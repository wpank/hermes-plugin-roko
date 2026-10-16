"""roko for Hermes Agent: delegate gated, budget-capped work to a roko harness.

`register(ctx)` adds, without touching the network:

- eight `roko_*` tools (toolset `roko`) the model uses to plan, run and follow
  roko work and to answer what a run waits on;
- the `/roko` slash command, the person's own view and answers;
- the `hermes roko setup | doctor | status | watch` CLI;
- a short `roko` system-prompt section teaching the delegation protocol;
- three skills (`roko:delegate`, `roko:plan`, `roko:decide`);
- an `@roko:<run>` context reference that puts a run card into a message;
- redaction of roko API keys in Hermes' logs and transcripts;
- with `learning_guard: true` (opt-in), one `pre_tool_call` hook, the learning
  guard (`learning_guard.py`): it vetoes only Hermes' background review saving
  a skill or memory that teaches repairing roko or re-running paid work.

The desktop app and web dashboard halves live next to this package
(`desktop/`, `dashboard/`); their backend routes are `ui_api.py`.

With the setting off (the default) the plugin registers no hook at all. Hermes
gates a plugin's tool-call hook per (hook, callback, call id): on 0.21.0 per
callback, so a hook running for one session blocked the same tool in another,
and even on 0.22 tool calls that carry no call id (execute_code's, the
hermes-tools MCP bridge's, connectors') share one key, so while any such hook
is registered, two of them at once can have the second refused. The guard is
registered only when it is turned on and Hermes gates hooks per call (0.22+).
"""

from __future__ import annotations

import importlib
import logging
import pkgutil
from pathlib import Path
from typing import Any

# install_state notes the code this process loads (docs/updating.md), so it comes with the package itself:
# the UI routes import the package without calling register().
from . import _hermes, catalog, cli, commands, install_state, prompt, references  # noqa: F401
from .learning_guard import make_hook as learning_guard_hook
from .runtime import Runtime
from .settings import load_settings
from .tools import make_handlers
from .version import __version__

__all__ = ["__version__", "register"]

logger = logging.getLogger(__name__)

SKILLS_DIR = Path(__file__).resolve().parent / "skills"
# name -> (folder, description); Hermes exposes them as roko:<name>.
SKILLS = {
    "delegate": ("roko-delegate", "Hand one well-defined change to roko as a gated, capped run."),
    "plan": ("roko-plan", "Turn larger work into a roko plan, review its waves and estimate, then run it."),
    "decide": ("roko-decide", "Answer what a roko run waits on, only with the person's own decision."),
}
# roko API keys are `roko_` and 43 URL-safe characters.
REDACTION_PATTERNS = [r"roko_[A-Za-z0-9_-]{36,}"]


def register(ctx: Any) -> None:
    """Hermes plugin entry point. Must not raise and must not use the network."""
    _import_all()
    rt = Runtime(ctx)
    try:
        settings = rt.settings()
    except Exception as exc:  # settings must never stop the plugin loading
        logger.warning("roko plugin: settings unreadable, using defaults: %s", exc)
        settings = load_settings(None)
    for problem in settings.problems:
        logger.warning("roko plugin settings: %s", problem)

    # The CLI comes first so `hermes roko doctor` exists even if a later step fails.
    _try(
        "the hermes roko command",
        lambda: ctx.register_cli_command(
            name="roko",
            help="Connect Hermes to roko serve, check the connection, follow runs",
            setup_fn=cli.build_parser,
            handler_fn=cli.make_main(rt),
            description="Connect Hermes to a roko orchestration harness (roko serve).",
        ),
    )

    if hasattr(ctx, "register_redaction_patterns"):
        _try("roko key redaction", lambda: ctx.register_redaction_patterns(REDACTION_PATTERNS))

    schemas = catalog.tool_schemas(settings.max_run_usd)
    handlers = make_handlers(rt)
    for name, schema in schemas.items():
        _try(
            f"tool {name}",
            lambda name=name, schema=schema: ctx.register_tool(
                name=name,
                toolset=catalog.TOOLSET,
                schema=schema,
                handler=handlers[name],
                description=schema["description"],
                emoji=catalog.TOOL_EMOJI.get(name, ""),
            ),
        )

    _try(
        "the /roko command",
        lambda: ctx.register_command(
            "roko",
            handler=commands.make_command(rt),
            description=commands.DESCRIPTION,
            args_hint=commands.ARGS_HINT,
        ),
    )

    if settings.prompt_section and hasattr(ctx, "register_system_prompt_section"):
        _try(
            "the system-prompt section",
            lambda: ctx.register_system_prompt_section(
                prompt.SECTION_ID, prompt.make_render(rt), max_chars=prompt.MAX_CHARS
            ),
        )

    if hasattr(ctx, "register_skill"):
        for name, (folder, description) in SKILLS.items():
            path = SKILLS_DIR / folder / "SKILL.md"
            _try(
                f"skill roko:{name}",
                lambda name=name, path=path, description=description: ctx.register_skill(
                    name, path, description=description
                ),
            )

    if hasattr(ctx, "register_context_reference"):
        provider = _hermes.context_reference(
            references.PREFIX, references.DESCRIPTION, references.completer(rt), references.expander(rt)
        )
        if provider is not None:
            _try("the @roko: reference", lambda: ctx.register_context_reference(provider))

    # Opt-in, and read once: with the guard off no hook exists, because any registered pre_tool_call
    # hook (even an idle one) lets Hermes refuse concurrent tool calls that carry no call id. Turning it
    # on takes a restart.
    if settings.learning_guard and hasattr(ctx, "register_hook") and _hermes.hooks_gated_per_call():
        hook = learning_guard_hook(lambda: _guard_on(rt))
        _try("the learning guard", lambda: ctx.register_hook("pre_tool_call", hook))

    if hasattr(ctx, "on_unload"):
        _try("the unload hook", lambda: ctx.on_unload(rt.close))


def _guard_on(rt: Runtime) -> bool:
    """The `learning_guard` setting, for a hook registered because it was on; on when it cannot be read."""
    try:
        return rt.settings().learning_guard
    except Exception:
        return True


def _import_all() -> None:
    """Import every module of the package now, so this process runs one version of the plugin.

    Hermes imports a plugin once and never again, and `hermes plugins update` rewrites its files in place.
    A module imported for the first time after an update would be the new version inside a process that
    runs the old one; importing them all at load keeps the process on one version until it restarts.
    """
    for module in pkgutil.iter_modules(__path__):
        _try(f"module {module.name}", lambda name=module.name: importlib.import_module(f"{__name__}.{name}"))


def _try(what: str, step: Any) -> None:
    try:
        step()
    except Exception as exc:
        logger.warning("roko plugin: could not register %s: %s", what, exc)

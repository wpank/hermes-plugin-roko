"""roko for Hermes Agent: delegate gated, budget-capped work to a roko harness.

`register(ctx)` adds, without touching the network:

- eight `roko_*` tools (toolset `roko`) the model uses to plan, run and follow
  roko work and to answer what a run waits on;
- the `/roko` slash command, the person's own view and answers;
- the `hermes roko setup | doctor | status` CLI;
- a short `roko` system-prompt section teaching the delegation protocol.

It registers no hooks: on Hermes 0.21.0 a plugin hook can block other
sessions' tools when two sessions call it at once, and nothing here needs one.
"""

from __future__ import annotations

import logging
from typing import Any

from . import catalog, cli, commands, prompt
from .runtime import Runtime
from .settings import load_settings
from .tools import make_handlers
from .version import __version__

__all__ = ["__version__", "register"]

logger = logging.getLogger(__name__)


def register(ctx: Any) -> None:
    """Hermes plugin entry point. Must not raise and must not use the network."""
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
            help="Connect Hermes to roko serve, and check the connection",
            setup_fn=cli.build_parser,
            handler_fn=cli.make_main(rt),
            description="Connect Hermes to a roko orchestration harness (roko serve).",
        ),
    )

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
                emoji=catalog.TOOL_EMOJI,
            ),
        )

    _try(
        "the /roko command",
        lambda: ctx.register_command(
            "roko",
            handler=commands.make_command(rt),
            description="roko: status, plans, what waits on you, approve/reject, cancel",
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

    if hasattr(ctx, "on_unload"):
        _try("the unload hook", lambda: ctx.on_unload(rt.close))


def _try(what: str, step: Any) -> None:
    try:
        step()
    except Exception as exc:
        logger.warning("roko plugin: could not register %s: %s", what, exc)

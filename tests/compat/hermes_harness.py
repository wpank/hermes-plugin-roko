"""Load the plugin into a real Hermes install and drive it, offline.

Run with Hermes' own interpreter, e.g.

    HERMES_AGENT_SRC=~/.hermes/hermes-agent \\
      ~/.hermes/hermes-agent/venv/bin/python tests/compat/hermes_harness.py

It builds a throwaway HERMES_HOME (nothing under ~/.hermes is touched),
installs the plugin there as `hermes plugins install` would lay it out,
enables it, points it at a fake roko serve, and then goes through Hermes' own
plugin manager, tool registry, slash-command resolver and system-prompt
assembly. It prints one JSON line per check and exits non-zero on the first
failure.
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import traceback
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parents[2]
HERMES_SRC = Path(os.environ.get("HERMES_AGENT_SRC", Path.home() / ".hermes" / "hermes-agent")).expanduser()
TOOLS = [
    "roko_status",
    "roko_plans",
    "roko_run",
    "roko_plan_generate",
    "roko_plan_run",
    "roko_cancel",
    "roko_recall",
    "roko_decide",
]
results: list[dict[str, Any]] = []


def report(line: dict[str, Any]) -> None:
    """One JSON line on the real stdout: Hermes' CLI points `sys.stdout` at stderr while it runs."""
    out = sys.__stdout__ or sys.stdout
    out.write(json.dumps(line, default=str) + "\n")
    out.flush()


def check(name: str, condition: bool, detail: Any = None) -> None:
    results.append({"check": name, "ok": bool(condition), "detail": detail})
    report(results[-1])
    if not condition:
        raise SystemExit(1)


def install_plugin(home: Path) -> Path:
    target = home / "plugins" / "roko"
    shutil.copytree(
        REPO,
        target,
        ignore=shutil.ignore_patterns(
            ".venv", ".git", "tests", "__pycache__", "*.pyc", ".*_cache", "*.egg-info"
        ),
    )
    return target


def hooks_gated_per_call() -> bool:
    """Whether this Hermes gates a plugin hook per tool call, as the plugin's `_hermes.hooks_gated_per_call` asks."""
    try:
        from hermes_cli.plugins_dispatch import _hook_call_identity  # noqa: F401
    except Exception:
        return False
    return True


# ROKO_COMPAT_LEARNING_GUARD=1 runs the harness with the opt-in learning guard turned on.
GUARD_ON = os.environ.get("ROKO_COMPAT_LEARNING_GUARD") == "1"


def write_config(home: Path, url: str, extra: str = "") -> None:
    guard = "        learning_guard: true\n" if GUARD_ON else ""
    (home / "config.yaml").write_text(
        f"plugins:\n  enabled: [roko]\n  entries:\n    roko:\n      settings:\n        url: {url}\n{guard}{extra}"
    )


def main() -> None:
    sys.path.insert(0, str(HERMES_SRC))
    sys.path.insert(0, str(REPO / "tests"))
    home = Path(tempfile.mkdtemp(prefix="hermes-roko-compat-"))
    (home / "bundled").mkdir()
    os.environ["HERMES_HOME"] = str(home)
    # Not a dependency environment of its own for this throwaway home (see test_hermes_compat._env).
    os.environ.setdefault("HERMES_DISABLE_LAZY_INSTALLS", "1")
    os.environ["HERMES_BUNDLED_PLUGINS"] = str(home / "bundled")
    os.environ.pop("ROKO_URL", None)
    os.environ.pop("ROKO_API_KEY", None)

    from fake_roko import FakeRoko  # tests/ is on sys.path

    fake = FakeRoko(auth=True).start()
    key = fake.add_key("hermes", "write")
    fake.add_plan(
        "add-parser-test",
        "Add a parser test",
        [
            {
                "id": "T1",
                "title": "write the test",
                "depends_on": [],
                "verify": [{"phase": "post", "command": "cargo test -p parser"}],
            },
        ],
    )
    fake.knowledge.append(
        {
            "id": "k1",
            "content": "the parser needs utf-8 input",
            "kind": "Insight",
            "tier": "Working",
            "relevance": 0.7,
            "created_at": "2026-10-01T00:00:00Z",
        }
    )
    install_plugin(home)
    write_config(home, fake.url)
    (home / ".env").write_text(f"ROKO_API_KEY={key}\n")
    os.environ["ROKO_API_KEY"] = key

    try:
        from hermes_cli import plugins as P
        from tools.registry import registry

        P.discover_plugins()
        manager = P.get_plugin_manager()
        rows = {row["key"]: row for row in manager.list_plugins()}
        row = rows.get("roko")
        check("plugin discovered", row is not None, sorted(rows))
        check("plugin enabled without error", bool(row["enabled"]) and row["error"] is None, row)
        # The plugin's one hook is the learning guard (learning_guard.py): a `pre_tool_call` hook it registers only
        # when `learning_guard` is on (opt-in) and Hermes gates hooks per call (0.22+), found the way the plugin
        # finds it. By default, and on an older Hermes, it registers none.
        gated = GUARD_ON and hooks_gated_per_call()
        hooks = 1 if gated else 0
        check(
            f"8 tools, {hooks} hook(s), 1 command",
            (row["tools"], row["hooks"], row["commands"]) == (8, hooks, 1),
            row,
        )
        ours = [
            f"{getattr(cb, '__module__', '')}.{getattr(cb, '__qualname__', '')}"
            for cb in manager._hooks.get("pre_tool_call", [])
            if "hermes_plugin_roko" in getattr(cb, "__module__", "")
        ]
        check(
            "the plugin's hooks: the learning guard's pre_tool_call when opted in on a per-call-gating Hermes, "
            "else none",
            len(ours) == hooks and all("learning_guard" in name for name in ours),
            ours,
        )
        if gated:
            block, _ = P._dispatch_pre_tool_call_hooks("terminal", {"command": "ls"}, tool_call_id="compat-1")
            check("the learning guard leaves an ordinary tool call alone", block is None, block)
            from tools.skill_provenance import reset_current_write_origin, set_current_write_origin

            recipe = "Clear it with `git -C ws worktree remove --force ws/.roko/worktrees/attempt-1a2b3c4d`."
            write = {"operations": [{"action": "create", "name": "roko-fix", "content": recipe}]}
            token = set_current_write_origin("background_review")
            try:
                block, _ = P._dispatch_pre_tool_call_hooks("skill_manage", write, tool_call_id="compat-2")
            finally:
                reset_current_write_origin(token)
            check(
                "the learning guard refuses a background review's roko repair recipe",
                bool(block) and "roko plugin declined" in block,
                block,
            )
            block, _ = P._dispatch_pre_tool_call_hooks("skill_manage", write, tool_call_id="compat-3")
            check("a chat's own skill write passes", block is None, block)
        check("hermes roko CLI registered", "roko" in manager._cli_commands, sorted(manager._cli_commands))

        for name in TOOLS:
            entry = registry.get_entry(name)
            check(
                f"{name} in toolset roko",
                entry is not None and entry.toolset == "roko",
                getattr(entry, "toolset", None),
            )

        def dispatch(name: str, args: dict[str, Any]) -> dict[str, Any]:
            return json.loads(
                registry.dispatch(name, args, task_id="compat-task", session_id="compat-session")
            )

        plans = dispatch("roko_plans", {})
        check(
            "roko_plans lists the plan",
            [p["id"] for p in plans.get("plans", [])] == ["add-parser-test"],
            plans,
        )
        detail = dispatch("roko_plans", {"plan_id": "add-parser-test"})
        check(
            "roko_plans shows tasks and checks",
            detail["tasks"][0]["checks"] == ["cargo test -p parser"],
            detail,
        )

        recall = dispatch("roko_recall", {"query": "parser"})
        check(
            "roko_recall returns entries",
            recall["entries"][0]["content"] == "the parser needs utf-8 input",
            recall,
        )

        # A script has no person to ask, so Hermes' approval gate must refuse paid work.
        denied = dispatch("roko_run", {"prompt": "add a test", "max_usd": 0.5})
        check("roko_run is refused without a person to approve", denied.get("code") == "denied", denied)
        check("nothing reached roko", fake.tool_calls("run_prompt") == [], fake.tool_calls("run_prompt"))

        over = dispatch("roko_run", {"prompt": "add a test", "max_usd": 50})
        check("an over-cap max_usd is refused locally", over.get("code") == "invalid", over)

        # With approvals turned off in settings, the run reaches roko through /mcp.
        write_config(home, fake.url, "        approve_paid: false\n")
        started = dispatch("roko_run", {"prompt": "add a test", "max_usd": 0.5})
        check("roko_run starts a run when approvals are off", bool(started.get("run_id")), started)
        sent = fake.tool_calls("run_prompt")
        check("run_prompt carried the cap", sent and sent[-1]["max_usd"] == 0.5, sent)
        auth_headers = [r["headers"].get("X-Api-Key") for r in fake.requests if r["path"] == "/mcp"]
        check(
            "the key went in X-Api-Key",
            auth_headers and all(h == key for h in auth_headers),
            len(auth_headers),
        )

        status = dispatch("roko_status", {"run_id": started["run_id"], "wait_secs": 0})
        check("roko_status reports running", status.get("state") == "running", status)
        status = dispatch("roko_status", {"run_id": started["run_id"], "wait_secs": 0})
        check("roko_status reports succeeded", status.get("state") == "succeeded", status)

        overview = dispatch("roko_status", {})
        runs = overview.get("recent_runs", [])
        check(
            "the overview lists the run Hermes started",
            runs and runs[0].startswith(started["run_id"]),
            overview,
        )

        handler = P.get_plugin_command_handler("roko")
        check("/roko resolves", handler is not None)
        text = P.resolve_plugin_command_result(handler("plans"))
        check("/roko plans renders", "add-parser-test" in str(text), text)
        text = P.resolve_plugin_command_result(handler("status"))
        check("/roko status renders", "roko 0.1.0" in str(text), text)

        # The system-prompt section renders the way a new session renders it.
        rendered = P.render_system_prompt_sections(
            {
                "session_id": "s",
                "model": "m",
                "provider": "p",
                "platform": "cli",
                "profile_name": "default",
                "cwd": ".",
            }
        )
        texts = {getattr(section, "id", "?"): str(getattr(section, "text", section)) for section in rendered}
        check("system prompt carries the roko section", "roko_plan_generate" in texts.get("roko", ""), texts)
        check("no directives outside the desktop app", "::roko-run" not in texts.get("roko", ""), texts)
        desktop = P.render_system_prompt_sections(
            {
                "session_id": "s",
                "model": "m",
                "provider": "p",
                "platform": "desktop",
                "profile_name": "default",
                "cwd": ".",
            }
        )
        desktop_text = {getattr(s, "id", "?"): str(getattr(s, "text", s)) for s in desktop}.get("roko", "")
        check(
            "the desktop app's prompt teaches the run card",
            '::roko-run{id="RUN_ID"}' in desktop_text,
            desktop_text,
        )

        skills = sorted(key for key in manager._plugin_skills if key.startswith("roko:"))
        check("three skills registered", skills == ["roko:decide", "roko:delegate", "roko:plan"], skills)

        from agent.redact import redact_sensitive_text

        masked = redact_sensitive_text(f"the key is {key} ok")
        check("roko keys are redacted", key not in masked, masked)

        import asyncio

        from agent.context_references import get_context_reference_providers

        provider = get_context_reference_providers().get("roko")
        check("@roko: reference registered", provider is not None, sorted(get_context_reference_providers()))
        expanded = asyncio.run(provider.expand(started["run_id"]))
        check(
            "@roko:<run> expands to the run card",
            "roko run card" in expanded and "succeeded" in expanded,
            expanded,
        )
        completions = asyncio.run(provider.autocomplete("", limit=5))
        check("@roko: completes recent runs", completions[0].text == "last", [c.text for c in completions])

        # The backend the desktop app and dashboard call: Hermes' own web server mounts it.
        from fastapi.testclient import TestClient
        from hermes_cli import web_server

        paths = {getattr(route, "path", "") for route in web_server.app.routes}
        check(
            "web server mounted the roko routes",
            "/api/plugins/roko/overview" in paths,
            sorted(path for path in paths if "roko" in path),
        )
        client = TestClient(web_server.app)
        headers = {"X-Hermes-Session-Token": web_server._SESSION_TOKEN}
        anonymous = client.get("/api/plugins/roko/overview")
        check("the routes need Hermes' session", anonymous.status_code == 401, anonymous.status_code)
        body = client.get("/api/plugins/roko/overview", headers=headers).json()
        check(
            "overview through Hermes' web server",
            body.get("ok") is True and body["connection"]["reachable"],
            body,
        )
        check("the overview lists the run", body["runs"][0]["run_id"] == started["run_id"], body["runs"])
        check("no key in the UI's answers", key not in json.dumps(body), "")
        card = client.get(f"/api/plugins/roko/runs/{started['run_id']}", headers=headers).json()
        check(
            "a run card through Hermes' web server",
            card.get("ok") and card["run"]["state"] == "succeeded",
            card,
        )
        listed = client.get("/api/dashboard/plugins", headers=headers).json()
        mine = [plugin for plugin in listed if plugin.get("name") == "roko"]
        check("the dashboard lists the roko tab", bool(mine) and mine[0]["tab"]["path"] == "/roko", listed)
        script = client.get("/dashboard-plugins/roko/dist/index.js")
        check(
            "the dashboard serves its script",
            script.status_code == 200 and "registerSlot" in script.text,
            script.status_code,
        )
        source = client.get("/dashboard-plugins/roko/plugin_api.py")
        check("the dashboard never serves the Python source", source.status_code == 404, source.status_code)
    except SystemExit:
        raise
    except Exception:
        check("no exception", False, traceback.format_exc())
    finally:
        fake.stop()
        shutil.rmtree(home, ignore_errors=True)
    report({"summary": "ok", "checks": len(results)})


if __name__ == "__main__":
    main()

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


def check(name: str, condition: bool, detail: Any = None) -> None:
    results.append({"check": name, "ok": bool(condition), "detail": detail})
    print(json.dumps(results[-1], default=str), flush=True)
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


def write_config(home: Path, url: str, extra: str = "") -> None:
    (home / "config.yaml").write_text(
        f"plugins:\n  enabled: [roko]\n  entries:\n    roko:\n      settings:\n        url: {url}\n{extra}"
    )


def main() -> None:
    sys.path.insert(0, str(HERMES_SRC))
    sys.path.insert(0, str(REPO / "tests"))
    home = Path(tempfile.mkdtemp(prefix="hermes-roko-compat-"))
    (home / "bundled").mkdir()
    os.environ["HERMES_HOME"] = str(home)
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
        check("8 tools, 0 hooks, 1 command", (row["tools"], row["hooks"], row["commands"]) == (8, 0, 1), row)
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
    except SystemExit:
        raise
    except Exception:
        check("no exception", False, traceback.format_exc())
    finally:
        fake.stop()
        shutil.rmtree(home, ignore_errors=True)
    print(json.dumps({"summary": "ok", "checks": len(results)}))


if __name__ == "__main__":
    main()

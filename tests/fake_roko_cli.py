"""A stand-in for the `roko` command, for `hermes roko init`'s tests (ROKO_BIN points at a wrapper).

    roko --version
    roko init                                   writes the roko.toml a roko before 2026-10-15 wrote
    roko serve --workdir DIR --port N           a FakeRoko that follows DIR/roko.toml, until SIGTERM
    roko config preset chat-host … --json       only with FAKE_ROKO_PRESET=1, as roko-chathost's preset
    roko plan validate DIR

`roko serve` reads its models from roko.toml and its keys from the environment and ~/.roko/.env, as
roko does, and re-reads roko.toml every 0.2 s like roko's watcher. FAKE_ROKO_OLD=1 plays a roko that
names refusals only in text and never refuses for want of a model.
"""

from __future__ import annotations

import json
import os
import re
import signal
import sys
import threading
import time
import tomllib
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).parent))

from fake_roko import FakeRoko

INIT_TOML = """\
config_version = 2

[agent]
default_model = "claude-sonnet-4-6"

[providers.claude_cli]
kind = "claude_cli"

[models.claude-sonnet-4-6]
provider = "claude_cli"
slug = "claude-sonnet-4-6"

[routing.ladder]
enabled = true

[[routing.ladder.rungs]]
name = "cheap"
model = "gpt-oss-120b"

[[routing.ladder.rungs]]
name = "top"
model = "claude-sonnet-4-6"

[serve.auth]
enabled = true

[serve.mcp]
max_run_usd = 5.0
allow_without_data_llm = false

[gates]
rungs = []
"""

API_KINDS = {"anthropic_api", "openai_compat", "perplexity_api", "gemini_api", "cerebras_api"}
# Slugs roko's own price table covers (config/prices/2026-09-28.toml and the built-in table in roko-core): a
# `[models.*]` entry on one of them needs no rates of its own.
PRICED_SLUGS = {"gpt-5.4-mini", "claude-haiku-4-5", "gpt-oss-120b"}


def keys() -> set[str]:
    names = {name for name, value in os.environ.items() if value}
    env = Path.home() / ".roko" / ".env"
    if env.is_file():
        for line in env.read_text().splitlines():
            name, sep, value = line.partition("=")
            if sep and value.strip():
                names.add(name.strip())
    return names


def follow(fake: FakeRoko, config: Path) -> None:
    """Keep the fake's model and provider lists as roko.toml and the keys say."""
    while True:
        try:
            data = tomllib.loads(config.read_text())
        except (OSError, tomllib.TOMLDecodeError):
            data = {}
        have = keys()
        providers = []
        for pid, row in (data.get("providers") or {}).items():
            kind = row.get("kind")
            has_key = kind in API_KINDS and (row.get("api_key_env") in have)
            providers.append(
                {"id": pid, "kind": kind, "has_api_key": has_key, "base_url": row.get("base_url")}
            )
        models = [
            {"key": key, "slug": row.get("slug"), "provider": row.get("provider"), "supports_tools": True}
            for key, row in (data.get("models") or {}).items()
        ]
        keyed = {p["id"] for p in providers if p["has_api_key"]}
        with fake.lock:
            fake.providers, fake.models = providers, models
            fake.tool_loop = any(m["provider"] in keyed for m in models)
            # roko since gap-8548e3: one of those models needs a price, its own rates or roko's table's.
            fake.priced = any(
                row.get("provider") in keyed
                and (
                    "cost_input_per_m" in row
                    or "cost_output_per_m" in row
                    or str(row.get("slug") or key) in PRICED_SLUGS
                )
                for key, row in (data.get("models") or {}).items()
            )
        time.sleep(0.2)


def watch(config: Path, seen: Path, delay: float) -> None:
    """roko serve's config watcher: what it serves from is `seen`, a copy of roko.toml taken `delay` seconds
    after each change (FAKE_ROKO_RELOAD_DELAY), as roko re-reads roko.toml only every 2 s or so."""
    last = config.stat().st_mtime_ns
    while True:
        time.sleep(0.05)
        try:
            now = config.stat().st_mtime_ns
        except OSError:
            continue
        if now != last:
            time.sleep(delay)
            copy = seen.with_suffix(".tmp")
            copy.write_bytes(config.read_bytes())
            copy.replace(seen)
            last = now


def serve(argv: list[str]) -> int:
    workdir = Path(argv[argv.index("--workdir") + 1]).resolve()
    port = int(argv[argv.index("--port") + 1]) if "--port" in argv else 6677
    config = workdir / "roko.toml"
    data = tomllib.loads(config.read_text())
    auth = bool((data.get("serve") or {}).get("auth", {}).get("enabled", False))
    delay = float(os.environ.get("FAKE_ROKO_RELOAD_DELAY") or 0)
    seen = config
    if delay:
        seen = workdir / ".roko" / "runtime" / "seen-roko.toml"
        seen.parent.mkdir(parents=True, exist_ok=True)
        seen.write_bytes(config.read_bytes())
        threading.Thread(target=watch, args=(config, seen, delay), daemon=True).start()
    fake = FakeRoko(auth=auth, config=seen, refusal_words=not os.environ.get("FAKE_ROKO_OLD")).start(port)
    threading.Thread(target=follow, args=(fake, seen), daemon=True).start()
    runtime = workdir / ".roko" / "runtime"
    runtime.mkdir(parents=True, exist_ok=True)
    if auth:
        (runtime / "serve.token").write_text(fake.launch_token)
    (runtime / "serve.json").write_text(
        json.dumps({"pid": os.getpid(), "url": fake.url, "workdir": str(workdir), "started_at": time.time()})
    )
    print(f"roko server listening on {fake.url}", flush=True)
    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    stop.wait()
    fake.stop()
    return 0


def preset(argv: list[str]) -> int:
    if not os.environ.get("FAKE_ROKO_PRESET"):
        print("error: unrecognized subcommand 'chat-host'", file=sys.stderr)
        return 2
    if os.environ["FAKE_ROKO_PRESET"] == "refuse":
        print("Error: roko.toml at ./roko.toml is not valid: duplicate key `mcp`", file=sys.stderr)
        return 2
    workdir = Path(argv[argv.index("--workdir") + 1]) if "--workdir" in argv else Path.cwd()
    path = workdir / "roko.toml"
    old = path.read_text()
    new = re.sub(r"(?m)^allow_without_data_llm = false$", "allow_without_data_llm = true", old)
    diff = "" if new == old else "-allow_without_data_llm = false\n+allow_without_data_llm = true\n"
    written = "--yes" in argv and new != old
    if written:
        path.write_text(new)
    answer: dict[str, Any] = {
        "preset": "chat-host",
        "path": str(path),
        "dry_run": "--dry-run" in argv,
        "written": written,
        "edit": {"key": "serve.mcp.allow_without_data_llm", "value": True},
        "why": "--allow-without-data-llm",
        "diff": diff,
        "ready": (written or new == old) and not os.environ.get("FAKE_ROKO_PRESET_NO_MODEL"),
        "refusals": ["no_tool_loop_model"] if os.environ.get("FAKE_ROKO_PRESET_NO_MODEL") else [],
        "refusal": "a run from a chat host needs a model …"
        if os.environ.get("FAKE_ROKO_PRESET_NO_MODEL")
        else None,
        "commit": False,
    }
    print(json.dumps(answer))
    return 0


def main(argv: list[str]) -> int:
    if argv[:1] == ["--version"]:
        print("roko 0.1.0 (fake)")
        return 0
    if argv[:1] == ["init"]:
        Path("roko.toml").write_text(INIT_TOML)
        print("wrote ./roko.toml")
        print("detected project domain: general")
        return 0
    if argv[:1] == ["serve"]:
        return serve(argv)
    if argv[:3] == ["config", "preset", "chat-host"]:
        return preset(argv)
    if argv[:2] == ["plan", "validate"]:
        return 0
    print(f"fake roko: unknown command {argv}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

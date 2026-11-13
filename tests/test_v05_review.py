"""0.5: what the review of the 0.5 working tree found before commit, each as the test that showed it.

- The learning guard let a recipe through when a negative condition came first ("if roko can't
  reattach the worktree, run `git worktree remove …`").
- `--dry-run` minted (or rotated) a key in roko: `hermes roko setup --mint --dry-run`, and `hermes roko init
  --dry-run` against a roko serve with auth on.
- `hermes roko init` started roko serve with every secret Hermes loads from its own .env but six.
- Commands the person may paste carried names from roko's answers unquoted (a plan branch, the desktop copy's
  folder).
- The status tool handed the model the setup problems' fix commands with nothing saying they are the
  person's to run.
- A timed-out answer from a page told the person to "check roko_status".
- The doctor raised on the path where the plugin's own look at roko broke.
"""

from __future__ import annotations

import argparse
import json
import os
import shlex
import subprocess
import time
import tomllib
from pathlib import Path
from typing import Any

import httpx
import pytest
from conftest import FakeContext
from fake_roko import FakeRoko
from test_v05_init import UNPRICED_TOML, free_port, home, init, project, roko, saved  # noqa: F401  (fixtures)
from test_v05_runs import CAP_STOPPED_ROWS

from hermes_plugin_roko import (
    cli,
    decisions,
    errors,
    install_state,
    learning_guard,
    onboard,
    readiness,
    runwork,
    settings,
    ui_api,
    views,
)
from hermes_plugin_roko.diagnostics import roko_checks
from hermes_plugin_roko.errors import Code, RokoError
from hermes_plugin_roko.runtime import Runtime
from hermes_plugin_roko.settings import load_settings


@pytest.fixture(autouse=True)
def _loaded_is_on_disk(monkeypatch: pytest.MonkeyPatch) -> None:
    # Other work may change the checkout while a test runs; install_state would call that a stale backend.
    pinned = install_state._fingerprint()
    monkeypatch.setattr(install_state, "_LOADED_FINGERPRINT", pinned)
    monkeypatch.setattr(install_state, "_fingerprint", lambda: pinned)


# -- the learning guard: a negative condition is not a prohibition -------------------------------------


@pytest.mark.parametrize(
    "text",
    [
        "If roko can't reattach the worktree, run `git -C <ws> worktree remove --force <ws>/.roko/worktrees/<n>`.",
        "When the run doesn't start, clear roko's leftover worktree with git worktree remove --force "
        ".roko/worktrees/x.",
        "If roko does not start the run, delete roko's stale worktree and branch.",
        "If the plan run is not accepted, re-issue roko_plan_run with the same cap.",
        "If roko cannot reattach, rm -rf .roko/worktrees/attempt-123abc and start the roko run again.",
        "If roko can't reattach then run git worktree remove --force .roko/worktrees/attempt-1a2b3c.",
    ],
)
def test_a_recipe_after_a_negative_condition_is_refused(text: str) -> None:
    assert learning_guard.teaches_repair(text)


@pytest.mark.parametrize(
    "text",
    [
        "If roko refuses, do not edit roko.toml.",
        "When a run fails, never re-run roko_plan_run on your own.",
        "Unless the person asks, never re-run roko_plan_run.",
        "Do not, if roko refuses, edit roko.toml.",
        "Never, under any circumstances, edit roko.toml.",
        "Never edit `roko.toml` (point to the plugin's fix instead), and never start, re-run or resume paid "
        "work the person did not ask for in this turn.",
    ],
)
def test_a_prohibition_after_a_condition_still_passes(text: str) -> None:
    assert not learning_guard.teaches_repair(text)


# -- --dry-run mints no key --------------------------------------------------------------------------


def _start_serve(roko: Path, project: Path, port: int) -> subprocess.Popen[bytes]:  # noqa: F811
    process = subprocess.Popen(
        [str(roko), "serve", "--workdir", str(project), "--port", str(port)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    endpoint = project / ".roko" / "runtime" / "serve.json"
    for _ in range(200):
        if endpoint.is_file():
            break
        time.sleep(0.05)
    return process


def _keys(project: Path) -> list[dict[str, Any]]:  # noqa: F811
    """The API keys roko serve holds, read with its launch token (admin)."""
    runtime = project / ".roko" / "runtime"
    url = json.loads((runtime / "serve.json").read_text())["url"]
    token = (runtime / "serve.token").read_text().strip()
    keys = httpx.get(f"{url}/api/api-keys", headers={"Authorization": f"Bearer {token}"}).json()["keys"]
    assert isinstance(keys, list)
    return keys


def test_init_dry_run_mints_no_key(
    project: Path,  # noqa: F811
    home: Path,  # noqa: F811
    roko: Path,  # noqa: F811
    saved: dict[str, str],  # noqa: F811
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-not-a-key")
    subprocess.run([str(roko), "init"], cwd=project, check=True, capture_output=True)  # auth on
    port = free_port()
    process = _start_serve(roko, project, port)
    try:
        before = _keys(project)
        code, out = init(FakeContext({}), project, port=port, dry_run=True)
        assert code == 0, out
        assert _keys(project) == before, out
        assert "ROKO_API_KEY" not in saved
    finally:
        process.terminate()
        process.wait(timeout=10)


def test_setup_dry_run_neither_mints_nor_rotates(
    project: Path,  # noqa: F811
    home: Path,  # noqa: F811
    roko: Path,  # noqa: F811
    saved: dict[str, str],  # noqa: F811
    capsys: pytest.CaptureFixture[str],
) -> None:
    subprocess.run([str(roko), "init"], cwd=project, check=True, capture_output=True)
    process = _start_serve(roko, project, free_port())
    rt = Runtime(FakeContext({}))
    try:
        parser = argparse.ArgumentParser(prog="hermes roko")
        cli.build_parser(parser)
        main = cli.make_main(rt)
        assert main(parser.parse_args(["setup", "--workdir", str(project), "--mint", "--dry-run"])) == 0
        assert _keys(project) == [] and "ROKO_API_KEY" not in saved
        assert "would mint" in capsys.readouterr().out
        # A key of that name already there: --yes would rotate it (the old one stops working), but not in a
        # dry run.
        main(parser.parse_args(["setup", "--workdir", str(project), "--mint"]))
        old = saved["ROKO_API_KEY"]
        assert (
            main(parser.parse_args(["setup", "--workdir", str(project), "--mint", "--yes", "--dry-run"])) == 0
        )
        assert saved["ROKO_API_KEY"] == old and _works(project, old)
    finally:
        rt.close()
        process.terminate()
        process.wait(timeout=10)


def _works(project: Path, key: str) -> bool:  # noqa: F811
    url = json.loads((project / ".roko" / "runtime" / "serve.json").read_text())["url"]
    return httpx.get(f"{url}/api/health", headers={"Authorization": f"Bearer {key}"}).status_code == 200


# -- roko serve gets none of Hermes' own secrets -------------------------------------------------------


def test_roko_serve_gets_none_of_the_keys_hermes_loaded_from_its_env_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    hermes_home = tmp_path / "hermes-home"
    hermes_home.mkdir(parents=True, exist_ok=True)
    (hermes_home / ".env").write_text(
        "TELEGRAM_BOT_TOKEN=123:abc\nexport GITHUB_TOKEN='ghp_x'\nROKO_API_KEY=roko_x\nEMPTY=\nPATH=/nowhere\n"
    )
    monkeypatch.setenv("HERMES_HOME", str(hermes_home))
    # `hermes` loads its .env into its own environment when it starts (hermes_cli/main.py).
    for name, value in (
        ("TELEGRAM_BOT_TOKEN", "123:abc"),
        ("GITHUB_TOKEN", "ghp_x"),
        ("ROKO_API_KEY", "roko_x"),
    ):
        monkeypatch.setenv(name, value)
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    monkeypatch.setenv("MY_SHELL_SETTING", "kept")
    env = onboard._roko_env()
    for name in ("TELEGRAM_BOT_TOKEN", "GITHUB_TOKEN", "ROKO_API_KEY", "OPENAI_API_KEY"):
        assert name not in env, name
    assert env["MY_SHELL_SETTING"] == "kept" and env["PATH"] == os.environ["PATH"]


# -- commands to paste quote what came from roko -------------------------------------------------------


def test_a_plan_branch_roko_names_is_only_taken_when_it_is_a_plain_ref() -> None:
    base, commit = "a" * 40, "b" * 40
    row = {
        "plan_id": "x",
        "commit": commit,
        "base": base,
        "tasks": [{"task_id": "T1", "verdict": "unverified"}],
        "files_changed": ["lib.py"],
        "diffstat": {"files": 1, "insertions": 1, "deletions": 0},
    }
    evil = "roko/plan/x;touch${IFS}pwned"
    parts, _ = runwork.roko_parts(
        {"unverified": [{**row, "branch": evil, "review_command": f"git diff {base[:12]}..{evil}"}]},
        "git -C /ws",
    )
    [part] = parts
    assert part["branch"] is None
    assert part["review_command"] == f"git -C /ws diff {base[:12]}..{commit[:12]}"
    plain = "roko/plan/add-tests"
    parts, _ = runwork.roko_parts(
        {"unverified": [{**row, "branch": plain, "review_command": f"git diff {base[:12]}..{plain}"}]}, "git"
    )
    assert parts[0]["branch"] == plain and parts[0]["review_command"] == f"git diff {base[:12]}..{plain}"


def test_the_merge_command_quotes_the_branch(tmp_path: Path) -> None:
    branch = "roko/plan/x;touch${IFS}pwned"
    part = {"trust": "unverified", "delivered": False, "branch": branch, "commit": "b" * 12, "tasks": []}
    state = runwork.merge_state(tmp_path / "missing", part, run_id="r", terminal=True)
    assert state["command"].endswith(f" merge {shlex.quote(branch)}")


def test_the_rm_step_quotes_the_desktop_copy_folder() -> None:
    folder = "/Users/a b/.hermes/desktop-plugins/roko"
    [problem] = install_state._problems(
        {
            "backend_stale": False,
            "desktop_copy_stale": True,
            "desktop_copy_marker": False,
            "desktop_copy": folder,
            "disk_version": "0.5.0",
            "desktop_copy_version": "0.4.0",
        }
    )
    assert shlex.split(problem["steps"]["terminal"][0]) == ["rm", "-r", folder]


# -- the status tool: setup problems are the person's to fix -------------------------------------------


def test_the_status_tool_says_setup_fixes_are_the_persons(fake: FakeRoko, call: Any) -> None:
    fake.boundary = False
    status = call("roko_status")
    assert [problem["id"] for problem in status["setup_problems"]] == ["workspace-refuses-chat-runs"]
    assert "do not run" in status["next"].lower() and "yourself" in status["next"]
    # The pages' restart steps are the person's too, and stay with the pages.
    assert all("steps" not in problem for problem in status["setup_problems"])


# -- a page's timed-out answer speaks to the person ----------------------------------------------------


def test_a_timed_out_answer_tells_the_person_what_to_do(monkeypatch: pytest.MonkeyPatch) -> None:
    class Client:
        def call_tool(self, *args: Any, **kwargs: Any) -> Any:
            raise RokoError(Code.UNREACHABLE, "timed out", timed_out=True)

    decision = decisions.parse_decision_id(decisions.confirmation_id("run-1", "T1", "attempt-1"))
    with pytest.raises(RokoError) as raised:
        decisions.answer(Client(), decision, True, None)  # type: ignore[arg-type]
    error = raised.value
    assert "roko_status" not in (error.hint or "")
    assert "roko_status" in (error.model_hint() or "")


# -- the doctor when the plugin's own look broke -------------------------------------------------------


def test_the_doctor_says_so_when_the_look_broke_part_way() -> None:
    facts = readiness.Facts(
        load_settings(None),
        health={"version": "x", "status": "ok"},
        has_key=True,
        read_only=True,
        runs="refused",
        refusals=["no_data_boundary"],
        bug="KeyError: 'x'",
    )
    checks = roko_checks(facts, readiness.problems_from(facts))
    assert any(check.name == "roko" and "could not finish" in check.detail for check in checks)


# -- init's demo never replaces a plan of the person's ------------------------------------------------


def test_the_demo_never_replaces_a_plan_of_the_persons(project: Path, home: Path) -> None:  # noqa: F811
    own = project / "plans" / "demos" / "demo-hello-world"
    own.mkdir(parents=True)
    (own / "plan.md").write_text("# My own hello world\n")
    (own / "tasks.toml").write_text('[meta]\nplan = "mine"\n')
    lines: list[str] = []
    rt = Runtime(FakeContext({}))
    try:
        onboard.Init(rt, onboard.Options(workdir=project, yes=True), out=lines.append).demo()
    finally:
        rt.close()
    assert (own / "plan.md").read_text() == "# My own hello world\n", lines
    assert (own / "tasks.toml").read_text() == '[meta]\nplan = "mine"\n'
    assert any("left it as it is" in line for line in lines), lines


# -- roko's own way past a leftover checkout reaches the person and the model whole --------------------

MOVE_ASIDE = (
    "git -C /Users/w/proj worktree move /Users/w/proj/.roko/worktrees/attempt-76555e29268820e0fd63 "
    "/Users/w/proj/.roko/worktrees/attempt-76555e29268820e0fd63-kept && git -C /Users/w/proj branch -m "
    "roko/attempt/attempt-76555e29268820e0fd63 roko/attempt/attempt-76555e29268820e0fd63-kept"
)
# roko's words since bug-e998be, as its error event carries them (about 900 characters).
MOVED_ERROR = (
    "plan 'demo-hello-world': task 'HELLO-1' failed: agent error (worktree-isolation): failed to acquire worktree "
    "for demo-hello-world/HELLO-1/attempt-0: workspace I/O error: cannot safely reattach worktree "
    "`attempt-76555e29268820e0fd63`: branch `roko/attempt/attempt-76555e29268820e0fd63` is already checked out "
    "in this repository, at `/Users/w/proj/.roko/worktrees/attempt-76555e29268820e0fd63`. roko left that "
    "checkout as it is and deleted nothing. To let this attempt run, move it aside with its branch, which keeps "
    "its work: " + MOVE_ASIDE
)


def _dies_on_a_checked_out_branch(fake: FakeRoko, message: str) -> None:
    fake.add_plan("demo-hello-world", "Hello world demo")
    fake.run_script = ["failed"]
    make = fake._new_run

    def new_run(kind: str, **kwargs: Any) -> Any:
        run = make(kind, **kwargs)
        run.events = [
            {"type": "plan_started", "plan_id": "demo-hello-world", "tasks_total": 1},
            {"type": "task_started", "plan_id": "demo-hello-world", "task_id": "HELLO-1", "title": "hello"},
            {
                "type": "task_completed",
                "plan_id": "demo-hello-world",
                "task_id": "HELLO-1",
                "outcome": "failed",
            },
            {"type": "error", "message": message},
            {"type": "plan_completed", "plan_id": "demo-hello-world", "success": False},
            {"type": "run_completed", "run_id": run.run_id, "outcome": "failed"},
        ]
        return run

    fake._new_run = new_run


def test_rokos_move_aside_command_reaches_the_person_and_the_model_whole(
    call: Any, fake: FakeRoko, approvals: Any, rt: Runtime
) -> None:
    _dies_on_a_checked_out_branch(fake, MOVED_ERROR)
    run_id = call("roko_plan_run", {"plan_id": "demo-hello-world", "max_usd": 0.25})["run_id"]
    why = call("roko_status", {"run_id": run_id, "detail": "why"})
    assert MOVE_ASIDE in why["why"]["summary"]
    assert why["next"] == errors.ROKO_STATE_GUIDANCE
    assert MOVE_ASIDE in views.card(rt, run_id)["why"]["summary"]


def test_only_a_command_of_rokos_own_shape_is_passed_on(
    call: Any, fake: FakeRoko, approvals: Any, rt: Runtime
) -> None:
    _dies_on_a_checked_out_branch(fake, MOVED_ERROR.replace("-kept && git", "-kept; rm -rf ~ && git"))
    run_id = call("roko_plan_run", {"plan_id": "demo-hello-world", "max_usd": 0.25})["run_id"]
    summary = views.card(rt, run_id)["why"]["summary"]
    assert "rm -rf" not in summary and "worktree move" not in summary


# -- init takes no other project's roko serve for this one's --------------------------------------------


def test_init_does_not_take_another_projects_serve_for_this_ones(
    project: Path,  # noqa: F811
    home: Path,  # noqa: F811
    roko: Path,  # noqa: F811
    saved: dict[str, str],  # noqa: F811
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-not-a-key")
    subprocess.run([str(roko), "init"], cwd=project, check=True, capture_output=True)
    other = tmp_path / "other"
    other.mkdir()
    subprocess.run([str(roko), "init"], cwd=other, check=True, capture_output=True)
    port = free_port()
    process = _start_serve(roko, other, port)  # another project's serve, on roko's usual port
    try:
        # This project's serve.json, left by a serve that stopped without removing it (a crash), on the same port.
        runtime = project / ".roko" / "runtime"
        runtime.mkdir(parents=True, exist_ok=True)
        (runtime / "serve.json").write_text(
            json.dumps(
                {
                    "pid": 999_999,
                    "url": f"http://127.0.0.1:{port}",
                    "workdir": str(project),
                    "started_at": "2026-10-14T09:00:00Z",
                }
            )
        )
        code, out = init(FakeContext({}), project, port=free_port(), yes=True)
        assert f"runs for this project at http://127.0.0.1:{port}" not in out, out
        assert "✓ roko serve: started at" in out and code == 0, out
    finally:
        process.terminate()
        process.wait(timeout=10)


# -- setup takes only a loopback URL from a workspace's serve.json ---------------------------------------


def test_setup_takes_only_a_loopback_url_from_serve_json(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    # serve.json is a file in the workspace: whatever can write it (a cloned repo's) must not be able to point
    # Hermes' key and every later request at another host, as settings._resolve_url already refuses.
    ws = tmp_path / "ws"
    (ws / ".roko" / "runtime").mkdir(parents=True)
    (ws / ".roko" / "runtime" / "serve.json").write_text(
        json.dumps({"pid": 1, "url": "https://roko.evil.invalid", "workdir": str(ws), "started_at": "x"})
    )
    monkeypatch.setenv("ROKO_API_KEY", "roko_" + "k" * 43)
    # The default address, closed: a roko serve the machine runs on 6677 must neither answer this test nor get
    # its probe (round v7: one did, and the setup passed).
    monkeypatch.setattr(settings, "DEFAULT_URL", "http://127.0.0.1:9")
    rt = Runtime(FakeContext({}))
    try:
        parser = argparse.ArgumentParser(prog="hermes roko")
        cli.build_parser(parser)
        code = cli.make_main(rt)(parser.parse_args(["setup", "--workdir", str(ws), "--dry-run"]))
    finally:
        rt.close()
    out = capsys.readouterr().out
    assert "roko serve: https://roko.evil.invalid" not in out and "ignored" in out, out
    assert code != 0  # nothing answers at the default address in a test


# -- a run start survives a tool list it cannot read --------------------------------------------------


def test_a_tool_list_with_an_odd_entry_neither_breaks_a_start_nor_loses_the_rest(
    fake: FakeRoko, rt: Runtime, monkeypatch: pytest.MonkeyPatch
) -> None:
    client = rt.client()
    listed = {
        "tools": [
            "run_prompt",
            None,
            {"name": "run_prompt", "inputSchema": {"properties": {"prompt": {}, "title": {}}}},
        ]
    }
    monkeypatch.setattr(client, "rpc", lambda method, *args, **kwargs: listed)
    assert rt.cards.tool_arguments(client) == {"run_prompt": frozenset({"prompt", "title"})}


# -- a run's domain is one plain word before anyone is asked --------------------------------------------


@pytest.mark.parametrize(
    "domain",
    [
        "docs\x1b[2K\rcode",  # a terminal escape inside the approval line
        "code task, checked by every gate and free",  # words that read as the plugin's own
        "x" * 300,
    ],
)
def test_a_runs_domain_must_be_one_plain_word_before_anyone_is_asked(
    call: Any, approvals: Any, fake: FakeRoko, domain: str
) -> None:
    # The domain sits outside the quoted request in Hermes' approval line, in the plugin's own words.
    answer = call("roko_run", {"prompt": "x", "max_usd": 1, "domain": domain})
    assert answer["code"] == "invalid" and approvals.asked == []
    assert fake.tool_calls("run_prompt") == []


def test_a_custom_domain_word_still_runs_and_is_named(call: Any, approvals: Any, fake: FakeRoko) -> None:
    # roko takes any domain label (a [gates.packs.<kind>] pack can check it), so a plain word is passed on.
    answer = call("roko_run", {"prompt": "x", "max_usd": 1, "domain": "ml-eval"})
    assert answer.get("run_id") and "ml-eval" in approvals.asked[0]["message"]
    assert fake.tool_calls("run_prompt")[-1]["domain"] == "ml-eval"


# -- P7: a retry that ended before its checks leaves the earlier attempt's verdicts standing -------------


def test_a_retry_that_ran_no_check_keeps_the_last_checks_that_ran(
    call: Any, approvals: Any, fake: FakeRoko, rt: Runtime
) -> None:
    fake.run_script = ["failed"]
    run_id = call("roko_run", {"prompt": "Add a flag.", "max_usd": 0.5})["run_id"]
    task = {"plan_id": "p", "task_id": "T1"}
    fake.runs[run_id].events = [
        {"type": "task_started", **task, "title": "Add a flag", "ts_millis": 1},
        {"type": "agent_spawned", **task, "attempt": 1, "model": "m", "ts_millis": 2},
        {"type": "gate_result", **task, "gate": "verify[0:compile]", "passed": False, "ts_millis": 3},
        # The retry's agent stops before any check runs (a provider error, or no change at all).
        {"type": "agent_spawned", **task, "attempt": 2, "model": "m", "ts_millis": 4},
        {"type": "task_completed", **task, "outcome": "failed", "ts_millis": 5},
    ]
    card = views.card(rt, run_id)
    assert card["gates"] == {"passed": 0, "failed": 1, "total": 1, "retried": 0}
    assert "no gate ran" not in card["headline"] and "gates 0/1" in card["headline"], card["headline"]


# -- bug-9a5970: "plan execution failed for <plan>" after the run began is not a start roko refused ------

# roko's conductor stops a run at a task (roko-cli graph_task_dispatch/supervision.rs, ConductorStop).
STOPPED = "conductor watcher `stall` stopped the run at hello/T1: no output for 600s"


def test_a_run_roko_stopped_after_its_tasks_ran_is_not_one_roko_did_not_start(
    call: Any, approvals: Any, fake: FakeRoko, rt: Runtime
) -> None:
    # Since bug-9a5970 roko adds its run error to the run's own events, after the run's own end when the run
    # began (serve's record_refused_start): a conductor stop, or a plan's error, reads like a refused start.
    fake.add_plan("hello", "Hello", [{"id": "T1"}])
    fake.run_script = ["failed"]
    run_id = call("roko_plan_run", {"plan_id": "hello", "max_usd": 0.25})["run_id"]
    task = {"plan_id": "hello", "task_id": "T1"}
    fake.runs[run_id].events = [
        {"type": "plan_started", "plan_id": "hello", "tasks_total": 1, "ts_millis": 1},
        {"type": "task_started", **task, "title": "Say hello", "ts_millis": 2},
        {"type": "agent_spawned", **task, "attempt": 1, "model": "m", "ts_millis": 3},
        {"type": "run_completed", "run_id": run_id, "outcome": "failed", "ts_millis": 4},
        {
            "type": "error",
            "run_id": run_id,
            "message": f"plan execution failed for hello: {STOPPED}",
            "ts_millis": 5,
        },
    ]
    card = views.card(rt, run_id)
    why = card["why"]
    assert why["start_error"] is None and STOPPED in why["summary"], why
    assert "did not start" not in why["summary"] + card["headline"] + str(card["next"]), card
    texts = [entry["text"] for entry in ui_api.timeline(rt, run_id, {})["events"]]
    assert texts[-1] == f"error: plan execution failed for hello: {STOPPED}", texts
    # The live relay's hub error says the same for a run Hermes follows: it is not a start roko refused either.
    tracker = rt.cards.tracker(rt.settings().url, run_id)
    tracker.start_error = STOPPED
    tracker.final = None
    assert views.card(rt, run_id)["why"]["start_error"] is None


# -- init's model steps replaced a symlinked roko.toml with a copy ----------------------------------------


def test_init_edits_a_symlinked_roko_toml_where_it_lives(
    project: Path,  # noqa: F811
    home: Path,  # noqa: F811
    roko: Path,  # noqa: F811
    saved: dict[str, str],  # noqa: F811
    tmp_path: Path,
) -> None:
    # The setup fix edits a roko.toml that is a symlink where it lives (a dotfiles checkout, plugin-setup's
    # test_a_symlinked_roko_toml_is_edited_where_it_lives). Init's model steps put a copy in the link's place:
    # the person's own file stopped applying to this workspace, and nothing said so.
    real = tmp_path / "dotfiles" / "roko.toml"
    real.parent.mkdir()
    real.write_text(UNPRICED_TOML)
    (project / "roko.toml").symlink_to(real)
    (home / ".roko").mkdir()
    (home / ".roko" / ".env").write_text(
        "ROUTER_API_KEY=rk-test-not-a-key\nOPENAI_API_KEY=sk-test-not-a-key\n"
    )
    code, out = init(FakeContext({}), project, yes=True)
    assert code == 0, out
    assert (project / "roko.toml").is_symlink(), out
    rungs = tomllib.loads(real.read_text())["routing"]["ladder"]["rungs"]
    assert rungs[-1] == {"name": "priced", "model": "gpt-5-4-mini"}, rungs
    backups = list((project / ".roko" / "backups").glob("roko.toml.bak-*"))
    assert [backup.read_text() for backup in backups] == [UNPRICED_TOML]


# -- a cap stop after a check that did not pass is told to the model as "not a failed check" ---------------


def test_a_cap_stop_after_a_check_that_did_not_pass_is_not_told_as_no_failed_check(
    call: Any, approvals: Any, fake: FakeRoko, rt: Runtime
) -> None:
    # plugin-runs' capture of roko-caps' run (bug-4fabd0), with T1's check not passing this time: roko then
    # stopped T2 at the cap. The model heard "a stop, not a failed check" and told the person nothing failed.
    fake.add_plan("caps-check", "caps-check", [{"id": "T1", "title": "Add shout to wordy"}, {"id": "T2"}])
    run_id = call("roko_plan_run", {"plan_id": "caps-check", "max_usd": 0.03})["run_id"]
    rows = [dict(row) for row in CAP_STOPPED_ROWS]
    for row in rows:
        if row.get("task_id") == "T1" and row["type"] == "gate_result":
            row["passed"] = False
        if row.get("task_id") == "T1" and row["type"] == "task_completed":
            row["outcome"] = "failed"
    fake.runs[run_id].states = ["failed"]
    fake.runs[run_id].events = rows
    status = call("roko_status", {"run_id": run_id, "wait_secs": 0})
    assert status["budget_stop"]["stopped"] == ["T2"] and status["gates"]["not_passed"] == 1
    assert "not a failed check" not in status["next"], status["next"]
    assert "Task 1's check verify[0:runs] did not pass" in views.card(rt, run_id)["why"]["summary"]

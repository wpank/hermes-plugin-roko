"""What a request would cost before it starts (round v6, P7): the composer's "where it starts" panel.

roko runs every request from Hermes as one `focused` task, so it starts on the rung the workspace's ladder
gives that tier and may climb two rungs above it. roko estimates no request itself (its plan estimate gives
every task one average), so the numbers here are the plugin's, from history, and always approximate: the
similar runs Hermes started in this workspace (the run log), else the tasks roko recorded here
(`GET /api/learn/efficiency`). The checks are the ones roko picks for a request of the domain from the
workspace's roko.toml.
"""

from __future__ import annotations

import math
from pathlib import Path
from statistics import median
from typing import Any

from . import rundata
from .catalog import TERMINAL_STATES
from .runtime import Runtime
from .sanitize import clean

# roko runs a request from a chat host as one task at this tier (its serve_runtime: "A host's prompt runs at
# the tier `roko run` gives a simple one").
REQUEST_TIER = "focused"
# roko climbs a rung after two failed tries on one (rundata.FAILURES_PER_RUNG), at most this many times.
MAX_CLIMBS = 2
# The similar runs: the newest this many; a 90th percentile from at least MIN_SIMILAR; medium confidence from
# MEDIUM_FROM.
SIMILAR_RUNS = 20
MIN_SIMILAR = 3
MEDIUM_FROM = 10
# Run states that are a verdict: a cancelled or interrupted run's spend and time were cut short.
VERDICTS = ("succeeded", "failed", "unverified")
# roko's compile check for a code request when roko.toml names no check (its `prompt_verify_steps`).
COMPILE_CHECKS = (("Cargo.toml", "cargo check --workspace"), ("go.mod", "go build ./..."))
COMMAND_CHARS = 400


def estimate(rt: Runtime, domain: str, max_usd: float, *, reachable: bool) -> dict[str, Any]:
    """`GET /estimate` (`Estimate`, docs/ui-api.md) for a request of `domain` under the cap `max_usd`."""
    settings = rt.settings()
    client = rt.client(settings) if reachable else None
    ladder = rt.cards.ladder_view(client, settings.workdir)
    climb = climb_path(ladder)
    logged = rt.runs.recent(200)
    runs = similar_runs(logged, domain)
    history = rt.cards.task_history(client) if client is not None else []
    likely, basis = _likely(runs, history, ended_elsewhere(logged, domain))
    worst = worst_usd(likely["usd"] if likely else None, climb, ladder, max_usd)
    data = rt.cards.workspace_toml(settings.workdir)
    return {
        "start_rung": climb[0] if climb else None,
        "climb": climb,
        "ladder": ladder,
        "likely": likely,
        "worst_usd": worst,
        "max_usd": max_usd,
        "stops_at_cap": worst is None or worst >= max_usd,
        "similar": similar_view(runs),
        "checks": request_checks(data, settings.workdir, domain),
        "basis": basis,
        "confidence": "medium" if len(runs) >= MEDIUM_FROM else "low",
    }


def climb_path(ladder: list[dict[str, Any]] | None) -> list[str]:
    """The rungs a request from Hermes may run on, in order: the one its tier starts on (or the first above it
    such a run can use), then at most two above it that such a run can use; [] without a ladder."""
    if not ladder:
        return []
    names = [str(rung.get("rung")) for rung in ladder]
    starts = {
        str(tier): name for rung, name in zip(ladder, names, strict=True) for tier in rung.get("starts") or []
    }
    first = names.index(starts.get(REQUEST_TIER, names[0]))
    usable = [
        name
        for rung, name in list(zip(ladder, names, strict=True))[first:]
        if rung.get("chat_ok") is not False and not rung.get("why_not")
    ]
    return usable[: MAX_CLIMBS + 1]


def similar_runs(logged: list[dict[str, Any]], domain: str) -> list[dict[str, Any]]:
    """The newest one-task runs Hermes started in this workspace, in `domain`, that ended with a verdict and a
    cost (a run logged without its domain counts as code)."""
    return [
        run
        for run in logged
        if run.get("kind") == "run"
        and run.get("state") in VERDICTS
        and (run.get("domain") or "code") == domain
        and rundata._is_number(run.get("cost_usd"))
    ][:SIMILAR_RUNS]


def similar_view(runs: list[dict[str, Any]]) -> dict[str, Any] | None:
    """`similar`: how many runs and tasks, how many passed on the first try, and the 90th percentile of their
    cost (from MIN_SIMILAR runs on)."""
    if not runs:
        return None
    records = [run["learning"] for run in runs if isinstance(run.get("learning"), dict)]
    tasks = sum(int(record.get("tasks") or 0) for record in records)
    first_try = sum(int(record.get("first_try") or 0) for record in records)
    costs = sorted(float(run["cost_usd"]) for run in runs)
    return {
        "runs": len(runs),
        "tasks": tasks,
        "first_try": first_try,
        "first_try_rate": round(first_try / tasks, 3) if tasks else None,
        # Nearest rank: the cost 90% of the runs stayed at or under.
        "p90_usd": round(costs[math.ceil(0.9 * len(costs)) - 1], 4) if len(costs) >= MIN_SIMILAR else None,
    }


def _likely(
    runs: list[dict[str, Any]], history: list[dict[str, Any]], elsewhere: list[str]
) -> tuple[dict[str, Any] | None, str]:
    """≈ what the request will cost and take, and a basis that says what it used: the median of the similar
    runs (from MIN_SIMILAR of them, or when roko has no history), else of the tasks roko recorded here, else
    nothing; then the basis names the runs that did end here and why they do not count (`elsewhere`)."""
    if runs and (len(runs) >= MIN_SIMILAR or not history):
        seconds = [
            ms / 1000
            for run in runs
            if (ms := rundata._between(run.get("started_at"), run.get("finished_at")))
        ]
        likely = {
            "usd": round(median(float(run["cost_usd"]) for run in runs), 4),
            "seconds": round(median(seconds)) if seconds else None,
        }
        return likely, f"≈ the median of {_count(len(runs), 'similar run')} Hermes started here"
    if history:
        times = [task["duration_ms"] / 1000 for task in history if task.get("duration_ms")]
        likely = {
            "usd": round(median(task["cost_usd"] for task in history), 4),
            "seconds": round(median(times)) if times else None,
        }
        lead = (
            f"only {_count(len(runs), 'similar run')} from Hermes"
            if runs
            else "no similar one-task run from Hermes yet"
        )
        return (
            likely,
            f"{lead}; ≈ the median of {_count(len(history), 'task')} roko recorded here, of every kind",
        )
    if not elsewhere:
        return None, "nothing to go by yet: no run has ended here"
    verb = "has" if _only_one(elsewhere) else "have"
    return None, f"nothing to go by yet: no similar one-task run has ended here ({_join(elsewhere)} {verb})"


def ended_elsewhere(logged: list[dict[str, Any]], domain: str) -> list[str]:
    """The runs that ended here but are no similar run for a request of `domain`, in groups a basis can name:
    plan runs, one-task runs in another domain, ones that ended without a verdict, and ones with no cost."""
    plans = other = cut = unpriced = 0
    for run in logged:
        if run.get("state") not in TERMINAL_STATES:
            continue
        if run.get("kind") == "plan":
            plans += 1
        elif run.get("kind") == "run":
            if (run.get("domain") or "code") != domain:
                other += 1
            elif run.get("state") not in VERDICTS:
                cut += 1
            elif not rundata._is_number(run.get("cost_usd")):
                unpriced += 1
    groups = (
        (plans, "plan run", "plan runs"),
        (other, "run in another domain", "runs in another domain"),
        (cut, "run that ended without a verdict", "runs that ended without a verdict"),
        (unpriced, "run with no cost", "runs with no cost"),
    )
    return [f"{number} {one if number == 1 else many}" for number, one, many in groups if number]


def _only_one(groups: list[str]) -> bool:
    """Whether the groups name one run in all ("1 plan run"), so the verb after them is singular."""
    return len(groups) == 1 and groups[0].startswith("1 ")


def _join(parts: list[str]) -> str:
    return parts[0] if len(parts) == 1 else ", ".join(parts[:-1]) + " and " + parts[-1]


def worst_usd(
    likely: float | None, climb: list[str], ladder: list[dict[str, Any]] | None, max_usd: float
) -> float | None:
    """≈ the most the request would spend if every try failed: two tries on each rung of its climb, each
    costing `likely` scaled by the rung's list prices against the start rung's, never above the cap. None when
    the likely cost or a rung's prices are unknown."""
    if likely is None or not climb:
        return None
    prices = {str(rung.get("rung")): _price(rung) for rung in ladder or []}
    start = prices.get(climb[0])
    if not start:
        return None
    total = 0.0
    for name in climb:
        price = prices.get(name)
        if price is None:
            return None
        total += rundata.FAILURES_PER_RUNG * likely * price / start
    return round(min(total, max_usd), 4)


def _price(rung: dict[str, Any]) -> float | None:
    """A rung's list price for comparing rungs: input plus output USD per million tokens, or None unpriced."""
    price_in, price_out = rung.get("price_in"), rung.get("price_out")
    if not (rundata._is_number(price_in) and rundata._is_number(price_out)):
        return None
    return float(price_in) + float(price_out)


def request_checks(data: dict[str, Any], workdir: Path | None, domain: str) -> list[dict[str, Any]] | None:
    """The checks roko runs on a request of `domain` from Hermes (its `prompt_verify_steps`): the domain's
    `[gates.packs.<domain>]` rungs, else, for code (which the plugin sends roko without a domain), its
    `[[gates.rungs]]`, the required ones that run a command; with none, a code request in a Rust or Go
    workspace gets roko's compile check. None when the plugin cannot read the workspace."""
    if workdir is None:
        return None
    gates = data["gates"] if isinstance(data.get("gates"), dict) else {}
    packs = gates["packs"] if isinstance(gates.get("packs"), dict) else {}
    if domain == "code":
        rungs = gates.get("rungs", gates.get("custom_rungs"))
    else:
        pack = packs.get(domain)
        rungs = pack.get("rungs") if isinstance(pack, dict) else []
    rows = [rung for rung in rungs if isinstance(rung, dict)] if isinstance(rungs, list) else []
    if rows or domain != "code":
        steps = [rung for rung in rows if _required_step(rung)]
        return [
            {
                "name": f"verify[{index}:{clean(rung.get('name'), 60, one_line=True)}]",
                "phase": clean(rung.get("name"), 60, one_line=True),
                "command": clean(rung.get("command"), COMMAND_CHARS, one_line=True),
                "source": "roko.toml",
            }
            for index, rung in enumerate(steps)
        ]
    for marker, command in COMPILE_CHECKS:
        if (workdir / marker).is_file():
            return [{"name": "verify[0:compile]", "phase": "compile", "command": command, "source": "roko"}]
    return []


def _required_step(rung: dict[str, Any]) -> bool:
    """roko's `is_required_step`: required (the default), not advisory (a `judge` rung advises unless it says
    otherwise), and a `command` rung (the default kind) with a command."""
    kind = rung.get("kind") or "command"
    advisory = rung.get("advisory")
    advises = advisory if isinstance(advisory, bool) else kind == "judge"
    command = rung.get("command")
    return (
        rung.get("required", True) is True
        and not advises
        and kind == "command"
        and isinstance(command, str)
        and bool(command.strip())
    )


def _count(number: int, noun: str) -> str:
    return f"{number} {noun}" if number == 1 else f"{number} {noun}s"

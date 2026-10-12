"""What roko runs wait on the person for, and opaque ids to answer them by.

roko holds two kinds of things for a person: a *confirmation* that a task's
result is what they asked for (the confirm rung), and an *effect*, an outbound
tool call such as a send or a post that a chat-started run may not make on
its own. Each gets a `decision_id` the model and the person can quote back.
A confirmation is named by (run, task, attempt key), and attempt keys contain
colons, so its id is that triple encoded rather than joined.
"""

from __future__ import annotations

import base64
import hashlib
import json
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

from .client import RokoClient
from .errors import Code, RokoError
from .sanitize import clean

CONFIRM_PREFIX = "c_"
EFFECT_PREFIX = "e_"
# Applying a held effect starts the workspace's MCP server, replays the call
# and runs its receipt checks (120 s by default in roko), so answers get far
# longer than the default request timeout.
ANSWER_TIMEOUT_S = 240.0
# A confirm rung waits this long for an answer by default, then skips and the
# task ends unverified (crates/roko-cli/src/graph_task_dispatch/gates.rs).
CONFIRM_TIMEOUT_S = 120
SUMMARY_CHARS = 2048


@dataclass(frozen=True)
class Confirmation:
    run_id: str
    task_id: str
    attempt_key: str


@dataclass(frozen=True)
class Effect:
    effect_id: str


Decision = Confirmation | Effect


def confirmation_id(run_id: str, task_id: str, attempt_key: str) -> str:
    raw = json.dumps([run_id, task_id, attempt_key], separators=(",", ":")).encode()
    return CONFIRM_PREFIX + base64.urlsafe_b64encode(raw).decode().rstrip("=")


def effect_decision_id(effect_id: str) -> str:
    return EFFECT_PREFIX + effect_id


def parse_decision_id(decision_id: str) -> Decision:
    value = decision_id.strip()
    if value.startswith(EFFECT_PREFIX) and len(value) > len(EFFECT_PREFIX):
        return Effect(value[len(EFFECT_PREFIX) :])
    if value.startswith(CONFIRM_PREFIX):
        encoded = value[len(CONFIRM_PREFIX) :]
        try:
            raw = base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4))
            parts = json.loads(raw)
        except (ValueError, TypeError) as exc:
            raise _bad_id(decision_id) from exc
        if isinstance(parts, list) and len(parts) == 3 and all(isinstance(p, str) and p for p in parts):
            return Confirmation(parts[0], parts[1], parts[2])
    raise _bad_id(decision_id)


def _bad_id(decision_id: str) -> RokoError:
    return RokoError(
        Code.INVALID,
        f"{decision_id!r} is not a decision id roko_status gave out",
        hint="call roko_status for the run and use a decision_id from its waiting_on_person list",
    )


def short_code(decision_id: str) -> str:
    """A 6-character code for a decision, the same in every chat and process."""
    return hashlib.sha256(decision_id.encode()).hexdigest()[:6]


def pending_for_run(client: RokoClient, run_id: str) -> list[dict[str, Any]]:
    """Confirmations and held effects one run waits on, newest information first."""
    items = pending_confirmations(client, run_id)
    items.extend(pending_effects(client, run_id))
    return items


def pending_effects(client: RokoClient, run_id: str | None = None) -> list[dict[str, Any]]:
    arguments = {"run_id": run_id} if run_id else {}
    body = client.call_tool("effects_pending", arguments)
    waiting = body.get("waiting") if isinstance(body, dict) else None
    items: list[dict[str, Any]] = []
    for effect in waiting if isinstance(waiting, list) else []:
        if not isinstance(effect, dict) or not effect.get("effect_id"):
            continue
        decision_id = effect_decision_id(str(effect["effect_id"]))
        tool = clean(effect.get("tool") or "?", 80, one_line=True)
        server = clean(effect.get("server") or "?", 80, one_line=True)
        item: dict[str, Any] = {
            "code": short_code(decision_id),
            "decision_id": decision_id,
            "kind": "effect",
            "title": "",
            "question": f"May the run call {tool} on {server} once, as proposed?",
            "run_id": clean(effect.get("run_id"), 80, one_line=True),
            "plan_id": clean(effect.get("plan_id"), 120, one_line=True) or None,
            "task_id": clean(effect.get("task_id"), 80, one_line=True) or None,
            "tool": tool,
            "server": server,
            "arguments": _argument_types(effect.get("arguments")),
            "proposed_at": _text_or_none(effect.get("proposed_at")),
        }
        item["title"] = title_of(item)
        items.append(item)
    return items


def pending_confirmations(client: RokoClient, run_id: str) -> list[dict[str, Any]]:
    body = client.call_tool("confirm_pending", {"run_id": run_id})
    pending = body.get("pending") if isinstance(body, dict) else None
    items: list[dict[str, Any]] = []
    for hold in pending if isinstance(pending, list) else []:
        if not isinstance(hold, dict) or not hold.get("task_id") or not hold.get("attempt_key"):
            continue
        decision_id = confirmation_id(run_id, str(hold["task_id"]), str(hold["attempt_key"]))
        held_at = _text_or_none(hold.get("held_at"))
        item: dict[str, Any] = {
            "code": short_code(decision_id),
            "decision_id": decision_id,
            "kind": "confirm",
            "title": "",
            "question": clean(hold.get("question") or "Is the result what you asked for?", 500),
            "summary": clean(hold.get("summary"), SUMMARY_CHARS) or None,
            "run_id": run_id,
            "plan_id": clean(hold.get("plan_id"), 120, one_line=True) or None,
            "task_id": clean(hold["task_id"], 80, one_line=True),
            "task_title": clean(hold.get("title"), 120, one_line=True) or None,
            "held_at": held_at,
            "deadline_at": _plus_seconds(held_at, CONFIRM_TIMEOUT_S),
        }
        item["title"] = title_of(item)
        items.append(item)
    return items


def title_of(item: dict[str, Any]) -> str:
    """One line naming a pending item, for lists, approvals and replies."""
    run = str(item.get("run_id") or "?")[:8]
    if item.get("kind") == "confirm":
        title = f" ({item['task_title']})" if item.get("task_title") else ""
        return f"the result of task {item.get('task_id')}{title} in run {run}"
    return f"the held action {item.get('tool')} on {item.get('server')} (run {run})"


def _argument_types(value: Any) -> dict[str, str] | None:
    """roko lists a held call's argument types and sizes, never their values."""
    if not isinstance(value, dict):
        return None
    return {
        clean(key, 60, one_line=True): clean(kind, 60, one_line=True)
        for key, kind in list(value.items())[:20]
    }


def _text_or_none(value: Any) -> str | None:
    text = clean(value, 64, one_line=True) if value is not None else ""
    return text or None


def _plus_seconds(stamp: str | None, seconds: int) -> str | None:
    if not stamp:
        return None
    try:
        when = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
    except ValueError:
        return None
    return (when + timedelta(seconds=seconds)).isoformat(timespec="seconds")


def find_pending(client: RokoClient, decision: Decision) -> dict[str, Any] | None:
    """The pending item a decision answers, or None if roko no longer waits on it."""
    if isinstance(decision, Effect):
        items = pending_effects(client)
    else:
        items = pending_confirmations(client, decision.run_id)
    wanted = (
        effect_decision_id(decision.effect_id)
        if isinstance(decision, Effect)
        else confirmation_id(decision.run_id, decision.task_id, decision.attempt_key)
    )
    return next((item for item in items if item.get("decision_id") == wanted), None)


def describe(item: dict[str, Any]) -> str:
    """What a pending item asks, as one line for an approval prompt or a reply."""
    if item.get("kind") == "effect":
        arguments = item.get("arguments") or {}
        shown = ", ".join(f"{key}: {kind}" for key, kind in arguments.items()) if arguments else "none"
        return clean(
            f"{title_of(item)}, task {item.get('task_id', '?')}, arguments {shown}", 400, one_line=True
        )
    return clean(f"{title_of(item)}: {item.get('question')}", 400, one_line=True)


def answer(client: RokoClient, decision: Decision, approve: bool, note: str | None) -> Any:
    """Send the person's answer to roko.

    A timeout here does not mean nothing happened: roko may have recorded the
    answer, or applied the held effect, before the plugin stopped waiting.
    """
    if isinstance(decision, Effect):
        arguments: dict[str, Any] = {"effect_id": decision.effect_id, "approve": approve}
        tool = "effect_decide"
    else:
        arguments = {
            "run_id": decision.run_id,
            "task_id": decision.task_id,
            "attempt_key": decision.attempt_key,
            "approve": approve,
        }
        tool = "confirm_answer"
    if note:
        arguments["note"] = note
    try:
        return client.call_tool(tool, arguments, timeout=ANSWER_TIMEOUT_S)
    except RokoError as exc:
        if exc.timed_out:
            raise RokoError(
                Code.UNREACHABLE,
                "roko did not confirm the answer in time; it may still have been recorded"
                + (" and the action applied" if isinstance(decision, Effect) else ""),
                hint="check roko_status for the run before answering again",
                timed_out=True,
            ) from exc
        raise

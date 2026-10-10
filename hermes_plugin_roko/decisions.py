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
from typing import Any

from .client import RokoClient
from .errors import Code, RokoError

CONFIRM_PREFIX = "c_"
EFFECT_PREFIX = "e_"
# Applying a held effect starts the workspace's MCP server, replays the call
# and runs its receipt checks (120 s by default in roko), so answers get far
# longer than the default request timeout.
ANSWER_TIMEOUT_S = 240.0


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
        items.append(
            {
                "decision_id": effect_decision_id(str(effect["effect_id"])),
                "kind": "effect",
                "question": (
                    f"May the run call {effect.get('tool', '?')} on {effect.get('server', '?')} "
                    "once, as proposed?"
                ),
                "run_id": effect.get("run_id"),
                "task_id": effect.get("task_id"),
                "tool": effect.get("tool"),
                "server": effect.get("server"),
                "arguments": effect.get("arguments"),
                "proposed_at": effect.get("proposed_at"),
            }
        )
    return items


def pending_confirmations(client: RokoClient, run_id: str) -> list[dict[str, Any]]:
    body = client.call_tool("confirm_pending", {"run_id": run_id})
    pending = body.get("pending") if isinstance(body, dict) else None
    items: list[dict[str, Any]] = []
    for hold in pending if isinstance(pending, list) else []:
        if not isinstance(hold, dict) or not hold.get("task_id") or not hold.get("attempt_key"):
            continue
        items.append(
            {
                "decision_id": confirmation_id(run_id, str(hold["task_id"]), str(hold["attempt_key"])),
                "kind": "confirm",
                "question": hold.get("question") or "Is the result what you asked for?",
                "run_id": run_id,
                "plan_id": hold.get("plan_id"),
                "task_id": hold.get("task_id"),
                "title": hold.get("title"),
                "summary": hold.get("summary"),
                "held_at": hold.get("held_at"),
            }
        )
    return items


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
    """What a pending item asks, in one line for an approval prompt or a reply."""
    if item.get("kind") == "effect":
        return (
            f"the held action {item.get('tool', '?')} on {item.get('server', '?')} "
            f"(run {item.get('run_id', '?')}, task {item.get('task_id', '?')}, "
            f"arguments {item.get('arguments')})"
        )
    title = f" ({item['title']})" if item.get("title") else ""
    return (
        f"the result of task {item.get('task_id')}{title} in run {item.get('run_id')}: {item.get('question')}"
    )


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

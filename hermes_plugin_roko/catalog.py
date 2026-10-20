"""What the plugin offers the model, and what it expects roko serve to offer it.

The plugin's tools are a Hermes-shaped face on roko's `POST /mcp` contract
(documented in roko's docs/v3/26-HTTP-API.md §8.41) plus two REST reads that
contract lacks (`roko_plans`, and the overview in `roko_status`). The
descriptions are written for the model: they say what each tool costs, what
it returns, and which tool comes next.
"""

from __future__ import annotations

from typing import Any

TOOLSET = "roko"

# Roko's MCP tools this plugin calls. `hermes roko doctor` compares them with
# roko serve's tools/list so a roko that renamed or dropped one is caught.
ROKO_MCP_TOOLS: tuple[str, ...] = (
    "run_status",
    "recall",
    "run_prompt",
    "plan_run",
    "plan_generate",
    "run_cancel",
    "confirm_pending",
    "confirm_answer",
    "effects_pending",
    "effect_decide",
)

# How long one roko_status call may wait for a run's state to change. The
# plugin waits in short server-side slices; Hermes ends a tool call after
# 420 s, so this stays well below that.
MAX_WAIT_SECS = 300
DEFAULT_WAIT_SECS = 60
# "missing" is the plugin's own: a run Hermes started that roko keeps no record of. "interrupted": roko
# stopped while the run was going (a restart or a crash), as roko says since bug-dceafd or the plugin finds.
TERMINAL_STATES = frozenset({"succeeded", "failed", "unverified", "cancelled", "interrupted", "missing"})
# What roko_status(run_id) returns: the run card, plus every task's result, or why it ended as it did.
DETAIL_LEVELS = ("summary", "tasks", "why")


# 0.7.0: each project has its own roko serve; a tool works in the one this names.
_PROJECT = {
    "type": "string",
    "description": (
        "Optional: the project to work in, as a folder path or the name of a project roko knows (roko_status "
        "lists them). Leave it out to use this chat's folder when roko knows it, else the default project. "
        "Name a project only when the person did; every answer says which project it used."
    ),
}

_TITLE = {
    "type": "string",
    "description": (
        "Optional: a short name for this run that the person sees in their run lists, under 60 "
        'characters, e.g. "Add budgets to tally". Without it the list shows the start of the request.'
    ),
}


# P-8: `_TITLE` read as a run's name in lists, so asked to title a plan, the model wrote the title into the
# request ("Title: P0 · …"), and roko made the plan's id from that (`title-p0-…`).
_PLAN_TITLE = {
    "type": "string",
    "description": (
        'Optional: the plan\'s title, under 60 characters, e.g. "P2 · Rumble and modulation". roko '
        "makes the plan's id from it (p2-rumble-and-modulation), and the person sees it in their lists. "
        "When the person names the plan, put that name here, never in prompt."
    ),
}


def _cap_description(max_run_usd: float) -> str:
    return (
        "Spending cap for this run in US dollars: roko stops spending model budget at "
        f"this amount. Must be above 0 and at most {max_run_usd:.2f}. Pick what the work "
        "is worth; a small change rarely needs more than 1.00."
    )


def tool_schemas(max_run_usd: float) -> dict[str, dict[str, Any]]:
    """The OpenAI-style function schemas Hermes shows the model, by tool name."""
    return {
        "roko_run": {
            "name": "roko_run",
            "description": (
                "Delegate one piece of work to roko as a single gated task: a roko agent does it "
                "in roko's workspace, and the workspace's checks (gates such as build, lint and "
                "tests) must pass before roko counts it as done. Use it for a well-defined change, "
                "fix, report or research task; for larger multi-step work use roko_plan_generate. "
                "Paid: spends model budget up to max_usd. Hermes asks the person first unless its "
                "approvals are off, so call it once, for a run the person asked for in this turn, and "
                "never to retry a refused or failed run on your own. Answers at once with a run_id; "
                "follow it with roko_status until the run ends. While it runs, the work is roko's: do "
                "not edit the project's files or run its checks yourself, and cancel it only if the "
                "person asks."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "prompt": {
                        "type": "string",
                        "description": (
                            "The task, stated completely: roko's agent sees only this text, not "
                            "this conversation. Name files, the expected outcome and how to check it."
                        ),
                    },
                    "max_usd": {"type": "number", "description": _cap_description(max_run_usd)},
                    "domain": {
                        "type": "string",
                        "description": (
                            "What kind of work this is, which picks the checks that verify it. Leave "
                            "it out (code, the default: the project's own build, lint and tests run) "
                            "unless the person asks for prose only, even for a README or another text "
                            "file in the project. docs or research run no project checks unless "
                            "roko.toml has a [gates.packs.docs] or [gates.packs.research] pack, so such "
                            "a run usually ends unverified."
                        ),
                    },
                    "title": _TITLE,
                    "project": _PROJECT,
                },
                "required": ["prompt", "max_usd"],
            },
        },
        "roko_plan_generate": {
            "name": "roko_plan_generate",
            "description": (
                "Have roko's planner turn a larger request into a plan: a graph of small tasks, "
                "each with its own checks, that roko can run in parallel. Writes the plan without "
                "running it. When the work is written down in a file in the project (a spec or a PRD), "
                "pass that file's path as spec_path: roko reads the file exactly, so never copy or "
                "summarize it into prompt. Paid: the planner spends model budget. Hermes asks the "
                "person first "
                "unless its approvals are off, so call it only when the person asked for a plan in "
                "this turn. Answers at once with a run_id and the plan_id. Follow the run_id with "
                "roko_status until it succeeds, show the plan with roko_plans(plan_id), and run it "
                "with roko_plan_run once the person agrees."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "prompt": {
                        "type": "string",
                        "description": (
                            "The request, stated completely, with its goal, constraints and what "
                            "done looks like. The planner sees only this text. With spec_path, only "
                            "what the person adds to the spec, or leave it out."
                        ),
                    },
                    "spec_path": {
                        "type": "string",
                        "description": (
                            "A file in the project that specifies the work, as a path relative to the "
                            "project (docs/specs/phase-2-rumble.md). roko reads it exactly as written."
                        ),
                    },
                    "title": _PLAN_TITLE,
                    "project": _PROJECT,
                },
                "required": [],
            },
        },
        "roko_plan_run": {
            "name": "roko_plan_run",
            "description": (
                "Run one of roko's plans (see roko_plans): its tasks run in dependency order, in "
                "parallel where the plan allows, each one checked by gates; if another plan is "
                "running, this run waits in a queue. Paid: spends model budget up to max_usd. "
                "Hermes asks the person first unless its approvals are off, so call it once, after "
                "the person agreed to this run in this turn, and never to run or resume a plan again "
                "on your own after a refusal or failure. When the plan's last run stopped part way "
                "it is refused, before anything is approved or spent, until the call says resume: true "
                "(only what is left runs) or fresh: true (start over): ask the person which. Answers at "
                "once with a run_id; follow it with roko_status until the run ends. While it runs, the "
                "work is roko's: do not edit the project's files or run its checks yourself, and cancel "
                "it only if the person asks."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "plan_id": {"type": "string", "description": "The plan's id, as roko_plans lists it."},
                    "max_usd": {"type": "number", "description": _cap_description(max_run_usd)},
                    "resume": {
                        "type": "boolean",
                        "description": (
                            "Continue this plan's last run from where it stopped: only the tasks it has "
                            "not passed run. Use it when the person asks to resume or continue."
                        ),
                    },
                    "fresh": {
                        "type": "boolean",
                        "description": (
                            "Start the plan over, setting its last run's progress aside (it can be "
                            "brought back). Only when the person asks to start over."
                        ),
                    },
                    "from_run": {
                        "type": "string",
                        "description": (
                            "Continue this earlier run of the plan instead of its last one: its id, or "
                            "its first 8 characters."
                        ),
                    },
                    "title": _TITLE,
                    "project": _PROJECT,
                },
                "required": ["plan_id", "max_usd"],
            },
        },
        "roko_status": {
            "name": "roko_status",
            "description": (
                "Check a roko run: its state (queued, running, succeeded, failed, unverified, "
                "cancelled or interrupted), a one-line headline, cost against its cap, gate and task "
                "counts, where the work landed, and anything waiting on the person "
                "(waiting_on_person). Waits up to wait_secs and answers as soon as the state changes. "
                "While a run goes, the work is roko's: do not edit the project's files or run its "
                "checks yourself, cancel it only if the person asks, and keep waiting when it is "
                "quiet. succeeded: roko's gates verified the result; unverified: nothing checked it; "
                "interrupted: roko stopped mid-run (a restart or a crash) and kept what had passed. "
                'detail "tasks" adds each task\'s model, attempts and gates; detail "why" explains a '
                "run that did not pass. Without run_id: roko's health, recent runs from Hermes, "
                "today's spend, and what waits on the person. If roko refused or a run failed, tell "
                "the person and stop: never repair roko's workspace (worktrees, branches, .roko/, "
                "roko.toml) or start the run again yourself."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "run_id": {
                        "type": "string",
                        "description": (
                            'The run\'s id, or "last" for the run Hermes started most recently. '
                            "Omit for an overview."
                        ),
                    },
                    "detail": {
                        "type": "string",
                        "enum": list(DETAIL_LEVELS),
                        "description": (
                            "summary (the default), tasks (every task's result), or why (what "
                            "made the run end as it did, with gate output)."
                        ),
                    },
                    "wait_secs": {
                        "type": "integer",
                        "minimum": 0,
                        "maximum": MAX_WAIT_SECS,
                        "description": (
                            f"How long to wait for the state to change, 0 to {MAX_WAIT_SECS} "
                            f"seconds. Default {DEFAULT_WAIT_SECS}."
                        ),
                    },
                    "project": {
                        **_PROJECT,
                        "description": (
                            "Optional, without run_id: the project whose overview to show (a folder path or "
                            "a known project's name). A run is always looked up in its own project."
                        ),
                    },
                },
                "required": [],
            },
        },
        "roko_cancel": {
            "name": "roko_cancel",
            "description": (
                "Stop a roko run that is running or queued, only when the person asks you to in this "
                "turn: never to save its cost or to do the work yourself instead. Pass their reason; "
                'the run\'s card then says "cancelled from chat: <reason>". Free, and needs no '
                "approval. Work that already passed its checks is kept."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "run_id": {"type": "string", "description": 'The run\'s id, or "last".'},
                    "reason": {
                        "type": "string",
                        "description": (
                            "Why it is stopped, as the person's own request (for example \"you asked "
                            "to stop it: wrong file\"), shown on the run's card. At most 200 characters."
                        ),
                    },
                },
                "required": ["run_id", "reason"],
            },
        },
        "roko_plans": {
            "name": "roko_plans",
            "description": (
                "List roko's plans with their id, title, task count and status; or, with "
                "plan_id, show one plan's tasks, what each depends on and how each is checked, "
                "the waves of tasks that can run together, and roko's cost estimate from past "
                "runs. Free and read-only. Use it to find a plan_id for roko_plan_run, and to "
                "show the person a plan and its estimate before running it."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "plan_id": {"type": "string", "description": "A plan's id, to show its tasks."},
                    "project": _PROJECT,
                },
                "required": [],
            },
        },
        "roko_recall": {
            "name": "roko_recall",
            "description": (
                "Search roko's project knowledge: the lessons, facts and warnings roko's verified "
                "runs recorded about this workspace, most relevant first. Free and read-only. Use "
                "it before planning work in an unfamiliar part of the project."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "What to look up, in plain words."},
                    "limit": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 20,
                        "description": "How many entries to return, 1 to 20. Default 5.",
                    },
                    "project": _PROJECT,
                },
                "required": ["query"],
            },
        },
        "roko_decide": {
            "name": "roko_decide",
            "description": (
                "Record the person's own decision on something a roko run waits for, as listed "
                "by roko_status under waiting_on_person: a confirmation that a task's result is "
                "what they asked for, or an outbound action (a send, post or payment) roko held "
                "for approval. Ask the person first and pass exactly what they decided: approve "
                "true confirms the result or lets the held action run once; false rejects it, "
                "with note as feedback. Never decide on your own; Hermes also asks the person to "
                "approve this call unless they turned that off or its approvals are off, and then "
                "their words in the chat are the only check."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "decision_id": {
                        "type": "string",
                        "description": (
                            "The decision_id from roko_status's waiting_on_person list, or the "
                            "item's 6-character code."
                        ),
                    },
                    "approve": {
                        "type": "boolean",
                        "description": "The person's answer: true to approve, false to reject.",
                    },
                    "note": {
                        "type": "string",
                        "description": "The person's reason or feedback, in their words.",
                    },
                },
                "required": ["decision_id", "approve"],
            },
        },
    }


# One wide emoji per tool, for Hermes' tool progress lines.
TOOL_EMOJI = {
    "roko_status": "\u23f3",  # hourglass
    "roko_plans": "\U0001f4cb",  # clipboard
    "roko_run": "\U0001f680",  # rocket
    "roko_plan_generate": "\U0001f9ed",  # compass
    "roko_plan_run": "\U0001f6a6",  # traffic light
    "roko_cancel": "\U0001f6d1",  # stop sign
    "roko_recall": "\U0001f4a1",  # light bulb
    "roko_decide": "\u2705",  # check mark
}

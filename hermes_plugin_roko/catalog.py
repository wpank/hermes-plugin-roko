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
TERMINAL_STATES = frozenset({"succeeded", "failed", "unverified", "cancelled"})


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
                "Paid: spends model budget up to max_usd, and Hermes asks the person to approve "
                "it first unless they turned that off. Answers at once with a run_id; follow it "
                "with roko_status until the run ends."
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
                            "What kind of work this is, which picks the checks that verify it: "
                            "code (the default), research or docs."
                        ),
                    },
                },
                "required": ["prompt", "max_usd"],
            },
        },
        "roko_plan_generate": {
            "name": "roko_plan_generate",
            "description": (
                "Have roko's planner turn a larger request into a plan: a graph of small tasks, "
                "each with its own checks, that roko can run in parallel. Writes the plan without "
                "running it. Paid: the planner spends model budget, and Hermes asks the person to "
                "approve it first unless they turned that off. Answers at once with a run_id and "
                "the plan_id. Follow the "
                "run_id with roko_status until it succeeds, show the plan with "
                "roko_plans(plan_id), and run it with roko_plan_run once the person agrees."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "prompt": {
                        "type": "string",
                        "description": (
                            "The request, stated completely, with its goal, constraints and what "
                            "done looks like. The planner sees only this text."
                        ),
                    }
                },
                "required": ["prompt"],
            },
        },
        "roko_plan_run": {
            "name": "roko_plan_run",
            "description": (
                "Run one of roko's plans (see roko_plans): its tasks run in dependency order, in "
                "parallel where the plan allows, each one checked by gates; if another plan is "
                "running, this run waits in a queue. Paid: spends model budget up to max_usd, "
                "and Hermes asks the person to approve it first unless they turned that off. "
                "Answers at once with a run_id; follow it with roko_status until the run ends."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "plan_id": {"type": "string", "description": "The plan's id, as roko_plans lists it."},
                    "max_usd": {"type": "number", "description": _cap_description(max_run_usd)},
                    "resume": {
                        "type": "boolean",
                        "description": (
                            "Continue this plan's previous run, skipping tasks that already "
                            "passed, instead of starting fresh. Default false."
                        ),
                    },
                },
                "required": ["plan_id", "max_usd"],
            },
        },
        "roko_status": {
            "name": "roko_status",
            "description": (
                "Check a roko run started with roko_run, roko_plan_run or roko_plan_generate: its "
                "state (queued, running, succeeded, failed, unverified or cancelled), verdict, "
                "cost, task results and milestones, and anything waiting on the person "
                "(waiting_on_person). Waits up to wait_secs for the state to change and answers as "
                "soon as it does, so a few calls with a long wait follow a run to its end. "
                "succeeded means roko's gates verified the result; unverified means nothing "
                "checked it. Without run_id: roko's health and the runs Hermes started recently."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "run_id": {"type": "string", "description": "The run's id. Omit for an overview."},
                    "wait_secs": {
                        "type": "integer",
                        "minimum": 0,
                        "maximum": MAX_WAIT_SECS,
                        "description": (
                            f"How long to wait for the state to change, 0 to {MAX_WAIT_SECS} "
                            f"seconds. Default {DEFAULT_WAIT_SECS}."
                        ),
                    },
                },
                "required": [],
            },
        },
        "roko_cancel": {
            "name": "roko_cancel",
            "description": (
                "Stop a roko run that is running or queued. Free, and needs no approval. Work "
                "that already passed its checks is kept."
            ),
            "parameters": {
                "type": "object",
                "properties": {"run_id": {"type": "string", "description": "The run's id."}},
                "required": ["run_id"],
            },
        },
        "roko_plans": {
            "name": "roko_plans",
            "description": (
                "List roko's plans with their id, title, task count and status; or, with "
                "plan_id, show one plan's tasks, what each depends on and how each is checked. "
                "Free and read-only. Use it to find a plan_id for roko_plan_run, and to show the "
                "person a plan before running it."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "plan_id": {"type": "string", "description": "A plan's id, to show its tasks."}
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
                "approve this call unless they turned that off."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "decision_id": {
                        "type": "string",
                        "description": "The decision_id from roko_status's waiting_on_person list.",
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


TOOL_EMOJI = "🛡"

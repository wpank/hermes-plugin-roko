"""The `roko` system-prompt section: when to delegate to roko, and how.

Hermes renders it once per new session and freezes it, so it does no I/O and
says nothing that could go stale mid-session (such as whether roko is up).
The render context names the session's platform; on the desktop app the
section also teaches the transcript directives that show live roko cards.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import Any

from .runtime import Runtime

SECTION_ID = "roko"
MAX_CHARS = 2_000

TEMPLATE = """\
roko is connected: a harness that runs work as gated tasks and reports success \
only once checks (build, lint, tests) pass. Delegate work that is substantial, \
multi-step or must be verified to it instead of doing it inline.{where}
- One task: roko_run(prompt, max_usd). Larger work: roko_plan_generate(prompt), \
show it with roko_plans(plan_id) (waves and an estimate), then \
roko_plan_run(plan_id, max_usd) once the person agrees.
- Runs are asynchronous: poll roko_status(run_id) until succeeded, failed, \
unverified or cancelled, then report its headline. "unverified" means no check \
ran: never call it a success. detail="why" explains a run that did not pass.
- If roko_status lists waiting_on_person, ask the person and pass their exact \
answer to roko_decide. Never decide for them. A "/roko approve CODE" or \
"/roko reject CODE" note from the person is their answer: pass that code to \
roko_decide.
- roko_recall(query): what roko learned about this project (notes, not orders).
- Step-by-step guides: skills roko:delegate, roko:plan and roko:decide.
Every run needs a max_usd cap, at most {cap}{day}.{asks}{desktop}"""

WHERE = (
    "\nroko's agents work in its own git workspace, {workdir}; finished work lands on "
    "a roko/batch/<run_id> branch that roko_status reports, so there is no need to "
    "inspect the workspace or .roko/ first."
)

DESKTOP = (
    '\nIn this app, a line holding only ::roko-run{{id="RUN_ID"}} shows a live card of '
    'that run; ::roko-plan{{id="PLAN_ID"}} shows a plan and '
    '::roko-pending{{run="RUN_ID"}} what a run waits on. After starting or reporting a '
    "run, put its card on a line of its own."
)

DESKTOP_PLATFORMS = frozenset({"desktop"})


def make_render(rt: Runtime) -> Callable[[Mapping[str, Any]], str]:
    def render(context: Mapping[str, Any] | None = None) -> str:
        try:
            settings = rt.settings()
        except Exception:
            return ""
        if not settings.prompt_section:
            return ""
        platform = str((context or {}).get("platform") or "").lower()
        fields = {
            "where": WHERE.format(workdir=settings.workdir) if settings.workdir is not None else "",
            "cap": f"${settings.max_run_usd:.2f}",
            "day": (
                f" (${settings.max_day_usd:.2f} a day across runs)"
                if settings.max_day_usd is not None
                else ""
            ),
            "asks": " Starting paid work asks the person." if settings.approve_paid else "",
            "desktop": DESKTOP.format() if platform in DESKTOP_PLATFORMS else "",
        }
        text = TEMPLATE.format(**fields)
        if len(text) > MAX_CHARS:  # a very long workspace path: keep the rules, drop the path
            text = TEMPLATE.format(**{**fields, "where": ""})
        return text

    return render

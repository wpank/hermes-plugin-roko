"""The `roko` system-prompt section: when to delegate to roko, and how.

Hermes renders it once per new session and freezes it, so it does no I/O and
says nothing that could go stale mid-session (such as whether roko is up).
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import Any

from .runtime import Runtime

SECTION_ID = "roko"
MAX_CHARS = 1_200

TEMPLATE = """\
roko is connected: a harness that runs work as gated tasks and reports success \
only once checks (build, lint, tests) pass. Delegate work that is substantial, \
multi-step or must be verified to it instead of doing it inline.{where}
- One task: roko_run(prompt, max_usd). Larger work: roko_plan_generate(prompt), \
show it with roko_plans(plan_id), then roko_plan_run(plan_id, max_usd) once the \
person agrees.
- Runs are asynchronous: poll roko_status(run_id) until succeeded, failed, \
unverified or cancelled, then report the verdict and cost. "unverified" means \
no check ran: say so.
- If roko_status lists waiting_on_person, ask the person and pass their exact \
answer to roko_decide. Never decide for them.
- roko_recall(query): what roko learned about this project.
Every run needs a max_usd cap, at most {cap}.{asks}"""

WHERE = (
    "\nroko's agents work in its own git workspace, {workdir}; finished work lands on "
    "a roko/batch/<run_id> branch that roko_status reports, so there is no need to "
    "inspect the workspace or .roko/ first."
)


def make_render(rt: Runtime) -> Callable[[Mapping[str, Any]], str]:
    def render(context: Mapping[str, Any] | None = None) -> str:
        try:
            settings = rt.settings()
        except Exception:
            return ""
        if not settings.prompt_section:
            return ""
        where = WHERE.format(workdir=settings.workdir) if settings.workdir is not None else ""
        cap = f"${settings.max_run_usd:.2f}"
        asks = " Starting paid work asks the person." if settings.approve_paid else ""
        text = TEMPLATE.format(cap=cap, where=where, asks=asks)
        if len(text) > MAX_CHARS:  # a very long workspace path: keep the rules, drop the path
            text = TEMPLATE.format(cap=cap, where="", asks=asks)
        return text

    return render

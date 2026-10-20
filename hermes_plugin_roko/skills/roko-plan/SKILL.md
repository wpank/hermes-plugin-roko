---
name: roko-plan
description: "Turn larger work into a roko plan, review its waves and estimate with the person, then run it."
version: 0.7.2
author: hermes-plugin-roko
license: MIT OR Apache-2.0
metadata:
  hermes:
    tags: [roko, planning, delegation, verification]
---

# Plan and run multi-step work with roko

roko's planner turns a request into a plan: a graph of small tasks, each with its own checks, that
roko runs in dependency order and in parallel where it can. Nothing runs until the person agrees.

## Steps

1. When the work is written down in a file in the project (a spec, a PRD), pass that file's path as
   `spec_path`: roko reads the file exactly. Never copy or summarize it into `prompt`; `prompt` then
   holds only what the person adds. Otherwise write the request completely: the goal, the
   constraints, what done looks like, and what must not change. The planner sees only this text.
2. Call `roko_plan_generate(prompt)`, or `roko_plan_generate(spec_path)` for a spec. A title the
   person gives the plan goes in `title`, never in the request. Hermes asks the person to approve the
   planner's spend unless its approvals are off.
3. Follow it with `roko_status(run_id)` until it `succeeded`. If it ends otherwise, report
   `planner_error` and stop.
4. Show the plan: `roko_plans(plan_id)`. Summarise it for the person:
   - the tasks wave by wave (`waves`: tasks in one wave can run together);
   - how each task is checked (`checks`);
   - the estimate (`estimate.total_cost_usd`, `confidence`: "low" means few past runs to go on).
   On the desktop app, put `::roko-plan{id="PLAN_ID"}` on a line of its own.
5. Ask the person whether to run it, and with what cap. Suggest a cap of about twice the estimate.
6. On a yes, call `roko_plan_run(plan_id, max_usd)` once. Their yes is the consent: with Hermes'
   approvals off, nothing else asks. If another plan is running the run is queued: say so and give
   its position.
7. Follow and report the run as in `skill_view("roko:delegate")`: poll `roko_status`, handle
   `waiting_on_person` with `skill_view("roko:decide")`, report the headline, and for a run that did not pass,
   use `detail="why"`. `detail="tasks"` lists each task's model, attempts and gates. A demo plan's
   output stays on its run branch: never offer to merge it. While the run goes, the work is roko's:
   do not edit the project's files or run its checks in roko's place, and cancel it only if the
   person asks.

## Resuming

If a plan's last run ended part-way (failed, cancelled or interrupted), `roko_plan_run` needs to know
what to do with it. `roko_plans(plan_id)` names that run (`resumable_run`), and a call that says
neither is refused with roko's words, before anything is approved or spent.

- When the person asks to resume or continue the plan, call `roko_plan_run(plan_id, max_usd,
  resume=true)`: the tasks that already passed are kept, and only the ones left run.
- Only when they ask to start over, call it with `fresh=true`: the last run's progress is set aside
  (`roko resume RUN_ID` brings it back), and every task runs again.
- If they did not say, ask them which, in one sentence with the run's short id and the tasks left
  ("continue 6988f0b8, so only T3 runs, or start over?"). Never pick for them.

After a stop at its cap, the resumed run's cap also counts what the plan already spent, so it needs a
higher one, and the person chooses it.

## When roko says no, or a run fails

The rules in `skill_view("roko:delegate")` apply to every plan run: report roko's refusals, failures and leftovers
to the person and stop. Never repair roko's state (worktrees, branches, `.roko/`, roko serve), not even
when the person asks; for a leftover checkout, run only the exact command roko's message gives, and
only when the person asks for it in this turn. Never edit `roko.toml` (point to the plugin's fix
instead), and never start, re-run or resume paid work the person did not ask for in this turn. Do not
save ways around roko's errors as skills or memories.

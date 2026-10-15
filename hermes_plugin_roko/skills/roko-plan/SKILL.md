---
name: roko-plan
description: "Turn larger work into a roko plan, review its waves and estimate with the person, then run it."
version: 0.4.0
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

1. Write the request completely: the goal, the constraints, what done looks like, and what must not
   change. The planner sees only this text.
2. Call `roko_plan_generate(prompt)`. Hermes asks the person to approve the planner's spend.
3. Follow it with `roko_status(run_id)` until it `succeeded`. If it ends otherwise, report
   `planner_error` and stop.
4. Show the plan: `roko_plans(plan_id)`. Summarise it for the person:
   - the tasks wave by wave (`waves`: tasks in one wave can run together);
   - how each task is checked (`checks`);
   - the estimate (`estimate.total_cost_usd`, `confidence`: "low" means few past runs to go on).
   On the desktop app, put `::roko-plan{id="PLAN_ID"}` on a line of its own.
5. Ask the person whether to run it, and with what cap. Suggest a cap of about twice the estimate.
6. On a yes, call `roko_plan_run(plan_id, max_usd)`. If another plan is running the run is queued:
   say so and give its position.
7. Follow and report the run as in the `roko-delegate` skill: poll `roko_status`, handle
   `waiting_on_person` with `roko-decide`, report the headline, and for a run that did not pass,
   use `detail="why"`. `detail="tasks"` lists each task's model, attempts and gates.

## Resuming

If a plan run ended part-way (failed or cancelled), `roko_plan_run(plan_id, max_usd, resume=true)`
keeps the tasks that already passed and runs the rest. Ask the person first.

---
name: roko-plan
description: "Turn larger work into a roko plan, review its waves and estimate with the person, then run it."
version: 0.8.1
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

1. Describe the work to build, as the person would tell an engineer: the goal, the constraints, what
   done looks like, and what must not change. Never ask roko for "a plan", a roadmap or planning
   documents: roko's planner plans the work it is given, so "Create a plan for X" gets tasks that
   write about X instead of building it. Leave out how to plan, "only write the plan" and what to
   spend: they are not the work, and the planner turns them into tasks. When the work is written
   down in a file in the project (a spec, a PRD), pass that file's path as `spec_path`: roko reads
   the file exactly, so there is no need to open it first. Never copy or summarize it into `prompt`;
   `prompt` then holds only what the person adds. The planner sees only this text.
2. Call `roko_plan_generate(prompt)`, or `roko_plan_generate(spec_path)` for a spec. A title the
   person gives the plan goes in `title`, never in the request. A cap the person names for writing the
   plan goes in `max_usd`: without it roko's own limit for plan writing applies ($2.00 by default), and a
   call without it is refused when their message names one. Hermes asks the person to approve the
   planner's spend unless its approvals are off. Call roko's tools yourself, here in the person's
   chat, never through `delegate_task`: a subagent shows no card and can't wait for the plan, and
   roko refuses to start work from one. Its answer comes at once, while roko still writes the plan:
   the plan is not written until `roko_status` says `succeeded`, so never call it created before then.
3. On the desktop app, put `::roko-plan{id="PLAN_ID"}` (the `plan_id` it answers) on a line of its
   own now: the card follows the writing, then shows the plan, so introduce it in words that stay true
   once the plan is written (what roko plans, and the writing's cap), not that the writing started.
   Follow it with `roko_status(run_id)` until it `succeeded`. If it ends otherwise, report
   `planner_error` and stop.
4. Show the plan: `roko_plans(plan_id)`. Summarise it for the person:
   - the tasks wave by wave (`waves`: tasks in one wave can run together);
   - how each task is checked, by count: "T1 runs 5 checks, T2 runs 3" (`check_count`; `checks` lists
     only the first four, and `checks_more` says how many it leaves out), and for a plan from a spec,
     roko's count of the spec's checks it keeps (`source_checks` in the writing's `roko_status`: "9
     checks, all kept"). Never retype the check commands: a retyped list drops some, and the plan card
     shows each one;
   - the estimate (`estimate.total_cost_usd`, `confidence`: "low" means few past runs to go on).
   On the desktop app, put `::roko-plan{id="PLAN_ID"}` on a line of its own.
5. Ask the person whether to run it, and with what cap. Suggest a cap of about twice the estimate. A
   cap the person gave for writing the plan covered writing the plan only: never offer it as the
   run's.
6. On a yes, call `roko_plan_run(plan_id, max_usd)` once. Their yes is the consent: with Hermes'
   approvals off, nothing else asks. If another plan is running the run is queued: say so and give
   its position.
7. Hand the run back at once, as in `skill_view("roko:delegate")`: reply with its card line
   (`::roko-run{id="RUN_ID"}` on a line of its own), one sentence on what runs and its cap, and end your
   turn. A plan run takes minutes to hours: don't wait for it in this turn. This chat hears when it
   ends (its next turn leads with the outcome), and `roko_status(run_id)` reports it when the person
   asks: handle `waiting_on_person` with `skill_view("roko:decide")`, report the headline, and for a run
   that did not pass, use `detail="why"`. `detail="tasks"` lists each task's model, attempts and gates.
   A demo plan's output stays on its run branch: never offer to merge it. While the run goes, the work
   is roko's: do not edit the project's files or run its checks in roko's place, and cancel it only if
   the person asks.

## Resuming

If a plan's last run ended part-way (failed, cancelled or interrupted), `roko_plan_run` needs to know
what to do with it. `roko_plans(plan_id)` names that run (`resumable_run`), and a call that says
neither is refused with roko's words, before anything is approved or spent.

- When the person asks to resume or continue the plan, call `roko_plan_run(plan_id, max_usd,
  resume=true)`: the tasks that already passed are kept, and only the ones left run.
- Only when they say "start over" or "from scratch" in this turn, after you told them what that sets
  aside (the tasks that passed, the run's checkpoint and what it spent), call it with `fresh=true` and
  `set_aside=true`: the last run's progress is set aside (`roko resume RUN_ID` brings it back), and every
  task is paid for anew. A request to run the plan again is not that: offer the resume.
- If they did not say, ask them which, in one sentence with the run's short id and the tasks left,
  resume first ("continue 6988f0b8, so only T3 runs, or start over?"). Never pick for them.

After a stop at its cap, the resumed run's cap also counts what the plan already spent, so it needs a
higher one, and the person chooses it.

## When roko says no, or a run fails

The rules in `skill_view("roko:delegate")` apply to every plan run: report roko's refusals, failures and leftovers
to the person and stop. Never repair roko's state (worktrees, branches, `.roko/`, roko serve), not even
when the person asks; for a leftover checkout, run only the exact command roko's message gives, and
only when the person asks for it in this turn. Never edit `roko.toml` (point to the plugin's fix
instead), and never start, re-run or resume paid work the person did not ask for in this turn. Do not
save ways around roko's errors as skills or memories.

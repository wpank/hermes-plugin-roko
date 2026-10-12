---
name: roko-delegate
description: "Hand one well-defined change to roko as a gated, capped run and report the verified result."
version: 0.2.0
author: hermes-plugin-roko
license: MIT OR Apache-2.0
metadata:
  hermes:
    tags: [roko, delegation, verification, coding]
---

# Delegate one task to roko

roko runs work as gated tasks: its agent does the work in roko's own git workspace, and the
workspace's checks (build, lint, tests) must pass before roko calls it done. Use this for a single,
well-defined change, fix, report or research task. For anything with several steps, use the
`roko-plan` skill instead.

## When to use

- The work is self-contained and you can say how to check it ("add X with a test", "fix the
  failing test in Y").
- The result must be verified, not just written.
- It would take more than a few edits inline, or should not touch this conversation's files.

## When not to use

- A one-line answer or an explanation: answer directly.
- Work that needs several dependent steps: write a plan (`roko-plan`).
- The person asked you to make the change yourself, here.

## Steps

1. Write the prompt for roko's agent. It sees only this text, not the conversation: name the files,
   the expected outcome and how to check it. Say what must not change.
2. Pick a cap: what the work is worth, usually 0.50–1.00 USD for a small change. It must be at most
   the plugin's `max_run_usd`.
3. Call `roko_run(prompt, max_usd)`. Hermes asks the person to approve the spend; if they decline,
   stop and say so. If the call says the daily limit would be passed, tell the person and offer a
   smaller cap.
4. Follow the run: `roko_status(run_id, wait_secs=120)` until the state is `succeeded`, `failed`,
   `unverified` or `cancelled`. Each answer has a one-line `headline`.
5. If `waiting_on_person` appears, follow the `roko-decide` skill before anything else.
6. Report:
   - `succeeded`: what changed (`delivered.files_changed`), the cost, and where the work is: a
     `roko/batch/<run_id>` branch, not merged. Give the `review_command` and `merge_command`.
   - `unverified`: no check ran, so the result is not verified. Never call it a success.
   - `failed`: call `roko_status(run_id, detail="why")` and explain the gate output in plain words.
     Offer a narrower retry; do not retry on your own.
   - `cancelled`: say so.

## Pitfalls

- Do not inspect roko's workspace or `.roko/` yourself; `roko_status` reports everything.
- Do not merge the branch for the person unless they ask.
- On the desktop app, put `::roko-run{id="RUN_ID"}` on a line of its own to show a live card.

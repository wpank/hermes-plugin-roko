---
name: roko-delegate
description: "Hand one well-defined change to roko as a gated, capped run and report the verified result."
version: 0.6.0
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
`skill_view("roko:plan")` skill instead.

## When to use

- The work is self-contained and you can say how to check it ("add X with a test", "fix the
  failing test in Y").
- The result must be verified, not just written.
- It would take more than a few edits inline, or should not touch this conversation's files.

## When not to use

- A one-line answer or an explanation: answer directly.
- Work that needs several dependent steps: write a plan (`skill_view("roko:plan")`).
- The person asked you to make the change yourself, here.

## Steps

1. Write the prompt for roko's agent. It sees only this text, not the conversation: name the files,
   the expected outcome and how to check it. Say what must not change.
2. Pick a cap: what the work is worth, usually 0.50–1.00 USD for a small change. It must be at most
   the plugin's `max_run_usd`.
3. Leave `domain` out. It then means `code`, and the project's own checks (build, lint, tests) verify
   the change, even for a README, a CONTRIBUTING.md or another text file in the project. Pass `docs`
   or `research` only when the person asks for prose that no project check applies to, and tell them
   that roko runs no project checks on that work unless roko.toml has a `[gates.packs.docs]` (or
   `research`) pack, so the run will end `unverified`.
4. Call `roko_run(prompt, max_usd)` once, for the run the person asked for. Hermes asks them to
   approve the spend unless its approvals are off; then nothing asks, and their request is the only
   consent. If they decline, stop and say so. If the call says the daily limit would be passed, tell
   the person and offer a smaller cap.
5. Follow the run: `roko_status(run_id, wait_secs=120)` until the state is `succeeded`, `failed`,
   `unverified` or `cancelled`. Each answer has a one-line `headline`. While the run goes, the work is
   roko's: do not edit the project's files or run its checks in roko's place, and cancel it only if
   the person asks. A quiet status is not a reason to step in: roko may be thinking, or retrying on a
   stronger model. Keep waiting and report what roko says; if it looks stuck, tell the person what
   the status shows (model, try, spend, last activity) and ask them.
6. If `waiting_on_person` appears, follow `skill_view("roko:decide")` before anything else.
7. Report:
   - `succeeded`: what changed (`delivered.files_changed`), the cost, and where the work is: a
     `roko/batch/<run_id>` branch, not merged. Give the `review_command` and `merge_command`.
     For one of roko's demo plans (the answer says `demo`), its output stays on its run branch:
     show what it did, and never offer to merge it.
   - `unverified`: no check ran, so the result is not verified. Never call it a success. Say where
     its changes are kept (`work`, with a `review_command`); merging them is the person's choice.
   - `failed` with `budget_stop`: roko stopped the run at its cap, a stop rather than a failed check
     (unless the answer names a check that did not pass). Say how far it got, what the cap stopped and
     what passed, which roko keeps on its branch. The cap is the person's limit: offer a run with a
     higher one, with a figure in words they can say back (the answer's `next` gives one, such as
     "continue with $0.25"), and start it only when they ask, with the cap they choose.
   - `failed`: call `roko_status(run_id, detail="why")` and explain the gate output in plain words.
     Offer a narrower retry, and start it only if the person says yes.
   - `interrupted`: roko stopped while the run went (a restart or a crash) and kept what had passed.
     Say so; running it again is the person's call.
   - `cancelled`: say so.

## When roko says no, or a run fails

roko's refusals, failures and leftovers are the person's to see and decide on. Report them; never
repair them.

- **Report, then stop.** Say what roko answered in a sentence or two, with the fix the answer gives
  the person (for example the **make ready** key on the roko page, or a command for their terminal).
- **Never repair roko's state, not even when the person asks.** Never run git surgery on roko's
  worktrees or branches (no `git worktree remove`, no `git branch -D`), never `rm` anything under
  `.roko/`, and never start, stop or restart roko serve, even when an error names them. roko owns that
  state.
- **The one exception: the command roko gives.** When roko's message gives a command for its
  leftover checkout (it moves the checkout aside and keeps its commits) and the person explicitly asks
  in this turn for it to be dealt with, run that exact command, and nothing else. If roko's message
  gives no command, tell the person what roko said and stop.
- **Never edit `roko.toml` or `~/.roko/`**, not even to lift a refusal or to turn roko's learning on,
  and not when the person asks you to: point them to the plugin's fix (`hermes roko fix`,
  `hermes roko init`), which shows them the change before it writes it, and do not run it for them.
- **Never start or re-run paid work the person did not ask for in this turn.** A refused or failed
  run is not a reason to try again, with the same cap or another. Run it again only when they say so.
- **Never do the work yourself in roko's place.** The person asked roko for it. When a run fails, stops
  at its cap or is refused, report it and offer the next steps (a higher cap, a narrower run, or doing
  it yourself); edit the project's files or run its checks yourself only when they ask you to.
- These rules are complete. Do not save steps for working around roko's errors as skills or memories.

## Pitfalls

- Do not inspect roko's workspace or `.roko/` yourself; `roko_status` reports everything.
- Do not merge the branch for the person unless they ask, and never offer to merge a demo's output.
- Say what roko reported, not how you expect it to behave: a task whose check already passes may end
  `already_satisfied`, and the run then succeeds.
- On the desktop app, put `::roko-run{id="RUN_ID"}` on a line of its own to show a live card: as soon as
  the run starts, before you call roko_status, so the person can watch it while you wait.

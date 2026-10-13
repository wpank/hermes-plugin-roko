# Changelog

## 0.2.0 — unreleased

roko becomes visible in every Hermes interface.

- **Desktop app** (`desktop/plugin.js`): a roko page (Runs, Waiting, Plans, Knowledge, Health), a
  status-bar chip, palette entries, notifications, a `hermes://open/roko?run=<id>` deep link, and live
  chat cards the model places with `::roko-run{id}`, `::roko-plan{id}` and `::roko-pending{run}`.
- **Web dashboard** (`dashboard/`): a roko tab, a header chip and a Sessions-page banner.
- **Backend for both** (`dashboard/plugin_api.py`, `hermes_plugin_roko/ui_api.py`): the
  `/api/plugins/roko/*` routes in docs/ui-api.md, mounted by Hermes' web server. roko's key stays in
  Hermes' backend. Every route answers 200 with `ok`, so a page can tell "roko said no" from "the route
  is missing".
- **Run cards** (`rundata.py`): cost and tokens summed from roko's efficiency events (roko's summary
  says $0 for plan runs), tasks with model, attempts and gates, start and end from the run's manifest,
  a readable timeline, a one-line headline, and the delivered branch with review and merge commands.
  Event indexes are read incrementally, and a finished run's only once.
- **Spend**: a daily limit, `max_day_usd` (default $20), across the runs Hermes starts, counting what
  running runs may still spend. Over-limit starts are refused before anyone is asked.
- **Tools**: `roko_status` gains a headline, `detail: "tasks" | "why"`, `run_id: "last"`, today's spend
  in the overview, and returns as soon as something waits on the person (with a 6-character code per
  item); `roko_plans` shows waves and roko's estimate; `roko_decide` accepts a code; approval prompts are
  one clean line and show the estimate and today's spend; errors carry `"success": false`; long waits
  tell Hermes they are still working; one emoji per tool.
- **`/roko`**: run cards for `status RUN [why]`, plans wave by wave, and new `runs`, `cost`, `gates`,
  `learn`, `effects` and `knowledge`; replies fit one message (1,900 characters).
- **`hermes roko watch [RUN]`** redraws a run's card until it ends; `hermes roko status RUN`.
- **Skills** `roko:delegate`, `roko:plan`, `roko:decide`; an **`@roko:` context reference**; roko API
  keys **redacted** in Hermes' logs and transcripts.
- **Prompt**: teaches the desktop cards in the desktop app only, the `/roko approve CODE` note, and
  that unverified is not success.
- **Safety**: all text from roko is cleaned of escape sequences, control characters and bidirectional
  overrides before it reaches a terminal, an approval prompt, a chat or a page; `ui_actions: false`
  makes the UIs read-only.
- **Doctor**: reports which UI halves are installed and what to do to see them.
- **Where the work is**: a finished run's card takes roko serve's own answer, the summary's `result`
  (roko gap-8409d0): the batch branch, its commit and base, the changed files, whether the checkout has
  the work, and roko's merge command, or the branch it was promoted into. It works for a remote roko
  serve too, and still names the files after the merge. Against an older roko serve the plugin reads the
  branch with git as before, which needs the workspace on this machine.
- **Fixes**:
  - A paid start that timed out now finds the run roko started anyway, instead of pointing at an
    overview that could not list it.
  - The run log takes a lock file around each change, so a chat and a UI backend writing at once
    cannot drop each other's runs.
  - The run log is written only when something changed.
  - Bare `hermes roko` prints its usage and exits 0.
  - Internal errors reach the model and chat cleaned.

## 0.1.0 — unreleased

First version.

- Eight tools for Hermes' model over roko serve's `/mcp` contract and two REST reads: `roko_run`,
  `roko_plan_generate`, `roko_plan_run`, `roko_status`, `roko_cancel`, `roko_plans`, `roko_recall`,
  `roko_decide`. Paid tools and decisions ask the person through Hermes' approval gate; every run names
  a `max_usd` cap, checked here before roko sees it.
- `roko_status` follows a run in short server-side waits (so an interrupt is noticed), lists what the
  run waits on the person for, reports the `roko/batch/<run_id>` branch its verified work is on when the
  workspace is local, and recovers a finished plan generation that roko has already forgotten.
- `/roko` slash command: `status`, `plans`, `pending`, `approve`, `reject`, `cancel`, `recall`, `doctor`.
- `hermes roko setup | doctor | status`: setup finds roko serve, mints a write-scoped key with its
  launch token (`--mint`), stores it in Hermes' `.env`, and runs the doctor. The doctor checks reach,
  auth, key scope, the `/mcp` tool set, and whether roko accepts chat-started runs, using a probe that
  starts nothing.
- A `roko` system-prompt section teaching the delegation protocol.
- No hooks.
- Built for Hermes' tool guardrails:
  - Status results carry `checked_at`, so polling a long run is never a byte-identical repeat. Hermes
    halts a gateway turn on the fifth identical call.
  - Results avoid bare `"failed"` and `"error"` tokens. The one exception is the status of a run that
    did fail. Polls of a healthy run therefore never count as failed calls.
- Safety details:
  - Approval rule keys carry the cap.
  - `roko_decide` binds the item and the verdict, and refuses items roko no longer waits on.
  - `/roko` names items by stable codes.
  - Slow answers and paid starts report that the work may already have happened.
  - The loopback check accepts only `localhost` or loopback IP literals, and loopback requests skip
    proxies.

# Changelog

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

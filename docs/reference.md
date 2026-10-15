# Reference

Everything the plugin adds to Hermes, and the settings on both sides. For a walkthrough, start with
[Getting started](getting-started.md).

## In chat: what Hermes can do with roko

You ask in plain words; Hermes calls these tools. Paid ones ask you first.

| Tool | What it does | Asks you first |
|---|---|---|
| `roko_run` | One piece of work as a single checked task | yes (it spends money) |
| `roko_plan_generate` | roko's planner writes a plan: small tasks, each with its own checks | yes |
| `roko_plan_run` | Runs a plan, or queues it behind the run in progress | yes |
| `roko_status` | A run's state, cost, checks and branch; waits for the run to change | no |
| `roko_cancel` | Stops a run | no |
| `roko_plans` | Lists plans, or shows one plan's tasks, waves and cost estimate | no |
| `roko_recall` | Searches what roko learned about the project | no |
| `roko_decide` | Records your answer to something a run waits on | yes, always |

Every run needs a spending cap. Say it in your request: "Cap it at $1", "max $0.50". Hermes may also give a run a
short `title` (under 60 characters) that names it in your lists.

## `/roko` commands

Type these in any Hermes chat: the terminal, the desktop app, Telegram, Discord. They answer right away,
without the model.

| Command | What it does | Example |
|---|---|---|
| `/roko status` | roko's health, today's spend, recent runs | `/roko status` |
| `/roko status RUN [why]` | One run's card; `why` adds the output of the checks that failed | `/roko status last why` |
| `/roko runs` | The runs Hermes started, with state and cost | `/roko runs` |
| `/roko plans [PLAN]` | The plans, or one plan wave by wave | `/roko plans add-csv-export` |
| `/roko pending` | What runs wait on you for, each with a code | `/roko pending` |
| `/roko approve CODE [NOTE]` | Approve that item | `/roko approve k3x9q2` |
| `/roko reject CODE [NOTE]` | Reject it; the note goes back to the run | `/roko reject k3x9q2 keep it short` |
| `/roko cancel RUN` | Stop a run | `/roko cancel last` |
| `/roko cost` | Today's spend against the daily limit, run by run | `/roko cost` |
| `/roko gates` | How often each check passes in this workspace | `/roko gates` |
| `/roko learn` | The models roko used, their success rate and cost | `/roko learn` |
| `/roko effects` | Outbound actions roko held for approval, and how each was decided | `/roko effects` |
| `/roko knowledge QUERY` | Search what roko learned (also `/roko recall`) | `/roko knowledge test setup` |
| `/roko doctor` | Check the connection | `/roko doctor` |

`RUN` is a run id (the first 8 characters are enough) or `last`. Codes are 6 characters and stay the same
everywhere, so you can read a code in the desktop app and answer it from Telegram.

## The roko page (desktop app and web dashboard)

| Tab | What it has |
|---|---|
| **Runs** | The runs Hermes started (Live, Today, Earlier), and for the one you pick: the display bar (`01 TASKS` … `06 PULSE`), the ticker, the sequencer, a task panel with routes, and the run's tabs Overview, Activity, Loops and Changes; Replay, Merge, Cancel |
| **Waiting** | Sign-offs and held actions, with roko's deadline, Approve and Reject |
| **Plans** | Each plan as a sequencer, its tasks, checks and estimate, and Run plan |
| **Loops** | roko's five loops on a dial, each ring's latest events, and roko's state for each |
| **Insights** | Check pass rates, models and their cost, spend over time, connection checks |
| **Knowledge** | Search what roko learned |

**new run** (the key in the page header, `n`, ⌘⌥R in the desktop app, "roko: New run…" in the palette, or the
`→ roko` key in a desktop chat's composer) starts a run or a plan from the page. Keys: `j`/`k` move through runs,
`[`/`]` switch a run's tabs, `Esc` closes a panel, `r` checks again (desktop), `1`–`6` switch sections and `?` lists
the keys (dashboard). The page header says **LIVE** while the live stream is open and **POLLING** when it is not.
The routes and the live stream behind the pages are in [UI API](ui-api.md).

The desktop app also has:

| Where | What |
|---|---|
| Right sidebar | The **roko** monitor pane: the newest run's display, ticker, a small sequencer and the dial ("roko: Monitor pane") |
| An empty chat | **delegate to roko**, with example requests that fill the composer |
| The chat composer | The `→ roko` key: opens new run with the chat's draft |
| Settings ▸ Appearance | The **`roko`** theme, light and dark |
| Settings ▸ Plugins ▸ roko | The connection and live stream, limits, sounds, the theme, the doctor's checks |
| The sidebar's chat list | A light on a chat whose run is going (blue) or waits on you (orange) |
| The status bar | A chip with the newest run's tasks as a strip, and how many runs are running or wait on you |
| Notifications | A toast when a run starts from a chat, ends or needs you; Hermes' pet says the same; opt-in sounds |
| The palette | roko: Open, New run…, What's waiting on me, Loops, Monitor pane, Health check |

The web dashboard also puts roko on its other pages: a chip in the sidebar, a strip above the chat and on the
Sessions page while a run is going, a card on Analytics (spend today, checks, models, the loops' lights) and a
scorecard on Models.

## `@roko:` in a message

`@roko:last`, or `@roko:<run id>`, puts that run's card into your message, for example: "Explain why
@roko:last failed". Typing `@roko:` offers the runs Hermes started.

## `hermes roko` in a terminal

| Command | What it does |
|---|---|
| `hermes roko setup --workdir DIR --mint` | Find roko serve for the workspace `DIR`, create a key for Hermes, save it, and check everything |
| `hermes roko setup --url URL --key-stdin < keyfile` | Use a key you already have, for a roko serve at `URL` |
| `hermes roko doctor` | Check every link to roko and say what to fix |
| `hermes roko status [RUN]` | roko's health and the runs Hermes started, or one run's card |
| `hermes roko watch [RUN]` | Follow a run live, full screen: its state, clock, spend, the plan wave by wave, what waits on you and the latest events. `q` stops watching (the run goes on), `r` checks at once; when the run ends, the last frame stays with the verdict and the merge command |

Options:

- `setup`: `--key-name NAME` (default `hermes`), `--yes` (replace an existing key of that name), `--dry-run`
  (check, change nothing).
- `doctor`: `--json`, `--offline` (local checks only), `--strict` (exit 3 on a warning), `--no-probe` (skip
  the free check that roko accepts runs). Exit codes: 0 all good, 1 a check failed, 3 a warning with
  `--strict`, 4 roko serve unreachable.
- `status`: `--json`.
- `watch`: `--interval SECONDS` (default 3), `--once`.

## Plugin settings

They live under `plugins.entries.roko.settings` in `~/.hermes/config.yaml`. Change one with
`hermes config set`; it applies right away, no restart:

```bash
hermes config set plugins.entries.roko.settings.max_day_usd 10
```

| Setting | Default | What it does |
|---|---|---|
| `url` | `http://127.0.0.1:6677` | roko serve's address |
| `workdir` | not set | The roko workspace; setup fills it in |
| `api_key_env` | `ROKO_API_KEY` | The environment variable that holds the key |
| `max_run_usd` | `5.0` | The largest cap one run may name |
| `max_day_usd` | `20.0` | The most runs started from Hermes may spend in a day; `0` turns the limit off |
| `approve_paid` | `true` | Ask before starting paid work |
| `confirm_decisions` | `true` | Ask before Hermes answers something for you |
| `prompt_section` | `true` | Teach the model how to use roko, in its system prompt |
| `ui_actions` | `true` | Let the desktop app and dashboard start plans, answer and cancel; `false` makes them read-only |
| `timeout_s` | `20` | Seconds to wait for one answer from roko serve |
| `allow_insecure_remote` | `false` | Allow sending the key over plain `http` to another machine |

Environment variables: `ROKO_URL` (or `ROKO_SERVE_URL`) overrides `url`; `ROKO_API_KEY` holds the key. Setup
writes the key to `~/.hermes/.env`.

## roko-side settings

These live in the project's `roko.toml`, plus API keys in `~/.roko/.env`. Restart `roko serve` after
changing them.

| Setting | Default | What it does |
|---|---|---|
| `[serve.mcp] allow_without_data_llm` | `false` | `true` accepts chat requests as they are |
| `[agent.data_llm]` | not set | A small model that screens what a chat-started run reads; set it instead of `allow_without_data_llm` when other people can reach Hermes |
| `[serve.mcp] max_run_usd` | `5.0` | roko's own limit on one chat-started run's cap |
| `[serve.auth] enabled` | `true` | Require a key for roko's API |
| `[server] port` | `6677` | The port `roko serve` listens on (`roko serve --port` overrides it) |
| `[[routing.ladder.rungs]]` | Claude and other models | The models roko tries, cheapest first |
| `[serve] live_agent_output` | `"tool_steps"` | `"trusted"` also streams the agent's words, reasoning and tool results as they happen, before roko's output screening; roko honours it only on a loopback bind |

To screen chat requests with a small model:

```toml
[agent.data_llm]
model = "claude-haiku-4-5"
```

A run started from a chat needs a model roko calls through an API. A CLI agent (Claude Code, Codex, Gemini
CLI, Cursor) runs its own tools, so roko cannot hold that agent's outbound actions for your approval.
`roko config models list` shows each model's provider and whether its key is set.

## Where things are

| What | Where |
|---|---|
| The key Hermes uses | `~/.hermes/.env`, as `ROKO_API_KEY` |
| The plugin's settings | `~/.hermes/config.yaml`, under `plugins.entries.roko.settings` |
| roko serve's address and launch token | `<project>/.roko/runtime/serve.json` and `serve.token` |
| A run's work | branch `roko/batch/<run id>` in the project |
| roko's API keys for models | `~/.roko/.env` |
| The sound switch | the page's own storage (desktop: per app; dashboard: per browser) |

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
| `roko_plans` | Lists plans, or shows one plan's tasks, steps and cost estimate | no |
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
| `/roko plans [PLAN]` | The plans, or one plan step by step | `/roko plans add-csv-export` |
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
| **Runs** | What needs you first (sign-offs and held actions, with roko's deadline, **decline** and **approve**), then each running run as a card, then a line for each run that ended. A run opens its own page: its head (state, title, four readings: tasks, time, spent against its cap, checks; one sentence; one key: **stop**, **review** or **run again**), the plan beside its models, what it made and learned, and folds for what the agents are doing, every step, where the time went, the changes with merge, the receipt and its details. Click a pad for a task's panel: its tries, the model each used, its route, cost, prompt and check output |
| **Plans** | A build's phases, when the project's specs name phases; every plan as a line, and each plan's own page with its document, tasks, checks, roko's estimate and **run plan** |
| **Learning** | What a passed task costs, first tries and moves to a stronger model, against your first runs; which models passed the work; the lessons that paid off; and, folded, roko's five loops, how it keeps itself steady, every lesson (with a search) and the checks' figures |

**new run** (the key in the page header, `n`, ⌘⌥R in the desktop app, "roko: New run…" in the palette, or the
`→ roko` key in a desktop chat's composer) starts a run or a plan from the page. Keys: `1`–`3` switch tabs, `w`
shows what waits on you (desktop), `j`/`k` move through runs, `[`/`]` move through a run's parts (desktop), `Esc`
closes a panel, `r` checks again, and `?` lists the keys (dashboard). The light after roko's wordmark is lit while
the live stream is open; hover it for why when it is not. The routes and the live stream behind the pages are in
[UI API](ui-api.md).

The desktop app also has:

| Where | What |
|---|---|
| Right sidebar | The **roko** side pane: the newest run's card ("roko: Monitor pane") |
| An empty chat that already has a session | **delegate to roko**, with example requests that fill the composer (a new chat shows Hermes' own start screen; use the `→ roko` key there) |
| The chat composer | The `→ roko` key: opens new run with the chat's draft |
| Settings ▸ Appearance | The **`roko`** theme, light and dark |
| Settings ▸ Plugins ▸ roko | The connection and live stream, limits, sounds, the theme, the doctor's checks |
| The sidebar's chat list | A light on a chat whose run is going (blue) or waits on you (orange) |
| The status bar | A chip with roko's most urgent state: what waits on you, the running run's time, or a problem with roko |
| Notifications | A toast when a run starts from a chat, ends or needs you; Hermes' pet says the same; opt-in sounds |
| The palette | roko: Open, New run…, What's waiting on me, Loops, Monitor pane, Health check |

The web dashboard also puts roko on its other pages: a chip in the header with roko's most urgent state, and one line
above the chat and on the Sessions page while a run goes or something waits on you.

## `@roko:` in a message

`@roko:last`, or `@roko:<run id>`, puts that run's card into your message, for example: "Explain why
@roko:last failed". Typing `@roko:` offers the runs Hermes started.

## `hermes roko` in a terminal

| Command | What it does |
|---|---|
| `hermes roko init [--workdir DIR]` | Make a project ready in one command: a key for roko, `roko init`, roko serve, the connection to Hermes, the settings runs from Hermes need, and the hello-world demo. It asks before each change, changes only what is missing, and makes the project Hermes' default project |
| `hermes roko serve [status\|start\|stop\|restart]` | A project's roko serve: `status` (the default) says where it stands; `start` starts it in the background the way Hermes does (`roko serve --detach`); `stop` and `restart` go through roko's own `roko serve stop` and `restart`. `--project P` (a folder, or a known project's name; default: the default project), `--all` (every known project), `--force` (stop or restart a serve with runs going: they stop, their work so far kept), `--json` |
| `hermes roko projects [list\|add P\|remove P\|default P]` | The projects Hermes uses roko in: list them (`*` marks the default), add a git checkout, forget one (its roko serve keeps running until it stops by itself), or make one the default. `--json` |
| `hermes roko setup --workdir DIR` | Make the project `DIR` Hermes' default project, check everything (Hermes uses the project's launch token), and offer each fix the plugin can make itself; `--mint` creates a key for Hermes instead, with the launch token |
| `hermes roko setup --url URL --key-stdin < keyfile` | Use a key you already have, for a roko serve on another machine at `URL` (a URL on this machine is never saved: setup finds its project) |
| `hermes roko doctor` | Check every link to roko and say what to fix |
| `hermes roko fix` | List what stands between Hermes and roko, each with its fix (the roko page's setup card, as text) |
| `hermes roko fix workspace-chat-ready` | Make the workspace's `roko.toml` accept runs started from Hermes: shows the change, then asks |
| `hermes roko status [RUN]` | roko's health and the runs Hermes started, or one run's card |
| `hermes roko watch [RUN]` | Follow a run live, full screen: its state, clock, spend, the plan step by step, what waits on you and the latest events. `q` stops watching (the run goes on), `r` checks at once; when the run ends, the last frame stays with the verdict and the merge command |

Options:

- `init`: `--workdir DIR` (default: the current folder), `--yes` (answer yes to every question), `--dry-run` (look
  only), `--port N` (for a roko serve it starts; default: roko.toml's `[server] port` when it is free, else one the
  OS picks), `--no-serve` (don't start roko serve; print the command), `--launchd` (write a macOS login item that
  starts roko serve, and print the `launchctl` command that loads it). The `roko_bin` setting or `ROKO_BIN` names
  the roko command when Hermes should not look for it ([Install roko](getting-started.md#install-roko)). Exit
  codes: 0 nothing stops runs from Hermes, 3 something is left for you (the summary says what).
- `serve`: exit codes 0 (`status`/`start`/`restart`: it runs; `stop`: it stopped), 1 it failed, 2 bad usage (a
  remote `url`, or no such project), 3 something for you to do (no roko, roko too old, a serve with runs going
  without `--force`).
- `setup`: `--key-name NAME` (default `hermes`), `--yes` (replace an existing key of that name, and make the
  fixes it offers without asking), `--dry-run` (check, change nothing).
- `fix`: `--variant local` (the default: runs started from Hermes run without the data-model boundary, as runs
  started in a terminal do) or `--variant boundary` (screen what their agents fetch with an API model),
  `--yes` (make the change without asking), `--dry-run` (show it only). Exit codes: 0 nothing stops runs
  started from Hermes, 3 something is left for you to do.
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
| `url` | not set | Only for a roko serve on another machine (`https://…`): the plugin then uses that one and starts nothing. On this machine each project's serve.json says where its roko serve listens (a loopback `url` from 0.5 or 0.6 is used only while the default project has no serve.json) |
| `workdir` | not set | The default project, a git checkout roko works in; `hermes roko init` and `setup` fill it in. A page's choice of default lasts until this changes |
| `auto_start` | `true` | Start a project's roko serve when Hermes needs it: the app opening, a page showing the project, a chat's first roko call. Off: only **start roko serve** and `hermes roko serve start` start it |
| `roko_bin` | `""` | The roko binary; empty: `ROKO_BIN`, `~/.roko/bin/roko`, `roko` on `PATH`, then `~/.cargo/bin/roko` |
| `idle_exit_minutes` | `60` | A roko serve Hermes starts stops by itself after this many minutes without work (no runs, open pages or requests); `0`: never |
| `api_key_env` | `ROKO_API_KEY` | The environment variable that holds the key for a roko serve on another machine (on this machine Hermes uses each project's launch token first) |
| `max_run_usd` | `5.0` | The largest cap one run may name |
| `max_day_usd` | `20.0` | The most runs started from Hermes may spend in a day; `0` turns the limit off |
| `approve_paid` | `true` | Ask before starting paid work |
| `confirm_decisions` | `true` | Ask before Hermes answers something for you |
| `prompt_section` | `true` | Teach the model how to use roko, in its system prompt |
| `ui_actions` | `true` | Let the desktop app and dashboard start plans, answer and cancel; `false` makes them read-only |
| `timeout_s` | `20` | Seconds to wait for one answer from roko serve |
| `allow_insecure_remote` | `false` | Allow sending the key over plain `http` to another machine |
| `learning_guard` | `false` | Opt-in: refuse Hermes' background review a skill or memory that teaches repairing roko's state or re-running paid roko work (Hermes 0.22+; takes effect when Hermes restarts; see [Using roko](using-roko.md#what-hermes-learns-from-a-roko-turn)) |
| `run_end_follow_up` | `false` | Opt-in: when a run ends, send the chat that started it one short turn, so it reports the end without being asked (one model call per run; needs `plugins.entries.roko.allow_gateway_injection`). Off, the chat's next turn starts with how the run ended (see [Using roko](using-roko.md#when-the-run-ends)) |

Environment variables: `ROKO_URL` (or `ROKO_SERVE_URL`) pins one roko serve, as a remote `url` does; `ROKO_API_KEY`
holds the key; `ROKO_BIN` names the roko binary. Setup writes a key it makes to `~/.hermes/.env`.

## roko-side settings

These live in the project's `roko.toml`, plus API keys in `~/.roko/.env`. roko serve reads `roko.toml` again for
every run, so the models, the ladder, `[serve.mcp]` and `[agent.data_llm]` apply to the next run. Restart
roko serve (`hermes roko serve restart`, or **restart** on the page) after you change `~/.roko/.env` (it reads
keys when it starts) or the settings of roko serve itself (`[serve]`, `[serve.auth]`, `[server]`).

| Setting | Default | What it does |
|---|---|---|
| `[serve.mcp] allow_without_data_llm` | `false` | `true` runs chat requests without the data-model boundary, as runs started in a terminal run |
| `[agent.data_llm]` | not set | A model that screens what an agent fetched from the web or an MCP tool before the agent reads it; set it instead of `allow_without_data_llm` when other people can reach Hermes. It applies to every run that uses an API model, runs started in a terminal too |
| `[serve.mcp] max_run_usd` | `5.0` | roko's own limit on one chat-started run's cap |
| `[serve.auth] enabled` | `true` | Require a key for roko's API |
| `[server] port` | `6677` | The port `roko serve` listens on (`roko serve --port` overrides it); a serve Hermes starts takes it when it is free, else one the OS picks |
| `[[routing.ladder.rungs]]` | written by `roko init` | The models roko tries, cheapest first; a run started from a chat needs one roko calls through an API. Under a spending cap roko passes over a model it has no price for (`cost_input_per_m` and `cost_output_per_m` on its `[models.*]` entry, or roko's own price table) and moves only up the ladder |
| `[learning] gate_threshold_flush_interval` | `10` | How often the checks' learned thresholds are saved; `1`, which `hermes roko init`'s learning step sets, saves them after every verify run |
| `[sections] pinned` | `[]` | Prompt sections roko never leaves out; `["domain_context"]`, which the same step adds, keeps the section that carries lessons in every prompt (a control arm still holds lessons back from some tries) |
| `[serve] live_agent_output` | `"tool_steps"` | `"trusted"` also streams the agent's words, reasoning and tool results as they happen, before roko's output screening; roko honours it only on a loopback bind |

`hermes roko fix workspace-chat-ready` sets one of the first two for you and shows the change first. To screen
with a model yourself, name a model roko calls through an API with its key set (a `[models.*]` entry):

```toml
[agent.data_llm]
model = "gpt-4o-mini"
```

A model roko cannot call here (a CLI model such as Claude Code, or one whose key is not set) stops every run that
uses an API model before it starts, and a roko from 2026-10-15 on refuses runs from a chat until it is fixed. When
a screening call does not go through (a rate limit, an outage), the agent does not get that result.

A run started from a chat needs a model roko calls through an API. A CLI agent (Claude Code, Codex, Gemini
CLI, Cursor) runs its own tools, so roko cannot hold that agent's outbound actions for your approval.
[Getting started: By hand](getting-started.md#by-hand) shows how to add one.

## Where things are

| What | Where |
|---|---|
| The key Hermes uses | `~/.hermes/.env`, as `ROKO_API_KEY` |
| The plugin's settings | `~/.hermes/config.yaml`, under `plugins.entries.roko.settings` |
| roko serve's address and launch token | `<project>/.roko/runtime/serve.json` and `serve.token` |
| roko serve's output | `<project>/.roko/logs/serve.log` (a serve Hermes started) |
| The projects Hermes knows | the plugin's state (`projects.v1`), under `~/.hermes/plugin-data/` |
| What Hermes is starting, or failed to start | the plugin's `serves/` folder under `~/.hermes/plugin-data/`, one marker and one lock per project |
| A run's work | its branch in the project, named from its plans: `roko/work/<plan>` |
| roko's API keys for models | `~/.roko/.env` |
| The sound switch | the page's own storage (desktop: per app; dashboard: per browser) |

# hermes-plugin-roko

A [Hermes Agent](https://github.com/NousResearch/hermes-agent) plugin that lets Hermes hand work to
[roko](https://github.com/wpank/roko), an orchestration harness that runs work as gated tasks: an agent
does the work in roko's workspace, and the workspace's checks (build, lint, tests) must pass before roko
counts it as done.

Hermes keeps the conversation; roko does the verified execution. From any Hermes surface (CLI, TUI,
Telegram, Discord, …) the model can write a plan, run it under a spending cap, follow it to a verdict,
and tell the person where the verified change is. The person approves anything that costs money, and
answers whatever a run waits on. In the Hermes desktop app and web dashboard roko also gets its own
page, a status chip, and live run cards in chat.

```
you ─► Hermes ─► roko_run / roko_plan_run ─► roko serve (/mcp) ─► agents in roko's workspace
                      ▲                                              │  gates: build, lint, tests
                      └──────────── roko_status (verdict, cost, branch) ◄┘
```

## What it adds to Hermes

**Eight tools** (toolset `roko`):

| Tool | What it does | Cost and approval |
|---|---|---|
| `roko_run` | One piece of work as a single gated task | paid; asks the person first |
| `roko_plan_generate` | roko's planner writes a plan (a graph of small gated tasks) | paid; asks first |
| `roko_plan_run` | Runs a plan, or queues it behind the run in progress | paid; asks first |
| `roko_status` | A run's one-line headline, state, verdict, cost against its cap, gates, task counts, what waits on the person (each item with a 6-character code), and the branch its verified work is on. `detail: "tasks"` adds each task's model, attempts and gates; `detail: "why"` explains a run that did not pass, with the gate output. `run_id: "last"` names the latest run. Waits up to 5 minutes and answers as soon as the state changes or something starts waiting on the person. Without a run id: roko's health, the runs Hermes started, today's spend, and everything waiting | free |
| `roko_cancel` | Stops a running or queued run (`last` works here too) | free |
| `roko_plans` | Lists plans, or shows one plan's tasks and checks, its waves (tasks that can run together) and roko's cost estimate from past runs | free |
| `roko_recall` | Searches what roko's verified runs learned about the project | free |
| `roko_decide` | Records the person's own answer to something a run waits on, named by its decision id or its code: a result to confirm, or an outbound action (send, post, payment) roko held | asks the person first, always |

Every run must name a `max_usd` cap. The plugin refuses a cap above its own limit (`max_run_usd`,
default $5.00) before roko sees the call, and roko enforces its own `[serve.mcp] max_run_usd` too.
Across runs, `max_day_usd` (default $20.00) limits a day: what the runs Hermes started spent today,
plus what running ones may still spend, plus the new cap. A start that would pass it is refused
before anyone is asked. Costs are read from roko's own efficiency events, because roko's run summary
reports $0 for plan runs.

**`/roko`**, the person's own view, in every chat surface:

| Subcommand | What it shows or does |
|---|---|
| `status [RUN_ID\|last] [why]` | roko's health, today's spend and recent runs; or one run's card: tasks with their model and gates, what waits, the branch and its review and merge commands; `why` adds the gate output of a run that did not pass |
| `runs` | the runs Hermes started, with state, cost against cap and age |
| `plans [PLAN_ID]` | the plans, or one plan wave by wave with its checks and estimate |
| `pending` | what roko waits on you for, each with a code |
| `approve CODE [NOTE]`, `reject CODE [NOTE]` | your answer; a rejection's note goes back to the run |
| `cancel RUN_ID\|last` | stops a run |
| `cost` | today's spend from Hermes against the daily limit, run by run |
| `gates` | pass rate per gate across roko's workspace |
| `learn` | the models roko used, their success rate and cost |
| `effects` | held outbound actions, and how each was decided |
| `knowledge QUERY` (or `recall`) | what roko learned about the project |
| `doctor` | checks every link to roko |

Codes are derived from the item itself, so a code means the same thing in every chat and after a
restart. A slash command comes from the person, so `/roko approve` records the decision without a
second prompt. Replies are plain text with glyphs (✓ ✗ ⟳ ⚠ ⊘), at most 1,900 characters, so they fit
one Discord or Telegram message.

**`hermes roko setup | doctor | status [RUN] | watch [RUN]`**: connect to roko serve and store a key,
check the connection, see recent runs or one run's card, and `watch` a run in a second terminal: its
card and latest events, redrawn every few seconds until it ends.

**A system-prompt section** (about 1,400 characters) that teaches the model when to delegate to roko,
the run → poll → report protocol, and, in the desktop app only, how to show a live run card in chat.

**Three skills**, `roko:delegate`, `roko:plan` and `roko:decide`: step-by-step procedures the model
loads with `skill_view` when it needs them.

**`@roko:last`** (or `@roko:<run id>`) in a message puts that run's card into it; typing `@roko:`
completes from the runs Hermes started.

**Key redaction**: roko API keys (`roko_…`) are masked in Hermes' logs, tool output and transcripts.

The plugin registers no hooks. On Hermes 0.21.0 a plugin hook that two sessions call at once blocks
the other session's tool call, and nothing here needs one.

## Where you see roko in Hermes

| Surface | What you get |
|---|---|
| Desktop app | A **roko** page in the sidebar (Runs, Waiting, Plans, Knowledge, Health), a status-bar chip (`roko ● 1 running · 2 waiting`), command-palette entries, a notification when a run ends or something starts waiting on you, and live cards the model places in chat: `::roko-run{id="…"}`, `::roko-plan{id="…"}`, `::roko-pending{run="…"}`. Approve, reject, cancel and start a plan from the page and the cards; `hermes://open/roko?run=<id>` opens a run |
| Web dashboard | A **roko** tab after Sessions with the same views, a chip in the header, and a banner on the Sessions page while a run is active or something waits on you |
| CLI and TUI | `/roko …`, `@roko:last`, and `hermes roko watch` in a second terminal |
| Telegram, Discord, Slack, … | `/roko …`, with codes to approve or reject |

The page, chip and cards need the directory install (step 2 below; a pip install has only the tools):

- **Desktop app**: after installing or updating the plugin, quit and reopen the app, because its
  backend loads the plugin's routes when it starts. Desktop plugins are off by default: turn **roko**
  on in Settings ▸ Plugins ▸ Desktop plugins. After a later update, ⌘K → "Reload desktop plugins"
  reloads the page and cards.
- **Web dashboard**: `hermes dashboard`; restart it after updating the plugin.

Both talk only to the plugin's own routes under `/api/plugins/roko/` (see
[docs/ui-api.md](docs/ui-api.md)), which Hermes authenticates like the rest of its API. roko's key
stays in Hermes' backend and never reaches the page. Text that came from roko is shown as text, never
as HTML. A click in the UI is the person acting, so starting a plan, answering a held item and
cancelling ask no second question; they are still checked against `max_run_usd` and `max_day_usd`, a
start asks you to confirm the spend first, and `ui_actions: false` makes both UIs read-only.

## Install

You need a running `roko serve` (roko 2026-10-03 or later, with the `/mcp` run tools) and Hermes
0.21.0 or later.

1. **Start roko serve** in the workspace roko should work in:

   ```bash
   roko serve --workdir ~/code/my-project        # auth is on by default
   ```

   roko refuses runs started from a chat host until the workspace has a data-model boundary, which
   screens untrusted text with a small model. Add one to the workspace's `roko.toml`:

   ```toml
   [agent.data_llm]
   model = "claude-haiku-4-5"
   ```

   For purely local use you can instead set `[serve.mcp] allow_without_data_llm = true`.

2. **Install and enable the plugin**:

   ```bash
   hermes plugins install wpank/hermes-plugin-roko
   hermes plugins enable roko
   ```

   From a local checkout (it must be a git repository with a commit), use
   `hermes plugins install file:///abs/path/to/hermes-plugin-roko`, or symlink it for development:
   `ln -s /abs/path/to/hermes-plugin-roko ~/.hermes/plugins/roko`.

   To install with pip into Hermes' own environment instead, run
   `VIRTUAL_ENV=~/.hermes/hermes-agent/venv uv pip install hermes-plugin-roko`, then
   `hermes plugins enable roko`.

3. **Connect**:

   ```bash
   hermes roko setup --workdir ~/code/my-project --mint
   ```

   Setup finds roko serve's URL in `<workdir>/.roko/runtime/serve.json`. If auth is on, it uses roko
   serve's launch token (`.roko/runtime/serve.token`) to mint a write-scoped API key named `hermes`,
   saves it to `~/.hermes/.env` as `ROKO_API_KEY`, and runs the doctor. Already have a key? Use
   `hermes roko setup --url http://127.0.0.1:6677 --key-stdin < keyfile`.

4. **Use it.** Start a new session (and restart a running gateway), then ask:

   > Use roko to add a unit test for the parser. Cap it at $1.

## What a run looks like

```
› Use roko to add is_even to src/lib.rs with a test, cap $0.10, and tell me where the change is.

  🚀 roko_run      approve? Spend up to $0.10 on one gated task in roko: "In src/lib.rs add …" (today: $0.00 spent of $20.00)
  ⏳ roko_status   succeeded · gates 1/1 · $0.01 of $0.10 · 37s · branch roko/batch/e15cd28a… (not merged)

Done, and verified: roko's compile gate passed, 1/1 task, $0.01 of the $0.10 cap, 37 s.
The change is on branch roko/batch/e15cd28a-… in ~/code/my-project (2 files, 18 lines added),
not merged into your checked-out branch.
  Review: git -C ~/code/my-project diff 3cfff55c8a68..roko/batch/e15cd28a-…
  Merge:  git -C ~/code/my-project merge --ff-only roko/batch/e15cd28a-…
```

roko never commits into your checked-out branch. Each run gets a branch, `roko/batch/<run_id>`, that
holds every plan whose tasks passed their gates. roko serve reports it in the run's summary: the
branch's commit, the files it changes, whether your checkout already has it, and the command that takes
it. `roko_status` passes that on. Against an older roko serve, the plugin reads the branch itself
(read-only), which needs the workspace on the same machine. You review the work and merge it yourself.

## Settings

Under `plugins.entries.roko.settings` in `~/.hermes/config.yaml`; set one with
`hermes config set plugins.entries.roko.settings.<key> <value>`. They are read on every use, so a
change applies without a restart.

| Key | Default | Meaning |
|---|---|---|
| `url` | `http://127.0.0.1:6677` | roko serve's URL. The `ROKO_URL` (or `ROKO_SERVE_URL`) environment variable overrides it; otherwise `<workdir>/.roko/runtime/serve.json` is used |
| `workdir` | unset | the roko workspace; lets the plugin find the URL and launch token, and read result branches |
| `api_key_env` | `ROKO_API_KEY` | the environment variable that holds the key |
| `max_run_usd` | `5.0` | the largest `max_usd` a run started from Hermes may name |
| `max_day_usd` | `20.0` | the most the runs Hermes starts may spend in a day, counting what running ones may still spend; `0` turns it off |
| `approve_paid` | `true` | ask the person before `roko_run`, `roko_plan_generate` and `roko_plan_run` |
| `confirm_decisions` | `true` | ask the person before `roko_decide` records an answer |
| `prompt_section` | `true` | add the `roko` section to new sessions' system prompt |
| `allow_insecure_remote` | `false` | allow sending the key over plain `http` to a non-loopback host |
| `timeout_s` | `20` | seconds to wait for roko serve to answer one request |
| `ui_actions` | `true` | let the desktop app and dashboard start plan runs, answer held items and cancel runs; `false` makes them read-only |

## Safety

- **Text from roko is cleaned before anyone sees it.** Run labels, questions, summaries and gate output
  are written by agents, so escape sequences (which could recolour or rewrite a terminal), control
  characters and bidirectional overrides are removed before they reach a terminal, an approval prompt,
  a chat or a page, and the pages show them as text only.
- **The person approves spending.** Paid tools go through Hermes' own approval gate, the one it uses
  for dangerous shell commands: `[o]nce / [s]ession / [a]lways / [d]eny` in the terminal, buttons on
  messaging platforms. Where nobody can answer (cron, `hermes chat -q`) the gate refuses, unless you
  set `approvals.cron_mode` or `approvals.single_query_mode` to `approve`. `--yolo` skips it. An
  "always" answer covers the same kind of work at the same cap (`roko_run` at $0.50, or plan `x` at
  $2.00), never a larger cap.
- **The person decides what a run waits on.** `roko_decide` answers only what roko still waits on,
  shows the person what it is (the held action's tool, server and run, or the task's question), and
  asks with a rule key bound to that item and that verdict, so answering "always" to one decision
  never covers another one, or the opposite verdict. `/roko approve` and `/roko reject` are typed by
  the person, so they need no second prompt.
- **Slow answers are not reported as failures.** Applying a held action can take minutes (roko
  replays the call and checks its receipt), so answers wait up to 4 minutes. If roko still has not
  answered, the plugin says the decision may already be recorded. If a paid start times out, roko may
  have started the run anyway, so the plugin looks for it: a run started from a chat since the
  request, which Hermes has not seen yet. If there is exactly one, it is reported and followed like any
  other; if not, the plugin says to wait and check before retrying, so nothing runs twice.
- **Runs started from Hermes carry roko's chat-host protections**: a required spending cap, origin
  `mcp:<key name>`, the request fenced as untrusted text, and outbound actions held for approval. They
  go through roko serve's `/mcp` endpoint, which applies these; the plain REST routes do not.
- **The key** is write-scoped, stored in `~/.hermes/.env`, sent as `X-Api-Key`, never written to
  `config.yaml` or printed, and never sent over plain `http` to another host unless you allow it.
  "This machine" means `localhost` or a loopback IP literal, and requests to it ignore
  `HTTP(S)_PROXY`. A roko URL found in a workspace's `serve.json` is used only if it is loopback.
- **The approval prompts are advisory against a model that has a shell.** Hermes strips its own
  provider keys from the environment of shells the model runs, but not `ROKO_API_KEY` (checked on
  0.21.0), and its file protections are, in its own words, "not a security boundary". A
  prompt-injected model with the terminal tool can therefore call roko serve directly and skip the
  plugin's prompts. What still holds is roko's side: the `[serve.mcp] max_run_usd` cap per run and the
  untrusted-text fence. Held outbound actions do not hold against such a model, because roko accepts an
  approval from the same key. If that is not enough, run Hermes without the terminal tool for sessions
  that can reach roko, or keep `max_run_usd` low.

## Troubleshooting

`hermes roko doctor` (or `/roko doctor`) checks each link and says what to do:

| Check | When it fails |
|---|---|
| `reachable` | roko serve isn't running at the URL: start it, or `hermes roko setup --url …` |
| `auth` | the key is missing or wrong: `hermes roko setup --workdir <ws> --mint` |
| `scope` | the key is read-only: mint a write-scoped one |
| `mcp` | this roko serve predates the `/mcp` run tools: update roko |
| `runs` | the workspace has no data-model boundary (see step 1). The probe names a plan that cannot exist, so nothing runs |
| `mcp` (warning) | Hermes also has roko as an MCP server, so the model sees roko's tools twice: remove one |
| `ui` (warning) | a pip install has no desktop or dashboard half: install the directory instead |

The doctor also says which UI halves are installed and how to show them. If the roko page or tab says
roko's backend isn't loaded, Hermes started before the plugin was installed or updated: restart the
desktop app or `hermes dashboard`.

Exit codes: 0 ok, 1 a check failed, 3 a warning under `--strict`, 4 roko serve unreachable.

The `scope` check cancels a run that cannot exist and the `runs` check names a plan that cannot exist,
so neither one changes anything in roko.

On a gateway that several people use, they share one roko connection: the runs Hermes started and
`/roko pending` are not separated by user.

By default Hermes' Tool Search keeps plugin tools behind `tool_search`, so the model discovers `roko_*`
by name; the system-prompt section names them. To show them to the model directly, set
`tools.tool_search: false`.

## Development

```bash
uv venv --python 3.11 .venv && uv pip install -e '.[dev]'
.venv/bin/ruff check . && .venv/bin/ruff format --check . && .venv/bin/mypy
.venv/bin/pytest                                   # unit tests, plus Hermes compat if Hermes is installed
ROKO_BIN=/path/to/roko .venv/bin/pytest tests/contract   # against a real roko serve, at no model cost
```

The test lanes:

- **Unit** (`tests/test_*.py`): a strict fake `PluginContext`, plus `tests/fake_roko.py`, a stdlib stand-in
  for roko serve's REST routes and `/mcp` tools that reproduces their envelopes, caps, refusals and auth.
- **Compat** (`tests/compat`): loads the plugin into the installed Hermes (`HERMES_AGENT_SRC`, default
  `~/.hermes/hermes-agent`) through Hermes' own plugin manager, tool registry, slash-command resolver and
  prompt-section renderer, and runs `hermes plugins doctor --ci`. Nothing under `~/.hermes` is touched.
- **Contract** (`tests/contract`): starts a real `roko serve` with auth on in a scratch workspace and
  scratch `HOME`, runs `setup --mint`, the doctor and every tool.
- **UI backend** (`tests/test_ui_api.py`): every `/api/plugins/roko` route through FastAPI's test client,
  and `dashboard/plugin_api.py` imported by path the way Hermes' web server imports it. The compat lane
  also mounts it in Hermes' own web server and checks auth, the dashboard tab and the asset routes.
- **Desktop half** (`tests/desktop`): `desktop/plugin.js` through the real Hermes desktop loader, SDK and
  React, with vitest and Testing Library: `bash tests/desktop/setup.sh`, then
  `node tests/desktop/node_modules/vitest/vitest.mjs run --config tests/desktop/vitest.config.mts`.
- **Dashboard half** (`tests/dashboard`): `dashboard/dist/index.js` in jsdom with a fake dashboard SDK:
  `node --test tests/dashboard/roko-dashboard.test.mjs`.

Text views run from fixtures too: `tests/fixtures/roko_plan_run_events.json` is the event index of a
real plan run, which the run-card tests fold.

## Compatibility

Tested with Hermes Agent 0.21.0 (`63279301`) on Python 3.11, its desktop app's plugin SDK and its web
dashboard's plugin SDK 1.1, and roko serve at `856ed7570` (2026-10-09). The plugin needs these roko MCP tools: `run_status`, `recall`, `run_prompt`, `plan_run`,
`plan_generate`, `run_cancel`, `confirm_pending`, `confirm_answer`, `effects_pending` and
`effect_decide`; `hermes roko doctor` reports any that are missing.

## License

MIT OR Apache-2.0, at your option.

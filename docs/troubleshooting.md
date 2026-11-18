# Troubleshooting

Start with the setup check. It asks roko serve what stands between Hermes and a run that works, and offers the fix
for each problem it finds:

```bash
hermes roko fix           # what needs fixing, if anything
hermes roko doctor        # every check, the passing ones too; or /roko doctor in any chat
hermes roko init          # every setup step again, in your project; it changes only what is missing
```

The roko page shows the same problems as a **setup card** at the top, with one key per fix: **make ready** shows
the change to `roko.toml` before it makes it, a command has a copy key, and a restart says what to quit and reopen.

| Check | When it fails |
|---|---|
| `project` | Which project Hermes uses by default, and where its roko serve listens |
| `reachable` | roko serve doesn't run for the project, or doesn't answer ([roko serve is not reachable](#roko-serve-is-not-reachable)); no roko to start it with ([Install roko](getting-started.md#install-roko)), or one too old ([roko is too old to start roko serve](#roko-is-too-old-to-start-roko-serve)); a project roko is not set up in ([Set roko up in a project](getting-started.md#set-roko-up-in-a-project)) |
| `auth` | The key is missing or wrong ([The key is refused or read-only](#the-key-is-refused-or-read-only)) |
| `scope` | The key is read-only (same section) |
| `mcp` | This roko is too old for the plugin ([roko serve is older than the plugin](#roko-serve-is-older-than-the-plugin)) |
| `runs` | roko refuses runs started from a chat ([roko refuses runs started from Hermes](#roko-refuses-runs-started-from-hermes)), or none of their models has a price ([roko has no priced model for runs from Hermes](using-roko.md#roko-has-no-priced-model-for-runs-from-hermes)) |
| `models` | roko has no model a chat-started run can use ([roko has no model for runs started from Hermes](#roko-has-no-model-for-runs-started-from-hermes)), or none with a price its cap can count ([roko has no priced model for runs from Hermes](using-roko.md#roko-has-no-priced-model-for-runs-from-hermes)) |
| `install` | Hermes runs an older copy of the plugin than the one installed ([Updating](updating.md#2-restart-what-you-use)) |
| `approvals` (warning) | Hermes' approvals are off, so roko runs start without asking you: `hermes config set approvals.mode smart` ([Using roko](using-roko.md#when-hermes-approvals-are-off)) |
| `ui` (warning) | A pip install has no desktop or dashboard page: install the plugin's folder instead |

Exit codes: 0 all good, 1 a check failed, 3 something for you to do (or a warning with `--strict`), 4 roko serve
unreachable.

## Setup problems

### roko serve is not reachable

Hermes starts each project's roko serve by itself (`roko serve --detach`): when the desktop app opens, when the roko
page shows a project, and when a chat first uses roko. The page's banner and `hermes roko serve status` say where it
stands:

| State | What it means | What to do |
|---|---|---|
| `running` | it answers, and it is this project's serve | nothing |
| `starting` | Hermes (this app, a chat, or a terminal) is starting it: a few seconds | wait; the page updates itself |
| `stopped` | none runs for the project: it stopped itself after `idle_exit_minutes` without work, or it was stopped | nothing: Hermes starts it when it needs it. With the `auto_start` setting off, **start roko serve** (or `hermes roko serve start`) |
| `failed` | the last start failed; the banner shows why and the last lines of `<project>/.roko/logs/serve.log` | fix what the log says, then **start again**. Hermes waits a minute before it tries again by itself |
| `outdated` | the roko binary cannot start a serve in the background, or the running serve is from before `/mcp` | [update roko](#roko-is-too-old-to-start-roko-serve), then restart roko serve |
| `not_found` | no roko binary on this machine | [install roko](getting-started.md#install-roko), or set the plugin's `roko_bin` setting |
| `remote` | the plugin's `url` (or `ROKO_URL`) names a roko serve on another machine | Hermes starts and stops nothing there: check that serve where it runs |

```
✗ reachable: roko serve did not start for my-project.
    Error: roko.toml at ./roko.toml is not valid: duplicate key `mcp`. The log's last lines say why; `roko
    serve --workdir /Users/you/code/my-project` in a terminal shows all of it.
    → start roko serve: hermes roko serve start --project /Users/you/code/my-project
```

`locked` means another roko process (a plan run in a terminal, say) holds the project: roko serve starts once it
ends. `not_initialized` means roko found no model provider ([roko has no model provider](#roko-has-no-model-provider)).
A project with no `roko.toml` can have a roko serve (on roko's defaults), but roko refuses runs started from Hermes
there until you set it up ([Set roko up in a project](getting-started.md#set-roko-up-in-a-project)).

Hermes never kills a roko serve: it stops and restarts one only through `roko serve stop` and `restart`, which leave
a serve with runs going alone unless you confirm. A roko serve you started yourself in a terminal is used as it is
(`started_by: other`).

The roko page says OFFLINE only after two looks in a row find no roko serve, a second or more apart (or one, when
its live stream to roko broke too): one dropped connection while a run starts is not roko being down. A roko serve
that answers late, or asks Hermes to slow down, is busy, not down: the page shows its status as `slow`.

### The key is refused or read-only

roko serve with auth on needs a key that can start, cancel and answer runs. `hermes roko setup --workdir
~/code/my-project --mint --yes` makes a new one named `hermes` and saves it; for a read-only key, add
`--key-name hermes-write` so the old key keeps working for whatever else uses it.

A Hermes app that was already open when setup or `hermes roko init` saved a new key still holds the old one. When
roko refuses the old key, the plugin switches to the saved one by itself. If the page keeps saying the key is
refused, that Hermes runs an older copy of the plugin: quit it with ⌘Q and open it again.

### roko refuses runs started from Hermes

```
✗ runs: roko refuses runs started from Hermes in this workspace.
    /Users/you/code/my-project/roko.toml neither sets roko's data-model boundary ([agent.data_llm]) nor allows
    runs from a chat without it, so roko refuses every run you start from Hermes.
    → make ready: hermes roko fix workspace-chat-ready
```

roko treats a request that comes from a chat as untrusted text, and refuses to run it until `roko.toml` says how.
`hermes roko fix workspace-chat-ready` (or **make ready** on the setup card) shows the change, asks, and makes it:

- **run without the boundary (local use)**, the default: `[serve.mcp] allow_without_data_llm = true`. Runs you
  start from Hermes then run as runs you start in a terminal do. Only runs started from a chat change.
- **screen with a model** (`--variant boundary`): an `[agent.data_llm]` table naming an API model with its key set
  (the cheapest one roko lists on its maker's own API). Before an agent reads what it fetched from the web or an MCP
  tool, that model screens it. roko then screens in every run in the workspace that uses an API model, runs started
  in a terminal too, and when a screening call does not go through (a rate limit, an outage), the agent does not get
  the result. Choose it when other people can reach your Hermes.

roko reads `roko.toml` for every run it is asked to start, so the change works at once: **no restart**. The fix keeps
a copy of the old file in `.roko/backups/`. If `roko.toml` is in git, commit the change: the page's Merge works only
on a checkout without uncommitted changes.

To make the change by hand, edit the existing line in the `[serve.mcp]` section (`roko init` writes it), or add the
section if your `roko.toml` has none:

```toml
[serve.mcp]
allow_without_data_llm = true
```

A newer roko also refuses runs when `[agent.data_llm]` names a model it cannot call: the fix then names one it can
instead. roko uses `[agent.data_llm]` whenever it is set, so `allow_without_data_llm` does not help in that case.

### roko has no model for runs started from Hermes

A run started from a chat holds anything that acts on the outside world for your approval, and only roko's own
agent loop can do that. So it needs a model roko calls through an API with its key set, not a CLI agent such as
Claude Code or Codex. Two ways it shows:

```
✗ models: roko has no model it can use for runs started from Hermes.
```

or, with a roko older than 2026-10-15, a run that fails within seconds, costs nothing, and says (`/roko status last
why`):

```
no usable provider for this task: `claude-sonnet-4-6` on `claude_cli`: provider `claude_cli` (claude_cli) runs
its own tools, so it cannot honour the task's `stage` policy … (claude-sonnet-4-6@anthropic: ANTHROPIC_API_KEY is
not set).
```

Give roko an API model. `hermes roko init` does it: it offers the key Hermes has, and adds a model to
`roko.toml` when roko has none. By hand ([Getting started: By hand](getting-started.md#by-hand)):

1. Put the provider's key in `~/.roko/.env` (`mkdir -p ~/.roko` first if the folder doesn't exist).
2. Make sure `roko.toml` names a model on that provider, on the model ladder. A recent `roko init` does this from
   the keys it finds; with an older roko, add the `[providers.*]` and `[models.*]` tables and the ladder rung by
   hand.
3. Restart `roko serve`: it reads `~/.roko/.env` only when it starts.

`hermes roko doctor` then says `✓ models: roko has API models for work from chat: …`.

### roko serve is older than the plugin

The `mcp` check fails when roko serve lacks the tools the plugin needs (a roko from August answers `/mcp` with 404):
update roko, then **restart roko serve** on the page's setup card (`hermes roko serve restart`), which starts it again
on the roko binary Hermes finds now. A warning (`! roko serve is older than this plugin.`) means runs still work but
some views stay empty, for example a run's changes without roko's diff route, or the five loops on Learning without
roko's loop events. Restart roko serve from a current roko build to get them.

### roko has no model provider

```
✗ reachable: roko has no model provider for my-project, so its roko serve did not start.
    → give roko a model key: hermes roko init --workdir /Users/you/code/my-project
```

roko serve needs a model it can call: a key for one in `~/.roko/.env` (OpenAI, Anthropic, OpenRouter, Cerebras, Z.ai or
Moonshot), or a `roko.toml` that names a provider. `hermes roko init` in the project offers the key Hermes has, or add a
line such as `OPENAI_API_KEY=…` to `~/.roko/.env` with your editor ([Getting started: By hand](getting-started.md#by-hand)).
Then **start roko serve** again.

### roko is too old to start roko serve

```
✗ reachable: roko is too old to start roko serve in the background.
    The roko at /Users/you/.cargo/bin/roko is from before `roko serve --detach`, so Hermes cannot start roko serve
    for my-project. Update roko: in your roko clone, `git pull && cargo install --path crates/roko-cli`.
```

Hermes starts roko serve only with `roko serve --detach` (roko from 2026-10-19 on). Update roko as the line says, or
point the plugin's `roko_bin` setting at a newer build. A roko serve that runs already keeps working; Hermes just
cannot start or restart one with that binary.

## Other problems

### I asked, and nothing ran: "Approval … timed out"

```
⚠ Approval: <roko_run> (plugin approval rule) → timed out (no response)
```

Hermes denies an approval nobody answers within 5 minutes, and nothing runs. Ask again, and choose **Allow
once** (press Enter) when the box appears.

### `hermes chat -q "…"` won't start a roko run

A single-query chat has nobody to answer the approval, so Hermes refuses it. Start an interactive `hermes`
session instead. For scripts you trust, `approvals.single_query_mode: approve` in `~/.hermes/config.yaml`
approves for you; it applies to every tool that asks, not only roko's.

### Hermes doesn't use roko

- Start a **new** session after installing; tools load when a session starts. Restart a running gateway
  (`hermes gateway restart`) for Telegram, Discord and other chat apps; without them you have no gateway to
  restart, whatever the install says.
- Check that `hermes plugins list` shows **roko** as enabled.
- Say "use roko" in your request.

A "Warning: Unknown toolsets: roko" line at the start of a session is harmless: Hermes checks its toolsets a
moment before the plugin's tools are registered.

### "max_usd 8.00 is above the 5.00 cap set for runs started from Hermes"

Name a smaller cap, or raise the limit on both sides: the plugin's `max_run_usd`
(`hermes config set plugins.entries.roko.settings.max_run_usd 10`) and roko's `[serve.mcp] max_run_usd` in
`roko.toml`. roko's own refusal reads "max_usd 8.00 is above the 5.00 USD a run started over /mcp may spend".

### "starting this run could take today's roko spend to $…, over the $20.00 daily limit"

`/roko cost` shows what today's runs spent and what running ones may still spend. Name a smaller cap, wait for
running runs to finish, or raise `max_day_usd`.

### The branch has build files in it (`target/`, `node_modules/`, …)

roko commits everything its agent leaves in the project. Add the build folders to `.gitignore`, commit that,
and run again.

### The desktop app has no roko page, or it shows the home screen

Turn on roko's **Desktop** switch in Capabilities ▸ Plugins (Settings ▸ Plugins ▸ **Manage plugins** leads there).
The sidebar entry and the status chip appear at once. If the app was open when you installed or updated the plugin,
quit it with ⌘Q (closing the window is not enough) and open it again: Hermes loads a plugin's backend only when it
starts. The page's setup card says so when this is the case.

### The roko page shows the chat after the app starts

Now and then, on a fresh start, the desktop app highlights **roko** in the sidebar but keeps showing the chat. That
comes from the app's own routing, not the plugin: click another sidebar entry and then **roko** again, or press ⌘R.

### Merge says it can't merge

**merge into main**, in a passed run's changes, merges only when it is safe to do from a button. Each refusal says
why, with the command to run yourself:

| It says | Do |
|---|---|
| the checkout has uncommitted changes to N tracked files | commit or stash them, then merge again |
| the run's changes conflict with the checkout's branch | merge in a terminal with the command shown and resolve the conflict |
| the checkout is not on a branch (detached HEAD) | check out the branch you want the work on |
| a merge, rebase, cherry-pick or revert is in progress | finish or abort it first |
| roko's workspace is not on this machine | merge where roko runs, with the command shown |
| the run's branch moved since you reviewed it | look at the changes again (they reload), then merge |
| this git cannot check a merge without making it | your git is older than 2.38: update it, or merge in a terminal |

After a merge, the page shows the command that undoes it (`git reset --keep <previous commit>`).

### A new run says it is queued

roko runs one thing at a time in a workspace. A run started while another is going waits in roko's queue, with its
position, and starts when the earlier one ends. Cancel either one from its page if you change your mind.

### The page's light is out, and its hover says it is polling

The page's live stream isn't connected, so it asks roko for news instead: every 3 seconds for an open run, every 10
for the list. Everything still works, a little later. The usual reasons:

- The desktop app is connected to a remote Hermes that you sign in to (OAuth). Hermes opens no plugin sockets there,
  so the page stays on polling.
- Hermes restarted, or the laptop slept. The page reconnects by itself (on the dashboard, its light blinks red
  meanwhile).

Settings ▸ Plugins ▸ roko shows the stream's state under **Connection**, on its **live stream** row: lit when roko's
events stream in, and what is wrong when they don't.

### A run shows no words while its agent works

roko streams an agent's words only when `roko.toml` has `[serve] live_agent_output = "trusted"` (change the line
`roko init` wrote) and `roko serve` listens on this machine alone (the default). Restart `roko serve` after the
change. Even then, words stream for plan runs (**plan first**); a single task's words (**run it**), and an API
model's tool steps, arrive when the try ends.

### One of the five loops on Learning never lights up

- **It needs a newer roko.** The model picked for each try, sign-offs, held calls and lessons come from events roko
  publishes since 2026-10-14. With an older roko, **tool calls** stays dark and the others show less.
- **Tool calls lights when roko holds a call for you**: a call that acts on the outside world (an MCP tool marked so,
  or a plugin tool with network and write access) in a run whose domain stages such calls. The `ops` domain does by
  default; another domain does with `outbound = "stage"` in its `[profiles.<domain>]`. roko can hold only the calls
  of an API model: Claude Code and Codex run their own tools. Most coding runs hold nothing.
- **Spot checks light when a run ends**, as roko's auditor reports on each learning loop. A loop changes state
  rarely: roko judges it after 200 settled decisions and moves it at most once a day.

### Every try says "started on the cheapest model"

roko's model ladder (`[routing.ladder]`, on by default) starts each plan task on the cheapest model it may use and
moves it up after failed checks; the model roko's learning would pick is only logged. To let roko's learning pick, set
`enabled = false` under `[routing.ladder]` in `roko.toml`. A task's `model_hint` and `--model` win either way.

### I don't see the side pane, the `roko` theme or the `→ roko` key

- **The side pane** lives in the right sidebar, which may be collapsed: pick "roko: Monitor pane" in the command
  palette (⌘K).
- **The `roko` theme** is installed but not selected: pick it in Settings ▸ Appearance, or press **use the roko
  theme** under Settings ▸ Plugins ▸ roko.
- **The `→ roko` key** shows once roko serve answers, and only while the app may act for you (`ui_actions` on, the
  default). **The empty-chat card** shows in an empty chat that already has a session, once roko serve answers;
  a new chat shows Hermes' own start screen, so use the `→ roko` key beside the model pill there.

### The web dashboard has no roko tab

Restart `hermes dashboard` after installing or updating the plugin.

### I changed `roko.toml` or `~/.roko/.env` and nothing changed

roko reads `roko.toml` again for every run, so a change to the models, the ladder, `[serve.mcp]` or `[agent.data_llm]`
applies to the next run. Restart roko serve after you change `~/.roko/.env` (it reads keys only when it starts) or
the settings of roko serve itself, `[serve]`, `[serve.auth]` and `[server]`: **restart** on the roko page, or
`hermes roko serve restart --project ~/code/my-project`.

### "run 'abc' not found"

Give at least 4 characters of a run Hermes started (the lists show 8), the full run id, or `last`. A run
started outside Hermes needs its full id.

### `hermes plugins install` asks about Python dependencies, or leaves roko disabled

"roko declares Python dependencies … [y/N]", or without a terminal "✗ Cannot enable roko: dependency install
skipped (non-interactive)": your copy of the plugin is older than 0.5. Update your copy (`git pull`) and install
again; the plugin now asks Hermes to install nothing. With the older copy, answer `y`, or add `--yes-deps`.

### `hermes plugins install` says the security scan blocked the plugin

Your copy is older than the fix for that. Update it (`git pull` in your copy of hermes-plugin-roko) and
install again with `--force`.

# Troubleshooting

Start with the doctor. It checks every link between Hermes and roko and says what to fix:

```bash
hermes roko doctor        # or /roko doctor in any chat
```

| Check | When it fails |
|---|---|
| `reachable` | roko serve isn't running at the URL: start it in your project, or run `hermes roko setup` again |
| `auth` | The key is missing or wrong: `hermes roko setup --workdir ~/code/my-project --mint --yes` |
| `scope` | The key is read-only: mint a write-scoped one (same command) |
| `mcp` | This roko is too old for the plugin: update roko |
| `runs` | roko refuses runs started from a chat (see the first problem below) |
| `ui` (warning) | A pip install has no desktop or dashboard page: install the plugin's folder instead |

Exit codes: 0 all good, 1 a check failed, 3 a warning with `--strict`, 4 roko serve unreachable.

## Problems and fixes

### "roko refuses runs started from Hermes: the workspace has no data-model boundary"

```
✗ runs: roko refuses runs started from Hermes: the workspace has no data-model boundary
    → add an [agent.data_llm] table to the roko workspace's roko.toml, or for local use set
      [serve.mcp] allow_without_data_llm = true; then restart roko serve
```

In `roko.toml`, change the existing line in `[serve.mcp]` to `allow_without_data_llm = true`, or add an
`[agent.data_llm]` table ([Reference](reference.md#roko-side-settings)). Then **restart `roko serve`**: it reads
`roko.toml` when it starts.

### A run fails within seconds, costs nothing, and says "no usable provider for this task"

Ask Hermes why, or type `/roko status last why`. You'll see roko's reason, for example:

```
no usable provider for this task: `claude-sonnet-4-6` on `claude_cli`: provider `claude_cli` (claude_cli) runs
its own tools, so it cannot honour the task's `stage` policy for tool calls that act on the outside world: only
roko's own tool loop can stage or refuse them. … (claude-sonnet-4-6@anthropic: ANTHROPIC_API_KEY is not set).
```

A run started from a chat holds anything that acts on the outside world for your approval, and only roko's own
agent loop can do that. Here roko could reach its model only through the Claude CLI. Give roko a model it can
call through an API ([Getting started, step 1](getting-started.md#1-prepare-your-project)):

- put `ANTHROPIC_API_KEY=…` in `~/.roko/.env`, or
- put a model whose key is set (see `roko config models list`) on the `top` rung of `[[routing.ladder.rungs]]`
  in `roko.toml`.

Then restart `roko serve` and ask again.

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
  (`hermes gateway restart`) for Telegram, Discord and other chat apps.
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

### The desktop app's roko page shows the home screen

Press **⌘R** after turning roko on in Settings ▸ Plugins ▸ Desktop plugins, or quit and reopen the app. The
sidebar entry appears at once, but the page loads only after a reload. If the page says roko's backend isn't
loaded, Hermes started before the plugin was installed or updated: quit and reopen the app.

### The roko page shows the chat after the app starts

Now and then, on a fresh start, the desktop app highlights **roko** in the sidebar but keeps showing the chat. That
comes from the app's own routing, not the plugin: click another sidebar entry and then **roko** again, or press ⌘R.

### Merge says it can't merge

The run's **Changes** tab merges only when it is safe to do from a button. Each refusal says why, with the command
to run yourself:

| It says | Do |
|---|---|
| the checkout has uncommitted changes to N tracked files | commit or stash them, then click Merge again |
| the run's changes conflict with the checkout's branch | merge in a terminal with the command shown and resolve the conflict |
| the checkout is not on a branch (detached HEAD) | check out the branch you want the work on |
| a merge, rebase, cherry-pick or revert is in progress | finish or abort it first |
| roko's workspace is not on this machine | merge where roko runs, with the command shown |
| the run's branch moved since you reviewed it | look at Changes again (it reloads), then merge |
| this git cannot check a merge without making it | your git is older than 2.38: update it, or merge in a terminal |

After a merge, the page shows the command that undoes it (`git reset --keep <previous commit>`).

### A new run says it is queued

roko runs one thing at a time in a workspace. A run started while another is going waits in roko's queue, with its
position, and starts when the earlier one ends. Cancel either one from its page if you change your mind.

### The page says POLLING, not LIVE

The page's live stream isn't connected, so it asks roko for news instead: every 3 seconds for an open run, every 10
for the list. Everything still works, a little later. The usual reasons:

- The desktop app is connected to a remote Hermes that you sign in to (OAuth). Hermes opens no plugin sockets there,
  so the page stays on polling.
- Hermes restarted, or the laptop slept. The page reconnects by itself (the dashboard says RECONNECTING meanwhile).

Settings ▸ Plugins ▸ roko shows the stream's state under **01 CONNECTION**: `live · hub open` when it works,
`hub backoff` while roko serve doesn't answer.

### The ticker shows no words while the agent works

roko streams an agent's words only when `roko.toml` has `[serve] live_agent_output = "trusted"` and `roko serve`
listens on this machine alone (the default). Restart `roko serve` after the change. Even then, words stream for plan
runs (**plan first**); a prompt run's words (**run it**), and an API model's tool steps, arrive when the attempt ends.

### A ring on the Loops dial never lights

- **The ring needs a newer roko.** Routes (L1), sign-offs (L2), held calls (L0) and lessons (L3) come from events roko
  publishes since 2026-10-14. With an older roko, L0 stays dark and the other rings show less.
- **L0 lights when roko holds a tool call for you**: a call that acts on the outside world (an MCP tool marked so, or
  a plugin tool with network and write access) in a run whose domain stages such calls. The `ops` domain does by
  default; another domain does with `outbound = "stage"` in its `[profiles.<domain>]`. roko can hold only the calls
  of an API model: Claude Code and Codex run their own tools. Most coding runs hold nothing.
- **L4 lights when a run ends**, as roko's auditor reports on each learning loop. A loop changes state rarely: roko
  judges it after 200 settled decisions and moves it at most once a day.

### Every route says "ladder"

roko's model ladder (`[routing.ladder]`, on by default) picks the model each plan task starts on, and the learned
router's own pick is only logged. To let the router pick, set `enabled = false` under `[routing.ladder]` in
`roko.toml`. A task's `model_hint` and `--model` win either way.

### I don't see the monitor pane, the `roko` theme or the `→ roko` key

- **The monitor pane** lives in the right sidebar, which may be collapsed: pick "roko: Monitor pane" in the command
  palette (⌘K).
- **The `roko` theme** is installed but not selected: pick it in Settings ▸ Appearance, or press **use the roko
  theme** under Settings ▸ Plugins ▸ roko.
- **The `→ roko` key** shows once roko serve answers, and only while the app may act for you (`ui_actions` on, the
  default). **The empty-chat card** shows in an empty chat once roko serve answers.

### The web dashboard has no roko tab

Restart `hermes dashboard` after installing or updating the plugin.

### I changed `roko.toml` or `~/.roko/.env` and nothing changed

Restart `roko serve`. It reads both when it starts.

### "run 'abc' not found"

Give at least 4 characters of a run Hermes started (the lists show 8), the full run id, or `last`. A run
started outside Hermes needs its full id.

### `hermes plugins install` says the security scan blocked the plugin

Your copy is older than the fix for that. Update it (`git pull` in your copy of hermes-plugin-roko) and
install again with `--force`.

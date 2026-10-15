# Getting started

roko for Hermes lets you hand coding work from Hermes to [roko](https://github.com/wpank/roko). roko runs
the work as a checked task in your project: an agent makes the change on a separate branch, and your project's
checks (build, tests, lint) have to pass before roko calls it done. You review that branch and merge it.

This guide takes about ten minutes, from nothing to your first verified change.

## What you need

- **Hermes Agent 0.21.6 or later**, already working: `hermes` starts a chat.
- **roko**, installed: `roko --version` prints a version.
- **A project in git** with at least one commit. Make sure its build output is ignored by git (`target/` for
  Rust, `node_modules/` for JavaScript): roko commits everything its agent leaves in the project.
- **An API key roko can use.** A run started from a chat holds anything that acts on the outside world for
  your approval, and only roko's own agent loop can do that. So these runs need a model roko calls through an
  API, not a CLI agent such as Claude Code. Step 1 sets this up.

## 1. Prepare your project

```bash
cd ~/code/my-project
roko init
```

```
wrote ./roko.toml
initialized roko workspace at .
detected project domain: rust
suggested gates: compile (cargo check), test (cargo test), clippy (cargo clippy)

provider: claude CLI — ready
```

**Let chats start runs.** Open `roko.toml`, find the `[serve.mcp]` section, and change `false` to `true`:

```toml
[serve.mcp]
max_run_usd = 5.0
allow_without_data_llm = true
```

roko treats a chat request as untrusted text. This setting accepts it as is, which is fine on your own machine.
To screen it with a small model instead, see [Reference: roko's settings](reference.md#roko-side-settings).

**Give roko an API model.** Pick one:

- **You have an Anthropic API key.** Add it to roko's environment file:

  ```bash
  echo 'ANTHROPIC_API_KEY=sk-ant-…' >> ~/.roko/.env
  ```

  roko's default models are Claude models, so this is all it needs.

- **You have a key for another provider** (OpenAI, Z.ai, Moonshot, OpenRouter, …). List the models roko can
  use:

  ```bash
  roko config models list
  ```

  Choose one whose **Provider** is not a CLI agent (`claude_cli`, `codex_cli`, `gemini_cli`, `cursor_cli`) and
  whose **Key** is `ok`, say `glm-5-1`. In `roko.toml`, put it on the last rung of the model ladder, the one
  named `top`:

  ```toml
  [[routing.ladder.rungs]]
  name = "top"
  model = "glm-5-1"
  ```

  roko starts each task on a cheap rung and moves up when a rung can't run it, so the ladder now always ends
  on a model it can reach.

**Optional: watch the agent's words live.** To have roko stream what its agent writes while it works, add this to
`roko.toml`:

```toml
[serve]
live_agent_output = "trusted"
```

roko honours it only while `roko serve` listens on this machine alone (the default), because these words reach the
page before roko's output screening. roko streams words for plan runs (**plan first**); a prompt run's words (**run
it**) appear when its attempt ends.

## 2. Start roko serve

In the project folder, in a terminal you leave open:

```bash
roko serve
```

It listens on `http://127.0.0.1:6677` and requires a key for its API. The next step makes one for Hermes.
Restart `roko serve` whenever you change `roko.toml` or `~/.roko/.env`.

## 3. Install the plugin

The plugin isn't published yet, so install it from your copy of the repository. Use the absolute path; the
folder must be a git repository, and Hermes installs its latest commit.

```bash
hermes plugins install file:///Users/you/code/hermes-plugin-roko --enable
```

```
Warning: Using insecure/local URL scheme. Consider using https:// or git@ for production installs.
Cloning file:///Users/you/code/hermes-plugin-roko...
╭──────────────────────────────────────────╮
│ roko plugin installed. Next: …           │
╰──────────────────────────────────────────╯
✓ Plugin roko enabled.
```

The warning is expected for a local path.

## 4. Connect Hermes to roko

```bash
hermes roko setup --workdir ~/code/my-project --mint
```

```
roko serve: http://127.0.0.1:6677
  reachable: roko 0.1.0, ok
  auth: on
  key: minted 'hermes' with the write scope
  /mcp: all 10 tools the plugin uses are served
  saved ROKO_API_KEY to /Users/you/.hermes/.env
  saved plugins.entries.roko.settings.url = http://127.0.0.1:6677
  saved plugins.entries.roko.settings.workdir = /Users/you/code/my-project

✓ plugin: hermes-plugin-roko 0.4.0 on Hermes 0.22.0
…
✓ reachable: roko serve 0.1.0, status ok
✓ auth: key accepted (api_key)
✓ scope: the key can start, cancel and answer runs
✓ mcp: all 10 MCP tools the plugin uses are served
✓ runs: roko accepts runs started from Hermes
```

Setup found roko serve's address and launch token in `~/code/my-project/.roko/runtime/`, used them to create
an API key named `hermes` that can start, cancel and answer runs, saved the key in `~/.hermes/.env`, and
checked every link. `hermes roko doctor` runs the same checks any time.

If a line starts with `✗`, it says what to fix; see [Troubleshooting](troubleshooting.md).

## 5. Your first task

Start a new Hermes session (`hermes`) and ask:

> Use roko to add a function is_even(n: i64) -> bool to src/lib.rs with a unit test. Cap it at $0.50.

Hermes asks before it spends anything:

```
╭───────────────────────────────────────────────────────────╮
│ ⚠️  Dangerous Command                                     │
│                                                           │
│ <roko_run> (plugin approval rule)                         │
│                                                           │
│ ❯ 1. Allow once                                           │
│   2. Allow for this session                               │
│   3. Add to permanent allowlist                           │
│   4. Deny                                                 │
│                                                           │
│ Spend up to $0.50 on one gated task in roko: “In          │
│ src/lib.rs add a public function `is_even(n: i64) ->      │
│ bool` …” (today: $0.00 spent of $20.00)                   │
╰───────────────────────────────────────────────────────────╯
  ↑/↓ to select, Enter to confirm
```

"Dangerous Command" is the title Hermes gives every approval. Press **Enter** to allow it once. If you don't
answer within 5 minutes, Hermes denies it and nothing runs.

Hermes then follows the run and reports, about a minute later:

```
Done. roko run d0433458 — succeeded, 1/1 gate passed, 58s, cost $0.012 of the $0.50 cap.

What changed:
- src/lib.rs: added `pub fn is_even(n: i64) -> bool { n % 2 == 0 }` plus 4 unit tests.

Not merged. Review:
  git -C ~/code/my-project diff 824497bb2be6..roko/batch/d0433458-c719-4a28-b5d5-900a7501d462

Merge (fast-forward):
  git -C ~/code/my-project merge --ff-only roko/batch/d0433458-c719-4a28-b5d5-900a7501d462
```

## 6. Review and merge

roko never commits to the branch you have checked out. Each run's work is on its own branch,
`roko/batch/<run id>`. Use the two commands from the answer:

```bash
git -C ~/code/my-project diff 824497bb2be6..roko/batch/d0433458-…        # look at the change
git -C ~/code/my-project merge --ff-only roko/batch/d0433458-…           # take it
```

Lost the answer? `/roko status last` in Hermes shows the same commands. In the desktop app, the run's
**Changes** tab shows the diff and merges it for you (step 7).

## 7. See roko in the desktop app and web dashboard

- **Desktop app**: quit and reopen Hermes, turn **roko** on under Settings ▸ Plugins ▸ Desktop plugins, and
  press **⌘R** to reload the window. A **roko** entry appears in the sidebar and a **roko** chip in the status
  bar. (The entry shows up as soon as you turn roko on, but its page loads only after the reload.)
- **Web dashboard**: run `hermes dashboard`; it opens `http://127.0.0.1:9119`, where roko has its own tab.

After installing or updating the plugin, restart whichever of the two you use.

Open the roko page and click the run you just made: its display bar (tasks, time, spend, checks, model), its tasks as
pads, and on **Changes**, the diff with **Merge into main**. The header says **LIVE** while the page is connected to the
live stream. Try **new run** next (⌘⌥R): ask for something small, cap it at $0.50, and watch it run.

![The roko page in the desktop app, in the roko theme: the run list, the display bar, the ticker and the sequencer](images/desktop-run-live-light.webp)

Two more things to try in the desktop app: the `roko` theme (Settings ▸ Appearance, or **use the roko theme** under
Settings ▸ Plugins ▸ roko), and the monitor pane ("roko: Monitor pane" in the command palette), which follows the newest
run beside your chat.

## Next

- [Using roko from Hermes](using-roko.md): everyday tasks, with examples.
- [Reference](reference.md): every command and setting.
- [Troubleshooting](troubleshooting.md): what an error means and how to fix it.

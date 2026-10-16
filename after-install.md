roko plugin installed. Next, in the project roko should work in:

1. `hermes roko init` makes it ready in one command: a key for roko, `roko init`, roko serve, the connection to
   Hermes, the setting runs from Hermes need, and a hello-world demo. It asks before each change (`--yes` answers
   for you; `--dry-run` only looks).
2. Start a new session and ask: "Use roko to run the demo-hello-world plan. Cap it at $0.25."

You need roko itself (`roko --version`). To build it: `cargo install --path crates/roko-cli` in a clone of
roko's repository. If the install above did not say `✓ Plugin roko enabled.`, run `hermes plugins enable roko`
first.

To see roko in the desktop app, turn on its Desktop switch in Capabilities ▸ Plugins (Settings ▸ Plugins ▸
Manage plugins leads there). If the app was open while you installed, quit it with ⌘Q and open it again first:
Hermes loads plugins when it starts. In the web dashboard, restart `hermes dashboard`; roko has its own tab.

`hermes roko doctor` checks the connection and says what to fix. The full guide is
`docs/getting-started.md` in the plugin's folder.

**Updating.** `hermes plugins update roko` changes the files on disk only. Hermes keeps running the version it
started with, and says nothing about it. To finish an update:

- desktop app: quit Hermes with ⌘Q (closing the window is not enough) and open it again;
- web dashboard: stop `hermes dashboard` and start it again;
- messaging gateway: `hermes gateway restart`.

Until then the roko page shows a RESTART banner with these steps (the desktop app's has a key that restarts
Hermes for you), and `hermes roko doctor` reports it. See `docs/updating.md`.

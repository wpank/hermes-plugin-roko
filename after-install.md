roko plugin installed. Next:

1. `hermes plugins enable roko` (skip this if you installed with `--enable`)
2. Start roko serve in the workspace roko should work in, for example `roko serve --workdir ~/code/my-project`
3. `hermes roko setup --workdir ~/code/my-project --mint`
4. Start a new session and ask: "Use roko to … Cap it at $1."

To see roko in the desktop app, quit and reopen it, turn roko on in Settings > Plugins > Desktop plugins,
and press ⌘R. In the web dashboard, restart `hermes dashboard`; roko has its own tab.

`hermes roko doctor` checks the connection and says what to fix. The full guide is
`docs/getting-started.md` in the plugin's folder.

roko plugin installed. Next:

1. `hermes plugins enable roko`
2. Start roko serve in the workspace roko should work in, for example `roko serve --workdir ~/code/my-project`
3. `hermes roko setup --workdir ~/code/my-project --mint`
4. Start a new session and ask: "Use roko to … Cap it at $1."

`hermes roko doctor` checks the connection and says what to fix.

# roko for Hermes: documentation

roko for Hermes lets you ask Hermes to do coding work through [roko](https://github.com/wpank/roko). roko
runs each piece of work as a checked task: an agent makes the change on its own branch, and your project's
checks must pass before roko calls it done. You review the branch and merge it.

```
you ──► Hermes ──► roko ──► an agent changes your project on a branch
                     │      your checks (build, tests, lint) must pass
                     ◄───── Hermes reports: verdict, cost, branch, how to merge
```

| Read | When |
|---|---|
| [Getting started](getting-started.md) | You're setting it up: install, connect, first task. About five minutes |
| [Using roko from Hermes](using-roko.md) | You want examples: asking, planning, checking runs, answering what a run waits on, merging |
| [Reference](reference.md) | You need a command, a setting or a file location |
| [Troubleshooting](troubleshooting.md) | Something failed, or the doctor shows a ✗ |
| [UI API](ui-api.md) | You're working on the desktop or dashboard pages |

The quickest version, once roko is installed (see Getting started):

```bash
hermes plugins install https://github.com/wpank/hermes-plugin-roko --enable
cd ~/code/my-project && hermes roko init    # roko's key, roko.toml, roko serve, the connection, a demo
hermes                                      # "Use roko to … Cap it at $1."
```

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
| [Getting started](getting-started.md) | You're setting it up: install, connect, first task. About ten minutes |
| [Using roko from Hermes](using-roko.md) | You want examples: asking, planning, checking runs, answering what a run waits on, merging |
| [Reference](reference.md) | You need a command, a setting or a file location |
| [Troubleshooting](troubleshooting.md) | Something failed, or the doctor shows a ✗ |
| [UI API](ui-api.md) | You're working on the desktop or dashboard pages |

The quickest version, once roko is installed and your project has an API model (see Getting started):

```bash
cd ~/code/my-project && roko init           # then set allow_without_data_llm = true in roko.toml
roko serve                                  # leave it running
hermes plugins install file:///Users/you/code/hermes-plugin-roko --enable
hermes roko setup --workdir ~/code/my-project --mint
hermes                                      # "Use roko to … Cap it at $1."
```

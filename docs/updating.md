# Updating roko for Hermes

An update has two steps: get the new version, then restart whatever Hermes you have open. Hermes loads a
plugin when it starts, so until you restart, you keep seeing (and running) the old version.

## 1. Get the new version

```bash
hermes plugins update roko
```

This pulls the newest commit from wherever you installed the plugin (a folder or a git repository). Hermes
prints `✓ Plugin roko updated.`, and nothing else tells you that the app you have open still runs the old
version. That is step 2.

The plugin asks Hermes to prepare no Python environment for it (`python_runtime: external`: its one dependency,
httpx, ships with Hermes), so an update only swaps its files and asks no questions. For an install from before
that change, the first update takes the plugin out of Hermes' Python environment; the plugin keeps working.

## 2. Restart what you use

| You use | Do this |
|---|---|
| The desktop app | Quit Hermes with **⌘Q** and open it again. Closing the window is not enough: on macOS the app, and roko's backend inside it, keep running |
| The web dashboard (`hermes dashboard`) | Stop it (Ctrl-C in the terminal where it runs) and start it again, then reload the browser tab |
| A messaging gateway (Telegram, Slack, …) | `hermes gateway restart` |
| `hermes` in a terminal | Start a new session. Each `hermes` loads the plugin fresh |

In the desktop app the roko page does the first row for you: its restart banner has a **restart hermes** key.
It asks first, then quits Hermes and opens it again, the same in-place restart Hermes offers after an app
update of its own. A chat that is answering at that moment stops there; your chats and roko's runs are kept
(runs belong to roko serve, which keeps going).

Then check: the roko page shows no restart banner, and the status-bar chip no RESTART tag.

## How the roko page tells you

The roko page in the desktop app and the web dashboard compares three things: its own version, the version of
roko's backend that Hermes loaded, and the version installed on disk. When they differ it shows a banner:

```
RESTART  roko 0.7.2 is installed, but Hermes is still running 0.7.1.
         1. Quit Hermes with ⌘Q. Closing the window is not enough: the app keeps running.
         2. Open Hermes again.                                        [restart hermes]
```

The first time a window notices, Hermes also shows a notice with an **Open roko** key, wherever you are in
the app. The banner stays on the roko page, a short form of it sits beside the chat (the monitor pane), and the
status-bar chip carries a RESTART tag. In the web dashboard the banner names the dashboard's own steps.

`hermes roko doctor` reports it as an `install` line while the desktop app's copy of the page is older than the
install. It runs in a process of its own, so it cannot see the app's backend: after ⌘R or a rescan the page is
new and only the page's banner knows the backend is not.

The banner arrived after 0.4.0, so a page from 0.4.0 or earlier can't show it. When you update **from** one
of those versions, restart anyway.

## Why the shortcuts don't finish the job

The desktop app runs two parts of the plugin. Each has its own way of going stale.

- **The page** is a copy: Hermes copies `plugins/roko/desktop/plugin.js` to `desktop-plugins/roko/` and runs
  the copy. It refreshes the copy when the app starts, on ⌘R, on ⌘K **Reload desktop plugins**, and on
  Capabilities ▸ Plugins ▸ **Rescan**.
- **The backend** (the Python routes the page talks to) is imported once, when the app's backend process
  starts. Nothing reloads it short of quitting the app.

So ⌘R, **Reload desktop plugins** and **Rescan** give you the new page against the old backend. The page then
shows the restart banner, and keys that need a newer backend say so instead of failing. When it is the other
way round (the backend is newer than the page, which happens when the app restarted its backend but kept the
window), the banner offers **reload window** instead: ⌘R is enough there. Two more that look
like they should help but don't:

- ⌘K **Restart gateway** restarts the messaging gateway, not the app's backend.
- `hermes dashboard --stop` stops every Hermes web server it finds, which can include the desktop app's own
  backend. Prefer quitting the app.

## If the page stays old after a restart

Look in `~/.hermes/desktop-plugins/roko/`. If there is no `.hermes-package.json` next to `plugin.js`, Hermes
treats the folder as one you made by hand and never replaces it. Delete the folder and restart Hermes; it
copies a fresh one from the installed plugin.

```bash
ls -a ~/.hermes/desktop-plugins/roko/      # no .hermes-package.json?
rm -r ~/.hermes/desktop-plugins/roko       # then quit Hermes (⌘Q) and open it again
```

(Use your `HERMES_HOME` instead of `~/.hermes` if you set one.)

## Updating roko itself

The plugin and roko are separate. After you update or rebuild roko, restart `roko serve` in your project: a
running serve keeps the binary it started with. (A change to `roko.toml` needs no restart for the setting
that lets runs from Hermes through; roko reads it on the next run.) When roko serve is older than the plugin
expects, the setup module says so and shows the command to run.

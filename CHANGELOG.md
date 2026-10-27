# Changelog

## 0.8.0 — unreleased

For long builds that take many plans. Made while roko built Metakosmia Undertow, a VST3 synth, phase by phase from a
Hermes chat. This release is what that build needed from the roko pages and the chat: the whole build in one view,
plans that run only when they can pass, where each run's time and money went, and a chat that asks roko for the work
exactly, under a cap it names, and then hands the run back.

- **The Build tab.** A project whose specs name phases (`docs/specs/phase-<n>-<slug>.md`, sub-phases such as
  `phase-2.1-<slug>.md` too) gets a Build tab on the desktop and the dashboard once it has two phases.
  - Each phase is a pad, in order: passed, running, its plan being written, stopped, written or only specified, with
    a dot per task, its spend, its time (all its runs, resumes included) and runs, and a small ladder. A passed
    phase's pad shows the first UI shot its work made, the synth's editor for Undertow. Once two or more phases
    have one, the shots move from the pads into a reel above them, in phase order, each with its phase's name,
    spend and time as on its pad; a phase without a shot is left out. A pad opens its latest run, its plan writing
    or its plan.
  - NEXT says what moves the build, and its key does it: plan a phase, write its plan again, run it, or resume it.
    When tasks ran out of rungs, it says to split or replan them before a resume. A plan written after a phase's
    run stopped, and never run, is the one NEXT runs, rather than resuming the plan that stopped. Planning a phase
    sends roko the phase's spec by its path, titled "P2 · …" so the plan is found as phase 2. A phase whose plan's
    branch was merged into the project's main by hand reads "merged by hand", counts as built, and NEXT moves on. A
    plan edited by hand after roko counted its checks goes by the plugin's own count, so NEXT no longer asks to write
    again a plan the edits fixed.
  - The money is roko's own ledger, by plan id, so it matches roko's books, plan writing included. The receipt puts
    the passed phases at the top rung's list prices beside what roko really spent, failed runs included: "2 phases
    built so far on claude-sonnet-4-6 ≈ $5.69 · roko spent $3.65: 1.6× less". Under it, the landed work on the
    ladder, from roko's records: "landed work by the rung it passed on: mid 26, strong 7 · 27 of 33 passed on the
    first try · 1 climb". Beside the build's numbers, two sparks by phase, labelled plainly: "cost per verified task,
    by phase" (a phase's whole spend, failed runs and plan writing too, over the tasks roko verified) and "first-try
    rate, by phase" (all its runs' tries), each with its range, and every phase's figure on hover.
- **Only plans that can pass are run.**
  - A spec's acceptance check counts as run only when a plan step runs exactly its command, or exactly a ` && ` join
    of spec commands. A guard in front of it does not count: in phase 2, roko counted a plan "24 of 24 checks kept",
    but each step was `grep -q … && tools/spec.sh …`, and one guard could never pass.
  - A pad shows roko's own count ("checks 24/24 kept by roko") and, in orange, where the plugin's count disagrees
    ("≠ 0/23 run"). NEXT then says to write the plan again. It offers to run a plan only when both counts keep every
    check.
- **Asking roko for a plan.**
  - `roko_plan_generate` takes `spec_path`, a spec file in the project that roko reads exactly, so the chat never
    rewords or summarizes it. Asked to "plan phase 0", the chat used to send "Create a roko plan for a macOS VST3
    synthesizer …", and roko planned five tasks of planning prose.
  - A plan's title goes to roko as its title, never as the request's first words. The tool asks for the work to
    build, not for a plan.
  - The plan sheet shows what was asked: the spec roko read, and the chat model's words as Hermes sent them, or yours
    from the page. It also lists roko's validator notes, in roko's own words, with their codes, and what roko
    changed in its planner's draft before it validated it ("roko repaired the draft": a files path the project
    lacks, a guard in front of a spec's command).
  - A cap on what writing a plan may spend (`max_usd`, also in the composer) is sent only to a roko that keeps it.
    roko's answer names the cap that applies, yours or its `[authoring] max_generation_usd`, and the chat tells you.
    It stays in view once the plan is written ("$0.04 of $0.50" on the writing's line and the plan sheet), and the
    chat keeps it apart from the run's own cap, which it suggests from roko's estimate.
  - A written plan's spend is roko's ledger's, as on the Build tab: it includes the call roko makes after the
    planner, its episode distiller ("$0.20 of $0.50 (incl. $0.03 after the planner)"). A plan written twice under
    one name shows each writing's own share. The writing's row in the Runs list shows it too, where it read "—"
    once the writing ended.
  - The chat sums up a plan's checks by count ("T1 runs 4 checks"), never by retyping the commands: a retyped list
    dropped some.
- **Watching a run.**
  - The Ladder holds a whole phase: each task on the rung that ran it, cheap models first and a rung up only after
    failed tries (✕). A provider's refusal (∿) is not held against a model, and a failover (⇄) is not drawn as a
    climb. A rung where tasks ran out of rungs gets one "split or replan" stamp, and a task not started yet waits on
    its tier's start rung. An ended run's ladder is the one it ran on, as roko recorded it, with what each rung
    spent; a live run's is roko.toml as it is now, and each says which.
  - Build glass: a check's raw output reads as an instrument. A C++ build is a meter with its stage and the failing
    file and line ("69 % COMPILING test_duck … 1 unit · 0 warnings"); a test run is pips by name with the one failing
    assertion ("4 of 5 passed · REQUIRE( peak < 4.0f ) · saw inf < 4.0f").
  - The stream ends with the agent's own words as they arrive. With two tasks at work it follows the one whose words
    grew last, held 2 s so it does not flicker.
  - The Time tab shows where a run's time went: each task a lane on the run's clock, each try split into model, tools
    and checks by roko's own clock, the critical path, and the spec gate. Before any agent runs, the horizon counts
    the spec gate's steps ("spec gate · 5/8 steps · 2 cached").
  - The spend moves with each model call, and the run's header, its row and the status chip show one figure, side
    calls included (calls refused before a failover, helper calls, audits). Once a run ends it is roko's own summary's
    figure, the ledger's total, and the receipt compares against it. roko's estimate of the time left counts down from
    when roko made it, with its 90th percentile and what it rests on ("~28 min left, up to 75 · est. 21:15 · from 12
    runs"). Past the median it says "past roko's likely time · up to 47 min left", and past both, "past roko's
    estimate from 21:15".
  - A long run opens on its newest lines and pages back, and its card shows roko's own totals until it has read the
    run whole. With roko's `?skip=`, phase 1's 165,638 events read in 0.5 s, not 33.7 s.
  - A provider that refuses a call for want of credit (z.ai's code 1113, an HTTP 402) or usage, which roko then goes
    on without, is said in roko's own words: under the run's headline, in its stream, and in the chat, which passes
    roko's line on as it is, so you learn your credit ran out ("zai: Insufficient balance or no resource package.
    Please recharge. (code 1113): recharge, or the ladder runs without it until 07:12"). Its rung on the Ladder
    says "⊘ no credit · until 07:12", so the climb past it does not read as the model failing.
  - When roko stops a reply that has only reasoned (past 3/8 of the model's output limit, glm-4.7's 12,288 tokens)
    and asks again, the run's card keeps roko's line for each stop, and the chat hears it from roko_status.
  - A provider that refuses a request reads as one, in its own words: "openai refused the request (HTTP 400):
    Function tools with reasoning_effort are not supported …", where it read "the network failed". A 401 or 403
    adds "(check its API key or account)". Only a real transport error still says the network failed. Such a run is
    not offered a resume, which would send the same request: its next step says a resume would fail the same way
    until roko or its config changes, and the chat does not offer one.
- **After a run.**
  - The receipt names the rung its tasks passed on, and says "via failover" where a failover put them there.
  - Spend a provider refused counts where roko counts it (roko bug-8bcd98): a try's spend includes its calls a
    provider refused before failover, and a rung's spend on the ladder too, with that part under it ("incl. $0.21
    refused"), so spend that bought work and spend a provider refused read apart.
  - A run whose checks changed your own checkout says so (roko bug-b7d9ad): the card lists each try's paths and
    the task whose checks ran, and the chat tells you, naming them. roko left those changes in your checkout and did
    not deliver them; keeping or dropping them is yours to decide, and the chat never runs git on your checkout
    unless you ask.
  - "What it made": the files the run's work put under `artifacts/`. UI shots show whole, WAV renders get a waveform
    and a play key, and pluginval and auval reports show their verdicts. Each file is read from git at the run's
    delivered commit, its type and size checked, past a big delivery's first 30 files too. A shot opens large, with
    its name and size, ←/→ to the run's other shots. In Changes, an image the work added shows as itself. In the
    chat, the run's card shows what roko built, its first shot, and that opens large too.
  - A rung roko skips for a run, its daily probe having failed (a provider out of credit), is drawn as one the run
    cannot use, in roko's words and until when ("skipped until 20:33: its tool-use probe failed: …"), and a task
    that would start on it waits on the next rung that runs, where roko starts it. When every rung is skipped, roko
    refuses the run before any model call, and the card says what works: when every rung failed on its provider's
    billing, "recharge cerebras and zai, then resume" (roko probes a billing failure again on the next run);
    otherwise no resume, which would be refused again until roko's 24-hour probe verdict lapses or its model's entry
    leaves roko's probe file. The Build tab's NEXT says the same for a phase whose run roko refused so.
  - A run roko stopped mid-try (a restart or a crash) offers "resume the plan", and says what a resume does, as roko
    says it since bug-b7f6a8: it continues where it stopped ("only T2 runs, and the $0.02 it spent before it stopped
    counts against its cap"), or roko refuses it and says why, and only starting over, which runs passed tasks again,
    is left (the chat asks you first); an older roko, which could start over, keeps the warning that it may. The chat
    says so too, and resumes it when you ask, at the cap you name, else the run's own, saying which and what the run
    already spent; never unasked. A resumed run counts what it carried from before the restart against its cap ("$0.06
    of $1.00 · $0.02 spent before it resumed, $0.94 left"). Its task that was at work reads stopped, not running, and
    its ladder is the one its tries ran on. A resumed run's receipt and ladder cover the whole run, its earlier
    invocation's tries and rungs included, against all it spent (P-54). A phase's time counts each run's own time,
    never the hours a failed run sat before its resume (P-58): P5.1 read 3h 48m where its two runs took 17m 23s,
    because roko writes a resume into the first run's manifest and the plugin took that manifest's close for the
    first run's end. Once a later run resumed it, it points there
    ("resumed as 92b8071f · passed · merged") and offers no resume, its ladder and spend its own, and its receipt says
    its work continued there ("+5 −5 in 5 files · its work continued in 92b8071f · merged").
  - A stopped plan is never resumed or restarted unasked. The chat asks whether to continue (only the tasks left run)
    or start over, and the Run plan form offers both. A fresh start shows what it set aside ("↺ started over ·
    6988f0b8 set aside") and the command that brings it back. A failed plan run its card offers to resume is resumed
    from the chat too when you ask (P-53): only the tasks that did not pass run, at the cap you name, else the run's
    own; before, only an interrupted run's words taught a resume, so the chat refused it. The chat starts such a
    plan over only on your word (P-57): asked "Run it again.", it started over and set aside a run that had passed
    T1 and spent $0.16, without a word. Now a start over from the chat is refused, before anything is approved or
    spent, until you said "start over" or "from scratch" (`set_aside`), and the refusal names the run, the tasks
    it passed, its checkpoint and what it spent, and offers the resume first. The Run plan form's start over is
    your own choice already, made beside what it sets aside.
- **The chat hands a run back.** Once a run starts, the chat shows its card and ends its turn instead of waiting it
  out. For a plan writing it shows the plan's card, which follows the writing, then shows the plan; an ended writing's
  card says "plan written", as its row and headline do, never "passed". The chat that started a run hears when it
  ends: its next turn leads with the outcome, once. With `run_end_follow_up` on (and Hermes'
  `plugins.entries.roko.allow_gateway_injection`), the plugin also gives that chat one short turn when the run ends:
  one model call per run.
- **The chat answers about the project it is in.**
  - `roko_status` finds a run Hermes did not start (from roko's CLI, another client or another Hermes): it asks the
    chat's project's roko serve first, then every other project Hermes knows whose roko serve runs, and starts none
    to look. Before, such a run was looked up in the default project only, and a run in the chat's own project came
    back "not found". A run no serve has is "not found in any project Hermes knows: searched undertow and ws", with
    the projects whose roko serve is down named too (P-55).
  - The overview `roko_status` gives without a run id is one project's: the chat's, or the one the call names. Its
    recent runs are that project's only, and include runs Hermes did not start, from roko's CLI (`roko run` in a
    terminal) or another client, read from roko's records of them and marked "not started from this Hermes (roko's
    CLI)". Before, it listed the runs Hermes started in every project, and none started elsewhere, so the chat took
    another project's failed run for the one asked about. The answer says whose runs they are and to answer about
    that project unless the person names another, and each thing waiting on the person names its project. A
    missing or unreadable record, or a roko slow to answer, leaves the runs Hermes started (P-56).
- **No page shows your home folder's path.** Answers and live frames show it as `~`, inside build paths too.
- **Smaller things.**
  - The header's spend line fits at 1440 px ("$2.39 held · $15.64 left", the day's limit in its tip), and the header
    names the serve's state first.
  - A plan card lists each task's first check command, so a check that cannot run in the project shows at once.
  - A task's checks are counted whole (P-59): phase 5.2's T1 has five, and the chat's plan card read "4 checks"
    because roko_plans lists a task's first four. The cards count `check_count`, a cut list ends "and 1 more", and
    roko_plans' task row says how many it leaves out (`checks_more`), so the chat does not give four as all.
  - A card line that the chat model put in a code span still becomes its card.
  - A setup problem you have seen folds to one line, unless it stops runs.
  - A run started in another project is read from that project's roko serve, on any project's page, so it no longer
    shows as "planning failed".
  - The run list no longer keeps a long run's half-read totals. 0.6.0 kept phase 1 as 2 of 5 tasks and $0.28, where
    roko said 5 of 5 and $1.02; kept totals are now checked once against roko's.
- **For page and tool authors** (each marked 0.8.0 in docs/ui-api.md):
  - `GET /build`, `GET /runs/{id}/artifacts` and `GET /runs/{id}/artifact`;
  - a try's `timing`, the run card's `spec_gate`, `eta_at`, `eta_p90_minutes` and `eta_basis`, and its `cost_usd`
    while it runs;
  - a plan's `asked`, `validator_notes` and `repairs`;
  - `roko_plan_generate` takes `spec_path` and `max_usd`, and needs no `prompt` with a spec; `roko_plan_run` takes
    `fresh` and `from_run`; `roko_plans` gives each task's `check_count`;
  - a `pre_llm_call` hook, and the `run_end_follow_up` setting.
- **Older roko works, with less.** The newest parts need roko main:
  - `spec_path`: 1ae6cab88;
  - the plan-writing cap: 55d0acda8;
  - per-try timing: 22de26a8c;
  - the live spend: f2ee9a0d3;
  - roko's own kept count: 9f0870e9a;
  - `?skip=` for long runs: 8d02ac126;
  - the time left as a range: bcce6c05c;
  - roko's repairs to a draft: 7c3b523a8;
  - side calls in a run's spend: de778b612.

  With an older roko, the plugin sends the spec's text itself, refuses a plan-writing cap rather than drop it, and
  takes a try's timing from the run's events.

## 0.7.2 — unreleased

- **Desktop chats get roko's per-project guidance again.** 0.7's text about projects made the desktop's prompt section
  about 2,540 characters with any workspace path. That was over the plugin's own 2,500 limit, so every desktop chat
  lost the workspace part. The limit is now 2,800; Hermes allows 4,000 per section. Two tests guard it:
  - a 200-character path keeps the workspace on every platform;
  - the section without a path stays at least 200 characters under the limit.

  Found by the round-v7 session's trial merge.

## 0.7.1 — unreleased

Three fixes from the round's last checks, on top of 0.7.0.

- **A project roko has no model for says so.** Since 0.7.0's round 1, a serve that fails with roko's
  `not_initialized` means roko found no model provider. It does not mean the project lacks a roko.toml. The pages
  called it "not set up" and offered "set up roko here", which does not help. Now:
  - the failed banner shows roko's message, with a copy key for `hermes roko init --workdir …` and "start again";
  - the banner hides the separate `no-model-provider` row;
  - a project without roko.toml still gets `project-needs-setup` and its "set up roko here".
- **Setting a project up names what is left.** When roko still refuses runs from Hermes after `setup-project`
  (`ready: false`), the message names the first thing left, as `next` does. The page shows it. A chat tool's answer
  does not carry setup's outcome yet. A run roko then refuses still names the blocking problem in its own error.
- **A restart never shows the old serve as running.** A `starting` marker now lasts as long as a whole restart can
  take (`RESTART_COMMAND_S + START_WAIT_S`). A marker whose writer died still lapses at once.

## 0.7.0 — unreleased

roko starts with Hermes. Each project gets its own `roko serve`, which the plugin starts by itself when the app
opens, when a page shows the project, or when a chat first uses roko, and the page and chats pick the project per run.
Nothing is left to copy into a terminal.

- **roko serve, started by Hermes** (`serve.py`).
  - Finding roko: the `roko_bin` setting, `ROKO_BIN`, `~/.roko/bin/roko`, `roko` on PATH, then `~/.cargo/bin/roko`.
    The first that has `roko serve --detach` is used; one named by the setting or `ROKO_BIN` is used even when it is
    older, and reported too old. Each binary is run once per file version (`--version`, `serve --help`).
  - Starting: only `roko serve --detach --json --workdir P --idle-exit <idle_exit_minutes × 60>`, with the
    environment the plugin gives roko (no key Hermes holds) and its output in files, never pipes. roko spawns the
    serve in a session of its own, writing to `<project>/.roko/logs/serve.log`, so it keeps running after Hermes
    quits and runs in flight finish; it stops by itself after an idle hour.
  - One start at a time per project across every Hermes process (the desktop backend, a chat, the CLI): a lock file
    and a marker in the plugin's data folder. Every process sees `starting` while one runs, `failed` with roko's reason
    and its log's last lines after one failed (an automatic start waits a minute after that; Start does not), and
    which serve the plugin started (`started_by: hermes`).
  - Looking: `running` only when the serve that answers is the project's (roko's identity: `instance_id` and
    `workdir` on `/health` and in serve.json; an older roko's uptime). Also `starting`, `stopped`, `failed`,
    `outdated` (a serve without `/mcp`, or a roko without `--detach`), `not_found` and `remote`.
  - Stopping and restarting go through `roko serve stop` and `restart` only; the plugin never kills a process. A
    serve with runs going is refused unless the person confirms (`force`). While a restart runs, the project's serve
    is `starting` in every Hermes process, also while the old serve still answers.
  - A tool, `POST /runs` or `hermes roko serve start` that finds a start in flight (the app's, another chat's, a
    restart) waits for it instead of saying roko serve is still starting.
  - A project without roko.toml still gets a roko serve when roko has a model provider (roko runs on its defaults);
    roko's `not_initialized` means it has none, and says so with the fix: a model key.
  - Never at plugin load: `register()` runs in every Hermes process, `plugins validate` included.
- **Projects** (`projects.py`, plugin state `projects.v1`). The `workdir` setting is the default project until the
  person picks another (a changed setting is the default again). A project is a git checkout; a folder inside Hermes'
  home is refused, and two projects with one folder name are told apart by their parent folder.
  - A project's URL always comes from its serve.json; nothing falls back to `127.0.0.1:6677`, and setup never saves a
    URL on this machine. A `url` on another machine, or `ROKO_URL`, pins one roko serve: one project, nothing started.
  - Hermes talks to a local project's roko serve with the project's launch token, read afresh for each client (no key
    to make); a refused token falls back to the configured key.
  - Clients, setup looks and overviews are kept per project. Each run Hermes starts records its project and its
    serve's URL; a run's card, events, diff, merge, cancel and decisions go to that project's serve (runs from before
    0.7.0 belong to the default project).
- **Tools**: `roko_run`, `roko_plan_generate`, `roko_plan_run`, `roko_plans`, `roko_recall` and `roko_status` (without
  a run id) take an optional `project` (a folder, or a known project's name). Without it: the chat's own folder when
  roko knows it (a known project, or a git checkout with a roko.toml; never Hermes' folder), else the default project.
  Every answer names the project. Before its first roko call a tool starts the project's serve if it is stopped,
  keeping Hermes' activity heartbeat going and returning at once if the person interrupts. In a git checkout without
  roko.toml it asks the person first, then runs `roko init` and roko's `config preset chat-host` (or the plugin's own
  fix) there, committing nothing. A project it cannot use answers with the projects roko knows, for the model to ask.
- **UI API** (docs/ui-api.md, "Projects and roko serve"):
  - `ServeState` and `Project`; `GET /projects` and `POST /projects {add | remove | set_default}`; `POST /serve
    {ensure | start | restart | stop}` (a busy restart or stop is a `conflict` that names the runs, with `serve`);
  - `?project=` on `/overview`, `/plans`, `/plans/{id}`, `/learning`, `/insights`, `/loops`, `/knowledge`,
    `/estimate`, `/pending`, `/effects`, `/health`, `/setup/fix` and `WS /live`; `project` in the body of `POST /runs`,
    `POST /plans/{id}/run`, `POST /setup/fix` and `POST /serve`;
  - `/overview` adds `project`, `projects` and `connection.serve`, and starts a stopped serve in the background;
    `connection.url` is null while no serve runs; runs and cards carry `project: {path, name}`. Its `runs`, `counts`
    and `spend` cover every project Hermes started runs in, and `pending` every project whose serve runs (each item
    names its project; a serve that is down is skipped, never started to read it); `connection`, `setup` and `ladder`
    stay the chosen project's;
  - the live channel sends a `serve` frame whenever a project's serve changes state, seen within about 2 s whichever
    Hermes process changed it;
  - fixes `setup-project`, `start-serve` and `restart-serve`, and `project` on a problem's fix.
- **Setup problems**: `roko-unreachable` is an action (`start-serve`) when the plugin can start roko, and says
  `starting` or why the last start failed. New: `roko-not-found` (install roko), `roko-too-old` (the update line),
  `no-model-provider` (roko found no model provider, so its serve did not start: `hermes roko init --workdir P` offers
  the key Hermes has) and `project-needs-setup` (roko isn't set up for runs from Hermes in a project without roko.toml:
  `setup-project`). A `/mcp` that answers 404 counts as a roko serve too old for the plugin, with `restart-serve` when
  the roko binary is newer.
- **CLI**: `hermes roko serve [status|start|stop|restart] [--project P | --all] [--force] [--json]` and `hermes roko
  projects [list | add P | remove P | default P]`. `hermes roko init` finds roko with the same rules, refuses one too
  old to start roko serve (with the update line), starts roko serve the one way the plugin does, and makes the project
  the default; it no longer mints a key or saves a URL. `hermes roko setup` saves the project, never a URL on this
  machine (a `--url` here finds the project roko serve says it runs in).
- **Settings**: `auto_start` (true), `roko_bin` ("") and `idle_exit_minutes` (60). `url` has no default any more and is
  only for a roko serve on another machine; `workdir` is the default project.
- **Doctor**: a `project` check names the project and where its serve listens; using a project's launch token is no
  longer a warning.
- **The live relay** follows the hub of the default project's roko serve; a run in another project gets its card and
  timeline re-read every 3 s. A socket's `?project=` picks whose overview its frames carry.
- **Tests**: `tests/test_v07_serve.py`, `tests/test_v07_projects.py`, and a fake roko (`tests/fake_roko_cli.py`) that
  plays `serve --detach`, `status`, `stop`, `restart` (with roko's `busy`, `unresponsive` and `failed` rows and exit
  codes), `--idle-exit`, `roko.lock`, the identity fields, a project without roko.toml with and without a model
  provider, a roko without `/mcp`, one without `--detach`, one whose serve fails to start and one with runs going. The contract lane
  (`tests/contract/test_live_serve.py`) starts, restarts and stops a real roko serve through the plugin in a scratch
  HOME and project, and checks a real idle exit.
- **Pages** (desktop and dashboard):
  - roko serve's state appears wherever the connection does: a banner at the top of the page, the header, the chip,
    the sidebar row (`roko · starting`), the monitor pane, the dashboard's strips, the landing card and the settings
    page. A screen-reader status announces each change once. The banner shows:
    - starting: the dot-matrix word and its clock;
    - stopped: `start roko serve`;
    - failed: why, `start again`, and the log's last lines;
    - outdated and not found: the fix to copy.
  - The keys come from `serve.actions` (start, restart, stop) and are hidden without write permission. A restart or
    stop that would stop runs asks first and names those runs.
  - Projects are chosen in two places:
    - a switcher in the header (desktop) or the tab row (dashboard);
    - `00 PROJECT` in the composer: `choose folder…` opens the system folder dialog on the desktop, and the dashboard
      takes a path.

    A checkout roko is not set up in offers `set up roko here` (the `setup-project` fix, preview then apply). With no
    project yet, the page says so, and the composer is where one is picked. Each window remembers its choice.
  - Once there are two projects, runs and waiting items name their project, and Waiting gathers sign-offs from every
    project whose serve runs.
  - Opening the app (desktop) or loading the page (dashboard) asks the backend to start the default project's roko
    serve.
  - An older backend gets 0.6's pages: every 0.7 piece is feature-detected.
  - Tests: desktop vitest 209 (12 under `0.7 serve and projects`), dashboard 156 (11).
- **roko** (its own repository, the same round): `roko serve --detach [--json] [--idle-exit SECS]` and
  `roko serve status | stop | restart [--all]`, an automatic port, a serve that proves which project and build it is
  (`instance_id`, `git_sha` on `/health` and in serve.json), clean shutdown on SIGTERM and SIGHUP, and a registry of
  running serves. The plugin needs a roko with `serve --detach`.

## 0.6.0 — unreleased

roko's pitch, as things on screen: the model ladder a task climbs when its checks fail, a receipt of what a run cost
against the same work on the top rung, and learning that shows in the numbers. Redesigned to spec v3, with every
number held to what roko's data supports, and reviewed line by line before commit.

- **Design (spec v3)**: each surface is one instrument made of two materials. The body follows Hermes' theme
  (numbered modules, keys, the cap knob, LEDs). Inside it sits a phosphor glass, where light follows significance.
  - Five channel colours, each meaning one thing: an agent is working, a check passed, a check failed, roko needs
    you, roko learned something.
  - One bone number per screen.
  - On the desktop, the run's instrument replaces 0.5.0's six-module display bar. It has four corner readouts
    around the run's spend, an erosion meter, and L0 along its edge.
  - Three tabs on both pages: Runs, Plans and Learning. Waiting is a badge (and the `w` key on the desktop). Loops,
    lessons and models are Learning's views.
- **The Ladder**: the workspace's model ladder (roko.toml `[routing.ladder]`), cheapest first.
  - It appears in full in the run view, as a mini ladder on run rows and in the status chip, as a column in the
    desktop's monitor pane, and as a strip on the desktop's chat card and the dashboard's chat and Sessions strips.
  - Each task sits on the rung it runs on, with its lives (`✕ ✕ ●`). ⌈CLIMBED⌋ marks a climb. A task that failed on
    the top rung it can reach says ⌈SPLIT OR REPLAN⌋.
  - The composer says the rule: "2 failed tries → a rung up, at most to <rung>".
  - New card fields: `ladder` and `rungs`, and per task `climb`, `lives`, `exhausted` and `check_tail`.
  - Each try is placed on its rung by roko's verdict on it, read from the run's record in the workspace
    (`.roko/runs/<run>/attempts.jsonl`) when the plugin shares roko's `workdir`. Otherwise it is placed by the run's
    events.
- **A task's tries**: from its pad, a task opens with each try on its rung, what ended it, and its check's output.
  - On the desktop it is a sheet: ↑↓ pick a try, C copies the key line, O shows all of the output, Esc closes.
  - The sheet also shows the lessons in each try's prompt, and what a failed try's check told the next one.
  - A try's check output is always that try's own. A try that ran no check, such as one the cap stopped, shows none.
- **The Receipt**: a run that ended gets one strip saying where its work passed on the ladder and what it cost.
  Beside it is an estimate of the same work on the top rung (see "Numbers" below).
- **Learning** (`GET /learning`): a Learning view on both pages.
  - The hero numbers: cost per verified task, the first-try rate and climbs per run.
  - Where work passed on the ladder, run by run.
  - The lessons that paid off.
  - The first try with a lesson and without.
  - roko's own cost per verified task, M1's homeostat, and an orrery of roko's five loops.
  - Two scopes: the runs started from Hermes, or every plan run in roko's workspace (from its run records). A
    coverage note says where the numbers rest on less.
- **The stream**: the run view streams the tool calls, the agents' words and each check's own lines as they happen
  (roko's `gate_output_line`).
  - Between tries it keeps the check that failed.
  - It is bounded per task and per run, and has a "jump to latest" key.
  - It keeps following a check's output as it grows. On the desktop only the person's own scroll (a wheel, a touch, a
    key or a drag) holds it, and reaching the foot again lets it follow.
  - The desktop adds the horizon: the live step, on one line of glass.
- **Ceremony**: first times play as a moment and repeats go quiet. That covers a run's end, a climb, a lesson, a
  lesson that paid off, a merge and a plan. The counts are kept per roko serve, in the page's own storage.
- **Plans read as documents** (`GET /plans/{id}`). The sheet shows:
  - plan.md (condensed) and rubric.md;
  - each task's acceptance criteria, with the checks that cover each one, and the whole-plan check;
  - what became of each check the request's spec states: kept, cannot run as written (roko gap-ecafde), shallow,
    dropped with the plan's reason, or missing. The line is orange when a check is missing or cannot run.
  - from `roko plan import --mori`: imports gather under "From mori", and a task's "also required · not checked
    automatically" list shows under its criteria and in its own panel. The list shows at most 20 lines of 600
    characters. Longer blocks keep their other lines in the task's description, counted as `also_required_more`, so no
    line is lost;
  - roko's own estimate (R7): each task's start rung, likely and worst cost; for the plan, its likely and worst cost,
    "worst $X for the priced tasks · N tasks unpriced" when there are any, and its cap, with "the worst case is over
    the cap: roko stops at $C" in orange; what the estimate rests on (similar past tries, other tasks' tries, or
    roko's defaults), and "low confidence" when roko says so.
- **The composer** shows where a request would start before it runs (`GET /estimate`): its start rung and how far it
  may climb, about what it will cost and how long it will take, the most it can spend within the cap, how similar
  runs went, and the checks roko will run on it. Nothing is spent.
- **Numbers that don't overstate** (decided in review):
  - The Receipt's top-rung figure is a conservative counterfactual.
    - It is always shown with "≈" and with its basis on a line of its own.
    - Each passed task's passing try is priced at the top rung's list prices, and helper calls at their real cost.
      Tasks that never passed are left out and counted.
    - It reads "N× less" from a ratio of 1.25, "about the same" from 0.8, and otherwise "the climb cost more this
      time".
    - From an older roko it prices the run's totals, labelled "failed tries included".
  - Cost per verified task is the total cost over the total verified tasks. Failed runs are included.
  - The first try with a lesson and without shows both counts. It gives a difference only from 5 tasks a side, and
    says whether roko's control arm made it a randomised comparison or it is observational.
  - The climb row says "N failed checks" only when every try on that rung failed its check. Otherwise it says what
    each try ended on.
  - `GET /estimate` takes the request's length (`chars`), never its words. For this release an older caller's
    `prompt` is still accepted, and read for its length alone.
  - roko's forced accept (a judge accepted a try whose check failed) is never counted as a pass.
  - Turning on roko's learning no longer promises that every matching lesson is in every prompt.
  - The today counter says whose spend it counts: "$0.42 from Hermes · $0.98 in roko today", with roko's figure taken
    from roko's own daily ledger.
- **The chat leaves roko's work to roko**:
  - The skills, the prompt section, the tool descriptions and every answer while a run goes tell the chat model three
    things: not to edit the project's files or run its checks in roko's place, to cancel only when the person asks,
    and to wait and report however quiet the run looks.
  - After a stop, a failure or a refusal, they tell it not to do the work itself unless asked.
  - In 8 live replays of one request, the first version failed once in 3: after roko stopped at its cap, the model
    wrote the file itself. With the fix, 5 of 5 passed.
  - `docs/using-roko.md` says these are instructions to the model, not locks, and what alone makes them certain.
  - `roko_status` adds `live`, built from roko's events, which stay current when its summary lags:
    - what each task does now: its try, model and rung, its tool steps and the last one, and how long the try has run;
    - the run's spend, and how long roko has been quiet.
  - It also adds the model each try ran on, from roko's route and verdict.
  - A stop at the cap or the daily limit tells the model how close each stopped task came: the rungs it tried, and how
    each try ended.
  - `roko_cancel` takes the person's reason. A cancel from the chat or from a page shows on the run's card, for
    example "cancelled from chat: <reason>", above roko's own summary.
  - The prompt and the skills name the guides as Hermes' `skill_view` takes them: `skill_view("roko:delegate")`,
    `"roko:plan"` and `"roko:decide"`, with no "plugin:" prefix.
- **Chat cards on the desktop no longer depend on the model**:
  - A run or plan writing that a turn started gets its card line (`::roko-run{id="…"}`) when the reply leaves it out,
    through Hermes' `transform_llm_output` hook.
  - A card the model already showed is never repeated. That covers one in the reply, by the desktop's own rules for
    drawing a card, and one in its interim text beside a tool call (`on_interim_message`).
  - In a turn where roko ran, an escaped price (`\$0.25`) loses its backslash, outside code and math. Other chats are
    never touched.
  - The three turn hooks (`transform_llm_output`, `on_interim_message`, `on_session_end`) are registered on Hermes
    0.22+, which gates them per turn, and are declared in `provides_hooks`. No tool-call hook is registered unless the
    opt-in learning guard is on.
- **Setup, keys and reaching roko**:
  - **A key saved while Hermes runs**: when setup or init saves a new key, a Hermes that was already open swaps to it
    the first time roko refuses the old one, and retries once.
    - The refusal is a 401, so roko ran nothing.
    - This covers only the key from Hermes' settings, and no key is logged.
    - Setup and init say when an open Hermes still holds an older key.
  - **One failed look is not OFFLINE**: roko serve reads unreachable after two failed looks at least 1 s apart. One is
    enough when roko's last good answer is over 30 s old, or when the live stream to roko failed too. A late answer
    or a 429 reads "slow".
  - **Paced requests**: requests to roko are paced at most 25 a second. A 429 waits as roko asks (at most 2 s) and is
    sent once more, and so is a request whose connection could not be made. Overviews asked at once share one build.
  - **Back quickly**: while roko is out of reach, the desktop looks again every 2.5 s for the first minute, so a serve
    just started shows within seconds.
  - **Learning on**: with the person's yes, `hermes roko init` turns on roko's learning. The checks' thresholds then
    update after every run, and the prompt section that carries lessons is never dropped. Dreams, the daimon and the
    self-model's control stay off. `hermes roko doctor` says whether learning is on.
  - **More on a card**:
    - A plan run that resumed another shows the plan's runs together, with their total cost.
    - "Resume the plan" is the next step for a plan run whose tasks did not all pass.
    - When roko's summary of a run lags its events (roko bug-e529e3), the card follows the events.
    - A run resumed under its own id (roko's checkpoint resume) reads as running.
- **Accessibility** (spec §8):
  - The stream logs are not live regions. A hidden status says the newest move, at most once every 2 s.
  - What changes every second is not re-read. The horizon, the monitor's ticker and the dashboard's now strip are
    marquees, and a clock inside a status is a timer. The dashboard's chat card and Sessions banner say their state at
    most every 2 s, never their clock, their spend or the agents' words.
  - The desktop gains a `prefers-contrast: more` rule: content leaves the dim ramp, and hairlines become 1.5 px.
  - Under reduced motion the climb is an instant move, nothing types or sweeps, and sounds play only on the person's
    own actions.
- **Security**:
  - The plan sheet reads plan.md in linear time. In review, a heading with a long run of spaces took the first
    version's heading pattern cubic time, holding a worker thread of Hermes' web server for minutes.
  - A plan.md, a rubric.md or an import's header that links to a file outside the workspace is not read.
  - Text from roko and its agents stays text on every page. Inline markdown draws only text and code, and a link shows
    only its words.
  - `GET /estimate` takes only a plain count (`chars`, at most 8,000) and refuses anything else as invalid.
- **Docs**:
  - `docs/ui-api.md` documents the 0.6.0 routes and fields.
  - `docs/using-roko.md` says what the plugin tells the chat model, and that it is an instruction, not a lock.
  - Troubleshooting covers a Hermes that holds an older key.
- **roko**: tested against roko main cc69556c2 (2026-10-18). It uses:
  - its per-try verdicts (`.roko/runs/<run>/attempts.jsonl`, `attempt_settled`);
  - `prompt_assembled` and `retry_feedback`;
  - streamed check lines;
  - `ladder_exhausted` and `route_decided`'s `ladder_reason`;
  - its per-task plan estimate;
  - `cannot_run` source checks;
  - `efficiency_trend_updated` and M1's homeostat;
  - its daily ledger.

  An older roko gets sensible fallbacks.
- **Tests**:
  - The full suite passes 1,016 (838 in 0.5.0).
    - Within it, the desktop's vitest lane runs 197 tests (139), and the dashboard's jsdom lane runs 145 (105).
    - The contract lane passes 5 against roko main cc69556c2.
  - New recorded fixtures:
    - a real cheap ✕ ✕ → mid ✓ climb (`climb_runs.json`);
    - a try that spends its rung's allowance (`climb2_runs.json`);
    - receipts, learning and the stream;
    - the round's dogfood runs;
    - a mori import (`plans/pocket-sequencer`).

## 0.5.0 — unreleased

What a person actually meets: a setup that tells the truth and fixes itself, updates that say when to restart,
runs that end honestly, and a chat model that reports roko's problems instead of repairing them. Built from a
replay of a real first session (the plugin updated under a running app, a workspace that refused every run from
Hermes) and a newcomer's walk through the docs, then reviewed line by line.

- **One command**: `hermes roko init` makes a project ready. It covers roko itself (`roko init`, `~/.roko`, a key copied
  from Hermes with mode 600) and the chat-run setting (roko's own `config preset chat-host` when it has one). It adds
  an API model with prices, so caps hold, and commits `roko.toml` so Merge isn't blocked. It starts roko serve, or
  writes a `--launchd` login item, connects Hermes and adds a hello-world demo. It asks before each change and skips
  what is already right; `--dry-run` changes nothing.
- **Setup problems, with their fix, everywhere**: `/overview` and `/health` gain `setup` and `install`. The desktop
  page, the monitor pane and the dashboard show a numbered setup card with one key per problem.
  - `GET` and `POST /setup/fix` preview and apply "make ready". roko picks it up without a restart, and the card says
    to commit `roko.toml` and offers to.
  - `hermes roko setup`, `hermes roko doctor` and `/roko doctor` use the same words.
  - The problems are: restart-hermes, workspace-refuses-chat-runs, no-tool-loop-model, roko-serve-outdated,
    roko-unreachable, key-read-only, approvals-off and no-priced-model.
  - With no priced model for runs from Hermes, `hermes roko init` can add one on a new last ladder rung,
    `priced`, which capped runs use. The person's own rungs, and where terminal runs start, stay as they were.
- **Updates**: the plugin notices when Hermes still runs an older copy of it, its desktop page or its backend, and
  says so. A RESTART banner offers a key that relaunches Hermes in place. Every plugin module is imported at load, so
  an update on disk can't mix versions inside a running process. See `docs/updating.md`.
- **Install**: `python_runtime: external`, so `hermes plugins install --enable` no longer stops on a default-No
  dependency question. Hermes' own interpreter already carries the one dependency, httpx.
- **Runs end honestly**, each with one next action:
  - interrupted: roko stopped mid-run; its reason is shown, the cap is released and the kept work can be reviewed.
  - unverified: no check ran; the work stays on its branch, and merging it asks again.
  - partial: the verified tasks of a plan that did not finish.
  - demo output: never offered for Merge.
  - checking: roko's whole-plan checks as they run ("checking the workspace: cargo clippy (2 of 3) · 1:12").
  - last seen running: roko serve is offline.
  - a failed start: with roko's own reason, kept under the run's id.
  - stopped at the cap: a run roko's cap, the Claude CLI's own spend limit or roko's daily limit stopped reads
    "stopped · cap" or "stopped · day limit", not failed. Why names the limit and what was spent, what passed is
    kept. The next step opens new run with a higher cap filled in, held to the plugin's per-run limit, and starts
    nothing until the person presses Run. Hermes' notice and `/roko status` say stopped, not failed.
  - cannot run yet: a plan roko wrote but will not run lists its findings and open questions.
  - delivery: each plan's delivery reads delivered, conflicted, failed its check, or stopped by a cancel. A check
    a cancel stopped reads as stopped, not failed.
  - passed with failures that were already there, and skipped by a condition, count as what they are; every
    outcome has a symbol in `/roko status`.
- **Panels that tell the truth**:
  - The route panel says what picked the model (a ladder rung, the learned router, a pin), and folds away the models
    the run cannot use.
  - Lessons and loops are in plain words, shared by both pages and the live feed. A test keeps them from drifting.
  - Insights says whose numbers it shows and over what period, and no longer counts "no check ran" as a failure.
- **Plans**: the demos come first, "Start here: hello world demo" is opened, and no real plan is preselected. The
  composer can run an existing plan, and titles replace ids.
  - Writing a plan shows what roko's planner is doing (planning, retrying, writing), with its clock and spend,
    and its cost counts toward the day's spend.
  - roko's own demo flag keeps demo output out of Merge, also after a demo has run.
- **Offline**: with roko serve down, the pages say OFFLINE, stop taking work and show the real start command. They
  reload by themselves when it answers again.
- **Safety**:
  - The skills, the prompt section and every tool answer tell the model to report roko's errors and stop. It never
    repairs roko's worktrees, branches, `.roko/` or `roko.toml`, and never re-runs paid work nobody asked for. On an
    explicit ask it may run only the move-aside command roko itself printed.
  - Every answer about a problem ends with one sentence: never repair or clean up roko's state yourself, not
    even when the person asks; report what roko said.
  - A cap or a daily limit is the person's: the model offers a run with a higher cap and starts it only when
    they ask. The opt-in guard refuses lessons that would raise a cap and retry.
  - Text for the person and guidance for the model are kept apart.
  - A warning appears when Hermes approvals are off, recommending `skills.write_approval`.
  - An opt-in `learning_guard` vetoes background-review skill writes that teach roko repairs. It is off by default:
    any `pre_tool_call` hook makes Hermes 0.22 block concurrent tool calls that carry no id.
- **Live relay**: a fast run's first events are no longer dropped before the run is followed, and the replay's clock
  no longer drifts.
- **Fixes from review**:
  - Dry runs no longer mint or rotate keys.
  - The roko serve that init starts gets none of Hermes' secrets.
  - Setup and init no longer adopt another project's serve, or a remote address, from `serve.json`.
  - Paths in commands meant for copying are quoted.
  - `roko.toml` is backed up before every edit.
  - No doc pipes a key through `echo`.
  - A run that ran tasks and then failed no longer reads "roko did not start the run".
  - `hermes roko init` edits a symlinked `roko.toml` where it lives.
  - A cap stop after a failed check tells the model about that check.
  - A failed demo run is no longer reported to the model as done.
- **Docs**: getting started, the README, after-install, updating, reference, troubleshooting and using-roko are
  rewritten around `hermes roko init`.
- **roko**: built from main of 2026-10-16 for:
  - refusals kept under a run's id, delivery events, plan-writing progress and its cost, the demo flag,
    `no_price` refusals and budget stops;
  - up-front chat-run refusals and the `/health` features;
  - interrupted runs, and unverified and partial results;
  - plan-check events;
  - `roko config preset chat-host`.

  An older roko gets sensible fallbacks.

## 0.4.0 — unreleased

The control surface: roko's work and its five loops, live, in every Hermes surface.

- **Design**: each run is one instrument. A black display bar with dot-matrix readouts (`01 TASKS`, `02 TIME`,
  `03 SPEND`, `04 CHECKS`, `05 MODEL`, `06 PULSE`), a ticker with what is happening this second, a scope that blips on
  each event, and the tasks as pads on a sequencer with a playhead, one column per wave. Four colours carry meaning
  and nothing else (blue: an agent works; green: a check passed; orange: you; red: a check did not pass). Keys,
  switches, LEDs, a 20-segment spend meter and a cap knob with detents bounded by your limits. Numbered module labels
  in the same order on every surface. Reduced motion respected throughout.
- **Live**: a WebSocket, `WS /api/plugins/roko/live`, behind which one relay per Hermes backend follows roko's event
  hub (`GET /api/events`) and pushes cards, timeline lines, the agents' tool steps and words, and roko's loop events as
  they happen. In the end-to-end test against roko with real models the median delay was 4 ms for a route, 15 to 20 ms
  for an agent's words and 0.3 s for an activity line. While the socket is up, pages poll only every 15 s as a
  backstop; while it is down, they poll as before. The desktop half reads it with `ctx.socket`, the dashboard
  with `buildWsUrl`; the socket checks Hermes' own credential.
  An agent's words arrive with `said`, the tail of what it has said since its last tool call, so a page shows sentences,
  not tokens.
- **roko's five loops**: L0 tool calls, L1 attempts, L2 the plan, L3 learning, L4 audit. A Loops tab per run and per
  page with a five-ring dial (a sweep hand, a tick per event), each ring's events, and roko's own state from the new
  `GET /loops` (route decisions and retry budgets, diagnoses, model scores, gate thresholds, lessons, playbooks, the
  learning loops' health). Built on roko's new events (roko 2026-10-14): `route_decided`, `confirm_waiting` and
  `confirm_resolved`, `effect_staged` and `effect_decided`, `knowledge_written`, live records numbered by attempt, and
  live rows flushed at once.
- **Run cards** gain the run's loop events (`loops`), roko's gate thresholds, and per task: the last tool steps, the
  agent's live words, a sign-off's hold with roko's deadline, held calls, lessons, and each attempt's route (model,
  source, probability and the candidates roko weighed).
- **Desktop app**, to the fullest of Hermes' plugin SDK:
  - a **monitor pane** in the right sidebar that follows the newest run beside the chat (hidden, never closed);
  - a **delegate to roko** card on an empty chat, whose example requests fill the composer;
  - a **`→ roko`** key in the chat composer that opens new run with the chat's draft;
  - a **`roko` theme** for the whole app, aluminium by day and graphite by night, TE orange;
  - a **settings page** under Settings ▸ Plugins ▸ roko: the connection, limits, sounds, the theme, the doctor;
  - a light on the sidebar row of a chat whose run is going (blue) or waits on you (orange);
  - Hermes' pet says when a run ends or needs you; opt-in sounds (off by default);
  - palette entries for new run, Loops, the monitor pane, what's waiting and the health check; ⌘⌥R anywhere;
  - a run started from a chat arrives with a toast at once, through Hermes plugin events (`plugin.roko.run.started`,
    `run.ended`, `waiting`).
- **Web dashboard**: the same instruments, plus roko on the dashboard's other pages: a strip above the chat
  (`chat:top`) and on Sessions while a run is going, a summary card on Analytics (`analytics:top`), a model scorecard
  on Models (`models:top`), and the sidebar chip; number keys 1–6 switch sections.
- **Fixes found by dogfooding**: a long run's final card could stay stale when roko rate-limited the reads (the card now
  waits as roko asks, and the relay rebuilds a card that came back with problems); live words came one token per
  frame; the chat and sessions strips cut off the newest words; a decision said "Approved · approved".
- **Tests**: the replay roko streams its hub, answers roko's learning routes from what it replayed, and with
  `--recording live` replays runs recorded from a live roko with real models (`tests/fixtures/live_runs.json`, the
  agents' words included); `--tour` adds one of each loop event the recordings never show. The compat lane keeps
  Hermes from building a dependency runtime per test home (`HERMES_DISABLE_LAZY_INSTALLS=1`).

## 0.3.0 — unreleased

Mission control: follow, review and merge roko's checked work without leaving Hermes.

- **Desktop app**: the roko page is rebuilt around the run.
  - A header with live instruments: a progress ring, a ticking clock, spend against the cap with a
    projection, checks passed, roko's estimate of the time left, and the models used.
  - The run as a graph: one column per wave, each task moving through its agent and its checks, with
    retries and blocks marked. Click a task for every attempt, its checks, the key line of a check that did
    not pass, and what its agent said.
  - A "now" line while the run goes, an activity feed with filters, and a replay of a finished run.
  - **Changes**: the run's diff, file by file. **Merge**: a guarded merge of exactly the commit you reviewed,
    as a fast-forward or a clean merge commit, with the command that undoes it.
  - **New run** (⌘⌥R, `n`, or the palette): ask roko for work from the app, as one checked task or as a
    plan first, under the run cap and the daily limit.
  - Waiting cards with a document preview, plans as graphs, Insights with charts, a first-run page with
    example requests, chat cards with a small graph and Review & merge, and a status chip with a progress
    ring.
- **Web dashboard**: the same mission control in the dashboard's own look, down to phone width.
- **`hermes roko watch [RUN]`** follows a run live, full screen, on a terminal: its state with a spinner,
  an elapsed clock, spend against the cap, the plan wave by wave (each task's model, attempts, cost and
  gates), what waits on you, and the run's latest events. `q` stops watching while the run goes on and `r`
  checks at once; when the run ends, the last frame stays with a summary: verdict, cost, branch, and the
  review and merge commands. Piped, or with `--once`, it prints the card as text. Also
  `hermes roko status RUN [--why]`, and run cards in `/roko` gain task and spend bars, the plan's waves on
  one line, and what waits on you first.
- **Backend** (docs/ui-api.md): run cards gain progress, the task graph, each task's timing, step,
  attempts and its agent's latest note, roko's estimate of the time left, and a "why" paragraph for runs
  that did not succeed. Timeline lines gain a group, a time, and the fields a replay needs. New routes: the
  diff (`GET /runs/{id}/diff`), the merge check and merge (`GET` and `POST /runs/{id}/merge`), and new work
  (`POST /runs`).
- **Tools**: a `title` names a run in every list; a run that waits behind another in roko's workspace
  reports its `queue_position`.
- **Why** reads better: the line of a failing check that says why, blocked tasks grouped under what
  blocked them, what a cancelled run had done, and no engine tally.
- **Confirmations** show roko's own deadline (roko gap-25d9cc), never a guessed one.
- **Newer roko**: numbered attempts (roko bug-369c21; an older roko's are still counted), queued prompt
  runs (roko bug-09e21e), and a run roko has no record of shows as `missing` rather than as an error.
- **Tests**: a replay roko (`tests/replay_roko.py`) that plays recorded runs back over time, for building
  and showing the UIs without spending anything; fixtures recorded in the Hermes dogfood.

## 0.2.0 — unreleased

roko becomes visible in every Hermes interface.

- **Desktop app** (`desktop/plugin.js`): a roko page (Runs, Waiting, Plans, Knowledge, Health), a
  status-bar chip, palette entries, notifications, a `hermes://open/roko?run=<id>` deep link, and live
  chat cards the model places with `::roko-run{id}`, `::roko-plan{id}` and `::roko-pending{run}`.
- **Web dashboard** (`dashboard/`): a roko tab, a header chip and a Sessions-page banner.
- **Backend for both** (`dashboard/plugin_api.py`, `hermes_plugin_roko/ui_api.py`): the
  `/api/plugins/roko/*` routes in docs/ui-api.md, mounted by Hermes' web server. roko's key stays in
  Hermes' backend. Every route answers 200 with `ok`, so a page can tell "roko said no" from "the route
  is missing".
- **Run cards** (`rundata.py`): cost and tokens summed from roko's efficiency events (roko's summary
  says $0 for plan runs), tasks with model, attempts and gates, start and end from the run's manifest,
  a readable timeline, a one-line headline, and the delivered branch with review and merge commands.
  Event indexes are read incrementally, and a finished run's only once.
- **Spend**: a daily limit, `max_day_usd` (default $20), across the runs Hermes starts, counting what
  running runs may still spend. Over-limit starts are refused before anyone is asked.
- **Tools**: `roko_status` gains a headline, `detail: "tasks" | "why"`, `run_id: "last"`, today's spend
  in the overview, and returns as soon as something waits on the person (with a 6-character code per
  item); `roko_plans` shows waves and roko's estimate; `roko_decide` accepts a code; approval prompts are
  one clean line and show the estimate and today's spend; errors carry `"success": false`; long waits
  tell Hermes they are still working; one emoji per tool.
- **`/roko`**: run cards for `status RUN [why]`, plans wave by wave, and new `runs`, `cost`, `gates`,
  `learn`, `effects` and `knowledge`; replies fit one message (1,900 characters).
- **`hermes roko watch [RUN]`** redraws a run's card until it ends; `hermes roko status RUN`.
- **Skills** `roko:delegate`, `roko:plan`, `roko:decide`; an **`@roko:` context reference**; roko API
  keys **redacted** in Hermes' logs and transcripts.
- **Prompt**: teaches the desktop cards in the desktop app only, the `/roko approve CODE` note, and
  that unverified is not success.
- **Safety**: all text from roko is cleaned of escape sequences, control characters and bidirectional
  overrides before it reaches a terminal, an approval prompt, a chat or a page; `ui_actions: false`
  makes the UIs read-only.
- **Doctor**: reports which UI halves are installed and what to do to see them.
- **Where the work is**: a finished run's card takes roko serve's own answer, the summary's `result`
  (roko gap-8409d0): the batch branch, its commit and base, the changed files, whether the checkout has
  the work, and roko's merge command, or the branch it was promoted into. It works for a remote roko
  serve too, and still names the files after the merge. Against an older roko serve the plugin reads the
  branch with git as before, which needs the workspace on this machine.
- **Docs** (`docs/`): getting started, everyday use with examples, a reference of commands and settings,
  and troubleshooting, each checked against a fresh install.
- **Short run ids**: the first characters of a run id (at least 4; the lists show 8) name the run Hermes
  started, in `/roko`, `hermes roko` and the tools.
- **Install scanner in the tests**: the compat lane runs Hermes' own install scanner over what an install
  would copy, so a finding that would block installing or updating the plugin fails the tests.
- **Fixes**:
  - The doctor's desktop hint says to reload the window (⌘R) after turning roko on: "Reload desktop
    plugins" adds the sidebar entry but does not load the page.
  - A paid start that timed out now finds the run roko started anyway, instead of pointing at an
    overview that could not list it.
  - The run log takes a lock file around each change, so a chat and a UI backend writing at once
    cannot drop each other's runs.
  - The run log is written only when something changed.
  - Bare `hermes roko` prints its usage and exits 0.
  - Internal errors reach the model and chat cleaned.

## 0.1.0 — unreleased

First version.

- Eight tools for Hermes' model over roko serve's `/mcp` contract and two REST reads: `roko_run`,
  `roko_plan_generate`, `roko_plan_run`, `roko_status`, `roko_cancel`, `roko_plans`, `roko_recall`,
  `roko_decide`. Paid tools and decisions ask the person through Hermes' approval gate; every run names
  a `max_usd` cap, checked here before roko sees it.
- `roko_status` follows a run in short server-side waits (so an interrupt is noticed), lists what the
  run waits on the person for, reports the `roko/batch/<run_id>` branch its verified work is on when the
  workspace is local, and recovers a finished plan generation that roko has already forgotten.
- `/roko` slash command: `status`, `plans`, `pending`, `approve`, `reject`, `cancel`, `recall`, `doctor`.
- `hermes roko setup | doctor | status`: setup finds roko serve, mints a write-scoped key with its
  launch token (`--mint`), stores it in Hermes' `.env`, and runs the doctor. The doctor checks reach,
  auth, key scope, the `/mcp` tool set, and whether roko accepts chat-started runs, using a probe that
  starts nothing.
- A `roko` system-prompt section teaching the delegation protocol.
- No hooks.
- Built for Hermes' tool guardrails:
  - Status results carry `checked_at`, so polling a long run is never a byte-identical repeat. Hermes
    halts a gateway turn on the fifth identical call.
  - Results avoid bare `"failed"` and `"error"` tokens. The one exception is the status of a run that
    did fail. Polls of a healthy run therefore never count as failed calls.
- Safety details:
  - Approval rule keys carry the cap.
  - `roko_decide` binds the item and the verdict, and refuses items roko no longer waits on.
  - `/roko` names items by stable codes.
  - Slow answers and paid starts report that the work may already have happened.
  - The loopback check accepts only `localhost` or loopback IP literals, and loopback requests skip
    proxies.

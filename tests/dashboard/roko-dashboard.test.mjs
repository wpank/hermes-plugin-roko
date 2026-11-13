// Behaviour tests for dashboard/dist/index.js, the roko tab of the Hermes web dashboard.
//
// The bundle runs inside jsdom exactly as the dashboard loads it: a plain script that
// reads window.__HERMES_PLUGIN_SDK__ and registers on window.__HERMES_PLUGINS__. The
// SDK here is a fake (simple DOM stand-ins for the dashboard's UI components) built on
// the real React from a Hermes checkout; fetchJSON is a fake backend answering with the
// plugin backend's own answers about recorded runs (tests/dashboard/fixtures.json, written
// by make_fixtures.py from the replayed dogfood runs), moved to "now".
//
// Run:  node tests/dashboard/roko-dashboard.test.mjs [HERMES_AGENT_SRC]
// (HERMES_AGENT_SRC defaults to ~/.hermes/hermes-agent; it must have node_modules
// with react, react-dom and jsdom.) tests/dashboard/test_dashboard_bundle.py runs this.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const BUNDLE_PATH = path.join(REPO, "dashboard", "dist", "index.js");
const BUNDLE_SRC = readFileSync(BUNDLE_PATH, "utf8");
const RAW = JSON.parse(readFileSync(path.join(HERE, "fixtures.json"), "utf8"));
// plugin-runs' cards from live runs (2026-10-15), the workspace path shortened.
const REAL_CARDS = JSON.parse(readFileSync(path.join(HERE, "real-cards.json"), "utf8")).cards;
// The version the bundle says it is: a current backend answers with it, and older or newer ones are relative to it,
// so a version bump changes no test.
const VERSION = /\bconst VERSION = "(\d+)\.(\d+)\.(\d+)"/.exec(BUNDLE_SRC).slice(1, 4).join(".");
/** The release before `v`: "0.5.0" → "0.4.0", "1.0.0" → "0.99.0", "0.0.3" → "0.0.2". */
function olderThan(v) {
  const [major, minor, patch] = v.split(".").map(Number);
  if (minor > 0) return major + "." + (minor - 1) + ".0";
  if (patch > 0) return major + "." + minor + "." + (patch - 1);
  return major - 1 + ".99.0";
}
const OLDER = olderThan(VERSION);
const OLDEST = olderThan(OLDER);
const NEWER = VERSION.split(".")[0] + "." + (Number(VERSION.split(".")[1]) + 1) + ".0";
const HERMES = path.resolve(process.argv[2] || path.join(os.homedir(), ".hermes", "hermes-agent"));
const requireFromHermes = createRequire(path.join(HERMES, "package.json"));

const { JSDOM } = requireFromHermes("jsdom");

const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
  url: "http://localhost/roko",
  pretendToBeVisual: true,
  runScripts: "outside-only",
});
const { window } = dom;

// react-dom reads these globals when it renders and dispatches events.
for (const key of [
  "window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "Node", "Element",
  "Event", "MouseEvent", "KeyboardEvent", "InputEvent", "FocusEvent", "PopStateEvent",
  "MutationObserver", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame",
]) {
  const value = key === "window" ? window : window[key];
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const React = requireFromHermes("react");
const { createRoot } = requireFromHermes("react-dom/client");
const { act } = React;
const h = React.createElement;

after(() => {
  window.close();
});

// --------------------------------------------------------------------------------
// The fixtures, moved to now: every ISO time and every millisecond stamp shifts by the same amount.
// --------------------------------------------------------------------------------

const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/;
function shifted(value, delta) {
  if (typeof value === "string" && ISO.test(value)) {
    const t = Date.parse(value);
    return Number.isFinite(t) ? new Date(t + delta).toISOString() : value;
  }
  if (Array.isArray(value)) return value.map((v) => shifted(v, delta));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = (k === "ts_millis" || k === "at" || k === "ts") && typeof v === "number" && v > 1e12 ? v + delta : shifted(v, delta);
    }
    return out;
  }
  return value;
}
function fixtures() {
  const fx = shifted(structuredClone(RAW), Date.now() - RAW._generated_at_ms);
  // The recordings name the version they were made with; the current backend is this bundle's.
  fx.overview.plugin_version = VERSION;
  for (const check of fx.health.checks || []) {
    if (typeof check.detail === "string") check.detail = check.detail.replace(/hermes-plugin-roko \d+\.\d+\.\d+/, "hermes-plugin-roko " + VERSION);
  }
  return fx;
}
const IDS = RAW.ids;

// --------------------------------------------------------------------------------
// The fake SDK
// --------------------------------------------------------------------------------

const VARIANT_PROPS = ["size", "outlined", "ghost", "destructive", "invert", "prefix", "suffix", "active", "value"];
function strip(props) {
  const out = { ...props };
  for (const key of VARIANT_PROPS) delete out[key];
  return out;
}

function makeSdk(fetchJSON) {
  const components = {
    Card: (props) => h("div", { ...props, "data-sdk": "Card" }),
    Badge: (props) => h("span", strip(props)),
    Button: (props) => h("button", { ...strip(props), "data-sdk": "Button" }, props.prefix || null, props.children, props.suffix || null),
    Input: (props) => h("input", { ...props, "data-sdk": "Input" }),
    Label: (props) => h("label", props),
    TabsList: (props) => h("div", { ...props, "data-sdk": "TabsList" }),
    TabsTrigger: (props) => h("button", { ...strip(props), "data-active": props.active ? "true" : "false", "data-sdk": "TabsTrigger" }),
    ConfirmDialog: (props) =>
      props.open
        ? h(
            "div",
            { role: "alertdialog", "aria-label": props.title, "data-destructive": props.destructive ? "true" : "false" },
            h("h2", null, props.title),
            props.description ? h("p", null, props.description) : null,
            h("button", { type: "button", "data-confirm": "yes", onClick: props.onConfirm }, props.confirmLabel || "Confirm"),
            h("button", { type: "button", "data-confirm": "no", onClick: props.onCancel }, props.cancelLabel || "Cancel")
          )
        : null,
    Toast: (props) => (props.toast ? h("div", { role: "status", "data-toast": props.toast.type }, props.toast.message) : null),
  };
  function useToast() {
    const [toast, setToast] = React.useState(null);
    const showToast = React.useCallback((message, type) => setToast({ message, type }), []);
    return { toast, showToast };
  }
  return {
    sdkVersion: "1.1.0",
    React,
    hooks: {
      useState: React.useState,
      useEffect: React.useEffect,
      useCallback: React.useCallback,
      useMemo: React.useMemo,
      useRef: React.useRef,
      useContext: React.useContext,
      createContext: React.createContext,
      useToast,
    },
    components,
    fetchJSON,
    utils: { cn: (...c) => c.filter(Boolean).join(" ") },
  };
}

// --------------------------------------------------------------------------------
// The fake backend: the routes in docs/ui-api.md, recording every call
// --------------------------------------------------------------------------------

function makeBackend(mode = "normal", edit = () => {}) {
  const fx = fixtures();
  if (mode === "idle") {
    fx.overview.counts = { running: 0, queued: 0, waiting: 0 };
    fx.overview.pending = [];
    fx.overview.runs = fx.overview.runs.filter((r) => !["running", "queued"].includes(r.state));
  }
  if (mode === "empty") {
    fx.overview.counts = { running: 0, queued: 0, waiting: 0 };
    fx.overview.pending = [];
    fx.overview.runs = [];
    fx.pending = { ok: true, items: [] };
  }
  if (mode === "readonly") fx.overview.permissions = { write: false };
  if (mode === "unreachable") {
    fx.overview.connection = {
      url: "http://localhost:6677",
      reachable: false,
      version: null,
      status: null,
      credential: "env:ROKO_API_KEY",
      error: { code: "unreachable", message: "roko serve is not reachable at http://localhost:6677", hint: "start it with `roko serve`" },
    };
    fx.overview.pending = [];
    fx.overview.counts.waiting = 0;
  }
  fx.merge_result = {
    ok: true,
    merge: {
      run_id: IDS.prompt, merged: true, already: false, mode: "fast-forward", into: "main",
      branch: "roko/batch/" + IDS.prompt, commit: "f8939382ea89", previous_head: "b379ff451fe9", head: "f8939382ea89",
      undo_command: "git -C /home/demo/code/tally reset --keep b379ff451fe9476ef043715cdad23aa4c23d42a6",
    },
  };
  fx.started = { ok: true, run_id: "11111111-2222-4333-8444-555555555555", kind: "run", state: "running", max_usd: 0.5 };
  // A current backend: the install state and the setup problems ride on the overview and /health.
  fx.overview.install = currentInstall();
  fx.overview.setup = { ok: true, problems: [] };
  fx.health = { ...fx.health, plugin_version: fx.overview.plugin_version, install: currentInstall(), setup: { ok: true, problems: [] } };
  // POST /setup/fix's `next` when git tracks roko.toml (readiness._commit_step), and its `ready`.
  fx.fix_next = COMMIT_NEXT;
  fx.fix_ready = true;
  // 0.7: no projects (a backend from before them, no /serve or /projects) unless a test names some.
  fx.projects = null;
  fx.serves = {};
  fx.serve_posts = [];
  fx.project_posts = [];
  fx.setup_posts = [];
  fx.serve_busy = 0;
  // 0.7: the plugin's `url` names a roko serve elsewhere and no `workdir`: no project, and a `remote` serve.
  fx.remote_url = null;
  edit(fx);
  const calls = [];
  let decided = false;

  async function fetchJSON(url, init) {
    const method = (init && init.method) || "GET";
    const body = init && init.body ? JSON.parse(init.body) : null;
    calls.push({ url, method, body });
    if (mode === "missing") throw new Error('404: {"detail":"Not Found"}');
    if (mode === "crash") throw new Error("500: Internal Server Error");
    const u = new URL(url, "http://localhost");
    assert.ok(u.pathname.startsWith("/api/plugins/roko/"), "every call goes to the plugin's routes: " + url);
    const p = u.pathname.slice("/api/plugins/roko".length);
    let m;
    const own = fx.projects ? routes07(fx, method, p, u, body) : null;
    if (own) return own;
    if (method === "GET" && p === "/overview") return fx.projects ? overview07(fx, u) : fx.overview;
    if (method === "GET" && p === "/pending") return decided && !fx.pending_lag ? { ok: true, items: fx.pending.items.slice(1) } : fx.pending;
    if (method === "GET" && p === "/plans") return fx.plans;
    if (method === "GET" && (m = /^\/plans\/([^/]+)$/.exec(p))) {
      return fx.plan_details[decodeURIComponent(m[1])] || { ok: false, error: { code: "not_found", message: "roko has no plan " + m[1], hint: "list plans first" } };
    }
    if (method === "POST" && (m = /^\/plans\/([^/]+)\/run$/.exec(p))) {
      // What roko's answer changes on the backend's side (a refused plan's validation, say).
      if (fx.on_plan_run) fx.on_plan_run(fx);
      return fx.plan_started || { ok: true, run_id: fx.started.run_id, state: "running", queue_position: null, ...projectRef(fx, body) };
    }
    if ((p === "/setup/fix") && !fx.overview.setup) throw new Error('404: {"detail":"Not Found"}');
    if (method === "GET" && p === "/setup/fix") {
      return u.searchParams.get("action") === "workspace-chat-ready"
        ? fixPreview(u.searchParams.get("variant"))
        : { ok: false, error: { code: "invalid", message: "there is no fix called that", hint: "" } };
    }
    if (method === "POST" && p === "/setup/fix") {
      // A new overview, as a real answer is: the page keys its setup on the reply it got.
      fx.overview = Object.assign({}, fx.overview, { setup: { ok: true, problems: fx.overview.setup.problems.filter((x) => !(x.fix && x.fix.action === body.action)) } });
      return {
        ok: true, action: body.action, variant: body.variant, done: true, path: "/home/demo/code/tally/roko.toml",
        backup: "/home/demo/code/tally/roko.toml.bak", summary: "", next: fx.fix_next, ready: fx.fix_ready,
        message: fx.fix_ready
          ? "Changed /home/demo/code/tally/roko.toml. roko accepts runs started from Hermes now."
          : "Changed /home/demo/code/tally/roko.toml. roko no longer asks for the data-model boundary, but it still refuses runs started from Hermes.",
      };
    }
    if (method === "POST" && p === "/runs") return fx.started.ok ? { ...fx.started, ...projectRef(fx, body) } : fx.started;
    if (method === "GET" && (m = /^\/runs\/([^/]+)\/events$/.exec(p))) {
      const answer = fx.events[decodeURIComponent(m[1])];
      if (!answer) return { ok: true, events: [], next_cursor: 0, has_more: false };
      if (u.searchParams.get("cursor") != null) return { ok: true, events: [], next_cursor: answer.next_cursor, has_more: false };
      return answer;
    }
    if (method === "GET" && (m = /^\/runs\/([^/]+)\/diff$/.exec(p))) {
      return fx.diffs[decodeURIComponent(m[1])] || { ok: true, diff: { available: false, why: "none", message: "this run left no changes to review", files: [], totals: { files: 0, additions: 0, deletions: 0 } } };
    }
    if (method === "GET" && (m = /^\/runs\/([^/]+)\/merge$/.exec(p))) {
      return fx.merges[decodeURIComponent(m[1])] || { ok: true, merge: { can_merge: false, merged: false, reason: "this run left no verified work to merge", command: null } };
    }
    if (method === "POST" && (m = /^\/runs\/([^/]+)\/merge$/.exec(p))) return fx.merge_result;
    if (method === "POST" && (m = /^\/runs\/([^/]+)\/cancel$/.exec(p))) return { ok: true, run_id: decodeURIComponent(m[1]), state: "cancelled" };
    if (method === "GET" && (m = /^\/runs\/([^/]+)$/.exec(p))) {
      const id = decodeURIComponent(m[1]);
      if (fx.runs[id]) return fx.runs[id];
      if (id === fx.started.run_id) {
        return { ok: true, run: { run_id: id, kind: fx.started.kind, label: "New run", state: "running", active: true, tasks: [], waiting: [], graph: { waves: [], edges: [] }, progress: { total: 0 }, started_at: new Date().toISOString() } };
      }
      return { ok: false, error: { code: "not_found", message: "roko does not know run " + id, hint: "it may have been cleaned up" } };
    }
    if (method === "POST" && p === "/decide") {
      if (fx.decide_error) return { ok: false, error: fx.decide_error };
      decided = true;
      return { ok: true, decision_id: "c_x", code: body.code, approved: body.approve, outcome: body.approve ? "approved" : "rejected", title: "the result of task T1" };
    }
    if (method === "GET" && p === "/knowledge") return { ...fx.knowledge, query: u.searchParams.get("q") };
    if (method === "GET" && p === "/health") return fx.health;
    if (method === "GET" && p === "/insights") return fx.insights;
    if (method === "GET" && p === "/loops") return fx.loops;
    if (method === "GET" && p === "/estimate" && fx.estimate) return fx.estimate;
    if (method === "GET" && p === "/learning" && fx.learning) return typeof fx.learning === "function" ? fx.learning(u.searchParams.get("scope")) : fx.learning;
    if (method === "GET" && p === "/build") return fx.build || { ok: true, project: null, reachable: true, phases: [], totals: {}, receipt: null, next: null };
    if (method === "GET" && (m = /^\/runs\/([^/]+)\/artifacts$/.exec(p))) return (fx.artifacts || {})[decodeURIComponent(m[1])] || { ok: true, commit: null, items: [] };
    if (method === "GET" && (m = /^\/runs\/([^/]+)\/artifact$/.exec(p))) return (fx.artifact_files || {})[u.searchParams.get("path")] || { ok: false, error: { code: "not_found", message: "not an image or a sound this run made", hint: "" } };
    throw new Error("404: no fake route for " + method + " " + p);
  }
  return { fetchJSON, calls, fx };
}

// --------------------------------------------------------------------------------
// 0.7: projects and their roko serves (BRIEF §C), as the backend words them
// --------------------------------------------------------------------------------

const WS = "/home/demo/code/tally";
const SYNTH = "/home/demo/code/pocket-synth";
const nameOf = (project) => project.split("/").pop();
const FORBIDDEN = { code: "forbidden", message: "actions from the Hermes UI are turned off for roko", hint: "set plugins.entries.roko.settings.ui_actions: true to allow them" };

/**
 * A ServeState as serve.py words it, with the keys it allows in that state. `outdated` is a running serve without /mcp
 * (`no_mcp`); one whose binary cannot start a serve (`too_old`) passes `url: null` and no actions.
 */
function serveState(project, state, extra = {}) {
  const up = state === "running" || state === "outdated";
  return {
    project, name: nameOf(project), state, url: up ? "http://127.0.0.1:6913" : null, pid: up ? 4343 : null,
    version: up ? "0.1.0" : null, git_sha: up ? "e31f4d52c" : null, started_by: up ? "hermes" : null,
    since: state === "stopped" ? null : new Date(Date.now() - 5000).toISOString(), idle_exit_minutes: 60, error: null, log_tail: null,
    actions: state === "running" ? ["restart", "stop"] : state === "stopped" || state === "failed" ? ["start"] : state === "outdated" ? ["restart"] : [],
    busy: null, ...extra,
  };
}
/** A ServeState's `error` in serve.py's words (its message, and its hint: the person's next step). */
function serveError(code, project = WS) {
  const name = nameOf(project);
  const words = {
    start_failed: ["roko serve exited before it answered (exit code 1)", "the log's last lines say why; `roko serve --workdir " + project + "` in a terminal shows the whole error"],
    // roko's own words for a serve with no LLM provider (roko serve --detach: not_initialized), and the plugin's hint.
    not_initialized: [project + " is not set up for roko: no LLM provider configured. Run `roko init` there, or put a provider's API key in ~/.roko/.env", "give roko a model key: a line such as OPENAI_API_KEY=… in ~/.roko/.env, or run `hermes roko init --workdir " + project + "`, which offers the key Hermes has"],
    no_mcp: ["roko serve for " + name + " runs a roko from before its /mcp endpoint, which Hermes needs", "update roko, then restart roko serve (Restart on the roko page)"],
    too_old: ["the roko at /usr/local/bin/roko is from before `roko serve --detach`, so Hermes cannot start roko serve with it", "update roko: in your roko clone, `git pull && cargo install --path crates/roko-cli`"],
    not_found: ["roko is not installed on this machine", "install roko: in a clone of roko's repository, `cargo install --path crates/roko-cli` (Rust 1.91 or later); or set the plugin's roko_bin setting to a roko binary"],
  };
  return { code, message: words[code][0], hint: words[code][1] };
}
/** A serve whose start failed for want of a model key: roko's `not_initialized` (no LLM provider; round 1). */
function noProvider(project) {
  return serveState(project, "failed", { error: serveError("not_initialized", project), log_tail: ["error: no LLM provider configured.", "roko serve: exiting (2)"] });
}
function projectRow(path, extra = {}) {
  return { path, name: nameOf(path), default: path === WS, last_used: new Date().toISOString(), ready: true, needs_setup: false, ...extra };
}
function serveFor(fx, path) { return fx.serves[path] || serveState(path, "running"); }
function defaultPath(fx) {
  return fx.projects.length ? (fx.projects.find((x) => x.default) || fx.projects[0]).path : null;
}
/** A project's serve answers: it runs (an outdated one runs too, without /mcp). */
function answers(fx, path) {
  const serve = serveFor(fx, path);
  return serve.state === "running" || (serve.state === "outdated" && !!serve.url);
}
/** A waiting item's project: the one it names, else its run's; the default project's for a run the overview does not list. */
function itemProject(fx, item) {
  if (item.project && item.project.path) return item.project.path;
  const row = (fx.overview.runs || []).find((r) => r.run_id === item.run_id);
  return row && row.project && row.project.path ? row.project.path : defaultPath(fx) || WS;
}
/**
 * What waits on the person (views.collect_pending, round 1): in every project whose serve answers, whichever project is
 * shown, each item with the project whose serve holds it.
 */
function waitingIn(fx, items) {
  return (items || []).filter((item) => answers(fx, itemProject(fx, item))).map((item) => {
    const path = itemProject(fx, item);
    return { ...item, project: { path, name: nameOf(path) } };
  });
}
function projectList(fx) { return fx.projects.map((x) => ({ ...x, serve: serveFor(fx, x.path) })); }
/** `{project: {path, name}}` on a start's answer (views.project_ref), from 0.7 on. */
function projectRef(fx, body) {
  if (!fx.projects || !fx.projects.length) return {};
  const path = askedProject(fx, body && body.project);
  return { project: { path, name: nameOf(path) } };
}
function askedProject(fx, asked) {
  return (fx.projects.find((x) => x.path === asked) || fx.projects.find((x) => x.default) || fx.projects[0]).path;
}

/** readiness.not_running's row for a project whose serve does not answer (none with no project yet, or a remote). */
function serveProblem(fx, path) {
  if (!fx.projects.length) {
    return fx.remote_url
      ? null
      : {
          id: "roko-unreachable", severity: "block", title: "No project is chosen for roko yet.",
          detail: "Hermes starts a roko serve for each project roko works in. Pick your project's folder on the roko page (Choose folder…), or run `hermes roko init` in it.",
          fix: { kind: "command", label: "set up a project", action: null, command: "hermes roko init", docs: "getting-started.md#set-roko-up-in-a-project" },
        };
  }
  const serve = serveFor(fx, path);
  const name = nameOf(path);
  const error = serve.error || {};
  // A checkout without roko.toml (its row's `needs_setup`): roko serve may run there on roko's defaults, but it refuses
  // runs started from Hermes (readiness.needs_setup).
  const row = fx.projects.find((x) => x.path === path);
  const needsSetup = {
    id: "project-needs-setup", severity: "block", title: "roko isn't set up for runs from Hermes in " + name + ".",
    detail: path + " has no roko.toml, so roko refuses runs started from Hermes there and knows none of the project's checks. Setting roko up runs `roko init` and lets roko accept runs started from Hermes; nothing is committed.",
    fix: { kind: "action", label: "set up roko here", action: "setup-project", command: "hermes roko init --workdir " + path, docs: "getting-started.md#set-roko-up-in-a-project", project: path },
  };
  if (serve.state === "remote") return null;
  if (answers(fx, path)) return row && row.needs_setup ? needsSetup : null;
  if (serve.state === "not_found") {
    return {
      id: "roko-not-found", severity: "block", title: "roko is not installed on this machine.",
      detail: "Hermes starts roko serve for " + name + " by itself, but it needs the roko command: install it (in a clone of roko's repository, `cargo install --path crates/roko-cli`), or set the plugin's roko_bin setting to a roko binary.",
      fix: { kind: "docs", label: "install roko", action: null, command: "cargo install --path crates/roko-cli", docs: "getting-started.md#install-roko" },
    };
  }
  if (serve.state === "outdated") {
    return {
      id: "roko-too-old", severity: "block", title: "roko is too old to start roko serve in the background.",
      detail: "The roko at /usr/local/bin/roko is from before `roko serve --detach`, so Hermes cannot start roko serve for " + name + ". Update roko: in your roko clone, `git pull && cargo install --path crates/roko-cli`.",
      fix: { kind: "command", label: "update roko", action: null, command: "git pull && cargo install --path crates/roko-cli", docs: "troubleshooting.md#roko-is-too-old-to-start-roko-serve" },
    };
  }
  if (serve.state === "failed" && error.code === "not_initialized") {
    return {
      id: "no-model-provider", severity: "block", title: "roko has no model provider for " + name + ", so its roko serve did not start.",
      detail: "roko serve needs a model it can call: a key in ~/.roko/.env (OpenAI, Anthropic, OpenRouter, …), or a roko.toml that names a provider. `hermes roko init` in the project offers the key Hermes has.",
      fix: { kind: "command", label: "give roko a model key", action: null, command: "hermes roko init --workdir " + path, docs: "troubleshooting.md#roko-has-no-model-provider", project: path },
    };
  }
  if (row && row.needs_setup) return needsSetup;
  const start = { kind: "action", label: "start roko serve", action: "start-serve", command: "hermes roko serve start --project " + path, docs: "troubleshooting.md#roko-serve-is-not-reachable", project: path };
  if (serve.state === "failed") {
    const hint = String(error.hint);
    return { id: "roko-unreachable", severity: "block", title: "roko serve did not start for " + name + ".", detail: error.message + ". " + hint.charAt(0).toUpperCase() + hint.slice(1) + ".", fix: start };
  }
  return {
    id: "roko-unreachable", severity: "block",
    title: serve.state === "starting" ? "roko serve is starting for " + name + "." : "roko serve is not running for " + name + ".",
    detail: serve.state === "starting"
      ? "Hermes started it a moment ago; this clears once it answers."
      : "Nothing roko does works from Hermes until roko serve runs. Hermes starts it in the background, and it keeps running after Hermes quits until it has had no work for a while.",
    fix: start,
  };
}
/** `setup` with the serve's own row first, as the overview and /health carry it for that project. */
function setupFor(fx, setup, path) {
  const row = serveProblem(fx, path);
  const problems = row ? [row, ...((setup && setup.problems) || [])] : (setup && setup.problems) || [];
  return { ok: !problems.some((x) => x.severity === "block"), problems };
}

/**
 * What serve.py does to a project's serve (POST /serve, and the start-serve and restart-serve fixes): ensure starts a
 * stopped one (a failed start waits a minute; nothing while `auto_start` is off), start starts a stopped or failed one,
 * restart starts one that does not run, and a restart or stop of a busy one wants `force`. Nothing starts where roko is
 * not set up.
 */
function serveChange(fx, path, action, force) {
  const now = serveFor(fx, path);
  const runs = now.state === "running" || (now.state === "outdated" && !!now.url);
  if (action === "ensure" || action === "start" || (action === "restart" && !runs)) {
    const may = action !== "ensure" || (fx.auto_start !== false && now.state === "stopped");
    if (may && (now.state === "stopped" || now.state === "failed")) fx.serves[path] = serveState(path, "starting");
    return { ok: true, serve: serveFor(fx, path) };
  }
  if (!runs) return { ok: true, serve: now };
  if (fx.serve_busy > 0 && !force) {
    const n = fx.serve_busy;
    return {
      ok: false,
      error: { code: "conflict", message: n + " run" + (n === 1 ? " is" : "s are") + " going in " + now.name + "; " + (action === "stop" ? "stopping" : "restarting") + " roko serve stops them.", hint: "wait for them to end, or confirm to stop them (their work so far is kept)" },
      serve: { ...now, busy: { active_runs: n } },
    };
  }
  fx.serves[path] = serveState(path, action === "stop" ? "stopped" : "starting");
  return { ok: true, serve: fx.serves[path] };
}

/** GET /overview?project=: the project it is about, every project, and its serve on the connection (ui_api, views). */
function overview07(fx, u) {
  if (!fx.projects.length) {
    // No project yet (round-1 amendment 1): no project, no serve, nothing waits; a remote serve without a workdir is
    // there, though, with no project either.
    const remote = fx.remote_url ? { ...serveState("", "remote"), project: null, name: new URL(fx.remote_url).host, url: fx.remote_url, since: null } : null;
    return {
      ...fx.overview, project: null, projects: [], pending: remote ? fx.overview.pending : [], counts: { ...fx.overview.counts, waiting: remote ? fx.overview.counts.waiting : 0 },
      setup: setupFor(fx, fx.overview.setup, null),
      connection: remote
        ? { ...fx.overview.connection, url: fx.remote_url, workdir: null, serve: remote }
        : { ...fx.overview.connection, url: null, reachable: false, version: null, status: null, workdir: null, serve: null,
            error: { code: "unreachable", message: "no project is chosen for roko, so there is no roko serve to ask", hint: "pick a project on the roko page, or run `hermes roko init` in your project" } },
    };
  }
  const path = askedProject(fx, u.searchParams.get("project"));
  const serve = serveFor(fx, path);
  const up = answers(fx, path) || serve.state === "remote";
  const projects = projectList(fx);
  const conn = up
    ? { ...fx.overview.connection, url: serve.url }
    : {
        ...fx.overview.connection, url: null, reachable: false, version: null, status: null,
        error: { code: "unreachable", message: "roko serve is not running for " + path, hint: "start it from the roko page, or with `hermes roko serve start --project " + path + "`" },
      };
  // What waits in every project whose serve answers (views.collect_pending, round 1), whichever project is shown.
  const pending = waitingIn(fx, fx.overview.pending);
  return {
    ...fx.overview,
    project: projects.find((x) => x.path === path),
    projects,
    setup: setupFor(fx, fx.overview.setup, path),
    connection: { ...conn, workdir: path, serve },
    pending,
    counts: { ...fx.overview.counts, waiting: pending.length },
  };
}

/**
 * The 0.7 routes (POST /serve, /projects, the project and serve fixes, /pending, /health) and the request gate (a
 * project Hermes does not know; a start that starts its project's serve first); null for every other route.
 */
function routes07(fx, method, p, u, body) {
  const asked = u.searchParams.get("project") || (body && typeof body.project === "string" ? body.project : null);
  if (asked && !fx.projects.some((x) => x.path === asked)) {
    return { ok: false, error: { code: "invalid", message: asked + " is not a project Hermes knows", hint: "add it first (Choose folder… on the roko page)" } };
  }
  const write = !(fx.overview.permissions && fx.overview.permissions.write === false);
  if (method === "POST" && (p === "/runs" || /^\/plans\/[^/]+\/run$/.test(p)) && fx.projects.length && write) {
    // ui_api.running_in: a stopped serve is started first and waited for; where it cannot run, the refusal names why.
    const path = askedProject(fx, asked);
    const serve = serveFor(fx, path);
    if (serve.error && serve.error.code === "not_initialized") {
      return { ok: false, error: { code: "unreachable", message: "roko serve did not start for " + nameOf(path) + ": " + serve.error.message, hint: serve.error.hint }, problem: serveProblem(fx, path), serve };
    }
    if (serve.state === "stopped" || serve.state === "failed") fx.serves[path] = serveState(path, "running");
    return null;
  }
  if (method === "POST" && p === "/serve") {
    fx.serve_posts.push(body);
    if (!["ensure", "start", "restart", "stop"].includes(body.action)) return { ok: false, error: { code: "invalid", message: "action must be one of ensure, start, restart, stop", hint: "" } };
    if (body.action !== "ensure" && !write) return { ok: false, error: FORBIDDEN };
    if (!fx.projects.length) return { ok: false, error: { code: "invalid", message: "no project is chosen", hint: "pick a project on the roko page" } };
    const path = askedProject(fx, body.project);
    if (serveFor(fx, path).state === "remote") {
      return { ok: false, error: { code: "forbidden", message: "roko serve at https://roko.example.net is not on this machine, so the plugin starts and stops nothing there", hint: "manage that roko serve where it runs" } };
    }
    return serveChange(fx, path, body.action, body.force === true);
  }
  if (p === "/projects") {
    if (method !== "POST") return { ok: true, default: defaultPath(fx), projects: projectList(fx) };
    fx.project_posts.push(body);
    if (!write) return { ok: false, error: FORBIDDEN };
    if (!["add", "remove", "set_default"].includes(body.action)) return { ok: false, error: { code: "invalid", message: "action must be add, remove or set_default", hint: "" } };
    const path = String(body.path || "").trim();
    if (!path) return { ok: false, error: { code: "invalid", message: "name the project's folder (path)", hint: "" } };
    if (body.action === "remove") {
      fx.projects = fx.projects.filter((x) => x.path !== path);
      if (fx.projects.length && !fx.projects.some((x) => x.default)) fx.projects[0] = { ...fx.projects[0], default: true };
      return { ok: true, default: defaultPath(fx), projects: projectList(fx) };
    }
    if (!path.startsWith("/home/demo/code/")) {
      return { ok: false, error: { code: "invalid", message: path + " is not a git checkout, and roko works on branches of one", hint: "make it one first: git -C '" + path + "' init, then commit what you have" } };
    }
    // The checkout's top folder, as `git rev-parse --show-toplevel` names it.
    const top = path.replace(/^(\/home\/demo\/code\/[^/]+).*$/, "$1");
    if (!fx.projects.some((x) => x.path === top)) {
      // The first project this Hermes knows is its default; a checkout without roko.toml needs setting up.
      const first = !fx.projects.length;
      fx.projects.push(projectRow(top, first ? { default: true, last_used: null } : { default: false, needs_setup: true, ready: false, last_used: null }));
      // round 1: roko serve runs there on roko's defaults (roko has a provider here), and it is not set up yet.
      fx.serves[top] = serveState(top, "running");
    }
    if (body.action === "set_default") fx.projects = fx.projects.map((x) => ({ ...x, default: x.path === top }));
    // `add` names the project it added (round-1 amendment 6).
    return { ok: true, default: defaultPath(fx), projects: projectList(fx), ...(body.action === "add" ? { project: projectList(fx).find((x) => x.path === top) } : {}) };
  }
  if (method === "GET" && p === "/pending") {
    // views.collect_pending (round 1): what waits in every project whose serve answers, also while the shown project's
    // is down; each item with its project.
    return { ok: true, items: waitingIn(fx, fx.pending.items) };
  }
  if (method === "GET" && p === "/health") {
    // It reads files only, so it answers while the serve is down; its setup is the project's.
    return { ...fx.health, setup: setupFor(fx, fx.health.setup, fx.projects.length ? askedProject(fx, asked) : null) };
  }
  const fix = u.searchParams.get("action") || (body && body.action);
  if (p === "/setup/fix" && ["setup-project", "start-serve", "restart-serve"].includes(fix)) {
    const project = askedProject(fx, asked);
    const name = nameOf(project);
    if (method === "GET") {
      // fixes.preview: a summary of what it does, no diff; the path is the project's.
      const busy = fx.serve_busy;
      return {
        ok: true, action: fix, variant: null, variants: [], preview: "", path: project,
        title: fix === "setup-project" ? "Set up roko in " + name : (fix === "start-serve" ? "Start" : "Restart") + " roko serve for " + name,
        summary: fix === "setup-project"
          ? fx.setup_summary === false ? "" : "Runs `roko init` in " + project + ": it writes roko.toml (the project's checks and its model ladder) and roko's `.roko/` folder. Then it lets roko accept runs started from Hermes there (roko's own `config preset chat-host`, or [serve.mcp] allow_without_data_llm = true on an older roko), and starts the project's roko serve."
          : fix === "start-serve"
            ? "Starts roko serve for " + name + " in the background (`roko serve --detach`) on a port of its own. It keeps running after Hermes quits, so runs finish, and stops itself after 60 minutes without work."
            : "Stops roko serve for " + name + " and starts it again with the roko at /usr/local/bin/roko (0.1.0, git e31f4d52c), with the arguments it started with: it reads roko.toml and ~/.roko/.env again.",
        digest: fix === "setup-project" ? "a3f1c2d4e5b6a7c8" : null,
        note: fix === "setup-project"
          ? "Nothing is committed: commit roko.toml yourself when you are happy with it."
          : fix === "restart-serve" && busy ? busy + " run" + (busy === 1 ? " is" : "s are") + " going in " + name + ": restarting stops " + (busy === 1 ? "it" : "them") + " (their work so far is kept)." : null,
      };
    }
    fx.setup_posts.push(body);
    if (!write) return { ok: false, error: FORBIDDEN };
    if (fix === "setup-project") {
      // fixes.setup_project: roko init, the chat-host preset, then the serve (restarted when it ran on roko's defaults,
      // so it reads the new roko.toml), waited for.
      const ranWithout = answers(fx, project);
      fx.projects = fx.projects.map((x) => (x.path === project ? { ...x, needs_setup: false, ready: true } : x));
      fx.serves[project] = serveState(project, "running");
      return {
        ok: true, action: fix, done: true, ready: true, path: project, next: null, serve: fx.serves[project],
        message: "roko init wrote roko.toml; roko's chat-host preset changed roko.toml" + (ranWithout ? "; roko serve restarted on the new roko.toml" : "") + ". roko accepts runs started from Hermes in " + name + " now.",
      };
    }
    const answer = serveChange(fx, project, fix === "start-serve" ? "start" : "restart", body.force === true);
    if (answer.ok !== true) return answer; // a busy restart is refused with nothing done: its setup row stays
    fx.overview = { ...fx.overview, setup: { ok: true, problems: fx.overview.setup.problems.filter((x) => !(x.fix && x.fix.action === fix)) } };
    const serve = answer.serve;
    return {
      ok: true, action: fix, done: serve.state === "starting" || serve.state === "running", ready: serve.state === "running", path: project, next: null, serve,
      message: serve.state === "starting" ? "roko serve is starting for " + name + "." : "roko serve for " + name + ": " + serve.state + ".",
    };
  }
  return null;
}

/** Wait for `check` to pass (real time: the page's own timers drive it), `timeout` ms at most. */
async function eventually(check, timeout = 4500) {
  const start = Date.now();
  for (;;) {
    try {
      return check();
    } catch (err) {
      if (Date.now() - start > timeout) throw err;
    }
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
  }
}

// Setup problems as roko's backend words them (docs/ui-api.md "setup", install_state.py).
function currentInstall() {
  return {
    loaded_version: VERSION, disk_version: VERSION, desktop_copy_version: VERSION, desktop_copy_stale: false,
    backend_stale: false, desktop_copy: "/home/demo/.hermes/desktop-plugins/roko", desktop_copy_marker: true,
  };
}
const PROBLEM_BOUNDARY = {
  id: "workspace-refuses-chat-runs", severity: "block",
  title: "roko refuses runs started from Hermes in this workspace.",
  detail: "Its roko.toml has no data-model boundary, so roko turns down every run a chat starts.",
  fix: { kind: "action", label: "make ready", action: "workspace-chat-ready", command: "hermes roko fix workspace-chat-ready", docs: "troubleshooting.md#roko-refuses-runs-started-from-hermes" },
};
const PROBLEM_MODEL = {
  id: "no-tool-loop-model", severity: "warn",
  title: "No model a chat-started run can use.",
  detail: "Chat runs need a model roko calls through an API; this workspace only has CLI agents.",
  fix: { kind: "command", label: "copy command", action: null, command: "roko config models list", docs: null },
};
const PROBLEM_RESTART = {
  id: "restart-hermes", severity: "warn",
  title: "roko " + NEWER + " is installed, but Hermes is still running " + VERSION + ".",
  detail: "Hermes loads plugins when it starts, so an update takes effect after a restart.",
  fix: { kind: "restart-hermes", label: "restart hermes", action: null, command: null, docs: "updating.md#2-restart-what-you-use" },
  steps: {
    desktop: ["Quit Hermes with ⌘Q. Closing the window is not enough: the app keeps running.", "Open Hermes again."],
    dashboard: ["Stop `hermes dashboard` (Ctrl-C where it runs) and start it again.", "Reload this page."],
    terminal: ["Web dashboard: stop `hermes dashboard` and start it again."],
  },
  parts: { backend: true, desktop_copy: false },
};
/** readiness.fix_preview for workspace-chat-ready: two ways, the boundary recommended. */
/** As plugin-setup has it since 18:20: `local` first and recommended, `boundary` ("screen with <model>") second. */
function fixPreview(variant) {
  const local = variant !== "boundary";
  return {
    ok: true, action: "workspace-chat-ready", title: "Make this workspace accept runs started from Hermes",
    variant: local ? "local" : "boundary",
    variants: [
      { id: "local", label: "run without the boundary (local use)", recommended: true, available: true, why: "fine on your own machine, for your own requests" },
      { id: "boundary", label: "screen with glm-4-7", recommended: false, available: true, why: "the mid rung of your model ladder, and its key is set" },
    ],
    preview: local
      ? "--- a/roko.toml\n+++ b/roko.toml\n@@ -40,2 +40,2 @@\n [serve.mcp]\n-allow_without_data_llm = false\n+allow_without_data_llm = true"
      : "--- a/roko.toml\n+++ b/roko.toml\n@@ -88,0 +89,3 @@\n+# Added by hermes roko fix workspace-chat-ready\n+[agent.data_llm]\n+model = \"glm-4-7\"",
    path: "/home/demo/code/tally/roko.toml",
    summary: local ? "Lets runs started from Hermes run without roko's data-model boundary." : "Adds roko's data-model boundary: glm-4-7 screens what a run fetched.",
    digest: local ? "digest-local" : "digest-boundary",
    note: "A copy of roko.toml is kept next to it first. roko reads the change at once, with no restart. Commit roko.toml afterwards.",
  };
}

const COMMIT_NEXT = 'commit roko.toml before you merge a run, since the roko page merges only into a checkout without uncommitted changes: git -C /home/demo/code/tally commit -m "roko: accept runs started from Hermes" -- roko.toml';

// --------------------------------------------------------------------------------
// Harness
// --------------------------------------------------------------------------------

const mounted = new Set();

function loadBundle(backend, tweak) {
  const registry = { pages: {}, slots: [] };
  window.__HERMES_PLUGIN_SDK__ = makeSdk(backend.fetchJSON);
  if (tweak) tweak(window.__HERMES_PLUGIN_SDK__);
  window.__HERMES_PLUGINS__ = {
    register(name, component) { registry.pages[name] = component; },
    registerSlot(plugin, slot, component) { registry.slots.push({ plugin, slot, component }); },
  };
  vm.runInContext(BUNDLE_SRC, dom.getInternalVMContext(), { filename: BUNDLE_PATH });
  return registry;
}

async function settle(rounds = 25) {
  await act(async () => {
    for (let i = 0; i < rounds; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mount(component, { url = "http://localhost/roko" } = {}) {
  window.history.replaceState(null, "", url);
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  const handle = {
    container,
    async unmount() {
      await act(async () => root.unmount());
      container.remove();
      mounted.delete(handle);
    },
  };
  mounted.add(handle);
  await act(async () => root.render(h(component)));
  await settle();
  return handle;
}

async function setup({ mode = "normal", url, edit, tweak } = {}) {
  const backend = makeBackend(mode, edit);
  const registry = loadBundle(backend, tweak);
  const page = await mount(registry.pages.roko, { url });
  return { backend, registry, page, container: page.container };
}

async function cleanup() {
  for (const handle of [...mounted]) await handle.unmount();
}

/** The element's text with a space between separate text nodes, the way it reads on screen. */
function text(el) {
  const parts = [];
  const walker = window.document.createTreeWalker(el, 4);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) parts.push(n.nodeValue);
  return parts.join(" ").replace(/\s+/g, " ").trim();
}
function buttons(scope) { return [...scope.querySelectorAll("button")]; }
function button(scope, label) {
  const found = buttons(scope).find((b) => text(b) === label || b.getAttribute("aria-label") === label);
  assert.ok(found, `no button "${label}" in: ${text(scope).slice(0, 300)}`);
  return found;
}
async function click(el) {
  await act(async () => {
    el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
  });
  await settle();
}
async function typeInto(input, value) {
  const proto = input.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}
async function submit(form) {
  await act(async () => {
    form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  });
  await settle();
}
async function press(key, target = window.document.body, extra = {}) {
  await act(async () => {
    target.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...extra }));
  });
  await settle();
}
async function openTab(container, label) {
  const tab = buttons(container).find((b) => b.getAttribute("role") === "tab" && text(b).startsWith(label));
  assert.ok(tab, "no tab " + label);
  await click(tab);
}
/** Open a fold of a run's page by its name (agents, steps, time, changes, receipt, about), as a click on it does. */
async function openFold(container, name) {
  const fold = container.querySelector(`[data-roko="fold-${name}"]`);
  assert.ok(fold, "no fold " + name);
  if (fold.open) return fold;
  await act(async () => {
    fold.open = true;
    fold.dispatchEvent(new window.Event("toggle"));
  });
  await settle();
  return fold;
}
function posts(backend, suffix) {
  return backend.calls.filter((c) => c.method === "POST" && c.url.endsWith(suffix));
}
function node(container, id) {
  return container.querySelector(`[data-roko-node="${id}"]`);
}
function runUrl(id, extra = "") {
  return "http://localhost/roko?run=" + id + extra;
}
/** Plans' sections and their plans' titles, in order, as the lines say them. */
function planSections(container) {
  return [...container.querySelectorAll('[data-roko="plan-list"] .rk-lines-sec')].map(text);
}
function planTitles(container) {
  return [...container.querySelectorAll('[data-roko="plan-line"] .rk-line-title')].map((el) => el.firstChild.textContent);
}
/** Back to Runs, the home, from a run's page: the run's line there (a run that ended), or its card (one that runs). */
async function onRuns(container, id) {
  await click(container.querySelector('[data-roko="crumb-runs"]'));
  return container.querySelector(`[data-roko="run-line"][data-run="${id}"], [data-roko="run-card"][data-run="${id}"]`);
}

// --------------------------------------------------------------------------------
// Registration, the header, the run list
// --------------------------------------------------------------------------------

test("registers the roko page and its three slots, with registerSlot(plugin, slot, component)", async () => {
  const backend = makeBackend();
  const registry = loadBundle(backend);
  assert.equal(typeof registry.pages.roko, "function");
  const slots = registry.slots.map((s) => [s.plugin, s.slot, typeof s.component]);
  // 0.9 (roko's design system §4.9): the chip, and one line above the sessions and the chat while a run goes.
  assert.deepEqual(slots, [
    ["roko", "header-right", "function"],
    ["roko", "sessions:top", "function"],
    ["roko", "chat:top", "function"],
  ]);
});

test("the header: the wordmark, today on the glass, new run; Runs is the home: what needs you, what runs, what ran", async () => {
  const { container } = await setup();
  try {
    const head = container.querySelector('[data-roko="status"]');
    // roko's state and address are for its tooltip and assistive tech: the header says it only when it isn't fine.
    assert.match(text(head.querySelector('[data-roko="roko-connection"]')), /^roko · v0\.1\.0 · ok · http:/);
    assert.equal(head.querySelector(".rk-head-trouble"), null);
    // P-3: the counter counts the runs started from this Hermes, and says so; roko's whole day only when it is known.
    // Phase 2's S2 stills: the line keeps what live runs hold and what is left; the glass's title has the limit too.
    assert.equal(text(head.querySelector('[data-roko="spend-words"]')), "$0.48 from Hermes · $1.46 held · $18.06 left");
    assert.match(head.querySelector('[data-roko="roko-today"]').getAttribute("title"), /limit \$20\.00 a day/);
    assert.equal(text(head.querySelector('[data-roko="roko-today"] .rk-dots .rk-sr')), "$0.48 from Hermes");
    // Two things wait on the person: the orange is theirs, so new run is a plain key.
    assert.ok(!button(container, "New run").classList.contains("rk-key--you"));
    const home = container.querySelector('[data-roko="runs-home"]');
    assert.deepEqual([...home.querySelectorAll(".rk-home-h")].map(text), ["Needs you · 2", "Running", "Earlier"]);
    assert.equal(home.querySelectorAll('[data-roko="needs-you"] [data-roko-pending]').length, 2);
    assert.deepEqual([...home.querySelectorAll('[data-roko="run-card"]')].map((c) => c.getAttribute("data-run")).sort(), [IDS.confirm, IDS.live].sort());
    // What ran, a line each, newest first; a run's page opens from its line.
    const lines = [...home.querySelectorAll('[data-roko="run-line"]')];
    assert.deepEqual(lines.map((l) => l.getAttribute("data-run")), [IDS.missing, IDS.multiwave, IDS.prompt, IDS.cancelled, IDS.failed]);
    await click(lines[2]);
    assert.ok(window.location.search.includes("run=" + IDS.prompt));
    assert.equal(text(container.querySelector(".rk-crumb")), "Runs › Add a --json flag to tally");
    await click(container.querySelector('[data-roko="crumb-runs"]'));
    assert.ok(container.querySelector('[data-roko="runs-home"]'), "the crumb comes back to Runs");
  } finally {
    await cleanup();
  }
});

test("P-3: today's spend reads the same in the header, the composer and the chip, with roko's whole day when known", async () => {
  const edit = (fx) => { Object.assign(fx.overview.spend, { today_usd: 0.2, from: "hermes", roko_today_usd: 0.56 }); };
  const { container } = await setup({ edit });
  try {
    assert.match(text(container.querySelector('[data-roko="status"] [data-roko="spend-words"]')), /^\$0\.20 from Hermes · \$0\.56 in roko today · /);
    await click(button(container, "New run"));
    assert.match(text(container.querySelector(".roko-composer-limits")), /^\$0\.20 from Hermes · \$0\.56 in roko today · limit \$20\.00 a day · at most \$5\.00 per run$/);
  } finally {
    await cleanup();
  }
  const registry = loadBundle(makeBackend("normal", edit));
  try {
    const chip = await mount(registry.slots.find((s) => s.slot === "header-right").component, { url: "http://localhost/sessions" });
    assert.match(chip.container.querySelector('[data-roko="chip"]').getAttribute("title"), /\$0\.20 from Hermes · \$0\.56 in roko today/);
  } finally {
    await cleanup();
  }
});

// --------------------------------------------------------------------------------
// A live run: hero, now, graph, inspector
// --------------------------------------------------------------------------------

test("a live plan run: its head (the pill, the glass's readings, one sentence, stop), what its agents do, the graph's states", async () => {
  const { container, backend } = await setup({ url: runUrl(IDS.live) });
  try {
    const hero = container.querySelector('[data-roko="hero"]');
    assert.equal(text(hero.querySelector('[data-roko="card-pill"]')), "running");
    assert.equal(text(hero.querySelector(".rk-runhead-title")), "Add per-category budgets to tally");
    assert.equal(text(hero.querySelector('[data-roko="card-tasks"] .rk-dots .rk-sr')), "2 of 5 tasks passed, 1 running");
    assert.equal(text(hero.querySelector('[data-roko="card-spent"] .rk-dots .rk-sr')), "spent $0.04 of $1.00");
    assert.match(text(hero.querySelector('[data-roko="card-eta"]')), /^~3 min left/);
    assert.equal(text(hero.querySelector('[data-roko="stop"]')), "stop");
    // While it runs, what its agents do is open: the horizon, and the stream under it.
    assert.equal(container.querySelector('[data-roko="fold-agents"]').open, true);
    assert.match(text(container.querySelector(".roko-now")), /Task 2 agent · glm-5\.1 \d+:\d\d/);
    const states = Object.fromEntries(["T1", "T2", "T3", "T4", "T5"].map((id) => [id, node(container, id).getAttribute("data-state")]));
    assert.deepEqual(states, { T1: "passed", T2: "running", T3: "pending", T4: "passed", T5: "pending" });
    // A pad says its number (§4.7): 03, "after 02, 03"; its label the task's name.
    assert.equal(text(node(container, "T3").querySelector(".roko-node-id")), "03");
    assert.match(node(container, "T3").getAttribute("aria-label"), /^Task 3, waiting/);
    assert.match(text(node(container, "T5")), /after 02, 03/);
    assert.ok(container.querySelector(".roko-edge.is-flow .roko-edge-flow"), "the edge into the running task flows");
    assert.equal(container.querySelectorAll(".roko-graph-wave").length, 4, "four waves");
    // The timeline: the last 400 lines first.
    assert.ok(backend.calls.some((c) => c.url === "/api/plugins/roko/runs/" + IDS.live + "/events?tail=400"));
  } finally {
    await cleanup();
  }
});

test("clicking a task opens the inspector: attempts, checks with output, the agent's last word", async () => {
  const { container } = await setup({ url: runUrl(IDS.live) });
  try {
    await click(node(container, "T1"));
    const inspector = container.querySelector('[data-roko-inspector="T1"]');
    assert.ok(inspector, "T1's inspector");
    assert.match(text(inspector), /Add BudgetStore persistence module/);
    assert.match(text(inspector), /#1 glm-5\.1/);
    assert.match(text(inspector), /✓ verify\[0:test\]/);
    assert.match(text(inspector), /The implementation is complete/);
    const check = [...inspector.querySelectorAll(".roko-checkrow-head")].find((b) => text(b).includes("rung[test]"));
    await click(check);
    assert.match(text(inspector), /python3 -m unittest discover/);
    await press("Escape");
    assert.equal(container.querySelector('[data-roko-inspector="T1"]'), null, "Esc closes it");
  } finally {
    await cleanup();
  }
});

test("a retry that has not reached its checks shows none of the attempt before's verdicts", async () => {
  // Live end-to-end, 2026-10-13: attempt 5 of a task was still with its agent, and the graph showed
  // attempt 4's failed check as if attempt 5 had run it.
  const { container } = await setup({
    url: runUrl(IDS.live),
    edit: (fx) => {
      const t2 = fx.runs[IDS.live].run.tasks.find((t) => t.task_id === "T2");
      t2.attempts = 2;
      t2.gates = [{ gate: "verify[0:test]", passed: false, excerpt: "FAILED", runs: 1 }];
      t2.attempt_log = [
        { attempt: 1, model: "glm-5.1", provider: "zai", started_at: t2.started_at, gates: [{ gate: "verify[0:test]", passed: false }] },
        { attempt: 2, model: "glm-5.1", provider: "zai", started_at: t2.started_at, gates: [] },
      ];
    },
  });
  try {
    const t2 = node(container, "T2");
    assert.equal(t2.getAttribute("data-state"), "running");
    const pips = t2.querySelector(".roko-pips");
    assert.ok(!pips || !/did not pass/.test(pips.getAttribute("aria-label")), "no verdict from attempt 1 on attempt 2");
  } finally {
    await cleanup();
  }
});

test("a failed run explains why, with the key line, and shows what it blocked", async () => {
  const { container } = await setup({ url: runUrl(IDS.failed) });
  try {
    const why = container.querySelector('[data-roko="why"]');
    assert.ok(why);
    assert.match(text(why), /Why it did not pass/i);
    assert.match(text(why), /T1's check verify\[0:compile\] did not pass, all 6 times it ran/);
    assert.match(text(why.querySelector(".roko-why-key")), /python: command not found/);
    assert.equal(node(container, "T1").getAttribute("data-state"), "failed");
    assert.match(text(node(container, "T1")), /×6/);
    for (const id of ["T2", "T3", "T4", "T5"]) {
      assert.equal(node(container, id).getAttribute("data-state"), "blocked");
      assert.match(text(node(container, id)), /blocked by 01/);
    }
    // The failed check opens with its key line in the inspector.
    const inspector = container.querySelector('[data-roko-inspector="T1"]');
    assert.ok(inspector, "the failed task is inspected first");
    assert.match(text(inspector.querySelector(".roko-keyline")), /python: command not found/);
    assert.equal(inspector.querySelectorAll(".roko-attempt").length, 6);
  } finally {
    await cleanup();
  }
});

test("a cancelled run says what was done, and the task that never started is stopped", async () => {
  const { container } = await setup({ url: runUrl(IDS.cancelled) });
  try {
    assert.match(text(container.querySelector('[data-roko="why"]')), /The run was cancelled while T3 ran\. T1, T2 and T4 had passed before that\. T5 never started\./);
    assert.equal(node(container, "T5").getAttribute("data-state"), "stopped");
    assert.equal(node(container, "T1").getAttribute("data-state"), "passed");
    // roko reports the task the cancel interrupted as failed (bug-1d09e8); its error says it was cancelled.
    assert.equal(node(container, "T3").getAttribute("data-state"), "stopped");
    assert.match(text(container.querySelector('[data-roko="hero"]')), /3 of 5 tasks passed/);
    assert.doesNotMatch(text(container.querySelector('[data-roko="hero"]')), /did not pass/);
    assert.equal(container.querySelector('[data-roko="why-cancelled"]'), null, "nobody in Hermes cancelled it");
  } finally {
    await cleanup();
  }
  // P-1: the chat's model cancelled it, with the person's reason: said first, then what was done. A cancel from a page
  // with no reason names the page alone.
  for (const [by, reason, said] of [["chat", "the person asked to stop", "cancelled from chat: the person asked to stop"], ["page", null, "cancelled from this page"]]) {
    const cancelled = await setup({
      url: runUrl(IDS.cancelled),
      edit: (fx) => { fx.runs[IDS.cancelled].run.cancelled_by = { by, reason, at: new Date().toISOString() }; },
    });
    try {
      const why = cancelled.container.querySelector('[data-roko="why"]');
      assert.equal(text(why.querySelector('[data-roko="why-cancelled"]')), said);
      assert.match(text(why), /^Why it stopped cancelled from .* The run was cancelled while T3 ran\./);
    } finally {
      await cleanup();
    }
  }
});

test("a run roko has no record of is shown as missing, never as a success", async () => {
  const { container } = await setup({ url: runUrl(IDS.missing) });
  try {
    assert.match(text(container.querySelector('[data-roko="why"]')), /Where this run went.*no record of this run/);
  } finally {
    await cleanup();
  }
  const home = await setup();
  try {
    const line = home.container.querySelector(`[data-roko="run-line"][data-run="${IDS.missing}"]`);
    assert.equal(line.getAttribute("data-state"), "stop");
    assert.match(text(line), /Summarise last week's commits not started/);
    assert.ok(text(line).includes("—"), "unknown cost is —, not $0.00");
    assert.ok(!text(line).includes("$0.00"));
  } finally {
    await cleanup();
  }
});

// --------------------------------------------------------------------------------
// Replay and activity
// --------------------------------------------------------------------------------

test("replay: scrubbing a finished run rebuilds each task's state at that moment", async () => {
  const { container } = await setup({ url: runUrl(IDS.multiwave) });
  try {
    const range = container.querySelector(".roko-replay-range");
    assert.ok(range, "a finished run has a replay bar");
    assert.deepEqual(["T1", "T2", "T3", "T4", "T5"].map((id) => node(container, id).getAttribute("data-state")), Array(5).fill("passed"));
    await typeInto(range, "100"); // 10 % in: T1 at work, the rest not started
    await settle();
    assert.equal(node(container, "T1").getAttribute("data-state"), "running");
    assert.equal(node(container, "T2").getAttribute("data-state"), "pending");
    assert.ok(container.querySelector(".roko-graph.is-replaying"));
    assert.match(text(container.querySelector(".roko-replay-time")), /^\+0:4\d \/ 7:1\d$/);
    await typeInto(range, "500"); // half way: T1, T2 and T4 passed, T3 at work, T5 waiting
    await settle();
    const half = ["T1", "T2", "T3", "T4", "T5"].map((id) => node(container, id).getAttribute("data-state"));
    assert.deepEqual(half, ["passed", "passed", "running", "passed", "pending"]);
    assert.match(text(container.querySelector('[data-roko="stream"] .rk-stream-head')), /at this moment/i);
    await click(button(container, "Show the end"));
    assert.equal(container.querySelector(".roko-graph.is-replaying"), null);
  } finally {
    await cleanup();
  }
});

test("Activity: every line, relative times, filters by kind, agent notes as quotes", async () => {
  const { container } = await setup({ url: runUrl(IDS.failed) });
  try {
    // Every step is a fold of the run's page.
    await openFold(container, "steps");
    assert.ok(window.location.search.includes("view=activity"), "a link back opens it again");
    const lines = container.querySelectorAll(".roko-feedline");
    assert.ok(lines.length >= 30, "the timeline lines: " + lines.length);
    assert.match(text(lines[0]), /^\+0:00/);
    assert.ok([...lines].some((l) => l.querySelector(".roko-feed-quote")), "an agent's words as a quote");
    await click(buttons(container).find((b) => text(b).startsWith("Problems")));
    const problems = [...container.querySelectorAll(".roko-feedline")].map((l) => text(l));
    assert.ok(problems.length >= 7 && problems.every((t) => /did not pass|blocked|error|failed/.test(t)), problems.join(" | "));
  } finally {
    await cleanup();
  }
});

// --------------------------------------------------------------------------------
// Changes and Merge
// --------------------------------------------------------------------------------

test("Changes: the diff file by file, with line numbers, and tinted code as text", async () => {
  const { container, backend } = await setup({ url: runUrl(IDS.multiwave, "&view=changes") });
  try {
    assert.ok(backend.calls.some((c) => c.url === "/api/plugins/roko/runs/" + IDS.multiwave + "/diff"));
    const diff = container.querySelector('[data-roko="diff"]');
    assert.ok(diff, "the Changes tab opened from the URL");
    assert.match(text(container.querySelector(".roko-changes-head")), /\+299 −5 in 9 files/);
    const items = diff.querySelectorAll(".roko-diff-fileitem");
    assert.equal(items.length, 9);
    assert.match(text(items[0]), /A budgets\.py tally\/ \+50 −0/);
    const file = diff.querySelector('[data-roko-file="tally/budgets.py"]');
    const first = file.querySelector(".roko-dl--add");
    assert.deepEqual([...first.querySelectorAll(".roko-dl-no")].map((n) => text(n)), ["", "1"]);
    assert.ok(file.querySelector(".roko-tk-kw"), "keywords are tinted");
    assert.equal(file.querySelectorAll("script, img").length, 0);
    // The fold says the size of the change.
    assert.equal(text(container.querySelector('[data-roko="fold-changes"] > summary')), "the changes · +299 −5");
  } finally {
    await cleanup();
  }
});

test("Merge: a guarded dialog, the reviewed commit in the request, then the undo command", async () => {
  const { container, backend } = await setup({ url: runUrl(IDS.prompt, "&view=changes") });
  try {
    assert.match(text(container.querySelector(".roko-mergebox")), /Ready to merge into main fast-forward · 243489f/);
    assert.equal(posts(backend, "/merge").length, 0);
    // The changes' one orange key; the head's review key steps aside while they are open.
    assert.equal(container.querySelector('[data-roko="hero-review"]'), null);
    await click(button(container, "merge into main"));
    const dialog = container.querySelector('[data-roko="merge"]');
    assert.ok(dialog, "the merge dialog");
    assert.match(text(dialog), /Merge into main\?/);
    assert.match(text(dialog), /1 file \+4 −1 fast-forward/);
    assert.match(text(dialog), /tally\/cli\.py/);
    await click(dialog.querySelector('[data-confirm="merge"]'));
    const sent = posts(backend, "/runs/" + IDS.prompt + "/merge");
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].body, { commit: "243489f88add54ef6174c6c6c36d2167c4deaab4" });
    assert.match(text(container.querySelector('[data-roko="merge"]')), /Merged into main/);
    assert.match(text(container.querySelector('[data-roko="merge"]')), /reset --keep b379ff451fe9/);
    assert.match(text(container), /Merged “Add a --json flag to tally” into main/);
  } finally {
    await cleanup();
  }
});

test("Merge: a refusal stays in the dialog with roko's reason; a run that cannot merge gives the command", async () => {
  const { container, backend } = await setup({
    url: runUrl(IDS.prompt, "&view=changes"),
    edit: (fx) => {
      fx.merge_result = { ok: false, error: { code: "conflict", message: "the run's branch moved since you reviewed it, so nothing was merged", hint: "review the changes again, then merge" } };
    },
  });
  try {
    await click(button(container, "merge into main"));
    await click(container.querySelector('[data-confirm="merge"]'));
    const dialog = container.querySelector('[data-roko="merge"]');
    assert.ok(dialog, "still open");
    assert.match(text(dialog), /moved since you reviewed it/);
    assert.match(text(dialog), /review the changes again/);
    assert.equal(posts(backend, "/merge").length, 1);
  } finally {
    await cleanup();
  }
  const blocked = await setup({
    url: runUrl(IDS.multiwave, "&view=changes"),
    edit: (fx) => {
      fx.merges[IDS.multiwave] = { ok: true, merge: { can_merge: false, merged: false, reason: "the checkout has uncommitted changes to 2 tracked files; commit or stash them first", command: "git -C /home/demo/code/tally merge roko/batch/x" } };
    },
  });
  try {
    const box = blocked.container.querySelector(".roko-mergebox");
    assert.match(text(box), /Merge it by hand.*uncommitted changes to 2 tracked files/);
    assert.match(text(box), /git -C \/home\/demo\/code\/tally merge roko\/batch\/x/);
    assert.equal(blocked.container.querySelector('[data-roko="merge-key"]'), null);
  } finally {
    await cleanup();
  }
});

test("Merge: a demo's run offers no Merge; its output stays on its run branch", async () => {
  const { container, backend } = await setup({
    url: runUrl(IDS.multiwave, "&view=changes"),
    edit: (fx) => { fx.plans.plans.forEach((p) => { if (p.id === IDS.plan) p.group = "demos"; }); },
  });
  try {
    assert.match(text(container.querySelector('[data-roko="demo-output"]')), /Demo output: it stays on its run branch/);
    // Why never merge it: what roko does with a re-run whose output is already there (dogfood-will G3).
    assert.match(text(container.querySelector('[data-roko="demo-output"]')), /a later run of the demo would find its check already passing and have nothing new to show\./);
    assert.ok(!/refuses/.test(text(container.querySelector('[data-roko="demo-output"]'))));
    assert.equal(container.querySelector('[data-roko="merge-key"]'), null);
    assert.ok(!backend.calls.some((c) => c.url === "/api/plugins/roko/runs/" + IDS.multiwave + "/merge"), "no merge check for a demo");
    assert.match(text(container.querySelector(".roko-delivered")), /demo output, stays on its branch/);
  } finally {
    await cleanup();
  }
});

test("an interrupted run (roko stopped mid-run) reads as its own outcome: its reason, what a resume may do, no Merge", async () => {
  const reason = "roko stopped while this run was going (machine restart or crash)";
  const note = "A resume continues where roko can, but if a task was stopped mid-call roko may start the run over and run passed tasks again (a known roko defect, being fixed).";
  const edit = (fx) => {
    const card = fx.runs[IDS.multiwave].run;
    const next = { action: "rerun", label: "resume the plan", resume: true, why: reason, note: note };
    Object.assign(card, { state: "interrupted", verdict: "interrupted", active: false, interrupted: { reason: reason, at: card.finished_at }, next: next });
    fx.overview.runs.forEach((row) => { if (row.run_id === IDS.multiwave) Object.assign(row, { state: "interrupted", active: false }); });
  };
  const { container, backend } = await setup({ url: runUrl(IDS.multiwave), edit: edit });
  try {
    const why = container.querySelector('[data-roko="why"]');
    assert.match(text(why), /roko stopped mid-run/);
    assert.match(text(why), /roko stopped while this run was going \(machine restart or crash\)/);
    // P-51, softened by the lead from roko-recovery's kill matrix: what a resume may do, in the backend's words.
    assert.equal(text(why.querySelector('[data-roko="why-next"]')), note);
    await openFold(container, "changes");
    assert.match(text(container.querySelector(".roko-delivered")), /interrupted: kept on its branch/);
    assert.match(text(container.querySelector('[data-roko="interrupted-output"]')), /Nothing verified to merge/);
    assert.equal(text(container.querySelector('[data-roko="interrupted-output"] .roko-dim')), "roko stopped before this run's checks finished. " + note);
    assert.equal(container.querySelector('[data-roko="merge-key"]'), null);
    assert.ok(!backend.calls.some((c) => c.url === "/api/plugins/roko/runs/" + IDS.multiwave + "/merge"), "no merge check");
  } finally {
    await cleanup();
  }
});

// --------------------------------------------------------------------------------
// The composer
// --------------------------------------------------------------------------------

test("Composer: n opens it; it needs a request; it posts the prompt, cap and title, then opens the run", async () => {
  const { container, backend } = await setup();
  try {
    await press("n");
    const dialog = container.querySelector('[data-roko="composer"]');
    assert.ok(dialog, "n opened the composer");
    const start = dialog.querySelector('[data-roko="composer-submit"]');
    assert.ok(start.disabled, "nothing to start yet");
    // The desktop's composer: the text box, run it or plan first with the cap's presets, a sentence, the rest in more.
    assert.equal(dialog.querySelectorAll(".rk-module-idx").length, 0, "no numbered modules");
    assert.equal(text(dialog.querySelector('[data-roko="composer-note"]')), "roko's agent works on its own branch; your project's checks must pass before roko calls it done.");
    const more = dialog.querySelector('[data-roko="composer-more"]');
    assert.equal(more.open, false, "where it starts, the kind of work, the exact cap and a name are folded");
    await click(dialog.querySelector(".roko-example"));
    assert.match(dialog.querySelector("textarea").value, /--json flag/);
    await typeInto(dialog.querySelector("textarea"), "Add a --json flag to tally's balance command, with a test");
    await click(more.querySelector("summary"));
    await typeInto(more.querySelector('input[aria-label="Title"]'), "JSON balances");
    await click([...dialog.querySelectorAll('[data-roko="cap-presets"] button')].find((b) => text(b) === "$1"));
    assert.equal(text(start), "start · cap $1.00 ⌘↵");
    await click(dialog.querySelector('[data-roko="composer-submit"]'));
    const sent = posts(backend, "/runs");
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].body, { prompt: "Add a --json flag to tally's balance command, with a test", title: "JSON balances", max_usd: 1 });
    assert.equal(container.querySelector('[data-roko="composer"]'), null, "closed");
    assert.ok(backend.calls.some((c) => c.url === "/api/plugins/roko/runs/" + backend.fx.started.run_id), "the new run opens");
    assert.equal(text(container.querySelector("[data-toast]")), "Started “JSON balances” · cap $1.00", "the toast names the run by its words, not its id");
  } finally {
    await cleanup();
  }
});

test("Composer: Plan it first posts plan:true with no cap; Ctrl+Enter submits; caps stop at what is left", async () => {
  const { container, backend } = await setup({ edit: (fx) => { fx.overview.spend.left_usd = 0.4; } });
  try {
    await click(button(container, "New run"));
    const dialog = container.querySelector('[data-roko="composer"]');
    const presets = [...dialog.querySelectorAll('[data-roko="cap-presets"] button')];
    assert.deepEqual(presets.map(text), ["$0.25"], "only caps under the $0.40 left");
    assert.equal(presets[0].getAttribute("aria-pressed"), "true", "the default cap fits");
    await click(buttons(dialog).find((b) => b.getAttribute("role") === "radio" && text(b).startsWith("plan first")));
    assert.ok(!dialog.querySelector('[data-roko="cap-presets"]'), "writing a plan takes no cap from this roko");
    assert.equal(text(dialog.querySelector('[data-roko="composer-note"]')), "Writing the plan spends a little, up to roko's own limit for plan writing, and runs nothing. You start it when it looks right.");
    assert.equal(text(dialog.querySelector('[data-roko="composer-submit"]')), "write plan ⌘↵");
    await typeInto(dialog.querySelector("textarea"), "Split the ledger into accounts and transactions modules");
    await press("Enter", dialog.querySelector("textarea"), { ctrlKey: true });
    const sent = posts(backend, "/runs");
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].body, { prompt: "Split the ledger into accounts and transactions modules", plan: true });
  } finally {
    await cleanup();
  }
});

test("Composer: roko's refusal stays in the dialog", async () => {
  const { container } = await setup({
    edit: (fx) => { fx.started = { ok: false, error: { code: "refused", message: "starting this run could take today's roko spend to $20.10, over the $20.00 daily limit", hint: "name a smaller cap" } }; },
  });
  try {
    await click(button(container, "New run"));
    const dialog = container.querySelector('[data-roko="composer"]');
    await typeInto(dialog.querySelector("textarea"), "Write the docs");
    await click(dialog.querySelector('[data-roko="composer-submit"]'));
    assert.ok(container.querySelector('[data-roko="composer"]'), "still open");
    assert.match(text(container.querySelector('[data-roko="composer"]')), /over the \$20\.00 daily limit.*name a smaller cap/);
  } finally {
    await cleanup();
  }
});

// --------------------------------------------------------------------------------
// What waits on the person
// --------------------------------------------------------------------------------

test("a run that waits on its sign-off says so in the now strip and on the task", async () => {
  const { container } = await setup({ url: runUrl(IDS.confirm) });
  try {
    assert.match(text(container.querySelector(".roko-now")), /Task 1 waits for your sign-off/);
    assert.ok(node(container, "T1").className.includes("is-held"));
    assert.match(text(node(container, "T1")), /waits on you/);
    const card = container.querySelector('[data-roko="run-waiting"] [data-roko-pending]');
    assert.ok(card);
    assert.match(text(card), /Is this what you asked for\?/);
    assert.match(text(card.querySelector(".roko-doc-head")), /REPORT\.md/);
  } finally {
    await cleanup();
  }
});

test("orange means you: a run that waits on the person is orange on its card, the hero, its strip and the now label", async () => {
  const home = await setup();
  try {
    const card = home.container.querySelector(`[data-roko="run-card"][data-run="${IDS.confirm}"]`);
    assert.equal(card.getAttribute("data-state"), "you");
    const pill = card.querySelector('[data-roko="card-pill"]');
    assert.equal(text(pill), "needs you");
    assert.equal(pill.getAttribute("data-blink"), "fast");
    assert.ok(card.querySelector('.rk-rc-strip i[data-state="you"]'), "its running task is what waits");
    assert.match(text(card.querySelector('[data-roko="card-status"]')), /^roko asks: /);
    assert.equal(text(card.querySelector('[data-roko="card-answer"]')), "answer");
    // A live run that waits on nobody stays blue: the live channel (an agent is working now).
    const live = home.container.querySelector(`[data-roko="run-card"][data-run="${IDS.live}"]`);
    assert.equal(live.getAttribute("data-state"), "live");
    assert.equal(live.querySelector('.rk-rc-strip i[data-state="you"]'), null);
  } finally {
    await cleanup();
  }
  const { container } = await setup({ url: runUrl(IDS.confirm) });
  try {
    const hero = container.querySelector('[data-roko="hero"]');
    assert.equal(hero.getAttribute("data-state"), "you");
    assert.equal(text(hero.querySelector('[data-roko="card-pill"]')), "needs you");
    assert.ok(hero.querySelector('.rk-rc-strip i[data-state="you"]'), "the glass's strip");
    assert.equal(container.querySelector(".roko-now-label").getAttribute("data-ch"), "you");
  } finally {
    await cleanup();
  }
});

test("Needs you: Approve posts the code, approve and the note; the deadline is roko's", async () => {
  // An old link to Waiting opens Runs, where what needs the person comes first.
  const { container, backend } = await setup({ url: "http://localhost/roko?section=waiting" });
  try {
    const confirm = backend.fx.pending.items.find((i) => i.kind === "confirm");
    const card = container.querySelector(`[data-roko="needs-you"] [data-roko-pending="${confirm.code}"]`);
    assert.ok(card, "the sign-off is listed");
    assert.equal(text(card.querySelector('[data-roko="card-pill"]')), "needs you");
    assert.equal(card.querySelector(".roko-pending-title").getAttribute("title"), "In any chat: /roko approve " + confirm.code);
    assert.doesNotMatch(text(card), new RegExp(confirm.code), "the code is for the chat: not on the card");
    assert.match(text(card.querySelector('[data-roko="countdown"] .rk-sr')), /^(29|30):\d\d left, then unverified$/, "roko's 30-minute wait");
    const effect = backend.fx.pending.items.find((i) => i.kind === "effect");
    const effectCard = container.querySelector(`[data-roko="needs-you"] [data-roko-pending="${effect.code}"]`);
    assert.equal(text(effectCard.querySelector('[data-roko="card-pill"]')), "held call");
    assert.match(text(effectCard), /mail\.send on mail/);
    assert.match(text(effectCard), /to: string/);
    assert.equal(effectCard.querySelector('[data-roko="countdown"]'), null, "no deadline, no countdown");
    await typeInto(card.querySelector("input"), "looks right");
    await click(button(card, "Approve " + confirm.code));
    assert.deepEqual(posts(backend, "/decide")[0].body, { code: confirm.code, approve: true, note: "looks right" });
    assert.match(text(container), /Approved the result of task T1/);
    assert.doesNotMatch(text(container), /\(approved\)/, "roko's outcome only when it adds to the verb");
    assert.equal(container.querySelector(`[data-roko="needs-you"] [data-roko-pending="${confirm.code}"]`), null, "an answered item leaves");
  } finally {
    await cleanup();
  }
});

test("Needs you: Decline posts approve false without an empty note; a passed deadline says so", async () => {
  const { container, backend } = await setup({
    edit: (fx) => { fx.pending.items.find((i) => i.kind === "confirm").deadline_at = new Date(Date.now() - 5_000).toISOString(); },
  });
  try {
    const confirm = backend.fx.pending.items.find((i) => i.kind === "confirm");
    const card = container.querySelector(`[data-roko="needs-you"] [data-roko-pending="${confirm.code}"]`);
    assert.match(text(card.querySelector('[data-roko="countdown"]')), /time is up · unverified/);
    await click(button(card, "Decline " + confirm.code));
    assert.deepEqual(posts(backend, "/decide")[0].body, { code: confirm.code, approve: false });
  } finally {
    await cleanup();
  }
});

// --------------------------------------------------------------------------------
// Plans
// --------------------------------------------------------------------------------

test("Plans: the plan as a graph, its stats and estimate; a task opens with its checks", async () => {
  const { container } = await setup({ url: "http://localhost/roko?section=plans&plan=" + IDS.plan });
  try {
    const plan = container.querySelector('[data-roko="plan"]');
    assert.ok(plan);
    assert.match(text(plan), /Per-category budgets for tally/);
    assert.equal(text(plan.querySelector('[data-roko="plan-count"]')), "tasks 5 tasks 5 checks");
    assert.equal(text(plan.querySelector('[data-roko="plan-waves"]')), "steps 4 steps each step waits for the one before");
    assert.ok(plan.querySelector(".roko-graph.is-planned"));
    assert.equal(plan.querySelectorAll(".roko-node.is-planned").length, 5);
    assert.match(text(node(plan, "T3")), /implementer · 1 check/);
    await click(node(plan, "T3"));
    assert.match(text(plan.querySelector(".roko-inspector")), /Checks that must pass/);
    assert.match(text(plan.querySelector(".roko-inspector")), /after T1, T2/);
  } finally {
    await cleanup();
  }
});

test("P-59: a task's checks are counted whole, and a cut list says how many more", async () => {
  const { container } = await setup({
    url: "http://localhost/roko?section=plans&plan=" + IDS.plan,
    edit: (fx) => {
      // roko_plans' first four, and roko's count of six: the plan sheet could not read the task's own list.
      const t3 = fx.plan_details[IDS.plan].plan.tasks.find((t) => t.id === "T3");
      Object.assign(t3, { checks: ["c1", "c2", "c3", "c4"], check_count: 6, verify: [] });
    },
  });
  try {
    const plan = container.querySelector('[data-roko="plan"]');
    assert.match(text(node(plan, "T3")), /implementer · 6 checks/);
    assert.equal(text(plan.querySelector('[data-roko="plan-count"]')), "tasks 5 tasks 10 checks");
    await click(node(plan, "T3"));
    assert.equal(plan.querySelectorAll(".roko-inspector .roko-checks li").length, 5);
    assert.equal(text(plan.querySelector('[data-roko="checks-more"]')), "and 2 more");
  } finally {
    await cleanup();
  }
});

test("Plans: Run plan posts the cap after a confirm, a chip sets the cap, and the new run opens", async () => {
  const { container, backend } = await setup({ url: "http://localhost/roko?section=plans&plan=" + IDS.plan });
  try {
    const form = container.querySelector(".roko-runform");
    assert.equal(text(form.querySelector(".roko-run-limits")), "at most $5.00 per run · $18.06 left today");
    await click(buttons(form).find((b) => text(b) === "$2.00"));
    assert.equal(form.querySelector('[data-roko="knob"]').getAttribute("aria-valuenow"), "2");
    assert.equal(text(form.querySelector('[data-roko="run-plan"]')), "run plan · cap $2.00");
    await click(form.querySelector('input[type="checkbox"]'));
    await submit(form);
    assert.equal(posts(backend, "/run").length, 0, "nothing starts before the confirm");
    const dialog = container.querySelector('[role="alertdialog"]');
    assert.match(text(dialog), /may spend up to \$2\.00/);
    await click(dialog.querySelector('[data-confirm="yes"]'));
    assert.deepEqual(posts(backend, "/plans/" + IDS.plan + "/run")[0].body, { max_usd: 2, resume: true });
    assert.ok(backend.calls.some((c) => c.url === "/api/plugins/roko/runs/" + backend.fx.started.run_id));
  } finally {
    await cleanup();
  }
});

test("Plans: the demos come first, the one to start with on top; a plan opens its page when picked", async () => {
  const { container, backend } = await setup({
    url: "http://localhost/roko?section=plans",
    edit: (fx) => {
      fx.plans.plans[1].group = "tally-programme";
      fx.plans.plans = fx.plans.plans.concat([
        { id: "demo-hello", title: "Roko plan-runner demo", task_count: 1, tasks_done: 1, status: "done", group: "demos" },
        { id: "demo-hello-world", title: "Start here: hello world demo", task_count: 1, tasks_done: 0, status: "fixture", group: "demos/parallel-plans" },
      ]);
      fx.plans.total = fx.plans.plans.length;
      fx.plan_details["demo-hello-world"] = {
        ok: true,
        plan: {
          plan_id: "demo-hello-world",
          title: "Start here: hello world demo",
          task_count: 1,
          tasks: [{ id: "HELLO-1", title: "Write a Rust program that prints hello world", depends_on: [], checks: [] }],
          waves: [["HELLO-1"]],
        },
      };
    },
  });
  try {
    const plans = container.querySelector('[data-roko="plan-list"]');
    assert.deepEqual(planSections(container), ["Demos", "Your plans", "tally-programme"]);
    assert.deepEqual(planTitles(container), [
      "Start here: hello world demo",
      "Roko plan-runner demo",
      "Per-category budgets for tally",
      "Per-category budgets for tally",
    ]);
    const first = plans.querySelector('[data-roko-plan="demo-hello-world"]');
    assert.match(text(first), /start here/);
    assert.equal(text(first.querySelector(".rk-line-glyph")), "◇", "a demo's mark, not roko's fixture marker");
    assert.doesNotMatch(text(first), /fixture/);
    // Nothing opens by itself: a plan opens its page when the person picks it.
    assert.equal(container.querySelector('[data-roko="plan"]'), null);
    assert.ok(!backend.calls.some((c) => c.url.indexOf("/plans/") >= 0), "no plan read until one is picked");
    await click(first);
    assert.match(text(container.querySelector('[data-roko="plan"] .rk-runhead-title')), /Start here: hello world demo/);
    assert.equal(text(container.querySelector(".rk-crumb")), "Plans › Start here: hello world demo");
  } finally {
    await cleanup();
  }
});

test("Plans: a demo stays a demo after its run by its set; without any set (an older roko) a demo- id is the sign", async () => {
  const listing = [
    { id: "add-tests", title: "Add tests", task_count: 3, tasks_done: 1, status: "ready", group: "work" },
    { id: "demo-mine", title: "My own demo plan", task_count: 1, tasks_done: 0, status: "ready" },
    { id: "demo-hello", title: "Roko plan-runner demo", task_count: 1, tasks_done: 1, status: "done", group: "demos" },
  ];
  const heads = (c) => planSections(c);
  const labels = (c) => planTitles(c);
  const known = await setup({ url: "http://localhost/roko?section=plans", edit: (fx) => { fx.plans = { ok: true, plans: listing, total: 3 }; } });
  try {
    assert.deepEqual(heads(known.container), ["Demos", "Your plans", "work"]);
    assert.deepEqual(labels(known.container), ["Roko plan-runner demo", "My own demo plan", "Add tests"]);
  } finally {
    await cleanup();
  }
  const older = listing.map((p) => { const { group, ...rest } = p; return rest; });
  const old = await setup({ url: "http://localhost/roko?section=plans", edit: (fx) => { fx.plans = { ok: true, plans: older, total: 3 }; } });
  try {
    assert.deepEqual(heads(old.container), ["Demos", "Your plans"]);
    assert.deepEqual(labels(old.container), ["My own demo plan", "Roko plan-runner demo", "Add tests"]);
  } finally {
    await cleanup();
  }
});

test("Plans: without a demo to start with, nothing is picked until the person picks", async () => {
  const { container, backend } = await setup({ url: "http://localhost/roko?section=plans" });
  try {
    assert.ok(container.querySelector('[data-roko="plans-home"]'));
    assert.equal(container.querySelector('[data-roko="plan"]'), null);
    assert.ok(!backend.calls.some((c) => c.url.indexOf("/plans/project-") >= 0));
    await click(container.querySelector('[data-roko-plan="' + IDS.plan + '"]'));
    assert.ok(container.querySelector('[data-roko="plan"]'), "the picked plan opens");
    await click(container.querySelector('[data-roko="crumb-plans"]'));
    assert.ok(container.querySelector('[data-roko="plans-home"]'), "the crumb comes back to Plans");
  } finally {
    await cleanup();
  }
});

test("Plans: an invalid cap cannot be submitted", async () => {
  const { container } = await setup({ url: "http://localhost/roko?section=plans&plan=" + IDS.plan });
  try {
    const form = container.querySelector(".roko-runform");
    await click(button(form, "custom"));
    const cap = form.querySelector('input[type="number"]');
    await typeInto(cap, "0");
    assert.match(text(form), /at least \$0\.01/);
    assert.ok(form.querySelector('[data-roko="run-plan"]').disabled);
    await typeInto(cap, "6");
    assert.match(text(form), /at most \$5\.00\./);
  } finally {
    await cleanup();
  }
});

// --------------------------------------------------------------------------------
// Insights and knowledge
// --------------------------------------------------------------------------------

test("Insights: rates, spend over time with its scale, checks, models and the doctor", async () => {
  const { container } = await setup({ url: "http://localhost/roko?section=insights" });
  try {
    const kpis = [...container.querySelectorAll(".roko-kpi")].map((k) => text(k));
    assert.match(kpis[0], /^Tasks that passed 59% 17 tasks recorded/);
    assert.match(kpis[2], /^Spend \$0\.48/);
    assert.match(kpis[3], /^Checks passing 79% 23 of 29 checks that ran/);
    assert.equal(container.querySelector('[data-roko="fold-checks"] .rk-module-idx'), null, "no numbered modules (§5.1)");
    assert.ok(container.querySelector(".roko-chart-svg path.roko-chart-line"));
    assert.match(text(container.querySelector(".roko-chart")), /\$0\.48 cumulative/);
    const bars = [...container.querySelectorAll(".roko-bar-row")].map((r) => text(r));
    assert.ok(bars.some((b) => /^verify\[0:compile\] 0% 0✓ 6✗/.test(b)), bars.join(" | "));
    assert.match(text(container.querySelector(".roko-table")), /glm-5\.1 17 59% \$0\.48/);
    assert.match(text(container), /approvals.*approval gate is not importable/);
  } finally {
    await cleanup();
  }
});

test("Knowledge searches /knowledge?q= and lists the entries as text", async () => {
  const { container, backend } = await setup();
  try {
    await openTab(container, "Learning");
    // Every lesson is a fold of Learning's one page.
    await openFold(container, "lessons");
    const form = container.querySelector(".roko-search");
    await typeInto(form.querySelector("input"), "tests");
    await submit(form);
    assert.ok(backend.calls.some((c) => c.url === "/api/plugins/roko/knowledge?q=tests&limit=10"));
    assert.match(text(container), /plain `python` is not on PATH/);
    assert.match(text(container), /80% confidence/);
  } finally {
    await cleanup();
  }
});

// --------------------------------------------------------------------------------
// Keys, onboarding, planning
// --------------------------------------------------------------------------------

test("keys: on a run's page j and k open the next and the previous run; digits open the tabs, ? lists them", async () => {
  const { container } = await setup({ url: runUrl(IDS.multiwave) });
  try {
    // Runs' order: what runs, then what ran, newest first.
    const shown = () => new URLSearchParams(window.location.search).get("run");
    assert.equal(shown(), IDS.multiwave);
    await press("j");
    assert.equal(shown(), IDS.prompt);
    await press("k");
    await press("k");
    assert.equal(shown(), IDS.missing);
    await press("?");
    assert.match(text(container.querySelector('[data-roko="keys"]')), /New run/);
    await press("Escape");
    assert.equal(container.querySelector('[data-roko="keys"]'), null);
    // The digits are Runs, Plans and Learning.
    await press("3");
    assert.ok(container.querySelector('[data-roko="learning-overview"]'), "3 opens Learning");
    await press("2");
    assert.ok(container.querySelector('[data-roko="plans-home"]'), "2 opens Plans");
    await press("1");
    assert.ok(container.querySelector('[data-roko="runs-home"]'), "1 opens Runs, the home");
  } finally {
    await cleanup();
  }
});

test("onboarding: with no runs yet, the first steps and example requests that fill the composer", async () => {
  const { container } = await setup({ mode: "empty" });
  try {
    const onboard = container.querySelector('[data-roko="onboarding"]');
    assert.ok(onboard);
    assert.ok(onboard.querySelector('[data-roko="onboard-new-run"]').classList.contains("rk-key--you"), "the page's own key is the orange one");
    assert.ok(!container.querySelector(".roko-newrun").classList.contains("rk-key--you"), "the header's is plain");
    assert.match(text(onboard), /Delegate checked work to roko/);
    assert.equal(onboard.querySelectorAll(".roko-steps3 li").length, 3);
    await click([...onboard.querySelectorAll(".roko-example")].find((b) => text(b).includes("--json flag")));
    assert.match(container.querySelector('[data-roko="composer"] textarea').value, /--json flag/);
    // The first offer is a plan roko already has (its hello world demo): it opens the composer on its plans.
    await press("Escape");
    await click(onboard.querySelector('[data-roko="onboard-plan"]'));
    assert.ok(container.querySelector('[data-roko="composer"] [data-roko="composer-plans"], [data-roko="composer"] .roko-skels'), "the plan list");
  } finally {
    await cleanup();
  }
});

test("a plan generation: the planner at work, then the plan it wrote with a way to open it", async () => {
  const gen = "22222222-3333-4444-8555-666666666666";
  const edit = (state) => (fx) => {
    fx.overview.runs.unshift({ run_id: gen, kind: "plan_generate", label: "Split the ledger", plan_id: IDS.plan, state, active: state === "running", cost_usd: null, max_usd: null, started_at: new Date().toISOString() });
    fx.runs[gen] = { ok: true, run: { run_id: gen, kind: "plan_generate", label: "Split the ledger", plan_id: IDS.plan, state, verdict: state === "running" ? null : state, active: state === "running", task_count: 5, tasks: [], gates: {}, milestones: [], waiting: [] } };
  };
  const running = await setup({ url: runUrl(gen), edit: edit("running") });
  try {
    assert.match(text(running.container.querySelector('[data-roko="planning"]')), /writing the plan/);
  } finally {
    await cleanup();
  }
  const done = await setup({ url: runUrl(gen), edit: edit("succeeded") });
  try {
    const planning = done.container.querySelector('[data-roko="planning"]');
    assert.match(text(planning), new RegExp("Plan ready: " + IDS.plan + " · 5 tasks"));
    assert.equal(planning.querySelectorAll(".roko-node.is-planned").length, 5);
    await click(button(planning, "Open the plan"));
    assert.ok(done.container.querySelector('[data-roko="plan"]'), "the Plans section opens on it");
  } finally {
    await cleanup();
  }
});

// --------------------------------------------------------------------------------
// Permissions, failures, slots, safety
// --------------------------------------------------------------------------------

test("read-only: no New run, Approve, Reject, Cancel or Merge; the chat commands instead", async () => {
  const { container } = await setup({ mode: "readonly", url: runUrl(IDS.confirm) });
  try {
    assert.equal(container.querySelector('[aria-label="New run"]'), null);
    assert.equal(container.querySelector('[aria-label^="Approve "]'), null);
    assert.equal(container.querySelector('[aria-label^="Reject "]'), null);
    assert.equal(buttons(container).filter((b) => text(b) === "Cancel run").length, 0);
    assert.match(text(container.querySelector(".roko-actions-off")), /\/roko approve [0-9a-f]{6}/);
    await press("n");
    assert.equal(container.querySelector('[data-roko="composer"]'), null, "n does nothing");
  } finally {
    await cleanup();
  }
  const changes = await setup({ mode: "readonly", url: runUrl(IDS.prompt, "&view=changes") });
  try {
    assert.equal(changes.container.querySelector('[data-roko="merge-key"]'), null);
    assert.match(text(changes.container.querySelector(".roko-mergebox")), /Merging from the dashboard is turned off/);
  } finally {
    await cleanup();
  }
});

test("stop sits behind a confirm and posts /runs/{id}/cancel", async () => {
  const { container, backend } = await setup({ url: runUrl(IDS.live) });
  try {
    await click(button(container, "stop"));
    assert.equal(posts(backend, "/cancel").length, 0);
    const dialog = container.querySelector('[role="alertdialog"]');
    assert.equal(dialog.getAttribute("aria-label"), "Stop this run?");
    await click(dialog.querySelector('[data-confirm="yes"]'));
    assert.equal(posts(backend, "/runs/" + IDS.live + "/cancel").length, 1);
    assert.match(text(container), /Stopped “Add per-category budgets to tally” \(stopped\)/);
  } finally {
    await cleanup();
  }
});

test("a missing backend (404) tells the person to restart hermes dashboard; the slots stay hidden", async () => {
  const { container, registry } = await setup({ mode: "missing" });
  try {
    const all = text(container);
    assert.ok(all.includes("roko's backend is not loaded in this dashboard."));
    assert.ok(all.includes("Restart `hermes dashboard`"));
    assert.ok(buttons(container).some((b) => text(b) === "Retry"));
    for (const slot of registry.slots) {
      const handle = await mount(slot.component);
      assert.equal(handle.container.innerHTML, "", slot.slot + " renders nothing without a backend");
    }
  } finally {
    await cleanup();
  }
});

test("a crashing route (HTTP 500) is reported, not shown as roko's answer", async () => {
  const { container } = await setup({ mode: "crash" });
  try {
    assert.ok(text(container).includes("roko's backend failed to answer (HTTP 500)."));
  } finally {
    await cleanup();
  }
});

test("roko serve unreachable: OFFLINE in red, its error and hint, the runs as last seen, nothing startable", async () => {
  const home = await setup({ mode: "unreachable" });
  try {
    const container = home.container;
    const all = text(container);
    assert.ok(all.includes("roko serve unreachable"));
    // The header says offline; the connection's own message and hint are on it, on hover.
    const trouble = container.querySelector('[data-roko="status"] .rk-head-trouble');
    assert.equal(text(trouble), "✗ offline");
    assert.match(trouble.getAttribute("title"), /^roko serve is not reachable at http:\/\/localhost:6677 · start it with `roko serve`/);
    // An older backend names no problem: the page derives it, with the start command its hint names as the fix.
    const derived = container.querySelector('[data-roko="problem-roko-unreachable"]');
    assert.match(text(derived), /Hermes cannot reach roko serve at http:\/\/localhost:6677\./);
    assert.match(text(derived), /roko serve/);
    // Never LIVE next to "unreachable" (repro-will F4).
    const live = container.querySelector('[data-roko="live-state"]');
    assert.equal(live.getAttribute("data-state"), "offline");
    assert.equal(live.querySelector(".rk-led").getAttribute("data-ch"), "fail");
    assert.match(text(container.querySelector('[data-roko="last-known"]')), /^Showing the last known runs · checked \d\d:\d\d:\d\d; the page asks again every few seconds$/);
    assert.ok(all.includes("Add a --json flag to tally"));
    // A run that was going is its last known state: unlit, still, said so, with no key to press.
    const card = container.querySelector(`[data-roko="run-card"][data-run="${IDS.live}"]`);
    assert.equal(text(card.querySelector('[data-roko="card-pill"]')), "■ last seen running");
    assert.equal(card.querySelector('[data-roko="card-pill"]').getAttribute("data-blink"), null, "no blinking");
    assert.match(text(card.querySelector('[data-roko="card-tasks"]')), /1 was running/);
    assert.equal(text(card.querySelector('[data-roko="card-status"]')), "roko serve is not answering: this is the run's last known state.");
    assert.equal(card.querySelector(".rk-rc-keys"), null);
  } finally {
    await cleanup();
  }
  const { container, registry } = await setup({ mode: "unreachable", url: runUrl(IDS.live) });
  try {
    const hero = container.querySelector('[data-roko="hero"]');
    assert.match(text(container.querySelector('[data-roko="stale"]')), /roko serve is not answering: this is the run's last known state, from \d\d:\d\d:\d\d\. It may still be going, or it stopped when roko did\./);
    assert.equal(text(hero.querySelector('[data-roko="card-pill"]')), "■ last seen running");
    assert.match(text(hero.querySelector('[data-roko="card-tasks"]')), /1 was running/, "not \"1 running\": nothing runs that the page can see");
    assert.equal(container.querySelector('[data-roko="ticker"]'), null, "no now strip");
    assert.ok(button(container, "stop").disabled, "roko cannot be asked to stop it");
    // The page names the problem an older backend does not, so nothing can start.
    assert.match(text(container.querySelector('[data-roko="setup"]')), /Hermes cannot reach roko serve at http:\/\/localhost:6677\./);
    await click(button(container, "New run"));
    const dialog = container.querySelector('[data-roko="composer"]');
    await typeInto(dialog.querySelector("textarea"), "Add a test");
    assert.ok(dialog.querySelector('[data-roko="composer-submit"]').disabled, "start is off while roko is down");
    assert.ok(dialog.querySelector('[data-roko="problem-card-roko-unreachable"]'));
    // The slots: the chip says offline, the strips say what starts roko, not "1 running".
    const slot = (name) => registry.slots.find((s) => s.slot === name).component;
    const chip = await mount(slot("header-right"));
    assert.match(chip.container.querySelector("a").getAttribute("title"), /unreachable/);
    assert.equal(text(chip.container.querySelector('[data-roko="chip-offline"]')), "off");
    assert.equal(chip.container.querySelector('[data-roko="chip-setup"]'), null, "off says it; no setup tag");
    const sessions = await mount(slot("sessions:top"), { url: "http://localhost/sessions" });
    assert.equal(sessions.container.querySelector('[data-roko="banner"]'), null, "no stale running banner");
    assert.match(text(sessions.container.querySelector('[data-roko="sessions-setup"]')), /Hermes cannot reach roko serve/);
    const chat = await mount(slot("chat:top"), { url: "http://localhost/chat" });
    assert.equal(chat.container.querySelector('[data-roko="chatstrip"]'), null);
    assert.ok(chat.container.querySelector('[data-roko="chat-setup"]'));
  } finally {
    await cleanup();
  }
});

test("roko down, and the backend names it: the header drops the WORKSPACE hint; the module has the real command", async () => {
  const problem = {
    id: "roko-unreachable", severity: "block", title: "Hermes cannot reach roko serve at http://localhost:6677.",
    detail: "Nothing roko does works from Hermes until roko serve runs. Start it in your roko workspace.",
    fix: { kind: "command", label: "start roko serve", action: null, command: "roko serve --workdir /home/demo/code/tally", docs: "troubleshooting.md#roko-serve-is-not-reachable" },
  };
  const { container } = await setup({
    mode: "unreachable",
    edit: (fx) => {
      fx.overview.connection.error.hint = "start it with `roko serve --workdir WORKSPACE`, or point the plugin at it with `hermes roko setup --url URL`";
      fx.overview.setup = { ok: false, problems: [problem] };
    },
  });
  try {
    const head = text(container.querySelector('[data-roko="status"]'));
    assert.match(head, /roko serve unreachable/);
    assert.ok(!head.includes("WORKSPACE"), "no placeholder: " + head);
    const rows = container.querySelectorAll('[data-roko="problem-roko-unreachable"]');
    assert.equal(rows.length, 1, "named once");
    assert.match(text(rows[0]), /roko serve --workdir \/home\/demo\/code\/tally/);
    assert.ok(!text(container).includes("WORKSPACE"));
  } finally {
    await cleanup();
  }
});

test("roko back: views that failed while it was away reload by themselves, no Retry", async () => {
  const { container, backend } = await setup({
    mode: "unreachable",
    url: "http://localhost/roko?section=plans",
    edit: (fx) => {
      fx.plans_ok = fx.plans;
      fx.plans = { ok: false, error: { code: "unreachable", message: "could not reach roko serve at http://localhost:6677", hint: "" } };
    },
  });
  try {
    // While roko is down the view says it comes back by itself; the header and the setup module say the rest.
    assert.match(text(container.querySelector('[data-roko="away"]')), /roko serve is not answering\. This comes back by itself when it answers/);
    const asked = () => backend.calls.filter((c) => c.url.endsWith("/plans")).length;
    const before = asked();
    // roko comes back; the next look at it finds it (here: the refresh key; the page polls by itself too).
    backend.fx.plans = backend.fx.plans_ok;
    backend.fx.overview = { ...backend.fx.overview, connection: { ...backend.fx.overview.connection, reachable: true, error: null } };
    // r: roko's status, asked again now (the page asks by itself every few seconds too).
    await press("r");
    await settle();
    assert.ok(asked() > before, "Plans asked again");
    assert.equal(container.querySelector('[data-roko="away"]'), null);
    assert.ok(container.querySelector('[data-roko="plan-list"]'), "the plans are back");
    assert.equal(container.querySelector('[data-roko="live-state"]').getAttribute("data-state"), "polling", "a dashboard without a socket polls");
  } finally {
    await cleanup();
  }
});

test("a route answering ok:false shows roko's message, hint and a Retry", async () => {
  const { container } = await setup({
    edit: (fx) => { fx.plans = { ok: false, error: { code: "unreachable", message: "roko serve did not answer", hint: "start roko serve, then retry" } }; },
  });
  try {
    await openTab(container, "Plans");
    const all = text(container);
    assert.ok(all.includes("roko serve did not answer"));
    assert.ok(all.includes("start roko serve, then retry"));
    assert.ok(all.includes("code: unreachable"));
    assert.ok(buttons(container).some((b) => text(b) === "Retry"));
  } finally {
    await cleanup();
  }
});

test("header-right chip and sessions:top: the most urgent state with one reading, and one line above the sessions", async () => {
  const backend = makeBackend();
  const registry = loadBundle(backend);
  try {
    const chip = await mount(registry.slots.find((s) => s.slot === "header-right").component, { url: "http://localhost/sessions" });
    const link = chip.container.querySelector('[data-roko="chip"]');
    // Something needs the person: that comes first (roko's design system §4.9), orange, with its count.
    assert.equal(text(link.querySelector('[data-roko="chip-waiting"]')), "2 waiting");
    assert.equal(link.querySelector('[data-roko="chip-live"]'), null, "one reading at most");
    assert.equal(link.getAttribute("href"), "/roko");
    assert.match(link.getAttribute("title"), /2 running · 2 waiting/);
    assert.match(link.getAttribute("title"), /Write the ledger report: 0\/1 tasks/);
    const banner = await mount(registry.slots.find((s) => s.slot === "sessions:top").component, { url: "http://localhost/sessions" });
    const line = banner.container.querySelector('[data-roko="banner"]');
    assert.ok(line, "a line while runs go");
    assert.ok(line.querySelector('[data-roko="card-pill"]'));
    assert.match(text(line), /2 waiting/);
    assert.equal(line.querySelector("a").getAttribute("href"), "/roko");
    let popped = 0;
    window.addEventListener("popstate", () => { popped += 1; }, { once: true });
    await click(line.querySelector("a"));
    assert.equal(window.location.pathname + window.location.search, "/roko");
    assert.equal(popped, 1);
    // The page and both slots share one overview poll.
    assert.equal(backend.calls.filter((c) => c.url.endsWith("/overview")).length, 1);
  } finally {
    await cleanup();
  }
});

test("idle: the chip is just roko ● and the sessions banner is hidden", async () => {
  const backend = makeBackend("idle");
  const registry = loadBundle(backend);
  try {
    const chip = await mount(registry.slots.find((s) => s.slot === "header-right").component);
    assert.equal(text(chip.container), "roko");
    assert.equal(chip.container.querySelector(".rk-led").getAttribute("data-ch"), "off", "an unlit LED");
    assert.equal(chip.container.querySelector("a").getAttribute("href"), "/roko");
    const banner = await mount(registry.slots.find((s) => s.slot === "sessions:top").component);
    assert.equal(banner.container.innerHTML, "");
  } finally {
    await cleanup();
  }
});

test("roko's strings are rendered as text, never as HTML: labels, notes, diff lines", async () => {
  const evil = '<img src=x onerror="alert(1)"><b>bold</b> **not markdown**';
  const { container } = await setup({
    url: runUrl(IDS.prompt, "&view=changes"),
    edit: (fx) => {
      fx.overview.runs.find((r) => r.run_id === IDS.prompt).label = evil;
      fx.runs[IDS.prompt].run.label = evil;
      fx.runs[IDS.prompt].run.tasks[0].note = evil;
      fx.diffs[IDS.prompt].diff.files[0].hunks[0].lines.push(["+", null, 99, "<script>alert(1)</script>" + evil]);
    },
  });
  try {
    assert.equal(container.querySelectorAll("img, b, script").length, 0);
    assert.ok(container.textContent.includes("<b>bold</b> **not markdown**"));
    assert.ok(container.textContent.includes("<script>alert(1)</script>"), "the diff line, tinted, still reads as written");
  } finally {
    await cleanup();
  }
});

// --------------------------------------------------------------------------------
// 0.4.0: the live socket, the control surface, the loops, the new slots
// --------------------------------------------------------------------------------

/** A stand-in for the browser's WebSocket: records the URL, and lets a test push frames. */
class FakeSocket {
  constructor(url) {
    this.url = url;
    this.closed = false;
    FakeSocket.all.push(this);
  }
  close() {
    this.closed = true;
    if (this.onclose) this.onclose({ code: 1000 });
  }
  send() { throw new Error("the page never sends on the live socket"); }
}
FakeSocket.all = [];

/** Install the fake socket and the SDK's buildWsUrl; returns the restore. */
function withLiveSocket(sdk) {
  sdk.buildWsUrl = async (path, params) => "ws://localhost" + path + (params ? "?" + new URLSearchParams(params) : "");
}
async function push(socket, frame, waitMs = 120) {
  await act(async () => {
    socket.onmessage({ data: JSON.stringify(frame) });
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  });
  await settle();
}
async function liveSetup(options = {}) {
  FakeSocket.all = [];
  const saved = window.WebSocket;
  window.WebSocket = FakeSocket;
  const env = await setup({ ...options, tweak: withLiveSocket });
  env.restore = () => { window.WebSocket = saved; };
  return env;
}

test("live: one socket from SDK.buildWsUrl; hello, overview, run, lines and live frames update the page at once", async () => {
  const env = await liveSetup({ url: runUrl(IDS.live) });
  const { container, backend } = env;
  try {
    assert.equal(FakeSocket.all.length, 1, "one socket for the page and its views");
    const socket = FakeSocket.all[0];
    assert.equal(new URL(socket.url).pathname, "/api/plugins/roko/live");
    const overview = structuredClone(backend.fx.overview);
    overview.spend.today_usd = 0.61;
    await push(socket, { type: "hello", version: VERSION, overview, server_time: new Date().toISOString(), hub: "open" });
    const head = text(container.querySelector('[data-roko="status"]'));
    assert.match(head, /\$0\.61 from Hermes/, "the hello frame's overview replaces the poll's");
    assert.match(head, /\blive\b/);

    // An agent's tool step: the ticker shows it within a frame.
    await push(socket, { type: "live", run_id: IDS.live, task_id: "T2", attempt: 1, kind: "tool", tool: "Edit", target: "tally/reports.py", ts: Date.now() });
    assert.match(text(container.querySelector('[data-roko="ticker"]')), /Task 2 .*▸ Edit tally\/reports\.py/);

    // A new card: T2 passed.
    const card = structuredClone(backend.fx.runs[IDS.live].run);
    const t2 = card.tasks.find((t) => t.task_id === "T2");
    t2.outcome = "passed";
    t2.step = null;
    card.progress = { ...card.progress, passed: 3, running: 0 };
    const callsBefore = backend.calls.length;
    await push(socket, { type: "run", run: card });
    assert.equal(node(container, "T2").getAttribute("data-state"), "passed");
    assert.match(text(container.querySelector('[data-roko="hero"] [data-roko="card-tasks"] .rk-dots .rk-sr')), /^3 of 5 tasks passed/);
    assert.equal(backend.calls.length, callsBefore, "the socket's card needs no request");

    // New timeline lines join the activity feed in cursor order.
    const top = Math.max(...backend.fx.events[IDS.live].events.map((e) => e.cursor));
    await push(socket, { type: "lines", run_id: IDS.live, lines: [{ cursor: top + 10, type: "gate_result", group: "gate", task_id: "T2", ts_millis: Date.now(), passed: true, gate: "verify[0:lint]", text: "T2 gate verify[0:lint] passed" }] });
    await openFold(container, "steps");
    const lines = [...container.querySelectorAll(".roko-feedline")].map((l) => text(l));
    assert.match(lines[lines.length - 1], /Task 2 gate verify\[0:lint\] passed/);
  } finally {
    await cleanup();
    env.restore();
  }
});

test("live: an agent's words reach the now strip as one running line, the end of what it says", async () => {
  const env = await liveSetup({ url: runUrl(IDS.live) });
  const { container } = env;
  try {
    const socket = FakeSocket.all[0];
    await push(socket, { type: "hello", version: VERSION, overview: env.backend.fx.overview, hub: "open" });
    const base = { type: "live", run_id: IDS.live, task_id: "T2", attempt: 1 };
    const ticker = () => text(container.querySelector('[data-roko="ticker"]'));
    await push(socket, { ...base, kind: "reasoning", text: "Reading", said: "Reading", ts: Date.now() });
    await push(socket, { ...base, kind: "reasoning", text: " the report", said: "Reading the report", ts: Date.now() });
    // A frame without `said` (an older backend) continues the line too.
    await push(socket, { ...base, kind: "reasoning", text: " code.", ts: Date.now() });
    assert.match(ticker(), /Task 2 .*\u201cReading the report code\.\u201d/);
    // A long stretch shows its end, where the agent is now.
    await push(socket, { ...base, kind: "text", text: " words", said: "word ".repeat(80) + "and the newest words", ts: Date.now() });
    assert.match(ticker(), /\u201c\u2026[^\u201d]*and the newest words\u201d/);
    // ...in a box that keeps its newest end in view when the line is wider than the strip.
    assert.match(text(container.querySelector(".rk-ticker-step.is-words > span")), /and the newest words\u201d$/);
  } finally {
    await cleanup();
    env.restore();
  }
});

test("live: roko's words in frames stay text; a dropped socket says so and reconnects with a fresh URL", async () => {
  const env = await liveSetup({ url: runUrl(IDS.live) });
  const { container } = env;
  try {
    const socket = FakeSocket.all[0];
    await push(socket, { type: "hello", version: VERSION, overview: env.backend.fx.overview, hub: "open" });
    const evil = '<img src=x onerror="alert(1)"><b>bold</b>';
    await push(socket, { type: "live", run_id: IDS.live, task_id: "T2", kind: "tool", tool: "Write", target: evil, ts: Date.now() });
    assert.equal(container.querySelectorAll("img, b").length, 0);
    assert.ok(text(container.querySelector('[data-roko="ticker"]')).includes("<b>bold</b>"));
    await act(async () => { socket.onclose({ code: 1006 }); });
    await settle();
    assert.match(text(container.querySelector('[data-roko="status"]')), /reconnecting/);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1400)); });
    await settle();
    assert.equal(FakeSocket.all.length, 2, "a second socket after the backoff");
    assert.notEqual(FakeSocket.all[1], socket);
  } finally {
    await cleanup();
    env.restore();
  }
});

test("the head's glass: four readings in dot-matrix with the plain value as text, the plan's strip, the cap meter", async () => {
  const { container } = await setup({ url: runUrl(IDS.live) });
  try {
    const glass = container.querySelector('[data-roko="hero"] [data-roko="card-glass"]');
    assert.ok(glass.classList.contains("rk-well"), "the readings are on the glass");
    assert.deepEqual([...glass.querySelectorAll(".rk-rc-label")].map(text), ["tasks", "time", "spent", "checks"]);
    const spent = glass.querySelector('[data-roko="card-spent"]');
    const dots = spent.querySelector(".rk-dots");
    assert.equal(text(dots.querySelector(".rk-sr")), "spent $0.04 of $1.00");
    assert.equal(dots.querySelector("svg").getAttribute("aria-hidden"), "true");
    assert.ok(dots.querySelectorAll("path.rk-on").length >= 5, "one lit path per glyph");
    assert.ok(dots.querySelector("path.rk-off"), "the unlit dots are drawn");
    assert.equal(spent.querySelectorAll('[data-roko="spend-meter"] i').length, 20, "a 20-segment meter against the cap");
    assert.match(text(spent), /of \$1\.00$/);
    // The plan's strip: a square a task, a gap between steps.
    assert.equal(glass.querySelectorAll('[data-roko="card-tasks"] .rk-rc-strip i').length, 5);
    const finished = await setup({ url: runUrl(IDS.multiwave) });
    const ended = finished.container.querySelector('[data-roko="hero"]');
    assert.equal(text(ended.querySelector('[data-roko="card-pill"]')), "✓ passed");
    assert.match(text(ended.querySelector('[data-roko="card-time"] .rk-rc-note')), /^from \d\d:\d\d$/, "when roko's clock started");
  } finally {
    await cleanup();
  }
});

test("the inspector shows the router's pick with the models it weighed, the tool steps and what roko learned", async () => {
  const { container } = await setup({ url: runUrl(IDS.live) });
  try {
    await click(node(container, "T1"));
    const inspector = container.querySelector('[data-roko-inspector="T1"]');
    // A ladder pick is a ladder pick: no router scores drawn as if they decided (repro-will D6).
    assert.match(text(inspector.querySelector(".rk-route-head")), /^picked by the model ladder$/);
    assert.match(text(inspector.querySelector(".rk-route-why")), /^the ladder's top rung for this workspace$/);
    assert.equal(inspector.querySelector(".rk-cand-bar"), null, "no score bars");
    assert.ok(!/p 0\.55/.test(text(inspector.querySelector('[data-roko="route"]'))), "no odds for a pick by rule");
    const cands = [...inspector.querySelectorAll(".rk-cand")].map((c) => text(c));
    assert.deepEqual(cands, ["glm-5.1 picked", "gpt-5.4-mini could have run it", "gpt-oss-120b could have run it"]);
    // The model this run cannot use folds away behind its count, with roko's reason inside.
    const fold = button(inspector, "1 model this run cannot use ›");
    await click(fold);
    assert.match(text(inspector.querySelector(".rk-cands--out")), /claude-sonnet-4-6 runs its own tools, so it cannot honour the stage policy/);
    assert.match(text(inspector), /What roko learned Budgets persist as integer cents per category, in a JSON file\. kept a new lesson · confirmed 1 lesson it had/);
    await click(node(container, "T2"));
    const t2 = container.querySelector('[data-roko-inspector="T2"]');
    const steps = [...t2.querySelectorAll(".rk-step")].map((s) => text(s).replace(/^\S+ /, ""));
    assert.deepEqual(steps, ["Read tally/reports.py", "Grep def build_parser", "Write tally/reports.py"]);
  } finally {
    await cleanup();
  }
});

test("the confirm run: the sign-off holds T1 in orange, with roko's deadline on the glass", async () => {
  const { container } = await setup({ url: runUrl(IDS.confirm) });
  try {
    await click(node(container, "T1"));
    const hold = container.querySelector('[data-roko-inspector="T1"] .rk-hold');
    assert.ok(hold, "the hold");
    assert.match(text(hold), /waits for your sign-off · rung\[sign-off\]/);
    assert.match(text(hold), /answer within (29|30):\d\d/);
    assert.equal(node(container, "T1").getAttribute("data-ch"), "you");
  } finally {
    await cleanup();
  }
});

test("the cap presets: a key a detent roko allows, never past what is left today; the exact figure is in more", async () => {
  const { container, backend } = await setup({ edit: (fx) => { fx.overview.spend.left_usd = 1.5; } });
  try {
    await click(button(container, "New run"));
    const dialog = container.querySelector('[data-roko="composer"]');
    const presets = dialog.querySelector('[data-roko="cap-presets"]');
    assert.equal(presets.getAttribute("aria-label"), "Spend cap presets");
    assert.deepEqual([...presets.querySelectorAll("button")].map(text), ["$0.25", "$0.50", "$1"], "the $2 and $5 detents are over what is left");
    assert.equal(text(presets.querySelector('[aria-pressed="true"]')), "$0.50");
    await click([...presets.querySelectorAll("button")].find((b) => text(b) === "$0.25"));
    assert.equal(text(dialog.querySelector('[data-roko="cap-presets"] [aria-pressed="true"]')), "$0.25");
    // The exact figure, in more: a cap between the detents lights none of them.
    const more = dialog.querySelector('[data-roko="composer-more"]');
    await click(more.querySelector("summary"));
    const exact = more.querySelector('input[aria-label="Spending cap in US dollars"]');
    assert.equal(exact.value, "0.25");
    await typeInto(exact, "0.4");
    assert.ok(!dialog.querySelector('[data-roko="cap-presets"] [aria-pressed="true"]'), "no detent lit for $0.40");
    await typeInto(dialog.querySelector("textarea"), "Tidy the README");
    await click(dialog.querySelector('[data-roko="composer-submit"]'));
    assert.deepEqual(posts(backend, "/runs")[0].body, { prompt: "Tidy the README", max_usd: 0.4 });
  } finally {
    await cleanup();
  }
});

test("the five loops, in plain words: what each does, its light from its newest event, how often it turned lately, the newest learning", async () => {
  const { container, backend } = await setup({ url: "http://localhost/roko?section=loops" });
  try {
    assert.ok(backend.calls.some((c) => c.url === "/api/plugins/roko/loops"));
    // An old link to the loops opens Learning with them open.
    const fold = container.querySelector('[data-roko="fold-loops"]');
    assert.equal(fold.open, true);
    const loops = [...fold.querySelectorAll(".rk-loop")];
    assert.deepEqual(loops.map((l) => text(l.querySelector(".rk-loop-name"))), ["tool calls", "tries", "the plan", "lessons", "spot checks"]);
    assert.match(text(loops[1]), /A task that fails its checks tries again; after two failed tries, on a stronger model\. \d+ in the last hour/);
    assert.ok(!/\bL[0-4]\b/.test(text(fold)), "no loop codes on the page");
  } finally {
    await cleanup();
  }
});

test("slots: chat:top is one line while a run goes: the newest run, its time, the way to it; nothing while roko is idle", async () => {
  // Nothing waits: the line follows the newest run, and opens its page.
  const backend = makeBackend("normal", (fx) => { fx.overview.pending = []; fx.overview.counts.waiting = 0; fx.pending = { ok: true, items: [] }; });
  const registry = loadBundle(backend);
  try {
    const chat = await mount(registry.slots.find((s) => s.slot === "chat:top").component, { url: "http://localhost/chat" });
    const strip = chat.container.querySelector('[data-roko="chatstrip"]');
    assert.ok(strip, "a line above the chat while a run is active");
    assert.equal(text(strip.querySelector('[data-roko="card-pill"]')), "running");
    assert.match(strip.querySelector("a").getAttribute("href"), /^\/roko\?run=/);
    assert.ok(strip.querySelector(".rk-runstrip-glass .rk-dots"), "its time on the glass");
    assert.equal(strip.querySelector(".rk-strip, .rk-lstrip"), null, "no strips or ladders above the chat");
  } finally {
    await cleanup();
  }
  const idle = makeBackend("idle");
  const idleRegistry = loadBundle(idle);
  try {
    const chat = await mount(idleRegistry.slots.find((s) => s.slot === "chat:top").component);
    assert.equal(chat.container.innerHTML, "", "nothing above the chat while roko is idle");
  } finally {
    await cleanup();
  }
});

test("sound is off until the person turns it on; then keys click, and it is remembered", async () => {
  let made = 0;
  class FakeAudio {
    constructor() { made += 1; this.currentTime = 0; this.state = "running"; this.destination = {}; }
    createOscillator() { return { type: "", frequency: { setValueAtTime() {} }, connect() {}, start() {}, stop() {} }; }
    createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
  }
  window.AudioContext = FakeAudio;
  window.localStorage.removeItem("roko.sound");
  const { container } = await setup();
  try {
    await click(button(container, "New run"));
    await press("Escape");
    assert.equal(made, 0, "no audio before the person asks for it");
    // Sound lives in Settings (the gear in the header).
    await click(container.querySelector('[data-roko="open-settings"]'));
    const sw = container.querySelector('[data-roko="settings"] [role="radiogroup"][aria-label="Sound"]');
    await click([...sw.querySelectorAll('[role="radio"]')].find((b) => text(b) === "on"));
    assert.equal(window.localStorage.getItem("roko.sound"), "on");
    assert.equal(made, 1, "one audio context, made on the person's click");
  } finally {
    await cleanup();
    window.localStorage.removeItem("roko.sound");
    delete window.AudioContext;
  }
});

// --------------------------------------------------------------------------------
// Setup and updates (0.5.0)
// --------------------------------------------------------------------------------

test("a current backend: no restart banner, no setup module, the chip says nothing extra", async () => {
  const { container, registry } = await setup();
  try {
    assert.equal(container.querySelector('[data-roko="restart"]'), null);
    assert.equal(container.querySelector('[data-roko="setup"]'), null);
    const chip = await mount(registry.slots.find((s) => s.slot === "header-right").component);
    assert.equal(chip.container.querySelector('[data-roko="chip-restart"], [data-roko="chip-setup"]'), null);
  } finally {
    await cleanup();
  }
});

test("a backend from before the update (no install, no setup): the restart banner names hermes dashboard; the chip and sessions strip say so", async () => {
  const strip = (fx) => {
    delete fx.overview.install;
    delete fx.overview.setup;
    delete fx.health.install;
    delete fx.health.setup;
  };
  const { container, registry } = await setup({ edit: strip });
  try {
    const banner = container.querySelector('[data-roko="restart"]');
    assert.ok(banner, "the restart banner");
    assert.match(text(banner), /This dashboard is still running the roko backend it started with, from before this update\./);
    assert.match(text(banner), /Stop `hermes dashboard` \(Ctrl-C where it runs\) and start it again\. Reload this page\./);
    assert.ok(banner.querySelector(".rk-well .rk-dots"), "RESTART on the glass");
    const chip = await mount(registry.slots.find((s) => s.slot === "header-right").component, { url: "http://localhost/sessions" });
    assert.equal(text(chip.container.querySelector('[data-roko="chip-restart"]')), "restart");
    assert.match(chip.container.querySelector("a").getAttribute("title"), /^This dashboard is still running the roko backend/);
    assert.equal(chip.container.querySelector("a").getAttribute("href"), "/roko");
    const banner2 = await mount(registry.slots.find((s) => s.slot === "sessions:top").component, { url: "http://localhost/sessions" });
    const line = banner2.container.querySelector('[data-roko="sessions-setup"]');
    assert.ok(line, "a strip on the sessions page");
    assert.match(text(line), /still running the roko backend/);
  } finally {
    await cleanup();
  }
});

test("install.backend_stale: the banner takes the backend's words; the module lists the other problems", async () => {
  const { container } = await setup({
    edit: (fx) => {
      fx.overview.install = { ...currentInstall(), backend_stale: true, disk_version: NEWER };
      fx.overview.setup = { ok: true, problems: [PROBLEM_RESTART, PROBLEM_MODEL] };
    },
  });
  try {
    assert.ok(text(container.querySelector('[data-roko="restart"]')).includes("roko " + NEWER + " is installed, but this dashboard is still running " + VERSION + "."));
    const module = container.querySelector('[data-roko="setup"]');
    assert.ok(module);
    assert.equal(module.querySelector('[data-roko="problem-restart-hermes"]'), null, "the banner is its line");
    assert.ok(module.querySelector('[data-roko="problem-no-tool-loop-model"]'));
  } finally {
    await cleanup();
  }
});

test("a newer backend than this tab: reload the page; an older one: restart hermes dashboard", async () => {
  let ctx = await setup({ edit: (fx) => { fx.overview.plugin_version = NEWER; } });
  try {
    assert.ok(text(ctx.container.querySelector('[data-roko="restart"]')).includes("The dashboard runs roko " + NEWER + ", but this tab still shows " + VERSION + ". Reload this page."));
    assert.ok(ctx.container.querySelector('[data-roko="restart"] [data-roko="reload-page"]'), "a key that reloads the tab");
  } finally {
    await cleanup();
  }
  ctx = await setup({ edit: (fx) => { fx.overview.plugin_version = OLDER; } });
  try {
    assert.ok(text(ctx.container.querySelector('[data-roko="restart"]')).includes("roko " + VERSION + " is installed, but this dashboard is still running " + OLDER + "."));
    assert.equal(ctx.container.querySelector('[data-roko="reload-page"]'), null, "a reload cannot fix an old backend");
  } finally {
    await cleanup();
  }
});

test("a problem only the desktop app has (its copy of its page) is not shown here", async () => {
  const { container } = await setup({
    edit: (fx) => {
      fx.overview.install = { ...currentInstall(), desktop_copy_stale: true, desktop_copy_version: OLDEST };
      fx.overview.setup = { ok: true, problems: [{ ...PROBLEM_RESTART, title: "The desktop app still shows roko " + OLDEST + "; " + VERSION + " is installed.", parts: { backend: false, desktop_copy: true } }] };
    },
  });
  try {
    assert.equal(container.querySelector('[data-roko="restart"]'), null);
    assert.equal(container.querySelector('[data-roko="setup"]'), null);
  } finally {
    await cleanup();
  }
});

test("the setup module numbers the problems, blocking first; a command fix copies; an action fix previews, then applies", async () => {
  const copied = [];
  const { container, backend } = await setup({
    edit: (fx) => { fx.overview.setup = { ok: false, problems: [PROBLEM_MODEL, PROBLEM_BOUNDARY] }; },
    tweak: () => {
      Object.defineProperty(window.navigator, "clipboard", { configurable: true, value: { writeText: async (v) => { copied.push(v); } } });
    },
  });
  try {
    const module = container.querySelector('[data-roko="setup"]');
    assert.match(text(module.querySelector(".rk-module-head")), /00 SETUP 1 blocking new runs/);
    const rows = [...module.querySelectorAll(".rk-problem")];
    assert.deepEqual(rows.map((r) => r.getAttribute("data-roko")), ["problem-workspace-refuses-chat-runs", "problem-no-tool-loop-model"]);
    assert.equal(text(rows[0].querySelector(".rk-problem-n")), "01");
    assert.equal(rows[0].querySelector(".rk-led").getAttribute("data-ch"), "fail");
    assert.equal(rows[1].querySelector(".rk-led").getAttribute("data-ch"), "you");
    assert.match(text(rows[1]), /roko config models list/);
    await click(rows[1].querySelector('[data-roko="fix-copy-no-tool-loop-model"]'));
    assert.deepEqual(copied, ["roko config models list"]);

    await click(rows[0].querySelector('[data-roko="fix-workspace-refuses-chat-runs"]'));
    assert.ok(backend.calls.some((c) => c.method === "GET" && c.url.endsWith("/setup/fix?action=workspace-chat-ready")));
    assert.equal(posts(backend, "/setup/fix").length, 0, "nothing applied before the second key");
    let panel = container.querySelector('[data-roko="fix-panel-workspace-refuses-chat-runs"]');
    assert.match(text(panel), /Make this workspace accept runs started from Hermes/);
    assert.match(text(panel), /changes \/home\/demo\/code\/tally\/roko\.toml/);
    // The recommended way comes first and is the one shown.
    assert.equal(panel.querySelector('[data-roko="fix-variant-local"]').getAttribute("aria-pressed"), "true");
    assert.match(text(panel.querySelector('[data-roko="fix-variant-local"]')), /run without the boundary \(local use\) · recommended/);
    assert.equal(panel.querySelector('[data-line="add"]').textContent, "+allow_without_data_llm = true\n");
    assert.equal(panel.querySelector('[data-line="del"]').textContent, "-allow_without_data_llm = false\n");
    await click(panel.querySelector('[data-roko="fix-variant-boundary"]'));
    assert.ok(backend.calls.some((c) => c.method === "GET" && c.url.endsWith("/setup/fix?action=workspace-chat-ready&variant=boundary")));
    panel = container.querySelector('[data-roko="fix-panel-workspace-refuses-chat-runs"]');
    assert.ok([...panel.querySelectorAll('[data-line="add"]')].some((line) => line.textContent === "+[agent.data_llm]\n"));
    await click(panel.querySelector('[data-roko="fix-apply-workspace-refuses-chat-runs"]'));
    assert.deepEqual(posts(backend, "/setup/fix")[0].body, { action: "workspace-chat-ready", variant: "boundary", digest: "digest-boundary" });
    // The next look no longer lists the problem, so its row goes; what was done and what is next stay.
    assert.equal(container.querySelector('[data-roko="problem-workspace-refuses-chat-runs"]'), null, "the fixed problem left the list");
    const note = container.querySelector('[data-roko="fix-done-note"]');
    assert.ok(note, "the outcome stays after its row goes");
    assert.equal(text(note), "Changed /home/demo/code/tally/roko.toml. roko accepts runs started from Hermes now. next " + COMMIT_NEXT);
    assert.equal(note.getAttribute("data-ready"), "true");
    assert.equal(note.querySelector(".rk-led").getAttribute("data-ch"), "pass");
    await click(note.querySelector('[data-roko="fix-done-note-close"]'));
    assert.equal(container.querySelector('[data-roko="fix-done-note"]'), null);
  } finally {
    delete window.navigator.clipboard;
    await cleanup();
  }
});

test("a fix that took while roko still refuses runs says so in orange", async () => {
  const { container } = await setup({
    edit: (fx) => {
      fx.overview.setup = { ok: false, problems: [PROBLEM_BOUNDARY] };
      fx.fix_ready = false;
    },
  });
  try {
    await click(container.querySelector('[data-roko="fix-workspace-refuses-chat-runs"]'));
    await click(container.querySelector('[data-roko="fix-apply-workspace-refuses-chat-runs"]'));
    const note = container.querySelector('[data-roko="fix-done-note"]');
    assert.ok(note, "the outcome stays");
    assert.match(text(note), /but it still refuses runs started from Hermes/);
    assert.equal(note.getAttribute("data-ready"), "false");
    assert.equal(note.querySelector(".rk-led").getAttribute("data-ch"), "you");
    await click(note.querySelector('[data-roko="fix-done-note-close"]'));
  } finally {
    await cleanup();
  }
});

test("a blocking problem: start is off in the composer, with the problem and its fix in place", async () => {
  const { container } = await setup({ edit: (fx) => { fx.overview.setup = { ok: false, problems: [PROBLEM_BOUNDARY] }; } });
  try {
    await click(button(container, "New run"));
    const dialog = container.querySelector('[data-roko="composer"]');
    await typeInto(dialog.querySelector("textarea"), "Write the docs");
    const start = dialog.querySelector('[data-roko="composer-submit"]');
    assert.ok(start.disabled);
    assert.equal(start.getAttribute("title"), "roko refuses runs started from Hermes in this workspace.");
    const card = dialog.querySelector('[data-roko="problem-card-workspace-refuses-chat-runs"]');
    assert.ok(card);
    assert.match(text(card), /roko can't start work from Hermes until this is fixed:/);
    assert.ok(card.querySelector('[data-roko="fix-workspace-refuses-chat-runs"]'));
  } finally {
    await cleanup();
  }
});

test("a refused start shows the problem roko named instead of a raw error", async () => {
  const { container } = await setup({
    edit: (fx) => { fx.started = { ok: false, error: { code: "refused", message: PROBLEM_BOUNDARY.title, hint: "" }, problem: PROBLEM_BOUNDARY }; },
  });
  try {
    await click(button(container, "New run"));
    const dialog = container.querySelector('[data-roko="composer"]');
    await typeInto(dialog.querySelector("textarea"), "Write the docs");
    await click(dialog.querySelector('[data-roko="composer-submit"]'));
    const card = container.querySelector('[data-roko="composer"] [data-roko="problem-card-workspace-refuses-chat-runs"]');
    assert.ok(card, "the problem card");
    assert.match(text(card), /roko did not start it:/);
    assert.equal(container.querySelector('[data-roko="composer"] .roko-error'), null, "no raw error");
  } finally {
    await cleanup();
  }
});

test("plans: a blocking problem turns Run plan… off; a refused plan run shows the problem", async () => {
  let ctx = await setup({
    url: "http://localhost/roko?section=plans&plan=" + IDS.plan,
    edit: (fx) => { fx.overview.setup = { ok: false, problems: [PROBLEM_BOUNDARY] }; },
  });
  try {
    const form = ctx.container.querySelector(".roko-runform");
    assert.ok(form.querySelector('[data-roko="run-plan"]').disabled);
    assert.ok(form.querySelector('[data-roko="problem-card-workspace-refuses-chat-runs"]'));
  } finally {
    await cleanup();
  }
  ctx = await setup({
    url: "http://localhost/roko?section=plans&plan=" + IDS.plan,
    edit: (fx) => { fx.plan_started = { ok: false, error: { code: "refused", message: PROBLEM_BOUNDARY.title, hint: "" }, problem: PROBLEM_BOUNDARY }; },
  });
  try {
    const form = ctx.container.querySelector(".roko-runform");
    await submit(form);
    await click(ctx.container.querySelector('[role="alertdialog"] [data-confirm="yes"]'));
    const card = form.querySelector('[data-roko="problem-card-workspace-refuses-chat-runs"]');
    assert.ok(card, "the problem with its fix");
    assert.match(text(card), /roko did not start the plan:/);
    assert.ok(card.querySelector('[data-roko="fix-workspace-refuses-chat-runs"]'));
  } finally {
    await cleanup();
  }
});

test("slots: chat:top and sessions:top show a problem that stops runs; the chip says setup", async () => {
  const backend = makeBackend("idle", (fx) => { fx.overview.setup = { ok: false, problems: [PROBLEM_BOUNDARY] }; });
  const registry = loadBundle(backend);
  try {
    const slot = (name) => registry.slots.find((s) => s.slot === name).component;
    const chat = await mount(slot("chat:top"), { url: "http://localhost/chat" });
    const line = chat.container.querySelector('[data-roko="chat-setup"]');
    assert.ok(line, "above the chat");
    assert.equal(line.getAttribute("data-ch"), "fail");
    assert.match(text(line), /roko refuses runs started from Hermes in this workspace\. make ready →/);
    const sessions = await mount(slot("sessions:top"), { url: "http://localhost/sessions" });
    assert.ok(sessions.container.querySelector('[data-roko="sessions-setup"]'));
    const chip = await mount(slot("header-right"), { url: "http://localhost/sessions" });
    assert.equal(text(chip.container.querySelector('[data-roko="chip-setup"]')), "setup");
  } finally {
    await cleanup();
  }
  // A problem that does not stop runs stays off the chat.
  const warnOnly = makeBackend("idle", (fx) => { fx.overview.setup = { ok: true, problems: [PROBLEM_MODEL] }; });
  const warnRegistry = loadBundle(warnOnly);
  try {
    const chat = await mount(warnRegistry.slots.find((s) => s.slot === "chat:top").component);
    assert.equal(chat.container.innerHTML, "");
  } finally {
    await cleanup();
  }
});

test("without install on the overview, the page and the slots read /health once, together", async () => {
  const backend = makeBackend("normal", (fx) => {
    delete fx.overview.install;
    fx.health.install = { ...currentInstall(), backend_stale: true, disk_version: NEWER };
  });
  const registry = loadBundle(backend);
  try {
    const page = await mount(registry.pages.roko);
    await mount(registry.slots.find((s) => s.slot === "header-right").component);
    await mount(registry.slots.find((s) => s.slot === "sessions:top").component);
    await settle();
    assert.ok(text(page.container.querySelector('[data-roko="restart"]')).includes("roko " + NEWER + " is installed, but this dashboard is still running " + VERSION + "."));
    assert.equal(backend.calls.filter((c) => c.url.endsWith("/health")).length, 1);
  } finally {
    await cleanup();
  }
});

// --------------------------------------------------------------------------------
// Phase 2: what happened, said plainly (phase2-plugin.md U1–U13, R1–R12)
// --------------------------------------------------------------------------------

test("live: the light says LIVE only while roko's event stream is open; otherwise polling or connecting, unlit", async () => {
  const env = await liveSetup({ url: runUrl(IDS.live) });
  try {
    const socket = FakeSocket.all[0];
    const state = () => env.container.querySelector('[data-roko="live-state"]').getAttribute("data-state");
    await push(socket, { type: "hello", version: VERSION, overview: env.backend.fx.overview, hub: "backoff" });
    assert.equal(state(), "polling", "the plugin's socket is open, roko's stream is not");
    assert.equal(env.container.querySelector('[data-roko="live-state"] .rk-led').getAttribute("data-ch"), "off");
    await push(socket, { type: "ping", hub: "connecting" });
    assert.equal(state(), "connecting");
    await push(socket, { type: "ping", hub: "open" });
    assert.equal(state(), "live");
    // An agent's step comes only from roko's stream: it is open, whatever the last ping said.
    await push(socket, { type: "ping", hub: "backoff" });
    assert.equal(state(), "polling");
    await push(socket, { type: "live", run_id: IDS.live, task_id: "T2", attempt: 1, kind: "tool", tool: "Read", target: "x", ts: Date.now() });
    assert.equal(state(), "live");
  } finally {
    await cleanup();
    env.restore();
  }
});

test("a router's pick keeps its scores; the models the run cannot use fold away; roko's decided_by names who picked", async () => {
  const { container } = await setup({
    url: runUrl(IDS.live),
    edit: (fx) => {
      const t1 = fx.runs[IDS.live].run.tasks.find((t) => t.task_id === "T1");
      t1.attempt_log[0].route = {
        attempt: 1, model: "gpt-5.4-mini", provider: "openai", source: "router", stage: "learned", decided_by: "learned", rung: null,
        scored: true, reason: "router", p: 0.82,
        candidates: [
          { model: "gpt-5.4-mini", provider: "openai", score: 0.71, p: 0.82, eligible: true },
          { model: "glm-5.1", provider: "zai", score: 0.52, p: 0.18, eligible: true },
          { model: "gemini-2.5-pro", provider: "gemini", score: 0.11, p: null, eligible: false, why_not: "provider_unconfigured: GEMINI_API_KEY is not set" },
        ],
      };
    },
  });
  try {
    await click(node(container, "T1"));
    const route = container.querySelector('[data-roko-inspector="T1"] [data-roko="route"]');
    assert.equal(route.getAttribute("data-decided-by"), "learned");
    assert.match(text(route.querySelector(".rk-route-head")), /^picked by what roko learned p 0\.82$/);
    assert.equal(route.getAttribute("data-scored"), "true", "its scores decided");
    assert.equal(route.querySelectorAll(".rk-cand-bar").length, 2, "bars for the two it weighed");
    assert.match(text(route), /1 model this run cannot use ›/);
    assert.ok(!text(route).includes("gemini-2.5-pro"), "folded until asked");
  } finally {
    await cleanup();
  }
});

test("a run whose card has no graph still gets a sequencer: one task is one pad, more are waved by their dependencies", async () => {
  const one = await setup({ url: runUrl(IDS.prompt), edit: (fx) => { delete fx.runs[IDS.prompt].run.graph; } });
  try {
    assert.equal(one.container.querySelectorAll(".rk-pad").length, 1, "one pad");
    assert.equal(one.container.querySelectorAll(".roko-graph-wave").length, 1);
    assert.equal(one.container.querySelector(".roko-graph-empty"), null);
  } finally {
    await cleanup();
  }
  const many = await setup({ url: runUrl(IDS.multiwave), edit: (fx) => { delete fx.runs[IDS.multiwave].run.graph; } });
  try {
    const waves = [...many.container.querySelectorAll(".roko-graph-wave")].map((w) => text(w));
    assert.deepEqual(waves, ["01", "02 2 at once", "03", "04"]);
  } finally {
    await cleanup();
  }
});

test("what roko learned, in words: nothing new to learn, lessons it had confirmed, moved up; never a 'none' lesson", async () => {
  const { container } = await setup({
    url: runUrl(IDS.multiwave),
    edit: (fx) => {
      fx.runs[IDS.multiwave].run.tasks.find((t) => t.task_id === "T1").lessons = [{ admission: "no_candidate", entry_id: null, lesson: "none", reinforced: 3, promoted: 3 }];
    },
  });
  try {
    await click(node(container, "T1"));
    const lessons = container.querySelector('[data-roko-inspector="T1"] .rk-lessons');
    assert.equal(text(lessons), "nothing new to learn from this task · confirmed 3 lessons it had · 3 moved up a tier");
    assert.ok(!/\bnone\b/.test(text(lessons)), "never a 'none' lesson");
  } finally {
    await cleanup();
  }
});

test("the four signals: live work is blue (live), and no blue agent channel is left", async () => {
  const home = await setup();
  try {
    assert.equal(home.container.querySelector(`[data-roko="run-card"][data-run="${IDS.live}"]`).getAttribute("data-state"), "live");
  } finally {
    await cleanup();
  }
  const run = await setup({ url: runUrl(IDS.live) });
  try {
    assert.ok(run.container.querySelector('.rk-led[data-ch="live"]'), "a blue LED while an agent works");
    assert.equal(run.container.querySelectorAll('[data-ch="agent"]').length, 0);
  } finally {
    await cleanup();
  }
});

test("Plans: waves and how many run at once agree; Run plan… starts at the composer's $0.50, or covers roko's estimate", async () => {
  const { container } = await setup({ url: "http://localhost/roko?section=plans&plan=" + IDS.plan });
  try {
    const stats = container.querySelector('[data-roko="plan"] [data-roko="plan-stats"]');
    assert.match(text(stats.querySelector('[data-roko="plan-waves"]')), /4 steps each step waits for the one before/);
    const parallel = stats.querySelector('[data-roko="plan-parallel"]');
    assert.equal(text(parallel), "at once 2 at once side by side, at most");
    assert.equal(parallel.getAttribute("title"), "2 tasks side by side at most");
    assert.equal(container.querySelector('.roko-runform [data-roko="knob"]').getAttribute("aria-valuenow"), "0.5");
  } finally {
    await cleanup();
  }
  // A chain of one task per wave runs one at a time, whatever max_parallel says; a dearer plan starts above its estimate.
  const chain = await setup({
    url: "http://localhost/roko?section=plans&plan=" + IDS.plan,
    edit: (fx) => {
      const plan = fx.plan_details[IDS.plan].plan;
      plan.tasks = plan.tasks.slice(0, 2);
      plan.waves = [["T1"], ["T2"]];
      plan.task_count = 2;
      plan.max_parallel = 2;
      plan.estimate.total_cost_usd = 1.3;
    },
  });
  try {
    assert.equal(text(chain.container.querySelector('[data-roko="plan-parallel"]')), "at once one task at a time");
    assert.equal(chain.container.querySelector('.roko-runform [data-roko="knob"]').getAttribute("aria-valuenow"), "2");
  } finally {
    await cleanup();
  }
});

test("a plan generation reads as a written plan, not a success: \"plan written\", unlit", async () => {
  const gen = "22222222-3333-4444-8555-666666666666";
  const { container } = await setup({
    url: runUrl(gen),
    edit: (fx) => {
      fx.overview.runs.unshift({ run_id: gen, kind: "plan_generate", label: "Split the ledger", plan_id: IDS.plan, state: "succeeded", active: false, cost_usd: null, max_usd: null, started_at: new Date().toISOString() });
      fx.runs[gen] = { ok: true, run: { run_id: gen, kind: "plan_generate", label: "Split the ledger", plan_id: IDS.plan, state: "succeeded", verdict: "succeeded", active: false, task_count: 5, tasks: [], gates: {}, milestones: [], waiting: [] } };
    },
  });
  try {
    assert.equal(text(container.querySelector('[data-roko="hero"] [data-roko="card-pill"]')), "✓ plan written");
    // The "planning" badge was the work; once the plan is written it is gone.
    assert.equal(container.querySelector('[data-roko="hero"] .roko-kind'), null);
    // A plan writing that ended is its plan's: Runs lists runs, and Plans has the plan.
    await click(container.querySelector('[data-roko="crumb-runs"]'));
    assert.ok(container.querySelector('[data-roko="runs-home"]'));
    assert.equal(container.querySelector(`[data-roko="run-line"][data-run="${gen}"]`), null);
  } finally {
    await cleanup();
  }
});

test("a long check says what roko checks, where and for how long, also when no task runs", async () => {
  const { container } = await setup({
    url: runUrl(IDS.live),
    edit: (fx) => {
      const card = fx.runs[IDS.live].run;
      card.tasks.forEach((t) => { t.outcome = "passed"; t.step = null; });
      card.checking = { what: "clippy", label: "cargo clippy", scope: "workspace", task_id: null, step: 2, steps: 3, since: new Date(Date.now() - 192000).toISOString(), elapsed_s: 192, source: "roko" };
    },
  });
  try {
    const ticker = container.querySelector('[data-roko="ticker"]');
    assert.ok(ticker, "the ticker shows the check although no task runs");
    assert.match(text(ticker), /checking the workspace: cargo clippy \(2 of 3\) · 3:1\d/);
    assert.equal(text(container.querySelector('[data-roko="hero"] [data-roko="card-status"]')), "checking the workspace: cargo clippy (2 of 3).");
  } finally {
    await cleanup();
  }
  // An older backend says nothing about checks: a running run whose tasks all ended is finishing them.
  const old = await setup({
    url: runUrl(IDS.live),
    edit: (fx) => { fx.runs[IDS.live].run.tasks.forEach((t) => { t.outcome = "passed"; t.step = null; }); },
  });
  try {
    assert.match(text(old.container.querySelector('[data-roko="ticker"]')), /finishing: the plan's checks before delivery/);
  } finally {
    await cleanup();
  }
  // The backend's own guess on an older roko (`source: "plugin"`) reads the same; a task's check names the task.
  const guessed = await setup({
    url: runUrl(IDS.live),
    edit: (fx) => {
      const card = fx.runs[IDS.live].run;
      card.tasks.forEach((t) => { t.outcome = "passed"; t.step = null; });
      card.checking = { what: "plan_check", label: "the plan's checks before delivery", scope: "plan", task_id: null, since: new Date(Date.now() - 20000).toISOString(), elapsed_s: 20, source: "plugin" };
    },
  });
  try {
    assert.match(text(guessed.container.querySelector('[data-roko="ticker"]')), /finishing: the plan's checks before delivery · 0:2\d/);
    assert.ok(!text(guessed.container).includes("checking the plan"), "a guess is not said as roko's own check");
  } finally {
    await cleanup();
  }
});

const DEMO_ROW = { id: "demo-hello-world", title: "Start here: hello world demo", task_count: 1, tasks_done: 0, tasks_not_passed: 0, status: "fixture", group: "demos" };
const DEMO_DETAIL = {
  ok: true,
  plan: {
    plan_id: "demo-hello-world", title: "Start here: hello world demo", task_count: 1, max_parallel: 1,
    tasks: [{ id: "HELLO-1", title: "Write hello world", depends_on: [], checks: ["rustc demo/hello-world/main.rs"] }],
    waves: [["HELLO-1"]], estimate: { total_cost_usd: 0.004, total_duration_secs: 20, confidence: "low", basis: "" },
  },
};

test("Composer: run a plan roko already has: the demo to start with, its cap, one key", async () => {
  const { container, backend } = await setup({
    edit: (fx) => {
      fx.plans.plans.unshift(DEMO_ROW);
      fx.plan_details["demo-hello-world"] = DEMO_DETAIL;
    },
  });
  try {
    await click(button(container, "New run"));
    const dialog = container.querySelector('[data-roko="composer"]');
    // The demo is among the TRY chips; the run-a-plan key switches the device to plans.
    assert.equal(text(dialog.querySelector('[data-roko="try-demo"]')), "▶ hello world demo");
    assert.ok(!text(dialog).includes("tests/test_ledger.py"), "no example names a file this project may lack");
    await click(dialog.querySelector('[data-roko="composer-plan"]'));
    const picks = dialog.querySelector('[data-roko="composer-plans"]');
    assert.ok(picks, "the plan list");
    const chosen = picks.querySelectorAll('[aria-checked="true"]');
    assert.equal(chosen.length, 1);
    assert.equal(chosen[0].getAttribute("data-roko-pick"), "demo-hello-world", "the demo to start with is picked; nothing else is");
    assert.match(text(dialog), /1 task · 1 step · roko estimates <\$0\.01 · a demo: its output stays on its run branch/);
    assert.equal(dialog.querySelectorAll(".rk-module-idx").length, 0, "no numbered modules");
    assert.equal(text(dialog.querySelector('[data-roko="composer-request"]')), "a new request instead");
    assert.equal(text(dialog.querySelector('[data-roko="composer-note"]')), "roko runs the plan's tasks, each checked, and stops at the $0.50 cap.");
    assert.ok(!dialog.querySelector('[aria-label="Kind of work"]'), "a plan's checks are set: no kind of work to pick");
    const start = dialog.querySelector('[data-roko="composer-submit"]');
    assert.equal(text(start), "run plan · cap $0.50 ⌘↵");
    await click(start);
    const post = posts(backend, "/plans/demo-hello-world/run");
    assert.equal(post.length, 1);
    assert.deepEqual(post[0].body, { max_usd: 0.5, resume: false });
    assert.equal(container.querySelector('[data-roko="composer"]'), null, "the dialog closed");
  } finally {
    await cleanup();
  }
});

test("an interrupted plan run offers one next step: run it again, on its plan, skipping what passed, at its cap", async () => {
  const edit = (fx) => {
    const card = fx.runs[IDS.multiwave].run;
    Object.assign(card, {
      state: "interrupted", verdict: "interrupted", active: false, kind: "plan", plan_id: IDS.plan, max_usd: 1,
      interrupted: { reason: "roko stopped while this run was going (machine restart or crash)", at: card.finished_at, source: "roko" },
    });
    // roko's last known state still calls T5 running (an older roko, or the plugin's own finding).
    Object.assign(card.tasks.find((t) => t.task_id === "T5"), { outcome: "running", step: "agent", step_detail: "glm-5.1", step_since: card.finished_at });
    card.progress = { ...card.progress, passed: 4, running: 1 };
    fx.overview.runs.forEach((row) => { if (row.run_id === IDS.multiwave) Object.assign(row, { state: "interrupted", active: false }); });
  };
  const { container, backend } = await setup({ url: runUrl(IDS.multiwave), edit });
  try {
    // Nothing runs it any more: the task it was on is stopped, with no agent and no clock.
    assert.equal(node(container, "T5").getAttribute("data-state"), "stopped");
    assert.ok(!/agent/.test(text(node(container, "T5"))));
    assert.equal(container.querySelector('[data-roko="ticker"]'), null);
    await click(container.querySelector('[data-roko="rerun"]'));
    const dialog = container.querySelector('[data-roko="composer"]');
    assert.ok(dialog, "the composer, on the plan");
    assert.equal(dialog.querySelector('[data-roko="composer-plans"] [aria-checked="true"]').getAttribute("data-roko-pick"), IDS.plan);
    assert.ok(dialog.querySelector('input[type="checkbox"]').checked, "skip tasks that already passed");
    await click(dialog.querySelector('[data-roko="composer-submit"]'));
    assert.deepEqual(posts(backend, "/plans/" + IDS.plan + "/run")[0].body, { max_usd: 1, resume: true });
  } finally {
    await cleanup();
  }
});

test("Changes: an unverified run's work is shown, marked unverified, and merging it asks once more", async () => {
  const id = IDS.prompt;
  const edit = (fx) => {
    const card = fx.runs[id].run;
    Object.assign(card, {
      state: "unverified", verdict: "unverified", delivered: null, review_command: null,
      work: {
        kind: "unverified", source: "roko",
        parts: [{
          trust: "unverified", delivered: false, plan_id: "p-1", branch: "roko/plan/p-1", commit: "d0dc746", base: "89e5bcd",
          files_changed: ["tally/cli.py"], diffstat: { files: 1, additions: 9, deletions: 0 }, tasks: [{ task_id: "T1", verdict: "unverified" }],
          review_command: "git diff 89e5bcd..roko/plan/p-1",
        }],
      },
    });
    fx.overview.runs.forEach((row) => { if (row.run_id === id) row.state = "unverified"; });
    Object.assign(fx.diffs[id].diff, { work: "unverified", plan_id: "p-1", branch: "roko/plan/p-1", delivered: false });
    fx.merges[id] = {
      ok: true,
      merge: {
        can_merge: true, available: true, merged: false, mode: "fast-forward", into: "main", branch: "roko/plan/p-1", commit: "d0dc746",
        reason: null, demo: false, work: "unverified", confirm: "No check ran on this work. Merge it only if you read it and want it.",
        dirty: [], fix: null, command: "git merge --ff-only roko/plan/p-1",
      },
    };
  };
  const { container, backend } = await setup({ url: runUrl(id, "&view=changes"), edit });
  try {
    assert.match(text(container.querySelector('[data-roko="unverified-banner"]')), /^Unverified: no check ran on this work\. roko did not deliver it: it stays on its plan branch\. Read it before you take it \(T1\)\.$/);
    assert.ok(container.querySelector(".roko-dfile"), "the diff, not \"no changes\"");
    assert.match(text(container.querySelector('[data-roko="merge-unverified"]')), /Unverified, but it can merge into main/);
    assert.equal(text(container.querySelector('[data-roko="merge-tag"]')), "unverified");
    assert.ok(container.querySelector('[data-roko="merge-key"]').classList.contains("rk-key--you"), "the changes' one orange key");
    assert.ok(buttons(container).some((b) => text(b).startsWith("Copy git diff")), "its own review command");
    await click(button(container, "merge anyway…"));
    // The dialog is the one more yes: roko's sentence first, then a key that names what it merges.
    assert.match(text(container.querySelector('[data-roko="merge"] .roko-modal-title')), /Merge this unverified work into main\?/);
    assert.match(text(container.querySelector('[data-roko="merge-confirm"]')), /^No check ran on this work\. Merge it only if you read it and want it\.$/);
    assert.equal(text(container.querySelector('[data-confirm="merge"]')), "Merge unverified work");
    await click(container.querySelector('[data-confirm="merge"]'));
    const body = posts(backend, "/runs/" + id + "/merge")[0].body;
    assert.equal(body.confirm, true);
    assert.equal(body.work, "unverified");
    assert.equal(body.plan_id, "p-1");
  } finally {
    await cleanup();
  }
});

test("Changes: a partial run's verified and unverified parts each have a key; the unverified one is marked", async () => {
  const id = IDS.multiwave;
  const edit = (fx) => {
    fx.runs[id].run.work = {
      kind: "partial", source: "roko",
      parts: [
        // A newer backend's `counts` beside git's sentence.
        { trust: "verified", delivered: true, plan_id: "p-1", branch: "roko/batch/x", commit: "aaa", base: "bbb", files_changed: ["a.py"], diffstat: "1 file changed, 3 insertions(+)", counts: { files: 1, additions: 3, deletions: 0 }, tasks: [{ task_id: "T1", verdict: "passed" }], review_command: "git diff bbb..roko/batch/x" },
        // docs/ui-api.md's shape: `diffstat` is git's own sentence.
        { trust: "unverified", delivered: false, plan_id: "p-1", branch: "roko/plan/p-1", commit: "ccc", base: "bbb", files_changed: ["b.py"], diffstat: "1 file changed, 5 insertions(+), 1 deletion(-)", tasks: [{ task_id: "T2", verdict: "unverified" }], review_command: "git diff bbb..roko/plan/p-1" },
      ],
    };
  };
  const { container, backend } = await setup({ url: runUrl(id, "&view=changes"), edit });
  try {
    const keys = [...container.querySelectorAll('[data-roko="work-parts"] button')].map((b) => text(b));
    // The desktop's words (ui-notes R2): the plan only for work roko did not deliver.
    assert.deepEqual(keys, ["verified · 1 file", "unverified · p-1 · 1 file"]);
    assert.equal(container.querySelector('[data-roko="unverified-banner"]'), null, "the verified part first");
    await click(button(container.querySelector('[data-roko="work-parts"]'), "unverified · p-1 · 1 file"));
    assert.ok(backend.calls.some((c) => c.url === "/api/plugins/roko/runs/" + id + "/diff?work=unverified&plan_id=p-1"));
  } finally {
    await cleanup();
  }
});

test("Changes: a dirty checkout names its files and offers the one fix the backend names (commit roko.toml)", async () => {
  const id = IDS.prompt;
  const { container } = await setup({
    url: runUrl(id, "&view=changes"),
    edit: (fx) => {
      fx.merges[id] = {
        ok: true,
        merge: {
          can_merge: false, available: false, merged: false, reason: "the checkout has uncommitted changes to 1 tracked file",
          demo: false, work: "verified", confirm: null, dirty: ["roko.toml"],
          fix: { kind: "action", label: "commit roko.toml", action: "commit-roko-toml", command: "git -C /home/demo/code/tally commit -m 'roko: accept runs started from Hermes' -- roko.toml", docs: null },
          command: "git merge --ff-only roko/batch/x",
        },
      };
    },
  });
  try {
    const box = container.querySelector('[data-roko="merge-blocked"]');
    assert.match(text(box), /Commit your changes first/);
    assert.match(text(box.querySelector('[data-roko="merge-dirty"]')), /uncommitted: roko\.toml/);
    assert.ok(box.querySelector('[data-roko="fix-merge-commit-roko-toml"]'), "the commit key");
  } finally {
    await cleanup();
  }
});

test("a demo run's card says demo: no Merge, and the plan list is not read", async () => {
  const id = IDS.multiwave;
  const { container, backend } = await setup({ url: runUrl(id, "&view=changes"), edit: (fx) => { fx.runs[id].run.demo = true; } });
  try {
    assert.match(text(container.querySelector('[data-roko="demo-output"]')), /Demo output: it stays on its run branch/);
    assert.ok(!backend.calls.some((c) => c.url === "/api/plugins/roko/plans"), "the card says it");
  } finally {
    await cleanup();
  }
});

test("Insights: the numbers say whose runs and since when; a newer backend switches between Hermes and the workspace", async () => {
  const old = await setup({ url: "http://localhost/roko?section=health" });
  try {
    assert.equal(text(old.container.querySelector('[data-roko="insights-scope"]')), "the whole workspace");
    assert.equal(old.container.querySelector('[data-roko="insights-scope"] .rk-switch'), null, "an older backend has one scope");
  } finally {
    await cleanup();
  }
  const { container, backend } = await setup({
    url: "http://localhost/roko?section=health",
    edit: (fx) => {
      fx.insights.scope = { kind: "hermes", label: "runs started from Hermes", since: new Date(Date.now() - 3 * 86400000).toISOString(), until: null };
      fx.insights.summary = { runs: 4, tasks: { total: 6, verified: 4, unverified: 1, failed: 1 }, checks: { passed: 9, failed: 1, ran: 10, pass_rate: 0.9 }, spend_usd: 0.12, cost_per_task_usd: 0.02, typical_task_ms: 33000 };
    },
  });
  try {
    const bar = container.querySelector('[data-roko="insights-scope"]');
    assert.match(text(bar.querySelector(".rk-scope-label")), /^numbers for runs started from Hermes · since (\w+ \d+|\d+ \w+)$/);
    assert.ok(button(bar, "from Hermes"), "two keys: from Hermes, whole workspace");
    assert.match(text(container), /Checks passing 90% 9 of 10 checks that ran/);
    assert.match(text(container), /6 tasks recorded · 1 not checked \(no check ran\), not counted/);
    await click(button(bar, "whole workspace"));
    assert.ok(backend.calls.some((c) => c.url.endsWith("/insights?scope=workspace")));
  } finally {
    await cleanup();
  }
});

test("a run that passed without changing a file: no changes to review, no Merge, no +0 −0 (real roko, 2026-10-15)", async () => {
  const id = IDS.prompt;
  const { container } = await setup({
    url: runUrl(id, "&view=changes"),
    edit: (fx) => {
      Object.assign(fx.diffs[id].diff, { files: [], totals: { files: 0, additions: 0, deletions: 0 } });
    },
  });
  try {
    assert.match(text(container.querySelector(".roko-changes")), /^No changes to review Its checks passed without it changing a file\.$/);
    assert.equal(container.querySelector(".roko-mergebox"), null, "nothing to merge");
    assert.equal(text(container.querySelector('[data-roko="fold-changes"] > summary')), "the changes", "no +0 −0 on the fold");
    assert.equal(container.querySelector('[data-roko="hero-review"]'), null);
  } finally {
    await cleanup();
  }
  // Work kept on a plan branch of a workspace on another machine: where to read it, as the desktop says it.
  const remote = await setup({
    url: runUrl(id, "&view=changes"),
    edit: (fx) => {
      fx.diffs[id] = {
        ok: true,
        diff: {
          available: false, why: "elsewhere", files: [], totals: { files: 0, additions: 0, deletions: 0 },
          message: "roko's workspace is not on this machine, so the plugin cannot read these changes; where roko runs: git -C /srv/ws diff a1..roko/plan/p-1",
          command: "git -C /srv/ws diff a1..roko/plan/p-1",
        },
      };
    },
  });
  try {
    const changes = remote.container.querySelector(".roko-changes");
    assert.match(text(changes), /^The changes are where roko runs roko's workspace is not on this machine/);
    assert.ok(buttons(changes).some((b) => text(b).startsWith("Copy git diff")), "the command to run there");
  } finally {
    await cleanup();
  }
});

test("a run from Hermes cannot use a CLI agent: an older backend's CLI candidates fold away with the reason", async () => {
  const { container } = await setup({
    url: runUrl(IDS.live),
    edit: (fx) => {
      const t1 = fx.runs[IDS.live].run.tasks.find((t) => t.task_id === "T1");
      t1.attempt_log[0].route = {
        attempt: 1, model: "gpt-5.4-mini", provider: "openai", source: "ladder", stage: "ladder", reason: "ladder", p: 1.0,
        candidates: [
          { model: "gpt-5.4-mini", provider: "openai", score: 0.11, p: 1.0, eligible: true, ineligible_reason: null },
          { model: "claude-sonnet-4-6", provider: "claude_cli", score: 0.11, p: 0.0, eligible: true, ineligible_reason: null },
        ],
      };
    },
  });
  try {
    await click(node(container, "T1"));
    const route = container.querySelector('[data-roko-inspector="T1"] [data-roko="route"]');
    assert.deepEqual([...route.querySelectorAll(".rk-cands:not(.rk-cands--out) .rk-cand")].map((c) => text(c)), ["gpt-5.4-mini picked"]);
    await click(button(route, "1 model this run cannot use ›"));
    assert.match(text(route.querySelector(".rk-cands--out")), /claude-sonnet-4-6 runs its own tools: a run started from Hermes needs a model in roko's own tool loop/);
  } finally {
    await cleanup();
  }
});

test("S3: Hermes approvals off is a setup warning with the exact setting to change, copyable; new runs still start", async () => {
  const problem = {
    id: "approvals-off", severity: "warn", title: "Hermes approvals are off: roko runs start without asking you.",
    detail: "approvals.mode is off (the desktop's ⚡ Off), so every paid roko run starts with no question.",
    fix: { kind: "command", label: "copy the setting", action: null, command: "hermes config set approvals.mode smart", docs: "using-roko.md#when-hermes-approvals-are-off" },
  };
  const { container } = await setup({ edit: (fx) => { fx.overview.setup = { ok: true, problems: [problem] }; } });
  try {
    const row = container.querySelector('[data-roko="problem-approvals-off"]');
    assert.ok(row, "on the setup module");
    assert.match(text(row), /Hermes approvals are off: roko runs start without asking you\./);
    assert.match(text(row.querySelector(".rk-fixcmd")), /hermes config set approvals\.mode smart/);
    assert.ok(row.querySelector('[data-roko="fix-copy-approvals-off"]'), "a copy key");
    await click(button(container, "New run"));
    const dialog = container.querySelector('[data-roko="composer"]');
    await typeInto(dialog.querySelector("textarea"), "Add a test");
    assert.ok(!dialog.querySelector('[data-roko="composer-submit"]').disabled, "a warning does not stop runs");
  } finally {
    await cleanup();
  }
});

/** One of plugin-runs' real cards, its times moved so roko checked it just now. */
function realCard(name) {
  const card = REAL_CARDS[name];
  return shifted(structuredClone(card), Date.now() - Date.parse(card.checked_at));
}
/** The fake backend with a real card: the card on /runs/{id}, its row on the overview. */
function withReal(fx, card) {
  fx.runs[card.run_id] = { ok: true, run: card };
  fx.overview.runs.unshift({
    run_id: card.run_id, kind: card.kind, label: card.label, plan_id: card.plan_id, state: card.state, active: card.active, cost_usd: card.cost_usd,
    max_usd: card.max_usd, started_at: card.started_at, finished_at: card.finished_at, session_id: card.session_id, source: card.source, progress: card.progress, note: null,
  });
}
/** The diff the backend answers for a real card's part: one file, one added line. */
function realDiff(part, path) {
  return {
    ok: true,
    diff: {
      available: true, work: part.trust, plan_id: part.delivered ? null : part.plan_id, delivered: part.delivered, branch: part.branch, commit: part.commit,
      files: [{ path: path, old_path: null, status: "modified", additions: 1, deletions: 0, binary: false, language: null, hunks: [{ header: "@@ -1,0 +1,1 @@", old_start: 1, new_start: 1, context: null, lines: [["+", null, 1, "Made with roko."]] }] }],
      totals: { files: 1, additions: 1, deletions: 0 }, truncated: false,
    },
  };
}

test("real cards: an interrupted run's kept work merges after one more yes, as work roko did not fully check", async () => {
  const card = realCard("interrupted");
  const id = card.run_id;
  const { container, backend } = await setup({
    url: runUrl(id),
    edit: (fx) => {
      withReal(fx, card);
      fx.diffs[id] = realDiff(card.work.parts[0], "notes/hello.txt");
      fx.merges[id] = { ok: true, merge: card.merge };
    },
  });
  try {
    assert.match(text(container.querySelector('[data-roko="hero"]')), /interrupted/);
    assert.equal(text(container.querySelector('[data-roko="rerun"]')), "run the plan again", "the backend's next key");
    await openFold(container, "changes");
    // The card has `merge` (a newer backend): its kept work can merge, after the second yes.
    assert.equal(container.querySelector('[data-roko="interrupted-output"]'), null);
    const box = container.querySelector('[data-roko="merge-unverified"]');
    assert.match(text(box), /^Not fully checked, but it can merge into main/);
    assert.equal(text(box.querySelector('[data-roko="merge-tag"]')), "not fully checked");
    await click(button(container, "merge anyway…"));
    assert.match(text(container.querySelector('[data-roko="merge"] .roko-modal-title')), /^Merge work roko did not fully check into main\?$/);
    assert.equal(text(container.querySelector('[data-roko="merge-confirm"]')), card.merge.confirm);
    assert.equal(text(container.querySelector('[data-confirm="merge"]')), "Merge anyway");
    await click(container.querySelector('[data-confirm="merge"]'));
    assert.deepEqual(posts(backend, "/runs/" + id + "/merge")[0].body, { commit: "ef085652eea1", confirm: true });
  } finally {
    await cleanup();
  }
});

test("real cards: unverified work, a plugin's guess at a long check, and a start roko refused", async () => {
  const unverified = realCard("unverified");
  const id = unverified.run_id;
  const part = unverified.work.parts[0];
  const one = await setup({
    url: runUrl(id),
    edit: (fx) => {
      withReal(fx, unverified);
      fx.diffs[id] = realDiff(part, "README.md");
      fx.merges[id] = { ok: true, merge: unverified.merge };
    },
  });
  try {
    // One orange key, "review"; the backend's longer words are its hover.
    const review = one.container.querySelector('[data-roko="hero-review"]');
    assert.equal(text(review), "review");
    assert.equal(review.getAttribute("title"), "review the unverified changes: no check ran on them");
    await click(review);
    assert.equal(one.container.querySelector('[data-roko="fold-changes"]').open, true, "review opens the changes");
    assert.equal(one.container.querySelector('[data-roko="hero-review"]'), null, "with them open, their keys are the ones");
    assert.equal(
      text(one.container.querySelector('[data-roko="unverified-banner"]')),
      "Unverified: no check ran on this work. roko did not deliver it: it stays on its plan branch. Read it before you take it (T1)."
    );
    assert.equal(text(one.container.querySelector('[data-roko="merge-tag"]')), "unverified");
    await click(button(one.container, "merge anyway…"));
    assert.match(text(one.container.querySelector('[data-roko="merge"] .roko-modal-title')), /^Merge this unverified work into main\?$/);
    await click(one.container.querySelector('[data-confirm="merge"]'));
    assert.deepEqual(posts(one.backend, "/runs/" + id + "/merge")[0].body, { commit: part.commit, confirm: true, work: "unverified", plan_id: part.plan_id });
  } finally {
    await cleanup();
  }
  const checking = realCard("checking");
  const two = await setup({ url: runUrl(checking.run_id), edit: (fx) => withReal(fx, checking) });
  try {
    assert.match(text(two.container.querySelector('[data-roko="ticker"]')), /finishing: the plan's checks before delivery · 0:[12]\d/);
  } finally {
    await cleanup();
  }
  const refused = realCard("lockfail");
  const three = await setup({ url: runUrl(refused.run_id), edit: (fx) => withReal(fx, refused) });
  try {
    assert.match(text(three.container), /roko did not start the run: A roko plan runner is already active in this workspace \(PID 4066\)/);
    const next = three.container.querySelector(".rk-next-words");
    assert.equal(text(next), "nothing to merge", "a next with no action is words, not a key");
    assert.equal(next.getAttribute("title"), "demo output stays on its run branch");
    await openFold(three.container, "changes");
    assert.match(text(three.container.querySelector(".roko-changes")), /No changes to review This run left no changes\./);
  } finally {
    await cleanup();
  }
});

test("roko-unreachable follows the overview both ways: once roko answers, a problem the backend's 30 s look still lists is gone", async () => {
  const lagging = {
    id: "roko-unreachable", severity: "block", title: "Hermes cannot reach roko serve at http://localhost:6677.",
    detail: "Nothing roko does works from Hermes until roko serve answers. Start it in your roko workspace.",
    fix: { kind: "command", label: "start roko serve", action: null, command: "roko serve --workdir /home/demo/code/tally", docs: "troubleshooting.md#roko-serve-is-not-reachable" },
  };
  const { container } = await setup({ edit: (fx) => { fx.overview.setup = { ok: false, problems: [lagging] }; } });
  try {
    assert.equal(container.querySelector('[data-roko="problem-roko-unreachable"]'), null, "roko answers: no stale problem");
    await click(button(container, "New run"));
    const dialog = container.querySelector('[data-roko="composer"]');
    await typeInto(dialog.querySelector("textarea"), "Add a test");
    assert.ok(!dialog.querySelector('[data-roko="composer-submit"]').disabled, "start is on with the live light");
  } finally {
    await cleanup();
  }
  // roko down, an older backend whose hint knows only a placeholder: no command to copy, so the hint stays.
  const placeholder = await setup({
    mode: "unreachable",
    edit: (fx) => { fx.overview.connection.error.hint = "start it with `roko serve --workdir WORKSPACE`, or point the plugin at it with `hermes roko setup --url URL`"; },
  });
  try {
    const row = placeholder.container.querySelector('[data-roko="problem-roko-unreachable"]');
    assert.ok(!/--workdir WORKSPACE/.test(text(row)), "no placeholder offered as the command");
    assert.match(text(row), /how: \S*troubleshooting\.md#roko-serve-is-not-reachable/);
    assert.match(placeholder.container.querySelector('[data-roko="status"] .rk-head-trouble').getAttribute("title"), /start it with `roko serve --workdir WORKSPACE`/);
  } finally {
    await cleanup();
  }
});

test("roko down and no card: the run is the overview's row, as last seen; two plans with one title show their ids' ends", async () => {
  const { container } = await setup({
    mode: "unreachable",
    url: runUrl(IDS.live),
    edit: (fx) => { fx.runs[IDS.live] = { ok: false, error: { code: "unreachable", message: "could not reach roko serve at http://localhost:6677", hint: "" } }; },
  });
  try {
    const hero = container.querySelector('[data-roko="hero"]');
    assert.ok(hero, "the row's run, not an error");
    assert.equal(text(hero.querySelector('[data-roko="card-pill"]')), "■ last seen running");
    assert.match(text(container.querySelector('[data-roko="stale"]')), /this is the run's last known state/);
    assert.equal(container.querySelector('[data-roko="away"]'), null, "the note says it once");
  } finally {
    await cleanup();
  }
  // The fixtures' two plans share a title (as two real ones did on 2026-10-15).
  const twins = ["project-tally-a-small-python-cli-expense-ledger", "project-tally-a-small-python-cli-expense-ledger-2"];
  const picker = await setup();
  try {
    await click(button(picker.container, "New run"));
    const dialog = picker.container.querySelector('[data-roko="composer"]');
    await click(dialog.querySelector('[data-roko="composer-plan"]'));
    const ids = [...dialog.querySelectorAll(".rk-planpick-id")];
    assert.deepEqual(ids.map(text), twins.map((id) => "…" + id.slice(-23)), "each id by its end");
    assert.deepEqual(ids.map((el) => el.getAttribute("title")), twins, "the whole id as the tooltip");
    assert.notEqual(text(ids[0]), text(ids[1]));
  } finally {
    await cleanup();
  }
});

test("an ended run has no live task: a cancelled run's stray running task is stopped, on its card and its row", async () => {
  const id = IDS.cancelled;
  const { container } = await setup({
    url: runUrl(id),
    edit: (fx) => {
      const card = fx.runs[id].run;
      // roko's last known state still calls T5 running (dogfood-desktop P4: a lit pad, "write_file … 0:55").
      Object.assign(card.tasks.find((t) => t.task_id === "T5"), { outcome: "running", step: "tool", step_detail: "write_file CHANGELOG.md", step_since: card.finished_at });
      card.progress = { ...card.progress, running: 1, stopped: 0 };
      fx.overview.runs.forEach((row) => { if (row.run_id === id) row.progress = { ...row.progress, running: 1, stopped: 0 }; });
    },
  });
  try {
    assert.equal(node(container, "T5").getAttribute("data-state"), "stopped");
    assert.ok(!/write_file/.test(text(node(container, "T5"))), "no step and no clock");
    const tasks = text(container.querySelector('[data-roko="hero"] [data-roko="card-tasks"]'));
    assert.match(tasks, /stopped/);
    assert.ok(!/running/.test(tasks), tasks);
    // Its line on Runs: the stray task is a stopped square, never a live one.
    await click(container.querySelector('[data-roko="crumb-runs"]'));
    const line = container.querySelector(`[data-roko="run-line"][data-run="${id}"]`);
    assert.equal(line.querySelector('.rk-rc-strip i[data-state="live"]'), null);
    assert.ok(line.querySelector('.rk-rc-strip i[data-state="stopped"]'));
  } finally {
    await cleanup();
  }
});

test("a fix's outcome shows once on Plans: at the top of the page, not again under Run plan…", async () => {
  const { container } = await setup({
    url: "http://localhost/roko?section=plans&plan=" + IDS.plan,
    edit: (fx) => { fx.overview.setup = { ok: false, problems: [PROBLEM_BOUNDARY] }; },
  });
  try {
    const row = container.querySelector('[data-roko="problem-workspace-refuses-chat-runs"]');
    await click(row.querySelector('[data-roko="fix-workspace-refuses-chat-runs"]'));
    await click(container.querySelector('[data-roko="fix-apply-workspace-refuses-chat-runs"]'));
    assert.ok(container.querySelector('[data-roko="run-plan"]'), "the plan's Run plan… form is on the page");
    assert.equal(container.querySelectorAll('[data-roko="fix-done-note"]').length, 1);
  } finally {
    await cleanup();
  }
});

test("an answered sign-off or held action leaves Needs you, the counts and its run at once, while roko still lists it", async () => {
  const { container, backend, registry } = await setup({ edit: (fx) => { fx.pending_lag = true; } });
  try {
    // What needs the person shows on the Runs tab, orange, from any tab (roko's design system §5.1).
    const badge = () => container.querySelector('[data-roko="wait-badge"]');
    assert.equal(text(badge()), "2");
    assert.equal(badge().closest('[role="tab"]').getAttribute("aria-label"), "Runs, 2 need you");
    const [confirm, effect] = ["confirm", "effect"].map((kind) => backend.fx.pending.items.find((i) => i.kind === kind));
    await click(button(container.querySelector(`[data-roko-pending="${confirm.code}"]`), "Approve " + confirm.code));
    // roko still lists it (here: every list the fake backend answers keeps it).
    assert.equal(container.querySelector(`[data-roko="needs-you"] [data-roko-pending="${confirm.code}"]`), null, "gone from Needs you");
    assert.equal(text(badge()), "1");
    const chip = await mount(registry.slots.find((s) => s.slot === "header-right").component, { url: "http://localhost/sessions" });
    assert.match(chip.container.querySelector("a").getAttribute("title"), /1 waiting/);
    await click(button(container.querySelector(`[data-roko-pending="${effect.code}"]`), "Approve " + effect.code));
    assert.equal(badge(), null, "nothing waits: no badge");
    assert.equal(container.querySelector('[data-roko="needs-you"]'), null);
    const card = container.querySelector(`[data-roko="run-card"][data-run="${IDS.confirm}"]`);
    assert.equal(text(card.querySelector('[data-roko="card-pill"]')), "running", "its run no longer waits on you");
  } finally {
    await cleanup();
  }
});

test("an answer roko may not have taken (it timed out) keeps the item: a sign-off that still waits is never hidden", async () => {
  const { container, backend } = await setup({
    edit: (fx) => { fx.decide_error = { code: "timeout", message: "roko did not answer in time", hint: "" }; },
  });
  try {
    const confirm = backend.fx.pending.items.find((i) => i.kind === "confirm");
    await click(button(container.querySelector(`[data-roko-pending="${confirm.code}"]`), "Approve " + confirm.code));
    assert.ok(container.querySelector(`[data-roko="needs-you"] [data-roko-pending="${confirm.code}"]`), "still listed");
    assert.equal(text(container.querySelector('[data-roko="wait-badge"]')), "2");
  } finally {
    await cleanup();
  }
});

test("P7: checks count each task's final attempt; a check a retry fixed reads \"1 retried\", its earlier verdict dim", async () => {
  const id = IDS.multiwave;
  const { container } = await setup({
    url: runUrl(id),
    edit: (fx) => {
      const card = fx.runs[id].run;
      card.gates = { passed: 13, failed: 0, total: 13, retried: 1 };
      // T1's test failed once and passed on the retry: the first verdict is an earlier attempt's.
      card.tasks.find((t) => t.task_id === "T1").gates.unshift({ gate: "verify[0:test]", passed: false, superseded: true, excerpt: "$ python3 -m unittest … FAILED (failures=1)", runs: 1 });
    },
  });
  try {
    const cell = container.querySelector('[data-roko="hero"] [data-roko="card-checks"]');
    assert.equal(text(cell.querySelector(".rk-dots .rk-sr")), "13 of 13 checks passed, 1 retried");
    assert.equal(cell.querySelector(".rk-dots").getAttribute("data-ch"), "pass", "no red: nothing failed in the end");
    assert.equal(text(cell.querySelector(".rk-rc-note")), "passed · 1 retried");
    await click(node(container, "T1"));
    const earlier = container.querySelector('[data-roko-inspector="T1"] .roko-checkrow.is-superseded');
    assert.ok(earlier, "the earlier attempt's verdict is listed, dim");
    assert.match(text(earlier), /verify\[0:test\] an earlier try/);
  } finally {
    await cleanup();
  }
});

test("§4.8: TIME rounds down to whole seconds; a check that never ran reads off once the run ended, live while it runs", async () => {
  // Phase 7.2's end: roko counted 22:13.9, and Hermes said "22m 14s" beside the glass's 22:13.
  const ended = await setup({
    url: runUrl(IDS.multiwave),
    edit: (fx) => {
      const card = fx.runs[IDS.multiwave].run;
      card.duration_ms = 1_333_900;
      card.gates = { passed: 4, failed: 0, total: 11, retried: 0 };
    },
  });
  try {
    const hero = ended.container.querySelector('[data-roko="hero"]');
    assert.equal(text(hero.querySelector('[data-roko="card-time"] .rk-dots .rk-sr')), "22m 13s");
    const checks = hero.querySelector('[data-roko="card-checks"] .rk-dots');
    assert.equal(text(checks.querySelector(".rk-sr")), "4 of 11 checks passed");
    assert.equal(checks.getAttribute("data-ch"), "off", "an ended run's unrun checks are not live");
  } finally {
    await cleanup();
  }
  const running = await setup({
    url: runUrl(IDS.live),
    edit: (fx) => {
      fx.runs[IDS.live].run.gates = { passed: 2, failed: 0, total: 11, retried: 0 };
    },
  });
  try {
    const checks = running.container.querySelector('[data-roko="hero"] [data-roko="card-checks"] .rk-dots');
    assert.equal(text(checks.querySelector(".rk-sr")), "2 of 11 checks passed");
    assert.equal(checks.getAttribute("data-ch"), "live");
  } finally {
    await cleanup();
  }
});

const VALIDATION = {
  valid: false,
  errors: [{ rule: "PLAN_045", task_id: "T2", message: "task 'T2' has open questions" }],
  open_questions: [{ task_id: "T2", question: "Should render_summary flag a category exactly at its limit?", assumption: "only above the limit" }],
  summary: "PLAN_045: task 'T2' has open questions, so its plan cannot run; answer them in tasks.toml",
};

test("P1: a plan roko won't run yet says why on the plan, its task and Run plan…; a refused start shows the same", async () => {
  const one = await setup({
    url: "http://localhost/roko?section=plans&plan=" + IDS.plan,
    edit: (fx) => {
      const plan = fx.plan_details[IDS.plan].plan;
      plan.validation = VALIDATION;
      plan.tasks.find((t) => t.id === "T2").open_questions = VALIDATION.open_questions;
    },
  });
  try {
    // On the plan sheet the question is a card (spec v3 §5.5): the question, the planner's suggestion, what happens.
    const note = one.container.querySelector('[data-roko="plan"] [data-roko="plan-validation"]');
    assert.equal(
      text(note),
      "roko won't run this plan yet open question Task 2 Should render_summary flag a category exactly at its limit? suggested only above the limit " +
        "unanswered, roko won't run the plan Answer each in the plan's tasks.toml, then delete it from open_questions. roko plan validate plans/" + IDS.plan + " says what is left."
    );
    assert.equal(note.querySelectorAll('[data-roko="question-card"]').length, 1);
    assert.equal(note.querySelector('[data-roko="validation-items"]'), null, "PLAN_045 is said by its question");
    assert.equal(text(one.container.querySelector('[data-roko="plan"] [data-roko="card-pill"]')), "cannot run yet", "the head says so too");
    assert.equal(one.container.querySelector('[data-roko="planhead-run"]'), null, "no run plan key in the head");
    const run = one.container.querySelector('[data-roko="run-plan"]');
    assert.ok(run.disabled);
    assert.equal(run.getAttribute("title"), "roko won't run this plan yet: see why above");
    const task = one.container.querySelector('[data-roko-plantask="T2"]');
    assert.equal(text(task.querySelector('[data-roko="open-question"]')), "open question");
    assert.match(text(task), /Should render_summary flag a category exactly at its limit\? · suggested: only above the limit/);
  } finally {
    await cleanup();
  }
  // roko refused the start (the plan changed since it was read): the note, not a red line; the plan is read again,
  // so its own note says it and Run plan… goes off (the desktop's way).
  const two = await setup({
    url: "http://localhost/roko?section=plans&plan=" + IDS.plan,
    edit: (fx) => {
      fx.plan_started = {
        ok: false,
        error: { code: "refused", message: "roko will not run plan " + IDS.plan + ": PLAN_045: task 'T2' has open questions", hint: "answer the plan's open questions in its tasks.toml, then run it again" },
        validation: VALIDATION,
      };
      fx.on_plan_run = (b) => { b.plan_details[IDS.plan].plan.validation = VALIDATION; };
    },
  });
  try {
    const form = two.container.querySelector(".roko-runform");
    await submit(form);
    await click(two.container.querySelector('[role="alertdialog"] [data-confirm="yes"]'));
    assert.equal(two.container.querySelector('[role="alertdialog"]'), null, "the confirm closed");
    assert.ok(!/roko will not run plan/.test(text(two.container)), "no red line: the note says it");
    assert.equal(two.container.querySelectorAll('[data-roko="plan-validation"]').length, 1, "one note, the plan's own");
    assert.ok(two.container.querySelector('[data-roko="run-plan"]').disabled);
    assert.ok(two.backend.calls.filter((c) => c.url.endsWith("/plans/" + IDS.plan)).length >= 2, "the plan was read again");
  } finally {
    await cleanup();
  }
});

test("P1: roko's other findings come first, in its words; a queued run that failed the check lists them in its Why", async () => {
  const found = {
    ...VALIDATION,
    errors: [{ rule: "PLAN_012", task_id: "T3", message: "task 'T3' depends on 'T9', which the plan does not have" }, ...VALIDATION.errors],
  };
  const plan = await setup({ url: "http://localhost/roko?section=plans&plan=" + IDS.plan, edit: (fx) => { fx.plan_details[IDS.plan].plan.validation = found; } });
  try {
    const note = plan.container.querySelector('[data-roko="plan-validation"]');
    const items = [...note.querySelectorAll('[data-roko="validation-items"] li')].map(text);
    assert.deepEqual(items, ["Task 3 task 'T3' depends on 'T9', which the plan does not have · PLAN_012"], "PLAN_045 is said by its questions");
    assert.equal(
      text(note.querySelector('[data-roko="question-card"]')),
      "open question Task 2 Should render_summary flag a category exactly at its limit? suggested only above the limit unanswered, roko won't run the plan"
    );
  } finally {
    await cleanup();
  }
  const id = IDS.failed;
  const queued = await setup({
    url: runUrl(id),
    edit: (fx) => {
      Object.assign(fx.runs[id].run, {
        plan_id: IDS.plan,
        why: {
          summary: "roko did not start this plan: its plans failed validation with 1 error(s) while it was queued. roko's check of the plan says: " + VALIDATION.summary + ". Open questions: (1) Should render_summary flag a category exactly at its limit? (suggested: only above the limit).",
          validation: VALIDATION,
          gates_not_passed: [],
        },
      });
    },
  });
  try {
    const why = queued.container.querySelector('[data-roko="why"]');
    assert.match(text(why), /roko did not start this plan: its plans failed validation with 1 error\(s\) while it was queued\. T2 Should/);
    assert.ok(!/check of the plan says/.test(text(why)), "the list, not the run-on sentence");
    assert.match(text(why), /roko plan validate plans\/project-tally-a-small-python-cli-expense-ledger-2 says what is left\./);
  } finally {
    await cleanup();
  }
});

test("P1: a written plan roko won't run yet reads \"cannot run yet\", says what to answer, and offers no run", async () => {
  const gen = "22222222-3333-4444-8555-777777777777";
  const { container } = await setup({
    url: runUrl(gen),
    edit: (fx) => {
      fx.overview.runs.unshift({ run_id: gen, kind: "plan_generate", label: "Split the ledger", plan_id: IDS.plan, state: "succeeded", active: false, cost_usd: null, max_usd: null, started_at: new Date().toISOString() });
      fx.runs[gen] = {
        ok: true,
        run: {
          run_id: gen, kind: "plan_generate", label: "Split the ledger", plan_id: IDS.plan, state: "succeeded", verdict: "succeeded", active: false, task_count: 5, tasks: [], gates: {}, milestones: [], waiting: [],
          validation: VALIDATION,
          why: { summary: "roko wrote the plan, but it cannot run yet: " + VALIDATION.summary + ".", validation: VALIDATION },
          next: { action: null, label: "answer the plan's open questions", why: VALIDATION.summary },
          headline: "plan written · cannot run yet",
        },
      };
    },
  });
  try {
    const hero = container.querySelector('[data-roko="hero"]');
    assert.equal(text(hero.querySelector('[data-roko="card-pill"]')), "cannot run yet");
    assert.equal(hero.getAttribute("data-state"), "you", "the person's turn");
    const next = container.querySelector(".rk-next-words");
    assert.equal(text(next), "answer the plan's open questions");
    const planning = container.querySelector('[data-roko="planning"]');
    assert.match(text(planning), /^roko wrote the plan, but it cannot run yet: /);
    assert.ok(planning.querySelector('[data-roko="plan-validation"]'));
  } finally {
    await cleanup();
  }
});

test("real cards: a run roko stopped at its cap reads as a stop, not a failure; its tasks are stopped", async () => {
  const card = realCard("budget_stop");
  const id = card.run_id;
  const { container } = await setup({ url: runUrl(id), edit: (fx) => withReal(fx, card) });
  try {
    const hero = container.querySelector('[data-roko="hero"]');
    assert.equal(text(hero.querySelector('[data-roko="card-pill"]')), "■ stopped at cap");
    assert.equal(hero.getAttribute("data-state"), "stop", "the stop colour, not red");
    assert.equal(text(hero.querySelector('[data-roko="card-status"]')), "roko stopped the run at its cap of $0.05 ($0.03 spent).");
    assert.match(text(hero.querySelector('[data-roko="card-tasks"]')), /2 stopped/);
    assert.ok(!/did not pass|failed/.test(text(hero.querySelector('[data-roko="card-tasks"]'))));
    for (const t of ["T1", "T2"]) assert.equal(node(container, t).getAttribute("data-state"), "stopped");
    const why = container.querySelector('[data-roko="why"]');
    assert.match(text(why), /^Why it stopped The run stopped: it reached its cap of \$0\.05/);
    assert.equal(text(container.querySelector('[data-roko="rerun"]')), "raise the cap and run it again");
    const row = await onRuns(container, id);
    assert.match(text(row), /failed/, "an overview row without budget_stop reads as before");
  } finally {
    await cleanup();
  }
  // A row that carries budget_stop (a newer backend) says the same in the list.
  const listed = realCard("budget_stop");
  const two = await setup({
    url: runUrl(listed.run_id),
    edit: (fx) => {
      withReal(fx, listed);
      fx.overview.runs[0].budget_stop = { cap_usd: 0.05, spent_usd: 0.032 };
    },
  });
  try {
    const row = await onRuns(two.container, listed.run_id);
    assert.match(text(row), /stopped at cap/);
    assert.equal(row.getAttribute("data-state"), "stop");
  } finally {
    await cleanup();
  }
});

test("real cards: a delivery a cancel stopped says so in the changes, in the timeline's words", async () => {
  const card = realCard("delivery_cancelled");
  const { container } = await setup({ url: runUrl(card.run_id), edit: (fx) => withReal(fx, card) });
  try {
    await openFold(container, "changes");
    const lines = [...container.querySelectorAll('[data-roko="deliveries"] li')].map(text);
    assert.deepEqual(lines, ["plan slow-check: its delivery was stopped by a cancel request"]);
    assert.equal(container.querySelector('[data-roko="deliveries"] li .rk-led').getAttribute("data-ch"), "off", "a stop, not a failure");
  } finally {
    await cleanup();
  }
  // A plain delivery says nothing extra: the branch line says it.
  const plain = await setup({ url: runUrl(IDS.multiwave), edit: (fx) => { fx.runs[IDS.multiwave].run.deliveries = [{ plan_id: "p-1", partial: false, state: "delivered", target: "roko/batch/x", reason: null, stopped: null }]; } });
  try {
    await openFold(plain.container, "changes");
    assert.equal(plain.container.querySelector('[data-roko="deliveries"]'), null);
  } finally {
    await cleanup();
  }
});

test("two outcomes the table lacked: passed with failures from before reads passed; condition-skipped reads skipped", async () => {
  const id = IDS.multiwave;
  const { container } = await setup({
    url: runUrl(id),
    edit: (fx) => {
      const card = fx.runs[id].run;
      Object.assign(card.tasks.find((t) => t.task_id === "T1"), { outcome: "passed_with_preexisting_failures", reason: null });
      Object.assign(card.tasks.find((t) => t.task_id === "T5"), { outcome: "condition-skipped", reason: null });
    },
  });
  try {
    // hermes-update's words, from roko's own definitions: the same on both pages.
    const t1 = node(container, "T1");
    assert.equal(t1.getAttribute("data-state"), "passed");
    assert.match(t1.getAttribute("aria-label"), /^Task 1, passed \(failures were there before\): /);
    assert.match(text(t1), /failures were there before/);
    await click(t1);
    let inspector = container.querySelector('[data-roko-inspector="T1"]');
    assert.equal(text(inspector.querySelector(".rk-state")), "passed");
    assert.equal(
      text(inspector.querySelector(".roko-inspector-reason")),
      "Passed. The tests that failed also failed on the commit this run started from, so this task did not cause them."
    );
    const t5 = node(container, "T5");
    assert.equal(t5.getAttribute("data-state"), "stopped", "drawn as a skip, not a failure");
    assert.match(t5.getAttribute("aria-label"), /^Task 5, skipped \(the plan's conditions did not call for it\): /);
    assert.ok(t5.querySelector("svg circle"), "render.py's ⊘, not the stop square");
    await click(t5);
    inspector = container.querySelector('[data-roko-inspector="T5"]');
    assert.equal(text(inspector.querySelector(".rk-state")), "skipped");
    assert.equal(text(inspector.querySelector(".roko-inspector-reason")), "Skipped: the plan's conditions did not call for this task.");
  } finally {
    await cleanup();
  }
});

test("a plan writing shows what roko's planner is doing (gap-11d870), with a guarded clock; a failed one how far it got", async () => {
  const gen = "33333333-4444-4555-8666-777777777777";
  const card = (over) => ({
    run_id: gen, kind: "plan_generate", label: "Split the ledger", plan_id: null, state: "running", active: true, task_count: null,
    tasks: [], gates: {}, milestones: [], waiting: [], checked_at: new Date().toISOString(), hermes_started_at: new Date(Date.now() - 15000).toISOString(),
    ...over,
  });
  const retrying = {
    stage: "retrying", attempt: 2, attempts: 2, calls: 3, cost_usd: 0, model: "glm-5.1",
    reason: "the planner call ran into roko's 300 s limit for one call and was stopped", elapsed_s: 3,
    text: "retrying: the planner call ran into roko's 300 s limit for one call and was stopped · try 2 of 2 · 0:03 · $0.00",
  };
  const row = { run_id: gen, kind: "plan_generate", label: "Split the ledger", plan_id: null, state: "running", active: true, cost_usd: null, max_usd: null, started_at: new Date().toISOString() };
  const one = await setup({ url: runUrl(gen), edit: (fx) => { fx.overview.runs.unshift({ ...row }); fx.runs[gen] = { ok: true, run: card({ writing: retrying }) }; } });
  try {
    const planning = one.container.querySelector('[data-roko="planning"]');
    assert.equal(text(planning.querySelector('[data-roko="writing-line"]')), "retrying: the planner call ran into roko's 300 s limit for one call and was stopped · try 2 of 2");
    assert.match(text(planning.querySelector(".roko-planning-title")), / · 0:0\d · \$0\.00 · glm-5\.1$/, "hermes-update's line: clock, spend, model");
  } finally {
    await cleanup();
  }
  // An elapsed_s out of range is not believed: the line has no clock (as the desktop's).
  const two = await setup({ url: runUrl(gen), edit: (fx) => { fx.overview.runs.unshift({ ...row }); fx.runs[gen] = { ok: true, run: card({ writing: { ...retrying, stage: "planning", reason: null, attempt: 1, attempts: 1, elapsed_s: 1e9 } }) }; } });
  try {
    const title = text(two.container.querySelector('[data-roko="planning"] .roko-planning-title'));
    assert.equal(title, "writing the plan: planning · try 1 of 1 · $0.00 · glm-5.1");
  } finally {
    await cleanup();
  }
  // roko keeps the last stage after the end: a failed writing says how far it got.
  const three = await setup({
    url: runUrl(gen),
    edit: (fx) => {
      fx.overview.runs.unshift({ ...row, state: "failed", active: false });
      fx.runs[gen] = { ok: true, run: card({ state: "failed", active: false, planner_error: "plan generation failed: the planner call timed out twice", writing: { ...retrying, elapsed_s: null } }) };
    },
  });
  try {
    assert.equal(
      text(three.container.querySelector('[data-roko="writing-last"]')),
      "how far it got: retrying: the planner call ran into roko's 300 s limit for one call and was stopped · try 2 of 2 · 0:03 · $0.00"
    );
  } finally {
    await cleanup();
  }
});

test("a stop at roko's daily limit reads \"stopped at limit\"; a skipped task counts as ended, in grey", async () => {
  const card = realCard("budget_stop");
  card.budget_stop = { ...card.budget_stop, limit: "day", cap_usd: 5, spent_usd: 5.0012 };
  card.next = { action: null, label: "raise the daily limit or run it tomorrow", why: "roko's daily limit of $5.00 was reached" };
  const id = card.run_id;
  const one = await setup({
    url: runUrl(id),
    edit: (fx) => {
      withReal(fx, card);
      fx.overview.runs[0].budget_stop = { limit: "day", cap_usd: 5, spent_usd: 5.0012 };
    },
  });
  try {
    const hero = one.container.querySelector('[data-roko="hero"]');
    assert.equal(text(hero.querySelector('[data-roko="card-pill"]')), "■ stopped at limit");
    assert.equal(text(hero.querySelector('[data-roko="card-status"]')), "roko stopped the run at today's limit of $5.00 ($5.00 spent).");
    assert.equal(hero.getAttribute("data-state"), "stop");
    assert.equal(text(one.container.querySelector(".rk-next-words")), "raise the daily limit or run it tomorrow", "nothing to press");
    assert.equal(one.container.querySelector('[data-roko="rerun"]'), null);
    assert.match(text(await onRuns(one.container, id)), /stopped at limit/);
  } finally {
    await cleanup();
  }
  // progress.skipped (0.5.0): tasks no route of the plan chose; ended, in grey, said.
  const two = await setup({
    url: runUrl(IDS.multiwave),
    edit: (fx) => {
      const skipped = { total: 5, passed: 4, failed: 0, running: 0, pending: 0, blocked: 0, stopped: 0, unverified: 0, skipped: 1 };
      fx.runs[IDS.multiwave].run.progress = skipped;
      fx.overview.runs.forEach((row) => { if (row.run_id === IDS.multiwave) row.progress = { ...skipped }; });
    },
  });
  try {
    assert.equal(text(two.container.querySelector('[data-roko="hero"] [data-roko="card-tasks"] .rk-rc-note')), "1 skipped");
    const line = await onRuns(two.container, IDS.multiwave);
    const cells = [...line.querySelectorAll(".rk-rc-strip i")].map((c) => c.getAttribute("data-state"));
    assert.deepEqual(cells, ["pass", "pass", "pass", "pass", "skipped"], "the run's progress is full: no waiting square");
  } finally {
    await cleanup();
  }
});

test("R2-3: \"raise the cap and run it again\" opens the composer at the higher cap roko's backend suggests, snapped to a detent", async () => {
  const runKey = async (next) => {
    const card = realCard("budget_stop");
    card.next = next;
    const env = await setup({
      url: runUrl(card.run_id),
      edit: (fx) => {
        withReal(fx, card);
        // The plan the run ran, as roko lists it.
        fx.plans.plans.push({ id: "cap-stop", title: "Cap stop", task_count: 2, tasks_done: 0, tasks_not_passed: 0, status: "ready", group: null });
        fx.plan_details["cap-stop"] = {
          ok: true,
          plan: {
            plan_id: "cap-stop", title: "Cap stop", task_count: 2, max_parallel: 1, waves: [["T2"], ["T1"]], estimate: null,
            tasks: [{ id: "T2", title: "First", depends_on: [], checks: [] }, { id: "T1", title: "Second", depends_on: ["T2"], checks: [] }],
          },
        };
      },
    });
    try {
      await click(env.container.querySelector('[data-roko="rerun"]'));
      const dialog = env.container.querySelector('[data-roko="composer"]');
      assert.ok(dialog.querySelector('input[type="checkbox"]').checked, "skip tasks that already passed");
      assert.equal(posts(env.backend, "/run").length, 0, "nothing starts by itself");
      return text(dialog.querySelector('[data-roko="composer-submit"]'));
    } finally {
      await cleanup();
    }
  };
  const base = { action: "rerun", label: "raise the cap and run it again", why: "it reached its cap of $0.05 ($0.032 spent)" };
  // $0.08 suggested: the next detent up, $0.25 (the fixtures allow $5.00 a run).
  assert.equal(await runKey({ ...base, max_usd: 0.08 }), "run plan · cap $0.25 ⌘↵");
  // Above the detents within the ceiling would be the figure itself; over the ceiling, the ceiling.
  assert.equal(await runKey({ ...base, max_usd: 9 }), "run plan · cap $5.00 ⌘↵");
  // An older backend suggests nothing: the run's own cap, as before.
  assert.equal(await runKey(base), "run plan · cap $0.05 ⌘↵");
});

// --------------------------------------------------------------------------------
// v3 (W2): the Ladder, the instrument, the horizon and the stream (spec v3 §4.2–4.5)
// --------------------------------------------------------------------------------

// The v5 dogfood workspace's model ladder, as plugin-runs reads it: its top rung is a CLI agent, not for chat runs.
const LADDER = [
  { rung: "cheap", model: "gpt-oss-120b", slug: "gpt-oss-120b", provider: "cerebras", price_in: 0.35, price_out: 0.75, price_cache_read: 0.35, chat_ok: true, why_not: null, starts: ["mechanical", "focused"] },
  { rung: "mid", model: "glm-4-7", slug: "glm-4.7", provider: "zai", price_in: 0.6, price_out: 2.2, price_cache_read: 0.11, chat_ok: true, why_not: null, starts: ["integrative"] },
  { rung: "strong", model: "gpt-5.4-mini", slug: "gpt-5.4-mini", provider: "openai", price_in: 0.75, price_out: 4.5, price_cache_read: 0.075, chat_ok: true, why_not: null, starts: [] },
  { rung: "top", model: "claude-sonnet-4-6", slug: "claude-sonnet-4-6", provider: "claude_cli", price_in: null, price_out: null, price_cache_read: null, chat_ok: false, why_not: "not for chat runs: its agent runs its own tools", starts: ["architectural"] },
];

/** One try at a task, as `tasks[].climb` gives it (docs/ui-api.md `Try`). */
function tryOn(attempt, rung, model, reason, outcome, extra = {}) {
  const running = outcome === "running";
  return {
    attempt, rung, model, provider: rung === "mid" ? "zai" : "cerebras", reason, outcome, failed_check: null, key_line: null,
    cost_usd: running ? null : 0.0014, duration_ms: running ? null : 31000, started_at: new Date(Date.now() - (running ? 14000 : 120000)).toISOString(),
    lesson_ids: null, failover: null, blame: outcome === "failed" ? "agent" : outcome === "passed" ? "none" : null, source: "roko", ...extra,
  };
}

/** The live run with a climb: T2's check failed twice on cheap, so roko climbed it to mid, where its third try runs. */
function climbEdit(fx) {
  const now = Date.now();
  const card = fx.runs[IDS.live].run;
  const task = (id) => card.tasks.find((t) => t.task_id === id);
  card.ladder = LADDER;
  task("T1").climb = [tryOn(1, "cheap", "gpt-oss-120b", "start", "passed")];
  task("T1").lives = { rung: "cheap", used: 1, of: 2 };
  task("T4").climb = [tryOn(1, "cheap", "gpt-oss-120b", "start", "passed")];
  task("T4").lives = { rung: "cheap", used: 1, of: 2 };
  const failed = { failed_check: "verify[0:test]", key_line: "AssertionError: 'food  50.00' != 'food  $50.00'" };
  task("T2").climb = [
    tryOn(1, "cheap", "gpt-oss-120b", "start", "failed", failed),
    tryOn(2, "cheap", "gpt-oss-120b", "retry", "failed", failed),
    tryOn(3, "mid", "glm-4.7", "climb", "running", { lesson_ids: ["k-cents", "k-parser", "k-cents"] }),
  ];
  task("T2").lives = { rung: "mid", used: 1, of: 2 };
  task("T3").climb = [];
  task("T5").climb = [];
  fx.overview.runs.find((r) => r.run_id === IDS.live).rungs = [
    { rung: "cheap", passed: 2, running: 0, failed: 2, waiting: 2 },
    { rung: "mid", passed: 0, running: 1, failed: 0, waiting: 0 },
    { rung: "strong", passed: 0, running: 0, failed: 0, waiting: 0 },
    { rung: "top", passed: 0, running: 0, failed: 0, waiting: 0 },
  ];
  // The timeline: T2's two failed checks on cheap, then the climb.
  const answer = fx.events[IDS.live];
  const top = Math.max(...answer.events.map((e) => e.cursor));
  answer.events.push(
    { cursor: top + 1, type: "gate_result", group: "gate", task_id: "T2", ts_millis: now - 90000, passed: false, gate: "verify[0:test]", text: "T2 gate verify[0:test] did not pass" },
    { cursor: top + 2, type: "route_decided", group: "loop", task_id: "T2", ts_millis: now - 85000, model: "gpt-oss-120b", attempt: 2, loop: "route", text: "T2 attempt 2 → gpt-oss-120b" },
    { cursor: top + 3, type: "gate_result", group: "gate", task_id: "T2", ts_millis: now - 60000, passed: false, gate: "verify[0:test]", text: "T2 gate verify[0:test] did not pass" },
    { cursor: top + 4, type: "route_decided", group: "loop", task_id: "T2", ts_millis: now - 55000, model: "glm-4.7", attempt: 3, loop: "route", text: "T2 attempt 3 → glm-4.7" }
  );
  answer.next_cursor = top + 5;
}

test("v3 Ladder: rungs top first, each task's token where its latest try ran, the climb's ghost and trail, a rung chats cannot use dashed", async () => {
  const { container } = await setup({ url: runUrl(IDS.live), edit: climbEdit });
  try {
    const display = container.querySelector('[data-roko="run-models"]');
    assert.match(text(display.querySelector(".rk-panel-h")), /^Models cheapest first; a stronger one only after failed checks$/);
    const rungs = [...display.querySelectorAll('[data-roko="ladder"] [role="listitem"]')];
    assert.deepEqual(rungs.map((r) => r.getAttribute("data-rung")), ["top", "strong", "mid", "cheap"]);
    const at = Object.fromEntries(rungs.map((r) => [r.getAttribute("data-rung"), r]));
    // The top rung is a CLI agent: dashed, and it says why (spec v3 §11, decision 4).
    assert.equal(at.top.getAttribute("data-off"), "true");
    assert.match(text(at.top), /not for chat runs: its agent runs its own tools/);
    assert.equal(at.top.getAttribute("aria-label"), "top rung, claude-sonnet-4-6, not for runs from a chat");
    // Its price per million tokens, and the model as its provider calls it (the slug, not roko.toml's key).
    assert.match(text(at.mid), /^mid \$0\.60·\$2\.20 glm-4\.7/);
    // T2 runs on mid after climbing: rose, with where it came from, a trail down to cheap.
    assert.equal(at.mid.querySelector('[data-roko-token="T2"]').getAttribute("data-state"), "running");
    assert.equal(at.mid.getAttribute("data-live"), "true");
    assert.equal(text(at.mid.querySelector(".rk-climbnote")), "▲ 2✕ on cheap");
    assert.ok(at.mid.querySelector(".rk-trail"), "a dashed trail down to the rung it climbed from");
    assert.match(at.mid.getAttribute("aria-label"), /^mid rung, glm-4\.7: T2 running, climbed here$/);
    // On cheap: T1 and T4 passed, T3 and T5 wait to start, and T2's two failed tries stay there as a ghost.
    const cheap = [...at.cheap.querySelectorAll(".rk-tok")].map((t) => (t.getAttribute("data-roko-token") || "ghost") + ":" + t.getAttribute("data-state")).sort();
    assert.deepEqual(cheap, ["T1:passed", "T3:waiting", "T4:passed", "T5:waiting", "ghost:ghost"]);
    assert.equal(text(at.cheap.querySelector('.rk-tok[data-state="ghost"]')), "✕✕");
    assert.equal(text(at.cheap.querySelector(".rk-rcount")), "2✓");
    assert.match(at.cheap.getAttribute("aria-label"), /T2 failed 2 times here and climbed$/);
  } finally {
    await cleanup();
  }
});

test("v3 pads: a task's rung, its tries and the lessons in its prompt", async () => {
  const { container } = await setup({ url: runUrl(IDS.live), edit: climbEdit });
  try {
    const t2 = node(container, "T2");
    assert.equal(text(t2.querySelector(".rk-rchip")), "mid ▲");
    assert.equal(t2.querySelector(".rk-rchip").getAttribute("data-climbed"), "true");
    assert.equal(t2.querySelector(".rk-rchip").getAttribute("title"), "It climbed to the mid rung after its tries failed below");
    assert.deepEqual([...t2.querySelectorAll(".rk-lives i")].map((i) => i.getAttribute("data-life")), ["x", "x", "r"]);
    assert.equal(t2.querySelector(".rk-lives").getAttribute("aria-label"), "3 tries: 2 failed");
    assert.equal(text(t2.querySelector(".rk-pad-lessons")), "◇2", "two different lessons in its prompt");
    const t1 = node(container, "T1");
    assert.equal(text(t1.querySelector(".rk-rchip")), "cheap");
    assert.equal(t1.querySelector(".rk-lives"), null, "a first-try pass shows its checks, not its tries");
  } finally {
    await cleanup();
  }
});

test("P-37: with two tasks at work the words show the stretch that grew last, held 2 s so they do not flicker", async () => {
  const edit = (fx) => {
    climbEdit(fx);
    const t3 = fx.runs[IDS.live].run.tasks.find((t) => t.task_id === "T3");
    t3.outcome = "running";
    t3.climb = [tryOn(1, "cheap", "gpt-oss-120b", "start", "running")];
  };
  const env = await liveSetup({ url: runUrl(IDS.live), edit });
  const { container } = env;
  try {
    const socket = FakeSocket.all[0];
    await push(socket, { type: "hello", version: VERSION, overview: env.backend.fx.overview, hub: "open" });
    const now = Date.now();
    const frame = (task, attempt, kind, ago, said = "") => ({ type: "live", run_id: IDS.live, task_id: task, attempt, kind, text: "", said, tool: kind === "tool" ? "Read" : undefined, ts: now - ago });
    const shown = () => text(container.querySelector('[data-roko="stream-words"]'));
    await push(socket, frame("T3", 1, "reasoning", 12000, "T3 starts on the CLI"));
    await push(socket, frame("T2", 3, "reasoning", 9000, "T2 reads the summary"));
    assert.match(shown(), /T2 reads the summary/);
    // T2 calls a tool; T3 thinks on, its words growing in the entry it began 12 s ago.
    await push(socket, frame("T2", 3, "tool", 8000));
    await push(socket, frame("T3", 1, "reasoning", 5000, "T3 starts on the CLI, then the flags"));
    assert.match(shown(), /Task 3 thinks T3 starts on the CLI, then the flags/);
    // T2 speaks again half a second later: T3, still growing, holds the strip.
    await push(socket, frame("T2", 3, "reasoning", 4500, "T2 again"));
    assert.match(shown(), /T3 starts on the CLI, then the flags/);
    // T3 has said nothing for 3 s while T2 goes on: the strip follows T2.
    await push(socket, frame("T2", 3, "reasoning", 2000, "T2 again, about budgets"));
    assert.match(shown(), /T2 again, about budgets/);
  } finally {
    await cleanup();
    env.restore();
  }
});

test("v3 stream: tool calls, a failed check with the line that says why, the climb and its lessons; check output and words live", async () => {
  const env = await liveSetup({ url: runUrl(IDS.live), edit: climbEdit });
  const { container } = env;
  try {
    const stream = container.querySelector('[data-roko="stream"]');
    assert.ok(stream.classList.contains("rk-glass"), "the stream is glass");
    assert.equal(stream.querySelector('[role="log"]').getAttribute("aria-live"), "off", "its status speaks for it (spec v3 §8)");
    const rows = () => [...stream.querySelectorAll(".rk-ln")].map((l) => text(l)).join(" | ");
    assert.match(rows(), /02 ✕ verify\[0:test\] did not pass \| AssertionError: 'food 50\.00' != 'food \$50\.00'/);
    assert.match(rows(), /02 ▲ up to mid · glm-4\.7 · 2 failed checks on cheap \| \S+ 02 ◇ 2 lessons in its prompt/);
    assert.match(rows(), /04 Write tests\/test_budgets\.py/, "a tool call, with what it works on");
    assert.ok(stream.querySelector('.rk-ln[data-kind="route"][data-tone="live"]'), "the climb is rose");
    assert.ok(stream.querySelector('.rk-ln[data-kind="lesson"][data-tone="learn"]'), "a lesson is indigo");
    // Older rows dim by their place from the newest; a failed check holds its brightness longer.
    const lines = [...stream.querySelectorAll(".rk-ln:not(.rk-ln-sub)")];
    assert.equal(lines[lines.length - 1].style.opacity, "1");
    assert.ok(Number(lines[0].style.opacity) < 1);
    // A running check's lines arrive as one block, its newest line highlighted (plugin-runs P4).
    const socket = FakeSocket.all[0];
    await push(socket, { type: "hello", version: VERSION, overview: env.backend.fx.overview, hub: "open" });
    await push(socket, { type: "live", run_id: IDS.live, task_id: "T2", attempt: null, kind: "check", gate: "verify[0:test]", line: "test_summary ... ok", tail: ["test_budget ... ok", "test_summary ... ok"], ts: Date.now() });
    const block = stream.querySelector('[data-roko="stream-check"]');
    assert.equal(text(block.querySelector(".rk-ln-new")), "test_summary ... ok");
    assert.match(text(block), /^test_budget \.\.\. ok test_summary \.\.\. ok$/);
    assert.match(rows(), /02 checking verify\[0:test\]/);
    // Words: the newest stretch sits at the bottom, with who says it and a cursor.
    await push(socket, { type: "live", run_id: IDS.live, task_id: "T2", attempt: 3, kind: "text", text: " cents.", said: "Budgets are kept in integer cents.", ts: Date.now() });
    const words = stream.querySelector('[data-roko="stream-words"]');
    assert.equal(text(words), "Task 2 says Budgets are kept in integer cents.");
    assert.ok(words.querySelector(".rk-cursor"));
    // The running task's key filters the stream to it, and ALL brings every task back.
    await click(button(stream, "02"));
    assert.ok([...stream.querySelectorAll(".rk-ln:not(.rk-ln-sub) .rk-ln-k")].every((k) => text(k) === "02"));
    await click(button(stream, "ALL"));
    assert.match(rows(), /04 /);
  } finally {
    await cleanup();
    env.restore();
  }
});

test("Q4: a climb row says what ended the tries on the rung it climbed from; failed checks only when every one failed its check", async () => {
  const edit = (fx) => {
    climbEdit(fx);
    const card = fx.runs[IDS.live].run;
    const task = (id) => card.tasks.find((t) => t.task_id === id);
    const check = { verdict: "gate_failed", failed_check: "verify[0:test]", why: "its check verify[0:test] failed" };
    // T2: a failed check and a turn cap on cheap, then a timeout and a failed check on mid; it runs on strong now.
    task("T2").climb = [
      tryOn(1, "cheap", "gpt-oss-120b", "start", "failed", check),
      tryOn(2, "cheap", "gpt-oss-120b", "retry", "failed", { verdict: "turn_cap", why: "it hit its turn cap (15 turns)" }),
      tryOn(3, "mid", "glm-4.7", "climb", "failed", { verdict: "timeout", why: "it ran out of time (90 s)" }),
      tryOn(4, "mid", "glm-4.7", "retry", "failed", check),
      tryOn(5, "strong", "gpt-5.4-mini", "climb", "running"),
    ];
    task("T2").lives = { rung: "strong", used: 1, of: 2 };
    // T4: one try on cheap spent its allowance; it passed on mid.
    task("T4").climb = [
      tryOn(1, "cheap", "gpt-oss-120b", "start", "failed", { verdict: "turn_cap", why: "it hit its turn cap (15 turns)" }),
      tryOn(2, "mid", "glm-4.7", "climb", "passed"),
    ];
    task("T4").lives = { rung: "mid", used: 1, of: 2 };
    const answer = fx.events[IDS.live];
    const now = Date.now();
    const top = answer.next_cursor;
    answer.events.push(
      { cursor: top, type: "route_decided", group: "loop", task_id: "T2", ts_millis: now - 40000, model: "glm-4.7", attempt: 4, loop: "route", text: "T2 attempt 4 → glm-4.7" },
      { cursor: top + 1, type: "route_decided", group: "loop", task_id: "T2", ts_millis: now - 20000, model: "gpt-5.4-mini", attempt: 5, loop: "route", text: "T2 attempt 5 → gpt-5.4-mini" },
      { cursor: top + 2, type: "route_decided", group: "loop", task_id: "T4", ts_millis: now - 10000, model: "glm-4.7", attempt: 2, loop: "route", text: "T4 attempt 2 → glm-4.7" }
    );
    answer.next_cursor = top + 3;
  };
  const env = await liveSetup({ url: runUrl(IDS.live), edit });
  const { container } = env;
  try {
    const stream = container.querySelector('[data-roko="stream"]');
    const climbs = [...stream.querySelectorAll('.rk-ln[data-kind="route"][data-tone="live"]')].map((l) => text(l.querySelector(".rk-ln-k")) + " " + text(l.querySelector(".rk-ln-x")));
    assert.deepEqual(climbs, [
      "02 ▲ up to mid · glm-4.7 · 2 tries on cheap didn't pass: 1 check failed, 1 turn cap",
      // Only the tries on the rung it climbed from count, not every earlier rung's.
      "02 ▲ up to strong · gpt-5.4-mini · 2 tries on mid didn't pass: 1 timed out, 1 check failed",
      // One try, by its own why.
      "04 ▲ up to mid · glm-4.7 · turn cap (15 turns) on cheap",
    ]);
    // A spent allowance counts toward a climb, so the ladder's rule counts tries, not checks.
    assert.match(text(container.querySelector('[data-roko="run-models"] .rk-panel-h')), /a stronger one only after failed checks/);
  } finally {
    await cleanup();
    env.restore();
  }
});

test("v3 horizon and an older card: the newest move is bright with the cursor; no ladder without one", async () => {
  const { container } = await setup({ url: runUrl(IDS.live) });
  try {
    const horizon = container.querySelector('[data-roko="ticker"]');
    assert.ok(horizon.classList.contains("rk-glass") && horizon.classList.contains("rk-horizon"), "one glass line");
    const newest = horizon.querySelector('.roko-now-item[data-age="0"]');
    assert.equal(text(newest.querySelector(".roko-now-id")), "Task 2");
    assert.ok(newest.querySelector(".rk-cursor"), "the cursor after the newest move");
    // A card from before 0.6.0: no ladder, no rung chips, no Models panel.
    assert.equal(container.querySelector('[data-roko="run-models"]'), null);
    assert.equal(container.querySelector(".rk-lad"), null);
    assert.equal(container.querySelector(".rk-rchip"), null);
  } finally {
    await cleanup();
  }
});

// --------------------------------------------------------------------------------
// v3 (W3): the Receipt, the end of a run, the chat and sessions strips, the chip (spec v3 §4.6, §5.10, §6)
// --------------------------------------------------------------------------------

/** The ended plan run on the ladder: four tasks passed on cheap at their first try, T5 climbed to mid and passed. */
function receiptEdit(fx) {
  const card = fx.runs[IDS.multiwave].run;
  card.ladder = LADDER.map((r) => (r.rung === "top" ? { ...r, rung: "top" } : r));
  const task = (id) => card.tasks.find((t) => t.task_id === id);
  for (const id of ["T1", "T2", "T3", "T4"]) {
    task(id).climb = [tryOn(1, "cheap", "gpt-oss-120b", "start", "passed")];
    task(id).lives = { rung: "cheap", used: 1, of: 2 };
  }
  const failed = { failed_check: "verify[0:test]", key_line: "AssertionError" };
  task("T5").climb = [tryOn(1, "cheap", "gpt-oss-120b", "start", "failed", failed), tryOn(2, "cheap", "gpt-oss-120b", "retry", "failed", failed), tryOn(3, "mid", "glm-4.7", "climb", "passed")];
  task("T5").lives = { rung: "mid", used: 1, of: 2 };
  card.receipt = {
    cost_usd: card.cost_usd, tasks: card.progress, checks: card.gates,
    by_rung: { cheap: { passed: 4, tries: 6, cost_usd: 0.12 }, mid: { passed: 1, tries: 1, cost_usd: 0.07 } },
    climbs: 1, first_try_passes: 4,
    top_rung: { rung: "strong", model: "gpt-5.4-mini", slug: "gpt-5.4-mini" }, top_rung_usd: 1.21, ratio: 6.2,
    top_rung_by: "passing_tries", not_compared: 0,
    basis: "≈ the 5 passing tries' tokens at gpt-5.4-mini's list prices, plus $0.01 helper calls",
    basis_detail: "45,881 input, 11,078 output and 341,120 cache-read tokens of the 5 passing tries at gpt-5.4-mini's list prices ($0.75 in, $4.50 out per million), plus $0.0100 of helper calls at their cost",
    lessons_kept: 5, lessons_confirmed: 2, lessons_used: 2,
    changes: { kind: "verified", files: 9, additions: 287, deletions: 3, branch: "roko/batch/" + IDS.multiwave, merged: false },
  };
}

test("v3 Receipt: an ended run in four lines: where it passed on the ladder, the top rung ≈, what changed, what roko learned", async () => {
  const { container } = await setup({ url: runUrl(IDS.multiwave), edit: receiptEdit });
  try {
    const receipt = container.querySelector('[data-roko="receipt"]');
    assert.ok(receipt.classList.contains("rk-glass"), "printed on the glass");
    assert.equal(text(receipt.querySelector('[data-roko="receipt-ladder"]')), "ladder 4 passed on cheap · 1 climbed to mid · nothing above");
    const top = receipt.querySelector('[data-roko="receipt-top-rung"]');
    assert.equal(text(top), "top rung ≈ $1.21 on gpt-5.4-mini · this cost 6.2× less");
    assert.match(top.getAttribute("title"), /^45,881 input/, "the counts in its title");
    assert.ok(top.querySelector(".rk-receipt-good"), "a run that cost less than the top rung says so in sage");
    // Q1: its basis is printed as a line of its own, under it, not only in a hover; every task passed, so none is
    // left out.
    const basis = top.nextElementSibling;
    assert.equal(basis.getAttribute("data-roko"), "receipt-basis");
    assert.equal(text(basis), "≈ the 5 passing tries' tokens at gpt-5.4-mini's list prices, plus $0.01 helper calls");
    assert.equal(text(basis.querySelector(".rk-receipt-k")), "");
    assert.equal(basis.getAttribute("data-tone"), "basis");
    assert.equal(receipt.querySelector('[data-roko="receipt-not-compared"]'), null);
    assert.ok(receipt.querySelector(".rk-receipt-rule"));
    const changes = receipt.querySelector('[data-roko="receipt-changes"]');
    assert.equal(text(changes), "changes +287 −3 in 9 files · roko/batch/ffb9f185 · verified");
    assert.equal(changes.getAttribute("title"), "roko/batch/" + IDS.multiwave, "the batch branch by its short id, the full name in the title");
    const learned = receipt.querySelector('[data-roko="receipt-learned"]');
    assert.equal(text(learned), "learned ◇ kept 5 lessons · confirmed 2 it had · 2 lessons in its prompts");
    assert.equal(learned.getAttribute("data-tone"), "learn");
    // The head offers the next step (review & merge), so the receipt does not repeat it.
    assert.ok(container.querySelector('[data-roko="hero-review"]'));
    assert.equal(receipt.querySelector('[data-roko="receipt-review"]'), null);
  } finally {
    await cleanup();
  }
  // No estimate: the top rung has no list price, and the receipt says so. Unverified work is orange, never green.
  const two = await setup({
    url: runUrl(IDS.multiwave),
    edit: (fx) => {
      receiptEdit(fx);
      Object.assign(fx.runs[IDS.multiwave].run.receipt, { top_rung: { rung: "top", model: "claude-sonnet-4-6", slug: "claude-sonnet-4-6" }, top_rung_usd: null, ratio: null, basis: "no list price for claude-sonnet-4-6", basis_detail: null });
      fx.runs[IDS.multiwave].run.receipt.changes.kind = "unverified";
    },
  });
  try {
    const top = two.container.querySelector('[data-roko="receipt-top-rung"]');
    assert.equal(text(top), "top rung no list price for claude-sonnet-4-6", "why there is no estimate, printed");
    assert.equal(top.getAttribute("data-tone"), "dim");
    assert.equal(two.container.querySelector('[data-roko="receipt-basis"]'), null);
    const changes = two.container.querySelector('[data-roko="receipt-changes"]');
    assert.match(text(changes), /unverified: no check ran$/);
    assert.equal(changes.getAttribute("data-tone"), "you");
  } finally {
    await cleanup();
  }
  // Q1: a run that ended without every task passing still compares the tasks that passed and counts the rest; when
  // the climb cost more than starting at the top, the receipt says so in plain ink.
  const partial = await setup({
    url: runUrl(IDS.multiwave),
    edit: (fx) => {
      receiptEdit(fx);
      const card = fx.runs[IDS.multiwave].run;
      card.state = "failed";
      Object.assign(card.receipt, { top_rung_usd: 0.11, ratio: 0.6, not_compared: 1, basis: "≈ the 4 passing tries' tokens at gpt-5.4-mini's list prices" });
    },
  });
  try {
    const top = partial.container.querySelector('[data-roko="receipt-top-rung"]');
    assert.equal(text(top), "top rung ≈ $0.11 on gpt-5.4-mini · the climb cost more this time");
    assert.equal(top.querySelector(".rk-receipt-good"), null, "information, not an alarm, and not sage");
    assert.equal(text(partial.container.querySelector('[data-roko="receipt-basis"]')), "≈ the 4 passing tries' tokens at gpt-5.4-mini's list prices");
    const left = partial.container.querySelector('[data-roko="receipt-not-compared"]');
    assert.equal(text(left), "1 task didn't pass: not compared");
    assert.equal(left.previousElementSibling.getAttribute("data-roko"), "receipt-basis", "under the basis");
  } finally {
    await cleanup();
  }
  const failed = await setup({ url: runUrl(IDS.failed) });
  try {
    const receipt = failed.container.querySelector('[data-roko="receipt"]');
    assert.equal(receipt.querySelector('[data-roko="receipt-top-rung"]'), null, "an older card with no receipt and no ladder compares nothing");
    assert.match(text(receipt.querySelector('[data-roko="receipt-models"]')), /^models /, "an older card without a ladder names its models");
    assert.equal(text(receipt.querySelector('[data-roko="receipt-changes"]')), "changes no changes");
  } finally {
    await cleanup();
  }
});

test("v3 end moment: a run ending while watched stamps it on the glass; the first ever prints its receipt; the first failure types its why", async () => {
  window.localStorage.removeItem("roko-novelty");
  const env = await liveSetup({ url: runUrl(IDS.live) });
  const { container } = env;
  try {
    const socket = FakeSocket.all[0];
    await push(socket, { type: "hello", version: VERSION, overview: env.backend.fx.overview, hub: "open" });
    const card = structuredClone(env.backend.fx.runs[IDS.live].run);
    const ended = (state, extra = {}) => ({
      ...card, state, active: false, finished_at: new Date().toISOString(), ...extra,
      tasks: card.tasks.map((t) => ({ ...t, outcome: state === "succeeded" ? "passed" : t.outcome === "running" ? "failed" : t.outcome })),
      progress: { ...card.progress, running: 0, pending: 0, passed: state === "succeeded" ? 5 : 2, failed: state === "succeeded" ? 0 : 1, blocked: state === "succeeded" ? 0 : 2 },
    });
    await push(socket, { type: "run", run: ended("succeeded") });
    const moment = container.querySelector('[data-roko="end-moment"]');
    assert.equal(text(moment), "passed");
    assert.ok(moment.parentElement.classList.contains("rk-rc-head"), "beside the pill");
    assert.equal(moment.getAttribute("data-tier"), "4", "the first run this workspace ends is a Cinematic");
    // The receipt's fold opens and prints it line by line, a line every 500 ms.
    assert.equal(container.querySelector('[data-roko="fold-receipt"]').open, true);
    const printed = container.querySelectorAll('[data-roko="receipt"] .rk-receipt-line').length;
    assert.ok(printed <= 1, "it starts nearly blank: " + printed);
    const counts = JSON.parse(window.localStorage.getItem("roko-novelty"));
    assert.deepEqual(Object.values(counts)[0], { run_ended: 1 });
    // Back to running, then ended again: the second time is a tier lower, and nothing prints.
    await push(socket, { type: "run", run: { ...card } });
    await push(socket, { type: "run", run: ended("succeeded") });
    assert.equal(container.querySelector('[data-roko="end-moment"]').getAttribute("data-tier"), "3");
    // A failure: the first this workspace sees types its why out.
    await push(socket, { type: "run", run: { ...card } });
    await push(socket, { type: "run", run: ended("failed", { why: { summary: "T2's check verify[0:test] did not pass: AssertionError.", gates_not_passed: [] } }) });
    assert.equal(text(container.querySelector('[data-roko="end-moment"]')), "failed");
    const why = container.querySelector('[data-roko="why"]');
    assert.ok(why.querySelector('[data-roko="type-out"]'), "the why types itself out");
    assert.equal(text(why.querySelector(".roko-why-text .rk-sr")), "T2's check verify[0:test] did not pass: AssertionError.", "whole for screen readers");
  } finally {
    await cleanup();
    env.restore();
  }
});

test("slots stay one line: no ladder and no agent step above the chat or the sessions; the chip's one reading is the newest run's time", async () => {
  const backend = makeBackend("normal", (fx) => {
    climbEdit(fx);
    fx.overview.ladder = LADDER;
    fx.overview.pending = [];
    fx.overview.counts.waiting = 0;
    fx.pending = { ok: true, items: [] };
  });
  const registry = loadBundle(backend);
  try {
    const slot = (name) => registry.slots.find((s) => s.slot === name).component;
    const chat = await mount(slot("chat:top"), { url: "http://localhost/chat" });
    const line = chat.container.querySelector('[data-roko="chatstrip"]');
    assert.ok(line, "one line above the chat");
    assert.equal(line.querySelector('[data-roko="ladder-strip"], .rk-livestrip-horizon, .rk-meter'), null, "the ladder, the agent and the spend are on the run's page");
    const sessions = await mount(slot("sessions:top"), { url: "http://localhost/sessions" });
    assert.equal(sessions.container.querySelector('[data-roko="banner"] [data-roko="ladder-strip"]'), null);
    const chip = await mount(slot("header-right"), { url: "http://localhost/sessions" });
    const live = chip.container.querySelector('[data-roko="chip-live"]');
    assert.ok(live, "nothing waits: the newest run's time");
    assert.match(text(live), /so far 2 running$/);
    assert.equal(chip.container.querySelector(".rk-mlad"), null, "no mini ladder in the chip");
  } finally {
    await cleanup();
  }
});

// --------------------------------------------------------------------------------
// v3 (W5): waiting, the composer, the ◆ badge (spec v3 §2.9, §5.1, §5.4, §5.7)
// --------------------------------------------------------------------------------

test("v3 needs you: the pill, the question, the countdown with what happens at 0:00; a and r answer from the card", async () => {
  const { container, backend } = await setup();
  try {
    const confirm = backend.fx.pending.items.find((i) => i.kind === "confirm");
    const card = container.querySelector(`[data-roko="needs-you"] [data-roko-pending="${confirm.code}"]`);
    assert.ok(card.classList.contains("rk-waitcard"));
    assert.equal(text(card.querySelector('[data-roko="card-pill"]')), "needs you");
    assert.equal(text(card.querySelector(".rk-pend-checked")), "no check ran on this: your answer decides");
    assert.match(text(card.querySelector(".rk-deadline-words")), /^(29|30):\d\d left · then unverified$/, "what happens if you walk away");
    assert.equal(card.querySelectorAll(".rk-deadline .rk-pend-well .rk-meter i").length, 24, "a segmented bar in a well");
    assert.equal(card.querySelector(".rk-deadline").getAttribute("data-urgent"), null);
    const effect = backend.fx.pending.items.find((i) => i.kind === "effect");
    const held = container.querySelector(`[data-roko-pending="${effect.code}"]`);
    assert.equal(text(held.querySelector('[data-roko="card-pill"]')), "held call");
    assert.equal(text(held.querySelector(".rk-pend-checked")), "roko holds the call: nothing is sent until you answer");
    assert.equal(held.querySelector(".rk-deadline"), null, "no deadline, no countdown");
    // The keys: r decline, the note, a approve (orange), with their letters engraved; no task ids or loop codes.
    const keys = [...card.querySelectorAll(".roko-decide > *")].map((k) => k.getAttribute("aria-label"));
    assert.deepEqual(keys, ["Decline " + confirm.code, "Note for " + confirm.code, "Approve " + confirm.code]);
    assert.equal(text(button(card, "Approve " + confirm.code).querySelector(".rk-key-kbd")), "a");
    assert.ok(button(card, "Approve " + confirm.code).classList.contains("rk-key--you"));
    assert.ok(!button(card, "Decline " + confirm.code).classList.contains("rk-key--fail"), "declining is a plain key");
    assert.equal(card.querySelector(".rk-ringtag"), null);
    // a answers the card that has focus; typing a in its note does not.
    await typeInto(card.querySelector("input"), "a");
    await press("a", card.querySelector("input"));
    assert.equal(posts(backend, "/decide").length, 0, "a typed in the note is text");
    await press("a", card);
    assert.deepEqual(posts(backend, "/decide")[0].body, { code: confirm.code, approve: true, note: "a" });
    await press("r", held);
    assert.deepEqual(posts(backend, "/decide")[1].body, { code: effect.code, approve: false });
  } finally {
    await cleanup();
  }
});

test("v3 tabs: three, and what needs you shows on Runs in orange from any of them; the digits open them", async () => {
  const { container } = await setup({ url: "http://localhost/roko?section=plans" });
  try {
    const tabs = [...container.querySelectorAll('.rk-tabs [role="tab"]')].map((b) => text(b).replace(/\s*\d+$/, ""));
    assert.deepEqual(tabs, ["Runs", "Plans", "Learning"]);
    assert.equal(text(container.querySelector('[data-roko="wait-badge"]')), "2");
    await press("1");
    assert.ok(container.querySelector('[data-roko="needs-you"]'), "Runs opens on what needs you");
    await press("2");
    assert.equal(new URL(window.location.href).searchParams.get("section"), "plans", "2 is Plans");
  } finally {
    await cleanup();
  }
  const idle = await setup({ mode: "idle" });
  try {
    assert.equal(idle.container.querySelector('[data-roko="wait-badge"]'), null, "nothing waits: no badge");
  } finally {
    await cleanup();
  }
});

test("v3 composer: where a request starts on the ladder, how far it may climb, and the cap in bone", async () => {
  const { container } = await setup({ edit: (fx) => { fx.overview.ladder = LADDER; } });
  try {
    await click(button(container, "New run"));
    const dialog = container.querySelector('[data-roko="composer"]');
    await click(dialog.querySelector('[data-roko="composer-more"] summary'));
    const where = dialog.querySelector('[data-roko="composer-more"] [data-roko="where-it-starts"]');
    assert.ok(where.classList.contains("rk-glass"));
    const rungs = [...where.querySelectorAll(".rk-where-rung")];
    assert.deepEqual(rungs.map((r) => text(r.querySelector(".rk-rung-r"))), ["top", "strong", "mid", "▸ cheap"], "top rung first");
    assert.equal(rungs[3].getAttribute("data-start"), "true", "a run from Hermes starts on the cheapest rung it can use");
    assert.equal(rungs[0].getAttribute("data-off"), "true");
    assert.equal(text(rungs[0].querySelector(".rk-rung-p")), "not for chat runs");
    assert.equal(rungs[0].querySelector(".rk-rung-p").getAttribute("title"), "not for chat runs: its agent runs its own tools");
    assert.equal(text(where.querySelector(".rk-where-words")), "2 failed tries → a rung up, at most to strong. The $0.50 cap stops it before it spends past it.");
    assert.equal(where.querySelector('[data-roko="starts-likely"]'), null, "an older backend: no estimate");
    assert.equal(text(dialog.querySelector('[data-roko="cap-presets"] [aria-pressed="true"]')), "$0.50", "the cap is the lit preset");
    assert.equal(text(dialog.querySelector('[data-roko="composer-submit"]')), "start · cap $0.50 ⌘↵");
    // Plan first: the planner runs nothing, so nothing starts on the ladder.
    await click([...dialog.querySelectorAll('[role="radio"]')].find((b) => text(b) === "plan first"));
    assert.equal(dialog.querySelector('[data-roko="where-it-starts"]'), null);
  } finally {
    await cleanup();
  }
});

// 0.6.0 P8 (plugin-runs' plansheet.py): the plan as a document. T1 has acceptance with a check that covers AC1; the other
// tasks are as an older backend sends them (checks as commands).
const SHEET_DOC = [
  "# Per-category budgets for tally",
  "",
  "**Goal**: a budget per category, and the monthly report flags a category over it.",
  "",
  "## What to build",
  "",
  "1. **`tally/budgets.py`**: a `BudgetStore` that keeps cents per category",
  "   - `save(path)` and `load(path)` as JSON,",
  "     with the categories sorted",
  "2. `render_summary` shows the budget beside what was spent",
  "",
  "## Non-goals",
  "",
  "- Currencies other than the ledger's",
  "",
  "## Verification",
  "",
  "The tests in `tests/` decide.",
].join("\n");
function sheetEdit(fx) {
  const plan = fx.plan_details[IDS.plan].plan;
  const dir = "plans/" + IDS.plan + "/";
  plan.doc = { title: "Per-category budgets for tally", sections: [], markdown: SHEET_DOC, truncated: true, path: dir + "plan.md" };
  plan.rubric = { markdown: "## Review rubric\n\n- [ ] `python3 -m unittest` passes\n- [ ] OVER only above the limit", truncated: false, path: dir + "rubric.md" };
  plan.imported_from = { kind: "mori", plan: "tally-budgets" };
  plan.plan_checks = [{ name: "plan[0:unit_test]", phase: "unit_test", command: "python3 -m unittest discover -s tests", fail_msg: "Whole suite", covers: [], expect: null }];
  plan.dropped_checks = [{ id: "SC3", reason: "needs a person to judge it" }];
  Object.assign(plan.tasks.find((t) => t.id === "T1"), {
    start_rung: "cheap",
    section: "What to build",
    goal: "A `BudgetStore` the report can read.",
    non_goals: ["currencies"],
    acceptance: [
      { id: "AC1", text: "`BudgetStore.save` then `load` gives the same budgets", checks: ["verify[0:test]"], source_checks: ["SC2"] },
      { id: "AC2", text: "an unknown category has no budget", checks: [], source_checks: [] },
    ],
    verify: [
      { name: "verify[0:test]", phase: "test", command: "python3 -m unittest tests.test_budgets", fail_msg: "budgets round-trip", covers: ["AC1"], expect: "fail_on_base" },
      { name: "verify[1:compile]", phase: "compile", command: "python3 -m py_compile tally/budgets.py", fail_msg: null, covers: [], expect: null },
    ],
  });
  plan.tasks.filter((t) => t.id !== "T1").forEach((t) => { t.start_rung = t.id === "T3" ? "mid" : "cheap"; });
  Object.assign(plan.estimate, {
    by_rung: [
      { rung: "cheap", model: "gpt-oss-120b", tasks: ["T1", "T2", "T4", "T5"], likely_usd: null },
      { rung: "mid", model: "glm-4.7", tasks: ["T3"], likely_usd: null },
      { rung: "strong", model: "gpt-5.4-mini", tasks: [], likely_usd: null },
    ],
    likely_usd: null,
    worst_usd: null,
    start_rung: "cheap",
  });
}

test("v3 plan sheet: a mori plan reads as a document: its summary, the plan on the glass with where its tasks start", async () => {
  const { container } = await setup({ url: "http://localhost/roko?section=plans&plan=" + IDS.plan, edit: sheetEdit });
  try {
    const plan = container.querySelector('[data-roko="plan"]');
    const imported = plan.querySelector('[data-roko="plan-imported"]');
    assert.equal(text(imported), "from mori");
    assert.equal(imported.getAttribute("title"), "roko plan import --mori wrote it from the mori plan tally-budgets");
    // 01: plan.md's own title repeats the plan's and goes; bold may carry code; an item's wrapped line stays with it.
    const doc = plan.querySelector('[data-roko="plan-doc"]');
    assert.ok(![...doc.querySelectorAll("h3,h4,h5,h6")].some((el) => text(el) === "Per-category budgets for tally"));
    assert.equal(text(doc.querySelector(".rk-doc-p")), "Goal : a budget per category, and the monthly report flags a category over it.");
    const items = [...doc.querySelectorAll(".rk-doc-list li")];
    assert.equal(text(items[0]), "1. tally/budgets.py : a BudgetStore that keeps cents per category");
    assert.equal(items[0].querySelector("b code").textContent, "tally/budgets.py");
    assert.equal(items[1].getAttribute("data-depth"), "1");
    assert.equal(text(items[1]), "– save(path) and load(path) as JSON, with the categories sorted");
    assert.doesNotMatch(text(doc), /The tests in/, "folded after six blocks");
    await click(button(doc, "read on"));
    assert.equal(text([...doc.querySelectorAll(".rk-doc-p")].pop()), "The tests in tests/ decide.");
    assert.equal(text(doc.lastChild), "The plan's plan.md goes on; this is its start.");
    assert.ok(button(doc, "fold the summary"));
    // 02: the plan on the glass; the estimate is ink (the cap is this sheet's bone number).
    const stats = plan.querySelector('[data-roko="plan-stats"]');
    assert.ok(stats.classList.contains("rk-glass"));
    assert.equal(text(stats.querySelector('[data-roko="plan-count"]')), "tasks 5 tasks 7 checks");
    assert.equal(stats.querySelector('[data-roko="plan-cost"] .rk-dots').getAttribute("data-ch"), "ink");
    const starts = [...stats.querySelectorAll('[data-roko="plan-starts"] li')];
    assert.deepEqual(starts.map((li) => li.getAttribute("data-start")), ["true", "true", null]);
    assert.equal(text(starts[0]), "cheap gpt-oss-120b T1 T2 T4 T5");
    assert.equal(text(stats.querySelector('[data-roko="plan-estimate"]')), "est $0.03 · ~30s · confidence low · starts 4 tasks on cheap, 1 task on mid");
    assert.equal(plan.querySelector('.roko-runform .rk-knob-well .rk-dots').getAttribute("data-ch"), "bone");
    // 03: a planned pad says the rung its task starts on, and counts its named checks.
    assert.equal(text(node(plan, "T1").querySelector(".rk-rchip")), "cheap");
    assert.match(text(node(plan, "T1")), /implementer · 2 checks/);
  } finally {
    await cleanup();
  }
});

test("v3 plan sheet: each criterion with the check that proves it, the rest of its checks, the whole-plan check, the rubric folded", async () => {
  const { container } = await setup({ url: "http://localhost/roko?section=plans&plan=" + IDS.plan, edit: sheetEdit });
  try {
    const plan = container.querySelector('[data-roko="plan"]');
    assert.equal(plan.querySelector('[data-roko="plan-tasks"]').getAttribute("data-doc"), "true");
    const t1 = plan.querySelector('[data-roko-plantask="T1"]');
    assert.equal(text(t1.querySelector(".rk-rchip")), "cheap");
    assert.equal(text(t1.querySelector(".rk-plantask-meta")), "§ What to build");
    assert.equal(text(t1.querySelector(".rk-plantask-goal")), "A BudgetStore the report can read.");
    const criteria = [...t1.querySelectorAll('[data-roko="acceptance"] li')];
    assert.deepEqual(criteria.map(text), [
      "AC1 SC2 BudgetStore.save then load gives the same budgets verify[0:test] python3 -m unittest tests.test_budgets",
      "AC2 an unknown category has no budget",
    ]);
    const proof = criteria[0].querySelector('[data-roko="check-chip"]');
    assert.equal(proof.getAttribute("title"), "python3 -m unittest tests.test_budgets\nif it fails: budgets round-trip\nit fails on the unchanged base");
    assert.equal(text(t1.querySelector(".rk-plantask-checks")), "also checked by verify[1:compile] python3 -m py_compile tally/budgets.py");
    assert.equal(text(t1.querySelector(".rk-plantask-nongoals")), "not in scope: currencies");
    // An older backend's task: its checks as commands, proved by them.
    const t2 = plan.querySelector('[data-roko-plantask="T2"]');
    assert.match(text(t2.querySelector(".rk-plantask-checks")), /^proved by grep -q 'OVER' tally\/reports\.py/);
    assert.equal(text(t2.querySelector(".rk-plantask-meta")), "needs T1");
    assert.equal(
      text(plan.querySelector('[data-roko="plan-checks"]')),
      "the whole plan, once its tasks passed plan[0:unit_test] python3 -m unittest discover -s tests"
    );
    assert.equal(text(plan.querySelector('[data-roko="plan-dropped"]')), "not kept from its source SC3 needs a person to judge it");
    const rubric = plan.querySelector('[data-roko="plan-rubric"]');
    assert.equal(rubric.tagName, "DETAILS");
    assert.equal(rubric.open, false, "folded");
    assert.match(text(rubric.querySelector("summary")), /review rubric plans\/.+\/rubric\.md$/);
    assert.deepEqual([...rubric.querySelectorAll("li")].map(text), ["– python3 -m unittest passes", "– OVER only above the limit"]);
    // The inspector names the checks too.
    await click(node(plan, "T1"));
    assert.deepEqual([...plan.querySelectorAll('.roko-inspector [data-roko="check-chip"] b')].map(text), ["verify[0:test]", "verify[1:compile]"]);
  } finally {
    await cleanup();
  }
});

test("v3 plan sheet: roko's estimate (R7) in the desktop's words, honest about its basis (F10); an older backend's plan shows no document parts", async () => {
  const taskEstimate = (likely, worst, basis) => ({ likely_usd: likely, likely_secs: 40, worst_usd: worst, worst_rungs: ["cheap", "mid", "strong"], first_try_rate: 0.7, basis, samples: 12 });
  const priced = await setup({
    url: "http://localhost/roko?section=plans&plan=" + IDS.plan,
    edit: (fx) => {
      sheetEdit(fx);
      const plan = fx.plan_details[IDS.plan].plan;
      Object.assign(plan.estimate, { likely_usd: 0.19, worst_usd: 1.29, cap_usd: 0.25, unpriced_tasks: ["T5"], confidence: "low" });
      plan.estimate.by_rung[0].likely_usd = 0.03;
      plan.tasks.find((t) => t.id === "T1").estimate = taskEstimate(0.05, 0.32, "same_tier");
      plan.tasks.find((t) => t.id === "T2").estimate = taskEstimate(0.04, 0.3, "defaults");
    },
  });
  try {
    const stats = priced.container.querySelector('[data-roko="plan-stats"]');
    const words = stats.querySelector('[data-roko="plan-estimate"]');
    // No "at most" with a task unpriced: roko leaves it out of both figures, and the line says so.
    assert.equal(text(words), "likely $0.19 · worst $1.29 for the priced tasks · 1 task unpriced · cap $0.25 · the worst case is over the cap: roko stops at $0.25 · roko's estimate, partly from its defaults · low confidence");
    assert.ok(words.querySelector('[data-roko="plan-over-cap"]').classList.contains("rk-est-over"), "the warning in orange");
    assert.match(text(stats.querySelector('[data-roko="plan-cost"]')), /^likely roko estimates \$0\.19 /);
    assert.equal(text(stats.querySelector('[data-roko="plan-starts"] li .rk-rung-p')), "≈ $0.03");
    // Each task's head: roko's estimate of it, else the rung it starts on.
    const t1 = priced.container.querySelector('[data-roko-plantask="T1"]');
    assert.equal(text(t1.querySelector('[data-roko="task-estimate"]')), "starts on cheap · likely $0.05 · worst $0.32");
    assert.equal(t1.querySelector(".rk-rchip"), null);
    assert.equal(text(priced.container.querySelector('[data-roko-plantask="T3"] .rk-rchip')), "mid");
  } finally {
    await cleanup();
  }
  const older = await setup({ url: "http://localhost/roko?section=plans&plan=" + IDS.plan });
  try {
    const plan = older.container.querySelector('[data-roko="plan"]');
    for (const part of ["plan-doc", "plan-rubric", "plan-imported", "plan-checks", "plan-dropped", "plan-starts", "acceptance"]) {
      assert.equal(plan.querySelector('[data-roko="' + part + '"]'), null, part);
    }
    assert.equal(plan.querySelector('[data-roko="plan-tasks"]').getAttribute("data-doc"), null);
    assert.equal(text(plan.querySelector('[data-roko="plan-estimate"]')), "est $0.03 · ~30s · confidence low");
  } finally {
    await cleanup();
  }
});

test("v3 composer with P7: likely ≈ and its basis, the worst case against the cap, similar tasks, the checks; the cap starts from p90", async () => {
  const estimate = {
    start_rung: "cheap", climb: ["cheap", "mid", "strong"], ladder: LADDER,
    likely: { usd: 0.021, seconds: 74 }, worst_usd: 0.31, max_usd: 0.5, stops_at_cap: false,
    similar: { runs: 12, tasks: 12, first_try: 9, first_try_rate: 0.75, p90_usd: 0.06 },
    checks: [
      { name: "verify[0:test]", phase: "test", command: "python3 -m unittest -q", source: "roko.toml" },
      { name: "verify[1:lint]", phase: "lint", command: "ruff check .", source: "roko.toml" },
      { name: "verify[2:types]", phase: "types", command: "mypy tally", source: "roko.toml" },
      { name: "verify[3:compile]", phase: "compile", command: "python3 -m compileall -q tally", source: "roko" },
    ],
    basis: "≈ the median of 12 similar runs Hermes started here", confidence: "medium",
  };
  const { container, backend } = await setup({ edit: (fx) => { fx.estimate = { ok: true, estimate }; } });
  try {
    await click(button(container, "New run"));
    const dialog = container.querySelector('[data-roko="composer"]');
    const where = dialog.querySelector('[data-roko="where-it-starts"]');
    assert.ok(backend.calls.some((c) => c.url.indexOf("/estimate?chars=0&domain=code") >= 0), "asked once the composer opened");
    assert.equal(text(where.querySelector('[data-roko="starts-likely"]')), "likely ≈ likely about $0.02 about a minute · cheap rung");
    assert.equal(text(where.querySelector('[data-roko="starts-basis"]')), "≈ the median of 12 similar runs Hermes started here");
    // 9 in 10 similar runs cost under $0.06: the cap starts at the $0.25 detent, under the worst case.
    assert.equal(text(dialog.querySelector('[data-roko="cap-presets"] [aria-pressed="true"]')), "$0.25");
    assert.equal(text(dialog.querySelector('[data-roko="composer-note"]')), "roko expects about $0.02 and a minute; the cap stops it before it spends past $0.25.");
    assert.equal(text(where.querySelector('[data-roko="starts-rule"]')), "2 failed tries → a rung up, at most to strong. The $0.25 cap stops it before it spends past it.");
    assert.equal(text(where.querySelector('[data-roko="starts-similar"]')), "12 similar tasks: 75% passed on the first try .");
    const checks = [...where.querySelectorAll('[data-roko="starts-checks"] li')].map(text);
    assert.deepEqual(checks, ["test python3 -m unittest -q roko.toml", "lint ruff check . roko.toml", "types mypy tally roko.toml", "and 1 more check"]);
    // A picked cap stands; past the worst case, the cap is the bound no more.
    await click([...dialog.querySelectorAll('[data-roko="cap-presets"] button')].find((b) => text(b) === "$0.50"));
    assert.equal(text(where.querySelector('[data-roko="starts-rule"]')), "2 failed tries → a rung up, at most to strong. At worst ≈ $0.31, under the $0.50 cap.");
    // Q5: once the person stops typing, roko is asked again with the request's length, never its words (a URL ends up
    // in logs and history).
    const ask = "Add a --json flag to tally's balance command";
    await typeInto(dialog.querySelector("textarea"), ask);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 700)); });
    await settle();
    assert.ok(backend.calls.some((c) => c.url.indexOf("/estimate?chars=" + ask.length + "&domain=code") >= 0), "asked with its length");
    assert.ok(!backend.calls.some((c) => c.url.indexOf("/estimate") >= 0 && /prompt=|json|tally/.test(c.url)), "never with its words");
  } finally {
    await cleanup();
  }
  // roko will run no check: it never climbs, and the run ends unverified.
  const none = await setup({ edit: (fx) => { fx.estimate = { ok: true, estimate: { ...estimate, checks: [], similar: null } }; } });
  try {
    await click(button(none.container, "New run"));
    const where = none.container.querySelector('[data-roko="where-it-starts"]');
    assert.match(text(where.querySelector('[data-roko="starts-rule"]')), /^roko found no check to run, so it never climbs: the run ends unverified\./);
    assert.equal(where.querySelector('[data-roko="starts-similar"]'), null);
  } finally {
    await cleanup();
  }
});

// --------------------------------------------------------------------------------
// Dogfood run 3's U-items and the on-camera notes (hermes-update's desktop fixes, mirrored)
// --------------------------------------------------------------------------------

test("dogfood: a failed check's line is its own try's; roko's stop in its words; a check block a try; no doubled tool steps", async () => {
  const edit = (fx) => {
    climbEdit(fx);
    const card = fx.runs[IDS.live].run;
    const t2 = card.tasks.find((t) => t.task_id === "T2");
    t2.climb[0] = { ...t2.climb[0], key_line: "AssertionError: 2 != 0" };
    t2.climb[1] = { ...t2.climb[1], key_line: "AssertionError: 'over budget' not found" };
    const answer = fx.events[IDS.live];
    const now = Date.now();
    const top = answer.next_cursor;
    answer.events.push(
      { cursor: top, type: "agent_output", group: "agent", task_id: "T3", ts_millis: now - 40000, tool: "read_file", target: "tally/cli.py", text: "T3 read_file tally/cli.py" },
      { cursor: top + 1, type: "agent_output", group: "agent", task_id: "T3", ts_millis: now - 39000, tool: "read_file", target: "", text: "T3 read_file" },
      { cursor: top + 2, type: "agent_output", group: "agent", task_id: "T3", ts_millis: now - 30000, stopped: true, text: "T3 stopped: it hit its turn cap (12 turns)" }
    );
    answer.next_cursor = top + 3;
  };
  const env = await liveSetup({ url: runUrl(IDS.live), edit });
  const { container } = env;
  try {
    const stream = container.querySelector('[data-roko="stream"]');
    const rows = () => [...stream.querySelectorAll(".rk-ln")].map((l) => text(l)).join(" | ");
    assert.match(rows(), /02 ✕ verify\[0:test\] did not pass \| AssertionError: 2 != 0 \|.*02 ✕ verify\[0:test\] did not pass \| AssertionError: 'over budget' not found/);
    const lines = [...stream.querySelectorAll(".rk-ln")].map(text);
    assert.ok(lines.some((l) => /03 read_file tally\/cli\.py$/.test(l)), "the screened step stays");
    assert.ok(!lines.some((l) => /03 read_file$/.test(l)), "its doubled end goes");
    assert.match(rows(), /03 ■ stopped: it hit its turn cap \(12 turns\)/);
    assert.ok(stream.querySelector('.rk-ln[data-kind="stopped"]'));
    // A new try's check starts clean: try 2's FAILED lines stay in try 2's block.
    const socket = FakeSocket.all[0];
    await push(socket, { type: "hello", version: VERSION, overview: env.backend.fx.overview, hub: "open" });
    await push(socket, { type: "live", run_id: IDS.live, task_id: "T2", attempt: 2, kind: "check", gate: "verify[0:test]", line: "FAILED (failures=1)", stream: "stdout", ts: Date.now() - 2000 });
    await push(socket, { type: "live", run_id: IDS.live, task_id: "T2", attempt: 3, kind: "check", gate: "verify[0:test]", line: "Ran 3 tests in 0.004s", stream: "stdout", ts: Date.now() - 1000 });
    await push(socket, { type: "live", run_id: IDS.live, task_id: "T2", attempt: 3, kind: "check", gate: "verify[0:test]", line: "… 40 more lines were not streamed", stream: "roko", ts: Date.now() });
    const blocks = [...stream.querySelectorAll('[data-roko="stream-check"]')].map(text);
    assert.deepEqual(blocks, ["FAILED (failures=1)", "Ran 3 tests in 0.004s … 40 more lines were not streamed"]);
    assert.equal(text(stream.querySelector(".rk-ln-note")), "… 40 more lines were not streamed", "roko's own line, dim");
    // An agent's markdown stays out of its words.
    await push(socket, { type: "live", run_id: IDS.live, task_id: "T2", attempt: 3, kind: "text", text: "x", said: "All met: 1. **Import**: `from tally import x`", ts: Date.now() });
    const said = stream.querySelector('[data-roko="stream-words"]');
    assert.equal(said.querySelector("b").textContent, "Import");
    assert.equal(said.querySelector("code").textContent, "from tally import x");
    assert.doesNotMatch(said.textContent, /\*\*|`/);
  } finally {
    await cleanup();
    env.restore();
  }
});

test("dogfood: an attempt row names its climb and what ended a try; a new lesson moves up no tier; split or replan from roko", async () => {
  const edit = (fx) => {
    climbEdit(fx);
    const t2 = fx.runs[IDS.live].run.tasks.find((t) => t.task_id === "T2");
    t2.attempt_log = [
      { attempt: 1, model: "gpt-oss-120b", gates: [{ gate: "verify[0:test]", passed: false }] },
      { attempt: 2, model: "gpt-oss-120b", gates: [{ gate: "verify[0:test]", passed: false }] },
      { attempt: 3, model: "glm-4.7", gates: [] },
    ];
    t2.climb[1] = { ...t2.climb[1], verdict: "turn_cap", why: "it hit its turn cap (12 turns)" };
    t2.lessons = [{ admission: "light_admitted", reinforced: 0, promoted: 1, lesson: "Format money with a dollar sign." }];
    const t1 = fx.runs[IDS.live].run.tasks.find((t) => t.task_id === "T1");
    t1.outcome = "failed";
    t1.climb = [tryOn(1, "strong", "gpt-5.4-mini", "start", "failed", { failed_check: "verify[0:test]" })];
    t1.exhausted = { attempt: 1, rung: "strong", model: "gpt-5.4-mini", suggestion: "split T1: its check needs two files changed together" };
  };
  const { container } = await setup({ url: runUrl(IDS.live), edit });
  try {
    await click(node(container, "T2"));
    const inspector = container.querySelector('[data-roko-inspector="T2"]');
    const rows = [...inspector.querySelectorAll(".roko-attempt")];
    assert.equal(text(rows[2].querySelector(".rk-tag")), "▲ mid", "the climb, named");
    assert.equal(rows[2].querySelector(".rk-tag").getAttribute("title"), "climbed cheap → mid after 2 failed tries");
    const end = rows[1].querySelector('[data-roko="attempt-end"]');
    assert.equal(text(end), "turn cap");
    assert.equal(end.getAttribute("title"), "it hit its turn cap (12 turns)");
    assert.equal(text(rows[0].querySelector('[data-roko="attempt-end"]')), "check failed");
    assert.equal(rows[2].querySelector('[data-roko="attempt-end"]'), null, "the try that runs has no end yet");
    assert.doesNotMatch(text(inspector), /moved up a tier/, "a lesson just kept enters its first tier");
    assert.match(text(inspector), /kept a new lesson/);
    const stamp = container.querySelector('[data-roko="stamp-exhausted"]');
    assert.equal(stamp.getAttribute("title"), "split T1: its check needs two files changed together");
  } finally {
    await cleanup();
  }
});

test("P-36: a task not started yet waits on its tier's start rung, not on the first rung", async () => {
  const edit = (fx) => {
    climbEdit(fx);
    fx.runs[IDS.live].run.tasks.find((t) => t.task_id === "T5").tier = "integrative";
  };
  const { container } = await setup({ url: runUrl(IDS.live), edit });
  try {
    const on = (rung) => container.querySelector('.rk-rung[data-rung="' + rung + '"]');
    assert.equal(on("mid").querySelector('[data-roko-token="T5"]').getAttribute("data-state"), "waiting");
    assert.ok(!on("cheap").querySelector('[data-roko-token="T5"]'), "not on the first rung");
    assert.ok(on("cheap").querySelector('[data-roko-token="T3"]'), "a task without a tier waits on the first rung");
  } finally {
    await cleanup();
  }
});

test("phase 2.1's receipt: passes on a rung that were failover substitutes say so", async () => {
  const edit = (fx) => {
    climbEdit(fx);
    const card = fx.runs[IDS.live].run;
    card.state = "succeeded";
    card.active = false;
    const failover = { model: "gpt-5.4-mini", provider: "openai", class: "rate_limited", why: "rate limited" };
    card.tasks.forEach((t, i) => {
      t.outcome = "passed";
      t.climb = [tryOn(1, i < 2 ? "strong" : "mid", i < 2 ? "gpt-5.4-mini" : "glm-4.7", i < 2 ? "failover" : "start", "passed", i < 2 ? { failover: failover } : {})];
      t.lives = null;
    });
  };
  const { container } = await setup({ url: runUrl(IDS.live), edit });
  try {
    assert.match(text(container), /2 passed on strong via failover/);
  } finally {
    await cleanup();
  }
});

test("phase 2's stills: two tasks out of rungs on one rung get one stamp beside the last; the receipt says 'for them'", async () => {
  const edit = (fx) => {
    climbEdit(fx);
    const card = fx.runs[IDS.live].run;
    card.state = "failed";
    card.active = false;
    const out = { attempt: 3, rung: "strong", model: "gpt-5.4-mini", suggestion: "Split the task into smaller tasks, or replan it." };
    for (const id of ["T3", "T4"]) {
      const t = card.tasks.find((x) => x.task_id === id);
      t.outcome = "failed";
      t.climb = [1, 2, 3].map((n) => tryOn(n, "strong", "gpt-5.4-mini", n === 1 ? "start" : "retry", "failed", { failed_check: "verify[0:test]" }));
      t.lives = null;
      t.exhausted = out;
    }
  };
  const { container } = await setup({ url: runUrl(IDS.live), edit });
  try {
    const strong = container.querySelector('.rk-rung[data-rung="strong"]');
    const stamps = [...strong.querySelectorAll('[data-roko="stamp-exhausted"]')];
    assert.equal(stamps.length, 1, "one stamp for the rung");
    assert.equal(stamps[0].getAttribute("title"), "T3, T4: Split the task into smaller tasks, or replan it.");
    assert.equal(stamps[0].parentElement.getAttribute("data-beside"), "T4", "beside the rung's last token");
    assert.equal(stamps[0].parentElement.style.right, "", "never at the rail's end over the tokens");
    assert.equal(strong.querySelector('[data-roko-token="T3"]').getAttribute("data-exhausted"), "true");
    assert.match(text(container), /T3, T4 failed on strong, the ladder's last rung for them/);
  } finally {
    await cleanup();
  }
});

test("dogfood: a resume links the run it resumed and says the plan's runs together; a title that is the id once", async () => {
  const earlier = IDS.failed;
  const edit = (fx) => {
    const card = fx.runs[IDS.multiwave].run;
    card.resumes = earlier;
    card.chain = { run_ids: [earlier, IDS.multiwave], cost_usd: 0.37, progress: { total: 5, passed: 5 } };
    const row = fx.overview.runs.find((r) => r.run_id === IDS.multiwave);
    row.chain = card.chain;
    fx.plans = { ok: true, plans: [{ id: "add-tests", title: "add-tests", task_count: 3, tasks_done: 0, status: "ready" }], total: 1 };
    fx.plan_details["add-tests"] = { ok: true, plan: { plan_id: "add-tests", title: "add-tests", task_count: 1, tasks: [{ id: "T1", title: "a test", depends_on: [], checks: [] }], waves: [["T1"]] } };
  };
  const { container } = await setup({ url: runUrl(IDS.multiwave), edit });
  try {
    const hero = container.querySelector('[data-roko="hero"]');
    assert.equal(text(hero.querySelector('[data-roko="plan-chain"]')), "this plan over 2 runs: $0.37 · 5/5 tasks passed");
    await click(hero.querySelector('[data-roko="resumes"]'));
    assert.equal(new URL(window.location.href).searchParams.get("run"), earlier, "the run it resumed opens");
    await openTab(container, "Plans");
    const item = container.querySelector('[data-roko-plan="add-tests"]');
    assert.equal(text(item.querySelector(".rk-line-title")), "add-tests ready to run", "its id is its title: said once");
  } finally {
    await cleanup();
  }
});

// --------------------------------------------------------------------------------
// The panel follows the host (design system §5.1), and its text reads at least 4.5:1 (§3)
// --------------------------------------------------------------------------------

test("the panel reads the host's own tokens: a light ground takes the day inks; an ink under 4.5:1 gives way to the panel's", async () => {
  // test_dashboard_contrast.py resolves style.css for each tone; this checks the bundle picks the tone from the host's
  // ground and ink, whatever the theme is called.
  const root = window.document.documentElement;
  const hosts = [
    ["Hermes Teal", "#041c1c", "#ffe6cb", []],
    ["Nous Blue", "#E8F2FD", "#0053FD", ["roko--light"]],
    ["a dark ground whose ink reads 2.6:1", "#101418", "#4a5560", ["roko--ink"]],
    ["a light ground whose ink reads 1.6:1", "#f4f4f2", "#b8bcc0", ["roko--light", "roko--ink"]],
  ];
  try {
    for (const [name, ground, ink, want] of hosts) {
      root.style.setProperty("--background-base", ground);
      root.style.setProperty("--midground-base", ink);
      const { container } = await setup({ url: "http://localhost/roko?section=learning", edit: (fx) => { fx.learning = learningAnswer(); } });
      try {
        const page = container.querySelector('[data-roko="page"]');
        assert.deepEqual(["roko--light", "roko--ink"].filter((tone) => page.classList.contains(tone)), want, name);
      } finally {
        await cleanup();
      }
    }
  } finally {
    root.style.removeProperty("--background-base");
    root.style.removeProperty("--midground-base");
  }
});

// --------------------------------------------------------------------------------
// W4: Learning (spec v3 §5.6; plugin-runs' P6 `GET /learning`, as docs/ui-api.md gives it)
// --------------------------------------------------------------------------------

/** Six ended runs from Hermes: a verified task gets cheaper, first tries rise, climbs fall; one lesson paid off twice. */
function learningAnswer() {
  const now = Date.now();
  const day = 86400000;
  const runs = [
    ["r1", 0.0316, 3, 3, 1, 2, { cheap: 1, mid: 2 }],
    ["r2", 0.0298, 3, 3, 1, 1, { cheap: 1, mid: 1, strong: 1 }],
    ["r3", 0.0244, 4, 4, 2, 1, { cheap: 2, mid: 2 }],
    ["r4", 0.0141, 4, 4, 3, 1, { cheap: 3, mid: 1 }],
    ["r5", 0.0118, 3, 3, 3, 0, { cheap: 3 }],
    ["r6", 0.0104, 5, 5, 4, 1, { cheap: 4, mid: 1 }],
  ].map(([id, cost, tasks, passed, first, climbs, by], i) => ({
    run_id: id + "-0000-4000-8000-000000000000", label: "run " + (i + 1), state: "succeeded", finished_at: new Date(now - (6 - i) * day).toISOString(),
    cost_usd: cost, tasks, passed, first_try: first, climbs, cost_per_pass: cost / passed, cost_per_pass_by: "roko",
    rungs: Object.entries(by).map(([rung, n]) => ({ rung, passed: n, running: 0, failed: 0, waiting: 0 })), lessons_kept: [], lessons_used: [],
    _by: by,
  }));
  return {
    ok: true,
    scope: "hermes",
    runs: runs.map(({ _by, ...r }) => r),
    kpis: {
      cost_per_pass: { value: 0.0026, first: 0.0101, series: runs.map((r) => r.cost_per_pass) },
      first_try_rate: { value: 0.8333, first: 0.4, series: runs.map((r) => r.first_try / r.tasks) },
      climbs_per_run: { value: 0.67, first: 1.33, series: runs.map((r) => r.climbs) },
    },
    lessons_first_try: {
      with: { passed: 7, of: 8, rate: 0.875 }, without: { passed: 3, of: 7, rate: 0.4286 },
      design: "observational", comparable: true, difference: 0.4464, note: "observational: tasks without a lesson differ in other ways too",
    },
    where_passed: { rungs: LADDER, runs: runs.map((r) => ({ run_id: r.run_id, passed: r._by })), cheapest_share: { first: 0.41, last: 0.78 } },
    lessons: [
      {
        id: "k-cents", text: "Keep money in integer cents; format with a dollar sign only when printing.",
        kept_by: { run_id: runs[2].run_id, task_id: "T2", at: new Date(now - 4 * day).toISOString() },
        uses: [
          { run_id: runs[3].run_id, task_id: "T1", first_try: true, climbed: false, passed: true },
          { run_id: runs[4].run_id, task_id: "T2", first_try: true, climbed: false, passed: true },
        ],
        first_try: 2, confidence: 0.8,
      },
      {
        id: "k-parser", text: "The report's parser splits on two spaces, never one.",
        kept_by: null,
        uses: [{ run_id: runs[5].run_id, task_id: "T3", first_try: false, climbed: true, passed: true }],
        first_try: 0, confidence: 0.4,
      },
    ],
    homeostat: {
      variables: [
        { ev: "pass_rate", value: 0.86, bound: 0.7, inner: 0.8, state: "in_bounds" },
        { ev: "usd_per_verified_success", value: 0.012, bound: 0.05, inner: 0.03, state: "in_bounds" },
        { ev: "false_green", value: 0.08, bound: 0.05, inner: 0.02, state: "breached" },
        { ev: "latency_p90_s", value: 182, bound: 300, inner: 240, state: "in_bounds" },
      ],
      controller: { episode_id: "m1-7", phase: "hold", change: null },
    },
    checked_at: new Date(now).toISOString(),
  };
}

test("v3 Learning: one page; an old link to its loops, lessons or models opens it with that fold open; 3 opens it", async () => {
  const { container } = await setup({ edit: (fx) => { fx.learning = learningAnswer(); } });
  try {
    const tabs = [...container.querySelectorAll('.rk-tabs [role="tab"]')].map((b) => text(b).replace(/\s*\d+$/, ""));
    assert.deepEqual(tabs, ["Runs", "Plans", "Learning"]);
    await press("3");
    assert.equal(new URL(window.location.href).searchParams.get("section"), "learning");
    assert.ok(container.querySelector('[data-roko="learning-overview"]'), "3 opens Learning");
    assert.equal(container.querySelector('[data-roko="learning-tabs"]'), null, "no sub-tabs: one page");
    assert.deepEqual([...container.querySelectorAll('[data-roko="learning-overview"] .rk-fold2 > summary')].map(text), ["the five loops, in plain words", "how roko keeps itself steady", "every lesson", "checks, models and spend in detail"]);
  } finally {
    await cleanup();
  }
  for (const [section, fold] of [["knowledge", "lessons"], ["health", "checks"], ["loops", "loops"]]) {
    const old = await setup({ url: "http://localhost/roko?section=" + section, edit: (fx) => { fx.learning = learningAnswer(); } });
    try {
      assert.equal(old.container.querySelector('.rk-tabs [data-tab="learning"]').getAttribute("aria-selected"), "true");
      assert.equal(old.container.querySelector(`[data-roko="fold-${fold}"]`).open, true, section + " opens its fold");
    } finally {
      await cleanup();
    }
  }
  // No run has ended yet: Learning is there, ghosted, and says when it starts.
  const fresh = await setup({ mode: "empty" });
  try {
    const learning = fresh.container.querySelector('.rk-tabs [data-tab="learning"]');
    assert.equal(learning.getAttribute("data-ghost"), "true");
    assert.equal(learning.getAttribute("title"), "roko starts learning when your first run ends");
  } finally {
    await cleanup();
  }
});

test("v3 Learning: three readings on the glass and what drove them, which models passed the work, the lessons that paid off, the homeostat folded", async () => {
  const { container } = await setup({ url: "http://localhost/roko?section=learning", edit: (fx) => { fx.learning = learningAnswer(); } });
  try {
    const page = container.querySelector('[data-roko="learning-overview"]');
    assert.equal(text(page.querySelector('[data-roko="learning-scope"]')), "runs from hermes workspace 6 runs · 6 days");
    const hero = page.querySelector('[data-roko="learning-hero"]');
    assert.ok(hero.classList.contains("rk-well"), "the readings are on the glass");
    const usd = hero.querySelector('[data-roko="kpi-usd"]');
    assert.equal(text(usd.querySelector(".rk-rc-label")), "cost per passed task");
    assert.equal(text(usd.querySelector(".rk-dots .rk-sr")), "<$0.01 per passed task");
    assert.equal(text(usd.querySelector(".rk-kpi-note")), "↓ 74% · was $0.01 on your first runs");
    assert.equal(usd.querySelector(".rk-kpi-note").getAttribute("data-ch"), "pass");
    assert.match(text(usd), /roko's own figures · last 6 runs/);
    const first = hero.querySelector('[data-roko="kpi-first"]');
    assert.equal(text(first.querySelector(".rk-dots .rk-sr")), "83% passed on the first try");
    assert.equal(text(first.querySelector(".rk-kpi-note")), "↑ from 40%");
    assert.equal(text(hero.querySelector('[data-roko="kpi-climbs"] .rk-kpi-note')), "↓ from 1.3");
    // What drove them, under the glass, from what the runs show.
    assert.equal(text(page.querySelector('[data-roko="kpi-why"]')), "First tries: with a lesson 7/8 passed first try, without 3/7 · +45 points · observational.");
    // Which models passed the work: a bar a model, cheapest first; a model chats cannot use and that passed nothing is left out.
    const models = page.querySelector('[data-roko="models-passed"]');
    assert.deepEqual([...models.querySelectorAll(".rk-bars-row")].map((r) => r.getAttribute("data-rung")), ["cheap", "mid", "strong"]);
    assert.equal(text(models.querySelector('[data-roko="models-said"]')), "22 passing tries. The 2 cheaper models passed 21 of them, and gpt-5.4-mini the other 1. The cheapest model's share went from 41% to 78% of passes.");
    // Lessons that paid off: who kept it, in words (no run id), its payoff squares.
    const lessons = [...page.querySelectorAll('[data-roko="lesson-paid"]')];
    assert.equal(lessons.length, 2);
    assert.equal(text(lessons[0].querySelector(".rk-payoff-n")), "2/2 first try");
    assert.match(text(lessons[0].querySelector("small")), /^kept 4 days ago by a run · in 2 prompts since/);
    assert.match(text(lessons[1].querySelector("small")), /^kept before these runs · in 1 prompt since/);
    assert.doesNotMatch(text(page.querySelector('[data-roko="lessons-paid"]')), /r3-0000|T2/);
    // How roko keeps itself steady, folded: four numbers a line each, the one out of bounds in red, and its controller.
    const homeo = page.querySelector('[data-roko="fold-steady"] [data-roko="homeostat"]');
    assert.equal(homeo.querySelectorAll(".rk-steady-row").length, 4);
    const fg = homeo.querySelector('[data-roko="gauge-false_green"]');
    assert.equal(fg.getAttribute("data-out"), "true");
    assert.equal(fg.getAttribute("aria-label"), "passed but wrong: 8%, bound ≤ 5%, out of bounds");
    assert.equal(text(fg.querySelector(".rk-steady-bound")), "kept at 5% or less");
    assert.equal(homeo.querySelector('[data-roko="gauge-latency_p90_s"]').getAttribute("aria-label"), "slowest waits (p90): 182 seconds, bound ≤ 300 seconds");
    // A stopwatch, as the desktop shows it: in the mono face a small s reads as a 5 ("1825").
    assert.equal(text(homeo.querySelector('[data-roko="gauge-latency_p90_s"] .rk-steady-v')), "3:02");
    assert.equal(text(homeo.querySelector('[data-roko="m1-line"]')), "It is holding for now · passed but wrong is out of bounds");
    assert.ok(page.querySelector('[data-roko="fold-loops"] [data-roko="five-loops"]'), "the five loops, folded");
    // The run that kept a lesson opens from its words.
    const keptBy = lessons[0].querySelector(".rk-chain-run");
    assert.equal(keptBy.getAttribute("title"), "Open the run that kept it");
    await click(keptBy);
    assert.equal(new URL(window.location.href).searchParams.get("run"), "r3-0000-4000-8000-000000000000");
  } finally {
    await cleanup();
  }
});

test("Q3: the first-try line gives both n's, the difference whichever way it points or why there is none, and how the sides were drawn", async () => {
  const driver = async (lft) => {
    const { container } = await setup({ url: "http://localhost/roko?section=learning", edit: (fx) => { fx.learning = { ...learningAnswer(), lessons_first_try: lft }; } });
    try {
      const said = container.querySelector('[data-roko="kpi-why"]');
      return said ? text(said).replace(/^First tries: /, "").replace(/\.$/, "") : null;
    } finally {
      await cleanup();
    }
  };
  // roko's control arm withheld the lessons at random, and the tasks with one came out behind: said as it is.
  assert.equal(
    await driver({
      with: { passed: 5, of: 10, rate: 0.5 }, without: { passed: 13, of: 20, rate: 0.65 },
      design: "control_arm", comparable: true, difference: -0.15, note: "randomised: roko's control arm withheld the lessons from the tasks without",
    }),
    "with a lesson 5/10 passed first try, without 13/20 · −15 points · roko's control arm (randomised)"
  );
  // Under 5 tasks a side: no difference, the backend's words for why, both n's still.
  assert.equal(
    await driver({
      with: { passed: 3, of: 3, rate: 1 }, without: { passed: 1, of: 2, rate: 0.5 },
      design: "observational", comparable: false, difference: null, note: "too few tasks to compare yet (n = 3 and 2)",
    }),
    "with a lesson 3/3 passed first try, without 1/2 · too few tasks to compare yet (n = 3 and 2) · observational"
  );
  // Until roko says what its prompts carried, there is nothing to quote.
  assert.equal(await driver(null), null);
});

test("v3 Learning live: roko's essential and controller frames move the homeostat; a run's lessons land on the log", async () => {
  const env = await liveSetup({ url: "http://localhost/roko?section=learning", edit: (fx) => { fx.learning = learningAnswer(); } });
  const { container } = env;
  try {
    const socket = FakeSocket.all[0];
    await push(socket, { type: "hello", version: VERSION, overview: env.backend.fx.overview, hub: "open" });
    await push(socket, { type: "loop", run_id: null, ring: "L3", kind: "essential", text: "homeostat: pass rate 62% (≥ 70%) · out of bounds", data: { ev: "pass_rate", value: 0.62, bound: 0.7, inner: 0.8, state: "breached" }, ts: Date.now(), key: "ev:pass_rate:9" });
    await push(socket, { type: "loop", run_id: null, ring: "L3", kind: "controller", text: "M1 moved tier_floor: cheap -> mid", data: { episode_id: "m1-8", phase: "search", change: "tier_floor: cheap -> mid" }, ts: Date.now(), key: "m1:8" });
    const homeo = container.querySelector('[data-roko="homeostat"]');
    assert.equal(homeo.querySelector('[data-roko="gauge-pass_rate"]').getAttribute("data-out"), "true");
    assert.equal(text(homeo.querySelector('[data-roko="m1-line"]')), "It last changed the model tasks start on: cheap → mid · pass rate and passed but wrong are out of bounds");
    await push(socket, { type: "loop", run_id: IDS.live, ring: "L3", kind: "knowledge", text: "T2 kept a lesson: amounts are integer cents", data: {}, ts: Date.now(), key: "k:9" });
    const log = container.querySelector('[data-roko="learning-log"]');
    assert.match(text(log.firstChild), /◇ just now T2 kept a lesson: amounts are integer cents/);
    // A loop's health that came with no words is said from its data, as the desktop says it.
    await push(socket, { type: "loop", run_id: null, ring: "L4", kind: "loop_health", text: "", data: { loop_id: "L-route", state: "probation", h: 0.2 }, ts: Date.now() + 1, key: "lh:1" });
    assert.match(text(container.querySelector('[data-roko="learning-log"]').firstChild), /model routing: on probation · holdout 20%$/);
  } finally {
    await cleanup();
    env.restore();
  }
});

test("v3 Learning scope: the workspace counts every plan run roko recorded; where the numbers rest on less, it says so", async () => {
  const workspace = {
    ...learningAnswer(),
    scope: "workspace",
    scope_label: "every plan run in this workspace",
    coverage: { source: "run records", runs: 6, found: 31, lessons_from: 2, note: "lessons and what prompts carried are known for 2 of 6 runs, the ones Hermes started" },
    recorded_tasks: { tasks: 412, cost_usd: 3.2, cost_per_task_usd: 0.0078, typical_task_ms: 41000 },
  };
  window.localStorage.removeItem("roko-learning-scope");
  const { container, backend } = await setup({ url: "http://localhost/roko?section=learning", edit: (fx) => { fx.learning = (scope) => (scope === "workspace" ? workspace : learningAnswer()); } });
  try {
    assert.equal(container.querySelector('[data-roko="learning-scope-hermes"]').getAttribute("aria-pressed"), "true");
    assert.equal(container.querySelector('[data-roko="learning-coverage"]'), null, "nothing thinner to say");
    await click(container.querySelector('[data-roko="learning-scope-workspace"]'));
    assert.ok(backend.calls.some((c) => c.url === "/api/plugins/roko/learning?scope=workspace"));
    assert.equal(container.querySelector('[data-roko="learning-scope-workspace"]').getAttribute("title"), "every plan run in this workspace");
    // One foot line: where the numbers rest on less, then roko's own tally.
    assert.equal(text(container.querySelector('[data-roko="learning-recorded"]')), "roko recorded 412 tasks here · $3.20 in all · under $0.01 a task · 41s each");
    assert.equal(text(container.querySelector('[data-roko="learning-coverage"]')), "◌ lessons and what prompts carried are known for 2 of 6 runs, the ones Hermes started");
    assert.equal(container.querySelectorAll(".rk-learn-foot").length, 1);
    assert.match(text(container.querySelector('[data-roko="learning-window"]')), /^6 of 31 runs · \d+ days$/, "how many there were to read");
    assert.equal(window.localStorage.getItem("roko-learning-scope"), "workspace", "kept for the next visit");
    // The checks fold counts the same runs: Learning's switch decides, and the fold has none of its own.
    await openFold(container, "checks");
    assert.ok(backend.calls.some((c) => c.url === "/api/plugins/roko/insights?scope=workspace"), "the workspace's figures");
    assert.equal(container.querySelector('[data-roko="fold-checks"] [data-roko="insights-scope"] .rk-switch'), null, "one switch on the page");
  } finally {
    await cleanup();
    window.localStorage.removeItem("roko-learning-scope");
  }
  // A backend from before the scope answers for Hermes' runs whatever is asked: the page says so.
  window.localStorage.setItem("roko-learning-scope", "workspace");
  const old = await setup({ url: "http://localhost/roko?section=learning", edit: (fx) => { fx.learning = learningAnswer(); } });
  try {
    assert.equal(text(old.container.querySelector('[data-roko="learning-coverage"]')), "◌ this backend answers for runs started from Hermes only");
  } finally {
    await cleanup();
    window.localStorage.removeItem("roko-learning-scope");
  }
});

test("v3 Learning from an older backend: worked out from the runs this page has; what needs 0.6.0 says so", async () => {
  const { container } = await setup({ url: "http://localhost/roko?section=learning" });
  try {
    const page = container.querySelector('[data-roko="learning-overview"]');
    assert.match(text(page.querySelector('[data-roko="learning-scope"]')), /^this page's runs \d+ runs?( · \d+ days?)?$/);
    assert.match(text(page.querySelector('[data-roko="kpi-first"]')), /needs the plugin's learning view \(0\.6\.0\)/);
    assert.match(text(page.querySelector('[data-roko="lessons-paid"]')), /needs the plugin's learning view \(0\.6\.0\)/);
    assert.match(text(page.querySelector('[data-roko="homeostat"]')), /needs the plugin's learning view \(0\.6\.0\)/);
  } finally {
    await cleanup();
  }
});

test("v3 lessons: every lesson, folded, heads with the wall of lessons that paid off, then the search", async () => {
  const { container } = await setup({ url: "http://localhost/roko?section=knowledge", edit: (fx) => { fx.learning = learningAnswer(); } });
  try {
    const wall = container.querySelector('[data-roko="fold-lessons"] .roko-knowledge [data-roko="lesson-wall"]');
    assert.ok(wall, "the wall, above the search");
    assert.ok(wall.classList.contains("rk-panel"));
    assert.equal(wall.querySelectorAll('[data-roko="lesson-paid"]').length, 2);
    assert.ok(container.querySelector(".roko-knowledge .roko-search"));
  } finally {
    await cleanup();
  }
});

test("Learning says none of roko's own names: no run ids, climbs, homeostat, M1, false green or run states roko keeps to itself, on the page, its steady and loops folds or the lesson wall", async () => {
  const BANNED = /\b[0-9a-f]{8}-[0-9a-f]{4}-|\br\d-0000|\bclimb(s|ed)?\b|homeostat|\bM1\b|false green|\b(succeeded|unverified|cancelled)\b|\bL[0-4]\b/i;
  const { container } = await setup({ url: "http://localhost/roko?section=learning", edit: (fx) => { fx.learning = learningAnswer(); } });
  try {
    // The page as it opens (the steady and loops folds render in place; every lesson and the checks only once opened).
    const page = container.querySelector('[data-roko="learning-overview"]').cloneNode(true);
    page.querySelectorAll('[data-roko="fold-lessons"], [data-roko="fold-checks"]').forEach((fold) => fold.remove());
    const said = text(page);
    assert.match(said, /Lessons that paid off .* passed but wrong .* It is holding for now/, "the lessons and the steady fold are there");
    assert.doesNotMatch(said, BANNED);
    await openFold(container, "lessons");
    const wall = container.querySelector('[data-roko="lesson-wall"]');
    assert.ok(wall, "the lesson wall, opened");
    assert.doesNotMatch(text(wall), BANNED);
  } finally {
    await cleanup();
  }
});

test("P8 links: a criterion's own quote links its check, dashed and said so; a mori import lists under From mori", async () => {
  const { container } = await setup({
    url: "http://localhost/roko?section=plans&plan=" + IDS.plan,
    edit: (fx) => {
      sheetEdit(fx);
      Object.assign(fx.plan_details[IDS.plan].plan.tasks.find((t) => t.id === "T4"), {
        acceptance: [{ id: "AC1", text: "`python3 -m unittest tests.test_budgets` passes", checks: ["verify[0:test]"], linked_by: "quote", source_checks: [] }],
        verify: [{ name: "verify[0:test]", phase: "test", command: "python3 -m unittest tests.test_budgets", fail_msg: null, covers: [], expect: null }],
      });
      fx.plans.plans[0].imported_from = { kind: "mori", plan: "tally-budgets" };
    },
  });
  try {
    const by = container.querySelector('[data-roko-plantask="T4"] .rk-accept-by');
    assert.equal(by.getAttribute("data-linked"), "quote");
    assert.match(by.querySelector('[data-roko="check-chip"]').getAttribute("title"), /^the criterion names this check \(the plan declares no coverage\)\npython3 -m unittest tests\.test_budgets/);
    assert.equal(container.querySelector('[data-roko-plantask="T1"] .rk-accept-by').getAttribute("data-linked"), null, "covers says so itself");
    await click(container.querySelector('[data-roko="crumb-plans"]'));
    assert.deepEqual(planSections(container), ["Your plans", "From mori"]);
    assert.ok(container.querySelector('[data-roko-plans="from:mori"]').nextElementSibling.getAttribute("data-roko-plan"), "its plan under it");
  } finally {
    await cleanup();
  }
});

test("dogfood C: an ended run's Models panel says where its tasks passed; the today line says left only when it adds", async () => {
  const { container } = await setup({
    url: runUrl(IDS.multiwave),
    edit: (fx) => {
      const card = fx.runs[IDS.multiwave].run;
      card.ladder = LADDER;
      card.tasks.forEach((t) => { t.climb = [tryOn(1, t.task_id === "T5" ? "mid" : "cheap", t.task_id === "T5" ? "glm-4.7" : "gpt-oss-120b", "start", "passed")]; });
      fx.overview.spend = { ...fx.overview.spend, today_usd: 0, committed_usd: 0, left_usd: fx.overview.spend.max_day_usd };
    },
  });
  try {
    // The Models panel says where the tasks passed, in a sentence.
    assert.equal(text(container.querySelector('[data-roko="models-sentence"]')), "4 tasks passed on gpt-oss-120b, 1 on another model.");
    assert.doesNotMatch(text(container.querySelector('[data-roko="spend-words"]')), /left/, "nothing spent or held: left repeats the limit");
  } finally {
    await cleanup();
  }
});

test("dogfood C: the horizon keeps to the try that runs; words whose try is over read said, without the cursor", async () => {
  const env = await liveSetup({ url: runUrl(IDS.live), edit: climbEdit });
  const { container } = env;
  try {
    const socket = FakeSocket.all[0];
    await push(socket, { type: "hello", version: VERSION, overview: env.backend.fx.overview, hub: "open" });
    // T2 runs its third try on mid: a frame from its second try is old news.
    await push(socket, { type: "live", run_id: IDS.live, task_id: "T2", attempt: 2, kind: "text", text: "x", said: "the summary rounds to cents", ts: Date.now() });
    const t2 = () => [...container.querySelectorAll(".roko-now-item")].find((el) => text(el.querySelector(".roko-now-id")) === "Task 2");
    assert.doesNotMatch(text(t2()), /the summary rounds to cents/);
    await push(socket, { type: "live", run_id: IDS.live, task_id: "T2", attempt: 3, kind: "text", text: "x", said: "now **dollars** with `$`", ts: Date.now() });
    assert.match(text(t2()), /now dollars with \$/);
    assert.equal(t2().querySelector(".rk-ticker-step b").textContent, "dollars");
    // T1 passed: words from its try are past. (3 s after T2's: the strip holds words that grew within 2 s, P-37.)
    await push(socket, { type: "live", run_id: IDS.live, task_id: "T1", attempt: 1, kind: "text", text: "x", said: "BudgetStore is done.", ts: Date.now() + 3000 });
    const words = container.querySelector('[data-roko="stream-words"]');
    assert.equal(words.getAttribute("data-past"), "true");
    assert.equal(text(words.querySelector(".rk-words-who")), "Task 1 said");
    assert.equal(words.querySelector(".rk-cursor"), null);
  } finally {
    await cleanup();
    env.restore();
  }
});

test("plan writing: what became of the checks the spec states, in the agreed words: kept, shallow, dropped and missing", async () => {
  const gen = "44444444-5555-4666-8777-888888888888";
  const sourceChecks = {
    total: 4, kept: 1, shallow: 1, dropped: 1, missing: 1, regenerated: true,
    checks: [
      { id: "SC1", check: "`tally report --json` prints valid JSON", status: "kept", task: "T1", criterion: "AC1", reason: null },
      { id: "SC2", check: "the JSON has a `categories` list", status: "shallow", task: "T1", criterion: "AC2", reason: "grep -q categories tally/report.py" },
      { id: "SC3", check: "the output reads well to a person", status: "dropped", task: null, criterion: null, reason: "needs a person to judge it" },
      { id: "SC4", check: "an empty ledger prints **[]**", status: "missing", task: null, criterion: null, reason: null },
    ],
  };
  const row = { run_id: gen, kind: "plan_generate", label: "A --json flag", plan_id: IDS.plan, state: "succeeded", active: false, cost_usd: 0.01, max_usd: null, started_at: new Date().toISOString() };
  const card = (extra) => ({ ok: true, run: { ...row, verdict: "succeeded", task_count: 5, tasks: [], gates: {}, milestones: [], waiting: [], ...extra } });
  const { container } = await setup({ url: runUrl(gen), edit: (fx) => { fx.overview.runs.unshift({ ...row }); fx.runs[gen] = card({ source_checks: sourceChecks }); } });
  try {
    const sc = container.querySelector('[data-roko="source-checks"]');
    assert.equal(sc.tagName, "DETAILS");
    assert.equal(sc.open, true, "open: a check is missing");
    const line = sc.querySelector('[data-roko="source-checks-line"]');
    assert.equal(text(line), "1 of 4 kept · 1 shallow · 1 dropped · 1 missing · asked again");
    assert.equal(line.getAttribute("data-missing"), "true", "orange");
    const rows = [...sc.querySelectorAll("li")];
    assert.deepEqual(rows.map((li) => li.getAttribute("data-status")), ["kept", "shallow", "dropped", "missing"]);
    assert.equal(text(rows[0]), "SC1 kept `tally report --json` prints valid JSON Task 1 AC1");
    assert.equal(text(rows[1]), "SC2 shallow the JSON has a `categories` list Task 1 AC2 only: grep -q categories tally/report.py");
    assert.equal(text(rows[2]), "SC3 dropped the output reads well to a person why: needs a person to judge it");
    assert.equal(text(rows[3]), "SC4 missing an empty ledger prints **[]**");
    assert.equal(rows[0].querySelector(".rk-srcchecks-what").getAttribute("title"), "`tally report --json` prints valid JSON", "clamped to 3 lines, whole in the title");
    assert.equal(sc.querySelectorAll("code, b").length, 0, "the spec's words stay text");
  } finally {
    await cleanup();
  }
  // Every check kept: one quiet line, folded.
  const all = await setup({ url: runUrl(gen), edit: (fx) => { fx.overview.runs.unshift({ ...row }); fx.runs[gen] = card({ source_checks: { total: 8, kept: 8, shallow: 0, dropped: 0, missing: 0, regenerated: false, checks: [] } }); } });
  try {
    const sc = all.container.querySelector('[data-roko="source-checks"]');
    assert.equal(sc.open, false);
    assert.equal(text(sc.querySelector('[data-roko="source-checks-line"]')), "Your spec states 8 checks · 8 kept");
    assert.equal(sc.querySelector('[data-roko="source-checks-line"]').getAttribute("data-missing"), null);
  } finally {
    await cleanup();
  }
  // A mixed line leaves a 0 count out (the lead's example).
  const mixed = await setup({ url: runUrl(gen), edit: (fx) => { fx.overview.runs.unshift({ ...row }); fx.runs[gen] = card({ source_checks: { total: 6, kept: 5, shallow: 0, dropped: 0, missing: 1, regenerated: false, checks: [] } }); } });
  try {
    assert.equal(text(mixed.container.querySelector('[data-roko="source-checks-line"]')), "5 of 6 kept · 1 missing");
  } finally {
    await cleanup();
  }
  // An older roko reports none: nothing shows.
  const older = await setup({ url: runUrl(gen), edit: (fx) => { fx.overview.runs.unshift({ ...row }); fx.runs[gen] = card({ source_checks: null }); } });
  try {
    assert.equal(older.container.querySelector('[data-roko="source-checks"]'), null);
  } finally {
    await cleanup();
  }
});

test("plan sheet: what became of its spec's checks, from the plan's newest plan writing; nothing without one", async () => {
  const older = "55555555-6666-4777-8888-999999999999";
  const newer = "66666666-7777-4888-8999-aaaaaaaaaaaa";
  const at = (ago) => new Date(Date.now() - ago).toISOString();
  const writing = (id, started, sc) => ({
    row: { run_id: id, kind: "plan_generate", label: "Per-category budgets", plan_id: IDS.plan, state: "succeeded", active: false, cost_usd: 0.01, max_usd: null, started_at: started },
    card: { ok: true, run: { run_id: id, kind: "plan_generate", label: "Per-category budgets", plan_id: IDS.plan, state: "succeeded", verdict: "succeeded", active: false, started_at: started, task_count: 5, tasks: [], gates: {}, milestones: [], waiting: [], source_checks: sc } },
  });
  const first = writing(older, at(7200000), { total: 2, kept: 2, shallow: 0, dropped: 0, missing: 0, regenerated: false, checks: [] });
  const latest = writing(newer, at(600000), {
    total: 3, kept: 2, shallow: 0, dropped: 0, missing: 1, regenerated: true,
    checks: [
      { id: "SC1", check: "a budget per category, in integer cents", status: "kept", task: "T1", criterion: "AC1", reason: null },
      { id: "SC2", check: "the report flags a category over its budget", status: "kept", task: "T2", criterion: "AC1", reason: null },
      { id: "SC3", check: "a category exactly at its limit is not flagged", status: "missing", task: null, criterion: null, reason: null },
    ],
  });
  const { container, backend } = await setup({
    url: "http://localhost/roko?section=plans&plan=" + IDS.plan,
    edit: (fx) => {
      fx.overview.runs.push(first.row, latest.row);
      fx.runs[older] = first.card;
      fx.runs[newer] = latest.card;
    },
  });
  try {
    const plan = container.querySelector('[data-roko="plan"]');
    const sc = plan.querySelector('[data-roko="source-checks"]');
    assert.ok(sc, "under the plan's head");
    assert.ok(sc.previousElementSibling.classList.contains("rk-runhead"));
    assert.equal(text(sc.querySelector('[data-roko="source-checks-line"]')), "2 of 3 kept · 1 missing · asked again");
    assert.equal(sc.open, true);
    assert.ok(backend.calls.some((c) => c.url === "/api/plugins/roko/runs/" + newer), "the newest plan writing's card");
    assert.ok(!backend.calls.some((c) => c.url === "/api/plugins/roko/runs/" + older), "not an older one");
  } finally {
    await cleanup();
  }
  const none = await setup({ url: "http://localhost/roko?section=plans&plan=" + IDS.plan });
  try {
    assert.ok(none.container.querySelector('[data-roko="plan"]'));
    assert.equal(none.container.querySelector('[data-roko="source-checks"]'), null, "no plan writing wrote it: nothing");
  } finally {
    await cleanup();
  }
});

test("a11y: the stream's log is quiet; a polite status says its newest row at most every 2 s, the latest winning (spec v3 §8)", async () => {
  const env = await liveSetup({ url: runUrl(IDS.live), edit: climbEdit });
  const { container } = env;
  const realSet = window.setTimeout;
  const held = [];
  let observer = null;
  try {
    const socket = FakeSocket.all[0];
    await push(socket, { type: "hello", version: VERSION, overview: env.backend.fx.overview, hub: "open" });
    const log = container.querySelector('[data-roko="stream-lines"]');
    assert.equal(log.getAttribute("role"), "log");
    assert.equal(log.getAttribute("aria-live"), "off", "a row is not an announcement of its own");
    const status = container.querySelector('[data-roko="stream-say"]');
    assert.ok(status, "the stream's status");
    assert.equal(status.getAttribute("role"), "status");
    assert.ok(status.classList.contains("rk-sr"), "visually hidden");
    // The 2 s windows wait until the test says 2 s went by; every other timer runs as it would.
    window.setTimeout = (fn, ms, ...rest) => (ms === 2000 ? held.push(fn) : realSet(fn, ms, ...rest));
    const said = [];
    observer = new window.MutationObserver(() => said.push(status.textContent));
    observer.observe(status, { childList: true, characterData: true, subtree: true });
    const tool = (name, target) => ({ type: "live", run_id: IDS.live, task_id: "T2", attempt: 3, kind: "tool", tool: name, target, ts: Date.now() });
    await push(socket, tool("Read", "tally/cli.py"));
    await push(socket, tool("Edit", "tally/cli.py"));
    await push(socket, tool("Read", "tests/test_cli.py"));
    await push(socket, tool("Edit", "tests/test_cli.py"));
    assert.equal(said.length, 1, "one announcement in the first 2 s: " + said.join(" | "));
    assert.equal(said[0], "Task 2 Read tally/cli.py");
    // 2 s later the newest row is said, once; the ones between are not read out.
    await act(async () => { held.splice(0).forEach((fn) => fn()); });
    await settle();
    assert.deepEqual(said.slice(1), ["Task 2 Edit tests/test_cli.py"]);
    // Nothing new by the end of the next window: nothing more is said.
    await act(async () => { held.splice(0).forEach((fn) => fn()); });
    await settle();
    assert.equal(said.length, 2);
  } finally {
    if (observer) observer.disconnect();
    window.setTimeout = realSet;
    await cleanup();
    env.restore();
  }
});

test("plan sheet: what a task must also do that no check proves sits under its checked criteria, in dim ink; the basis as roko gives it", async () => {
  const edit = (basis) => (fx) => {
    sheetEdit(fx);
    const plan = fx.plan_details[IDS.plan].plan;
    Object.assign(plan.estimate, { likely_usd: 0.1, worst_usd: 0.2, cap_usd: 1, unpriced_tasks: [], confidence: "medium" });
    plan.tasks.forEach((t, i) => { t.estimate = { likely_usd: 0.02, likely_secs: 30, worst_usd: 0.04, worst_rungs: [], first_try_rate: null, basis: basis[i % basis.length], samples: 4 }; });
    Object.assign(plan.tasks.find((t) => t.id === "T1"), {
      also_required: ["Keep the CLI's exit codes as they are.", "Mention the flag in **README.md**."],
      also_required_judged_in_review: true,
    });
  };
  const { container } = await setup({ url: "http://localhost/roko?section=plans&plan=" + IDS.plan, edit: edit(["same_role_and_tier", "same_tier"]) });
  try {
    const t1 = container.querySelector('[data-roko-plantask="T1"]');
    const also = t1.querySelector('[data-roko="also-required"]');
    assert.equal(also.previousElementSibling.getAttribute("data-roko"), "acceptance", "under the checked criteria");
    assert.equal(text(also.querySelector(".rk-also-head")), "also required · not checked automatically · the review task judges these");
    assert.deepEqual([...also.querySelectorAll("li")].map((li) => li.textContent), ["Keep the CLI's exit codes as they are.", "Mention the flag in **README.md**."], "as text");
    assert.equal(container.querySelector('[data-roko-plantask="T2"] [data-roko="also-required"]'), null, "nothing without a list");
    assert.equal(text(container.querySelector('[data-roko="plan-estimate"]')), "likely $0.10 · worst $0.20 · cap $1.00 · roko's estimate, from similar past tries");
  } finally {
    await cleanup();
  }
  for (const [basis, said] of [[["any_task", "same_tier"], "from past tries of other tasks"], [["defaults"], "from its defaults"], [["same_role"], "from past tries"]]) {
    const other = await setup({ url: "http://localhost/roko?section=plans&plan=" + IDS.plan, edit: edit(basis) });
    try {
      assert.match(text(other.container.querySelector('[data-roko="plan-estimate"]')), new RegExp("roko's estimate, " + said + "$"));
    } finally {
      await cleanup();
    }
  }
});

test("also_required in the task detail too: the block lifted out of the description shows beside it; a plan with no checked criteria still lists its tasks", async () => {
  const { container } = await setup({
    url: "http://localhost/roko?section=plans&plan=" + IDS.plan,
    edit: (fx) => {
      sheetEdit(fx);
      const t1 = fx.plan_details[IDS.plan].plan.tasks.find((t) => t.id === "T1");
      Object.assign(t1, { acceptance: [], verify: [], description: "Add a BudgetStore.", also_required: ["Keep the CLI's exit codes as they are."], also_required_judged_in_review: false });
      fx.plan_details[IDS.plan].plan.tasks.forEach((t) => { t.acceptance = []; });
    },
  });
  try {
    const list = container.querySelector('[data-roko="plan-tasks"]');
    assert.ok(list.querySelector('[data-roko-plantask="T1"]'), "the task list, with no checked criteria anywhere");
    assert.equal(text(list.querySelector('[data-roko-plantask="T1"] .rk-also-head')), "also required · not checked automatically");
    // The task's detail, where its description shows.
    await click(container.querySelector('[data-roko-node="T1"]'));
    const detail = container.querySelector('aside.roko-inspector[aria-label="Task 1"]');
    assert.match(text(detail), /Add a BudgetStore\./);
    assert.deepEqual([...detail.querySelectorAll('[data-roko="also-required"] li')].map((li) => li.textContent), ["Keep the CLI's exit codes as they are."]);
  } finally {
    await cleanup();
  }
});

test("L5: a mori import lists under From mori after the person's own plans, with no row tag and no id", async () => {
  const { container } = await setup({
    url: "http://localhost/roko?section=plans",
    edit: (fx) => {
      const rows = fx.plans.plans;
      rows[0].imported_from = { kind: "mori", plan: "tally-budgets" };
      rows[0].title = "Per-category budgets";
    },
  });
  try {
    const heads = planSections(container);
    assert.equal(heads[heads.length - 1], "From mori", "after the person's own plans: " + heads.join(", "));
    const row = container.querySelector('[data-roko-plans="from:mori"]').nextElementSibling;
    assert.equal(row.querySelector(".rk-tag"), null, "the section says where it came from");
    assert.equal(text(row.querySelector(".rk-line-title")).indexOf(row.getAttribute("data-roko-plan")), -1, "its title, never its id");
  } finally {
    await cleanup();
  }
});

test("F11: a source check a step covers but cannot pass as written says so, in orange, with why", async () => {
  const sc = {
    total: 3, kept: 1, cannot_run: 1, shallow: 0, dropped: 0, missing: 1, regenerated: false,
    checks: [
      { id: "SC1", check: "budgets round-trip", status: "kept", task: "T1", criterion: "AC1", reason: null },
      { id: "SC2", check: "the low-pass filter passes lows", status: "cannot_run", task: "T2", criterion: "AC1", reason: "`pytest` is not installed" },
      { id: "SC3", check: "the report flags a category over budget", status: "missing", task: null, criterion: null, reason: null },
    ],
  };
  const gen = "55555555-6666-4777-8888-999999999999";
  const row = { run_id: gen, kind: "plan_generate", label: "A synth", plan_id: IDS.plan, state: "succeeded", active: false, cost_usd: 0.01, max_usd: null, started_at: new Date().toISOString() };
  const card = { ok: true, run: { ...row, verdict: "succeeded", task_count: 5, tasks: [], gates: {}, milestones: [], waiting: [], source_checks: sc } };
  const { container } = await setup({ url: runUrl(gen), edit: (fx) => { fx.overview.runs.unshift({ ...row }); fx.runs[gen] = card; } });
  try {
    const block = container.querySelector('[data-roko="source-checks"]');
    assert.equal(block.open, true, "open: a check cannot run");
    const line = block.querySelector('[data-roko="source-checks-line"]');
    assert.equal(text(line), "1 of 3 kept · 1 cannot run · 1 missing");
    assert.equal(line.getAttribute("data-missing"), "true", "in orange");
    const row = block.querySelector('li[data-status="cannot_run"]');
    assert.equal(text(row.querySelector(".rk-srcchecks-st")), "cannot run");
    assert.equal(text(row.querySelector(".rk-srcchecks-why")), "why: `pytest` is not installed");
  } finally {
    await cleanup();
  }
});

test("a11y F9: no live region re-reads a ticking clock; the chat and sessions strips say their state, not their clocks", async () => {
  const page = await setup({ url: runUrl(IDS.live), edit: climbEdit });
  try {
    await mount(page.registry.slots.find((s) => s.slot === "chat:top").component, { url: runUrl(IDS.live) });
    const doc = window.document;
    const LIVE = '[role="status"],[role="alert"],[role="log"],[aria-live="polite"],[aria-live="assertive"]';
    const QUIET = '[aria-live="off"],[role="marquee"],[role="timer"]';
    // What a screen reader re-reads when it changes: each live region's text, less what sits in a quiet part.
    const heard = () =>
      [...doc.querySelectorAll(LIVE)]
        .filter((el) => !el.closest(QUIET))
        .map((el) => {
          const parts = [];
          const walker = doc.createTreeWalker(el, 4);
          for (let n = walker.nextNode(); n; n = walker.nextNode()) if (!n.parentElement.closest(QUIET)) parts.push(n.nodeValue);
          return parts.join(" ").replace(/\s+/g, " ").trim();
        });
    const before = heard();
    assert.ok(doc.querySelector('[data-roko="ticker"] .roko-now-clock'), "a running task's stopwatch on the horizon");
    assert.ok(doc.querySelector('[data-roko="chatstrip"]'), "the chat strip");
    // No new data for over 2 s: the stopwatches tick on screen, and nothing a screen reader hears changes.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2300)); });
    await settle();
    assert.deepEqual(heard(), before);
    // The horizon is a marquee; the chat card says its state, not its clock or its spend, through a hidden status.
    assert.equal(doc.querySelector('[data-roko="ticker"]').getAttribute("role"), "marquee");
    const chat = doc.querySelector('[data-roko="chatstrip"]');
    assert.equal(chat.getAttribute("role"), null);
    const said = chat.querySelector('[data-roko="chatstrip-say"]');
    assert.equal(said.getAttribute("role"), "status");
    assert.ok(said.classList.contains("rk-sr"), "visually hidden");
    assert.match(said.textContent, /^roko: (running|needs you) · /);
    assert.doesNotMatch(said.textContent, /\d:\d\d|\$/, "no clock, no money");
  } finally {
    await cleanup();
  }
  // The sessions banner (off the roko page) does the same.
  const registry = loadBundle(makeBackend());
  try {
    const banner = await mount(registry.slots.find((s) => s.slot === "sessions:top").component, { url: "http://localhost/sessions" });
    const strip = banner.container.querySelector('[data-roko="banner"]');
    assert.equal(strip.getAttribute("role"), null);
    assert.match(strip.querySelector('[data-roko="banner-say"]').textContent, /^roko: (running|needs you) · [^\d$]+$/, "its state and its run, no clock, no money");
  } finally {
    await cleanup();
  }
});

// --------------------------------------------------------------------------------
// v7 (plugin-wow): the desktop's Ladder at scale and honest tries, on the dashboard (#9 parity)
// --------------------------------------------------------------------------------

/** A try roko charged to the provider (a 429): not the agent's, so never a ✕ and never toward a climb. */
function refusedTry(attempt, rung) {
  return tryOn(attempt, rung, "gpt-oss-120b", attempt === 1 ? "start" : "retry", "failed", { blame: "infra", verdict: "provider_error", why: "the provider failed" });
}

test("v7 Ladder: a try the provider refused is ∿, never a ✕: on the ladder, the pads, and why a task climbed", async () => {
  const edit = (fx) => {
    climbEdit(fx);
    const card = fx.runs[IDS.live].run;
    const task = (id) => card.tasks.find((t) => t.task_id === id);
    const failed = { failed_check: "verify[0:test]", key_line: "AssertionError" };
    const failover = { model: "gpt-oss-120b", provider: "cerebras", class: "rate_limited", why: "rate limited" };
    task("T1").climb = [refusedTry(1, "cheap"), tryOn(2, "cheap", "gpt-oss-120b", "failover", "passed", { failover })];
    task("T2").climb = [refusedTry(1, "cheap"), tryOn(2, "cheap", "gpt-oss-120b", "retry", "failed", failed), tryOn(3, "cheap", "gpt-oss-120b", "retry", "failed", failed), tryOn(4, "mid", "glm-4.7", "climb", "running")];
    const answer = fx.events[IDS.live];
    const top = Math.max(...answer.events.map((e) => e.cursor));
    answer.events.push({ cursor: top + 1, type: "route_decided", group: "loop", task_id: "T2", ts_millis: Date.now() - 20000, model: "glm-4.7", attempt: 4, loop: "route", text: "T2 attempt 4 → glm-4.7" });
    answer.next_cursor = top + 2;
  };
  const { container } = await setup({ url: runUrl(IDS.live), edit });
  try {
    const ladder = container.querySelector('[data-roko="ladder"]');
    const cheap = ladder.querySelector('[data-rung="cheap"]');
    // T2's ghost on cheap is its two failed tries; the refused one is a ∿ beside it, and T1 has no ghost at all.
    assert.deepEqual([...cheap.querySelectorAll('.rk-tok[data-state="ghost"]')].map((g) => text(g)), ["✕✕"]);
    assert.equal(text(ladder.querySelector('[data-roko-refused="T2"]')), "∿");
    // T1 passed on cheap after the provider refused its first try: the ∿ beside its token, never a ✕.
    assert.deepEqual([...ladder.querySelectorAll('[data-roko-marks="T1"] i')].map((i) => i.getAttribute("data-mark")), ["i"]);
    assert.match(cheap.getAttribute("aria-label"), /T1 passed, after a provider refused 1 try/);
    assert.match(cheap.getAttribute("aria-label"), /T2 failed 2 times here and climbed/);
    assert.match(cheap.getAttribute("aria-label"), /T2: a provider refused 1 try here, not counted/);
    assert.match(text(ladder.querySelector(".rk-lad-foot")), /∿ provider refused/);
    // The pads say the same: ∿ for the refused try, also under a task that passed.
    const lives = (id) => [...node(container, id).querySelectorAll(".rk-lives i")].map((i) => i.getAttribute("data-life"));
    assert.deepEqual(lives("T1"), ["i", "p"]);
    assert.deepEqual(lives("T2"), ["i", "x", "x", "r"]);
    assert.equal(node(container, "T2").querySelector(".rk-lives").getAttribute("aria-label"), "4 tries: 2 failed, 1 refused by a provider");
    // Why it climbed counts its own failed tries, not the provider's.
    const rows = [...container.querySelectorAll('[data-roko="stream"] .rk-ln')].map((l) => text(l)).join(" | ");
    assert.match(rows, /02 ▲ up to mid · glm-4\.7 · 2 failed checks on cheap/);
  } finally {
    await cleanup();
  }
});

test("v7 Ladder: a task that passed on strong after failing there shows that ✕ before its ✓", async () => {
  const edit = (fx) => {
    climbEdit(fx);
    const card = fx.runs[IDS.live].run;
    const task = card.tasks.find((t) => t.task_id === "T2");
    const failed = { failed_check: "verify[0:test]", key_line: "AssertionError" };
    task.outcome = "passed";
    task.climb = [
      tryOn(1, "cheap", "gpt-oss-120b", "start", "failed", failed), tryOn(2, "cheap", "gpt-oss-120b", "retry", "failed", failed),
      tryOn(3, "mid", "glm-4.7", "climb", "failed", failed), tryOn(4, "mid", "glm-4.7", "retry", "failed", failed),
      tryOn(5, "strong", "gpt-5.4-mini", "climb", "failed", failed), tryOn(6, "strong", "gpt-5.4-mini", "retry", "passed"),
    ];
    task.lives = { rung: "strong", used: 2, of: 2 };
  };
  const { container } = await setup({ url: runUrl(IDS.live), edit });
  try {
    const ladder = container.querySelector('[data-roko="ladder"]');
    const rung = (name) => ladder.querySelector(`[data-rung="${name}"]`);
    assert.equal(rung("strong").querySelector('[data-roko-token="T2"]').getAttribute("data-state"), "passed");
    assert.deepEqual([...ladder.querySelectorAll('[data-roko-marks="T2"] i')].map((i) => i.getAttribute("data-mark")), ["x"]);
    assert.equal(text(rung("mid").querySelector('.rk-tok[data-state="ghost"]')), "✕✕");
    assert.match(rung("strong").getAttribute("aria-label"), /T2 passed, after 1 failed try here/);
  } finally {
    await cleanup();
  }
});

test("v7 Ladder: a long phase fits: eight tasks keep their labels; fourteen go dense, ids in titles; thirty are dots", async () => {
  const many = (n, running) => (fx) => {
    climbEdit(fx);
    const card = fx.runs[IDS.live].run;
    card.tasks = Array.from({ length: n }, (_, i) => ({
      task_id: "T" + (i + 1), title: "Task " + (i + 1), outcome: i < running ? "passed" : i === running ? "running" : "pending",
      attempts: i <= running ? 1 : 0, gates: [], depends_on: [], lives: null,
      climb: i < running ? [tryOn(1, "cheap", "gpt-oss-120b", "start", "passed")] : i === running ? [tryOn(1, "cheap", "gpt-oss-120b", "start", "running")] : [],
    }));
    if (n === 14) card.tasks[3].climb = [tryOn(1, "cheap", "gpt-oss-120b", "start", "failed", { failed_check: "verify[0:test]" }), tryOn(2, "cheap", "gpt-oss-120b", "retry", "passed")];
  };
  for (const [n, running, density] of [[8, 3, null], [14, 9, "dense"], [30, 20, "dots"]]) {
    const { container } = await setup({ url: runUrl(IDS.live), edit: many(n, running) });
    try {
      const ladder = container.querySelector('[data-roko="ladder"]');
      assert.equal(ladder.getAttribute("data-density"), density, n + " tasks");
      assert.equal(ladder.querySelectorAll(".rk-tok:not(.rk-tok-echo)").length, n);
      const left = [...ladder.querySelectorAll("[data-roko-token]")].map((t) => t.style.left);
      assert.equal(new Set(left).size, n, "every task keeps its own column");
      if (density === null) assert.equal(text(ladder.querySelector('[data-roko-token="T2"]')), "T2");
      if (density === "dense") {
        assert.equal(text(ladder.querySelector('[data-roko-token="T3"]')), "");
        assert.match(ladder.querySelector('[data-roko-token="T3"]').getAttribute("title"), /T3 passed/);
        assert.equal(text(ladder.querySelector('[data-roko-token="T10"]')), "T10", "the running one keeps its name");
        assert.equal(ladder.querySelector('[data-roko-token="T4"]').getAttribute("data-marked"), "x");
        assert.match(ladder.querySelector('[data-roko-token="T4"]').getAttribute("title"), /T4 passed, after 1 failed try here/);
      }
    } finally {
      await cleanup();
    }
  }
});

// --------------------------------------------------------------------------------
// v7 (plugin-wow): build glass on the dashboard (#9 parity): a C++ check read as an instrument
// --------------------------------------------------------------------------------

const GLASS_BUILD = [
  "$ cmake --preset core && cmake --build --preset core --target spec_p3_tone",
  "-- Configuring done (1.8s)",
  "[  9%] Building CXX object core/CMakeFiles/undertow_core.dir/src/Version.cpp.o",
  "[ 27%] Building CXX object core/CMakeFiles/undertow_core.dir/src/SineOsc.cpp.o",
  "[ 45%] Building CXX object core/CMakeFiles/undertow_core.dir/src/Oversampler.cpp.o",
];
const GLASS_ERROR = [
  "[ 61%] Building CXX object core/CMakeFiles/undertow_core.dir/src/RumbleTone.cpp.o",
  "~/dev/undertow/core/src/RumbleTone.cpp:84:23: error: no member named 'tanhApprox' in namespace 'undertow::dsp'",
  "   84 |     const float y = dsp::tanhApprox(g * (x - k * s4));",
  "      |                     ~~~~~^",
  "~/dev/undertow/core/src/RumbleTone.cpp:91:9: warning: unused variable 'drive' [-Wunused-variable]",
  "1 warning and 1 error generated.",
];

/** The live run with T2 checking verify[0:build] on mid (its climb from climbEdit). */
function checkingEdit(tail) {
  return (fx) => {
    climbEdit(fx);
    const task = fx.runs[IDS.live].run.tasks.find((t) => t.task_id === "T2");
    task.step = "check";
    task.step_detail = "verify[0:build]";
    task.step_since = new Date(Date.now() - 20000).toISOString();
    if (tail) task.check_tail = tail;
  };
}

test("v7 build glass: a build shows how far it is and what compiles now, on the stream, the pad and the horizon; its error is a hazard card", async () => {
  const env = await liveSetup({ url: runUrl(IDS.live), edit: checkingEdit(null) });
  const { container } = env;
  try {
    const socket = FakeSocket.all[0];
    await push(socket, { type: "hello", version: VERSION, overview: env.backend.fx.overview, hub: "open" });
    const line = (lines) => push(socket, { type: "live", run_id: IDS.live, task_id: "T2", attempt: 3, kind: "check", gate: "verify[0:build]", stream: "stdout", line: lines[lines.length - 1], tail: lines.slice(-12), ts: Date.now() });
    // Two items, the second with only the newest lines: the glass reads the whole check as the window heard it.
    await line(GLASS_BUILD.slice(0, 4));
    await line(GLASS_BUILD);
    const stream = container.querySelector('[data-roko="stream"]');
    const meter = stream.querySelector('[data-roko="build-meter"]');
    assert.ok(meter, "a build meter in the stream");
    assert.match(text(meter), /built 45%/);
    assert.match(text(meter), /compiling Oversampler\.cpp/);
    assert.match(text(meter), /3 units · 0 warnings/);
    // Under the meter the raw lines are only the newest three, and none the meter already says.
    const raw = [...stream.querySelectorAll('[data-roko="stream-check"] span')].map((s) => s.textContent);
    assert.ok(raw.length <= 3 && !raw.some((l) => /\[\s*\d+%\]/.test(l)), JSON.stringify(raw));
    const pad = node(container, "T2").querySelector('[data-roko="pad-check-T2"]');
    assert.equal(text(pad), "45%");
    assert.equal(pad.getAttribute("title"), "building 45% · Oversampler.cpp");
    assert.match(text(container.querySelector('[data-roko="ticker"]')), /building 45% · Oversampler\.cpp/);

    // The compiler stops: a hazard card with where, what, the source line and its caret.
    await line([...GLASS_BUILD, ...GLASS_ERROR]);
    const hazard = stream.querySelector('[data-roko="build-hazard"]');
    assert.ok(hazard, "a hazard card");
    assert.equal(text(hazard.querySelector(".rk-hz-loc")), "core/src/RumbleTone.cpp :84:23");
    assert.equal(text(hazard.querySelector(".rk-hz-msg")), "error: no member named 'tanhApprox' in namespace 'undertow::dsp'");
    // The source line loses only the indent it shares with its caret line: the caret still points where it did.
    assert.match(hazard.querySelector(".rk-hz-code").textContent, /84 │ const float y = dsp::tanhApprox/);
    assert.match(hazard.querySelector(".rk-hz-caret").textContent, /\^/);
    assert.match(text(hazard), /1 warning/);
    assert.match(text(container.querySelector('[data-roko="ticker"]')), /✕ RumbleTone\.cpp:84 no member named 'tanhApprox'/);
  } finally {
    await cleanup();
    env.restore();
  }
});

test("v7 build glass: tests read as pips with the first failure, what it saw and what the spec logged, in the stream and the inspector", async () => {
  const W = "~/dev/undertow/.roko/worktrees/attempt-afa08b39d03a16f8ee04";
  const doctest = [
    `${W}/tests/spec/p0/plugin_test.cpp:147:`,
    "TEST CASE:  P0.11 processBlock is finite, never allocates, and hands host parameter changes to the engine",
    "",
    `${W}/tests/spec/p0/plugin_test.cpp:183: ERROR: CHECK( allocations == 0 ) is NOT correct!`,
    "  values: CHECK( 11400 == 0 )",
    "  logged: 11400 heap allocations inside processBlock: preallocate the MIDI event array and everything else in prepareToPlay",
    "",
    "[doctest] test cases:   6 |   5 passed | 1 failed | 0 skipped",
    "[doctest] Status: FAILURE!",
  ];
  const edit = (fx) => {
    climbEdit(fx);
    const task = fx.runs[IDS.live].run.tasks.find((t) => t.task_id === "T2");
    task.climb[1] = { ...task.climb[1], failed_check: "verify[1:test]" };
    task.check_tail = { attempt: 2, gate: "verify[1:test]", passed: false, command: "tools/spec.sh 0 plugin", exit_code: 1, duration_ms: 9000, lines: doctest, live: false };
    const answer = fx.events[IDS.live];
    const top = Math.max(...answer.events.map((e) => e.cursor));
    answer.events.push({ cursor: top + 1, type: "gate_result", group: "gate", task_id: "T2", attempt: 2, ts_millis: Date.now() - 50000, passed: false, gate: "verify[1:test]", text: "T2 gate verify[1:test] did not pass" });
    answer.next_cursor = top + 2;
  };
  const { container } = await setup({ url: runUrl(IDS.live), edit });
  try {
    const pips = container.querySelector('[data-roko="stream"] [data-roko="test-pips"]');
    assert.ok(pips, "test pips under the failed check");
    assert.equal(text(pips.querySelector(".rk-tp-count")), "✕ 5 of 6 passed");
    assert.match(text(pips.querySelector(".rk-tp-fail b")), /^✕ P0\.11 processBlock is finite, never allocates/);
    assert.equal(text(pips.querySelector(".rk-tp-fail small")), "p0/plugin_test.cpp:183");
    assert.equal(text(pips.querySelector(".rk-tp-expr")), "CHECK( allocations == 0 ) · saw CHECK( 11400 == 0 )");
    assert.equal(text(pips.querySelector(".rk-tp-logged")), "11400 heap allocations inside processBlock: preallocate the MIDI event array and everything else in prepareToPlay");
    // The task's inspector reads the same check.
    await click(node(container, "T2"));
    const inspector = container.querySelector('[data-roko-inspector="T2"]');
    assert.equal(text(inspector.querySelector('[data-roko="test-pips"] .rk-tp-count')), "✕ 5 of 6 passed");
  } finally {
    await cleanup();
  }
});

test("v7 build glass: CMake's own errors are hazard cards (the real P0 run's presets error, not the JSON line it quoted)", async () => {
  const W = "~/dev/undertow/.roko/worktrees/attempt-afa08b39d03a16f8ee04";
  const presets = [
    "spec: FAIL spec_p0_plugin: `cmake --preset plugin` failed (full log: build/spec-logs/plugin-configure.log):",
    `CMake Error: Could not read presets from ${W}:`,
    'Error: @34,24: Invalid extra field "noTestsAction" in Preset',
    '      "noTestsAction": "error"',
    "                       ^",
    'Error: @33,26: Invalid extra field "outputOnFailure" in Preset',
    '      "outputOnFailure": true,',
  ];
  const edit = (fx) => {
    climbEdit(fx);
    const task = fx.runs[IDS.live].run.tasks.find((t) => t.task_id === "T2");
    task.climb[1] = { ...task.climb[1], failed_check: "verify[0:test]" };
    task.check_tail = { attempt: 2, gate: "verify[0:test]", passed: false, command: "tools/spec.sh 0 plugin", exit_code: 1, duration_ms: 3000, lines: presets, live: false };
    const answer = fx.events[IDS.live];
    const top = Math.max(...answer.events.map((e) => e.cursor));
    answer.events.push({ cursor: top + 1, type: "gate_result", group: "gate", task_id: "T2", attempt: 2, ts_millis: Date.now() - 50000, passed: false, gate: "verify[0:test]", text: "T2 gate verify[0:test] did not pass" });
    answer.next_cursor = top + 2;
  };
  const { container } = await setup({ url: runUrl(IDS.live), edit });
  try {
    const hazard = container.querySelector('[data-roko="stream"] [data-roko="build-hazard"]');
    assert.ok(hazard, "a hazard card");
    assert.match(text(hazard.querySelector(".rk-stamp")), /configure failed/);
    assert.equal(text(hazard.querySelector(".rk-hz-loc")), "CMakePresets.json :34:24");
    assert.equal(text(hazard.querySelector(".rk-hz-msg")), 'CMake error: Invalid extra field "noTestsAction" in Preset');
    assert.match(hazard.querySelector(".rk-hz-code").textContent, /34 │ "noTestsAction": "error"/);
    // P-21: a narrow glass (the stream at 1440 px) keeps 16 characters around the caret, the cut ends marked there.
    const win = hazard.querySelector(".rk-hz-code > .rk-hz-win");
    assert.equal(win.textContent, 'Action": "error"');
    assert.equal(win.getAttribute("data-l"), "true");
    assert.equal(win.getAttribute("data-r"), null);
    assert.equal(hazard.querySelector(".rk-hz-code > .rk-hz-cut").textContent, '"noTests');
    assert.equal(hazard.querySelector(".rk-hz-caret").textContent, " ".repeat(18) + "^");
    assert.equal(hazard.querySelector(".rk-hz-caret .rk-hz-win").textContent.indexOf("^"), win.textContent.indexOf('"error"'));
    const css = readFileSync(path.join(REPO, "dashboard", "dist", "style.css"), "utf8");
    assert.match(css, /\.rk-hz \{[^}]*container-type: inline-size/);
    assert.match(css, /@container \(max-width: 360px\) \{\s*\.rk-hz-cut \{ display: none; \}/);
  } finally {
    await cleanup();
  }
});

test("v7 build glass: output with no build, error or tests stays lines: the last 40 of them", async () => {
  const env = await liveSetup({ url: runUrl(IDS.live), edit: checkingEdit(null) });
  const { container } = env;
  try {
    const socket = FakeSocket.all[0];
    await push(socket, { type: "hello", version: VERSION, overview: env.backend.fx.overview, hub: "open" });
    const lines = Array.from({ length: 45 }, (_, i) => "checking file " + (i + 1));
    await push(socket, { type: "live", run_id: IDS.live, task_id: "T2", attempt: 3, kind: "check", gate: "verify[0:build]", stream: "stdout", line: lines[44], tail: lines, ts: Date.now() });
    const block = container.querySelector('[data-roko="stream"] [data-roko="stream-check"]');
    assert.equal(text(block.querySelector(".rk-ln-new")), "checking file 45");
    assert.equal(block.querySelectorAll("span").length, 40);
    assert.equal(container.querySelector('[data-roko="stream"] [data-roko="build-glass"]'), null);
  } finally {
    await cleanup();
    env.restore();
  }
});

test("v7: an ended run the backend is still reading says so, draws no receipt, and looks again until it is read (hermes-pilot P-17)", async () => {
  const edit = (fx) => {
    const card = fx.runs[IDS.multiwave].run;
    card.reading = true;
    card.events_read = 40000;
  };
  const env = await setup({ url: runUrl(IDS.multiwave), edit });
  const { container } = env;
  try {
    const note = container.querySelector('[data-roko="run-reading"]');
    assert.ok(note, "a reading note");
    assert.equal(text(note), "Reading this run's history · 40,000 events so far · the page fills in as it reads");
    assert.equal(container.querySelector('[data-roko="receipt"]'), null, "no receipt from half a run");
    // The backend reads on; the page looks again (an ended run is otherwise looked at once).
    env.backend.fx.runs[IDS.multiwave].run.reading = false;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 3600)); });
    await settle();
    assert.equal(container.querySelector('[data-roko="run-reading"]'), null);
    assert.ok(container.querySelector('[data-roko="receipt"]'), "its receipt once read");
  } finally {
    await cleanup();
  }
});

test("the bundle uses no string evaluation and no innerHTML", () => {
  for (const needle of ["ev" + "al(", "new " + "Function", "dangerously" + "SetInnerHTML", "inner" + "HTML", "at" + "ob("]) {
    assert.ok(!BUNDLE_SRC.includes(needle), "dist/index.js must not contain " + needle);
  }
});

// --------------------------------------------------------------------------------
// 0.7 serve and projects (BRIEF §C): the serve states, Start, a busy restart, the project picker and switcher,
// project names on runs, and the page-load ensure
// --------------------------------------------------------------------------------

/** The page's own refresh key, r: the overview is asked again now. */
async function refreshPage(container) {
  await press("r");
  await settle();
}
const serveBanner = (scope) => scope.querySelector('[data-roko="serve-banner"]');

test("0.7 serve and projects: every serve state shows in the banner, the header, the chip and the slots, and is said once", async () => {
  window.localStorage.removeItem("roko.project");
  const edit = (fx) => {
    fx.projects = [projectRow(WS)];
    fx.serves[WS] = serveState(WS, "starting");
    fx.auto_start = false;
  };
  const { container, backend, registry } = await setup({ edit });
  try {
    const states = [
      ["starting", () => serveState(WS, "starting"), "starting", /^roko serve is starting for tally…$/],
      ["stopped", () => serveState(WS, "stopped"), "stopped", /^roko serve is not running for tally\.$/],
      ["failed", () => serveState(WS, "failed", { error: serveError("start_failed") }), "failed to start", /^roko serve did not start for tally\.$/],
      ["outdated", () => serveState(WS, "outdated", { error: serveError("no_mcp") }), "outdated", /^The roko for tally is too old for Hermes\.$/],
      ["not_found", () => serveState(WS, "not_found", { error: serveError("not_found") }), "not found", /^Hermes cannot find roko on this machine\.$/],
    ];
    for (const [state, make, word, title] of states) {
      backend.fx.serves[WS] = make();
      await refreshPage(container);
      const banner = serveBanner(container);
      assert.ok(banner, "a banner for " + state);
      assert.equal(banner.getAttribute("data-state"), state);
      assert.match(text(banner.querySelector(".rk-serve-title")), title);
      assert.equal(text(container.querySelector('[data-roko="live-state"]')), word);
      const said = container.querySelector('[data-roko="serve-said"]');
      assert.equal(said.textContent, "roko serve " + word);
      assert.equal(said.getAttribute("aria-live"), "polite");
      // The banner says it: the backend's own row about the serve (roko-unreachable, roko-not-found) is not shown as
      // well, and the header has no second line.
      assert.ok(!container.querySelector('[data-roko="problem-roko-unreachable"]'));
      assert.ok(!container.querySelector('[data-roko="problem-roko-not-found"]'));
      assert.ok(!container.querySelector('[data-roko="conn-detail"]'));
    }

    // Starting: a rose light and a word that sweeps along the glass.
    backend.fx.serves[WS] = serveState(WS, "starting");
    await refreshPage(container);
    assert.ok(serveBanner(container).querySelector('.rk-led[data-ch="live"][data-blink="slow"]'));
    assert.ok(serveBanner(container).querySelector('.rk-dots[data-sweep="true"]'));
    assert.match(text(container.querySelector('[data-roko="serve-starting"]')), /^0:0\d · usually ready within a minute$/);

    // The chip and the slots say it too.
    const chip = await mount(registry.slots.find((s) => s.slot === "header-right").component, { url: "http://localhost/sessions" });
    assert.equal(text(chip.container.querySelector('[data-roko="chip"]')), "roko starting");
    assert.ok(!chip.container.querySelector('[data-roko="chip-setup"]'), "the serve is its own word, not \"setup\"");
    const sessions = await mount(registry.slots.find((s) => s.slot === "sessions:top").component, { url: "http://localhost/sessions" });
    const strip = sessions.container.querySelector('[data-roko="sessions-setup"]');
    assert.equal(strip.getAttribute("data-serve"), "starting");
    assert.match(text(strip), /roko serve is starting for tally…/);

    // Running: no banner; remote: the plugin never starts it, and the connection says where it is.
    backend.fx.serves[WS] = serveState(WS, "running");
    await refreshPage(container);
    assert.ok(!serveBanner(container));
    assert.equal(container.querySelector('[data-roko="serve-said"]').textContent, "roko serve running");
    assert.match(text(container.querySelector('[data-roko="roko-connection"]')), / · http:\/\/127\.0\.0\.1:6913$/, "the serve's own URL");
    backend.fx.serves[WS] = serveState(WS, "remote", { url: "https://roko.example.net" });
    await refreshPage(container);
    assert.ok(!serveBanner(container));
    assert.equal(text(container.querySelector('[data-roko="roko-connection"]')), "roko · v0.1.0 · ok · remote · https://roko.example.net");
  } finally {
    await cleanup();
  }
});

test("0.7 serve and projects: Start from the banner, the composer waits, the page looks every 2 s; a failed start's log; a missing roko's fix copies", async () => {
  window.localStorage.removeItem("roko.project");
  const edit = (fx) => {
    fx.projects = [projectRow(WS)];
    fx.serves[WS] = serveState(WS, "stopped");
    fx.auto_start = false;
  };
  const { container, backend } = await setup({ edit });
  const copied = [];
  Object.defineProperty(window.navigator, "clipboard", { configurable: true, value: { writeText: async (v) => { copied.push(v); } } });
  try {
    assert.deepEqual(backend.fx.serve_posts, [{ action: "ensure" }], "the page load asked for it once");
    // One orange key a screen: starting roko serve is the thing to do, so new run steps back meanwhile.
    assert.ok(button(serveBanner(container), "start roko serve").classList.contains("rk-key--you"));
    assert.ok(!button(container, "New run").classList.contains("rk-key--you"));
    await click(button(serveBanner(container), "start roko serve"));
    assert.deepEqual(backend.fx.serve_posts.at(-1), { action: "start", project: WS });
    assert.equal(serveBanner(container).getAttribute("data-state"), "starting");

    // A request can be written meanwhile; its start key waits for roko serve, which the composer says.
    await click(button(container, "New run"));
    const modal = container.querySelector('[data-roko="composer"]') || window.document.querySelector('[data-roko="composer"]');
    assert.ok(modal, "the composer");
    await typeInto(modal.querySelector("textarea"), "Add a --json flag");
    assert.equal(serveBanner(modal).getAttribute("data-state"), "starting");
    assert.equal(modal.querySelector('[data-roko="composer-submit"]').disabled, true);
    assert.equal(modal.querySelector('[data-roko="composer-serve-said"]').textContent, "roko serve starting");

    // roko serve answers: nothing is refetched by hand, the page's own look every 2 s finds it.
    backend.fx.serves[WS] = serveState(WS, "running");
    await eventually(() => assert.ok(!serveBanner(container)));
    assert.equal(modal.querySelector('[data-roko="composer-submit"]').disabled, false);
    // Said inside the dialog, where assistive tech is while it is open.
    assert.equal(modal.querySelector('[data-roko="composer-serve-said"]').textContent, "roko serve running");
    assert.ok(!button(container, "New run").classList.contains("rk-key--you"), "two answers wait on Runs: theirs are the orange keys");
    await press("Escape");

    // A failed start: why (roko's words, and the backend's hint as a sentence, its command to copy), and the last lines
    // of its log as text.
    backend.fx.serves[WS] = serveState(WS, "failed", {
      error: serveError("start_failed"),
      log_tail: ["error: could not bind 127.0.0.1:6913", '<img src=x onerror="alert(1)"> **not bold**', "roko serve: exiting"],
    });
    await refreshPage(container);
    const banner = serveBanner(container);
    assert.match(text(banner), /roko serve exited before it answered \(exit code 1\)\./);
    assert.equal(banner.querySelector(".rk-serve-hint").textContent, "The log's last lines say why; `roko serve --workdir /home/demo/code/tally` in a terminal shows the whole error.");
    assert.equal(text(banner.querySelector(".roko-cmd-text")), "roko serve --workdir /home/demo/code/tally");
    assert.ok(!banner.querySelector('[data-roko="serve-log"]'));
    await click(banner.querySelector('[data-roko="serve-log-key"]'));
    const log = banner.querySelector('[data-roko="serve-log"]');
    assert.equal(log.textContent, 'error: could not bind 127.0.0.1:6913\n<img src=x onerror="alert(1)"> **not bold**\nroko serve: exiting\n');
    assert.ok(!log.querySelector("img"));
    assert.ok(button(banner, "start again"));

    // roko is not found: the install command to copy.
    backend.fx.serves[WS] = serveState(WS, "not_found", { error: serveError("not_found") });
    await refreshPage(container);
    assert.equal(text(serveBanner(container).querySelector(".roko-cmd-text")), "cargo install --path crates/roko-cli");
    await click(serveBanner(container).querySelector('[data-roko="serve-fix-copy"]'));
    assert.deepEqual(copied, ["cargo install --path crates/roko-cli"]);

    // A roko too old to start a serve: the update command; a running serve without /mcp: words only (nothing to copy),
    // and its restart key.
    backend.fx.serves[WS] = serveState(WS, "outdated", { url: null, pid: null, actions: [], error: serveError("too_old") });
    await refreshPage(container);
    assert.equal(text(serveBanner(container).querySelector(".roko-cmd-text")), "git pull && cargo install --path crates/roko-cli");
    backend.fx.serves[WS] = serveState(WS, "outdated", { error: serveError("no_mcp") });
    await refreshPage(container);
    assert.equal(serveBanner(container).querySelector(".rk-serve-hint").textContent, "Update roko, then restart roko serve (Restart on the roko page).");
    assert.ok(!serveBanner(container).querySelector(".roko-cmd-text"));
    assert.ok(!serveBanner(container).querySelector('[data-roko="serve-fix-copy"]'));
    assert.ok(button(serveBanner(container), "restart roko serve"));
  } finally {
    delete window.navigator.clipboard;
    await cleanup();
  }
});

test("0.7 serve and projects: a busy restart asks first, naming what it stops, then sends force; so does one the backend finds busy", async () => {
  window.localStorage.removeItem("roko.project");
  const edit = (fx) => {
    fx.projects = [projectRow(WS)];
    fx.serves[WS] = serveState(WS, "outdated", { error: serveError("no_mcp"), busy: { active_runs: 2 } });
    fx.auto_start = false;
    fx.serve_busy = 2;
  };
  const { container, backend } = await setup({ edit });
  try {
    await click(button(serveBanner(container), "restart roko serve"));
    const confirm = container.querySelector('[role="alertdialog"]') || window.document.querySelector('[role="alertdialog"]');
    assert.equal(confirm.getAttribute("aria-label"), "Restart roko serve while runs are going?");
    assert.match(text(confirm), /2 runs are going in tally: restarting roko serve stops them\. What passed is kept\. Going now: Write the ledger report, Add per-category budgets to tally/);
    assert.deepEqual(backend.fx.serve_posts, [{ action: "ensure" }], "asked first: nothing sent yet");
    await click(confirm.querySelector('[data-confirm="yes"]'));
    assert.deepEqual(backend.fx.serve_posts.at(-1), { action: "restart", project: WS, force: true });

    // The overview did not know it was busy; the backend does, and says so: the same question, in its words.
    backend.fx.serves[WS] = serveState(WS, "outdated", { error: serveError("no_mcp") });
    await refreshPage(container);
    await click(button(serveBanner(container), "restart roko serve"));
    assert.deepEqual(backend.fx.serve_posts.at(-1), { action: "restart", project: WS });
    const asked = window.document.querySelector('[role="alertdialog"]');
    assert.match(text(asked), /2 runs are going in tally; restarting roko serve stops them\./);
    await click(asked.querySelector('[data-confirm="yes"]'));
    assert.deepEqual(backend.fx.serve_posts.at(-1), { action: "restart", project: WS, force: true });
    assert.ok(!window.document.querySelector('[role="alertdialog"]'));
  } finally {
    await cleanup();
  }
});

test("0.7 serve and projects: the composer picks the project, adds one by its path, and sets roko up in it", async () => {
  window.localStorage.removeItem("roko.project");
  const edit = (fx) => { fx.projects = [projectRow(WS), projectRow(SYNTH)]; };
  const { container, backend } = await setup({ edit });
  try {
    await click(button(container, "New run"));
    const modal = window.document.querySelector('[data-roko="composer"]');
    const module = () => modal.querySelector('[data-roko="composer-project"]');
    const radio = (name) => [...module().querySelectorAll('[role="radio"]')].find((r) => r.getAttribute("aria-label").startsWith(name));
    assert.equal(radio("tally").getAttribute("aria-label"), "tally, roko serve running, default");
    assert.equal(radio("tally").getAttribute("aria-checked"), "true");
    await click(radio("pocket-synth"));
    await settle();
    assert.ok(backend.calls.some((c) => c.url === "/api/plugins/roko/overview?project=" + encodeURIComponent(SYNTH)));
    assert.equal(radio("pocket-synth").getAttribute("aria-checked"), "true");
    assert.equal(window.localStorage.getItem("roko.project"), SYNTH);

    // A path that is no git checkout: the backend's reason, nothing added.
    const field = module().querySelector('input[aria-label="Add a project: the path of a git checkout"]');
    await typeInto(field, "/home/demo/Downloads");
    await click(button(module(), "add"));
    assert.match(text(module()), /\/home\/demo\/Downloads is not a git checkout, and roko works on branches of one/);
    assert.match(text(module()), /make it one first: git -C '\/home\/demo\/Downloads' init, then commit what you have/);

    // A folder inside a checkout: the backend keeps its top folder, and the composer is now for it. It has no roko.toml:
    // its roko serve runs on roko's defaults, but roko refuses runs from Hermes there until it is set up.
    await typeInto(field, "/home/demo/code/notes/src");
    await press("Enter", field);
    assert.deepEqual(backend.fx.project_posts.at(-1), { action: "add", path: "/home/demo/code/notes/src" });
    await settle();
    assert.equal(radio("notes").getAttribute("aria-checked"), "true");
    assert.equal(radio("notes").getAttribute("aria-label"), "notes, roko serve running, needs setup");

    // roko is not set up there: start waits, and "set up roko here" says what it does (no diff: roko init writes the
    // file), then applies it.
    await typeInto(modal.querySelector("textarea"), "Add a --json flag");
    const card = modal.querySelector('[data-roko="problem-card-project-needs-setup"]');
    assert.match(text(card), /roko isn't set up for runs from Hermes in notes\./);
    assert.ok(!serveBanner(modal));
    assert.equal(modal.querySelector('[data-roko="composer-serve-said"]').textContent, "roko serve running");
    assert.equal(modal.querySelector('[data-roko="composer-submit"]').disabled, true);
    await click(card.querySelector('[data-roko="fix-project-needs-setup"]'));
    const panel = card.querySelector('[data-roko="fix-panel-project-needs-setup"]');
    assert.ok(backend.calls.some((c) => c.url === "/api/plugins/roko/setup/fix?action=setup-project&project=" + encodeURIComponent("/home/demo/code/notes")));
    assert.match(text(panel), /Set up roko in notes/);
    assert.match(text(panel), /Runs `roko init` in \/home\/demo\/code\/notes/);
    assert.equal(text(panel.querySelector(".rk-fixpath")), "in /home/demo/code/notes");
    assert.match(text(panel), /Nothing is committed: commit roko\.toml yourself when you are happy with it\./);
    assert.ok(!/Nothing in the file changes/.test(text(panel)));
    assert.ok(!panel.querySelector('[data-roko="fix-preview"]'));
    await click(card.querySelector('[data-roko="fix-apply-project-needs-setup"]'));
    assert.deepEqual(backend.fx.setup_posts, [{ action: "setup-project", project: "/home/demo/code/notes", digest: "a3f1c2d4e5b6a7c8" }]);

    // Set up, and its serve answered before the reply came: the run goes to that project at once.
    await settle();
    assert.ok(!modal.querySelector('[data-roko="problem-card-project-needs-setup"]'));
    await eventually(() => assert.equal(modal.querySelector('[data-roko="composer-submit"]').disabled, false));
    await click(modal.querySelector('[data-roko="composer-submit"]'));
    assert.equal(posts(backend, "/runs").at(-1).body.project, "/home/demo/code/notes");
  } finally {
    window.localStorage.removeItem("roko.project");
    await cleanup();
  }
});

test("0.7 serve and projects: the header switches the project the page shows, keeps it in the browser, and goes back to the default", async () => {
  window.localStorage.removeItem("roko.project");
  const edit = (fx) => {
    fx.projects = [projectRow(WS), projectRow(SYNTH)];
    fx.serves[SYNTH] = serveState(SYNTH, "stopped");
    fx.auto_start = false;
  };
  const { container, backend } = await setup({ edit });
  try {
    const select = () => container.querySelector('[data-roko="project-switch"]');
    assert.equal(select().value, WS);
    assert.deepEqual([...select().options].map((o) => o.textContent), ["tally", "pocket-synth"]);
    assert.equal(select().closest("label").querySelector(".rk-led").getAttribute("data-ch"), "pass", "the light says the shown project's serve");
    await act(async () => {
      select().value = SYNTH;
      select().dispatchEvent(new window.Event("change", { bubbles: true }));
    });
    await settle();
    assert.equal(select().value, SYNTH);
    assert.equal(window.localStorage.getItem("roko.project"), SYNTH);
    assert.equal(serveBanner(container).getAttribute("data-state"), "stopped");
    assert.match(text(serveBanner(container)), /roko serve is not running for pocket-synth\./);
    await openTab(container, "Plans");
    assert.ok(backend.calls.some((c) => c.url === "/api/plugins/roko/plans?project=" + encodeURIComponent(SYNTH)));

    // A new tab opens on the project this browser kept.
    await cleanup();
    const again = await setup({ edit });
    assert.equal(again.container.querySelector('[data-roko="project-switch"]').value, SYNTH);
    assert.ok(again.backend.calls.some((c) => c.url === "/api/plugins/roko/overview?project=" + encodeURIComponent(SYNTH)));

    // Back to the default project: 0.6's routes, nothing kept.
    const sel = again.container.querySelector('[data-roko="project-switch"]');
    await act(async () => {
      sel.value = WS;
      sel.dispatchEvent(new window.Event("change", { bubbles: true }));
    });
    await settle();
    assert.ok(!window.localStorage.getItem("roko.project"));
    assert.equal(again.backend.calls.filter((c) => c.method === "GET" && /\/overview$/.test(c.url)).length >= 1, true);
    assert.ok(!serveBanner(again.container));
  } finally {
    window.localStorage.removeItem("roko.project");
    await cleanup();
  }
});

test("0.7 serve and projects: runs say their project once more than one is known; a socket serve frame ends the banner", async () => {
  window.localStorage.removeItem("roko.project");
  const edit = (fx) => {
    fx.projects = [projectRow(WS), projectRow(SYNTH)];
    fx.overview.runs = fx.overview.runs.map((r) => ({ ...r, project: r.run_id === IDS.live ? { path: SYNTH, name: "pocket-synth" } : { path: WS, name: "tally" } }));
    fx.runs[IDS.live].run.project = { path: SYNTH, name: "pocket-synth" };
  };
  const env = await liveSetup({ edit });
  const { container, backend } = env;
  try {
    const names = [...container.querySelectorAll('[data-roko="run-line"] [data-roko="run-project"], [data-roko="run-card"] [data-roko="run-project"]')].map((el) => text(el));
    assert.equal(names.length, backend.fx.overview.runs.length);
    assert.equal(names.filter((n) => n === "pocket-synth").length, 1);
    await click(container.querySelector(`[data-roko="run-card"][data-run="${IDS.live}"] .rk-rc-title`));
    assert.equal(container.querySelector('[data-roko="hero"] [data-roko="run-project"]').getAttribute("title"), SYNTH);

    // One project: nothing to tell apart.
    backend.fx.projects = [projectRow(WS)];
    await refreshPage(container);
    assert.equal(container.querySelectorAll('[data-roko="run-project"]').length, 0);

    backend.fx.serves[WS] = serveState(WS, "starting");
    await refreshPage(container);
    assert.equal(serveBanner(container).getAttribute("data-state"), "starting");
    backend.fx.serves[WS] = serveState(WS, "running");
    await push(FakeSocket.all[0], { type: "serve", serve: serveState(WS, "running") });
    assert.ok(!serveBanner(container));
  } finally {
    env.restore();
    await cleanup();
  }
});

test("0.7 serve and projects: the page load asks the backend to ensure roko serve, once; an older backend's 404 changes nothing", async () => {
  window.localStorage.removeItem("roko.project");
  const backend = makeBackend("normal", (fx) => {
    fx.projects = [projectRow(WS)];
    fx.serves[WS] = serveState(WS, "stopped");
  });
  const registry = loadBundle(backend);
  await settle();
  assert.deepEqual(backend.fx.serve_posts, [{ action: "ensure" }]);
  assert.equal(backend.fx.serves[WS].state, "starting", "the backend started it in the background");
  assert.equal(typeof registry.pages.roko, "function");

  // With no project, ensure is refused (`invalid`: nothing to start); the page ignores it and asks for one.
  const none = await setup({ edit: (fx) => { fx.projects = []; } });
  try {
    assert.deepEqual(none.backend.fx.serve_posts, [{ action: "ensure" }]);
    assert.ok(none.container.querySelector('[data-roko="pick-project"]'));
    assert.ok(!none.container.querySelector(".roko-error"), "the refusal is not shown");
  } finally {
    await cleanup();
  }

  // A 0.6 backend has no /serve: the call fails quietly, and the page works as before.
  const { container, backend: old } = await setup();
  try {
    assert.ok(old.calls.some((c) => c.method === "POST" && c.url === "/api/plugins/roko/serve"));
    assert.match(text(container.querySelector('[data-roko="roko-connection"]')), /^roko · v0\.1\.0 · ok/);
    assert.ok(!container.querySelector('[data-roko="project-switch"]'));
    assert.ok(!container.querySelector('[data-roko="restart"]'));
    assert.ok(!serveBanner(container));
  } finally {
    await cleanup();
  }
});

test("0.7 serve and projects: no project yet: the page, the header and the chip ask for one; a path adds it and the page shows it", async () => {
  window.localStorage.removeItem("roko.project");
  const { container, backend, registry } = await setup({ edit: (fx) => { fx.projects = []; } });
  try {
    const pick = container.querySelector('[data-roko="pick-project"]');
    assert.ok(pick, "the pick state");
    assert.match(text(pick), /Pick the project roko works in\./);
    assert.equal(text(container.querySelector('[data-roko="live-state"]')), "no project");
    assert.equal(text(container.querySelector('[data-roko="status"] .rk-head-trouble')), "no project");
    assert.equal(text(container.querySelector('[data-roko="roko-connection"]')), "no project yet");
    // No serve to reach: no unreachable row, no second line in the header.
    assert.ok(!container.querySelector('[data-roko="problem-roko-unreachable"]'));
    assert.ok(!container.querySelector('[data-roko="conn-detail"]'));
    const chip = await mount(registry.slots.find((x) => x.slot === "header-right").component, { url: "http://localhost/sessions" });
    assert.equal(text(chip.container.querySelector('[data-roko="chip"]')), "roko no project");
    assert.ok(!chip.container.querySelector('[data-roko="chip-setup"]'));

    // Its path field is the screen's one orange key; the backend names the project it added.
    const field = pick.querySelector('input[aria-label="Add a project: the path of a git checkout"]');
    await typeInto(field, "/home/demo/code/tally");
    const add = pick.querySelector('[data-roko="project-add"]');
    assert.ok(add.classList.contains("rk-key--you"));
    await click(add);
    assert.deepEqual(backend.fx.project_posts, [{ action: "add", path: "/home/demo/code/tally" }]);
    await settle();
    assert.ok(!container.querySelector('[data-roko="pick-project"]'));
    assert.equal(container.querySelector('[data-roko="project-switch"]').value, WS);
    assert.ok(!window.localStorage.getItem("roko.project"), "the first project is the default: nothing to keep");
  } finally {
    await cleanup();
  }
});

test("0.7 serve and projects: a setup card about the project shown acts on that project: fix.project rides the preview and the apply", async () => {
  window.localStorage.setItem("roko.project", SYNTH);
  const edit = (fx) => {
    fx.projects = [projectRow(WS), projectRow(SYNTH)];
    fx.overview.setup = {
      ok: false,
      problems: [
        { ...PROBLEM_BOUNDARY, fix: { ...PROBLEM_BOUNDARY.fix, project: SYNTH } },
        { id: "project-needs-setup", severity: "block", title: "roko isn't set up for runs from Hermes in pocket-synth.", detail: "It has no roko.toml.", fix: { kind: "action", label: "set up roko here", action: "setup-project", command: null, docs: null, project: SYNTH } },
      ],
    };
  };
  const { container, backend } = await setup({ edit });
  try {
    assert.equal(container.querySelector('[data-roko="project-switch"]').value, SYNTH, "the tab opens on the project this browser kept");
    // The backend's own setup row is shown once (the page derives none of its own).
    assert.equal(container.querySelectorAll('[data-roko="problem-project-needs-setup"]').length, 1);
    await click(container.querySelector('[data-roko="fix-workspace-refuses-chat-runs"]'));
    assert.ok(backend.calls.some((c) => c.method === "GET" && c.url.endsWith("/setup/fix?action=workspace-chat-ready&project=" + encodeURIComponent(SYNTH))));
    await click(container.querySelector('[data-roko="fix-apply-workspace-refuses-chat-runs"]'));
    const applied = posts(backend, "/setup/fix").at(-1).body;
    assert.deepEqual(applied, { action: "workspace-chat-ready", project: SYNTH, variant: "local", digest: "digest-local" });
  } finally {
    window.localStorage.removeItem("roko.project");
    await cleanup();
  }
});

test("0.7 serve and projects: the project shown reaches /pending, /health and the live socket; picking another dials it again", async () => {
  window.localStorage.removeItem("roko.project");
  const env = await liveSetup({ edit: (fx) => { fx.projects = [projectRow(WS), projectRow(SYNTH)]; } });
  const { container, backend } = env;
  try {
    assert.equal(FakeSocket.all.length, 1);
    assert.ok(!FakeSocket.all[0].url.includes("project="));
    const select = container.querySelector('[data-roko="project-switch"]');
    await act(async () => {
      select.value = SYNTH;
      select.dispatchEvent(new window.Event("change", { bubbles: true }));
    });
    await settle();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    const latest = FakeSocket.all.at(-1);
    assert.ok(latest.url.includes("project=" + encodeURIComponent(SYNTH)), latest.url);
    assert.notEqual(latest, FakeSocket.all[0], "a new socket for the project");
    assert.ok(backend.calls.some((c) => c.url === "/api/plugins/roko/pending?project=" + encodeURIComponent(SYNTH)), "Runs asks for what waits there");
    await openTab(container, "Learning");
    await openFold(container, "checks");
    assert.ok(backend.calls.some((c) => c.url === "/api/plugins/roko/health?project=" + encodeURIComponent(SYNTH)));
    assert.ok(backend.calls.some((c) => c.url.startsWith("/api/plugins/roko/insights?scope=") && c.url.endsWith("&project=" + encodeURIComponent(SYNTH))));
  } finally {
    window.localStorage.removeItem("roko.project");
    env.restore();
    await cleanup();
  }
});

test("0.7 serve and projects: Waiting lists what waits in every project whose serve runs, each with its run's project (an item names none)", async () => {
  window.localStorage.removeItem("roko.project");
  const edit = (fx) => {
    fx.projects = [projectRow(WS), projectRow(SYNTH)];
    // The confirm run waits in pocket-synth; one of its two items moves to the live run, in tally.
    fx.overview.runs = fx.overview.runs.map((r) => ({ ...r, project: r.run_id === IDS.confirm ? { path: SYNTH, name: "pocket-synth" } : { path: WS, name: "tally" } }));
    const move = (item, i) => (i === 1 ? { ...item, run_id: IDS.live } : item);
    fx.pending = { ...fx.pending, items: fx.pending.items.map(move) };
    fx.overview.pending = fx.overview.pending.map(move);
  };
  const { container, backend } = await setup({ edit });
  try {
    // What needs the person tops Runs, from every project whose serve runs.
    const cards = () => [...container.querySelectorAll('[data-roko="needs-you"] .roko-pending-list > *')];
    assert.equal(cards().length, 2);
    const names = cards().map((card) => text(card.querySelector('[data-roko="run-project"]')));
    assert.deepEqual(names.sort(), ["pocket-synth", "tally"]);

    // pocket-synth's serve stops: what waits there cannot be asked for, so it leaves the list.
    backend.fx.serves[SYNTH] = serveState(SYNTH, "stopped");
    await refreshPage(container);
    await openTab(container, "Plans");
    await openTab(container, "Runs");
    await eventually(() => assert.equal(cards().length, 1));
    assert.equal(text(cards()[0].querySelector('[data-roko="run-project"]')), "tally");
  } finally {
    await cleanup();
  }
});

test("0.7 serve and projects: project-needs-setup (no roko.toml) still offers set up roko here: the backend's row, once, while its serve runs on roko's defaults", async () => {
  window.localStorage.setItem("roko.project", "/home/demo/code/notes");
  const edit = (fx) => {
    fx.projects = [projectRow(WS), projectRow("/home/demo/code/notes", { needs_setup: true, ready: false, last_used: null })];
  };
  const { container } = await setup({ edit });
  try {
    assert.equal(container.querySelector('[data-roko="project-switch"]').value, "/home/demo/code/notes");
    const rows = container.querySelectorAll('[data-roko="problem-project-needs-setup"]');
    assert.equal(rows.length, 1);
    assert.match(text(rows[0]), /roko isn't set up for runs from Hermes in notes\./);
    assert.equal(text(rows[0].querySelector('[data-roko="fix-project-needs-setup"]')), "set up roko here");
    // Its serve runs: no serve banner, and nothing calls the project "not set up" in place of the serve's state.
    assert.ok(!serveBanner(container));
    assert.equal(container.querySelector('[data-roko="serve-said"]').textContent, "roko serve running");
    assert.ok(!/not set up/.test(text(container.querySelector('[data-roko="status"]'))));
  } finally {
    window.localStorage.removeItem("roko.project");
    await cleanup();
  }
});

test("0.7 serve and projects: no model provider: the failed banner says roko's words and copies the key fix; no separate row, no set up roko here", async () => {
  window.localStorage.removeItem("roko.project");
  // roko's not_initialized (round 1): no LLM provider. Here also in a checkout without roko.toml: the key comes first.
  const edit = (fx) => {
    fx.projects = [projectRow(WS, { needs_setup: true, ready: false })];
    fx.serves[WS] = noProvider(WS);
    fx.auto_start = false;
  };
  const { container, registry } = await setup({ edit });
  const copied = [];
  Object.defineProperty(window.navigator, "clipboard", { configurable: true, value: { writeText: async (v) => { copied.push(v); } } });
  try {
    const banner = serveBanner(container);
    assert.ok(banner, "the failed banner");
    assert.equal(banner.getAttribute("data-state"), "failed");
    assert.match(text(banner), /roko serve did not start for tally\./);
    assert.match(text(banner), /\/home\/demo\/code\/tally is not set up for roko: no LLM provider configured\./);
    assert.equal(banner.querySelector(".rk-serve-hint").textContent, "Give roko a model key: a line such as OPENAI_API_KEY=… in ~/.roko/.env, or run `hermes roko init --workdir /home/demo/code/tally`, which offers the key Hermes has.");
    assert.equal(text(banner.querySelector(".roko-cmd-text")), "hermes roko init --workdir /home/demo/code/tally");
    await click(banner.querySelector('[data-roko="serve-fix-copy"]'));
    assert.deepEqual(copied, ["hermes roko init --workdir /home/demo/code/tally"]);
    assert.ok(button(banner, "start again"));
    // The banner is the backend's no-model-provider row; nothing offers to set roko up for it.
    assert.ok(!container.querySelector('[data-roko="problem-no-model-provider"]'));
    assert.ok(!container.querySelector('[data-roko="fix-project-needs-setup"]'));
    assert.equal(text(container.querySelector('[data-roko="live-state"]')), "failed to start");
    const chip = await mount(registry.slots.find((x) => x.slot === "header-right").component, { url: "http://localhost/sessions" });
    assert.equal(text(chip.container.querySelector('[data-roko="chip"]')), "roko failed to start");
  } finally {
    delete window.navigator.clipboard;
    await cleanup();
  }
});

test("0.7 serve and projects: actions from the UI off: no path field (the backend refuses adds then), and the CLI line says how", async () => {
  window.localStorage.removeItem("roko.project");
  const edit = (fx) => {
    fx.projects = [];
    fx.overview.permissions = { write: false };
  };
  const { container } = await setup({ edit });
  try {
    const pick = container.querySelector('[data-roko="pick-project"]');
    assert.match(text(pick), /In a terminal: hermes roko projects add <path>/);
    assert.ok(!pick.querySelector("input"));
    assert.ok(!pick.querySelector('[data-roko="project-add"]'));
  } finally {
    await cleanup();
  }
});

test("0.7 serve and projects: a remote roko serve without a project is no \"no project\": nothing to pick, the header says where", async () => {
  window.localStorage.removeItem("roko.project");
  const edit = (fx) => {
    fx.projects = [];
    fx.remote_url = "https://roko.example.net";
  };
  const { container } = await setup({ edit });
  try {
    assert.ok(!container.querySelector('[data-roko="pick-project"]'));
    assert.ok(!container.querySelector('[data-roko="status"] .rk-head-trouble'), "nothing to pick: no trouble to say");
    assert.ok(!container.querySelector('[data-roko="project-switch"]'));
    assert.ok(!serveBanner(container));
    assert.equal(text(container.querySelector('[data-roko="roko-connection"]')), "roko · v0.1.0 · ok · remote · https://roko.example.net");
  } finally {
    await cleanup();
  }
});

test("0.7 serve and projects: restart roko serve as a setup fix: its summary, then a busy restart asks first and sends force", async () => {
  window.localStorage.removeItem("roko.project");
  const edit = (fx) => {
    fx.projects = [projectRow(WS)];
    fx.serve_busy = 1;
    fx.auto_start = false;
    // readiness._outdated: roko serve runs but lacks a tool this plugin needs; restarting it on the newer roko fixes it.
    fx.overview.setup = {
      ok: false,
      problems: [{
        id: "roko-serve-outdated", severity: "block", title: "roko serve is too old for this plugin.",
        detail: "It lacks roko_plan_run, so plans cannot run from Hermes. Update roko, then restart roko serve.",
        fix: { kind: "action", label: "restart roko serve", action: "restart-serve", command: "hermes roko serve restart --project " + WS, docs: "troubleshooting.md#roko-serve-is-too-old", project: WS },
      }],
    };
  };
  const { container, backend } = await setup({ edit });
  try {
    await click(container.querySelector('[data-roko="fix-roko-serve-outdated"]'));
    const panel = container.querySelector('[data-roko="fix-panel-roko-serve-outdated"]');
    assert.match(text(panel), /Restart roko serve for tally/);
    assert.equal(text(panel.querySelector(".rk-fixpath")), "in /home/demo/code/tally");
    assert.match(text(panel), /1 run is going in tally: restarting stops it \(their work so far is kept\)\./);
    assert.ok(!/Nothing in the file changes/.test(text(panel)));
    await click(panel.querySelector('[data-roko="fix-apply-roko-serve-outdated"]'));

    // The backend refused it (busy) and did nothing: the page asks, in the backend's words, naming what it stops.
    const confirm = window.document.querySelector('[role="alertdialog"]');
    assert.equal(confirm.getAttribute("aria-label"), "Restart roko serve while runs are going?");
    assert.match(text(confirm), /1 run is going in tally; restarting roko serve stops them\. Going now: /);
    assert.deepEqual(backend.fx.setup_posts, [{ action: "restart-serve", project: WS }]);
    await click(confirm.querySelector('[data-confirm="yes"]'));
    assert.deepEqual(backend.fx.setup_posts.at(-1), { action: "restart-serve", project: WS, force: true });

    // The reply's serve: the banner says starting at once, and the outcome says what was done.
    await settle();
    assert.equal(serveBanner(container).getAttribute("data-state"), "starting");
    assert.match(text(container.querySelector('[data-roko="fix-done-note"]')), /roko serve is starting for tally\./);
  } finally {
    await cleanup();
  }
});

test("0.7 serve and projects: a project this browser kept that Hermes no longer knows gives way to the default", async () => {
  window.localStorage.setItem("roko.project", "/home/demo/code/gone");
  const { container, backend } = await setup({ edit: (fx) => { fx.projects = [projectRow(WS)]; } });
  try {
    await settle();
    // The backend refused it (`invalid`): the browser forgets it, and the page shows the default project.
    assert.ok(backend.calls.some((c) => c.url === "/api/plugins/roko/overview?project=" + encodeURIComponent("/home/demo/code/gone")));
    await eventually(() => assert.ok(!window.localStorage.getItem("roko.project")));
    await eventually(() => assert.equal(container.querySelector('[data-roko="project-switch"]').value, WS));
    assert.ok(!container.querySelector('[data-roko="pick-project"]'));
  } finally {
    window.localStorage.removeItem("roko.project");
    await cleanup();
  }
});

test("0.7 serve and projects: set up roko here in the setup module says what roko init creates (the backend's summary, else its own line), never \"Nothing in the file changes.\"", async () => {
  window.localStorage.setItem("roko.project", "/home/demo/code/notes");
  const edit = (fx) => {
    fx.projects = [projectRow(WS), projectRow("/home/demo/code/notes", { needs_setup: true, ready: false, last_used: null })];
  };
  const { container, backend } = await setup({ edit });
  try {
    const row = () => container.querySelector('.rk-setup [data-roko="problem-project-needs-setup"]');
    await click(row().querySelector('[data-roko="fix-project-needs-setup"]'));
    // The backend's summary says what roko init writes: the panel shows that, and the project's path, nothing else.
    let panel = row().querySelector('[data-roko="fix-panel-project-needs-setup"]');
    assert.match(text(panel.querySelector(".rk-fixsummary")), /^Runs `roko init` in \/home\/demo\/code\/notes: it writes roko\.toml .* and roko's `\.roko\/` folder\./);
    assert.equal(text(panel.querySelector(".rk-fixpath")), "in /home/demo/code/notes");
    assert.ok(!/Nothing in the file changes/.test(text(panel)));
    assert.ok(!/changes \/home\/demo\/code\/notes/.test(text(panel)));

    // A backend that sends no summary (its preview is empty: roko.toml does not exist yet): the page says it itself.
    backend.fx.setup_summary = false;
    await click(button(panel, "cancel"));
    await click(row().querySelector('[data-roko="fix-project-needs-setup"]'));
    panel = row().querySelector('[data-roko="fix-panel-project-needs-setup"]');
    assert.equal(text(panel.querySelector(".rk-fixsummary")), "roko init writes roko.toml and .roko/ in notes.");
    assert.ok(!/Nothing in the file changes/.test(text(panel)));
  } finally {
    window.localStorage.removeItem("roko.project");
    await cleanup();
  }
});

// --------------------------------------------------------------------------------
// v8 (plugin-wow P-14): a plan whose last run stopped part way, continued or started over
// --------------------------------------------------------------------------------

const STOPPED_RUN = { run_id: "6988f0b8-4199-4abf-9cfc-67713bc60e34", status: "failed", passed_tasks: ["T1", "T2"], tasks_left: ["T3"] };

test("v8 P-14: Run plan asks continue or start over for a plan whose last run stopped part way, and posts the choice", async () => {
  const { container, backend } = await setup({
    url: "http://localhost/roko?section=plans&plan=" + IDS.plan,
    edit: (fx) => { fx.plan_details[IDS.plan].plan.resumable_run = STOPPED_RUN; },
  });
  try {
    const form = container.querySelector(".roko-runform");
    const choice = form.querySelector('[data-roko="resume-choice"]');
    assert.ok(choice, "the choice replaces the resume checkbox");
    assert.equal(form.querySelector('input[type="checkbox"]'), null);
    assert.match(text(choice), /Its last run, 6988f0b8 \(failed\), passed T1 and T2, and T3 is left\./);
    assert.equal(text(choice.querySelector('[data-roko="resume-what"]')), "Only T3 runs; what passed is kept.");
    await click(buttons(choice).find((b) => text(b) === "start over"));
    assert.equal(text(choice.querySelector('[data-roko="resume-what"]')), "Every task runs again, and 6988f0b8's progress is set aside (roko resume 6988f0b8 brings it back).");
    await submit(form);
    const dialog = container.querySelector('[role="alertdialog"]');
    assert.match(text(dialog), /starting over \(6988f0b8's progress is set aside\)/);
    await click(dialog.querySelector('[data-confirm="yes"]'));
    assert.deepEqual(posts(backend, "/plans/" + IDS.plan + "/run")[0].body, { max_usd: 0.5, fresh: true });
  } finally {
    await cleanup();
  }
});

test("v8 P-61: a run whose tasks all passed and whose delivery a crash cut: a resume only delivers", async () => {
  const { container } = await setup({
    url: "http://localhost/roko?section=plans&plan=" + IDS.plan,
    edit: (fx) => {
      fx.plan_details[IDS.plan].plan.resumable_run = { ...STOPPED_RUN, status: "interrupted", passed_tasks: ["T1", "T2", "T3"], tasks_left: [], delivery_pending: true };
    },
  });
  try {
    const choice = container.querySelector('.roko-runform [data-roko="resume-choice"]');
    assert.match(text(choice), /Its last run, 6988f0b8 \(interrupted\), passed T1, T2 and T3, and its delivery didn't finish\./);
    assert.equal(text(choice.querySelector('[data-roko="resume-what"]')), "No task runs again: only its delivery (the merge, the plan check and the batch).");
  } finally {
    await cleanup();
  }
});

test("v8 P-14: a run roko refuses until it says which shows the choice in the form, and a run that started over says what it set aside", async () => {
  const { container, backend } = await setup({
    url: "http://localhost/roko?section=plans&plan=" + IDS.plan,
    edit: (fx) => {
      fx.plan_started = { ok: false, error: { code: "refused", message: "Plan has a run that can be resumed", hint: "continue it, or start the plan over" }, resumable_run: STOPPED_RUN };
    },
  });
  try {
    const form = container.querySelector(".roko-runform");
    await submit(form);
    await click(container.querySelector('[role="alertdialog"] [data-confirm="yes"]'));
    assert.equal(posts(backend, "/plans/" + IDS.plan + "/run").length, 1);
    const choice = form.querySelector('[data-roko="resume-choice"]');
    assert.ok(choice, "the refusal's run is offered: continue or start over");
    assert.match(text(choice), /continue 6988f0b8/);
    assert.equal(form.querySelector(".roko-error"), null, "the choice says it, not an error note");
  } finally {
    await cleanup();
  }
  const run = await setup({
    url: runUrl(IDS.cancelled),
    edit: (fx) => { fx.runs[IDS.cancelled].run.set_aside = STOPPED_RUN; },
  });
  try {
    const aside = run.container.querySelector('[data-roko="set-aside"]');
    assert.equal(text(aside), "it started over: an earlier run's progress is set aside");
    assert.equal(aside.getAttribute("title"), "roko resume 6988f0b8 brings it back");
  } finally {
    await cleanup();
  }
});

test("v8 P-22: an ended pad too narrow for its foot keeps its time: the seconds go first, then its tries (its head counts them)", async () => {
  // A width model for the pads' feet: 7 px a character and 10 px a try or check mark, in 100 px.
  const foot = (el) => el.classList.contains("rk-pad-ladder");
  Object.defineProperty(window.HTMLElement.prototype, "scrollWidth", { configurable: true, get() { return foot(this) ? this.textContent.length * 7 + this.querySelectorAll(".rk-lives i, .rk-pip").length * 10 : 0; } });
  Object.defineProperty(window.HTMLElement.prototype, "clientWidth", { configurable: true, get() { return foot(this) ? 100 : 0; } });
  const failed = { failed_check: "verify[0:test]", key_line: "AssertionError" };
  const { container } = await setup({
    url: runUrl(IDS.live),
    edit: (fx) => {
      climbEdit(fx);
      const task = fx.runs[IDS.live].run.tasks.find((t) => t.task_id === "T4");
      task.outcome = "passed";
      task.attempts = 6;
      task.duration_ms = 2003000;
      task.climb = [
        tryOn(1, "cheap", "gpt-oss-120b", "start", "failed", failed),
        tryOn(2, "cheap", "gpt-oss-120b", "retry", "failed", failed),
        tryOn(3, "mid", "glm-4.7", "climb", "failed", failed),
        tryOn(4, "mid", "glm-4.7", "retry", "failed", failed),
        tryOn(5, "strong", "gpt-5.4-mini", "climb", "failed", failed),
        tryOn(6, "strong", "gpt-5.4-mini", "retry", "passed"),
      ];
      task.lives = { rung: "strong", used: 2, of: 2 };
    },
  });
  try {
    const pad = node(container, "T4");
    const time = pad.querySelector(".roko-node-time");
    assert.equal(text(time), "33m");
    assert.equal(time.getAttribute("title"), "33m 23s");
    assert.ok(!pad.querySelector(".rk-lives"), "its tries gave way");
    assert.equal(text(pad.querySelector(".rk-rchip")), "strong ▲");
  } finally {
    await cleanup();
    delete window.HTMLElement.prototype.scrollWidth;
    delete window.HTMLElement.prototype.clientWidth;
  }
});

test("v8 P-29: an ended task's pad says the rung it ran on last, and that a failover moved it there", async () => {
  const { container } = await setup({
    url: runUrl(IDS.live),
    edit: (fx) => {
      climbEdit(fx);
      const task = fx.runs[IDS.live].run.tasks.find((t) => t.task_id === "T4");
      const refused = (n) => tryOn(n, "mid", "glm-4.7", n === 1 ? "start" : "retry", "failed", { blame: "infra", verdict: "provider_error" });
      task.outcome = "passed";
      task.climb = [refused(1), refused(2), refused(3), tryOn(4, "strong", "gpt-5.4-mini", "failover", "passed", { failover: { model: "glm-4.7", provider: "zai", class: "rate_limited", why: "rate limited" } })];
      task.lives = { rung: "mid", used: 0, of: 2 };
    },
  });
  try {
    const chip = node(container, "T4").querySelector(".rk-rchip");
    assert.equal(text(chip), "strong ⇄");
    assert.equal(chip.getAttribute("title"), "A failover moved it from mid to the strong rung (rate limited)");
  } finally {
    await cleanup();
  }
});

test("v8 P-31: a failover tag too long for its rail says it short, the long words in its tip", async () => {
  // A width model for the tags: 8 px a character, in a 120 px rail.
  const tag = (el) => el.classList.contains("rk-lad-failover");
  Object.defineProperty(window.HTMLElement.prototype, "scrollWidth", { configurable: true, get() { return tag(this) ? this.textContent.length * 8 : 0; } });
  Object.defineProperty(window.HTMLElement.prototype, "clientWidth", { configurable: true, get() { return tag(this) ? 120 : 0; } });
  const { container } = await setup({
    url: runUrl(IDS.live),
    edit: (fx) => {
      climbEdit(fx);
      const task = fx.runs[IDS.live].run.tasks.find((t) => t.task_id === "T2");
      const failover = { model: "glm-4.7", provider: "zai", class: "circuit_open", why: "failing, so roko paused it" };
      task.outcome = "passed";
      task.climb = [tryOn(1, "cheap", "gpt-oss-120b", "start", "failed"), tryOn(2, "cheap", "gpt-oss-120b", "retry", "failed"), tryOn(3, "mid", "glm-4.7", "failover", "passed", { failover })];
    },
  });
  try {
    const shown = container.querySelector('[data-roko="ladder-failover"]');
    assert.equal(text(shown), "⇄ via failover");
    assert.match(shown.getAttribute("title"), /its first pick was passed over \(failing, so roko paused it\)/);
  } finally {
    await cleanup();
    delete window.HTMLElement.prototype.scrollWidth;
    delete window.HTMLElement.prototype.clientWidth;
  }
});

test("v8 P-34: Run plan offers no resume for a plan whose last run left nothing to resume", async () => {
  const { container } = await setup({
    url: "http://localhost/roko?section=plans&plan=" + IDS.plan,
    edit: (fx) => { fx.plan_details[IDS.plan].plan.resumable_run = null; },
  });
  try {
    const form = container.querySelector(".roko-runform");
    assert.ok(form, "the Run plan form");
    // Booleans, not nodes: a failing assert.equal on a jsdom node inspects the whole window and kills node.
    assert.ok(!form.querySelector('input[type="checkbox"]'), "no resume checkbox");
    assert.ok(!form.querySelector('[data-roko="resume-choice"]'), "no continue or start over");
    assert.doesNotMatch(text(form), /Resume the last run/);
  } finally {
    await cleanup();
  }
});

/** Metakosmia Undertow's build after phase 1, as GET /build answers it (the pilot's real numbers, as the desktop's). */
function undertowBuild() {
  return {
    ok: true,
    project: { name: "undertow", path: "~/dev/undertow" },
    reachable: true,
    phases: [
      { n: 0, name: "foundation", goal: "the build system, the core library and a plugin skeleton.", spec: "docs/specs/phase-0-foundation.md", plan_id: "p0-undertow-foundation", state: "passed", tasks: { passed: 3, total: 3 }, runs: 3, run_id: IDS.done, writing_id: null, cost_usd: 1.19, writing_usd: 0.11, wall_ms: 5460000, coverage: { total: 9, covered: 9, missing: [] }, rungs: null, plans: 1, newest: true },
      { n: 1, name: "the voice", goal: "Undertow makes sound.", spec: "docs/specs/phase-1-voice.md", plan_id: "p1-undertow-voice", state: "passed", tasks: { passed: 5, total: 5 }, runs: 1, run_id: IDS.done, writing_id: null, cost_usd: 1.18, writing_usd: 0.16, wall_ms: 4560000, coverage: { total: 20, covered: 20, missing: [] }, rungs: null, plans: 1, newest: true },
      { n: 2, name: "rumble and modulation", goal: "the hypnotic part of the sound.", spec: "docs/specs/phase-2-rumble.md", plan_id: "p2-undertow-rumble-2", state: "written", tasks: { passed: 0, total: 4 }, runs: 0, run_id: null, writing_id: null, cost_usd: 0.31, writing_usd: 0.31, wall_ms: null, coverage: { total: 19, covered: 0, missing: ["P2.01", "P2.02"] }, rungs: null, plans: 2, newest: true },
      { n: 3, name: "the hypnotic sequencer", goal: "a 16-step bassline sequencer locked to the host transport", spec: "docs/specs/phase-3-sequencer.md", plan_id: null, state: "specified", tasks: null, runs: 0, run_id: null, writing_id: null, cost_usd: null, writing_usd: null, wall_ms: null, coverage: null, rungs: null, plans: 0, newest: false },
    ],
    totals: { phases: 4, passed: 2, tasks_passed: 8, tasks_total: 12, runs: 4, wall_ms: 10020000, cost_usd: 2.79, writing_usd: 0.58, outside_usd: 0.11, cost_source: "ledger" },
    receipt: { phases: 2, top_rung: "claude-sonnet-4-6", top_rung_usd: 5.69, cost_usd: 2.1, ratio: 2.7, missing: 0, unread: [], basis: "≈ each passed phase's passing tries at claude-sonnet-4-6's list prices · roko's spend includes 2 runs that didn't pass", words: "2 phases built so far on claude-sonnet-4-6 ≈ $5.69 · roko spent $2.10: 2.7× less" },
    next: { n: 2, do: "rewrite", plan_id: "p2-undertow-rumble-2", spec: "docs/specs/phase-2-rumble.md", covered: 0, total: 19, missing: ["P2.01", "P2.02"], plans: 2, newest: true },
  };
}

test("wow 3: the build's ladder line shows under the receipt as the backend words it", async () => {
  const line = "landed work by the rung it passed on: mid 24, strong 6 · 25 of 30 passed on the first try · 1 climb";
  const { container } = await setup({ url: "http://localhost/roko?section=build", edit: (fx) => { fx.build = Object.assign(undertowBuild(), { ladder_line: line }); } });
  try {
    const shown = container.querySelector('[data-roko="build-ladder"]');
    assert.ok(shown, "the ladder line");
    assert.equal(shown.textContent, line);
  } finally {
    await cleanup();
  }
});

test("wow 2: the build's chart is the backend's two series by phase, a spark each with its range, each phase's figure on hover", async () => {
  const cost = "each phase's whole spend, failed runs and plan writing too, over the tasks roko verified: P0 $0.35 · P1 $0.23";
  const first = "of the tasks each phase's runs tried, failed runs too, those whose first try passed: P0 3 of 4 · P1 4 of 5";
  const chart = [
    { label: "cost per verified task, by phase", values: [0.351268, 0.23446], range: "$0.23 to $0.35", words: cost, tone: "bone" },
    { label: "first-try rate, by phase", values: [0.75, 0.8], range: "75% to 80%", words: first, tone: "pass" },
  ];
  for (const shown of [chart, null]) {
    const { container } = await setup({ url: "http://localhost/roko?section=build", edit: (fx) => { fx.build = Object.assign(undertowBuild(), { chart: shown }); } });
    try {
      const cells = [...container.querySelectorAll('[data-roko="fold-build-chart"] .rk-build-cell')];
      assert.equal(container.querySelectorAll('[data-roko="build-glass"] .rk-rc-cell').length, 4, "the glass keeps its four readings");
      if (!shown) {
        assert.equal(container.querySelector('[data-roko="fold-build-chart"]'), null, "no chart, no fold");
        continue;
      }
      const charted = cells.filter((c) => c.querySelector("svg.rk-spark2"));
      assert.deepEqual(charted.map((c) => text(c)), ["cost per verified task, by phase $0.23 to $0.35", "first-try rate, by phase 75% to 80%"]);
      assert.deepEqual(charted.map((c) => c.querySelector("[title]").getAttribute("title")), [cost, first]);
    } finally {
      await cleanup();
    }
  }
});

test("P-52: a phase whose run roko refused with every rung skipped says what works in the backend's words, not resume", async () => {
  const words = "P2's run was refused: every rung was skipped because its provider could not bill: recharge cerebras and zai, then resume it";
  const { container } = await setup({
    url: "http://localhost/roko?section=build",
    edit: (fx) => {
      fx.build = undertowBuild();
      Object.assign(fx.build.phases[2], { state: "stopped", run_id: IDS.failed });
      fx.build.next = { n: 2, do: "resume", plan_id: "p2-undertow-rumble-2", run_id: IDS.failed, words: words };
    },
  });
  try {
    const next = container.querySelector('[data-roko="build-next"]');
    assert.ok(text(next).includes(words), text(next));
    assert.ok(!text(next).includes("and only what is left runs"), text(next));
  } finally {
    await cleanup();
  }
});

test("option 1: the build's receipt is the backend's words as they are; without them, no receipt and no basis", async () => {
  for (const words of ["the receipt as the backend words it", null]) {
    const { container } = await setup({ url: "http://localhost/roko?section=build", edit: (fx) => { fx.build = undertowBuild(); fx.build.receipt.words = words; } });
    try {
      const shown = container.querySelector('[data-roko="build-receipt"]');
      if (words) {
        assert.equal(text(shown), words);
      } else {
        assert.equal(shown, null);
        assert.equal(container.querySelector('[data-roko="build-basis"]'), null);
      }
    } finally {
      await cleanup();
    }
  }
});

test("wow 1: the phase reel shows each passed phase's own UI shot in order, its spend and time as on its pad", async () => {
  const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAADklEQVR4nGMQQAIMODkALAcCQaqvfAkAAAAASUVORK5CYII=";
  const paths = ["artifacts/ui/editor-idle.png", "artifacts/ui/editor-voice.png"];
  const { container, backend } = await setup({
    url: "http://localhost/roko?section=build",
    edit: (fx) => {
      fx.build = undertowBuild();
      fx.build.phases[0].shot = { run_id: IDS.prompt, path: paths[0], bytes: 119209 };
      fx.build.phases[1].shot = { run_id: IDS.multiwave, path: paths[1], bytes: 120311 };
      fx.artifact_files = Object.fromEntries(paths.map((p) => [p, { ok: true, path: p, mime: "image/png", data: PNG }]));
    },
  });
  try {
    const reel = container.querySelector('[data-roko="build-reel"]');
    assert.ok(reel, "the reel");
    assert.deepEqual([...reel.querySelectorAll("img")].map((i) => i.getAttribute("alt")), ["Phase 0: editor-idle.png", "Phase 1: editor-voice.png"]);
    // The phases with no shot have no place in it.
    const lines = [...reel.querySelectorAll("figcaption")].map((c) => [...c.childNodes].map((n) => n.textContent).filter(Boolean));
    assert.deepEqual(lines, [["Phase 0 · foundation", "$1.19 · 1h 31m"], ["Phase 1 · the voice", "$1.18 · 1h 16m"]]);
    // Each from its own phase's run, once: the pads leave their shots to the reel.
    const asked = backend.calls.filter((c) => c.url.includes("/artifact?path="));
    assert.equal(asked.length, 2);
    assert.ok(asked.some((c) => c.url.includes(IDS.prompt)) && asked.some((c) => c.url.includes(IDS.multiwave)));
    assert.equal(container.querySelector('[data-roko="phase-0"] img'), null);
  } finally {
    await cleanup();
  }
});

test("v8 #3: the Build section: the whole build on the glass, a pad a phase, and NEXT; its tab shows for two or more phases", async () => {
  const { container } = await setup({ url: "http://localhost/roko?section=build", edit: (fx) => { fx.build = undertowBuild(); } });
  try {
    const build = container.querySelector('[data-roko="build"]');
    assert.ok(build, "the build section");
    assert.match(text(build.querySelector('[data-roko="build-head"]')), /^Undertow 4 phases, built one at a time\./);
    assert.equal(text(build.querySelector('[data-roko="build-glass"] [data-roko="build-phases"] .rk-dots .rk-sr')), "2 of 4 phases passed");
    assert.equal(text(build.querySelector('[data-roko="build-spend"] .rk-rc-note')), "≈ 2.7× less than Sonnet 4.6");
    assert.equal(text(build.querySelector('[data-roko="build-incl"]')), "$2.79 in all · incl. $0.58 plan writing · $0.11 outside the phases");
    assert.equal(text(build.querySelector('[data-roko="build-receipt"]')), "2 phases built so far on claude-sonnet-4-6 ≈ $5.69 · roko spent $2.10: 2.7× less");
    const pads = [...build.querySelectorAll(".rk-phase")];
    assert.deepEqual(pads.map((pad) => pad.getAttribute("data-state")), ["passed", "passed", "written", "specified"]);
    assert.match(text(pads[0]), /\$1\.19 · incl\. \$0\.11 plan writing/);
    assert.match(text(pads[2]), /\$0\.31 plan writing/);
    assert.equal(text(build.querySelector('[data-roko="phase-cover-2"]')), "checks 0/19 of its spec");
    const next = build.querySelector('[data-roko="build-next"]');
    assert.match(text(next), /^NEXT Phase 2's plan leaves out 19 of its spec's 19 checks: write it again\./);
    // The plan's id and the spec's path are on hover, not on the page.
    assert.match(next.querySelector(".rk-build-next-words").getAttribute("title"), /^plan p2-undertow-rumble-2 \(the newest of 2 plans\) · spec docs\/specs\/phase-2-rumble\.md/);
    // Build is Plans now (roko's design system §5.1): the old link opens Plans, headed by the build.
    assert.equal(container.querySelector('.rk-tabs [data-tab="plans"]').getAttribute("aria-selected"), "true");
    assert.ok(!buttons(container).some((b) => b.getAttribute("role") === "tab" && text(b).startsWith("Build")), "no Build tab");
  } finally {
    await cleanup();
  }
});

test("v8 #3: roko's own kept count leads a pad and NEXT, and the plugin's count flags where the two disagree (bug-72dc0d)", async () => {
  const { container } = await setup({
    url: "http://localhost/roko?section=build",
    edit: (fx) => {
      fx.build = undertowBuild();
      const phase = fx.build.phases[2];
      phase.coverage = { total: 23, covered: 19, missing: ["P2.03", "P2.07", "P2.11", "P2.19"] };
      phase.roko_coverage = { total: 23, kept: 20, shallow: 1, cannot_run: 0, dropped: 1, missing: 1, writing_id: "w-3" };
      phase.coverage_agrees = false;
      fx.build.next = { ...fx.build.next, covered: 19, total: 23, roko_kept: 20, roko_total: 23 };
    },
  });
  try {
    const cover = container.querySelector('[data-roko="phase-cover-2"]');
    assert.equal(text(cover), "checks 20/23 kept by roko ≠ 19/23 run");
    assert.equal(cover.getAttribute("data-cross"), "true");
    const next = container.querySelector('[data-roko="build-next"]');
    assert.match(text(next), /Phase 2's plan leaves out 3 of its spec's 23 checks: write it again\./, "roko's count leads");
    assert.match(next.querySelector(".rk-build-next-words").getAttribute("title"), /roko counts 20 of 23 kept; the plugin 19 of 23/);
  } finally {
    await cleanup();
  }
});

test("v8 P-6: NEXT's key writes the plan from its phase's spec, which roko reads itself: plan first, the spec by its path, the plan's title", async () => {
  const { container, backend } = await setup({ url: "http://localhost/roko?section=build", edit: (fx) => { fx.build = undertowBuild(); } });
  try {
    await click(buttons(container).find((b) => text(b) === "plan phase 2 again"));
    const dialog = container.querySelector('[data-roko="composer"]');
    assert.ok(dialog, "the composer opened");
    const mode = buttons(dialog).find((b) => b.getAttribute("role") === "radio" && text(b).startsWith("plan first"));
    assert.equal(mode.getAttribute("aria-checked"), "true", "plan first, not a plan to run");
    assert.match(text(dialog.querySelector('[data-roko="composer-spec"]')), /docs\/specs\/phase-2-rumble\.md/);
    assert.equal(dialog.querySelector('input[aria-label="Title"]').value, "P2 · Rumble and modulation");
    const added = dialog.querySelector("textarea").value;
    // The build names 20 missing checks at most: the rest are counted.
    assert.equal(added, "The plan p2-undertow-rumble-2 ran 0 of this spec's 19 acceptance checks (P2.01, P2.02 and 17 more not run). Make each one a verify step whose command is exactly the spec's command, with nothing around it.");
    await click(dialog.querySelector('[data-roko="composer-submit"]'));
    const sent = posts(backend, "/runs");
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].body, { prompt: added, plan: true, spec_path: "docs/specs/phase-2-rumble.md", title: "P2 · Rumble and modulation" });
  } finally {
    await cleanup();
  }
});

test("v8 P-7: a roko that caps plan writing gets a cap for it from the composer", async () => {
  const { container, backend } = await setup({ url: "http://localhost/roko?section=build", edit: (fx) => { fx.build = undertowBuild(); fx.overview.plan_writing_cap = true; } });
  try {
    await click(buttons(container).find((b) => text(b) === "plan phase 2 again"));
    const dialog = container.querySelector('[data-roko="composer"]');
    assert.ok(dialog.querySelector('[data-roko="cap-presets"]'), "a cap for the plan writing");
    assert.match(text(dialog.querySelector('[data-roko="composer-more"]')), /the most writing the plan may spend/);
    assert.match(text(dialog.querySelector('[data-roko="composer-note"]')), /^Writing the plan spends at most \$0\.50 and runs nothing\./);
    await click([...dialog.querySelectorAll('[data-roko="cap-presets"] button')].find((b) => text(b) === "$1"));
    assert.equal(text(dialog.querySelector('[data-roko="composer-submit"]')), "write plan · cap $1.00 ⌘↵");
    await click(dialog.querySelector('[data-roko="composer-submit"]'));
    assert.equal(posts(backend, "/runs")[0].body.max_usd, 1);
  } finally {
    await cleanup();
  }
});

test("v8 P-6: a spec taken off the composer leaves a plan from the request alone", async () => {
  const { container, backend } = await setup({
    url: "http://localhost/roko?section=build",
    edit: (fx) => { fx.build = undertowBuild(); fx.build.next = { n: 3, do: "write", spec: "docs/specs/phase-3-sequencer.md" }; },
  });
  try {
    await click(buttons(container).find((b) => text(b) === "plan phase 3"));
    const dialog = container.querySelector('[data-roko="composer"]');
    assert.equal(dialog.querySelector("textarea").value, "", "a spec alone needs no request");
    assert.ok(!dialog.querySelector('[data-roko="composer-submit"]').disabled, "a spec alone can be planned");
    await click(buttons(dialog).find((b) => b.getAttribute("aria-label") === "Plan from the request alone"));
    assert.ok(!dialog.querySelector('[data-roko="composer-spec"]'), "the spec is off");
    await typeInto(dialog.querySelector("textarea"), "A 16-step sequencer");
    await click(dialog.querySelector('[data-roko="composer-submit"]'));
    assert.deepEqual(posts(backend, "/runs")[0].body, { prompt: "A 16-step sequencer", plan: true, title: "P3 · The hypnotic sequencer" });
  } finally {
    await cleanup();
  }
});

test("phase 2's stills: a phase whose tasks ran out of rungs says so before the resume, and offers its plan again", async () => {
  const { container } = await setup({
    url: "http://localhost/roko?section=build",
    edit: (fx) => {
      fx.build = undertowBuild();
      fx.build.phases[2] = { ...fx.build.phases[2], state: "stopped", ended: "failed", run_id: IDS.failed, coverage: { total: 23, covered: 23, missing: [] } };
      fx.build.next = { n: 2, do: "resume", plan_id: "p2-undertow-rumble-4", run_id: IDS.failed, covered: 23, total: 23, plans: 4, newest: true, exhausted: ["T2", "T3"] };
    },
  });
  try {
    const next = container.querySelector('[data-roko="build-next"]');
    assert.match(text(next), /Phase 2 stopped \(failed\)\. Task 2 and Task 3 failed even on the strongest model, so roko says to split or replan them; then resume it, and only what is left runs\./);
    await click(buttons(next).find((b) => text(b) === "plan phase 2 again"));
    const dialog = container.querySelector('[data-roko="composer"]');
    assert.match(text(dialog.querySelector('[data-roko="composer-spec"]')), /docs\/specs\/phase-2-rumble\.md/);
    assert.equal(dialog.querySelector("textarea").value, "The plan p2-undertow-rumble-4 stopped: T2 and T3 failed their checks on the ladder's last rung. Split them into smaller tasks, or plan them another way.");
  } finally {
    await cleanup();
  }
});

test("v8 P-41: the plan sheet shows roko's validator notes, its code and its words", async () => {
  const message = "T2's check `tools/spec.sh 2_2 gain 'P2.2.03*'` needs core/src/gain.cpp, which only T3 writes";
  const { container } = await setup({
    url: "http://localhost/roko?section=plans&plan=" + IDS.plan,
    edit: (fx) => { fx.plan_details[IDS.plan].plan.validator_notes = [{ rule: "PLAN_058", task_id: "T2", message: message }]; },
  });
  try {
    const notes = container.querySelector('[data-roko="validator-notes"]');
    assert.ok(notes, "the validator's notes");
    assert.match(text(notes), /roko's validator notes/);
    assert.ok(text(notes).includes("PLAN_058 T2: " + message));
  } finally {
    await cleanup();
  }
});

test("roko 7c3b523a8: the plan sheet lists roko's repairs to its planner's draft, in roko's words, code as code", async () => {
  const line = "T1: `core/src/envelope.h` became `core/include/undertow/envelope.h` in its files and its text";
  const { container } = await setup({
    url: "http://localhost/roko?section=plans&plan=" + IDS.plan,
    edit: (fx) => { fx.plan_details[IDS.plan].plan.repairs = [line, "dropped context files that do not exist: `docs/old.md`"]; },
  });
  try {
    const repairs = container.querySelector('[data-roko="plan-repairs"]');
    assert.ok(repairs, "roko's repairs");
    assert.match(text(repairs), /roko repaired the draft/);
    assert.deepEqual([...repairs.querySelectorAll("li")].map((li) => text(li)), [
      "T1: core/src/envelope.h became core/include/undertow/envelope.h in its files and its text",
      "dropped context files that do not exist: docs/old.md",
    ]);
    assert.equal(repairs.querySelectorAll("li code").length, 3);
  } finally {
    await cleanup();
  }
});

test("v8 P-1: the plan sheet shows what the chat asked roko for, labelled as the chat model's words", async () => {
  const reworded = "Create a roko plan for a macOS VST3 synthesizer plugin. The plan should cover product definition. Constraints: only write the plan. Cap planning spend at $0.40 total.";
  const { container } = await setup({
    url: "http://localhost/roko?section=plans&plan=" + IDS.plan,
    edit: (fx) => { fx.plan_details[IDS.plan].plan.asked = { text: reworded, spec_path: null, by: "chat", run_id: "w-1", at: new Date().toISOString() }; },
  });
  try {
    const asked = container.querySelector('[data-roko="plan-asked"]');
    assert.ok(asked, "what was asked");
    assert.match(text(asked), /what the chat asked roko/);
    assert.match(text(asked), /the chat model's words, as Hermes sent them/);
    assert.equal(text(asked.querySelector(".rk-asked-text")), reworded);
  } finally {
    await cleanup();
  }
});

test("P-43: the plan sheet says what writing the plan cost of its cap, after the writing ended", async () => {
  const { container } = await setup({
    url: "http://localhost/roko?section=plans&plan=" + IDS.plan,
    edit: (fx) => { fx.plan_details[IDS.plan].plan.asked = { text: null, spec_path: "docs/specs/phase-3-sequencer.md", by: "chat", run_id: "w-3", at: new Date().toISOString(), cost_usd: 0.04, max_usd: 0.5 }; },
  });
  try {
    const cap = container.querySelector('[data-roko="plan-asked-cap"]');
    assert.ok(cap, "what writing the plan cost");
    assert.equal(text(cap), "writing it cost $0.04 of its $0.50 cap");
  } finally {
    await cleanup();
  }
});

test("P-38: roko's estimate counts down from when roko made it, and past it says so", async () => {
  const at = (minutesAgo) => new Date(Date.now() - minutesAgo * 60000).toISOString();
  const hhmm = (iso) => new Date(iso).toTimeString().slice(0, 5);
  const made = at(5);
  const { container } = await setup({
    url: runUrl(IDS.live),
    edit: (fx) => { Object.assign(fx.runs[IDS.live].run, { eta_minutes: 12, eta_at: made }); },
  });
  try {
    // On the glass, two short lines; the whole of it on hover.
    const eta = container.querySelector('[data-roko="card-eta"]');
    assert.equal(text(eta), "~7 min left est. " + hhmm(made));
    assert.match(eta.getAttribute("title"), new RegExp("≈ 7 min left · est\\. " + hhmm(made)));
  } finally {
    await cleanup();
  }
  const old = at(18);
  const again = await setup({
    url: runUrl(IDS.live),
    edit: (fx) => { Object.assign(fx.runs[IDS.live].run, { eta_minutes: 12, eta_at: old }); },
  });
  try {
    const eta = again.container.querySelector('[data-roko="card-eta"]');
    assert.match(text(eta), /^past estimate/);
    assert.match(eta.getAttribute("title"), new RegExp("past roko's estimate from " + hhmm(old)));
  } finally {
    await cleanup();
  }
});

test("roko's estimate as a range (roko bcce6c05c): likely and up to, from when, what it rests on, and past the likely time", async () => {
  const at = (minutesAgo) => new Date(Date.now() - minutesAgo * 60000).toISOString();
  const hhmm = (iso) => new Date(iso).toTimeString().slice(0, 5);
  const made = at(5);
  const cases = [
    [{ eta_p90_minutes: 80, eta_at: made, eta_basis: { source: "history", tasks: 9, runs: 12 } }, "≈ 28 min left, up to 75 · est. " + hhmm(made) + " · from 12 runs"],
    [{ eta_p90_minutes: 80, eta_at: made, eta_basis: { source: "guess", tasks: 0, runs: 0 } }, "≈ 28 min left, up to 75 · est. " + hhmm(made) + " · a guess"],
    [{ eta_p90_minutes: 87, eta_at: at(40), eta_basis: { source: "history", tasks: 9, runs: 12 } }, "past roko's likely time · up to 47 min left"],
  ];
  for (const [fields, words] of cases) {
    const { container } = await setup({
      url: runUrl(IDS.live),
      edit: (fx) => { Object.assign(fx.runs[IDS.live].run, { eta_minutes: 33, ...fields }); },
    });
    try {
      assert.equal(container.querySelector('[data-roko="card-eta"]').getAttribute("title"), words);
    } finally {
      await cleanup();
    }
  }
});

test("phase 2's S2 stills: a live run's row reads its spend as its header does", async () => {
  const { container } = await setup({
    url: runUrl(IDS.live),
    edit: (fx) => {
      fx.runs[IDS.live].run.cost_usd = 0.732;
      fx.overview.runs.find((r) => r.run_id === IDS.live).cost_usd = 0.732;
    },
  });
  try {
    const card = await onRuns(container, IDS.live);
    assert.equal(text(card.querySelector('[data-roko="card-spent"] .rk-dots .rk-sr')), "spent $0.73 of $1.00");
  } finally {
    await cleanup();
  }
});

test("v8 #3: no Build tab for a project without a build", async () => {
  const { container } = await setup({ url: runUrl(IDS.live) });
  try {
    assert.ok(!buttons(container).some((b) => b.getAttribute("role") === "tab" && text(b).startsWith("Build")), "no Build tab");
  } finally {
    await cleanup();
  }
});

test("v8 #4: a run's Time tab draws its tasks as lanes, each try its phases, the critical path and the run's split", async () => {
  const at = (offset) => new Date(Date.now() - 600000 + offset).toISOString();
  const phases = (model, tools, checks, extra = {}) => ({ basis: "roko", split: true, prompt_ms: 30, model_ms: model, tools_ms: tools, checks_ms: checks, other_ms: 10, model_calls: 3, tool_calls: 2, tools: [], checks: [], ...extra });
  const timed = (attempt, outcome, start, timing) => tryOn(attempt, "cheap", "gpt-oss-120b", attempt === 1 ? "start" : "retry", outcome, { started_at: at(start), duration_ms: 40 + timing.model_ms + timing.tools_ms + timing.checks_ms, timing });
  const { container } = await setup({
    url: runUrl(IDS.live, "&view=time"),
    edit: (fx) => {
      climbEdit(fx);
      const card = fx.runs[IDS.live].run;
      card.started_at = at(0);
      card.tasks.forEach((t) => { t.climb = []; });
      card.tasks.find((t) => t.task_id === "T1").climb = [timed(1, "passed", 1000, phases(20000, 5000, 10000))];
      card.tasks.find((t) => t.task_id === "T2").climb = [timed(1, "failed", 40000, phases(10000, 2000, 6000)), timed(2, "passed", 60000, phases(13072, 0, 2000, { split: false }))];
    },
  });
  try {
    const view = container.querySelector('[data-roko="time-view"]');
    assert.ok(view, "the time view");
    const lanes = [...view.querySelectorAll(".rk-tl-lane")];
    assert.deepEqual(lanes.map((lane) => text(lane.querySelector(".rk-tl-name b"))), ["T1", "T2"]);
    const t2 = [...lanes[1].querySelectorAll(".rk-tl-try")];
    assert.deepEqual(t2.map((x) => x.getAttribute("data-outcome")), ["failed", "passed"]);
    assert.deepEqual([...t2[0].querySelectorAll("i")].map((i) => i.getAttribute("data-kind")), ["model", "tools", "checks", "other"]);
    // An older roko's try, model and tools not split: one span, never "the model took 13 s".
    assert.deepEqual([...t2[1].querySelectorAll("i")].map((i) => i.getAttribute("data-kind")), ["agent", "checks", "other"]);
    assert.match(t2[1].getAttribute("title"), /model and tools 13s/);
    assert.deepEqual(lanes.map((lane) => lane.getAttribute("data-critical")), ["true", "true"]);
    const split = view.querySelector('[data-roko="time-split"]');
    assert.match(text(split), /critical path T1 → T2/);
    assert.match(text(split), /1 try did not split model from tools \(a roko before f407b62e9\)/);
  } finally {
    await cleanup();
  }
});

test("v8 #4: the horizon shows the spec gate's progress before any agent runs", async () => {
  const { container } = await setup({
    url: runUrl(IDS.live),
    edit: (fx) => {
      const card = fx.runs[IDS.live].run;
      card.tasks.forEach((t) => { t.outcome = "pending"; t.step = null; });
      card.checking = null;
      card.spec_gate = { state: "running", steps_total: 8, steps_done: 5, cached: 2, passed: 0, ms: 40000, elapsed_ms: null, blocked: null, started_at: new Date().toISOString() };
    },
  });
  try {
    const gate = container.querySelector('[data-roko="spec-gate"]');
    assert.ok(gate, "the spec gate on the horizon");
    assert.match(text(gate), /spec gate · 5\/8 steps · 2 cached/);
    assert.equal(gate.querySelector(".rk-sg-bar i").style.width, "62.5%");
  } finally {
    await cleanup();
  }
});

test("v8 #7: an ended run shows what its work added: its UI shots, a sound's waveform with a play key, a report's verdict", async () => {
  const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAADklEQVR4nGMQQAIMODkALAcCQaqvfAkAAAAASUVORK5CYII=";
  const { container, backend } = await setup({
    url: runUrl(IDS.prompt),
    edit: (fx) => {
      fx.artifacts = {
        [IDS.prompt]: {
          ok: true,
          commit: "d66293e36e22",
          items: [
            { path: "artifacts/ui/editor-idle.png", name: "editor-idle.png", kind: "image", bytes: 812000, width: 1200, height: 760 },
            { path: "artifacts/audio/init.wav", name: "init.wav", kind: "audio", bytes: 4300000, audio: { seconds: 15, rate: 48000, bits: 24, channels: 2, peaks: Array.from({ length: 240 }, (_, i) => (i < 120 ? 0.5 : 0)) } },
            { path: "artifacts/reports/auval.txt", name: "auval.txt", kind: "report", bytes: 300, verdict: "failed", line: "AU VALIDATION FAILED: 1 test failed" },
          ],
        },
      };
      fx.artifact_files = { "artifacts/ui/editor-idle.png": { ok: true, path: "artifacts/ui/editor-idle.png", mime: "image/png", data: PNG } };
    },
  });
  try {
    const strip = container.querySelector('[data-roko="run-made"]');
    assert.ok(strip, "the strip");
    const shot = strip.querySelector('img[alt="editor-idle.png, 1200 × 760"]');
    assert.ok(shot, "the shot");
    assert.equal(shot.getAttribute("src"), "data:image/png;base64," + PNG.replace(/-/g, "+").replace(/_/g, "/"));
    const sound = strip.querySelector('[data-roko="made-init.wav"]');
    assert.match(text(sound), /15s · 48 kHz · 24-bit/);
    const bars = [...sound.querySelectorAll(".rk-made-wave i")];
    assert.equal(bars.length, 60);
    assert.equal(bars[0].style.height, "50%");
    assert.ok(!backend.calls.some((c) => c.url.includes("artifact?path=artifacts%2Faudio")), "no sound fetched before the press");
    await click(button(sound, "play init.wav"));
    assert.ok(backend.calls.some((c) => c.url.includes("artifact?path=artifacts%2Faudio%2Finit.wav")), "the press asks for the sound");
    const report = strip.querySelector('[data-roko="made-auval.txt"]');
    assert.equal(report.getAttribute("data-verdict"), "failed");
    assert.match(text(report), /AU VALIDATION FAILED: 1 test failed/);
  } finally {
    await cleanup();
  }
});

test("phase 4 prep A: a shot opens large, with its name and size, and ←/→ to the run's other shots", async () => {
  const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAADklEQVR4nGMQQAIMODkALAcCQaqvfAkAAAAASUVORK5CYII=";
  const shots = [
    { path: "artifacts/ui/editor-clipping.png", name: "editor-clipping.png", kind: "image", bytes: 152392, width: 1200, height: 760 },
    { path: "artifacts/ui/editor-idle.png", name: "editor-idle.png", kind: "image", bytes: 119209, width: 1200, height: 760 },
  ];
  const { container } = await setup({
    url: runUrl(IDS.prompt),
    edit: (fx) => {
      fx.artifacts = { [IDS.prompt]: { ok: true, commit: "d66293e36e22", items: shots } };
      fx.artifact_files = Object.fromEntries(shots.map((s) => [s.path, { ok: true, path: s.path, mime: "image/png", data: PNG }]));
    },
  });
  try {
    const strip = container.querySelector('[data-roko="run-made"]');
    await click(button(strip, "Open editor-clipping.png large"));
    let dialog = container.querySelector('[data-roko="shot-dialog"]');
    assert.ok(dialog, "the dialog");
    assert.match(text(dialog), /editor-clipping\.png/);
    assert.match(text(dialog), /1200 × 760 · 149 KB · 1 of 2/);
    assert.ok(dialog.querySelector('img[alt="editor-clipping.png"]'), "the shot, large");
    await press("ArrowRight");
    dialog = container.querySelector('[data-roko="shot-dialog"]');
    assert.match(text(dialog), /editor-idle\.png/);
    assert.match(text(dialog), /2 of 2/);
  } finally {
    await cleanup();
  }
});

test("phase 4 prep B: an image the run added under artifacts/ shows in Changes; another binary file keeps its note", async () => {
  const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAADklEQVR4nGMQQAIMODkALAcCQaqvfAkAAAAASUVORK5CYII=";
  const { container } = await setup({
    url: runUrl(IDS.prompt, "&view=changes"),
    edit: (fx) => {
      fx.diffs[IDS.prompt].diff.files.push(
        { path: "artifacts/ui/editor-idle.png", old_path: null, status: "added", additions: 0, deletions: 0, binary: true, language: null, truncated: false, hunks: [] },
        { path: "assets/logo.png", old_path: null, status: "added", additions: 0, deletions: 0, binary: true, language: null, truncated: false, hunks: [] },
      );
      fx.artifact_files = { "artifacts/ui/editor-idle.png": { ok: true, path: "artifacts/ui/editor-idle.png", mime: "image/png", data: PNG } };
    },
  });
  try {
    const shot = container.querySelector('img[alt="artifacts/ui/editor-idle.png"]');
    assert.ok(shot, "the image, in Changes");
    assert.equal(shot.getAttribute("src"), "data:image/png;base64," + PNG);
    assert.equal((text(container).match(/A binary file: roko does not show its contents\./g) || []).length, 1);
  } finally {
    await cleanup();
  }
});

test("phase 4 prep C: a passed phase's pad shows its first UI shot, its bytes from the backend", async () => {
  const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAADklEQVR4nGMQQAIMODkALAcCQaqvfAkAAAAASUVORK5CYII=";
  const { container, backend } = await setup({
    url: "http://localhost/roko?section=build",
    edit: (fx) => {
      fx.build = undertowBuild();
      fx.build.phases[0].shot = { run_id: IDS.prompt, path: "artifacts/ui/editor-idle.png", bytes: 119209 };
      fx.artifact_files = { "artifacts/ui/editor-idle.png": { ok: true, path: "artifacts/ui/editor-idle.png", mime: "image/png", data: PNG } };
    },
  });
  try {
    const shot = container.querySelector('[data-roko="phase-0"] img[alt="Phase 0: editor-idle.png"]');
    assert.ok(shot, "the pad's shot");
    assert.equal(shot.getAttribute("src"), "data:image/png;base64," + PNG);
    assert.equal(backend.calls.filter((c) => c.url.includes("/artifact?path=")).length, 1);
    // One shot is no reel (wow 1): its pad keeps it.
    assert.equal(container.querySelector('[data-roko="build-reel"]'), null);
  } finally {
    await cleanup();
  }
});

test("P-50: a phase whose plan branch was merged into main by hand reads merged on its pad", async () => {
  const { container } = await setup({
    url: "http://localhost/roko?section=build",
    edit: (fx) => {
      fx.build = undertowBuild();
      fx.build.phases.push({ n: 4, name: "the phosphor editor", goal: null, spec: "docs/specs/phase-4-ui.md", plan_id: "p4-undertow-phosphor-editor", state: "merged", ended: "run cancelled", tasks: { passed: 5, total: 7 }, runs: 2, run_id: IDS.done, writing_id: null, cost_usd: 2.61, writing_usd: 0.2, wall_ms: 3600000, coverage: { total: 11, covered: 11, missing: [] }, roko_coverage: { kept: 12, total: 12 }, rungs: null, plans: 1, newest: true });
    },
  });
  try {
    const pad = container.querySelector('[data-roko="phase-4"]');
    assert.ok(pad, "the pad");
    assert.equal(pad.querySelector(".rk-phase-word").textContent, "merged by hand · run cancelled");
    assert.equal(pad.querySelector(".rk-phase-word").getAttribute("data-ch"), "pass");
    assert.equal(container.querySelector('[data-roko="phase-cover-4"]'), null, "built, as a passed pad is: no checks line");
  } finally {
    await cleanup();
  }
});

test("P-52: a rung roko skips reads skipped in roko's words on the ladder", async () => {
  const said = "skipped until 20:33: its tool-use probe failed: insufficient_credits: http 402; a task that would start on it starts on the next rung that runs";
  const rung = (name, model, extra) => Object.assign({ rung: name, model: model, slug: model, provider: null, price_in: null, price_out: null, chat_ok: true, why_not: null, starts: [] }, extra || {});
  const { container } = await setup({
    url: runUrl(IDS.prompt),
    edit: (fx) => {
      Object.assign(fx.runs[IDS.prompt].run, {
        ladder: [rung("cheap", "gpt-oss-120b", { chat_ok: false, skipped: true, why_not: said }), rung("mid", "gpt-5.4-mini", { starts: ["integrative", "mechanical"] }), rung("strong", "gpt-5.4")],
        ladder_from: "config",
      });
    },
  });
  try {
    const cheap = container.querySelector('.rk-rung[data-rung="cheap"]');
    assert.ok(cheap, "the cheap rung");
    assert.equal(cheap.getAttribute("data-off"), "true");
    assert.equal(cheap.querySelector(".rk-rail-note").textContent, said);
    assert.equal(cheap.querySelector(".rk-rail-note").getAttribute("title"), said);
    assert.ok(cheap.getAttribute("aria-label").includes(said), cheap.getAttribute("aria-label"));
  } finally {
    await cleanup();
  }
});

test("P-46: an ended run's ladder is the one it ran on, each rung with what it spent", async () => {
  const rung = (name, model, spent, refused) => ({ rung: name, model: model, slug: model, provider: null, price_in: null, price_out: null, chat_ok: true, why_not: null, starts: [], spent_usd: spent, refused_usd: refused || null });
  const { container } = await setup({
    url: runUrl(IDS.prompt),
    edit: (fx) => {
      Object.assign(fx.runs[IDS.prompt].run, { ladder: [rung("mid", "glm-4.7", 0.873042, 0.207559), rung("strong", "gpt-5.4-mini", 0.035439)], ladder_from: "run" });
    },
  });
  try {
    const display = container.querySelector('[data-roko="run-models"]');
    assert.match(text(display.querySelector(".rk-panel-h")), /as it ran: cheapest first/);
    assert.match(text(display), /\$0\.87 spent/);
    // roko bug-8bcd98: what a provider refused of the rung's calls, apart under its spend (the lead).
    const prices = (name) => [...container.querySelectorAll('.rk-rung[data-rung="' + name + '"] .rk-rung-p')].map(text);
    assert.deepEqual(prices("mid"), ["$0.87 spent", "incl. $0.21 refused"]);
    assert.deepEqual(prices("strong"), ["$0.04 spent"]);
    assert.ok(!/claude-sonnet-4-6/.test(text(display)), "no rung of today's roko.toml");
  } finally {
    await cleanup();
  }
});

test("bug-390e4b: a provider roko went on without says so in roko's words under the title and on its rung", async () => {
  const zai = "zai: Insufficient balance or no resource package. Please recharge. (code 1113): recharge, or the ladder runs without it until 07:12";
  const usage = "<b>codex</b>: You've hit your usage limit. (code usage_limit): skipped until 09:30";
  const until = Date.now() + 30 * 60_000;
  const hhmm = new Date(until).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).slice(0, 5);
  const rung = (name, model, provider) => ({ rung: name, model: model, slug: model, provider: provider, price_in: null, price_out: null, chat_ok: true, why_not: null, starts: [] });
  const { container } = await setup({
    url: runUrl(IDS.prompt),
    edit: (fx) => {
      Object.assign(fx.runs[IDS.prompt].run, {
        ladder: [rung("mid", "glm-4.7", "zai"), rung("strong", "gpt-5.4-mini", "openai")],
        provider_exhausted: [
          { provider: "codex", model: "gpt-5.4", billing: false, reason: null, until_ms: null, detail: usage, at: null },
          { provider: "zai", model: "glm-4.7", billing: true, reason: "Insufficient balance", until_ms: until, detail: zai, at: null },
        ],
      });
    },
  });
  try {
    const lines = Array.from(container.querySelectorAll('[data-roko="provider-out"]'));
    // roko's line as it is, as plain text: a provider's words never become markup.
    assert.deepEqual(lines.map((line) => line.textContent), ["⊘ " + usage, "⊘ " + zai]);
    assert.ok(!lines[0].innerHTML.includes("<b>"));
    const note = container.querySelector('[data-roko="ladder-out-mid"]');
    assert.equal(note && note.textContent, "⊘ no credit · until " + hhmm);
    assert.equal(note.getAttribute("title"), zai);
    assert.equal(container.querySelector('[data-roko="ladder-out-strong"]'), null);
  } finally {
    await cleanup();
  }
});

test("v8 P-18: a failover tag stays inside its rail, and once its task passed it says so in the past", async () => {
  const { container } = await setup({
    url: runUrl(IDS.live),
    edit: (fx) => {
      climbEdit(fx);
      const task = fx.runs[IDS.live].run.tasks.find((t) => t.task_id === "T2");
      const failover = { model: "glm-4.7", provider: "zai", class: "circuit_open", why: "failing, so roko paused it" };
      task.outcome = "passed";
      task.climb = [tryOn(1, "cheap", "gpt-oss-120b", "start", "failed"), tryOn(2, "cheap", "gpt-oss-120b", "retry", "failed"), tryOn(3, "mid", "glm-4.7", "failover", "passed", { failover })];
    },
  });
  try {
    const tag = container.querySelector('[data-roko="ladder-failover"]');
    assert.ok(tag, "the passed task's failover tag is drawn");
    assert.equal(text(tag), "⇄ passed after a failover");
    assert.match(tag.getAttribute("title"), /its first pick was passed over \(failing, so roko paused it\)/);
    assert.match(tag.style.maxWidth, /^calc\(100% - /);
  } finally {
    await cleanup();
  }
});

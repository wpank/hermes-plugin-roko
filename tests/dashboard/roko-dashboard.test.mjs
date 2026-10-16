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
    if (method === "GET" && p === "/overview") return fx.overview;
    if (method === "GET" && p === "/pending") return decided && !fx.pending_lag ? { ok: true, items: fx.pending.items.slice(1) } : fx.pending;
    if (method === "GET" && p === "/plans") return fx.plans;
    if (method === "GET" && (m = /^\/plans\/([^/]+)$/.exec(p))) {
      return fx.plan_details[decodeURIComponent(m[1])] || { ok: false, error: { code: "not_found", message: "roko has no plan " + m[1], hint: "list plans first" } };
    }
    if (method === "POST" && (m = /^\/plans\/([^/]+)\/run$/.exec(p))) {
      // What roko's answer changes on the backend's side (a refused plan's validation, say).
      if (fx.on_plan_run) fx.on_plan_run(fx);
      return fx.plan_started || { ok: true, run_id: fx.started.run_id, state: "running", queue_position: null };
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
    if (method === "POST" && p === "/runs") return fx.started;
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
    throw new Error("404: no fake route for " + method + " " + p);
  }
  return { fetchJSON, calls, fx };
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
async function openRunTab(container, label) {
  const tab = [...container.querySelectorAll(".roko-runtab")].find((b) => text(b).startsWith(label));
  assert.ok(tab, "no run tab " + label);
  await click(tab);
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

// --------------------------------------------------------------------------------
// Registration, the header, the run list
// --------------------------------------------------------------------------------

test("registers the roko page and its five slots, with registerSlot(plugin, slot, component)", async () => {
  const backend = makeBackend();
  const registry = loadBundle(backend);
  assert.equal(typeof registry.pages.roko, "function");
  const slots = registry.slots.map((s) => [s.plugin, s.slot, typeof s.component]);
  assert.deepEqual(slots, [
    ["roko", "header-right", "function"],
    ["roko", "sessions:top", "function"],
    ["roko", "chat:top", "function"],
    ["roko", "analytics:top", "function"],
    ["roko", "models:top", "function"],
  ]);
});

test("the header shows the connection and today's spend; runs are grouped Live, Today", async () => {
  // The fixture's ended runs started up to 95 minutes before now: just after midnight some would be yesterday's.
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const { container } = await setup({
    edit: (fx) => {
      for (const run of fx.overview.runs) {
        if (Date.parse(run.started_at) < midnight.getTime()) run.started_at = midnight.toISOString();
      }
    },
  });
  try {
    const head = text(container.querySelector('[data-roko="status"]'));
    assert.match(head, /roko 0\.1\.0 · ok/);
    assert.match(head, /today \$0\.48 of \$20\.00/);
    assert.match(head, /\$1\.46 committed/);
    assert.ok(button(container, "New run"), "a New run button");
    const groups = [...container.querySelectorAll(".roko-rungroup-head")].map((g) => text(g));
    assert.deepEqual(groups.map((g) => g.replace(/\d+$/, "").trim()), ["Live", "Today"]);
    assert.equal(container.querySelectorAll(".roko-rungroup")[0].querySelectorAll(".roko-runitem").length, 2);
  } finally {
    await cleanup();
  }
});

// --------------------------------------------------------------------------------
// A live run: hero, now, graph, inspector
// --------------------------------------------------------------------------------

test("a live plan run: the hero's instruments, the now strip and the graph's states", async () => {
  const { container, backend } = await setup({ url: runUrl(IDS.live) });
  try {
    const hero = container.querySelector('[data-roko="hero"]');
    assert.match(text(hero), /running/i);
    assert.match(text(hero), /plan · 5 tasks/);
    assert.match(text(hero), /Add per-category budgets to tally/);
    assert.equal(hero.querySelector(".roko-ring-label").textContent, "2/5", "2 of 5 tasks passed");
    assert.match(text(hero), /\$0\.037/);
    assert.match(text(hero), /≈ 3 min left/);
    assert.match(text(container.querySelector(".roko-now")), /T2 agent · glm-5\.1 \d+:\d\d/);
    const states = Object.fromEntries(["T1", "T2", "T3", "T4", "T5"].map((id) => [id, node(container, id).getAttribute("data-state")]));
    assert.deepEqual(states, { T1: "passed", T2: "running", T3: "pending", T4: "passed", T5: "pending" });
    assert.match(node(container, "T3").getAttribute("aria-label"), /^T3, waiting/);
    assert.match(text(node(container, "T5")), /after T2, T3/);
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
      assert.match(text(node(container, id)), /blocked by T1/);
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
    assert.match(text(container.querySelector('[data-roko="hero"]')), /3 passed/);
    assert.doesNotMatch(text(container.querySelector('[data-roko="hero"]')), /did not pass/);
  } finally {
    await cleanup();
  }
});

test("a run roko has no record of is shown as missing, never as a success", async () => {
  const { container } = await setup({ url: runUrl(IDS.missing) });
  try {
    const item = container.querySelector(`[data-roko-runitem="${IDS.missing}"]`);
    assert.ok(item.className.includes("roko-edge-warn"));
    assert.match(text(container.querySelector('[data-roko="why"]')), /Where this run went.*no record of this run/);
    assert.ok(text(item).includes("— of $0.25"), "unknown cost is —, not $0.00");
    assert.ok(!text(item).includes("$0.00"));
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
    assert.match(text(container.querySelector(".roko-latest")), /At this moment/i);
    await click(button(container, "Show the end"));
    assert.equal(container.querySelector(".roko-graph.is-replaying"), null);
  } finally {
    await cleanup();
  }
});

test("Activity: every line, relative times, filters by kind, agent notes as quotes", async () => {
  const { container } = await setup({ url: runUrl(IDS.failed) });
  try {
    await click(buttons(container).find((b) => b.getAttribute("role") === "tab" && text(b).startsWith("Activity")));
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
    // The run's tab shows the size of the change.
    assert.match(text(buttons(container).find((b) => b.getAttribute("role") === "tab" && text(b).startsWith("Changes"))), /\+299 −5/);
  } finally {
    await cleanup();
  }
});

test("Merge: a guarded dialog, the reviewed commit in the request, then the undo command", async () => {
  const { container, backend } = await setup({ url: runUrl(IDS.prompt, "&view=changes") });
  try {
    assert.match(text(container.querySelector(".roko-mergebox")), /Ready to merge into main fast-forward · 243489f/);
    assert.equal(posts(backend, "/merge").length, 0);
    await click(button(container, "Merge run " + IDS.prompt.slice(0, 8)));
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
    assert.match(text(container), /Merged run 3982fef0 into main/);
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
    await click(button(container, "Merge run " + IDS.prompt.slice(0, 8)));
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
    assert.equal(blocked.container.querySelector('button[aria-label^="Merge run"]'), null);
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
    assert.equal(container.querySelector('button[aria-label^="Merge run"]'), null);
    assert.ok(!backend.calls.some((c) => c.url === "/api/plugins/roko/runs/" + IDS.multiwave + "/merge"), "no merge check for a demo");
    await openRunTab(container, "Overview");
    assert.match(text(container.querySelector(".roko-delivered")), /demo output, stays on its branch/);
  } finally {
    await cleanup();
  }
});

test("an interrupted run (roko stopped mid-run) reads as its own outcome: its reason, what is kept, no Merge", async () => {
  const reason = "roko stopped while this run was going (machine restart or crash)";
  const edit = (fx) => {
    const card = fx.runs[IDS.multiwave].run;
    Object.assign(card, { state: "interrupted", verdict: "interrupted", active: false, interrupted: { reason: reason, at: card.finished_at } });
    fx.overview.runs.forEach((row) => { if (row.run_id === IDS.multiwave) Object.assign(row, { state: "interrupted", active: false }); });
  };
  const { container, backend } = await setup({ url: runUrl(IDS.multiwave), edit: edit });
  try {
    const why = container.querySelector('[data-roko="why"]');
    assert.match(text(why), /roko stopped mid-run/);
    assert.match(text(why), /roko stopped while this run was going \(machine restart or crash\)/);
    assert.match(text(why.querySelector('[data-roko="why-next"]')), /kept on its own branch/);
    assert.match(text(container.querySelector(".roko-delivered")), /interrupted: kept on its branch/);
    await openRunTab(container, "Changes");
    assert.match(text(container.querySelector('[data-roko="interrupted-output"]')), /Nothing verified to merge/);
    assert.equal(container.querySelector('button[aria-label^="Merge run"]'), null);
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
    assert.deepEqual(Array.from(dialog.querySelectorAll(".rk-module-idx")).map(text), ["01", "02", "03", "04"]);
    await click(dialog.querySelector(".roko-example"));
    assert.match(dialog.querySelector("textarea").value, /--json flag/);
    await typeInto(dialog.querySelector("textarea"), "Add a --json flag to tally's balance command, with a test");
    await typeInto(dialog.querySelector('input[aria-label="Title"]'), "JSON balances");
    await click(buttons(dialog).find((b) => text(b) === "$1.00"));
    await click(dialog.querySelector('[data-roko="composer-submit"]'));
    const sent = posts(backend, "/runs");
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].body, { prompt: "Add a --json flag to tally's balance command, with a test", title: "JSON balances", max_usd: 1 });
    assert.equal(container.querySelector('[data-roko="composer"]'), null, "closed");
    assert.ok(backend.calls.some((c) => c.url === "/api/plugins/roko/runs/" + backend.fx.started.run_id), "the new run opens");
    assert.match(text(container), /Started run 11111111/);
  } finally {
    await cleanup();
  }
});

test("Composer: Plan it first posts plan:true with no cap; Ctrl+Enter submits; caps stop at what is left", async () => {
  const { container, backend } = await setup({ edit: (fx) => { fx.overview.spend.left_usd = 0.4; } });
  try {
    await click(button(container, "New run"));
    const dialog = container.querySelector('[data-roko="composer"]');
    const chip = (label) => buttons(dialog).find((b) => text(b) === label);
    assert.ok(chip("$0.50").disabled && chip("$1.00").disabled && !chip("$0.25").disabled, "only caps under $0.40 left");
    assert.equal(chip("$0.25").getAttribute("aria-pressed"), "true", "the default cap fits");
    await click(buttons(dialog).find((b) => b.getAttribute("role") === "radio" && text(b).startsWith("plan first")));
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
    assert.match(text(container.querySelector(".roko-now")), /T1 waits for your sign-off/);
    assert.ok(node(container, "T1").className.includes("is-held"));
    assert.match(text(node(container, "T1")), /waits on you/);
    const card = container.querySelector(".roko-run-waiting [data-roko-pending]");
    assert.ok(card);
    assert.match(text(card), /Is this what you asked for\?/);
    assert.match(text(card.querySelector(".roko-doc-head")), /REPORT\.md/);
  } finally {
    await cleanup();
  }
});

test("orange means you: a run that waits on the person is orange in the list, the hero, its strip and the now label", async () => {
  const { container } = await setup({ url: runUrl(IDS.confirm) });
  try {
    const item = container.querySelector(`[data-roko-runitem="${IDS.confirm}"]`);
    assert.equal(item.getAttribute("data-ch"), "you");
    assert.equal(text(item.querySelector(".rk-state")), "waiting on you");
    assert.ok(item.querySelector('.rk-strip-cell[data-wait="true"][data-ch="you"]'), "its running task is what waits");
    assert.equal(item.querySelector(".rk-led").getAttribute("data-blink"), "fast");
    const hero = container.querySelector('[data-roko="hero"]');
    assert.equal(hero.getAttribute("data-ch"), "you");
    assert.equal(hero.querySelector('[data-roko="hero-waiting"]').getAttribute("data-ch"), "you");
    assert.ok(hero.querySelector('.rk-strip-cell[data-wait="true"]'), "the display's strip");
    assert.equal(container.querySelector(".roko-now-label").getAttribute("data-ch"), "you");
    // A live run that waits on nobody stays blue: the agent's colour.
    const live = container.querySelector(`[data-roko-runitem="${IDS.live}"]`);
    assert.equal(live.getAttribute("data-ch"), "agent");
    assert.equal(live.querySelector('[data-wait="true"]'), null);
  } finally {
    await cleanup();
  }
});

test("Waiting: Approve posts the code, approve and the note; the deadline is roko's", async () => {
  const { container, backend } = await setup({ url: "http://localhost/roko?section=waiting" });
  try {
    const confirm = backend.fx.pending.items.find((i) => i.kind === "confirm");
    const card = container.querySelector(`.roko-waiting [data-roko-pending="${confirm.code}"]`);
    assert.ok(card, "the sign-off is listed");
    assert.match(text(card), /answer within (29|30):\d\d/, "roko's 30-minute wait");
    const effect = backend.fx.pending.items.find((i) => i.kind === "effect");
    const effectCard = container.querySelector(`.roko-waiting [data-roko-pending="${effect.code}"]`);
    assert.match(text(effectCard), /mail\.send on mail/);
    assert.match(text(effectCard), /to: string/);
    assert.doesNotMatch(text(effectCard), /answer within/);
    await typeInto(card.querySelector("input"), "looks right");
    await click(button(card, "Approve " + confirm.code));
    assert.deepEqual(posts(backend, "/decide")[0].body, { code: confirm.code, approve: true, note: "looks right" });
    assert.match(text(container), /Approved the result of task T1/);
    assert.doesNotMatch(text(container), /\(approved\)/, "roko's outcome only when it adds to the verb");
    assert.equal(container.querySelector(`.roko-waiting [data-roko-pending="${confirm.code}"]`), null, "an answered item leaves");
  } finally {
    await cleanup();
  }
});

test("Waiting: Reject posts approve false without an empty note; a passed deadline says so", async () => {
  const { container, backend } = await setup({
    url: "http://localhost/roko?section=waiting",
    edit: (fx) => { fx.pending.items.find((i) => i.kind === "confirm").deadline_at = new Date(Date.now() - 5_000).toISOString(); },
  });
  try {
    const confirm = backend.fx.pending.items.find((i) => i.kind === "confirm");
    const card = container.querySelector(`.roko-waiting [data-roko-pending="${confirm.code}"]`);
    assert.match(text(card), /deadline passed/);
    await click(button(card, "Reject " + confirm.code));
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
    assert.match(text(plan.querySelector(".roko-instruments")), /Tasks 5 Waves 4/);
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

test("Plans: Run plan posts the cap after a confirm, a chip sets the cap, and the new run opens", async () => {
  const { container, backend } = await setup({ url: "http://localhost/roko?section=plans&plan=" + IDS.plan });
  try {
    const form = container.querySelector(".roko-runform");
    assert.equal(text(form.querySelector(".roko-run-limits")), "at most $5.00 per run · $18.06 left today");
    await click(buttons(form).find((b) => text(b) === "$2.00"));
    assert.equal(form.querySelector('input[type="number"]').value, "2.00");
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

test("Plans: the demos come first, the one to start with on top and open; a real plan waits to be picked", async () => {
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
    assert.deepEqual([...plans.querySelectorAll(".roko-rungroup-head")].map((el) => text(el.firstChild)), ["Demos", "Your plans", "tally-programme"]);
    assert.deepEqual([...plans.querySelectorAll(".roko-runitem-label")].map(text), [
      "Start here: hello world demo",
      "Roko plan-runner demo",
      "Per-category budgets for tally",
      "Per-category budgets for tally",
    ]);
    const first = plans.querySelector('[data-roko-plan="demo-hello-world"]');
    assert.match(text(first), /start here/);
    assert.match(text(first), /demo/, "a demo says so instead of roko's fixture marker");
    assert.doesNotMatch(text(first), /fixture/);
    assert.equal(first.getAttribute("aria-current"), "true");
    assert.match(text(container.querySelector('[data-roko="plan"]')), /Start here: hello world demo/);
    assert.ok(!backend.calls.some((c) => c.url.indexOf("/plans/project-") >= 0), "no real plan opened");
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
  const heads = (c) => [...c.querySelectorAll('[data-roko="plan-list"] .roko-rungroup-head')].map((el) => text(el.firstChild));
  const labels = (c) => [...c.querySelectorAll('[data-roko="plan-list"] .roko-runitem-label')].map(text);
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
    assert.match(text(container.querySelector('[data-roko="plan-pick"]')), /Pick a plan/);
    assert.equal(container.querySelector('[data-roko="plan"]'), null);
    assert.ok(!backend.calls.some((c) => c.url.indexOf("/plans/project-") >= 0));
    await click(container.querySelector('[data-roko-plan="' + IDS.plan + '"]'));
    assert.ok(container.querySelector('[data-roko="plan"]'), "the picked plan opens");
  } finally {
    await cleanup();
  }
});

test("Plans: an invalid cap cannot be submitted", async () => {
  const { container } = await setup({ url: "http://localhost/roko?section=plans&plan=" + IDS.plan });
  try {
    const form = container.querySelector(".roko-runform");
    const cap = form.querySelector('input[type="number"]');
    await typeInto(cap, "0");
    assert.match(text(form), /at least \$0\.01/);
    assert.ok(button(form, "Run plan…").disabled);
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
    assert.match(kpis[0], /^01 Tasks that passed 59% 17 tasks recorded/);
    assert.match(kpis[2], /^03 Spend \$0\.48/);
    assert.match(kpis[3], /^04 Checks passing 79% 23 of 29 checks that ran/);
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
    await openTab(container, "Knowledge");
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

test("keys: j and k move through the runs, [ and ] through the run's tabs, digits through sections, ? lists them", async () => {
  const { container } = await setup({ url: runUrl(IDS.multiwave) });
  try {
    const selected = () => container.querySelector(".roko-runitem.is-selected").getAttribute("data-roko-runitem");
    assert.equal(selected(), IDS.multiwave);
    await press("j");
    assert.equal(selected(), IDS.prompt);
    await press("k");
    await press("k");
    assert.equal(selected(), IDS.missing);
    await press("]");
    assert.equal(text(container.querySelector(".roko-runtab.is-on")).split(/\s/)[0], "Activity");
    await press("[");
    assert.equal(text(container.querySelector(".roko-runtab.is-on")).split(/\s/)[0], "Overview");
    await press("?");
    assert.match(text(container.querySelector('[data-roko="keys"]')), /New run/);
    await press("Escape");
    assert.equal(container.querySelector('[data-roko="keys"]'), null);
    await press("4");
    assert.ok(container.querySelector('[data-roko="loops-section"]'), "4 opens Loops");
    await press("5");
    assert.ok(container.querySelector(".roko-kpis"), "5 opens Insights");
  } finally {
    await cleanup();
  }
});

test("onboarding: with no runs yet, the first steps and example requests that fill the composer", async () => {
  const { container } = await setup({ mode: "empty" });
  try {
    const onboard = container.querySelector('[data-roko="onboarding"]');
    assert.ok(onboard);
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
    assert.equal(changes.container.querySelector('button[aria-label^="Merge run"]'), null);
    assert.match(text(changes.container.querySelector(".roko-mergebox")), /Merging from the dashboard is turned off/);
  } finally {
    await cleanup();
  }
});

test("Cancel run sits behind a confirm and posts /runs/{id}/cancel", async () => {
  const { container, backend } = await setup({ url: runUrl(IDS.live) });
  try {
    await click(button(container, "Cancel run"));
    assert.equal(posts(backend, "/cancel").length, 0);
    await click(container.querySelector('[role="alertdialog"] [data-confirm="yes"]'));
    assert.equal(posts(backend, "/runs/" + IDS.live + "/cancel").length, 1);
    assert.match(text(container), new RegExp("Cancelled run " + IDS.live.slice(0, 8)));
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
  const { container, registry } = await setup({ mode: "unreachable" });
  try {
    const all = text(container);
    assert.ok(all.includes("roko serve unreachable"));
    assert.ok(all.includes("roko serve is not reachable at http://localhost:6677"), "the connection's own message stays");
    // An older backend names no problem: the page derives it, with the start command its hint names as the fix,
    // so the header drops the hint (the desktop's rule, ui-notes U1).
    const derived = container.querySelector('[data-roko="problem-roko-unreachable"]');
    assert.match(text(derived), /Hermes cannot reach roko serve at http:\/\/localhost:6677\./);
    assert.match(text(derived), /roko serve/);
    assert.ok(!text(container.querySelector('[data-roko="status"]')).includes("start it with"), "the hint gives way to the fix");
    // Never LIVE next to "unreachable" (repro-will F4).
    const live = container.querySelector('[data-roko="live-state"]');
    assert.equal(live.getAttribute("data-state"), "offline");
    assert.equal(live.querySelector(".rk-led").getAttribute("data-ch"), "fail");
    assert.match(text(container.querySelector('[data-roko="last-known"]')), /^Showing the last known runs · checked \d\d:\d\d:\d\d; the page asks again every few seconds$/);
    assert.ok(all.includes("Add a --json flag to tally"));
    // A run that was going is its last known state: unlit, still, said so.
    const row = container.querySelector(`[data-roko-runitem="${IDS.live}"]`);
    assert.match(text(row), /last seen running/);
    assert.equal(row.querySelector(".rk-led").getAttribute("data-ch"), "off");
    assert.equal(row.querySelector(".rk-led").getAttribute("data-blink"), null, "no blinking");
    const hero = container.querySelector('[data-roko="hero"]');
    assert.match(text(hero.querySelector('[data-roko="stale"]')), /roko serve is not answering: this is the run's last known state, from \d\d:\d\d:\d\d\. It may still be going, or it stopped when roko did\./);
    assert.match(text(hero.querySelector(".rk-state")), /^last seen running$/);
    assert.match(text(hero.querySelector(".rk-cell--tasks")), /1 was running/, "not \"1 running\": nothing runs that the page can see");
    assert.equal(container.querySelector('[data-roko="ticker"]'), null, "no now strip");
    assert.ok(button(container, "Cancel run").disabled, "roko cannot be asked to stop it");
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
    assert.match(text(chip.container), /offline/);
    assert.equal(chip.container.querySelector(".roko-chip-alert"), null, "the red light says it; no setup tag");
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
    await click(button(container, "Refresh roko's status"));
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

test("header-right chip and sessions:top banner summarise the overview, with the live run's ring", async () => {
  const backend = makeBackend();
  const registry = loadBundle(backend);
  try {
    const chip = await mount(registry.slots.find((s) => s.slot === "header-right").component, { url: "http://localhost/sessions" });
    const link = chip.container.querySelector("a");
    assert.equal(text(link), "roko 2 running · 2 waiting");
    assert.equal(link.getAttribute("href"), "/roko?section=waiting");
    assert.match(link.getAttribute("title"), /2 of 5 tasks done/);
    assert.ok(link.querySelector(".rk-strip"), "the live plan's step strip");
    assert.equal(link.querySelectorAll(".rk-strip-cell").length, 5, "one cell per task");
    const banner = await mount(registry.slots.find((s) => s.slot === "sessions:top").component, { url: "http://localhost/sessions" });
    assert.equal(text(banner.container.querySelector(".roko-banner-text")), "roko: 2 runs running · 2 items wait on you");
    assert.equal(text(banner.container.querySelector(".roko-banner-sub")), "2/5 tasks");
    assert.equal(banner.container.querySelector("a").getAttribute("href"), "/roko?section=waiting");
    let popped = 0;
    window.addEventListener("popstate", () => { popped += 1; }, { once: true });
    await click(banner.container.querySelector("a"));
    assert.equal(window.location.pathname + window.location.search, "/roko?section=waiting");
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

test("live: one socket from SDK.buildWsUrl; hello, overview, run, lines, live and loop frames update the page at once", async () => {
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
    assert.match(head, /today \$0\.61 of \$20\.00/, "the hello frame's overview replaces the poll's");
    assert.match(head, /\blive\b/);

    // An agent's tool step: the ticker shows it within a frame.
    await push(socket, { type: "live", run_id: IDS.live, task_id: "T2", attempt: 1, kind: "tool", tool: "Edit", target: "tally/reports.py", ts: Date.now() });
    assert.match(text(container.querySelector('[data-roko="ticker"]')), /T2 .*▸ Edit tally\/reports\.py/);

    // A new card: T2 passed.
    const card = structuredClone(backend.fx.runs[IDS.live].run);
    const t2 = card.tasks.find((t) => t.task_id === "T2");
    t2.outcome = "passed";
    t2.step = null;
    card.progress = { ...card.progress, passed: 3, running: 0 };
    const callsBefore = backend.calls.length;
    await push(socket, { type: "run", run: card });
    assert.equal(node(container, "T2").getAttribute("data-state"), "passed");
    assert.equal(container.querySelector('[data-roko="hero"] .roko-ring-label').textContent, "3/5");
    assert.equal(backend.calls.length, callsBefore, "the socket's card needs no request");

    // New timeline lines join the activity feed in cursor order.
    const top = Math.max(...backend.fx.events[IDS.live].events.map((e) => e.cursor));
    await push(socket, { type: "lines", run_id: IDS.live, lines: [{ cursor: top + 10, type: "gate_result", group: "gate", task_id: "T2", ts_millis: Date.now(), passed: true, gate: "verify[0:lint]", text: "T2 gate verify[0:lint] passed" }] });
    await openTab(container, "Activity");
    const lines = [...container.querySelectorAll(".roko-feedline")].map((l) => text(l));
    assert.match(lines[lines.length - 1], /T2 gate verify\[0:lint\] passed/);

    // A loop event: on the run's Loops tab, on its ring, on the dial.
    await push(socket, { type: "loop", run_id: IDS.live, ring: "L1", kind: "failover", text: "T3 switched to claude-sonnet-4-6 (failover)", data: {}, task_id: "T3", plan_id: null, ts: Date.now(), key: "failover:T3:2" });
    await openRunTab(container, "Loops");
    const loops = container.querySelector('[data-roko="loops"]');
    assert.ok(loops, "the Loops tab");
    const l1 = [...loops.querySelectorAll(".rk-ringmod")].find((m) => /^L1/.test(text(m.querySelector(".rk-module-head"))));
    assert.match(text(l1), /failover T3 switched to claude-sonnet-4-6 \(failover\)/);
    assert.ok(loops.querySelector('[data-roko="dial"] .rk-tick[data-ch="fail"]'), "a red tick on the dial");
    assert.ok(loops.querySelector(".rk-dial-hand"), "a live run's dial sweeps");
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
    assert.match(ticker(), /T2 .*\u201cReading the report code\.\u201d/);
    // A long stretch shows its end, where the agent is now.
    await push(socket, { ...base, kind: "text", text: " words", said: "word ".repeat(80) + "and the newest words", ts: Date.now() });
    assert.match(ticker(), /\u201c\u2026[^\u201d]*and the newest words\u201d/);
    // ...in a box that keeps its newest end in view when the line is wider than the strip.
    assert.match(text(container.querySelector(".rk-ticker-step.is-words > span")), /and the newest words\u201d$/);
    // The strip above the chat says the same, the same way, for the run it follows.
    const chat = await mount(env.registry.slots.find((s) => s.slot === "chat:top").component, { url: "http://localhost/chat" });
    const followed = new URL(chat.container.querySelector('[data-roko="chatstrip"] a').getAttribute("href"), "http://localhost").searchParams.get("run");
    await push(socket, { ...base, run_id: followed, kind: "text", text: " words", said: "word ".repeat(80) + "and the newest words", ts: Date.now() });
    assert.match(text(chat.container.querySelector(".rk-livestrip-step.is-words > span")), /^T2 \u201c\u2026.*and the newest words\u201d$/);
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

test("the display bar: numbered readouts in dot-matrix with the plain value as text, and the scope while live", async () => {
  const { container } = await setup({ url: runUrl(IDS.live) });
  try {
    const display = container.querySelector('[data-roko="display"]');
    assert.ok(display, "the display bar");
    const labels = [...display.querySelectorAll(".rk-cell-head")].map((h) => text(h));
    assert.deepEqual(labels.slice(0, 4), ["01 TASKS", "02 TIME", "03 SPEND", "04 CHECKS"]);
    assert.match(labels[4], /^05 MODELS?$/);
    const spend = [...display.querySelectorAll(".rk-cell")][2];
    const dots = spend.querySelector(".rk-dots");
    assert.equal(text(dots.querySelector(".rk-sr")), "$0.037");
    assert.equal(dots.querySelector("svg").getAttribute("aria-hidden"), "true");
    assert.ok(dots.querySelectorAll("path.rk-on").length >= 5, "one lit path per glyph");
    assert.equal(spend.querySelectorAll(".rk-segmeter .rk-seg").length, 20, "a 20-segment meter");
    assert.ok(display.querySelector(".rk-scope svg"), "the scope while the run is live");
    const finished = await setup({ url: runUrl(IDS.multiwave) });
    assert.match(text(finished.container.querySelector('[data-roko="display"] .rk-verdict')), /verdict: succeeded/);
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
    assert.match(text(inspector.querySelector(".rk-route-head")), /^L1 picked by the model ladder$/);
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

test("the cap knob: arrows step between the detents roko allows, never past what is left today", async () => {
  const { container, backend } = await setup({ edit: (fx) => { fx.overview.spend.left_usd = 1.5; } });
  try {
    await click(button(container, "New run"));
    const dialog = container.querySelector('[data-roko="composer"]');
    const knob = dialog.querySelector('[role="slider"]');
    assert.equal(knob.getAttribute("aria-valuenow"), "0.5");
    assert.equal(knob.getAttribute("aria-valuemax"), "1", "the $2 and $5 detents are over what is left");
    await press("ArrowRight", knob);
    assert.equal(dialog.querySelector('[role="slider"]').getAttribute("aria-valuenow"), "1");
    await press("ArrowRight", dialog.querySelector('[role="slider"]'));
    assert.equal(dialog.querySelector('[role="slider"]').getAttribute("aria-valuetext"), "$1.00", "stops at the last allowed detent");
    await press("ArrowLeft", dialog.querySelector('[role="slider"]'));
    await press("ArrowLeft", dialog.querySelector('[role="slider"]'));
    assert.equal(dialog.querySelector('[role="slider"]').getAttribute("aria-valuenow"), "0.25");
    await typeInto(dialog.querySelector("textarea"), "Tidy the README");
    await click(dialog.querySelector('[data-roko="composer-submit"]'));
    assert.deepEqual(posts(backend, "/runs")[0].body, { prompt: "Tidy the README", max_usd: 0.25 });
  } finally {
    await cleanup();
  }
});

test("Loops: the five rings with what roko reports for each, and the dial over their events", async () => {
  const { container, backend } = await setup({ url: "http://localhost/roko?section=loops" });
  try {
    assert.ok(backend.calls.some((c) => c.url === "/api/plugins/roko/loops"));
    const section = container.querySelector('[data-roko="loops-section"]');
    assert.ok(section);
    const heads = [...section.querySelectorAll(".rk-ringmod .rk-module-head")].map((h) => text(h));
    assert.deepEqual(heads.map((h) => h.split(" ")[0]), ["L0", "L1", "L2", "L3", "L4"]);
    const rings = [...section.querySelectorAll(".rk-ringmod")];
    assert.match(text(rings[0]), /1 held/);
    assert.match(text(rings[3]), /2 lessons kept/);
    assert.match(text(rings[3]), /glm-5\.1 passes 59% of 17 tasks/);
    const legend = [...section.querySelectorAll(".rk-legend-row")].map((r) => text(r));
    assert.equal(legend.length, 5);
    const events = backend.fx.loops.rings.reduce((n, r) => n + r.recent.length, 0);
    assert.equal(section.querySelectorAll('[data-roko="dial"] .rk-tick').length, events, "one tick per event");
  } finally {
    await cleanup();
  }
});

test("slots: chat:top follows the live run, analytics:top shows spend, checks and the loops, models:top roko's scorecard", async () => {
  const backend = makeBackend();
  const registry = loadBundle(backend);
  try {
    const slot = (name) => registry.slots.find((s) => s.slot === name).component;
    const chat = await mount(slot("chat:top"), { url: "http://localhost/chat" });
    const strip = chat.container.querySelector('[data-roko="chatstrip"]');
    assert.ok(strip, "a strip above the chat while a run is active");
    assert.match(text(strip), /roko/);
    assert.match(strip.querySelector("a").getAttribute("href"), /^\/roko\?run=/);
    assert.ok(strip.querySelector(".rk-strip"), "the run's step strip");
    const analytics = await mount(slot("analytics:top"), { url: "http://localhost/analytics" });
    const card = analytics.container.querySelector('[data-roko="analytics-card"]');
    assert.ok(card);
    assert.match(text(card), /03 SPEND TODAY today \$0\.48 of \$20\.00/);
    assert.match(text(card), /04 CHECKS \d+% of checks passed/);
    assert.match(text(card), /05 MODELS 1 model routed glm-5\.1 · 59% of tasks passed/);
    assert.equal(card.querySelectorAll(".rk-ringled").length, 5);
    const models = await mount(slot("models:top"), { url: "http://localhost/models" });
    assert.match(text(models.container.querySelector('[data-roko="models-card"]')), /glm-5\.1 .*59% of tasks passed 17 tasks/);
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
    const sw = container.querySelector('[role="radiogroup"][aria-label="Sound"]');
    await click([...sw.querySelectorAll('[role="radio"]')].find((b) => text(b) === "on"));
    assert.equal(window.localStorage.getItem("roko.sound"), "on");
    assert.equal(made, 1, "one audio context, made on the person's click");
  } finally {
    await cleanup();
    window.localStorage.removeItem("roko.sound");
    delete window.AudioContext;
  }
});

test("reduced motion: no sweeping hand, the dial still shows every event", async () => {
  const saved = window.matchMedia;
  window.matchMedia = (q) => ({ matches: /prefers-reduced-motion: reduce/.test(q), addEventListener() {}, removeEventListener() {} });
  const { container } = await setup({ url: runUrl(IDS.live, "&view=loops") });
  try {
    const loops = container.querySelector('[data-roko="loops"]');
    assert.ok(loops.querySelector('[data-roko="dial"]'));
    assert.equal(loops.querySelector(".rk-dial-hand"), null);
  } finally {
    await cleanup();
    window.matchMedia = saved;
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
    assert.equal(chip.container.querySelector(".roko-chip-alert"), null);
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
    assert.equal(text(chip.container.querySelector(".roko-chip-alert")), "restart");
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
    assert.ok(button(form, "Run plan…").disabled);
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
    assert.equal(text(chip.container.querySelector(".roko-chip-alert")), "setup");
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
    assert.match(text(route.querySelector(".rk-route-head")), /^L1 picked by what roko learned p 0\.82$/);
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

test("Loops: the rows say who picked a model, each retry budget, and each learning loop's state, in words", async () => {
  const { container } = await setup({
    url: "http://localhost/roko?section=loops",
    edit: (fx) => {
      const ring = (id) => fx.loops.rings.find((r) => r.ring === id);
      ring("L1").routes = [{ ts: new Date().toISOString(), task_id: "T1", model: "gpt-oss-120b", provider: "cerebras", stage: "static", reason: "ladder", source: "ladder", p: 1.0, candidates: [], outcome: true }];
      ring("L1").retry_budgets = [{ rung: "verify[0:test]", ema_pass_rate: 0.92, observations: 30, consecutive_passes: 4, suggested_max_retries: 1, should_skip: false }];
      ring("L4").loops = [
        { loop_id: "L-route", lifecycle: "active", state: "probation", reason: null, h: 0.2, n_opp: 40, eps: 0, iota_net: 0, beta: null },
        { loop_id: "L-know", lifecycle: "active", state: "flagged", reason: "dormant:no_opportunity", h: 0.1, n_opp: 0, eps: null },
      ];
    },
  });
  try {
    const section = container.querySelector('[data-roko="loops-section"]');
    const rows = [...section.querySelectorAll(".rk-mini li")].map((li) => text(li));
    assert.ok(rows.includes("gpt-oss-120b picked by the model ladder · passed"), rows.join(" | "));
    assert.ok(rows.includes("verify[0:test] up to 1 retry · passes 92%"), rows.join(" | "));
    assert.ok(rows.includes("model routing on probation · holdout 20% · reach 0% · 40 decisions"), rows.join(" | "));
    assert.ok(rows.includes("lessons in prompts flagged: no chance to act yet · holdout 10% · 0 decisions"), rows.join(" | "));
    assert.ok(!/\bh 0\.\d\d\b|ε/.test(rows.join(" ")), "no bare symbols in the rows");
  } finally {
    await cleanup();
  }
});

test("Plans: waves and how many run at once agree; Run plan… starts at the composer's $0.50, or covers roko's estimate", async () => {
  const { container } = await setup({ url: "http://localhost/roko?section=plans&plan=" + IDS.plan });
  try {
    const hero = text(container.querySelector('[data-roko="plan"] .roko-hero'));
    assert.match(hero, /Waves 4 each wave waits for the one before/);
    assert.match(hero, /Parallel 2 2 at once/);
    assert.equal(container.querySelector('[data-roko="plan"] .roko-instrument[title]').getAttribute("title"), "2 tasks side by side at most");
    assert.equal(container.querySelector(".roko-runform .roko-capinput").value, "0.50");
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
    assert.match(text(chain.container.querySelector('[data-roko="plan"] .roko-hero')), /Parallel 1 one task at a time/);
    assert.equal(chain.container.querySelector(".roko-runform .roko-capinput").value, "2.00");
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
    const row = container.querySelector(`[data-roko-runitem="${gen}"]`);
    assert.match(text(row), /plan written/);
    assert.ok(!/succeeded/.test(text(row)));
    assert.equal(row.getAttribute("data-ch"), "off");
    assert.equal(text(container.querySelector('[data-roko="hero"] .rk-state')), "plan written");
    // The "planning" badge was the work; once the plan is written it is gone (hero and row).
    assert.equal(container.querySelector('[data-roko="hero"] .roko-kind'), null);
    assert.ok(!/planning/.test(text(row)), text(row));
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
    assert.match(text(container.querySelector('[data-roko="display"]')), /checking the workspace: cargo clippy/);
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
    assert.match(text(dialog), /1 task · 1 wave · roko estimates <\$0\.01 · a demo: its output stays on its run branch/);
    const modules = Array.from(dialog.querySelectorAll(".rk-module-idx")).map(text);
    assert.deepEqual(modules, ["01", "02", "03"], "a plan's checks are set, so no CHECKED AS module and no gap in the numbers");
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
    assert.equal(text(button(container, "Merge run " + id.slice(0, 8))), "Merge anyway…");
    assert.ok(buttons(container).some((b) => text(b).startsWith("Copy git diff")), "its own review command");
    await click(button(container, "Merge run " + id.slice(0, 8)));
    // The dialog is the one more yes: roko's sentence first, then a key that names what it merges.
    assert.match(text(container.querySelector('[data-roko="merge"] .roko-modal-title')), /Merge this unverified work into main\?/);
    assert.match(text(container.querySelector('[data-roko="merge-confirm"]')), /^No check ran on this work\. Merge it only if you read it and want it\.$/);
    assert.equal(text(container.querySelector('[data-confirm="merge"]')), "Merge unverified work");
    await click(container.querySelector('[data-confirm="merge"]'));
    const body = posts(backend, "/runs/" + id + "/merge")[0].body;
    assert.equal(body.confirm, true);
    assert.equal(body.work, "unverified");
    assert.equal(body.plan_id, "p-1");
    assert.match(text(container.querySelector('[data-roko="hero-review"]')), /^review the work \+\d+ −\d+$/);
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
    assert.match(text(container), /6 tasks recorded · 1 unverified \(no check ran\), not counted/);
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
    const tab = [...container.querySelectorAll(".roko-runtab")].find((b) => text(b).startsWith("changes") || text(b).startsWith("Changes"));
    assert.ok(!/\+0/.test(text(tab)), "no +0 −0 on the tab");
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
    await openRunTab(container, "Changes");
    // The card has `merge` (a newer backend): its kept work can merge, after the second yes.
    assert.equal(container.querySelector('[data-roko="interrupted-output"]'), null);
    const box = container.querySelector('[data-roko="merge-unverified"]');
    assert.match(text(box), /^Not fully checked, but it can merge into main/);
    assert.equal(text(box.querySelector('[data-roko="merge-tag"]')), "not fully checked");
    const key = button(container, "Merge run " + id.slice(0, 8));
    assert.equal(text(key), "Merge anyway…");
    await click(key);
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
    assert.match(text(one.container.querySelector('[data-roko="hero-review"]')), /^review the unverified changes \+1 −0$/);
    await openRunTab(one.container, "Changes");
    assert.equal(
      text(one.container.querySelector('[data-roko="unverified-banner"]')),
      "Unverified: no check ran on this work. roko did not deliver it: it stays on its plan branch. Read it before you take it (T1)."
    );
    assert.equal(text(one.container.querySelector('[data-roko="merge-tag"]')), "unverified");
    await click(button(one.container, "Merge run " + id.slice(0, 8)));
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
    await openRunTab(three.container, "Changes");
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
    assert.match(text(placeholder.container.querySelector('[data-roko="conn-detail"]')), /start it with `roko serve --workdir WORKSPACE`/);
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
    assert.match(text(hero.querySelector(".rk-state")), /^last seen running$/);
    assert.match(text(hero.querySelector('[data-roko="stale"]')), /this is the run's last known state/);
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
    const tasks = text(container.querySelector('[data-roko="hero"] .rk-cell--tasks'));
    assert.match(tasks, /stopped/);
    assert.ok(!/running/.test(tasks), tasks);
    const strip = container.querySelector(`[data-roko-runitem="${id}"] .rk-strip`);
    assert.ok(!/running/.test(strip.getAttribute("aria-label")), strip.getAttribute("aria-label"));
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

test("an answered sign-off or held action leaves Waiting, the counts and its run at once, while roko still lists it", async () => {
  const { container, backend, registry } = await setup({
    url: "http://localhost/roko?section=waiting",
    edit: (fx) => { fx.pending_lag = true; },
  });
  try {
    const waitingTab = () => buttons(container).find((b) => b.getAttribute("role") === "tab" && /^Waiting/.test(text(b)));
    assert.equal(text(waitingTab()), "Waiting 2");
    const [confirm, effect] = ["confirm", "effect"].map((kind) => backend.fx.pending.items.find((i) => i.kind === kind));
    await click(button(container.querySelector(`[data-roko-pending="${confirm.code}"]`), "Approve " + confirm.code));
    // roko still lists it (here: every list the fake backend answers keeps it).
    assert.equal(container.querySelector(`.roko-waiting [data-roko-pending="${confirm.code}"]`), null, "gone from Waiting");
    assert.equal(text(waitingTab()), "Waiting 1");
    const chip = await mount(registry.slots.find((s) => s.slot === "header-right").component, { url: "http://localhost/sessions" });
    assert.match(chip.container.querySelector("a").getAttribute("title"), /1 waiting/);
    await click(button(container.querySelector(`[data-roko-pending="${effect.code}"]`), "Approve " + effect.code));
    assert.equal(text(waitingTab()), "Waiting");
    await openTab(container, "Runs");
    assert.ok(!/waiting on you/.test(text(container.querySelector(`[data-roko-runitem="${IDS.confirm}"]`))), "its run no longer waits on you");
  } finally {
    await cleanup();
  }
});

test("an answer roko may not have taken (it timed out) keeps the item: a sign-off that still waits is never hidden", async () => {
  const { container, backend } = await setup({
    url: "http://localhost/roko?section=waiting",
    edit: (fx) => { fx.decide_error = { code: "timeout", message: "roko did not answer in time", hint: "" }; },
  });
  try {
    const confirm = backend.fx.pending.items.find((i) => i.kind === "confirm");
    await click(button(container.querySelector(`[data-roko-pending="${confirm.code}"]`), "Approve " + confirm.code));
    assert.ok(container.querySelector(`.roko-waiting [data-roko-pending="${confirm.code}"]`), "still listed");
    const tab = buttons(container).find((b) => b.getAttribute("role") === "tab" && /^Waiting/.test(text(b)));
    assert.equal(text(tab), "Waiting 2");
  } finally {
    await cleanup();
  }
});

test("Loops: rungs by roko's own names, also when the backend sends the number as text; L2's diagnoses in words", async () => {
  const { container } = await setup({
    url: "http://localhost/roko?section=loops",
    edit: (fx) => {
      const ring = (id) => fx.loops.rings.find((r) => r.ring === id);
      // As the backend sends them (insights.retry_budgets: the rung through clean(), so text).
      const rows = [["0", 1], ["2", 0.91], ["6", 1], ["1000", 0.94], ["1001", 0.72], [3, 0.5]].map(([rung, rate]) => ({ rung: rung, ema_pass_rate: rate, observations: 10, consecutive_passes: 1, suggested_max_retries: 3, should_skip: false }));
      ring("L1").retry_budgets = rows;
      ring("L3").thresholds = rows;
      ring("L2").diagnoses = [{ id: "conductor:stall:1", source: "conductor", ts: new Date().toISOString(), severity: "warning", subject: "T3 stalled", detail: "no tool call for 4 minutes", suggested_action: "restart the agent", intervention_taken: null }];
    },
  });
  try {
    const section = container.querySelector('[data-roko="loops-section"]');
    const rows = [...section.querySelectorAll(".rk-mini li")].map((li) => text(li));
    // L1 lists five retry budgets; the L3 table lists them all.
    for (const name of ["compile", "test", "integration", "whole-plan", "post-merge"]) {
      assert.ok(rows.some((r) => r.startsWith(name + " up to 3 retries")), name + ": " + rows.join(" | "));
    }
    const table = [...section.querySelectorAll(".rk-table tbody tr td:first-child")].map(text);
    assert.deepEqual(table, ["compile", "test", "integration", "whole-plan", "post-merge", "symbol"]);
    const diagnosis = rows.find((r) => r.startsWith("conductor"));
    assert.equal(diagnosis, "conductor · T3 stalled · no tool call for 4 minutes");
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
    const cell = [...container.querySelectorAll('[data-roko="display"] .rk-cell')][3];
    assert.equal(text(cell.querySelector(".rk-sr")), "13 of 13 checks passed, 1 retried");
    assert.equal(cell.querySelector(".rk-dots").getAttribute("data-ch"), "pass", "no red: nothing failed in the end");
    assert.equal(text(cell.querySelector('[data-roko="checks-words"]')), "passed · 1 retried");
    await click(node(container, "T1"));
    const earlier = container.querySelector('[data-roko-inspector="T1"] .roko-checkrow.is-superseded');
    assert.ok(earlier, "the earlier attempt's verdict is listed, dim");
    assert.match(text(earlier), /verify\[0:test\] an earlier attempt/);
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
    const note = one.container.querySelector('[data-roko="plan"] [data-roko="plan-validation"]');
    assert.equal(
      text(note),
      "roko won't run this plan yet T2 Should render_summary flag a category exactly at its limit? · suggested: only above the limit " +
        "Answer each in the plan's tasks.toml, then delete it from open_questions. roko plan validate plans/" + IDS.plan + " says what is left."
    );
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
    const items = [...plan.container.querySelectorAll('[data-roko="plan-validation"] [data-roko="validation-items"] li')].map(text);
    assert.deepEqual(items, [
      "T3 task 'T3' depends on 'T9', which the plan does not have · PLAN_012",
      "T2 Should render_summary flag a category exactly at its limit? · suggested: only above the limit",
    ], "PLAN_045 is said by its questions");
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
    assert.equal(text(hero.querySelector(".rk-state")), "cannot run yet");
    assert.equal(hero.getAttribute("data-ch"), "you", "the person's turn");
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
    assert.equal(text(hero.querySelector(".rk-state")), "stopped · cap");
    assert.equal(hero.querySelector(".rk-state").getAttribute("title"), "roko stopped the run at its cap of $0.05 ($0.032 spent)");
    assert.equal(hero.getAttribute("data-ch"), "off", "the stop colour, not red");
    assert.equal(text(hero.querySelector(".rk-verdict .rk-sr")), "verdict: roko stopped the run at its cap of $0.05 ($0.032 spent)");
    assert.match(text(hero.querySelector(".rk-cell--tasks")), /2 stopped/);
    assert.ok(!/did not pass|failed/.test(text(hero.querySelector(".rk-cell--tasks"))));
    for (const t of ["T1", "T2"]) assert.equal(node(container, t).getAttribute("data-state"), "stopped");
    const why = container.querySelector('[data-roko="why"]');
    assert.match(text(why), /^Why it stopped The run stopped: it reached its cap of \$0\.05/);
    assert.equal(text(container.querySelector('[data-roko="rerun"]')), "raise the cap and run it again");
    const row = container.querySelector(`[data-roko-runitem="${id}"]`);
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
    const row = two.container.querySelector(`[data-roko-runitem="${listed.run_id}"]`);
    assert.match(text(row), /stopped · cap/);
    assert.equal(row.querySelector(".rk-led").getAttribute("data-ch"), "off");
  } finally {
    await cleanup();
  }
});

test("real cards: a delivery a cancel stopped says so under the run, in the timeline's words", async () => {
  const card = realCard("delivery_cancelled");
  const { container } = await setup({ url: runUrl(card.run_id), edit: (fx) => withReal(fx, card) });
  try {
    const lines = [...container.querySelectorAll('[data-roko="deliveries"] li')].map(text);
    assert.deepEqual(lines, ["plan slow-check: its delivery was stopped by a cancel request"]);
    assert.equal(container.querySelector('[data-roko="deliveries"] li .rk-led').getAttribute("data-ch"), "off", "a stop, not a failure");
  } finally {
    await cleanup();
  }
  // A plain delivery says nothing extra: the branch line says it.
  const plain = await setup({ url: runUrl(IDS.multiwave), edit: (fx) => { fx.runs[IDS.multiwave].run.deliveries = [{ plan_id: "p-1", partial: false, state: "delivered", target: "roko/batch/x", reason: null, stopped: null }]; } });
  try {
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
    assert.match(t1.getAttribute("aria-label"), /^T1, passed \(failures were there before\): /);
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
    assert.match(t5.getAttribute("aria-label"), /^T5, skipped \(the plan's conditions did not call for it\): /);
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
    text: "retrying: the planner call ran into roko's 300 s limit for one call and was stopped · attempt 2 of 2 · 0:03 · $0.00",
  };
  const row = { run_id: gen, kind: "plan_generate", label: "Split the ledger", plan_id: null, state: "running", active: true, cost_usd: null, max_usd: null, started_at: new Date().toISOString() };
  const one = await setup({ url: runUrl(gen), edit: (fx) => { fx.overview.runs.unshift({ ...row }); fx.runs[gen] = { ok: true, run: card({ writing: retrying }) }; } });
  try {
    const planning = one.container.querySelector('[data-roko="planning"]');
    assert.equal(text(planning.querySelector('[data-roko="writing-line"]')), "retrying: the planner call ran into roko's 300 s limit for one call and was stopped · attempt 2 of 2");
    assert.match(text(planning.querySelector(".roko-planning-title")), / · 0:0\d · \$0\.00 · glm-5\.1$/, "hermes-update's line: clock, spend, model");
  } finally {
    await cleanup();
  }
  // An elapsed_s out of range is not believed: the line has no clock (as the desktop's).
  const two = await setup({ url: runUrl(gen), edit: (fx) => { fx.overview.runs.unshift({ ...row }); fx.runs[gen] = { ok: true, run: card({ writing: { ...retrying, stage: "planning", reason: null, attempt: 1, attempts: 1, elapsed_s: 1e9 } }) }; } });
  try {
    const title = text(two.container.querySelector('[data-roko="planning"] .roko-planning-title'));
    assert.equal(title, "writing the plan: planning · attempt 1 of 1 · $0.00 · glm-5.1");
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
      "how far it got: retrying: the planner call ran into roko's 300 s limit for one call and was stopped · attempt 2 of 2 · 0:03 · $0.00"
    );
  } finally {
    await cleanup();
  }
});

test("a stop at roko's daily limit reads \"stopped · day limit\"; a skipped task counts as ended, in grey", async () => {
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
    assert.equal(text(hero.querySelector(".rk-state")), "stopped · day limit");
    assert.equal(hero.querySelector(".rk-state").getAttribute("title"), "roko stopped the run at today's limit of $5.00 ($5.00 spent)");
    assert.equal(hero.getAttribute("data-ch"), "off");
    assert.equal(text(one.container.querySelector(".rk-next-words")), "raise the daily limit or run it tomorrow", "nothing to press");
    assert.equal(one.container.querySelector('[data-roko="rerun"]'), null);
    assert.match(text(one.container.querySelector(`[data-roko-runitem="${id}"]`)), /stopped · day limit/);
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
    assert.match(text(two.container.querySelector('[data-roko="hero"] .rk-cell--tasks')), /4 passed · 1 skipped/);
    const cells = [...two.container.querySelectorAll(`[data-roko-runitem="${IDS.multiwave}"] .rk-strip-cell`)].map((c) => c.getAttribute("data-ch"));
    assert.deepEqual(cells, ["pass", "pass", "pass", "pass", "off"], "the run's progress is full: no waiting cell");
    assert.equal(two.container.querySelectorAll('[data-roko="hero"] .roko-ring-muted').length, 1);
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

test("the bundle uses no string evaluation and no innerHTML", () => {
  for (const needle of ["ev" + "al(", "new " + "Function", "dangerously" + "SetInnerHTML", "inner" + "HTML", "at" + "ob("]) {
    assert.ok(!BUNDLE_SRC.includes(needle), "dist/index.js must not contain " + needle);
  }
});

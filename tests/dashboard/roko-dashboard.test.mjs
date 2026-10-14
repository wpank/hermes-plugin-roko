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
      out[k] = (k === "ts_millis" || k === "at") && typeof v === "number" && v > 1e12 ? v + delta : shifted(v, delta);
    }
    return out;
  }
  return value;
}
function fixtures() {
  return shifted(structuredClone(RAW), Date.now() - RAW._generated_at_ms);
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
    if (method === "GET" && p === "/pending") return decided ? { ok: true, items: fx.pending.items.slice(1) } : fx.pending;
    if (method === "GET" && p === "/plans") return fx.plans;
    if (method === "GET" && (m = /^\/plans\/([^/]+)$/.exec(p))) {
      return fx.plan_details[decodeURIComponent(m[1])] || { ok: false, error: { code: "not_found", message: "roko has no plan " + m[1], hint: "list plans first" } };
    }
    if (method === "POST" && (m = /^\/plans\/([^/]+)\/run$/.exec(p))) return { ok: true, run_id: fx.started.run_id, state: "running", queue_position: null };
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
      decided = true;
      return { ok: true, decision_id: "c_x", code: body.code, approved: body.approve, outcome: body.approve ? "approved" : "rejected", title: "the result of task T1" };
    }
    if (method === "GET" && p === "/knowledge") return { ...fx.knowledge, query: u.searchParams.get("q") };
    if (method === "GET" && p === "/health") return fx.health;
    if (method === "GET" && p === "/insights") return fx.insights;
    throw new Error("404: no fake route for " + method + " " + p);
  }
  return { fetchJSON, calls, fx };
}

// --------------------------------------------------------------------------------
// Harness
// --------------------------------------------------------------------------------

const mounted = new Set();

function loadBundle(backend) {
  const registry = { pages: {}, slots: [] };
  window.__HERMES_PLUGIN_SDK__ = makeSdk(backend.fetchJSON);
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

async function setup({ mode = "normal", url, edit } = {}) {
  const backend = makeBackend(mode, edit);
  const registry = loadBundle(backend);
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

test("registers the roko page and both slots, with registerSlot(plugin, slot, component)", async () => {
  const backend = makeBackend();
  const registry = loadBundle(backend);
  assert.equal(typeof registry.pages.roko, "function");
  const slots = registry.slots.map((s) => [s.plugin, s.slot, typeof s.component]);
  assert.deepEqual(slots, [
    ["roko", "header-right", "function"],
    ["roko", "sessions:top", "function"],
  ]);
});

test("the header shows the connection and today's spend; runs are grouped Live, Today", async () => {
  const { container } = await setup();
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
    assert.match(text(container.querySelector(".roko-changes-head")), /\+299 −3 in 9 files/);
    const items = diff.querySelectorAll(".roko-diff-fileitem");
    assert.equal(items.length, 9);
    assert.match(text(items[0]), /A budgets\.py tally\/ \+50 −0/);
    const file = diff.querySelector('[data-roko-file="tally/budgets.py"]');
    const first = file.querySelector(".roko-dl--add");
    assert.deepEqual([...first.querySelectorAll(".roko-dl-no")].map((n) => text(n)), ["", "1"]);
    assert.ok(file.querySelector(".roko-tk-kw"), "keywords are tinted");
    assert.equal(file.querySelectorAll("script, img").length, 0);
    // The run's tab shows the size of the change.
    assert.match(text(buttons(container).find((b) => b.getAttribute("role") === "tab" && text(b).startsWith("Changes"))), /\+299 −3/);
  } finally {
    await cleanup();
  }
});

test("Merge: a guarded dialog, the reviewed commit in the request, then the undo command", async () => {
  const { container, backend } = await setup({ url: runUrl(IDS.prompt, "&view=changes") });
  try {
    assert.match(text(container.querySelector(".roko-mergebox")), /Ready to merge into main fast-forward · f893938/);
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
    assert.deepEqual(sent[0].body, { commit: "f8939382ea89d70d6bea0595efacb01e3bfde144" });
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
    await click(buttons(dialog).find((b) => b.getAttribute("role") === "radio" && text(b).startsWith("Plan it first")));
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
    assert.match(kpis[0], /Checks passed 79% 23 of 29 check runs/);
    assert.match(kpis[1], /Tasks that passed 59% 17 tasks recorded/);
    assert.match(kpis[2], /Spend \$0\.48/);
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
    assert.ok(container.querySelector(".roko-kpis"), "4 opens Insights");
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
    await click(onboard.querySelector(".roko-example"));
    assert.match(container.querySelector('[data-roko="composer"] textarea').value, /--json flag/);
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

test("roko serve unreachable: the header shows the error and hint, cached runs stay listed", async () => {
  const { container, registry } = await setup({ mode: "unreachable" });
  try {
    const all = text(container);
    assert.ok(all.includes("roko serve unreachable"));
    assert.ok(all.includes("roko serve is not reachable at http://localhost:6677"));
    assert.ok(all.includes("start it with `roko serve`"));
    assert.ok(all.includes("Last known states"));
    assert.ok(all.includes("Add a --json flag to tally"));
    const chip = await mount(registry.slots.find((s) => s.slot === "header-right").component);
    assert.match(chip.container.querySelector("a").getAttribute("title"), /unreachable/);
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
    assert.ok(link.querySelector(".roko-ring--mini"), "the live plan's progress ring");
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
    assert.ok(chip.container.querySelector(".roko-dot"));
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

test("the bundle uses no string evaluation and no innerHTML", () => {
  for (const needle of ["ev" + "al(", "new " + "Function", "dangerously" + "SetInnerHTML", "inner" + "HTML", "at" + "ob("]) {
    assert.ok(!BUNDLE_SRC.includes(needle), "dist/index.js must not contain " + needle);
  }
});

// Behaviour tests for dashboard/dist/index.js, the roko tab of the Hermes web dashboard.
//
// The bundle runs inside jsdom exactly as the dashboard loads it: a plain script that
// reads window.__HERMES_PLUGIN_SDK__ and registers on window.__HERMES_PLUGINS__. The
// SDK here is a fake (simple DOM stand-ins for the dashboard's UI components) built on
// the real React from a Hermes checkout; fetchJSON is a fake backend answering with the
// contract shapes from docs/ui-api.md (tests/dashboard/fixtures.json).
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
const FIXTURES = JSON.parse(readFileSync(path.join(HERE, "fixtures.json"), "utf8"));
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
  "window", "document", "navigator", "HTMLElement", "HTMLInputElement", "Node", "Element",
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
    CardHeader: (props) => h("div", props),
    CardTitle: (props) => h("h3", props),
    CardContent: (props) => h("div", props),
    Badge: (props) => h("span", strip(props)),
    Button: (props) => h("button", { ...strip(props), "data-sdk": "Button" }, props.prefix || null, props.children, props.suffix || null),
    Input: (props) => h("input", { ...props, "data-sdk": "Input" }),
    Label: (props) => h("label", props),
    Separator: () => h("hr"),
    Select: (props) => h("select", props),
    SelectOption: () => null,
    Tabs: (props) => h("div", null, props.children("x", () => {})),
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
// The fake backend: docs/ui-api.md shapes, recording every call
// --------------------------------------------------------------------------------

const RUNNING = "e13f6327-5c1a-4a3e-9d2b-7f8e1a2b3c4d";
const DELIVERED = "c2e4a6b8-1d3f-4a5c-8e7b-0f2d4c6a8e19";
const UNVERIFIED = "8a0c4f19-2d7e-4b61-a0f3-5e9c7d2b1a30";

function makeBackend(mode = "normal", overrides = {}) {
  const fx = structuredClone(FIXTURES);
  const now = Date.now();
  const deadline = new Date(now + 95_000).toISOString();
  fx.overview.pending[0].deadline_at = deadline;
  fx.runs[RUNNING].run.waiting[0].deadline_at = deadline;
  fx.pending = { ok: true, items: structuredClone(fx.overview.pending) };
  if (mode === "idle") {
    fx.overview.counts = { running: 0, queued: 0, waiting: 0 };
    fx.overview.pending = [];
    fx.overview.runs = fx.overview.runs.filter((r) => r.state !== "running");
  }
  if (mode === "readonly") {
    fx.overview.permissions = { write: false };
  }
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
  Object.assign(fx, overrides);
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
    if (method === "POST" && (m = /^\/plans\/([^/]+)\/run$/.exec(p))) return fx.plan_run;
    if (method === "GET" && (m = /^\/runs\/([^/]+)\/events$/.exec(p))) {
      const all = fx.events[decodeURIComponent(m[1])] || [];
      const cursor = u.searchParams.get("cursor");
      if (cursor == null) {
        const first = all.slice(0, 3);
        return { ok: true, events: first, next_cursor: first.length ? first[first.length - 1].cursor : null, has_more: all.length > 3 };
      }
      const rest = all.filter((e) => e.cursor > Number(cursor));
      return { ok: true, events: rest, next_cursor: rest.length ? rest[rest.length - 1].cursor : Number(cursor), has_more: false };
    }
    if (method === "POST" && (m = /^\/runs\/([^/]+)\/cancel$/.exec(p))) return { ok: true, run_id: decodeURIComponent(m[1]), state: "cancelled" };
    if (method === "GET" && (m = /^\/runs\/([^/]+)$/.exec(p))) {
      const id = decodeURIComponent(m[1]);
      if (fx.runs[id]) return fx.runs[id];
      if (id === fx.plan_run.run_id) {
        return { ok: true, run: { run_id: id, kind: "plan", label: "add-tests", plan_id: "add-tests", state: "queued", active: true, position: 1, cost_usd: null, max_usd: 2.5, tasks: [], waiting: [], started_at: new Date().toISOString() } };
      }
      return { ok: false, error: { code: "not_found", message: "roko does not know run " + id, hint: "it may have been cleaned up" } };
    }
    if (method === "POST" && p === "/decide") {
      decided = true;
      return { ...fx.decide, approved: body.approve };
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

async function setup({ mode = "normal", url, overrides } = {}) {
  const backend = makeBackend(mode, overrides);
  const registry = loadBundle(backend);
  const page = await mount(registry.pages.roko, { url });
  return { backend, registry, page, container: page.container };
}

async function cleanup() {
  for (const handle of [...mounted]) await handle.unmount();
}

function text(el) { return el.textContent.replace(/\s+/g, " ").trim(); }
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
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
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
async function openTab(container, label) {
  const tab = buttons(container).find((b) => b.getAttribute("role") === "tab" && text(b).startsWith(label));
  assert.ok(tab, "no tab " + label);
  await click(tab);
}
function posts(backend, suffix) {
  return backend.calls.filter((c) => c.method === "POST" && c.url.endsWith(suffix));
}

// --------------------------------------------------------------------------------
// Tests
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

test("the page shows the connection, today's spend, the runs and the active run's card", async () => {
  const { container, backend } = await setup();
  try {
    const all = text(container);
    assert.match(all, /roko 0\.1\.0 · ok/);
    assert.match(all, /http:\/\/localhost:6677/);
    assert.match(all, /today \$0\.42 of \$10\.00/);
    assert.match(all, /\$1\.00 committed/);
    for (const label of ["Add clamp() to mathx with a unit test", "add-tests", "Fix the flaky lexer test in roko-gate"]) {
      assert.ok(all.includes(label), "run listed: " + label);
    }
    // The running run is selected by default and its card is loaded.
    assert.ok(backend.calls.some((c) => c.url === "/api/plugins/roko/runs/" + RUNNING));
    assert.match(all, /running · gates 2\/3 · \$0\.21 of \$0\.50 · 1m 52s/);
    assert.match(all, /\$0\.21 of \$0\.50/);
    assert.match(all, /42% of the cap/);
    // Task outcome glyphs: ✓ passed, ↻ running on a second attempt, · queued.
    const glyph = (id) => text(container.querySelector(`[data-roko-task="${id}"] .roko-task-glyph`));
    assert.equal(glyph("T1"), "✓");
    assert.equal(glyph("T2"), "↻");
    assert.equal(glyph("T3"), "·");
    assert.ok(all.includes("verify[0:test]"), "gate chips");
    assert.ok(all.includes("Is this what you asked for?"), "the run's waiting item");
    // The timeline is fetched incrementally: a first page, then from next_cursor.
    const eventCalls = backend.calls.filter((c) => c.url.includes("/events"));
    assert.ok(eventCalls.length >= 2, "events fetched in pages");
    assert.ok(!eventCalls[0].url.includes("cursor="));
    assert.ok(eventCalls[1].url.includes("cursor=1312"), "the second page asks from the first page's next_cursor");
    assert.ok(all.includes("T1 started: Add clamp"));
    assert.ok(all.includes("T2 retrying (attempt 2)"));
  } finally {
    await cleanup();
  }
});

test("unverified is never green, and unknown money renders as —", async () => {
  const { container } = await setup();
  try {
    const item = [...container.querySelectorAll(".roko-runitem")].find((el) => text(el).includes("add-tests"));
    assert.ok(item, "the unverified plan run is listed");
    const pill = item.querySelector(".roko-pill");
    assert.equal(text(pill), "unverified");
    assert.ok(pill.className.includes("roko-tone-warn"));
    assert.ok(!pill.className.includes("roko-tone-ok"), "unverified must not look like success");
    assert.ok(text(item).includes("— of $2.00"), "null cost renders as —, not $0.00");
    assert.ok(!text(item).includes("$0.00"));
  } finally {
    await cleanup();
  }
});

test("a delivered run offers copyable review and merge commands", async () => {
  const { container } = await setup({ url: "http://localhost/roko?run=" + DELIVERED });
  try {
    const all = text(container);
    assert.ok(all.includes("roko/batch/" + DELIVERED), "branch");
    assert.ok(all.includes("d66293e36e22"), "commit");
    assert.ok(all.includes("not merged yet"));
    assert.ok(all.includes("git -C /Users/demo/code/roko diff HEAD...roko/batch/" + DELIVERED));
    assert.ok(all.includes("git -C /Users/demo/code/roko merge roko/batch/" + DELIVERED));
    assert.ok(buttons(container).some((b) => b.getAttribute("aria-label") === "Copy the review command"));
    assert.ok(buttons(container).some((b) => b.getAttribute("aria-label") === "Copy the merge command"));
    // A finished run has no Cancel button.
    assert.ok(!buttons(container).some((b) => text(b) === "Cancel run"));
  } finally {
    await cleanup();
  }
});

test("Waiting: Approve posts /decide with the code, approve and the note", async () => {
  const { container, backend } = await setup();
  try {
    await openTab(container, "Waiting");
    assert.ok(backend.calls.some((c) => c.url === "/api/plugins/roko/pending"));
    const card = container.querySelector('.roko-waiting [data-roko-pending="a1b2c3"]');
    assert.ok(card, "the confirm item is listed");
    assert.match(text(card), /answer within 1:3\d/, "confirm deadline countdown");
    assert.ok(container.querySelector('.roko-waiting [data-roko-pending="f4e5d6"]'), "the held action is listed");
    assert.match(text(container), /to: string/, "effect arguments show types only");
    await typeInto(card.querySelector("input"), "looks right");
    await click(button(card, "Approve a1b2c3"));
    const sent = posts(backend, "/decide");
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].body, { code: "a1b2c3", approve: true, note: "looks right" });
    assert.match(text(container), /Approved the result of task T1/);
    assert.ok(!container.querySelector('.roko-waiting [data-roko-pending="a1b2c3"]'), "an answered item leaves the inbox");
  } finally {
    await cleanup();
  }
});

test("Waiting: a confirm past its deadline says so instead of counting down", async () => {
  const fx = structuredClone(FIXTURES);
  const items = structuredClone(fx.overview.pending);
  items[0].deadline_at = new Date(Date.now() - 5_000).toISOString();
  const { container } = await setup({ url: "http://localhost/roko?section=waiting", overrides: { pending: { ok: true, items } } });
  try {
    const card = container.querySelector('.roko-waiting [data-roko-pending="a1b2c3"]');
    assert.ok(card);
    assert.match(text(card), /deadline passed/);
    assert.doesNotMatch(text(card), /answer within/);
  } finally {
    await cleanup();
  }
});

test("Waiting: Reject posts approve false without an empty note", async () => {
  const { container, backend } = await setup({ url: "http://localhost/roko?section=waiting" });
  try {
    const card = container.querySelector('.roko-waiting [data-roko-pending="f4e5d6"]');
    assert.ok(card, "the URL opened the Waiting tab");
    await click(button(card, "Reject f4e5d6"));
    assert.deepEqual(posts(backend, "/decide")[0].body, { code: "f4e5d6", approve: false });
  } finally {
    await cleanup();
  }
});

test("Plans: the detail shows waves, deps, checks and the estimate; Run plan posts the cap after a confirm", async () => {
  const { container, backend } = await setup();
  try {
    await openTab(container, "Plans");
    await click([...container.querySelectorAll(".roko-runitem")].find((el) => text(el).includes("add-tests")));
    const waves = [...container.querySelectorAll(".roko-wave")];
    assert.equal(waves.length, 2);
    assert.deepEqual(
      waves.map((w) => [...w.querySelectorAll("[data-roko-plantask]")].map((t) => t.getAttribute("data-roko-plantask"))),
      [["T1", "T2"], ["T3"]]
    );
    const all = text(container);
    assert.ok(all.includes("after T1, T2"));
    assert.ok(all.includes("cargo test --workspace"));
    assert.ok(all.includes("$0.03 · 30s"), "estimate");
    assert.ok(all.includes("low confidence"));

    const form = container.querySelector(".roko-runform");
    await typeInto(form.querySelector('input[type="number"]'), "2.5");
    await submit(form);
    assert.equal(posts(backend, "/run").length, 0, "nothing starts before the confirm");
    const dialog = container.querySelector('[role="alertdialog"]');
    assert.ok(dialog, "an explicit confirm opens");
    assert.match(text(dialog), /may spend up to \$2\.50/);
    await click(dialog.querySelector('[data-confirm="yes"]'));
    const sent = posts(backend, "/plans/add-tests/run");
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].body, { max_usd: 2.5, resume: false });
    // The started run opens on the Runs tab.
    assert.ok(backend.calls.some((c) => c.url === "/api/plugins/roko/runs/" + FIXTURES.plan_run.run_id));
    assert.match(text(container), /Started run 9d8c7b6a/);
  } finally {
    await cleanup();
  }
});

test("Plans: an invalid cap cannot be submitted and resume is sent when ticked", async () => {
  const { container, backend } = await setup({ url: "http://localhost/roko?section=plans&plan=add-tests" });
  try {
    const form = container.querySelector(".roko-runform");
    assert.ok(form, "the URL opened the plan");
    const capInput = form.querySelector('input[type="number"]');
    await typeInto(capInput, "0");
    assert.match(text(form), /at least \$0\.01/);
    assert.ok(button(form, "Run plan…").disabled);
    await typeInto(capInput, "0.75");
    await click(form.querySelector('input[type="checkbox"]'));
    await submit(form);
    await click(container.querySelector('[role="alertdialog"] [data-confirm="yes"]'));
    assert.deepEqual(posts(backend, "/plans/add-tests/run")[0].body, { max_usd: 0.75, resume: true });
  } finally {
    await cleanup();
  }
});

test("Plans: the cap stops at the per-run cap and what is left today", async () => {
  const { container } = await setup({ url: "http://localhost/roko?section=plans&plan=add-tests" });
  try {
    const form = container.querySelector(".roko-runform");
    assert.equal(text(form.querySelector(".roko-run-limits")), "at most $5.00 per run · $8.58 left today");
    await typeInto(form.querySelector('input[type="number"]'), "6");
    assert.match(text(form), /at most \$5\.00\./);
    assert.ok(button(form, "Run plan…").disabled);
  } finally {
    await cleanup();
  }
});

test("read-only: with actions off there is no Approve, Reject or Cancel, only the chat command", async () => {
  const { container } = await setup({ mode: "readonly" });
  try {
    assert.equal(container.querySelector('[aria-label^="Approve "]'), null);
    assert.equal(container.querySelector('[aria-label^="Reject "]'), null);
    assert.equal([...container.querySelectorAll("button")].filter((b) => text(b) === "Cancel run").length, 0);
    assert.match(text(container.querySelector(".roko-actions-off")), /\/roko approve [0-9a-f]{6}/);
  } finally {
    await cleanup();
  }
});

test("Cancel run sits behind a confirm and posts /runs/{id}/cancel", async () => {
  const { container, backend } = await setup();
  try {
    await click(button(container, "Cancel run"));
    assert.equal(posts(backend, "/cancel").length, 0);
    const dialog = container.querySelector('[role="alertdialog"]');
    assert.ok(dialog);
    await click(dialog.querySelector('[data-confirm="yes"]'));
    const sent = posts(backend, "/runs/" + RUNNING + "/cancel");
    assert.equal(sent.length, 1);
    assert.match(text(container), /Cancelled run e13f6327/);
  } finally {
    await cleanup();
  }
});

test("Knowledge searches /knowledge?q= and lists the entries as text", async () => {
  const { container, backend } = await setup();
  try {
    await openTab(container, "Knowledge");
    const form = container.querySelector(".roko-search");
    await typeInto(form.querySelector("input"), "parser");
    await submit(form);
    assert.ok(backend.calls.some((c) => c.url === "/api/plugins/roko/knowledge?q=parser&limit=10"));
    assert.ok(text(container).includes("error recovery skips to the next semicolon"));
    assert.ok(text(container).includes("95% confidence"));
  } finally {
    await cleanup();
  }
});

test("Health shows the checks, gate pass rates, the model scorecard and a sparkline", async () => {
  const { container } = await setup();
  try {
    await openTab(container, "Health");
    const all = text(container);
    assert.ok(all.includes("the key cannot cancel runs"));
    assert.ok(all.includes("→ run `hermes roko setup --mint` for a write-scoped key"));
    assert.ok(all.includes("verify[0:test]"));
    assert.ok(all.includes("83%"));
    assert.ok(all.includes("claude-haiku-4.5"));
    assert.ok(all.includes("67%"));
    assert.ok(container.querySelector("svg polyline"), "a cost sparkline");
    assert.ok(all.includes("$1.35 cumulative"));
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
    assert.ok(all.includes("Add clamp() to mathx with a unit test"));
    const chip = await mount(registry.slots.find((s) => s.slot === "header-right").component);
    assert.match(chip.container.querySelector("a").getAttribute("title"), /unreachable/);
  } finally {
    await cleanup();
  }
});

test("a route answering ok:false shows roko's message, hint and a Retry", async () => {
  const overrides = {
    plans: { ok: false, error: { code: "unreachable", message: "roko serve did not answer", hint: "start roko serve, then retry" } },
  };
  const { container } = await setup({ overrides });
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

test("header-right chip and sessions:top banner summarise the overview and link to the tab", async () => {
  const backend = makeBackend();
  const registry = loadBundle(backend);
  try {
    const chip = await mount(registry.slots.find((s) => s.slot === "header-right").component, { url: "http://localhost/sessions" });
    const link = chip.container.querySelector("a");
    assert.equal(text(link), "roko1 running · 2 waiting");
    assert.equal(link.getAttribute("href"), "/roko?section=waiting");
    const banner = await mount(registry.slots.find((s) => s.slot === "sessions:top").component, { url: "http://localhost/sessions" });
    assert.equal(text(banner.container.querySelector(".roko-banner-text")), "roko: 1 run running · 2 items wait on you");
    assert.equal(text(banner.container.querySelector("a")), "open →");
    assert.equal(banner.container.querySelector("a").getAttribute("href"), "/roko?section=waiting");
    // The link navigates inside the SPA (pushState + popstate for react-router).
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

test("roko's strings are rendered as text, never as HTML", async () => {
  const fx = structuredClone(FIXTURES);
  fx.overview.runs[0].label = '<img src=x onerror="alert(1)"><b>bold</b> **not markdown**';
  const { container } = await setup({ overrides: { overview: fx.overview } });
  try {
    assert.equal(container.querySelectorAll("img").length, 0);
    assert.equal(container.querySelectorAll("b").length, 0);
    assert.ok(text(container).includes("<b>bold</b> **not markdown**"));
  } finally {
    await cleanup();
  }
});

test("the bundle uses no string evaluation and no innerHTML", () => {
  for (const needle of ["ev" + "al(", "new " + "Function", "dangerously" + "SetInnerHTML", "inner" + "HTML", "at" + "ob("]) {
    assert.ok(!BUNDLE_SRC.includes(needle), "dist/index.js must not contain " + needle);
  }
});

/**
 * roko for the Hermes web dashboard (`hermes dashboard`).
 *
 * A hand-written, unminified IIFE: no build step, no dependencies of its own.
 * It uses only what the dashboard hands plugins on `window.__HERMES_PLUGIN_SDK__`
 * (React, hooks, UI components, `fetchJSON`) and registers with
 * `window.__HERMES_PLUGINS__`:
 *
 *   - the "roko" tab (/roko): Runs, Waiting, Plans, Knowledge, Health;
 *   - a `header-right` slot chip: "roko ● 1 running · 2 waiting";
 *   - a `sessions:top` slot banner while runs are active or something waits.
 *
 * Data comes only from the plugin's own backend, `/api/plugins/roko/*`
 * (dashboard/plugin_api.py; the contract is docs/ui-api.md). Every route answers
 * HTTP 200 with `{ok: true, …}` or `{ok: false, error: {code, message, hint}}`.
 * A non-200 means the route itself is missing: Hermes mounts plugin routes only
 * when the dashboard starts, so the page tells the person to restart it.
 *
 * Everything that came from roko is untrusted text. It is rendered as React text
 * nodes only: never parsed as HTML or markdown, and no links are built from it.
 *
 * Polling follows the contract: the overview every 10 s (shared by the page and
 * both slots), a single run every 3 s while it is active, nothing faster.
 */
(function () {
  "use strict";

  const SDK = window.__HERMES_PLUGIN_SDK__;
  const PLUGINS = window.__HERMES_PLUGINS__;
  if (!SDK || !SDK.React || !PLUGINS) return;

  const React = SDK.React;
  const h = React.createElement;
  const hooks = SDK.hooks || {};
  const useState = hooks.useState || React.useState;
  const useEffect = hooks.useEffect || React.useEffect;
  const useCallback = hooks.useCallback || React.useCallback;
  const useMemo = hooks.useMemo || React.useMemo;
  const useRef = hooks.useRef || React.useRef;
  const C = SDK.components || {};

  const PLUGIN = "roko";
  const VERSION = "0.2.0";
  const API = "/api/plugins/roko";
  const OVERVIEW_POLL_MS = 10000;
  const RUN_POLL_MS = 3000;
  const PENDING_POLL_MS = 10000;
  const MAX_EVENTS = 400;
  const MAX_EVENT_PAGES = 10;

  const SECTIONS = [
    { id: "runs", label: "Runs" },
    { id: "waiting", label: "Waiting" },
    { id: "plans", label: "Plans" },
    { id: "knowledge", label: "Knowledge" },
    { id: "health", label: "Health" },
  ];

  // ---------------------------------------------------------------------------
  // SDK components, with plain fallbacks for older dashboards
  // ---------------------------------------------------------------------------

  function omitStyleProps(props) {
    const out = Object.assign({}, props);
    ["size", "outlined", "ghost", "destructive", "invert", "prefix", "suffix", "active", "value"].forEach(
      function (key) { delete out[key]; }
    );
    return out;
  }

  const Button = C.Button || function FallbackButton(props) {
    const rest = omitStyleProps(props);
    rest.className = "roko-btn " + (props.className || "");
    return h("button", rest, props.prefix || null, props.children, props.suffix || null);
  };

  const Card = C.Card || function FallbackCard(props) {
    return h("div", Object.assign({}, props, { className: "roko-card " + (props.className || "") }));
  };

  const Input = C.Input || function FallbackInput(props) {
    return h("input", Object.assign({}, props, { className: "roko-input " + (props.className || "") }));
  };

  const TabsList = C.TabsList || function FallbackTabsList(props) {
    return h("div", Object.assign({}, props, { className: "roko-tablist " + (props.className || "") }));
  };

  const TabsTrigger = C.TabsTrigger || function FallbackTabsTrigger(props) {
    const rest = omitStyleProps(props);
    rest.type = "button";
    rest.className = "roko-tab " + (props.active ? "is-active " : "") + (props.className || "");
    return h("button", rest);
  };

  /** The dashboard's ConfirmDialog, or an inline confirm panel on older hosts. */
  function Confirm(props) {
    if (C.ConfirmDialog) {
      return h(C.ConfirmDialog, {
        open: !!props.open,
        title: props.title,
        description: props.description,
        confirmLabel: props.confirmLabel,
        cancelLabel: props.cancelLabel || "Cancel",
        destructive: !!props.destructive,
        loading: !!props.loading,
        onConfirm: props.onConfirm,
        onCancel: props.onCancel,
      });
    }
    if (!props.open) return null;
    return h(
      "div",
      { className: "roko-inline-confirm", role: "alertdialog", "aria-label": props.title },
      h("div", { className: "roko-inline-confirm-title" }, props.title),
      props.description ? h("div", { className: "roko-dim" }, props.description) : null,
      h(
        "div",
        { className: "roko-row" },
        h(Button, { size: "sm", type: "button", onClick: props.onConfirm }, props.confirmLabel || "Confirm"),
        h(Button, { size: "sm", outlined: true, type: "button", onClick: props.onCancel }, props.cancelLabel || "Cancel")
      )
    );
  }

  /** The dashboard's toast (hooks.useToast + components.Toast), or a small local one. */
  function useLocalToast() {
    const [toast, setToast] = useState(null);
    useEffect(function () {
      if (!toast) return undefined;
      const timer = setTimeout(function () { setToast(null); }, 4000);
      return function () { clearTimeout(timer); };
    }, [toast]);
    const showToast = useCallback(function (message, type) {
      setToast({ message: String(message), type: type === "error" ? "error" : "success" });
    }, []);
    return { toast: toast, showToast: showToast };
  }
  const useToastImpl = typeof hooks.useToast === "function" && C.Toast ? hooks.useToast : useLocalToast;
  function ToastView(props) {
    if (C.Toast && useToastImpl === hooks.useToast) return h(C.Toast, { toast: props.toast });
    if (!props.toast) return null;
    return h(
      "div",
      { className: "roko-toast roko-tone-" + (props.toast.type === "error" ? "bad" : "ok"), role: "status" },
      props.toast.message
    );
  }

  // ---------------------------------------------------------------------------
  // Formatting (all output is plain text)
  // ---------------------------------------------------------------------------

  function isNum(v) { return typeof v === "number" && isFinite(v); }
  function str(v) { return v == null ? "" : String(v); }

  /** Dollars; `null`/unknown is "—", never "$0.00". */
  function money(v) {
    if (!isNum(v)) return "—";
    if (v > 0 && v < 0.005) return "<$0.01";
    return "$" + v.toFixed(2);
  }
  function costOfCap(cost, cap) {
    if (isNum(cap)) return money(cost) + " of " + money(cap);
    return money(cost);
  }
  function pct(ratio) { return isNum(ratio) ? Math.round(ratio * 100) + "%" : "—"; }
  function plural(n, one, many) { return n + " " + (n === 1 ? one : many); }
  function shortId(id) { const s = str(id); return s.length > 12 ? s.slice(0, 8) : s; }
  function ms(iso) { return iso ? Date.parse(iso) : NaN; }
  function ago(iso, now) {
    const t = ms(iso);
    if (!isFinite(t)) return "—";
    const s = Math.max(0, Math.round(((now || Date.now()) - t) / 1000));
    if (s < 10) return "just now";
    if (s < 60) return s + "s ago";
    const m = Math.floor(s / 60);
    if (m < 60) return m + "m ago";
    const hrs = Math.floor(m / 60);
    if (hrs < 48) return hrs + "h ago";
    return Math.floor(hrs / 24) + "d ago";
  }
  function duration(msValue) {
    if (!isNum(msValue) || msValue < 0) return "—";
    const s = Math.round(msValue / 1000);
    if (s < 60) return s + "s";
    const m = Math.floor(s / 60);
    if (m < 60) return m + "m " + String(s % 60).padStart(2, "0") + "s";
    return Math.floor(m / 60) + "h " + String(m % 60).padStart(2, "0") + "m";
  }
  function clock(seconds) {
    const s = Math.max(0, Math.floor(seconds));
    return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  }
  function tokens(n) {
    if (!isNum(n)) return "—";
    if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
    return String(n);
  }
  function enc(v) { return encodeURIComponent(str(v)); }

  const KIND_LABEL = { run: "task", plan: "plan", plan_generate: "planning" };

  /** Run-state tone. `unverified` is never green: nothing checked the result. */
  function stateTone(state) {
    switch (state) {
      case "succeeded": return "ok";
      case "failed": return "bad";
      case "unverified": return "warn";
      case "running": return "run";
      case "queued": return "idle";
      default: return "muted";
    }
  }
  function isActiveState(state) { return state === "running" || state === "queued"; }
  function isRunActive(run) { return !!run && (run.active === true || isActiveState(run.state)); }

  const OUTCOMES = {
    passed: ["✓", "ok", "passed"],
    succeeded: ["✓", "ok", "succeeded"],
    already_satisfied: ["✓", "muted", "already satisfied"],
    accepted_with_failures: ["✓", "warn", "accepted with failures"],
    failed: ["✗", "bad", "failed"],
    blocked: ["✗", "warn", "blocked"],
    running: ["⟳", "run", "running"],
    retrying: ["↻", "warn", "retrying"],
    queued: ["·", "idle", "queued"],
    pending: ["·", "idle", "pending"],
    skipped: ["·", "muted", "skipped"],
    unverified: ["·", "warn", "unverified"],
    cancelled: ["·", "muted", "cancelled"],
  };
  function outcomeInfo(task) {
    let key = str(task && task.outcome) || "pending";
    if (key === "running" && isNum(task.attempts) && task.attempts > 1) key = "retrying";
    const o = OUTCOMES[key] || ["·", "muted", key.replace(/_/g, " ")];
    return { glyph: o[0], tone: o[1], label: o[2] };
  }

  /** 80 % of a cap is a warning, 95 % is the danger zone. */
  function capTone(value, cap) {
    if (!isNum(value) || !isNum(cap) || cap <= 0) return "fill";
    const r = value / cap;
    return r >= 0.95 ? "bad" : r >= 0.8 ? "warn" : "fill";
  }

  // ---------------------------------------------------------------------------
  // The backend
  // ---------------------------------------------------------------------------

  /** A thrown fetchJSON error: "<status>: <body>" means the route is missing or crashed. */
  function describeThrow(err) {
    const raw = err && err.message ? String(err.message) : String(err || "");
    const m = /^(\d{3}):/.exec(raw);
    if (m) {
      const status = Number(m[1]);
      if (status === 404) {
        return {
          kind: "backend",
          status: status,
          code: "backend_missing",
          message: "roko's backend is not loaded in this dashboard.",
          hint:
            "Restart `hermes dashboard`. Hermes mounts plugin routes only when it starts, so a roko " +
            "plugin installed or updated since then has no backend yet.",
        };
      }
      return {
        kind: "backend",
        status: status,
        code: "backend_failed",
        message: "roko's backend failed to answer (HTTP " + status + ").",
        hint: "Restart `hermes dashboard`; if it keeps failing, look for the roko plugin in the dashboard's log.",
      };
    }
    return {
      kind: "network",
      status: 0,
      code: "network",
      message: "Could not reach the Hermes dashboard server.",
      hint: "Check that `hermes dashboard` is still running, then retry.",
    };
  }

  /** One call to the plugin's backend → {ok: true, data} or {ok: false, error}. */
  function request(path, init) {
    if (typeof SDK.fetchJSON !== "function") {
      return Promise.resolve({
        ok: false,
        error: {
          kind: "backend",
          code: "no_fetch",
          message: "This dashboard does not give plugins a fetch helper.",
          hint: "Update Hermes.",
        },
      });
    }
    let pending;
    try {
      pending = SDK.fetchJSON(API + path, init);
    } catch (err) {
      return Promise.resolve({ ok: false, error: describeThrow(err) });
    }
    return Promise.resolve(pending).then(
      function (body) {
        if (!body || typeof body !== "object") {
          return {
            ok: false,
            error: {
              kind: "protocol",
              code: "protocol",
              message: "roko's backend sent an answer this page does not understand.",
              hint: "Update the roko plugin, then restart `hermes dashboard`.",
            },
          };
        }
        if (body.ok === true) return { ok: true, data: body };
        const e = body.error && typeof body.error === "object" ? body.error : {};
        return {
          ok: false,
          error: {
            kind: "roko",
            code: str(e.code) || "internal",
            message: str(e.message) || "roko reported a problem.",
            hint: e.hint ? str(e.hint) : null,
          },
        };
      },
      function (err) { return { ok: false, error: describeThrow(err) }; }
    );
  }
  function apiGet(path) { return request(path); }
  function apiPost(path, payload) {
    return request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {}),
    });
  }

  // ---------------------------------------------------------------------------
  // The overview: one 10 s poller shared by the page and both slots
  // ---------------------------------------------------------------------------

  const overviewStore = (function () {
    let state = { status: "idle", data: null, error: null, at: 0 };
    const listeners = new Set();
    let timer = null;
    let inflight = null;

    function emit() {
      listeners.forEach(function (fn) {
        try { fn(state); } catch (_) { /* a broken listener must not stop the others */ }
      });
    }
    function load() {
      if (inflight) return inflight;
      if (state.status === "idle") {
        state = Object.assign({}, state, { status: "loading" });
        emit();
      }
      inflight = apiGet("/overview").then(function (res) {
        inflight = null;
        state = res.ok
          ? { status: "ok", data: res.data, error: null, at: Date.now() }
          : { status: "error", data: state.data, error: res.error, at: Date.now() };
        emit();
        return state;
      });
      return inflight;
    }
    function schedule() {
      clearTimeout(timer);
      timer = null;
      if (listeners.size > 0) timer = setTimeout(tick, OVERVIEW_POLL_MS);
    }
    function tick() {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        schedule();
        return;
      }
      load().then(schedule);
    }
    return {
      get: function () { return state; },
      subscribe: function (fn) {
        listeners.add(fn);
        if (listeners.size === 1) load().then(schedule);
        return function () {
          listeners.delete(fn);
          if (listeners.size === 0) {
            clearTimeout(timer);
            timer = null;
          }
        };
      },
      refresh: function () { return load().then(schedule); },
    };
  })();

  function useOverview() {
    const [snapshot, setSnapshot] = useState(overviewStore.get());
    useEffect(function () { return overviewStore.subscribe(setSnapshot); }, []);
    return snapshot;
  }

  // What the backend lets this page do. Unknown means allowed: the backend checks every action again,
  // so this only hides buttons it would refuse.
  function useLimits() {
    const data = useOverview().data || {};
    const permissions = data.permissions && typeof data.permissions === "object" ? data.permissions : {};
    const limits = data.limits && typeof data.limits === "object" ? data.limits : {};
    const spend = data.spend && typeof data.spend === "object" ? data.spend : {};
    return {
      canAct: permissions.write !== false,
      maxRun: isNum(limits.max_run_usd) ? limits.max_run_usd : null,
      left: isNum(spend.left_usd) ? spend.left_usd : null,
    };
  }

  function counts(data) {
    const c = (data && data.counts) || {};
    const runs = (data && Array.isArray(data.runs)) ? data.runs : [];
    const pendingItems = (data && Array.isArray(data.pending)) ? data.pending : [];
    return {
      running: isNum(c.running) ? c.running : runs.filter(function (r) { return r.state === "running"; }).length,
      queued: isNum(c.queued) ? c.queued : runs.filter(function (r) { return r.state === "queued"; }).length,
      waiting: isNum(c.waiting) ? c.waiting : pendingItems.length,
    };
  }

  // ---------------------------------------------------------------------------
  // Small hooks
  // ---------------------------------------------------------------------------

  /** GET a route once (or every `intervalMs`); `reload()` fetches again now. */
  function useResource(path, intervalMs) {
    const [state, setState] = useState({ status: path ? "loading" : "idle", data: null, error: null, path: path });
    const [nonce, setNonce] = useState(0);
    useEffect(function () {
      if (!path) {
        setState({ status: "idle", data: null, error: null, path: path });
        return undefined;
      }
      let alive = true;
      let timer = null;
      setState(function (prev) {
        return { status: "loading", data: prev.path === path ? prev.data : null, error: null, path: path };
      });
      function tick() {
        apiGet(path).then(function (res) {
          if (!alive) return;
          setState(function (prev) {
            return res.ok
              ? { status: "ok", data: res.data, error: null, path: path }
              : { status: "error", data: prev.path === path ? prev.data : null, error: res.error, path: path };
          });
          if (intervalMs) timer = setTimeout(tick, intervalMs);
        });
      }
      tick();
      return function () {
        alive = false;
        clearTimeout(timer);
      };
    }, [path, intervalMs, nonce]);
    const reload = useCallback(function () { setNonce(function (n) { return n + 1; }); }, []);
    return { status: state.status, data: state.data, error: state.error, reload: reload };
  }

  /** The current time, ticking every `stepMs` while `enabled`. */
  function useNow(stepMs, enabled) {
    const [now, setNow] = useState(Date.now());
    useEffect(function () {
      if (!enabled) return undefined;
      const id = setInterval(function () { setNow(Date.now()); }, stepMs);
      return function () { clearInterval(id); };
    }, [stepMs, enabled]);
    return now;
  }

  /** Whether the dashboard theme is a light one, so semantic colours can darken for contrast. */
  function parseColor(value) {
    const v = str(value).trim();
    let m = /^#([0-9a-f]{3})$/i.exec(v);
    if (m) return m[1].split("").map(function (c) { return parseInt(c + c, 16); });
    m = /^#([0-9a-f]{6})/i.exec(v);
    if (m) return [0, 2, 4].map(function (i) { return parseInt(m[1].slice(i, i + 2), 16); });
    m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(v);
    if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
    return null;
  }
  function isLightTheme() {
    try {
      const raw = window.getComputedStyle(document.documentElement).getPropertyValue("--background-base");
      const rgb = parseColor(raw);
      if (!rgb) return false;
      return (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255 > 0.6;
    } catch (_) {
      return false;
    }
  }
  function useLightTheme() {
    const [light, setLight] = useState(isLightTheme);
    useEffect(function () {
      function check() { setLight(isLightTheme()); }
      check();
      if (typeof MutationObserver !== "function") return undefined;
      const observer = new MutationObserver(check);
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class", "data-theme"] });
      return function () { observer.disconnect(); };
    }, []);
    return light;
  }

  // ---------------------------------------------------------------------------
  // Navigation inside the dashboard (react-router BrowserRouter listens to popstate)
  // ---------------------------------------------------------------------------

  function basePath() {
    const raw = str(window.__HERMES_BASE_PATH__);
    if (!raw) return "";
    return (raw.charAt(0) === "/" ? raw : "/" + raw).replace(/\/+$/, "");
  }
  function appHref(path) { return basePath() + path; }
  function navigate(path) {
    const href = appHref(path);
    try {
      const current = window.history.state;
      const idx = current && typeof current.idx === "number" ? current.idx + 1 : 0;
      window.history.pushState({ usr: null, key: Math.random().toString(36).slice(2, 10), idx: idx }, "", href);
      window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
    } catch (_) {
      window.location.assign(href);
    }
  }
  function linkProps(path, extra) {
    return Object.assign(
      {
        href: appHref(path),
        onClick: function (event) {
          if (event.defaultPrevented || event.button !== 0) return;
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          navigate(path);
        },
      },
      extra || {}
    );
  }
  function readParams() {
    try { return new URLSearchParams(window.location.search); } catch (_) { return new URLSearchParams(""); }
  }
  function writeParams(update) {
    try {
      const params = readParams();
      Object.keys(update).forEach(function (key) {
        if (update[key] == null || update[key] === "") params.delete(key);
        else params.set(key, update[key]);
      });
      const qs = params.toString();
      const url = window.location.pathname + (qs ? "?" + qs : "") + window.location.hash;
      window.history.replaceState(window.history.state, "", url);
    } catch (_) { /* the URL is a convenience only */ }
  }
  function validSection(id) {
    return SECTIONS.some(function (s) { return s.id === id; }) ? id : null;
  }

  function copyText(value) {
    const textValue = str(value);
    function fallback() {
      try {
        const area = document.createElement("textarea");
        area.value = textValue;
        area.setAttribute("readonly", "");
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        const ok = typeof document.execCommand === "function" && document.execCommand("copy");
        document.body.removeChild(area);
        return !!ok;
      } catch (_) {
        return false;
      }
    }
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
        return navigator.clipboard.writeText(textValue).then(
          function () { return true; },
          function () { return fallback(); }
        );
      }
    } catch (_) { /* fall through */ }
    return Promise.resolve(fallback());
  }

  // ---------------------------------------------------------------------------
  // Atoms
  // ---------------------------------------------------------------------------

  function Pill(props) {
    return h(
      "span",
      { className: "roko-pill roko-tone-" + (props.tone || "muted"), title: props.title || undefined },
      props.children
    );
  }

  function Dot(props) {
    return h("span", {
      className: "roko-dot roko-tone-" + (props.tone || "muted") + (props.pulse ? " roko-dot--pulse" : ""),
      "aria-hidden": "true",
    });
  }

  /** A thin bar: value of max, coloured at 80 % / 95 %; `extra` adds a hatched segment. */
  function Meter(props) {
    const max = props.max;
    if (!isNum(max) || max <= 0) return null;
    const value = isNum(props.value) ? Math.max(0, props.value) : 0;
    const extra = isNum(props.extra) ? Math.max(0, props.extra) : 0;
    const first = Math.min(100, (value / max) * 100);
    const second = Math.min(100 - first, (extra / max) * 100);
    return h(
      "div",
      {
        className: "roko-meter roko-tone-" + capTone(value + extra, max),
        role: "meter",
        "aria-valuemin": 0,
        "aria-valuemax": max,
        "aria-valuenow": value,
        "aria-label": props.label || undefined,
      },
      h("span", { className: "roko-meter-fill", style: { width: first.toFixed(1) + "%" } }),
      second > 0 ? h("span", { className: "roko-meter-extra", style: { width: second.toFixed(1) + "%" } }) : null
    );
  }

  function CopyButton(props) {
    const [state, setState] = useState("idle");
    useEffect(function () {
      if (state === "idle") return undefined;
      const timer = setTimeout(function () { setState("idle"); }, 1600);
      return function () { clearTimeout(timer); };
    }, [state]);
    return h(
      Button,
      {
        size: "sm",
        outlined: true,
        type: "button",
        className: "roko-copy",
        "aria-label": "Copy the " + (props.what || "text"),
        onClick: function () {
          copyText(props.value).then(function (ok) { setState(ok ? "copied" : "failed"); });
        },
      },
      state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy"
    );
  }

  function ErrorNote(props) {
    const e = props.error || {};
    return h(
      "div",
      { className: "roko-error", role: "alert" },
      h(
        "div",
        { className: "roko-error-msg" },
        h("span", { className: "roko-tone-bad", "aria-hidden": "true" }, "✗ "),
        str(e.message) || "Something went wrong."
      ),
      e.hint ? h("div", { className: "roko-error-hint" }, str(e.hint)) : null,
      e.kind === "roko" && e.code ? h("div", { className: "roko-error-code" }, "code: " + str(e.code)) : null,
      props.onRetry
        ? h(Button, { size: "sm", outlined: true, type: "button", onClick: props.onRetry }, "Retry")
        : null
    );
  }

  function Empty(props) {
    return h(
      "div",
      { className: "roko-empty" },
      h("div", { className: "roko-empty-title" }, props.title),
      props.children ? h("div", { className: "roko-empty-body" }, props.children) : null
    );
  }

  function Loading(props) {
    return h("div", { className: "roko-loading", role: "status" }, h(Dot, { tone: "run", pulse: true }), props.label || "Loading…");
  }

  function Panel(props) {
    return h(
      Card,
      { className: "roko-panel " + (props.className || "") },
      props.title || props.actions
        ? h(
            "div",
            { className: "roko-panel-head" },
            h("h3", { className: "roko-panel-title" }, props.title),
            props.actions ? h("div", { className: "roko-panel-actions" }, props.actions) : null
          )
        : null,
      h("div", { className: "roko-panel-body" }, props.children)
    );
  }

  function KV(props) {
    return h(
      "div",
      { className: "roko-kv-item" },
      h("span", { className: "roko-kv-key" }, props.k),
      h("span", { className: "roko-kv-value" + (props.mono ? " roko-mono" : "") }, props.children)
    );
  }

  // ---------------------------------------------------------------------------
  // Waiting items (shared by the Waiting tab and the run card)
  // ---------------------------------------------------------------------------

  function Deadline(props) {
    const left = (ms(props.at) - props.now) / 1000;
    if (!isFinite(left)) return null;
    if (left <= 0) {
      return h(Pill, { tone: "bad", title: "roko's wait for this answer may have ended" }, "deadline passed");
    }
    return h(Pill, { tone: left < 30 ? "bad" : left < 60 ? "warn" : "idle", title: "answer before " + str(props.at) }, "answer within " + clock(left));
  }

  function LongText(props) {
    const value = str(props.value);
    const [open, setOpen] = useState(false);
    if (!value) return null;
    const long = value.length > (props.limit || 420);
    return h(
      "div",
      { className: "roko-longtext" },
      h("div", { className: "roko-pre roko-pre--prose" + (long && !open ? " is-clamped" : "") }, value),
      long
        ? h(
            "button",
            { type: "button", className: "roko-linkbtn", onClick: function () { setOpen(!open); } },
            open ? "Show less" : "Show all"
          )
        : null
    );
  }

  function PendingCard(props) {
    const item = props.item;
    const canAct = useLimits().canAct;
    const [note, setNote] = useState("");
    const [busy, setBusy] = useState(null);
    const [error, setError] = useState(null);

    function decide(approve) {
      setBusy(approve ? "approve" : "reject");
      setError(null);
      const body = { code: item.code, approve: approve };
      if (note.trim()) body.note = note.trim();
      apiPost("/decide", body).then(function (res) {
        setBusy(null);
        if (res.ok) {
          const outcome = res.data.outcome ? " (" + str(res.data.outcome) + ")" : "";
          props.notify((approve ? "Approved " : "Rejected ") + str(res.data.title || item.title) + outcome, "success");
          props.onDecided(item, res.data);
          return;
        }
        setError(res.error);
        props.notify(res.error.message, "error");
        if (res.error.code === "not_found") props.onDecided(item, null);
      });
    }

    const args = item.arguments && typeof item.arguments === "object" ? Object.keys(item.arguments) : [];
    const kindTone = item.kind === "effect" ? "warn" : "idle";
    return h(
      "div",
      { className: "roko-pending", "data-roko-pending": str(item.code) },
      h(
        "div",
        { className: "roko-pending-top" },
        h(Pill, { tone: kindTone }, item.kind === "effect" ? "held action" : "confirm"),
        h("span", { className: "roko-pending-title" }, str(item.title)),
        h("span", { className: "roko-code", title: "the code /roko approve and /roko reject take" }, str(item.code)),
        item.kind === "confirm" && item.deadline_at ? h(Deadline, { at: item.deadline_at, now: props.now }) : null
      ),
      item.question ? h("div", { className: "roko-pending-question" }, str(item.question)) : null,
      item.summary ? h(LongText, { value: item.summary }) : null,
      item.kind === "effect"
        ? h(
            "div",
            { className: "roko-kv" },
            item.tool ? h(KV, { k: "tool", mono: true }, str(item.tool)) : null,
            item.server ? h(KV, { k: "server", mono: true }, str(item.server)) : null,
            args.length
              ? h(
                  KV,
                  { k: "arguments" },
                  args.map(function (name) {
                    return h("span", { key: name, className: "roko-argtype roko-mono" }, name + ": " + str(item.arguments[name]));
                  })
                )
              : null
          )
        : null,
      h(
        "div",
        { className: "roko-pending-meta roko-dim" },
        "run " + shortId(item.run_id) + (item.task_id ? " · task " + str(item.task_id) : ""),
        item.held_at ? " · held " + ago(item.held_at, props.now) : "",
        item.proposed_at ? " · proposed " + ago(item.proposed_at, props.now) : ""
      ),
      !canAct
        ? h(
            "div",
            { className: "roko-dim roko-actions-off" },
            "Answering from the dashboard is turned off; answer in chat with /roko approve " + str(item.code) +
              " or /roko reject " + str(item.code) + "."
          )
        : h(
        "div",
        { className: "roko-decide" },
        h(Input, {
          className: "roko-note",
          type: "text",
          value: note,
          maxLength: 2000,
          placeholder: "Note for roko (optional; a reason helps a rejected task retry)",
          "aria-label": "Note for " + str(item.code),
          onChange: function (event) { setNote(event.target.value); },
          disabled: !!busy,
        }),
        h(
          Button,
          { size: "sm", type: "button", disabled: !!busy, onClick: function () { decide(true); }, "aria-label": "Approve " + str(item.code) },
          busy === "approve" ? "Approving…" : "Approve"
        ),
        h(
          Button,
          { size: "sm", outlined: true, destructive: true, type: "button", disabled: !!busy, onClick: function () { decide(false); }, "aria-label": "Reject " + str(item.code) },
          busy === "reject" ? "Rejecting…" : "Reject"
        )
      ),
      error ? h(ErrorNote, { error: error }) : null
    );
  }

  function PendingList(props) {
    const items = props.items || [];
    const now = useNow(1000, items.some(function (it) { return it.kind === "confirm" && it.deadline_at; }));
    if (!items.length) return props.empty || null;
    return h(
      "div",
      { className: "roko-pending-list" },
      items.map(function (item) {
        return h(PendingCard, {
          key: str(item.decision_id || item.code),
          item: item,
          now: now,
          notify: props.notify,
          onDecided: props.onDecided,
        });
      })
    );
  }

  // ---------------------------------------------------------------------------
  // Runs
  // ---------------------------------------------------------------------------

  function RunList(props) {
    const now = useNow(30000, true);
    return h(
      "div",
      { className: "roko-runlist", role: "list" },
      props.runs.map(function (run) {
        const selected = run.run_id === props.selected;
        const tone = stateTone(run.state);
        return h(
          "button",
          {
            key: str(run.run_id),
            type: "button",
            role: "listitem",
            className: "roko-runitem roko-edge-" + tone + (selected ? " is-selected" : ""),
            "aria-current": selected ? "true" : undefined,
            onClick: function () { props.onSelect(run.run_id); },
          },
          h(
            "div",
            { className: "roko-runitem-top" },
            h(Pill, { tone: tone }, str(run.state || "unknown")),
            h("span", { className: "roko-kind" }, KIND_LABEL[run.kind] || str(run.kind)),
            h("span", { className: "roko-runitem-ago" }, ago(run.started_at, now))
          ),
          h("div", { className: "roko-runitem-label", title: str(run.label) }, str(run.label) || "(no label)"),
          h(
            "div",
            { className: "roko-runitem-meta" },
            h("span", { className: "roko-mono" }, shortId(run.run_id)),
            h("span", null, costOfCap(run.cost_usd, run.max_usd))
          )
        );
      })
    );
  }

  function TaskRow(props) {
    const task = props.task;
    const info = outcomeInfo(task);
    const gates = Array.isArray(task.gates) ? task.gates : [];
    const [openGate, setOpenGate] = useState(null);
    return h(
      "div",
      { className: "roko-task", "data-roko-task": str(task.task_id) },
      h("span", { className: "roko-task-glyph roko-tone-" + info.tone, title: info.label, "aria-label": info.label }, info.glyph),
      h(
        "div",
        { className: "roko-task-main" },
        h(
          "div",
          { className: "roko-task-title" },
          h("span", { className: "roko-mono roko-task-id" }, str(task.task_id)),
          h("span", null, str(task.title))
        ),
        h(
          "div",
          { className: "roko-task-meta roko-dim" },
          info.label,
          task.model ? " · " + str(task.model) : "",
          isNum(task.attempts) && task.attempts > 1 ? " · attempt " + task.attempts : ""
        ),
        gates.length
          ? h(
              "div",
              { className: "roko-gates" },
              gates.map(function (gate, i) {
                return h(
                  "button",
                  {
                    key: i,
                    type: "button",
                    className: "roko-gate roko-tone-" + (gate.passed ? "ok" : "bad"),
                    "aria-expanded": openGate === i ? "true" : "false",
                    title: (gate.passed ? "passed" : "failed") + ": show the gate's output",
                    onClick: function () { setOpenGate(openGate === i ? null : i); },
                  },
                  (gate.passed ? "✓ " : "✗ ") + str(gate.gate)
                );
              })
            )
          : null,
        openGate != null && gates[openGate]
          ? h("pre", { className: "roko-pre" }, str(gates[openGate].excerpt) || "(no output recorded)")
          : null
      )
    );
  }

  const EVENT_GLYPHS = {
    plan_started: "▸",
    task_started: "⟳",
    agent_spawned: "◆",
    gate_rung_started: "↻",
    task_completed: "✓",
    task_blocked: "✗",
    plan_completed: "■",
    run_completed: "■",
    error: "✗",
  };
  function eventGlyph(event) {
    if (event.type === "gate_result") return event.passed ? "✓" : "✗";
    return EVENT_GLYPHS[event.type] || "·";
  }
  function eventTone(event) {
    if (event.type === "error" || event.type === "task_blocked") return "bad";
    if (event.type === "gate_result") return event.passed ? "ok" : "bad";
    if (event.type === "task_completed") return "ok";
    return "muted";
  }

  /** The run's timeline, fetched incrementally with the events cursor. */
  function Timeline(props) {
    const runId = props.runId;
    const [events, setEvents] = useState([]);
    const [error, setError] = useState(null);
    const [loaded, setLoaded] = useState(false);
    const activeRef = useRef(props.active);
    activeRef.current = props.active;
    const kickRef = useRef(null);

    useEffect(function () {
      let alive = true;
      let timer = null;
      let cursor = null;
      let running = false;
      const seen = new Set();
      setEvents([]);
      setError(null);
      setLoaded(false);

      function pull() {
        if (running) return;
        running = true;
        clearTimeout(timer);
        timer = null;
        let pages = 0;
        let added = [];
        function page() {
          const q = "?limit=100" + (cursor != null ? "&cursor=" + enc(cursor) : "");
          return apiGet("/runs/" + enc(runId) + "/events" + q).then(function (res) {
            if (!alive) return false;
            if (!res.ok) {
              setError(res.error);
              return false;
            }
            setError(null);
            const list = Array.isArray(res.data.events) ? res.data.events : [];
            list.forEach(function (ev) {
              const key = ev.cursor != null ? "c" + ev.cursor : "t" + str(ev.type) + str(ev.text);
              if (seen.has(key)) return;
              seen.add(key);
              added.push(ev);
            });
            if (res.data.next_cursor != null) cursor = res.data.next_cursor;
            pages += 1;
            return !!res.data.has_more && list.length > 0 && pages < MAX_EVENT_PAGES;
          });
        }
        function loop() {
          return page().then(function (more) { return more ? loop() : null; });
        }
        loop().then(function () {
          running = false;
          if (!alive) return;
          setLoaded(true);
          if (added.length) {
            const fresh = added;
            setEvents(function (prev) { return prev.concat(fresh).slice(-MAX_EVENTS); });
          }
          if (activeRef.current) timer = setTimeout(pull, RUN_POLL_MS);
        });
      }
      kickRef.current = function () { if (!timer && !running) pull(); };
      pull();
      return function () {
        alive = false;
        clearTimeout(timer);
        kickRef.current = null;
      };
    }, [runId]);

    // A run that was idle and became active again (resumed) starts polling again.
    useEffect(function () {
      if (props.active && kickRef.current) kickRef.current();
    }, [props.active]);

    return h(
      "div",
      { className: "roko-timeline" },
      error ? h(ErrorNote, { error: error }) : null,
      !loaded && !error ? h(Loading, { label: "Loading the timeline…" }) : null,
      loaded && !events.length && !error ? h("div", { className: "roko-dim" }, "No events recorded yet.") : null,
      events.length
        ? h(
            "ol",
            { className: "roko-events" },
            events.map(function (ev, i) {
              return h(
                "li",
                { key: ev.cursor != null ? "c" + ev.cursor : "i" + i, className: "roko-event" },
                h("span", { className: "roko-event-glyph roko-tone-" + eventTone(ev), "aria-hidden": "true" }, eventGlyph(ev)),
                // The line names its task already ("T1 started: …"); the column is for lines that do not.
                ev.task_id && str(ev.text).indexOf(str(ev.task_id) + " ") !== 0
                  ? h("span", { className: "roko-mono roko-event-task" }, str(ev.task_id))
                  : null,
                h("span", { className: "roko-event-text" }, str(ev.text) || str(ev.type))
              );
            })
          )
        : null
    );
  }

  function Delivered(props) {
    const run = props.run;
    const d = run.delivered;
    if (!d || typeof d !== "object") return null;
    const files = Array.isArray(d.files_changed) ? d.files_changed : [];
    return h(
      "section",
      { className: "roko-section" },
      h("h4", { className: "roko-subhead" }, "Delivered"),
      h(
        "div",
        { className: "roko-kv" },
        h(KV, { k: "branch", mono: true }, str(d.branch)),
        h(KV, { k: "commit", mono: true }, str(d.commit)),
        h(KV, { k: "merged" }, d.merged ? h(Pill, { tone: "ok" }, "merged") : h(Pill, { tone: "warn" }, "not merged yet")),
        d.workspace ? h(KV, { k: "workspace", mono: true }, str(d.workspace)) : null
      ),
      d.diffstat ? h("div", { className: "roko-dim" }, str(d.diffstat)) : null,
      files.length
        ? h(
            "ul",
            { className: "roko-files" },
            files.slice(0, 40).map(function (f, i) { return h("li", { key: i, className: "roko-mono" }, str(f)); })
          )
        : null,
      run.review_command ? h(CommandRow, { label: "Review", value: run.review_command }) : null,
      run.merge_command && !d.merged ? h(CommandRow, { label: "Merge", value: run.merge_command }) : null
    );
  }

  function CommandRow(props) {
    return h(
      "div",
      { className: "roko-cmd" },
      h("span", { className: "roko-cmd-label" }, props.label),
      h("code", { className: "roko-cmd-text" }, str(props.value)),
      h(CopyButton, { value: props.value, what: props.label.toLowerCase() + " command" })
    );
  }

  function RunDetail(props) {
    const runId = props.runId;
    const limits = useLimits();
    const [state, setState] = useState({ status: "loading", run: null, error: null });
    const [nonce, setNonce] = useState(0);
    const [confirmCancel, setConfirmCancel] = useState(false);
    const [cancelling, setCancelling] = useState(false);
    const [showTimeline, setShowTimeline] = useState(true);
    const [answered, setAnswered] = useState({});
    // Whether the last good answer showed an active run: only an active run is polled,
    // and a failing poll keeps going only for a run that was active (a blip, not a 404).
    const lastActiveRef = useRef(null);

    useEffect(function () {
      let alive = true;
      let timer = null;
      function tick() {
        apiGet("/runs/" + enc(runId)).then(function (res) {
          if (!alive) return;
          let keepPolling;
          if (res.ok) {
            const run = res.data.run && typeof res.data.run === "object" ? res.data.run : {};
            keepPolling = isRunActive(run);
            lastActiveRef.current = keepPolling;
            setState({ status: "ok", run: run, error: null });
          } else {
            keepPolling = lastActiveRef.current === true && res.error.kind !== "backend";
            setState(function (prev) { return { status: "error", run: prev.run, error: res.error }; });
          }
          if (keepPolling) timer = setTimeout(tick, RUN_POLL_MS);
        });
      }
      tick();
      return function () {
        alive = false;
        clearTimeout(timer);
      };
    }, [runId, nonce]);

    const run = state.run;
    if (!run) {
      if (state.error) {
        return h(Panel, { title: "Run " + shortId(runId) }, h(ErrorNote, { error: state.error, onRetry: function () { setNonce(function (n) { return n + 1; }); } }));
      }
      return h(Panel, { title: "Run " + shortId(runId) }, h(Loading, { label: "Loading the run…" }));
    }

    const active = isRunActive(run);
    const canAct = limits.canAct;
    const tone = stateTone(run.state);
    const tasks = Array.isArray(run.tasks) ? run.tasks : [];
    const milestones = Array.isArray(run.milestones) ? run.milestones : [];
    const waiting = (Array.isArray(run.waiting) ? run.waiting : []).filter(function (it) { return !answered[it.decision_id]; });
    const gates = run.gates && typeof run.gates === "object" ? run.gates : null;
    const tok = run.tokens && typeof run.tokens === "object" ? run.tokens : null;

    function doCancel() {
      setConfirmCancel(false);
      setCancelling(true);
      apiPost("/runs/" + enc(runId) + "/cancel", {}).then(function (res) {
        setCancelling(false);
        if (res.ok) {
          props.notify("Cancelled run " + shortId(runId) + " (" + str(res.data.state || "cancelled") + ")", "success");
          setNonce(function (n) { return n + 1; });
          overviewStore.refresh();
        } else {
          props.notify(res.error.message + (res.error.hint ? " — " + res.error.hint : ""), "error");
        }
      });
    }

    return h(
      Panel,
      {
        className: "roko-rundetail",
        title: h(
          "span",
          { className: "roko-rundetail-title" },
          h(Pill, { tone: tone }, str(run.state || "unknown")),
          run.verdict && run.verdict !== run.state ? h(Pill, { tone: stateTone(run.verdict), title: "verdict" }, "verdict: " + str(run.verdict)) : null,
          h("span", { className: "roko-rundetail-label" }, str(run.label) || "(no label)")
        ),
        actions: active && canAct
          ? h(
              Button,
              { size: "sm", outlined: true, destructive: true, type: "button", disabled: cancelling, onClick: function () { setConfirmCancel(true); } },
              cancelling ? "Cancelling…" : "Cancel run"
            )
          : null,
      },
      h(
        "div",
        { className: "roko-rundetail-sub roko-dim" },
        h("span", { className: "roko-mono", title: str(run.run_id) }, shortId(run.run_id)),
        h(CopyButton, { value: run.run_id, what: "run id" }),
        run.plan_id && run.plan_id !== run.run_id
          ? h("span", null, "plan " + str(run.plan_id))
          : h("span", null, KIND_LABEL[run.kind] || str(run.kind)),
        h("span", null, "started " + ago(run.started_at)),
        run.finished_at ? h("span", null, "finished " + ago(run.finished_at)) : null,
        isNum(run.duration_ms) ? h("span", null, duration(run.duration_ms)) : null,
        run.position != null ? h(Pill, { tone: "idle" }, "queue position " + str(run.position)) : null
      ),
      run.headline ? h("div", { className: "roko-headline" }, str(run.headline)) : null,
      h(
        "div",
        { className: "roko-stats" },
        h(
          "div",
          { className: "roko-stat" },
          h("div", { className: "roko-stat-label" }, "Cost"),
          h("div", { className: "roko-stat-value roko-tone-" + capTone(run.cost_usd, run.max_usd) }, costOfCap(run.cost_usd, run.max_usd)),
          h(Meter, { value: run.cost_usd, max: run.max_usd, label: "cost against the run's cap" }),
          isNum(run.cost_usd) && isNum(run.max_usd) && run.max_usd > 0
            ? h("div", { className: "roko-dim" }, pct(run.cost_usd / run.max_usd) + " of the cap")
            : null
        ),
        h(
          "div",
          { className: "roko-stat" },
          h("div", { className: "roko-stat-label" }, "Gates"),
          h(
            "div",
            { className: "roko-stat-value" },
            gates ? (isNum(gates.passed) ? gates.passed : 0) + " passed · " + (isNum(gates.failed) ? gates.failed : 0) + " failed" : "—"
          )
        ),
        h(
          "div",
          { className: "roko-stat" },
          h("div", { className: "roko-stat-label" }, "Tokens"),
          h(
            "div",
            { className: "roko-stat-value" },
            tok ? tokens(tok.input) + " in · " + tokens(tok.output) + " out" : "—"
          ),
          tok && isNum(tok.cache_read) ? h("div", { className: "roko-dim" }, tokens(tok.cache_read) + " read from cache") : null
        )
      ),
      state.error ? h(ErrorNote, { error: state.error, onRetry: function () { setNonce(function (n) { return n + 1; }); } }) : null,
      waiting.length
        ? h(
            "section",
            { className: "roko-section" },
            h("h4", { className: "roko-subhead" }, "Waiting on you"),
            h(PendingList, {
              items: waiting,
              notify: props.notify,
              onDecided: function (item) {
                setAnswered(function (prev) { const next = Object.assign({}, prev); next[item.decision_id] = true; return next; });
                setNonce(function (n) { return n + 1; });
                overviewStore.refresh();
              },
            })
          )
        : null,
      h(
        "section",
        { className: "roko-section" },
        h("h4", { className: "roko-subhead" }, "Tasks"),
        tasks.length
          ? h("div", { className: "roko-tasks" }, tasks.map(function (task, i) { return h(TaskRow, { key: str(task.task_id) || i, task: task }); }))
          : h("div", { className: "roko-dim" }, "No task results yet.")
      ),
      h(Delivered, { run: run }),
      milestones.length
        ? h(
            "section",
            { className: "roko-section" },
            h("h4", { className: "roko-subhead" }, "Milestones"),
            h(
              "ul",
              { className: "roko-milestones" },
              milestones.map(function (m, i) { return h("li", { key: i }, str(m && (m.text || m.kind))); })
            )
          )
        : null,
      h(
        "section",
        { className: "roko-section" },
        h(
          "div",
          { className: "roko-subhead-row" },
          h("h4", { className: "roko-subhead" }, "Timeline"),
          h(
            "button",
            { type: "button", className: "roko-linkbtn", "aria-expanded": showTimeline ? "true" : "false", onClick: function () { setShowTimeline(!showTimeline); } },
            showTimeline ? "Hide" : "Show"
          )
        ),
        showTimeline ? h(Timeline, { runId: runId, active: active }) : null
      ),
      h(Confirm, {
        open: confirmCancel,
        title: "Cancel this run?",
        description:
          "roko stops run " + shortId(runId) + " (" + str(run.label).slice(0, 80) + "). Work that already passed its checks is kept.",
        confirmLabel: "Cancel run",
        cancelLabel: "Keep running",
        destructive: true,
        loading: cancelling,
        onConfirm: doCancel,
        onCancel: function () { setConfirmCancel(false); },
      })
    );
  }

  function RunsSection(props) {
    const data = props.overview || {};
    const runs = Array.isArray(data.runs) ? data.runs : [];
    let selected = props.selectedRunId;
    if (!selected && runs.length) {
      const active = runs.filter(function (r) { return isActiveState(r.state); })[0];
      selected = (active || runs[0]).run_id;
    }
    if (!runs.length && !selected) {
      return h(
        Empty,
        { title: "No runs started from Hermes yet." },
        "Ask Hermes to use roko (\"Use roko to … Cap it at $1.\"), or start a plan from the Plans tab."
      );
    }
    const unreachable = data.connection && data.connection.reachable === false;
    return h(
      "div",
      { className: "roko-runs" },
      h(
        "div",
        { className: "roko-runs-side" },
        unreachable ? h("div", { className: "roko-note-line roko-dim" }, "Last known states: roko serve is unreachable.") : null,
        runs.length ? h(RunList, { runs: runs, selected: selected, onSelect: props.onSelectRun }) : null
      ),
      selected ? h(RunDetail, { key: selected, runId: selected, notify: props.notify }) : null
    );
  }

  // ---------------------------------------------------------------------------
  // Waiting
  // ---------------------------------------------------------------------------

  function WaitingSection(props) {
    const res = useResource("/pending", PENDING_POLL_MS);
    const [answered, setAnswered] = useState({});
    const items = res.data && Array.isArray(res.data.items)
      ? res.data.items.filter(function (it) { return !answered[it.decision_id]; })
      : [];
    if (!res.data && res.error) return h(ErrorNote, { error: res.error, onRetry: res.reload });
    if (!res.data) return h(Loading, { label: "Loading what waits on you…" });
    return h(
      "div",
      { className: "roko-waiting" },
      res.error ? h(ErrorNote, { error: res.error, onRetry: res.reload }) : null,
      h(PendingList, {
        items: items,
        notify: props.notify,
        empty: h(Empty, { title: "Nothing waits on you." }, "When a roko run needs your confirmation, or holds an action for approval, it shows up here."),
        onDecided: function (item) {
          setAnswered(function (prev) { const next = Object.assign({}, prev); next[item.decision_id] = true; return next; });
          res.reload();
          overviewStore.refresh();
        },
      })
    );
  }

  // ---------------------------------------------------------------------------
  // Plans
  // ---------------------------------------------------------------------------

  function RunPlanForm(props) {
    const plan = props.plan;
    const limits = useLimits();
    const [cap, setCap] = useState("1.00");
    const [resume, setResume] = useState(false);
    const [confirming, setConfirming] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const capValue = Number(cap);
    const ceiling = limits.maxRun !== null && limits.left !== null ? Math.min(limits.maxRun, limits.left)
      : limits.maxRun !== null ? limits.maxRun : limits.left;
    const capTooHigh = ceiling !== null && isFinite(capValue) && capValue > ceiling + 1e-9;
    const capOk = cap.trim() !== "" && isFinite(capValue) && capValue >= 0.01 && !capTooHigh;
    const est = plan.estimate && typeof plan.estimate === "object" ? plan.estimate : null;

    function start() {
      setConfirming(false);
      setBusy(true);
      setError(null);
      const payload = { max_usd: Math.round(capValue * 100) / 100, resume: resume };
      apiPost("/plans/" + enc(plan.plan_id) + "/run", payload).then(function (res) {
        setBusy(false);
        if (res.ok) {
          props.notify("Started run " + shortId(res.data.run_id) + " for plan " + str(plan.plan_id), "success");
          overviewStore.refresh();
          props.onStarted(res.data);
          return;
        }
        setError(res.error);
      });
    }

    return h(
      "form",
      {
        className: "roko-runform",
        onSubmit: function (event) {
          event.preventDefault();
          if (capOk && !busy) setConfirming(true);
        },
      },
      h("h4", { className: "roko-subhead" }, "Run this plan"),
      h(
        "div",
        { className: "roko-runform-fields" },
        h(
          "label",
          { className: "roko-field" },
          h("span", { className: "roko-field-label" }, "Spending cap (USD)"),
          h(Input, {
            type: "number",
            inputMode: "decimal",
            min: "0.01",
            step: "0.01",
            value: cap,
            "aria-label": "Spending cap in US dollars",
            "aria-invalid": capOk ? undefined : "true",
            onChange: function (event) { setCap(event.target.value); },
          })
        ),
        h(
          "label",
          { className: "roko-check" },
          h("input", {
            type: "checkbox",
            checked: resume,
            onChange: function (event) { setResume(!!event.target.checked); },
          }),
          h("span", null, "Resume the previous run (skip tasks that already passed)")
        ),
        h(Button, { size: "sm", type: "submit", disabled: !capOk || busy }, busy ? "Starting…" : "Run plan…")
      ),
      !capOk
        ? h("div", { className: "roko-field-error" }, capTooHigh ? "Name a cap of at most " + money(ceiling) + "." : "Name a cap of at least $0.01.")
        : null,
      limits.maxRun !== null || limits.left !== null
        ? h(
            "div",
            { className: "roko-dim roko-run-limits" },
            [limits.maxRun !== null ? "at most " + money(limits.maxRun) + " per run" : null,
             limits.left !== null ? money(limits.left) + " left today" : null].filter(Boolean).join(" · ")
          )
        : null,
      h(
        "div",
        { className: "roko-dim" },
        "Paid: roko stops spending at the cap. " +
          (est && isNum(est.total_cost_usd) ? "roko estimates " + money(est.total_cost_usd) + ". " : "") +
          "The plugin and roko serve each refuse caps above their own limits."
      ),
      error ? h(ErrorNote, { error: error }) : null,
      h(Confirm, {
        open: confirming,
        title: "Run plan " + str(plan.plan_id) + "?",
        description:
          "roko runs " + plural(isNum(plan.task_count) ? plan.task_count : (plan.tasks || []).length, "task", "tasks") +
          (resume ? ", resuming the previous run," : "") +
          " and may spend up to " + money(Math.round(capValue * 100) / 100) + " of model budget. This click is your approval.",
        confirmLabel: "Run plan",
        cancelLabel: "Not now",
        loading: busy,
        onConfirm: start,
        onCancel: function () { setConfirming(false); },
      })
    );
  }

  function PlanDetail(props) {
    const res = useResource("/plans/" + enc(props.planId), 0);
    if (!res.data && res.error) return h(Panel, { title: "Plan " + str(props.planId) }, h(ErrorNote, { error: res.error, onRetry: res.reload }));
    if (!res.data) return h(Panel, { title: "Plan " + str(props.planId) }, h(Loading, { label: "Loading the plan…" }));
    const plan = res.data.plan && typeof res.data.plan === "object" ? res.data.plan : {};
    const tasks = Array.isArray(plan.tasks) ? plan.tasks : [];
    const byId = {};
    tasks.forEach(function (t) { byId[t.id] = t; });
    let waves = Array.isArray(plan.waves) && plan.waves.length ? plan.waves.map(function (w) { return Array.isArray(w) ? w : []; }) : null;
    if (!waves) waves = [tasks.map(function (t) { return t.id; })];
    const placed = new Set();
    waves.forEach(function (w) { w.forEach(function (id) { placed.add(id); }); });
    const leftovers = tasks.filter(function (t) { return !placed.has(t.id); });
    const est = plan.estimate && typeof plan.estimate === "object" ? plan.estimate : null;

    return h(
      Panel,
      {
        className: "roko-plandetail",
        title: h(
          "span",
          { className: "roko-rundetail-title" },
          h("span", { className: "roko-mono" }, str(plan.plan_id || props.planId)),
          plan.title ? h("span", { className: "roko-rundetail-label" }, str(plan.title)) : null
        ),
        actions: h(Button, { size: "sm", ghost: true, type: "button", onClick: res.reload }, "Refresh"),
      },
      h(
        "div",
        { className: "roko-stats" },
        h("div", { className: "roko-stat" }, h("div", { className: "roko-stat-label" }, "Tasks"), h("div", { className: "roko-stat-value" }, str(isNum(plan.task_count) ? plan.task_count : tasks.length))),
        h("div", { className: "roko-stat" }, h("div", { className: "roko-stat-label" }, "Parallel"), h("div", { className: "roko-stat-value" }, plan.max_parallel != null ? "up to " + str(plan.max_parallel) : "—")),
        h(
          "div",
          { className: "roko-stat" },
          h("div", { className: "roko-stat-label" }, "Estimate"),
          h(
            "div",
            { className: "roko-stat-value" },
            est ? money(est.total_cost_usd) + " · " + (isNum(est.total_duration_secs) ? duration(est.total_duration_secs * 1000) : "—") : "—"
          ),
          est && est.confidence ? h("div", { className: "roko-dim" }, str(est.confidence) + " confidence") : null
        )
      ),
      h(
        "div",
        { className: "roko-waves", role: "list", "aria-label": "Waves: tasks in a column can run together" },
        waves.map(function (wave, wi) {
          return h(
            "div",
            { key: wi, className: "roko-wave", role: "listitem" },
            h("div", { className: "roko-wave-head" }, "Wave " + (wi + 1), h("span", { className: "roko-dim" }, plural(wave.length, "task", "tasks"))),
            wave.map(function (id) { return h(PlanTask, { key: str(id), task: byId[id] || { id: id, title: "" } }); })
          );
        }),
        leftovers.length
          ? h(
              "div",
              { className: "roko-wave", role: "listitem" },
              h("div", { className: "roko-wave-head" }, "Other tasks"),
              leftovers.map(function (t) { return h(PlanTask, { key: str(t.id), task: t }); })
            )
          : null
      ),
      h(RunPlanForm, { plan: Object.assign({ plan_id: props.planId }, plan), notify: props.notify, onStarted: props.onStarted })
    );
  }

  function PlanTask(props) {
    const t = props.task || {};
    const deps = Array.isArray(t.depends_on) ? t.depends_on : [];
    const checks = Array.isArray(t.checks) ? t.checks : [];
    return h(
      "div",
      { className: "roko-plantask", "data-roko-plantask": str(t.id) },
      h(
        "div",
        { className: "roko-plantask-head" },
        h("span", { className: "roko-mono roko-task-id" }, str(t.id)),
        h("span", { className: "roko-plantask-title" }, str(t.title)),
        t.role ? h("span", { className: "roko-kind" }, str(t.role)) : null
      ),
      deps.length ? h("div", { className: "roko-dim" }, "after " + deps.map(str).join(", ")) : null,
      t.description ? h("div", { className: "roko-plantask-desc" }, str(t.description)) : null,
      checks.length
        ? h(
            "ul",
            { className: "roko-checks" },
            checks.map(function (c, i) { return h("li", { key: i }, h("span", { className: "roko-dim" }, "check "), h("code", { className: "roko-mono" }, str(c))); })
          )
        : null
    );
  }

  function PlansSection(props) {
    const list = useResource("/plans", 0);
    const plans = list.data && Array.isArray(list.data.plans) ? list.data.plans : [];
    const selected = props.selectedPlanId;
    if (!list.data && list.error) return h(ErrorNote, { error: list.error, onRetry: list.reload });
    if (!list.data) return h(Loading, { label: "Loading roko's plans…" });
    return h(
      "div",
      { className: "roko-plans" },
      h(
        "div",
        { className: "roko-plans-side" },
        h(
          "div",
          { className: "roko-subhead-row" },
          h("h4", { className: "roko-subhead" }, plural(isNum(list.data.total) ? list.data.total : plans.length, "plan", "plans")),
          h(Button, { size: "sm", ghost: true, type: "button", onClick: list.reload }, "Refresh")
        ),
        list.error ? h(ErrorNote, { error: list.error, onRetry: list.reload }) : null,
        plans.length
          ? h(
              "div",
              { className: "roko-runlist", role: "list" },
              plans.map(function (p) {
                const done = isNum(p.tasks_done) ? p.tasks_done : null;
                const isSel = p.id === selected;
                return h(
                  "button",
                  {
                    key: str(p.id),
                    type: "button",
                    role: "listitem",
                    className: "roko-runitem" + (isSel ? " is-selected" : ""),
                    "aria-current": isSel ? "true" : undefined,
                    onClick: function () { props.onSelectPlan(p.id); },
                  },
                  h(
                    "div",
                    { className: "roko-runitem-top" },
                    h(Pill, { tone: p.status === "completed" ? "ok" : p.status === "ready" ? "idle" : "muted" }, str(p.status || "plan")),
                    h("span", { className: "roko-runitem-ago" }, done != null ? done + "/" + str(p.task_count) + " done" : plural(p.task_count || 0, "task", "tasks"))
                  ),
                  h("div", { className: "roko-runitem-label" }, str(p.title) || str(p.id)),
                  h("div", { className: "roko-runitem-meta" }, h("span", { className: "roko-mono" }, str(p.id)))
                );
              })
            )
          : h(Empty, { title: "roko has no plans yet." }, "Ask Hermes to plan larger work with roko (roko_plan_generate).")
      ),
      selected
        ? h(PlanDetail, { key: selected, planId: selected, notify: props.notify, onStarted: props.onRunStarted })
        : plans.length
          ? h(Empty, { title: "Pick a plan" }, "Its tasks, waves, checks and estimate show here, with a form to run it.")
          : null
    );
  }

  // ---------------------------------------------------------------------------
  // Knowledge
  // ---------------------------------------------------------------------------

  function KnowledgeSection() {
    const [query, setQuery] = useState("");
    const [submitted, setSubmitted] = useState("");
    const path = submitted ? "/knowledge?q=" + enc(submitted) + "&limit=10" : null;
    const res = useResource(path, 0);
    const entries = res.data && Array.isArray(res.data.entries) ? res.data.entries : [];
    return h(
      "div",
      { className: "roko-knowledge" },
      h(
        "form",
        {
          className: "roko-search",
          role: "search",
          onSubmit: function (event) {
            event.preventDefault();
            const q = query.trim();
            if (q) {
              if (q === submitted) res.reload();
              setSubmitted(q);
            }
          },
        },
        h(Input, {
          type: "search",
          value: query,
          placeholder: "What did roko learn about… (e.g. parser, flaky tests)",
          "aria-label": "Search roko's project knowledge",
          onChange: function (event) { setQuery(event.target.value); },
        }),
        h(Button, { size: "sm", type: "submit", disabled: !query.trim() }, "Search")
      ),
      !submitted ? h(Empty, { title: "Search roko's project knowledge" }, "Lessons, facts and warnings roko's verified runs recorded about this workspace.") : null,
      submitted && res.status === "loading" && !res.data ? h(Loading, { label: "Searching…" }) : null,
      submitted && res.error ? h(ErrorNote, { error: res.error, onRetry: res.reload }) : null,
      submitted && res.data && !entries.length ? h(Empty, { title: "Nothing found for \"" + submitted + "\"." }) : null,
      entries.length
        ? h(
            "ol",
            { className: "roko-entries" },
            entries.map(function (e, i) {
              return h(
                "li",
                { key: str(e.id) || i, className: "roko-entry" },
                h(
                  "div",
                  { className: "roko-entry-meta" },
                  e.kind ? h(Pill, { tone: e.kind === "warning" ? "warn" : "idle" }, str(e.kind)) : null,
                  e.tier ? h("span", { className: "roko-kind" }, str(e.tier)) : null,
                  isNum(e.confidence) ? h("span", { className: "roko-dim" }, pct(e.confidence) + " confidence") : null,
                  isNum(e.score) ? h("span", { className: "roko-dim" }, "score " + e.score.toFixed(2)) : null
                ),
                h("div", { className: "roko-entry-content" }, str(e.content))
              );
            })
          )
        : null
    );
  }

  // ---------------------------------------------------------------------------
  // Health
  // ---------------------------------------------------------------------------

  const CHECK_GLYPH = { ok: ["✓", "ok"], warn: ["!", "warn"], fail: ["✗", "bad"] };

  function Sparkline(props) {
    const points = (props.points || []).filter(function (p) { return p && isNum(p.cumulative_usd); });
    if (points.length < 2) return h("div", { className: "roko-dim" }, points.length ? "Spend so far: " + money(points[0].cumulative_usd) : "No spend recorded yet.");
    const W = 220;
    const H = 44;
    const pad = 3;
    const values = points.map(function (p) { return p.cumulative_usd; });
    const min = Math.min.apply(null, values);
    const max = Math.max.apply(null, values);
    const span = max - min || 1;
    const coords = values.map(function (v, i) {
      const x = pad + (i / (values.length - 1)) * (W - 2 * pad);
      const y = H - pad - ((v - min) / span) * (H - 2 * pad);
      return [x, y];
    });
    const line = coords.map(function (c) { return c[0].toFixed(1) + "," + c[1].toFixed(1); }).join(" ");
    const area = "M" + coords[0][0].toFixed(1) + "," + (H - pad) + " L" + coords.map(function (c) { return c[0].toFixed(1) + "," + c[1].toFixed(1); }).join(" L") + " L" + coords[coords.length - 1][0].toFixed(1) + "," + (H - pad) + " Z";
    const last = coords[coords.length - 1];
    const label = "Cumulative spend from " + money(values[0]) + " to " + money(values[values.length - 1]) + " over " + points.length + " points";
    return h(
      "figure",
      { className: "roko-spark" },
      h(
        "svg",
        { viewBox: "0 0 " + W + " " + H, width: W, height: H, role: "img", "aria-label": label, className: "roko-spark-svg" },
        h("path", { d: area, className: "roko-spark-area" }),
        h("polyline", { points: line, className: "roko-spark-line", fill: "none" }),
        h("circle", { cx: last[0].toFixed(1), cy: last[1].toFixed(1), r: 2.5, className: "roko-spark-dot" })
      ),
      h(
        "figcaption",
        { className: "roko-dim" },
        money(values[values.length - 1]) + " cumulative",
        points[0].at && points[points.length - 1].at ? " · since " + ago(points[0].at) : ""
      )
    );
  }

  function HealthSection() {
    const health = useResource("/health", 0);
    const insights = useResource("/insights", 0);
    const checks = health.data && Array.isArray(health.data.checks) ? health.data.checks : [];
    const gates = insights.data && Array.isArray(insights.data.gates) ? insights.data.gates : [];
    const models = insights.data && Array.isArray(insights.data.models) ? insights.data.models : [];
    const trend = insights.data && Array.isArray(insights.data.cost_trend) ? insights.data.cost_trend : [];
    function reloadAll() { health.reload(); insights.reload(); }

    return h(
      "div",
      { className: "roko-health" },
      h(
        Panel,
        { title: "Connection checks", actions: h(Button, { size: "sm", ghost: true, type: "button", onClick: reloadAll }, "Refresh") },
        !health.data && health.error ? h(ErrorNote, { error: health.error, onRetry: health.reload }) : null,
        !health.data && !health.error ? h(Loading, { label: "Running the checks…" }) : null,
        checks.length
          ? h(
              "ul",
              { className: "roko-checklist" },
              checks.map(function (c, i) {
                const g = CHECK_GLYPH[c.status] || ["·", "muted"];
                return h(
                  "li",
                  { key: i, className: "roko-check-row" },
                  h("span", { className: "roko-check-glyph roko-tone-" + g[1], "aria-label": str(c.status) }, g[0]),
                  h("span", { className: "roko-check-name" }, str(c.name)),
                  h(
                    "span",
                    { className: "roko-check-detail" },
                    str(c.detail),
                    c.hint && c.status !== "ok" ? h("span", { className: "roko-check-hint" }, "→ " + str(c.hint)) : null
                  )
                );
              })
            )
          : null
      ),
      h(
        Panel,
        { title: "Gates" },
        !insights.data && insights.error ? h(ErrorNote, { error: insights.error, onRetry: insights.reload }) : null,
        !insights.data && !insights.error ? h(Loading, { label: "Loading insights…" }) : null,
        insights.data && !gates.length ? h("div", { className: "roko-dim" }, "No gate results recorded yet.") : null,
        gates.length
          ? h(
              "div",
              { className: "roko-bars" },
              gates.map(function (g, i) {
                const rate = isNum(g.pass_rate) ? Math.max(0, Math.min(1, g.pass_rate)) : null;
                const tone = rate == null ? "muted" : rate >= 0.9 ? "ok" : rate >= 0.7 ? "warn" : "bad";
                return h(
                  "div",
                  { key: i, className: "roko-bar-row" },
                  h("span", { className: "roko-mono roko-bar-name", title: str(g.gate) }, str(g.gate)),
                  h(
                    "span",
                    { className: "roko-bar roko-tone-" + tone, role: "meter", "aria-valuemin": 0, "aria-valuemax": 1, "aria-valuenow": rate == null ? undefined : rate, "aria-label": "pass rate of " + str(g.gate) },
                    h("span", { className: "roko-bar-fill", style: { width: rate == null ? "0%" : (rate * 100).toFixed(1) + "%" } })
                  ),
                  h(
                    "span",
                    { className: "roko-bar-value" },
                    pct(rate),
                    h("span", { className: "roko-dim" }, " · " + (isNum(g.passed) ? g.passed : 0) + "✓ " + (isNum(g.failed) ? g.failed : 0) + "✗" + (isNum(g.avg_duration_ms) ? " · " + duration(g.avg_duration_ms) + " avg" : ""))
                  )
                );
              })
            )
          : null
      ),
      h(
        Panel,
        { title: "Models" },
        insights.data && !models.length ? h("div", { className: "roko-dim" }, "No model results recorded yet.") : null,
        models.length
          ? h(
              "table",
              { className: "roko-table" },
              h("thead", null, h("tr", null, h("th", null, "Model"), h("th", null, "Tasks"), h("th", null, "Success"), h("th", null, "Cost"))),
              h(
                "tbody",
                null,
                models.map(function (m, i) {
                  const rate = isNum(m.success_rate) ? m.success_rate : null;
                  return h(
                    "tr",
                    { key: i },
                    h("td", { className: "roko-mono" }, str(m.model)),
                    h("td", null, isNum(m.tasks) ? String(m.tasks) : "—"),
                    h("td", { className: "roko-tone-" + (rate == null ? "muted" : rate >= 0.9 ? "ok" : rate >= 0.7 ? "warn" : "bad") }, pct(rate)),
                    h("td", null, money(m.total_cost_usd))
                  );
                })
              )
            )
          : null
      ),
      h(
        Panel,
        { title: "Spend" },
        insights.data ? h(Sparkline, { points: trend }) : null
      )
    );
  }

  // ---------------------------------------------------------------------------
  // The page
  // ---------------------------------------------------------------------------

  function StatusHeader(props) {
    const ov = props.overview;
    const data = ov.data;
    const conn = data && data.connection ? data.connection : null;
    const spend = data && data.spend ? data.spend : null;
    let connection;
    if (!data && ov.error) {
      connection = h(
        "div",
        { className: "roko-conn" },
        h(Dot, { tone: "muted" }),
        h("span", null, ov.error.kind === "backend" ? "backend not loaded" : "dashboard server unreachable")
      );
    } else if (!conn) {
      connection = h("div", { className: "roko-conn" }, h(Dot, { tone: "idle", pulse: true }), h("span", null, "connecting…"));
    } else if (conn.reachable) {
      const degraded = conn.status && conn.status !== "ok";
      connection = h(
        "div",
        { className: "roko-conn" },
        h(Dot, { tone: degraded ? "warn" : "ok" }),
        h("span", { className: "roko-conn-main" }, "roko " + (conn.version ? str(conn.version) : "") + (conn.status ? " · " + str(conn.status) : "")),
        h("span", { className: "roko-mono roko-dim" }, str(conn.url))
      );
    } else {
      const e = conn.error || {};
      connection = h(
        "div",
        { className: "roko-conn roko-conn--down" },
        h(Dot, { tone: "bad" }),
        h("span", { className: "roko-conn-main" }, "roko serve unreachable"),
        h("span", { className: "roko-mono roko-dim" }, str(conn.url)),
        e.message ? h("span", { className: "roko-conn-msg" }, str(e.message)) : null,
        e.hint ? h("span", { className: "roko-conn-hint roko-dim" }, str(e.hint)) : null
      );
    }

    return h(
      "div",
      { className: "roko-head", "data-roko": "status" },
      connection,
      spend
        ? h(
            "div",
            { className: "roko-spend" },
            h(
              "span",
              { className: "roko-spend-text" },
              "today " + money(spend.today_usd) + (isNum(spend.max_day_usd) ? " of " + money(spend.max_day_usd) : ""),
              isNum(spend.committed_usd) && spend.committed_usd > 0
                ? h("span", { className: "roko-dim" }, " · " + money(spend.committed_usd) + " committed")
                : null,
              isNum(spend.max_day_usd) && isNum(spend.left_usd)
                ? h("span", { className: "roko-dim" }, " · " + money(spend.left_usd) + " left")
                : null
            ),
            h(Meter, { value: spend.today_usd, extra: spend.committed_usd, max: spend.max_day_usd, label: "today's spend against the daily limit" })
          )
        : null,
      h(
        "div",
        { className: "roko-head-end" },
        data && data.checked_at ? h("span", { className: "roko-dim" }, "checked " + ago(data.checked_at)) : null,
        h(Button, { size: "sm", ghost: true, type: "button", onClick: function () { overviewStore.refresh(); }, "aria-label": "Refresh roko's status" }, "Refresh")
      )
    );
  }

  function BackendDown(props) {
    const e = props.error || {};
    return h(
      Panel,
      { title: e.kind === "backend" ? "roko's backend is not loaded" : "Can't reach the dashboard server", className: "roko-backend-down" },
      h(ErrorNote, { error: e, onRetry: props.onRetry }),
      e.kind === "backend" && e.status === 404
        ? h(
            "ol",
            { className: "roko-steps" },
            h("li", null, "Stop the running `hermes dashboard` (Ctrl+C, or `hermes dashboard --stop`)."),
            h("li", null, "Start it again: `hermes dashboard`."),
            h("li", null, "Open this tab again. `hermes plugins list` should show roko as enabled.")
          )
        : null
    );
  }

  class ErrorBoundary extends React.Component {
    constructor(props) {
      super(props);
      this.state = { error: null };
    }
    static getDerivedStateFromError(error) {
      return { error: error };
    }
    componentDidCatch(error) {
      if (window.console && console.error) console.error("roko dashboard plugin crashed:", error);
    }
    render() {
      if (this.state.error) {
        if (this.props.silent) return null;
        const self = this;
        return h(
          Panel,
          { title: "The roko tab hit a rendering error" },
          h("div", { className: "roko-dim" }, String((this.state.error && this.state.error.message) || this.state.error)),
          h(Button, { size: "sm", type: "button", onClick: function () { self.setState({ error: null }); } }, "Reload the view")
        );
      }
      return this.props.children;
    }
  }

  function RokoPage() {
    const ov = useOverview();
    const light = useLightTheme();
    const toastApi = useToastImpl();
    const notify = toastApi.showToast;
    const initial = useMemo(readParams, []);
    const [section, setSectionState] = useState(validSection(initial.get("section")) || "runs");
    const [runId, setRunId] = useState(initial.get("run") || null);
    const [planId, setPlanId] = useState(initial.get("plan") || null);

    useEffect(function () {
      function sync() {
        const p = readParams();
        setSectionState(validSection(p.get("section")) || "runs");
        if (p.get("run")) setRunId(p.get("run"));
        if (p.get("plan")) setPlanId(p.get("plan"));
      }
      window.addEventListener("popstate", sync);
      return function () { window.removeEventListener("popstate", sync); };
    }, []);

    function setSection(id) {
      setSectionState(id);
      writeParams({ section: id === "runs" ? null : id });
    }
    function selectRun(id) {
      setRunId(id);
      setSectionState("runs");
      writeParams({ run: id, section: null });
    }
    function selectPlan(id) {
      setPlanId(id);
      writeParams({ plan: id, section: "plans" });
    }

    const data = ov.data;
    const c = counts(data);
    const blocked = !data && ov.error && ov.error.kind !== "roko";
    const loadingFirst = !data && !ov.error;

    let body = null;
    if (blocked) {
      body = h(BackendDown, { error: ov.error, onRetry: function () { overviewStore.refresh(); } });
    } else if (loadingFirst) {
      body = h(Loading, { label: "Loading roko…" });
    } else if (section === "runs") {
      body = h(RunsSection, { overview: data, selectedRunId: runId, onSelectRun: selectRun, notify: notify });
    } else if (section === "waiting") {
      body = h(WaitingSection, { notify: notify });
    } else if (section === "plans") {
      body = h(PlansSection, {
        selectedPlanId: planId,
        onSelectPlan: selectPlan,
        notify: notify,
        onRunStarted: function (started) { if (started && started.run_id) selectRun(started.run_id); },
      });
    } else if (section === "knowledge") {
      body = h(KnowledgeSection, null);
    } else if (section === "health") {
      body = h(HealthSection, null);
    }

    const badges = { runs: c.running + c.queued, waiting: c.waiting };
    return h(
      "div",
      { className: "roko" + (light ? " roko--light" : ""), "data-roko": "page" },
      h(StatusHeader, { overview: ov }),
      data && ov.error ? h(ErrorNote, { error: ov.error, onRetry: function () { overviewStore.refresh(); } }) : null,
      blocked
        ? null
        : h(
            TabsList,
            { className: "roko-tabs", role: "tablist", "aria-label": "roko sections" },
            SECTIONS.map(function (s) {
              const count = badges[s.id];
              return h(
                TabsTrigger,
                {
                  key: s.id,
                  value: s.id,
                  active: section === s.id,
                  role: "tab",
                  "aria-selected": section === s.id ? "true" : "false",
                  onClick: function () { setSection(s.id); },
                },
                s.label,
                count ? h("span", { className: "roko-tabcount roko-tone-" + (s.id === "waiting" ? "warn" : "run") }, String(count)) : null
              );
            })
          ),
      h("div", { className: "roko-body", role: "tabpanel" }, body),
      h(ToastView, { toast: toastApi.toast })
    );
  }

  function RokoPageRoot() {
    return h(ErrorBoundary, null, h(RokoPage));
  }

  // ---------------------------------------------------------------------------
  // Slots
  // ---------------------------------------------------------------------------

  const useLayoutEffectSafe = React.useLayoutEffect || useEffect;

  /**
   * Whether the chip's text is cut off: either by its own box, or by the nearest
   * ancestor that clips (a collapsed sidebar is narrower than the row inside it).
   */
  function clipAncestor(el) {
    let node = el.parentElement;
    for (let depth = 0; node && depth < 8; depth += 1, node = node.parentElement) {
      const overflow = window.getComputedStyle(node).overflowX;
      if (overflow && overflow !== "visible") return node;
    }
    return null;
  }
  function chipOverflows(el) {
    if (el.scrollWidth > el.clientWidth + 1) return true;
    // The text span may shrink to nothing inside the chip (it clips with an ellipsis).
    const textSpan = el.querySelector(".roko-chip-text");
    if (textSpan && textSpan.scrollWidth > textSpan.clientWidth + 1) return true;
    const clip = clipAncestor(el);
    return !!clip && el.getBoundingClientRect().right > clip.getBoundingClientRect().right + 0.5;
  }
  /** The width that decides how much the chip can show: its clipping ancestor's, else its row's. */
  function roomWidth(el) {
    const clip = clipAncestor(el);
    return (clip || el.parentElement || el).clientWidth;
  }

  /** The chip's text at each density: full, the most urgent part, a number, nothing. */
  function chipLabels(c) {
    const parts = [];
    if (c.running) parts.push(c.running + " running");
    if (c.queued) parts.push(c.queued + " queued");
    if (c.waiting) parts.push(c.waiting + " waiting");
    const active = c.running + c.queued;
    return {
      parts: parts,
      full: parts.join(" · "),
      primary: c.waiting ? c.waiting + " waiting" : c.running ? c.running + " running" : c.queued ? c.queued + " queued" : "",
      digit: c.waiting ? String(c.waiting) : active ? String(active) : "",
    };
  }

  /**
   * `header-right`: "roko ● 1 running · 2 waiting", or just "roko ●" when idle.
   * The slot sits in the sidebar footer next to the theme and language switchers, so
   * the chip measures itself before paint and steps down (most urgent count only, then
   * a number, then the dot alone) until it fits; the tooltip always has the full text.
   */
  function HeaderChip() {
    const ov = useOverview();
    const light = useLightTheme();
    const ref = useRef(null);
    const [level, setLevel] = useState(0);
    const levelRef = useRef(0);
    levelRef.current = level;
    // The row's width when the chip last stepped down: once the row is wider than
    // that (the sidebar was expanded, the window grew), the chip starts over.
    const stepWidth = useRef(Infinity);
    const [, setMeasure] = useState(0);
    const data = ov.data;
    const c = counts(data);
    const labels = chipLabels(c);

    const lastFull = useRef(labels.full);
    useLayoutEffectSafe(function () {
      if (lastFull.current !== labels.full) {
        // New counts: start again from the full text, then shrink to fit.
        lastFull.current = labels.full;
        if (level !== 0) {
          stepWidth.current = Infinity;
          setLevel(0);
          return;
        }
      }
      const el = ref.current;
      if (el && level < 3 && chipOverflows(el)) {
        stepWidth.current = roomWidth(el);
        setLevel(level + 1);
      }
    });
    useEffect(function () {
      const el = ref.current;
      const parent = el && el.parentElement;
      if (!el || !parent || typeof ResizeObserver !== "function") return undefined;
      const observer = new ResizeObserver(function () {
        if (levelRef.current > 0 && roomWidth(el) > stepWidth.current + 2) {
          stepWidth.current = Infinity;
          setLevel(0);
        }
        setMeasure(function (n) { return n + 1; });
      });
      observer.observe(el);
      observer.observe(parent);
      const clip = clipAncestor(el);
      if (clip) observer.observe(clip);
      return function () { observer.disconnect(); };
    }, [data != null]);

    if (!data) return null;
    const conn = data.connection || {};
    const active = c.running + c.queued;
    const down = conn.reachable === false;
    const tone = down ? "bad" : c.waiting ? "warn" : active ? "run" : "muted";
    const title = down
      ? "roko serve is unreachable" + (conn.error && conn.error.message ? ": " + str(conn.error.message) : "")
      : labels.parts.length
        ? "roko: " + labels.parts.join(", ")
        : "roko: idle";
    const path = "/roko" + (c.waiting ? "?section=waiting" : "");
    // Levels: 0 "roko ● 1 running · 2 waiting", 1 "roko ● 2 waiting", 2 "roko ●"
    // (state by colour), 3 "● 2" (a collapsed sidebar has room for nothing more).
    const detail = level === 0 ? labels.full : level === 1 ? labels.primary : level === 3 ? labels.digit : "";
    return h(
      "a",
      linkProps(path, {
        ref: ref,
        className: "roko-chip roko-tone-scope" + (light ? " roko--light" : "") + (level >= 2 ? " roko-chip--compact" : ""),
        title: title,
        "aria-label": title,
        "data-roko": "chip",
        "data-roko-level": String(level),
      }),
      level < 3 ? h("span", { className: "roko-chip-name" }, "roko") : null,
      h(Dot, { tone: tone, pulse: !down && active > 0 }),
      detail ? h("span", { className: level === 3 ? "roko-chip-count roko-tone-" + tone : "roko-chip-text" }, detail) : null
    );
  }

  /** `sessions:top`: a one-line banner while runs started from Hermes are active or something waits. */
  function SessionsBanner() {
    const ov = useOverview();
    const light = useLightTheme();
    const data = ov.data;
    if (!data) return null;
    const c = counts(data);
    if (!(c.running || c.queued || c.waiting)) return null;
    const parts = [];
    if (c.running) parts.push(plural(c.running, "run", "runs") + " running");
    if (c.queued) parts.push(plural(c.queued, "run", "runs") + " queued");
    if (c.waiting) parts.push(c.waiting === 1 ? "1 item waits on you" : c.waiting + " items wait on you");
    const path = "/roko" + (c.waiting ? "?section=waiting" : "");
    return h(
      "div",
      { className: "roko-banner roko-tone-scope" + (light ? " roko--light" : ""), role: "status", "data-roko": "banner" },
      h(Dot, { tone: c.waiting ? "warn" : "run", pulse: c.running > 0 }),
      h("span", { className: "roko-banner-text" }, "roko: " + parts.join(" · ")),
      h("a", linkProps(path, { className: "roko-banner-link" }), "open →")
    );
  }

  function HeaderChipRoot() { return h(ErrorBoundary, { silent: true }, h(HeaderChip)); }
  function SessionsBannerRoot() { return h(ErrorBoundary, { silent: true }, h(SessionsBanner)); }

  // ---------------------------------------------------------------------------
  // Register: registerSlot takes (plugin, slot, component) in Hermes 0.21
  // (web/src/plugins/slots.ts).
  // ---------------------------------------------------------------------------

  if (typeof PLUGINS.register === "function") {
    PLUGINS.register(PLUGIN, RokoPageRoot);
  }
  if (typeof PLUGINS.registerSlot === "function") {
    PLUGINS.registerSlot(PLUGIN, "header-right", HeaderChipRoot);
    PLUGINS.registerSlot(PLUGIN, "sessions:top", SessionsBannerRoot);
  }
  window.__ROKO_DASHBOARD_VERSION__ = VERSION;
})();

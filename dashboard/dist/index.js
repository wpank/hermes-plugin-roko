/**
 * roko for the Hermes web dashboard (`hermes dashboard`): a control surface for checked work.
 *
 * A hand-written, unminified IIFE: no build step, no dependencies of its own. It uses only what
 * the dashboard hands plugins on `window.__HERMES_PLUGIN_SDK__` (React, hooks, UI components,
 * `fetchJSON`, `buildWsUrl`) and registers with `window.__HERMES_PLUGINS__`:
 *
 *   - the "roko" tab (/roko): Runs (each run as one instrument: a display bar of numbered dot-matrix
 *     readouts, a live ticker and scope, the tasks as a sequencer of pads, roko's five loops on a
 *     dial, activity, a replay, the diff and a guarded Merge), Waiting, Plans, Loops, Insights and
 *     Knowledge, and a composer device for new work;
 *   - slots: `header-right` (an LED and a step strip), `sessions:top` and `chat:top` (a live strip
 *     while a run goes), `analytics:top` (spend, checks and the loops), `models:top` (roko's
 *     scorecard).
 *
 * The design system is "the roko control surface" (teenage-engineering-like): four function
 * colours (agent blue, pass green, you orange, fail red), numbers that change rendered in a 5×7
 * dot-matrix on a black display well, numbered modules, keys, a knob and switches. The body and ink
 * stay the dashboard theme's.
 *
 * Data comes only from the plugin's own backend, `/api/plugins/roko/*` (dashboard/plugin_api.py;
 * the contract is docs/ui-api.md): REST answers that are HTTP 200 with `{ok: true, …}` or
 * `{ok: false, error}`, and one WebSocket, `/live`, that pushes runs, timeline lines, live agent
 * activity and roko's loop events as they happen. While the socket is healthy, polling drops to a
 * 15 s fallback; without it the page polls as 0.3.0 did (overview 10 s, an active run 3 s).
 *
 * Everything that came from roko is untrusted text. It is rendered as React text nodes only: never
 * parsed as HTML or markdown, and no links are built from it. Diff lines are tinted by a small
 * tokenizer that only splits text into spans.
 */
(function () {
  "use strict";

  const SDK = window.__HERMES_PLUGIN_SDK__;
  const PLUGINS = window.__HERMES_PLUGINS__;
  if (!SDK || !SDK.React || !PLUGINS) return;

  const React = SDK.React;
  const h = React.createElement;
  const Fragment = React.Fragment;
  const hooks = SDK.hooks || {};
  const useState = hooks.useState || React.useState;
  const useEffect = hooks.useEffect || React.useEffect;
  const useCallback = hooks.useCallback || React.useCallback;
  const useMemo = hooks.useMemo || React.useMemo;
  const useRef = hooks.useRef || React.useRef;
  const useLayoutEffectSafe = React.useLayoutEffect || useEffect;
  const C = SDK.components || {};

  const PLUGIN = "roko";
  const VERSION = "0.4.0";
  const API = "/api/plugins/roko";
  const OVERVIEW_POLL_MS = 10000;
  const RUN_POLL_MS = 3000;
  const PENDING_POLL_MS = 10000;
  // While the live socket is healthy, polling is only a fallback.
  const LIVE_FALLBACK_MS = 15000;
  const LIVE_STALE_MS = 40000;
  const EVENTS_TAIL = 400;
  const MAX_EVENTS = 600;
  const REPLAY_SECONDS = 22;

  const SECTIONS = [
    { id: "runs", label: "Runs" },
    { id: "waiting", label: "Waiting" },
    { id: "plans", label: "Plans" },
    { id: "loops", label: "Loops" },
    { id: "health", label: "Insights" },
    { id: "knowledge", label: "Knowledge" },
  ];
  const SECTION_ALIASES = { insights: "health" };
  const RUN_TABS = [
    { id: "overview", label: "Overview" },
    { id: "activity", label: "Activity" },
    { id: "loops", label: "Loops" },
    { id: "changes", label: "Changes" },
  ];
  // The cap knob's detents; a run may never pick one above its limits.
  const CAP_PRESETS = [0.25, 0.5, 1, 2, 5];
  const DOMAINS = [
    { id: "code", label: "Code", hint: "builds, tests and lint check it" },
    { id: "research", label: "Research", hint: "sources and claims are checked" },
    { id: "docs", label: "Docs", hint: "the writing is checked" },
  ];
  const EXAMPLES = [
    "Add a --json flag to the CLI's status command, with a test for it",
    "Fix the flaky test in tests/test_ledger.py and explain what was racing",
    "Write REPORT.md summarising the public API, one paragraph per function",
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
    rest.className = "roko-btn " + (props.outlined || props.ghost ? "roko-btn--quiet " : "") + (props.className || "");
    return h("button", rest, props.prefix || null, props.children, props.suffix || null);
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

  /** The dashboard's ConfirmDialog, or an inline confirm panel on older dashboards. */
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
  function list(v) { return Array.isArray(v) ? v : []; }
  function obj(v) { return v && typeof v === "object" && !Array.isArray(v) ? v : null; }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  /** Dollars; `null`/unknown is "—", never "$0.00". */
  function money(v) {
    if (!isNum(v)) return "—";
    if (v > 0 && v < 0.005) return "<$0.01";
    return "$" + v.toFixed(2);
  }
  /** Dollars with a third digit under a dollar, for the instruments ("$0.037"). */
  function moneyFine(v) {
    if (!isNum(v)) return "—";
    if (v > 0 && v < 0.0005) return "<$0.001";
    return "$" + (Math.abs(v) < 1 ? v.toFixed(3) : v.toFixed(2));
  }
  function costOfCap(cost, cap) {
    if (isNum(cap)) return money(cost) + " of " + money(cap);
    return money(cost);
  }
  function pct(ratio) { return isNum(ratio) ? Math.round(ratio * 100) + "%" : "—"; }
  function plural(n, one, many) { return n + " " + (n === 1 ? one : many); }
  function shortId(id) { const s = str(id); return s.length > 12 ? s.slice(0, 8) : s; }
  function ms(iso) {
    if (isNum(iso)) return iso;
    const t = iso ? Date.parse(str(iso)) : NaN;
    return isFinite(t) ? t : NaN;
  }
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
    if (msValue < 1000) return msValue < 10 ? "<10ms" : Math.round(msValue) + "ms";
    const s = Math.round(msValue / 1000);
    if (s < 60) return s + "s";
    const m = Math.floor(s / 60);
    if (m < 60) return m + "m " + String(s % 60).padStart(2, "0") + "s";
    return Math.floor(m / 60) + "h " + String(m % 60).padStart(2, "0") + "m";
  }
  /** "4:07" or "1:02:09": a stopwatch reading. */
  function stopwatch(msValue) {
    if (!isNum(msValue) || msValue < 0) return "—";
    const total = Math.floor(msValue / 1000);
    const hrs = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return (hrs ? hrs + ":" + String(m).padStart(2, "0") : String(m)) + ":" + String(s).padStart(2, "0");
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
  function wallClock(t) {
    if (!isFinite(t)) return "";
    try {
      return new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
    } catch (_) {
      return "";
    }
  }
  function enc(v) { return encodeURIComponent(str(v)); }
  function oneLine(v, max) {
    const s = str(v).replace(/\s+/g, " ").trim();
    return max && s.length > max ? s.slice(0, max - 1) + "…" : s;
  }

  /** The end of `v` in at most `max` characters: what an agent is saying now is at the end. */
  function oneLineEnd(v, max) {
    const s = str(v).replace(/\s+/g, " ").trim();
    return max && s.length > max ? "…" + s.slice(s.length - max + 1) : s;
  }

  const KIND_LABEL = { run: "task", plan: "plan", plan_generate: "planning" };

  /** Run-state tone. `unverified` is never green: nothing checked the result. */
  function stateTone(state) {
    switch (state) {
      case "succeeded": return "ok";
      case "failed": return "bad";
      case "unverified": return "warn";
      case "missing": return "warn";
      case "running": return "run";
      case "queued": return "idle";
      default: return "muted";
    }
  }
  function isActiveState(state) { return state === "running" || state === "queued"; }

  /** A run that is going and waits on the person: its colour is orange, "you", and its lights blink fast. */
  function runWaits(run, pending) {
    if (!run || !isActiveState(run.state)) return false;
    if (list(run.waiting).length) return true;
    const id = str(run.run_id);
    return list(pending).some(function (item) { return item && str(item.run_id) === id; });
  }
  function isRunActive(run) { return !!run && (run.active === true || isActiveState(run.state)); }

  /** A task's state for the graph: one of the node classes. */
  function nodeState(outcome) {
    switch (outcome) {
      case "passed":
      case "succeeded":
      case "already_satisfied":
        return "passed";
      case "accepted_with_failures":
        return "warn";
      case "failed":
      case "error":
      case "crashed":
      case "timeout":
      case "timed_out":
      case "rejected":
        return "failed";
      case "running":
        return "running";
      case "blocked":
        return "blocked";
      case "unverified":
        return "warn";
      case "cancelled":
      case "interrupted":
      case "skipped":
        return "stopped";
      default:
        return "pending";
    }
  }
  const NODE_WORD = {
    passed: "passed",
    warn: "unverified",
    interrupted: "interrupted",
    failed: "did not pass",
    running: "running",
    blocked: "blocked",
    stopped: "stopped",
    pending: "waiting",
    planned: "planned",
  };

  /** 80 % of a cap is a warning, 95 % is the danger zone. */
  function capTone(value, cap) {
    if (!isNum(value) || !isNum(cap) || cap <= 0) return "fill";
    const r = value / cap;
    return r >= 0.95 ? "bad" : r >= 0.8 ? "warn" : "fill";
  }

  function prefersReducedMotion() {
    try {
      return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    } catch (_) {
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // The four function colours and roko's five loops
  // ---------------------------------------------------------------------------

  /** A task's or run's state as a channel: agent (working), pass, you (needs the person), fail, off. */
  function channelOf(state) {
    switch (state) {
      case "running":
      case "queued":
        return "agent";
      case "passed":
      case "succeeded":
        return "pass";
      case "failed":
      case "blocked":
        return "fail";
      case "warn":
      case "unverified":
      case "missing":
      case "held":
        return "you";
      default:
        return "off";
    }
  }

  const RINGS = [
    { id: "L0", name: "tool calls", clock: "seconds" },
    { id: "L1", name: "attempts", clock: "minutes" },
    { id: "L2", name: "the plan", clock: "hours" },
    { id: "L3", name: "learning", clock: "days" },
    { id: "L4", name: "audit", clock: "weeks" },
  ];
  const LOOP_CHANNEL = {
    tool_held: "you",
    tool_decided: "pass",
    withheld: "fail",
    route: "agent",
    failover: "fail",
    retry: "you",
    regression: "fail",
    wave: "agent",
    diagnosis: "you",
    budget: "you",
    hold: "you",
    thresholds: "pass",
    knowledge: "pass",
    loop_health: "agent",
    guarded_commit: "you",
  };
  const LOOP_WORD = {
    tool_held: "held call",
    tool_decided: "call decided",
    withheld: "withheld",
    route: "route",
    failover: "failover",
    retry: "retry",
    regression: "regression",
    wave: "wave",
    diagnosis: "diagnosis",
    budget: "budget",
    hold: "sign-off",
    thresholds: "thresholds",
    knowledge: "lesson",
    loop_health: "loop health",
    guarded_commit: "guard",
  };
  // The dial's centre has room for one short word.
  const HUB_WORD = {
    tool_held: "held",
    tool_decided: "decided",
    withheld: "withheld",
    route: "route",
    failover: "failover",
    retry: "retry",
    regression: "regress",
    wave: "wave",
    diagnosis: "diagnose",
    budget: "budget",
    hold: "sign-off",
    thresholds: "thresh",
    knowledge: "lesson",
    loop_health: "health",
    guarded_commit: "guard",
  };
  /** A loop event's channel: by kind, with a diagnosis's severity and a resolved hold taken into account. */
  function loopChannel(ev) {
    const data = obj(ev && ev.data) || {};
    if (ev && ev.kind === "diagnosis") return data.severity === "alert" ? "fail" : data.severity === "info" ? "agent" : "you";
    if (ev && ev.kind === "hold" && data.state === "resolved") return data.outcome === "approved" ? "pass" : "fail";
    if (ev && ev.kind === "tool_decided") return data.outcome === "applied" ? "pass" : "fail";
    return LOOP_CHANNEL[ev && ev.kind] || "agent";
  }
  function ringIndex(ring) {
    const i = RINGS.map(function (r) { return r.id; }).indexOf(str(ring));
    return i < 0 ? 2 : i;
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
  // The overview: one poller shared by the page and every slot (10 s; 15 s while the socket is live)
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
      if (listeners.size > 0) timer = setTimeout(tick, liveStore.healthy() ? LIVE_FALLBACK_MS : OVERVIEW_POLL_MS);
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
      /** An overview the live socket pushed: the same answer as `GET /overview`. */
      set: function (data) {
        if (!obj(data) || data.ok !== true) return;
        state = { status: "ok", data: data, error: null, at: Date.now() };
        emit();
        schedule();
      },
      /** A fresh run card updates its row at once, rather than at the next 10 s poll. */
      patchRun: function (run) {
        if (!run || !run.run_id || !state.data || !Array.isArray(state.data.runs)) return;
        let changed = false;
        const runs = state.data.runs.map(function (row) {
          if (!row || row.run_id !== run.run_id) return row;
          const next = Object.assign({}, row, {
            state: typeof run.state === "string" && run.state ? run.state : row.state,
            active: typeof run.active === "boolean" ? run.active : row.active,
            cost_usd: typeof run.cost_usd === "number" && isFinite(run.cost_usd) ? run.cost_usd : row.cost_usd,
            finished_at: run.finished_at || row.finished_at,
            progress: run.progress && typeof run.progress === "object" ? run.progress : row.progress,
          });
          changed = changed || ["state", "active", "cost_usd", "finished_at"].some(function (k) { return next[k] !== row[k]; })
            || JSON.stringify(next.progress) !== JSON.stringify(row.progress);
          return next;
        });
        if (!changed) return;
        state = Object.assign({}, state, { data: Object.assign({}, state.data, { runs: runs }) });
        emit();
      },
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
    const permissions = obj(data.permissions) || {};
    const limits = obj(data.limits) || {};
    const spend = obj(data.spend) || {};
    return {
      canAct: permissions.write !== false,
      maxRun: isNum(limits.max_run_usd) ? limits.max_run_usd : null,
      maxDay: isNum(limits.max_day_usd) ? limits.max_day_usd : null,
      left: isNum(spend.left_usd) ? spend.left_usd : null,
      today: isNum(spend.today_usd) ? spend.today_usd : null,
    };
  }
  /** The most a new run may cap itself at: the per-run cap and what is left today, whichever is lower. */
  function ceilingOf(limits) {
    if (limits.maxRun !== null && limits.left !== null) return Math.min(limits.maxRun, limits.left);
    return limits.maxRun !== null ? limits.maxRun : limits.left;
  }

  function counts(data) {
    const c = (data && data.counts) || {};
    const runs = data ? list(data.runs) : [];
    const pendingItems = data ? list(data.pending) : [];
    return {
      running: isNum(c.running) ? c.running : runs.filter(function (r) { return r.state === "running"; }).length,
      queued: isNum(c.queued) ? c.queued : runs.filter(function (r) { return r.state === "queued"; }).length,
      waiting: isNum(c.waiting) ? c.waiting : pendingItems.length,
    };
  }

  // ---------------------------------------------------------------------------
  // One shared clock: every ticking label reads it, so they turn over together
  // ---------------------------------------------------------------------------

  const ticker = (function () {
    let now = Date.now();
    const listeners = new Set();
    let timer = null;
    function tick() {
      now = Date.now();
      listeners.forEach(function (fn) {
        try { fn(now); } catch (_) { /* keep ticking */ }
      });
    }
    return {
      now: function () { return listeners.size ? now : Date.now(); },
      subscribe: function (fn) {
        listeners.add(fn);
        if (!timer) {
          now = Date.now();
          timer = setInterval(tick, 1000);
        }
        return function () {
          listeners.delete(fn);
          if (!listeners.size && timer) {
            clearInterval(timer);
            timer = null;
          }
        };
      },
    };
  })();

  /** The current time, from the shared one-second clock while `enabled`. */
  function useTick(enabled) {
    const [now, setNow] = useState(Date.now());
    useEffect(function () {
      if (!enabled) return undefined;
      setNow(Date.now());
      return ticker.subscribe(setNow);
    }, [enabled]);
    return now;
  }

  /** The current time, re-read every `stepMs` while `enabled` (ages, countdowns). */
  function useNow(stepMs, enabled) {
    const [now, setNow] = useState(Date.now());
    useEffect(function () {
      if (!enabled) return undefined;
      const id = setInterval(function () { setNow(Date.now()); }, stepMs);
      return function () { clearInterval(id); };
    }, [stepMs, enabled]);
    return now;
  }

  /** A stopwatch label that ticks by itself, so its parent does not re-render every second. */
  function Ticker(props) {
    const since = ms(props.since);
    const running = isFinite(since) && !props.stopped && !isFinite(ms(props.until));
    const now = useTick(running);
    const end = isFinite(ms(props.until)) ? ms(props.until) : now;
    if (!isFinite(since)) return h("span", { className: props.className }, props.fallback || "—");
    return h("span", { className: props.className }, (props.prefix || "") + stopwatch(Math.max(0, end - since)));
  }

  // ---------------------------------------------------------------------------
  // The live channel: one socket for the page and every slot (docs/ui-api.md, "WS /live")
  // ---------------------------------------------------------------------------

  const LIVE_KEEP = 40;
  const LOOPS_KEEP = 160;
  const PULSE_KEEP_MS = 24000;
  const FOLLOW_MAX = 8;

  /**
   * The socket roko's plugin backend pushes frames on. It opens while anything on screen uses it,
   * reconnects with backoff (1 s → 15 s, a fresh URL each time: gated tickets are single-use), and
   * closes 30 s after the last user leaves. Without `SDK.buildWsUrl` (an older dashboard) it stays
   * "unsupported" and every view polls as before.
   */
  const liveStore = (function () {
    let status = "idle";
    let socket = null;
    let generation = 0;
    let lastFrame = 0;
    let hub = null;
    let backoff = 1000;
    let retryTimer = null;
    let closeTimer = null;
    let followTimer = null;
    let follows = [];
    let followed = "";
    let pulses = [];
    const users = new Set();
    const listeners = new Set();
    const cards = new Map();
    const lives = new Map();
    const loopsByRun = new Map();
    const outcomes = new Map();

    function supported() {
      return typeof SDK.buildWsUrl === "function" && typeof window.WebSocket === "function";
    }
    function emit(kind, runId, payload) {
      listeners.forEach(function (fn) {
        try { fn(kind, runId, payload); } catch (_) { /* a broken listener must not stop the others */ }
      });
    }
    function setStatus(next) {
      if (status === next) return;
      status = next;
      emit("status", null, null);
    }
    function pulse(ch, runId, amp) {
      const now = Date.now();
      pulses.push({ at: now, ch: ch, run: runId || "", amp: isNum(amp) ? amp : 1 });
      if (pulses.length > 240 || (pulses.length && now - pulses[0].at > PULSE_KEEP_MS)) {
        pulses = pulses.filter(function (p) { return now - p.at <= PULSE_KEEP_MS; }).slice(-240);
      }
      emit("pulse", runId || null, ch);
    }

    function onRun(card) {
      const runId = str(card.run_id);
      if (!runId) return;
      const before = cards.get(runId);
      cards.set(runId, card);
      // A task that just finished, or the run itself: one short sound (when the person turned sound on).
      const seen = outcomes.get(runId) || {};
      const next = {};
      list(card.tasks).forEach(function (t) {
        const id = str(t.task_id);
        const now = nodeState(t.outcome);
        next[id] = now;
        if (!before || !seen[id] || seen[id] === now) return;
        if (now === "passed") sound.play("pass");
        else if (now === "failed" || now === "blocked") sound.play("fail");
      });
      outcomes.set(runId, next);
      if (before && before.state !== card.state && !isActiveState(card.state)) {
        if (card.state === "succeeded" || card.state === "passed") {
          sound.play("run");
          pulse("pass", runId, 1.2);
        } else if (card.state === "failed") {
          sound.play("fail");
          pulse("fail", runId, 1.2);
        }
      }
      overviewStore.patchRun(card);
      emit("run", runId, card);
    }

    function onLines(runId, lines) {
      const fresh = list(lines).filter(obj);
      if (!fresh.length) return;
      fresh.forEach(function (ev) {
        if (ev.type === "gate_result") {
          pulse(ev.passed === true ? "pass" : "fail", runId, 0.8);
          if (ev.passed === true) sound.play("check");
        } else if (ev.type === "task_completed") {
          pulse(nodeState(ev.outcome) === "passed" ? "pass" : "fail", runId, 1);
        } else if (ev.type === "agent_spawned") {
          pulse("agent", runId, 0.7);
        }
      });
      emit("lines", runId, fresh);
    }

    function onLive(frame) {
      const runId = str(frame.run_id);
      if (!runId) return;
      const entry = lives.get(runId) || { byTask: {}, recent: [] };
      const at = isNum(frame.ts) ? frame.ts : Date.now();
      const task = str(frame.task_id);
      const prev = entry.byTask[task];
      // Words stream a token at a time. The relay sends the tail of what the task's agent has said since
      // its last tool call (`said`); without it, keep that tail here.
      const words = frame.kind === "text" || frame.kind === "reasoning";
      const stretch = words ? frame.attempt + ":" + frame.kind : frame.kind === "tool" || !prev ? "" : str(prev.stretch);
      const own = words && prev && prev.stretch === stretch ? str(prev.said) : "";
      const said = words ? (typeof frame.said === "string" ? frame.said : own + str(frame.text)).slice(-400) : frame.kind === "tool" || !prev ? "" : str(prev.said);
      const item = Object.assign({}, frame, { ts: at, seen_at: Date.now(), said: said, stretch: stretch });
      if (frame.kind !== "beat" || !prev) entry.byTask[task] = item;
      else entry.byTask[task] = Object.assign({}, prev, { beat_at: Date.now() });
      if (frame.kind !== "beat") {
        // One entry per stretch of words, updated in place: a frame that continues the task's newest
        // entry replaces it.
        let last = entry.recent.length - 1;
        while (last >= 0 && str(entry.recent[last].task_id) !== task) last -= 1;
        const continues = words && last >= 0 && entry.recent[last].kind === frame.kind && entry.recent[last].stretch === stretch;
        entry.recent = continues
          ? entry.recent.map(function (old, i) { return i === last ? item : old; })
          : entry.recent.concat([item]).slice(-LIVE_KEEP);
      }
      lives.set(runId, entry);
      pulse("agent", runId, frame.kind === "beat" ? 0.25 : frame.kind === "tool" ? 0.6 : 0.4);
      emit("live", runId, item);
    }

    function onLoop(frame) {
      const runId = str(frame.run_id);
      const key = str(frame.key) || [frame.kind, frame.task_id, frame.ts].join(":");
      const map = loopsByRun.get(runId) || new Map();
      if (map.has(key)) return;
      map.set(key, Object.assign({}, frame, { key: key, seen_at: Date.now() }));
      if (map.size > LOOPS_KEEP) map.delete(map.keys().next().value);
      loopsByRun.set(runId, map);
      pulse(loopChannel(frame), runId, 1);
      const data = obj(frame.data) || {};
      if ((frame.kind === "hold" && data.state !== "resolved") || frame.kind === "tool_held") sound.play("you");
      emit("loop", runId || null, frame);
    }

    function onFrame(raw) {
      let frame;
      try { frame = JSON.parse(raw); } catch (_) { return; }
      if (!obj(frame)) return;
      lastFrame = Date.now();
      if (frame.hub) hub = str(frame.hub);
      switch (frame.type) {
        case "hello":
          backoff = 1000;
          setStatus("open");
          if (obj(frame.overview)) overviewStore.set(frame.overview);
          emit("hello", null, frame);
          break;
        case "overview":
          if (obj(frame.overview)) overviewStore.set(frame.overview);
          break;
        case "run":
          if (obj(frame.run)) onRun(frame.run);
          break;
        case "lines":
          onLines(str(frame.run_id), frame.lines);
          break;
        case "live":
          onLive(frame);
          break;
        case "loop":
          onLoop(frame);
          break;
        case "ping":
          emit("status", null, null);
          break;
        default:
          break;
      }
    }

    function retry(gen) {
      if (gen !== generation) return;
      socket = null;
      if (!users.size) {
        setStatus("idle");
        return;
      }
      setStatus("down");
      const wait = Math.min(15000, backoff) * (0.8 + Math.random() * 0.4);
      backoff = Math.min(15000, backoff * 2);
      clearTimeout(retryTimer);
      retryTimer = setTimeout(connect, wait);
    }

    function connect() {
      clearTimeout(retryTimer);
      retryTimer = null;
      if (!supported()) {
        setStatus("unsupported");
        return;
      }
      if (socket || !users.size) return;
      const gen = ++generation;
      setStatus(status === "open" ? "connecting" : status === "down" ? "down" : "connecting");
      followed = follows.join(",");
      let built;
      try {
        built = SDK.buildWsUrl(API + "/live", followed ? { runs: followed } : undefined);
      } catch (_) {
        retry(gen);
        return;
      }
      Promise.resolve(built).then(
        function (url) {
          if (gen !== generation || !users.size) return;
          let ws;
          try {
            ws = new window.WebSocket(str(url));
          } catch (_) {
            retry(gen);
            return;
          }
          socket = ws;
          ws.onmessage = function (event) { if (gen === generation) onFrame(event.data); };
          ws.onclose = function () { if (gen === generation) retry(gen); };
          ws.onerror = function () { /* onclose follows */ };
        },
        function () { retry(gen); }
      );
    }

    function disconnect() {
      generation += 1;
      clearTimeout(retryTimer);
      retryTimer = null;
      const ws = socket;
      socket = null;
      if (ws) {
        try { ws.close(1000); } catch (_) { /* already closed */ }
      }
    }

    function reconnect() {
      disconnect();
      connect();
    }

    if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
      document.addEventListener("visibilitychange", function () {
        // Back on the tab after the socket dropped: try now rather than at the end of the backoff.
        if (document.visibilityState === "visible" && users.size && !socket && supported()) {
          backoff = 1000;
          connect();
        }
      });
    }

    return {
      status: function () { return supported() ? status : "unsupported"; },
      hub: function () { return hub; },
      /** Open, and heard from in the last 40 s (roko's backend pings every 15 s). */
      healthy: function () { return status === "open" && Date.now() - lastFrame < LIVE_STALE_MS; },
      /** Keep the socket open while the caller is on screen; returns the release. */
      use: function () {
        const token = {};
        users.add(token);
        clearTimeout(closeTimer);
        closeTimer = null;
        if (!socket && !retryTimer) connect();
        return function () {
          users.delete(token);
          if (users.size) return;
          clearTimeout(closeTimer);
          closeTimer = null;
          if (!socket && !retryTimer) {
            // Nothing open (an older dashboard, or the URL is still being built): nothing to close later.
            generation += 1;
            setStatus(supported() ? "idle" : "unsupported");
            return;
          }
          closeTimer = setTimeout(function () {
            if (users.size) return;
            disconnect();
            setStatus(supported() ? "idle" : "unsupported");
          }, 30000);
        };
      },
      subscribe: function (fn) {
        listeners.add(fn);
        return function () { listeners.delete(fn); };
      },
      /** Follow a run the backend may not know it should (opened by its id); reconnects once. */
      follow: function (runId) {
        const id = str(runId);
        if (!id || follows.indexOf(id) >= 0) return;
        follows = [id].concat(follows).slice(0, FOLLOW_MAX);
        clearTimeout(followTimer);
        followTimer = setTimeout(function () {
          if (follows.join(",") !== followed && socket) reconnect();
        }, 400);
      },
      card: function (runId) { return cards.get(str(runId)) || null; },
      live: function (runId) { return lives.get(str(runId)) || null; },
      /** Loop events the socket brought, oldest first: one run's, or every run's. */
      loops: function (runId) {
        const out = [];
        loopsByRun.forEach(function (map, id) {
          if (runId !== undefined && id !== str(runId)) return;
          map.forEach(function (ev) { out.push(ev); });
        });
        return out.sort(function (a, b) { return (a.ts || 0) - (b.ts || 0); });
      },
      pulses: function () { return pulses; },
      /** For tests and a replay: feed one frame as if the socket had sent it. */
      inject: function (frame) { onFrame(typeof frame === "string" ? frame : JSON.stringify(frame)); },
    };
  })();

  /** The live channel's state: unsupported · idle · connecting · open · down; keeps the socket open. */
  function useLiveStatus() {
    const [, setVersion] = useState(0);
    useEffect(function () {
      const release = liveStore.use();
      const unsub = liveStore.subscribe(function (kind) {
        if (kind === "status" || kind === "hello") setVersion(function (v) { return v + 1; });
      });
      return function () {
        unsub();
        release();
      };
    }, []);
    return { status: liveStore.status(), healthy: liveStore.healthy(), hub: liveStore.hub() };
  }

  /**
   * A number that changes when the socket brings one of `kinds` (for `runId`, or for any run when it
   * is undefined), at most ~12 times a second, so a busy run does not re-render a view per frame.
   */
  function useLiveVersion(runId, kinds) {
    const [version, setVersion] = useState(0);
    const key = list(kinds).join(",");
    useEffect(function () {
      const release = liveStore.use();
      let timer = null;
      const unsub = liveStore.subscribe(function (kind, rid) {
        if (key && key.split(",").indexOf(kind) < 0) return;
        if (runId !== undefined && kind !== "status" && rid !== runId) return;
        if (timer) return;
        timer = setTimeout(function () {
          timer = null;
          setVersion(function (v) { return v + 1; });
        }, 60);
      });
      return function () {
        unsub();
        release();
        clearTimeout(timer);
      };
    }, [runId, key]);
    return version;
  }

  // ---------------------------------------------------------------------------
  // Sound: short blips, off until the person turns them on (remembered in this browser)
  // ---------------------------------------------------------------------------

  const SOUND_KEY = "roko.sound";
  // [frequency Hz, seconds, wave, gain]
  const SOUNDS = {
    check: [[2000, 0.03, "square", 0.018]],
    pass: [[1046.5, 0.06, "square", 0.028]],
    fail: [[110, 0.12, "sawtooth", 0.05]],
    run: [[1046.5, 0.07, "square", 0.026], [1318.5, 0.07, "square", 0.026], [1568, 0.07, "square", 0.026], [2093, 0.1, "square", 0.026]],
    you: [[880, 0.06, "sine", 0.06], [880, 0.06, "sine", 0.06]],
    key: [[1500, 0.016, "square", 0.012]],
  };

  const sound = (function () {
    let on = false;
    try { on = window.localStorage.getItem(SOUND_KEY) === "on"; } catch (_) { on = false; }
    let ctx = null;
    let lastAt = 0;
    const listeners = new Set();
    function audio() {
      if (ctx) return ctx;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (typeof AC !== "function") return null;
      try { ctx = new AC(); } catch (_) { ctx = null; }
      return ctx;
    }
    function tone(ac, at, note) {
      const osc = ac.createOscillator();
      const amp = ac.createGain();
      osc.type = note[2];
      osc.frequency.setValueAtTime(note[0], at);
      amp.gain.setValueAtTime(0.0001, at);
      amp.gain.exponentialRampToValueAtTime(note[3], at + 0.004);
      amp.gain.exponentialRampToValueAtTime(0.0001, at + note[1]);
      osc.connect(amp);
      amp.connect(ac.destination);
      osc.start(at);
      osc.stop(at + note[1] + 0.03);
    }
    /** Play one sound. Never while the tab is hidden; with reduced motion only for the person's own actions. */
    function play(name, opts) {
      const user = !!(opts && opts.user);
      if (!on || !SOUNDS[name]) return false;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return false;
      if (!user && prefersReducedMotion()) return false;
      const now = Date.now();
      if (!user && now - lastAt < 140) return false;
      lastAt = now;
      const ac = audio();
      if (!ac) return false;
      try {
        if (ac.state === "suspended" && typeof ac.resume === "function") ac.resume();
        let at = ac.currentTime + 0.01;
        SOUNDS[name].forEach(function (note) {
          tone(ac, at, note);
          at += name === "you" ? 0.15 : note[1];
        });
      } catch (_) {
        return false;
      }
      return true;
    }
    return {
      on: function () { return on; },
      set: function (value) {
        on = !!value;
        try { window.localStorage.setItem(SOUND_KEY, on ? "on" : "off"); } catch (_) { /* private mode */ }
        if (on) play("pass", { user: true });
        listeners.forEach(function (fn) {
          try { fn(on); } catch (_) { /* keep going */ }
        });
      },
      play: play,
      subscribe: function (fn) {
        listeners.add(fn);
        return function () { listeners.delete(fn); };
      },
    };
  })();

  function useSound() {
    const [on, setOn] = useState(sound.on());
    useEffect(function () { return sound.subscribe(setOn); }, []);
    return on;
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

  /** The width of an element, kept up to date (for the graph's layout). */
  function useWidth(ref, fallback) {
    const [width, setWidth] = useState(fallback);
    useLayoutEffectSafe(function () {
      const el = ref.current;
      if (!el) return undefined;
      function measure() {
        const w = el.clientWidth;
        if (w > 0) setWidth(function (prev) { return Math.abs(prev - w) > 1 ? w : prev; });
      }
      measure();
      if (typeof ResizeObserver !== "function") return undefined;
      const observer = new ResizeObserver(measure);
      observer.observe(el);
      return function () { observer.disconnect(); };
    }, []);
    return width;
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
    const key = SECTION_ALIASES[id] || id;
    return SECTIONS.some(function (s) { return s.id === key; }) ? key : null;
  }
  function validRunTab(id) {
    return RUN_TABS.some(function (t) { return t.id === id; }) ? id : null;
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

  /** Whether a key press belongs to a text field (shortcuts stay out of the way). */
  function typingIn(target) {
    if (!target || !target.tagName) return false;
    const tag = String(target.tagName).toLowerCase();
    return tag === "input" || tag === "textarea" || tag === "select" || !!target.isContentEditable;
  }

  // ---------------------------------------------------------------------------
  // Icons: a few 16-unit line drawings, coloured by currentColor
  // ---------------------------------------------------------------------------

  const ICONS = {
    run: [["circle", { cx: 8, cy: 8, r: 6 }], ["path", { d: "M6.6 5.4 L10.6 8 L6.6 10.6 Z", fill: "currentColor", stroke: "none" }]],
    task: [["rect", { x: 2.5, y: 2.5, width: 11, height: 11, rx: 1.5 }], ["path", { d: "M5.2 8.2 L7.1 10.1 L10.9 6.1" }]],
    agent: [["path", { d: "M8 1.8 L9.3 6.7 L14.2 8 L9.3 9.3 L8 14.2 L6.7 9.3 L1.8 8 L6.7 6.7 Z" }]],
    gate: [
      ["path", { d: "M8 1.8 L13 3.7 V7.7 C13 10.7 10.9 13 8 14.2 C5.1 13 3 10.7 3 7.7 V3.7 Z" }],
      ["path", { d: "M5.8 8 L7.4 9.6 L10.3 6.5" }],
    ],
    error: [
      ["path", { d: "M8 2.2 L14.3 13.4 H1.7 Z" }],
      ["path", { d: "M8 6.4 V9.4" }],
      ["circle", { cx: 8, cy: 11.5, r: 0.55, fill: "currentColor", stroke: "none" }],
    ],
    play: [["path", { d: "M5.2 3.4 L12.6 8 L5.2 12.6 Z", fill: "currentColor" }]],
    pause: [["rect", { x: 4.2, y: 3.5, width: 2.4, height: 9, rx: 0.5, fill: "currentColor", stroke: "none" }], ["rect", { x: 9.4, y: 3.5, width: 2.4, height: 9, rx: 0.5, fill: "currentColor", stroke: "none" }]],
    merge: [
      ["circle", { cx: 4.5, cy: 3.5, r: 1.6 }],
      ["circle", { cx: 4.5, cy: 12.5, r: 1.6 }],
      ["circle", { cx: 11.5, cy: 9, r: 1.6 }],
      ["path", { d: "M4.5 5.1 V10.9 M4.5 5.2 C4.6 8 6.9 9 9.9 9" }],
    ],
    diff: [["path", { d: "M4 1.6 H9.6 L12.4 4.4 V14.4 H4 Z" }], ["path", { d: "M6.2 6.6 H10.2 M8.2 4.6 V8.6 M6.2 11.6 H10.2" }]],
    copy: [["rect", { x: 5.4, y: 5.4, width: 8.2, height: 8.2, rx: 1.2 }], ["path", { d: "M3 10.4 V3.6 C3 3 3.4 2.6 4 2.6 H10.4" }]],
    plus: [["path", { d: "M8 3 V13 M3 8 H13" }]],
    refresh: [["path", { d: "M13 8.2 A5 5 0 1 1 11.4 4.4" }], ["path", { d: "M11.9 1.9 V4.8 H9" }]],
    chevronRight: [["path", { d: "M6 3.5 L10.5 8 L6 12.5" }]],
    chevronDown: [["path", { d: "M3.5 6 L8 10.5 L12.5 6" }]],
    clock: [["circle", { cx: 8, cy: 8, r: 6 }], ["path", { d: "M8 4.6 V8 L10.4 9.5" }]],
    coins: [
      ["ellipse", { cx: 8, cy: 4.8, rx: 5, ry: 2 }],
      ["path", { d: "M3 4.8 V11 C3 12.1 5.2 13 8 13 C10.8 13 13 12.1 13 11 V4.8" }],
      ["path", { d: "M3 7.9 C3 9 5.2 9.9 8 9.9 C10.8 9.9 13 9 13 7.9" }],
    ],
    x: [["path", { d: "M4 4 L12 12 M12 4 L4 12" }]],
    check: [["path", { d: "M3 8.6 L6.4 12 L13 4.6" }]],
    stop: [["rect", { x: 4, y: 4, width: 8, height: 8, rx: 1.2 }]],
    inbox: [["path", { d: "M2 9 L4 3.2 H12 L14 9 V13 H2 Z" }], ["path", { d: "M2 9 H5.4 L6.4 10.6 H9.6 L10.6 9 H14" }]],
    graph: [
      ["circle", { cx: 3.4, cy: 8, r: 1.8 }],
      ["circle", { cx: 12.6, cy: 3.8, r: 1.8 }],
      ["circle", { cx: 12.6, cy: 12.2, r: 1.8 }],
      ["path", { d: "M5.1 7.2 L10.9 4.6 M5.1 8.8 L10.9 11.4" }],
    ],
    search: [["circle", { cx: 7, cy: 7, r: 4.4 }], ["path", { d: "M10.4 10.4 L13.8 13.8" }]],
    keyboard: [["rect", { x: 1.6, y: 4, width: 12.8, height: 8, rx: 1.2 }], ["path", { d: "M4.2 6.8 H4.3 M6.6 6.8 H6.7 M9 6.8 H9.1 M11.4 6.8 H11.5 M5 9.4 H11" }]],
    replay: [["path", { d: "M2.9 8 A5.1 5.1 0 1 0 4.5 4.3" }], ["path", { d: "M4.4 1.8 V4.6 H7.2" }], ["path", { d: "M7 6.2 L10 8 L7 9.8 Z", fill: "currentColor", stroke: "none" }]],
    bolt: [["path", { d: "M9.2 1.5 L3.6 9 H8 L6.8 14.5 L12.4 7 H8 Z" }]],
    doc: [["path", { d: "M4 1.6 H9.6 L12.4 4.4 V14.4 H4 Z" }], ["path", { d: "M6.2 7.6 H10.4 M6.2 10 H10.4 M6.2 12.4 H9" }]],
    branch: [
      ["circle", { cx: 4.5, cy: 3.5, r: 1.6 }],
      ["circle", { cx: 4.5, cy: 12.5, r: 1.6 }],
      ["circle", { cx: 11.5, cy: 5, r: 1.6 }],
      ["path", { d: "M4.5 5.1 V10.9 M11.5 6.6 C11.5 9.4 8.2 9.8 4.9 10.9" }],
    ],
    undo: [["path", { d: "M4.2 6 H10 A3.5 3.5 0 0 1 10 13 H6" }], ["path", { d: "M6.6 3.5 L4.1 6 L6.6 8.5" }]],
    info: [["circle", { cx: 8, cy: 8, r: 6 }], ["path", { d: "M8 7.3 V11" }], ["circle", { cx: 8, cy: 5, r: 0.6, fill: "currentColor", stroke: "none" }]],
    filter: [["path", { d: "M2.5 3.5 H13.5 L9.4 8.6 V12.6 L6.6 13.6 V8.6 Z" }]],
    chart: [["path", { d: "M2.5 13.5 H13.5" }], ["path", { d: "M4.6 11 V7.6 M7.6 11 V4.4 M10.6 11 V8.8" }]],
    book: [["path", { d: "M3 2.6 H7 C7.6 2.6 8 3 8 3.6 V13.6 C8 13 7.6 12.6 7 12.6 H3 Z" }], ["path", { d: "M13 2.6 H9 C8.4 2.6 8 3 8 3.6 V13.6 C8 13 8.4 12.6 9 12.6 H13 Z" }]],
    pulse: [["path", { d: "M1.6 8.4 H4.4 L6 4.4 L8.6 12 L10.4 7.4 L11.4 8.4 H14.4" }]],
    hand: [["path", { d: "M5.4 8.2 V3.6 A0.95 0.95 0 0 1 7.3 3.6 V7.5 M7.3 7.4 V2.8 A0.95 0.95 0 0 1 9.2 2.8 V7.4 M9.2 7.4 V3.6 A0.95 0.95 0 0 1 11.1 3.6 V9.3 C11.1 12 9.6 14 7.4 14 C5.8 14 4.9 13.2 4 11.8 L2.6 9.6 A0.95 0.95 0 0 1 4.1 8.5 L5.4 9.9" }]],
  };

  function Icon(props) {
    const shapes = ICONS[props.name];
    if (!shapes) return null;
    const size = props.size || 14;
    return h(
      "svg",
      {
        viewBox: "0 0 16 16",
        width: size,
        height: size,
        fill: "none",
        stroke: "currentColor",
        strokeWidth: props.weight || 1.45,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        "aria-hidden": "true",
        focusable: "false",
        className: "roko-icon" + (props.className ? " " + props.className : ""),
      },
      shapes.map(function (shape, i) { return h(shape[0], Object.assign({ key: i }, shape[1])); })
    );
  }

  const GROUP_ICON = { run: "run", task: "task", agent: "agent", gate: "gate", error: "error", tool: "bolt", loop: "refresh" };

  // ---------------------------------------------------------------------------
  // Atoms
  // ---------------------------------------------------------------------------

  function Pill(props) {
    return h(
      "span",
      {
        className: "roko-pill roko-tone-" + (props.tone || "muted") + (props.live ? " roko-pill--live" : ""),
        title: props.title || undefined,
      },
      props.live ? h("span", { className: "roko-pill-beat", "aria-hidden": "true" }) : null,
      props.children
    );
  }

  function Dot(props) {
    return h("span", {
      className: "roko-dot roko-tone-" + (props.tone || "muted") + (props.pulse ? " roko-dot--pulse" : ""),
      "aria-hidden": "true",
    });
  }

  function Kbd(props) {
    return h("kbd", { className: "roko-kbd" }, props.children);
  }

  function Label(props) {
    return h("div", { className: "roko-label" + (props.className ? " " + props.className : "") }, props.children);
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

  /**
   * Spend against a cap: the fill is what was spent, the ghost what the run is on course to spend
   * (spent ÷ the share of tasks done), and a tick marks 80 % of the cap.
   */
  function CostMeter(props) {
    const cap = props.cap;
    const spent = isNum(props.spent) ? Math.max(0, props.spent) : null;
    if (!isNum(cap) || cap <= 0) return null;
    const used = spent === null ? 0 : Math.min(1, spent / cap);
    const projected = isNum(props.projected) && spent !== null && props.projected > spent ? props.projected : null;
    const ghost = projected === null ? 0 : Math.min(1, projected / cap) - used;
    const tone = capTone(spent, cap);
    const over = projected !== null && projected > cap;
    return h(
      "div",
      {
        className: "roko-costmeter roko-tone-" + tone + (over ? " is-over" : ""),
        role: "meter",
        "aria-valuemin": 0,
        "aria-valuemax": cap,
        "aria-valuenow": spent === null ? undefined : spent,
        "aria-label": "spent " + money(spent) + " of the " + money(cap) + " cap" + (projected !== null ? ", on course for " + money(projected) : ""),
      },
      h("span", { className: "roko-costmeter-fill", style: { width: (used * 100).toFixed(2) + "%" } }),
      ghost > 0.001
        ? h("span", { className: "roko-costmeter-ghost", style: { left: (used * 100).toFixed(2) + "%", width: (ghost * 100).toFixed(2) + "%" } })
        : null,
      h("span", { className: "roko-costmeter-tick", style: { left: "80%" }, "aria-hidden": "true" })
    );
  }

  const PROGRESS_ORDER = [
    ["passed", "ok"],
    ["unverified", "warn"],
    ["failed", "bad"],
    ["blocked", "blocked"],
    ["stopped", "muted"],
    ["running", "run"],
  ];

  /** A segmented ring: one arc per kind of task, the rest is the track. */
  function Ring(props) {
    const p = obj(props.progress) || {};
    const total = isNum(p.total) ? p.total : 0;
    const size = props.size || 58;
    const stroke = props.stroke || Math.max(2, Math.round(size / 11));
    const r = (size - stroke) / 2;
    const c = 2 * Math.PI * r;
    const center = size / 2;
    const gap = total > 1 && size > 20 ? Math.min(2.2, c / total / 3) : 0;
    let offset = 0;
    const arcs = [];
    if (total > 0) {
      PROGRESS_ORDER.forEach(function (entry) {
        const n = isNum(p[entry[0]]) ? p[entry[0]] : 0;
        for (let i = 0; i < n; i += 1) {
          const len = c / total;
          arcs.push(
            h("circle", {
              key: entry[0] + i,
              cx: center,
              cy: center,
              r: r,
              className: "roko-ring-arc roko-ring-" + entry[1],
              strokeWidth: stroke,
              strokeDasharray: Math.max(0.5, len - gap).toFixed(2) + " " + c.toFixed(2),
              strokeDashoffset: (-offset).toFixed(2),
              transform: "rotate(-90 " + center + " " + center + ")",
            })
          );
          offset += len;
        }
      });
    }
    const passed = isNum(p.passed) ? p.passed : 0;
    return h(
      "div",
      { className: "roko-ring" + (props.className ? " " + props.className : ""), style: { width: size, height: size } },
      h(
        "svg",
        {
          viewBox: "0 0 " + size + " " + size,
          width: size,
          height: size,
          role: "img",
          "aria-label": total ? passed + " of " + total + " tasks passed" + (p.running ? ", " + p.running + " running" : "") : "no tasks yet",
        },
        h("circle", { cx: center, cy: center, r: r, className: "roko-ring-track", strokeWidth: stroke }),
        arcs
      ),
      props.label === false
        ? null
        : props.dots
          ? h("div", { className: "roko-ring-label rk-ring-dots", "aria-hidden": "true" }, h(Dots, { value: total ? String(passed) : "–", size: "M", label: total ? passed + "/" + total : "–" }))
          : h(
              "div",
              { className: "roko-ring-label", "aria-hidden": "true" },
              h("span", { className: "roko-ring-num" }, total ? String(passed) : "–"),
              total ? h("span", { className: "roko-ring-den" }, "/" + total) : null
            )
    );
  }

  /** The same ring, small and silent, for list rows and the header chip. */
  function MiniRing(props) {
    return h(Ring, { progress: props.progress, size: props.size || 14, stroke: props.stroke || 2.4, label: false, className: "roko-ring--mini" });
  }

  /** A flat bar in the ring's colours, for list rows. */
  function SegBar(props) {
    const p = obj(props.progress) || {};
    const total = isNum(p.total) ? p.total : 0;
    if (!total) return h("span", { className: "roko-segbar is-empty", "aria-hidden": "true" });
    return h(
      "span",
      { className: "roko-segbar", role: "img", "aria-label": (p.passed || 0) + " of " + total + " tasks passed" },
      PROGRESS_ORDER.concat([["pending", "idle"]]).map(function (entry) {
        const n = isNum(p[entry[0]]) ? p[entry[0]] : 0;
        if (!n) return null;
        return h("span", { key: entry[0], className: "roko-segbar-part roko-seg-" + entry[1], style: { flexGrow: n } });
      })
    );
  }

  /** One pip per check: passed, did not pass, waiting, or running now. */
  function Pips(props) {
    const pips = list(props.pips);
    if (!pips.length) return null;
    return h(
      "span",
      { className: "roko-pips", role: "img", "aria-label": pips.map(function (p) { return str(p.gate) + " " + (p.passed === true ? "passed" : p.passed === false ? "did not pass" : "running"); }).join(", ") },
      pips.slice(0, 12).map(function (pip, i) {
        const cls = pip.passed === true ? "ok" : pip.passed === false ? "bad" : pip.live ? "live" : "idle";
        return h("span", { key: i, className: "roko-pip roko-pip--" + cls, title: str(pip.gate) });
      })
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
      "button",
      {
        type: "button",
        className: "roko-copy" + (props.compact ? " roko-copy--compact" : "") + (state === "copied" ? " is-copied" : ""),
        "aria-label": "Copy the " + (props.what || "text"),
        title: "Copy the " + (props.what || "text"),
        onClick: function (event) {
          event.stopPropagation();
          copyText(props.value).then(function (ok) { setState(ok ? "copied" : "failed"); });
        },
      },
      h(Icon, { name: state === "copied" ? "check" : "copy", size: 12 }),
      props.compact ? null : h("span", null, state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : props.label || "Copy")
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

  function ErrorNote(props) {
    const e = props.error || {};
    return h(
      "div",
      { className: "roko-error" + (props.compact ? " roko-error--compact" : ""), role: "alert" },
      h(
        "div",
        { className: "roko-error-msg" },
        h(Icon, { name: "error", size: 14, className: "roko-tone-bad" }),
        h("span", null, str(e.message) || "Something went wrong.")
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
      { className: "roko-empty" + (props.className ? " " + props.className : "") },
      props.icon ? h("div", { className: "roko-empty-icon" }, h(Icon, { name: props.icon, size: 22, weight: 1.2 })) : null,
      h("div", { className: "roko-empty-title" }, props.title),
      props.children ? h("div", { className: "roko-empty-body" }, props.children) : null
    );
  }

  function Loading(props) {
    return h(
      "div",
      { className: "roko-loading", role: "status" },
      h("span", { className: "roko-spinner", "aria-hidden": "true" }),
      props.label || "Loading…"
    );
  }

  /** Placeholder blocks while a view loads: the layout appears first, the data fills it. */
  function Skeleton(props) {
    const rows = props.rows || 3;
    const out = [];
    for (let i = 0; i < rows; i += 1) {
      out.push(h("div", { key: i, className: "roko-skel", style: { width: (92 - (i * 17) % 40) + "%" } }));
    }
    return h("div", { className: "roko-skels", "aria-hidden": "true" }, out);
  }

  function Panel(props) {
    return h(
      "section",
      { className: "roko-panel " + (props.className || ""), "aria-label": props.ariaLabel || undefined },
      props.title || props.actions
        ? h(
            "div",
            { className: "roko-panel-head" },
            h("h3", { className: "roko-panel-title" }, props.icon ? h(Icon, { name: props.icon, size: 13 }) : null, props.title),
            props.actions ? h("div", { className: "roko-panel-actions" }, props.actions) : null
          )
        : null,
      h("div", { className: "roko-panel-body" }, props.children)
    );
  }

  /** Long untrusted text, clamped with a fade, with Show all. */
  function LongText(props) {
    const value = str(props.value);
    const [open, setOpen] = useState(false);
    if (!value) return null;
    const long = value.length > (props.limit || 420) || value.split("\n").length > (props.lines || 8);
    return h(
      "div",
      { className: "roko-longtext" },
      h("div", { className: "roko-pre " + (props.prose ? "roko-pre--prose" : "") + (long && !open ? " is-clamped" : "") }, value),
      long
        ? h(
            "button",
            { type: "button", className: "roko-linkbtn", "aria-expanded": open ? "true" : "false", onClick: function () { setOpen(!open); } },
            open ? "Show less" : "Show all"
          )
        : null
    );
  }

  /**
   * A dialog. In the dashboard it is the dashboard's own Dialog (Radix: drawn over the whole app,
   * focus kept inside, Esc closes it); elsewhere a dialog drawn here that does the same.
   */
  function Modal(props) {
    const light = useLightTheme();
    if (C.Dialog && C.DialogContent) return h(PortalModal, Object.assign({}, props, { light: light }));
    return h(InlineModal, props);
  }

  function ModalFrame(props) {
    const Title = C.DialogTitle || "div";
    return [
      h(
        "div",
        { key: "head", className: "roko-modal-head" },
        props.icon ? h("span", { className: "roko-modal-icon" }, h(Icon, { name: props.icon, size: 15 })) : null,
        h(
          "div",
          { className: "roko-modal-titles" },
          h(Title, { className: "roko-modal-title" }, props.title),
          props.subtitle ? h("div", { className: "roko-modal-sub" }, props.subtitle) : null
        ),
        h("button", { type: "button", className: "roko-iconbtn", "aria-label": "Close", onClick: props.onClose }, h(Icon, { name: "x", size: 14 }))
      ),
      h("div", { key: "body", className: "roko-modal-body" }, props.children),
      props.footer ? h("div", { key: "foot", className: "roko-modal-foot" }, props.footer) : null,
    ];
  }

  function PortalModal(props) {
    const ref = useRef(null);
    const onClose = props.onClose;
    return h(
      C.Dialog,
      { open: !!props.open, onOpenChange: function (open) { if (!open) onClose(); } },
      props.open
        ? h(
            C.DialogContent,
            {
              className: "roko roko-dialog" + (props.wide ? " roko-dialog--wide" : "") + (props.light ? " roko--light" : ""),
              showCloseButton: false,
              "aria-describedby": undefined,
              onOpenAutoFocus: function (event) {
                const el = ref.current && ref.current.querySelector("[data-autofocus]");
                if (el) {
                  event.preventDefault();
                  el.focus();
                }
              },
            },
            h(
              "div",
              { ref: ref, className: "roko-modal" + (props.wide ? " roko-modal--wide" : ""), "data-roko": props.name || "modal", role: props.role === "alertdialog" ? "group" : undefined },
              ModalFrame(props)
            )
          )
        : null
    );
  }

  /** The dialog drawn by this plugin when the dashboard has none: Esc closes it, focus stays inside. */
  function InlineModal(props) {
    const ref = useRef(null);
    const onClose = props.onClose;
    useEffect(function () {
      if (!props.open) return undefined;
      const previous = document.activeElement;
      const el = ref.current;
      if (el) {
        const first = el.querySelector("[data-autofocus]") || el.querySelector("textarea, input, button");
        if (first && typeof first.focus === "function") first.focus();
      }
      function onKey(event) {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
          return;
        }
        if (event.key !== "Tab" || !el) return;
        const items = [].slice.call(el.querySelectorAll("button, input, textarea, select, [tabindex]:not([tabindex='-1'])"))
          .filter(function (node) { return !node.disabled; });
        if (!items.length) return;
        const firstItem = items[0];
        const lastItem = items[items.length - 1];
        if (event.shiftKey && document.activeElement === firstItem) {
          event.preventDefault();
          lastItem.focus();
        } else if (!event.shiftKey && document.activeElement === lastItem) {
          event.preventDefault();
          firstItem.focus();
        }
      }
      document.addEventListener("keydown", onKey, true);
      return function () {
        document.removeEventListener("keydown", onKey, true);
        if (previous && typeof previous.focus === "function") {
          try { previous.focus(); } catch (_) { /* gone */ }
        }
      };
    }, [props.open]);
    if (!props.open) return null;
    return h(
      "div",
      {
        className: "roko-modal-backdrop",
        onMouseDown: function (event) { if (event.target === event.currentTarget) onClose(); },
      },
      h(
        "div",
        {
          ref: ref,
          className: "roko-modal" + (props.wide ? " roko-modal--wide" : ""),
          role: props.role || "dialog",
          "aria-modal": "true",
          "aria-label": props.title,
          "data-roko": props.name || "modal",
        },
        ModalFrame(props)
      )
    );
  }

  /** A row of small toggle chips (filters, presets). */
  function Chips(props) {
    return h(
      "div",
      { className: "roko-chips", role: props.role || "group", "aria-label": props.label },
      props.items.map(function (item) {
        const on = props.value === item.id;
        return h(
          "button",
          {
            key: item.id,
            type: "button",
            className: "roko-chipbtn" + (on ? " is-on" : "") + (item.tone ? " roko-tone-" + item.tone : ""),
            "aria-pressed": on ? "true" : "false",
            disabled: !!item.disabled,
            title: item.title || undefined,
            onClick: function () { props.onChange(item.id); },
          },
          item.icon ? h(Icon, { name: item.icon, size: 12 }) : null,
          h("span", null, item.label),
          isNum(item.count) ? h("span", { className: "roko-chipbtn-count" }, String(item.count)) : null
        );
      })
    );
  }

  /** A two-or-three way switch, drawn as one control. */
  function Segmented(props) {
    return h(
      "div",
      { className: "roko-segmented", role: "radiogroup", "aria-label": props.label },
      props.items.map(function (item) {
        const on = props.value === item.id;
        return h(
          "button",
          {
            key: item.id,
            type: "button",
            role: "radio",
            "aria-checked": on ? "true" : "false",
            className: "roko-segmented-opt" + (on ? " is-on" : ""),
            onClick: function () { props.onChange(item.id); },
          },
          h("span", { className: "roko-segmented-title" }, item.label),
          item.hint ? h("span", { className: "roko-segmented-hint" }, item.hint) : null
        );
      })
    );
  }

  // ---------------------------------------------------------------------------
  // The control surface: dot-matrix displays, LEDs, keys, switches, a knob, meters, a scope, a dial
  // ---------------------------------------------------------------------------

  // A 5×7 dot-matrix face, drawn here (no font to download): each glyph is seven rows, top to bottom,
  // of lit (1) and unlit (0) dots. Narrow glyphs are narrower rows.
  const GLYPH_ROWS = {
    "0": "01110 10001 10011 10101 11001 10001 01110",
    "1": "00100 01100 00100 00100 00100 00100 01110",
    "2": "01110 10001 00001 00010 00100 01000 11111",
    "3": "11111 00010 00100 00010 00001 10001 01110",
    "4": "00010 00110 01010 10010 11111 00010 00010",
    "5": "11111 10000 11110 00001 00001 10001 01110",
    "6": "00110 01000 10000 11110 10001 10001 01110",
    "7": "11111 00001 00010 00100 01000 01000 01000",
    "8": "01110 10001 10001 01110 10001 10001 01110",
    "9": "01110 10001 10001 01111 00001 00010 01100",
    A: "01110 10001 10001 11111 10001 10001 10001",
    B: "11110 10001 10001 11110 10001 10001 11110",
    C: "01110 10001 10000 10000 10000 10001 01110",
    D: "11100 10010 10001 10001 10001 10010 11100",
    E: "11111 10000 10000 11110 10000 10000 11111",
    F: "11111 10000 10000 11110 10000 10000 10000",
    G: "01110 10001 10000 10111 10001 10001 01111",
    H: "10001 10001 10001 11111 10001 10001 10001",
    I: "111 010 010 010 010 010 111",
    J: "00111 00010 00010 00010 00010 10010 01100",
    K: "10001 10010 10100 11000 10100 10010 10001",
    L: "10000 10000 10000 10000 10000 10000 11111",
    M: "10001 11011 10101 10101 10001 10001 10001",
    N: "10001 10001 11001 10101 10011 10001 10001",
    O: "01110 10001 10001 10001 10001 10001 01110",
    P: "11110 10001 10001 11110 10000 10000 10000",
    Q: "01110 10001 10001 10001 10101 10010 01101",
    R: "11110 10001 10001 11110 10100 10010 10001",
    S: "01111 10000 10000 01110 00001 00001 11110",
    T: "11111 00100 00100 00100 00100 00100 00100",
    U: "10001 10001 10001 10001 10001 10001 01110",
    V: "10001 10001 10001 10001 10001 01010 00100",
    W: "10001 10001 10001 10101 10101 10101 01010",
    X: "10001 10001 01010 00100 01010 10001 10001",
    Y: "10001 10001 01010 00100 00100 00100 00100",
    Z: "11111 00001 00010 00100 01000 10000 11111",
    "$": "00100 01111 10100 01110 00101 11110 00100",
    ".": "0 0 0 0 0 0 1",
    ",": "00 00 00 00 00 01 10",
    ":": "0 0 1 0 1 0 0",
    "/": "00001 00010 00010 00100 01000 01000 10000",
    "%": "11001 11010 00010 00100 01000 01011 10011",
    "+": "00000 00100 00100 11111 00100 00100 00000",
    "-": "000 000 000 111 000 000 000",
    "—": "00000 00000 00000 11111 00000 00000 00000",
    "–": "0000 0000 0000 1111 0000 0000 0000",
    "=": "00000 00000 11111 00000 11111 00000 00000",
    "~": "00000 00000 01000 10101 00010 00000 00000",
    "≈": "00000 01101 10010 00000 01101 10010 00000",
    "×": "00000 10001 01010 00100 01010 10001 00000",
    "<": "00010 00100 01000 10000 01000 00100 00010",
    ">": "01000 00100 00010 00001 00010 00100 01000",
    "▸": "1000 1100 1110 1111 1110 1100 1000",
    "?": "01110 10001 00001 00010 00100 00000 00100",
    "!": "1 1 1 1 1 0 1",
    "#": "01010 01010 11111 01010 11111 01010 01010",
    "(": "001 010 100 100 100 010 001",
    ")": "100 010 001 001 001 010 100",
    "'": "1 1 0 0 0 0 0",
    "·": "0 0 0 1 0 0 0",
    "_": "00000 00000 00000 00000 00000 00000 11111",
    " ": "000 000 000 000 000 000 000",
  };
  const DOT_SIZES = { S: [2, 3], M: [3, 4], L: [4, 5], XL: [5, 6] };
  const glyphCache = {};

  /** One glyph at one size: its lit and unlit dots as two path strings, and its width in columns. */
  function glyphPaths(ch, size) {
    const key = size + ch;
    if (glyphCache[key]) return glyphCache[key];
    const rows = (GLYPH_ROWS[ch] || GLYPH_ROWS[ch.toUpperCase()] || GLYPH_ROWS[" "]).split(" ");
    const dot = DOT_SIZES[size][0];
    const pitch = DOT_SIZES[size][1];
    let on = "";
    let off = "";
    rows.forEach(function (row, y) {
      for (let x = 0; x < row.length; x += 1) {
        const d = "M" + x * pitch + " " + y * pitch + "h" + dot + "v" + dot + "h-" + dot + "z";
        if (row[x] === "1") on += d;
        else off += d;
      }
    });
    glyphCache[key] = { on: on, off: off, width: rows[0].length };
    return glyphCache[key];
  }

  /** A string as dot-matrix glyph groups; a changed glyph remounts, so it rolls in. */
  function dotGlyphs(value, size, pad, ghost) {
    let text = str(value);
    if (pad && text.length < pad) text = new Array(pad - text.length + 1).join(" ") + text;
    const pitch = DOT_SIZES[size][1];
    let x = 0;
    const groups = Array.from(text).map(function (ch, i) {
      const g = glyphPaths(ch, size);
      // The position sits on an outer group: the roll animates the inner one's CSS transform, which
      // would otherwise replace the position.
      const node = h(
        "g",
        { key: i + ":" + ch, transform: "translate(" + x + " 0)" },
        h(
          "g",
          { className: "rk-glyph" },
          ghost === false || !g.off ? null : h("path", { className: "rk-off", d: g.off }),
          g.on ? h("path", { className: "rk-on", d: g.on }) : null
        )
      );
      x += (g.width + 1) * pitch;
      return node;
    });
    return { groups: groups, width: Math.max(pitch, x - pitch), height: 7 * pitch };
  }

  /**
   * Dot-matrix text, for numbers that change. The picture is decorative; the same words are in the
   * page as (visually hidden) text, so screen readers and copy-paste get the plain value.
   */
  function Dots(props) {
    const size = DOT_SIZES[props.size] ? props.size : "M";
    const g = dotGlyphs(props.value, size, props.pad, props.ghost);
    return h(
      "span",
      { className: "rk-dots rk-dots--" + size + (props.className ? " " + props.className : ""), "data-ch": props.ch || undefined, title: props.title || undefined },
      h("svg", { width: g.width, height: g.height, viewBox: "0 0 " + g.width + " " + g.height, "aria-hidden": "true", focusable: "false" }, g.groups),
      h("span", { className: "rk-sr" }, props.label || str(props.value))
    );
  }

  /** Dot-matrix text placed inside another SVG (the dial's centre), scaled to its units. */
  function DotsAt(props) {
    const size = DOT_SIZES[props.size] ? props.size : "S";
    const g = dotGlyphs(props.value, size, 0, props.ghost);
    const k = props.scale || 1;
    const x = props.anchor === "middle" ? props.x - (g.width * k) / 2 : props.x;
    return h(
      "svg",
      { x: x, y: props.y, width: g.width * k, height: g.height * k, viewBox: "0 0 " + g.width + " " + g.height, className: "rk-dots-at", "data-ch": props.ch || undefined },
      g.groups
    );
  }

  /** The black display glass every live number sits in. */
  function Well(props) {
    return h(
      "div",
      {
        className: "rk-well" + (props.className ? " " + props.className : ""),
        "data-ch": props.ch || undefined,
        role: props.role || undefined,
        "aria-label": props.ariaLabel || undefined,
        "aria-live": props.live || undefined,
        "data-roko": props.name || undefined,
      },
      props.children
    );
  }

  /** An 8 px status light: solid when done, a slow blink while an agent works, fast when it needs you. */
  function LED(props) {
    const ch = props.ch || "off";
    const blink = props.blink === false ? null : props.blink || (ch === "agent" ? "slow" : ch === "you" ? "fast" : null);
    return h("span", {
      className: "rk-led" + (props.className ? " " + props.className : ""),
      "data-ch": ch,
      "data-blink": blink || undefined,
      role: props.label ? "img" : undefined,
      "aria-label": props.label || undefined,
      "aria-hidden": props.label ? undefined : "true",
      title: props.title || props.label || undefined,
    });
  }

  /** A key: it travels when pressed, and shows its keyboard key engraved on it. */
  function Key(props) {
    const label = props.label != null ? props.label : props.children;
    const onClick = props.onClick;
    return h(
      "button",
      {
        type: props.type || "button",
        className:
          "rk-key" + (props.tone ? " rk-key--" + props.tone : "") + (props.size ? " rk-key--" + props.size : "") +
          (props.className ? " " + props.className : ""),
        onClick: function (event) {
          sound.play("key", { user: true });
          if (onClick) onClick(event);
        },
        disabled: !!props.disabled,
        title: props.title || undefined,
        "aria-label": props.ariaLabel || (props.kbd && typeof label === "string" ? label : undefined),
        "aria-keyshortcuts": props.keys || undefined,
        "aria-pressed": props.pressed == null ? undefined : props.pressed ? "true" : "false",
        "aria-busy": props.busy ? "true" : undefined,
        "data-autofocus": props.autoFocus ? "true" : undefined,
        "data-roko": props.name || undefined,
      },
      props.icon ? h(Icon, { name: props.icon, size: props.iconSize || 13 }) : null,
      label != null && label !== "" ? h("span", { className: "rk-key-label" }, label) : null,
      props.kbd ? h("kbd", { className: "rk-key-kbd", "aria-hidden": "true" }, props.kbd) : null
    );
  }

  /** A two-position slide switch with both labels in view. */
  function Switch(props) {
    const items = props.items;
    const at = Math.max(0, items.map(function (i) { return i.id; }).indexOf(props.value));
    function pick(id) {
      if (id === props.value) return;
      sound.play("key", { user: true });
      props.onChange(id);
    }
    return h(
      "div",
      { className: "rk-switch" + (props.size ? " rk-switch--" + props.size : ""), role: "radiogroup", "aria-label": props.label, "data-at": at },
      h(
        "button",
        { type: "button", role: "radio", "aria-checked": at === 0 ? "true" : "false", className: "rk-switch-opt" + (at === 0 ? " is-on" : ""), onClick: function () { pick(items[0].id); } },
        h("span", null, items[0].label)
      ),
      h(
        "span",
        { className: "rk-switch-track", "aria-hidden": "true", onClick: function () { pick(items[at === 0 ? 1 : 0].id); } },
        h("span", { className: "rk-switch-thumb" })
      ),
      h(
        "button",
        { type: "button", role: "radio", "aria-checked": at === 1 ? "true" : "false", className: "rk-switch-opt" + (at === 1 ? " is-on" : ""), onClick: function () { pick(items[1].id); } },
        h("span", null, items[1].label)
      )
    );
  }

  /**
   * A detented knob: ←/→ (↑/↓), the wheel, or a drag step between the detents allowed (the ones at or
   * under `max`); each detent is also a key under it. One `slider` for assistive tech.
   */
  function Knob(props) {
    const detents = props.detents;
    const max = isNum(props.max) ? props.max : Infinity;
    const allowed = detents.filter(function (d) { return d <= max + 1e-9; });
    const value = props.value;
    const onChange = props.onChange;
    const ref = useRef(null);
    const stateRef = useRef({});
    stateRef.current = { value: value, allowed: allowed, onChange: onChange, disabled: props.disabled };

    function stepFrom(cur, dir, allowedNow) {
      if (!allowedNow.length) return null;
      const i = allowedNow.indexOf(cur);
      if (i >= 0) return allowedNow[clamp(i + dir, 0, allowedNow.length - 1)];
      const above = allowedNow.filter(function (d) { return d > cur; });
      const below = allowedNow.filter(function (d) { return d < cur; });
      return dir > 0 ? (above.length ? above[0] : allowedNow[allowedNow.length - 1]) : below.length ? below[below.length - 1] : allowedNow[0];
    }
    function nudge(dir) {
      const st = stateRef.current;
      if (st.disabled) return;
      const next = stepFrom(st.value, dir, st.allowed);
      if (next !== null && next !== st.value) {
        sound.play("key", { user: true });
        st.onChange(next);
      }
    }
    // The wheel needs a listener that may cancel scrolling (React's is passive).
    useEffect(function () {
      const el = ref.current;
      if (!el) return undefined;
      let acc = 0;
      function onWheel(event) {
        event.preventDefault();
        acc += event.deltaY;
        if (Math.abs(acc) < 24) return;
        nudge(acc < 0 ? 1 : -1);
        acc = 0;
      }
      el.addEventListener("wheel", onWheel, { passive: false });
      return function () { el.removeEventListener("wheel", onWheel); };
    }, []);

    function onPointerDown(event) {
      if (props.disabled || event.button !== 0) return;
      const el = ref.current;
      const startY = event.clientY;
      let steps = 0;
      try { el.setPointerCapture(event.pointerId); } catch (_) { /* not supported */ }
      function move(ev) {
        const want = Math.trunc((startY - ev.clientY) / 18);
        while (steps < want) { nudge(1); steps += 1; }
        while (steps > want) { nudge(-1); steps -= 1; }
      }
      function up() {
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerup", up);
        el.removeEventListener("pointercancel", up);
      }
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", up);
      el.addEventListener("pointercancel", up);
    }

    // Where the value sits on the scale: the detents spread over 270°, from 7:30 to 4:30.
    const n = detents.length;
    let pos = detents.indexOf(value);
    if (pos < 0) {
      const above = detents.filter(function (d) { return d >= value; })[0];
      const i = above === undefined ? n - 1 : detents.indexOf(above);
      const lo = i > 0 ? detents[i - 1] : 0;
      pos = i - (above === undefined ? 0 : (above - value) / Math.max(1e-9, above - lo));
    }
    const angle = -135 + (n > 1 ? (270 * clamp(pos, 0, n - 1)) / (n - 1) : 0);
    const marks = detents.map(function (d, i) {
      const a = ((-135 + (n > 1 ? (270 * i) / (n - 1) : 0)) * Math.PI) / 180;
      const lit = d <= value + 1e-9;
      const ok = d <= max + 1e-9;
      return h("line", {
        key: i,
        x1: (32 + Math.sin(a) * 26).toFixed(2),
        y1: (32 - Math.cos(a) * 26).toFixed(2),
        x2: (32 + Math.sin(a) * 30).toFixed(2),
        y2: (32 - Math.cos(a) * 30).toFixed(2),
        className: "rk-knob-mark" + (lit ? " is-lit" : "") + (ok ? "" : " is-off"),
      });
    });
    return h(
      "div",
      { className: "rk-knobset" + (props.disabled ? " is-disabled" : "") },
      h(
        "div",
        {
          ref: ref,
          className: "rk-knob",
          role: "slider",
          tabIndex: props.disabled ? -1 : 0,
          "aria-label": props.label,
          "aria-valuemin": allowed.length ? allowed[0] : 0,
          "aria-valuemax": allowed.length ? allowed[allowed.length - 1] : 0,
          "aria-valuenow": value,
          "aria-valuetext": money(value),
          "aria-disabled": props.disabled ? "true" : undefined,
          "data-roko": "knob",
          onKeyDown: function (event) {
            if (event.key === "ArrowRight" || event.key === "ArrowUp") {
              event.preventDefault();
              nudge(1);
            } else if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
              event.preventDefault();
              nudge(-1);
            } else if (event.key === "Home" && allowed.length) {
              event.preventDefault();
              onChange(allowed[0]);
            } else if (event.key === "End" && allowed.length) {
              event.preventDefault();
              onChange(allowed[allowed.length - 1]);
            }
          },
          onPointerDown: onPointerDown,
        },
        h(
          "svg",
          { viewBox: "0 0 64 64", width: 64, height: 64, "aria-hidden": "true" },
          marks,
          h("circle", { cx: 32, cy: 32, r: 21, className: "rk-knob-body" }),
          h("circle", { cx: 32, cy: 32, r: 15, className: "rk-knob-cap" }),
          h(
            "g",
            { transform: "rotate(" + angle.toFixed(1) + " 32 32)", className: "rk-knob-pointer" },
            h("line", { x1: 32, y1: 30, x2: 32, y2: 14 })
          )
        )
      ),
      h(
        "div",
        { className: "rk-knob-read" },
        h(Well, { className: "rk-knob-well" }, h(Dots, { value: money(value), size: "M", label: "cap " + money(value), ch: "you" })),
        h(
          "div",
          { className: "rk-detents", role: "group", "aria-label": props.label + " presets" },
          detents.map(function (d) {
            const ok = d <= max + 1e-9;
            return h(
              "button",
              {
                key: d,
                type: "button",
                className: "rk-detent" + (Math.abs(d - value) < 1e-9 ? " is-on" : ""),
                "aria-pressed": Math.abs(d - value) < 1e-9 ? "true" : "false",
                disabled: !ok || props.disabled,
                title: ok ? undefined : "over your limit",
                onClick: function () {
                  sound.play("key", { user: true });
                  onChange(d);
                },
              },
              money(d)
            );
          })
        )
      )
    );
  }

  /** A 20-segment meter: segments go from the pass colour to `you` at 80 % and `fail` at 95 %. */
  function SegMeter(props) {
    const max = props.max;
    if (!isNum(max) || max <= 0) return null;
    const n = props.segments || 20;
    const value = isNum(props.value) ? Math.max(0, props.value) : 0;
    const projected = isNum(props.projected) && props.projected > value ? props.projected : null;
    const lit = value > 0 ? Math.max(1, Math.round(clamp(value / max, 0, 1) * n)) : 0;
    const ghost = projected === null ? lit : Math.round(clamp(projected / max, 0, 1) * n);
    const segs = [];
    for (let i = 0; i < n; i += 1) {
      const at = (i + 1) / n;
      const ch = at > 0.95 ? "fail" : at > 0.8 ? "you" : "pass";
      const cls = i < lit ? " is-lit" : i < ghost ? " is-ghost" : "";
      segs.push(h("span", { key: i, className: "rk-seg" + cls, "data-ch": ch }));
    }
    return h(
      "span",
      {
        className: "rk-segmeter" + (props.className ? " " + props.className : "") + (projected !== null && projected > max ? " is-over" : ""),
        role: "meter",
        "aria-valuemin": 0,
        "aria-valuemax": max,
        "aria-valuenow": value,
        "aria-label": props.label || undefined,
        style: { "--rk-segs": n },
      },
      segs,
      h("span", { className: "rk-segmeter-cap", "aria-hidden": "true" })
    );
  }

  const STRIP_ORDER = [
    ["passed", "pass"],
    ["unverified", "you"],
    ["failed", "fail"],
    ["blocked", "fail"],
    ["stopped", "off"],
    ["running", "agent"],
    ["queued", "idle"],
    ["pending", "idle"],
  ];

  /** One small square per task in its channel colour (a run's progress, at a glance). */
  function StepStrip(props) {
    const p = obj(props.progress) || {};
    const total = isNum(p.total) ? p.total : 0;
    const cap = props.max || 16;
    const cells = [];
    STRIP_ORDER.forEach(function (entry) {
      const k = isNum(p[entry[0]]) ? p[entry[0]] : 0;
      for (let i = 0; i < k && cells.length < cap; i += 1) cells.push(props.waiting && entry[0] === "running" ? "wait" : entry[1]);
    });
    while (cells.length < Math.min(total, cap)) cells.push("idle");
    if (!cells.length) return h("span", { className: "rk-strip is-empty", "aria-hidden": "true" }, h("span", { className: "rk-strip-cell", "data-ch": "idle" }));
    return h(
      "span",
      { className: "rk-strip" + (props.size ? " rk-strip--" + props.size : ""), role: "img", "aria-label": (p.passed || 0) + " of " + total + " tasks passed" + (p.running ? ", " + p.running + " running" : "") },
      cells.map(function (ch, i) {
        return ch === "wait"
          ? h("span", { key: i, className: "rk-strip-cell", "data-ch": "you", "data-wait": "true" })
          : h("span", { key: i, className: "rk-strip-cell", "data-ch": ch });
      }),
      total > cap ? h("span", { className: "rk-strip-more", "aria-hidden": "true" }, "+" + (total - cap)) : null
    );
  }

  /** A numbered module: `01 LABEL` at its top left, always in the same place. */
  function Module(props) {
    return h(
      "section",
      {
        className: "rk-module" + (props.className ? " " + props.className : ""),
        "aria-label": props.ariaLabel || str(props.label).toLowerCase() || undefined,
        "data-roko": props.name || undefined,
      },
      props.label
        ? h(
            "header",
            { className: "rk-module-head" },
            props.index ? h("span", { className: "rk-module-idx" }, props.index) : null,
            h("span", { className: "rk-module-label" }, props.label),
            props.right ? h("span", { className: "rk-module-right" }, props.right) : null
          )
        : null,
      h("div", { className: "rk-module-body" }, props.children)
    );
  }

  const SCOPE_SPAN_MS = 20000;
  const SCOPE_POOL = 28;

  /**
   * The machine's pulse: a trace that blips, in the event's colour, for every tool step, check and loop
   * event the socket brings. It animates only while there is something in its 20 s window, and never
   * with reduced motion (then it redraws once per event).
   */
  function Scope(props) {
    const W = props.width || 168;
    const H = props.height || 44;
    const runId = props.runId;
    const blips = useRef([]);
    useEffect(function () {
      const release = liveStore.use();
      let raf = 0;
      let last = 0;
      let alive = true;
      const reduced = prefersReducedMotion();
      const mid = H / 2;
      function draw(now) {
        const shown = liveStore.pulses().filter(function (p) {
          return (runId === undefined || p.run === runId) && now - p.at <= SCOPE_SPAN_MS;
        }).slice(-SCOPE_POOL);
        for (let i = 0; i < SCOPE_POOL; i += 1) {
          const el = blips.current[i];
          if (!el) continue;
          const p = shown[i];
          if (!p) {
            el.setAttribute("d", "");
            continue;
          }
          const age = now - p.at;
          const x = W - 6 - (age / SCOPE_SPAN_MS) * (W - 12);
          const a = H * 0.4 * clamp(p.amp, 0.15, 1.2);
          el.setAttribute(
            "d",
            "M" + (x - 7).toFixed(1) + " " + mid + "L" + (x - 3).toFixed(1) + " " + mid + "L" + (x - 1.5).toFixed(1) + " " + (mid - a).toFixed(1) +
              "L" + (x + 1).toFixed(1) + " " + (mid + a * 0.55).toFixed(1) + "L" + (x + 3).toFixed(1) + " " + (mid - a * 0.2).toFixed(1) +
              "L" + (x + 5).toFixed(1) + " " + mid + "L" + (x + 8).toFixed(1) + " " + mid
          );
          el.setAttribute("data-ch", p.ch);
          el.setAttribute("opacity", (1 - (age / SCOPE_SPAN_MS) * 0.7).toFixed(2));
        }
        return shown.length > 0;
      }
      function frame() {
        raf = 0;
        if (!alive) return;
        const now = Date.now();
        if (now - last >= 33) {
          last = now;
          if (!draw(now)) return;
        }
        raf = window.requestAnimationFrame(frame);
      }
      function wake() {
        if (reduced || typeof window.requestAnimationFrame !== "function") {
          draw(Date.now());
          return;
        }
        if (!raf && !(typeof document !== "undefined" && document.visibilityState === "hidden")) raf = window.requestAnimationFrame(frame);
      }
      const unsub = liveStore.subscribe(function (kind, rid) {
        if (kind === "pulse" && (runId === undefined || rid === runId)) wake();
      });
      wake();
      return function () {
        alive = false;
        if (raf) window.cancelAnimationFrame(raf);
        unsub();
        release();
      };
    }, [runId, W, H]);
    const pool = [];
    for (let i = 0; i < SCOPE_POOL; i += 1) {
      pool.push(h("path", { key: i, ref: function (el) { blips.current[i] = el; }, className: "rk-scope-blip", d: "" }));
    }
    return h(
      Well,
      { className: "rk-scope" + (props.className ? " " + props.className : "") },
      h(
        "svg",
        { viewBox: "0 0 " + W + " " + H, width: W, height: H, "aria-hidden": "true", preserveAspectRatio: "none" },
        [0.25, 0.5, 0.75].map(function (f) {
          return h("line", { key: f, x1: W * f, y1: 2, x2: W * f, y2: H - 2, className: "rk-scope-grid" });
        }),
        h("line", { x1: 0, y1: H / 2, x2: W, y2: H / 2, className: "rk-scope-base" }),
        pool
      ),
      props.label ? h("span", { className: "rk-scope-label" }, props.label) : null
    );
  }

  const DIAL_R = [38, 54, 70, 86, 102];
  const DIAL_HALF = 118;
  const DIAL_WINDOW_MS = 10 * 60 * 1000;

  /**
   * roko's five loops as one instrument: five rings, L0 (tool calls, seconds) inside to L4 (audit,
   * weeks) outside. Live, a hand sweeps once a minute and each event drops a tick on its ring at the
   * second it happened, fading over ten minutes; for a finished run the ring is the run's whole span.
   */
  function Dial(props) {
    const events = list(props.events).filter(function (ev) { return obj(ev) && isNum(ev.ts); });
    const live = !!props.live;
    const now = useTick(live);
    const reduced = prefersReducedMotion();
    const delay = useMemo(function () { return -((Date.now() / 1000) % 60); }, []);
    let t0 = 0;
    let t1 = 1;
    if (!live && events.length) {
      t0 = Math.min.apply(null, events.map(function (e) { return e.ts; }));
      t1 = Math.max.apply(null, events.map(function (e) { return e.ts; }));
      if (t1 - t0 < 1000) t1 = t0 + 60000;
    }
    const shown = live ? events.filter(function (e) { return now - e.ts < DIAL_WINDOW_MS; }) : events;
    const perRing = [0, 0, 0, 0, 0];
    shown.forEach(function (e) { perRing[ringIndex(e.ring)] += 1; });
    function angleOf(ts) {
      return live ? ((ts / 1000) % 60) * 6 : 15 + ((ts - t0) / Math.max(1, t1 - t0)) * 330;
    }
    const ticks = shown.map(function (e, i) {
      const r = DIAL_R[ringIndex(e.ring)];
      const a = (angleOf(e.ts) * Math.PI) / 180;
      const age = live ? now - e.ts : 0;
      const fresh = live && age < 2600;
      return h("line", {
        key: str(e.key) || i,
        x1: (Math.sin(a) * (r - 6)).toFixed(2),
        y1: (-Math.cos(a) * (r - 6)).toFixed(2),
        x2: (Math.sin(a) * (r + 6)).toFixed(2),
        y2: (-Math.cos(a) * (r + 6)).toFixed(2),
        className: "rk-tick" + (fresh ? " rk-tick--new" : ""),
        "data-ch": loopChannel(e),
        opacity: live ? Math.max(0.28, 1 - age / DIAL_WINDOW_MS).toFixed(2) : undefined,
      });
    });
    const newest = shown.length ? shown.reduce(function (a, b) { return b.ts >= a.ts ? b : a; }) : null;
    const marks = [];
    for (let i = 0; i < 60; i += 1) {
      const a = (i * 6 * Math.PI) / 180;
      const long = i % 5 === 0;
      const r1 = DIAL_R[4] + 9;
      const r2 = r1 + (long ? 6 : 3);
      marks.push(h("line", { key: i, x1: (Math.sin(a) * r1).toFixed(2), y1: (-Math.cos(a) * r1).toFixed(2), x2: (Math.sin(a) * r2).toFixed(2), y2: (-Math.cos(a) * r2).toFixed(2), className: "rk-dial-mark" + (long ? " is-long" : "") }));
    }
    const label = "roko's five loops: " + RINGS.map(function (ring, i) { return ring.id + " " + ring.name + " " + perRing[i]; }).join(", ") + (newest ? "; newest: " + str(newest.text) : "");
    return h(
      "div",
      { className: "rk-dial" + (live ? " is-live" : ""), "data-roko": "dial" },
      h(
        "svg",
        { viewBox: -DIAL_HALF + " " + -DIAL_HALF + " " + DIAL_HALF * 2 + " " + DIAL_HALF * 2, width: props.size || 236, height: props.size || 236, role: "img", "aria-label": label },
        h("circle", { cx: 0, cy: 0, r: DIAL_HALF - 1, className: "rk-dial-face" }),
        marks,
        DIAL_R.map(function (r, i) {
          return h("circle", { key: i, cx: 0, cy: 0, r: r, className: "rk-dial-ring" + (perRing[i] ? " is-active" : "") });
        }),
        DIAL_R.map(function (r, i) {
          return h("text", { key: "t" + i, x: 3, y: -r + 3.5, className: "rk-dial-ringlabel" }, RINGS[i].id);
        }),
        live ? null : h("line", { x1: 0, y1: -DIAL_R[0] + 8, x2: 0, y2: -DIAL_R[4] - 8, className: "rk-dial-zero" }),
        ticks,
        live && !reduced
          ? h(
              "g",
              { className: "rk-dial-hand", style: { animationDelay: delay.toFixed(2) + "s" } },
              h("line", { x1: 0, y1: 0, x2: 0, y2: -(DIAL_R[4] + 8) }),
              h("circle", { cx: 0, cy: -(DIAL_R[4] + 8), r: 2.2 })
            )
          : null,
        h("circle", { cx: 0, cy: 0, r: 29, className: "rk-dial-hub" }),
        newest
          ? [
              h(DotsAt, { key: "ring", value: str(newest.ring) || "L?", size: "M", scale: 0.62, x: 0, y: -15, anchor: "middle", ch: loopChannel(newest) }),
              h(DotsAt, { key: "kind", value: HUB_WORD[newest.kind] || str(newest.kind).slice(0, 8), size: "S", scale: 0.36, x: 0, y: 6, anchor: "middle" }),
            ]
          : h(DotsAt, { value: "IDLE", size: "S", scale: 0.6, x: 0, y: -4, anchor: "middle" })
      )
    );
  }

  /** The dial's legend: per ring its LED, name, clock and how many events it shows. */
  function DialLegend(props) {
    const events = list(props.events);
    const cutoff = props.live ? Date.now() - DIAL_WINDOW_MS : -Infinity;
    return h(
      "ol",
      { className: "rk-legend" },
      RINGS.map(function (ring, i) {
        const mine = events.filter(function (e) { return ringIndex(e.ring) === i && (!isNum(e.ts) || e.ts >= cutoff); });
        const newest = mine.length ? mine[mine.length - 1] : null;
        const state = obj(props.states) ? props.states[ring.id] : null;
        return h(
          "li",
          { key: ring.id, className: "rk-legend-row" + (mine.length ? " is-active" : "") },
          h(LED, { ch: newest ? loopChannel(newest) : state === "active" ? "agent" : "off", blink: false }),
          h("span", { className: "rk-legend-id" }, ring.id),
          h("span", { className: "rk-legend-name" }, ring.name),
          h("span", { className: "rk-legend-clock" }, ring.clock),
          h(Dots, { value: String(mine.length), size: "S", pad: 3, label: plural(mine.length, "event", "events") })
        );
      })
    );
  }

  /** One loop event as a feed line: ring tag in its colour, the words, when. */
  function LoopLine(props) {
    const ev = props.event;
    const ch = loopChannel(ev);
    return h(
      "li",
      { className: "rk-loopline", "data-ch": ch },
      h("span", { className: "rk-ringtag", "data-ch": ch }, str(ev.ring) || "L?"),
      h("span", { className: "rk-loopline-kind" }, LOOP_WORD[ev.kind] || str(ev.kind)),
      h("span", { className: "rk-loopline-text" }, oneLine(ev.text, 220)),
      isNum(ev.ts) ? h("time", { className: "rk-loopline-when", dateTime: new Date(ev.ts).toISOString(), title: new Date(ev.ts).toLocaleString() }, ago(new Date(ev.ts).toISOString(), props.now || Date.now())) : null
    );
  }

  // ---------------------------------------------------------------------------
  // A run's timeline: the last 400 lines, then only what is new while it runs
  // ---------------------------------------------------------------------------

  function lineKey(ev) {
    return ev.cursor != null ? "c" + ev.cursor : "t" + str(ev.type) + str(ev.text);
  }

  function useRunEvents(runId, active) {
    const [state, setState] = useState({ events: [], loaded: false, error: null });
    const activeRef = useRef(active);
    activeRef.current = active;
    const kickRef = useRef(null);
    const seenRef = useRef(new Set());

    // Lines the live socket pushes join the timeline at once, in cursor order.
    useEffect(function () {
      const release = liveStore.use();
      const unsub = liveStore.subscribe(function (kind, rid, lines) {
        if (kind !== "lines" || rid !== runId) return;
        const seen = seenRef.current;
        const fresh = list(lines).filter(function (ev) {
          if (!obj(ev)) return false;
          const key = lineKey(ev);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        if (!fresh.length) return;
        setState(function (prev) {
          const merged = prev.events.concat(fresh);
          merged.sort(function (a, b) {
            return (isNum(a.cursor) ? a.cursor : Infinity) - (isNum(b.cursor) ? b.cursor : Infinity);
          });
          return { events: merged.slice(-MAX_EVENTS), loaded: prev.loaded, error: prev.error };
        });
      });
      return function () {
        unsub();
        release();
      };
    }, [runId]);

    useEffect(function () {
      let alive = true;
      let timer = null;
      let cursor = null;
      let running = false;
      const seen = new Set();
      seenRef.current = seen;
      setState({ events: [], loaded: false, error: null });

      function pull() {
        if (running || !alive) return;
        running = true;
        clearTimeout(timer);
        timer = null;
        const q = cursor == null ? "?tail=" + EVENTS_TAIL : "?limit=200&cursor=" + enc(cursor);
        apiGet("/runs/" + enc(runId) + "/events" + q).then(function (res) {
          running = false;
          if (!alive) return;
          if (!res.ok) {
            setState(function (prev) { return { events: prev.events, loaded: true, error: res.error }; });
          } else {
            const fresh = [];
            list(res.data.events).forEach(function (ev) {
              if (!obj(ev)) return;
              const key = lineKey(ev);
              if (seen.has(key)) return;
              seen.add(key);
              fresh.push(ev);
            });
            if (res.data.next_cursor != null) cursor = res.data.next_cursor;
            setState(function (prev) {
              let merged = prev.events;
              if (fresh.length) {
                merged = prev.events.concat(fresh);
                merged.sort(function (a, b) {
                  return (isNum(a.cursor) ? a.cursor : Infinity) - (isNum(b.cursor) ? b.cursor : Infinity);
                });
                merged = merged.slice(-MAX_EVENTS);
              }
              return { events: merged, loaded: true, error: null };
            });
            if (res.data.has_more && fresh.length) {
              pull();
              return;
            }
          }
          if (activeRef.current) timer = setTimeout(pull, liveStore.healthy() ? LIVE_FALLBACK_MS : RUN_POLL_MS);
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
      if (active && kickRef.current) kickRef.current();
    }, [active]);
    return state;
  }

  // ---------------------------------------------------------------------------
  // What each task looked like at a moment: from the card (now) or the timeline (replay)
  // ---------------------------------------------------------------------------

  const ATTEMPT_RE = /attempt \d+ on (\S+)/;
  const GATE_RE = /^\S+ gate (.+?) (passed|did not pass)$/;

  function taskView(task) {
    const log = list(task.attempt_log);
    const lastAttempt = log.length ? log[log.length - 1] : null;
    // The latest attempt's own checks. An attempt that has not reached its checks has none: the task's
    // gates hold earlier attempts' verdicts, so they stand in only when a backend sends no attempt_log.
    let pips = lastAttempt ? list(lastAttempt.gates).map(function (g) { return { gate: g.gate, passed: g.passed === true }; }) : [];
    if (!lastAttempt) pips = list(task.gates).map(function (g) { return { gate: g.gate, passed: g.passed === true }; });
    if (task.step === "check" && task.step_detail) pips = pips.concat([{ gate: task.step_detail, passed: null, live: true }]);
    return {
      state: nodeState(task.outcome),
      outcome: str(task.outcome) || "pending",
      step: task.step || null,
      detail: task.step_detail || null,
      since: task.step_since || null,
      attempts: isNum(task.attempts) ? task.attempts : 0,
      pips: pips,
      duration: isNum(task.duration_ms) ? task.duration_ms : null,
      started: task.started_at || null,
      model: task.model || null,
    };
  }

  /** Each task's state at time `t`, rebuilt from the timeline's lines. */
  function replayAt(tasks, events, t) {
    const map = {};
    tasks.forEach(function (task) {
      map[str(task.task_id)] = {
        state: "pending",
        outcome: "pending",
        step: null,
        detail: null,
        since: null,
        attempts: 0,
        pips: [],
        duration: null,
        started: null,
        model: null,
      };
    });
    let current = null;
    events.forEach(function (ev) {
      const ts = ev.ts_millis;
      if (!isNum(ts) || ts > t) return;
      current = ev;
      const s = ev.task_id ? map[str(ev.task_id)] : null;
      if (!s) return;
      const text = str(ev.text);
      if (ev.type === "task_started") {
        s.state = "running";
        s.outcome = "running";
        s.step = "starting";
        s.since = ts;
        s.started = s.started || ts;
      } else if (ev.type === "agent_spawned") {
        // 0.3.0 lines carry model and attempt; older ones only say them in their text.
        const m = ATTEMPT_RE.exec(text);
        const model = str(ev.model) || (m ? m[1] : null);
        s.state = "running";
        s.outcome = "running";
        s.attempts = isNum(ev.attempt) && ev.attempt > 0 ? Math.max(s.attempts, ev.attempt) : s.attempts + 1;
        s.step = "agent";
        s.detail = model;
        s.model = model || s.model;
        s.since = ts;
        s.started = s.started || ts;
        s.pips = [];
      } else if (ev.type === "gate_rung_started") {
        const at = text.indexOf("checking ");
        s.step = "check";
        s.detail = str(ev.gate) || (at >= 0 ? text.slice(at + 9) : null);
        s.since = ts;
        s.pips = s.pips.concat([{ gate: s.detail, passed: null, live: true }]);
      } else if (ev.type === "gate_result") {
        const m = GATE_RE.exec(text);
        const gate = str(ev.gate) || (m ? m[1] : null);
        const passed = ev.passed === true;
        let replaced = false;
        s.pips = s.pips.map(function (p) {
          if (!replaced && p.live && (!gate || p.gate === gate)) {
            replaced = true;
            return { gate: p.gate, passed: passed };
          }
          return p;
        });
        if (!replaced) s.pips = s.pips.concat([{ gate: gate, passed: passed }]);
      } else if (ev.type === "task_completed") {
        s.outcome = str(ev.outcome) || "passed";
        s.state = nodeState(s.outcome);
        s.step = null;
        s.duration = s.started ? ts - s.started : null;
      } else if (ev.type === "task_blocked") {
        s.outcome = "blocked";
        s.state = "blocked";
        s.step = null;
      }
    });
    return { tasks: map, current: current };
  }

  function stepWords(view) {
    if (view.step === "agent") return "agent" + (view.detail ? " · " + view.detail : "");
    if (view.step === "check") return "checking" + (view.detail ? " " + view.detail : "");
    if (view.step === "waiting") return "waits for " + (view.detail || "you");
    if (view.step === "agent done") return "agent finished";
    if (view.step === "starting") return "starting";
    return "";
  }

  // ---------------------------------------------------------------------------
  // The run graph: one column per wave, edges drawn under the nodes
  // ---------------------------------------------------------------------------

  const GRAPH = { pad: 14, head: 26, nodeH: 88, minW: 160, maxW: 240, colGap: 46, rowGap: 14 };

  function layoutGraph(graph, width) {
    const waves = list(graph && graph.waves).map(function (w) { return list(w).map(str); }).filter(function (w) { return w.length; });
    const cols = Math.max(1, waves.length);
    const maxRows = waves.reduce(function (m, w) { return Math.max(m, w.length); }, 1);
    const room = (width || 900) - GRAPH.pad * 2 - (cols - 1) * GRAPH.colGap;
    const nodeW = clamp(Math.floor(room / cols), GRAPH.minW, GRAPH.maxW);
    const nodeH = GRAPH.nodeH;
    const stack = maxRows * nodeH + (maxRows - 1) * GRAPH.rowGap;
    const pos = {};
    waves.forEach(function (wave, wi) {
      const colH = wave.length * nodeH + (wave.length - 1) * GRAPH.rowGap;
      const top = GRAPH.head + GRAPH.pad + (stack - colH) / 2;
      wave.forEach(function (id, ri) {
        pos[id] = { x: GRAPH.pad + wi * (nodeW + GRAPH.colGap), y: top + ri * (nodeH + GRAPH.rowGap), wave: wi };
      });
    });
    const edges = list(graph && graph.edges)
      .filter(function (e) { return Array.isArray(e) && pos[str(e[0])] && pos[str(e[1])]; })
      .map(function (e) {
        const a = pos[str(e[0])];
        const b = pos[str(e[1])];
        const x1 = a.x + nodeW;
        const y1 = a.y + nodeH / 2;
        const x2 = b.x;
        const y2 = b.y + nodeH / 2;
        const dx = Math.max(26, (x2 - x1) * 0.52);
        const d = "M" + x1 + " " + y1 + " C" + (x1 + dx) + " " + y1 + ", " + (x2 - dx) + " " + y2 + ", " + x2 + " " + y2;
        return { from: str(e[0]), to: str(e[1]), d: d };
      });
    return {
      waves: waves,
      pos: pos,
      edges: edges,
      nodeW: nodeW,
      nodeH: nodeH,
      width: GRAPH.pad * 2 + cols * nodeW + (cols - 1) * GRAPH.colGap,
      height: GRAPH.head + GRAPH.pad * 2 + stack,
    };
  }

  function edgeState(from, to) {
    if (!from || !to) return "idle";
    if (from.state === "failed" || to.state === "blocked") return "bad";
    if (from.state === "passed" && to.state === "running") return "flow";
    if (from.state === "passed" && (to.state === "passed" || to.state === "warn")) return "done";
    if (from.state === "passed") return "ready";
    return "idle";
  }

  const NODE_GLYPH = { passed: "check", failed: "x", blocked: "x", stopped: "stop", warn: "info" };

  /** A pad flashes its colour when its task finishes while the page watches (never on load). */
  function usePadFlash(state, off) {
    const prev = useRef(state);
    const [flash, setFlash] = useState(null);
    useEffect(function () {
      const was = prev.current;
      prev.current = state;
      if (off || was === state || (was !== "running" && was !== "pending")) return undefined;
      if (state !== "passed" && state !== "failed" && state !== "warn") return undefined;
      if (prefersReducedMotion()) return undefined;
      setFlash(channelOf(state));
      const timer = setTimeout(function () { setFlash(null); }, 760);
      return function () {
        clearTimeout(timer);
        setFlash(null);
      };
    }, [state, off]);
    return flash;
  }

  /** A task as a pad: its id big, an LED for its state, the title, and what it is doing or did. */
  function GraphNode(props) {
    const task = props.task || {};
    const view = props.view;
    const id = str(task.task_id || task.id);
    const state = props.planned ? "planned" : view.state;
    const deps = list(task.depends_on).map(str);
    const flash = usePadFlash(state, !!props.planned);
    let foot;
    if (props.planned) {
      const checks = list(task.checks).length;
      foot = h(
        "span",
        { className: "roko-node-foot-text" },
        [task.role ? str(task.role) : null, checks ? plural(checks, "check", "checks") : "no checks"].filter(Boolean).join(" · ")
      );
    } else if (state === "running" && props.held) {
      foot = h("span", { className: "roko-node-foot-text roko-node-held" }, h(Icon, { name: "hand", size: 11 }), " waits on you");
    } else if (state === "running") {
      foot = h(
        "span",
        { className: "roko-node-foot-text roko-node-live" },
        h("span", { className: "roko-node-step" }, stepWords(view) || "running"),
        view.since ? h(Ticker, { since: view.since, until: props.clockAt, className: "roko-node-clock", prefix: " · " }) : null
      );
    } else if (state === "blocked") {
      foot = h("span", { className: "roko-node-foot-text" }, task.blocked_by ? "blocked by " + str(task.blocked_by) : "blocked");
    } else if (state === "pending") {
      foot = h("span", { className: "roko-node-foot-text" }, deps.length ? "after " + deps.join(", ") : "queued");
    } else {
      foot = h(
        "span",
        { className: "roko-node-foot-text" },
        [view.duration != null ? duration(view.duration) : null, isNum(task.cost_usd) && !props.replaying ? moneyFine(task.cost_usd) : null, view.model || task.model]
          .filter(Boolean)
          .join(" · ") || NODE_WORD[state]
      );
    }
    const glyph = NODE_GLYPH[state];
    const ch = props.planned ? "off" : props.held && state === "running" ? "you" : channelOf(state);
    const label = id + ", " + (NODE_WORD[state] || state) + (state === "running" && stepWords(view) ? ", " + stepWords(view) : "") + ": " + str(task.title);
    return h(
      "button",
      {
        type: "button",
        className:
          "roko-node rk-pad is-" + state + (props.held ? " is-held" : "") + (props.selected ? " is-selected" : "") + (props.dim ? " is-dim" : "") +
          (flash ? " rk-flash" : ""),
        style: { left: props.at.x + "px", top: props.at.y + "px", width: props.width + "px", height: props.height + "px" },
        "aria-label": label,
        "aria-pressed": props.selected ? "true" : "false",
        "data-roko-node": id,
        "data-state": state,
        "data-ch": ch,
        onClick: function () {
          sound.play("key", { user: true });
          if (props.onSelect) props.onSelect(id);
        },
      },
      h(
        "span",
        { className: "roko-node-head" },
        h("span", { className: "roko-node-id" }, id),
        view.attempts > 1 ? h("span", { className: "roko-node-attempts", title: view.attempts + " attempts" }, "×" + view.attempts) : null,
        h(
          "span",
          { className: "roko-node-glyph" },
          glyph && state !== "running" ? h(Icon, { name: glyph, size: 12, weight: 2, className: "rk-glyphmark" }) : null,
          props.planned ? null : h(LED, { ch: ch, blink: props.replaying ? false : undefined })
        )
      ),
      h("span", { className: "roko-node-title", title: str(task.title) }, str(task.title) || "—"),
      h("span", { className: "roko-node-foot" }, foot, props.planned ? null : h(Pips, { pips: view.pips }))
    );
  }

  const FINISHED = { passed: true, failed: true, blocked: true, stopped: true, warn: true };

  /** Where the run is: the first wave with a task left to finish, and how far through it. */
  function playheadAt(layout, viewOf) {
    for (let wi = 0; wi < layout.waves.length; wi += 1) {
      const wave = layout.waves[wi];
      const finished = wave.filter(function (id) { return FINISHED[viewOf(id).state]; }).length;
      if (finished < wave.length) {
        const started = wave.some(function (id) { return viewOf(id).state !== "pending"; });
        const x = GRAPH.pad + wi * (layout.nodeW + GRAPH.colGap);
        return { x: x + (started ? Math.max(0.1, finished / wave.length) : 0) * layout.nodeW, wave: wi, done: false };
      }
    }
    return { x: layout.width - GRAPH.pad / 2, wave: layout.waves.length, done: true };
  }

  /**
   * The run as a sequencer: one step per wave (numbered, with an LED), the tasks as pads, the
   * dependencies drawn under them, and a playhead at the frontier (or at the replay's moment).
   * `views` maps each task to how it looks now or then; `planned` draws a plan that has not run.
   */
  function RunGraph(props) {
    const ref = useRef(null);
    const width = useWidth(ref, 900);
    const tasks = list(props.tasks);
    const byId = {};
    tasks.forEach(function (t) { byId[str(t.task_id || t.id)] = t; });
    const layout = useMemo(function () { return layoutGraph(props.graph, width); }, [props.graph, width]);
    if (!layout.waves.length) {
      return h("div", { className: "roko-graph-empty roko-dim" }, props.planned ? "This plan has no tasks." : "No tasks yet.");
    }
    function viewOf(id) {
      if (props.views && props.views[id]) return props.views[id];
      return byId[id] && !props.planned ? taskView(byId[id]) : { state: "pending", pips: [], attempts: 0 };
    }
    const head = props.planned ? null : playheadAt(layout, viewOf);
    return h(
      "div",
      { className: "roko-graph-wrap", ref: ref },
      h(
        "div",
        {
          className: "roko-graph rk-seq" + (props.planned ? " is-planned" : "") + (props.replaying ? " is-replaying" : ""),
          style: { width: layout.width + "px", height: layout.height + "px" },
          "data-replay": props.replaying && isNum(props.clockAt) ? "+" + stopwatch(props.clockAt - props.replayStart) : undefined,
          role: "group",
          "aria-label": props.planned ? "The plan's tasks, wave by wave" : "The run's tasks, wave by wave",
        },
        layout.waves.map(function (wave, wi) {
          const x = GRAPH.pad + wi * (layout.nodeW + GRAPH.colGap);
          const stepCh = !head ? "off" : wi < head.wave ? "pass" : wi === head.wave ? (props.replaying ? "you" : "agent") : "off";
          return h(
            "div",
            {
              key: "w" + wi,
              className: "roko-graph-wave" + (head && wi === head.wave ? " is-now" : "") + (head && wi < head.wave ? " is-done" : ""),
              style: { left: x + "px", width: layout.nodeW + "px" },
              title: "wave " + (wi + 1),
            },
            h(LED, { ch: stepCh, blink: false }),
            h("span", { className: "roko-graph-wave-name" }, (wi + 1 < 10 ? "0" : "") + (wi + 1)),
            h("span", { className: "roko-graph-wave-count" }, wave.length > 1 ? wave.length + " in parallel" : "")
          );
        }),
        h(
          "svg",
          { className: "roko-graph-edges", width: layout.width, height: layout.height, "aria-hidden": "true" },
          layout.edges.map(function (e) {
            const st = props.planned ? "idle" : edgeState(viewOf(e.from), viewOf(e.to));
            return h(
              "g",
              { key: e.from + ">" + e.to, className: "roko-edge is-" + st },
              h("path", { d: e.d, className: "roko-edge-line" }),
              st === "flow" ? h("path", { d: e.d, className: "roko-edge-flow" }) : null
            );
          })
        ),
        head
          ? h("div", {
              className: "rk-playhead" + (head.done ? " is-done" : "") + (props.replaying ? " is-replay" : ""),
              style: { transform: "translateX(" + head.x.toFixed(1) + "px)", height: layout.height - GRAPH.head + "px", top: GRAPH.head + "px" },
              "aria-hidden": "true",
            })
          : null,
        layout.waves.map(function (wave) {
          return wave.map(function (id) {
            return h(GraphNode, {
              key: id,
              task: byId[id] || { task_id: id, title: "" },
              view: viewOf(id),
              at: layout.pos[id],
              width: layout.nodeW,
              height: layout.nodeH,
              planned: !!props.planned,
              replaying: !!props.replaying,
              clockAt: props.clockAt,
              held: !!(props.held && props.held[id]) && !props.replaying,
              selected: props.selected === id,
              dim: !!props.selected && props.selected !== id && !!props.dimOthers,
              onSelect: props.onSelect,
            });
          });
        })
      )
    );
  }

  // ---------------------------------------------------------------------------
  // The task inspector: one task's attempts, checks, and its agent's last word
  // ---------------------------------------------------------------------------

  function CheckRow(props) {
    const gate = props.gate;
    const [open, setOpen] = useState(!!props.open);
    const output = props.output || str(gate.excerpt);
    return h(
      "li",
      { className: "roko-checkrow " + (gate.passed ? "is-ok" : "is-bad") },
      h(
        "button",
        {
          type: "button",
          className: "roko-checkrow-head",
          "aria-expanded": open ? "true" : "false",
          onClick: function () { setOpen(!open); },
        },
        h(Icon, { name: gate.passed ? "check" : "x", size: 12, weight: 2, className: gate.passed ? "roko-tone-ok" : "roko-tone-bad" }),
        h("span", { className: "roko-mono roko-checkrow-name" }, str(gate.gate)),
        isNum(gate.runs) && gate.runs > 1 ? h("span", { className: "roko-checkrow-runs" }, "ran " + gate.runs + "×") : null,
        h("span", { className: "roko-checkrow-more" }, open ? "Hide output" : "Output"),
        h(Icon, { name: open ? "chevronDown" : "chevronRight", size: 12 })
      ),
      props.keyLine && !gate.passed ? h("div", { className: "roko-keyline" }, h("span", { className: "roko-keyline-mark" }, "›"), props.keyLine) : null,
      open ? h("pre", { className: "roko-pre roko-pre--output" }, output || "(no output recorded)") : null
    );
  }

  /** The router's pick for one attempt: where it came from, its odds, and the models it weighed. */
  function RouteLine(props) {
    const route = obj(props.route);
    if (!route) return null;
    const cands = list(route.candidates).filter(obj);
    const top = cands.reduce(function (m, c) { return isNum(c.score) ? Math.max(m, c.score) : m; }, 0) || 1;
    return h(
      "div",
      { className: "rk-route" },
      h(
        "div",
        { className: "rk-route-head" },
        h("span", { className: "rk-ringtag", "data-ch": "agent" }, "L1"),
        h("span", { className: "rk-route-src" }, str(route.source || route.stage) || "route"),
        isNum(route.p) ? h("span", { className: "rk-route-p roko-mono" }, "p " + route.p.toFixed(2)) : null,
        route.reason ? h("span", { className: "rk-route-why" }, oneLine(route.reason, 140)) : null
      ),
      cands.length
        ? h(
            "ol",
            { className: "rk-cands", "aria-label": "models the router weighed" },
            cands.slice(0, 6).map(function (c, i) {
              const picked = str(c.model) === str(route.model);
              const w = isNum(c.score) ? Math.max(0.04, c.score / top) : 0.04;
              return h(
                "li",
                {
                  key: str(c.model) + i,
                  className: "rk-cand" + (picked ? " is-picked" : "") + (c.eligible === false ? " is-out" : ""),
                  title: c.eligible === false && c.ineligible_reason ? str(c.ineligible_reason) : undefined,
                },
                h("span", { className: "rk-cand-model roko-mono" }, str(c.model) || "?"),
                h("span", { className: "rk-cand-bar", "aria-hidden": "true" }, h("span", { style: { width: (w * 100).toFixed(1) + "%" } })),
                h("span", { className: "rk-cand-score roko-mono" }, isNum(c.score) ? c.score.toFixed(2) : "—"),
                h("span", { className: "rk-cand-note" }, picked ? "picked" : c.eligible === false ? "out: " + oneLine(c.ineligible_reason, 60) : isNum(c.p) ? "p " + c.p.toFixed(2) : "")
              );
            })
          )
        : null
    );
  }

  /** A task's last tool steps: the card's, joined by what the socket brought since. */
  function StepList(props) {
    const runId = props.runId;
    const task = props.task;
    useLiveVersion(runId, ["live"]);
    const id = str(task.task_id);
    const seen = {};
    const steps = [];
    list(task.steps).forEach(function (s) {
      const at = ms(s.ts);
      const key = str(s.tool) + "|" + str(s.target);
      seen[key + "|" + Math.round(at / 1000)] = true;
      steps.push({ at: at, tool: str(s.tool), target: str(s.target) });
    });
    const live = liveStore.live(runId);
    list(live && live.recent).forEach(function (f) {
      if (str(f.task_id) !== id || f.kind !== "tool") return;
      const key = str(f.tool) + "|" + str(f.target) + "|" + Math.round(f.ts / 1000);
      if (seen[key]) return;
      seen[key] = true;
      steps.push({ at: f.ts, tool: str(f.tool), target: str(f.target), fresh: true });
    });
    steps.sort(function (a, b) { return (a.at || 0) - (b.at || 0); });
    const shown = steps.slice(-8);
    if (!shown.length && !task.live_text) return null;
    return h(
      "div",
      { className: "roko-inspector-sec" },
      h(Label, null, h("span", { className: "rk-ringtag", "data-ch": "agent" }, "L0"), " Tool steps"),
      shown.length
        ? h(
            "ol",
            { className: "rk-steps" },
            shown.map(function (s, i) {
              return h(
                "li",
                { key: i + s.tool + s.at, className: "rk-step" + (i === shown.length - 1 && props.running ? " is-last" : "") },
                h("span", { className: "rk-step-at roko-mono" }, isFinite(s.at) ? wallClock(s.at) : ""),
                h("span", { className: "rk-step-tool" }, s.tool || "?"),
                h("span", { className: "rk-step-target roko-mono", title: s.target }, s.target)
              );
            })
          )
        : null,
      task.live_text ? h("blockquote", { className: "roko-quote rk-livetext" }, oneLine(task.live_text, 600)) : null
    );
  }

  function TaskInspector(props) {
    const task = props.task;
    const view = props.view;
    if (!task) return null;
    const why = obj(props.why);
    const notPassed = why ? list(why.gates_not_passed).filter(function (g) { return str(g.task_id) === str(task.task_id); }) : [];
    const attempts = list(task.attempt_log);
    const gates = list(task.gates);
    const state = view ? view.state : nodeState(task.outcome);
    const ch = channelOf(state);
    const hold = obj(task.hold);
    const effects = list(task.effects).filter(obj);
    const lessons = list(task.lessons).filter(obj);
    return h(
      "aside",
      { className: "roko-inspector", "aria-label": "Task " + str(task.task_id), "data-roko-inspector": str(task.task_id), "data-ch": ch },
      h(
        "div",
        { className: "roko-inspector-head" },
        h(LED, { ch: ch }),
        h("span", { className: "roko-inspector-id" }, str(task.task_id)),
        h("span", { className: "rk-state", "data-ch": ch }, NODE_WORD[state] || state),
        h("span", { className: "roko-flex" }),
        props.onClose
          ? h("button", { type: "button", className: "roko-iconbtn", "aria-label": "Close the task", onClick: props.onClose }, h(Icon, { name: "x", size: 13 }))
          : null
      ),
      h("div", { className: "roko-inspector-title" }, str(task.title) || "—"),
      h(
        "div",
        { className: "roko-facts" },
        h(Fact, { k: "time" }, state === "running" && task.started_at ? h(Ticker, { since: task.started_at }) : isNum(task.duration_ms) ? duration(task.duration_ms) : "—"),
        h(Fact, { k: "cost" }, moneyFine(task.cost_usd)),
        h(Fact, { k: "model", title: task.provider ? "through " + str(task.provider) : undefined }, task.model ? str(task.model) : "—"),
        h(Fact, { k: "attempts" }, String(isNum(task.attempts) ? task.attempts : 0))
      ),
      hold && hold.state === "waiting"
        ? h(
            "div",
            { className: "rk-hold", "data-ch": "you" },
            h("div", { className: "rk-hold-head" }, h(LED, { ch: "you" }), h("span", null, "waits for your sign-off" + (hold.rung ? " · " + str(hold.rung) : "")), hold.deadline_at ? h(Countdown, { until: hold.deadline_at, size: "S" }) : null),
            hold.question ? h("div", { className: "rk-hold-q" }, str(hold.question)) : null
          )
        : hold && hold.state === "resolved"
          ? h("div", { className: "roko-inspector-reason" }, h(Icon, { name: "check", size: 12 }), "sign-off " + str(hold.outcome || "answered") + (hold.note ? ": " + oneLine(hold.note, 160) : ""))
          : null,
      state === "running" && view && view.step
        ? h("div", { className: "roko-inspector-now" }, h(LED, { ch: hold && hold.state === "waiting" ? "you" : "agent" }), stepWords(view), view.since ? h(Ticker, { since: view.since, prefix: " · " }) : null)
        : null,
      task.reason ? h("div", { className: "roko-inspector-reason" }, h(Icon, { name: "info", size: 12 }), str(task.reason)) : null,
      props.replaying ? null : h(StepList, { runId: props.runId, task: task, running: state === "running" }),
      attempts.length
        ? h(
            "div",
            { className: "roko-inspector-sec" },
            h(Label, null, h("span", { className: "rk-ringtag", "data-ch": "agent" }, "L1"), attempts.length > 1 ? " " + attempts.length + " attempts" : " Attempt"),
            h(
              "ol",
              { className: "roko-attempts" },
              attempts.map(function (a, i) {
                const gs = list(a.gates);
                const ok = gs.length && gs.every(function (g) { return g.passed; });
                return h(
                  "li",
                  { key: i, className: "roko-attempt" + (ok ? " is-ok" : gs.length ? " is-bad" : "") },
                  h(
                    "div",
                    { className: "roko-attempt-row" },
                    h("span", { className: "roko-attempt-n" }, "#" + str(a.attempt || i + 1)),
                    h("span", { className: "roko-attempt-model roko-mono" }, str(a.model) || "?"),
                    a.started_at ? h("span", { className: "roko-attempt-at" }, wallClock(ms(a.started_at))) : null,
                    h(
                      "span",
                      { className: "roko-attempt-gates" },
                      gs.length
                        ? gs.map(function (g, gi) { return h("span", { key: gi, className: "roko-attempt-gate " + (g.passed ? "is-ok" : "is-bad"), title: str(g.gate) }, (g.passed ? "✓ " : "✗ ") + str(g.gate)); })
                        : h("span", { className: "roko-dim" }, i === attempts.length - 1 && state === "running" ? "working…" : "no checks ran")
                    )
                  ),
                  h(RouteLine, { route: a.route })
                );
              })
            )
          )
        : null,
      gates.length
        ? h(
            "div",
            { className: "roko-inspector-sec" },
            h(Label, null, "Checks"),
            h(
              "ul",
              { className: "roko-checklist2" },
              gates.map(function (g, i) {
                const miss = notPassed.filter(function (n) { return str(n.gate) === str(g.gate); })[0];
                return h(CheckRow, { key: str(g.gate) + i, gate: g, keyLine: miss ? str(miss.key_line) : null, output: miss ? str(miss.output) : null, open: !!miss });
              })
            )
          )
        : null,
      effects.length
        ? h(
            "div",
            { className: "roko-inspector-sec" },
            h(Label, null, h("span", { className: "rk-ringtag", "data-ch": "you" }, "L0"), " Held actions"),
            h(
              "ul",
              { className: "rk-effects" },
              effects.map(function (e, i) {
                const held = e.state === "held";
                const ech = held ? "you" : e.outcome === "applied" || e.outcome === "approved" ? "pass" : "fail";
                return h(
                  "li",
                  { key: str(e.effect_id) || i, className: "rk-effect" },
                  h(LED, { ch: ech, blink: held ? undefined : false }),
                  h("span", { className: "roko-mono" }, str(e.tool) + (e.server ? " on " + str(e.server) : "")),
                  h("span", { className: "roko-dim" }, held ? "held for you" : str(e.outcome || "decided"))
                );
              })
            )
          )
        : null,
      lessons.length
        ? h(
            "div",
            { className: "roko-inspector-sec" },
            h(Label, null, h("span", { className: "rk-ringtag", "data-ch": "pass" }, "L3"), " What roko learned"),
            h(
              "ul",
              { className: "rk-lessons" },
              lessons.map(function (l, i) {
                return h(
                  "li",
                  { key: str(l.entry_id) || i, className: "rk-lesson" },
                  h("span", { className: "rk-lesson-text" }, oneLine(l.lesson, 300)),
                  h(
                    "span",
                    { className: "rk-lesson-meta roko-dim" },
                    [str(l.admission).replace(/_/g, " "), isNum(l.reinforced) && l.reinforced > 0 ? "reinforced " + l.reinforced : null, isNum(l.promoted) && l.promoted > 0 ? "promoted" : null].filter(Boolean).join(" · ")
                  )
                );
              })
            )
          )
        : null,
      task.note
        ? h(
            "div",
            { className: "roko-inspector-sec roko-inspector-sec--note" },
            h(Label, null, "The agent's last word"),
            h("blockquote", { className: "roko-quote" }, h(LongText, { value: task.note, limit: 360, lines: 6, prose: true }))
          )
        : null
    );
  }

  function Fact(props) {
    return h("div", { className: "roko-fact", title: props.title }, h("span", { className: "roko-fact-k" }, props.k), h("span", { className: "roko-fact-v" }, props.children));
  }

  // ---------------------------------------------------------------------------
  // The activity feed
  // ---------------------------------------------------------------------------

  function isProblem(ev) {
    return ev.group === "error" || ev.type === "task_blocked" || (ev.type === "gate_result" && ev.passed === false) ||
      (ev.type === "task_completed" && ev.outcome && ev.outcome !== "passed" && ev.outcome !== "skipped");
  }
  const FEED_FILTERS = [
    { id: "all", label: "All", test: function () { return true; } },
    { id: "agent", label: "Agents", icon: "agent", test: function (ev) { return ev.group === "agent"; } },
    { id: "tool", label: "Tool steps", icon: "bolt", test: function (ev) { return ev.group === "tool"; } },
    { id: "gate", label: "Checks", icon: "gate", test: function (ev) { return ev.group === "gate"; } },
    { id: "loop", label: "Loops", icon: "refresh", test: function (ev) { return ev.group === "loop"; } },
    { id: "problems", label: "Problems", icon: "error", test: isProblem },
  ];

  const CH_TONE = { agent: "run", pass: "ok", you: "warn", fail: "bad", off: "muted" };
  /** A timeline line's channel: loop lines by their kind, tool steps are an agent at work. */
  function lineChannel(ev) {
    if (ev.group === "loop") return loopChannel({ kind: ev.loop, data: ev });
    if (ev.group === "tool") return "agent";
    return null;
  }

  function eventTone(ev) {
    if (isProblem(ev)) return "bad";
    if (lineChannel(ev)) return CH_TONE[lineChannel(ev)];
    if (ev.type === "gate_result" || ev.type === "task_completed" || ev.type === "plan_completed" || ev.type === "run_completed") return "ok";
    if (ev.group === "agent") return "run";
    return "muted";
  }

  function FeedLine(props) {
    const ev = props.ev;
    const text = str(ev.text) || str(ev.type);
    const task = ev.task_id ? str(ev.task_id) : "";
    let rest = text;
    if (task && text.indexOf(task + " ") === 0) rest = text.slice(task.length + 1);
    const quote = ev.type === "agent_output" && rest.indexOf("agent: ") === 0;
    const at = isNum(ev.ts_millis) && isNum(props.start) ? "+" + stopwatch(Math.max(0, ev.ts_millis - props.start)) : "";
    return h(
      "li",
      {
        className: "roko-feedline roko-feedgroup-" + str(ev.group || "run") + " roko-tone-line-" + eventTone(ev) + (props.current ? " is-current" : "") + (props.future ? " is-future" : ""),
        "data-roko-event": str(ev.type),
      },
      h("span", { className: "roko-feed-at", title: isNum(ev.ts_millis) ? wallClock(ev.ts_millis) : undefined }, at),
      h("span", { className: "roko-feed-icon roko-tone-" + eventTone(ev) }, h(Icon, { name: GROUP_ICON[ev.group] || "run", size: 12 })),
      h(
        "span",
        { className: "roko-feed-text" },
        ev.ring ? h("span", { className: "rk-ringtag", "data-ch": lineChannel(ev) || "agent" }, str(ev.ring)) : null,
        task ? h("span", { className: "roko-feed-task" }, task) : null,
        quote ? h("span", { className: "roko-feed-quote" }, "“" + rest.slice(7) + "”") : h("span", null, rest)
      )
    );
  }

  function Feed(props) {
    const events = list(props.events);
    const [filter, setFilter] = useState("all");
    const boxRef = useRef(null);
    const pinned = useRef(true);
    const [unseen, setUnseen] = useState(0);
    const lastCount = useRef(0);
    const test = (FEED_FILTERS.filter(function (f) { return f.id === filter; })[0] || FEED_FILTERS[0]).test;
    const shown = events.filter(test);
    const countOf = function (f) { return events.filter(f.test).length; };

    useLayoutEffectSafe(function () {
      const box = boxRef.current;
      if (!box) return;
      const added = shown.length - lastCount.current;
      lastCount.current = shown.length;
      if (props.replayAt != null) return;
      if (pinned.current) {
        box.scrollTop = box.scrollHeight;
        setUnseen(0);
      } else if (added > 0) {
        setUnseen(function (n) { return n + added; });
      }
    }, [shown.length, props.replayAt]);

    useEffect(function () {
      const box = boxRef.current;
      if (!box || props.replayAt == null) return;
      const current = box.querySelector(".is-current");
      if (current && typeof current.scrollIntoView === "function") {
        try { current.scrollIntoView({ block: "nearest" }); } catch (_) { /* old engines */ }
      }
    }, [props.replayAt]);

    let currentIndex = -1;
    if (props.replayAt != null) {
      shown.forEach(function (ev, i) { if (isNum(ev.ts_millis) && ev.ts_millis <= props.replayAt) currentIndex = i; });
    }

    return h(
      "div",
      { className: "roko-feed" + (props.compact ? " roko-feed--compact" : "") },
      props.compact
        ? null
        : h(
            "div",
            { className: "roko-feed-bar" },
            h(Chips, {
              label: "Show",
              value: filter,
              onChange: setFilter,
              items: FEED_FILTERS.map(function (f) { return { id: f.id, label: f.label, icon: f.icon, count: countOf(f), tone: f.id === "problems" && countOf(f) ? "bad" : null }; }),
            }),
            props.live ? h("span", { className: "roko-feed-live" }, h(LED, { ch: "agent" }), "live") : null
          ),
      h(
        "div",
        {
          className: "roko-feed-box",
          ref: boxRef,
          onScroll: function (event) {
            const box = event.currentTarget;
            pinned.current = box.scrollHeight - box.scrollTop - box.clientHeight < 28;
            if (pinned.current) setUnseen(0);
          },
        },
        !props.loaded && !props.error ? h(Skeleton, { rows: 5 }) : null,
        props.error ? h(ErrorNote, { error: props.error, compact: true }) : null,
        props.loaded && !shown.length && !props.error
          ? h("div", { className: "roko-feed-empty roko-dim" }, events.length ? "Nothing of this kind yet." : "No events recorded yet.")
          : null,
        shown.length
          ? h(
              "ol",
              { className: "roko-feedlist", "aria-live": props.live ? "polite" : undefined, "aria-relevant": "additions" },
              shown.map(function (ev, i) {
                return h(FeedLine, {
                  key: ev.cursor != null ? "c" + ev.cursor : "i" + i,
                  ev: ev,
                  start: props.start,
                  current: i === currentIndex,
                  future: props.replayAt != null && isNum(ev.ts_millis) && ev.ts_millis > props.replayAt,
                });
              })
            )
          : null
      ),
      unseen > 0
        ? h(
            "button",
            {
              type: "button",
              className: "roko-feed-jump",
              onClick: function () {
                const box = boxRef.current;
                if (box) box.scrollTop = box.scrollHeight;
                pinned.current = true;
                setUnseen(0);
              },
            },
            unseen + " new ↓"
          )
        : null
    );
  }

  // ---------------------------------------------------------------------------
  // Replay: scrub a finished run's timeline and watch the graph move again
  // ---------------------------------------------------------------------------

  function ReplayBar(props) {
    const events = props.events.filter(function (e) { return isNum(e.ts_millis); });
    const start = props.start;
    const end = props.end;
    const span = Math.max(1, end - start);
    const t = props.t == null ? end : props.t;
    const [playing, setPlaying] = useState(false);
    const tRef = useRef(t);
    tRef.current = t;
    const onChange = props.onChange;

    useEffect(function () {
      if (!playing) return undefined;
      const reduced = prefersReducedMotion();
      const marks = events.map(function (e) { return e.ts_millis; });
      let frame = null;
      let stepTimer = null;
      let last = null;
      const rate = span / (REPLAY_SECONDS * 1000);
      // The position lives here while playing: a render may not have caught up with the last frame.
      let pos = tRef.current == null || tRef.current >= end ? start : tRef.current;
      onChange(pos);
      function frameTick(now) {
        if (last == null) {
          last = now;
          frame = window.requestAnimationFrame(frameTick);
          return;
        }
        pos = Math.min(end, pos + (now - last) * rate);
        last = now;
        onChange(pos);
        if (pos >= end) {
          setPlaying(false);
          return;
        }
        frame = window.requestAnimationFrame(frameTick);
      }
      function step() {
        const next = marks.filter(function (m) { return m > pos; })[0];
        if (next == null) {
          onChange(end);
          setPlaying(false);
          return;
        }
        pos = next;
        onChange(pos);
        stepTimer = setTimeout(step, 450);
      }
      if (reduced || typeof window.requestAnimationFrame !== "function") step();
      else frame = window.requestAnimationFrame(frameTick);
      return function () {
        if (frame && typeof window.cancelAnimationFrame === "function") window.cancelAnimationFrame(frame);
        clearTimeout(stepTimer);
      };
    }, [playing]);

    const fraction = clamp((t - start) / span, 0, 1);
    return h(
      "div",
      { className: "roko-replay" + (props.t != null ? " is-on" : ""), "data-roko": "replay" },
      h(
        "button",
        {
          type: "button",
          className: "roko-replay-play",
          "aria-label": playing ? "Pause the replay" : "Replay the run",
          onClick: function () { setPlaying(!playing); },
        },
        h(Icon, { name: playing ? "pause" : props.t == null ? "replay" : "play", size: 14 })
      ),
      h(
        "div",
        { className: "roko-replay-track" },
        h(
          "div",
          { className: "roko-replay-ticks", "aria-hidden": "true" },
          events.map(function (e, i) {
            return h("span", {
              key: i,
              className: "roko-replay-tick roko-tick-" + str(e.group || "run") + (isProblem(e) ? " is-bad" : ""),
              style: { left: (clamp((e.ts_millis - start) / span, 0, 1) * 100).toFixed(2) + "%" },
            });
          })
        ),
        h("div", { className: "roko-replay-fill", style: { width: (fraction * 100).toFixed(2) + "%" } }),
        h("input", {
          type: "range",
          className: "roko-replay-range",
          min: 0,
          max: 1000,
          step: 1,
          value: Math.round(fraction * 1000),
          "aria-label": "Replay position",
          "aria-valuetext": "+" + stopwatch(t - start) + " of " + stopwatch(span),
          onChange: function (event) {
            setPlaying(false);
            onChange(start + (Number(event.target.value) / 1000) * span);
          },
        })
      ),
      h("span", { className: "roko-replay-time" }, "+" + stopwatch(t - start), h("span", { className: "roko-dim" }, " / " + stopwatch(span))),
      props.t != null
        ? h(
            "button",
            { type: "button", className: "roko-linkbtn roko-replay-exit", onClick: function () { setPlaying(false); onChange(null); } },
            "Show the end"
          )
        : null
    );
  }

  // ---------------------------------------------------------------------------
  // The now strip and the why callout
  // ---------------------------------------------------------------------------

  /** What a running task's agent did last: the socket's newest frame, else the card's last tool step. */
  function tickerStep(task, frame, now) {
    const since = ms(task.step_since || task.started_at);
    if (frame && frame.kind !== "beat" && now - frame.seen_at < 90000) {
      if (frame.kind === "tool") return { key: "f" + frame.ts, text: "▸ " + str(frame.tool) + (frame.target ? " " + oneLine(frame.target, 80) : "") };
      if (frame.kind === "text" || frame.kind === "reasoning") return { key: "w" + str(frame.stretch), text: "“" + oneLineEnd(frame.said || frame.text, 120) + "”", words: true };
      if (frame.kind === "result") return { key: "f" + frame.ts, text: "◂ " + oneLine(frame.text || frame.tool, 100) };
    }
    const steps = list(task.steps);
    const last = steps.length ? steps[steps.length - 1] : null;
    if (last && (!isFinite(since) || ms(last.ts) >= since - 1000)) {
      return { key: "s" + str(last.ts), text: "▸ " + str(last.tool) + (last.target ? " " + oneLine(last.target, 80) : "") };
    }
    if (task.live_text) return { key: "t" + str(task.live_text).length, text: "“" + oneLine(task.live_text, 120) + "”" };
    return null;
  }

  /**
   * The ticker: what each running task's agent is doing this second, on the display glass. Tool steps
   * arrive over the live socket; without it, the card's last steps stand in.
   */
  function NowStrip(props) {
    const run = props.run || {};
    const runId = str(run.run_id);
    const busy = list(props.tasks).filter(function (t) { return t.outcome === "running"; });
    useLiveVersion(runId, ["live"]);
    const now = useTick(busy.length > 0);
    if (!busy.length) return null;
    const live = liveStore.live(runId);
    return h(
      "div",
      { className: "rk-ticker roko-now", role: "status", "aria-label": "What runs now", "data-roko": "ticker" },
      h(
        "span",
        { className: "roko-now-label", "data-ch": busy.some(function (t) { return props.held && props.held[str(t.task_id)]; }) ? "you" : undefined },
        h(LED, { ch: busy.some(function (t) { return props.held && props.held[str(t.task_id)]; }) ? "you" : "agent" }),
        "now"
      ),
      h(
        "div",
        { className: "rk-ticker-items" },
        busy.slice(0, 4).map(function (task) {
          const id = str(task.task_id);
          const view = taskView(task);
          const held = props.held && props.held[id];
          const step = held ? null : tickerStep(task, live && live.byTask[id], now);
          return h(
            "button",
            {
              key: id,
              type: "button",
              className: "roko-now-item" + (held ? " is-held" : ""),
              onClick: function () { if (props.onSelect) props.onSelect(id); },
            },
            h("span", { className: "roko-now-id" }, id),
            h("span", { className: "roko-now-what" }, held ? (held === "effect" ? "holds an action for your approval" : "waits for your sign-off") : stepWords(view) || "working"),
            !held && view.since ? h(Ticker, { since: view.since, className: "roko-now-clock" }) : null,
            // Words keep their newest end in view: a long line is cut on the left, never the right.
            step ? h("span", { key: step.key, className: "rk-ticker-step" + (step.words ? " is-words" : "") }, step.words ? h("span", null, step.text) : step.text) : null
          );
        }),
        busy.length > 4 ? h("span", { className: "rk-ticker-more" }, "+" + (busy.length - 4) + " more") : null
      )
    );
  }

  function WhyCallout(props) {
    const run = props.run;
    const why = obj(run.why);
    const problems = list(run.problems);
    let summary = why ? str(why.summary) : "";
    if (!summary && run.state === "missing" && problems.length) summary = str(problems[0]);
    if (!summary && run.kind === "plan_generate" && run.planner_error) summary = str(run.planner_error);
    if (!summary) return null;
    const tone = run.state === "failed" || run.kind === "plan_generate" ? "bad" : "warn";
    const keyLines = why ? list(why.gates_not_passed).filter(function (g) { return g.key_line; }).slice(0, 3) : [];
    const title = run.state === "cancelled" ? "Why it stopped" : run.state === "unverified" ? "Why it is unverified" : run.state === "missing" ? "Where this run went" : "Why it did not pass";
    return h(
      "div",
      { className: "roko-why roko-why--" + tone, role: "note", "data-roko": "why" },
      h("div", { className: "roko-why-icon" }, h(Icon, { name: run.state === "cancelled" ? "stop" : "error", size: 16 })),
      h(
        "div",
        { className: "roko-why-body" },
        h("div", { className: "roko-why-title" }, title),
        h("div", { className: "roko-why-text" }, summary),
        keyLines.length
          ? h(
              "ul",
              { className: "roko-why-lines" },
              keyLines.map(function (g, i) {
                return h(
                  "li",
                  { key: i },
                  h(
                    "button",
                    { type: "button", className: "roko-why-task", onClick: function () { if (props.onSelect) props.onSelect(str(g.task_id)); } },
                    str(g.task_id) + " · " + str(g.gate)
                  ),
                  h("code", { className: "roko-why-key" }, str(g.key_line))
                );
              })
            )
          : null
      )
    );
  }

  // ---------------------------------------------------------------------------
  // Diff lines, tinted: a small tokenizer that only ever splits text into spans
  // ---------------------------------------------------------------------------

  const KEYWORDS = {
    python: "False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield self cls",
    javascript: "async await break case catch class const continue default delete do else export extends false finally for from function if import in instanceof let new null of return static super switch this throw true try typeof undefined var void while yield",
    typescript: "async await break case catch class const continue default delete do else enum export extends false finally for from function if implements import in instanceof interface let new null of private protected public readonly return static super switch this throw true try type typeof undefined var void while yield",
    rust: "as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while",
    go: "break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var nil true false",
    shell: "if then else elif fi for do done case esac while until function in export local return",
    toml: "true false",
    yaml: "true false null yes no",
    json: "true false null",
    sql: "select from where and or not insert into values update set delete create table index join left right inner outer on group by order limit as null",
  };
  const KEYWORD_SETS = {};
  Object.keys(KEYWORDS).forEach(function (lang) {
    const set = new Set();
    KEYWORDS[lang].split(" ").forEach(function (w) { set.add(w); });
    KEYWORD_SETS[lang] = set;
  });
  const HASH_COMMENT = { python: true, shell: true, toml: true, yaml: true };
  const SLASH_COMMENT = { javascript: true, typescript: true, rust: true, go: true, css: true };
  const TOKEN_RE = /("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|`(?:[^`\\]|\\.)*`?)|(\b\d[\d_.]*[a-z]*\b)|(@?[A-Za-z_][A-Za-z0-9_]*)|(\s+)|([^\sA-Za-z0-9_"'`]+)/g;

  /** `text` as [[class, piece], …]; the pieces put back together are exactly `text`. */
  function tint(text, lang) {
    const out = [];
    if (!lang || text.length > 600) return [["", text]];
    if (lang === "markdown") {
      if (/^\s{0,3}#{1,6}\s/.test(text)) return [["roko-tk-head", text]];
      const parts = text.split(/(`[^`]*`)/);
      return parts.filter(function (p) { return p !== ""; }).map(function (p) { return [p.charAt(0) === "`" ? "roko-tk-str" : "", p]; });
    }
    let commentAt = -1;
    if (HASH_COMMENT[lang]) commentAt = findComment(text, "#");
    else if (SLASH_COMMENT[lang]) commentAt = findComment(text, "//");
    else if (lang === "sql") commentAt = findComment(text, "--");
    const code = commentAt >= 0 ? text.slice(0, commentAt) : text;
    const words = KEYWORD_SETS[lang] || null;
    TOKEN_RE.lastIndex = 0;
    let m;
    while ((m = TOKEN_RE.exec(code)) !== null) {
      if (m[0] === "") { TOKEN_RE.lastIndex += 1; continue; }
      let cls = "";
      if (m[1]) cls = "roko-tk-str";
      else if (m[2]) cls = "roko-tk-num";
      else if (m[3]) {
        const w = m[3];
        const next = code.charAt(TOKEN_RE.lastIndex);
        if (w.charAt(0) === "@") cls = "roko-tk-deco";
        else if (words && words.has(lang === "sql" ? w.toLowerCase() : w)) cls = "roko-tk-kw";
        else if (next === "(") cls = "roko-tk-fn";
        else if (/^[A-Z][A-Za-z0-9_]*[a-z]/.test(w)) cls = "roko-tk-type";
      }
      const last = out[out.length - 1];
      if (last && last[0] === cls) last[1] += m[0];
      else out.push([cls, m[0]]);
    }
    if (commentAt >= 0) out.push(["roko-tk-com", text.slice(commentAt)]);
    return out.length ? out : [["", text]];
  }
  /** Where a line comment starts, outside quotes, or -1. */
  function findComment(text, marker) {
    let quote = null;
    for (let i = 0; i < text.length; i += 1) {
      const ch = text.charAt(i);
      if (quote) {
        if (ch === "\\") i += 1;
        else if (ch === quote) quote = null;
      } else if (ch === "\"" || ch === "'" || ch === "`") {
        quote = ch;
      } else if (text.substr(i, marker.length) === marker) {
        if (marker === "#" && i > 0 && /[A-Za-z0-9_]/.test(text.charAt(i - 1))) continue;
        return i;
      }
    }
    return -1;
  }

  // ---------------------------------------------------------------------------
  // Changes: the run's diff, file by file, and the guarded Merge
  // ---------------------------------------------------------------------------

  const STATUS_LETTER = { added: "A", deleted: "D", modified: "M", renamed: "R", copied: "C" };

  function splitPath(path) {
    const p = str(path);
    const cut = p.lastIndexOf("/");
    return cut >= 0 ? [p.slice(0, cut + 1), p.slice(cut + 1)] : ["", p];
  }

  function DiffBar(props) {
    const add = props.add || 0;
    const del = props.del || 0;
    const total = add + del;
    const cells = [];
    const addCells = total ? Math.round((add / total) * 5) : 0;
    for (let i = 0; i < 5; i += 1) {
      const cls = !total ? "" : i < addCells ? " is-add" : " is-del";
      cells.push(h("span", { key: i, className: "roko-diffbar-cell" + cls }));
    }
    return h("span", { className: "roko-diffbar", "aria-hidden": "true" }, cells);
  }

  function DiffLine(props) {
    const line = props.line;
    const tag = str(line[0]);
    const kind = tag === "+" ? "add" : tag === "-" ? "del" : tag === "\\" ? "note" : "ctx";
    const text = str(line[3]);
    return h(
      "div",
      { className: "roko-dl roko-dl--" + kind },
      h("span", { className: "roko-dl-no" }, line[1] == null ? "" : String(line[1])),
      h("span", { className: "roko-dl-no" }, line[2] == null ? "" : String(line[2])),
      h("span", { className: "roko-dl-sign", "aria-hidden": "true" }, kind === "add" ? "+" : kind === "del" ? "−" : ""),
      h(
        "span",
        { className: "roko-dl-code" },
        kind === "note"
          ? text
          : tint(text, props.lang).map(function (piece, i) {
              return piece[0] ? h("span", { key: i, className: piece[0] }, piece[1]) : piece[1];
            })
      )
    );
  }

  function DiffFile(props) {
    const file = props.file;
    const [open, setOpen] = useState(props.open);
    const parts = splitPath(file.path);
    const letter = STATUS_LETTER[file.status] || "M";
    const hunks = list(file.hunks);
    return h(
      "section",
      { className: "roko-dfile", id: props.anchor, "data-roko-file": str(file.path) },
      h(
        "div",
        { className: "roko-dfile-head" },
        h(
          "button",
          { type: "button", className: "roko-dfile-toggle", "aria-expanded": open ? "true" : "false", onClick: function () { setOpen(!open); } },
          h(Icon, { name: open ? "chevronDown" : "chevronRight", size: 12 }),
          h("span", { className: "roko-status-letter roko-status-" + letter }, letter),
          h("span", { className: "roko-dfile-path" }, h("span", { className: "roko-dim" }, parts[0]), parts[1]),
          file.old_path ? h("span", { className: "roko-dim roko-dfile-old" }, "from " + str(file.old_path)) : null
        ),
        h("span", { className: "roko-dfile-counts" }, h("span", { className: "roko-add" }, "+" + (file.additions || 0)), h("span", { className: "roko-del" }, "−" + (file.deletions || 0))),
        h(CopyButton, { value: file.path, what: "path", compact: true })
      ),
      open
        ? h(
            "div",
            { className: "roko-dfile-body" },
            file.binary ? h("div", { className: "roko-dnote" }, "A binary file: roko does not show its contents.") : null,
            !file.binary && !hunks.length
              ? h("div", { className: "roko-dnote" }, file.truncated ? "This file's patch is too large to show here; review it with git." : "No line changes (a rename or a mode change).")
              : null,
            hunks.map(function (hunk, hi) {
              return h(
                "div",
                { key: hi, className: "roko-hunk" },
                h(
                  "div",
                  { className: "roko-hunk-head" },
                  h("span", { className: "roko-hunk-range" }, str(hunk.header).replace(/ @@.*$/, " @@")),
                  hunk.context ? h("span", { className: "roko-hunk-ctx" }, str(hunk.context)) : null
                ),
                h(
                  "div",
                  { className: "roko-hunk-lines" },
                  list(hunk.lines).map(function (line, li) { return h(DiffLine, { key: li, line: line, lang: file.language }); })
                )
              );
            }),
            file.truncated && hunks.length ? h("div", { className: "roko-dnote" }, "The rest of this file's patch was cut short; review it with git.") : null
          )
        : null
    );
  }

  function DiffView(props) {
    const diff = props.diff;
    const files = list(diff.files);
    const totals = obj(diff.totals) || {};
    const lines = files.reduce(function (n, f) { return n + (f.additions || 0) + (f.deletions || 0); }, 0);
    const openAll = lines <= 1600;
    const base = "roko-file-" + shortId(diff.run_id) + "-";
    return h(
      "div",
      { className: "roko-diff", "data-roko": "diff" },
      h(
        "div",
        { className: "roko-diff-files", role: "list", "aria-label": "Changed files" },
        h(Label, null, plural(isNum(totals.files) ? totals.files : files.length, "file", "files")),
        files.map(function (f, i) {
          const parts = splitPath(f.path);
          const letter = STATUS_LETTER[f.status] || "M";
          return h(
            "button",
            {
              key: str(f.path),
              type: "button",
              role: "listitem",
              className: "roko-diff-fileitem",
              title: str(f.path),
              onClick: function () {
                const el = document.getElementById(base + i);
                if (el && typeof el.scrollIntoView === "function") {
                  try { el.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" }); } catch (_) { el.scrollIntoView(); }
                }
              },
            },
            h("span", { className: "roko-status-letter roko-status-" + letter }, letter),
            h("span", { className: "roko-diff-fileitem-path" }, h("span", { className: "roko-diff-base" }, parts[1]), parts[0] ? h("span", { className: "roko-diff-dir" }, parts[0]) : null),
            h("span", { className: "roko-diff-fileitem-n" }, h("span", { className: "roko-add" }, "+" + (f.additions || 0)), h("span", { className: "roko-del" }, "−" + (f.deletions || 0))),
            h(DiffBar, { add: f.additions, del: f.deletions })
          );
        }),
        diff.truncated ? h("div", { className: "roko-dim roko-diff-more" }, "More files changed than are shown here.") : null
      ),
      h(
        "div",
        { className: "roko-diff-main" },
        files.map(function (f, i) {
          return h(DiffFile, { key: str(f.path), file: f, anchor: base + i, open: openAll || i < 6 });
        })
      )
    );
  }

  /** Whether Merge would work, and the dialog that does it. */
  function MergeBox(props) {
    const run = props.run;
    const diff = props.diff;
    const canAct = useLimits().canAct;
    const [check, setCheck] = useState({ status: "loading", data: null, error: null });
    const [nonce, setNonce] = useState(0);
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const [done, setDone] = useState(null);

    useEffect(function () {
      let alive = true;
      setCheck(function (prev) { return { status: "loading", data: prev.data, error: null }; });
      apiGet("/runs/" + enc(run.run_id) + "/merge").then(function (res) {
        if (!alive) return;
        setCheck(res.ok ? { status: "ok", data: obj(res.data.merge) || {}, error: null } : { status: "error", data: null, error: res.error });
      });
      return function () { alive = false; };
    }, [run.run_id, nonce, props.refreshKey]);

    const m = check.data;
    const totals = obj(diff && diff.totals) || {};
    const files = diff ? list(diff.files) : [];
    const commit = str((diff && diff.commit) || (m && m.commit));
    const into = m && m.into ? str(m.into) : "your branch";

    function doMerge() {
      setBusy(true);
      setError(null);
      const body = commit ? { commit: commit.slice(0, 40) } : {};
      apiPost("/runs/" + enc(run.run_id) + "/merge", body).then(function (res) {
        setBusy(false);
        if (res.ok) {
          const result = obj(res.data.merge) || {};
          setDone(result);
          props.notify(result.already ? "The checkout already had this run's work." : "Merged run " + shortId(run.run_id) + " into " + str(result.into || into) + ".", "success");
          if (props.onMerged) props.onMerged(result);
          overviewStore.refresh();
          return;
        }
        setError(res.error);
      });
    }

    let body;
    if (done && done.merged) {
      body = h(
        "div",
        { className: "roko-mergebox is-done", "data-roko": "merged" },
        h("span", { className: "roko-merge-check", "aria-hidden": "true" }, h(Icon, { name: "check", size: 18, weight: 2.2 })),
        h(
          "div",
          { className: "roko-mergebox-main" },
          h("div", { className: "roko-mergebox-title" }, done.already ? "Already merged" : "Merged into " + str(done.into || into)),
          h("div", { className: "roko-dim" }, done.already ? "The checkout had this run's work." : (done.mode === "fast-forward" ? "Fast-forwarded to " : "Merge commit on top of ") + str(done.head || done.commit))
        ),
        done.undo_command ? h(CommandRow, { label: "Undo", value: done.undo_command }) : null
      );
    } else if (check.status === "loading" && !m) {
      body = h("div", { className: "roko-mergebox" }, h(Loading, { label: "Checking whether this can merge…" }));
    } else if (check.error) {
      body = h("div", { className: "roko-mergebox" }, h(ErrorNote, { error: check.error, compact: true, onRetry: function () { setNonce(function (n) { return n + 1; }); } }));
    } else if (m && m.merged) {
      body = h(
        "div",
        { className: "roko-mergebox is-done" },
        h("span", { className: "roko-merge-check", "aria-hidden": "true" }, h(Icon, { name: "check", size: 18, weight: 2.2 })),
        h("div", { className: "roko-mergebox-main" }, h("div", { className: "roko-mergebox-title" }, "Merged"), h("div", { className: "roko-dim" }, str(m.reason) || "The checkout has this run's work."))
      );
    } else if (m && m.can_merge && canAct) {
      body = h(
        "div",
        { className: "roko-mergebox is-ready" },
        h(
          "div",
          { className: "roko-mergebox-main" },
          h("div", { className: "roko-mergebox-title" }, "Ready to merge into ", h("span", { className: "roko-mono" }, into)),
          h("div", { className: "roko-dim" }, (m.mode === "fast-forward" ? "fast-forward" : "a merge commit, no conflicts") + (commit ? " · " + commit.slice(0, 7) : ""))
        ),
        h(Button, { type: "button", size: "sm", onClick: function () { setError(null); setOpen(true); }, "aria-label": "Merge run " + shortId(run.run_id) }, "Merge…")
      );
    } else {
      body = h(
        "div",
        { className: "roko-mergebox is-blocked" },
        h(
          "div",
          { className: "roko-mergebox-main" },
          h("div", { className: "roko-mergebox-title" }, canAct ? "Merge it by hand" : "Merging from the dashboard is turned off"),
          m && m.reason ? h("div", { className: "roko-dim" }, str(m.reason)) : null
        ),
        m && m.command ? h(CommandRow, { label: "Merge", value: m.command }) : null
      );
    }

    return h(
      Fragment,
      null,
      body,
      h(
        Modal,
        {
          open: open,
          name: "merge",
          role: "alertdialog",
          icon: "merge",
          title: done && done.merged ? "Merged" : "Merge into " + into + "?",
          subtitle: done && done.merged ? null : str(run.label),
          onClose: function () { if (!busy) setOpen(false); },
          footer: done && done.merged
            ? h(Fragment, null, h("span", { className: "roko-flex" }), h(Button, { type: "button", size: "sm", onClick: function () { setOpen(false); } }, "Done"))
            : h(
                Fragment,
                null,
                h("span", { className: "roko-flex" }),
                h(Button, { type: "button", size: "sm", outlined: true, disabled: busy, onClick: function () { setOpen(false); } }, "Not now"),
                h(Button, { type: "button", size: "sm", disabled: busy, "data-confirm": "merge", onClick: doMerge }, busy ? "Merging…" : "Merge " + plural(isNum(totals.files) ? totals.files : files.length, "file", "files"))
              ),
        },
        done && done.merged
          ? h(
              "div",
              { className: "roko-merged" },
              h("div", { className: "roko-merged-mark", "aria-hidden": "true" }, h(Icon, { name: "check", size: 30, weight: 2 })),
              h("div", { className: "roko-merged-title" }, done.already ? "The checkout already had this work." : "Merged into " + str(done.into || into)),
              h("div", { className: "roko-dim" }, (done.previous_head ? str(done.previous_head) + " → " : "") + str(done.head || done.commit)),
              done.undo_command ? h(CommandRow, { label: "Undo", value: done.undo_command }) : null
            )
          : h(
              "div",
              { className: "roko-mergeplan" },
              h(
                "div",
                { className: "roko-mergeplan-stats" },
                h("span", { className: "roko-mergeplan-big" }, plural(isNum(totals.files) ? totals.files : files.length, "file", "files")),
                h("span", { className: "roko-add" }, "+" + (totals.additions || 0)),
                h("span", { className: "roko-del" }, "−" + (totals.deletions || 0)),
                h(Pill, { tone: "idle" }, m && m.mode === "fast-forward" ? "fast-forward" : "merge commit")
              ),
              h(
                "div",
                { className: "roko-mergeplan-route" },
                h(Icon, { name: "branch", size: 13 }),
                h("span", { className: "roko-mono" }, str(m && m.branch)),
                h("span", { className: "roko-dim" }, "→"),
                h("span", { className: "roko-mono" }, into),
                commit ? h("span", { className: "roko-dim roko-mono" }, "@ " + commit.slice(0, 12)) : null
              ),
              files.length
                ? h(
                    "ul",
                    { className: "roko-mergeplan-files" },
                    files.slice(0, 8).map(function (f) {
                      return h(
                        "li",
                        { key: str(f.path) },
                        h("span", { className: "roko-status-letter roko-status-" + (STATUS_LETTER[f.status] || "M") }, STATUS_LETTER[f.status] || "M"),
                        h("span", { className: "roko-mono" }, str(f.path)),
                        h("span", { className: "roko-add" }, "+" + (f.additions || 0)),
                        h("span", { className: "roko-del" }, "−" + (f.deletions || 0))
                      );
                    }),
                    files.length > 8 ? h("li", { className: "roko-dim" }, "and " + (files.length - 8) + " more") : null
                  )
                : null,
              h(
                "p",
                { className: "roko-mergeplan-note" },
                "This changes the checkout of roko's workspace. Only the commit you reviewed is merged; if the branch moved since, nothing is."
              ),
              error ? h(ErrorNote, { error: error, compact: true }) : null
            )
      )
    );
  }

  function ChangesTab(props) {
    const run = props.run;
    const state = props.diffState;
    const d = state.data;
    if (!d && state.error) return h(ErrorNote, { error: state.error, onRetry: props.onReload });
    if (!d) return h("div", { className: "roko-changes" }, h(Skeleton, { rows: 6 }));
    if (!d.available) {
      return h(
        "div",
        { className: "roko-changes" },
        h(Empty, { icon: d.why === "running" ? "clock" : "diff", title: d.why === "running" ? "The changes show once the run ends" : "No changes to review" }, str(d.message))
      );
    }
    const totals = obj(d.totals) || {};
    return h(
      "div",
      { className: "roko-changes" },
      h(
        "div",
        { className: "roko-changes-head" },
        h(
          "div",
          { className: "roko-changes-sum" },
          h("span", { className: "roko-changes-big" }, h("span", { className: "roko-add" }, "+" + (totals.additions || 0)), " ", h("span", { className: "roko-del" }, "−" + (totals.deletions || 0))),
          h("span", { className: "roko-dim" }, "in " + plural(isNum(totals.files) ? totals.files : list(d.files).length, "file", "files")),
          h("span", { className: "roko-changes-route" }, h(Icon, { name: "branch", size: 12 }), h("span", { className: "roko-mono" }, str(d.branch)), d.commit ? h("span", { className: "roko-mono roko-dim" }, "@ " + str(d.commit).slice(0, 7)) : null)
        ),
        run.review_command ? h(CopyButton, { value: run.review_command, what: "review command", label: "Copy git diff" }) : null
      ),
      h(MergeBox, { run: run, diff: d, notify: props.notify, onMerged: props.onMerged, refreshKey: props.refreshKey }),
      h(DiffView, { diff: d })
    );
  }

  // ---------------------------------------------------------------------------
  // The run hero: what it is, and the instruments
  // ---------------------------------------------------------------------------

  function modelsOf(tasks) {
    const seen = {};
    tasks.forEach(function (t) {
      list(t.attempt_log).forEach(function (a) { if (a.model) seen[a.model] = (seen[a.model] || 0) + 1; });
      if (!list(t.attempt_log).length && t.model) seen[t.model] = (seen[t.model] || 0) + 1;
    });
    return Object.keys(seen).map(function (k) { return { model: k, n: seen[k] }; }).sort(function (a, b) { return b.n - a.n; });
  }

  function allPips(tasks) {
    const out = [];
    tasks.forEach(function (t) { taskView(t).pips.forEach(function (p) { out.push(p); }); });
    return out;
  }

  function Instrument(props) {
    return h(
      "div",
      { className: "roko-instrument" + (props.className ? " " + props.className : "") },
      h(Label, null, props.label),
      h("div", { className: "roko-instrument-main" }, props.children),
      props.sub ? h("div", { className: "roko-instrument-sub" }, props.sub) : null
    );
  }

  /** One readout on the display bar: `01 LABEL`, the value, a line under it. */
  function Cell(props) {
    return h(
      "div",
      { className: "rk-cell" + (props.className ? " " + props.className : ""), role: "group", "aria-label": str(props.label).toLowerCase() },
      h("div", { className: "rk-cell-head", "aria-hidden": "true" }, h("span", { className: "rk-cell-idx" }, props.index), h("span", { className: "rk-cell-label" }, props.label)),
      h("div", { className: "rk-cell-main" }, props.children),
      props.sub ? h("div", { className: "rk-cell-sub" }, props.sub) : null
    );
  }

  /** A stopwatch on the glass: ticks once a second while it runs. */
  function DotClock(props) {
    const since = ms(props.since);
    const running = isFinite(since) && !isFinite(ms(props.until)) && !props.stopped;
    const now = useTick(running);
    const end = isFinite(ms(props.until)) ? ms(props.until) : now;
    const value = isFinite(since) ? stopwatch(Math.max(0, end - since)) : props.fallback || "—";
    return h(Dots, { value: value, size: props.size || "L", pad: props.pad, ch: props.ch, label: (props.prefix || "") + value });
  }

  /** A countdown on the glass (roko's own deadline): orange, red in the last minute. */
  function Countdown(props) {
    const until = ms(props.until);
    const now = useTick(isFinite(until));
    if (!isFinite(until)) return null;
    const left = until - now;
    const value = left > 0 ? stopwatch(left) : "0:00";
    return h(
      Well,
      { className: "rk-countdown" + (props.className ? " " + props.className : "") },
      h(Dots, { value: value, size: props.size || "M", ch: left > 60000 ? "you" : "fail", label: left > 0 ? "answer within " + value : "deadline passed" })
    );
  }

  const VERDICT = { succeeded: "PASS", passed: "PASS", failed: "FAIL", cancelled: "STOP", unverified: "WARN", missing: "LOST", planned: "PLAN" };

  /** Whether `value` just went from true to false while the page watched (a run that just ended). */
  function useJustEnded(active) {
    const prev = useRef(active);
    const [ended, setEnded] = useState(false);
    useEffect(function () {
      const was = prev.current;
      prev.current = active;
      if (!(was && !active) || prefersReducedMotion()) return undefined;
      setEnded(true);
      const timer = setTimeout(function () { setEnded(false); }, 1400);
      return function () { clearTimeout(timer); };
    }, [active]);
    return ended;
  }

  /** The run as one instrument: a display bar of numbered readouts, with the scope or the verdict. */
  function RunHero(props) {
    const run = props.run;
    const tasks = list(run.tasks);
    const p = obj(run.progress) || obj(run.task_counts) || {};
    const active = isRunActive(run);
    const gates = obj(run.gates) || {};
    const tok = obj(run.tokens);
    const models = modelsOf(tasks);
    const finishedCount = (p.passed || 0) + (p.failed || 0) + (p.blocked || 0) + (p.stopped || 0) + (p.unverified || 0);
    const fraction = isNum(p.total) && p.total > 0 ? finishedCount / p.total : 0;
    const projected = active && isNum(run.cost_usd) && fraction >= 0.2 && fraction < 1 ? run.cost_usd / fraction : null;
    const waits = runWaits(run);
    const ch = waits ? "you" : run.state === "succeeded" ? "pass" : run.state === "cancelled" ? "off" : channelOf(run.state);
    const justEnded = useJustEnded(active);
    const spendTone = capTone(run.cost_usd, run.max_usd);
    const doneWord = [p.passed ? p.passed + " passed" : null, waits ? "waiting on you" : p.running ? p.running + " running" : null, p.failed ? p.failed + " did not pass" : null, p.blocked ? p.blocked + " blocked" : null, p.pending ? p.pending + " waiting" : null]
      .filter(Boolean)
      .join(" · ");
    const checksAll = isNum(gates.total) && gates.total > 0;
    return h(
      "header",
      { className: "roko-hero rk-hero", "data-roko": "hero", "data-ch": ch },
      h(
        "div",
        { className: "roko-hero-top" },
        h(LED, { ch: ch, blink: active ? undefined : false }),
        h("span", { className: "rk-state", "data-ch": waits ? "agent" : ch }, str(run.state || "unknown")),
        waits ? h("span", { className: "rk-state rk-state-you", "data-ch": "you", "data-roko": "hero-waiting" }, "waiting on you") : null,
        h("span", { className: "roko-kind" }, (KIND_LABEL[run.kind] || str(run.kind)) + (isNum(p.total) && p.total > 1 ? " · " + p.total + " tasks" : "")),
        h("span", { className: "roko-hero-id roko-mono", title: str(run.run_id) }, shortId(run.run_id)),
        h(CopyButton, { value: run.run_id, what: "run id", compact: true }),
        h(
          "span",
          { className: "roko-hero-when roko-dim" },
          [(run.started_at || run.hermes_started_at) ? "started " + ago(run.started_at || run.hermes_started_at) : null,
           props.source === "ui" ? "from a Hermes page" : run.session_id ? "from a Hermes chat" : null].filter(Boolean).join(" · ")
        ),
        h("span", { className: "roko-flex" }),
        props.actions
      ),
      h("h2", { className: "roko-hero-title" }, str(run.label) || "(no label)"),
      run.request && str(run.request) !== str(run.label)
        ? h("blockquote", { className: "roko-hero-request" }, h(LongText, { value: run.request, limit: 220, lines: 3, prose: true }))
        : null,
      run.kind === "plan_generate"
        ? h("div", { className: "roko-hero-spacer" })
        : h(
            "div",
            { className: "rk-well rk-display roko-instruments" + (justEnded ? " rk-sweep-once" : ""), "data-roko": "display", "data-ch": ch },
            h(
              Cell,
              { index: "01", label: "TASKS", className: "rk-cell--tasks", sub: doneWord || (isNum(p.total) && p.total ? "" : "no tasks yet") },
              h(Ring, { progress: p, size: 46, dots: true }),
              h(StepStrip, { progress: p, size: "l", max: 12, waiting: waits })
            ),
            h(
              Cell,
              {
                index: "02",
                label: active ? "TIME" : "TOOK",
                sub: active
                  ? isNum(run.eta_minutes) && run.eta_minutes > 0 ? "≈ " + Math.max(1, Math.round(run.eta_minutes)) + " min left" : "roko is working"
                  : run.finished_at ? "finished " + ago(run.finished_at) : null,
              },
              active && run.started_at
                ? h(DotClock, { since: run.started_at, size: "L" })
                : h(Dots, { value: isNum(run.duration_ms) ? stopwatch(run.duration_ms) : "—", size: "L" })
            ),
            h(
              Cell,
              {
                index: "03",
                label: "SPEND",
                className: "rk-cell--spend",
                sub: h(
                  Fragment,
                  null,
                  h(SegMeter, { value: run.cost_usd, max: run.max_usd, projected: projected, label: "spent " + money(run.cost_usd) + (isNum(run.max_usd) ? " of the " + money(run.max_usd) + " cap" : "") }),
                  h("span", { className: "rk-cell-subtext" }, isNum(run.max_usd) ? "of " + money(run.max_usd) + " cap" : "no cap"),
                  projected !== null
                    ? h("span", { className: "rk-cell-subtext roko-proj", title: "spent so far ÷ the share of tasks done" }, "≈ " + money(projected) + " at this pace")
                    : null
                ),
              },
              h(Dots, { value: moneyFine(run.cost_usd), size: "L", ch: spendTone === "bad" ? "fail" : spendTone === "warn" ? "you" : undefined })
            ),
            h(
              Cell,
              { index: "04", label: "CHECKS", sub: h(Pips, { pips: allPips(tasks) }) },
              h(Dots, {
                value: checksAll ? String(gates.passed || 0) + "/" + gates.total : "—",
                size: "L",
                ch: checksAll && gates.passed === gates.total ? "pass" : undefined,
                label: checksAll ? (gates.passed || 0) + " of " + gates.total + " checks passed" : "no checks yet",
              })
            ),
            h(
              Cell,
              {
                index: "05",
                label: models.length > 1 ? "MODELS" : "MODEL",
                className: "rk-cell--models",
                sub: tok ? tokens(tok.input) + " in · " + tokens(tok.output) + " out" + (isNum(tok.cache_read) && tok.cache_read ? " · " + tokens(tok.cache_read) + " cached" : "") : null,
              },
              models.length
                ? h(
                    "span",
                    { className: "roko-models" },
                    models.slice(0, 3).map(function (m) {
                      return h("span", { key: m.model, className: "roko-model" }, m.model, m.n > 1 ? h("span", { className: "roko-model-n" }, "×" + m.n) : null);
                    })
                  )
                : h(Dots, { value: "—", size: "L" })
            ),
            h(
              "div",
              { className: "rk-display-end" },
              active
                ? h(Scope, { runId: str(run.run_id), width: 156, height: 56, label: "pulse" })
                : h(
                    "div",
                    { className: "rk-verdict", "data-ch": ch },
                    h(Dots, { value: VERDICT[run.state] || str(run.state).slice(0, 4).toUpperCase() || "—", size: "L", ch: ch === "off" ? undefined : ch, label: "verdict: " + str(run.state) })
                  )
            )
          )
    );
  }

  // ---------------------------------------------------------------------------
  // One run: the display bar, the ticker, why, waiting, and Overview · Activity · Loops · Changes
  // ---------------------------------------------------------------------------

  /**
   * The run as this page shows it. roko reports a task a cancel interrupted as failed (roko bug-1d09e8);
   * its error says "cancelled: …", so here it is interrupted, and the ring counts it as stopped.
   */
  function shownRun(run) {
    if (run.state !== "cancelled") return run;
    const cut = {};
    list(obj(run.why) && run.why.errors).forEach(function (e) {
      const m = /task '([^']+)' failed: cancelled/.exec(str(e));
      if (m) cut[m[1]] = true;
    });
    let moved = 0;
    const tasks = list(run.tasks).map(function (t) {
      if (cut[str(t.task_id)] && nodeState(t.outcome) === "failed") {
        moved += 1;
        return Object.assign({}, t, { outcome: "interrupted" });
      }
      return t;
    });
    if (!moved) return run;
    const p = Object.assign({}, obj(run.progress) || {});
    if (isNum(p.failed)) p.failed = Math.max(0, p.failed - moved);
    p.stopped = (isNum(p.stopped) ? p.stopped : 0) + moved;
    return Object.assign({}, run, { tasks: tasks, progress: p });
  }

  /** A prompt run's single task is titled "Request from chat host …" by roko; use the request instead. */
  function namedTasks(run) {
    const tasks = list(run.tasks);
    if (run.kind !== "run" || tasks.length !== 1 || !/^Request from /.test(str(tasks[0].title))) return tasks;
    const name = oneLine(run.request || run.label, 140);
    return name ? [Object.assign({}, tasks[0], { title: name })] : tasks;
  }

  function defaultTask(tasks) {
    const running = tasks.filter(function (t) { return t.outcome === "running"; })[0];
    if (running) return str(running.task_id);
    const bad = tasks.filter(function (t) { return nodeState(t.outcome) === "failed"; })[0];
    if (bad) return str(bad.task_id);
    return tasks.length === 1 ? str(tasks[0].task_id) : null;
  }

  function useRunCard(runId) {
    const [state, setState] = useState({ status: "loading", run: null, error: null });
    const [nonce, setNonce] = useState(0);
    const lastActiveRef = useRef(null);
    useEffect(function () {
      let alive = true;
      let timer = null;
      function later() {
        clearTimeout(timer);
        timer = lastActiveRef.current ? setTimeout(tick, liveStore.healthy() ? LIVE_FALLBACK_MS : RUN_POLL_MS) : null;
      }
      function take(run) {
        lastActiveRef.current = isRunActive(run);
        setState({ status: "ok", run: run, error: null });
      }
      function tick() {
        apiGet("/runs/" + enc(runId)).then(function (res) {
          if (!alive) return;
          if (res.ok) {
            const run = obj(res.data.run) || {};
            take(run);
            overviewStore.patchRun(run);
            if (isRunActive(run)) {
              const rows = list((overviewStore.get().data || {}).runs);
              if (!rows.some(function (r) { return r && r.run_id === runId; })) liveStore.follow(runId);
            }
          } else {
            lastActiveRef.current = lastActiveRef.current === true && res.error.kind !== "backend";
            setState(function (prev) { return { status: "error", run: prev.run, error: res.error }; });
          }
          later();
        });
      }
      const release = liveStore.use();
      const unsub = liveStore.subscribe(function (kind, rid, card) {
        if (kind !== "run" || rid !== runId || !alive) return;
        take(card);
        later();
      });
      tick();
      return function () {
        alive = false;
        clearTimeout(timer);
        unsub();
        release();
      };
    }, [runId, nonce]);
    const reload = useCallback(function () { setNonce(function (n) { return n + 1; }); }, []);
    return { state: state, reload: reload };
  }

  function useDiff(runId, ended, nonce) {
    const [state, setState] = useState({ data: null, error: null });
    useEffect(function () {
      if (!ended) {
        setState({ data: null, error: null });
        return undefined;
      }
      let alive = true;
      apiGet("/runs/" + enc(runId) + "/diff").then(function (res) {
        if (!alive) return;
        setState(res.ok ? { data: obj(res.data.diff) || {}, error: null } : { data: null, error: res.error });
      });
      return function () { alive = false; };
    }, [runId, ended, nonce]);
    return state;
  }

  function RunView(props) {
    const runId = props.runId;
    const limits = useLimits();
    const card = useRunCard(runId);
    const run = card.state.run ? shownRun(card.state.run) : null;
    const active = isRunActive(run);
    const ended = !!run && !active && run.kind !== "plan_generate";
    const events = useRunEvents(runId, active);
    const [tab, setTabState] = useState(validRunTab(props.initialTab) || "overview");
    const [selected, setSelected] = useState(null);
    const [replayT, setReplayT] = useState(null);
    const [diffNonce, setDiffNonce] = useState(0);
    const diff = useDiff(runId, ended, diffNonce);
    const [confirmCancel, setConfirmCancel] = useState(false);
    const [cancelling, setCancelling] = useState(false);
    const [answered, setAnswered] = useState({});
    const tabRef = useRef(tab);
    tabRef.current = tab;

    function setTab(id) {
      setTabState(id);
      writeParams({ view: id === "overview" ? null : id });
    }

    // [ and ] move between the run's tabs; Esc closes the task.
    useEffect(function () {
      function onKey(event) {
        if (typingIn(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
        if (document.querySelector(".roko-modal")) return;
        const ids = RUN_TABS.map(function (t) { return t.id; });
        const at = ids.indexOf(tabRef.current);
        if (event.key === "]") setTab(ids[(at + 1) % ids.length]);
        else if (event.key === "[") setTab(ids[(at + ids.length - 1) % ids.length]);
        else if (event.key === "Escape") setSelected(null);
      }
      document.addEventListener("keydown", onKey);
      return function () { document.removeEventListener("keydown", onKey); };
    }, []);

    if (!run) {
      if (card.state.error) {
        return h(Panel, { title: "Run " + shortId(runId) }, h(ErrorNote, { error: card.state.error, onRetry: card.reload }));
      }
      return h("div", { className: "roko-runview is-loading" }, h("div", { className: "roko-hero" }, h(Skeleton, { rows: 4 })), h(Skeleton, { rows: 6 }));
    }

    const tasks = namedTasks(run);
    const waiting = list(run.waiting).filter(function (it) { return !answered[it.decision_id]; });
    const heldTasks = {};
    waiting.forEach(function (it) {
      // A sign-off says more than a held action about where the task is.
      if (it.task_id && (!heldTasks[str(it.task_id)] || it.kind === "confirm")) heldTasks[str(it.task_id)] = it.kind || "confirm";
    });
    const canAct = limits.canAct;
    const evs = events.events;
    const stamps = evs.map(function (e) { return e.ts_millis; }).filter(isNum);
    const startMs = isFinite(ms(run.started_at)) ? Math.min(ms(run.started_at), stamps.length ? stamps[0] : Infinity) : stamps.length ? stamps[0] : NaN;
    const endMs = stamps.length ? stamps[stamps.length - 1] : NaN;
    const canReplay = ended && stamps.length > 2 && tasks.length > 0;
    const replay = canReplay && replayT != null ? replayAt(tasks, evs, replayT) : null;
    const views = replay ? replay.tasks : null;
    const current = selected || defaultTask(tasks);
    const currentTask = tasks.filter(function (t) { return str(t.task_id) === current; })[0] || null;
    const d = diff.data;
    const totals = d && d.available ? obj(d.totals) || {} : null;
    const delivered = obj(run.delivered);

    function doCancel() {
      setConfirmCancel(false);
      setCancelling(true);
      apiPost("/runs/" + enc(runId) + "/cancel", {}).then(function (res) {
        setCancelling(false);
        if (res.ok) {
          props.notify("Cancelled run " + shortId(runId) + " (" + str(res.data.state || "cancelled") + ")", "success");
          card.reload();
          overviewStore.refresh();
        } else {
          props.notify(res.error.message + (res.error.hint ? " — " + res.error.hint : ""), "error");
        }
      });
    }

    const actions = [];
    if (active && canAct && run.kind !== "plan_generate") {
      actions.push(
        h(
          Button,
          { key: "cancel", size: "sm", outlined: true, destructive: true, type: "button", disabled: cancelling, onClick: function () { setConfirmCancel(true); } },
          cancelling ? "Cancelling…" : "Cancel run"
        )
      );
    }
    if (run.plan_id && run.kind === "plan" && props.onOpenPlan) {
      actions.push(h("button", { key: "plan", type: "button", className: "roko-linkbtn", onClick: function () { props.onOpenPlan(run.plan_id); } }, "Open plan"));
    }
    if (ended && delivered && !delivered.merged && totals) {
      actions.push(
        h(
          "button",
          { key: "review", type: "button", className: "roko-hero-review", onClick: function () { setTab("changes"); } },
          h(Icon, { name: "diff", size: 13 }),
          "Review ",
          h("span", { className: "roko-add" }, "+" + (totals.additions || 0)),
          h("span", { className: "roko-del" }, "−" + (totals.deletions || 0))
        )
      );
    }

    if (run.kind === "plan_generate") {
      return h(
        "div",
        { className: "roko-runview", "data-roko": "run", "data-roko-run": str(run.run_id) },
        h(RunHero, { run: run, actions: actions, source: props.source }),
        h(PlanningView, { run: run, notify: props.notify, onOpenPlan: props.onOpenPlan, onStarted: props.onStarted }),
        card.state.error ? h(ErrorNote, { error: card.state.error, onRetry: card.reload }) : null
      );
    }

    let body;
    if (tab === "activity") {
      body = h(Feed, { events: evs, loaded: events.loaded, error: events.error, start: startMs, live: active });
    } else if (tab === "loops") {
      body = h(RunLoops, { run: run });
    } else if (tab === "changes") {
      body = ended
        ? h(ChangesTab, {
            run: run,
            diffState: diff,
            notify: props.notify,
            refreshKey: diffNonce,
            onReload: function () { setDiffNonce(function (n) { return n + 1; }); },
            onMerged: function () { card.reload(); },
          })
        : h(Empty, { icon: "clock", title: "The changes show once the run ends" }, "roko merges every plan whose checks all pass into the run's batch branch; review and merge it here when the run ends.");
    } else {
      body = h(
        "div",
        { className: "roko-overview" + (currentTask ? " has-inspector" : "") },
        h(
          "div",
          { className: "roko-overview-graph" },
          h(RunGraph, {
            graph: run.graph,
            tasks: tasks,
            views: views,
            selected: current,
            replaying: !!replay,
            clockAt: replay ? replayT : null,
            replayStart: stamps.length ? stamps[0] : null,
            held: heldTasks,
            onSelect: function (id) { setSelected(id === current && selected ? null : id); },
          }),
          canReplay
            ? h(ReplayBar, { events: evs, start: stamps[0], end: endMs, t: replayT, onChange: setReplayT })
            : null,
          h(
            "div",
            { className: "roko-latest" },
            h(Label, null, replay ? "At this moment" : active ? "Latest" : "How it ended"),
            h(Feed, {
              compact: true,
              events: replay ? evs.filter(function (e) { return isNum(e.ts_millis) && e.ts_millis <= replayT; }).slice(-5) : evs.slice(-5),
              loaded: events.loaded,
              error: events.error,
              start: startMs,
              live: false,
            })
          )
        ),
        currentTask
          ? h(TaskInspector, {
              task: currentTask,
              runId: str(run.run_id),
              replaying: !!replay,
              view: views ? views[str(currentTask.task_id)] : taskView(currentTask),
              why: run.why,
              onClose: function () { setSelected(null); },
            })
          : null
      );
    }

    const activityCount = evs.length;
    const loopCount = list(run.loops).length;
    return h(
      "div",
      { className: "roko-runview", "data-roko": "run", "data-roko-run": str(run.run_id) },
      h(RunHero, { run: run, actions: actions, source: props.source }),
      card.state.error ? h(ErrorNote, { error: card.state.error, compact: true, onRetry: card.reload }) : null,
      active ? h(NowStrip, { run: run, tasks: tasks, held: heldTasks, onSelect: function (id) { setSelected(id); setTab("overview"); } }) : null,
      h(WhyCallout, { run: run, onSelect: function (id) { setSelected(id); setTab("overview"); } }),
      waiting.length
        ? h(
            "section",
            { className: "roko-run-waiting" },
            h(Label, null, h(Icon, { name: "hand", size: 12 }), " Waiting on you"),
            h(PendingList, {
              items: waiting,
              notify: props.notify,
              onDecided: function (item) {
                setAnswered(function (prev) { const next = Object.assign({}, prev); next[item.decision_id] = true; return next; });
                card.reload();
                overviewStore.refresh();
              },
            })
          )
        : null,
      h(
        "div",
        { className: "roko-runtabs", role: "tablist", "aria-label": "This run" },
        RUN_TABS.map(function (t) {
          const on = tab === t.id;
          let extra = null;
          if (t.id === "activity" && activityCount) extra = h("span", { className: "roko-runtab-n" }, String(activityCount));
          if (t.id === "loops" && loopCount) extra = h("span", { className: "roko-runtab-n" }, String(loopCount));
          if (t.id === "changes" && totals) {
            extra = h("span", { className: "roko-runtab-n" }, h("span", { className: "roko-add" }, "+" + (totals.additions || 0)), " ", h("span", { className: "roko-del" }, "−" + (totals.deletions || 0)));
          }
          return h(
            "button",
            {
              key: t.id,
              type: "button",
              role: "tab",
              "aria-selected": on ? "true" : "false",
              className: "roko-runtab" + (on ? " is-on" : ""),
              onClick: function () { setTab(t.id); },
            },
            t.label,
            extra
          );
        }),
        h("span", { className: "roko-flex" }),
        h("span", { className: "roko-runtabs-keys roko-dim", "aria-hidden": "true" }, h(Kbd, null, "["), h(Kbd, null, "]"))
      ),
      h("div", { className: "roko-runbody", role: "tabpanel" }, body),
      ended && delivered && tab !== "changes"
        ? h(
            "div",
            { className: "roko-delivered" },
            h(Icon, { name: "branch", size: 13 }),
            h("span", { className: "roko-mono" }, str(delivered.branch)),
            delivered.commit ? h("span", { className: "roko-mono roko-dim" }, "@ " + str(delivered.commit)) : null,
            delivered.merged ? h(Pill, { tone: "ok" }, "merged") : delivered.promoted_into ? h(Pill, { tone: "ok" }, "promoted into " + str(delivered.promoted_into)) : h(Pill, { tone: "warn" }, "not merged yet"),
            delivered.diffstat ? h("span", { className: "roko-dim" }, str(delivered.diffstat)) : null
          )
        : null,
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

  /** A plan generation: the planner at work, then the plan it wrote. */
  function PlanningView(props) {
    const run = props.run;
    const active = isRunActive(run);
    const planId = run.plan_id ? str(run.plan_id) : null;
    const done = run.state === "succeeded" && planId;
    const plan = useResource(done ? "/plans/" + enc(planId) : null, 0);
    const detail = plan.data ? obj(plan.data.plan) : null;
    if (active) {
      return h(
        "div",
        { className: "roko-planning", "data-roko": "planning" },
        h(
          "div",
          { className: "roko-planning-title" },
          h("span", { className: "roko-spinner", "aria-hidden": "true" }),
          "roko's planner is writing the plan",
          run.hermes_started_at ? h(Ticker, { since: run.hermes_started_at, className: "roko-planning-clock", prefix: "· " }) : null
        ),
        h("div", { className: "roko-dim" }, "It splits the request into small tasks, each with its own checks, in waves that can run in parallel. Nothing runs until you start the plan."),
        h(
          "div",
          { className: "roko-planning-ghost", "aria-hidden": "true" },
          [3, 2, 1].map(function (n, i) {
            const col = [];
            for (let j = 0; j < n; j += 1) col.push(h("span", { key: j, className: "roko-ghostnode", style: { animationDelay: (i * 0.25 + j * 0.12) + "s" } }));
            return h("div", { key: i, className: "roko-ghostcol" }, col);
          })
        )
      );
    }
    if (!done) {
      return h(WhyCallout, { run: run });
    }
    return h(
      "div",
      { className: "roko-planning is-done", "data-roko": "planning" },
      h(
        "div",
        { className: "roko-planning-title" },
        h(Icon, { name: "check", size: 16, weight: 2, className: "roko-tone-ok" }),
        "Plan ready: ",
        h("span", { className: "roko-mono" }, planId),
        isNum(detail && detail.task_count) || isNum(run.task_count)
          ? h("span", { className: "roko-dim" }, " · " + plural(isNum(detail && detail.task_count) ? detail.task_count : run.task_count, "task", "tasks"))
          : null
      ),
      detail ? h(RunGraph, { graph: planGraph(detail), tasks: list(detail.tasks).map(planTaskCard), planned: true }) : plan.error ? h(ErrorNote, { error: plan.error, compact: true }) : h(Skeleton, { rows: 3 }),
      h(
        "div",
        { className: "roko-row" },
        props.onOpenPlan ? h(Button, { type: "button", size: "sm", onClick: function () { props.onOpenPlan(planId); } }, "Open the plan") : null,
        h("span", { className: "roko-dim" }, "Review it, then run it with a cap from the Plans tab.")
      )
    );
  }

  /** A plan's tasks as the graph's {waves, edges}. */
  function planGraph(plan) {
    const tasks = list(plan.tasks);
    const known = {};
    tasks.forEach(function (t) { known[str(t.id)] = true; });
    let waves = list(plan.waves).map(function (w) { return list(w).map(str); }).filter(function (w) { return w.length; });
    if (!waves.length) waves = [tasks.map(function (t) { return str(t.id); })];
    const placed = {};
    waves.forEach(function (w) { w.forEach(function (id) { placed[id] = true; }); });
    const rest = tasks.map(function (t) { return str(t.id); }).filter(function (id) { return !placed[id]; });
    if (rest.length) waves.push(rest);
    const edges = [];
    tasks.forEach(function (t) {
      list(t.depends_on).forEach(function (dep) { if (known[str(dep)]) edges.push([str(dep), str(t.id)]); });
    });
    return { waves: waves, edges: edges };
  }
  function planTaskCard(t) {
    return Object.assign({}, t, { task_id: str(t.id) });
  }

  // ---------------------------------------------------------------------------
  // roko's five loops: the dial, the rings, and what each loop reports
  // ---------------------------------------------------------------------------

  /** Loop events from several sources, once each (by key), oldest first. */
  function mergeLoops() {
    const byKey = {};
    const out = [];
    for (let i = 0; i < arguments.length; i += 1) {
      list(arguments[i]).forEach(function (ev) {
        if (!obj(ev) || !isNum(ev.ts)) return;
        const key = str(ev.key) || [ev.run_id, ev.kind, ev.task_id, ev.ts].join(":");
        if (byKey[key]) return;
        byKey[key] = true;
        out.push(ev);
      });
    }
    return out.sort(function (a, b) { return a.ts - b.ts; });
  }

  /** One ring's feed: its newest events, newest first, or a calm line. */
  function RingFeed(props) {
    const mine = props.events.filter(function (e) { return ringIndex(e.ring) === props.index; });
    const ring = RINGS[props.index];
    return h(
      Module,
      {
        index: ring.id,
        label: ring.name.toUpperCase(),
        className: "rk-ringmod" + (mine.length ? " is-active" : ""),
        right: h("span", { className: "rk-ringmod-clock" }, ring.clock),
      },
      props.children,
      mine.length
        ? h(
            "ol",
            { className: "rk-loopfeed" },
            mine.slice(-(props.max || 5)).reverse().map(function (ev, i) {
              return h(LoopLine, { key: str(ev.key) || i, event: ev, now: props.now });
            })
          )
        : React.Children.toArray(props.children).length
          ? null
          : h("div", { className: "rk-quiet" }, props.quiet || "quiet")
    );
  }

  /** The run's Loops tab: the dial over the run's loop events, and each ring's feed. */
  function RunLoops(props) {
    const run = props.run;
    const runId = str(run.run_id);
    useLiveVersion(runId, ["loop"]);
    const now = useNow(15000, true);
    const events = mergeLoops(run.loops, liveStore.loops(runId));
    // Live (the sweeping clock) while the run goes and its loops spoke in the last ten minutes;
    // otherwise the dial is the run's whole span.
    const newest = events.length ? events[events.length - 1].ts : 0;
    const live = isRunActive(run) && now - newest < DIAL_WINDOW_MS;
    const thresholds = list(run.thresholds).filter(obj);
    return h(
      "div",
      { className: "rk-loops", "data-roko": "loops" },
      h(
        Module,
        { index: "06", label: "LOOPS", className: "rk-dialmod", right: live ? h("span", { className: "rk-live" }, h(LED, { ch: "agent" }), "live") : h("span", { className: "roko-dim" }, "the run, start to end") },
        h("div", { className: "rk-dialwrap" }, h(Dial, { events: events, live: live }), h(DialLegend, { events: events, live: live }))
      ),
      h(
        "div",
        { className: "rk-ringgrid" },
        RINGS.map(function (ring, i) {
          let extra = null;
          if (i === 3 && thresholds.length) extra = h(ThresholdTable, { rows: thresholds });
          return h(RingFeed, { key: ring.id, index: i, events: events, now: now, quiet: RING_QUIET[i] }, extra);
        })
      )
    );
  }

  const RING_QUIET = [
    "no tool call was held or withheld",
    "no retries or failovers: each attempt kept its model",
    "no diagnosis, hold or budget alert",
    "nothing learned in this window",
    "no loop changed state",
  ];

  /** Gate thresholds as roko keeps them: pass rate per rung, how sure, and where they moved. */
  function ThresholdTable(props) {
    return h(
      "table",
      { className: "rk-table" },
      h("thead", null, h("tr", null, h("th", null, "rung"), h("th", null, "pass rate"), h("th", null, "seen"), h("th", null, "shift"))),
      h(
        "tbody",
        null,
        props.rows.slice(0, 8).map(function (r, i) {
          const rate = isNum(r.ema_pass_rate) ? r.ema_pass_rate : null;
          return h(
            "tr",
            { key: str(r.rung || r.name) + i },
            h("td", { className: "roko-mono" }, str(r.name || r.rung)),
            h("td", null, rate === null ? "—" : h("span", { className: "rk-rate" }, h("span", { className: "rk-rate-bar", "data-ch": rate >= 0.8 ? "pass" : rate >= 0.5 ? "you" : "fail", style: { width: (rate * 100).toFixed(0) + "%" } }), pct(rate))),
            h("td", { className: "roko-mono" }, isNum(r.observations) ? String(r.observations) : "—"),
            h("td", { className: "roko-mono" }, r.shift == null ? "—" : str(r.shift))
          );
        })
      )
    );
  }

  /** The Loops section: all five loops, from roko's own routes and the live socket. */
  function LoopsSection(props) {
    const res = useResource("/loops", 30000);
    const liveState = useLiveStatus();
    useLiveVersion(undefined, ["loop"]);
    const now = useNow(15000, true);
    const data = res.data || {};
    const rings = list(data.rings).filter(obj);
    const byRing = {};
    rings.forEach(function (r) { byRing[str(r.ring)] = r; });
    const recent = [];
    rings.forEach(function (r) { list(r.recent).forEach(function (ev) { recent.push(Object.assign({ ring: r.ring }, ev)); }); });
    const events = mergeLoops(recent, liveStore.loops());
    const newest = events.length ? events[events.length - 1].ts : 0;
    const live = now - newest < DIAL_WINDOW_MS;
    const states = {};
    rings.forEach(function (r) { states[str(r.ring)] = str(r.state); });
    if (!res.data && res.error) return h(ErrorNote, { error: res.error, onRetry: res.reload });
    if (!res.data) return h(Loading, { label: "Reading roko's loops…" });
    const problems = list(data.problems);
    const L0 = byRing.L0 || {};
    const L1 = byRing.L1 || {};
    const L2 = byRing.L2 || {};
    const L3 = byRing.L3 || {};
    const L4 = byRing.L4 || {};
    const counts = obj(L0.counts) || {};
    const knowledge = obj(L3.knowledge) || {};
    const playbooks = obj(L3.playbooks) || {};
    return h(
      "div",
      { className: "rk-loopsection", "data-roko": "loops-section" },
      h(
        "div",
        { className: "rk-loopsection-intro" },
        h("h2", { className: "rk-h2" }, "five loops"),
        h(
          "p",
          { className: "roko-dim" },
          "roko regulates itself on five nested clocks: each tool call, each attempt, the plan, what it learns, and an audit of the loops themselves. Every event lands on its ring as it happens."
        ),
        h(
          "span",
          { className: "rk-live" },
          h(LED, { ch: liveState.status === "open" ? "agent" : liveState.status === "down" ? "fail" : "off", blink: liveState.status === "open" && live ? undefined : false }),
          liveState.status === "open" ? "live" : liveState.status === "unsupported" ? "polling" : liveState.status === "down" ? "reconnecting" : "connecting"
        )
      ),
      h(
        "div",
        { className: "rk-loopsection-grid" },
        h(
          Module,
          { index: "06", label: "LOOPS", className: "rk-dialmod rk-dialmod--big" },
          h("div", { className: "rk-dialwrap" }, h(Dial, { events: events, live: live, size: 300 }), h(DialLegend, { events: events, live: live, states: states }))
        ),
        h(
          "div",
          { className: "rk-ringgrid" },
          h(
            RingFeed,
            { index: 0, events: events, now: now, quiet: RING_QUIET[0] },
            h(
              "div",
              { className: "rk-counts" },
              h(Well, { className: "rk-count" }, h(Dots, { value: String(isNum(counts.held) ? counts.held : 0), size: "M", ch: counts.held ? "you" : undefined, label: (counts.held || 0) + " held" }), h("span", null, "held")),
              h(Well, { className: "rk-count" }, h(Dots, { value: String(isNum(counts.withheld) ? counts.withheld : 0), size: "M", ch: counts.withheld ? "fail" : undefined, label: (counts.withheld || 0) + " withheld" }), h("span", null, "withheld"))
            )
          ),
          h(
            RingFeed,
            { index: 1, events: events, now: now, quiet: RING_QUIET[1] },
            list(L1.routes).length
              ? h(
                  "ol",
                  { className: "rk-mini" },
                  list(L1.routes).slice(0, 5).map(function (r, i) {
                    return h("li", { key: i }, h("span", { className: "roko-mono" }, str(r.model || r.chosen || "?")), h("span", { className: "roko-dim" }, [str(r.source || r.stage), isNum(r.p) ? "p " + r.p.toFixed(2) : null].filter(Boolean).join(" · ")));
                  })
                )
              : null,
            list(L1.retry_budgets).length
              ? h(
                  "ol",
                  { className: "rk-mini" },
                  list(L1.retry_budgets).slice(0, 5).map(function (r, i) {
                    return h("li", { key: "b" + i }, h("span", { className: "roko-mono" }, str(r.rung)), h("span", { className: "roko-dim" }, "retries " + str(r.suggested_max_retries) + (isNum(r.ema_pass_rate) ? " · " + pct(r.ema_pass_rate) : "")));
                  })
                )
              : null
          ),
          h(
            RingFeed,
            { index: 2, events: events, now: now, quiet: RING_QUIET[2] },
            list(L2.diagnoses).length
              ? h(
                  "ol",
                  { className: "rk-mini" },
                  list(L2.diagnoses).slice(0, 4).map(function (d, i) {
                    return h("li", { key: i }, h(LED, { ch: d.severity === "alert" ? "fail" : d.severity === "info" ? "agent" : "you", blink: false }), h("span", null, oneLine(d.summary || d.text || d.kind, 140)));
                  })
                )
              : null
          ),
          h(
            RingFeed,
            { index: 3, events: events, now: now, quiet: RING_QUIET[3] },
            h(
              "div",
              { className: "rk-counts" },
              h(Well, { className: "rk-count" }, h(Dots, { value: String(isNum(knowledge.total) ? knowledge.total : 0), size: "M", ch: "pass", label: (knowledge.total || 0) + " lessons kept" }), h("span", null, "lessons")),
              h(Well, { className: "rk-count" }, h(Dots, { value: String(isNum(playbooks.total) ? playbooks.total : 0), size: "M", label: (playbooks.total || 0) + " playbooks" }), h("span", null, "playbooks"))
            ),
            list(L3.models).length
              ? h(
                  "ol",
                  { className: "rk-mini" },
                  list(L3.models).slice(0, 4).map(function (m, i) {
                    const rate = isNum(m.success_rate) ? m.success_rate : null;
                    return h(
                      "li",
                      { key: i },
                      h("span", { className: "roko-mono" }, str(m.model)),
                      rate === null ? null : h("span", { className: "rk-rate" }, h("span", { className: "rk-rate-bar", "data-ch": rate >= 0.8 ? "pass" : rate >= 0.5 ? "you" : "fail", style: { width: (rate * 100).toFixed(0) + "%" } })),
                      h("span", { className: "roko-dim" }, [rate === null ? null : pct(rate), isNum(m.tasks) ? plural(m.tasks, "task", "tasks") : null].filter(Boolean).join(" · "))
                    );
                  })
                )
              : null,
            list(L3.thresholds).length ? h(ThresholdTable, { rows: list(L3.thresholds).filter(obj) }) : null
          ),
          h(
            RingFeed,
            { index: 4, events: events, now: now, quiet: RING_QUIET[4] },
            list(L4.loops).length
              ? h(
                  "ol",
                  { className: "rk-mini" },
                  list(L4.loops).slice(0, 8).map(function (l, i) {
                    const st = str(l.state);
                    return h(
                      "li",
                      { key: str(l.loop_id) || i },
                      h(LED, { ch: st === "healthy" ? "pass" : st === "degraded" || st === "tripped" ? "fail" : st === "watch" ? "you" : "off", blink: false }),
                      h("span", { className: "roko-mono" }, str(l.loop_id)),
                      h("span", { className: "roko-dim" }, [st.replace(/_/g, " "), isNum(l.h) ? "h " + l.h.toFixed(2) : null].filter(Boolean).join(" · "))
                    );
                  })
                )
              : null
          )
        )
      ),
      problems.length
        ? h("div", { className: "roko-dim rk-problems" }, "roko could not answer: " + problems.map(str).join(" · "))
        : null
    );
  }
  // ---------------------------------------------------------------------------
  // The run list
  // ---------------------------------------------------------------------------

  function groupRuns(runs, now) {
    const live = [];
    const today = [];
    const earlier = [];
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    runs.forEach(function (run) {
      if (isActiveState(run.state)) live.push(run);
      else if (ms(run.started_at) >= midnight.getTime()) today.push(run);
      else earlier.push(run);
    });
    return [
      { id: "live", label: "Live", runs: live },
      { id: "today", label: "Today", runs: today },
      { id: "earlier", label: "Earlier", runs: earlier },
    ].filter(function (g) { return g.runs.length; });
  }

  function RunList(props) {
    const now = useNow(30000, true);
    const groups = groupRuns(props.runs, now);
    return h(
      "nav",
      { className: "roko-runlist rk-tracks", "aria-label": "Runs started from Hermes" },
      groups.map(function (group) {
        return h(
          "div",
          { key: group.id, className: "roko-rungroup" },
          h("div", { className: "roko-rungroup-head" }, h("span", null, group.label), h("span", { className: "roko-rungroup-n" }, String(group.runs.length))),
          h(
            "div",
            { role: "list" },
            group.runs.map(function (run) {
              const selected = run.run_id === props.selected;
              const tone = stateTone(run.state);
              const progress = obj(run.progress);
              const waits = runWaits(run, props.pending);
              const ch = waits ? "you" : run.state === "succeeded" ? "pass" : run.state === "cancelled" ? "off" : channelOf(run.state);
              return h(
                "button",
                {
                  key: str(run.run_id),
                  type: "button",
                  role: "listitem",
                  className: "roko-runitem roko-edge-" + tone + (selected ? " is-selected" : ""),
                  "aria-current": selected ? "true" : undefined,
                  "data-roko-runitem": str(run.run_id),
                  "data-ch": ch,
                  onClick: function () {
                    sound.play("key", { user: true });
                    props.onSelect(run.run_id);
                  },
                },
                h(LED, { ch: ch, blink: isActiveState(run.state) ? undefined : false }),
                h(
                  "span",
                  { className: "roko-runitem-main" },
                  h(
                    "span",
                    { className: "roko-runitem-top" },
                    h("span", { className: "roko-runitem-label", title: str(run.label) }, str(run.label) || "(no label)"),
                    h("span", { className: "roko-runitem-ago" }, ago(run.started_at, now).replace(" ago", ""))
                  ),
                  h(
                    "span",
                    { className: "roko-runitem-meta" },
                    h("span", { className: "rk-state", "data-ch": ch }, waits ? "waiting on you" : str(run.state || "unknown")),
                    progress && progress.total ? h(StepStrip, { progress: progress, waiting: waits }) : h("span", { className: "roko-kind" }, KIND_LABEL[run.kind] || str(run.kind)),
                    h("span", { className: "roko-runitem-cost roko-mono" }, costOfCap(run.cost_usd, run.max_usd))
                  )
                )
              );
            })
          )
        );
      })
    );
  }

  // ---------------------------------------------------------------------------
  // The composer: ask roko for work
  // ---------------------------------------------------------------------------

  function defaultCap(ceiling) {
    if (ceiling === null) return 0.5;
    const fits = CAP_PRESETS.filter(function (c) { return c <= ceiling + 1e-9; });
    if (fits.indexOf(0.5) >= 0) return 0.5;
    if (fits.length) return fits[fits.length - 1];
    return ceiling >= 0.01 ? Math.floor(ceiling * 100) / 100 : null;
  }

  function Composer(props) {
    const limits = useLimits();
    const ceiling = ceilingOf(limits);
    const [mode, setMode] = useState("run");
    const [prompt, setPrompt] = useState(props.prompt || "");
    const [title, setTitle] = useState("");
    const [cap, setCap] = useState(defaultCap(ceiling));
    const [custom, setCustom] = useState("");
    const [domain, setDomain] = useState("code");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const [touched, setTouched] = useState(false);

    useEffect(function () {
      if (props.open) {
        setPrompt(props.prompt || "");
        setTitle("");
        setMode("run");
        setDomain("code");
        setCustom("");
        setError(null);
        setTouched(false);
        setBusy(false);
        // The limits may have arrived since the page loaded: start from a cap that fits them.
        setCap(function (current) {
          const fits = current !== "custom" && isNum(current) && (ceiling === null || current <= ceiling + 1e-9);
          return fits ? current : defaultCap(ceiling);
        });
      }
    }, [props.open, props.prompt]);

    const capValue = cap === "custom" ? Number(custom) : cap;
    const capTooHigh = ceiling !== null && isNum(capValue) && capValue > ceiling + 1e-9;
    const capOk = mode === "plan" || (isNum(capValue) && capValue >= 0.01 && !capTooHigh && !(cap === "custom" && custom.trim() === ""));
    const promptOk = prompt.trim().length > 0 && prompt.length <= 8000;
    const ready = promptOk && capOk && !busy;

    function submit() {
      setTouched(true);
      if (!promptOk || !capOk || busy) return;
      setBusy(true);
      setError(null);
      const body = { prompt: prompt.trim() };
      if (title.trim()) body.title = title.trim();
      if (mode === "plan") body.plan = true;
      else {
        body.max_usd = Math.round(capValue * 100) / 100;
        if (domain !== "code") body.domain = domain;
      }
      apiPost("/runs", body).then(function (res) {
        setBusy(false);
        if (res.ok) {
          sound.play("run", { user: true });
          props.notify((mode === "plan" ? "roko is writing a plan: " : "Started run ") + shortId(res.data.run_id), "success");
          overviewStore.refresh();
          props.onClose();
          props.onStarted(res.data);
          return;
        }
        setError(res.error);
      });
    }

    return h(
      Modal,
      {
        open: props.open,
        name: "composer",
        icon: "bolt",
        wide: true,
        title: "new run",
        subtitle: "roko's agents do the work on a branch; your project's checks decide when it is done.",
        onClose: props.onClose,
        footer: h(
          Fragment,
          null,
          h(
            "span",
            { className: "roko-composer-limits" },
            limits.today !== null ? "today " + money(limits.today) + (limits.maxDay !== null ? " of " + money(limits.maxDay) : "") : null,
            limits.maxRun !== null ? " · at most " + money(limits.maxRun) + " per run" : null
          ),
          h("span", { className: "roko-flex" }),
          h(Key, { label: "cancel", kbd: "esc", ariaLabel: "Cancel", onClick: props.onClose }),
          h(Key, {
            tone: "you",
            size: "l",
            name: "composer-submit",
            disabled: !ready,
            busy: busy,
            kbd: "⌘↵",
            keys: "Control+Enter Meta+Enter",
            ariaLabel: mode === "plan" ? "Write the plan" : "Start the run",
            label: busy ? (mode === "plan" ? "asking the planner…" : "starting…") : mode === "plan" ? "write the plan" : "start",
            onClick: submit,
          })
        ),
      },
      h(
        "div",
        { className: "roko-composer rk-device" },
        h(
          "div",
          { className: "rk-device-row" },
          h(Switch, {
            label: "How roko should take it",
            value: mode,
            onChange: setMode,
            items: [{ id: "run", label: "run it" }, { id: "plan", label: "plan first" }],
          }),
          h("span", { className: "rk-device-hint" }, mode === "plan" ? "a graph of tasks you review, then run" : "one checked task, now")
        ),
        h(
          "label",
          { className: "roko-field rk-field" },
          h("span", { className: "rk-module-head" }, h("span", { className: "rk-module-idx" }, "01"), h("span", { className: "rk-module-label" }, "WHAT SHOULD ROKO DO?")),
          h("textarea", {
            className: "roko-textarea rk-textarea",
            rows: 5,
            value: prompt,
            maxLength: 8000,
            "data-autofocus": "true",
            "aria-label": "What should roko do?",
            placeholder: "Say it completely: roko's agent sees only this. Name files, the outcome, and how to check it.",
            "aria-invalid": touched && !promptOk ? "true" : undefined,
            onChange: function (event) { setPrompt(event.target.value); },
            onKeyDown: function (event) {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                submit();
              }
            },
          }),
          h(
            "span",
            { className: "roko-field-foot" },
            touched && !prompt.trim() ? h("span", { className: "roko-field-error" }, "Say what roko should do.") : h("span", { className: "roko-dim" }, "⌘/Ctrl + Enter starts it"),
            h("span", { className: "roko-dim roko-count roko-mono" }, prompt.length + " / 8000")
          )
        ),
        !prompt.trim()
          ? h(
              "div",
              { className: "roko-examples" },
              h("span", { className: "rk-tiny" }, "try"),
              EXAMPLES.map(function (ex) {
                return h("button", { key: ex, type: "button", className: "roko-example", onClick: function () { setPrompt(ex); } }, ex);
              })
            )
          : null,
        h(
          "div",
          { className: "rk-device-grid" + (mode === "run" ? "" : " is-plan") },
          h(
            "div",
            { className: "rk-device-col" },
            h(
              "label",
              { className: "roko-field" },
              h("span", { className: "rk-module-head" }, h("span", { className: "rk-module-idx" }, "02"), h("span", { className: "rk-module-label" }, "TITLE"), h("span", { className: "rk-module-right" }, "optional")),
              h(Input, {
                type: "text",
                value: title,
                maxLength: 80,
                placeholder: "Names the run in lists",
                "aria-label": "Title",
                onChange: function (event) { setTitle(event.target.value); },
              })
            ),
            mode === "run"
              ? h(
                  "div",
                  { className: "roko-field" },
                  h("span", { className: "rk-module-head" }, h("span", { className: "rk-module-idx" }, "03"), h("span", { className: "rk-module-label" }, "CHECKED AS")),
                  h(
                    "div",
                    { className: "rk-keyrow", role: "group", "aria-label": "Kind of work" },
                    DOMAINS.map(function (d) {
                      return h(Key, { key: d.id, size: "s", label: d.label.toLowerCase(), title: d.hint, pressed: domain === d.id, onClick: function () { setDomain(d.id); } });
                    })
                  ),
                  h("span", { className: "roko-dim rk-small" }, (DOMAINS.filter(function (d) { return d.id === domain; })[0] || DOMAINS[0]).hint)
                )
              : null
          ),
          mode === "run"
            ? h(
                "div",
                { className: "roko-field rk-capfield" },
                h("span", { className: "rk-module-head" }, h("span", { className: "rk-module-idx" }, "04"), h("span", { className: "rk-module-label" }, "SPENDING CAP")),
                h(
                  "div",
                  { className: "rk-capctl" },
                  h(Knob, {
                    label: "Spending cap",
                    detents: CAP_PRESETS,
                    max: ceiling === null ? undefined : ceiling,
                    value: cap === "custom" ? (isNum(capValue) && capValue > 0 ? capValue : CAP_PRESETS[0]) : cap,
                    onChange: function (v) { setCap(v); },
                  }),
                  h(
                    "div",
                    { className: "rk-capcustom" },
                    h(Key, { size: "s", label: "custom", pressed: cap === "custom", onClick: function () { setCap("custom"); } }),
                    cap === "custom"
                      ? h(Input, {
                          type: "number",
                          inputMode: "decimal",
                          min: "0.01",
                          step: "0.01",
                          value: custom,
                          className: "roko-capinput",
                          placeholder: "0.75",
                          "aria-label": "Spending cap in US dollars",
                          "aria-invalid": capOk ? undefined : "true",
                          onChange: function (event) { setCustom(event.target.value); },
                        })
                      : null
                  )
                ),
                !capOk
                  ? h("span", { className: "roko-field-error" }, capTooHigh ? "Name a cap of at most " + money(ceiling) + "." : "Name a cap of at least $0.01.")
                  : h("span", { className: "roko-dim rk-small" }, "roko stops spending at the cap; the run is checked before it counts as done.")
              )
            : h("div", { className: "roko-dim roko-composer-note" }, h(Icon, { name: "info", size: 12 }), " The planner spends a little model budget and runs nothing. You review the plan, then run it with a cap.")
        ),
        error ? h(ErrorNote, { error: error, compact: true }) : null
      )
    );
  }

  // ---------------------------------------------------------------------------
  // Onboarding: the first visit, before any run
  // ---------------------------------------------------------------------------

  function Motif() {
    return h(
      "svg",
      { className: "roko-motif", viewBox: "0 0 240 120", width: 240, height: 120, "aria-hidden": "true" },
      h("path", { className: "roko-motif-edge", d: "M62 60 C96 60, 104 28, 138 28" }),
      h("path", { className: "roko-motif-edge", d: "M62 60 C96 60, 104 92, 138 92" }),
      h("path", { className: "roko-motif-edge roko-motif-flow", d: "M62 60 C96 60, 104 28, 138 28" }),
      h("path", { className: "roko-motif-edge", d: "M178 28 C196 28, 196 60, 214 60" }),
      h("path", { className: "roko-motif-edge", d: "M178 92 C196 92, 196 60, 214 60" }),
      h("rect", { className: "roko-motif-node is-ok", x: 14, y: 46, width: 48, height: 28, rx: 3 }),
      h("rect", { className: "roko-motif-node is-run", x: 138, y: 14, width: 40, height: 28, rx: 3 }),
      h("rect", { className: "roko-motif-node", x: 138, y: 78, width: 40, height: 28, rx: 3 }),
      h("circle", { className: "roko-motif-node", cx: 222, cy: 60, r: 8 }),
      h("path", { className: "roko-motif-check", d: "M30 60 L36 66 L47 54" })
    );
  }

  function Onboarding(props) {
    const canAct = useLimits().canAct;
    return h(
      "div",
      { className: "roko-onboard", "data-roko": "onboarding" },
      h(Motif),
      h("h2", { className: "roko-onboard-title" }, "Delegate checked work to roko"),
      h(
        "p",
        { className: "roko-onboard-lead" },
        "roko turns a request into small tasks, runs them on agents in parallel, and counts each one done only when your project's checks pass. You review the diff and merge it."
      ),
      h(
        "ol",
        { className: "roko-steps3" },
        h("li", null, h("span", { className: "roko-step-n" }, "1"), h("b", null, "Ask"), h("span", null, "here, or in any Hermes chat: “Use roko to … Cap it at $1.”")),
        h("li", null, h("span", { className: "roko-step-n" }, "2"), h("b", null, "Watch"), h("span", null, "tasks move through agents and checks, live, with the spend against its cap.")),
        h("li", null, h("span", { className: "roko-step-n" }, "3"), h("b", null, "Review and merge"), h("span", null, "the verified branch, file by file, in one guarded click."))
      ),
      canAct
        ? h(
            "div",
            { className: "roko-onboard-actions" },
            h(Button, { type: "button", onClick: function () { props.onCompose(""); } }, "New run"),
            h(
              "div",
              { className: "roko-examples" },
              EXAMPLES.map(function (ex) {
                return h("button", { key: ex, type: "button", className: "roko-example", onClick: function () { props.onCompose(ex); } }, ex);
              })
            )
          )
        : h("p", { className: "roko-dim" }, "Starting runs from the dashboard is turned off; ask Hermes in a chat instead.")
    );
  }

  function RunsSection(props) {
    const data = props.overview || {};
    const runs = list(data.runs);
    let selected = props.selectedRunId;
    if (!selected && runs.length) {
      const active = runs.filter(function (r) { return isActiveState(r.state); })[0];
      selected = (active || runs[0]).run_id;
    }
    if (!runs.length && !selected) {
      return h(Onboarding, { onCompose: props.onCompose });
    }
    const unreachable = data.connection && data.connection.reachable === false;
    return h(
      "div",
      { className: "roko-runs" },
      h(
        "div",
        { className: "roko-runs-side" },
        unreachable ? h("div", { className: "roko-note-line roko-dim" }, "Last known states: roko serve is unreachable.") : null,
        runs.length ? h(RunList, { runs: runs, pending: list(data.pending), selected: selected, onSelect: props.onSelectRun }) : null,
        h("div", { className: "roko-runs-keys roko-dim", "aria-hidden": "true" }, h(Kbd, null, "j"), h(Kbd, null, "k"), " move · ", h(Kbd, null, "n"), " new run · ", h(Kbd, null, "?"), " keys")
      ),
      selected
        ? h(RunView, {
            key: selected,
            runId: selected,
            source: (runs.filter(function (r) { return r.run_id === selected; })[0] || {}).source || null,
            initialTab: props.initialTab,
            notify: props.notify,
            onOpenPlan: props.onOpenPlan,
            onStarted: props.onStarted,
          })
        : null
    );
  }

  // ---------------------------------------------------------------------------
  // Waiting items (shared by the Waiting tab and the run view)
  // ---------------------------------------------------------------------------

  function Deadline(props) {
    const left = (ms(props.at) - props.now) / 1000;
    if (!isFinite(left)) return null;
    const title = "roko waits until " + wallClock(ms(props.at)) + "; then the task ends unverified";
    if (left <= 0) {
      return h("span", { className: "rk-deadline is-over", title: "roko's wait for this answer may have ended" }, h(Well, null, h(Dots, { value: "0:00", size: "S", ch: "fail", label: "deadline passed" })));
    }
    return h(
      "span",
      { className: "rk-deadline", title: title },
      h(Well, null, h(Dots, { value: clock(left), size: "S", ch: left < 60 ? "fail" : "you", label: "answer within " + clock(left) })),
      h("span", { className: "rk-tiny" }, "to answer")
    );
  }

  /** "REPORT.md:\n…" → a document box titled REPORT.md. */
  function splitDocument(summary) {
    const text = str(summary);
    const m = /^([\w./-]{1,80}):\n/.exec(text);
    return m ? { name: m[1], body: text.slice(m[0].length) } : { name: null, body: text };
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
          // roko's outcome when it adds something (an action applied, released); not the verb again.
          const said = str(res.data.outcome);
          const outcome = said && said.toLowerCase() !== (approve ? "approved" : "rejected") ? " (" + said + ")" : "";
          sound.play(approve ? "pass" : "key", { user: true });
          props.notify((approve ? "Approved " : "Rejected ") + str(res.data.title || item.title) + outcome, "success");
          props.onDecided(item, res.data);
          return;
        }
        setError(res.error);
        props.notify(res.error.message, "error");
        if (res.error.code === "not_found") props.onDecided(item, null);
      });
    }

    const effect = item.kind === "effect";
    const args = obj(item.arguments) ? Object.keys(item.arguments) : [];
    const doc = item.summary ? splitDocument(item.summary) : null;
    return h(
      "article",
      { className: "roko-pending" + (effect ? " roko-pending--effect" : ""), "data-roko-pending": str(item.code) },
      h(
        "div",
        { className: "roko-pending-top" },
        h(LED, { ch: "you" }),
        h("span", { className: "rk-ringtag", "data-ch": "you" }, effect ? "L0" : "L2"),
        h("span", { className: "rk-pending-kind" }, effect ? "held action" : "sign-off"),
        h("span", { className: "roko-pending-title" }, str(item.title)),
        item.kind === "confirm" && item.deadline_at ? h(Deadline, { at: item.deadline_at, now: props.now }) : null,
        h("span", { className: "roko-code", title: "the code /roko approve and /roko reject take" }, str(item.code))
      ),
      item.question ? h("div", { className: "roko-pending-question" }, str(item.question)) : null,
      doc
        ? h(
            "div",
            { className: "roko-doc" },
            h("div", { className: "roko-doc-head" }, h(Icon, { name: "doc", size: 12 }), h("span", null, doc.name || "What the task produced")),
            h(LongText, { value: doc.body, limit: 520, lines: 10 })
          )
        : null,
      effect
        ? h(
            "div",
            { className: "roko-effect" },
            h("div", { className: "roko-effect-call roko-mono" }, str(item.tool || "?"), h("span", { className: "roko-dim" }, " on "), str(item.server || "?")),
            args.length
              ? h(
                  "div",
                  { className: "roko-effect-args" },
                  h("span", { className: "roko-dim" }, "arguments (types only):"),
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
        item.proposed_at ? " · proposed " + ago(item.proposed_at, props.now) : "",
        props.onOpenRun && item.run_id
          ? h("button", { type: "button", className: "roko-linkbtn roko-pending-open", onClick: function () { props.onOpenRun(item.run_id); } }, "open the run →")
          : null
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
              placeholder: effect ? "Note for roko (optional)" : "Note for roko (optional; a reason helps a rejected task retry)",
              "aria-label": "Note for " + str(item.code),
              onChange: function (event) { setNote(event.target.value); },
              disabled: !!busy,
            }),
            h(Key, { tone: "you", disabled: !!busy, busy: busy === "approve", onClick: function () { decide(true); }, ariaLabel: "Approve " + str(item.code), label: busy === "approve" ? "approving…" : "approve" }),
            h(Key, { tone: "fail", disabled: !!busy, busy: busy === "reject", onClick: function () { decide(false); }, ariaLabel: "Reject " + str(item.code), label: busy === "reject" ? "rejecting…" : "reject" })
          ),
      error ? h(ErrorNote, { error: error, compact: true }) : null
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
          onOpenRun: props.onOpenRun,
        });
      })
    );
  }

  function WaitingSection(props) {
    const res = useResource("/pending", PENDING_POLL_MS);
    const [answered, setAnswered] = useState({});
    const items = res.data ? list(res.data.items).filter(function (it) { return !answered[it.decision_id]; }) : [];
    if (!res.data && res.error) return h(ErrorNote, { error: res.error, onRetry: res.reload });
    if (!res.data) return h(Loading, { label: "Loading what waits on you…" });
    return h(
      "div",
      { className: "roko-waiting" },
      res.error ? h(ErrorNote, { error: res.error, onRetry: res.reload }) : null,
      items.length
        ? h(
            "div",
            { className: "roko-waiting-head" },
            h("span", { className: "roko-waiting-count" }, String(items.length)),
            h("span", null, items.length === 1 ? "thing waits on you" : "things wait on you"),
            h("span", { className: "roko-dim" }, "roko holds these until you answer; nothing is approved for you.")
          )
        : null,
      h(PendingList, {
        items: items,
        notify: props.notify,
        onOpenRun: props.onOpenRun,
        empty: h(
          Empty,
          { icon: "inbox", title: "Nothing waits on you", className: "roko-empty--calm" },
          "When a roko run asks you to sign off on its result, or holds an action (a send, a post, a payment) for your approval, it shows up here."
        ),
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
    const ceiling = ceilingOf(limits);
    const [cap, setCap] = useState("1.00");
    const [resume, setResume] = useState(false);
    const [confirming, setConfirming] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const capValue = Number(cap);
    const capTooHigh = ceiling !== null && isFinite(capValue) && capValue > ceiling + 1e-9;
    const capOk = cap.trim() !== "" && isFinite(capValue) && capValue >= 0.01 && !capTooHigh;
    const est = obj(plan.estimate);

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
      h("div", { className: "roko-runform-title" }, h(Icon, { name: "play", size: 12 }), "Run this plan"),
      h(
        "div",
        { className: "roko-runform-fields" },
        h(
          "div",
          { className: "roko-runform-caps" },
          CAP_PRESETS.concat([5]).map(function (c) {
            const over = ceiling !== null && c > ceiling + 1e-9;
            const on = isFinite(capValue) && Math.abs(capValue - c) < 1e-9;
            return h(
              "button",
              {
                key: c,
                type: "button",
                className: "roko-chipbtn" + (on ? " is-on" : ""),
                disabled: over,
                "aria-pressed": on ? "true" : "false",
                onClick: function () { setCap(c.toFixed(2)); },
              },
              money(c)
            );
          })
        ),
        h(
          "label",
          { className: "roko-field roko-field--inline" },
          h("span", { className: "roko-field-label" }, "Cap (USD)"),
          h(Input, {
            type: "number",
            inputMode: "decimal",
            min: "0.01",
            step: "0.01",
            value: cap,
            className: "roko-capinput",
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
          h("span", null, "Resume the last run (skip tasks that already passed)")
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
          "roko runs " + plural(isNum(plan.task_count) ? plan.task_count : list(plan.tasks).length, "task", "tasks") +
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
    const [selected, setSelected] = useState(null);
    if (!res.data && res.error) return h(Panel, { title: "Plan " + str(props.planId) }, h(ErrorNote, { error: res.error, onRetry: res.reload }));
    if (!res.data) return h(Panel, { title: "Plan " + str(props.planId) }, h(Skeleton, { rows: 5 }));
    const plan = obj(res.data.plan) || {};
    const tasks = list(plan.tasks);
    const graph = planGraph(plan);
    const est = obj(plan.estimate);
    const current = tasks.filter(function (t) { return str(t.id) === selected; })[0] || null;
    return h(
      "div",
      { className: "roko-plandetail", "data-roko": "plan" },
      h(
        "header",
        { className: "roko-hero roko-hero--plan" },
        h(
          "div",
          { className: "roko-hero-top" },
          h(Pill, { tone: "idle" }, "plan"),
          h("span", { className: "roko-hero-id roko-mono" }, str(plan.plan_id || props.planId)),
          h(CopyButton, { value: plan.plan_id || props.planId, what: "plan id", compact: true }),
          h("span", { className: "roko-flex" }),
          h("button", { type: "button", className: "roko-iconbtn", "aria-label": "Refresh the plan", onClick: res.reload }, h(Icon, { name: "refresh", size: 13 }))
        ),
        h("h2", { className: "roko-hero-title" }, str(plan.title) || str(plan.plan_id || props.planId)),
        h(
          "div",
          { className: "roko-instruments" },
          h(Instrument, { label: "Tasks" }, h("span", { className: "roko-big roko-mono" }, String(isNum(plan.task_count) ? plan.task_count : tasks.length))),
          h(Instrument, { label: "Waves", sub: "tasks in a wave run together" }, h("span", { className: "roko-big roko-mono" }, String(graph.waves.length))),
          h(Instrument, { label: "Parallel" }, h("span", { className: "roko-big roko-mono" }, plan.max_parallel != null ? "≤ " + str(plan.max_parallel) : "—")),
          h(
            Instrument,
            { label: "Estimate", sub: est && est.confidence ? str(est.confidence) + " confidence" + (est.basis ? " · " + str(est.basis) : "") : "roko has no history to estimate from" },
            h(
              "span",
              { className: "roko-big roko-mono" },
              est ? money(est.total_cost_usd) : "—",
              est && isNum(est.total_duration_secs) ? h("span", { className: "roko-big-den" }, " · " + duration(est.total_duration_secs * 1000)) : null
            )
          )
        )
      ),
      h(
        "div",
        { className: "roko-overview" + (current ? " has-inspector" : "") },
        h(
          "div",
          { className: "roko-overview-graph" },
          h(RunGraph, {
            graph: graph,
            tasks: tasks.map(planTaskCard),
            planned: true,
            selected: selected,
            onSelect: function (id) { setSelected(id === selected ? null : id); },
          })
        ),
        current ? h(PlanTaskInspector, { task: current, onClose: function () { setSelected(null); } }) : null
      ),
      h(
        "div",
        { className: "roko-plantasks", role: "list", "aria-label": "The plan's tasks" },
        tasks.map(function (t) { return h(PlanTask, { key: str(t.id), task: t }); })
      ),
      h(RunPlanForm, { plan: Object.assign({ plan_id: props.planId }, plan), notify: props.notify, onStarted: props.onStarted })
    );
  }

  function PlanTaskInspector(props) {
    const t = props.task;
    const checks = list(t.checks);
    const files = list(t.files);
    return h(
      "aside",
      { className: "roko-inspector", "aria-label": "Task " + str(t.id) },
      h(
        "div",
        { className: "roko-inspector-head" },
        h("span", { className: "roko-inspector-id" }, str(t.id)),
        t.role ? h(Pill, { tone: "idle" }, str(t.role)) : null,
        t.tier ? h("span", { className: "roko-kind" }, str(t.tier)) : null,
        h("span", { className: "roko-flex" }),
        h("button", { type: "button", className: "roko-iconbtn", "aria-label": "Close the task", onClick: props.onClose }, h(Icon, { name: "x", size: 13 }))
      ),
      h("div", { className: "roko-inspector-title" }, str(t.title)),
      t.description ? h("div", { className: "roko-inspector-sec roko-inspector-sec--wide" }, h(LongText, { value: t.description, prose: true, limit: 600 })) : null,
      list(t.depends_on).length ? h("div", { className: "roko-dim" }, "after " + list(t.depends_on).map(str).join(", ")) : null,
      checks.length
        ? h(
            "div",
            { className: "roko-inspector-sec" },
            h(Label, null, "Checks that must pass"),
            h("ul", { className: "roko-checks" }, checks.map(function (c, i) { return h("li", { key: i }, h(Icon, { name: "gate", size: 12 }), h("code", { className: "roko-mono" }, str(c))); }))
          )
        : null,
      files.length
        ? h(
            "div",
            { className: "roko-inspector-sec" },
            h(Label, null, "Files"),
            h("div", { className: "roko-filechips" }, files.map(function (f, i) { return h("span", { key: i, className: "roko-filechip roko-mono" }, str(f)); }))
          )
        : null
    );
  }

  function PlanTask(props) {
    const t = props.task || {};
    const deps = list(t.depends_on);
    const checks = list(t.checks);
    return h(
      "div",
      { className: "roko-plantask", role: "listitem", "data-roko-plantask": str(t.id) },
      h(
        "div",
        { className: "roko-plantask-head" },
        h("span", { className: "roko-mono roko-task-id" }, str(t.id)),
        h("span", { className: "roko-plantask-title" }, str(t.title)),
        t.role ? h("span", { className: "roko-kind" }, str(t.role)) : null
      ),
      deps.length ? h("div", { className: "roko-dim" }, "after " + deps.map(str).join(", ")) : null,
      checks.length
        ? h(
            "ul",
            { className: "roko-checks" },
            checks.map(function (c, i) { return h("li", { key: i }, h(Icon, { name: "gate", size: 12 }), h("code", { className: "roko-mono" }, str(c))); })
          )
        : null
    );
  }

  function PlansSection(props) {
    const plansRes = useResource("/plans", 0);
    const plans = plansRes.data ? list(plansRes.data.plans) : [];
    const selected = props.selectedPlanId || (plans.length ? str(plans[0].id) : null);
    if (!plansRes.data && plansRes.error) return h(ErrorNote, { error: plansRes.error, onRetry: plansRes.reload });
    if (!plansRes.data) return h(Loading, { label: "Loading roko's plans…" });
    return h(
      "div",
      { className: "roko-plans" },
      h(
        "nav",
        { className: "roko-plans-side", "aria-label": "Plans" },
        h(
          "div",
          { className: "roko-rungroup-head" },
          h("span", null, plural(isNum(plansRes.data.total) ? plansRes.data.total : plans.length, "plan", "plans")),
          h("button", { type: "button", className: "roko-iconbtn", "aria-label": "Refresh the plans", onClick: plansRes.reload }, h(Icon, { name: "refresh", size: 12 }))
        ),
        plansRes.error ? h(ErrorNote, { error: plansRes.error, onRetry: plansRes.reload, compact: true }) : null,
        plans.length
          ? h(
              "div",
              { className: "roko-runlist", role: "list" },
              plans.map(function (p) {
                const isSel = str(p.id) === selected;
                const done = isNum(p.tasks_done) ? p.tasks_done : 0;
                const total = isNum(p.task_count) ? p.task_count : 0;
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
                  h("span", { className: "roko-runitem-glyph" }, h(Icon, { name: "graph", size: 13 })),
                  h(
                    "span",
                    { className: "roko-runitem-main" },
                    h("span", { className: "roko-runitem-top" }, h("span", { className: "roko-runitem-label" }, str(p.title) || str(p.id))),
                    h(
                      "span",
                      { className: "roko-runitem-meta" },
                      h(Pill, { tone: str(p.status).indexOf("not pass") >= 0 ? "bad" : str(p.status).indexOf("done") === 0 ? "ok" : "idle" }, str(p.status || "plan")),
                      h(SegBar, { progress: { total: total, passed: done, failed: isNum(p.tasks_not_passed) ? p.tasks_not_passed : 0, pending: Math.max(0, total - done) } }),
                      h("span", { className: "roko-runitem-cost" }, done + "/" + total)
                    ),
                    h("span", { className: "roko-runitem-id roko-mono" }, str(p.id))
                  )
                );
              })
            )
          : h(Empty, { icon: "graph", title: "roko has no plans yet" }, "Use New run → Plan it first, or ask Hermes to plan larger work with roko.")
      ),
      selected
        ? h(PlanDetail, { key: selected, planId: selected, notify: props.notify, onStarted: props.onRunStarted })
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
    const entries = res.data ? list(res.data.entries) : [];
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
        h("span", { className: "roko-search-icon", "aria-hidden": "true" }, h(Icon, { name: "search", size: 14 })),
        h(Input, {
          type: "search",
          value: query,
          placeholder: "What did roko learn about… (tests, the parser, flaky checks)",
          "aria-label": "Search roko's project knowledge",
          onChange: function (event) { setQuery(event.target.value); },
        }),
        h(Button, { size: "sm", type: "submit", disabled: !query.trim() }, "Search")
      ),
      !submitted ? h(Empty, { icon: "book", title: "Search roko's project knowledge" }, "Lessons, facts and warnings roko's verified runs recorded about this workspace. They are notes to weigh, not instructions.") : null,
      submitted && res.status === "loading" && !res.data ? h(Loading, { label: "Searching…" }) : null,
      submitted && res.error ? h(ErrorNote, { error: res.error, onRetry: res.reload }) : null,
      submitted && res.data && !entries.length ? h(Empty, { icon: "search", title: "Nothing found for “" + submitted + "”" }) : null,
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
                  h("span", { className: "roko-flex" }),
                  isNum(e.confidence)
                    ? h("span", { className: "roko-confidence", title: pct(e.confidence) + " confidence" }, h("span", { className: "roko-confidence-bar" }, h("span", { style: { width: pct(e.confidence) } })), pct(e.confidence) + " confidence")
                    : null,
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
  // Insights: how roko's workspace is doing
  // ---------------------------------------------------------------------------

  const CHECK_GLYPH = { ok: ["check", "ok"], warn: ["info", "warn"], fail: ["x", "bad"] };

  function rateTone(rate) {
    return rate == null ? "muted" : rate >= 0.9 ? "ok" : rate >= 0.7 ? "warn" : "bad";
  }

  /** Cumulative spend over time, with its scale written out. */
  function SpendChart(props) {
    const points = list(props.points).filter(function (p) { return p && isNum(p.cumulative_usd); });
    if (points.length < 2) {
      return h("div", { className: "roko-dim" }, points.length ? "Spend so far: " + money(points[0].cumulative_usd) : "No spend recorded yet.");
    }
    const W = 600;
    const H = 150;
    const values = points.map(function (p) { return p.cumulative_usd; });
    const times = points.map(function (p) { return ms(p.at); });
    const max = Math.max.apply(null, values) || 1;
    const t0 = isFinite(times[0]) ? times[0] : 0;
    const t1 = isFinite(times[times.length - 1]) ? times[times.length - 1] : 1;
    const span = Math.max(1, t1 - t0);
    const coords = points.map(function (p, i) {
      const t = isFinite(times[i]) ? times[i] : t0 + (i / (points.length - 1)) * span;
      return [((t - t0) / span) * W, H - (p.cumulative_usd / max) * (H - 6)];
    });
    const line = coords.map(function (c, i) { return (i ? "L" : "M") + c[0].toFixed(1) + " " + c[1].toFixed(1); }).join(" ");
    const area = line + " L" + W + " " + H + " L0 " + H + " Z";
    const label = "Cumulative spend from " + money(values[0]) + " to " + money(values[values.length - 1]) + " over " + points.length + " tasks";
    return h(
      "figure",
      { className: "roko-chart" },
      h(
        "div",
        { className: "roko-chart-plot" },
        h("span", { className: "roko-chart-y roko-chart-y--top" }, money(max)),
        h("span", { className: "roko-chart-y roko-chart-y--mid" }, money(max / 2)),
        h("span", { className: "roko-chart-y roko-chart-y--bottom" }, "$0"),
        h(
          "svg",
          { viewBox: "0 0 " + W + " " + H, preserveAspectRatio: "none", role: "img", "aria-label": label, className: "roko-chart-svg" },
          h("line", { x1: 0, x2: W, y1: H / 2, y2: H / 2, className: "roko-chart-grid" }),
          h("line", { x1: 0, x2: W, y1: 6, y2: 6, className: "roko-chart-grid" }),
          h("path", { d: area, className: "roko-chart-area" }),
          h("path", { d: line, className: "roko-chart-line" })
        )
      ),
      h(
        "figcaption",
        { className: "roko-chart-x" },
        h("span", null, isFinite(t0) && t0 ? wallClock(t0) : ""),
        h("span", { className: "roko-chart-total" }, money(values[values.length - 1]) + " cumulative"),
        h("span", null, isFinite(t1) && t1 ? wallClock(t1) : "")
      )
    );
  }

  /** A numbered readout: the value on the glass in its channel, a line of context under it. */
  function Kpi(props) {
    const ch = props.tone === "ok" ? "pass" : props.tone === "warn" ? "you" : props.tone === "bad" ? "fail" : undefined;
    return h(
      "div",
      { className: "roko-kpi rk-kpi" + (props.tone ? " roko-kpi--" + props.tone : "") },
      h("span", { className: "rk-module-head" }, h("span", { className: "rk-module-idx" }, props.index), h("span", { className: "rk-module-label" }, props.label)),
      h(Well, { className: "rk-kpi-well" }, h(Dots, { value: str(props.value), size: "L", ch: ch, label: str(props.value) })),
      props.sub ? h("div", { className: "roko-kpi-sub" }, props.sub) : null
    );
  }

  function HealthSection() {
    const health = useResource("/health", 0);
    const insights = useResource("/insights", 0);
    const checks = health.data ? list(health.data.checks) : [];
    const data = insights.data || {};
    const gates = list(data.gates);
    const models = list(data.models);
    const trend = list(data.cost_trend);
    const eff = obj(data.efficiency) || {};
    function reloadAll() { health.reload(); insights.reload(); }

    const gateRuns = gates.reduce(function (n, g) { return n + (isNum(g.total) ? g.total : 0); }, 0);
    const gatePassed = gates.reduce(function (n, g) { return n + (isNum(g.passed) ? g.passed : 0); }, 0);
    const gateRate = gateRuns ? gatePassed / gateRuns : null;
    const taskCount = models.reduce(function (n, m) { return n + (isNum(m.tasks) ? m.tasks : 0); }, 0);
    const taskRate = taskCount
      ? models.reduce(function (n, m) { return n + (isNum(m.tasks) && isNum(m.success_rate) ? m.tasks * m.success_rate : 0); }, 0) / taskCount
      : null;
    const bad = checks.filter(function (c) { return c.status !== "ok"; }).length;

    return h(
      "div",
      { className: "roko-health" },
      h(
        "div",
        { className: "roko-kpis" },
        h(Kpi, { index: "01", label: "Tasks that passed", tone: rateTone(taskRate), value: pct(taskRate), sub: taskCount ? plural(taskCount, "task", "tasks") + " recorded" : "no tasks recorded" }),
        h(Kpi, { index: "02", label: "Time per task", value: isNum(eff.avg_task_duration_ms) ? duration(eff.avg_task_duration_ms) : "—", sub: "on average" }),
        h(Kpi, { index: "03", label: "Spend", value: money(eff.total_cost_usd), sub: isNum(eff.cost_per_task_usd) && eff.cost_per_task_usd ? money(eff.cost_per_task_usd) + " per task" : "workspace-wide" }),
        h(Kpi, { index: "04", label: "Checks passed", tone: rateTone(gateRate), value: pct(gateRate), sub: gateRuns ? gatePassed + " of " + gateRuns + " check runs" : "no checks recorded" })
      ),
      !insights.data && insights.error ? h(ErrorNote, { error: insights.error, onRetry: insights.reload }) : null,
      h(
        Panel,
        { title: "Spend", icon: "chart", className: "roko-panel--chart" },
        insights.data ? h(SpendChart, { points: trend }) : h(Skeleton, { rows: 4 })
      ),
      h(
        "div",
        { className: "roko-health-grid" },
        h(
          "div",
          { className: "roko-health-col" },
        h(
          Panel,
          { title: "Checks", icon: "gate" },
          !insights.data && !insights.error ? h(Skeleton, { rows: 4 }) : null,
          insights.data && !gates.length ? h("div", { className: "roko-dim" }, "No check results recorded yet.") : null,
          gates.length
            ? h(
                "div",
                { className: "roko-bars" },
                gates.map(function (g, i) {
                  const rate = isNum(g.pass_rate) ? clamp(g.pass_rate, 0, 1) : null;
                  const tone = rateTone(rate);
                  return h(
                    "div",
                    { key: i, className: "roko-bar-row" },
                    h("span", { className: "roko-mono roko-bar-name", title: str(g.gate) }, str(g.gate)),
                    h(
                      "span",
                      { className: "roko-bar roko-tone-" + tone, role: "meter", "aria-valuemin": 0, "aria-valuemax": 1, "aria-valuenow": rate == null ? undefined : rate, "aria-label": "pass rate of " + str(g.gate) },
                      h("span", { className: "roko-bar-fill", style: { width: rate == null ? "0%" : (rate * 100).toFixed(1) + "%" } })
                    ),
                    h("span", { className: "roko-bar-value roko-tone-" + tone }, pct(rate)),
                    h("span", { className: "roko-bar-detail roko-dim" }, (isNum(g.passed) ? g.passed : 0) + "✓ " + (isNum(g.failed) ? g.failed : 0) + "✗" + (isNum(g.avg_duration_ms) ? " · " + duration(g.avg_duration_ms) : ""))
                  );
                })
              )
            : null
        ),
        h(
          Panel,
          { title: "Models", icon: "agent" },
          insights.data && !models.length ? h("div", { className: "roko-dim" }, "No model results recorded yet.") : null,
          models.length
            ? h(
                "table",
                { className: "roko-table" },
                h("thead", null, h("tr", null, h("th", null, "Model"), h("th", null, "Tasks"), h("th", null, "Passed"), h("th", null, "Cost"), h("th", null, "Per task"))),
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
                      h("td", { className: "roko-tone-" + rateTone(rate) }, pct(rate)),
                      h("td", null, money(m.total_cost_usd)),
                      h("td", { className: "roko-dim" }, moneyFine(m.avg_cost_usd))
                    );
                  })
                )
              )
            : null
        )
        ),
        h(
          Panel,
          {
            title: "Connection",
            icon: "pulse",
            actions: h("button", { type: "button", className: "roko-iconbtn", "aria-label": "Check again", onClick: reloadAll }, h(Icon, { name: "refresh", size: 13 })),
          },
          !health.data && health.error ? h(ErrorNote, { error: health.error, onRetry: health.reload }) : null,
          !health.data && !health.error ? h(Skeleton, { rows: 5 }) : null,
          checks.length
            ? h(
                "div",
                { className: "roko-checksum " + (bad ? "is-bad" : "is-ok") },
                bad ? plural(bad, "check needs", "checks need") + " a look" : "Every check passed"
              )
            : null,
          checks.length
            ? h(
                "ul",
                { className: "roko-checklist" },
                checks.map(function (c, i) {
                  const g = CHECK_GLYPH[c.status] || ["info", "muted"];
                  return h(
                    "li",
                    { key: i, className: "roko-check-row" },
                    h("span", { className: "roko-check-glyph roko-tone-" + g[1], "aria-label": str(c.status) }, h(Icon, { name: g[0], size: 12, weight: 2 })),
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
        )
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
    const canAct = useLimits().canAct;
    const liveState = useLiveStatus();
    const soundOn = useSound();
    let connection;
    if (!data && ov.error) {
      connection = h(
        "div",
        { className: "roko-conn" },
        h(LED, { ch: "off" }),
        h("span", null, ov.error.kind === "backend" ? "backend not loaded" : "dashboard server unreachable")
      );
    } else if (!conn) {
      connection = h("div", { className: "roko-conn" }, h(LED, { ch: "agent" }), h("span", null, "connecting…"));
    } else if (conn.reachable) {
      const degraded = conn.status && conn.status !== "ok";
      connection = h(
        "div",
        { className: "roko-conn" },
        h(LED, { ch: degraded ? "you" : "pass", blink: false, label: degraded ? "roko is degraded" : "roko is up" }),
        h("span", { className: "roko-conn-main" }, "roko " + (conn.version ? str(conn.version) : "") + (conn.status ? " · " + str(conn.status) : "")),
        h("span", { className: "roko-mono roko-dim roko-conn-url" }, str(conn.url))
      );
    } else {
      const e = conn.error || {};
      connection = h(
        "div",
        { className: "roko-conn roko-conn--down" },
        h(LED, { ch: "fail", blink: false, label: "roko is down" }),
        h("span", { className: "roko-conn-main" }, "roko serve unreachable"),
        h("span", { className: "roko-mono roko-dim roko-conn-url" }, str(conn.url)),
        e.message ? h("span", { className: "roko-conn-msg" }, str(e.message)) : null,
        e.hint ? h("span", { className: "roko-conn-hint roko-dim" }, str(e.hint)) : null
      );
    }
    const liveWord = liveState.status === "open" ? "live" : liveState.status === "down" ? "reconnecting" : liveState.status === "unsupported" ? "polling" : "connecting";
    const liveCh = liveState.status === "open" ? (liveState.healthy ? "agent" : "you") : liveState.status === "down" ? "fail" : "off";

    return h(
      "div",
      { className: "roko-head", "data-roko": "status" },
      h(
        "div",
        { className: "roko-brand" },
        h("span", { className: "rk-wordmark", "aria-label": "roko" }, h("span", { className: "rk-wordmark-dot", "aria-hidden": "true" }), "roko"),
        connection
      ),
      spend
        ? h(
            "div",
            { className: "roko-spend" },
            h(Well, { className: "rk-spendwell" }, h(Dots, { value: money(spend.today_usd), size: "M", pad: 6, ch: capTone(spend.today_usd, spend.max_day_usd) === "bad" ? "fail" : capTone(spend.today_usd, spend.max_day_usd) === "warn" ? "you" : undefined, label: "today " + money(spend.today_usd) })),
            h(
              "div",
              { className: "rk-spendinfo" },
              h(SegMeter, { value: spend.today_usd, projected: isNum(spend.committed_usd) ? (spend.today_usd || 0) + spend.committed_usd : null, max: spend.max_day_usd, label: "today's spend against the daily limit" }),
              h(
                "span",
                { className: "roko-spend-text" },
                "today " + money(spend.today_usd) + (isNum(spend.max_day_usd) ? " of " + money(spend.max_day_usd) : ""),
                isNum(spend.committed_usd) && spend.committed_usd > 0 ? h("span", { className: "roko-dim" }, " · " + money(spend.committed_usd) + " committed") : null,
                isNum(spend.max_day_usd) && isNum(spend.left_usd) ? h("span", { className: "roko-dim" }, " · " + money(spend.left_usd) + " left") : null
              )
            )
          )
        : null,
      h(
        "div",
        { className: "roko-head-end" },
        h("span", { className: "rk-live", title: liveState.status === "open" ? "roko's backend pushes changes as they happen" : liveState.status === "unsupported" ? "this dashboard cannot open the live socket; the page polls" : "the live socket is not open; the page polls meanwhile" }, h(LED, { ch: liveCh, blink: liveState.status === "down" ? "fast" : false }), liveWord),
        h(
          "span",
          { className: "rk-soundsw" },
          h("span", { className: "rk-tiny" }, "sound"),
          h(Switch, {
            size: "s",
            label: "Sound",
            value: soundOn ? "on" : "off",
            items: [{ id: "off", label: "off" }, { id: "on", label: "on" }],
            onChange: function (id) { sound.set(id === "on"); },
          })
        ),
        h("button", { type: "button", className: "roko-iconbtn", onClick: function () { overviewStore.refresh(); }, "aria-label": "Refresh roko's status", title: "Refresh" + (data && data.checked_at ? " (checked " + ago(data.checked_at) + ")" : "") }, h(Icon, { name: "refresh", size: 14 })),
        h("button", { type: "button", className: "roko-iconbtn", onClick: props.onHelp, "aria-label": "Keyboard shortcuts", title: "Keyboard shortcuts (?)" }, h(Icon, { name: "keyboard", size: 15 })),
        canAct && data
          ? h(Key, { tone: "you", label: "new run", kbd: "n", ariaLabel: "New run", keys: "n", className: "roko-newrun", onClick: function () { props.onCompose(""); } })
          : null
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

  const SHORTCUTS = [
    ["n", "New run"],
    ["j / ↓", "Next run"],
    ["k / ↑", "Previous run"],
    ["[ / ]", "The run's Overview, Activity, Loops and Changes"],
    ["Esc", "Close the task, or a dialog"],
    ["1 – 6", "Runs, Waiting, Plans, Loops, Insights, Knowledge"],
    ["?", "These keys"],
  ];

  function ShortcutHelp(props) {
    return h(
      Modal,
      { open: props.open, name: "keys", icon: "keyboard", title: "Keyboard", onClose: props.onClose },
      h(
        "dl",
        { className: "roko-keys" },
        SHORTCUTS.map(function (row) {
          return h(Fragment, { key: row[0] }, h("dt", null, row[0].split(" ").map(function (k, i) { return k === "/" || k === "–" ? h("span", { key: i, className: "roko-dim" }, " " + k + " ") : h(Kbd, { key: i }, k); })), h("dd", null, row[1]));
        })
      )
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
    const limits = useLimits();
    const toastApi = useToastImpl();
    const notify = toastApi.showToast;
    const initial = useMemo(readParams, []);
    const [section, setSectionState] = useState(validSection(initial.get("section")) || "runs");
    const [runId, setRunId] = useState(initial.get("run") || null);
    const [planId, setPlanId] = useState(initial.get("plan") || null);
    const [runTab] = useState(validRunTab(initial.get("view")));
    const [composer, setComposer] = useState({ open: false, prompt: "" });
    const [help, setHelp] = useState(false);
    const stateRef = useRef({});

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
      writeParams({ section: id === "runs" ? null : id, view: null });
    }
    function selectRun(id) {
      setRunId(id);
      setSectionState("runs");
      writeParams({ run: id, section: null, view: null });
    }
    function selectPlan(id) {
      setPlanId(id);
      setSectionState("plans");
      writeParams({ plan: id, section: "plans", view: null });
    }
    function compose(prompt) {
      setComposer({ open: true, prompt: prompt || "" });
    }

    const data = ov.data;
    const c = counts(data);
    const runs = data ? list(data.runs) : [];
    stateRef.current = { section: section, runId: runId, runs: runs, canAct: limits.canAct, data: data };

    // Page keys: n, j/k, 1–5, ?. They stay out of text fields and open dialogs.
    useEffect(function () {
      function onKey(event) {
        if (event.defaultPrevented || typingIn(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
        if (document.querySelector(".roko-modal")) return;
        const s = stateRef.current;
        if (!s.data) return;
        const key = event.key;
        if (key === "n" && s.canAct) {
          event.preventDefault();
          setComposer({ open: true, prompt: "" });
        } else if (key === "?") {
          event.preventDefault();
          setHelp(true);
        } else if (/^[1-6]$/.test(key)) {
          event.preventDefault();
          setSection(SECTIONS[Number(key) - 1].id);
        } else if ((key === "j" || key === "k" || key === "ArrowDown" || key === "ArrowUp") && s.section === "runs" && s.runs.length) {
          const order = [];
          groupRuns(s.runs, Date.now()).forEach(function (g) { g.runs.forEach(function (r) { order.push(r.run_id); }); });
          const current = s.runId && order.indexOf(s.runId) >= 0 ? order.indexOf(s.runId) : 0;
          const step = key === "j" || key === "ArrowDown" ? 1 : -1;
          const next = order[clamp(current + step, 0, order.length - 1)];
          if (next && next !== s.runId) {
            event.preventDefault();
            selectRun(next);
          }
        }
      }
      document.addEventListener("keydown", onKey);
      return function () { document.removeEventListener("keydown", onKey); };
    }, []);

    const blocked = !data && ov.error && ov.error.kind !== "roko";
    const loadingFirst = !data && !ov.error;

    let body = null;
    if (blocked) {
      body = h(BackendDown, { error: ov.error, onRetry: function () { overviewStore.refresh(); } });
    } else if (loadingFirst) {
      body = h("div", { className: "roko-firstload" }, h(Loading, { label: "Loading roko…" }), h(Skeleton, { rows: 6 }));
    } else if (section === "runs") {
      body = h(RunsSection, {
        overview: data,
        selectedRunId: runId,
        initialTab: runTab,
        onSelectRun: selectRun,
        onOpenPlan: selectPlan,
        onCompose: compose,
        onStarted: function (started) { if (started && started.run_id) selectRun(started.run_id); },
        notify: notify,
      });
    } else if (section === "waiting") {
      body = h(WaitingSection, { notify: notify, onOpenRun: selectRun });
    } else if (section === "plans") {
      body = h(PlansSection, {
        selectedPlanId: planId,
        onSelectPlan: selectPlan,
        notify: notify,
        onRunStarted: function (started) { if (started && started.run_id) selectRun(started.run_id); },
      });
    } else if (section === "loops") {
      body = h(LoopsSection, null);
    } else if (section === "knowledge") {
      body = h(KnowledgeSection, null);
    } else if (section === "health") {
      body = h(HealthSection, null);
    }

    const badges = { runs: c.running + c.queued, waiting: c.waiting };
    return h(
      "div",
      { className: "roko" + (light ? " roko--light" : ""), "data-roko": "page" },
      h(StatusHeader, { overview: ov, onCompose: compose, onHelp: function () { setHelp(true); } }),
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
      h(Composer, {
        open: composer.open,
        prompt: composer.prompt,
        notify: notify,
        onClose: function () { setComposer({ open: false, prompt: "" }); },
        onStarted: function (started) { if (started && started.run_id) selectRun(started.run_id); },
      }),
      h(ShortcutHelp, { open: help, onClose: function () { setHelp(false); } }),
      h(ToastView, { toast: toastApi.toast })
    );
  }

  function RokoPageRoot() {
    return h(ErrorBoundary, null, h(RokoPage));
  }

  // ---------------------------------------------------------------------------
  // Slots
  // ---------------------------------------------------------------------------

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

  /** The newest active run's progress, for the small ring in the chip and the banner. */
  function liveRun(data) {
    let best = null;
    (data ? list(data.runs) : []).forEach(function (r) {
      if (r.state === "running" && obj(r.progress) && r.progress.total && (!best || r.progress.total > best.progress.total)) best = r;
    });
    return best;
  }

  function liveProgress(data) {
    const run = liveRun(data);
    return run ? run.progress : null;
  }

  /** Whether the run `liveProgress` follows waits on the person. */
  function liveWaits(data) {
    return runWaits(liveRun(data), data && data.pending);
  }

  /**
   * `header-right`: "roko ▪▪▪▫▫ 1 running · 2 waiting", or just "roko ●" when idle.
   * The slot sits in the sidebar footer next to the theme and language switchers, so
   * the chip measures itself before paint and steps down (most urgent count only, then
   * a number, then the light alone) until it fits; the tooltip always has the full text.
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
    const ch = down ? "fail" : c.waiting ? "you" : active ? "agent" : "off";
    const progress = liveProgress(data);
    const title = down
      ? "roko serve is unreachable" + (conn.error && conn.error.message ? ": " + str(conn.error.message) : "")
      : labels.parts.length
        ? "roko: " + labels.parts.join(", ") + (progress ? " (" + (progress.passed || 0) + " of " + progress.total + " tasks done)" : "")
        : "roko: idle";
    const path = "/roko" + (c.waiting ? "?section=waiting" : "");
    // Levels: 0 "roko ● ▪▪▪ 1 running · 2 waiting", 1 "roko ● 2 waiting", 2 "roko ●"
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
      h(LED, { ch: ch, blink: down || !(active || c.waiting) ? false : undefined }),
      progress && !down && level < 2 ? h(StepStrip, { progress: progress, max: 8, waiting: liveWaits(data) }) : null,
      detail ? h("span", { className: level === 3 ? "roko-chip-count" : "roko-chip-text" }, detail) : null
    );
  }

  /** The newest active run in the overview, and the socket's newest agent step for it. */
  function useNewestActive(data) {
    const runs = data ? list(data.runs).filter(isRunActive) : [];
    const run = runs.length ? runs.reduce(function (a, b) { return ms(b.started_at) > ms(a.started_at) ? b : a; }) : null;
    const runId = run ? str(run.run_id) : null;
    useLiveVersion(runId || undefined, ["live"]);
    let step = null;
    let stepKey = null;
    let stepWords = false;
    if (runId) {
      const live = liveStore.live(runId);
      const recent = live ? live.recent : [];
      const last = recent.length ? recent[recent.length - 1] : null;
      if (last && Date.now() - last.seen_at < 120000) {
        stepWords = last.kind !== "tool";
        step = str(last.task_id) + " " + (stepWords ? "“" + oneLineEnd(last.said || last.text, 80) + "”" : "▸ " + str(last.tool) + (last.target ? " " + oneLine(last.target, 60) : ""));
        // One key per stretch of words, so the strip holds still while they grow.
        stepKey = stepWords ? "w" + str(last.task_id) + ":" + str(last.stretch) : step;
      }
    }
    return { run: run, step: step, stepKey: stepKey, stepWords: stepWords, more: Math.max(0, runs.length - 1) };
  }

  /** The strip's newest agent move; words keep their newest end in view (a long line is cut on the left). */
  function LiveStep(props) {
    const newest = props.newest;
    return h(
      "span",
      { className: "rk-livestrip-step roko-mono" + (newest.stepWords ? " is-words" : "") },
      newest.stepWords ? h("span", null, newest.step) : newest.step
    );
  }

  /** `sessions:top`: a live strip while runs started from Hermes are active or something waits. */
  function SessionsBanner() {
    const ov = useOverview();
    const light = useLightTheme();
    const data = ov.data;
    const newest = useNewestActive(data);
    if (!data) return null;
    const c = counts(data);
    if (!(c.running || c.queued || c.waiting)) return null;
    const parts = [];
    if (c.running) parts.push(plural(c.running, "run", "runs") + " running");
    if (c.queued) parts.push(plural(c.queued, "run", "runs") + " queued");
    if (c.waiting) parts.push(c.waiting === 1 ? "1 item waits on you" : c.waiting + " items wait on you");
    const path = "/roko" + (c.waiting ? "?section=waiting" : "");
    const progress = liveProgress(data);
    return h(
      "div",
      { className: "roko-banner rk-livestrip roko-tone-scope" + (light ? " roko--light" : ""), role: "status", "data-roko": "banner" },
      h(LED, { ch: c.waiting ? "you" : "agent" }),
      h("span", { className: "roko-banner-text" }, "roko: " + parts.join(" · ")),
      progress ? h(StepStrip, { progress: progress, waiting: liveWaits(data) }) : null,
      progress ? h("span", { className: "roko-banner-sub roko-dim" }, (progress.passed || 0) + "/" + progress.total + " tasks") : null,
      newest.step ? h(LiveStep, { key: newest.stepKey, newest: newest }) : null,
      h("a", linkProps(path, { className: "roko-banner-link" }), "open →")
    );
  }

  /** `chat:top`: while a run is active, a strip above the chat with its progress and its agent's step. */
  function ChatStrip() {
    const ov = useOverview();
    const light = useLightTheme();
    const data = ov.data;
    const newest = useNewestActive(data);
    if (!data) return null;
    const c = counts(data);
    const run = newest.run;
    if (!run && !c.waiting) return null;
    const path = c.waiting && !run ? "/roko?section=waiting" : "/roko?run=" + enc(run.run_id);
    const progress = run ? obj(run.progress) : null;
    return h(
      "div",
      { className: "roko-banner rk-livestrip rk-chatstrip roko-tone-scope" + (light ? " roko--light" : ""), role: "status", "data-roko": "chatstrip" },
      h(LED, { ch: run ? (c.waiting ? "you" : "agent") : "you" }),
      h("span", { className: "rk-chatstrip-name" }, "roko"),
      run ? h("span", { className: "roko-banner-text", title: str(run.label) }, oneLine(run.label, 70) || "a run") : h("span", { className: "roko-banner-text" }, c.waiting === 1 ? "1 item waits on you" : c.waiting + " items wait on you"),
      progress && progress.total ? h(StepStrip, { progress: progress, waiting: runWaits(run, data.pending) }) : null,
      run && isNum(run.cost_usd) ? h(Well, { className: "rk-chatstrip-well" }, h(Dots, { value: moneyFine(run.cost_usd), size: "S", label: "spent " + moneyFine(run.cost_usd) })) : null,
      newest.step ? h(LiveStep, { key: newest.stepKey, newest: newest }) : null,
      run && c.waiting ? h("span", { className: "rk-chatstrip-wait" }, plural(c.waiting, "item waits", "items wait") + " on you") : null,
      newest.more ? h("span", { className: "roko-dim" }, "+" + newest.more + " more") : null,
      h("a", linkProps(path, { className: "roko-banner-link" }), "open in roko →")
    );
  }

  /** A route read once for a slot card (and every `intervalMs`); nothing while it fails. */
  function useSlotResource(path, intervalMs) {
    const res = useResource(path, intervalMs);
    return res.status === "ok" || (res.data && res.status !== "error") ? res.data : null;
  }

  /** `analytics:top`: roko's spend today, how its checks went, and its five loops. */
  function AnalyticsCard() {
    const ov = useOverview();
    const light = useLightTheme();
    const data = ov.data;
    const loops = useSlotResource(data ? "/loops" : null, 60000);
    const insights = useSlotResource(data ? "/insights" : null, 0);
    if (!data) return null;
    const spend = obj(data.spend) || {};
    const gates = insights ? list(insights.gates).filter(obj) : [];
    const ran = gates.reduce(function (n, g) { return n + (isNum(g.total) ? g.total : 0); }, 0);
    const passed = gates.reduce(function (n, g) { return n + (isNum(g.passed) ? g.passed : 0); }, 0);
    const rate = ran ? passed / ran : null;
    const rings = loops ? list(loops.rings).filter(obj) : [];
    const models = list((rings.filter(function (r) { return r.ring === "L3"; })[0] || {}).models).filter(obj);
    const topModel = models.reduce(function (best, m) { return !best || (m.tasks || 0) > (best.tasks || 0) ? m : best; }, null);
    const state = {};
    rings.forEach(function (r) { state[str(r.ring)] = r; });
    return h(
      "section",
      { className: "rk-slotcard roko-tone-scope" + (light ? " roko--light" : ""), "data-roko": "analytics-card", "aria-label": "roko" },
      h(
        "header",
        { className: "rk-slotcard-head" },
        h("span", { className: "rk-wordmark rk-wordmark--s" }, h("span", { className: "rk-wordmark-dot", "aria-hidden": "true" }), "roko"),
        h("span", { className: "rk-tiny" }, "checked work · " + plural(isNum(spend.runs_today) ? spend.runs_today : 0, "run", "runs") + " today · " + counts(data).running + " running"),
        h("span", { className: "roko-flex" }),
        h("a", linkProps("/roko?section=health", { className: "roko-banner-link" }), "insights →")
      ),
      h(
        "div",
        { className: "rk-well rk-display rk-display--slot" },
        h(
          Cell,
          { index: "03", label: "SPEND TODAY", sub: isNum(spend.max_day_usd) ? h(SegMeter, { value: spend.today_usd, max: spend.max_day_usd, label: "today's spend against the daily limit" }) : null },
          h(Dots, { value: money(spend.today_usd), size: "L", label: "today " + money(spend.today_usd) + (isNum(spend.max_day_usd) ? " of " + money(spend.max_day_usd) : "") })
        ),
        h(
          Cell,
          { index: "04", label: "CHECKS", sub: ran ? passed + " of " + ran + " check runs passed" : "no checks recorded" },
          h(Dots, { value: rate === null ? "—" : Math.round(rate * 100) + "%", size: "L", ch: rate === null ? undefined : rate >= 0.8 ? "pass" : rate >= 0.5 ? "you" : "fail", label: rate === null ? "no checks" : pct(rate) + " of checks passed" })
        ),
        h(
          Cell,
          { index: "05", label: "MODELS", sub: topModel ? str(topModel.model) + (isNum(topModel.success_rate) ? " · " + pct(topModel.success_rate) + " of tasks passed" : "") : "none scored yet" },
          h(Dots, { value: String(models.length), size: "L", label: plural(models.length, "model", "models") + " routed" })
        ),
        h(
          Cell,
          { index: "06", label: "LOOPS", className: "rk-cell--loops", sub: rings.length ? rings.filter(function (r) { return r.state === "active"; }).length + " of 5 active" : "—" },
          h(
            "span",
            { className: "rk-ringleds" },
            RINGS.map(function (ring) {
              const r = state[ring.id];
              const recent = r ? list(r.recent) : [];
              const last = recent.length ? recent[recent.length - 1] : null;
              return h(
                "span",
                { key: ring.id, className: "rk-ringled", title: ring.id + " " + ring.name + (r ? ": " + str(r.state) : "") },
                h(LED, { ch: last ? loopChannel(last) : r && r.state === "active" ? "agent" : "off", blink: false }),
                h("span", null, ring.id)
              );
            })
          )
        )
      )
    );
  }

  /** `models:top`: the models roko routes between, as its own scorecard rates them. */
  function ModelsCard() {
    const ov = useOverview();
    const light = useLightTheme();
    const data = ov.data;
    const loops = useSlotResource(data ? "/loops" : null, 60000);
    if (!data || !loops) return null;
    const L3 = list(loops.rings).filter(function (r) { return obj(r) && r.ring === "L3"; })[0] || {};
    const models = list(L3.models).filter(obj);
    if (!models.length) return null;
    return h(
      "section",
      { className: "rk-slotcard roko-tone-scope" + (light ? " roko--light" : ""), "data-roko": "models-card", "aria-label": "roko's models" },
      h(
        "header",
        { className: "rk-slotcard-head" },
        h("span", { className: "rk-wordmark rk-wordmark--s" }, h("span", { className: "rk-wordmark-dot", "aria-hidden": "true" }), "roko"),
        h("span", { className: "rk-tiny" }, "routes tasks between these models, by how each did"),
        h("span", { className: "roko-flex" }),
        h("a", linkProps("/roko?section=loops", { className: "roko-banner-link" }), "loops →")
      ),
      h(
        "ol",
        { className: "rk-modelrows" },
        models.slice(0, 6).map(function (m, i) {
          const rate = isNum(m.success_rate) ? m.success_rate : null;
          const ch = rate === null ? "off" : rate >= 0.8 ? "pass" : rate >= 0.5 ? "you" : "fail";
          return h(
            "li",
            { key: str(m.model) + i, className: "rk-modelrow" },
            h("span", { className: "roko-mono rk-modelrow-name" }, h(LED, { ch: ch, blink: false }), str(m.model)),
            h("span", { className: "rk-rate" }, h("span", { className: "rk-rate-bar", "data-ch": ch, style: { width: ((rate || 0) * 100).toFixed(0) + "%" } })),
            h(Well, { className: "rk-modelrow-well" }, h(Dots, { value: rate === null ? "—" : Math.round(rate * 100) + "%", size: "S", ch: ch === "off" ? undefined : ch, label: rate === null ? "no rate" : pct(rate) + " of tasks passed" })),
            h("span", { className: "roko-dim" }, [isNum(m.tasks) ? plural(m.tasks, "task", "tasks") : null, isNum(m.avg_cost_usd) ? moneyFine(m.avg_cost_usd) + " a task" : null].filter(Boolean).join(" · "))
          );
        })
      )
    );
  }

  function HeaderChipRoot() { return h(ErrorBoundary, { silent: true }, h(HeaderChip)); }
  function SessionsBannerRoot() { return h(ErrorBoundary, { silent: true }, h(SessionsBanner)); }
  function ChatStripRoot() { return h(ErrorBoundary, { silent: true }, h(ChatStrip)); }
  function AnalyticsCardRoot() { return h(ErrorBoundary, { silent: true }, h(AnalyticsCard)); }
  function ModelsCardRoot() { return h(ErrorBoundary, { silent: true }, h(ModelsCard)); }

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
    PLUGINS.registerSlot(PLUGIN, "chat:top", ChatStripRoot);
    PLUGINS.registerSlot(PLUGIN, "analytics:top", AnalyticsCardRoot);
    PLUGINS.registerSlot(PLUGIN, "models:top", ModelsCardRoot);
  }
  window.__ROKO_DASHBOARD_VERSION__ = VERSION;
})();

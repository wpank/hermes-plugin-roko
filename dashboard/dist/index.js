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
  const VERSION = "0.5.0";
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
  // Generic requests that name no file a project may lack (the desktop's three); a backend that knows the
  // project sends its own (`examples` on /overview).
  const EXAMPLES = [
    "Add a --json flag to the CLI that prints the report as JSON, with a test for it.",
    "Write REPORT.md: a one-page summary of the public API with an example for each function.",
    "Find the test that fails on a clean checkout, fix the cause, and keep every other test green.",
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
      // roko stopped while it went (a restart or a crash): not a verdict on the work, which is kept.
      case "interrupted": return "warn";
      case "running": return "run";
      case "queued": return "idle";
      default: return "muted";
    }
  }
  function isActiveState(state) { return state === "running" || state === "queued"; }

  /** A run's state in words. A plan generation that succeeded wrote a plan and ran nothing: it says so. */
  /**
   * roko stopped the run at its cap (`budget_stop`, 0.5.0; roko bug-4fabd0): a stop, not a failure. `state` stays
   * roko's `failed`, so every reader that knows the field says "stopped · cap" instead.
   */
  function capStop(run) {
    return run && str(run.state) === "failed" && obj(run.budget_stop) ? run.budget_stop : null;
  }
  /** "roko stopped the run at its cap of $0.05 ($0.032 spent)", with what roko gave of the figures. */
  function capStopWords(stop) {
    // Amounts as roko gives them: to a hundredth of a cent below 10¢ ("$0.0264"), else to the cent.
    function amount(v) {
      const fixed = v < 0.1 ? v.toFixed(4).replace(/0{1,2}$/, "") : v.toFixed(2);
      return "$" + fixed;
    }
    const cap = isNum(stop.cap_usd) ? " of " + amount(stop.cap_usd) : "";
    const spent = isNum(stop.spent_usd) ? " (" + amount(stop.spent_usd) + " spent)" : "";
    // `limit: "day"` is roko's daily limit (budget.max_daily_usd), not the run's cap.
    return "roko stopped the run at " + (str(stop.limit) === "day" ? "today's limit" : "its cap") + cap + spent;
  }

  /** A written plan roko's validator rejects (`validation`, 0.5.0): the person answers its questions first. */
  function planBlocked(run) {
    return !!(run && obj(run.validation) && run.validation.valid === false);
  }

  function stateWord(run) {
    const state = str(run && run.state);
    if (capStop(run)) return str(capStop(run).limit) === "day" ? "stopped · day limit" : "stopped · cap";
    if (run && run.kind === "plan_generate") {
      if (state === "succeeded") return planBlocked(run) ? "cannot run yet" : "plan written";
      if (state === "running" || state === "queued") return "planning";
      if (state === "failed") return "planning failed";
    }
    return state || "unknown";
  }

  /** A run that is going and waits on the person: its colour is orange, "you", and its lights blink fast. */
  function runWaits(run, pending) {
    if (!run || !isActiveState(run.state)) return false;
    if (list(run.waiting).some(function (item) { return !answeredStore.has(item); })) return true;
    const id = str(run.run_id);
    return list(pending).some(function (item) { return item && str(item.run_id) === id && !answeredStore.has(item); });
  }
  function isRunActive(run) { return !!run && (run.active === true || isActiveState(run.state)); }

  /** A task's state for the graph: one of the node classes. */
  function nodeState(outcome) {
    switch (outcome) {
      case "passed":
      case "succeeded":
      case "already_satisfied":
      case "passed_with_preexisting_failures": // its checks passed; what failed had failed before it
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
      case "condition-skipped": // roko did not select it: its condition did not hold
      case "stopped":
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
      case "interrupted":
      case "held":
        return "you";
      default:
        return "off";
    }
  }

  /** A run's channel: you when it waits on the person; a written plan is monochrome (nothing ran, nothing checked). */
  function runChannel(run, waits) {
    if (waits) return "you";
    // A cap's stop is a stop: unlit, as a cancelled run is; never red.
    if (capStop(run)) return "off";
    if (run.kind === "plan_generate" && run.state === "succeeded") return planBlocked(run) ? "you" : "off";
    if (run.state === "cancelled") return "off";
    return channelOf(run.state);
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
        // A refusal that names a setup problem: shown as that problem, with its fix.
        const problem = readProblem(body.problem);
        return {
          ok: false,
          error: {
            kind: "roko",
            code: str(e.code) || "internal",
            message: str(e.message) || (problem ? problem.title : "roko reported a problem."),
            hint: e.hint ? str(e.hint) : null,
            problem: problem,
            // 0.5.0: a plan run roko refused because the plan fails its validator (`PlanValidation`).
            validation: obj(body.validation) && body.validation.valid === false ? body.validation : null,
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

  /**
   * The sign-offs and held actions the person just answered. roko still lists one for about 2 s, so every list
   * (Waiting, the overview's `pending` and `counts.waiting`, a run card's `waiting`) leaves it out at once; a code
   * is forgotten once roko's full list no longer has it, or after 60 s (the desktop's rule).
   */
  const answeredStore = (function () {
    const at = new Map();
    const KEEP_MS = 60000;
    function keyOf(item) { return str(item && (item.code || item.decision_id)); }
    function fresh(key) {
      if (!key || !at.has(key)) return false;
      if (Date.now() - at.get(key) > KEEP_MS) {
        at.delete(key);
        return false;
      }
      return true;
    }
    return {
      add: function (item) { const key = keyOf(item); if (key) at.set(key, Date.now()); },
      has: function (item) { return fresh(keyOf(item)); },
      /** roko's whole list of what waits: a code it no longer has is forgotten. */
      settle: function (items) {
        const listed = new Set(list(items).map(keyOf));
        Array.from(at.keys()).forEach(function (key) { if (!listed.has(key)) at.delete(key); });
      },
    };
  })();

  const overviewStore = (function () {
    let state = { status: "idle", data: null, error: null, at: 0 };
    const listeners = new Set();
    const backListeners = new Set();
    let timer = null;
    let inflight = null;
    // Whether the last answer found roko serve answering: null before the first one.
    let up = null;

    function emit() {
      const now = state.status === "ok" ? !rokoDown(state.data) : state.status === "error" ? false : up;
      const back = up === false && now === true;
      up = now;
      listeners.forEach(function (fn) {
        try { fn(state); } catch (_) { /* a broken listener must not stop the others */ }
      });
      // roko (or the backend) answers again: every view that failed while it was away reloads by itself.
      if (back) {
        backListeners.forEach(function (fn) {
          try { fn(); } catch (_) { /* a broken listener must not stop the others */ }
        });
      }
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
      /** Re-show the last answer (readers leave out what was just answered); no request. */
      touch: function () {
        state = Object.assign({}, state);
        emit();
      },
      /** Call `fn` when an overview finds roko answering after one that did not; returns the unsubscribe. */
      onBack: function (fn) {
        backListeners.add(fn);
        return function () { backListeners.delete(fn); };
      },
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
    // What the person just answered that roko still lists (for about 2 s) no longer waits.
    const gone = pendingItems.filter(function (item) { return answeredStore.has(item); }).length;
    return {
      running: isNum(c.running) ? c.running : runs.filter(function (r) { return r.state === "running"; }).length,
      queued: isNum(c.queued) ? c.queued : runs.filter(function (r) { return r.state === "queued"; }).length,
      waiting: Math.max(0, (isNum(c.waiting) ? c.waiting : pendingItems.length) - gone),
    };
  }

  /** roko serve did not answer the backend's last look: every run on the page is its last known state. */
  function rokoDown(data) {
    return !!(data && obj(data.connection) && data.connection.reachable === false);
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
        } else if (card.state === "failed" && !capStop(card)) {
          // A cap's stop is not a failure: no fail sound, no red pulse.
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
          // An agent's steps and words come only from roko's event stream: it is open.
          if (hub !== "open") {
            hub = "open";
            emit("status", null, null);
          }
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

  /**
   * The page's live light, honestly: LIVE only while the socket is open, roko's event stream (the relay's
   * `hub`, absent from an older backend) is open and roko serve answers. roko down is OFFLINE, in red; a
   * socket without roko's stream is POLLING, unlit (the page asks every few seconds).
   */
  function liveIndicator(liveState, down) {
    if (down) {
      return { word: "offline", ch: "fail", blink: false, title: "roko serve isn't answering: nothing streams. The page asks again every few seconds." };
    }
    if (liveState.status === "open") {
      if (liveState.hub === "connecting") {
        return { word: "connecting", ch: "off", blink: false, title: "connecting to roko's live event stream; the page polls meanwhile" };
      }
      if (liveState.hub && liveState.hub !== "open") {
        return { word: "polling", ch: "off", blink: false, title: "roko's live event stream is not connected (roko is restarting, or older): the page asks every few seconds" };
      }
      return { word: "live", ch: liveState.healthy ? "agent" : "you", blink: undefined, title: "roko's backend pushes changes as they happen" };
    }
    if (liveState.status === "down") return { word: "reconnecting", ch: "fail", blink: "fast", title: "the live socket dropped; the page polls while it reconnects" };
    if (liveState.status === "unsupported") return { word: "polling", ch: "off", blink: false, title: "this dashboard cannot open the live socket; the page polls" };
    return { word: "connecting", ch: "off", blink: false, title: "opening the live socket; the page polls meanwhile" };
  }

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
    // A view that failed while roko (or the backend) was away reloads when it answers again: no Retry needed.
    const failedRef = useRef(false);
    failedRef.current = state.status === "error";
    useEffect(function () {
      return overviewStore.onBack(function () { if (failedRef.current) reload(); });
    }, [reload]);
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
    skip: [["circle", { cx: 8, cy: 8, r: 5.6 }], ["path", { d: "M4.1 4.1 L11.9 11.9" }]],
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
    // 0.5.0: tasks roko skipped because no route of the plan chose them (neither failed nor stopped).
    ["skipped", "muted"],
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
      { className: "roko-pips", role: "img", "aria-label": pips.map(function (p) { return str(p.gate) + " " + (p.passed === true ? "passed" : p.passed === false ? "did not pass" : "running") + (p.superseded ? ", an earlier attempt" : ""); }).join(", ") },
      pips.slice(0, 12).map(function (pip, i) {
        const cls = pip.passed === true ? "ok" : pip.passed === false ? "bad" : pip.live ? "live" : "idle";
        return h("span", { key: i, className: "roko-pip roko-pip--" + cls, "data-superseded": pip.superseded ? "true" : undefined, title: str(pip.gate) + (pip.superseded ? " (an earlier attempt)" : "") });
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
    // roko serve is down, and the page already says so with the fix (the header, the setup module): a view that
    // could not load says only that it comes back by itself, without the connection's hint again.
    if (e.code === "unreachable" && rokoDown(overviewStore.get().data)) {
      return h(
        "div",
        { className: "roko-error roko-error--away" + (props.compact ? " roko-error--compact" : ""), role: "status", "data-roko": "away" },
        h("div", { className: "roko-error-msg" }, h(LED, { ch: "fail", blink: false }), h("span", null, "roko serve is not answering.")),
        h("div", { className: "roko-error-hint" }, "This comes back by itself when it answers; the page asks every few seconds.")
      );
    }
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
    ["skipped", "off"],
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

  /**
   * A loop event's words: the backend's own (`text`), as the desktop shows them. An older backend wrote bare
   * numbers for a learning loop's health ("· h 0.20") and a route ("(ladder; p 1.00; over claude-haiku-4-5
   * 0.00)"); those the page says in words from `data`: "model routing: on probation · holdout 20%",
   * "T1 attempt 1 → glm-5.1, picked by the model ladder (rung mid)".
   */
  function loopText(ev) {
    const data = obj(ev && ev.data) || {};
    const said = str(ev && ev.text);
    if (ev && ev.kind === "loop_health" && str(data.loop_id) && (!said || /· h \d/.test(said))) {
      const words = loopHealthWords({ loop_id: data.loop_id, state: data.state, reason: data.reason, h: data.h, eps: data.eps });
      return words.name + ": " + words.line;
    }
    if (ev && ev.kind === "route" && str(data.model) && !/, (picked by|switched by|roko's default)/.test(said)) {
      const view = routeView(data);
      const odds = routeOdds(data, view);
      return (ev.task_id ? str(ev.task_id) + " " : "") + (isNum(data.attempt) ? "attempt " + data.attempt + " " : "") + "→ " + str(data.model) +
        ", " + view.words + (view.rung ? " (rung " + view.rung + ")" : odds ? " (" + odds + ")" : "");
    }
    return said;
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
      h("span", { className: "rk-loopline-text" }, oneLine(loopText(ev), 220)),
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
    // A timeline that failed while roko was away is read again when it answers.
    const failedRef = useRef(false);
    failedRef.current = !!state.error;
    useEffect(function () {
      return overviewStore.onBack(function () { if (failedRef.current && kickRef.current) kickRef.current(); });
    }, []);
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
    // `superseded` (0.5.0): a verdict from an earlier attempt, which roko retried; shown dim.
    if (!lastAttempt) pips = list(task.gates).map(function (g) { return { gate: g.gate, passed: g.passed === true, superseded: g.superseded === true }; });
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
  // Outcomes whose own word or glyph says more than their node class (render.py: ✓ and ⊘), and the muted note the
  // inspector adds when roko gives no reason.
  // The words are hermes-update's, from roko's own definitions (baseline_verify.rs; engine.rs ConditionSkipped).
  const OUTCOME_SAYS = {
    passed_with_preexisting_failures: {
      word: "passed",
      short: "failures were there before",
      note: "Passed. The tests that failed also failed on the commit this run started from, so this task did not cause them.",
    },
    "condition-skipped": {
      word: "skipped",
      glyph: "skip",
      short: "the plan's conditions did not call for it",
      note: "Skipped: the plan's conditions did not call for this task.",
    },
  };
  /** The outcome's own words where the node shows that outcome (a replay's moment may show the task earlier). */
  function outcomeSays(outcome, state) {
    return nodeState(str(outcome)) === state ? OUTCOME_SAYS[str(outcome)] || null : null;
  }
  /** A task's word: its outcome's own (`OUTCOME_SAYS`), else its node class's. */
  function outcomeWord(outcome, state) {
    const says = outcomeSays(outcome, state);
    return (says && says.word) || NODE_WORD[state] || state;
  }

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
        [
          view.duration != null ? duration(view.duration) : null,
          isNum(task.cost_usd) && !props.replaying ? moneyFine(task.cost_usd) : null,
          // An outcome's short note ("failures were there before") says more than the model's name here.
          (outcomeSays(task.outcome, state) || {}).short || view.model || task.model,
        ]
          .filter(Boolean)
          .join(" · ") || outcomeWord(task.outcome, state)
      );
    }
    const says = outcomeSays(task.outcome, state);
    const glyph = (says && says.glyph) || NODE_GLYPH[state];
    const ch = props.planned ? "off" : props.held && state === "running" ? "you" : channelOf(state);
    const label = id + ", " + outcomeWord(task.outcome, state) + (says && says.short ? " (" + says.short + ")" : "") + (state === "running" && stepWords(view) ? ", " + stepWords(view) : "") + ": " + str(task.title);
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
          // A run that ended before its last wave (interrupted, cancelled, failed) has no agent at its frontier.
          const stepCh = !head ? "off" : wi < head.wave ? "pass" : wi === head.wave ? (props.replaying ? "you" : props.ended ? "off" : "agent") : "off";
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
            h("span", { className: "roko-graph-wave-count" }, wave.length > 1 ? wave.length + " at once" : "")
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
              className: "rk-playhead" + (head.done ? " is-done" : "") + (props.replaying ? " is-replay" : "") + (props.ended && !head.done && !props.replaying ? " is-stopped" : ""),
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
      { className: "roko-checkrow " + (gate.passed ? "is-ok" : "is-bad") + (gate.superseded ? " is-superseded" : ""), "data-superseded": gate.superseded ? "true" : undefined },
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
        gate.superseded ? h("span", { className: "roko-checkrow-runs" }, "an earlier attempt") : null,
        h("span", { className: "roko-checkrow-more" }, open ? "Hide output" : "Output"),
        h(Icon, { name: open ? "chevronDown" : "chevronRight", size: 12 })
      ),
      props.keyLine && !gate.passed ? h("div", { className: "roko-keyline" }, h("span", { className: "roko-keyline-mark" }, "›"), props.keyLine) : null,
      open ? h("pre", { className: "roko-pre roko-pre--output" }, output || "(no output recorded)") : null
    );
  }

  /**
   * A route candidate as a run Hermes started can use it. Such a run carries roko's `stage` policy, which a CLI agent
   * (claude_cli, codex_cli, …: it runs its own tools) cannot honour, so roko never runs it there. A newer backend
   * marks those rows itself (`why_not`); for an older one the page marks a CLI provider the same way.
   */
  function fromHermes(c) {
    if (c.eligible === false || "why_not" in c) return c;
    return /(^|[_-])(cli|acp)$/i.test(str(c.provider))
      ? Object.assign({}, c, { eligible: false, why_not: "runs its own tools: a run started from Hermes needs a model in roko's own tool loop" })
      : c;
  }

  /**
   * Who decided an attempt's model: roko's `decided_by` (ladder, router, learned, pinned, fallback, failover,
   * explore), or, from an older backend, read off the router's `source` / `stage`.
   */
  function routeDecider(route) {
    const said = str(route.decided_by);
    if (said) return said;
    const src = str(route.source || route.stage);
    if (src === "ladder" || str(route.stage) === "ladder") return "ladder";
    if (src === "task_hint" || src === "override") return "pinned";
    if (src === "control" || src === "self_model" || src === "router") return "router";
    return src;
  }

  /**
   * An attempt's route: who picked the model and why, then the models it could have used. A ladder pick or a
   * pinned model was not scored, so it shows no score bars (roko's router scores, all alike or backwards there,
   * decided nothing); the models this run cannot use (a CLI agent for a run from Hermes, a provider without a key)
   * fold away behind their count.
   */
  /** Who picked a model, in a word (the MODEL readout) and in a sentence's words; the desktop's (ui-notes R10). */
  const DECIDERS = {
    control: "control",
    default: "default",
    explore: "exploring",
    failover: "failover",
    fallback: "fallback",
    ladder: "ladder",
    learned: "learned",
    override: "override",
    pinned: "pinned",
    router: "router",
    self_model: "self-model",
    task_hint: "task hint",
  };
  /**
   * Who picked an attempt's model and whether scores did it: `{decider, word, words, rung, scored}`, as
   * "ladder" and "picked by the model ladder", or "switched by a failover".
   */
  function routeView(route) {
    const by = routeDecider(route);
    return {
      decider: by,
      rung: str(route.rung),
      scored: routeScored(route),
      word: DECIDERS[by] || oneLine(by, 16) || "router",
      words: by === "failover" ? "switched by a failover" : "picked by " + (ROUTE_SOURCE_WORDS[by] || by.replace(/_/g, " ") || "roko"),
    };
  }
  /** The router's odds for a pick, only where its scores decided it and it was not a sure thing: "p 0.62". */
  function routeOdds(route, view) {
    return (view || routeView(route)).scored && isNum(route.p) && route.p < 1 ? "p " + route.p.toFixed(2) : null;
  }
  /** Whether the router's scores decided a pick: `scored` from roko, else not for a ladder or a pin, nor all alike. */
  function routeScored(route, usable) {
    if (route.scored === true || route.scored === false) return route.scored;
    const by = routeDecider(route);
    if (by === "ladder" || by === "pinned") return false;
    const scores = (usable || list(route.candidates).filter(function (c) { return obj(c) && c.eligible !== false; })).map(function (c) { return c && c.score; }).filter(isNum);
    return scores.some(function (v) { return Math.abs(v - scores[0]) > 1e-9; });
  }

  /**
   * An attempt's route: who picked the model and why, then the models it could have used. A pick by rule (the
   * ladder, a pin) shows no score bars and no odds (roko's router scores, all alike or backwards there, decided
   * nothing); the models this run cannot use (a CLI agent for a run from Hermes, a provider without a key) fold away
   * behind their count. The words are the desktop's (ui-notes R10).
   */
  function RouteLine(props) {
    const route = obj(props.route);
    const [showOut, setShowOut] = useState(false);
    if (!route) return null;
    const view = routeView(route);
    const by = view.decider;
    const cands = list(route.candidates).filter(obj).map(fromHermes);
    const usable = cands.filter(function (c) { return c.eligible !== false; });
    const out = cands.filter(function (c) { return c.eligible === false; });
    const scored = view.scored;
    const scores = usable.map(function (c) { return c.score; }).filter(isNum);
    const top = scores.reduce(function (m, v) { return Math.max(m, v); }, 0) || 1;
    const reason = str(route.reason);
    // `reason` is sometimes just the source's own word again ("ladder"): that adds nothing.
    const said = reason && reason !== by && reason !== str(route.source) && reason !== str(route.stage) ? oneLine(reason, 200) : "";
    const odds = routeOdds(route, view);
    return h(
      "div",
      { className: "rk-route", "data-roko": "route", "data-decided-by": by || undefined, "data-scored": scored ? "true" : "false" },
      h(
        "div",
        { className: "rk-route-head" },
        h("span", { className: "rk-ringtag", "data-ch": by === "failover" ? "fail" : "agent" }, "L1"),
        h("span", { className: "rk-route-src", "data-roko": "route-decider" }, view.words),
        view.rung ? h("span", { className: "rk-route-rung" }, "rung " + oneLine(view.rung, 12)) : null,
        odds ? h("span", { className: "rk-route-p roko-mono", title: "the chance the router gave this pick" }, odds) : null
      ),
      said ? h("div", { className: "rk-route-why" }, said) : null,
      usable.length
        ? h(
            "ol",
            { className: "rk-cands" + (scored ? "" : " is-unscored"), "aria-label": scored ? "models the router weighed" : "models this run could use" },
            usable.slice(0, 6).map(function (c, i) {
              const picked = str(c.model) === str(route.model);
              const w = isNum(c.score) ? Math.max(0.04, c.score / top) : 0.04;
              return h(
                "li",
                { key: str(c.model) + i, className: "rk-cand" + (picked ? " is-picked" : "") },
                h("span", { className: "rk-cand-model roko-mono" }, str(c.model) || "?"),
                scored ? h("span", { className: "rk-cand-bar", "aria-hidden": "true" }, h("span", { style: { width: (w * 100).toFixed(1) + "%" } })) : null,
                scored ? h("span", { className: "rk-cand-score roko-mono" }, isNum(c.score) ? c.score.toFixed(2) : "—") : null,
                h("span", { className: "rk-cand-note" }, picked ? "picked" : scored ? (isNum(c.p) ? "p " + c.p.toFixed(2) : "") : "could have run it")
              );
            })
          )
        : null,
      out.length
        ? h(
            "div",
            { className: "rk-cands-out" },
            h(
              "button",
              { type: "button", className: "roko-linkbtn", "aria-expanded": showOut ? "true" : "false", "data-roko": "route-unusable", onClick: function () { setShowOut(!showOut); } },
              plural(out.length, "model", "models") + " this run cannot use" + (showOut ? "" : " ›")
            ),
            showOut
              ? h(
                  "ul",
                  { className: "rk-cands rk-cands--out", "aria-label": "Models this run cannot use" },
                  out.map(function (c, i) {
                    return h(
                      "li",
                      { key: str(c.model) + i, className: "rk-cand is-out" },
                      h("span", { className: "rk-cand-model roko-mono" }, str(c.model) || "?"),
                      h("span", { className: "rk-cand-note" }, oneLine(c.why_not || c.ineligible_reason, 120) || "this run cannot use it")
                    );
                  })
                )
              : null
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

  const ADMISSION_WORDS = {
    deferred: "a lesson waits for more evidence",
    duplicate: "confirmed a lesson it had",
    full_admitted: "kept a new lesson",
    full_deferred: "a lesson waits for more evidence",
    full_rejected: "a lesson was not kept",
    full_suppressed: "a lesson was not kept",
    light_admitted: "kept a new lesson",
    no_candidate: "nothing new to learn from this task",
  };
  /**
   * What roko's knowledge store did with a task's outcome (`admission`), in the desktop's words (ui-notes D7): the
   * lesson, never a stand-in like "none", and one line of what happened: "nothing new to learn from this task ·
   * confirmed 3 lessons it had · 3 moved up a tier".
   */
  function lessonWords(l) {
    const text = oneLine(l.lesson, 300);
    const lesson = text && !/^(none|null|n\/a|-)$/i.test(text) ? text : "";
    const a = str(l.admission);
    const confirmed = isNum(l.reinforced) && l.reinforced > 0;
    // A duplicate is a confirmation: the count says it once.
    const what = a === "duplicate" && confirmed ? "" : ADMISSION_WORDS[a] || (a ? a.replace(/_/g, " ") : lesson ? "kept" : "");
    const meta = [what];
    if (confirmed) meta.push("confirmed " + plural(l.reinforced, "lesson", "lessons") + " it had");
    if (isNum(l.promoted) && l.promoted > 0) meta.push(l.promoted + " moved up a tier");
    else if (l.promoted === true) meta.push("moved up a tier");
    return { ch: /admitted|duplicate/.test(a) || confirmed ? "pass" : "ink", lesson: lesson, meta: meta.filter(Boolean).join(" · ") };
  }

  /** The agent's last word without roko's empty "Lesson: none" line (a real "Lesson: …" stays). */
  function agentWords(note) {
    return str(note).replace(/\n?\s*Lesson:\s*(none|n\/a)\.?\s*$/i, "").trim();
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
        h("span", { className: "rk-state", "data-ch": ch }, outcomeWord(task.outcome, state)),
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
      task.reason || (outcomeSays(task.outcome, state) || {}).note
        ? h("div", { className: "roko-inspector-reason" }, h(Icon, { name: "info", size: 12 }), str(task.reason) || outcomeSays(task.outcome, state).note)
        : null,
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
                const said = lessonWords(l);
                return h(
                  "li",
                  { key: str(l.entry_id) || i, className: "rk-lesson" + (said.ch === "pass" ? "" : " is-none"), "data-admission": str(l.admission) || undefined },
                  said.lesson ? h("span", { className: "rk-lesson-text" }, said.lesson) : null,
                  said.meta ? h("span", { className: said.lesson ? "rk-lesson-meta roko-dim" : "rk-lesson-text" }, said.meta) : null
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
            h("blockquote", { className: "roko-quote" }, h(LongText, { value: agentWords(task.note), limit: 360, lines: 6, prose: true }))
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
    // A check that no running task's own line already says: the plan's checks, or the workspace's.
    const checking = checkingOf(run, props.tasks);
    const ownLine = checking && checking.task && busy.some(function (t) { return str(t.task_id) === checking.task; });
    const checkItem = checking && !ownLine
      ? h(
          "div",
          { key: "checking", className: "roko-now-item is-checking" },
          h("span", { className: "roko-now-id" }, checking.task || (checking.scope === "workspace" ? "all" : "plan")),
          h(CheckingLine, { checking: checking })
        )
      : null;
    if (!busy.length && !checkItem) return null;
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
        busy.length > 4 ? h("span", { className: "rk-ticker-more" }, "+" + (busy.length - 4) + " more") : null,
        checkItem
      )
    );
  }

  const TERMINAL_OUTCOME = { passed: true, succeeded: true, already_satisfied: true, accepted_with_failures: true, failed: true, error: true, crashed: true, timeout: true, timed_out: true, rejected: true, blocked: true, skipped: true, cancelled: true, interrupted: true, stopped: true, unverified: true, passed_with_preexisting_failures: true, "condition-skipped": true };

  /**
   * What roko checks while a run waits on its checks: the card's `checking` ({what, scope, task_id, since,
   * elapsed_s}), so a long check reads "checking the workspace: clippy · 3:12" rather than a silent "running".
   * A backend from before `checking` says nothing; then a running run whose every task has ended is checking
   * the plan's work before it delivers it (roko's whole-plan check), as far as the page can tell.
   */
  function checkingOf(run, tasks) {
    if (!run || !isRunActive(run)) return null;
    const c = obj(run.checking);
    if (c) {
      const what = str(c.label) || str(c.name) || str(c.what);
      if (!what) return null;
      let since = ms(c.since);
      if (!isFinite(since) && isNum(c.elapsed_s)) since = (isFinite(ms(run.checked_at)) ? ms(run.checked_at) : Date.now()) - c.elapsed_s * 1000;
      return {
        what: oneLine(what, 60) + (isNum(c.step) && isNum(c.steps) && c.steps > 1 ? " (" + c.step + " of " + c.steps + ")" : ""),
        scope: str(c.scope),
        task: str(c.task_id) || null,
        packages: list(c.packages).map(str).filter(Boolean),
        since: isFinite(since) ? since : null,
        // The plugin's own guess on an older roko (every task ended, the run still goes): roko is finishing.
        guessed: str(c.source) === "plugin",
      };
    }
    if (run.checking === null || run.kind === "plan_generate") return null;
    const all = list(tasks || run.tasks);
    if (!all.length || !all.every(function (t) { return TERMINAL_OUTCOME[str(t.outcome)]; })) return null;
    return { what: "the plan's checks before delivery", scope: "plan", task: null, since: ms(run.last_event_at) || null, guessed: true };
  }

  /** "checking the workspace: clippy · 3:12", with the clock ticking. */
  function CheckingLine(props) {
    const c = props.checking;
    // The desktop's words (ui-notes R9): "checking the workspace: …", "checking the plan: …", "checking speed-test: …",
    // "checking T2: compile".
    const where =
      c.scope === "workspace" ? " the workspace"
      : c.scope === "plan" ? " the plan"
      : c.scope === "packages" && c.packages && c.packages.length ? " " + oneLine(c.packages.join(", "), 40)
      : c.scope === "task" && c.task ? " " + oneLine(c.task, 14)
      : "";
    const words = c.guessed ? "finishing: " + c.what : "checking" + where + ": " + c.what;
    return h(
      "span",
      { className: "rk-checking", "data-roko": "checking", title: c.guessed ? "every task has ended; roko checks the plan's work before it delivers it" : undefined },
      h("span", { className: "rk-checking-what" }, props.short ? oneLine(words, 48) : words),
      isFinite(ms(c.since)) ? h(Ticker, { since: c.since, prefix: " · ", className: "rk-checking-clock" }) : null
    );
  }

  /** roko's line for an interrupted run (`interrupted.reason`), or the same words from an older card. */
  function interruptedReason(run) {
    const it = obj(run && run.interrupted);
    return (it ? str(it.reason) : "") || "roko stopped while this run was going (machine restart or crash).";
  }

  function WhyCallout(props) {
    const run = props.run;
    const why = obj(run.why);
    // The plan failed roko's validator while the run waited (0.5.0 `why.validation`): its findings as a list, not as
    // the summary's run-on sentence; the step names the plan's folder, from the plans list's `group`.
    const validation = why && obj(why.validation) && why.validation.valid === false ? why.validation : null;
    const plans = useResource(validation && run.plan_id ? "/plans" : null, 0);
    const listed = plans.data ? list(plans.data.plans).filter(function (p) { return obj(p) && str(p.id) === str(run.plan_id); })[0] : null;
    const problems = list(run.problems);
    const interrupted = run.state === "interrupted";
    let summary = interrupted ? interruptedReason(run) : why ? str(why.summary) : "";
    if (!summary && run.state === "missing" && problems.length) summary = str(problems[0]);
    if (!summary && run.kind === "plan_generate" && run.planner_error) summary = str(run.planner_error);
    if (!summary) return null;
    const stoppedAtCap = !!capStop(run);
    const tone = stoppedAtCap ? "warn" : run.state === "failed" || run.kind === "plan_generate" ? "bad" : "warn";
    const keyLines = why ? list(why.gates_not_passed).filter(function (g) { return g.key_line; }).slice(0, 3) : [];
    const title = run.state === "cancelled" || stoppedAtCap ? "Why it stopped" : run.state === "unverified" ? "Why it is unverified" : run.state === "missing" ? "Where this run went" : interrupted ? "roko stopped mid-run" : "Why it did not pass";
    return h(
      "div",
      { className: "roko-why roko-why--" + tone, role: "note", "data-roko": "why" },
      h("div", { className: "roko-why-icon" }, h(Icon, { name: run.state === "cancelled" || interrupted || stoppedAtCap ? "stop" : "error", size: 16 })),
      h(
        "div",
        { className: "roko-why-body" },
        h("div", { className: "roko-why-title" }, title),
        h("div", { className: "roko-why-text" }, validation ? summary.split(/\s*roko['\u2019]s check of the plan says:/)[0].trim() : summary),
        validation ? h(ValidationItems, { validation: validation }) : null,
        validation ? h(ValidationStep, { validation: validation, planId: run.plan_id, group: listed ? listed.group : null }) : null,
        // What an interrupted run leaves: roko sets its checkout aside, and a new run starts clean.
        interrupted ? h("div", { className: "roko-why-text", "data-roko": "why-next" }, "What it did so far is kept on its own branch. Run it again to start from a clean checkout.") : null,
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
  /** A fix the merge check names (`merge.fix`, e.g. commit roko.toml), as a problem row's fix, or null. */
  function mergeFix(m) {
    const f = obj(m && m.fix);
    if (!f || !plain(f.kind)) return null;
    return {
      id: "merge-" + (plain(f.action) || plain(f.kind)),
      severity: "warn",
      title: "",
      detail: "",
      fix: { kind: plain(f.kind), label: plain(f.label) || "fix", action: plain(f.action) || null, command: plain(f.command) || null, docs: docsPath(f.docs) },
      steps: [],
      parts: null,
    };
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
    // true for a demo's run, null while that is not known yet; a caller that does not say means no demo.
    const demo = props.demo === undefined ? false : props.demo;
    // roko stopped mid-run (a restart or a crash). A newer backend's card says whether its kept work can merge
    // (`merge`, after one more yes); without it (an older backend) there is nothing verified to merge.
    const interrupted = run.state === "interrupted" && !obj(run.merge);
    // The work shown is a part of the run's work the backend names (`?work=unverified&plan_id=`): merge that part.
    const work = str(diff && diff.work) || "verified";
    const planId = str(diff && diff.plan_id);
    const query = work === "verified" && !planId ? "" : "?work=" + enc(work) + (planId ? "&plan_id=" + enc(planId) : "");

    useEffect(function () {
      if (demo !== false || interrupted) return undefined;
      let alive = true;
      setCheck(function (prev) { return { status: "loading", data: prev.data, error: null }; });
      apiGet("/runs/" + enc(run.run_id) + "/merge" + query).then(function (res) {
        if (!alive) return;
        setCheck(res.ok ? { status: "ok", data: obj(res.data.merge) || {}, error: null } : { status: "error", data: null, error: res.error });
      });
      return function () { alive = false; };
    }, [run.run_id, nonce, props.refreshKey, demo, interrupted, query]);

    const m = check.data;
    const totals = obj(diff && diff.totals) || {};
    const files = diff ? list(diff.files) : [];
    const commit = str((diff && diff.commit) || (m && m.commit));
    const into = m && m.into ? str(m.into) : "your branch";
    // Work no check ran on merges only after one more, explicit yes (`merge.confirm` says what it means). Partial
    // work (some of it unchecked, or checks roko never finished) is "not fully checked"; work no check ran on,
    // "unverified" (ui-notes R7).
    const confirm = m && plain(m.confirm) ? plain(m.confirm) : work === "unverified" ? "No check ran on this work: merge it only if you reviewed it yourself." : "";
    const partly = !!(m && str(m.work) === "partial");
    const trustWord = partly ? "not fully checked" : "unverified";
    const dirty = m ? list(m.dirty).map(plain).filter(Boolean) : [];
    const fixRow = mergeFix(m);

    function doMerge() {
      setBusy(true);
      setError(null);
      const body = commit ? { commit: commit.slice(0, 40) } : {};
      if (confirm) body.confirm = true;
      if (work !== "verified" || planId) {
        body.work = work;
        if (planId) body.plan_id = planId;
      }
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
    } else if (interrupted) {
      body = h(
        "div",
        { className: "roko-mergebox is-demo", "data-roko": "interrupted-output" },
        h(
          "div",
          { className: "roko-mergebox-main" },
          h("div", { className: "roko-mergebox-title" }, "Nothing verified to merge"),
          h("div", { className: "roko-dim" }, "roko stopped before this run's checks finished. What it did so far is kept on its own branch; run it again to start from a clean checkout.")
        )
      );
    } else if (demo || (m && m.demo === true)) {
      body = h(
        "div",
        { className: "roko-mergebox is-demo", "data-roko": "demo-output" },
        h(
          "div",
          { className: "roko-mergebox-main" },
          h("div", { className: "roko-mergebox-title" }, "Demo output: it stays on its run branch"),
          h("div", { className: "roko-dim" }, "A demo's output is a showcase. Merged into your branch it is clutter, and a later run of the demo would find its check already passing and have nothing new to show.")
        )
      );
    } else if (demo === null || (check.status === "loading" && !m)) {
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
    } else if (m && (m.can_merge || m.available === true) && canAct) {
      body = h(
        "div",
        { className: "roko-mergebox is-ready" + (confirm ? " is-unverified" : ""), "data-roko": confirm ? "merge-unverified" : "merge-ready" },
        h(
          "div",
          { className: "roko-mergebox-main" },
          h("div", { className: "roko-mergebox-title" }, confirm ? (partly ? "Not fully checked, but it can merge into " : "Unverified, but it can merge into ") : "Ready to merge into ", h("span", { className: "roko-mono" }, into)),
          h("div", { className: "roko-dim" }, (m.mode === "fast-forward" ? "fast-forward" : "a merge commit, no conflicts") + (commit ? " · " + commit.slice(0, 7) : "") + (confirm ? " · asks you once more" : ""))
        ),
        confirm ? h("span", { className: "rk-unverified-tag", "data-roko": "merge-tag" }, trustWord) : null,
        h(Button, { type: "button", size: "sm", onClick: function () { setError(null); setOpen(true); }, "aria-label": "Merge run " + shortId(run.run_id) }, confirm ? "Merge anyway…" : "Merge…")
      );
    } else {
      body = h(
        "div",
        { className: "roko-mergebox is-blocked", "data-roko": "merge-blocked" },
        h(
          "div",
          { className: "roko-mergebox-main" },
          h("div", { className: "roko-mergebox-title" }, !canAct ? "Merging from the dashboard is turned off" : dirty.length ? "Commit your changes first" : "Merge it by hand"),
          m && m.reason ? h("div", { className: "roko-dim" }, str(m.reason)) : null,
          dirty.length
            ? h(
                "div",
                { className: "rk-dirty", "data-roko": "merge-dirty" },
                h("span", { className: "roko-dim" }, "uncommitted: "),
                dirty.slice(0, 6).map(function (path, i) { return h("code", { key: i, className: "roko-mono" }, path); }),
                dirty.length > 6 ? h("span", { className: "roko-dim" }, " and " + (dirty.length - 6) + " more") : null
              )
            : null,
          // The one fix the backend offers for it (committing roko.toml, which the setup fix changed): preview, then apply.
          fixRow && canAct ? h("div", { className: "rk-problem-fix" }, h(FixControl, { problem: fixRow, onDone: function () { setNonce(function (n) { return n + 1; }); } })) : null
        ),
        m && m.command && !fixRow ? h(CommandRow, { label: "Merge", value: m.command }) : null
      );
    }

    const fileCount = isNum(totals.files) ? totals.files : files.length;
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
          title: done && done.merged ? "Merged" : (confirm ? (partly ? "Merge work roko did not fully check into " : "Merge this unverified work into ") : "Merge into ") + into + "?",
          subtitle: done && done.merged ? null : str(run.label),
          onClose: function () { if (!busy) setOpen(false); },
          footer: done && done.merged
            ? h(Fragment, null, h("span", { className: "roko-flex" }), h(Button, { type: "button", size: "sm", onClick: function () { setOpen(false); } }, "Done"))
            : h(
                Fragment,
                null,
                h("span", { className: "roko-flex" }),
                h(Button, { type: "button", size: "sm", outlined: true, disabled: busy, onClick: function () { setOpen(false); } }, "Not now"),
                h(
                  Button,
                  { type: "button", size: "sm", disabled: busy, "data-confirm": "merge", onClick: doMerge },
                  busy ? "Merging…" : confirm ? (partly ? "Merge anyway" : "Merge unverified work") : "Merge " + plural(fileCount, "file", "files")
                )
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
              // Work no check ran on: roko's sentence comes first, in orange; this dialog is the one more yes.
              confirm ? h("p", { className: "rk-merge-confirm", "data-roko": "merge-confirm" }, confirm) : null,
              h(
                "div",
                { className: "roko-mergeplan-stats" },
                h("span", { className: "roko-mergeplan-big" }, plural(fileCount, "file", "files")),
                h("span", { className: "roko-add" }, "+" + (totals.additions || 0)),
                h("span", { className: "roko-del" }, "−" + (totals.deletions || 0)),
                h(Pill, { tone: "idle" }, m && m.mode === "fast-forward" ? "fast-forward" : "merge commit"),
                confirm ? h(Pill, { tone: "warn" }, trustWord) : null
              ),
              h(
                "div",
                { className: "roko-mergeplan-route" },
                h(Icon, { name: "branch", size: 13 }),
                h("span", { className: "roko-mono" }, str((m && m.branch) || (diff && diff.branch))),
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

  /** One part of a run's work (`work.parts`): verified or not, which plan, how big. */
  function partOf(p) {
    // `counts` ({files, additions, deletions}) from a newer backend; else `diffstat`, git's sentence ("2 files
    // changed, 12 insertions(+)", or an object from another backend); else the file list.
    const counts = obj(p.counts) || {};
    const stat = obj(p.diffstat) || {};
    const sentence = typeof p.diffstat === "string" ? oneLine(p.diffstat, 120).replace(/ changed/, "") : "";
    const fromSentence = /(\d+) files? changed/.exec(typeof p.diffstat === "string" ? p.diffstat : "");
    const files = isNum(counts.files) ? counts.files
      : isNum(stat.files) ? stat.files
      : fromSentence ? Number(fromSentence[1])
      : list(p.files_changed).filter(function (f) { return !/^… \d+ more$/.test(str(f)); }).length;
    return {
      sentence: sentence,
      merged: p.merged === true,
      trust: str(p.trust) === "verified" ? "verified" : "unverified",
      plan: str(p.plan_id),
      delivered: p.delivered === true,
      files: files,
      additions: isNum(counts.additions) ? counts.additions : isNum(stat.additions) ? stat.additions : isNum(stat.insertions) ? stat.insertions : null,
      deletions: isNum(counts.deletions) ? counts.deletions : isNum(stat.deletions) ? stat.deletions : null,
      review: plain(p.review_command),
      tasks: list(p.tasks).filter(obj).map(function (t) { return str(t.task_id); }).filter(Boolean),
    };
  }
  /** A part's name on its key, as the desktop says it (ui-notes R2): "verified · 1 file", "unverified · add-tests
   *  · 2 files" (the plan only for work roko did not deliver), "· merged" once merged. */
  function partLabel(p) {
    return [p.trust, !p.delivered && p.plan ? oneLine(p.plan, 28) : "", p.files ? plural(p.files, "file", "files") : "", p.merged ? "merged" : ""].filter(Boolean).join(" · ");
  }
  /** A part's size as git says it: "1 file, 30 insertions(+), 3 deletions(-)". */
  function diffstatWords(p) {
    if (p.sentence) return p.sentence;
    const out = [plural(p.files, "file", "files")];
    if (isNum(p.additions) && p.additions) out.push(p.additions + " insertion" + (p.additions === 1 ? "" : "s") + "(+)");
    if (isNum(p.deletions) && p.deletions) out.push(p.deletions + " deletion" + (p.deletions === 1 ? "" : "s") + "(-)");
    return out.join(", ");
  }
  function partQuery(part) {
    return "work=" + part.trust + (part.plan ? "&plan_id=" + enc(part.plan) : "");
  }

  /**
   * Changes: the run's work, file by file, and the guarded Merge. A newer backend names the run's work (`work`):
   * verified, unverified (no check ran: shown, marked, never delivered), or partial (the verified tasks of a plan
   * that failed). With more than one part, keys pick the part; unverified work is never shown as "no changes".
   */
  function ChangesTab(props) {
    const run = props.run;
    const work = obj(run.work);
    const parts = work ? list(work.parts).filter(obj).map(partOf) : [];
    const [pick, setPick] = useState(null);
    const picked = pick === null ? null : parts[pick] || null;
    const other = useDiff(run.run_id, !!picked, props.refreshKey, picked ? partQuery(picked) : "");
    const state = picked ? other : props.diffState;
    const d = state.data;
    const shownWork = d ? str(d.work) || (picked ? picked.trust : "verified") : null;
    const shownPlan = d ? str(d.plan_id) || (picked ? picked.plan : "") : "";
    const current = parts.filter(function (p) { return p.trust === shownWork && (!shownPlan || !p.plan || p.plan === shownPlan); })[0] || null;
    const switcher = parts.length > 1
      ? h(
          "div",
          { className: "rk-keyrow rk-workparts", role: "group", "aria-label": "The run's work", "data-roko": "work-parts" },
          parts.map(function (p, i) {
            const on = pick === null ? p === current : pick === i;
            return h(Key, {
              key: i,
              size: "s",
              pressed: on,
              name: "work-part-" + i,
              icon: null,
              label: h(
                Fragment,
                null,
                h(LED, { ch: p.trust === "verified" ? "pass" : "you", blink: false }),
                " " + partLabel(p)
              ),
              ariaLabel: partLabel(p),
              title: [p.tasks.join(", "), diffstatWords(p)].filter(Boolean).join(" · ") || undefined,
              onClick: function () { setPick(i); },
            });
          })
        )
      : null;
    if (!d && state.error) return h("div", { className: "roko-changes" }, switcher, h(ErrorNote, { error: state.error, onRetry: props.onReload }));
    if (!d) return h("div", { className: "roko-changes" }, switcher, h(Skeleton, { rows: 6 }));
    // A run can pass without changing a file (the work was already there): nothing to review, nothing to merge.
    const noFiles = d.available && !list(d.files).length && !(obj(d.totals) && d.totals.files > 0);
    if (work && str(work.kind) === "none" && !d.available) {
      return h("div", { className: "roko-changes" }, h(Empty, { icon: "diff", title: "No changes to review" }, "This run left no changes."));
    }
    if (noFiles) {
      return h(
        "div",
        { className: "roko-changes" },
        switcher,
        h(Empty, { icon: "diff", title: "No changes to review" }, "Its checks passed without it changing a file.")
      );
    }
    if (!d.available && d.why === "elsewhere") {
      // The work is on a plan branch of a workspace on another machine: the `git diff` to run where roko runs.
      return h(
        "div",
        { className: "roko-changes" },
        switcher,
        h(
          Empty,
          { icon: "diff", title: "The changes are where roko runs" },
          str(d.message) || "This run kept its work on a plan branch of a workspace on another machine.",
          plain(d.command) ? h("span", { className: "roko-empty-cmd" }, " ", h(CopyButton, { value: plain(d.command), what: "git diff command", label: "Copy git diff" })) : null
        )
      );
    }
    if (!d.available) {
      const unverifiedRun = run.state === "unverified" || (work && str(work.kind) === "unverified");
      return h(
        "div",
        { className: "roko-changes" },
        switcher,
        h(
          Empty,
          { icon: d.why === "running" ? "clock" : "diff", title: d.why === "running" ? "The changes show once the run ends" : unverifiedRun ? "No verified work to review" : "No changes to review" },
          str(d.message),
          unverifiedRun && d.why !== "running" ? " No check ran on what this run did, so roko delivered nothing; its work, if any, stays on its plan branch." : null
        )
      );
    }
    const totals = obj(d.totals) || {};
    const unverified = shownWork === "unverified";
    const review = (current && current.review) || (unverified ? "" : plain(run.review_command));
    return h(
      "div",
      { className: "roko-changes", "data-work": shownWork || undefined },
      switcher,
      unverified
        ? h(
            "div",
            { className: "rk-unverified", role: "note", "data-roko": "unverified-banner" },
            h(LED, { ch: "you", blink: false }),
            h(
              "div",
              null,
              h("b", { className: "rk-unverified-title" }, "Unverified: no check ran on this work. "),
              (current && !current.delivered ? "roko did not deliver it: it stays on its plan branch. " : "") +
                "Read it before you take it" +
                (current && current.tasks.length ? " (" + current.tasks.join(", ") + ")" : "") +
                "."
            )
          )
        : null,
      h(
        "div",
        { className: "roko-changes-head" },
        h(
          "div",
          { className: "roko-changes-sum" },
          h("span", { className: "roko-changes-big" }, h("span", { className: "roko-add" }, "+" + (totals.additions || 0)), " ", h("span", { className: "roko-del" }, "−" + (totals.deletions || 0))),
          h("span", { className: "roko-dim" }, "in " + plural(isNum(totals.files) ? totals.files : list(d.files).length, "file", "files")),
          h("span", { className: "roko-changes-route" }, h(Icon, { name: "branch", size: 12 }), h("span", { className: "roko-mono" }, str(d.branch) || "(no branch)"), d.commit ? h("span", { className: "roko-mono roko-dim" }, "@ " + str(d.commit).slice(0, 7)) : null)
        ),
        review ? h(CopyButton, { value: review, what: "review command", label: "Copy git diff" }) : null
      ),
      h(MergeBox, { key: shownWork + ":" + shownPlan, run: run, demo: props.demo, diff: d, notify: props.notify, onMerged: props.onMerged, refreshKey: props.refreshKey }),
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

  /** The route of the newest attempt among a run's tasks, or null (an older roko sends none). */
  function latestRoute(tasks) {
    let best = null;
    let bestAt = -Infinity;
    tasks.forEach(function (t) {
      const own = obj(t.route);
      if (own && !list(t.attempt_log).length && bestAt === -Infinity) best = own;
      list(t.attempt_log).forEach(function (a, i) {
        const route = obj(a && a.route);
        if (!route) return;
        const at = isFinite(ms(a.started_at)) ? ms(a.started_at) : i;
        if (at >= bestAt) {
          bestAt = at;
          best = route;
        }
      });
    });
    return best;
  }

  function allPips(tasks) {
    const out = [];
    tasks.forEach(function (t) { taskView(t).pips.forEach(function (p) { out.push(p); }); });
    return out;
  }

  function Instrument(props) {
    return h(
      "div",
      { className: "roko-instrument" + (props.className ? " " + props.className : ""), title: props.title },
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

  const VERDICT = { succeeded: "PASS", passed: "PASS", failed: "FAIL", cancelled: "STOP", unverified: "WARN", missing: "LOST", interrupted: "HALT", planned: "PLAN" };

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
    const lastRoute = latestRoute(tasks);
    const finishedCount = (p.passed || 0) + (p.failed || 0) + (p.blocked || 0) + (p.stopped || 0) + (p.skipped || 0) + (p.unverified || 0);
    const fraction = isNum(p.total) && p.total > 0 ? finishedCount / p.total : 0;
    const projected = active && isNum(run.cost_usd) && fraction >= 0.2 && fraction < 1 ? run.cost_usd / fraction : null;
    // roko serve is down: the card is the last known state, so nothing on it blinks or ticks. Its clock stops when
    // roko last wrote (`last_event_at`), else when the overview last heard from roko.
    const stale = !!props.stale;
    const lastSeen = !stale ? NaN : isFinite(ms(run.last_event_at)) ? ms(run.last_event_at) : ms(run.checked_at || (overviewStore.get().data || {}).checked_at);
    const checking = active && !stale ? checkingOf(run, tasks) : null;
    const waits = runWaits(run) && !stale;
    const ch = stale ? "off" : runChannel(run, waits);
    const justEnded = useJustEnded(active);
    const spendTone = capTone(run.cost_usd, run.max_usd);
    const doneWord = [p.passed ? p.passed + " passed" : null, p.unverified ? p.unverified + " unverified" : null, waits ? "waiting on you" : p.running ? p.running + (stale ? " was running" : " running") : null, p.failed ? p.failed + " did not pass" : null, p.blocked ? p.blocked + " blocked" : null, p.stopped ? p.stopped + " stopped" : null, p.skipped ? p.skipped + " skipped" : null, p.pending ? p.pending + " waiting" : null]
      .filter(Boolean)
      .join(" · ");
    const checksAll = isNum(gates.total) && gates.total > 0;
    return h(
      "header",
      { className: "roko-hero rk-hero", "data-roko": "hero", "data-ch": ch },
      h(
        "div",
        { className: "roko-hero-top" },
        h(LED, { ch: ch, blink: active && !stale ? undefined : false }),
        h("span", { className: "rk-state", "data-ch": waits ? "agent" : ch, title: capStop(run) ? capStopWords(capStop(run)) : undefined }, stale ? "last seen running" : stateWord(run)),
        waits ? h("span", { className: "rk-state rk-state-you", "data-ch": "you", "data-roko": "hero-waiting" }, "waiting on you") : null,
        // A plan writing that ended reads "plan written" (or "planning failed"); its "planning" badge was the work.
        run.kind === "plan_generate" && !active
          ? null
          : h("span", { className: "roko-kind" }, (KIND_LABEL[run.kind] || str(run.kind)) + (isNum(p.total) && p.total > 1 ? " · " + p.total + " tasks" : "")),
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
      stale
        ? h(
            "div",
            { className: "roko-hero-stale", "data-roko": "stale", role: "status" },
            h(LED, { ch: "fail", blink: false }),
            "roko serve is not answering: this is the run's last known state" +
              (isFinite(lastSeen) ? ", from " + wallClock(lastSeen) : "") +
              ". It may still be going, or it stopped when roko did."
          )
        : null,
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
                sub: stale
                  ? "until roko last wrote"
                  : active
                    ? checking
                      ? h(CheckingLine, { checking: checking, short: true })
                      : isNum(run.eta_minutes) && run.eta_minutes > 0 ? "≈ " + Math.max(1, Math.round(run.eta_minutes)) + " min left" : "roko is working"
                    : run.finished_at ? "finished " + ago(run.finished_at) : null,
              },
              active && run.started_at
                ? h(DotClock, { since: run.started_at, until: stale && isFinite(lastSeen) ? lastSeen : undefined, stopped: stale, size: "L" })
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
              {
                index: "04",
                label: "CHECKS",
                // `gates` counts each task's final attempt; `retried` the earlier attempts' checks that did not
                // pass, so roko tried again (0.5.0): a retry that passed is not a failure (the desktop's words).
                sub: h(
                  Fragment,
                  null,
                  h(Pips, { pips: allPips(tasks) }),
                  checksAll
                    ? h(
                        "span",
                        { className: "rk-cell-subtext", "data-roko": "checks-words" },
                        gates.failed ? gates.failed + " did not pass" : "passed",
                        isNum(gates.retried) && gates.retried > 0 ? h("span", { "data-roko": "checks-retried" }, " · " + gates.retried + " retried") : null
                      )
                    : null
                ),
              },
              h(Dots, {
                value: checksAll ? String(gates.passed || 0) + "/" + gates.total : "—",
                size: "L",
                ch: checksAll && gates.failed > 0 ? "fail" : checksAll && gates.passed === gates.total ? "pass" : undefined,
                label: checksAll ? (gates.passed || 0) + " of " + gates.total + " checks passed" + (isNum(gates.retried) && gates.retried > 0 ? ", " + gates.retried + " retried" : "") : "no checks yet",
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
                    }),
                    // Who picked the newest attempt's model, in the route panel's words.
                    lastRoute ? h("span", { className: "rk-model-tag", "data-roko": "model-tag" }, routeView(lastRoute).word + (routeOdds(lastRoute) ? " · " + routeOdds(lastRoute) : "")) : null
                  )
                : h(Dots, { value: "—", size: "L" })
            ),
            h(
              "div",
              { className: "rk-display-end" },
              active && !stale
                ? h(Scope, { runId: str(run.run_id), width: 156, height: 56, label: "pulse" })
                : stale
                  ? h("div", { className: "rk-verdict", "data-ch": "off" }, h(Dots, { value: "OFF", size: "L", label: "roko serve is not answering" }))
                  : h(
                      "div",
                      { className: "rk-verdict", "data-ch": ch },
                      h(Dots, {
                        value: capStop(run) ? "STOP" : VERDICT[run.state] || str(run.state).slice(0, 4).toUpperCase() || "—",
                        size: "L",
                        ch: ch === "off" ? undefined : ch,
                        label: capStop(run) ? "verdict: " + capStopWords(capStop(run)) : "verdict: " + str(run.state),
                      })
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
    // A run that has ended has no live task (dogfood-desktop P4): one roko's last known state still calls
    // running stops as the run did, and nothing of the run waits on the person. A run last seen while roko is
    // down is still active: it keeps its last known state.
    if (!run || isRunActive(run)) return run;
    let shown = stoppedTasks(run, run.state === "interrupted" || run.state === "cancelled" ? run.state : "stopped");
    if (list(shown.waiting).length) shown = Object.assign({}, shown, { waiting: [] });
    if (shown.state !== "cancelled") return shown;
    run = shown;
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

  /**
   * An ended run (interrupted, cancelled, …): a task its last known state calls running is stopped, not running
   * (no agent, no ticking clock), with the run's own word for it (`outcome`); the ring counts it as stopped.
   */
  function stoppedTasks(run, outcome) {
    let moved = 0;
    const tasks = list(run.tasks).map(function (t) {
      if (str(t.outcome) !== "running") return t;
      moved += 1;
      return Object.assign({}, t, { outcome: outcome || "interrupted", step: null, step_detail: null, step_since: null });
    });
    if (!moved) return run;
    const p = Object.assign({}, obj(run.progress) || {});
    if (isNum(p.running)) p.running = Math.max(0, p.running - moved);
    p.stopped = (isNum(p.stopped) ? p.stopped : 0) + moved;
    return Object.assign({}, run, { tasks: tasks, progress: p });
  }

  /** A run row's progress: an ended run's stray "running" counts as stopped, as on its card (`shownRun`). */
  function endedProgress(run) {
    const p = obj(run && run.progress);
    if (!p || isRunActive(run) || !isNum(p.running) || p.running <= 0) return p;
    return Object.assign({}, p, { running: 0, stopped: (isNum(p.stopped) ? p.stopped : 0) + p.running });
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
    // A card that failed while roko was away comes back with it.
    const failedRef = useRef(false);
    failedRef.current = state.status === "error";
    useEffect(function () {
      return overviewStore.onBack(function () { if (failedRef.current) reload(); });
    }, [reload]);
    return { state: state, reload: reload };
  }

  /**
   * The run's diff once it ended: the verified work (roko's own diff route), or the work `query` names
   * (`work=unverified&plan_id=…`, a newer backend's other parts of a run's work).
   */
  function useDiff(runId, ended, nonce, query) {
    const [state, setState] = useState({ data: null, error: null });
    const [back, setBack] = useState(0);
    const failedRef = useRef(false);
    failedRef.current = !!state.error;
    useEffect(function () {
      return overviewStore.onBack(function () { if (failedRef.current) setBack(function (n) { return n + 1; }); });
    }, []);
    useEffect(function () {
      if (!ended) {
        setState({ data: null, error: null });
        return undefined;
      }
      let alive = true;
      apiGet("/runs/" + enc(runId) + "/diff" + (query ? "?" + query : "")).then(function (res) {
        if (!alive) return;
        setState(res.ok ? { data: obj(res.data.diff) || {}, error: null } : { data: null, error: res.error });
      });
      return function () { alive = false; };
    }, [runId, ended, nonce, query, back]);
    return state;
  }

  /** A run's one next step: roko's `next` ({action, label, why}) when the backend gives it, else what the page knows. */
  // The next step's words when the backend sends none (the desktop's, ui-notes U12).
  const NEXT_LABELS = { merge: "review & merge", review: "review the work", "commit-roko-toml": "commit roko.toml", rerun: "run it again" };

  /**
   * A run's one next step: roko's `next` ({action, label, why}; `action: null` is words only) when the backend gives
   * it, else what the page can tell: run an interrupted run again, review and merge a delivered branch, review work
   * no check ran on.
   */
  function nextOf(run, seen) {
    const n = obj(run && run.next);
    if (n && ("action" in n)) return { action: plain(n.action) || null, label: plain(n.label), why: plain(n.why) };
    if (run && run.state === "interrupted") {
      return { action: "rerun", label: NEXT_LABELS.rerun, why: "roko set the stopped run's checkout aside: a new run starts clean, and skips the tasks that passed" };
    }
    const s = seen || {};
    if (s.totals && s.unverified) return { action: "review", label: NEXT_LABELS.review, why: "no check ran on this work: read it before you merge it" };
    if (s.totals && s.delivered && !s.delivered.merged && !s.delivered.promoted_into && s.demo !== true) {
      return { action: "merge", label: NEXT_LABELS.merge, why: "the run's verified work waits on its branch" };
    }
    if (s.totals && s.demo === true) return { action: "review", label: NEXT_LABELS.review, why: "demo output: it stays on its run branch" };
    return null;
  }

  /**
   * A suggested cap (`next.max_usd`, 0.5.0) as the composer's: the smallest detent at or above it that fits what the
   * run may spend; above the detents, the figure itself to the cent; over the ceiling, the ceiling.
   */
  function snapCap(want, ceiling) {
    if (!isNum(want) || want <= 0) return null;
    const fits = CAP_PRESETS.filter(function (c) { return c >= want - 1e-9 && (ceiling === null || c <= ceiling + 1e-9); });
    if (fits.length) return fits[0];
    const up = Math.ceil(want * 100 - 1e-6) / 100;
    return ceiling === null || up <= ceiling + 1e-9 ? up : Math.floor(ceiling * 100) / 100;
  }

  /**
   * Run it again: a plan run reopens the composer on its plan (tasks that passed are skipped), a request on its words.
   * A run its cap stopped comes back at the higher cap roko's backend suggests (`next.max_usd`, R2-3), so that
   * pressing start does not stop it again; else at its own cap. Nothing starts until the person presses it.
   */
  function rerun(run, onCompose, ceiling) {
    const next = obj(run.next);
    const raised = next && str(next.action) === "rerun" ? snapCap(next.max_usd, ceiling === undefined ? null : ceiling) : null;
    const cap = raised !== null ? raised : isNum(run.max_usd) ? run.max_usd : undefined;
    if (run.kind === "plan" && run.plan_id) onCompose("", { plan: str(run.plan_id), resume: true, cap: cap });
    else onCompose(str(run.request || run.label), { cap: cap });
  }

  function RunView(props) {
    const runId = props.runId;
    const limits = useLimits();
    const card = useRunCard(runId);
    // roko down and no card to show: the overview's row is the run's last known state (shown as such, stale).
    const ovData = useOverview().data;
    const row = !card.state.run && card.state.error && rokoDown(ovData)
      ? list(ovData.runs).filter(function (r) { return obj(r) && str(r.run_id) === str(runId); })[0] || null
      : null;
    const run = card.state.run ? shownRun(card.state.run) : row ? shownRun(row) : null;
    const active = isRunActive(run);
    const ended = !!run && !active && run.kind !== "plan_generate";
    const events = useRunEvents(runId, active);
    const [tab, setTabState] = useState(validRunTab(props.initialTab) || "overview");
    const [selected, setSelected] = useState(null);
    const [replayT, setReplayT] = useState(null);
    const [diffNonce, setDiffNonce] = useState(0);
    const diff = useDiff(runId, ended, diffNonce);
    const demo = useDemoRun(ended && run && run.delivered ? run : null);
    const [confirmCancel, setConfirmCancel] = useState(false);
    const [cancelling, setCancelling] = useState(false);
    // Bumped by an answer, so the card leaves it out at once (the shared store decides what stays apart).
    const [, setAnswered] = useState(0);
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
    const waiting = list(run.waiting).filter(function (it) { return !answeredStore.has(it); });
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
    // A diff without a file is no change: no review key, no +0 −0 on the tab.
    const totals = d && d.available && (list(d.files).length || (obj(d.totals) && d.totals.files > 0)) ? obj(d.totals) || {} : null;
    const delivered = obj(run.delivered);
    // roko serve is down: the card is the run's last known state, and nothing about it can change from here.
    const stale = !!props.stale && active;

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
          {
            key: "cancel",
            size: "sm",
            outlined: true,
            destructive: true,
            type: "button",
            disabled: cancelling || stale,
            title: stale ? "roko serve is not answering: it cannot be asked to stop this run" : undefined,
            onClick: function () { setConfirmCancel(true); },
          },
          cancelling ? "Cancelling…" : "Cancel run"
        )
      );
    }
    if (run.plan_id && run.kind === "plan" && props.onOpenPlan) {
      actions.push(h("button", { key: "plan", type: "button", className: "roko-linkbtn", onClick: function () { props.onOpenPlan(run.plan_id); } }, "Open plan"));
    }
    // The run's one next step (roko's `next`, else what the page can tell): one key where Cancel is while it runs.
    // Work no check ran is reviewable too (a newer backend's diff names it), marked as such.
    const unverifiedShown = !!(d && d.available && str(d.work) === "unverified");
    const next = active ? null : nextOf(run, { delivered: delivered, totals: totals, unverified: unverifiedShown, demo: demo });
    if (next && (next.action === "merge" || next.action === "review" || next.action === "commit-roko-toml")) {
      actions.push(
        h(
          "button",
          {
            key: "next",
            type: "button",
            className: "roko-hero-review" + (unverifiedShown ? " is-unverified" : ""),
            "data-roko": "hero-review",
            "data-next": next.action,
            title: next.why || undefined,
            onClick: function () { setTab("changes"); },
          },
          h(Icon, { name: next.action === "commit-roko-toml" ? "check" : "diff", size: 13 }),
          (next.label || NEXT_LABELS[next.action]) + (totals ? " " : ""),
          totals ? h("span", { className: "roko-add" }, "+" + (totals.additions || 0)) : null,
          totals ? h("span", { className: "roko-del" }, "−" + (totals.deletions || 0)) : null
        )
      );
    } else if (next && next.action === "rerun" && canAct && props.onCompose) {
      // Behind the composer, so the person sees the plan or the request and its cap before anything is spent.
      actions.push(
        h(Key, {
          key: "next",
          tone: "you",
          size: "s",
          icon: "replay",
          name: "rerun",
          label: next.label || NEXT_LABELS.rerun,
          title: next.why || undefined,
          onClick: function () { rerun(run, props.onCompose, ceilingOf(limits)); },
        })
      );
    } else if (next && !next.action && next.label) {
      actions.push(h("span", { key: "next", className: "roko-dim rk-next-words", title: next.why || undefined }, next.label));
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
            demo: demo,
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
            graph: graphOf(run, tasks),
            ended: ended,
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
              // One task: its inspector is the run's detail, so it stays open (no close key).
              onClose: tasks.length > 1 ? function () { setSelected(null); } : null,
            })
          : null
      );
    }

    const activityCount = evs.length;
    const loopCount = list(run.loops).length;
    return h(
      "div",
      // A last known state (roko down) is drawn frozen: unlit, still.
      { className: "roko-runview" + (stale ? " is-stale" : ""), "data-roko": "run", "data-roko-run": str(run.run_id) },
      h(RunHero, { run: run, actions: actions, source: props.source, stale: stale }),
      // With roko down the header and the setup module say so once; the card's failed refresh adds nothing.
      card.state.error && !stale ? h(ErrorNote, { error: card.state.error, compact: true, onRetry: card.reload }) : null,
      active && !stale ? h(NowStrip, { run: run, tasks: tasks, held: heldTasks, onSelect: function (id) { setSelected(id); setTab("overview"); } }) : null,
      h(WhyCallout, { run: run, onSelect: function (id) { setSelected(id); setTab("overview"); } }),
      // With roko down nothing can be answered: what waited is part of the last known state above.
      waiting.length && !stale
        ? h(
            "section",
            { className: "roko-run-waiting" },
            h(Label, null, h(Icon, { name: "hand", size: 12 }), " Waiting on you"),
            h(PendingList, {
              items: waiting,
              notify: props.notify,
              onDecided: function (item) {
                setAnswered(function (n) { return n + 1; });
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
            delivered.merged
              ? h(Pill, { tone: "ok" }, "merged")
              : delivered.promoted_into
                ? h(Pill, { tone: "ok" }, "promoted into " + str(delivered.promoted_into))
                : demo
                  ? h(Pill, { tone: "idle" }, "demo output, stays on its branch")
                  : run.state === "interrupted"
                    ? h(Pill, { tone: "warn" }, "interrupted: kept on its branch")
                    : h(Pill, { tone: "warn" }, "not merged yet"),
            delivered.diffstat ? h("span", { className: "roko-dim" }, str(delivered.diffstat)) : null
          )
        : null,
      ended && tab !== "changes" ? h(DeliveryLines, { deliveries: run.deliveries }) : null,
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

  /**
   * How each plan's delivery into the run's batch branch went (`deliveries`, 0.5.0; roko gap-4f6cbe), in the
   * timeline's words. Shown only when one did not simply deliver: the branch line above says the usual case.
   */
  function DeliveryLines(props) {
    const all = list(props.deliveries).filter(obj);
    if (!all.some(function (d) { return str(d.state) !== "delivered"; })) return null;
    return h(
      "ul",
      { className: "rk-deliveries", "data-roko": "deliveries" },
      all.slice(0, 8).map(function (d, i) {
        const plan = "plan " + (oneLine(d.plan_id, 60) || "?");
        const into = str(d.target) ? " into " + oneLine(d.target, 80) : "";
        const st = str(d.state);
        const words =
          st === "delivering" ? "delivering " + plan + into
          : st === "delivered" ? plan + " delivered" + into
          : st === "cancelled" ? plan + ": its delivery was stopped by " + (oneLine(d.stopped, 80) || "a stop request")
          : st === "conflict" ? plan + " was not delivered: its merge" + into + " conflicted"
          : st === "regression_failed" ? plan + " was not delivered: the check on its merge failed"
          : plan + " was not delivered" + (str(d.reason) ? ": " + oneLine(d.reason, 160) : "");
        const ch = st === "delivered" ? "pass" : st === "delivering" ? "agent" : st === "cancelled" ? "off" : "fail";
        return h(
          "li",
          { key: i, "data-state": st || undefined },
          h(LED, { ch: ch, blink: false }),
          h("span", null, words),
          d.partial === true ? h("span", { className: "roko-dim" }, " · only the tasks that passed") : null
        );
      })
    );
  }

  // roko's plan-writing stages (gap-11d870), in the backend's words (rundata.WRITING_STAGES).
  const WRITING_STAGES = {
    planning: "planning",
    retrying: "retrying",
    fixing: "fixing the plan",
    regenerating: "rewriting the plan",
    writing: "writing its files",
    recording: "recording it",
  };
  /**
   * What roko's planner is doing (`writing`, 0.5.0): "writing the plan: planning · attempt 1 of 1", or, for a stage
   * that tries again, why ("retrying: the planner call ran into roko's 300 s limit … · attempt 2 of 2"). The clock
   * and the spend are drawn apart (a live clock), as the backend's `text` has them.
   */
  function writingWords(w) {
    const stage = str(w.stage);
    const words = WRITING_STAGES[stage] || stage;
    const reason = (stage === "retrying" || stage === "fixing" || stage === "regenerating") && str(w.reason) ? oneLine(w.reason, 200) : "";
    const parts = [reason ? words + ": " + reason : "writing the plan: " + words];
    if (isNum(w.attempt) && isNum(w.attempts)) parts.push("attempt " + w.attempt + " of " + w.attempts);
    return parts.join(" · ");
  }
  /**
   * When the writing started, from its `elapsed_s` at the card's `checked_at`, only when the elapsed time is sane (a
   * finite 0 s to a day); else NaN, and the line has no clock (as the desktop does).
   */
  function writingSince(run, w) {
    const at = isFinite(ms(run.checked_at)) ? ms(run.checked_at) : Date.now();
    const secs = w && isNum(w.elapsed_s) && isFinite(w.elapsed_s) && w.elapsed_s >= 0 && w.elapsed_s <= 86400 ? w.elapsed_s : null;
    return secs !== null ? at - secs * 1000 : NaN;
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
      // Where roko's planner is (`writing`, 0.5.0; null from an older roko and before its first stage): the line
      // `writing.text` says, with the clock ticking here (hermes-update's WritingLine, the same words).
      const w = obj(run.writing) && str(run.writing.stage) ? run.writing : null;
      const since = w ? writingSince(run, w) : ms(run.hermes_started_at);
      return h(
        "div",
        { className: "roko-planning", "data-roko": "planning" },
        h(
          "div",
          { className: "roko-planning-title" },
          h("span", { className: "roko-spinner", "aria-hidden": "true" }),
          w ? h("span", { "data-roko": "writing-line" }, writingWords(w)) : "roko's planner is writing the plan",
          isFinite(since) ? h(Ticker, { since: since, className: "roko-planning-clock", prefix: " · " }) : null,
          w && isNum(w.cost_usd) ? h("span", { className: "roko-planning-clock" }, " · " + money(w.cost_usd)) : null,
          w && str(w.model) ? h("span", { className: "roko-dim" }, " · " + oneLine(w.model, 40)) : null
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
      // roko keeps the last stage after the end: how far a failed writing got.
      const last = obj(run.writing);
      return h(
        Fragment,
        null,
        h(WhyCallout, { run: run }),
        last ? h("div", { className: "roko-dim roko-planning-last", "data-roko": "writing-last" }, "how far it got: " + (oneLine(last.text, 400) || writingWords(last) + (isNum(last.cost_usd) ? " · " + money(last.cost_usd) : ""))) : null
      );
    }
    // roko's validator rejects the written plan (0.5.0): it cannot run until its open questions are answered.
    const invalid = planBlocked(run) ? run.validation : detail && obj(detail.validation) && detail.validation.valid === false ? detail.validation : null;
    return h(
      "div",
      { className: "roko-planning is-done" + (invalid ? " is-blocked" : ""), "data-roko": "planning" },
      h(
        "div",
        { className: "roko-planning-title" },
        invalid ? h(LED, { ch: "you", blink: false }) : h(Icon, { name: "check", size: 16, weight: 2, className: "roko-tone-ok" }),
        invalid ? "roko wrote the plan, but it cannot run yet: " : "Plan ready: ",
        h("span", { className: "roko-mono" }, planId),
        isNum(detail && detail.task_count) || isNum(run.task_count)
          ? h("span", { className: "roko-dim" }, " · " + plural(isNum(detail && detail.task_count) ? detail.task_count : run.task_count, "task", "tasks"))
          : null
      ),
      detail ? h(RunGraph, { graph: planGraph(detail), tasks: list(detail.tasks).map(planTaskCard), planned: true }) : plan.error ? h(ErrorNote, { error: plan.error, compact: true }) : h(Skeleton, { rows: 3 }),
      invalid ? h(PlanValidationNote, { validation: invalid, planId: planId, group: detail && detail.group }) : null,
      h(
        "div",
        { className: "roko-row" },
        props.onOpenPlan ? h(Button, { type: "button", size: "sm", onClick: function () { props.onOpenPlan(planId); } }, "Open the plan") : null,
        h("span", { className: "roko-dim" }, invalid ? "Answer what roko asks in the plan, then run it from the Plans tab." : "Review it, then run it with a cap from the Plans tab.")
      )
    );
  }

  /** A plan's tasks as the graph's {waves, edges}. */
  function planGraph(plan) {
    const tasks = list(plan.tasks);
    const known = {};
    tasks.forEach(function (t) { known[str(t.id)] = true; });
    let waves = list(plan.waves).map(function (w) { return list(w).map(str); }).filter(function (w) { return w.length; });
    if (!waves.length) waves = wavesFromDeps(tasks);
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

  /** Tasks (`{id, depends_on}`) in waves: each task one wave after the latest task it depends on. */
  function wavesFromDeps(tasks) {
    const byId = {};
    tasks.forEach(function (t) { byId[str(t.id)] = t; });
    const level = {};
    function depth(id, seen) {
      if (level[id] != null) return level[id];
      if (seen[id]) return 0; // a cycle: roko's linter refuses those; draw it flat rather than loop
      seen[id] = true;
      let d = 0;
      list(byId[id] && byId[id].depends_on).forEach(function (dep) {
        if (byId[str(dep)]) d = Math.max(d, depth(str(dep), seen) + 1);
      });
      level[id] = d;
      return d;
    }
    const waves = [];
    tasks.forEach(function (t) {
      const id = str(t.id);
      const d = depth(id, {});
      while (waves.length <= d) waves.push([]);
      waves[d].push(id);
    });
    return waves.filter(function (w) { return w.length; });
  }

  /**
   * A run's graph for the sequencer: the card's, or one built from its tasks when the card has none (an older
   * backend, or a prompt run's single task), so one task is still one pad to click.
   */
  function graphOf(run, tasks) {
    const g = obj(run.graph);
    if (g && list(g.waves).some(function (w) { return list(w).length; })) return g;
    if (!tasks.length) return g || { waves: [], edges: [] };
    return planGraph({ tasks: tasks.map(function (t) { return Object.assign({}, t, { id: str(t.task_id) }); }) });
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

  /** Who picked an attempt's model (`source` / `decided_by`), in words. */
  const ROUTE_SOURCE_WORDS = {
    ladder: "the model ladder",
    router: "the router",
    learned: "what roko learned",
    task_hint: "the task's model hint",
    pinned: "the task's model hint",
    override: "an override",
    fallback: "the fallback",
    default: "the default model",
    explore: "the router, exploring",
    control: "the router's control arm",
    self_model: "the self-model",
    failover: "a failover",
  };

  /** One of the router's past picks: "picked by the model ladder · passed" (p only for a scored pick under 1). */
  function routeRowWords(r) {
    return [
      routeView(r).words,
      routeOdds(r),
      r.outcome === true ? "passed" : r.outcome === false ? "did not pass" : null,
    ].filter(Boolean).join(" · ");
  }

  /** A check's retry budget: "up to 1 retry · passes 92%", or that roko skips retrying it. */
  function retryBudgetWords(r) {
    const n = isNum(r.suggested_max_retries) ? r.suggested_max_retries : null;
    return [
      r.should_skip === true ? "no retries: it rarely passes on a retry" : n === null ? null : n === 0 ? "no retries" : "up to " + plural(n, "retry", "retries"),
      isNum(r.ema_pass_rate) ? "passes " + pct(r.ema_pass_rate) : null,
    ].filter(Boolean).join(" · ") || "—";
  }

  /** roko's learning loops by name (roko-learn's loops.toml, in the desktop's words); an unknown id shows as it is. */
  const LOOP_NAMES = {
    "L-route": "model routing",
    "L-linucb": "model routing (LinUCB stage)",
    "L-model-exp": "model experiments",
    "L-routing-log": "routing decision log",
    "L-know": "lessons in prompts",
    "L-rag11": "retrieval experiment",
    "L-play": "playbooks in prompts",
    "L-hdc": "episode recall",
    "L-err": "error patterns",
    "L-dream": "dream consolidation",
    "L-prompt-exp": "prompt experiments",
    "L-bid": "attention bidders",
    "L-sec": "prompt sections",
    "L-gate-thr": "check thresholds",
    "L-retry-budget": "retry budgets",
    "L-holdout": "holdout experiment",
    "L-M1": "M1 controller",
    "L-M3": "M3 self-model",
    "L-M4": "M4 audit feedback",
    "L-placebo": "placebo (checks the audit)",
  };
  // roko-learn's reason codes (loop_audit/spec.rs ReasonCode), in words.
  const LOOP_REASONS = {
    "dormant:label_only": "it only labels decisions",
    "dormant:degenerate": "it has nothing to vary",
    "dormant:no_opportunity": "no chance to act yet",
    "dormant:no_learning": "it learns nothing",
    "dormant:write_only": "what it learns is never read",
    "dormant:cut": "what it reads is empty",
    "dormant:stale": "it reads an old state",
    "dormant:mask": "something else overrides what it picks",
    "dormant:unlogged": "its effect is not recorded",
    inert: "it changes nothing",
    null: "no measurable benefit",
    harm: "it made things worse",
  };
  // roko's check rungs by number, as its adaptive thresholds and retry budgets key them: roko_gate::Rung's
  // index and label (rung_selector.rs), and the two sentinels gate_dispatch.rs used, 1000 for the plan-level
  // verification and 1001 for the post-merge regression gates.
  const RUNG_NAMES = { 0: "compile", 1: "lint", 2: "test", 3: "symbol", 4: "gen-test", 5: "prop-test", 6: "integration", 1000: "whole-plan", 1001: "post-merge" };
  /** A check rung's name: roko's own, else from its number, which the backend may send as text ("2"). */
  function rungName(r) {
    const name = str(r && r.name);
    if (name) return name;
    const n = r ? r.rung : null;
    const index = isNum(n) ? n : /^\d+$/.test(str(n)) ? Number(str(n)) : null;
    return index !== null ? RUNG_NAMES[index] || "rung " + index : oneLine(n, 22) || "a check";
  }

  /**
   * One learning loop's audit, worded: its name, its state ("on probation", "proven: its learning is in use",
   * "flagged: no chance to act yet", "demoted: roko uses its default"), and two of roko's numbers with labels: the
   * holdout (`h`, the share of decisions kept on roko's default to measure what the loop adds) and its reach (`eps`,
   * the share of decisions its learning changed). The desktop's words (ui-notes D8).
   */
  function loopHealthWords(l) {
    const id = str(l.loop_id);
    const st = str(l.state);
    const reason = str(l.reason);
    const why = LOOP_REASONS[reason] || reason.replace(/^dormant:/, "").replace(/_/g, " ");
    const state =
      st === "probation" ? "on probation"
      : st === "live" ? "proven: its learning is in use"
      : st === "flagged" ? "flagged" + (why ? ": " + why : "")
      : st === "demoted" ? "demoted: roko uses its default" + (why ? " (" + why + ")" : "")
      : st.replace(/_/g, " ") || "not checked yet";
    const ch =
      st === "live" || st === "healthy" ? "pass"
      : st === "demoted" || st === "degraded" || st === "tripped" ? "fail"
      : st === "flagged" || st === "watch" ? "you"
      : "off";
    const line = [
      state,
      isNum(l.h) ? "holdout " + pct(l.h) : null,
      isNum(l.eps) ? "reach " + pct(l.eps) : null,
      isNum(l.n_opp) ? plural(l.n_opp, "decision", "decisions") : null,
    ].filter(Boolean).join(" · ");
    return {
      name: LOOP_NAMES[id] || id || "a loop",
      line: line,
      ch: ch,
      title: (id ? id + ": " : "") + "holdout = the share of decisions roko keeps on its default, to measure what this loop adds; reach = how often what it learned reached a decision",
    };
  }

  /** Gate thresholds as roko keeps them: pass rate per rung, how sure, and where they moved. */
  function ThresholdTable(props) {
    return h(
      "table",
      { className: "rk-table" },
      h(
        "thead",
        null,
        h(
          "tr",
          null,
          h("th", { title: "the check (roko's gate rung)" }, "check"),
          h("th", { title: "how often it passes, weighted to recent runs" }, "passes"),
          h("th", { title: "how many results roko has seen" }, "runs seen"),
          h("th", { title: "whether roko just moved its threshold" }, "moved")
        )
      ),
      h(
        "tbody",
        null,
        props.rows.slice(0, 8).map(function (r, i) {
          const rate = isNum(r.ema_pass_rate) ? r.ema_pass_rate : null;
          return h(
            "tr",
            { key: str(r.rung || r.name) + i },
            h("td", { className: "roko-mono" }, rungName(r)),
            h("td", null, rate === null ? "—" : h("span", { className: "rk-rate" }, h("span", { className: "rk-rate-bar", "data-ch": rate >= 0.8 ? "pass" : rate >= 0.5 ? "you" : "fail", style: { width: (rate * 100).toFixed(0) + "%" } }), pct(rate))),
            h("td", { className: "roko-mono" }, isNum(r.observations) ? String(r.observations) : "—"),
            h("td", { className: "roko-mono" }, r.shift === true ? "yes" : r.shift === false ? "no" : r.shift == null ? "—" : str(r.shift))
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
                    return h("li", { key: i }, h("span", { className: "roko-mono" }, str(r.model || r.chosen || "?")), h("span", { className: "roko-dim" }, routeRowWords(r)));
                  })
                )
              : null,
            list(L1.retry_budgets).length
              ? h(
                  "ol",
                  { className: "rk-mini" },
                  list(L1.retry_budgets).slice(0, 5).map(function (r, i) {
                    return h("li", { key: "b" + i }, h("span", { className: "roko-mono" }, rungName(r)), h("span", { className: "roko-dim" }, retryBudgetWords(r)));
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
                  list(L2.diagnoses).filter(obj).slice(0, 4).map(function (d, i) {
                    // The backend's shape (insights.diagnoses): who, about what, what it found; as the desktop says it.
                    const said = [oneLine(d.source, 18), oneLine(d.subject, 24), oneLine(d.detail, 90)].filter(Boolean).join(" · ") || oneLine(d.summary || d.text || d.kind, 140);
                    const tip = [str(d.suggested_action) && "suggested: " + oneLine(d.suggested_action, 200), str(d.intervention_taken) && "done: " + oneLine(d.intervention_taken, 200)].filter(Boolean).join(" · ");
                    return h(
                      "li",
                      { key: i, title: tip || undefined },
                      h(LED, { ch: /warn|error|crit|alert|high/i.test(str(d.severity)) ? "fail" : "off", blink: false }),
                      h("span", null, said || "a diagnosis")
                    );
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
                      h("span", { className: "roko-dim" }, rate === null ? (isNum(m.tasks) ? plural(m.tasks, "task", "tasks") : "") : "passes " + pct(rate) + (isNum(m.tasks) ? " of " + plural(m.tasks, "task", "tasks") : ""))
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
                    const words = loopHealthWords(l);
                    return h(
                      "li",
                      { key: str(l.loop_id) || i, title: words.title },
                      h(LED, { ch: words.ch, blink: false }),
                      h("span", { className: "rk-mini-name" }, words.name),
                      h("span", { className: "roko-dim" }, words.line)
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
              const progress = endedProgress(run);
              const waits = runWaits(run, props.pending);
              // With roko down nothing is known to be working: the last known state stays, unlit and still.
              const stale = !!props.stale && isActiveState(run.state);
              const ch = stale ? "off" : runChannel(run, waits);
              return h(
                "button",
                {
                  key: str(run.run_id),
                  type: "button",
                  role: "listitem",
                  className: "roko-runitem roko-edge-" + tone + (selected ? " is-selected" : "") + (stale ? " is-stale" : ""),
                  "aria-current": selected ? "true" : undefined,
                  "data-roko-runitem": str(run.run_id),
                  "data-ch": ch,
                  onClick: function () {
                    sound.play("key", { user: true });
                    props.onSelect(run.run_id);
                  },
                },
                h(LED, { ch: ch, blink: isActiveState(run.state) && !stale ? undefined : false }),
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
                    h(
                      "span",
                      { className: "rk-state", "data-ch": ch, title: stale ? "roko serve is not answering: this is the run's last known state" : capStop(run) ? capStopWords(capStop(run)) : undefined },
                      stale ? "last seen running" : waits ? "waiting on you" : stateWord(run)
                    ),
                    progress && progress.total
                      ? h(StepStrip, { progress: progress, waiting: waits })
                      : run.kind === "plan_generate" && !isRunActive(run)
                        ? null
                        : h("span", { className: "roko-kind" }, KIND_LABEL[run.kind] || str(run.kind)),
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

  /** The TRY chips: the backend's requests about this project when it has them, else three that name no file. */
  function examplesOf(data) {
    const own = list(data && data.examples).map(function (e) { return oneLine(e, 300); }).filter(Boolean).slice(0, 3);
    return own.length ? own : EXAMPLES;
  }

  /**
   * The composer: one device for new work. A request, run at once ("run it") or planned first; or a plan roko
   * already has ("run a plan": the hello-world demo, a plan it wrote), with its cap. One field, one knob, one key.
   */
  function Composer(props) {
    const limits = useLimits();
    const setup = useSetup();
    const data = useOverview().data;
    const blocking = setup.blocking;
    const ceiling = ceilingOf(limits);
    const [source, setSource] = useState("request");
    const [planId, setPlanId] = useState(null);
    const [resume, setResume] = useState(false);
    const [mode, setMode] = useState("run");
    const [prompt, setPrompt] = useState(props.prompt || "");
    const [title, setTitle] = useState("");
    const [cap, setCap] = useState(defaultCap(ceiling));
    const [capTouched, setCapTouched] = useState(false);
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
        setSource(props.planMode || props.plan ? "plan" : "request");
        setPlanId(props.plan || null);
        setResume(!!props.resume);
        setDomain("code");
        setCustom("");
        setError(null);
        setTouched(false);
        setBusy(false);
        // A cap the caller names (a run's own, run again) stands; else a plan's starts from roko's estimate.
        setCapTouched(isNum(props.cap));
        // The limits may have arrived since the page loaded: start from a cap that fits them.
        setCap(function (current) {
          const wanted = isNum(props.cap) ? props.cap : current;
          const fits = wanted !== "custom" && isNum(wanted) && wanted >= 0.01 && (ceiling === null || wanted <= ceiling + 1e-9);
          return fits ? wanted : defaultCap(ceiling);
        });
      }
    }, [props.open, props.prompt, props.plan, props.planMode]);

    // roko's plans (for "run a plan", and the demo chip): read while the composer is open.
    const plansRes = useResource(props.open ? "/plans" : null, 0);
    const plans = plansRes.data ? list(plansRes.data.plans).filter(obj) : [];
    const known = groupsKnown(plans);
    const startHere = plans.filter(function (p) { return isStartHere(p, known); })[0] || null;
    // Nothing is picked for the person but the demo roko says to start with.
    const pickedId = planId || (source === "plan" && startHere ? str(startHere.id) : null);
    const picked = plans.filter(function (p) { return str(p.id) === pickedId; })[0] || null;
    const sameTitle = {};
    plans.forEach(function (p) { sameTitle[str(p.title)] = (sameTitle[str(p.title)] || 0) + 1; });
    const detailRes = useResource(props.open && source === "plan" && pickedId ? "/plans/" + enc(pickedId) : null, 0);
    const detail = detailRes.data ? obj(detailRes.data.plan) : null;
    const est = detail ? obj(detail.estimate) : null;

    // A plan's cap starts from roko's estimate, until the person turns the knob.
    useEffect(function () {
      if (source !== "plan" || capTouched || !detail) return;
      const first = planCap(ceiling, est);
      if (isNum(first)) setCap(first);
    }, [source, pickedId, !!detail, capTouched]);

    function turnCap(v) {
      setCapTouched(true);
      setCap(v);
    }

    const planSource = source === "plan";
    const capValue = cap === "custom" ? Number(custom) : cap;
    const capTooHigh = ceiling !== null && isNum(capValue) && capValue > ceiling + 1e-9;
    const capOk = (!planSource && mode === "plan") || (isNum(capValue) && capValue >= 0.01 && !capTooHigh && !(cap === "custom" && custom.trim() === ""));
    const promptOk = prompt.trim().length > 0 && prompt.length <= 8000;
    // A picked plan roko would not run now (`validation`, 0.5.0): the device says why; nothing to start.
    const pickedInvalid = planSource && detail && obj(detail.validation) && detail.validation.valid === false ? detail.validation : null;
    const ready = (planSource ? !!pickedId && !pickedInvalid && !(error && error.validation) : promptOk) && capOk && !busy && !blocking;
    const refusal = error && error.problem ? error.problem : null;
    const writesPlan = !planSource && mode === "plan";

    function done(res, words) {
      setBusy(false);
      if (res.ok) {
        sound.play("run", { user: true });
        props.notify(words + shortId(res.data.run_id), "success");
        overviewStore.refresh();
        props.onClose();
        props.onStarted(res.data);
        return;
      }
      setError(res.error);
    }

    function submit() {
      setTouched(true);
      if (!ready) return;
      setBusy(true);
      setError(null);
      if (planSource) {
        const payload = { max_usd: Math.round(capValue * 100) / 100, resume: resume };
        if (title.trim()) payload.title = title.trim();
        apiPost("/plans/" + enc(pickedId) + "/run", payload).then(function (res) {
          done(res, "Started run of " + (picked ? oneLine(picked.title || picked.id, 60) : pickedId) + ": ");
          // roko will not run the plan as it is: read it again, so the device says why and start stays off.
          if (!res.ok && res.error.validation) detailRes.reload();
        });
        return;
      }
      const body = { prompt: prompt.trim() };
      if (title.trim()) body.title = title.trim();
      if (mode === "plan") body.plan = true;
      else {
        body.max_usd = Math.round(capValue * 100) / 100;
        if (domain !== "code") body.domain = domain;
      }
      apiPost("/runs", body).then(function (res) {
        done(res, mode === "plan" ? "roko is writing a plan: " : "Started run ");
      });
    }

    function usePlan(id) {
      setSource("plan");
      setPlanId(id || null);
      setError(null);
    }

    const capField = h(
      "div",
      { className: "roko-field rk-capfield" },
      h("span", { className: "rk-module-head" }, h("span", { className: "rk-module-idx" }, planSource ? "03" : "04"), h("span", { className: "rk-module-label" }, "SPENDING CAP")),
      h(
        "div",
        { className: "rk-capctl" },
        h(Knob, {
          label: "Spending cap",
          detents: CAP_PRESETS,
          max: ceiling === null ? undefined : ceiling,
          value: cap === "custom" ? (isNum(capValue) && capValue > 0 ? capValue : CAP_PRESETS[0]) : cap,
          onChange: turnCap,
        }),
        h(
          "div",
          { className: "rk-capcustom" },
          h(Key, { size: "s", label: "custom", pressed: cap === "custom", onClick: function () { turnCap("custom"); } }),
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
        : h(
            "span",
            { className: "roko-dim rk-small" },
            planSource && est && isNum(est.total_cost_usd)
              ? "roko estimates " + money(est.total_cost_usd) + " for this plan; it stops spending at the cap."
              : "roko stops spending at the cap; the run is checked before it counts as done."
          )
    );

    const titleField = h(
      "label",
      { className: "roko-field" },
      h("span", { className: "rk-module-head" }, h("span", { className: "rk-module-idx" }, "02"), h("span", { className: "rk-module-label" }, "TITLE"), h("span", { className: "rk-module-right" }, "optional")),
      h(Input, {
        type: "text",
        value: title,
        maxLength: 80,
        placeholder: planSource ? "The plan's own title, if empty" : "Names the run in lists",
        "aria-label": "Title",
        onChange: function (event) { setTitle(event.target.value); },
      })
    );

    let device;
    if (planSource) {
      device = h(
        Fragment,
        null,
        h(
          "div",
          { className: "rk-device-row" },
          h("span", { className: "rk-device-hint" }, "a plan roko already has: its tasks and checks are set"),
          h("span", { className: "roko-flex" }),
          h(Key, { size: "s", icon: "plus", label: "a new request", name: "composer-request", onClick: function () { setSource("request"); setError(null); } })
        ),
        h(
          "div",
          { className: "roko-field rk-field" },
          h("span", { className: "rk-module-head" }, h("span", { className: "rk-module-idx" }, "01"), h("span", { className: "rk-module-label" }, "WHICH PLAN?")),
          !plansRes.data && plansRes.error ? h(ErrorNote, { error: plansRes.error, compact: true, onRetry: plansRes.reload }) : null,
          !plansRes.data && !plansRes.error ? h(Skeleton, { rows: 3 }) : null,
          plansRes.data && !plans.length ? h("div", { className: "roko-dim" }, "roko has no plans yet. Write one with a new request and “plan first”.") : null,
          plans.length
            ? h(
                "div",
                { className: "rk-planpick", role: "radiogroup", "aria-label": "Which plan", "data-roko": "composer-plans" },
                // Two plans with one title are told apart by their ids.
                sectionPlans(plans).map(function (section) {
                  return h(
                    "div",
                    { key: section.id, className: "rk-planpick-group" },
                    h("div", { className: "rk-tiny" }, section.label),
                    section.plans.map(function (p) {
                      const id = str(p.id);
                      const on = id === pickedId;
                      return h(
                        "button",
                        {
                          key: id,
                          type: "button",
                          role: "radio",
                          "aria-checked": on ? "true" : "false",
                          className: "rk-planpick-item" + (on ? " is-on" : ""),
                          "data-roko-pick": id,
                          onClick: function () { setPlanId(id); setError(null); },
                        },
                        h(LED, { ch: on ? "you" : "off", blink: false }),
                        h(
                          "span",
                          { className: "rk-planpick-title" },
                          h("span", null, str(p.title) || id),
                          // Two plans with one title: their ids tell them apart, by their ends ("…-ledger-2").
                          str(p.title) && sameTitle[str(p.title)] > 1 ? h("span", { className: "rk-planpick-id roko-mono", title: id }, id.length > 24 ? "…" + id.slice(-23) : id) : null
                        ),
                        isStartHere(p, known) ? h("span", { className: "roko-starthere" }, "start here") : null,
                        h("span", { className: "rk-planpick-n roko-dim" }, plural(isNum(p.task_count) ? p.task_count : 0, "task", "tasks"))
                      );
                    })
                  );
                })
              )
            : null,
          picked
            ? h(
                "span",
                { className: "roko-field-foot" },
                h(
                  "span",
                  { className: "roko-dim" },
                  [
                    plural(isNum(picked.task_count) ? picked.task_count : 0, "task", "tasks"),
                    detail ? plural(planGraph(detail).waves.length, "wave", "waves") : null,
                    est && isNum(est.total_cost_usd) ? "roko estimates " + money(est.total_cost_usd) : null,
                    isDemoPlan(picked, known) ? "a demo: its output stays on its run branch" : null,
                  ].filter(Boolean).join(" · ")
                ),
                h(
                  "label",
                  { className: "roko-check" },
                  h("input", { type: "checkbox", checked: resume, onChange: function (event) { setResume(!!event.target.checked); } }),
                  h("span", null, "skip tasks that already passed")
                )
              )
            : null
        ),
        h("div", { className: "rk-device-grid" }, h("div", { className: "rk-device-col" }, titleField), capField)
      );
    } else {
      const examples = examplesOf(data);
      device = h(
        Fragment,
        null,
        h(
          "div",
          { className: "rk-device-row" },
          h(Switch, {
            label: "How roko should take it",
            value: mode,
            onChange: setMode,
            items: [{ id: "run", label: "run it" }, { id: "plan", label: "plan first" }],
          }),
          h("span", { className: "rk-device-hint" }, mode === "plan" ? "a graph of tasks you review, then run" : "one checked task, now"),
          h("span", { className: "roko-flex" }),
          h(Key, { size: "s", icon: "graph", label: "run a plan", name: "composer-plan", title: "Run a plan roko already has, such as the hello world demo", onClick: function () { usePlan(null); } })
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
              startHere
                ? h(
                    "button",
                    { key: "demo", type: "button", className: "roko-example roko-example--plan", "data-roko": "try-demo", onClick: function () { usePlan(str(startHere.id)); } },
                    "▶ " + oneLine(str(startHere.title || startHere.id).replace(/^start here:\s*/i, ""), 60)
                  )
                : null,
              examples.map(function (ex) {
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
            titleField,
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
            ? capField
            : h("div", { className: "roko-dim roko-composer-note" }, h(Icon, { name: "info", size: 12 }), " The planner spends a little model budget and runs nothing. You review the plan, then run it with a cap.")
        )
      );
    }

    return h(
      Modal,
      {
        open: props.open,
        name: "composer",
        icon: "bolt",
        wide: true,
        title: "new run",
        subtitle: planSource
          ? "roko runs the plan's tasks on agents; each counts as done only when its checks pass."
          : "roko's agents do the work on a branch; your project's checks decide when it is done.",
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
            title: blocking ? blocking.title : planSource && (pickedInvalid || (error && error.validation)) ? "roko won't run this plan yet: see why above" : undefined,
            busy: busy,
            kbd: "⌘↵",
            keys: "Control+Enter Meta+Enter",
            ariaLabel: planSource ? "Run the plan" : writesPlan ? "Write the plan" : "Start the run",
            label: busy
              ? writesPlan ? "asking the planner…" : "starting…"
              : planSource ? "run plan" + (capOk && isNum(capValue) ? " · cap " + money(capValue) : "") : writesPlan ? "write the plan" : "start",
            onClick: submit,
          })
        ),
      },
      h(
        "div",
        { className: "roko-composer rk-device" + (planSource ? " is-planrun" : "") },
        device,
        h(FixDoneNote, { problems: setup.problems }),
        blocking && !refusal ? h(ProblemCard, { problem: blocking, lead: "roko can't start work from Hermes until this is fixed:" }) : null,
        refusal ? h(ProblemCard, { problem: refusal, lead: planSource ? "roko did not start the plan:" : "roko did not start it:" }) : null,
        // The picked plan fails roko's validator (before a start), or roko refused the start for it.
        planSource && (pickedInvalid || (error && error.validation))
          ? h(PlanValidationNote, { validation: pickedInvalid || error.validation, planId: pickedId, group: detail && detail.group })
          : null,
        error && !refusal && !error.validation ? h(ErrorNote, { error: error, compact: true }) : null
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
    const data = useOverview().data;
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
              // The demo to start with, when roko has one: it runs anywhere and shows the whole loop.
              h(
                "button",
                { key: "demo", type: "button", className: "roko-example roko-example--plan", "data-roko": "onboard-plan", onClick: function () { props.onCompose("", { plan: true }); } },
                "▸ run a plan roko already has, such as its hello world demo"
              ),
              examplesOf(data).map(function (ex) {
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
    const unreachable = rokoDown(data);
    const checked = wallClock(ms(data.checked_at));
    return h(
      "div",
      { className: "roko-runs" },
      h(
        "div",
        { className: "roko-runs-side" },
        unreachable
          ? h("div", { className: "roko-note-line roko-dim", "data-roko": "last-known" }, "Showing the last known runs" + (checked ? " · checked " + checked : "") + "; the page asks again every few seconds")
          : null,
        runs.length ? h(RunList, { runs: runs, pending: list(data.pending), selected: selected, stale: unreachable, onSelect: props.onSelectRun }) : null,
        h("div", { className: "roko-runs-keys roko-dim", "aria-hidden": "true" }, h(Kbd, null, "j"), h(Kbd, null, "k"), " move · ", h(Kbd, null, "n"), " new run · ", h(Kbd, null, "?"), " keys")
      ),
      selected
        ? h(RunView, {
            key: selected,
            runId: selected,
            source: (runs.filter(function (r) { return r.run_id === selected; })[0] || {}).source || null,
            stale: unreachable,
            onCompose: props.onCompose,
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
          answeredStore.add(item);
          overviewStore.touch();
          props.onDecided(item, res.data);
          return;
        }
        setError(res.error);
        props.notify(res.error.message, "error");
        // roko no longer knows the code: read the lists again; what still waits shows (the desktop's rule: only an
        // answer roko took is kept apart, so a sign-off that still waits never stays hidden).
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
    // Bumped by an answer, so the list leaves it out at once (the shared store decides what stays apart).
    const [, setAnswered] = useState(0);
    const items = res.data ? list(res.data.items).filter(function (it) { return !answeredStore.has(it); }) : [];
    // roko's whole list: what it no longer lists needs no hiding any more.
    useEffect(function () { if (res.data) answeredStore.settle(res.data.items); }, [res.data]);
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
          setAnswered(function (n) { return n + 1; });
          res.reload();
          overviewStore.refresh();
        },
      })
    );
  }

  // ---------------------------------------------------------------------------
  // Plans
  // ---------------------------------------------------------------------------

  /** Run plan…'s first cap: the composer's default, or the smallest detent at or above roko's estimate. */
  function planCap(ceiling, est) {
    const base = defaultCap(ceiling);
    const want = est && isNum(est.total_cost_usd) ? est.total_cost_usd : 0;
    if (!isNum(base) || want <= base) return base;
    const fits = CAP_PRESETS.filter(function (c) { return c >= want - 1e-9 && (ceiling === null || c <= ceiling + 1e-9); });
    return fits.length ? fits[0] : base;
  }

  function RunPlanForm(props) {
    const plan = props.plan;
    const limits = useLimits();
    const setup = useSetup();
    const blocking = setup.blocking;
    // roko would not run this plan now (`validation`, 0.5.0): the plan detail says why, above.
    const planInvalid = obj(plan.validation) && plan.validation.valid === false ? plan.validation : null;
    const ceiling = ceilingOf(limits);
    // The composer's default cap ($0.50), or the smallest detent that covers roko's estimate for this plan.
    const [cap, setCap] = useState(function () {
      const first = planCap(ceiling, obj(plan.estimate));
      return isNum(first) ? first.toFixed(2) : "";
    });
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
        // roko will not run the plan as it is: read it again, so its own note says why and Run plan… goes off.
        if (res.error.validation && props.onRefused) props.onRefused();
      });
    }

    return h(
      "form",
      {
        className: "roko-runform",
        onSubmit: function (event) {
          event.preventDefault();
          if (capOk && !busy && !blocking && !planInvalid) setConfirming(true);
        },
      },
      h("div", { className: "roko-runform-title" }, h(Icon, { name: "play", size: 12 }), "Run this plan"),
      h(
        "div",
        { className: "roko-runform-fields" },
        h(
          "div",
          { className: "roko-runform-caps" },
          CAP_PRESETS.map(function (c) {
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
        h(
          Button,
          {
            size: "sm",
            type: "submit",
            disabled: !capOk || busy || !!blocking || !!planInvalid,
            title: blocking ? blocking.title : planInvalid ? "roko won't run this plan yet: see why above" : undefined,
            "data-roko": "run-plan",
          },
          busy ? "Starting…" : "Run plan…"
        )
      ),
      // A fix's outcome shows once, at the top of the page (the setup area), not again here.
      blocking ? h(ProblemCard, { problem: blocking, lead: "Plans can't run from Hermes until this is fixed:" }) : null,
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
      error && error.problem ? h(ProblemCard, { problem: error.problem, lead: "roko did not start the plan:" }) : null,
      error && !error.problem && !error.validation ? h(ErrorNote, { error: error }) : null,
      // roko refused it because the plan fails its validator: why and what to answer, until the plan's own note says it.
      error && error.validation && !planInvalid ? h(PlanValidationNote, { validation: error.validation, planId: plan.plan_id, group: plan.group }) : null,
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

  /** The most tasks of a plan that run at the same time: its widest wave, capped by its `max_parallel`. */
  function atOnce(graph, plan) {
    const widest = list(graph.waves).reduce(function (m, w) { return Math.max(m, list(w).length); }, 0);
    const cap = isNum(plan.max_parallel) && plan.max_parallel > 0 ? plan.max_parallel : Infinity;
    return Math.min(widest, cap);
  }
  /** The desktop's words (ui-notes U10): "2 at once", or "one task at a time". */
  function atOnceWords(graph, plan) {
    const n = atOnce(graph, plan);
    if (!n) return "no tasks";
    return n > 1 ? n + " at once" : "one task at a time";
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
          h(Instrument, { label: "Waves", sub: graph.waves.length > 1 ? "each wave waits for the one before" : null }, h("span", { className: "roko-big roko-mono" }, String(graph.waves.length))),
          // How many tasks can really run together: the widest wave, within the plan's own limit (a plan of
          // two waves of one task each runs one at a time, whatever its max_parallel says).
          h(
            Instrument,
            { label: "Parallel", sub: atOnceWords(graph, plan), title: atOnce(graph, plan) > 1 ? atOnce(graph, plan) + " tasks side by side at most" : undefined },
            h("span", { className: "roko-big roko-mono" }, String(atOnce(graph, plan) || "—"))
          ),
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
      // roko would not run this plan now: why, and what to answer, before the person presses Run plan….
      h(PlanValidationNote, { validation: plan.validation, planId: plan.plan_id || props.planId, group: plan.group }),
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
      h(RunPlanForm, { plan: Object.assign({ plan_id: props.planId }, plan), notify: props.notify, onStarted: props.onStarted, onRefused: res.reload })
    );
  }

  /** Open questions, one per line: "T2 Should … · suggested: …" (the task id only where it is not already said). */
  function OpenQuestions(props) {
    return h(
      "ul",
      { className: "rk-plan-questions" },
      list(props.questions).slice(0, 8).map(function (q, i) {
        return h(
          "li",
          { key: i },
          props.withTask && str(q.task_id) ? h("b", null, oneLine(q.task_id, 16) + " ") : null,
          oneLine(q.question, 300),
          str(q.assumption) ? h("span", { className: "roko-dim" }, " · suggested: " + oneLine(q.assumption, 300)) : null
        );
      })
    );
  }

  /**
   * Why roko will not run this plan yet (`validation`, 0.5.0): roko's words, and the questions its planner left open
   * on a task with the answer it suggested. They are answered in the plan's tasks.toml; `roko plan validate` says
   * what is left. The desktop's words (ui-notes P1).
   */
  function PlanValidationNote(props) {
    const v = obj(props.validation);
    if (!v) return null;
    return h(
      "div",
      { className: "rk-validation", role: "note", "data-roko": "plan-validation" },
      h(LED, { ch: "you", blink: false }),
      h(
        "div",
        { className: "rk-validation-body" },
        h("div", { className: "rk-validation-title" }, "roko won't run this plan yet"),
        h(ValidationItems, { validation: v }),
        h(ValidationStep, { validation: v, planId: props.planId, group: props.group })
      )
    );
  }

  /**
   * What roko's validator found, one line each: roko's own words for each error (the open-questions rule is said by
   * the questions themselves), then each open question with the answer the planner suggested; else its summary.
   */
  function ValidationItems(props) {
    const v = props.validation;
    const questions = list(v.open_questions).filter(obj);
    const errors = list(v.errors).filter(function (e) { return obj(e) && str(e.message) && !(questions.length && str(e.rule) === "PLAN_045"); });
    if (!questions.length && !errors.length) return h("p", { className: "rk-validation-text" }, oneLine(v.summary, 600));
    return h(
      "ul",
      { className: "rk-plan-questions", "data-roko": "validation-items" },
      errors.slice(0, 6).map(function (e, i) {
        return h(
          "li",
          { key: "e" + i, "data-kind": "error" },
          str(e.task_id) ? h("b", null, oneLine(e.task_id, 16) + " ") : null,
          oneLine(e.message, 300),
          str(e.rule) ? h("span", { className: "roko-dim" }, " · " + oneLine(e.rule, 24)) : null
        );
      }),
      questions.slice(0, 8).map(function (q, i) {
        return h(
          "li",
          { key: "q" + i, "data-kind": "question" },
          str(q.task_id) ? h("b", null, oneLine(q.task_id, 16) + " ") : null,
          oneLine(q.question, 300),
          str(q.assumption) ? h("span", { className: "roko-dim" }, " · suggested: " + oneLine(q.assumption, 300)) : null
        );
      })
    );
  }

  /** The person's step: answer the questions in tasks.toml; `roko plan validate <dir>` says what is left. */
  function ValidationStep(props) {
    const planId = str(props.planId);
    const group = str(props.group);
    // roko's plans live in plans/<group>/<id> (the listing's `group` is that folder).
    const dir = planId ? "plans/" + (group ? group + "/" : "") + planId : "";
    return h(
      "p",
      { className: "rk-validation-text roko-dim" },
      list(props.validation.open_questions).some(obj) ? "Answer each in the plan's tasks.toml, then delete it from open_questions. " : "",
      dir ? h("code", { className: "roko-mono" }, "roko plan validate " + dir) : "roko plan validate",
      " says what is left."
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
      list(t.open_questions).filter(obj).length
        ? h("div", { className: "roko-inspector-sec" }, h(Label, null, "Open questions"), h(OpenQuestions, { questions: list(t.open_questions).filter(obj) }))
        : null,
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
    // 0.5.0: what roko's validator says this task still asks (its plan cannot run until it is answered).
    const asked = list(t.open_questions).filter(obj);
    return h(
      "div",
      { className: "roko-plantask", role: "listitem", "data-roko-plantask": str(t.id) },
      h(
        "div",
        { className: "roko-plantask-head" },
        h("span", { className: "roko-mono roko-task-id" }, str(t.id)),
        h("span", { className: "roko-plantask-title" }, str(t.title)),
        t.role ? h("span", { className: "roko-kind" }, str(t.role)) : null,
        asked.length ? h("span", { className: "rk-question-tag", "data-roko": "open-question" }, asked.length === 1 ? "open question" : asked.length + " open questions") : null
      ),
      asked.length ? h(OpenQuestions, { questions: asked }) : null,
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

  /**
   * One of roko's demos (`plans/demos/…`, or a plan still marked `fixture`): a showcase, not the person's work.
   * Its output belongs on its run's branch: merged, it clutters the person's branch, and a later run of the demo
   * would find its check already passing and have nothing new to show. Never merge demo output.
   */
  function isDemoPlan(p, groupsKnown) {
    // A newer backend says so (`demo`); then nothing is guessed.
    if (p && typeof p.demo === "boolean") return p.demo;
    const group = str(p && p.group);
    return (
      group === "demos" ||
      group.indexOf("demos/") === 0 ||
      // roko says `fixture` only until a demo's first run (gap-8f84d1); `group` stays.
      str(p && p.status) === "fixture" ||
      // An older roko or plugin sends no `group` at all: a `demo-` id is the sign left.
      (groupsKnown === false && str(p && p.id).indexOf("demo-") === 0)
    );
  }

  /** Whether roko said which set each plan is in (a plan at the top of plans/ has none; an older roko sends none). */
  function groupsKnown(plans) {
    return plans.some(function (p) { return !!str(p && p.group); });
  }

  /** The demo roko says to run first: its title starts with "Start here". */
  function isStartHere(p, known) {
    if (p && typeof p.start_here === "boolean") return p.start_here;
    return isDemoPlan(p, known) && /^start here\b/i.test(str(p && p.title));
  }

  /** The plan list's sections: the demos first (the one to start with on top), then the person's plans by set. */
  function sectionPlans(plans) {
    const known = groupsKnown(plans);
    const demos = plans.filter(function (p) { return isDemoPlan(p, known); });
    const own = plans.filter(function (p) { return !isDemoPlan(p, known); });
    const sets = [];
    own.forEach(function (p) {
      if (sets.indexOf(str(p.group)) < 0) sets.push(str(p.group));
    });
    // Top-level plans first, then each set in roko's order.
    sets.sort(function (a, b) { return Number(Boolean(a)) - Number(Boolean(b)); });
    return [{ id: "demos", label: "Demos", plans: demos.filter(function (p) { return isStartHere(p, known); }).concat(demos.filter(function (p) { return !isStartHere(p, known); })) }]
      .concat(sets.map(function (g) {
        return { id: "set:" + g, label: g || (demos.length ? "Your plans" : "Plans"), plans: own.filter(function (p) { return str(p.group) === g; }) };
      }))
      .filter(function (section) { return section.plans.length; });
  }

  /**
   * Whether a run ran one of roko's demos, from the plan list (a run's card does not say): true, false, or null
   * while the list loads. A list that fails to load counts as no demo.
   */
  function useDemoRun(run) {
    // A newer backend says so on the card (`demo`, or its merge state's); otherwise the plan list does.
    const said = run ? (typeof run.demo === "boolean" ? run.demo : obj(run.merge) && typeof run.merge.demo === "boolean" ? run.merge.demo : null) : null;
    const planId = run && run.kind === "plan" && said === null ? str(run.plan_id) : "";
    const res = useResource(planId ? "/plans" : null, 0);
    if (said !== null) return said;
    if (!planId) return false;
    if (!res.data) return res.status === "error" ? false : null;
    const rows = list(res.data.plans);
    const known = groupsKnown(rows);
    return rows.some(function (p) { return str(p.id) === planId && isDemoPlan(p, known); });
  }

  function PlansSection(props) {
    const plansRes = useResource("/plans", 0);
    const plans = plansRes.data ? list(plansRes.data.plans) : [];
    // Nothing is chosen for the person except the demo roko says to start with: a real plan waits to be picked.
    const known = groupsKnown(plans);
    const startHere = plans.filter(function (p) { return isStartHere(p, known); })[0];
    const selected = props.selectedPlanId || (startHere ? str(startHere.id) : null);
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
              { className: "roko-runlist", "data-roko": "plan-list" },
              sectionPlans(plans).map(function (section) {
                return h(
                  "div",
                  { key: section.id, className: "roko-rungroup", "data-roko-plans": section.id },
                  h("div", { className: "roko-rungroup-head" }, h("span", null, section.label), h("span", { className: "roko-rungroup-n" }, String(section.plans.length))),
                  h(
                    "div",
                    { role: "list" },
                    section.plans.map(function (p) {
                      const isSel = str(p.id) === selected;
                      const done = isNum(p.tasks_done) ? p.tasks_done : 0;
                      const total = isNum(p.task_count) ? p.task_count : 0;
                      const demo = isDemoPlan(p, known);
                      // A demo's `fixture` is roko's marker, not news for the person.
                      const status = demo && str(p.status) === "fixture" ? "demo" : str(p.status || "plan");
                      return h(
                        "button",
                        {
                          key: str(p.id),
                          type: "button",
                          role: "listitem",
                          className: "roko-runitem" + (isSel ? " is-selected" : ""),
                          "aria-current": isSel ? "true" : undefined,
                          "data-roko-plan": str(p.id),
                          onClick: function () { props.onSelectPlan(p.id); },
                        },
                        h("span", { className: "roko-runitem-glyph" }, h(Icon, { name: "graph", size: 13 })),
                        h(
                          "span",
                          { className: "roko-runitem-main" },
                          h(
                            "span",
                            { className: "roko-runitem-top" },
                            h("span", { className: "roko-runitem-label" }, str(p.title) || str(p.id)),
                            isStartHere(p, known) ? h("span", { className: "roko-starthere" }, "start here") : null
                          ),
                          h(
                            "span",
                            { className: "roko-runitem-meta" },
                            h(Pill, { tone: status.indexOf("not pass") >= 0 ? "bad" : status.indexOf("done") === 0 ? "ok" : "idle" }, status),
                            h(SegBar, { progress: { total: total, passed: done, failed: isNum(p.tasks_not_passed) ? p.tasks_not_passed : 0, pending: Math.max(0, total - done) } }),
                            h("span", { className: "roko-runitem-cost" }, done + "/" + total)
                          ),
                          h("span", { className: "roko-runitem-id roko-mono" }, str(p.id))
                        )
                      );
                    })
                  )
                );
              })
            )
          : h(Empty, { icon: "graph", title: "roko has no plans yet" }, "Use New run → Plan it first, or ask Hermes to plan larger work with roko.")
      ),
      selected
        ? h(PlanDetail, { key: selected, planId: selected, notify: props.notify, onStarted: props.onRunStarted })
        : plans.length
          ? h(
              "div",
              { className: "roko-plandetail", "data-roko": "plan-pick" },
              h(Empty, { icon: "graph", title: "Pick a plan" }, "Its tasks, checks and estimate show here. Nothing runs until you press Run plan and say yes.")
            )
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

  /** A date as the person's locale says a day and a month: "12 Oct" or "Oct 12". */
  function dayWords(t) {
    if (!isFinite(t)) return "";
    try {
      return new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short" });
    } catch (_) {
      return "";
    }
  }

  /**
   * What an /insights answer covers: its `scope` ({kind, label, since, until}) from a newer backend, which can show
   * the runs Hermes started or the whole workspace; an older backend always reads the whole workspace, so its
   * numbers say so, with the period its spend covers.
   */
  function insightScope(data) {
    const sc = obj(data && data.scope);
    // The desktop's words (ui-notes R4): "numbers for runs started from Hermes · since 12 Oct", "… · 12 Oct – 15 Oct";
    // an older backend's numbers are the whole workspace's.
    const since = sc ? dayWords(ms(sc.since)) : "";
    const until = sc ? dayWords(ms(sc.until)) : "";
    const period = since && until && since !== until ? since + " – " + until : since ? "since " + since : "";
    const label = sc ? plain(sc.label) || "this workspace" : "the whole workspace";
    return {
      kind: sc ? str(sc.kind) || "hermes" : "workspace",
      label: label,
      line: sc ? ["numbers for " + label, period].filter(Boolean).join(" · ") : "the whole workspace",
      scoped: !!sc,
    };
  }

  function HealthSection() {
    const [scope, setScope] = useState("hermes");
    const health = useResource("/health", 0);
    const insights = useResource("/insights?scope=" + scope, 0);
    const checks = health.data ? list(health.data.checks) : [];
    const data = insights.data || {};
    // The checks panel lists checks; a newer backend marks the task verdict rows (`kind: verdict`) apart.
    const gates = list(data.gates).filter(function (g) { return obj(g) && str(g.kind) !== "verdict"; });
    const models = list(data.models);
    const trend = list(data.cost_trend);
    const eff = obj(data.efficiency) || {};
    const summary = obj(data.summary);
    const where = insightScope(data);
    function reloadAll() { health.reload(); insights.reload(); }

    // A newer backend sums them for its scope, never counting "no check ran" as a failure; an older one is read here.
    const sumChecks = summary ? obj(summary.checks) : null;
    const gateRuns = sumChecks && isNum(sumChecks.ran) ? sumChecks.ran : gates.reduce(function (n, g) { return n + (isNum(g.total) ? g.total : 0); }, 0);
    const gatePassed = sumChecks && isNum(sumChecks.passed) ? sumChecks.passed : gates.reduce(function (n, g) { return n + (isNum(g.passed) ? g.passed : 0); }, 0);
    const gateRate = sumChecks && isNum(sumChecks.pass_rate) ? sumChecks.pass_rate : gateRuns ? gatePassed / gateRuns : null;
    const sumTasks = summary ? obj(summary.tasks) : null;
    const taskCount = sumTasks && isNum(sumTasks.total) ? sumTasks.total : models.reduce(function (n, m) { return n + (isNum(m.tasks) ? m.tasks : 0); }, 0);
    const verified = sumTasks && isNum(sumTasks.verified) ? sumTasks.verified : null;
    const unverifiedTasks = sumTasks && isNum(sumTasks.unverified) ? sumTasks.unverified : 0;
    // The workspace scope: roko cannot tell a task no check ran on from one that failed (`not_verified`).
    const notVerified = sumTasks && isNum(sumTasks.not_verified) ? sumTasks.not_verified : null;
    const taskRate = verified !== null
      ? taskCount - unverifiedTasks > 0 ? verified / (taskCount - unverifiedTasks) : null
      : taskCount
        ? models.reduce(function (n, m) { return n + (isNum(m.tasks) && isNum(m.success_rate) ? m.tasks * m.success_rate : 0); }, 0) / taskCount
        : null;
    const spent = summary && isNum(summary.spend_usd) ? summary.spend_usd : eff.total_cost_usd;
    const perTask = summary && isNum(summary.cost_per_task_usd) ? summary.cost_per_task_usd : eff.cost_per_task_usd;
    const typical = summary && isNum(summary.typical_task_ms) ? summary.typical_task_ms : eff.avg_task_duration_ms;
    const bad = checks.filter(function (c) { return c.status !== "ok"; }).length;
    // A newer backend counts the runs of its scope by outcome: "1 passed · 1 unverified · 1 failed".
    const sumRuns = summary ? obj(summary.runs) : null;
    const runsTotal = sumRuns
      ? isNum(sumRuns.total) ? sumRuns.total : Object.keys(sumRuns).reduce(function (n, k) { return n + (isNum(sumRuns[k]) ? sumRuns[k] : 0); }, 0)
      : 0;
    const runsWords = sumRuns
      ? ["succeeded", "unverified", "failed", "interrupted", "cancelled", "missing", "running"]
          .filter(function (k) { return isNum(sumRuns[k]) && sumRuns[k] > 0; })
          .map(function (k) { return sumRuns[k] + " " + (k === "succeeded" ? "passed" : k); })
          .join(" · ") || "none yet"
      : "";

    return h(
      "div",
      { className: "roko-health" },
      h(
        "div",
        { className: "rk-scopebar", "data-roko": "insights-scope" },
        h("span", { className: "rk-scope-label" }, where.line),
        h("span", { className: "roko-flex" }),
        // The switch only where the backend knows scopes (an older one answers for the workspace, always).
        where.scoped || scope !== "hermes"
          ? h(Switch, {
              size: "s",
              label: "Whose numbers",
              value: scope,
              onChange: setScope,
              items: [{ id: "hermes", label: "from Hermes" }, { id: "workspace", label: "whole workspace" }],
            })
          : null
      ),
      h(
        "div",
        { className: "roko-kpis" },
        h(Kpi, {
          index: "01",
          label: "Tasks that passed",
          tone: rateTone(taskRate),
          value: pct(taskRate),
          sub: taskCount
            ? plural(taskCount, "task", "tasks") + " recorded" +
              (unverifiedTasks ? " · " + unverifiedTasks + " unverified (no check ran), not counted" : "") +
              (notVerified ? " · " + notVerified + " not verified (failed, or no check ran)" : "")
            : "no tasks recorded",
        }),
        h(Kpi, { index: "02", label: "Time per task", value: isNum(typical) ? duration(typical) : "—", sub: summary ? "typical" : "on average" }),
        h(Kpi, { index: "03", label: "Spend", value: money(spent), sub: isNum(perTask) && perTask ? money(perTask) + " per task" : where.label }),
        h(Kpi, { index: "04", label: "Checks passing", tone: rateTone(gateRate), value: pct(gateRate), sub: gateRuns ? gatePassed + " of " + plural(gateRuns, "check", "checks") + " that ran" : "no check has run yet" }),
        runsWords ? h(Kpi, { index: "05", label: "Runs", value: String(runsTotal), sub: runsWords }) : null
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
  // Setup and updates: what keeps roko from working here, each with its one fix
  // (`setup.problems` on /overview and /health), and the restart `hermes dashboard`
  // needs after an update (docs/updating.md)
  // ---------------------------------------------------------------------------

  const SEVERITY_RANK = { block: 0, warn: 1 };
  // Without the install state on the overview (an older backend), /health is asked this often instead.
  const HEALTH_POLL_MS = 60000;
  // The dashboard serves this script from disk on every load, but imported roko's backend when it started.
  const DASHBOARD_STEPS = ["Stop `hermes dashboard` (Ctrl-C where it runs) and start it again.", "Reload this page."];

  /** Untrusted value → plain text (objects never print). */
  function plain(v) {
    return typeof v === "string" ? v : isNum(v) ? String(v) : "";
  }

  /** Where a fix is explained: the backend names a page of the plugin's docs/ folder (or a full link). */
  function docsPath(value) {
    const docs = plain(value);
    return !docs ? null : docs.indexOf("docs/") === 0 || /^https?:/.test(docs) ? docs : "docs/" + docs;
  }

  /** A setup problem from the backend, checked, or null. Its restart steps are the dashboard's. */
  function readProblem(value) {
    const p = obj(value);
    if (!p || !plain(p.id) || !plain(p.title)) return null;
    const fix = obj(p.fix) || {};
    const parts = obj(p.parts);
    return {
      id: plain(p.id),
      severity: p.severity === "block" ? "block" : "warn",
      title: plain(p.title),
      detail: plain(p.detail),
      fix: {
        kind: plain(fix.kind) || "docs",
        label: plain(fix.label) || "fix",
        action: plain(fix.action) || null,
        command: plain(fix.command) || null,
        docs: docsPath(fix.docs),
      },
      steps: obj(p.steps) ? list(p.steps.dashboard).map(plain).filter(Boolean) : [],
      parts: parts ? { backend: parts.backend === true, desktop_copy: parts.desktop_copy === true } : null,
    };
  }

  /**
   * The problem the backend has not named yet when roko serve is down (its look lags up to 30 s, and an older
   * backend has none): no run can start until roko answers. `derived` marks it as the page's own; the header
   * keeps the connection's message and hint beside it.
   */
  function unreachableProblem(conn) {
    const url = plain(conn && conn.url);
    // The connection's hint names the start command with the real workspace: `roko serve --workdir '…'`. A hint
    // that only knows a placeholder (`--workdir WORKSPACE`: an older backend, or no workdir set) is no command to copy.
    const found = /`(roko serve\b[^`]*)`/.exec(plain(obj(conn && conn.error) ? conn.error.hint : ""));
    const said = found && !/\bWORKSPACE\b/.test(found[1]) ? found : null;
    const docs = docsPath("troubleshooting.md#roko-serve-is-not-reachable");
    return {
      id: "roko-unreachable",
      severity: "block",
      title: "Hermes cannot reach roko serve" + (url ? " at " + url : "") + ".",
      detail: "Nothing roko does works from Hermes until roko serve answers. Start it in your roko workspace.",
      fix: said
        ? { kind: "command", label: "start roko serve", action: null, command: said[1], docs: docs }
        : { kind: "docs", label: "how to start it", action: null, command: null, docs: docs },
      steps: [],
      parts: null,
      derived: true,
    };
  }

  /** Every problem the sources report, the ones that stop new runs first, each id once. Problems only the
   *  desktop app has (its copy of its page) are left out: this dashboard does not use that copy. */
  function problemsOf() {
    const seen = {};
    const out = [];
    for (let i = 0; i < arguments.length; i += 1) {
      const source = obj(arguments[i]);
      list(source ? source.problems : null).forEach(function (raw) {
        const problem = readProblem(raw);
        if (!problem || seen[problem.id]) return;
        if (problem.parts && !problem.parts.backend) return;
        seen[problem.id] = true;
        out.push(problem);
      });
    }
    return out.sort(function (a, b) { return SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]; });
  }

  /** -1, 0 or 1 for two dotted versions ("0.4.0" < "0.10.0"), or null when either is not one. */
  function compareVersions(a, b) {
    function parse(v) {
      const m = /^(\d+)\.(\d+)\.(\d+)/.exec(plain(v));
      return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
    }
    const x = parse(a);
    const y = parse(b);
    if (!x || !y) return null;
    for (let i = 0; i < 3; i += 1) {
      if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
    }
    return 0;
  }

  /**
   * Whether this tab and the dashboard's backend are two versions of roko, and what finishes the update.
   * `hermes dashboard` imports roko's backend once, when it starts, and serves this script fresh from disk,
   * so after `hermes plugins update roko` a reloaded tab is new and its backend old. The signs: the backend
   * says its files changed (`install.backend_stale`); its `plugin_version` differs from this script's; or
   * it answers without `setup` or `install` (it predates this script). Returns null or {key, title, steps}.
   */
  function restartOf(data, health) {
    data = obj(data);
    if (!data) return null;
    const reply = obj(health);
    const install = obj(data.install) || (reply ? obj(reply.install) : null);
    const backend = plain(data.plugin_version) || (install ? plain(install.loaded_version) : "");
    const disk = install ? plain(install.disk_version) : "";
    const problem = problemsOf(data.setup, reply ? reply.setup : null).filter(function (p) { return p.id === "restart-hermes"; })[0];
    const steps = problem && problem.steps.length ? problem.steps : DASHBOARD_STEPS;
    const order = compareVersions(backend, VERSION);
    if (install && install.backend_stale === true) {
      const title = disk && backend && disk !== backend
        ? "roko " + disk + " is installed, but this dashboard is still running " + backend + "."
        : "roko was updated on disk, but this dashboard is still running the code it started with.";
      return { key: "backend:" + backend + ":" + disk, title: title, steps: steps };
    }
    if (order === -1) {
      return { key: "older:" + backend, title: "roko " + VERSION + " is installed, but this dashboard is still running " + backend + ".", steps: steps };
    }
    if (order === 1) {
      return { key: "page:" + backend, title: "The dashboard runs roko " + backend + ", but this tab still shows " + VERSION + ".", steps: ["Reload this page."], pageOnly: true };
    }
    if (!obj(data.setup) && !install && !(reply && obj(reply.install))) {
      return { key: "predates:" + backend, title: "This dashboard is still running the roko backend it started with, from before this update.", steps: steps };
    }
    return null;
  }

  /** /health for an overview without the install state: one read a minute, shared by the page and the slots. */
  const healthStore = (function () {
    let state = { data: null, at: 0 };
    let inflight = null;
    let timer = null;
    const listeners = new Set();
    function load() {
      if (inflight) return inflight;
      inflight = apiGet("/health").then(function (res) {
        inflight = null;
        if (res.ok) state = { data: res.data, at: Date.now() };
        listeners.forEach(function (fn) {
          try { fn(state); } catch (_) { /* a broken listener must not stop the others */ }
        });
        return state;
      });
      return inflight;
    }
    function schedule() {
      clearTimeout(timer);
      timer = listeners.size > 0 ? setTimeout(function () { load().then(schedule); }, HEALTH_POLL_MS) : null;
    }
    return {
      get: function () { return state; },
      /** After a fix: read it again now, if anything reads it. */
      refresh: function () { return listeners.size > 0 ? load() : Promise.resolve(state); },
      subscribe: function (fn) {
        listeners.add(fn);
        if (listeners.size === 1) {
          if (Date.now() - state.at > HEALTH_POLL_MS / 2) load().then(schedule);
          else schedule();
        }
        return function () {
          listeners.delete(fn);
          if (listeners.size === 0) {
            clearTimeout(timer);
            timer = null;
          }
        };
      },
    };
  })();

  function useHealthReply(enabled) {
    const [snapshot, setSnapshot] = useState(healthStore.get());
    useEffect(function () {
      if (!enabled) return undefined;
      return healthStore.subscribe(setSnapshot);
    }, [enabled]);
    return enabled ? obj(snapshot.data) : null;
  }

  /** The setup problems and the restart this dashboard needs, from the overview (and /health when it must). */
  function useSetup() {
    const data = useOverview().data;
    const reply = useHealthReply(!!data && !obj(data.install));
    return useMemo(function () {
      // The overview asks roko every time; the backend's own look at setup lags up to 30 s (and an older backend has
      // none). So roko-unreachable follows the overview both ways: added at once when roko stops answering, gone at
      // once when it answers again (ui-notes U1).
      const reachable = !!(data && obj(data.connection) && data.connection.reachable === true);
      const problems = (data ? problemsOf(data.setup, reply ? reply.setup : null) : []).filter(function (p) { return !(reachable && p.id === "roko-unreachable"); });
      if (rokoDown(data) && !problems.some(function (p) { return p.id === "roko-unreachable"; })) {
        problems.unshift(unreachableProblem(data.connection));
      }
      return {
        problems: problems,
        blocking: problems.filter(function (p) { return p.severity === "block"; })[0] || null,
        restart: restartOf(data, reply),
      };
    }, [data, reply]);
  }

  /** A line of a fix's preview: a diff's added and removed lines get their channel colours. */
  function previewKind(line) {
    if (line.indexOf("+++") === 0 || line.indexOf("---") === 0) return "file";
    if (line.indexOf("@@") === 0) return "hunk";
    return line.charAt(0) === "+" ? "add" : line.charAt(0) === "-" ? "del" : undefined;
  }

  /** What a fix would change, on the glass. Untrusted text: text nodes only. */
  function PreviewText(props) {
    return h(
      "pre",
      { className: "rk-well rk-fixpreview", "data-roko": "fix-preview" },
      plain(props.value).split("\n").map(function (line, i) {
        return h("span", { key: i, "data-line": previewKind(line) }, line + "\n");
      })
    );
  }

  /** A fix the backend could not even look at: an older backend has no fix route at all. */
  function FixFailed(props) {
    const e = props.error || {};
    if (e.kind === "backend" && e.status === 404) {
      return h(
        "div",
        { className: "rk-fixnote", role: "alert" },
        "This dashboard still runs the roko backend from before your update, which cannot do this. " + DASHBOARD_STEPS.join(" ") + " Then try again."
      );
    }
    return h(ErrorNote, { error: e, compact: true });
  }

  /** The fix's ways to do it (`variants`): each with its label, whether it is recommended, and why it is off. */
  function fixVariants(reply) {
    return list(reply && reply.variants)
      .filter(function (v) { return obj(v) && plain(v.id); })
      .map(function (v) {
        return { id: plain(v.id), label: plain(v.label) || plain(v.id), recommended: v.recommended === true, available: v.available !== false, why: plain(v.why) };
      });
  }

  /**
   * An `action` fix: its key asks the backend what the fix would change (GET /setup/fix) and shows that on
   * the glass, with its way of doing it when there is a choice; a second key applies exactly that preview
   * (POST /setup/fix with its `variant` and `digest`), and the row then says what was done and what is next.
   */
  /** How long the outcome of an applied fix stays once its problem has gone from the list. */
  const FIX_DONE_MS = 15 * 60000;

  /**
   * The last fix the person applied: `{id, reply, at}`. Applying it usually clears its problem, and the row with
   * it, at the next look; the outcome (what changed, what is left, such as committing roko.toml) stays here.
   */
  const fixDoneStore = (function () {
    let value = null;
    const listeners = new Set();
    return {
      get: function () { return value; },
      set: function (next) {
        value = next;
        listeners.forEach(function (fn) {
          try { fn(value); } catch (_) { /* a broken listener must not stop the others */ }
        });
      },
      subscribe: function (fn) {
        listeners.add(fn);
        return function () { listeners.delete(fn); };
      },
    };
  })();

  function useFixDone() {
    const [value, setValue] = useState(fixDoneStore.get());
    useEffect(function () { return fixDoneStore.subscribe(setValue); }, []);
    return value;
  }

  /**
   * What an applied fix did and what is left to do (POST /setup/fix's reply). Green when roko now accepts runs from
   * Hermes; orange when the change took but roko still refuses them (`ready: false`): the next step says why.
   */
  function FixOutcome(props) {
    const reply = obj(props.reply) || {};
    const next = plain(reply.next);
    const said = plain(reply.message) || (typeof reply.done === "string" ? reply.done : "") || "Done.";
    const ready = reply.ready !== false;
    return h(
      "div",
      { className: props.onClose ? "rk-fixdone rk-fixdone-note" : "rk-fixdone", role: "status", "data-roko": props.name, "data-ready": ready ? "true" : "false" },
      h(LED, { ch: ready ? "pass" : "you", blink: false, label: ready ? "done" : "done, but not ready yet" }),
      h("span", { className: "rk-fixdone-text" }, h("span", null, said), next && said.indexOf(next) < 0 ? h("span", { className: "rk-fixnext" }, h("b", null, "next"), " " + next) : null),
      props.onClose ? h(Key, { size: "s", icon: "x", ariaLabel: "Dismiss", name: props.name + "-close", onClick: props.onClose }) : null
    );
  }

  /** The outcome of the fix just applied, once its problem has left `problems` (else its row says it). */
  function FixDoneNote(props) {
    const done = useFixDone();
    const problems = list(props.problems);
    if (!done || Date.now() - done.at > FIX_DONE_MS || problems.some(function (p) { return p.id === done.id; })) return null;
    return h(FixOutcome, { reply: done.reply, name: "fix-done-note", onClose: function () { fixDoneStore.set(null); } });
  }

  function FixAction(props) {
    const problem = props.problem;
    const action = problem.fix.action;
    const [state, setState] = useState({ step: "idle" });

    function preview(variant) {
      setState(function (s) { return Object.assign({}, s, { error: null, step: s.reply ? "switching" : "loading" }); });
      apiGet("/setup/fix?action=" + enc(action) + (variant ? "&variant=" + enc(variant) : "")).then(function (res) {
        if (res.ok) {
          setState({ step: "preview", reply: res.data });
          return;
        }
        setState(function (s) { return s.reply ? Object.assign({}, s, { step: "preview", error: res.error }) : { step: "failed", error: res.error }; });
      });
    }
    function apply() {
      const shown = obj(state.reply) || {};
      const body = { action: action };
      if (plain(shown.variant)) body.variant = plain(shown.variant);
      if (plain(shown.digest)) body.digest = plain(shown.digest);
      setState(function (s) { return Object.assign({}, s, { step: "applying", error: null }); });
      apiPost("/setup/fix", body).then(function (res) {
        if (res.ok) {
          setState({ step: "done", reply: res.data });
          fixDoneStore.set({ at: Date.now(), id: problem.id, reply: obj(res.data) || {} });
          sound.play("check", { user: true });
          overviewStore.refresh();
          healthStore.refresh();
          if (props.onDone) props.onDone(res.data);
          return;
        }
        setState(function (s) { return Object.assign({}, s, { step: "preview", error: res.error }); });
      });
    }

    if (state.step === "done") return h(FixOutcome, { reply: state.reply, name: "fix-done-" + problem.id });
    if (state.step === "preview" || state.step === "applying" || state.step === "switching") {
      const reply = obj(state.reply) || {};
      const busy = state.step !== "preview";
      const variants = fixVariants(reply);
      const chosen = plain(reply.variant);
      return h(
        "div",
        { className: "rk-fixpanel", "data-roko": "fix-panel-" + problem.id },
        plain(reply.title) ? h("div", { className: "rk-fixtitle" }, plain(reply.title)) : null,
        variants.length > 1
          ? h(
              "div",
              { className: "rk-keyrow rk-fixvariants", role: "group", "aria-label": "How to fix it" },
              variants.map(function (v) {
                return h(Key, {
                  key: v.id,
                  size: "s",
                  name: "fix-variant-" + v.id,
                  pressed: v.id === chosen,
                  disabled: busy || !v.available,
                  title: v.available ? v.why || undefined : v.why || "not available here",
                  label: v.recommended ? v.label + " · recommended" : v.label,
                  onClick: function () { if (v.id !== chosen) preview(v.id); },
                });
              })
            )
          : null,
        plain(reply.summary) ? h("div", { className: "rk-fixsummary roko-dim" }, plain(reply.summary)) : null,
        plain(reply.path) ? h("div", { className: "rk-fixpath roko-dim" }, "changes ", h("span", { className: "roko-mono" }, plain(reply.path))) : null,
        plain(reply.preview) ? h(PreviewText, { value: reply.preview }) : h("div", { className: "roko-dim" }, "Nothing in the file changes."),
        plain(reply.note) ? h("div", { className: "rk-fixpath roko-dim" }, plain(reply.note)) : null,
        state.error ? h(FixFailed, { error: state.error }) : null,
        h(
          "div",
          { className: "roko-row rk-fixkeys" },
          h(Key, { tone: "you", size: "s", icon: "check", label: "apply", name: "fix-apply-" + problem.id, busy: state.step === "applying", disabled: busy, onClick: apply }),
          state.error && state.error.code === "conflict"
            ? h(Key, { size: "s", label: "look again", name: "fix-again-" + problem.id, disabled: busy, onClick: function () { preview(chosen || null); } })
            : null,
          h(Key, { size: "s", label: "cancel", disabled: busy, onClick: function () { setState({ step: "idle" }); } })
        )
      );
    }
    return h(
      Fragment,
      null,
      h(Key, {
        tone: problem.severity === "block" ? "you" : undefined,
        size: "s",
        icon: "bolt",
        label: state.step === "loading" ? "looking…" : problem.fix.label,
        name: "fix-" + problem.id,
        busy: state.step === "loading",
        disabled: state.step === "loading",
        onClick: function () { preview(null); },
      }),
      state.step === "failed" ? h(FixFailed, { error: state.error }) : null
    );
  }

  /** A key that copies a command; the command itself is shown beside it. */
  function CopyKey(props) {
    const [state, setState] = useState("idle");
    useEffect(function () {
      if (state === "idle") return undefined;
      const timer = setTimeout(function () { setState("idle"); }, 1600);
      return function () { clearTimeout(timer); };
    }, [state]);
    return h(Key, {
      size: "s",
      icon: state === "copied" ? "check" : "copy",
      label: state === "copied" ? "copied" : state === "failed" ? "copy failed" : props.label,
      ariaLabel: props.label + ": " + props.value,
      name: props.name,
      onClick: function () { copyText(props.value).then(function (ok) { setState(ok ? "copied" : "failed"); }); },
    });
  }

  /** A problem's one fix: preview then apply, a command to copy, the restart steps, or where the docs say how. */
  function FixControl(props) {
    const problem = props.problem;
    const fix = problem.fix;
    if (fix.kind === "action" && fix.action) return h(FixAction, { problem: problem, onDone: props.onDone });
    // A command to copy: the `command` kind, or any newer kind that comes with one (a setting to change, say).
    if (fix.command && fix.kind !== "restart-hermes") {
      return h(
        "div",
        { className: "rk-fixcmd" },
        h("code", { className: "roko-cmd-text" }, fix.command),
        h(CopyKey, { label: fix.label, value: fix.command, name: "fix-copy-" + problem.id })
      );
    }
    if (fix.kind === "restart-hermes") {
      return h("ol", { className: "rk-fix-steps" }, (problem.steps.length ? problem.steps : DASHBOARD_STEPS).map(function (step, i) { return h("li", { key: i }, step); }));
    }
    if (fix.kind === "hint" && fix.hint) {
      // An older backend's own words for what to do (the page has no command of its own to offer).
      return h("span", { className: "roko-dim rk-small", "data-roko": "fix-hint" }, fix.hint, fix.docs ? h("span", null, " · how: ", h("span", { className: "roko-mono" }, fix.docs)) : null);
    }
    return fix.docs ? h("span", { className: "roko-dim rk-small" }, "how: ", h("span", { className: "roko-mono" }, fix.docs)) : null;
  }

  /** One problem: its light (red when it stops new runs), what is wrong, why it matters, and its fix. */
  function ProblemRow(props) {
    const problem = props.problem;
    const block = problem.severity === "block";
    return h(
      "li",
      { className: "rk-problem", "data-severity": problem.severity, "data-roko": "problem-" + problem.id },
      isNum(props.index) ? h("span", { className: "rk-problem-n", "aria-hidden": "true" }, String(props.index + 1).padStart(2, "0")) : null,
      h(LED, { ch: block ? "fail" : "you", blink: false, label: block ? "stops new runs" : "worth fixing" }),
      h(
        "div",
        { className: "rk-problem-main" },
        h("div", { className: "rk-problem-title" }, problem.title),
        problem.detail && !props.compact ? h("div", { className: "rk-problem-detail" }, problem.detail) : null,
        h("div", { className: "rk-problem-fix" }, h(FixControl, { problem: problem }))
      )
    );
  }

  /** One problem on its own, where it stops something: the composer, the plan's run form, a refused start. */
  function ProblemCard(props) {
    return h(
      "div",
      { className: "rk-problemcard", "data-severity": props.problem.severity, "data-roko": "problem-card-" + props.problem.id, role: "alert" },
      props.lead ? h("div", { className: "rk-problemcard-lead roko-dim" }, props.lead) : null,
      h("ul", { className: "rk-problems" }, h(ProblemRow, { problem: props.problem, compact: props.compact }))
    );
  }

  /** `00 SETUP`: everything that keeps roko from working here, numbered, each with its one fix. */
  function SetupModule(props) {
    const problems = props.problems;
    if (!problems.length) return null;
    const blocking = problems.filter(function (p) { return p.severity === "block"; }).length;
    return h(
      Module,
      {
        index: "00",
        label: "SETUP",
        name: "setup",
        className: "rk-setup" + (blocking ? " is-blocking" : ""),
        right: blocking ? blocking + " blocking new runs" : problems.length + " to look at",
      },
      h("ol", { className: "rk-problems" }, problems.map(function (problem, i) { return h(ProblemRow, { key: problem.id, problem: problem, index: i }); }))
    );
  }

  /** Calm but unmistakable: this dashboard runs an older roko than the one installed, and what finishes it. */
  function RestartBanner(props) {
    const restart = props.restart;
    return h(
      "div",
      { className: "rk-restart" + (props.compact ? " is-compact" : ""), role: "alert", "data-roko": "restart" },
      h(Well, { className: "rk-restart-well" }, h(LED, { ch: "you", blink: "fast" }), h(Dots, { value: "RESTART", size: props.compact ? "S" : "M", ch: "you", label: "restart" })),
      h(
        "div",
        { className: "rk-restart-body" },
        h("div", { className: "rk-restart-title" }, restart.title),
        h("ol", { className: "rk-fix-steps" }, restart.steps.map(function (step, i) { return h("li", { key: i }, step); })),
        props.compact ? null : h("div", { className: "roko-dim rk-small" }, "Hermes loads roko when it starts, so an update waits for a restart (docs/updating.md).")
      ),
      // Only this tab is old: the dashboard serves the installed script, so a reload is the whole fix.
      restart.pageOnly ? h(Key, { tone: "you", size: "s", icon: "refresh", label: "reload page", name: "reload-page", onClick: function () { window.location.reload(); } }) : null
    );
  }

  /** The top of the roko tab: the restart banner, then the setup module (its restart line is the banner). */
  function SetupArea() {
    const setup = useSetup();
    const done = useFixDone();
    const problems = setup.restart ? setup.problems.filter(function (p) { return p.id !== "restart-hermes"; }) : setup.problems;
    if (!setup.restart && !problems.length && !done) return null;
    return h(
      "div",
      { className: "rk-setuparea" },
      setup.restart ? h(RestartBanner, { restart: setup.restart }) : null,
      h(FixDoneNote, { problems: setup.problems }),
      h(SetupModule, { problems: problems })
    );
  }

  /** A slot's line for it: the restart, or the first problem, with a link to the roko tab's setup module. */
  function SetupStrip(props) {
    const setup = useSetup();
    const light = useLightTheme();
    const first = setup.problems.filter(function (p) { return p.id !== "restart-hermes"; })[0];
    const blockingOnly = !!props.blockingOnly;
    if (!setup.restart && (!first || (blockingOnly && first.severity !== "block"))) return null;
    const ch = setup.restart ? "you" : first.severity === "block" ? "fail" : "you";
    const title = setup.restart ? setup.restart.title : first.title;
    const more = setup.restart ? 0 : setup.problems.length - 1;
    return h(
      "div",
      { className: "roko-banner rk-livestrip rk-setupstrip roko-tone-scope" + (light ? " roko--light" : ""), role: "status", "data-roko": props.name || "setup-strip", "data-ch": ch },
      h(LED, { ch: ch, blink: setup.restart ? "fast" : false }),
      h("span", { className: "rk-chatstrip-name" }, "roko"),
      h("span", { className: "roko-banner-text", title: title }, title),
      more > 0 ? h("span", { className: "roko-dim roko-mono" }, "+" + more) : null,
      h("a", linkProps("/roko", { className: "roko-banner-link" }), setup.restart ? "how to restart →" : first.fix.label + " →")
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
    const setup = useSetup();
    let connection;
    let downDetail = null;
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
      // The setup module says how to start roko serve, with this workspace's path: then the hint here is dropped.
      const fixShown = setup.problems.some(function (p) { return p.id === "roko-unreachable" && p.fix && p.fix.kind !== "docs"; });
      connection = h(
        "div",
        { className: "roko-conn roko-conn--down" },
        h(LED, { ch: "fail", blink: false, label: "roko is down" }),
        h("span", { className: "roko-conn-main" }, "roko serve unreachable"),
        h("span", { className: "roko-mono roko-dim roko-conn-url" }, str(conn.url))
      );
      // The connection's own words, on a line of their own across the header.
      if (e.message || (e.hint && !fixShown)) {
        downDetail = h(
          "div",
          { className: "roko-conn-detail", "data-roko": "conn-detail" },
          e.message ? h("span", { className: "roko-conn-msg" }, str(e.message)) : null,
          e.hint && !fixShown ? h("span", { className: "roko-conn-hint roko-dim" }, str(e.hint)) : null
        );
      }
    }
    const live = liveIndicator(liveState, rokoDown(data));

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
        h("span", { className: "rk-live", "data-roko": "live-state", "data-state": live.word, title: live.title }, h(LED, { ch: live.ch, blink: live.blink }), live.word),
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
      ),
      downDetail
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
    /** Open the composer: with a request to start from, or (`opts.plan`) on a plan to run, resumed or not. */
    function compose(prompt, opts) {
      const o = opts || {};
      setComposer({ open: true, prompt: prompt || "", planMode: !!o.plan, plan: typeof o.plan === "string" && o.plan ? o.plan : null, resume: !!o.resume, cap: isNum(o.cap) ? o.cap : null });
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

    // roko down: its running count is a last known one, not a badge.
    const badges = { runs: rokoDown(data) ? 0 : c.running + c.queued, waiting: c.waiting };
    return h(
      "div",
      { className: "roko" + (light ? " roko--light" : ""), "data-roko": "page" },
      h(StatusHeader, { overview: ov, onCompose: compose, onHelp: function () { setHelp(true); } }),
      blocked ? null : h(SetupArea, null),
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
        planMode: !!composer.planMode,
        plan: composer.plan || null,
        resume: !!composer.resume,
        cap: composer.cap,
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
    const setup = useSetup();
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
    // roko down: the counts are its last known ones, so the chip says offline instead.
    const labels = rokoDown(data) ? { parts: [], full: "offline", primary: "offline", digit: "" } : chipLabels(c);

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
    // A restart or a problem that stops new runs comes first: it says what to do, not how roko is doing.
    // (roko down says itself: a red light and "offline".)
    const setupAlert = setup.blocking && setup.blocking.id !== "roko-unreachable";
    const alert = setup.restart ? "restart" : setupAlert ? "setup" : "";
    const alertLine = setup.restart ? setup.restart.title : setupAlert ? "setup: " + setup.blocking.title : "";
    const path = alert ? "/roko" : "/roko" + (c.waiting ? "?section=waiting" : "");
    // Levels: 0 "roko ● ▪▪▪ 1 running · 2 waiting", 1 "roko ● 2 waiting", 2 "roko ●"
    // (state by colour), 3 "● 2" (a collapsed sidebar has room for nothing more).
    const detail = level === 0 ? labels.full : level === 1 ? labels.primary : level === 3 ? labels.digit : "";
    return h(
      "a",
      linkProps(path, {
        ref: ref,
        className: "roko-chip roko-tone-scope" + (light ? " roko--light" : "") + (level >= 2 ? " roko-chip--compact" : ""),
        title: alertLine ? alertLine + " · " + title : title,
        "aria-label": alertLine ? alertLine + " · " + title : title,
        "data-roko": "chip",
        "data-roko-level": String(level),
      }),
      level < 3 ? h("span", { className: "roko-chip-name" }, "roko") : null,
      h(LED, { ch: ch, blink: down || !(active || c.waiting) ? false : undefined }),
      alert && level < 3 ? h("span", { className: "roko-chip-alert", "data-ch": setup.restart ? "you" : "fail", "data-roko": "chip-" + alert }, alert) : null,
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
    const strip = h(SetupStrip, { name: "sessions-setup" });
    // roko down: its counts are stale; the setup strip says roko is down and what starts it.
    if (!(c.running || c.queued || c.waiting) || rokoDown(data)) return strip;
    const parts = [];
    if (c.running) parts.push(plural(c.running, "run", "runs") + " running");
    if (c.queued) parts.push(plural(c.queued, "run", "runs") + " queued");
    if (c.waiting) parts.push(c.waiting === 1 ? "1 item waits on you" : c.waiting + " items wait on you");
    const path = "/roko" + (c.waiting ? "?section=waiting" : "");
    const progress = liveProgress(data);
    return h(
      Fragment,
      null,
      strip,
      h(
        "div",
        { className: "roko-banner rk-livestrip roko-tone-scope" + (light ? " roko--light" : ""), role: "status", "data-roko": "banner" },
        h(LED, { ch: c.waiting ? "you" : "agent" }),
        h("span", { className: "roko-banner-text" }, "roko: " + parts.join(" · ")),
        progress ? h(StepStrip, { progress: progress, waiting: liveWaits(data) }) : null,
        progress ? h("span", { className: "roko-banner-sub roko-dim" }, (progress.passed || 0) + "/" + progress.total + " tasks") : null,
        newest.step ? h(LiveStep, { key: newest.stepKey, newest: newest }) : null,
        h("a", linkProps(path, { className: "roko-banner-link" }), "open →")
      )
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
    // Asking for roko work in this chat would be refused: say so above it.
    const strip = h(SetupStrip, { name: "chat-setup", blockingOnly: true });
    if ((!run && !c.waiting) || rokoDown(data)) return strip;
    const path = c.waiting && !run ? "/roko?section=waiting" : "/roko?run=" + enc(run.run_id);
    const progress = run ? obj(run.progress) : null;
    return h(
      Fragment,
      null,
      strip,
      h(
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
      )
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
    const gates = insights ? list(insights.gates).filter(function (g) { return obj(g) && str(g.kind) !== "verdict"; }) : [];
    // A newer backend sums the checks for its scope (runs from Hermes by default); an older one, the workspace's.
    const sum = insights && obj(insights.summary) ? obj(insights.summary.checks) : null;
    const ran = sum && isNum(sum.ran) ? sum.ran : gates.reduce(function (n, g) { return n + (isNum(g.total) ? g.total : 0); }, 0);
    const passed = sum && isNum(sum.passed) ? sum.passed : gates.reduce(function (n, g) { return n + (isNum(g.passed) ? g.passed : 0); }, 0);
    const rate = sum && isNum(sum.pass_rate) ? sum.pass_rate : ran ? passed / ran : null;
    const where = insights ? insightScope(insights) : null;
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
        h("span", { className: "rk-tiny" }, "checked work · " + plural(isNum(spend.runs_today) ? spend.runs_today : 0, "run", "runs") + " today · " + (rokoDown(data) ? "roko offline" : counts(data).running + " running")),
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
          { index: "04", label: "CHECKS", sub: (ran ? passed + " of " + ran + " check runs passed" : "no checks recorded") + (where ? " · " + where.label : "") },
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

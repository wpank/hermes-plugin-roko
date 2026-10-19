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
  const VERSION = "0.6.0";
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
  // 0.7: while a project's roko serve starts, the page looks every 2 s, for 90 s at most (BRIEF §C).
  const SERVE_POLL_MS = 2000;
  const SERVE_WAIT_MS = 90000;
  // The project this tab shows, kept in this browser.
  const PROJECT_KEY = "roko.project";
  // The routes that answer per project (`?project=`); the default project's keep 0.6's URLs.
  const PROJECT_ROUTES = /^\/(plans|loops|insights|learning|knowledge|estimate|pending|health)(\/|\?|$)/;

  const SECTIONS = [
    { id: "runs", label: "Runs" },
    { id: "waiting", label: "Waiting" },
    { id: "plans", label: "Plans" },
    { id: "learning", label: "Learning" },
    { id: "loops", label: "Loops" },
    { id: "health", label: "Insights" },
    { id: "knowledge", label: "Knowledge" },
  ];
  const SECTION_ALIASES = { insights: "health", models: "health", lessons: "knowledge" };
  /**
   * The tabs: three destinations, one per part of the pitch (runs: do; plans: specify; learning: improve); Learning
   * holds the loops, the lessons and the models as its sub-views, and Waiting is the ◆ badge (spec v3 §5.1).
   */
  const TABS = SECTIONS.filter(function (s) { return s.id === "runs" || s.id === "plans" || s.id === "learning"; });
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
  /** The values without repeats, in their first order. */
  function distinct(values) { return values.filter(function (v, i) { return values.indexOf(v) === i; }); }
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

  /** An agent's words as plain text: its inline markdown markers (**, `) go (the desktop's mdPlain). */
  function mdPlain(v) { return str(v).replace(/\*\*|`/g, ""); }

  /**
   * An agent's words with their inline markdown shown (`code`, **strong**, a link's words), never as HTML; a marker
   * a clip cut in half goes. The desktop's mdWords.
   */
  function mdWords(words, keyBase) {
    return mdInline(str(words), keyBase || "w").map(function (part) { return typeof part === "string" ? part.replace(/\*\*|`/g, "") : part; });
  }

  /** Words in quotation marks, the marks joined to the words' first and last text so a line stays one run of text. */
  function quotedWords(parts) {
    const out = parts.slice();
    if (typeof out[0] === "string") out[0] = "“" + out[0];
    else out.unshift("“");
    if (typeof out[out.length - 1] === "string") out[out.length - 1] = out[out.length - 1] + "”";
    else out.push("”");
    return out;
  }

  /** The newest try a task names: its card's attempts, or its latest try on the ladder. */
  function newestTry(task) {
    const tries = list(task && task.climb).filter(obj);
    const last = tries.length && isNum(tries[tries.length - 1].attempt) ? tries[tries.length - 1].attempt : 0;
    return Math.max(task && isNum(task.attempts) ? task.attempts : 0, last);
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

  /** A run's state as the system declares it, ⌈PASSED⌋ (spec v3 §4.7), in the desktop's words. */
  function stampWord(run) {
    const stop = capStop(run);
    if (stop) return str(stop.limit) === "day" ? "stopped at limit" : "stopped at cap";
    if (str(run && run.state) === "succeeded" && run.kind !== "plan_generate") return "passed";
    return stateWord(run);
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
  // The five channels (spec v3 §2.2) and roko's five loops: live (rose, an agent is working), pass (sage),
  // fail (red), you (orange, the person is needed) and learn (indigo, roko changed itself)
  // ---------------------------------------------------------------------------

  /** A task's or run's state as a channel: live (working), pass, you (needs the person), fail, off. */
  function channelOf(state) {
    switch (state) {
      case "running":
      case "queued":
        return "live";
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
    route: "live",
    failover: "fail",
    retry: "you",
    regression: "fail",
    wave: "live",
    diagnosis: "you",
    budget: "you",
    hold: "you",
    thresholds: "learn",
    knowledge: "learn",
    loop_health: "learn",
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
    if (ev && ev.kind === "diagnosis") return data.severity === "alert" ? "fail" : data.severity === "info" ? "live" : "you";
    if (ev && ev.kind === "hold" && data.state === "resolved") return data.outcome === "approved" ? "pass" : "fail";
    if (ev && ev.kind === "tool_decided") return data.outcome === "applied" ? "pass" : "fail";
    return LOOP_CHANNEL[ev && ev.kind] || "live";
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
            // 0.7: POST /serve refused (a busy restart or stop): the serve as it is now, with what it would stop.
            serve: obj(body.serve) || null,
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
  // 0.7: the project this tab shows, and its roko serve (BRIEF §C)
  // ---------------------------------------------------------------------------

  /**
   * The project the page shows (its overview, plans, loops, insights, learning and lessons): a path the person picked,
   * kept in this browser, or null for the backend's default, whose URLs are 0.6's. Every storage read and write is
   * guarded: a private window has none.
   */
  const projectStore = (function () {
    let value = null;
    try {
      const kept = window.localStorage.getItem(PROJECT_KEY);
      value = typeof kept === "string" && kept && kept.length < 4096 ? kept : null;
    } catch (_) {
      value = null;
    }
    const listeners = new Set();
    return {
      get: function () { return value; },
      set: function (next) {
        const path = typeof next === "string" && next ? next : null;
        if (path === value) return;
        value = path;
        try {
          if (path) window.localStorage.setItem(PROJECT_KEY, path);
          else window.localStorage.removeItem(PROJECT_KEY);
        } catch (_) { /* kept for this page only */ }
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

  function useProject() {
    const [value, setValue] = useState(projectStore.get());
    useEffect(function () {
      setValue(projectStore.get());
      return projectStore.subscribe(setValue);
    }, []);
    return value;
  }

  /** `path` for the project shown here: `?project=…` (or `&…`) for a picked one, nothing for the default. */
  function forProject(path, project) {
    const p = project === undefined ? projectStore.get() : project;
    return p ? path + (path.indexOf("?") >= 0 ? "&" : "?") + "project=" + enc(p) : path;
  }

  /** `{project}` for a start's body when the person picked one; the default project needs none. */
  function projectBody() {
    return projectStore.get() ? { project: projectStore.get() } : {};
  }

  /** Each state of a project's roko serve: its word, its channel, and the word on the glass (the desktop's). */
  const SERVE_LOOK = {
    failed: { dots: "FAILED", ch: "fail", word: "failed to start" },
    not_found: { dots: "NO ROKO", ch: "you", word: "not found" },
    outdated: { dots: "UPDATE", ch: "you", word: "outdated" },
    remote: { dots: "REMOTE", ch: "off", word: "remote" },
    running: { dots: "ON", ch: "pass", word: "running" },
    starting: { dots: "STARTING", ch: "live", word: "starting" },
    stopped: { dots: "STOPPED", ch: "off", word: "stopped" },
  };
  // The states the page shows as the serve banner: everything but running and remote (which it never starts).
  const SERVE_BANNER = ["starting", "stopped", "failed", "outdated", "not_found"];
  // The backend's rows about a serve that does not run; the banner says them instead (BRIEF B7).
  const SERVE_ROWS = ["roko-unreachable", "roko-not-found", "roko-too-old"];

  /** A ServeState from the backend, checked; null from an older backend (no `connection.serve`). */
  function readServe(value) {
    const s = obj(value);
    if (!s || !SERVE_LOOK[plain(s.state)]) return null;
    const err = obj(s.error);
    return {
      actions: list(s.actions).map(plain).filter(function (a) { return a === "start" || a === "restart" || a === "stop"; }),
      busy: obj(s.busy) && isNum(s.busy.active_runs) ? s.busy.active_runs : 0,
      error: err ? { code: plain(err.code), message: plain(err.message), hint: plain(err.hint) } : null,
      idle: isNum(s.idle_exit_minutes) ? s.idle_exit_minutes : null,
      // The last lines of the project's serve.log: untrusted, text nodes only.
      log: list(s.log_tail).map(function (line) { return plain(line).slice(0, 400); }).slice(-40),
      name: plain(s.name),
      project: plain(s.project),
      since: plain(s.since),
      state: plain(s.state),
    };
  }
  function serveOf(data) { return readServe(data && obj(data.connection) ? data.connection.serve : null); }

  /** A Project from the backend, checked, or null. */
  function readProject(value) {
    const p = obj(value);
    const path = p ? plain(p.path) : "";
    if (!path) return null;
    return { path: path, name: plain(p.name) || path.split(/[\\/]/).filter(Boolean).pop() || path, isDefault: p.default === true, needsSetup: p.needs_setup === true, serve: readServe(p.serve) };
  }

  /**
   * The overview's projects (default first, then the most recently used) and the one it is about; none from 0.6.
   * `none`: a 0.7 backend that knows no project yet (`projects: []`, `project: null`): the page asks for one.
   */
  function projectsOf(data) {
    const all = list(data && data.projects).map(readProject).filter(Boolean);
    const current = readProject(data && data.project) || all.filter(function (p) { return p.isDefault; })[0] || null;
    return { all: all.length || !current ? all : [current], current: current, none: !!data && Array.isArray(data.projects) && !all.length && !current };
  }

  /** Show a project here; the default one keeps 0.6's routes. */
  function pickProject(p) { projectStore.set(p.isDefault ? null : p.path); }

  /** A serve's state in a sentence (the desktop's words). */
  function serveTitle(serve) {
    const name = serve.name || "this project";
    return {
      failed: "roko serve did not start for " + name + ".",
      not_found: "Hermes cannot find roko on this machine.",
      outdated: "The roko for " + name + " is too old for Hermes.",
      remote: "roko serve for " + name + " runs on another machine.",
      running: "roko serve runs for " + name + ".",
      starting: "roko serve is starting for " + name + "…",
      stopped: "roko serve is not running for " + name + ".",
    }[serve.state];
  }

  /** The runs a restart or stop of this serve would stop: the overview's live rows in its project. */
  function busyRuns(serve, data) {
    return list(data && data.runs).filter(function (r) {
      return obj(r) && isRunActive(r) && (!obj(r.project) || !serve.project || plain(r.project.path) === serve.project);
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
    // The project the request in flight asks about (0.7): a pick since then asks again.
    let inflightFor = null;
    // Since when the shown project's serve has been starting (0.7): the page looks every 2 s for 90 s.
    let startingSince = null;
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
      const project = projectStore.get();
      if (inflight && inflightFor === project) return inflight;
      if (state.status === "idle") {
        state = Object.assign({}, state, { status: "loading" });
        emit();
      }
      inflightFor = project;
      const mine = apiGet(forProject("/overview", project)).then(function (res) {
        if (inflight === mine) inflight = null;
        // Another project was picked meanwhile: its own answer is on the way.
        if (projectStore.get() !== project) return state;
        // A picked project the backend does not know, or a backend with no projects at all: back to the default.
        if (project && ((res.ok && !list(res.data.projects).some(function (p) { return obj(p) && p.path === project; })) || (!res.ok && (res.error.code === "not_found" || res.error.code === "invalid")))) {
          projectStore.set(null);
          return state;
        }
        state = res.ok
          ? { status: "ok", data: res.data, error: null, at: Date.now() }
          : { status: "error", data: state.data, error: res.error, at: Date.now() };
        emit();
        return state;
      });
      inflight = mine;
      return mine;
    }
    function delay() {
      const serve = serveOf(state.data);
      startingSince = serve && serve.state === "starting" ? startingSince || Date.now() : null;
      if (startingSince !== null && Date.now() - startingSince < SERVE_WAIT_MS) return SERVE_POLL_MS;
      return liveStore.healthy() ? LIVE_FALLBACK_MS : OVERVIEW_POLL_MS;
    }
    function schedule() {
      clearTimeout(timer);
      timer = null;
      if (listeners.size > 0) timer = setTimeout(tick, delay());
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
      /**
       * An overview the live socket pushed: the same answer as `GET /overview`, kept when it is about the project this
       * tab shows (0.7 `project`; a 0.6 overview names none).
       */
      set: function (data) {
        if (!obj(data) || data.ok !== true) return;
        const about = obj(data.project);
        const shown = projectStore.get();
        if (about && (shown ? about.path !== shown : about.default !== true)) return;
        state = { status: "ok", data: data, error: null, at: Date.now() };
        emit();
        schedule();
      },
      /**
       * A serve's new state (POST /serve's reply, or the socket's `serve` frame): the overview says it at once when it
       * is about that project, and so does its list of projects; then the overview is asked again.
       */
      patchServe: function (value) {
        const serve = readServe(value);
        if (!serve || !state.data) return;
        const data = state.data;
        const here = serve.project ? obj(data.project) && data.project.path === serve.project : obj(data.project) && data.project.default === true;
        const projects = Array.isArray(data.projects)
          ? data.projects.map(function (p) { return obj(p) && p.path === serve.project ? Object.assign({}, p, { serve: value }) : p; })
          : data.projects;
        const next = Object.assign({}, data, { projects: projects });
        if (here && obj(data.connection)) next.connection = Object.assign({}, data.connection, { serve: value });
        state = Object.assign({}, state, { data: next });
        emit();
        load().then(schedule);
      },
      /** POST /projects's reply: the overview lists the projects as it says them now. */
      setProjects: function (projects) {
        if (!Array.isArray(projects) || !state.data) return;
        state = Object.assign({}, state, { data: Object.assign({}, state.data, { projects: projects }) });
        emit();
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

  // Another project picked: the overview asks about it now (the last one's answer shows until it comes), and so does
  // the live socket, whose overview frames are about one project. (liveStore and healthStore come later; this runs
  // only once the person picks.)
  projectStore.subscribe(function () {
    overviewStore.refresh();
    liveStore.redial();
    healthStore.refresh();
  });

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
      spend: spend,
    };
  }
  /**
   * Today's spend in the same words everywhere (0.6.0 P-3): what the runs started from this Hermes spent, then what roko
   * recorded today across its workspace (terminal runs and helper calls too) when the backend can read it: "$0.20 from
   * Hermes · $0.56 in roko today", else "$0.20 from Hermes".
   */
  function spendWords(spend) {
    const s = obj(spend) || {};
    return money(isNum(s.today_usd) ? s.today_usd : 0) + " from Hermes" + (isNum(s.roko_today_usd) ? " · " + money(s.roko_today_usd) + " in roko today" : "");
  }
  /**
   * The header's line (the desktop's todayLine): the counter, Hermes' daily limit, what live runs still hold, and what
   * is left when it says more than the limit does (live runs hold some of it).
   */
  function todayLine(spend) {
    const s = obj(spend) || {};
    const max = isNum(s.max_day_usd) ? s.max_day_usd : null;
    const parts = [spendWords(s)];
    if (max !== null) parts.push("limit " + money(max) + " a day");
    if (isNum(s.committed_usd) && s.committed_usd > 0) parts.push(money(s.committed_usd) + " held by live runs");
    if (max !== null && isNum(s.left_usd) && Math.abs(s.left_usd - (max - (isNum(s.today_usd) ? s.today_usd : 0))) > 0.005) parts.push(money(s.left_usd) + " left");
    return parts.join(" · ");
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
        } else if (card.state === "failed" && !capStop(card)) {
          // A cap's stop is not a failure: no fail sound.
          sound.play("fail");
        }
      }
      overviewStore.patchRun(card);
      emit("run", runId, card);
    }

    function onLines(runId, lines) {
      const fresh = list(lines).filter(obj);
      if (!fresh.length) return;
      fresh.forEach(function (ev) {
        if (ev.type === "gate_result" && ev.passed === true) sound.play("check");
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
        case "serve":
          // 0.7: a project's roko serve changed state.
          overviewStore.patchServe(frame.serve);
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
        // 0.7: whose overview the hello and overview frames carry (round-1 amendment 5).
        const params = {};
        if (followed) params.runs = followed;
        if (projectStore.get()) params.project = projectStore.get();
        built = SDK.buildWsUrl(API + "/live", Object.keys(params).length ? params : undefined);
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
      /** For tests and a replay: feed one frame as if the socket had sent it. */
      inject: function (frame) { onFrame(typeof frame === "string" ? frame : JSON.stringify(frame)); },
      /** Dial again, when the socket is open (another project picked: its frames are about another overview). */
      redial: function () { if (socket) reconnect(); },
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
      return { word: "live", ch: liveState.healthy ? "live" : "you", blink: undefined, title: "roko's backend pushes changes as they happen" };
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

  /**
   * GET a route once (or every `intervalMs`); `reload()` fetches again now. A route that answers per project (0.7) asks
   * about the project this tab shows, and again when the person picks another.
   */
  function useResource(route, intervalMs) {
    const project = useProject();
    const path = route && PROJECT_ROUTES.test(route) ? forProject(route, project) : route;
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

  // The 5×7 dot-matrix face, the desktop's own (spec v3 §3.4, §5.11: the glass and the dots are the same in both):
  // each glyph is seven rows of five bits (bit 4 is the left column), as hex pairs. Lowercase prints as uppercase;
  // anything else prints as a middle dot. No font to download.
  const FONT = {
    " ": "00000000000000", "!": "04040404040004", '"': "0A0A0000000000", "#": "0A0A1F0A1F0A0A",
    $: "040F140E051E04", "%": "18190204081303", "&": "0C12140815120D", "'": "0C040800000000",
    "(": "02040808080402", ")": "08040202020408", "*": "0004150E150400", "+": "0004041F040400",
    ",": "000000000C0408", "-": "0000001F000000", ".": "00000000000C0C", "/": "00010204081000",
    0: "0E11131519110E", 1: "040C040404040E", 2: "0E11010204081F", 3: "1F02040201110E",
    4: "02060A121F0202", 5: "1F101E0101110E", 6: "0608101E11110E", 7: "1F010204080808",
    8: "0E11110E11110E", 9: "0E11110F01020C", ":": "000C0C000C0C00", "<": "02040810080402",
    "=": "00001F001F0000", ">": "08040201020408", "?": "0E110102040004", "@": "0E11171517100F",
    A: "0E1111111F1111", B: "1E11111E11111E", C: "0E11101010110E", D: "1C12111111121C",
    E: "1F10101E10101F", F: "1F10101E101010", G: "0E11101711110F", H: "1111111F111111",
    I: "0E04040404040E", J: "0702020202120C", K: "11121418141211", L: "1010101010101F",
    M: "111B1515111111", N: "11111915131111", O: "0E11111111110E", P: "1E11111E101010",
    Q: "0E11111115120D", R: "1E11111E141211", S: "0F10100E01011E", T: "1F040404040404",
    U: "1111111111110E", V: "11111111110A04", W: "1111111515150A", X: "11110A040A1111",
    Y: "1111110A040404", Z: "1F01020408101F", "[": "0E08080808080E", "]": "0E02020202020E",
    _: "0000000000001F", "|": "04040404040404", "~": "00000815020000", "·": "00000004000000",
    "×": "00110A040A1100", "—": "0000001F000000", "−": "0000001F000000", "→": "0004021F020400",
    // The dashboard's own, beyond the desktop's: an estimate and a money range.
    "≈": "000D12000D1200", "–": "0000000E000000",
  };
  /** Punctuation takes only the columns it lights; digits and letters keep five (numbers never jitter). */
  const NARROW = { " ": 1, "!": 1, "'": 1, "(": 1, ")": 1, ",": 1, ".": 1, ":": 1, "[": 1, "]": 1, "|": 1, "·": 1, '"': 1 };
  /** Dot and pitch in px for each size of the face (spec v3 §3.4). */
  const DOT_SIZES = {
    XS: { dot: 1.15, pitch: 1.6 },
    S: { dot: 1.55, pitch: 2.15 },
    M: { dot: 2.15, pitch: 2.95 },
    L: { dot: 2.9, pitch: 3.85 },
    XL: { dot: 3.9, pitch: 5.1 },
    XXL: { dot: 5.2, pitch: 6.6 },
  };
  const glyphCache = {};

  /** One glyph: its seven rows as numbers, its width in columns and its first lit column (narrow glyphs). */
  function glyphOf(ch) {
    const key = FONT[ch] ? ch : FONT[ch.toUpperCase()] ? ch.toUpperCase() : "·";
    if (glyphCache[key]) return glyphCache[key];
    const rows = [0, 1, 2, 3, 4, 5, 6].map(function (i) { return parseInt(FONT[key].slice(i * 2, i * 2 + 2), 16); });
    let lo = 5;
    let hi = -1;
    rows.forEach(function (row) {
      for (let c = 0; c < 5; c += 1) {
        if ((row >> (4 - c)) & 1) {
          lo = Math.min(lo, c);
          hi = Math.max(hi, c);
        }
      }
    });
    glyphCache[key] = NARROW[key] ? (hi < 0 ? { rows: rows, w: 2, x0: 0 } : { rows: rows, w: hi - lo + 1, x0: lo }) : { rows: rows, w: 5, x0: 0 };
    return glyphCache[key];
  }

  /** Lit dots as one path of zero-length strokes: with round caps each becomes a dot. */
  function glyphPath(g, col, pitch, dot) {
    let d = "";
    g.rows.forEach(function (row, r) {
      for (let c = 0; c < g.w; c += 1) {
        if ((row >> (4 - (g.x0 + c))) & 1) d += "M" + ((col + c) * pitch + dot / 2).toFixed(2) + " " + (r * pitch + dot / 2).toFixed(2) + "h0";
      }
    });
    return d;
  }

  const gridCache = {};
  /** The unlit glass: a dim dot at every cell, the columns between glyphs included. */
  function gridPath(cols, pitch, dot) {
    const key = cols + ":" + pitch + ":" + dot;
    if (gridCache[key] === undefined) {
      let d = "";
      for (let r = 0; r < 7; r += 1) {
        for (let c = 0; c < cols; c += 1) d += "M" + (c * pitch + dot / 2).toFixed(2) + " " + (r * pitch + dot / 2).toFixed(2) + "h0";
      }
      gridCache[key] = d;
    }
    return gridCache[key];
  }

  /**
   * A string laid out on the face: the unlit grid, then one lit path per glyph. A glyph that changed since the last
   * draw (`before`) rolls in; the first draw is still.
   */
  function dotGlyphs(value, size, pad, ghost, before, sweep) {
    let text = str(value).toUpperCase();
    if (pad && text.length < pad) text = new Array(pad - text.length + 1).join(" ") + text;
    const dot = DOT_SIZES[size].dot;
    const pitch = DOT_SIZES[size].pitch;
    let col = 0;
    const chars = Array.from(text);
    const laid = chars.map(function (ch) {
      const g = glyphOf(ch);
      const at = col;
      col += g.w + 1;
      return { at: at, ch: ch, g: g };
    });
    const cols = Math.max(1, col - 1);
    const width = cols * pitch - (pitch - dot);
    const height = 7 * pitch - (pitch - dot);
    const paths = [];
    if (ghost !== false) paths.push(h("path", { key: "grid", className: "rk-off", d: gridPath(cols, pitch, dot), strokeWidth: dot }));
    laid.forEach(function (item, i) {
      const d = glyphPath(item.g, item.at, pitch, dot);
      if (!d) return;
      paths.push(
        h("path", {
          key: i + ":" + item.ch,
          className: "rk-on",
          d: d,
          strokeWidth: dot,
          "data-roll": before != null && Array.from(before)[i] !== item.ch ? "true" : undefined,
          // A light that runs along the word while something is under way (0.7: a serve starting).
          style: sweep ? { "--rk-i": i } : undefined,
        })
      );
    });
    return { paths: paths, text: text, width: width, height: height };
  }

  /**
   * Dot-matrix text, for numbers that change. The picture is decorative; the same words are in the
   * page as (visually hidden) text, so screen readers and copy-paste get the plain value.
   */
  function Dots(props) {
    const size = DOT_SIZES[props.size] ? props.size : "L";
    const prev = useRef(null);
    const g = dotGlyphs(props.value, size, props.pad, props.ghost, prev.current, props.sweep);
    useEffect(function () { prev.current = g.text; }, [g.text]);
    return h(
      "span",
      { className: "rk-dots rk-dots--" + size + (props.className ? " " + props.className : ""), "data-ch": props.ch || undefined, "data-sweep": props.sweep ? "true" : undefined, title: props.title || undefined },
      h("svg", { width: g.width.toFixed(1), height: g.height.toFixed(1), viewBox: "0 0 " + g.width.toFixed(2) + " " + g.height.toFixed(2), "aria-hidden": "true", focusable: "false" }, g.paths),
      h("span", { className: "rk-sr" }, props.label || str(props.value))
    );
  }

  /** Dot-matrix text placed inside another SVG (the dial's centre), scaled to its units. */
  function DotsAt(props) {
    const size = DOT_SIZES[props.size] ? props.size : "M";
    const g = dotGlyphs(props.value, size, 0, props.ghost, null);
    const k = props.scale || 1;
    const x = props.anchor === "middle" ? props.x - (g.width * k) / 2 : props.x;
    return h(
      "svg",
      { x: x, y: props.y, width: g.width * k, height: g.height * k, viewBox: "0 0 " + g.width.toFixed(2) + " " + g.height.toFixed(2), className: "rk-dots-at", "data-ch": props.ch || undefined },
      g.paths
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
    const blink = props.blink === false ? null : props.blink || (ch === "live" ? "slow" : ch === "you" ? "fast" : null);
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
        h(Well, { className: "rk-knob-well" }, h(Dots, { value: money(value), size: "L", label: "cap " + money(value), ch: "bone" })),
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
    ["running", "live"],
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
              h(DotsAt, { key: "ring", value: str(newest.ring) || "L?", size: "L", scale: 0.62, x: 0, y: -15, anchor: "middle", ch: loopChannel(newest) }),
              h(DotsAt, { key: "kind", value: HUB_WORD[newest.kind] || str(newest.kind).slice(0, 8), size: "M", scale: 0.36, x: 0, y: 6, anchor: "middle" }),
            ]
          : h(DotsAt, { value: "IDLE", size: "M", scale: 0.6, x: 0, y: -4, anchor: "middle" })
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
          h(LED, { ch: newest ? loopChannel(newest) : state === "active" ? "live" : "off", blink: false }),
          h("span", { className: "rk-legend-id" }, ring.id),
          h("span", { className: "rk-legend-name" }, ring.name),
          h("span", { className: "rk-legend-clock" }, ring.clock),
          h(Dots, { value: String(mine.length), size: "M", pad: 3, label: plural(mine.length, "event", "events") })
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

  const GRAPH = { pad: 14, head: 26, nodeH: 88, minW: 104, maxW: 240, colGap: 46, gapMin: 14, rowGap: 14 };

  function layoutGraph(graph, width) {
    const waves = list(graph && graph.waves).map(function (w) { return list(w).map(str); }).filter(function (w) { return w.length; });
    const cols = Math.max(1, waves.length);
    const maxRows = waves.reduce(function (m, w) { return Math.max(m, w.length); }, 1);
    // The gap between waves shrinks with the room (5 % of it, 14–46 px), so narrow pads still fit beside the stream.
    const avail = (width || 900) - GRAPH.pad * 2;
    const gap = cols > 1 ? clamp(Math.round(avail * 0.05), GRAPH.gapMin, GRAPH.colGap) : GRAPH.colGap;
    const room = avail - (cols - 1) * gap;
    const nodeW = clamp(Math.floor(room / cols), GRAPH.minW, GRAPH.maxW);
    const nodeH = GRAPH.nodeH;
    const stack = maxRows * nodeH + (maxRows - 1) * GRAPH.rowGap;
    const pos = {};
    waves.forEach(function (wave, wi) {
      const colH = wave.length * nodeH + (wave.length - 1) * GRAPH.rowGap;
      const top = GRAPH.head + GRAPH.pad + (stack - colH) / 2;
      wave.forEach(function (id, ri) {
        pos[id] = { x: GRAPH.pad + wi * (nodeW + gap), y: top + ri * (nodeH + GRAPH.rowGap), wave: wi };
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
      gap: gap,
      width: GRAPH.pad * 2 + cols * nodeW + (cols - 1) * gap,
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
    // Its place on the model ladder (0.6.0 `climb`): the rung it stands on, a climb, its tries (✕✕●).
    const at = props.planned || props.replaying ? null : padLadder(task);
    let foot;
    if (props.planned) {
      // Its checks (0.6.0 P8 names them in `verify`), and the rung it starts on.
      const checks = list(task.verify).filter(obj).length || list(task.checks).length;
      foot = h(
        "span",
        { className: "roko-node-foot-text" + (str(task.start_rung) ? " rk-pad-ladder" : "") },
        str(task.start_rung) ? h("span", { className: "rk-rchip", title: "It starts on the " + str(task.start_rung) + " rung" }, str(task.start_rung)) : null,
        [task.role ? str(task.role) : null, checks ? plural(checks, "check", "checks") : "no checks"].filter(Boolean).join(" · ")
      );
    } else if (state === "running" && props.held) {
      foot = h("span", { className: "roko-node-foot-text roko-node-held" }, h(Icon, { name: "hand", size: 11 }), " waits on you");
    } else if (state === "running" && at && at.rung) {
      foot = h(
        "span",
        { className: "roko-node-foot-text roko-node-live rk-pad-ladder" },
        h(RungChip, { at: at }),
        h(Lives, { lives: at.lives }),
        h(PadLessons, { at: at }),
        h("span", { className: "roko-flex" }),
        view.since ? h(Ticker, { since: view.since, until: props.clockAt, className: "roko-node-clock" }) : null
      );
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
    } else if (at && at.rung) {
      foot = h(
        "span",
        { className: "roko-node-foot-text rk-pad-ladder" },
        h(RungChip, { at: at }),
        at.lives.indexOf("x") >= 0 ? h(Lives, { lives: at.lives }) : null,
        h(PadLessons, { at: at }),
        h("span", { className: "roko-flex" }),
        view.duration != null ? duration(view.duration) : null
      );
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
      h("span", { className: "roko-node-foot" }, foot, props.planned || (at && at.rung && (state === "running" || at.lives.indexOf("x") >= 0)) ? null : h(Pips, { pips: view.pips }))
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
        const x = GRAPH.pad + wi * (layout.nodeW + layout.gap);
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
          const x = GRAPH.pad + wi * (layout.nodeW + layout.gap);
          // A run that ended before its last wave (interrupted, cancelled, failed) has no agent at its frontier.
          const stepCh = !head ? "off" : wi < head.wave ? "pass" : wi === head.wave ? (props.replaying ? "you" : props.ended ? "off" : "live") : "off";
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
        h("span", { className: "rk-ringtag", "data-ch": by === "failover" ? "fail" : "live" }, "L1"),
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
      h(Label, null, h("span", { className: "rk-ringtag", "data-ch": "live" }, "L0"), " Tool steps"),
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
      task.live_text ? h("blockquote", { className: "roko-quote rk-livetext" }, mdWords(oneLine(task.live_text, 600), "said")) : null
    );
  }

  /** A try's end in a word or two for its attempt row (dogfood U1): roko's verdict, else its outcome. The desktop's. */
  const VERDICT_WORDS = {
    budget_exhausted: "budget",
    gate_failed: "check failed",
    no_changes: "no changes",
    passed: "passed",
    provider_error: "provider error",
    stream_limit: "stream stopped",
    timeout: "timed out",
    turn_cap: "turn cap",
  };
  function tryEnd(t) {
    if (!obj(t) || t.outcome === "running") return null;
    return VERDICT_WORDS[str(t.verdict)] || (t.outcome === "failed" ? (str(t.failed_check) ? "check failed" : "failed") : str(t.outcome) || null);
  }

  /**
   * Why a task climbed, from the tries that did not pass on the rung it climbed from (Q4): "2 failed checks on cheap"
   * only when every one of them ended on its check (an older roko's try, with no verdict, when it names a failed
   * check); else what ended each, in order of first appearance ("2 tries on cheap didn't pass: 1 check failed, 1 turn
   * cap"); a single try by its own why ("turn cap (15 turns) on cheap"). The desktop's climbWhy.
   */
  function climbWhy(below) {
    const rung = below.length ? str(below[0].rung) : "";
    if (!rung) return "";
    function checkFailed(t) { return str(t.verdict) === "gate_failed" || (!str(t.verdict) && !!str(t.failed_check)); }
    if (below.every(checkFailed)) return plural(below.length, "failed check", "failed checks") + " on " + rung;
    if (below.length === 1) return (oneLine(str(below[0].why).replace(/^(it hit its|it|its)\s+/i, ""), 80) || tryEnd(below[0]) || "did not pass") + " on " + rung;
    const words = [];
    const counts = {};
    below.forEach(function (t) {
      const word = checkFailed(t) ? "check failed" : tryEnd(t) || "other";
      if (!(word in counts)) {
        words.push(word);
        counts[word] = 0;
      }
      counts[word] += 1;
    });
    return below.length + " tries on " + rung + " didn't pass: " + words.map(function (w) { return counts[w] + " " + w; }).join(", ");
  }

  /** Who raised a diagnosis, in words (roko's ids: `stall-watchdog`, `self_model_abandon`, …; dogfood U7). */
  function diagnosisSource(source) {
    const raw = str(source).split(":")[0];
    return { ladder_exhausted: "model ladder exhausted", self_model_abandon: "self-model", self_model_refine: "self-model" }[raw] || raw.replace(/[_-]+/g, " ");
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
    // A lesson just admitted with nothing confirmed enters its first tier: nothing moved up (dogfood U6).
    if (/_admitted$/.test(a) && !confirmed) meta.push("");
    else if (isNum(l.promoted) && l.promoted > 0) meta.push(l.promoted + " moved up a tier");
    else if (l.promoted === true) meta.push("moved up a tier");
    return { ch: /admitted|duplicate/.test(a) || confirmed ? "learn" : "ink", lesson: lesson, meta: meta.filter(Boolean).join(" · ") };
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
        ? h("div", { className: "roko-inspector-now" }, h(LED, { ch: hold && hold.state === "waiting" ? "you" : "live" }), stepWords(view), view.since ? h(Ticker, { since: view.since, prefix: " · " }) : null)
        : null,
      task.reason || (outcomeSays(task.outcome, state) || {}).note
        ? h("div", { className: "roko-inspector-reason" }, h(Icon, { name: "info", size: 12 }), str(task.reason) || outcomeSays(task.outcome, state).note)
        : null,
      props.replaying ? null : h(StepList, { runId: props.runId, task: task, running: state === "running" }),
      attempts.length
        ? h(
            "div",
            { className: "roko-inspector-sec" },
            h(Label, null, h("span", { className: "rk-ringtag", "data-ch": "live" }, "L1"), attempts.length > 1 ? " " + attempts.length + " attempts" : " Attempt"),
            h(
              "ol",
              { className: "roko-attempts" },
              attempts.map(function (a, i) {
                const gs = list(a.gates);
                const ok = gs.length && gs.every(function (g) { return g.passed; });
                // Its try on the ladder (0.6.0 `climb`): a climb named as one (U3), and what ended it (U1, `why`).
                const tries = list(task.climb).filter(obj);
                const t = tries.filter(function (x) { return isNum(x.attempt) && x.attempt === (isNum(a.attempt) ? a.attempt : i + 1); })[0] || null;
                const from = t && t.reason === "climb" && tries.indexOf(t) > 0 ? str(tries[tries.indexOf(t) - 1].rung) : "";
                const end = t && i < attempts.length - 1 ? tryEnd(t) : null;
                return h(
                  "li",
                  { key: i, className: "roko-attempt" + (ok ? " is-ok" : gs.length ? " is-bad" : "") },
                  h(
                    "div",
                    { className: "roko-attempt-row" },
                    h("span", { className: "roko-attempt-n" }, "#" + str(a.attempt || i + 1)),
                    h("span", { className: "roko-attempt-model roko-mono" }, str(a.model) || "?"),
                    t && t.reason === "climb"
                      ? h(Tag, { ch: "live", title: "climbed " + (from || "a rung") + " → " + str(t.rung) + " after 2 failed tries" }, "▲ " + oneLine(t.rung, 10))
                      : null,
                    a.started_at ? h("span", { className: "roko-attempt-at" }, wallClock(ms(a.started_at))) : null,
                    h(
                      "span",
                      { className: "roko-attempt-gates" },
                      gs.length
                        ? gs.map(function (g, gi) { return h("span", { key: gi, className: "roko-attempt-gate " + (g.passed ? "is-ok" : "is-bad"), title: str(g.gate) }, (g.passed ? "✓ " : "✗ ") + str(g.gate)); })
                        : h("span", { className: "roko-dim" }, i === attempts.length - 1 && state === "running" ? "working…" : "no checks ran")
                    ),
                    end ? h("span", { className: "roko-attempt-end", "data-roko": "attempt-end", title: str(t.why) || undefined }, end) : null
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
            h(Label, null, h("span", { className: "rk-ringtag", "data-ch": "learn" }, "L3"), " What roko learned"),
            h(
              "ul",
              { className: "rk-lessons" },
              lessons.map(function (l, i) {
                const said = lessonWords(l);
                return h(
                  "li",
                  { key: str(l.entry_id) || i, className: "rk-lesson" + (said.ch === "learn" ? "" : " is-none"), "data-admission": str(l.admission) || undefined },
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
    if (ev.group === "tool") return "live";
    return null;
  }

  function eventTone(ev) {
    if (isProblem(ev)) return "bad";
    // roko ended a try in the agent's place ("SVF stopped: it hit its turn cap"; 0.6.0 `stopped`): a stop, in red.
    if (ev.stopped === true) return "bad";
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
        ev.ring ? h("span", { className: "rk-ringtag", "data-ch": lineChannel(ev) || "live" }, str(ev.ring)) : null,
        task ? h("span", { className: "roko-feed-task" }, task) : null,
        quote ? h("span", { className: "roko-feed-quote" }, "“" + rest.slice(7) + "”") : h("span", null, rest)
      )
    );
  }

  function Feed(props) {
    // A trusted run's doubled tool steps go (dogfood U5).
    const events = dedupeTools(props.events);
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
            props.live ? h("span", { className: "roko-feed-live" }, h(LED, { ch: "live" }), "live") : null
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
    // Only the try that runs now: a frame from an earlier try of the task is old news (it lagged on camera).
    const current = frame && !(isNum(frame.attempt) && frame.attempt < newestTry(task));
    if (current && frame.kind !== "beat" && now - frame.seen_at < 90000) {
      if (frame.kind === "tool") return { key: "f" + frame.ts, text: "▸ " + str(frame.tool) + (frame.target ? " " + oneLine(frame.target, 80) : "") };
      if (frame.kind === "text" || frame.kind === "reasoning") return { key: "w" + str(frame.stretch), said: oneLineEnd(frame.said || frame.text, 120), words: true };
      if (frame.kind === "result") return { key: "f" + frame.ts, text: "◂ " + oneLine(frame.text || frame.tool, 100) };
    }
    const steps = list(task.steps);
    const last = steps.length ? steps[steps.length - 1] : null;
    if (last && (!isFinite(since) || ms(last.ts) >= since - 1000)) {
      return { key: "s" + str(last.ts), text: "▸ " + str(last.tool) + (last.target ? " " + oneLine(last.target, 80) : "") };
    }
    if (task.live_text) return { key: "t" + str(task.live_text).length, said: oneLine(task.live_text, 120), words: true };
    return null;
  }

  /**
   * The horizon (spec v3 §4.8): one glass line between what is decided (above) and what happens (below): what each
   * running task's agent is doing this second, the newest bright with a cursor, the others dimmer. Tool steps and
   * words arrive over the live socket; without it, the card's last steps stand in.
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
    const forYou = busy.some(function (t) { return props.held && props.held[str(t.task_id)]; });
    // The newest move is bright, with the cursor; the others are older news.
    function lastMove(task) {
      const frame = live && live.byTask[str(task.task_id)];
      return frame && frame.kind !== "beat" ? frame.seen_at || 0 : ms(task.step_since || task.started_at) || 0;
    }
    const shown = busy.slice(0, 4);
    const newest = shown.reduce(function (best, t) { return !best || lastMove(t) > lastMove(best) ? t : best; }, null);
    return h(
      Glass,
      // A marquee (plugin-review F9): its stopwatches and step words change every second, so a screen reader is not
      // told each change; the stream's status says the newest move at most every 2 s.
      { className: "rk-ticker rk-horizon roko-now", role: "marquee", label: "What runs now", name: "ticker", attrs: { "data-tone": forYou ? "you" : "live" } },
      h(
        "span",
        { className: "roko-now-label", "data-ch": forYou ? "you" : undefined },
        h(LED, { ch: forYou ? "you" : "live" }),
        h("span", { className: "rk-sr" }, "now")
      ),
      h(
        "div",
        { className: "rk-ticker-items" },
        shown.map(function (task) {
          const id = str(task.task_id);
          const view = taskView(task);
          const held = props.held && props.held[id];
          const step = held ? null : tickerStep(task, live && live.byTask[id], now);
          const age = task === newest ? 0 : 1;
          return h(
            "button",
            {
              key: id,
              type: "button",
              className: "roko-now-item" + (held ? " is-held" : ""),
              "data-age": String(age),
              onClick: function () { if (props.onSelect) props.onSelect(id); },
            },
            h("span", { className: "roko-now-id" }, id),
            h("span", { className: "roko-now-what" }, held ? (held === "effect" ? "holds an action for your approval" : "waits for your sign-off") : stepWords(view) || "working"),
            !held && view.since ? h(Ticker, { since: view.since, className: "roko-now-clock" }) : null,
            // Words keep their newest end in view: a long line is cut on the left, never the right.
            step
              ? h(
                  "span",
                  { key: step.key, className: "rk-ticker-step" + (step.words ? " is-words" : ""), title: step.words ? mdPlain(step.said) : undefined },
                  step.words ? h("span", null, quotedWords(mdWords(step.said, step.key))) : step.text
                )
              : null,
            step && age === 0 ? h("span", { className: "rk-cursor", "aria-hidden": "true" }) : null
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

  /** A run Hermes cancelled (0.6.0 P-1 `cancelled_by`): "cancelled from chat: <reason>", or from this page; "" else. */
  function cancelWords(run) {
    const c = obj(run && run.cancelled_by);
    const reason = c ? oneLine(c.reason, 300) : "";
    return c ? "cancelled from " + (str(c.by) === "chat" ? "chat" : "this page") + (reason ? ": " + reason : "") : "";
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
    // A run Hermes cancelled says who did it and why first (P-1: the chat's model can cancel, so the person always sees
    // it), then roko's account of what was done.
    const cancelled = run.state === "cancelled" ? cancelWords(run) : "";
    let summary = interrupted ? interruptedReason(run) : why ? str(why.summary) : "";
    if (!summary && run.state === "missing" && problems.length) summary = str(problems[0]);
    if (!summary && run.kind === "plan_generate" && run.planner_error) summary = str(run.planner_error);
    if (!summary && !cancelled) return null;
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
        cancelled ? h("div", { className: "roko-why-text", "data-roko": "why-cancelled" }, cancelled) : null,
        summary
          ? h(
              "div",
              { className: "roko-why-text" },
              validation ? summary.split(/\s*roko['\u2019]s check of the plan says:/)[0].trim() : props.typeOut ? h(TypeOut, { value: summary }) : summary
            )
          : null,
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
  // The v3 instrument (spec v3 §4.1–4.3): the glass, module labels, stamps, the bone number, the erosion meter,
  // the Ladder, the display's corners and the L0 scope. The desktop draws the same (desktop/plugin.js).
  // ---------------------------------------------------------------------------

  /** A pane of the glass (spec v3 §3.2), the same in every theme; `grid` adds the 32 px crosshair. */
  function Glass(props) {
    return h(
      "div",
      Object.assign({}, props.attrs || {}, {
        className: "rk-glass" + (props.className ? " " + props.className : ""),
        "data-grid": props.grid ? "true" : undefined,
        "data-roko": props.name || undefined,
        role: props.role || undefined,
        "aria-label": props.label || undefined,
      }),
      props.children
    );
  }

  /** `01 LABEL`, always top-left of its module, with a note on the right (spec v3 §3.4). */
  function ModLabel(props) {
    return h(
      "div",
      { className: "rk-mod" },
      props.n != null ? h("span", { className: "rk-mod-n", "aria-hidden": "true" }, (props.n < 10 ? "0" : "") + props.n) : null,
      h("span", { className: "rk-mod-label" }, props.children),
      props.right ? h("span", { className: "rk-mod-right" }, props.right) : null
    );
  }

  /** The system declaring a state, in brackets: ⌈CLIMBED⌋ (spec v3 §4.7). Words first, colour second. */
  function Stamp(props) {
    return h("span", { className: "rk-stamp", "data-tone": props.tone || undefined, "data-roko": props.name || undefined, title: props.title || undefined }, props.children);
  }

  /** A small tag in a channel: `MID ▲`, `failover: out of usage`. */
  function Tag(props) {
    return h("span", { className: "rk-tag" + (props.className ? " " + props.className : ""), "data-ch": props.ch || undefined, "data-roko": props.name || undefined, title: props.title || undefined }, props.children);
  }

  /**
   * The erosion meter (bardo's MortalityGauge, █ → ▓ → ▒ → ░): lit segments for what is spent, the segment it is in
   * partly lit, and a dashed ghost up to what is held or projected (spec v3 §4.2). It sits on the glass.
   */
  function Meter(props) {
    const max = props.max;
    if (!isNum(max) || max <= 0) return null;
    const n = props.segments || 24;
    const value = isNum(props.value) ? Math.max(0, props.value) : 0;
    const lit = clamp(value / max, 0, 1) * n;
    const full = Math.floor(lit);
    const held = isNum(props.ghost) ? Math.round(clamp(props.ghost / max, 0, 1) * n) : 0;
    const segs = [];
    for (let i = 0; i < n; i += 1) {
      const seg = i < full ? "on" : i === full && lit - full > 0.5 ? "e1" : i === full && lit - full > 0.05 ? "e2" : i < held ? "ghost" : undefined;
      segs.push(h("i", { key: i, "data-seg": seg }));
    }
    return h(
      "span",
      {
        className: "rk-meter" + (props.className ? " " + props.className : ""),
        "data-tone": props.tone || "ink",
        "data-roko": props.name || undefined,
        role: props.label ? "meter" : undefined,
        "aria-hidden": props.label ? undefined : "true",
        "aria-label": props.label || undefined,
        "aria-valuemin": props.label ? 0 : undefined,
        "aria-valuemax": props.label ? max : undefined,
        "aria-valuenow": props.label ? value : undefined,
      },
      segs
    );
  }

  /**
   * Money as the one bone number shows it: to the tenth of a cent below a dollar ($0.000 at the start, $0.071, $0.250),
   * so its width never changes as it climbs; to the cent from a dollar.
   */
  function boneMoney(v) {
    if (!isNum(v)) return "—";
    return Math.abs(v) < 1 ? "$" + v.toFixed(3) : "$" + v.toFixed(2);
  }

  /**
   * A number that moves the way bardo's VitalityNumber does (spec v3 §2.3, §3.6): towards its target at `rate` per
   * second, current += (target − current)·(1 − e^(−rate·dt)), a frame at a time, asleep once it arrives. The first
   * value shows at once; with reduced motion every value does. It never flashes.
   */
  function useLerp(target, rate) {
    const speed = rate || 1.5;
    const [shown, setShown] = useState(target);
    const cur = useRef(target);
    useEffect(function () {
      if (!isNum(target) || !isNum(cur.current) || prefersReducedMotion() || typeof window.requestAnimationFrame !== "function") {
        cur.current = target;
        setShown(target);
        return undefined;
      }
      if (Math.abs(target - cur.current) < 1e-9) return undefined;
      let last = 0;
      let frame = 0;
      function step(now) {
        const dt = last ? Math.min(0.25, (now - last) / 1000) : 1 / 30;
        last = now;
        cur.current += (target - cur.current) * (1 - Math.exp(-speed * dt));
        if (Math.abs(target - cur.current) <= Math.max(5e-5, Math.abs(target) * 2e-4)) cur.current = target;
        setShown(cur.current);
        if (cur.current !== target) frame = window.requestAnimationFrame(step);
      }
      frame = window.requestAnimationFrame(step);
      return function () { window.cancelAnimationFrame(frame); };
    }, [target, speed]);
    return shown;
  }

  /** The one bone number on a screen (spec v3 §2.3): the focal object's money, lerping, never flashing. */
  function BoneNumber(props) {
    const shown = useLerp(isNum(props.value) ? props.value : null);
    return h("span", { className: "rk-bone", "data-roko": props.name || undefined }, h(Dots, { value: boneMoney(shown), size: props.size || "XL", ch: "bone", label: props.label }));
  }

  /** A braille-resolution trace: a column of dots per bucket, a dot at its height, older columns dimmer (spec v3 §4.2). */
  function BrailleTrace(props) {
    const width = props.width || 300;
    const height = props.height || 18;
    const values = props.values;
    const pitch = 3.2;
    const cols = Math.max(2, Math.floor(width / pitch));
    const rows = Math.max(2, Math.floor(height / pitch));
    const max = Math.max.apply(null, [1].concat(values));
    function at(i) {
      return values[Math.min(values.length - 1, Math.round((i / (cols - 1)) * (values.length - 1)))] || 0;
    }
    function y(v) {
      return ((rows - 1 - Math.round((v / max) * (rows - 1))) * pitch + pitch / 2).toFixed(1);
    }
    const dots = [];
    for (let c = 0; c < cols; c += 1) {
      const v = at(c);
      dots.push(h("circle", { key: c, cx: (c * pitch + pitch / 2).toFixed(1), cy: y(v), r: v > 0 ? 1.05 : 0.6, opacity: (0.28 + 0.72 * (c / (cols - 1))).toFixed(2) }));
    }
    return h(
      "svg",
      { className: "rk-trace", "data-tone": props.tone || "live", width: width, height: height, viewBox: "0 0 " + width + " " + height, "aria-hidden": "true", focusable: "false" },
      dots,
      h("circle", { className: "rk-trace-head", cx: ((cols - 1) * pitch + pitch / 2).toFixed(1), cy: y(at(cols - 1)), r: 2 })
    );
  }

  /**
   * L0, the scope (the instrument's bottom edge): the run's tool calls as a braille trace, the last three minutes
   * while it goes and its whole length once it ended, and how many a minute. From the live socket, else the card's
   * steps.
   */
  function ToolScope(props) {
    const run = props.run;
    const active = props.active;
    const runId = str(run.run_id);
    useLiveVersion(runId, ["live"]);
    const now = useTick(active);
    const live = liveStore.live(runId);
    const fromSocket = live ? list(live.recent).filter(function (it) { return it.kind === "tool" && isNum(it.ts); }).map(function (it) { return it.ts; }) : [];
    const fromCard = [];
    list(run.tasks).forEach(function (t) {
      list(t.steps).forEach(function (step) { if (isFinite(ms(step.ts))) fromCard.push(ms(step.ts)); });
    });
    // The card's steps up to the socket's first tool call, then the socket's: each call once.
    const firstLive = fromSocket.length ? Math.min.apply(null, fromSocket) : Infinity;
    const times = fromCard.filter(function (t) { return t < firstLive; }).concat(fromSocket);
    const start = ms(run.started_at || run.hermes_started_at);
    const end = active ? now : isFinite(ms(run.finished_at)) ? ms(run.finished_at) : Math.max.apply(null, [now].concat(times));
    const from = active ? end - 180000 : isFinite(start) ? start : Math.min.apply(null, [end - 60000].concat(times));
    const span = Math.max(1, end - from);
    const buckets = [];
    for (let i = 0; i < 48; i += 1) buckets.push(0);
    times.forEach(function (t) {
      if (t >= from && t <= end) buckets[Math.min(47, Math.floor(((t - from) / span) * 48))] += 1;
    });
    const perMin = times.filter(function (t) { return t > now - 60000; }).length;
    return h(
      "div",
      { className: "rk-disp-scope", "data-roko": "instrument-scope" },
      h(ModLabel, null, "L0"),
      h(BrailleTrace, { values: buckets, width: 300, tone: "live" }),
      h("span", { className: "roko-flex" }),
      props.end || h("span", { className: "rk-cnote" }, active ? perMin + " calls/min" : times.length ? plural(times.length, "tool call", "tool calls") : "no tool calls seen")
    );
  }

  // The Ladder (spec v3 §4.3): cheap to top rungs, tasks climbing when their checks fail.

  /** A rung's price per million tokens, in and out: "$0.35·$0.75" (from the workspace's [models.*] or roko's list). */
  /** Where a rung's prices come from, in words (0.6.0 `priced_by`, roko 7a5dd6046), for the price's title. */
  function priceSource(rung) {
    const by = str(rung && rung.priced_by);
    if (!by) return undefined;
    const said = { snapshot: "roko's price snapshot" + (str(rung.price_snapshot) ? " " + str(rung.price_snapshot) : ""), profile: "the model's own prices in roko", builtin: "roko's built-in price table", "roko.toml": "roko.toml's [models] prices" }[by] || by;
    return "USD per million tokens, in · out; priced by " + said;
  }
  function rungPrice(rung) {
    function one(v) { return isNum(v) ? "$" + (v < 10 ? v.toFixed(2) : String(Math.round(v))) : "?"; }
    return !isNum(rung.price_in) && !isNum(rung.price_out) ? "" : one(rung.price_in) + "·" + one(rung.price_out);
  }

  /** Where a task stands now, as a token: its latest try's state. */
  function tokenState(task) {
    const state = nodeState(task.outcome);
    return state === "pending" ? "waiting" : state === "warn" ? "unverified" : state;
  }

  /**
   * The run's ladder as rows, top rung first (spec v3 §4.3): each rung with the tasks whose latest try ran on it,
   * the ghosts of tries that failed on it before their task climbed, and the tasks not started yet on the rung a run
   * from Hermes starts on (the cheapest it can use). Null without a ladder (an older backend, or a workspace whose
   * roko.toml names no rungs).
   */
  function ladderRows(run) {
    const rungs = list(run && run.ladder).filter(function (r) { return obj(r) && str(r.rung); });
    if (!rungs.length) return null;
    const index = {};
    rungs.forEach(function (r, i) { index[str(r.rung)] = i; });
    const start = Math.max(0, rungs.findIndex(function (r) { return r.chat_ok !== false; }));
    const rows = rungs.map(function (rung) { return { rung: rung, tokens: [], ghosts: [], passed: 0 }; });
    const tasks = list(run.tasks).filter(obj);
    tasks.forEach(function (task, col) {
      const id = str(task.task_id);
      const tries = list(task.climb).filter(obj);
      const last = tries.length ? tries[tries.length - 1] : null;
      const at = last ? index[str(last.rung)] : tries.length ? undefined : start;
      // The tries that failed on a rung other than the one the task stands on: its climb's footprints.
      const below = {};
      tries.forEach(function (t) {
        const i = index[str(t.rung)];
        if (i !== undefined && i !== at && t.outcome === "failed") below[i] = (below[i] || 0) + 1;
      });
      Object.keys(below).forEach(function (i) { rows[i].ghosts.push({ col: col, id: id, n: below[i] }); });
      if (at === undefined) return;
      const lower = Object.keys(below).map(Number).filter(function (i) { return i < at; }).sort(function (a, b) { return b - a; })[0];
      // A task with no tries on the card yet waits on the start rung; one that ended without them says how.
      const state = tries.length || ["pending", "running"].indexOf(nodeState(task.outcome)) < 0 ? tokenState(task) : "waiting";
      const lives = obj(task.lives);
      const top = !rungs.slice(at + 1).some(function (r) { return r.chat_ok !== false; });
      const fo = last && last.reason === "failover" ? obj(last.failover) : null;
      rows[at].tokens.push({
        id: id,
        col: col,
        state: state,
        climbed: tries.some(function (t) { return t.reason === "climb"; }),
        // roko says so since 37088dc12 (`tasks[].exhausted`, with its advice); an older card, by its lives on the top rung.
        exhausted: !!obj(task.exhausted) || (state === "failed" && top && !!lives && isNum(lives.used) && lives.used >= (isNum(lives.of) ? lives.of : 2)),
        advice: obj(task.exhausted) ? oneLine(task.exhausted.suggestion, 160) : "",
        failover: last && last.reason === "failover" ? (fo && (str(fo.why) || str(fo.class))) || "failover" : "",
        from: lower,
        fromWord: lower !== undefined ? "▲ " + below[lower] + "✕ on " + str(rungs[lower].rung) : "",
      });
      if (state === "passed") rows[at].passed += 1;
    });
    return { columns: tasks.length, rows: rows.slice().reverse(), top: rows.length - 1 };
  }

  /** Each task's rung the last time the ladder drew, so a climb or a failover is seen once, as it happens. */
  const ladderSeen = new Map();

  /**
   * The Ladder, full form (the instrument's left): rung rows, top first, each with its name, model, price, a rail
   * and how many tasks passed there. A token per task on the rung of its latest try: ✓ passed in sage, rose while
   * running, a dashed red ✕✕ ghost where it failed before it climbed, a dashed ◌ while it waits. A rung a chat's run
   * cannot use is dashed and says why. A climb rises along a dashed rose trail with an echo and the ⌈CLIMBED⌋ stamp; a
   * failover slides sideways; a task out of rungs says ⌈SPLIT OR REPLAN⌋.
   */
  function Ladder(props) {
    const run = props.run;
    const laid = ladderRows(run);
    const [stamps, setStamps] = useState({});
    const [playing, setPlaying] = useState({});
    const stampTimer = useRef(null);
    const moveTimer = useRef(null);
    const reduced = prefersReducedMotion();
    useEffect(function () {
      return function () {
        clearTimeout(stampTimer.current);
        clearTimeout(moveTimer.current);
      };
    }, []);

    // What moved since the last draw: a token on a higher rung climbed; one on the same rung after a failover slid.
    const moves = {};
    if (laid) {
      laid.rows.forEach(function (row, r) {
        row.tokens.forEach(function (token) {
          const was = ladderSeen.get(str(run.run_id) + ":" + token.id);
          const at = laid.top - r;
          if (was && was.at < at && token.climbed) moves[token.id] = { kind: "climb", dy: (at - was.at) * 40 };
          else if (was && was.at === at && token.failover && !was.failover) moves[token.id] = { kind: "failover" };
        });
      });
    }

    useEffect(function () {
      if (!laid) return;
      const fresh = {};
      laid.rows.forEach(function (row, r) {
        row.tokens.forEach(function (token) {
          if (moves[token.id] && moves[token.id].kind === "climb") fresh[token.id] = true;
          ladderSeen.set(str(run.run_id) + ":" + token.id, { at: laid.top - r, failover: !!token.failover });
        });
      });
      if (ladderSeen.size > 600) ladderSeen.delete(ladderSeen.keys().next().value);
      if (Object.keys(fresh).length) {
        // The stamp holds for a Moment, then the ladder is still again (spec v3 §6).
        setStamps(fresh);
        clearTimeout(stampTimer.current);
        stampTimer.current = setTimeout(function () { setStamps({}); }, 1200);
      }
      if (Object.keys(moves).length) {
        // The move keeps playing through the redraws that follow, for its passage (600 ms), then the token rests.
        setPlaying(function (was) { return Object.assign({}, was, moves); });
        clearTimeout(moveTimer.current);
        moveTimer.current = setTimeout(function () { setPlaying({}); }, 700);
      }
    });

    if (!laid) return null;
    const n1 = Math.max(1, laid.columns - 1);
    function x(col) { return "calc(min(38px, (100% - 32px) / " + n1 + ") * " + col + ")"; }
    function words(row) {
      const parts = row.tokens.map(function (t) {
        return t.id + " " + (t.state === "waiting" ? "waiting to start" : t.state) + (t.climbed ? ", climbed here" : "");
      });
      row.ghosts.forEach(function (g) { parts.push(g.id + " failed " + (g.n === 1 ? "once" : g.n + " times") + " here and climbed"); });
      return str(row.rung.rung) + " rung, " + (str(row.rung.slug) || str(row.rung.model)) + (row.rung.chat_ok === false ? ", not for runs from a chat" : "") + (parts.length ? ": " + parts.join("; ") : "");
    }

    return h(
      "div",
      { className: "rk-lad", "data-roko": "ladder" },
      h(ModLabel, { n: 3, right: "cheapest first · a rung up after 2 failed tries" }, "ladder"),
      h(
        "div",
        { className: "rk-lad-rungs", role: "list", "aria-label": "The model ladder, top rung first" },
        laid.rows.map(function (row, r) {
          const off = row.rung.chat_ok === false;
          const live = row.tokens.some(function (t) { return t.state === "running"; });
          // A note sits beside its token only when no token stands to its right on the rung; otherwise the token
          // carries the words in its title (the stream and the NOW corner say them too).
          const last = Math.max.apply(null, [-1].concat(row.tokens.map(function (t) { return t.col; })));
          return h(
            "div",
            {
              key: str(row.rung.rung),
              className: "rk-rung",
              role: "listitem",
              "aria-label": words(row),
              "data-rung": str(row.rung.rung),
              "data-live": live ? "true" : undefined,
              "data-off": off ? "true" : undefined,
            },
            h(
              "div",
              { className: "rk-rung-name", "aria-hidden": "true" },
              h("span", { className: "rk-rung-top" }, h("span", { className: "rk-rung-r" }, str(row.rung.rung)), h("span", { className: "rk-rung-p", title: priceSource(row.rung) }, rungPrice(row.rung))),
              h("span", { className: "rk-rung-m", title: str(row.rung.model) }, str(row.rung.slug) || str(row.rung.model))
            ),
            h(
              "div",
              { className: "rk-rail", "aria-hidden": "true" },
              off ? h("span", { className: "rk-rail-note" }, str(row.rung.why_not) || "not for chat runs") : null,
              row.ghosts.map(function (g) {
                return h("span", { key: "g" + g.id, className: "rk-tok", "data-state": "ghost", style: { left: x(g.col) }, title: g.id + " failed " + (g.n === 1 ? "once" : g.n + " times") + " here" }, g.n > 1 ? "✕✕" : "✕");
              }),
              row.tokens.map(function (t) {
                const move = moves[t.id] || playing[t.id];
                // Rows run top first: this one is rung `laid.top - r`; the trail reaches down to the rung it climbed from.
                const trail = t.from !== undefined ? laid.top - r - t.from : 0;
                const beside = { left: "calc(" + x(t.col) + " + 40px)" };
                return h(
                  Fragment,
                  { key: t.id },
                  trail > 0 ? h("span", { className: "rk-trail", style: { height: trail * 40 - 20 + "px", left: "calc(" + x(t.col) + " + 15px)" } }) : null,
                  move && move.kind === "climb" && !reduced ? h("span", { className: "rk-tok rk-tok-echo", style: { left: x(t.col), "--rk-dy": move.dy + "px" } }) : null,
                  h(
                    "span",
                    {
                      className: "rk-tok",
                      "data-roko-token": t.id,
                      "data-state": t.state,
                      "data-failover": t.failover ? "true" : undefined,
                      "data-move": move && !reduced ? move.kind : undefined,
                      style: { left: x(t.col), "--rk-dy": move && move.dy ? move.dy + "px" : undefined },
                      title: [t.failover ? "failover: " + t.failover : "", t.fromWord && t.col !== last ? t.fromWord : ""].filter(Boolean).join(" · ") || undefined,
                    },
                    oneLine(t.id, 4)
                  ),
                  t.fromWord && t.state === "running" && t.col === last ? h("span", { className: "rk-climbnote", style: beside }, t.fromWord) : null,
                  // A stamp is a declaration: beside its token, or (with tokens to its right) over the rail's end.
                  stamps[t.id]
                    ? h("span", { className: "rk-lad-stamp", style: t.col === last ? beside : { right: 0 } }, h(Stamp, { tone: "live", name: "stamp-climbed" }, "climbed"))
                    : null,
                  t.exhausted
                    ? h(
                        "span",
                        { className: "rk-lad-stamp", style: t.col === last ? beside : { right: 0 } },
                        h(Stamp, { tone: "you", name: "stamp-exhausted", title: t.advice || "It failed its checks on the top rung a run from here can use: split it or replan it" }, "split or replan")
                      )
                    : null,
                  t.failover && t.col === last ? h("span", { className: "rk-lad-failover", style: beside }, h(Tag, { ch: "fail" }, "failover: " + oneLine(t.failover, 24))) : null
                );
              })
            ),
            h("span", { className: "rk-rcount", "aria-hidden": "true", "data-passed": row.passed ? "true" : undefined }, row.passed ? row.passed + "✓" : off ? "" : "·")
          );
        })
      ),
      h(
        "div",
        { className: "rk-lad-foot", "aria-hidden": "true" },
        h("span", null, h("b", { "data-ch": "pass" }, "✓"), " passed"),
        h("span", null, h("b", { "data-ch": "fail" }, "✕"), " check failed"),
        h("span", null, h("b", { "data-ch": "live" }, "▲"), " climbed"),
        h("span", null, h("b", null, "◌"), " waiting")
      )
    );
  }

  /**
   * The Ladder, mini form (a run row, spec v3 §4.3): four rails, top first, a dot per task where it stands: sage
   * passed, rose running, red where a try failed, hollow waiting.
   */
  function MiniLadder(props) {
    const rungs = list(props.rungs).slice(-4);
    if (!rungs.length) return null;
    function dots(r) {
      const out = [];
      function add(k, n, max) { for (let i = 0; i < Math.min(max, isNum(n) ? n : 0); i += 1) out.push(k); }
      add("p", r.passed, 4);
      add("r", r.running, 2);
      add("x", r.failed, 2);
      add("w", r.waiting, 2);
      return out.slice(0, 5);
    }
    const words = rungs.map(function (r) {
      const parts = [isNum(r.passed) && r.passed ? r.passed + " passed" : null, isNum(r.running) && r.running ? r.running + " running" : null, isNum(r.failed) && r.failed ? r.failed + " failed" : null].filter(Boolean);
      return parts.length ? str(r.rung) + ": " + parts.join(", ") : null;
    }).filter(Boolean).join("; ");
    return h(
      "span",
      { className: "rk-mlad", role: "img", "aria-label": "On the model ladder: " + (words || "nothing yet") },
      rungs.slice().reverse().map(function (r, i) {
        return h("i", { key: str(r.rung) || i }, dots(r).map(function (d, j) { return h("b", { key: j, "data-state": d }); }));
      })
    );
  }

  /** A task's place on the model ladder (0.6.0 `climb`): the rung it stands on, whether it climbed, its tries. */
  function padLadder(task) {
    const tries = list(task && task.climb).filter(obj);
    const lives = obj(task && task.lives);
    const last = tries.length ? tries[tries.length - 1] : null;
    return {
      rung: (lives && str(lives.rung)) || (last && str(last.rung)) || "",
      climbed: tries.some(function (t) { return t.reason === "climb"; }),
      lives: tries.map(function (t) { return t.outcome === "failed" ? "x" : t.outcome === "running" ? "r" : t.outcome === "passed" ? "p" : "o"; }),
      // The lessons roko put in its latest try's prompt (0.6.0 `lesson_ids`, from roko's prompt_assembled).
      lessons: last ? distinct(list(last.lesson_ids).map(str).filter(Boolean)).length : 0,
    };
  }

  /** ◇n on a pad: the lessons roko put in the task's latest prompt (indigo, the learn channel). */
  function PadLessons(props) {
    const n = props.at.lessons;
    return n ? h("span", { className: "rk-pad-lessons", title: plural(n, "lesson", "lessons") + " in its prompt" }, "◇" + n) : null;
  }

  /** A pad's ladder rung (spec v3 §4.4): `CHEAP`, or `MID ▲` in rose when the task climbed to it. */
  function RungChip(props) {
    const at = props.at;
    return h(
      "span",
      { className: "rk-rchip", "data-climbed": at.climbed ? "true" : undefined, title: at.climbed ? "It climbed to the " + at.rung + " rung after its tries failed below" : "It runs on the " + at.rung + " rung" },
      at.climbed ? at.rung + " ▲" : at.rung
    );
  }

  /** A task's tries, read left to right (spec v3 §4.3): ✕ a try whose check failed, ● the running one, ● passed. */
  function Lives(props) {
    const lives = list(props.lives);
    if (!lives.length) return null;
    const failed = lives.filter(function (l) { return l === "x"; }).length;
    return h(
      "span",
      { className: "rk-lives", role: "img", "aria-label": plural(lives.length, "try", "tries") + ": " + failed + " failed" },
      lives.slice(-6).map(function (l, i) { return h("i", { key: i, "data-life": l }); })
    );
  }

  /** The run's checks as pips across its tasks (bardo's ActionGateIndicator): ▮ passed, ▯ red not passed, rose running. */
  function GatePips(props) {
    const pips = list(props.pips).slice(-(props.max || 16));
    if (!pips.length) return null;
    return h(
      "span",
      { className: "rk-gpips", "aria-hidden": "true" },
      pips.map(function (p, i) { return h("i", { key: i, "data-state": p.passed === true ? "pass" : p.passed === false ? "fail" : p.live ? "run" : "wait" }); })
    );
  }

  /**
   * The run's instrument (spec v3 §4.2, the CHEST): the Ladder at its left when the workspace has one, and a
   * corner-heavy display around the bone number: 01 TASKS, 02 TIME, the spend with its erosion meter, 04 CHECKS,
   * 05 NOW, and L0 along the bottom edge (or, once it ended, the verdict).
   */
  function RunInstrument(props) {
    const run = props.run;
    const tasks = props.tasks;
    const p = props.progress;
    const active = props.active;
    const stale = props.stale;
    const waits = props.waits;
    const ch = props.ch;
    const gates = obj(run.gates) || {};
    const checksAll = isNum(gates.total) && gates.total > 0;
    const models = modelsOf(tasks);
    const route = latestRoute(tasks);
    const view = route ? routeView(route) : null;
    const cap = isNum(run.max_usd) && run.max_usd > 0 ? run.max_usd : null;
    const ratio = cap !== null && isNum(run.cost_usd) ? run.cost_usd / cap : null;
    const finishedCount = (p.passed || 0) + (p.failed || 0) + (p.blocked || 0) + (p.stopped || 0) + (p.skipped || 0) + (p.unverified || 0);
    const fraction = isNum(p.total) && p.total > 0 ? finishedCount / p.total : 0;
    const projected = active && !stale && isNum(run.cost_usd) && fraction >= 0.15 && fraction < 1 ? run.cost_usd / fraction : null;
    const lastSeen = props.lastSeen;
    const checking = props.checking;
    const state = capStop(run) ? "stopped" : str(run.state);
    const ladder = list(run.ladder).filter(obj).length ? h(Ladder, { run: run }) : null;
    // The task the NOW corner speaks for: the newest route's, else the first running one; its latest try on the
    // ladder names its model and rung even before a route event.
    const running = tasks.filter(function (t) { return t.outcome === "running"; });
    const nowTask = route && route.task_id ? tasks.filter(function (t) { return str(t.task_id) === str(route.task_id); })[0] : running[0];
    const nowTries = nowTask ? list(nowTask.climb).filter(obj) : [];
    const nowTry = nowTries.length ? nowTries[nowTries.length - 1] : null;
    const nowRung = (nowTry && str(nowTry.rung)) || (route && str(route.rung)) || "";
    const nowClimbed = nowTries.some(function (t) { return t.reason === "climb"; });
    const nowModel = (route && str(route.model)) || (nowTry && str(nowTry.model)) || (models[0] && models[0].model) || "";
    const attempts = nowTask && isNum(nowTask.attempts) ? nowTask.attempts : nowTry && isNum(nowTry.attempt) ? nowTry.attempt : 0;
    // Once it ended: the model most of its tasks finished on, that model's rung, and the others it also used (not the
    // last route's words).
    const endModels = {};
    tasks.forEach(function (t) {
      const tries = list(t.climb).filter(obj);
      const last = tries.length ? tries[tries.length - 1] : null;
      const logs = list(t.attempt_log);
      const m = (last && str(last.model)) || (logs.length && str(logs[logs.length - 1].model)) || str(t.model);
      if (!m) return;
      const e = endModels[m] || (endModels[m] = { model: m, n: 0, rung: "" });
      e.n += 1;
      if (!e.rung && last) e.rung = str(last.rung);
    });
    const ranked = Object.keys(endModels).map(function (k) { return endModels[k]; }).sort(function (a, b) { return b.n - a.n; });
    const doneWords = [
      p.passed ? h("span", { key: "p" }, p.passed + " passed") : null,
      p.unverified ? h("span", { key: "u", "data-ch": "you" }, p.unverified + " unverified") : null,
      waits ? h("span", { key: "w", "data-ch": "you", "data-roko": "instrument-waiting" }, "waiting on you") : p.running ? h("span", { key: "r", "data-ch": stale ? undefined : "live" }, p.running + (stale ? " was running" : " running")) : null,
      p.failed ? h("span", { key: "f", "data-ch": "fail" }, p.failed + " did not pass") : null,
      p.blocked ? h("span", { key: "b", "data-ch": "you" }, p.blocked + " blocked") : null,
      p.stopped ? h("span", { key: "s" }, p.stopped + " stopped") : null,
      p.skipped ? h("span", { key: "k" }, p.skipped + " skipped") : null,
      p.pending ? h("span", { key: "q" }, p.pending + " waiting") : null,
    ].filter(Boolean);
    const verdict = stale
      ? h("div", { className: "rk-verdict", "data-ch": "off" }, h(Stamp, null, "off"), h("span", { className: "rk-sr" }, "roko serve is not answering"))
      : h(
          "div",
          { className: "rk-verdict", "data-ch": ch },
          h(Stamp, { tone: ch === "off" || ch === "idle" ? undefined : ch }, stampWord(run)),
          h("span", { className: "rk-sr" }, capStop(run) ? "verdict: " + capStopWords(capStop(run)) : "verdict: " + str(run.state))
        );
    const moment = props.moment;
    // How long it took: roko's figure, else from its start to its end.
    const took = isNum(run.duration_ms) ? run.duration_ms : ms(run.finished_at) - ms(run.started_at || run.hermes_started_at);
    return h(
      Glass,
      {
        className: "rk-inst",
        grid: true,
        name: "display",
        label: "the run's instrument",
        attrs: { "data-ch": ch, "data-state": state, "data-ladder": ladder ? "true" : undefined },
      },
      state === "failed" ? h("div", { className: "rk-hazard", "aria-hidden": "true" }) : null,
      // The end, as it happens (spec v3 §6): one scanline sweeps the glass when it passed; its stamp holds a Moment.
      moment && moment.tier >= 3 && str(run.state) === "succeeded" && !prefersReducedMotion() ? h("div", { key: "sweep" + moment.at, className: "rk-sweep", "aria-hidden": "true" }) : null,
      state === "interrupted" ? h("div", { className: "rk-deadzone", "aria-hidden": "true" }) : null,
      ladder ? h("div", { className: "rk-inst-ladder" }, ladder) : null,
      ladder ? h("div", { className: "rk-inst-divider", "aria-hidden": "true" }) : null,
      h(
        "div",
        { className: "rk-disp" },
        // The stamp holds on the display's label row, between TASKS and TIME, covering no reading.
        moment ? h("div", { key: "moment" + moment.at, className: "rk-moment", "data-tier": String(moment.tier), "data-roko": "end-moment" }, h(Stamp, { tone: moment.stamp.tone || undefined }, moment.stamp.word)) : null,
        h(
          "div",
          { className: "rk-corner", "data-at": "tl", "data-roko": "instrument-tasks", role: "group", "aria-label": "tasks" },
          h(ModLabel, { n: 1 }, "tasks"),
          h(
            "div",
            { className: "rk-corner-v" },
            h(Dots, {
              value: isNum(p.total) && p.total ? (p.passed || 0) + "/" + p.total : "-/-",
              size: "M",
              ch: "ink",
              label: isNum(p.total) && p.total ? (p.passed || 0) + " of " + plural(p.total, "task", "tasks") + " passed" + (p.running ? ", " + p.running + " running" : "") : "no tasks yet",
            }),
            h(StepStrip, { progress: p, max: 14, waiting: waits })
          ),
          h(
            "span",
            { className: "rk-cnote" },
            doneWords.length
              ? doneWords.reduce(function (out, word, i) { return i ? out.concat([" · ", word]) : [word]; }, [])
              : isNum(p.total) && p.total ? null : "no tasks yet"
          )
        ),
        h(
          "div",
          { className: "rk-corner", "data-at": "tr", "data-roko": "instrument-time", role: "group", "aria-label": active ? "time" : "took" },
          h(ModLabel, { n: 2 }, active ? "time" : "took"),
          active && (run.started_at || run.hermes_started_at)
            ? h(DotClock, { since: run.started_at || run.hermes_started_at, until: stale && isFinite(lastSeen) ? lastSeen : undefined, stopped: stale, size: "M", ch: "ink" })
            : h(Dots, { value: isFinite(took) ? stopwatch(took) : "-:--", size: "M", ch: "ink", label: isFinite(took) ? "took " + stopwatch(took) : "not started" }),
          h(
            "span",
            { className: "rk-cnote" },
            stale
              ? "until roko last wrote"
              : active
                ? checking
                  ? h(CheckingLine, { checking: checking, short: true })
                  : isNum(run.eta_minutes) && run.eta_minutes > 0 ? "≈ " + Math.max(1, Math.round(run.eta_minutes)) + " min left" : "roko is working"
                : run.finished_at ? "finished " + ago(run.finished_at) : ""
          )
        ),
        h(
          "div",
          { className: "rk-disp-center", "data-roko": "instrument-spend", role: "group", "aria-label": "spend" },
          h("div", { className: "rk-mod" }, h("span", { className: "rk-mod-label" }, run.state === "queued" ? "queued" : "spend · this run")),
          run.state === "queued" && isNum(run.position)
            ? h(Dots, { value: "#" + run.position, size: "XL", ch: "ink", label: "queued, position " + run.position })
            : h(BoneNumber, { value: run.cost_usd, label: "spent " + moneyFine(run.cost_usd) + (cap !== null ? " of a " + money(cap) + " cap" : "") }),
          // The cap meter erodes in bone; past 80 % of the cap it turns orange, past 95 % red.
          cap !== null
            ? h(Meter, {
                value: run.cost_usd,
                max: cap,
                segments: 34,
                ghost: projected,
                name: "spend-meter",
                tone: ratio !== null && ratio >= 0.95 ? "fail" : ratio !== null && ratio >= 0.8 ? "you" : "bone",
                label: "spent " + moneyFine(run.cost_usd) + " of " + money(cap),
              })
            : null,
          h(
            "span",
            { className: "rk-disp-sub" },
            cap !== null ? "of " + money(cap) + " cap" : "no cap",
            projected !== null ? h("span", { title: "spent so far ÷ the share of tasks done" }, " · ≈ " + money(projected) + " at this pace") : null,
            capStop(run) ? " · stopped at it" : null
          )
        ),
        h(
          "div",
          { className: "rk-corner", "data-at": "bl", "data-roko": "instrument-checks", role: "group", "aria-label": "checks" },
          h(ModLabel, { n: 4 }, "checks"),
          h(
            "div",
            { className: "rk-corner-v" },
            h(Dots, {
              value: checksAll ? String(gates.passed || 0) + "/" + gates.total : "-/-",
              size: "M",
              ch: checksAll && gates.failed > 0 ? "fail" : checksAll && gates.passed ? "pass" : "dim",
              label: checksAll ? (gates.passed || 0) + " of " + gates.total + " checks passed" + (isNum(gates.retried) && gates.retried > 0 ? ", " + gates.retried + " retried" : "") : "no checks yet",
            }),
            h(GatePips, { pips: allPips(tasks), max: 16 })
          ),
          // `gates` counts each task's final attempt; `retried` the earlier attempts' checks that did not pass, so
          // roko tried again (0.5.0): a retry that passed is not a failure.
          h(
            "span",
            { className: "rk-cnote", "data-roko": "checks-words" },
            checksAll ? (gates.failed ? gates.failed + " did not pass" : "passed") : "no check ran yet",
            isNum(gates.retried) && gates.retried > 0 ? h("span", { "data-roko": "checks-retried" }, " · " + gates.retried + " retried") : null
          )
        ),
        h(
          "div",
          { className: "rk-corner", "data-at": "br", "data-roko": "instrument-model", role: "group", "aria-label": active ? "now" : "models" },
          h(ModLabel, { n: 5 }, active ? "now" : models.length > 1 ? "models" : "model"),
          !active && ranked.length
            ? h(
                "div",
                { className: "rk-corner-v" },
                h("span", { className: "rk-now-model", title: ranked.map(function (m) { return m.model + " · " + plural(m.n, "task", "tasks"); }).join("; ") }, oneLine(ranked[0].model, 24)),
                ranked[0].rung ? h(Tag, null, ranked[0].rung) : null
              )
            : h(
                "div",
                { className: "rk-corner-v" },
                h("span", { className: "rk-now-model", title: models.map(function (m) { return m.model + (m.n > 1 ? " ×" + m.n : ""); }).join(" · ") || undefined }, oneLine(nowModel, 24) || "—"),
                nowRung ? h(Tag, { ch: active ? "live" : undefined }, nowClimbed ? nowRung + " ▲" : nowRung) : null
              ),
          !active && ranked.length
            ? h("span", { className: "rk-cnote", "data-roko": "models-also" }, ranked.length > 1 ? "also " + ranked.slice(1, 3).map(function (m) { return oneLine(m.model, 20); }).join(", ") + (ranked.length > 3 ? " +" + (ranked.length - 3) : "") : plural(ranked[0].n, "task", "tasks"))
            : h(
            "span",
            { className: "rk-cnote", title: route ? [view.word, route.task_id ? str(route.task_id) : "", attempts > 1 ? "attempt " + attempts : "", str(route.provider)].filter(Boolean).join(" · ") : undefined },
            route
              ? h(
                  Fragment,
                  null,
                  h("span", { "data-ch": view.decider === "failover" ? "fail" : "live", "data-roko": "model-tag" }, view.word + (routeOdds(route, view) ? " · " + routeOdds(route, view) : "")),
                  route.task_id ? " · " + oneLine(str(route.task_id), 12) : "",
                  attempts > 1 ? " · attempt " + attempts : "",
                  route.provider ? " · " + oneLine(str(route.provider), 16) : ""
                )
              : nowTry
                ? oneLine(str(nowTask.task_id), 12) + " · attempt " + (isNum(nowTry.attempt) ? nowTry.attempt : 1) + (nowTry.provider ? " · " + oneLine(str(nowTry.provider), 16) : "")
                : models.length > 1
                  ? "+" + (models.length - 1) + " more"
                  : ""
          )
        ),
        active && !stale ? h(ToolScope, { run: run, active: true }) : h(ToolScope, { run: run, active: false, end: verdict })
      )
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
    return h(Dots, { value: value, size: props.size || "XL", pad: props.pad, ch: props.ch, label: (props.prefix || "") + value });
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
      h(Dots, { value: value, size: props.size || "L", ch: left > 60000 ? "you" : "fail", label: left > 0 ? "answer within " + value : "deadline passed" })
    );
  }


  /** The run as one instrument: a display bar of numbered readouts, with the scope or the verdict. */
  function RunHero(props) {
    const run = props.run;
    const tasks = list(run.tasks);
    const p = obj(run.progress) || obj(run.task_counts) || {};
    const active = isRunActive(run);
    // roko serve is down: the card is the last known state, so nothing on it blinks or ticks. Its clock stops when
    // roko last wrote (`last_event_at`), else when the overview last heard from roko.
    const stale = !!props.stale;
    const lastSeen = !stale ? NaN : isFinite(ms(run.last_event_at)) ? ms(run.last_event_at) : ms(run.checked_at || (overviewStore.get().data || {}).checked_at);
    const checking = active && !stale ? checkingOf(run, tasks) : null;
    const waits = runWaits(run) && !stale;
    const ch = stale ? "off" : runChannel(run, waits);
    return h(
      "header",
      { className: "roko-hero rk-hero", "data-roko": "hero", "data-ch": ch },
      h(
        "div",
        { className: "roko-hero-top" },
        h(LED, { ch: ch, blink: active && !stale ? undefined : false }),
        h("span", { className: "rk-state rk-stamp", "data-ch": waits ? "live" : ch, title: capStop(run) ? capStopWords(capStop(run)) : undefined }, stale ? "last seen running" : stampWord(run)),
        waits ? h("span", { className: "rk-tag rk-tag-you", "data-ch": "you", "data-roko": "hero-waiting" }, "◆ waiting on you") : null,
        // A plan writing that ended reads "plan written" (or "planning failed"); its "planning" badge was the work.
        run.kind === "plan_generate" && !active
          ? null
          : h("span", { className: "roko-kind" }, (KIND_LABEL[run.kind] || str(run.kind)) + (isNum(p.total) && p.total > 1 ? " · " + p.total + " tasks" : "")),
        h(ProjectTag, { run: run }),
        h("span", { className: "roko-hero-id roko-mono", title: str(run.run_id) }, shortId(run.run_id)),
        h(CopyButton, { value: run.run_id, what: "run id", compact: true }),
        h(
          "span",
          { className: "roko-hero-when roko-dim" },
          [(run.started_at || run.hermes_started_at) ? "started " + ago(run.started_at || run.hermes_started_at) : null,
           props.source === "ui" ? "from a Hermes page" : run.session_id ? "from a Hermes chat" : null].filter(Boolean).join(" · ")
        ),
        // The run this one resumed (0.6.0 `resumes`, dogfood U10).
        str(run.resumes) && props.onOpenRun
          ? h(
              "button",
              { type: "button", className: "roko-kind rk-kind-link", "data-roko": "resumes", title: "Open the run this one resumed", onClick: function () { props.onOpenRun(str(run.resumes)); } },
              "↻ resumes " + shortId(run.resumes)
            )
          : str(run.resumes) || run.resumed
            ? h("span", { className: "roko-kind" }, "resumed")
            : null,
        h("span", { className: "roko-flex" }),
        props.actions
      ),
      h("h2", { className: "roko-hero-title" }, str(run.label) || "(no label)"),
      // A resume: the plan's runs together, what they spent and where its tasks are (0.6.0 `chain`, dogfood U10).
      obj(run.chain) && list(run.chain.run_ids).length > 1
        ? h(
            "div",
            { className: "roko-headline rk-chain-line", "data-roko": "plan-chain" },
            "this plan over " + plural(list(run.chain.run_ids).length, "run", "runs") + ": ",
            [isNum(run.chain.cost_usd) ? money(run.chain.cost_usd) : "",
             obj(run.chain.progress) && isNum(run.chain.progress.total) && run.chain.progress.total ? (isNum(run.chain.progress.passed) ? run.chain.progress.passed : 0) + "/" + run.chain.progress.total + " tasks passed" : ""].filter(Boolean).join(" · ")
          )
        : null,
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
        : h(RunInstrument, { run: run, tasks: tasks, progress: p, active: active, stale: stale, waits: waits, ch: ch, lastSeen: lastSeen, checking: checking, moment: props.moment })
    );
  }

  // ---------------------------------------------------------------------------
  // The stream (spec v3 §4.5): what the agents do, as a phosphor log on the glass, newest at the bottom
  // ---------------------------------------------------------------------------

  /**
   * A timeline without the doubled tool steps of a trusted run (dogfood U5): roko writes the screened step ("read_file
   * synth/svf.py") and then the call's end ("read_file", no target) a moment later. The second goes.
   */
  function dedupeTools(events) {
    const last = {};
    return list(events).filter(function (e) {
      if (str(e.type) !== "agent_output" || !str(e.tool)) return true;
      const key = str(e.task_id) + "|" + str(e.tool);
      const prev = last[key];
      const ts = isNum(e.ts_millis) ? e.ts_millis : null;
      last[key] = { target: str(e.target), ts: ts };
      return !(prev && !str(e.target) && prev.target && (ts === null || prev.ts === null || Math.abs(ts - prev.ts) <= 3000));
    });
  }

  /** How often the stream speaks to a screen reader (spec v3 §8): one announcement every 2 s at most. */
  const SAY_EVERY_MS = 2000;

  /**
   * `words` for a screen reader at most once every SAY_EVERY_MS, the latest winning: a change after a quiet spell is
   * said at once and opens a window; what arrives in it waits, and only its newest is said when the window ends.
   */
  function useThrottledSay(words) {
    const [said, setSaid] = useState(words);
    const st = useRef({ timer: null, pending: null, last: words });
    useEffect(function () {
      const s = st.current;
      if (s.timer) {
        s.pending = words;
        return;
      }
      if (words === s.last) return;
      s.last = words;
      setSaid(words);
      function quiet() {
        s.timer = setTimeout(function () {
          s.timer = null;
          const next = s.pending;
          s.pending = null;
          if (next !== null && next !== s.last) {
            s.last = next;
            setSaid(next);
            quiet();
          }
        }, SAY_EVERY_MS);
      }
      quiet();
    }, [words]);
    useEffect(function () { return function () { clearTimeout(st.current.timer); }; }, []);
    return said;
  }

  /**
   * A stream row as a screen reader hears it, as it reads on screen: "T2 Read tally/cli.py", "T2 ✕ verify[0:test] did
   * not pass: AssertionError: 2 != 0", "T2 checking verify[0:test]: <its newest line>".
   */
  function sayRow(row) {
    const lines = list(row.lines);
    const tail = row.kind === "output" && lines.length
      ? ": " + oneLine(lines[lines.length - 1], 200)
      : row.detail ? (row.kind === "tool" ? " " : ": ") + oneLine(row.detail, 200) : "";
    return [oneLine(row.task, 16), oneLine(row.text, 200)].filter(Boolean).join(" ") + tail;
  }

  /** How many rows the stream keeps: 200 a task, 1 000 a run (a ring buffer). */
  const STREAM_PER_TASK = 200;
  const STREAM_PER_RUN = 1000;

  /**
   * The run's stream rows, oldest first: tool calls, checks (with the line that says why a failed one failed), route
   * decisions (a climb says from where and why), lessons, and what each task ended with, from the run's timeline;
   * between its lines, the live socket's tool calls and check output. Each row: {key, ts, task, kind, text, detail,
   * tone, lines}.
   */
  function streamRows(run, events, recent) {
    const tasks = {};
    list(run.tasks).filter(obj).forEach(function (t) { tasks[str(t.task_id)] = t; });
    function tryOf(taskId, attempt) {
      return list(tasks[taskId] && tasks[taskId].climb).filter(obj).filter(function (t) { return t.attempt === attempt; })[0] || null;
    }
    const rows = [];
    const seenTools = {};
    // The try each task is on as the timeline goes (its agent and route lines name it), and how many times each of
    // its checks failed so far: a failed check's key line is its own try's, not the first try that failed it.
    const tryNow = {};
    const failures = {};
    dedupeTools(events).forEach(function (e, i) {
      const type = str(e.type);
      const task = str(e.task_id);
      const ts = isNum(e.ts_millis) ? e.ts_millis : null;
      const key = "e" + (isNum(e.cursor) ? e.cursor : i);
      if (task && isNum(e.attempt) && (type === "agent_spawned" || type === "route_decided" || type === "agent_output")) tryNow[task] = e.attempt;
      if (type === "agent_output" && e.tool) {
        seenTools[task + "|" + str(e.tool) + "|" + str(e.target)] = true;
        rows.push({ key: key, ts: ts, task: task, kind: "tool", text: oneLine(e.tool, 40), detail: oneLine(e.target, 120) });
      } else if (type === "agent_output" && e.stopped === true) {
        // roko ended the try in the agent's place (a turn cap, its stream limit, the cap): roko's words, not the agent's.
        const said = str(e.text);
        rows.push({ key: key, ts: ts, task: task, kind: "stopped", text: "■ " + oneLine(task && said.indexOf(task + " ") === 0 ? said.slice(task.length + 1) : said, 200), tone: "fail" });
      } else if (type === "gate_result" && task) {
        const failed = e.passed === false;
        const gateName = str(e.gate);
        const n = failed ? (failures[task + "|" + gateName] || 0) + 1 : 0;
        if (failed) failures[task + "|" + gateName] = n;
        const tries = list(tasks[task] && tasks[task].climb).filter(obj);
        // The try the timeline is on; else (a timeline without agent lines) the n-th try that failed this check.
        const t = !failed
          ? null
          : task in tryNow
            ? tries.filter(function (x) { return x.attempt === tryNow[task] && str(x.failed_check) === gateName; })[0] || null
            : tries.filter(function (x) { return str(x.failed_check) === gateName; })[n - 1] || null;
        const gate = oneLine(e.gate || (GATE_RE.exec(str(e.text)) || [])[1], 40) || "a check";
        rows.push({
          key: key,
          ts: ts,
          task: task,
          kind: "check",
          text: (failed ? "✕ " : "✓ ") + gate + (failed ? " did not pass" : " passed"),
          detail: failed && t ? oneLine(str(t.key_line).replace(/[\r\n]+/g, " "), 200) : "",
          tone: failed ? "fail" : "pass",
        });
      } else if (type === "route_decided" && e.model) {
        const t = tryOf(task, e.attempt);
        // A failover try has two decisions: the pick roko passed over, then the model that ran (its loop says which).
        const passedOver = t && t.reason === "failover" && str(e.loop) !== "failover" && str(e.source) !== "failover";
        const reason = passedOver ? "pick" : t ? str(t.reason) : "";
        // The tries that did not pass on the rung it climbed from (the latest try before this one stood there).
        const earlier = reason === "climb" ? list(tasks[task] && tasks[task].climb).filter(function (x) { return obj(x) && x.attempt < e.attempt; }) : [];
        const from = earlier.length ? str(earlier[earlier.length - 1].rung) : "";
        const below = earlier.filter(function (x) { return x.outcome === "failed" && str(x.rung) === from && from !== str(t.rung); });
        const fo = t && obj(t.failover);
        rows.push({
          key: key,
          ts: ts,
          task: task,
          kind: "route",
          text:
            reason === "climb"
              ? "▲ up to " + str(t.rung) + " · " + oneLine(e.model, 30) + (below.length ? " · " + climbWhy(below) : "")
              : reason === "failover"
                ? "⇄ failover → " + oneLine(e.model, 30) + (fo && fo.why ? " · " + (oneLine(fo.model, 30) || "its pick") + " " + oneLine(fo.why, 60) : "")
                : reason === "pick"
                  ? "→ " + oneLine(e.model, 30)
                  : "→ " + oneLine(e.model, 30) + (t && t.rung ? " on " + str(t.rung) : "") + (isNum(e.attempt) && e.attempt > 1 ? " · try " + e.attempt : ""),
          tone: reason === "climb" ? "live" : reason === "failover" ? "fail" : null,
        });
        // The lessons roko put in that try's prompt (0.6.0 `lesson_ids`, from roko's prompt_assembled).
        const used = distinct(list(t && t.lesson_ids).map(str).filter(Boolean)).length;
        if (used && reason !== "pick") {
          rows.push({ key: key + "L", ts: (ts || 0) + 1, task: task, kind: "lesson", text: "◇ " + plural(used, "lesson", "lessons") + " in its prompt", tone: "learn" });
        }
      } else if (type === "knowledge_written") {
        rows.push({ key: key, ts: ts, task: task, kind: "lesson", text: "◇ " + oneLine(e.text, 140), tone: "learn" });
      } else if (type === "task_completed") {
        const state = nodeState(e.outcome);
        rows.push({ key: key, ts: ts, task: task, kind: "task", text: state === "passed" ? "✓ " + task + " passed" : task + " " + (oneLine(outcomeWord(e.outcome, state), 30) || "ended"), tone: state === "passed" ? "pass" : state === "failed" ? "fail" : null });
      } else if (type === "error" || e.group === "error") {
        rows.push({ key: key, ts: ts, task: task, kind: "error", text: oneLine(e.text, 200), tone: "fail" });
      }
    });

    // Between the timeline's lines: the socket's tool calls and check output.
    const blocks = {};
    list(recent).forEach(function (item, i) {
      const task = str(item.task_id);
      if (item.kind === "tool" && !seenTools[task + "|" + str(item.tool) + "|" + str(item.target)]) {
        rows.push({ key: "l" + item.ts + ":" + i, ts: item.ts, task: task, kind: "tool", text: oneLine(item.tool, 40), detail: oneLine(item.target, 120) });
      } else if (item.kind === "check" && (item.line || list(item.tail).length)) {
        // One block a try: a new try's check starts clean, not under the last try's lines.
        const id = task + "|" + str(item.gate) + "|" + (isNum(item.attempt) ? item.attempt : "");
        const block = blocks[id] || { key: "c" + task + ":" + str(item.gate) + ":" + (isNum(item.attempt) ? item.attempt : ""), ts: item.ts, task: task, kind: "output", text: "checking " + oneLine(item.gate, 40), lines: [], notes: [] };
        // An item that waited for the rate carries the lines before it (`tail`, the line included).
        block.lines = (list(item.tail).length ? list(item.tail).map(str) : block.lines.concat([str(item.line)])).slice(-8);
        // roko's own line ("… lines were not streamed"), as roko says it, never as the check's output.
        if (str(item.stream) === "roko" && item.line) block.notes = block.notes.concat([str(item.line)]);
        block.ts = item.ts;
        blocks[id] = block;
      }
    });
    // A page opened mid-check: what the running check printed so far (the card's `check_tail`), unless the socket's
    // lines of the same try (or of a try they do not number) already show it.
    Object.keys(tasks).forEach(function (id) {
      const tail = obj(tasks[id].check_tail);
      if (!tail || tail.passed != null || !list(tail.lines).length) return;
      const prefix = id + "|" + str(tail.gate) + "|";
      const shown = Object.keys(blocks).some(function (k) {
        if (k.indexOf(prefix) !== 0) return false;
        const a = k.slice(prefix.length);
        return a === "" || !isNum(tail.attempt) || a === String(tail.attempt);
      });
      if (shown) return;
      blocks[prefix + (isNum(tail.attempt) ? tail.attempt : "")] = {
        key: "c" + id + ":" + str(tail.gate) + ":" + (isNum(tail.attempt) ? tail.attempt : ""),
        ts: Date.now(),
        task: id,
        kind: "output",
        text: "checking " + oneLine(tail.gate, 40),
        lines: list(tail.lines).map(function (l) { return str(l).slice(0, 300); }).slice(-8),
        notes: [],
      };
    });
    Object.keys(blocks).forEach(function (id) { rows.push(blocks[id]); });

    const sorted = rows
      .filter(function (r) { return r.text || (r.lines && r.lines.length); })
      .map(function (r, i) { return { r: r, i: i }; })
      .sort(function (a, b) { return (a.r.ts || 0) - (b.r.ts || 0) || a.i - b.i; })
      .map(function (x) { return x.r; });
    // The ring buffer: the newest 200 a task, 1 000 a run.
    const perTask = {};
    return sorted
      .reverse()
      .filter(function (r) {
        perTask[r.task] = (perTask[r.task] || 0) + 1;
        return perTask[r.task] <= STREAM_PER_TASK;
      })
      .slice(0, STREAM_PER_RUN)
      .reverse();
  }

  /**
   * The stream (spec v3 §4.5): a phosphor log on the glass, newest at the bottom where the eye falls. Rows age from
   * bright to dim by their place from the newest (a failed check ages slowest); the newest words a task's agent said
   * sit at the bottom as a block with a rose rule and a cursor. It follows the newest row until the person scrolls
   * up, then a key brings it back. Filter: every task, or the one picked on the sequencer. In a replay, what had not
   * happened yet at the playhead waits, faint.
   */
  function Stream(props) {
    const run = props.run;
    const runId = str(run.run_id);
    const active = props.active;
    useLiveVersion(runId, ["live"]);
    const now = useTick(active);
    const [only, setOnly] = useState(null);
    const [pinned, setPinned] = useState(false);
    const box = useRef(null);
    const live = liveStore.live(runId);
    const recent = live ? list(live.recent) : [];
    const start = isFinite(props.start) ? props.start : ms(run.started_at || run.hermes_started_at);
    const all = streamRows(run, props.events, recent);
    const task = only && list(run.tasks).some(function (t) { return str(t.task_id) === only; }) ? only : null;
    const rows = task ? all.filter(function (r) { return r.task === task; }) : all;
    const replayT = isNum(props.replayT) ? props.replayT : null;
    let words = null;
    for (let i = recent.length - 1; i >= 0 && active; i -= 1) {
      const it = recent[i];
      if ((it.kind === "text" || it.kind === "reasoning") && (!task || str(it.task_id) === task) && (it.said || it.text)) {
        words = it;
        break;
      }
    }
    const toolsOnly = active && !words && recent.some(function (it) { return it.kind === "tool"; });
    // Words whose try is over (the task ended, or a newer try runs): "said", without the live cursor.
    const wordsTask = words ? list(run.tasks).filter(function (t) { return str(t.task_id) === str(words.task_id); })[0] : null;
    const past = !!words && (!wordsTask || wordsTask.outcome !== "running" || (isNum(words.attempt) && words.attempt < newestTry(wordsTask)));
    const pick = props.focus && str(props.focus) !== task ? str(props.focus) : null;
    const reduced = prefersReducedMotion();
    const shown = rows.slice(-60);
    const last = shown.length ? shown[shown.length - 1].key : "";
    // A screen reader hears the newest row, at most every 2 s (the log itself is quiet); nothing while a replay moves.
    const said = useThrottledSay(replayT !== null || !shown.length ? "" : sayRow(shown[shown.length - 1]));

    // Follow the newest row unless the person scrolled up.
    useEffect(function () {
      const el = box.current;
      if (el && !pinned) el.scrollTop = el.scrollHeight;
    }, [last, words && words.said, pinned]);

    return h(
      Glass,
      { className: "rk-stream", name: "stream" },
      h(
        "div",
        { className: "rk-stream-head" },
        h(ModLabel, { n: 7, right: replayT !== null ? "at this moment" : (task || "all tasks") + (active ? " · live" : "") }, "stream"),
        h(
          "span",
          { className: "rk-seg", role: "group", "aria-label": "Show" },
          h("button", { type: "button", "aria-pressed": task ? "false" : "true", onClick: function () { setOnly(null); } }, "ALL"),
          task ? h("button", { type: "button", "aria-pressed": "true", title: "Show every task", onClick: function () { setOnly(null); } }, oneLine(task, 8)) : null,
          pick ? h("button", { type: "button", "aria-pressed": "false", onClick: function () { setOnly(pick); } }, oneLine(pick, 8)) : null
        )
      ),
      h(
        "div",
        {
          ref: box,
          className: "rk-stream-lines",
          role: "log",
          "aria-live": "off",
          "aria-label": "What " + (task || "the run") + "'s agents do, newest last",
          "data-roko": "stream-lines",
          onScroll: function (event) {
            const el = event.currentTarget;
            setPinned(el.scrollHeight - el.scrollTop - el.clientHeight > 24);
          },
        },
        !shown.length && !words
          ? h("div", { className: "rk-stream-empty" }, active ? "roko's agents start here as soon as they move" : props.loaded === false ? "reading the run's timeline…" : "Nothing was recorded for this run.")
          : null,
        shown.map(function (row, i) {
          const fromEnd = shown.length - 1 - i;
          const future = replayT !== null && isNum(row.ts) && row.ts > replayT;
          // The phosphor chain, by place from the newest: bright, then ink, then down to dim. Failed checks hold.
          const opacity = future ? 0.16 : Math.max(row.tone === "fail" ? 0.72 : 0.42, 1 - fromEnd * 0.06);
          const fresh = !reduced && active && isNum(row.ts) && now - row.ts < 5000;
          const at = isNum(row.ts) && isFinite(start) ? stopwatch(Math.max(0, row.ts - start)) : "";
          return h(
            Fragment,
            { key: row.key },
            h(
              "div",
              { className: "rk-ln", "data-kind": row.kind, "data-tone": row.tone || undefined, "data-fresh": fresh ? "true" : undefined, "data-future": future ? "true" : undefined, style: { opacity: opacity } },
              h("span", { className: "rk-ln-t" }, at),
              h("span", { className: "rk-ln-k" }, oneLine(row.task, 5)),
              h("span", { className: "rk-ln-x" }, row.text, row.detail && row.kind === "tool" ? h("span", { className: "rk-ln-d" }, " " + row.detail) : null)
            ),
            row.detail && row.kind !== "tool"
              ? h("div", { className: "rk-ln rk-ln-sub", "data-tone": row.tone || undefined, style: { opacity: Math.min(1, opacity + 0.08) } }, h("span", { className: "rk-ln-x" }, row.detail))
              : null,
            row.lines && row.lines.length
              ? h(
                  "pre",
                  { className: "rk-ln-out", "data-roko": "stream-check", style: { opacity: opacity } },
                  // roko's own line ("… lines were not streamed") is roko speaking, dim, never the check's output.
                  row.lines.map(function (l, j) {
                    const last = j === row.lines.length - 1;
                    const note = list(row.notes).indexOf(l) >= 0;
                    return h("span", { key: j, className: [last ? "rk-ln-new" : "", note ? "rk-ln-note" : ""].filter(Boolean).join(" ") || undefined }, l + (last ? "" : "\n"));
                  })
                )
              : null
          );
        }),
        words
          ? h(
              "div",
              { className: "rk-words", "data-kind": words.kind, "data-roko": "stream-words", "data-past": past ? "true" : undefined },
              h("span", { className: "rk-words-who" }, oneLine(str(words.task_id), 6) + (words.kind === "reasoning" ? (past ? " thought" : " thinks") : past ? " said" : " says")),
              h("span", null, mdWords(oneLineEnd(words.said || words.text, 600), "words")),
              past ? null : h("span", { className: "rk-cursor", "aria-hidden": "true" })
            )
          : toolsOnly
            ? h("div", { className: "rk-stream-empty" }, "words arrive when the try ends")
            : null
      ),
      pinned ? h("button", { type: "button", className: "rk-stream-jump", onClick: function () { setPinned(false); } }, "jump to latest ↓") : null,
      h("div", { className: "rk-sr", role: "status", "aria-live": "polite", "data-roko": "stream-say" }, said)
    );
  }

  // ---------------------------------------------------------------------------
  // Ceremony (spec v3 §2.10, §6): the novelty store, the transition tiers, the end of a run, the Receipt
  // ---------------------------------------------------------------------------

  const NOVELTY_KEY = "roko-novelty";

  /**
   * How many times this workspace has seen each first (a run ended, a failed run, a climb, a lesson, a merge, a plan),
   * kept in this browser per roko serve, so the first plays as a Moment and the hundredth as a Gesture. Storage may
   * be off or full: the count then starts over each time, which only means more ceremony.
   */
  function noteNovelty(event) {
    const data = obj(overviewStore.get().data);
    const conn = data && obj(data.connection);
    const scope = (conn && str(conn.url)) || "roko";
    let all = {};
    try {
      all = JSON.parse(window.localStorage.getItem(NOVELTY_KEY) || "{}") || {};
    } catch (_) {
      all = {};
    }
    const seen = obj(all[scope]) || {};
    const count = (isNum(seen[event]) ? seen[event] : 0) + 1;
    all[scope] = Object.assign({}, seen);
    all[scope][event] = count;
    try {
      window.localStorage.setItem(NOVELTY_KEY, JSON.stringify(all));
    } catch (_) {
      // Firsts are a nicety.
    }
    return count;
  }

  /**
   * The tier an event plays at (bardo's novelty, spec v3 §6): its top tier the first time, one lower the 2nd to the
   * 5th, two lower (never below T1) up to the 20th, then T1 at most. T0 ambient … T4 cinematic.
   */
  function ceremonyTier(top, count) {
    if (count <= 1) return top;
    if (count <= 5) return Math.max(1, top - 1);
    return count <= 20 ? Math.max(1, top - 2) : Math.min(1, top);
  }

  /** The stamp a run's end declares, with its tone (spec v3 §4.7, §6), in the desktop's words. */
  function endStamp(run) {
    const stop = capStop(run);
    if (stop) return { tone: "you", word: str(stop.limit) === "day" ? "stopped at limit" : "stopped at cap" };
    return { cancelled: { tone: null, word: "cancelled" }, failed: { tone: "fail", word: "failed" }, interrupted: { tone: "you", word: "signal lost" }, succeeded: { tone: "pass", word: "passed" }, unverified: { tone: "you", word: "unverified" } }[str(run && run.state)] || null;
  }

  /**
   * The end of a run seen as it happens (spec v3 §6): a scanline sweeps the glass when it passed, its stamp holds for
   * a Moment, and the first run this workspace ever ended prints its receipt line by line (T4). Repeats go quieter.
   * {tier, stamp, at, first} while it plays, else null. With reduced motion only the stamp shows.
   */
  function useEndMoment(run) {
    const active = isRunActive(run);
    const was = useRef(active ? "active" : "ended");
    const [moment, setMoment] = useState(null);
    const state = run ? str(run.state) : "";
    useEffect(function () {
      const before = was.current;
      was.current = active ? "active" : "ended";
      if (active || before !== "active" || !run || run.kind === "plan_generate" || !endStamp(run)) return undefined;
      const tier = ceremonyTier(state === "succeeded" ? 4 : 3, noteNovelty("run_ended"));
      // The first failure this workspace sees types its why out (spec v3 §5.2); later ones just say it.
      const first = state === "failed" && !capStop(run) && noteNovelty("run_failed") <= 1;
      setMoment({ at: Date.now(), tier: tier, stamp: endStamp(run), first: first });
      const timer = setTimeout(function () { setMoment(null); }, tier >= 4 ? 3200 : 1200);
      return function () { clearTimeout(timer); };
    }, [state, active]);
    return moment;
  }

  /**
   * Text that types itself out once (the why of a failed run the first time, spec v3 §5.2), three characters every
   * 90 ms, with the rose cursor while it types. Screen readers get the whole text at once; with reduced motion so
   * does the eye.
   */
  function TypeOut(props) {
    const full = str(props.value);
    const [n, setN] = useState(prefersReducedMotion() ? full.length : 0);
    useEffect(function () {
      if (n >= full.length) return undefined;
      const timer = setTimeout(function () { setN(function (m) { return Math.min(full.length, m + 3); }); }, 90);
      return function () { clearTimeout(timer); };
    }, [n, full]);
    return h(
      Fragment,
      null,
      h("span", { className: "rk-sr" }, full),
      h("span", { "aria-hidden": "true", "data-roko": "type-out" }, full.slice(0, n), n < full.length ? h("span", { className: "rk-cursor" }) : null)
    );
  }

  /** A batch branch by its run's short id, as roko's headline says it: roko/batch/ddf4e5b1. */
  function shortBranch(branch) {
    return str(branch).replace(/\/([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "/$1");
  }

  /** "+287 −3 in 9 files": the backend's receipt counts, else the card's work and its delivery's diffstat. */
  function changesWords(run) {
    const receipt = obj(run.receipt);
    const counted = receipt && obj(receipt.changes);
    if (counted) {
      return [
        isNum(counted.additions) || isNum(counted.deletions) ? "+" + (isNum(counted.additions) ? counted.additions : 0) + " −" + (isNum(counted.deletions) ? counted.deletions : 0) : "",
        isNum(counted.files) && counted.files ? "in " + plural(counted.files, "file", "files") : "",
      ].filter(Boolean).join(" ");
    }
    const work = obj(run.work);
    const part = work ? list(work.parts).filter(obj)[0] : null;
    const counts = part && obj(part.counts);
    const delivered = obj(run.delivered);
    const stat = str(delivered && delivered.diffstat) || str(part && part.diffstat);
    function said(re) {
      const m = re.exec(stat);
      return m ? parseInt(m[1], 10) : null;
    }
    const add = counts && isNum(counts.additions) ? counts.additions : said(/(\d+) insertions?/);
    const del = counts && isNum(counts.deletions) ? counts.deletions : said(/(\d+) deletions?/);
    const files = counts && isNum(counts.files) ? counts.files : said(/(\d+) files? changed/) || list(delivered && delivered.files_changed).length;
    return [add !== null || del !== null ? "+" + (add || 0) + " −" + (del || 0) : "", files ? "in " + plural(files, "file", "files") : ""].filter(Boolean).join(" ");
  }

  /**
   * What the run's work would have cost on the ladder's top rung (≈, spec v3 §4.6, bardo's ShadowComparison). The
   * backend's `receipt` (0.6.0): the conservative counterfactual, each passed task's passing try at the top rung's list
   * prices, with the tasks it leaves out (`not_compared`); else, for an older backend, the card's tokens, failed tries
   * included. {backend, model, usd, ratio, basis, detail, notCompared}, `usd` null with the reason in `basis` when
   * there is no estimate; or null.
   */
  function topRungCost(run) {
    const receipt = obj(run.receipt);
    const rungs = list(run.ladder).filter(obj);
    const ladderTop = rungs.length ? rungs[rungs.length - 1] : null;
    if (receipt && "top_rung_usd" in receipt) {
      const top = obj(receipt.top_rung) || ladderTop;
      const model = top ? str(top.slug) || str(top.model) || str(top.rung) : "";
      if (!model) return null;
      const usd = isNum(receipt.top_rung_usd) ? receipt.top_rung_usd : null;
      return {
        backend: true,
        model: model,
        usd: usd,
        ratio: isNum(receipt.ratio) ? receipt.ratio : null,
        basis: str(receipt.basis) || (usd === null ? "" : "≈ the top rung's list prices"),
        detail: str(receipt.basis_detail),
        notCompared: isNum(receipt.not_compared) ? receipt.not_compared : 0,
      };
    }
    const tokens = obj(run.tokens);
    if (!ladderTop || !tokens || !isNum(ladderTop.price_in) || !isNum(ladderTop.price_out)) return null;
    const cacheRead = isNum(ladderTop.price_cache_read) ? ladderTop.price_cache_read : ladderTop.price_in * 0.1;
    const usd = ((tokens.input || 0) * ladderTop.price_in + (tokens.output || 0) * ladderTop.price_out + (tokens.cache_read || 0) * cacheRead) / 1e6;
    return usd > 0
      ? {
          backend: false,
          model: str(ladderTop.slug) || str(ladderTop.model),
          usd: usd,
          ratio: null,
          basis: "≈ from run totals, failed tries included",
          detail: "the run's tokens at the top rung's list prices; a stronger model might use fewer",
          notCompared: 0,
        }
      : null;
  }

  /**
   * The top rung's ≈ against what the run cost, in words (spec v3 §4.6): 1.25 or more "this cost 8× less" (one decimal
   * below 10), 0.8 to 1.25 "about the same", below 0.8 "the climb cost more this time" (information, not an alarm).
   */
  function timesWords(times) {
    function n(v) { return v >= 10 ? String(Math.round(v)) : String(Number(v.toFixed(1))); }
    return times >= 1.25 ? "this cost " + n(times) + "× less" : times >= 0.8 ? "about the same" : "the climb cost more this time";
  }

  /** The Receipt's lines: [key, value, title, tone, name], or ["rule"]; a line with no key carries its name. */
  function receiptLines(run) {
    const receipt = obj(run.receipt);
    const laid = ladderRows(run);
    const lines = [];
    if (laid) {
      const rows = laid.rows.slice().reverse();
      // A task that climbed is said once, as a climb; the others by the rung they passed on; then the ones that did
      // not pass, where they stopped. "Nothing above" only when the run passed below a rung it could still have used.
      function ids(ts) { return ts.length > 2 ? ts.length + " tasks" : ts.map(function (t) { return t.id; }).join(", "); }
      const passedOn = [];
      const climbedTo = [];
      const failedOn = [];
      const stoppedOn = [];
      rows.forEach(function (r) {
        const rung = str(r.rung.rung);
        const passed = r.tokens.filter(function (t) { return t.state === "passed" && !t.climbed; }).length;
        const climbed = r.tokens.filter(function (t) { return t.state === "passed" && t.climbed; }).length;
        const failed = r.tokens.filter(function (t) { return t.state === "failed"; });
        // Stopped only counts a task that had tries: one the run never started stopped nowhere.
        const stopped = r.tokens.filter(function (t) {
          return t.state === "stopped" && list(run.tasks).some(function (task) { return obj(task) && str(task.task_id) === t.id && list(task.climb).length; });
        });
        if (passed) passedOn.push(passed + " passed on " + rung);
        if (climbed) climbedTo.push(climbed + " climbed to " + rung);
        if (failed.length) failedOn.push(ids(failed) + " failed on " + rung + (failed.some(function (t) { return t.exhausted; }) ? ", the ladder's last rung for it" : ""));
        if (stopped.length) stoppedOn.push(ids(stopped) + " stopped on " + rung);
      });
      const words = passedOn.concat(climbedTo, failedOn, stoppedOn);
      let usable = -1;
      let highest = -1;
      rows.forEach(function (r, i) {
        if (r.rung.chat_ok !== false) usable = i;
        if (r.tokens.some(function (t) { return t.state !== "waiting"; })) highest = i;
      });
      const head = passedOn.length || climbedTo.length ? [] : ["no task passed"];
      const tail = run.state === "succeeded" && highest >= 0 && highest < usable ? ["nothing above"] : [];
      lines.push(["ladder", head.concat(words, tail).join(" · "), null, null]);
    } else {
      const models = modelsOf(list(run.tasks));
      if (models.length) lines.push(["models", models.slice(0, 3).map(function (m) { return m.model; }).join(" · "), null, null]);
    }

    // The top-rung comparison (Q1): the backend's prices only the passing tries, so it stands for any run that ended,
    // with the tasks it leaves out counted; worked out here from a run's totals, only for a run that passed. Without a
    // figure, the backend's words alone; with one, its basis in full on a line of its own, not only in a hover.
    const top = topRungCost(run);
    if (top && (top.backend ? !isRunActive(run) : run.state === "succeeded")) {
      if (top.usd === null) {
        lines.push(["top rung", top.basis || top.model + ": no estimate", top.detail || null, "dim"]);
      } else {
        const times = isNum(top.ratio) ? top.ratio : isNum(run.cost_usd) && run.cost_usd > 0 ? top.usd / run.cost_usd : null;
        lines.push([
          "top rung",
          h(
            Fragment,
            null,
            "≈ " + money(top.usd) + " on " + top.model,
            times !== null ? h("span", { className: times >= 1.25 ? "rk-receipt-good" : undefined }, " · " + timesWords(times)) : null
          ),
          top.detail || null,
          null,
        ]);
        // The backend's basis starts with "≈" already ("≈ the 5 passing tries' tokens at …").
        lines.push(["", "≈ " + top.basis.replace(/^≈\s*/, ""), top.detail || null, "basis", "basis"]);
      }
      if (top.notCompared > 0) {
        lines.push(["", plural(top.notCompared, "task", "tasks") + " didn't pass: not compared", null, "basis", "not-compared"]);
      }
    }

    lines.push(["rule"]);

    const counted = receipt && obj(receipt.changes);
    const work = obj(run.work);
    const delivered = obj(run.delivered);
    const changes = changesWords(run);
    const branch = str(counted && counted.branch) || str(delivered && delivered.branch) || str(work && list(work.parts).filter(obj).map(function (p) { return p.branch; }).filter(Boolean)[0]);
    const kind = str(counted && counted.kind) || str(work && work.kind);
    const nothing = kind === "none" || (counted && !counted.files && !counted.additions && !counted.deletions);
    if (nothing) {
      lines.push(["changes", "no changes", null, null]);
    } else if (changes || branch) {
      const trust = kind === "unverified" ? "unverified: no check ran" : kind === "partial" ? "partly verified" : (counted && counted.merged) || (delivered && delivered.merged) ? "merged" : "verified";
      lines.push(["changes", [changes, branch ? oneLine(shortBranch(branch), 40) : "", trust].filter(Boolean).join(" · "), branch || null, kind === "unverified" ? "you" : null]);
    } else {
      lines.push(["changes", delivered ? "—" : "no changes", null, null]);
    }

    const lessons = [];
    list(run.tasks).filter(obj).forEach(function (t) { list(t.lessons).filter(obj).forEach(function (l) { lessons.push(l); }); });
    const kept = receipt && isNum(receipt.lessons_kept) ? receipt.lessons_kept : lessons.filter(function (l) { return /admitted/.test(str(l.admission)); }).length;
    const confirmed = receipt && isNum(receipt.lessons_confirmed) ? receipt.lessons_confirmed : lessons.reduce(function (n, l) { return n + (isNum(l.reinforced) ? l.reinforced : 0); }, 0);
    const used = receipt && isNum(receipt.lessons_used) ? receipt.lessons_used : 0;
    if (kept || confirmed || used) {
      const parts = [kept ? "kept " + plural(kept, "lesson", "lessons") : "", confirmed ? "confirmed " + confirmed + " it had" : "", used ? plural(used, "lesson", "lessons") + " in its prompts" : ""].filter(Boolean);
      lines.push(["learned", "◇ " + parts.join(" · "), null, "learn"]);
    }
    return lines;
  }

  /**
   * The Receipt (spec v3 §4.6): a strip of mono lines, as a teenage engineering device prints them: where on the
   * ladder the work passed, what the same work would have cost on the top rung (≈), what changed, what roko
   * learned. Demo output says it stays on its branch; unverified work says no check ran, in orange, never green.
   * `print` types it out a line every 500 ms (the first run a workspace ever ends). Its key opens the changes, unless
   * the run's head already offers the next step there.
   */
  function Receipt(props) {
    const run = props.run;
    const lines = receiptLines(run);
    const [shown, setShown] = useState(props.print && !prefersReducedMotion() ? 0 : 99);
    useEffect(function () {
      if (shown >= lines.length) return undefined;
      const timer = setTimeout(function () { setShown(function (n) { return n + 1; }); }, 500);
      return function () { clearTimeout(timer); };
    }, [shown, lines.length]);
    const demo = run.demo === true || (obj(run.merge) && run.merge.demo === true) || props.demo === true;
    const hasChanges = !!obj(run.delivered) || list(obj(run.work) && run.work.parts).length > 0;
    const keys = props.compact
      ? null
      : h(
          "div",
          { className: "rk-receipt-keys" },
          demo ? h("span", { className: "rk-receipt-note" }, "demo output: stays on its branch") : null,
          hasChanges && props.onView && !props.reviewInHead ? h(Key, { size: "s", name: "receipt-review", onClick: function () { props.onView("changes"); } }, "review changes") : null
        );
    return h(
      Glass,
      { className: "rk-receipt" + (props.compact ? " is-compact" : ""), name: "receipt", role: "group", label: "the run's receipt" },
      h(
        "div",
        { className: "rk-receipt-lines" },
        lines.slice(0, shown).map(function (line, i) {
          return line[0] === "rule"
            ? h("div", { key: "rule" + i, className: "rk-receipt-rule", "aria-hidden": "true" })
            : h(
                "div",
                { key: line[4] || line[0], className: "rk-receipt-line", "data-tone": line[3] || undefined, "data-roko": "receipt-" + (line[4] || line[0].replace(/ /g, "-")), title: line[2] || undefined },
                h("span", { className: "rk-receipt-k" }, line[0]),
                h("span", { className: "rk-receipt-v" }, line[1])
              );
        })
      ),
      props.compact && demo ? h("span", { className: "rk-receipt-note" }, "demo output: stays on its branch") : null,
      keys
    );
  }

  // ---------------------------------------------------------------------------
  // One run: the instrument, the horizon, why, waiting, and Overview · Activity · Loops · Changes
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
    const moment = useEndMoment(run);
    // The first failure's why types out once, and stays typed (the moment itself ends after a beat).
    const [typed, setTyped] = useState(false);
    useEffect(function () { if (moment && moment.first) setTyped(true); }, [moment && moment.at]);
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
        h(RunHero, { run: run, actions: actions, source: props.source, onOpenRun: props.onOpenRun }),
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
        // The GUT (spec v3 §5.2): the sequencer, and the stream beside it once the run view is wide enough.
        h(
          "div",
          { className: "roko-overview-graph rk-gut" },
          h(
            "div",
            { className: "rk-gut-seq" },
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
              : null
          ),
          h(Stream, { run: run, events: evs, loaded: events.loaded, start: startMs, active: active && !stale, replayT: replay ? replayT : null, focus: current })
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
      h(RunHero, { run: run, actions: actions, source: props.source, stale: stale, moment: moment, onOpenRun: props.onOpenRun }),
      // With roko down the header and the setup module say so once; the card's failed refresh adds nothing.
      card.state.error && !stale ? h(ErrorNote, { error: card.state.error, compact: true, onRetry: card.reload }) : null,
      active && !stale ? h(NowStrip, { run: run, tasks: tasks, held: heldTasks, onSelect: function (id) { setSelected(id); setTab("overview"); } }) : null,
      // Once it ended, the receipt (spec v3 §4.6); the first run a workspace ever ends prints it line by line.
      ended && run.state !== "missing"
        ? h(Receipt, {
            key: moment && moment.tier >= 4 ? "print" + moment.at : "receipt",
            run: run,
            demo: demo === true,
            print: !!(moment && moment.tier >= 4),
            onView: setTab,
            reviewInHead: !!(next && (next.action === "merge" || next.action === "review" || next.action === "commit-roko-toml")),
          })
        : null,
      h(WhyCallout, { run: run, typeOut: typed, onSelect: function (id) { setSelected(id); setTab("overview"); } }),
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
        const ch = st === "delivered" ? "pass" : st === "delivering" ? "live" : st === "cancelled" ? "off" : "fail";
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
      // The glass says the planner is at work in dot-matrix (spec v3 §5.5), as the desktop's PlanGenView.
      return h(
        "div",
        { className: "roko-planning rk-plangen", "data-roko": "planning" },
        h(
          "div",
          { className: "rk-plangen-top" },
          h(Well, { className: "rk-plangen-well" }, h(LED, { ch: "live" }), h(Dots, { value: "PLANNING", size: "M", ch: "live", label: "planning" })),
          h(
            "div",
            { className: "rk-plangen-words" },
            h(
              "div",
              { className: "roko-planning-title" },
              w ? h("span", { "data-roko": "writing-line" }, writingWords(w)) : "roko's planner is writing the plan",
              isFinite(since) ? h(Ticker, { since: since, className: "roko-planning-clock", prefix: " · " }) : null,
              w && isNum(w.cost_usd) ? h("span", { className: "roko-planning-clock" }, " · " + money(w.cost_usd)) : null,
              w && str(w.model) ? h("span", { className: "roko-dim" }, " · " + oneLine(w.model, 40)) : null
            ),
            h("div", { className: "roko-dim" }, "It splits the request into small tasks, each with its own checks, in waves that can run in parallel. Nothing runs until you start the plan.")
          )
        ),
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
        last ? h("div", { className: "roko-dim roko-planning-last", "data-roko": "writing-last" }, "how far it got: " + (oneLine(last.text, 400) || writingWords(last) + (isNum(last.cost_usd) ? " · " + money(last.cost_usd) : ""))) : null,
        h(SourceChecks, { sc: run.source_checks })
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
      h(SourceChecks, { sc: run.source_checks }),
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

  /**
   * The coverage line of what became of the checks a request's spec states (0.6.0 `source_checks`): "Your spec states
   * 8 checks · 8 kept", or "5 of 8 kept · 1 cannot run · 1 shallow · 1 missing" (no 0 count), and "asked again" when
   * the planner was asked once more for the missing ones. The wording the lead settled, the desktop's too.
   */
  function sourceChecksLine(sc) {
    const total = isNum(sc.total) ? sc.total : 0;
    const kept = isNum(sc.kept) ? sc.kept : 0;
    const parts = kept === total ? ["Your spec states " + plural(total, "check", "checks"), kept + " kept"] : [kept + " of " + total + " kept"];
    [["cannot_run", "cannot run"], ["shallow", "shallow"], ["dropped", "dropped"], ["missing", "missing"]].forEach(function (k) {
      if (isNum(sc[k[0]]) && sc[k[0]] > 0) parts.push(sc[k[0]] + " " + k[1]);
    });
    if (sc.regenerated === true) parts.push("asked again");
    return parts.join(" · ");
  }

  /**
   * What became of each check the request's spec states (0.6.0 `source_checks`, roko's planner's own report, roko
   * 75a1a08bf): kept (a verify step proves it), cannot run (a step covers it but cannot pass as written, with why, in
   * orange outline; roko gap-ecafde), shallow (only a grep, a file test or a build covers it: its one command), dropped
   * (with the plan's reason) or missing (neither: the plan may not prove it, in orange). Folded while every check was
   * kept, open when one is missing or cannot run; nothing from an older roko. All of it is text.
   */
  function SourceChecks(props) {
    const sc = obj(props.sc);
    if (!sc || !isNum(sc.total) || sc.total <= 0) return null;
    const checks = list(sc.checks).filter(function (c) { return obj(c) && str(c.id); });
    const missing = (isNum(sc.missing) && sc.missing > 0) || (isNum(sc.cannot_run) && sc.cannot_run > 0);
    return h(
      "details",
      { className: "rk-srcchecks", "data-roko": "source-checks", open: missing ? true : undefined },
      h("summary", null, h("span", { className: "rk-srcchecks-line", "data-roko": "source-checks-line", "data-missing": missing ? "true" : undefined }, sourceChecksLine(sc))),
      checks.length
        ? h(
            "ul",
            { className: "rk-srcchecks-list" },
            checks.slice(0, 40).map(function (c, i) {
              const status = str(c.status);
              return h(
                "li",
                { key: i, "data-status": status },
                h("span", { className: "rk-srcchecks-id" }, oneLine(c.id, 10)),
                h("span", { className: "rk-srcchecks-st", "data-status": status }, status === "cannot_run" ? "cannot run" : ["kept", "shallow", "dropped", "missing"].indexOf(status) >= 0 ? status : oneLine(status, 12) || "?"),
                h("span", { className: "rk-srcchecks-what", title: oneLine(c.check, 300) || undefined }, oneLine(c.check, 300)),
                str(c.task) || str(c.criterion) ? h("span", { className: "rk-srcchecks-where" }, [oneLine(c.task, 16), oneLine(c.criterion, 16)].filter(Boolean).join(" ")) : null,
                str(c.reason) ? h("span", { className: "rk-srcchecks-why" }, (status === "shallow" ? "only: " : "why: ") + oneLine(c.reason, 200)) : null
              );
            })
          )
        : null
    );
  }

  /** The run id of the newest plan writing (`plan_generate`) that wrote plan `planId`, from the overview's runs; or null. */
  function newestPlanWriting(data, planId) {
    let best = null;
    list(data && data.runs).forEach(function (r) {
      if (!obj(r) || r.kind !== "plan_generate" || !str(r.run_id) || str(r.plan_id) !== str(planId)) return;
      if (!best || (ms(r.started_at) || 0) > (ms(best.started_at) || 0)) best = r;
    });
    return best ? str(best.run_id) : null;
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
        { index: "06", label: "LOOPS", className: "rk-dialmod", right: live ? h("span", { className: "rk-live" }, h(LED, { ch: "live" }), "live") : h("span", { className: "roko-dim" }, "the run, start to end") },
        // The orrery on one clock: the run's own span, ending now while it goes and at its last event once it ended.
        h(
          "div",
          { className: "rk-dialwrap" },
          h(Glass, { className: "rk-orrery-glass" }, h(Orrery, { events: events, now: live ? now : newest, span: Math.max(60000, (live ? now : newest) - (events.length ? events[0].ts : 0)), size: 236 })),
          h(DialLegend, { events: events, live: live })
        )
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
      // A loop whose learning is in use: roko changed itself (indigo, spec v3 §2.2).
      st === "live" || st === "healthy" ? "learn"
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
          h(LED, { ch: liveState.status === "open" ? "live" : liveState.status === "down" ? "fail" : "off", blink: liveState.status === "open" && live ? undefined : false }),
          liveState.status === "open" ? "live" : liveState.status === "unsupported" ? "polling" : liveState.status === "down" ? "reconnecting" : "connecting"
        )
      ),
      h(
        "div",
        { className: "rk-loopsection-grid" },
        h(
          Module,
          { index: "06", label: "LOOPS", className: "rk-dialmod rk-dialmod--big" },
          h("div", { className: "rk-dialwrap" }, h(Glass, { className: "rk-orrery-glass" }, h(Orrery, { events: events, now: now, size: 300 })), h(DialLegend, { events: events, live: live, states: states }))
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
              h(Well, { className: "rk-count" }, h(Dots, { value: String(isNum(counts.held) ? counts.held : 0), size: "L", ch: counts.held ? "you" : undefined, label: (counts.held || 0) + " held" }), h("span", null, "held")),
              h(Well, { className: "rk-count" }, h(Dots, { value: String(isNum(counts.withheld) ? counts.withheld : 0), size: "L", ch: counts.withheld ? "fail" : undefined, label: (counts.withheld || 0) + " withheld" }), h("span", null, "withheld"))
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
                    // The backend's shape (insights.diagnoses): who, about what, what it found; as the desktop says it
                    // (dogfood U7: who in words, never roko's raw source id).
                    const said = [oneLine(str(d.who) || diagnosisSource(d.source), 24), oneLine(d.subject, 24), oneLine(d.detail, 90)].filter(Boolean).join(" · ") || oneLine(d.summary || d.text || d.kind, 140);
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
              h(Well, { className: "rk-count" }, h(Dots, { value: String(isNum(knowledge.total) ? knowledge.total : 0), size: "L", ch: "learn", label: (knowledge.total || 0) + " lessons kept" }), h("span", null, "lessons")),
              h(Well, { className: "rk-count" }, h(Dots, { value: String(isNum(playbooks.total) ? playbooks.total : 0), size: "L", label: (playbooks.total || 0) + " playbooks" }), h("span", null, "playbooks"))
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
                      // roko counts a model's tries (0.6.0 `attempts`), not tasks (dogfood U6).
                      h("span", { className: "roko-dim" }, (function () {
                        const n = isNum(m.attempts) ? m.attempts : isNum(m.tasks) ? m.tasks : null;
                        const of = n === null ? "" : plural(n, "try", "tries");
                        return rate === null ? of : "passes " + pct(rate) + (of ? " of " + of : "");
                      })())
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
                    h(ProjectTag, { run: run }),
                    // Where its tasks stand on the model ladder (0.6.0 `rungs`): the mini ladder, else the task strip.
                    list(run.rungs).length
                      ? h(MiniLadder, { rungs: run.rungs })
                      : progress && progress.total
                        ? h(StepStrip, { progress: progress, waiting: waits })
                        : run.kind === "plan_generate" && !isRunActive(run)
                          ? null
                          : h("span", { className: "roko-kind" }, KIND_LABEL[run.kind] || str(run.kind)),
                    obj(run.chain) && list(run.chain.run_ids).length > 1
                      ? h("span", { className: "rk-chainmark", title: "the plan's " + list(run.chain.run_ids).length + " runs together" }, "↻ plan " + money(run.chain.cost_usd))
                      : null,
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

  /**
   * What roko expects a request to cost and how similar runs went (0.6.0 P7 `GET /estimate`), asked again 600 ms after
   * the person stops typing; the last answer stays while the next loads. null from an older backend. It sends the
   * request's length, never its words: a URL ends up in logs and history (Q5).
   */
  function useEstimate(prompt, domain, enabled) {
    const [q, setQ] = useState(str(prompt).trim());
    useEffect(function () {
      const timer = setTimeout(function () { setQ(str(prompt).trim()); }, 600);
      return function () { clearTimeout(timer); };
    }, [prompt]);
    const res = useResource(enabled ? "/estimate?chars=" + q.length + "&domain=" + enc(domain) : null, 0);
    const answer = res.data && obj(res.data.estimate) ? res.data.estimate : null;
    const last = useRef(null);
    if (answer) last.current = answer;
    return enabled ? answer || last.current : null;
  }

  /** How long a likely run takes, in words. */
  function aboutSecs(secs) {
    return !isNum(secs) ? "" : secs < 45 ? "under a minute" : secs < 90 ? "about a minute" : "about " + Math.round(secs / 60) + " minutes";
  }

  /**
   * Where a new request starts (spec v3 §5.7, mockup 04's glass panel): the workspace's ladder with its prices, top
   * rung first, the start rung marked ▸; what roko expects it to cost (≈, from history), how far it may climb before
   * the cap stops it, how similar tasks went, and the checks roko found. The ladder and the rule come from roko.toml;
   * the rest only when the backend estimates (P7). The desktop's WhereItStarts.
   */
  function WhereItStarts(props) {
    const e = obj(props.estimate);
    const rungs = list(e && list(e.ladder).length ? e.ladder : props.ladder).filter(function (r) { return obj(r) && str(r.rung); });
    if (!rungs.length) return null;
    const names = rungs.map(function (r) { return str(r.rung); });
    const named = e && str(e.start_rung) ? names.indexOf(str(e.start_rung)) : -1;
    const usable = rungs.filter(function (r) { return r.chat_ok !== false; });
    const start = named >= 0 ? rungs[named] : usable[0] || null;
    const at = start ? rungs.indexOf(start) : -1;
    // How far it may climb: roko's `climb` when it estimates, else the two usable rungs above the start.
    const climb = list(e && e.climb).map(str).filter(Boolean);
    const above = start ? rungs.slice(at + 1).filter(function (r) { return r.chat_ok !== false; }) : [];
    const highest = climb.length ? (climb.length > 1 ? climb[climb.length - 1] : "") : above.length ? str(above[Math.min(1, above.length - 1)].rung) : "";
    const likely = e ? obj(e.likely) : null;
    const usd = likely && isNum(likely.usd) ? likely.usd : null;
    const secs = likely && isNum(likely.seconds) ? likely.seconds : null;
    const worst = e && isNum(e.worst_usd) ? e.worst_usd : null;
    const cap = isNum(props.cap) && props.cap > 0 ? props.cap : null;
    const similar = e ? obj(e.similar) : null;
    const tasks = similar && isNum(similar.tasks) ? similar.tasks : 0;
    const rate = similar ? (isNum(similar.first_try_rate) ? similar.first_try_rate : tasks && isNum(similar.first_try) ? similar.first_try / tasks : null) : null;
    // null: the backend could not read roko.toml (say nothing); []: roko runs no check, so the run ends unverified.
    const checks = e && Array.isArray(e.checks) ? e.checks.filter(obj) : null;
    const basis = [str(e && e.basis), e && str(e.confidence) === "low" && usd !== null ? "low confidence" : ""].filter(Boolean).join(" · ");
    return h(
      Glass,
      { className: "rk-where", grid: true, name: "where-it-starts", label: "where it starts" },
      h(ModLabel, { n: 5, right: "the ladder in roko.toml · cheapest first" }, "where it starts"),
      h(
        "div",
        { className: "rk-where-body" },
        h(
          "ul",
          { className: "rk-where-rungs", "aria-label": "The model ladder, top rung first" },
          rungs.slice().reverse().map(function (r) {
            const here = r === start;
            return h(
              "li",
              { key: str(r.rung), className: "rk-where-rung", "data-start": here ? "true" : undefined, "data-off": r.chat_ok === false ? "true" : undefined },
              h("span", { className: "rk-rung-r" }, here ? "▸ " : "", str(r.rung)),
              h("span", { className: "rk-where-m" }, str(r.slug) || str(r.model)),
              h("span", { className: "rk-rung-p", title: r.chat_ok === false ? str(r.why_not) || undefined : priceSource(r) }, r.chat_ok === false ? "not for chat runs" : rungPrice(r))
            );
          })
        ),
        h(
          "div",
          { className: "rk-where-side" },
          usd !== null
            ? h(
                "div",
                { className: "rk-where-likely", "data-roko": "starts-likely" },
                h("span", { className: "rk-where-k" }, "likely ≈"),
                h(Dots, { value: boneMoney(usd), size: "M", ch: "ink", label: "likely about " + money(usd) }),
                h("span", null, [aboutSecs(secs), start ? str(start.rung) + " rung" : ""].filter(Boolean).join(" · "))
              )
            : null,
          basis ? h("p", { className: "rk-where-basis", "data-roko": "starts-basis" }, basis) : null,
          h(
            "p",
            { className: "rk-where-words", "data-roko": "starts-rule" },
            !start
              ? "No rung of this ladder runs work started from Hermes."
              : checks && !checks.length
                ? "roko found no check to run, so it never climbs: the run ends unverified."
                : highest
                  ? "2 failed tries → a rung up, at most to " + highest + "."
                  : "It stays on its rung: no rung above it can run work from a chat.",
            start && cap !== null
              ? h(
                  "span",
                  { className: "rk-where-cap" },
                  worst !== null && worst < cap - 1e-9
                    ? " At worst ≈ " + money(worst) + ", under the " + money(cap) + " cap."
                    : " The " + money(cap) + " cap stops it before it spends past it."
                )
              : null
          ),
          tasks
            ? h(
                "p",
                { className: "rk-where-similar", "data-roko": "starts-similar" },
                plural(tasks, "similar task", "similar tasks") + ": ",
                rate !== null ? h("b", null, pct(rate) + " passed on the first try") : "none said yet",
                isNum(similar.climbed) && similar.climbed ? ", " + similar.climbed + " climbed." : "."
              )
            : null,
          checks && checks.length
            ? h(
                "ul",
                { className: "rk-where-checks", "aria-label": "The checks roko will run", "data-roko": "starts-checks" },
                checks.slice(0, 3).map(function (c, i) {
                  return h(
                    "li",
                    { key: i, title: str(c.name) || undefined },
                    h("i", { "aria-hidden": "true" }),
                    h("b", null, oneLine(str(c.phase) || str(c.name), 16)),
                    h("span", null, oneLine(c.command, 60)),
                    str(c.source) ? h("small", null, oneLine(c.source, 24)) : null
                  );
                }),
                checks.length > 3 ? h("li", { className: "rk-where-more" }, "and " + plural(checks.length - 3, "more check", "more checks")) : null
              )
            : null
        )
      )
    );
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
    // 0.7: which project the run is for. Picking one switches the page too, so its plans, ladder and setup match.
    const projects = projectsOf(data);
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
    const estimate = useEstimate(prompt, domain, !!props.open && !planSource && mode === "run");
    const p90 = estimate && obj(estimate.similar) && isNum(estimate.similar.p90_usd) ? estimate.similar.p90_usd : null;
    // A run's cap starts at the smallest detent at or above what 9 in 10 similar runs cost (P7 `similar.p90_usd`),
    // until the person turns the knob.
    useEffect(function () {
      if (!props.open || planSource || mode !== "run" || p90 === null || capTouched) return;
      const detent = CAP_PRESETS.filter(function (c) { return c >= p90 - 1e-9 && (ceiling === null || c <= ceiling + 1e-9); })[0];
      if (isNum(detent)) setCap(detent);
    }, [props.open, planSource, mode, p90, capTouched]);

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
        const payload = Object.assign({ max_usd: Math.round(capValue * 100) / 100, resume: resume }, projectBody());
        if (title.trim()) payload.title = title.trim();
        apiPost("/plans/" + enc(pickedId) + "/run", payload).then(function (res) {
          done(res, "Started run of " + (picked ? oneLine(picked.title || picked.id, 60) : pickedId) + ": ");
          // roko will not run the plan as it is: read it again, so the device says why and start stays off.
          if (!res.ok && res.error.validation) detailRes.reload();
        });
        return;
      }
      const body = Object.assign({ prompt: prompt.trim() }, projectBody());
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
                        isStartHere(p, known) ? h(Tag, { ch: "you" }, "start here") : null,
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
        ),
        mode === "run" ? h(WhereItStarts, { ladder: data ? data.ladder : null, cap: capOk && isNum(capValue) ? capValue : null, estimate: estimate }) : null
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
            limits.today !== null ? spendWords(limits.spend) + (limits.maxDay !== null ? " · limit " + money(limits.maxDay) + " a day" : "") : null,
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
              : planSource ? "run plan" + (capOk && isNum(capValue) ? " · cap " + money(capValue) : "") : writesPlan ? "write the plan" : "start" + (capOk && isNum(capValue) ? " · cap " + money(capValue) : ""),
            onClick: submit,
          })
        ),
      },
      h(
        "div",
        { className: "roko-composer rk-device" + (planSource ? " is-planrun" : "") },
        projects.current || projects.none ? h(ProjectModule, { projects: projects }) : null,
        device,
        h(FixDoneNote, { problems: setup.problems }),
        // The page's status is behind the dialog: the serve's changes are said here too (starting, then running).
        h("span", { className: "rk-sr", role: "status", "aria-live": "polite", "data-roko": "composer-serve-said" }, serveOf(data) ? "roko serve " + SERVE_LOOK[serveOf(data).state].word : ""),
        blocking && !refusal && !blocking.pick ? h(Blocking, { problem: blocking, lead: "roko can't start work from Hermes until this is fixed:" }) : null,
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
    // 0.7: a serve that does not run says so on the glass here too; the banner above has its keys.
    const serve = useSetup().serve;
    return h(
      "div",
      { className: "roko-onboard", "data-roko": "onboarding" },
      serve ? h("div", { className: "rk-onboard-serve", "data-roko": "onboard-serve" }, h(ServeLight, { serve: serve, size: "M" })) : h(Motif),
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
            // One orange key a screen: while the banner above offers to start roko serve, that is the one.
            h(Key, { tone: serve && serve.actions.indexOf("start") >= 0 ? undefined : "you", size: "l", label: "new run", kbd: "n", ariaLabel: "New run", name: "onboard-new-run", onClick: function () { props.onCompose(""); } }),
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
            onOpenRun: props.onSelectRun,
          })
        : null
    );
  }

  // ---------------------------------------------------------------------------
  // Waiting items (shared by the Waiting tab and the run view)
  // ---------------------------------------------------------------------------

  /**
   * roko's wait for an answer (spec v3 §2.9, §5.4, Nooscopy): a segmented orange bar in a well that breathes and empties
   * as time runs, and what happens at 0:00, so the person always knows what follows if they walk away: "23:41 left ·
   * then unverified" for a sign-off, "then it is not sent" for a held call; red from the last minute. The desktop's
   * PendingCountdown.
   */
  function Deadline(props) {
    const at = ms(props.at);
    const left = Math.max(0, Math.round((at - props.now) / 1000));
    if (!isFinite(at)) return null;
    const total = isNum(props.total) && props.total > 0 ? props.total : Math.max(left, 1);
    const then = props.then || "then unverified";
    const face = clock(left);
    return h(
      "div",
      {
        className: "rk-deadline" + (left > 0 ? "" : " is-over"),
        "data-urgent": left <= 60 ? "true" : undefined,
        "data-roko": "countdown",
        title: "roko stops waiting at " + wallClock(at) + "; " + then,
      },
      h(Well, { className: "rk-pend-well" }, h(Meter, { value: left, max: total, segments: 24, tone: left <= 60 ? "fail" : "you" })),
      h("span", { className: "rk-deadline-words", "aria-hidden": "true" }, left > 0 ? face + " left · " + then : "time is up · " + then.replace(/^then /, "")),
      h("span", { className: "rk-sr" }, left > 0 ? face + " left, " + then : "time is up, " + then.replace(/^then /, ""))
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
    const wait = isNum(item.timeout_secs) ? item.timeout_secs : isFinite(ms(item.held_at)) && isFinite(ms(item.deadline_at)) ? (ms(item.deadline_at) - ms(item.held_at)) / 1000 : null;
    function onKey(event) {
      if (!canAct || busy || typingIn(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "a" || event.key === "r") {
        event.preventDefault();
        decide(event.key === "a");
      }
    }
    return h(
      "article",
      {
        className: "roko-pending rk-waitcard" + (effect ? " roko-pending--effect" : ""),
        "data-roko-pending": str(item.code),
        tabIndex: 0,
        "aria-label": (effect ? "Held call " : "Sign-off ") + str(item.code) + ": " + str(item.question || item.title),
        onKeyDown: onKey,
      },
      h(
        "div",
        { className: "roko-pending-top" },
        h(LED, { ch: "you" }),
        h(Stamp, { tone: "you" }, effect ? "held call" : "sign-off"),
        h("span", { className: "rk-ringtag", "data-ch": "you", title: effect ? "L0: a tool call held for you" : "L2: the plan waits for you" }, effect ? "L0" : "L2"),
        h("span", { className: "roko-flex" }),
        h("span", { className: "roko-code", title: "the code /roko approve and /roko reject take" }, str(item.code))
      ),
      item.question ? h("div", { className: "roko-pending-question" }, str(item.question)) : null,
      h("div", { className: "roko-pending-title" }, str(item.title)),
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
      // What checked it: nothing, for a sign-off (the answer decides); a held call goes nowhere until answered.
      h("div", { className: "rk-pend-checked" }, effect ? "roko holds the call: nothing is sent until you answer" : "no check ran on this: your answer decides"),
      item.deadline_at ? h(Deadline, { at: item.deadline_at, now: props.now, total: wait, then: effect ? "then it is not sent" : "then unverified" }) : null,
      h(
        "div",
        { className: "roko-pending-meta roko-dim" },
        "run " + shortId(item.run_id) + (item.task_id ? " · task " + str(item.task_id) : ""),
        h(ProjectTag, { run: item }),
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
            h(Key, { tone: "fail", kbd: "r", disabled: !!busy, busy: busy === "reject", onClick: function () { decide(false); }, ariaLabel: "Reject " + str(item.code), label: busy === "reject" ? "rejecting…" : "reject" }),
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
            h(Key, { tone: "you", kbd: "a", disabled: !!busy, busy: busy === "approve", onClick: function () { decide(true); }, ariaLabel: "Approve " + str(item.code), label: busy === "approve" ? "approving…" : "approve" })
          ),
      error ? h(ErrorNote, { error: error, compact: true }) : null
    );
  }

  function PendingList(props) {
    const items = props.items || [];
    const now = useNow(1000, items.some(function (it) { return !!it.deadline_at; }));
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
    // 0.7: the overview lists what waits in every project whose serve runs; /pending, in the project shown.
    const everywhere = list((useOverview().data || {}).pending).filter(obj);
    const listed = res.data ? list(res.data.items).filter(obj) : [];
    const codes = listed.map(function (it) { return str(it.code); });
    const items = res.data
      ? listed.concat(everywhere.filter(function (it) { return codes.indexOf(str(it.code)) < 0; })).filter(function (it) { return !answeredStore.has(it); })
      : [];
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

  /**
   * 07 run plan (spec v3 §5.5): the knob with its detents and the cap in the bone well (the plan sheet's one number),
   * resume, the limits, and the orange key. The click opens a confirm; that yes is the person's approval.
   */
  function RunPlanForm(props) {
    const plan = props.plan;
    const limits = useLimits();
    const setup = useSetup();
    const blocking = setup.blocking;
    // roko would not run this plan now (`validation`, 0.5.0): the plan sheet says why, above.
    const planInvalid = obj(plan.validation) && plan.validation.valid === false ? plan.validation : null;
    const ceiling = ceilingOf(limits);
    // The composer's default cap ($0.50), or the smallest detent that covers roko's estimate for this plan; "custom"
    // while the person types one.
    const [cap, setCap] = useState(function () { return planCap(ceiling, obj(plan.estimate)); });
    const [custom, setCustom] = useState("");
    const [resume, setResume] = useState(false);
    const [confirming, setConfirming] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const capValue = cap === "custom" ? Number(custom) : cap;
    const capTooHigh = ceiling !== null && isNum(capValue) && capValue > ceiling + 1e-9;
    const capOk = isNum(capValue) && capValue >= 0.01 && !capTooHigh && !(cap === "custom" && custom.trim() === "");
    const est = obj(plan.estimate);

    function start() {
      setConfirming(false);
      setBusy(true);
      setError(null);
      const payload = Object.assign({ max_usd: Math.round(capValue * 100) / 100, resume: resume }, projectBody());
      apiPost("/plans/" + enc(plan.plan_id) + "/run", payload).then(function (res) {
        setBusy(false);
        if (res.ok) {
          props.notify("Started run " + shortId(res.data.run_id) + " for plan " + str(plan.plan_id), "success");
          overviewStore.refresh();
          props.onStarted(res.data);
          return;
        }
        setError(res.error);
        // roko will not run the plan as it is: read it again, so its own note says why and run plan goes off.
        if (res.error.validation && props.onRefused) props.onRefused();
      });
    }

    return h(
      "form",
      {
        className: "roko-runform rk-planrun",
        onSubmit: function (event) {
          event.preventDefault();
          if (capOk && !busy && !blocking && !planInvalid) setConfirming(true);
        },
      },
      h(
        "div",
        { className: "rk-planrun-row" },
        h(Knob, {
          label: "Spending cap",
          detents: CAP_PRESETS,
          max: ceiling === null ? undefined : ceiling,
          value: cap === "custom" ? (isNum(capValue) && capValue > 0 ? capValue : CAP_PRESETS[0]) : isNum(cap) ? cap : CAP_PRESETS[0],
          onChange: setCap,
        }),
        h(
          "div",
          { className: "rk-planrun-side" },
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
            { className: "roko-dim rk-small" },
            "Paid: roko stops spending at the cap. " +
              (est && isNum(est.total_cost_usd) ? "roko estimates " + money(est.total_cost_usd) + ". " : "") +
              "The plugin and roko serve each refuse caps above their own limits."
          )
        ),
        h(Key, {
          type: "submit",
          tone: "you",
          size: "l",
          name: "run-plan",
          busy: busy,
          disabled: !capOk || busy || !!blocking || !!planInvalid,
          title: blocking ? blocking.title : planInvalid ? "roko won't run this plan yet: see why above" : undefined,
          label: busy ? "starting…" : "run plan" + (capOk ? " · cap " + money(capValue) : ""),
        })
      ),
      // A fix's outcome shows once, at the top of the page (the setup area), not again here.
      blocking ? h(Blocking, { problem: blocking, lead: "Plans can't run from Hermes until this is fixed:" }) : null,
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

  // ---------------------------------------------------------------------------
  // The plan sheet (spec v3 §5.5; 0.6.0 P8): a plan reads as a document first. Its plan.md, the plan on the glass
  // with where its tasks start, the static sequencer, each task's acceptance with the checks that prove it, the
  // rubric, what roko still asks, and run plan. The desktop's words (desktop/plugin.js PlanDetail, PlanTasks).
  // ---------------------------------------------------------------------------

  /**
   * Inline markdown as text: `code`, **strong** (with any `code` in it: mori plans bold their file names), and
   * [a link](…) as its words; never HTML.
   */
  function mdInline(line, keyBase) {
    const out = [];
    const re = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]*\))/g;
    let at = 0;
    let m;
    while ((m = re.exec(line))) {
      if (m.index > at) out.push(line.slice(at, m.index));
      const tok = m[0];
      out.push(
        tok.charAt(0) === "`"
          ? h("code", { key: keyBase + ":" + m.index }, tok.slice(1, -1))
          : tok.slice(0, 2) === "**"
            ? h("b", { key: keyBase + ":" + m.index }, mdInline(tok.slice(2, -2), keyBase + ":" + m.index))
            : tok.slice(1, tok.indexOf("]"))
      );
      at = m.index + tok.length;
    }
    if (at < line.length) out.push(line.slice(at));
    return out;
  }

  const MD_ITEM = /^(\s*)([-*+]|\d+[.)])\s+/;

  /**
   * Untrusted markdown read as a document (spec v3 §5.5): headings, paragraphs, lists, code and tables, all as text,
   * never as HTML. A list keeps its own numbers and two levels of nesting; an item's wrapped lines stay with it.
   * `blocks` caps what shows before "read on". The desktop's MiniMarkdown.
   */
  function MiniMarkdown(props) {
    const lines = str(props.source).replace(/\r\n?/g, "\n").split("\n");
    const blocks = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      const key = blocks.length;
      if (/^```/.test(line)) {
        const body = [];
        i += 1;
        while (i < lines.length && !/^```/.test(lines[i])) {
          body.push(lines[i]);
          i += 1;
        }
        i += 1;
        blocks.push(h("pre", { key: key, className: "rk-doc-code" }, body.join("\n")));
      } else if (/^#{1,6}\s/.test(line)) {
        const level = Math.min(4, /^#+/.exec(line)[0].length);
        blocks.push(h("h" + (level + 2), { key: key, className: "rk-doc-h rk-doc-h" + level }, mdInline(line.replace(/^#+\s*/, "").replace(/\s+#+\s*$/, ""), key)));
        i += 1;
      } else if (MD_ITEM.test(line)) {
        const items = [];
        while (i < lines.length && (MD_ITEM.test(lines[i]) || (items.length && /^\s+\S/.test(lines[i]) && !/^\s*\|/.test(lines[i])))) {
          const found = MD_ITEM.exec(lines[i]);
          if (found) {
            items.push({
              depth: found[1].length >= 5 ? 2 : found[1].length >= 2 ? 1 : 0,
              mark: /\d/.test(found[2]) ? found[2] : "–",
              text: lines[i].slice(found[0].length).replace(/^\[[ xX]\]\s*/, ""),
            });
          } else {
            items[items.length - 1].text += " " + lines[i].trim();
          }
          i += 1;
        }
        blocks.push(
          h(
            "ul",
            { key: key, className: "rk-doc-list" },
            items.map(function (item, j) {
              return h(
                "li",
                { key: j, "data-depth": item.depth || undefined },
                h("span", { className: "rk-doc-mark", "aria-hidden": "true" }, item.mark),
                h("span", null, mdInline(item.text, key + ":" + j))
              );
            })
          )
        );
      } else if (/^\s*\|/.test(line)) {
        const rows = [];
        while (i < lines.length && /^\s*\|/.test(lines[i])) {
          if (!/^\s*\|[\s:|-]+\|\s*$/.test(lines[i])) rows.push(lines[i].trim());
          i += 1;
        }
        blocks.push(h("pre", { key: key, className: "rk-doc-table" }, rows.join("\n")));
      } else if (!line.trim() || /^(---|\*\*\*|___)\s*$/.test(line)) {
        i += 1;
      } else {
        const para = [];
        while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|\s*([-*+]|\d+[.)])\s+|\s*\|)/.test(lines[i])) {
          para.push(lines[i].replace(/^>\s?/, "").trim());
          i += 1;
        }
        blocks.push(h("p", { key: key, className: "rk-doc-p" }, mdInline(para.join(" "), key)));
      }
    }
    return h(Fragment, null, props.blocks ? blocks.slice(0, props.blocks) : blocks);
  }

  /** 01: the plan's own summary (0.6.0 P8 `doc`): its plan.md's headings and first paragraphs, folded after a screenful. */
  function PlanDoc(props) {
    const plan = props.plan;
    const doc = obj(plan.doc);
    const [open, setOpen] = useState(false);
    // The document's own title repeats the plan's: it goes.
    const source = str(doc && doc.markdown).replace(/^\s*#\s+(.+)\n/, function (whole, title) {
      return title.trim() === str(plan.title).trim() ? "" : whole;
    });
    if (!doc || !source.trim()) return null;
    const blocks = source.split(/\n{2,}/).length;
    return h(
      "section",
      { className: "rk-planmod", "aria-label": "The plan's summary" },
      h(ModLabel, { n: 1, right: str(doc.path) || "plan.md" }, "summary"),
      h(
        "div",
        { className: "rk-plandoc", "data-open": open ? "true" : undefined, "data-roko": "plan-doc" },
        h(MiniMarkdown, { source: source, blocks: open ? 0 : 6 }),
        blocks > 6
          ? h(
              "button",
              { type: "button", className: "roko-linkbtn rk-plandoc-more", "aria-expanded": open ? "true" : "false", onClick: function () { setOpen(!open); } },
              open ? "fold the summary" : "read on"
            )
          : null,
        open && doc.truncated ? h("p", { className: "roko-dim rk-small" }, "The plan's plan.md goes on; this is its start.") : null
      )
    );
  }

  /** roko's estimate in one line: "est $0.03 · ~30s · confidence low" (the desktop's `estimateLine`). */
  function estimateLine(est) {
    if (!obj(est)) return "no estimate";
    const parts = ["est " + money(est.total_cost_usd)];
    if (isNum(est.total_duration_secs)) parts.push("~" + duration(est.total_duration_secs * 1000));
    if (est.confidence) parts.push("confidence " + oneLine(est.confidence, 20));
    return parts.join(" · ");
  }

  /**
   * What roko's task estimates rest on, as roko gives it (plugin-review F10, the desktop's words): "from its defaults"
   * when every task's does, "partly from its defaults" in a mix with them, "from past tries of other tasks" when one
   * rests on `any_task`, "from similar past tries" only when every one is `same_role_and_tier` or `same_tier`, else
   * "from past tries"; "" when no task says.
   */
  function estimateBasis(tasks) {
    const bases = list(tasks)
      .filter(function (t) { return obj(t) && obj(t.estimate) && str(t.estimate.basis); })
      .map(function (t) { return str(t.estimate.basis); });
    if (!bases.length) return "";
    const defaults = bases.filter(function (b) { return b === "defaults"; }).length;
    if (defaults === bases.length) return "from its defaults";
    if (defaults) return "partly from its defaults";
    if (bases.indexOf("any_task") >= 0) return "from past tries of other tasks";
    return bases.every(function (b) { return b === "same_role_and_tier" || b === "same_tier"; }) ? "from similar past tries" : "from past tries";
  }

  /**
   * The plan's estimate in words (R7, the desktop's PlanEstimate; plugin-review F10): "likely $0.19 · worst $1.29 · cap
   * $0.25", then in orange "the worst case is over the cap: roko stops at $0.25" when it is, the tasks roko could not
   * price (left out of both figures), what the figures rest on, and "low confidence" when roko says so. From a roko
   * before R7, its rough total and where the tasks start.
   */
  function planEstimateWords(est, tasks) {
    const starts = list(est && est.by_rung)
      .filter(function (r) { return obj(r) && list(r.tasks).length; })
      .map(function (r) { return plural(list(r.tasks).length, "task", "tasks") + " on " + str(r.rung); });
    if (!obj(est) || !isNum(est.likely_usd)) return [estimateLine(est), starts.length ? "starts " + starts.join(", ") : ""].filter(Boolean).join(" · ");
    const worst = isNum(est.worst_usd) ? est.worst_usd : null;
    const cap = isNum(est.cap_usd) ? est.cap_usd : null;
    const unpriced = list(est.unpriced_tasks).map(str).filter(Boolean);
    const basis = estimateBasis(tasks);
    const low = str(est.confidence) === "low";
    return h(
      Fragment,
      null,
      // The worst case leaves unpriced tasks out: it is the priced tasks', never "at most", and the count follows it.
      [
        "likely " + money(est.likely_usd),
        worst !== null ? "worst " + money(worst) + (unpriced.length ? " for the priced tasks" : "") : "",
        unpriced.length ? plural(unpriced.length, "task", "tasks") + " unpriced" : "",
        cap !== null ? "cap " + money(cap) : "",
      ]
        .filter(Boolean)
        .join(" · "),
      worst !== null && cap !== null && worst > cap + 1e-9 ? h("span", { className: "rk-est-over", "data-roko": "plan-over-cap" }, " · the worst case is over the cap: roko stops at " + money(cap)) : null,
      basis || low ? h("span", { className: "roko-dim" }, " · roko's estimate" + (basis ? ", " + basis : "") + (low ? " · low confidence" : "")) : null
    );
  }

  /** A task's estimate (R7): "starts on cheap · likely $0.05 · worst $0.32"; "" from a roko before R7. The desktop's. */
  function taskEstimateWords(t) {
    const e = obj(t.estimate);
    if (!e) return "";
    return [str(t.start_rung) ? "starts on " + str(t.start_rung) : "", isNum(e.likely_usd) ? "likely " + money(e.likely_usd) : "", isNum(e.worst_usd) ? "worst " + money(e.worst_usd) : ""]
      .filter(Boolean)
      .join(" · ");
  }

  /** One readout on the plan's glass: `TASKS` over its dot-matrix value, with a note under it. */
  function PlanRead(props) {
    return h(
      "div",
      { className: "rk-planread", "data-roko": props.name, role: "group", "aria-label": props.label, title: props.title || undefined },
      h("div", { className: "rk-mod" }, h("span", { className: "rk-mod-label" }, props.label)),
      h(Dots, { value: props.value, size: "M", ch: props.ch || "ink", label: props.sr }),
      props.note ? h("span", { className: "rk-cnote" }, props.note) : null
    );
  }

  /**
   * Where the plan's tasks start (0.6.0 P8 `estimate.by_rung`): the workspace's ladder, strongest on top, each rung
   * with its model and the tasks that start on it, and roko's likely cost there once it prices tasks by rung (R7).
   */
  function PlanStarts(props) {
    const rows = list(props.byRung).filter(function (r) { return obj(r) && str(r.rung); });
    if (!rows.length) return null;
    return h(
      "ul",
      { className: "rk-planstarts", "data-roko": "plan-starts", "aria-label": "Where its tasks start" },
      rows.map(function (r) {
        const tasks = list(r.tasks).map(str).filter(Boolean);
        return h(
          "li",
          { key: str(r.rung), className: "rk-planstart", "data-start": tasks.length ? "true" : undefined },
          h("span", { className: "rk-rung-r" }, str(r.rung)),
          h("span", { className: "rk-where-m" }, str(r.model)),
          h(
            "span",
            { className: "rk-planstart-tasks" },
            tasks.length
              ? tasks.slice(0, 12).map(function (id) { return h("i", { key: id }, oneLine(id, 16)); }).concat(tasks.length > 12 ? [h("span", { key: "more" }, "+" + (tasks.length - 12))] : [])
              : null
          ),
          isNum(r.likely_usd) ? h("span", { className: "rk-rung-p" }, "≈ " + money(r.likely_usd)) : null
        );
      })
    );
  }

  /**
   * 02: the plan on the glass (spec v3 §5.5's stats): tasks, waves, how many run at once and roko's estimate as
   * dot-matrix readouts; where its tasks start; the estimate in words. The estimate is ink: the plan sheet's one bone
   * number is the cap, at run plan.
   */
  function PlanDisplay(props) {
    const plan = props.plan;
    const graph = props.graph;
    const tasks = list(plan.tasks).filter(obj);
    const est = obj(plan.estimate);
    const count = isNum(plan.task_count) ? plan.task_count : tasks.length;
    const n = atOnce(graph, plan);
    const checks =
      tasks.reduce(function (sum, t) { return sum + (list(t.verify).filter(obj).length || list(t.checks).length); }, 0) +
      list(plan.plan_checks).filter(obj).length;
    const usd = est ? (isNum(est.likely_usd) ? est.likely_usd : est.total_cost_usd) : null;
    return h(
      Glass,
      { className: "rk-plandisp", grid: true, name: "plan-stats", label: "The plan" },
      h(ModLabel, { n: 2, right: "nothing runs until you say so" }, "the plan"),
      h(
        "div",
        { className: "rk-planreads" },
        h(PlanRead, { name: "plan-count", label: "tasks", value: String(count), sr: plural(count, "task", "tasks"), note: checks ? plural(checks, "check", "checks") : "no checks of their own" }),
        h(PlanRead, { name: "plan-waves", label: "waves", value: String(graph.waves.length), sr: plural(graph.waves.length, "wave", "waves"), note: graph.waves.length > 1 ? "each wave waits for the one before" : null }),
        h(PlanRead, { name: "plan-parallel", label: "at once", value: n ? String(n) : "-", sr: atOnceWords(graph, plan), note: n > 1 ? "side by side, at most" : null, title: n > 1 ? n + " tasks side by side at most" : undefined }),
        h(PlanRead, {
          name: "plan-cost",
          label: est && isNum(est.likely_usd) ? "likely" : "estimate",
          value: isNum(usd) ? boneMoney(usd) : "-",
          sr: isNum(usd) ? "roko estimates " + moneyFine(usd) : "no estimate",
          title: est && str(est.basis) ? oneLine(est.basis, 200) : undefined,
          note: est
            ? [est.confidence ? oneLine(est.confidence, 20) + " confidence" : null, isNum(est.total_duration_secs) ? "~" + duration(est.total_duration_secs * 1000) : null].filter(Boolean).join(" · ") || null
            : "roko has no history to estimate from",
        })
      ),
      est ? h(PlanStarts, { byRung: est.by_rung }) : null,
      h("p", { className: "rk-planwords", "data-roko": "plan-estimate" }, planEstimateWords(est, tasks))
    );
  }

  /** A plan's check as a run names it ("verify[0:unit_test]"), its command, and what a failure means (0.6.0 P8). */
  function CheckChip(props) {
    const c = props.check || {};
    const name = str(c.name);
    const command = str(c.command);
    return h(
      "code",
      {
        className: "rk-checkchip",
        "data-roko": "check-chip",
        title:
          [
            props.quoted ? "the criterion names this check (the plan declares no coverage)" : "",
            command,
            str(c.fail_msg) ? "if it fails: " + str(c.fail_msg) : "",
            str(c.expect) === "fail_on_base" ? "it fails on the unchanged base" : "",
          ]
            .filter(Boolean)
            .join("\n") || undefined,
      },
      name ? h("b", null, oneLine(name, 40) + " ") : null,
      oneLine(command, 90)
    );
  }

  /**
   * What a task must also do that no check proves (a mori import's "Also required, not checked automatically", which
   * the backend lifts out of its description), in dim ink: under its checked criteria on the sheet, and beside its
   * description in its detail. Each item as text; nothing for an empty list.
   */
  function AlsoRequired(props) {
    const t = props.task || {};
    const also = list(t.also_required).map(str).filter(Boolean);
    if (!also.length) return null;
    return h(
      "div",
      { className: "rk-also", "data-roko": "also-required" },
      h("span", { className: "rk-also-head" }, "also required · not checked automatically" + (t.also_required_judged_in_review === true ? " · the review task judges these" : "")),
      h("ul", { className: "rk-also-list" }, also.slice(0, 20).map(function (a, i) { return h("li", { key: i }, oneLine(a, 600)); }))
    );
  }

  /**
   * One task as the plan's document states it (spec v3 §5.5, 0.6.0 P8): the rung it starts on, its role, the section
   * of the plan it implements, its goal, its acceptance criteria as a checklist, each followed by the checks that cover
   * it, the checks that cover nothing in particular, what is out of scope, what roko's planner still asks about it,
   * and its files. An older backend's task has its checks as commands and no acceptance.
   */
  function PlanTask(props) {
    const t = props.task || {};
    const id = str(t.id);
    const deps = list(t.depends_on).map(str).filter(Boolean);
    // 0.5.0: what roko's validator says this task still asks (its plan cannot run until it is answered).
    const asked = list(t.open_questions).filter(obj);
    // An older backend sends the criteria as words; 0.6.0 as {id, text, checks}.
    const acceptance = list(t.acceptance)
      .map(function (a, i) {
        return obj(a)
          ? { id: str(a.id) || "AC" + (i + 1), text: str(a.text), checks: list(a.checks).map(str).filter(Boolean), source: list(a.source_checks).map(str).filter(Boolean), quoted: str(a.linked_by) === "quote" }
          : { id: "AC" + (i + 1), text: str(a), checks: [], source: [], quoted: false };
      })
      .filter(function (a) { return a.text; });
    const named = list(t.verify).filter(obj);
    const verify = named.length
      ? named
      : list(t.checks).map(function (c) { return { name: "", command: str(c) }; }).filter(function (c) { return c.command; });
    const byName = {};
    verify.forEach(function (v) { if (str(v.name)) byName[str(v.name)] = v; });
    const covering = {};
    acceptance.forEach(function (a) { a.checks.forEach(function (name) { covering[name] = true; }); });
    const loose = verify.filter(function (v) { return !covering[str(v.name)]; });
    const files = list(t.files).map(str).filter(Boolean);
    const nonGoals = list(t.non_goals).map(str).filter(Boolean);
    return h(
      "section",
      {
        className: "roko-plantask rk-plantask",
        role: "listitem",
        "aria-label": id + " " + str(t.title),
        "data-roko-plantask": id,
        "data-doc": acceptance.length ? "true" : undefined,
      },
      h(
        "div",
        { className: "roko-plantask-head" },
        h("span", { className: "roko-mono roko-task-id" }, id),
        h("span", { className: "roko-plantask-title" }, str(t.title)),
        h(
          "span",
          { className: "rk-plantask-tags" },
          taskEstimateWords(t)
            ? h(
                "span",
                {
                  className: "rk-plantask-est",
                  "data-roko": "task-estimate",
                  title: list(t.estimate.worst_rungs).length ? "worst: every try fails and climbs, through " + list(t.estimate.worst_rungs).map(str).join(" → ") : undefined,
                },
                taskEstimateWords(t)
              )
            : str(t.start_rung)
              ? h("span", { className: "rk-rchip", title: "It starts on the " + str(t.start_rung) + " rung" }, str(t.start_rung))
              : null,
          t.role ? h("span", { className: "roko-kind" }, str(t.role)) : null,
          asked.length ? h("span", { className: "rk-question-tag", "data-roko": "open-question" }, asked.length === 1 ? "open question" : asked.length + " open questions") : null
        )
      ),
      str(t.section) || deps.length
        ? h(
            "div",
            { className: "rk-plantask-meta" },
            str(t.section) ? h("span", { title: "The section of the plan it implements" }, "§ " + oneLine(t.section, 60)) : null,
            deps.length ? h("span", null, "needs " + deps.join(", ")) : null
          )
        : null,
      str(t.goal) ? h("p", { className: "rk-plantask-goal" }, mdInline(oneLine(t.goal, 600), "goal")) : null,
      acceptance.length
        ? h(
            "ul",
            { className: "rk-accept", "aria-label": "What " + id + " must do", "data-roko": "acceptance" },
            acceptance.map(function (a, i) {
              return h(
                "li",
                { key: i },
                h("span", { className: "rk-accept-box", "aria-hidden": "true" }),
                h(
                  "span",
                  { className: "rk-accept-text" },
                  h("span", { className: "rk-accept-id" }, a.id),
                  // The checks of the plan's source (its spec) this criterion keeps ("SC2").
                  a.source.length ? h("span", { className: "rk-accept-src", title: "from the plan's source: its success checks" }, a.source.map(function (id) { return oneLine(id, 12); }).join(" ")) : null,
                  mdInline(a.text, i),
                  // Checks the plan says cover it (`covers`); or, where it says none, the ones the criterion quotes
                  // (0.6.0 `linked_by: quote`), drawn dashed and said so.
                  a.checks.length
                    ? h(
                        "span",
                        { className: "rk-accept-by", "data-linked": a.quoted ? "quote" : undefined },
                        a.checks.map(function (name) { return h(CheckChip, { key: name, check: byName[name] || { name: name }, quoted: a.quoted }); })
                      )
                    : null
                )
              );
            })
          )
        : null,
      h(AlsoRequired, { task: t }),
      nonGoals.length ? h("p", { className: "rk-plantask-nongoals roko-dim" }, "not in scope: " + nonGoals.map(function (n) { return oneLine(n, 80); }).join(" · ")) : null,
      loose.length
        ? h(
            "div",
            { className: "rk-plantask-checks" },
            h("span", { className: "rk-tiny" }, acceptance.some(function (a) { return a.checks.length; }) ? "also checked by" : "proved by"),
            h("span", { className: "rk-chips" }, loose.map(function (v, i) { return h(CheckChip, { key: i, check: v }); }))
          )
        : !verify.length
          ? h("div", { className: "rk-plantask-checks roko-dim" }, "no check of its own: the workspace's gates apply")
          : null,
      asked.length ? h(OpenQuestions, { questions: asked }) : null,
      files.length
        ? h(
            "div",
            { className: "roko-filechips" },
            files.slice(0, 8).map(function (f) { return h("span", { key: f, className: "roko-filechip roko-mono" }, oneLine(f, 60)); }),
            files.length > 8 ? h("span", { className: "roko-dim rk-small" }, "+" + (files.length - 8)) : null
          )
        : null
    );
  }

  /**
   * 04: the plan's tasks, then the whole-plan check roko runs once every task passed (0.6.0 `plan_checks`), and what
   * the plan's source asked for that no check here proves, with why (`dropped_checks`).
   */
  function PlanTasks(props) {
    const plan = props.plan;
    const tasks = list(plan.tasks).filter(obj);
    const planChecks = list(plan.plan_checks).filter(obj);
    const dropped = list(plan.dropped_checks).filter(function (d) { return obj(d) && str(d.id); });
    if (!tasks.length) return null;
    const doc = tasks.some(function (t) { return list(t.acceptance).length; });
    return h(
      "section",
      { className: "rk-planmod", "aria-label": "The plan's tasks" },
      h(ModLabel, { n: 4, right: doc ? "each criterion with the check that proves it" : null }, "tasks"),
      h(
        "div",
        { className: "roko-plantasks", role: "list", "aria-label": "The plan's tasks", "data-roko": "plan-tasks", "data-doc": doc ? "true" : undefined },
        tasks.map(function (t) { return h(PlanTask, { key: str(t.id), task: t }); }),
        planChecks.length
          ? h(
              "div",
              { className: "roko-plantask rk-plantask rk-planchecks", role: "listitem", "data-roko": "plan-checks" },
              h("div", { className: "roko-plantask-head" }, h("span", { className: "roko-plantask-title" }, "the whole plan, once its tasks passed")),
              h("div", { className: "rk-plantask-checks" }, planChecks.map(function (c, i) { return h(CheckChip, { key: i, check: c }); }))
            )
          : null,
        dropped.length
          ? h(
              "div",
              { className: "roko-plantask rk-plantask rk-planchecks", role: "listitem", "data-roko": "plan-dropped" },
              h("div", { className: "roko-plantask-head" }, h("span", { className: "roko-plantask-title" }, "not kept from its source")),
              h(
                "ul",
                { className: "rk-dropped" },
                dropped.slice(0, 12).map(function (d, i) {
                  return h("li", { key: i }, h("span", { className: "rk-accept-id" }, oneLine(d.id, 12)), oneLine(d.reason, 200) || "no reason given");
                })
              )
            )
          : null
      )
    );
  }

  /** 05: the plan's review rubric (0.6.0 P8 `rubric`, a mori plan's rubric.md), folded: what its reviewers check. */
  function PlanRubric(props) {
    const rubric = obj(props.plan.rubric);
    if (!rubric || !str(rubric.markdown).trim()) return null;
    return h(
      "details",
      { className: "rk-planmod rk-rubric", "data-roko": "plan-rubric" },
      h("summary", null, h(ModLabel, { n: 5, right: str(rubric.path) || "rubric.md" }, "review rubric")),
      h(
        "div",
        { className: "rk-plandoc" },
        h(MiniMarkdown, { source: rubric.markdown }),
        rubric.truncated ? h("p", { className: "roko-dim rk-small" }, (str(rubric.path) || "rubric.md") + " goes on; this is its start.") : null
      )
    );
  }

  /**
   * The plan sheet (spec v3 §5.5), top to bottom: the title and the plan's own summary (a PRD-style plan reads as a
   * document first), the plan on the glass, the static sequencer, each task with its acceptance and the checks that
   * prove it, the review rubric (folded), what roko still asks, and run plan. An older backend's plan has no document,
   * acceptance or rubric: those parts are left out.
   */
  function PlanDetail(props) {
    const res = useResource("/plans/" + enc(props.planId), 0);
    const [selected, setSelected] = useState(null);
    // What became of its spec's checks: the report on the card of the plan's newest plan writing, if one wrote it.
    const writing = newestPlanWriting(useOverview().data, props.planId);
    const writingRes = useResource(writing ? "/runs/" + enc(writing) : null, 0);
    const writingCard = writingRes.data && obj(writingRes.data.run) ? writingRes.data.run : null;
    if (!res.data && res.error) return h(Panel, { title: "Plan " + str(props.planId) }, h(ErrorNote, { error: res.error, onRetry: res.reload }));
    if (!res.data) return h(Panel, { title: "Plan " + str(props.planId) }, h(Skeleton, { rows: 5 }));
    const plan = obj(res.data.plan) || {};
    const planId = str(plan.plan_id || props.planId);
    const tasks = list(plan.tasks).filter(obj);
    const graph = planGraph(plan);
    const current = tasks.filter(function (t) { return str(t.id) === selected; })[0] || null;
    const imported = obj(plan.imported_from);
    const invalid = obj(plan.validation);
    return h(
      "div",
      { className: "roko-plandetail rk-plansheet", "data-roko": "plan" },
      h(
        "header",
        { className: "rk-planhead" },
        h(
          "div",
          { className: "rk-planhead-top" },
          h(Stamp, { name: "plan-stamp" }, "plan"),
          // `roko plan import --mori` wrote it (0.6.0 P8): the desktop's words.
          imported
            ? h(
                Tag,
                { name: "plan-imported", title: "roko plan import --" + oneLine(imported.kind, 12) + " wrote it from the " + oneLine(imported.kind, 12) + " plan " + oneLine(imported.plan, 120) },
                "from " + oneLine(imported.kind, 12)
              )
            : null,
          invalid ? h(Tag, { ch: "you", name: "plan-blocked", title: "roko won't run this plan yet: see why below" }, "◆ won't run yet") : null,
          h("span", { className: "roko-flex" }),
          h("span", { className: "rk-planhead-id roko-mono" }, planId),
          h(CopyButton, { value: planId, what: "plan id", compact: true }),
          h("button", { type: "button", className: "roko-iconbtn", "aria-label": "Refresh the plan", onClick: res.reload }, h(Icon, { name: "refresh", size: 13 }))
        ),
        h("h2", { className: "rk-planhead-title" }, str(plan.title) || planId)
      ),
      writingCard ? h(SourceChecks, { sc: writingCard.source_checks }) : null,
      h(PlanDoc, { plan: plan }),
      h(PlanDisplay, { plan: plan, graph: graph }),
      h(
        "section",
        { className: "rk-planmod", "aria-label": "The plan as a sequencer" },
        h(ModLabel, { n: 3, right: current ? null : "select a pad to see how roko checks it" }, "sequencer"),
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
        )
      ),
      h(PlanTasks, { plan: plan }),
      h(PlanRubric, { plan: plan }),
      // roko would not run this plan now: why, and the questions it asks, right before run plan.
      invalid
        ? h(
            "section",
            { className: "rk-planmod", "aria-label": "What roko still asks" },
            h(ModLabel, { n: 6, right: "answered in the plan's tasks.toml" }, "before it runs"),
            h(PlanValidationNote, { validation: invalid, planId: planId, group: plan.group, cards: true })
          )
        : null,
      h(
        "section",
        { className: "rk-planmod", "aria-label": "Run this plan" },
        h(ModLabel, { n: 7, right: "nothing runs until you press it and say yes" }, "run plan"),
        h(RunPlanForm, { plan: Object.assign({ plan_id: props.planId }, plan), notify: props.notify, onStarted: props.onStarted, onRefused: res.reload })
      )
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
   * A question roko's planner left open (roko's PLAN_045), as the machine asking (spec v3 §2.9, §5.5): the question,
   * large; the answer the planner suggested; and what happens while nobody answers. It is answered in the plan's
   * tasks.toml: no route answers it from here.
   */
  function QuestionCard(props) {
    const q = props.question;
    return h(
      "div",
      { className: "rk-qcard", role: "group", "aria-label": "Open question" + (str(q.task_id) ? " on " + oneLine(q.task_id, 16) : ""), "data-roko": "question-card" },
      h(
        "div",
        { className: "rk-qcard-head" },
        h(Stamp, { tone: "you" }, "open question"),
        str(q.task_id) ? h("span", { className: "rk-qcard-task roko-mono" }, oneLine(q.task_id, 16)) : null
      ),
      h("p", { className: "rk-qcard-q" }, oneLine(q.question, 300)),
      str(q.assumption) ? h("p", { className: "rk-qcard-s" }, h("span", { className: "rk-qcard-k" }, "suggested"), oneLine(q.assumption, 300)) : null,
      h("p", { className: "rk-qcard-then" }, "unanswered, roko won't run the plan")
    );
  }

  /**
   * Why roko will not run this plan yet (`validation`, 0.5.0): roko's words, and the questions its planner left open
   * on a task with the answer it suggested. They are answered in the plan's tasks.toml; `roko plan validate` says
   * what is left. The desktop's words (ui-notes P1); on the plan sheet (`cards`) each question is a card.
   */
  function PlanValidationNote(props) {
    const v = obj(props.validation);
    if (!v) return null;
    return h(
      "div",
      { className: "rk-validation" + (props.cards ? " has-cards" : ""), role: "note", "data-roko": "plan-validation" },
      props.cards ? null : h(LED, { ch: "you", blink: false }),
      h(
        "div",
        { className: "rk-validation-body" },
        h("div", { className: "rk-validation-title" }, "roko won't run this plan yet"),
        h(ValidationItems, { validation: v, cards: props.cards }),
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
    const errorItems = errors.slice(0, 6).map(function (e, i) {
      return h(
        "li",
        { key: "e" + i, "data-kind": "error" },
        str(e.task_id) ? h("b", null, oneLine(e.task_id, 16) + " ") : null,
        oneLine(e.message, 300),
        str(e.rule) ? h("span", { className: "roko-dim" }, " · " + oneLine(e.rule, 24)) : null
      );
    });
    if (props.cards) {
      return h(
        Fragment,
        null,
        errorItems.length ? h("ul", { className: "rk-plan-questions", "data-roko": "validation-items" }, errorItems) : null,
        questions.length
          ? h("div", { className: "rk-qcards", "data-roko": "question-cards" }, questions.slice(0, 8).map(function (q, i) { return h(QuestionCard, { key: i, question: q }); }))
          : null
      );
    }
    return h(
      "ul",
      { className: "rk-plan-questions", "data-roko": "validation-items" },
      errorItems,
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
    const named = list(t.verify).filter(obj);
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
        // The rung it starts on (0.6.0 P8) says more than roko's tier word.
        str(t.start_rung)
          ? h("span", { className: "rk-rchip", title: "It starts on the " + str(t.start_rung) + " rung" }, str(t.start_rung))
          : t.tier ? h("span", { className: "roko-kind" }, str(t.tier)) : null,
        h("span", { className: "roko-flex" }),
        h("button", { type: "button", className: "roko-iconbtn", "aria-label": "Close the task", onClick: props.onClose }, h(Icon, { name: "x", size: 13 }))
      ),
      h("div", { className: "roko-inspector-title" }, str(t.title)),
      t.description ? h("div", { className: "roko-inspector-sec roko-inspector-sec--wide" }, h(LongText, { value: t.description, prose: true, limit: 600 })) : null,
      h(AlsoRequired, { task: t }),
      list(t.depends_on).length ? h("div", { className: "roko-dim" }, "after " + list(t.depends_on).map(str).join(", ")) : null,
      list(t.open_questions).filter(obj).length
        ? h("div", { className: "roko-inspector-sec" }, h(Label, null, "Open questions"), h(OpenQuestions, { questions: list(t.open_questions).filter(obj) }))
        : null,
      named.length || checks.length
        ? h(
            "div",
            { className: "roko-inspector-sec" },
            h(Label, null, "Checks that must pass"),
            named.length
              ? h("div", { className: "rk-plantask-checks rk-checkcol" }, named.map(function (c, i) { return h(CheckChip, { key: i, check: c }); }))
              : h("ul", { className: "roko-checks" }, checks.map(function (c, i) { return h("li", { key: i }, h(Icon, { name: "gate", size: 12 }), h("code", { className: "roko-mono" }, str(c))); }))
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

  /**
   * The plan list's sections (spec v3 §5.5's START HERE · DEMOS · MINE · FROM DOCS): the demos first (the one to start
   * with on top), then the person's plans by set, then the imports by where they came from (0.6.0 rows'
   * `imported_from`: `roko plan import --mori` gives "From mori"; the desktop's L5).
   */
  function sectionPlans(plans) {
    const known = groupsKnown(plans);
    const demos = plans.filter(function (p) { return isDemoPlan(p, known); });
    const docs = plans.filter(function (p) { return !isDemoPlan(p, known) && obj(p.imported_from); });
    const own = plans.filter(function (p) { return !isDemoPlan(p, known) && !obj(p.imported_from); });
    const sets = [];
    own.forEach(function (p) {
      if (sets.indexOf(str(p.group)) < 0) sets.push(str(p.group));
    });
    // Top-level plans first, then each set in roko's order.
    sets.sort(function (a, b) { return Number(Boolean(a)) - Number(Boolean(b)); });
    return [{ id: "demos", label: "Demos", plans: demos.filter(function (p) { return isStartHere(p, known); }).concat(demos.filter(function (p) { return !isStartHere(p, known); })) }]
      .concat(sets.map(function (g) {
        return { id: "set:" + g, label: g || (demos.length || docs.length ? "Your plans" : "Plans"), plans: own.filter(function (p) { return str(p.group) === g; }) };
      }))
      .concat(
        distinct(docs.map(function (p) { return oneLine(p.imported_from.kind, 16) || "docs"; })).map(function (kind) {
          return { id: "from:" + kind, label: "From " + kind, plans: docs.filter(function (p) { return (oneLine(p.imported_from.kind, 16) || "docs") === kind; }) };
        })
      )
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
    // One plan and nothing chosen: it is the plan (dogfood U8).
    const known = groupsKnown(plans);
    const startHere = plans.filter(function (p) { return isStartHere(p, known); })[0];
    const selected = props.selectedPlanId || (startHere ? str(startHere.id) : plans.length === 1 ? str(plans[0].id) : null);
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
                            // An import's group says where it came from: no tag on its row (the desktop's L5).
                            isStartHere(p, known) ? h(Tag, { ch: "you" }, "start here") : null
                          ),
                          h(
                            "span",
                            { className: "roko-runitem-meta" },
                            h(Pill, { tone: status.indexOf("not pass") >= 0 ? "bad" : status.indexOf("done") === 0 ? "ok" : "idle" }, status),
                            h(SegBar, { progress: { total: total, passed: done, failed: isNum(p.tasks_not_passed) ? p.tasks_not_passed : 0, pending: Math.max(0, total - done) } }),
                            h("span", { className: "roko-runitem-cost" }, done + "/" + total)
                          ),
                          // roko's list gives an older plan's id as its title (dogfood U8): say it once.
                          str(p.title) && str(p.title) !== str(p.id) ? h("span", { className: "roko-runitem-id roko-mono" }, str(p.id)) : null
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

  function KnowledgeSection(props) {
    // The lessons view heads with the wall of lessons that paid off (0.6.0 `GET /learning`, spec v3 §4.11).
    const learning = useLearningData();
    const now = useNow(60000, true);
    const [query, setQuery] = useState("");
    const [submitted, setSubmitted] = useState("");
    const path = submitted ? "/knowledge?q=" + enc(submitted) + "&limit=10" : null;
    const res = useResource(path, 0);
    const entries = res.data ? list(res.data.entries) : [];
    return h(
      "div",
      { className: "roko-knowledge" },
      learning && !learning.derived && list(learning.lessons).length ? h(LessonsPaid, { data: learning, now: now, all: true, onOpenRun: props.onOpenRun }) : null,
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
      h(Well, { className: "rk-kpi-well" }, h(Dots, { value: str(props.value), size: "XL", ch: ch, label: str(props.value) })),
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
        // 0.7: the project an action fix is for (`setup-project`), sent with its preview and its apply.
        project: plain(fix.project) || null,
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
      inflight = apiGet(forProject("/health")).then(function (res) {
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
      // 0.7: the serve banner says what the serve's rows would, as the restart banner does for restart-hermes. A project
      // roko is not set up in shows its setup instead: its serve cannot start before that.
      const projects = projectsOf(data);
      const current = projects.current;
      const none = projects.none;
      const serve = serveOf(data);
      const listed = data ? problemsOf(data.setup, reply ? reply.setup : null) : [];
      const needsSetup = !!(current && current.needsSetup) || listed.some(function (p) { return p.id === "project-needs-setup"; });
      const banner = serve && SERVE_BANNER.indexOf(serve.state) >= 0 && !needsSetup && !none ? serve : null;
      const quiet = !!banner || needsSetup || none;
      function covered(id) { return quiet && (SERVE_ROWS.indexOf(id) >= 0 || (id === "roko-serve-outdated" && !!banner && banner.state === "outdated")); }
      // The overview asks roko every time; the backend's own look at setup lags up to 30 s (and an older backend has
      // none). So roko-unreachable follows the overview both ways: added at once when roko stops answering, gone at
      // once when it answers again (ui-notes U1).
      const reachable = !!(data && obj(data.connection) && data.connection.reachable === true);
      const problems = listed.filter(function (p) { return !(reachable && p.id === "roko-unreachable") && !covered(p.id); });
      if (rokoDown(data) && !quiet && !problems.some(function (p) { return p.id === "roko-unreachable"; })) {
        problems.unshift(unreachableProblem(data.connection));
      }
      if (current && current.needsSetup && !problems.some(function (p) { return p.id === "project-needs-setup" || p.id === "workspace-refuses-chat-runs"; })) {
        problems.unshift(setupProblem(current));
      }
      return {
        problems: problems,
        blocking: none ? pickProblem() : problems.filter(function (p) { return p.severity === "block"; })[0] || (banner ? serveProblem(banner) : null),
        pick: none,
        restart: restartOf(data, reply),
        serve: banner,
      };
    }, [data, reply]);
  }

  /** What "no project yet" stands for where a start waits on it (Run plan, the chip): a blocking problem. */
  function pickProblem() {
    return Object.assign(readProblem({ id: "pick-project", severity: "block", title: "Pick the project roko works in first.", fix: { kind: "pick", label: "pick a project" } }), { pick: true });
  }

  /** What a serve banner stands for where a start waits on it (the composer, Run plan): a blocking problem. */
  function serveProblem(serve) {
    return Object.assign(readProblem({ id: "roko-serve", severity: "block", title: serveTitle(serve), fix: { kind: "serve", label: "roko serve" } }), { serve: serve });
  }

  /** A project roko is not set up in (0.7 `needs_setup`): its `setup-project` fix, previewed, then applied. */
  function setupProblem(project) {
    return readProblem({
      id: "project-needs-setup",
      severity: "block",
      title: "roko is not set up in " + project.name + " yet.",
      detail: "It is a git checkout without roko's settings. Setting roko up writes roko.toml and roko's folder there; nothing is committed.",
      fix: { kind: "action", label: "set up roko here", action: "setup-project", project: project.path },
    });
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
    const project = problem.fix.project;
    const [state, setState] = useState({ step: "idle" });

    function preview(variant) {
      setState(function (s) { return Object.assign({}, s, { error: null, step: s.reply ? "switching" : "loading" }); });
      apiGet("/setup/fix?action=" + enc(action) + (project ? "&project=" + enc(project) : "") + (variant ? "&variant=" + enc(variant) : "")).then(function (res) {
        if (res.ok) {
          setState({ step: "preview", reply: res.data });
          return;
        }
        setState(function (s) { return s.reply ? Object.assign({}, s, { step: "preview", error: res.error }) : { step: "failed", error: res.error }; });
      });
    }
    function apply() {
      const shown = obj(state.reply) || {};
      const body = project ? { action: action, project: project } : { action: action };
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
      h(Well, { className: "rk-restart-well" }, h(LED, { ch: "you", blink: "fast" }), h(Dots, { value: "RESTART", size: props.compact ? "M" : "L", ch: "you", label: "restart" })),
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

  /** A serve's state on the glass: its light, and its word in dot-matrix, which sweeps while it starts. */
  function ServeLight(props) {
    const look = SERVE_LOOK[props.serve.state];
    return h(
      Well,
      { className: "rk-serve-well" },
      h(LED, { ch: look.ch }),
      h(Dots, { value: look.dots, size: props.size || "L", ch: look.ch === "off" ? "dim" : look.ch, sweep: props.serve.state === "starting", label: "roko serve " + look.word })
    );
  }

  /**
   * The project's roko serve while it does not run (0.7, BRIEF §C; the desktop's banner): its state on the glass and in
   * a sentence, how long it has been starting, why it failed and the last lines of its log, the fix to copy for an
   * outdated or missing roko, and the keys the backend allows now. Its clock is never read out: the header's status
   * says each change once.
   */
  function ServeBanner(props) {
    const serve = props.serve;
    const data = useOverview().data;
    const [open, setOpen] = useState(false);
    const hint = serve.error ? serve.error.hint : "";
    // The fix to copy: the command a hint quotes, else the whole hint for an outdated or missing roko.
    const quoted = /`([^`]+)`/.exec(hint);
    const fix = quoted ? quoted[1] : serve.state === "outdated" || serve.state === "not_found" ? hint : "";
    const said = serve.state === "starting" ? "" : (serve.error && serve.error.message) || (serve.state === "stopped" ? "Nothing roko does works from Hermes until it runs." : "");
    return h(
      "section",
      { className: "rk-serve" + (props.compact ? " is-compact" : ""), "aria-label": "roko serve", "data-roko": "serve-banner", "data-state": serve.state },
      h(ServeLight, { serve: serve, size: props.compact ? "M" : "L" }),
      h(
        "div",
        { className: "rk-serve-body" },
        props.lead ? h("div", { className: "rk-problemcard-lead roko-dim" }, props.lead) : null,
        h("div", { className: "rk-serve-title" }, serveTitle(serve)),
        serve.state === "starting"
          ? h("div", { className: "rk-serve-line", "data-roko": "serve-starting" }, isFinite(ms(serve.since)) ? h(Fragment, null, h(Ticker, { since: serve.since, className: "rk-serve-clock" }), " · ") : null, "usually ready within a minute")
          : said
            ? h("div", { className: "rk-serve-line" }, said)
            : null,
        hint && hint !== fix ? h("div", { className: "rk-serve-hint roko-dim" }, hint) : null,
        fix ? h("div", { className: "rk-fixcmd" }, h("code", { className: "roko-cmd-text" }, fix), h(CopyKey, { label: "copy", value: fix, name: "serve-fix-copy" })) : null,
        h(
          "div",
          { className: "rk-keyrow" },
          h(ServeKeys, { serve: serve, data: data }),
          serve.log.length
            ? h(Key, { size: "s", label: (open ? "▾ " : "▸ ") + "log · last " + plural(serve.log.length, "line", "lines"), name: "serve-log-key", pressed: open, onClick: function () { setOpen(!open); } })
            : null
        ),
        open ? h("pre", { className: "rk-well rk-serve-log", "data-roko": "serve-log", "aria-label": "The last lines of roko serve's log" }, serve.log.map(function (line, i) { return h("span", { key: i }, line + "\n"); })) : null
      )
    );
  }

  /** A serve's keys, in words. */
  const SERVE_KEYS = {
    restart: { icon: "refresh", word: "restart roko serve" },
    start: { icon: "play", word: "start roko serve" },
    stop: { icon: "stop", word: "stop roko serve" },
  };

  /**
   * The keys the backend allows for a serve now (`actions`), each a POST /serve. A restart or stop that would stop runs
   * asks first and names them, then sends `force`; so does one the backend turns away as busy (`conflict`).
   */
  function ServeKeys(props) {
    const serve = props.serve;
    const canAct = useLimits().canAct;
    const [pending, setPending] = useState(null);
    const [error, setError] = useState(null);
    const [confirm, setConfirm] = useState(null);
    if (!canAct || !serve.actions.length) return null;

    function send(action, force) {
      setPending(action);
      setError(null);
      const body = { action: action };
      if (serve.project) body.project = serve.project;
      if (force) body.force = true;
      apiPost("/serve", body).then(function (res) {
        setPending(null);
        if (res.ok) {
          setConfirm(null);
          overviewStore.patchServe(res.data.serve);
          return;
        }
        if (res.error.code === "conflict" && !force) {
          setConfirm({ action: action, message: res.error.message, serve: readServe(res.error.serve) || serve });
          return;
        }
        setConfirm(null);
        setError(res.error);
      });
    }
    const going = confirm ? busyRuns(confirm.serve, props.data) : [];
    const n = confirm ? Math.max(confirm.serve.busy, going.length) : 0;
    const stop = confirm && confirm.action === "stop";
    const names = going.slice(0, 4).map(function (r) { return oneLine(r.label || r.run_id, 50); }).join(", ");
    return h(
      Fragment,
      null,
      serve.actions.map(function (action) {
        return h(Key, {
          key: action,
          size: "s",
          tone: action === "start" ? "you" : undefined,
          icon: SERVE_KEYS[action].icon,
          label: action === "start" && serve.state === "failed" ? "start again" : SERVE_KEYS[action].word,
          name: "serve-" + action,
          busy: pending === action,
          disabled: !!pending,
          onClick: function () {
            if ((action === "restart" || action === "stop") && serve.busy > 0) setConfirm({ action: action, message: "", serve: serve });
            else send(action, false);
          },
        });
      }),
      error ? h(ErrorNote, { error: error, compact: true }) : null,
      h(Confirm, {
        open: !!confirm,
        title: stop ? "Stop roko serve while runs are going?" : "Restart roko serve while runs are going?",
        description: confirm
          ? (confirm.message || plural(n, "run is", "runs are") + " going in " + (confirm.serve.name || "this project") + ": " + (stop ? "stopping" : "restarting") + " roko serve stops " + (n === 1 ? "it" : "them") + ". What passed is kept.") + (names ? " Going now: " + names + "." : "")
          : "",
        confirmLabel: stop ? "Stop roko serve" : "Restart roko serve",
        destructive: true,
        loading: !!pending,
        onConfirm: function () { if (confirm) send(confirm.action, true); },
        onCancel: function () { setConfirm(null); },
      })
    );
  }

  /** What stops a start, where it stops it (the composer, Run plan): the serve banner while the serve is why. */
  function Blocking(props) {
    return props.problem.pick
      ? h(PickProject, { compact: true, lead: props.lead })
      : props.problem.serve
        ? h(ServeBanner, { serve: props.problem.serve, compact: true, lead: props.lead })
        : h(ProblemCard, { problem: props.problem, lead: props.lead, compact: props.compact });
  }

  /** No project yet (0.7 `projects: []`): roko works in a git checkout the person names. */
  function PickProject(props) {
    return h(
      "section",
      { className: "rk-serve" + (props.compact ? " is-compact" : ""), "aria-label": "Pick a project", "data-roko": "pick-project", "data-state": "pick" },
      h(Well, { className: "rk-serve-well" }, h(LED, { ch: "you" }), h(Dots, { value: "NO PROJECT", size: props.compact ? "M" : "L", ch: "you", label: "no project" })),
      h(
        "div",
        { className: "rk-serve-body" },
        props.lead ? h("div", { className: "rk-problemcard-lead roko-dim" }, props.lead) : null,
        h("div", { className: "rk-serve-title" }, "Pick the project roko works in."),
        h("div", { className: "rk-serve-line" }, "A git checkout: roko runs its tasks there, on branches of its own, and starts a roko serve for it."),
        h(ProjectAdd, { known: [], primary: true })
      )
    );
  }

  /** The projects as a pick list, each lit by its serve, the one shown checked. */
  function ProjectList(props) {
    const current = props.projects.current;
    return h(
      "div",
      { className: "rk-projlist", role: "radiogroup", "aria-label": "Projects", "data-roko": props.name || undefined },
      props.projects.all.map(function (p) {
        const on = !!current && p.path === current.path;
        const look = p.serve ? SERVE_LOOK[p.serve.state] : null;
        return h(
          "button",
          {
            key: p.path,
            type: "button",
            role: "radio",
            "aria-checked": on ? "true" : "false",
            "aria-label": [p.name, look ? "roko serve " + look.word : "", p.needsSetup ? "needs setup" : p.isDefault ? "default" : ""].filter(Boolean).join(", "),
            className: "rk-proj" + (on ? " is-on" : ""),
            title: p.path,
            onClick: function () { pickProject(p); },
          },
          h(LED, { ch: look ? look.ch : "off" }),
          h("span", { className: "rk-proj-name" }, p.name),
          p.needsSetup ? h(Tag, { ch: "you" }, "needs setup") : p.isDefault ? h(Tag, null, "default") : null
        );
      })
    );
  }

  /**
   * The composer's `00 PROJECT` (0.7): which project the run is for, and a path field that adds one (POST /projects
   * add; the backend keeps the checkout's top folder). Picking one shows it on the page as well.
   */
  /**
   * A path field that adds a project (POST /projects add; the backend keeps the checkout's top folder and names the
   * project it added) and shows it.
   */
  function ProjectAdd(props) {
    const [path, setPath] = useState("");
    const [state, setState] = useState({ busy: false, error: null });
    function add() {
      const asked = path.trim();
      if (!asked) return;
      setState({ busy: true, error: null });
      apiPost("/projects", { action: "add", path: asked }).then(function (res) {
        if (!res.ok) {
          setState({ busy: false, error: res.error });
          return;
        }
        const before = list(props.known).map(function (p) { return p.path; });
        const now = list(res.data.projects).map(readProject).filter(Boolean);
        // The backend names the project it added; an earlier one only lists them all.
        const added = readProject(res.data.project) || now.filter(function (p) { return before.indexOf(p.path) < 0; })[0] || now.filter(function (p) { return asked === p.path || asked.indexOf(p.path + "/") === 0; })[0];
        overviewStore.setProjects(res.data.projects);
        pickProject(added || { path: asked });
        setPath("");
        setState({ busy: false, error: null });
      });
    }
    return h(
      Fragment,
      null,
      h(
        "div",
        { className: "rk-projadd" },
        h(Input, {
          type: "text",
          value: path,
          placeholder: "/path/to/a/git/checkout",
          "aria-label": "Add a project: the path of a git checkout",
          className: "roko-mono",
          onChange: function (event) { setPath(event.target.value); },
          onKeyDown: function (event) {
            if (event.key === "Enter") {
              event.preventDefault();
              add();
            }
          },
        }),
        h(Key, { size: "s", icon: "plus", label: "add", name: "project-add", tone: props.primary ? "you" : undefined, busy: state.busy, disabled: state.busy || !path.trim(), onClick: add })
      ),
      state.error ? h(ErrorNote, { error: state.error, compact: true }) : null
    );
  }

  /**
   * The composer's `00 PROJECT` (0.7): which project the run is for, and a path field that adds one. Picking one shows
   * it on the page as well.
   */
  function ProjectModule(props) {
    const projects = props.projects;
    const where = projects.current ? projects.current.path : "none yet: name the git checkout roko works in";
    return h(
      "div",
      { className: "roko-field rk-field rk-projmodule", "data-roko": "composer-project" },
      h("span", { className: "rk-module-head" }, h("span", { className: "rk-module-idx" }, "00"), h("span", { className: "rk-module-label" }, "PROJECT"), h("span", { className: "rk-module-right roko-mono", title: where }, where)),
      h(ProjectList, { projects: projects, name: "composer-projects" }),
      h(ProjectAdd, { known: projects.all, primary: projects.none })
    );
  }

  /**
   * The header's project (0.7): which project this page shows, lit by its serve, as a native select (every project this
   * Hermes knows). Picking one switches the page (overview, plans, loops, insights, learning, lessons) and is kept in
   * this browser.
   */
  function ProjectSwitch(props) {
    const projects = projectsOf(props.data);
    const current = projects.current;
    if (!current) return null;
    const look = current.serve ? SERVE_LOOK[current.serve.state] : null;
    return h(
      "label",
      { className: "rk-projswitch", title: current.path },
      h(LED, { ch: look ? look.ch : "off" }),
      h(
        "select",
        {
          className: "rk-projselect",
          value: current.path,
          "aria-label": "The project this page shows",
          "data-roko": "project-switch",
          onChange: function (event) {
            const p = projects.all.filter(function (x) { return x.path === event.target.value; })[0];
            if (p) pickProject(p);
          },
        },
        // Names only: the light beside it says the shown project's serve, and the banner says more.
        projects.all.map(function (p) {
          return h("option", { key: p.path, value: p.path }, p.name + (p.needsSetup ? " · needs setup" : ""));
        })
      )
    );
  }

  /** The project a run belongs to (0.7 `project`), once this Hermes knows more than one. */
  function ProjectTag(props) {
    const data = useOverview().data;
    const raw = props.run ? props.run.project : null;
    // A run row's `{path, name}`, or a path alone.
    const p = obj(raw) || (plain(raw) ? { path: plain(raw), name: plain(raw).split(/[\\/]/).filter(Boolean).pop() } : null);
    if (!p || !plain(p.name) || list(data && data.projects).length < 2) return null;
    return h("span", { className: "rk-runproj", "data-roko": "run-project", title: plain(p.path) || undefined }, oneLine(plain(p.name), 28));
  }

  /**
   * The top of the roko tab: the restart banner, the serve banner (0.7), then the setup module (its restart and serve
   * lines are the banners).
   */
  function SetupArea() {
    const setup = useSetup();
    const done = useFixDone();
    const problems = setup.restart ? setup.problems.filter(function (p) { return p.id !== "restart-hermes"; }) : setup.problems;
    if (!setup.restart && !setup.serve && !setup.pick && !problems.length && !done) return null;
    return h(
      "div",
      { className: "rk-setuparea" },
      setup.restart ? h(RestartBanner, { restart: setup.restart }) : null,
      setup.pick ? h(PickProject, null) : null,
      setup.serve ? h(ServeBanner, { serve: setup.serve }) : null,
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
    // 0.7: no project yet, or a serve that does not run, says so here (a start waits on it, so it counts as blocking).
    const pick = !setup.restart && setup.pick;
    const serve = setup.restart || pick ? null : setup.serve;
    if (!setup.restart && !pick && !serve && (!first || (blockingOnly && first.severity !== "block"))) return null;
    const ch = setup.restart || pick ? "you" : serve ? SERVE_LOOK[serve.state].ch : first.severity === "block" ? "fail" : "you";
    const title = setup.restart ? setup.restart.title : pick ? "Pick the project roko works in." : serve ? serveTitle(serve) : first.title;
    const more = setup.restart ? 0 : pick || serve ? setup.problems.length : setup.problems.length - 1;
    return h(
      "div",
      { className: "roko-banner rk-livestrip rk-setupstrip roko-tone-scope" + (light ? " roko--light" : ""), role: "status", "data-roko": props.name || "setup-strip", "data-ch": ch, "data-serve": serve ? serve.state : undefined },
      h(LED, { ch: ch, blink: setup.restart ? "fast" : serve && serve.state === "starting" ? "slow" : false }),
      h("span", { className: "rk-chatstrip-name" }, "roko"),
      h("span", { className: "roko-banner-text", title: title }, title),
      more > 0 ? h("span", { className: "roko-dim roko-mono" }, "+" + more) : null,
      h("a", linkProps("/roko", { className: "roko-banner-link" }), setup.restart ? "how to restart →" : pick ? "pick a project →" : serve ? "open roko →" : first.fix.label + " →")
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
    // 0.7: the shown project's serve; one that does not run says its own state (the banner below has its keys).
    const serve = serveOf(data);
    const banner = setup.serve;
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
      connection = h("div", { className: "roko-conn" }, h(LED, { ch: "off" }), h("span", null, "connecting…"));
    } else if (setup.pick) {
      connection = h("div", { className: "roko-conn", "data-roko": "conn-pick" }, h(LED, { ch: "you", label: "no project yet" }), h("span", { className: "roko-conn-main" }, "no project yet"));
    } else if (banner && !conn.reachable) {
      connection = h(
        "div",
        { className: "roko-conn roko-conn--down", "data-roko": "conn-serve" },
        h(LED, { ch: SERVE_LOOK[banner.state].ch, label: "roko serve " + SERVE_LOOK[banner.state].word }),
        h("span", { className: "roko-conn-main" }, "roko serve " + SERVE_LOOK[banner.state].word)
      );
    } else if (conn.reachable) {
      const degraded = conn.status && conn.status !== "ok";
      connection = h(
        "div",
        { className: "roko-conn" },
        h(LED, { ch: degraded ? "you" : "pass", blink: false, label: degraded ? "roko is degraded" : "roko is up" }),
        h("span", { className: "roko-conn-main" }, "roko " + (conn.version ? str(conn.version) : "") + (conn.status ? " · " + str(conn.status) : "") + (serve && serve.state === "remote" ? " · remote" : "")),
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
    const live = setup.pick
      ? { word: "no project", ch: "you", blink: false, title: "Pick the project roko works in: a git checkout." }
      : banner
        ? { word: SERVE_LOOK[banner.state].word, ch: SERVE_LOOK[banner.state].ch, blink: banner.state === "starting" ? "slow" : false, title: serveTitle(banner) }
        : liveIndicator(liveState, rokoDown(data));

    return h(
      "div",
      { className: "roko-head", "data-roko": "status" },
      h(
        "div",
        { className: "roko-brand" },
        h("span", { className: "rk-wordmark", "aria-label": "roko" }, h("span", { className: "rk-wordmark-dot", "aria-hidden": "true" }), "roko"),
        connection,
        // Each change of the serve's state, said once (the banner's clock is not).
        h("span", { className: "rk-sr", role: "status", "aria-live": "polite", "data-roko": "serve-said" }, serve ? "roko serve " + SERVE_LOOK[serve.state].word : "")
      ),
      spend
        ? h(
            "div",
            { className: "roko-spend" },
            h(Well, { className: "rk-spendwell" }, h(Dots, { value: money(spend.today_usd), size: "L", pad: 6, ch: capTone(spend.today_usd, spend.max_day_usd) === "bad" ? "fail" : capTone(spend.today_usd, spend.max_day_usd) === "warn" ? "you" : undefined, label: spendWords(spend) })),
            h(
              "div",
              { className: "rk-spendinfo" },
              h(SegMeter, { value: spend.today_usd, projected: isNum(spend.committed_usd) ? (spend.today_usd || 0) + spend.committed_usd : null, max: spend.max_day_usd, label: "today's spend against the daily limit" }),
              // The counter, then (dim) the limit, what live runs hold and what is left, in the desktop's words.
              h(
                "span",
                { className: "roko-spend-text", "data-roko": "spend-words", title: todayLine(spend) },
                spendWords(spend),
                todayLine(spend).length > spendWords(spend).length ? h("span", { className: "roko-dim" }, todayLine(spend).slice(spendWords(spend).length)) : null
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
          ? h(Key, { tone: list(data.runs).length && !(banner && banner.actions.indexOf("start") >= 0) ? "you" : undefined, label: "new run", kbd: "n", ariaLabel: "New run", keys: "n", className: "roko-newrun", onClick: function () { props.onCompose(""); } })
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
    ["[ / ]", "The run's Overview, Activity, Loops and Changes; Learning's views"],
    ["Esc", "Close the task, or a dialog"],
    ["1 – 3", "Runs, Plans, Learning"],
    ["w", "What waits on you"],
    ["a / r", "Approve or reject the waiting card that has focus"],
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

  // ---------------------------------------------------------------------------
  // Learning (spec v3 §5.6, mockup 03): is roko getting better? 0.6.0's `GET /learning` (P6): the hero's three
  // numbers with their trends, where work passed on the ladder, the five loops as an orrery, the lessons that paid
  // off, and M1's homeostat; without it (an older backend), what the run rows show. The desktop's D7.
  // ---------------------------------------------------------------------------

  /** Learning's sub-views (spec v3 §5.6): the overview, the loops, the lessons, and the models (0.5.0's Insights). */
  const LEARNING_VIEWS = [
    { id: "learning", label: "overview" },
    { id: "loops", label: "loops" },
    { id: "knowledge", label: "lessons" },
    { id: "health", label: "models" },
  ];
  function isLearning(section) {
    return LEARNING_VIEWS.some(function (v) { return v.id === section; });
  }

  /**
   * A trend as braille dots (the kit's spark): a column a value, its height between the series' least and most, older
   * columns dimmer, the newest with a glowing head; `grid` lights the unlit dots faintly. Nothing under two values.
   */
  function Spark(props) {
    const vals = list(props.values).filter(isNum);
    if (vals.length < 2) return null;
    const width = props.width || 110;
    const height = props.height || 30;
    const pitch = 3.2;
    const cols = Math.max(2, Math.floor(width / pitch));
    const rows = Math.max(2, Math.floor(height / pitch));
    const min = Math.min.apply(null, vals);
    const max = Math.max.apply(null, vals);
    function top(v) { return rows - 1 - Math.round(max === min ? rows / 2 : ((v - min) / (max - min)) * (rows - 1)); }
    function at(i) { return vals[Math.min(vals.length - 1, Math.round((i / (cols - 1)) * (vals.length - 1)))]; }
    const dots = [];
    for (let c = 0; c < cols; c += 1) {
      const row = top(at(c));
      const cx = (c * pitch + pitch / 2).toFixed(1);
      for (let r = 0; r < rows; r += 1) {
        const cy = (r * pitch + pitch / 2).toFixed(1);
        if (r === row) dots.push(h("circle", { key: c + ":" + r, cx: cx, cy: cy, r: 1.05, opacity: (0.28 + 0.72 * (c / (cols - 1))).toFixed(2) }));
        else if (props.grid) dots.push(h("circle", { key: c + ":" + r, className: "rk-spark-grid", cx: cx, cy: cy, r: 0.55 }));
      }
    }
    return h(
      "svg",
      { className: "rk-spark2", "data-ch": props.ch || "ink", width: width, height: height, viewBox: "0 0 " + width + " " + height, "aria-hidden": "true" },
      dots,
      h("circle", { className: "rk-spark2-head", cx: ((cols - 1) * pitch + pitch / 2).toFixed(1), cy: (top(vals[vals.length - 1]) * pitch + pitch / 2).toFixed(1), r: 2 })
    );
  }

  /** A value per run: its cost per verified task, its first-try rate, its climbs. Null where a run cannot say. */
  const RUN_RATE = {
    usd: function (r) { return isNum(r.per_pass) ? r.per_pass : isNum(r.cost_usd) && isNum(r.passed) && r.passed ? r.cost_usd / r.passed : null; },
    first: function (r) { return isNum(r.first_try) && isNum(r.tasks) && r.tasks ? r.first_try / r.tasks : null; },
    climbs: function (r) { return isNum(r.climbs) ? r.climbs : null; },
  };
  function meanOf(values) {
    const vals = values.filter(isNum);
    return vals.length ? vals.reduce(function (a, b) { return a + b; }, 0) / vals.length : null;
  }
  /** The mean of a series' first or last third (at least 2 runs); null with too few runs to compare (under 4). */
  function thirdOf(series, pick, which) {
    const n = Math.max(2, Math.ceil(series.length / 3));
    return series.length >= 4 ? meanOf((which === "first" ? series.slice(0, n) : series.slice(-n)).map(pick)) : null;
  }

  /** One of M1's essential variables as the gauges draw it: pass_rate's bound is a floor, the others' a ceiling. */
  function essentialOf(v) {
    const name = str(v.ev || v.name);
    const floor = name === "pass_rate";
    const bound = isNum(v.bound) ? (floor ? { min: v.bound } : { max: v.bound }) : obj(v.bound) || {};
    return {
      name: name,
      value: isNum(v.value) ? v.value : null,
      bound: bound,
      inner: isNum(v.inner) ? (floor ? [v.inner, 1] : [0, v.inner]) : null,
      state: str(v.state) === "breached" || str(v.state) === "out" ? "out" : "ok",
    };
  }

  /**
   * The backend's learning view (0.6.0 `GET /learning`) as the overview draws it: each run's numbers and passes per
   * rung, the hero's numbers with their trends, the lessons that paid off, the homeostat. Only what the backend says.
   */
  function readLearning(raw) {
    const wp = obj(raw.where_passed);
    const passedBy = {};
    list(wp && wp.runs).filter(obj).forEach(function (r) { if (obj(r.passed)) passedBy[str(r.run_id)] = r.passed; });
    const series = list(raw.runs).filter(obj).map(function (r) {
      const rungs = list(r.rungs).filter(obj);
      const byRung = {};
      rungs.forEach(function (x) { byRung[str(x.rung)] = isNum(x.passed) ? x.passed : 0; });
      return {
        run_id: str(r.run_id),
        label: str(r.label),
        state: str(r.state),
        at: r.finished_at,
        cost_usd: isNum(r.cost_usd) ? r.cost_usd : null,
        tasks: isNum(r.tasks) ? r.tasks : null,
        passed: isNum(r.passed) ? r.passed : null,
        first_try: isNum(r.first_try) ? r.first_try : null,
        climbs: isNum(r.climbs) ? r.climbs : null,
        per_pass: isNum(r.cost_per_pass) ? r.cost_per_pass : null,
        per_pass_by: str(r.cost_per_pass_by),
        by_rung: passedBy[str(r.run_id)] || (rungs.length ? byRung : null),
      };
    });
    function kpi(key) {
      const k = obj(raw.kpis) && obj(raw.kpis[key]) ? raw.kpis[key] : {};
      return { trend: list(k.series).map(function (v) { return isNum(v) ? v : null; }), value: isNum(k.value) ? k.value : null, was: isNum(k.first) ? k.first : null };
    }
    // "What drove it" only from what the runs show (Q3): first tries with a lesson in the prompt against those without,
    // both n's always, the difference whichever way it points once each side has 5 tasks (else the backend's note), and
    // how the two sides were drawn: roko's control arm (randomised) or observational. The desktop's words.
    const lft = obj(raw.lessons_first_try);
    const withL = lft ? obj(lft.with) : null;
    const without = lft ? obj(lft.without) : null;
    function count(x, key) { return x && isNum(x[key]) ? x[key] : 0; }
    const diff = lft && lft.comparable === true && isNum(lft.difference) ? lft.difference : null;
    const points = diff === null ? "" : (diff >= 0 ? "+" : "−") + Math.abs(Math.round(diff * 100)) + " points";
    const design = lft && str(lft.design) === "control_arm" ? "roko's control arm (randomised)" : "observational";
    const driver = withL && without && (count(withL, "of") || count(without, "of"))
      ? [
          "with a lesson " + count(withL, "passed") + "/" + count(withL, "of") + " passed first try, without " + count(without, "passed") + "/" + count(without, "of"),
          points || oneLine(lft.note, 120),
          design,
        ].filter(Boolean).join(" · ")
      : "";
    const homeostat = obj(raw.homeostat);
    const controller = homeostat ? obj(homeostat.controller) : null;
    return {
      scope: str(raw.scope),
      scopeLabel: str(raw.scope_label),
      coverage: obj(raw.coverage),
      recorded: obj(raw.recorded_tasks),
      series: series,
      kpis: {
        usd_per_pass: Object.assign(kpi("cost_per_pass"), { source: series.length && series.slice(-3).every(function (r) { return r.per_pass_by === "roko"; }) ? "roko" : "" }),
        first_try_rate: Object.assign(kpi("first_try_rate"), { driver: driver }),
        climbs_per_run: kpi("climbs_per_run"),
      },
      ladder: list(wp && wp.rungs).filter(obj),
      share: wp && obj(wp.cheapest_share) && isNum(wp.cheapest_share.first) && isNum(wp.cheapest_share.last) ? { from: wp.cheapest_share.first, to: wp.cheapest_share.last } : null,
      lessons: list(raw.lessons).filter(obj).map(function (l) {
        return {
          id: str(l.id),
          text: str(l.text) || str(l.id),
          kept_by: obj(l.kept_by),
          confidence: isNum(l.confidence) ? l.confidence : null,
          uses: list(l.uses).filter(obj).map(function (u) { return u.first_try ? "first_try" : u.climbed ? "climbed" : u.passed ? "passed" : "failed"; }),
        };
      }),
      homeostat: homeostat
        ? {
            variables: list(homeostat.variables).filter(obj).map(essentialOf),
            controller: controller ? { phase: str(controller.phase), change: str(controller.change) } : null,
          }
        : null,
    };
  }

  /**
   * The learning view worked out from the run rows this page has (an older backend has no `/learning`): each ended
   * run's spend, passes and (0.6.0 rows' `rungs`) where they passed. First tries and climbs need the backend's view.
   */
  function learningFromRows(rows) {
    const series = list(rows)
      .filter(function (r) { return obj(r) && !isRunActive(r) && ["missing", "queued"].indexOf(str(r.state)) < 0 && r.kind !== "plan_generate"; })
      .slice(0, 30)
      .reverse()
      .map(function (r) {
        const p = obj(r.progress) || {};
        const rungs = list(r.rungs).filter(obj);
        const byRung = {};
        rungs.forEach(function (x) { byRung[str(x.rung)] = isNum(x.passed) ? x.passed : 0; });
        return {
          run_id: str(r.run_id),
          label: str(r.label),
          state: str(r.state),
          at: r.finished_at || r.started_at,
          cost_usd: isNum(r.cost_usd) ? r.cost_usd : null,
          tasks: isNum(p.total) ? p.total : null,
          passed: isNum(p.passed) ? p.passed : null,
          first_try: null,
          climbs: null,
          per_pass: null,
          per_pass_by: "",
          by_rung: rungs.length ? byRung : null,
        };
      });
    return { derived: true, scope: "", series: series, kpis: {}, ladder: [], share: null, lessons: [], homeostat: null };
  }

  /** One KPI: its value now, what the first runs showed, its trend per run, and the one line on what drove it. */
  function kpiOf(data, key, pick) {
    const given = obj(data.kpis) && obj(data.kpis[key]) ? data.kpis[key] : {};
    const series = list(data.series);
    const trend = list(given.trend).length ? list(given.trend) : series.map(pick);
    return {
      driver: str(given.driver),
      source: str(given.source),
      trend: trend,
      value: isNum(given.value) ? given.value : thirdOf(series, pick, "last") !== null ? thirdOf(series, pick, "last") : meanOf(series.map(pick)),
      was: isNum(given.was) ? given.was : thirdOf(series, pick, "first"),
    };
  }

  /** "↓ 38% · was $0.050 on your first runs": the change against the first runs, in the channel of better or worse. */
  function kpiDelta(kpi, lowerIsBetter, show) {
    if (kpi.value === null || kpi.was === null || kpi.was === 0) return null;
    const change = (kpi.value - kpi.was) / Math.abs(kpi.was);
    const better = lowerIsBetter ? change < -0.02 : change > 0.02;
    const worse = lowerIsBetter ? change > 0.02 : change < -0.02;
    return { arrow: change < 0 ? "↓" : "↑", change: change, ch: better ? "pass" : worse ? "you" : "dim", was: show(kpi.was) };
  }

  /**
   * The hero glass (spec v3 §5.6, bardo F7): cost per verified task in bone (Q2), with its trend and how it moved since
   * the first runs; passed on the first try (sage), with what drove it when the runs show it; climbs per run (rose).
   * `compact` is the analytics:top slot's.
   */
  function LearningHero(props) {
    const data = props.data;
    const runs = list(data.series).length;
    const usd = kpiOf(data, "usd_per_pass", RUN_RATE.usd);
    const first = kpiOf(data, "first_try_rate", RUN_RATE.first);
    const climbs = kpiOf(data, "climbs_per_run", RUN_RATE.climbs);
    const usdDelta = kpiDelta(usd, true, boneMoney);
    const firstDelta = kpiDelta(first, false, pct);
    const climbDelta = kpiDelta(climbs, true, function (v) { return v.toFixed(1); });
    // Why a number is missing: an older backend has no learning view; a current one has no ended run to count yet.
    const missing = data.derived ? "needs the plugin's learning view (0.6.0)" : "no ended run has said yet";
    const compact = !!props.compact;
    function note(delta, words, driver) {
      return h(
        "span",
        { className: "rk-kpi2-note", "data-ch": delta ? delta.ch : undefined },
        delta ? delta.arrow + " from " + delta.was : "",
        delta && driver && !compact ? " · " : "",
        driver && !compact ? h("b", null, driver) : delta ? "" : words
      );
    }
    return h(
      Glass,
      { className: "rk-lhero" + (compact ? " is-compact" : ""), grid: true, name: "learning-hero", label: "Is roko getting better", role: "group" },
      h(
        "div",
        { className: "rk-kpi2", "data-roko": "kpi-usd" },
        // Whose figure: roko's own cost per verified task when it gave one for the newest runs, else the plugin's.
        h(ModLabel, { n: 6, right: compact ? null : (usd.source === "roko" ? "roko's · " : "") + "last " + plural(runs, "run", "runs") }, "cost per verified task"),
        h(
          "div",
          { className: "rk-kpi2-big" },
          h(Dots, { value: boneMoney(usd.value), size: compact ? "XL" : "XXL", ch: "bone", label: usd.value === null ? "no verified task yet" : boneMoney(usd.value) + " per verified task" }),
          h(Spark, { values: usd.trend, width: compact ? 110 : 150, height: compact ? 30 : 40, ch: "bone", grid: true })
        ),
        usdDelta
          ? h(
              "span",
              { className: "rk-kpi2-delta", "data-ch": usdDelta.ch },
              Math.round(Math.abs(usdDelta.change) * 100) === 0
                ? "about the same as your first runs (" + usdDelta.was + ")"
                : usdDelta.arrow + " " + Math.round(Math.abs(usdDelta.change) * 100) + "% · was " + usdDelta.was + " on your first runs"
            )
          : h("span", { className: "rk-kpi2-note" }, usd.value === null ? missing : runs < 4 ? "the trend shows after 4 runs" : "")
      ),
      h("i", { className: "rk-lhero-div", "aria-hidden": "true" }),
      h(
        "div",
        { className: "rk-kpi2", "data-roko": "kpi-first" },
        h(ModLabel, { n: 7 }, "passed on the first try"),
        first.value === null
          ? null
          : h("div", { className: "rk-kpi2-big" }, h(Dots, { value: pct(first.value), size: compact ? "M" : "L", ch: "pass", label: pct(first.value) + " passed on the first try" }), h(Spark, { values: first.trend, ch: "pass" })),
        note(firstDelta, first.value === null ? missing : "", first.driver)
      ),
      h("i", { className: "rk-lhero-div", "aria-hidden": "true" }),
      h(
        "div",
        { className: "rk-kpi2", "data-roko": "kpi-climbs" },
        h(ModLabel, { n: 8 }, "climbs per run"),
        climbs.value === null
          ? null
          : h("div", { className: "rk-kpi2-big" }, h(Dots, { value: climbs.value.toFixed(1), size: compact ? "M" : "L", ch: "live", label: climbs.value.toFixed(1) + " climbs per run" }), h(Spark, { values: climbs.trend, ch: "live" })),
        note(climbDelta, climbs.value === null ? missing : "", "")
      )
    );
  }

  /** "oct 7": a run's day on the unit array's axis. */
  function dayWord(v) {
    const t = ms(v);
    if (!isFinite(t)) return "";
    try {
      return new Date(t).toLocaleDateString("en", { day: "numeric", month: "short" }).toLowerCase();
    } catch (_) {
      return "";
    }
  }

  /**
   * Where work passed (spec v3 §5.6, bardo B1): the ladder's rungs × the last 14 runs, a cell brighter the more tasks
   * passed on that rung in that run, and each rung's share of the passes; read left to right it shows the router's mass
   * moving down the ladder ("cheap ↑ 41% → 78% of passes"). A rung a chat's run cannot use is hatched.
   */
  function WhereWorkPassed(props) {
    const data = props.data;
    const runs = list(data.series).filter(function (r) { return obj(r.by_rung); }).slice(-14);
    const rungs = (list(data.ladder).length ? list(data.ladder) : list(props.ladder)).filter(function (r) { return obj(r) && str(r.rung); });
    let names = rungs.map(function (r) { return str(r.rung); });
    if (!names.length) {
      runs.forEach(function (r) { Object.keys(r.by_rung).forEach(function (n) { if (names.indexOf(n) < 0) names.push(n); }); });
    }
    const head = h(ModLabel, { n: 9, right: "a cell per run, brighter = more tasks passed on that rung" }, "where work passed");
    if (!runs.length || !names.length) {
      return h(
        Glass,
        { className: "rk-lpanel", grid: true, name: "where-passed" },
        head,
        h("p", { className: "rk-lempty" }, rungs.length || runs.length ? "Each run that ends adds a column: where on the ladder its tasks passed." : "This workspace's roko.toml names no model ladder, so there are no rungs to place passes on.")
      );
    }
    function passes(subset, name) { return subset.reduce(function (n, r) { return n + (isNum(r.by_rung[name]) ? r.by_rung[name] : 0); }, 0); }
    function all(subset) { return names.reduce(function (n, name) { return n + passes(subset, name); }, 0); }
    function shareOf(subset, name) { return all(subset) ? passes(subset, name) / all(subset) : null; }
    const part = Math.max(1, Math.ceil(runs.length / 3));
    const moves = names
      .map(function (name) { return { name: name, from: shareOf(runs.slice(0, part), name), to: shareOf(runs.slice(-part), name) }; })
      .filter(function (m) { return m.from !== null && m.to !== null && runs.length >= 4; })
      .sort(function (a, b) { return Math.abs(b.to - b.from) - Math.abs(a.to - a.from); });
    // The backend's measure when it gives one: the cheapest rung's share of passes, first 3 runs against the last 3.
    const share = data.share ? { name: names[0], from: data.share.from, to: data.share.to } : null;
    const moved = share || (moves[0] && Math.abs(moves[0].to - moves[0].from) >= 0.05 ? moves[0] : null);
    const off = rungs.filter(function (r) { return r.chat_ok === false; }).map(function (r) { return str(r.rung); });
    return h(
      Glass,
      { className: "rk-lpanel", grid: true, name: "where-passed" },
      head,
      h(
        "div",
        { className: "rk-heat", role: "table", "aria-label": "Where tasks passed on the ladder, the last " + plural(runs.length, "run", "runs"), style: { "--rk-heat-n": runs.length } },
        names.slice().reverse().map(function (name) {
          const rung = rungs.filter(function (r) { return str(r.rung) === name; })[0];
          const hatched = off.indexOf(name) >= 0;
          const whole = shareOf(runs, name);
          const m = moved && moved.name === name ? moved : null;
          return h(
            "div",
            { key: name, className: "rk-heat-row", role: "row", "data-rung": name, "data-off": hatched ? "true" : undefined },
            h("span", { className: "rk-heat-rung", role: "rowheader" }, name, rung ? h("small", null, str(rung.slug) || str(rung.model)) : null),
            runs.map(function (r, i) {
              const n = hatched ? 0 : isNum(r.by_rung[name]) ? r.by_rung[name] : 0;
              return h("span", {
                key: r.run_id || i,
                className: "rk-heat-cell",
                role: "cell",
                "data-n": String(Math.min(5, n)),
                "data-now": i === runs.length - 1 ? "true" : undefined,
                "aria-label": (oneLine(r.label, 40) || shortId(r.run_id)) + ": " + plural(n, "task", "tasks") + " passed on " + name,
              });
            }),
            h("span", { className: "rk-heat-share", role: "cell" }, hatched || whole === null ? h("i", null, "—") : pct(whole), m && Math.abs(m.to - m.from) >= 0.01 ? h("i", null, m.to > m.from ? " ↑" : " ↓") : null)
          );
        }),
        h(
          "div",
          { className: "rk-heat-row rk-heat-axis", "aria-hidden": "true" },
          h("span", null),
          runs.map(function (r, i) {
            return h("span", { key: r.run_id || i, "data-now": i === runs.length - 1 ? "true" : undefined }, i === runs.length - 1 ? "now" : i % 3 === 0 ? dayWord(r.at) : "");
          }),
          h("span", null)
        )
      ),
      h(
        "div",
        { className: "rk-heat-foot" },
        moved ? h("span", { "data-roko": "heat-moved" }, h("b", null, moved.name + " " + (moved.to > moved.from ? "↑" : "↓")), " " + pct(moved.from) + " → " + pct(moved.to) + " of passes") : null,
        off.length ? h("span", null, off.join(", ") + ": not for chat runs") : null,
        h("span", { className: "rk-heat-now" }, "▔ now: the newest run")
      )
    );
  }

  /** How far back each ring of the orrery reaches: L0 two minutes, L1 an hour, L2 a day, L3 two weeks, L4 twelve. */
  const ORRERY_WINDOW = { L0: 120000, L1: 3600000, L2: 86400000, L3: 14 * 86400000, L4: 84 * 86400000 };

  /**
   * The five loops as an orrery (spec v3 §4.9): L0 inside to L4 outside, each ring with its label at a gap. A loop
   * event is a mark on its ring, behind the rose hand at "now" by its age on that ring's clock, brighter the newer;
   * its colour is its channel (L1 failures red, L2 holds orange, L3 and L4 indigo). The newest lesson glows on L3.
   * `span` puts every ring on one clock (a run's own events, ending at its last). The desktop's Orrery.
   */
  function Orrery(props) {
    const events = list(props.events).filter(function (e) { return obj(e) && isNum(e.ts); });
    const now = props.now;
    const size = props.size || 220;
    const span = isNum(props.span) ? props.span : null;
    const cx = 110;
    const cy = 106;
    const R = [28, 46, 64, 82, 100];
    const hand = -60;
    const k = size / 220;
    function polar(r, deg) { return [cx + r * Math.cos((deg * Math.PI) / 180), cy + r * Math.sin((deg * Math.PI) / 180)]; }
    const w0 = polar(108, hand - 40);
    const w1 = polar(108, hand);
    const hp = polar(104, hand);
    const lesson = events.slice().reverse().filter(function (e) { return e.ring === "L3" && e.kind === "knowledge" && now - e.ts < (span || ORRERY_WINDOW.L3); })[0] || null;
    const lp = polar(R[3], hand - 6);
    const ids = RINGS.map(function (r) { return r.id; });
    const marks = events.slice(-240).map(function (e, j) {
      const i = ids.indexOf(str(e.ring));
      const age = i < 0 ? 2 : Math.max(0, now - e.ts) / (span || ORRERY_WINDOW[ids[i]]);
      if (age > 1) return null;
      const deg = hand - 12 - age * 300;
      const half = (i < 2 ? 3.2 : 5.5) / 2;
      const p = polar(R[i], deg);
      const dx = Math.cos((deg * Math.PI) / 180) * half;
      const dy = Math.sin((deg * Math.PI) / 180) * half;
      return h("line", {
        key: str(e.key) || j,
        className: "rk-orrery-tick",
        "data-ch": loopChannel(e),
        "data-ring": str(e.ring),
        opacity: (0.95 - age * 0.8).toFixed(2),
        strokeWidth: i > 2 ? 2.4 : 1.8,
        x1: (p[0] - dx).toFixed(1),
        y1: (p[1] - dy).toFixed(1),
        x2: (p[0] + dx).toFixed(1),
        y2: (p[1] + dy).toFixed(1),
      });
    });
    const shown = marks.filter(Boolean).length;
    return h(
      "div",
      { className: "rk-orrery", "data-roko": "orrery", role: "img", "aria-label": props.label || plural(shown, "loop event", "loop events") + " on five rings", style: { width: size + "px", height: Math.round(212 * k) + "px" } },
      h(
        "svg",
        { width: size, height: Math.round(212 * k), viewBox: "0 0 220 212", "aria-hidden": "true" },
        h("path", { className: "rk-orrery-sweep", d: "M" + cx + " " + cy + " L" + w0[0].toFixed(1) + " " + w0[1].toFixed(1) + " A108 108 0 0 1 " + w1[0].toFixed(1) + " " + w1[1].toFixed(1) + " Z" }),
        R.map(function (r, i) {
          const gap0 = -128 - i * 4;
          const a = polar(r, gap0 + 22);
          const b = polar(r, gap0 + 360);
          const t = polar(r, gap0 + 11);
          return h(
            Fragment,
            { key: ids[i] },
            h("path", { className: "rk-orrery-ring", d: "M" + a[0].toFixed(1) + " " + a[1].toFixed(1) + " A" + r + " " + r + " 0 1 1 " + b[0].toFixed(1) + " " + b[1].toFixed(1) }),
            h("text", { className: "rk-orrery-label", textAnchor: "middle", x: t[0].toFixed(1), y: (t[1] + 3).toFixed(1) }, ids[i])
          );
        }),
        marks,
        lesson ? h("circle", { className: "rk-orrery-lesson", cx: lp[0].toFixed(1), cy: lp[1].toFixed(1), r: 3.6 }) : null,
        h("line", { className: "rk-orrery-hand", x1: cx, y1: cy, x2: hp[0].toFixed(1), y2: hp[1].toFixed(1) }),
        h("circle", { className: "rk-orrery-hub", cx: cx, cy: cy, r: 17 }),
        // roko's mark at the centre: indigo for a minute after a lesson lands, else rose.
        h("circle", { className: "rk-orrery-core", "data-ch": lesson && now - lesson.ts < 60000 ? "learn" : "live", cx: cx, cy: cy, r: 4.5 })
      )
    );
  }

  /** A ring's clock, short: sec, min, hrs, days, wks. */
  const CLOCK_SHORT = { seconds: "sec", minutes: "min", hours: "hrs", days: "days", weeks: "wks" };

  /** The five loops (spec v3 §4.9): the orrery, then per ring its name, clock and count, then the latest learning. */
  function FiveLoops(props) {
    const now = props.now;
    const shown = list(props.events).filter(function (e) { return obj(e) && isNum(e.ts) && ["L0", "L1", "L2", "L3", "L4"].indexOf(str(e.ring)) >= 0; });
    // The log is learning's events; the homeostat's readings (`essential`) have their meters.
    const log = shown.filter(function (e) { return ["L2", "L3", "L4"].indexOf(e.ring) >= 0 && e.kind !== "essential"; }).slice(-4).reverse();
    return h(
      Glass,
      { className: "rk-lpanel", grid: true, name: "five-loops" },
      h(ModLabel, { n: 10, right: "each event lands on its ring as it happens" }, "five loops"),
      h(
        "div",
        { className: "rk-orr" },
        h(Orrery, { events: shown, now: now }),
        h(
          "div",
          { className: "rk-orr-side" },
          h(
            "div",
            { className: "rk-orr-rings" },
            RINGS.map(function (ring) {
              const mine = shown.filter(function (e) { return e.ring === ring.id && now - e.ts <= ORRERY_WINDOW[ring.id]; });
              const last = mine[mine.length - 1];
              return h(
                "div",
                { key: ring.id, className: "rk-orr-ring", "data-roko": "orrery-" + ring.id },
                h(LED, { ch: last ? loopChannel(last) : "off", blink: false }),
                h("span", null, ring.name),
                h("span", { className: "rk-orr-k" }, ring.id + " · " + (CLOCK_SHORT[ring.clock] || ring.clock)),
                h("span", { className: "rk-orr-n" }, String(mine.length))
              );
            })
          ),
          log.length
            ? h(
                "div",
                { className: "rk-orr-log", "data-roko": "learning-log" },
                log.map(function (e, i) {
                  return h(
                    "div",
                    { key: str(e.key) || i, className: "rk-orr-ev", "data-ch": loopChannel(e), style: { opacity: 1 - i * 0.16 } },
                    h("span", { className: "rk-orr-g" }, e.kind === "knowledge" ? "◇" : e.kind === "thresholds" ? "▮" : "◆"),
                    h("span", { className: "rk-orr-t" }, ago(e.ts, now)),
                    h("span", { className: "rk-orr-x" }, oneLine(e.text, 160) || LOOP_WORD[e.kind] || str(e.kind))
                  );
                })
              )
            : h("p", { className: "rk-lempty" }, "Lessons, thresholds and loop health land here as roko learns.")
        )
      )
    );
  }

  /** A confidence as five bars: solid, eroding (bardo's decay zones █▓▒░), then empty. */
  function Confidence(props) {
    if (!isNum(props.value)) return null;
    const filled = clamp(props.value, 0, 1) * 5;
    const bars = [];
    for (let i = 0; i < 5; i += 1) bars.push(h("i", { key: i, "data-z": filled >= i + 1 ? "on" : filled > i + 0.5 ? "e1" : filled > i ? "e2" : "o" }));
    return h("span", { className: "rk-conf", role: "img", "aria-label": "confidence " + pct(props.value) }, bars);
  }

  /**
   * One lesson that paid off (spec v3 §4.11): ◇, the lesson, who kept it, and its chain of later tasks, a square each:
   * sage when it passed on the first try, a rose outline when it climbed; "2/2 first try".
   */
  function LessonChain(props) {
    const lesson = props.lesson;
    const uses = list(lesson.uses);
    const firstTry = uses.filter(function (u) { return u === "first_try"; }).length;
    const climbed = uses.filter(function (u) { return u === "climbed"; }).length;
    const kept = obj(lesson.kept_by) || {};
    const keptAt = ms(kept.at);
    const now = props.now;
    return h(
      "div",
      { className: "rk-chain", role: "listitem", "data-roko": "lesson-paid" },
      h("span", { className: "rk-chain-g", "aria-hidden": "true" }, "◇"),
      h(
        "div",
        { className: "rk-chain-body" },
        h("p", { title: str(lesson.text) }, oneLine(lesson.text, 240)),
        h(
          "small",
          null,
          "kept ",
          isFinite(keptAt) && now - keptAt > 3600000 ? ago(keptAt, now) + " " : "",
          str(kept.run_id)
            ? h(
                Fragment,
                null,
                "by ",
                props.onOpenRun
                  ? h("button", { type: "button", className: "rk-chain-run", onClick: function () { props.onOpenRun(str(kept.run_id)); } }, shortId(kept.run_id) + (kept.task_id ? " · " + oneLine(kept.task_id, 12) : ""))
                  : h("span", { className: "roko-mono" }, shortId(kept.run_id) + (kept.task_id ? " · " + oneLine(kept.task_id, 12) : ""))
              )
            : "before these runs",
          " · in " + plural(uses.length, "prompt", "prompts") + " since",
          isNum(lesson.confidence) ? h(Fragment, null, " · confidence ", h(Confidence, { value: lesson.confidence })) : null
        )
      ),
      h(
        "div",
        { className: "rk-payoff" },
        h("span", { className: "rk-payoff-seq", "aria-hidden": "true" }, h("span", { className: "rk-payoff-arrow" }, "→"), uses.slice(-12).map(function (u, i) { return h("i", { key: i, "data-outcome": u }); })),
        h(
          "span",
          { className: "rk-payoff-n", "data-ch": uses.length && firstTry === uses.length ? "pass" : undefined },
          uses.length ? firstTry + "/" + uses.length + (firstTry === uses.length ? " first try" : climbed ? " · " + climbed + " climbed" : " first try") : "not used yet"
        )
      )
    );
  }

  /** Lessons that paid off (spec v3 §5.6): the three whose later tasks passed first try most (`all`: every one). */
  function LessonsPaid(props) {
    const data = props.data;
    const lessons = list(data.lessons).slice(0, props.all ? 10 : 3);
    return h(
      Glass,
      { className: "rk-lpanel", grid: true, name: "lessons-paid" },
      h(ModLabel, { n: 11, right: "kept by one run, used by later ones" }, "lessons that paid off"),
      lessons.length
        ? h("div", { className: "rk-paid", role: "list", "aria-label": "Lessons that paid off" }, lessons.map(function (l, i) { return h(LessonChain, { key: l.id || i, lesson: l, now: props.now, onOpenRun: props.onOpenRun }); }))
        : h(
            "p",
            { className: "rk-lempty" },
            data.derived ? "Which lessons paid off needs the plugin's learning view (0.6.0)." : "No lesson has paid off yet: one does when a later task has it in its prompt and passes on the first try."
          )
    );
  }

  /** roko's essential variables (M1's homeostat, `homeostasis.rs`): their names and how to show them. */
  const ESSENTIALS = {
    pass_rate: { label: "pass rate", unit: "ratio", show: function (v) { return pct(v); } },
    usd_per_verified_success: { label: "$ per verified pass", unit: "usd", show: function (v) { return boneMoney(v); } },
    false_green: { label: "false green", unit: "ratio", show: function (v) { return pct(v); } },
    latency_p90_s: { label: "p90 wait", unit: "s", show: function (v) { return clock(v); }, say: function (v) { return plural(Math.round(v), "second", "seconds"); } },
  };

  /**
   * One essential variable as an analog meter (spec v3 §4.10, bardo B21): an arc, its bounds in sage, a needle that
   * moves slowly, the value in dots. Out of bounds the needle and the value turn red and a hazard tick marks the bound.
   * The scale is 0–1 for a ratio (×4 its bound when that is under 0.5), else 1.5× the largest number.
   */
  function Gauge(props) {
    const v = props.variable;
    const meta = ESSENTIALS[v.name] || { label: v.name.replace(/_/g, " "), unit: "", show: function (x) { return String(x); } };
    const value = v.value;
    const lo = isNum(v.bound.min) ? v.bound.min : null;
    const hi = isNum(v.bound.max) ? v.bound.max : null;
    const inner = list(v.inner);
    const scaleMax = meta.unit === "ratio" ? (hi !== null && hi < 0.5 ? Math.min(1, hi * 4) : 1) : Math.max(hi || 0, value || 0, lo || 0) * 1.5 || 1;
    const out = v.state === "out" || (value !== null && ((lo !== null && value < lo) || (hi !== null && value > hi)));
    const shown = useLerp(value, 0.8);
    const gx = 52;
    const gy = 50;
    const r = 40;
    function ang(x) { return Math.PI + (clamp(x, 0, scaleMax) / scaleMax) * Math.PI; }
    function pt(a, rr) { return [gx + rr * Math.cos(a), gy + rr * Math.sin(a)]; }
    function arc(v0, v1, rr) {
      const a = pt(ang(v0), rr);
      const b = pt(ang(v1), rr);
      return "M" + a[0].toFixed(1) + " " + a[1].toFixed(1) + " A" + rr + " " + rr + " 0 0 1 " + b[0].toFixed(1) + " " + b[1].toFixed(1);
    }
    const needle = pt(ang(isNum(shown) ? shown : 0), r - 2);
    const boundAt = lo !== null ? lo : hi;
    const boundWords = lo !== null ? "≥ " + meta.show(lo) : hi !== null ? "≤ " + meta.show(hi) : "";
    const say = meta.say || meta.show;
    const boundSaid = lo !== null ? "≥ " + say(lo) : hi !== null ? "≤ " + say(hi) : "";
    const ticks = [];
    for (let t = 0; t <= 10; t += 1) {
      const a = Math.PI + (t / 10) * Math.PI;
      const p0 = pt(a, r + 5);
      const p1 = pt(a, r + (t % 5 ? 7 : 9));
      ticks.push(h("line", { key: t, className: "rk-gauge-tick", x1: p0[0].toFixed(1), y1: p0[1].toFixed(1), x2: p1[0].toFixed(1), y2: p1[1].toFixed(1) }));
    }
    const hz0 = boundAt !== null ? pt(ang(boundAt), r - 7) : null;
    const hz1 = boundAt !== null ? pt(ang(boundAt), r + 9) : null;
    return h(
      "div",
      {
        className: "rk-gauge",
        role: "img",
        "data-out": out ? "true" : undefined,
        "data-roko": "gauge-" + v.name,
        "aria-label": meta.label + ": " + (value === null ? "unknown" : say(value)) + (boundSaid ? ", bound " + boundSaid : "") + (out ? ", out of bounds" : ""),
      },
      h(
        "svg",
        { width: 104, height: 58, viewBox: "0 0 104 58", "aria-hidden": "true" },
        h("path", { className: "rk-gauge-track", d: arc(0, scaleMax, r) }),
        h("path", { className: "rk-gauge-band", d: arc(lo !== null ? lo : 0, hi !== null ? hi : scaleMax, r) }),
        inner.length === 2 && inner.every(isNum) ? h("path", { className: "rk-gauge-inner", d: arc(inner[0], inner[1], r + 4) }) : null,
        ticks,
        out && hz0 ? h("line", { className: "rk-gauge-hazard", x1: hz0[0].toFixed(1), y1: hz0[1].toFixed(1), x2: hz1[0].toFixed(1), y2: hz1[1].toFixed(1) }) : null,
        value !== null ? h("line", { className: "rk-gauge-needle", x1: gx, y1: gy, x2: needle[0].toFixed(1), y2: needle[1].toFixed(1) }) : null,
        h("circle", { className: "rk-gauge-hub", cx: gx, cy: gy, r: 3 })
      ),
      h(Dots, { value: value === null ? "-" : meta.show(value).replace(/^\$0\./, "$."), size: "S", ch: out ? "fail" : "pass", label: value === null ? "unknown" : meta.show(value) }),
      h("span", { className: "rk-gauge-label" }, meta.label),
      boundWords ? h("span", { className: "rk-gauge-bound" }, boundWords) : null
    );
  }

  /** "M1 holding · all four in bounds", "M1 moved tier_floor cheap → mid", or what is out of bounds. */
  function controllerWords(homeostat) {
    const variables = list(homeostat.variables);
    const out = variables.filter(function (v) { return v.state === "out"; });
    const controller = obj(homeostat.controller) || {};
    // roko's M1 says its last act as "knob: from -> to".
    const change = /^\s*([^:]+):\s*(.+?)\s*->\s*(.+?)\s*$/.exec(str(controller.change));
    const head = change
      ? "M1 moved " + oneLine(change[1], 30) + " " + oneLine(change[2], 20) + " → " + oneLine(change[3], 20)
      : str(controller.phase) === "search"
        ? "M1 searching: it is trying a knob"
        : "M1 holding";
    const tail = !variables.length
      ? ""
      : out.length
        ? out.map(function (v) { return (ESSENTIALS[v.name] || { label: v.name }).label; }).join(", ") + " out of bounds"
        : variables.length === 4 ? "all four in bounds" : "all in bounds";
    return { out: out.length > 0, text: [head, tail].filter(Boolean).join(" · ") };
  }

  /** The homeostat (spec v3 §4.10): M1 keeps four essential variables inside their bounds. */
  function Homeostat(props) {
    const data = props.data;
    const homeostat = obj(data.homeostat);
    const variables = homeostat ? list(homeostat.variables) : [];
    const words = homeostat ? controllerWords(homeostat) : null;
    return h(
      Glass,
      { className: "rk-lpanel", grid: true, name: "homeostat" },
      h(ModLabel, { n: 12, right: "M1 keeps four variables inside their bounds" }, "homeostat"),
      variables.length
        ? h("div", { className: "rk-homeo" }, variables.slice(0, 4).map(function (v) { return h(Gauge, { key: v.name, variable: v }); }))
        : h(
            "p",
            { className: "rk-lempty" },
            data.derived ? "The homeostat needs the plugin's learning view (0.6.0)." : "roko has reported no essential variables yet: its controller, M1, publishes them while it runs."
          ),
      words ? h("div", { className: "rk-m1", "data-roko": "m1-line" }, h(LED, { ch: words.out ? "fail" : "pass", blink: false }), h("span", null, words.text)) : null
    );
  }

  /**
   * What roko learned, read once a minute (0.6.0 `GET /learning`, for `scope`: the runs Hermes started, or every plan
   * run in the workspace), with the homeostat moved by the socket's `essential` and `controller` loop frames; from the
   * run rows when the backend has no learning view (null while it loads).
   */
  function useLearningData(scope) {
    const res = useResource("/learning" + (scope === "workspace" ? "?scope=workspace" : ""), 60000);
    const ov = useOverview();
    useLiveVersion(undefined, ["loop"]);
    const base = res.data && res.data.ok !== false && (list(res.data.runs).length || obj(res.data.kpis))
      ? readLearning(res.data)
      : res.status === "loading" && !res.data
        ? null
        : learningFromRows(ov.data ? ov.data.runs : []);
    if (!base || base.derived) return base;
    const vars = {};
    let controller = null;
    liveStore.loops().forEach(function (e) {
      const d = obj(e.data);
      if (e.kind === "essential" && d && str(d.ev)) vars[str(d.ev)] = essentialOf(d);
      else if (e.kind === "controller" && d) controller = { phase: str(d.phase), change: str(d.change) };
    });
    if (!Object.keys(vars).length && !controller) return base;
    const had = base.homeostat ? list(base.homeostat.variables) : [];
    const variables = had.map(function (v) { return vars[v.name] || v; }).concat(Object.keys(vars).filter(function (n) { return !had.some(function (v) { return v.name === n; }); }).map(function (n) { return vars[n]; }));
    return Object.assign({}, base, { homeostat: { variables: variables, controller: controller || (base.homeostat && base.homeostat.controller) || null } });
  }

  /**
   * Learning's overview (spec v3 §5.6, mockup 03), most important first: does a passed task get cheaper, do tasks
   * pass on the first try, do they climb less; where work passed; the five loops; the lessons that paid off; the
   * homeostat.
   */
  function LearningOverview(props) {
    const [scope, setScope] = useState(readLearningScope);
    const data = useLearningData(scope);
    const ov = useOverview();
    const now = useNow(5000, true);
    function pickScope(id) {
      setScope(id);
      try { window.localStorage.setItem(LEARNING_SCOPE_KEY, id); } catch (_) { /* a private window keeps no pick */ }
    }
    const loops = useResource("/loops", 60000);
    if (!data) return h(Loading, { label: "Reading what roko learned…" });
    const rings = loops.data ? list(loops.data.rings).filter(obj) : [];
    const recent = [];
    rings.forEach(function (r) { list(r.recent).forEach(function (ev) { recent.push(Object.assign({ ring: r.ring }, ev)); }); });
    const events = mergeLoops(recent, liveStore.loops());
    const runs = list(data.series).length;
    const first = runs ? ms(data.series[0].at) : NaN;
    const days = isFinite(first) ? Math.max(1, Math.round((now - first) / 86400000)) : null;
    return h(
      "div",
      { className: "rk-learn", "data-roko": "learning-overview" },
      // Whose runs these numbers are, over how long, and where they rest on less (`coverage.note`).
      h(
        "div",
        { className: "rk-lscope", "data-roko": "learning-scope" },
        data.derived
          ? h(Tag, null, "this page's runs")
          : h(
              "span",
              { className: "rk-seg", role: "group", "aria-label": "Whose runs" },
              [["hermes", "runs from hermes"], ["workspace", "workspace"]].map(function (pair) {
                return h(
                  "button",
                  { key: pair[0], type: "button", "aria-pressed": scope === pair[0] ? "true" : "false", "data-roko": "learning-scope-" + pair[0], title: scope === pair[0] && data.scopeLabel ? data.scopeLabel : undefined, onClick: function () { pickScope(pair[0]); } },
                  pair[1]
                );
              })
            ),
        h(
          "span",
          { "data-roko": "learning-window" },
          [
            data.coverage && isNum(data.coverage.found) && data.coverage.found > runs ? runs + " of " + plural(data.coverage.found, "ended run", "ended runs") : plural(runs, "ended run", "ended runs"),
            days ? "over " + plural(days, "day", "days") : "",
          ].filter(Boolean).join(" · ")
        ),
        // roko's own spend over every task it recorded (the workspace scope).
        data.recorded && isNum(data.recorded.tasks)
          ? h(
              "span",
              { "data-roko": "learning-recorded" },
              "roko recorded " + plural(data.recorded.tasks, "task", "tasks") +
                (isNum(data.recorded.cost_usd) ? ": " + money(data.recorded.cost_usd) : "") +
                (isNum(data.recorded.cost_per_task_usd) ? ", " + moneyFine(data.recorded.cost_per_task_usd) + " a task" : "") +
                (isNum(data.recorded.typical_task_ms) ? ", typically " + duration(data.recorded.typical_task_ms) : "")
            )
          : null,
        // An older backend answers for Hermes' runs whatever was asked: say so rather than show them as the workspace's.
        !data.derived && data.scope && data.scope !== scope
          ? h("span", { className: "rk-lscope-note", "data-roko": "learning-coverage" }, "this backend answers for runs started from Hermes only")
          : data.coverage && str(data.coverage.note)
            ? h("span", { className: "rk-lscope-note", "data-roko": "learning-coverage" }, oneLine(data.coverage.note, 240))
            : null
      ),
      h(LearningHero, { data: data }),
      h("div", { className: "rk-lrow" }, h(WhereWorkPassed, { data: data, ladder: ov.data ? ov.data.ladder : null }), h(FiveLoops, { events: events, now: now })),
      h("div", { className: "rk-lrow" }, h(LessonsPaid, { data: data, now: now, onOpenRun: props.onOpenRun }), h(Homeostat, { data: data }))
    );
  }

  /** Whose runs Learning's overview counts, as the person last picked it in this browser: "hermes" or "workspace". */
  const LEARNING_SCOPE_KEY = "roko-learning-scope";
  function readLearningScope() {
    try {
      return window.localStorage.getItem(LEARNING_SCOPE_KEY) === "workspace" ? "workspace" : "hermes";
    } catch (_) {
      return "hermes";
    }
  }

  /** Learning's sub-views as a row of sub-tabs: 01 overview · 02 loops · 03 lessons · 04 models. */
  function LearningTabs(props) {
    return h(
      "div",
      { className: "rk-subtabs", role: "tablist", "aria-label": "Learning views", "data-roko": "learning-tabs" },
      LEARNING_VIEWS.map(function (v, i) {
        return h(
          "button",
          { key: v.id, type: "button", role: "tab", className: "rk-subtab", "aria-selected": props.section === v.id ? "true" : "false", onClick: function () { props.onPick(v.id); } },
          h("b", { "aria-hidden": "true" }, "0" + (i + 1)),
          v.label
        );
      })
    );
  }

  /** "◇ 2" on the Learning tab: the lessons that landed in the last ten minutes, as the socket brings them. */
  function LessonCount() {
    useLiveVersion(undefined, ["loop"]);
    const n = liveStore.loops().filter(function (e) { return e.ring === "L3" && e.kind === "knowledge" && Date.now() - (e.ts || 0) < 600000; }).length;
    return n ? h("span", { className: "rk-tab-lessons", "data-roko": "learning-count" }, "◇ " + n) : null;
  }

  let learningView = "learning";

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
      if (isLearning(id)) learningView = id;
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

    // Page keys: n, j/k, 1–5, w, ?. They stay out of text fields and open dialogs.
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
        } else if (/^[1-9]$/.test(key) && Number(key) <= TABS.length) {
          event.preventDefault();
          setSection(TABS[Number(key) - 1].id === "learning" ? learningView : TABS[Number(key) - 1].id);
        } else if ((key === "[" || key === "]") && isLearning(s.section)) {
          event.preventDefault();
          const ids = LEARNING_VIEWS.map(function (v) { return v.id; });
          setSection(ids[(ids.indexOf(s.section) + (key === "]" ? 1 : ids.length - 1)) % ids.length]);
        } else if (key === "w") {
          event.preventDefault();
          setSection("waiting");
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
    } else if (section === "learning") {
      body = h(LearningOverview, { onOpenRun: selectRun });
    } else if (section === "loops") {
      body = h(LoopsSection, null);
    } else if (section === "knowledge") {
      body = h(KnowledgeSection, { onOpenRun: selectRun });
    } else if (section === "health") {
      body = h(HealthSection, null);
    }

    // roko down: its running count is a last known one, not a badge.
    const badges = { runs: rokoDown(data) ? 0 : c.running + c.queued };
    // roko learns from runs that ended: until one has, Learning has nothing of this workspace's to show.
    const ended = runs.some(function (r) { return obj(r) && !isRunActive(r) && r.state !== "queued"; });
    return h(
      "div",
      { className: "roko" + (light ? " roko--light" : ""), "data-roko": "page" },
      h(StatusHeader, { overview: ov, onCompose: compose, onHelp: function () { setHelp(true); } }),
      blocked ? null : h(SetupArea, null),
      data && ov.error ? h(ErrorNote, { error: ov.error, onRetry: function () { overviewStore.refresh(); } }) : null,
      blocked
        ? null
        : h(
            "div",
            { className: "rk-tabrow" },
            h(
            TabsList,
            { className: "roko-tabs", role: "tablist", "aria-label": "roko sections" },
            TABS.map(function (s) {
              const count = badges[s.id];
              const on = s.id === "learning" ? isLearning(section) : section === s.id;
              return h(
                TabsTrigger,
                {
                  key: s.id,
                  value: s.id,
                  active: on,
                  role: "tab",
                  "aria-selected": on ? "true" : "false",
                  "data-ghost": s.id === "learning" && !ended ? "true" : undefined,
                  title: s.id === "learning" ? (ended ? "What roko learned: lessons, its loops, models and checks" : "roko starts learning when your first run ends") : undefined,
                  onClick: function () { setSection(s.id === "learning" ? learningView : s.id); },
                },
                s.label,
                count ? h("span", { className: "roko-tabcount roko-tone-run" }, String(count)) : null,
                s.id === "learning" ? h(LessonCount, null) : null
              );
            })
            ),
            c.waiting || section === "waiting"
              ? h(
                  "button",
                  {
                    type: "button",
                    className: "rk-waitbadge",
                    "data-roko": "wait-badge",
                    "aria-pressed": section === "waiting" ? "true" : "false",
                    "aria-keyshortcuts": "w",
                    title: "What waits on you (w)",
                    onClick: function () { setSection("waiting"); },
                  },
                  h("i", { className: "rk-diamond", "aria-hidden": "true" }),
                  c.waiting ? c.waiting + (c.waiting === 1 ? " waits on you" : " wait on you") : "nothing waits on you"
                )
              : null,
            // 0.7: which project the tabs show, at the row's end.
            h(ProjectSwitch, { data: data })
          ),
      !blocked && isLearning(section) ? h(LearningTabs, { section: section, onPick: setSection }) : null,
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
    // roko down: the counts are its last known ones, so the chip says offline instead (0.7: the serve's own state).
    const banner = setup.serve;
    const downWord = setup.pick ? "no project" : banner ? SERVE_LOOK[banner.state].word : "offline";
    const labels = rokoDown(data) || banner || setup.pick ? { parts: [], full: downWord, primary: downWord, digit: "" } : chipLabels(c);

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
    const down = conn.reachable === false || !!banner || setup.pick;
    const ch = setup.pick ? "you" : banner ? SERVE_LOOK[banner.state].ch : down ? "fail" : c.waiting ? "you" : active ? "live" : "off";
    const progress = liveProgress(data);
    const live = liveRun(data);
    const title = setup.pick
      ? "roko: pick the project it works in"
      : banner
      ? serveTitle(banner)
      : down
        ? "roko serve is unreachable" + (conn.error && conn.error.message ? ": " + str(conn.error.message) : "")
        : labels.parts.length
          ? "roko: " + labels.parts.join(", ") + (progress ? " (" + (progress.passed || 0) + " of " + progress.total + " tasks done)" : "")
          : "roko: idle";
    // A restart or a problem that stops new runs comes first: it says what to do, not how roko is doing.
    // (roko down says itself: a red light and "offline"; 0.7: a serve that does not run, its state.)
    const setupAlert = setup.blocking && setup.blocking.id !== "roko-unreachable" && setup.blocking.id !== "roko-serve" && setup.blocking.id !== "pick-project";
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
      h(LED, { ch: ch, blink: banner && banner.state === "starting" ? "slow" : down || !(active || c.waiting) ? false : undefined }),
      alert && level < 3 ? h("span", { className: "roko-chip-alert", "data-ch": setup.restart ? "you" : "fail", "data-roko": "chip-" + alert }, alert) : null,
      // The newest live run on the ladder and what it spent (spec v3 §5.10), while there is room.
      live && !down && level === 0 && list(live.rungs).length ? h(MiniLadder, { rungs: live.rungs }) : null,
      progress && !down && level < 2 ? h(StepStrip, { progress: progress, max: 8, waiting: liveWaits(data) }) : null,
      live && !down && level === 0 && isNum(live.cost_usd) ? h("span", { className: "roko-chip-spend" }, boneMoney(live.cost_usd)) : null,
      c.waiting && !down && level < 3 ? h("span", { className: "roko-chip-wait", "aria-hidden": "true" }, "◆") : null,
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
        step = str(last.task_id) + " " + (stepWords ? "“" + oneLineEnd(mdPlain(last.said || last.text), 80) + "”" : "▸ " + str(last.tool) + (last.target ? " " + oneLine(last.target, 60) : ""));
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

  /**
   * A run row on the workspace's ladder, cheapest first: each rung (the overview's `ladder`) with the row's counts
   * there (0.6.0 RunRow `rungs`). Empty without either.
   */
  function stripRows(ladder, rungs) {
    const counted = {};
    list(rungs).filter(obj).forEach(function (r) { counted[str(r.rung)] = r; });
    const named = list(ladder).filter(function (r) { return obj(r) && str(r.rung); });
    const base = named.length ? named : list(rungs).filter(obj).map(function (r) { return { rung: str(r.rung) }; });
    if (!list(rungs).length) return [];
    return base.map(function (r) {
      const c = counted[str(r.rung)] || {};
      function n(v) { return isNum(v) ? v : 0; }
      return { rung: str(r.rung), model: str(r.slug) || str(r.model), off: r.chat_ok === false, passed: n(c.passed), running: n(c.running), failed: n(c.failed), waiting: n(c.waiting) };
    });
  }

  /**
   * The Ladder, strip form (the chat and sessions strips, spec v3 §4.3): cheap to top, each rung's model and a square
   * per task where it stands: rose running, sage passed, red where a try failed, hollow waiting. A rung a chat's run
   * cannot use is hatched and says so.
   */
  function LadderStrip(props) {
    const rows = props.rows;
    if (!rows || !rows.length) return null;
    function squares(r) {
      const out = [];
      function add(state, n) { for (let i = 0; i < n && out.length < 8; i += 1) out.push(state); }
      add("failed", r.failed);
      add("running", r.running);
      add("passed", r.passed);
      add("waiting", r.waiting);
      return out;
    }
    const words = rows.map(function (r) {
      const parts = [r.passed ? r.passed + " passed" : "", r.running ? r.running + " running" : "", r.failed ? r.failed + " failed" : "", r.waiting ? r.waiting + " waiting" : ""].filter(Boolean);
      return r.rung + (r.model ? " " + r.model : "") + (r.off ? " (not for chat runs)" : "") + (parts.length ? ": " + parts.join(", ") : "");
    });
    return h(
      Glass,
      { className: "rk-lstrip", name: "ladder-strip", role: "img", label: "The model ladder: " + words.join("; ") },
      rows.map(function (r) {
        return h(
          "div",
          { key: r.rung, className: "rk-lstrip-seg", "data-live": r.running ? "true" : undefined, "data-off": r.off ? "true" : undefined },
          h("span", { className: "rk-lstrip-top" }, h("span", { className: "rk-rung-r" }, r.rung), h("span", { className: "rk-lstrip-m" }, r.off ? "chat: no" : oneLine(r.model, 18))),
          h("span", { className: "rk-lstrip-toks" }, squares(r).map(function (state, i) { return h("i", { key: i, "data-state": state }); }))
        );
      })
    );
  }

  /** `sessions:top`: a live strip while runs started from Hermes are active or something waits. */
  function SessionsBanner() {
    const ov = useOverview();
    const light = useLightTheme();
    const data = ov.data;
    const newest = useNewestActive(data);
    const c = data ? counts(data) : { running: 0, queued: 0, waiting: 0 };
    // roko down: its counts are stale; the setup strip says roko is down and what starts it.
    const shown = !!data && !!(c.running || c.queued || c.waiting) && !rokoDown(data);
    const parts = [];
    if (c.running) parts.push(plural(c.running, "run", "runs") + " running");
    if (c.queued) parts.push(plural(c.queued, "run", "runs") + " queued");
    if (c.waiting) parts.push(c.waiting === 1 ? "1 item waits on you" : c.waiting + " items wait on you");
    const progress = shown ? liveProgress(data) : null;
    // A screen reader hears the banner's state at most once every 2 s (plugin-review F9), never its live step.
    const said = useThrottledSay(shown ? "roko: " + parts.join(" · ") + (progress ? " · " + (progress.passed || 0) + "/" + progress.total + " tasks" : "") : "");
    if (!data) return null;
    const strip = h(SetupStrip, { name: "sessions-setup" });
    if (!shown) return strip;
    const path = "/roko" + (c.waiting ? "?section=waiting" : "");
    // The ladder of the run whose tasks the strip counts; the horizon shows the newest move of any.
    const counted = liveRun(data) || newest.run;
    const ladder = counted ? stripRows(data.ladder, counted.rungs) : [];
    return h(
      Fragment,
      null,
      strip,
      h(
        "div",
        { className: "roko-banner rk-livestrip roko-tone-scope" + (light ? " roko--light" : "") + (ladder.length || newest.step ? " has-strip" : ""), "data-roko": "banner" },
        h("div", { className: "rk-sr", role: "status", "aria-live": "polite", "data-roko": "banner-say" }, said),
        h(LED, { ch: c.waiting ? "you" : "live" }),
        h("span", { className: "roko-banner-text" }, "roko: " + parts.join(" · ")),
        progress ? h(StepStrip, { progress: progress, waiting: liveWaits(data) }) : null,
        progress ? h("span", { className: "roko-banner-sub roko-dim" }, (progress.passed || 0) + "/" + progress.total + " tasks") : null,
        h("a", linkProps(path, { className: "roko-banner-link" }), "open →"),
        // The live strip (spec v3 §5.11): the newest run's ladder, and what its agent does this second.
        ladder.length ? h(LadderStrip, { rows: ladder }) : null,
        newest.step ? h(Glass, { className: "rk-livestrip-horizon" }, h(LED, { ch: "live" }), h(LiveStep, { key: newest.stepKey, newest: newest })) : null
      )
    );
  }

  /**
   * `chat:top`: while a run is active, its live card above the chat (spec v3 §5.10): the stamp, the title, its size,
   * cap and time, the spend in bone on a well with its meter, the ladder strip (or the task strip on an older
   * backend), what its agent does this second on a glass line, and the way into roko.
   */
  function ChatStrip() {
    const ov = useOverview();
    const light = useLightTheme();
    const data = ov.data;
    const newest = useNewestActive(data);
    const c = data ? counts(data) : { running: 0, queued: 0, waiting: 0 };
    const run = data ? newest.run : null;
    const shown = !!data && !!(run || c.waiting) && !rokoDown(data);
    const progress = run ? obj(run.progress) : null;
    const kind = run ? (run.kind === "plan" ? "plan run" : run.kind === "plan_generate" ? "plan writing" : "task") + (progress && progress.total > 1 ? " · " + (progress.passed || 0) + "/" + progress.total + " tasks" : "") : "";
    const waitWords = c.waiting ? plural(c.waiting, "item waits", "items wait") + " on you" : "";
    // A screen reader hears the card's state at most once every 2 s (plugin-review F9): it sits above the chat the
    // person is using, so never its clock, its spend or the words its agent streams.
    const said = useThrottledSay(!shown ? "" : run ? ["roko: " + stampWord(run), kind, waitWords].filter(Boolean).join(" · ") : "roko: " + waitWords);
    if (!data) return null;
    // Asking for roko work in this chat would be refused: say so above it.
    const strip = h(SetupStrip, { name: "chat-setup", blockingOnly: true });
    if (!shown) return strip;
    const path = c.waiting && !run ? "/roko?section=waiting" : "/roko?run=" + enc(run.run_id);
    const waits = run ? runWaits(run, data.pending) : false;
    const ladder = run ? stripRows(data.ladder, run.rungs) : [];
    const ch = run ? (waits ? "you" : "live") : "you";
    const cap = run && isNum(run.max_usd) ? run.max_usd : null;
    return h(
      Fragment,
      null,
      strip,
      h(
        "div",
        { className: "roko-banner rk-livestrip rk-chatstrip rk-chatcard roko-tone-scope" + (light ? " roko--light" : ""), "data-roko": "chatstrip" },
        h("div", { className: "rk-sr", role: "status", "aria-live": "polite", "data-roko": "chatstrip-say" }, said),
        h(
          "div",
          { className: "rk-chatcard-head" },
          h(
            "div",
            { className: "rk-chatcard-who" },
            h(
              "span",
              { className: "rk-chatcard-top" },
              h(LED, { ch: ch }),
              h("span", { className: "rk-chatstrip-name" }, "roko"),
              run ? h("span", { className: "rk-state rk-stamp", "data-ch": waits ? "you" : "live" }, stampWord(run)) : null,
              run ? h(ProjectTag, { run: run }) : null,
              run && c.waiting ? h("span", { className: "rk-tag rk-tag-you rk-chatstrip-wait", "data-ch": "you" }, "◆ " + plural(c.waiting, "item waits", "items wait") + " on you") : null
            ),
            run
              ? h("span", { className: "roko-banner-text rk-chatcard-title", title: str(run.label) }, oneLine(run.label, 90) || "a run")
              : h("span", { className: "roko-banner-text" }, c.waiting === 1 ? "1 item waits on you" : c.waiting + " items wait on you"),
            run
              ? h(
                  "span",
                  { className: "rk-chatcard-sub" },
                  kind,
                  cap !== null ? " · cap " + money(cap) : "",
                  run.started_at ? h(Ticker, { since: run.started_at, prefix: " · " }) : null
                )
              : null
          ),
          run && isNum(run.cost_usd)
            ? h(
                Well,
                { className: "rk-chatstrip-well" },
                h(BoneNumber, { value: run.cost_usd, size: "L", label: "spent " + moneyFine(run.cost_usd) + (cap !== null ? " of a " + money(cap) + " cap" : "") }),
                cap !== null ? h(Meter, { value: run.cost_usd, max: cap, segments: 18, tone: "bone" }) : null
              )
            : null
        ),
        ladder.length ? h(LadderStrip, { rows: ladder }) : progress && progress.total ? h(StepStrip, { progress: progress, waiting: waits }) : null,
        run ? h(Glass, { className: "rk-livestrip-horizon" }, h(LED, { ch: ch }), newest.step ? h(LiveStep, { key: newest.stepKey, newest: newest }) : h("span", { className: "rk-livestrip-idle" }, "working…")) : null,
        h(
          "div",
          { className: "rk-chatcard-foot" },
          newest.more ? h("span", { className: "roko-dim" }, "+" + newest.more + " more") : null,
          h("span", { className: "roko-flex" }),
          h("a", linkProps(path, { className: "roko-banner-link" }), "open in roko →")
        )
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
    const learning = useSlotResource(data ? "/learning" : null, 60000);
    if (!data) return null;
    const spend = obj(data.spend) || {};
    const lv = obj(learning) && (list(learning.runs).length || obj(learning.kpis)) ? readLearning(learning) : null;
    if (lv) {
      return h(
        "section",
        { className: "rk-slotcard roko-tone-scope" + (light ? " roko--light" : ""), "data-roko": "analytics-card", "aria-label": "roko" },
        h(
          "header",
          { className: "rk-slotcard-head" },
          h("span", { className: "rk-wordmark rk-wordmark--s" }, h("span", { className: "rk-wordmark-dot", "aria-hidden": "true" }), "roko"),
          h("span", { className: "rk-tiny" }, "is it getting better · " + plural(list(lv.series).length, "ended run", "ended runs") + " from hermes"),
          h("span", { className: "roko-flex" }),
          h("a", linkProps("/roko?section=learning", { className: "roko-banner-link" }), "learning →")
        ),
        h(LearningHero, { data: lv, compact: true })
      );
    }
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
          {
            index: "03",
            label: "SPEND TODAY",
            sub: h(
              Fragment,
              null,
              isNum(spend.max_day_usd) ? h(SegMeter, { value: spend.today_usd, max: spend.max_day_usd, label: "today's spend against the daily limit" }) : null,
              h("span", { className: "rk-cell-subtext", "data-roko": "spend-words", title: todayLine(spend) }, spendWords(spend))
            ),
          },
          h(Dots, { value: money(spend.today_usd), size: "XL", label: money(spend.today_usd) + " from Hermes" })
        ),
        h(
          Cell,
          { index: "04", label: "CHECKS", sub: (ran ? passed + " of " + ran + " check runs passed" : "no checks recorded") + (where ? " · " + where.label : "") },
          h(Dots, { value: rate === null ? "—" : Math.round(rate * 100) + "%", size: "XL", ch: rate === null ? undefined : rate >= 0.8 ? "pass" : rate >= 0.5 ? "you" : "fail", label: rate === null ? "no checks" : pct(rate) + " of checks passed" })
        ),
        h(
          Cell,
          { index: "05", label: "MODELS", sub: topModel ? str(topModel.model) + (isNum(topModel.success_rate) ? " · " + pct(topModel.success_rate) + " of tasks passed" : "") : "none scored yet" },
          h(Dots, { value: String(models.length), size: "XL", label: plural(models.length, "model", "models") + " routed" })
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
                h(LED, { ch: last ? loopChannel(last) : r && r.state === "active" ? "live" : "off", blink: false }),
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
            h(Well, { className: "rk-modelrow-well" }, h(Dots, { value: rate === null ? "—" : Math.round(rate * 100) + "%", size: "M", ch: ch === "off" ? undefined : ch, label: rate === null ? "no rate" : pct(rate) + " of tasks passed" })),
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
  // 0.7: the dashboard opened, so roko serve should be up (BRIEF B6). The backend answers at once and starts it in the
  // background; a failure, or a 404 from an older backend (its restart banner covers that), changes nothing.
  apiPost("/serve", { action: "ensure" }).then(function (res) {
    if (res.ok && obj(res.data)) overviewStore.patchServe(res.data.serve);
  });
  window.__ROKO_DASHBOARD_VERSION__ = VERSION;
})();

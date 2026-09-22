// @bun
var __require = import.meta.require;

// src/tui/plugin.tsx
import { createComponent as _$createComponent3 } from "@opentui/solid";

// src/tui/dashboard.tsx
import { use as _$use } from "@opentui/solid";
import { effect as _$effect } from "@opentui/solid";
import { createComponent as _$createComponent } from "@opentui/solid";
import { spread as _$spread } from "@opentui/solid";
import { mergeProps as _$mergeProps } from "@opentui/solid";
import { memo as _$memo } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
import { createTextNode as _$createTextNode } from "@opentui/solid";
import { insertNode as _$insertNode } from "@opentui/solid";
import { setProp as _$setProp } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
import { createSignal, For, Show, onCleanup, onMount, createEffect } from "solid-js";
import { useKeyboard } from "@opentui/solid";

// src/infrastructure/control-client.ts
import { randomUUID } from "crypto";

// src/infrastructure/state-repository.ts
import { promises as fs } from "fs";
import path from "path";
var CURRENT_VERSION = 7;
function emptyState() {
  return { version: CURRENT_VERSION, revision: 0, goals: [], runtimes: [], commandLedger: [], commands: [] };
}
function loopDir(directory) {
  return path.join(directory, ".opencode", "loopd");
}
function stateFile(directory) {
  return path.join(loopDir(directory), "state.json");
}
function eventsFile(directory) {
  return path.join(loopDir(directory), "events.ndjson");
}
async function readState(directory) {
  const target = stateFile(directory);
  const attempts = 5;
  for (let attempt = 0;attempt < attempts; attempt++) {
    try {
      const raw = await fs.readFile(target, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && Array.isArray(parsed.goals)) {
        return migrate(parsed);
      }
      return emptyState();
    } catch (error) {
      if (error?.code === "ENOENT")
        return emptyState();
      const transient = error instanceof SyntaxError || error?.code === "EPERM" || error?.code === "EACCES" || error?.code === "EBUSY";
      if (!transient || attempt === attempts - 1)
        break;
      await delay(25 * (attempt + 1));
    }
  }
  return emptyState();
}
function migrate(state) {
  if (state.version === CURRENT_VERSION)
    return state;
  let result = { ...state };
  if (result.version < 2) {
    result.version = 2;
    if (!result.commandLedger)
      result.commandLedger = [];
    result.runtimes = result.runtimes.map((rt) => ({
      ...rt,
      progressDuringTurn: rt.progressDuringTurn ?? false
    }));
    result.goals = result.goals.map((g) => ({
      ...g,
      lastProgress: g.lastProgress ?? undefined,
      completionEvidence: g.completionEvidence ?? undefined,
      blocker: g.blocker ?? undefined
    }));
  }
  if (result.version < 3) {
    result.version = 3;
    result.runtimes = result.runtimes.map((rt) => {
      const oldTurnCount = rt.turnCount ?? 0;
      const { turnCount: _deprecatedTurnCount, ...rest } = rt;
      return {
        ...rest,
        budgetTurnCount: rest.budgetTurnCount ?? oldTurnCount,
        runCount: rest.runCount ?? oldTurnCount,
        runGeneration: rest.runGeneration ?? 0,
        freeRetryPending: rest.freeRetryPending ?? false,
        lastRejectionDetails: rest.lastRejectionDetails ?? undefined,
        activePromptMessageID: rest.activePromptMessageID ?? undefined,
        lastActivityAt: rest.lastActivityAt ?? undefined,
        idleCandidateAt: rest.idleCandidateAt ?? undefined,
        activeToolCallIDs: rest.activeToolCallIDs ?? []
      };
    });
  }
  if (result.version < 4) {
    result.version = 4;
    result.runtimes = result.runtimes.map((rt) => ({
      ...rt,
      lastVerificationAttempt: rt.lastVerificationAttempt ?? undefined,
      recentVerificationAttempts: rt.recentVerificationAttempts ?? []
    }));
  }
  if (result.version < 5) {
    result.version = 5;
    result.goals = result.goals.map((goal) => ({
      ...goal,
      config: {
        ...goal.config,
        workspaceWrite: goal.config?.workspaceWrite ?? true
      }
    }));
    result.runtimes = result.runtimes.map((rt) => ({
      ...rt,
      activePromptObservedAt: rt.activePromptObservedAt ?? undefined,
      activeAssistantMessageID: rt.activeAssistantMessageID ?? undefined,
      activeAssistantCompletedAt: rt.activeAssistantCompletedAt ?? undefined,
      idleCandidateGeneration: rt.idleCandidateGeneration ?? undefined,
      unknownStatusCount: rt.unknownStatusCount ?? 0,
      lastUnknownStatusAt: rt.lastUnknownStatusAt ?? undefined,
      workerUnreachableNotifiedAt: rt.workerUnreachableNotifiedAt ?? undefined
    }));
  }
  if (result.version < 6) {
    result.version = 6;
    result.goals = result.goals.map((goal) => ({
      ...goal,
      config: {
        ...goal.config,
        schedule: goal.config?.schedule ?? undefined
      }
    }));
    result.goals = result.goals.map((goal) => {
      const s = goal.config?.schedule;
      if (s && typeof s.everyMs === "number" && s.everyMs >= 1000)
        return goal;
      if (s) {
        const { schedule: _s, ...restConfig } = goal.config;
        return { ...goal, config: restConfig };
      }
      return goal;
    });
    result.runtimes = result.runtimes.map((rt) => ({
      ...rt,
      scheduleRunCount: typeof rt.scheduleRunCount === "number" ? rt.scheduleRunCount : 0,
      nextRunAt: rt.nextRunAt ?? undefined,
      lastScheduleAt: rt.lastScheduleAt ?? undefined
    }));
  }
  if (result.version < 7) {
    result.version = 7;
    if (!Array.isArray(result.commands))
      result.commands = [];
  }
  return result;
}
async function writeAtomic(target, contents) {
  const dir = path.dirname(target);
  await fs.mkdir(dir, { recursive: true });
  const temp = path.join(dir, `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await fs.writeFile(temp, contents, "utf8");
  try {
    for (let attempt = 0;attempt < 5; attempt++) {
      try {
        await fs.rename(temp, target);
        return;
      } catch (error) {
        if (error?.code === "EXDEV")
          break;
        if (error?.code !== "EPERM" && error?.code !== "EACCES" && error?.code !== "EBUSY" && error?.code !== "EEXIST" && error?.code !== "EAGAIN")
          throw error;
        if (attempt < 4)
          await delay(25 * (attempt + 1));
      }
    }
    await fs.copyFile(temp, target);
  } finally {
    try {
      await fs.rm(temp, { force: true });
    } catch {}
  }
}
async function readEvents(directory, limit = 50) {
  try {
    const raw = await fs.readFile(eventsFile(directory), "utf8");
    const lines = raw.trim().split(`
`).filter(Boolean);
    return lines.slice(-limit).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}
function controlDir(directory) {
  return path.join(loopDir(directory), "control");
}
function requestFile(directory, requestID) {
  return path.join(controlDir(directory), "requests", `${requestID}.json`);
}
function responseFile(directory, requestID) {
  return path.join(controlDir(directory), "responses", `${requestID}.json`);
}
async function writeControlRequest(directory, request) {
  const dir = path.join(controlDir(directory), "requests");
  await fs.mkdir(dir, { recursive: true });
  await writeAtomic(requestFile(directory, request.requestID), JSON.stringify(request, null, 2));
}
async function readControlResponse(directory, requestID) {
  try {
    const raw = await fs.readFile(responseFile(directory, requestID), "utf8");
    return JSON.parse(raw);
  } catch {
    return;
  }
}
function commandLogFile(directory, commandID) {
  return path.join(loopDir(directory), "commands", `${commandID}.log`);
}
async function readCommandLog(directory, commandID, opts) {
  const file = commandLogFile(directory, commandID);
  try {
    const stat = await fs.stat(file);
    const totalBytes = stat.size;
    const startByte = Math.max(0, opts?.offsetBytes ?? 0);
    if (startByte >= totalBytes)
      return { text: "", totalBytes, startByte };
    const fh = await fs.open(file, "r");
    try {
      const want = Math.min(opts?.limitBytes ?? 64 * 1024, totalBytes - startByte);
      const buf = Buffer.alloc(want);
      await fh.read(buf, 0, want, startByte);
      return { text: buf.toString("utf8"), totalBytes, startByte };
    } finally {
      await fh.close();
    }
  } catch {
    return { text: "", totalBytes: 0, startByte: 0 };
  }
}
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// src/infrastructure/control-client.ts
function createControlClient(directory) {
  async function execute(command, timeoutMs = 30000) {
    return executeRaw({
      command: command.command,
      goalID: command.goalID,
      args: "args" in command ? command.args : undefined
    }, timeoutMs);
  }
  async function executeRaw(command, timeoutMs = 30000) {
    const request = {
      requestID: randomUUID(),
      command: command.command,
      goalID: command.goalID,
      args: command.args,
      requestedAt: new Date().toISOString()
    };
    await writeControlRequest(directory, request);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const response = await readControlResponse(directory, request.requestID);
      if (response)
        return response;
      await delay2(100);
    }
    return {
      requestID: request.requestID,
      ok: false,
      message: "timeout waiting for response",
      errorCode: "timeout",
      completedAt: new Date().toISOString()
    };
  }
  async function getState() {
    return readState(directory);
  }
  async function getEvents(limit) {
    return readEvents(directory, limit);
  }
  return { execute, executeRaw, getState, getEvents };
}
function delay2(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// src/tui/command-parser.ts
function parseCommand(input) {
  const trimmed = input.trim();
  if (!trimmed)
    return null;
  const tokens = tokenize(trimmed);
  if (tokens.length === 0)
    return null;
  const command = tokens[0];
  const args = {};
  const positional = [];
  for (let i = 1;i < tokens.length; i++) {
    const token = tokens[i];
    if (token.startsWith("--")) {
      const eqIdx = token.indexOf("=");
      if (eqIdx > 0) {
        args[token.slice(2, eqIdx)] = token.slice(eqIdx + 1);
      } else if (i + 1 < tokens.length && !tokens[i + 1].startsWith("--")) {
        args[token.slice(2)] = tokens[++i];
      } else {
        args[token.slice(2)] = "true";
      }
    } else {
      positional.push(token);
    }
  }
  return { command, args, positional, raw: trimmed };
}
function tokenize(input) {
  const tokens = [];
  let current = "";
  let inQuote = null;
  let escape = false;
  for (const char of input) {
    if (escape) {
      current += char;
      escape = false;
      continue;
    }
    if (char === "\\") {
      escape = true;
      continue;
    }
    if (inQuote) {
      if (char === inQuote) {
        inQuote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      inQuote = char;
      continue;
    }
    if (char === " " || char === "\t") {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current)
    tokens.push(current);
  return tokens;
}
function commandHelp() {
  return [
    "Modes: : insert \u2192 send/commands | Ctrl+N \u2192 normal | ? toggle help | Shift+B bug report",
    "Nav: j/k move | g/G top/bottom | o open child | c toggle done | p/r/R/x pause/resume/retry/clear | A abort worker | N nudge | L logs | q close",
    "Goal (ownership): Active=loopd owns it | Blocked/Paused=needs you | Out of budget=resume to spend | Waiting for capacity=auto-resumes | Done=verified",
    "Worker (activity now): Running=acting now | Idle=between turns | Retrying=backing off | Queued/Compacting/Stopping=transitional",
    "Commands (insert mode, : prefix):",
    "  :send <message>                           Send bare words now as their own turn (no steering)",
    "  :open                                     Open child session (same as o)",
    "  :force <summary> --evidence <text>        Force-complete (bypass checks)",
    "  :block <reason> --needed <text>           Force-block the selected goal",
    "  :pause / :resume / :retry / :clear        Quick controls (also p/r/R/x)",
    "  :abort                                   Abort worker session now (status unchanged; A)",
    "  :nudge                                   Force re-prompt now with full steering (N)",
    "  :bug / :report                            Open prefilled GitHub bug report",
    "  :logs / :help / :q                        Toggle logs / help / close",
    "  Tip: create goals via /goal in the parent chat (agent clarifies first)."
  ].join(`
`);
}

// src/domain/status-labels.ts
var GOAL_STATUS_META = {
  active: { short: "Active", hint: "loopd owns it" },
  paused: { short: "Paused", hint: "stopped by you" },
  blocked: { short: "Blocked", hint: "needs you" },
  budget_limited: { short: "Out of budget", hint: "resume to spend" },
  usage_limited: { short: "Waiting for capacity", hint: "auto-resumes" },
  complete: { short: "Done", hint: "verified" }
};
var PHASE_META = {
  idle: { short: "Idle", hint: "between turns" },
  queued: { short: "Queued", hint: "waiting to start" },
  running: { short: "Running", hint: "worker acting now" },
  compacting: { short: "Compacting", hint: "summarizing context" },
  waiting_retry: { short: "Retrying", hint: "backing off" },
  stopping: { short: "Stopping", hint: "abort in flight" }
};
function goalStatusLabel(status) {
  return GOAL_STATUS_META[status] ?? { short: status, hint: "" };
}
function phaseLabel(phase) {
  return PHASE_META[phase] ?? { short: phase, hint: "" };
}
function describeGoalState(status, phase) {
  const goal = goalStatusLabel(status);
  const activity = phase ? phaseLabel(phase) : undefined;
  const workerClause = activity ? `worker is ${activity.hint || activity.short.toLowerCase()}` : "worker state unknown";
  if (status === "active")
    return `Loopd owns this; ${workerClause}.`;
  if (status === "complete")
    return "Done \u2014 verified; worker is stopped.";
  return `Parked \u2014 ${goal.hint || goal.short.toLowerCase()}; ${workerClause}.`;
}

// src/browser.ts
import { spawn } from "child_process";
var LOOPD_ISSUES_URL = "https://github.com/bojackduy/opencode-loopd/issues/new";
function bugReportUrl(context = {}) {
  const url = new URL(LOOPD_ISSUES_URL);
  url.searchParams.set("title", "bug: ");
  url.searchParams.set("body", [
    "## What happened?",
    "",
    "Describe the unexpected behavior.",
    "",
    "## What did you expect?",
    "",
    "Describe the expected behavior.",
    "",
    "## Steps to reproduce",
    "",
    "1. ",
    "2. ",
    "3. ",
    "",
    "## Environment",
    "",
    `- opencode-loopd version: ${context.runtimeLabel ?? ""}`,
    `- OS: ${process.platform}`,
    "- Terminal:",
    "- Installation: npm / source",
    context.extra ? `
## Goal context

${context.extra}
` : "",
    "Do not include secrets, API tokens, or .opencode/loopd contents."
  ].join(`
`));
  return url.toString();
}
function openBrowserUrl(value, options = {}) {
  try {
    const url = normalizeBrowserUrl(value);
    const command = browserCommandForUrl(url, options.platform);
    const launch = options.launch ?? launchBrowserCommand;
    launch(command.command, command.args);
    return { status: "opened", url };
  } catch (error) {
    return { status: "blocked", reason: error instanceof Error ? error.message : "Could not open the browser." };
  }
}
function browserCommandForUrl(value, platform = process.platform) {
  const url = normalizeBrowserUrl(value);
  if (platform === "darwin")
    return { command: "open", args: [url] };
  if (platform === "linux")
    return { command: "xdg-open", args: [url] };
  if (platform === "win32")
    return { command: "cmd.exe", args: ["/d", "/s", "/c", `start "" "${url}"`] };
  throw new Error(`Opening a browser is not supported on ${platform}.`);
}
function normalizeBrowserUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("The selected page does not have a valid browser URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error("Only http and https page URLs can be opened in a browser.");
  return url.toString();
}
function launchBrowserCommand(command, args) {
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
}

// src/tui/dashboard.tsx
import { randomUUID as randomUUID2 } from "crypto";
var LOG_FILE = "/tmp/loopd-tui.log";
function debugLog(...args) {
  try {
    const {
      appendFileSync
    } = __require("fs");
    appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${args.map((a) => typeof a === "string" ? a : JSON.stringify(a)).join(" ")}
`);
  } catch {}
}
function prevent(evt) {
  const e = evt;
  e.preventDefault?.();
  e.stopPropagation?.();
}
function keyName(evt) {
  return (evt.name || "").toLowerCase();
}
function keySeq(evt) {
  const e = evt;
  return e.sequence || e.raw || "";
}
function isEnterKey(evt) {
  const name = keyName(evt);
  if (name === "return" || name === "enter" || name === "kp_enter")
    return true;
  const seq = keySeq(evt);
  return seq === "\r" || seq === `
`;
}
function isEscapeKey(evt) {
  if (keyName(evt) === "escape" || keyName(evt) === "esc")
    return true;
  return keySeq(evt) === "\x1B";
}
function isCtrlN(evt) {
  return Boolean(evt.ctrl) && keyName(evt) === "n";
}
function statusColor(status, theme) {
  switch (status) {
    case "active":
      return theme.success;
    case "paused":
      return theme.warning;
    case "blocked":
      return theme.error;
    case "complete":
      return theme.info;
    case "budget_limited":
      return theme.accent;
    case "usage_limited":
      return theme.accent;
    default:
      return theme.text;
  }
}
function phaseColor(phase, theme) {
  switch (phase) {
    case "running":
      return theme.success;
    case "compacting":
      return theme.warning;
    case "waiting_retry":
      return theme.accent;
    case "stopping":
      return theme.error;
    default:
      return theme.textMuted;
  }
}
function borderColorForStatus(status, theme) {
  switch (status) {
    case "active":
      return theme.success;
    case "paused":
      return theme.warning;
    case "blocked":
      return theme.error;
    case "budget_limited":
    case "usage_limited":
      return theme.accent;
    default:
      return "gray";
  }
}
function eventColor(type, theme) {
  if (type === "goal.completed")
    return theme.info;
  if (type === "goal.blocked" || type === "run.failed")
    return theme.error;
  if (type === "goal.created" || type === "goal.progress")
    return theme.success;
  if (type === "run.started" || type === "compaction.started")
    return theme.warning;
  return theme.textMuted;
}
function phaseIcon(phase) {
  switch (phase) {
    case "running":
      return "\u25B6";
    case "compacting":
      return "\u23F3";
    case "waiting_retry":
      return "\uD83D\uDD04";
    case "stopping":
      return "\u23F9";
    case "queued":
      return "\u25F7";
    case "idle":
      return "\u25CB";
    default:
      return "\u25CB";
  }
}
function statusIcon(status) {
  switch (status) {
    case "active":
      return "\u25CF";
    case "paused":
      return "\u275A\u275A";
    case "blocked":
      return "\u2716";
    case "complete":
      return "\u2713";
    case "budget_limited":
      return "\u2B22";
    case "usage_limited":
      return "\u23F0";
    default:
      return "\u25CB";
  }
}
function ageLabel(timestamp, now) {
  if (!timestamp)
    return "never";
  const seconds = Math.max(0, Math.floor((now - Date.parse(timestamp)) / 1000));
  if (seconds < 60)
    return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60)
    return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}
function countdownLabel(targetIso, now) {
  if (!targetIso)
    return;
  const diff = Math.max(0, Math.floor((Date.parse(targetIso) - now) / 1000));
  if (diff < 60)
    return `${diff}s`;
  const minutes = Math.floor(diff / 60);
  if (minutes < 60)
    return `${minutes}m ${diff % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
function formatTokens(n) {
  if (!n)
    return "0";
  if (n < 1000)
    return String(Math.round(n));
  if (n < 1e6)
    return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1e6).toFixed(2)}M`;
}
function formatCost(c) {
  if (!c)
    return "$0.00";
  if (c < 0.01)
    return `$${c.toFixed(4)}`;
  return `$${c.toFixed(2)}`;
}
function formatDuration(seconds) {
  if (!seconds || seconds <= 0)
    return "0s";
  if (seconds < 60)
    return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60)
    return `${minutes}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}
function agentColor(color, theme) {
  if (!color)
    return theme.text;
  const named = {
    primary: theme.primary,
    secondary: theme.secondary,
    accent: theme.accent,
    success: theme.success,
    warning: theme.warning,
    error: theme.error,
    info: theme.info
  };
  if (named[color])
    return named[color];
  if (/^#[0-9a-fA-F]{3,8}$/.test(color))
    return color;
  return theme.text;
}
function indexAgents(list) {
  const map = {};
  for (const a of list) {
    if (!a?.name)
      continue;
    map[a.name] = {
      color: a.color,
      mode: a.mode
    };
    map[a.name.toLowerCase()] = {
      color: a.color,
      mode: a.mode
    };
  }
  return map;
}
function LoopDashboard(props) {
  const theme = () => props.api.theme.current;
  const [mode, setMode] = createSignal("normal");
  const [selected, setSelected] = createSignal(0);
  const [commandInput, setCommandInput] = createSignal("");
  const [statusText, setStatusText] = createSignal("Press : to send/command, ? help, c toggle done, o open, q close");
  const [state, setState] = createSignal(null);
  const [events, setEvents] = createSignal([]);
  const [selectedGoal, setSelectedGoal] = createSignal(null);
  const [showLogs, setShowLogs] = createSignal(false);
  const [showHelp, setShowHelp] = createSignal(false);
  const [showCompleted, setShowCompleted] = createSignal(false);
  const [clock, setClock] = createSignal(Date.now());
  const [agentIndex, setAgentIndex] = createSignal({});
  let inputEl;
  let listScrollRef;
  let focusTimer;
  const client = createControlClient(props.directory);
  const popMode = props.api.mode.push("loopd.dashboard");
  function focusInput() {
    if (focusTimer)
      clearTimeout(focusTimer);
    focusTimer = setTimeout(() => {
      const current = props.api.renderer.currentFocusedRenderable;
      if (current && current !== inputEl)
        current.blur();
      inputEl?.focus();
    }, 10);
  }
  async function refresh() {
    try {
      const s = await client.getState();
      setState(s);
      const goals = s.goals.filter((g) => showCompleted() || g.status !== "complete");
      if (goals.length > 0 && selected() >= goals.length)
        setSelected(goals.length - 1);
      setSelectedGoal(goals[selected()] || null);
      setEvents(await client.getEvents(20));
    } catch (e) {
      setStatusText(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  refresh();
  async function refreshAgents() {
    try {
      const res = await props.api.client?.app?.agents?.();
      const list = res?.data ?? res ?? [];
      if (Array.isArray(list))
        setAgentIndex(indexAgents(list));
    } catch {}
  }
  refreshAgents();
  const unsubs = [props.api.event.on("session.idle", () => refresh()), props.api.event.on("session.status", () => refresh()), props.api.event.on("session.error", () => refresh()), props.api.event.on("session.compacted", () => refresh()), setInterval(refresh, 1e4), setInterval(() => setClock(Date.now()), 500)];
  onCleanup(() => {
    popMode();
    if (focusTimer)
      clearTimeout(focusTimer);
    for (const u of unsubs)
      typeof u === "function" ? u() : clearInterval(u);
  });
  onMount(() => {
    try {
      const {
        appendFileSync
      } = __require("fs");
      appendFileSync(LOG_FILE, `[${new Date().toISOString()}] dashboard mounted dir=${props.directory} mode=${mode()} dialogOpen=${props.api.ui.dialog.open}
`);
    } catch {}
    debugLog("mounted", "dialogOpen", props.api.ui.dialog.open, "directory", props.directory);
    focusInput();
  });
  createEffect(() => {
    const m = mode();
    debugLog("mode ->", m);
    focusInput();
  });
  function enterInsertMode() {
    setCommandInput("");
    if (inputEl)
      inputEl.value = "";
    setMode("insert");
    focusInput();
  }
  function returnToNormalMode() {
    setCommandInput("");
    if (inputEl)
      inputEl.value = "";
    setMode("normal");
    focusInput();
  }
  useKeyboard((evt) => {
    const name = evt.name || "";
    const seq = evt.sequence || "";
    const raw = evt.raw || "";
    debugLog("useKeyboard", `name=${name} seq=${JSON.stringify(seq)} raw=${JSON.stringify(raw)} shift=${evt.shift} ctrl=${evt.ctrl} mode=${mode()} dialogOpen=${props.api.ui.dialog.open}`);
    if (!props.api.ui.dialog.open)
      return;
    const isColon = name === ":" || seq === ":" || raw === ":" || seq.includes(":") || raw.includes(":") || name === ";" || name === "colon";
    const isQuestion = name === "?" || seq === "?" || raw === "?" || seq.includes("?") || raw.includes("?");
    debugLog("isColon", isColon, "isQuestion", isQuestion, "modeBefore", mode());
    if (mode() === "insert") {
      if (isEnterKey(evt)) {
        prevent(evt);
        debugLog("insert enter -> execute");
        executeCommand(commandInput());
        return;
      }
      if (isEscapeKey(evt) || isCtrlN(evt)) {
        prevent(evt);
        returnToNormalMode();
        debugLog("insert -> normal via esc/ctrl+n");
        return;
      }
      return;
    }
    if (isColon) {
      prevent(evt);
      enterInsertMode();
      debugLog("normal -> insert");
      return;
    }
    if (isQuestion) {
      prevent(evt);
      setShowHelp((value) => !value);
      debugLog("toggle help");
      return;
    }
    const key = raw || seq || name;
    if (key === "c") {
      prevent(evt);
      setShowCompleted((v) => !v);
      debugLog("toggle completed");
      return;
    }
    const currentGoals = state()?.goals.filter((goal) => showCompleted() || goal.status !== "complete") || [];
    if (name === "down" || key === "j") {
      prevent(evt);
      setSelected((index) => Math.min(currentGoals.length - 1, index + 1));
      return;
    }
    if (name === "up" || key === "k") {
      prevent(evt);
      setSelected((index) => Math.max(0, index - 1));
      return;
    }
    if (key === "g") {
      prevent(evt);
      setSelected(0);
      return;
    }
    if (key === "G") {
      prevent(evt);
      setSelected(Math.max(0, currentGoals.length - 1));
      return;
    }
    if (key === "p") {
      prevent(evt);
      executeCommand("pause");
      return;
    }
    if (key === "r") {
      prevent(evt);
      executeCommand("resume");
      return;
    }
    if (key === "R") {
      prevent(evt);
      executeCommand("retry");
      return;
    }
    if (key === "x") {
      prevent(evt);
      executeCommand("clear");
      return;
    }
    if (key === "A") {
      prevent(evt);
      executeCommand("abort");
      return;
    }
    if (key === "N") {
      prevent(evt);
      executeCommand("nudge");
      return;
    }
    if (key === "L") {
      prevent(evt);
      setShowLogs((value) => !value);
      return;
    }
    if (key === "o") {
      prevent(evt);
      const goal = selectedGoal();
      if (goal?.workerSessionID) {
        props.api.route.navigate("session", {
          sessionID: goal.workerSessionID
        });
        props.api.ui.dialog.clear();
      }
      return;
    }
    if (key === "B") {
      prevent(evt);
      handleBugReport();
      return;
    }
    if (key === "q") {
      prevent(evt);
      props.api.ui.dialog.clear();
      return;
    }
  });
  const goals = () => state()?.goals.filter((g) => showCompleted() || g.status !== "complete") || [];
  async function executeCommand(cmd) {
    debugLog("executeCommand raw=", JSON.stringify(cmd));
    const parsed = parseCommand(cmd);
    debugLog("parsed", parsed);
    if (!parsed) {
      setStatusText("Empty command");
      debugLog("empty command");
      return;
    }
    if (!["help", "logs", "q", "close"].includes(parsed.command)) {
      setStatusText(`sending ${parsed.command}\u2026`);
    }
    try {
      switch (parsed.command) {
        case "send": {
          if (!selectedGoal()) {
            setStatusText("No goal selected");
            break;
          }
          const message = parsed.positional.join(" ") || parsed.args.message || "";
          if (!message) {
            setStatusText("Usage: :send <message>");
            break;
          }
          const r = await client.execute({
            version: 1,
            requestID: randomUUID2(),
            requestedAt: new Date().toISOString(),
            command: "send",
            goalID: selectedGoal().id,
            args: {
              message
            }
          });
          setStatusText(r.ok ? r.message : `Error: ${r.message}`);
          if (r.ok)
            await refresh();
          break;
        }
        case "open": {
          const goal = selectedGoal();
          if (!goal?.workerSessionID) {
            setStatusText("No worker session");
            break;
          }
          props.api.route.navigate("session", {
            sessionID: goal.workerSessionID
          });
          props.api.ui.dialog.clear();
          return;
        }
        case "force": {
          if (!selectedGoal()) {
            setStatusText("No goal");
            break;
          }
          const summary = parsed.positional.join(" ") || parsed.args.summary || "Force-completed from dashboard.";
          const evidence = parsed.args.evidence || "Manual override \u2014 no verification checks run.";
          const r = await client.execute({
            version: 1,
            requestID: randomUUID2(),
            requestedAt: new Date().toISOString(),
            command: "force_complete",
            goalID: selectedGoal().id,
            args: {
              summary,
              evidence
            }
          });
          setStatusText(r.ok ? r.message : `Error: ${r.message}`);
          if (r.ok)
            await refresh();
          break;
        }
        case "block": {
          if (!selectedGoal()) {
            setStatusText("No goal");
            break;
          }
          const reason = parsed.positional.join(" ") || parsed.args.reason || "Blocked from dashboard.";
          const needed = parsed.args.needed || "User intervention required.";
          const r = await client.execute({
            version: 1,
            requestID: randomUUID2(),
            requestedAt: new Date().toISOString(),
            command: "block",
            goalID: selectedGoal().id,
            args: {
              reason,
              needed
            }
          });
          setStatusText(r.ok ? r.message : `Error: ${r.message}`);
          if (r.ok)
            await refresh();
          break;
        }
        case "pause": {
          if (!selectedGoal()) {
            setStatusText("No goal");
            break;
          }
          const r = await client.execute({
            version: 1,
            requestID: randomUUID2(),
            requestedAt: new Date().toISOString(),
            command: "pause",
            goalID: selectedGoal().id
          });
          setStatusText(r.ok ? r.message : `Error: ${r.message}`);
          if (r.ok)
            await refresh();
          break;
        }
        case "resume": {
          if (!selectedGoal()) {
            setStatusText("No goal");
            break;
          }
          const r = await client.execute({
            version: 1,
            requestID: randomUUID2(),
            requestedAt: new Date().toISOString(),
            command: "resume",
            goalID: selectedGoal().id
          });
          setStatusText(r.ok ? r.message : `Error: ${r.message}`);
          if (r.ok)
            await refresh();
          break;
        }
        case "retry": {
          if (!selectedGoal()) {
            setStatusText("No goal");
            break;
          }
          const r = await client.execute({
            version: 1,
            requestID: randomUUID2(),
            requestedAt: new Date().toISOString(),
            command: "retry",
            goalID: selectedGoal().id
          });
          setStatusText(r.ok ? r.message : `Error: ${r.message}`);
          if (r.ok)
            await refresh();
          break;
        }
        case "clear": {
          if (!selectedGoal()) {
            setStatusText("No goal");
            break;
          }
          const r = await client.execute({
            version: 1,
            requestID: randomUUID2(),
            requestedAt: new Date().toISOString(),
            command: "clear",
            goalID: selectedGoal().id
          });
          setStatusText(r.ok ? r.message : `Error: ${r.message}`);
          if (r.ok)
            await refresh();
          break;
        }
        case "abort": {
          if (!selectedGoal()) {
            setStatusText("No goal");
            break;
          }
          const r = await client.execute({
            version: 1,
            requestID: randomUUID2(),
            requestedAt: new Date().toISOString(),
            command: "abort_worker",
            goalID: selectedGoal().id
          });
          setStatusText(r.ok ? r.message : `Error: ${r.message}`);
          if (r.ok)
            await refresh();
          break;
        }
        case "nudge": {
          if (!selectedGoal()) {
            setStatusText("No goal");
            break;
          }
          const r = await client.execute({
            version: 1,
            requestID: randomUUID2(),
            requestedAt: new Date().toISOString(),
            command: "nudge",
            goalID: selectedGoal().id
          });
          setStatusText(r.ok ? r.message : `Error: ${r.message}`);
          if (r.ok)
            await refresh();
          break;
        }
        case "goal": {
          setStatusText("Create goals via /goal in the parent chat (agent clarifies first). Dashboard: :send to steer the worker.");
          break;
        }
        case "bug":
        case "report": {
          handleBugReport();
          break;
        }
        case "logs":
          setShowLogs(!showLogs());
          break;
        case "help":
          setShowHelp(true);
          break;
        case "q":
        case "close":
          props.api.ui.dialog.clear();
          return;
        default: {
          if (parsed.command && selectedGoal()) {
            const message = parsed.raw;
            const r = await client.execute({
              version: 1,
              requestID: randomUUID2(),
              requestedAt: new Date().toISOString(),
              command: "send",
              goalID: selectedGoal().id,
              args: {
                message
              }
            });
            setStatusText(r.ok ? `sent: ${message.slice(0, 80)}` : `Error: ${r.message}`);
            if (r.ok)
              await refresh();
          } else
            setStatusText(`Unknown: ${parsed.command}. ? for help`);
        }
      }
    } catch (e) {
      setStatusText(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
    returnToNormalMode();
  }
  const activeGoals = () => state()?.goals.filter((g) => showCompleted() || g.status !== "complete") || [];
  const listHeight = () => Math.min(activeGoals().length, 10);
  const runningCount = () => state()?.runtimes.filter((runtime) => runtime.phase === "running").length || 0;
  const runningFrame = () => ["|", "/", "-", "\\"][Math.floor(clock() / 500) % 4];
  function handleBugReport() {
    const goal = selectedGoal();
    const extra = goal ? `Goal: ${goal.name} (${goal.id.slice(0, 8)}) status=${goal.status} objective=${goal.objective.slice(0, 120)}` : "No goal selected";
    const url = bugReportUrl({
      runtimeLabel: `opencode-loopd dashboard`,
      extra
    });
    const res = openBrowserUrl(url);
    setStatusText(res.status === "opened" ? "Opening bug report in browser\u2026" : `Could not open browser: ${res.reason} \u2014 ${url}`);
  }
  createEffect(() => setSelectedGoal(activeGoals()[selected()] || null));
  function rowIdFor(goalID) {
    return `loopd-goal-${goalID}`;
  }
  createEffect(() => {
    const goals = activeGoals();
    const goal = goals[selected()];
    if (!goal || !listScrollRef)
      return;
    try {
      listScrollRef.scrollChildIntoView(rowIdFor(goal.id));
    } catch {}
  });
  return (() => {
    var _el$ = _$createElement("box"), _el$2 = _$createElement("box"), _el$3 = _$createElement("box"), _el$4 = _$createElement("text"), _el$5 = _$createElement("span"), _el$7 = _$createElement("span"), _el$9 = _$createElement("span"), _el$0 = _$createTextNode(` `), _el$1 = _$createTextNode(` `), _el$10 = _$createElement("span"), _el$12 = _$createElement("span"), _el$13 = _$createElement("span"), _el$15 = _$createElement("span"), _el$17 = _$createElement("span"), _el$18 = _$createTextNode(` `), _el$19 = _$createTextNode(` acting now`), _el$20 = _$createElement("span"), _el$22 = _$createElement("span"), _el$23 = _$createElement("span"), _el$25 = _$createElement("box"), _el$26 = _$createElement("text"), _el$27 = _$createElement("span"), _el$29 = _$createElement("box"), _el$41 = _$createElement("box"), _el$42 = _$createElement("text"), _el$43 = _$createElement("span"), _el$44 = _$createElement("input");
    _$insertNode(_el$, _el$2);
    _$setProp(_el$, "flexDirection", "column");
    _$setProp(_el$, "width", "100%");
    _$setProp(_el$, "alignItems", "center");
    _$setProp(_el$, "padding", 1);
    _$insertNode(_el$2, _el$3);
    _$insertNode(_el$2, _el$29);
    _$insertNode(_el$2, _el$41);
    _$setProp(_el$2, "flexDirection", "column");
    _$setProp(_el$2, "width", "90%");
    _$setProp(_el$2, "border", true);
    _$setProp(_el$2, "padding", 1);
    _$insertNode(_el$3, _el$4);
    _$insertNode(_el$3, _el$25);
    _$setProp(_el$3, "flexDirection", "row");
    _$setProp(_el$3, "justifyContent", "space-between");
    _$setProp(_el$3, "alignItems", "center");
    _$setProp(_el$3, "padding", 0);
    _$setProp(_el$3, "flexShrink", 0);
    _$setProp(_el$3, "gap", 1);
    _$insertNode(_el$4, _el$5);
    _$insertNode(_el$4, _el$7);
    _$insertNode(_el$4, _el$9);
    _$insertNode(_el$4, _el$10);
    _$insertNode(_el$4, _el$12);
    _$insertNode(_el$4, _el$13);
    _$insertNode(_el$4, _el$15);
    _$insertNode(_el$4, _el$17);
    _$insertNode(_el$4, _el$20);
    _$insertNode(_el$4, _el$22);
    _$insertNode(_el$4, _el$23);
    _$insertNode(_el$5, _$createTextNode(`\u2B22 Loop Dashboard`));
    _$insertNode(_el$7, _$createTextNode(` \u2502 `));
    _$insertNode(_el$9, _el$0);
    _$insertNode(_el$9, _el$1);
    _$insert(_el$9, () => mode().toUpperCase(), _el$1);
    _$insertNode(_el$10, _$createTextNode(` \u2502 `));
    _$insert(_el$12, () => activeGoals().length);
    _$insertNode(_el$13, _$createTextNode(` open`));
    _$insertNode(_el$15, _$createTextNode(` \u2502 `));
    _$insertNode(_el$17, _el$18);
    _$insertNode(_el$17, _el$19);
    _$insert(_el$17, (() => {
      var _c$ = _$memo(() => runningCount() > 0);
      return () => _c$() ? runningFrame() : "\u25CB";
    })(), _el$18);
    _$insert(_el$17, runningCount, _el$19);
    _$insertNode(_el$20, _$createTextNode(` \u2502 `));
    _$insert(_el$22, () => state()?.goals.filter((g) => g.status === "complete").length || 0);
    _$insertNode(_el$23, _$createTextNode(` done`));
    _$insertNode(_el$25, _el$26);
    _$setProp(_el$25, "flexDirection", "row");
    _$setProp(_el$25, "alignItems", "center");
    _$setProp(_el$25, "paddingLeft", 1);
    _$setProp(_el$25, "paddingRight", 1);
    _$setProp(_el$25, "flexShrink", 0);
    _$spread(_el$25, _$mergeProps({
      get backgroundColor() {
        return theme().error;
      }
    }, {
      onMouseDown: handleBugReport
    }), true);
    _$insertNode(_el$26, _el$27);
    _$insertNode(_el$27, _$createTextNode(`Bug Report`));
    _$setProp(_el$27, "style", {
      fg: "white",
      bold: true
    });
    _$setProp(_el$29, "flexDirection", "column");
    _$setProp(_el$29, "flexShrink", 1);
    _$setProp(_el$29, "minHeight", 0);
    _$setProp(_el$29, "overflow", "hidden");
    _$insert(_el$29, _$createComponent(Show, {
      get when() {
        return showHelp();
      },
      get children() {
        var _el$30 = _$createElement("box"), _el$31 = _$createElement("text"), _el$32 = _$createElement("span");
        _$insertNode(_el$30, _el$31);
        _$setProp(_el$30, "flexDirection", "column");
        _$setProp(_el$30, "padding", 1);
        _$setProp(_el$30, "border", true);
        _$setProp(_el$30, "borderColor", "yellow");
        _$setProp(_el$30, "flexShrink", 0);
        _$setProp(_el$30, "maxHeight", 14);
        _$setProp(_el$30, "overflow", "hidden");
        _$insertNode(_el$31, _el$32);
        _$insertNode(_el$32, _$createTextNode(`\u2501\u2501\u2501 Keys: ? toggle help c toggle done : insert Ctrl+N normal o open A abort worker N nudge q close \u2501\u2501\u2501`));
        _$setProp(_el$32, "style", {
          fg: "yellow",
          bold: true
        });
        _$insert(_el$31, _$createComponent(For, {
          get each() {
            return commandHelp().split(`
`);
          },
          children: (line) => {
            if (line.startsWith("Modes:") || line.startsWith("Nav:")) {
              const label = line.startsWith("Modes:") ? "Modes:" : "Nav:";
              const rest = line.slice(label.length).trim();
              const segments = rest.split(" | ");
              return [`
`, (() => {
                var _el$45 = _$createElement("span");
                _$insert(_el$45, label);
                _$effect((_$p) => _$setProp(_el$45, "style", {
                  fg: theme().primary,
                  bold: true
                }, _$p));
                return _el$45;
              })(), (() => {
                var _el$46 = _$createElement("span");
                _$insertNode(_el$46, _$createTextNode(` `));
                _$effect((_$p) => _$setProp(_el$46, "style", {
                  fg: theme().textMuted
                }, _$p));
                return _el$46;
              })(), _$createComponent(For, {
                each: segments,
                children: (seg, idx) => {
                  const hasArrow = seg.includes("\u2192");
                  if (hasArrow) {
                    const [k, d] = seg.split("\u2192").map((s) => s.trim());
                    return [_$memo(() => _$memo(() => idx() > 0)() && (() => {
                      var _el$52 = _$createElement("span");
                      _$insertNode(_el$52, _$createTextNode(` | `));
                      _$effect((_$p) => _$setProp(_el$52, "style", {
                        fg: theme().textMuted
                      }, _$p));
                      return _el$52;
                    })()), (() => {
                      var _el$48 = _$createElement("span");
                      _$insert(_el$48, k);
                      _$effect((_$p) => _$setProp(_el$48, "style", {
                        fg: theme().warning,
                        bold: true
                      }, _$p));
                      return _el$48;
                    })(), (() => {
                      var _el$49 = _$createElement("span");
                      _$insertNode(_el$49, _$createTextNode(` \u2192 `));
                      _$effect((_$p) => _$setProp(_el$49, "style", {
                        fg: theme().textMuted
                      }, _$p));
                      return _el$49;
                    })(), (() => {
                      var _el$51 = _$createElement("span");
                      _$insert(_el$51, d);
                      _$effect((_$p) => _$setProp(_el$51, "style", {
                        fg: theme().text
                      }, _$p));
                      return _el$51;
                    })()];
                  }
                  const sp = seg.indexOf(" ");
                  const k = sp > 0 ? seg.slice(0, sp) : seg;
                  const d = sp > 0 ? seg.slice(sp + 1) : "";
                  return [_$memo(() => _$memo(() => idx() > 0)() && (() => {
                    var _el$55 = _$createElement("span");
                    _$insertNode(_el$55, _$createTextNode(` | `));
                    _$effect((_$p) => _$setProp(_el$55, "style", {
                      fg: theme().textMuted
                    }, _$p));
                    return _el$55;
                  })()), (() => {
                    var _el$54 = _$createElement("span");
                    _$insert(_el$54, k);
                    _$effect((_$p) => _$setProp(_el$54, "style", {
                      fg: theme().warning,
                      bold: true
                    }, _$p));
                    return _el$54;
                  })(), d && (() => {
                    var _el$57 = _$createElement("span"), _el$58 = _$createTextNode(` `);
                    _$insertNode(_el$57, _el$58);
                    _$insert(_el$57, d, null);
                    _$effect((_$p) => _$setProp(_el$57, "style", {
                      fg: theme().text
                    }, _$p));
                    return _el$57;
                  })()];
                }
              })];
            }
            if (line.trim().startsWith(":")) {
              const m = line.match(/^(\s*)(:\S+(?:\s+\S+)*?)\s{2,}(.*)$/);
              const indent = m?.[1] ?? line.match(/^\s*/)?.[0] ?? "";
              const key = m?.[2] ?? line.trim().split(/\s{2,}/)[0] ?? line.trim();
              const desc = m?.[3] ?? line.split(/\s{2,}/)[1] ?? "";
              return [`
`, (() => {
                var _el$59 = _$createElement("span");
                _$insert(_el$59, indent);
                _$effect((_$p) => _$setProp(_el$59, "style", {
                  fg: theme().textMuted
                }, _$p));
                return _el$59;
              })(), (() => {
                var _el$60 = _$createElement("span");
                _$insert(_el$60, key);
                _$effect((_$p) => _$setProp(_el$60, "style", {
                  fg: theme().warning,
                  bold: true
                }, _$p));
                return _el$60;
              })(), desc && [(() => {
                var _el$61 = _$createElement("span");
                _$insertNode(_el$61, _$createTextNode(` `));
                _$effect((_$p) => _$setProp(_el$61, "style", {
                  fg: theme().textMuted
                }, _$p));
                return _el$61;
              })(), (() => {
                var _el$63 = _$createElement("span");
                _$insert(_el$63, desc);
                _$effect((_$p) => _$setProp(_el$63, "style", {
                  fg: theme().textMuted
                }, _$p));
                return _el$63;
              })()]];
            }
            const isHeader = line.startsWith("Commands");
            return [`
`, (() => {
              var _el$64 = _$createElement("span");
              _$insert(_el$64, line);
              _$effect((_$p) => _$setProp(_el$64, "style", {
                fg: isHeader ? theme().primary : theme().textMuted,
                bold: isHeader
              }, _$p));
              return _el$64;
            })()];
          }
        }), null);
        _$effect((_$p) => _$setProp(_el$30, "backgroundColor", theme().background, _$p));
        return _el$30;
      }
    }), null);
    _$insert(_el$29, _$createComponent(Show, {
      get when() {
        return activeGoals().length > 0;
      },
      get fallback() {
        return (() => {
          var _el$65 = _$createElement("box"), _el$66 = _$createElement("text"), _el$67 = _$createElement("span"), _el$69 = _$createElement("span"), _el$71 = _$createElement("span"), _el$73 = _$createElement("text"), _el$74 = _$createElement("span"), _el$76 = _$createElement("span"), _el$78 = _$createElement("span"), _el$80 = _$createElement("span"), _el$82 = _$createElement("span"), _el$84 = _$createElement("span"), _el$86 = _$createElement("span");
          _$insertNode(_el$65, _el$66);
          _$insertNode(_el$65, _el$73);
          _$setProp(_el$65, "flexDirection", "column");
          _$setProp(_el$65, "gap", 1);
          _$setProp(_el$65, "padding", 1);
          _$insertNode(_el$66, _el$67);
          _$insertNode(_el$66, _el$69);
          _$insertNode(_el$66, _el$71);
          _$insertNode(_el$67, _$createTextNode(`No active goals.`));
          _$insertNode(_el$69, _$createTextNode(` /goal`));
          _$insertNode(_el$71, _$createTextNode(` in parent chat to create one.`));
          _$insertNode(_el$73, _el$74);
          _$insertNode(_el$73, _el$76);
          _$insertNode(_el$73, _el$78);
          _$insertNode(_el$73, _el$80);
          _$insertNode(_el$73, _el$82);
          _$insertNode(_el$73, _el$84);
          _$insertNode(_el$73, _el$86);
          _$insertNode(_el$74, _$createTextNode(`Tip: `));
          _$insertNode(_el$76, _$createTextNode(`:send`));
          _$insertNode(_el$78, _$createTextNode(` to steer the worker \xB7 `));
          _$insertNode(_el$80, _$createTextNode(`o`));
          _$insertNode(_el$82, _$createTextNode(` to open child \xB7 `));
          _$insertNode(_el$84, _$createTextNode(`:force`));
          _$insertNode(_el$86, _$createTextNode(` to complete manually.`));
          _$effect((_p$) => {
            var _v$21 = {
              fg: theme().textMuted
            }, _v$22 = {
              fg: theme().accent
            }, _v$23 = {
              fg: theme().textMuted
            }, _v$24 = {
              fg: theme().textMuted
            }, _v$25 = {
              fg: theme().warning
            }, _v$26 = {
              fg: theme().textMuted
            }, _v$27 = {
              fg: theme().warning
            }, _v$28 = {
              fg: theme().textMuted
            }, _v$29 = {
              fg: theme().warning
            }, _v$30 = {
              fg: theme().textMuted
            };
            _v$21 !== _p$.e && (_p$.e = _$setProp(_el$67, "style", _v$21, _p$.e));
            _v$22 !== _p$.t && (_p$.t = _$setProp(_el$69, "style", _v$22, _p$.t));
            _v$23 !== _p$.a && (_p$.a = _$setProp(_el$71, "style", _v$23, _p$.a));
            _v$24 !== _p$.o && (_p$.o = _$setProp(_el$74, "style", _v$24, _p$.o));
            _v$25 !== _p$.i && (_p$.i = _$setProp(_el$76, "style", _v$25, _p$.i));
            _v$26 !== _p$.n && (_p$.n = _$setProp(_el$78, "style", _v$26, _p$.n));
            _v$27 !== _p$.s && (_p$.s = _$setProp(_el$80, "style", _v$27, _p$.s));
            _v$28 !== _p$.h && (_p$.h = _$setProp(_el$82, "style", _v$28, _p$.h));
            _v$29 !== _p$.r && (_p$.r = _$setProp(_el$84, "style", _v$29, _p$.r));
            _v$30 !== _p$.d && (_p$.d = _$setProp(_el$86, "style", _v$30, _p$.d));
            return _p$;
          }, {
            e: undefined,
            t: undefined,
            a: undefined,
            o: undefined,
            i: undefined,
            n: undefined,
            s: undefined,
            h: undefined,
            r: undefined,
            d: undefined
          });
          return _el$65;
        })();
      },
      get children() {
        var _el$34 = _$createElement("scrollbox");
        _$use((el) => {
          listScrollRef = el;
        }, _el$34);
        _$insert(_el$34, _$createComponent(For, {
          get each() {
            return activeGoals();
          },
          children: (goal, i) => {
            const runtime = () => state()?.runtimes.find((r) => r.goalID === goal.id);
            const isActive = () => i() === selected();
            const maxTurns = goal.config?.maxTurns;
            const turnColor = () => {
              if (!runtime() || !maxTurns)
                return phaseColor(runtime()?.phase || "idle", theme());
              const ratio = runtime().budgetTurnCount / maxTurns;
              if (ratio >= 1)
                return theme().error;
              if (ratio >= 0.8)
                return theme().warning;
              return phaseColor(runtime().phase || "idle", theme());
            };
            return (() => {
              var _el$88 = _$createElement("box"), _el$89 = _$createElement("text"), _el$90 = _$createElement("span"), _el$91 = _$createElement("span"), _el$93 = _$createElement("span"), _el$95 = _$createElement("span");
              _$insertNode(_el$88, _el$89);
              _$setProp(_el$88, "flexDirection", "row");
              _$setProp(_el$88, "paddingLeft", 1);
              _$setProp(_el$88, "paddingRight", 1);
              _$insertNode(_el$89, _el$90);
              _$insertNode(_el$89, _el$91);
              _$insertNode(_el$89, _el$93);
              _$insertNode(_el$89, _el$95);
              _$setProp(_el$89, "wrapMode", "none");
              _$setProp(_el$89, "truncate", true);
              _$insert(_el$90, (() => {
                var _c$2 = _$memo(() => !!isActive());
                return () => _c$2() ? `\u25B6 ${statusIcon(goal.status)} ${goal.name}` : `  ${statusIcon(goal.status)} ${goal.name}`;
              })());
              _$insertNode(_el$91, _$createTextNode(` \u2502 `));
              _$insertNode(_el$93, _$createTextNode(`Goal `));
              _$insert(_el$95, () => goalStatusLabel(goal.status).short.toUpperCase());
              _$insert(_el$89, (() => {
                var _c$3 = _$memo(() => !!runtime());
                return () => _c$3() && [(() => {
                  var _el$96 = _$createElement("span");
                  _$insertNode(_el$96, _$createTextNode(` \u2502 Worker `));
                  _$effect((_$p) => _$setProp(_el$96, "style", {
                    fg: theme().textMuted
                  }, _$p));
                  return _el$96;
                })(), (() => {
                  var _el$98 = _$createElement("span"), _el$99 = _$createTextNode(` `);
                  _$insertNode(_el$98, _el$99);
                  _$insert(_el$98, (() => {
                    var _c$1 = _$memo(() => runtime().phase === "running");
                    return () => _c$1() ? runningFrame() : phaseIcon(runtime().phase);
                  })(), _el$99);
                  _$insert(_el$98, () => phaseLabel(runtime().phase).short.toUpperCase(), null);
                  _$effect((_$p) => _$setProp(_el$98, "style", {
                    fg: turnColor(),
                    bold: runtime().phase === "running"
                  }, _$p));
                  return _el$98;
                })(), (() => {
                  var _el$100 = _$createElement("span"), _el$101 = _$createTextNode(` `);
                  _$insertNode(_el$100, _el$101);
                  _$insert(_el$100, () => runtime().budgetTurnCount, null);
                  _$insert(_el$100, maxTurns ? `/${maxTurns}` : "", null);
                  _$effect((_$p) => _$setProp(_el$100, "style", {
                    fg: turnColor()
                  }, _$p));
                  return _el$100;
                })(), (() => {
                  var _el$102 = _$createElement("span"), _el$103 = _$createTextNode(` `);
                  _$insertNode(_el$102, _el$103);
                  _$insert(_el$102, () => ageLabel(runtime().lastProgressAt || runtime().lastRunAt, clock()), null);
                  _$effect((_$p) => _$setProp(_el$102, "style", {
                    fg: theme().textMuted
                  }, _$p));
                  return _el$102;
                })()];
              })(), null);
              _$insert(_el$89, (() => {
                var _c$4 = _$memo(() => !!(runtime() && runtime().consecutiveFailures > 0));
                return () => _c$4() && (() => {
                  var _el$104 = _$createElement("span"), _el$105 = _$createTextNode(` \u2502 \u26A0 `), _el$106 = _$createTextNode(` fail`);
                  _$insertNode(_el$104, _el$105);
                  _$insertNode(_el$104, _el$106);
                  _$insert(_el$104, () => runtime().consecutiveFailures, _el$106);
                  _$effect((_$p) => _$setProp(_el$104, "style", {
                    fg: theme().error,
                    bold: true
                  }, _$p));
                  return _el$104;
                })();
              })(), null);
              _$insert(_el$89, (() => {
                var _c$5 = _$memo(() => !!(runtime() && (runtime().noProgressCount || 0) > 0));
                return () => _c$5() && (() => {
                  var _el$107 = _$createElement("span"), _el$108 = _$createTextNode(` \u2502 `), _el$109 = _$createTextNode(` no-progress`);
                  _$insertNode(_el$107, _el$108);
                  _$insertNode(_el$107, _el$109);
                  _$insert(_el$107, () => runtime().noProgressCount, _el$109);
                  _$effect((_$p) => _$setProp(_el$107, "style", {
                    fg: theme().warning
                  }, _$p));
                  return _el$107;
                })();
              })(), null);
              _$insert(_el$89, (() => {
                var _c$6 = _$memo(() => !!(runtime() && runtime().evaluatorRejectionCount > 0));
                return () => _c$6() && (() => {
                  var _el$110 = _$createElement("span"), _el$111 = _$createTextNode(` \u2502 \u26A0 `), _el$112 = _$createTextNode(` rejected`);
                  _$insertNode(_el$110, _el$111);
                  _$insertNode(_el$110, _el$112);
                  _$insert(_el$110, () => String(runtime().evaluatorRejectionCount), _el$112);
                  _$effect((_$p) => _$setProp(_el$110, "style", {
                    fg: theme().warning,
                    bold: true
                  }, _$p));
                  return _el$110;
                })();
              })(), null);
              _$insert(_el$89, (() => {
                var _c$7 = _$memo(() => !!(runtime() && runtime().unknownStatusCount >= 3));
                return () => _c$7() && (() => {
                  var _el$113 = _$createElement("span");
                  _$insertNode(_el$113, _$createTextNode(` \u2502 \u26A0\uFE0F UNREACHABLE`));
                  _$effect((_$p) => _$setProp(_el$113, "style", {
                    fg: theme().error,
                    bold: true
                  }, _$p));
                  return _el$113;
                })();
              })(), null);
              _$insert(_el$89, (() => {
                var _c$8 = _$memo(() => !!(runtime() && runtime().phase === "idle" && runtime().activeRunID));
                return () => _c$8() && (() => {
                  var _el$115 = _$createElement("span");
                  _$insertNode(_el$115, _$createTextNode(` \u2502 \u26A0\uFE0F STALE LEASE`));
                  _$effect((_$p) => _$setProp(_el$115, "style", {
                    fg: theme().error,
                    bold: true
                  }, _$p));
                  return _el$115;
                })();
              })(), null);
              _$insert(_el$89, (() => {
                var _c$9 = _$memo(() => !!(runtime() && runtime().retryAfter));
                return () => _c$9() && (() => {
                  var _el$117 = _$createElement("span"), _el$118 = _$createTextNode(` \u2502 \u21BB `);
                  _$insertNode(_el$117, _el$118);
                  _$insert(_el$117, () => countdownLabel(runtime().retryAfter, clock()), null);
                  _$effect((_$p) => _$setProp(_el$117, "style", {
                    fg: theme().accent
                  }, _$p));
                  return _el$117;
                })();
              })(), null);
              _$insert(_el$89, (() => {
                var _c$0 = _$memo(() => !!(runtime() && runtime().nextRunAt));
                return () => _c$0() && (() => {
                  var _el$119 = _$createElement("span"), _el$120 = _$createTextNode(` \u2502 \u23F0 `);
                  _$insertNode(_el$119, _el$120);
                  _$insert(_el$119, () => countdownLabel(runtime().nextRunAt, clock()), null);
                  _$effect((_$p) => _$setProp(_el$119, "style", {
                    fg: theme().accent
                  }, _$p));
                  return _el$119;
                })();
              })(), null);
              _$effect((_p$) => {
                var _v$31 = rowIdFor(goal.id), _v$32 = isActive() ? theme().backgroundElement : undefined, _v$33 = {
                  fg: statusColor(goal.status, theme()),
                  bold: isActive()
                }, _v$34 = {
                  fg: theme().textMuted
                }, _v$35 = {
                  fg: theme().textMuted
                }, _v$36 = {
                  fg: statusColor(goal.status, theme()),
                  bold: true
                };
                _v$31 !== _p$.e && (_p$.e = _$setProp(_el$88, "id", _v$31, _p$.e));
                _v$32 !== _p$.t && (_p$.t = _$setProp(_el$88, "backgroundColor", _v$32, _p$.t));
                _v$33 !== _p$.a && (_p$.a = _$setProp(_el$90, "style", _v$33, _p$.a));
                _v$34 !== _p$.o && (_p$.o = _$setProp(_el$91, "style", _v$34, _p$.o));
                _v$35 !== _p$.i && (_p$.i = _$setProp(_el$93, "style", _v$35, _p$.i));
                _v$36 !== _p$.n && (_p$.n = _$setProp(_el$95, "style", _v$36, _p$.n));
                return _p$;
              }, {
                e: undefined,
                t: undefined,
                a: undefined,
                o: undefined,
                i: undefined,
                n: undefined
              });
              return _el$88;
            })();
          }
        }));
        _$effect((_$p) => _$setProp(_el$34, "height", listHeight(), _$p));
        return _el$34;
      }
    }), null);
    _$insert(_el$29, _$createComponent(Show, {
      get when() {
        return selectedGoal();
      },
      children: (goal) => {
        const rt = () => state()?.runtimes.find((r) => r.goalID === goal().id);
        const lp = () => goal().lastProgress;
        const blk = () => goal().blocker;
        return (() => {
          var _el$121 = _$createElement("box"), _el$122 = _$createElement("text"), _el$123 = _$createElement("span"), _el$124 = _$createTextNode(` `), _el$125 = _$createElement("span"), _el$127 = _$createElement("span"), _el$128 = _$createTextNode(` \u2014 `), _el$129 = _$createTextNode(`
`), _el$130 = _$createElement("span"), _el$131 = _$createTextNode(`
`), _el$132 = _$createElement("span"), _el$134 = _$createElement("span");
          _$insertNode(_el$121, _el$122);
          _$setProp(_el$121, "flexDirection", "column");
          _$setProp(_el$121, "border", true);
          _$setProp(_el$121, "padding", 1);
          _$setProp(_el$121, "flexShrink", 0);
          _$setProp(_el$121, "maxHeight", 13);
          _$insertNode(_el$122, _el$123);
          _$insertNode(_el$122, _el$125);
          _$insertNode(_el$122, _el$127);
          _$insertNode(_el$122, _el$129);
          _$insertNode(_el$122, _el$130);
          _$insertNode(_el$122, _el$131);
          _$insertNode(_el$122, _el$132);
          _$insertNode(_el$122, _el$134);
          _$insertNode(_el$123, _el$124);
          _$insert(_el$123, () => statusIcon(goal().status), _el$124);
          _$insert(_el$123, () => goal().name, null);
          _$insertNode(_el$125, _$createTextNode(` Goal `));
          _$insertNode(_el$127, _el$128);
          _$insert(_el$127, () => goalStatusLabel(goal().status).short, _el$128);
          _$insert(_el$127, () => goalStatusLabel(goal().status).hint, null);
          _$insert(_el$122, (() => {
            var _c$10 = _$memo(() => !!rt());
            return () => _c$10() && [(() => {
              var _el$135 = _$createElement("span");
              _$insertNode(_el$135, _$createTextNode(` \u2502 Worker `));
              _$effect((_$p) => _$setProp(_el$135, "style", {
                fg: theme().textMuted
              }, _$p));
              return _el$135;
            })(), (() => {
              var _el$137 = _$createElement("span"), _el$138 = _$createTextNode(` `), _el$139 = _$createTextNode(` \u2014 `);
              _$insertNode(_el$137, _el$138);
              _$insertNode(_el$137, _el$139);
              _$insert(_el$137, () => phaseIcon(rt().phase), _el$138);
              _$insert(_el$137, () => phaseLabel(rt().phase).short, _el$139);
              _$insert(_el$137, () => phaseLabel(rt().phase).hint, null);
              _$effect((_$p) => _$setProp(_el$137, "style", {
                fg: phaseColor(rt().phase, theme()),
                bold: true
              }, _$p));
              return _el$137;
            })(), (() => {
              var _el$140 = _$createElement("span"), _el$141 = _$createTextNode(` run `), _el$142 = _$createTextNode(` (budget `), _el$143 = _$createTextNode(`)`);
              _$insertNode(_el$140, _el$141);
              _$insertNode(_el$140, _el$142);
              _$insertNode(_el$140, _el$143);
              _$insert(_el$140, () => rt().runCount, _el$142);
              _$insert(_el$140, () => rt().budgetTurnCount, _el$143);
              _$effect((_$p) => _$setProp(_el$140, "style", {
                fg: theme().textMuted
              }, _$p));
              return _el$140;
            })()];
          })(), _el$129);
          _$insert(_el$130, () => describeGoalState(goal().status, rt()?.phase));
          _$insert(_el$122, (() => {
            var _c$11 = _$memo(() => !!rt()?.workerAbortedAt);
            return () => _c$11() && [(() => {
              var _el$144 = _$createElement("span");
              _$insertNode(_el$144, _$createTextNode(` \u2502 \u26A0 worker aborted `));
              _$effect((_$p) => _$setProp(_el$144, "style", {
                fg: theme().warning,
                bold: true
              }, _$p));
              return _el$144;
            })(), (() => {
              var _el$146 = _$createElement("span"), _el$147 = _$createTextNode(` \u2014 session kept, next turn reuses it`);
              _$insertNode(_el$146, _el$147);
              _$insert(_el$146, () => ageLabel(rt().workerAbortedAt, clock()), _el$147);
              _$effect((_$p) => _$setProp(_el$146, "style", {
                fg: theme().textMuted
              }, _$p));
              return _el$146;
            })()];
          })(), _el$131);
          _$insert(_el$122, () => {
            const agentName = goal().config.agent;
            const meta = agentName ? agentIndex()[agentName] ?? agentIndex()[agentName.toLowerCase()] : undefined;
            const model = goal().config.model;
            const slash = model?.indexOf("/") ?? -1;
            return [`
`, (() => {
              var _el$148 = _$createElement("span");
              _$insertNode(_el$148, _$createTextNode(`\uD83E\uDD16 `));
              _$effect((_$p) => _$setProp(_el$148, "style", {
                fg: theme().textMuted
              }, _$p));
              return _el$148;
            })(), (() => {
              var _el$150 = _$createElement("span");
              _$insertNode(_el$150, _$createTextNode(`Agent: `));
              _$effect((_$p) => _$setProp(_el$150, "style", {
                fg: theme().primary,
                bold: true
              }, _$p));
              return _el$150;
            })(), _$memo(() => agentName ? [(() => {
              var _el$166 = _$createElement("span");
              _$insert(_el$166, agentName);
              _$effect((_$p) => _$setProp(_el$166, "style", {
                fg: agentColor(meta?.color, theme()),
                bold: true
              }, _$p));
              return _el$166;
            })(), _$memo(() => _$memo(() => !!meta?.mode)() && (() => {
              var _el$167 = _$createElement("span"), _el$168 = _$createTextNode(` (`), _el$169 = _$createTextNode(`)`);
              _$insertNode(_el$167, _el$168);
              _$insertNode(_el$167, _el$169);
              _$insert(_el$167, () => meta.mode, _el$169);
              _$effect((_$p) => _$setProp(_el$167, "style", {
                fg: theme().textMuted
              }, _$p));
              return _el$167;
            })())] : goal().parentAgent ? [(() => {
              var _el$170 = _$createElement("span");
              _$insertNode(_el$170, _$createTextNode(`\u21A9 `));
              _$effect((_$p) => _$setProp(_el$170, "style", {
                fg: theme().textMuted
              }, _$p));
              return _el$170;
            })(), (() => {
              var _el$172 = _$createElement("span");
              _$insert(_el$172, () => goal().parentAgent);
              _$effect((_$p) => _$setProp(_el$172, "style", {
                fg: theme().text,
                bold: true
              }, _$p));
              return _el$172;
            })(), (() => {
              var _el$173 = _$createElement("span");
              _$insertNode(_el$173, _$createTextNode(` (parent)`));
              _$effect((_$p) => _$setProp(_el$173, "style", {
                fg: theme().textMuted
              }, _$p));
              return _el$173;
            })()] : (() => {
              var _el$175 = _$createElement("span");
              _$insertNode(_el$175, _$createTextNode(`parent`));
              _$effect((_$p) => _$setProp(_el$175, "style", {
                fg: theme().textMuted
              }, _$p));
              return _el$175;
            })()), (() => {
              var _el$152 = _$createElement("span");
              _$insertNode(_el$152, _$createTextNode(` \u2502 \uD83E\uDDE0 `));
              _$effect((_$p) => _$setProp(_el$152, "style", {
                fg: theme().textMuted
              }, _$p));
              return _el$152;
            })(), (() => {
              var _el$154 = _$createElement("span");
              _$insertNode(_el$154, _$createTextNode(`Model: `));
              _$effect((_$p) => _$setProp(_el$154, "style", {
                fg: theme().primary,
                bold: true
              }, _$p));
              return _el$154;
            })(), _$memo(() => model && slash > 0 ? [(() => {
              var _el$177 = _$createElement("span"), _el$178 = _$createTextNode(`/`);
              _$insertNode(_el$177, _el$178);
              _$insert(_el$177, () => model.slice(0, slash), _el$178);
              _$effect((_$p) => _$setProp(_el$177, "style", {
                fg: theme().textMuted
              }, _$p));
              return _el$177;
            })(), (() => {
              var _el$179 = _$createElement("span");
              _$insert(_el$179, () => model.slice(slash + 1));
              _$effect((_$p) => _$setProp(_el$179, "style", {
                fg: theme().info,
                bold: true
              }, _$p));
              return _el$179;
            })()] : goal().parentModel ? [(() => {
              var _el$180 = _$createElement("span");
              _$insertNode(_el$180, _$createTextNode(`\u21A9 `));
              _$effect((_$p) => _$setProp(_el$180, "style", {
                fg: theme().textMuted
              }, _$p));
              return _el$180;
            })(), (() => {
              var _el$182 = _$createElement("span");
              _$insert(_el$182, () => goal().parentModel);
              _$effect((_$p) => _$setProp(_el$182, "style", {
                fg: theme().info,
                bold: true
              }, _$p));
              return _el$182;
            })(), (() => {
              var _el$183 = _$createElement("span");
              _$insertNode(_el$183, _$createTextNode(` (parent)`));
              _$effect((_$p) => _$setProp(_el$183, "style", {
                fg: theme().textMuted
              }, _$p));
              return _el$183;
            })()] : (() => {
              var _el$185 = _$createElement("span");
              _$insertNode(_el$185, _$createTextNode(`parent`));
              _$effect((_$p) => _$setProp(_el$185, "style", {
                fg: theme().textMuted
              }, _$p));
              return _el$185;
            })()), (() => {
              var _el$156 = _$createElement("span");
              _$insertNode(_el$156, _$createTextNode(` \u2502 \uD83D\uDCB0 `));
              _$effect((_$p) => _$setProp(_el$156, "style", {
                fg: theme().textMuted
              }, _$p));
              return _el$156;
            })(), (() => {
              var _el$158 = _$createElement("span");
              _$insertNode(_el$158, _$createTextNode(`Spent: `));
              _$effect((_$p) => _$setProp(_el$158, "style", {
                fg: theme().primary,
                bold: true
              }, _$p));
              return _el$158;
            })(), (() => {
              var _el$160 = _$createElement("span");
              _$insert(_el$160, () => formatCost(goal().costUsed));
              _$effect((_$p) => _$setProp(_el$160, "style", {
                fg: theme().success,
                bold: true
              }, _$p));
              return _el$160;
            })(), (() => {
              var _el$161 = _$createElement("span");
              _$insertNode(_el$161, _$createTextNode(` \xB7 `));
              _$effect((_$p) => _$setProp(_el$161, "style", {
                fg: theme().textMuted
              }, _$p));
              return _el$161;
            })(), (() => {
              var _el$163 = _$createElement("span");
              _$insert(_el$163, () => formatTokens(goal().tokensUsed));
              _$effect((_$p) => _$setProp(_el$163, "style", {
                fg: theme().warning,
                bold: true
              }, _$p));
              return _el$163;
            })(), (() => {
              var _el$164 = _$createElement("span"), _el$165 = _$createTextNode(` tokens \xB7 `);
              _$insertNode(_el$164, _el$165);
              _$insert(_el$164, () => formatDuration(goal().timeUsedSeconds), null);
              _$effect((_$p) => _$setProp(_el$164, "style", {
                fg: theme().textMuted
              }, _$p));
              return _el$164;
            })()];
          }, _el$131);
          _$insertNode(_el$132, _$createTextNode(`\uD83C\uDFAF Target: `));
          _$insert(_el$134, () => goal().objective.slice(0, 160));
          _$insert(_el$122, (() => {
            var _c$12 = _$memo(() => !!lp());
            return () => _c$12() && [(() => {
              var _el$187 = _$createElement("span"), _el$188 = _$createTextNode(`
\u2714 `);
              _$insertNode(_el$187, _el$188);
              _$effect((_$p) => _$setProp(_el$187, "style", {
                fg: theme().success
              }, _$p));
              return _el$187;
            })(), (() => {
              var _el$190 = _$createElement("span");
              _$insertNode(_el$190, _$createTextNode(`Progress: `));
              _$effect((_$p) => _$setProp(_el$190, "style", {
                fg: theme().success,
                bold: true
              }, _$p));
              return _el$190;
            })(), (() => {
              var _el$192 = _$createElement("span");
              _$insert(_el$192, () => lp().summary.slice(0, 100));
              _$effect((_$p) => _$setProp(_el$192, "style", {
                fg: theme().text
              }, _$p));
              return _el$192;
            })(), (() => {
              var _el$193 = _$createElement("span"), _el$194 = _$createTextNode(` \u2192 `);
              _$insertNode(_el$193, _el$194);
              _$insert(_el$193, () => lp().next?.slice(0, 60) || "", null);
              _$effect((_$p) => _$setProp(_el$193, "style", {
                fg: theme().textMuted
              }, _$p));
              return _el$193;
            })()];
          })(), null);
          _$insert(_el$122, (() => {
            var _c$13 = _$memo(() => !!blk());
            return () => _c$13() && [(() => {
              var _el$195 = _$createElement("span"), _el$196 = _$createTextNode(`
\u2716 Blocked: `);
              _$insertNode(_el$195, _el$196);
              _$effect((_$p) => _$setProp(_el$195, "style", {
                fg: theme().error,
                bold: true
              }, _$p));
              return _el$195;
            })(), (() => {
              var _el$198 = _$createElement("span");
              _$insert(_el$198, () => blk().reason.slice(0, 140));
              _$effect((_$p) => _$setProp(_el$198, "style", {
                fg: theme().error
              }, _$p));
              return _el$198;
            })(), (() => {
              var _el$199 = _$createElement("span"), _el$200 = _$createTextNode(` \u2014 `);
              _$insertNode(_el$199, _el$200);
              _$insert(_el$199, () => blk().needed.slice(0, 60), null);
              _$effect((_$p) => _$setProp(_el$199, "style", {
                fg: theme().textMuted
              }, _$p));
              return _el$199;
            })()];
          })(), null);
          _$insert(_el$122, (() => {
            var _c$14 = _$memo(() => !!goal().config.artifactDir);
            return () => _c$14() && [(() => {
              var _el$201 = _$createElement("span"), _el$202 = _$createTextNode(`
\uD83D\uDCC1 `);
              _$insertNode(_el$201, _el$202);
              _$effect((_$p) => _$setProp(_el$201, "style", {
                fg: theme().accent
              }, _$p));
              return _el$201;
            })(), (() => {
              var _el$204 = _$createElement("span");
              _$insertNode(_el$204, _$createTextNode(`Artifacts: `));
              _$effect((_$p) => _$setProp(_el$204, "style", {
                fg: theme().accent,
                bold: true
              }, _$p));
              return _el$204;
            })(), (() => {
              var _el$206 = _$createElement("span");
              _$insert(_el$206, () => String(goal().config.artifactDir).replace(String(props.directory), "."));
              _$effect((_$p) => _$setProp(_el$206, "style", {
                fg: theme().textMuted
              }, _$p));
              return _el$206;
            })()];
          })(), null);
          _$insert(_el$122, (() => {
            var _c$15 = _$memo(() => (goal().config.checks?.length ?? 0) > 0);
            return () => _c$15() ? [(() => {
              var _el$207 = _$createElement("span"), _el$208 = _$createTextNode(`
\u25A3 `);
              _$insertNode(_el$207, _el$208);
              _$effect((_$p) => _$setProp(_el$207, "style", {
                fg: theme().warning
              }, _$p));
              return _el$207;
            })(), (() => {
              var _el$210 = _$createElement("span");
              _$insertNode(_el$210, _$createTextNode(`Checks: `));
              _$effect((_$p) => _$setProp(_el$210, "style", {
                fg: theme().warning,
                bold: true
              }, _$p));
              return _el$210;
            })(), (() => {
              var _el$212 = _$createElement("span");
              _$insert(_el$212, () => goal().config.checks.join(", ").slice(0, 100));
              _$effect((_$p) => _$setProp(_el$212, "style", {
                fg: theme().textMuted
              }, _$p));
              return _el$212;
            })()] : null;
          })(), null);
          _$insert(_el$122, (() => {
            var _c$16 = _$memo(() => rt()?.evaluatorRejectionCount > 0);
            return () => _c$16() && [(() => {
              var _el$213 = _$createElement("span"), _el$214 = _$createTextNode(`
\u26A0 rejections: `);
              _$insertNode(_el$213, _el$214);
              _$effect((_$p) => _$setProp(_el$213, "style", {
                fg: theme().warning
              }, _$p));
              return _el$213;
            })(), (() => {
              var _el$216 = _$createElement("span"), _el$217 = _$createTextNode(` \u2014 `);
              _$insertNode(_el$216, _el$217);
              _$insert(_el$216, () => String(rt().evaluatorRejectionCount), _el$217);
              _$insert(_el$216, () => String(rt().lastRejectionDetails || "").slice(0, 80), null);
              _$effect((_$p) => _$setProp(_el$216, "style", {
                fg: theme().warning
              }, _$p));
              return _el$216;
            })()];
          })(), null);
          _$insert(_el$122, (() => {
            var _c$17 = _$memo(() => rt()?.unknownStatusCount > 0);
            return () => _c$17() && [(() => {
              var _el$218 = _$createElement("span"), _el$219 = _$createTextNode(`
\u26A0\uFE0F unreachable: `);
              _$insertNode(_el$218, _el$219);
              _$effect((_$p) => _$setProp(_el$218, "style", {
                fg: theme().error
              }, _$p));
              return _el$218;
            })(), (() => {
              var _el$221 = _$createElement("span"), _el$222 = _$createTextNode(`/3`);
              _$insertNode(_el$221, _el$222);
              _$insert(_el$221, () => String(rt().unknownStatusCount), _el$222);
              _$effect((_$p) => _$setProp(_el$221, "style", {
                fg: theme().error
              }, _$p));
              return _el$221;
            })(), (() => {
              var _el$223 = _$createElement("span");
              _$insertNode(_el$223, _$createTextNode(` \u2014 nudge to recover`));
              _$effect((_$p) => _$setProp(_el$223, "style", {
                fg: theme().textMuted
              }, _$p));
              return _el$223;
            })()];
          })(), null);
          _$insert(_el$122, (() => {
            var _c$18 = _$memo(() => !!rt()?.retryAfter);
            return () => _c$18() && [(() => {
              var _el$225 = _$createElement("span"), _el$226 = _$createTextNode(`
\u21BB retry in: `);
              _$insertNode(_el$225, _el$226);
              _$effect((_$p) => _$setProp(_el$225, "style", {
                fg: theme().accent
              }, _$p));
              return _el$225;
            })(), (() => {
              var _el$228 = _$createElement("span");
              _$insert(_el$228, () => countdownLabel(rt().retryAfter, clock()));
              _$effect((_$p) => _$setProp(_el$228, "style", {
                fg: theme().accent
              }, _$p));
              return _el$228;
            })()];
          })(), null);
          _$insert(_el$122, (() => {
            var _c$19 = _$memo(() => !!rt()?.nextRunAt);
            return () => _c$19() && [(() => {
              var _el$229 = _$createElement("span"), _el$230 = _$createTextNode(`
\u23F0 next run: `);
              _$insertNode(_el$229, _el$230);
              _$effect((_$p) => _$setProp(_el$229, "style", {
                fg: theme().accent
              }, _$p));
              return _el$229;
            })(), (() => {
              var _el$232 = _$createElement("span");
              _$insert(_el$232, () => countdownLabel(rt().nextRunAt, clock()));
              _$effect((_$p) => _$setProp(_el$232, "style", {
                fg: theme().accent
              }, _$p));
              return _el$232;
            })(), (() => {
              var _el$233 = _$createElement("span"), _el$234 = _$createTextNode(` (`), _el$235 = _$createTextNode(` runs)`);
              _$insertNode(_el$233, _el$234);
              _$insertNode(_el$233, _el$235);
              _$insert(_el$233, () => String(rt().scheduleRunCount || 0), _el$235);
              _$effect((_$p) => _$setProp(_el$233, "style", {
                fg: theme().textMuted
              }, _$p));
              return _el$233;
            })()];
          })(), null);
          _$insert(_el$122, (() => {
            var _c$20 = _$memo(() => !!rt()?.lastError);
            return () => _c$20() && [(() => {
              var _el$236 = _$createElement("span"), _el$237 = _$createTextNode(`
\u26A0 `);
              _$insertNode(_el$236, _el$237);
              _$effect((_$p) => _$setProp(_el$236, "style", {
                fg: theme().error
              }, _$p));
              return _el$236;
            })(), (() => {
              var _el$239 = _$createElement("span");
              _$insertNode(_el$239, _$createTextNode(`Error: `));
              _$effect((_$p) => _$setProp(_el$239, "style", {
                fg: theme().error,
                bold: true
              }, _$p));
              return _el$239;
            })(), (() => {
              var _el$241 = _$createElement("span");
              _$insert(_el$241, () => rt().lastError.slice(0, 120));
              _$effect((_$p) => _$setProp(_el$241, "style", {
                fg: theme().error
              }, _$p));
              return _el$241;
            })()];
          })(), null);
          _$effect((_p$) => {
            var _v$37 = borderColorForStatus(goal().status, theme()), _v$38 = {
              fg: statusColor(goal().status, theme()),
              bold: true
            }, _v$39 = {
              fg: theme().textMuted
            }, _v$40 = {
              fg: statusColor(goal().status, theme())
            }, _v$41 = {
              fg: theme().textMuted
            }, _v$42 = {
              fg: theme().primary,
              bold: true
            }, _v$43 = {
              fg: theme().text
            };
            _v$37 !== _p$.e && (_p$.e = _$setProp(_el$121, "borderColor", _v$37, _p$.e));
            _v$38 !== _p$.t && (_p$.t = _$setProp(_el$123, "style", _v$38, _p$.t));
            _v$39 !== _p$.a && (_p$.a = _$setProp(_el$125, "style", _v$39, _p$.a));
            _v$40 !== _p$.o && (_p$.o = _$setProp(_el$127, "style", _v$40, _p$.o));
            _v$41 !== _p$.i && (_p$.i = _$setProp(_el$130, "style", _v$41, _p$.i));
            _v$42 !== _p$.n && (_p$.n = _$setProp(_el$132, "style", _v$42, _p$.n));
            _v$43 !== _p$.s && (_p$.s = _$setProp(_el$134, "style", _v$43, _p$.s));
            return _p$;
          }, {
            e: undefined,
            t: undefined,
            a: undefined,
            o: undefined,
            i: undefined,
            n: undefined,
            s: undefined
          });
          return _el$121;
        })();
      }
    }), null);
    _$insert(_el$29, _$createComponent(Show, {
      get when() {
        return _$memo(() => !!showLogs())() && events().length > 0;
      },
      get children() {
        var _el$35 = _$createElement("box"), _el$36 = _$createElement("text"), _el$37 = _$createElement("span"), _el$39 = _$createElement("span");
        _$insertNode(_el$35, _el$36);
        _$setProp(_el$35, "flexDirection", "column");
        _$setProp(_el$35, "border", true);
        _$setProp(_el$35, "padding", 1);
        _$setProp(_el$35, "maxHeight", 7);
        _$setProp(_el$35, "flexShrink", 0);
        _$setProp(_el$35, "overflow", "hidden");
        _$insertNode(_el$36, _el$37);
        _$insertNode(_el$36, _el$39);
        _$insertNode(_el$37, _$createTextNode(`\u25C8 Recent Events`));
        _$insertNode(_el$39, _$createTextNode(` \u2014 :logs to hide`));
        _$insert(_el$36, _$createComponent(For, {
          get each() {
            return events().slice(-10);
          },
          children: (ev) => [`
`, (() => {
            var _el$242 = _$createElement("span");
            _$insert(_el$242, () => String(ev.type));
            _$effect((_$p) => _$setProp(_el$242, "style", {
              fg: eventColor(String(ev.type), theme()),
              bold: true
            }, _$p));
            return _el$242;
          })(), (() => {
            var _el$243 = _$createElement("span"), _el$244 = _$createTextNode(` `);
            _$insertNode(_el$243, _el$244);
            _$insert(_el$243, () => ev.goalID?.slice(0, 8), null);
            _$effect((_$p) => _$setProp(_el$243, "style", {
              fg: theme().textMuted
            }, _$p));
            return _el$243;
          })(), _$memo(() => _$memo(() => !!ev.summary)() && (() => {
            var _el$245 = _$createElement("span"), _el$246 = _$createTextNode(` \u2014 `);
            _$insertNode(_el$245, _el$246);
            _$insert(_el$245, () => String(ev.summary).slice(0, 60), null);
            _$effect((_$p) => _$setProp(_el$245, "style", {
              fg: theme().text
            }, _$p));
            return _el$245;
          })())]
        }), null);
        _$effect((_p$) => {
          var _v$ = theme().border, _v$2 = {
            fg: theme().accent,
            bold: true
          }, _v$3 = {
            fg: theme().textMuted
          };
          _v$ !== _p$.e && (_p$.e = _$setProp(_el$35, "borderColor", _v$, _p$.e));
          _v$2 !== _p$.t && (_p$.t = _$setProp(_el$37, "style", _v$2, _p$.t));
          _v$3 !== _p$.a && (_p$.a = _$setProp(_el$39, "style", _v$3, _p$.a));
          return _p$;
        }, {
          e: undefined,
          t: undefined,
          a: undefined
        });
        return _el$35;
      }
    }), null);
    _$insertNode(_el$41, _el$42);
    _$insertNode(_el$41, _el$44);
    _$setProp(_el$41, "flexDirection", "row");
    _$setProp(_el$41, "border", true);
    _$setProp(_el$41, "paddingLeft", 1);
    _$setProp(_el$41, "paddingRight", 1);
    _$setProp(_el$41, "flexShrink", 0);
    _$setProp(_el$41, "height", 3);
    _$setProp(_el$41, "gap", 1);
    _$insertNode(_el$42, _el$43);
    _$insert(_el$43, () => mode() === "insert" ? " INSERT \uE0B1" : " NORMAL ");
    _$use((el) => {
      inputEl = el;
      focusInput();
    }, _el$44);
    _$setProp(_el$44, "flexGrow", 1);
    _$setProp(_el$44, "onInput", (v) => {
      debugLog("onInput", JSON.stringify(v), "mode", mode());
      if (mode() === "insert")
        setCommandInput(v);
      else if (inputEl?.value)
        inputEl.value = "";
    });
    _$setProp(_el$44, "onKeyDown", (evt) => {
      const name = evt.name || "";
      const seq = evt.sequence || "";
      debugLog("input onKeyDown", `name=${name} seq=${JSON.stringify(seq)} mode=${mode()} value=${JSON.stringify(commandInput())}`);
      if (mode() !== "insert") {
        if ((evt.name || "").length === 1)
          prevent(evt);
        return;
      }
    });
    _$effect((_p$) => {
      var _v$4 = theme().border, _v$5 = {
        fg: theme().primary,
        bold: true
      }, _v$6 = {
        fg: theme().textMuted
      }, _v$7 = {
        fg: mode() === "normal" ? theme().success : theme().warning,
        bold: true,
        bg: mode() === "insert" ? theme().backgroundElement : undefined
      }, _v$8 = {
        fg: theme().textMuted
      }, _v$9 = {
        fg: theme().accent,
        bold: true
      }, _v$0 = {
        fg: theme().textMuted
      }, _v$1 = {
        fg: theme().textMuted
      }, _v$10 = {
        fg: runningCount() > 0 ? theme().success : theme().textMuted,
        bold: runningCount() > 0
      }, _v$11 = {
        fg: theme().textMuted
      }, _v$12 = {
        fg: theme().info,
        bold: true
      }, _v$13 = {
        fg: theme().textMuted
      }, _v$14 = mode() === "insert" ? theme().warning : theme().border, _v$15 = {
        fg: mode() === "insert" ? theme().warning : theme().success,
        bold: true,
        bg: mode() === "insert" ? theme().backgroundElement : undefined
      }, _v$16 = mode() === "insert" ? ":send hello  or  :force done --evidence proof  or  :open  (Ctrl+N: normal)" : statusText() || "Press : to send/command  \xB7  ? help  \xB7  o open child  \xB7  q close", _v$17 = theme().textMuted, _v$18 = theme().primary, _v$19 = theme().text, _v$20 = theme().background;
      _v$4 !== _p$.e && (_p$.e = _$setProp(_el$2, "borderColor", _v$4, _p$.e));
      _v$5 !== _p$.t && (_p$.t = _$setProp(_el$5, "style", _v$5, _p$.t));
      _v$6 !== _p$.a && (_p$.a = _$setProp(_el$7, "style", _v$6, _p$.a));
      _v$7 !== _p$.o && (_p$.o = _$setProp(_el$9, "style", _v$7, _p$.o));
      _v$8 !== _p$.i && (_p$.i = _$setProp(_el$10, "style", _v$8, _p$.i));
      _v$9 !== _p$.n && (_p$.n = _$setProp(_el$12, "style", _v$9, _p$.n));
      _v$0 !== _p$.s && (_p$.s = _$setProp(_el$13, "style", _v$0, _p$.s));
      _v$1 !== _p$.h && (_p$.h = _$setProp(_el$15, "style", _v$1, _p$.h));
      _v$10 !== _p$.r && (_p$.r = _$setProp(_el$17, "style", _v$10, _p$.r));
      _v$11 !== _p$.d && (_p$.d = _$setProp(_el$20, "style", _v$11, _p$.d));
      _v$12 !== _p$.l && (_p$.l = _$setProp(_el$22, "style", _v$12, _p$.l));
      _v$13 !== _p$.u && (_p$.u = _$setProp(_el$23, "style", _v$13, _p$.u));
      _v$14 !== _p$.c && (_p$.c = _$setProp(_el$41, "borderColor", _v$14, _p$.c));
      _v$15 !== _p$.w && (_p$.w = _$setProp(_el$43, "style", _v$15, _p$.w));
      _v$16 !== _p$.m && (_p$.m = _$setProp(_el$44, "placeholder", _v$16, _p$.m));
      _v$17 !== _p$.f && (_p$.f = _$setProp(_el$44, "placeholderColor", _v$17, _p$.f));
      _v$18 !== _p$.y && (_p$.y = _$setProp(_el$44, "cursorColor", _v$18, _p$.y));
      _v$19 !== _p$.g && (_p$.g = _$setProp(_el$44, "focusedTextColor", _v$19, _p$.g));
      _v$20 !== _p$.p && (_p$.p = _$setProp(_el$44, "focusedBackgroundColor", _v$20, _p$.p));
      return _p$;
    }, {
      e: undefined,
      t: undefined,
      a: undefined,
      o: undefined,
      i: undefined,
      n: undefined,
      s: undefined,
      h: undefined,
      r: undefined,
      d: undefined,
      l: undefined,
      u: undefined,
      c: undefined,
      w: undefined,
      m: undefined,
      f: undefined,
      y: undefined,
      g: undefined,
      p: undefined
    });
    return _el$;
  })();
}

// src/tui/command-panel.tsx
import { effect as _$effect2 } from "@opentui/solid";
import { use as _$use2 } from "@opentui/solid";
import { memo as _$memo2 } from "@opentui/solid";
import { createComponent as _$createComponent2 } from "@opentui/solid";
import { insert as _$insert2 } from "@opentui/solid";
import { createTextNode as _$createTextNode2 } from "@opentui/solid";
import { insertNode as _$insertNode2 } from "@opentui/solid";
import { setProp as _$setProp2 } from "@opentui/solid";
import { createElement as _$createElement2 } from "@opentui/solid";
import { createSignal as createSignal2, For as For2, Show as Show2, onCleanup as onCleanup2, onMount as onMount2 } from "solid-js";
import { useKeyboard as useKeyboard2 } from "@opentui/solid";

// src/tui/command-controller.ts
function emptyCommandPanelState() {
  return { commands: [], selected: 0, selectedCommand: null, outputOffset: 0, statusText: "", inputMode: false };
}
function refreshCommandList(state, commands) {
  const prevID = state.selectedCommand?.id;
  let selected = 0;
  if (prevID) {
    const idx = commands.findIndex((c) => c.id === prevID);
    if (idx >= 0)
      selected = idx;
    else
      selected = Math.min(state.selected, Math.max(0, commands.length - 1));
  }
  return { ...state, commands, selected, selectedCommand: commands[selected] ?? null, outputOffset: 0 };
}
function moveCommandSelection(state, delta) {
  if (state.commands.length === 0)
    return state;
  const next = Math.min(Math.max(0, state.selected + delta), state.commands.length - 1);
  return { ...state, selected: next, selectedCommand: state.commands[next] ?? null, outputOffset: 0 };
}
function selectCommandFirst(state) {
  if (state.commands.length === 0)
    return state;
  return { ...state, selected: 0, selectedCommand: state.commands[0] ?? null, outputOffset: 0 };
}
function selectCommandLast(state) {
  if (state.commands.length === 0)
    return state;
  const last = state.commands.length - 1;
  return { ...state, selected: last, selectedCommand: state.commands[last] ?? null, outputOffset: 0 };
}
function parseCommandLine(input) {
  const args = [];
  let current = "";
  let quote;
  let escaped = false;
  let started = false;
  for (const char of input.trim()) {
    if (escaped) {
      current += char;
      escaped = false;
      started = true;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote) {
      if (char === quote)
        quote = undefined;
      else
        current += char;
      started = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) {
        args.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += char;
    started = true;
  }
  if (quote || escaped)
    return;
  if (started)
    args.push(current);
  return args;
}

// src/tui/command-stream-client.ts
import { promises as fs2 } from "fs";
import path2 from "path";

// src/domain/command-events.ts
var _encoder = new TextEncoder;
function utf8ByteLength(data) {
  return _encoder.encode(data).length;
}
function offsetsContinuous(prevEnd, nextStart) {
  return prevEnd === nextStart;
}
function expectedNextEnd(startOffset, data) {
  return startOffset + utf8ByteLength(data);
}
var VALID_STATUSES = [
  "running",
  "exited",
  "terminated",
  "missing"
];
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}
function isNonNegativeInt(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
function isCommandSessionLike(value) {
  if (!isRecord(value))
    return false;
  if (typeof value["id"] !== "string" || value["id"].length === 0)
    return false;
  if (typeof value["title"] !== "string")
    return false;
  if (typeof value["command"] !== "string")
    return false;
  if (typeof value["cwd"] !== "string")
    return false;
  if (typeof value["ownerSessionID"] !== "string")
    return false;
  if (typeof value["status"] !== "string")
    return false;
  if (!VALID_STATUSES.includes(value["status"]))
    return false;
  if (!isNonNegativeInt(value["outputBytes"]))
    return false;
  if (typeof value["truncated"] !== "boolean")
    return false;
  if (typeof value["createdAt"] !== "string")
    return false;
  if (typeof value["updatedAt"] !== "string")
    return false;
  if (value["args"] !== undefined && !Array.isArray(value["args"]))
    return false;
  if (value["streamBytes"] !== undefined && !isNonNegativeInt(value["streamBytes"]))
    return false;
  return true;
}
function checkOffsets(startOffset, endOffset, data) {
  if (typeof data !== "string")
    return "data must be a string";
  if (!isNonNegativeInt(startOffset))
    return "startOffset must be a non-negative integer";
  if (!isNonNegativeInt(endOffset))
    return "endOffset must be a non-negative integer";
  if (endOffset < startOffset)
    return "endOffset must be >= startOffset";
  const expected = expectedNextEnd(startOffset, data);
  if (endOffset !== expected)
    return `endOffset mismatch: expected ${expected} (startOffset + UTF-8 byte length ${expected - startOffset}), got ${endOffset}`;
  return null;
}
function validateCommandStreamMessage(value) {
  try {
    if (!isRecord(value))
      return { ok: false, error: "message must be an object" };
    const type = value["type"];
    if (typeof type !== "string")
      return { ok: false, error: "missing type field" };
    switch (type) {
      case "subscribe": {
        if (!isNonEmptyString(value["commandID"]))
          return { ok: false, error: "subscribe.commandID must be a non-empty string" };
        if (!isNonEmptyString(value["ownerSessionID"]))
          return { ok: false, error: "subscribe.ownerSessionID must be a non-empty string" };
        return {
          ok: true,
          message: {
            type: "subscribe",
            commandID: value["commandID"],
            ownerSessionID: value["ownerSessionID"]
          }
        };
      }
      case "snapshot": {
        if (!isCommandSessionLike(value["command"]))
          return { ok: false, error: "snapshot.command must be CommandSession metadata" };
        const offsetError = checkOffsets(value["startOffset"], value["endOffset"], value["data"]);
        if (offsetError)
          return { ok: false, error: `snapshot.${offsetError}` };
        return {
          ok: true,
          message: {
            type: "snapshot",
            command: value["command"],
            data: value["data"],
            startOffset: value["startOffset"],
            endOffset: value["endOffset"]
          }
        };
      }
      case "output": {
        if (!isNonEmptyString(value["commandID"]))
          return { ok: false, error: "output.commandID must be a non-empty string" };
        const offsetError = checkOffsets(value["startOffset"], value["endOffset"], value["data"]);
        if (offsetError)
          return { ok: false, error: `output.${offsetError}` };
        return {
          ok: true,
          message: {
            type: "output",
            commandID: value["commandID"],
            data: value["data"],
            startOffset: value["startOffset"],
            endOffset: value["endOffset"]
          }
        };
      }
      case "status": {
        if (!isCommandSessionLike(value["command"]))
          return { ok: false, error: "status.command must be CommandSession metadata" };
        return { ok: true, message: { type: "status", command: value["command"] } };
      }
      case "input": {
        if (!isNonEmptyString(value["commandID"]))
          return { ok: false, error: "input.commandID must be a non-empty string" };
        if (typeof value["data"] !== "string")
          return { ok: false, error: "input.data must be a string" };
        return {
          ok: true,
          message: { type: "input", commandID: value["commandID"], data: value["data"] }
        };
      }
      case "interrupt": {
        if (!isNonEmptyString(value["commandID"]))
          return { ok: false, error: "interrupt.commandID must be a non-empty string" };
        return { ok: true, message: { type: "interrupt", commandID: value["commandID"] } };
      }
      case "resync": {
        if (!isNonEmptyString(value["commandID"]))
          return { ok: false, error: "resync.commandID must be a non-empty string" };
        return { ok: true, message: { type: "resync", commandID: value["commandID"] } };
      }
      case "error": {
        if (!isNonEmptyString(value["code"]))
          return { ok: false, error: "error.code must be a non-empty string" };
        if (typeof value["message"] !== "string")
          return { ok: false, error: "error.message must be a string" };
        return {
          ok: true,
          message: { type: "error", code: value["code"], message: value["message"] }
        };
      }
      default:
        return { ok: false, error: `unknown message type: ${type}` };
    }
  } catch (err) {
    return { ok: false, error: `validation failed: ${String(err)}` };
  }
}

// src/tui/command-stream-client.ts
function defaultEndpointPath(directory) {
  return path2.join(directory, ".opencode", "loopd", "commands", ".stream-endpoint.json");
}
async function defaultReadEndpoint(directory) {
  let text;
  try {
    text = await fs2.readFile(defaultEndpointPath(directory), "utf8");
  } catch {
    return;
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed.url !== "string" || parsed.url.length === 0)
      return;
    return { url: parsed.url };
  } catch {
    return;
  }
}
function defaultCreateSocket(url) {
  const ws = new WebSocket(url);
  const socket = {
    send: (data) => ws.send(data),
    close: (code, reason) => ws.close(code, reason),
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null
  };
  ws.onopen = () => socket.onopen?.();
  ws.onmessage = (ev) => socket.onmessage?.(String(ev.data));
  ws.onclose = (ev) => socket.onclose?.(ev.code, ev.reason);
  ws.onerror = (err) => socket.onerror?.(err);
  return socket;
}
function createCommandStreamClient(options = {}) {
  const readEndpoint = options.readEndpoint ?? defaultReadEndpoint;
  const createSocket = options.createSocket ?? defaultCreateSocket;
  const initialBackoffMs = options.initialBackoffMs ?? 250;
  const maxBackoffMs = options.maxBackoffMs ?? 8000;
  const maxResyncsPerWindow = options.maxResyncsPerWindow ?? 5;
  const resyncWindowMs = options.resyncWindowMs ?? 30000;
  let state = "disconnected";
  let directory = "";
  let endpointURL = "";
  let socket;
  let closedIntentionally = false;
  let reconnectAttempt = 0;
  let reconnectTimer;
  const subs = new Map;
  function emitConnection(next) {
    if (state === next)
      return;
    state = next;
    try {
      options.onConnection?.(next);
    } catch {}
    for (const sub of subs.values()) {
      try {
        sub.handlers.onConnection?.(next);
      } catch {}
    }
  }
  function sendWire(msg) {
    if (!socket || state !== "connected")
      return false;
    try {
      socket.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }
  function sendSubscribe(sub) {
    return sendWire({ type: "subscribe", commandID: sub.commandID, ownerSessionID: sub.ownerSessionID });
  }
  function pruneResyncTimes(sub, now) {
    sub.resyncTimes = sub.resyncTimes.filter((t) => now - t < resyncWindowMs);
  }
  function requestResync(sub, reason) {
    if (sub.resyncPending)
      return;
    const now = Date.now();
    pruneResyncTimes(sub, now);
    if (sub.resyncTimes.length >= maxResyncsPerWindow) {
      try {
        sub.handlers.onError?.(`resync-loop-guard: giving up after ${sub.resyncTimes.length} resyncs (${reason})`);
      } catch {}
      return;
    }
    sub.resyncTimes.push(now);
    sub.resyncPending = true;
    if (!sendSubscribe(sub)) {
      return;
    }
  }
  function handleMessage(raw) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    let validated;
    try {
      validated = validateCommandStreamMessage(parsed);
    } catch {
      return;
    }
    if (!validated.ok)
      return;
    const msg = validated.message;
    switch (msg.type) {
      case "snapshot": {
        const id = msg.command.id;
        const sub = subs.get(id);
        if (!sub)
          return;
        sub.startOffset = msg.startOffset;
        sub.endOffset = msg.endOffset;
        sub.resyncPending = false;
        try {
          sub.handlers.onSnapshot?.({
            command: msg.command,
            data: msg.data,
            startOffset: msg.startOffset,
            endOffset: msg.endOffset
          });
        } catch {}
        break;
      }
      case "output": {
        const sub = subs.get(msg.commandID);
        if (!sub)
          return;
        if (sub.endOffset === undefined) {
          requestResync(sub, "no-baseline");
          return;
        }
        if (offsetsContinuous(sub.endOffset, msg.startOffset)) {
          sub.endOffset = msg.endOffset;
          try {
            sub.handlers.onDelta?.({
              commandID: msg.commandID,
              data: msg.data,
              startOffset: msg.startOffset,
              endOffset: msg.endOffset
            });
          } catch {}
        } else {
          requestResync(sub, msg.startOffset > sub.endOffset ? "gap" : "overlap");
        }
        break;
      }
      case "status": {
        const id = msg.command.id;
        const sub = subs.get(id);
        if (!sub)
          return;
        try {
          sub.handlers.onStatus?.(msg.command);
        } catch {}
        break;
      }
      case "error": {
        const text = `${msg.code}: ${msg.message}`;
        for (const sub of subs.values()) {
          try {
            sub.handlers.onError?.(text);
          } catch {}
        }
        break;
      }
      default:
        break;
    }
  }
  function openSocket() {
    if (!endpointURL)
      return false;
    closedIntentionally = false;
    emitConnection("connecting");
    let next;
    try {
      next = createSocket(endpointURL);
    } catch {
      scheduleReconnect();
      return false;
    }
    socket = next;
    socket.onopen = () => {
      reconnectAttempt = 0;
      emitConnection("connected");
      for (const sub of subs.values()) {
        sub.resyncPending = false;
        sendSubscribe(sub);
      }
    };
    socket.onmessage = (data) => handleMessage(data);
    socket.onclose = () => {
      socket = undefined;
      if (closedIntentionally) {
        emitConnection("disconnected");
        return;
      }
      emitConnection("disconnected");
      scheduleReconnect();
    };
    socket.onerror = () => {};
    return true;
  }
  function scheduleReconnect() {
    if (closedIntentionally)
      return;
    if (reconnectTimer)
      return;
    const delay = Math.min(initialBackoffMs * 2 ** reconnectAttempt, maxBackoffMs);
    reconnectAttempt += 1;
    emitConnection("connecting");
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      if (closedIntentionally || !endpointURL || !directory)
        return;
      openSocket();
    }, delay);
    const t = reconnectTimer;
    try {
      t.unref?.();
    } catch {}
  }
  return {
    get connectionState() {
      return state;
    },
    async connect(nextDirectory) {
      directory = nextDirectory;
      let endpoint;
      try {
        endpoint = await readEndpoint(nextDirectory);
      } catch {
        return { ok: false, reason: "no-endpoint" };
      }
      if (!endpoint || typeof endpoint.url !== "string" || endpoint.url.length === 0) {
        return { ok: false, reason: "no-endpoint" };
      }
      if (endpointURL === endpoint.url && socket && (state === "connected" || state === "connecting")) {
        return { ok: true };
      }
      try {
        socket?.close(1000, "reconnect");
      } catch {}
      socket = undefined;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      reconnectAttempt = 0;
      endpointURL = endpoint.url;
      const opened = openSocket();
      if (!opened)
        return { ok: false, reason: "connect-failed" };
      return { ok: true };
    },
    subscribe(commandID, ownerSessionID, handlers = {}) {
      if (!commandID || !ownerSessionID)
        return { ok: false, reason: "owner-required" };
      let sub = subs.get(commandID);
      if (!sub) {
        sub = {
          commandID,
          ownerSessionID,
          handlers,
          endOffset: undefined,
          startOffset: undefined,
          resyncPending: false,
          resyncTimes: []
        };
        subs.set(commandID, sub);
      } else {
        sub.ownerSessionID = ownerSessionID;
        sub.handlers = handlers;
        sub.endOffset = undefined;
        sub.startOffset = undefined;
        sub.resyncPending = false;
      }
      if (!socket || state !== "connected") {
        return { ok: true };
      }
      return sendSubscribe(sub) ? { ok: true } : { ok: false, reason: "send-failed" };
    },
    unsubscribe(commandID) {
      subs.delete(commandID);
    },
    sendInput(commandID, data) {
      if (!socket || state !== "connected" || !subs.has(commandID)) {
        return { ok: false, reason: "not-subscribed" };
      }
      return sendWire({ type: "input", commandID, data }) ? { ok: true } : { ok: false, reason: "send-failed" };
    },
    sendInterrupt(commandID) {
      if (!socket || state !== "connected" || !subs.has(commandID)) {
        return { ok: false, reason: "not-subscribed" };
      }
      return sendWire({ type: "interrupt", commandID }) ? { ok: true } : { ok: false, reason: "send-failed" };
    },
    isLive(commandID) {
      return state === "connected" && subs.has(commandID);
    },
    disconnect() {
      closedIntentionally = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      try {
        socket?.close(1000, "client disconnect");
      } catch {}
      socket = undefined;
      emitConnection("disconnected");
    },
    dispose() {
      subs.clear();
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      closedIntentionally = true;
      try {
        socket?.close(1000, "client dispose");
      } catch {}
      socket = undefined;
      if (state !== "disconnected")
        emitConnection("disconnected");
    }
  };
}

// src/tui/command-panel.tsx
function prevent2(evt) {
  const e = evt;
  e.preventDefault?.();
  e.stopPropagation?.();
}
function routeOwnerSessionID(api) {
  try {
    const current = api.route?.current;
    if (current?.name === "session" && current.params?.sessionID)
      return current.params.sessionID;
  } catch {}
  return;
}
function CommandPanel(props) {
  const theme = () => props.api.theme.current;
  const [state, setState] = createSignal2(emptyCommandPanelState());
  const [output, setOutput] = createSignal2("");
  const [outputMeta, setOutputMeta] = createSignal2({
    startByte: 0,
    totalBytes: 0,
    live: false
  });
  const [insertMode, setInsertMode] = createSignal2(false);
  const [inputValue, setInputValue] = createSignal2("");
  const [statusText, setStatusText] = createSignal2("commands: j/k move \xB7 enter write-mode \xB7 ctrl-c interrupt \xB7 :terminate :remove :resize \xB7 q detach");
  let inputEl;
  const client = createControlClient(props.directory);
  const ownerSessionID = props.ownerSessionID ?? routeOwnerSessionID(props.api);
  const stream = createCommandStreamClient();
  let subscribedID;
  let streamConnected = false;
  let lastSlowListRefresh = 0;
  const SLOW_LIST_REFRESH_MS = 30000;
  function streamLiveForSelected() {
    const id = state().selectedCommand?.id;
    return streamConnected && !!id && stream.isLive(id);
  }
  function applyCommandMetadata(cmd) {
    setState((prev) => {
      const idx = prev.commands.findIndex((c) => c.id === cmd.id);
      if (idx < 0)
        return prev;
      const next = [...prev.commands];
      next[idx] = cmd;
      return {
        ...prev,
        commands: next,
        selectedCommand: next[prev.selected] ?? null
      };
    });
  }
  function syncStreamSubscription() {
    const sel = state().selectedCommand;
    if (!ownerSessionID || !sel) {
      if (subscribedID) {
        stream.unsubscribe(subscribedID);
        subscribedID = undefined;
      }
      return;
    }
    if (subscribedID === sel.id && stream.isLive(sel.id))
      return;
    if (subscribedID && subscribedID !== sel.id)
      stream.unsubscribe(subscribedID);
    subscribedID = sel.id;
    stream.subscribe(sel.id, ownerSessionID, {
      onSnapshot: (snap) => {
        if (subscribedID !== sel.id)
          return;
        setOutput(snap.data);
        setOutputMeta({
          startByte: snap.startOffset,
          totalBytes: snap.endOffset,
          live: snap.command.status === "running"
        });
        applyCommandMetadata(snap.command);
      },
      onDelta: (delta) => {
        if (subscribedID !== sel.id)
          return;
        setOutput((prev) => prev + delta.data);
        setOutputMeta((prev) => ({
          ...prev,
          totalBytes: delta.endOffset
        }));
      },
      onStatus: (cmd) => {
        applyCommandMetadata(cmd);
      },
      onError: (message) => {
        setStatusText(message);
      },
      onConnection: (s) => {
        streamConnected = s === "connected";
        if (streamConnected)
          syncStreamSubscription();
      }
    });
    streamConnected = stream.connectionState === "connected";
  }
  async function tryStreamConnect() {
    if (!ownerSessionID)
      return;
    try {
      const r = await stream.connect(props.directory);
      streamConnected = stream.connectionState === "connected";
      if (r.ok)
        syncStreamSubscription();
    } catch {}
  }
  async function refresh() {
    try {
      if (streamLiveForSelected()) {
        const now = Date.now();
        if (now - lastSlowListRefresh < SLOW_LIST_REFRESH_MS)
          return;
        lastSlowListRefresh = now;
        const s = await readState(props.directory);
        const mine = (s.commands ?? []).filter((c) => ownerSessionID ? c.ownerSessionID === ownerSessionID : false);
        setState((prev) => refreshCommandList(prev, mine));
        syncStreamSubscription();
        return;
      }
      const s = await readState(props.directory);
      const mine = (s.commands ?? []).filter((c) => ownerSessionID ? c.ownerSessionID === ownerSessionID : false);
      setState((prev) => refreshCommandList(prev, mine));
      syncStreamSubscription();
      if (!streamConnected)
        tryStreamConnect();
      await refreshOutput();
    } catch (e) {
      setStatusText(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  async function refreshOutput() {
    if (streamLiveForSelected())
      return;
    const sel = state().selectedCommand;
    if (!sel) {
      setOutput("");
      return;
    }
    try {
      const total = sel.outputBytes;
      const window = 32 * 1024;
      const startByte = Math.max(0, total - window);
      const log = await readCommandLog(props.directory, sel.id, {
        offsetBytes: startByte,
        limitBytes: window
      });
      setOutput(log.text);
      setOutputMeta({
        startByte: log.startByte,
        totalBytes: total,
        live: sel.status === "running"
      });
    } catch {
      setOutput("");
    }
  }
  async function sendRaw(command, args, commandID) {
    if (!ownerSessionID) {
      setStatusText("No owning session (open from a session view) \u2014 mutations disabled.");
      return;
    }
    setStatusText(`sending ${command}\u2026`);
    try {
      const r = await client.executeRaw({
        command,
        goalID: commandID,
        args: {
          ...args,
          ownerSessionID
        }
      });
      setStatusText(r.ok ? r.message : `Error: ${r.message}`);
      if (r.ok)
        await refresh();
    } catch (e) {
      setStatusText(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  function selectedID() {
    return state().selectedCommand?.id;
  }
  async function openCmd() {
    await refreshOutput();
    setStatusText("open-cmd: output snapshot refreshed (live while running).");
  }
  async function writeInput(text) {
    const id = selectedID();
    if (!id) {
      setStatusText("No command selected.");
      return;
    }
    const payload = text.endsWith(`
`) ? text : `${text}
`;
    if (streamLiveForSelected() && stream.sendInput(id, payload).ok)
      return;
    await sendRaw("cmd_write", {
      commandID: id,
      input: payload
    }, id);
  }
  async function interrupt() {
    const id = selectedID();
    if (!id) {
      setStatusText("No command selected.");
      return;
    }
    if (streamLiveForSelected() && stream.sendInterrupt(id).ok)
      return;
    await sendRaw("cmd_interrupt", {
      commandID: id
    }, id);
  }
  async function terminate() {
    const id = selectedID();
    if (!id) {
      setStatusText("No command selected.");
      return;
    }
    await sendRaw("cmd_terminate", {
      commandID: id
    }, id);
  }
  async function remove() {
    const id = selectedID();
    if (!id) {
      setStatusText("No command selected.");
      return;
    }
    await sendRaw("cmd_remove", {
      commandID: id
    }, id);
  }
  async function resize(cols, rows) {
    const id = selectedID();
    if (!id) {
      setStatusText("No command selected.");
      return;
    }
    await sendRaw("cmd_resize", {
      commandID: id,
      cols,
      rows
    }, id);
  }
  async function startNew(raw) {
    const parts = parseCommandLine(raw);
    if (!parts) {
      setStatusText("Invalid command line: close quotes and trailing escapes.");
      return;
    }
    if (parts.length === 0) {
      setStatusText("Usage: :new <command> [args...]");
      return;
    }
    const [command, ...cmdArgs] = parts;
    if (!ownerSessionID) {
      setStatusText("No owning session (open from a session view) \u2014 mutations disabled.");
      return;
    }
    setStatusText(`sending cmd_start\u2026`);
    try {
      const r = await client.executeRaw({
        command: "cmd_start",
        args: {
          title: command,
          command,
          cmdArgs,
          ownerSessionID
        }
      });
      setStatusText(r.ok ? r.message : `Error: ${r.message}`);
      if (r.ok)
        await refresh();
    } catch (e) {
      setStatusText(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  async function executeColonCommand(raw) {
    const text = raw.startsWith(":") ? raw.slice(1) : raw;
    const [verb, ...rest] = text.trim().split(/\s+/);
    switch (verb) {
      case "new":
        await startNew(rest.join(" "));
        break;
      case "terminate":
        await terminate();
        break;
      case "remove":
        await remove();
        break;
      case "interrupt":
        await interrupt();
        break;
      case "resize": {
        const cols = Number(rest[0]);
        const rows = Number(rest[1]);
        if (!Number.isInteger(cols) || !Number.isInteger(rows)) {
          setStatusText("Usage: :resize <cols> <rows> (stored only \u2014 unsupported by pipe host)");
          break;
        }
        await resize(cols, rows);
        break;
      }
      case "open-cmd":
        await openCmd();
        break;
      default:
        setStatusText(`Unknown :${verb}. Try :new, :terminate, :remove, :interrupt, :resize, :open-cmd`);
    }
  }
  function focusInput() {
    setTimeout(() => {
      const current = props.api.renderer.currentFocusedRenderable;
      if (current && current !== inputEl)
        current.blur();
      inputEl?.focus();
    }, 10);
  }
  onMount2(() => {
    refresh();
    tryStreamConnect();
    focusInput();
  });
  const pollers = [setInterval(refresh, 2000), setInterval(refreshOutput, 2000)];
  const unsubs = [props.api.event.on("session.idle", () => refresh()), props.api.event.on("session.status", () => refresh())];
  onCleanup2(() => {
    for (const u of unsubs)
      if (typeof u === "function")
        u();
    for (const p of pollers)
      clearInterval(p);
    if (subscribedID)
      stream.unsubscribe(subscribedID);
    subscribedID = undefined;
    stream.dispose();
  });
  useKeyboard2((evt) => {
    const name = (evt.name || "").toLowerCase();
    const seq = evt.sequence || "";
    const raw = evt.raw || "";
    const key = raw || seq || name;
    const ctrlC = Boolean(evt.ctrl) && name === "c";
    if (insertMode()) {
      if (isEnterKey(evt)) {
        prevent2(evt);
        const v = inputValue();
        if (v.startsWith(":"))
          executeColonCommand(v);
        else
          writeInput(v);
        setInputValue("");
        if (inputEl)
          inputEl.value = "";
        setInsertMode(false);
        return;
      }
      if (isEscapeKey(evt)) {
        prevent2(evt);
        setInsertMode(false);
        setInputValue("");
        if (inputEl)
          inputEl.value = "";
        return;
      }
      return;
    }
    if (ctrlC) {
      prevent2(evt);
      interrupt();
      return;
    }
    if (key === ":") {
      prevent2(evt);
      setInsertMode(true);
      focusInput();
      return;
    }
    if (name === "down" || key === "j") {
      prevent2(evt);
      setState((s) => moveCommandSelection(s, 1));
      syncStreamSubscription();
      refreshOutput();
      return;
    }
    if (name === "up" || key === "k") {
      prevent2(evt);
      setState((s) => moveCommandSelection(s, -1));
      syncStreamSubscription();
      refreshOutput();
      return;
    }
    if (key === "g") {
      prevent2(evt);
      setState(selectCommandFirst);
      syncStreamSubscription();
      refreshOutput();
      return;
    }
    if (key === "G") {
      prevent2(evt);
      setState(selectCommandLast);
      syncStreamSubscription();
      refreshOutput();
      return;
    }
    if (key === "q") {
      prevent2(evt);
      if (props.onDetach)
        props.onDetach();
      else
        props.api.ui.dialog.clear();
      return;
    }
  });
  const sel = () => state().selectedCommand;
  return (() => {
    var _el$ = _$createElement2("box"), _el$2 = _$createElement2("box"), _el$3 = _$createElement2("box"), _el$4 = _$createElement2("text"), _el$5 = _$createElement2("span"), _el$7 = _$createElement2("span"), _el$9 = _$createElement2("text"), _el$0 = _$createElement2("span"), _el$1 = _$createTextNode2(` owned`), _el$11 = _$createElement2("box"), _el$12 = _$createElement2("text"), _el$13 = _$createElement2("span"), _el$14 = _$createElement2("input");
    _$insertNode2(_el$, _el$2);
    _$setProp2(_el$, "flexDirection", "column");
    _$setProp2(_el$, "width", "100%");
    _$setProp2(_el$, "alignItems", "center");
    _$setProp2(_el$, "padding", 1);
    _$insertNode2(_el$2, _el$3);
    _$insertNode2(_el$2, _el$11);
    _$setProp2(_el$2, "flexDirection", "column");
    _$setProp2(_el$2, "width", "90%");
    _$setProp2(_el$2, "border", true);
    _$setProp2(_el$2, "padding", 1);
    _$insertNode2(_el$3, _el$4);
    _$insertNode2(_el$3, _el$9);
    _$setProp2(_el$3, "flexDirection", "row");
    _$setProp2(_el$3, "justifyContent", "space-between");
    _$setProp2(_el$3, "flexShrink", 0);
    _$insertNode2(_el$4, _el$5);
    _$insertNode2(_el$4, _el$7);
    _$insertNode2(_el$5, _$createTextNode2(`\u2B22 Command Sessions`));
    _$insertNode2(_el$7, _$createTextNode2(` \u2502 byte-stream output (not a terminal emulator)`));
    _$insertNode2(_el$9, _el$0);
    _$insertNode2(_el$0, _el$1);
    _$insert2(_el$0, () => state().commands.length, _el$1);
    _$insert2(_el$2, _$createComponent2(Show2, {
      get when() {
        return state().commands.length > 0;
      },
      get fallback() {
        return (() => {
          var _el$15 = _$createElement2("box"), _el$16 = _$createElement2("text"), _el$17 = _$createElement2("span");
          _$insertNode2(_el$15, _el$16);
          _$setProp2(_el$15, "padding", 1);
          _$insertNode2(_el$16, _el$17);
          _$insert2(_el$17, ownerSessionID ? "No command sessions. :new <command> [args...] to start one." : "Open this panel from a session view \u2014 owner scoping needs a session.");
          _$effect2((_$p) => _$setProp2(_el$17, "style", {
            fg: theme().textMuted
          }, _$p));
          return _el$15;
        })();
      },
      get children() {
        var _el$10 = _$createElement2("box");
        _$setProp2(_el$10, "flexDirection", "column");
        _$setProp2(_el$10, "flexShrink", 1);
        _$setProp2(_el$10, "minHeight", 0);
        _$setProp2(_el$10, "overflow", "hidden");
        _$insert2(_el$10, _$createComponent2(For2, {
          get each() {
            return state().commands;
          },
          children: (cmd, i) => (() => {
            var _el$18 = _$createElement2("box"), _el$19 = _$createElement2("text"), _el$20 = _$createElement2("span"), _el$21 = _$createElement2("span"), _el$22 = _$createTextNode2(` \u2502 `), _el$23 = _$createTextNode2(` \u2502 `);
            _$insertNode2(_el$18, _el$19);
            _$setProp2(_el$18, "paddingLeft", 1);
            _$setProp2(_el$18, "paddingRight", 1);
            _$insertNode2(_el$19, _el$20);
            _$insertNode2(_el$19, _el$21);
            _$setProp2(_el$19, "wrapMode", "none");
            _$setProp2(_el$19, "truncate", true);
            _$insert2(_el$20, () => i() === state().selected ? "\u25B6 " : "  ", null);
            _$insert2(_el$20, () => cmd.title, null);
            _$insertNode2(_el$21, _el$22);
            _$insertNode2(_el$21, _el$23);
            _$insert2(_el$21, () => [cmd.command, ...cmd.args].join(" ").slice(0, 60), _el$23);
            _$insert2(_el$21, () => cmd.status, null);
            _$insert2(_el$21, (() => {
              var _c$ = _$memo2(() => cmd.exitCode !== undefined);
              return () => _c$() ? ` (${cmd.exitCode})` : "";
            })(), null);
            _$effect2((_p$) => {
              var _v$10 = i() === state().selected ? theme().backgroundElement : undefined, _v$11 = {
                fg: cmd.status === "running" ? theme().success : theme().textMuted,
                bold: i() === state().selected
              }, _v$12 = {
                fg: theme().textMuted
              };
              _v$10 !== _p$.e && (_p$.e = _$setProp2(_el$18, "backgroundColor", _v$10, _p$.e));
              _v$11 !== _p$.t && (_p$.t = _$setProp2(_el$20, "style", _v$11, _p$.t));
              _v$12 !== _p$.a && (_p$.a = _$setProp2(_el$21, "style", _v$12, _p$.a));
              return _p$;
            }, {
              e: undefined,
              t: undefined,
              a: undefined
            });
            return _el$18;
          })()
        }));
        return _el$10;
      }
    }), _el$11);
    _$insert2(_el$2, _$createComponent2(Show2, {
      get when() {
        return sel();
      },
      children: (cmd) => (() => {
        var _el$24 = _$createElement2("box"), _el$25 = _$createElement2("text"), _el$26 = _$createElement2("span"), _el$27 = _$createElement2("span"), _el$28 = _$createTextNode2(` \u2502 `), _el$29 = _$createTextNode2(` \u2502 `), _el$30 = _$createTextNode2(` \u2502 `), _el$31 = _$createTextNode2(` bytes`), _el$32 = _$createTextNode2(`
`), _el$33 = _$createElement2("span");
        _$insertNode2(_el$24, _el$25);
        _$setProp2(_el$24, "flexDirection", "column");
        _$setProp2(_el$24, "border", true);
        _$setProp2(_el$24, "padding", 1);
        _$setProp2(_el$24, "flexShrink", 0);
        _$setProp2(_el$24, "maxHeight", 16);
        _$setProp2(_el$24, "overflow", "hidden");
        _$insertNode2(_el$25, _el$26);
        _$insertNode2(_el$25, _el$27);
        _$insertNode2(_el$25, _el$32);
        _$insertNode2(_el$25, _el$33);
        _$insert2(_el$26, () => cmd().title);
        _$insertNode2(_el$27, _el$28);
        _$insertNode2(_el$27, _el$29);
        _$insertNode2(_el$27, _el$30);
        _$insertNode2(_el$27, _el$31);
        _$insert2(_el$27, () => [cmd().command, ...cmd().args].join(" "), _el$29);
        _$insert2(_el$27, () => cmd().status, _el$30);
        _$insert2(_el$27, () => outputMeta().totalBytes, _el$31);
        _$insert2(_el$27, () => outputMeta().live ? " \xB7 live" : "", null);
        _$insert2(_el$27, () => cmd().truncated ? " \xB7 truncated" : "", null);
        _$insert2(_el$33, () => output().slice(-4000) || "(no output yet)");
        _$effect2((_p$) => {
          var _v$13 = theme().border, _v$14 = {
            fg: theme().primary,
            bold: true
          }, _v$15 = {
            fg: theme().textMuted
          }, _v$16 = {
            fg: theme().text
          };
          _v$13 !== _p$.e && (_p$.e = _$setProp2(_el$24, "borderColor", _v$13, _p$.e));
          _v$14 !== _p$.t && (_p$.t = _$setProp2(_el$26, "style", _v$14, _p$.t));
          _v$15 !== _p$.a && (_p$.a = _$setProp2(_el$27, "style", _v$15, _p$.a));
          _v$16 !== _p$.o && (_p$.o = _$setProp2(_el$33, "style", _v$16, _p$.o));
          return _p$;
        }, {
          e: undefined,
          t: undefined,
          a: undefined,
          o: undefined
        });
        return _el$24;
      })()
    }), _el$11);
    _$insertNode2(_el$11, _el$12);
    _$insertNode2(_el$11, _el$14);
    _$setProp2(_el$11, "flexDirection", "row");
    _$setProp2(_el$11, "border", true);
    _$setProp2(_el$11, "paddingLeft", 1);
    _$setProp2(_el$11, "paddingRight", 1);
    _$setProp2(_el$11, "flexShrink", 0);
    _$setProp2(_el$11, "height", 3);
    _$setProp2(_el$11, "gap", 1);
    _$insertNode2(_el$12, _el$13);
    _$insert2(_el$13, () => insertMode() ? " INPUT " : " NORMAL ");
    _$use2((el) => {
      inputEl = el;
    }, _el$14);
    _$setProp2(_el$14, "flexGrow", 1);
    _$setProp2(_el$14, "onInput", (v) => {
      if (insertMode())
        setInputValue(v);
      else if (inputEl?.value)
        inputEl.value = "";
    });
    _$effect2((_p$) => {
      var _v$ = theme().border, _v$2 = {
        fg: theme().primary,
        bold: true
      }, _v$3 = {
        fg: theme().textMuted
      }, _v$4 = {
        fg: theme().textMuted
      }, _v$5 = insertMode() ? theme().warning : theme().border, _v$6 = {
        fg: insertMode() ? theme().warning : theme().success,
        bold: true
      }, _v$7 = insertMode() ? "type stdin, Enter sends (:new/:terminate/:remove/:interrupt/:resize/:open-cmd)" : statusText() || "Press : to type, q to detach", _v$8 = theme().textMuted, _v$9 = theme().primary, _v$0 = theme().text, _v$1 = theme().background;
      _v$ !== _p$.e && (_p$.e = _$setProp2(_el$2, "borderColor", _v$, _p$.e));
      _v$2 !== _p$.t && (_p$.t = _$setProp2(_el$5, "style", _v$2, _p$.t));
      _v$3 !== _p$.a && (_p$.a = _$setProp2(_el$7, "style", _v$3, _p$.a));
      _v$4 !== _p$.o && (_p$.o = _$setProp2(_el$0, "style", _v$4, _p$.o));
      _v$5 !== _p$.i && (_p$.i = _$setProp2(_el$11, "borderColor", _v$5, _p$.i));
      _v$6 !== _p$.n && (_p$.n = _$setProp2(_el$13, "style", _v$6, _p$.n));
      _v$7 !== _p$.s && (_p$.s = _$setProp2(_el$14, "placeholder", _v$7, _p$.s));
      _v$8 !== _p$.h && (_p$.h = _$setProp2(_el$14, "placeholderColor", _v$8, _p$.h));
      _v$9 !== _p$.r && (_p$.r = _$setProp2(_el$14, "cursorColor", _v$9, _p$.r));
      _v$0 !== _p$.d && (_p$.d = _$setProp2(_el$14, "focusedTextColor", _v$0, _p$.d));
      _v$1 !== _p$.l && (_p$.l = _$setProp2(_el$14, "focusedBackgroundColor", _v$1, _p$.l));
      return _p$;
    }, {
      e: undefined,
      t: undefined,
      a: undefined,
      o: undefined,
      i: undefined,
      n: undefined,
      s: undefined,
      h: undefined,
      r: undefined,
      d: undefined,
      l: undefined
    });
    return _el$;
  })();
}

// src/tui/plugin.tsx
var PLUGIN_ID = "opencode-loopd.tui";
var tui = async (api) => {
  const directory = api.state.path.directory;
  const open = () => {
    const previousFocus = api.renderer.currentFocusedRenderable;
    api.ui.dialog.replace(() => _$createComponent3(LoopDashboard, {
      api,
      directory
    }));
    api.ui.dialog.setSize("xlarge");
    previousFocus?.blur();
  };
  const openCommands = () => {
    const previousFocus = api.renderer.currentFocusedRenderable;
    api.ui.dialog.replace(() => _$createComponent3(CommandPanel, {
      api,
      directory
    }));
    api.ui.dialog.setSize("xlarge");
    previousFocus?.blur();
  };
  api.keymap.registerLayer({
    commands: [{
      name: "opencode.loopd.dashboard",
      title: "Loop Dashboard",
      category: "Loop",
      namespace: "palette",
      slashName: "loop",
      run: open
    }, {
      name: "opencode.loopd.commands",
      title: "Command Sessions",
      category: "Loop",
      namespace: "palette",
      slashName: "commands",
      run: openCommands
    }],
    bindings: [{
      key: "<leader>o",
      cmd: "opencode.loopd.dashboard",
      desc: "Open loop dashboard"
    }]
  });
  api.lifecycle.onDispose(() => {});
};
function adaptThemeV2(theme) {
  const t = theme ?? {};
  const text = t.text ?? {};
  const fb = text.feedback ?? {};
  const bg = t.background ?? {};
  const raised = bg.raised ?? bg.surface ?? {};
  const diff = t.diff ?? {};
  const diffText = diff.text ?? {};
  const diffBg = diff.background ?? {};
  const diffHi = diff.highlight ?? {};
  const diffLn = diff.lineNumber ?? {};
  const syntax = t.syntax ?? {};
  const md = t.markdown ?? {};
  const pick = (...values) => values.find((value) => value !== undefined && value !== null);
  const base = pick(text.base, text.default, "#ffffff");
  const muted = pick(text.muted, text.subdued, "#888888");
  const primary = pick(t.hue?.interactive?.[200], text.formfield?.focused, text.action?.primary?.selected, base);
  const accent = pick(t.hue?.accent?.[200], text.action?.primary?.focused, primary);
  const background = pick(bg.base, bg.default, "#000000");
  return {
    text: base,
    textMuted: muted,
    primary,
    secondary: pick(t.hue?.accent?.[300], accent),
    accent,
    success: pick(fb.success?.base, fb.success?.default, "#22c55e"),
    warning: pick(fb.warning?.base, fb.warning?.default, "#eab308"),
    error: pick(fb.error?.base, fb.error?.default, "#ef4444"),
    info: pick(fb.info?.base, fb.info?.default, accent),
    selectedListItemText: pick(text.action?.primary?.focused, base),
    background,
    backgroundPanel: pick(raised.base, raised.overlay, background),
    backgroundElement: pick(raised.high, raised.offset, background),
    backgroundMenu: pick(raised.max, raised.high, background),
    border: pick(t.border?.base, muted),
    borderActive: pick(t.scrollbar?.base, primary),
    borderSubtle: pick(t.border?.base, muted),
    diffAdded: pick(diffText.added, base),
    diffRemoved: pick(diffText.removed, base),
    diffContext: pick(diffText.context, muted),
    diffHunkHeader: pick(diffText.hunkHeader, accent),
    diffAddedBg: pick(diffBg.added, background),
    diffRemovedBg: pick(diffBg.removed, background),
    diffContextBg: pick(diffBg.context, background),
    diffHighlightAdded: pick(diffHi.added, base),
    diffHighlightRemoved: pick(diffHi.removed, base),
    diffLineNumber: pick(diffLn.text, muted),
    diffAddedLineNumberBg: pick(diffLn.background?.added, background),
    diffRemovedLineNumberBg: pick(diffLn.background?.removed, background),
    syntaxComment: pick(syntax.comment, muted),
    syntaxKeyword: pick(syntax.keyword, base),
    syntaxFunction: pick(syntax.function, base),
    syntaxVariable: pick(syntax.variable, base),
    syntaxString: pick(syntax.string, base),
    syntaxNumber: pick(syntax.number, base),
    syntaxType: pick(syntax.type, base),
    syntaxOperator: pick(syntax.operator, base),
    syntaxPunctuation: pick(syntax.punctuation, muted),
    markdownText: pick(md.text, base),
    markdownHeading: pick(md.heading, primary),
    markdownLink: pick(md.link, accent),
    markdownLinkText: pick(md.linkText, accent),
    markdownCode: pick(md.code, base),
    markdownBlockQuote: pick(md.blockQuote, muted),
    markdownEmph: pick(md.emphasis, base),
    markdownStrong: pick(md.strong, base),
    markdownHorizontalRule: pick(md.horizontalRule, muted),
    markdownListItem: pick(md.listItem, accent),
    markdownListEnumeration: pick(md.listEnumeration, accent),
    markdownImage: pick(md.image, accent),
    markdownImageText: pick(md.imageText, base),
    markdownCodeBlock: pick(md.codeBlock, base),
    thinkingOpacity: 0.6,
    _hasSelectedListItemText: true
  };
}
var v2setup = (ctx) => {
  const directory = ctx.location?.directory ?? ctx.data.location.default().directory;
  let dialogOpen = false;
  const closeDialog = () => {
    dialogOpen = false;
    ctx.ui.dialog.clear();
  };
  const facade = {
    theme: {
      get current() {
        return adaptThemeV2(ctx.theme);
      }
    },
    mode: {
      push: (name) => ctx.keymap.mode.push(name)
    },
    renderer: ctx.renderer,
    client: ctx.client,
    event: {
      on: (name, callback) => {
        if (name === "session.idle")
          return ctx.data.on("session.idle", callback);
        if (name === "session.status") {
          const unsubs = [ctx.data.on("session.execution.started", callback), ctx.data.on("session.execution.succeeded", callback)];
          return () => void unsubs.forEach((un) => un());
        }
        if (name === "session.error")
          return ctx.data.on("session.execution.failed", callback);
        if (name === "session.compacted")
          return ctx.data.on("session.compaction.ended", callback);
        return ctx.data.on(name, callback);
      }
    },
    ui: {
      dialog: {
        clear: closeDialog,
        get open() {
          return dialogOpen;
        },
        replace: (render) => {
          dialogOpen = true;
          ctx.ui.dialog.show(render);
        },
        setSize: (_size) => ctx.ui.dialog.set({
          size: "xlarge"
        })
      }
    },
    route: {
      get current() {
        const current = ctx.ui.router.current();
        return current.type === "session" ? {
          name: "session",
          params: {
            sessionID: current.sessionID
          }
        } : {
          name: current.type,
          params: {}
        };
      },
      navigate: (name, params) => {
        if (name === "session")
          ctx.ui.router.navigate({
            type: "session",
            sessionID: params?.sessionID
          });
      }
    }
  };
  const open = () => {
    const previousFocus = ctx.renderer.currentFocusedRenderable;
    dialogOpen = true;
    ctx.ui.dialog.show(() => _$createComponent3(LoopDashboard, {
      api: facade,
      directory
    }), () => {
      dialogOpen = false;
    });
    ctx.ui.dialog.set({
      size: "xlarge"
    });
    previousFocus?.blur();
  };
  const openCommands = () => {
    const previousFocus = ctx.renderer.currentFocusedRenderable;
    dialogOpen = true;
    ctx.ui.dialog.show(() => _$createComponent3(CommandPanel, {
      api: facade,
      directory
    }), () => {
      dialogOpen = false;
    });
    ctx.ui.dialog.set({
      size: "xlarge"
    });
    previousFocus?.blur();
  };
  const command = "opencode.loopd.dashboard";
  const commandsCommand = "opencode.loopd.commands";
  const commandsPanel = "opencode.loopd.commands";
  const unclaimCommandPanel = ctx.ui.slot({
    append: "session.panel",
    render: (input) => input.name === commandsPanel ? _$createComponent3(CommandPanel, {
      api: facade,
      directory,
      get ownerSessionID() {
        return input.sessionID;
      },
      get onDetach() {
        return input.close;
      }
    }) : null
  });
  let layerRegistered = false;
  const unclaimSlot = ctx.ui.slot({
    append: "app",
    render: () => {
      if (!layerRegistered) {
        layerRegistered = true;
        ctx.keymap.layer(() => ({
          commands: [{
            id: command,
            title: "Loop Dashboard",
            group: "Loop",
            palette: true,
            slash: {
              name: "loop"
            },
            bind: "<leader>o",
            run: open
          }, {
            id: commandsCommand,
            title: "Command Sessions",
            group: "Loop",
            palette: true,
            slash: {
              name: "commands"
            },
            run: () => {
              if (!ctx.ui.panel.open(commandsPanel, {
                presentation: "fullscreen"
              }))
                openCommands();
            }
          }],
          bindings: [command]
        }));
      }
      return null;
    }
  });
  return () => {
    closeDialog();
    ctx.ui.panel.close();
    unclaimCommandPanel();
    unclaimSlot();
  };
};
var plugin_default = {
  id: PLUGIN_ID,
  tui,
  setup: v2setup
};
export {
  adaptThemeV2,
  plugin_default as default
};

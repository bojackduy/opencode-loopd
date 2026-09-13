// @bun
var __require = import.meta.require;

// src/tui/plugin.tsx
import { createComponent as _$createComponent2 } from "@opentui/solid";

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

// src/infrastructure/state-repository.ts
import { promises as fs } from "fs";
import path from "path";
var CURRENT_VERSION = 6;
function emptyState() {
  return { version: CURRENT_VERSION, revision: 0, goals: [], runtimes: [], commandLedger: [] };
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
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// src/infrastructure/control-client.ts
function createControlClient(directory) {
  async function execute(command, timeoutMs = 30000) {
    const request = {
      requestID: command.requestID,
      command: command.command,
      goalID: command.goalID,
      args: "args" in command ? command.args : undefined,
      requestedAt: command.requestedAt
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
  return { execute, getState, getEvents };
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
import { randomUUID } from "crypto";
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
            requestID: randomUUID(),
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
            requestID: randomUUID(),
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
            requestID: randomUUID(),
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
            requestID: randomUUID(),
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
            requestID: randomUUID(),
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
            requestID: randomUUID(),
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
            requestID: randomUUID(),
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
            requestID: randomUUID(),
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
            requestID: randomUUID(),
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
              requestID: randomUUID(),
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
    var _el$ = _$createElement("box"), _el$2 = _$createElement("box"), _el$3 = _$createElement("box"), _el$4 = _$createElement("text"), _el$5 = _$createElement("span"), _el$7 = _$createElement("span"), _el$9 = _$createElement("span"), _el$0 = _$createTextNode(` `), _el$1 = _$createTextNode(` `), _el$10 = _$createElement("span"), _el$12 = _$createElement("span"), _el$13 = _$createElement("span"), _el$15 = _$createElement("span"), _el$17 = _$createElement("span"), _el$18 = _$createTextNode(` `), _el$19 = _$createTextNode(` running`), _el$20 = _$createElement("span"), _el$22 = _$createElement("span"), _el$24 = _$createElement("span"), _el$25 = _$createElement("span"), _el$27 = _$createElement("box"), _el$28 = _$createElement("text"), _el$29 = _$createElement("span"), _el$31 = _$createElement("box"), _el$43 = _$createElement("box"), _el$44 = _$createElement("text"), _el$45 = _$createElement("span"), _el$46 = _$createElement("input");
    _$insertNode(_el$, _el$2);
    _$setProp(_el$, "flexDirection", "column");
    _$setProp(_el$, "width", "100%");
    _$setProp(_el$, "alignItems", "center");
    _$setProp(_el$, "padding", 1);
    _$insertNode(_el$2, _el$3);
    _$insertNode(_el$2, _el$31);
    _$insertNode(_el$2, _el$43);
    _$setProp(_el$2, "flexDirection", "column");
    _$setProp(_el$2, "width", "90%");
    _$setProp(_el$2, "border", true);
    _$setProp(_el$2, "padding", 1);
    _$insertNode(_el$3, _el$4);
    _$insertNode(_el$3, _el$27);
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
    _$insertNode(_el$4, _el$24);
    _$insertNode(_el$4, _el$25);
    _$insertNode(_el$5, _$createTextNode(`\u2B22 Loop Dashboard`));
    _$insertNode(_el$7, _$createTextNode(` \u2502 `));
    _$insertNode(_el$9, _el$0);
    _$insertNode(_el$9, _el$1);
    _$insert(_el$9, () => mode().toUpperCase(), _el$1);
    _$insertNode(_el$10, _$createTextNode(` \u2502 `));
    _$insert(_el$12, () => activeGoals().length);
    _$insertNode(_el$13, _$createTextNode(` active`));
    _$insertNode(_el$15, _$createTextNode(` \u2502 `));
    _$insertNode(_el$17, _el$18);
    _$insertNode(_el$17, _el$19);
    _$insert(_el$17, (() => {
      var _c$ = _$memo(() => runningCount() > 0);
      return () => _c$() ? runningFrame() : "\u25CB";
    })(), _el$18);
    _$insert(_el$17, runningCount, _el$19);
    _$insertNode(_el$20, _$createTextNode(` (phase)`));
    _$insertNode(_el$22, _$createTextNode(` \u2502 `));
    _$insert(_el$24, () => state()?.goals.filter((g) => g.status === "complete").length || 0);
    _$insertNode(_el$25, _$createTextNode(` done`));
    _$insertNode(_el$27, _el$28);
    _$setProp(_el$27, "flexDirection", "row");
    _$setProp(_el$27, "alignItems", "center");
    _$setProp(_el$27, "paddingLeft", 1);
    _$setProp(_el$27, "paddingRight", 1);
    _$setProp(_el$27, "flexShrink", 0);
    _$spread(_el$27, _$mergeProps({
      get backgroundColor() {
        return theme().error;
      }
    }, {
      onMouseDown: handleBugReport
    }), true);
    _$insertNode(_el$28, _el$29);
    _$insertNode(_el$29, _$createTextNode(`Bug Report`));
    _$setProp(_el$29, "style", {
      fg: "white",
      bold: true
    });
    _$setProp(_el$31, "flexDirection", "column");
    _$setProp(_el$31, "flexShrink", 1);
    _$setProp(_el$31, "minHeight", 0);
    _$setProp(_el$31, "overflow", "hidden");
    _$insert(_el$31, _$createComponent(Show, {
      get when() {
        return showHelp();
      },
      get children() {
        var _el$32 = _$createElement("box"), _el$33 = _$createElement("text"), _el$34 = _$createElement("span");
        _$insertNode(_el$32, _el$33);
        _$setProp(_el$32, "flexDirection", "column");
        _$setProp(_el$32, "padding", 1);
        _$setProp(_el$32, "border", true);
        _$setProp(_el$32, "borderColor", "yellow");
        _$setProp(_el$32, "flexShrink", 0);
        _$setProp(_el$32, "maxHeight", 14);
        _$setProp(_el$32, "overflow", "hidden");
        _$insertNode(_el$33, _el$34);
        _$insertNode(_el$34, _$createTextNode(`\u2501\u2501\u2501 Keys: ? toggle help c toggle done : insert Ctrl+N normal o open A abort worker N nudge q close \u2501\u2501\u2501`));
        _$setProp(_el$34, "style", {
          fg: "yellow",
          bold: true
        });
        _$insert(_el$33, _$createComponent(For, {
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
                var _el$47 = _$createElement("span");
                _$insert(_el$47, label);
                _$effect((_$p) => _$setProp(_el$47, "style", {
                  fg: theme().primary,
                  bold: true
                }, _$p));
                return _el$47;
              })(), (() => {
                var _el$48 = _$createElement("span");
                _$insertNode(_el$48, _$createTextNode(` `));
                _$effect((_$p) => _$setProp(_el$48, "style", {
                  fg: theme().textMuted
                }, _$p));
                return _el$48;
              })(), _$createComponent(For, {
                each: segments,
                children: (seg, idx) => {
                  const hasArrow = seg.includes("\u2192");
                  if (hasArrow) {
                    const [k, d] = seg.split("\u2192").map((s) => s.trim());
                    return [_$memo(() => _$memo(() => idx() > 0)() && (() => {
                      var _el$54 = _$createElement("span");
                      _$insertNode(_el$54, _$createTextNode(` | `));
                      _$effect((_$p) => _$setProp(_el$54, "style", {
                        fg: theme().textMuted
                      }, _$p));
                      return _el$54;
                    })()), (() => {
                      var _el$50 = _$createElement("span");
                      _$insert(_el$50, k);
                      _$effect((_$p) => _$setProp(_el$50, "style", {
                        fg: theme().warning,
                        bold: true
                      }, _$p));
                      return _el$50;
                    })(), (() => {
                      var _el$51 = _$createElement("span");
                      _$insertNode(_el$51, _$createTextNode(` \u2192 `));
                      _$effect((_$p) => _$setProp(_el$51, "style", {
                        fg: theme().textMuted
                      }, _$p));
                      return _el$51;
                    })(), (() => {
                      var _el$53 = _$createElement("span");
                      _$insert(_el$53, d);
                      _$effect((_$p) => _$setProp(_el$53, "style", {
                        fg: theme().text
                      }, _$p));
                      return _el$53;
                    })()];
                  }
                  const sp = seg.indexOf(" ");
                  const k = sp > 0 ? seg.slice(0, sp) : seg;
                  const d = sp > 0 ? seg.slice(sp + 1) : "";
                  return [_$memo(() => _$memo(() => idx() > 0)() && (() => {
                    var _el$57 = _$createElement("span");
                    _$insertNode(_el$57, _$createTextNode(` | `));
                    _$effect((_$p) => _$setProp(_el$57, "style", {
                      fg: theme().textMuted
                    }, _$p));
                    return _el$57;
                  })()), (() => {
                    var _el$56 = _$createElement("span");
                    _$insert(_el$56, k);
                    _$effect((_$p) => _$setProp(_el$56, "style", {
                      fg: theme().warning,
                      bold: true
                    }, _$p));
                    return _el$56;
                  })(), d && (() => {
                    var _el$59 = _$createElement("span"), _el$60 = _$createTextNode(` `);
                    _$insertNode(_el$59, _el$60);
                    _$insert(_el$59, d, null);
                    _$effect((_$p) => _$setProp(_el$59, "style", {
                      fg: theme().text
                    }, _$p));
                    return _el$59;
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
                var _el$61 = _$createElement("span");
                _$insert(_el$61, indent);
                _$effect((_$p) => _$setProp(_el$61, "style", {
                  fg: theme().textMuted
                }, _$p));
                return _el$61;
              })(), (() => {
                var _el$62 = _$createElement("span");
                _$insert(_el$62, key);
                _$effect((_$p) => _$setProp(_el$62, "style", {
                  fg: theme().warning,
                  bold: true
                }, _$p));
                return _el$62;
              })(), desc && [(() => {
                var _el$63 = _$createElement("span");
                _$insertNode(_el$63, _$createTextNode(` `));
                _$effect((_$p) => _$setProp(_el$63, "style", {
                  fg: theme().textMuted
                }, _$p));
                return _el$63;
              })(), (() => {
                var _el$65 = _$createElement("span");
                _$insert(_el$65, desc);
                _$effect((_$p) => _$setProp(_el$65, "style", {
                  fg: theme().textMuted
                }, _$p));
                return _el$65;
              })()]];
            }
            const isHeader = line.startsWith("Commands");
            return [`
`, (() => {
              var _el$66 = _$createElement("span");
              _$insert(_el$66, line);
              _$effect((_$p) => _$setProp(_el$66, "style", {
                fg: isHeader ? theme().primary : theme().textMuted,
                bold: isHeader
              }, _$p));
              return _el$66;
            })()];
          }
        }), null);
        _$effect((_$p) => _$setProp(_el$32, "backgroundColor", theme().background, _$p));
        return _el$32;
      }
    }), null);
    _$insert(_el$31, _$createComponent(Show, {
      get when() {
        return activeGoals().length > 0;
      },
      get fallback() {
        return (() => {
          var _el$67 = _$createElement("box"), _el$68 = _$createElement("text"), _el$69 = _$createElement("span"), _el$71 = _$createElement("span"), _el$73 = _$createElement("span"), _el$75 = _$createElement("text"), _el$76 = _$createElement("span"), _el$78 = _$createElement("span"), _el$80 = _$createElement("span"), _el$82 = _$createElement("span"), _el$84 = _$createElement("span"), _el$86 = _$createElement("span"), _el$88 = _$createElement("span");
          _$insertNode(_el$67, _el$68);
          _$insertNode(_el$67, _el$75);
          _$setProp(_el$67, "flexDirection", "column");
          _$setProp(_el$67, "gap", 1);
          _$setProp(_el$67, "padding", 1);
          _$insertNode(_el$68, _el$69);
          _$insertNode(_el$68, _el$71);
          _$insertNode(_el$68, _el$73);
          _$insertNode(_el$69, _$createTextNode(`No active goals.`));
          _$insertNode(_el$71, _$createTextNode(` /goal`));
          _$insertNode(_el$73, _$createTextNode(` in parent chat to create one.`));
          _$insertNode(_el$75, _el$76);
          _$insertNode(_el$75, _el$78);
          _$insertNode(_el$75, _el$80);
          _$insertNode(_el$75, _el$82);
          _$insertNode(_el$75, _el$84);
          _$insertNode(_el$75, _el$86);
          _$insertNode(_el$75, _el$88);
          _$insertNode(_el$76, _$createTextNode(`Tip: `));
          _$insertNode(_el$78, _$createTextNode(`:send`));
          _$insertNode(_el$80, _$createTextNode(` to steer the worker \xB7 `));
          _$insertNode(_el$82, _$createTextNode(`o`));
          _$insertNode(_el$84, _$createTextNode(` to open child \xB7 `));
          _$insertNode(_el$86, _$createTextNode(`:force`));
          _$insertNode(_el$88, _$createTextNode(` to complete manually.`));
          _$effect((_p$) => {
            var _v$22 = {
              fg: theme().textMuted
            }, _v$23 = {
              fg: theme().accent
            }, _v$24 = {
              fg: theme().textMuted
            }, _v$25 = {
              fg: theme().textMuted
            }, _v$26 = {
              fg: theme().warning
            }, _v$27 = {
              fg: theme().textMuted
            }, _v$28 = {
              fg: theme().warning
            }, _v$29 = {
              fg: theme().textMuted
            }, _v$30 = {
              fg: theme().warning
            }, _v$31 = {
              fg: theme().textMuted
            };
            _v$22 !== _p$.e && (_p$.e = _$setProp(_el$69, "style", _v$22, _p$.e));
            _v$23 !== _p$.t && (_p$.t = _$setProp(_el$71, "style", _v$23, _p$.t));
            _v$24 !== _p$.a && (_p$.a = _$setProp(_el$73, "style", _v$24, _p$.a));
            _v$25 !== _p$.o && (_p$.o = _$setProp(_el$76, "style", _v$25, _p$.o));
            _v$26 !== _p$.i && (_p$.i = _$setProp(_el$78, "style", _v$26, _p$.i));
            _v$27 !== _p$.n && (_p$.n = _$setProp(_el$80, "style", _v$27, _p$.n));
            _v$28 !== _p$.s && (_p$.s = _$setProp(_el$82, "style", _v$28, _p$.s));
            _v$29 !== _p$.h && (_p$.h = _$setProp(_el$84, "style", _v$29, _p$.h));
            _v$30 !== _p$.r && (_p$.r = _$setProp(_el$86, "style", _v$30, _p$.r));
            _v$31 !== _p$.d && (_p$.d = _$setProp(_el$88, "style", _v$31, _p$.d));
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
          return _el$67;
        })();
      },
      get children() {
        var _el$36 = _$createElement("scrollbox");
        _$use((el) => {
          listScrollRef = el;
        }, _el$36);
        _$setProp(_el$36, "scrollbarOptions", {
          visible: false
        });
        _$insert(_el$36, _$createComponent(For, {
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
              var _el$90 = _$createElement("box"), _el$91 = _$createElement("text"), _el$92 = _$createElement("span"), _el$93 = _$createElement("span"), _el$95 = _$createElement("span");
              _$insertNode(_el$90, _el$91);
              _$setProp(_el$90, "flexDirection", "row");
              _$setProp(_el$90, "paddingLeft", 1);
              _$setProp(_el$90, "paddingRight", 1);
              _$insertNode(_el$91, _el$92);
              _$insertNode(_el$91, _el$93);
              _$insertNode(_el$91, _el$95);
              _$setProp(_el$91, "wrapMode", "none");
              _$setProp(_el$91, "truncate", true);
              _$insert(_el$92, (() => {
                var _c$2 = _$memo(() => !!isActive());
                return () => _c$2() ? `\u25B6 ${statusIcon(goal.status)} ${goal.name}` : `  ${statusIcon(goal.status)} ${goal.name}`;
              })());
              _$insertNode(_el$93, _$createTextNode(` \u2502 `));
              _$insert(_el$95, () => goal.status.toUpperCase());
              _$insert(_el$91, (() => {
                var _c$3 = _$memo(() => !!runtime());
                return () => _c$3() && [(() => {
                  var _el$96 = _$createElement("span");
                  _$insertNode(_el$96, _$createTextNode(` \u2502 `));
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
                  _$insert(_el$98, () => runtime().phase.toUpperCase(), null);
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
              _$insert(_el$91, (() => {
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
              _$insert(_el$91, (() => {
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
              _$insert(_el$91, (() => {
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
              _$insert(_el$91, (() => {
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
              _$insert(_el$91, (() => {
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
              _$insert(_el$91, (() => {
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
              _$insert(_el$91, (() => {
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
                var _v$32 = rowIdFor(goal.id), _v$33 = isActive() ? theme().backgroundElement : undefined, _v$34 = {
                  fg: statusColor(goal.status, theme()),
                  bold: isActive()
                }, _v$35 = {
                  fg: theme().textMuted
                }, _v$36 = {
                  fg: statusColor(goal.status, theme()),
                  bold: true
                };
                _v$32 !== _p$.e && (_p$.e = _$setProp(_el$90, "id", _v$32, _p$.e));
                _v$33 !== _p$.t && (_p$.t = _$setProp(_el$90, "backgroundColor", _v$33, _p$.t));
                _v$34 !== _p$.a && (_p$.a = _$setProp(_el$92, "style", _v$34, _p$.a));
                _v$35 !== _p$.o && (_p$.o = _$setProp(_el$93, "style", _v$35, _p$.o));
                _v$36 !== _p$.i && (_p$.i = _$setProp(_el$95, "style", _v$36, _p$.i));
                return _p$;
              }, {
                e: undefined,
                t: undefined,
                a: undefined,
                o: undefined,
                i: undefined
              });
              return _el$90;
            })();
          }
        }));
        _$effect((_$p) => _$setProp(_el$36, "height", listHeight(), _$p));
        return _el$36;
      }
    }), null);
    _$insert(_el$31, _$createComponent(Show, {
      get when() {
        return selectedGoal();
      },
      children: (goal) => {
        const rt = () => state()?.runtimes.find((r) => r.goalID === goal().id);
        const lp = () => goal().lastProgress;
        const blk = () => goal().blocker;
        return (() => {
          var _el$121 = _$createElement("box"), _el$122 = _$createElement("text"), _el$123 = _$createElement("span"), _el$124 = _$createTextNode(` `), _el$125 = _$createElement("span"), _el$126 = _$createTextNode(` `), _el$127 = _$createTextNode(`
`), _el$128 = _$createElement("span");
          _$insertNode(_el$121, _el$122);
          _$setProp(_el$121, "flexDirection", "column");
          _$setProp(_el$121, "border", true);
          _$setProp(_el$121, "padding", 1);
          _$setProp(_el$121, "flexShrink", 0);
          _$setProp(_el$121, "maxHeight", 13);
          _$insertNode(_el$122, _el$123);
          _$insertNode(_el$122, _el$125);
          _$insertNode(_el$122, _el$127);
          _$insertNode(_el$122, _el$128);
          _$insertNode(_el$123, _el$124);
          _$insert(_el$123, () => statusIcon(goal().status), _el$124);
          _$insert(_el$123, () => goal().name, null);
          _$insertNode(_el$125, _el$126);
          _$insert(_el$125, () => goal().status.toUpperCase(), null);
          _$insert(_el$122, (() => {
            var _c$10 = _$memo(() => !!rt());
            return () => _c$10() && [(() => {
              var _el$129 = _$createElement("span");
              _$insertNode(_el$129, _$createTextNode(` \u2502 `));
              _$effect((_$p) => _$setProp(_el$129, "style", {
                fg: theme().textMuted
              }, _$p));
              return _el$129;
            })(), (() => {
              var _el$131 = _$createElement("span"), _el$132 = _$createTextNode(` `);
              _$insertNode(_el$131, _el$132);
              _$insert(_el$131, () => phaseIcon(rt().phase), _el$132);
              _$insert(_el$131, () => rt().phase, null);
              _$effect((_$p) => _$setProp(_el$131, "style", {
                fg: phaseColor(rt().phase, theme()),
                bold: true
              }, _$p));
              return _el$131;
            })(), (() => {
              var _el$133 = _$createElement("span"), _el$134 = _$createTextNode(` run `), _el$135 = _$createTextNode(` (budget `), _el$136 = _$createTextNode(`)`);
              _$insertNode(_el$133, _el$134);
              _$insertNode(_el$133, _el$135);
              _$insertNode(_el$133, _el$136);
              _$insert(_el$133, () => rt().runCount, _el$135);
              _$insert(_el$133, () => rt().budgetTurnCount, _el$136);
              _$effect((_$p) => _$setProp(_el$133, "style", {
                fg: theme().textMuted
              }, _$p));
              return _el$133;
            })()];
          })(), _el$127);
          _$insert(_el$122, (() => {
            var _c$11 = _$memo(() => !!rt()?.workerAbortedAt);
            return () => _c$11() && [(() => {
              var _el$137 = _$createElement("span");
              _$insertNode(_el$137, _$createTextNode(` \u2502 \u26A0 worker aborted `));
              _$effect((_$p) => _$setProp(_el$137, "style", {
                fg: theme().warning,
                bold: true
              }, _$p));
              return _el$137;
            })(), (() => {
              var _el$139 = _$createElement("span"), _el$140 = _$createTextNode(` \u2014 session kept, next turn reuses it`);
              _$insertNode(_el$139, _el$140);
              _$insert(_el$139, () => ageLabel(rt().workerAbortedAt, clock()), _el$140);
              _$effect((_$p) => _$setProp(_el$139, "style", {
                fg: theme().textMuted
              }, _$p));
              return _el$139;
            })()];
          })(), _el$127);
          _$insert(_el$122, () => {
            const agentName = goal().config.agent;
            const meta = agentName ? agentIndex()[agentName] ?? agentIndex()[agentName.toLowerCase()] : undefined;
            const model = goal().config.model;
            const slash = model?.indexOf("/") ?? -1;
            return [`
`, (() => {
              var _el$141 = _$createElement("span");
              _$insertNode(_el$141, _$createTextNode(`\uD83E\uDD16 `));
              _$effect((_$p) => _$setProp(_el$141, "style", {
                fg: theme().textMuted
              }, _$p));
              return _el$141;
            })(), agentName ? [(() => {
              var _el$153 = _$createElement("span");
              _$insert(_el$153, agentName);
              _$effect((_$p) => _$setProp(_el$153, "style", {
                fg: agentColor(meta?.color, theme()),
                bold: true
              }, _$p));
              return _el$153;
            })(), _$memo(() => _$memo(() => !!meta?.mode)() && (() => {
              var _el$154 = _$createElement("span"), _el$155 = _$createTextNode(` (`), _el$156 = _$createTextNode(`)`);
              _$insertNode(_el$154, _el$155);
              _$insertNode(_el$154, _el$156);
              _$insert(_el$154, () => meta.mode, _el$156);
              _$effect((_$p) => _$setProp(_el$154, "style", {
                fg: theme().textMuted
              }, _$p));
              return _el$154;
            })())] : (() => {
              var _el$157 = _$createElement("span");
              _$insertNode(_el$157, _$createTextNode(`parent default`));
              _$effect((_$p) => _$setProp(_el$157, "style", {
                fg: theme().textMuted
              }, _$p));
              return _el$157;
            })(), (() => {
              var _el$143 = _$createElement("span");
              _$insertNode(_el$143, _$createTextNode(` \u2502 \uD83E\uDDE0 `));
              _$effect((_$p) => _$setProp(_el$143, "style", {
                fg: theme().textMuted
              }, _$p));
              return _el$143;
            })(), model && slash > 0 ? [(() => {
              var _el$159 = _$createElement("span"), _el$160 = _$createTextNode(`/`);
              _$insertNode(_el$159, _el$160);
              _$insert(_el$159, () => model.slice(0, slash), _el$160);
              _$effect((_$p) => _$setProp(_el$159, "style", {
                fg: theme().textMuted
              }, _$p));
              return _el$159;
            })(), (() => {
              var _el$161 = _$createElement("span");
              _$insert(_el$161, () => model.slice(slash + 1));
              _$effect((_$p) => _$setProp(_el$161, "style", {
                fg: theme().info,
                bold: true
              }, _$p));
              return _el$161;
            })()] : (() => {
              var _el$162 = _$createElement("span");
              _$insertNode(_el$162, _$createTextNode(`session default`));
              _$effect((_$p) => _$setProp(_el$162, "style", {
                fg: theme().textMuted
              }, _$p));
              return _el$162;
            })(), (() => {
              var _el$145 = _$createElement("span");
              _$insertNode(_el$145, _$createTextNode(` \u2502 \uD83D\uDCB0 `));
              _$effect((_$p) => _$setProp(_el$145, "style", {
                fg: theme().textMuted
              }, _$p));
              return _el$145;
            })(), (() => {
              var _el$147 = _$createElement("span");
              _$insert(_el$147, () => formatTokens(goal().tokensUsed));
              _$effect((_$p) => _$setProp(_el$147, "style", {
                fg: theme().warning,
                bold: true
              }, _$p));
              return _el$147;
            })(), (() => {
              var _el$148 = _$createElement("span");
              _$insertNode(_el$148, _$createTextNode(` tokens \xB7 `));
              _$effect((_$p) => _$setProp(_el$148, "style", {
                fg: theme().textMuted
              }, _$p));
              return _el$148;
            })(), (() => {
              var _el$150 = _$createElement("span");
              _$insert(_el$150, () => formatCost(goal().costUsed));
              _$effect((_$p) => _$setProp(_el$150, "style", {
                fg: theme().success,
                bold: true
              }, _$p));
              return _el$150;
            })(), (() => {
              var _el$151 = _$createElement("span"), _el$152 = _$createTextNode(` \xB7 `);
              _$insertNode(_el$151, _el$152);
              _$insert(_el$151, () => formatDuration(goal().timeUsedSeconds), null);
              _$effect((_$p) => _$setProp(_el$151, "style", {
                fg: theme().textMuted
              }, _$p));
              return _el$151;
            })()];
          }, _el$127);
          _$insert(_el$128, () => goal().objective.slice(0, 160));
          _$insert(_el$122, (() => {
            var _c$12 = _$memo(() => !!lp());
            return () => _c$12() && [(() => {
              var _el$164 = _$createElement("span"), _el$165 = _$createTextNode(`
\u2714 `);
              _$insertNode(_el$164, _el$165);
              _$effect((_$p) => _$setProp(_el$164, "style", {
                fg: theme().success
              }, _$p));
              return _el$164;
            })(), (() => {
              var _el$167 = _$createElement("span");
              _$insert(_el$167, () => lp().summary.slice(0, 100));
              _$effect((_$p) => _$setProp(_el$167, "style", {
                fg: theme().text
              }, _$p));
              return _el$167;
            })(), (() => {
              var _el$168 = _$createElement("span"), _el$169 = _$createTextNode(` \u2192 `);
              _$insertNode(_el$168, _el$169);
              _$insert(_el$168, () => lp().next?.slice(0, 60) || "", null);
              _$effect((_$p) => _$setProp(_el$168, "style", {
                fg: theme().textMuted
              }, _$p));
              return _el$168;
            })()];
          })(), null);
          _$insert(_el$122, (() => {
            var _c$13 = _$memo(() => !!blk());
            return () => _c$13() && [(() => {
              var _el$170 = _$createElement("span"), _el$171 = _$createTextNode(`
\u2716 blocked: `);
              _$insertNode(_el$170, _el$171);
              _$effect((_$p) => _$setProp(_el$170, "style", {
                fg: theme().error,
                bold: true
              }, _$p));
              return _el$170;
            })(), (() => {
              var _el$173 = _$createElement("span");
              _$insert(_el$173, () => blk().reason.slice(0, 140));
              _$effect((_$p) => _$setProp(_el$173, "style", {
                fg: theme().error
              }, _$p));
              return _el$173;
            })(), (() => {
              var _el$174 = _$createElement("span"), _el$175 = _$createTextNode(` \u2014 `);
              _$insertNode(_el$174, _el$175);
              _$insert(_el$174, () => blk().needed.slice(0, 60), null);
              _$effect((_$p) => _$setProp(_el$174, "style", {
                fg: theme().textMuted
              }, _$p));
              return _el$174;
            })()];
          })(), null);
          _$insert(_el$122, (() => {
            var _c$14 = _$memo(() => !!goal().config.artifactDir);
            return () => _c$14() && [(() => {
              var _el$176 = _$createElement("span"), _el$177 = _$createTextNode(`
\uD83D\uDCC1 `);
              _$insertNode(_el$176, _el$177);
              _$effect((_$p) => _$setProp(_el$176, "style", {
                fg: theme().accent
              }, _$p));
              return _el$176;
            })(), (() => {
              var _el$179 = _$createElement("span");
              _$insert(_el$179, () => String(goal().config.artifactDir).replace(String(props.directory), "."));
              _$effect((_$p) => _$setProp(_el$179, "style", {
                fg: theme().textMuted
              }, _$p));
              return _el$179;
            })()];
          })(), null);
          _$insert(_el$122, (() => {
            var _c$15 = _$memo(() => (goal().config.checks?.length ?? 0) > 0);
            return () => _c$15() ? [(() => {
              var _el$180 = _$createElement("span"), _el$181 = _$createTextNode(`
\u25A3 checks: `);
              _$insertNode(_el$180, _el$181);
              _$effect((_$p) => _$setProp(_el$180, "style", {
                fg: theme().warning
              }, _$p));
              return _el$180;
            })(), (() => {
              var _el$183 = _$createElement("span");
              _$insert(_el$183, () => goal().config.checks.join(", ").slice(0, 100));
              _$effect((_$p) => _$setProp(_el$183, "style", {
                fg: theme().textMuted
              }, _$p));
              return _el$183;
            })()] : null;
          })(), null);
          _$insert(_el$122, (() => {
            var _c$16 = _$memo(() => rt()?.evaluatorRejectionCount > 0);
            return () => _c$16() && [(() => {
              var _el$184 = _$createElement("span"), _el$185 = _$createTextNode(`
\u26A0 rejections: `);
              _$insertNode(_el$184, _el$185);
              _$effect((_$p) => _$setProp(_el$184, "style", {
                fg: theme().warning
              }, _$p));
              return _el$184;
            })(), (() => {
              var _el$187 = _$createElement("span"), _el$188 = _$createTextNode(` \u2014 `);
              _$insertNode(_el$187, _el$188);
              _$insert(_el$187, () => String(rt().evaluatorRejectionCount), _el$188);
              _$insert(_el$187, () => String(rt().lastRejectionDetails || "").slice(0, 80), null);
              _$effect((_$p) => _$setProp(_el$187, "style", {
                fg: theme().warning
              }, _$p));
              return _el$187;
            })()];
          })(), null);
          _$insert(_el$122, (() => {
            var _c$17 = _$memo(() => rt()?.unknownStatusCount > 0);
            return () => _c$17() && [(() => {
              var _el$189 = _$createElement("span"), _el$190 = _$createTextNode(`
\u26A0\uFE0F unreachable: `);
              _$insertNode(_el$189, _el$190);
              _$effect((_$p) => _$setProp(_el$189, "style", {
                fg: theme().error
              }, _$p));
              return _el$189;
            })(), (() => {
              var _el$192 = _$createElement("span"), _el$193 = _$createTextNode(`/3`);
              _$insertNode(_el$192, _el$193);
              _$insert(_el$192, () => String(rt().unknownStatusCount), _el$193);
              _$effect((_$p) => _$setProp(_el$192, "style", {
                fg: theme().error
              }, _$p));
              return _el$192;
            })(), (() => {
              var _el$194 = _$createElement("span");
              _$insertNode(_el$194, _$createTextNode(` \u2014 nudge to recover`));
              _$effect((_$p) => _$setProp(_el$194, "style", {
                fg: theme().textMuted
              }, _$p));
              return _el$194;
            })()];
          })(), null);
          _$insert(_el$122, (() => {
            var _c$18 = _$memo(() => !!rt()?.retryAfter);
            return () => _c$18() && [(() => {
              var _el$196 = _$createElement("span"), _el$197 = _$createTextNode(`
\u21BB retry in: `);
              _$insertNode(_el$196, _el$197);
              _$effect((_$p) => _$setProp(_el$196, "style", {
                fg: theme().accent
              }, _$p));
              return _el$196;
            })(), (() => {
              var _el$199 = _$createElement("span");
              _$insert(_el$199, () => countdownLabel(rt().retryAfter, clock()));
              _$effect((_$p) => _$setProp(_el$199, "style", {
                fg: theme().accent
              }, _$p));
              return _el$199;
            })()];
          })(), null);
          _$insert(_el$122, (() => {
            var _c$19 = _$memo(() => !!rt()?.nextRunAt);
            return () => _c$19() && [(() => {
              var _el$200 = _$createElement("span"), _el$201 = _$createTextNode(`
\u23F0 next run: `);
              _$insertNode(_el$200, _el$201);
              _$effect((_$p) => _$setProp(_el$200, "style", {
                fg: theme().accent
              }, _$p));
              return _el$200;
            })(), (() => {
              var _el$203 = _$createElement("span");
              _$insert(_el$203, () => countdownLabel(rt().nextRunAt, clock()));
              _$effect((_$p) => _$setProp(_el$203, "style", {
                fg: theme().accent
              }, _$p));
              return _el$203;
            })(), (() => {
              var _el$204 = _$createElement("span"), _el$205 = _$createTextNode(` (`), _el$206 = _$createTextNode(` runs)`);
              _$insertNode(_el$204, _el$205);
              _$insertNode(_el$204, _el$206);
              _$insert(_el$204, () => String(rt().scheduleRunCount || 0), _el$206);
              _$effect((_$p) => _$setProp(_el$204, "style", {
                fg: theme().textMuted
              }, _$p));
              return _el$204;
            })()];
          })(), null);
          _$insert(_el$122, (() => {
            var _c$20 = _$memo(() => !!rt()?.lastError);
            return () => _c$20() && [(() => {
              var _el$207 = _$createElement("span"), _el$208 = _$createTextNode(`
\u26A0 `);
              _$insertNode(_el$207, _el$208);
              _$effect((_$p) => _$setProp(_el$207, "style", {
                fg: theme().error
              }, _$p));
              return _el$207;
            })(), (() => {
              var _el$210 = _$createElement("span");
              _$insert(_el$210, () => rt().lastError.slice(0, 120));
              _$effect((_$p) => _$setProp(_el$210, "style", {
                fg: theme().error
              }, _$p));
              return _el$210;
            })()];
          })(), null);
          _$effect((_p$) => {
            var _v$37 = borderColorForStatus(goal().status, theme()), _v$38 = {
              fg: statusColor(goal().status, theme()),
              bold: true
            }, _v$39 = {
              fg: statusColor(goal().status, theme())
            }, _v$40 = {
              fg: theme().text
            };
            _v$37 !== _p$.e && (_p$.e = _$setProp(_el$121, "borderColor", _v$37, _p$.e));
            _v$38 !== _p$.t && (_p$.t = _$setProp(_el$123, "style", _v$38, _p$.t));
            _v$39 !== _p$.a && (_p$.a = _$setProp(_el$125, "style", _v$39, _p$.a));
            _v$40 !== _p$.o && (_p$.o = _$setProp(_el$128, "style", _v$40, _p$.o));
            return _p$;
          }, {
            e: undefined,
            t: undefined,
            a: undefined,
            o: undefined
          });
          return _el$121;
        })();
      }
    }), null);
    _$insert(_el$31, _$createComponent(Show, {
      get when() {
        return _$memo(() => !!showLogs())() && events().length > 0;
      },
      get children() {
        var _el$37 = _$createElement("box"), _el$38 = _$createElement("text"), _el$39 = _$createElement("span"), _el$41 = _$createElement("span");
        _$insertNode(_el$37, _el$38);
        _$setProp(_el$37, "flexDirection", "column");
        _$setProp(_el$37, "border", true);
        _$setProp(_el$37, "padding", 1);
        _$setProp(_el$37, "maxHeight", 7);
        _$setProp(_el$37, "flexShrink", 0);
        _$setProp(_el$37, "overflow", "hidden");
        _$insertNode(_el$38, _el$39);
        _$insertNode(_el$38, _el$41);
        _$insertNode(_el$39, _$createTextNode(`\u25C8 Recent Events`));
        _$insertNode(_el$41, _$createTextNode(` \u2014 :logs to hide`));
        _$insert(_el$38, _$createComponent(For, {
          get each() {
            return events().slice(-10);
          },
          children: (ev) => [`
`, (() => {
            var _el$211 = _$createElement("span");
            _$insert(_el$211, () => String(ev.type));
            _$effect((_$p) => _$setProp(_el$211, "style", {
              fg: eventColor(String(ev.type), theme()),
              bold: true
            }, _$p));
            return _el$211;
          })(), (() => {
            var _el$212 = _$createElement("span"), _el$213 = _$createTextNode(` `);
            _$insertNode(_el$212, _el$213);
            _$insert(_el$212, () => ev.goalID?.slice(0, 8), null);
            _$effect((_$p) => _$setProp(_el$212, "style", {
              fg: theme().textMuted
            }, _$p));
            return _el$212;
          })(), _$memo(() => _$memo(() => !!ev.summary)() && (() => {
            var _el$214 = _$createElement("span"), _el$215 = _$createTextNode(` \u2014 `);
            _$insertNode(_el$214, _el$215);
            _$insert(_el$214, () => String(ev.summary).slice(0, 60), null);
            _$effect((_$p) => _$setProp(_el$214, "style", {
              fg: theme().text
            }, _$p));
            return _el$214;
          })())]
        }), null);
        _$effect((_p$) => {
          var _v$ = theme().border, _v$2 = {
            fg: theme().accent,
            bold: true
          }, _v$3 = {
            fg: theme().textMuted
          };
          _v$ !== _p$.e && (_p$.e = _$setProp(_el$37, "borderColor", _v$, _p$.e));
          _v$2 !== _p$.t && (_p$.t = _$setProp(_el$39, "style", _v$2, _p$.t));
          _v$3 !== _p$.a && (_p$.a = _$setProp(_el$41, "style", _v$3, _p$.a));
          return _p$;
        }, {
          e: undefined,
          t: undefined,
          a: undefined
        });
        return _el$37;
      }
    }), null);
    _$insertNode(_el$43, _el$44);
    _$insertNode(_el$43, _el$46);
    _$setProp(_el$43, "flexDirection", "row");
    _$setProp(_el$43, "border", true);
    _$setProp(_el$43, "paddingLeft", 1);
    _$setProp(_el$43, "paddingRight", 1);
    _$setProp(_el$43, "flexShrink", 0);
    _$setProp(_el$43, "height", 3);
    _$setProp(_el$43, "gap", 1);
    _$insertNode(_el$44, _el$45);
    _$insert(_el$45, () => mode() === "insert" ? " INSERT \uE0B1" : " NORMAL ");
    _$use((el) => {
      inputEl = el;
      focusInput();
    }, _el$46);
    _$setProp(_el$46, "flexGrow", 1);
    _$setProp(_el$46, "onInput", (v) => {
      debugLog("onInput", JSON.stringify(v), "mode", mode());
      if (mode() === "insert")
        setCommandInput(v);
      else if (inputEl?.value)
        inputEl.value = "";
    });
    _$setProp(_el$46, "onKeyDown", (evt) => {
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
        fg: theme().textMuted
      }, _v$13 = {
        fg: theme().info,
        bold: true
      }, _v$14 = {
        fg: theme().textMuted
      }, _v$15 = mode() === "insert" ? theme().warning : theme().border, _v$16 = {
        fg: mode() === "insert" ? theme().warning : theme().success,
        bold: true,
        bg: mode() === "insert" ? theme().backgroundElement : undefined
      }, _v$17 = mode() === "insert" ? ":send hello  or  :force done --evidence proof  or  :open  (Ctrl+N: normal)" : statusText() || "Press : to send/command  \xB7  ? help  \xB7  o open child  \xB7  q close", _v$18 = theme().textMuted, _v$19 = theme().primary, _v$20 = theme().text, _v$21 = theme().background;
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
      _v$13 !== _p$.u && (_p$.u = _$setProp(_el$24, "style", _v$13, _p$.u));
      _v$14 !== _p$.c && (_p$.c = _$setProp(_el$25, "style", _v$14, _p$.c));
      _v$15 !== _p$.w && (_p$.w = _$setProp(_el$43, "borderColor", _v$15, _p$.w));
      _v$16 !== _p$.m && (_p$.m = _$setProp(_el$45, "style", _v$16, _p$.m));
      _v$17 !== _p$.f && (_p$.f = _$setProp(_el$46, "placeholder", _v$17, _p$.f));
      _v$18 !== _p$.y && (_p$.y = _$setProp(_el$46, "placeholderColor", _v$18, _p$.y));
      _v$19 !== _p$.g && (_p$.g = _$setProp(_el$46, "cursorColor", _v$19, _p$.g));
      _v$20 !== _p$.p && (_p$.p = _$setProp(_el$46, "focusedTextColor", _v$20, _p$.p));
      _v$21 !== _p$.b && (_p$.b = _$setProp(_el$46, "focusedBackgroundColor", _v$21, _p$.b));
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
      p: undefined,
      b: undefined
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
    api.ui.dialog.replace(() => _$createComponent2(LoopDashboard, {
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
    }],
    bindings: [{
      key: "<leader>o",
      cmd: "opencode.loopd.dashboard",
      desc: "Open loop dashboard"
    }]
  });
  api.lifecycle.onDispose(() => {});
};
var plugin_default = {
  id: PLUGIN_ID,
  tui
};
export {
  plugin_default as default
};

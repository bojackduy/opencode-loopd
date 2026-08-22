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
var CURRENT_VERSION = 2;
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
    "Nav: j/k move | g/G top/bottom | o open child | p/r/R/x pause/resume/retry/clear | L logs | q close",
    "Commands (insert mode, : prefix):",
    "  :send <message>                           Send instruction to selected goal",
    "  :open                                     Open child session (same as o)",
    "  :force <summary> --evidence <text>        Force-complete (bypass checks)",
    "  :block <reason> --needed <text>           Force-block the selected goal",
    "  :pause / :resume / :retry / :clear        Quick controls (also p/r/R/x)",
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
function LoopDashboard(props) {
  const theme = () => props.api.theme.current;
  const [mode, setMode] = createSignal("normal");
  const [selected, setSelected] = createSignal(0);
  const [commandInput, setCommandInput] = createSignal("");
  const [statusText, setStatusText] = createSignal("Press : to send/command, ? help, o open, q close");
  const [state, setState] = createSignal(null);
  const [events, setEvents] = createSignal([]);
  const [selectedGoal, setSelectedGoal] = createSignal(null);
  const [showLogs, setShowLogs] = createSignal(false);
  const [showHelp, setShowHelp] = createSignal(false);
  const [clock, setClock] = createSignal(Date.now());
  let inputEl;
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
      const goals2 = s.goals.filter((g) => g.status !== "complete");
      if (goals2.length > 0 && selected() >= goals2.length)
        setSelected(goals2.length - 1);
      setSelectedGoal(goals2[selected()] || null);
      setEvents(await client.getEvents(20));
    } catch (e) {
      setStatusText(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  refresh();
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
        writeFileSync
      } = __require("fs");
      writeFileSync(LOG_FILE, `[${new Date().toISOString()}] dashboard mounted dir=${props.directory} mode=${mode()} dialogOpen=${props.api.ui.dialog.open}
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
      if (evt.ctrl && name.toLowerCase() === "n") {
        prevent(evt);
        returnToNormalMode();
        debugLog("insert -> normal via ctrl+n");
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
    const currentGoals = state()?.goals.filter((goal) => goal.status !== "complete") || [];
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
  const goals = () => state()?.goals.filter((g) => g.status !== "complete") || [];
  async function executeCommand(cmd) {
    debugLog("executeCommand raw=", JSON.stringify(cmd));
    const parsed = parseCommand(cmd);
    debugLog("parsed", parsed);
    if (!parsed) {
      setStatusText("Empty command");
      debugLog("empty command");
      return;
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
  const activeGoals = () => state()?.goals.filter((g) => g.status !== "complete") || [];
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
  return (() => {
    var _el$ = _$createElement("box"), _el$2 = _$createElement("box"), _el$3 = _$createElement("box"), _el$4 = _$createElement("text"), _el$5 = _$createElement("span"), _el$7 = _$createElement("span"), _el$9 = _$createElement("span"), _el$0 = _$createTextNode(` `), _el$1 = _$createTextNode(` `), _el$10 = _$createElement("span"), _el$12 = _$createElement("span"), _el$13 = _$createElement("span"), _el$15 = _$createElement("span"), _el$17 = _$createElement("span"), _el$18 = _$createTextNode(` `), _el$19 = _$createTextNode(` RUNNING`), _el$20 = _$createElement("span"), _el$22 = _$createElement("span"), _el$23 = _$createElement("span"), _el$25 = _$createElement("box"), _el$26 = _$createElement("text"), _el$27 = _$createElement("span"), _el$29 = _$createElement("box"), _el$34 = _$createElement("box"), _el$41 = _$createElement("box"), _el$42 = _$createElement("text"), _el$43 = _$createElement("span"), _el$44 = _$createElement("input");
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
    _$insertNode(_el$13, _$createTextNode(` goals`));
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
    _$setProp(_el$25, "border", true);
    _$setProp(_el$25, "paddingLeft", 1);
    _$setProp(_el$25, "paddingRight", 1);
    _$setProp(_el$25, "flexShrink", 0);
    _$spread(_el$25, _$mergeProps({
      get borderColor() {
        return theme().error;
      }
    }, {
      onMouseDown: handleBugReport
    }), true);
    _$insertNode(_el$26, _el$27);
    _$insertNode(_el$27, _$createTextNode(`Bug`));
    _$insertNode(_el$29, _el$34);
    _$setProp(_el$29, "flexDirection", "column");
    _$setProp(_el$29, "flexGrow", 1);
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
        _$insertNode(_el$32, _$createTextNode(`\u2501\u2501\u2501 Keys: ? toggle : insert Ctrl+N normal o open B bug q close \u2501\u2501\u2501`));
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
                    const [k2, d2] = seg.split("\u2192").map((s) => s.trim());
                    return [_$memo(() => _$memo(() => idx() > 0)() && (() => {
                      var _el$52 = _$createElement("span");
                      _$insertNode(_el$52, _$createTextNode(` | `));
                      _$effect((_$p) => _$setProp(_el$52, "style", {
                        fg: theme().textMuted
                      }, _$p));
                      return _el$52;
                    })()), (() => {
                      var _el$48 = _$createElement("span");
                      _$insert(_el$48, k2);
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
                      _$insert(_el$51, d2);
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
    }), _el$34);
    _$setProp(_el$34, "flexDirection", "column");
    _$setProp(_el$34, "flexGrow", 1);
    _$setProp(_el$34, "padding", 1);
    _$setProp(_el$34, "minHeight", 0);
    _$setProp(_el$34, "overflow", "hidden");
    _$insert(_el$34, _$createComponent(Show, {
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
            _v$22 !== _p$.e && (_p$.e = _$setProp(_el$67, "style", _v$22, _p$.e));
            _v$23 !== _p$.t && (_p$.t = _$setProp(_el$69, "style", _v$23, _p$.t));
            _v$24 !== _p$.a && (_p$.a = _$setProp(_el$71, "style", _v$24, _p$.a));
            _v$25 !== _p$.o && (_p$.o = _$setProp(_el$74, "style", _v$25, _p$.o));
            _v$26 !== _p$.i && (_p$.i = _$setProp(_el$76, "style", _v$26, _p$.i));
            _v$27 !== _p$.n && (_p$.n = _$setProp(_el$78, "style", _v$27, _p$.n));
            _v$28 !== _p$.s && (_p$.s = _$setProp(_el$80, "style", _v$28, _p$.s));
            _v$29 !== _p$.h && (_p$.h = _$setProp(_el$82, "style", _v$29, _p$.h));
            _v$30 !== _p$.r && (_p$.r = _$setProp(_el$84, "style", _v$30, _p$.r));
            _v$31 !== _p$.d && (_p$.d = _$setProp(_el$86, "style", _v$31, _p$.d));
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
        return _$createComponent(For, {
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
              const ratio = runtime().turnCount / maxTurns;
              if (ratio >= 1)
                return theme().error;
              if (ratio >= 0.8)
                return theme().warning;
              return phaseColor(runtime().phase || "idle", theme());
            };
            return (() => {
              var _el$88 = _$createElement("box"), _el$89 = _$createElement("text"), _el$90 = _$createElement("span"), _el$91 = _$createElement("span"), _el$93 = _$createElement("span");
              _$insertNode(_el$88, _el$89);
              _$setProp(_el$88, "flexDirection", "row");
              _$setProp(_el$88, "paddingLeft", 1);
              _$setProp(_el$88, "paddingRight", 1);
              _$insertNode(_el$89, _el$90);
              _$insertNode(_el$89, _el$91);
              _$insertNode(_el$89, _el$93);
              _$insert(_el$90, (() => {
                var _c$2 = _$memo(() => !!isActive());
                return () => _c$2() ? `\u25B6 ${statusIcon(goal.status)} ${goal.name}` : `  ${statusIcon(goal.status)} ${goal.name}`;
              })());
              _$insertNode(_el$91, _$createTextNode(` \u2502 `));
              _$insert(_el$93, () => goal.status.toUpperCase());
              _$insert(_el$89, (() => {
                var _c$3 = _$memo(() => !!runtime());
                return () => _c$3() && [(() => {
                  var _el$94 = _$createElement("span");
                  _$insertNode(_el$94, _$createTextNode(` \u2502 `));
                  _$effect((_$p) => _$setProp(_el$94, "style", {
                    fg: theme().textMuted
                  }, _$p));
                  return _el$94;
                })(), (() => {
                  var _el$96 = _$createElement("span"), _el$97 = _$createTextNode(` `);
                  _$insertNode(_el$96, _el$97);
                  _$insert(_el$96, (() => {
                    var _c$6 = _$memo(() => runtime().phase === "running");
                    return () => _c$6() ? runningFrame() : phaseIcon(runtime().phase);
                  })(), _el$97);
                  _$insert(_el$96, () => runtime().phase.toUpperCase(), null);
                  _$effect((_$p) => _$setProp(_el$96, "style", {
                    fg: turnColor(),
                    bold: runtime().phase === "running"
                  }, _$p));
                  return _el$96;
                })(), (() => {
                  var _el$98 = _$createElement("span"), _el$99 = _$createTextNode(` `);
                  _$insertNode(_el$98, _el$99);
                  _$insert(_el$98, () => runtime().turnCount, null);
                  _$insert(_el$98, maxTurns ? `/${maxTurns}` : "", null);
                  _$effect((_$p) => _$setProp(_el$98, "style", {
                    fg: turnColor()
                  }, _$p));
                  return _el$98;
                })(), (() => {
                  var _el$100 = _$createElement("span"), _el$101 = _$createTextNode(` `);
                  _$insertNode(_el$100, _el$101);
                  _$insert(_el$100, () => ageLabel(runtime().lastProgressAt || runtime().lastRunAt, clock()), null);
                  _$effect((_$p) => _$setProp(_el$100, "style", {
                    fg: theme().textMuted
                  }, _$p));
                  return _el$100;
                })()];
              })(), null);
              _$insert(_el$89, (() => {
                var _c$4 = _$memo(() => !!(runtime() && runtime().consecutiveFailures > 0));
                return () => _c$4() && (() => {
                  var _el$102 = _$createElement("span"), _el$103 = _$createTextNode(` \u2502 \u26A0 `), _el$104 = _$createTextNode(` fail`);
                  _$insertNode(_el$102, _el$103);
                  _$insertNode(_el$102, _el$104);
                  _$insert(_el$102, () => runtime().consecutiveFailures, _el$104);
                  _$effect((_$p) => _$setProp(_el$102, "style", {
                    fg: theme().error,
                    bold: true
                  }, _$p));
                  return _el$102;
                })();
              })(), null);
              _$insert(_el$89, (() => {
                var _c$5 = _$memo(() => !!(runtime() && (runtime().noProgressCount || 0) > 0));
                return () => _c$5() && (() => {
                  var _el$105 = _$createElement("span"), _el$106 = _$createTextNode(` \u2502 `), _el$107 = _$createTextNode(` no-progress`);
                  _$insertNode(_el$105, _el$106);
                  _$insertNode(_el$105, _el$107);
                  _$insert(_el$105, () => runtime().noProgressCount, _el$107);
                  _$effect((_$p) => _$setProp(_el$105, "style", {
                    fg: theme().warning
                  }, _$p));
                  return _el$105;
                })();
              })(), null);
              _$effect((_p$) => {
                var _v$32 = isActive() ? theme().backgroundElement : undefined, _v$33 = {
                  fg: statusColor(goal.status, theme()),
                  bold: isActive()
                }, _v$34 = {
                  fg: theme().textMuted
                }, _v$35 = {
                  fg: statusColor(goal.status, theme()),
                  bold: true
                };
                _v$32 !== _p$.e && (_p$.e = _$setProp(_el$88, "backgroundColor", _v$32, _p$.e));
                _v$33 !== _p$.t && (_p$.t = _$setProp(_el$90, "style", _v$33, _p$.t));
                _v$34 !== _p$.a && (_p$.a = _$setProp(_el$91, "style", _v$34, _p$.a));
                _v$35 !== _p$.o && (_p$.o = _$setProp(_el$93, "style", _v$35, _p$.o));
                return _p$;
              }, {
                e: undefined,
                t: undefined,
                a: undefined,
                o: undefined
              });
              return _el$88;
            })();
          }
        });
      }
    }));
    _$insert(_el$29, _$createComponent(Show, {
      get when() {
        return selectedGoal();
      },
      children: (goal) => {
        const rt = () => state()?.runtimes.find((r) => r.goalID === goal().id);
        return (() => {
          var _el$108 = _$createElement("box"), _el$109 = _$createElement("text"), _el$110 = _$createElement("span"), _el$111 = _$createTextNode(` `), _el$112 = _$createElement("span"), _el$113 = _$createTextNode(` `), _el$114 = _$createTextNode(`
`), _el$115 = _$createElement("span");
          _$insertNode(_el$108, _el$109);
          _$setProp(_el$108, "flexDirection", "column");
          _$setProp(_el$108, "border", true);
          _$setProp(_el$108, "padding", 1);
          _$setProp(_el$108, "flexShrink", 0);
          _$setProp(_el$108, "maxHeight", 10);
          _$insertNode(_el$109, _el$110);
          _$insertNode(_el$109, _el$112);
          _$insertNode(_el$109, _el$114);
          _$insertNode(_el$109, _el$115);
          _$insertNode(_el$110, _el$111);
          _$insert(_el$110, () => statusIcon(goal().status), _el$111);
          _$insert(_el$110, () => goal().name, null);
          _$insertNode(_el$112, _el$113);
          _$insert(_el$112, () => goal().status.toUpperCase(), null);
          _$insert(_el$109, (() => {
            var _c$7 = _$memo(() => !!rt());
            return () => _c$7() && [(() => {
              var _el$116 = _$createElement("span");
              _$insertNode(_el$116, _$createTextNode(` \u2502 `));
              _$effect((_$p) => _$setProp(_el$116, "style", {
                fg: theme().textMuted
              }, _$p));
              return _el$116;
            })(), (() => {
              var _el$118 = _$createElement("span"), _el$119 = _$createTextNode(` `);
              _$insertNode(_el$118, _el$119);
              _$insert(_el$118, () => phaseIcon(rt().phase), _el$119);
              _$insert(_el$118, () => rt().phase, null);
              _$effect((_$p) => _$setProp(_el$118, "style", {
                fg: phaseColor(rt().phase, theme()),
                bold: true
              }, _$p));
              return _el$118;
            })(), (() => {
              var _el$120 = _$createElement("span"), _el$121 = _$createTextNode(` turn `);
              _$insertNode(_el$120, _el$121);
              _$insert(_el$120, () => rt().turnCount, null);
              _$effect((_$p) => _$setProp(_el$120, "style", {
                fg: theme().textMuted
              }, _$p));
              return _el$120;
            })()];
          })(), _el$114);
          _$insert(_el$115, () => goal().objective.slice(0, 160));
          _$insert(_el$109, (() => {
            var _c$8 = _$memo(() => !!goal().lastProgress);
            return () => _c$8() && [(() => {
              var _el$122 = _$createElement("span"), _el$123 = _$createTextNode(`
\u2714 `);
              _$insertNode(_el$122, _el$123);
              _$effect((_$p) => _$setProp(_el$122, "style", {
                fg: theme().success
              }, _$p));
              return _el$122;
            })(), (() => {
              var _el$125 = _$createElement("span");
              _$insert(_el$125, () => goal().lastProgress.summary.slice(0, 100));
              _$effect((_$p) => _$setProp(_el$125, "style", {
                fg: theme().text
              }, _$p));
              return _el$125;
            })(), (() => {
              var _el$126 = _$createElement("span"), _el$127 = _$createTextNode(` \u2192 `);
              _$insertNode(_el$126, _el$127);
              _$insert(_el$126, () => goal().lastProgress.next?.slice(0, 60) || "", null);
              _$effect((_$p) => _$setProp(_el$126, "style", {
                fg: theme().textMuted
              }, _$p));
              return _el$126;
            })()];
          })(), null);
          _$insert(_el$109, (() => {
            var _c$9 = _$memo(() => !!goal().blocker);
            return () => _c$9() && [(() => {
              var _el$128 = _$createElement("span"), _el$129 = _$createTextNode(`
\u2716 blocked: `);
              _$insertNode(_el$128, _el$129);
              _$effect((_$p) => _$setProp(_el$128, "style", {
                fg: theme().error,
                bold: true
              }, _$p));
              return _el$128;
            })(), (() => {
              var _el$131 = _$createElement("span");
              _$insert(_el$131, () => goal().blocker.reason.slice(0, 140));
              _$effect((_$p) => _$setProp(_el$131, "style", {
                fg: theme().error
              }, _$p));
              return _el$131;
            })(), (() => {
              var _el$132 = _$createElement("span"), _el$133 = _$createTextNode(` \u2014 `);
              _$insertNode(_el$132, _el$133);
              _$insert(_el$132, () => goal().blocker.needed.slice(0, 60), null);
              _$effect((_$p) => _$setProp(_el$132, "style", {
                fg: theme().textMuted
              }, _$p));
              return _el$132;
            })()];
          })(), null);
          _$insert(_el$109, (() => {
            var _c$0 = _$memo(() => !!goal().config.artifactDir);
            return () => _c$0() && [(() => {
              var _el$134 = _$createElement("span"), _el$135 = _$createTextNode(`
\uD83D\uDCC1 `);
              _$insertNode(_el$134, _el$135);
              _$effect((_$p) => _$setProp(_el$134, "style", {
                fg: theme().accent
              }, _$p));
              return _el$134;
            })(), (() => {
              var _el$137 = _$createElement("span");
              _$insert(_el$137, () => String(goal().config.artifactDir).replace(String(props.directory), "."));
              _$effect((_$p) => _$setProp(_el$137, "style", {
                fg: theme().textMuted
              }, _$p));
              return _el$137;
            })()];
          })(), null);
          _$insert(_el$109, (() => {
            var _c$1 = _$memo(() => !!rt()?.lastError);
            return () => _c$1() && [(() => {
              var _el$138 = _$createElement("span"), _el$139 = _$createTextNode(`
\u26A0 `);
              _$insertNode(_el$138, _el$139);
              _$effect((_$p) => _$setProp(_el$138, "style", {
                fg: theme().error
              }, _$p));
              return _el$138;
            })(), (() => {
              var _el$141 = _$createElement("span");
              _$insert(_el$141, () => rt().lastError.slice(0, 120));
              _$effect((_$p) => _$setProp(_el$141, "style", {
                fg: theme().error
              }, _$p));
              return _el$141;
            })()];
          })(), null);
          _$effect((_p$) => {
            var _v$36 = borderColorForStatus(goal().status, theme()), _v$37 = {
              fg: statusColor(goal().status, theme()),
              bold: true
            }, _v$38 = {
              fg: statusColor(goal().status, theme())
            }, _v$39 = {
              fg: theme().text
            };
            _v$36 !== _p$.e && (_p$.e = _$setProp(_el$108, "borderColor", _v$36, _p$.e));
            _v$37 !== _p$.t && (_p$.t = _$setProp(_el$110, "style", _v$37, _p$.t));
            _v$38 !== _p$.a && (_p$.a = _$setProp(_el$112, "style", _v$38, _p$.a));
            _v$39 !== _p$.o && (_p$.o = _$setProp(_el$115, "style", _v$39, _p$.o));
            return _p$;
          }, {
            e: undefined,
            t: undefined,
            a: undefined,
            o: undefined
          });
          return _el$108;
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
        _$insert(_el$35, _$createComponent(For, {
          get each() {
            return events().slice(-10);
          },
          children: (ev) => (() => {
            var _el$142 = _$createElement("text"), _el$143 = _$createElement("span"), _el$144 = _$createElement("span"), _el$145 = _$createTextNode(` `);
            _$insertNode(_el$142, _el$143);
            _$insertNode(_el$142, _el$144);
            _$insert(_el$143, () => String(ev.type));
            _$insertNode(_el$144, _el$145);
            _$insert(_el$144, () => ev.goalID?.slice(0, 8), null);
            _$insert(_el$142, (() => {
              var _c$10 = _$memo(() => !!ev.summary);
              return () => _c$10() && (() => {
                var _el$146 = _$createElement("span"), _el$147 = _$createTextNode(` \u2014 `);
                _$insertNode(_el$146, _el$147);
                _$insert(_el$146, () => String(ev.summary).slice(0, 60), null);
                _$effect((_$p) => _$setProp(_el$146, "style", {
                  fg: theme().text
                }, _$p));
                return _el$146;
              })();
            })(), null);
            _$effect((_p$) => {
              var _v$40 = {
                fg: eventColor(String(ev.type), theme()),
                bold: true
              }, _v$41 = {
                fg: theme().textMuted
              };
              _v$40 !== _p$.e && (_p$.e = _$setProp(_el$143, "style", _v$40, _p$.e));
              _v$41 !== _p$.t && (_p$.t = _$setProp(_el$144, "style", _v$41, _p$.t));
              return _p$;
            }, {
              e: undefined,
              t: undefined
            });
            return _el$142;
          })()
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
      if (name === "return" || name === "enter") {
        prevent(evt);
        debugLog("input enter -> execute");
        executeCommand(commandInput());
        return;
      }
      if (evt.ctrl && name.toLowerCase() === "n") {
        prevent(evt);
        debugLog("input ctrl+n -> normal");
        returnToNormalMode();
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
      }, _v$14 = {
        fg: theme().error,
        bold: true
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
      _v$13 !== _p$.u && (_p$.u = _$setProp(_el$23, "style", _v$13, _p$.u));
      _v$14 !== _p$.c && (_p$.c = _$setProp(_el$27, "style", _v$14, _p$.c));
      _v$15 !== _p$.w && (_p$.w = _$setProp(_el$41, "borderColor", _v$15, _p$.w));
      _v$16 !== _p$.m && (_p$.m = _$setProp(_el$43, "style", _v$16, _p$.m));
      _v$17 !== _p$.f && (_p$.f = _$setProp(_el$44, "placeholder", _v$17, _p$.f));
      _v$18 !== _p$.y && (_p$.y = _$setProp(_el$44, "placeholderColor", _v$18, _p$.y));
      _v$19 !== _p$.g && (_p$.g = _$setProp(_el$44, "cursorColor", _v$19, _p$.g));
      _v$20 !== _p$.p && (_p$.p = _$setProp(_el$44, "focusedTextColor", _v$20, _p$.p));
      _v$21 !== _p$.b && (_p$.b = _$setProp(_el$44, "focusedBackgroundColor", _v$21, _p$.b));
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
      key: "<leader>d",
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

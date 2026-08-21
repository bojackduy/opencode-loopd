// @bun
var __require = import.meta.require;

// src/tui/plugin.tsx
import { createComponent as _$createComponent2 } from "@opentui/solid";

// src/tui/dashboard.tsx
import { use as _$use } from "@opentui/solid";
import { effect as _$effect } from "@opentui/solid";
import { createComponent as _$createComponent } from "@opentui/solid";
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
    "Modes: : insert \u2192 send/commands, Ctrl+N \u2192 normal, ? toggle help",
    "Nav: j/k move \u2502 g/G top/bottom \u2502 o open child \u2502 p/r/R/x pause/resume/retry/clear \u2502 L logs \u2502 q close",
    "Commands (insert mode, : prefix):",
    "  :send <message>                           Send instruction to selected goal",
    "  :open                                     Open child session (same as o)",
    "  :force <summary> --evidence <text>        Force-complete (bypass checks)",
    "  :block <reason> --needed <text>           Force-block the selected goal",
    "  :pause / :resume / :retry / :clear        Quick controls (also p/r/R/x)",
    "  :logs / :help / :q                        Toggle logs / help / close",
    "  Tip: create goals via /goal in the parent chat (agent clarifies first)."
  ].join(`
`);
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
  createEffect(() => setSelectedGoal(activeGoals()[selected()] || null));
  return (() => {
    var _el$ = _$createElement("box"), _el$2 = _$createElement("box"), _el$3 = _$createElement("box"), _el$4 = _$createElement("text"), _el$5 = _$createElement("span"), _el$7 = _$createElement("span"), _el$9 = _$createElement("span"), _el$0 = _$createTextNode(` `), _el$1 = _$createTextNode(` `), _el$10 = _$createElement("span"), _el$12 = _$createElement("span"), _el$13 = _$createElement("span"), _el$15 = _$createElement("span"), _el$17 = _$createElement("span"), _el$18 = _$createTextNode(` `), _el$19 = _$createTextNode(` RUNNING`), _el$20 = _$createElement("span"), _el$22 = _$createElement("span"), _el$23 = _$createElement("span"), _el$25 = _$createElement("box"), _el$30 = _$createElement("box"), _el$37 = _$createElement("box"), _el$38 = _$createElement("text"), _el$39 = _$createElement("span"), _el$40 = _$createElement("input");
    _$insertNode(_el$, _el$2);
    _$setProp(_el$, "flexDirection", "column");
    _$setProp(_el$, "width", "100%");
    _$setProp(_el$, "alignItems", "center");
    _$setProp(_el$, "padding", 1);
    _$insertNode(_el$2, _el$3);
    _$insertNode(_el$2, _el$25);
    _$insertNode(_el$2, _el$37);
    _$setProp(_el$2, "flexDirection", "column");
    _$setProp(_el$2, "width", "90%");
    _$setProp(_el$2, "border", true);
    _$setProp(_el$2, "padding", 1);
    _$insertNode(_el$3, _el$4);
    _$setProp(_el$3, "flexDirection", "row");
    _$setProp(_el$3, "padding", 0);
    _$setProp(_el$3, "flexShrink", 0);
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
    _$insertNode(_el$25, _el$30);
    _$setProp(_el$25, "flexDirection", "column");
    _$setProp(_el$25, "flexGrow", 1);
    _$setProp(_el$25, "minHeight", 0);
    _$setProp(_el$25, "overflow", "hidden");
    _$insert(_el$25, _$createComponent(Show, {
      get when() {
        return showHelp();
      },
      get children() {
        var _el$26 = _$createElement("box"), _el$27 = _$createElement("text"), _el$28 = _$createElement("span");
        _$insertNode(_el$26, _el$27);
        _$setProp(_el$26, "flexDirection", "column");
        _$setProp(_el$26, "padding", 1);
        _$setProp(_el$26, "border", true);
        _$setProp(_el$26, "borderColor", "yellow");
        _$setProp(_el$26, "flexShrink", 0);
        _$setProp(_el$26, "maxHeight", 14);
        _$setProp(_el$26, "overflow", "hidden");
        _$insertNode(_el$27, _el$28);
        _$insertNode(_el$28, _$createTextNode(`\u2501\u2501\u2501 Keys: ? toggle : insert Ctrl+N normal o open q close \u2501\u2501\u2501`));
        _$setProp(_el$28, "style", {
          fg: "yellow",
          bold: true
        });
        _$insert(_el$27, _$createComponent(For, {
          get each() {
            return commandHelp().split(`
`);
          },
          children: (line) => {
            const isHeader = line.startsWith("Modes:") || line.startsWith("Nav:") || line.startsWith("Commands");
            const isCmd = line.trim().startsWith(":");
            return [`
`, (() => {
              var _el$41 = _$createElement("span");
              _$insert(_el$41, line);
              _$effect((_$p) => _$setProp(_el$41, "style", {
                fg: isHeader ? theme().primary : isCmd ? theme().warning : theme().text,
                bold: isHeader
              }, _$p));
              return _el$41;
            })()];
          }
        }), null);
        _$effect((_$p) => _$setProp(_el$26, "backgroundColor", theme().background, _$p));
        return _el$26;
      }
    }), _el$30);
    _$setProp(_el$30, "flexDirection", "column");
    _$setProp(_el$30, "flexGrow", 1);
    _$setProp(_el$30, "padding", 1);
    _$setProp(_el$30, "minHeight", 0);
    _$setProp(_el$30, "overflow", "hidden");
    _$insert(_el$30, _$createComponent(Show, {
      get when() {
        return activeGoals().length > 0;
      },
      get fallback() {
        return (() => {
          var _el$42 = _$createElement("box"), _el$43 = _$createElement("text"), _el$44 = _$createElement("span"), _el$46 = _$createElement("span"), _el$48 = _$createElement("span"), _el$50 = _$createElement("text"), _el$51 = _$createElement("span"), _el$53 = _$createElement("span"), _el$55 = _$createElement("span"), _el$57 = _$createElement("span"), _el$59 = _$createElement("span"), _el$61 = _$createElement("span"), _el$63 = _$createElement("span");
          _$insertNode(_el$42, _el$43);
          _$insertNode(_el$42, _el$50);
          _$setProp(_el$42, "flexDirection", "column");
          _$setProp(_el$42, "gap", 1);
          _$insertNode(_el$43, _el$44);
          _$insertNode(_el$43, _el$46);
          _$insertNode(_el$43, _el$48);
          _$insertNode(_el$44, _$createTextNode(`No active goals.`));
          _$insertNode(_el$46, _$createTextNode(` /goal`));
          _$insertNode(_el$48, _$createTextNode(` in parent chat to create one.`));
          _$insertNode(_el$50, _el$51);
          _$insertNode(_el$50, _el$53);
          _$insertNode(_el$50, _el$55);
          _$insertNode(_el$50, _el$57);
          _$insertNode(_el$50, _el$59);
          _$insertNode(_el$50, _el$61);
          _$insertNode(_el$50, _el$63);
          _$insertNode(_el$51, _$createTextNode(`Tip: `));
          _$insertNode(_el$53, _$createTextNode(`:send`));
          _$insertNode(_el$55, _$createTextNode(` to steer the worker \xB7 `));
          _$insertNode(_el$57, _$createTextNode(`o`));
          _$insertNode(_el$59, _$createTextNode(` to open child \xB7 `));
          _$insertNode(_el$61, _$createTextNode(`:force`));
          _$insertNode(_el$63, _$createTextNode(` to complete manually.`));
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
            _v$21 !== _p$.e && (_p$.e = _$setProp(_el$44, "style", _v$21, _p$.e));
            _v$22 !== _p$.t && (_p$.t = _$setProp(_el$46, "style", _v$22, _p$.t));
            _v$23 !== _p$.a && (_p$.a = _$setProp(_el$48, "style", _v$23, _p$.a));
            _v$24 !== _p$.o && (_p$.o = _$setProp(_el$51, "style", _v$24, _p$.o));
            _v$25 !== _p$.i && (_p$.i = _$setProp(_el$53, "style", _v$25, _p$.i));
            _v$26 !== _p$.n && (_p$.n = _$setProp(_el$55, "style", _v$26, _p$.n));
            _v$27 !== _p$.s && (_p$.s = _$setProp(_el$57, "style", _v$27, _p$.s));
            _v$28 !== _p$.h && (_p$.h = _$setProp(_el$59, "style", _v$28, _p$.h));
            _v$29 !== _p$.r && (_p$.r = _$setProp(_el$61, "style", _v$29, _p$.r));
            _v$30 !== _p$.d && (_p$.d = _$setProp(_el$63, "style", _v$30, _p$.d));
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
          return _el$42;
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
              var _el$65 = _$createElement("box"), _el$66 = _$createElement("text"), _el$67 = _$createElement("span"), _el$68 = _$createElement("span"), _el$70 = _$createElement("span");
              _$insertNode(_el$65, _el$66);
              _$setProp(_el$65, "flexDirection", "row");
              _$setProp(_el$65, "paddingLeft", 1);
              _$setProp(_el$65, "paddingRight", 1);
              _$insertNode(_el$66, _el$67);
              _$insertNode(_el$66, _el$68);
              _$insertNode(_el$66, _el$70);
              _$insert(_el$67, (() => {
                var _c$2 = _$memo(() => !!isActive());
                return () => _c$2() ? `\u25B6 ${statusIcon(goal.status)} ${goal.name}` : `  ${statusIcon(goal.status)} ${goal.name}`;
              })());
              _$insertNode(_el$68, _$createTextNode(` \u2502 `));
              _$insert(_el$70, () => goal.status.toUpperCase());
              _$insert(_el$66, (() => {
                var _c$3 = _$memo(() => !!runtime());
                return () => _c$3() && [(() => {
                  var _el$71 = _$createElement("span");
                  _$insertNode(_el$71, _$createTextNode(` \u2502 `));
                  _$effect((_$p) => _$setProp(_el$71, "style", {
                    fg: theme().textMuted
                  }, _$p));
                  return _el$71;
                })(), (() => {
                  var _el$73 = _$createElement("span"), _el$74 = _$createTextNode(` `);
                  _$insertNode(_el$73, _el$74);
                  _$insert(_el$73, (() => {
                    var _c$6 = _$memo(() => runtime().phase === "running");
                    return () => _c$6() ? runningFrame() : phaseIcon(runtime().phase);
                  })(), _el$74);
                  _$insert(_el$73, () => runtime().phase.toUpperCase(), null);
                  _$effect((_$p) => _$setProp(_el$73, "style", {
                    fg: turnColor(),
                    bold: runtime().phase === "running"
                  }, _$p));
                  return _el$73;
                })(), (() => {
                  var _el$75 = _$createElement("span"), _el$76 = _$createTextNode(` `);
                  _$insertNode(_el$75, _el$76);
                  _$insert(_el$75, () => runtime().turnCount, null);
                  _$insert(_el$75, maxTurns ? `/${maxTurns}` : "", null);
                  _$effect((_$p) => _$setProp(_el$75, "style", {
                    fg: turnColor()
                  }, _$p));
                  return _el$75;
                })(), (() => {
                  var _el$77 = _$createElement("span"), _el$78 = _$createTextNode(` `);
                  _$insertNode(_el$77, _el$78);
                  _$insert(_el$77, () => ageLabel(runtime().lastProgressAt || runtime().lastRunAt, clock()), null);
                  _$effect((_$p) => _$setProp(_el$77, "style", {
                    fg: theme().textMuted
                  }, _$p));
                  return _el$77;
                })()];
              })(), null);
              _$insert(_el$66, (() => {
                var _c$4 = _$memo(() => !!(runtime() && runtime().consecutiveFailures > 0));
                return () => _c$4() && (() => {
                  var _el$79 = _$createElement("span"), _el$80 = _$createTextNode(` \u2502 \u26A0 `), _el$81 = _$createTextNode(` fail`);
                  _$insertNode(_el$79, _el$80);
                  _$insertNode(_el$79, _el$81);
                  _$insert(_el$79, () => runtime().consecutiveFailures, _el$81);
                  _$effect((_$p) => _$setProp(_el$79, "style", {
                    fg: theme().error,
                    bold: true
                  }, _$p));
                  return _el$79;
                })();
              })(), null);
              _$insert(_el$66, (() => {
                var _c$5 = _$memo(() => !!(runtime() && (runtime().noProgressCount || 0) > 0));
                return () => _c$5() && (() => {
                  var _el$82 = _$createElement("span"), _el$83 = _$createTextNode(` \u2502 `), _el$84 = _$createTextNode(` no-progress`);
                  _$insertNode(_el$82, _el$83);
                  _$insertNode(_el$82, _el$84);
                  _$insert(_el$82, () => runtime().noProgressCount, _el$84);
                  _$effect((_$p) => _$setProp(_el$82, "style", {
                    fg: theme().warning
                  }, _$p));
                  return _el$82;
                })();
              })(), null);
              _$effect((_p$) => {
                var _v$31 = isActive() ? theme().backgroundElement : undefined, _v$32 = {
                  fg: statusColor(goal.status, theme()),
                  bold: isActive()
                }, _v$33 = {
                  fg: theme().textMuted
                }, _v$34 = {
                  fg: statusColor(goal.status, theme()),
                  bold: true
                };
                _v$31 !== _p$.e && (_p$.e = _$setProp(_el$65, "backgroundColor", _v$31, _p$.e));
                _v$32 !== _p$.t && (_p$.t = _$setProp(_el$67, "style", _v$32, _p$.t));
                _v$33 !== _p$.a && (_p$.a = _$setProp(_el$68, "style", _v$33, _p$.a));
                _v$34 !== _p$.o && (_p$.o = _$setProp(_el$70, "style", _v$34, _p$.o));
                return _p$;
              }, {
                e: undefined,
                t: undefined,
                a: undefined,
                o: undefined
              });
              return _el$65;
            })();
          }
        });
      }
    }));
    _$insert(_el$25, _$createComponent(Show, {
      get when() {
        return selectedGoal();
      },
      children: (goal) => {
        const rt = () => state()?.runtimes.find((r) => r.goalID === goal().id);
        return (() => {
          var _el$85 = _$createElement("box"), _el$86 = _$createElement("text"), _el$87 = _$createElement("span"), _el$88 = _$createTextNode(` `), _el$89 = _$createElement("span"), _el$90 = _$createTextNode(` `), _el$91 = _$createTextNode(`
`), _el$92 = _$createElement("span");
          _$insertNode(_el$85, _el$86);
          _$setProp(_el$85, "flexDirection", "column");
          _$setProp(_el$85, "border", true);
          _$setProp(_el$85, "padding", 1);
          _$setProp(_el$85, "flexShrink", 0);
          _$setProp(_el$85, "maxHeight", 10);
          _$insertNode(_el$86, _el$87);
          _$insertNode(_el$86, _el$89);
          _$insertNode(_el$86, _el$91);
          _$insertNode(_el$86, _el$92);
          _$insertNode(_el$87, _el$88);
          _$insert(_el$87, () => statusIcon(goal().status), _el$88);
          _$insert(_el$87, () => goal().name, null);
          _$insertNode(_el$89, _el$90);
          _$insert(_el$89, () => goal().status.toUpperCase(), null);
          _$insert(_el$86, (() => {
            var _c$7 = _$memo(() => !!rt());
            return () => _c$7() && [(() => {
              var _el$93 = _$createElement("span");
              _$insertNode(_el$93, _$createTextNode(` \u2502 `));
              _$effect((_$p) => _$setProp(_el$93, "style", {
                fg: theme().textMuted
              }, _$p));
              return _el$93;
            })(), (() => {
              var _el$95 = _$createElement("span"), _el$96 = _$createTextNode(` `);
              _$insertNode(_el$95, _el$96);
              _$insert(_el$95, () => phaseIcon(rt().phase), _el$96);
              _$insert(_el$95, () => rt().phase, null);
              _$effect((_$p) => _$setProp(_el$95, "style", {
                fg: phaseColor(rt().phase, theme()),
                bold: true
              }, _$p));
              return _el$95;
            })(), (() => {
              var _el$97 = _$createElement("span"), _el$98 = _$createTextNode(` turn `);
              _$insertNode(_el$97, _el$98);
              _$insert(_el$97, () => rt().turnCount, null);
              _$effect((_$p) => _$setProp(_el$97, "style", {
                fg: theme().textMuted
              }, _$p));
              return _el$97;
            })()];
          })(), _el$91);
          _$insert(_el$92, () => goal().objective.slice(0, 160));
          _$insert(_el$86, (() => {
            var _c$8 = _$memo(() => !!goal().lastProgress);
            return () => _c$8() && [(() => {
              var _el$99 = _$createElement("span"), _el$100 = _$createTextNode(`
\u2714 `);
              _$insertNode(_el$99, _el$100);
              _$effect((_$p) => _$setProp(_el$99, "style", {
                fg: theme().success
              }, _$p));
              return _el$99;
            })(), (() => {
              var _el$102 = _$createElement("span");
              _$insert(_el$102, () => goal().lastProgress.summary.slice(0, 100));
              _$effect((_$p) => _$setProp(_el$102, "style", {
                fg: theme().text
              }, _$p));
              return _el$102;
            })(), (() => {
              var _el$103 = _$createElement("span"), _el$104 = _$createTextNode(` \u2192 `);
              _$insertNode(_el$103, _el$104);
              _$insert(_el$103, () => goal().lastProgress.next?.slice(0, 60) || "", null);
              _$effect((_$p) => _$setProp(_el$103, "style", {
                fg: theme().textMuted
              }, _$p));
              return _el$103;
            })()];
          })(), null);
          _$insert(_el$86, (() => {
            var _c$9 = _$memo(() => !!goal().blocker);
            return () => _c$9() && [(() => {
              var _el$105 = _$createElement("span"), _el$106 = _$createTextNode(`
\u2716 blocked: `);
              _$insertNode(_el$105, _el$106);
              _$effect((_$p) => _$setProp(_el$105, "style", {
                fg: theme().error,
                bold: true
              }, _$p));
              return _el$105;
            })(), (() => {
              var _el$108 = _$createElement("span");
              _$insert(_el$108, () => goal().blocker.reason.slice(0, 140));
              _$effect((_$p) => _$setProp(_el$108, "style", {
                fg: theme().error
              }, _$p));
              return _el$108;
            })(), (() => {
              var _el$109 = _$createElement("span"), _el$110 = _$createTextNode(` \u2014 `);
              _$insertNode(_el$109, _el$110);
              _$insert(_el$109, () => goal().blocker.needed.slice(0, 60), null);
              _$effect((_$p) => _$setProp(_el$109, "style", {
                fg: theme().textMuted
              }, _$p));
              return _el$109;
            })()];
          })(), null);
          _$insert(_el$86, (() => {
            var _c$0 = _$memo(() => !!goal().config.artifactDir);
            return () => _c$0() && [(() => {
              var _el$111 = _$createElement("span"), _el$112 = _$createTextNode(`
\uD83D\uDCC1 `);
              _$insertNode(_el$111, _el$112);
              _$effect((_$p) => _$setProp(_el$111, "style", {
                fg: theme().accent
              }, _$p));
              return _el$111;
            })(), (() => {
              var _el$114 = _$createElement("span");
              _$insert(_el$114, () => String(goal().config.artifactDir).replace(String(props.directory), "."));
              _$effect((_$p) => _$setProp(_el$114, "style", {
                fg: theme().textMuted
              }, _$p));
              return _el$114;
            })()];
          })(), null);
          _$insert(_el$86, (() => {
            var _c$1 = _$memo(() => !!rt()?.lastError);
            return () => _c$1() && [(() => {
              var _el$115 = _$createElement("span"), _el$116 = _$createTextNode(`
\u26A0 `);
              _$insertNode(_el$115, _el$116);
              _$effect((_$p) => _$setProp(_el$115, "style", {
                fg: theme().error
              }, _$p));
              return _el$115;
            })(), (() => {
              var _el$118 = _$createElement("span");
              _$insert(_el$118, () => rt().lastError.slice(0, 120));
              _$effect((_$p) => _$setProp(_el$118, "style", {
                fg: theme().error
              }, _$p));
              return _el$118;
            })()];
          })(), null);
          _$effect((_p$) => {
            var _v$35 = borderColorForStatus(goal().status, theme()), _v$36 = {
              fg: statusColor(goal().status, theme()),
              bold: true
            }, _v$37 = {
              fg: statusColor(goal().status, theme())
            }, _v$38 = {
              fg: theme().text
            };
            _v$35 !== _p$.e && (_p$.e = _$setProp(_el$85, "borderColor", _v$35, _p$.e));
            _v$36 !== _p$.t && (_p$.t = _$setProp(_el$87, "style", _v$36, _p$.t));
            _v$37 !== _p$.a && (_p$.a = _$setProp(_el$89, "style", _v$37, _p$.a));
            _v$38 !== _p$.o && (_p$.o = _$setProp(_el$92, "style", _v$38, _p$.o));
            return _p$;
          }, {
            e: undefined,
            t: undefined,
            a: undefined,
            o: undefined
          });
          return _el$85;
        })();
      }
    }), null);
    _$insert(_el$25, _$createComponent(Show, {
      get when() {
        return _$memo(() => !!showLogs())() && events().length > 0;
      },
      get children() {
        var _el$31 = _$createElement("box"), _el$32 = _$createElement("text"), _el$33 = _$createElement("span"), _el$35 = _$createElement("span");
        _$insertNode(_el$31, _el$32);
        _$setProp(_el$31, "flexDirection", "column");
        _$setProp(_el$31, "border", true);
        _$setProp(_el$31, "padding", 1);
        _$setProp(_el$31, "maxHeight", 7);
        _$setProp(_el$31, "flexShrink", 0);
        _$setProp(_el$31, "overflow", "hidden");
        _$insertNode(_el$32, _el$33);
        _$insertNode(_el$32, _el$35);
        _$insertNode(_el$33, _$createTextNode(`\u25C8 Recent Events`));
        _$insertNode(_el$35, _$createTextNode(` \u2014 :logs to hide`));
        _$insert(_el$31, _$createComponent(For, {
          get each() {
            return events().slice(-10);
          },
          children: (ev) => (() => {
            var _el$119 = _$createElement("text"), _el$120 = _$createElement("span"), _el$121 = _$createElement("span"), _el$122 = _$createTextNode(` `);
            _$insertNode(_el$119, _el$120);
            _$insertNode(_el$119, _el$121);
            _$insert(_el$120, () => String(ev.type));
            _$insertNode(_el$121, _el$122);
            _$insert(_el$121, () => ev.goalID?.slice(0, 8), null);
            _$insert(_el$119, (() => {
              var _c$10 = _$memo(() => !!ev.summary);
              return () => _c$10() && (() => {
                var _el$123 = _$createElement("span"), _el$124 = _$createTextNode(` \u2014 `);
                _$insertNode(_el$123, _el$124);
                _$insert(_el$123, () => String(ev.summary).slice(0, 60), null);
                _$effect((_$p) => _$setProp(_el$123, "style", {
                  fg: theme().text
                }, _$p));
                return _el$123;
              })();
            })(), null);
            _$effect((_p$) => {
              var _v$39 = {
                fg: eventColor(String(ev.type), theme()),
                bold: true
              }, _v$40 = {
                fg: theme().textMuted
              };
              _v$39 !== _p$.e && (_p$.e = _$setProp(_el$120, "style", _v$39, _p$.e));
              _v$40 !== _p$.t && (_p$.t = _$setProp(_el$121, "style", _v$40, _p$.t));
              return _p$;
            }, {
              e: undefined,
              t: undefined
            });
            return _el$119;
          })()
        }), null);
        _$effect((_p$) => {
          var _v$ = theme().border, _v$2 = {
            fg: theme().accent,
            bold: true
          }, _v$3 = {
            fg: theme().textMuted
          };
          _v$ !== _p$.e && (_p$.e = _$setProp(_el$31, "borderColor", _v$, _p$.e));
          _v$2 !== _p$.t && (_p$.t = _$setProp(_el$33, "style", _v$2, _p$.t));
          _v$3 !== _p$.a && (_p$.a = _$setProp(_el$35, "style", _v$3, _p$.a));
          return _p$;
        }, {
          e: undefined,
          t: undefined,
          a: undefined
        });
        return _el$31;
      }
    }), null);
    _$insertNode(_el$37, _el$38);
    _$insertNode(_el$37, _el$40);
    _$setProp(_el$37, "flexDirection", "row");
    _$setProp(_el$37, "border", true);
    _$setProp(_el$37, "paddingLeft", 1);
    _$setProp(_el$37, "paddingRight", 1);
    _$setProp(_el$37, "flexShrink", 0);
    _$setProp(_el$37, "height", 3);
    _$setProp(_el$37, "gap", 1);
    _$insertNode(_el$38, _el$39);
    _$insert(_el$39, () => mode() === "insert" ? " INSERT \uE0B1" : " NORMAL ");
    _$use((el) => {
      inputEl = el;
      focusInput();
    }, _el$40);
    _$setProp(_el$40, "flexGrow", 1);
    _$setProp(_el$40, "onInput", (v) => {
      debugLog("onInput", JSON.stringify(v), "mode", mode());
      if (mode() === "insert")
        setCommandInput(v);
      else if (inputEl?.value)
        inputEl.value = "";
    });
    _$setProp(_el$40, "onKeyDown", (evt) => {
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
      _v$14 !== _p$.c && (_p$.c = _$setProp(_el$37, "borderColor", _v$14, _p$.c));
      _v$15 !== _p$.w && (_p$.w = _$setProp(_el$39, "style", _v$15, _p$.w));
      _v$16 !== _p$.m && (_p$.m = _$setProp(_el$40, "placeholder", _v$16, _p$.m));
      _v$17 !== _p$.f && (_p$.f = _$setProp(_el$40, "placeholderColor", _v$17, _p$.f));
      _v$18 !== _p$.y && (_p$.y = _$setProp(_el$40, "cursorColor", _v$18, _p$.y));
      _v$19 !== _p$.g && (_p$.g = _$setProp(_el$40, "focusedTextColor", _v$19, _p$.g));
      _v$20 !== _p$.p && (_p$.p = _$setProp(_el$40, "focusedBackgroundColor", _v$20, _p$.p));
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
      key: "ctrl+l",
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

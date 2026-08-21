// @bun
var __require = import.meta.require;

// src/tui/plugin.tsx
import { createComponent as _$createComponent2 } from "@opentui/solid";

// src/tui/dashboard.tsx
import { use as _$use } from "@opentui/solid";
import { createComponent as _$createComponent } from "@opentui/solid";
import { effect as _$effect } from "@opentui/solid";
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
    "Modes: : insert, Ctrl+N normal, ? toggle help",
    "Navigation: j/k move, g/G top/bottom, o open child, L toggle logs",
    "Commands:",
    '  :goal start <name> --objective "<text>"  Create a new goal',
    "  :pause                                    Pause the selected goal",
    "  :resume                                   Resume the selected goal",
    "  :retry                                    Retry the blocked goal",
    "  :clear                                    Clear the selected goal",
    "  :answer <text>                            Answer worker's question",
    "  :logs                                     Toggle log view",
    "  :help                                     Show this help",
    "  :q / :close                               Close dashboard"
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
    case "awaiting_user":
      return theme.warning;
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
    case "awaiting_user":
      return "?";
    case "complete":
      return "\u2713";
    case "budget_limited":
      return "$";
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
  const [statusText, setStatusText] = createSignal("Press : to insert, ? help, x:clear, q close");
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
    const route = props.api.route.current;
    const ownerSessionID = route.name === "session" ? route.params?.sessionID : undefined;
    try {
      switch (parsed.command) {
        case "goal": {
          if (parsed.positional[0] === "start") {
            if (!ownerSessionID) {
              setStatusText("Error: open /loop from an active session before starting a goal");
              break;
            }
            const name = parsed.positional[1] || parsed.args.name || "unnamed";
            const objective = parsed.args.objective || parsed.positional[2] || "";
            const r = await client.execute({
              version: 1,
              requestID: randomUUID(),
              requestedAt: new Date().toISOString(),
              command: "start",
              args: {
                name,
                objective,
                config: {},
                ownerSessionID
              }
            });
            setStatusText(r.ok ? r.message : `Error: ${r.message}`);
            if (r.ok)
              await refresh();
          } else
            setStatusText("Usage: :goal start <name> --objective <text>");
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
        case "answer": {
          if (!selectedGoal()) {
            setStatusText("No goal");
            break;
          }
          const answerText = parsed.positional.join(" ") || parsed.args.text || "";
          if (!answerText) {
            setStatusText("Usage: :answer <your response>");
            break;
          }
          const r = await client.execute({
            version: 1,
            requestID: randomUUID(),
            requestedAt: new Date().toISOString(),
            command: "answer",
            goalID: selectedGoal().id,
            args: {
              answer: answerText
            }
          });
          setStatusText(r.ok ? r.message : `Error: ${r.message}`);
          if (r.ok)
            await refresh();
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
        default:
          setStatusText(`Unknown: ${parsed.command}. ? for help`);
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
    var _el$ = _$createElement("box"), _el$2 = _$createElement("box"), _el$3 = _$createElement("box"), _el$4 = _$createElement("text"), _el$6 = _$createElement("text"), _el$8 = _$createElement("text"), _el$9 = _$createElement("text"), _el$1 = _$createElement("text"), _el$10 = _$createElement("text"), _el$12 = _$createElement("text"), _el$13 = _$createTextNode(` `), _el$14 = _$createTextNode(` RUNNING`), _el$15 = _$createElement("text"), _el$17 = _$createElement("text"), _el$18 = _$createElement("box"), _el$23 = _$createElement("box"), _el$27 = _$createElement("box"), _el$28 = _$createElement("text"), _el$29 = _$createElement("input");
    _$insertNode(_el$, _el$2);
    _$setProp(_el$, "flexDirection", "column");
    _$setProp(_el$, "width", "100%");
    _$setProp(_el$, "alignItems", "center");
    _$setProp(_el$, "padding", 1);
    _$insertNode(_el$2, _el$3);
    _$insertNode(_el$2, _el$18);
    _$insertNode(_el$2, _el$27);
    _$setProp(_el$2, "flexDirection", "column");
    _$setProp(_el$2, "width", "90%");
    _$setProp(_el$2, "border", true);
    _$setProp(_el$2, "borderColor", "gray");
    _$setProp(_el$2, "padding", 1);
    _$insertNode(_el$3, _el$4);
    _$insertNode(_el$3, _el$6);
    _$insertNode(_el$3, _el$8);
    _$insertNode(_el$3, _el$9);
    _$insertNode(_el$3, _el$1);
    _$insertNode(_el$3, _el$10);
    _$insertNode(_el$3, _el$12);
    _$insertNode(_el$3, _el$15);
    _$insertNode(_el$3, _el$17);
    _$setProp(_el$3, "flexDirection", "row");
    _$setProp(_el$3, "padding", 0);
    _$setProp(_el$3, "flexShrink", 0);
    _$insertNode(_el$4, _$createTextNode(`Loop Dashboard`));
    _$setProp(_el$4, "bold", true);
    _$insertNode(_el$6, _$createTextNode(` \u2502 `));
    _$insert(_el$8, () => mode().toUpperCase());
    _$insertNode(_el$9, _$createTextNode(` \u2502 goals: `));
    _$insert(_el$1, () => activeGoals().length);
    _$insertNode(_el$10, _$createTextNode(` \u2502 `));
    _$insertNode(_el$12, _el$13);
    _$insertNode(_el$12, _el$14);
    _$insert(_el$12, (() => {
      var _c$ = _$memo(() => runningCount() > 0);
      return () => _c$() ? runningFrame() : "\u25CB";
    })(), _el$13);
    _$insert(_el$12, runningCount, _el$14);
    _$insertNode(_el$15, _$createTextNode(` \u2502 verified: `));
    _$insert(_el$17, () => state()?.goals.filter((g) => g.status === "complete").length || 0);
    _$insertNode(_el$18, _el$23);
    _$setProp(_el$18, "flexDirection", "column");
    _$setProp(_el$18, "flexGrow", 1);
    _$setProp(_el$18, "minHeight", 0);
    _$setProp(_el$18, "overflow", "hidden");
    _$insert(_el$18, _$createComponent(Show, {
      get when() {
        return showHelp();
      },
      get children() {
        var _el$19 = _$createElement("box"), _el$20 = _$createElement("text"), _el$22 = _$createElement("text");
        _$insertNode(_el$19, _el$20);
        _$insertNode(_el$19, _el$22);
        _$setProp(_el$19, "flexDirection", "column");
        _$setProp(_el$19, "padding", 1);
        _$setProp(_el$19, "border", true);
        _$setProp(_el$19, "borderColor", "yellow");
        _$setProp(_el$19, "flexShrink", 0);
        _$setProp(_el$19, "maxHeight", 12);
        _$setProp(_el$19, "overflow", "hidden");
        _$insertNode(_el$20, _$createTextNode(`\u2501\u2501\u2501 Keyboard Shortcuts \u2014 ? toggle, : insert, Ctrl+N normal \u2501\u2501\u2501`));
        _$setProp(_el$20, "fg", "yellow");
        _$setProp(_el$20, "bold", true);
        _$insert(_el$22, commandHelp);
        _$effect((_p$) => {
          var _v$ = theme().background, _v$2 = theme().text;
          _v$ !== _p$.e && (_p$.e = _$setProp(_el$19, "backgroundColor", _v$, _p$.e));
          _v$2 !== _p$.t && (_p$.t = _$setProp(_el$22, "fg", _v$2, _p$.t));
          return _p$;
        }, {
          e: undefined,
          t: undefined
        });
        return _el$19;
      }
    }), _el$23);
    _$setProp(_el$23, "flexDirection", "column");
    _$setProp(_el$23, "flexGrow", 1);
    _$setProp(_el$23, "padding", 1);
    _$setProp(_el$23, "minHeight", 0);
    _$setProp(_el$23, "overflow", "hidden");
    _$insert(_el$23, _$createComponent(Show, {
      get when() {
        return activeGoals().length > 0;
      },
      get fallback() {
        return (() => {
          var _el$30 = _$createElement("text");
          _$insertNode(_el$30, _$createTextNode(`No active goals. Press : to create.`));
          _$effect((_$p) => _$setProp(_el$30, "fg", theme().textMuted, _$p));
          return _el$30;
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
            const line = () => {
              const parts = [`${statusIcon(goal.status)} ${goal.name}`, goal.status];
              if (runtime())
                parts.push(`${runtime().phase === "running" ? runningFrame() : phaseIcon(runtime().phase)} ${runtime().phase.toUpperCase()} turn ${runtime().turnCount}`, ageLabel(runtime().lastProgressAt || runtime().lastRunAt, clock()));
              if (runtime().consecutiveFailures > 0)
                parts.push(`${runtime().consecutiveFailures} failures`);
              return parts.join(" \u2502 ");
            };
            return (() => {
              var _el$32 = _$createElement("box"), _el$33 = _$createElement("text");
              _$insertNode(_el$32, _el$33);
              _$setProp(_el$32, "flexDirection", "row");
              _$setProp(_el$32, "paddingLeft", 1);
              _$setProp(_el$32, "paddingRight", 1);
              _$insert(_el$33, line);
              _$effect((_p$) => {
                var _v$18 = isActive() ? theme().backgroundElement : undefined, _v$19 = statusColor(goal.status, theme()), _v$20 = isActive();
                _v$18 !== _p$.e && (_p$.e = _$setProp(_el$32, "backgroundColor", _v$18, _p$.e));
                _v$19 !== _p$.t && (_p$.t = _$setProp(_el$33, "fg", _v$19, _p$.t));
                _v$20 !== _p$.a && (_p$.a = _$setProp(_el$33, "bold", _v$20, _p$.a));
                return _p$;
              }, {
                e: undefined,
                t: undefined,
                a: undefined
              });
              return _el$32;
            })();
          }
        });
      }
    }));
    _$insert(_el$18, _$createComponent(Show, {
      get when() {
        return selectedGoal();
      },
      children: (goal) => (() => {
        var _el$34 = _$createElement("box"), _el$35 = _$createElement("text"), _el$36 = _$createElement("text");
        _$insertNode(_el$34, _el$35);
        _$insertNode(_el$34, _el$36);
        _$setProp(_el$34, "flexDirection", "column");
        _$setProp(_el$34, "border", true);
        _$setProp(_el$34, "padding", 1);
        _$setProp(_el$34, "flexShrink", 0);
        _$setProp(_el$34, "maxHeight", 6);
        _$setProp(_el$35, "bold", true);
        _$insert(_el$35, () => goal().name, null);
        _$insert(_el$35, () => goal().status === "awaiting_user" ? " WAITING FOR YOU" : "", null);
        _$insert(_el$36, () => goal().objective.slice(0, 120));
        _$insert(_el$34, (() => {
          var _c$2 = _$memo(() => !!goal().question);
          return () => _c$2() && (() => {
            var _el$37 = _$createElement("text"), _el$38 = _$createTextNode(`Q: `);
            _$insertNode(_el$37, _el$38);
            _$insert(_el$37, () => goal().question.text, null);
            _$effect((_$p) => _$setProp(_el$37, "fg", theme().warning, _$p));
            return _el$37;
          })();
        })(), null);
        _$insert(_el$34, (() => {
          var _c$3 = _$memo(() => !!goal().lastProgress);
          return () => _c$3() && (() => {
            var _el$39 = _$createElement("text"), _el$40 = _$createTextNode(`last: `);
            _$insertNode(_el$39, _el$40);
            _$insert(_el$39, () => goal().lastProgress.summary.slice(0, 80), null);
            _$effect((_$p) => _$setProp(_el$39, "fg", theme().textMuted, _$p));
            return _el$39;
          })();
        })(), null);
        _$insert(_el$34, (() => {
          var _c$4 = _$memo(() => !!goal().blocker);
          return () => _c$4() && (() => {
            var _el$41 = _$createElement("text"), _el$42 = _$createTextNode(`blocked: `);
            _$insertNode(_el$41, _el$42);
            _$insert(_el$41, () => goal().blocker.reason.slice(0, 140), null);
            _$effect((_$p) => _$setProp(_el$41, "fg", theme().error, _$p));
            return _el$41;
          })();
        })(), null);
        _$effect((_p$) => {
          var _v$21 = goal().status === "awaiting_user" ? theme().warning : "gray", _v$22 = theme().primary, _v$23 = theme().textMuted;
          _v$21 !== _p$.e && (_p$.e = _$setProp(_el$34, "borderColor", _v$21, _p$.e));
          _v$22 !== _p$.t && (_p$.t = _$setProp(_el$35, "fg", _v$22, _p$.t));
          _v$23 !== _p$.a && (_p$.a = _$setProp(_el$36, "fg", _v$23, _p$.a));
          return _p$;
        }, {
          e: undefined,
          t: undefined,
          a: undefined
        });
        return _el$34;
      })()
    }), null);
    _$insert(_el$18, _$createComponent(Show, {
      get when() {
        return _$memo(() => !!showLogs())() && events().length > 0;
      },
      get children() {
        var _el$24 = _$createElement("box"), _el$25 = _$createElement("text");
        _$insertNode(_el$24, _el$25);
        _$setProp(_el$24, "flexDirection", "column");
        _$setProp(_el$24, "border", true);
        _$setProp(_el$24, "borderColor", "gray");
        _$setProp(_el$24, "padding", 1);
        _$setProp(_el$24, "maxHeight", 6);
        _$setProp(_el$24, "flexShrink", 0);
        _$setProp(_el$24, "overflow", "hidden");
        _$insertNode(_el$25, _$createTextNode(`Recent Events`));
        _$setProp(_el$25, "bold", true);
        _$insert(_el$24, _$createComponent(For, {
          get each() {
            return events().slice(-10);
          },
          children: (event) => (() => {
            var _el$43 = _$createElement("text"), _el$44 = _$createTextNode(` `);
            _$insertNode(_el$43, _el$44);
            _$insert(_el$43, () => event.type, _el$44);
            _$insert(_el$43, () => event.goalID?.slice(0, 8), null);
            _$effect((_$p) => _$setProp(_el$43, "fg", theme().textMuted, _$p));
            return _el$43;
          })()
        }), null);
        _$effect((_$p) => _$setProp(_el$25, "fg", theme().primary, _$p));
        return _el$24;
      }
    }), null);
    _$insertNode(_el$27, _el$28);
    _$insertNode(_el$27, _el$29);
    _$setProp(_el$27, "flexDirection", "row");
    _$setProp(_el$27, "border", true);
    _$setProp(_el$27, "paddingLeft", 1);
    _$setProp(_el$27, "paddingRight", 1);
    _$setProp(_el$27, "flexShrink", 0);
    _$setProp(_el$27, "height", 3);
    _$setProp(_el$27, "gap", 1);
    _$setProp(_el$28, "bold", true);
    _$insert(_el$28, () => mode() === "insert" ? "INSERT :" : "NORMAL");
    _$use((el) => {
      inputEl = el;
      focusInput();
    }, _el$29);
    _$setProp(_el$29, "flexGrow", 1);
    _$setProp(_el$29, "onInput", (v) => {
      debugLog("onInput", JSON.stringify(v), "mode", mode());
      if (mode() === "insert")
        setCommandInput(v);
      else if (inputEl?.value)
        inputEl.value = "";
    });
    _$setProp(_el$29, "onKeyDown", (evt) => {
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
      var _v$3 = theme().primary, _v$4 = theme().textMuted, _v$5 = mode() === "normal" ? theme().success : theme().warning, _v$6 = theme().textMuted, _v$7 = theme().text, _v$8 = theme().textMuted, _v$9 = runningCount() > 0 ? theme().success : theme().textMuted, _v$0 = runningCount() > 0, _v$1 = theme().textMuted, _v$10 = theme().info, _v$11 = mode() === "insert" ? theme().warning : "gray", _v$12 = mode() === "insert" ? theme().warning : theme().success, _v$13 = mode() === "insert" ? "goal start my-goal --objective ...  (Ctrl+N: normal)" : statusText() || "Press : to insert, ? help, q close", _v$14 = theme().textMuted, _v$15 = theme().primary, _v$16 = theme().text, _v$17 = theme().background;
      _v$3 !== _p$.e && (_p$.e = _$setProp(_el$4, "fg", _v$3, _p$.e));
      _v$4 !== _p$.t && (_p$.t = _$setProp(_el$6, "fg", _v$4, _p$.t));
      _v$5 !== _p$.a && (_p$.a = _$setProp(_el$8, "fg", _v$5, _p$.a));
      _v$6 !== _p$.o && (_p$.o = _$setProp(_el$9, "fg", _v$6, _p$.o));
      _v$7 !== _p$.i && (_p$.i = _$setProp(_el$1, "fg", _v$7, _p$.i));
      _v$8 !== _p$.n && (_p$.n = _$setProp(_el$10, "fg", _v$8, _p$.n));
      _v$9 !== _p$.s && (_p$.s = _$setProp(_el$12, "fg", _v$9, _p$.s));
      _v$0 !== _p$.h && (_p$.h = _$setProp(_el$12, "bold", _v$0, _p$.h));
      _v$1 !== _p$.r && (_p$.r = _$setProp(_el$15, "fg", _v$1, _p$.r));
      _v$10 !== _p$.d && (_p$.d = _$setProp(_el$17, "fg", _v$10, _p$.d));
      _v$11 !== _p$.l && (_p$.l = _$setProp(_el$27, "borderColor", _v$11, _p$.l));
      _v$12 !== _p$.u && (_p$.u = _$setProp(_el$28, "fg", _v$12, _p$.u));
      _v$13 !== _p$.c && (_p$.c = _$setProp(_el$29, "placeholder", _v$13, _p$.c));
      _v$14 !== _p$.w && (_p$.w = _$setProp(_el$29, "placeholderColor", _v$14, _p$.w));
      _v$15 !== _p$.m && (_p$.m = _$setProp(_el$29, "cursorColor", _v$15, _p$.m));
      _v$16 !== _p$.f && (_p$.f = _$setProp(_el$29, "focusedTextColor", _v$16, _p$.f));
      _v$17 !== _p$.y && (_p$.y = _$setProp(_el$29, "focusedBackgroundColor", _v$17, _p$.y));
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
      y: undefined
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
      key: "ctrl+alt+l",
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

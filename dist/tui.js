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
    "Modes: : command, Esc normal, ? help",
    "Commands:",
    '  :goal start <name> --objective "<text>"  Create a new goal',
    "  :pause                                    Pause the selected goal",
    "  :resume                                   Resume the selected goal",
    "  :retry                                    Retry the blocked goal",
    "  :clear                                    Clear the selected goal",
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
function LoopDashboard(props) {
  const theme = () => props.api.theme.current;
  const [mode, setMode] = createSignal("normal");
  const [selected, setSelected] = createSignal(0);
  const [commandInput, setCommandInput] = createSignal("");
  const [statusText, setStatusText] = createSignal("Press : to create, ? help, q close");
  const [state, setState] = createSignal(null);
  const [events, setEvents] = createSignal([]);
  const [selectedGoal, setSelectedGoal] = createSignal(null);
  const [showLogs, setShowLogs] = createSignal(false);
  let inputEl;
  const client = createControlClient(props.directory);
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
  const unsubs = [props.api.event.on("session.idle", () => refresh()), props.api.event.on("session.status", () => refresh()), props.api.event.on("session.error", () => refresh()), props.api.event.on("session.compacted", () => refresh()), setInterval(refresh, 1e4)];
  onCleanup(() => {
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
    queueMicrotask(() => inputEl?.focus());
  });
  createEffect(() => {
    const m = mode();
    debugLog("mode ->", m);
    queueMicrotask(() => inputEl?.focus());
  });
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
    if (mode() === "command") {
      if (name === "escape" || name === "esc") {
        prevent(evt);
        setCommandInput("");
        if (inputEl)
          inputEl.value = "";
        setMode("normal");
        debugLog("command -> normal");
      }
      return;
    }
    if (mode() === "help") {
      const n = name.toLowerCase();
      if (isColon) {
        prevent(evt);
        setCommandInput("");
        if (inputEl)
          inputEl.value = "";
        setMode("command");
        debugLog("help -> command");
      } else if (isQuestion || n === "h" || n === "q" || n === "escape" || n === "esc") {
        prevent(evt);
        setMode("normal");
        debugLog("help -> normal via", n);
      } else {
        prevent(evt);
        debugLog("help stay, blocked", n);
      }
      return;
    }
    if (isColon) {
      prevent(evt);
      setCommandInput("");
      if (inputEl)
        inputEl.value = "";
      setMode("command");
      debugLog("normal -> command");
      queueMicrotask(() => inputEl?.focus());
      return;
    }
    if (isQuestion) {
      prevent(evt);
      setMode("help");
      debugLog("normal -> help");
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
    if (name === "escape" || name === "esc" || key === "q") {
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
        case "logs":
          setShowLogs(!showLogs());
          break;
        case "help":
          setMode("help");
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
    setCommandInput("");
    if (inputEl)
      inputEl.value = "";
    setMode("normal");
    queueMicrotask(() => inputEl?.focus());
  }
  const activeGoals = () => state()?.goals.filter((g) => g.status !== "complete") || [];
  createEffect(() => setSelectedGoal(activeGoals()[selected()] || null));
  return (() => {
    var _el$ = _$createElement("box"), _el$2 = _$createElement("box"), _el$3 = _$createElement("box"), _el$4 = _$createElement("text"), _el$5 = _$createElement("span"), _el$7 = _$createElement("span"), _el$9 = _$createElement("span"), _el$0 = _$createElement("span"), _el$10 = _$createElement("span"), _el$11 = _$createElement("span"), _el$13 = _$createElement("span"), _el$19 = _$createElement("box"), _el$20 = _$createElement("input");
    _$insertNode(_el$, _el$2);
    _$setProp(_el$, "flexDirection", "column");
    _$setProp(_el$, "width", "100%");
    _$setProp(_el$, "alignItems", "center");
    _$setProp(_el$, "padding", 1);
    _$insertNode(_el$2, _el$3);
    _$insertNode(_el$2, _el$19);
    _$setProp(_el$2, "flexDirection", "column");
    _$setProp(_el$2, "width", "90%");
    _$setProp(_el$2, "border", true);
    _$setProp(_el$2, "borderColor", "gray");
    _$setProp(_el$2, "padding", 1);
    _$insertNode(_el$3, _el$4);
    _$setProp(_el$3, "flexDirection", "row");
    _$setProp(_el$3, "padding", 0);
    _$setProp(_el$3, "flexShrink", 0);
    _$insertNode(_el$4, _el$5);
    _$insertNode(_el$4, _el$7);
    _$insertNode(_el$4, _el$9);
    _$insertNode(_el$4, _el$0);
    _$insertNode(_el$4, _el$10);
    _$insertNode(_el$4, _el$11);
    _$insertNode(_el$4, _el$13);
    _$insertNode(_el$5, _$createTextNode(`Loop Dashboard`));
    _$insertNode(_el$7, _$createTextNode(` \u2502 `));
    _$insert(_el$9, () => mode().toUpperCase());
    _$insertNode(_el$0, _$createTextNode(` \u2502 goals: `));
    _$insert(_el$10, () => activeGoals().length);
    _$insertNode(_el$11, _$createTextNode(` \u2502 verified: `));
    _$insert(_el$13, () => state()?.goals.filter((g) => g.status === "complete").length || 0);
    _$insert(_el$2, _$createComponent(Show, {
      get when() {
        return mode() !== "help";
      },
      get fallback() {
        return (() => {
          var _el$21 = _$createElement("box"), _el$22 = _$createElement("text"), _el$23 = _$createElement("span");
          _$insertNode(_el$21, _el$22);
          _$setProp(_el$21, "flexDirection", "column");
          _$setProp(_el$21, "flexGrow", 1);
          _$setProp(_el$21, "padding", 1);
          _$setProp(_el$21, "minHeight", 12);
          _$setProp(_el$21, "border", true);
          _$setProp(_el$21, "borderColor", "yellow");
          _$insertNode(_el$22, _el$23);
          _$insertNode(_el$23, _$createTextNode(`\u2501\u2501\u2501 Keyboard Shortcuts \u2014 : command, ?/Esc normal \u2501\u2501\u2501`));
          _$setProp(_el$23, "style", {
            fg: "yellow",
            bold: true
          });
          _$insert(_el$21, _$createComponent(For, {
            get each() {
              return commandHelp().split(`
`);
            },
            children: (line) => (() => {
              var _el$25 = _$createElement("text"), _el$26 = _$createElement("span");
              _$insertNode(_el$25, _el$26);
              _$insert(_el$26, line);
              _$effect((_$p) => _$setProp(_el$26, "style", {
                fg: theme().text
              }, _$p));
              return _el$25;
            })()
          }), null);
          _$effect((_$p) => _$setProp(_el$21, "backgroundColor", theme().background, _$p));
          return _el$21;
        })();
      },
      get children() {
        var _el$14 = _$createElement("box");
        _$setProp(_el$14, "flexDirection", "column");
        _$setProp(_el$14, "flexGrow", 1);
        _$setProp(_el$14, "padding", 1);
        _$setProp(_el$14, "minHeight", 5);
        _$insert(_el$14, _$createComponent(Show, {
          get when() {
            return activeGoals().length > 0;
          },
          get fallback() {
            return (() => {
              var _el$27 = _$createElement("text"), _el$28 = _$createElement("span");
              _$insertNode(_el$27, _el$28);
              _$insertNode(_el$28, _$createTextNode(`No active goals. Press : to create one.`));
              _$effect((_$p) => _$setProp(_el$28, "style", {
                fg: theme().textMuted
              }, _$p));
              return _el$27;
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
                return (() => {
                  var _el$30 = _$createElement("box"), _el$31 = _$createElement("text"), _el$32 = _$createElement("span"), _el$33 = _$createTextNode(` `), _el$34 = _$createElement("span"), _el$36 = _$createElement("span");
                  _$insertNode(_el$30, _el$31);
                  _$setProp(_el$30, "flexDirection", "row");
                  _$setProp(_el$30, "paddingLeft", 1);
                  _$setProp(_el$30, "paddingRight", 1);
                  _$insertNode(_el$31, _el$32);
                  _$insertNode(_el$31, _el$34);
                  _$insertNode(_el$31, _el$36);
                  _$insertNode(_el$32, _el$33);
                  _$insert(_el$32, () => statusIcon(goal.status), _el$33);
                  _$insert(_el$32, () => goal.name, null);
                  _$insertNode(_el$34, _$createTextNode(` \u2502 `));
                  _$insert(_el$36, () => goal.status);
                  _$insert(_el$31, (() => {
                    var _c$ = _$memo(() => !!runtime());
                    return () => _c$() && [(() => {
                      var _el$37 = _$createElement("span");
                      _$insertNode(_el$37, _$createTextNode(` \u2502 `));
                      _$effect((_$p) => _$setProp(_el$37, "style", {
                        fg: theme().textMuted
                      }, _$p));
                      return _el$37;
                    })(), (() => {
                      var _el$39 = _$createElement("span"), _el$40 = _$createTextNode(` turn `);
                      _$insertNode(_el$39, _el$40);
                      _$insert(_el$39, () => phaseIcon(runtime().phase), _el$40);
                      _$insert(_el$39, () => runtime().turnCount, null);
                      _$effect((_$p) => _$setProp(_el$39, "style", {
                        fg: theme().text
                      }, _$p));
                      return _el$39;
                    })(), _$memo(() => _$memo(() => runtime().consecutiveFailures > 0)() && (() => {
                      var _el$41 = _$createElement("span"), _el$42 = _$createTextNode(` \u2502 `), _el$43 = _$createTextNode(` failures`);
                      _$insertNode(_el$41, _el$42);
                      _$insertNode(_el$41, _el$43);
                      _$insert(_el$41, () => runtime().consecutiveFailures, _el$43);
                      _$effect((_$p) => _$setProp(_el$41, "style", {
                        fg: theme().error
                      }, _$p));
                      return _el$41;
                    })())];
                  })(), null);
                  _$effect((_p$) => {
                    var _v$12 = isActive() ? theme().backgroundElement : undefined, _v$13 = {
                      fg: statusColor(goal.status, theme()),
                      bold: isActive()
                    }, _v$14 = {
                      fg: theme().textMuted
                    }, _v$15 = {
                      fg: statusColor(goal.status, theme())
                    };
                    _v$12 !== _p$.e && (_p$.e = _$setProp(_el$30, "backgroundColor", _v$12, _p$.e));
                    _v$13 !== _p$.t && (_p$.t = _$setProp(_el$32, "style", _v$13, _p$.t));
                    _v$14 !== _p$.a && (_p$.a = _$setProp(_el$34, "style", _v$14, _p$.a));
                    _v$15 !== _p$.o && (_p$.o = _$setProp(_el$36, "style", _v$15, _p$.o));
                    return _p$;
                  }, {
                    e: undefined,
                    t: undefined,
                    a: undefined,
                    o: undefined
                  });
                  return _el$30;
                })();
              }
            });
          }
        }));
        return _el$14;
      }
    }), _el$19);
    _$insert(_el$2, _$createComponent(Show, {
      get when() {
        return selectedGoal();
      },
      children: (goal) => (() => {
        var _el$44 = _$createElement("box"), _el$45 = _$createElement("text"), _el$46 = _$createElement("span"), _el$47 = _$createElement("text"), _el$48 = _$createElement("span");
        _$insertNode(_el$44, _el$45);
        _$insertNode(_el$44, _el$47);
        _$setProp(_el$44, "flexDirection", "column");
        _$setProp(_el$44, "border", true);
        _$setProp(_el$44, "borderColor", "gray");
        _$setProp(_el$44, "padding", 1);
        _$setProp(_el$44, "flexShrink", 0);
        _$insertNode(_el$45, _el$46);
        _$insert(_el$46, () => goal().name);
        _$insertNode(_el$47, _el$48);
        _$insert(_el$48, () => goal().objective.slice(0, 120));
        _$insert(_el$44, (() => {
          var _c$2 = _$memo(() => !!goal().config.progressFile);
          return () => _c$2() && (() => {
            var _el$49 = _$createElement("text"), _el$50 = _$createElement("span"), _el$51 = _$createTextNode(`progress: `);
            _$insertNode(_el$49, _el$50);
            _$insertNode(_el$50, _el$51);
            _$insert(_el$50, () => goal().config.progressFile, null);
            _$effect((_$p) => _$setProp(_el$50, "style", {
              fg: theme().textMuted
            }, _$p));
            return _el$49;
          })();
        })(), null);
        _$insert(_el$44, (() => {
          var _c$3 = _$memo(() => !!goal().lastProgress);
          return () => _c$3() && (() => {
            var _el$52 = _$createElement("text"), _el$53 = _$createElement("span"), _el$54 = _$createTextNode(`last progress: `);
            _$insertNode(_el$52, _el$53);
            _$insertNode(_el$53, _el$54);
            _$insert(_el$53, () => goal().lastProgress.summary.slice(0, 80), null);
            _$effect((_$p) => _$setProp(_el$53, "style", {
              fg: theme().textMuted
            }, _$p));
            return _el$52;
          })();
        })(), null);
        _$insert(_el$44, (() => {
          var _c$4 = _$memo(() => !!goal().blocker);
          return () => _c$4() && (() => {
            var _el$55 = _$createElement("text"), _el$56 = _$createElement("span"), _el$57 = _$createTextNode(`blocked: `);
            _$insertNode(_el$55, _el$56);
            _$insertNode(_el$56, _el$57);
            _$insert(_el$56, () => goal().blocker.reason.slice(0, 140), null);
            _$effect((_$p) => _$setProp(_el$56, "style", {
              fg: theme().error
            }, _$p));
            return _el$55;
          })();
        })(), null);
        _$insert(_el$44, (() => {
          var _c$5 = _$memo(() => !!state()?.runtimes.find((runtime) => runtime.goalID === goal().id)?.lastError);
          return () => _c$5() && (() => {
            var _el$58 = _$createElement("text"), _el$59 = _$createElement("span"), _el$60 = _$createTextNode(`error: `);
            _$insertNode(_el$58, _el$59);
            _$insertNode(_el$59, _el$60);
            _$insert(_el$59, () => state().runtimes.find((runtime) => runtime.goalID === goal().id).lastError.slice(0, 140), null);
            _$effect((_$p) => _$setProp(_el$59, "style", {
              fg: theme().error
            }, _$p));
            return _el$58;
          })();
        })(), null);
        _$effect((_p$) => {
          var _v$16 = {
            fg: theme().primary,
            bold: true
          }, _v$17 = {
            fg: theme().textMuted
          };
          _v$16 !== _p$.e && (_p$.e = _$setProp(_el$46, "style", _v$16, _p$.e));
          _v$17 !== _p$.t && (_p$.t = _$setProp(_el$48, "style", _v$17, _p$.t));
          return _p$;
        }, {
          e: undefined,
          t: undefined
        });
        return _el$44;
      })()
    }), _el$19);
    _$insert(_el$2, _$createComponent(Show, {
      get when() {
        return _$memo(() => !!showLogs())() && events().length > 0;
      },
      get children() {
        var _el$15 = _$createElement("box"), _el$16 = _$createElement("text"), _el$17 = _$createElement("span");
        _$insertNode(_el$15, _el$16);
        _$setProp(_el$15, "flexDirection", "column");
        _$setProp(_el$15, "border", true);
        _$setProp(_el$15, "borderColor", "gray");
        _$setProp(_el$15, "padding", 1);
        _$setProp(_el$15, "maxHeight", 8);
        _$setProp(_el$15, "flexShrink", 0);
        _$insertNode(_el$16, _el$17);
        _$insertNode(_el$17, _$createTextNode(`Recent Events`));
        _$insert(_el$15, _$createComponent(For, {
          get each() {
            return events().slice(-10);
          },
          children: (event) => (() => {
            var _el$61 = _$createElement("text"), _el$62 = _$createElement("span"), _el$63 = _$createTextNode(` `);
            _$insertNode(_el$61, _el$62);
            _$insertNode(_el$62, _el$63);
            _$insert(_el$62, () => event.type, _el$63);
            _$insert(_el$62, () => event.goalID?.slice(0, 8), null);
            _$effect((_$p) => _$setProp(_el$62, "style", {
              fg: theme().textMuted
            }, _$p));
            return _el$61;
          })()
        }), null);
        _$effect((_$p) => _$setProp(_el$17, "style", {
          fg: theme().primary,
          bold: true
        }, _$p));
        return _el$15;
      }
    }), _el$19);
    _$insertNode(_el$19, _el$20);
    _$setProp(_el$19, "flexDirection", "row");
    _$setProp(_el$19, "border", true);
    _$setProp(_el$19, "borderColor", "gray");
    _$setProp(_el$19, "paddingLeft", 1);
    _$setProp(_el$19, "paddingRight", 1);
    _$setProp(_el$19, "flexShrink", 0);
    _$setProp(_el$19, "height", 3);
    _$use((el) => {
      inputEl = el;
      queueMicrotask(() => el?.focus());
    }, _el$20);
    _$setProp(_el$20, "onInput", (v) => {
      debugLog("onInput", JSON.stringify(v), "mode", mode());
      if (mode() === "command")
        setCommandInput(v);
    });
    _$setProp(_el$20, "onKeyDown", (evt) => {
      const name = evt.name || "";
      const seq = evt.sequence || "";
      debugLog("input onKeyDown", `name=${name} seq=${JSON.stringify(seq)} mode=${mode()} value=${JSON.stringify(commandInput())}`);
      if (mode() !== "command") {
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
      if (name === "escape") {
        prevent(evt);
        debugLog("input escape -> normal");
        setCommandInput("");
        if (inputEl)
          inputEl.value = "";
        setMode("normal");
        return;
      }
    });
    _$effect((_p$) => {
      var _v$ = {
        fg: theme().primary,
        bold: true
      }, _v$2 = {
        fg: theme().textMuted
      }, _v$3 = {
        fg: mode() === "normal" ? theme().success : theme().warning
      }, _v$4 = {
        fg: theme().textMuted
      }, _v$5 = {
        fg: theme().text
      }, _v$6 = {
        fg: theme().textMuted
      }, _v$7 = {
        fg: theme().info
      }, _v$8 = mode() === "command" ? commandInput() : "", _v$9 = mode() === "command" ? "goal start my-goal --objective ...  (Esc: normal)" : mode() === "help" ? ": command, ?/Esc normal" : statusText() || "Press : to create, ? help, q close \u2014 j/k move p pause r resume", _v$0 = theme().textMuted, _v$1 = theme().primary, _v$10 = theme().text, _v$11 = theme().background;
      _v$ !== _p$.e && (_p$.e = _$setProp(_el$5, "style", _v$, _p$.e));
      _v$2 !== _p$.t && (_p$.t = _$setProp(_el$7, "style", _v$2, _p$.t));
      _v$3 !== _p$.a && (_p$.a = _$setProp(_el$9, "style", _v$3, _p$.a));
      _v$4 !== _p$.o && (_p$.o = _$setProp(_el$0, "style", _v$4, _p$.o));
      _v$5 !== _p$.i && (_p$.i = _$setProp(_el$10, "style", _v$5, _p$.i));
      _v$6 !== _p$.n && (_p$.n = _$setProp(_el$11, "style", _v$6, _p$.n));
      _v$7 !== _p$.s && (_p$.s = _$setProp(_el$13, "style", _v$7, _p$.s));
      _v$8 !== _p$.h && (_p$.h = _$setProp(_el$20, "value", _v$8, _p$.h));
      _v$9 !== _p$.r && (_p$.r = _$setProp(_el$20, "placeholder", _v$9, _p$.r));
      _v$0 !== _p$.d && (_p$.d = _$setProp(_el$20, "placeholderColor", _v$0, _p$.d));
      _v$1 !== _p$.l && (_p$.l = _$setProp(_el$20, "cursorColor", _v$1, _p$.l));
      _v$10 !== _p$.u && (_p$.u = _$setProp(_el$20, "focusedTextColor", _v$10, _p$.u));
      _v$11 !== _p$.c && (_p$.c = _$setProp(_el$20, "focusedBackgroundColor", _v$11, _p$.c));
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
      c: undefined
    });
    return _el$;
  })();
}

// src/tui/plugin.tsx
var PLUGIN_ID = "opencode-loopd.tui";
var tui = async (api) => {
  const directory = api.state.path.directory;
  const open = () => {
    api.ui.dialog.replace(() => _$createComponent2(LoopDashboard, {
      api,
      directory
    }));
    api.ui.dialog.setSize("xlarge");
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
      key: "ctrl+shift+l",
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

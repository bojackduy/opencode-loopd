// @bun
// src/tui/dashboard.tsx
import { createSignal, For, Show, onCleanup } from "solid-js";

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

// src/tui/controller.ts
import { randomUUID } from "crypto";
function createDashboardController(client) {
  async function refresh() {
    const s = await client.getState();
    const activeGoals = s.goals.filter((g) => g.status !== "complete");
    return {
      goals: s.goals,
      selected: 0,
      activeGoals,
      selectedGoal: activeGoals[0] || null,
      statusText: "",
      showLogs: false
    };
  }
  function moveDown(state) {
    if (state.activeGoals.length === 0)
      return state;
    const next = Math.min(state.selected + 1, state.activeGoals.length - 1);
    return { ...state, selected: next, selectedGoal: state.activeGoals[next] || null };
  }
  function moveUp(state) {
    if (state.activeGoals.length === 0)
      return state;
    const next = Math.max(state.selected - 1, 0);
    return { ...state, selected: next, selectedGoal: state.activeGoals[next] || null };
  }
  function moveFirst(state) {
    return { ...state, selected: 0, selectedGoal: state.activeGoals[0] || null };
  }
  function moveLast(state) {
    if (state.activeGoals.length === 0)
      return state;
    const last = state.activeGoals.length - 1;
    return { ...state, selected: last, selectedGoal: state.activeGoals[last] || null };
  }
  async function startGoal(ownerSessionID, name, objective) {
    const result = await client.execute({
      version: 1,
      requestID: randomUUID(),
      requestedAt: new Date().toISOString(),
      command: "start",
      args: { name, objective, config: {}, ownerSessionID }
    });
    return {
      statusText: result.ok ? result.message : `Error: ${result.message}`,
      needsRefresh: true
    };
  }
  async function pauseGoal(goal) {
    const result = await client.execute({
      version: 1,
      requestID: randomUUID(),
      requestedAt: new Date().toISOString(),
      command: "pause",
      goalID: goal.id
    });
    return {
      statusText: result.ok ? result.message : `Error: ${result.message}`,
      needsRefresh: true
    };
  }
  async function resumeGoal(goal) {
    const result = await client.execute({
      version: 1,
      requestID: randomUUID(),
      requestedAt: new Date().toISOString(),
      command: "resume",
      goalID: goal.id
    });
    return {
      statusText: result.ok ? result.message : `Error: ${result.message}`,
      needsRefresh: true
    };
  }
  async function retryGoal(goal) {
    const result = await client.execute({
      version: 1,
      requestID: randomUUID(),
      requestedAt: new Date().toISOString(),
      command: "retry",
      goalID: goal.id
    });
    return {
      statusText: result.ok ? result.message : `Error: ${result.message}`,
      needsRefresh: true
    };
  }
  async function clearGoal(goal) {
    const result = await client.execute({
      version: 1,
      requestID: randomUUID(),
      requestedAt: new Date().toISOString(),
      command: "clear",
      goalID: goal.id
    });
    return {
      statusText: result.ok ? result.message : `Error: ${result.message}`,
      needsRefresh: true
    };
  }
  function toggleLogs(state) {
    return { ...state, showLogs: !state.showLogs };
  }
  async function executeCommand(command, args, positional, state, ownerSessionID) {
    switch (command) {
      case "goal": {
        if (positional[0] === "start") {
          const name = positional[1] || args.name || "unnamed";
          const objective = args.objective || positional[2] || "";
          return startGoal(ownerSessionID, name, objective);
        }
        return { statusText: "Usage: :goal start <name> --objective <text>", needsRefresh: false };
      }
      case "pause": {
        if (!state.selectedGoal)
          return { statusText: "No goal selected", needsRefresh: false };
        return pauseGoal(state.selectedGoal);
      }
      case "resume": {
        if (!state.selectedGoal)
          return { statusText: "No goal selected", needsRefresh: false };
        return resumeGoal(state.selectedGoal);
      }
      case "retry": {
        if (!state.selectedGoal)
          return { statusText: "No goal selected", needsRefresh: false };
        return retryGoal(state.selectedGoal);
      }
      case "clear": {
        if (!state.selectedGoal)
          return { statusText: "No goal selected", needsRefresh: false };
        return clearGoal(state.selectedGoal);
      }
      case "logs": {
        return { statusText: "", needsRefresh: false };
      }
      case "help": {
        return { statusText: "", needsRefresh: false };
      }
      case "q":
      case "close": {
        return { statusText: "close", needsRefresh: false };
      }
      default: {
        return { statusText: `Unknown command: ${command}. Type :help for available commands.`, needsRefresh: false };
      }
    }
  }
  return {
    refresh,
    moveDown,
    moveUp,
    moveFirst,
    moveLast,
    startGoal,
    pauseGoal,
    resumeGoal,
    retryGoal,
    clearGoal,
    toggleLogs,
    executeCommand
  };
}

// src/tui/dashboard.tsx
import { jsxDEV, Fragment } from "@opentui/solid/jsx-dev-runtime";
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
  const [statusText, setStatusText] = createSignal("Press ? for help");
  const [state, setState] = createSignal(null);
  const [events, setEvents] = createSignal([]);
  const [selectedGoal, setSelectedGoal] = createSignal(null);
  const [showLogs, setShowLogs] = createSignal(false);
  const client = createControlClient(props.directory);
  const ctrl = createDashboardController(client);
  async function refresh() {
    try {
      const s = await client.getState();
      setState(s);
      const goals = s.goals.filter((g) => g.status !== "complete");
      if (goals.length > 0 && selected() >= goals.length) {
        setSelected(goals.length - 1);
      }
      const sel = goals[selected()];
      setSelectedGoal(sel || null);
      const ev = await client.getEvents(20);
      setEvents(ev);
    } catch (e) {
      setStatusText(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  refresh();
  const refreshInterval = setInterval(refresh, 2000);
  onCleanup(() => clearInterval(refreshInterval));
  async function executeCommand(cmd) {
    const parsed = parseCommand(cmd);
    if (!parsed)
      return;
    const route = props.api.route.current;
    const ownerSessionID = route.name === "session" ? route.params?.sessionID || "main" : "main";
    try {
      const result = await ctrl.executeCommand(parsed.command, parsed.args, parsed.positional, { goals: state()?.goals || [], selected: selected(), activeGoals: state()?.goals.filter((g) => g.status !== "complete") || [], selectedGoal: selectedGoal(), statusText: statusText(), showLogs: showLogs() }, ownerSessionID);
      setStatusText(result.statusText);
      if (result.needsRefresh)
        await refresh();
    } catch (e) {
      setStatusText(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  props.api.keymap.registerLayer({
    mode: "modal",
    commands: [],
    bindings: [
      { key: "escape", cmd: "loopd.close", desc: "Close dashboard" },
      { key: "ctrl+c", cmd: "loopd.close", desc: "Close dashboard" },
      { key: "j", cmd: "loopd.next", desc: "Next goal" },
      { key: "down", cmd: "loopd.next", desc: "Next goal" },
      { key: "k", cmd: "loopd.prev", desc: "Previous goal" },
      { key: "up", cmd: "loopd.prev", desc: "Previous goal" },
      { key: "g", cmd: "loopd.first", desc: "First goal" },
      { key: "G", cmd: "loopd.last", desc: "Last goal" },
      { key: "p", cmd: "loopd.pause", desc: "Pause selected goal" },
      { key: "r", cmd: "loopd.resume", desc: "Resume selected goal" },
      { key: "R", cmd: "loopd.retry", desc: "Retry failed goal" },
      { key: "x", cmd: "loopd.clear", desc: "Clear selected goal" },
      { key: "L", cmd: "loopd.logs", desc: "Toggle log view" },
      { key: ":", cmd: "loopd.command", desc: "Enter command mode" },
      { key: "?", cmd: "loopd.help", desc: "Show help" },
      { key: "q", cmd: "loopd.close", desc: "Close dashboard" }
    ]
  });
  const activeGoals = () => state()?.goals.filter((g) => g.status !== "complete") || [];
  return /* @__PURE__ */ jsxDEV("box", {
    flexDirection: "column",
    width: "100%",
    height: "100%",
    children: [
      /* @__PURE__ */ jsxDEV("box", {
        flexDirection: "row",
        padding: 1,
        children: /* @__PURE__ */ jsxDEV("text", {
          children: [
            /* @__PURE__ */ jsxDEV("span", {
              style: { fg: theme().primary, bold: true },
              children: "Loop Dashboard"
            }, undefined, false, undefined, this),
            /* @__PURE__ */ jsxDEV("span", {
              style: { fg: theme().textMuted },
              children: " \u2502 "
            }, undefined, false, undefined, this),
            /* @__PURE__ */ jsxDEV("span", {
              style: { fg: mode() === "normal" ? theme().success : theme().warning },
              children: mode().toUpperCase()
            }, undefined, false, undefined, this),
            /* @__PURE__ */ jsxDEV("span", {
              style: { fg: theme().textMuted },
              children: " \u2502 goals: "
            }, undefined, false, undefined, this),
            /* @__PURE__ */ jsxDEV("span", {
              style: { fg: theme().text },
              children: activeGoals().length
            }, undefined, false, undefined, this),
            /* @__PURE__ */ jsxDEV("span", {
              style: { fg: theme().textMuted },
              children: " \u2502 verified: "
            }, undefined, false, undefined, this),
            /* @__PURE__ */ jsxDEV("span", {
              style: { fg: theme().info },
              children: state()?.goals.filter((g) => g.status === "complete").length || 0
            }, undefined, false, undefined, this)
          ]
        }, undefined, true, undefined, this)
      }, undefined, false, undefined, this),
      /* @__PURE__ */ jsxDEV(Show, {
        when: mode() !== "help",
        fallback: /* @__PURE__ */ jsxDEV("box", {
          flexDirection: "column",
          flexGrow: 1,
          padding: 1,
          children: [
            /* @__PURE__ */ jsxDEV("text", {
              children: /* @__PURE__ */ jsxDEV("span", {
                style: { fg: theme().primary, bold: true },
                children: "Keyboard Shortcuts"
              }, undefined, false, undefined, this)
            }, undefined, false, undefined, this),
            /* @__PURE__ */ jsxDEV("text", {
              children: /* @__PURE__ */ jsxDEV("span", {
                style: { fg: theme().text },
                children: commandHelp()
              }, undefined, false, undefined, this)
            }, undefined, false, undefined, this)
          ]
        }, undefined, true, undefined, this),
        children: /* @__PURE__ */ jsxDEV("box", {
          flexDirection: "column",
          flexGrow: 1,
          padding: 1,
          children: /* @__PURE__ */ jsxDEV(Show, {
            when: activeGoals().length > 0,
            fallback: /* @__PURE__ */ jsxDEV("text", {
              children: /* @__PURE__ */ jsxDEV("span", {
                style: { fg: theme().textMuted },
                children: "No active goals. Press : to create one."
              }, undefined, false, undefined, this)
            }, undefined, false, undefined, this),
            children: /* @__PURE__ */ jsxDEV(For, {
              each: activeGoals(),
              children: (goal, i) => {
                const runtime = () => state()?.runtimes.find((r) => r.goalID === goal.id);
                const isActive = () => i() === selected();
                return /* @__PURE__ */ jsxDEV("box", {
                  flexDirection: "row",
                  paddingLeft: 1,
                  paddingRight: 1,
                  paddingTop: 0,
                  paddingBottom: 0,
                  backgroundColor: isActive() ? theme().backgroundElement : undefined,
                  children: /* @__PURE__ */ jsxDEV("text", {
                    children: [
                      /* @__PURE__ */ jsxDEV("span", {
                        style: { fg: statusColor(goal.status, theme()), bold: isActive() },
                        children: [
                          statusIcon(goal.status),
                          " ",
                          goal.name
                        ]
                      }, undefined, true, undefined, this),
                      /* @__PURE__ */ jsxDEV("span", {
                        style: { fg: theme().textMuted },
                        children: " \u2502 "
                      }, undefined, false, undefined, this),
                      /* @__PURE__ */ jsxDEV("span", {
                        style: { fg: statusColor(goal.status, theme()) },
                        children: goal.status
                      }, undefined, false, undefined, this),
                      runtime() && /* @__PURE__ */ jsxDEV(Fragment, {
                        children: [
                          /* @__PURE__ */ jsxDEV("span", {
                            style: { fg: theme().textMuted },
                            children: " \u2502 "
                          }, undefined, false, undefined, this),
                          /* @__PURE__ */ jsxDEV("span", {
                            style: { fg: theme().text },
                            children: [
                              phaseIcon(runtime().phase),
                              " turn ",
                              runtime().turnCount
                            ]
                          }, undefined, true, undefined, this),
                          runtime().consecutiveFailures > 0 && /* @__PURE__ */ jsxDEV("span", {
                            style: { fg: theme().error },
                            children: [
                              " \u2502 ",
                              runtime().consecutiveFailures,
                              " failures"
                            ]
                          }, undefined, true, undefined, this)
                        ]
                      }, undefined, true, undefined, this)
                    ]
                  }, undefined, true, undefined, this)
                }, undefined, false, undefined, this);
              }
            }, undefined, false, undefined, this)
          }, undefined, false, undefined, this)
        }, undefined, false, undefined, this)
      }, undefined, false, undefined, this),
      /* @__PURE__ */ jsxDEV(Show, {
        when: selectedGoal(),
        children: /* @__PURE__ */ jsxDEV("box", {
          flexDirection: "column",
          border: true,
          borderColor: "gray",
          padding: 1,
          children: [
            /* @__PURE__ */ jsxDEV("text", {
              children: /* @__PURE__ */ jsxDEV("span", {
                style: { fg: theme().primary, bold: true },
                children: selectedGoal().name
              }, undefined, false, undefined, this)
            }, undefined, false, undefined, this),
            /* @__PURE__ */ jsxDEV("text", {
              children: /* @__PURE__ */ jsxDEV("span", {
                style: { fg: theme().textMuted },
                children: selectedGoal().objective.slice(0, 120)
              }, undefined, false, undefined, this)
            }, undefined, false, undefined, this),
            selectedGoal().config.progressFile && /* @__PURE__ */ jsxDEV("text", {
              children: /* @__PURE__ */ jsxDEV("span", {
                style: { fg: theme().textMuted },
                children: [
                  "progress: ",
                  selectedGoal().config.progressFile
                ]
              }, undefined, true, undefined, this)
            }, undefined, false, undefined, this),
            selectedGoal().lastProgress && /* @__PURE__ */ jsxDEV("text", {
              children: /* @__PURE__ */ jsxDEV("span", {
                style: { fg: theme().textMuted },
                children: [
                  "last progress: ",
                  selectedGoal().lastProgress.summary.slice(0, 80)
                ]
              }, undefined, true, undefined, this)
            }, undefined, false, undefined, this)
          ]
        }, undefined, true, undefined, this)
      }, undefined, false, undefined, this),
      /* @__PURE__ */ jsxDEV(Show, {
        when: showLogs() && events().length > 0,
        children: /* @__PURE__ */ jsxDEV("box", {
          flexDirection: "column",
          border: true,
          borderColor: "gray",
          padding: 1,
          maxHeight: 8,
          children: [
            /* @__PURE__ */ jsxDEV("text", {
              children: /* @__PURE__ */ jsxDEV("span", {
                style: { fg: theme().primary, bold: true },
                children: "Recent Events"
              }, undefined, false, undefined, this)
            }, undefined, false, undefined, this),
            /* @__PURE__ */ jsxDEV(For, {
              each: events().slice(-10),
              children: (event) => /* @__PURE__ */ jsxDEV("text", {
                children: /* @__PURE__ */ jsxDEV("span", {
                  style: { fg: theme().textMuted },
                  children: [
                    event.type,
                    " ",
                    event.goalID?.slice(0, 8)
                  ]
                }, undefined, true, undefined, this)
              }, undefined, false, undefined, this)
            }, undefined, false, undefined, this)
          ]
        }, undefined, true, undefined, this)
      }, undefined, false, undefined, this),
      /* @__PURE__ */ jsxDEV("box", {
        flexDirection: "row",
        border: true,
        borderColor: "gray",
        padding: 0,
        children: /* @__PURE__ */ jsxDEV(Show, {
          when: mode() === "command",
          fallback: /* @__PURE__ */ jsxDEV("text", {
            children: /* @__PURE__ */ jsxDEV("span", {
              style: { fg: theme().textMuted },
              children: statusText() || " q:close  p:pause  r:resume  R:retry  x:clear  :cmd  ?help"
            }, undefined, false, undefined, this)
          }, undefined, false, undefined, this),
          children: /* @__PURE__ */ jsxDEV("text", {
            children: /* @__PURE__ */ jsxDEV("span", {
              style: { fg: theme().warning },
              children: [
                ":",
                commandInput()
              ]
            }, undefined, true, undefined, this)
          }, undefined, false, undefined, this)
        }, undefined, false, undefined, this)
      }, undefined, false, undefined, this)
    ]
  }, undefined, true, undefined, this);
}

// src/tui/plugin.tsx
import { jsxDEV as jsxDEV2 } from "@opentui/solid/jsx-dev-runtime";
var PLUGIN_ID = "opencode-loopd.tui";
var tui = async (api) => {
  const directory = api.state.path.directory;
  const open = () => {
    api.ui.dialog.replace(() => /* @__PURE__ */ jsxDEV2(LoopDashboard, {
      api,
      directory
    }, undefined, false, undefined, this));
    api.ui.dialog.setSize("xlarge");
  };
  api.keymap.registerLayer({
    commands: [
      {
        name: "opencode.loopd.dashboard",
        title: "Loop Dashboard",
        category: "Loop",
        namespace: "palette",
        slashName: "loop",
        run: open
      }
    ],
    bindings: [
      { key: "ctrl+shift+l", cmd: "opencode.loopd.dashboard", desc: "Open loop dashboard" }
    ]
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

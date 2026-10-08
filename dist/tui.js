// @bun
var __require = import.meta.require;

// src/tui/plugin.tsx
import { createComponent as _$createComponent4 } from "@opentui/solid";

// src/tui/dashboard.tsx
import { createComponent as _$createComponent } from "@opentui/solid";
import { spread as _$spread } from "@opentui/solid";
import { mergeProps as _$mergeProps } from "@opentui/solid";
import { memo as _$memo } from "@opentui/solid";
import { createTextNode as _$createTextNode } from "@opentui/solid";
import { insertNode as _$insertNode } from "@opentui/solid";
import { effect as _$effect } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
import { setProp as _$setProp } from "@opentui/solid";
import { use as _$use } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
import { batch, createSignal, For, Show, onCleanup, onMount, createEffect } from "solid-js";
import { useKeyboard } from "@opentui/solid";

// src/infrastructure/control-client.ts
import { randomUUID } from "crypto";

// src/infrastructure/state-repository.ts
import { promises as fs2 } from "fs";
import path from "path";

// src/infrastructure/event-tail.ts
import { promises as fs } from "fs";
async function readEventTail(target, limit) {
  try {
    if (!Number.isFinite(limit) || limit < 1) {
      const raw = await fs.readFile(target, "utf8");
      return raw.trim().split(`
`).filter(Boolean).slice(-limit).map((line) => JSON.parse(line));
    }
    const count = Math.trunc(limit);
    const file = await fs.open(target, "r");
    try {
      let position = (await file.stat()).size;
      let fragments = [];
      const lines = [];
      const finishLine = (first = false) => {
        const line = Buffer.concat(fragments.reverse()).toString("utf8");
        fragments = [];
        if (line && !((first || lines.length === 0) && !line.trim()))
          lines.push(line);
      };
      while (position > 0 && lines.length < count) {
        const length = Math.min(16 * 1024, position);
        position -= length;
        const buffer = Buffer.allocUnsafe(length);
        const { bytesRead } = await file.read(buffer, 0, length, position);
        let end = bytesRead;
        for (let i = bytesRead - 1;i >= 0; i--) {
          if (buffer[i] !== 10)
            continue;
          fragments.push(buffer.subarray(i + 1, end));
          finishLine();
          end = i;
          if (lines.length === count)
            break;
        }
        if (lines.length < count)
          fragments.push(buffer.subarray(0, end));
      }
      if (lines.length < count)
        finishLine(true);
      return lines.reverse().map((line) => JSON.parse(line));
    } finally {
      await file.close();
    }
  } catch {
    return [];
  }
}

// src/infrastructure/state-repository.ts
var CURRENT_VERSION = 9;
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
      const raw = await fs2.readFile(target, "utf8");
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
  if (result.version < 8) {
    result.version = 8;
    if (!Array.isArray(result.commandAwaits))
      result.commandAwaits = [];
  }
  if (result.version < 9) {
    result.version = 9;
    result.goals = result.goals.map((goal) => ({
      ...goal,
      workerTopology: goal.workerTopology ?? undefined,
      nativeParentID: goal.nativeParentID ?? undefined
    }));
  }
  return result;
}
async function writeAtomic(target, contents) {
  const dir = path.dirname(target);
  await fs2.mkdir(dir, { recursive: true });
  const temp = path.join(dir, `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await fs2.writeFile(temp, contents, "utf8");
  try {
    for (let attempt = 0;attempt < 5; attempt++) {
      try {
        await fs2.rename(temp, target);
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
    await fs2.copyFile(temp, target);
  } finally {
    try {
      await fs2.rm(temp, { force: true });
    } catch {}
  }
}
async function readEvents(directory, limit = 50) {
  return readEventTail(eventsFile(directory), limit);
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
  await fs2.mkdir(dir, { recursive: true });
  await writeAtomic(requestFile(directory, request.requestID), JSON.stringify(request, null, 2));
}
async function readControlResponse(directory, requestID) {
  try {
    const raw = await fs2.readFile(responseFile(directory, requestID), "utf8");
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
    const stat = await fs2.stat(file);
    const totalBytes = stat.size;
    const requestedStart = Math.max(0, opts?.offsetBytes ?? 0);
    if (requestedStart >= totalBytes)
      return { text: "", totalBytes, startByte: requestedStart };
    const fh = await fs2.open(file, "r");
    try {
      const want = Math.min(opts?.limitBytes ?? 64 * 1024, totalBytes - requestedStart);
      const buf = Buffer.alloc(want);
      await fh.read(buf, 0, want, requestedStart);
      const { text, startByte, endByte } = decodeUtf8Window(buf, requestedStart);
      return { text, totalBytes, startByte };
    } finally {
      await fh.close();
    }
  } catch {
    return { text: "", totalBytes: 0, startByte: 0 };
  }
}
function decodeUtf8Window(buf, windowStart) {
  let start = 0;
  while (start < buf.length && (buf[start] & 192) === 128 && start < 4)
    start++;
  let end = buf.length;
  let leadIndex = end;
  while (leadIndex > start && (buf[leadIndex - 1] & 192) === 128)
    leadIndex--;
  if (leadIndex > start) {
    const lead = buf[leadIndex - 1];
    let expected = 1;
    if ((lead & 128) === 0)
      expected = 1;
    else if ((lead & 224) === 192)
      expected = 2;
    else if ((lead & 240) === 224)
      expected = 3;
    else if ((lead & 248) === 240)
      expected = 4;
    if (end - (leadIndex - 1) < expected)
      end = leadIndex - 1;
  } else if (leadIndex === start && start > 0 && end > start) {
    end = start;
  }
  const slice = buf.subarray(start, end);
  return { text: slice.toString("utf8"), startByte: windowStart + start, endByte: windowStart + end };
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
    "  :interactive                             Toggle manual mode (engine never starts turns)",
    "  :model <provider/model>                Switch this goal's model (same worker; :models lists options)",
    "  :agent <name> / :agents                 Switch this goal's agent / list agents (Goals tab only)",
    "  :bug / :report                            Open prefilled GitHub bug report",
    "  :logs / :help / :q                        Toggle logs / help / close",
    "  Tip: create goals via /goal in the parent chat (agent clarifies first)."
  ].join(`
`);
}
function commandTabHelp() {
  return [
    "Nav: j/k select | o fullscreen | q close",
    "Commands tab (selected command only):",
    "  c / Ctrl+C              Toggle finished / send SIGINT",
    "  :terminate              Graceful stop (SIGTERM\u2192SIGKILL)",
    "  X / :kill               Force kill now (SIGKILL)",
    "  R / :restart            Restart; old log kept",
    "  x / :remove             Remove finished + log",
    "  :new <cmd> [args]       Start a command",
    "  bare text + Enter       Write stdin line"
  ].join(`
`);
}

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
function watchBadge(c) {
  const st = c.watchState?.state;
  if (st === "until-matched")
    return "until-matched";
  if (st === "flood-suspended")
    return "flood-suspended";
  if (st === "budget-exhausted")
    return "budget-exhausted";
  if (c.watchUntil !== undefined)
    return `until:${c.watchUntilAction ?? "stop"}-armed`;
  if (c.watchFilter !== undefined)
    return "watch:filter";
  return;
}
function formatWatchDetail(c) {
  if (c.watchFilter === undefined && c.watchUntil === undefined && c.watchState === undefined)
    return;
  const spec = [
    c.watchFilter !== undefined ? `filter="${c.watchFilter}"` : null,
    c.watchUntil !== undefined ? `until="${c.watchUntil}"` : null,
    `action=${c.watchUntilAction ?? "stop"}`,
    c.watchIgnoreCase === true ? "ignore-case" : null
  ].filter((x) => x !== null).join(" ");
  const st = c.watchState;
  const counters = st ? `state=${st.state} matches=${st.matches} pushes=${st.pushes} dropped=${st.droppedLines}` : "state=\u2014";
  return `watch ${spec} \xB7 ${counters}`;
}
function parseNewCommandTail(raw) {
  const match = /^(?::?\s*new)(?:\s+(.*))?\s*$/s.exec(raw.trim());
  if (!match)
    return;
  const tail = (match[1] ?? "").trim();
  if (!tail)
    return;
  return parseCommandLine(tail);
}
function parseNewCommand(raw) {
  const parts = parseNewCommandTail(raw);
  if (!parts || parts.length === 0)
    return;
  const [command, ...cmdArgs] = parts;
  return { command, cmdArgs };
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

// src/tui/terminal-route.ts
var TERMINAL_ROUTE_NAME = "opencode.loopd.terminal";
function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}
function validateTerminalRouteData(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "route-data-missing" };
  }
  const r = raw;
  if (!isNonEmptyString(r["commandID"]))
    return { ok: false, reason: "commandID-required" };
  if (!isNonEmptyString(r["ownerSessionID"]))
    return { ok: false, reason: "ownerSessionID-required" };
  if (!isNonEmptyString(r["returnSessionID"]))
    return { ok: false, reason: "returnSessionID-required" };
  return {
    ok: true,
    data: {
      commandID: r["commandID"],
      ownerSessionID: r["ownerSessionID"],
      returnSessionID: r["returnSessionID"]
    }
  };
}
function terminalRoutePayload(commandID, ownerSessionID, returnSessionID) {
  return { commandID, ownerSessionID, returnSessionID };
}
function isTerminalRouteConsistent(data) {
  return data.ownerSessionID === data.returnSessionID;
}
function currentRouteSessionID(api) {
  try {
    const current = api.route?.current;
    if (current?.name === "session" && current.params?.sessionID)
      return current.params.sessionID;
  } catch {}
  return;
}
function filterCommandsByOwner(commands, ownerSessionID) {
  if (!ownerSessionID)
    return [];
  return commands.filter((c) => c.ownerSessionID === ownerSessionID);
}
function resolveOpenTarget(input) {
  const sel = input.selection;
  if (!sel)
    return { kind: "none", reason: "no-selection" };
  if (sel.kind === "goal") {
    if (!sel.workerSessionID)
      return { kind: "none", reason: "no-worker-session" };
    return { kind: "goal", workerSessionID: sel.workerSessionID };
  }
  if (!sel.commandID)
    return { kind: "none", reason: "no-command" };
  if (!input.ownerSessionID)
    return { kind: "none", reason: "owner-required" };
  if (!input.returnSessionID)
    return { kind: "none", reason: "return-required" };
  return {
    kind: "command",
    data: {
      commandID: sel.commandID,
      ownerSessionID: input.ownerSessionID,
      returnSessionID: input.returnSessionID
    }
  };
}

// src/domain/command-await.ts
var TERMINAL_COMMAND_STATUSES = [
  "exited",
  "terminated",
  "missing"
];
var MAX_AWAIT_TAIL_BYTES = 4 * 1024;

// src/tui/dashboard-view.ts
function toggleDashboardView(view) {
  return view === "goals" ? "commands" : "goals";
}
function dashboardViewForKey(key) {
  if (key === "h")
    return "goals";
  if (key === "l")
    return "commands";
  return;
}
function moveDashboardSelection(sel, move, goalCount, commandCount) {
  if (sel.view === "goals") {
    const max = Math.max(0, goalCount - 1);
    const cur = Math.min(sel.goalIndex, max);
    switch (move) {
      case "down":
        return { ...sel, goalIndex: Math.min(max, cur + 1) };
      case "up":
        return { ...sel, goalIndex: Math.max(0, cur - 1) };
      case "first":
        return { ...sel, goalIndex: 0 };
      case "last":
        return { ...sel, goalIndex: max };
    }
  }
  const max = Math.max(0, commandCount - 1);
  const cur = Math.min(sel.commandIndex, max);
  switch (move) {
    case "down":
      return { ...sel, commandIndex: Math.min(max, cur + 1) };
    case "up":
      return { ...sel, commandIndex: Math.max(0, cur - 1) };
    case "first":
      return { ...sel, commandIndex: 0 };
    case "last":
      return { ...sel, commandIndex: max };
  }
}
function resolveDashboardOpen(lists, sel, ownerSessionID, returnSessionID, showCompleted = false) {
  if (sel.view === "goals") {
    const goal = lists.goals[sel.goalIndex];
    return resolveOpenTarget({ selection: goal ? { kind: "goal", workerSessionID: goal.workerSessionID } : null, ownerSessionID, returnSessionID });
  }
  const ownerCommands = visibleOwnerCommands(lists.commands, ownerSessionID, showCompleted);
  const cmd = ownerCommands[sel.commandIndex];
  return resolveOpenTarget({
    selection: cmd ? { kind: "command", commandID: cmd.id } : null,
    ownerSessionID,
    returnSessionID
  });
}
function visibleOwnerCommands(commands, ownerSessionID, showCompleted = false) {
  const owned = filterCommandsByOwner(commands ?? [], ownerSessionID);
  if (showCompleted)
    return owned;
  const terminal = TERMINAL_COMMAND_STATUSES;
  return owned.filter((c) => !terminal.includes(c.status));
}

// src/tui/dashboard.tsx
import { randomUUID as randomUUID2 } from "crypto";

// src/tui/dashboard-refresh.ts
function createDashboardRefresh(client, publish, onError) {
  let disposed = false;
  let pending = false;
  let flight;
  function refresh() {
    if (disposed)
      return Promise.resolve();
    pending = true;
    if (flight)
      return flight;
    flight = (async () => {
      while (pending && !disposed) {
        pending = false;
        try {
          const state = await client.getState();
          if (disposed)
            break;
          const events = await client.getEvents(20);
          if (!disposed)
            publish(state, events);
        } catch (error) {
          if (!disposed)
            onError(error);
        }
      }
    })().finally(() => {
      flight = undefined;
    });
    return flight;
  }
  return {
    refresh,
    dispose() {
      disposed = true;
      pending = false;
    }
  };
}

// src/tui/dashboard.tsx
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
function commandStatusColor(status, theme) {
  switch (status) {
    case "running":
      return theme.success;
    case "exited":
      return theme.info;
    case "terminated":
      return theme.warning;
    case "missing":
      return theme.error;
    default:
      return theme.text;
  }
}
function commandStatusIcon(status) {
  switch (status) {
    case "running":
      return "\u25B6";
    case "exited":
      return "\u2713";
    case "terminated":
      return "\u25A0";
    case "missing":
      return "?";
    default:
      return "\u25CB";
  }
}
function commandStatusLabel(status) {
  switch (status) {
    case "running":
      return {
        short: "RUNNING",
        hint: "process is executing"
      };
    case "exited":
      return {
        short: "EXITED",
        hint: "process ended on its own"
      };
    case "terminated":
      return {
        short: "TERMINATED",
        hint: "stopped via interrupt/terminate"
      };
    case "missing":
      return {
        short: "MISSING",
        hint: "no live execution found \u2014 reconcile"
      };
    default:
      return {
        short: String(status).toUpperCase(),
        hint: ""
      };
  }
}
function commandBorderColor(status, theme) {
  return commandStatusColor(status, theme);
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
function DashboardList(props) {
  let scroll;
  let followPending = true;
  createEffect(() => {
    props.count;
    props.selectedID;
    followPending = true;
    scroll?.requestRender();
  });
  return (() => {
    var _el$ = _$createElement("scrollbox");
    _$use((el) => {
      scroll = el;
    }, _el$);
    _$setProp(_el$, "scrollX", false);
    _$setProp(_el$, "scrollY", true);
    _$setProp(_el$, "stickyScroll", false);
    _$setProp(_el$, "renderAfter", () => {
      if (!followPending || !scroll)
        return;
      followPending = false;
      if (props.selectedID)
        scroll.scrollChildIntoView(props.selectedID);
    });
    _$insert(_el$, () => props.children);
    _$effect((_$p) => _$setProp(_el$, "height", Math.min(props.count, 10), _$p));
    return _el$;
  })();
}
function DashboardRow(props) {
  let text;
  return (() => {
    var _el$2 = _$createElement("box"), _el$3 = _$createElement("text");
    _$insertNode(_el$2, _el$3);
    _$setProp(_el$2, "flexDirection", "row");
    _$setProp(_el$2, "paddingLeft", 1);
    _$setProp(_el$2, "paddingRight", 1);
    _$setProp(_el$2, "height", 1);
    _$setProp(_el$2, "flexShrink", 0);
    _$setProp(_el$2, "overflow", "hidden");
    _$setProp(_el$2, "onMouseScroll", () => {
      if (text) {
        text.scrollX = 0;
        text.scrollY = 0;
      }
    });
    _$use((el) => {
      text = el;
    }, _el$3);
    _$setProp(_el$3, "wrapMode", "none");
    _$setProp(_el$3, "truncate", true);
    _$setProp(_el$3, "minWidth", 0);
    _$setProp(_el$3, "flexShrink", 1);
    _$insert(_el$3, () => props.children);
    _$effect((_p$) => {
      var { id: _v$, backgroundColor: _v$2 } = props;
      _v$ !== _p$.e && (_p$.e = _$setProp(_el$2, "id", _v$, _p$.e));
      _v$2 !== _p$.t && (_p$.t = _$setProp(_el$2, "backgroundColor", _v$2, _p$.t));
      return _p$;
    }, {
      e: undefined,
      t: undefined
    });
    return _el$2;
  })();
}
function LoopDashboard(props) {
  const theme = () => props.api.theme.current;
  const [mode, setMode] = createSignal("normal");
  const [selected, setSelected] = createSignal(0);
  const [commandInput, setCommandInput] = createSignal("");
  const [statusText, setStatusText] = createSignal("Tab goals/commands \xB7 : send/command \xB7 ? help \xB7 c toggle done \xB7 o open \xB7 q close");
  const [tab, setTab] = createSignal(props.initialView ?? "goals");
  const [cmdSelected, setCmdSelected] = createSignal(0);
  const ownerSessionID = () => props.ownerSessionID ?? currentRouteSessionID(props.api);
  const ownerCommands = () => visibleOwnerCommands(state()?.commands, ownerSessionID(), showCompleted());
  const hiddenFinishedCommands = () => {
    if (showCompleted())
      return 0;
    const terminal = ["exited", "terminated", "missing"];
    return (state()?.commands ?? []).filter((c) => c.ownerSessionID === ownerSessionID() && terminal.includes(c.status)).length;
  };
  const [state, setState] = createSignal(null);
  const [events, setEvents] = createSignal([]);
  const [selectedGoal, setSelectedGoal] = createSignal(null);
  const [showLogs, setShowLogs] = createSignal(false);
  const [showHelp, setShowHelp] = createSignal(false);
  const [showCompleted, setShowCompleted] = createSignal(false);
  const [clock, setClock] = createSignal(Date.now());
  const [agentIndex, setAgentIndex] = createSignal({});
  let inputEl;
  let focusTimer;
  let disposed = false;
  const client = createControlClient(props.directory);
  const popMode = props.api.mode.push("loopd.dashboard");
  function focusInput() {
    if (disposed)
      return;
    if (focusTimer)
      clearTimeout(focusTimer);
    focusTimer = setTimeout(() => {
      if (disposed)
        return;
      const current = props.api.renderer.currentFocusedRenderable;
      if (current && current !== inputEl)
        current.blur();
      inputEl?.focus();
    }, 10);
  }
  const refreshQueue = createDashboardRefresh(client, (s, logs) => {
    batch(() => {
      setState(s);
      setEvents(logs);
    });
  }, (e) => {
    setStatusText(`Error: ${e instanceof Error ? e.message : String(e)}`);
  });
  const refresh = refreshQueue.refresh;
  refresh();
  async function refreshAgents() {
    try {
      const res = await props.api.client?.app?.agents?.();
      const list = res?.data ?? res ?? [];
      if (!disposed && Array.isArray(list))
        setAgentIndex(indexAgents(list));
    } catch {}
  }
  refreshAgents();
  const unsubs = [props.api.event.on("session.idle", () => refresh()), props.api.event.on("session.status", () => refresh()), props.api.event.on("session.error", () => refresh()), props.api.event.on("session.compacted", () => refresh()), setInterval(refresh, 1e4), setInterval(() => setClock(Date.now()), 500)];
  onCleanup(() => {
    disposed = true;
    refreshQueue.dispose();
    popMode();
    if (focusTimer)
      clearTimeout(focusTimer);
    for (const u of unsubs)
      typeof u === "function" ? u() : clearInterval(u);
  });
  onMount(() => {
    focusInput();
  });
  createEffect(() => {
    mode();
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
    if (!props.api.ui.dialog.open)
      return;
    const active = (() => {
      try {
        return props.isActive?.() ?? props.api.ui.dialog.open;
      } catch {
        return props.api.ui.dialog.open;
      }
    })();
    if (!active)
      return;
    const isColon = name === ":" || seq === ":" || raw === ":" || seq.includes(":") || raw.includes(":") || name === ";" || name === "colon";
    const isQuestion = name === "?" || seq === "?" || raw === "?" || seq.includes("?") || raw.includes("?");
    if (mode() === "insert") {
      if (isEnterKey(evt)) {
        prevent(evt);
        executeCommand(commandInput());
        return;
      }
      if (isEscapeKey(evt) || isCtrlN(evt)) {
        prevent(evt);
        returnToNormalMode();
        return;
      }
      return;
    }
    if (isColon) {
      prevent(evt);
      enterInsertMode();
      return;
    }
    if (isQuestion) {
      prevent(evt);
      setShowHelp((value) => !value);
      return;
    }
    const key = raw || seq || name;
    if (tab() === "commands" && Boolean(evt.ctrl) && name === "c") {
      prevent(evt);
      const sel = selectedCommand();
      if (!sel) {
        setStatusText("No command selected.");
        return;
      }
      executeCommandRaw("cmd_interrupt", {
        commandID: sel.id
      }, sel.id);
      return;
    }
    if (key === "c") {
      prevent(evt);
      setShowCompleted((v) => {
        const next = !v;
        setStatusText(next ? `Showing finished ${tab() === "commands" ? "commands" : "goals"}.` : `Hiding finished ${tab() === "commands" ? "commands" : "goals"}.`);
        return next;
      });
      return;
    }
    const currentGoals = state()?.goals.filter((goal) => showCompleted() || goal.status !== "complete") || [];
    const currentCommands = ownerCommands();
    if (name === "tab") {
      prevent(evt);
      setTab((v) => toggleDashboardView(v));
      return;
    }
    const directionalView = dashboardViewForKey(key);
    if (directionalView !== undefined) {
      prevent(evt);
      setTab(directionalView);
      return;
    }
    function dashboardSelection() {
      return {
        view: tab(),
        goalIndex: selected(),
        commandIndex: cmdSelected()
      };
    }
    function applyMove(move) {
      const next = moveDashboardSelection(dashboardSelection(), move, currentGoals.length, currentCommands.length);
      setSelected(next.goalIndex);
      setCmdSelected(next.commandIndex);
    }
    if (name === "down" || key === "j") {
      prevent(evt);
      applyMove("down");
      return;
    }
    if (name === "up" || key === "k") {
      prevent(evt);
      applyMove("up");
      return;
    }
    if (key === "g") {
      prevent(evt);
      applyMove("first");
      return;
    }
    if (key === "G") {
      prevent(evt);
      applyMove("last");
      return;
    }
    if (tab() === "commands" && key === "X") {
      prevent(evt);
      killSelectedCommand();
      return;
    }
    if (tab() === "commands" && key === "R") {
      prevent(evt);
      restartSelectedCommand();
      return;
    }
    if (tab() === "commands" && key === "x") {
      prevent(evt);
      removeFinishedSelected();
      return;
    }
    const needsGoalsTab = ["p", "r", "A", "N", "model", "models", "agent", "agents"].includes(key);
    if (needsGoalsTab && tab() !== "goals") {
      prevent(evt);
      setStatusText("Goal controls need the Goals tab (Tab to switch).");
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
      const target = resolveDashboardOpen({
        goals: currentGoals,
        commands: state()?.commands ?? []
      }, dashboardSelection(), ownerSessionID(), currentRouteSessionID(props.api), showCompleted());
      if (target.kind === "goal") {
        props.api.route.navigate("session", {
          sessionID: target.workerSessionID
        });
        props.api.ui.dialog.clear();
      } else if (target.kind === "command") {
        if (props.onOpenCommand) {
          props.onOpenCommand(target.data);
        } else {
          try {
            props.api.route.navigate(TERMINAL_ROUTE_NAME, terminalRoutePayload(target.data.commandID, target.data.ownerSessionID, target.data.returnSessionID));
            props.api.ui.dialog.clear();
          } catch {
            setStatusText("Fullscreen route unavailable on this host.");
          }
        }
      } else {
        setStatusText(target.reason === "no-worker-session" ? "No worker session" : target.reason === "no-command" ? "No command selected." : target.reason === "owner-required" ? "No owning session \u2014 open disabled." : target.reason === "return-required" ? "No return session \u2014 open disabled." : "Nothing to open.");
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
  async function executeCommandRaw(command, args, commandID) {
    const owner = ownerSessionID();
    if (!owner) {
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
          ownerSessionID: owner
        }
      });
      setStatusText(r.ok ? r.message : `Error: ${r.message}`);
      if (r.ok)
        await refresh();
    } catch (e) {
      setStatusText(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  function selectedCommand() {
    return ownerCommands()[cmdSelected()] ?? null;
  }
  async function killSelectedCommand() {
    const sel = selectedCommand();
    if (!sel) {
      setStatusText("No command selected.");
      return;
    }
    await executeCommandRaw("cmd_kill", {
      commandID: sel.id
    }, sel.id);
  }
  async function restartSelectedCommand() {
    const sel = selectedCommand();
    if (!sel) {
      setStatusText("No command selected.");
      return;
    }
    await executeCommandRaw("cmd_restart", {
      commandID: sel.id
    }, sel.id);
  }
  function removeFinishedSelected() {
    const sel = selectedCommand();
    if (!sel) {
      setStatusText("No command selected.");
      return;
    }
    if (sel.status === "running") {
      setStatusText(`"${sel.title}" is still running \u2014 X force kill \xB7 :terminate graceful \xB7 q detach (keeps running).`);
      return;
    }
    executeCommandRaw("cmd_remove", {
      commandID: sel.id
    }, sel.id);
  }
  async function executeCommandTabCommand(verb, positional, raw) {
    switch (verb) {
      case "model":
      case "models":
      case "agent":
      case "agents":
        setStatusText(`:${verb} is only available on the Goals tab.`);
        return;
      case "new": {
        const argv = parseNewCommand(raw);
        if (!argv) {
          setStatusText("Usage: :new <command> [args...]");
          return;
        }
        const {
          command,
          cmdArgs
        } = argv;
        await executeCommandRaw("cmd_start", {
          title: command,
          command,
          cmdArgs
        });
        return;
      }
      case "interrupt":
        if (!selectedCommand()) {
          setStatusText("No command selected.");
          return;
        }
        await executeCommandRaw("cmd_interrupt", {
          commandID: selectedCommand().id
        }, selectedCommand().id);
        return;
      case "terminate":
        if (!selectedCommand()) {
          setStatusText("No command selected.");
          return;
        }
        await executeCommandRaw("cmd_terminate", {
          commandID: selectedCommand().id
        }, selectedCommand().id);
        return;
      case "kill":
        await killSelectedCommand();
        return;
      case "restart":
        await restartSelectedCommand();
        return;
      case "remove":
        if (!selectedCommand()) {
          setStatusText("No command selected.");
          return;
        }
        await executeCommandRaw("cmd_remove", {
          commandID: selectedCommand().id
        }, selectedCommand().id);
        return;
      case "logs":
        setShowLogs(!showLogs());
        return;
      case "help":
        setShowHelp(true);
        return;
      default: {
        if (selectedCommand()) {
          const payload = raw.endsWith(`
`) ? raw : `${raw}
`;
          await executeCommandRaw("cmd_write", {
            commandID: selectedCommand().id,
            input: payload
          }, selectedCommand().id);
        } else
          setStatusText(`Unknown: ${verb}. ? for help`);
      }
    }
  }
  async function executeCommand(cmd) {
    const parsed = parseCommand(cmd);
    if (!parsed) {
      setStatusText("Empty command");
      return;
    }
    if (tab() === "commands" && !["q", "close"].includes(parsed.command)) {
      await executeCommandTabCommand(parsed.command, parsed.positional, parsed.raw);
      returnToNormalMode();
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
        case "interactive": {
          if (!selectedGoal()) {
            setStatusText("No goal");
            break;
          }
          const next = !(selectedGoal().interactive === true);
          const r = await client.execute({
            version: 1,
            requestID: randomUUID2(),
            requestedAt: new Date().toISOString(),
            command: "set_interactive",
            goalID: selectedGoal().id,
            args: {
              interactive: next
            }
          });
          setStatusText(r.ok ? r.message : `Error: ${r.message}`);
          if (r.ok)
            await refresh();
          break;
        }
        case "agent": {
          if (!selectedGoal()) {
            setStatusText("No goal selected");
            break;
          }
          const agent = parsed.positional.join(" ").trim();
          if (!agent) {
            setStatusText("Usage: :agent <name> \u2014 :agents lists available agents.");
            break;
          }
          const r = await client.execute({
            version: 1,
            requestID: randomUUID2(),
            requestedAt: new Date().toISOString(),
            command: "switch_goal_identity",
            goalID: selectedGoal().id,
            args: {
              agent
            }
          });
          setStatusText(r.ok ? r.message : `Error: ${r.message}`);
          if (r.ok)
            await refresh();
          break;
        }
        case "agents": {
          const r = await client.execute({
            version: 1,
            requestID: randomUUID2(),
            requestedAt: new Date().toISOString(),
            command: "list_agents"
          });
          setStatusText(r.ok ? r.message : `Error: ${r.message}`);
          break;
        }
        case "model": {
          if (!selectedGoal()) {
            setStatusText("No goal selected");
            break;
          }
          const target = parsed.positional.join(" ").trim();
          if (!target) {
            setStatusText("Usage: :model <provider/model> \u2014 e.g. :model openai/gpt-5.6-sol. :models lists what's available.");
            break;
          }
          const r = await client.execute({
            version: 1,
            requestID: randomUUID2(),
            requestedAt: new Date().toISOString(),
            command: "switch_goal_identity",
            goalID: selectedGoal().id,
            args: {
              model: target
            }
          });
          setStatusText(r.ok ? r.message : `Error: ${r.message}`);
          if (r.ok)
            await refresh();
          break;
        }
        case "models": {
          const r = await client.execute({
            version: 1,
            requestID: randomUUID2(),
            requestedAt: new Date().toISOString(),
            command: "list_models"
          });
          setStatusText(r.ok ? r.message : `Error: ${r.message}`);
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
  createEffect(() => {
    setSelected(Math.max(0, Math.min(selected(), activeGoals().length - 1)));
    setCmdSelected(Math.max(0, Math.min(cmdSelected(), ownerCommands().length - 1)));
    setSelectedGoal(activeGoals()[selected()] || null);
  });
  function rowIdFor(goalID) {
    return `loopd-goal-${goalID}`;
  }
  return (() => {
    var _el$4 = _$createElement("box"), _el$5 = _$createElement("box"), _el$6 = _$createElement("box"), _el$7 = _$createElement("text"), _el$8 = _$createElement("span"), _el$0 = _$createElement("span"), _el$10 = _$createElement("span"), _el$11 = _$createTextNode(` `), _el$12 = _$createTextNode(` `), _el$13 = _$createElement("span"), _el$15 = _$createElement("span"), _el$16 = _$createElement("span"), _el$18 = _$createElement("span"), _el$20 = _$createElement("span"), _el$21 = _$createTextNode(` `), _el$22 = _$createTextNode(` acting now`), _el$23 = _$createElement("span"), _el$25 = _$createElement("span"), _el$26 = _$createElement("span"), _el$28 = _$createElement("span"), _el$30 = _$createElement("span"), _el$32 = _$createElement("span"), _el$34 = _$createElement("span"), _el$36 = _$createElement("span"), _el$38 = _$createElement("box"), _el$39 = _$createElement("text"), _el$40 = _$createElement("span"), _el$42 = _$createElement("box"), _el$52 = _$createElement("box"), _el$53 = _$createElement("text"), _el$54 = _$createElement("span"), _el$55 = _$createElement("input");
    _$insertNode(_el$4, _el$5);
    _$setProp(_el$4, "flexDirection", "column");
    _$setProp(_el$4, "width", "100%");
    _$setProp(_el$4, "alignItems", "center");
    _$setProp(_el$4, "padding", 1);
    _$insertNode(_el$5, _el$6);
    _$insertNode(_el$5, _el$42);
    _$insertNode(_el$5, _el$52);
    _$setProp(_el$5, "flexDirection", "column");
    _$setProp(_el$5, "width", "90%");
    _$setProp(_el$5, "border", true);
    _$setProp(_el$5, "padding", 1);
    _$insertNode(_el$6, _el$7);
    _$insertNode(_el$6, _el$38);
    _$setProp(_el$6, "flexDirection", "row");
    _$setProp(_el$6, "justifyContent", "space-between");
    _$setProp(_el$6, "alignItems", "center");
    _$setProp(_el$6, "padding", 0);
    _$setProp(_el$6, "flexShrink", 0);
    _$setProp(_el$6, "gap", 1);
    _$insertNode(_el$7, _el$8);
    _$insertNode(_el$7, _el$0);
    _$insertNode(_el$7, _el$10);
    _$insertNode(_el$7, _el$13);
    _$insertNode(_el$7, _el$15);
    _$insertNode(_el$7, _el$16);
    _$insertNode(_el$7, _el$18);
    _$insertNode(_el$7, _el$20);
    _$insertNode(_el$7, _el$23);
    _$insertNode(_el$7, _el$25);
    _$insertNode(_el$7, _el$26);
    _$insertNode(_el$7, _el$28);
    _$insertNode(_el$7, _el$30);
    _$insertNode(_el$7, _el$32);
    _$insertNode(_el$7, _el$34);
    _$insertNode(_el$7, _el$36);
    _$insertNode(_el$8, _$createTextNode(`\u2B22 Loop Dashboard`));
    _$insertNode(_el$0, _$createTextNode(` \u2502 `));
    _$insertNode(_el$10, _el$11);
    _$insertNode(_el$10, _el$12);
    _$insert(_el$10, () => mode().toUpperCase(), _el$12);
    _$insertNode(_el$13, _$createTextNode(` \u2502 `));
    _$insert(_el$15, () => activeGoals().length);
    _$insertNode(_el$16, _$createTextNode(` open`));
    _$insertNode(_el$18, _$createTextNode(` \u2502 `));
    _$insertNode(_el$20, _el$21);
    _$insertNode(_el$20, _el$22);
    _$insert(_el$20, (() => {
      var _c$ = _$memo(() => runningCount() > 0);
      return () => _c$() ? runningFrame() : "\u25CB";
    })(), _el$21);
    _$insert(_el$20, runningCount, _el$22);
    _$insertNode(_el$23, _$createTextNode(` \u2502 `));
    _$insert(_el$25, () => state()?.goals.filter((g) => g.status === "complete").length || 0);
    _$insertNode(_el$26, _$createTextNode(` done`));
    _$insertNode(_el$28, _$createTextNode(` \u2502 `));
    _$insertNode(_el$30, _$createTextNode(`[Goals]`));
    _$insertNode(_el$32, _$createTextNode(` `));
    _$insertNode(_el$34, _$createTextNode(`[Commands]`));
    _$insertNode(_el$36, _$createTextNode(` (Tab)`));
    _$insertNode(_el$38, _el$39);
    _$setProp(_el$38, "flexDirection", "row");
    _$setProp(_el$38, "alignItems", "center");
    _$setProp(_el$38, "paddingLeft", 1);
    _$setProp(_el$38, "paddingRight", 1);
    _$setProp(_el$38, "flexShrink", 0);
    _$spread(_el$38, _$mergeProps({
      get backgroundColor() {
        return theme().error;
      }
    }, {
      onMouseDown: handleBugReport
    }), true);
    _$insertNode(_el$39, _el$40);
    _$insertNode(_el$40, _$createTextNode(`Bug Report`));
    _$setProp(_el$40, "style", {
      fg: "white",
      bold: true
    });
    _$setProp(_el$42, "flexDirection", "column");
    _$setProp(_el$42, "flexShrink", 1);
    _$setProp(_el$42, "minHeight", 0);
    _$setProp(_el$42, "overflow", "hidden");
    _$insert(_el$42, _$createComponent(Show, {
      get when() {
        return showHelp();
      },
      get children() {
        var _el$43 = _$createElement("box"), _el$44 = _$createElement("text"), _el$45 = _$createElement("span");
        _$insertNode(_el$43, _el$44);
        _$setProp(_el$43, "flexDirection", "column");
        _$setProp(_el$43, "padding", 1);
        _$setProp(_el$43, "border", true);
        _$setProp(_el$43, "borderColor", "yellow");
        _$setProp(_el$43, "flexShrink", 0);
        _$setProp(_el$43, "maxHeight", 17);
        _$setProp(_el$43, "overflow", "hidden");
        _$insertNode(_el$44, _el$45);
        _$setProp(_el$45, "style", {
          fg: "yellow",
          bold: true
        });
        _$insert(_el$45, () => tab() === "commands" ? "\u2501\u2501\u2501 Commands: ? help  : insert  c toggle done  X kill  R restart  x remove-done  o fullscreen  q close \u2501\u2501\u2501" : "\u2501\u2501\u2501 Keys: ? toggle help  c toggle done  : insert  Ctrl+N normal  o open  A abort worker  N nudge  q close \u2501\u2501\u2501");
        _$insert(_el$44, _$createComponent(For, {
          get each() {
            return (tab() === "commands" ? commandTabHelp() : commandHelp()).split(`
`);
          },
          children: (line) => {
            if (line.startsWith("Modes:") || line.startsWith("Nav:")) {
              const label = line.startsWith("Modes:") ? "Modes:" : "Nav:";
              const rest = line.slice(label.length).trim();
              const segments = rest.split(" | ");
              return [`
`, (() => {
                var _el$56 = _$createElement("span");
                _$insert(_el$56, label);
                _$effect((_$p) => _$setProp(_el$56, "style", {
                  fg: theme().primary,
                  bold: true
                }, _$p));
                return _el$56;
              })(), (() => {
                var _el$57 = _$createElement("span");
                _$insertNode(_el$57, _$createTextNode(` `));
                _$effect((_$p) => _$setProp(_el$57, "style", {
                  fg: theme().textMuted
                }, _$p));
                return _el$57;
              })(), _$createComponent(For, {
                each: segments,
                children: (seg, idx) => {
                  const hasArrow = seg.includes("\u2192");
                  if (hasArrow) {
                    const [k, d] = seg.split("\u2192").map((s) => s.trim());
                    return [_$memo(() => _$memo(() => idx() > 0)() && (() => {
                      var _el$63 = _$createElement("span");
                      _$insertNode(_el$63, _$createTextNode(` | `));
                      _$effect((_$p) => _$setProp(_el$63, "style", {
                        fg: theme().textMuted
                      }, _$p));
                      return _el$63;
                    })()), (() => {
                      var _el$59 = _$createElement("span");
                      _$insert(_el$59, k);
                      _$effect((_$p) => _$setProp(_el$59, "style", {
                        fg: theme().warning,
                        bold: true
                      }, _$p));
                      return _el$59;
                    })(), (() => {
                      var _el$60 = _$createElement("span");
                      _$insertNode(_el$60, _$createTextNode(` \u2192 `));
                      _$effect((_$p) => _$setProp(_el$60, "style", {
                        fg: theme().textMuted
                      }, _$p));
                      return _el$60;
                    })(), (() => {
                      var _el$62 = _$createElement("span");
                      _$insert(_el$62, d);
                      _$effect((_$p) => _$setProp(_el$62, "style", {
                        fg: theme().text
                      }, _$p));
                      return _el$62;
                    })()];
                  }
                  const sp = seg.indexOf(" ");
                  const k = sp > 0 ? seg.slice(0, sp) : seg;
                  const d = sp > 0 ? seg.slice(sp + 1) : "";
                  return [_$memo(() => _$memo(() => idx() > 0)() && (() => {
                    var _el$66 = _$createElement("span");
                    _$insertNode(_el$66, _$createTextNode(` | `));
                    _$effect((_$p) => _$setProp(_el$66, "style", {
                      fg: theme().textMuted
                    }, _$p));
                    return _el$66;
                  })()), (() => {
                    var _el$65 = _$createElement("span");
                    _$insert(_el$65, k);
                    _$effect((_$p) => _$setProp(_el$65, "style", {
                      fg: theme().warning,
                      bold: true
                    }, _$p));
                    return _el$65;
                  })(), d && (() => {
                    var _el$68 = _$createElement("span"), _el$69 = _$createTextNode(` `);
                    _$insertNode(_el$68, _el$69);
                    _$insert(_el$68, d, null);
                    _$effect((_$p) => _$setProp(_el$68, "style", {
                      fg: theme().text
                    }, _$p));
                    return _el$68;
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
                var _el$70 = _$createElement("span");
                _$insert(_el$70, indent);
                _$effect((_$p) => _$setProp(_el$70, "style", {
                  fg: theme().textMuted
                }, _$p));
                return _el$70;
              })(), (() => {
                var _el$71 = _$createElement("span");
                _$insert(_el$71, key);
                _$effect((_$p) => _$setProp(_el$71, "style", {
                  fg: theme().warning,
                  bold: true
                }, _$p));
                return _el$71;
              })(), desc && [(() => {
                var _el$72 = _$createElement("span");
                _$insertNode(_el$72, _$createTextNode(` `));
                _$effect((_$p) => _$setProp(_el$72, "style", {
                  fg: theme().textMuted
                }, _$p));
                return _el$72;
              })(), (() => {
                var _el$74 = _$createElement("span");
                _$insert(_el$74, desc);
                _$effect((_$p) => _$setProp(_el$74, "style", {
                  fg: theme().textMuted
                }, _$p));
                return _el$74;
              })()]];
            }
            const isHeader = line.startsWith("Commands");
            return [`
`, (() => {
              var _el$75 = _$createElement("span");
              _$insert(_el$75, line);
              _$effect((_$p) => _$setProp(_el$75, "style", {
                fg: isHeader ? theme().primary : theme().textMuted,
                bold: isHeader
              }, _$p));
              return _el$75;
            })()];
          }
        }), null);
        _$effect((_$p) => _$setProp(_el$43, "backgroundColor", theme().background, _$p));
        return _el$43;
      }
    }), null);
    _$insert(_el$42, _$createComponent(Show, {
      get when() {
        return tab() === "goals";
      },
      get children() {
        return [_$createComponent(Show, {
          get when() {
            return activeGoals().length > 0;
          },
          get fallback() {
            return (() => {
              var _el$76 = _$createElement("box"), _el$77 = _$createElement("text"), _el$78 = _$createElement("span"), _el$80 = _$createElement("span"), _el$82 = _$createElement("span"), _el$84 = _$createElement("text"), _el$85 = _$createElement("span"), _el$87 = _$createElement("span"), _el$89 = _$createElement("span"), _el$91 = _$createElement("span"), _el$93 = _$createElement("span"), _el$95 = _$createElement("span"), _el$97 = _$createElement("span");
              _$insertNode(_el$76, _el$77);
              _$insertNode(_el$76, _el$84);
              _$setProp(_el$76, "flexDirection", "column");
              _$setProp(_el$76, "gap", 1);
              _$setProp(_el$76, "padding", 1);
              _$insertNode(_el$77, _el$78);
              _$insertNode(_el$77, _el$80);
              _$insertNode(_el$77, _el$82);
              _$insertNode(_el$78, _$createTextNode(`No active goals.`));
              _$insertNode(_el$80, _$createTextNode(` /goal`));
              _$insertNode(_el$82, _$createTextNode(` in parent chat to create one.`));
              _$insertNode(_el$84, _el$85);
              _$insertNode(_el$84, _el$87);
              _$insertNode(_el$84, _el$89);
              _$insertNode(_el$84, _el$91);
              _$insertNode(_el$84, _el$93);
              _$insertNode(_el$84, _el$95);
              _$insertNode(_el$84, _el$97);
              _$insertNode(_el$85, _$createTextNode(`Tip: `));
              _$insertNode(_el$87, _$createTextNode(`:send`));
              _$insertNode(_el$89, _$createTextNode(` to steer the worker \xB7 `));
              _$insertNode(_el$91, _$createTextNode(`o`));
              _$insertNode(_el$93, _$createTextNode(` to open child \xB7 `));
              _$insertNode(_el$95, _$createTextNode(`:force`));
              _$insertNode(_el$97, _$createTextNode(` to complete manually.`));
              _$effect((_p$) => {
                var _v$28 = {
                  fg: theme().textMuted
                }, _v$29 = {
                  fg: theme().accent
                }, _v$30 = {
                  fg: theme().textMuted
                }, _v$31 = {
                  fg: theme().textMuted
                }, _v$32 = {
                  fg: theme().warning
                }, _v$33 = {
                  fg: theme().textMuted
                }, _v$34 = {
                  fg: theme().warning
                }, _v$35 = {
                  fg: theme().textMuted
                }, _v$36 = {
                  fg: theme().warning
                }, _v$37 = {
                  fg: theme().textMuted
                };
                _v$28 !== _p$.e && (_p$.e = _$setProp(_el$78, "style", _v$28, _p$.e));
                _v$29 !== _p$.t && (_p$.t = _$setProp(_el$80, "style", _v$29, _p$.t));
                _v$30 !== _p$.a && (_p$.a = _$setProp(_el$82, "style", _v$30, _p$.a));
                _v$31 !== _p$.o && (_p$.o = _$setProp(_el$85, "style", _v$31, _p$.o));
                _v$32 !== _p$.i && (_p$.i = _$setProp(_el$87, "style", _v$32, _p$.i));
                _v$33 !== _p$.n && (_p$.n = _$setProp(_el$89, "style", _v$33, _p$.n));
                _v$34 !== _p$.s && (_p$.s = _$setProp(_el$91, "style", _v$34, _p$.s));
                _v$35 !== _p$.h && (_p$.h = _$setProp(_el$93, "style", _v$35, _p$.h));
                _v$36 !== _p$.r && (_p$.r = _$setProp(_el$95, "style", _v$36, _p$.r));
                _v$37 !== _p$.d && (_p$.d = _$setProp(_el$97, "style", _v$37, _p$.d));
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
              return _el$76;
            })();
          },
          get children() {
            return _$createComponent(DashboardList, {
              get count() {
                return activeGoals().length;
              },
              get selectedID() {
                return _$memo(() => !!activeGoals()[selected()])() ? rowIdFor(activeGoals()[selected()].id) : undefined;
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
                      const ratio = runtime().budgetTurnCount / maxTurns;
                      if (ratio >= 1)
                        return theme().error;
                      if (ratio >= 0.8)
                        return theme().warning;
                      return phaseColor(runtime().phase || "idle", theme());
                    };
                    return _$createComponent(DashboardRow, {
                      get id() {
                        return rowIdFor(goal.id);
                      },
                      get backgroundColor() {
                        return _$memo(() => !!isActive())() ? theme().backgroundElement : undefined;
                      },
                      get children() {
                        return [(() => {
                          var _el$99 = _$createElement("span");
                          _$insert(_el$99, (() => {
                            var _c$2 = _$memo(() => !!isActive());
                            return () => _c$2() ? `\u25B6 ${statusIcon(goal.status)} ${goal.name}` : `  ${statusIcon(goal.status)} ${goal.name}`;
                          })());
                          _$effect((_$p) => _$setProp(_el$99, "style", {
                            fg: statusColor(goal.status, theme()),
                            bold: isActive()
                          }, _$p));
                          return _el$99;
                        })(), (() => {
                          var _el$100 = _$createElement("span");
                          _$insertNode(_el$100, _$createTextNode(` \u2502 `));
                          _$effect((_$p) => _$setProp(_el$100, "style", {
                            fg: theme().textMuted
                          }, _$p));
                          return _el$100;
                        })(), (() => {
                          var _el$102 = _$createElement("span");
                          _$insertNode(_el$102, _$createTextNode(`Goal `));
                          _$effect((_$p) => _$setProp(_el$102, "style", {
                            fg: theme().textMuted
                          }, _$p));
                          return _el$102;
                        })(), (() => {
                          var _el$104 = _$createElement("span");
                          _$insert(_el$104, () => goalStatusLabel(goal.status).short.toUpperCase());
                          _$effect((_$p) => _$setProp(_el$104, "style", {
                            fg: statusColor(goal.status, theme()),
                            bold: true
                          }, _$p));
                          return _el$104;
                        })(), _$memo(() => _$memo(() => !!runtime())() && [(() => {
                          var _el$105 = _$createElement("span");
                          _$insertNode(_el$105, _$createTextNode(` \u2502 Worker `));
                          _$effect((_$p) => _$setProp(_el$105, "style", {
                            fg: theme().textMuted
                          }, _$p));
                          return _el$105;
                        })(), (() => {
                          var _el$107 = _$createElement("span"), _el$108 = _$createTextNode(` `);
                          _$insertNode(_el$107, _el$108);
                          _$insert(_el$107, (() => {
                            var _c$3 = _$memo(() => runtime().phase === "running");
                            return () => _c$3() ? runningFrame() : phaseIcon(runtime().phase);
                          })(), _el$108);
                          _$insert(_el$107, () => phaseLabel(runtime().phase).short.toUpperCase(), null);
                          _$effect((_$p) => _$setProp(_el$107, "style", {
                            fg: turnColor(),
                            bold: runtime().phase === "running"
                          }, _$p));
                          return _el$107;
                        })(), (() => {
                          var _el$109 = _$createElement("span"), _el$110 = _$createTextNode(` `);
                          _$insertNode(_el$109, _el$110);
                          _$insert(_el$109, () => runtime().budgetTurnCount, null);
                          _$insert(_el$109, maxTurns ? `/${maxTurns}` : "", null);
                          _$effect((_$p) => _$setProp(_el$109, "style", {
                            fg: turnColor()
                          }, _$p));
                          return _el$109;
                        })(), (() => {
                          var _el$111 = _$createElement("span"), _el$112 = _$createTextNode(` `);
                          _$insertNode(_el$111, _el$112);
                          _$insert(_el$111, () => ageLabel(runtime().lastProgressAt || runtime().lastRunAt, clock()), null);
                          _$effect((_$p) => _$setProp(_el$111, "style", {
                            fg: theme().textMuted
                          }, _$p));
                          return _el$111;
                        })()]), _$memo(() => _$memo(() => !!(runtime() && runtime().consecutiveFailures > 0))() && (() => {
                          var _el$113 = _$createElement("span"), _el$114 = _$createTextNode(` \u2502 \u26A0 `), _el$115 = _$createTextNode(` fail`);
                          _$insertNode(_el$113, _el$114);
                          _$insertNode(_el$113, _el$115);
                          _$insert(_el$113, () => runtime().consecutiveFailures, _el$115);
                          _$effect((_$p) => _$setProp(_el$113, "style", {
                            fg: theme().error,
                            bold: true
                          }, _$p));
                          return _el$113;
                        })()), _$memo(() => _$memo(() => !!(runtime() && (runtime().noProgressCount || 0) > 0))() && (() => {
                          var _el$116 = _$createElement("span"), _el$117 = _$createTextNode(` \u2502 `), _el$118 = _$createTextNode(` no-progress`);
                          _$insertNode(_el$116, _el$117);
                          _$insertNode(_el$116, _el$118);
                          _$insert(_el$116, () => runtime().noProgressCount, _el$118);
                          _$effect((_$p) => _$setProp(_el$116, "style", {
                            fg: theme().warning
                          }, _$p));
                          return _el$116;
                        })()), _$memo(() => _$memo(() => !!(runtime() && runtime().evaluatorRejectionCount > 0))() && (() => {
                          var _el$119 = _$createElement("span"), _el$120 = _$createTextNode(` \u2502 \u26A0 `), _el$121 = _$createTextNode(` rejected`);
                          _$insertNode(_el$119, _el$120);
                          _$insertNode(_el$119, _el$121);
                          _$insert(_el$119, () => String(runtime().evaluatorRejectionCount), _el$121);
                          _$effect((_$p) => _$setProp(_el$119, "style", {
                            fg: theme().warning,
                            bold: true
                          }, _$p));
                          return _el$119;
                        })()), _$memo(() => _$memo(() => !!(runtime() && runtime().unknownStatusCount >= 3))() && (() => {
                          var _el$122 = _$createElement("span");
                          _$insertNode(_el$122, _$createTextNode(` \u2502 \u26A0\uFE0F UNREACHABLE`));
                          _$effect((_$p) => _$setProp(_el$122, "style", {
                            fg: theme().error,
                            bold: true
                          }, _$p));
                          return _el$122;
                        })()), _$memo(() => _$memo(() => !!(runtime() && runtime().phase === "idle" && runtime().activeRunID))() && (() => {
                          var _el$124 = _$createElement("span");
                          _$insertNode(_el$124, _$createTextNode(` \u2502 \u26A0\uFE0F STALE LEASE`));
                          _$effect((_$p) => _$setProp(_el$124, "style", {
                            fg: theme().error,
                            bold: true
                          }, _$p));
                          return _el$124;
                        })()), _$memo(() => _$memo(() => goal.interactive === true)() && (() => {
                          var _el$126 = _$createElement("span");
                          _$insertNode(_el$126, _$createTextNode(` \u2502 \u270B MANUAL`));
                          _$effect((_$p) => _$setProp(_el$126, "style", {
                            fg: theme().accent,
                            bold: true
                          }, _$p));
                          return _el$126;
                        })()), _$memo(() => _$memo(() => !!goal.config.model)() && (() => {
                          var _el$128 = _$createElement("span"), _el$129 = _$createTextNode(` \u2502 \uD83E\uDDE0 `);
                          _$insertNode(_el$128, _el$129);
                          _$insert(_el$128, () => goal.config.model, null);
                          _$effect((_$p) => _$setProp(_el$128, "style", {
                            fg: theme().info
                          }, _$p));
                          return _el$128;
                        })()), _$memo(() => _$memo(() => !!goal.config.agent)() && (() => {
                          var _el$130 = _$createElement("span"), _el$131 = _$createTextNode(` \u2502 \uD83E\uDD16 `);
                          _$insertNode(_el$130, _el$131);
                          _$insert(_el$130, () => goal.config.agent, null);
                          _$effect((_$p) => _$setProp(_el$130, "style", {
                            fg: theme().info
                          }, _$p));
                          return _el$130;
                        })()), _$memo(() => _$memo(() => !!(runtime() && runtime().retryAfter))() && (() => {
                          var _el$132 = _$createElement("span"), _el$133 = _$createTextNode(` \u2502 \u21BB `);
                          _$insertNode(_el$132, _el$133);
                          _$insert(_el$132, () => countdownLabel(runtime().retryAfter, clock()), null);
                          _$effect((_$p) => _$setProp(_el$132, "style", {
                            fg: theme().accent
                          }, _$p));
                          return _el$132;
                        })()), _$memo(() => _$memo(() => !!(runtime() && runtime().nextRunAt))() && (() => {
                          var _el$134 = _$createElement("span"), _el$135 = _$createTextNode(` \u2502 \u23F0 `);
                          _$insertNode(_el$134, _el$135);
                          _$insert(_el$134, () => countdownLabel(runtime().nextRunAt, clock()), null);
                          _$effect((_$p) => _$setProp(_el$134, "style", {
                            fg: theme().accent
                          }, _$p));
                          return _el$134;
                        })())];
                      }
                    });
                  }
                });
              }
            });
          }
        }), _$createComponent(Show, {
          get when() {
            return selectedGoal();
          },
          children: (goal) => {
            const rt = () => state()?.runtimes.find((r) => r.goalID === goal().id);
            const lp = () => goal().lastProgress;
            const blk = () => goal().blocker;
            return (() => {
              var _el$136 = _$createElement("box"), _el$137 = _$createElement("text"), _el$138 = _$createElement("span"), _el$139 = _$createTextNode(` `), _el$140 = _$createElement("span"), _el$142 = _$createElement("span"), _el$143 = _$createTextNode(` \u2014 `), _el$144 = _$createTextNode(`
`), _el$145 = _$createElement("span"), _el$146 = _$createTextNode(`
`), _el$147 = _$createElement("span"), _el$149 = _$createElement("span");
              _$insertNode(_el$136, _el$137);
              _$setProp(_el$136, "flexDirection", "column");
              _$setProp(_el$136, "border", true);
              _$setProp(_el$136, "padding", 1);
              _$setProp(_el$136, "flexShrink", 0);
              _$setProp(_el$136, "maxHeight", 13);
              _$insertNode(_el$137, _el$138);
              _$insertNode(_el$137, _el$140);
              _$insertNode(_el$137, _el$142);
              _$insertNode(_el$137, _el$144);
              _$insertNode(_el$137, _el$145);
              _$insertNode(_el$137, _el$146);
              _$insertNode(_el$137, _el$147);
              _$insertNode(_el$137, _el$149);
              _$insertNode(_el$138, _el$139);
              _$insert(_el$138, () => statusIcon(goal().status), _el$139);
              _$insert(_el$138, () => goal().name, null);
              _$insertNode(_el$140, _$createTextNode(` Goal `));
              _$insertNode(_el$142, _el$143);
              _$insert(_el$142, () => goalStatusLabel(goal().status).short, _el$143);
              _$insert(_el$142, () => goalStatusLabel(goal().status).hint, null);
              _$insert(_el$137, (() => {
                var _c$4 = _$memo(() => !!rt());
                return () => _c$4() && [(() => {
                  var _el$154 = _$createElement("span");
                  _$insertNode(_el$154, _$createTextNode(` \u2502 Worker `));
                  _$effect((_$p) => _$setProp(_el$154, "style", {
                    fg: theme().textMuted
                  }, _$p));
                  return _el$154;
                })(), (() => {
                  var _el$156 = _$createElement("span"), _el$157 = _$createTextNode(` `), _el$158 = _$createTextNode(` \u2014 `);
                  _$insertNode(_el$156, _el$157);
                  _$insertNode(_el$156, _el$158);
                  _$insert(_el$156, () => phaseIcon(rt().phase), _el$157);
                  _$insert(_el$156, () => phaseLabel(rt().phase).short, _el$158);
                  _$insert(_el$156, () => phaseLabel(rt().phase).hint, null);
                  _$effect((_$p) => _$setProp(_el$156, "style", {
                    fg: phaseColor(rt().phase, theme()),
                    bold: true
                  }, _$p));
                  return _el$156;
                })(), (() => {
                  var _el$159 = _$createElement("span"), _el$160 = _$createTextNode(` run `), _el$161 = _$createTextNode(` (budget `), _el$162 = _$createTextNode(`)`);
                  _$insertNode(_el$159, _el$160);
                  _$insertNode(_el$159, _el$161);
                  _$insertNode(_el$159, _el$162);
                  _$insert(_el$159, () => rt().runCount, _el$161);
                  _$insert(_el$159, () => rt().budgetTurnCount, _el$162);
                  _$effect((_$p) => _$setProp(_el$159, "style", {
                    fg: theme().textMuted
                  }, _$p));
                  return _el$159;
                })()];
              })(), _el$144);
              _$insert(_el$145, () => describeGoalState(goal().status, rt()?.phase));
              _$insert(_el$137, (() => {
                var _c$5 = _$memo(() => !!rt()?.workerAbortedAt);
                return () => _c$5() && [(() => {
                  var _el$163 = _$createElement("span");
                  _$insertNode(_el$163, _$createTextNode(` \u2502 \u26A0 worker aborted `));
                  _$effect((_$p) => _$setProp(_el$163, "style", {
                    fg: theme().warning,
                    bold: true
                  }, _$p));
                  return _el$163;
                })(), (() => {
                  var _el$165 = _$createElement("span"), _el$166 = _$createTextNode(` \u2014 session kept, next turn reuses it`);
                  _$insertNode(_el$165, _el$166);
                  _$insert(_el$165, () => ageLabel(rt().workerAbortedAt, clock()), _el$166);
                  _$effect((_$p) => _$setProp(_el$165, "style", {
                    fg: theme().textMuted
                  }, _$p));
                  return _el$165;
                })()];
              })(), _el$146);
              _$insert(_el$137, () => {
                const agentName = goal().config.agent;
                const meta = agentName ? agentIndex()[agentName] ?? agentIndex()[agentName.toLowerCase()] : undefined;
                const model = goal().config.model;
                const slash = model?.indexOf("/") ?? -1;
                return [`
`, (() => {
                  var _el$167 = _$createElement("span");
                  _$insertNode(_el$167, _$createTextNode(`\uD83E\uDD16 `));
                  _$effect((_$p) => _$setProp(_el$167, "style", {
                    fg: theme().textMuted
                  }, _$p));
                  return _el$167;
                })(), (() => {
                  var _el$169 = _$createElement("span");
                  _$insertNode(_el$169, _$createTextNode(`Agent: `));
                  _$effect((_$p) => _$setProp(_el$169, "style", {
                    fg: theme().primary,
                    bold: true
                  }, _$p));
                  return _el$169;
                })(), _$memo(() => agentName ? [(() => {
                  var _el$185 = _$createElement("span");
                  _$insert(_el$185, agentName);
                  _$effect((_$p) => _$setProp(_el$185, "style", {
                    fg: agentColor(meta?.color, theme()),
                    bold: true
                  }, _$p));
                  return _el$185;
                })(), _$memo(() => _$memo(() => !!meta?.mode)() && (() => {
                  var _el$186 = _$createElement("span"), _el$187 = _$createTextNode(` (`), _el$188 = _$createTextNode(`)`);
                  _$insertNode(_el$186, _el$187);
                  _$insertNode(_el$186, _el$188);
                  _$insert(_el$186, () => meta.mode, _el$188);
                  _$effect((_$p) => _$setProp(_el$186, "style", {
                    fg: theme().textMuted
                  }, _$p));
                  return _el$186;
                })())] : goal().parentAgent ? [(() => {
                  var _el$189 = _$createElement("span");
                  _$insertNode(_el$189, _$createTextNode(`\u21A9 `));
                  _$effect((_$p) => _$setProp(_el$189, "style", {
                    fg: theme().textMuted
                  }, _$p));
                  return _el$189;
                })(), (() => {
                  var _el$191 = _$createElement("span");
                  _$insert(_el$191, () => goal().parentAgent);
                  _$effect((_$p) => _$setProp(_el$191, "style", {
                    fg: theme().text,
                    bold: true
                  }, _$p));
                  return _el$191;
                })(), (() => {
                  var _el$192 = _$createElement("span");
                  _$insertNode(_el$192, _$createTextNode(` (parent)`));
                  _$effect((_$p) => _$setProp(_el$192, "style", {
                    fg: theme().textMuted
                  }, _$p));
                  return _el$192;
                })()] : (() => {
                  var _el$194 = _$createElement("span");
                  _$insertNode(_el$194, _$createTextNode(`parent`));
                  _$effect((_$p) => _$setProp(_el$194, "style", {
                    fg: theme().textMuted
                  }, _$p));
                  return _el$194;
                })()), (() => {
                  var _el$171 = _$createElement("span");
                  _$insertNode(_el$171, _$createTextNode(` \u2502 \uD83E\uDDE0 `));
                  _$effect((_$p) => _$setProp(_el$171, "style", {
                    fg: theme().textMuted
                  }, _$p));
                  return _el$171;
                })(), (() => {
                  var _el$173 = _$createElement("span");
                  _$insertNode(_el$173, _$createTextNode(`Model: `));
                  _$effect((_$p) => _$setProp(_el$173, "style", {
                    fg: theme().primary,
                    bold: true
                  }, _$p));
                  return _el$173;
                })(), _$memo(() => model && slash > 0 ? [(() => {
                  var _el$196 = _$createElement("span"), _el$197 = _$createTextNode(`/`);
                  _$insertNode(_el$196, _el$197);
                  _$insert(_el$196, () => model.slice(0, slash), _el$197);
                  _$effect((_$p) => _$setProp(_el$196, "style", {
                    fg: theme().textMuted
                  }, _$p));
                  return _el$196;
                })(), (() => {
                  var _el$198 = _$createElement("span");
                  _$insert(_el$198, () => model.slice(slash + 1));
                  _$effect((_$p) => _$setProp(_el$198, "style", {
                    fg: theme().info,
                    bold: true
                  }, _$p));
                  return _el$198;
                })()] : goal().parentModel ? [(() => {
                  var _el$199 = _$createElement("span");
                  _$insertNode(_el$199, _$createTextNode(`\u21A9 `));
                  _$effect((_$p) => _$setProp(_el$199, "style", {
                    fg: theme().textMuted
                  }, _$p));
                  return _el$199;
                })(), (() => {
                  var _el$201 = _$createElement("span");
                  _$insert(_el$201, () => goal().parentModel);
                  _$effect((_$p) => _$setProp(_el$201, "style", {
                    fg: theme().info,
                    bold: true
                  }, _$p));
                  return _el$201;
                })(), (() => {
                  var _el$202 = _$createElement("span");
                  _$insertNode(_el$202, _$createTextNode(` (parent)`));
                  _$effect((_$p) => _$setProp(_el$202, "style", {
                    fg: theme().textMuted
                  }, _$p));
                  return _el$202;
                })()] : (() => {
                  var _el$204 = _$createElement("span");
                  _$insertNode(_el$204, _$createTextNode(`parent`));
                  _$effect((_$p) => _$setProp(_el$204, "style", {
                    fg: theme().textMuted
                  }, _$p));
                  return _el$204;
                })()), (() => {
                  var _el$175 = _$createElement("span");
                  _$insertNode(_el$175, _$createTextNode(` \u2502 \uD83D\uDCB0 `));
                  _$effect((_$p) => _$setProp(_el$175, "style", {
                    fg: theme().textMuted
                  }, _$p));
                  return _el$175;
                })(), (() => {
                  var _el$177 = _$createElement("span");
                  _$insertNode(_el$177, _$createTextNode(`Spent: `));
                  _$effect((_$p) => _$setProp(_el$177, "style", {
                    fg: theme().primary,
                    bold: true
                  }, _$p));
                  return _el$177;
                })(), (() => {
                  var _el$179 = _$createElement("span");
                  _$insert(_el$179, () => formatCost(goal().costUsed));
                  _$effect((_$p) => _$setProp(_el$179, "style", {
                    fg: theme().success,
                    bold: true
                  }, _$p));
                  return _el$179;
                })(), (() => {
                  var _el$180 = _$createElement("span");
                  _$insertNode(_el$180, _$createTextNode(` \xB7 `));
                  _$effect((_$p) => _$setProp(_el$180, "style", {
                    fg: theme().textMuted
                  }, _$p));
                  return _el$180;
                })(), (() => {
                  var _el$182 = _$createElement("span");
                  _$insert(_el$182, () => formatTokens(goal().tokensUsed));
                  _$effect((_$p) => _$setProp(_el$182, "style", {
                    fg: theme().warning,
                    bold: true
                  }, _$p));
                  return _el$182;
                })(), (() => {
                  var _el$183 = _$createElement("span"), _el$184 = _$createTextNode(` tokens \xB7 `);
                  _$insertNode(_el$183, _el$184);
                  _$insert(_el$183, () => formatDuration(goal().timeUsedSeconds), null);
                  _$effect((_$p) => _$setProp(_el$183, "style", {
                    fg: theme().textMuted
                  }, _$p));
                  return _el$183;
                })()];
              }, _el$146);
              _$insertNode(_el$147, _$createTextNode(`\uD83C\uDFAF Target: `));
              _$insert(_el$149, () => goal().objective.slice(0, 160));
              _$insert(_el$137, (() => {
                var _c$6 = _$memo(() => !!lp());
                return () => _c$6() && [(() => {
                  var _el$206 = _$createElement("span"), _el$207 = _$createTextNode(`
\u2714 `);
                  _$insertNode(_el$206, _el$207);
                  _$effect((_$p) => _$setProp(_el$206, "style", {
                    fg: theme().success
                  }, _$p));
                  return _el$206;
                })(), (() => {
                  var _el$209 = _$createElement("span");
                  _$insertNode(_el$209, _$createTextNode(`Progress: `));
                  _$effect((_$p) => _$setProp(_el$209, "style", {
                    fg: theme().success,
                    bold: true
                  }, _$p));
                  return _el$209;
                })(), (() => {
                  var _el$211 = _$createElement("span");
                  _$insert(_el$211, () => lp().summary.slice(0, 100));
                  _$effect((_$p) => _$setProp(_el$211, "style", {
                    fg: theme().text
                  }, _$p));
                  return _el$211;
                })(), (() => {
                  var _el$212 = _$createElement("span"), _el$213 = _$createTextNode(` \u2192 `);
                  _$insertNode(_el$212, _el$213);
                  _$insert(_el$212, () => lp().next?.slice(0, 60) || "", null);
                  _$effect((_$p) => _$setProp(_el$212, "style", {
                    fg: theme().textMuted
                  }, _$p));
                  return _el$212;
                })()];
              })(), null);
              _$insert(_el$137, (() => {
                var _c$7 = _$memo(() => !!blk());
                return () => _c$7() && [(() => {
                  var _el$214 = _$createElement("span"), _el$215 = _$createTextNode(`
\u2716 Blocked: `);
                  _$insertNode(_el$214, _el$215);
                  _$effect((_$p) => _$setProp(_el$214, "style", {
                    fg: theme().error,
                    bold: true
                  }, _$p));
                  return _el$214;
                })(), (() => {
                  var _el$217 = _$createElement("span");
                  _$insert(_el$217, () => blk().reason.slice(0, 140));
                  _$effect((_$p) => _$setProp(_el$217, "style", {
                    fg: theme().error
                  }, _$p));
                  return _el$217;
                })(), (() => {
                  var _el$218 = _$createElement("span"), _el$219 = _$createTextNode(` \u2014 `);
                  _$insertNode(_el$218, _el$219);
                  _$insert(_el$218, () => blk().needed.slice(0, 60), null);
                  _$effect((_$p) => _$setProp(_el$218, "style", {
                    fg: theme().textMuted
                  }, _$p));
                  return _el$218;
                })()];
              })(), null);
              _$insert(_el$137, (() => {
                var _c$8 = _$memo(() => !!goal().config.artifactDir);
                return () => _c$8() && [(() => {
                  var _el$220 = _$createElement("span"), _el$221 = _$createTextNode(`
\uD83D\uDCC1 `);
                  _$insertNode(_el$220, _el$221);
                  _$effect((_$p) => _$setProp(_el$220, "style", {
                    fg: theme().accent
                  }, _$p));
                  return _el$220;
                })(), (() => {
                  var _el$223 = _$createElement("span");
                  _$insertNode(_el$223, _$createTextNode(`Artifacts: `));
                  _$effect((_$p) => _$setProp(_el$223, "style", {
                    fg: theme().accent,
                    bold: true
                  }, _$p));
                  return _el$223;
                })(), (() => {
                  var _el$225 = _$createElement("span");
                  _$insert(_el$225, () => String(goal().config.artifactDir).replace(String(props.directory), "."));
                  _$effect((_$p) => _$setProp(_el$225, "style", {
                    fg: theme().textMuted
                  }, _$p));
                  return _el$225;
                })()];
              })(), null);
              _$insert(_el$137, (() => {
                var _c$9 = _$memo(() => !!goal().workerTopology);
                return () => _c$9() && [(() => {
                  var _el$226 = _$createElement("span"), _el$227 = _$createTextNode(`
\uD83C\uDF3F Worker: `);
                  _$insertNode(_el$226, _el$227);
                  _$effect((_$p) => _$setProp(_el$226, "style", {
                    fg: theme().textMuted
                  }, _$p));
                  return _el$226;
                })(), (() => {
                  var _el$229 = _$createElement("span");
                  _$insert(_el$229, (() => {
                    var _c$18 = _$memo(() => goal().workerTopology === "v2-native-child");
                    return () => _c$18() ? "native child" : goal().workerTopology === "v2-root-fallback" ? "root fallback" : "v1 child";
                  })());
                  _$effect((_$p) => _$setProp(_el$229, "style", {
                    fg: theme().text
                  }, _$p));
                  return _el$229;
                })(), _$memo(() => _$memo(() => !!goal().nativeParentID)() ? (() => {
                  var _el$230 = _$createElement("span"), _el$231 = _$createTextNode(` of `), _el$232 = _$createTextNode(`\u2026`);
                  _$insertNode(_el$230, _el$231);
                  _$insertNode(_el$230, _el$232);
                  _$insert(_el$230, () => goal().nativeParentID.slice(0, 12), _el$232);
                  _$effect((_$p) => _$setProp(_el$230, "style", {
                    fg: theme().textMuted
                  }, _$p));
                  return _el$230;
                })() : null)];
              })(), null);
              _$insert(_el$137, (() => {
                var _c$0 = _$memo(() => goal().interactive === true);
                return () => _c$0() && [(() => {
                  var _el$233 = _$createElement("span"), _el$234 = _$createTextNode(`
\u270B Manual: `);
                  _$insertNode(_el$233, _el$234);
                  _$effect((_$p) => _$setProp(_el$233, "style", {
                    fg: theme().accent,
                    bold: true
                  }, _$p));
                  return _el$233;
                })(), (() => {
                  var _el$236 = _$createElement("span");
                  _$insertNode(_el$236, _$createTextNode(`engine never starts turns \u2014 steer with :send/nudge (:interactive to re-enable auto)`));
                  _$effect((_$p) => _$setProp(_el$236, "style", {
                    fg: theme().textMuted
                  }, _$p));
                  return _el$236;
                })()];
              })(), null);
              _$insert(_el$137, (() => {
                var _c$1 = _$memo(() => !!goal().config.model);
                return () => _c$1() && [(() => {
                  var _el$238 = _$createElement("span"), _el$239 = _$createTextNode(`
\uD83E\uDDE0 Model: `);
                  _$insertNode(_el$238, _el$239);
                  _$effect((_$p) => _$setProp(_el$238, "style", {
                    fg: theme().info,
                    bold: true
                  }, _$p));
                  return _el$238;
                })(), (() => {
                  var _el$241 = _$createElement("span");
                  _$insert(_el$241, () => goal().config.model);
                  _$effect((_$p) => _$setProp(_el$241, "style", {
                    fg: theme().text
                  }, _$p));
                  return _el$241;
                })(), _$memo(() => _$memo(() => !!goal().modelSwitch?.pending)() ? (() => {
                  var _el$242 = _$createElement("span"), _el$243 = _$createTextNode(` \u2192 pending `), _el$244 = _$createTextNode(` (applies next turn)`);
                  _$insertNode(_el$242, _el$243);
                  _$insertNode(_el$242, _el$244);
                  _$insert(_el$242, () => goal().modelSwitch?.pending?.model, _el$244);
                  _$effect((_$p) => _$setProp(_el$242, "style", {
                    fg: theme().warning
                  }, _$p));
                  return _el$242;
                })() : null)];
              })(), null);
              _$insert(_el$137, (() => {
                var _c$10 = _$memo(() => !!goal().config.agent);
                return () => _c$10() && [(() => {
                  var _el$245 = _$createElement("span"), _el$246 = _$createTextNode(`
\uD83E\uDD16 Agent: `);
                  _$insertNode(_el$245, _el$246);
                  _$effect((_$p) => _$setProp(_el$245, "style", {
                    fg: theme().info,
                    bold: true
                  }, _$p));
                  return _el$245;
                })(), (() => {
                  var _el$248 = _$createElement("span");
                  _$insert(_el$248, () => goal().config.agent);
                  _$effect((_$p) => _$setProp(_el$248, "style", {
                    fg: theme().text
                  }, _$p));
                  return _el$248;
                })(), _$memo(() => _$memo(() => !!goal().agentSwitch?.pending)() ? (() => {
                  var _el$249 = _$createElement("span"), _el$250 = _$createTextNode(` \u2192 pending `), _el$251 = _$createTextNode(` (applies next turn)`);
                  _$insertNode(_el$249, _el$250);
                  _$insertNode(_el$249, _el$251);
                  _$insert(_el$249, () => goal().agentSwitch?.pending?.agent, _el$251);
                  _$effect((_$p) => _$setProp(_el$249, "style", {
                    fg: theme().warning
                  }, _$p));
                  return _el$249;
                })() : null)];
              })(), null);
              _$insert(_el$137, (() => {
                var _c$11 = _$memo(() => (goal().config.checks?.length ?? 0) > 0);
                return () => _c$11() ? [(() => {
                  var _el$252 = _$createElement("span"), _el$253 = _$createTextNode(`
\u25A3 `);
                  _$insertNode(_el$252, _el$253);
                  _$effect((_$p) => _$setProp(_el$252, "style", {
                    fg: theme().warning
                  }, _$p));
                  return _el$252;
                })(), (() => {
                  var _el$255 = _$createElement("span");
                  _$insertNode(_el$255, _$createTextNode(`Checks: `));
                  _$effect((_$p) => _$setProp(_el$255, "style", {
                    fg: theme().warning,
                    bold: true
                  }, _$p));
                  return _el$255;
                })(), (() => {
                  var _el$257 = _$createElement("span");
                  _$insert(_el$257, () => goal().config.checks.join(", ").slice(0, 100));
                  _$effect((_$p) => _$setProp(_el$257, "style", {
                    fg: theme().textMuted
                  }, _$p));
                  return _el$257;
                })()] : null;
              })(), null);
              _$insert(_el$137, [(() => {
                var _el$150 = _$createElement("span"), _el$151 = _$createTextNode(`
Write scope: `);
                _$insertNode(_el$150, _el$151);
                _$effect((_$p) => _$setProp(_el$150, "style", {
                  fg: theme().info,
                  bold: true
                }, _$p));
                return _el$150;
              })(), (() => {
                var _el$153 = _$createElement("span");
                _$insert(_el$153, (() => {
                  var _c$12 = _$memo(() => goal().config.workspaceWrite === false);
                  return () => _c$12() ? "read-only / own artifacts" : _$memo(() => goal().config.write_scope === undefined)() ? "whole workspace (legacy exclusive)" : _$memo(() => goal().config.write_scope.length === 0)() ? "exploration only \u2014 claim before editing" : goal().config.write_scope.join(", ");
                })());
                _$effect((_$p) => _$setProp(_el$153, "style", {
                  fg: theme().textMuted
                }, _$p));
                return _el$153;
              })(), _$memo(() => _$memo(() => !!(goal().scopeClosing || goal().scopeClearPending))() ? (() => {
                var _el$258 = _$createElement("span");
                _$insertNode(_el$258, _$createTextNode(` \u2014 closing; claims retained until writes drain`));
                _$effect((_$p) => _$setProp(_el$258, "style", {
                  fg: theme().warning
                }, _$p));
                return _el$258;
              })() : null)], null);
              _$insert(_el$137, (() => {
                var _c$13 = _$memo(() => rt()?.evaluatorRejectionCount > 0);
                return () => _c$13() && [(() => {
                  var _el$260 = _$createElement("span"), _el$261 = _$createTextNode(`
\u26A0 rejections: `);
                  _$insertNode(_el$260, _el$261);
                  _$effect((_$p) => _$setProp(_el$260, "style", {
                    fg: theme().warning
                  }, _$p));
                  return _el$260;
                })(), (() => {
                  var _el$263 = _$createElement("span"), _el$264 = _$createTextNode(` \u2014 `);
                  _$insertNode(_el$263, _el$264);
                  _$insert(_el$263, () => String(rt().evaluatorRejectionCount), _el$264);
                  _$insert(_el$263, () => String(rt().lastRejectionDetails || "").slice(0, 80), null);
                  _$effect((_$p) => _$setProp(_el$263, "style", {
                    fg: theme().warning
                  }, _$p));
                  return _el$263;
                })()];
              })(), null);
              _$insert(_el$137, (() => {
                var _c$14 = _$memo(() => rt()?.unknownStatusCount > 0);
                return () => _c$14() && [(() => {
                  var _el$265 = _$createElement("span"), _el$266 = _$createTextNode(`
\u26A0\uFE0F unreachable: `);
                  _$insertNode(_el$265, _el$266);
                  _$effect((_$p) => _$setProp(_el$265, "style", {
                    fg: theme().error
                  }, _$p));
                  return _el$265;
                })(), (() => {
                  var _el$268 = _$createElement("span"), _el$269 = _$createTextNode(`/3`);
                  _$insertNode(_el$268, _el$269);
                  _$insert(_el$268, () => String(rt().unknownStatusCount), _el$269);
                  _$effect((_$p) => _$setProp(_el$268, "style", {
                    fg: theme().error
                  }, _$p));
                  return _el$268;
                })(), (() => {
                  var _el$270 = _$createElement("span");
                  _$insertNode(_el$270, _$createTextNode(` \u2014 nudge to recover`));
                  _$effect((_$p) => _$setProp(_el$270, "style", {
                    fg: theme().textMuted
                  }, _$p));
                  return _el$270;
                })()];
              })(), null);
              _$insert(_el$137, (() => {
                var _c$15 = _$memo(() => !!rt()?.retryAfter);
                return () => _c$15() && [(() => {
                  var _el$272 = _$createElement("span"), _el$273 = _$createTextNode(`
\u21BB retry in: `);
                  _$insertNode(_el$272, _el$273);
                  _$effect((_$p) => _$setProp(_el$272, "style", {
                    fg: theme().accent
                  }, _$p));
                  return _el$272;
                })(), (() => {
                  var _el$275 = _$createElement("span");
                  _$insert(_el$275, () => countdownLabel(rt().retryAfter, clock()));
                  _$effect((_$p) => _$setProp(_el$275, "style", {
                    fg: theme().accent
                  }, _$p));
                  return _el$275;
                })()];
              })(), null);
              _$insert(_el$137, (() => {
                var _c$16 = _$memo(() => !!rt()?.nextRunAt);
                return () => _c$16() && [(() => {
                  var _el$276 = _$createElement("span"), _el$277 = _$createTextNode(`
\u23F0 next run: `);
                  _$insertNode(_el$276, _el$277);
                  _$effect((_$p) => _$setProp(_el$276, "style", {
                    fg: theme().accent
                  }, _$p));
                  return _el$276;
                })(), (() => {
                  var _el$279 = _$createElement("span");
                  _$insert(_el$279, () => countdownLabel(rt().nextRunAt, clock()));
                  _$effect((_$p) => _$setProp(_el$279, "style", {
                    fg: theme().accent
                  }, _$p));
                  return _el$279;
                })(), (() => {
                  var _el$280 = _$createElement("span"), _el$281 = _$createTextNode(` (`), _el$282 = _$createTextNode(` runs)`);
                  _$insertNode(_el$280, _el$281);
                  _$insertNode(_el$280, _el$282);
                  _$insert(_el$280, () => String(rt().scheduleRunCount || 0), _el$282);
                  _$effect((_$p) => _$setProp(_el$280, "style", {
                    fg: theme().textMuted
                  }, _$p));
                  return _el$280;
                })()];
              })(), null);
              _$insert(_el$137, (() => {
                var _c$17 = _$memo(() => !!rt()?.lastError);
                return () => _c$17() && [(() => {
                  var _el$283 = _$createElement("span"), _el$284 = _$createTextNode(`
\u26A0 `);
                  _$insertNode(_el$283, _el$284);
                  _$effect((_$p) => _$setProp(_el$283, "style", {
                    fg: theme().error
                  }, _$p));
                  return _el$283;
                })(), (() => {
                  var _el$286 = _$createElement("span");
                  _$insertNode(_el$286, _$createTextNode(`Error: `));
                  _$effect((_$p) => _$setProp(_el$286, "style", {
                    fg: theme().error,
                    bold: true
                  }, _$p));
                  return _el$286;
                })(), (() => {
                  var _el$288 = _$createElement("span");
                  _$insert(_el$288, () => rt().lastError.slice(0, 120));
                  _$effect((_$p) => _$setProp(_el$288, "style", {
                    fg: theme().error
                  }, _$p));
                  return _el$288;
                })()];
              })(), null);
              _$effect((_p$) => {
                var _v$38 = borderColorForStatus(goal().status, theme()), _v$39 = {
                  fg: statusColor(goal().status, theme()),
                  bold: true
                }, _v$40 = {
                  fg: theme().textMuted
                }, _v$41 = {
                  fg: statusColor(goal().status, theme())
                }, _v$42 = {
                  fg: theme().textMuted
                }, _v$43 = {
                  fg: theme().primary,
                  bold: true
                }, _v$44 = {
                  fg: theme().text
                };
                _v$38 !== _p$.e && (_p$.e = _$setProp(_el$136, "borderColor", _v$38, _p$.e));
                _v$39 !== _p$.t && (_p$.t = _$setProp(_el$138, "style", _v$39, _p$.t));
                _v$40 !== _p$.a && (_p$.a = _$setProp(_el$140, "style", _v$40, _p$.a));
                _v$41 !== _p$.o && (_p$.o = _$setProp(_el$142, "style", _v$41, _p$.o));
                _v$42 !== _p$.i && (_p$.i = _$setProp(_el$145, "style", _v$42, _p$.i));
                _v$43 !== _p$.n && (_p$.n = _$setProp(_el$147, "style", _v$43, _p$.n));
                _v$44 !== _p$.s && (_p$.s = _$setProp(_el$149, "style", _v$44, _p$.s));
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
              return _el$136;
            })();
          }
        })];
      }
    }), null);
    _$insert(_el$42, _$createComponent(Show, {
      get when() {
        return tab() === "commands";
      },
      get children() {
        return [_$createComponent(Show, {
          get when() {
            return ownerCommands().length > 0;
          },
          get fallback() {
            return (() => {
              var _el$289 = _$createElement("box"), _el$290 = _$createElement("text"), _el$291 = _$createElement("span"), _el$292 = _$createTextNode(`No live command sessions`), _el$293 = _$createTextNode(`. `), _el$294 = _$createElement("span"), _el$296 = _$createElement("span"), _el$297 = _$createTextNode(` to start one`), _el$298 = _$createElement("text"), _el$299 = _$createElement("span"), _el$301 = _$createElement("span"), _el$303 = _$createElement("span"), _el$305 = _$createElement("span"), _el$307 = _$createElement("span"), _el$309 = _$createElement("span"), _el$311 = _$createElement("span");
              _$insertNode(_el$289, _el$290);
              _$insertNode(_el$289, _el$298);
              _$setProp(_el$289, "flexDirection", "column");
              _$setProp(_el$289, "gap", 1);
              _$setProp(_el$289, "padding", 1);
              _$insertNode(_el$290, _el$291);
              _$insertNode(_el$290, _el$294);
              _$insertNode(_el$290, _el$296);
              _$insertNode(_el$291, _el$292);
              _$insertNode(_el$291, _el$293);
              _$insert(_el$291, (() => {
                var _c$19 = _$memo(() => hiddenFinishedCommands() > 0);
                return () => _c$19() ? ` \u2014 ${hiddenFinishedCommands()} finished hidden` : "";
              })(), _el$293);
              _$insertNode(_el$294, _$createTextNode(`:new &lt;command&gt;`));
              _$insertNode(_el$296, _el$297);
              _$insert(_el$296, () => hiddenFinishedCommands() > 0 ? ", or " : "; ", null);
              _$insert(_el$290, (() => {
                var _c$20 = _$memo(() => hiddenFinishedCommands() > 0);
                return () => _c$20() && (() => {
                  var _el$313 = _$createElement("span"), _el$314 = _$createElement("span"), _el$316 = _$createElement("span");
                  _$insertNode(_el$313, _el$314);
                  _$insertNode(_el$313, _el$316);
                  _$insertNode(_el$314, _$createTextNode(`c`));
                  _$insertNode(_el$316, _$createTextNode(` to show finished.`));
                  _$effect((_p$) => {
                    var _v$55 = {
                      fg: theme().warning
                    }, _v$56 = {
                      fg: theme().textMuted
                    };
                    _v$55 !== _p$.e && (_p$.e = _$setProp(_el$314, "style", _v$55, _p$.e));
                    _v$56 !== _p$.t && (_p$.t = _$setProp(_el$316, "style", _v$56, _p$.t));
                    return _p$;
                  }, {
                    e: undefined,
                    t: undefined
                  });
                  return _el$313;
                })();
              })(), null);
              _$insertNode(_el$298, _el$299);
              _$insertNode(_el$298, _el$301);
              _$insertNode(_el$298, _el$303);
              _$insertNode(_el$298, _el$305);
              _$insertNode(_el$298, _el$307);
              _$insertNode(_el$298, _el$309);
              _$insertNode(_el$298, _el$311);
              _$insertNode(_el$299, _$createTextNode(`Tip: `));
              _$insertNode(_el$301, _$createTextNode(`o`));
              _$insertNode(_el$303, _$createTextNode(` fullscreen \xB7 `));
              _$insertNode(_el$305, _$createTextNode(`X kill \xB7 R restart \xB7 x remove-done`));
              _$insertNode(_el$307, _$createTextNode(` \xB7 `));
              _$insertNode(_el$309, _$createTextNode(`:interrupt :terminate :remove`));
              _$insertNode(_el$311, _$createTextNode(` manage \xB7 text + Enter writes stdin.`));
              _$effect((_p$) => {
                var _v$45 = {
                  fg: theme().textMuted
                }, _v$46 = {
                  fg: theme().warning
                }, _v$47 = {
                  fg: theme().textMuted
                }, _v$48 = {
                  fg: theme().textMuted
                }, _v$49 = {
                  fg: theme().warning
                }, _v$50 = {
                  fg: theme().textMuted
                }, _v$51 = {
                  fg: theme().warning
                }, _v$52 = {
                  fg: theme().textMuted
                }, _v$53 = {
                  fg: theme().warning
                }, _v$54 = {
                  fg: theme().textMuted
                };
                _v$45 !== _p$.e && (_p$.e = _$setProp(_el$291, "style", _v$45, _p$.e));
                _v$46 !== _p$.t && (_p$.t = _$setProp(_el$294, "style", _v$46, _p$.t));
                _v$47 !== _p$.a && (_p$.a = _$setProp(_el$296, "style", _v$47, _p$.a));
                _v$48 !== _p$.o && (_p$.o = _$setProp(_el$299, "style", _v$48, _p$.o));
                _v$49 !== _p$.i && (_p$.i = _$setProp(_el$301, "style", _v$49, _p$.i));
                _v$50 !== _p$.n && (_p$.n = _$setProp(_el$303, "style", _v$50, _p$.n));
                _v$51 !== _p$.s && (_p$.s = _$setProp(_el$305, "style", _v$51, _p$.s));
                _v$52 !== _p$.h && (_p$.h = _$setProp(_el$307, "style", _v$52, _p$.h));
                _v$53 !== _p$.r && (_p$.r = _$setProp(_el$309, "style", _v$53, _p$.r));
                _v$54 !== _p$.d && (_p$.d = _$setProp(_el$311, "style", _v$54, _p$.d));
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
              return _el$289;
            })();
          },
          get children() {
            return _$createComponent(DashboardList, {
              get count() {
                return ownerCommands().length;
              },
              get selectedID() {
                return _$memo(() => !!selectedCommand())() ? `loopd-command-${selectedCommand().id}` : undefined;
              },
              get children() {
                return _$createComponent(For, {
                  get each() {
                    return ownerCommands();
                  },
                  children: (cmd, i) => {
                    const isActive = () => i() === cmdSelected();
                    return _$createComponent(DashboardRow, {
                      get id() {
                        return `loopd-command-${cmd.id}`;
                      },
                      get backgroundColor() {
                        return _$memo(() => !!isActive())() ? theme().backgroundElement : undefined;
                      },
                      get children() {
                        return [(() => {
                          var _el$318 = _$createElement("span");
                          _$insert(_el$318, (() => {
                            var _c$21 = _$memo(() => !!isActive());
                            return () => _c$21() ? `\u25B6 ${cmd.title}` : `  ${commandStatusIcon(cmd.status)} ${cmd.title}`;
                          })());
                          _$effect((_$p) => _$setProp(_el$318, "style", {
                            fg: commandStatusColor(cmd.status, theme()),
                            bold: isActive()
                          }, _$p));
                          return _el$318;
                        })(), (() => {
                          var _el$319 = _$createElement("span");
                          _$insertNode(_el$319, _$createTextNode(` \u2502 `));
                          _$effect((_$p) => _$setProp(_el$319, "style", {
                            fg: theme().textMuted
                          }, _$p));
                          return _el$319;
                        })(), (() => {
                          var _el$321 = _$createElement("span");
                          _$insertNode(_el$321, _$createTextNode(`Cmd `));
                          _$effect((_$p) => _$setProp(_el$321, "style", {
                            fg: theme().textMuted
                          }, _$p));
                          return _el$321;
                        })(), (() => {
                          var _el$323 = _$createElement("span");
                          _$insert(_el$323, () => commandStatusLabel(cmd.status).short);
                          _$effect((_$p) => _$setProp(_el$323, "style", {
                            fg: commandStatusColor(cmd.status, theme()),
                            bold: true
                          }, _$p));
                          return _el$323;
                        })(), (() => {
                          var _el$324 = _$createElement("span");
                          _$insertNode(_el$324, _$createTextNode(` \u2502 `));
                          _$effect((_$p) => _$setProp(_el$324, "style", {
                            fg: theme().textMuted
                          }, _$p));
                          return _el$324;
                        })(), (() => {
                          var _el$326 = _$createElement("span");
                          _$insert(_el$326, () => cmd.command);
                          _$effect((_$p) => _$setProp(_el$326, "style", {
                            fg: theme().accent,
                            bold: true
                          }, _$p));
                          return _el$326;
                        })(), _$memo(() => _$memo(() => cmd.args.length > 0)() && (() => {
                          var _el$329 = _$createElement("span"), _el$330 = _$createTextNode(` `);
                          _$insertNode(_el$329, _el$330);
                          _$insert(_el$329, () => cmd.args.join(" ").slice(0, 40), null);
                          _$effect((_$p) => _$setProp(_el$329, "style", {
                            fg: theme().textMuted
                          }, _$p));
                          return _el$329;
                        })()), _$memo(() => _$memo(() => cmd.exitCode !== undefined)() && (() => {
                          var _el$331 = _$createElement("span"), _el$332 = _$createTextNode(` \u2502 exit `);
                          _$insertNode(_el$331, _el$332);
                          _$insert(_el$331, () => cmd.exitCode, null);
                          _$effect((_$p) => _$setProp(_el$331, "style", {
                            fg: cmd.exitCode === 0 ? theme().success : theme().error
                          }, _$p));
                          return _el$331;
                        })()), _$memo(() => _$memo(() => !!cmd.signal)() && (() => {
                          var _el$333 = _$createElement("span"), _el$334 = _$createTextNode(` \u2502 `);
                          _$insertNode(_el$333, _el$334);
                          _$insert(_el$333, () => cmd.signal, null);
                          _$effect((_$p) => _$setProp(_el$333, "style", {
                            fg: theme().warning
                          }, _$p));
                          return _el$333;
                        })()), (() => {
                          var _el$327 = _$createElement("span"), _el$328 = _$createTextNode(` \u2502 `);
                          _$insertNode(_el$327, _el$328);
                          _$insert(_el$327, () => ageLabel(cmd.updatedAt, clock()), null);
                          _$effect((_$p) => _$setProp(_el$327, "style", {
                            fg: theme().textMuted
                          }, _$p));
                          return _el$327;
                        })(), _$memo(() => _$memo(() => !!cmd.truncated)() && (() => {
                          var _el$335 = _$createElement("span");
                          _$insertNode(_el$335, _$createTextNode(` \u2502 \u26A0 truncated`));
                          _$effect((_$p) => _$setProp(_el$335, "style", {
                            fg: theme().warning,
                            bold: true
                          }, _$p));
                          return _el$335;
                        })())];
                      }
                    });
                  }
                });
              }
            });
          }
        }), _$createComponent(Show, {
          get when() {
            return selectedCommand();
          },
          children: (cmd) => (() => {
            var _el$337 = _$createElement("box"), _el$338 = _$createElement("text"), _el$339 = _$createElement("span"), _el$340 = _$createTextNode(` `), _el$341 = _$createElement("span"), _el$343 = _$createElement("span"), _el$344 = _$createTextNode(` \u2014 `), _el$345 = _$createTextNode(`
`), _el$346 = _$createElement("span"), _el$348 = _$createElement("span"), _el$349 = _$createTextNode(`
`), _el$350 = _$createElement("span"), _el$352 = _$createElement("span"), _el$354 = _$createElement("span"), _el$355 = _$createTextNode(`
`), _el$356 = _$createElement("span"), _el$358 = _$createElement("span"), _el$360 = _$createElement("span"), _el$361 = _$createTextNode(` bytes`), _el$362 = _$createElement("span"), _el$363 = _$createTextNode(` \u2502 updated `), _el$364 = _$createTextNode(`
`), _el$365 = _$createElement("span");
            _$insertNode(_el$337, _el$338);
            _$setProp(_el$337, "flexDirection", "column");
            _$setProp(_el$337, "border", true);
            _$setProp(_el$337, "padding", 1);
            _$setProp(_el$337, "flexShrink", 0);
            _$setProp(_el$337, "maxHeight", 8);
            _$insertNode(_el$338, _el$339);
            _$insertNode(_el$338, _el$341);
            _$insertNode(_el$338, _el$343);
            _$insertNode(_el$338, _el$345);
            _$insertNode(_el$338, _el$346);
            _$insertNode(_el$338, _el$348);
            _$insertNode(_el$338, _el$349);
            _$insertNode(_el$338, _el$350);
            _$insertNode(_el$338, _el$352);
            _$insertNode(_el$338, _el$354);
            _$insertNode(_el$338, _el$355);
            _$insertNode(_el$338, _el$356);
            _$insertNode(_el$338, _el$358);
            _$insertNode(_el$338, _el$360);
            _$insertNode(_el$338, _el$362);
            _$insertNode(_el$338, _el$364);
            _$insertNode(_el$338, _el$365);
            _$insertNode(_el$339, _el$340);
            _$insert(_el$339, () => commandStatusIcon(cmd().status), _el$340);
            _$insert(_el$339, () => cmd().title, null);
            _$insertNode(_el$341, _$createTextNode(` Cmd `));
            _$insertNode(_el$343, _el$344);
            _$insert(_el$343, () => commandStatusLabel(cmd().status).short, _el$344);
            _$insert(_el$343, () => commandStatusLabel(cmd().status).hint, null);
            _$insertNode(_el$346, _$createTextNode(`\u2B22 Spawn: `));
            _$insert(_el$348, () => cmd().command);
            _$insert(_el$338, (() => {
              var _c$22 = _$memo(() => cmd().args.length > 0);
              return () => _c$22() && (() => {
                var _el$367 = _$createElement("span"), _el$368 = _$createTextNode(` `);
                _$insertNode(_el$367, _el$368);
                _$insert(_el$367, () => cmd().args.join(" "), null);
                _$effect((_$p) => _$setProp(_el$367, "style", {
                  fg: theme().text
                }, _$p));
                return _el$367;
              })();
            })(), _el$349);
            _$insertNode(_el$350, _$createTextNode(`\uD83D\uDCC1 `));
            _$insertNode(_el$352, _$createTextNode(`Cwd: `));
            _$insert(_el$354, () => cmd().cwd.replace(String(props.directory), "."));
            _$insert(_el$338, (() => {
              var _c$23 = _$memo(() => !!cmd().goalID);
              return () => _c$23() && [(() => {
                var _el$369 = _$createElement("span");
                _$insertNode(_el$369, _$createTextNode(` \u2502 \uD83D\uDD17 linked goal `));
                _$effect((_$p) => _$setProp(_el$369, "style", {
                  fg: theme().textMuted
                }, _$p));
                return _el$369;
              })(), (() => {
                var _el$371 = _$createElement("span");
                _$insert(_el$371, () => cmd().goalID.slice(0, 8));
                _$effect((_$p) => _$setProp(_el$371, "style", {
                  fg: theme().text
                }, _$p));
                return _el$371;
              })()];
            })(), _el$355);
            _$insertNode(_el$356, _$createTextNode(`\uD83D\uDCBE `));
            _$insertNode(_el$358, _$createTextNode(`Output: `));
            _$insertNode(_el$360, _el$361);
            _$insert(_el$360, () => cmd().outputBytes, _el$361);
            _$insert(_el$338, (() => {
              var _c$24 = _$memo(() => !!cmd().truncated);
              return () => _c$24() && (() => {
                var _el$372 = _$createElement("span");
                _$insertNode(_el$372, _$createTextNode(` \xB7 \u26A0 truncated`));
                _$effect((_$p) => _$setProp(_el$372, "style", {
                  fg: theme().warning,
                  bold: true
                }, _$p));
                return _el$372;
              })();
            })(), _el$362);
            _$insertNode(_el$362, _el$363);
            _$insert(_el$362, () => ageLabel(cmd().updatedAt, clock()), null);
            _$insert(_el$338, (() => {
              var _c$25 = _$memo(() => !!cmd().lastError);
              return () => _c$25() && [(() => {
                var _el$374 = _$createElement("span"), _el$375 = _$createTextNode(`
\u26A0 Error: `);
                _$insertNode(_el$374, _el$375);
                _$effect((_$p) => _$setProp(_el$374, "style", {
                  fg: theme().error,
                  bold: true
                }, _$p));
                return _el$374;
              })(), (() => {
                var _el$377 = _$createElement("span");
                _$insert(_el$377, () => cmd().lastError.slice(0, 120));
                _$effect((_$p) => _$setProp(_el$377, "style", {
                  fg: theme().error
                }, _$p));
                return _el$377;
              })()];
            })(), _el$364);
            _$insertNode(_el$365, _$createTextNode(`o fullscreen \xB7 X kill \xB7 R restart \xB7 x remove-done \xB7 :interrupt :terminate :remove \xB7 text + Enter writes stdin`));
            _$effect((_p$) => {
              var _v$57 = commandBorderColor(cmd().status, theme()), _v$58 = {
                fg: commandStatusColor(cmd().status, theme()),
                bold: true
              }, _v$59 = {
                fg: theme().textMuted
              }, _v$60 = {
                fg: commandStatusColor(cmd().status, theme())
              }, _v$61 = {
                fg: theme().primary,
                bold: true
              }, _v$62 = {
                fg: theme().accent,
                bold: true
              }, _v$63 = {
                fg: theme().textMuted
              }, _v$64 = {
                fg: theme().accent,
                bold: true
              }, _v$65 = {
                fg: theme().textMuted
              }, _v$66 = {
                fg: theme().warning,
                bold: true
              }, _v$67 = {
                fg: theme().warning,
                bold: true
              }, _v$68 = {
                fg: theme().text
              }, _v$69 = {
                fg: theme().textMuted
              }, _v$70 = {
                fg: theme().textMuted
              };
              _v$57 !== _p$.e && (_p$.e = _$setProp(_el$337, "borderColor", _v$57, _p$.e));
              _v$58 !== _p$.t && (_p$.t = _$setProp(_el$339, "style", _v$58, _p$.t));
              _v$59 !== _p$.a && (_p$.a = _$setProp(_el$341, "style", _v$59, _p$.a));
              _v$60 !== _p$.o && (_p$.o = _$setProp(_el$343, "style", _v$60, _p$.o));
              _v$61 !== _p$.i && (_p$.i = _$setProp(_el$346, "style", _v$61, _p$.i));
              _v$62 !== _p$.n && (_p$.n = _$setProp(_el$348, "style", _v$62, _p$.n));
              _v$63 !== _p$.s && (_p$.s = _$setProp(_el$350, "style", _v$63, _p$.s));
              _v$64 !== _p$.h && (_p$.h = _$setProp(_el$352, "style", _v$64, _p$.h));
              _v$65 !== _p$.r && (_p$.r = _$setProp(_el$354, "style", _v$65, _p$.r));
              _v$66 !== _p$.d && (_p$.d = _$setProp(_el$356, "style", _v$66, _p$.d));
              _v$67 !== _p$.l && (_p$.l = _$setProp(_el$358, "style", _v$67, _p$.l));
              _v$68 !== _p$.u && (_p$.u = _$setProp(_el$360, "style", _v$68, _p$.u));
              _v$69 !== _p$.c && (_p$.c = _$setProp(_el$362, "style", _v$69, _p$.c));
              _v$70 !== _p$.w && (_p$.w = _$setProp(_el$365, "style", _v$70, _p$.w));
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
              w: undefined
            });
            return _el$337;
          })()
        })];
      }
    }), null);
    _$insert(_el$42, _$createComponent(Show, {
      get when() {
        return _$memo(() => !!showLogs())() && events().length > 0;
      },
      get children() {
        var _el$46 = _$createElement("box"), _el$47 = _$createElement("text"), _el$48 = _$createElement("span"), _el$50 = _$createElement("span");
        _$insertNode(_el$46, _el$47);
        _$setProp(_el$46, "flexDirection", "column");
        _$setProp(_el$46, "border", true);
        _$setProp(_el$46, "padding", 1);
        _$setProp(_el$46, "maxHeight", 7);
        _$setProp(_el$46, "flexShrink", 0);
        _$setProp(_el$46, "overflow", "hidden");
        _$insertNode(_el$47, _el$48);
        _$insertNode(_el$47, _el$50);
        _$insertNode(_el$48, _$createTextNode(`\u25C8 Recent Events`));
        _$insertNode(_el$50, _$createTextNode(` \u2014 :logs to hide`));
        _$insert(_el$47, _$createComponent(For, {
          get each() {
            return events().slice(-10);
          },
          children: (ev) => [`
`, (() => {
            var _el$378 = _$createElement("span");
            _$insert(_el$378, () => String(ev.type));
            _$effect((_$p) => _$setProp(_el$378, "style", {
              fg: eventColor(String(ev.type), theme()),
              bold: true
            }, _$p));
            return _el$378;
          })(), (() => {
            var _el$379 = _$createElement("span"), _el$380 = _$createTextNode(` `);
            _$insertNode(_el$379, _el$380);
            _$insert(_el$379, () => ev.goalID?.slice(0, 8), null);
            _$effect((_$p) => _$setProp(_el$379, "style", {
              fg: theme().textMuted
            }, _$p));
            return _el$379;
          })(), _$memo(() => _$memo(() => !!ev.summary)() && (() => {
            var _el$381 = _$createElement("span"), _el$382 = _$createTextNode(` \u2014 `);
            _$insertNode(_el$381, _el$382);
            _$insert(_el$381, () => String(ev.summary).slice(0, 60), null);
            _$effect((_$p) => _$setProp(_el$381, "style", {
              fg: theme().text
            }, _$p));
            return _el$381;
          })())]
        }), null);
        _$effect((_p$) => {
          var _v$3 = theme().border, _v$4 = {
            fg: theme().accent,
            bold: true
          }, _v$5 = {
            fg: theme().textMuted
          };
          _v$3 !== _p$.e && (_p$.e = _$setProp(_el$46, "borderColor", _v$3, _p$.e));
          _v$4 !== _p$.t && (_p$.t = _$setProp(_el$48, "style", _v$4, _p$.t));
          _v$5 !== _p$.a && (_p$.a = _$setProp(_el$50, "style", _v$5, _p$.a));
          return _p$;
        }, {
          e: undefined,
          t: undefined,
          a: undefined
        });
        return _el$46;
      }
    }), null);
    _$insertNode(_el$52, _el$53);
    _$insertNode(_el$52, _el$55);
    _$setProp(_el$52, "flexDirection", "row");
    _$setProp(_el$52, "border", true);
    _$setProp(_el$52, "paddingLeft", 1);
    _$setProp(_el$52, "paddingRight", 1);
    _$setProp(_el$52, "flexShrink", 0);
    _$setProp(_el$52, "height", 3);
    _$setProp(_el$52, "gap", 1);
    _$insertNode(_el$53, _el$54);
    _$insert(_el$54, () => mode() === "insert" ? " INSERT \uE0B1" : " NORMAL ");
    _$use((el) => {
      inputEl = el;
      focusInput();
    }, _el$55);
    _$setProp(_el$55, "flexGrow", 1);
    _$setProp(_el$55, "onInput", (v) => {
      if (mode() === "insert")
        setCommandInput(v);
      else if (inputEl?.value)
        inputEl.value = "";
    });
    _$setProp(_el$55, "onKeyDown", (evt) => {
      if (mode() !== "insert") {
        if ((evt.name || "").length === 1)
          prevent(evt);
        return;
      }
    });
    _$effect((_p$) => {
      var _v$6 = theme().border, _v$7 = {
        fg: theme().primary,
        bold: true
      }, _v$8 = {
        fg: theme().textMuted
      }, _v$9 = {
        fg: mode() === "normal" ? theme().success : theme().warning,
        bold: true,
        bg: mode() === "insert" ? theme().backgroundElement : undefined
      }, _v$0 = {
        fg: theme().textMuted
      }, _v$1 = {
        fg: theme().accent,
        bold: true
      }, _v$10 = {
        fg: theme().textMuted
      }, _v$11 = {
        fg: theme().textMuted
      }, _v$12 = {
        fg: runningCount() > 0 ? theme().success : theme().textMuted,
        bold: runningCount() > 0
      }, _v$13 = {
        fg: theme().textMuted
      }, _v$14 = {
        fg: theme().info,
        bold: true
      }, _v$15 = {
        fg: theme().textMuted
      }, _v$16 = {
        fg: theme().textMuted
      }, _v$17 = {
        fg: tab() === "goals" ? theme().primary : theme().textMuted,
        bold: tab() === "goals"
      }, _v$18 = {
        fg: theme().textMuted
      }, _v$19 = {
        fg: tab() === "commands" ? theme().primary : theme().textMuted,
        bold: tab() === "commands"
      }, _v$20 = {
        fg: theme().textMuted
      }, _v$21 = mode() === "insert" ? theme().warning : theme().border, _v$22 = {
        fg: mode() === "insert" ? theme().warning : theme().success,
        bold: true,
        bg: mode() === "insert" ? theme().backgroundElement : undefined
      }, _v$23 = mode() === "insert" ? ":send hello  or  :force done --evidence proof  or  :open  (Ctrl+N: normal)" : statusText() || "Press : to send/command  \xB7  ? help  \xB7  o open child  \xB7  q close", _v$24 = theme().textMuted, _v$25 = theme().primary, _v$26 = theme().text, _v$27 = theme().background;
      _v$6 !== _p$.e && (_p$.e = _$setProp(_el$5, "borderColor", _v$6, _p$.e));
      _v$7 !== _p$.t && (_p$.t = _$setProp(_el$8, "style", _v$7, _p$.t));
      _v$8 !== _p$.a && (_p$.a = _$setProp(_el$0, "style", _v$8, _p$.a));
      _v$9 !== _p$.o && (_p$.o = _$setProp(_el$10, "style", _v$9, _p$.o));
      _v$0 !== _p$.i && (_p$.i = _$setProp(_el$13, "style", _v$0, _p$.i));
      _v$1 !== _p$.n && (_p$.n = _$setProp(_el$15, "style", _v$1, _p$.n));
      _v$10 !== _p$.s && (_p$.s = _$setProp(_el$16, "style", _v$10, _p$.s));
      _v$11 !== _p$.h && (_p$.h = _$setProp(_el$18, "style", _v$11, _p$.h));
      _v$12 !== _p$.r && (_p$.r = _$setProp(_el$20, "style", _v$12, _p$.r));
      _v$13 !== _p$.d && (_p$.d = _$setProp(_el$23, "style", _v$13, _p$.d));
      _v$14 !== _p$.l && (_p$.l = _$setProp(_el$25, "style", _v$14, _p$.l));
      _v$15 !== _p$.u && (_p$.u = _$setProp(_el$26, "style", _v$15, _p$.u));
      _v$16 !== _p$.c && (_p$.c = _$setProp(_el$28, "style", _v$16, _p$.c));
      _v$17 !== _p$.w && (_p$.w = _$setProp(_el$30, "style", _v$17, _p$.w));
      _v$18 !== _p$.m && (_p$.m = _$setProp(_el$32, "style", _v$18, _p$.m));
      _v$19 !== _p$.f && (_p$.f = _$setProp(_el$34, "style", _v$19, _p$.f));
      _v$20 !== _p$.y && (_p$.y = _$setProp(_el$36, "style", _v$20, _p$.y));
      _v$21 !== _p$.g && (_p$.g = _$setProp(_el$52, "borderColor", _v$21, _p$.g));
      _v$22 !== _p$.p && (_p$.p = _$setProp(_el$54, "style", _v$22, _p$.p));
      _v$23 !== _p$.b && (_p$.b = _$setProp(_el$55, "placeholder", _v$23, _p$.b));
      _v$24 !== _p$.T && (_p$.T = _$setProp(_el$55, "placeholderColor", _v$24, _p$.T));
      _v$25 !== _p$.A && (_p$.A = _$setProp(_el$55, "cursorColor", _v$25, _p$.A));
      _v$26 !== _p$.O && (_p$.O = _$setProp(_el$55, "focusedTextColor", _v$26, _p$.O));
      _v$27 !== _p$.I && (_p$.I = _$setProp(_el$55, "focusedBackgroundColor", _v$27, _p$.I));
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
      b: undefined,
      T: undefined,
      A: undefined,
      O: undefined,
      I: undefined
    });
    return _el$4;
  })();
}

// src/tui/command-panel.tsx
import { effect as _$effect2 } from "@opentui/solid";
import { use as _$use2 } from "@opentui/solid";
import { createComponent as _$createComponent2 } from "@opentui/solid";
import { insert as _$insert2 } from "@opentui/solid";
import { memo as _$memo2 } from "@opentui/solid";
import { createTextNode as _$createTextNode2 } from "@opentui/solid";
import { insertNode as _$insertNode2 } from "@opentui/solid";
import { setProp as _$setProp2 } from "@opentui/solid";
import { createElement as _$createElement2 } from "@opentui/solid";
import { createSignal as createSignal2, For as For2, Show as Show2, onCleanup as onCleanup2, onMount as onMount2 } from "solid-js";
import { useKeyboard as useKeyboard2 } from "@opentui/solid";

// src/tui/command-stream-client.ts
import { promises as fs3 } from "fs";
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
function isNonEmptyString2(value) {
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
        if (!isNonEmptyString2(value["commandID"]))
          return { ok: false, error: "subscribe.commandID must be a non-empty string" };
        if (!isNonEmptyString2(value["ownerSessionID"]))
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
        if (!isNonEmptyString2(value["commandID"]))
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
        if (!isNonEmptyString2(value["commandID"]))
          return { ok: false, error: "input.commandID must be a non-empty string" };
        if (typeof value["data"] !== "string")
          return { ok: false, error: "input.data must be a string" };
        return {
          ok: true,
          message: { type: "input", commandID: value["commandID"], data: value["data"] }
        };
      }
      case "interrupt": {
        if (!isNonEmptyString2(value["commandID"]))
          return { ok: false, error: "interrupt.commandID must be a non-empty string" };
        return { ok: true, message: { type: "interrupt", commandID: value["commandID"] } };
      }
      case "resync": {
        if (!isNonEmptyString2(value["commandID"]))
          return { ok: false, error: "resync.commandID must be a non-empty string" };
        return { ok: true, message: { type: "resync", commandID: value["commandID"] } };
      }
      case "unsubscribe": {
        if (!isNonEmptyString2(value["commandID"]))
          return { ok: false, error: "unsubscribe.commandID must be a non-empty string" };
        return { ok: true, message: { type: "unsubscribe", commandID: value["commandID"] } };
      }
      case "error": {
        if (!isNonEmptyString2(value["code"]))
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
    text = await fs3.readFile(defaultEndpointPath(directory), "utf8");
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
  const snapshotTimeoutMs = options.snapshotTimeoutMs ?? 8000;
  const maxPreSnapshotBuffered = options.maxPreSnapshotBuffered ?? 32;
  let state = "disconnected";
  let directory = "";
  let endpointURL = "";
  let socket;
  let generation = 0;
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
  function clearSnapshotTimer(sub) {
    if (sub.snapshotTimer) {
      clearTimeout(sub.snapshotTimer);
      sub.snapshotTimer = undefined;
    }
  }
  function armSnapshotTimer(sub) {
    clearSnapshotTimer(sub);
    if (sub.hasSnapshot)
      return;
    sub.snapshotTimer = setTimeout(() => {
      sub.snapshotTimer = undefined;
      if (sub.hasSnapshot || !subs.has(sub.commandID))
        return;
      sub.resyncPending = false;
      try {
        sub.handlers.onError?.(`snapshot-timeout: no snapshot for ${sub.commandID} within ${snapshotTimeoutMs}ms \u2014 using polling fallback`);
      } catch {}
    }, snapshotTimeoutMs);
    const t = sub.snapshotTimer;
    try {
      t.unref?.();
    } catch {}
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
        sub.hasSnapshot = true;
        sub.preSnapshotDropped = 0;
        clearSnapshotTimer(sub);
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
        if (sub.endOffset === undefined || !sub.hasSnapshot) {
          sub.preSnapshotDropped += 1;
          if (sub.preSnapshotDropped <= maxPreSnapshotBuffered) {
            requestResync(sub, "no-baseline");
          }
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
    generation += 1;
    const myGeneration = generation;
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
      if (myGeneration !== generation || socket !== next)
        return;
      reconnectAttempt = 0;
      emitConnection("connected");
      if (directory) {
        readEndpoint(directory).then((ep) => {
          if (myGeneration !== generation)
            return;
          if (ep && typeof ep.url === "string" && ep.url.length > 0)
            endpointURL = ep.url;
        }, () => {});
      }
      for (const sub of subs.values()) {
        sub.resyncPending = false;
        sub.hasSnapshot = false;
        sub.endOffset = undefined;
        sub.startOffset = undefined;
        sub.preSnapshotDropped = 0;
        sendSubscribe(sub);
        armSnapshotTimer(sub);
      }
    };
    socket.onmessage = (data) => {
      if (myGeneration !== generation || socket !== next)
        return;
      handleMessage(data);
    };
    socket.onclose = () => {
      if (myGeneration !== generation || socket !== next)
        return;
      socket = undefined;
      for (const sub of subs.values()) {
        sub.hasSnapshot = false;
        sub.endOffset = undefined;
        sub.startOffset = undefined;
        sub.resyncPending = false;
        clearSnapshotTimer(sub);
      }
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
      if (closedIntentionally || !directory)
        return;
      readEndpoint(directory).then((ep) => {
        if (closedIntentionally || !directory)
          return;
        if (ep && typeof ep.url === "string" && ep.url.length > 0)
          endpointURL = ep.url;
        if (!endpointURL) {
          scheduleReconnect();
          return;
        }
        openSocket();
      }, () => {
        if (!endpointURL) {
          scheduleReconnect();
          return;
        }
        openSocket();
      });
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
          hasSnapshot: false,
          resyncPending: false,
          resyncTimes: [],
          preSnapshotDropped: 0,
          snapshotTimer: undefined
        };
        subs.set(commandID, sub);
      } else {
        sub.ownerSessionID = ownerSessionID;
        sub.handlers = handlers;
        sub.endOffset = undefined;
        sub.startOffset = undefined;
        sub.hasSnapshot = false;
        sub.resyncPending = false;
        sub.preSnapshotDropped = 0;
        clearSnapshotTimer(sub);
      }
      if (!socket || state !== "connected") {
        return { ok: true };
      }
      const sent = sendSubscribe(sub);
      if (sent)
        armSnapshotTimer(sub);
      return sent ? { ok: true } : { ok: false, reason: "send-failed" };
    },
    unsubscribe(commandID) {
      const sub = subs.get(commandID);
      if (sub)
        clearSnapshotTimer(sub);
      subs.delete(commandID);
      if (sub && socket && state === "connected") {
        try {
          socket.send(JSON.stringify({ type: "unsubscribe", commandID }));
        } catch {}
      }
    },
    sendInput(commandID, data) {
      const sub = subs.get(commandID);
      if (!socket || state !== "connected" || !sub || !sub.hasSnapshot) {
        return { ok: false, reason: "not-subscribed" };
      }
      return sendWire({ type: "input", commandID, data }) ? { ok: true } : { ok: false, reason: "send-failed" };
    },
    sendInterrupt(commandID) {
      const sub = subs.get(commandID);
      if (!socket || state !== "connected" || !sub || !sub.hasSnapshot) {
        return { ok: false, reason: "not-subscribed" };
      }
      return sendWire({ type: "interrupt", commandID }) ? { ok: true } : { ok: false, reason: "send-failed" };
    },
    isLive(commandID) {
      return state === "connected" && subs.get(commandID)?.hasSnapshot === true;
    },
    disconnect() {
      closedIntentionally = true;
      generation += 1;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      for (const sub of subs.values()) {
        clearSnapshotTimer(sub);
        sub.hasSnapshot = false;
        sub.endOffset = undefined;
        sub.startOffset = undefined;
        sub.resyncPending = false;
      }
      try {
        socket?.close(1000, "client disconnect");
      } catch {}
      socket = undefined;
      emitConnection("disconnected");
    },
    dispose() {
      for (const sub of subs.values())
        clearSnapshotTimer(sub);
      subs.clear();
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      closedIntentionally = true;
      generation += 1;
      try {
        socket?.close(1000, "client dispose");
      } catch {}
      socket = undefined;
      if (state !== "disconnected")
        emitConnection("disconnected");
    }
  };
}

// src/tui/terminal-screen.ts
var BASE_COLORS = [
  "#000000",
  "#cd0000",
  "#00cd00",
  "#cdcd00",
  "#0000cd",
  "#cd00cd",
  "#00cdcd",
  "#e5e5e5",
  "#7f7f7f",
  "#ff0000",
  "#00ff00",
  "#ffff00",
  "#5c5cff",
  "#ff00ff",
  "#00ffff",
  "#ffffff"
];
function toHex(n) {
  return `#${n.toString(16).padStart(6, "0")}`;
}
function paletteToHex(index) {
  if (index < 0 || index > 255)
    return;
  if (index < 16)
    return BASE_COLORS[index];
  if (index < 232) {
    const i = index - 16;
    const r = Math.floor(i / 36);
    const g = Math.floor(i % 36 / 6);
    const b = i % 6;
    const v = (c) => c === 0 ? 0 : 55 + c * 40;
    return toHex(v(r) << 16 | v(g) << 8 | v(b));
  }
  const g = 8 + (index - 232) * 10;
  return toHex(g << 16 | g << 8 | g);
}
function createTerminalScreen(cols, rows) {
  const { Terminal } = __require("@xterm/headless");
  function makeTerm(nextCols, nextRows) {
    return new Terminal({
      cols: nextCols,
      rows: nextRows,
      scrollback: 0,
      allowProposedApi: true
    });
  }
  let term = makeTerm(cols, rows);
  let disposed = false;
  let pendingFlushes = [];
  let cursorVisible = true;
  function trackCursorVisibility(data) {
    if (!data)
      return;
    const re = /\x1b\[\?25([lh])/g;
    let m;
    while ((m = re.exec(data)) !== null) {
      cursorVisible = m[1] === "h";
    }
  }
  function readCursor() {
    try {
      const buf = term.buffer.active;
      const x = typeof buf.cursorX === "number" ? buf.cursorX : 0;
      const y = typeof buf.cursorY === "number" ? buf.cursorY : 0;
      return {
        x: Math.max(0, Math.min(term.cols - 1, x)),
        y: Math.max(0, Math.min(term.rows - 1, y)),
        visible: cursorVisible
      };
    } catch {
      return { x: 0, y: 0, visible: cursorVisible };
    }
  }
  return {
    get cols() {
      return term.cols;
    },
    get rows() {
      return term.rows;
    },
    get activeBuffer() {
      try {
        return term.buffer.active.type === "alternate" ? "alternate" : "normal";
      } catch {
        return "normal";
      }
    },
    get cursor() {
      return readCursor();
    },
    write(data) {
      if (disposed || !data)
        return;
      trackCursorVisibility(data);
      term.write(data);
    },
    flush() {
      if (disposed)
        return Promise.resolve();
      const myTerm = term;
      return new Promise((resolve) => {
        let done = false;
        const finish = () => {
          if (done)
            return;
          done = true;
          pendingFlushes = pendingFlushes.filter((f) => f !== finish);
          resolve();
        };
        pendingFlushes.push(finish);
        try {
          myTerm.write("", finish);
        } catch {
          finish();
        }
      });
    },
    resize(nextCols, nextRows) {
      if (disposed)
        return;
      if (!Number.isInteger(nextCols) || !Number.isInteger(nextRows))
        return;
      if (nextCols <= 0 || nextRows <= 0)
        return;
      if (nextCols === term.cols && nextRows === term.rows)
        return;
      try {
        term.resize(nextCols, nextRows);
      } catch {}
    },
    reset() {
      if (disposed)
        return;
      cursorVisible = true;
      let nextCols = 80;
      let nextRows = 24;
      try {
        nextCols = term.cols;
        nextRows = term.rows;
      } catch {}
      const stale = term;
      try {
        stale.dispose();
      } catch {}
      const waiters = pendingFlushes;
      pendingFlushes = [];
      for (const w of waiters) {
        try {
          w();
        } catch {}
      }
      term = makeTerm(nextCols, nextRows);
    },
    readScreen() {
      const out = [];
      if (disposed)
        return out;
      let active;
      try {
        active = term.buffer.active;
      } catch {
        return out;
      }
      const c = term.cols;
      const r = term.rows;
      for (let y = 0;y < r; y++) {
        let line;
        try {
          line = active.getLine(y);
        } catch {
          line = undefined;
        }
        for (let x = 0;x < c; x++) {
          let cell;
          try {
            cell = line?.getCell(x);
          } catch {
            cell = undefined;
          }
          if (!cell) {
            out.push({ text: " " });
            continue;
          }
          const text = cell.getChars() || " ";
          const entry = { text };
          try {
            const w = cell.getWidth();
            if (w === 0 || w === 2)
              entry.width = w;
          } catch {}
          try {
            if (!cell.isFgDefault()) {
              if (cell.isFgRGB())
                entry.fg = toHex(cell.getFgColor());
              else if (cell.isFgPalette())
                entry.fg = paletteToHex(cell.getFgColor());
            }
            if (!cell.isBgDefault()) {
              if (cell.isBgRGB())
                entry.bg = toHex(cell.getBgColor());
              else if (cell.isBgPalette())
                entry.bg = paletteToHex(cell.getBgColor());
            }
            if (cell.isBold())
              entry.bold = true;
            if (cell.isUnderline())
              entry.underline = true;
            if (cell.isInverse())
              entry.inverse = true;
          } catch {}
          if (entry.inverse) {
            const fg = entry.fg;
            entry.fg = entry.bg;
            entry.bg = fg;
          }
          out.push(entry);
        }
      }
      return out;
    },
    serialize() {
      if (disposed)
        return [];
      const cells = this.readScreen();
      const rows = [];
      const c = term.cols;
      const r = term.rows;
      for (let y = 0;y < r; y++) {
        let row = "";
        for (let x = 0;x < c; x++) {
          row += cells[y * c + x]?.text ?? " ";
        }
        rows.push(row);
      }
      return rows;
    },
    dispose() {
      disposed = true;
      const waiters = pendingFlushes;
      pendingFlushes = [];
      for (const w of waiters) {
        try {
          w();
        } catch {}
      }
      try {
        term.dispose();
      } catch {}
    }
  };
}
function createCommandScreenFeed(screen) {
  let end;
  return {
    get endOffset() {
      return end;
    },
    applySnapshot(data, _startOffset, endOffset) {
      screen.reset();
      if (data)
        screen.write(data);
      end = endOffset;
    },
    applyDelta(data, startOffset, endOffset) {
      if (end === undefined)
        return false;
      if (startOffset !== end)
        return false;
      if (data)
        screen.write(data);
      end = endOffset;
      return true;
    },
    reset() {
      screen.reset();
      end = undefined;
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
  return currentRouteSessionID(api);
}
function sameStyle(a, b) {
  return a.fg === b.fg && a.bg === b.bg && a.bold === b.bold && a.underline === b.underline;
}
function buildScreenRows(cells, cols) {
  const rows = [];
  const rowCount = Math.floor(cells.length / cols);
  for (let y = 0;y < rowCount; y++) {
    const runs = [];
    let current;
    for (let x = 0;x < cols; x++) {
      const cell = cells[y * cols + x];
      if (!cell)
        continue;
      const prev = x > 0 ? cells[y * cols + x - 1] : undefined;
      if (current && prev && sameStyle(cell, prev)) {
        current.text += cell.text;
      } else {
        current = {
          text: cell.text
        };
        if (cell.fg !== undefined)
          current.fg = cell.fg;
        if (cell.bg !== undefined)
          current.bg = cell.bg;
        if (cell.bold)
          current.bold = true;
        if (cell.underline)
          current.underline = true;
        runs.push(current);
      }
    }
    while (runs.length > 1 && runs[runs.length - 1] && /^ *$/.test(runs[runs.length - 1].text))
      runs.pop();
    const first = runs[0];
    if (runs.length === 1 && first && /^ *$/.test(first.text))
      first.text = " ";
    rows.push({
      runs
    });
  }
  while (rows.length > 1) {
    const last = rows[rows.length - 1];
    if (!last || !last.runs.every((r) => /^ *$/.test(r.text)))
      break;
    rows.pop();
  }
  return rows;
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
  const [statusText, setStatusText] = createSignal2("commands: j/k move \xB7 o fullscreen \xB7 enter write-mode \xB7 ctrl-c interrupt \xB7 X kill \xB7 R restart \xB7 x remove-done \xB7 :terminate :remove :resize :await \xB7 q detach");
  let inputEl;
  const client = createControlClient(props.directory);
  const ownerSessionID = props.ownerSessionID ?? routeOwnerSessionID(props.api);
  const stream = createCommandStreamClient();
  let subscribedID;
  let streamConnected = false;
  let lastSlowListRefresh = 0;
  const SLOW_LIST_REFRESH_MS = 30000;
  const [screenRows, setScreenRows] = createSignal2([]);
  const [emulated, setEmulated] = createSignal2(false);
  let screen;
  let feed;
  let feedForID;
  const ptyKnown = new Map;
  let screenDirty = false;
  let screenFlushTimer;
  let lastScreenFlushAt = 0;
  const SCREEN_FLUSH_MIN_MS = 120;
  let lastResizeAppliedAt = 0;
  const RESIZE_DEBOUNCE_MS = 500;
  let autoResizeTimer;
  let pendingAutoResize;
  function emuSizeFor(cmd) {
    return {
      cols: cmd.cols ?? 80,
      rows: cmd.rows ?? 24
    };
  }
  function ensureEmulatorFor(cmd) {
    if (!screen || !feed) {
      const size = emuSizeFor(cmd);
      screen = createTerminalScreen(size.cols, size.rows);
      feed = createCommandScreenFeed(screen);
      feedForID = undefined;
    }
    if (feedForID === cmd.id)
      return;
    const size = emuSizeFor(cmd);
    screen.resize(size.cols, size.rows);
    feed.reset();
    feedForID = cmd.id;
    setScreenRows([]);
    screenDirty = false;
    setEmulated(ptyKnown.get(cmd.id) === true);
  }
  function flushScreenRows() {
    lastScreenFlushAt = Date.now();
    if (!screenDirty)
      return;
    screenDirty = false;
    if (!screen || !feedForID)
      return;
    const sel = state().selectedCommand;
    if (!sel || sel.id !== feedForID)
      return;
    if (ptyKnown.get(sel.id) !== true)
      return;
    try {
      setScreenRows(buildScreenRows(screen.readScreen(), screen.cols));
    } catch {}
  }
  function markScreenDirty() {
    screenDirty = true;
    if (screenFlushTimer)
      return;
    const wait = Math.max(0, SCREEN_FLUSH_MIN_MS - (Date.now() - lastScreenFlushAt));
    screenFlushTimer = setTimeout(() => {
      screenFlushTimer = undefined;
      flushScreenRows();
    }, wait);
  }
  function feedSnapshotFor(id, data, startOffset, endOffset) {
    if (!feed || feedForID !== id)
      return;
    feed.applySnapshot(data, startOffset, endOffset);
    markScreenDirty();
  }
  function feedDeltaFor(id, data, startOffset, endOffset) {
    if (!feed || feedForID !== id)
      return;
    if (feed.applyDelta(data, startOffset, endOffset))
      markScreenDirty();
  }
  async function doResizeAndLearn(cols, rows) {
    const id = selectedID();
    if (!id || !ownerSessionID)
      return;
    lastResizeAppliedAt = Date.now();
    try {
      screen?.resize(cols, rows);
      const r = await client.executeRaw({
        command: "cmd_resize",
        goalID: id,
        args: {
          commandID: id,
          cols,
          rows,
          ownerSessionID
        }
      });
      ptyKnown.set(id, r.ok);
      if (selectedID() === id) {
        setEmulated(r.ok);
        if (r.ok)
          markScreenDirty();
        else
          setStatusText(r.message);
      }
      if (r.ok)
        await refresh();
    } catch (e) {
      setStatusText(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  function scheduleAutoResize(cmd) {
    if (!ownerSessionID)
      return;
    if (ptyKnown.has(cmd.id))
      return;
    pendingAutoResize = emuSizeFor(cmd);
    if (autoResizeTimer)
      return;
    const wait = Math.max(0, RESIZE_DEBOUNCE_MS - (Date.now() - lastResizeAppliedAt));
    autoResizeTimer = setTimeout(() => {
      autoResizeTimer = undefined;
      const p = pendingAutoResize;
      pendingAutoResize = undefined;
      if (!p)
        return;
      if (selectedID() !== cmd.id)
        return;
      doResizeAndLearn(p.cols, p.rows);
    }, wait);
  }
  function selectChanged() {
    const sel = state().selectedCommand;
    syncStreamSubscription();
    if (sel) {
      ensureEmulatorFor(sel);
      scheduleAutoResize(sel);
    }
    refreshOutput();
  }
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
        ensureEmulatorFor(snap.command);
        setOutput(snap.data);
        setOutputMeta({
          startByte: snap.startOffset,
          totalBytes: snap.endOffset,
          live: snap.command.status === "running"
        });
        feedSnapshotFor(snap.command.id, snap.data, snap.startOffset, snap.endOffset);
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
        feedDeltaFor(delta.commandID, delta.data, delta.startOffset, delta.endOffset);
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
        flushScreenRows();
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
      if (state().selectedCommand?.id !== sel.id)
        return;
      ensureEmulatorFor(sel);
      setOutput(log.text);
      setOutputMeta({
        startByte: log.startByte,
        totalBytes: total,
        live: sel.status === "running"
      });
      feedSnapshotFor(sel.id, log.text, log.startByte, total);
      flushScreenRows();
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
  async function forceKill() {
    const id = selectedID();
    if (!id) {
      setStatusText("No command selected.");
      return;
    }
    await sendRaw("cmd_kill", {
      commandID: id
    }, id);
  }
  async function restart() {
    const id = selectedID();
    if (!id) {
      setStatusText("No command selected.");
      return;
    }
    await sendRaw("cmd_restart", {
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
  async function removeFinished() {
    const sel = state().selectedCommand;
    if (!sel) {
      setStatusText("No command selected.");
      return;
    }
    if (sel.status === "running") {
      setStatusText(`"${sel.title}" is still running \u2014 X force kill \xB7 :terminate graceful \xB7 q detach (keeps running).`);
      return;
    }
    await sendRaw("cmd_remove", {
      commandID: sel.id
    }, sel.id);
  }
  async function awaitExit(goalID) {
    const sel = state().selectedCommand;
    if (!sel) {
      setStatusText("No command selected.");
      return;
    }
    const target = (goalID || sel.goalID || "").trim();
    if (!target) {
      setStatusText("Usage: :await <goalID> (selected command has no linked goal to default to).");
      return;
    }
    await sendRaw("cmd_await", {
      commandID: sel.id,
      goalID: target
    }, sel.id);
  }
  async function resize(cols, rows) {
    const id = selectedID();
    if (!id) {
      setStatusText("No command selected.");
      return;
    }
    if (Date.now() - lastResizeAppliedAt < RESIZE_DEBOUNCE_MS) {
      setStatusText("resize debounced \u2014 retry in a moment.");
      return;
    }
    await doResizeAndLearn(cols, rows);
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
      case "kill":
        await forceKill();
        break;
      case "restart":
        await restart();
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
      case "await":
        await awaitExit(rest[0]);
        break;
      default:
        setStatusText(`Unknown :${verb}. Try :new, :terminate, :kill, :restart, :remove, :interrupt, :resize, :open-cmd, :await <goalID>`);
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
    if (screenFlushTimer)
      clearTimeout(screenFlushTimer);
    if (autoResizeTimer)
      clearTimeout(autoResizeTimer);
    screenFlushTimer = undefined;
    autoResizeTimer = undefined;
    try {
      screen?.dispose();
    } catch {}
    screen = undefined;
    feed = undefined;
    feedForID = undefined;
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
      selectChanged();
      return;
    }
    if (name === "up" || key === "k") {
      prevent2(evt);
      setState((s) => moveCommandSelection(s, -1));
      selectChanged();
      return;
    }
    if (key === "g") {
      prevent2(evt);
      setState(selectCommandFirst);
      selectChanged();
      return;
    }
    if (key === "G") {
      prevent2(evt);
      setState(selectCommandLast);
      selectChanged();
      return;
    }
    if (key === "o") {
      prevent2(evt);
      const selCmd = state().selectedCommand;
      const returnSessionID = routeOwnerSessionID(props.api);
      const target = resolveOpenTarget({
        selection: selCmd ? {
          kind: "command",
          commandID: selCmd.id
        } : null,
        ownerSessionID,
        returnSessionID
      });
      if (target.kind === "none") {
        setStatusText(target.reason === "no-command" ? "No command selected." : target.reason === "owner-required" ? "No owning session (open from a session view) \u2014 open disabled." : "No return session \u2014 open disabled.");
        return;
      }
      if (target.kind !== "command")
        return;
      if (props.onOpenCommand) {
        props.onOpenCommand(target.data);
        return;
      }
      try {
        props.api.route.navigate(TERMINAL_ROUTE_NAME, terminalRoutePayload(target.data.commandID, target.data.ownerSessionID, target.data.returnSessionID));
        if (props.onDetach)
          props.onDetach();
        else
          props.api.ui.dialog.clear();
      } catch {
        setStatusText("Fullscreen route unavailable on this host \u2014 staying in the monitor.");
      }
      return;
    }
    if (key === "X") {
      prevent2(evt);
      forceKill();
      return;
    }
    if (key === "R") {
      prevent2(evt);
      restart();
      return;
    }
    if (key === "x") {
      prevent2(evt);
      removeFinished();
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
    var _el$ = _$createElement2("box"), _el$2 = _$createElement2("box"), _el$3 = _$createElement2("box"), _el$4 = _$createElement2("text"), _el$5 = _$createElement2("span"), _el$7 = _$createElement2("span"), _el$8 = _$createElement2("text"), _el$9 = _$createElement2("span"), _el$0 = _$createTextNode2(` owned`), _el$10 = _$createElement2("box"), _el$11 = _$createElement2("text"), _el$12 = _$createElement2("span"), _el$13 = _$createElement2("input");
    _$insertNode2(_el$, _el$2);
    _$setProp2(_el$, "flexDirection", "column");
    _$setProp2(_el$, "width", "100%");
    _$setProp2(_el$, "alignItems", "center");
    _$setProp2(_el$, "padding", 1);
    _$insertNode2(_el$2, _el$3);
    _$insertNode2(_el$2, _el$10);
    _$setProp2(_el$2, "flexDirection", "column");
    _$setProp2(_el$2, "width", "90%");
    _$setProp2(_el$2, "border", true);
    _$setProp2(_el$2, "padding", 1);
    _$insertNode2(_el$3, _el$4);
    _$insertNode2(_el$3, _el$8);
    _$setProp2(_el$3, "flexDirection", "row");
    _$setProp2(_el$3, "justifyContent", "space-between");
    _$setProp2(_el$3, "flexShrink", 0);
    _$insertNode2(_el$4, _el$5);
    _$insertNode2(_el$4, _el$7);
    _$insertNode2(_el$5, _$createTextNode2(`\u2B22 Command Sessions`));
    _$insert2(_el$7, () => emulated() ? " \u2502 terminal screen (emulated view \xB7 raw log is the record)" : " \u2502 byte-stream output (raw text)");
    _$insertNode2(_el$8, _el$9);
    _$insertNode2(_el$9, _el$0);
    _$insert2(_el$9, () => state().commands.length, _el$0);
    _$insert2(_el$2, _$createComponent2(Show2, {
      get when() {
        return state().commands.length > 0;
      },
      get fallback() {
        return (() => {
          var _el$14 = _$createElement2("box"), _el$15 = _$createElement2("text"), _el$16 = _$createElement2("span");
          _$insertNode2(_el$14, _el$15);
          _$setProp2(_el$14, "padding", 1);
          _$insertNode2(_el$15, _el$16);
          _$insert2(_el$16, ownerSessionID ? "No command sessions. :new <command> [args...] to start one." : "Open this panel from a session view \u2014 owner scoping needs a session.");
          _$effect2((_$p) => _$setProp2(_el$16, "style", {
            fg: theme().textMuted
          }, _$p));
          return _el$14;
        })();
      },
      get children() {
        var _el$1 = _$createElement2("box");
        _$setProp2(_el$1, "flexDirection", "column");
        _$setProp2(_el$1, "flexShrink", 1);
        _$setProp2(_el$1, "minHeight", 0);
        _$setProp2(_el$1, "overflow", "hidden");
        _$insert2(_el$1, _$createComponent2(For2, {
          get each() {
            return state().commands;
          },
          children: (cmd, i) => {
            const badge = watchBadge(cmd);
            const badgeWarn = badge === "flood-suspended" || badge === "budget-exhausted";
            const badgeHot = badge === "until-matched";
            const terminalReason = cmd.status !== "running" ? cmd.endReason : undefined;
            return (() => {
              var _el$17 = _$createElement2("box"), _el$18 = _$createElement2("text"), _el$19 = _$createElement2("span"), _el$20 = _$createElement2("span"), _el$21 = _$createTextNode2(` \u2502 `), _el$22 = _$createTextNode2(` \u2502 `);
              _$insertNode2(_el$17, _el$18);
              _$setProp2(_el$17, "paddingLeft", 1);
              _$setProp2(_el$17, "paddingRight", 1);
              _$insertNode2(_el$18, _el$19);
              _$insertNode2(_el$18, _el$20);
              _$setProp2(_el$18, "wrapMode", "none");
              _$setProp2(_el$18, "truncate", true);
              _$insert2(_el$19, () => i() === state().selected ? "\u25B6 " : "  ", null);
              _$insert2(_el$19, () => cmd.title, null);
              _$insertNode2(_el$20, _el$21);
              _$insertNode2(_el$20, _el$22);
              _$insert2(_el$20, () => [cmd.command, ...cmd.args].join(" ").slice(0, 60), _el$22);
              _$insert2(_el$20, () => cmd.status, null);
              _$insert2(_el$20, (() => {
                var _c$ = _$memo2(() => cmd.exitCode !== undefined);
                return () => _c$() ? ` (${cmd.exitCode})` : "";
              })(), null);
              _$insert2(_el$18, terminalReason ? (() => {
                var _el$23 = _$createElement2("span"), _el$24 = _$createTextNode2(` [`), _el$25 = _$createTextNode2(`]`);
                _$insertNode2(_el$23, _el$24);
                _$insertNode2(_el$23, _el$25);
                _$insert2(_el$23, terminalReason, _el$25);
                _$effect2((_$p) => _$setProp2(_el$23, "style", {
                  fg: terminalReason === "timeout" ? theme().warning : theme().textMuted
                }, _$p));
                return _el$23;
              })() : undefined, null);
              _$insert2(_el$18, badge ? (() => {
                var _el$26 = _$createElement2("span"), _el$27 = _$createTextNode2(` [`), _el$28 = _$createTextNode2(`]`);
                _$insertNode2(_el$26, _el$27);
                _$insertNode2(_el$26, _el$28);
                _$insert2(_el$26, badge, _el$28);
                _$effect2((_$p) => _$setProp2(_el$26, "style", {
                  fg: badgeWarn ? theme().warning : badgeHot ? theme().primary : theme().textMuted
                }, _$p));
                return _el$26;
              })() : undefined, null);
              _$effect2((_p$) => {
                var _v$10 = i() === state().selected ? theme().backgroundElement : undefined, _v$11 = {
                  fg: cmd.status === "running" ? theme().success : theme().textMuted,
                  bold: i() === state().selected
                }, _v$12 = {
                  fg: theme().textMuted
                };
                _v$10 !== _p$.e && (_p$.e = _$setProp2(_el$17, "backgroundColor", _v$10, _p$.e));
                _v$11 !== _p$.t && (_p$.t = _$setProp2(_el$19, "style", _v$11, _p$.t));
                _v$12 !== _p$.a && (_p$.a = _$setProp2(_el$20, "style", _v$12, _p$.a));
                return _p$;
              }, {
                e: undefined,
                t: undefined,
                a: undefined
              });
              return _el$17;
            })();
          }
        }));
        return _el$1;
      }
    }), _el$10);
    _$insert2(_el$2, _$createComponent2(Show2, {
      get when() {
        return sel();
      },
      children: (cmd) => (() => {
        var _el$29 = _$createElement2("box"), _el$30 = _$createElement2("text"), _el$31 = _$createElement2("span"), _el$32 = _$createElement2("span"), _el$33 = _$createTextNode2(` \u2502 `), _el$34 = _$createTextNode2(` \u2502 `), _el$35 = _$createTextNode2(` \u2502 `), _el$36 = _$createTextNode2(` bytes`);
        _$insertNode2(_el$29, _el$30);
        _$setProp2(_el$29, "flexDirection", "column");
        _$setProp2(_el$29, "border", true);
        _$setProp2(_el$29, "padding", 1);
        _$setProp2(_el$29, "flexShrink", 0);
        _$setProp2(_el$29, "maxHeight", 16);
        _$setProp2(_el$29, "overflow", "hidden");
        _$insertNode2(_el$30, _el$31);
        _$insertNode2(_el$30, _el$32);
        _$insert2(_el$31, () => cmd().title);
        _$insertNode2(_el$32, _el$33);
        _$insertNode2(_el$32, _el$34);
        _$insertNode2(_el$32, _el$35);
        _$insertNode2(_el$32, _el$36);
        _$insert2(_el$32, () => [cmd().command, ...cmd().args].join(" "), _el$34);
        _$insert2(_el$32, () => cmd().status, _el$35);
        _$insert2(_el$32, () => outputMeta().totalBytes, _el$36);
        _$insert2(_el$32, () => outputMeta().live ? " \xB7 live" : "", null);
        _$insert2(_el$32, () => cmd().truncated ? " \xB7 truncated" : "", null);
        _$insert2(_el$32, (() => {
          var _c$2 = _$memo2(() => !!(cmd().status !== "running" && cmd().endReason));
          return () => _c$2() ? ` \xB7 end:${cmd().endReason}` : "";
        })(), null);
        _$insert2(_el$32, (() => {
          var _c$3 = _$memo2(() => !!(emulated() && screen && feedForID === cmd().id));
          return () => _c$3() ? ` \xB7 ${screen.cols}x${screen.rows} screen${screen.activeBuffer === "alternate" ? " \xB7 alt-screen" : ""}` : "";
        })(), null);
        _$insert2(_el$29, (() => {
          var _c$4 = _$memo2(() => !!formatWatchDetail(cmd()));
          return () => _c$4() ? (() => {
            var _el$37 = _$createElement2("text"), _el$38 = _$createElement2("span");
            _$insertNode2(_el$37, _el$38);
            _$insert2(_el$38, () => formatWatchDetail(cmd()));
            _$effect2((_$p) => _$setProp2(_el$38, "style", {
              fg: theme().textMuted
            }, _$p));
            return _el$37;
          })() : undefined;
        })(), null);
        _$insert2(_el$29, _$createComponent2(Show2, {
          get when() {
            return _$memo2(() => !!emulated())() && screenRows().length > 0;
          },
          get fallback() {
            return (() => {
              var _el$39 = _$createElement2("text"), _el$40 = _$createElement2("span");
              _$insertNode2(_el$39, _el$40);
              _$insert2(_el$40, () => output().slice(-4000) || "(no output yet)");
              _$effect2((_$p) => _$setProp2(_el$40, "style", {
                fg: theme().text
              }, _$p));
              return _el$39;
            })();
          },
          get children() {
            return _$createComponent2(For2, {
              get each() {
                return screenRows();
              },
              children: (row) => (() => {
                var _el$41 = _$createElement2("text");
                _$setProp2(_el$41, "wrapMode", "none");
                _$setProp2(_el$41, "truncate", true);
                _$insert2(_el$41, _$createComponent2(For2, {
                  get each() {
                    return row.runs;
                  },
                  children: (run) => (() => {
                    var _el$42 = _$createElement2("span");
                    _$insert2(_el$42, () => run.text);
                    _$effect2((_$p) => _$setProp2(_el$42, "style", {
                      fg: run.fg ?? theme().text,
                      bg: run.bg,
                      bold: run.bold,
                      underline: run.underline
                    }, _$p));
                    return _el$42;
                  })()
                }));
                return _el$41;
              })()
            });
          }
        }), null);
        _$effect2((_p$) => {
          var _v$13 = theme().border, _v$14 = {
            fg: theme().primary,
            bold: true
          }, _v$15 = {
            fg: theme().textMuted
          };
          _v$13 !== _p$.e && (_p$.e = _$setProp2(_el$29, "borderColor", _v$13, _p$.e));
          _v$14 !== _p$.t && (_p$.t = _$setProp2(_el$31, "style", _v$14, _p$.t));
          _v$15 !== _p$.a && (_p$.a = _$setProp2(_el$32, "style", _v$15, _p$.a));
          return _p$;
        }, {
          e: undefined,
          t: undefined,
          a: undefined
        });
        return _el$29;
      })()
    }), _el$10);
    _$insertNode2(_el$10, _el$11);
    _$insertNode2(_el$10, _el$13);
    _$setProp2(_el$10, "flexDirection", "row");
    _$setProp2(_el$10, "border", true);
    _$setProp2(_el$10, "paddingLeft", 1);
    _$setProp2(_el$10, "paddingRight", 1);
    _$setProp2(_el$10, "flexShrink", 0);
    _$setProp2(_el$10, "height", 3);
    _$setProp2(_el$10, "gap", 1);
    _$insertNode2(_el$11, _el$12);
    _$insert2(_el$12, () => insertMode() ? " INPUT " : " NORMAL ");
    _$use2((el) => {
      inputEl = el;
    }, _el$13);
    _$setProp2(_el$13, "flexGrow", 1);
    _$setProp2(_el$13, "onInput", (v) => {
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
      }, _v$7 = insertMode() ? "type stdin, Enter sends (:new/:terminate/:kill/:restart/:remove/:interrupt/:resize/:open-cmd/:await)" : statusText() || "Press : to type, q to detach", _v$8 = theme().textMuted, _v$9 = theme().primary, _v$0 = theme().text, _v$1 = theme().background;
      _v$ !== _p$.e && (_p$.e = _$setProp2(_el$2, "borderColor", _v$, _p$.e));
      _v$2 !== _p$.t && (_p$.t = _$setProp2(_el$5, "style", _v$2, _p$.t));
      _v$3 !== _p$.a && (_p$.a = _$setProp2(_el$7, "style", _v$3, _p$.a));
      _v$4 !== _p$.o && (_p$.o = _$setProp2(_el$9, "style", _v$4, _p$.o));
      _v$5 !== _p$.i && (_p$.i = _$setProp2(_el$10, "borderColor", _v$5, _p$.i));
      _v$6 !== _p$.n && (_p$.n = _$setProp2(_el$12, "style", _v$6, _p$.n));
      _v$7 !== _p$.s && (_p$.s = _$setProp2(_el$13, "placeholder", _v$7, _p$.s));
      _v$8 !== _p$.h && (_p$.h = _$setProp2(_el$13, "placeholderColor", _v$8, _p$.h));
      _v$9 !== _p$.r && (_p$.r = _$setProp2(_el$13, "cursorColor", _v$9, _p$.r));
      _v$0 !== _p$.d && (_p$.d = _$setProp2(_el$13, "focusedTextColor", _v$0, _p$.d));
      _v$1 !== _p$.l && (_p$.l = _$setProp2(_el$13, "focusedBackgroundColor", _v$1, _p$.l));
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

// src/tui/terminal-view.tsx
import { use as _$use3 } from "@opentui/solid";
import { createComponent as _$createComponent3 } from "@opentui/solid";
import { effect as _$effect3 } from "@opentui/solid";
import { insert as _$insert3 } from "@opentui/solid";
import { createTextNode as _$createTextNode3 } from "@opentui/solid";
import { insertNode as _$insertNode3 } from "@opentui/solid";
import { memo as _$memo3 } from "@opentui/solid";
import { setProp as _$setProp3 } from "@opentui/solid";
import { createElement as _$createElement3 } from "@opentui/solid";
import { createSignal as createSignal3, For as For3, Show as Show3, onCleanup as onCleanup3, onMount as onMount3 } from "solid-js";
import { useKeyboard as useKeyboard3, usePaste } from "@opentui/solid";

// src/tui/terminal-session.ts
var TERMINAL_FALLBACK_COLS = 80;
var TERMINAL_FALLBACK_ROWS = 24;
var TERMINAL_POLL_INTERVAL_MS = 2000;
var TERMINAL_RESIZE_DEBOUNCE_MS = 75;
var TERMINAL_LOG_WINDOW_BYTES = 32 * 1024;
function computeViewportSize(measuredWidth, measuredHeight, chromeRows) {
  const cols = Math.floor(measuredWidth);
  const rows = Math.floor(measuredHeight) - chromeRows;
  if (!Number.isFinite(cols) || !Number.isFinite(rows))
    return;
  if (cols < 1 || rows < 1)
    return;
  return { cols, rows };
}
function createTerminalSession(options) {
  const validated = validateTerminalRouteData(options.routeData);
  const data = validated.ok ? validated.data : undefined;
  const invalidReason = validated.ok ? undefined : validated.reason;
  const routeConsistent = !data || isTerminalRouteConsistent(data);
  const routeReason = !data ? invalidReason : routeConsistent ? undefined : "owner-return-mismatch";
  const pollIntervalMs = options.pollIntervalMs ?? TERMINAL_POLL_INTERVAL_MS;
  const resizeDebounceMs = options.resizeDebounceMs ?? TERMINAL_RESIZE_DEBOUNCE_MS;
  const stream = (options.createStreamClient ?? createCommandStreamClient)();
  const control = (options.createControl ?? createControlClient)(options.directory);
  const readStateFn = options.readStateFn ?? readState;
  const readLogFn = options.readLogFn ?? ((dir, id, range) => readCommandLog(dir, id, range));
  let screen;
  let feed;
  let command = null;
  let connection = "polling";
  let connectionDetail = "connecting\u2026";
  let totalBytes = 0;
  let live = false;
  let disposed = false;
  let started = false;
  let appliedSize = { cols: TERMINAL_FALLBACK_COLS, rows: TERMINAL_FALLBACK_ROWS };
  let pollTimer;
  let resizeTimer;
  let pendingResize;
  let emitTimer;
  let lastEmitAt = 0;
  const EMIT_MIN_MS = 120;
  let paintRevision = 0;
  function ensureEmulator() {
    if (screen && feed)
      return;
    const make = options.createScreen ?? createTerminalScreen;
    screen = make(appliedSize.cols, appliedSize.rows);
    feed = createCommandScreenFeed(screen);
  }
  function emit() {
    if (disposed)
      return;
    try {
      options.onSnapshot?.(readView());
    } catch {}
  }
  function emitSoon() {
    if (disposed)
      return;
    const wait = Math.max(0, EMIT_MIN_MS - (Date.now() - lastEmitAt));
    if (emitTimer)
      return;
    emitTimer = setTimeout(() => {
      emitTimer = undefined;
      lastEmitAt = Date.now();
      emit();
    }, wait);
  }
  function applySnapshotBytes(snapshotData, startOffset, endOffset) {
    ensureEmulator();
    const revision = ++paintRevision;
    feed.applySnapshot(snapshotData, startOffset, endOffset);
    totalBytes = endOffset;
    flushThenEmit(revision);
  }
  function applyDeltaBytes(deltaData, startOffset, endOffset) {
    if (!feed)
      return;
    if (feed.applyDelta(deltaData, startOffset, endOffset)) {
      const revision = ++paintRevision;
      totalBytes = endOffset;
      flushThenEmit(revision);
    }
  }
  async function flushThenEmit(revision) {
    try {
      await screen?.flush();
    } catch {}
    if (disposed || revision !== paintRevision)
      return;
    emitSoon();
  }
  function streamLive() {
    return !!data && stream.isLive(data.commandID);
  }
  async function pollOnce() {
    if (disposed || !data)
      return;
    if (!routeConsistent)
      return;
    if (streamLive())
      return;
    try {
      const state = await readStateFn(options.directory);
      const found = (state.commands ?? []).find((c) => c.id === data.commandID) ?? null;
      if (!found) {
        connection = "error";
        connectionDetail = "command not found";
        emitSoon();
        return;
      }
      if (found.ownerSessionID !== data.ownerSessionID) {
        connection = "error";
        connectionDetail = "not owned by this session";
        emitSoon();
        return;
      }
      command = found;
      const windowBytes = TERMINAL_LOG_WINDOW_BYTES;
      const fileStartByte = Math.max(0, found.outputBytes - windowBytes);
      const log = await readLogFn(options.directory, found.id, {
        offsetBytes: fileStartByte,
        limitBytes: windowBytes
      });
      if (disposed || !data)
        return;
      ensureEmulator();
      const lifetimeBase = Math.max(0, (found.streamBytes ?? found.outputBytes) - found.outputBytes);
      const absoluteStart = lifetimeBase + log.startByte;
      const absoluteEnd = absoluteStart + utf8ByteLength(log.text);
      applySnapshotBytes(log.text, absoluteStart, absoluteEnd);
      live = found.status === "running";
      if (connection !== "stream") {
        connection = "polling";
        connectionDetail = "polling fallback (stream unavailable)";
      }
      emitSoon();
    } catch (error) {
      connectionDetail = error instanceof Error ? error.message : String(error);
      emitSoon();
    }
  }
  async function start() {
    if (started || disposed)
      return;
    started = true;
    ensureEmulator();
    if (!data) {
      connection = "error";
      connectionDetail = `invalid route data: ${invalidReason}`;
      emit();
      return;
    }
    if (!routeConsistent) {
      connection = "error";
      connectionDetail = `invalid route data: ${routeReason}`;
      emit();
      pollTimer = setInterval(() => void pollOnce(), pollIntervalMs);
      return;
    }
    try {
      const state = await readStateFn(options.directory);
      const found = (state.commands ?? []).find((c) => c.id === data.commandID);
      if (!found) {
        connection = "error";
        connectionDetail = "command not found";
        emit();
      } else if (found.ownerSessionID !== data.ownerSessionID) {
        connection = "error";
        connectionDetail = "not owned by this session";
        emit();
      } else {
        command = found;
      }
    } catch (error) {
      connectionDetail = error instanceof Error ? error.message : String(error);
    }
    if (connection === "error") {
      pollTimer = setInterval(() => void pollOnce(), pollIntervalMs);
      return;
    }
    try {
      const result = await stream.connect(options.directory);
      if (!result.ok) {
        connection = "polling";
        connectionDetail = "polling fallback (stream unavailable)";
      }
    } catch {
      connection = "polling";
      connectionDetail = "polling fallback (stream unavailable)";
    }
    stream.subscribe(data.commandID, data.ownerSessionID, {
      onSnapshot: (snap) => {
        if (disposed || snap.command.id !== data.commandID)
          return;
        if (snap.command.ownerSessionID !== data.ownerSessionID) {
          connection = "error";
          connectionDetail = "not owned by this session";
          stream.unsubscribe(data.commandID);
          emit();
          return;
        }
        command = snap.command;
        connection = "stream";
        live = snap.command.status === "running";
        connectionDetail = live ? "live" : "saved output (process ended)";
        applySnapshotBytes(snap.data, snap.startOffset, snap.endOffset);
      },
      onDelta: (delta) => {
        if (disposed || delta.commandID !== data.commandID)
          return;
        applyDeltaBytes(delta.data, delta.startOffset, delta.endOffset);
      },
      onStatus: (cmd) => {
        if (disposed || cmd.id !== data.commandID)
          return;
        if (cmd.ownerSessionID !== data.ownerSessionID)
          return;
        command = cmd;
        live = cmd.status === "running";
        connectionDetail = live ? "live" : "saved output (process ended)";
        emitSoon();
      },
      onError: (message) => {
        if (disposed)
          return;
        if (/snapshot-timeout|resync-loop-guard/.test(message) && connection !== "error") {
          connection = "polling";
          connectionDetail = "polling fallback (stream unavailable)";
        } else if (connection !== "stream") {
          connectionDetail = message;
        }
        emitSoon();
      },
      onConnection: (next) => {
        if (disposed)
          return;
        if (next === "connected" && connection !== "stream" && connection !== "error") {
          connectionDetail = "stream connected \u2014 awaiting snapshot\u2026";
        } else if (next === "disconnected" && connection === "stream") {
          connection = "polling";
          connectionDetail = "polling fallback (stream unavailable)";
        }
        emitSoon();
      }
    });
    await pollOnce();
    pollTimer = setInterval(() => void pollOnce(), pollIntervalMs);
  }
  function writeInput(bytes) {
    if (disposed || !data || !bytes)
      return;
    if (connection === "error")
      return;
    if (command && command.status !== "running")
      return;
    if (streamLive() && stream.sendInput(data.commandID, bytes).ok)
      return;
    control.executeRaw({ command: "cmd_write", goalID: data.commandID, args: { commandID: data.commandID, input: bytes, ownerSessionID: data.ownerSessionID } }).catch(() => {});
  }
  function paste(text) {
    if (disposed || !data || !text)
      return;
    writeInput(text);
  }
  function interrupt() {
    if (disposed || !data)
      return;
    if (connection === "error")
      return;
    if (command && command.status !== "running")
      return;
    if (streamLive() && stream.sendInterrupt(data.commandID).ok)
      return;
    control.executeRaw({ command: "cmd_interrupt", goalID: data.commandID, args: { commandID: data.commandID, ownerSessionID: data.ownerSessionID } }).catch(() => {});
  }
  function applyResize(cols, rows) {
    if (disposed || !data)
      return;
    appliedSize = { cols, rows };
    try {
      screen?.resize(cols, rows);
    } catch {}
    if (connection === "error") {
      emitSoon();
      return;
    }
    control.executeRaw({ command: "cmd_resize", goalID: data.commandID, args: { commandID: data.commandID, cols, rows, ownerSessionID: data.ownerSessionID } }).catch(() => {});
    emitSoon();
  }
  function requestViewportSize(cols, rows) {
    if (disposed)
      return;
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1)
      return;
    if (cols === appliedSize.cols && rows === appliedSize.rows && !pendingResize)
      return;
    pendingResize = { cols, rows };
    if (resizeTimer)
      return;
    resizeTimer = setTimeout(() => {
      resizeTimer = undefined;
      const next = pendingResize;
      pendingResize = undefined;
      if (!next || disposed)
        return;
      applyResize(next.cols, next.rows);
    }, resizeDebounceMs);
  }
  function cleanup() {
    if (pollTimer)
      clearInterval(pollTimer);
    if (resizeTimer)
      clearTimeout(resizeTimer);
    if (emitTimer)
      clearTimeout(emitTimer);
    pollTimer = undefined;
    resizeTimer = undefined;
    emitTimer = undefined;
    pendingResize = undefined;
    try {
      if (data)
        stream.unsubscribe(data.commandID);
    } catch {}
    try {
      stream.dispose();
    } catch {}
    try {
      screen?.dispose();
    } catch {}
    screen = undefined;
    feed = undefined;
  }
  function detach() {
    if (disposed)
      return;
    cleanup();
    disposed = true;
    try {
      options.onDetach?.();
    } catch {}
  }
  function dispose() {
    if (disposed)
      return;
    cleanup();
    disposed = true;
  }
  function readView() {
    ensureEmulator();
    let rows = [];
    try {
      rows = screen.readScreen();
    } catch {
      rows = [];
    }
    let cursor = { x: 0, y: 0, visible: true };
    try {
      cursor = screen.cursor;
    } catch {}
    let activeBuffer = "normal";
    try {
      activeBuffer = screen.activeBuffer;
    } catch {}
    return {
      rows,
      cols: screen.cols,
      viewportRows: screen.rows,
      cursor,
      activeBuffer,
      command,
      connection,
      connectionDetail,
      totalBytes,
      live,
      invalid: routeReason
    };
  }
  return {
    get data() {
      return data;
    },
    get invalidReason() {
      return routeReason;
    },
    start,
    writeInput,
    paste,
    interrupt,
    detach,
    requestViewportSize,
    get appliedSize() {
      return { ...appliedSize };
    },
    readView,
    dispose
  };
}

// src/tui/terminal-keys.ts
function isDetachChord(evt) {
  if (!evt || evt.release)
    return false;
  if (!evt.ctrl)
    return false;
  const name = (evt.name ?? "").toLowerCase();
  return name === "]" || evt.sequence === "\x1D";
}
function isInterruptChord(evt) {
  if (!evt || evt.release)
    return false;
  if (!evt.ctrl)
    return false;
  return (evt.name ?? "").toLowerCase() === "c";
}
var CSI = "\x1B[";
function isKittyEncoding(name, sequence) {
  if (/^\x1b\[[0-9;?]*u$/i.test(sequence))
    return true;
  if (/^kitty/i.test(name))
    return true;
  return false;
}
var CONVENTIONAL_NAMES = new Set([
  "return",
  "enter",
  "kp_enter",
  "tab",
  "backspace",
  "escape",
  "esc",
  "up",
  "down",
  "right",
  "left",
  "home",
  "end",
  "delete",
  "del",
  "pageup",
  "page_up",
  "pagedown",
  "page_down",
  "space"
]);
function isConventionalVT(name, sequence, text) {
  if (CONVENTIONAL_NAMES.has(name))
    return true;
  if (text.length === 1)
    return true;
  if (sequence.length === 1 && sequence >= " " && sequence !== "\x7F")
    return true;
  return false;
}
function encodeTerminalKey(evt) {
  if (!evt || evt.release)
    return;
  const rawName = (evt.name ?? "").toLowerCase();
  const seq = evt.sequence ?? "";
  const text = evt.text ?? "";
  const ctrl = Boolean(evt.ctrl);
  const alt = Boolean(evt.alt || evt.meta || evt.option);
  if (isDetachChord(evt))
    return;
  if (evt.source === "kitty" && !isConventionalVT(rawName, seq, text))
    return;
  if (isKittyEncoding(rawName, seq))
    return;
  switch (rawName) {
    case "return":
    case "enter":
    case "kp_enter":
      return alt ? `\x1B\r` : "\r";
    case "tab":
      return alt ? "\x1B\t" : "\t";
    case "backspace":
      return alt ? "\x1B\x7F" : "\x7F";
    case "escape":
    case "esc":
      return "\x1B";
    case "up":
      return alt ? `\x1B${CSI}A` : `${CSI}A`;
    case "down":
      return alt ? `\x1B${CSI}B` : `${CSI}B`;
    case "right":
      return alt ? `\x1B${CSI}C` : `${CSI}C`;
    case "left":
      return alt ? `\x1B${CSI}D` : `${CSI}D`;
    case "home":
      return alt ? `\x1B${CSI}H` : `${CSI}H`;
    case "end":
      return alt ? `\x1B${CSI}F` : `${CSI}F`;
    case "delete":
    case "del":
      return alt ? `\x1B${CSI}3~` : `${CSI}3~`;
    case "pageup":
    case "page_up":
      return alt ? `\x1B${CSI}5~` : `${CSI}5~`;
    case "pagedown":
    case "page_down":
      return alt ? `\x1B${CSI}6~` : `${CSI}6~`;
    case "space":
      if (ctrl)
        return "\x00";
      return alt ? "\x1B " : " ";
    default:
      break;
  }
  if (ctrl) {
    const letter = rawName.length === 1 ? rawName : text.length === 1 ? text.toLowerCase() : "";
    if (/^[a-z]$/.test(letter)) {
      const byte = letter.charCodeAt(0) - 96;
      const out = String.fromCharCode(byte);
      return alt ? `\x1B${out}` : out;
    }
    if (rawName === "[" || seq === "\x1B")
      return "\x1B";
    if (rawName === "\\")
      return alt ? "\x1B\x1C" : "\x1C";
    if (rawName === "^" || rawName === "6")
      return alt ? "\x1B\x1E" : "\x1E";
    if (rawName === "_" || rawName === "-")
      return alt ? "\x1B\x1F" : "\x1F";
    return;
  }
  if (text.length === 1) {
    return alt ? `\x1B${text}` : text;
  }
  if (seq.length === 1 && seq >= " " && seq !== "\x7F") {
    return alt ? `\x1B${seq}` : seq;
  }
  const knownVT = new Set([
    "\r",
    `
`,
    "\t",
    "\x7F",
    "\x1B",
    `${CSI}A`,
    `${CSI}B`,
    `${CSI}C`,
    `${CSI}D`,
    `${CSI}H`,
    `${CSI}F`,
    `${CSI}3~`,
    `${CSI}5~`,
    `${CSI}6~`,
    "\x1BOA",
    "\x1BOB",
    "\x1BOC",
    "\x1BOD",
    "\x1BOH",
    "\x1BOF"
  ]);
  if (knownVT.has(seq)) {
    return alt && !seq.startsWith("\x1B") ? `\x1B${seq}` : seq;
  }
  return;
}

// src/tui/terminal-view.tsx
var TERMINAL_INPUT_MODE = "loopd.terminal";
function prevent3(evt) {
  const e = evt;
  e.preventDefault?.();
  e.stopPropagation?.();
}
function toKeyEvent(evt) {
  const e = evt;
  return {
    name: e.name,
    text: e.text,
    sequence: e.sequence ?? e.raw,
    ctrl: e.ctrl,
    alt: evt.alt,
    meta: e.meta,
    option: e.option,
    shift: e.shift,
    source: e.source,
    release: e.eventType === "release",
    repeated: evt.repeated
  };
}
function sameStyle2(a, b) {
  return a.fg === b.fg && a.bg === b.bg && a.bold === b.bold && a.underline === b.underline && (a.inverse ?? false) === (b.inverse ?? false);
}
function isDroppableBlank(run) {
  if (!/^ *$/.test(run.text))
    return false;
  return run.fg === undefined && run.bg === undefined && !run.bold && !run.underline && !run.inverse && !run.cursor;
}
function buildTerminalRows(cells, cols, rows, cursor) {
  const out = [];
  for (let y = 0;y < rows; y++) {
    const runs = [];
    let current;
    let prev;
    let prevIsCursor = false;
    for (let x = 0;x < cols; x++) {
      const cell = cells[y * cols + x];
      if (!cell)
        continue;
      if (cell.width === 0)
        continue;
      const isCursor = cursor.visible && cursor.y === y && cursor.x === x;
      if (current && prev && sameStyle2(cell, prev) && isCursor === prevIsCursor) {
        current.text += cell.text;
      } else {
        current = {
          text: cell.text
        };
        if (cell.fg !== undefined)
          current.fg = cell.fg;
        if (cell.bg !== undefined)
          current.bg = cell.bg;
        if (cell.bold)
          current.bold = true;
        if (cell.underline)
          current.underline = true;
        if (cell.inverse)
          current.inverse = true;
        if (isCursor)
          current.cursor = true;
        runs.push(current);
      }
      prev = cell;
      prevIsCursor = isCursor;
    }
    while (runs.length > 1 && runs[runs.length - 1] && isDroppableBlank(runs[runs.length - 1]))
      runs.pop();
    const first = runs[0];
    if (runs.length === 0)
      runs.push({
        text: " "
      });
    else if (runs.length === 1 && first && isDroppableBlank(first))
      first.text = " ";
    out.push(runs);
  }
  return out;
}
function TerminalView(props) {
  const theme = () => props.api.theme.current;
  const makeSession = props.createSession ?? createTerminalSession;
  const [view, setView] = createSignal3(null);
  let viewportEl;
  let measureTimer;
  let popTerminalMode;
  const session = makeSession({
    directory: props.directory,
    routeData: props.data,
    onSnapshot: (snap) => setView({
      ...snap
    }),
    onDetach: () => {
      if (props.onDetach) {
        props.onDetach();
        return;
      }
      const ret = session.data?.returnSessionID;
      if (ret) {
        try {
          props.api.route.navigate("session", {
            sessionID: ret
          });
        } catch {}
      }
    }
  });
  function measureViewport() {
    try {
      const w = viewportEl?.width;
      const h = viewportEl?.height;
      if (typeof w !== "number" || typeof h !== "number")
        return;
      const size = computeViewportSize(w, h, 0);
      if (size)
        session.requestViewportSize(size.cols, size.rows);
    } catch {}
  }
  onMount3(() => {
    try {
      const push = props.api.mode?.push;
      if (typeof push === "function") {
        popTerminalMode = push.call(props.api.mode, TERMINAL_INPUT_MODE);
      }
    } catch {}
    session.start();
    setTimeout(measureViewport, 50);
    measureTimer = setInterval(measureViewport, 1000);
  });
  onCleanup3(() => {
    if (measureTimer)
      clearInterval(measureTimer);
    measureTimer = undefined;
    viewportEl = undefined;
    try {
      popTerminalMode?.();
    } catch {}
    popTerminalMode = undefined;
    session.dispose();
  });
  useKeyboard3((evt) => {
    if (isDetachChord(toKeyEvent(evt))) {
      prevent3(evt);
      session.detach();
      return;
    }
    if (isInterruptChord(toKeyEvent(evt))) {
      prevent3(evt);
      if (view()?.command && view()?.command?.status !== "running")
        return;
      session.interrupt();
      return;
    }
    const bytes = encodeTerminalKey(toKeyEvent(evt));
    if (bytes !== undefined) {
      prevent3(evt);
      if (view()?.command && view()?.command?.status !== "running")
        return;
      session.writeInput(bytes);
    }
  });
  usePaste((event) => {
    try {
      const text = Buffer.from(event.bytes).toString("utf8");
      if (text)
        session.paste(text);
    } catch {}
  });
  const cmd = () => view()?.command;
  const processRunning = () => cmd()?.status === "running" && view()?.live === true;
  const dims = () => {
    const v = view();
    if (!v)
      return `${TERMINAL_FALLBACK_COLS}x${TERMINAL_FALLBACK_ROWS}`;
    return `${v.cols}x${v.viewportRows}`;
  };
  return (() => {
    var _el$ = _$createElement3("box"), _el$2 = _$createElement3("box"), _el$3 = _$createElement3("text"), _el$4 = _$createElement3("span"), _el$5 = _$createTextNode3(`\u2B22 `), _el$9 = _$createElement3("span"), _el$1 = _$createElement3("span"), _el$12 = _$createElement3("text"), _el$13 = _$createElement3("span"), _el$26 = _$createElement3("box"), _el$27 = _$createElement3("box"), _el$28 = _$createElement3("text"), _el$29 = _$createElement3("span"), _el$30 = _$createElement3("span"), _el$32 = _$createElement3("span"), _el$34 = _$createElement3("span"), _el$36 = _$createElement3("span"), _el$38 = _$createElement3("text"), _el$39 = _$createElement3("span"), _el$40 = _$createTextNode3(` \xB7 `), _el$41 = _$createTextNode3(` bytes`);
    _$insertNode3(_el$, _el$2);
    _$insertNode3(_el$, _el$26);
    _$insertNode3(_el$, _el$27);
    _$setProp3(_el$, "flexDirection", "column");
    _$setProp3(_el$, "width", "100%");
    _$setProp3(_el$, "height", "100%");
    _$setProp3(_el$, "padding", 1);
    _$insertNode3(_el$2, _el$3);
    _$insertNode3(_el$2, _el$12);
    _$setProp3(_el$2, "flexDirection", "row");
    _$setProp3(_el$2, "justifyContent", "space-between");
    _$setProp3(_el$2, "flexShrink", 0);
    _$insertNode3(_el$3, _el$4);
    _$insertNode3(_el$3, _el$9);
    _$insertNode3(_el$3, _el$1);
    _$insertNode3(_el$4, _el$5);
    _$insert3(_el$4, () => cmd()?.title ?? "Terminal", null);
    _$insert3(_el$3, _$createComponent3(Show3, {
      get when() {
        return cmd();
      },
      get children() {
        var _el$6 = _$createElement3("span"), _el$7 = _$createTextNode3(` \u2502 `), _el$8 = _$createTextNode3(` \u2502 `);
        _$insertNode3(_el$6, _el$7);
        _$insertNode3(_el$6, _el$8);
        _$insert3(_el$6, () => [cmd().command, ...cmd().args].join(" "), _el$8);
        _$insert3(_el$6, () => cmd().status, null);
        _$insert3(_el$6, (() => {
          var _c$ = _$memo3(() => cmd().exitCode !== undefined);
          return () => _c$() ? ` (${cmd().exitCode})` : "";
        })(), null);
        _$effect3((_$p) => _$setProp3(_el$6, "style", {
          fg: theme().textMuted
        }, _$p));
        return _el$6;
      }
    }), _el$9);
    _$insertNode3(_el$9, _$createTextNode3(` \u2502 `));
    _$insert3(_el$1, () => view()?.connectionDetail ?? "connecting\u2026");
    _$insert3(_el$3, _$createComponent3(Show3, {
      get when() {
        return (view()?.activeBuffer ?? "normal") === "alternate";
      },
      get children() {
        var _el$10 = _$createElement3("span");
        _$insertNode3(_el$10, _$createTextNode3(` \u2502 alt-screen`));
        _$effect3((_$p) => _$setProp3(_el$10, "style", {
          fg: theme().accent
        }, _$p));
        return _el$10;
      }
    }), null);
    _$insertNode3(_el$12, _el$13);
    _$insert3(_el$13, dims, null);
    _$insert3(_el$13, () => processRunning() ? " \xB7 live" : "", null);
    _$insert3(_el$, _$createComponent3(Show3, {
      get when() {
        return view()?.invalid;
      },
      get children() {
        var _el$14 = _$createElement3("box"), _el$15 = _$createElement3("text"), _el$16 = _$createElement3("span"), _el$17 = _$createTextNode3(`Invalid terminal route: `), _el$18 = _$createElement3("span"), _el$19 = _$createTextNode3(`
Press Ctrl+] to go back. Nothing was subscribed or written.`);
        _$insertNode3(_el$14, _el$15);
        _$setProp3(_el$14, "flexDirection", "column");
        _$setProp3(_el$14, "border", true);
        _$setProp3(_el$14, "padding", 1);
        _$setProp3(_el$14, "flexShrink", 0);
        _$insertNode3(_el$15, _el$16);
        _$insertNode3(_el$15, _el$18);
        _$insertNode3(_el$16, _el$17);
        _$insert3(_el$16, () => view()?.invalid, null);
        _$insertNode3(_el$18, _el$19);
        _$effect3((_p$) => {
          var _v$ = theme().error, _v$2 = {
            fg: theme().error,
            bold: true
          }, _v$3 = {
            fg: theme().textMuted
          };
          _v$ !== _p$.e && (_p$.e = _$setProp3(_el$14, "borderColor", _v$, _p$.e));
          _v$2 !== _p$.t && (_p$.t = _$setProp3(_el$16, "style", _v$2, _p$.t));
          _v$3 !== _p$.a && (_p$.a = _$setProp3(_el$18, "style", _v$3, _p$.a));
          return _p$;
        }, {
          e: undefined,
          t: undefined,
          a: undefined
        });
        return _el$14;
      }
    }), _el$26);
    _$insert3(_el$, _$createComponent3(Show3, {
      get when() {
        return _$memo3(() => !!cmd())() && !processRunning();
      },
      get children() {
        var _el$21 = _$createElement3("box"), _el$22 = _$createElement3("text"), _el$23 = _$createElement3("span"), _el$24 = _$createTextNode3(`PROCESS `), _el$25 = _$createTextNode3(` \u2014 saved output only. Ctrl+C/input cannot affect it; Ctrl+] returns to Commands.`);
        _$insertNode3(_el$21, _el$22);
        _$setProp3(_el$21, "border", true);
        _$setProp3(_el$21, "paddingLeft", 1);
        _$setProp3(_el$21, "paddingRight", 1);
        _$setProp3(_el$21, "flexShrink", 0);
        _$insertNode3(_el$22, _el$23);
        _$insertNode3(_el$23, _el$24);
        _$insertNode3(_el$23, _el$25);
        _$insert3(_el$23, () => cmd().status.toUpperCase(), _el$25);
        _$insert3(_el$23, (() => {
          var _c$2 = _$memo3(() => cmd().exitCode !== undefined);
          return () => _c$2() ? ` (exit ${cmd().exitCode})` : "";
        })(), _el$25);
        _$effect3((_p$) => {
          var _v$4 = theme().warning, _v$5 = {
            fg: theme().warning,
            bold: true
          };
          _v$4 !== _p$.e && (_p$.e = _$setProp3(_el$21, "borderColor", _v$4, _p$.e));
          _v$5 !== _p$.t && (_p$.t = _$setProp3(_el$23, "style", _v$5, _p$.t));
          return _p$;
        }, {
          e: undefined,
          t: undefined
        });
        return _el$21;
      }
    }), _el$26);
    _$use3((el) => {
      viewportEl = el;
      try {
        el.onSizeChange = () => measureViewport();
      } catch {}
      setTimeout(measureViewport, 50);
    }, _el$26);
    _$setProp3(_el$26, "flexDirection", "column");
    _$setProp3(_el$26, "flexGrow", 1);
    _$setProp3(_el$26, "minHeight", 0);
    _$setProp3(_el$26, "overflow", "hidden");
    _$insert3(_el$26, _$createComponent3(Show3, {
      get when() {
        return _$memo3(() => !!view())() && view().rows.length > 0;
      },
      get fallback() {
        return (() => {
          var _el$42 = _$createElement3("text"), _el$43 = _$createElement3("span");
          _$insertNode3(_el$42, _el$43);
          _$insert3(_el$43, () => view()?.invalid ? "" : "(no output yet)");
          _$effect3((_$p) => _$setProp3(_el$43, "style", {
            fg: theme().textMuted
          }, _$p));
          return _el$42;
        })();
      },
      get children() {
        return _$createComponent3(For3, {
          get each() {
            return buildTerminalRows(view().rows, view().cols, view().viewportRows, {
              ...view().cursor,
              visible: processRunning() && view().cursor.visible
            });
          },
          children: (runs) => (() => {
            var _el$44 = _$createElement3("text");
            _$setProp3(_el$44, "wrapMode", "none");
            _$setProp3(_el$44, "truncate", true);
            _$insert3(_el$44, _$createComponent3(For3, {
              each: runs,
              children: (run) => (() => {
                var _el$45 = _$createElement3("span");
                _$insert3(_el$45, () => run.text);
                _$effect3((_$p) => _$setProp3(_el$45, "style", {
                  fg: run.cursor ? theme().background : run.inverse ? run.fg ?? theme().background : run.fg ?? theme().text,
                  bg: run.cursor ? theme().primary : run.inverse ? run.bg ?? theme().text : run.bg,
                  bold: run.bold ?? run.cursor,
                  underline: run.underline
                }, _$p));
                return _el$45;
              })()
            }));
            return _el$44;
          })()
        });
      }
    }));
    _$insertNode3(_el$27, _el$28);
    _$insertNode3(_el$27, _el$38);
    _$setProp3(_el$27, "flexDirection", "row");
    _$setProp3(_el$27, "justifyContent", "space-between");
    _$setProp3(_el$27, "flexShrink", 0);
    _$insertNode3(_el$28, _el$29);
    _$insertNode3(_el$28, _el$30);
    _$insertNode3(_el$28, _el$32);
    _$insertNode3(_el$28, _el$34);
    _$insertNode3(_el$28, _el$36);
    _$insert3(_el$29, () => processRunning() ? "type to write \xB7 " : "saved log \xB7 ");
    _$insertNode3(_el$30, _$createTextNode3(`Ctrl+C`));
    _$insertNode3(_el$32, _$createTextNode3(` interrupt \xB7 `));
    _$insertNode3(_el$34, _$createTextNode3(`Ctrl+]`));
    _$insertNode3(_el$36, _$createTextNode3(` detach (keeps running)`));
    _$insertNode3(_el$38, _el$39);
    _$insertNode3(_el$39, _el$40);
    _$insertNode3(_el$39, _el$41);
    _$insert3(_el$39, dims, _el$40);
    _$insert3(_el$39, () => view()?.totalBytes ?? 0, _el$41);
    _$effect3((_p$) => {
      var _v$6 = {
        fg: theme().primary,
        bold: true
      }, _v$7 = {
        fg: theme().textMuted
      }, _v$8 = {
        fg: cmd() && !processRunning() ? theme().warning : view()?.connection === "stream" ? theme().success : view()?.connection === "polling" ? theme().warning : theme().error
      }, _v$9 = {
        fg: theme().textMuted
      }, _v$0 = {
        fg: theme().textMuted
      }, _v$1 = {
        fg: theme().warning,
        bold: true
      }, _v$10 = {
        fg: theme().textMuted
      }, _v$11 = {
        fg: theme().warning,
        bold: true
      }, _v$12 = {
        fg: theme().textMuted
      }, _v$13 = {
        fg: theme().textMuted
      };
      _v$6 !== _p$.e && (_p$.e = _$setProp3(_el$4, "style", _v$6, _p$.e));
      _v$7 !== _p$.t && (_p$.t = _$setProp3(_el$9, "style", _v$7, _p$.t));
      _v$8 !== _p$.a && (_p$.a = _$setProp3(_el$1, "style", _v$8, _p$.a));
      _v$9 !== _p$.o && (_p$.o = _$setProp3(_el$13, "style", _v$9, _p$.o));
      _v$0 !== _p$.i && (_p$.i = _$setProp3(_el$29, "style", _v$0, _p$.i));
      _v$1 !== _p$.n && (_p$.n = _$setProp3(_el$30, "style", _v$1, _p$.n));
      _v$10 !== _p$.s && (_p$.s = _$setProp3(_el$32, "style", _v$10, _p$.s));
      _v$11 !== _p$.h && (_p$.h = _$setProp3(_el$34, "style", _v$11, _p$.h));
      _v$12 !== _p$.r && (_p$.r = _$setProp3(_el$36, "style", _v$12, _p$.r));
      _v$13 !== _p$.d && (_p$.d = _$setProp3(_el$39, "style", _v$13, _p$.d));
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
    return _el$;
  })();
}

// src/v2/native-rpc.ts
var NATIVE_RPC_ID = "loopd.native";
function resolveNativeParentID(child) {
  return child.fork?.sessionID ?? child.parentID ?? undefined;
}
var requestSchema = {
  type: "object",
  properties: {
    requestID: { type: "string" },
    goalID: { type: "string" },
    parentSessionID: { type: "string" },
    title: { type: "string" },
    agent: { type: "string" },
    model: {
      type: "object",
      properties: {
        id: { type: "string" },
        providerID: { type: "string" }
      },
      required: ["id", "providerID"],
      additionalProperties: false
    },
    permissions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          action: { type: "string" },
          resource: { type: "string" },
          effect: { type: "string", enum: ["allow", "deny", "ask"] }
        },
        required: ["action", "resource", "effect"],
        additionalProperties: false
      }
    },
    directory: { type: "string" }
  },
  required: ["requestID", "goalID", "parentSessionID", "title"],
  additionalProperties: false
};
var claimResultSchema = {
  type: "object",
  properties: {
    requestID: { type: "string" },
    claimantID: { type: "string" }
  },
  required: ["requestID", "claimantID"],
  additionalProperties: false
};
var claimAckSchema = {
  type: "object",
  properties: {
    requestID: { type: "string" },
    claimantID: { type: "string" },
    won: { type: "boolean" }
  },
  required: ["requestID", "claimantID", "won"],
  additionalProperties: false
};
var createResultSchema = {
  type: "object",
  properties: {
    requestID: { type: "string" },
    childSessionID: { type: "string" },
    parentSessionID: { type: "string" },
    topology: { type: "string", const: "v2-native-child" }
  },
  required: ["requestID", "childSessionID", "parentSessionID", "topology"],
  additionalProperties: false
};
var failureSchema = {
  type: "object",
  properties: {
    requestID: { type: "string" },
    reason: { type: "string" },
    detail: { type: "string" },
    preCreation: { type: "boolean" }
  },
  required: ["requestID", "reason", "preCreation"],
  additionalProperties: false
};
var emptySchema = {
  type: "object",
  properties: {},
  additionalProperties: false
};
var nativeRpcDefinition = {
  id: NATIVE_RPC_ID,
  methods: {
    claimRequest: { input: claimResultSchema, output: claimAckSchema, errors: {} },
    completeWorkerCreate: { input: createResultSchema, output: emptySchema, errors: {} },
    failRequest: { input: failureSchema, output: emptySchema, errors: {} }
  },
  events: {
    workerCreateRequested: { schema: requestSchema }
  }
};

// src/v2/native-tui.ts
function subscribeNativeRequests(rpcClient, deps) {
  return rpcClient.events.on("workerCreateRequested", (event) => {
    const request = event?.data;
    if (!request || typeof request.requestID !== "string")
      return;
    const directory = event?.location?.directory;
    const options = typeof directory === "string" && directory.length > 0 ? { location: { directory } } : undefined;
    handleWorkerCreateRequest(request, {
      ...deps,
      claim: (input) => rpcClient.claimRequest(input, options).then((ack) => ({ won: ack?.won === true })),
      complete: (result) => rpcClient.completeWorkerCreate(result, options),
      fail: (failure) => rpcClient.failRequest(failure, options)
    }).then((outcome) => {
      try {
        deps.onOutcome?.(outcome, request.requestID);
      } catch {}
    }, () => {});
  });
}
async function handleWorkerCreateRequest(request, deps) {
  const parent = deps.data.session.get(request.parentSessionID);
  if (!parent)
    return { handled: "ignored-unknown-parent" };
  if (deps.isKnownParent && !deps.isKnownParent(request.parentSessionID)) {
    return { handled: "ignored-unknown-parent" };
  }
  const { won } = await deps.claim({ requestID: request.requestID, claimantID: deps.claimantID });
  if (!won)
    return { handled: "claim-lost" };
  const fail = (reason, preCreation, detail) => deps.fail({ requestID: request.requestID, reason, preCreation, detail }).then(() => ({
    handled: "failed",
    reason,
    preCreation
  }));
  let forkInput;
  try {
    const messages = deps.data.session.message.list(request.parentSessionID);
    const firstID = messages[0]?.id;
    forkInput = firstID ? { sessionID: request.parentSessionID, before: firstID } : { sessionID: request.parentSessionID };
  } catch (error) {
    return fail("message-list-failed", true, error instanceof Error ? error.message : String(error));
  }
  let child;
  try {
    child = await deps.client.session.fork(forkInput);
  } catch (error) {
    return fail("fork-failed", true, error instanceof Error ? error.message : String(error));
  }
  const actualParent = resolveNativeParentID(child);
  if (actualParent !== request.parentSessionID) {
    return fail("parent-mismatch", false, `resolved-parent=${JSON.stringify(actualParent)} expected=${JSON.stringify(request.parentSessionID)}`);
  }
  try {
    if (request.agent && deps.client.session.switchAgent) {
      await deps.client.session.switchAgent({ sessionID: child.id, agent: request.agent });
    }
    if (request.model && deps.client.session.switchModel) {
      await deps.client.session.switchModel({ sessionID: child.id, model: request.model });
    }
    if (deps.client.session.update) {
      await deps.client.session.update({ sessionID: child.id, title: request.title });
    }
  } catch (error) {
    return fail("configure-failed", false, error instanceof Error ? error.message : String(error));
  }
  await deps.complete({
    requestID: request.requestID,
    childSessionID: child.id,
    parentSessionID: request.parentSessionID,
    topology: "v2-native-child"
  });
  return { handled: "completed", childSessionID: child.id, forkInput };
}

// src/tui/plugin.tsx
var PLUGIN_ID = "opencode-loopd.tui";
function navigateToTerminalV1(api, commandID, ownerSessionID, returnSessionID) {
  const payload = terminalRoutePayload(commandID, ownerSessionID, returnSessionID);
  try {
    api.route.navigate(TERMINAL_ROUTE_NAME, payload);
    api.ui.dialog.clear();
    return true;
  } catch {
    return false;
  }
}
var tui = async (api) => {
  const directory = api.state.path.directory;
  let terminalRouteAvailable = false;
  let unregisterTerminalRoute;
  try {
    unregisterTerminalRoute = api.route.register([{
      name: TERMINAL_ROUTE_NAME,
      render: ({
        params
      }) => _$createComponent4(TerminalView, {
        api,
        directory,
        data: params
      })
    }]);
    terminalRouteAvailable = true;
  } catch {
    terminalRouteAvailable = false;
  }
  const openTerminal = (commandID, ownerSessionID, returnSessionID) => {
    if (terminalRouteAvailable && navigateToTerminalV1(api, commandID, ownerSessionID, returnSessionID))
      return;
    const previousFocus = api.renderer.currentFocusedRenderable;
    api.ui.dialog.replace(() => _$createComponent4(CommandPanel, {
      api,
      directory,
      ownerSessionID,
      onOpenCommand: (payload) => openTerminal(payload.commandID, payload.ownerSessionID, payload.returnSessionID)
    }));
    api.ui.dialog.setSize("xlarge");
    previousFocus?.blur();
  };
  const open = () => {
    const previousFocus = api.renderer.currentFocusedRenderable;
    api.ui.dialog.replace(() => _$createComponent4(LoopDashboard, {
      api,
      directory
    }));
    api.ui.dialog.setSize("xlarge");
    previousFocus?.blur();
  };
  const openCommands = () => {
    const previousFocus = api.renderer.currentFocusedRenderable;
    api.ui.dialog.replace(() => _$createComponent4(LoopDashboard, {
      api,
      directory,
      initialView: "commands",
      get ownerSessionID() {
        return currentRouteSessionID(api);
      },
      onOpenCommand: (payload) => openTerminal(payload.commandID, payload.ownerSessionID, payload.returnSessionID)
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
  api.lifecycle.onDispose(() => {
    try {
      unregisterTerminalRoute?.();
    } catch {}
  });
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
function navigateToTerminalV2(router, commandID, ownerSessionID, returnSessionID) {
  try {
    router.navigate({
      type: "plugin",
      name: TERMINAL_ROUTE_NAME,
      data: terminalRoutePayload(commandID, ownerSessionID, returnSessionID)
    });
    return true;
  } catch {
    return false;
  }
}
var v2setup = (ctx) => {
  const directory = ctx.location?.directory ?? ctx.data.location.default().directory;
  const claimantID = `tui-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
  let unsubscribeNative;
  try {
    const rpcClient = ctx.client.rpc(nativeRpcDefinition);
    unsubscribeNative = subscribeNativeRequests(rpcClient, {
      client: {
        session: {
          fork: (input) => ctx.client.session.fork(input),
          switchAgent: (input) => ctx.client.session.switchAgent(input),
          switchModel: (input) => ctx.client.session.switchModel(input),
          update: (input) => ctx.client.session.update(input)
        }
      },
      data: {
        session: {
          get: (sessionID) => {
            const session = ctx.data.session.get(sessionID);
            return session ? {
              id: session.id
            } : undefined;
          },
          message: {
            list: (sessionID) => ctx.data.session.message.list(sessionID).map((message) => ({
              id: message.id
            }))
          }
        }
      },
      claimantID,
      isKnownParent: (parentSessionID) => {
        const parent = ctx.data.session.get(parentSessionID);
        if (!parent)
          return false;
        const parentDirectory = parent.location?.directory;
        if (!parentDirectory)
          return true;
        return parentDirectory === directory;
      }
    });
  } catch {
    unsubscribeNative = undefined;
  }
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
  let terminalRouteAvailable = false;
  let unregisterTerminalRoute;
  try {
    unregisterTerminalRoute = ctx.ui.router.register({
      name: TERMINAL_ROUTE_NAME,
      render: ({
        data
      }) => _$createComponent4(TerminalView, {
        api: facade,
        directory,
        data
      })
    });
    terminalRouteAvailable = true;
  } catch {
    terminalRouteAvailable = false;
  }
  const openTerminal = (commandID, ownerSessionID, returnSessionID) => {
    if (!terminalRouteAvailable)
      return false;
    const ok = navigateToTerminalV2(ctx.ui.router, commandID, ownerSessionID, returnSessionID);
    if (ok) {
      try {
        ctx.ui.panel.close();
      } catch {}
      closeDialog();
    }
    return ok;
  };
  const open = () => {
    const previousFocus = ctx.renderer.currentFocusedRenderable;
    dialogOpen = true;
    ctx.ui.dialog.show(() => _$createComponent4(LoopDashboard, {
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
    ctx.ui.dialog.show(() => _$createComponent4(LoopDashboard, {
      api: facade,
      directory,
      initialView: "commands",
      ownerSessionID: undefined,
      onOpenCommand: (payload) => {
        openTerminal(payload.commandID, payload.ownerSessionID, payload.returnSessionID);
      }
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
    render: (input) => input.name === commandsPanel ? _$createComponent4(LoopDashboard, {
      api: facade,
      directory,
      initialView: "commands",
      get ownerSessionID() {
        return input.sessionID;
      },
      onOpenCommand: (payload) => {
        openTerminal(payload.commandID, payload.ownerSessionID, payload.returnSessionID);
      },
      isActive: () => input.focused !== false
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
    try {
      unsubscribeNative?.();
    } catch {}
    try {
      unregisterTerminalRoute?.();
    } catch {}
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
  plugin_default as default,
  navigateToTerminalV1,
  navigateToTerminalV2
};

// @bun
var __require = import.meta.require;

// src/tui/plugin.tsx
import { createComponent as _$createComponent6 } from "@opentui/solid";

// src/tui/dashboard.tsx
import { createComponent as _$createComponent3 } from "@opentui/solid";
import { createTextNode as _$createTextNode3 } from "@opentui/solid";
import { memo as _$memo3 } from "@opentui/solid";
import { insertNode as _$insertNode3 } from "@opentui/solid";
import { spread as _$spread3 } from "@opentui/solid";
import { mergeProps as _$mergeProps3 } from "@opentui/solid";
import { effect as _$effect3 } from "@opentui/solid";
import { insert as _$insert3 } from "@opentui/solid";
import { setProp as _$setProp3 } from "@opentui/solid";
import { use as _$use3 } from "@opentui/solid";
import { createElement as _$createElement3 } from "@opentui/solid";
import { batch, createSignal, For as For3, Show as Show3, onCleanup, onMount, createEffect } from "solid-js";
import { useKeyboard, useTerminalDimensions } from "@opentui/solid";

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
var CURRENT_VERSION = 10;
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
        throw error;
      await delay(25 * (attempt + 1));
    }
  }
  throw new Error("State could not be read.");
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
  if (result.version < 10) {
    result.version = 10;
    if (!result.writeTickets)
      result.writeTickets = { holders: [], queue: [] };
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
function processingFile(directory, requestID) {
  return path.join(controlDir(directory), "processing", `${requestID}.json`);
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
async function statProcessingRequest(directory, requestID) {
  try {
    const st = await fs2.stat(processingFile(directory, requestID));
    return { requestAgeMs: Math.max(0, Date.now() - st.mtimeMs) };
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
import { randomUUID } from "crypto";
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
    let submitted = false;
    let expired = false;
    let timeoutReply;
    const deadline = performance.now() + timeoutMs;
    function timedOut() {
      return timeoutReply ??= (async () => {
        let probeTimer;
        let claimed;
        try {
          claimed = await Promise.race([
            statProcessingRequest(directory, request.requestID),
            new Promise((resolve) => {
              probeTimer = setTimeout(() => resolve(undefined), 100);
            })
          ]);
        } catch {} finally {
          if (probeTimer)
            clearTimeout(probeTimer);
        }
        const stage = claimed ? `accepted by the server ${(claimed.requestAgeMs / 1000).toFixed(1)}s ago, still processing` : submitted ? "request submitted; server acceptance or response could not be confirmed" : "request submission is still pending";
        return {
          requestID: request.requestID,
          ok: false,
          errorCode: "timeout",
          message: `timeout waiting for response (${stage}; the operation may complete later under this requestID \u2014 check the server log before retrying)`,
          completedAt: new Date().toISOString()
        };
      })();
    }
    async function exchange() {
      await writeControlRequest(directory, request);
      submitted = true;
      while (!expired && performance.now() < deadline) {
        const response = await readControlResponse(directory, request.requestID);
        if (response)
          return response;
        if (!expired)
          await delay2(Math.min(100, Math.max(0, deadline - performance.now())));
      }
      if (!expired) {
        const late = await readControlResponse(directory, request.requestID);
        if (late)
          return late;
      }
      return timedOut();
    }
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => {
        expired = true;
        timedOut().then(resolve);
      }, timeoutMs);
    });
    try {
      return await Promise.race([exchange(), timeout]);
    } finally {
      expired = true;
      if (timer)
        clearTimeout(timer);
    }
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
var PHASE_META = {
  idle: { short: "Idle", hint: "between turns" },
  queued: { short: "Queued", hint: "waiting to start" },
  running: { short: "Reserved", hint: "turn reserved; activity unconfirmed" },
  compacting: { short: "Compacting", hint: "summarizing context" },
  waiting_retry: { short: "Retrying", hint: "backing off" },
  stopping: { short: "Stopping", hint: "abort in flight" }
};
function phaseLabel(phase) {
  return PHASE_META[phase] ?? { short: phase, hint: "" };
}
function workerActivityLabel(runtime, now = Date.now()) {
  if (runtime.phase !== "running")
    return { ...phaseLabel(runtime.phase), acting: false };
  if (runtime.executionSource === "native") {
    const status = runtime.nativeExecutionStatus;
    if (status === "busy")
      return { short: "Running", hint: "OpenCode execution is active", acting: true };
    if (status === "retry")
      return { short: "Retrying", hint: "OpenCode is retrying execution", acting: false };
    if (status === "idle")
      return { short: "Finishing", hint: "OpenCode is idle; reconciling goal outcome", acting: false };
    return { short: "Unconfirmed", hint: "native execution state unavailable", acting: false };
  }
  const expires = runtime.leaseExpiresAt ? Date.parse(runtime.leaseExpiresAt) : NaN;
  if (Number.isFinite(expires) && expires <= now)
    return { short: "Stale", hint: "lease expired; activity unconfirmed (not proof of worker exit)", acting: false };
  if (runtime.lastWorkerStatus === "retry")
    return { short: "Retrying", hint: "provider is retrying; the prompt may already be accepted", acting: false };
  if (!Number.isFinite(expires) || (runtime.unknownStatusCount ?? 0) > 0)
    return { short: "Unconfirmed", hint: "worker status unavailable; do not assume the prompt failed", acting: false };
  if (runtime.activeAssistantCompletedAt)
    return { short: "Finishing", hint: "response completed; waiting for turn reconciliation", acting: false };
  if (runtime.activePromptObservedAt && runtime.lastWorkerStatus !== "idle" && (runtime.activeAssistantMessageID || runtime.activeToolCallIDs?.length)) {
    return { short: "Running", hint: "correlated assistant or tool activity observed", acting: true };
  }
  if (runtime.activePromptObservedAt)
    return { short: "Prompt seen", hint: "prompt observed; response activity not confirmed", acting: false };
  if (runtime.activePromptAcceptedAt)
    return { short: "Awaiting", hint: "host accepted prompt; transcript activity not confirmed", acting: false };
  if (runtime.activePromptDispatchAt)
    return { short: "Sending", hint: "dispatch requested; awaiting host acceptance", acting: false };
  return { short: "Requested", hint: "run reserved; no dispatch evidence yet", acting: false };
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
  if (view === "project")
    return "fleet";
  if (view === "fleet")
    return "commands";
  return "project";
}
function toggleDashboardViewBack(view) {
  if (view === "project")
    return "commands";
  if (view === "fleet")
    return "project";
  return "fleet";
}
function dashboardViewForKey(key) {
  if (key === "1")
    return "project";
  if (key === "2")
    return "fleet";
  if (key === "3")
    return "commands";
  return;
}
function goalSelectionKey(directory, goalID) {
  return `${directory}
${goalID}`;
}
function moveDashboardSelection(sel, move, goalCount, commandCount) {
  if (sel.view !== "commands") {
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
  if (sel.view === "project" || sel.view === "fleet") {
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
function indexForSelectionKey(keysInOrder, key) {
  if (!key)
    return 0;
  const idx = keysInOrder.indexOf(key);
  return idx < 0 ? 0 : idx;
}
function toggleCollapsed(collapsed, directory) {
  return collapsed.includes(directory) ? collapsed.filter((d) => d !== directory) : [...collapsed, directory];
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

// src/infrastructure/managed-dirs.ts
import { promises as fs3 } from "fs";
import path2 from "path";
var REGISTRY_VERSION = 1;
function registryFile(instanceDir) {
  return path2.join(instanceDir, ".opencode", "loopd", "managed.json");
}
function normalizeDir(input) {
  return path2.normalize(input);
}
function resolveEntry(instanceDir, entry) {
  if (path2.isAbsolute(entry))
    return normalizeDir(entry);
  return normalizeDir(path2.resolve(instanceDir, entry));
}
async function readRegistry(instanceDir) {
  try {
    const raw = await fs3.readFile(registryFile(instanceDir), "utf8");
    const parsed = JSON.parse(raw);
    const dirs = Array.isArray(parsed.dirs) ? parsed.dirs.filter((d) => typeof d === "string" && d.trim().length > 0) : [];
    return { version: REGISTRY_VERSION, dirs };
  } catch (error) {
    if (error?.code === "ENOENT")
      return { version: REGISTRY_VERSION, dirs: [] };
    throw error;
  }
}
function parseManagedDirsEnv(envValue) {
  const raw = envValue !== undefined ? envValue : process?.env?.LOOPD_MANAGED_DIRS;
  if (typeof raw !== "string" || !raw)
    return [];
  const sep = path2.delimiter;
  return raw.split(sep).map((s) => s.trim()).filter(Boolean);
}
async function resolveManagedDirs(instanceDir, opts = {}) {
  const root = normalizeDir(path2.resolve(instanceDir));
  const seen = new Set([root]);
  const result = [root];
  const push = (entry) => {
    const trimmed = entry.trim();
    if (!trimmed)
      return;
    const resolved = resolveEntry(root, trimmed);
    if (!seen.has(resolved)) {
      seen.add(resolved);
      result.push(resolved);
    }
  };
  const registry = await readRegistry(instanceDir);
  for (const entry of registry.dirs)
    push(entry);
  for (const entry of parseManagedDirsEnv(opts.env))
    push(entry);
  for (const entry of opts.extra ?? [])
    push(entry);
  return result;
}

// src/server/managed-status.ts
async function resolveManagedDirs2(currentDir, extra) {
  return resolveManagedDirs(currentDir, { extra });
}

// src/tui/dashboard-presentation.ts
var PALETTE = {
  base: "#242736",
  inset: "#1c1f2b",
  rule: "#4e5468",
  rowRule: "#383d52",
  selectedBg: "#1e3538",
  ink: "#f3f5fa",
  muted: "#b4bbd0",
  cyan: "#67e8f9",
  amber: "#fbbf24",
  rose: "#fb7185",
  sage: "#4ade80",
  violet: "#c4b5fd",
  sky: "#38bdf8",
  tabActiveFg: "#11131a"
};
function paletteFor(t) {
  const c = (v, fallback) => v ?? fallback;
  return {
    ...PALETTE,
    base: c(t.background, PALETTE.base),
    inset: c(t.backgroundPanel, PALETTE.inset),
    rule: c(t.border, PALETTE.rule),
    rowRule: c(t.borderSubtle, PALETTE.rowRule),
    selectedBg: c(t.backgroundElement, PALETTE.selectedBg),
    ink: c(t.text, PALETTE.ink),
    muted: c(t.textMuted, PALETTE.muted),
    tabActiveFg: c(t.background, PALETTE.tabActiveFg)
  };
}
var ATTENTION_STATES = new Set(["blocked", "budget_limited", "usage_limited"]);
function stateSymbol(status, manual) {
  if (status === "blocked" || status === "budget_limited" || status === "usage_limited")
    return "\u2716";
  if (status === "active")
    return manual ? "\u25D0" : "\u25CF";
  if (status === "paused")
    return "\u2016";
  if (status === "complete")
    return "\u2713";
  return "\u2022";
}
function toRowModel(goal, directory, runtime, now, opts) {
  const activity = runtime ? workerActivityLabel(runtime, now) : undefined;
  const stateLabel = goalStatusShort(goal.status);
  let attention = null;
  let attentionText;
  if (goal.status === "blocked") {
    attention = "blocker";
    attentionText = goal.blocker?.reason?.replace(/\s+/g, " ").slice(0, 100) ?? "blocked";
  } else if (ATTENTION_STATES.has(goal.status)) {
    attention = "limit";
    attentionText = stateLabel;
  }
  if (runtime) {
    const rt = runtime;
    if ((rt.unknownStatusCount ?? 0) >= 3) {
      attention = "unreachable";
      attentionText = "worker unreachable \u2014 nudge to recover";
    } else if (rt.phase === "idle" && rt.activeRunID) {
      attention = "stale";
      attentionText = "stale lease \u2014 nudge to force a turn";
    } else if ((rt.consecutiveFailures ?? 0) > 0 && goal.status !== "blocked") {
      attention = "error";
      attentionText = `${rt.consecutiveFailures} failures`;
    } else if ((rt.evaluatorRejectionCount ?? 0) > 0 && goal.status !== "blocked") {
      attention = "error";
      attentionText = `${rt.evaluatorRejectionCount} check rejections`;
    }
  }
  const maxTurns = goal.config?.maxTurns;
  const turnText = runtime ? `${runtime.budgetTurnCount}${maxTurns ? `/${maxTurns}` : ""}` : undefined;
  const manual = goal.interactive === true;
  const rawLabel = goal.status === "active" ? activeGoalLabel(goal, runtime, opts) : stateLabel;
  const sym = stateSymbol(goal.status, manual);
  const label = `${sym} ${rawLabel}`;
  const activityLine = goal.status === "blocked" && goal.blocker?.reason ? goal.blocker.reason.replace(/\s+/g, " ") : attentionText ? attentionText : goal.lastProgress?.summary ? goal.lastProgress.summary.replace(/\s+/g, " ") : activity ? `${activity.short} \u2014 ${activity.hint}` : "no runtime yet";
  return {
    id: goal.id,
    directory,
    name: goal.name,
    state: goal.status,
    stateLabel: label,
    activity: activityLine,
    updated: ageText(runtime?.lastProgressAt ?? runtime?.lastRunAt, now),
    attention,
    attentionText,
    turnText,
    manual
  };
}
var ROW_COLS = { name: 24, state: 17, activity: 34, updated: 8 };
function col(text, width) {
  const chars = [...text];
  if (chars.length > width)
    return `${chars.slice(0, width - 1).join("")}\u2026`;
  return text + " ".repeat(width - chars.length);
}
function formatRowColumns(row, activityWidth = ROW_COLS.activity) {
  return {
    name: col(row.name, ROW_COLS.name),
    state: col(row.stateLabel, ROW_COLS.state),
    activity: col(row.activity, activityWidth),
    updated: col(row.updated, ROW_COLS.updated)
  };
}
function isAwaitingInput(goal, runtime, confirmedIdle, queuedInput) {
  if (goal.status !== "active")
    return false;
  if (goal.interactive !== true)
    return false;
  if (!runtime || runtime.phase !== "idle")
    return false;
  const rt = runtime;
  if (rt.activeRunID)
    return false;
  if (queuedInput)
    return false;
  return confirmedIdle;
}
function activeGoalLabel(goal, runtime, opts) {
  if (!goal.interactive)
    return "Working";
  const queuedInput = opts?.queuedInput ?? Boolean(runtime?.nativeInboxMessageIDs?.length);
  const confirmedIdle = opts?.confirmedIdle ?? (runtime?.executionSource === "native" ? runtime.nativeExecutionStatus === "idle" : runtime?.lastWorkerStatus === "idle");
  if (isAwaitingInput(goal, runtime, confirmedIdle, queuedInput))
    return "Awaiting input";
  if (runtime?.phase === "running" || runtime?.activeRunID || runtime?.nativeExecutionStatus === "busy")
    return "Working";
  if (queuedInput)
    return "Input queued";
  return "Manual";
}
var FOOT_HINTS = [
  "1/2/3 tabs",
  "j/k move",
  "? help",
  "Esc close"
];
function fitHintBar(hints, maxWidth) {
  if (maxWidth <= 1)
    return "\u2026";
  const full = hints.join(" \xB7 ");
  if ([...full].length <= maxWidth)
    return full;
  for (let n = hints.length - 1;n >= 1; n--) {
    const candidate = `${hints.slice(0, n).join(" \xB7 ")} \u2026`;
    if ([...candidate].length <= maxWidth)
      return candidate;
  }
  const first = `${hints[0]} \u2026`;
  return [...first].length <= maxWidth ? first : "\u2026";
}
function goalStatusShort(status) {
  switch (status) {
    case "active":
      return "Active";
    case "paused":
      return "Paused";
    case "blocked":
      return "Blocked";
    case "complete":
      return "Complete";
    case "budget_limited":
      return "Budget limited";
    case "usage_limited":
      return "Usage limited";
    default:
      return String(status);
  }
}
function summarizeScope(goals, isAwaiting) {
  const out = { needsAction: 0, working: 0, awaiting: 0, paused: 0, done: 0 };
  goals.forEach((g, i) => {
    if (g.status === "blocked" || g.status === "budget_limited" || g.status === "usage_limited")
      out.needsAction += 1;
    else if (g.status === "active" && isAwaiting(i))
      out.awaiting += 1;
    else if (g.status === "active")
      out.working += 1;
    else if (g.status === "paused")
      out.paused += 1;
    else if (g.status === "complete")
      out.done += 1;
  });
  return out;
}
function summaryText(s) {
  const parts = [`${s.needsAction} needs action`, `${s.working} working`, `${s.awaiting} awaiting input`];
  if (s.paused > 0)
    parts.push(`${s.paused} paused`);
  return parts.join(" \xB7 ");
}
function groupByDirectory(rows, collapsed) {
  const order = [];
  const byDir = new Map;
  for (const row of rows) {
    if (collapsed.includes(row.directory))
      continue;
    if (!byDir.has(row.directory)) {
      byDir.set(row.directory, []);
      order.push(row.directory);
    }
    byDir.get(row.directory).push(row);
  }
  return order.map((directory) => {
    const group = byDir.get(directory);
    return {
      directory,
      shortName: directory.split("/").pop() || directory,
      needsAction: group.filter((r) => r.attention === "blocker" || r.attention === "limit").length,
      working: group.filter((r) => r.attention === null && r.state === "active").length,
      rows: group
    };
  });
}
function filterRows(rows, query) {
  const q = query.trim().toLowerCase();
  if (!q)
    return rows;
  return rows.filter((r) => `${r.name} ${r.stateLabel} ${r.activity} ${r.directory}`.toLowerCase().includes(q));
}
function ageText(timestamp, now) {
  if (!timestamp)
    return "never";
  const seconds = Math.max(0, Math.floor((now - Date.parse(timestamp)) / 1000));
  if (seconds < 60)
    return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60)
    return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48)
    return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

// src/tui/goal-details.tsx
import { createComponent as _$createComponent } from "@opentui/solid";
import { use as _$use } from "@opentui/solid";
import { effect as _$effect } from "@opentui/solid";
import { createTextNode as _$createTextNode } from "@opentui/solid";
import { insertNode as _$insertNode } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
import { setProp as _$setProp } from "@opentui/solid";
import { spread as _$spread } from "@opentui/solid";
import { mergeProps as _$mergeProps } from "@opentui/solid";
import { memo as _$memo } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
import { For, Show } from "solid-js";
function stateBadge(goal, runtime) {
  if (goal.status === "blocked") {
    return {
      text: "\u2716 Blocked",
      fg: PALETTE.rose,
      nameFg: PALETTE.rose
    };
  }
  if (goal.status === "budget_limited" || goal.status === "usage_limited") {
    return {
      text: `! ${goalStatusShort(goal.status)}`,
      fg: PALETTE.rose,
      nameFg: PALETTE.rose
    };
  }
  if (goal.status === "active") {
    const label = activeGoalLabel(goal, runtime);
    return label !== "Working" ? {
      text: `\u25D0 ${label}`,
      fg: PALETTE.amber,
      nameFg: PALETTE.amber
    } : {
      text: "\u25CF Working",
      fg: PALETTE.sage,
      nameFg: PALETTE.sage
    };
  }
  if (goal.status === "paused") {
    return {
      text: "\u2016 Paused",
      fg: PALETTE.violet,
      nameFg: PALETTE.violet
    };
  }
  if (goal.status === "complete") {
    return {
      text: "\u2713 Completed",
      fg: PALETTE.sky,
      nameFg: PALETTE.sky
    };
  }
  return {
    text: goalStatusShort(goal.status),
    fg: PALETTE.ink,
    nameFg: PALETTE.cyan
  };
}
function GoalInspector(props) {
  const PALETTE2 = paletteFor(props.theme);
  const m = () => props.model;
  const badge = () => stateBadge(m().goal, m().runtime);
  const proj = () => m().directory.split("/").pop() ?? m().directory;
  const btn = (label, keyHint, onClick, active = false, hintColor = PALETTE2.cyan) => (() => {
    var _el$ = _$createElement("box"), _el$2 = _$createElement("text"), _el$3 = _$createElement("span"), _el$4 = _$createTextNode(` `), _el$5 = _$createElement("span"), _el$6 = _$createTextNode(`[`), _el$7 = _$createTextNode(`]`);
    _$insertNode(_el$, _el$2);
    _$setProp(_el$, "flexDirection", "row");
    _$setProp(_el$, "border", true);
    _$setProp(_el$, "paddingLeft", 1);
    _$setProp(_el$, "paddingRight", 1);
    _$spread(_el$, _$mergeProps({
      get backgroundColor() {
        return active ? PALETTE2.cyan : PALETTE2.base;
      },
      get borderColor() {
        return active ? PALETTE2.cyan : PALETTE2.rule;
      }
    }, {
      onMouseDown: onClick
    }), true);
    _$insertNode(_el$2, _el$3);
    _$insertNode(_el$2, _el$5);
    _$setProp(_el$2, "wrapMode", "none");
    _$insertNode(_el$3, _el$4);
    _$insert(_el$3, label, _el$4);
    _$insertNode(_el$5, _el$6);
    _$insertNode(_el$5, _el$7);
    _$insert(_el$5, keyHint, _el$7);
    _$effect((_p$) => {
      var _v$ = {
        fg: active ? PALETTE2.tabActiveFg : PALETTE2.ink,
        bold: active
      }, _v$2 = {
        fg: active ? PALETTE2.tabActiveFg : hintColor,
        bold: true
      };
      _v$ !== _p$.e && (_p$.e = _$setProp(_el$3, "style", _v$, _p$.e));
      _v$2 !== _p$.t && (_p$.t = _$setProp(_el$5, "style", _v$2, _p$.t));
      return _p$;
    }, {
      e: undefined,
      t: undefined
    });
    return _el$;
  })();
  return (() => {
    var _el$8 = _$createElement("box"), _el$9 = _$createElement("box"), _el$0 = _$createElement("text"), _el$1 = _$createElement("span"), _el$10 = _$createElement("span"), _el$12 = _$createElement("span"), _el$13 = _$createElement("text"), _el$14 = _$createElement("span"), _el$15 = _$createElement("box"), _el$16 = _$createElement("text"), _el$17 = _$createElement("span"), _el$19 = _$createElement("span"), _el$20 = _$createElement("box"), _el$21 = _$createElement("box"), _el$22 = _$createElement("box");
    _$insertNode(_el$8, _el$9);
    _$insertNode(_el$8, _el$15);
    _$insertNode(_el$8, _el$20);
    _$insertNode(_el$8, _el$21);
    _$setProp(_el$8, "flexDirection", "column");
    _$setProp(_el$8, "border", true);
    _$setProp(_el$8, "paddingLeft", 1);
    _$setProp(_el$8, "paddingRight", 1);
    _$setProp(_el$8, "paddingTop", 0);
    _$setProp(_el$8, "paddingBottom", 0);
    _$setProp(_el$8, "flexShrink", 0);
    _$insertNode(_el$9, _el$0);
    _$insertNode(_el$9, _el$13);
    _$setProp(_el$9, "flexDirection", "row");
    _$setProp(_el$9, "justifyContent", "space-between");
    _$setProp(_el$9, "alignItems", "center");
    _$setProp(_el$9, "height", 1);
    _$setProp(_el$9, "flexShrink", 0);
    _$insertNode(_el$0, _el$1);
    _$insertNode(_el$0, _el$10);
    _$insertNode(_el$0, _el$12);
    _$setProp(_el$0, "wrapMode", "none");
    _$insert(_el$1, () => m().goal.name);
    _$insertNode(_el$10, _$createTextNode(` / `));
    _$insert(_el$12, proj);
    _$insertNode(_el$13, _el$14);
    _$setProp(_el$13, "wrapMode", "none");
    _$insert(_el$14, () => badge().text);
    _$insertNode(_el$15, _el$16);
    _$setProp(_el$15, "flexDirection", "row");
    _$setProp(_el$15, "height", 1);
    _$setProp(_el$15, "flexShrink", 0);
    _$insertNode(_el$16, _el$17);
    _$insertNode(_el$16, _el$19);
    _$setProp(_el$16, "wrapMode", "none");
    _$insertNode(_el$17, _$createTextNode(`Now: `));
    _$insert(_el$19, () => m().activityLine ?? "Idle \u2014 between turns");
    _$setProp(_el$20, "flexDirection", "column");
    _$setProp(_el$20, "flexShrink", 0);
    _$insert(_el$20, (() => {
      var _c$ = _$memo(() => !!m().blocked);
      return () => _c$() ? (() => {
        var _el$23 = _$createElement("text"), _el$24 = _$createElement("span"), _el$26 = _$createElement("span"), _el$27 = _$createElement("span"), _el$28 = _$createTextNode(` \u2014 `);
        _$insertNode(_el$23, _el$24);
        _$insertNode(_el$23, _el$26);
        _$insertNode(_el$23, _el$27);
        _$setProp(_el$23, "wrapMode", "word");
        _$insertNode(_el$24, _$createTextNode(`Blocked: `));
        _$insert(_el$26, () => m().blocked.reason.replace(/\s+/g, " ").slice(0, 180));
        _$insertNode(_el$27, _el$28);
        _$insert(_el$27, () => m().blocked.needed.replace(/\s+/g, " ").slice(0, 90), null);
        _$effect((_p$) => {
          var _v$11 = {
            fg: PALETTE2.rose,
            bold: true
          }, _v$12 = {
            fg: PALETTE2.rose
          }, _v$13 = {
            fg: PALETTE2.muted
          };
          _v$11 !== _p$.e && (_p$.e = _$setProp(_el$24, "style", _v$11, _p$.e));
          _v$12 !== _p$.t && (_p$.t = _$setProp(_el$26, "style", _v$12, _p$.t));
          _v$13 !== _p$.a && (_p$.a = _$setProp(_el$27, "style", _v$13, _p$.a));
          return _p$;
        }, {
          e: undefined,
          t: undefined,
          a: undefined
        });
        return _el$23;
      })() : (() => {
        var _el$29 = _$createElement("text"), _el$30 = _$createElement("span");
        _$insertNode(_el$29, _el$30);
        _$setProp(_el$29, "wrapMode", "word");
        _$insert(_el$30, () => (m().lastResult ?? "No progress reported yet \u2014 steer with [s] Send or [Enter] Actions.").replace(/\s+/g, " ").slice(0, 200));
        _$effect((_$p) => _$setProp(_el$30, "style", {
          fg: PALETTE2.muted
        }, _$p));
        return _el$29;
      })();
    })());
    _$insertNode(_el$21, _el$22);
    _$setProp(_el$21, "flexDirection", "row");
    _$setProp(_el$21, "gap", 1);
    _$setProp(_el$21, "flexShrink", 0);
    _$setProp(_el$21, "alignItems", "center");
    _$insert(_el$21, () => btn("Send", "s", props.onSend, false, PALETTE2.sage), _el$22);
    _$insert(_el$21, () => btn("Open session", "o", props.onOpen, false, PALETTE2.sky), _el$22);
    _$use((el) => props.actionsAnchor?.(el), _el$22);
    _$setProp(_el$22, "position", "relative");
    _$insert(_el$22, () => btn("Actions", "Enter", props.onActions, false, PALETTE2.amber), null);
    _$insert(_el$22, () => props.actionsMenu, null);
    _$insert(_el$21, () => btn("Details", "d", props.onDetails, Boolean(m().detailsOpen), PALETTE2.violet), null);
    _$insert(_el$21, _$createComponent(Show, {
      get when() {
        return _$memo(() => !!m().showFocusProject)() && props.onFocusProject;
      },
      get children() {
        return btn("Focus project", "f", () => props.onFocusProject?.());
      }
    }), null);
    _$effect((_p$) => {
      var { rule: _v$3, inset: _v$4 } = PALETTE2, _v$5 = props.actionsOpen ? 10 : 0, _v$6 = {
        fg: PALETTE2.cyan,
        bold: true
      }, _v$7 = {
        fg: PALETTE2.muted
      }, _v$8 = {
        fg: PALETTE2.violet
      }, _v$9 = {
        fg: badge().fg,
        bold: true
      }, _v$0 = {
        fg: PALETTE2.muted
      }, _v$1 = {
        fg: m().acting ? PALETTE2.sage : PALETTE2.ink
      }, _v$10 = props.onActionsLayout;
      _v$3 !== _p$.e && (_p$.e = _$setProp(_el$8, "borderColor", _v$3, _p$.e));
      _v$4 !== _p$.t && (_p$.t = _$setProp(_el$8, "backgroundColor", _v$4, _p$.t));
      _v$5 !== _p$.a && (_p$.a = _$setProp(_el$8, "zIndex", _v$5, _p$.a));
      _v$6 !== _p$.o && (_p$.o = _$setProp(_el$1, "style", _v$6, _p$.o));
      _v$7 !== _p$.i && (_p$.i = _$setProp(_el$10, "style", _v$7, _p$.i));
      _v$8 !== _p$.n && (_p$.n = _$setProp(_el$12, "style", _v$8, _p$.n));
      _v$9 !== _p$.s && (_p$.s = _$setProp(_el$14, "style", _v$9, _p$.s));
      _v$0 !== _p$.h && (_p$.h = _$setProp(_el$17, "style", _v$0, _p$.h));
      _v$1 !== _p$.r && (_p$.r = _$setProp(_el$19, "style", _v$1, _p$.r));
      _v$10 !== _p$.d && (_p$.d = _$setProp(_el$22, "renderAfter", _v$10, _p$.d));
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
    return _el$8;
  })();
}
function GoalDetailsDrawer(props) {
  const PALETTE2 = paletteFor(props.theme);
  const m = () => props.model;
  const g = () => m().goal;
  const badge = () => stateBadge(g(), m().runtime);
  const proj = () => m().directory ? m().directory.split("/").pop() ?? m().directory : "";
  const maxTurns = () => g().config?.maxTurns;
  const turnsLabel = () => {
    const rt = m().runtime;
    return rt ? `${rt.budgetTurnCount}${maxTurns() ? `/${maxTurns()}` : ""} turns` : "0 turns";
  };
  const dtRow = (icon, dt, dd, labelColor, valueColor = PALETTE2.ink) => (() => {
    var _el$31 = _$createElement("box"), _el$32 = _$createElement("box"), _el$33 = _$createElement("text"), _el$34 = _$createElement("span"), _el$35 = _$createTextNode(` `), _el$36 = _$createElement("span"), _el$37 = _$createElement("box"), _el$38 = _$createElement("text"), _el$39 = _$createElement("span");
    _$insertNode(_el$31, _el$32);
    _$insertNode(_el$31, _el$37);
    _$setProp(_el$31, "flexDirection", "row");
    _$setProp(_el$31, "flexShrink", 0);
    _$setProp(_el$31, "paddingLeft", 1);
    _$setProp(_el$31, "paddingRight", 1);
    _$insertNode(_el$32, _el$33);
    _$setProp(_el$32, "width", 16);
    _$setProp(_el$32, "flexShrink", 0);
    _$insertNode(_el$33, _el$34);
    _$insertNode(_el$33, _el$36);
    _$setProp(_el$33, "wrapMode", "none");
    _$insertNode(_el$34, _el$35);
    _$setProp(_el$34, "style", {
      fg: labelColor,
      bold: true
    });
    _$insert(_el$34, icon, _el$35);
    _$setProp(_el$36, "style", {
      fg: labelColor
    });
    _$insert(_el$36, dt);
    _$insertNode(_el$37, _el$38);
    _$setProp(_el$37, "flexGrow", 1);
    _$setProp(_el$37, "flexShrink", 1);
    _$setProp(_el$37, "minWidth", 0);
    _$insertNode(_el$38, _el$39);
    _$setProp(_el$38, "wrapMode", "word");
    _$setProp(_el$39, "style", {
      fg: valueColor
    });
    _$insert(_el$39, dd);
    return _el$31;
  })();
  return (() => {
    var _el$40 = _$createElement("box"), _el$41 = _$createElement("box"), _el$42 = _$createElement("text"), _el$43 = _$createElement("span"), _el$44 = _$createTextNode(`Details / `), _el$48 = _$createElement("span"), _el$50 = _$createElement("span"), _el$51 = _$createElement("box"), _el$52 = _$createElement("text"), _el$53 = _$createElement("span"), _el$55 = _$createElement("box"), _el$56 = _$createElement("text"), _el$57 = _$createElement("span"), _el$59 = _$createElement("scrollbox"), _el$60 = _$createElement("box"), _el$61 = _$createElement("text"), _el$62 = _$createElement("span");
    _$insertNode(_el$40, _el$41);
    _$insertNode(_el$40, _el$55);
    _$insertNode(_el$40, _el$59);
    _$setProp(_el$40, "flexDirection", "column");
    _$setProp(_el$40, "border", true);
    _$setProp(_el$40, "paddingLeft", 2);
    _$setProp(_el$40, "paddingRight", 2);
    _$setProp(_el$40, "paddingTop", 1);
    _$setProp(_el$40, "paddingBottom", 1);
    _$setProp(_el$40, "gap", 1);
    _$setProp(_el$40, "flexShrink", 0);
    _$insertNode(_el$41, _el$42);
    _$insertNode(_el$41, _el$51);
    _$setProp(_el$41, "flexDirection", "row");
    _$setProp(_el$41, "justifyContent", "space-between");
    _$setProp(_el$41, "alignItems", "center");
    _$setProp(_el$41, "height", 1);
    _$setProp(_el$41, "flexShrink", 0);
    _$insertNode(_el$42, _el$43);
    _$insertNode(_el$42, _el$48);
    _$insertNode(_el$42, _el$50);
    _$setProp(_el$42, "wrapMode", "none");
    _$insertNode(_el$43, _el$44);
    _$insert(_el$43, () => g().name, null);
    _$insert(_el$42, _$createComponent(Show, {
      get when() {
        return proj();
      },
      get children() {
        var _el$45 = _$createElement("span"), _el$46 = _$createTextNode(` (`), _el$47 = _$createTextNode(`)`);
        _$insertNode(_el$45, _el$46);
        _$insertNode(_el$45, _el$47);
        _$insert(_el$45, proj, _el$47);
        _$effect((_$p) => _$setProp(_el$45, "style", {
          fg: PALETTE2.muted
        }, _$p));
        return _el$45;
      }
    }), _el$48);
    _$insertNode(_el$48, _$createTextNode(` \xB7 `));
    _$insert(_el$50, () => badge().text);
    _$insertNode(_el$51, _el$52);
    _$setProp(_el$51, "flexDirection", "row");
    _$setProp(_el$51, "paddingLeft", 1);
    _$setProp(_el$51, "paddingRight", 1);
    _$setProp(_el$51, "height", 1);
    _$spread(_el$51, _$mergeProps({
      get backgroundColor() {
        return PALETTE2.base;
      }
    }, {
      onMouseDown: () => props.onClose?.()
    }), true);
    _$insertNode(_el$52, _el$53);
    _$setProp(_el$52, "wrapMode", "none");
    _$insertNode(_el$53, _$createTextNode(`[esc]`));
    _$insertNode(_el$55, _el$56);
    _$setProp(_el$55, "flexDirection", "row");
    _$setProp(_el$55, "height", 1);
    _$setProp(_el$55, "flexShrink", 0);
    _$insertNode(_el$56, _el$57);
    _$setProp(_el$56, "wrapMode", "none");
    _$insertNode(_el$57, _$createTextNode(`j / k scrolls \xB7 PgUp / PgDn pages \xB7 n / p switches worker \xB7 d or Esc returns to table`));
    _$insertNode(_el$59, _el$60);
    _$use((el) => props.scrollRef?.(el), _el$59);
    _$setProp(_el$59, "height", 12);
    _$setProp(_el$59, "scrollX", false);
    _$setProp(_el$59, "scrollY", true);
    _$setProp(_el$59, "stickyScroll", false);
    _$insert(_el$59, () => dtRow("\u2756", "agent/model", `${m().agentLabel} \xB7 ${m().modelLabel}`, PALETTE2.sage, PALETTE2.amber), _el$60);
    _$insert(_el$59, () => dtRow("\u25C9", "budget/turns", `${formatCost(g().costUsed)} \xB7 ${turnsLabel()} \xB7 ${formatTokens(g().tokensUsed)} tok \xB7 ${formatDuration(g().timeUsedSeconds)}`, PALETTE2.amber, PALETTE2.sage), _el$60);
    _$insert(_el$59, () => dtRow("\u25CE", "objective", g().objective.replace(/\s+/g, " "), PALETTE2.cyan, PALETTE2.ink), _el$60);
    _$insert(_el$59, () => dtRow("\u2B23", "scope", (() => {
      const writeable = g().config.workspaceWrite !== false;
      const scope = g().config.write_scope;
      if (!writeable)
        return "(read-only)";
      if (scope === undefined)
        return "whole workspace (legacy exclusive)";
      if (scope.length === 0)
        return "exploration only";
      return scope.join(", ");
    })(), PALETTE2.violet, PALETTE2.violet), _el$60);
    _$insert(_el$59, () => dtRow("\u2713", "checks", (g().config.checks ?? []).join(" \xB7 ") || "No source changes", PALETTE2.sky, PALETTE2.sky), _el$60);
    _$insert(_el$59, () => dtRow("\u2699", "diagnostics", `goal: ${g().id} \xB7 worker: ${g().workerSessionID ?? "\u2014"} \xB7 owner: ${g().ownerSessionID ?? "\u2014"}`, PALETTE2.muted, PALETTE2.muted), _el$60);
    _$insertNode(_el$60, _el$61);
    _$setProp(_el$60, "flexDirection", "column");
    _$setProp(_el$60, "border", true);
    _$setProp(_el$60, "paddingLeft", 1);
    _$setProp(_el$60, "paddingRight", 1);
    _$setProp(_el$60, "flexShrink", 0);
    _$insertNode(_el$61, _el$62);
    _$setProp(_el$61, "wrapMode", "none");
    _$insertNode(_el$62, _$createTextNode(`Recent progress & events`));
    _$insert(_el$60, _$createComponent(For, {
      get each() {
        return m().progressHistory.slice(-4);
      },
      children: (p) => (() => {
        var _el$64 = _$createElement("text"), _el$65 = _$createElement("span"), _el$67 = _$createElement("span");
        _$insertNode(_el$64, _el$65);
        _$insertNode(_el$64, _el$67);
        _$setProp(_el$64, "wrapMode", "word");
        _$insertNode(_el$65, _$createTextNode(`\u2713 `));
        _$insert(_el$67, () => p.summary.replace(/\s+/g, " "));
        _$insert(_el$64, _$createComponent(Show, {
          get when() {
            return p.next;
          },
          get children() {
            var _el$68 = _$createElement("span"), _el$69 = _$createTextNode(` \u2192 `);
            _$insertNode(_el$68, _el$69);
            _$insert(_el$68, () => p.next.replace(/\s+/g, " "), null);
            _$effect((_$p) => _$setProp(_el$68, "style", {
              fg: PALETTE2.muted
            }, _$p));
            return _el$68;
          }
        }), null);
        _$effect((_p$) => {
          var _v$24 = {
            fg: PALETTE2.sage,
            bold: true
          }, _v$25 = {
            fg: PALETTE2.ink
          };
          _v$24 !== _p$.e && (_p$.e = _$setProp(_el$65, "style", _v$24, _p$.e));
          _v$25 !== _p$.t && (_p$.t = _$setProp(_el$67, "style", _v$25, _p$.t));
          return _p$;
        }, {
          e: undefined,
          t: undefined
        });
        return _el$64;
      })()
    }), null);
    _$insert(_el$60, _$createComponent(For, {
      get each() {
        return m().transcript.slice(-10);
      },
      get fallback() {
        return (() => {
          var _el$70 = _$createElement("text"), _el$71 = _$createElement("span");
          _$insertNode(_el$70, _el$71);
          _$insertNode(_el$71, _$createTextNode(`No recent events recorded yet.`));
          _$effect((_$p) => _$setProp(_el$71, "style", {
            fg: PALETTE2.muted
          }, _$p));
          return _el$70;
        })();
      },
      children: (line) => (() => {
        var _el$73 = _$createElement("text"), _el$74 = _$createElement("span");
        _$insertNode(_el$73, _el$74);
        _$setProp(_el$73, "wrapMode", "word");
        _$insert(_el$74, line);
        _$effect((_$p) => _$setProp(_el$74, "style", {
          fg: PALETTE2.muted
        }, _$p));
        return _el$73;
      })()
    }), null);
    _$effect((_p$) => {
      var { cyan: _v$14, inset: _v$15 } = PALETTE2, _v$16 = {
        fg: PALETTE2.cyan,
        bold: true
      }, _v$17 = {
        fg: PALETTE2.muted
      }, _v$18 = {
        fg: badge().fg,
        bold: true
      }, _v$19 = {
        fg: PALETTE2.amber,
        bold: true
      }, _v$20 = {
        fg: PALETTE2.muted
      }, { rule: _v$21, base: _v$22 } = PALETTE2, _v$23 = {
        fg: PALETTE2.cyan,
        bold: true
      };
      _v$14 !== _p$.e && (_p$.e = _$setProp(_el$40, "borderColor", _v$14, _p$.e));
      _v$15 !== _p$.t && (_p$.t = _$setProp(_el$40, "backgroundColor", _v$15, _p$.t));
      _v$16 !== _p$.a && (_p$.a = _$setProp(_el$43, "style", _v$16, _p$.a));
      _v$17 !== _p$.o && (_p$.o = _$setProp(_el$48, "style", _v$17, _p$.o));
      _v$18 !== _p$.i && (_p$.i = _$setProp(_el$50, "style", _v$18, _p$.i));
      _v$19 !== _p$.n && (_p$.n = _$setProp(_el$53, "style", _v$19, _p$.n));
      _v$20 !== _p$.s && (_p$.s = _$setProp(_el$57, "style", _v$20, _p$.s));
      _v$21 !== _p$.h && (_p$.h = _$setProp(_el$60, "borderColor", _v$21, _p$.h));
      _v$22 !== _p$.r && (_p$.r = _$setProp(_el$60, "backgroundColor", _v$22, _p$.r));
      _v$23 !== _p$.d && (_p$.d = _$setProp(_el$62, "style", _v$23, _p$.d));
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
    return _el$40;
  })();
}

// src/tui/coordination-panel.tsx
import { createComponent as _$createComponent2 } from "@opentui/solid";
import { use as _$use2 } from "@opentui/solid";
import { effect as _$effect2 } from "@opentui/solid";
import { insert as _$insert2 } from "@opentui/solid";
import { createTextNode as _$createTextNode2 } from "@opentui/solid";
import { insertNode as _$insertNode2 } from "@opentui/solid";
import { setProp as _$setProp2 } from "@opentui/solid";
import { spread as _$spread2 } from "@opentui/solid";
import { mergeProps as _$mergeProps2 } from "@opentui/solid";
import { memo as _$memo2 } from "@opentui/solid";
import { createElement as _$createElement2 } from "@opentui/solid";
import { For as For2, Show as Show2 } from "solid-js";
function CoordinationPanel(props) {
  const PALETTE = paletteFor(props.theme);
  const m = () => props.model;
  const tabBtn = (id, keyHint, label) => {
    const active = () => props.tab === id;
    return (() => {
      var _el$ = _$createElement2("box"), _el$2 = _$createElement2("text"), _el$3 = _$createElement2("span"), _el$4 = _$createTextNode2(`[`), _el$5 = _$createTextNode2(`] `), _el$6 = _$createElement2("span");
      _$insertNode2(_el$, _el$2);
      _$setProp2(_el$, "flexDirection", "row");
      _$setProp2(_el$, "border", true);
      _$setProp2(_el$, "paddingLeft", 1);
      _$setProp2(_el$, "paddingRight", 1);
      _$spread2(_el$, _$mergeProps2({
        get backgroundColor() {
          return _$memo2(() => !!active())() ? PALETTE.cyan : PALETTE.base;
        },
        get borderColor() {
          return _$memo2(() => !!active())() ? PALETTE.cyan : PALETTE.rule;
        }
      }, {
        onMouseDown: () => props.onTab(id)
      }), true);
      _$insertNode2(_el$2, _el$3);
      _$insertNode2(_el$2, _el$6);
      _$setProp2(_el$2, "wrapMode", "none");
      _$insertNode2(_el$3, _el$4);
      _$insertNode2(_el$3, _el$5);
      _$insert2(_el$3, keyHint, _el$5);
      _$insert2(_el$6, label);
      _$effect2((_p$) => {
        var _v$ = {
          fg: active() ? PALETTE.tabActiveFg : PALETTE.muted
        }, _v$2 = {
          fg: active() ? PALETTE.tabActiveFg : PALETTE.ink,
          bold: active()
        };
        _v$ !== _p$.e && (_p$.e = _$setProp2(_el$3, "style", _v$, _p$.e));
        _v$2 !== _p$.t && (_p$.t = _$setProp2(_el$6, "style", _v$2, _p$.t));
        return _p$;
      }, {
        e: undefined,
        t: undefined
      });
      return _el$;
    })();
  };
  return (() => {
    var _el$7 = _$createElement2("box"), _el$8 = _$createElement2("box"), _el$9 = _$createElement2("text"), _el$0 = _$createElement2("span"), _el$10 = _$createElement2("span"), _el$12 = _$createElement2("span"), _el$13 = _$createElement2("box"), _el$14 = _$createElement2("text"), _el$15 = _$createElement2("span"), _el$17 = _$createElement2("box"), _el$18 = _$createElement2("text"), _el$19 = _$createElement2("span"), _el$20 = _$createTextNode2(` \xB7 j / k scrolls \xB7 Tab / Shift+Tab switches tab \xB7 w / v / r selects \xB7 Esc closes`), _el$21 = _$createElement2("box"), _el$22 = _$createElement2("scrollbox"), _el$36 = _$createElement2("box"), _el$37 = _$createElement2("text"), _el$38 = _$createElement2("span");
    _$insertNode2(_el$7, _el$8);
    _$insertNode2(_el$7, _el$17);
    _$insertNode2(_el$7, _el$21);
    _$insertNode2(_el$7, _el$22);
    _$insertNode2(_el$7, _el$36);
    _$setProp2(_el$7, "flexDirection", "column");
    _$setProp2(_el$7, "border", true);
    _$setProp2(_el$7, "paddingLeft", 2);
    _$setProp2(_el$7, "paddingRight", 2);
    _$setProp2(_el$7, "paddingTop", 1);
    _$setProp2(_el$7, "paddingBottom", 1);
    _$setProp2(_el$7, "gap", 1);
    _$setProp2(_el$7, "flexShrink", 0);
    _$insertNode2(_el$8, _el$9);
    _$insertNode2(_el$8, _el$13);
    _$setProp2(_el$8, "flexDirection", "row");
    _$setProp2(_el$8, "justifyContent", "space-between");
    _$setProp2(_el$8, "alignItems", "center");
    _$setProp2(_el$8, "height", 1);
    _$setProp2(_el$8, "flexShrink", 0);
    _$insertNode2(_el$9, _el$0);
    _$insertNode2(_el$9, _el$10);
    _$insertNode2(_el$9, _el$12);
    _$setProp2(_el$9, "wrapMode", "none");
    _$insertNode2(_el$0, _$createTextNode2(`Coordination`));
    _$insertNode2(_el$10, _$createTextNode2(` / `));
    _$insert2(_el$12, () => m().shortName);
    _$insertNode2(_el$13, _el$14);
    _$setProp2(_el$13, "flexDirection", "row");
    _$setProp2(_el$13, "paddingLeft", 1);
    _$setProp2(_el$13, "paddingRight", 1);
    _$setProp2(_el$13, "height", 1);
    _$spread2(_el$13, _$mergeProps2({
      get backgroundColor() {
        return PALETTE.base;
      }
    }, {
      onMouseDown: () => props.onClose?.()
    }), true);
    _$insertNode2(_el$14, _el$15);
    _$setProp2(_el$14, "wrapMode", "none");
    _$insertNode2(_el$15, _$createTextNode2(`[esc]`));
    _$insertNode2(_el$17, _el$18);
    _$setProp2(_el$17, "flexDirection", "row");
    _$setProp2(_el$17, "height", 1);
    _$setProp2(_el$17, "flexShrink", 0);
    _$insertNode2(_el$18, _el$19);
    _$setProp2(_el$18, "wrapMode", "none");
    _$insertNode2(_el$19, _el$20);
    _$insert2(_el$19, () => m().directory, _el$20);
    _$setProp2(_el$21, "flexDirection", "row");
    _$setProp2(_el$21, "gap", 1);
    _$setProp2(_el$21, "flexShrink", 0);
    _$setProp2(_el$21, "alignItems", "center");
    _$insert2(_el$21, () => tabBtn("writes", "w", `Writes (${m().holds.length})`), null);
    _$insert2(_el$21, () => tabBtn("verify", "v", `Verification (${m().verifyBlockers.length})`), null);
    _$insert2(_el$21, () => tabBtn("resv", "r", `Reservations (${m().reservations.length})`), null);
    _$use2((el) => props.scrollRef?.(el), _el$22);
    _$setProp2(_el$22, "height", 10);
    _$setProp2(_el$22, "scrollX", false);
    _$setProp2(_el$22, "scrollY", true);
    _$setProp2(_el$22, "stickyScroll", false);
    _$insert2(_el$22, _$createComponent2(Show2, {
      get when() {
        return props.tab === "writes";
      },
      get children() {
        var _el$23 = _$createElement2("box"), _el$24 = _$createElement2("text"), _el$25 = _$createElement2("span"), _el$27 = _$createElement2("text"), _el$28 = _$createElement2("span");
        _$insertNode2(_el$23, _el$24);
        _$insertNode2(_el$23, _el$27);
        _$setProp2(_el$23, "flexDirection", "column");
        _$setProp2(_el$23, "flexShrink", 0);
        _$setProp2(_el$23, "gap", 1);
        _$insertNode2(_el$24, _el$25);
        _$setProp2(_el$24, "wrapMode", "none");
        _$insertNode2(_el$25, _$createTextNode2(`Current write tickets`));
        _$insert2(_el$23, _$createComponent2(For2, {
          get each() {
            return m().holds;
          },
          get fallback() {
            return (() => {
              var _el$40 = _$createElement2("box"), _el$41 = _$createElement2("text"), _el$42 = _$createElement2("span");
              _$insertNode2(_el$40, _el$41);
              _$setProp2(_el$40, "border", true);
              _$setProp2(_el$40, "paddingLeft", 1);
              _$setProp2(_el$40, "paddingRight", 1);
              _$insertNode2(_el$41, _el$42);
              _$setProp2(_el$41, "wrapMode", "none");
              _$insertNode2(_el$42, _$createTextNode2(`No active writes in this project.`));
              _$effect2((_p$) => {
                var { rule: _v$11, base: _v$12 } = PALETTE, _v$13 = {
                  fg: PALETTE.muted
                };
                _v$11 !== _p$.e && (_p$.e = _$setProp2(_el$40, "borderColor", _v$11, _p$.e));
                _v$12 !== _p$.t && (_p$.t = _$setProp2(_el$40, "backgroundColor", _v$12, _p$.t));
                _v$13 !== _p$.a && (_p$.a = _$setProp2(_el$42, "style", _v$13, _p$.a));
                return _p$;
              }, {
                e: undefined,
                t: undefined,
                a: undefined
              });
              return _el$40;
            })();
          },
          children: (h) => (() => {
            var _el$44 = _$createElement2("box"), _el$45 = _$createElement2("text"), _el$46 = _$createElement2("span"), _el$48 = _$createElement2("span"), _el$49 = _$createElement2("text"), _el$50 = _$createElement2("span"), _el$52 = _$createElement2("span"), _el$53 = _$createElement2("span"), _el$54 = _$createTextNode2(` \xB7 session `), _el$55 = _$createTextNode2(` \xB7 held `);
            _$insertNode2(_el$44, _el$45);
            _$insertNode2(_el$44, _el$49);
            _$setProp2(_el$44, "flexDirection", "column");
            _$setProp2(_el$44, "border", true);
            _$setProp2(_el$44, "paddingLeft", 1);
            _$setProp2(_el$44, "paddingRight", 1);
            _$insertNode2(_el$45, _el$46);
            _$insertNode2(_el$45, _el$48);
            _$setProp2(_el$45, "wrapMode", "word");
            _$insertNode2(_el$46, _$createTextNode2(`\u25CF Writing `));
            _$insert2(_el$48, () => h.files.join(", "));
            _$insertNode2(_el$49, _el$50);
            _$insertNode2(_el$49, _el$52);
            _$insertNode2(_el$49, _el$53);
            _$setProp2(_el$49, "wrapMode", "none");
            _$insertNode2(_el$50, _$createTextNode2(`Holder: `));
            _$insert2(_el$52, () => h.goalName);
            _$insertNode2(_el$53, _el$54);
            _$insertNode2(_el$53, _el$55);
            _$insert2(_el$53, () => h.sessionID.slice(0, 14), _el$55);
            _$insert2(_el$53, () => h.age, null);
            _$effect2((_p$) => {
              var { rule: _v$14, base: _v$15 } = PALETTE, _v$16 = {
                fg: PALETTE.sage,
                bold: true
              }, _v$17 = {
                fg: PALETTE.ink,
                bold: true
              }, _v$18 = {
                fg: PALETTE.muted
              }, _v$19 = {
                fg: PALETTE.cyan
              }, _v$20 = {
                fg: PALETTE.muted
              };
              _v$14 !== _p$.e && (_p$.e = _$setProp2(_el$44, "borderColor", _v$14, _p$.e));
              _v$15 !== _p$.t && (_p$.t = _$setProp2(_el$44, "backgroundColor", _v$15, _p$.t));
              _v$16 !== _p$.a && (_p$.a = _$setProp2(_el$46, "style", _v$16, _p$.a));
              _v$17 !== _p$.o && (_p$.o = _$setProp2(_el$48, "style", _v$17, _p$.o));
              _v$18 !== _p$.i && (_p$.i = _$setProp2(_el$50, "style", _v$18, _p$.i));
              _v$19 !== _p$.n && (_p$.n = _$setProp2(_el$52, "style", _v$19, _p$.n));
              _v$20 !== _p$.s && (_p$.s = _$setProp2(_el$53, "style", _v$20, _p$.s));
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
            return _el$44;
          })()
        }), _el$27);
        _$insertNode2(_el$27, _el$28);
        _$setProp2(_el$27, "wrapMode", "none");
        _$insertNode2(_el$28, _$createTextNode2(`Queued write requests (scope claims are NOT a queue)`));
        _$insert2(_el$23, _$createComponent2(For2, {
          get each() {
            return m().queue;
          },
          get fallback() {
            return (() => {
              var _el$56 = _$createElement2("box"), _el$57 = _$createElement2("text"), _el$58 = _$createElement2("span");
              _$insertNode2(_el$56, _el$57);
              _$setProp2(_el$56, "border", true);
              _$setProp2(_el$56, "paddingLeft", 1);
              _$setProp2(_el$56, "paddingRight", 1);
              _$insertNode2(_el$57, _el$58);
              _$setProp2(_el$57, "wrapMode", "none");
              _$insertNode2(_el$58, _$createTextNode2(`No queued write requests.`));
              _$effect2((_p$) => {
                var { rule: _v$21, base: _v$22 } = PALETTE, _v$23 = {
                  fg: PALETTE.muted
                };
                _v$21 !== _p$.e && (_p$.e = _$setProp2(_el$56, "borderColor", _v$21, _p$.e));
                _v$22 !== _p$.t && (_p$.t = _$setProp2(_el$56, "backgroundColor", _v$22, _p$.t));
                _v$23 !== _p$.a && (_p$.a = _$setProp2(_el$58, "style", _v$23, _p$.a));
                return _p$;
              }, {
                e: undefined,
                t: undefined,
                a: undefined
              });
              return _el$56;
            })();
          },
          children: (q) => (() => {
            var _el$60 = _$createElement2("box"), _el$61 = _$createElement2("text"), _el$62 = _$createElement2("span"), _el$63 = _$createTextNode2(`#`), _el$64 = _$createTextNode2(` `), _el$65 = _$createElement2("span"), _el$68 = _$createElement2("text"), _el$69 = _$createElement2("span"), _el$70 = _$createElement2("text"), _el$71 = _$createElement2("span"), _el$72 = _$createTextNode2(`Waits for `), _el$73 = _$createTextNode2(` to finish its write ticket.`);
            _$insertNode2(_el$60, _el$61);
            _$insertNode2(_el$60, _el$68);
            _$insertNode2(_el$60, _el$70);
            _$setProp2(_el$60, "flexDirection", "column");
            _$setProp2(_el$60, "border", true);
            _$setProp2(_el$60, "paddingLeft", 1);
            _$setProp2(_el$60, "paddingRight", 1);
            _$insertNode2(_el$61, _el$62);
            _$insertNode2(_el$61, _el$65);
            _$setProp2(_el$61, "wrapMode", "word");
            _$insertNode2(_el$62, _el$63);
            _$insertNode2(_el$62, _el$64);
            _$insert2(_el$62, () => q.position, _el$64);
            _$insert2(_el$65, () => q.goalName);
            _$insert2(_el$61, _$createComponent2(Show2, {
              get when() {
                return q.ownerPriority;
              },
              get children() {
                var _el$66 = _$createElement2("span");
                _$insertNode2(_el$66, _$createTextNode2(` \u2605owner priority`));
                _$effect2((_$p) => _$setProp2(_el$66, "style", {
                  fg: PALETTE.cyan
                }, _$p));
                return _el$66;
              }
            }), null);
            _$insertNode2(_el$68, _el$69);
            _$setProp2(_el$68, "wrapMode", "word");
            _$insert2(_el$69, () => q.files.join(", "));
            _$insertNode2(_el$70, _el$71);
            _$setProp2(_el$70, "wrapMode", "word");
            _$insertNode2(_el$71, _el$72);
            _$insertNode2(_el$71, _el$73);
            _$insert2(_el$71, () => q.waitsFor, _el$73);
            _$effect2((_p$) => {
              var { rule: _v$24, base: _v$25 } = PALETTE, _v$26 = {
                fg: PALETTE.amber,
                bold: true
              }, _v$27 = {
                fg: PALETTE.ink,
                bold: true
              }, _v$28 = {
                fg: PALETTE.ink
              }, _v$29 = {
                fg: PALETTE.muted
              };
              _v$24 !== _p$.e && (_p$.e = _$setProp2(_el$60, "borderColor", _v$24, _p$.e));
              _v$25 !== _p$.t && (_p$.t = _$setProp2(_el$60, "backgroundColor", _v$25, _p$.t));
              _v$26 !== _p$.a && (_p$.a = _$setProp2(_el$62, "style", _v$26, _p$.a));
              _v$27 !== _p$.o && (_p$.o = _$setProp2(_el$65, "style", _v$27, _p$.o));
              _v$28 !== _p$.i && (_p$.i = _$setProp2(_el$69, "style", _v$28, _p$.i));
              _v$29 !== _p$.n && (_p$.n = _$setProp2(_el$71, "style", _v$29, _p$.n));
              return _p$;
            }, {
              e: undefined,
              t: undefined,
              a: undefined,
              o: undefined,
              i: undefined,
              n: undefined
            });
            return _el$60;
          })()
        }), null);
        _$effect2((_p$) => {
          var _v$3 = {
            fg: PALETTE.cyan
          }, _v$4 = {
            fg: PALETTE.cyan
          };
          _v$3 !== _p$.e && (_p$.e = _$setProp2(_el$25, "style", _v$3, _p$.e));
          _v$4 !== _p$.t && (_p$.t = _$setProp2(_el$28, "style", _v$4, _p$.t));
          return _p$;
        }, {
          e: undefined,
          t: undefined
        });
        return _el$23;
      }
    }), null);
    _$insert2(_el$22, _$createComponent2(Show2, {
      get when() {
        return props.tab === "verify";
      },
      get children() {
        var _el$30 = _$createElement2("box"), _el$31 = _$createElement2("box"), _el$32 = _$createElement2("text"), _el$33 = _$createElement2("span");
        _$insertNode2(_el$30, _el$31);
        _$setProp2(_el$30, "flexDirection", "column");
        _$setProp2(_el$30, "flexShrink", 0);
        _$setProp2(_el$30, "gap", 1);
        _$insert2(_el$30, _$createComponent2(For2, {
          get each() {
            return m().verifyBlockers;
          },
          get fallback() {
            return (() => {
              var _el$74 = _$createElement2("box"), _el$75 = _$createElement2("text"), _el$76 = _$createElement2("span");
              _$insertNode2(_el$74, _el$75);
              _$setProp2(_el$74, "border", true);
              _$setProp2(_el$74, "paddingLeft", 1);
              _$setProp2(_el$74, "paddingRight", 1);
              _$insertNode2(_el$75, _el$76);
              _$setProp2(_el$75, "wrapMode", "none");
              _$insertNode2(_el$76, _$createTextNode2(`\u25CF Workspace quiet \u2014 host checks can run immediately.`));
              _$effect2((_p$) => {
                var { rule: _v$30, base: _v$31 } = PALETTE, _v$32 = {
                  fg: PALETTE.sage
                };
                _v$30 !== _p$.e && (_p$.e = _$setProp2(_el$74, "borderColor", _v$30, _p$.e));
                _v$31 !== _p$.t && (_p$.t = _$setProp2(_el$74, "backgroundColor", _v$31, _p$.t));
                _v$32 !== _p$.a && (_p$.a = _$setProp2(_el$76, "style", _v$32, _p$.a));
                return _p$;
              }, {
                e: undefined,
                t: undefined,
                a: undefined
              });
              return _el$74;
            })();
          },
          children: (b) => (() => {
            var _el$78 = _$createElement2("box"), _el$79 = _$createElement2("text"), _el$80 = _$createElement2("span"), _el$82 = _$createElement2("span"), _el$83 = _$createElement2("text"), _el$84 = _$createElement2("span"), _el$85 = _$createTextNode2(` \u2014 checks resume after the workspace is quiet.`);
            _$insertNode2(_el$78, _el$79);
            _$insertNode2(_el$78, _el$83);
            _$setProp2(_el$78, "flexDirection", "column");
            _$setProp2(_el$78, "border", true);
            _$setProp2(_el$78, "paddingLeft", 1);
            _$setProp2(_el$78, "paddingRight", 1);
            _$insertNode2(_el$79, _el$80);
            _$insertNode2(_el$79, _el$82);
            _$setProp2(_el$79, "wrapMode", "word");
            _$insertNode2(_el$80, _$createTextNode2(`\u25CF Host checks waiting: `));
            _$insert2(_el$82, () => b.text);
            _$insertNode2(_el$83, _el$84);
            _$setProp2(_el$83, "wrapMode", "word");
            _$insertNode2(_el$84, _el$85);
            _$insert2(_el$84, () => b.holder ?? "unknown holder", _el$85);
            _$insert2(_el$84, (() => {
              var _c$ = _$memo2(() => !!b.age);
              return () => _c$() ? ` \xB7 ${b.age}` : "";
            })(), _el$85);
            _$effect2((_p$) => {
              var { rule: _v$33, base: _v$34 } = PALETTE, _v$35 = {
                fg: PALETTE.amber,
                bold: true
              }, _v$36 = {
                fg: PALETTE.ink
              }, _v$37 = {
                fg: PALETTE.muted
              };
              _v$33 !== _p$.e && (_p$.e = _$setProp2(_el$78, "borderColor", _v$33, _p$.e));
              _v$34 !== _p$.t && (_p$.t = _$setProp2(_el$78, "backgroundColor", _v$34, _p$.t));
              _v$35 !== _p$.a && (_p$.a = _$setProp2(_el$80, "style", _v$35, _p$.a));
              _v$36 !== _p$.o && (_p$.o = _$setProp2(_el$82, "style", _v$36, _p$.o));
              _v$37 !== _p$.i && (_p$.i = _$setProp2(_el$84, "style", _v$37, _p$.i));
              return _p$;
            }, {
              e: undefined,
              t: undefined,
              a: undefined,
              o: undefined,
              i: undefined
            });
            return _el$78;
          })()
        }), _el$31);
        _$insertNode2(_el$31, _el$32);
        _$setProp2(_el$31, "flexDirection", "row");
        _$setProp2(_el$31, "border", true);
        _$setProp2(_el$31, "paddingLeft", 1);
        _$setProp2(_el$31, "paddingRight", 1);
        _$spread2(_el$31, _$mergeProps2({
          get borderColor() {
            return PALETTE.rule;
          },
          get backgroundColor() {
            return PALETTE.base;
          }
        }, {
          onMouseDown: () => props.onTab("resv")
        }), true);
        _$insertNode2(_el$32, _el$33);
        _$setProp2(_el$32, "wrapMode", "none");
        _$insertNode2(_el$33, _$createTextNode2(`[r] Inspect reservations \u2192`));
        _$effect2((_$p) => _$setProp2(_el$33, "style", {
          fg: PALETTE.cyan
        }, _$p));
        return _el$30;
      }
    }), null);
    _$insert2(_el$22, _$createComponent2(Show2, {
      get when() {
        return props.tab === "resv";
      },
      get children() {
        var _el$35 = _$createElement2("box");
        _$setProp2(_el$35, "flexDirection", "column");
        _$setProp2(_el$35, "flexShrink", 0);
        _$setProp2(_el$35, "gap", 1);
        _$insert2(_el$35, _$createComponent2(For2, {
          get each() {
            return m().reservations;
          },
          get fallback() {
            return (() => {
              var _el$86 = _$createElement2("box"), _el$87 = _$createElement2("text"), _el$88 = _$createElement2("span");
              _$insertNode2(_el$86, _el$87);
              _$setProp2(_el$86, "border", true);
              _$setProp2(_el$86, "paddingLeft", 1);
              _$setProp2(_el$86, "paddingRight", 1);
              _$insertNode2(_el$87, _el$88);
              _$setProp2(_el$87, "wrapMode", "none");
              _$insertNode2(_el$88, _$createTextNode2(`No active or stale reservations in this project.`));
              _$effect2((_p$) => {
                var { rule: _v$38, base: _v$39 } = PALETTE, _v$40 = {
                  fg: PALETTE.muted
                };
                _v$38 !== _p$.e && (_p$.e = _$setProp2(_el$86, "borderColor", _v$38, _p$.e));
                _v$39 !== _p$.t && (_p$.t = _$setProp2(_el$86, "backgroundColor", _v$39, _p$.t));
                _v$40 !== _p$.a && (_p$.a = _$setProp2(_el$88, "style", _v$40, _p$.a));
                return _p$;
              }, {
                e: undefined,
                t: undefined,
                a: undefined
              });
              return _el$86;
            })();
          },
          children: (r) => (() => {
            var _el$90 = _$createElement2("box"), _el$91 = _$createElement2("text"), _el$92 = _$createElement2("span"), _el$93 = _$createElement2("span"), _el$94 = _$createElement2("text"), _el$95 = _$createElement2("span"), _el$96 = _$createElement2("span"), _el$97 = _$createTextNode2(` \xB7 session `), _el$98 = _$createTextNode2(` \xB7 `), _el$99 = _$createElement2("text"), _el$100 = _$createElement2("span"), _el$101 = _$createElement2("box"), _el$102 = _$createElement2("box"), _el$103 = _$createElement2("text"), _el$104 = _$createElement2("span");
            _$insertNode2(_el$90, _el$91);
            _$insertNode2(_el$90, _el$94);
            _$insertNode2(_el$90, _el$99);
            _$insertNode2(_el$90, _el$101);
            _$setProp2(_el$90, "flexDirection", "column");
            _$setProp2(_el$90, "border", true);
            _$setProp2(_el$90, "paddingLeft", 1);
            _$setProp2(_el$90, "paddingRight", 1);
            _$insertNode2(_el$91, _el$92);
            _$insertNode2(_el$91, _el$93);
            _$setProp2(_el$91, "wrapMode", "word");
            _$insert2(_el$92, () => r.live ? "\u25CF Live / tracked reservation " : "! Ended reservation ");
            _$insert2(_el$93, () => r.callID.slice(0, 18));
            _$insertNode2(_el$94, _el$95);
            _$insertNode2(_el$94, _el$96);
            _$setProp2(_el$94, "wrapMode", "word");
            _$insert2(_el$95, () => r.goalName);
            _$insertNode2(_el$96, _el$97);
            _$insertNode2(_el$96, _el$98);
            _$insert2(_el$96, () => r.sessionID.slice(0, 14), _el$98);
            _$insert2(_el$96, () => r.age, null);
            _$insertNode2(_el$99, _el$100);
            _$setProp2(_el$99, "wrapMode", "word");
            _$insert2(_el$100, () => r.reason);
            _$insertNode2(_el$101, _el$102);
            _$setProp2(_el$101, "flexDirection", "row");
            _$setProp2(_el$101, "gap", 1);
            _$insertNode2(_el$102, _el$103);
            _$setProp2(_el$102, "flexDirection", "row");
            _$setProp2(_el$102, "border", true);
            _$setProp2(_el$102, "paddingLeft", 1);
            _$setProp2(_el$102, "paddingRight", 1);
            _$spread2(_el$102, _$mergeProps2({
              get borderColor() {
                return PALETTE.cyan;
              },
              get backgroundColor() {
                return PALETTE.inset;
              }
            }, {
              onMouseDown: () => props.onRelease(r.callID)
            }), true);
            _$insertNode2(_el$103, _el$104);
            _$setProp2(_el$103, "wrapMode", "none");
            _$insertNode2(_el$104, _$createTextNode2(`Release reservation\u2026 [W]`));
            _$effect2((_p$) => {
              var { rule: _v$41, base: _v$42 } = PALETTE, _v$43 = {
                fg: r.live ? PALETTE.sage : PALETTE.rose,
                bold: true
              }, _v$44 = {
                fg: PALETTE.ink,
                bold: true
              }, _v$45 = {
                fg: PALETTE.violet
              }, _v$46 = {
                fg: PALETTE.muted
              }, _v$47 = {
                fg: PALETTE.muted
              }, _v$48 = {
                fg: PALETTE.cyan
              };
              _v$41 !== _p$.e && (_p$.e = _$setProp2(_el$90, "borderColor", _v$41, _p$.e));
              _v$42 !== _p$.t && (_p$.t = _$setProp2(_el$90, "backgroundColor", _v$42, _p$.t));
              _v$43 !== _p$.a && (_p$.a = _$setProp2(_el$92, "style", _v$43, _p$.a));
              _v$44 !== _p$.o && (_p$.o = _$setProp2(_el$93, "style", _v$44, _p$.o));
              _v$45 !== _p$.i && (_p$.i = _$setProp2(_el$95, "style", _v$45, _p$.i));
              _v$46 !== _p$.n && (_p$.n = _$setProp2(_el$96, "style", _v$46, _p$.n));
              _v$47 !== _p$.s && (_p$.s = _$setProp2(_el$100, "style", _v$47, _p$.s));
              _v$48 !== _p$.h && (_p$.h = _$setProp2(_el$104, "style", _v$48, _p$.h));
              return _p$;
            }, {
              e: undefined,
              t: undefined,
              a: undefined,
              o: undefined,
              i: undefined,
              n: undefined,
              s: undefined,
              h: undefined
            });
            return _el$90;
          })()
        }));
        return _el$35;
      }
    }), null);
    _$insertNode2(_el$36, _el$37);
    _$setProp2(_el$36, "flexDirection", "row");
    _$setProp2(_el$36, "height", 1);
    _$setProp2(_el$36, "flexShrink", 0);
    _$insertNode2(_el$37, _el$38);
    _$setProp2(_el$37, "wrapMode", "none");
    _$insertNode2(_el$38, _$createTextNode2(`Scope = permission \xB7 Ticket = current write \xB7 Verification waits for quiet \xB7 [W] release \xB7 [Esc] close`));
    _$effect2((_p$) => {
      var { cyan: _v$5, inset: _v$6 } = PALETTE, _v$7 = {
        fg: PALETTE.cyan,
        bold: true
      }, _v$8 = {
        fg: PALETTE.muted
      }, _v$9 = {
        fg: PALETTE.violet,
        bold: true
      }, _v$0 = {
        fg: PALETTE.amber,
        bold: true
      }, _v$1 = {
        fg: PALETTE.muted
      }, _v$10 = {
        fg: PALETTE.muted
      };
      _v$5 !== _p$.e && (_p$.e = _$setProp2(_el$7, "borderColor", _v$5, _p$.e));
      _v$6 !== _p$.t && (_p$.t = _$setProp2(_el$7, "backgroundColor", _v$6, _p$.t));
      _v$7 !== _p$.a && (_p$.a = _$setProp2(_el$0, "style", _v$7, _p$.a));
      _v$8 !== _p$.o && (_p$.o = _$setProp2(_el$10, "style", _v$8, _p$.o));
      _v$9 !== _p$.i && (_p$.i = _$setProp2(_el$12, "style", _v$9, _p$.i));
      _v$0 !== _p$.n && (_p$.n = _$setProp2(_el$15, "style", _v$0, _p$.n));
      _v$1 !== _p$.s && (_p$.s = _$setProp2(_el$19, "style", _v$1, _p$.s));
      _v$10 !== _p$.h && (_p$.h = _$setProp2(_el$38, "style", _v$10, _p$.h));
      return _p$;
    }, {
      e: undefined,
      t: undefined,
      a: undefined,
      o: undefined,
      i: undefined,
      n: undefined,
      s: undefined,
      h: undefined
    });
    return _el$7;
  })();
}

// src/tui/dashboard.tsx
var activeSubPopupDismiss;
var activeProjectPickerOpen;
var lastDashboardState;
function isDashboardProjectPickerOpen() {
  return activeProjectPickerOpen?.() === true;
}
function tryDismissDashboardSubPopup() {
  try {
    return activeSubPopupDismiss?.() === true;
  } catch {
    return false;
  }
}
function getSavedDashboardState() {
  return lastDashboardState;
}
function prevent(evt) {
  const e = evt;
  try {
    e.defaultPrevented = true;
  } catch {}
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
function normalizeInitialView(view) {
  if (view === "goals")
    return "project";
  return view ?? "project";
}
function commandStatusColor(status) {
  switch (status) {
    case "running":
      return PALETTE.cyan;
    case "exited":
      return PALETTE.muted;
    case "terminated":
      return PALETTE.amber;
    case "missing":
      return PALETTE.rose;
    default:
      return PALETTE.ink;
  }
}
function commandStatusIcon(status) {
  switch (status) {
    case "running":
      return "\u25CF";
    case "exited":
      return "\u2713";
    case "terminated":
      return "\u25A0";
    case "missing":
      return "!";
    default:
      return "\u25CB";
  }
}
function commandStatusLabel(status) {
  switch (status) {
    case "running":
      return {
        short: "running",
        hint: "process is executing"
      };
    case "exited":
      return {
        short: "exited",
        hint: "process ended on its own"
      };
    case "terminated":
      return {
        short: "terminated",
        hint: "stopped via interrupt/terminate"
      };
    case "missing":
      return {
        short: "missing",
        hint: "no live execution found"
      };
    default:
      return {
        short: String(status),
        hint: ""
      };
  }
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
    props.maxRows;
    followPending = true;
    scroll?.requestRender();
  });
  const rows = () => Math.max(1, Math.min(props.count, props.maxRows ?? 6));
  return (() => {
    var _el$ = _$createElement3("scrollbox");
    _$use3((el) => {
      scroll = el;
    }, _el$);
    _$setProp3(_el$, "scrollX", false);
    _$setProp3(_el$, "scrollY", true);
    _$setProp3(_el$, "stickyScroll", false);
    _$setProp3(_el$, "renderAfter", () => {
      if (!followPending || !scroll)
        return;
      followPending = false;
      if (props.selectedID)
        scroll.scrollChildIntoView(props.selectedID);
    });
    _$insert3(_el$, () => props.children);
    _$effect3((_$p) => _$setProp3(_el$, "height", rows(), _$p));
    return _el$;
  })();
}
function DashboardRow(props) {
  let text;
  return (() => {
    var _el$2 = _$createElement3("box"), _el$3 = _$createElement3("text");
    _$insertNode3(_el$2, _el$3);
    _$setProp3(_el$2, "flexDirection", "row");
    _$setProp3(_el$2, "paddingLeft", 1);
    _$setProp3(_el$2, "paddingRight", 1);
    _$setProp3(_el$2, "height", 1);
    _$setProp3(_el$2, "flexShrink", 0);
    _$setProp3(_el$2, "overflow", "hidden");
    _$setProp3(_el$2, "onMouseScroll", () => {
      if (text) {
        text.scrollX = 0;
        text.scrollY = 0;
      }
    });
    _$spread3(_el$2, _$mergeProps3({
      get id() {
        return props.id;
      },
      get backgroundColor() {
        return props.backgroundColor;
      }
    }, () => props.onClick ? {
      onMouseDown: props.onClick
    } : {}), true);
    _$use3((el) => {
      text = el;
    }, _el$3);
    _$setProp3(_el$3, "wrapMode", "none");
    _$insert3(_el$3, () => props.children);
    return _el$2;
  })();
}
function DashboardHeader(props) {
  const PALETTE2 = paletteFor(props.theme);
  const tabBtn = (id, num, label) => {
    const active = () => props.tab === id;
    return (() => {
      var _el$4 = _$createElement3("box"), _el$5 = _$createElement3("text"), _el$6 = _$createElement3("span"), _el$7 = _$createTextNode3(`[`), _el$8 = _$createTextNode3(`] `), _el$9 = _$createElement3("span");
      _$insertNode3(_el$4, _el$5);
      _$setProp3(_el$4, "flexDirection", "row");
      _$setProp3(_el$4, "paddingLeft", 2);
      _$setProp3(_el$4, "paddingRight", 2);
      _$setProp3(_el$4, "height", 1);
      _$spread3(_el$4, _$mergeProps3({
        get backgroundColor() {
          return _$memo3(() => !!active())() ? PALETTE2.cyan : PALETTE2.inset;
        }
      }, {
        onMouseDown: () => props.onSelectTab?.(id)
      }), true);
      _$insertNode3(_el$5, _el$6);
      _$insertNode3(_el$5, _el$9);
      _$setProp3(_el$5, "wrapMode", "none");
      _$insertNode3(_el$6, _el$7);
      _$insertNode3(_el$6, _el$8);
      _$insert3(_el$6, num, _el$8);
      _$insert3(_el$9, label);
      _$effect3((_p$) => {
        var _v$ = {
          fg: active() ? PALETTE2.tabActiveFg : PALETTE2.rule
        }, _v$2 = {
          fg: active() ? PALETTE2.tabActiveFg : PALETTE2.muted,
          bold: active()
        };
        _v$ !== _p$.e && (_p$.e = _$setProp3(_el$6, "style", _v$, _p$.e));
        _v$2 !== _p$.t && (_p$.t = _$setProp3(_el$9, "style", _v$2, _p$.t));
        return _p$;
      }, {
        e: undefined,
        t: undefined
      });
      return _el$4;
    })();
  };
  return (() => {
    var _el$0 = _$createElement3("box"), _el$1 = _$createElement3("box"), _el$10 = _$createElement3("text"), _el$11 = _$createElement3("span"), _el$13 = _$createElement3("span"), _el$15 = _$createElement3("span"), _el$16 = _$createElement3("span"), _el$17 = _$createTextNode3(` [`), _el$18 = _$createTextNode3(` project`), _el$19 = _$createTextNode3(`]`), _el$20 = _$createElement3("box"), _el$21 = _$createElement3("text"), _el$22 = _$createElement3("span"), _el$24 = _$createElement3("box"), _el$25 = _$createElement3("box"), _el$26 = _$createElement3("text"), _el$27 = _$createElement3("span");
    _$insertNode3(_el$0, _el$1);
    _$insertNode3(_el$0, _el$24);
    _$setProp3(_el$0, "flexDirection", "column");
    _$setProp3(_el$0, "flexShrink", 0);
    _$insertNode3(_el$1, _el$10);
    _$insertNode3(_el$1, _el$20);
    _$setProp3(_el$1, "flexDirection", "row");
    _$setProp3(_el$1, "justifyContent", "space-between");
    _$setProp3(_el$1, "alignItems", "center");
    _$setProp3(_el$1, "paddingLeft", 2);
    _$setProp3(_el$1, "paddingRight", 2);
    _$setProp3(_el$1, "height", 1);
    _$setProp3(_el$1, "flexShrink", 0);
    _$insertNode3(_el$10, _el$11);
    _$insertNode3(_el$10, _el$13);
    _$insertNode3(_el$10, _el$15);
    _$insertNode3(_el$10, _el$16);
    _$setProp3(_el$10, "wrapMode", "none");
    _$insertNode3(_el$11, _$createTextNode3(`LOOPD`));
    _$insertNode3(_el$13, _$createTextNode3(` `));
    _$insert3(_el$15, () => props.scopeName);
    _$insertNode3(_el$16, _el$17);
    _$insertNode3(_el$16, _el$18);
    _$insertNode3(_el$16, _el$19);
    _$insert3(_el$16, () => props.projCount, _el$18);
    _$insert3(_el$16, () => props.projCount === 1 ? "" : "s", _el$19);
    _$insertNode3(_el$20, _el$21);
    _$setProp3(_el$20, "flexDirection", "row");
    _$setProp3(_el$20, "paddingLeft", 1);
    _$setProp3(_el$20, "paddingRight", 1);
    _$spread3(_el$20, _$mergeProps3({
      get backgroundColor() {
        return PALETTE2.base;
      }
    }, () => ({
      onMouseDown: props.onBugReport
    })), true);
    _$insertNode3(_el$21, _el$22);
    _$setProp3(_el$21, "wrapMode", "none");
    _$insertNode3(_el$22, _$createTextNode3(`[Bug Report]`));
    _$insertNode3(_el$24, _el$25);
    _$insertNode3(_el$24, _el$26);
    _$setProp3(_el$24, "flexDirection", "row");
    _$setProp3(_el$24, "justifyContent", "space-between");
    _$setProp3(_el$24, "alignItems", "center");
    _$setProp3(_el$24, "paddingLeft", 1);
    _$setProp3(_el$24, "paddingRight", 2);
    _$setProp3(_el$24, "height", 1);
    _$setProp3(_el$24, "flexShrink", 0);
    _$setProp3(_el$25, "flexDirection", "row");
    _$setProp3(_el$25, "gap", 1);
    _$setProp3(_el$25, "alignItems", "center");
    _$insert3(_el$25, () => tabBtn("project", "1", "Project"), null);
    _$insert3(_el$25, () => tabBtn("fleet", "2", "Fleet"), null);
    _$insert3(_el$25, () => tabBtn("commands", "3", "Commands"), null);
    _$insertNode3(_el$26, _el$27);
    _$setProp3(_el$26, "wrapMode", "none");
    _$insert3(_el$27, () => props.mode.toUpperCase());
    _$effect3((_p$) => {
      var _v$3 = PALETTE2.inset, _v$4 = {
        fg: PALETTE2.violet,
        bold: true
      }, _v$5 = {
        fg: PALETTE2.muted
      }, _v$6 = {
        fg: PALETTE2.ink
      }, _v$7 = {
        fg: PALETTE2.muted
      }, _v$8 = {
        fg: PALETTE2.muted
      }, _v$9 = {
        fg: props.mode === "normal" ? PALETTE2.muted : PALETTE2.amber,
        bold: props.mode !== "normal"
      };
      _v$3 !== _p$.e && (_p$.e = _$setProp3(_el$0, "backgroundColor", _v$3, _p$.e));
      _v$4 !== _p$.t && (_p$.t = _$setProp3(_el$11, "style", _v$4, _p$.t));
      _v$5 !== _p$.a && (_p$.a = _$setProp3(_el$13, "style", _v$5, _p$.a));
      _v$6 !== _p$.o && (_p$.o = _$setProp3(_el$15, "style", _v$6, _p$.o));
      _v$7 !== _p$.i && (_p$.i = _$setProp3(_el$16, "style", _v$7, _p$.i));
      _v$8 !== _p$.n && (_p$.n = _$setProp3(_el$22, "style", _v$8, _p$.n));
      _v$9 !== _p$.s && (_p$.s = _$setProp3(_el$27, "style", _v$9, _p$.s));
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
    return _el$0;
  })();
}
function LoopDashboard(props) {
  const theme = () => props.api.theme.current;
  const PALETTE2 = paletteFor(props.api.theme.current);
  const terminal = useTerminalDimensions();
  const initial = props.restoredState;
  const [mode, setMode] = createSignal("normal");
  const [insertKind, setInsertKind] = createSignal("colon");
  const [selected, setSelected] = createSignal(initial?.selected ?? 0);
  const [commandInput, setCommandInput] = createSignal("");
  const [statusText, setStatusText] = createSignal("");
  const [tab, setTab] = createSignal(initial?.tab ?? normalizeInitialView(props.initialView));
  const [cmdSelected, setCmdSelected] = createSignal(initial?.cmdSelected ?? 0);
  const [projectScope, setProjectScope] = createSignal(initial?.projectScope ?? props.directory);
  const [cmdScope, setCmdScope] = createSignal(initial?.cmdScope ?? "all");
  const [filterText, setFilterText] = createSignal(initial?.filterText ?? "");
  const [collapsed, setCollapsed] = createSignal([]);
  const [coordOpen, setCoordOpen] = createSignal(false);
  const [coordTab, setCoordTab] = createSignal("writes");
  const [detailsOpen, setDetailsOpen] = createSignal(initial?.detailsOpen ?? false);
  const [actionsOpen, setActionsOpen] = createSignal(false);
  const [actionIdx, setActionIdx] = createSignal(0);
  const [sendOpen, setSendOpen] = createSignal(false);
  const [selectedKey, setSelectedKey] = createSignal(undefined);
  const [pendingRelease, setPendingRelease] = createSignal(null);
  const ownerSessionID = () => props.ownerSessionID ?? currentRouteSessionID(props.api);
  let detailsScrollEl;
  let coordScrollEl;
  const commandEntries = () => {
    const dirs = cmdScope() === "all" ? managedDirs() : [cmdScope()];
    const out = [];
    for (const dir of dirs) {
      const cmds = dir === props.directory ? state()?.commands ?? [] : managedStates()[dir]?.commands ?? [];
      for (const cmd of cmds)
        out.push({
          cmd,
          dir
        });
    }
    return out;
  };
  const ownerCommands = () => {
    const owned = commandEntries().filter(({
      cmd
    }) => ownerSessionID() ? cmd.ownerSessionID === ownerSessionID() : false);
    const base = showCompleted() ? owned.map(({
      cmd
    }) => cmd) : owned.filter(({
      cmd
    }) => !["exited", "terminated", "missing"].includes(cmd.status)).map(({
      cmd
    }) => cmd);
    const q = filterText().trim().toLowerCase();
    if (!q)
      return base;
    return base.filter((c) => `${c.title} ${c.command} ${c.args.join(" ")} ${c.status}`.toLowerCase().includes(q));
  };
  const commandDir = (commandID) => {
    const hit = commandEntries().find(({
      cmd
    }) => cmd.id === commandID);
    return hit ? hit.dir : props.directory;
  };
  const hiddenFinishedCommands = () => {
    if (showCompleted())
      return 0;
    const terminal = ["exited", "terminated", "missing"];
    return (state()?.commands ?? []).filter((c) => c.ownerSessionID === ownerSessionID() && terminal.includes(c.status)).length;
  };
  const [state, setState] = createSignal(null);
  const [hintCols, setHintCols] = createSignal(84);
  let hintBoxEl;
  createEffect(() => {
    clock();
    const w = hintBoxEl?.width;
    if (typeof w === "number" && w > 0) {
      const cols = Math.max(24, Math.floor(w) - 6);
      if (cols !== hintCols())
        setHintCols(cols);
    }
  });
  const [events, setEvents] = createSignal([]);
  const [selectedGoal, setSelectedGoal] = createSignal(null);
  const [showLogs, setShowLogs] = createSignal(false);
  const [showHelp, setShowHelp] = createSignal(false);
  const [showCompleted, setShowCompleted] = createSignal(initial?.showCompleted ?? false);
  const [clock, setClock] = createSignal(Date.now());
  const [agentIndex, setAgentIndex] = createSignal({});
  const [managedDirList, setManagedDirList] = createSignal([props.directory]);
  const managedDirs = () => managedDirList();
  const [showProjects, setShowProjects] = createSignal(false);
  const [projectIdx, setProjectIdx] = createSignal(0);
  const [projectBounds, setProjectBounds] = createSignal({
    width: 32,
    rows: 6,
    top: 3
  });
  let projectAnchor;
  const [actionsBounds, setActionsBounds] = createSignal({
    width: 32,
    rows: 6,
    top: -8
  });
  const projectOptions = () => tab() === "commands" ? ["all", ...managedDirs()] : managedDirs();
  const projectCurrentScope = () => tab() === "commands" ? cmdScope() : projectScope();
  const projectLabel = (dir) => dir === "all" ? "All projects" : dir.split("/").pop() || dir;
  const [managedStates, setManagedStates] = createSignal({});
  function updateProjectBounds() {
    if (!showProjects() || !projectAnchor)
      return;
    const {
      width,
      height
    } = terminal();
    const below = height - projectAnchor.y - projectAnchor.height - 1;
    const available = below >= 3 ? below : projectAnchor.y - 1;
    const rows = Math.max(1, Math.min(6, available - 2));
    const next = {
      width: Math.max(1, Math.min(40, width - projectAnchor.x - 2)),
      rows,
      top: below >= 3 ? projectAnchor.height : -(Math.min(projectOptions().length, rows) + 2)
    };
    if (next.width !== projectBounds().width || next.rows !== projectBounds().rows || next.top !== projectBounds().top)
      setProjectBounds(next);
  }
  function echoPopupKey(key) {
    if (actionsOpen() || coordOpen() || detailsOpen() || showProjects()) {
      setStatusText(`key:${key} mode:${mode()} acts:${actionsOpen()} det:${detailsOpen()} co:${coordOpen()}`);
    }
  }
  function updateActionsBounds() {
    if (!actionsOpen())
      return;
    const verbs = paletteVerbs();
    const content = verbs.reduce((m, v) => Math.max(m, v.label.length + v.key.length), 0);
    const width = Math.min(40, Math.max(24, content + 9));
    const rows = Math.max(1, Math.min(6, verbs.length));
    const next = {
      width,
      rows,
      top: -(Math.min(verbs.length, rows) + 2)
    };
    const old = actionsBounds();
    if (next.width !== old.width || next.rows !== old.rows || next.top !== old.top)
      setActionsBounds(next);
  }
  function openActions() {
    if (!selectedGoal())
      return;
    closeProjectsPicker();
    setActionIdx(0);
    setActionsOpen(true);
    inputEl?.blur();
    updateActionsBounds();
  }
  createEffect(() => {
    lastDashboardState = {
      tab: tab(),
      selected: selected(),
      cmdSelected: cmdSelected(),
      projectScope: projectScope(),
      cmdScope: cmdScope(),
      filterText: filterText(),
      showCompleted: showCompleted(),
      detailsOpen: detailsOpen()
    };
  });
  function openProjectsPicker() {
    if (tab() === "fleet" || modalPopupOpen() || actionsOpen())
      return;
    setProjectIdx(Math.max(0, projectOptions().indexOf(projectCurrentScope())));
    setShowProjects(true);
    inputEl?.blur();
    updateProjectBounds();
  }
  function closeProjectsPicker() {
    setShowProjects(false);
    focusInput();
  }
  function applyProjectChoice(dir) {
    batch(() => {
      if (dir !== projectCurrentScope()) {
        if (tab() === "commands") {
          setCmdScope(dir);
          setCmdSelected(0);
        } else {
          setProjectScope(dir);
          setSelected(0);
        }
      }
      closeProjectsPicker();
      setStatusText(`scope: ${projectLabel(dir)}`);
    });
  }
  async function refreshProjects() {
    try {
      setManagedDirList(await resolveManagedDirs2(props.directory));
      const states = {};
      for (const dir of managedDirs()) {
        if (dir === props.directory)
          continue;
        try {
          states[dir] = await readState(dir);
        } catch {}
      }
      if (!disposed)
        setManagedStates(states);
    } catch (e) {
      setStatusText(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  let inputEl;
  let focusTimer;
  let disposed = false;
  const client = createControlClient(props.directory);
  const clients = new Map([[props.directory, client]]);
  function clientFor(dir) {
    let c = clients.get(dir);
    if (!c) {
      c = createControlClient(dir);
      clients.set(dir, c);
    }
    return c;
  }
  const popMode = props.api.mode.push("loopd.dashboard");
  function focusInput() {
    if (disposed)
      return;
    if (focusTimer)
      clearTimeout(focusTimer);
    focusTimer = setTimeout(() => {
      if (disposed)
        return;
      if (mode() === "insert") {
        const current = props.api.renderer.currentFocusedRenderable;
        if (current && current !== inputEl)
          current.blur();
        inputEl?.focus();
      } else {
        inputEl?.blur();
      }
    }, 10);
  }
  function enterInsertMode(kind, initialValue = "") {
    setInsertKind(kind);
    setCommandInput(initialValue);
    if (inputEl)
      inputEl.value = initialValue;
    setMode("insert");
    focusInput();
  }
  function returnToNormalMode() {
    setCommandInput("");
    if (inputEl)
      inputEl.value = "";
    setSendOpen(false);
    setMode("normal");
    focusInput();
  }
  function openSendModal() {
    if (!selectedGoal() && tab() !== "commands") {
      setStatusText("No worker selected");
      return;
    }
    setActionsOpen(false);
    setCoordOpen(false);
    setShowHelp(false);
    setSendOpen(true);
    enterInsertMode("send", "");
  }
  function openFilterBox() {
    setActionsOpen(false);
    setCoordOpen(false);
    setSendOpen(false);
    enterInsertMode("filter", filterText());
  }
  function dismissTopSubPopup() {
    if (showProjects()) {
      closeProjectsPicker();
      return true;
    }
    if (pendingRelease()) {
      setPendingRelease(null);
      return true;
    }
    if (sendOpen()) {
      returnToNormalMode();
      return true;
    }
    if (actionsOpen()) {
      setActionsOpen(false);
      return true;
    }
    if (coordOpen()) {
      setCoordOpen(false);
      focusInput();
      return true;
    }
    if (showHelp()) {
      setShowHelp(false);
      return true;
    }
    if (mode() === "insert") {
      if (insertKind() === "filter")
        setFilterText("");
      returnToNormalMode();
      return true;
    }
    if (detailsOpen()) {
      setDetailsOpen(false);
      return true;
    }
    if (filterText()) {
      setFilterText("");
      setStatusText("filter cleared");
      return true;
    }
    return false;
  }
  activeSubPopupDismiss = dismissTopSubPopup;
  const projectPickerActive = () => showProjects() && (props.isActive?.() ?? props.api.ui.dialog.open);
  activeProjectPickerOpen = projectPickerActive;
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
  refreshProjects();
  const unsubs = [props.api.event.on("session.idle", () => refresh()), props.api.event.on("session.status", () => refresh()), props.api.event.on("session.error", () => refresh()), props.api.event.on("session.compacted", () => refresh()), setInterval(refresh, 1e4), setInterval(() => setClock(Date.now()), 500)];
  onCleanup(() => {
    disposed = true;
    if (activeSubPopupDismiss === dismissTopSubPopup)
      activeSubPopupDismiss = undefined;
    if (activeProjectPickerOpen === projectPickerActive)
      activeProjectPickerOpen = undefined;
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
  const paletteVerbs = () => {
    const g = selectedGoal();
    if (!g)
      return [];
    const list = [];
    if (g.status === "paused")
      list.push({
        key: "r",
        cmd: "resume",
        label: "Resume worker"
      });
    else if (g.status === "blocked") {
      list.push({
        key: "R",
        cmd: "retry",
        label: "Retry worker"
      });
      list.push({
        key: "p",
        cmd: "pause",
        label: "Pause worker"
      });
    } else if (g.status === "complete") {
      list.push({
        key: "x",
        cmd: "clear",
        label: "Clear completed goal"
      });
    } else {
      list.push({
        key: "p",
        cmd: "pause",
        label: "Pause worker"
      });
      list.push({
        key: "N",
        cmd: "nudge",
        label: "Nudge with full contract"
      });
      list.push({
        key: "A",
        cmd: "abort",
        label: "Abort current turn only"
      });
    }
    list.push({
      key: "s",
      cmd: "__send__",
      label: "Send bare input to worker"
    });
    list.push({
      key: "o",
      cmd: "open",
      label: "Open worker session transcript"
    });
    list.push({
      key: "m",
      cmd: "interactive",
      label: g.interactive ? "Switch to autonomous turns" : "Switch to manual (await input)"
    });
    list.push({
      key: "Esc",
      cmd: "__cancel__",
      label: "Cancel"
    });
    return list;
  };
  const verbKeyColor = (cmd) => {
    if (cmd === "abort")
      return PALETTE2.rose;
    if (cmd === "pause" || cmd === "__cancel__")
      return PALETTE2.amber;
    if (cmd === "nudge" || cmd === "__send__")
      return PALETTE2.sage;
    if (cmd === "open")
      return PALETTE2.sky;
    if (cmd === "interactive")
      return PALETTE2.violet;
    return PALETTE2.muted;
  };
  async function runPaletteVerb(item) {
    setActionsOpen(false);
    if (item.cmd === "__cancel__")
      return;
    if (item.cmd === "__send__") {
      openSendModal();
      return;
    }
    await executeCommand(item.cmd);
  }
  const handleDashboardKey = (evt) => {
    if (evt.defaultPrevented)
      return;
    const name = evt.name || "";
    const seq = evt.sequence || "";
    const raw = evt.raw || "";
    const active = (() => {
      try {
        return props.isActive?.() ?? props.api.ui.dialog.open;
      } catch {
        return props.api.ui.dialog.open;
      }
    })();
    if (!active)
      return;
    const isColon = name === ":" || seq === ":" || raw === ":" || name === "colon";
    const isQuestion = name === "?" || seq === "?" || raw === "?";
    if (showProjects()) {
      prevent(evt);
      if (isEscapeKey(evt) || name === "q")
        closeProjectsPicker();
      else if (name === "down" || name === "j")
        setProjectIdx((i) => Math.min(projectOptions().length - 1, i + 1));
      else if (name === "up" || name === "k")
        setProjectIdx((i) => Math.max(0, i - 1));
      else if (isEnterKey(evt)) {
        const dir = projectOptions()[projectIdx()];
        if (dir)
          applyProjectChoice(dir);
      }
      return;
    }
    if (mode() === "insert") {
      if (isEscapeKey(evt) || isCtrlN(evt)) {
        prevent(evt);
        if (insertKind() === "filter")
          setFilterText("");
        returnToNormalMode();
        return;
      }
      if (isEnterKey(evt)) {
        prevent(evt);
        const val = commandInput().trim();
        const kind = insertKind();
        if (kind === "filter") {
          setFilterText(val);
          setStatusText(val ? `filter: "${val}"` : "filter cleared");
          returnToNormalMode();
          return;
        }
        if (kind === "send") {
          returnToNormalMode();
          if (!val)
            return;
          if (tab() === "commands") {
            executeCommand(val);
          } else {
            executeCommand(`send ${val}`);
          }
          return;
        }
        executeCommand(val);
        return;
      }
      return;
    }
    const key = raw || seq || name;
    echoPopupKey(key);
    if (pendingRelease()) {
      if (key === "y" || isEnterKey(evt)) {
        prevent(evt);
        const target = pendingRelease();
        setPendingRelease(null);
        releaseWorkspaceFences({
          callID: target.callID
        }, target.dir);
        return;
      }
      if (isEscapeKey(evt) || key === "n") {
        prevent(evt);
        setPendingRelease(null);
        return;
      }
      return;
    }
    if (actionsOpen()) {
      const verbs = paletteVerbs();
      if (isEscapeKey(evt)) {
        prevent(evt);
        setActionsOpen(false);
        return;
      }
      if (name === "down" || key === "j") {
        prevent(evt);
        setActionIdx((i) => Math.min(verbs.length - 1, i + 1));
        return;
      }
      if (name === "up" || key === "k") {
        prevent(evt);
        setActionIdx((i) => Math.max(0, i - 1));
        return;
      }
      if (isEnterKey(evt)) {
        prevent(evt);
        const chosen = verbs[actionIdx()];
        if (chosen)
          runPaletteVerb(chosen);
        return;
      }
      const match = verbs.find((v) => v.key === key);
      if (match) {
        prevent(evt);
        runPaletteVerb(match);
        return;
      }
      return;
    }
    if (coordOpen()) {
      if (isEscapeKey(evt) || key === "t") {
        prevent(evt);
        setCoordOpen(false);
        focusInput();
        return;
      }
      if (name === "down" || key === "j") {
        prevent(evt);
        coordScrollEl?.scrollBy({
          x: 0,
          y: 2
        });
        return;
      }
      if (name === "up" || key === "k") {
        prevent(evt);
        coordScrollEl?.scrollBy({
          x: 0,
          y: -2
        });
        return;
      }
      if (key === "g") {
        prevent(evt);
        coordScrollEl?.scrollTo(0);
        return;
      }
      if (key === "G") {
        prevent(evt);
        coordScrollEl?.scrollTo(9999);
        return;
      }
      if (key === "w" || key === "1") {
        prevent(evt);
        setCoordTab("writes");
        return;
      }
      if (key === "v" || key === "2") {
        prevent(evt);
        setCoordTab("verify");
        return;
      }
      if (key === "r" || key === "3") {
        prevent(evt);
        setCoordTab("resv");
        return;
      }
      if (name === "tab" && !evt.shift || name === "right") {
        prevent(evt);
        setCoordTab((t) => t === "writes" ? "verify" : t === "verify" ? "resv" : "writes");
        return;
      }
      if (name === "left" || name === "tab" && evt.shift) {
        prevent(evt);
        setCoordTab((t) => t === "resv" ? "verify" : t === "verify" ? "writes" : "resv");
        return;
      }
      if (key === "W") {
        prevent(evt);
        const first = coordModel().reservations[0];
        if (first)
          setPendingRelease({
            callID: first.callID,
            dir: coordDir()
          });
        else
          releaseWorkspaceFences({}, coordDir());
        return;
      }
      return;
    }
    if (detailsOpen()) {
      if (isEscapeKey(evt) || key === "d") {
        prevent(evt);
        setDetailsOpen(false);
        return;
      }
      if (name === "down" || key === "j" || key === "J" || name === "pagedown") {
        prevent(evt);
        detailsScrollEl?.scrollBy(name === "pagedown" || key === "J" ? 1 : {
          x: 0,
          y: 1
        }, name === "pagedown" || key === "J" ? "viewport" : "absolute");
        return;
      }
      if (name === "up" || key === "k" || key === "K" || name === "pageup") {
        prevent(evt);
        detailsScrollEl?.scrollBy(name === "pageup" || key === "K" ? -1 : {
          x: 0,
          y: -1
        }, name === "pageup" || key === "K" ? "viewport" : "absolute");
        return;
      }
      if (key === "g") {
        prevent(evt);
        detailsScrollEl?.scrollTo(0);
        return;
      }
      if (key === "G") {
        prevent(evt);
        detailsScrollEl?.scrollTo(9999);
        return;
      }
      if (key === "n" || key === "]") {
        prevent(evt);
        const max = Math.max(0, rowModels().length - 1);
        setSelected((s) => Math.min(max, s + 1));
        return;
      }
      if (key === "p" || key === "[") {
        prevent(evt);
        setSelected((s) => Math.max(0, s - 1));
        return;
      }
      return;
    }
    if (showHelp()) {
      if (isEscapeKey(evt) || isQuestion || key === "q") {
        prevent(evt);
        setShowHelp(false);
        return;
      }
      return;
    }
    if (isEscapeKey(evt)) {
      if (dismissTopSubPopup()) {
        prevent(evt);
        return;
      }
      return;
    }
    if (isColon) {
      prevent(evt);
      enterInsertMode("colon", "");
      return;
    }
    if (isQuestion) {
      prevent(evt);
      setShowHelp((v) => !v);
      return;
    }
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
    if (key === "h") {
      prevent(evt);
      setShowCompleted((v) => {
        const next = !v;
        setStatusText(next ? "History shown" : "History hidden");
        return next;
      });
      return;
    }
    if (key === "P") {
      prevent(evt);
      openProjectsPicker();
      return;
    }
    const currentGoals = rowModels();
    const currentCommands = ownerCommands();
    if (name === "tab") {
      prevent(evt);
      if (evt.shift)
        setTab((v) => toggleDashboardViewBack(v));
      else
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
    if (tab() === "commands" && ["p", "r", "A", "N"].includes(key)) {
      prevent(evt);
      setStatusText(`Key "${key}" is a Worker control \u2014 switch to [1] Project or [2] Fleet.`);
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
    if (key === "/") {
      prevent(evt);
      openFilterBox();
      return;
    }
    if (key === "d") {
      prevent(evt);
      setDetailsOpen((v) => !v);
      return;
    }
    if (key === "t") {
      prevent(evt);
      setCoordOpen((v) => !v);
      return;
    }
    if (key === "s") {
      prevent(evt);
      openSendModal();
      return;
    }
    if (key === "f" && tab() === "fleet" && selectedGoal()) {
      prevent(evt);
      const dir = selectedDir();
      setProjectScope(dir);
      setTab("project");
      setSelected(0);
      setStatusText(`scope: ${dir.split("/").pop() || dir}`);
      return;
    }
    if (isEnterKey(evt)) {
      prevent(evt);
      if (tab() === "commands") {
        openSendModal();
        return;
      }
      openActions();
      return;
    }
    if (key === "[") {
      prevent(evt);
      cycleScope(-1);
      return;
    }
    if (key === "]") {
      prevent(evt);
      cycleScope(1);
      return;
    }
    if (key === "W") {
      prevent(evt);
      if (fenceCount() === 0) {
        setStatusText("No workspace fences to release.");
        return;
      }
      const goal = selectedGoal();
      releaseWorkspaceFences(goal ? {
        goalID: goal.id
      } : {}, goal ? goalDir(goal.id) : undefined);
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
        goals: activeGoals().map((e) => e.goal),
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
        setStatusText(target.reason === "no-worker-session" ? "No worker session" : target.reason === "no-command" ? "No command selected." : "Nothing to open.");
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
  };
  useKeyboard(handleDashboardKey);
  async function executeCommandRaw(command, args, commandID) {
    const owner = ownerSessionID();
    if (!owner) {
      setStatusText("No owning session (open from a session view) \u2014 mutations disabled.");
      return;
    }
    if (commandID && commandDir(commandID) !== props.directory) {
      setStatusText(`Foreign command \u2014 open the ${commandDir(commandID)} dashboard. Mutations stay local.`);
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
  async function releaseWorkspaceFences(selection, dir) {
    const owner = ownerSessionID();
    if (!owner) {
      setStatusText("No owning session \u2014 release disabled.");
      return;
    }
    const targetDir = dir ?? props.directory;
    const selecting = Boolean(selection.callID || selection.goalID || selection.sessionID);
    if (!selecting && fenceCount() === 0) {
      setStatusText("No live workspace reservations \u2014 nothing is fencing this project.");
      return;
    }
    setStatusText(selecting ? "releasing workspace fence\u2026" : "inspecting workspace fences\u2026");
    try {
      const r = await clientFor(targetDir).execute({
        version: 1,
        requestID: randomUUID2(),
        requestedAt: new Date().toISOString(),
        command: "release_workspace",
        args: {
          ownerSessionID: owner,
          ...selection
        }
      });
      setStatusText(r.ok ? r.message : `Release refused: ${r.message}`);
      await refresh();
    } catch (e) {
      setStatusText(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
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
      setStatusText(`"${sel.title}" is still running \u2014 X force kill \xB7 :terminate graceful.`);
      return;
    }
    executeCommandRaw("cmd_remove", {
      commandID: sel.id
    }, sel.id);
  }
  async function executeCommandTabCommand(verb, _positional, raw) {
    switch (verb) {
      case "model":
      case "models":
      case "agent":
      case "agents":
        setStatusText(`:${verb} is only available on the Project / Fleet tabs.`);
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
      case "projects": {
        setShowProjects(true);
        await refreshProjects();
        return;
      }
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
    if (tab() === "commands" && !["q", "close", "filter", "project", "history"].includes(parsed.command)) {
      await executeCommandTabCommand(parsed.command, parsed.positional, parsed.raw);
      returnToNormalMode();
      return;
    }
    const verbDir = selectedGoal() ? goalDir(selectedGoal().id) : props.directory;
    const bus = clientFor(verbDir);
    if (!["help", "logs", "q", "close", "filter", "project", "history", "collapse", "focus"].includes(parsed.command)) {
      setStatusText(`sending ${parsed.command}\u2026`);
    }
    try {
      switch (parsed.command) {
        case "filter": {
          setFilterText(parsed.positional.join(" "));
          setStatusText(parsed.positional.length ? `filter: "${parsed.positional.join(" ")}"` : "filter cleared");
          break;
        }
        case "project": {
          const name = parsed.positional.join(" ").trim();
          if (!name) {
            setStatusText(`projects: ${managedDirs().join(" \xB7 ")}`);
            break;
          }
          const match = managedDirs().find((d) => d === name || d.split("/").pop() === name || String(managedDirs().indexOf(d) + 1) === name);
          if (!match) {
            setStatusText(`Unknown project "${name}"`);
            break;
          }
          if (tab() === "commands")
            setCmdScope(match);
          else
            setProjectScope(match);
          setSelected(0);
          setStatusText(`scope: ${match.split("/").pop() || match}`);
          break;
        }
        case "collapse": {
          const name = parsed.positional.join(" ").trim();
          const dir = name ? managedDirs().find((d) => d === name || d.split("/").pop() === name) ?? selectedDir() : selectedDir();
          setCollapsed((list) => toggleCollapsed(list, dir));
          break;
        }
        case "focus": {
          const dir = selectedDir();
          setProjectScope(dir);
          setTab("project");
          setSelected(0);
          setFilterText("");
          setStatusText(`scope: ${dir.split("/").pop() || dir}`);
          break;
        }
        case "history": {
          setShowCompleted((v) => !v);
          setStatusText(showCompleted() ? "History shown" : "History hidden");
          break;
        }
        case "send": {
          if (!selectedGoal()) {
            setStatusText("No goal selected");
            break;
          }
          const message = parsed.positional.join(" ") || parsed.args.message || "";
          if (!message) {
            openSendModal();
            return;
          }
          const r = await bus.execute({
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
          try {
            props.api.route.navigate("session", {
              sessionID: goal.workerSessionID
            });
            props.api.ui.dialog.clear();
          } catch {
            setStatusText("Navigate unsupported here \u2014 read transcript via read_goal_transcript.");
          }
          return;
        }
        case "force": {
          if (!selectedGoal()) {
            setStatusText("No goal");
            break;
          }
          const summary = parsed.positional.join(" ") || parsed.args.summary || "Force-completed from dashboard.";
          const evidence = parsed.args.evidence || "Manual override \u2014 no verification checks run.";
          const r = await bus.execute({
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
          const r = await bus.execute({
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
          const r = await bus.execute({
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
          const r = await bus.execute({
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
          const r = await bus.execute({
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
          const r = await bus.execute({
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
          const r = await bus.execute({
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
          const r = await bus.execute({
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
          const r = await bus.execute({
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
            setStatusText("Usage: :agent <name>");
            break;
          }
          const r = await bus.execute({
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
          const r = await bus.execute({
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
            setStatusText("Usage: :model <provider/model>");
            break;
          }
          const r = await bus.execute({
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
          const r = await bus.execute({
            version: 1,
            requestID: randomUUID2(),
            requestedAt: new Date().toISOString(),
            command: "list_models"
          });
          setStatusText(r.ok ? r.message : `Error: ${r.message}`);
          break;
        }
        case "release": {
          await releaseWorkspaceFences({
            callID: parsed.args.call,
            goalID: parsed.args.goal,
            sessionID: parsed.args.session
          });
          break;
        }
        case "goal": {
          setStatusText("Create goals via /goal in parent chat.");
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
        case "projects": {
          await openProjectsPicker();
          break;
        }
        case "q":
        case "close":
          props.api.ui.dialog.clear();
          return;
        default: {
          if (parsed.command && selectedGoal()) {
            const message = parsed.raw;
            const r = await bus.execute({
              version: 1,
              requestID: randomUUID2(),
              requestedAt: new Date().toISOString(),
              command: "send",
              goalID: selectedGoal().id,
              args: {
                message
              }
            });
            setStatusText(r.ok ? `sent: ${message.slice(0, 60)}` : `Error: ${r.message}`);
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
  const activeGoals = () => {
    const inScope = (g) => showCompleted() || g.status !== "complete";
    if (tab() === "fleet") {
      const own = (state()?.goals ?? []).filter(inScope).map((g) => ({
        goal: g,
        dir: props.directory
      }));
      const seen = new Set(own.map((e) => e.goal.id));
      const out = [...own];
      for (const [dir, st] of Object.entries(managedStates())) {
        if (dir === props.directory)
          continue;
        for (const g of st.goals ?? []) {
          if (inScope(g) && !seen.has(g.id)) {
            seen.add(g.id);
            out.push({
              goal: g,
              dir
            });
          }
        }
      }
      return out;
    }
    const dir = projectScope();
    const list = dir === props.directory ? state()?.goals ?? [] : managedStates()[dir]?.goals ?? [];
    return list.filter(inScope).map((goal) => ({
      goal,
      dir
    }));
  };
  const activeFilterQuery = () => mode() === "insert" && insertKind() === "filter" ? commandInput() : filterText();
  const rowModels = () => {
    const now = clock();
    const rows = activeGoals().map(({
      goal,
      dir
    }) => toRowModel(goal, dir, runtimeFor(goal.id), now));
    return filterRows(rows, activeFilterQuery());
  };
  const modalPopupOpen = () => Boolean(pendingRelease()) || sendOpen() || coordOpen() || detailsOpen() || showHelp();
  createEffect(() => {
    if (showProjects() && (tab() === "fleet" || modalPopupOpen()))
      closeProjectsPicker();
  });
  const displayItems = () => {
    const rows = rowModels();
    if (tab() !== "fleet") {
      return rows.map((row, index) => ({
        kind: "row",
        row,
        index
      }));
    }
    const out = [];
    for (const group of groupByDirectory(rows, collapsed())) {
      out.push({
        kind: "header",
        dir: group.directory,
        group
      });
      rows.forEach((row, idx) => {
        if (row.directory === group.directory)
          out.push({
            kind: "row",
            row,
            index: idx
          });
      });
    }
    return out;
  };
  const goalDir = (goalID) => {
    if ((state()?.goals ?? []).some((g) => g.id === goalID))
      return props.directory;
    for (const [dir, st] of Object.entries(managedStates())) {
      if ((st.goals ?? []).some((g) => g.id === goalID))
        return dir;
    }
    return props.directory;
  };
  const runtimeFor = (goalID) => state()?.runtimes.find((r) => r.goalID === goalID) ?? Object.values(managedStates()).map((st) => (st.runtimes ?? []).find((r) => r.goalID === goalID)).find(Boolean);
  const recentTranscriptFor = (goalID) => events().filter((e) => e.goalID === goalID).slice(-10).map((e) => {
    const ev = e;
    return `${String(ev.type ?? "event")}${ev.summary ? ` \u2014 ${ev.summary}` : ""}`.slice(0, 160);
  });
  const coordDir = () => {
    if (tab() === "fleet")
      return selectedDir();
    if (tab() === "commands")
      return cmdScope() === "all" ? props.directory : cmdScope();
    return projectScope();
  };
  const stateForDir = (dir) => dir === props.directory ? state() : managedStates()[dir] ?? null;
  const coordModel = () => {
    const dir = coordDir();
    const st = stateForDir(dir);
    const goals = st?.goals ?? [];
    const nameOf = (goalID) => goalID && goals.find((g) => g.id === goalID)?.name || (goalID ?? "").slice(0, 8) || "owner/session";
    const holds = (st?.writeTickets?.holders ?? []).map((h) => ({
      files: h.files ?? [],
      sessionID: h.sessionID ?? "?",
      goalName: nameOf(h.goalID),
      age: ageText(h.grantedAt, clock())
    }));
    const queue = (st?.writeTickets?.queue ?? []).map((w, i) => {
      const conflict = holds.find((h) => h.files.some((f) => (w.files ?? []).includes(f)));
      return {
        files: w.files ?? [],
        sessionID: w.sessionID ?? "?",
        goalName: nameOf(w.goalID),
        position: i + 1,
        waitsFor: conflict ? `${conflict.goalName} (${conflict.files.join(", ").slice(0, 40)})` : "clearing writes",
        ownerPriority: w.isOwner === true
      };
    });
    const blockers = [];
    const op = st?.workspaceOperation;
    if (op)
      blockers.push({
        kind: "operation",
        text: `operation ${op.id}`,
        holder: `session ${op.sessionID}${op.goalID ? ` \xB7 ${nameOf(op.goalID)}` : ""}`
      });
    for (const h of holds)
      blockers.push({
        kind: "ticket",
        text: `ticket on ${h.files.join(", ").slice(0, 60)}`,
        holder: `${h.goalName} \xB7 held ${h.age}`
      });
    for (const c of (st?.workspaceCalls ?? []).filter((c) => c.uncontrolled)) {
      blockers.push({
        kind: "uncontrolled",
        text: "live shell/command",
        holder: `session ${(c.sessionID ?? "").slice(0, 12)}\u2026`,
        age: ageText(c.at, clock())
      });
    }
    for (const c of (st?.workspaceCalls ?? []).filter((c) => (c.paths?.length ?? 0) > 0)) {
      blockers.push({
        kind: "legacy",
        text: `legacy write on ${(c.paths ?? []).join(", ").slice(0, 60)}`,
        holder: `session ${(c.sessionID ?? "").slice(0, 12)}\u2026`,
        age: ageText(c.at, clock())
      });
    }
    return {
      directory: dir,
      shortName: dir.split("/").pop() || dir,
      holds,
      queue,
      verifyBlockers: blockers,
      verifyNote: blockers.length === 0 ? "Workspace quiet \u2014 checks can run" : undefined,
      reservations: (st?.workspaceCalls ?? []).map((c) => ({
        callID: c.callID,
        sessionID: c.sessionID ?? "?",
        goalName: nameOf(c.goalID),
        live: true,
        releasable: true,
        reason: "Server verifies ownership and liveness before releasing.",
        age: ageText(c.at, clock())
      }))
    };
  };
  function cycleScope(dir) {
    if (tab() === "commands") {
      const opts = ["all", ...managedDirs()];
      const idx = opts.indexOf(cmdScope());
      setCmdScope(opts[(idx + dir + opts.length) % opts.length]);
      setCmdSelected(0);
      return;
    }
    const dirs = managedDirs();
    if (dirs.length <= 1) {
      setStatusText("1 project managed \u2014 :projects lists registry");
      return;
    }
    const idx = dirs.indexOf(projectScope());
    setProjectScope(dirs[(idx + dir + dirs.length) % dirs.length]);
    setSelected(0);
  }
  const scopeSummaryCounts = () => {
    const entries = activeGoals();
    return summarizeScope(entries.map((e) => e.goal), (i) => {
      const rt = runtimeFor(entries[i].goal.id);
      return entries[i].goal.interactive === true && !!rt && rt.phase === "idle" && !rt.activeRunID;
    });
  };
  const scopeSummaryText = () => {
    if (tab() === "commands") {
      const running = ownerCommands().filter((c) => c.status === "running").length;
      return `${running} running \xB7 ${ownerCommands().length} shown`;
    }
    return summaryText(scopeSummaryCounts());
  };
  const fenceCount = () => state()?.workspaceCalls?.length || 0;
  function handleBugReport() {
    const goal = selectedGoal();
    const extra = goal ? `Goal: ${goal.name} (${goal.id.slice(0, 8)}) status=${goal.status}` : "No goal selected";
    const url = bugReportUrl({
      runtimeLabel: `opencode-loopd dashboard`,
      extra
    });
    const res = openBrowserUrl(url);
    setStatusText(res.status === "opened" ? "Opening bug report in browser\u2026" : `Bug report: ${url}`);
  }
  createEffect(() => {
    const rows = rowModels();
    setSelected(Math.max(0, Math.min(selected(), Math.max(0, rows.length - 1))));
    setCmdSelected(Math.max(0, Math.min(cmdSelected(), Math.max(0, ownerCommands().length - 1))));
    const row = rows[selected()] ?? null;
    const entry = row ? activeGoals().find((e) => e.goal.id === row.id && e.dir === row.directory) ?? null : null;
    setSelectedGoal(entry ? entry.goal : null);
    const key = entry ? goalSelectionKey(entry.dir, entry.goal.id) : undefined;
    if (key !== selectedKey()) {
      const idx = key ? indexForSelectionKey(rows.map((r) => goalSelectionKey(r.directory, r.id)), key) : 0;
      if (idx !== selected())
        setSelected(idx);
      setSelectedKey(key);
    }
  });
  const selectedDir = () => activeGoals()[selected()]?.dir ?? props.directory;
  function rowIdFor(goalID) {
    return `loopd-goal-${goalID}`;
  }
  const rowStateColor = (row) => {
    if (row.state === "blocked" || row.state === "budget_limited" || row.state === "usage_limited")
      return PALETTE2.rose;
    if (row.state === "active")
      return row.manual ? PALETTE2.amber : PALETTE2.sage;
    if (row.state === "paused")
      return PALETTE2.violet;
    if (row.state === "complete")
      return PALETTE2.sky;
    return PALETTE2.muted;
  };
  const rowNameColor = (row) => {
    if (row.state === "blocked" || row.state === "budget_limited" || row.state === "usage_limited")
      return PALETTE2.rose;
    if (row.state === "active")
      return row.manual ? PALETTE2.amber : PALETTE2.sage;
    if (row.state === "paused")
      return PALETTE2.violet;
    if (row.state === "complete")
      return PALETTE2.sky;
    return PALETTE2.ink;
  };
  const coordStripSummary = () => {
    const cm = coordModel();
    const projPrefix = tab() === "fleet" ? `${cm.shortName} \u2502 ` : "";
    const writesPart = `Writes ${cm.holds.length} running${cm.queue.length ? ` \xB7 ${cm.queue.length} queued` : ""}`;
    const verifyPart = cm.verifyBlockers.length ? `Verification waiting (${cm.verifyBlockers.length})` : "No verification waits";
    const resvPart = cm.reservations.length ? ` \u2502 ${cm.reservations.length} reservation${cm.reservations.length === 1 ? "" : "s"}` : "";
    return `${projPrefix}${writesPart} \xB7 ${verifyPart}${resvPart}`;
  };
  const headerModeLabel = () => {
    if (mode() !== "insert")
      return "normal";
    if (insertKind() === "filter")
      return "filter";
    if (insertKind() === "send")
      return "send";
    return "command";
  };
  return (() => {
    var _el$28 = _$createElement3("box"), _el$29 = _$createElement3("box"), _el$223 = _$createElement3("box"), _el$224 = _$createElement3("text"), _el$225 = _$createElement3("span"), _el$226 = _$createElement3("box"), _el$227 = _$createElement3("text"), _el$228 = _$createElement3("span"), _el$230 = _$createElement3("box"), _el$234 = _$createElement3("input");
    _$insertNode3(_el$28, _el$29);
    _$insertNode3(_el$28, _el$223);
    _$insertNode3(_el$28, _el$230);
    _$setProp3(_el$28, "flexDirection", "column");
    _$setProp3(_el$28, "width", "100%");
    _$setProp3(_el$28, "border", true);
    _$setProp3(_el$28, "flexShrink", 0);
    _$insert3(_el$28, _$createComponent3(DashboardHeader, {
      get theme() {
        return theme();
      },
      get mode() {
        return headerModeLabel();
      },
      get scopeName() {
        return _$memo3(() => tab() === "fleet")() ? "All projects" : _$memo3(() => tab() === "commands")() ? _$memo3(() => cmdScope() === "all")() ? "All projects" : cmdScope().split("/").pop() || cmdScope() : projectScope().split("/").pop() || projectScope();
      },
      get summary() {
        return scopeSummaryText();
      },
      get tab() {
        return tab();
      },
      get projCount() {
        return managedDirs().length;
      },
      onBugReport: handleBugReport,
      onSelectTab: (nextTab) => {
        if (showProjects())
          closeProjectsPicker();
        setTab(nextTab);
        setSelected(0);
      }
    }), _el$29);
    _$setProp3(_el$29, "flexDirection", "column");
    _$setProp3(_el$29, "paddingLeft", 2);
    _$setProp3(_el$29, "paddingRight", 2);
    _$setProp3(_el$29, "paddingTop", 0);
    _$setProp3(_el$29, "paddingBottom", 0);
    _$setProp3(_el$29, "gap", 0);
    _$setProp3(_el$29, "flexShrink", 0);
    _$insert3(_el$29, _$createComponent3(Show3, {
      get when() {
        return pendingRelease();
      },
      get children() {
        var _el$30 = _$createElement3("box"), _el$31 = _$createElement3("box"), _el$32 = _$createElement3("text"), _el$33 = _$createElement3("span"), _el$35 = _$createElement3("text"), _el$36 = _$createElement3("span"), _el$38 = _$createElement3("text"), _el$39 = _$createElement3("span"), _el$40 = _$createElement3("span"), _el$41 = _$createTextNode3(` in `), _el$42 = _$createElement3("text"), _el$43 = _$createElement3("span"), _el$45 = _$createElement3("box"), _el$46 = _$createElement3("box"), _el$47 = _$createElement3("text"), _el$48 = _$createElement3("span"), _el$50 = _$createElement3("box"), _el$51 = _$createElement3("text"), _el$52 = _$createElement3("span");
        _$insertNode3(_el$30, _el$31);
        _$insertNode3(_el$30, _el$38);
        _$insertNode3(_el$30, _el$42);
        _$insertNode3(_el$30, _el$45);
        _$setProp3(_el$30, "flexDirection", "column");
        _$setProp3(_el$30, "border", true);
        _$setProp3(_el$30, "paddingLeft", 2);
        _$setProp3(_el$30, "paddingRight", 2);
        _$setProp3(_el$30, "paddingTop", 1);
        _$setProp3(_el$30, "paddingBottom", 1);
        _$setProp3(_el$30, "gap", 1);
        _$insertNode3(_el$31, _el$32);
        _$insertNode3(_el$31, _el$35);
        _$setProp3(_el$31, "flexDirection", "row");
        _$setProp3(_el$31, "justifyContent", "space-between");
        _$setProp3(_el$31, "height", 1);
        _$insertNode3(_el$32, _el$33);
        _$setProp3(_el$32, "wrapMode", "none");
        _$insertNode3(_el$33, _$createTextNode3(`Release reservation`));
        _$insertNode3(_el$35, _el$36);
        _$setProp3(_el$35, "wrapMode", "none");
        _$insertNode3(_el$36, _$createTextNode3(`[esc]`));
        _$insertNode3(_el$38, _el$39);
        _$insertNode3(_el$38, _el$40);
        _$setProp3(_el$38, "wrapMode", "word");
        _$insert3(_el$39, () => pendingRelease().callID);
        _$insertNode3(_el$40, _el$41);
        _$insert3(_el$40, () => pendingRelease().dir, null);
        _$insertNode3(_el$42, _el$43);
        _$setProp3(_el$42, "wrapMode", "word");
        _$insertNode3(_el$43, _$createTextNode3(`The server verifies ownership and call liveness before releasing. Live calls from other sessions are never released.`));
        _$insertNode3(_el$45, _el$46);
        _$insertNode3(_el$45, _el$50);
        _$setProp3(_el$45, "flexDirection", "row");
        _$setProp3(_el$45, "gap", 2);
        _$insertNode3(_el$46, _el$47);
        _$setProp3(_el$46, "border", true);
        _$setProp3(_el$46, "paddingLeft", 1);
        _$setProp3(_el$46, "paddingRight", 1);
        _$insertNode3(_el$47, _el$48);
        _$setProp3(_el$47, "wrapMode", "none");
        _$insertNode3(_el$48, _$createTextNode3(`[y / Enter] Confirm release`));
        _$insertNode3(_el$50, _el$51);
        _$setProp3(_el$50, "border", true);
        _$setProp3(_el$50, "paddingLeft", 1);
        _$setProp3(_el$50, "paddingRight", 1);
        _$insertNode3(_el$51, _el$52);
        _$setProp3(_el$51, "wrapMode", "none");
        _$insertNode3(_el$52, _$createTextNode3(`[n / Esc] Cancel`));
        _$effect3((_p$) => {
          var { cyan: _v$0, inset: _v$1 } = PALETTE2, _v$10 = {
            fg: PALETTE2.cyan,
            bold: true
          }, _v$11 = {
            fg: PALETTE2.muted
          }, _v$12 = {
            fg: PALETTE2.ink,
            bold: true
          }, _v$13 = {
            fg: PALETTE2.muted
          }, _v$14 = {
            fg: PALETTE2.muted
          }, { cyan: _v$15, base: _v$16 } = PALETTE2, _v$17 = {
            fg: PALETTE2.cyan,
            bold: true
          }, { rule: _v$18, base: _v$19 } = PALETTE2, _v$20 = {
            fg: PALETTE2.muted
          };
          _v$0 !== _p$.e && (_p$.e = _$setProp3(_el$30, "borderColor", _v$0, _p$.e));
          _v$1 !== _p$.t && (_p$.t = _$setProp3(_el$30, "backgroundColor", _v$1, _p$.t));
          _v$10 !== _p$.a && (_p$.a = _$setProp3(_el$33, "style", _v$10, _p$.a));
          _v$11 !== _p$.o && (_p$.o = _$setProp3(_el$36, "style", _v$11, _p$.o));
          _v$12 !== _p$.i && (_p$.i = _$setProp3(_el$39, "style", _v$12, _p$.i));
          _v$13 !== _p$.n && (_p$.n = _$setProp3(_el$40, "style", _v$13, _p$.n));
          _v$14 !== _p$.s && (_p$.s = _$setProp3(_el$43, "style", _v$14, _p$.s));
          _v$15 !== _p$.h && (_p$.h = _$setProp3(_el$46, "borderColor", _v$15, _p$.h));
          _v$16 !== _p$.r && (_p$.r = _$setProp3(_el$46, "backgroundColor", _v$16, _p$.r));
          _v$17 !== _p$.d && (_p$.d = _$setProp3(_el$48, "style", _v$17, _p$.d));
          _v$18 !== _p$.l && (_p$.l = _$setProp3(_el$50, "borderColor", _v$18, _p$.l));
          _v$19 !== _p$.u && (_p$.u = _$setProp3(_el$50, "backgroundColor", _v$19, _p$.u));
          _v$20 !== _p$.c && (_p$.c = _$setProp3(_el$52, "style", _v$20, _p$.c));
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
        return _el$30;
      }
    }), null);
    _$insert3(_el$29, _$createComponent3(Show3, {
      get when() {
        return _$memo3(() => !!!pendingRelease())() && sendOpen();
      },
      get children() {
        var _el$54 = _$createElement3("box"), _el$55 = _$createElement3("box"), _el$56 = _$createElement3("text"), _el$57 = _$createElement3("span"), _el$58 = _$createElement3("span"), _el$59 = _$createTextNode3(` \u2192 `), _el$60 = _$createElement3("box"), _el$61 = _$createElement3("text"), _el$62 = _$createElement3("span"), _el$64 = _$createElement3("text"), _el$65 = _$createElement3("span"), _el$66 = _$createElement3("box"), _el$67 = _$createElement3("text"), _el$68 = _$createElement3("span"), _el$70 = _$createElement3("span"), _el$71 = _$createElement3("span"), _el$73 = _$createElement3("box"), _el$74 = _$createElement3("text"), _el$75 = _$createElement3("span"), _el$77 = _$createElement3("span"), _el$79 = _$createElement3("span"), _el$81 = _$createElement3("span"), _el$83 = _$createElement3("span");
        _$insertNode3(_el$54, _el$55);
        _$insertNode3(_el$54, _el$64);
        _$insertNode3(_el$54, _el$66);
        _$insertNode3(_el$54, _el$73);
        _$setProp3(_el$54, "flexDirection", "column");
        _$setProp3(_el$54, "border", true);
        _$setProp3(_el$54, "paddingLeft", 2);
        _$setProp3(_el$54, "paddingRight", 2);
        _$setProp3(_el$54, "paddingTop", 1);
        _$setProp3(_el$54, "paddingBottom", 1);
        _$setProp3(_el$54, "gap", 1);
        _$insertNode3(_el$55, _el$56);
        _$insertNode3(_el$55, _el$60);
        _$setProp3(_el$55, "flexDirection", "row");
        _$setProp3(_el$55, "justifyContent", "space-between");
        _$setProp3(_el$55, "height", 1);
        _$insertNode3(_el$56, _el$57);
        _$insertNode3(_el$56, _el$58);
        _$setProp3(_el$56, "wrapMode", "none");
        _$insert3(_el$57, () => tab() === "commands" ? "Send stdin" : "Send input");
        _$insertNode3(_el$58, _el$59);
        _$insert3(_el$58, (() => {
          var _c$ = _$memo3(() => tab() === "commands");
          return () => _c$() ? selectedCommand()?.title ?? "command" : selectedGoal()?.name ?? "worker";
        })(), null);
        _$insertNode3(_el$60, _el$61);
        _$setProp3(_el$60, "paddingLeft", 1);
        _$setProp3(_el$60, "paddingRight", 1);
        _$setProp3(_el$60, "height", 1);
        _$spread3(_el$60, _$mergeProps3({
          get backgroundColor() {
            return PALETTE2.base;
          }
        }, {
          onMouseDown: () => returnToNormalMode()
        }), true);
        _$insertNode3(_el$61, _el$62);
        _$setProp3(_el$61, "wrapMode", "none");
        _$insertNode3(_el$62, _$createTextNode3(`[esc]`));
        _$insertNode3(_el$64, _el$65);
        _$setProp3(_el$64, "wrapMode", "none");
        _$insert3(_el$65, () => tab() === "commands" ? "Writes a line to the selected process stdin:" : "Delivers bare words as the worker's own turn (no steering wrapper):");
        _$insertNode3(_el$66, _el$67);
        _$setProp3(_el$66, "flexDirection", "row");
        _$setProp3(_el$66, "border", true);
        _$setProp3(_el$66, "paddingLeft", 1);
        _$setProp3(_el$66, "paddingRight", 1);
        _$setProp3(_el$66, "height", 3);
        _$setProp3(_el$66, "alignItems", "center");
        _$insertNode3(_el$67, _el$68);
        _$insertNode3(_el$67, _el$70);
        _$insertNode3(_el$67, _el$71);
        _$setProp3(_el$67, "wrapMode", "word");
        _$insertNode3(_el$68, _$createTextNode3(`\u203A `));
        _$insert3(_el$70, () => commandInput() || "Give this worker a short directive\u2026");
        _$insertNode3(_el$71, _$createTextNode3(`\u2588`));
        _$insertNode3(_el$73, _el$74);
        _$setProp3(_el$73, "flexDirection", "row");
        _$setProp3(_el$73, "justifyContent", "space-between");
        _$setProp3(_el$73, "height", 1);
        _$insertNode3(_el$74, _el$75);
        _$insertNode3(_el$74, _el$77);
        _$insertNode3(_el$74, _el$79);
        _$insertNode3(_el$74, _el$81);
        _$insertNode3(_el$74, _el$83);
        _$setProp3(_el$74, "wrapMode", "none");
        _$insertNode3(_el$75, _$createTextNode3(`Press `));
        _$insertNode3(_el$77, _$createTextNode3(`Enter`));
        _$insertNode3(_el$79, _$createTextNode3(` to send \xB7 `));
        _$insertNode3(_el$81, _$createTextNode3(`Esc`));
        _$insertNode3(_el$83, _$createTextNode3(` to cancel`));
        _$effect3((_p$) => {
          var { cyan: _v$21, inset: _v$22 } = PALETTE2, _v$23 = {
            fg: PALETTE2.cyan,
            bold: true
          }, _v$24 = {
            fg: PALETTE2.muted
          }, _v$25 = {
            fg: PALETTE2.amber,
            bold: true
          }, _v$26 = {
            fg: PALETTE2.muted
          }, { amber: _v$27, base: _v$28 } = PALETTE2, _v$29 = {
            fg: PALETTE2.amber,
            bold: true
          }, _v$30 = {
            fg: commandInput() ? PALETTE2.ink : PALETTE2.muted
          }, _v$31 = {
            fg: PALETTE2.cyan,
            bold: true
          }, _v$32 = {
            fg: PALETTE2.muted
          }, _v$33 = {
            fg: PALETTE2.ink,
            bold: true
          }, _v$34 = {
            fg: PALETTE2.muted
          }, _v$35 = {
            fg: PALETTE2.ink,
            bold: true
          }, _v$36 = {
            fg: PALETTE2.muted
          };
          _v$21 !== _p$.e && (_p$.e = _$setProp3(_el$54, "borderColor", _v$21, _p$.e));
          _v$22 !== _p$.t && (_p$.t = _$setProp3(_el$54, "backgroundColor", _v$22, _p$.t));
          _v$23 !== _p$.a && (_p$.a = _$setProp3(_el$57, "style", _v$23, _p$.a));
          _v$24 !== _p$.o && (_p$.o = _$setProp3(_el$58, "style", _v$24, _p$.o));
          _v$25 !== _p$.i && (_p$.i = _$setProp3(_el$62, "style", _v$25, _p$.i));
          _v$26 !== _p$.n && (_p$.n = _$setProp3(_el$65, "style", _v$26, _p$.n));
          _v$27 !== _p$.s && (_p$.s = _$setProp3(_el$66, "borderColor", _v$27, _p$.s));
          _v$28 !== _p$.h && (_p$.h = _$setProp3(_el$66, "backgroundColor", _v$28, _p$.h));
          _v$29 !== _p$.r && (_p$.r = _$setProp3(_el$68, "style", _v$29, _p$.r));
          _v$30 !== _p$.d && (_p$.d = _$setProp3(_el$70, "style", _v$30, _p$.d));
          _v$31 !== _p$.l && (_p$.l = _$setProp3(_el$71, "style", _v$31, _p$.l));
          _v$32 !== _p$.u && (_p$.u = _$setProp3(_el$75, "style", _v$32, _p$.u));
          _v$33 !== _p$.c && (_p$.c = _$setProp3(_el$77, "style", _v$33, _p$.c));
          _v$34 !== _p$.w && (_p$.w = _$setProp3(_el$79, "style", _v$34, _p$.w));
          _v$35 !== _p$.m && (_p$.m = _$setProp3(_el$81, "style", _v$35, _p$.m));
          _v$36 !== _p$.f && (_p$.f = _$setProp3(_el$83, "style", _v$36, _p$.f));
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
          f: undefined
        });
        return _el$54;
      }
    }), null);
    _$insert3(_el$29, _$createComponent3(Show3, {
      get when() {
        return _$memo3(() => !!(!pendingRelease() && !sendOpen() && !actionsOpen()))() && coordOpen();
      },
      get children() {
        return _$createComponent3(CoordinationPanel, {
          get theme() {
            return theme();
          },
          get model() {
            return coordModel();
          },
          get tab() {
            return coordTab();
          },
          onTab: (t) => setCoordTab(t),
          onInspectReservations: () => void releaseWorkspaceFences({}, coordDir()),
          onRelease: (callID) => setPendingRelease({
            callID,
            dir: coordDir()
          }),
          onOpenSession: () => {
            const g = selectedGoal();
            if (g?.workerSessionID) {
              try {
                props.api.route.navigate("session", {
                  sessionID: g.workerSessionID
                });
                props.api.ui.dialog.clear();
              } catch {
                setStatusText("Navigate unsupported here.");
              }
            }
          },
          onClose: () => setCoordOpen(false),
          scrollRef: (el) => {
            coordScrollEl = el;
          }
        });
      }
    }), null);
    _$insert3(_el$29, _$createComponent3(Show3, {
      get when() {
        return _$memo3(() => !!(!pendingRelease() && !sendOpen() && !actionsOpen() && !coordOpen() && detailsOpen()))() && selectedGoal();
      },
      children: (goal) => {
        const entry = () => activeGoals().find((e) => e.goal.id === goal().id);
        const dir = () => entry()?.dir ?? props.directory;
        const rt = () => runtimeFor(goal().id);
        const lp = () => goal().lastProgress;
        const agentName = () => goal().config.agent;
        const meta = () => agentName() ? agentIndex()[agentName()] ?? agentIndex()[agentName().toLowerCase()] : undefined;
        const model = () => goal().config.model;
        return _$createComponent3(GoalDetailsDrawer, {
          get theme() {
            return theme();
          },
          scrollRef: (el) => {
            detailsScrollEl = el;
          },
          onClose: () => setDetailsOpen(false),
          get model() {
            return {
              goal: goal(),
              directory: dir(),
              runtime: rt(),
              transcript: recentTranscriptFor(goal().id),
              progressHistory: lp() ? [{
                summary: lp().summary,
                next: lp().next,
                at: lp().at
              }] : [],
              agentLabel: agentName() ? `${agentName()}${meta()?.mode ? ` (${meta().mode})` : ""}` : goal().parentAgent ?? "parent",
              modelLabel: model() ?? goal().parentModel ?? "parent"
            };
          }
        });
      }
    }), null);
    _$insert3(_el$29, _$createComponent3(Show3, {
      get when() {
        return _$memo3(() => !!(!pendingRelease() && !sendOpen() && !actionsOpen() && !coordOpen() && !detailsOpen()))() && showHelp();
      },
      get children() {
        var _el$85 = _$createElement3("box"), _el$86 = _$createElement3("box"), _el$87 = _$createElement3("text"), _el$88 = _$createElement3("span"), _el$90 = _$createElement3("box"), _el$91 = _$createElement3("text"), _el$92 = _$createElement3("span"), _el$94 = _$createElement3("box"), _el$95 = _$createElement3("text"), _el$96 = _$createElement3("span"), _el$98 = _$createElement3("span"), _el$100 = _$createTextNode3(`
`), _el$101 = _$createElement3("span"), _el$103 = _$createElement3("span"), _el$105 = _$createTextNode3(`
`), _el$106 = _$createElement3("span"), _el$108 = _$createElement3("span"), _el$110 = _$createTextNode3(`
`), _el$111 = _$createElement3("span"), _el$113 = _$createElement3("span"), _el$115 = _$createTextNode3(`
`), _el$116 = _$createElement3("span"), _el$118 = _$createElement3("span"), _el$120 = _$createTextNode3(`
`), _el$121 = _$createElement3("span"), _el$123 = _$createElement3("span"), _el$125 = _$createTextNode3(`
`), _el$126 = _$createElement3("span"), _el$128 = _$createElement3("span"), _el$130 = _$createTextNode3(`
`), _el$131 = _$createElement3("span"), _el$133 = _$createElement3("span"), _el$135 = _$createTextNode3(`
`), _el$136 = _$createElement3("span"), _el$138 = _$createElement3("span"), _el$140 = _$createTextNode3(`
`), _el$141 = _$createElement3("span"), _el$143 = _$createElement3("span"), _el$145 = _$createTextNode3(`
`), _el$146 = _$createElement3("span"), _el$148 = _$createElement3("span"), _el$150 = _$createTextNode3(`
`), _el$151 = _$createElement3("span"), _el$153 = _$createElement3("span");
        _$insertNode3(_el$85, _el$86);
        _$insertNode3(_el$85, _el$94);
        _$setProp3(_el$85, "flexDirection", "column");
        _$setProp3(_el$85, "border", true);
        _$setProp3(_el$85, "paddingLeft", 2);
        _$setProp3(_el$85, "paddingRight", 2);
        _$setProp3(_el$85, "paddingTop", 1);
        _$setProp3(_el$85, "paddingBottom", 1);
        _$setProp3(_el$85, "gap", 1);
        _$insertNode3(_el$86, _el$87);
        _$insertNode3(_el$86, _el$90);
        _$setProp3(_el$86, "flexDirection", "row");
        _$setProp3(_el$86, "justifyContent", "space-between");
        _$setProp3(_el$86, "height", 1);
        _$insertNode3(_el$87, _el$88);
        _$setProp3(_el$87, "wrapMode", "none");
        _$insertNode3(_el$88, _$createTextNode3(`Keyboard shortcuts`));
        _$insertNode3(_el$90, _el$91);
        _$setProp3(_el$90, "paddingLeft", 1);
        _$setProp3(_el$90, "paddingRight", 1);
        _$setProp3(_el$90, "height", 1);
        _$spread3(_el$90, _$mergeProps3({
          get backgroundColor() {
            return PALETTE2.base;
          }
        }, {
          onMouseDown: () => setShowHelp(false)
        }), true);
        _$insertNode3(_el$91, _el$92);
        _$setProp3(_el$91, "wrapMode", "none");
        _$insertNode3(_el$92, _$createTextNode3(`[esc]`));
        _$insertNode3(_el$94, _el$95);
        _$setProp3(_el$94, "border", true);
        _$setProp3(_el$94, "paddingLeft", 1);
        _$setProp3(_el$94, "paddingRight", 1);
        _$insertNode3(_el$95, _el$96);
        _$insertNode3(_el$95, _el$98);
        _$insertNode3(_el$95, _el$100);
        _$insertNode3(_el$95, _el$101);
        _$insertNode3(_el$95, _el$103);
        _$insertNode3(_el$95, _el$105);
        _$insertNode3(_el$95, _el$106);
        _$insertNode3(_el$95, _el$108);
        _$insertNode3(_el$95, _el$110);
        _$insertNode3(_el$95, _el$111);
        _$insertNode3(_el$95, _el$113);
        _$insertNode3(_el$95, _el$115);
        _$insertNode3(_el$95, _el$116);
        _$insertNode3(_el$95, _el$118);
        _$insertNode3(_el$95, _el$120);
        _$insertNode3(_el$95, _el$121);
        _$insertNode3(_el$95, _el$123);
        _$insertNode3(_el$95, _el$125);
        _$insertNode3(_el$95, _el$126);
        _$insertNode3(_el$95, _el$128);
        _$insertNode3(_el$95, _el$130);
        _$insertNode3(_el$95, _el$131);
        _$insertNode3(_el$95, _el$133);
        _$insertNode3(_el$95, _el$135);
        _$insertNode3(_el$95, _el$136);
        _$insertNode3(_el$95, _el$138);
        _$insertNode3(_el$95, _el$140);
        _$insertNode3(_el$95, _el$141);
        _$insertNode3(_el$95, _el$143);
        _$insertNode3(_el$95, _el$145);
        _$insertNode3(_el$95, _el$146);
        _$insertNode3(_el$95, _el$148);
        _$insertNode3(_el$95, _el$150);
        _$insertNode3(_el$95, _el$151);
        _$insertNode3(_el$95, _el$153);
        _$setProp3(_el$95, "wrapMode", "none");
        _$insertNode3(_el$96, _$createTextNode3(`1 / 2 / 3 `));
        _$insertNode3(_el$98, _$createTextNode3(`Project / Fleet / Commands tabs`));
        _$insertNode3(_el$101, _$createTextNode3(`j / k `));
        _$insertNode3(_el$103, _$createTextNode3(`Move selection (or scroll inside Details / Coordination)`));
        _$insertNode3(_el$106, _$createTextNode3(`Enter `));
        _$insertNode3(_el$108, _$createTextNode3(`Worker actions popup`));
        _$insertNode3(_el$111, _$createTextNode3(`s `));
        _$insertNode3(_el$113, _$createTextNode3(`Send input popup`));
        _$insertNode3(_el$116, _$createTextNode3(`o `));
        _$insertNode3(_el$118, _$createTextNode3(`Open worker session / fullscreen command`));
        _$insertNode3(_el$121, _$createTextNode3(`d `));
        _$insertNode3(_el$123, _$createTextNode3(`Technical details popup (j/k scrolls, n/p switches worker)`));
        _$insertNode3(_el$126, _$createTextNode3(`t `));
        _$insertNode3(_el$128, _$createTextNode3(`Project coordination popup (j/k scrolls, w/v/r switches tab)`));
        _$insertNode3(_el$131, _$createTextNode3(`/ `));
        _$insertNode3(_el$133, _$createTextNode3(`Focus filter box in toolbar`));
        _$insertNode3(_el$136, _$createTextNode3(`h `));
        _$insertNode3(_el$138, _$createTextNode3(`Show or hide completed history`));
        _$insertNode3(_el$141, _$createTextNode3(`P `));
        _$insertNode3(_el$143, _$createTextNode3(`Pick project scope (j/k + Enter)`));
        _$insertNode3(_el$146, _$createTextNode3(`[ / ] `));
        _$insertNode3(_el$148, _$createTextNode3(`Cycle project scope`));
        _$insertNode3(_el$151, _$createTextNode3(`Esc `));
        _$insertNode3(_el$153, _$createTextNode3(`Close active popup / filter, or close dashboard`));
        _$effect3((_p$) => {
          var { cyan: _v$37, inset: _v$38 } = PALETTE2, _v$39 = {
            fg: PALETTE2.cyan,
            bold: true
          }, _v$40 = {
            fg: PALETTE2.amber,
            bold: true
          }, { rule: _v$41, base: _v$42 } = PALETTE2, _v$43 = {
            fg: PALETTE2.muted
          }, _v$44 = {
            fg: PALETTE2.ink
          }, _v$45 = {
            fg: PALETTE2.muted
          }, _v$46 = {
            fg: PALETTE2.ink
          }, _v$47 = {
            fg: PALETTE2.amber
          }, _v$48 = {
            fg: PALETTE2.ink
          }, _v$49 = {
            fg: PALETTE2.sage
          }, _v$50 = {
            fg: PALETTE2.ink
          }, _v$51 = {
            fg: PALETTE2.sky
          }, _v$52 = {
            fg: PALETTE2.ink
          }, _v$53 = {
            fg: PALETTE2.violet
          }, _v$54 = {
            fg: PALETTE2.ink
          }, _v$55 = {
            fg: PALETTE2.cyan
          }, _v$56 = {
            fg: PALETTE2.ink
          }, _v$57 = {
            fg: PALETTE2.muted
          }, _v$58 = {
            fg: PALETTE2.ink
          }, _v$59 = {
            fg: PALETTE2.muted
          }, _v$60 = {
            fg: PALETTE2.ink
          }, _v$61 = {
            fg: PALETTE2.violet
          }, _v$62 = {
            fg: PALETTE2.ink
          }, _v$63 = {
            fg: PALETTE2.muted
          }, _v$64 = {
            fg: PALETTE2.ink
          }, _v$65 = {
            fg: PALETTE2.amber
          }, _v$66 = {
            fg: PALETTE2.ink
          };
          _v$37 !== _p$.e && (_p$.e = _$setProp3(_el$85, "borderColor", _v$37, _p$.e));
          _v$38 !== _p$.t && (_p$.t = _$setProp3(_el$85, "backgroundColor", _v$38, _p$.t));
          _v$39 !== _p$.a && (_p$.a = _$setProp3(_el$88, "style", _v$39, _p$.a));
          _v$40 !== _p$.o && (_p$.o = _$setProp3(_el$92, "style", _v$40, _p$.o));
          _v$41 !== _p$.i && (_p$.i = _$setProp3(_el$94, "borderColor", _v$41, _p$.i));
          _v$42 !== _p$.n && (_p$.n = _$setProp3(_el$94, "backgroundColor", _v$42, _p$.n));
          _v$43 !== _p$.s && (_p$.s = _$setProp3(_el$96, "style", _v$43, _p$.s));
          _v$44 !== _p$.h && (_p$.h = _$setProp3(_el$98, "style", _v$44, _p$.h));
          _v$45 !== _p$.r && (_p$.r = _$setProp3(_el$101, "style", _v$45, _p$.r));
          _v$46 !== _p$.d && (_p$.d = _$setProp3(_el$103, "style", _v$46, _p$.d));
          _v$47 !== _p$.l && (_p$.l = _$setProp3(_el$106, "style", _v$47, _p$.l));
          _v$48 !== _p$.u && (_p$.u = _$setProp3(_el$108, "style", _v$48, _p$.u));
          _v$49 !== _p$.c && (_p$.c = _$setProp3(_el$111, "style", _v$49, _p$.c));
          _v$50 !== _p$.w && (_p$.w = _$setProp3(_el$113, "style", _v$50, _p$.w));
          _v$51 !== _p$.m && (_p$.m = _$setProp3(_el$116, "style", _v$51, _p$.m));
          _v$52 !== _p$.f && (_p$.f = _$setProp3(_el$118, "style", _v$52, _p$.f));
          _v$53 !== _p$.y && (_p$.y = _$setProp3(_el$121, "style", _v$53, _p$.y));
          _v$54 !== _p$.g && (_p$.g = _$setProp3(_el$123, "style", _v$54, _p$.g));
          _v$55 !== _p$.p && (_p$.p = _$setProp3(_el$126, "style", _v$55, _p$.p));
          _v$56 !== _p$.b && (_p$.b = _$setProp3(_el$128, "style", _v$56, _p$.b));
          _v$57 !== _p$.T && (_p$.T = _$setProp3(_el$131, "style", _v$57, _p$.T));
          _v$58 !== _p$.A && (_p$.A = _$setProp3(_el$133, "style", _v$58, _p$.A));
          _v$59 !== _p$.O && (_p$.O = _$setProp3(_el$136, "style", _v$59, _p$.O));
          _v$60 !== _p$.I && (_p$.I = _$setProp3(_el$138, "style", _v$60, _p$.I));
          _v$61 !== _p$.S && (_p$.S = _$setProp3(_el$141, "style", _v$61, _p$.S));
          _v$62 !== _p$.W && (_p$.W = _$setProp3(_el$143, "style", _v$62, _p$.W));
          _v$63 !== _p$.C && (_p$.C = _$setProp3(_el$146, "style", _v$63, _p$.C));
          _v$64 !== _p$.B && (_p$.B = _$setProp3(_el$148, "style", _v$64, _p$.B));
          _v$65 !== _p$.v && (_p$.v = _$setProp3(_el$151, "style", _v$65, _p$.v));
          _v$66 !== _p$.k && (_p$.k = _$setProp3(_el$153, "style", _v$66, _p$.k));
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
          I: undefined,
          S: undefined,
          W: undefined,
          C: undefined,
          B: undefined,
          v: undefined,
          k: undefined
        });
        return _el$85;
      }
    }), null);
    _$insert3(_el$29, _$createComponent3(Show3, {
      get when() {
        return !modalPopupOpen();
      },
      get children() {
        return [(() => {
          var _el$155 = _$createElement3("box"), _el$156 = _$createElement3("text");
          _$insertNode3(_el$155, _el$156);
          _$setProp3(_el$155, "flexDirection", "row");
          _$setProp3(_el$155, "justifyContent", "space-between");
          _$setProp3(_el$155, "alignItems", "center");
          _$setProp3(_el$155, "height", 1);
          _$setProp3(_el$155, "flexShrink", 0);
          _$setProp3(_el$156, "wrapMode", "none");
          _$insert3(_el$156, _$createComponent3(Show3, {
            get when() {
              return tab() !== "commands";
            },
            get fallback() {
              return (() => {
                var _el$235 = _$createElement3("span"), _el$236 = _$createTextNode3(`Raw processes / independent from worker lifecycle \xB7 `), _el$237 = _$createElement3("span");
                _$insertNode3(_el$235, _el$236);
                _$insertNode3(_el$235, _el$237);
                _$insert3(_el$237, scopeSummaryText);
                _$effect3((_p$) => {
                  var _v$91 = {
                    fg: PALETTE2.muted
                  }, _v$92 = {
                    fg: PALETTE2.amber
                  };
                  _v$91 !== _p$.e && (_p$.e = _$setProp3(_el$235, "style", _v$91, _p$.e));
                  _v$92 !== _p$.t && (_p$.t = _$setProp3(_el$237, "style", _v$92, _p$.t));
                  return _p$;
                }, {
                  e: undefined,
                  t: undefined
                });
                return _el$235;
              })();
            },
            get children() {
              return [(() => {
                var _el$157 = _$createElement3("span");
                _$insert3(_el$157, () => scopeSummaryCounts().needsAction);
                _$effect3((_$p) => _$setProp3(_el$157, "style", {
                  fg: PALETTE2.amber,
                  bold: true
                }, _$p));
                return _el$157;
              })(), (() => {
                var _el$158 = _$createElement3("span");
                _$insertNode3(_el$158, _$createTextNode3(` needs action \xB7 `));
                _$effect3((_$p) => _$setProp3(_el$158, "style", {
                  fg: PALETTE2.muted
                }, _$p));
                return _el$158;
              })(), (() => {
                var _el$160 = _$createElement3("span");
                _$insert3(_el$160, () => scopeSummaryCounts().working);
                _$effect3((_$p) => _$setProp3(_el$160, "style", {
                  fg: PALETTE2.amber,
                  bold: true
                }, _$p));
                return _el$160;
              })(), (() => {
                var _el$161 = _$createElement3("span");
                _$insertNode3(_el$161, _$createTextNode3(` working \xB7 `));
                _$effect3((_$p) => _$setProp3(_el$161, "style", {
                  fg: PALETTE2.muted
                }, _$p));
                return _el$161;
              })(), (() => {
                var _el$163 = _$createElement3("span");
                _$insert3(_el$163, () => scopeSummaryCounts().awaiting);
                _$effect3((_$p) => _$setProp3(_el$163, "style", {
                  fg: PALETTE2.amber,
                  bold: true
                }, _$p));
                return _el$163;
              })(), (() => {
                var _el$164 = _$createElement3("span");
                _$insertNode3(_el$164, _$createTextNode3(` awaiting input`));
                _$effect3((_$p) => _$setProp3(_el$164, "style", {
                  fg: PALETTE2.muted
                }, _$p));
                return _el$164;
              })(), _$createComponent3(Show3, {
                get when() {
                  return scopeSummaryCounts().paused > 0;
                },
                get children() {
                  return [(() => {
                    var _el$166 = _$createElement3("span");
                    _$insertNode3(_el$166, _$createTextNode3(` \xB7 `));
                    _$effect3((_$p) => _$setProp3(_el$166, "style", {
                      fg: PALETTE2.muted
                    }, _$p));
                    return _el$166;
                  })(), (() => {
                    var _el$168 = _$createElement3("span");
                    _$insert3(_el$168, () => scopeSummaryCounts().paused);
                    _$effect3((_$p) => _$setProp3(_el$168, "style", {
                      fg: PALETTE2.amber,
                      bold: true
                    }, _$p));
                    return _el$168;
                  })(), (() => {
                    var _el$169 = _$createElement3("span");
                    _$insertNode3(_el$169, _$createTextNode3(` paused`));
                    _$effect3((_$p) => _$setProp3(_el$169, "style", {
                      fg: PALETTE2.muted
                    }, _$p));
                    return _el$169;
                  })()];
                }
              }), _$createComponent3(Show3, {
                get when() {
                  return detailsOpen();
                },
                get children() {
                  var _el$171 = _$createElement3("span");
                  _$insertNode3(_el$171, _$createTextNode3(` \xB7 detail open (1 row)`));
                  _$effect3((_$p) => _$setProp3(_el$171, "style", {
                    fg: PALETTE2.muted
                  }, _$p));
                  return _el$171;
                }
              })];
            }
          }));
          _$insert3(_el$155, _$createComponent3(Show3, {
            get when() {
              return statusText();
            },
            get children() {
              var _el$173 = _$createElement3("text"), _el$174 = _$createElement3("span");
              _$insertNode3(_el$173, _el$174);
              _$setProp3(_el$173, "wrapMode", "none");
              _$insert3(_el$174, () => statusText().slice(0, 48));
              _$effect3((_$p) => _$setProp3(_el$174, "style", {
                fg: PALETTE2.cyan
              }, _$p));
              return _el$173;
            }
          }), null);
          return _el$155;
        })(), (() => {
          var _el$175 = _$createElement3("box"), _el$176 = _$createElement3("box"), _el$184 = _$createElement3("box"), _el$185 = _$createElement3("text"), _el$191 = _$createElement3("box"), _el$192 = _$createElement3("text"), _el$193 = _$createElement3("span"), _el$194 = _$createTextNode3(` history [h]`);
          _$insertNode3(_el$175, _el$176);
          _$insertNode3(_el$175, _el$191);
          _$setProp3(_el$175, "flexDirection", "row");
          _$setProp3(_el$175, "justifyContent", "space-between");
          _$setProp3(_el$175, "alignItems", "center");
          _$setProp3(_el$175, "height", 3);
          _$setProp3(_el$175, "flexShrink", 0);
          _$setProp3(_el$175, "gap", 1);
          _$insertNode3(_el$176, _el$184);
          _$setProp3(_el$176, "flexDirection", "row");
          _$setProp3(_el$176, "gap", 1);
          _$setProp3(_el$176, "alignItems", "center");
          _$insert3(_el$176, _$createComponent3(Show3, {
            get when() {
              return tab() !== "fleet";
            },
            get children() {
              var _el$177 = _$createElement3("box"), _el$178 = _$createElement3("box"), _el$179 = _$createElement3("text"), _el$180 = _$createElement3("span"), _el$181 = _$createElement3("span");
              _$insertNode3(_el$177, _el$178);
              _$use3((el) => {
                projectAnchor = el;
              }, _el$177);
              _$setProp3(_el$177, "position", "relative");
              _$setProp3(_el$177, "maxWidth", "100%");
              _$setProp3(_el$177, "renderAfter", updateProjectBounds);
              _$insertNode3(_el$178, _el$179);
              _$setProp3(_el$178, "flexDirection", "row");
              _$setProp3(_el$178, "border", true);
              _$setProp3(_el$178, "paddingLeft", 1);
              _$setProp3(_el$178, "paddingRight", 1);
              _$spread3(_el$178, _$mergeProps3({
                get borderColor() {
                  return PALETTE2.rule;
                },
                get backgroundColor() {
                  return PALETTE2.inset;
                }
              }, {
                onMouseDown: () => showProjects() ? closeProjectsPicker() : openProjectsPicker()
              }), true);
              _$insertNode3(_el$179, _el$180);
              _$insertNode3(_el$179, _el$181);
              _$setProp3(_el$179, "wrapMode", "none");
              _$insert3(_el$180, () => projectLabel(projectCurrentScope()));
              _$insertNode3(_el$181, _$createTextNode3(` \u25BE [P]`));
              _$insert3(_el$177, _$createComponent3(Show3, {
                get when() {
                  return showProjects();
                },
                get children() {
                  var _el$183 = _$createElement3("box");
                  _$setProp3(_el$183, "position", "absolute");
                  _$setProp3(_el$183, "left", 0);
                  _$setProp3(_el$183, "zIndex", 1);
                  _$setProp3(_el$183, "flexDirection", "column");
                  _$setProp3(_el$183, "border", true);
                  _$setProp3(_el$183, "onMouseDown", (event) => event.stopPropagation());
                  _$insert3(_el$183, _$createComponent3(DashboardList, {
                    get count() {
                      return projectOptions().length;
                    },
                    get maxRows() {
                      return projectBounds().rows;
                    },
                    get selectedID() {
                      return `loopd-project-option-${projectIdx()}`;
                    },
                    get children() {
                      return _$createComponent3(For3, {
                        get each() {
                          return projectOptions();
                        },
                        children: (dir, i) => {
                          const highlighted = () => i() === projectIdx();
                          return _$createComponent3(DashboardRow, {
                            get id() {
                              return `loopd-project-option-${i()}`;
                            },
                            get backgroundColor() {
                              return _$memo3(() => !!highlighted())() ? PALETTE2.selectedBg : undefined;
                            },
                            onClick: () => applyProjectChoice(dir),
                            get children() {
                              return [(() => {
                                var _el$238 = _$createElement3("span");
                                _$insert3(_el$238, () => dir === projectCurrentScope() ? "\u2713 " : "  ");
                                _$effect3((_$p) => _$setProp3(_el$238, "style", {
                                  fg: highlighted() ? PALETTE2.cyan : PALETTE2.muted
                                }, _$p));
                                return _el$238;
                              })(), (() => {
                                var _el$239 = _$createElement3("span");
                                _$insert3(_el$239, () => projectLabel(dir).slice(0, Math.max(1, projectBounds().width - 6)));
                                _$effect3((_$p) => _$setProp3(_el$239, "style", {
                                  fg: highlighted() ? PALETTE2.cyan : PALETTE2.ink,
                                  bold: highlighted()
                                }, _$p));
                                return _el$239;
                              })()];
                            }
                          });
                        }
                      });
                    }
                  }));
                  _$effect3((_p$) => {
                    var _v$67 = projectBounds().top, _v$68 = projectBounds().width, _v$69 = Math.min(projectOptions().length, projectBounds().rows) + 2, _v$70 = theme().borderActive, _v$71 = theme().backgroundMenu;
                    _v$67 !== _p$.e && (_p$.e = _$setProp3(_el$183, "top", _v$67, _p$.e));
                    _v$68 !== _p$.t && (_p$.t = _$setProp3(_el$183, "width", _v$68, _p$.t));
                    _v$69 !== _p$.a && (_p$.a = _$setProp3(_el$183, "height", _v$69, _p$.a));
                    _v$70 !== _p$.o && (_p$.o = _$setProp3(_el$183, "borderColor", _v$70, _p$.o));
                    _v$71 !== _p$.i && (_p$.i = _$setProp3(_el$183, "backgroundColor", _v$71, _p$.i));
                    return _p$;
                  }, {
                    e: undefined,
                    t: undefined,
                    a: undefined,
                    o: undefined,
                    i: undefined
                  });
                  return _el$183;
                }
              }), null);
              _$effect3((_p$) => {
                var _v$72 = {
                  fg: PALETTE2.ink
                }, _v$73 = {
                  fg: PALETTE2.muted
                };
                _v$72 !== _p$.e && (_p$.e = _$setProp3(_el$180, "style", _v$72, _p$.e));
                _v$73 !== _p$.t && (_p$.t = _$setProp3(_el$181, "style", _v$73, _p$.t));
                return _p$;
              }, {
                e: undefined,
                t: undefined
              });
              return _el$177;
            }
          }), _el$184);
          _$insertNode3(_el$184, _el$185);
          _$setProp3(_el$184, "flexDirection", "row");
          _$setProp3(_el$184, "border", true);
          _$setProp3(_el$184, "paddingLeft", 1);
          _$setProp3(_el$184, "paddingRight", 1);
          _$setProp3(_el$184, "width", 38);
          _$spread3(_el$184, _$mergeProps3({
            get borderColor() {
              return _$memo3(() => !!(mode() === "insert" && insertKind() === "filter"))() ? PALETTE2.amber : _$memo3(() => !!activeFilterQuery())() ? PALETTE2.cyan : PALETTE2.rule;
            },
            get backgroundColor() {
              return PALETTE2.inset;
            }
          }, {
            onMouseDown: () => openFilterBox()
          }), true);
          _$setProp3(_el$185, "wrapMode", "none");
          _$insert3(_el$185, _$createComponent3(Show3, {
            get when() {
              return _$memo3(() => mode() === "insert")() && insertKind() === "filter";
            },
            get fallback() {
              return _$memo3(() => !!activeFilterQuery())() ? [(() => {
                var _el$240 = _$createElement3("span");
                _$insertNode3(_el$240, _$createTextNode3(`/ `));
                _$effect3((_$p) => _$setProp3(_el$240, "style", {
                  fg: PALETTE2.cyan
                }, _$p));
                return _el$240;
              })(), (() => {
                var _el$242 = _$createElement3("span");
                _$insert3(_el$242, () => activeFilterQuery().slice(0, 26));
                _$effect3((_$p) => _$setProp3(_el$242, "style", {
                  fg: PALETTE2.ink
                }, _$p));
                return _el$242;
              })(), (() => {
                var _el$243 = _$createElement3("span");
                _$insertNode3(_el$243, _$createTextNode3(` (Esc clear)`));
                _$effect3((_$p) => _$setProp3(_el$243, "style", {
                  fg: PALETTE2.muted
                }, _$p));
                return _el$243;
              })()] : (() => {
                var _el$245 = _$createElement3("span");
                _$insertNode3(_el$245, _$createTextNode3(`/ filter workers or commands`));
                _$effect3((_$p) => _$setProp3(_el$245, "style", {
                  fg: PALETTE2.muted
                }, _$p));
                return _el$245;
              })();
            },
            get children() {
              return [(() => {
                var _el$186 = _$createElement3("span");
                _$insertNode3(_el$186, _$createTextNode3(`/ `));
                _$effect3((_$p) => _$setProp3(_el$186, "style", {
                  fg: PALETTE2.amber,
                  bold: true
                }, _$p));
                return _el$186;
              })(), (() => {
                var _el$188 = _$createElement3("span");
                _$insert3(_el$188, commandInput);
                _$effect3((_$p) => _$setProp3(_el$188, "style", {
                  fg: PALETTE2.ink
                }, _$p));
                return _el$188;
              })(), (() => {
                var _el$189 = _$createElement3("span");
                _$insertNode3(_el$189, _$createTextNode3(`\u2588`));
                _$effect3((_$p) => _$setProp3(_el$189, "style", {
                  fg: PALETTE2.cyan,
                  bold: true
                }, _$p));
                return _el$189;
              })()];
            }
          }));
          _$insertNode3(_el$191, _el$192);
          _$setProp3(_el$191, "flexDirection", "row");
          _$setProp3(_el$191, "border", true);
          _$setProp3(_el$191, "paddingLeft", 1);
          _$setProp3(_el$191, "paddingRight", 1);
          _$spread3(_el$191, _$mergeProps3({
            get borderColor() {
              return _$memo3(() => !!showCompleted())() ? PALETTE2.cyan : PALETTE2.rule;
            },
            get backgroundColor() {
              return PALETTE2.inset;
            }
          }, {
            onMouseDown: () => setShowCompleted((v) => !v)
          }), true);
          _$insertNode3(_el$192, _el$193);
          _$setProp3(_el$192, "wrapMode", "none");
          _$insertNode3(_el$193, _el$194);
          _$insert3(_el$193, () => showCompleted() ? "[\u2713]" : "[ ]", _el$194);
          _$effect3((_p$) => {
            var _v$74 = showProjects() ? 10 : 0, _v$75 = {
              fg: showCompleted() ? PALETTE2.cyan : PALETTE2.muted
            };
            _v$74 !== _p$.e && (_p$.e = _$setProp3(_el$175, "zIndex", _v$74, _p$.e));
            _v$75 !== _p$.t && (_p$.t = _$setProp3(_el$193, "style", _v$75, _p$.t));
            return _p$;
          }, {
            e: undefined,
            t: undefined
          });
          return _el$175;
        })(), _$createComponent3(Show3, {
          get when() {
            return tab() === "project" || tab() === "fleet";
          },
          get children() {
            return [_$createComponent3(Show3, {
              get when() {
                return rowModels().length > 0;
              },
              get fallback() {
                return (() => {
                  var _el$247 = _$createElement3("box"), _el$248 = _$createElement3("text"), _el$249 = _$createElement3("span"), _el$250 = _$createTextNode3(`No matching workers`), _el$251 = _$createTextNode3(`. Use /goal in chat to start one, or press [h] to toggle history.`);
                  _$insertNode3(_el$247, _el$248);
                  _$setProp3(_el$247, "border", true);
                  _$setProp3(_el$247, "paddingLeft", 2);
                  _$setProp3(_el$247, "paddingRight", 2);
                  _$setProp3(_el$247, "paddingTop", 1);
                  _$setProp3(_el$247, "paddingBottom", 1);
                  _$insertNode3(_el$248, _el$249);
                  _$setProp3(_el$248, "wrapMode", "none");
                  _$insertNode3(_el$249, _el$250);
                  _$insertNode3(_el$249, _el$251);
                  _$insert3(_el$249, (() => {
                    var _c$2 = _$memo3(() => !!activeFilterQuery());
                    return () => _c$2() ? ` for "${activeFilterQuery()}"` : "";
                  })(), _el$251);
                  _$effect3((_p$) => {
                    var { rule: _v$93, inset: _v$94 } = PALETTE2, _v$95 = {
                      fg: PALETTE2.muted
                    };
                    _v$93 !== _p$.e && (_p$.e = _$setProp3(_el$247, "borderColor", _v$93, _p$.e));
                    _v$94 !== _p$.t && (_p$.t = _$setProp3(_el$247, "backgroundColor", _v$94, _p$.t));
                    _v$95 !== _p$.a && (_p$.a = _$setProp3(_el$249, "style", _v$95, _p$.a));
                    return _p$;
                  }, {
                    e: undefined,
                    t: undefined,
                    a: undefined
                  });
                  return _el$247;
                })();
              },
              get children() {
                var _el$195 = _$createElement3("box"), _el$196 = _$createElement3("box"), _el$197 = _$createElement3("text"), _el$198 = _$createElement3("span"), _el$199 = _$createTextNode3(`  `), _el$200 = _$createTextNode3(`  `), _el$201 = _$createTextNode3(`  `), _el$202 = _$createTextNode3(`  Updated`), _el$204 = _$createElement3("box"), _el$205 = _$createElement3("text"), _el$206 = _$createElement3("span");
                _$insertNode3(_el$195, _el$196);
                _$insertNode3(_el$195, _el$204);
                _$setProp3(_el$195, "flexDirection", "column");
                _$setProp3(_el$195, "flexShrink", 0);
                _$insertNode3(_el$196, _el$197);
                _$setProp3(_el$196, "flexDirection", "row");
                _$setProp3(_el$196, "paddingLeft", 1);
                _$setProp3(_el$196, "paddingRight", 1);
                _$setProp3(_el$196, "height", 1);
                _$setProp3(_el$196, "flexShrink", 0);
                _$insertNode3(_el$197, _el$198);
                _$setProp3(_el$197, "wrapMode", "none");
                _$insertNode3(_el$198, _el$199);
                _$insertNode3(_el$198, _el$200);
                _$insertNode3(_el$198, _el$201);
                _$insertNode3(_el$198, _el$202);
                _$insert3(_el$198, () => "Worker".padEnd(ROW_COLS.name), _el$200);
                _$insert3(_el$198, () => "State".padEnd(ROW_COLS.state), _el$201);
                _$insert3(_el$198, () => "Current activity".padEnd(ROW_COLS.activity), _el$202);
                _$insertNode3(_el$204, _el$205);
                _$setProp3(_el$204, "flexDirection", "row");
                _$setProp3(_el$204, "paddingLeft", 1);
                _$setProp3(_el$204, "paddingRight", 1);
                _$setProp3(_el$204, "height", 1);
                _$setProp3(_el$204, "flexShrink", 0);
                _$insertNode3(_el$205, _el$206);
                _$setProp3(_el$205, "wrapMode", "none");
                _$insert3(_el$206, () => "\u2500".repeat(2 + ROW_COLS.name + 2 + ROW_COLS.state + 2 + ROW_COLS.activity + 2 + ROW_COLS.updated));
                _$insert3(_el$195, _$createComponent3(DashboardList, {
                  get count() {
                    return displayItems().length;
                  },
                  maxRows: 6,
                  get selectedID() {
                    return _$memo3(() => !!rowModels()[selected()])() ? rowIdFor(rowModels()[selected()].id) : undefined;
                  },
                  get children() {
                    return _$createComponent3(For3, {
                      get each() {
                        return displayItems();
                      },
                      children: (item) => {
                        if (item.kind === "header") {
                          const g = item.group;
                          return _$createComponent3(DashboardRow, {
                            get id() {
                              return `loopd-group-${g.directory}`;
                            },
                            get backgroundColor() {
                              return PALETTE2.inset;
                            },
                            onClick: () => setCollapsed((list) => toggleCollapsed(list, g.directory)),
                            get children() {
                              return [(() => {
                                var _el$252 = _$createElement3("span"), _el$253 = _$createTextNode3(` `);
                                _$insertNode3(_el$252, _el$253);
                                _$insert3(_el$252, () => collapsed().includes(g.directory) ? "\u25B8" : "\u25BE", _el$253);
                                _$insert3(_el$252, () => g.shortName, null);
                                _$effect3((_$p) => _$setProp3(_el$252, "style", {
                                  fg: PALETTE2.cyan,
                                  bold: true
                                }, _$p));
                                return _el$252;
                              })(), (() => {
                                var _el$254 = _$createElement3("span"), _el$255 = _$createTextNode3(` / `), _el$256 = _$createTextNode3(` \xB7 `), _el$257 = _$createTextNode3(` working`);
                                _$insertNode3(_el$254, _el$255);
                                _$insertNode3(_el$254, _el$256);
                                _$insertNode3(_el$254, _el$257);
                                _$insert3(_el$254, (() => {
                                  var _c$3 = _$memo3(() => g.needsAction > 0);
                                  return () => _c$3() ? `${g.needsAction} needs action` : "No intervention needed";
                                })(), _el$256);
                                _$insert3(_el$254, () => g.working, _el$257);
                                _$effect3((_$p) => _$setProp3(_el$254, "style", {
                                  fg: PALETTE2.muted
                                }, _$p));
                                return _el$254;
                              })()];
                            }
                          });
                        }
                        const row = item.row;
                        const isActive = () => item.index === selected();
                        const stateFg = () => rowStateColor(row);
                        const nameFg = () => rowNameColor(row);
                        const cols = () => formatRowColumns(row);
                        return _$createComponent3(DashboardRow, {
                          get id() {
                            return rowIdFor(row.id);
                          },
                          get backgroundColor() {
                            return _$memo3(() => !!isActive())() ? PALETTE2.selectedBg : undefined;
                          },
                          onClick: () => setSelected(item.index),
                          get children() {
                            return [(() => {
                              var _el$258 = _$createElement3("span");
                              _$insert3(_el$258, () => isActive() ? "> " : "  ");
                              _$effect3((_$p) => _$setProp3(_el$258, "style", {
                                fg: PALETTE2.muted,
                                bold: true
                              }, _$p));
                              return _el$258;
                            })(), (() => {
                              var _el$259 = _$createElement3("span");
                              _$insert3(_el$259, () => cols().name);
                              _$effect3((_$p) => _$setProp3(_el$259, "style", {
                                fg: nameFg(),
                                bold: true
                              }, _$p));
                              return _el$259;
                            })(), (() => {
                              var _el$260 = _$createElement3("span");
                              _$insertNode3(_el$260, _$createTextNode3(`  `));
                              _$effect3((_$p) => _$setProp3(_el$260, "style", {
                                fg: PALETTE2.muted
                              }, _$p));
                              return _el$260;
                            })(), (() => {
                              var _el$262 = _$createElement3("span");
                              _$insert3(_el$262, () => cols().state);
                              _$effect3((_$p) => _$setProp3(_el$262, "style", {
                                fg: stateFg(),
                                bold: true
                              }, _$p));
                              return _el$262;
                            })(), (() => {
                              var _el$263 = _$createElement3("span");
                              _$insertNode3(_el$263, _$createTextNode3(`  `));
                              _$effect3((_$p) => _$setProp3(_el$263, "style", {
                                fg: PALETTE2.muted
                              }, _$p));
                              return _el$263;
                            })(), (() => {
                              var _el$265 = _$createElement3("span");
                              _$insert3(_el$265, () => cols().activity);
                              _$effect3((_$p) => _$setProp3(_el$265, "style", {
                                fg: row.state === "blocked" ? PALETTE2.rose : PALETTE2.ink
                              }, _$p));
                              return _el$265;
                            })(), (() => {
                              var _el$266 = _$createElement3("span"), _el$267 = _$createTextNode3(`  `);
                              _$insertNode3(_el$266, _el$267);
                              _$insert3(_el$266, () => cols().updated, null);
                              _$effect3((_$p) => _$setProp3(_el$266, "style", {
                                fg: PALETTE2.muted
                              }, _$p));
                              return _el$266;
                            })()];
                          }
                        });
                      }
                    });
                  }
                }), null);
                _$effect3((_p$) => {
                  var _v$76 = {
                    fg: PALETTE2.muted
                  }, _v$77 = {
                    fg: PALETTE2.rule
                  };
                  _v$76 !== _p$.e && (_p$.e = _$setProp3(_el$198, "style", _v$76, _p$.e));
                  _v$77 !== _p$.t && (_p$.t = _$setProp3(_el$206, "style", _v$77, _p$.t));
                  return _p$;
                }, {
                  e: undefined,
                  t: undefined
                });
                return _el$195;
              }
            }), _$createComponent3(Show3, {
              get when() {
                return selectedGoal();
              },
              children: (goal) => {
                const entry = () => activeGoals().find((e) => e.goal.id === goal().id);
                const dir = () => entry()?.dir ?? props.directory;
                const rt = () => runtimeFor(goal().id);
                const activity = () => rt() ? workerActivityLabel(rt(), clock()) : undefined;
                const lp = () => goal().lastProgress;
                const blk = () => goal().blocker;
                const agentName = () => goal().config.agent;
                const meta = () => agentName() ? agentIndex()[agentName()] ?? agentIndex()[agentName().toLowerCase()] : undefined;
                return _$createComponent3(GoalInspector, {
                  get theme() {
                    return theme();
                  },
                  get model() {
                    return {
                      goal: goal(),
                      directory: dir(),
                      runtime: rt(),
                      activityLine: activity() ? `${activity().short} \u2014 ${activity().hint}` : undefined,
                      acting: activity()?.acting ?? false,
                      lastResult: lp()?.summary,
                      blocked: blk() ? {
                        reason: blk().reason,
                        needed: blk().needed
                      } : undefined,
                      lastProgress: lp() ?? undefined,
                      agentMeta: meta()?.mode,
                      showFocusProject: tab() === "fleet",
                      detailsOpen: detailsOpen()
                    };
                  },
                  onSend: () => openSendModal(),
                  onOpen: () => {
                    if (goal().workerSessionID) {
                      try {
                        props.api.route.navigate("session", {
                          sessionID: goal().workerSessionID
                        });
                        props.api.ui.dialog.clear();
                      } catch {
                        setStatusText("Navigate unsupported here.");
                      }
                    } else
                      setStatusText("No worker session");
                  },
                  onActions: () => actionsOpen() ? setActionsOpen(false) : openActions(),
                  get actionsOpen() {
                    return actionsOpen();
                  },
                  onActionsLayout: updateActionsBounds,
                  get actionsMenu() {
                    return _$createComponent3(Show3, {
                      get when() {
                        return actionsOpen();
                      },
                      get children() {
                        var _el$268 = _$createElement3("box");
                        _$setProp3(_el$268, "position", "absolute");
                        _$setProp3(_el$268, "left", 0);
                        _$setProp3(_el$268, "zIndex", 1);
                        _$setProp3(_el$268, "flexDirection", "column");
                        _$setProp3(_el$268, "border", true);
                        _$setProp3(_el$268, "onMouseDown", (event) => event.stopPropagation());
                        _$insert3(_el$268, _$createComponent3(DashboardList, {
                          get count() {
                            return paletteVerbs().length;
                          },
                          get maxRows() {
                            return actionsBounds().rows;
                          },
                          get selectedID() {
                            return `loopd-action-option-${actionIdx()}`;
                          },
                          get children() {
                            return _$createComponent3(For3, {
                              get each() {
                                return paletteVerbs();
                              },
                              children: (verb, idx) => _$createComponent3(DashboardRow, {
                                get id() {
                                  return `loopd-action-option-${idx()}`;
                                },
                                get backgroundColor() {
                                  return _$memo3(() => idx() === actionIdx())() ? PALETTE2.selectedBg : undefined;
                                },
                                onClick: () => void runPaletteVerb(verb),
                                get children() {
                                  return [(() => {
                                    var _el$269 = _$createElement3("span");
                                    _$insert3(_el$269, () => `${idx() === actionIdx() ? "> " : "  "}${verb.label}`.slice(0, Math.max(1, actionsBounds().width - verb.key.length - 7)));
                                    _$effect3((_$p) => _$setProp3(_el$269, "style", {
                                      fg: idx() === actionIdx() ? PALETTE2.cyan : PALETTE2.ink
                                    }, _$p));
                                    return _el$269;
                                  })(), (() => {
                                    var _el$270 = _$createElement3("span"), _el$271 = _$createTextNode3(` [`), _el$272 = _$createTextNode3(`]`);
                                    _$insertNode3(_el$270, _el$271);
                                    _$insertNode3(_el$270, _el$272);
                                    _$insert3(_el$270, () => verb.key, _el$272);
                                    _$effect3((_$p) => _$setProp3(_el$270, "style", {
                                      fg: verbKeyColor(verb.cmd)
                                    }, _$p));
                                    return _el$270;
                                  })()];
                                }
                              })
                            });
                          }
                        }));
                        _$effect3((_p$) => {
                          var _v$96 = actionsBounds().top, _v$97 = actionsBounds().width, _v$98 = Math.min(paletteVerbs().length, actionsBounds().rows) + 2, _v$99 = theme().borderActive, _v$100 = theme().backgroundMenu;
                          _v$96 !== _p$.e && (_p$.e = _$setProp3(_el$268, "top", _v$96, _p$.e));
                          _v$97 !== _p$.t && (_p$.t = _$setProp3(_el$268, "width", _v$97, _p$.t));
                          _v$98 !== _p$.a && (_p$.a = _$setProp3(_el$268, "height", _v$98, _p$.a));
                          _v$99 !== _p$.o && (_p$.o = _$setProp3(_el$268, "borderColor", _v$99, _p$.o));
                          _v$100 !== _p$.i && (_p$.i = _$setProp3(_el$268, "backgroundColor", _v$100, _p$.i));
                          return _p$;
                        }, {
                          e: undefined,
                          t: undefined,
                          a: undefined,
                          o: undefined,
                          i: undefined
                        });
                        return _el$268;
                      }
                    });
                  },
                  onDetails: () => setDetailsOpen(true),
                  onFocusProject: () => {
                    setProjectScope(dir());
                    setTab("project");
                    setSelected(0);
                    setStatusText(`scope: ${dir().split("/").pop() || dir()}`);
                  }
                });
              }
            })];
          }
        }), _$createComponent3(Show3, {
          get when() {
            return tab() === "commands";
          },
          get children() {
            return [_$createComponent3(Show3, {
              get when() {
                return ownerCommands().length > 0;
              },
              get fallback() {
                return (() => {
                  var _el$273 = _$createElement3("box"), _el$274 = _$createElement3("text"), _el$275 = _$createElement3("span"), _el$276 = _$createTextNode3(`No live command sessions`), _el$277 = _$createTextNode3(`. Use :new &lt;cmd&gt; to start one.`);
                  _$insertNode3(_el$273, _el$274);
                  _$setProp3(_el$273, "border", true);
                  _$setProp3(_el$273, "paddingLeft", 2);
                  _$setProp3(_el$273, "paddingRight", 2);
                  _$setProp3(_el$273, "paddingTop", 1);
                  _$setProp3(_el$273, "paddingBottom", 1);
                  _$insertNode3(_el$274, _el$275);
                  _$setProp3(_el$274, "wrapMode", "none");
                  _$insertNode3(_el$275, _el$276);
                  _$insertNode3(_el$275, _el$277);
                  _$insert3(_el$275, (() => {
                    var _c$4 = _$memo3(() => hiddenFinishedCommands() > 0);
                    return () => _c$4() ? ` (${hiddenFinishedCommands()} finished hidden \u2014 press [h] to show)` : "";
                  })(), _el$277);
                  _$effect3((_p$) => {
                    var { rule: _v$101, inset: _v$102 } = PALETTE2, _v$103 = {
                      fg: PALETTE2.muted
                    };
                    _v$101 !== _p$.e && (_p$.e = _$setProp3(_el$273, "borderColor", _v$101, _p$.e));
                    _v$102 !== _p$.t && (_p$.t = _$setProp3(_el$273, "backgroundColor", _v$102, _p$.t));
                    _v$103 !== _p$.a && (_p$.a = _$setProp3(_el$275, "style", _v$103, _p$.a));
                    return _p$;
                  }, {
                    e: undefined,
                    t: undefined,
                    a: undefined
                  });
                  return _el$273;
                })();
              },
              get children() {
                var _el$207 = _$createElement3("box"), _el$208 = _$createElement3("box"), _el$209 = _$createElement3("text"), _el$210 = _$createElement3("span"), _el$211 = _$createTextNode3(`  Title                   Status          Command                               Updated`), _el$219 = _$createElement3("box"), _el$220 = _$createElement3("text"), _el$221 = _$createElement3("span");
                _$insertNode3(_el$207, _el$208);
                _$insertNode3(_el$207, _el$219);
                _$setProp3(_el$207, "flexDirection", "column");
                _$setProp3(_el$207, "flexShrink", 0);
                _$insertNode3(_el$208, _el$209);
                _$setProp3(_el$208, "flexDirection", "row");
                _$setProp3(_el$208, "paddingLeft", 1);
                _$setProp3(_el$208, "paddingRight", 1);
                _$setProp3(_el$208, "height", 1);
                _$setProp3(_el$208, "flexShrink", 0);
                _$insertNode3(_el$209, _el$210);
                _$setProp3(_el$209, "wrapMode", "none");
                _$insertNode3(_el$210, _el$211);
                _$insertNode3(_el$219, _el$220);
                _$setProp3(_el$219, "flexDirection", "row");
                _$setProp3(_el$219, "paddingLeft", 1);
                _$setProp3(_el$219, "paddingRight", 1);
                _$setProp3(_el$219, "height", 1);
                _$setProp3(_el$219, "flexShrink", 0);
                _$insertNode3(_el$220, _el$221);
                _$setProp3(_el$220, "wrapMode", "none");
                _$insertNode3(_el$221, _$createTextNode3(`\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500`));
                _$insert3(_el$207, _$createComponent3(DashboardList, {
                  get count() {
                    return ownerCommands().length;
                  },
                  maxRows: 6,
                  get selectedID() {
                    return _$memo3(() => !!selectedCommand())() ? `loopd-command-${selectedCommand().id}` : undefined;
                  },
                  get children() {
                    return _$createComponent3(For3, {
                      get each() {
                        return ownerCommands();
                      },
                      children: (cmd, i) => {
                        const isActive = () => i() === cmdSelected();
                        const pad = (s, w) => s.length > w ? `${s.slice(0, w - 1)}\u2026` : s.padEnd(w);
                        return _$createComponent3(DashboardRow, {
                          get id() {
                            return `loopd-command-${cmd.id}`;
                          },
                          get backgroundColor() {
                            return _$memo3(() => !!isActive())() ? PALETTE2.selectedBg : undefined;
                          },
                          onClick: () => setCmdSelected(i()),
                          get children() {
                            return [(() => {
                              var _el$278 = _$createElement3("span");
                              _$insert3(_el$278, () => isActive() ? "> " : "  ");
                              _$effect3((_$p) => _$setProp3(_el$278, "style", {
                                fg: PALETTE2.muted,
                                bold: true
                              }, _$p));
                              return _el$278;
                            })(), (() => {
                              var _el$279 = _$createElement3("span");
                              _$insert3(_el$279, () => pad(cmd.title, 22));
                              _$effect3((_$p) => _$setProp3(_el$279, "style", {
                                fg: PALETTE2.ink,
                                bold: isActive()
                              }, _$p));
                              return _el$279;
                            })(), (() => {
                              var _el$280 = _$createElement3("span");
                              _$insertNode3(_el$280, _$createTextNode3(`  `));
                              _$effect3((_$p) => _$setProp3(_el$280, "style", {
                                fg: PALETTE2.muted
                              }, _$p));
                              return _el$280;
                            })(), (() => {
                              var _el$282 = _$createElement3("span");
                              _$insert3(_el$282, () => pad(`${commandStatusIcon(cmd.status)} ${commandStatusLabel(cmd.status).short}`, 14));
                              _$effect3((_$p) => _$setProp3(_el$282, "style", {
                                fg: commandStatusColor(cmd.status),
                                bold: isActive()
                              }, _$p));
                              return _el$282;
                            })(), (() => {
                              var _el$283 = _$createElement3("span");
                              _$insertNode3(_el$283, _$createTextNode3(`  `));
                              _$effect3((_$p) => _$setProp3(_el$283, "style", {
                                fg: PALETTE2.muted
                              }, _$p));
                              return _el$283;
                            })(), (() => {
                              var _el$285 = _$createElement3("span");
                              _$insert3(_el$285, () => pad(`${cmd.command} ${cmd.args.join(" ")}`.trim(), 36));
                              _$effect3((_$p) => _$setProp3(_el$285, "style", {
                                fg: PALETTE2.ink
                              }, _$p));
                              return _el$285;
                            })(), (() => {
                              var _el$286 = _$createElement3("span"), _el$287 = _$createTextNode3(`  `);
                              _$insertNode3(_el$286, _el$287);
                              _$insert3(_el$286, () => ageText(cmd.updatedAt, clock()), null);
                              _$effect3((_$p) => _$setProp3(_el$286, "style", {
                                fg: PALETTE2.muted
                              }, _$p));
                              return _el$286;
                            })()];
                          }
                        });
                      }
                    });
                  }
                }), null);
                _$effect3((_p$) => {
                  var _v$78 = {
                    fg: PALETTE2.muted
                  }, _v$79 = {
                    fg: PALETTE2.rule
                  };
                  _v$78 !== _p$.e && (_p$.e = _$setProp3(_el$210, "style", _v$78, _p$.e));
                  _v$79 !== _p$.t && (_p$.t = _$setProp3(_el$221, "style", _v$79, _p$.t));
                  return _p$;
                }, {
                  e: undefined,
                  t: undefined
                });
                return _el$207;
              }
            }), _$createComponent3(Show3, {
              get when() {
                return selectedCommand();
              },
              children: (cmd) => (() => {
                var _el$288 = _$createElement3("box"), _el$289 = _$createElement3("box"), _el$290 = _$createElement3("text"), _el$291 = _$createElement3("span"), _el$292 = _$createElement3("span"), _el$293 = _$createTextNode3(` / `), _el$294 = _$createElement3("text"), _el$295 = _$createElement3("span"), _el$296 = _$createTextNode3(` `), _el$297 = _$createElement3("text"), _el$298 = _$createElement3("span"), _el$300 = _$createElement3("span"), _el$301 = _$createTextNode3(` `), _el$302 = _$createElement3("span"), _el$303 = _$createTextNode3(` \xB7 `), _el$304 = _$createTextNode3(`B \xB7 updated `), _el$305 = _$createElement3("box"), _el$306 = _$createElement3("box"), _el$307 = _$createElement3("text"), _el$308 = _$createElement3("span"), _el$310 = _$createElement3("span"), _el$312 = _$createElement3("box"), _el$313 = _$createElement3("text"), _el$314 = _$createElement3("span"), _el$316 = _$createElement3("span"), _el$318 = _$createElement3("box"), _el$319 = _$createElement3("text"), _el$320 = _$createElement3("span"), _el$322 = _$createElement3("span"), _el$324 = _$createElement3("box"), _el$325 = _$createElement3("text"), _el$326 = _$createElement3("span"), _el$328 = _$createElement3("span");
                _$insertNode3(_el$288, _el$289);
                _$insertNode3(_el$288, _el$297);
                _$insertNode3(_el$288, _el$305);
                _$setProp3(_el$288, "flexDirection", "column");
                _$setProp3(_el$288, "border", true);
                _$setProp3(_el$288, "paddingLeft", 1);
                _$setProp3(_el$288, "paddingRight", 1);
                _$setProp3(_el$288, "flexShrink", 0);
                _$insertNode3(_el$289, _el$290);
                _$insertNode3(_el$289, _el$294);
                _$setProp3(_el$289, "flexDirection", "row");
                _$setProp3(_el$289, "justifyContent", "space-between");
                _$setProp3(_el$289, "height", 1);
                _$insertNode3(_el$290, _el$291);
                _$insertNode3(_el$290, _el$292);
                _$setProp3(_el$290, "wrapMode", "none");
                _$insert3(_el$291, () => cmd().title);
                _$insertNode3(_el$292, _el$293);
                _$insert3(_el$292, () => commandDir(cmd().id).split("/").pop() ?? commandDir(cmd().id), null);
                _$insertNode3(_el$294, _el$295);
                _$setProp3(_el$294, "wrapMode", "none");
                _$insertNode3(_el$295, _el$296);
                _$insert3(_el$295, () => commandStatusIcon(cmd().status), _el$296);
                _$insert3(_el$295, () => commandStatusLabel(cmd().status).short, null);
                _$insertNode3(_el$297, _el$298);
                _$insertNode3(_el$297, _el$300);
                _$insertNode3(_el$297, _el$302);
                _$setProp3(_el$297, "wrapMode", "none");
                _$insertNode3(_el$298, _$createTextNode3(`Command: `));
                _$insertNode3(_el$300, _el$301);
                _$insert3(_el$300, () => cmd().command, _el$301);
                _$insert3(_el$300, () => cmd().args.join(" "), null);
                _$insertNode3(_el$302, _el$303);
                _$insertNode3(_el$302, _el$304);
                _$insert3(_el$302, () => cmd().outputBytes, _el$304);
                _$insert3(_el$302, () => ageText(cmd().updatedAt, clock()), null);
                _$insertNode3(_el$305, _el$306);
                _$insertNode3(_el$305, _el$312);
                _$insertNode3(_el$305, _el$318);
                _$insertNode3(_el$305, _el$324);
                _$setProp3(_el$305, "flexDirection", "row");
                _$setProp3(_el$305, "gap", 1);
                _$insertNode3(_el$306, _el$307);
                _$setProp3(_el$306, "border", true);
                _$setProp3(_el$306, "paddingLeft", 1);
                _$setProp3(_el$306, "paddingRight", 1);
                _$spread3(_el$306, _$mergeProps3({
                  get borderColor() {
                    return PALETTE2.rule;
                  },
                  get backgroundColor() {
                    return PALETTE2.base;
                  }
                }, {
                  onMouseDown: () => openSendModal()
                }), true);
                _$insertNode3(_el$307, _el$308);
                _$insertNode3(_el$307, _el$310);
                _$setProp3(_el$307, "wrapMode", "none");
                _$insertNode3(_el$308, _$createTextNode3(`Send stdin `));
                _$insertNode3(_el$310, _$createTextNode3(`[s]`));
                _$insertNode3(_el$312, _el$313);
                _$setProp3(_el$312, "border", true);
                _$setProp3(_el$312, "paddingLeft", 1);
                _$setProp3(_el$312, "paddingRight", 1);
                _$insertNode3(_el$313, _el$314);
                _$insertNode3(_el$313, _el$316);
                _$setProp3(_el$313, "wrapMode", "none");
                _$insertNode3(_el$314, _$createTextNode3(`Fullscreen `));
                _$insertNode3(_el$316, _$createTextNode3(`[o]`));
                _$insertNode3(_el$318, _el$319);
                _$setProp3(_el$318, "border", true);
                _$setProp3(_el$318, "paddingLeft", 1);
                _$setProp3(_el$318, "paddingRight", 1);
                _$spread3(_el$318, _$mergeProps3({
                  get borderColor() {
                    return PALETTE2.rule;
                  },
                  get backgroundColor() {
                    return PALETTE2.base;
                  }
                }, {
                  onMouseDown: () => void killSelectedCommand()
                }), true);
                _$insertNode3(_el$319, _el$320);
                _$insertNode3(_el$319, _el$322);
                _$setProp3(_el$319, "wrapMode", "none");
                _$insertNode3(_el$320, _$createTextNode3(`Kill `));
                _$insertNode3(_el$322, _$createTextNode3(`[X]`));
                _$insertNode3(_el$324, _el$325);
                _$setProp3(_el$324, "border", true);
                _$setProp3(_el$324, "paddingLeft", 1);
                _$setProp3(_el$324, "paddingRight", 1);
                _$spread3(_el$324, _$mergeProps3({
                  get borderColor() {
                    return PALETTE2.rule;
                  },
                  get backgroundColor() {
                    return PALETTE2.base;
                  }
                }, {
                  onMouseDown: () => void restartSelectedCommand()
                }), true);
                _$insertNode3(_el$325, _el$326);
                _$insertNode3(_el$325, _el$328);
                _$setProp3(_el$325, "wrapMode", "none");
                _$insertNode3(_el$326, _$createTextNode3(`Restart `));
                _$insertNode3(_el$328, _$createTextNode3(`[R]`));
                _$effect3((_p$) => {
                  var { rule: _v$104, inset: _v$105 } = PALETTE2, _v$106 = {
                    fg: PALETTE2.cyan,
                    bold: true
                  }, _v$107 = {
                    fg: PALETTE2.muted
                  }, _v$108 = {
                    fg: commandStatusColor(cmd().status),
                    bold: true
                  }, _v$109 = {
                    fg: PALETTE2.muted
                  }, _v$110 = {
                    fg: PALETTE2.ink
                  }, _v$111 = {
                    fg: PALETTE2.muted
                  }, _v$112 = {
                    fg: PALETTE2.ink
                  }, _v$113 = {
                    fg: PALETTE2.sage
                  }, { rule: _v$114, base: _v$115 } = PALETTE2, _v$116 = {
                    fg: PALETTE2.ink
                  }, _v$117 = {
                    fg: PALETTE2.sky
                  }, _v$118 = {
                    fg: PALETTE2.ink
                  }, _v$119 = {
                    fg: PALETTE2.rose
                  }, _v$120 = {
                    fg: PALETTE2.ink
                  }, _v$121 = {
                    fg: PALETTE2.amber
                  };
                  _v$104 !== _p$.e && (_p$.e = _$setProp3(_el$288, "borderColor", _v$104, _p$.e));
                  _v$105 !== _p$.t && (_p$.t = _$setProp3(_el$288, "backgroundColor", _v$105, _p$.t));
                  _v$106 !== _p$.a && (_p$.a = _$setProp3(_el$291, "style", _v$106, _p$.a));
                  _v$107 !== _p$.o && (_p$.o = _$setProp3(_el$292, "style", _v$107, _p$.o));
                  _v$108 !== _p$.i && (_p$.i = _$setProp3(_el$295, "style", _v$108, _p$.i));
                  _v$109 !== _p$.n && (_p$.n = _$setProp3(_el$298, "style", _v$109, _p$.n));
                  _v$110 !== _p$.s && (_p$.s = _$setProp3(_el$300, "style", _v$110, _p$.s));
                  _v$111 !== _p$.h && (_p$.h = _$setProp3(_el$302, "style", _v$111, _p$.h));
                  _v$112 !== _p$.r && (_p$.r = _$setProp3(_el$308, "style", _v$112, _p$.r));
                  _v$113 !== _p$.d && (_p$.d = _$setProp3(_el$310, "style", _v$113, _p$.d));
                  _v$114 !== _p$.l && (_p$.l = _$setProp3(_el$312, "borderColor", _v$114, _p$.l));
                  _v$115 !== _p$.u && (_p$.u = _$setProp3(_el$312, "backgroundColor", _v$115, _p$.u));
                  _v$116 !== _p$.c && (_p$.c = _$setProp3(_el$314, "style", _v$116, _p$.c));
                  _v$117 !== _p$.w && (_p$.w = _$setProp3(_el$316, "style", _v$117, _p$.w));
                  _v$118 !== _p$.m && (_p$.m = _$setProp3(_el$320, "style", _v$118, _p$.m));
                  _v$119 !== _p$.f && (_p$.f = _$setProp3(_el$322, "style", _v$119, _p$.f));
                  _v$120 !== _p$.y && (_p$.y = _$setProp3(_el$326, "style", _v$120, _p$.y));
                  _v$121 !== _p$.g && (_p$.g = _$setProp3(_el$328, "style", _v$121, _p$.g));
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
                  g: undefined
                });
                return _el$288;
              })()
            })];
          }
        })];
      }
    }), null);
    _$insertNode3(_el$223, _el$224);
    _$insertNode3(_el$223, _el$226);
    _$setProp3(_el$223, "flexDirection", "row");
    _$setProp3(_el$223, "justifyContent", "space-between");
    _$setProp3(_el$223, "alignItems", "center");
    _$setProp3(_el$223, "paddingLeft", 2);
    _$setProp3(_el$223, "paddingRight", 2);
    _$setProp3(_el$223, "height", 1);
    _$setProp3(_el$223, "flexShrink", 0);
    _$insertNode3(_el$224, _el$225);
    _$setProp3(_el$224, "wrapMode", "none");
    _$insert3(_el$225, coordStripSummary);
    _$insertNode3(_el$226, _el$227);
    _$setProp3(_el$226, "flexDirection", "row");
    _$setProp3(_el$226, "paddingLeft", 1);
    _$setProp3(_el$226, "paddingRight", 1);
    _$spread3(_el$226, _$mergeProps3({
      get backgroundColor() {
        return PALETTE2.inset;
      }
    }, {
      onMouseDown: () => setCoordOpen((v) => !v)
    }), true);
    _$insertNode3(_el$227, _el$228);
    _$setProp3(_el$227, "wrapMode", "none");
    _$insertNode3(_el$228, _$createTextNode3(`[t] Inspect coordination`));
    _$insertNode3(_el$230, _el$234);
    _$use3((el) => {
      hintBoxEl = el;
    }, _el$230);
    _$setProp3(_el$230, "flexDirection", "row");
    _$setProp3(_el$230, "paddingLeft", 2);
    _$setProp3(_el$230, "paddingRight", 2);
    _$setProp3(_el$230, "height", 1);
    _$setProp3(_el$230, "flexShrink", 0);
    _$setProp3(_el$230, "alignItems", "center");
    _$insert3(_el$230, _$createComponent3(Show3, {
      get when() {
        return _$memo3(() => mode() === "insert")() && insertKind() === "colon";
      },
      get children() {
        var _el$231 = _$createElement3("text"), _el$232 = _$createElement3("span");
        _$insertNode3(_el$231, _el$232);
        _$setProp3(_el$231, "wrapMode", "none");
        _$insertNode3(_el$232, _$createTextNode3(`:`));
        _$effect3((_$p) => _$setProp3(_el$232, "style", {
          fg: PALETTE2.amber,
          bold: true
        }, _$p));
        return _el$231;
      }
    }), _el$234);
    _$use3((el) => {
      inputEl = el;
      focusInput();
    }, _el$234);
    _$setProp3(_el$234, "flexGrow", 1);
    _$setProp3(_el$234, "onInput", (v) => {
      if (mode() === "insert")
        setCommandInput(v);
      else if (inputEl?.value)
        inputEl.value = "";
    });
    _$setProp3(_el$234, "onKeyDown", (evt) => {
      if (mode() !== "insert") {
        if ((evt.name || "").length === 1)
          prevent(evt);
        return;
      }
    });
    _$effect3((_p$) => {
      var { rule: _v$80, base: _v$81, base: _v$82 } = PALETTE2, _v$83 = {
        fg: PALETTE2.amber
      }, _v$84 = {
        fg: PALETTE2.cyan
      }, _v$85 = PALETTE2.inset, _v$86 = mode() === "insert" && insertKind() === "colon" ? "send <msg> | filter <text> | project <name> | release (Esc cancel)" : fitHintBar(FOOT_HINTS, hintCols()), { muted: _v$87, cyan: _v$88 } = PALETTE2, _v$89 = mode() === "insert" && insertKind() === "colon" ? PALETTE2.ink : PALETTE2.inset, _v$90 = PALETTE2.inset;
      _v$80 !== _p$.e && (_p$.e = _$setProp3(_el$28, "borderColor", _v$80, _p$.e));
      _v$81 !== _p$.t && (_p$.t = _$setProp3(_el$28, "backgroundColor", _v$81, _p$.t));
      _v$82 !== _p$.a && (_p$.a = _$setProp3(_el$223, "backgroundColor", _v$82, _p$.a));
      _v$83 !== _p$.o && (_p$.o = _$setProp3(_el$225, "style", _v$83, _p$.o));
      _v$84 !== _p$.i && (_p$.i = _$setProp3(_el$228, "style", _v$84, _p$.i));
      _v$85 !== _p$.n && (_p$.n = _$setProp3(_el$230, "backgroundColor", _v$85, _p$.n));
      _v$86 !== _p$.s && (_p$.s = _$setProp3(_el$234, "placeholder", _v$86, _p$.s));
      _v$87 !== _p$.h && (_p$.h = _$setProp3(_el$234, "placeholderColor", _v$87, _p$.h));
      _v$88 !== _p$.r && (_p$.r = _$setProp3(_el$234, "cursorColor", _v$88, _p$.r));
      _v$89 !== _p$.d && (_p$.d = _$setProp3(_el$234, "focusedTextColor", _v$89, _p$.d));
      _v$90 !== _p$.l && (_p$.l = _$setProp3(_el$234, "focusedBackgroundColor", _v$90, _p$.l));
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
    return _el$28;
  })();
}

// src/tui/command-panel.tsx
import { effect as _$effect4 } from "@opentui/solid";
import { use as _$use4 } from "@opentui/solid";
import { createComponent as _$createComponent4 } from "@opentui/solid";
import { insert as _$insert4 } from "@opentui/solid";
import { memo as _$memo4 } from "@opentui/solid";
import { createTextNode as _$createTextNode4 } from "@opentui/solid";
import { insertNode as _$insertNode4 } from "@opentui/solid";
import { setProp as _$setProp4 } from "@opentui/solid";
import { createElement as _$createElement4 } from "@opentui/solid";
import { createSignal as createSignal2, For as For4, Show as Show4, onCleanup as onCleanup2, onMount as onMount2 } from "solid-js";
import { useKeyboard as useKeyboard2 } from "@opentui/solid";

// src/domain/command-agent-event.ts
var MAX_AGENT_EVENT_BYTES = 4 * 1024;
var AGENT_EVENT_MAX_PAYLOAD_BYTES = 4 * 1024;
function formatAgentChannelStatus(session) {
  const retained = session.truncated ? `${session.outputBytes}B retained of ${session.streamBytes}B (truncated)` : `${session.outputBytes}B retained`;
  const events = session.agentEvents ?? [];
  if (events.length === 0) {
    return `console: ${retained} \xB7 agent events: none (filtered output stays console-only)`;
  }
  const last = events[events.length - 1];
  return `console: ${retained} \xB7 agent events: ${events.length} (last #${last.sequence} ${last.trigger} ` + `${last.lines} line(s) [${last.startOffset},${last.endOffset}))`;
}

// src/tui/command-stream-client.ts
import { promises as fs4 } from "fs";
import path3 from "path";

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
  return path3.join(directory, ".opencode", "loopd", "commands", ".stream-endpoint.json");
}
async function defaultReadEndpoint(directory) {
  let text;
  try {
    text = await fs4.readFile(defaultEndpointPath(directory), "utf8");
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
function createTerminalScreen(cols, rows, opts) {
  const { Terminal } = __require("@xterm/headless");
  function makeTerm(nextCols, nextRows) {
    return new Terminal({
      cols: nextCols,
      rows: nextRows,
      scrollback: opts?.scrollback ?? 1000,
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
      let base = 0;
      try {
        const viewY = active.viewportY;
        const len = active.length ?? r;
        if (typeof viewY === "number" && Number.isFinite(viewY)) {
          base = Math.max(0, Math.min(viewY, Math.max(0, len - r)));
        }
      } catch {
        base = 0;
      }
      for (let y = 0;y < r; y++) {
        let line;
        try {
          line = active.getLine(base + y);
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
    get scrollOffset() {
      if (disposed)
        return 0;
      try {
        const active = term.buffer.active;
        if (typeof active.viewportY !== "number" || typeof active.baseY !== "number")
          return 0;
        return Math.max(0, active.baseY - active.viewportY);
      } catch {
        return 0;
      }
    },
    get scrollPosition() {
      const none = { above: 0, below: 0 };
      if (disposed)
        return none;
      try {
        if (term.buffer.active.type === "alternate")
          return none;
        const active = term.buffer.active;
        const r = term.rows;
        const len = typeof active.length === "number" ? active.length : r;
        let v = typeof active.viewportY === "number" && Number.isFinite(active.viewportY) ? active.viewportY : 0;
        v = Math.max(0, Math.min(v, Math.max(0, len - r)));
        return { above: v, below: Math.max(0, len - (v + r)) };
      } catch {
        return none;
      }
    },
    scrollBy(lines) {
      if (disposed || !Number.isFinite(lines) || lines === 0)
        return;
      try {
        if (term.buffer.active.type === "alternate")
          return;
        term.scrollLines(Math.trunc(lines));
      } catch {}
    },
    scrollToBottom() {
      if (disposed)
        return;
      try {
        term.scrollToBottom();
      } catch {}
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
    var _el$ = _$createElement4("box"), _el$2 = _$createElement4("box"), _el$3 = _$createElement4("box"), _el$4 = _$createElement4("text"), _el$5 = _$createElement4("span"), _el$7 = _$createElement4("span"), _el$8 = _$createElement4("text"), _el$9 = _$createElement4("span"), _el$0 = _$createTextNode4(` owned`), _el$10 = _$createElement4("box"), _el$11 = _$createElement4("text"), _el$12 = _$createElement4("span"), _el$13 = _$createElement4("input");
    _$insertNode4(_el$, _el$2);
    _$setProp4(_el$, "flexDirection", "column");
    _$setProp4(_el$, "width", "100%");
    _$setProp4(_el$, "alignItems", "center");
    _$setProp4(_el$, "padding", 1);
    _$insertNode4(_el$2, _el$3);
    _$insertNode4(_el$2, _el$10);
    _$setProp4(_el$2, "flexDirection", "column");
    _$setProp4(_el$2, "width", "90%");
    _$setProp4(_el$2, "border", true);
    _$setProp4(_el$2, "padding", 1);
    _$insertNode4(_el$3, _el$4);
    _$insertNode4(_el$3, _el$8);
    _$setProp4(_el$3, "flexDirection", "row");
    _$setProp4(_el$3, "justifyContent", "space-between");
    _$setProp4(_el$3, "flexShrink", 0);
    _$insertNode4(_el$4, _el$5);
    _$insertNode4(_el$4, _el$7);
    _$insertNode4(_el$5, _$createTextNode4(`\u2B22 Command Sessions`));
    _$insert4(_el$7, () => emulated() ? " \u2502 terminal screen (emulated view \xB7 raw log is the record)" : " \u2502 byte-stream output (raw text)");
    _$insertNode4(_el$8, _el$9);
    _$insertNode4(_el$9, _el$0);
    _$insert4(_el$9, () => state().commands.length, _el$0);
    _$insert4(_el$2, _$createComponent4(Show4, {
      get when() {
        return state().commands.length > 0;
      },
      get fallback() {
        return (() => {
          var _el$14 = _$createElement4("box"), _el$15 = _$createElement4("text"), _el$16 = _$createElement4("span");
          _$insertNode4(_el$14, _el$15);
          _$setProp4(_el$14, "padding", 1);
          _$insertNode4(_el$15, _el$16);
          _$insert4(_el$16, ownerSessionID ? "No command sessions. :new <command> [args...] to start one." : "Open this panel from a session view \u2014 owner scoping needs a session.");
          _$effect4((_$p) => _$setProp4(_el$16, "style", {
            fg: theme().textMuted
          }, _$p));
          return _el$14;
        })();
      },
      get children() {
        var _el$1 = _$createElement4("box");
        _$setProp4(_el$1, "flexDirection", "column");
        _$setProp4(_el$1, "flexShrink", 1);
        _$setProp4(_el$1, "minHeight", 0);
        _$setProp4(_el$1, "overflow", "hidden");
        _$insert4(_el$1, _$createComponent4(For4, {
          get each() {
            return state().commands;
          },
          children: (cmd, i) => {
            const badge = watchBadge(cmd);
            const badgeWarn = badge === "flood-suspended" || badge === "budget-exhausted";
            const badgeHot = badge === "until-matched";
            const terminalReason = cmd.status !== "running" ? cmd.endReason : undefined;
            return (() => {
              var _el$17 = _$createElement4("box"), _el$18 = _$createElement4("text"), _el$19 = _$createElement4("span"), _el$20 = _$createElement4("span"), _el$21 = _$createTextNode4(` \u2502 `), _el$22 = _$createTextNode4(` \u2502 `);
              _$insertNode4(_el$17, _el$18);
              _$setProp4(_el$17, "paddingLeft", 1);
              _$setProp4(_el$17, "paddingRight", 1);
              _$insertNode4(_el$18, _el$19);
              _$insertNode4(_el$18, _el$20);
              _$setProp4(_el$18, "wrapMode", "none");
              _$setProp4(_el$18, "truncate", true);
              _$insert4(_el$19, () => i() === state().selected ? "\u25B6 " : "  ", null);
              _$insert4(_el$19, () => cmd.title, null);
              _$insertNode4(_el$20, _el$21);
              _$insertNode4(_el$20, _el$22);
              _$insert4(_el$20, () => [cmd.command, ...cmd.args].join(" ").slice(0, 60), _el$22);
              _$insert4(_el$20, () => cmd.status, null);
              _$insert4(_el$20, (() => {
                var _c$ = _$memo4(() => cmd.exitCode !== undefined);
                return () => _c$() ? ` (${cmd.exitCode})` : "";
              })(), null);
              _$insert4(_el$18, terminalReason ? (() => {
                var _el$23 = _$createElement4("span"), _el$24 = _$createTextNode4(` [`), _el$25 = _$createTextNode4(`]`);
                _$insertNode4(_el$23, _el$24);
                _$insertNode4(_el$23, _el$25);
                _$insert4(_el$23, terminalReason, _el$25);
                _$effect4((_$p) => _$setProp4(_el$23, "style", {
                  fg: terminalReason === "timeout" ? theme().warning : theme().textMuted
                }, _$p));
                return _el$23;
              })() : undefined, null);
              _$insert4(_el$18, badge ? (() => {
                var _el$26 = _$createElement4("span"), _el$27 = _$createTextNode4(` [`), _el$28 = _$createTextNode4(`]`);
                _$insertNode4(_el$26, _el$27);
                _$insertNode4(_el$26, _el$28);
                _$insert4(_el$26, badge, _el$28);
                _$effect4((_$p) => _$setProp4(_el$26, "style", {
                  fg: badgeWarn ? theme().warning : badgeHot ? theme().primary : theme().textMuted
                }, _$p));
                return _el$26;
              })() : undefined, null);
              _$effect4((_p$) => {
                var _v$10 = i() === state().selected ? theme().backgroundElement : undefined, _v$11 = {
                  fg: cmd.status === "running" ? theme().success : theme().textMuted,
                  bold: i() === state().selected
                }, _v$12 = {
                  fg: theme().textMuted
                };
                _v$10 !== _p$.e && (_p$.e = _$setProp4(_el$17, "backgroundColor", _v$10, _p$.e));
                _v$11 !== _p$.t && (_p$.t = _$setProp4(_el$19, "style", _v$11, _p$.t));
                _v$12 !== _p$.a && (_p$.a = _$setProp4(_el$20, "style", _v$12, _p$.a));
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
    _$insert4(_el$2, _$createComponent4(Show4, {
      get when() {
        return sel();
      },
      children: (cmd) => (() => {
        var _el$29 = _$createElement4("box"), _el$30 = _$createElement4("text"), _el$31 = _$createElement4("span"), _el$32 = _$createElement4("span"), _el$33 = _$createTextNode4(` \u2502 `), _el$34 = _$createTextNode4(` \u2502 `), _el$35 = _$createTextNode4(` \u2502 `), _el$36 = _$createTextNode4(` bytes`), _el$42 = _$createElement4("text"), _el$43 = _$createElement4("span");
        _$insertNode4(_el$29, _el$30);
        _$insertNode4(_el$29, _el$42);
        _$setProp4(_el$29, "flexDirection", "column");
        _$setProp4(_el$29, "border", true);
        _$setProp4(_el$29, "padding", 1);
        _$setProp4(_el$29, "flexShrink", 0);
        _$setProp4(_el$29, "maxHeight", 16);
        _$setProp4(_el$29, "overflow", "hidden");
        _$insertNode4(_el$30, _el$31);
        _$insertNode4(_el$30, _el$32);
        _$insert4(_el$31, () => cmd().title);
        _$insertNode4(_el$32, _el$33);
        _$insertNode4(_el$32, _el$34);
        _$insertNode4(_el$32, _el$35);
        _$insertNode4(_el$32, _el$36);
        _$insert4(_el$32, () => [cmd().command, ...cmd().args].join(" "), _el$34);
        _$insert4(_el$32, () => cmd().status, _el$35);
        _$insert4(_el$32, () => cmd().detached ? " \xB7 detached (output frozen)" : "", _el$35);
        _$insert4(_el$32, () => outputMeta().totalBytes, _el$36);
        _$insert4(_el$32, () => outputMeta().live ? " \xB7 live" : "", null);
        _$insert4(_el$32, () => cmd().truncated ? " \xB7 truncated" : "", null);
        _$insert4(_el$32, (() => {
          var _c$2 = _$memo4(() => !!(cmd().status !== "running" && cmd().endReason));
          return () => _c$2() ? ` \xB7 end:${cmd().endReason}${cmd().terminatedBy ? `(${cmd().terminatedBy})` : ""}` : "";
        })(), null);
        _$insert4(_el$32, (() => {
          var _c$3 = _$memo4(() => !!(emulated() && screen && feedForID === cmd().id));
          return () => _c$3() ? ` \xB7 ${screen.cols}x${screen.rows} screen${screen.activeBuffer === "alternate" ? " \xB7 alt-screen" : ""}` : "";
        })(), null);
        _$insert4(_el$29, (() => {
          var _c$4 = _$memo4(() => !!formatWatchDetail(cmd()));
          return () => _c$4() ? (() => {
            var _el$44 = _$createElement4("text"), _el$45 = _$createElement4("span");
            _$insertNode4(_el$44, _el$45);
            _$insert4(_el$45, () => formatWatchDetail(cmd()));
            _$effect4((_$p) => _$setProp4(_el$45, "style", {
              fg: theme().textMuted
            }, _$p));
            return _el$44;
          })() : undefined;
        })(), _el$42);
        _$insert4(_el$29, _$createComponent4(Show4, {
          get when() {
            return cmd().truncated;
          },
          get children() {
            var _el$37 = _$createElement4("text"), _el$38 = _$createElement4("span"), _el$39 = _$createTextNode4(`earlier output not retained: keeping the last `), _el$40 = _$createTextNode4(` of `), _el$41 = _$createTextNode4(` bytes (console offsets stay absolute)`);
            _$insertNode4(_el$37, _el$38);
            _$insertNode4(_el$38, _el$39);
            _$insertNode4(_el$38, _el$40);
            _$insertNode4(_el$38, _el$41);
            _$insert4(_el$38, () => outputMeta().totalBytes, _el$40);
            _$insert4(_el$38, () => cmd().streamBytes, _el$41);
            _$effect4((_$p) => _$setProp4(_el$38, "style", {
              fg: theme().warning
            }, _$p));
            return _el$37;
          }
        }), _el$42);
        _$insertNode4(_el$42, _el$43);
        _$insert4(_el$43, () => formatAgentChannelStatus(cmd()));
        _$insert4(_el$29, _$createComponent4(Show4, {
          get when() {
            return _$memo4(() => !!emulated())() && screenRows().length > 0;
          },
          get fallback() {
            return (() => {
              var _el$46 = _$createElement4("text"), _el$47 = _$createElement4("span");
              _$insertNode4(_el$46, _el$47);
              _$insert4(_el$47, () => output().slice(-4000) || "(no output yet)");
              _$effect4((_$p) => _$setProp4(_el$47, "style", {
                fg: theme().text
              }, _$p));
              return _el$46;
            })();
          },
          get children() {
            return _$createComponent4(For4, {
              get each() {
                return screenRows();
              },
              children: (row) => (() => {
                var _el$48 = _$createElement4("text");
                _$setProp4(_el$48, "wrapMode", "none");
                _$setProp4(_el$48, "truncate", true);
                _$insert4(_el$48, _$createComponent4(For4, {
                  get each() {
                    return row.runs;
                  },
                  children: (run) => (() => {
                    var _el$49 = _$createElement4("span");
                    _$insert4(_el$49, () => run.text);
                    _$effect4((_$p) => _$setProp4(_el$49, "style", {
                      fg: run.fg ?? theme().text,
                      bg: run.bg,
                      bold: run.bold,
                      underline: run.underline
                    }, _$p));
                    return _el$49;
                  })()
                }));
                return _el$48;
              })()
            });
          }
        }), null);
        _$effect4((_p$) => {
          var _v$13 = theme().border, _v$14 = {
            fg: theme().primary,
            bold: true
          }, _v$15 = {
            fg: theme().textMuted
          }, _v$16 = {
            fg: theme().textMuted
          };
          _v$13 !== _p$.e && (_p$.e = _$setProp4(_el$29, "borderColor", _v$13, _p$.e));
          _v$14 !== _p$.t && (_p$.t = _$setProp4(_el$31, "style", _v$14, _p$.t));
          _v$15 !== _p$.a && (_p$.a = _$setProp4(_el$32, "style", _v$15, _p$.a));
          _v$16 !== _p$.o && (_p$.o = _$setProp4(_el$43, "style", _v$16, _p$.o));
          return _p$;
        }, {
          e: undefined,
          t: undefined,
          a: undefined,
          o: undefined
        });
        return _el$29;
      })()
    }), _el$10);
    _$insertNode4(_el$10, _el$11);
    _$insertNode4(_el$10, _el$13);
    _$setProp4(_el$10, "flexDirection", "row");
    _$setProp4(_el$10, "border", true);
    _$setProp4(_el$10, "paddingLeft", 1);
    _$setProp4(_el$10, "paddingRight", 1);
    _$setProp4(_el$10, "flexShrink", 0);
    _$setProp4(_el$10, "height", 3);
    _$setProp4(_el$10, "gap", 1);
    _$insertNode4(_el$11, _el$12);
    _$insert4(_el$12, () => insertMode() ? " INPUT " : " NORMAL ");
    _$use4((el) => {
      inputEl = el;
    }, _el$13);
    _$setProp4(_el$13, "flexGrow", 1);
    _$setProp4(_el$13, "onInput", (v) => {
      if (insertMode())
        setInputValue(v);
      else if (inputEl?.value)
        inputEl.value = "";
    });
    _$effect4((_p$) => {
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
      _v$ !== _p$.e && (_p$.e = _$setProp4(_el$2, "borderColor", _v$, _p$.e));
      _v$2 !== _p$.t && (_p$.t = _$setProp4(_el$5, "style", _v$2, _p$.t));
      _v$3 !== _p$.a && (_p$.a = _$setProp4(_el$7, "style", _v$3, _p$.a));
      _v$4 !== _p$.o && (_p$.o = _$setProp4(_el$9, "style", _v$4, _p$.o));
      _v$5 !== _p$.i && (_p$.i = _$setProp4(_el$10, "borderColor", _v$5, _p$.i));
      _v$6 !== _p$.n && (_p$.n = _$setProp4(_el$12, "style", _v$6, _p$.n));
      _v$7 !== _p$.s && (_p$.s = _$setProp4(_el$13, "placeholder", _v$7, _p$.s));
      _v$8 !== _p$.h && (_p$.h = _$setProp4(_el$13, "placeholderColor", _v$8, _p$.h));
      _v$9 !== _p$.r && (_p$.r = _$setProp4(_el$13, "cursorColor", _v$9, _p$.r));
      _v$0 !== _p$.d && (_p$.d = _$setProp4(_el$13, "focusedTextColor", _v$0, _p$.d));
      _v$1 !== _p$.l && (_p$.l = _$setProp4(_el$13, "focusedBackgroundColor", _v$1, _p$.l));
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
import { use as _$use5 } from "@opentui/solid";
import { createComponent as _$createComponent5 } from "@opentui/solid";
import { effect as _$effect5 } from "@opentui/solid";
import { insert as _$insert5 } from "@opentui/solid";
import { createTextNode as _$createTextNode5 } from "@opentui/solid";
import { insertNode as _$insertNode5 } from "@opentui/solid";
import { memo as _$memo5 } from "@opentui/solid";
import { setProp as _$setProp5 } from "@opentui/solid";
import { createElement as _$createElement5 } from "@opentui/solid";
import { createSignal as createSignal3, For as For5, Show as Show5, onCleanup as onCleanup3, onMount as onMount3 } from "solid-js";
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
  let pendingScrollRestore = 0;
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
    if (feed?.endOffset === endOffset)
      return;
    const keepOffset = screen?.scrollOffset ?? 0;
    const revision = ++paintRevision;
    feed.applySnapshot(snapshotData, startOffset, endOffset);
    totalBytes = endOffset;
    if (keepOffset > 0)
      pendingScrollRestore = keepOffset;
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
    if (pendingScrollRestore > 0) {
      const keep = pendingScrollRestore;
      pendingScrollRestore = 0;
      try {
        screen?.scrollToBottom();
        screen?.scrollBy(-keep);
      } catch {}
    }
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
    if (command?.detached === true)
      return;
    if (streamLive() && stream.sendInput(data.commandID, bytes).ok)
      return;
    control.executeRaw({ command: "cmd_write", goalID: data.commandID, args: { commandID: data.commandID, input: bytes, ownerSessionID: data.ownerSessionID } }).catch(() => {});
  }
  function paste(text) {
    if (disposed || !data || !text)
      return;
    if (command?.detached === true)
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
    if (command?.detached === true)
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
  function scrollBy(lines) {
    if (disposed || !data)
      return;
    if (!Number.isFinite(lines) || lines === 0)
      return;
    try {
      screen?.scrollBy(Math.trunc(lines));
    } catch {}
    emitSoon();
  }
  function scrollToBottom() {
    if (disposed)
      return;
    try {
      screen?.scrollToBottom();
    } catch {}
    emitSoon();
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
    let scrollOffset = 0;
    let scrollAbove = 0;
    let scrollBelow = 0;
    try {
      scrollOffset = screen?.scrollOffset ?? 0;
      const pos = screen?.scrollPosition;
      scrollAbove = pos?.above ?? 0;
      scrollBelow = pos?.below ?? 0;
    } catch {
      scrollOffset = 0;
    }
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
      scrollOffset,
      scrollAbove,
      scrollBelow,
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
    scrollBy,
    scrollToBottom,
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
    const keyEvt = toKeyEvent(evt);
    if (keyEvt.shift && !keyEvt.release) {
      const nm = (keyEvt.name ?? "").toLowerCase();
      if (nm === "pageup" || nm === "page_up") {
        prevent3(evt);
        session.scrollBy(-Math.max(1, session.appliedSize.rows));
        return;
      }
      if (nm === "pagedown" || nm === "page_down") {
        prevent3(evt);
        session.scrollBy(Math.max(1, session.appliedSize.rows));
        return;
      }
    }
    if (isDetachChord(keyEvt)) {
      prevent3(evt);
      session.detach();
      return;
    }
    if (isInterruptChord(keyEvt)) {
      prevent3(evt);
      if (detachedCmd() || view()?.command && view()?.command?.status !== "running")
        return;
      session.interrupt();
      return;
    }
    const bytes = encodeTerminalKey(keyEvt);
    if (bytes !== undefined) {
      prevent3(evt);
      if (detachedCmd() || view()?.command && view()?.command?.status !== "running")
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
  const detachedCmd = () => cmd()?.detached === true && cmd()?.status === "running";
  const dims = () => {
    const v = view();
    if (!v)
      return `${TERMINAL_FALLBACK_COLS}x${TERMINAL_FALLBACK_ROWS}`;
    return `${v.cols}x${v.viewportRows}`;
  };
  return (() => {
    var _el$ = _$createElement5("box"), _el$2 = _$createElement5("box"), _el$3 = _$createElement5("text"), _el$4 = _$createElement5("span"), _el$5 = _$createTextNode5(`\u2B22 `), _el$9 = _$createElement5("span"), _el$1 = _$createElement5("span"), _el$12 = _$createElement5("text"), _el$13 = _$createElement5("span"), _el$30 = _$createElement5("box"), _el$31 = _$createElement5("box"), _el$32 = _$createElement5("text"), _el$33 = _$createElement5("span"), _el$43 = _$createElement5("span"), _el$45 = _$createElement5("span"), _el$47 = _$createElement5("span"), _el$49 = _$createElement5("span"), _el$51 = _$createElement5("text"), _el$52 = _$createElement5("span"), _el$53 = _$createTextNode5(` \xB7 `), _el$54 = _$createTextNode5(` bytes`);
    _$insertNode5(_el$, _el$2);
    _$insertNode5(_el$, _el$30);
    _$insertNode5(_el$, _el$31);
    _$setProp5(_el$, "flexDirection", "column");
    _$setProp5(_el$, "width", "100%");
    _$setProp5(_el$, "height", "100%");
    _$setProp5(_el$, "padding", 1);
    _$insertNode5(_el$2, _el$3);
    _$insertNode5(_el$2, _el$12);
    _$setProp5(_el$2, "flexDirection", "row");
    _$setProp5(_el$2, "justifyContent", "space-between");
    _$setProp5(_el$2, "flexShrink", 0);
    _$insertNode5(_el$3, _el$4);
    _$insertNode5(_el$3, _el$9);
    _$insertNode5(_el$3, _el$1);
    _$insertNode5(_el$4, _el$5);
    _$insert5(_el$4, () => cmd()?.title ?? "Terminal", null);
    _$insert5(_el$3, _$createComponent5(Show5, {
      get when() {
        return cmd();
      },
      get children() {
        var _el$6 = _$createElement5("span"), _el$7 = _$createTextNode5(` \u2502 `), _el$8 = _$createTextNode5(` \u2502 `);
        _$insertNode5(_el$6, _el$7);
        _$insertNode5(_el$6, _el$8);
        _$insert5(_el$6, () => [cmd().command, ...cmd().args].join(" "), _el$8);
        _$insert5(_el$6, () => cmd().status, null);
        _$insert5(_el$6, (() => {
          var _c$ = _$memo5(() => cmd().exitCode !== undefined);
          return () => _c$() ? ` (${cmd().exitCode})` : "";
        })(), null);
        _$effect5((_$p) => _$setProp5(_el$6, "style", {
          fg: theme().textMuted
        }, _$p));
        return _el$6;
      }
    }), _el$9);
    _$insertNode5(_el$9, _$createTextNode5(` \u2502 `));
    _$insert5(_el$1, () => view()?.connectionDetail ?? "connecting\u2026");
    _$insert5(_el$3, _$createComponent5(Show5, {
      get when() {
        return (view()?.activeBuffer ?? "normal") === "alternate";
      },
      get children() {
        var _el$10 = _$createElement5("span");
        _$insertNode5(_el$10, _$createTextNode5(` \u2502 alt-screen`));
        _$effect5((_$p) => _$setProp5(_el$10, "style", {
          fg: theme().accent
        }, _$p));
        return _el$10;
      }
    }), null);
    _$insertNode5(_el$12, _el$13);
    _$insert5(_el$13, dims, null);
    _$insert5(_el$13, () => processRunning() ? " \xB7 live" : "", null);
    _$insert5(_el$, _$createComponent5(Show5, {
      get when() {
        return view()?.invalid;
      },
      get children() {
        var _el$14 = _$createElement5("box"), _el$15 = _$createElement5("text"), _el$16 = _$createElement5("span"), _el$17 = _$createTextNode5(`Invalid terminal route: `), _el$18 = _$createElement5("span"), _el$19 = _$createTextNode5(`
Press Ctrl+] to go back. Nothing was subscribed or written.`);
        _$insertNode5(_el$14, _el$15);
        _$setProp5(_el$14, "flexDirection", "column");
        _$setProp5(_el$14, "border", true);
        _$setProp5(_el$14, "padding", 1);
        _$setProp5(_el$14, "flexShrink", 0);
        _$insertNode5(_el$15, _el$16);
        _$insertNode5(_el$15, _el$18);
        _$insertNode5(_el$16, _el$17);
        _$insert5(_el$16, () => view()?.invalid, null);
        _$insertNode5(_el$18, _el$19);
        _$effect5((_p$) => {
          var _v$ = theme().error, _v$2 = {
            fg: theme().error,
            bold: true
          }, _v$3 = {
            fg: theme().textMuted
          };
          _v$ !== _p$.e && (_p$.e = _$setProp5(_el$14, "borderColor", _v$, _p$.e));
          _v$2 !== _p$.t && (_p$.t = _$setProp5(_el$16, "style", _v$2, _p$.t));
          _v$3 !== _p$.a && (_p$.a = _$setProp5(_el$18, "style", _v$3, _p$.a));
          return _p$;
        }, {
          e: undefined,
          t: undefined,
          a: undefined
        });
        return _el$14;
      }
    }), _el$30);
    _$insert5(_el$, _$createComponent5(Show5, {
      get when() {
        return _$memo5(() => !!cmd())() && !processRunning();
      },
      get children() {
        var _el$21 = _$createElement5("box"), _el$22 = _$createElement5("text"), _el$23 = _$createElement5("span"), _el$24 = _$createTextNode5(`PROCESS `), _el$25 = _$createTextNode5(` \u2014 saved output only. Ctrl+C/input cannot affect it; Ctrl+] returns to Commands.`);
        _$insertNode5(_el$21, _el$22);
        _$setProp5(_el$21, "border", true);
        _$setProp5(_el$21, "paddingLeft", 1);
        _$setProp5(_el$21, "paddingRight", 1);
        _$setProp5(_el$21, "flexShrink", 0);
        _$insertNode5(_el$22, _el$23);
        _$insertNode5(_el$23, _el$24);
        _$insertNode5(_el$23, _el$25);
        _$insert5(_el$23, () => cmd().status.toUpperCase(), _el$25);
        _$insert5(_el$23, (() => {
          var _c$2 = _$memo5(() => cmd().exitCode !== undefined);
          return () => _c$2() ? ` (exit ${cmd().exitCode})` : "";
        })(), _el$25);
        _$effect5((_p$) => {
          var _v$4 = theme().warning, _v$5 = {
            fg: theme().warning,
            bold: true
          };
          _v$4 !== _p$.e && (_p$.e = _$setProp5(_el$21, "borderColor", _v$4, _p$.e));
          _v$5 !== _p$.t && (_p$.t = _$setProp5(_el$23, "style", _v$5, _p$.t));
          return _p$;
        }, {
          e: undefined,
          t: undefined
        });
        return _el$21;
      }
    }), _el$30);
    _$insert5(_el$, _$createComponent5(Show5, {
      get when() {
        return detachedCmd();
      },
      get children() {
        var _el$26 = _$createElement5("box"), _el$27 = _$createElement5("text"), _el$28 = _$createElement5("span");
        _$insertNode5(_el$26, _el$27);
        _$setProp5(_el$26, "border", true);
        _$setProp5(_el$26, "paddingLeft", 1);
        _$setProp5(_el$26, "paddingRight", 1);
        _$setProp5(_el$26, "flexShrink", 0);
        _$insertNode5(_el$27, _el$28);
        _$insertNode5(_el$28, _$createTextNode5(`DETACHED \u2014 survived a host restart. Output frozen at the detach point; typing cannot reach it. Terminate/kill from Commands still stops the pid.`));
        _$effect5((_p$) => {
          var _v$6 = theme().info, _v$7 = {
            fg: theme().info,
            bold: true
          };
          _v$6 !== _p$.e && (_p$.e = _$setProp5(_el$26, "borderColor", _v$6, _p$.e));
          _v$7 !== _p$.t && (_p$.t = _$setProp5(_el$28, "style", _v$7, _p$.t));
          return _p$;
        }, {
          e: undefined,
          t: undefined
        });
        return _el$26;
      }
    }), _el$30);
    _$use5((el) => {
      viewportEl = el;
      try {
        el.onSizeChange = () => measureViewport();
      } catch {}
      setTimeout(measureViewport, 50);
    }, _el$30);
    _$setProp5(_el$30, "flexDirection", "column");
    _$setProp5(_el$30, "flexGrow", 1);
    _$setProp5(_el$30, "minHeight", 0);
    _$setProp5(_el$30, "overflow", "hidden");
    _$setProp5(_el$30, "onMouseScroll", (evt) => {
      const dir = evt.scroll?.direction;
      if (dir !== "up" && dir !== "down")
        return;
      const step = Math.max(1, evt.scroll?.delta ?? 1) * 3;
      session.scrollBy(dir === "up" ? -step : step);
    });
    _$insert5(_el$30, _$createComponent5(Show5, {
      get when() {
        return _$memo5(() => !!view())() && view().rows.length > 0;
      },
      get fallback() {
        return (() => {
          var _el$55 = _$createElement5("text"), _el$56 = _$createElement5("span");
          _$insertNode5(_el$55, _el$56);
          _$insert5(_el$56, () => view()?.invalid ? "" : "(no output yet)");
          _$effect5((_$p) => _$setProp5(_el$56, "style", {
            fg: theme().textMuted
          }, _$p));
          return _el$55;
        })();
      },
      get children() {
        return _$createComponent5(For5, {
          get each() {
            return buildTerminalRows(view().rows, view().cols, view().viewportRows, {
              ...view().cursor,
              visible: processRunning() && view().cursor.visible
            });
          },
          children: (runs) => (() => {
            var _el$57 = _$createElement5("text");
            _$setProp5(_el$57, "wrapMode", "none");
            _$setProp5(_el$57, "truncate", true);
            _$insert5(_el$57, _$createComponent5(For5, {
              each: runs,
              children: (run) => (() => {
                var _el$58 = _$createElement5("span");
                _$insert5(_el$58, () => run.text);
                _$effect5((_$p) => _$setProp5(_el$58, "style", {
                  fg: run.cursor ? theme().background : run.inverse ? run.fg ?? theme().background : run.fg ?? theme().text,
                  bg: run.cursor ? theme().primary : run.inverse ? run.bg ?? theme().text : run.bg,
                  bold: run.bold ?? run.cursor,
                  underline: run.underline
                }, _$p));
                return _el$58;
              })()
            }));
            return _el$57;
          })()
        });
      }
    }));
    _$insertNode5(_el$31, _el$32);
    _$insertNode5(_el$31, _el$51);
    _$setProp5(_el$31, "flexDirection", "row");
    _$setProp5(_el$31, "justifyContent", "space-between");
    _$setProp5(_el$31, "flexShrink", 0);
    _$insertNode5(_el$32, _el$33);
    _$insertNode5(_el$32, _el$43);
    _$insertNode5(_el$32, _el$45);
    _$insertNode5(_el$32, _el$47);
    _$insertNode5(_el$32, _el$49);
    _$insert5(_el$33, (() => {
      var _c$3 = _$memo5(() => !!detachedCmd());
      return () => _c$3() ? "detached \u2014 input unavailable \xB7 " : processRunning() ? "type to write \xB7 " : "saved log \xB7 ";
    })());
    _$insert5(_el$32, _$createComponent5(Show5, {
      get when() {
        return !detachedCmd();
      },
      get children() {
        return [(() => {
          var _el$34 = _$createElement5("span");
          _$insertNode5(_el$34, _$createTextNode5(`Ctrl+C`));
          _$effect5((_$p) => _$setProp5(_el$34, "style", {
            fg: theme().warning,
            bold: true
          }, _$p));
          return _el$34;
        })(), (() => {
          var _el$36 = _$createElement5("span");
          _$insertNode5(_el$36, _$createTextNode5(` interrupt \xB7 `));
          _$effect5((_$p) => _$setProp5(_el$36, "style", {
            fg: theme().textMuted
          }, _$p));
          return _el$36;
        })()];
      }
    }), _el$43);
    _$insert5(_el$32, _$createComponent5(Show5, {
      get when() {
        return (view()?.scrollBelow ?? 0) > 0;
      },
      get children() {
        return [(() => {
          var _el$38 = _$createElement5("span"), _el$39 = _$createTextNode5(`\u2191`), _el$40 = _$createTextNode5(` \u2193`);
          _$insertNode5(_el$38, _el$39);
          _$insertNode5(_el$38, _el$40);
          _$insert5(_el$38, () => view()?.scrollAbove, _el$40);
          _$insert5(_el$38, () => view()?.scrollBelow, null);
          _$effect5((_$p) => _$setProp5(_el$38, "style", {
            fg: theme().accent,
            bold: true
          }, _$p));
          return _el$38;
        })(), (() => {
          var _el$41 = _$createElement5("span");
          _$insertNode5(_el$41, _$createTextNode5(` \xB7 `));
          _$effect5((_$p) => _$setProp5(_el$41, "style", {
            fg: theme().textMuted
          }, _$p));
          return _el$41;
        })()];
      }
    }), _el$43);
    _$insertNode5(_el$43, _$createTextNode5(`Shift+PgUp/PgDn`));
    _$insertNode5(_el$45, _$createTextNode5(` or wheel scroll \xB7 `));
    _$insertNode5(_el$47, _$createTextNode5(`Ctrl+]`));
    _$insertNode5(_el$49, _$createTextNode5(` detach (keeps running)`));
    _$insertNode5(_el$51, _el$52);
    _$insertNode5(_el$52, _el$53);
    _$insertNode5(_el$52, _el$54);
    _$insert5(_el$52, dims, _el$53);
    _$insert5(_el$52, () => view()?.totalBytes ?? 0, _el$54);
    _$effect5((_p$) => {
      var _v$8 = {
        fg: theme().primary,
        bold: true
      }, _v$9 = {
        fg: theme().textMuted
      }, _v$0 = {
        fg: cmd() && !processRunning() ? theme().warning : view()?.connection === "stream" ? theme().success : view()?.connection === "polling" ? theme().warning : theme().error
      }, _v$1 = {
        fg: theme().textMuted
      }, _v$10 = {
        fg: theme().textMuted
      }, _v$11 = {
        fg: theme().warning,
        bold: true
      }, _v$12 = {
        fg: theme().textMuted
      }, _v$13 = {
        fg: theme().warning,
        bold: true
      }, _v$14 = {
        fg: theme().textMuted
      }, _v$15 = {
        fg: theme().textMuted
      };
      _v$8 !== _p$.e && (_p$.e = _$setProp5(_el$4, "style", _v$8, _p$.e));
      _v$9 !== _p$.t && (_p$.t = _$setProp5(_el$9, "style", _v$9, _p$.t));
      _v$0 !== _p$.a && (_p$.a = _$setProp5(_el$1, "style", _v$0, _p$.a));
      _v$1 !== _p$.o && (_p$.o = _$setProp5(_el$13, "style", _v$1, _p$.o));
      _v$10 !== _p$.i && (_p$.i = _$setProp5(_el$33, "style", _v$10, _p$.i));
      _v$11 !== _p$.n && (_p$.n = _$setProp5(_el$43, "style", _v$11, _p$.n));
      _v$12 !== _p$.s && (_p$.s = _$setProp5(_el$45, "style", _v$12, _p$.s));
      _v$13 !== _p$.h && (_p$.h = _$setProp5(_el$47, "style", _v$13, _p$.h));
      _v$14 !== _p$.r && (_p$.r = _$setProp5(_el$49, "style", _v$14, _p$.r));
      _v$15 !== _p$.d && (_p$.d = _$setProp5(_el$52, "style", _v$15, _p$.d));
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
  const directoryFor = (sessionID = currentRouteSessionID(api)) => (sessionID ? api.state.session?.get(sessionID)?.directory : undefined) || api.state.path.directory;
  let terminalRouteAvailable = false;
  let unregisterTerminalRoute;
  try {
    unregisterTerminalRoute = api.route.register([{
      name: TERMINAL_ROUTE_NAME,
      render: ({
        params
      }) => _$createComponent6(TerminalView, {
        api,
        get directory() {
          return directoryFor(params?.ownerSessionID);
        },
        data: params
      })
    }]);
    terminalRouteAvailable = true;
  } catch {
    terminalRouteAvailable = false;
  }
  const openTerminal = (commandID, ownerSessionID, returnSessionID) => {
    const directory = directoryFor(ownerSessionID);
    if (terminalRouteAvailable && navigateToTerminalV1(api, commandID, ownerSessionID, returnSessionID))
      return;
    const previousFocus = api.renderer.currentFocusedRenderable;
    api.ui.dialog.replace(() => _$createComponent6(CommandPanel, {
      api,
      directory,
      ownerSessionID,
      onOpenCommand: (payload) => openTerminal(payload.commandID, payload.ownerSessionID, payload.returnSessionID)
    }));
    api.ui.dialog.setSize("xlarge");
    previousFocus?.blur();
  };
  const open = () => {
    const directory = directoryFor();
    const previousFocus = api.renderer.currentFocusedRenderable;
    api.ui.dialog.replace(() => _$createComponent6(LoopDashboard, {
      api,
      directory,
      onOpenCommand: (payload) => openTerminal(payload.commandID, payload.ownerSessionID, payload.returnSessionID)
    }));
    api.ui.dialog.setSize("xlarge");
    previousFocus?.blur();
  };
  const openCommands = () => {
    const directory = directoryFor();
    const previousFocus = api.renderer.currentFocusedRenderable;
    api.ui.dialog.replace(() => _$createComponent6(LoopDashboard, {
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
  const fb = t.feedback ?? text.feedback ?? {};
  const bg = t.background ?? {};
  const raised = bg.raised ?? bg.surface ?? bg.elevated ?? {};
  const borderTokens = t.border ?? {};
  const hue = t.hue ?? {};
  const diff = t.diff ?? {};
  const diffText = diff.text ?? {};
  const diffBg = diff.background ?? {};
  const diffHi = diff.highlight ?? {};
  const diffLn = diff.lineNumber ?? {};
  const syntax = t.syntax ?? {};
  const md = t.markdown ?? {};
  const pick = (...values) => values.find((value) => value !== undefined && value !== null);
  const base = pick(text.base, text.default, text.primary, t.foreground, "#e8e8f0");
  const muted = pick(text.muted, text.subdued, text.secondary, "#9a9ab0");
  const primary = pick(hue.interactive?.[200], hue.interactive?.[300], hue.primary?.[200], hue.violet?.[300], text.formfield?.focused, text.action?.primary?.selected, text.link, "#a78bfa");
  const accent = pick(hue.accent?.[200], hue.pink?.[300], hue.violet?.[400], text.action?.primary?.focused, text.accent, primary, "#f472b6");
  const background = pick(bg.base, bg.default, bg.canvas, "#13131a");
  return {
    text: base,
    textMuted: muted,
    primary,
    secondary: pick(hue.accent?.[300], hue.violet?.[300], accent, "#c4b5fd"),
    accent,
    success: pick(fb.success?.base, fb.success?.default, fb.success, hue.green?.[300], "#34d399"),
    warning: pick(fb.warning?.base, fb.warning?.default, fb.warning, hue.yellow?.[300], "#fbbf24"),
    error: pick(fb.error?.base, fb.error?.default, fb.error, hue.red?.[300], "#f87171"),
    info: pick(fb.info?.base, fb.info?.default, fb.info, hue.blue?.[300], accent, "#60a5fa"),
    selectedListItemText: pick(text.action?.primary?.focused, text.selected, base),
    background,
    backgroundPanel: pick(raised.base, raised.overlay, raised.surface, bg.panel, "#1e1e2a"),
    backgroundElement: pick(raised.high, raised.offset, raised.elevated, bg.element, "#252535"),
    backgroundMenu: pick(raised.max, raised.high, bg.menu, "#2a2a3a"),
    border: pick(borderTokens.base, borderTokens.default, t.borderColor, muted, "#3a3a4a"),
    borderActive: pick(t.scrollbar?.base, hue.interactive?.[200], primary, "#a78bfa"),
    borderSubtle: pick(borderTokens.subtle, borderTokens.muted, "rgba(154,154,176,0.18)"),
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
  const directoryFor = (sessionID) => {
    const route = ctx.ui.router.current();
    const id = sessionID ?? (route.type === "session" ? route.sessionID : undefined);
    return (id ? ctx.data.session.get(id)?.location?.directory : undefined) || ctx.data.location.default().directory || directory;
  };
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
  let explicitClose = false;
  const closeDialog = () => {
    explicitClose = true;
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
      }) => _$createComponent6(TerminalView, {
        api: facade,
        get directory() {
          return directoryFor(data?.ownerSessionID);
        },
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
  const showDashboardDialog = (initialView, restoredState) => {
    const directory = directoryFor();
    const previousFocus = ctx.renderer.currentFocusedRenderable;
    explicitClose = false;
    dialogOpen = true;
    ctx.ui.dialog.show(() => _$createComponent6(LoopDashboard, {
      api: facade,
      directory,
      initialView,
      restoredState,
      onOpenCommand: (payload) => {
        openTerminal(payload.commandID, payload.ownerSessionID, payload.returnSessionID);
      }
    }), () => {
      if (!explicitClose && tryDismissDashboardSubPopup()) {
        const snapshot = getSavedDashboardState();
        queueMicrotask(() => {
          showDashboardDialog(initialView, snapshot);
        });
        return;
      }
      dialogOpen = false;
    });
    ctx.ui.dialog.set({
      size: "xlarge"
    });
    previousFocus?.blur();
  };
  const open = () => showDashboardDialog(undefined);
  const openCommands = () => showDashboardDialog("commands");
  const command = "opencode.loopd.dashboard";
  const commandsCommand = "opencode.loopd.commands";
  const commandsPanel = "opencode.loopd.commands";
  const unclaimCommandPanel = ctx.ui.slot({
    append: "session.panel",
    render: (input) => input.name === commandsPanel ? _$createComponent6(LoopDashboard, {
      api: facade,
      get directory() {
        return directoryFor(input.sessionID);
      },
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
        const escapeCmd = "opencode.loopd.escape";
        ctx.keymap.layer(() => ({
          mode: "global",
          priority: 1e4,
          enabled: () => dialogOpen || isDashboardProjectPickerOpen(),
          commands: [{
            id: escapeCmd,
            bind: "escape",
            run: (_input, event) => {
              if (event?.defaultPrevented)
                return;
              if (tryDismissDashboardSubPopup()) {
                event?.preventDefault?.();
                event?.stopPropagation?.();
                return;
              }
              closeDialog();
            }
          }],
          bindings: [escapeCmd]
        }));
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

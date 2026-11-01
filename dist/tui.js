// @bun
var __require = import.meta.require;

// src/tui/plugin.tsx
import { createComponent as _$createComponent6 } from "@opentui/solid";

// src/tui/dashboard.tsx
import { createComponent as _$createComponent3 } from "@opentui/solid";
import { spread as _$spread } from "@opentui/solid";
import { mergeProps as _$mergeProps } from "@opentui/solid";
import { createTextNode as _$createTextNode3 } from "@opentui/solid";
import { memo as _$memo3 } from "@opentui/solid";
import { insertNode as _$insertNode3 } from "@opentui/solid";
import { effect as _$effect3 } from "@opentui/solid";
import { insert as _$insert3 } from "@opentui/solid";
import { setProp as _$setProp3 } from "@opentui/solid";
import { use as _$use } from "@opentui/solid";
import { createElement as _$createElement3 } from "@opentui/solid";
import { batch, createSignal, For as For3, Show as Show2, onCleanup, onMount, createEffect } from "solid-js";
import { useKeyboard } from "@opentui/solid";

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
function commandHelp() {
  return [
    "Modes: : insert \u2192 send/commands | Ctrl+N \u2192 normal | ? toggle help | Shift+B bug report",
    "Nav: j/k move | g/G top/bottom | o open child | c toggle done | p/r/R/x pause/resume/retry/clear | A abort worker | N nudge | W release fence | L logs | q close",
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
    "  :release [--call <id>|--goal <id>|--session <id>]  Inspect or release workspace fences (W releases the selected goal's)",
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
function dashboardViewForKey(key) {
  if (key === "l")
    return "commands";
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

// src/server/managed-status.ts
import path3 from "path";

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
function managedStorePath(directory) {
  return path3.join(directory, ".opencode", "loopd");
}
async function resolveManagedDirs2(currentDir, extra) {
  return resolveManagedDirs(currentDir, { extra });
}
async function statusForDirectory(directory) {
  const storePath = managedStorePath(directory);
  try {
    const state = await readState(directory);
    const goals = state.goals ?? [];
    const blockedGoals = goals.filter((g) => g.status === "blocked");
    return {
      directory,
      storePath,
      total: goals.length,
      active: goals.filter((g) => g.status === "active").length,
      blocked: blockedGoals.length,
      paused: goals.filter((g) => g.status === "paused").length,
      complete: goals.filter((g) => g.status === "complete").length,
      blockedItems: blockedGoals.map((g) => ({
        goalID: g.id,
        name: g.name,
        reason: g.blocker?.reason ?? "blocked",
        needed: g.blocker?.needed ?? ""
      }))
    };
  } catch (error) {
    return {
      directory,
      storePath,
      total: 0,
      active: 0,
      blocked: 0,
      paused: 0,
      complete: 0,
      blockedItems: [],
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
async function statusAll(managedDirs) {
  const out = [];
  for (const dir of managedDirs.length > 0 ? managedDirs : ["."]) {
    out.push(await statusForDirectory(dir));
  }
  return out;
}

// src/tui/dashboard-presentation.ts
var ATTENTION_STATES = new Set(["blocked", "budget_limited", "usage_limited"]);
function toRowModel(goal, directory, runtime, now, opts) {
  const activity = runtime ? workerActivityLabel(runtime, now) : undefined;
  const stateLabel = goalStatusShort(goal.status);
  let attention = null;
  let attentionText;
  if (goal.status === "blocked") {
    attention = "blocker";
    attentionText = goal.blocker?.reason?.slice(0, 100) ?? "blocked";
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
    } else if ((rt.consecutiveFailures ?? 0) > 0) {
      attention = "error";
      attentionText = `${rt.consecutiveFailures} failures`;
    } else if ((rt.evaluatorRejectionCount ?? 0) > 0) {
      attention = "error";
      attentionText = `${rt.evaluatorRejectionCount} check rejections`;
    }
  }
  const maxTurns = goal.config?.maxTurns;
  const turnText = runtime ? `${runtime.budgetTurnCount}${maxTurns ? `/${maxTurns}` : ""}` : undefined;
  const manual = goal.interactive === true;
  const label = manual && goal.status === "active" ? "Active, waiting on you (manual)" : stateLabel;
  return {
    id: goal.id,
    directory,
    name: goal.name,
    state: goal.status,
    stateLabel: label,
    activity: activity ? `${activity.short} \u2014 ${activity.hint}` : "no runtime yet",
    updated: ageText(runtime?.lastProgressAt ?? runtime?.lastRunAt, now),
    attention,
    attentionText,
    turnText,
    manual
  };
}
var ROW_COLS = { name: 22, state: 30, updated: 9 };
function col(text, width) {
  const chars = [...text];
  if (chars.length > width)
    return `${chars.slice(0, width - 1).join("")}\u2026`;
  return text + " ".repeat(width - chars.length);
}
function formatRowColumns(row, activityWidth = 24) {
  return {
    name: col(row.name, ROW_COLS.name),
    state: col(row.stateLabel, ROW_COLS.state),
    activity: col(row.activity, activityWidth),
    updated: col(row.updated, ROW_COLS.updated)
  };
}
var FOOT_HINTS = [
  "1/2/3 tabs",
  "j/k move",
  "Enter actions",
  "s send",
  "d details",
  "o session",
  "t coordination",
  "/ filter",
  "h history",
  "? help"
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
import { effect as _$effect } from "@opentui/solid";
import { createTextNode as _$createTextNode } from "@opentui/solid";
import { insertNode as _$insertNode } from "@opentui/solid";
import { memo as _$memo } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
import { setProp as _$setProp } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
import { For, Show } from "solid-js";
function GoalInspector(props) {
  const theme = () => props.theme;
  const m = () => props.model;
  const statusFg = () => statusColor(m().goal.status, theme());
  return (() => {
    var _el$ = _$createElement("box"), _el$2 = _$createElement("text"), _el$3 = _$createElement("span"), _el$4 = _$createElement("span"), _el$5 = _$createTextNode(` / `), _el$6 = _$createElement("span"), _el$8 = _$createElement("span"), _el$9 = _$createTextNode(`
`), _el$0 = _$createElement("span"), _el$10 = _$createElement("span"), _el$12 = _$createElement("span"), _el$14 = _$createElement("span"), _el$16 = _$createElement("span"), _el$18 = _$createElement("span"), _el$20 = _$createElement("span");
    _$insertNode(_el$, _el$2);
    _$setProp(_el$, "flexDirection", "column");
    _$setProp(_el$, "border", true);
    _$setProp(_el$, "padding", 1);
    _$setProp(_el$, "flexShrink", 0);
    _$setProp(_el$, "maxHeight", 9);
    _$insertNode(_el$2, _el$3);
    _$insertNode(_el$2, _el$4);
    _$insertNode(_el$2, _el$6);
    _$insertNode(_el$2, _el$8);
    _$insertNode(_el$2, _el$9);
    _$insertNode(_el$2, _el$0);
    _$insertNode(_el$2, _el$10);
    _$insertNode(_el$2, _el$12);
    _$insertNode(_el$2, _el$14);
    _$insertNode(_el$2, _el$16);
    _$insertNode(_el$2, _el$18);
    _$insertNode(_el$2, _el$20);
    _$insert(_el$3, () => m().goal.name);
    _$insertNode(_el$4, _el$5);
    _$insert(_el$4, () => m().directory.split("/").pop() ?? m().directory, null);
    _$insertNode(_el$6, _$createTextNode(` \u2502 Now: `));
    _$insert(_el$8, () => m().activityLine ?? "\u2014");
    _$insert(_el$2, (() => {
      var _c$ = _$memo(() => !!m().blocked);
      return () => _c$() ? [(() => {
        var _el$22 = _$createElement("span"), _el$23 = _$createTextNode(`
\u2716 Blocked: `);
        _$insertNode(_el$22, _el$23);
        _$effect((_$p) => _$setProp(_el$22, "style", {
          fg: theme().error,
          bold: true
        }, _$p));
        return _el$22;
      })(), (() => {
        var _el$25 = _$createElement("span");
        _$insert(_el$25, () => m().blocked.reason.slice(0, 140));
        _$effect((_$p) => _$setProp(_el$25, "style", {
          fg: theme().error
        }, _$p));
        return _el$25;
      })(), (() => {
        var _el$26 = _$createElement("span"), _el$27 = _$createTextNode(` \u2014 `);
        _$insertNode(_el$26, _el$27);
        _$insert(_el$26, () => m().blocked.needed.slice(0, 60), null);
        _$effect((_$p) => _$setProp(_el$26, "style", {
          fg: theme().textMuted
        }, _$p));
        return _el$26;
      })()] : _$memo(() => !!m().lastResult)() ? [(() => {
        var _el$28 = _$createElement("span");
        _$insertNode(_el$28, _$createTextNode(`
`));
        _$effect((_$p) => _$setProp(_el$28, "style", {
          fg: theme().textMuted
        }, _$p));
        return _el$28;
      })(), (() => {
        var _el$30 = _$createElement("span");
        _$insert(_el$30, () => m().lastResult.slice(0, 160));
        _$effect((_$p) => _$setProp(_el$30, "style", {
          fg: theme().text
        }, _$p));
        return _el$30;
      })()] : null;
    })(), _el$9);
    _$insertNode(_el$0, _$createTextNode(`[s] Send`));
    _$insertNode(_el$10, _$createTextNode(` \xB7 `));
    _$insertNode(_el$12, _$createTextNode(`[o] Open session`));
    _$insertNode(_el$14, _$createTextNode(` \xB7 `));
    _$insertNode(_el$16, _$createTextNode(`[Enter] Actions`));
    _$insertNode(_el$18, _$createTextNode(` \xB7 `));
    _$insertNode(_el$20, _$createTextNode(`[d] Details`));
    _$insert(_el$2, (() => {
      var _c$2 = _$memo(() => !!m().showFocusProject);
      return () => _c$2() && [(() => {
        var _el$31 = _$createElement("span");
        _$insertNode(_el$31, _$createTextNode(` \xB7 `));
        _$effect((_$p) => _$setProp(_el$31, "style", {
          fg: theme().textMuted
        }, _$p));
        return _el$31;
      })(), (() => {
        var _el$33 = _$createElement("span");
        _$insertNode(_el$33, _$createTextNode(`[focus] Project`));
        _$effect((_$p) => _$setProp(_el$33, "style", {
          fg: theme().warning
        }, _$p));
        return _el$33;
      })()];
    })(), null);
    _$effect((_p$) => {
      var _v$ = statusFg(), _v$2 = {
        fg: statusFg(),
        bold: true
      }, _v$3 = {
        fg: theme().textMuted
      }, _v$4 = {
        fg: theme().textMuted
      }, _v$5 = {
        fg: m().acting ? statusFg() : theme().textMuted
      }, _v$6 = {
        fg: theme().warning
      }, _v$7 = {
        fg: theme().textMuted
      }, _v$8 = {
        fg: theme().warning
      }, _v$9 = {
        fg: theme().textMuted
      }, _v$0 = {
        fg: theme().warning
      }, _v$1 = {
        fg: theme().textMuted
      }, _v$10 = {
        fg: theme().warning
      };
      _v$ !== _p$.e && (_p$.e = _$setProp(_el$, "borderColor", _v$, _p$.e));
      _v$2 !== _p$.t && (_p$.t = _$setProp(_el$3, "style", _v$2, _p$.t));
      _v$3 !== _p$.a && (_p$.a = _$setProp(_el$4, "style", _v$3, _p$.a));
      _v$4 !== _p$.o && (_p$.o = _$setProp(_el$6, "style", _v$4, _p$.o));
      _v$5 !== _p$.i && (_p$.i = _$setProp(_el$8, "style", _v$5, _p$.i));
      _v$6 !== _p$.n && (_p$.n = _$setProp(_el$0, "style", _v$6, _p$.n));
      _v$7 !== _p$.s && (_p$.s = _$setProp(_el$10, "style", _v$7, _p$.s));
      _v$8 !== _p$.h && (_p$.h = _$setProp(_el$12, "style", _v$8, _p$.h));
      _v$9 !== _p$.r && (_p$.r = _$setProp(_el$14, "style", _v$9, _p$.r));
      _v$0 !== _p$.d && (_p$.d = _$setProp(_el$16, "style", _v$0, _p$.d));
      _v$1 !== _p$.l && (_p$.l = _$setProp(_el$18, "style", _v$1, _p$.l));
      _v$10 !== _p$.u && (_p$.u = _$setProp(_el$20, "style", _v$10, _p$.u));
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
      u: undefined
    });
    return _el$;
  })();
}
function GoalDetailsDrawer(props) {
  const theme = () => props.theme;
  const m = () => props.model;
  const g = () => m().goal;
  const row = (label, value) => (() => {
    var _el$35 = _$createElement("box"), _el$36 = _$createElement("text"), _el$37 = _$createElement("span"), _el$38 = _$createTextNode(`: `), _el$39 = _$createElement("span");
    _$insertNode(_el$35, _el$36);
    _$setProp(_el$35, "flexDirection", "column");
    _$setProp(_el$35, "flexShrink", 0);
    _$setProp(_el$35, "paddingLeft", 1);
    _$setProp(_el$35, "paddingRight", 1);
    _$insertNode(_el$36, _el$37);
    _$insertNode(_el$36, _el$39);
    _$setProp(_el$36, "wrapMode", "word");
    _$setProp(_el$36, "minWidth", 0);
    _$insertNode(_el$37, _el$38);
    _$insert(_el$37, label, _el$38);
    _$insert(_el$39, value);
    _$effect((_p$) => {
      var _v$11 = {
        fg: theme().textMuted
      }, _v$12 = {
        fg: theme().text
      };
      _v$11 !== _p$.e && (_p$.e = _$setProp(_el$37, "style", _v$11, _p$.e));
      _v$12 !== _p$.t && (_p$.t = _$setProp(_el$39, "style", _v$12, _p$.t));
      return _p$;
    }, {
      e: undefined,
      t: undefined
    });
    return _el$35;
  })();
  return (() => {
    var _el$40 = _$createElement("box"), _el$41 = _$createElement("scrollbox"), _el$42 = _$createElement("box"), _el$43 = _$createElement("text"), _el$44 = _$createElement("span"), _el$46 = _$createElement("span");
    _$insertNode(_el$40, _el$41);
    _$setProp(_el$40, "flexDirection", "column");
    _$setProp(_el$40, "border", true);
    _$setProp(_el$40, "flexShrink", 0);
    _$setProp(_el$40, "flexGrow", 1);
    _$setProp(_el$40, "minHeight", 6);
    _$insertNode(_el$41, _el$42);
    _$setProp(_el$41, "flexDirection", "column");
    _$setProp(_el$41, "flexGrow", 1);
    _$setProp(_el$41, "minHeight", 0);
    _$setProp(_el$41, "scrollX", false);
    _$setProp(_el$41, "scrollY", true);
    _$setProp(_el$41, "stickyScroll", false);
    _$insert(_el$41, () => row("agent / model", `${m().agentLabel} \xB7 ${m().modelLabel}`), _el$42);
    _$insert(_el$41, () => row("budget / turns", `${formatCost(g().costUsed)} \xB7 ${formatTokens(g().tokensUsed)} tokens \xB7 ${formatDuration(g().timeUsedSeconds)}`), _el$42);
    _$insert(_el$41, () => row("objective", g().objective), _el$42);
    _$insert(_el$41, () => row("scope", (() => {
      const writeable = g().config.workspaceWrite !== false;
      const scope = g().config.write_scope;
      if (!writeable)
        return "(read-only)";
      if (scope === undefined)
        return "whole workspace (legacy exclusive)";
      if (scope.length === 0)
        return "exploration only";
      return scope.join(", ");
    })()), _el$42);
    _$insert(_el$41, () => row("checks", (g().config.checks ?? []).join(" \xB7 ") || "none"), _el$42);
    _$insert(_el$41, () => row("goal / worker", `${g().id} \xB7 ${g().workerSessionID ?? "\u2014"}`), _el$42);
    _$insert(_el$41, () => row("owner", g().ownerSessionID ?? "\u2014"), _el$42);
    _$insertNode(_el$42, _el$43);
    _$setProp(_el$42, "flexDirection", "column");
    _$setProp(_el$42, "flexShrink", 0);
    _$setProp(_el$42, "paddingLeft", 1);
    _$setProp(_el$42, "paddingRight", 1);
    _$setProp(_el$42, "paddingTop", 1);
    _$insertNode(_el$43, _el$44);
    _$insertNode(_el$43, _el$46);
    _$insertNode(_el$44, _$createTextNode(`Recent activity`));
    _$insertNode(_el$46, _$createTextNode(` \u2014 newest last`));
    _$insert(_el$41, _$createComponent(For, {
      get each() {
        return m().progressHistory.slice(-5);
      },
      children: (p) => (() => {
        var _el$48 = _$createElement("box"), _el$49 = _$createElement("text"), _el$50 = _$createElement("span"), _el$52 = _$createElement("span");
        _$insertNode(_el$48, _el$49);
        _$setProp(_el$48, "flexDirection", "column");
        _$setProp(_el$48, "flexShrink", 0);
        _$setProp(_el$48, "paddingLeft", 1);
        _$setProp(_el$48, "paddingRight", 1);
        _$insertNode(_el$49, _el$50);
        _$insertNode(_el$49, _el$52);
        _$setProp(_el$49, "wrapMode", "word");
        _$setProp(_el$49, "minWidth", 0);
        _$insertNode(_el$50, _$createTextNode(`\u2713 `));
        _$insert(_el$52, () => p.summary);
        _$insert(_el$48, _$createComponent(Show, {
          get when() {
            return p.next;
          },
          get children() {
            var _el$53 = _$createElement("text"), _el$54 = _$createElement("span"), _el$55 = _$createTextNode(` next: `);
            _$insertNode(_el$53, _el$54);
            _$setProp(_el$53, "wrapMode", "word");
            _$setProp(_el$53, "minWidth", 0);
            _$insertNode(_el$54, _el$55);
            _$insert(_el$54, () => p.next, null);
            _$effect((_$p) => _$setProp(_el$54, "style", {
              fg: theme().textMuted
            }, _$p));
            return _el$53;
          }
        }), null);
        _$effect((_p$) => {
          var _v$16 = {
            fg: theme().textMuted
          }, _v$17 = {
            fg: theme().text
          };
          _v$16 !== _p$.e && (_p$.e = _$setProp(_el$50, "style", _v$16, _p$.e));
          _v$17 !== _p$.t && (_p$.t = _$setProp(_el$52, "style", _v$17, _p$.t));
          return _p$;
        }, {
          e: undefined,
          t: undefined
        });
        return _el$48;
      })()
    }), null);
    _$insert(_el$41, _$createComponent(For, {
      get each() {
        return m().transcript.slice(-10);
      },
      children: (line) => (() => {
        var _el$56 = _$createElement("box"), _el$57 = _$createElement("text"), _el$58 = _$createElement("span");
        _$insertNode(_el$56, _el$57);
        _$setProp(_el$56, "flexDirection", "column");
        _$setProp(_el$56, "flexShrink", 0);
        _$setProp(_el$56, "paddingLeft", 1);
        _$setProp(_el$56, "paddingRight", 1);
        _$insertNode(_el$57, _el$58);
        _$setProp(_el$57, "wrapMode", "word");
        _$setProp(_el$57, "minWidth", 0);
        _$insert(_el$58, line);
        _$effect((_$p) => _$setProp(_el$58, "style", {
          fg: theme().textMuted
        }, _$p));
        return _el$56;
      })()
    }), null);
    _$effect((_p$) => {
      var _v$13 = theme().border, _v$14 = {
        fg: theme().accent,
        bold: true
      }, _v$15 = {
        fg: theme().textMuted
      };
      _v$13 !== _p$.e && (_p$.e = _$setProp(_el$40, "borderColor", _v$13, _p$.e));
      _v$14 !== _p$.t && (_p$.t = _$setProp(_el$44, "style", _v$14, _p$.t));
      _v$15 !== _p$.a && (_p$.a = _$setProp(_el$46, "style", _v$15, _p$.a));
      return _p$;
    }, {
      e: undefined,
      t: undefined,
      a: undefined
    });
    return _el$40;
  })();
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
    case "usage_limited":
      return theme.accent;
    default:
      return theme.text;
  }
}

// src/tui/coordination-panel.tsx
import { createComponent as _$createComponent2 } from "@opentui/solid";
import { memo as _$memo2 } from "@opentui/solid";
import { setProp as _$setProp2 } from "@opentui/solid";
import { effect as _$effect2 } from "@opentui/solid";
import { insert as _$insert2 } from "@opentui/solid";
import { createTextNode as _$createTextNode2 } from "@opentui/solid";
import { insertNode as _$insertNode2 } from "@opentui/solid";
import { createElement as _$createElement2 } from "@opentui/solid";
import { For as For2 } from "solid-js";
function CoordinationPanel(props) {
  const theme = () => props.theme;
  const m = () => props.model;
  const tabBtn = (id, label) => (() => {
    var _el$ = _$createElement2("span"), _el$2 = _$createTextNode2(`[`), _el$3 = _$createTextNode2(`] `);
    _$insertNode2(_el$, _el$2);
    _$insertNode2(_el$, _el$3);
    _$insert2(_el$, label, _el$3);
    _$effect2((_$p) => _$setProp2(_el$, "style", {
      fg: props.tab === id ? theme().info : theme().textMuted,
      bold: props.tab === id
    }, _$p));
    return _el$;
  })();
  return (() => {
    var _el$4 = _$createElement2("box"), _el$5 = _$createElement2("text"), _el$6 = _$createElement2("span"), _el$7 = _$createTextNode2(`Coordination / `), _el$8 = _$createElement2("span"), _el$0 = _$createTextNode2(`
`), _el$1 = _$createElement2("scrollbox");
    _$insertNode2(_el$4, _el$5);
    _$insertNode2(_el$4, _el$1);
    _$setProp2(_el$4, "flexDirection", "column");
    _$setProp2(_el$4, "border", true);
    _$setProp2(_el$4, "padding", 1);
    _$setProp2(_el$4, "flexShrink", 0);
    _$setProp2(_el$4, "maxHeight", 14);
    _$insertNode2(_el$5, _el$6);
    _$insertNode2(_el$5, _el$8);
    _$insertNode2(_el$5, _el$0);
    _$insertNode2(_el$6, _el$7);
    _$insert2(_el$6, () => m().shortName, null);
    _$insertNode2(_el$8, _$createTextNode2(` \u2014 scope = permission \xB7 ticket = current write \xB7 verification waits for quiet`));
    _$insert2(_el$5, () => tabBtn("writes", "Writes"), null);
    _$insert2(_el$5, () => tabBtn("verify", "Verification"), null);
    _$insert2(_el$5, () => tabBtn("resv", "Reservations"), null);
    _$setProp2(_el$1, "height", 9);
    _$setProp2(_el$1, "scrollX", false);
    _$setProp2(_el$1, "scrollY", true);
    _$insert2(_el$1, (() => {
      var _c$ = _$memo2(() => props.tab === "writes");
      return () => _c$() && (() => {
        var _el$10 = _$createElement2("text"), _el$11 = _$createElement2("span"), _el$13 = _$createTextNode2(`
`), _el$14 = _$createElement2("span");
        _$insertNode2(_el$10, _el$11);
        _$insertNode2(_el$10, _el$13);
        _$insertNode2(_el$10, _el$14);
        _$insertNode2(_el$11, _$createTextNode2(`Current write tickets`));
        _$insert2(_el$10, _$createComponent2(For2, {
          get each() {
            return m().holds;
          },
          get fallback() {
            return (() => {
              var _el$16 = _$createElement2("span"), _el$17 = _$createTextNode2(`
no active writes`);
              _$insertNode2(_el$16, _el$17);
              _$effect2((_$p) => _$setProp2(_el$16, "style", {
                fg: theme().textMuted
              }, _$p));
              return _el$16;
            })();
          },
          children: (h) => [(() => {
            var _el$19 = _$createElement2("span"), _el$20 = _$createTextNode2(`
HOLD `);
            _$insertNode2(_el$19, _el$20);
            _$effect2((_$p) => _$setProp2(_el$19, "style", {
              fg: theme().warning,
              bold: true
            }, _$p));
            return _el$19;
          })(), (() => {
            var _el$22 = _$createElement2("span");
            _$insert2(_el$22, () => h.files.join(", ").slice(0, 80));
            _$effect2((_$p) => _$setProp2(_el$22, "style", {
              fg: theme().text
            }, _$p));
            return _el$22;
          })(), (() => {
            var _el$23 = _$createElement2("span"), _el$24 = _$createTextNode2(` \u2014 `), _el$25 = _$createTextNode2(` \xB7 held `);
            _$insertNode2(_el$23, _el$24);
            _$insertNode2(_el$23, _el$25);
            _$insert2(_el$23, () => h.goalName, _el$25);
            _$insert2(_el$23, () => h.age, null);
            _$effect2((_$p) => _$setProp2(_el$23, "style", {
              fg: theme().textMuted
            }, _$p));
            return _el$23;
          })()]
        }), _el$13);
        _$insertNode2(_el$14, _$createTextNode2(`Queued write requests (scope claims are NOT a queue)`));
        _$insert2(_el$10, _$createComponent2(For2, {
          get each() {
            return m().queue;
          },
          get fallback() {
            return (() => {
              var _el$26 = _$createElement2("span"), _el$27 = _$createTextNode2(`
none queued`);
              _$insertNode2(_el$26, _el$27);
              _$effect2((_$p) => _$setProp2(_el$26, "style", {
                fg: theme().textMuted
              }, _$p));
              return _el$26;
            })();
          },
          children: (q) => [(() => {
            var _el$29 = _$createElement2("span"), _el$30 = _$createTextNode2(`
WAIT #`), _el$32 = _$createTextNode2(` `);
            _$insertNode2(_el$29, _el$30);
            _$insertNode2(_el$29, _el$32);
            _$insert2(_el$29, () => q.position, _el$32);
            _$effect2((_$p) => _$setProp2(_el$29, "style", {
              fg: theme().textMuted
            }, _$p));
            return _el$29;
          })(), (() => {
            var _el$33 = _$createElement2("span");
            _$insert2(_el$33, () => q.files.join(", ").slice(0, 80));
            _$effect2((_$p) => _$setProp2(_el$33, "style", {
              fg: theme().text
            }, _$p));
            return _el$33;
          })(), (() => {
            var _el$34 = _$createElement2("span"), _el$35 = _$createTextNode2(` \u2014 `), _el$36 = _$createTextNode2(` \xB7 waits for `);
            _$insertNode2(_el$34, _el$35);
            _$insertNode2(_el$34, _el$36);
            _$insert2(_el$34, () => q.goalName, _el$36);
            _$insert2(_el$34, () => q.waitsFor, null);
            _$insert2(_el$34, () => q.ownerPriority ? " \u2605owner" : "", null);
            _$effect2((_$p) => _$setProp2(_el$34, "style", {
              fg: theme().textMuted
            }, _$p));
            return _el$34;
          })()]
        }), null);
        _$effect2((_p$) => {
          var _v$4 = {
            fg: theme().textMuted
          }, _v$5 = {
            fg: theme().textMuted
          };
          _v$4 !== _p$.e && (_p$.e = _$setProp2(_el$11, "style", _v$4, _p$.e));
          _v$5 !== _p$.t && (_p$.t = _$setProp2(_el$14, "style", _v$5, _p$.t));
          return _p$;
        }, {
          e: undefined,
          t: undefined
        });
        return _el$10;
      })();
    })(), null);
    _$insert2(_el$1, (() => {
      var _c$2 = _$memo2(() => props.tab === "verify");
      return () => _c$2() && (() => {
        var _el$37 = _$createElement2("text"), _el$38 = _$createElement2("span");
        _$insertNode2(_el$37, _el$38);
        _$insertNode2(_el$38, _$createTextNode2(`Verification blockers`));
        _$insert2(_el$37, _$createComponent2(For2, {
          get each() {
            return m().verifyBlockers;
          },
          get fallback() {
            return (() => {
              var _el$40 = _$createElement2("span"), _el$41 = _$createTextNode2(`
quiet \u2014 checks can run`);
              _$insertNode2(_el$40, _el$41);
              _$effect2((_$p) => _$setProp2(_el$40, "style", {
                fg: theme().success
              }, _$p));
              return _el$40;
            })();
          },
          children: (b) => [(() => {
            var _el$43 = _$createElement2("span"), _el$44 = _$createTextNode2(`
WAIT `);
            _$insertNode2(_el$43, _el$44);
            _$effect2((_$p) => _$setProp2(_el$43, "style", {
              fg: theme().warning,
              bold: true
            }, _$p));
            return _el$43;
          })(), (() => {
            var _el$46 = _$createElement2("span");
            _$insert2(_el$46, () => b.text.slice(0, 120));
            _$effect2((_$p) => _$setProp2(_el$46, "style", {
              fg: theme().text
            }, _$p));
            return _el$46;
          })(), _$memo2(() => _$memo2(() => !!b.holder)() && (() => {
            var _el$47 = _$createElement2("span"), _el$48 = _$createTextNode2(` \u2014 `);
            _$insertNode2(_el$47, _el$48);
            _$insert2(_el$47, () => b.holder, null);
            _$effect2((_$p) => _$setProp2(_el$47, "style", {
              fg: theme().textMuted
            }, _$p));
            return _el$47;
          })()), _$memo2(() => _$memo2(() => !!b.age)() && (() => {
            var _el$49 = _$createElement2("span"), _el$50 = _$createTextNode2(` \xB7 `);
            _$insertNode2(_el$49, _el$50);
            _$insert2(_el$49, () => b.age, null);
            _$effect2((_$p) => _$setProp2(_el$49, "style", {
              fg: theme().textMuted
            }, _$p));
            return _el$49;
          })())]
        }), null);
        _$insert2(_el$37, (() => {
          var _c$4 = _$memo2(() => !!m().verifyNote);
          return () => _c$4() && [(() => {
            var _el$51 = _$createElement2("span");
            _$insertNode2(_el$51, _$createTextNode2(`
`));
            _$effect2((_$p) => _$setProp2(_el$51, "style", {
              fg: theme().textMuted
            }, _$p));
            return _el$51;
          })(), (() => {
            var _el$53 = _$createElement2("span");
            _$insert2(_el$53, () => m().verifyNote);
            _$effect2((_$p) => _$setProp2(_el$53, "style", {
              fg: theme().textMuted
            }, _$p));
            return _el$53;
          })()];
        })(), null);
        _$effect2((_$p) => _$setProp2(_el$38, "style", {
          fg: theme().textMuted
        }, _$p));
        return _el$37;
      })();
    })(), null);
    _$insert2(_el$1, (() => {
      var _c$3 = _$memo2(() => props.tab === "resv");
      return () => _c$3() && (() => {
        var _el$54 = _$createElement2("text"), _el$55 = _$createElement2("span");
        _$insertNode2(_el$54, _el$55);
        _$insertNode2(_el$55, _$createTextNode2(`Write reservations \u2014 release targets exactly one entry after confirmation`));
        _$insert2(_el$54, _$createComponent2(For2, {
          get each() {
            return m().reservations;
          },
          get fallback() {
            return (() => {
              var _el$57 = _$createElement2("span"), _el$58 = _$createTextNode2(`
none`);
              _$insertNode2(_el$57, _el$58);
              _$effect2((_$p) => _$setProp2(_el$57, "style", {
                fg: theme().textMuted
              }, _$p));
              return _el$57;
            })();
          },
          children: (r) => [(() => {
            var _el$60 = _$createElement2("span"), _el$61 = _$createTextNode2(`
`);
            _$insertNode2(_el$60, _el$61);
            _$insert2(_el$60, () => r.live ? "\u25CF LIVE " : "! ENDED ", null);
            _$effect2((_$p) => _$setProp2(_el$60, "style", {
              fg: r.live ? theme().warning : theme().error,
              bold: true
            }, _$p));
            return _el$60;
          })(), (() => {
            var _el$62 = _$createElement2("span"), _el$63 = _$createTextNode2(`\u2026`);
            _$insertNode2(_el$62, _el$63);
            _$insert2(_el$62, () => r.callID.slice(0, 12), _el$63);
            _$effect2((_$p) => _$setProp2(_el$62, "style", {
              fg: theme().text
            }, _$p));
            return _el$62;
          })(), (() => {
            var _el$64 = _$createElement2("span"), _el$65 = _$createTextNode2(` \u2014 `), _el$66 = _$createTextNode2(` \xB7 `);
            _$insertNode2(_el$64, _el$65);
            _$insertNode2(_el$64, _el$66);
            _$insert2(_el$64, () => r.goalName, _el$66);
            _$insert2(_el$64, () => r.age, null);
            _$effect2((_$p) => _$setProp2(_el$64, "style", {
              fg: theme().textMuted
            }, _$p));
            return _el$64;
          })(), `
`, (() => {
            var _el$67 = _$createElement2("span"), _el$68 = _$createTextNode2(` `);
            _$insertNode2(_el$67, _el$68);
            _$insert2(_el$67, () => r.reason, null);
            _$effect2((_$p) => _$setProp2(_el$67, "style", {
              fg: theme().textMuted
            }, _$p));
            return _el$67;
          })(), _$memo2(() => _$memo2(() => !!!r.releasable)() && (() => {
            var _el$69 = _$createElement2("span");
            _$insertNode2(_el$69, _$createTextNode2(` [release unavailable]`));
            _$effect2((_$p) => _$setProp2(_el$69, "style", {
              fg: theme().error
            }, _$p));
            return _el$69;
          })())]
        }), null);
        _$effect2((_$p) => _$setProp2(_el$55, "style", {
          fg: theme().textMuted
        }, _$p));
        return _el$54;
      })();
    })(), null);
    _$effect2((_p$) => {
      var _v$ = theme().border, _v$2 = {
        fg: theme().accent,
        bold: true
      }, _v$3 = {
        fg: theme().textMuted
      };
      _v$ !== _p$.e && (_p$.e = _$setProp2(_el$4, "borderColor", _v$, _p$.e));
      _v$2 !== _p$.t && (_p$.t = _$setProp2(_el$6, "style", _v$2, _p$.t));
      _v$3 !== _p$.a && (_p$.a = _$setProp2(_el$8, "style", _v$3, _p$.a));
      return _p$;
    }, {
      e: undefined,
      t: undefined,
      a: undefined
    });
    return _el$4;
  })();
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
function normalizeInitialView(view) {
  if (view === "goals")
    return "project";
  return view ?? "project";
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
    followPending = true;
    scroll?.requestRender();
  });
  return (() => {
    var _el$ = _$createElement3("scrollbox");
    _$use((el) => {
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
    _$effect3((_$p) => _$setProp3(_el$, "height", Math.min(props.count, 10), _$p));
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
    _$use((el) => {
      text = el;
    }, _el$3);
    _$setProp3(_el$3, "wrapMode", "none");
    _$setProp3(_el$3, "truncate", true);
    _$setProp3(_el$3, "minWidth", 0);
    _$setProp3(_el$3, "flexShrink", 1);
    _$insert3(_el$3, () => props.children);
    _$effect3((_p$) => {
      var { id: _v$, backgroundColor: _v$2 } = props;
      _v$ !== _p$.e && (_p$.e = _$setProp3(_el$2, "id", _v$, _p$.e));
      _v$2 !== _p$.t && (_p$.t = _$setProp3(_el$2, "backgroundColor", _v$2, _p$.t));
      return _p$;
    }, {
      e: undefined,
      t: undefined
    });
    return _el$2;
  })();
}
function DashboardHeader(props) {
  const theme = () => props.theme;
  const tabLabel = (id, text) => (() => {
    var _el$4 = _$createElement3("span");
    _$insert3(_el$4, () => props.tab === id ? `[${text}]` : ` ${text} `);
    _$effect3((_$p) => _$setProp3(_el$4, "style", {
      fg: props.tab === id ? theme().info : theme().textMuted,
      bold: props.tab === id
    }, _$p));
    return _el$4;
  })();
  return (() => {
    var _el$5 = _$createElement3("box"), _el$6 = _$createElement3("box"), _el$7 = _$createElement3("text"), _el$8 = _$createElement3("span"), _el$0 = _$createElement3("box"), _el$1 = _$createElement3("text"), _el$10 = _$createElement3("span"), _el$12 = _$createElement3("box"), _el$13 = _$createElement3("text"), _el$14 = _$createElement3("span"), _el$16 = _$createElement3("span"), _el$17 = _$createElement3("box"), _el$18 = _$createElement3("text"), _el$19 = _$createElement3("span"), _el$20 = _$createElement3("span"), _el$22 = _$createElement3("span"), _el$23 = _$createElement3("span"), _el$24 = _$createTextNode3(` \xB7 `), _el$25 = _$createTextNode3(` proj`);
    _$insertNode3(_el$5, _el$6);
    _$insertNode3(_el$5, _el$12);
    _$insertNode3(_el$5, _el$17);
    _$setProp3(_el$5, "flexDirection", "column");
    _$setProp3(_el$5, "flexShrink", 0);
    _$setProp3(_el$5, "gap", 0);
    _$insertNode3(_el$6, _el$7);
    _$insertNode3(_el$6, _el$0);
    _$setProp3(_el$6, "flexDirection", "row");
    _$setProp3(_el$6, "justifyContent", "space-between");
    _$setProp3(_el$6, "alignItems", "center");
    _$setProp3(_el$6, "height", 1);
    _$setProp3(_el$6, "overflow", "hidden");
    _$setProp3(_el$6, "flexShrink", 0);
    _$insertNode3(_el$7, _el$8);
    _$setProp3(_el$7, "wrapMode", "none");
    _$setProp3(_el$7, "truncate", true);
    _$setProp3(_el$7, "minWidth", 0);
    _$setProp3(_el$7, "flexShrink", 1);
    _$insertNode3(_el$8, _$createTextNode3(`\u2B22 Loop Dashboard`));
    _$insertNode3(_el$0, _el$1);
    _$setProp3(_el$0, "flexDirection", "row");
    _$setProp3(_el$0, "alignItems", "center");
    _$setProp3(_el$0, "paddingLeft", 1);
    _$setProp3(_el$0, "paddingRight", 1);
    _$spread(_el$0, _$mergeProps({
      get backgroundColor() {
        return theme().error;
      }
    }, () => ({
      onMouseDown: props.onBugReport
    })), true);
    _$insertNode3(_el$1, _el$10);
    _$insertNode3(_el$10, _$createTextNode3(`Bug Report`));
    _$setProp3(_el$10, "style", {
      fg: "white",
      bold: true
    });
    _$insertNode3(_el$12, _el$13);
    _$setProp3(_el$12, "flexDirection", "row");
    _$setProp3(_el$12, "alignItems", "center");
    _$setProp3(_el$12, "height", 1);
    _$setProp3(_el$12, "overflow", "hidden");
    _$setProp3(_el$12, "flexShrink", 0);
    _$setProp3(_el$12, "gap", 1);
    _$insertNode3(_el$13, _el$14);
    _$insertNode3(_el$13, _el$16);
    _$setProp3(_el$13, "wrapMode", "none");
    _$setProp3(_el$13, "truncate", true);
    _$setProp3(_el$13, "minWidth", 0);
    _$setProp3(_el$13, "flexShrink", 1);
    _$insert3(_el$13, () => tabLabel("project", "1 Project"), _el$14);
    _$insert3(_el$13, () => tabLabel("fleet", "2 Fleet"), _el$14);
    _$insert3(_el$13, () => tabLabel("commands", "3 Commands"), _el$14);
    _$insertNode3(_el$14, _$createTextNode3(` \u2502 `));
    _$insert3(_el$16, () => props.mode.toUpperCase());
    _$insertNode3(_el$17, _el$18);
    _$setProp3(_el$17, "flexDirection", "row");
    _$setProp3(_el$17, "alignItems", "center");
    _$setProp3(_el$17, "height", 1);
    _$setProp3(_el$17, "overflow", "hidden");
    _$setProp3(_el$17, "flexShrink", 0);
    _$insertNode3(_el$18, _el$19);
    _$insertNode3(_el$18, _el$20);
    _$insertNode3(_el$18, _el$22);
    _$insertNode3(_el$18, _el$23);
    _$setProp3(_el$18, "wrapMode", "none");
    _$setProp3(_el$18, "truncate", true);
    _$setProp3(_el$18, "minWidth", 0);
    _$setProp3(_el$18, "flexShrink", 1);
    _$insert3(_el$19, () => props.summary);
    _$insertNode3(_el$20, _$createTextNode3(` \u2502 `));
    _$insert3(_el$22, () => props.scopeName);
    _$insertNode3(_el$23, _el$24);
    _$insertNode3(_el$23, _el$25);
    _$insert3(_el$23, () => props.projCount, _el$25);
    _$effect3((_p$) => {
      var _v$3 = {
        fg: theme().info,
        bold: true
      }, _v$4 = {
        fg: theme().textMuted
      }, _v$5 = {
        fg: props.mode === "normal" ? theme().success : theme().warning,
        bold: true
      }, _v$6 = {
        fg: theme().text
      }, _v$7 = {
        fg: theme().textMuted
      }, _v$8 = {
        fg: theme().accent,
        bold: true
      }, _v$9 = {
        fg: theme().textMuted
      };
      _v$3 !== _p$.e && (_p$.e = _$setProp3(_el$8, "style", _v$3, _p$.e));
      _v$4 !== _p$.t && (_p$.t = _$setProp3(_el$14, "style", _v$4, _p$.t));
      _v$5 !== _p$.a && (_p$.a = _$setProp3(_el$16, "style", _v$5, _p$.a));
      _v$6 !== _p$.o && (_p$.o = _$setProp3(_el$19, "style", _v$6, _p$.o));
      _v$7 !== _p$.i && (_p$.i = _$setProp3(_el$20, "style", _v$7, _p$.i));
      _v$8 !== _p$.n && (_p$.n = _$setProp3(_el$22, "style", _v$8, _p$.n));
      _v$9 !== _p$.s && (_p$.s = _$setProp3(_el$23, "style", _v$9, _p$.s));
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
    return _el$5;
  })();
}
function LoopDashboard(props) {
  const theme = () => props.api.theme.current;
  const [mode, setMode] = createSignal("normal");
  const [selected, setSelected] = createSignal(0);
  const [commandInput, setCommandInput] = createSignal("");
  const [statusText, setStatusText] = createSignal("");
  const [tab, setTab] = createSignal(normalizeInitialView(props.initialView));
  const [cmdSelected, setCmdSelected] = createSignal(0);
  const [projectScope, setProjectScope] = createSignal(props.directory);
  const [cmdScope, setCmdScope] = createSignal("all");
  const [filterText, setFilterText] = createSignal("");
  const [collapsed, setCollapsed] = createSignal([]);
  const [coordOpen, setCoordOpen] = createSignal(false);
  const [coordTab, setCoordTab] = createSignal("writes");
  const [detailsOpen, setDetailsOpen] = createSignal(false);
  const [actionsOpen, setActionsOpen] = createSignal(false);
  const [selectedKey, setSelectedKey] = createSignal(undefined);
  const [pendingRelease, setPendingRelease] = createSignal(null);
  const ownerSessionID = () => props.ownerSessionID ?? currentRouteSessionID(props.api);
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
    if (showCompleted())
      return owned.map(({
        cmd
      }) => cmd);
    const terminal = ["exited", "terminated", "missing"];
    return owned.filter(({
      cmd
    }) => !terminal.includes(cmd.status)).map(({
      cmd
    }) => cmd);
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
  const [hintCols, setHintCols] = createSignal(80);
  let hintBoxEl;
  let frameEl;
  createEffect(() => {
    clock();
    const w = hintBoxEl?.width;
    if (typeof w === "number" && w > 0) {
      const cols = Math.max(20, Math.floor(w) - 20);
      if (cols !== hintCols())
        setHintCols(cols);
    }
  });
  const [events, setEvents] = createSignal([]);
  const [selectedGoal, setSelectedGoal] = createSignal(null);
  const [showLogs, setShowLogs] = createSignal(false);
  const [showHelp, setShowHelp] = createSignal(false);
  const [showCompleted, setShowCompleted] = createSignal(false);
  const [clock, setClock] = createSignal(Date.now());
  const [agentIndex, setAgentIndex] = createSignal({});
  const [managedDirList, setManagedDirList] = createSignal([props.directory]);
  const managedDirs = () => managedDirList();
  const [projectStatuses, setProjectStatuses] = createSignal(null);
  const [showProjects, setShowProjects] = createSignal(false);
  const [managedStates, setManagedStates] = createSignal({});
  async function refreshProjects() {
    try {
      setManagedDirList(await resolveManagedDirs2(props.directory));
      setProjectStatuses(await statusAll(managedDirs()));
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
  refreshProjects();
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
    const currentGoals = rowModels();
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
      const last = Math.max(0, currentGoals.length - 1);
      const selectedNow = tab() === "commands" ? cmdSelected() : selected();
      if (move === "down" && selectedNow >= last) {
        frameEl?.scrollBy({
          x: 0,
          y: 1
        });
        return;
      }
      if (move === "up" && selectedNow <= 0 && (frameEl?.scrollTop ?? 0) > 0) {
        frameEl?.scrollBy({
          x: 0,
          y: -1
        });
        return;
      }
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
    const needsWorkerTab = ["p", "r", "A", "N", "W", "model", "models", "agent", "agents"].includes(key);
    if (needsWorkerTab && tab() === "commands") {
      prevent(evt);
      setStatusText("Goal controls need the Project or Fleet tab (Tab to switch).");
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
    if (key === "h") {
      prevent(evt);
      setShowCompleted((v) => {
        const next = !v;
        setStatusText(next ? "Showing finished goals and commands." : "Hiding finished goals and commands.");
        return next;
      });
      return;
    }
    if (key === "/") {
      prevent(evt);
      setCommandInput("filter ");
      if (inputEl)
        inputEl.value = "filter ";
      setMode("insert");
      focusInput();
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
      if (!selectedGoal()) {
        setStatusText("No goal selected");
        return;
      }
      setCommandInput("send ");
      if (inputEl)
        inputEl.value = "send ";
      setMode("insert");
      focusInput();
      return;
    }
    if (isEnterKey(evt)) {
      prevent(evt);
      setActionsOpen((v) => !v);
      return;
    }
    if (pendingRelease()) {
      if (key === "y") {
        prevent(evt);
        const target = pendingRelease();
        setPendingRelease(null);
        releaseWorkspaceFences({
          callID: target.callID
        }, target.dir);
        return;
      }
      if (isEscapeKey(evt)) {
        prevent(evt);
        setPendingRelease(null);
        return;
      }
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
    if (isEscapeKey(evt)) {
      if (actionsOpen()) {
        prevent(evt);
        setActionsOpen(false);
        return;
      }
      if (detailsOpen()) {
        prevent(evt);
        setDetailsOpen(false);
        return;
      }
      if (coordOpen()) {
        prevent(evt);
        setCoordOpen(false);
        focusInput();
        return;
      }
      if (filterText()) {
        prevent(evt);
        setFilterText("");
        setStatusText("filter cleared");
        return;
      }
    }
    if (key === "W") {
      prevent(evt);
      if (fenceCount() === 0) {
        setStatusText("No workspace fences to release \u2014 nothing is blocking writes or checks.");
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
      setStatusText("No owning session (open from a session view) \u2014 release disabled.");
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
    return;
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
      case "projects": {
        setShowProjects(true);
        await refreshProjects();
        const list = projectStatuses() ?? [];
        setStatusText(list.length ? list.map((p) => `${p.directory}: ${p.total} goals (${p.active} active, ${p.blocked} blocked)`).join(" \xB7 ") : `${managedDirs().length} project(s): ${managedDirs().join(", ")}`);
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
    if (tab() === "commands" && !["q", "close"].includes(parsed.command)) {
      await executeCommandTabCommand(parsed.command, parsed.positional, parsed.raw);
      returnToNormalMode();
      return;
    }
    const verbDir = selectedGoal() ? goalDir(selectedGoal().id) : props.directory;
    const bus = clientFor(verbDir);
    if (!["help", "logs", "q", "close"].includes(parsed.command)) {
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
            setStatusText(`Unknown project "${name}" \u2014 :project lists managed dirs.`);
            break;
          }
          if (tab() === "commands")
            setCmdScope(match);
          else
            setProjectScope(match);
          setSelected(0);
          setStatusText(`scope: ${match}`);
          break;
        }
        case "collapse": {
          const name = parsed.positional.join(" ").trim();
          const dir = name ? managedDirs().find((d) => d === name || d.split("/").pop() === name) ?? null : selectedDir() || null;
          if (!dir) {
            setStatusText(`Unknown project "${name}"`);
            break;
          }
          setCollapsed(toggleCollapsed(collapsed(), dir));
          setSelected(0);
          setStatusText(collapsed().includes(dir) ? `collapsed ${dir}` : `expanded ${dir}`);
          break;
        }
        case "focus": {
          const dir = selectedDir();
          setProjectScope(dir);
          setTab("project");
          setSelected(0);
          setFilterText("");
          setStatusText(`scope: ${dir}`);
          break;
        }
        case "history": {
          setShowCompleted((v) => !v);
          setStatusText(showCompleted() ? "Showing finished goals and commands." : "Hiding finished goals and commands.");
          break;
        }
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
            setStatusText("Navigate unsupported here \u2014 read the transcript via agent tools (read_goal_transcript).");
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
            setStatusText("Usage: :agent <name> \u2014 :agents lists available agents.");
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
            setStatusText("Usage: :model <provider/model> \u2014 e.g. :model openai/gpt-5.6-sol. :models lists what's available.");
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
        case "projects": {
          setShowProjects(!showProjects());
          if (showProjects()) {
            await refreshProjects();
            const list = projectStatuses() ?? [];
            setStatusText(list.length ? list.map((p) => `${p.directory}: ${p.total} goals (${p.active} active, ${p.blocked} blocked)`).join(" \xB7 ") : `${managedDirs().length} project(s): ${managedDirs().join(", ")}`);
          }
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
  const rowModels = () => {
    const now = clock();
    const rows = activeGoals().map(({
      goal,
      dir
    }) => toRowModel(goal, dir, runtimeFor(goal.id), now));
    return filterRows(rows, filterText());
  };
  const panelOpen = () => actionsOpen() || coordOpen();
  const displayItems = () => {
    const all = rowModels();
    const rows = detailsOpen() ? all.slice(selected(), selected() + 1) : all;
    if (tab() !== "fleet")
      return rows.map((row) => ({
        kind: "row",
        row,
        index: all.indexOf(row)
      }));
    const out = [];
    for (const group of groupByDirectory(rows, collapsed())) {
      out.push({
        kind: "header",
        dir: group.directory,
        group
      });
      rows.forEach((row) => {
        if (row.directory === group.directory)
          out.push({
            kind: "row",
            row,
            index: all.indexOf(row)
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
  const recentTranscriptFor = (goalID) => events().filter((e) => e.goalID === goalID).slice(-12).map((e) => {
    const ev = e;
    return `${String(ev.type ?? "event")}${ev.summary ? ` \u2014 ${ev.summary}` : ""}`.slice(0, 160);
  });
  const paletteVerbs = () => {
    const g = selectedGoal();
    if (!g)
      return [];
    if (g.status === "paused")
      return [{
        key: "r",
        label: "Resume worker"
      }];
    if (g.status === "blocked")
      return [{
        key: "R",
        label: "Retry worker"
      }, {
        key: "p",
        label: "Pause worker"
      }];
    if (g.status === "complete")
      return [{
        key: "x",
        label: "Clear (removes goal)"
      }];
    return [{
      key: "p",
      label: "Pause worker"
    }, {
      key: "N",
      label: "Nudge with full contract"
    }];
  };
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
    const nameOf = (goalID) => goalID && goals.find((g) => g.id === goalID)?.name || (goalID ?? "").slice(0, 8);
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
        text: "live shell/command (writes unknown)",
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
      verifyNote: blockers.length === 0 ? "quiet \u2014 checks can run" : undefined,
      reservations: (st?.workspaceCalls ?? []).map((c) => ({
        callID: c.callID,
        sessionID: c.sessionID ?? "?",
        goalName: nameOf(c.goalID),
        live: true,
        releasable: false,
        reason: "liveness unconfirmed from here \u2014 Inspect refreshes from server; release asks the server, refusal names why",
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
      setStatusText("one project managed \u2014 :project lists managed dirs");
      return;
    }
    const idx = dirs.indexOf(projectScope());
    setProjectScope(dirs[(idx + dir + dirs.length) % dirs.length]);
    setSelected(0);
  }
  const scopeSummaryText = () => {
    if (tab() === "commands") {
      const running = ownerCommands().filter((c) => c.status === "running").length;
      return `${running} running \xB7 ${ownerCommands().length} shown`;
    }
    const entries = activeGoals();
    const s = summarizeScope(entries.map((e) => e.goal), (i) => {
      const rt = runtimeFor(entries[i].goal.id);
      return entries[i].goal.interactive === true && !!rt && rt.phase === "idle" && !rt.activeRunID;
    });
    return summaryText(s);
  };
  const fenceCount = () => state()?.workspaceCalls?.length || 0;
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
    const rows = rowModels();
    setSelected(Math.max(0, Math.min(selected(), Math.max(0, rows.length - 1))));
    setCmdSelected(Math.max(0, Math.min(cmdSelected(), ownerCommands().length - 1)));
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
  return (() => {
    var _el$26 = _$createElement3("box"), _el$27 = _$createElement3("box"), _el$28 = _$createElement3("scrollbox"), _el$88 = _$createElement3("box"), _el$89 = _$createElement3("text"), _el$90 = _$createElement3("span"), _el$91 = _$createElement3("input");
    _$insertNode3(_el$26, _el$27);
    _$setProp3(_el$26, "flexDirection", "column");
    _$setProp3(_el$26, "width", "100%");
    _$setProp3(_el$26, "alignItems", "center");
    _$setProp3(_el$26, "padding", 1);
    _$insertNode3(_el$27, _el$28);
    _$insertNode3(_el$27, _el$88);
    _$setProp3(_el$27, "flexDirection", "column");
    _$setProp3(_el$27, "width", "90%");
    _$setProp3(_el$27, "border", true);
    _$setProp3(_el$27, "padding", 1);
    _$insert3(_el$27, _$createComponent3(DashboardHeader, {
      get theme() {
        return theme();
      },
      get mode() {
        return mode();
      },
      get scopeName() {
        return _$memo3(() => tab() === "fleet")() ? "All projects" : _$memo3(() => tab() === "commands")() ? "Command sessions" : projectScope().split("/").pop() || projectScope();
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
      onBugReport: handleBugReport
    }), _el$28);
    _$use((el) => {
      frameEl = el;
    }, _el$28);
    _$setProp3(_el$28, "flexDirection", "column");
    _$setProp3(_el$28, "flexGrow", 1);
    _$setProp3(_el$28, "flexShrink", 1);
    _$setProp3(_el$28, "minHeight", 0);
    _$setProp3(_el$28, "scrollX", false);
    _$setProp3(_el$28, "scrollY", true);
    _$setProp3(_el$28, "stickyScroll", false);
    _$insert3(_el$28, _$createComponent3(Show2, {
      get when() {
        return showHelp();
      },
      get children() {
        var _el$29 = _$createElement3("box"), _el$30 = _$createElement3("box"), _el$31 = _$createElement3("text"), _el$32 = _$createElement3("span"), _el$33 = _$createElement3("text"), _el$34 = _$createElement3("span");
        _$insertNode3(_el$29, _el$30);
        _$insertNode3(_el$29, _el$33);
        _$setProp3(_el$29, "flexDirection", "column");
        _$setProp3(_el$29, "padding", 1);
        _$setProp3(_el$29, "border", true);
        _$setProp3(_el$29, "borderColor", "yellow");
        _$setProp3(_el$29, "flexShrink", 0);
        _$setProp3(_el$29, "maxHeight", 22);
        _$insertNode3(_el$30, _el$31);
        _$setProp3(_el$30, "flexDirection", "column");
        _$setProp3(_el$30, "padding", 1);
        _$setProp3(_el$30, "flexShrink", 1);
        _$setProp3(_el$30, "minHeight", 0);
        _$setProp3(_el$30, "overflow", "scroll");
        _$insertNode3(_el$31, _el$32);
        _$setProp3(_el$32, "style", {
          fg: "yellow",
          bold: true
        });
        _$insert3(_el$32, () => tab() === "commands" ? "\u2501\u2501\u2501 Commands: ? help  : insert  h history  X kill  R restart  x remove-done  o fullscreen  q close \u2501\u2501\u2501" : "\u2501\u2501\u2501 Keys: 1/2/3 tabs  j/k move  Enter actions  s send  d details  o session  t coordination  / filter  h history  W release  q close \u2501\u2501\u2501");
        _$insert3(_el$31, _$createComponent3(For3, {
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
                var _el$92 = _$createElement3("span");
                _$insert3(_el$92, label);
                _$effect3((_$p) => _$setProp3(_el$92, "style", {
                  fg: theme().primary,
                  bold: true
                }, _$p));
                return _el$92;
              })(), (() => {
                var _el$93 = _$createElement3("span");
                _$insertNode3(_el$93, _$createTextNode3(` `));
                _$effect3((_$p) => _$setProp3(_el$93, "style", {
                  fg: theme().textMuted
                }, _$p));
                return _el$93;
              })(), _$createComponent3(For3, {
                each: segments,
                children: (seg, idx) => {
                  const hasArrow = seg.includes("\u2192");
                  if (hasArrow) {
                    const [k, d] = seg.split("\u2192").map((s) => s.trim());
                    return [_$memo3(() => _$memo3(() => idx() > 0)() && (() => {
                      var _el$99 = _$createElement3("span");
                      _$insertNode3(_el$99, _$createTextNode3(` | `));
                      _$effect3((_$p) => _$setProp3(_el$99, "style", {
                        fg: theme().textMuted
                      }, _$p));
                      return _el$99;
                    })()), (() => {
                      var _el$95 = _$createElement3("span");
                      _$insert3(_el$95, k);
                      _$effect3((_$p) => _$setProp3(_el$95, "style", {
                        fg: theme().warning,
                        bold: true
                      }, _$p));
                      return _el$95;
                    })(), (() => {
                      var _el$96 = _$createElement3("span");
                      _$insertNode3(_el$96, _$createTextNode3(` \u2192 `));
                      _$effect3((_$p) => _$setProp3(_el$96, "style", {
                        fg: theme().textMuted
                      }, _$p));
                      return _el$96;
                    })(), (() => {
                      var _el$98 = _$createElement3("span");
                      _$insert3(_el$98, d);
                      _$effect3((_$p) => _$setProp3(_el$98, "style", {
                        fg: theme().text
                      }, _$p));
                      return _el$98;
                    })()];
                  }
                  const sp = seg.indexOf(" ");
                  const k = sp > 0 ? seg.slice(0, sp) : seg;
                  const d = sp > 0 ? seg.slice(sp + 1) : "";
                  return [_$memo3(() => _$memo3(() => idx() > 0)() && (() => {
                    var _el$102 = _$createElement3("span");
                    _$insertNode3(_el$102, _$createTextNode3(` | `));
                    _$effect3((_$p) => _$setProp3(_el$102, "style", {
                      fg: theme().textMuted
                    }, _$p));
                    return _el$102;
                  })()), (() => {
                    var _el$101 = _$createElement3("span");
                    _$insert3(_el$101, k);
                    _$effect3((_$p) => _$setProp3(_el$101, "style", {
                      fg: theme().warning,
                      bold: true
                    }, _$p));
                    return _el$101;
                  })(), d && (() => {
                    var _el$104 = _$createElement3("span"), _el$105 = _$createTextNode3(` `);
                    _$insertNode3(_el$104, _el$105);
                    _$insert3(_el$104, d, null);
                    _$effect3((_$p) => _$setProp3(_el$104, "style", {
                      fg: theme().text
                    }, _$p));
                    return _el$104;
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
                var _el$106 = _$createElement3("span");
                _$insert3(_el$106, indent);
                _$effect3((_$p) => _$setProp3(_el$106, "style", {
                  fg: theme().textMuted
                }, _$p));
                return _el$106;
              })(), (() => {
                var _el$107 = _$createElement3("span");
                _$insert3(_el$107, key);
                _$effect3((_$p) => _$setProp3(_el$107, "style", {
                  fg: theme().warning,
                  bold: true
                }, _$p));
                return _el$107;
              })(), desc && [(() => {
                var _el$108 = _$createElement3("span");
                _$insertNode3(_el$108, _$createTextNode3(` `));
                _$effect3((_$p) => _$setProp3(_el$108, "style", {
                  fg: theme().textMuted
                }, _$p));
                return _el$108;
              })(), (() => {
                var _el$110 = _$createElement3("span");
                _$insert3(_el$110, desc);
                _$effect3((_$p) => _$setProp3(_el$110, "style", {
                  fg: theme().textMuted
                }, _$p));
                return _el$110;
              })()]];
            }
            const isHeader = line.startsWith("Commands");
            return [`
`, (() => {
              var _el$111 = _$createElement3("span");
              _$insert3(_el$111, line);
              _$effect3((_$p) => _$setProp3(_el$111, "style", {
                fg: isHeader ? theme().primary : theme().textMuted,
                bold: isHeader
              }, _$p));
              return _el$111;
            })()];
          }
        }), null);
        _$insertNode3(_el$33, _el$34);
        _$insertNode3(_el$34, _$createTextNode3(`\u25BC scroll for more`));
        _$setProp3(_el$34, "style", {
          italic: true
        });
        _$effect3((_p$) => {
          var _v$0 = theme().background, _v$1 = theme().background, _v$10 = {
            fg: theme().textMuted
          };
          _v$0 !== _p$.e && (_p$.e = _$setProp3(_el$29, "backgroundColor", _v$0, _p$.e));
          _v$1 !== _p$.t && (_p$.t = _$setProp3(_el$30, "backgroundColor", _v$1, _p$.t));
          _v$10 !== _p$.a && (_p$.a = _$setProp3(_el$33, "style", _v$10, _p$.a));
          return _p$;
        }, {
          e: undefined,
          t: undefined,
          a: undefined
        });
        return _el$29;
      }
    }), null);
    _$insert3(_el$28, _$createComponent3(Show2, {
      get when() {
        return showProjects();
      },
      get children() {
        var _el$36 = _$createElement3("box"), _el$37 = _$createElement3("text"), _el$38 = _$createElement3("span"), _el$39 = _$createTextNode3(`\u2B23 Projects (`), _el$40 = _$createTextNode3(`)`), _el$41 = _$createElement3("span");
        _$insertNode3(_el$36, _el$37);
        _$setProp3(_el$36, "flexDirection", "column");
        _$setProp3(_el$36, "padding", 1);
        _$setProp3(_el$36, "border", true);
        _$setProp3(_el$36, "flexShrink", 0);
        _$setProp3(_el$36, "maxHeight", 12);
        _$insertNode3(_el$37, _el$38);
        _$insertNode3(_el$37, _el$41);
        _$insertNode3(_el$38, _el$39);
        _$insertNode3(_el$38, _el$40);
        _$insert3(_el$38, () => managedDirs().length, _el$40);
        _$insertNode3(_el$41, _$createTextNode3(` \u2014 :projects to hide \xB7 registry .opencode/loopd/managed.json (+ LOOPD_MANAGED_DIRS)`));
        _$insert3(_el$37, _$createComponent3(For3, {
          get each() {
            return projectStatuses() ?? managedDirs().map((d) => ({
              directory: d,
              storePath: managedStorePath(d),
              total: 0,
              active: 0,
              blocked: 0,
              paused: 0,
              complete: 0,
              blockedItems: []
            }));
          },
          children: (p) => [`
`, (() => {
            var _el$112 = _$createElement3("span");
            _$insert3(_el$112, () => p.directory);
            _$effect3((_$p) => _$setProp3(_el$112, "style", {
              fg: theme().text,
              bold: true
            }, _$p));
            return _el$112;
          })(), (() => {
            var _el$113 = _$createElement3("span"), _el$114 = _$createTextNode3(` \u2014 `), _el$115 = _$createTextNode3(` goals (`), _el$116 = _$createTextNode3(` active, `), _el$117 = _$createTextNode3(` blocked, `), _el$118 = _$createTextNode3(` paused, `), _el$119 = _$createTextNode3(` done)`);
            _$insertNode3(_el$113, _el$114);
            _$insertNode3(_el$113, _el$115);
            _$insertNode3(_el$113, _el$116);
            _$insertNode3(_el$113, _el$117);
            _$insertNode3(_el$113, _el$118);
            _$insertNode3(_el$113, _el$119);
            _$insert3(_el$113, () => p.total, _el$115);
            _$insert3(_el$113, () => p.active, _el$116);
            _$insert3(_el$113, () => p.blocked, _el$117);
            _$insert3(_el$113, () => p.paused, _el$118);
            _$insert3(_el$113, () => p.complete, _el$119);
            _$effect3((_$p) => _$setProp3(_el$113, "style", {
              fg: theme().textMuted
            }, _$p));
            return _el$113;
          })(), _$createComponent3(For3, {
            get each() {
              return p.blockedItems.slice(0, 3);
            },
            children: (b) => [`
`, (() => {
              var _el$120 = _$createElement3("span"), _el$121 = _$createTextNode3(` \u2716 `), _el$122 = _$createTextNode3(`: `);
              _$insertNode3(_el$120, _el$121);
              _$insertNode3(_el$120, _el$122);
              _$insert3(_el$120, () => b.name, _el$122);
              _$effect3((_$p) => _$setProp3(_el$120, "style", {
                fg: theme().error
              }, _$p));
              return _el$120;
            })(), (() => {
              var _el$123 = _$createElement3("span");
              _$insert3(_el$123, () => b.reason.slice(0, 80));
              _$effect3((_$p) => _$setProp3(_el$123, "style", {
                fg: theme().textMuted
              }, _$p));
              return _el$123;
            })()]
          })]
        }), null);
        _$effect3((_p$) => {
          var _v$11 = theme().border, _v$12 = {
            fg: theme().accent,
            bold: true
          }, _v$13 = {
            fg: theme().textMuted
          };
          _v$11 !== _p$.e && (_p$.e = _$setProp3(_el$36, "borderColor", _v$11, _p$.e));
          _v$12 !== _p$.t && (_p$.t = _$setProp3(_el$38, "style", _v$12, _p$.t));
          _v$13 !== _p$.a && (_p$.a = _$setProp3(_el$41, "style", _v$13, _p$.a));
          return _p$;
        }, {
          e: undefined,
          t: undefined,
          a: undefined
        });
        return _el$36;
      }
    }), null);
    _$insert3(_el$28, _$createComponent3(Show2, {
      get when() {
        return tab() === "project" || tab() === "fleet";
      },
      get children() {
        return [_$createComponent3(Show2, {
          get when() {
            return !panelOpen();
          },
          get children() {
            return _$createComponent3(Show2, {
              get when() {
                return rowModels().length > 0;
              },
              get fallback() {
                return (() => {
                  var _el$124 = _$createElement3("box"), _el$125 = _$createElement3("text"), _el$126 = _$createElement3("span"), _el$127 = _$createTextNode3(`No workers`), _el$128 = _$createTextNode3(`.`), _el$129 = _$createElement3("span"), _el$131 = _$createElement3("span"), _el$133 = _$createElement3("text"), _el$134 = _$createTextNode3(`Scope: `), _el$135 = _$createTextNode3(`/.opencode/loopd`), _el$136 = _$createElement3("text"), _el$137 = _$createElement3("span"), _el$139 = _$createElement3("span"), _el$141 = _$createElement3("span"), _el$143 = _$createElement3("span"), _el$145 = _$createElement3("span"), _el$147 = _$createElement3("span"), _el$149 = _$createElement3("span"), _el$151 = _$createElement3("span"), _el$153 = _$createElement3("span");
                  _$insertNode3(_el$124, _el$125);
                  _$insertNode3(_el$124, _el$133);
                  _$insertNode3(_el$124, _el$136);
                  _$setProp3(_el$124, "flexDirection", "column");
                  _$setProp3(_el$124, "gap", 1);
                  _$setProp3(_el$124, "padding", 1);
                  _$insertNode3(_el$125, _el$126);
                  _$insertNode3(_el$125, _el$129);
                  _$insertNode3(_el$125, _el$131);
                  _$insertNode3(_el$126, _el$127);
                  _$insertNode3(_el$126, _el$128);
                  _$insert3(_el$126, (() => {
                    var _c$5 = _$memo3(() => !!filterText());
                    return () => _c$5() ? ` matching "${filterText()}"` : "";
                  })(), _el$128);
                  _$insertNode3(_el$129, _$createTextNode3(` /goal`));
                  _$insertNode3(_el$131, _$createTextNode3(` in parent chat to create one.`));
                  _$insertNode3(_el$133, _el$134);
                  _$insertNode3(_el$133, _el$135);
                  _$insert3(_el$133, (() => {
                    var _c$6 = _$memo3(() => tab() === "fleet");
                    return () => _c$6() ? "all projects" : projectScope();
                  })(), _el$135);
                  _$insertNode3(_el$136, _el$137);
                  _$insertNode3(_el$136, _el$139);
                  _$insertNode3(_el$136, _el$141);
                  _$insertNode3(_el$136, _el$143);
                  _$insertNode3(_el$136, _el$145);
                  _$insertNode3(_el$136, _el$147);
                  _$insertNode3(_el$136, _el$149);
                  _$insertNode3(_el$136, _el$151);
                  _$insertNode3(_el$136, _el$153);
                  _$insertNode3(_el$137, _$createTextNode3(`Tip: `));
                  _$insertNode3(_el$139, _$createTextNode3(`s`));
                  _$insertNode3(_el$141, _$createTextNode3(` send \xB7 `));
                  _$insertNode3(_el$143, _$createTextNode3(`o`));
                  _$insertNode3(_el$145, _$createTextNode3(` open child \xB7 `));
                  _$insertNode3(_el$147, _$createTextNode3(`t`));
                  _$insertNode3(_el$149, _$createTextNode3(` coordination \xB7 `));
                  _$insertNode3(_el$151, _$createTextNode3(`/`));
                  _$insertNode3(_el$153, _$createTextNode3(` filter.`));
                  _$effect3((_p$) => {
                    var _v$39 = {
                      fg: theme().textMuted
                    }, _v$40 = {
                      fg: theme().accent
                    }, _v$41 = {
                      fg: theme().textMuted
                    }, _v$42 = {
                      fg: theme().textMuted
                    }, _v$43 = {
                      fg: theme().textMuted
                    }, _v$44 = {
                      fg: theme().warning
                    }, _v$45 = {
                      fg: theme().textMuted
                    }, _v$46 = {
                      fg: theme().warning
                    }, _v$47 = {
                      fg: theme().textMuted
                    }, _v$48 = {
                      fg: theme().warning
                    }, _v$49 = {
                      fg: theme().textMuted
                    }, _v$50 = {
                      fg: theme().warning
                    }, _v$51 = {
                      fg: theme().textMuted
                    };
                    _v$39 !== _p$.e && (_p$.e = _$setProp3(_el$126, "style", _v$39, _p$.e));
                    _v$40 !== _p$.t && (_p$.t = _$setProp3(_el$129, "style", _v$40, _p$.t));
                    _v$41 !== _p$.a && (_p$.a = _$setProp3(_el$131, "style", _v$41, _p$.a));
                    _v$42 !== _p$.o && (_p$.o = _$setProp3(_el$133, "style", _v$42, _p$.o));
                    _v$43 !== _p$.i && (_p$.i = _$setProp3(_el$137, "style", _v$43, _p$.i));
                    _v$44 !== _p$.n && (_p$.n = _$setProp3(_el$139, "style", _v$44, _p$.n));
                    _v$45 !== _p$.s && (_p$.s = _$setProp3(_el$141, "style", _v$45, _p$.s));
                    _v$46 !== _p$.h && (_p$.h = _$setProp3(_el$143, "style", _v$46, _p$.h));
                    _v$47 !== _p$.r && (_p$.r = _$setProp3(_el$145, "style", _v$47, _p$.r));
                    _v$48 !== _p$.d && (_p$.d = _$setProp3(_el$147, "style", _v$48, _p$.d));
                    _v$49 !== _p$.l && (_p$.l = _$setProp3(_el$149, "style", _v$49, _p$.l));
                    _v$50 !== _p$.u && (_p$.u = _$setProp3(_el$151, "style", _v$50, _p$.u));
                    _v$51 !== _p$.c && (_p$.c = _$setProp3(_el$153, "style", _v$51, _p$.c));
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
                  return _el$124;
                })();
              },
              get children() {
                return [(() => {
                  var _el$43 = _$createElement3("text"), _el$44 = _$createElement3("span"), _el$46 = _$createElement3("span"), _el$47 = _$createElement3("span"), _el$48 = _$createTextNode3(` \xB7 history `);
                  _$insertNode3(_el$43, _el$44);
                  _$insertNode3(_el$43, _el$46);
                  _$insertNode3(_el$43, _el$47);
                  _$insertNode3(_el$44, _$createTextNode3(`Scope `));
                  _$insert3(_el$46, (() => {
                    var _c$ = _$memo3(() => tab() === "fleet");
                    return () => _c$() ? `all projects (${managedDirs().length})` : projectScope().split("/").pop() || projectScope();
                  })());
                  _$insert3(_el$43, (() => {
                    var _c$2 = _$memo3(() => !!filterText());
                    return () => _c$2() && [(() => {
                      var _el$155 = _$createElement3("span");
                      _$insertNode3(_el$155, _$createTextNode3(` \xB7 filter `));
                      _$effect3((_$p) => _$setProp3(_el$155, "style", {
                        fg: theme().textMuted
                      }, _$p));
                      return _el$155;
                    })(), (() => {
                      var _el$157 = _$createElement3("span"), _el$158 = _$createTextNode3(`"`), _el$159 = _$createTextNode3(`"`);
                      _$insertNode3(_el$157, _el$158);
                      _$insertNode3(_el$157, _el$159);
                      _$insert3(_el$157, filterText, _el$159);
                      _$effect3((_$p) => _$setProp3(_el$157, "style", {
                        fg: theme().text
                      }, _$p));
                      return _el$157;
                    })()];
                  })(), _el$47);
                  _$insertNode3(_el$47, _el$48);
                  _$insert3(_el$47, () => showCompleted() ? "shown" : "hidden", null);
                  _$insert3(_el$43, (() => {
                    var _c$3 = _$memo3(() => !!detailsOpen());
                    return () => _c$3() && (() => {
                      var _el$160 = _$createElement3("span");
                      _$insertNode3(_el$160, _$createTextNode3(` \xB7 detail open \u2014 table collapsed to the selected row`));
                      _$effect3((_$p) => _$setProp3(_el$160, "style", {
                        fg: theme().textMuted
                      }, _$p));
                      return _el$160;
                    })();
                  })(), null);
                  _$effect3((_p$) => {
                    var _v$14 = {
                      fg: theme().textMuted
                    }, _v$15 = {
                      fg: theme().accent,
                      bold: true
                    }, _v$16 = {
                      fg: theme().textMuted
                    };
                    _v$14 !== _p$.e && (_p$.e = _$setProp3(_el$44, "style", _v$14, _p$.e));
                    _v$15 !== _p$.t && (_p$.t = _$setProp3(_el$46, "style", _v$15, _p$.t));
                    _v$16 !== _p$.a && (_p$.a = _$setProp3(_el$47, "style", _v$16, _p$.a));
                    return _p$;
                  }, {
                    e: undefined,
                    t: undefined,
                    a: undefined
                  });
                  return _el$43;
                })(), (() => {
                  var _el$49 = _$createElement3("box"), _el$50 = _$createElement3("text"), _el$51 = _$createElement3("span"), _el$52 = _$createTextNode3(`WORKER                \u2502 STATE                         \u2502 ACTIVITY`);
                  _$insertNode3(_el$49, _el$50);
                  _$setProp3(_el$49, "flexDirection", "row");
                  _$setProp3(_el$49, "paddingLeft", 3);
                  _$setProp3(_el$49, "paddingRight", 1);
                  _$setProp3(_el$49, "height", 1);
                  _$setProp3(_el$49, "flexShrink", 0);
                  _$insertNode3(_el$50, _el$51);
                  _$setProp3(_el$50, "wrapMode", "none");
                  _$setProp3(_el$50, "truncate", true);
                  _$insertNode3(_el$51, _el$52);
                  _$effect3((_$p) => _$setProp3(_el$51, "style", {
                    fg: theme().textMuted
                  }, _$p));
                  return _el$49;
                })(), _$createComponent3(DashboardList, {
                  get count() {
                    return displayItems().length;
                  },
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
                              return theme().backgroundElement;
                            },
                            get children() {
                              return [(() => {
                                var _el$162 = _$createElement3("span"), _el$163 = _$createTextNode3(` `);
                                _$insertNode3(_el$162, _el$163);
                                _$insert3(_el$162, () => collapsed().includes(g.directory) ? "\u25B8" : "\u25BE", _el$163);
                                _$insert3(_el$162, () => g.shortName, null);
                                _$effect3((_$p) => _$setProp3(_el$162, "style", {
                                  fg: theme().accent,
                                  bold: true
                                }, _$p));
                                return _el$162;
                              })(), (() => {
                                var _el$164 = _$createElement3("span"), _el$165 = _$createTextNode3(` / `), _el$166 = _$createTextNode3(` working (:collapse toggles)`);
                                _$insertNode3(_el$164, _el$165);
                                _$insertNode3(_el$164, _el$166);
                                _$insert3(_el$164, (() => {
                                  var _c$7 = _$memo3(() => g.needsAction > 0);
                                  return () => _c$7() ? `${g.needsAction} needs action \xB7 ` : "no intervention needed \xB7 ";
                                })(), _el$166);
                                _$insert3(_el$164, () => g.working, _el$166);
                                _$effect3((_$p) => _$setProp3(_el$164, "style", {
                                  fg: theme().textMuted
                                }, _$p));
                                return _el$164;
                              })()];
                            }
                          });
                        }
                        const row = item.row;
                        const isActive = () => item.index === selected();
                        const stateFg = () => row.state === "blocked" ? theme().error : row.state === "active" ? theme().success : row.state === "paused" ? theme().warning : theme().textMuted;
                        const attnFg = () => row.attention === "blocker" || row.attention === "unreachable" || row.attention === "stale" || row.attention === "error" ? theme().error : theme().warning;
                        const cols = () => formatRowColumns(row);
                        return _$createComponent3(DashboardRow, {
                          get id() {
                            return rowIdFor(row.id);
                          },
                          get backgroundColor() {
                            return _$memo3(() => !!isActive())() ? theme().backgroundElement : undefined;
                          },
                          get children() {
                            return [(() => {
                              var _el$167 = _$createElement3("span");
                              _$insert3(_el$167, (() => {
                                var _c$8 = _$memo3(() => !!isActive());
                                return () => _c$8() ? `\u25B6 ${cols().name}` : `  ${cols().name}`;
                              })());
                              _$effect3((_$p) => _$setProp3(_el$167, "style", {
                                fg: stateFg(),
                                bold: isActive()
                              }, _$p));
                              return _el$167;
                            })(), (() => {
                              var _el$168 = _$createElement3("span");
                              _$insertNode3(_el$168, _$createTextNode3(` \u2502 `));
                              _$effect3((_$p) => _$setProp3(_el$168, "style", {
                                fg: theme().textMuted
                              }, _$p));
                              return _el$168;
                            })(), (() => {
                              var _el$170 = _$createElement3("span");
                              _$insert3(_el$170, () => cols().state);
                              _$effect3((_$p) => _$setProp3(_el$170, "style", {
                                fg: stateFg(),
                                bold: true
                              }, _$p));
                              return _el$170;
                            })(), (() => {
                              var _el$171 = _$createElement3("span");
                              _$insertNode3(_el$171, _$createTextNode3(` \u2502 `));
                              _$effect3((_$p) => _$setProp3(_el$171, "style", {
                                fg: theme().textMuted
                              }, _$p));
                              return _el$171;
                            })(), (() => {
                              var _el$173 = _$createElement3("span");
                              _$insert3(_el$173, () => cols().activity);
                              _$effect3((_$p) => _$setProp3(_el$173, "style", {
                                fg: row.attention === null ? theme().text : attnFg()
                              }, _$p));
                              return _el$173;
                            })(), _$memo3(() => _$memo3(() => !!row.turnText)() && (() => {
                              var _el$176 = _$createElement3("span"), _el$177 = _$createTextNode3(` \xB7 `);
                              _$insertNode3(_el$176, _el$177);
                              _$insert3(_el$176, () => row.turnText, null);
                              _$effect3((_$p) => _$setProp3(_el$176, "style", {
                                fg: theme().textMuted
                              }, _$p));
                              return _el$176;
                            })()), (() => {
                              var _el$174 = _$createElement3("span"), _el$175 = _$createTextNode3(` \xB7 `);
                              _$insertNode3(_el$174, _el$175);
                              _$insert3(_el$174, () => cols().updated, null);
                              _$effect3((_$p) => _$setProp3(_el$174, "style", {
                                fg: theme().textMuted
                              }, _$p));
                              return _el$174;
                            })(), _$memo3(() => _$memo3(() => !!(row.attention && row.attentionText))() && (() => {
                              var _el$178 = _$createElement3("span"), _el$179 = _$createTextNode3(` \u2502 \u26A0 `);
                              _$insertNode3(_el$178, _el$179);
                              _$insert3(_el$178, () => row.attentionText.slice(0, 60), null);
                              _$effect3((_$p) => _$setProp3(_el$178, "style", {
                                fg: attnFg(),
                                bold: true
                              }, _$p));
                              return _el$178;
                            })())];
                          }
                        });
                      }
                    });
                  }
                })];
              }
            });
          }
        }), _$createComponent3(Show2, {
          get when() {
            return _$memo3(() => !!!panelOpen())() && selectedGoal();
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
            const model = () => goal().config.model;
            return [_$createComponent3(GoalInspector, {
              get theme() {
                return theme();
              },
              get model() {
                return {
                  goal: goal(),
                  directory: dir(),
                  activityLine: activity() ? `${activity().short} \u2014 ${activity().hint}` : undefined,
                  acting: activity()?.acting ?? false,
                  lastResult: lp()?.summary,
                  blocked: blk() ? {
                    reason: blk().reason,
                    needed: blk().needed
                  } : undefined,
                  lastProgress: lp() ?? undefined,
                  agentMeta: meta()?.mode,
                  showFocusProject: tab() === "fleet"
                };
              },
              onSend: () => {
                setCommandInput("send ");
                if (inputEl)
                  inputEl.value = "send ";
                setMode("insert");
                focusInput();
              },
              onOpen: () => {
                if (goal().workerSessionID) {
                  try {
                    props.api.route.navigate("session", {
                      sessionID: goal().workerSessionID
                    });
                    props.api.ui.dialog.clear();
                  } catch {
                    setStatusText("Navigate unsupported here \u2014 read the transcript via agent tools (read_goal_transcript).");
                  }
                } else
                  setStatusText("No worker session");
              },
              onActions: () => setActionsOpen(true),
              onDetails: () => setDetailsOpen((v) => !v),
              onFocusProject: () => {
                setProjectScope(dir());
                setTab("project");
                setSelected(0);
                setStatusText(`scope: ${dir()}`);
              }
            }), _$createComponent3(Show2, {
              get when() {
                return detailsOpen();
              },
              get children() {
                return _$createComponent3(GoalDetailsDrawer, {
                  get theme() {
                    return theme();
                  },
                  get model() {
                    return {
                      goal: goal(),
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
            })];
          }
        }), _$createComponent3(Show2, {
          get when() {
            return _$memo3(() => !!actionsOpen())() && selectedGoal();
          },
          get children() {
            var _el$56 = _$createElement3("box"), _el$57 = _$createElement3("text"), _el$58 = _$createElement3("span"), _el$59 = _$createTextNode3(`Actions / `), _el$60 = _$createElement3("span"), _el$62 = _$createTextNode3(`
`), _el$63 = _$createElement3("span");
            _$insertNode3(_el$56, _el$57);
            _$setProp3(_el$56, "flexDirection", "column");
            _$setProp3(_el$56, "border", true);
            _$setProp3(_el$56, "padding", 1);
            _$setProp3(_el$56, "flexShrink", 0);
            _$setProp3(_el$56, "maxHeight", 10);
            _$insertNode3(_el$57, _el$58);
            _$insertNode3(_el$57, _el$60);
            _$insertNode3(_el$57, _el$62);
            _$insertNode3(_el$57, _el$63);
            _$insertNode3(_el$58, _el$59);
            _$insert3(_el$58, () => selectedGoal().name, null);
            _$insertNode3(_el$60, _$createTextNode3(` \u2014 press the key, Esc closes`));
            _$insert3(_el$57, _$createComponent3(For3, {
              get each() {
                return paletteVerbs();
              },
              children: (v) => [(() => {
                var _el$180 = _$createElement3("span"), _el$181 = _$createTextNode3(`
[`), _el$183 = _$createTextNode3(`] `);
                _$insertNode3(_el$180, _el$181);
                _$insertNode3(_el$180, _el$183);
                _$insert3(_el$180, () => v.key, _el$183);
                _$effect3((_$p) => _$setProp3(_el$180, "style", {
                  fg: theme().warning,
                  bold: true
                }, _$p));
                return _el$180;
              })(), (() => {
                var _el$184 = _$createElement3("span");
                _$insert3(_el$184, () => v.label);
                _$effect3((_$p) => _$setProp3(_el$184, "style", {
                  fg: theme().text
                }, _$p));
                return _el$184;
              })()]
            }), _el$62);
            _$insertNode3(_el$63, _$createTextNode3(`[s] Send \xB7 [o] Open session \xB7 [d] Technical details`));
            _$effect3((_p$) => {
              var _v$17 = theme().accent, _v$18 = {
                fg: theme().accent,
                bold: true
              }, _v$19 = {
                fg: theme().textMuted
              }, _v$20 = {
                fg: theme().textMuted
              };
              _v$17 !== _p$.e && (_p$.e = _$setProp3(_el$56, "borderColor", _v$17, _p$.e));
              _v$18 !== _p$.t && (_p$.t = _$setProp3(_el$58, "style", _v$18, _p$.t));
              _v$19 !== _p$.a && (_p$.a = _$setProp3(_el$60, "style", _v$19, _p$.a));
              _v$20 !== _p$.o && (_p$.o = _$setProp3(_el$63, "style", _v$20, _p$.o));
              return _p$;
            }, {
              e: undefined,
              t: undefined,
              a: undefined,
              o: undefined
            });
            return _el$56;
          }
        }), _$createComponent3(Show2, {
          get when() {
            return coordOpen();
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
              }
            });
          }
        }), _$createComponent3(Show2, {
          get when() {
            return pendingRelease();
          },
          get children() {
            var _el$65 = _$createElement3("box"), _el$66 = _$createElement3("text"), _el$67 = _$createElement3("span"), _el$68 = _$createTextNode3(`Release `), _el$69 = _$createTextNode3(`\u2026 in `), _el$70 = _$createTextNode3(`?`), _el$71 = _$createElement3("span"), _el$73 = _$createElement3("span");
            _$insertNode3(_el$65, _el$66);
            _$setProp3(_el$65, "flexDirection", "column");
            _$setProp3(_el$65, "border", true);
            _$setProp3(_el$65, "padding", 1);
            _$setProp3(_el$65, "flexShrink", 0);
            _$insertNode3(_el$66, _el$67);
            _$insertNode3(_el$66, _el$71);
            _$insertNode3(_el$66, _el$73);
            _$insertNode3(_el$67, _el$68);
            _$insertNode3(_el$67, _el$69);
            _$insertNode3(_el$67, _el$70);
            _$insert3(_el$67, () => pendingRelease().callID.slice(0, 12), _el$69);
            _$insert3(_el$67, () => pendingRelease().dir, _el$70);
            _$insertNode3(_el$71, _$createTextNode3(` \u2014 server decides; refusal names the reason. `));
            _$insertNode3(_el$73, _$createTextNode3(`[y] release \xB7 [Esc] cancel`));
            _$effect3((_p$) => {
              var _v$21 = theme().error, _v$22 = {
                fg: theme().error,
                bold: true
              }, _v$23 = {
                fg: theme().textMuted
              }, _v$24 = {
                fg: theme().warning,
                bold: true
              };
              _v$21 !== _p$.e && (_p$.e = _$setProp3(_el$65, "borderColor", _v$21, _p$.e));
              _v$22 !== _p$.t && (_p$.t = _$setProp3(_el$67, "style", _v$22, _p$.t));
              _v$23 !== _p$.a && (_p$.a = _$setProp3(_el$71, "style", _v$23, _p$.a));
              _v$24 !== _p$.o && (_p$.o = _$setProp3(_el$73, "style", _v$24, _p$.o));
              return _p$;
            }, {
              e: undefined,
              t: undefined,
              a: undefined,
              o: undefined
            });
            return _el$65;
          }
        })];
      }
    }), null);
    _$insert3(_el$28, _$createComponent3(Show2, {
      get when() {
        return tab() === "commands";
      },
      get children() {
        return [(() => {
          var _el$75 = _$createElement3("text"), _el$76 = _$createElement3("span"), _el$78 = _$createElement3("span"), _el$79 = _$createElement3("span"), _el$80 = _$createTextNode3(` \xB7 history: `), _el$81 = _$createTextNode3(` \xB7 :project :history \xB7 [ ] cycle scope`);
          _$insertNode3(_el$75, _el$76);
          _$insertNode3(_el$75, _el$78);
          _$insertNode3(_el$75, _el$79);
          _$insertNode3(_el$76, _$createTextNode3(`Scope: `));
          _$insert3(_el$78, (() => {
            var _c$4 = _$memo3(() => cmdScope() === "all");
            return () => _c$4() ? `all projects (${managedDirs().length})` : cmdScope().split("/").pop() || cmdScope();
          })());
          _$insertNode3(_el$79, _el$80);
          _$insertNode3(_el$79, _el$81);
          _$insert3(_el$79, () => showCompleted() ? "shown (h to hide)" : "hidden (h to show)", _el$81);
          _$effect3((_p$) => {
            var _v$25 = {
              fg: theme().textMuted
            }, _v$26 = {
              fg: theme().accent,
              bold: true
            }, _v$27 = {
              fg: theme().textMuted
            };
            _v$25 !== _p$.e && (_p$.e = _$setProp3(_el$76, "style", _v$25, _p$.e));
            _v$26 !== _p$.t && (_p$.t = _$setProp3(_el$78, "style", _v$26, _p$.t));
            _v$27 !== _p$.a && (_p$.a = _$setProp3(_el$79, "style", _v$27, _p$.a));
            return _p$;
          }, {
            e: undefined,
            t: undefined,
            a: undefined
          });
          return _el$75;
        })(), _$createComponent3(Show2, {
          get when() {
            return ownerCommands().length > 0;
          },
          get fallback() {
            return (() => {
              var _el$185 = _$createElement3("box"), _el$186 = _$createElement3("text"), _el$187 = _$createElement3("span"), _el$188 = _$createTextNode3(`No live command sessions`), _el$189 = _$createTextNode3(`. `), _el$190 = _$createElement3("span"), _el$192 = _$createElement3("span"), _el$193 = _$createTextNode3(` to start one`), _el$194 = _$createElement3("text"), _el$195 = _$createElement3("span"), _el$197 = _$createElement3("span"), _el$199 = _$createElement3("span"), _el$201 = _$createElement3("span"), _el$203 = _$createElement3("span"), _el$205 = _$createElement3("span"), _el$207 = _$createElement3("span");
              _$insertNode3(_el$185, _el$186);
              _$insertNode3(_el$185, _el$194);
              _$setProp3(_el$185, "flexDirection", "column");
              _$setProp3(_el$185, "gap", 1);
              _$setProp3(_el$185, "padding", 1);
              _$insertNode3(_el$186, _el$187);
              _$insertNode3(_el$186, _el$190);
              _$insertNode3(_el$186, _el$192);
              _$insertNode3(_el$187, _el$188);
              _$insertNode3(_el$187, _el$189);
              _$insert3(_el$187, (() => {
                var _c$9 = _$memo3(() => hiddenFinishedCommands() > 0);
                return () => _c$9() ? ` \u2014 ${hiddenFinishedCommands()} finished hidden` : "";
              })(), _el$189);
              _$insertNode3(_el$190, _$createTextNode3(`:new &lt;command&gt;`));
              _$insertNode3(_el$192, _el$193);
              _$insert3(_el$192, () => hiddenFinishedCommands() > 0 ? ", or " : "; ", null);
              _$insert3(_el$186, (() => {
                var _c$0 = _$memo3(() => hiddenFinishedCommands() > 0);
                return () => _c$0() && (() => {
                  var _el$209 = _$createElement3("span"), _el$210 = _$createElement3("span"), _el$212 = _$createElement3("span");
                  _$insertNode3(_el$209, _el$210);
                  _$insertNode3(_el$209, _el$212);
                  _$insertNode3(_el$210, _$createTextNode3(`c`));
                  _$insertNode3(_el$212, _$createTextNode3(` to show finished.`));
                  _$effect3((_p$) => {
                    var _v$62 = {
                      fg: theme().warning
                    }, _v$63 = {
                      fg: theme().textMuted
                    };
                    _v$62 !== _p$.e && (_p$.e = _$setProp3(_el$210, "style", _v$62, _p$.e));
                    _v$63 !== _p$.t && (_p$.t = _$setProp3(_el$212, "style", _v$63, _p$.t));
                    return _p$;
                  }, {
                    e: undefined,
                    t: undefined
                  });
                  return _el$209;
                })();
              })(), null);
              _$insertNode3(_el$194, _el$195);
              _$insertNode3(_el$194, _el$197);
              _$insertNode3(_el$194, _el$199);
              _$insertNode3(_el$194, _el$201);
              _$insertNode3(_el$194, _el$203);
              _$insertNode3(_el$194, _el$205);
              _$insertNode3(_el$194, _el$207);
              _$insertNode3(_el$195, _$createTextNode3(`Tip: `));
              _$insertNode3(_el$197, _$createTextNode3(`o`));
              _$insertNode3(_el$199, _$createTextNode3(` fullscreen \xB7 `));
              _$insertNode3(_el$201, _$createTextNode3(`X kill \xB7 R restart \xB7 x remove-done`));
              _$insertNode3(_el$203, _$createTextNode3(` \xB7 `));
              _$insertNode3(_el$205, _$createTextNode3(`:interrupt :terminate :remove`));
              _$insertNode3(_el$207, _$createTextNode3(` manage \xB7 text + Enter writes stdin.`));
              _$effect3((_p$) => {
                var _v$52 = {
                  fg: theme().textMuted
                }, _v$53 = {
                  fg: theme().warning
                }, _v$54 = {
                  fg: theme().textMuted
                }, _v$55 = {
                  fg: theme().textMuted
                }, _v$56 = {
                  fg: theme().warning
                }, _v$57 = {
                  fg: theme().textMuted
                }, _v$58 = {
                  fg: theme().warning
                }, _v$59 = {
                  fg: theme().textMuted
                }, _v$60 = {
                  fg: theme().warning
                }, _v$61 = {
                  fg: theme().textMuted
                };
                _v$52 !== _p$.e && (_p$.e = _$setProp3(_el$187, "style", _v$52, _p$.e));
                _v$53 !== _p$.t && (_p$.t = _$setProp3(_el$190, "style", _v$53, _p$.t));
                _v$54 !== _p$.a && (_p$.a = _$setProp3(_el$192, "style", _v$54, _p$.a));
                _v$55 !== _p$.o && (_p$.o = _$setProp3(_el$195, "style", _v$55, _p$.o));
                _v$56 !== _p$.i && (_p$.i = _$setProp3(_el$197, "style", _v$56, _p$.i));
                _v$57 !== _p$.n && (_p$.n = _$setProp3(_el$199, "style", _v$57, _p$.n));
                _v$58 !== _p$.s && (_p$.s = _$setProp3(_el$201, "style", _v$58, _p$.s));
                _v$59 !== _p$.h && (_p$.h = _$setProp3(_el$203, "style", _v$59, _p$.h));
                _v$60 !== _p$.r && (_p$.r = _$setProp3(_el$205, "style", _v$60, _p$.r));
                _v$61 !== _p$.d && (_p$.d = _$setProp3(_el$207, "style", _v$61, _p$.d));
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
              return _el$185;
            })();
          },
          get children() {
            return _$createComponent3(DashboardList, {
              get count() {
                return ownerCommands().length;
              },
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
                    return _$createComponent3(DashboardRow, {
                      get id() {
                        return `loopd-command-${cmd.id}`;
                      },
                      get backgroundColor() {
                        return _$memo3(() => !!isActive())() ? theme().backgroundElement : undefined;
                      },
                      get children() {
                        return [(() => {
                          var _el$214 = _$createElement3("span");
                          _$insert3(_el$214, (() => {
                            var _c$1 = _$memo3(() => !!isActive());
                            return () => _c$1() ? `\u25B6 ${cmd.title}` : `  ${commandStatusIcon(cmd.status)} ${cmd.title}`;
                          })());
                          _$effect3((_$p) => _$setProp3(_el$214, "style", {
                            fg: commandStatusColor(cmd.status, theme()),
                            bold: isActive()
                          }, _$p));
                          return _el$214;
                        })(), _$memo3(() => _$memo3(() => managedDirs().length > 1)() && [(() => {
                          var _el$225 = _$createElement3("span");
                          _$insertNode3(_el$225, _$createTextNode3(` \u2502 `));
                          _$effect3((_$p) => _$setProp3(_el$225, "style", {
                            fg: theme().textMuted
                          }, _$p));
                          return _el$225;
                        })(), (() => {
                          var _el$227 = _$createElement3("span"), _el$228 = _$createTextNode3(`\u2B23 `);
                          _$insertNode3(_el$227, _el$228);
                          _$insert3(_el$227, () => commandDir(cmd.id).split("/").pop() ?? commandDir(cmd.id), null);
                          _$effect3((_$p) => _$setProp3(_el$227, "style", {
                            fg: theme().accent
                          }, _$p));
                          return _el$227;
                        })()]), (() => {
                          var _el$215 = _$createElement3("span");
                          _$insertNode3(_el$215, _$createTextNode3(` \u2502 `));
                          _$effect3((_$p) => _$setProp3(_el$215, "style", {
                            fg: theme().textMuted
                          }, _$p));
                          return _el$215;
                        })(), (() => {
                          var _el$217 = _$createElement3("span");
                          _$insertNode3(_el$217, _$createTextNode3(`Cmd `));
                          _$effect3((_$p) => _$setProp3(_el$217, "style", {
                            fg: theme().textMuted
                          }, _$p));
                          return _el$217;
                        })(), (() => {
                          var _el$219 = _$createElement3("span");
                          _$insert3(_el$219, () => commandStatusLabel(cmd.status).short);
                          _$effect3((_$p) => _$setProp3(_el$219, "style", {
                            fg: commandStatusColor(cmd.status, theme()),
                            bold: true
                          }, _$p));
                          return _el$219;
                        })(), (() => {
                          var _el$220 = _$createElement3("span");
                          _$insertNode3(_el$220, _$createTextNode3(` \u2502 `));
                          _$effect3((_$p) => _$setProp3(_el$220, "style", {
                            fg: theme().textMuted
                          }, _$p));
                          return _el$220;
                        })(), (() => {
                          var _el$222 = _$createElement3("span");
                          _$insert3(_el$222, () => cmd.command);
                          _$effect3((_$p) => _$setProp3(_el$222, "style", {
                            fg: theme().accent,
                            bold: true
                          }, _$p));
                          return _el$222;
                        })(), _$memo3(() => _$memo3(() => cmd.args.length > 0)() && (() => {
                          var _el$229 = _$createElement3("span"), _el$230 = _$createTextNode3(` `);
                          _$insertNode3(_el$229, _el$230);
                          _$insert3(_el$229, () => cmd.args.join(" ").slice(0, 40), null);
                          _$effect3((_$p) => _$setProp3(_el$229, "style", {
                            fg: theme().textMuted
                          }, _$p));
                          return _el$229;
                        })()), _$memo3(() => _$memo3(() => cmd.exitCode !== undefined)() && (() => {
                          var _el$231 = _$createElement3("span"), _el$232 = _$createTextNode3(` \u2502 exit `);
                          _$insertNode3(_el$231, _el$232);
                          _$insert3(_el$231, () => cmd.exitCode, null);
                          _$effect3((_$p) => _$setProp3(_el$231, "style", {
                            fg: cmd.exitCode === 0 ? theme().success : theme().error
                          }, _$p));
                          return _el$231;
                        })()), _$memo3(() => _$memo3(() => !!cmd.signal)() && (() => {
                          var _el$233 = _$createElement3("span"), _el$234 = _$createTextNode3(` \u2502 `);
                          _$insertNode3(_el$233, _el$234);
                          _$insert3(_el$233, () => cmd.signal, null);
                          _$effect3((_$p) => _$setProp3(_el$233, "style", {
                            fg: theme().warning
                          }, _$p));
                          return _el$233;
                        })()), (() => {
                          var _el$223 = _$createElement3("span"), _el$224 = _$createTextNode3(` \u2502 `);
                          _$insertNode3(_el$223, _el$224);
                          _$insert3(_el$223, () => ageLabel(cmd.updatedAt, clock()), null);
                          _$effect3((_$p) => _$setProp3(_el$223, "style", {
                            fg: theme().textMuted
                          }, _$p));
                          return _el$223;
                        })(), _$memo3(() => _$memo3(() => !!cmd.truncated)() && (() => {
                          var _el$235 = _$createElement3("span");
                          _$insertNode3(_el$235, _$createTextNode3(` \u2502 \u26A0 truncated`));
                          _$effect3((_$p) => _$setProp3(_el$235, "style", {
                            fg: theme().warning,
                            bold: true
                          }, _$p));
                          return _el$235;
                        })())];
                      }
                    });
                  }
                });
              }
            });
          }
        }), _$createComponent3(Show2, {
          get when() {
            return selectedCommand();
          },
          children: (cmd) => (() => {
            var _el$237 = _$createElement3("box"), _el$238 = _$createElement3("text"), _el$239 = _$createElement3("span"), _el$240 = _$createTextNode3(` `), _el$241 = _$createElement3("span"), _el$243 = _$createElement3("span"), _el$244 = _$createTextNode3(` \u2014 `), _el$245 = _$createTextNode3(`
`), _el$246 = _$createElement3("span"), _el$248 = _$createElement3("span"), _el$249 = _$createTextNode3(`
`), _el$250 = _$createElement3("span"), _el$252 = _$createElement3("span"), _el$254 = _$createElement3("span"), _el$255 = _$createTextNode3(`
`), _el$256 = _$createElement3("span"), _el$258 = _$createElement3("span"), _el$260 = _$createElement3("span"), _el$261 = _$createTextNode3(` bytes`), _el$262 = _$createElement3("span"), _el$263 = _$createTextNode3(` \u2502 updated `), _el$264 = _$createTextNode3(`
`), _el$265 = _$createElement3("span");
            _$insertNode3(_el$237, _el$238);
            _$setProp3(_el$237, "flexDirection", "column");
            _$setProp3(_el$237, "border", true);
            _$setProp3(_el$237, "padding", 1);
            _$setProp3(_el$237, "flexShrink", 0);
            _$setProp3(_el$237, "maxHeight", 8);
            _$insertNode3(_el$238, _el$239);
            _$insertNode3(_el$238, _el$241);
            _$insertNode3(_el$238, _el$243);
            _$insertNode3(_el$238, _el$245);
            _$insertNode3(_el$238, _el$246);
            _$insertNode3(_el$238, _el$248);
            _$insertNode3(_el$238, _el$249);
            _$insertNode3(_el$238, _el$250);
            _$insertNode3(_el$238, _el$252);
            _$insertNode3(_el$238, _el$254);
            _$insertNode3(_el$238, _el$255);
            _$insertNode3(_el$238, _el$256);
            _$insertNode3(_el$238, _el$258);
            _$insertNode3(_el$238, _el$260);
            _$insertNode3(_el$238, _el$262);
            _$insertNode3(_el$238, _el$264);
            _$insertNode3(_el$238, _el$265);
            _$insertNode3(_el$239, _el$240);
            _$insert3(_el$239, () => commandStatusIcon(cmd().status), _el$240);
            _$insert3(_el$239, () => cmd().title, null);
            _$insertNode3(_el$241, _$createTextNode3(` Cmd `));
            _$insertNode3(_el$243, _el$244);
            _$insert3(_el$243, () => commandStatusLabel(cmd().status).short, _el$244);
            _$insert3(_el$243, () => commandStatusLabel(cmd().status).hint, null);
            _$insertNode3(_el$246, _$createTextNode3(`\u2B22 Spawn: `));
            _$insert3(_el$248, () => cmd().command);
            _$insert3(_el$238, (() => {
              var _c$10 = _$memo3(() => cmd().args.length > 0);
              return () => _c$10() && (() => {
                var _el$267 = _$createElement3("span"), _el$268 = _$createTextNode3(` `);
                _$insertNode3(_el$267, _el$268);
                _$insert3(_el$267, () => cmd().args.join(" "), null);
                _$effect3((_$p) => _$setProp3(_el$267, "style", {
                  fg: theme().text
                }, _$p));
                return _el$267;
              })();
            })(), _el$249);
            _$insertNode3(_el$250, _$createTextNode3(`\uD83D\uDCC1 `));
            _$insertNode3(_el$252, _$createTextNode3(`Cwd: `));
            _$insert3(_el$254, () => cmd().cwd.replace(String(props.directory), "."));
            _$insert3(_el$238, (() => {
              var _c$11 = _$memo3(() => !!cmd().goalID);
              return () => _c$11() && [(() => {
                var _el$269 = _$createElement3("span");
                _$insertNode3(_el$269, _$createTextNode3(` \u2502 \uD83D\uDD17 linked goal `));
                _$effect3((_$p) => _$setProp3(_el$269, "style", {
                  fg: theme().textMuted
                }, _$p));
                return _el$269;
              })(), (() => {
                var _el$271 = _$createElement3("span");
                _$insert3(_el$271, () => cmd().goalID.slice(0, 8));
                _$effect3((_$p) => _$setProp3(_el$271, "style", {
                  fg: theme().text
                }, _$p));
                return _el$271;
              })()];
            })(), _el$255);
            _$insertNode3(_el$256, _$createTextNode3(`\uD83D\uDCBE `));
            _$insertNode3(_el$258, _$createTextNode3(`Output: `));
            _$insertNode3(_el$260, _el$261);
            _$insert3(_el$260, () => cmd().outputBytes, _el$261);
            _$insert3(_el$238, (() => {
              var _c$12 = _$memo3(() => !!cmd().truncated);
              return () => _c$12() && (() => {
                var _el$272 = _$createElement3("span");
                _$insertNode3(_el$272, _$createTextNode3(` \xB7 \u26A0 truncated`));
                _$effect3((_$p) => _$setProp3(_el$272, "style", {
                  fg: theme().warning,
                  bold: true
                }, _$p));
                return _el$272;
              })();
            })(), _el$262);
            _$insertNode3(_el$262, _el$263);
            _$insert3(_el$262, () => ageLabel(cmd().updatedAt, clock()), null);
            _$insert3(_el$238, (() => {
              var _c$13 = _$memo3(() => !!cmd().lastError);
              return () => _c$13() && [(() => {
                var _el$274 = _$createElement3("span"), _el$275 = _$createTextNode3(`
\u26A0 Error: `);
                _$insertNode3(_el$274, _el$275);
                _$effect3((_$p) => _$setProp3(_el$274, "style", {
                  fg: theme().error,
                  bold: true
                }, _$p));
                return _el$274;
              })(), (() => {
                var _el$277 = _$createElement3("span");
                _$insert3(_el$277, () => cmd().lastError.slice(0, 120));
                _$effect3((_$p) => _$setProp3(_el$277, "style", {
                  fg: theme().error
                }, _$p));
                return _el$277;
              })()];
            })(), _el$264);
            _$insertNode3(_el$265, _$createTextNode3(`o fullscreen \xB7 X kill \xB7 R restart \xB7 x remove-done \xB7 :interrupt :terminate :remove \xB7 text + Enter writes stdin`));
            _$effect3((_p$) => {
              var _v$64 = commandBorderColor(cmd().status, theme()), _v$65 = {
                fg: commandStatusColor(cmd().status, theme()),
                bold: true
              }, _v$66 = {
                fg: theme().textMuted
              }, _v$67 = {
                fg: commandStatusColor(cmd().status, theme())
              }, _v$68 = {
                fg: theme().primary,
                bold: true
              }, _v$69 = {
                fg: theme().accent,
                bold: true
              }, _v$70 = {
                fg: theme().textMuted
              }, _v$71 = {
                fg: theme().accent,
                bold: true
              }, _v$72 = {
                fg: theme().textMuted
              }, _v$73 = {
                fg: theme().warning,
                bold: true
              }, _v$74 = {
                fg: theme().warning,
                bold: true
              }, _v$75 = {
                fg: theme().text
              }, _v$76 = {
                fg: theme().textMuted
              }, _v$77 = {
                fg: theme().textMuted
              };
              _v$64 !== _p$.e && (_p$.e = _$setProp3(_el$237, "borderColor", _v$64, _p$.e));
              _v$65 !== _p$.t && (_p$.t = _$setProp3(_el$239, "style", _v$65, _p$.t));
              _v$66 !== _p$.a && (_p$.a = _$setProp3(_el$241, "style", _v$66, _p$.a));
              _v$67 !== _p$.o && (_p$.o = _$setProp3(_el$243, "style", _v$67, _p$.o));
              _v$68 !== _p$.i && (_p$.i = _$setProp3(_el$246, "style", _v$68, _p$.i));
              _v$69 !== _p$.n && (_p$.n = _$setProp3(_el$248, "style", _v$69, _p$.n));
              _v$70 !== _p$.s && (_p$.s = _$setProp3(_el$250, "style", _v$70, _p$.s));
              _v$71 !== _p$.h && (_p$.h = _$setProp3(_el$252, "style", _v$71, _p$.h));
              _v$72 !== _p$.r && (_p$.r = _$setProp3(_el$254, "style", _v$72, _p$.r));
              _v$73 !== _p$.d && (_p$.d = _$setProp3(_el$256, "style", _v$73, _p$.d));
              _v$74 !== _p$.l && (_p$.l = _$setProp3(_el$258, "style", _v$74, _p$.l));
              _v$75 !== _p$.u && (_p$.u = _$setProp3(_el$260, "style", _v$75, _p$.u));
              _v$76 !== _p$.c && (_p$.c = _$setProp3(_el$262, "style", _v$76, _p$.c));
              _v$77 !== _p$.w && (_p$.w = _$setProp3(_el$265, "style", _v$77, _p$.w));
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
            return _el$237;
          })()
        })];
      }
    }), null);
    _$insert3(_el$28, _$createComponent3(Show2, {
      get when() {
        return _$memo3(() => !!showLogs())() && events().length > 0;
      },
      get children() {
        var _el$82 = _$createElement3("box"), _el$83 = _$createElement3("text"), _el$84 = _$createElement3("span"), _el$86 = _$createElement3("span");
        _$insertNode3(_el$82, _el$83);
        _$setProp3(_el$82, "flexDirection", "column");
        _$setProp3(_el$82, "border", true);
        _$setProp3(_el$82, "padding", 1);
        _$setProp3(_el$82, "maxHeight", 7);
        _$setProp3(_el$82, "flexShrink", 0);
        _$setProp3(_el$82, "overflow", "hidden");
        _$insertNode3(_el$83, _el$84);
        _$insertNode3(_el$83, _el$86);
        _$insertNode3(_el$84, _$createTextNode3(`\u25C8 Recent Events`));
        _$insertNode3(_el$86, _$createTextNode3(` \u2014 :logs to hide`));
        _$insert3(_el$83, _$createComponent3(For3, {
          get each() {
            return events().slice(-10);
          },
          children: (ev) => [`
`, (() => {
            var _el$278 = _$createElement3("span");
            _$insert3(_el$278, () => String(ev.type));
            _$effect3((_$p) => _$setProp3(_el$278, "style", {
              fg: eventColor(String(ev.type), theme()),
              bold: true
            }, _$p));
            return _el$278;
          })(), (() => {
            var _el$279 = _$createElement3("span"), _el$280 = _$createTextNode3(` `);
            _$insertNode3(_el$279, _el$280);
            _$insert3(_el$279, () => ev.goalID?.slice(0, 8), null);
            _$effect3((_$p) => _$setProp3(_el$279, "style", {
              fg: theme().textMuted
            }, _$p));
            return _el$279;
          })(), _$memo3(() => _$memo3(() => !!ev.summary)() && (() => {
            var _el$281 = _$createElement3("span"), _el$282 = _$createTextNode3(` \u2014 `);
            _$insertNode3(_el$281, _el$282);
            _$insert3(_el$281, () => String(ev.summary).slice(0, 60), null);
            _$effect3((_$p) => _$setProp3(_el$281, "style", {
              fg: theme().text
            }, _$p));
            return _el$281;
          })())]
        }), null);
        _$effect3((_p$) => {
          var _v$28 = theme().border, _v$29 = {
            fg: theme().accent,
            bold: true
          }, _v$30 = {
            fg: theme().textMuted
          };
          _v$28 !== _p$.e && (_p$.e = _$setProp3(_el$82, "borderColor", _v$28, _p$.e));
          _v$29 !== _p$.t && (_p$.t = _$setProp3(_el$84, "style", _v$29, _p$.t));
          _v$30 !== _p$.a && (_p$.a = _$setProp3(_el$86, "style", _v$30, _p$.a));
          return _p$;
        }, {
          e: undefined,
          t: undefined,
          a: undefined
        });
        return _el$82;
      }
    }), null);
    _$insertNode3(_el$88, _el$89);
    _$insertNode3(_el$88, _el$91);
    _$use((el) => {
      hintBoxEl = el;
    }, _el$88);
    _$setProp3(_el$88, "flexDirection", "row");
    _$setProp3(_el$88, "border", true);
    _$setProp3(_el$88, "paddingLeft", 1);
    _$setProp3(_el$88, "paddingRight", 1);
    _$setProp3(_el$88, "flexShrink", 0);
    _$setProp3(_el$88, "height", 3);
    _$setProp3(_el$88, "gap", 1);
    _$insertNode3(_el$89, _el$90);
    _$insert3(_el$90, () => mode() === "insert" ? " INSERT \uE0B1" : " NORMAL ");
    _$use((el) => {
      inputEl = el;
      focusInput();
    }, _el$91);
    _$setProp3(_el$91, "flexGrow", 1);
    _$setProp3(_el$91, "onInput", (v) => {
      if (mode() === "insert")
        setCommandInput(v);
      else if (inputEl?.value)
        inputEl.value = "";
    });
    _$setProp3(_el$91, "onKeyDown", (evt) => {
      if (mode() !== "insert") {
        if ((evt.name || "").length === 1)
          prevent(evt);
        return;
      }
    });
    _$effect3((_p$) => {
      var _v$31 = theme().border, _v$32 = mode() === "insert" ? theme().warning : theme().border, _v$33 = {
        fg: mode() === "insert" ? theme().warning : theme().success,
        bold: true,
        bg: mode() === "insert" ? theme().backgroundElement : undefined
      }, _v$34 = mode() === "insert" ? ":send hello  or  :filter text  or  :project name  (Ctrl+N: normal)" : statusText() || fitHintBar(FOOT_HINTS, hintCols()), _v$35 = theme().textMuted, _v$36 = theme().primary, _v$37 = theme().text, _v$38 = theme().background;
      _v$31 !== _p$.e && (_p$.e = _$setProp3(_el$27, "borderColor", _v$31, _p$.e));
      _v$32 !== _p$.t && (_p$.t = _$setProp3(_el$88, "borderColor", _v$32, _p$.t));
      _v$33 !== _p$.a && (_p$.a = _$setProp3(_el$90, "style", _v$33, _p$.a));
      _v$34 !== _p$.o && (_p$.o = _$setProp3(_el$91, "placeholder", _v$34, _p$.o));
      _v$35 !== _p$.i && (_p$.i = _$setProp3(_el$91, "placeholderColor", _v$35, _p$.i));
      _v$36 !== _p$.n && (_p$.n = _$setProp3(_el$91, "cursorColor", _v$36, _p$.n));
      _v$37 !== _p$.s && (_p$.s = _$setProp3(_el$91, "focusedTextColor", _v$37, _p$.s));
      _v$38 !== _p$.h && (_p$.h = _$setProp3(_el$91, "focusedBackgroundColor", _v$38, _p$.h));
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
    return _el$26;
  })();
}

// src/tui/command-panel.tsx
import { effect as _$effect4 } from "@opentui/solid";
import { use as _$use2 } from "@opentui/solid";
import { createComponent as _$createComponent4 } from "@opentui/solid";
import { insert as _$insert4 } from "@opentui/solid";
import { memo as _$memo4 } from "@opentui/solid";
import { createTextNode as _$createTextNode4 } from "@opentui/solid";
import { insertNode as _$insertNode4 } from "@opentui/solid";
import { setProp as _$setProp4 } from "@opentui/solid";
import { createElement as _$createElement4 } from "@opentui/solid";
import { createSignal as createSignal2, For as For4, Show as Show3, onCleanup as onCleanup2, onMount as onMount2 } from "solid-js";
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
import path4 from "path";

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
  return path4.join(directory, ".opencode", "loopd", "commands", ".stream-endpoint.json");
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
    _$insert4(_el$2, _$createComponent4(Show3, {
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
    _$insert4(_el$2, _$createComponent4(Show3, {
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
        _$insert4(_el$29, _$createComponent4(Show3, {
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
        _$insert4(_el$29, _$createComponent4(Show3, {
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
    _$use2((el) => {
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
import { use as _$use3 } from "@opentui/solid";
import { createComponent as _$createComponent5 } from "@opentui/solid";
import { effect as _$effect5 } from "@opentui/solid";
import { insert as _$insert5 } from "@opentui/solid";
import { createTextNode as _$createTextNode5 } from "@opentui/solid";
import { insertNode as _$insertNode5 } from "@opentui/solid";
import { memo as _$memo5 } from "@opentui/solid";
import { setProp as _$setProp5 } from "@opentui/solid";
import { createElement as _$createElement5 } from "@opentui/solid";
import { createSignal as createSignal3, For as For5, Show as Show4, onCleanup as onCleanup3, onMount as onMount3 } from "solid-js";
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
    _$insert5(_el$3, _$createComponent5(Show4, {
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
    _$insert5(_el$3, _$createComponent5(Show4, {
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
    _$insert5(_el$, _$createComponent5(Show4, {
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
    _$insert5(_el$, _$createComponent5(Show4, {
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
    _$insert5(_el$, _$createComponent5(Show4, {
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
    _$use3((el) => {
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
    _$insert5(_el$30, _$createComponent5(Show4, {
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
    _$insert5(_el$32, _$createComponent5(Show4, {
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
    _$insert5(_el$32, _$createComponent5(Show4, {
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
  const open = () => {
    const directory = directoryFor();
    const previousFocus = ctx.renderer.currentFocusedRenderable;
    dialogOpen = true;
    ctx.ui.dialog.show(() => _$createComponent6(LoopDashboard, {
      api: facade,
      directory,
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
  const openCommands = () => {
    const directory = directoryFor();
    const previousFocus = ctx.renderer.currentFocusedRenderable;
    dialogOpen = true;
    ctx.ui.dialog.show(() => _$createComponent6(LoopDashboard, {
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

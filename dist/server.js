// @bun
var __defProp = Object.defineProperty;
var __returnValue = (v) => v;
function __exportSetter(name, newValue) {
  this[name] = __returnValue.bind(null, newValue);
}
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: __exportSetter.bind(all, name)
    });
};

// src/domain/runtime.ts
var exports_runtime = {};
__export(exports_runtime, {
  shouldNotifyParent: () => shouldNotifyParent,
  removeToolCall: () => removeToolCall,
  releaseLease: () => releaseLease,
  recordActivity: () => recordActivity,
  markProgress: () => markProgress,
  markParentNotified: () => markParentNotified,
  leaseIsValid: () => leaseIsValid,
  hasActiveToolCalls: () => hasActiveToolCalls,
  createRuntimeState: () => createRuntimeState,
  addToolCall: () => addToolCall,
  acquireLease: () => acquireLease
});
function createRuntimeState(goalID) {
  const now = new Date().toISOString();
  return {
    goalID,
    phase: "idle",
    consecutiveFailures: 0,
    runCount: 0,
    budgetTurnCount: 0,
    noProgressCount: 0,
    progressDuringTurn: false,
    unknownStatusCount: 0,
    accountedMessageIDs: [],
    runGeneration: 0,
    createdAt: now,
    updatedAt: now
  };
}
function acquireLease(rt, timeoutMs) {
  const now = Date.now();
  const expires = new Date(now + timeoutMs).toISOString();
  return {
    ...rt,
    phase: "running",
    leaseExpiresAt: expires,
    turnStartedAt: new Date(now).toISOString(),
    progressDuringTurn: false,
    turnTokensUsed: 0,
    runGeneration: rt.runGeneration + 1,
    lastActivityAt: new Date(now).toISOString(),
    idleCandidateAt: undefined,
    idleCandidateGeneration: undefined,
    idleConfirmFailedAt: undefined,
    idleConfirmFailedGeneration: undefined,
    idleStuckNotifiedGeneration: undefined,
    workerAbortedAt: undefined,
    activePromptObservedAt: undefined,
    activeAssistantMessageID: undefined,
    activeAssistantCompletedAt: undefined,
    activeToolCallIDs: [],
    updatedAt: new Date(now).toISOString()
  };
}
function releaseLease(rt) {
  return {
    ...rt,
    phase: "idle",
    leaseExpiresAt: undefined,
    turnStartedAt: undefined,
    activePromptMessageID: undefined,
    activePromptObservedAt: undefined,
    activeAssistantMessageID: undefined,
    activeAssistantCompletedAt: undefined,
    idleCandidateAt: undefined,
    idleCandidateGeneration: undefined,
    activeToolCallIDs: [],
    updatedAt: new Date().toISOString()
  };
}
function leaseIsValid(rt) {
  if (!rt.leaseExpiresAt)
    return false;
  return Date.now() < Date.parse(rt.leaseExpiresAt);
}
function markProgress(rt) {
  return { ...rt, progressDuringTurn: true, lastProgressAt: new Date().toISOString() };
}
function shouldNotifyParent(runtime, type) {
  if (!runtime.lastParentNotifiedAt || !runtime.lastParentNotifiedFor)
    return true;
  if (runtime.lastParentNotifiedFor !== type)
    return true;
  const elapsed = Date.now() - Date.parse(runtime.lastParentNotifiedAt);
  return !Number.isFinite(elapsed) || elapsed > PARENT_NOTIFY_DEDUPE_MS;
}
function markParentNotified(runtime, type) {
  runtime.lastParentNotifiedFor = type;
  runtime.lastParentNotifiedAt = new Date().toISOString();
  runtime.updatedAt = new Date().toISOString();
}
function recordActivity(rt) {
  return {
    ...rt,
    lastActivityAt: new Date().toISOString(),
    idleCandidateAt: undefined,
    idleCandidateGeneration: undefined,
    updatedAt: new Date().toISOString()
  };
}
function addToolCall(rt, callID) {
  const ids = new Set(rt.activeToolCallIDs || []);
  ids.add(callID);
  return {
    ...rt,
    activeToolCallIDs: Array.from(ids),
    lastActivityAt: new Date().toISOString(),
    idleCandidateAt: undefined,
    idleCandidateGeneration: undefined,
    updatedAt: new Date().toISOString()
  };
}
function removeToolCall(rt, callID) {
  const ids = (rt.activeToolCallIDs || []).filter((id) => id !== callID);
  return {
    ...rt,
    activeToolCallIDs: ids,
    lastActivityAt: new Date().toISOString(),
    idleCandidateAt: undefined,
    idleCandidateGeneration: undefined,
    updatedAt: new Date().toISOString()
  };
}
function hasActiveToolCalls(rt) {
  return (rt.activeToolCallIDs?.length ?? 0) > 0;
}
var PARENT_NOTIFY_DEDUPE_MS = 60000;

// src/application/control-worker.ts
import { randomUUID } from "crypto";

// src/infrastructure/state-repository.ts
import { promises as fs } from "fs";
import path from "path";
import os from "os";
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
function lockDir(directory) {
  const projectHash = Buffer.from(directory).toString("base64url").slice(0, 32);
  return path.join(os.tmpdir(), "loopd-locks", projectHash);
}
function lockFile(directory, key) {
  return path.join(lockDir(directory), `${key}.lock`);
}
var LOCK_STALE_MS = 1e4;
async function acquireLock(directory, key, operation) {
  const dir = lockDir(directory);
  await fs.mkdir(dir, { recursive: true });
  const lockPath = lockFile(directory, key);
  for (let attempt = 0;attempt < 10; attempt++) {
    try {
      try {
        const raw = await fs.readFile(lockPath, "utf8");
        const meta2 = JSON.parse(raw);
        const age = Date.now() - Date.parse(meta2.acquiredAt);
        if (age > LOCK_STALE_MS) {
          await fs.rm(lockPath, { force: true });
        }
      } catch {}
      const meta = { pid: process.pid, operation, acquiredAt: new Date().toISOString() };
      const fd = await fs.open(lockPath, "wx");
      try {
        await fd.writeFile(JSON.stringify(meta), "utf8");
      } finally {
        await fd.close();
      }
      return;
    } catch (error) {
      if (error?.code === "EEXIST") {} else if (error?.code === "ENOENT") {
        await fs.mkdir(dir, { recursive: true });
        continue;
      } else {
        throw error;
      }
    }
    await delay(25 * (attempt + 1));
  }
  throw new Error(`failed to acquire lock "${key}" for "${operation}" after retries`);
}
async function releaseLock(directory, key) {
  const lockPath = lockFile(directory, key);
  try {
    const raw = await fs.readFile(lockPath, "utf8");
    const meta = JSON.parse(raw);
    const age = Date.now() - Date.parse(meta.acquiredAt);
    const shouldRelease = meta.pid === process.pid || age > LOCK_STALE_MS;
    if (!shouldRelease)
      return;
    try {
      const raw2 = await fs.readFile(lockPath, "utf8");
      const meta2 = JSON.parse(raw2);
      if (meta2.acquiredAt !== meta.acquiredAt || meta2.pid !== meta.pid)
        return;
    } catch {
      return;
    }
    await fs.rm(lockPath, { force: true });
  } catch {}
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
async function writeState(directory, state) {
  state.revision += 1;
  const payload = JSON.stringify(state, null, 2);
  await writeAtomic(stateFile(directory), payload);
}
async function mutateState(directory, description, fn) {
  await acquireLock(directory, "state", description);
  try {
    const state = await readState(directory);
    const next = await fn(state);
    await writeState(directory, next);
    return next;
  } finally {
    await releaseLock(directory, "state");
  }
}
async function appendEvent(directory, event) {
  await fs.mkdir(loopDir(directory), { recursive: true });
  const line = JSON.stringify(event) + `
`;
  await fs.appendFile(eventsFile(directory), line, "utf8");
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
function processingFile(directory, requestID) {
  return path.join(controlDir(directory), "processing", `${requestID}.json`);
}
function responseFile(directory, requestID) {
  return path.join(controlDir(directory), "responses", `${requestID}.json`);
}
async function claimControlRequest(directory, requestID) {
  const src = requestFile(directory, requestID);
  const dst = processingFile(directory, requestID);
  try {
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await fs.rename(src, dst);
    return true;
  } catch {
    return false;
  }
}
async function writeControlResponse(directory, response) {
  const dir = path.join(controlDir(directory), "responses");
  await fs.mkdir(dir, { recursive: true });
  await writeAtomic(responseFile(directory, response.requestID), JSON.stringify(response, null, 2));
  try {
    await fs.rm(processingFile(directory, response.requestID), { force: true });
  } catch {}
}
async function readControlResponse(directory, requestID) {
  try {
    const raw = await fs.readFile(responseFile(directory, requestID), "utf8");
    return JSON.parse(raw);
  } catch {
    return;
  }
}
async function listPendingRequests(directory) {
  const dir = path.join(controlDir(directory), "requests");
  try {
    const files = await fs.readdir(dir);
    const requests = [];
    for (const file of files) {
      if (!file.endsWith(".json"))
        continue;
      try {
        const raw = await fs.readFile(path.join(dir, file), "utf8");
        requests.push(JSON.parse(raw));
      } catch {}
    }
    return requests.sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
  } catch {
    return [];
  }
}
function goalArtifactDir(directory, goalID) {
  return path.join(loopDir(directory), "goals", goalID);
}
async function ensureGoalArtifactDir(directory, goalID) {
  const dir = goalArtifactDir(directory, goalID);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}
function inboxFile(directory, goalID) {
  return path.join(loopDir(directory), "inboxes", `${goalID}.jsonl`);
}
async function appendGoalInbox(directory, goalID, from, text) {
  const dir = path.join(loopDir(directory), "inboxes");
  await fs.mkdir(dir, { recursive: true });
  const msg = { from, text, at: new Date().toISOString() };
  await fs.appendFile(inboxFile(directory, goalID), JSON.stringify(msg) + `
`, "utf8");
}
async function drainGoalInbox(directory, goalID) {
  const file = inboxFile(directory, goalID);
  try {
    const raw = await fs.readFile(file, "utf8");
    const lines = raw.trim().split(`
`).filter(Boolean);
    if (lines.length === 0)
      return [];
    const messages = lines.map((l) => JSON.parse(l));
    await fs.rm(file, { force: true });
    return messages.map((m) => `[${m.from}] ${m.text}`);
  } catch {
    return [];
  }
}
async function peekGoalInbox(directory, goalID) {
  const file = inboxFile(directory, goalID);
  try {
    const raw = await fs.readFile(file, "utf8");
    const lines = raw.trim().split(`
`).filter(Boolean);
    if (lines.length === 0)
      return [];
    const messages = lines.map((l) => JSON.parse(l));
    return messages.map((m) => `[${m.from}] ${m.text}`);
  } catch {
    return [];
  }
}
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// src/application/goal-policy.ts
function resolveGoalCreationConfig(input) {
  const requested = input.config || {};
  const defaults = input.defaults || {};
  const explicitAgent = cleanText(requested.agent);
  const defaultAgent = cleanText(defaults.defaultAgent);
  const agent = explicitAgent || defaultAgent || undefined;
  const explicitModel = cleanText(requested.model);
  const defaultModel = cleanText(defaults.defaultModel);
  const model = explicitModel || defaultModel || undefined;
  if (model && !isValidModelRef(model)) {
    return {
      ok: false,
      errorCode: "invalid_model",
      message: `Invalid model "${model}". Use "providerID/modelID" (e.g. "openai/gpt-5.6-sol", "ollama/qwen3.8:27b"). Discover with \`opencode models\`.`
    };
  }
  const workspaceWrite = requested.workspaceWrite ?? true;
  const explicitChecks = cleanList(requested.checks);
  const defaultChecks = workspaceWrite ? cleanList(defaults.defaultChecks || ["bun test"]) : [];
  const checks = explicitChecks.length > 0 ? explicitChecks : defaultChecks;
  if (workspaceWrite && checks.length === 0) {
    return {
      ok: false,
      errorCode: "missing_checks",
      message: "Workspace-writing goals require completion checks. Pass checks or configure plugin option defaultChecks."
    };
  }
  return {
    ok: true,
    config: {
      ...requested,
      agent,
      model,
      workspaceWrite,
      checks: checks.length > 0 ? checks : undefined,
      checkCwd: requested.checkCwd || (workspaceWrite ? input.directory : undefined)
    },
    defaultsApplied: {
      agent: !explicitAgent && Boolean(defaultAgent),
      model: !explicitModel && Boolean(defaultModel),
      checks: explicitChecks.length === 0 && defaultChecks.length > 0
    }
  };
}
function isValidModelRef(value) {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash >= value.length - 1)
    return false;
  const providerID = value.slice(0, slash).trim();
  const modelID = value.slice(slash + 1).trim();
  if (!providerID || !modelID)
    return false;
  if (/\s/.test(providerID) || /\s/.test(modelID))
    return false;
  return true;
}
function cleanText(value) {
  if (typeof value !== "string")
    return;
  const trimmed = value.trim();
  return trimmed || undefined;
}
function cleanList(value) {
  if (!Array.isArray(value))
    return [];
  return value.map(cleanText).filter((item) => Boolean(item));
}

// src/infrastructure/server-log.ts
import { appendFile } from "fs/promises";
var SERVER_LOG_FILE = "/tmp/loopd-server.log";
async function logServerEvent(directory, event, details = {}) {
  try {
    await appendFile(SERVER_LOG_FILE, `${JSON.stringify({
      timestamp: new Date().toISOString(),
      directory,
      event,
      ...details
    }, errorReplacer)}
`);
  } catch {}
}
function describeError(value) {
  if (value instanceof Error)
    return value.message;
  if (typeof value === "string")
    return value;
  if (typeof value === "object" && value !== null && "message" in value) {
    return String(value.message);
  }
  try {
    return JSON.stringify(value, errorReplacer);
  } catch {
    return String(value);
  }
}
function errorReplacer(_key, value) {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}

// src/application/control-worker.ts
var MAX_LEDGER_SIZE = 100;
var RESPONSE_CLEANUP_AGE_MS = 60 * 60 * 1000;
function createControlWorker(options) {
  const directory = options.directory;
  const pollMs = options.pollIntervalMs ?? 1000;
  const goalSvc = options.goalService;
  let running = false;
  let pollTimer;
  let processing = new Set;
  let lastProcessDone = true;
  function start() {
    if (running)
      return;
    running = true;
    processPending().catch((error) => {
      logServerEvent(directory, "control.worker.error", { detail: describeError(error) }).catch(() => {});
    });
    pollTimer = setInterval(() => {
      if (running && lastProcessDone) {
        lastProcessDone = false;
        processPending().then(() => {
          lastProcessDone = true;
        }, (error) => {
          lastProcessDone = true;
          logServerEvent(directory, "control.worker.error", { detail: describeError(error) }).catch(() => {});
        });
      }
    }, pollMs);
  }
  async function stop() {
    running = false;
    if (pollTimer)
      clearInterval(pollTimer);
    pollTimer = undefined;
    processing.clear();
  }
  async function processPending() {
    if (!running)
      return;
    const requests = await listPendingRequests(directory);
    for (const request of requests) {
      if (processing.has(request.requestID))
        continue;
      const claimed = await claimControlRequest(directory, request.requestID);
      if (!claimed)
        continue;
      processing.add(request.requestID);
      options.onRequest?.(request);
      try {
        const response = await handleRequest(request);
        await writeControlResponse(directory, response);
        options.onResponse?.(response);
      } catch (error) {
        const detail = describeError(error);
        await logServerEvent(directory, "control.request.failed", {
          requestID: request.requestID,
          command: request.command,
          goalID: request.goalID,
          detail
        });
        const response = {
          requestID: request.requestID,
          ok: false,
          message: `internal error: ${detail}. Diagnostics: ${SERVER_LOG_FILE}`,
          errorCode: "internal_error",
          completedAt: new Date().toISOString()
        };
        await writeControlResponse(directory, response);
        options.onResponse?.(response);
      } finally {
        processing.delete(request.requestID);
      }
    }
  }
  async function handleRequest(request) {
    const existingResponse = await readControlResponse(directory, request.requestID);
    if (existingResponse) {
      return existingResponse;
    }
    const state = await readState(directory);
    const ledgerEntry = state.commandLedger?.find((e) => e.requestID === request.requestID);
    if (ledgerEntry?.completedAt) {
      return {
        requestID: request.requestID,
        ok: true,
        message: `command "${request.command}" already processed`,
        stateRevision: state.revision,
        completedAt: ledgerEntry.completedAt
      };
    }
    const base = {
      requestID: request.requestID,
      ok: true,
      message: "",
      stateRevision: undefined,
      errorCode: undefined,
      completedAt: new Date().toISOString()
    };
    let response;
    switch (request.command) {
      case "start": {
        const args = request.args;
        if (!args.ownerSessionID || args.ownerSessionID === "main") {
          response = {
            ...base,
            ok: false,
            message: "cannot start goal without a valid owner session; open /loop from an active OpenCode session",
            errorCode: "invalid_owner_session"
          };
          break;
        }
        const resolution = resolveGoalCreationConfig({
          directory,
          objective: args.objective,
          config: args.config,
          defaults: options.defaults
        });
        if (!resolution.ok) {
          response = {
            ...base,
            ok: false,
            message: resolution.message,
            errorCode: resolution.errorCode
          };
          break;
        }
        const { goal } = await goalSvc.start(directory, {
          name: args.name,
          objective: args.objective,
          ownerSessionID: args.ownerSessionID,
          config: resolution.config
        });
        const state2 = await readState(directory);
        response = {
          ...base,
          message: `goal "${args.name}" created (${goal.id.slice(0, 8)}...)`,
          stateRevision: state2.revision
        };
        break;
      }
      case "pause": {
        await goalSvc.pause(directory, request.goalID);
        const state2 = await readState(directory);
        const goal = state2.goals.find((g) => g.id === request.goalID);
        response = {
          ...base,
          message: `goal "${goal?.name || request.goalID}" paused`,
          stateRevision: state2.revision
        };
        break;
      }
      case "resume": {
        await goalSvc.resume(directory, request.goalID);
        const state2 = await readState(directory);
        const goal = state2.goals.find((g) => g.id === request.goalID);
        response = {
          ...base,
          message: `goal "${goal?.name || request.goalID}" resumed`,
          stateRevision: state2.revision
        };
        break;
      }
      case "retry": {
        await goalSvc.retry(directory, request.goalID);
        const state2 = await readState(directory);
        const goal = state2.goals.find((g) => g.id === request.goalID);
        response = {
          ...base,
          message: `goal "${goal?.name || request.goalID}" retried`,
          stateRevision: state2.revision
        };
        break;
      }
      case "nudge": {
        if (!request.goalID) {
          response = { ...base, ok: false, message: "goalID is required", errorCode: "bad_request" };
          break;
        }
        const result = await goalSvc.nudge(directory, request.goalID);
        const state2 = await readState(directory);
        response = {
          ...base,
          ok: result.ok,
          message: result.message,
          stateRevision: state2.revision
        };
        break;
      }
      case "clear": {
        await goalSvc.clear(directory, request.goalID);
        const state2 = await readState(directory);
        response = {
          ...base,
          message: `goal cleared`,
          stateRevision: state2.revision
        };
        break;
      }
      case "send": {
        const args = request.args;
        const text = String(args.message || "").trim();
        if (!text) {
          response = { ...base, ok: false, message: "message is required", errorCode: "bad_request" };
          break;
        }
        if (!request.goalID) {
          response = { ...base, ok: false, message: "goalID is required", errorCode: "bad_request" };
          break;
        }
        const sent = await goalSvc.sendUserMessage(directory, request.goalID, text);
        const state2 = await readState(directory);
        response = {
          ...base,
          ok: sent.ok,
          message: sent.message,
          stateRevision: state2.revision
        };
        break;
      }
      case "abort_worker": {
        if (!request.goalID) {
          response = { ...base, ok: false, message: "goalID is required", errorCode: "bad_request" };
          break;
        }
        const result = await goalSvc.abortWorker(directory, request.goalID);
        const state2 = await readState(directory);
        response = {
          ...base,
          ok: result.ok,
          message: result.message,
          stateRevision: state2.revision
        };
        break;
      }
      case "force_complete": {
        const args = request.args;
        const state2 = await readState(directory);
        const goal = state2.goals.find((g) => g.id === request.goalID);
        if (!goal) {
          response = { ...base, ok: false, message: "goal not found", errorCode: "not_found" };
          break;
        }
        if (goal.status === "complete") {
          response = { ...base, message: `goal "${goal.name}" already complete`, stateRevision: state2.revision };
          break;
        }
        goal.status = "complete";
        goal.updatedAt = new Date().toISOString();
        goal.completionEvidence = {
          summary: String(args.summary || "Force-completed from dashboard."),
          evidence: String(args.evidence || "Manual override \u2014 no verification checks run."),
          at: new Date().toISOString()
        };
        const runtime = state2.runtimes.find((r) => r.goalID === goal.id);
        if (runtime) {
          Object.assign(runtime, releaseLease(runtime));
          runtime.activeRunID = undefined;
          runtime.lastError = undefined;
          runtime.updatedAt = new Date().toISOString();
        }
        await writeState(directory, state2);
        await appendEvent(directory, {
          version: 1,
          eventID: randomUUID(),
          goalID: goal.id,
          type: "goal.completed",
          summary: goal.completionEvidence.summary,
          evidence: goal.completionEvidence.evidence,
          timestamp: new Date().toISOString(),
          revision: state2.revision
        });
        response = { ...base, message: `goal "${goal.name}" force-completed`, stateRevision: state2.revision };
        break;
      }
      case "force_block":
      case "block": {
        const args = request.args;
        const state2 = await readState(directory);
        const goal = state2.goals.find((g) => g.id === request.goalID);
        if (!goal) {
          response = { ...base, ok: false, message: "goal not found", errorCode: "not_found" };
          break;
        }
        if (goal.status === "blocked") {
          response = { ...base, message: `goal "${goal.name}" already blocked`, stateRevision: state2.revision };
          break;
        }
        goal.status = "blocked";
        goal.updatedAt = new Date().toISOString();
        goal.blocker = {
          reason: String(args.reason || "Blocked from dashboard."),
          needed: String(args.needed || "User intervention required."),
          at: new Date().toISOString()
        };
        const runtime = state2.runtimes.find((r) => r.goalID === goal.id);
        if (runtime) {
          Object.assign(runtime, releaseLease(runtime));
          runtime.activeRunID = undefined;
          runtime.lastError = undefined;
          runtime.updatedAt = new Date().toISOString();
        }
        await writeState(directory, state2);
        await appendEvent(directory, {
          version: 1,
          eventID: randomUUID(),
          goalID: goal.id,
          type: "goal.blocked",
          reason: goal.blocker.reason,
          needed: goal.blocker.needed,
          timestamp: new Date().toISOString(),
          revision: state2.revision
        });
        response = { ...base, message: `goal "${goal.name}" blocked`, stateRevision: state2.revision };
        break;
      }
      default: {
        response = {
          requestID: request.requestID,
          ok: false,
          message: `command "${request.command}" not implemented in worker`,
          errorCode: "unknown_command",
          completedAt: new Date().toISOString()
        };
      }
    }
    await recordInLedger(directory, request);
    return response;
  }
  async function recordInLedger(directory2, request) {
    const state = await readState(directory2);
    if (!state.commandLedger)
      state.commandLedger = [];
    state.commandLedger.push({
      requestID: request.requestID,
      command: request.command,
      goalID: request.goalID,
      acceptedAt: request.requestedAt,
      completedAt: new Date().toISOString()
    });
    if (state.commandLedger.length > MAX_LEDGER_SIZE) {
      state.commandLedger = state.commandLedger.slice(-MAX_LEDGER_SIZE);
    }
    await writeState(directory2, state);
  }
  return { start, stop: async () => {
    await stop();
  }, isRunning: () => running };
}

// src/application/loop-engine.ts
import { randomUUID as randomUUID2 } from "crypto";

// src/domain/goal.ts
var MODEL_TRANSITIONS = {
  active: ["complete", "blocked"],
  paused: [],
  blocked: [],
  budget_limited: ["complete", "blocked"],
  usage_limited: [],
  complete: []
};
var USER_TRANSITIONS = {
  active: ["paused"],
  paused: ["active"],
  blocked: ["active"],
  budget_limited: ["active"],
  usage_limited: ["active"],
  complete: ["active"]
};
var SYSTEM_TRANSITIONS = {
  active: ["budget_limited", "usage_limited"],
  paused: [],
  blocked: [],
  budget_limited: [],
  usage_limited: [],
  complete: []
};
function canTransition(current, target, caller) {
  const table = caller === "model" ? MODEL_TRANSITIONS : caller === "user" ? USER_TRANSITIONS : SYSTEM_TRANSITIONS;
  return table[current]?.includes(target) ?? false;
}
function isTerminal(status) {
  return status === "complete";
}
function createGoal(input) {
  const now = new Date().toISOString();
  return { ...input, tokensUsed: 0, costUsed: 0, timeUsedSeconds: 0, createdAt: now, updatedAt: now };
}
// src/application/loop-engine.ts
var CONFIRM_IDLE_DURATION_MS = 2000;
var HANDLED_EVENT_TYPES = new Set([
  "session.idle",
  "session.status",
  "session.error",
  "session.compacted",
  "message.updated",
  "message.part.updated"
]);
function createLoopEngine(options) {
  const { directory, host, goalService } = options;
  const maintenanceMs = options.pollIntervalMs ?? 30000;
  const confirmIdleMs = options.confirmIdleMs ?? CONFIRM_IDLE_DURATION_MS;
  const unknownStatusThreshold = Math.max(1, options.unknownStatusThreshold ?? 3);
  const stuckRunningMs = options.stuckRunningMs ?? 10 * 60000;
  const idleUnconfirmedMs = options.idleUnconfirmedMs ?? 5 * 60000;
  const idleRecoverMs = options.idleRecoverMs ?? 3 * 60000;
  let running = false;
  let maintenanceTimer;
  let knownWorkerSessions = new Set;
  let knownWorkerSessionsLoaded = false;
  const inflightContinuations = new Set;
  const recentForceFinishBlocked = new Map;
  async function loadWorkerSessionsIfneeded() {
    if (knownWorkerSessionsLoaded)
      return;
    try {
      const state = await readState(directory);
      for (const g of state.goals) {
        if (g.workerSessionID)
          knownWorkerSessions.add(g.workerSessionID);
      }
      knownWorkerSessionsLoaded = true;
    } catch {}
  }
  function syncWorkerSessionsFromService() {
    for (const worker of goalService.getActiveWorkers().values()) {
      knownWorkerSessions.add(worker.workerSessionID);
    }
  }
  async function preloadWorkerSessions() {
    await loadWorkerSessionsIfneeded();
    syncWorkerSessionsFromService();
  }
  function start() {
    if (running)
      return;
    running = true;
    loadWorkerSessionsIfneeded().catch(() => {});
    maintenanceTimer = setInterval(() => {
      if (running)
        maintenance().catch(() => {});
    }, maintenanceMs);
  }
  function stop() {
    running = false;
    if (maintenanceTimer)
      clearInterval(maintenanceTimer);
    maintenanceTimer = undefined;
    inflightContinuations.clear();
  }
  function isRunning() {
    return running;
  }
  async function continueGoal(goalID) {
    if (inflightContinuations.has(goalID))
      return false;
    inflightContinuations.add(goalID);
    try {
      await goalService.continueTurn(directory, goalID);
      return true;
    } finally {
      inflightContinuations.delete(goalID);
    }
  }
  async function handleEvent(event) {
    if (!running || !event || typeof event !== "object")
      return false;
    const type = event.type;
    if (!type || !HANDLED_EVENT_TYPES.has(type))
      return false;
    const sessionID = eventSessionID(event);
    if (!sessionID)
      return false;
    await loadWorkerSessionsIfneeded();
    syncWorkerSessionsFromService();
    if (knownWorkerSessionsLoaded && knownWorkerSessions.size === 0)
      return false;
    if (knownWorkerSessions.size > 0 && !knownWorkerSessions.has(sessionID))
      return false;
    const state = await readState(directory);
    const goal = state.goals.find((g) => g.workerSessionID === sessionID);
    if (!goal)
      return false;
    if (goal.workerSessionID)
      knownWorkerSessions.add(goal.workerSessionID);
    if (goal.status !== "active")
      return false;
    switch (type) {
      case "session.idle":
        return await handleSessionIdle(state, goal);
      case "session.status":
        return await handleSessionStatus(state, goal, event);
      case "session.error":
        return await handleSessionError(state, goal, event);
      case "session.compacted":
        return await handleSessionCompacted(state, goal);
      case "message.updated":
      case "message.part.updated":
        return await handleMessageActivity(goal, event);
      default:
        return false;
    }
  }
  function eventSessionID(event) {
    return event.properties?.sessionID || event.properties?.info?.sessionID || event.properties?.part?.sessionID;
  }
  async function handleMessageActivity(goal, event) {
    let matched = false;
    await mutateState(directory, `message-activity:${goal.id}`, async (s) => {
      const rt = s.runtimes.find((r) => r.goalID === goal.id);
      if (!rt || rt.phase !== "running" || !rt.activePromptMessageID)
        return s;
      if (event.type === "message.updated") {
        const info = event.properties?.info;
        if (info?.role === "user" && info.id === rt.activePromptMessageID) {
          Object.assign(rt, recordActivity(rt));
          rt.activePromptObservedAt = new Date().toISOString();
          matched = true;
        } else if (info?.role === "assistant" && info.parentID === rt.activePromptMessageID) {
          Object.assign(rt, recordActivity(rt));
          rt.activeAssistantMessageID = info.id;
          if (info.time?.completed) {
            rt.activeAssistantCompletedAt = new Date(info.time.completed).toISOString();
          }
          matched = true;
        }
      } else {
        const part = event.properties?.part;
        if (part?.messageID && part.messageID === rt.activeAssistantMessageID) {
          if (rt.activeAssistantCompletedAt)
            return s;
          Object.assign(rt, recordActivity(rt));
          matched = true;
        }
      }
      return s;
    });
    return matched;
  }
  async function handleSessionIdle(state, goal) {
    const goalID = goal.id;
    if (inflightContinuations.has(goalID))
      return false;
    let completedRunID;
    let confirmation;
    let afterIdle = await mutateState(directory, `idle:${goalID}`, async (s) => {
      const g = s.goals.find((item) => item.id === goalID);
      if (!g)
        return s;
      if (isTerminal(g.status) || g.status === "paused")
        return s;
      const rt = s.runtimes.find((r) => r.goalID === goalID);
      if (!rt)
        return s;
      if (rt.phase !== "running")
        return s;
      if ((rt.activeToolCallIDs?.length ?? 0) > 0) {
        rt.idleCandidateAt = undefined;
        rt.idleCandidateGeneration = undefined;
        return s;
      }
      const now = Date.now();
      if (!rt.idleCandidateAt || rt.idleCandidateGeneration !== rt.runGeneration) {
        rt.idleCandidateAt = new Date(now).toISOString();
        rt.idleCandidateGeneration = rt.runGeneration;
        return s;
      }
      const elapsed = now - Date.parse(rt.idleCandidateAt);
      if (elapsed < confirmIdleMs)
        return s;
      const anchoredHere = Boolean(rt.activeAssistantCompletedAt);
      const quietSince = anchoredHere && rt.activeAssistantCompletedAt ? rt.activeAssistantCompletedAt : rt.idleCandidateAt;
      if (rt.lastActivityAt && rt.lastActivityAt > rt.idleCandidateAt && rt.lastActivityAt > quietSince) {
        rt.idleCandidateAt = undefined;
        rt.idleCandidateGeneration = undefined;
        return s;
      }
      if (rt.activePromptMessageID) {
        confirmation = {
          generation: rt.runGeneration,
          promptMessageID: rt.activePromptMessageID,
          candidateAt: rt.idleCandidateAt,
          assistantCompleted: Boolean(rt.activeAssistantCompletedAt)
        };
      } else {
        completedRunID = rt.activeRunID;
        Object.assign(rt, releaseLease(rt));
        rt.activeRunID = undefined;
        rt.lastWorkerStatus = "idle";
      }
      return s;
    });
    if (confirmation) {
      const candidate = confirmation;
      const stagedRt = afterIdle.runtimes.find((r) => r.goalID === goalID);
      const eventAnchored = stagedRt?.runGeneration === candidate.generation && Boolean(stagedRt?.activeAssistantCompletedAt);
      const transcript = await inspectPromptTurn(goal.workerSessionID, candidate.promptMessageID);
      const failureReason = !transcript.latestUserPrompt && !eventAnchored ? "prompt-outside-window" : !eventAnchored && !candidate.assistantCompleted && !transcript.assistantCompleted ? "assistant-incomplete" : undefined;
      if (failureReason) {
        let newlyStamped = false;
        await mutateState(directory, `idle.confirm-stamp:${goalID}`, async (s) => {
          const rt = s.runtimes.find((r) => r.goalID === goalID);
          if (!rt || rt.runGeneration !== candidate.generation)
            return s;
          if (rt.idleConfirmFailedGeneration !== candidate.generation) {
            rt.idleConfirmFailedAt = new Date().toISOString();
            rt.idleConfirmFailedGeneration = candidate.generation;
            newlyStamped = true;
          }
          return s;
        });
        if (newlyStamped) {
          await appendEvent(directory, {
            version: 1,
            eventID: randomUUID2(),
            goalID,
            type: "idle.confirm-failed",
            reason: failureReason,
            runGeneration: candidate.generation,
            timestamp: new Date().toISOString(),
            revision: afterIdle.revision
          });
        }
        return true;
      }
      afterIdle = await mutateState(directory, `idle.confirm:${goalID}`, async (s) => {
        const g = s.goals.find((item) => item.id === goalID);
        const rt = s.runtimes.find((r) => r.goalID === goalID);
        if (!g || !rt || isTerminal(g.status) || g.status === "paused")
          return s;
        if (rt.phase !== "running")
          return s;
        if (rt.runGeneration !== candidate.generation)
          return s;
        if (rt.activePromptMessageID !== candidate.promptMessageID)
          return s;
        if (rt.idleCandidateGeneration !== candidate.generation)
          return s;
        if (rt.idleCandidateAt !== candidate.candidateAt)
          return s;
        if (rt.lastActivityAt && rt.lastActivityAt > candidate.candidateAt) {
          const quiet = rt.runGeneration === candidate.generation && rt.activeAssistantCompletedAt ? rt.activeAssistantCompletedAt : candidate.candidateAt;
          if (rt.lastActivityAt > quiet)
            return s;
        }
        if ((rt.activeToolCallIDs?.length ?? 0) > 0)
          return s;
        completedRunID = rt.activeRunID;
        Object.assign(rt, releaseLease(rt));
        rt.activeRunID = undefined;
        rt.lastWorkerStatus = "idle";
        rt.idleConfirmFailedAt = undefined;
        rt.idleConfirmFailedGeneration = undefined;
        return s;
      });
    }
    if (completedRunID) {
      await appendEvent(directory, {
        version: 1,
        eventID: randomUUID2(),
        goalID,
        type: "run.completed",
        runID: completedRunID,
        timestamp: new Date().toISOString(),
        revision: afterIdle.revision
      });
    } else {
      return true;
    }
    const freshState = await readState(directory);
    const freshGoal = freshState.goals.find((g) => g.id === goalID);
    if (!freshGoal || freshGoal.status !== "active")
      return false;
    const freshRuntime = freshState.runtimes.find((r) => r.goalID === goalID);
    if (!freshRuntime)
      return false;
    const limitResult = enforceLimits(freshGoal, freshRuntime);
    if (limitResult.stop === "force_finish") {
      if (!freshRuntime.forceFinishRequested) {
        await mutateState(directory, `idle.force-finish:${goalID}`, async (s) => {
          const rt = s.runtimes.find((r) => r.goalID === goalID);
          if (rt)
            rt.forceFinishRequested = true;
          return s;
        });
        await goalService.continueTurn(directory, goalID, { forceFinish: true });
        return true;
      }
      const blockedKey = goalID;
      const nowBlocked = Date.now();
      const lastBlocked = recentForceFinishBlocked.get(blockedKey);
      if (lastBlocked !== undefined && nowBlocked - lastBlocked < 60000)
        return true;
      recentForceFinishBlocked.set(blockedKey, nowBlocked);
      let shouldNotifyBlocked = false;
      await goalService.accountUsage(directory, goalID).catch(() => ({
        tokenDelta: 0,
        costDelta: 0,
        timeDeltaSeconds: 0,
        counted: []
      }));
      const blockedState = await mutateState(directory, `idle.blocked:${goalID}`, async (s) => {
        const g = s.goals.find((item) => item.id === goalID);
        if (!g)
          return s;
        g.status = "blocked";
        g.updatedAt = new Date().toISOString();
        g.blocker = {
          reason: limitResult.reason + " (force-finish ignored)",
          needed: "User intervention required. Use retry to attempt again.",
          at: new Date().toISOString()
        };
        const rt = s.runtimes.find((r) => r.goalID === goalID);
        if (rt) {
          rt.forceFinishRequested = undefined;
          if (shouldNotifyParent(rt, "stopped")) {
            markParentNotified(rt, "stopped");
            shouldNotifyBlocked = true;
          }
        }
        return s;
      });
      await appendEvent(directory, {
        version: 1,
        eventID: randomUUID2(),
        goalID,
        type: "goal.blocked",
        reason: limitResult.reason + " (force-finish ignored)",
        needed: "User intervention required. Use retry to attempt again.",
        timestamp: new Date().toISOString(),
        revision: blockedState.revision
      });
      if (shouldNotifyBlocked) {
        await host.notifyOwner(goal.ownerSessionID, `Loop goal "${goal.name}" stopped: ${limitResult.reason} (child did not wrap up). Status: blocked. Last progress: ${goal.lastProgress?.summary || "none"}.`);
      }
      return true;
    }
    if (limitResult.stop === "budget") {
      const budgetState = await mutateState(directory, `idle.budget:${goalID}`, async (s) => {
        const g = s.goals.find((item) => item.id === goalID);
        if (g) {
          g.status = "budget_limited";
          g.updatedAt = new Date().toISOString();
        }
        return s;
      });
      await appendEvent(directory, {
        version: 1,
        eventID: randomUUID2(),
        goalID,
        type: "goal.status_changed",
        from: "active",
        to: "budget_limited",
        timestamp: new Date().toISOString(),
        revision: budgetState.revision
      });
      return true;
    }
    if (shouldCompact(freshGoal, freshRuntime)) {
      await doCompact(freshGoal, freshRuntime);
      return true;
    }
    await continueGoal(goalID);
    return true;
  }
  async function inspectPromptTurn(workerSessionID, promptMessageID) {
    const noMatch = { latestUserPrompt: false, assistantCompleted: false };
    if (!workerSessionID)
      return noMatch;
    let messages;
    try {
      messages = await host.readMessages(workerSessionID, 200);
    } catch {
      return noMatch;
    }
    const users = messages.filter((message) => message.role === "user");
    if (users.length === 0)
      return noMatch;
    const allTimestamped = users.every((message) => message.timestamp && Number.isFinite(Date.parse(message.timestamp)));
    const ordered = allTimestamped ? [...users].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)) : users;
    return {
      latestUserPrompt: ordered.at(-1)?.messageID === promptMessageID,
      assistantCompleted: messages.some((message) => message.role === "assistant" && message.parentMessageID === promptMessageID && Boolean(message.completedAt))
    };
  }
  async function handleSessionStatus(state, goal, event) {
    const runtime = state.runtimes.find((r) => r.goalID === goal.id);
    if (!runtime)
      return false;
    const status = event.properties?.status;
    const statusType = status?.type;
    if (!statusType)
      return false;
    if (statusType === "idle")
      return handleSessionIdle(state, goal);
    await mutateState(directory, `status:${goal.id}`, async (s) => {
      const rt = s.runtimes.find((r) => r.goalID === goal.id);
      if (!rt)
        return s;
      if (statusType === "busy" || statusType === "retry") {
        Object.assign(rt, recordActivity(rt));
      }
      rt.lastWorkerStatus = statusType;
      rt.updatedAt = new Date().toISOString();
      return s;
    });
    return true;
  }
  async function handleSessionError(state, goal, event) {
    const runtime = state.runtimes.find((r) => r.goalID === goal.id);
    if (!runtime)
      return false;
    const error = event.properties?.error;
    const message = describeError(error) || "unknown error";
    let shouldNotify = false;
    const newState = await mutateState(directory, `error:${goal.id}`, async (s) => {
      const g = s.goals.find((item) => item.id === goal.id);
      const rt = s.runtimes.find((r) => r.goalID === goal.id);
      if (!rt)
        return s;
      rt.consecutiveFailures += 1;
      rt.lastError = message;
      rt.updatedAt = new Date().toISOString();
      rt.idleCandidateAt = undefined;
      if (rt.phase === "running") {
        Object.assign(rt, releaseLease(rt));
      }
      if (rt.consecutiveFailures >= (goal.config?.maxFailures || 5)) {
        if (g) {
          g.status = "blocked";
          g.updatedAt = new Date().toISOString();
          g.blocker = {
            reason: `Failed ${rt.consecutiveFailures} times. Last error: ${message}`,
            needed: "User intervention required. Use retry to attempt again.",
            at: new Date().toISOString()
          };
        }
        if (shouldNotifyParent(rt, "failed")) {
          markParentNotified(rt, "failed");
          shouldNotify = true;
        }
      } else {
        const backoffMs = Math.min(30000, 1000 * Math.pow(2, rt.consecutiveFailures));
        rt.retryAfter = new Date(Date.now() + backoffMs).toISOString();
        rt.phase = "waiting_retry";
      }
      return s;
    });
    await appendEvent(directory, {
      version: 1,
      eventID: randomUUID2(),
      goalID: goal.id,
      type: "run.failed",
      runID: runtime.activeRunID || "unknown",
      error: message,
      consecutiveFailures: runtime.consecutiveFailures + 1,
      timestamp: new Date().toISOString(),
      revision: newState.revision
    });
    const updatedGoal = newState.goals.find((g) => g.id === goal.id);
    if (updatedGoal?.status === "blocked") {
      await appendEvent(directory, {
        version: 1,
        eventID: randomUUID2(),
        goalID: goal.id,
        type: "goal.blocked",
        reason: `Failed ${runtime.consecutiveFailures + 1} times`,
        needed: "User intervention required",
        timestamp: new Date().toISOString(),
        revision: newState.revision
      });
      if (shouldNotify) {
        await host.notifyOwner(goal.ownerSessionID, `Loop goal "${goal.name}" blocked after ${runtime.consecutiveFailures + 1} failures. Last error: ${message}.`);
      }
    }
    return true;
  }
  async function handleSessionCompacted(state, goal) {
    const runtime = state.runtimes.find((r) => r.goalID === goal.id);
    if (!runtime)
      return false;
    const newState = await mutateState(directory, `compacted:${goal.id}`, async (s) => {
      const rt = s.runtimes.find((r) => r.goalID === goal.id);
      if (!rt)
        return s;
      rt.lastCompactAt = new Date().toISOString();
      rt.updatedAt = new Date().toISOString();
      return s;
    });
    await appendEvent(directory, {
      version: 1,
      eventID: randomUUID2(),
      goalID: goal.id,
      type: "compaction.completed",
      timestamp: new Date().toISOString(),
      revision: newState.revision
    });
    return true;
  }
  function enforceLimits(goal, runtime) {
    const noResult = { stop: "none", blocked: false, event: "goal.status_changed", reason: "" };
    const maxTurns = goal.config?.maxTurns;
    if (maxTurns && runtime.budgetTurnCount >= maxTurns) {
      return {
        stop: "force_finish",
        blocked: true,
        event: "goal.blocked",
        reason: `Reached max turns (${maxTurns})`
      };
    }
    const maxNoProgress = goal.config?.maxNoProgress;
    if (maxNoProgress && runtime.noProgressCount >= maxNoProgress) {
      return {
        stop: "force_finish",
        blocked: true,
        event: "goal.blocked",
        reason: `No progress for ${runtime.noProgressCount} consecutive turns`
      };
    }
    if (goal.tokenBudget && goal.tokensUsed >= goal.tokenBudget) {
      goal.status = "budget_limited";
      goal.updatedAt = new Date().toISOString();
      return {
        stop: "budget",
        blocked: true,
        event: "goal.status_changed",
        reason: `Token budget exhausted (${goal.tokensUsed}/${goal.tokenBudget})`
      };
    }
    if (typeof goal.costBudget === "number" && (goal.costUsed ?? 0) >= goal.costBudget) {
      goal.status = "budget_limited";
      goal.updatedAt = new Date().toISOString();
      return {
        stop: "budget",
        blocked: true,
        event: "goal.status_changed",
        reason: `Cost budget exhausted ($${(goal.costUsed ?? 0).toFixed(4)}/$${goal.costBudget})`
      };
    }
    return noResult;
  }
  function shouldCompact(goal, runtime) {
    const compactEvery = goal.config?.compactEvery;
    if (!compactEvery)
      return false;
    return runtime.runCount > 0 && runtime.runCount % compactEvery === 0;
  }
  async function doCompact(goal, runtime) {
    if (!goal.workerSessionID)
      return;
    const prevPhase = runtime.phase;
    const state = await mutateState(directory, `compact.start:${goal.id}`, async (s) => {
      const rt = s.runtimes.find((r) => r.goalID === goal.id);
      if (!rt)
        return s;
      rt.phase = "compacting";
      rt.lastCompactAt = new Date().toISOString();
      return s;
    });
    await appendEvent(directory, {
      version: 1,
      eventID: randomUUID2(),
      goalID: goal.id,
      type: "compaction.started",
      timestamp: new Date().toISOString(),
      revision: state.revision
    });
    try {
      await host.compactSession(goal.workerSessionID);
    } catch {}
    await mutateState(directory, `compact.end:${goal.id}`, async (s) => {
      const rt = s.runtimes.find((r) => r.goalID === goal.id);
      if (rt)
        rt.phase = prevPhase;
      return s;
    });
  }
  async function accountAndEnforceBudget(goal) {
    try {
      await goalService.accountUsage(directory, goal.id);
    } catch {}
    const fresh = await readState(directory);
    const g = fresh.goals.find((item) => item.id === goal.id);
    if (!g || g.status !== "active")
      return false;
    const overTokens = typeof g.tokenBudget === "number" && g.tokensUsed >= g.tokenBudget;
    const overCost = typeof g.costBudget === "number" && (g.costUsed ?? 0) >= g.costBudget;
    if (!overTokens && !overCost)
      return false;
    const reason = overCost ? `Cost budget exhausted ($${(g.costUsed ?? 0).toFixed(4)}/$${g.costBudget})` : `Token budget exhausted (${g.tokensUsed}/${g.tokenBudget})`;
    if (g.workerSessionID) {
      try {
        await host.abortSession(g.workerSessionID);
      } catch {}
    }
    let shouldNotify = false;
    const stoppedState = await mutateState(directory, `maintenance.budget:${goal.id}`, async (s) => {
      const target = s.goals.find((item) => item.id === goal.id);
      if (!target || target.status !== "active")
        return s;
      target.status = "budget_limited";
      target.updatedAt = new Date().toISOString();
      const rt = s.runtimes.find((r) => r.goalID === goal.id);
      if (rt) {
        Object.assign(rt, releaseLease(rt));
        rt.activeRunID = undefined;
        rt.updatedAt = new Date().toISOString();
        if (shouldNotifyParent(rt, "stopped")) {
          markParentNotified(rt, "stopped");
          shouldNotify = true;
        }
      }
      return s;
    });
    const stoppedGoal = stoppedState.goals.find((item) => item.id === goal.id);
    if (stoppedGoal?.status !== "budget_limited")
      return false;
    await appendEvent(directory, {
      version: 1,
      eventID: randomUUID2(),
      goalID: goal.id,
      type: "goal.status_changed",
      from: "active",
      to: "budget_limited",
      timestamp: new Date().toISOString(),
      revision: stoppedState.revision
    });
    await logServerEvent(directory, "maintenance.budget-exhausted", {
      goalID: goal.id,
      reason,
      tokensUsed: stoppedGoal.tokensUsed,
      costUsed: stoppedGoal.costUsed
    });
    if (shouldNotify) {
      await host.notifyOwner(goal.ownerSessionID, `Loop goal "${goal.name}" stopped: ${reason}. Worker aborted, status: budget_limited. Resume with resume_goal to continue spending.`);
    }
    return true;
  }
  async function maintenance() {
    syncWorkerSessionsFromService();
    if (knownWorkerSessions.size === 0)
      return;
    const state = await readState(directory);
    for (const goal of state.goals) {
      if (goal.status === "active")
        continue;
      const rt = state.runtimes.find((r) => r.goalID === goal.id);
      if (!rt)
        continue;
      if (rt.phase === "idle" && (rt.activeRunID || rt.leaseExpiresAt || rt.activePromptMessageID)) {
        await mutateState(directory, `maintenance.clear-terminal-leak:${goal.id}`, async (s) => {
          const r = s.runtimes.find((x) => x.goalID === goal.id);
          if (r && r.phase === "idle" && (r.activeRunID || r.leaseExpiresAt || r.activePromptMessageID)) {
            Object.assign(r, releaseLease(r));
            r.activeRunID = undefined;
            r.unknownStatusCount = 0;
            r.lastUnknownStatusAt = undefined;
            r.workerUnreachableNotifiedAt = undefined;
            r.updatedAt = new Date().toISOString();
          }
          return s;
        });
        await logServerEvent(directory, "maintenance.terminal-leak-cleared", { goalID: goal.id, status: goal.status });
      }
    }
    const hasActiveGoals = state.goals.some((g) => g.status === "active");
    if (!hasActiveGoals)
      return;
    for (const goal of state.goals) {
      if (goal.status !== "active")
        continue;
      const runtime = state.runtimes.find((r) => r.goalID === goal.id);
      if (!runtime)
        continue;
      if (goal.workerSessionID) {
        const stopped = await accountAndEnforceBudget(goal);
        if (stopped)
          continue;
      }
      if (runtime.phase === "waiting_retry" && runtime.retryAfter) {
        if (Date.now() >= Date.parse(runtime.retryAfter)) {
          await mutateState(directory, `retry-ready:${goal.id}`, async (s) => {
            const rt = s.runtimes.find((r) => r.goalID === goal.id);
            if (rt) {
              rt.retryAfter = undefined;
              rt.phase = "idle";
            }
            return s;
          });
          goalService.continueTurn(directory, goal.id).catch(() => {});
        }
      }
      if ((runtime.phase === "running" || runtime.phase === "idle") && goal.workerSessionID) {
        if (runtime.phase === "idle" && runtime.activeRunID) {
          await mutateState(directory, `maintenance.clear-stale-run:${goal.id}`, async (s) => {
            const rt = s.runtimes.find((r) => r.goalID === goal.id);
            if (rt?.phase === "idle" && rt.activeRunID) {
              Object.assign(rt, releaseLease(rt));
              rt.activeRunID = undefined;
              rt.lastWorkerStatus = "idle";
            }
            return s;
          });
          await logServerEvent(directory, "maintenance.stale-run-cleared", { goalID: goal.id });
        }
        if ((runtime.activeToolCallIDs?.length ?? 0) > 0 && runtime.lastActivityAt) {
          const age = Date.now() - Date.parse(runtime.lastActivityAt);
          if (age > 30000) {
            await mutateState(directory, `maintenance.toolcall-ttl:${goal.id}`, async (s) => {
              const rt = s.runtimes.find((r) => r.goalID === goal.id);
              if (rt && (rt.activeToolCallIDs?.length ?? 0) > 0) {
                rt.activeToolCallIDs = [];
                rt.idleCandidateAt = undefined;
                rt.idleCandidateGeneration = undefined;
                rt.updatedAt = new Date().toISOString();
              }
              return s;
            });
            await logServerEvent(directory, "maintenance.toolcall-ttl-cleared", { goalID: goal.id, age });
          }
        }
        const status = await host.sessionStatus(goal.workerSessionID);
        if (status === "unknown") {
          let shouldNotify = false;
          const unknownState = await mutateState(directory, `maintenance.unknown-status:${goal.id}`, async (s) => {
            const rt = s.runtimes.find((r) => r.goalID === goal.id);
            if (!rt)
              return s;
            rt.unknownStatusCount = Math.min(unknownStatusThreshold, (rt.unknownStatusCount ?? 0) + 1);
            rt.lastUnknownStatusAt = new Date().toISOString();
            if (rt.unknownStatusCount >= unknownStatusThreshold && !rt.workerUnreachableNotifiedAt) {
              rt.workerUnreachableNotifiedAt = new Date().toISOString();
              shouldNotify = true;
            }
            rt.updatedAt = new Date().toISOString();
            return s;
          });
          const unknownRuntime = unknownState.runtimes.find((r) => r.goalID === goal.id);
          if (shouldNotify) {
            await logServerEvent(directory, "maintenance.worker-unreachable", {
              goalID: goal.id,
              workerSessionID: goal.workerSessionID,
              count: unknownRuntime?.unknownStatusCount
            });
            await host.notifyOwner(goal.ownerSessionID, `Loop goal "${goal.name}" worker is unreachable after ${unknownRuntime?.unknownStatusCount ?? unknownStatusThreshold} status checks. The goal remains active; use inspect_background_goal, nudge_goal, pause_goal, or resume_goal to recover it.`);
          }
          continue;
        }
        if ((runtime.unknownStatusCount ?? 0) > 0 || runtime.workerUnreachableNotifiedAt) {
          await mutateState(directory, `maintenance.status-recovered:${goal.id}`, async (s) => {
            const rt = s.runtimes.find((r) => r.goalID === goal.id);
            if (rt) {
              rt.unknownStatusCount = 0;
              rt.lastUnknownStatusAt = undefined;
              rt.workerUnreachableNotifiedAt = undefined;
              rt.updatedAt = new Date().toISOString();
            }
            return s;
          });
          await logServerEvent(directory, "maintenance.worker-recovered", { goalID: goal.id });
        }
        if (status === "idle" && runtime.phase === "running") {
          const lastSignal = Math.max(runtime.lastActivityAt ? Date.parse(runtime.lastActivityAt) : 0, runtime.lastRunAt ? Date.parse(runtime.lastRunAt) : 0, runtime.turnStartedAt ? Date.parse(runtime.turnStartedAt) : 0);
          const quietMs = Date.now() - lastSignal;
          if (lastSignal > 0 && quietMs > idleRecoverMs) {
            const generation = runtime.runGeneration;
            const stalledRunID = runtime.activeRunID;
            let clearedToolCalls = 0;
            let recovered = false;
            const recoveredState = await mutateState(directory, `maintenance.idle-recover:${goal.id}`, async (s) => {
              const g = s.goals.find((item) => item.id === goal.id);
              const rt = s.runtimes.find((r) => r.goalID === goal.id);
              if (!g || !rt || g.status !== "active")
                return s;
              if (rt.phase !== "running")
                return s;
              if (rt.runGeneration !== generation)
                return s;
              clearedToolCalls = rt.activeToolCallIDs?.length ?? 0;
              Object.assign(rt, releaseLease(rt));
              rt.activeRunID = undefined;
              rt.lastWorkerStatus = "idle";
              rt.idleConfirmFailedAt = undefined;
              rt.idleConfirmFailedGeneration = undefined;
              rt.idleStuckNotifiedGeneration = undefined;
              recovered = true;
              return s;
            });
            if (recovered) {
              await appendEvent(directory, {
                version: 1,
                eventID: randomUUID2(),
                goalID: goal.id,
                type: "run.recovered",
                runID: stalledRunID ?? "unknown",
                quietSeconds: Math.floor(quietMs / 1000),
                clearedToolCalls,
                timestamp: new Date().toISOString(),
                revision: recoveredState.revision
              });
              await logServerEvent(directory, "maintenance.idle-recovered", {
                goalID: goal.id,
                generation,
                quietSeconds: Math.floor(quietMs / 1000),
                clearedToolCalls
              });
              await continueGoal(goal.id);
              continue;
            }
          }
        }
        if (status === "idle" && runtime.phase === "running" && runtime.idleConfirmFailedGeneration === runtime.runGeneration && runtime.idleConfirmFailedAt && runtime.idleStuckNotifiedGeneration !== runtime.runGeneration && Date.now() - Date.parse(runtime.idleConfirmFailedAt) > idleUnconfirmedMs) {
          const failedAt = runtime.idleConfirmFailedAt;
          const generation = runtime.runGeneration;
          const stuckState = await mutateState(directory, `maintenance.idle-stuck:${goal.id}`, async (s) => {
            const rt = s.runtimes.find((r) => r.goalID === goal.id);
            if (!rt || rt.runGeneration !== generation || rt.phase !== "running")
              return s;
            rt.idleStuckNotifiedGeneration = generation;
            rt.updatedAt = new Date().toISOString();
            return s;
          });
          const stuckSeconds = Math.floor((Date.now() - Date.parse(failedAt)) / 1000);
          await appendEvent(directory, {
            version: 1,
            eventID: randomUUID2(),
            goalID: goal.id,
            type: "run.stuck",
            runID: runtime.activeRunID ?? "unknown",
            stuckSeconds,
            timestamp: new Date().toISOString(),
            revision: stuckState.revision
          });
          await logServerEvent(directory, "maintenance.idle-stuck", {
            goalID: goal.id,
            generation,
            stuckSeconds
          });
          const quietMinutes = Math.max(1, Math.floor(stuckSeconds / 60));
          await host.notifyOwner(goal.ownerSessionID, `Loop goal "${goal.name}" worker is idle but its turn will not confirm (unconfirmed for ${quietMinutes}m, no activity). The goal remains active; use inspect_background_goal to look, nudge_goal to re-prompt, or pause_goal to stop it.`);
          continue;
        }
        if (status === "idle") {
          if (runtime.phase === "idle") {
            await continueGoal(goal.id);
          } else {
            await handleSessionIdle(state, goal);
          }
          continue;
        }
        if ((status === "busy" || status === "retry") && runtime.phase === "running" && runtime.activeRunID && runtime.stuckNotifiedRunID !== runtime.activeRunID) {
          const leaseExpired = !runtime.leaseExpiresAt || Date.now() >= Date.parse(runtime.leaseExpiresAt);
          const lastActive = runtime.lastActivityAt ? Date.parse(runtime.lastActivityAt) : 0;
          if (leaseExpired && Date.now() - lastActive > stuckRunningMs) {
            const stuckSeconds = Math.floor((Date.now() - lastActive) / 1000);
            const stuckState = await mutateState(directory, `maintenance.run-stuck:${goal.id}`, async (s) => {
              const rt = s.runtimes.find((r) => r.goalID === goal.id);
              if (!rt || rt.activeRunID !== runtime.activeRunID)
                return s;
              rt.stuckNotifiedRunID = rt.activeRunID;
              rt.updatedAt = new Date().toISOString();
              return s;
            });
            await appendEvent(directory, {
              version: 1,
              eventID: randomUUID2(),
              goalID: goal.id,
              type: "run.stuck",
              runID: runtime.activeRunID,
              stuckSeconds,
              timestamp: new Date().toISOString(),
              revision: stuckState.revision
            });
            await logServerEvent(directory, "maintenance.run-stuck", {
              goalID: goal.id,
              runID: runtime.activeRunID,
              stuckSeconds
            });
            await host.notifyOwner(goal.ownerSessionID, `Loop goal "${goal.name}" worker may be stuck: no activity for ${Math.floor(stuckSeconds / 60)}m while reporting ${status}, lease expired. The goal remains active; use inspect_background_goal to look, nudge_goal to re-prompt, or pause_goal to stop it.`);
          }
        }
      }
    }
  }
  return { start, stop, isRunning, handleEvent, preloadWorkerSessions };
}

// src/application/goal-service.ts
import { randomUUID as randomUUID3 } from "crypto";
import * as path2 from "path";
import { promises as fs2 } from "fs";

// src/server/host-adapter.ts
function parseModelRef(value) {
  if (value === undefined)
    return;
  const trimmed = value.trim();
  if (!trimmed)
    return;
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash >= trimmed.length - 1) {
    throw new Error(`Invalid model "${value}". Use "providerID/modelID" (e.g. "openai/gpt-5.6-sol").`);
  }
  const providerID = trimmed.slice(0, slash).trim();
  const modelID = trimmed.slice(slash + 1).trim();
  if (!providerID || !modelID || /\s/.test(providerID) || /\s/.test(modelID)) {
    throw new Error(`Invalid model "${value}". Use "providerID/modelID" (e.g. "openai/gpt-5.6-sol").`);
  }
  return { providerID, modelID };
}
var recentParentNotifies = new Map;
function shouldDedupParentNotify(ownerSessionID, message) {
  const key = `${ownerSessionID}:${message.slice(0, 200)}`;
  const now = Date.now();
  const last = recentParentNotifies.get(key);
  if (last !== undefined && now - last < 60000)
    return true;
  recentParentNotifies.set(key, now);
  if (recentParentNotifies.size > 200) {
    for (const [k, t] of recentParentNotifies.entries())
      if (now - t > 60000)
        recentParentNotifies.delete(k);
  }
  return false;
}
function createRealHost(client, directory) {
  return {
    async createWorker({ parentID, title, agent, model }) {
      try {
        const body = { parentID, title };
        if (agent)
          body.agent = agent;
        if (model)
          body.model = { id: model.modelID, providerID: model.providerID };
        const result = await withTimeout(client.session.create({ body }), 1e4, "OpenCode session.create");
        const data = result?.data;
        if (result?.error || !data?.id) {
          const detail = describeError(result?.error || "response contained no session ID");
          await logServerEvent(directory, "worker.create.failed", { parentID, title, detail });
          throw new Error(`OpenCode session.create failed for parent "${parentID}": ${detail}`);
        }
        await logServerEvent(directory, "worker.created", { parentID, workerSessionID: data.id, title });
        return data.id;
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("OpenCode session.create failed"))
          throw error;
        const detail = describeError(error);
        await logServerEvent(directory, "worker.create.failed", { parentID, title, detail });
        throw new Error(`OpenCode session.create failed for parent "${parentID}": ${detail}`);
      }
    },
    async promptWorker({ sessionID, prompt, messageID, model, agent }) {
      const body = {
        parts: [{ type: "text", text: prompt }]
      };
      if (messageID) {
        const collapsed = messageID.replace(/^(msg-)+/, "msg-");
        body.messageID = collapsed.startsWith("msg-") ? collapsed : `msg-${messageID}`;
      }
      if (model)
        body.model = model;
      if (agent)
        body.agent = agent;
      const result = await withTimeout(client.session.promptAsync({
        path: { id: sessionID },
        body
      }), 1e4, "OpenCode session.promptAsync");
      if (result?.error) {
        const detail = describeError(result.error);
        await logServerEvent(directory, "worker.prompt.failed", { sessionID, detail });
        throw new Error(`OpenCode session.promptAsync failed for worker "${sessionID}": ${detail}`);
      }
      await logServerEvent(directory, "worker.prompted", { sessionID });
      return { messageID: result?.data?.messageID };
    },
    async sessionStatus(sessionID) {
      try {
        const result = await client.session.status({});
        if (result?.error)
          return "unknown";
        const data = result?.data;
        if (!data || typeof data !== "object" || Array.isArray(data))
          return "unknown";
        const status = data[sessionID];
        if (status === undefined || status === null)
          return "idle";
        if (typeof status !== "object" || Array.isArray(status))
          return "unknown";
        const type = status.type;
        if (type === "busy" || type === "retry")
          return type;
        if (type === "idle")
          return "idle";
        return "unknown";
      } catch {
        return "unknown";
      }
    },
    async abortSession(sessionID) {
      try {
        await client.session.abort({ path: { id: sessionID } });
      } catch {}
    },
    async readMessages(sessionID, limit = 10) {
      try {
        const result = await client.session.messages({
          path: { id: sessionID },
          query: { limit }
        });
        const data = result?.data;
        if (!Array.isArray(data))
          return [];
        return data.map((m) => {
          const createdMs = m.info?.time?.created;
          const completedMs = m.info?.time?.completed;
          const tokens = m.info?.tokens;
          return {
            role: m.info?.role || "assistant",
            content: m.parts?.filter((p) => p.type === "text").map((p) => p.text).join(`
`) || "",
            timestamp: completedMs || createdMs ? new Date(completedMs || createdMs).toISOString() : undefined,
            messageID: m.info?.id || m.id,
            parentMessageID: m.info?.parentID,
            completedAt: completedMs ? new Date(completedMs).toISOString() : undefined,
            tokens: tokens && typeof tokens.input === "number" ? {
              input: tokens.input || 0,
              output: tokens.output || 0,
              reasoning: tokens.reasoning || 0,
              cacheRead: tokens.cache?.read || 0,
              cacheWrite: tokens.cache?.write || 0
            } : undefined,
            cost: typeof m.info?.cost === "number" ? m.info.cost : undefined,
            durationMs: typeof createdMs === "number" && typeof completedMs === "number" && completedMs >= createdMs ? completedMs - createdMs : undefined
          };
        });
      } catch {
        return [];
      }
    },
    async compactSession(sessionID) {
      try {
        await client.session.compact({ sessionID });
      } catch {}
    },
    async notifyOwner(ownerSessionID, message) {
      if (shouldDedupParentNotify(ownerSessionID, message)) {
        await logServerEvent(directory, "parent.notify.deduped", { ownerSessionID, preview: message.slice(0, 160) });
        return;
      }
      try {
        const result = await withTimeout(client.session.promptAsync({
          path: { id: ownerSessionID },
          body: { parts: [{ type: "text", text: message }] }
        }), 1e4, "OpenCode parent notify");
        if (result?.error) {
          await logServerEvent(directory, "parent.notify.failed", { ownerSessionID, detail: describeError(result.error) });
        } else {
          await logServerEvent(directory, "parent.notified", { ownerSessionID, preview: message.slice(0, 160) });
        }
      } catch (error) {
        await logServerEvent(directory, "parent.notify.failed", { ownerSessionID, detail: describeError(error) });
      }
    }
  };
}
async function withTimeout(promise, timeoutMs, operation) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${operation} timed out after ${timeoutMs}ms`)), timeoutMs);
      })
    ]);
  } finally {
    if (timer)
      clearTimeout(timer);
  }
}

// src/server/worker-session.ts
function createWorkerManager(host) {
  return {
    async createWorker(goal) {
      const workerSessionID = await host.createWorker({
        parentID: goal.ownerSessionID,
        title: `loopd: ${goal.name}`,
        agent: goal.config.agent,
        model: parseModelRef(goal.config.model)
      });
      return {
        goalID: goal.id,
        workerSessionID,
        startedAt: new Date().toISOString()
      };
    },
    async continueWorker(worker, goal, runtime, context) {
      const prompt = buildContinuationSteering(goal, runtime, context);
      const result = await host.promptWorker({
        sessionID: worker.workerSessionID,
        prompt,
        messageID: runtime.activePromptMessageID,
        agent: goal.config.agent,
        model: parseModelRef(goal.config.model)
      });
      return result;
    },
    async sendBare(worker, goal, runtime, text) {
      const result = await host.promptWorker({
        sessionID: worker.workerSessionID,
        prompt: text,
        messageID: runtime.activePromptMessageID,
        agent: goal.config.agent,
        model: parseModelRef(goal.config.model)
      });
      return result;
    },
    async isIdle(workerSessionID) {
      const status = await host.sessionStatus(workerSessionID);
      return status === "idle";
    },
    async abortWorker(workerSessionID) {
      await host.abortSession(workerSessionID);
    },
    async compactWorker(workerSessionID) {
      await host.compactSession(workerSessionID);
    }
  };
}
function buildContinuationSteering(goal, runtime, context) {
  const parts = [];
  const artifactDir = goal.config.artifactDir;
  function outputLocationBlock() {
    if (!artifactDir)
      return [];
    return [
      ``,
      `## OUTPUT LOCATION`,
      `Write all files, logs, and artifacts under:`,
      artifactDir,
      ``,
      `Exception: if the objective explicitly specifies a different output directory, follow the objective instead.`
    ];
  }
  if (runtime.runCount <= 1) {
    parts.push(`You are a worker for an active goal.`, ``, `Call get_goal to read the authoritative objective, acceptance criteria, and current state.`, `Perform one concrete batch of work. After durable verification:`, ``, `- Call report_goal_progress if work remains.`, `- Call complete_goal only if ALL acceptance criteria pass with concrete evidence.`, `- Call block_goal only for a real external blocker requiring user intervention.`, `- Use the built-in question tool when you need clarification only the user can provide.`, ``, `Do not ask questions unnecessarily. Make reasonable assumptions and work directly.`);
    parts.push(...outputLocationBlock());
  } else {
    parts.push(`This is continuation run ${runtime.runCount} for the goal below.`, ``, `## GOAL (user-provided data)`, goal.objective);
    const progress = context?.progressHistory;
    if (progress && progress.length > 0) {
      parts.push(``, `## PROGRESS SO FAR`);
      for (const p of progress) {
        parts.push(`- [${p.at.slice(11, 16)}] ${p.summary}`);
        if (p.next)
          parts.push(`  \u2192 next: ${p.next}`);
      }
    }
    const tail = context?.transcriptTail;
    if (tail && tail.length > 0) {
      parts.push(``, `## RECENT WORK (last ${tail.length} messages)`);
      for (const m of tail) {
        const snippet = m.content.slice(0, 300).replace(/\n/g, " ");
        parts.push(`- [${m.role}] ${snippet}`);
      }
    }
    if (runtime.consecutiveFailures > 0) {
      parts.push(``, `## WARNINGS`);
      parts.push(`- ${runtime.consecutiveFailures} consecutive failure(s). Last error: ${runtime.lastError || "unknown"}.`);
      if (runtime.noProgressCount > 0) {
        parts.push(`- ${runtime.noProgressCount} turn(s) without progress. Work concretely this turn.`);
      }
    }
    parts.push(...outputLocationBlock());
    if (context?.verification) {
      const v = context.verification;
      if (v.evaluatorRejectionCount && v.evaluatorRejectionCount > 0) {
        parts.push(``, `## HOST VERDICT: COMPLETION REJECTED`);
        parts.push(`Rejection #${v.evaluatorRejectionCount}`);
        if (v.lastRejectionDetails) {
          parts.push(v.lastRejectionDetails);
        }
        parts.push(``, `Required action:`);
        parts.push(`- Fix the behavior causing the command(s) above to fail.`);
        parts.push(`- Do NOT merely rewrite the completion evidence.`);
        parts.push(`- Rerun the command from the stated directory.`);
        parts.push(`- Call complete_goal only after the command passes.`);
      } else {
        parts.push(``, `## VERIFICATION (deterministic pre-screen)`);
        if (v.checksPassed !== undefined) {
          if (v.checksPassed)
            parts.push(`- checks: all passed`);
          else if (v.failedChecks?.length)
            parts.push(`- checks FAILED: ${v.failedChecks.join(", ")} \u2014 fix before claiming completion`);
          else
            parts.push(`- checks: not yet run`);
        }
        if (v.artifactSummary)
          parts.push(`- artifacts: ${v.artifactSummary}`);
      }
    }
    parts.push(``, `## COMPLETION REVIEW`, `You are the semantic reviewer. The host is the acceptance authority.`, `Before proposing completion:`, `1. Derive concrete requirements from the objective and any referenced files/plans/specs/issues.`, `2. For each requirement, identify authoritative evidence: files, command output, test results.`, `3. Judge each: proves | contradicts | incomplete | missing.`, `4. Only call complete_goal when you have verified every requirement yourself.`, `5. If objective and checks appear contradictory, call block_goal \u2014 do not silently violate either.`);
    if (context?.forceFinish) {
      parts.push(``, `## FINAL REPORT REQUIRED \u2014 STOPPING SOON`, `The system requires you to wrap up now. Do NOT start new work.`, `Call complete_goal NOW with:`, `- summary: a specific semantic summary of what was accomplished (files changed, results, key findings)`, `- evidence: concrete proof (commands run, files created, checks passed)`, `If you cannot complete truthfully, call block_goal with the reason \u2014 do not fabricate evidence.`);
    } else {
      parts.push(``, `## INSTRUCTIONS`, `1. Inspect current workspace state \u2014 read files, check what exists. Do NOT redo completed work.`, `2. Continue concrete progress toward the objective.`, `3. After completing a batch, call report_goal_progress with what you did and what's next.`, `4. Use the built-in question tool only for genuinely risky ambiguity.`);
    }
  }
  if (context?.inboxMessages && context.inboxMessages.length > 0) {
    parts.push(``, `## USER INSTRUCTIONS`);
    for (const msg of context.inboxMessages) {
      parts.push(`- ${msg}`);
    }
  }
  return parts.join(`
`);
}

// src/application/goal-service.ts
function createGoalService(host) {
  const workers = createWorkerManager(host);
  const sessions = new Map;
  const goalOperations = new Map;
  async function withGoalOperation(goalID, fn) {
    const previous = goalOperations.get(goalID) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const current = previous.catch(() => {}).then(() => gate);
    goalOperations.set(goalID, current);
    await previous.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      if (goalOperations.get(goalID) === current)
        goalOperations.delete(goalID);
    }
  }
  function assertWorkspaceWriteAvailable(state, goal) {
    if (!goal.config.workspaceWrite)
      return;
    const activeWriter = state.goals.find((item) => item.id !== goal.id && item.status === "active" && item.config.workspaceWrite);
    if (activeWriter) {
      throw new Error(`Workspace-writing goal "${activeWriter.name}" (${activeWriter.id}) is already active. ` + "Pause, block, complete, or clear it before activating another workspace-writing goal.");
    }
  }
  async function recordPromptFailure(directory, goalID, error, blockImmediately = false) {
    const detail = describeError(error);
    let runID = "unknown";
    let failureCount = 0;
    let blocked = false;
    let blockerNeeded = "Retry after the OpenCode worker/session API is available.";
    const state = await mutateState(directory, `turn.prompt-failed:${goalID}`, async (s) => {
      const goal = s.goals.find((item) => item.id === goalID);
      const rt = s.runtimes.find((item) => item.goalID === goalID);
      if (!goal || !rt)
        return s;
      runID = rt.activeRunID || "unknown";
      failureCount = rt.consecutiveFailures + 1;
      Object.assign(rt, releaseLease(rt));
      rt.activeRunID = undefined;
      rt.consecutiveFailures = failureCount;
      rt.lastError = detail;
      blocked = blockImmediately || failureCount >= (goal.config.maxFailures || 5);
      if (blocked) {
        blockerNeeded = blockImmediately ? "Retry after the OpenCode worker/session API is available." : "Fix the underlying error and use retry_goal to attempt again.";
        goal.status = "blocked";
        goal.blocker = {
          reason: `Worker prompt delivery failed: ${detail}`,
          needed: blockerNeeded,
          at: new Date().toISOString()
        };
      } else {
        const backoffMs = Math.min(30000, 1000 * Math.pow(2, failureCount));
        rt.phase = "waiting_retry";
        rt.retryAfter = new Date(Date.now() + backoffMs).toISOString();
      }
      goal.updatedAt = new Date().toISOString();
      rt.updatedAt = new Date().toISOString();
      return s;
    });
    await appendEvent(directory, {
      version: 1,
      eventID: randomUUID3(),
      goalID,
      type: "run.failed",
      runID,
      error: detail,
      consecutiveFailures: failureCount,
      timestamp: new Date().toISOString(),
      revision: state.revision
    });
    if (blocked) {
      await appendEvent(directory, {
        version: 1,
        eventID: randomUUID3(),
        goalID,
        type: "goal.blocked",
        reason: `Worker prompt delivery failed: ${detail}`,
        needed: blockerNeeded,
        timestamp: new Date().toISOString(),
        revision: state.revision
      });
    }
  }
  async function ensureWorkerSession(directory, goal) {
    let session = sessions.get(goal.id);
    if (session)
      return session;
    if (goal.workerSessionID) {
      session = {
        goalID: goal.id,
        workerSessionID: goal.workerSessionID,
        startedAt: goal.createdAt
      };
      sessions.set(goal.id, session);
      return session;
    }
    session = await workers.createWorker(goal);
    sessions.set(goal.id, session);
    await mutateState(directory, `goal.set-worker:${goal.id}`, async (s) => {
      const persisted = s.goals.find((item) => item.id === goal.id);
      if (persisted)
        persisted.workerSessionID = session.workerSessionID;
      return s;
    });
    return session;
  }
  async function start(directory, input) {
    const id = randomUUID3();
    return withGoalOperation(id, () => startUnlocked(directory, input, id));
  }
  async function startUnlocked(directory, input, id) {
    const goal = createGoal({
      id,
      name: input.name,
      objective: input.objective,
      status: "active",
      ownerSessionID: input.ownerSessionID,
      config: {
        maxTurns: 50,
        workspaceWrite: true,
        ...input.config
      }
    });
    if (typeof input.costBudget === "number")
      goal.costBudget = input.costBudget;
    const artifactDir = goalArtifactDir(directory, id);
    goal.config.artifactDir = artifactDir;
    if (!goal.config.progressFile)
      goal.config.progressFile = path2.join(artifactDir, "progress.md");
    await ensureGoalArtifactDir(directory, id);
    const state1 = await mutateState(directory, `goal.create:${id}`, async (state) => {
      assertWorkspaceWriteAvailable(state, goal);
      state.goals.push(goal);
      const rt = createRuntimeState(id);
      if (goal.config.schedule) {
        rt.scheduleRunCount = 0;
        rt.nextRunAt = undefined;
        rt.lastScheduleAt = undefined;
      }
      state.runtimes.push(rt);
      const runtime2 = state.runtimes.find((r) => r.goalID === id);
      if (runtime2)
        runtime2.phase = "queued";
      return state;
    });
    let runtime = state1.runtimes.find((r) => r.goalID === id);
    let worker;
    try {
      worker = await workers.createWorker(goal);
    } catch (error) {
      const detail = describeError(error);
      const blockedState = await mutateState(directory, `goal.blocked:${id}`, async (state) => {
        const g = state.goals.find((item) => item.id === id);
        if (!g)
          return state;
        g.status = "blocked";
        g.updatedAt = new Date().toISOString();
        g.blocker = {
          reason: detail,
          needed: "Start the goal again from a valid OpenCode session after correcting the worker creation error.",
          at: new Date().toISOString()
        };
        const rt = state.runtimes.find((item) => item.goalID === id);
        if (rt) {
          rt.phase = "idle";
          rt.lastError = detail;
          rt.updatedAt = new Date().toISOString();
        }
        return state;
      });
      await appendEvent(directory, {
        version: 1,
        eventID: randomUUID3(),
        goalID: id,
        type: "goal.blocked",
        reason: detail,
        needed: goal.blocker?.needed || "",
        timestamp: new Date().toISOString(),
        revision: blockedState.revision
      });
      await logServerEvent(directory, "goal.start.failed", { goalID: id, ownerSessionID: input.ownerSessionID, detail });
      throw error;
    }
    sessions.set(id, worker);
    const state2 = await mutateState(directory, `goal.worker-assign:${id}`, async (state) => {
      const g = state.goals.find((item) => item.id === id);
      if (!g)
        return state;
      g.workerSessionID = worker.workerSessionID;
      goal.workerSessionID = worker.workerSessionID;
      const rt = state.runtimes.find((item) => item.goalID === id);
      if (rt) {
        Object.assign(rt, acquireLease(rt, g.config.timeoutMs || 300000));
        rt.activeRunID = randomUUID3();
        rt.activePromptMessageID = `msg-${randomUUID3()}`;
        rt.runCount = 1;
        rt.budgetTurnCount = 1;
        rt.lastRunAt = new Date().toISOString();
      }
      return state;
    });
    runtime = state2.runtimes.find((r) => r.goalID === id);
    await appendEvent(directory, {
      version: 1,
      eventID: randomUUID3(),
      goalID: id,
      type: "goal.created",
      name: input.name,
      objective: input.objective,
      ownerSessionID: input.ownerSessionID,
      timestamp: new Date().toISOString(),
      revision: state2.revision
    });
    if (runtime) {
      await appendEvent(directory, {
        version: 1,
        eventID: randomUUID3(),
        goalID: id,
        type: "run.started",
        runID: runtime.activeRunID,
        turnCount: runtime.runCount,
        timestamp: new Date().toISOString(),
        revision: state2.revision
      });
      try {
        await workers.continueWorker(worker, goal, runtime);
      } catch (error) {
        await recordPromptFailure(directory, id, error, true);
        throw error;
      }
    }
    return { goal, worker };
  }
  async function accountTailUsage(directory, goalID, runtime, tail) {
    const seenIDs = new Set(runtime.accountedMessageIDs ?? []);
    let tokenDelta = 0;
    let costDelta = 0;
    let timeDeltaSeconds = 0;
    const counted = [];
    for (const m of tail) {
      if (m.role !== "assistant" || !m.messageID || !m.completedAt)
        continue;
      if (seenIDs.has(m.messageID))
        continue;
      seenIDs.add(m.messageID);
      counted.push(m.messageID);
      if (m.tokens) {
        tokenDelta += (m.tokens.input || 0) + (m.tokens.output || 0) + (m.tokens.reasoning || 0) + (m.tokens.cacheRead || 0) + (m.tokens.cacheWrite || 0);
      }
      if (typeof m.cost === "number")
        costDelta += m.cost;
      if (typeof m.durationMs === "number")
        timeDeltaSeconds += m.durationMs / 1000;
    }
    if (counted.length === 0)
      return { tokenDelta: 0, costDelta: 0, timeDeltaSeconds: 0, counted };
    const mergedWatermark = [...runtime.accountedMessageIDs ?? [], ...counted].slice(-200);
    await mutateState(directory, `turn.account-usage:${goalID}`, async (s) => {
      const g = s.goals.find((item) => item.id === goalID);
      if (g) {
        g.tokensUsed += tokenDelta;
        g.costUsed = (g.costUsed ?? 0) + costDelta;
        g.timeUsedSeconds += timeDeltaSeconds;
        g.updatedAt = new Date().toISOString();
      }
      const rt = s.runtimes.find((item) => item.goalID === goalID);
      if (rt) {
        rt.turnTokensUsed = (rt.turnTokensUsed ?? 0) + tokenDelta;
        rt.accountedMessageIDs = mergedWatermark;
        rt.updatedAt = new Date().toISOString();
      }
      return s;
    });
    return { tokenDelta, costDelta, timeDeltaSeconds, counted };
  }
  async function accountUsageUnlocked(directory, goalID) {
    const preState = await readState(directory);
    const goal = preState.goals.find((g) => g.id === goalID);
    const runtime = preState.runtimes.find((r) => r.goalID === goalID);
    if (!goal?.workerSessionID || !runtime) {
      return { tokenDelta: 0, costDelta: 0, timeDeltaSeconds: 0, counted: [] };
    }
    let tail = [];
    try {
      tail = await host.readMessages(goal.workerSessionID, 50);
    } catch {
      return { tokenDelta: 0, costDelta: 0, timeDeltaSeconds: 0, counted: [] };
    }
    return accountTailUsage(directory, goalID, runtime, tail);
  }
  async function continueTurnUnlocked(directory, goalID, opts) {
    const preState = await readState(directory);
    const goal = preState.goals.find((g) => g.id === goalID);
    if (!goal || goal.status !== "active")
      return;
    const runtime = preState.runtimes.find((r) => r.goalID === goalID);
    if (!runtime)
      return;
    if (runtime.phase === "running" && leaseIsValid(runtime))
      return;
    let session = sessions.get(goalID);
    if (!session && goal.workerSessionID) {
      session = {
        goalID: goal.id,
        workerSessionID: goal.workerSessionID,
        startedAt: goal.createdAt
      };
      sessions.set(goalID, session);
    }
    if (!session)
      return;
    if (!opts?.force && !await workers.isIdle(session.workerSessionID))
      return;
    let acquired = false;
    const state = await mutateState(directory, `turn.acquire:${goalID}`, async (s) => {
      const g = s.goals.find((item) => item.id === goalID);
      if (!g || g.status !== "active")
        return s;
      const rt = s.runtimes.find((item) => item.goalID === goalID);
      if (!rt)
        return s;
      if (rt.phase === "running" && leaseIsValid(rt))
        return s;
      const timeoutMs = g.config.timeoutMs || 300000;
      Object.assign(rt, acquireLease(rt, timeoutMs));
      rt.activeRunID = randomUUID3();
      rt.activePromptMessageID = `msg-${randomUUID3()}`;
      rt.runCount += 1;
      if (rt.freeRetryPending) {
        rt.freeRetryPending = false;
      } else {
        rt.budgetTurnCount += 1;
      }
      rt.lastRunAt = new Date().toISOString();
      acquired = true;
      return s;
    });
    const freshGoal = state.goals.find((g) => g.id === goalID);
    const freshRuntime = state.runtimes.find((r) => r.goalID === goalID);
    if (!acquired || !freshGoal || freshGoal.status !== "active" || !freshRuntime?.activeRunID)
      return;
    await appendEvent(directory, {
      version: 1,
      eventID: randomUUID3(),
      goalID,
      type: "run.started",
      runID: freshRuntime.activeRunID,
      turnCount: freshRuntime.runCount,
      timestamp: new Date().toISOString(),
      revision: state.revision
    });
    if (opts?.bare) {
      const bareWords = await drainGoalInbox(directory, goalID);
      const bareText = bareWords.join(`
`).trim();
      if (bareText) {
        try {
          await workers.sendBare(session, freshGoal, freshRuntime, bareText);
        } catch (error) {
          await recordPromptFailure(directory, goalID, error);
          throw error;
        }
        return;
      }
    }
    const inboxMessages = await drainGoalInbox(directory, goalID);
    const allEvents = await readEvents(directory, 200);
    const progressHistory = allEvents.filter((e) => e.goalID === goalID && e.type === "goal.progress").map((e) => ({
      summary: String(e.summary || ""),
      next: e.next ? String(e.next) : undefined,
      at: String(e.timestamp || "")
    }));
    let transcriptTail;
    try {
      transcriptTail = await host.readMessages(freshGoal.workerSessionID, 5);
    } catch {
      transcriptTail = [];
    }
    await accountTailUsage(directory, goalID, freshRuntime, transcriptTail ?? []);
    let verification;
    try {
      const artifactDir = freshGoal.config.artifactDir;
      if (artifactDir) {
        try {
          const files = await fs2.readdir(artifactDir);
          verification = { artifactSummary: files.length ? `${files.length} file(s): ${files.slice(0, 8).join(", ")}` : "no artifacts yet" };
        } catch {
          verification = { artifactSummary: "no artifacts yet" };
        }
      }
      if (freshGoal.config.checks?.length) {
        const c = `checks configured: ${freshGoal.config.checks.length} \u2014 run them before claiming completion`;
        verification = { ...verification || {}, failedChecks: [c], checksPassed: undefined };
      }
      if (freshRuntime.evaluatorRejectionCount && freshRuntime.evaluatorRejectionCount > 0) {
        verification = { ...verification || {}, evaluatorRejectionCount: freshRuntime.evaluatorRejectionCount };
      }
      if (freshRuntime.lastRejectionDetails) {
        verification = { ...verification || {}, lastRejectionDetails: freshRuntime.lastRejectionDetails };
      }
    } catch {}
    const context = {
      inboxMessages: inboxMessages.length > 0 ? inboxMessages : undefined,
      progressHistory: progressHistory.length > 0 ? progressHistory : undefined,
      transcriptTail: transcriptTail && transcriptTail.length > 0 ? transcriptTail : undefined,
      forceFinish: opts?.forceFinish || undefined,
      verification
    };
    try {
      await workers.continueWorker(session, freshGoal, freshRuntime, context);
    } catch (error) {
      await recordPromptFailure(directory, goalID, error);
      throw error;
    }
  }
  async function pauseUnlocked(directory, goalID) {
    const preState = await readState(directory);
    const goal = preState.goals.find((g) => g.id === goalID);
    if (!goal)
      return;
    if (!canTransition(goal.status, "paused", "user"))
      return;
    const state = await mutateState(directory, `goal.pause:${goalID}`, async (s) => {
      const g = s.goals.find((item) => item.id === goalID);
      if (!g)
        return s;
      g.status = "paused";
      g.updatedAt = new Date().toISOString();
      const rt = s.runtimes.find((r) => r.goalID === goalID);
      if (rt)
        Object.assign(rt, releaseLease(rt));
      return s;
    });
    const session = sessions.get(goalID) || (goal.workerSessionID ? {
      goalID: goal.id,
      workerSessionID: goal.workerSessionID,
      startedAt: goal.createdAt
    } : undefined);
    if (session) {
      await workers.abortWorker(session.workerSessionID);
      sessions.delete(goalID);
    }
    await appendEvent(directory, {
      version: 1,
      eventID: randomUUID3(),
      goalID,
      type: "goal.status_changed",
      from: "active",
      to: "paused",
      timestamp: new Date().toISOString(),
      revision: state.revision
    });
  }
  async function resumeUnlocked(directory, goalID) {
    let resumed = false;
    const state = await mutateState(directory, `goal.resume:${goalID}`, async (state2) => {
      const goal2 = state2.goals.find((g) => g.id === goalID);
      if (!goal2)
        return state2;
      if (!canTransition(goal2.status, "active", "user"))
        return state2;
      assertWorkspaceWriteAvailable(state2, goal2);
      goal2.status = "active";
      goal2.updatedAt = new Date().toISOString();
      resumed = true;
      return state2;
    });
    const goal = state.goals.find((g) => g.id === goalID);
    if (!goal || !resumed)
      return;
    try {
      await ensureWorkerSession(directory, goal);
    } catch (error) {
      await mutateState(directory, `goal.resume-rollback:${goalID}`, async (s) => {
        const g = s.goals.find((item) => item.id === goalID);
        if (g?.status === "active")
          g.status = "paused";
        return s;
      });
      throw error;
    }
    await appendEvent(directory, {
      version: 1,
      eventID: randomUUID3(),
      goalID,
      type: "goal.status_changed",
      from: "paused",
      to: "active",
      timestamp: new Date().toISOString(),
      revision: state.revision
    });
    await continueTurnUnlocked(directory, goalID);
  }
  async function retryUnlocked(directory, goalID) {
    let retried = false;
    const state = await mutateState(directory, `goal.retry:${goalID}`, async (state2) => {
      const goal2 = state2.goals.find((g) => g.id === goalID);
      if (!goal2 || goal2.status !== "blocked")
        return state2;
      assertWorkspaceWriteAvailable(state2, goal2);
      goal2.status = "active";
      goal2.updatedAt = new Date().toISOString();
      retried = true;
      const runtime = state2.runtimes.find((r) => r.goalID === goalID);
      if (runtime) {
        runtime.consecutiveFailures = 0;
        runtime.lastError = undefined;
        runtime.forceFinishRequested = undefined;
        runtime.lastParentNotifiedAt = undefined;
        runtime.lastParentNotifiedFor = undefined;
        runtime.phase = "idle";
        runtime.updatedAt = new Date().toISOString();
      }
      return state2;
    });
    const goal = state.goals.find((g) => g.id === goalID);
    if (!goal || !retried)
      return;
    try {
      await ensureWorkerSession(directory, goal);
    } catch (error) {
      await mutateState(directory, `goal.retry-rollback:${goalID}`, async (s) => {
        const g = s.goals.find((item) => item.id === goalID);
        if (g?.status === "active")
          g.status = "blocked";
        return s;
      });
      throw error;
    }
    await appendEvent(directory, {
      version: 1,
      eventID: randomUUID3(),
      goalID,
      type: "goal.status_changed",
      from: "blocked",
      to: "active",
      timestamp: new Date().toISOString(),
      revision: state.revision
    });
    await continueTurnUnlocked(directory, goalID);
  }
  async function clearUnlocked(directory, goalID) {
    const state = await readState(directory);
    const goal = state.goals.find((g) => g.id === goalID);
    if (!goal)
      return;
    const session = sessions.get(goalID) || (goal.workerSessionID ? {
      goalID: goal.id,
      workerSessionID: goal.workerSessionID,
      startedAt: goal.createdAt
    } : undefined);
    if (session) {
      await workers.abortWorker(session.workerSessionID);
      sessions.delete(goalID);
    }
    await mutateState(directory, `goal.clear:${goalID}`, async (s) => {
      s.goals = s.goals.filter((g) => g.id !== goalID);
      s.runtimes = s.runtimes.filter((r) => r.goalID !== goalID);
      return s;
    });
    await appendEvent(directory, {
      version: 1,
      eventID: randomUUID3(),
      goalID,
      type: "goal.cleared",
      timestamp: new Date().toISOString(),
      revision: state.revision
    });
  }
  function getWorker(goalID) {
    return sessions.get(goalID);
  }
  function getActiveWorkers() {
    return new Map(sessions);
  }
  async function reconcile(directory) {
    const state = await readState(directory);
    for (const goal of state.goals) {
      if (isTerminal(goal.status))
        continue;
      if (goal.status === "paused")
        continue;
      if (!goal.workerSessionID) {
        let worker;
        try {
          worker = await workers.createWorker(goal);
          sessions.set(goal.id, worker);
        } catch (error) {
          const detail = describeError(error);
          await mutateState(directory, `reconcile.block:${goal.id}`, async (s) => {
            const g = s.goals.find((item) => item.id === goal.id);
            if (!g)
              return s;
            g.status = "blocked";
            g.updatedAt = new Date().toISOString();
            g.blocker = {
              reason: detail,
              needed: "Clear this goal and start it again from a valid OpenCode session.",
              at: new Date().toISOString()
            };
            const rt = s.runtimes.find((item) => item.goalID === goal.id);
            if (rt) {
              rt.phase = "idle";
              rt.lastError = detail;
              rt.updatedAt = new Date().toISOString();
            }
            return s;
          });
          await logServerEvent(directory, "goal.reconcile.failed", { goalID: goal.id, ownerSessionID: goal.ownerSessionID, detail });
          continue;
        }
        await mutateState(directory, `reconcile.set-worker:${goal.id}`, async (s) => {
          const g = s.goals.find((item) => item.id === goal.id);
          if (g) {
            g.workerSessionID = worker.workerSessionID;
            g.updatedAt = new Date().toISOString();
          }
          return s;
        });
      }
      if (goal.workerSessionID && !sessions.has(goal.id)) {
        sessions.set(goal.id, {
          goalID: goal.id,
          workerSessionID: goal.workerSessionID,
          startedAt: goal.createdAt
        });
      }
      const preRt = state.runtimes.find((r) => r.goalID === goal.id);
      if (preRt?.phase === "running" && !leaseIsValid(preRt)) {
        const session = sessions.get(goal.id);
        if (session && await workers.isIdle(session.workerSessionID)) {
          await mutateState(directory, `reconcile.release-lease:${goal.id}`, async (s) => {
            const rt = s.runtimes.find((r) => r.goalID === goal.id);
            if (rt) {
              Object.assign(rt, releaseLease(rt));
              const g = s.goals.find((item) => item.id === goal.id);
              if (g)
                g.updatedAt = new Date().toISOString();
            }
            return s;
          });
        }
      }
    }
  }
  async function nudgeUnlocked(directory, goalID) {
    const preState = await readState(directory);
    const goal = preState.goals.find((g) => g.id === goalID);
    if (!goal)
      return { ok: false, message: "Goal not found." };
    if (goal.status !== "active") {
      return { ok: false, message: `Goal is ${goal.status}; resume or retry it before nudging.` };
    }
    const cleared = await mutateState(directory, `goal.nudge:${goalID}`, async (s) => {
      const rt = s.runtimes.find((r) => r.goalID === goalID);
      if (!rt)
        return s;
      rt.phase = "idle";
      rt.activeRunID = undefined;
      rt.idleCandidateAt = undefined;
      rt.activePromptMessageID = undefined;
      rt.activeToolCallIDs = [];
      rt.updatedAt = new Date().toISOString();
      return s;
    });
    const freshGoal = cleared.goals.find((g) => g.id === goalID);
    if (!freshGoal || !freshGoal.workerSessionID) {
      return { ok: false, message: "Goal has no worker session. Use resume_goal or retry_goal." };
    }
    await continueTurnUnlocked(directory, goalID, { force: true });
    return { ok: true, message: `Re-prompted worker for "${freshGoal.name}".` };
  }
  async function sendUnlocked(directory, goalID, text) {
    const trimmed = text.trim();
    if (!trimmed)
      return { ok: false, message: "Nothing to send." };
    const preState = await readState(directory);
    const goal = preState.goals.find((g) => g.id === goalID);
    if (!goal)
      return { ok: false, message: "Goal not found." };
    await appendGoalInbox(directory, goalID, "user", trimmed);
    if (goal.status !== "active") {
      return { ok: true, message: `Queued for "${goal.name}" (goal is ${goal.status}; delivers on the next active turn).` };
    }
    const cleared = await mutateState(directory, `goal.send:${goalID}`, async (s) => {
      const rt = s.runtimes.find((r) => r.goalID === goalID);
      if (!rt)
        return s;
      rt.phase = "idle";
      rt.activeRunID = undefined;
      rt.idleCandidateAt = undefined;
      rt.activePromptMessageID = undefined;
      rt.activeToolCallIDs = [];
      rt.updatedAt = new Date().toISOString();
      return s;
    });
    const freshGoal = cleared.goals.find((g) => g.id === goalID);
    if (!freshGoal || !freshGoal.workerSessionID) {
      return { ok: true, message: `Queued for "${goal.name}" (no worker session yet; delivers on the next turn).` };
    }
    await continueTurnUnlocked(directory, goalID, { force: true, bare: true });
    return { ok: true, message: `Sent to "${freshGoal.name}" as its own turn.` };
  }
  function sendUserMessage(directory, goalID, text) {
    return withGoalOperation(goalID, () => sendUnlocked(directory, goalID, text));
  }
  function continueTurn(directory, goalID, opts) {
    return withGoalOperation(goalID, () => continueTurnUnlocked(directory, goalID, opts));
  }
  function pause(directory, goalID) {
    return withGoalOperation(goalID, () => pauseUnlocked(directory, goalID));
  }
  function resume(directory, goalID) {
    return withGoalOperation(goalID, () => resumeUnlocked(directory, goalID));
  }
  function retry(directory, goalID) {
    return withGoalOperation(goalID, () => retryUnlocked(directory, goalID));
  }
  function clear(directory, goalID) {
    return withGoalOperation(goalID, () => clearUnlocked(directory, goalID));
  }
  function nudge(directory, goalID) {
    return withGoalOperation(goalID, () => nudgeUnlocked(directory, goalID));
  }
  async function abortWorkerUnlocked(directory, goalID) {
    const preState = await readState(directory);
    const goal = preState.goals.find((g) => g.id === goalID);
    if (!goal)
      return { ok: false, message: "Goal not found." };
    const workerID = sessions.get(goalID)?.workerSessionID || goal.workerSessionID;
    if (!workerID)
      return { ok: false, message: `Goal "${goal.name}" has no worker session to abort.` };
    try {
      await workers.abortWorker(workerID);
    } catch {}
    sessions.delete(goalID);
    await mutateState(directory, `goal.abort-worker:${goalID}`, async (s) => {
      const rt = s.runtimes.find((r) => r.goalID === goalID);
      if (rt) {
        Object.assign(rt, releaseLease(rt));
        rt.activeRunID = undefined;
        rt.activePromptMessageID = undefined;
        rt.activeToolCallIDs = [];
        rt.idleCandidateAt = undefined;
        rt.idleCandidateGeneration = undefined;
        rt.workerAbortedAt = new Date().toISOString();
        rt.updatedAt = new Date().toISOString();
      }
      const g = s.goals.find((item) => item.id === goalID);
      if (g)
        g.updatedAt = new Date().toISOString();
      return s;
    });
    await logServerEvent(directory, "worker.aborted-manual", { goalID, workerSessionID: workerID });
    return {
      ok: true,
      message: `Worker run for "${goal.name}" aborted, session kept for inspection (status unchanged: ${goal.status}).` + (goal.status === "active" ? " Engine continues the same session next turn." : "")
    };
  }
  function abortWorker(directory, goalID) {
    return withGoalOperation(goalID, () => abortWorkerUnlocked(directory, goalID));
  }
  function accountUsage(directory, goalID) {
    return withGoalOperation(goalID, () => accountUsageUnlocked(directory, goalID));
  }
  return { start, continueTurn, nudge, pause, resume, retry, clear, getWorker, getActiveWorkers, reconcile, accountUsage, abortWorker, sendUserMessage };
}

// src/application/schedule-worker.ts
import { randomUUID as randomUUID4 } from "crypto";
function createScheduleWorker(options) {
  const { directory, goalService } = options;
  const intervalMs = options.intervalMs ?? 5000;
  let running = false;
  let timer;
  function start() {
    if (running)
      return;
    running = true;
    timer = setInterval(() => {
      tick().catch(() => {});
    }, intervalMs);
  }
  function stop() {
    running = false;
    if (timer)
      clearInterval(timer);
    timer = undefined;
  }
  function isRunning() {
    return running;
  }
  async function tick() {
    const state = await readState(directory);
    let resurrected = 0;
    for (const goal of state.goals) {
      const schedule = goal.config.schedule;
      if (!schedule || typeof schedule.everyMs !== "number" || schedule.everyMs < 1000)
        continue;
      const runtime = state.runtimes.find((r) => r.goalID === goal.id);
      if (!runtime)
        continue;
      if (goal.status !== "complete")
        continue;
      const count = runtime.scheduleRunCount ?? 0;
      const max = schedule.maxRuns;
      if (typeof max === "number" && count >= max)
        continue;
      const nextAt = runtime.nextRunAt;
      if (!nextAt)
        continue;
      if (Date.now() < Date.parse(nextAt))
        continue;
      const activeWriter = state.goals.find((g) => g.id !== goal.id && g.status === "active" && g.config.workspaceWrite);
      if (goal.config.workspaceWrite && activeWriter) {
        await logServerEvent(directory, "schedule.skipped-writer-active", {
          goalID: goal.id,
          activeWriter: activeWriter.id
        });
        continue;
      }
      if (runtime.phase === "running" || runtime.phase === "queued" || runtime.phase === "compacting")
        continue;
      if (leaseIsValid(runtime))
        continue;
      const didResurrect = await mutateState(directory, `schedule.tick:${goal.id}`, async (s) => {
        const g = s.goals.find((x) => x.id === goal.id);
        const rt = s.runtimes.find((x) => x.goalID === goal.id);
        if (!g || !rt)
          return s;
        if (g.status !== "complete")
          return s;
        const curCount = rt.scheduleRunCount ?? 0;
        if (typeof max === "number" && curCount >= max)
          return s;
        const curNext = rt.nextRunAt;
        if (!curNext || Date.now() < Date.parse(curNext))
          return s;
        g.status = "active";
        g.updatedAt = new Date().toISOString();
        g.blocker = undefined;
        Object.assign(rt, releaseLease(rt));
        rt.activeRunID = undefined;
        rt.consecutiveFailures = 0;
        rt.noProgressCount = 0;
        rt.progressDuringTurn = false;
        rt.forceFinishRequested = undefined;
        rt.lastError = undefined;
        rt.lastScheduleAt = new Date().toISOString();
        rt.updatedAt = new Date().toISOString();
        return s;
      });
      const after = didResurrect.goals.find((g) => g.id === goal.id);
      if (!after || after.status !== "active")
        continue;
      await appendEvent(directory, {
        version: 1,
        eventID: randomUUID4(),
        goalID: goal.id,
        type: "schedule.tick",
        scheduleRunCount: count,
        nextRunAt: nextAt,
        timestamp: new Date().toISOString(),
        revision: didResurrect.revision
      });
      await logServerEvent(directory, "schedule.resurrected", {
        goalID: goal.id,
        scheduleRunCount: count,
        nextRunAt: nextAt
      });
      const maxLabel = typeof max === "number" ? `/${max}` : "";
      await appendGoalInbox(directory, goal.id, "user", `Scheduled tick ${count + 1}${maxLabel} \u2014 re-execute the objective now. Previous completion: ${runtime.scheduleRunCount ?? 0} runs. Ensure artifact checks pass for this tick (e.g., append timestamp to tick.txt).`);
      try {
        await goalService.continueTurn(directory, goal.id);
        resurrected++;
      } catch {}
    }
    return resurrected;
  }
  return { start, stop, isRunning, tick };
}

// src/server/goal-tools.ts
import { randomUUID as randomUUID5 } from "crypto";
import { tool } from "@opencode-ai/plugin/tool";
// src/domain/verification.ts
var MAX_RECENT_ATTEMPTS = 10;
function appendVerificationAttempt(recent, attempt) {
  const next = [...recent, attempt];
  if (next.length > MAX_RECENT_ATTEMPTS) {
    return next.slice(next.length - MAX_RECENT_ATTEMPTS);
  }
  return next;
}

// src/server/goal-tools.ts
import { exec as execChild } from "child_process";
import { promisify } from "util";
var execAsync = promisify(execChild);
function goalTools(dir, goalService, hostSessionID, defaults = {}) {
  return {
    loopd_create_goal: tool({
      description: "Create a new background loop goal (contract: objective + checks + agent/model + workspaceWrite). " + "The engine spawns a dedicated worker session that does the work autonomously \u2014 it never runs in this chat. " + "Call this after clarifying the contract with the user. " + "Worker identity is free-form: agent is any OpenCode agent name (built-in, ~/.config/opencode/agents/*.md, or opencode.jsonc agent.* \u2014 discover with `opencode agent list`), " + 'model is any "providerID/modelID" (discover with `opencode models [provider]`). Both are sent on every worker prompt. ' + "Host is the acceptance authority: checks must pass for complete_goal (free retry if rejected <3, blocked after 3). " + "Workspace-writing goals are serialized (only one active writer) and require checks. " + "agent/model are optional \u2014 fall back to the parent session's agent/model, or plugin defaultAgent/defaultModel in opencode.jsonc.",
      args: {
        name: tool.schema.string().describe("Short goal name (used in the dashboard)."),
        objective: tool.schema.string().describe("What the goal should accomplish, in detail."),
        agent: tool.schema.string().optional().describe(`Agent to run the worker as (e.g. "researcher", "smart-agent"). Optional \u2014 uses parent session's agent if omitted, or plugin defaultAgent.`),
        model: tool.schema.string().optional().describe(`Model to run the worker as, as "providerID/modelID" (e.g. "openai/gpt-5.6-sol", "ollama/qwen3.8:27b"). Optional \u2014 uses parent session's model if omitted, or plugin defaultModel.`),
        costBudget: tool.schema.number().optional().describe("Max provider cost in dollars before the engine stops the goal as budget_limited (e.g. 0.5). Optional \u2014 unlimited if omitted."),
        checks: tool.schema.array(tool.schema.string()).optional().describe('Shell commands that must pass for completion to be accepted. E.g. ["npm test"].'),
        checkCwd: tool.schema.string().optional().describe("Directory where completion checks run. Workspace-writing goals default to the project root."),
        workspaceWrite: tool.schema.boolean().optional().describe("Whether this goal edits the shared project workspace. Defaults to true; explicitly set false for artifact-only/read-only work."),
        progressFile: tool.schema.string().optional().describe("Markdown file the worker reads/writes as its transaction state."),
        maxTurns: tool.schema.number().optional().describe("Max turns before auto-block."),
        maxNoProgress: tool.schema.number().optional().describe("Block after N turns without progress."),
        maxFailures: tool.schema.number().optional().describe("Block after N consecutive failures."),
        compactEvery: tool.schema.number().optional().describe("Compact the worker session every N turns."),
        timeoutMs: tool.schema.number().optional().describe("Per-turn timeout in ms."),
        scheduleEveryMs: tool.schema.number().optional().describe("Interval in ms to auto-requeue the same goal after each completion. Minimum 1000. Enables repetitive dialogue reduction."),
        scheduleMaxRuns: tool.schema.number().optional().describe("Maximum total runs including the initial run. Undefined = unlimited. Requires scheduleEveryMs.")
      },
      execute: async (args, context) => {
        const sessionID = context?.sessionID || hostSessionID;
        if (!sessionID || sessionID === "main") {
          return {
            title: "Goal not created",
            output: JSON.stringify({
              ok: false,
              message: "A valid owner session is required. Run /goal from an active OpenCode session."
            })
          };
        }
        const config = {
          maxTurns: 50
        };
        if (args.agent)
          config.agent = args.agent;
        if (args.model)
          config.model = args.model;
        if (args.checks)
          config.checks = args.checks;
        if (args.checkCwd)
          config.checkCwd = args.checkCwd;
        if (args.workspaceWrite !== undefined)
          config.workspaceWrite = args.workspaceWrite;
        if (args.progressFile)
          config.progressFile = args.progressFile;
        if (args.maxTurns !== undefined)
          config.maxTurns = args.maxTurns;
        if (args.maxNoProgress !== undefined)
          config.maxNoProgress = args.maxNoProgress;
        if (args.maxFailures !== undefined)
          config.maxFailures = args.maxFailures;
        if (args.compactEvery !== undefined)
          config.compactEvery = args.compactEvery;
        if (args.timeoutMs !== undefined)
          config.timeoutMs = args.timeoutMs;
        if (args.scheduleEveryMs !== undefined) {
          const everyMs = args.scheduleEveryMs;
          if (typeof everyMs !== "number" || !Number.isFinite(everyMs) || everyMs < 1000) {
            return {
              title: "Goal not created",
              output: JSON.stringify({ ok: false, message: "scheduleEveryMs must be a number >= 1000", errorCode: "invalid_schedule" })
            };
          }
          const maxRuns = args.scheduleMaxRuns;
          if (maxRuns !== undefined && (typeof maxRuns !== "number" || !Number.isFinite(maxRuns) || maxRuns < 1 || Math.floor(maxRuns) !== maxRuns)) {
            return {
              title: "Goal not created",
              output: JSON.stringify({ ok: false, message: "scheduleMaxRuns must be an integer >= 1", errorCode: "invalid_schedule" })
            };
          }
          config.schedule = { everyMs, ...maxRuns !== undefined ? { maxRuns } : {} };
        } else if (args.scheduleMaxRuns !== undefined) {
          return {
            title: "Goal not created",
            output: JSON.stringify({ ok: false, message: "scheduleMaxRuns requires scheduleEveryMs", errorCode: "invalid_schedule" })
          };
        }
        let costBudget;
        if (args.costBudget !== undefined) {
          if (typeof args.costBudget !== "number" || !Number.isFinite(args.costBudget) || args.costBudget <= 0) {
            return {
              title: "Goal not created",
              output: JSON.stringify({ ok: false, message: "costBudget must be a positive number of dollars", errorCode: "invalid_cost_budget" })
            };
          }
          costBudget = args.costBudget;
        }
        const resolution = resolveGoalCreationConfig({
          directory: dir,
          objective: args.objective,
          config,
          defaults
        });
        if (!resolution.ok) {
          return {
            title: "Goal not created",
            output: JSON.stringify({
              ok: false,
              message: resolution.message,
              errorCode: resolution.errorCode
            })
          };
        }
        try {
          const { goal, worker } = await goalService.start(dir, {
            name: args.name,
            objective: args.objective,
            ownerSessionID: sessionID,
            config: resolution.config,
            costBudget
          });
          return {
            title: "Goal created",
            output: JSON.stringify({
              ok: true,
              goalID: goal.id,
              workerSessionID: worker.workerSessionID,
              artifactDir: goal.config.artifactDir,
              agent: resolution.config.agent,
              model: resolution.config.model,
              costBudget: goal.costBudget,
              checks: resolution.config.checks || [],
              workspaceWrite: resolution.config.workspaceWrite,
              defaultsApplied: resolution.defaultsApplied,
              name: args.name,
              message: `Goal "${args.name}" created and started in the background. Artifacts: ${goal.config.artifactDir}. Monitor with /loop (<leader>o).`
            })
          };
        } catch (error) {
          return {
            title: "Goal creation failed",
            output: JSON.stringify({
              ok: false,
              name: args.name,
              message: error instanceof Error ? error.message : String(error),
              diagnostics: SERVER_LOG_FILE
            })
          };
        }
      }
    }),
    get_goal: tool({
      description: "Get the current goal contract and state. Call at the start of every turn to retrieve the objective, checks, limits, and recent failures (including HOST VERDICT if the last completion was rejected). Returns structured JSON with config and runtime (phase, runGeneration, rejectionCount).",
      args: {},
      execute: async (_args, context) => {
        const state = await readState(dir);
        const workerID = context?.sessionID || hostSessionID;
        const goal = findGoalByWorkerSession(state, workerID);
        if (!goal) {
          return {
            title: "No active goal",
            output: JSON.stringify({
              status: "none",
              message: "No active goal found for this worker session."
            })
          };
        }
        const runtime = state.runtimes.find((r) => r.goalID === goal.id);
        return {
          title: `Goal: ${goal.name}`,
          output: formatGoalStructured(goal, runtime)
        };
      }
    }),
    report_goal_progress: tool({
      description: "Report meaningful progress (resets consecutiveFailures/noProgressCount). Call after durable state changes (file writes, verifications) \u2014 not after thinking. The engine uses this to avoid force-finish.",
      args: {
        summary: tool.schema.string().describe("What was accomplished."),
        next: tool.schema.string().describe("The next concrete step."),
        evidence: tool.schema.string().describe("Optional concrete evidence.")
      },
      execute: async (args, context) => {
        const state = await readState(dir);
        const workerID = context?.sessionID || hostSessionID;
        const goal = findGoalByWorkerSession(state, workerID);
        if (!goal) {
          return { title: "No goal", output: "No active goal to report progress for." };
        }
        if (goal.status !== "active") {
          return { title: "Invalid state", output: `Goal is ${goal.status}, not active. Cannot report progress.` };
        }
        const runtime = state.runtimes.find((r) => r.goalID === goal.id);
        if (runtime) {
          Object.assign(runtime, markProgress(runtime));
          runtime.noProgressCount = 0;
          runtime.consecutiveFailures = 0;
        }
        goal.lastProgress = {
          summary: args.summary,
          next: args.next,
          at: new Date().toISOString()
        };
        await writeState(dir, state);
        const event = {
          version: 1,
          eventID: randomUUID5(),
          goalID: goal.id,
          type: "goal.progress",
          summary: args.summary,
          next: args.next,
          timestamp: new Date().toISOString(),
          revision: state.revision
        };
        await appendEvent(dir, event);
        return {
          title: "Progress recorded",
          output: JSON.stringify({
            goalName: goal.name,
            summary: args.summary,
            next: args.next,
            turn: runtime?.runCount
          })
        };
      }
    }),
    complete_goal: tool({
      description: "Propose completion. Host runs checks from checkCwd (writers default to project root) \u2014 if any fail, host rejects (rejectionCount++, freeRetryPending if <3, blocked after 3 with HOST VERDICT). Only call when every requirement is proved with evidence; the host decides, not the model.",
      args: {
        summary: tool.schema.string().describe("What was completed."),
        evidence: tool.schema.string().describe("Concrete evidence of completion.")
      },
      execute: async (args, context) => {
        const state = await readState(dir);
        const workerID = context?.sessionID || hostSessionID;
        const goal = findGoalByWorkerSession(state, workerID);
        if (!goal) {
          return { title: "No goal", output: "No active goal to complete." };
        }
        if (!canTransition(goal.status, "complete", "model")) {
          return { title: "Invalid transition", output: `Cannot complete goal in ${goal.status} state.` };
        }
        if (goal.config.checks?.length) {
          const cwd = goal.config.checkCwd || goal.config.artifactDir || dir;
          const checkResults = await runCompletionChecks(goal.config.checks, cwd);
          if (!checkResults.passed) {
            const runtime2 = state.runtimes.find((r) => r.goalID === goal.id);
            if (runtime2) {
              runtime2.evaluatorRejectionCount = (runtime2.evaluatorRejectionCount || 0) + 1;
              const failureDetails = checkResults.failures.map((f) => {
                const stdoutSnippet = f.stdout ? `
Stdout: ${f.stdout.slice(0, 500)}` : "";
                const stderrSnippet = f.stderr ? `
Stderr: ${f.stderr.slice(0, 500)}` : "";
                return `Command: ${f.command}
Exit code: ${f.exitCode}${stdoutSnippet}${stderrSnippet}`;
              }).join(`

`);
              runtime2.lastRejectionDetails = `Rejection #${runtime2.evaluatorRejectionCount} at ${new Date().toISOString()}

Working directory: ${cwd}

${failureDetails}`;
              const attemptID = randomUUID5();
              const verificationAttempt = {
                id: attemptID,
                sequence: runtime2.evaluatorRejectionCount,
                runGeneration: runtime2.runGeneration,
                claimedSummary: args.summary,
                claimedEvidence: args.evidence,
                startedAt: new Date().toISOString(),
                completedAt: new Date().toISOString(),
                status: "failed",
                cwd,
                checks: checkResults.failures.map((f) => ({
                  command: f.command,
                  exitCode: f.exitCode,
                  stderr: f.stderr,
                  stdout: f.stdout
                }))
              };
              runtime2.lastVerificationAttempt = verificationAttempt;
              runtime2.recentVerificationAttempts = appendVerificationAttempt(runtime2.recentVerificationAttempts || [], verificationAttempt);
              const rejectEvent = {
                version: 1,
                eventID: randomUUID5(),
                goalID: goal.id,
                type: "goal.completion_rejected",
                attemptID,
                rejectionCount: runtime2.evaluatorRejectionCount,
                failedCheckCount: checkResults.failures.length,
                failureSummary: failureDetails.slice(0, 500),
                timestamp: new Date().toISOString(),
                revision: state.revision
              };
              await appendEvent(dir, rejectEvent);
              const maxRejections = goal.config.maxEvaluatorRejections || 3;
              if (runtime2.evaluatorRejectionCount >= maxRejections) {
                goal.status = "blocked";
                goal.updatedAt = new Date().toISOString();
                goal.blocker = {
                  reason: `Evaluator rejected ${runtime2.evaluatorRejectionCount} time(s). Last failure:
${failureDetails.slice(0, 500)}`,
                  needed: "Fix the failing checks and retry the goal.",
                  at: new Date().toISOString()
                };
                runtime2.forceFinishRequested = undefined;
                await appendEvent(dir, {
                  version: 1,
                  eventID: randomUUID5(),
                  goalID: goal.id,
                  type: "goal.blocked",
                  reason: goal.blocker.reason,
                  needed: goal.blocker.needed,
                  timestamp: new Date().toISOString(),
                  revision: state.revision
                });
              } else {
                runtime2.forceFinishRequested = false;
                runtime2.freeRetryPending = true;
              }
              runtime2.updatedAt = new Date().toISOString();
              await writeState(dir, state);
            }
            return {
              title: "Completion rejected \u2014 keep working",
              output: JSON.stringify({
                passed: false,
                failedChecks: checkResults.failures,
                message: "Evaluator rejected completion. Fix the issues above and try again.",
                rejectionCount: runtime2?.evaluatorRejectionCount || 0,
                status: goal.status
              })
            };
          }
        }
        goal.status = "complete";
        goal.updatedAt = new Date().toISOString();
        goal.completionEvidence = {
          summary: args.summary,
          evidence: args.evidence,
          at: new Date().toISOString()
        };
        const finalUsage = await goalService.accountUsage(dir, goal.id);
        goal.tokensUsed += finalUsage.tokenDelta;
        goal.costUsed = (goal.costUsed ?? 0) + finalUsage.costDelta;
        goal.timeUsedSeconds += finalUsage.timeDeltaSeconds;
        const runtime = state.runtimes.find((r) => r.goalID === goal.id);
        if (runtime) {
          Object.assign(runtime, releaseLease(runtime));
          runtime.activeRunID = undefined;
          runtime.lastError = undefined;
          runtime.turnTokensUsed = (runtime.turnTokensUsed ?? 0) + finalUsage.tokenDelta;
          runtime.accountedMessageIDs = [...runtime.accountedMessageIDs ?? [], ...finalUsage.counted].slice(-200);
          runtime.updatedAt = new Date().toISOString();
          const schedule = goal.config.schedule;
          if (schedule && typeof schedule.everyMs === "number" && schedule.everyMs >= 1000) {
            const cur = typeof runtime.scheduleRunCount === "number" ? runtime.scheduleRunCount : 0;
            const nextCount = cur + 1;
            runtime.scheduleRunCount = nextCount;
            const max = schedule.maxRuns;
            const hasMore = typeof max === "number" ? nextCount < max : true;
            if (hasMore) {
              runtime.nextRunAt = new Date(Date.now() + schedule.everyMs).toISOString();
              runtime.lastScheduleAt = new Date().toISOString();
            } else {
              runtime.nextRunAt = undefined;
            }
            runtime.updatedAt = new Date().toISOString();
          }
          const attemptID = randomUUID5();
          const cwd = goal.config.checkCwd || goal.config.artifactDir || dir;
          const checks = (goal.config.checks || []).map((cmd) => ({
            command: cmd,
            exitCode: 0
          }));
          const verificationAttempt = {
            id: attemptID,
            sequence: (runtime.evaluatorRejectionCount || 0) + 1,
            runGeneration: runtime.runGeneration,
            claimedSummary: args.summary,
            claimedEvidence: args.evidence,
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            status: "passed",
            cwd,
            checks
          };
          runtime.lastVerificationAttempt = verificationAttempt;
          runtime.recentVerificationAttempts = appendVerificationAttempt(runtime.recentVerificationAttempts || [], verificationAttempt);
        }
        await writeState(dir, state);
        const event = {
          version: 1,
          eventID: randomUUID5(),
          goalID: goal.id,
          type: "goal.completed",
          summary: args.summary,
          evidence: args.evidence,
          timestamp: new Date().toISOString(),
          revision: state.revision
        };
        await appendEvent(dir, event);
        return {
          title: "Goal completed",
          output: JSON.stringify({
            goalID: goal.id,
            goalName: goal.name,
            status: "complete",
            summary: args.summary,
            evidence: args.evidence
          })
        };
      }
    }),
    block_goal: tool({
      description: "Mark blocked for a real external blocker (missing creds, contradictory objective vs checks). Use only when you cannot proceed \u2014 the engine will not auto-continue blocked goals until resume/retry.",
      args: {
        reason: tool.schema.string().describe("Why the goal is blocked."),
        needed: tool.schema.string().describe("What is needed to unblock.")
      },
      execute: async (args, context) => {
        const state = await readState(dir);
        const workerID = context?.sessionID || hostSessionID;
        const goal = findGoalByWorkerSession(state, workerID);
        if (!goal) {
          return { title: "No goal", output: "No active goal to block." };
        }
        if (!canTransition(goal.status, "blocked", "model")) {
          return { title: "Invalid transition", output: `Cannot block goal in ${goal.status} state.` };
        }
        goal.status = "blocked";
        goal.updatedAt = new Date().toISOString();
        goal.blocker = {
          reason: args.reason,
          needed: args.needed,
          at: new Date().toISOString()
        };
        const finalUsage = await goalService.accountUsage(dir, goal.id);
        goal.tokensUsed += finalUsage.tokenDelta;
        goal.costUsed = (goal.costUsed ?? 0) + finalUsage.costDelta;
        goal.timeUsedSeconds += finalUsage.timeDeltaSeconds;
        const runtime = state.runtimes.find((r) => r.goalID === goal.id);
        if (runtime) {
          Object.assign(runtime, releaseLease(runtime));
          runtime.activeRunID = undefined;
          runtime.lastError = undefined;
          runtime.turnTokensUsed = (runtime.turnTokensUsed ?? 0) + finalUsage.tokenDelta;
          runtime.accountedMessageIDs = [...runtime.accountedMessageIDs ?? [], ...finalUsage.counted].slice(-200);
          runtime.updatedAt = new Date().toISOString();
        }
        await writeState(dir, state);
        const event = {
          version: 1,
          eventID: randomUUID5(),
          goalID: goal.id,
          type: "goal.blocked",
          reason: args.reason,
          needed: args.needed,
          timestamp: new Date().toISOString(),
          revision: state.revision
        };
        await appendEvent(dir, event);
        return {
          title: "Goal blocked",
          output: JSON.stringify({
            goalID: goal.id,
            goalName: goal.name,
            status: "blocked",
            reason: args.reason,
            needed: args.needed
          })
        };
      }
    })
  };
}
function findGoalByWorkerSession(state, sessionID) {
  if (!sessionID)
    return;
  return state.goals.find((g) => g.workerSessionID === sessionID && (g.status === "active" || g.status === "blocked"));
}
function formatGoalStructured(goal, runtime) {
  const output = {
    id: goal.id,
    name: goal.name,
    objective: goal.objective,
    status: goal.status,
    ownerSessionID: goal.ownerSessionID,
    workerSessionID: goal.workerSessionID,
    config: {
      promptFile: goal.config.promptFile,
      progressFile: goal.config.progressFile,
      includeFiles: goal.config.includeFiles,
      checks: goal.config.checks,
      checkCwd: goal.config.checkCwd,
      workspaceWrite: goal.config.workspaceWrite,
      agent: goal.config.agent,
      model: goal.config.model,
      maxTurns: goal.config.maxTurns,
      maxNoProgress: goal.config.maxNoProgress,
      maxFailures: goal.config.maxFailures,
      compactEvery: goal.config.compactEvery,
      timeoutMs: goal.config.timeoutMs,
      schedule: goal.config.schedule
    },
    lastProgress: goal.lastProgress,
    completionEvidence: goal.completionEvidence,
    blocker: goal.blocker,
    tokensUsed: goal.tokensUsed,
    tokenBudget: goal.tokenBudget,
    costUsed: goal.costUsed ?? 0,
    costBudget: goal.costBudget,
    timeUsedSeconds: goal.timeUsedSeconds
  };
  if (runtime) {
    output.runtime = {
      phase: runtime.phase,
      runCount: runtime.runCount,
      budgetTurnCount: runtime.budgetTurnCount,
      runGeneration: runtime.runGeneration,
      evaluatorRejectionCount: runtime.evaluatorRejectionCount,
      freeRetryPending: runtime.freeRetryPending,
      lastRejectionDetails: runtime.lastRejectionDetails,
      consecutiveFailures: runtime.consecutiveFailures,
      noProgressCount: runtime.noProgressCount,
      lastError: runtime.lastError,
      lastProgressAt: runtime.lastProgressAt,
      lastRunAt: runtime.lastRunAt,
      lastCompactAt: runtime.lastCompactAt,
      lastActivityAt: runtime.lastActivityAt,
      activePromptMessageID: runtime.activePromptMessageID,
      activeAssistantMessageID: runtime.activeAssistantMessageID,
      activeAssistantCompletedAt: runtime.activeAssistantCompletedAt,
      idleCandidateGeneration: runtime.idleCandidateGeneration,
      unknownStatusCount: runtime.unknownStatusCount,
      lastUnknownStatusAt: runtime.lastUnknownStatusAt,
      workerUnreachableNotifiedAt: runtime.workerUnreachableNotifiedAt,
      lastVerificationAttempt: runtime.lastVerificationAttempt,
      recentVerificationAttempts: runtime.recentVerificationAttempts,
      scheduleRunCount: runtime.scheduleRunCount,
      nextRunAt: runtime.nextRunAt,
      lastScheduleAt: runtime.lastScheduleAt
    };
  }
  return JSON.stringify(output, null, 2);
}
async function runCompletionChecks(checks, cwd) {
  const failures = [];
  for (const cmd of checks) {
    try {
      const { stdout, stderr } = await execAsync(cmd, { timeout: 30000, cwd });
    } catch (error) {
      failures.push({
        command: cmd,
        exitCode: error.code ?? 1,
        stderr: String(error.stderr || error.message || "unknown error").slice(0, 1000),
        stdout: String(error.stdout || "").slice(0, 1000)
      });
    }
  }
  return {
    passed: failures.length === 0,
    failures
  };
}

// src/server/owner-tools.ts
import { tool as tool2 } from "@opencode-ai/plugin/tool";
import { promises as fs3 } from "fs";
function withTimeout2(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms))
  ]);
}
function ownerTools(options) {
  const { directory, host, goalService } = options;
  return {
    list_background_goals: tool2({
      description: "List all active background goals owned by this session. Shows contract (name, status, phase, turn, last progress, blocker) \u2014 only goals with your ownerSessionID appear.",
      args: {},
      execute: async (_args, context) => {
        const state = await readState(directory);
        const ownerID = context?.sessionID;
        if (!ownerID) {
          return {
            title: "No session",
            output: JSON.stringify({ ok: false, message: "No session context available." })
          };
        }
        const goals = state.goals.filter((g) => g.ownerSessionID === ownerID && g.status !== "complete");
        if (goals.length === 0) {
          return {
            title: "No active goals",
            output: JSON.stringify({
              ok: true,
              goals: [],
              message: "No active background goals for this session."
            })
          };
        }
        const summaries = goals.map((g) => {
          const runtime = state.runtimes.find((r) => r.goalID === g.id);
          return {
            id: g.id,
            name: g.name,
            status: g.status,
            phase: runtime?.phase ?? "unknown",
            turn: runtime?.runCount ?? 0,
            budgetTurnCount: runtime?.budgetTurnCount ?? 0,
            maxTurns: g.config.maxTurns,
            agent: g.config.agent,
            model: g.config.model,
            lastProgress: g.lastProgress?.summary?.slice(0, 120),
            lastProgressAt: g.lastProgress?.at,
            blocker: g.blocker?.reason?.slice(0, 120),
            evaluatorRejectionCount: runtime?.evaluatorRejectionCount ?? 0,
            unknownStatusCount: runtime?.unknownStatusCount ?? 0,
            lastActivityAt: runtime?.lastActivityAt,
            retryAfter: runtime?.retryAfter,
            nextRunAt: runtime?.nextRunAt,
            scheduleRunCount: runtime?.scheduleRunCount,
            consecutiveFailures: runtime?.consecutiveFailures ?? 0,
            noProgressCount: runtime?.noProgressCount ?? 0
          };
        });
        return {
          title: `${goals.length} active goal(s)`,
          output: JSON.stringify({ ok: true, goals: summaries }, null, 2)
        };
      }
    }),
    inspect_background_goal: tool2({
      description: "Inspect a goal\u2019s full contract, runtime, and live execution state: objective, config{agent,model,checks,checkCwd,workspaceWrite,limits}, progress, blocker, runtime{phase,runCount,budgetTurnCount,runGeneration,evaluatorRejectionCount,unknownStatusCount,lastActivityAt,activePromptMessageID}, plus live transcriptTail, activeToolCallIDs, progressHistory, artifactSummary, pendingInbox. Single-call follow-up for parent to see what child is actually doing.",
      args: {
        goal_id: tool2.schema.string().optional().describe("Goal ID. Omit to inspect the first active goal."),
        includeTranscript: tool2.schema.boolean().optional().describe("Include live transcript tail (adds ~100ms). Default true. Set false for fast metadata-only."),
        transcriptLimit: tool2.schema.number().optional().describe("Number of transcript messages to include (1-10). Default 3.")
      },
      execute: async (args, context) => {
        const state = await readState(directory);
        const ownerID = context?.sessionID;
        const goal = args.goal_id ? state.goals.find((g) => g.id === args.goal_id && g.ownerSessionID === ownerID) : state.goals.find((g) => g.ownerSessionID === ownerID && g.status !== "complete");
        if (!goal) {
          return {
            title: "No goal found",
            output: JSON.stringify({ ok: false, message: "No matching active goal for this session." })
          };
        }
        const runtime = state.runtimes.find((r) => r.goalID === goal.id);
        const includeTranscript = args.includeTranscript !== false;
        const tLimit = Math.min(10, Math.max(1, args.transcriptLimit ?? 3));
        const [transcriptTail, progressHistory, artifactSummary, pendingInbox] = await Promise.all([
          includeTranscript && goal.workerSessionID ? withTimeout2(host.readMessages(goal.workerSessionID, tLimit), 900).catch(() => null) : Promise.resolve(null),
          readEvents(directory, 60).then((evs) => evs.filter((e) => e.goalID === goal.id && e.type === "goal.progress").slice(-5).map((e) => ({ summary: String(e.summary || "").slice(0, 120), next: e.next ? String(e.next).slice(0, 80) : undefined, at: String(e.timestamp || "") }))).catch(() => []),
          (async () => {
            const dir = goal.config.artifactDir;
            if (!dir)
              return;
            try {
              const files = await fs3.readdir(dir);
              return files.length ? `${files.length} file(s): ${files.slice(0, 8).join(", ")}` : "no artifacts yet";
            } catch {
              return "no artifacts yet";
            }
          })(),
          peekGoalInbox(directory, goal.id).then((msgs) => msgs.slice(-3)).catch(() => [])
        ]);
        const activeToolCallIDs = runtime?.activeToolCallIDs ?? [];
        return {
          title: `Goal: ${goal.name}`,
          output: JSON.stringify({
            ok: true,
            id: goal.id,
            name: goal.name,
            objective: goal.objective,
            status: goal.status,
            ownerSessionID: goal.ownerSessionID,
            workerSessionID: goal.workerSessionID,
            config: {
              maxTurns: goal.config.maxTurns,
              maxFailures: goal.config.maxFailures,
              timeoutMs: goal.config.timeoutMs,
              progressFile: goal.config.progressFile,
              checks: goal.config.checks,
              checkCwd: goal.config.checkCwd,
              workspaceWrite: goal.config.workspaceWrite,
              agent: goal.config.agent,
              model: goal.config.model,
              schedule: goal.config.schedule
            },
            lastProgress: goal.lastProgress,
            completionEvidence: goal.completionEvidence,
            blocker: goal.blocker,
            tokensUsed: goal.tokensUsed,
            tokenBudget: goal.tokenBudget,
            costUsed: goal.costUsed ?? 0,
            costBudget: goal.costBudget,
            timeUsedSeconds: goal.timeUsedSeconds,
            progressHistory,
            pendingInbox,
            live: {
              artifactSummary,
              transcriptTail: transcriptTail ? transcriptTail.map((m) => ({ role: m.role, content: String(m.content || "").slice(0, 400), timestamp: m.timestamp, messageID: m.messageID, parentMessageID: m.parentMessageID })) : undefined,
              activeToolCallIDs,
              pendingToolCalls: activeToolCallIDs.length,
              lastActivityAge: runtime?.lastActivityAt ? `${Math.floor((Date.now() - Date.parse(runtime.lastActivityAt)) / 1000)}s ago` : undefined
            },
            runtime: runtime ? {
              phase: runtime.phase,
              runCount: runtime.runCount,
              budgetTurnCount: runtime.budgetTurnCount,
              runGeneration: runtime.runGeneration,
              evaluatorRejectionCount: runtime.evaluatorRejectionCount,
              freeRetryPending: runtime.freeRetryPending,
              lastRejectionDetails: runtime.lastRejectionDetails?.slice(0, 800),
              consecutiveFailures: runtime.consecutiveFailures,
              noProgressCount: runtime.noProgressCount,
              lastError: runtime.lastError,
              lastProgressAt: runtime.lastProgressAt,
              lastRunAt: runtime.lastRunAt,
              lastActivityAt: runtime.lastActivityAt,
              lastCompactAt: runtime.lastCompactAt,
              activePromptMessageID: runtime.activePromptMessageID,
              activeAssistantMessageID: runtime.activeAssistantMessageID,
              activeAssistantCompletedAt: runtime.activeAssistantCompletedAt,
              idleCandidateAt: runtime.idleCandidateAt,
              idleCandidateGeneration: runtime.idleCandidateGeneration,
              unknownStatusCount: runtime.unknownStatusCount,
              lastUnknownStatusAt: runtime.lastUnknownStatusAt,
              workerUnreachableNotifiedAt: runtime.workerUnreachableNotifiedAt,
              workerAbortedAt: runtime.workerAbortedAt,
              retryAfter: runtime.retryAfter,
              forceFinishRequested: runtime.forceFinishRequested,
              scheduleRunCount: runtime.scheduleRunCount,
              nextRunAt: runtime.nextRunAt,
              lastScheduleAt: runtime.lastScheduleAt,
              lastVerificationAttempt: runtime.lastVerificationAttempt,
              recentVerificationAttempts: runtime.recentVerificationAttempts?.slice(-2)
            } : undefined
          }, null, 2)
        };
      }
    }),
    read_goal_transcript: tool2({
      description: "Read the last N messages from the worker transcript (role, content, messageID). Shows HOST VERDICT, steering, and whether the worker\u2019s last prompt was correlated. Use to debug why a completion was rejected or why a worker is stuck.",
      args: {
        goal_id: tool2.schema.string().optional().describe("Goal ID. Omit to read the first active goal."),
        limit: tool2.schema.number().optional().describe("Max messages to return (default: 20).")
      },
      execute: async (args, context) => {
        const state = await readState(directory);
        const ownerID = context?.sessionID;
        const goal = args.goal_id ? state.goals.find((g) => g.id === args.goal_id && g.ownerSessionID === ownerID) : state.goals.find((g) => g.ownerSessionID === ownerID && g.status !== "complete");
        if (!goal) {
          return {
            title: "No goal found",
            output: JSON.stringify({ ok: false, message: "No matching active goal for this session." })
          };
        }
        if (!goal.workerSessionID) {
          return {
            title: "No worker",
            output: JSON.stringify({ ok: false, message: "Goal has no worker session yet." })
          };
        }
        try {
          const messages = await host.readMessages(goal.workerSessionID, args.limit || 20);
          return {
            title: `Transcript: ${goal.name}`,
            output: JSON.stringify({
              ok: true,
              goalID: goal.id,
              workerSessionID: goal.workerSessionID,
              messages: messages.map((m) => ({
                role: m.role,
                content: m.content.slice(0, 2000),
                timestamp: m.timestamp,
                messageID: m.messageID
              }))
            }, null, 2)
          };
        } catch (error) {
          return {
            title: "Transcript error",
            output: JSON.stringify({
              ok: false,
              message: error instanceof Error ? error.message : String(error)
            })
          };
        }
      }
    }),
    send_goal_input: tool2({
      description: "Send an inbox message to the worker (injected as ## USER INSTRUCTIONS on next turn). Use to answer `question`, redirect, or refine scope. Does NOT itself re-prompt \u2014 the engine re-prompts on next idle/maintenance; use nudge_goal if the worker is stuck with no activity.",
      args: {
        goal_id: tool2.schema.string().optional().describe("Goal ID. Omit to target the first active goal."),
        message: tool2.schema.string().describe("Message to send to the worker.")
      },
      execute: async (args, context) => {
        const state = await readState(directory);
        const ownerID = context?.sessionID;
        const goal = args.goal_id ? state.goals.find((g) => g.id === args.goal_id && g.ownerSessionID === ownerID) : state.goals.find((g) => g.ownerSessionID === ownerID && g.status !== "complete");
        if (!goal) {
          return {
            title: "No goal found",
            output: JSON.stringify({ ok: false, message: "No matching active goal for this session." })
          };
        }
        await appendGoalInbox(directory, goal.id, "user", args.message);
        return {
          title: "Message sent",
          output: JSON.stringify({
            ok: true,
            goalID: goal.id,
            goalName: goal.name,
            message: `Message delivered to "${goal.name}". It will appear in the worker's next turn.`
          })
        };
      }
    }),
    pause_goal: tool2({
      description: "Pause an active goal: status active \u2192 paused, releaseLease, abortWorker, per-goal mutex. Frees the workspaceWrite slot. Use to investigate or to free the single-writer slot.",
      args: {
        goal_id: tool2.schema.string().optional().describe("Goal ID. Omit to pause the first active goal.")
      },
      execute: async (args, context) => {
        const state = await readState(directory);
        const ownerID = context?.sessionID;
        const goal = args.goal_id ? state.goals.find((g) => g.id === args.goal_id && g.ownerSessionID === ownerID) : state.goals.find((g) => g.ownerSessionID === ownerID && g.status !== "complete");
        if (!goal) {
          return {
            title: "No goal found",
            output: JSON.stringify({ ok: false, message: "No matching active goal for this session." })
          };
        }
        if (goal.status === "paused") {
          return {
            title: "Already paused",
            output: JSON.stringify({ ok: true, message: `Goal "${goal.name}" is already paused.` })
          };
        }
        try {
          await goalService.pause(directory, goal.id);
          return {
            title: "Goal paused",
            output: JSON.stringify({
              ok: true,
              goalID: goal.id,
              goalName: goal.name,
              message: `Goal "${goal.name}" paused. Resume with resume_goal.`
            })
          };
        } catch (error) {
          return {
            title: "Pause failed",
            output: JSON.stringify({
              ok: false,
              goalName: goal.name,
              message: error instanceof Error ? error.message : String(error)
            })
          };
        }
      }
    }),
    resume_goal: tool2({
      description: "Resume a paused (\u2192active, reuses existing worker if sessionStatus still idle/busy) or retry a blocked (\u2192active, resets consecutiveFailures/forceFinish). Fails with 'already active' if another workspaceWrite writer is active. Per-goal mutex.",
      args: {
        goal_id: tool2.schema.string().optional().describe("Goal ID. Omit to resume the first paused/blocked goal.")
      },
      execute: async (args, context) => {
        const state = await readState(directory);
        const ownerID = context?.sessionID;
        const goal = args.goal_id ? state.goals.find((g) => g.id === args.goal_id && g.ownerSessionID === ownerID) : state.goals.find((g) => g.ownerSessionID === ownerID && (g.status === "paused" || g.status === "blocked"));
        if (!goal) {
          return {
            title: "No goal found",
            output: JSON.stringify({
              ok: false,
              message: "No matching paused/blocked goal for this session."
            })
          };
        }
        if (goal.status === "active") {
          return {
            title: "Already active",
            output: JSON.stringify({ ok: true, message: `Goal "${goal.name}" is already active.` })
          };
        }
        try {
          if (goal.status === "paused") {
            await goalService.resume(directory, goal.id);
          } else if (goal.status === "blocked") {
            await goalService.retry(directory, goal.id);
          }
          return {
            title: "Goal resumed",
            output: JSON.stringify({
              ok: true,
              goalID: goal.id,
              goalName: goal.name,
              message: `Goal "${goal.name}" resumed.`
            })
          };
        } catch (error) {
          return {
            title: "Resume failed",
            output: JSON.stringify({
              ok: false,
              goalName: goal.name,
              message: error instanceof Error ? error.message : String(error)
            })
          };
        }
      }
    }),
    nudge_goal: tool2({
      description: "Force re-prompt a stuck active worker (the hardened recovery). Clears stale activeRunID/idleCandidate/generation/lease (phase\u2192idle) and calls continueTurn({force:true}) even if sessionStatus is not idle. Use when unknownStatusCount\u22653, lastActivityAt is stale, or maintenance notified 'worker is unreachable'. Per-goal mutex.",
      args: {
        goal_id: tool2.schema.string().optional().describe("Goal ID. Omit to nudge the first active goal.")
      },
      execute: async (args, context) => {
        const state = await readState(directory);
        const ownerID = context?.sessionID;
        const goal = args.goal_id ? state.goals.find((g) => g.id === args.goal_id && g.ownerSessionID === ownerID) : state.goals.find((g) => g.ownerSessionID === ownerID && g.status !== "complete");
        if (!goal) {
          return {
            title: "No goal found",
            output: JSON.stringify({ ok: false, message: "No matching active goal for this session." })
          };
        }
        try {
          const result = await goalService.nudge(directory, goal.id);
          return {
            title: result.ok ? "Goal nudged" : "Nudge failed",
            output: JSON.stringify({ ...result, goalID: goal.id, goalName: goal.name })
          };
        } catch (error) {
          return {
            title: "Nudge failed",
            output: JSON.stringify({
              ok: false,
              goalName: goal.name,
              message: error instanceof Error ? error.message : String(error)
            })
          };
        }
      }
    }),
    clear_goal: tool2({
      description: "Clear a goal: aborts worker and removes goal+runtime+ledger (cannot be undone). Use when the goal is no longer needed or to free a stuck writer slot after inspection.",
      args: {
        goal_id: tool2.schema.string().optional().describe("Goal ID. Omit to clear the first active goal.")
      },
      execute: async (args, context) => {
        const state = await readState(directory);
        const ownerID = context?.sessionID;
        const goal = args.goal_id ? state.goals.find((g) => g.id === args.goal_id && g.ownerSessionID === ownerID) : state.goals.find((g) => g.ownerSessionID === ownerID && g.status !== "complete");
        if (!goal) {
          return {
            title: "No goal found",
            output: JSON.stringify({ ok: false, message: "No matching active goal for this session." })
          };
        }
        try {
          await goalService.clear(directory, goal.id);
          return {
            title: "Goal cleared",
            output: JSON.stringify({
              ok: true,
              goalID: goal.id,
              goalName: goal.name,
              message: `Goal "${goal.name}" cleared and removed.`
            })
          };
        } catch (error) {
          return {
            title: "Clear failed",
            output: JSON.stringify({
              ok: false,
              goalName: goal.name,
              message: error instanceof Error ? error.message : String(error)
            })
          };
        }
      }
    })
  };
}
// src/server/plugin.ts
var PLUGIN_ID = "opencode-loopd.server";
var server = async ({ client, directory }, pluginOptions) => {
  const defaults = parsePluginDefaults(pluginOptions);
  const host = createRealHost(client, directory);
  const goalService = createGoalService(host);
  const worker = createControlWorker({
    directory,
    goalService,
    pollIntervalMs: 1000,
    defaults
  });
  const engine = createLoopEngine({
    directory,
    host,
    goalService,
    pollIntervalMs: 30000
  });
  const scheduleWorker = createScheduleWorker({
    directory,
    goalService,
    intervalMs: 5000
  });
  let started = false;
  let reconciliationStarted = false;
  function ensureStarted() {
    if (started)
      return;
    started = true;
    engine.start();
    worker.start();
    scheduleWorker.start();
  }
  function reconcileInBackground() {
    if (reconciliationStarted)
      return;
    reconciliationStarted = true;
    logServerEvent(directory, "reconcile.started");
    goalService.reconcile(directory).then(() => logServerEvent(directory, "reconcile.completed"), (error) => logServerEvent(directory, "reconcile.failed", { detail: describeError(error) }));
  }
  return {
    event: async ({ event }) => {
      const type = event?.type;
      if (type?.startsWith("session.")) {
        ensureStarted();
      }
      await engine.handleEvent(event);
      if (type?.startsWith("session."))
        reconcileInBackground();
    },
    tool: { ...goalTools(directory, goalService, undefined, defaults), ...ownerTools({ directory, host, goalService }) },
    "tool.execute.before": async (input, _output) => {
      const activeWorkers = goalService.getActiveWorkers();
      let matchedGoalID;
      for (const [goalID, worker2] of activeWorkers) {
        if (worker2.workerSessionID === input.sessionID) {
          matchedGoalID = goalID;
          break;
        }
      }
      if (!matchedGoalID)
        return;
      try {
        await mutateState(directory, `tool-call.start:${matchedGoalID}:${input.callID}`, async (s) => {
          const runtime = s.runtimes.find((r) => r.goalID === matchedGoalID);
          if (runtime)
            Object.assign(runtime, addToolCall(runtime, input.callID));
          return s;
        });
      } catch {}
    },
    "tool.execute.after": async (input, output) => {
      if (input.tool === "loopd_create_goal" || input.tool === "get_goal" || input.tool === "report_goal_progress") {
        ensureStarted();
        reconcileInBackground();
      }
      const activeWorkers = goalService.getActiveWorkers();
      let matchedGoalID;
      for (const [goalID, worker2] of activeWorkers) {
        if (worker2.workerSessionID === input.sessionID) {
          matchedGoalID = goalID;
          break;
        }
      }
      if (matchedGoalID) {
        try {
          await mutateState(directory, `tool-call.end:${matchedGoalID}:${input.callID}`, async (s) => {
            const runtime = s.runtimes.find((r) => r.goalID === matchedGoalID);
            if (runtime)
              Object.assign(runtime, removeToolCall(runtime, input.callID));
            return s;
          });
        } catch {}
      }
      if (input.tool === "complete_goal" || input.tool === "block_goal") {
        try {
          const raw = output?.output;
          if (!raw)
            return;
          const parsed = JSON.parse(raw);
          if (parsed.status !== "complete" && parsed.status !== "blocked")
            return;
          const goalID = parsed.goalID;
          if (!goalID)
            return;
          const { shouldNotifyParent: shouldNotifyParent2, markParentNotified: markParentNotified2 } = await Promise.resolve().then(() => exports_runtime);
          const state = await readState(directory);
          const goal = state.goals.find((g) => g.id === goalID);
          if (!goal)
            return;
          const runtime = state.runtimes.find((r) => r.goalID === goalID);
          const notifyType = parsed.status === "complete" ? "complete" : "blocked";
          if (runtime && !shouldNotifyParent2(runtime, notifyType))
            return;
          if (runtime) {
            await mutateState(directory, `notify-parent:${goalID}`, async (s) => {
              const rt = s.runtimes.find((r) => r.goalID === goalID);
              if (rt)
                markParentNotified2(rt, notifyType);
              return s;
            });
          }
          const message = parsed.status === "complete" ? `Loop goal "${goal.name}" completed: ${parsed.summary || ""}. Evidence: ${parsed.evidence || ""}. Artifacts: ${goal.config.artifactDir || "n/a"}.` : `Loop goal "${goal.name}" blocked: ${parsed.reason || ""}. Needed: ${parsed.needed || ""}.`;
          await host.notifyOwner(goal.ownerSessionID, message);
        } catch {}
      }
    },
    dispose: async () => {
      engine.stop();
      await worker.stop();
      scheduleWorker.stop();
    }
  };
};
function parsePluginDefaults(options) {
  const agent = typeof options?.defaultAgent === "string" ? options.defaultAgent.trim() : "";
  const model = typeof options?.defaultModel === "string" ? options.defaultModel.trim() : "";
  const checks = Array.isArray(options?.defaultChecks) ? options.defaultChecks.filter((item) => typeof item === "string").map((item) => item.trim()).filter(Boolean) : [];
  return {
    defaultAgent: agent || undefined,
    defaultModel: model || undefined,
    defaultChecks: checks.length > 0 ? checks : undefined
  };
}
var plugin_default = {
  id: PLUGIN_ID,
  server
};
export {
  plugin_default as default
};

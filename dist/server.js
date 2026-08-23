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
var __esm = (fn, res) => () => (fn && (res = fn(fn = 0)), res);

// src/infrastructure/state-repository.ts
var exports_state_repository = {};
__export(exports_state_repository, {
  writeState: () => writeState,
  writeControlResponse: () => writeControlResponse,
  writeControlRequest: () => writeControlRequest,
  recoverStaleProcessing: () => recoverStaleProcessing,
  readState: () => readState,
  readEvents: () => readEvents,
  readControlResponse: () => readControlResponse,
  readControlRequest: () => readControlRequest,
  mutateState: () => mutateState,
  listPendingRequests: () => listPendingRequests,
  goalArtifactDir: () => goalArtifactDir,
  ensureGoalArtifactDir: () => ensureGoalArtifactDir,
  drainGoalInbox: () => drainGoalInbox,
  claimControlRequest: () => claimControlRequest,
  appendGoalInbox: () => appendGoalInbox,
  appendEvent: () => appendEvent
});
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { randomUUID } from "crypto";
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
async function acquireLock(directory, key, operation) {
  const dir = lockDir(directory);
  await fs.mkdir(dir, { recursive: true });
  const lockPath = lockFile(directory, key);
  const lockID = randomUUID();
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
      const temp = lockPath + `.${lockID}.tmp`;
      const meta = { pid: process.pid, operation, acquiredAt: new Date().toISOString() };
      await fs.writeFile(temp, JSON.stringify(meta), "utf8");
      try {
        await fs.rename(temp, lockPath);
        return;
      } catch (error) {
        await fs.rm(temp, { force: true });
        if (error?.code !== "EEXIST")
          throw error;
      }
    } catch (error) {
      if (error?.code === "ENOENT") {
        await fs.mkdir(dir, { recursive: true });
        continue;
      }
      throw error;
    }
    await delay(25 * (attempt + 1));
  }
  throw new Error(`failed to acquire lock "${key}" for "${operation}" after retries`);
}
async function releaseLock(directory, key) {
  try {
    await fs.rm(lockFile(directory, key), { force: true });
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
async function writeControlRequest(directory, request) {
  const dir = path.join(controlDir(directory), "requests");
  await fs.mkdir(dir, { recursive: true });
  await writeAtomic(requestFile(directory, request.requestID), JSON.stringify(request, null, 2));
}
async function readControlRequest(directory, requestID) {
  try {
    const raw = await fs.readFile(requestFile(directory, requestID), "utf8");
    return JSON.parse(raw);
  } catch {
    return;
  }
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
async function recoverStaleProcessing(directory) {
  const dir = path.join(controlDir(directory), "processing");
  try {
    const files = await fs.readdir(dir);
    const recovered = [];
    for (const file of files) {
      if (!file.endsWith(".json"))
        continue;
      const processingPath = path.join(dir, file);
      const requestPath = path.join(controlDir(directory), "requests", file);
      try {
        const raw = await fs.readFile(processingPath, "utf8");
        const request = JSON.parse(raw);
        await fs.rename(processingPath, requestPath);
        recovered.push(request);
      } catch {}
    }
    return recovered;
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
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
var CURRENT_VERSION = 2, LOCK_STALE_MS = 1e4;
var init_state_repository = () => {};

// src/domain/runtime.ts
var exports_runtime = {};
__export(exports_runtime, {
  shouldNotifyParent: () => shouldNotifyParent,
  releaseLease: () => releaseLease,
  markProgress: () => markProgress,
  markParentNotified: () => markParentNotified,
  leaseIsValid: () => leaseIsValid,
  createRuntimeState: () => createRuntimeState,
  acquireLease: () => acquireLease
});
function createRuntimeState(goalID) {
  const now = new Date().toISOString();
  return {
    goalID,
    phase: "idle",
    consecutiveFailures: 0,
    runCount: 0,
    turnCount: 0,
    noProgressCount: 0,
    progressDuringTurn: false,
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
    updatedAt: new Date(now).toISOString()
  };
}
function releaseLease(rt) {
  return {
    ...rt,
    phase: "idle",
    leaseExpiresAt: undefined,
    turnStartedAt: undefined,
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
var PARENT_NOTIFY_DEDUPE_MS = 60000;

// src/application/control-worker.ts
init_state_repository();
import { randomUUID as randomUUID2 } from "crypto";

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
    processPending();
    pollTimer = setInterval(() => {
      if (running && lastProcessDone) {
        lastProcessDone = false;
        processPending().then(() => {
          lastProcessDone = true;
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
        const { goal } = await goalSvc.start(directory, {
          name: args.name,
          objective: args.objective,
          ownerSessionID: args.ownerSessionID,
          config: args.config
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
        await appendGoalInbox(directory, request.goalID, "user", text);
        const state2 = await readState(directory);
        const goal = state2.goals.find((g) => g.id === request.goalID);
        response = {
          ...base,
          message: `sent to "${goal?.name || request.goalID}"`,
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
          runtime.phase = "idle";
          runtime.lastError = undefined;
          runtime.updatedAt = new Date().toISOString();
        }
        await writeState(directory, state2);
        await appendEvent(directory, {
          version: 1,
          eventID: randomUUID2(),
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
          runtime.phase = "idle";
          runtime.lastError = undefined;
          runtime.updatedAt = new Date().toISOString();
        }
        await writeState(directory, state2);
        await appendEvent(directory, {
          version: 1,
          eventID: randomUUID2(),
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
init_state_repository();
import { randomUUID as randomUUID3 } from "crypto";

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
  return { ...input, tokensUsed: 0, timeUsedSeconds: 0, createdAt: now, updatedAt: now };
}
// src/application/loop-engine.ts
var HANDLED_EVENT_TYPES = new Set([
  "session.idle",
  "session.status",
  "session.error",
  "session.compacted"
]);
function createLoopEngine(options) {
  const { directory, host, goalService } = options;
  const maintenanceMs = options.pollIntervalMs ?? 30000;
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
    const sessionID = event.properties?.sessionID;
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
    if (isTerminal(goal.status) || goal.status === "paused")
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
      default:
        return false;
    }
  }
  async function handleSessionIdle(state, goal) {
    const runtime = state.runtimes.find((r) => r.goalID === goal.id);
    if (!runtime)
      return false;
    if (inflightContinuations.has(goal.id))
      return false;
    if (runtime.phase === "running") {
      const completedRunID = runtime.activeRunID;
      Object.assign(runtime, releaseLease(runtime));
      runtime.activeRunID = undefined;
      runtime.lastWorkerStatus = "idle";
      await writeState(directory, state);
      if (completedRunID) {
        await appendEvent(directory, {
          version: 1,
          eventID: randomUUID3(),
          goalID: goal.id,
          type: "run.completed",
          runID: completedRunID,
          timestamp: new Date().toISOString(),
          revision: state.revision
        });
      }
    }
    if (goal.status !== "active")
      return false;
    const limitResult = enforceLimits(goal, runtime);
    if (limitResult.stop === "force_finish") {
      if (!runtime.forceFinishRequested) {
        runtime.forceFinishRequested = true;
        await writeState(directory, state);
        await goalService.continueTurn(directory, goal.id, { forceFinish: true });
        return true;
      }
      const blockedKey = goal.id;
      const nowBlocked = Date.now();
      const lastBlocked = recentForceFinishBlocked.get(blockedKey);
      if (lastBlocked !== undefined && nowBlocked - lastBlocked < 60000)
        return true;
      recentForceFinishBlocked.set(blockedKey, nowBlocked);
      goal.status = "blocked";
      goal.updatedAt = new Date().toISOString();
      goal.blocker = {
        reason: limitResult.reason + " (force-finish ignored)",
        needed: "User intervention required. Use retry to attempt again.",
        at: new Date().toISOString()
      };
      runtime.forceFinishRequested = undefined;
      const shouldNotify = shouldNotifyParent(runtime, "stopped");
      if (shouldNotify)
        markParentNotified(runtime, "stopped");
      await writeState(directory, state);
      await appendEvent(directory, {
        version: 1,
        eventID: randomUUID3(),
        goalID: goal.id,
        type: "goal.blocked",
        reason: limitResult.reason + " (force-finish ignored)",
        needed: goal.blocker.needed,
        timestamp: new Date().toISOString(),
        revision: state.revision
      });
      if (shouldNotify) {
        await host.notifyOwner(goal.ownerSessionID, `Loop goal "${goal.name}" stopped: ${limitResult.reason} (child did not wrap up). Status: blocked. Last progress: ${goal.lastProgress?.summary || "none"}.`);
      }
      return true;
    }
    if (limitResult.stop === "budget") {
      await writeState(directory, state);
      await appendEvent(directory, {
        version: 1,
        eventID: randomUUID3(),
        goalID: goal.id,
        type: "goal.status_changed",
        from: "active",
        to: goal.status,
        timestamp: new Date().toISOString(),
        revision: state.revision
      });
      return true;
    }
    if (shouldCompact(goal, runtime)) {
      await doCompact(goal, runtime);
      return true;
    }
    await continueGoal(goal.id);
    return true;
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
    runtime.lastWorkerStatus = statusType;
    runtime.updatedAt = new Date().toISOString();
    await writeState(directory, state);
    return true;
  }
  async function handleSessionError(state, goal, event) {
    const runtime = state.runtimes.find((r) => r.goalID === goal.id);
    if (!runtime)
      return false;
    const error = event.properties?.error;
    const message = describeError(error) || "unknown error";
    runtime.consecutiveFailures += 1;
    runtime.lastError = message;
    runtime.updatedAt = new Date().toISOString();
    if (runtime.phase === "running") {
      Object.assign(runtime, releaseLease(runtime));
    }
    await appendEvent(directory, {
      version: 1,
      eventID: randomUUID3(),
      goalID: goal.id,
      type: "run.failed",
      runID: runtime.activeRunID || "unknown",
      error: message,
      consecutiveFailures: runtime.consecutiveFailures,
      timestamp: new Date().toISOString(),
      revision: state.revision
    });
    const maxFailures = goal.config?.maxFailures || 5;
    if (runtime.consecutiveFailures >= maxFailures) {
      goal.status = "blocked";
      goal.updatedAt = new Date().toISOString();
      goal.blocker = {
        reason: `Failed ${runtime.consecutiveFailures} times. Last error: ${message}`,
        needed: "User intervention required. Use retry to attempt again.",
        at: new Date().toISOString()
      };
      await appendEvent(directory, {
        version: 1,
        eventID: randomUUID3(),
        goalID: goal.id,
        type: "goal.blocked",
        reason: `Failed ${runtime.consecutiveFailures} times`,
        needed: "User intervention required",
        timestamp: new Date().toISOString(),
        revision: state.revision
      });
      if (shouldNotifyParent(runtime, "failed")) {
        markParentNotified(runtime, "failed");
        await host.notifyOwner(goal.ownerSessionID, `Loop goal "${goal.name}" blocked after ${runtime.consecutiveFailures} failures. Last error: ${message}.`);
      }
    } else {
      const backoffMs = Math.min(30000, 1000 * Math.pow(2, runtime.consecutiveFailures));
      runtime.retryAfter = new Date(Date.now() + backoffMs).toISOString();
      runtime.phase = "waiting_retry";
    }
    await writeState(directory, state);
    return true;
  }
  async function handleSessionCompacted(state, goal) {
    const runtime = state.runtimes.find((r) => r.goalID === goal.id);
    if (!runtime)
      return false;
    runtime.lastCompactAt = new Date().toISOString();
    runtime.updatedAt = new Date().toISOString();
    await writeState(directory, state);
    await appendEvent(directory, {
      version: 1,
      eventID: randomUUID3(),
      goalID: goal.id,
      type: "compaction.completed",
      timestamp: new Date().toISOString(),
      revision: state.revision
    });
    return true;
  }
  function enforceLimits(goal, runtime) {
    const noResult = { stop: "none", blocked: false, event: "goal.status_changed", reason: "" };
    const maxTurns = goal.config?.maxTurns;
    if (maxTurns && runtime.turnCount >= maxTurns) {
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
    return noResult;
  }
  function shouldCompact(goal, runtime) {
    const compactEvery = goal.config?.compactEvery;
    if (!compactEvery)
      return false;
    return runtime.turnCount > 0 && runtime.turnCount % compactEvery === 0;
  }
  async function doCompact(goal, runtime) {
    if (!goal.workerSessionID)
      return;
    const prevPhase = runtime.phase;
    runtime.phase = "compacting";
    runtime.lastCompactAt = new Date().toISOString();
    const state = await readState(directory);
    await writeState(directory, state);
    await appendEvent(directory, {
      version: 1,
      eventID: randomUUID3(),
      goalID: goal.id,
      type: "compaction.started",
      timestamp: new Date().toISOString(),
      revision: state.revision
    });
    try {
      await host.compactSession(goal.workerSessionID);
    } catch {}
    const updatedState = await readState(directory);
    const updatedRuntime = updatedState.runtimes.find((r) => r.goalID === goal.id);
    if (updatedRuntime) {
      updatedRuntime.phase = prevPhase;
      await writeState(directory, updatedState);
    }
  }
  async function maintenance() {
    syncWorkerSessionsFromService();
    if (knownWorkerSessions.size === 0)
      return;
    const state = await readState(directory);
    const hasActiveGoals = state.goals.some((g) => !isTerminal(g.status) && g.status !== "paused");
    if (!hasActiveGoals)
      return;
    for (const goal of state.goals) {
      if (isTerminal(goal.status) || goal.status === "paused")
        continue;
      const runtime = state.runtimes.find((r) => r.goalID === goal.id);
      if (!runtime)
        continue;
      if (runtime.phase === "waiting_retry" && runtime.retryAfter) {
        if (Date.now() >= Date.parse(runtime.retryAfter)) {
          runtime.retryAfter = undefined;
          runtime.phase = "idle";
          await writeState(directory, state);
          goalService.continueTurn(directory, goal.id).catch(() => {});
        }
      }
      if ((runtime.phase === "running" || runtime.phase === "idle") && goal.workerSessionID) {
        const status = await host.sessionStatus(goal.workerSessionID);
        if (status === "idle") {
          await handleSessionIdle(state, goal);
          continue;
        }
      }
    }
  }
  return { start, stop, isRunning, handleEvent, preloadWorkerSessions };
}

// src/application/goal-service.ts
import { randomUUID as randomUUID4 } from "crypto";
init_state_repository();
import * as path2 from "path";
import { promises as fs2 } from "fs";

// src/server/worker-session.ts
function createWorkerManager(host) {
  return {
    async createWorker(goal) {
      const workerSessionID = await host.createWorker({
        parentID: goal.ownerSessionID,
        title: `loopd: ${goal.name}`,
        agent: goal.config.agent
      });
      return {
        goalID: goal.id,
        workerSessionID,
        startedAt: new Date().toISOString()
      };
    },
    async continueWorker(worker, goal, runtime, context) {
      const prompt = buildContinuationSteering(goal, runtime, context);
      await host.promptWorker({
        sessionID: worker.workerSessionID,
        prompt,
        agent: goal.config.agent
      });
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
  if (runtime.turnCount <= 1) {
    parts.push(`You are a worker for an active goal.`, ``, `Call get_goal to read the authoritative objective, acceptance criteria, and current state.`, `Perform one concrete batch of work. After durable verification:`, ``, `- Call report_goal_progress if work remains.`, `- Call complete_goal only if ALL acceptance criteria pass with concrete evidence.`, `- Call block_goal only for a real external blocker requiring user intervention.`, `- Use the built-in question tool when you need clarification only the user can provide.`, ``, `Do not ask questions unnecessarily. Make reasonable assumptions and work directly.`);
    parts.push(...outputLocationBlock());
  } else {
    parts.push(`This is continuation turn ${runtime.turnCount} for the goal below.`, ``, `## GOAL (user-provided data)`, goal.objective);
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
      if (v.evaluatorRejectionCount && v.evaluatorRejectionCount > 0) {
        parts.push(`- evaluator rejected ${v.evaluatorRejectionCount} time(s): previous completion claim had weak evidence \u2014 fix the issues and call complete_goal again with stronger evidence`);
      }
    }
    parts.push(``, `## COMPLETION AUDIT \u2014 you ARE the evaluator`, `Before deciding the goal is achieved, treat completion as unproven:`, `1. Derive concrete requirements from the objective and any referenced files/plans/specs/issues. Preserve original scope; do not redefine success.`, `2. For _every_ explicit requirement, numbered item, named artifact, command, test, gate, invariant, deliverable \u2192 identify authoritative evidence: files, command output, test results, PR state, rendered artifacts, runtime behavior.`, `3. Judge each per-requirement: proves | contradicts | incomplete | too weak/indirect | missing \u2014 matching scope narrowly (narrow check \u2260 broad claim).`, `4. Treat tests/manifests/verifiers as evidence only after confirming they cover the relevant requirement. Treat uncertain/indirect as NOT achieved.`, `5. Only call complete_goal when _every_ requirement's current-state evidence proves it and no required work remains. If any requirement is missing/incomplete/weak \u2192 keep working, do not call complete_goal.`);
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
  async function start(directory, input) {
    const state = await readState(directory);
    const id = randomUUID4();
    const goal = createGoal({
      id,
      name: input.name,
      objective: input.objective,
      status: "active",
      ownerSessionID: input.ownerSessionID,
      config: {
        maxTurns: 50,
        ...input.config
      }
    });
    const artifactDir = goalArtifactDir(directory, id);
    goal.config.artifactDir = artifactDir;
    if (!goal.config.progressFile)
      goal.config.progressFile = path2.join(artifactDir, "progress.md");
    await ensureGoalArtifactDir(directory, id);
    state.goals.push(goal);
    state.runtimes.push(createRuntimeState(id));
    const runtime = state.runtimes.find((r) => r.goalID === id);
    if (runtime) {
      runtime.phase = "queued";
      await writeState(directory, state);
    }
    let worker;
    try {
      worker = await workers.createWorker(goal);
    } catch (error) {
      const detail = describeError(error);
      goal.status = "blocked";
      goal.updatedAt = new Date().toISOString();
      goal.blocker = {
        reason: detail,
        needed: "Start the goal again from a valid OpenCode session after correcting the worker creation error.",
        at: new Date().toISOString()
      };
      if (runtime) {
        runtime.phase = "idle";
        runtime.lastError = detail;
        runtime.updatedAt = new Date().toISOString();
      }
      await writeState(directory, state);
      await appendEvent(directory, {
        version: 1,
        eventID: randomUUID4(),
        goalID: id,
        type: "goal.blocked",
        reason: detail,
        needed: goal.blocker.needed,
        timestamp: new Date().toISOString(),
        revision: state.revision
      });
      await logServerEvent(directory, "goal.start.failed", { goalID: id, ownerSessionID: input.ownerSessionID, detail });
      throw error;
    }
    sessions.set(id, worker);
    goal.workerSessionID = worker.workerSessionID;
    await writeState(directory, state);
    await appendEvent(directory, {
      version: 1,
      eventID: randomUUID4(),
      goalID: id,
      type: "goal.created",
      name: input.name,
      objective: input.objective,
      ownerSessionID: input.ownerSessionID,
      timestamp: new Date().toISOString(),
      revision: state.revision
    });
    if (runtime) {
      const runID = randomUUID4();
      Object.assign(runtime, acquireLease(runtime, goal.config.timeoutMs || 300000));
      runtime.activeRunID = runID;
      runtime.turnCount = 1;
      runtime.runCount = 1;
      runtime.lastRunAt = new Date().toISOString();
      await writeState(directory, state);
      await appendEvent(directory, {
        version: 1,
        eventID: randomUUID4(),
        goalID: id,
        type: "run.started",
        runID,
        turnCount: runtime.turnCount,
        timestamp: new Date().toISOString(),
        revision: state.revision
      });
      await workers.continueWorker(worker, goal, runtime);
    }
    return { goal, worker };
  }
  async function continueTurn(directory, goalID, opts) {
    const state = await readState(directory);
    const goal = state.goals.find((g) => g.id === goalID);
    if (!goal || isTerminal(goal.status))
      return;
    const runtime = state.runtimes.find((r) => r.goalID === goalID);
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
    if (!await workers.isIdle(session.workerSessionID))
      return;
    const timeoutMs = goal.config.timeoutMs || 300000;
    const leased = acquireLease(runtime, timeoutMs);
    Object.assign(runtime, leased);
    const runID = randomUUID4();
    runtime.activeRunID = runID;
    runtime.turnCount += 1;
    runtime.runCount += 1;
    runtime.lastRunAt = new Date().toISOString();
    await writeState(directory, state);
    await appendEvent(directory, {
      version: 1,
      eventID: randomUUID4(),
      goalID,
      type: "run.started",
      runID,
      turnCount: runtime.turnCount,
      timestamp: new Date().toISOString(),
      revision: state.revision
    });
    const inboxMessages = await drainGoalInbox(directory, goalID);
    const allEvents = await readEvents(directory, 200);
    const progressHistory = allEvents.filter((e) => e.goalID === goalID && e.type === "goal.progress").map((e) => ({
      summary: String(e.summary || ""),
      next: e.next ? String(e.next) : undefined,
      at: String(e.timestamp || "")
    }));
    let transcriptTail;
    try {
      transcriptTail = await host.readMessages(goal.workerSessionID, 5);
    } catch {
      transcriptTail = [];
    }
    let verification;
    try {
      const artifactDir = goal.config.artifactDir;
      if (artifactDir) {
        try {
          const files = await fs2.readdir(artifactDir);
          verification = { artifactSummary: files.length ? `${files.length} file(s): ${files.slice(0, 8).join(", ")}` : "no artifacts yet" };
        } catch {
          verification = { artifactSummary: "no artifacts yet" };
        }
      }
      if (goal.config.checks?.length) {
        const c = `checks configured: ${goal.config.checks.length} \u2014 run them before claiming completion`;
        verification = { ...verification || {}, failedChecks: [c], checksPassed: undefined };
      }
      if (runtime.evaluatorRejectionCount && runtime.evaluatorRejectionCount > 0) {
        verification = { ...verification || {}, evaluatorRejectionCount: runtime.evaluatorRejectionCount };
      }
    } catch {}
    const context = {
      inboxMessages: inboxMessages.length > 0 ? inboxMessages : undefined,
      progressHistory: progressHistory.length > 0 ? progressHistory : undefined,
      transcriptTail: transcriptTail && transcriptTail.length > 0 ? transcriptTail : undefined,
      forceFinish: opts?.forceFinish || undefined,
      verification
    };
    await workers.continueWorker(session, goal, runtime, context);
  }
  async function pause(directory, goalID) {
    const state = await readState(directory);
    const goal = state.goals.find((g) => g.id === goalID);
    if (!goal)
      return;
    if (!canTransition(goal.status, "paused", "user"))
      return;
    goal.status = "paused";
    goal.updatedAt = new Date().toISOString();
    const session = sessions.get(goalID) || (goal.workerSessionID ? {
      goalID: goal.id,
      workerSessionID: goal.workerSessionID,
      startedAt: goal.createdAt
    } : undefined);
    if (session) {
      await workers.abortWorker(session.workerSessionID);
      sessions.delete(goalID);
    }
    const runtime = state.runtimes.find((r) => r.goalID === goalID);
    if (runtime) {
      Object.assign(runtime, releaseLease(runtime));
    }
    await writeState(directory, state);
    await appendEvent(directory, {
      version: 1,
      eventID: randomUUID4(),
      goalID,
      type: "goal.status_changed",
      from: "active",
      to: "paused",
      timestamp: new Date().toISOString(),
      revision: state.revision
    });
  }
  async function resume(directory, goalID) {
    const state = await readState(directory);
    const goal = state.goals.find((g) => g.id === goalID);
    if (!goal)
      return;
    if (!canTransition(goal.status, "active", "user"))
      return;
    goal.status = "active";
    goal.updatedAt = new Date().toISOString();
    let session = sessions.get(goalID);
    if (!session) {
      session = await workers.createWorker(goal);
      sessions.set(goalID, session);
      goal.workerSessionID = session.workerSessionID;
    }
    await writeState(directory, state);
    await appendEvent(directory, {
      version: 1,
      eventID: randomUUID4(),
      goalID,
      type: "goal.status_changed",
      from: "paused",
      to: "active",
      timestamp: new Date().toISOString(),
      revision: state.revision
    });
    await continueTurn(directory, goalID);
  }
  async function retry(directory, goalID) {
    const state = await readState(directory);
    const goal = state.goals.find((g) => g.id === goalID);
    if (!goal || goal.status !== "blocked")
      return;
    goal.status = "active";
    goal.updatedAt = new Date().toISOString();
    const runtime = state.runtimes.find((r) => r.goalID === goalID);
    if (runtime) {
      runtime.consecutiveFailures = 0;
      runtime.lastError = undefined;
      runtime.forceFinishRequested = undefined;
      runtime.lastParentNotifiedAt = undefined;
      runtime.lastParentNotifiedFor = undefined;
      runtime.phase = "idle";
      runtime.updatedAt = new Date().toISOString();
    }
    await writeState(directory, state);
    await appendEvent(directory, {
      version: 1,
      eventID: randomUUID4(),
      goalID,
      type: "goal.status_changed",
      from: "blocked",
      to: "active",
      timestamp: new Date().toISOString(),
      revision: state.revision
    });
    await continueTurn(directory, goalID);
  }
  async function clear(directory, goalID) {
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
    await appendEvent(directory, {
      version: 1,
      eventID: randomUUID4(),
      goalID,
      type: "goal.cleared",
      timestamp: new Date().toISOString(),
      revision: state.revision
    });
    state.goals = state.goals.filter((g) => g.id !== goalID);
    state.runtimes = state.runtimes.filter((r) => r.goalID !== goalID);
    await writeState(directory, state);
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
        try {
          const worker = await workers.createWorker(goal);
          sessions.set(goal.id, worker);
          goal.workerSessionID = worker.workerSessionID;
          goal.updatedAt = new Date().toISOString();
        } catch (error) {
          const detail = describeError(error);
          goal.status = "blocked";
          goal.updatedAt = new Date().toISOString();
          goal.blocker = {
            reason: detail,
            needed: "Clear this goal and start it again from a valid OpenCode session.",
            at: new Date().toISOString()
          };
          const runtime2 = state.runtimes.find((item) => item.goalID === goal.id);
          if (runtime2) {
            runtime2.phase = "idle";
            runtime2.lastError = detail;
            runtime2.updatedAt = new Date().toISOString();
          }
          await logServerEvent(directory, "goal.reconcile.failed", { goalID: goal.id, ownerSessionID: goal.ownerSessionID, detail });
          continue;
        }
      }
      if (goal.workerSessionID && !sessions.has(goal.id)) {
        sessions.set(goal.id, {
          goalID: goal.id,
          workerSessionID: goal.workerSessionID,
          startedAt: goal.createdAt
        });
      }
      const runtime = state.runtimes.find((r) => r.goalID === goal.id);
      if (runtime?.phase === "running" && !leaseIsValid(runtime)) {
        const session = sessions.get(goal.id);
        if (session && await workers.isIdle(session.workerSessionID)) {
          Object.assign(runtime, releaseLease(runtime));
          goal.updatedAt = new Date().toISOString();
        }
      }
    }
    await writeState(directory, state);
  }
  return { start, continueTurn, pause, resume, retry, clear, getWorker, getActiveWorkers, reconcile };
}

// src/server/host-adapter.ts
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
    async createWorker({ parentID, title, agent }) {
      try {
        const body = { parentID, title };
        if (agent)
          body.agent = agent;
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
    async promptWorker({ sessionID, prompt, model, agent }) {
      const body = {
        parts: [{ type: "text", text: prompt }]
      };
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
    },
    async sessionStatus(sessionID) {
      try {
        const result = await client.session.status({});
        const data = result?.data;
        if (!data || typeof data !== "object")
          return "idle";
        const status = data[sessionID];
        if (!status || typeof status !== "object")
          return "idle";
        const type = status.type;
        if (type === "busy" || type === "retry")
          return type;
        return "idle";
      } catch {
        return "idle";
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
        return data.map((m) => ({
          role: m.info?.role || "assistant",
          content: m.parts?.filter((p) => p.type === "text").map((p) => p.text).join(`
`) || "",
          timestamp: m.info?.time?.completed ? new Date(m.info.time.completed).toISOString() : undefined,
          messageID: m.id
        }));
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

// src/server/goal-tools.ts
init_state_repository();
import { randomUUID as randomUUID5 } from "crypto";
import { tool } from "@opencode-ai/plugin/tool";
import { exec as execChild } from "child_process";
import { promisify } from "util";
var execAsync = promisify(execChild);
function goalTools(dir, goalService, hostSessionID) {
  return {
    loopd_create_goal: tool({
      description: "Create a new background loop goal. The engine spawns a dedicated worker session " + "that does the work autonomously \u2014 it never runs in this chat. " + "Call this after clarifying the goal name, objective, and any config with the user. " + "The goal immediately starts in the background; the user can monitor it via /loop.",
      args: {
        name: tool.schema.string().describe("Short goal name (used in the dashboard)."),
        objective: tool.schema.string().describe("What the goal should accomplish, in detail."),
        checks: tool.schema.array(tool.schema.string()).optional().describe('Shell commands that must pass for completion to be accepted. E.g. ["npm test"].'),
        progressFile: tool.schema.string().optional().describe("Markdown file the worker reads/writes as its transaction state."),
        maxTurns: tool.schema.number().optional().describe("Max turns before auto-block."),
        maxNoProgress: tool.schema.number().optional().describe("Block after N turns without progress."),
        maxFailures: tool.schema.number().optional().describe("Block after N consecutive failures."),
        compactEvery: tool.schema.number().optional().describe("Compact the worker session every N turns."),
        timeoutMs: tool.schema.number().optional().describe("Per-turn timeout in ms."),
        agent: tool.schema.string().optional().describe('Agent to run the worker as (e.g. "dumb-agent", "build"). Defaults to primary agent.')
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
        if (args.checks)
          config.checks = args.checks;
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
        if (args.agent !== undefined)
          config.agent = args.agent;
        try {
          const { goal, worker } = await goalService.start(dir, {
            name: args.name,
            objective: args.objective,
            ownerSessionID: sessionID,
            config
          });
          return {
            title: "Goal created",
            output: JSON.stringify({
              ok: true,
              goalID: goal.id,
              workerSessionID: worker.workerSessionID,
              artifactDir: goal.config.artifactDir,
              name: args.name,
              message: `Goal "${args.name}" created and started in the background. Artifacts: ${goal.config.artifactDir}. Monitor with /loop (<leader>d).`
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
      description: "Get the current goal state. Call at the start of every continuation turn " + "to retrieve the objective, current state, acceptance criteria, and recent failures.",
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
      description: "Report meaningful progress on the current goal without completing it. " + "Call after durable state changes (file writes, verifications).",
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
            turn: runtime?.turnCount
          })
        };
      }
    }),
    complete_goal: tool({
      description: "Mark the current goal as completed. " + "Use only when all acceptance criteria pass with concrete evidence. " + "Runs configured completion checks before accepting.",
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
          const checkResults = await runCompletionChecks(goal.config.checks);
          if (!checkResults.passed) {
            const runtime2 = state.runtimes.find((r) => r.goalID === goal.id);
            if (runtime2) {
              runtime2.evaluatorRejectionCount = (runtime2.evaluatorRejectionCount || 0) + 1;
              if (runtime2.evaluatorRejectionCount >= 3) {
                runtime2.forceFinishRequested = true;
              } else {
                runtime2.forceFinishRequested = false;
                runtime2.turnCount = Math.max(0, runtime2.turnCount - 1);
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
                rejectionCount: runtime2?.evaluatorRejectionCount || 0
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
        const runtime = state.runtimes.find((r) => r.goalID === goal.id);
        if (runtime) {
          runtime.phase = "idle";
          runtime.lastError = undefined;
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
      description: "Mark the current goal as blocked. " + "Use only for a real external blocker requiring user intervention.",
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
        const runtime = state.runtimes.find((r) => r.goalID === goal.id);
        if (runtime) {
          runtime.phase = "idle";
          runtime.lastError = undefined;
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
      maxTurns: goal.config.maxTurns,
      maxNoProgress: goal.config.maxNoProgress,
      maxFailures: goal.config.maxFailures,
      compactEvery: goal.config.compactEvery,
      timeoutMs: goal.config.timeoutMs
    },
    lastProgress: goal.lastProgress,
    completionEvidence: goal.completionEvidence,
    blocker: goal.blocker,
    tokensUsed: goal.tokensUsed,
    timeUsedSeconds: goal.timeUsedSeconds
  };
  if (runtime) {
    output.runtime = {
      phase: runtime.phase,
      turnCount: runtime.turnCount,
      runCount: runtime.runCount,
      consecutiveFailures: runtime.consecutiveFailures,
      noProgressCount: runtime.noProgressCount,
      lastError: runtime.lastError,
      lastProgressAt: runtime.lastProgressAt,
      lastRunAt: runtime.lastRunAt,
      lastCompactAt: runtime.lastCompactAt
    };
  }
  return JSON.stringify(output, null, 2);
}
async function runCompletionChecks(checks) {
  const failures = [];
  for (const cmd of checks) {
    try {
      await execAsync(cmd, { timeout: 30000 });
    } catch (error) {
      failures.push({
        command: cmd,
        exitCode: error.code || 1,
        stderr: error.stderr || error.message || "unknown error"
      });
    }
  }
  return {
    passed: failures.length === 0,
    failures
  };
}

// src/server/owner-tools.ts
init_state_repository();
import { tool as tool2 } from "@opencode-ai/plugin/tool";
function ownerTools(options) {
  const { directory, host, goalService } = options;
  return {
    list_background_goals: tool2({
      description: "List all background loop goals visible to this session. " + "Shows name, status, progress, and whether any goal is waiting for user input.",
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
            turn: runtime?.turnCount ?? 0,
            lastProgress: g.lastProgress?.summary?.slice(0, 120),
            lastProgressAt: g.lastProgress?.at,
            blocker: g.blocker?.reason?.slice(0, 120)
          };
        });
        return {
          title: `${goals.length} active goal(s)`,
          output: JSON.stringify({ ok: true, goals: summaries }, null, 2)
        };
      }
    }),
    inspect_background_goal: tool2({
      description: "Inspect a background goal in detail: objective, contract, progress, " + "blockers, questions, runtime state, and recent events.",
      args: {
        goal_id: tool2.schema.string().optional().describe("Goal ID. Omit to inspect the first active goal.")
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
              checks: goal.config.checks
            },
            lastProgress: goal.lastProgress,
            completionEvidence: goal.completionEvidence,
            blocker: goal.blocker,
            tokensUsed: goal.tokensUsed,
            timeUsedSeconds: goal.timeUsedSeconds,
            runtime: runtime ? {
              phase: runtime.phase,
              turnCount: runtime.turnCount,
              runCount: runtime.runCount,
              consecutiveFailures: runtime.consecutiveFailures,
              lastError: runtime.lastError,
              lastProgressAt: runtime.lastProgressAt,
              lastRunAt: runtime.lastRunAt
            } : undefined
          }, null, 2)
        };
      }
    }),
    read_goal_transcript: tool2({
      description: "Read the last N messages from a goal's worker session transcript. " + "Shows what the worker has been doing: tool calls, file changes, responses.",
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
      description: "Send a message, instruction, or answer to a background goal's worker session. " + "The message will be injected into the worker's next continuation prompt. " + "Use this to answer worker questions, redirect work, or refine scope.",
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
      description: "Pause a background goal. The worker session is aborted and the goal stops running. " + "Use when you need to temporarily stop work (e.g., to investigate an issue or change priorities).",
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
      description: "Resume a paused or blocked background goal. " + "For paused goals, creates a new worker session if needed. " + "For blocked goals, resets failure count and retries.",
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
    clear_goal: tool2({
      description: "Clear a background goal. Aborts the worker and removes the goal from the dashboard. " + "This action cannot be undone. Use when the goal is no longer needed.",
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
var server = async ({ client, directory }) => {
  const host = createRealHost(client, directory);
  const goalService = createGoalService(host);
  const worker = createControlWorker({
    directory,
    goalService,
    pollIntervalMs: 1000
  });
  const engine = createLoopEngine({
    directory,
    host,
    goalService,
    pollIntervalMs: 30000
  });
  let started = false;
  let reconciliationStarted = false;
  function ensureStarted() {
    if (started)
      return;
    started = true;
    engine.start();
    worker.start();
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
    tool: { ...goalTools(directory, goalService), ...ownerTools({ directory, host, goalService }) },
    "tool.execute.after": async (input, output) => {
      if (input.tool === "loopd_create_goal" || input.tool === "get_goal" || input.tool === "report_goal_progress") {
        ensureStarted();
        reconcileInBackground();
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
          const { readState: readState2, writeState: writeState2 } = await Promise.resolve().then(() => (init_state_repository(), exports_state_repository));
          const { shouldNotifyParent: shouldNotifyParent2, markParentNotified: markParentNotified2 } = await Promise.resolve().then(() => exports_runtime);
          const state = await readState2(directory);
          const goal = state.goals.find((g) => g.id === goalID);
          if (!goal)
            return;
          const runtime = state.runtimes.find((r) => r.goalID === goalID);
          const notifyType = parsed.status === "complete" ? "complete" : "blocked";
          if (runtime && !shouldNotifyParent2(runtime, notifyType))
            return;
          if (runtime) {
            markParentNotified2(runtime, notifyType);
            await writeState2(directory, state);
          }
          const message = parsed.status === "complete" ? `Loop goal "${goal.name}" completed: ${parsed.summary || ""}. Evidence: ${parsed.evidence || ""}. Artifacts: ${goal.config.artifactDir || "n/a"}.` : `Loop goal "${goal.name}" blocked: ${parsed.reason || ""}. Needed: ${parsed.needed || ""}.`;
          await host.notifyOwner(goal.ownerSessionID, message);
        } catch {}
      }
    },
    dispose: async () => {
      engine.stop();
      await worker.stop();
    }
  };
};
var plugin_default = {
  id: PLUGIN_ID,
  server
};
export {
  plugin_default as default
};

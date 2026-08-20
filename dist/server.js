// @bun
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
async function writeState(directory, state) {
  state.revision += 1;
  const payload = JSON.stringify(state, null, 2);
  await writeAtomic(stateFile(directory), payload);
}
async function appendEvent(directory, event) {
  await fs.mkdir(loopDir(directory), { recursive: true });
  const line = JSON.stringify(event) + `
`;
  await fs.appendFile(eventsFile(directory), line, "utf8");
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
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
import { randomUUID } from "crypto";

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

// src/domain/runtime.ts
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
          eventID: randomUUID(),
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
    if (limitResult.blocked) {
      await writeState(directory, state);
      if (limitResult.event === "goal.blocked") {
        await appendEvent(directory, {
          version: 1,
          eventID: randomUUID(),
          goalID: goal.id,
          type: "goal.blocked",
          reason: limitResult.reason,
          needed: limitResult.reason,
          timestamp: new Date().toISOString(),
          revision: state.revision
        });
      } else {
        await appendEvent(directory, {
          version: 1,
          eventID: randomUUID(),
          goalID: goal.id,
          type: "goal.status_changed",
          from: "active",
          to: goal.status,
          timestamp: new Date().toISOString(),
          revision: state.revision
        });
      }
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
    const message = error?.message || error?.toString() || "unknown error";
    runtime.consecutiveFailures += 1;
    runtime.lastError = message;
    runtime.updatedAt = new Date().toISOString();
    if (runtime.phase === "running") {
      Object.assign(runtime, releaseLease(runtime));
    }
    await appendEvent(directory, {
      version: 1,
      eventID: randomUUID(),
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
        eventID: randomUUID(),
        goalID: goal.id,
        type: "goal.blocked",
        reason: `Failed ${runtime.consecutiveFailures} times`,
        needed: "User intervention required",
        timestamp: new Date().toISOString(),
        revision: state.revision
      });
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
      eventID: randomUUID(),
      goalID: goal.id,
      type: "compaction.completed",
      timestamp: new Date().toISOString(),
      revision: state.revision
    });
    return true;
  }
  function enforceLimits(goal, runtime) {
    const noResult = { blocked: false, event: "goal.status_changed", reason: "" };
    const maxTurns = goal.config?.maxTurns;
    if (maxTurns && runtime.turnCount >= maxTurns) {
      goal.status = "blocked";
      goal.updatedAt = new Date().toISOString();
      goal.blocker = {
        reason: `Reached max turns (${maxTurns})`,
        needed: "Use retry to reset turns and continue.",
        at: new Date().toISOString()
      };
      return {
        blocked: true,
        event: "goal.blocked",
        reason: `Reached max turns (${maxTurns})`
      };
    }
    const maxNoProgress = goal.config?.maxNoProgress;
    if (maxNoProgress && runtime.noProgressCount >= maxNoProgress) {
      goal.status = "blocked";
      goal.updatedAt = new Date().toISOString();
      goal.blocker = {
        reason: `No progress for ${runtime.noProgressCount} consecutive turns`,
        needed: "Use retry to reset and continue.",
        at: new Date().toISOString()
      };
      return {
        blocked: true,
        event: "goal.blocked",
        reason: `No progress for ${runtime.noProgressCount} consecutive turns`
      };
    }
    if (goal.tokenBudget && goal.tokensUsed >= goal.tokenBudget) {
      goal.status = "budget_limited";
      goal.updatedAt = new Date().toISOString();
      return {
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
      eventID: randomUUID(),
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
      if (runtime.phase === "running" && goal.workerSessionID) {
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
import { randomUUID as randomUUID2 } from "crypto";

// src/server/worker-session.ts
var CONTINUATION_PROMPT = `You are a worker for an active goal.

Call get_goal to retrieve the authoritative objective, current state, acceptance criteria, and recent failures. Perform one meaningful batch of work. After durable verification:

- Call report_goal_progress if work remains.
- Call complete_goal only if all acceptance criteria pass with concrete evidence.
- Call block_goal only for a real external blocker requiring user intervention.

Do not ask questions. Make reasonable assumptions. Work directly.`;
function createWorkerManager(host) {
  return {
    async createWorker(goal) {
      const workerSessionID = await host.createWorker({
        parentID: goal.ownerSessionID,
        title: `loopd: ${goal.name}`
      });
      return {
        goalID: goal.id,
        workerSessionID,
        startedAt: new Date().toISOString()
      };
    },
    async continueWorker(worker, goal, runtime) {
      const prompt = buildContinuationPrompt(goal, runtime);
      await host.promptWorker({
        sessionID: worker.workerSessionID,
        prompt
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
function buildContinuationPrompt(goal, runtime) {
  const parts = [CONTINUATION_PROMPT];
  if (runtime.turnCount > 1) {
    parts.push(`
This is turn ${runtime.turnCount}.`);
  }
  if (runtime.consecutiveFailures > 0) {
    parts.push(`
Warning: ${runtime.consecutiveFailures} consecutive failure(s). Last error: ${runtime.lastError || "unknown"}.`);
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
    const id = randomUUID2();
    const goal = createGoal({
      id,
      name: input.name,
      objective: input.objective,
      status: "active",
      ownerSessionID: input.ownerSessionID,
      config: input.config || {}
    });
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
        eventID: randomUUID2(),
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
      eventID: randomUUID2(),
      goalID: id,
      type: "goal.created",
      name: input.name,
      objective: input.objective,
      ownerSessionID: input.ownerSessionID,
      timestamp: new Date().toISOString(),
      revision: state.revision
    });
    if (runtime) {
      const runID = randomUUID2();
      Object.assign(runtime, acquireLease(runtime, goal.config.timeoutMs || 300000));
      runtime.activeRunID = runID;
      runtime.turnCount = 1;
      runtime.runCount = 1;
      runtime.lastRunAt = new Date().toISOString();
      await writeState(directory, state);
      await appendEvent(directory, {
        version: 1,
        eventID: randomUUID2(),
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
  async function continueTurn(directory, goalID) {
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
    const runID = randomUUID2();
    runtime.activeRunID = runID;
    runtime.turnCount += 1;
    runtime.runCount += 1;
    runtime.lastRunAt = new Date().toISOString();
    await writeState(directory, state);
    await appendEvent(directory, {
      version: 1,
      eventID: randomUUID2(),
      goalID,
      type: "run.started",
      runID,
      turnCount: runtime.turnCount,
      timestamp: new Date().toISOString(),
      revision: state.revision
    });
    await workers.continueWorker(session, goal, runtime);
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
      eventID: randomUUID2(),
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
      eventID: randomUUID2(),
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
      runtime.phase = "idle";
      runtime.updatedAt = new Date().toISOString();
    }
    await writeState(directory, state);
    await appendEvent(directory, {
      version: 1,
      eventID: randomUUID2(),
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
      eventID: randomUUID2(),
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
function createRealHost(client, directory) {
  return {
    async createWorker({ parentID, title }) {
      try {
        const result = await withTimeout(client.session.create({ body: { parentID, title } }), 1e4, "OpenCode session.create");
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
import { randomUUID as randomUUID3 } from "crypto";
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
        timeoutMs: tool.schema.number().optional().describe("Per-turn timeout in ms.")
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
        const config = {};
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
              name: args.name,
              message: `Goal "${args.name}" created and started in the background. Monitor with /loop (Ctrl+Alt+L).`
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
          eventID: randomUUID3(),
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
            return {
              title: "Checks failed",
              output: JSON.stringify({
                passed: false,
                failedChecks: checkResults.failures,
                message: "Completion checks failed. Fix issues and try again."
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
          eventID: randomUUID3(),
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
          eventID: randomUUID3(),
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
    tool: goalTools(directory, goalService),
    "tool.execute.after": async (input, output) => {
      if (input.tool === "loopd_create_goal" || input.tool === "get_goal" || input.tool === "report_goal_progress") {
        ensureStarted();
        reconcileInBackground();
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

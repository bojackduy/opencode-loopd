// @bun
// src/infrastructure/state-store.ts
import { promises as fs } from "fs";
import path from "path";
import os from "os";
var STATE_VERSION = 1;
function emptyState() {
  return { version: STATE_VERSION, revision: 0, goals: [], runtimes: [] };
}
var EMPTY_STATE = emptyState();
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
        return parsed;
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
async function writeAtomic(target, contents) {
  const dir = path.dirname(target);
  await fs.mkdir(dir, { recursive: true });
  const temp = path.join(os.tmpdir(), `loopd-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`);
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
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// src/application/control-service.ts
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
    createdAt: now,
    updatedAt: now
  };
}
function acquireLease(rt, timeoutMs) {
  const now = Date.now();
  const expires = new Date(now + timeoutMs).toISOString();
  return { ...rt, phase: "running", leaseExpiresAt: expires, updatedAt: new Date(now).toISOString() };
}
function releaseLease(rt) {
  return { ...rt, phase: "idle", leaseExpiresAt: undefined, updatedAt: new Date().toISOString() };
}
function leaseIsValid(rt) {
  if (!rt.leaseExpiresAt)
    return false;
  return Date.now() < Date.parse(rt.leaseExpiresAt);
}

// src/application/control-service.ts
function createControlService() {
  const locks = new Map;
  async function withLock(key, fn) {
    const prev = locks.get(key) || Promise.resolve();
    let release;
    const current = new Promise((r) => {
      release = r;
    });
    const next = prev.catch(() => {}).then(() => current);
    locks.set(key, next);
    await prev.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      if (locks.get(key) === next)
        locks.delete(key);
    }
  }
  async function execute(directory, command) {
    return withLock(directory, async () => {
      const state = await readState(directory);
      try {
        switch (command.command) {
          case "start":
            return await handleStart(directory, state, command);
          case "pause":
            return await handleTransition(directory, state, command, "paused", "user");
          case "resume":
            return await handleTransition(directory, state, command, "active", "user");
          case "retry":
            return await handleRetry(directory, state, command);
          case "clear":
            return await handleClear(directory, state, command);
          case "update":
            return await handleUpdate(directory, state, command);
          case "inspect":
            return { ok: true, requestID: command.requestID, message: "inspect not yet implemented" };
          case "open_worker":
            return { ok: true, requestID: command.requestID, message: "open_worker not yet implemented" };
          case "compact":
            return { ok: true, requestID: command.requestID, message: "compact not yet implemented" };
          default: {
            const req = command;
            return {
              ok: false,
              requestID: req.requestID,
              message: `unknown command: ${req.command}`,
              errorCode: "unknown_command"
            };
          }
        }
      } finally {
        await writeState(directory, state);
      }
    });
  }
  async function handleStart(directory, state, cmd) {
    const id = randomUUID();
    const existing = state.goals.find((g) => g.name === cmd.args.name && g.status !== "complete" && g.status !== "paused");
    if (existing) {
      return {
        ok: false,
        requestID: cmd.requestID,
        message: `goal "${cmd.args.name}" already exists (${existing.status})`,
        errorCode: "goal_exists"
      };
    }
    const goal = createGoal({
      id,
      name: cmd.args.name,
      objective: cmd.args.objective,
      status: "active",
      ownerSessionID: "main",
      config: cmd.args.config
    });
    state.goals.push(goal);
    state.runtimes.push(createRuntimeState(id));
    const event = {
      version: 1,
      eventID: randomUUID(),
      goalID: id,
      type: "goal.created",
      name: cmd.args.name,
      objective: cmd.args.objective,
      timestamp: new Date().toISOString(),
      revision: state.revision
    };
    await appendEvent(directory, event);
    return {
      ok: true,
      requestID: cmd.requestID,
      message: `goal "${cmd.args.name}" created and active`,
      stateRevision: state.revision
    };
  }
  async function handleTransition(directory, state, cmd, target, caller) {
    const goal = findGoal(state, cmd.goalID);
    if (!goal) {
      return { ok: false, requestID: cmd.requestID, message: "goal not found", errorCode: "goal_not_found" };
    }
    if (!canTransition(goal.status, target, caller)) {
      return {
        ok: false,
        requestID: cmd.requestID,
        message: `cannot transition from ${goal.status} to ${target} (caller: ${caller})`,
        errorCode: "invalid_transition"
      };
    }
    const from = goal.status;
    goal.status = target;
    goal.updatedAt = new Date().toISOString();
    const event = {
      version: 1,
      eventID: randomUUID(),
      goalID: goal.id,
      type: "goal.status_changed",
      from,
      to: target,
      timestamp: new Date().toISOString(),
      revision: state.revision
    };
    await appendEvent(directory, event);
    return {
      ok: true,
      requestID: cmd.requestID,
      message: `goal "${goal.name}" ${target}`,
      stateRevision: state.revision
    };
  }
  async function handleRetry(directory, state, cmd) {
    const goal = findGoal(state, cmd.goalID);
    if (!goal) {
      return { ok: false, requestID: cmd.requestID, message: "goal not found", errorCode: "goal_not_found" };
    }
    if (goal.status !== "blocked") {
      return { ok: false, requestID: cmd.requestID, message: "can only retry blocked goals", errorCode: "invalid_transition" };
    }
    goal.status = "active";
    goal.updatedAt = new Date().toISOString();
    const runtime = findRuntime(state, goal.id);
    if (runtime) {
      runtime.consecutiveFailures = 0;
      runtime.lastError = undefined;
      runtime.phase = "idle";
      runtime.updatedAt = new Date().toISOString();
    }
    const event = {
      version: 1,
      eventID: randomUUID(),
      goalID: goal.id,
      type: "goal.status_changed",
      from: "blocked",
      to: "active",
      timestamp: new Date().toISOString(),
      revision: state.revision
    };
    await appendEvent(directory, event);
    return { ok: true, requestID: cmd.requestID, message: `goal "${goal.name}" retried`, stateRevision: state.revision };
  }
  async function handleClear(directory, state, cmd) {
    const goal = findGoal(state, cmd.goalID);
    if (!goal) {
      return { ok: false, requestID: cmd.requestID, message: "goal not found", errorCode: "goal_not_found" };
    }
    const event = {
      version: 1,
      eventID: randomUUID(),
      goalID: goal.id,
      type: "goal.cleared",
      timestamp: new Date().toISOString(),
      revision: state.revision
    };
    await appendEvent(directory, event);
    state.goals = state.goals.filter((g) => g.id !== goal.id);
    state.runtimes = state.runtimes.filter((r) => r.goalID !== goal.id);
    return { ok: true, requestID: cmd.requestID, message: `goal "${goal.name}" cleared`, stateRevision: state.revision };
  }
  async function handleUpdate(directory, state, cmd) {
    const goal = findGoal(state, cmd.goalID);
    if (!goal) {
      return { ok: false, requestID: cmd.requestID, message: "goal not found", errorCode: "goal_not_found" };
    }
    if (cmd.args.objective !== undefined)
      goal.objective = cmd.args.objective;
    if (cmd.args.config !== undefined) {
      goal.config = { ...goal.config, ...cmd.args.config };
    }
    goal.updatedAt = new Date().toISOString();
    return { ok: true, requestID: cmd.requestID, message: `goal "${goal.name}" updated`, stateRevision: state.revision };
  }
  function findGoal(state, id) {
    if (id)
      return state.goals.find((g) => g.id === id);
    return state.goals.find((g) => g.status === "active" || g.status === "blocked");
  }
  function findRuntime(state, goalID) {
    return state.runtimes.find((r) => r.goalID === goalID);
  }
  return { execute };
}

// src/application/goal-service.ts
import { randomUUID as randomUUID2 } from "crypto";

// src/server/worker-session.ts
var CONTINUATION_PROMPT = `You are a worker for an active goal.

Call get_goal to retrieve the authoritative objective, current state, acceptance criteria, and recent failures. Perform one meaningful batch of work. After durable verification:

- Call report_goal_progress if work remains.
- Call update_goal with status "complete" only if all acceptance criteria pass with concrete evidence.
- Call update_goal with status "blocked" only for a real external blocker requiring user intervention.

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
    }
  };
}
function buildContinuationPrompt(goal, runtime) {
  const parts = [CONTINUATION_PROMPT];
  if (runtime.turnCount > 0) {
    parts.push(`
This is turn ${runtime.turnCount + 1}.`);
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
    const worker = await workers.createWorker(goal);
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
      timestamp: new Date().toISOString(),
      revision: state.revision
    });
    const runtime = state.runtimes.find((r) => r.goalID === id);
    if (runtime) {
      runtime.turnCount = 1;
      runtime.lastRunAt = new Date().toISOString();
      runtime.phase = "running";
      await writeState(directory, state);
      await workers.continueWorker(worker, goal, runtime);
    }
    return { goal, worker };
  }
  async function continueTurn(directory, goalID) {
    const state = await readState(directory);
    const goal = state.goals.find((g) => g.id === goalID);
    if (!goal || goal.status !== "active")
      return;
    const runtime = state.runtimes.find((r) => r.goalID === goalID);
    if (!runtime)
      return;
    if (runtime.phase === "running" && leaseIsValid(runtime))
      return;
    const session = sessions.get(goalID);
    if (session && !await workers.isIdle(session.workerSessionID))
      return;
    const timeoutMs = goal.config.timeoutMs || 300000;
    const leased = acquireLease(runtime, timeoutMs);
    Object.assign(runtime, leased);
    runtime.turnCount += 1;
    runtime.lastRunAt = new Date().toISOString();
    await writeState(directory, state);
    if (session) {
      await workers.continueWorker(session, goal, runtime);
    }
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
    const session = sessions.get(goalID);
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
    if (!sessions.has(goalID)) {
      const worker = await workers.createWorker(goal);
      sessions.set(goalID, worker);
      goal.workerSessionID = worker.workerSessionID;
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
    const session = sessions.get(goalID);
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
  return { start, continueTurn, pause, resume, retry, clear };
}

// src/application/control-worker.ts
function createControlWorker(options) {
  const directory = options.directory;
  const pollMs = options.pollIntervalMs ?? 500;
  const goalSvc = createGoalService(options.host);
  let running = false;
  let pollTimer;
  let processing = new Set;
  function start() {
    if (running)
      return;
    running = true;
    recoverStaleProcessing(directory).catch(() => {});
    pollTimer = setInterval(() => {
      if (running)
        processPending();
    }, pollMs);
  }
  function stop() {
    running = false;
    if (pollTimer)
      clearInterval(pollTimer);
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
        const response = {
          requestID: request.requestID,
          ok: false,
          message: `internal error: ${error instanceof Error ? error.message : String(error)}`,
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
    const base = {
      requestID: request.requestID,
      ok: true,
      message: "",
      stateRevision: undefined,
      errorCode: undefined,
      completedAt: new Date().toISOString()
    };
    switch (request.command) {
      case "start": {
        const args = request.args;
        const { goal } = await goalSvc.start(directory, {
          name: args.name,
          objective: args.objective,
          ownerSessionID: "main",
          config: args.config
        });
        const state = await readState(directory);
        return {
          ...base,
          message: `goal "${args.name}" created (${goal.id.slice(0, 8)}...)`,
          stateRevision: state.revision
        };
      }
      case "pause": {
        await goalSvc.pause(directory, request.goalID);
        const state = await readState(directory);
        const goal = state.goals.find((g) => g.id === request.goalID);
        return {
          ...base,
          message: `goal "${goal?.name || request.goalID}" paused`,
          stateRevision: state.revision
        };
      }
      case "resume": {
        await goalSvc.resume(directory, request.goalID);
        const state = await readState(directory);
        const goal = state.goals.find((g) => g.id === request.goalID);
        return {
          ...base,
          message: `goal "${goal?.name || request.goalID}" resumed`,
          stateRevision: state.revision
        };
      }
      case "retry": {
        await goalSvc.retry(directory, request.goalID);
        const state = await readState(directory);
        const goal = state.goals.find((g) => g.id === request.goalID);
        return {
          ...base,
          message: `goal "${goal?.name || request.goalID}" retried`,
          stateRevision: state.revision
        };
      }
      case "clear": {
        await goalSvc.clear(directory, request.goalID);
        const state = await readState(directory);
        return {
          ...base,
          message: `goal cleared`,
          stateRevision: state.revision
        };
      }
      default: {
        const cmd = buildBasicCommand(request);
        const svc = createControlService();
        const result = await svc.execute(directory, cmd);
        return {
          requestID: request.requestID,
          ok: result.ok,
          message: result.message,
          stateRevision: result.stateRevision,
          errorCode: result.errorCode,
          completedAt: new Date().toISOString()
        };
      }
    }
  }
  function buildBasicCommand(request) {
    const base = {
      version: 1,
      requestID: request.requestID,
      requestedAt: request.requestedAt
    };
    switch (request.command) {
      case "update":
        return { ...base, command: "update", goalID: request.goalID, args: request.args };
      case "inspect":
        return { ...base, command: "inspect", args: request.args };
      case "open_worker":
        return { ...base, command: "open_worker" };
      case "compact":
        return { ...base, command: "compact" };
      default:
        return { ...base, command: request.command };
    }
  }
  return { start, stop, isRunning: () => running };
}

// src/server/host-adapter.ts
function createRealHost(client) {
  return {
    async createWorker({ parentID, title }) {
      const result = await client.session.create({
        body: { parentID, title }
      });
      const data = result?.data;
      if (!data?.id)
        throw new Error("failed to create worker session");
      return data.id;
    },
    async promptWorker({ sessionID, prompt, model, agent }) {
      const body = {
        parts: [{ type: "text", text: prompt }]
      };
      if (model)
        body.model = model;
      if (agent)
        body.agent = agent;
      await client.session.promptAsync({
        path: { id: sessionID },
        body
      });
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
        return status.type || "idle";
      } catch {
        return "idle";
      }
    },
    async abortSession(sessionID) {
      await client.session.abort({ path: { id: sessionID } });
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
          timestamp: m.info?.time?.completed ? new Date(m.info.time.completed).toISOString() : undefined
        }));
      } catch {
        return [];
      }
    }
  };
}

// src/server/goal-tools.ts
import { randomUUID as randomUUID3 } from "crypto";
import { tool } from "@opencode-ai/plugin/tool";
function goalTools(dir, hostSessionID) {
  return {
    get_goal: tool({
      description: "Get the current goal state. Call at the start of every continuation turn " + "to retrieve the objective, current state, acceptance criteria, and recent failures.",
      args: {},
      execute: async (_args, context) => {
        const state = await readState(dir);
        const workerID = context?.sessionID || hostSessionID;
        const goal = findGoalBySession(state, workerID);
        if (!goal) {
          return {
            title: "No active goal",
            output: JSON.stringify({
              status: "none",
              message: "No active goal found for this session."
            })
          };
        }
        const runtime = state.runtimes.find((r) => r.goalID === goal.id);
        return {
          title: `Goal: ${goal.name}`,
          output: formatGoalForModel(goal, runtime)
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
        const goal = findGoalBySession(state, workerID);
        if (!goal) {
          return { title: "No goal", output: "No active goal to report progress for." };
        }
        const runtime = state.runtimes.find((r) => r.goalID === goal.id);
        if (runtime) {
          runtime.noProgressCount = 0;
          runtime.lastProgressAt = new Date().toISOString();
          runtime.consecutiveFailures = 0;
          await writeState(dir, state);
        }
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
          output: `Progress on "${goal.name}": ${args.summary}
Next: ${args.next}`
        };
      }
    }),
    update_goal: tool({
      description: "Mark the current goal as completed or blocked. " + "Use complete only when all acceptance criteria pass with concrete evidence. " + "Use blocked only for a real external blocker requiring user intervention.",
      args: {
        status: tool.schema.enum(["complete", "blocked"]).describe("Terminal status."),
        summary: tool.schema.string().describe("What was completed or why blocked."),
        evidence: tool.schema.string().describe("Concrete evidence."),
        needed: tool.schema.string().describe("For blocked: what is needed to unblock.")
      },
      execute: async (args, context) => {
        const state = await readState(dir);
        const workerID = context?.sessionID || hostSessionID;
        const goal = findGoalBySession(state, workerID);
        if (!goal) {
          return { title: "No goal", output: "No active goal to update." };
        }
        const from = goal.status;
        goal.status = args.status;
        goal.updatedAt = new Date().toISOString();
        const runtime = state.runtimes.find((r) => r.goalID === goal.id);
        if (runtime) {
          runtime.phase = "idle";
          runtime.lastError = undefined;
          runtime.updatedAt = new Date().toISOString();
        }
        await writeState(dir, state);
        const event = {
          version: 1,
          eventID: randomUUID3(),
          goalID: goal.id,
          type: args.status === "complete" ? "goal.completed" : "goal.blocked",
          ...args.status === "complete" ? { summary: args.summary, evidence: args.evidence || "" } : { reason: args.summary, needed: args.needed || "" },
          timestamp: new Date().toISOString(),
          revision: state.revision
        };
        await appendEvent(dir, event);
        return {
          title: `Goal ${args.status}`,
          output: `Goal "${goal.name}" marked as ${args.status}.
Summary: ${args.summary}
Evidence: ${args.evidence || "none"}`
        };
      }
    })
  };
}
function findGoalBySession(state, sessionID) {
  if (!sessionID) {
    return state.goals.find((g) => g.status === "active" || g.status === "blocked");
  }
  const byWorker = state.goals.find((g) => g.workerSessionID === sessionID && (g.status === "active" || g.status === "blocked"));
  if (byWorker)
    return byWorker;
  return state.goals.find((g) => g.ownerSessionID === sessionID && (g.status === "active" || g.status === "blocked"));
}
function formatGoalForModel(goal, runtime) {
  const lines = [
    `Goal: ${goal.name}`,
    `Objective: ${goal.objective}`,
    `Status: ${goal.status}`
  ];
  if (goal.config.progressFile) {
    lines.push(`Progress file: ${goal.config.progressFile}`);
  }
  if (goal.config.checks?.length) {
    lines.push(`Checks: ${goal.config.checks.join(", ")}`);
  }
  if (runtime) {
    lines.push(`Turn: ${runtime.turnCount}`);
    lines.push(`Failures: ${runtime.consecutiveFailures}`);
    if (runtime.lastError) {
      lines.push(`Last error: ${runtime.lastError}`);
    }
  }
  return lines.join(`
`);
}

// src/server/plugin.ts
var PLUGIN_ID = "opencode-loopd.server";
var worker;
var server = async ({ client, directory }) => {
  const host = createRealHost(client);
  worker = createControlWorker({
    directory,
    host,
    pollIntervalMs: 500
  });
  worker.start();
  return {
    event: async ({ event }) => {},
    tool: goalTools(directory),
    "tool.execute.after": async (input, output) => {},
    dispose: async () => {
      worker?.stop();
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

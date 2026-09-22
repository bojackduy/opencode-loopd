// ─── Server Plugin Entry ─────────────────────────────────────────────────────
// The engine. Hooks, tools, control worker, goal tools, event handling.
// Starts lazily: no timers, no polling, no disk reads until a goal exists.

import type { Hooks, Plugin, PluginModule } from "@opencode-ai/plugin"
import { tool as v1Tool, type ToolDefinition } from "@opencode-ai/plugin/tool"
import type { Plugin as V2Plugin } from "@opencode/plugin"
import { createControlWorker } from "../application/control-worker"
import { createLoopEngine } from "../application/loop-engine"
import { createGoalService } from "../application/goal-service"
import { createScheduleWorker } from "../application/schedule-worker"
import { createRealHost, createV2Host, type LoopHost, type SessionStatusType } from "./host-adapter"
import { goalTools } from "./goal-tools"
import { ownerTools } from "./owner-tools"
import { describeError, logServerEvent } from "../infrastructure/server-log"
import { addToolCall, removeToolCall } from "../domain/runtime"
import { readState, mutateState } from "../infrastructure/state-repository"
import type { GoalToolDefaults } from "./goal-tools"
import { version as PLUGIN_VERSION } from "../../package.json"

const PLUGIN_ID = "opencode-loopd.server"

const server: Plugin = async ({ client, directory }, pluginOptions) => {
  const defaults = parsePluginDefaults(pluginOptions)
  const host = createRealHost(client, directory)
  // Staleness marker: an already-running host keeps old code after a rebuild,
  // so log the loaded build at setup. If the live log shows an older version
  // than the tree, restart/reload the host process before testing.
  void logServerEvent(directory, "plugin.loaded", { pluginID: PLUGIN_ID, host: "v1", version: PLUGIN_VERSION })
  return createServerHooks(directory, host, defaults)
}

function createServerHooks(directory: string, host: LoopHost, defaults: GoalToolDefaults): Hooks {
  const goalService = createGoalService(host)

  const worker = createControlWorker({
    directory,
    goalService,
    pollIntervalMs: 1_000,
    defaults,
  })

  const engine = createLoopEngine({
    directory,
    host,
    goalService,
    pollIntervalMs: 30_000,
  })

  const scheduleWorker = createScheduleWorker({
    directory,
    goalService,
    intervalMs: 5_000,
  })

  // Start lazily: only when first event arrives or goal is created
  let started = false
  let reconciliationStarted = false
  function ensureStarted() {
    if (started) return
    started = true
    engine.start()
    worker.start()
    scheduleWorker.start()
  }

  function reconcileInBackground() {
    if (reconciliationStarted) return
    reconciliationStarted = true
    void logServerEvent(directory, "reconcile.started")
    void goalService.reconcile(directory).then(
      () => logServerEvent(directory, "reconcile.completed"),
      (error) => logServerEvent(directory, "reconcile.failed", { detail: describeError(error) }),
    )
  }

  return {
    event: async ({ event }) => {
      // Lazy start on first relevant event
      const type = (event as any)?.type as string | undefined
      if (type?.startsWith("session.")) {
        ensureStarted()
      }

      // Route through engine (engine filters by type before disk I/O)
      await engine.handleEvent(event)
      if (type?.startsWith("session.")) reconcileInBackground()
    },
    tool: { ...goalTools(directory, goalService, undefined, defaults, host), ...ownerTools({ directory, host, goalService }) },
    "tool.execute.before": async (input, _output) => {
      // Track tool call start for worker sessions only
      const activeWorkers = goalService.getActiveWorkers()
      let matchedGoalID: string | undefined
      for (const [goalID, worker] of activeWorkers) {
        if (worker.workerSessionID === input.sessionID) {
          matchedGoalID = goalID
          break
        }
      }
      if (!matchedGoalID) return

      try {
        await mutateState(directory, `tool-call.start:${matchedGoalID}:${input.callID}`, async (s) => {
          const runtime = s.runtimes.find((r) => r.goalID === matchedGoalID)
          if (runtime) Object.assign(runtime, addToolCall(runtime, input.callID))
          return s
        })
      } catch {}
    },
    "tool.execute.after": async (input, output) => {
      // Lazy start when goal tools are used
      if (input.tool === "loopd_create_goal" || input.tool === "get_goal" || input.tool === "report_goal_progress") {
        ensureStarted()
        reconcileInBackground()
      }

      // Track tool call end for worker sessions only
      const activeWorkers = goalService.getActiveWorkers()
      let matchedGoalID: string | undefined
      for (const [goalID, worker] of activeWorkers) {
        if (worker.workerSessionID === input.sessionID) {
          matchedGoalID = goalID
          break
        }
      }
      if (matchedGoalID) {
        try {
          await mutateState(directory, `tool-call.end:${matchedGoalID}:${input.callID}`, async (s) => {
            const runtime = s.runtimes.find((r) => r.goalID === matchedGoalID)
            if (runtime) Object.assign(runtime, removeToolCall(runtime, input.callID))
            return s
          })
        } catch {}
      }

      // Forward terminal worker events to the parent session (deduped)
      if (input.tool === "complete_goal" || input.tool === "block_goal") {
        try {
          const raw = (output as any)?.output as string | undefined
          if (!raw) return
          const parsed = JSON.parse(raw) as any
          if (parsed.status !== "complete" && parsed.status !== "blocked") return
          const goalID = parsed.goalID as string | undefined
          if (!goalID) return
          const { shouldNotifyParent, markParentNotified } = await import("../domain/runtime")
          const state = await readState(directory)
          const goal = state.goals.find((g) => g.id === goalID)
          if (!goal) return
          const runtime = state.runtimes.find((r) => r.goalID === goalID)
          const notifyType = parsed.status === "complete" ? ("complete" as const) : ("blocked" as const)
          if (runtime && !shouldNotifyParent(runtime, notifyType)) return
          if (runtime) {
            await mutateState(directory, `notify-parent:${goalID}`, async (s) => {
              const rt = s.runtimes.find((r) => r.goalID === goalID)
              if (rt) markParentNotified(rt, notifyType)
              return s
            })
          }
          const message =
            parsed.status === "complete"
              ? `Loop goal "${goal.name}" completed: ${parsed.summary || ""}. Evidence: ${parsed.evidence || ""}. Artifacts: ${goal.config.artifactDir || "n/a"}.`
              : `Loop goal "${goal.name}" blocked: ${parsed.reason || ""}. Needed: ${parsed.needed || ""}.`
          await host.notifyOwner(goal.ownerSessionID, message, goal.parentAgent)
        } catch {}
      }
    },
    dispose: async () => {
      engine.stop()
      await worker.stop()
      scheduleWorker.stop()
    },
  }
}

function parsePluginDefaults(options: Record<string, unknown> | undefined): GoalToolDefaults {
  const agent = typeof options?.defaultAgent === "string" ? options.defaultAgent.trim() : ""
  const model = typeof options?.defaultModel === "string" ? options.defaultModel.trim() : ""
  const checks = Array.isArray(options?.defaultChecks)
    ? options.defaultChecks
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean)
    : []
  return {
    defaultAgent: agent || undefined,
    defaultModel: model || undefined,
    defaultChecks: checks.length > 0 ? checks : undefined,
  }
}

// ─── V2 (opencode v2 core) ───────────────────────────────────────────────────

const v2 = {
  id: PLUGIN_ID,
  async setup(context: V2Plugin.Context) {
    const directory = context.location.directory
    // Same staleness marker as the v1 path above: proves the running v2 host
    // actually loaded this build (rebuild alone never reloads a live process).
    void logServerEvent(directory, "plugin.loaded", { pluginID: PLUGIN_ID, host: "v2", version: PLUGIN_VERSION })
    const statuses = new Map<string, SessionStatusType>()
    const host = createV2Host(context, statuses)
    const hooks = createServerHooks(directory, host, parsePluginDefaults(context.options))
    const registrations: Array<{ dispose(): Promise<void> }> = []
    const eventController = new AbortController()
    let eventTask = Promise.resolve()
    let disposed = false

    const cleanup = async () => {
      if (disposed) return
      disposed = true
      eventController.abort()
      await eventTask
      try {
        await Promise.allSettled(registrations.reverse().map((registration) => registration.dispose()))
      } finally {
        await hooks.dispose?.()
      }
    }

    try {
      registrations.push(await context.tool.transform((editor) => {
        for (const [id, definition] of Object.entries(hooks.tool ?? {})) {
          editor.add(toV2Tool(id, definition, directory))
        }
      }))
      registrations.push(await context.tool.hook("execute.before", async (input) => {
        await hooks["tool.execute.before"]?.({
          tool: input.tool,
          sessionID: input.sessionID,
          callID: input.id,
        }, { args: input.input })
      }))
      registrations.push(await context.tool.hook("execute.after", async (input) => {
        const output = input.status === "completed" ? input.result : { content: JSON.stringify(input.error) }
        await hooks["tool.execute.after"]?.({
          tool: input.tool,
          sessionID: input.sessionID,
          callID: input.id,
          args: input.input,
        }, {
          title: "",
          output: typeof output.content === "string" ? output.content : JSON.stringify(output.content ?? ""),
          metadata: output.metadata ?? {},
        })
      }))

      eventTask = consumeV2Events(context, eventController.signal, statuses, hooks).catch(async (error) => {
        if (!eventController.signal.aborted) {
          await logServerEvent(directory, "events.failed", { detail: describeError(error) })
        }
      })
      return cleanup
    } catch (error) {
      await cleanup()
      throw error
    }
  },
} satisfies V2Plugin.Plugin

function toV2Tool(id: string, definition: ToolDefinition, directory: string) {
  return {
    name: id,
    description: definition.description,
    input: v1Tool.schema.object(definition.args),
    async execute(input: unknown, context: { sessionID: string; agent: string; messageID: string; id: string }) {
      const result = await definition.execute(input as never, {
        sessionID: context.sessionID,
        agent: context.agent,
        messageID: context.messageID,
        directory,
        worktree: directory,
        abort: new AbortController().signal,
        metadata() {},
        async ask() {},
      })
      if (typeof result === "string") return { content: result }
      return {
        content: result.output,
        metadata: {
          ...result.metadata,
          ...(result.title ? { title: result.title } : {}),
        },
      }
    },
  }
}

async function consumeV2Events(
  context: V2Plugin.Context,
  signal: AbortSignal,
  statuses: Map<string, SessionStatusType>,
  hooks: Hooks,
) {
  for await (const event of context.event.subscribe({ signal })) {
    const data = "data" in event && event.data && typeof event.data === "object" ? event.data as Record<string, any> : {}
    const sessionID = typeof data.sessionID === "string" ? data.sessionID : undefined
    if (sessionID) {
      if (event.type === "session.status") statuses.set(sessionID, data.status?.type ?? "unknown")
      else if (event.type === "session.idle") statuses.set(sessionID, "idle")
      else if (event.type === "session.execution.started") statuses.set(sessionID, "busy")
    }
    await hooks.event?.({ event: normalizeV2Event(event) as any })
  }
}

// Exported for tests: the v2→engine event contract is load-bearing for
// worker correlation (delivery/completion anchors).
export function normalizeV2Event(event: any) {
  const properties = event?.data && typeof event.data === "object" ? event.data : {}
  if (event?.type === "session.compaction.ended") return { type: "session.compacted", properties }
  if (event?.type === "session.execution.failed") return { type: "session.error", properties }
  if (event?.type === "session.execution.succeeded") return { type: "session.execution.succeeded", properties }
  if (event?.type === "session.inbox.delivered") {
    // Delivery confirmation carries the prompt's message ID (inboxID).
    // Shape it as an observed user prompt so the engine correlates it with
    // the active turn exactly like a v1 message.updated event.
    return {
      type: "message.updated",
      properties: {
        sessionID: properties.sessionID,
        info: { role: "user", id: properties.inboxID },
      },
    }
  }
  if (event?.type === "session.message.content.updated") {
    return {
      type: "message.part.updated",
      properties: {
        sessionID: properties.sessionID,
        part: { messageID: properties.messageID },
      },
    }
  }
  return { type: event?.type, properties }
}

export default {
  id: PLUGIN_ID,
  server,
  setup: v2.setup,
} satisfies PluginModule & V2Plugin.Plugin

// ─── Infrastructure: State Store ─────────────────────────────────────────────
// Atomic, revisioned JSON persistence for goal + runtime state.

import { promises as fs } from "fs"
import path from "path"
import os from "os"
import type { Goal } from "../domain/goal"
import type { GoalRuntimeState } from "../domain/runtime"

const STATE_VERSION = 1

export interface StoreState {
  version: number
  revision: number
  goals: Goal[]
  runtimes: GoalRuntimeState[]
}

const EMPTY_STATE: StoreState = {
  version: STATE_VERSION,
  revision: 0,
  goals: [],
  runtimes: [],
}

function stateDir(directory: string): string {
  return path.join(directory, ".opencode", "loopd")
}

function statePath(directory: string, sessionID: string): string {
  return path.join(stateDir(directory), `${safeID(sessionID)}.json`)
}

function eventsPath(directory: string, sessionID: string): string {
  return path.join(stateDir(directory), `${safeID(sessionID)}-events.ndjson`)
}

function safeID(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 128)
}

// ─── Read ────────────────────────────────────────────────────────────────────

async function readRaw(directory: string, sessionID: string): Promise<StoreState> {
  const target = statePath(directory, sessionID)
  const attempts = 5
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const raw = await fs.readFile(target, "utf8")
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === "object" && Array.isArray(parsed.goals)) {
        return parsed as StoreState
      }
      return { ...EMPTY_STATE }
    } catch (error: any) {
      if (error?.code === "ENOENT") return { ...EMPTY_STATE }
      const transient =
        error instanceof SyntaxError ||
        error?.code === "EPERM" ||
        error?.code === "EACCES" ||
        error?.code === "EBUSY"
      if (!transient || attempt === attempts - 1) break
      await delay(25 * (attempt + 1))
    }
  }
  return { ...EMPTY_STATE }
}

export async function readState(
  directory: string,
  sessionID: string,
): Promise<StoreState> {
  return await readRaw(directory, sessionID)
}

// ─── Write ───────────────────────────────────────────────────────────────────

async function writeAtomic(target: string, contents: string): Promise<void> {
  const temp = path.join(
    os.tmpdir(),
    `loopd-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`,
  )
  await fs.writeFile(temp, contents, "utf8")
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await fs.rename(temp, target)
        return
      } catch (error: any) {
        if (error?.code === "EXDEV") break
        if (
          error?.code !== "EPERM" &&
          error?.code !== "EACCES" &&
          error?.code !== "EBUSY" &&
          error?.code !== "EEXIST" &&
          error?.code !== "EAGAIN"
        )
          throw error
        if (attempt < 4) await delay(25 * (attempt + 1))
      }
    }
    await fs.copyFile(temp, target)
  } finally {
    try {
      await fs.rm(temp, { force: true })
    } catch {}
  }
}

export async function writeState(
  directory: string,
  sessionID: string,
  state: StoreState,
): Promise<void> {
  const target = statePath(directory, sessionID)
  await fs.mkdir(path.dirname(target), { recursive: true })
  state.revision += 1
  const payload = JSON.stringify(state, null, 2)
  await writeAtomic(target, payload)
}

// ─── Events Log ──────────────────────────────────────────────────────────────

export async function appendEvent(
  directory: string,
  sessionID: string,
  event: unknown,
): Promise<void> {
  const target = eventsPath(directory, sessionID)
  await fs.mkdir(path.dirname(target), { recursive: true })
  const line = JSON.stringify(event as object) + "\n"
  await fs.appendFile(target, line, "utf8")
}

export async function readEvents(
  directory: string,
  sessionID: string,
  limit = 50,
): Promise<Record<string, unknown>[]> {
  const target = eventsPath(directory, sessionID)
  try {
    const raw = await fs.readFile(target, "utf8")
    const lines = raw.trim().split("\n").filter(Boolean)
    return lines.slice(-limit).map((l) => JSON.parse(l) as Record<string, unknown>)
  } catch {
    return []
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

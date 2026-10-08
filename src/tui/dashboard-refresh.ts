import type { ControlClient } from "../infrastructure/control-client"
import type { StoreState } from "../infrastructure/state-repository"

/** One read pair at a time; requests during a read collapse into one rerun.
 * Disposal cannot cancel filesystem reads, but fences all subsequent work. */
export function createDashboardRefresh(
  client: Pick<ControlClient, "getState" | "getEvents">,
  publish: (state: StoreState, events: Record<string, unknown>[]) => void,
  onError: (error: unknown) => void,
) {
  let disposed = false
  let pending = false
  let flight: Promise<void> | undefined

  function refresh(): Promise<void> {
    if (disposed) return Promise.resolve()
    pending = true
    if (flight) return flight
    flight = (async () => {
      while (pending && !disposed) {
        pending = false
        try {
          const state = await client.getState()
          if (disposed) break
          const events = await client.getEvents(20)
          if (!disposed) publish(state, events)
        } catch (error) {
          if (!disposed) onError(error)
        }
      }
    })().finally(() => { flight = undefined })
    return flight
  }

  return {
    refresh,
    dispose() { disposed = true; pending = false },
  }
}

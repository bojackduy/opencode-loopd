import { describe, expect, it } from "bun:test"
import plugin from "../../src/tui/plugin"

describe("TUI Plugin", () => {
  it("blurs the previously focused renderable when opening from the command palette", async () => {
    let blurCount = 0
    let replaceCount = 0
    let layer: any
    const api = {
      state: { path: { directory: "/tmp/loopd-tui-plugin-test" } },
      renderer: {
        currentFocusedRenderable: { blur: () => blurCount++ },
      },
      ui: {
        dialog: {
          replace: () => replaceCount++,
          setSize: () => {},
        },
      },
      keymap: {
        registerLayer: (value: unknown) => { layer = value },
      },
      lifecycle: { onDispose: () => {} },
    }

    await plugin.tui(api as any)
    layer.commands[0].run()

    expect(replaceCount).toBe(1)
    expect(blurCount).toBe(1)
  })
})

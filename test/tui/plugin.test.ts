import { describe, expect, it } from "bun:test"
import plugin, { adaptThemeV2 } from "../../src/tui/plugin"

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

  it("maps v2 semantic colors into the flat v1 dashboard palette", () => {
    const colors = Object.fromEntries([
      "text", "muted", "primary", "secondary", "accent", "success", "warning", "error", "info",
      "background", "panel", "element", "menu", "border", "scrollbar",
    ].map((name) => [name, { name }])) as Record<string, { name: string }>
    const scale = (step200: object, step300: object) => ({ 200: step200, 300: step300 })
    const theme = {
      hue: {
        interactive: scale(colors.primary, colors.secondary),
        accent: scale(colors.accent, colors.secondary),
      },
      text: {
        base: colors.text,
        muted: colors.muted,
        action: { primary: { focused: colors.text } },
        feedback: {
          success: { base: colors.success },
          warning: { base: colors.warning },
          error: { base: colors.error },
          info: { base: colors.info },
        },
      },
      background: {
        base: colors.background,
        raised: { base: colors.panel, high: colors.element, max: colors.menu },
      },
      border: { base: colors.border },
      scrollbar: { base: colors.scrollbar },
      diff: {},
      syntax: {},
      markdown: {},
    }

    const mapped = adaptThemeV2(theme as any) as any

    expect(mapped.primary).toBe(colors.primary)
    expect(mapped.accent).toBe(colors.accent)
    expect(mapped.success).toBe(colors.success)
    expect(mapped.backgroundPanel).toBe(colors.panel)
    expect(mapped.backgroundElement).toBe(colors.element)
    expect(mapped.borderActive).toBe(colors.scrollbar)
  })

  it("retains safe colors for incomplete v2 themes", () => {
    const mapped = adaptThemeV2({ text: { base: "#ddd", muted: "#777" } } as any) as any

    expect(mapped.text).toBe("#ddd")
    expect(mapped.primary).toBe("#ddd")
    expect(mapped.success).toBe("#22c55e")
    expect(mapped.background).toBe("#000000")
  })
})

import { describe, expect, it } from "bun:test"
import plugin, { adaptThemeV2, navigateToTerminalV1, navigateToTerminalV2 } from "../../src/tui/plugin"
import { TERMINAL_ROUTE_NAME } from "../../src/tui/terminal-route"

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

  it("v1 registers the stable terminal route", async () => {
    const registered: Array<{ name: string }> = []
    const api = {
      state: { path: { directory: "/tmp/loopd-tui-plugin-test" } },
      renderer: { currentFocusedRenderable: undefined },
      ui: { dialog: { replace: () => {}, setSize: () => {}, clear: () => {} } },
      route: {
        register: (routes: Array<{ name: string }>) => {
          registered.push(...routes)
          return () => {}
        },
        navigate: () => {},
      },
      keymap: { registerLayer: () => {} },
      lifecycle: { onDispose: () => {} },
    }
    await plugin.tui(api as any)
    expect(registered.map((r) => r.name)).toContain(TERMINAL_ROUTE_NAME)
    expect(TERMINAL_ROUTE_NAME).toBe("opencode.loopd.terminal")
  })

  it("v1 navigate carries commandID/ownerSessionID/returnSessionID and clears the popup", () => {
    const navigated: Array<{ name: string; params?: unknown }> = []
    let cleared = 0
    const api = {
      route: { navigate: (name: string, params?: unknown) => navigated.push({ name, params }) },
      ui: { dialog: { clear: () => cleared++ } },
    }
    expect(navigateToTerminalV1(api as any, "cmd-1", "owner-1", "ses-ret")).toBe(true)
    expect(navigated).toEqual([
      {
        name: TERMINAL_ROUTE_NAME,
        params: { commandID: "cmd-1", ownerSessionID: "owner-1", returnSessionID: "ses-ret" },
      },
    ])
    expect(cleared).toBe(1)
  })

  it("v1 navigate returns false when the host lacks route support", () => {
    const api = {
      route: {
        navigate: () => {
          throw new Error("no routes")
        },
      },
      ui: { dialog: { clear: () => {} } },
    }
    expect(navigateToTerminalV1(api as any, "cmd-1", "owner-1", "ses-ret")).toBe(false)
  })

  it("v2 navigate uses the plugin destination with route data", () => {
    const destinations: unknown[] = []
    const router = { navigate: (d: unknown) => destinations.push(d) }
    expect(navigateToTerminalV2(router, "cmd-9", "owner-2", "ses-back")).toBe(true)
    expect(destinations).toEqual([
      {
        type: "plugin",
        name: TERMINAL_ROUTE_NAME,
        data: { commandID: "cmd-9", ownerSessionID: "owner-2", returnSessionID: "ses-back" },
      },
    ])
  })

  it("v2 navigate returns false when the host rejects it", () => {
    const router = {
      navigate: () => {
        throw new Error("no router")
      },
    }
    expect(navigateToTerminalV2(router, "cmd-9", "owner-2", "ses-back")).toBe(false)
  })

  it("v2 setup registers the terminal page and cleans up", async () => {
    const registered: Array<{ name: string }> = []
    let unregistered = 0
    const ctx = {
      location: { directory: "/tmp/loopd-tui-plugin-v2-test" },
      options: {},
      renderer: {},
      client: {},
      data: {
        on: () => () => {},
        location: { default: () => ({ directory: "/tmp/loopd-tui-plugin-v2-test" }) },
      },
      theme: {},
      keymap: { layer: () => {} },
      ui: {
        dialog: { show: () => {}, set: () => {}, clear: () => {} },
        router: {
          register: (page: { name: string }) => {
            registered.push(page)
            return () => {
              unregistered += 1
            }
          },
          navigate: () => {},
          current: () => ({ type: "session", sessionID: "ses-1" }),
        },
        panel: { open: () => false, close: () => {} },
        slot: () => () => {},
      },
      storage: {},
    }
    const setup = (plugin as unknown as { setup: (ctx: unknown) => () => Promise<void> }).setup
    const cleanup = setup(ctx)
    expect(registered.map((r) => r.name)).toContain(TERMINAL_ROUTE_NAME)
    await cleanup()
    expect(unregistered).toBe(1)
  })
})

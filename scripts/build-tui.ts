import solidPlugin from "@opentui/solid/bun-plugin"

const result = await Bun.build({
  entrypoints: ["src/tui/plugin.tsx"],
  outdir: "dist",
  naming: "tui.js",
  target: "bun",
  external: [
    "@opencode-ai/plugin/tui",
    "@opentui/core",
    "@opentui/solid",
    "solid-js",
    // Declared runtime dependency; terminal-screen requires it only when a
    // terminal opens. Keep its large CommonJS factory out of TUI startup.
    "@xterm/headless",
  ],
  plugins: [solidPlugin],
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

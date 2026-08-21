/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { LoopDashboard } from "./src/tui/dashboard"

const fakeTheme = {
  primary: { r: 0, g: 0, b: 0, a: 1 }, secondary: { r: 0, g: 0, b: 0, a: 1 }, accent: { r: 0, g: 0, b: 0, a: 1 },
  error: { r: 0, g: 0, b: 0, a: 1 }, warning: { r: 0, g: 0, b: 0, a: 1 }, success: { r: 0, g: 0, b: 0, a: 1 }, info: { r: 0, g: 0, b: 0, a: 1 },
  text: { r: 1, g: 1, b: 1, a: 1 }, textMuted: { r: 0.5, g: 0.5, b: 0.5, a: 1 }, selectedListItemText: { r: 1, g: 1, b: 1, a: 1 },
  background: { r: 0, g: 0, b: 0, a: 1 }, backgroundPanel: { r: 0, g: 0, b: 0, a: 1 }, backgroundElement: { r: 0.1, g: 0.1, b: 0.1, a: 1 },
  backgroundMenu: { r: 0, g: 0, b: 0, a: 1 }, border: { r: 0.3, g: 0.3, b: 0.3, a: 1 }, borderActive: { r: 1, g: 1, b: 1, a: 1 }, borderSubtle: { r: 0.2, g: 0.2, b: 0.2, a: 1 },
  diffAdded: { r: 0, g: 1, b: 0, a: 1 }, diffRemoved: { r: 1, g: 0, b: 0, a: 1 }, diffContext: { r: 1, g: 1, b: 1, a: 1 }, diffHunkHeader: { r: 1, g: 1, b: 0, a: 1 },
  diffHighlightAdded: { r: 0, g: 1, b: 0, a: 1 }, diffHighlightRemoved: { r: 1, g: 0, b: 0, a: 1 }, diffAddedBg: { r: 0, g: 0.2, b: 0, a: 1 }, diffRemovedBg: { r: 0.2, g: 0, b: 0, a: 1 },
  diffContextBg: { r: 0.2, g: 0.2, b: 0.2, a: 1 }, diffLineNumber: { r: 0.5, g: 0.5, b: 0.5, a: 1 }, diffAddedLineNumberBg: { r: 0, g: 0.2, b: 0, a: 1 },
  diffRemovedLineNumberBg: { r: 0.2, g: 0, b: 0, a: 1 }, markdownText: { r: 1, g: 1, b: 1, a: 1 }, markdownHeading: { r: 1, g: 1, b: 0, a: 1 }, markdownLink: { r: 0, g: 0.5, b: 1, a: 1 },
  markdownLinkText: { r: 0, g: 0.5, b: 1, a: 1 }, markdownBlockQuote: { r: 0.5, g: 0.5, b: 0.5, a: 1 }, markdownEmph: { r: 1, g: 1, b: 1, a: 1 }, markdownStrong: { r: 1, g: 1, b: 1, a: 1 },
  markdownHorizontalRule: { r: 0.5, g: 0.5, b: 0.5, a: 1 }, markdownListItem: { r: 1, g: 1, b: 1, a: 1 }, markdownListEnumeration: { r: 1, g: 1, b: 1, a: 1 },
  markdownImage: { r: 1, g: 1, b: 1, a: 1 }, markdownImageText: { r: 1, g: 1, b: 1, a: 1 },
}

const api: any = {
  theme: { current: fakeTheme },
  event: { on: () => () => {} },
  ui: { dialog: { open: true, clear: () => {}, replace: () => {}, setSize: () => {} } },
  route: { current: { name: "home" }, navigate: () => {} },
  mode: { push: () => () => {} },
  renderer: { currentFocusedRenderable: undefined },
  state: { path: { directory: "/tmp/x" } },
}

const setup = await testRender(() => <LoopDashboard api={api} directory="/tmp/x" />, { width: 90, height: 30 })
// Wait a couple of frames then capture
for (let i = 0; i < 3; i++) await new Promise(r => setTimeout(r, 50))
await setup.flush?.()
const frame = setup.captureCharFrame()
console.log("=== FRAME START ===")
console.log(frame)
console.log("=== FRAME END ===")
process.exit(0)

import { spawn } from "node:child_process"

export type BrowserCommand = { command: string; args: string[] }
export type BrowserOpenResult = { status: "opened"; url: string } | { status: "blocked"; reason: string }
export type BrowserLaunch = (command: string, args: string[]) => void
export interface OpenBrowserOptions { platform?: NodeJS.Platform; launch?: BrowserLaunch }

export const LOOPD_ISSUES_URL = "https://github.com/bojackduy/opencode-loopd/issues/new"

export function bugReportUrl(context: { runtimeLabel?: string; extra?: string } = {}) {
  const url = new URL(LOOPD_ISSUES_URL)
  url.searchParams.set("title", "bug: ")
  url.searchParams.set("body", [
    "## What happened?",
    "",
    "Describe the unexpected behavior.",
    "",
    "## What did you expect?",
    "",
    "Describe the expected behavior.",
    "",
    "## Steps to reproduce",
    "",
    "1. ",
    "2. ",
    "3. ",
    "",
    "## Environment",
    "",
    `- opencode-loopd version: ${context.runtimeLabel ?? ""}`,
    `- OS: ${process.platform}`,
    "- Terminal:",
    "- Installation: npm / source",
    context.extra ? `\n## Goal context\n\n${context.extra}\n` : "",
    "Do not include secrets, API tokens, or .opencode/loopd contents.",
  ].join("\n"))
  return url.toString()
}

export function openBrowserUrl(value: string, options: OpenBrowserOptions = {}): BrowserOpenResult {
  try {
    const url = normalizeBrowserUrl(value)
    const command = browserCommandForUrl(url, options.platform)
    const launch = options.launch ?? launchBrowserCommand
    launch(command.command, command.args)
    return { status: "opened", url }
  } catch (error) {
    return { status: "blocked", reason: error instanceof Error ? error.message : "Could not open the browser." }
  }
}

export function browserCommandForUrl(value: string, platform: NodeJS.Platform = process.platform): BrowserCommand {
  const url = normalizeBrowserUrl(value)
  if (platform === "darwin") return { command: "open", args: [url] }
  if (platform === "linux") return { command: "xdg-open", args: [url] }
  if (platform === "win32") return { command: "cmd.exe", args: ["/d", "/s", "/c", `start "" "${url}"`] }
  throw new Error(`Opening a browser is not supported on ${platform}.`)
}

export function normalizeBrowserUrl(value: string) {
  let url: URL
  try { url = new URL(value) } catch { throw new Error("The selected page does not have a valid browser URL.") }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only http and https page URLs can be opened in a browser.")
  return url.toString()
}

function launchBrowserCommand(command: string, args: string[]) {
  const child = spawn(command, args, { detached: true, stdio: "ignore" })
  child.unref()
}

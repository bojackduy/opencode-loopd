#!/usr/bin/env node
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const config = process.env.OPENCODE_CONFIG_DIR || join(homedir(), ".config", "opencode")
const commandDir = join(config, "commands")
const skillDir = join(config, "skills", "loopd")
const packagePath = join(config, "package.json")
const rootPackageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"))
const packageName = rootPackageJson.name // "@bojackduy/opencode-loopd"
const legacyPackageName = "opencode-loopd" // unscoped name used by older installs; matched for cleanup/upgrade only
const packageVersion = rootPackageJson.version
const packageSpec = `${packageName}@${packageVersion}`
const configCandidates = ["opencode.json", "opencode.jsonc", "config.json", "config.jsonc"]
const tuiConfigName = "tui.json"
const installerArgs = process.argv.slice(2)
const uninstallRequested = installerArgs.length === 1 && ["--uninstall", "uninstall", "--remove"].includes(installerArgs[0] || "")

if (installerArgs.includes("--help") || installerArgs.includes("-h")) {
  console.log(`opencode-loopd installer/updater\n\nUsage:\n  opencode-loopd\n  npx -y opencode-loopd@latest\n  npx -y opencode-loopd@latest --uninstall\n\nInstall/update registers the plugin, installs /goal command and loopd skill.\nUninstall removes the plugin registration, command and skill.\n\nSet OPENCODE_CONFIG_DIR to target a non-default OpenCode config directory.`)
  process.exit(0)
}

if (installerArgs.includes("--version") || installerArgs.includes("-v")) {
  console.log(packageVersion)
  process.exit(0)
}

if (installerArgs.length && !uninstallRequested) {
  console.error(`Unknown installer option: ${installerArgs[0]}`)
  process.exit(2)
}

function stripJsonComments(input) {
  let out = "", quote = "", esc = false, lc = false, bc = false
  for (let i = 0; i < input.length; i++) {
    const c = input[i], n = input[i + 1]
    if (lc) { if (c === "\n" || c === "\r") { lc = false; out += c } continue }
    if (bc) { if (c === "*" && n === "/") { bc = false; i++ } else if (c === "\n" || c === "\r") out += c; continue }
    if (quote) { out += c; if (esc) esc = false; else if (c === "\\") esc = true; else if (c === quote) quote = ""; continue }
    if (c === '"') { quote = c; out += c; continue }
    if (c === "/" && n === "/") { lc = true; i++; continue }
    if (c === "/" && n === "*") { bc = true; i++; continue }
    out += c
  }
  return out
}
function stripTrailingCommas(input) {
  let out = "", quote = "", esc = false
  for (let i = 0; i < input.length; i++) {
    const c = input[i]
    if (quote) { out += c; if (esc) esc = false; else if (c === "\\") esc = true; else if (c === quote) quote = ""; continue }
    if (c === '"') { quote = c; out += c; continue }
    if (c === ",") { let j = i + 1; while (/\s/.test(input[j] || "")) j++; if (input[j] === "]" || input[j] === "}") continue }
    out += c
  }
  return out
}
function parseJsonc(input) {
  const p = JSON.parse(stripTrailingCommas(stripJsonComments(input)))
  if (!p || typeof p !== "object" || Array.isArray(p)) throw new Error("OpenCode config root must be an object")
  return p
}
function isPackageSpec(v) {
  const s = String(v||"").trim()
  return s === packageName || s.startsWith(`${packageName}@`) || s === legacyPackageName || s.startsWith(`${legacyPackageName}@`)
}
function skipTrivia(s, i) { while (i < s.length) { const c=s[i]||"", n=s[i+1]||""; if (/\s/.test(c)) {i++;continue} if (c==="/"&&n==="/") {i+=2; while(i<s.length&&s[i]!=="\n"&&s[i]!=="\r") i++; continue} if (c==="/"&&n==="*") { const e=s.indexOf("*/",i+2); if(e<0) throw new Error("unterminated block comment"); i=e+2; continue } break } return i }
function readJsonString(s, i) { if(s[i]!=='"') throw new Error("expected JSON string"); let esc=false; for(let j=i+1;j<s.length;j++){const c=s[j]||""; if(esc){esc=false; continue} if(c==="\\"){esc=true;continue} if(c==='"'){return {value:JSON.parse(s.slice(i,j+1)), end:j+1}}} throw new Error("unterminated JSON string") }
function skipJsonValue(s,i){ const vs=skipTrivia(s,i), f=s[vs]; if(f==='"') return readJsonString(s,vs).end; if(f==="{"||f==="["){const st=[]; let q=false,esc=false,lc=false,bc=false; for(let j=vs;j<s.length;j++){const c=s[j]||"",n=s[j+1]||""; if(lc){if(c==="\n"||c==="\r") lc=false; continue} if(bc){if(c==="*"&&n==="/"){bc=false;j++} continue} if(q){if(esc) esc=false; else if(c==="\\") esc=true; else if(c==='"') q=false; continue} if(c==='"'){q=true;continue} if(c==="/"&&n==="/"){lc=true;j++;continue} if(c==="/"&&n==="*"){bc=true;j++;continue} if(c==="{"||c==="[") st.push(c); else if(c==="}"||c==="]"){const e=c==="}"?"{":"["; if(st.at(-1)!==e) throw new Error("mismatched delimiters"); st.pop(); if(!st.length) return j+1} } throw new Error("unterminated JSON value") } let j=vs; while(j<s.length&&![",","}","]"].includes(s[j])) j++; return j }
function findRootProperty(s, name){ let i=skipTrivia(s,0); if(s[i]!=="{") throw new Error("OpenCode config must be root object"); i++; while(true){ i=skipTrivia(s,i); if(s[i]==="}") return null; const k=readJsonString(s,i); i=skipTrivia(s,k.end); if(s[i]!==":") throw new Error(`expected ':' after ${k.value}`); const vs=skipTrivia(s,i+1), ve=skipJsonValue(s,vs); if(k.value===name){ const ls=Math.max(s.lastIndexOf("\n",vs-1),s.lastIndexOf("\r",vs-1))+1; const kls=Math.max(s.lastIndexOf("\n",k.end-1),s.lastIndexOf("\r",k.end-1))+1; const indent=s.slice(kls,k.end-k.value.length-2).match(/^[\t ]*/)?.[0]||"  "; return {valueStart:vs,valueEnd:ve,indent,lineStart:ls} } const av=skipTrivia(s,ve); if(s[av]===",") i=av+1; else if(s[av]==="}") return null; else throw new Error(`expected ',' or '}' after ${k.value}`) } }
function formatPluginArray(vals, indent, eol){ if(!vals.length) return "[]"; const ci=`${indent}  `; return `[${eol}${vals.map(v=>`${ci}${JSON.stringify(v)}`).join(`,${eol}`)}${eol}${indent}]` }
function rewriteExistingPluginArray(source, next){ const prop=findRootProperty(source,"plugin"); if(!prop) return source; const eol=source.includes("\r\n")?"\r\n":"\n"; const rep=formatPluginArray(next,prop.indent,eol); return `${source.slice(0,prop.valueStart)}${rep}${source.slice(prop.valueEnd)}` }
function insertPluginProperty(source, vals) {
  const eol = source.includes("\r\n") ? "\r\n" : "\n"
  const i = skipTrivia(source, 0)
  if (source[i] !== "{") throw new Error("OpenCode config must be root object")
  const openEnd = i + 1
  const after = skipTrivia(source, openEnd)
  const propLine = `  "plugin": ${formatPluginArray(vals, "  ", eol)}`
  if (source[after] === "}") return `${source.slice(0, openEnd)}${eol}${propLine}${eol}${source.slice(after)}`
  return `${source.slice(0, openEnd)}${eol}${propLine},${source.slice(openEnd)}`
}

// Adds/updates the plugin entry in `target`, creating the file (with a minimal
// `{ "plugin": [...] }`) if it doesn't exist yet. Returns true if the file changed.
async function ensurePluginRegistered(target) {
  let source
  try {
    source = await readFile(target, "utf8")
  } catch (e) {
    if (e?.code !== "ENOENT") throw new Error(`Could not read ${target}: ${e.message}`)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, JSON.stringify({ plugin: [packageSpec] }, null, 2) + "\n", "utf8")
    return true
  }
  const parsed = parseJsonc(source)
  if (parsed.plugin !== undefined && !Array.isArray(parsed.plugin)) throw new Error(`plugin must be array in ${target}`)
  const plugins = parsed.plugin || []
  const next = plugins.filter(v => !isPackageSpec(v))
  next.push(packageSpec)
  const updated = parsed.plugin !== undefined ? rewriteExistingPluginArray(source, next) : insertPluginProperty(source, next)
  if (updated === source) return false
  await writeFile(target, updated, "utf8")
  return true
}
// Removes the plugin entry from `target` if present. Returns true if the file changed.
async function removePluginFromFile(target) {
  let source
  try {
    source = await readFile(target, "utf8")
  } catch (e) {
    if (e?.code !== "ENOENT") throw new Error(`Could not inspect ${target}: ${e.message}`)
    return false
  }
  const parsed = parseJsonc(source)
  if (parsed.plugin !== undefined && !Array.isArray(parsed.plugin)) throw new Error(`plugin must be array in ${target}`)
  const plugins = parsed.plugin || []
  const next = plugins.filter(v => !isPackageSpec(v))
  if (next.length === plugins.length) return false
  const updated = rewriteExistingPluginArray(source, next)
  if (updated === source) return false
  await writeFile(target, updated, "utf8")
  return true
}
// The server plugin registers into whichever main config file the user already
// has (first match wins); falls back to opencode.jsonc if none exist yet.
async function findExistingServerConfig() {
  for (const name of configCandidates) {
    const target = join(config, name)
    try { await readFile(target, "utf8"); return target } catch (e) { if (e?.code !== "ENOENT") throw new Error(`Could not inspect ${target}: ${e.message}`) }
  }
  return null
}
async function ensureDependency(){
  let pkg={}
  try{ pkg=JSON.parse(await readFile(packagePath,"utf8")) }catch(e){ if(e?.code!=="ENOENT"){ console.warn(`Could not update ${packagePath}: ${e.message}`); return } }
  if(!pkg||typeof pkg!=="object"||Array.isArray(pkg)) pkg={}
  pkg.dependencies = pkg.dependencies && typeof pkg.dependencies==="object" && !Array.isArray(pkg.dependencies) ? pkg.dependencies : {}
  if(!pkg.dependencies["@opencode-ai/plugin"]){ pkg.dependencies["@opencode-ai/plugin"]=">=1.4.0"; await writeFile(packagePath, JSON.stringify(pkg,null,2)+"\n","utf8") }
}
async function removePackagedFiles(srcDir, tgtDir){
  try{ for(const n of await readdir(srcDir)) if(n.endsWith(".md")) await rm(join(tgtDir,n),{force:true}) }catch{}
}
async function uninstall(){
  const targets = [...configCandidates.map(name => join(config, name)), join(config, tuiConfigName)]
  let changed = 0
  for (const target of targets) {
    if (await removePluginFromFile(target)) changed++
  }
  // remove loopd artifacts
  await removePackagedFiles(join(root,"commands"), join(config,"commands"))
  await rm(join(config,"skills","loopd","SKILL.md"),{force:true})
  try{ const d=join(config,"skills","loopd"); const files=await readdir(d); if(!files.length) await rm(d,{force:true}) }catch{}
  console.log(changed ? `Removed ${packageName} from ${changed} config file(s).` : `${packageName} was not registered.`)
  console.log("Removed loopd command and skill when present. Project state under .opencode/loopd is preserved.")
  console.log("Restart OpenCode to finish unloading.")
}
async function installOrUpdate(){
  await mkdir(config,{recursive:true})
  await mkdir(join(config,"commands"),{recursive:true})
  await mkdir(join(config,"skills","loopd"),{recursive:true})

  // Server engine plugin: registers into whichever main config file the user
  // already has, creating opencode.jsonc if none exist yet.
  const serverTarget = (await findExistingServerConfig()) || join(config, "opencode.jsonc")
  const serverChanged = await ensurePluginRegistered(serverTarget)

  // TUI dashboard plugin: separate config file, loaded by the TUI process.
  // Without this, `/loop` and the `<leader>o` binding never register.
  const tuiTarget = join(config, tuiConfigName)
  const tuiChanged = await ensurePluginRegistered(tuiTarget)

  await ensureDependency()

  // commands
  for(const n of await readdir(join(root,"commands"))){
    if(n.endsWith(".md")) await copyFile(join(root,"commands",n), join(config,"commands",n))
  }
  // skill
  await copyFile(join(root,"skills","loopd","SKILL.md"), join(config,"skills","loopd","SKILL.md"))

  console.log(serverChanged ? `Registered ${packageSpec} in ${serverTarget}` : `${packageSpec} already registered in ${serverTarget}`)
  console.log(tuiChanged ? `Registered ${packageSpec} in ${tuiTarget}` : `${packageSpec} already registered in ${tuiTarget}`)
  console.log(`Installed ${packageName} command to ${join(config,"commands","goal.md")}`)
  console.log(`Installed ${packageName} skill to ${join(config,"skills","loopd","SKILL.md")}`)
  console.log("Restart OpenCode, then run: /goal  or  /loop  (<leader>o)")
}
if(uninstallRequested) await uninstall()
else await installOrUpdate()

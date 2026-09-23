// ─── TUI: Terminal Key Encoder (headless-testable) ────────────────────────────
// Raw input is immediate: every keypress forwards as VT bytes the moment it
// lands — never through a line-submit InputRenderable. This helper maps host
// key events to the bytes to write; incompatible host Kitty encodings are
// refused (undefined) rather than forwarded blindly.
//
// Host key shape: OpenTUI ParsedKey-ish ({ name, sequence, ctrl, alt/meta,
// shift }) plus an explicit `release` flag. Releases are always ignored.

export interface TerminalKeyEvent {
  /** Logical key name from the host (e.g. "return", "up", "a", "escape"). */
  name?: string
  /** Printable text the host already decoded (for normal typing). */
  text?: string
  /** Raw sequence (fallback when name is absent). */
  sequence?: string
  ctrl?: boolean
  alt?: boolean
  meta?: boolean
  /** macOS Option-as-Alt. Treated like alt when true. */
  option?: boolean
  shift?: boolean
  /** Host event source ("raw" | "kitty"). Kitty CSI-u is never forwarded. */
  source?: string
  /** Key-release events are ignored (return undefined). */
  release?: boolean
  /** Repeat events (held key) forward like presses. */
  repeated?: boolean
}

/** Ctrl+] — reserved LOCAL detach chord. Never forwarded to the PTY. */
export function isDetachChord(evt: TerminalKeyEvent): boolean {
  if (!evt || evt.release) return false
  if (!evt.ctrl) return false
  const name = (evt.name ?? "").toLowerCase()
  return name === "]" || evt.sequence === "\x1d"
}

/** Ctrl+C — interrupt INPUT to the PTY (never a local close). */
export function isInterruptChord(evt: TerminalKeyEvent): boolean {
  if (!evt || evt.release) return false
  if (!evt.ctrl) return false
  return (evt.name ?? "").toLowerCase() === "c"
}

const CSI = "\x1b["

/** Kitty keyboard protocol (CSI u / CSI … u with modifiers) — never forward. */
function isKittyEncoding(name: string, sequence: string): boolean {
  if (/^\x1b\[[0-9;?]*u$/i.test(sequence)) return true
  if (/^kitty/i.test(name)) return true
  return false
}

const CONVENTIONAL_NAMES = new Set([
  "return", "enter", "kp_enter", "tab", "backspace", "escape", "esc",
  "up", "down", "right", "left", "home", "end", "delete", "del",
  "pageup", "page_up", "pagedown", "page_down", "space",
])

/** True for single printable chars and the conventional VT set above. */
function isConventionalVT(name: string, sequence: string, text: string): boolean {
  if (CONVENTIONAL_NAMES.has(name)) return true
  if (text.length === 1) return true
  if (sequence.length === 1 && sequence >= " " && sequence !== "\x7f") return true
  return false
}

/**
 * Encode one host key event to terminal input bytes.
 * Returns undefined when the event must not be forwarded (release, Kitty
 * encoding, or unrecognized).
 */
export function encodeTerminalKey(evt: TerminalKeyEvent): string | undefined {
  if (!evt || evt.release) return undefined
  const rawName = (evt.name ?? "").toLowerCase()
  const seq = evt.sequence ?? ""
  const text = evt.text ?? ""
  const ctrl = Boolean(evt.ctrl)
  const alt = Boolean(evt.alt || evt.meta || evt.option)

  // The local detach chord (Ctrl+]) never reaches the PTY.
  if (isDetachChord(evt)) return undefined

  // Kitty-protocol frames are never forwarded blindly: only the conventional
  // VT sequences below pass through, everything else is refused.
  if (evt.source === "kitty" && !isConventionalVT(rawName, seq, text)) return undefined
  if (isKittyEncoding(rawName, seq)) return undefined

  // Named special keys first (names win over text/sequence).
  switch (rawName) {
    case "return":
    case "enter":
    case "kp_enter":
      return alt ? `\x1b\r` : "\r"
    case "tab":
      return alt ? "\x1b\t" : "\t"
    case "backspace":
      return alt ? "\x1b\x7f" : "\x7f"
    case "escape":
    case "esc":
      return "\x1b"
    case "up":
      return alt ? `\x1b${CSI}A` : `${CSI}A`
    case "down":
      return alt ? `\x1b${CSI}B` : `${CSI}B`
    case "right":
      return alt ? `\x1b${CSI}C` : `${CSI}C`
    case "left":
      return alt ? `\x1b${CSI}D` : `${CSI}D`
    case "home":
      return alt ? `\x1b${CSI}H` : `${CSI}H`
    case "end":
      return alt ? `\x1b${CSI}F` : `${CSI}F`
    case "delete":
    case "del":
      return alt ? `\x1b${CSI}3~` : `${CSI}3~`
    case "pageup":
    case "page_up":
      return alt ? `\x1b${CSI}5~` : `${CSI}5~`
    case "pagedown":
    case "page_down":
      return alt ? `\x1b${CSI}6~` : `${CSI}6~`
    case "space":
      if (ctrl) return "\x00"
      return alt ? "\x1b " : " "
    default:
      break
  }

  // Ctrl+A..Z → C0 control bytes. Ctrl+C (\x03) is interrupt INPUT to the PTY
  // (never a local close); Ctrl+] is handled by the view as local detach and
  // never reaches this encoder.
  if (ctrl) {
    const letter = rawName.length === 1 ? rawName : text.length === 1 ? text.toLowerCase() : ""
    if (/^[a-z]$/.test(letter)) {
      const byte = letter.charCodeAt(0) - 96 // a→1 … z→26
      const out = String.fromCharCode(byte)
      return alt ? `\x1b${out}` : out
    }
    if (rawName === "[" || seq === "\x1b") return "\x1b"
    if (rawName === "\\") return alt ? "\x1b\x1c" : "\x1c"
    // "]" (Ctrl+]) is the reserved local detach chord — isDetachChord above
    // already refused it; reaching here is a non-ctrl anomaly: refuse.
    if (rawName === "^" || rawName === "6") return alt ? "\x1b\x1e" : "\x1e"
    if (rawName === "_" || rawName === "-") return alt ? "\x1b\x1f" : "\x1f"
    return undefined
  }

  // Printable single characters (normal typing + Alt-prefix).
  if (text.length === 1) {
    return alt ? `\x1b${text}` : text
  }
  if (seq.length === 1 && seq >= " " && seq !== "\x7f") {
    return alt ? `\x1b${seq}` : seq
  }

  // Conventional VT sequences the host already decoded (Enter/Tab/Backspace/
  // Escape/arrows/Home/End/Delete/PageUp/PageDown) pass through; anything
  // else (multi-byte Kitty-style) is refused.
  const knownVT = new Set([
    "\r", "\n", "\t", "\x7f", "\x1b",
    `${CSI}A`, `${CSI}B`, `${CSI}C`, `${CSI}D`,
    `${CSI}H`, `${CSI}F`, `${CSI}3~`, `${CSI}5~`, `${CSI}6~`,
    "\x1bOA", "\x1bOB", "\x1bOC", "\x1bOD", // SS3 application-cursor arrows
    "\x1bOH", "\x1bOF", // SS3 Home/End
  ])
  if (knownVT.has(seq)) {
    return alt && !seq.startsWith("\x1b") ? `\x1b${seq}` : seq
  }
  return undefined
}

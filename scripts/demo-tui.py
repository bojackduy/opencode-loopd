#!/usr/bin/env python3
"""Drive a REAL opencode TUI session over a pty, record to asciicast v3.
Story: empty Loop dashboard -> prompt agent -> two parallel loopd goals ->
dashboard shows them done.
"""
import os, pty, time, json, select, signal

WORKDIR = "/tmp/loopd-tui"
OUT = "/Users/duytrinh/Code/opencode-loopd/assets/loopd-tui.cast"
COLS, ROWS = 120, 32

PROMPT = ("You have loopd tools: loopd_create_goal, list_background_goals. "
  "Create TWO goals in parallel: 'tui-a' (append exactly one line TUI-A to src/a.txt "
  "with your own write tool, no subagents; checks ['grep -q TUI-A src/a.txt'], "
  "write_scope ['src/a.txt']) and 'tui-b' (same for TUI-B in src/b.txt; checks "
  "['grep -q TUI-B src/b.txt'], write_scope ['src/b.txt']). "
  "Poll list_background_goals till both complete, then show both files. Only this dir.")

def main():
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(WORKDIR)
        os.execvpe("opencode", ["opencode"], dict(os.environ, TERM="xterm-256color"))

    import fcntl, termios, struct
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))

    events = []
    t0 = time.time()
    def drain(timeout):
        end = time.time() + timeout
        while time.time() < end:
            r, _, _ = select.select([fd], [], [], 0.2)
            if r:
                try:
                    chunk = os.read(fd, 65536)
                except OSError:
                    break
                if not chunk:
                    break
                events.append([round(time.time() - t0, 3), "o", chunk.decode("utf-8", "replace")])

    def send(text):
        for i in range(0, len(text), 64):
            os.write(fd, text[i:i+64].encode())
            time.sleep(0.02)

    def dashboard(seconds=8):
        os.write(fd, b"\x18")  # leader ctrl+x
        time.sleep(0.4)
        os.write(fd, b"o")
        drain(seconds)

    print("tui loading...", flush=True)
    drain(10)
    print("empty dashboard...", flush=True)
    dashboard(5)
    os.write(fd, b"q")
    drain(2)
    print("sending prompt...", flush=True)
    send(PROMPT)
    time.sleep(0.5)
    os.write(fd, b"\r")
    drain(5)

    import pathlib
    state = pathlib.Path(WORKDIR) / ".opencode" / "loopd" / "state.json"
    deadline = time.time() + 480
    done = False
    while time.time() < deadline:
        drain(5)
        try:
            goals = json.loads(state.read_text()).get("goals", [])
            names = {g["name"]: g["status"] for g in goals if g["name"] in ("tui-a", "tui-b")}
            if names.get("tui-a") == "complete" and names.get("tui-b") == "complete":
                done = True
                break
        except Exception:
            pass
    print("goals complete:", done, flush=True)

    drain(25)  # agent summary
    print("done, quitting...", flush=True)
    def safe_write(data):
        try:
            os.write(fd, data)
            return True
        except OSError:
            return False

    safe_write(b"\x03")
    drain(2)
    safe_write(b"\x03")
    drain(2)
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    drain(1)
    try:
        os.close(fd)
    except OSError:
        pass

    hdr = {"version": 2, "width": COLS, "height": ROWS}
    with open(OUT, "w") as f:
        f.write(json.dumps(hdr) + "\n")
        # Preserve each event's real time, but keep timestamps strictly
        # increasing at microsecond precision: agg mis-schedules
        # duplicate/rounded timestamps (renders them with multi-second
        # delays), so nudge any event that would share its predecessor's time.
        last = events[0][0] if events else 0.0
        first = True
        for t, kind, data in events:
            if not first:
                t = max(t, last + 0.0005)
            first = False
            last = t
            f.write(json.dumps([round(t, 4), kind, data]) + "\n")
    total = events[-1][0] if events else 0
    print(f"wrote {OUT}: {len(events)} events, {total:.1f}s", flush=True)

main()

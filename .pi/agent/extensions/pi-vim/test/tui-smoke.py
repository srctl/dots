"""Offline smoke test against the real Pi TUI in a temporary pseudo-terminal.

No model call, saved session, or clipboard write. Requires pi on PATH.
"""
import fcntl
import os
from pathlib import Path
import pty
import re
import select
import struct
import subprocess
import tempfile
import termios
import time

ROOT = Path(__file__).resolve().parents[1]
ANSI = re.compile(rb"\x1b\[[0-?]*[ -/]*[@-~]")


def read_output(fd, seconds=1):
    output = b""
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if select.select([fd], [], [], 0.05)[0]:
            try:
                output += os.read(fd, 65536)
            except OSError:
                break
    return output


master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 35, 100, 0, 0))
with tempfile.TemporaryDirectory(prefix="pi-vim-smoke-") as cwd:
    process = subprocess.Popen(
        ["pi", "--offline", "--no-session", "--no-context-files", "--no-extensions",
         "--no-skills", "--no-prompt-templates", "--no-themes", "--no-tools",
         "--tui-mode", "fullscreen", "-e", str(ROOT / "index.ts"),
         "-e", str(ROOT / "test/response-fixture.ts")],
        stdin=slave, stdout=slave, stderr=slave, cwd=cwd,
        env={**os.environ, "TERM": "xterm-256color"},
    )
    os.close(slave)
    try:
        startup = read_output(master, 6)
        assert b"Last response line" in ANSI.sub(b"", startup), startup[-3000:]
        os.write(master, b"draft")
        read_output(master, 0.2)
        os.write(master, b"\x1b")
        read_output(master, 0.2)
        os.write(master, b"k")
        response = read_output(master)
        assert "RESPONSES · NORMAL" in ANSI.sub(b"", response).decode(errors="replace"), response[-3000:]
        assert b"106m" in response, "The response pane did not paint its cyan cursor"
        os.write(master, b"\x08")  # Ctrl+H: animated half-page up.
        upward = read_output(master)
        assert b"106m" in upward, "Animated scrolling should repaint the cursor"
        os.write(master, b"\x0c")  # Ctrl+L: animated half-page down, not model picker.
        downward = read_output(master)
        assert b"106m" in downward, "Scrolling down should repaint the cursor"
        os.write(master, b"v")
        selection = read_output(master)
        assert b"VISUAL" in ANSI.sub(b"", selection), selection[-3000:]
        os.write(master, b"A!")
        prompt = read_output(master)
        assert b"INSERT" in ANSI.sub(b"", prompt), prompt[-3000:]
        assert b"draft!" in ANSI.sub(b"", prompt), prompt[-3000:]
        print("PASS: real TUI cursor, animated scrolling, selection, and A to append")
    finally:
        process.terminate()
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
        os.close(master)

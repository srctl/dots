/**
 * OS integration lives here, not in the Vim key handler.
 * Clipboard tools are optional: the editor also keeps its own copy register.
 */
import { spawnSync } from "node:child_process";

type Command = [program: string, ...arguments: string[]];

function clipboardWriteCommands(): Command[] {
  if (process.platform === "darwin") return [["pbcopy"]];
  if (process.platform === "win32") return [["clip"]];
  return [
    ["wl-copy"],
    ["xclip", "-selection", "clipboard"],
    ["xsel", "--clipboard", "--input"],
  ];
}

function clipboardReadCommands(): Command[] {
  if (process.platform === "darwin") return [["pbpaste"]];
  if (process.platform === "win32")
    return [["powershell", "-NoProfile", "-Command", "Get-Clipboard -Raw"]];
  return [
    ["wl-paste", "--no-newline"],
    ["xclip", "-selection", "clipboard", "-out"],
    ["xsel", "--clipboard", "--output"],
  ];
}

export function writeClipboard(text: string): void {
  for (const [program, ...args] of clipboardWriteCommands()) {
    const result = spawnSync(program, args, { input: text });
    if (result.status === 0) return;
  }
}

export function readClipboard(): string {
  for (const [program, ...args] of clipboardReadCommands()) {
    const result = spawnSync(program, args, { encoding: "utf8" });
    if (result.status === 0) return result.stdout;
  }
  return "";
}

export function openExternalUrl(url: string): boolean {
  let commands: Command[];
  if (process.platform === "darwin") commands = [["open", url]];
  else if (process.platform === "win32")
    commands = [["cmd", "/c", "start", "", url]];
  else
    commands = [
      ["xdg-open", url],
      ["gio", "open", url],
    ];

  // Pass arguments directly, never through a shell command containing the URL.
  for (const [program, ...args] of commands) {
    if (spawnSync(program, args, { stdio: "ignore" }).status === 0) return true;
  }
  return false;
}

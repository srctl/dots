/**
 * Owns the response pane for the current Pi session.
 * The prompt editor asks this module to open/close the pane; this module owns
 * its overlay handle, footer status, and timers. There is only one Pi editor.
 */
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { OverlayHandle, TUI } from "@earendil-works/pi-tui";
import { ScrollbackOverlay, nativeTranscriptComponents } from "./scrollback.ts";
import { branchUserMessages, showMessageActions } from "./message-actions.ts";
import type { Mode } from "./types.ts";

// Share one stable object across Pi's TypeScript module loader. Exported mutable
// scalar bindings can otherwise become snapshots when jiti bridges ESM and CJS.
export const responseSession = {
  context: undefined as ExtensionContext | undefined,
  pane: undefined as ScrollbackOverlay | undefined,
  cursorVisible: true,
};
export const MESSAGE_ACTION_COMMAND = "vim-message-action";

let currentTui: TUI | undefined;
let overlayHandle: OverlayHandle | undefined;
let footerMode: Mode = "insert";
let pendingMessageId: string | undefined;
let lastInputTime = Date.now();
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
let blinkTimer: ReturnType<typeof setInterval> | undefined;

export function setCurrentMode(mode: Mode): void {
  footerMode = mode;
  const labels: Record<Mode, string> = {
    insert: "INSERT",
    normal: "NORMAL",
    visual: "VISUAL",
    visualLine: "VISUAL LINE",
  };
  const paneLabel = responseSession.pane ? "RESPONSES · " : "";
  responseSession.context?.ui.setStatus("vim-mode", paneLabel + labels[mode]);
}

export function noteInput(): void {
  lastInputTime = Date.now();
  responseSession.cursorVisible = true;
}

export function beginSession(ctx: ExtensionContext, tui: TUI): void {
  responseSession.context = ctx;
  currentTui = tui;
  setCurrentMode("insert");
  if (blinkTimer) clearInterval(blinkTimer);
  blinkTimer = setInterval(() => {
    // Never blink the response cursor, or the prompt cursor while typing.
    if (footerMode !== "insert" || Date.now() - lastInputTime < 900) {
      responseSession.cursorVisible = true;
    } else {
      responseSession.cursorVisible = !responseSession.cursorVisible;
    }
    tui.requestRender();
  }, 550);
}

export function ensureScrollback(ctx: ExtensionContext, tui: TUI): void {
  if (ctx.mode !== "tui" || responseSession.pane) return;
  currentTui = tui;
  responseSession.pane = new ScrollbackOverlay(
    tui,
    nativeTranscriptComponents(tui),
  );

  // The first mounted component is Pi's transcript ScrollView. Start in the
  // viewport the user is already looking at, rather than jumping to the bottom.
  const transcriptView = tui.children[0] as { scrollTop?: number } | undefined;
  responseSession.pane.enterCursor(transcriptView?.scrollTop);
  setCurrentMode("normal");
  overlayHandle = tui.showOverlay(responseSession.pane, {
    row: 0,
    col: 0,
    width: "100%",
    maxHeight: "100%",
    nonCapturing: true,
  });
  // The component itself limits its height to the space above the editor.
  // A percentage limit allows that space to change after a terminal resize.
  tui.requestRender();
}

export function leaveScrollback(): void {
  responseSession.pane?.cancelScrollAnimation();
  overlayHandle?.hide();
  overlayHandle = undefined;
  responseSession.pane = undefined;
  currentTui?.requestRender();
}

export function requestScrollRender(tui: TUI): void {
  // Pi already batches render requests; no extra timer is needed for keypresses.
  tui.requestRender();
}

function refreshResponsePane(): void {
  if (!currentTui || !responseSession.pane) return;
  responseSession.pane.setComponents(nativeTranscriptComponents(currentTui));
  currentTui.requestRender();
}

function scheduleRefresh(): void {
  if (!responseSession.pane || refreshTimer) return;
  // Coalesce streamed tokens so we do not rebuild the transcript for each one.
  refreshTimer = setTimeout(() => {
    refreshTimer = undefined;
    refreshResponsePane();
  }, 100);
}

export function queueSelectedUserMessageAction(): boolean {
  if (!responseSession.context || !responseSession.pane) return false;
  const index = responseSession.pane.selectedUserMessageIndex();
  const message =
    index === undefined
      ? undefined
      : branchUserMessages(responseSession.context)[index];
  if (!message) {
    responseSession.context.ui.notify(
      "Could not resolve selected user message",
      "error",
    );
    return false;
  }
  pendingMessageId = message.entryId;
  leaveScrollback();
  setCurrentMode("normal");
  return true;
}

export function registerResponseEvents(pi: ExtensionAPI): void {
  pi.registerCommand(MESSAGE_ACTION_COMMAND, {
    description: "Open actions for the selected pi-vim user message",
    handler: async (_args, ctx) => {
      const entryId = pendingMessageId;
      pendingMessageId = undefined;
      if (!entryId) {
        ctx.ui.notify("No user message selected", "error");
        return;
      }
      if (await showMessageActions(ctx, entryId)) refreshResponsePane();
    },
  });

  pi.on("message_start", scheduleRefresh);
  pi.on("message_update", scheduleRefresh);
  pi.on("message_end", scheduleRefresh);
  pi.on("tool_execution_start", scheduleRefresh);
  pi.on("tool_execution_update", scheduleRefresh);
  pi.on("tool_execution_end", scheduleRefresh);
  pi.on("agent_settled", scheduleRefresh);

  pi.on("session_shutdown", () => {
    if (refreshTimer) clearTimeout(refreshTimer);
    if (blinkTimer) clearInterval(blinkTimer);
    refreshTimer = undefined;
    blinkTimer = undefined;
    leaveScrollback();
    responseSession.context?.ui.setStatus("vim-mode", undefined);
    responseSession.context = undefined;
    currentTui = undefined;
    pendingMessageId = undefined;
    responseSession.cursorVisible = true;
  });
}

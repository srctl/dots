/** Pi entry point: register lifecycle hooks and install the single Vim editor. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ScrollEditor } from "./prompt-editor.ts";
import {
  beginSession,
  registerResponseEvents,
} from "./parts/response-session.ts";

// Retain the upstream export for editor integration tests.
export { ScrollEditor } from "./prompt-editor.ts";

export default function piVim(pi: ExtensionAPI): void {
  registerResponseEvents(pi);
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      beginSession(ctx, tui);
      return new ScrollEditor(tui, theme, keybindings);
    });
  });
}

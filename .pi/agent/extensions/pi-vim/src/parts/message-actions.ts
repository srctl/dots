/** Message navigation and the explicitly destructive "Edit message" action. */
import type {
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

interface StoredEntry {
  id?: string;
  parentId?: string | null;
  type?: string;
  message?: { role?: string; content?: unknown };
}

export function sessionEntries(ctx: ExtensionContext): StoredEntry[] {
  return ctx.sessionManager.getBranch() as StoredEntry[];
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const textParts: string[] = [];
  for (const part of content) {
    if (typeof part === "string") textParts.push(part);
    else if (
      (part?.type === "text" || part?.type === "input_text") &&
      typeof part.text === "string"
    ) {
      textParts.push(part.text);
    }
  }
  return textParts.join("");
}

export function branchUserMessages(
  ctx: ExtensionContext,
): Array<{ entryId: string; text: string }> {
  const messages: Array<{ entryId: string; text: string }> = [];
  for (const entry of sessionEntries(ctx)) {
    if (!entry.id || entry.type !== "message" || entry.message?.role !== "user")
      continue;
    const text = messageText(entry.message.content);
    if (text.trim()) messages.push({ entryId: entry.id, text });
  }
  return messages;
}

async function askForBranchSummary(ctx: ExtensionCommandContext) {
  while (true) {
    const choice = await ctx.ui.select("Summarize branch?", [
      "No summary",
      "Summarize",
      "Summarize with custom prompt",
    ]);
    if (choice === undefined) return undefined;
    if (choice === "No summary") return { summarize: false };
    if (choice === "Summarize") return { summarize: true };
    const instructions = await ctx.ui.editor(
      "Custom summarization instructions",
      "",
    );
    // Cancelling the text editor returns to the summary choices.
    if (instructions !== undefined)
      return { summarize: true, customInstructions: instructions };
  }
}

function pruneSessionFromMessage(
  ctx: ExtensionCommandContext,
  entryId: string,
): string {
  // Pi has no public API for deleting session entries. Keep this private-API
  // dependency isolated here, and refuse the edit if its required methods change.
  const manager = ctx.sessionManager as unknown as {
    fileEntries: StoredEntry[];
    leafId: string | null;
    _buildIndex(): void;
    _rewriteFile(): void;
  };
  if (
    !Array.isArray(manager.fileEntries) ||
    typeof manager._buildIndex !== "function" ||
    typeof manager._rewriteFile !== "function"
  ) {
    throw new Error(
      "This Pi version does not support destructive message editing",
    );
  }
  const index = manager.fileEntries.findIndex((entry) => entry.id === entryId);
  const entry = manager.fileEntries[index];
  if (!entry || entry.type !== "message" || entry.message?.role !== "user") {
    throw new Error("Selected user message is no longer in the session");
  }

  const text = messageText(entry.message.content);
  manager.fileEntries = manager.fileEntries.slice(0, index);
  manager._buildIndex();
  manager.leafId = entry.parentId ?? null;
  manager._rewriteFile();
  return text;
}

/** Returns true when navigation changed the visible conversation. */
export async function showMessageActions(
  ctx: ExtensionCommandContext,
  entryId: string,
): Promise<boolean> {
  const entry = branchUserMessages(ctx).find(
    (message) => message.entryId === entryId,
  );
  const preview =
    entry?.text.replace(/\s+/g, " ").trim().slice(0, 160) ??
    entryId.slice(0, 8);
  const choice = await ctx.ui.select(
    `Selected user message:\n${preview}\n\nAction`,
    [
      "Edit message (destructive)",
      "Fork from here (tree navigation)",
      "Cancel",
    ],
  );
  if (!choice || choice === "Cancel") return false;

  if (choice === "Edit message (destructive)") {
    // Navigate first so Pi updates its live conversation, then remove the
    // selected message and every later entry from the session file on disk.
    await ctx.navigateTree(entryId, { summarize: false });
    ctx.ui.setEditorText(pruneSessionFromMessage(ctx, entryId));
    ctx.ui.notify(
      "Restored selected message to input and removed later session entries",
      "info",
    );
    return true;
  }

  const options = await askForBranchSummary(ctx);
  if (!options) return false;
  await ctx.navigateTree(entryId, options);
  ctx.ui.notify("Navigated via tree from selected message", "info");
  return true;
}

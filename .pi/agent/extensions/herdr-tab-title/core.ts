export const STATE_ENTRY_TYPE = "herdr-tab-title";
export const RETITLE_EVERY_TURNS = 3;

export interface TabTitleState {
  autoAttempted: boolean;
  lastAttemptTurn?: number;
  title?: string;
}

export const isInteractiveHerdrSession = (options: {
  herdrEnv?: string;
  tabId?: string;
  mode: string;
}) =>
  options.herdrEnv === "1" &&
  Boolean(options.tabId?.trim()) &&
  options.mode === "tui";

type SessionEntryLike = {
  type?: string;
  customType?: string;
  data?: unknown;
  message?: {
    role?: string;
    content?: unknown;
    stopReason?: string;
  };
};

const textFromContent = (content: unknown): string => {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is { type: "text"; text: string } =>
        typeof part === "object" &&
        part !== null &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string",
    )
    .map((part) => part.text)
    .join("\n")
    .trim();
};

// A turn is a user request followed by a completed reply, not a tool iteration.
export const countCompletedTurns = (entries: readonly SessionEntryLike[]): number => {
  let turns = 0;
  let pendingUser = false;
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    if (entry.message?.role === "user") pendingUser = true;
    if (pendingUser && entry.message?.role === "assistant" && entry.message.stopReason === "stop") {
      turns++;
      pendingUser = false;
    }
  }
  return turns;
};

export const isAutoTitleDue = (state: TabTitleState, completedTurns: number): boolean =>
  completedTurns > 0 &&
  (!state.autoAttempted || completedTurns - (state.lastAttemptTurn ?? 0) >= RETITLE_EVERY_TURNS);

export const restoreState = (entries: readonly SessionEntryLike[]): TabTitleState => {
  let state: TabTitleState = { autoAttempted: false };
  for (const [index, entry] of entries.entries()) {
    if (entry.type !== "custom" || entry.customType !== STATE_ENTRY_TYPE) continue;
    if (!entry.data || typeof entry.data !== "object") continue;
    const data = entry.data as { autoAttempted?: unknown; title?: unknown; lastAttemptTurn?: unknown };
    if (typeof data.autoAttempted !== "boolean") continue;
    state = {
      autoAttempted: data.autoAttempted,
      // Older one-shot states resume periodic naming from their saved position.
      lastAttemptTurn: typeof data.lastAttemptTurn === "number" &&
        Number.isSafeInteger(data.lastAttemptTurn) && data.lastAttemptTurn >= 0
        ? data.lastAttemptTurn
        : countCompletedTurns(entries.slice(0, index)),
      title: typeof data.title === "string" ? data.title : undefined,
    };
  }
  return state;
};

const isSubstantive = (text: string) =>
  text.length >= 16 && (text.match(/[\p{L}\p{N}]+/gu)?.length ?? 0) >= 3;

export const buildTaskContext = (entries: readonly SessionEntryLike[]): string | undefined => {
  const messages: string[] = [];
  let hasSubstantiveUser = false;
  let hasCompletedAssistant = false;

  for (const entry of entries) {
    if (entry.type !== "message" || !entry.message?.role) continue;
    const text = textFromContent(entry.message.content);
    if (!text) continue;

    if (entry.message.role === "user") {
      if (isSubstantive(text)) hasSubstantiveUser = true;
      messages.push(`User: ${text.slice(0, 6000)}`);
    } else if (
      entry.message.role === "assistant" &&
      entry.message.stopReason === "stop"
    ) {
      if (hasSubstantiveUser) hasCompletedAssistant = true;
      messages.push(`Assistant: ${text.slice(0, 3000)}`);
    }
  }

  if (!hasSubstantiveUser || !hasCompletedAssistant) return undefined;
  return messages.slice(-8).join("\n\n").slice(-12_000);
};

export const normalizeGeneratedTitle = (raw: string): string | undefined => {
  let title = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!title) return undefined;

  title = title
    .replace(/^title\s*:\s*/i, "")
    .replace(/[*_`#]/g, "")
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .replace(/[.!?]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!title) return undefined;
  title = title.split(" ").slice(0, 6).join(" ");
  const codePoints = [...title];
  return codePoints.length <= 80 ? title : codePoints.slice(0, 79).join("") + "…";
};

export const normalizeExplicitTitle = (raw: string): string | undefined => {
  const title = raw.replace(/\s+/g, " ").trim();
  if (!title) return undefined;
  const codePoints = [...title];
  return codePoints.length <= 120 ? title : codePoints.slice(0, 119).join("") + "…";
};

export const isSolePaneTabResponse = (stdout: string, tabId: string): boolean => {
  try {
    const response = JSON.parse(stdout) as {
      result?: { tab?: { tab_id?: unknown; pane_count?: unknown } };
    };
    return (
      response.result?.tab?.tab_id === tabId &&
      response.result.tab.pane_count === 1
    );
  } catch {
    return false;
  }
};

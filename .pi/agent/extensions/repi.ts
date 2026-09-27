import { existsSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

type ThinkingLevel = Parameters<ExtensionAPI["setThinkingLevel"]>[0];

const THINKING_LEVELS = new Set<ThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

interface RuntimeCommand {
  action:
    | "history"
    | "prompt"
    | "steer"
    | "abort"
    | "set_model"
    | "set_thinking";
  text?: string;
  provider?: string;
  modelId?: string;
  level?: string;
}

export default function roveExtension(pi: ExtensionAPI): void {
  let socket: Socket | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let stopped = false;
  let context: ExtensionContext | null = null;
  let threadId: string | null = null;

  const send = (message: unknown): void => {
    if (socket?.writable) socket.write(`${JSON.stringify(message)}\n`);
  };

  const runtimeInfo = (ctx: ExtensionContext): Record<string, unknown> => ({
    threadId: threadId ?? ctx.sessionManager.getSessionId(),
    pid: process.pid,
    cwd: ctx.cwd,
    sessionId: ctx.sessionManager.getSessionId(),
    ...(ctx.sessionManager.getSessionFile()
      ? { sessionFile: ctx.sessionManager.getSessionFile() }
      : {}),
    ...(pi.getSessionName() ? { sessionName: pi.getSessionName() } : {}),
    ...(ctx.model ? { model: `${ctx.model.provider}/${ctx.model.id}` } : {}),
    ...(process.env.HERDR_WORKSPACE_ID
      ? { herdrWorkspace: process.env.HERDR_WORKSPACE_ID }
      : {}),
    ...(process.env.HERDR_TAB_ID ? { herdrTab: process.env.HERDR_TAB_ID } : {}),
    ...(process.env.HERDR_PANE_ID
      ? { herdrPane: process.env.HERDR_PANE_ID }
      : {}),
  });

  const register = (): void => {
    if (context) send({ type: "register", runtime: runtimeInfo(context) });
  };

  const nameSession = (ctx: ExtensionContext, pendingMessage?: unknown): void => {
    const currentName = pi.getSessionName();
    const defaultName = process.env.ROVE_DEFAULT_SESSION_NAME;
    if (currentName && currentName !== defaultName) return;
    const name = automaticSessionName({
      currentName,
      defaultName,
      entries: ctx.sessionManager.getEntries(),
      branch: ctx.sessionManager.getBranch(),
      pendingMessage,
    });
    if (name) pi.setSessionName(name);
  };

  const scheduleReconnect = (): void => {
    if (stopped || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      openSocket();
    }, 1_000);
    reconnectTimer.unref();
  };

  const handleCommand = async (
    id: string,
    command: RuntimeCommand,
  ): Promise<void> => {
    const ctx = context;
    if (!ctx) throw new Error("Pi session is not ready");
    switch (command.action) {
      case "history":
        send({
          type: "response",
          id,
          ok: true,
          result: {
            messages: projectHistory(ctx.sessionManager.getBranch()),
          },
        });
        return;
      case "prompt":
        if (!command.text) throw new Error("prompt text is required");
        pi.sendUserMessage(command.text);
        break;
      case "steer":
        if (!command.text) throw new Error("steering text is required");
        pi.sendUserMessage(command.text, { deliverAs: "steer" });
        break;
      case "abort":
        ctx.abort();
        break;
      case "set_model": {
        if (!command.provider || !command.modelId)
          throw new Error("provider and model are required");
        const model = ctx.modelRegistry.find(command.provider, command.modelId);
        if (!model)
          throw new Error(
            `model not found: ${command.provider}/${command.modelId}`,
          );
        if (!(await pi.setModel(model)))
          throw new Error("model authentication is unavailable");
        break;
      }
      case "set_thinking":
        if (
          !command.level ||
          !THINKING_LEVELS.has(command.level as ThinkingLevel)
        ) {
          throw new Error("thinking level is invalid");
        }
        pi.setThinkingLevel(command.level as ThinkingLevel);
        break;
    }
    send({ type: "response", id, ok: true, result: { accepted: true } });
  };

  const handleLine = (line: string): void => {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!message || typeof message !== "object") return;
    const record = message as Record<string, unknown>;
    if (
      record.type !== "command" ||
      typeof record.id !== "string" ||
      !record.command
    )
      return;
    void handleCommand(record.id, record.command as RuntimeCommand).catch(
      (error: unknown) => {
        send({
          type: "response",
          id: record.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    );
  };

  const openSocket = (): void => {
    if (stopped || socket) return;
    const candidate = connect(runtimeSocketPath());
    const decoder = new StringDecoder("utf8");
    let inputBuffer = "";
    socket = candidate;
    candidate.on("connect", register);
    candidate.on("data", (chunk: Buffer) => {
      inputBuffer += decoder.write(chunk);
      while (true) {
        const newline = inputBuffer.indexOf("\n");
        if (newline < 0) break;
        let line = inputBuffer.slice(0, newline);
        inputBuffer = inputBuffer.slice(newline + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        handleLine(line);
      }
    });
    candidate.on("error", () => undefined);
    candidate.on("close", () => {
      if (socket === candidate) socket = null;
      scheduleReconnect();
    });
  };

  pi.on("session_start", (_event, ctx) => {
    stopped = false;
    context = ctx;
    threadId = process.env.ROVE_THREAD_ID || process.env.REPI_THREAD_ID || ctx.sessionManager.getSessionId();
    nameSession(ctx);
    openSocket();
    register();
  });

  pi.on("session_info_changed", (_event, ctx) => {
    context = ctx;
    register();
  });
  pi.on("model_select", (_event, ctx) => {
    context = ctx;
    register();
  });

  const forward = (event: unknown, ctx: ExtensionContext): void => {
    context = ctx;
    send({ type: "event", event });
  };
  pi.on("agent_start", forward);
  pi.on("agent_end", forward);
  pi.on("agent_settled", forward);
  pi.on("message_start", forward);
  pi.on("message_update", forward);
  pi.on("message_end", (event, ctx) => {
    forward(event, ctx);
    if (event.message.role === "user") nameSession(ctx, event.message);
  });
  pi.on("tool_execution_start", forward);
  pi.on("tool_execution_update", forward);
  pi.on("tool_execution_end", forward);

  pi.on("session_shutdown", () => {
    stopped = true;
    context = null;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    socket?.destroy();
    socket = null;
  });
}

function projectHistory(entries: unknown[]): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    if (
      record.type !== "message" ||
      !record.message ||
      typeof record.message !== "object"
    )
      continue;
    const message = record.message as Record<string, unknown>;
    if (message.role !== "user" && message.role !== "assistant") continue;
    const text = messageText(message.content);
    if (!text) continue;
    const projected: Record<string, unknown> = {
      id: typeof record.id === "string" ? record.id : "unknown",
      role: message.role,
      text,
    };
    if (typeof message.timestamp === "number")
      projected.messageTimestamp = message.timestamp;
    if (typeof record.timestamp === "string")
      projected.timestamp = record.timestamp;
    messages.push(projected);
  }
  return messages;
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) => {
      if (!part || typeof part !== "object") return [];
      const record = part as Record<string, unknown>;
      return record.type === "text" && typeof record.text === "string"
        ? [record.text]
        : [];
    })
    .join("\n");
}

function runtimeSocketPath(): string {
  const current = join(homedir(), ".rove");
  const legacy = join(homedir(), ".repi");
  const root = process.env.ROVE_HOME || process.env.REPI_HOME ||
    (!existsSync(current) && existsSync(legacy) ? legacy : current);
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\repi-runtime-${Buffer.from(join(root, "host")).toString("base64url")}`;
  }
  return join(root, "host", "runtime.sock");
}

const TITLE_LENGTH = 60;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Use readable prompt text without turning code or attached context into a title. */
export function titleFromPrompt(text: string): string | undefined {
  const withoutContext = text
    .replace(/<!--[^]*?-->/g, "")
    .replace(/<(environment_context|system-reminder|system_reminder|attachments?|skill)\b[^>]*>[^]*?<\/\1>/gi, "");
  let fence: string | undefined;
  const lines: string[] = [];
  for (const line of withoutContext.split(/\r?\n/)) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (marker) {
      const value = marker[1]!;
      if (!fence) fence = value;
      else if (value[0] === fence[0] && value.length >= fence.length) fence = undefined;
      continue;
    }
    if (fence) continue;
    lines.push(line);
  }
  const normalized = lines.join("\n")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+(?:\[[ xX]\]\s*)?|\d+[.)]\s+)/gm, "")
    .replace(/[`*~]/g, "")
    .replace(/\b_([^_\n]+)_\b/g, "$1")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized || !/[\p{L}\p{N}]/u.test(normalized)) return undefined;
  const parts = Array.from(graphemes.segment(normalized), ({ segment }) => segment);
  if (parts.length <= TITLE_LENGTH) return normalized;
  let prefix = parts.slice(0, TITLE_LENGTH - 1).join("");
  const boundary = prefix.lastIndexOf(" ");
  if (boundary > prefix.length / 2) prefix = prefix.slice(0, boundary);
  return `${prefix.trimEnd()}…`;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function userPrompt(message: unknown): string | undefined {
  const value = record(message);
  if (value?.role !== "user") return undefined;
  if (typeof value.content === "string") return value.content;
  if (!Array.isArray(value.content)) return undefined;
  return value.content.flatMap((part) => {
    const content = record(part);
    return content?.type === "text" && typeof content.text === "string" ? [content.text] : [];
  }).join("\n");
}

export function automaticSessionName(options: {
  currentName: string | undefined;
  defaultName: string | undefined;
  entries: readonly unknown[];
  branch: readonly unknown[];
  pendingMessage?: unknown;
}): string | undefined {
  const { currentName, defaultName, entries, branch, pendingMessage } = options;
  if (currentName && currentName !== defaultName) return undefined;
  // An empty session_info entry is an intentional user clear, not an unnamed session.
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = record(entries[index]);
    if (entry?.type !== "session_info") continue;
    if (typeof entry.name !== "string" || !entry.name.trim()) return undefined;
    break;
  }
  const messages = branch.flatMap((value) => {
    const entry = record(value);
    return entry?.type === "message" ? [entry.message] : [];
  });
  // Pi emits message_end before it appends the message to the session file.
  if (pendingMessage) messages.push(pendingMessage);
  for (const message of messages) {
    const prompt = userPrompt(message);
    const title = prompt && titleFromPrompt(prompt);
    if (title) return title === currentName ? undefined : title;
  }
  return undefined;
}

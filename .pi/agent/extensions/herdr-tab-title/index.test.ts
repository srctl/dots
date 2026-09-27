import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import herdrTabTitle from "./index.ts";

type Entry = { type: string; message?: { role: string; content: string; stopReason?: string }; customType?: string; data?: unknown };

function harness(options: { lunaAvailable?: boolean; paneCount?: number; renameFails?: boolean } = {}) {
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
  const entries: Entry[] = [];
  const modelCalls: unknown[] = [];
  const renames: string[] = [];
  const sessionNames: string[] = [];
  const pendingEvents: Promise<unknown>[] = [];
  const luna = { provider: "openai-codex", id: "gpt-5.6-luna" };
  let nextTitle = "Improve tab naming";
  let complete = async () => ({ stopReason: "stop", content: [{ type: "text", text: nextTitle }] });
  const ctx = {
    mode: "tui",
    model: { provider: "anthropic", id: "different-chat-model" },
    modelRegistry: {
      find: (provider: string, id: string) => {
        assert.equal(provider, "openai-codex");
        assert.equal(id, "gpt-5.6-luna");
        return options.lunaAvailable === false ? undefined : luna;
      },
      complete: async (model: unknown) => { modelCalls.push(model); return complete(); },
    },
    sessionManager: { getBranch: () => entries },
    ui: { notify: () => {} },
  } as unknown as ExtensionContext;
  const pi = {
    on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(name, handler),
    registerCommand: (name: string, command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => commands.set(name, command),
    appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
    setSessionName: (name: string) => {
      sessionNames.push(name);
      // Match Pi: setSessionName emits this event without awaiting its handlers.
      pendingEvents.push(Promise.resolve(handlers.get("session_info_changed")?.({ name }, ctx)));
    },
    exec: async (_command: string, args: string[]) => {
      if (args[1] === "rename") {
        renames.push(args[3]!);
        if (options.renameFails) return { code: 1, stdout: "" };
      }
      return { code: 0, stdout: JSON.stringify({ result: { tab: { tab_id: "test-tab", pane_count: options.paneCount ?? 1 } } }) };
    },
  } as unknown as ExtensionAPI;
  const previous = { HERDR_ENV: process.env.HERDR_ENV, HERDR_TAB_ID: process.env.HERDR_TAB_ID };
  process.env.HERDR_ENV = "1";
  process.env.HERDR_TAB_ID = "test-tab";
  try { herdrTabTitle(pi); } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  const emit = async (name: string, event: unknown = {}) => {
    await handlers.get(name)?.(event, ctx);
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  const exchange = async () => {
    entries.push(
      { type: "message", message: { role: "user", content: "Improve automatic terminal tab naming" } },
      { type: "message", message: { role: "assistant", stopReason: "stop", content: "Updated the tab naming extension" } },
    );
    await emit("agent_settled");
  };
  return { emit, exchange, modelCalls, renames, sessionNames, luna,
    retitle: async (args = "") => {
      await commands.get("retitle-tab")!.handler(args, ctx);
      await Promise.all(pendingEvents.splice(0));
    },
    setTitle: (title: string) => { nextTitle = title; },
    setComplete: (fn: typeof complete) => { complete = fn; },
  };
}

test("automatic and manual generation use Luna, with a durable three-exchange cadence", async () => {
  const h = harness();
  await h.emit("session_start");
  await h.exchange();
  assert.deepEqual(h.modelCalls, [h.luna]);
  assert.deepEqual(h.renames, ["Improve tab naming"]);
  await h.emit("agent_settled"); // Duplicate idle event is not a new turn.
  await h.exchange();
  await h.emit("session_start"); // Reload preserves the counter.
  await h.exchange();
  assert.equal(h.modelCalls.length, 1);
  h.setTitle("Fix authentication bug");
  await h.exchange();
  assert.equal(h.modelCalls.length, 2);
  assert.equal(h.renames.at(-1), "Fix authentication bug");
  await h.retitle();
  assert.deepEqual(h.modelCalls, [h.luna, h.luna, h.luna]);
  await h.retitle("My explicit title");
  assert.equal(h.modelCalls.length, 3);
  assert.equal(h.renames.at(-1), "My explicit title");
  await h.exchange();
  await h.exchange();
  assert.equal(h.modelCalls.length, 3);
  await h.exchange();
  assert.equal(h.modelCalls.length, 4);
});

test("missing Luna never falls back to the chat model", async () => {
  const h = harness({ lunaAvailable: false });
  await h.emit("session_start");
  await h.exchange();
  await h.retitle();
  assert.deepEqual(h.modelCalls, []);
  assert.deepEqual(h.renames, []);
});

test("automatic naming leaves shared tabs alone", async () => {
  const h = harness({ paneCount: 2 });
  await h.emit("session_start");
  await h.exchange();
  assert.deepEqual(h.modelCalls, []);
  assert.deepEqual(h.renames, []);
});

test("manual renaming cancels an in-flight automatic title", async () => {
  const h = harness();
  let resolve!: (value: { stopReason: string; content: { type: string; text: string }[] }) => void;
  h.setComplete(() => new Promise((done) => { resolve = done; }));
  await h.emit("session_start");
  await h.exchange();
  await h.retitle("Keep this title");
  resolve({ stopReason: "stop", content: [{ type: "text", text: "Stale automatic title" }] });
  await h.emit("agent_settled");
  assert.deepEqual(h.renames, ["Keep this title"]);
  assert.deepEqual(h.sessionNames, ["Keep this title"]);
});

test("explicit retitling names the session and syncs the tab exactly once", async () => {
  const h = harness();
  await h.emit("session_start");
  await h.retitle("  tl   design  ");
  assert.deepEqual(h.sessionNames, ["tl design"]);
  assert.deepEqual(h.renames, ["tl design"]);
  assert.deepEqual(h.modelCalls, []);
});

test("generated retitling names the session but automatic refreshes remain tab-only", async () => {
  const h = harness();
  await h.emit("session_start");
  await h.exchange();
  assert.deepEqual(h.sessionNames, []);
  h.setTitle("Define validated task workflows");
  await h.retitle();
  assert.deepEqual(h.sessionNames, ["Define validated task workflows"]);
  assert.deepEqual(h.renames, ["Improve tab naming", "Define validated task workflows"]);
  h.setTitle("Implement task validation");
  await h.exchange();
  await h.exchange();
  await h.exchange();
  assert.equal(h.renames.at(-1), "Implement task validation");
  assert.deepEqual(h.sessionNames, ["Define validated task workflows"]);
});

test("session naming succeeds even when Herdr cannot rename the tab", async () => {
  const h = harness({ renameFails: true });
  await h.emit("session_start");
  await h.retitle("tl design");
  assert.deepEqual(h.sessionNames, ["tl design"]);
  assert.deepEqual(h.renames, ["tl design"]);
});

test("/name still syncs the tab without recursively naming the session", async () => {
  const h = harness();
  await h.emit("session_start");
  await h.emit("session_info_changed", { name: "Named through Pi" });
  assert.deepEqual(h.renames, ["Named through Pi"]);
  assert.deepEqual(h.sessionNames, []);
});

test("failed title generation leaves the session name unchanged", async () => {
  const h = harness({ lunaAvailable: false });
  await h.emit("session_start");
  await h.exchange();
  await h.retitle();
  assert.deepEqual(h.sessionNames, []);
  assert.deepEqual(h.renames, []);
});

test("failed generation is retried after three exchanges instead of stopping forever", async () => {
  const h = harness();
  h.setComplete(async () => { throw new Error("temporary provider failure"); });
  await h.emit("session_start");
  await h.exchange();
  await h.exchange();
  await h.exchange();
  assert.equal(h.modelCalls.length, 1);
  await h.exchange();
  assert.equal(h.modelCalls.length, 2);
  assert.deepEqual(h.renames, []);
});

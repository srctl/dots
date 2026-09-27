import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTaskContext,
  countCompletedTurns,
  isAutoTitleDue,
  isInteractiveHerdrSession,
  isSolePaneTabResponse,
  normalizeExplicitTitle,
  normalizeGeneratedTitle,
  restoreState,
  STATE_ENTRY_TYPE,
} from "./core.ts";

test("activates only for the main interactive Pi session in Herdr", () => {
  assert.equal(
    isInteractiveHerdrSession({ herdrEnv: "1", tabId: "w1:t2", mode: "tui" }),
    true,
  );
  assert.equal(
    isInteractiveHerdrSession({ herdrEnv: "1", tabId: "w1:t2", mode: "print" }),
    false,
  );
  assert.equal(
    isInteractiveHerdrSession({ herdrEnv: undefined, tabId: "w1:t2", mode: "tui" }),
    false,
  );
});

test("restores the latest durable title state", () => {
  const entries = [
    { type: "custom", customType: STATE_ENTRY_TYPE, data: { autoAttempted: true } },
    { type: "custom", customType: "other", data: { autoAttempted: false } },
    {
      type: "custom",
      customType: STATE_ENTRY_TYPE,
      data: { autoAttempted: true, title: "Make dotctl agent-friendly" },
    },
  ];

  assert.deepEqual(restoreState(entries), {
    autoAttempted: true,
    lastAttemptTurn: 0,
    title: "Make dotctl agent-friendly",
  });
});

test("requires a substantive completed agent turn before building title context", () => {
  assert.equal(
    buildTaskContext([
      { type: "message", message: { role: "user", content: "Hello" } },
      {
        type: "message",
        message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Hi!" }] },
      },
    ]),
    undefined,
  );

  const context = buildTaskContext([
    {
      type: "message",
      message: {
        role: "user",
        content: "Make dotctl easier for coding agents to use.",
      },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "Updated the agent instructions and checks." }],
      },
    },
  ]);

  assert.match(context ?? "", /Make dotctl easier/);
  assert.match(context ?? "", /Updated the agent instructions/);
});

test("counts completed exchanges, not tool iterations or failed replies", () => {
  const message = (role: string, stopReason?: string) => ({ type: "message", message: { role, stopReason } });
  assert.equal(countCompletedTurns([
    message("user"), message("assistant", "toolUse"), message("toolResult"),
    message("assistant", "error"), message("assistant", "stop"),
    message("assistant", "stop"), message("user"), message("assistant", "aborted"),
  ]), 1);
});

test("titles the first exchange then every three completed exchanges", () => {
  assert.equal(isAutoTitleDue({ autoAttempted: false }, 0), false);
  assert.equal(isAutoTitleDue({ autoAttempted: false }, 1), true);
  const state = { autoAttempted: true, lastAttemptTurn: 1 };
  for (const turns of [1, 2, 3]) assert.equal(isAutoTitleDue(state, turns), false);
  assert.equal(isAutoTitleDue(state, 4), true);
});

test("migrates one-shot state and preserves the cadence across reloads", () => {
  const entries = [
    { type: "message", message: { role: "user" } },
    { type: "message", message: { role: "assistant", stopReason: "stop" } },
    { type: "custom", customType: STATE_ENTRY_TYPE, data: { autoAttempted: true, title: "Old title" } },
  ];
  const state = restoreState(entries);
  assert.equal(state.lastAttemptTurn, 1);
  assert.equal(isAutoTitleDue(state, 3), false);
  assert.equal(isAutoTitleDue(state, 4), true);
  assert.deepEqual(restoreState([
    { type: "custom", customType: STATE_ENTRY_TYPE, data: { ...state, lastAttemptTurn: 4 } },
  ]), { ...state, lastAttemptTurn: 4 });
});

test("keeps the newest task when the context budget is exceeded", () => {
  const entries = Array.from({ length: 4 }, () => [
    { type: "message", message: { role: "user", content: "Implement the feature " + "x".repeat(6000) } },
    { type: "message", message: { role: "assistant", stopReason: "stop", content: "y".repeat(3000) } },
  ]).flat();
  entries.push({ type: "message", message: { role: "user", content: "Now fix the latest authentication bug" } });
  entries.push({ type: "message", message: { role: "assistant", stopReason: "stop", content: "Fixed the latest authentication bug" } });
  const context = buildTaskContext(entries)!;
  assert.ok(context.length <= 12_000);
  assert.ok(context.endsWith("Fixed the latest authentication bug"));
});

test("normalizes generated titles without blindly copying a long response", () => {
  assert.equal(
    normalizeGeneratedTitle('Title: **“Make dotctl agent-friendly today”**\nExtra explanation'),
    "Make dotctl agent-friendly today",
  );
  assert.equal(
    normalizeGeneratedTitle("Implement automatic semantic Herdr tab titles with repeated churn"),
    "Implement automatic semantic Herdr tab titles",
  );
  assert.equal(normalizeExplicitTitle("  Keep   my exact title  "), "Keep my exact title");
});

test("auto ownership fails closed unless the explicit tab has one pane", () => {
  const response = (tabId: string, paneCount: number) =>
    JSON.stringify({ result: { type: "tab_info", tab: { tab_id: tabId, pane_count: paneCount } } });

  assert.equal(isSolePaneTabResponse(response("w1:t2", 1), "w1:t2"), true);
  assert.equal(isSolePaneTabResponse(response("w1:t2", 2), "w1:t2"), false);
  assert.equal(isSolePaneTabResponse(response("w1:t3", 1), "w1:t2"), false);
  assert.equal(isSolePaneTabResponse("not json", "w1:t2"), false);
});

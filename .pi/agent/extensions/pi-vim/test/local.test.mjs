import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";

// Use the running Pi's loader and dependencies, not a second installed Pi.
const host = process.env.PI_PACKAGE_ROOT;
if (!host)
  throw new Error(
    "Set PI_PACKAGE_ROOT to the installed pi-coding-agent package directory",
  );
const hostImport = (path) => import(pathToFileURL(join(host, path)).href);
const { loadExtensions } = await hostImport("dist/core/extensions/loader.js");
const { KeybindingsManager } = await hostImport("dist/core/keybindings.js");
const require = createRequire(join(host, "package.json"));
const { visibleWidth, ScrollView } = await import(
  pathToFileURL(require.resolve("@earendil-works/pi-tui")).href
);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const plain = (line) =>
  stripVTControlCharacters(line.replaceAll("\x1b_pi:c\x07", ""));
const identity = (text) => text;

async function setup(t, responseLines = []) {
  const loaded = await loadExtensions([join(root, "index.ts")], root);
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions[0];
  const statuses = [];
  let editor;
  let overlay;
  const clipboard = [];
  const frames = [];
  const transcript = new ScrollView(
    { render: () => responseLines, invalidate() {} },
    { follow: "end" },
  );
  transcript.updateLayout(responseLines.length, 9, () => {});
  const tui = {
    requestRender() {
      if (overlay) frames.push(overlay.render(this.terminal.columns));
    },
    terminal: { rows: 12, columns: 80, write() {} },
    children: [transcript],
    showOverlay(component) {
      overlay = component;
      return {
        hide() {
          overlay = undefined;
        },
      };
    },
  };
  const theme = {
    borderColor: identity,
    selectList: Object.fromEntries(
      [
        "selectedPrefix",
        "selectedText",
        "description",
        "scrollInfo",
        "noMatch",
      ].map((key) => [key, identity]),
    ),
  };
  const ctx = {
    mode: "tui",
    sessionManager: { getBranch: () => [] },
    ui: {
      setStatus: (_key, value) => statuses.push(value),
      notify() {},
      setEditorComponent: (factory) => {
        editor = factory(tui, theme, new KeybindingsManager());
      },
    },
  };
  for (const handler of extension.handlers.get("session_start") ?? [])
    await handler({ type: "session_start" }, ctx);
  t.after(async () => {
    editor.setText("");
    for (const handler of extension.handlers.get("session_shutdown") ?? [])
      await handler({ type: "session_shutdown" }, ctx);
  });
  editor.setClipboardWriterForTests((text) => clipboard.push(text));
  editor.setClipboardReaderForTests(() => "");
  return {
    editor,
    statuses,
    clipboard,
    frames,
    tui,
    transcript,
    responseRows: (width = tui.terminal.columns) =>
      overlay?.render(width) ?? [],
    emit: async (event) => {
      for (const handler of extension.handlers.get(event.type) ?? [])
        await handler(event, ctx);
    },
  };
}

const send = (editor, keys) => {
  for (const key of keys) editor.handleInput(key);
};

test("real extension loader: glyph, Escape, Vim editing, and return to insert", async (t) => {
  const { editor, statuses } = await setup(t);
  send(editor, "hello world");
  editor.setPaddingX(1); // Pi copies its default padding after the factory returns.
  assert.ok(plain(editor.render(40)[1]).startsWith("❯ hello world"));
  editor.handleInput("\x1b");
  assert.equal(statuses.at(-1), "NORMAL");
  send(editor, "0dw");
  assert.equal(editor.getText(), "world");
  send(editor, "i!");
  assert.equal(editor.getText(), "!world");
  assert.equal(statuses.at(-1), "INSERT");
});

test("glyph rendering fits narrow and wrapped editors", async (t) => {
  const { editor } = await setup(t);
  send(editor, "hello world long prompt\nsecond line");
  for (const width of [3, 4, 5, 8, 20, 80]) {
    const lines = editor.render(width);
    for (const line of lines)
      assert.ok(visibleWidth(line) <= width, `overflow at width ${width}`);
    if (width >= 5) assert.ok(plain(lines[1]).startsWith("❯ "));
  }
});

test("visual selection and Flash labels respect the glyph padding", async (t) => {
  const { editor } = await setup(t);
  send(editor, "abc def");
  editor.handleInput("\x1b");
  send(editor, "0v");
  const selected = editor.render(40)[1];
  assert.ok(selected.includes("❯ "));
  assert.match(selected, /\x1b\[7ma/);
  send(editor, "d");
  assert.equal(editor.getText(), "bc def");
  send(editor, "A f\x1b0sf"); // Two matches keep labels visible instead of jumping immediately.
  const flashed = plain(editor.render(40)[1]);
  assert.ok(flashed.startsWith("❯ bc dea s"), flashed);
});

test("Ctrl+P/N navigate autocomplete without taking model cycling elsewhere", async (t) => {
  const { editor } = await setup(t);
  let cycles = 0;
  editor.onAction("app.model.cycleForward", () => {
    cycles++;
  });
  editor.handleInput("\x10");
  assert.equal(cycles, 1);
  editor.setAutocompleteProvider({
    getSuggestions: () => ({
      prefix: "/",
      items: [
        { value: "/alpha", label: "/alpha" },
        { value: "/beta", label: "/beta" },
        { value: "/gamma", label: "/gamma" },
      ],
    }),
    applyCompletion: (_lines, _line, _col, item) => ({
      lines: [item.value],
      cursorLine: 0,
      cursorCol: item.value.length,
    }),
  });
  editor.handleInput("/");
  // Autocomplete is asynchronous in Pi 0.87.
  for (
    let attempt = 0;
    attempt < 50 && !editor.isShowingAutocomplete();
    attempt++
  ) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(editor.isShowingAutocomplete());
  send(editor, ["\x0e", "\x0e", "\x10", "\t"]);
  assert.equal(editor.getText(), "/beta");
  assert.equal(cycles, 1);
});

// Regression cases exercise the editor through key input, not private fields.
for (const example of [
  {
    name: "counted delete",
    text: "one two three",
    keys: "\x1b02dw",
    expected: "three",
  },
  {
    name: "change inner word",
    text: "hello world",
    keys: "\x1b0ciwHi\x1b",
    expected: "Hi world",
  },
  {
    name: "change quoted text",
    text: '"hello" world',
    keys: '\x1b0lci"Hi\x1b',
    expected: '"Hi" world',
  },
  {
    name: "matching delimiter",
    text: "(one [two])",
    keys: "\x1b0%rX",
    expected: "(one [two]X",
  },
  {
    name: "delete and put register",
    text: "abcd",
    keys: "\x1b02xP",
    expected: "abcd",
  },
  {
    name: "linewise delete",
    text: "one\ntwo",
    keys: "\x1bggdd",
    expected: "two",
  },
  {
    name: "join lines",
    text: "one\ntwo",
    keys: "\x1bggJ",
    expected: "one two",
  },
  {
    name: "empty first line",
    text: "\ntext",
    keys: "\x1bgg$i!",
    expected: "!\ntext",
  },
]) {
  test(`prompt regression: ${example.name}`, async (t) => {
    const { editor } = await setup(t);
    editor.setText(example.text);
    send(editor, example.keys);
    assert.equal(editor.getText(), example.expected);
  });
}

const waitForScroll = () => new Promise((resolve) => setTimeout(resolve, 260));
const cursorMarker = "\x1b_pi:c\x07";
function cursorText(rows) {
  const line = rows.find((row) => row.includes(cursorMarker));
  assert.ok(line, "response pane should render a cursor");
  return plain(
    line.slice(line.indexOf(cursorMarker) + cursorMarker.length),
  ).trimEnd();
}

test("k enters responses at the visible end, motions select and yank, i restores the draft", async (t) => {
  const pane = await setup(t, [
    "first response",
    "second response",
    "last response",
    "",
  ]);
  send(pane.editor, "draft\x1bk");
  assert.equal(cursorText(pane.responseRows()), "last response");
  assert.equal(pane.statuses.at(-1), "RESPONSES · NORMAL");
  assert.ok(
    pane.editor.render(80).every((line) => !line.includes(cursorMarker)),
  );
  send(pane.editor, "kwve");
  assert.equal(cursorText(pane.responseRows()), "e");
  send(pane.editor, "y");
  assert.deepEqual(pane.clipboard, ["response"]);
  assert.equal(pane.statuses.at(-1), "RESPONSES · NORMAL");
  send(pane.editor, "i!");
  assert.equal(pane.editor.getText(), "draft!");
  assert.deepEqual(pane.responseRows(), []);
  assert.equal(pane.statuses.at(-1), "INSERT");
});

test("k moves inside a multiline draft before entering responses; response edits are ignored", async (t) => {
  const pane = await setup(t, ["response"]);
  pane.editor.setText("first\nsecond");
  send(pane.editor, "\x1bk");
  assert.deepEqual(pane.responseRows(), []);
  send(pane.editor, "kddccx\r");
  assert.equal(cursorText(pane.responseRows()), "response");
  assert.equal(pane.editor.getText(), "first\nsecond");
});

test("V selects full response lines; Escape cancels selection before leaving the pane", async (t) => {
  const pane = await setup(t, ["one", "two", "three"]);
  send(pane.editor, "\x1bkVk");
  assert.equal(pane.statuses.at(-1), "RESPONSES · VISUAL LINE");
  send(pane.editor, "y");
  assert.deepEqual(pane.clipboard, ["two\nthree"]);
  send(pane.editor, "v\x1b");
  assert.equal(pane.statuses.at(-1), "RESPONSES · NORMAL");
  assert.equal(cursorText(pane.responseRows()), "two");
  send(pane.editor, "\x1b");
  assert.deepEqual(pane.responseRows(), []);
  assert.equal(pane.statuses.at(-1), "NORMAL");
});

test("cursor follows page and boundary motions, without losing focus at transcript end", async (t) => {
  const lines = Array.from({ length: 50 }, (_, index) => `row ${index}`);
  const pane = await setup(t, lines);
  send(pane.editor, "\x1bkgg");
  assert.equal(cursorText(pane.responseRows()), "row 0");
  send(pane.editor, ["\x04"]);
  assert.equal(cursorText(pane.responseRows()), "row 4");
  send(pane.editor, "Gjj");
  assert.equal(cursorText(pane.responseRows()), "row 49");
  send(pane.editor, "q");
  assert.deepEqual(pane.responseRows(), []);
});

test("response cursor handles Unicode, streaming, resize, and an empty transcript", async (t) => {
  const lines = ["a界🙂z"];
  const pane = await setup(t, lines);
  send(pane.editor, "\x1bkllvly");
  assert.deepEqual(pane.clipboard, ["🙂z"]);
  lines.push("new streamed line");
  await pane.emit({ type: "message_update" });
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(cursorText(pane.responseRows()), "z");
  pane.tui.terminal.columns = 20;
  pane.tui.terminal.rows = 8;
  assert.equal(cursorText(pane.responseRows()), "z");
  for (const row of pane.responseRows()) assert.ok(visibleWidth(row) <= 20);
  send(pane.editor, "i");
  lines.splice(0);
  await pane.emit({ type: "message_update" });
  send(pane.editor, "\x1bk");
  assert.equal(cursorText(pane.responseRows()), "");
});

test("Ctrl+L/H animate half a page through intermediate rendered rows", async (t) => {
  const pane = await setup(
    t,
    Array.from({ length: 50 }, (_, index) => `row ${index}`),
  );
  let modelPickerCalls = 0;
  pane.editor.onAction("app.model.select", () => {
    modelPickerCalls++;
  });
  send(pane.editor, "\x1bkgg");
  pane.frames.length = 0;
  send(pane.editor, "\x0c");
  await waitForScroll();
  assert.equal(cursorText(pane.responseRows()), "row 4");
  assert.ok(
    pane.frames.some((rows) => /^row [1-3]$/.test(cursorText(rows))),
    "scroll must draw intermediate positions",
  );
  assert.equal(plain(pane.responseRows()[0]).trim(), "row 4");
  send(pane.editor, "\x08");
  await waitForScroll();
  assert.equal(cursorText(pane.responseRows()), "row 0");
  assert.equal(modelPickerCalls, 0);
});

test("animated scroll accumulates repeated keys, reverses, and stops at boundaries", async (t) => {
  const pane = await setup(
    t,
    Array.from({ length: 50 }, (_, index) => `row ${index}`),
  );
  send(pane.editor, "\x1bkgg\x0c\x0c");
  await waitForScroll();
  assert.equal(cursorText(pane.responseRows()), "row 8");
  send(pane.editor, "\x0c");
  await new Promise((resolve) => setTimeout(resolve, 45));
  const rowBeforeReverse = Number(cursorText(pane.responseRows()).slice(4));
  send(pane.editor, "\x08");
  await waitForScroll();
  assert.equal(cursorText(pane.responseRows()), `row ${rowBeforeReverse - 4}`);
  send(pane.editor, "G\x0c");
  await waitForScroll();
  assert.equal(cursorText(pane.responseRows()), "row 49");
  send(pane.editor, "gg\x08");
  await waitForScroll();
  assert.equal(cursorText(pane.responseRows()), "row 0");
});

test("A leaves response selection, appends at the end of a multiline draft, and cancels animation", async (t) => {
  const pane = await setup(
    t,
    Array.from({ length: 50 }, (_, index) => `row ${index}`),
  );
  pane.editor.setText("first\nsecond");
  send(pane.editor, "\x1bggkggv\x0cA!");
  assert.equal(pane.editor.getText(), "first\nsecond!");
  assert.equal(pane.statuses.at(-1), "INSERT");
  assert.deepEqual(pane.responseRows(), []);
  send(pane.editor, "\x1bggkgg");
  await waitForScroll();
  assert.equal(
    cursorText(pane.responseRows()),
    "row 0",
    "old animation must not affect a reopened pane",
  );
});

test("Normal-mode A appends to the whole draft; Insert-mode shortcuts remain native", async (t) => {
  const pane = await setup(t, ["response"]);
  let modelPickerCalls = 0;
  pane.editor.onAction("app.model.select", () => {
    modelPickerCalls++;
  });
  pane.editor.setText("first\nsecond");
  send(pane.editor, "\x1bggA!");
  assert.equal(pane.editor.getText(), "first\nsecond!");
  send(pane.editor, "\x0c\x08");
  assert.equal(modelPickerCalls, 1);
  assert.equal(pane.editor.getText(), "first\nsecond");
  assert.deepEqual(pane.responseRows(), []);
});

test("Ctrl+H can enter responses directly from Normal mode and shutdown cancels scrolling", async (t) => {
  const pane = await setup(
    t,
    Array.from({ length: 50 }, (_, index) => `row ${index}`),
  );
  send(pane.editor, "\x1b\x08");
  await waitForScroll();
  assert.equal(cursorText(pane.responseRows()), "row 45");
  send(pane.editor, "\x08");
  await pane.emit({ type: "session_shutdown" });
  const framesBeforeWait = pane.frames.length;
  await waitForScroll();
  assert.equal(
    pane.frames.length,
    framesBeforeWait,
    "closed pane should not render animation frames",
  );
  assert.deepEqual(pane.responseRows(), []);
});

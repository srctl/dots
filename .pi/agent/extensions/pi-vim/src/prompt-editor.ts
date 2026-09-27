/**
 * Prompt editor and key routing.
 *
 * Key handling has three destinations: Insert mode delegates to Pi, the
 * response pane consumes read-only navigation, and Normal/Visual prompt modes
 * edit the draft. `mode` belongs to the prompt. The response-session module
 * owns the footer's display mode, which may describe a response selection.
 *
 * A pending command stores keys until a Vim sequence is complete. For example,
 * `2dw` stores a count of 2, then a delete operator, then executes the w motion.
 */
import {
  openExternalUrl,
  readClipboard,
  writeClipboard,
} from "./parts/system-clipboard.ts";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { nativeTranscriptComponents } from "./parts/scrollback.ts";
import {
  ensureScrollback,
  leaveScrollback,
  responseSession,
  MESSAGE_ACTION_COMMAND,
  noteInput,
  queueSelectedUserMessageAction,
  requestScrollRender,
  setCurrentMode,
} from "./parts/response-session.ts";
import type { CursorPos, FlashTarget, Mode } from "./parts/types.ts";
import {
  findCharacter,
  lineBounds,
  motionTarget,
  operatorRange,
  textObjectRange,
  type TextObjectKind,
  type VimMotion,
} from "./parts/vim-operations.ts";

function hideInsertCursor(lines: string[]): string[] {
  const cursorMarker = "\x1b_pi:c\x07";
  return lines.map((line) => {
    const markerIndex = line.indexOf(cursorMarker);
    if (markerIndex === -1) return line;
    const before = line.slice(0, markerIndex + cursorMarker.length);
    const after = line.slice(markerIndex + cursorMarker.length);
    return before + after.replace(/\x1b\[7m([\s\S]*?)\x1b\[(?:0|27)m/, "$1");
  });
}

export class ScrollEditor extends CustomEditor {
  private mode: Mode = "insert";
  private pendingG = false;
  private pendingOperator: "d" | "c" | "y" | undefined;
  private operatorCount = 1;
  private pendingCount = "";
  private pendingTextObject: TextObjectKind | undefined;
  private pendingFind:
    | {
        direction: 1 | -1;
        until: boolean;
        operator?: "d" | "c" | "y";
        count: number;
      }
    | undefined;
  private pendingReplaceCount: number | undefined;
  private lastFind:
    { char: string; direction: 1 | -1; until: boolean } | undefined;
  private register: { text: string; linewise: boolean } = {
    text: "",
    linewise: false,
  };
  private visualAnchor: CursorPos | undefined;
  private flashAwaitingChar = false;
  private flashQuery = "";
  private flashTargets: FlashTarget[] = [];
  private scrollFlashAwaitingChar = false;
  private clipboardWriterForTests: ((text: string) => void) | undefined;
  private clipboardReaderForTests: (() => string) | undefined;
  private readonly flashLabels =
    "asdfghjklqwertyuiopzxcvbnmASDFGHJKLQWERTYUIOPZXCVBNM1234567890";

  private setMode(mode: Mode): void {
    const enteringVisual =
      (mode === "visual" || mode === "visualLine") &&
      this.mode !== "visual" &&
      this.mode !== "visualLine";
    if (enteringVisual) {
      this.visualAnchor = { ...this.getCursor() };
    } else if (mode !== "visual" && mode !== "visualLine") {
      this.visualAnchor = undefined;
    }
    if (this.mode === mode) return;
    this.pendingOperator = undefined;
    this.pendingTextObject = undefined;
    this.pendingFind = undefined;
    this.pendingReplaceCount = undefined;
    this.pendingCount = "";
    this.operatorCount = 1;
    this.pendingG = false;
    this.clearFlash();
    this.mode = mode;
    setCurrentMode(mode);
    this.tui.requestRender();
  }

  private activateScrollback(): boolean {
    if (!responseSession.context) return false;
    ensureScrollback(responseSession.context, this.tui);
    return Boolean(responseSession.pane);
  }

  private isAtStartOfBuffer(): boolean {
    const cursor = this.getCursor();
    return cursor.line === 0 && cursor.col === 0;
  }

  private comparePos(a: CursorPos, b: CursorPos): number {
    if (a.line !== b.line) return a.line - b.line;
    return a.col - b.col;
  }

  private posToIndex(pos: CursorPos): number {
    const lines = this.getText().split("\n");
    let index = 0;
    for (let line = 0; line < Math.min(pos.line, lines.length); line++) {
      index += (lines[line]?.length ?? 0) + 1;
    }
    return index + Math.min(pos.col, lines[pos.line]?.length ?? 0);
  }

  /** Convert the selection anchor and cursor into an inclusive Vim selection. */
  private visualRange(width = this.tui.terminal.columns || 80):
    | {
        start: CursorPos;
        end: CursorPos;
        startIndex: number;
        endIndex: number;
        visualStart?: number;
        visualEnd?: number;
      }
    | undefined {
    if (!this.visualAnchor) return undefined;
    const cursor = this.getCursor();
    const text = this.getText();

    if (this.mode === "visualLine") {
      const visualLines = this.visualLineMap(width);
      const findVisualLine = (pos: CursorPos): number => {
        const found = (this as any).findVisualLineAt?.(
          visualLines,
          pos.line,
          pos.col,
        );
        return typeof found === "number" ? found : 0;
      };
      const anchorVisual = findVisualLine(this.visualAnchor);
      const cursorVisual = findVisualLine(cursor);
      const visualStart = Math.min(anchorVisual, cursorVisual);
      const visualEnd = Math.max(anchorVisual, cursorVisual);
      const first = visualLines[visualStart];
      const last = visualLines[visualEnd];
      if (!first || !last) return undefined;

      const start = { line: first.logicalLine, col: first.startCol };
      const end = { line: last.logicalLine, col: last.startCol + last.length };
      return {
        start,
        end,
        startIndex: this.posToIndex(start),
        endIndex: this.posToIndex(end),
        visualStart,
        visualEnd,
      };
    }

    const anchorFirst = this.comparePos(this.visualAnchor, cursor) <= 0;
    const start = anchorFirst ? this.visualAnchor : cursor;
    const end = anchorFirst ? cursor : this.visualAnchor;
    const startIndex = this.posToIndex(start);
    // Vim characterwise visual mode is inclusive. Clamp so selecting at EOF is safe.
    const endIndex = Math.min(text.length, this.posToIndex(end) + 1);
    return { start, end, startIndex, endIndex };
  }

  private selectedText(): string {
    const range = this.visualRange();
    return range ? this.getText().slice(range.startIndex, range.endIndex) : "";
  }

  setClipboardWriterForTests(
    writer: ((text: string) => void) | undefined,
  ): void {
    this.clipboardWriterForTests = writer;
  }

  setClipboardReaderForTests(reader: (() => string) | undefined): void {
    this.clipboardReaderForTests = reader;
  }

  private copyText(text: string, linewise = false): void {
    if (!text) return;
    this.register = { text, linewise };
    if (this.clipboardWriterForTests) {
      this.clipboardWriterForTests(text);
      return;
    }
    writeClipboard(text);
  }

  private clipboardText(): string {
    if (this.clipboardReaderForTests) return this.clipboardReaderForTests();
    return readClipboard();
  }

  /** p/P put the unnamed register after/before the cursor (or entire line). */
  private paste(after: boolean, count = 1): void {
    const value = this.register.text || this.clipboardText();
    if (!value) return;
    const repeated = value.repeat(Math.max(1, count));
    if (this.register.linewise || value.endsWith("\n")) {
      const text = this.getText();
      const index = this.posToIndex(this.getCursor());
      const bounds = lineBounds(text, index);
      const insertAt = after
        ? Math.min(text.length, bounds.end + (bounds.end < text.length ? 1 : 0))
        : bounds.start;
      let payload = repeated.endsWith("\n") ? repeated : `${repeated}\n`;
      if (
        after &&
        insertAt === text.length &&
        insertAt > 0 &&
        text[insertAt - 1] !== "\n"
      )
        payload = `\n${payload}`;
      this.setText(text.slice(0, insertAt) + payload + text.slice(insertAt));
      this.setCursorIndex(insertAt);
    } else {
      const text = this.getText();
      const index = this.posToIndex(this.getCursor());
      const insertAt =
        after && text.length ? Math.min(text.length, index + 1) : index;
      this.setText(text.slice(0, insertAt) + repeated + text.slice(insertAt));
      this.setCursorIndex(Math.max(insertAt, insertAt + repeated.length - 1));
    }
    this.tui.requestRender();
  }

  // Pi has no public setter for an arbitrary cursor position. Keep that
  // private-API dependency here; ordinary movement still delegates to Pi.
  private setCursor(pos: CursorPos): void {
    const state = (this as any).state;
    if (state) {
      state.cursorLine = pos.line;
      state.cursorCol = pos.col;
    }
  }

  private setCursorIndex(index: number): void {
    const text = this.getText();
    const safe = Math.max(0, Math.min(index, text.length));
    const before = text.slice(0, safe);
    const lastNewline = before.lastIndexOf("\n");
    this.setCursor({
      line: before.split("\n").length - 1,
      col: safe - lastNewline - 1,
    });
  }

  /** Consume the digits collected so far, e.g. the 3 in `3dw`. */
  private takeCount(fallback = 1): number {
    const value = this.pendingCount
      ? Math.min(9999, Number(this.pendingCount))
      : fallback;
    this.pendingCount = "";
    return value;
  }

  private repeatInput(data: string, count: number): void {
    for (let index = 0; index < Math.max(1, count); index++)
      super.handleInput(data);
  }

  private lineStart(lineNumber: number): number {
    const lines = this.getText().split("\n");
    const target = Math.max(0, Math.min(lines.length - 1, lineNumber - 1));
    let index = 0;
    for (let line = 0; line < target; line++)
      index += (lines[line]?.length ?? 0) + 1;
    return index;
  }

  /** Every edit first fills the register; change additionally enters Insert. */
  private applyRange(
    operator: "d" | "c" | "y",
    range: { start: number; end: number; linewise?: boolean },
  ): void {
    const text = this.getText();
    const selected = text.slice(range.start, range.end);
    this.copyText(selected, Boolean(range.linewise));
    if (operator === "y") {
      this.setCursorIndex(range.start);
      this.tui.requestRender();
      return;
    }
    this.setText(text.slice(0, range.start) + text.slice(range.end));
    this.setCursorIndex(range.start);
    if (operator === "c") this.setMode("insert");
    else this.tui.requestRender();
  }

  private executeFind(
    char: string,
    direction: 1 | -1,
    until: boolean,
    count: number,
    operator?: "d" | "c" | "y",
  ): void {
    const text = this.getText();
    const index = this.posToIndex(this.getCursor());
    const target = findCharacter(text, index, char, direction, until, count);
    if (target === undefined) return;
    this.lastFind = { char, direction, until };
    if (operator) {
      const inclusive = !until && direction > 0;
      this.applyRange(operator, {
        start: Math.min(index, target),
        end: Math.max(index, target) + (inclusive ? 1 : 0),
      });
    } else {
      this.setCursorIndex(target);
      this.tui.requestRender();
    }
  }

  private joinLines(count: number, normalizeSpace: boolean): void {
    let text = this.getText();
    let index = this.posToIndex(this.getCursor());
    for (let step = 1; step < Math.max(2, count); step++) {
      const newline = text.indexOf("\n", index);
      if (newline < 0) break;
      const rightStart = newline + 1;
      const rightTrimmed = normalizeSpace
        ? text.slice(rightStart).replace(/^\s+/, "")
        : text.slice(rightStart);
      const left = normalizeSpace
        ? text.slice(0, newline).replace(/\s+$/, "")
        : text.slice(0, newline);
      const separator = normalizeSpace && left && rightTrimmed ? " " : "";
      index = left.length;
      text = left + separator + rightTrimmed;
    }
    this.setText(text);
    this.setCursorIndex(index);
    this.tui.requestRender();
  }

  private clearFlash(): void {
    this.flashAwaitingChar = false;
    this.flashQuery = "";
    this.flashTargets = [];
  }

  // Flash labels are an optional shortcut on top of ordinary cursor movement.
  private collectFlashTargets(query: string): FlashTarget[] {
    const targets: FlashTarget[] = [];
    if (!query) return targets;

    const cursor = this.getCursor();
    const lines = this.getText().split("\n");
    for (let line = 0; line < lines.length; line++) {
      const text = lines[line] ?? "";
      for (let col = 0; col <= text.length - query.length; col++) {
        if (!text.startsWith(query, col)) continue;
        if (line === cursor.line && col === cursor.col) continue;
        const label = this.flashLabels[targets.length];
        if (!label) return targets;
        targets.push({ line, col, label });
      }
    }
    return targets;
  }

  private startFlash(query: string): void {
    this.flashAwaitingChar = false;
    this.flashQuery = query;
    this.flashTargets = this.collectFlashTargets(query);

    if (this.flashTargets.length === 1) {
      this.setCursor(this.flashTargets[0]!);
      this.clearFlash();
      this.setMode("visual");
      return;
    }
    this.tui.requestRender();
  }

  private refineFlash(data: string): boolean {
    if (data.length !== 1 || data.charCodeAt(0) < 32 || !this.flashQuery)
      return false;
    const query = this.flashQuery + data;
    const targets = this.collectFlashTargets(query);
    if (!targets.length) return false;
    this.flashQuery = query;
    this.flashTargets = targets;
    if (this.flashTargets.length === 1) {
      this.setCursor(this.flashTargets[0]!);
      this.clearFlash();
      this.setMode("visual");
      return true;
    }
    this.tui.requestRender();
    return true;
  }

  private handleFlashInput(data: string): boolean {
    if (this.flashAwaitingChar) {
      if (data.length === 1 && data.charCodeAt(0) >= 32) {
        this.startFlash(data);
        return true;
      }
      this.clearFlash();
      return false;
    }

    if (!this.flashTargets.length) return false;
    if (this.refineFlash(data)) return true;
    const target = this.flashTargets.find((item) => item.label === data);
    if (target) {
      this.setCursor(target);
      this.clearFlash();
      this.setMode("visual");
      return true;
    }
    this.clearFlash();
    this.tui.requestRender();
    return true;
  }

  private replaceVisibleCell(
    line: string,
    targetCol: number,
    label: string,
    styled = true,
  ): string {
    const index = this.indexAtVisibleCol(line, targetCol);
    if (index >= line.length) return line;
    let end = index;
    if (line[end] === "\x1b") {
      const match = /^\x1b\[[0-?]*[ -/]*[@-~]/.exec(line.slice(end));
      if (match) end += match[0].length;
    }
    const next = line[end] ?? "";
    end += next ? next.length : 0;
    const styledLabel = "\x1b[1;93m" + label + "\x1b[22;39m";
    const replacement = styled
      ? "\x1b[7m" + styledLabel + "\x1b[27m"
      : styledLabel;
    return line.slice(0, index) + replacement + line.slice(end);
  }

  private renderFlashTargets(rendered: string[], width: number): string[] {
    if (!this.flashTargets.length) return rendered;
    const visualLines = this.visualLineMap(width);
    const scrollOffset = Math.max(0, (this as any).scrollOffset ?? 0);
    const next = [...rendered];

    for (const target of this.flashTargets) {
      const visualIndex = visualLines.findIndex(
        (line) =>
          line.logicalLine === target.line &&
          target.col >= line.startCol &&
          target.col < line.startCol + Math.max(1, line.length),
      );
      if (visualIndex < scrollOffset) continue;
      const row = 1 + visualIndex - scrollOffset;
      if (row <= 0 || row >= next.length || !next[row]) continue;
      const paddingX = Math.min(
        this.getPaddingX(),
        Math.max(0, Math.floor((width - 1) / 2)),
      );
      const visualCol =
        paddingX + target.col - (visualLines[visualIndex]?.startCol ?? 0);
      const matchWidth = Math.max(1, visibleWidth(this.flashQuery));
      const highlighted = this.highlightVisibleRange(
        next[row]!,
        visualCol,
        visualCol + matchWidth,
      );
      next[row] = truncateToWidth(
        this.replaceVisibleCell(highlighted, visualCol, target.label, false),
        width,
        "",
      );
    }

    return next;
  }

  private deleteRange(startIndex: number, endIndex: number): CursorPos {
    const text = this.getText();
    const start = Math.max(0, Math.min(startIndex, endIndex));
    const end = Math.max(0, Math.max(startIndex, endIndex));
    const before = text.slice(0, start);
    const cursor: CursorPos = {
      line: before.split("\n").length - 1,
      col: before.length - before.lastIndexOf("\n") - 1,
    };
    this.setText(text.slice(0, start) + text.slice(end));
    this.setCursor(cursor);
    return cursor;
  }

  private deleteVisualSelection(change = false): void {
    const range = this.visualRange();
    if (!range) return;
    let start = range.startIndex;
    let end = range.endIndex;
    if (this.mode === "visualLine" && !change) {
      const text = this.getText();
      if (end < text.length && text[end] === "\n") end++;
      else if (start > 0) start--;
    }
    this.deleteRange(start, end);
  }

  /** Handle both repeated operators (dd/cc/yy) and motions (dw/ce/y$). */
  private applyOperatorMotion(
    operator: "d" | "c" | "y",
    motion: string,
    count: number,
  ): boolean {
    const text = this.getText();
    const start = this.getCursor();
    const startIndex = this.posToIndex(start);

    if (motion === operator || (operator === "y" && motion === "Y")) {
      const lines = text.split("\n");
      const firstLine = Math.max(0, Math.min(start.line, lines.length - 1));
      const lastLine = Math.min(
        lines.length - 1,
        firstLine + Math.max(1, count) - 1,
      );
      const rangeStart = this.posToIndex({ line: firstLine, col: 0 });
      const hasTrailingNewline = lastLine < lines.length - 1;
      const rangeEnd = hasTrailingNewline
        ? this.posToIndex({ line: lastLine + 1, col: 0 })
        : text.length;
      this.copyText(text.slice(rangeStart, rangeEnd).replace(/\n$/, ""), true);
      if (operator === "y") {
        this.setCursorIndex(rangeStart);
        this.tui.requestRender();
        return true;
      }
      let deleteStart = rangeStart;
      let deleteEnd = rangeEnd;
      if (operator === "c" && hasTrailingNewline) deleteEnd--;
      else if (operator === "d" && !hasTrailingNewline && deleteStart > 0)
        deleteStart--;
      this.setText(text.slice(0, deleteStart) + text.slice(deleteEnd));
      this.setCursorIndex(operator === "c" ? rangeStart : deleteStart);
      if (operator === "c") this.setMode("insert");
      else this.tui.requestRender();
      return true;
    }

    const supported: VimMotion[] = [
      "w",
      "W",
      "b",
      "B",
      "e",
      "E",
      "0",
      "^",
      "$",
      "%",
      "gg",
      "G",
      "{",
      "}",
    ];
    if (!supported.includes(motion as VimMotion)) return false;
    const range = operatorRange(text, startIndex, motion as VimMotion, count);
    if (!range) return true;
    this.applyRange(operator, range);
    return true;
  }

  private handleVisualMovement(data: string, count = 1): boolean {
    switch (data) {
      case "h":
        this.repeatInput("\x1b[D", count);
        return true;
      case "l":
        this.repeatInput("\x1b[C", count);
        return true;
      case "j":
        this.repeatInput("\x1b[B", count);
        return true;
      case "k":
        // Avoid native Up history recall while extending a visual selection from
        // the very start of the prompt.
        if (!this.isAtStartOfBuffer()) this.repeatInput("\x1b[A", count);
        return true;
      case "0":
        super.handleInput("\x01");
        return true;
      case "$":
        super.handleInput("\x05");
        return true;
      case "w":
        this.repeatInput("\x1bf", count);
        return true;
      case "b":
        this.repeatInput("\x1bb", count);
        return true;
      default:
        return false;
    }
  }

  private indexAtVisibleCol(line: string, targetCol: number): number {
    let visibleCol = 0;
    for (let i = 0; i < line.length;) {
      if (line[i] === "\x1b") {
        const match = /^\x1b\[[0-?]*[ -/]*[@-~]/.exec(line.slice(i));
        if (match) {
          i += match[0].length;
          continue;
        }
      }
      if (visibleCol >= targetCol) return i;
      const char = line[i] ?? "";
      visibleCol += Math.max(1, visibleWidth(char));
      i += char.length;
    }
    return line.length;
  }

  private visualLineMap(
    width: number,
  ): Array<{ logicalLine: number; startCol: number; length: number }> {
    const paddingX = Math.min(
      this.getPaddingX(),
      Math.max(0, Math.floor((width - 1) / 2)),
    );
    const contentWidth = Math.max(1, width - paddingX * 2);
    const layoutWidth = Math.max(1, contentWidth - (paddingX ? 0 : 1));
    return ((this as any).buildVisualLineMap?.(layoutWidth) ?? []) as Array<{
      logicalLine: number;
      startCol: number;
      length: number;
    }>;
  }

  private highlightVisibleRange(
    line: string,
    startCol: number,
    endColExclusive: number,
  ): string {
    if (endColExclusive <= startCol) return line;

    let visibleCol = 0;
    let startIndex: number | undefined;
    let endIndex: number | undefined;

    for (let i = 0; i < line.length;) {
      if (line[i] === "\x1b") {
        const match = /^\x1b\[[0-?]*[ -/]*[@-~]/.exec(line.slice(i));
        if (match) {
          i += match[0].length;
          continue;
        }
      }

      if (startIndex === undefined && visibleCol >= startCol) startIndex = i;
      const char = line[i] ?? "";
      visibleCol += Math.max(1, visibleWidth(char));
      i += char.length;
      if (endIndex === undefined && visibleCol >= endColExclusive) {
        endIndex = i;
        break;
      }
    }

    startIndex ??= line.length;
    endIndex ??= line.length;
    // The editor may already contain ANSI for the fake cursor. If that cursor
    // reset lands inside our selection, immediately re-enable inverse video so
    // the rest of the visual selection stays painted.
    const selected = line
      .slice(startIndex, endIndex)
      .replace(/\x1b\[0m/g, "\x1b[0m\x1b[7m");
    return (
      line.slice(0, startIndex) +
      "\x1b[7m" +
      selected +
      "\x1b[0m" +
      line.slice(endIndex)
    );
  }

  private handleVisualBufferInput(data: string): boolean {
    if (/^[1-9]$/.test(data) || (/^0$/.test(data) && this.pendingCount)) {
      this.pendingCount = `${this.pendingCount}${data}`.slice(0, 4);
      return true;
    }

    if (data === "v") {
      this.setMode(this.mode === "visual" ? "normal" : "visual");
      return true;
    }

    if (data === "V") {
      this.setMode(this.mode === "visualLine" ? "normal" : "visualLine");
      return true;
    }

    if (data === "y") {
      const range = this.visualRange();
      this.copyText(this.selectedText(), this.mode === "visualLine");
      if (range) this.setCursor(range.start);
      this.setMode("normal");
      return true;
    }

    if (data === "d" || data === "x") {
      this.copyText(this.selectedText(), this.mode === "visualLine");
      this.deleteVisualSelection();
      this.setMode("normal");
      return true;
    }

    if (data === "c") {
      this.copyText(this.selectedText(), this.mode === "visualLine");
      this.deleteVisualSelection(true);
      this.setMode("insert");
      return true;
    }

    if (data === "s") {
      this.flashAwaitingChar = true;
      this.flashQuery = "";
      this.flashTargets = [];
      this.tui.requestRender();
      return true;
    }

    if (this.handleVisualMovement(data, this.takeCount(1))) {
      this.tui.requestRender();
      return true;
    }
    this.pendingCount = "";

    return true;
  }

  render(width: number): string[] {
    // Pi reapplies its configured padding after constructing custom editors.
    // Reserve space here so the glyph never shifts the text or hardware cursor.
    this.setPaddingX(2);
    const paddingX = Math.min(
      this.getPaddingX(),
      Math.max(0, Math.floor((width - 1) / 2)),
    );
    let rendered = super.render(width);
    if (paddingX >= 2 && rendered.length > 1) {
      rendered[1] = rendered[1]!.replace(/^  /, `${this.borderColor("❯")} `);
    }
    if (this.mode === "insert" && !responseSession.cursorVisible)
      rendered = hideInsertCursor(rendered);
    if (responseSession.pane) {
      // The response pane owns the visible cursor; leave the draft untouched.
      return hideInsertCursor(rendered).map((line) =>
        line.replaceAll("\x1b_pi:c\x07", ""),
      );
    }
    const range =
      this.mode === "visual" || this.mode === "visualLine"
        ? this.visualRange(width)
        : undefined;
    if (!range) return this.renderFlashTargets(rendered, width);

    const visualLines = this.visualLineMap(width);
    const scrollOffset = Math.max(0, (this as any).scrollOffset ?? 0);
    let contentRow = 0;
    const highlighted = rendered.map((line, row) => {
      // The editor renders a border row, then visible prompt layout rows, then
      // border rows / autocomplete. Use Pi's own visual-line map so wrapped
      // lines and logical lines stay in sync.
      if (row === 0) return line;
      const visualLine = visualLines[scrollOffset + contentRow];
      if (!visualLine) return line;
      contentRow++;
      if (this.mode === "visualLine") {
        if (range.visualStart === undefined || range.visualEnd === undefined)
          return line;
        if (
          scrollOffset + contentRow - 1 < range.visualStart ||
          scrollOffset + contentRow - 1 > range.visualEnd
        )
          return line;
      } else if (
        visualLine.logicalLine < range.start.line ||
        visualLine.logicalLine > range.end.line
      ) {
        return line;
      }

      let startCol = paddingX;
      let endColExclusive = width - paddingX;
      if (this.mode !== "visualLine") {
        const segmentStart = visualLine.startCol;
        const segmentEnd = visualLine.startCol + visualLine.length;
        const selectedStart =
          visualLine.logicalLine === range.start.line
            ? Math.max(range.start.col, segmentStart)
            : segmentStart;
        const selectedEnd =
          visualLine.logicalLine === range.end.line
            ? Math.min(range.end.col + 1, segmentEnd)
            : segmentEnd;
        startCol = paddingX + Math.max(0, selectedStart - segmentStart);
        endColExclusive = paddingX + Math.max(0, selectedEnd - segmentStart);
      }
      if (endColExclusive <= startCol) return line;

      const cursorMarker = "\x1b_pi:c\x07";
      const markerIndex = line.indexOf(cursorMarker);
      const markerCol =
        markerIndex === -1
          ? undefined
          : visibleWidth(line.slice(0, markerIndex));
      const lineWithoutMarker =
        markerIndex === -1
          ? line
          : line.slice(0, markerIndex) +
            line.slice(markerIndex + cursorMarker.length);
      let highlighted = truncateToWidth(
        this.highlightVisibleRange(
          lineWithoutMarker,
          startCol,
          endColExclusive,
        ),
        width,
        "",
      );
      if (markerCol !== undefined && markerCol <= width) {
        const insertAt = this.indexAtVisibleCol(highlighted, markerCol);
        highlighted =
          highlighted.slice(0, insertAt) +
          cursorMarker +
          highlighted.slice(insertAt);
      }
      return highlighted;
    });
    return this.renderFlashTargets(highlighted, width);
  }

  private appendToComposer(): void {
    leaveScrollback();
    this.scrollFlashAwaitingChar = false;
    this.setCursorIndex(this.getText().length);
    this.setMode("insert");
  }

  private handleScrollbackInput(data: string): boolean {
    const pane = responseSession.pane;
    if (!pane) return false;

    // Flash consumes the next printable character as a search or label, not
    // as a navigation command. A jump does not automatically start selection.
    if (this.scrollFlashAwaitingChar) {
      this.scrollFlashAwaitingChar = false;
      if (data.length === 1 && data.charCodeAt(0) >= 32) pane.startFlash(data);
    } else if (pane.hasLinkTargets()) {
      const url = pane.chooseLink(data);
      if (url) {
        const opened = openExternalUrl(url);
        const message = opened ? `Opened ${url}` : `Could not open ${url}`;
        responseSession.context?.ui.notify(message, opened ? "info" : "error");
      }
    } else if (pane.hasFlashTargets()) {
      if (!pane.refineFlash(data) && pane.chooseFlash(data))
        setCurrentMode("normal");
    } else {
      this.handleResponseNavigation(data);
    }

    this.tui.requestRender();
    // Consume even unknown keys: response navigation must never edit the draft.
    return true;
  }

  private handleResponseNavigation(data: string): void {
    const pane = responseSession.pane;
    if (!pane) return;

    const completesTopCommand = this.pendingG && data === "g";
    this.pendingG = false;
    if (completesTopCommand) {
      pane.top();
      return;
    }
    if (matchesKey(data, "ctrl+u") || matchesKey(data, "pageUp")) {
      pane.page(-1);
      return;
    }
    if (matchesKey(data, "ctrl+d") || matchesKey(data, "pageDown")) {
      pane.page(1);
      return;
    }
    if (matchesKey(data, "enter") && pane.hasSelectedUserMessage()) {
      if (queueSelectedUserMessageAction()) {
        this.setText(`/${MESSAGE_ACTION_COMMAND}`);
        super.handleInput("\r");
      }
      return;
    }

    switch (data) {
      case "h":
      case "j":
      case "k":
      case "l":
      case "w":
      case "b":
      case "e":
      case "0":
      case "$":
        pane.moveCursor(data);
        break;
      case "v":
      case "V": {
        pane.toggleSelection(data === "V");
        let mode: Mode = "normal";
        if (pane.isSelecting())
          mode = pane.isLinewiseSelection() ? "visualLine" : "visual";
        setCurrentMode(mode);
        break;
      }
      case "y":
        if (pane.isSelecting()) {
          this.copyText(pane.selectedText(), pane.isLinewiseSelection());
          pane.clearSelection();
          setCurrentMode("normal");
          responseSession.context?.ui.notify(
            "Copied response selection",
            "info",
          );
        }
        break;
      case "g":
        this.pendingG = true;
        break;
      case "G":
        pane.setComponents(nativeTranscriptComponents(this.tui));
        pane.bottom();
        break;
      case "J":
      case "K":
        if (pane.cycleUserMessage(data === "J" ? 1 : -1))
          setCurrentMode("normal");
        break;
      case "s":
        this.scrollFlashAwaitingChar = true;
        break;
      case "S":
        pane.startLinkFlash();
        break;
      case "q":
        leaveScrollback();
        setCurrentMode("normal");
        break;
      case "i":
      case "a":
        leaveScrollback();
        this.setMode("insert");
        break;
    }
  }

  /** Complete pending commands first, then interpret a new Normal-mode key. */
  private handleNormalBufferInput(data: string): boolean {
    if (this.pendingReplaceCount !== undefined) {
      const count = this.pendingReplaceCount;
      this.pendingReplaceCount = undefined;
      if (data.length !== 1) return true;
      const text = this.getText();
      const start = this.posToIndex(this.getCursor());
      const end = Math.min(lineBounds(text, start).end, start + count);
      if (end > start) {
        this.setText(
          text.slice(0, start) + data.repeat(end - start) + text.slice(end),
        );
        this.setCursorIndex(start + end - start - 1);
        this.tui.requestRender();
      }
      return true;
    }

    if (this.pendingFind) {
      const pending = this.pendingFind;
      this.pendingFind = undefined;
      if (data.length === 1)
        this.executeFind(
          data,
          pending.direction,
          pending.until,
          pending.count,
          pending.operator,
        );
      return true;
    }

    if (this.pendingTextObject && this.pendingOperator) {
      const kind = this.pendingTextObject;
      const operator = this.pendingOperator;
      this.pendingTextObject = undefined;
      this.pendingOperator = undefined;
      const range = textObjectRange(
        this.getText(),
        this.posToIndex(this.getCursor()),
        kind,
        data,
      );
      if (range) this.applyRange(operator, range);
      return true;
    }

    if (this.pendingOperator) {
      if (/^[1-9]$/.test(data) || (/^0$/.test(data) && this.pendingCount)) {
        this.pendingCount = `${this.pendingCount}${data}`.slice(0, 4);
        return true;
      }
      const operator = this.pendingOperator;
      const count = Math.min(9999, this.operatorCount * this.takeCount(1));
      if (data === "i" || data === "a") {
        this.pendingTextObject = data;
        return true;
      }
      if (data === "f" || data === "F" || data === "t" || data === "T") {
        this.pendingFind = {
          direction: data === "f" || data === "t" ? 1 : -1,
          until: data === "t" || data === "T",
          operator,
          count,
        };
        return true;
      }
      this.pendingOperator = undefined;
      if (this.applyOperatorMotion(operator, data, count)) return true;
      return data.length === 1;
    }

    if (/^[1-9]$/.test(data) || (/^0$/.test(data) && this.pendingCount)) {
      this.pendingCount = `${this.pendingCount}${data}`.slice(0, 4);
      return true;
    }

    if (this.pendingG) {
      this.pendingG = false;
      if (data === "g") {
        const targetLine = this.takeCount(1);
        this.setCursorIndex(this.lineStart(targetLine));
        this.tui.requestRender();
        return true;
      }
      if (data === "J") {
        this.joinLines(this.takeCount(2), false);
        return true;
      }
    }

    const count = this.takeCount(1);
    const moveTo = (motion: VimMotion) => {
      this.setCursorIndex(
        motionTarget(
          this.getText(),
          this.posToIndex(this.getCursor()),
          motion,
          count,
        ),
      );
      this.tui.requestRender();
    };

    switch (data) {
      case "s":
        this.flashAwaitingChar = true;
        this.flashQuery = "";
        this.flashTargets = [];
        this.tui.requestRender();
        return true;
      case "v":
        this.setMode("visual");
        return true;
      case "V":
        this.setMode("visualLine");
        return true;
      case "i":
        this.setMode("insert");
        return true;
      case "a":
        super.handleInput("\x1b[C");
        this.setMode("insert");
        return true;
      case "I":
        moveTo("^");
        this.setMode("insert");
        return true;
      case "A":
        this.appendToComposer();
        return true;
      case "o":
        super.handleInput("\x05");
        super.handleInput("\n");
        this.setMode("insert");
        return true;
      case "O":
        super.handleInput("\x01");
        super.handleInput("\n");
        super.handleInput("\x1b[A");
        this.setMode("insert");
        return true;
      case "h":
        this.repeatInput("\x1b[D", count);
        return true;
      case "l":
        this.repeatInput("\x1b[C", count);
        return true;
      case "j":
        this.repeatInput("\x1b[B", count);
        return true;
      case "k":
        if (this.getCursor().line > 0) this.repeatInput("\x1b[A", count);
        else if (this.activateScrollback()) requestScrollRender(this.tui);
        return true;
      case "0":
        moveTo("0");
        return true;
      case "^":
      case "_":
        moveTo("^");
        return true;
      case "$":
        moveTo("$");
        return true;
      case "w":
      case "W":
      case "b":
      case "B":
      case "e":
      case "E":
      case "%":
      case "{":
      case "}":
        moveTo(data as VimMotion);
        return true;
      case "G":
        this.setCursorIndex(
          count > 1 ? this.lineStart(count) : this.getText().length,
        );
        this.tui.requestRender();
        return true;
      case "g":
        this.pendingG = true;
        this.pendingCount = count === 1 ? "" : String(count);
        return true;
      case "f":
      case "t":
        this.pendingFind = { direction: 1, until: data === "t", count };
        return true;
      case "F":
      case "T":
        this.pendingFind = { direction: -1, until: data === "T", count };
        return true;
      case ";":
        if (this.lastFind)
          this.executeFind(
            this.lastFind.char,
            this.lastFind.direction,
            this.lastFind.until,
            count,
          );
        return true;
      case ",":
        if (this.lastFind)
          this.executeFind(
            this.lastFind.char,
            this.lastFind.direction === 1 ? -1 : 1,
            this.lastFind.until,
            count,
          );
        return true;
      case "p":
        this.paste(true, count);
        return true;
      case "P":
        this.paste(false, count);
        return true;
      case "x": {
        const start = this.posToIndex(this.getCursor());
        const end = Math.min(
          lineBounds(this.getText(), start).end,
          start + count,
        );
        if (end > start) this.applyRange("d", { start, end });
        return true;
      }
      case "d":
      case "c":
      case "y":
        this.pendingOperator = data;
        this.operatorCount = count;
        return true;
      case "Y":
        this.applyOperatorMotion("y", "Y", count);
        return true;
      case "D":
        this.applyOperatorMotion("d", "$", count);
        return true;
      case "C":
        this.applyOperatorMotion("c", "$", count);
        return true;
      case "S":
        this.applyOperatorMotion("c", "c", count);
        return true;
      case "r":
        this.pendingReplaceCount = count;
        return true;
      case "J":
        this.joinLines(count === 1 ? 2 : count, true);
        return true;
      case "u":
        this.repeatInput("\x1f", count);
        return true;
      default:
        return false;
    }
  }

  /** Main dispatcher. Order matters: Escape, Insert, selection, then navigation. */
  handleInput(data: string): void {
    noteInput();
    const animatedScrollUp = matchesKey(data, "ctrl+h");
    const animatedScrollDown = matchesKey(data, "ctrl+l");
    if (!animatedScrollUp && !animatedScrollDown) {
      responseSession.pane?.cancelScrollAnimation();
    }
    // Only take these application shortcuts while navigating autocomplete.
    if (this.mode === "insert" && this.isShowingAutocomplete()) {
      if (matchesKey(data, "ctrl+p")) return super.handleInput("\x1b[A");
      if (matchesKey(data, "ctrl+n")) return super.handleInput("\x1b[B");
    }
    // Some terminals/tests can deliver a fast Escape+key as one Alt-style chunk
    // (for example "\x1bs"). Treat that as Escape followed by the key so
    // leaving insert mode and immediately starting a normal-mode motion works.
    if (
      data.length > 1 &&
      data.startsWith("\x1b") &&
      !data.startsWith("\x1b[") &&
      !data.startsWith("\x1bO")
    ) {
      this.handleInput("\x1b");
      for (const char of data.slice(1)) this.handleInput(char);
      return;
    }

    if (matchesKey(data, "escape")) {
      if (responseSession.pane) {
        const cancelSelection =
          this.scrollFlashAwaitingChar ||
          responseSession.pane?.isSelecting() ||
          responseSession.pane?.hasFlashTargets() ||
          responseSession.pane?.hasLinkTargets();
        this.scrollFlashAwaitingChar = false;
        this.pendingG = false;
        responseSession.pane?.clearSelection();
        // First Escape cancels a selection/search; a second returns to the prompt.
        if (!cancelSelection) leaveScrollback();
        setCurrentMode("normal");
        this.tui.requestRender();
        return;
      }
      if (this.flashAwaitingChar || this.flashTargets.length) {
        this.clearFlash();
        this.tui.requestRender();
        return;
      }
      if (this.mode === "visual" || this.mode === "visualLine") {
        this.setMode("normal");
        return;
      }
      if (this.mode === "insert" && !this.isShowingAutocomplete()) {
        this.setMode("normal");
        return;
      }
      if (
        this.pendingOperator ||
        this.pendingTextObject ||
        this.pendingFind ||
        this.pendingReplaceCount !== undefined ||
        this.pendingCount ||
        this.pendingG
      ) {
        this.pendingOperator = undefined;
        this.pendingTextObject = undefined;
        this.pendingFind = undefined;
        this.pendingReplaceCount = undefined;
        this.pendingCount = "";
        this.pendingG = false;
        this.tui.requestRender();
        return;
      }
      super.handleInput(data);
      return;
    }

    if (this.mode === "insert") {
      if (matchesKey(data, "enter")) {
        leaveScrollback();
      }
      super.handleInput(data);
      return;
    }

    // Keep Insert-mode Ctrl+L (model picker) and Ctrl+H (backspace) native.
    // In Normal mode these shortcuts enter responses if needed and animate.
    if (this.mode === "normal" && (animatedScrollUp || animatedScrollDown)) {
      this.pendingG = false;
      this.scrollFlashAwaitingChar = false;
      if (this.activateScrollback()) {
        responseSession.pane?.animatePage(animatedScrollUp ? -1 : 1);
      }
      return;
    }

    // A is a pane switch even during response selection or a Flash search.
    if (responseSession.pane && data === "A") {
      this.appendToComposer();
      return;
    }

    if (this.handleFlashInput(data)) return;

    if (this.mode === "visual" || this.mode === "visualLine") {
      this.handleVisualBufferInput(data);
      return;
    }

    if (this.handleScrollbackInput(data)) return;

    // With an empty prompt, Flash can still jump directly into responses.
    // Otherwise `k` on the first prompt line enters the response cursor pane.
    // Uppercase J/K jump between user messages and keep the selected message at
    // the top of the viewport.
    if (this.getText().length === 0 && (data === "J" || data === "K")) {
      if (this.activateScrollback()) {
        responseSession.pane?.cycleUserMessage(data === "J" ? 1 : -1);
        requestScrollRender(this.tui);
      }
      return;
    }

    if (this.getText().length === 0 && data === "s") {
      if (this.activateScrollback()) {
        this.handleScrollbackInput(data);
      }
      return;
    }

    if (this.getText().length === 0 && data === "S") {
      if (this.activateScrollback()) {
        responseSession.pane?.startLinkFlash();
        requestScrollRender(this.tui);
      }
      return;
    }

    if (this.getText().length === 0 && this.pendingG) {
      this.pendingG = false;
      if (data === "g") {
        if (this.activateScrollback()) responseSession.pane?.top();
        return;
      }
    }

    if (this.getText().length === 0 && data === "g") {
      this.pendingG = true;
      return;
    }

    if (this.getText().length === 0 && data === "G") {
      if (this.activateScrollback()) responseSession.pane?.bottom();
      return;
    }

    if (matchesKey(data, "ctrl+u") || matchesKey(data, "pageUp")) {
      if (this.activateScrollback()) responseSession.pane?.page(-1);
      return;
    }

    if (matchesKey(data, "ctrl+d") || matchesKey(data, "pageDown")) {
      if (this.activateScrollback()) responseSession.pane?.page(1);
      return;
    }

    if (this.handleNormalBufferInput(data)) return;
    if (data.length === 1 && data.charCodeAt(0) >= 32) return;
    super.handleInput(data);
  }
}

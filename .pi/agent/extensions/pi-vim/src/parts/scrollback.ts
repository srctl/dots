/**
 * Read-only response pane, drawn over Pi's transcript (never over the prompt).
 *
 * `offset` is the first visible rendered line. `cursor` and `selectionAnchor`
 * use absolute rendered-line numbers and JavaScript string offsets. Rendering
 * converts those string offsets into terminal columns, since emoji and CJK
 * characters can occupy more than one column. Selection includes both ends.
 *
 * The cached lines come from Pi's own components, preserving Markdown/colors.
 * Streaming updates invalidate that cache without moving the user's cursor.
 */
import {
  CURSOR_MARKER,
  truncateToWidth,
  visibleWidth,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";

type ScrollFlashTarget = { line: number; col: number; label: string };
type ScrollLinkTarget = {
  line: number;
  col: number;
  label: string;
  url: string;
  length: number;
};
type LineRange = { start: number; end: number };
type RenderedTranscript = { lines: string[]; userRanges: LineRange[] };

function stripTerminalSequencesLocal(line: string): string {
  return line
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

export class ScrollbackOverlay implements Component {
  private offset = Number.MAX_SAFE_INTEGER;
  private followEnd = true;
  private cachedWidth = -1;
  private cachedLines: string[] | undefined;
  private cachedUserRanges: LineRange[] | undefined;
  private cursor = { line: 0, col: 0 };
  private selectionAnchor: { line: number; col: number } | undefined;
  private linewiseSelection = false;
  private scrollTimer: ReturnType<typeof setTimeout> | undefined;
  private remainingScrollRows = 0;
  private flashQuery = "";
  private flashTargets: ScrollFlashTarget[] = [];
  private linkTargets: ScrollLinkTarget[] = [];
  private selectedUserMessageStart: number | undefined;
  private alignSelectedUserMessageTop = false;
  private readonly flashLabels =
    "asdfghjklqwertyuiopzxcvbnmASDFGHJKLQWERTYUIOPZXCVBNM1234567890";

  constructor(
    private tui: TUI,
    private components: Component[],
  ) {}

  private width(): number {
    return this.tui.terminal.columns || 80;
  }

  /** Start at the last nonblank line in the currently visible transcript. */
  enterCursor(scrollTop?: number): void {
    const lines = this.renderedLines(this.width()).map((line) =>
      this.stripAnsi(line).trimEnd(),
    );
    const rows = scrollbackRows(this.tui, this.width());
    this.offset = Math.max(
      0,
      Math.min(
        scrollTop ?? lines.length - rows,
        Math.max(0, lines.length - rows),
      ),
    );
    let line = Math.min(lines.length - 1, this.offset + rows - 1);
    while (line > this.offset && !lines[line]?.trim()) line--;
    this.cursor = {
      line: Math.max(0, line),
      col: Math.max(0, lines[line]?.search(/\S/) ?? 0),
    };
    this.followEnd = false;
  }

  private keepCursorVisible(width = this.width()): void {
    const lines = this.renderedLines(width);
    this.cursor.line = Math.max(
      0,
      Math.min(this.cursor.line, lines.length - 1),
    );
    const text = this.stripAnsi(lines[this.cursor.line] ?? "").trimEnd();
    this.cursor.col = this.characterStart(
      text,
      Math.max(0, Math.min(this.cursor.col, text.length - 1)),
    );
    const rows = scrollbackRows(this.tui, width);
    this.offset = Math.max(
      0,
      Math.min(this.offset, Math.max(0, lines.length - rows)),
    );
    if (this.cursor.line < this.offset) this.offset = this.cursor.line;
    if (this.cursor.line >= this.offset + rows)
      this.offset = this.cursor.line - rows + 1;
    this.followEnd = false;
  }

  private characterStart(text: string, col: number): number {
    for (const part of new Intl.Segmenter().segment(text)) {
      if (part.index + part.segment.length > col) return part.index;
    }
    return 0;
  }

  private characterEnd(text: string, col: number): number {
    for (const part of new Intl.Segmenter().segment(text)) {
      if (part.index + part.segment.length > col)
        return part.index + part.segment.length;
    }
    return text.length;
  }

  setComponents(components: Component[]): void {
    this.components = components;
    if (this.followEnd) this.offset = Number.MAX_SAFE_INTEGER;
    this.cachedWidth = -1;
    this.cachedLines = undefined;
    this.cachedUserRanges = undefined;
  }

  cycleUserMessage(direction: 1 | -1): boolean {
    const width = this.width();
    const ranges = this.renderedUserRanges(width);
    if (!ranges.length) return false;
    const starts = ranges.map((range) => range.start);

    const currentIndex =
      this.selectedUserMessageStart === undefined
        ? -1
        : starts.indexOf(this.selectedUserMessageStart);
    let nextIndex: number;
    if (currentIndex >= 0) {
      nextIndex = currentIndex + direction;
      if (nextIndex < 0 || nextIndex >= starts.length) return false;
    } else if (direction > 0) {
      const afterTop = starts.findIndex((line) => line >= this.offset);
      nextIndex = afterTop >= 0 ? afterTop : 0;
    } else {
      let beforeTop = -1;
      for (let index = starts.length - 1; index >= 0; index--) {
        if (starts[index]! <= this.offset) {
          beforeTop = index;
          break;
        }
      }
      nextIndex = beforeTop >= 0 ? beforeTop : starts.length - 1;
    }

    const selected = starts[nextIndex]!;
    this.selectedUserMessageStart = selected;
    this.alignSelectedUserMessageTop = true;
    this.followEnd = false;
    this.offset = selected;
    this.cursor = { line: selected, col: 0 };
    this.selectionAnchor = undefined;
    this.flashTargets = [];
    this.linkTargets = [];
    return true;
  }

  invalidate(): void {
    this.cachedWidth = -1;
    this.cachedLines = undefined;
    this.cachedUserRanges = undefined;
    for (const component of this.components) component.invalidate();
  }

  private halfPageRows(): number {
    return Math.max(1, Math.floor(scrollbackRows(this.tui, this.width()) / 2));
  }

  private scrollRows(distance: number): void {
    this.clearUserMessageSelection();
    this.cursor.line += distance;
    this.offset += distance;
    this.keepCursorVisible();
  }

  page(direction: number): void {
    this.cancelScrollAnimation();
    this.scrollRows(this.halfPageRows() * direction);
  }

  /** Smoothly move both the viewport and cursor over roughly 180ms. */
  animatePage(direction: 1 | -1): void {
    // Repeated keys add distance; the opposite key reverses immediately.
    if (this.remainingScrollRows * direction < 0) this.cancelScrollAnimation();
    if (this.scrollTimer) clearTimeout(this.scrollTimer);
    this.remainingScrollRows += this.halfPageRows() * direction;

    const totalRows = this.remainingScrollRows;
    const startedAt = Date.now();
    const durationMs = 180;
    let movedRows = 0;

    const renderFrame = () => {
      const progress = Math.min(1, (Date.now() - startedAt) / durationMs);
      // Ease-out: start quickly, then settle gently on the destination row.
      const easedProgress = 1 - Math.pow(1 - progress, 3);
      const nextMovedRows = Math.round(totalRows * easedProgress);
      const distance = nextMovedRows - movedRows;
      if (distance !== 0) {
        this.scrollRows(distance);
        this.tui.requestRender();
      }
      movedRows = nextMovedRows;
      this.remainingScrollRows = totalRows - movedRows;

      if (progress < 1) this.scrollTimer = setTimeout(renderFrame, 16);
      else this.scrollTimer = undefined;
    };
    renderFrame();
  }

  /** Stop before another command, leaving the cursor at its current position. */
  cancelScrollAnimation(): void {
    if (this.scrollTimer) clearTimeout(this.scrollTimer);
    this.scrollTimer = undefined;
    this.remainingScrollRows = 0;
  }

  top(): void {
    this.clearUserMessageSelection();
    this.followEnd = false;
    this.offset = 0;
    this.cursor = { line: 0, col: 0 };
  }

  bottom(): void {
    this.clearUserMessageSelection();
    const lines = this.renderedLines(this.width());
    this.cursor = { line: Math.max(0, lines.length - 1), col: 0 };
    this.keepCursorVisible();
  }

  toggleSelection(linewise = false): void {
    this.clearUserMessageSelection();
    if (this.selectionAnchor && this.linewiseSelection === linewise)
      this.selectionAnchor = undefined;
    else if (!this.selectionAnchor) this.selectionAnchor = { ...this.cursor };
    this.linewiseSelection = linewise;
    this.flashTargets = [];
    this.linkTargets = [];
  }

  isLinewiseSelection(): boolean {
    return this.isSelecting() && this.linewiseSelection;
  }

  isSelecting(): boolean {
    return Boolean(this.selectionAnchor);
  }

  clearSelection(): void {
    this.selectionAnchor = undefined;
    this.linewiseSelection = false;
    this.flashQuery = "";
    this.flashTargets = [];
    this.linkTargets = [];
  }

  private clearUserMessageSelection(): void {
    this.selectedUserMessageStart = undefined;
    this.alignSelectedUserMessageTop = false;
  }

  private renderedUserRanges(width: number): LineRange[] {
    if (!this.cachedUserRanges || this.cachedWidth !== width)
      this.renderedLines(width);
    return this.cachedUserRanges ?? [];
  }

  private selectedUserMessageRange(width: number): LineRange | undefined {
    const start = this.selectedUserMessageStart;
    if (start === undefined) return undefined;
    return this.renderedUserRanges(width).find(
      (range) => range.start === start,
    );
  }

  selectedUserMessageIndex(width = this.width()): number | undefined {
    const start = this.selectedUserMessageStart;
    if (start === undefined) return undefined;
    const index = this.renderedUserRanges(width).findIndex(
      (range) => range.start === start,
    );
    return index >= 0 ? index : undefined;
  }

  hasSelectedUserMessage(): boolean {
    return this.selectedUserMessageIndex() !== undefined;
  }

  hasFlashTargets(): boolean {
    return this.flashTargets.length > 0;
  }

  hasLinkTargets(): boolean {
    return this.linkTargets.length > 0;
  }

  private linksInRenderedLine(
    line: string,
    lineNo: number,
  ): Array<Omit<ScrollLinkTarget, "label">> {
    const links: Array<Omit<ScrollLinkTarget, "label">> = [];
    let active: { url: string; col: number } | undefined;
    let visibleCol = 0;

    for (let index = 0; index < line.length;) {
      if (line[index] === "\x1b") {
        const osc8 = /^\x1b\]8;[^;]*;([^\x07\x1b]*)(?:\x07|\x1b\\)/.exec(
          line.slice(index),
        );
        if (osc8) {
          const url = osc8[1] ?? "";
          if (url) active = { url, col: visibleCol };
          else if (active && visibleCol > active.col) {
            links.push({
              line: lineNo,
              col: active.col,
              url: active.url,
              length: visibleCol - active.col,
            });
            active = undefined;
          } else active = undefined;
          index += osc8[0].length;
          continue;
        }

        const sgr = /^\x1b\[[0-?]*[ -/]*[@-~]/.exec(line.slice(index));
        if (sgr) {
          index += sgr[0].length;
          continue;
        }

        const osc = /^\x1b\][^\x07]*(?:\x07|\x1b\\)/.exec(line.slice(index));
        if (osc) {
          index += osc[0].length;
          continue;
        }
      }

      const char = line[index] ?? "";
      visibleCol += Math.max(1, visibleWidth(char));
      index += char.length;
    }

    if (active && visibleCol > active.col)
      links.push({
        line: lineNo,
        col: active.col,
        url: active.url,
        length: visibleCol - active.col,
      });
    return links;
  }

  startLinkFlash(): void {
    this.clearUserMessageSelection();
    this.flashQuery = "";
    this.flashTargets = [];
    this.linkTargets = [];

    const width = this.width();
    const rows = scrollbackRows(this.tui, width);
    const rendered = this.renderedLines(width);
    const maxOffset = Math.max(0, rendered.length - rows);
    this.offset = Math.max(0, Math.min(this.offset, maxOffset));
    if (this.offset === maxOffset) this.followEnd = true;

    for (
      let lineNo = this.offset;
      lineNo < Math.min(rendered.length, this.offset + rows);
      lineNo++
    ) {
      for (const link of this.linksInRenderedLine(
        rendered[lineNo] ?? "",
        lineNo,
      )) {
        const label = this.flashLabels[this.linkTargets.length];
        if (!label) return;
        this.linkTargets.push({ ...link, label });
      }
    }
  }

  chooseLink(label: string): string | undefined {
    const target = this.linkTargets.find((item) => item.label === label);
    this.linkTargets = [];
    return target?.url;
  }

  private collectFlashTargets(query: string): ScrollFlashTarget[] {
    const targets: ScrollFlashTarget[] = [];
    if (!query) return targets;
    const width = this.width();
    const rows = scrollbackRows(this.tui, width);
    const rendered = this.renderedLines(width);
    const maxOffset = Math.max(0, rendered.length - rows);
    this.offset = Math.max(0, Math.min(this.offset, maxOffset));
    if (this.offset === maxOffset) this.followEnd = true;
    const lines = rendered.map((line) => this.stripAnsi(line));
    for (
      let lineNo = this.offset;
      lineNo < Math.min(lines.length, this.offset + rows);
      lineNo++
    ) {
      const line = lines[lineNo] ?? "";
      for (let col = 0; col <= line.length - query.length; col++) {
        if (!line.startsWith(query, col)) continue;
        const label = this.flashLabels[targets.length];
        if (!label) return targets;
        targets.push({ line: lineNo, col, label });
      }
    }
    return targets;
  }

  startFlash(query: string): void {
    this.clearUserMessageSelection();
    this.linkTargets = [];
    this.flashQuery = query;
    this.flashTargets = this.collectFlashTargets(query);
  }

  refineFlash(data: string): boolean {
    if (data.length !== 1 || data.charCodeAt(0) < 32 || !this.flashQuery)
      return false;
    const query = this.flashQuery + data;
    const targets = this.collectFlashTargets(query);
    if (!targets.length) return false;
    this.flashQuery = query;
    this.flashTargets = targets;
    return true;
  }

  chooseFlash(label: string, enterSelection = false): boolean {
    this.clearUserMessageSelection();
    const target = this.flashTargets.find((item) => item.label === label);
    this.flashQuery = "";
    this.flashTargets = [];
    this.linkTargets = [];
    if (!target) return false;
    this.cursor = { line: target.line, col: target.col };
    this.selectionAnchor = enterSelection ? { ...this.cursor } : undefined;
    this.linewiseSelection = false;
    this.followEnd = false;
    return true;
  }

  moveCursor(
    direction: "h" | "j" | "k" | "l" | "w" | "b" | "e" | "0" | "$",
  ): void {
    this.clearUserMessageSelection();
    const width = this.width();
    const lines = this.renderedLines(width).map((line) =>
      this.stripAnsi(line).trimEnd(),
    );
    if (!lines.length) return;

    const currentLine = () => lines[this.cursor.line] ?? "";
    const isWord = (char: string | undefined) =>
      Boolean(char && /[A-Za-z0-9_]/.test(char));
    const nextLineStart = () => {
      if (this.cursor.line < lines.length - 1) {
        this.cursor.line++;
        this.cursor.col = 0;
        return true;
      }
      return false;
    };
    const prevLineEnd = () => {
      if (this.cursor.line > 0) {
        this.cursor.line--;
        this.cursor.col = Math.max(
          0,
          (lines[this.cursor.line] ?? "").length - 1,
        );
        return true;
      }
      return false;
    };

    if (direction === "h")
      this.cursor.col = this.characterStart(
        currentLine(),
        Math.max(0, this.cursor.col - 1),
      );
    else if (direction === "l")
      this.cursor.col = this.characterEnd(currentLine(), this.cursor.col);
    else if (direction === "j") this.cursor.line++;
    else if (direction === "k") this.cursor.line--;
    else if (direction === "0") this.cursor.col = 0;
    else if (direction === "$")
      this.cursor.col = Math.max(0, currentLine().length - 1);
    else if (direction === "w") {
      let line = currentLine();
      let i = this.cursor.col;
      if (isWord(line[i])) while (i < line.length && isWord(line[i])) i++;
      while (i < line.length && !isWord(line[i])) i++;
      if (i < line.length) this.cursor.col = i;
      else if (nextLineStart()) {
        line = currentLine();
        i = 0;
        while (i < line.length && !isWord(line[i])) i++;
        this.cursor.col = Math.min(i, Math.max(0, line.length - 1));
      }
    } else if (direction === "e") {
      let line = currentLine();
      let i = Math.min(this.cursor.col + 1, line.length - 1);
      while (i < line.length && !isWord(line[i])) i++;
      if (i >= line.length) {
        if (!nextLineStart()) return;
        line = currentLine();
        i = 0;
        while (i < line.length && !isWord(line[i])) i++;
      }
      while (i < line.length && isWord(line[i])) i++;
      this.cursor.col = Math.max(0, i - 1);
    } else if (direction === "b") {
      let line = currentLine();
      let i = this.cursor.col - 1;
      while (i >= 0 && !isWord(line[i])) i--;
      if (i < 0) {
        if (!prevLineEnd()) return;
        line = currentLine();
        i = this.cursor.col;
        while (i >= 0 && !isWord(line[i])) i--;
      }
      while (i > 0 && isWord(line[i - 1])) i--;
      this.cursor.col = Math.max(0, i);
    }

    this.cursor.line = Math.max(
      0,
      Math.min(this.cursor.line, lines.length - 1),
    );
    const maxCol = Math.max(0, (lines[this.cursor.line] ?? "").length - 1);
    this.cursor.col = Math.max(0, Math.min(this.cursor.col, maxCol));

    this.keepCursorVisible();
  }

  selectedText(): string {
    if (!this.selectionAnchor) return "";
    const width = this.width();
    const lines = this.renderedLines(width).map((line) =>
      this.stripAnsi(line).trimEnd(),
    );
    let start = this.selectionAnchor;
    let end = this.cursor;
    if (
      start.line > end.line ||
      (start.line === end.line && start.col > end.col)
    )
      [start, end] = [end, start];
    if (this.linewiseSelection)
      return lines.slice(start.line, end.line + 1).join("\n");
    const endCol = this.characterEnd(lines[end.line] ?? "", end.col);
    if (start.line === end.line)
      return (lines[start.line] ?? "").slice(start.col, endCol);
    const selected: string[] = [];
    selected.push((lines[start.line] ?? "").slice(start.col));
    for (let line = start.line + 1; line < end.line; line++)
      selected.push(lines[line] ?? "");
    selected.push((lines[end.line] ?? "").slice(0, endCol));
    return selected.join("\n");
  }

  private renderedLines(width: number): string[] {
    if (
      !this.cachedLines ||
      this.cachedWidth !== width ||
      !this.cachedUserRanges
    ) {
      const rendered = renderComponentsWithUserRanges(this.components, width);
      this.cachedWidth = width;
      this.cachedLines = rendered.lines;
      this.cachedUserRanges = rendered.userRanges;
    }

    return this.cachedLines;
  }

  private stripAnsi(line: string): string {
    return stripTerminalSequencesLocal(line);
  }

  private indexAtVisibleCol(line: string, targetCol: number): number {
    let visibleCol = 0;
    for (let i = 0; i < line.length;) {
      if (line[i] === "\x1b") {
        const sgr = /^\x1b\[[0-?]*[ -/]*[@-~]/.exec(line.slice(i));
        if (sgr) {
          i += sgr[0].length;
          continue;
        }
        const osc = /^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/.exec(line.slice(i));
        if (osc) {
          i += osc[0].length;
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

  private replaceVisibleCell(
    line: string,
    targetCol: number,
    label: string,
    styled = true,
  ): string {
    const start = this.indexAtVisibleCol(line, targetCol);
    if (start >= line.length) return line;
    let end = start;
    if (line[end] === "\x1b") {
      const sgr = /^\x1b\[[0-?]*[ -/]*[@-~]/.exec(line.slice(end));
      if (sgr) end += sgr[0].length;
      const osc = /^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/.exec(line.slice(end));
      if (osc) end += osc[0].length;
    }
    const char = line[end] ?? "";
    if (char) end += char.length;
    // Use 27m (inverse off), not 0m (full reset). That keeps whatever Pi's
    // renderer had active for the rest of the line: markdown colors, code block
    // syntax colors, muted tool text, etc.
    const styledLabel = "\x1b[1;93m" + label + "\x1b[22;39m";
    const replacement = styled
      ? "\x1b[7m" + styledLabel + "\x1b[27m"
      : styledLabel;
    return line.slice(0, start) + replacement + line.slice(end);
  }

  private highlightVisibleRange(
    line: string,
    startCol: number,
    endColExclusive: number,
  ): string {
    if (endColExclusive <= startCol) return line;
    const start = this.indexAtVisibleCol(line, startCol);
    const end = this.indexAtVisibleCol(line, endColExclusive);
    // Same trick: inverse on/off only, no SGR reset, so existing colors survive
    // both inside and after the highlighted selection.
    return (
      line.slice(0, start) +
      "\x1b[7m" +
      line.slice(start, end) +
      "\x1b[27m" +
      line.slice(end)
    );
  }

  private decorateLine(
    line: string,
    absoluteLine: number,
    width: number,
    selectedUserRange?: { start: number; end: number },
  ): string {
    const base =
      visibleWidth(line) > width ? truncateToWidth(line, width, "") : line;
    const paddedBase =
      base + " ".repeat(Math.max(0, width - visibleWidth(base)));

    const flash = this.flashTargets
      .filter((target) => target.line === absoluteLine)
      .sort((a, b) => b.col - a.col);
    const links = this.linkTargets
      .filter((target) => target.line === absoluteLine)
      .sort((a, b) => b.col - a.col);
    const isSelectionLine = (() => {
      if (!this.selectionAnchor) return false;
      let start = this.selectionAnchor;
      let end = this.cursor;
      if (
        start.line > end.line ||
        (start.line === end.line && start.col > end.col)
      )
        [start, end] = [end, start];
      return absoluteLine >= start.line && absoluteLine <= end.line;
    })();
    const isSelectedUserLine = Boolean(
      selectedUserRange &&
      absoluteLine >= selectedUserRange.start &&
      absoluteLine <= selectedUserRange.end,
    );

    // Preserve Pi's native message/tool/markdown colors unless we actually need
    // to paint flash labels, a visual selection, or the selected user-message
    // gutter marker. The first selection implementation stripped ANSI for every
    // scrollback line, which made scrollback look monochrome.
    const isCursorLine = absoluteLine === this.cursor.line;
    if (
      !flash.length &&
      !links.length &&
      !isSelectionLine &&
      !isSelectedUserLine &&
      !isCursorLine
    )
      return paddedBase;

    let decorated = paddedBase;
    if (isSelectedUserLine) {
      const insertAt = this.indexAtVisibleCol(decorated, 0);
      decorated =
        decorated.slice(0, insertAt) + "▌" + decorated.slice(insertAt);
    }

    for (const target of flash) {
      const matchWidth = Math.max(1, visibleWidth(this.flashQuery));
      decorated = this.highlightVisibleRange(
        decorated,
        target.col,
        target.col + matchWidth,
      );
      decorated = this.replaceVisibleCell(
        decorated,
        target.col,
        target.label,
        false,
      );
    }

    for (const target of links) {
      decorated = this.highlightVisibleRange(
        decorated,
        target.col,
        target.col + target.length,
      );
      decorated = this.replaceVisibleCell(
        decorated,
        target.col,
        target.label,
        false,
      );
    }

    if (
      isSelectionLine &&
      this.selectionAnchor &&
      !flash.length &&
      !links.length
    ) {
      let start = this.selectionAnchor;
      let end = this.cursor;
      if (
        start.line > end.line ||
        (start.line === end.line && start.col > end.col)
      )
        [start, end] = [end, start];
      const text = this.stripAnsi(base);
      const selectionStart =
        !this.linewiseSelection && absoluteLine === start.line
          ? visibleWidth(text.slice(0, start.col))
          : 0;
      const selectionEnd =
        !this.linewiseSelection && absoluteLine === end.line
          ? visibleWidth(text.slice(0, this.characterEnd(text, end.col)))
          : width;
      decorated = this.highlightVisibleRange(
        decorated,
        selectionStart,
        Math.max(selectionStart, selectionEnd),
      );
    }

    if (isCursorLine && !flash.length && !links.length) {
      const text = this.stripAnsi(base);
      const col = Math.min(
        Math.max(0, width - 1),
        visibleWidth(text.slice(0, this.cursor.col)),
      );
      const cellWidth = Math.max(
        1,
        visibleWidth(
          text.slice(this.cursor.col, this.characterEnd(text, this.cursor.col)),
        ),
      );
      const start = this.indexAtVisibleCol(decorated, col);
      const end = this.indexAtVisibleCol(decorated, col + cellWidth);
      // A cyan block remains distinct even inside an inverse-video selection.
      decorated =
        decorated.slice(0, start) +
        CURSOR_MARKER +
        "\x1b[30;106m" +
        decorated.slice(start, end) +
        "\x1b[39;49m" +
        decorated.slice(end);
    }

    const truncated = truncateToWidth(decorated, width, "");
    return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
  }

  render(width: number): string[] {
    // Overlay, not widget: do not participate in Pi layout. Compute the same
    // bottom area Pi is using for the real editor/footer instead of guessing.
    const rows = scrollbackRows(this.tui, width);
    const lines = this.renderedLines(width);
    const maxOffset = Math.max(0, lines.length - rows);
    const allowTopAlignedSelection =
      this.alignSelectedUserMessageTop &&
      this.selectedUserMessageStart !== undefined;
    const maxAllowedOffset = allowTopAlignedSelection
      ? Math.max(0, lines.length - 1)
      : maxOffset;
    this.offset = Math.max(0, Math.min(this.offset, maxAllowedOffset));
    if (!allowTopAlignedSelection) this.keepCursorVisible(width);
    const selectedUserRange = this.selectedUserMessageRange(width);
    if (this.selectedUserMessageStart !== undefined && !selectedUserRange)
      this.clearUserMessageSelection();
    this.cursor.line = Math.max(
      0,
      Math.min(this.cursor.line, Math.max(0, lines.length - 1)),
    );
    const visible = lines
      .slice(this.offset, this.offset + rows)
      // Fully cover the underlying native transcript. If overlay lines are
      // shorter/transparent, old Pi output can show through and look duplicated.
      .map((line, index) =>
        this.decorateLine(line, this.offset + index, width, selectedUserRange),
      );
    if (visible.length < rows) {
      const blankRows = Array(rows - visible.length).fill(
        " ".repeat(Math.max(1, width)),
      );
      return allowTopAlignedSelection
        ? [...visible, ...blankRows]
        : [...blankRows, ...visible];
    }
    return visible;
  }
}

function isUserMessageComponent(component: Component): boolean {
  return (component as any)?.constructor?.name === "UserMessageComponent";
}

function childComponents(component: Component): Component[] | undefined {
  const name = (component as any)?.constructor?.name;
  if (name !== "Container" && name !== "TUI") return undefined;
  const children = (component as any)?.children;
  return Array.isArray(children) ? children.filter(Boolean) : undefined;
}

function renderComponentWithUserRanges(
  component: Component,
  width: number,
): RenderedTranscript {
  if (isUserMessageComponent(component)) {
    const lines = component.render(width);
    return {
      lines,
      userRanges: lines.length ? [{ start: 0, end: lines.length - 1 }] : [],
    };
  }

  const children = childComponents(component);
  if (children) return renderComponentsWithUserRanges(children, width);

  return { lines: component.render(width), userRanges: [] };
}

function renderComponentsWithUserRanges(
  components: Component[],
  width: number,
): RenderedTranscript {
  const lines: string[] = [];
  const userRanges: LineRange[] = [];

  for (const component of components) {
    const rendered = renderComponentWithUserRanges(component, width);
    if (!rendered.lines.length) continue;
    const base = lines.length;
    lines.push(...rendered.lines);
    for (const range of rendered.userRanges) {
      userRanges.push({ start: base + range.start, end: base + range.end });
    }
  }

  return { lines: lines.length ? lines : [""], userRanges };
}

export function renderComponents(
  components: Component[],
  width: number,
): string[] {
  return renderComponentsWithUserRanges(components, width).lines;
}

export function nativeTranscriptComponents(tui: TUI): Component[] {
  // Pi 0.84 mounts the interactive TUI root as:
  // 0 transcript/document scroll view, 1 pending messages, 2 status,
  // 3 widgets above editor, 4 editor, 5 widgets below editor, 6 footer.
  // Older pi-vim-flash versions sliced 1..4 from the pre-0.84 layout, which
  // omitted the transcript and made the overlay draw blank rows as soon as
  // scrollback opened. Use the actual transcript-side components instead of
  // reconstructing messages from session state; this keeps scrollback visually
  // aligned with native Pi.
  const children = ((tui as any).children ?? []) as Component[];
  return children.slice(0, 3).filter(Boolean);
}

export function scrollbackRows(
  tui?: TUI,
  width = process.stdout.columns || 80,
): number {
  const terminalRows = tui?.terminal.rows || process.stdout.rows || 30;
  const children = ((tui as any)?.children ?? []) as Component[];
  // Pi 0.84 root layout: 3 widgets above editor, 4 editor, 5 widgets below
  // editor, 6 footer. Measure the dock components so the overlay stops exactly
  // above Pi's real input/footer area.
  const reserved = children
    .slice(3, 7)
    .reduce(
      (rows, component) =>
        rows + Math.max(0, component?.render(width)?.length ?? 0),
      0,
    );
  return Math.max(1, terminalRows - Math.max(3, reserved));
}

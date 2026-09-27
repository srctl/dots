/**
 * Pure text operations: no Pi UI, clipboard, or session state.
 *
 * A motion returns a JavaScript string offset. An operator (delete/change/yank)
 * turns that motion into a range. Ranges use the same convention as slice():
 * start is included, end is excluded. Text objects select a word or enclosure
 * without needing a motion first; for example `ciw` means "change inner word".
 */
export type VimMotion =
  | "w"
  | "W"
  | "b"
  | "B"
  | "e"
  | "E"
  | "0"
  | "^"
  | "$"
  | "%"
  | "gg"
  | "G"
  | "{"
  | "}";
export type TextObjectKind = "i" | "a";

export interface TextRange {
  start: number;
  end: number;
  linewise?: boolean;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function isKeyword(character: string | undefined): boolean {
  return Boolean(character && /[\p{L}\p{N}_]/u.test(character));
}

function isWhitespace(character: string | undefined): boolean {
  return Boolean(character && /\s/u.test(character));
}

// Lowercase w/b/e distinguish punctuation from letters. Uppercase W/B/E treat
// every run of non-whitespace characters as one WORD (including punctuation).
function sameWordClass(
  first: string | undefined,
  second: string | undefined,
  wholeWord: boolean,
): boolean {
  if (!first || !second) return false;
  if (wholeWord) return !isWhitespace(first) && !isWhitespace(second);
  if (isWhitespace(first) || isWhitespace(second))
    return isWhitespace(first) && isWhitespace(second);
  return isKeyword(first) === isKeyword(second);
}

export function lineBounds(
  text: string,
  index: number,
): { start: number; end: number } {
  const position = clamp(index, 0, text.length);
  const previousNewline =
    position === 0 ? -1 : text.lastIndexOf("\n", position - 1);
  const nextNewline = text.indexOf("\n", position);
  return {
    start: previousNewline + 1,
    end: nextNewline === -1 ? text.length : nextNewline,
  };
}

function nextWordStart(
  text: string,
  index: number,
  wholeWord: boolean,
): number {
  let position = clamp(index, 0, text.length);
  const firstCharacter = text[position];
  if (!isWhitespace(firstCharacter)) {
    while (
      position < text.length &&
      sameWordClass(firstCharacter, text[position], wholeWord)
    )
      position++;
  }
  while (position < text.length && isWhitespace(text[position])) position++;
  return position;
}

function previousWordStart(
  text: string,
  index: number,
  wholeWord: boolean,
): number {
  let position = clamp(index - 1, -1, text.length - 1);
  while (position >= 0 && isWhitespace(text[position])) position--;
  if (position < 0) return 0;
  const firstCharacter = text[position];
  while (
    position > 0 &&
    sameWordClass(firstCharacter, text[position - 1], wholeWord)
  )
    position--;
  return position;
}

function wordEnd(text: string, index: number, wholeWord: boolean): number {
  let position = clamp(index + 1, 0, Math.max(0, text.length - 1));
  while (position < text.length && isWhitespace(text[position])) position++;
  if (position >= text.length) return text.length;
  const firstCharacter = text[position];
  while (
    position + 1 < text.length &&
    sameWordClass(firstCharacter, text[position + 1], wholeWord)
  )
    position++;
  return position;
}

function matchingDelimiter(text: string, index: number): number {
  const pairs: Record<string, string> = {
    "(": ")",
    "[": "]",
    "{": "}",
    ")": "(",
    "]": "[",
    "}": "{",
  };
  const bounds = lineBounds(text, index);
  let start = index;
  while (start < bounds.end && !pairs[text[start] ?? ""]) start++;
  const opening = text[start];
  const closing = pairs[opening ?? ""];
  if (!closing) return index;

  const direction =
    opening === "(" || opening === "[" || opening === "{" ? 1 : -1;
  let depth = 0;
  for (
    let position = start;
    position >= 0 && position < text.length;
    position += direction
  ) {
    if (text[position] === opening) depth++;
    else if (text[position] === closing) {
      depth--;
      if (depth === 0) return position;
    }
  }
  return index;
}

function paragraphTarget(
  text: string,
  index: number,
  direction: 1 | -1,
): number {
  const lines = text.split("\n");
  let line = text.slice(0, index).split("\n").length - 1;
  if (direction > 0) {
    line++;
    while (line < lines.length && lines[line]?.trim()) line++;
    while (line < lines.length && !lines[line]?.trim()) line++;
  } else {
    line--;
    while (line > 0 && !lines[line]?.trim()) line--;
    while (line > 0 && lines[line - 1]?.trim()) line--;
  }

  const targetLine = clamp(line, 0, lines.length - 1);
  let offset = 0;
  for (let row = 0; row < targetLine; row++) offset += lines[row]!.length + 1;
  return offset;
}

function singleMotionTarget(
  text: string,
  index: number,
  motion: VimMotion,
): number {
  switch (motion) {
    case "w":
      return nextWordStart(text, index, false);
    case "W":
      return nextWordStart(text, index, true);
    case "b":
      return previousWordStart(text, index, false);
    case "B":
      return previousWordStart(text, index, true);
    case "e":
      return wordEnd(text, index, false);
    case "E":
      return wordEnd(text, index, true);
    case "0":
      return lineBounds(text, index).start;
    case "$":
      return lineBounds(text, index).end;
    case "^": {
      const bounds = lineBounds(text, index);
      const firstNonspace = /\S/.exec(text.slice(bounds.start, bounds.end));
      return bounds.start + (firstNonspace?.index ?? 0);
    }
    case "%":
      return matchingDelimiter(text, index);
    case "gg":
      return 0;
    case "G":
      return text.length;
    case "{":
      return paragraphTarget(text, index, -1);
    case "}":
      return paragraphTarget(text, index, 1);
  }
}

export function motionTarget(
  text: string,
  index: number,
  motion: VimMotion,
  count = 1,
): number {
  let target = clamp(index, 0, text.length);
  const repetitions = clamp(Math.floor(count) || 1, 1, 9999);
  for (let step = 0; step < repetitions; step++)
    target = singleMotionTarget(text, target, motion);
  return target;
}

export function operatorRange(
  text: string,
  index: number,
  motion: VimMotion,
  count = 1,
): TextRange | undefined {
  const target = motionTarget(text, index, motion, count);
  if (target === index) return undefined;
  const includesTarget = motion === "e" || motion === "E" || motion === "%";
  let end = Math.max(index, target);
  if (target >= index && includesTarget) end++;
  return { start: Math.min(index, target), end: Math.min(text.length, end) };
}

/** f/F land on the character; t/T (until=true) stop one character before it. */
export function findCharacter(
  text: string,
  index: number,
  character: string,
  direction: 1 | -1,
  until: boolean,
  count = 1,
): number | undefined {
  const bounds = lineBounds(text, index);
  let position = index;
  let matches = 0;
  while (matches < Math.max(1, count)) {
    position += direction;
    if (position < bounds.start || position >= bounds.end) return undefined;
    if (text[position] === character) matches++;
  }
  return until ? position - direction : position;
}

function delimitedRange(
  text: string,
  index: number,
  open: string,
  close: string,
  kind: TextObjectKind,
): TextRange | undefined {
  let start = -1;
  let depth = 0;
  // Walk backward to find the opening delimiter that contains the cursor.
  for (
    let position = Math.min(index, text.length - 1);
    position >= 0;
    position--
  ) {
    if (text[position] === close) depth++;
    else if (text[position] === open) {
      if (depth === 0) {
        start = position;
        break;
      }
      depth--;
    }
  }
  if (start < 0) return undefined;

  depth = 0;
  let end = -1;
  for (let position = start + 1; position < text.length; position++) {
    if (text[position] === open) depth++;
    else if (text[position] === close) {
      if (depth === 0) {
        end = position;
        break;
      }
      depth--;
    }
  }
  if (end < 0 || index > end) return undefined;
  if (kind === "i") return { start: start + 1, end };
  return { start, end: end + 1 };
}

function quotedRange(
  text: string,
  index: number,
  quote: string,
  kind: TextObjectKind,
): TextRange | undefined {
  const bounds = lineBounds(text, index);
  const left = text.lastIndexOf(quote, index);
  if (left < bounds.start) return undefined;
  const right = text.indexOf(quote, Math.max(index + 1, left + 1));
  if (right < 0 || right > bounds.end) return undefined;
  if (kind === "i") return { start: left + 1, end: right };
  return { start: left, end: right + 1 };
}

function wordObjectRange(
  text: string,
  index: number,
  kind: TextObjectKind,
  wholeWord: boolean,
): TextRange | undefined {
  if (!text.length) return undefined;
  let position = clamp(index, 0, text.length - 1);
  while (position < text.length && isWhitespace(text[position])) position++;
  if (position >= text.length) return undefined;

  const firstCharacter = text[position];
  let start = position;
  let end = position + 1;
  while (start > 0 && sameWordClass(firstCharacter, text[start - 1], wholeWord))
    start--;
  while (
    end < text.length &&
    sameWordClass(firstCharacter, text[end], wholeWord)
  )
    end++;

  // "Around word" includes trailing spaces, or leading spaces when there are
  // none after the word. Never absorb a newline from the adjacent line.
  if (kind === "a") {
    const wordEnd = end;
    while (end < text.length && text[end] !== "\n" && isWhitespace(text[end]))
      end++;
    if (end === wordEnd) {
      while (
        start > 0 &&
        text[start - 1] !== "\n" &&
        isWhitespace(text[start - 1])
      )
        start--;
    }
  }
  return { start, end };
}

export function textObjectRange(
  text: string,
  index: number,
  kind: TextObjectKind,
  object: string,
): TextRange | undefined {
  if (object === "w" || object === "W")
    return wordObjectRange(text, index, kind, object === "W");
  if (object === '"' || object === "'" || object === "`")
    return quotedRange(text, index, object, kind);
  const pairs: Record<string, [string, string]> = {
    "(": ["(", ")"],
    ")": ["(", ")"],
    b: ["(", ")"],
    "[": ["[", "]"],
    "]": ["[", "]"],
    "{": ["{", "}"],
    "}": ["{", "}"],
    B: ["{", "}"],
  };
  const pair = pairs[object];
  if (!pair) return undefined;
  return delimitedRange(text, index, pair[0], pair[1], kind);
}

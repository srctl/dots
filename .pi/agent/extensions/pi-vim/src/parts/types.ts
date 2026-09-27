/** Prompt modes. Visual selects characters; visualLine selects whole lines. */
export type Mode = "insert" | "normal" | "visual" | "visualLine";

/** Zero-based line number and JavaScript string offset within that line. */
export type CursorPos = { line: number; col: number };

/** A location temporarily labeled with a key during a Flash search. */
export type FlashTarget = CursorPos & { label: string };

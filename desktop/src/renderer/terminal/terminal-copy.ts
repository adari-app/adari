// The terminal copies what you select, as Herdr,
// Ghostty with copy-on-select and Claude Code do: when a drag, a double click
// (a word) or a triple click (a line) ends with text selected, that text goes
// to the clipboard at once, once per selection (not Ghostty's macOS default,
// "copy-on-select none").
//
// ghostty-web 0.4.0's SelectionManager draws the selection and tracks the
// drag; it also copies on its own (navigator.clipboard, on the button coming
// up and on a double click), and its text and clicks differ from Ghostty's:
// - it puts a newline after every row, so a soft-wrapped line comes out cut
//   in pieces; Ghostty joins the rows of one line;
// - it trims each row's trailing blanks, a real space where a line wrapped
//   included; Ghostty trims at the line's end only (clipboard-trim-trailing-
//   spaces);
// - it writes a space for the tail cell of a wide character ("日 本 ");
// - a plain click makes a one-cell "selection" whose character it copies;
// - its double click takes /[\w-]/ runs on one row ("src" of src/main.ts);
//   Ghostty's word runs to its boundary characters (selection-word-chars:
//   blank, tab, ' " │ ` | : ; , ( ) [ ] { } < > $) and across soft wraps;
// - it has no triple click.
// So its copy is replaced by this one, which reads Ghostty's screen by
// Ghostty's rules, and the double and triple click are taken here, on the
// press, as Ghostty selects them. A click that only clears a selection, and a
// blank or whitespace selection, copy nothing. ghostty-web keeps the drawing,
// the drag and its auto-scroll.
//
// Ghostty's VT core gives the soft-wrap mark for the screen's rows (a row
// that continues the one above); rows already in the scrollback carry none,
// so a line that wrapped there reads as hard lines, as ghostty-web reads it.

/** One cell as Ghostty's VT core (ghostty-web's GhosttyTerminal) gives it. */
export interface GridCell {
  readonly codepoint: number;
  /** 2 for a wide character, 0 for its tail cell. */
  readonly width: number;
  readonly grapheme_len: number;
}

/** Ghostty's VT core as the copy reads it (ghostty-web's GhosttyTerminal). */
export interface Grid {
  getDimensions(): { cols: number; rows: number };
  getScrollbackLength(): number;
  /** 0 is the oldest line. */
  getScrollbackLine(offset: number): readonly GridCell[] | null;
  /** A row of the screen. */
  getLine(row: number): readonly GridCell[] | null;
  /** Whether the screen's row continues the row above it (a soft wrap). */
  isRowWrapped(row: number): boolean;
  getGraphemeString(row: number, col: number): string;
  getScrollbackGraphemeString(offset: number, col: number): string;
}

/** A cell by absolute row: the scrollback's rows first, then the screen's (ghostty-web's selection rows). */
export interface Point {
  readonly col: number;
  readonly row: number;
}

export interface Span {
  readonly start: Point;
  readonly end: Point;
}

/** What the app's clipboard takes (main's clipboardWrite drops a larger text). */
export const maxSelectionCopyBytes = 4 * 1_048_576;

/** Ghostty's default selection-word-chars (and an empty cell). */
const wordBoundaries = new Set([0, ..." \t'\"│`|:;,()[]{}<>$"].map((char) => (typeof char === "number" ? char : char.codePointAt(0)!)));

function rowCount(grid: Grid): number {
  return grid.getScrollbackLength() + grid.getDimensions().rows;
}

function cellsOf(grid: Grid, row: number): readonly GridCell[] | null {
  const scrollback = grid.getScrollbackLength();
  return row < scrollback ? grid.getScrollbackLine(row) : grid.getLine(row - scrollback);
}

/** Whether this row continues the row above it; unknown (false) in the scrollback. */
function continues(grid: Grid, row: number): boolean {
  const scrollback = grid.getScrollbackLength();
  if (row < scrollback || row >= rowCount(grid)) return false;
  return grid.isRowWrapped(row - scrollback);
}

function cellText(grid: Grid, row: number, col: number, cell: GridCell | undefined): string {
  if (cell === undefined) return "";
  if (cell.width === 0) return "";
  if (cell.codepoint === 0) return " ";
  if (cell.grapheme_len > 0) {
    const scrollback = grid.getScrollbackLength();
    return row < scrollback ? grid.getScrollbackGraphemeString(row, col) : grid.getGraphemeString(row - scrollback, col);
  }
  return String.fromCodePoint(cell.codepoint);
}

function ordered(a: Point, b: Point): [Point, Point] {
  return a.row < b.row || (a.row === b.row && a.col <= b.col) ? [a, b] : [b, a];
}

/**
 * The text between two cells (both included) as Ghostty copies it: the rows of
 * a soft-wrapped line joined, trailing blanks trimmed at each line's end, a
 * wide character once.
 */
export function selectedText(grid: Grid, from: Point, to: Point): string {
  const [start, end] = ordered(from, to);
  const cols = grid.getDimensions().cols;
  const last = Math.min(end.row, rowCount(grid) - 1);
  const lines: string[] = [];
  let line = "";
  for (let row = Math.max(0, start.row); row <= last; row += 1) {
    const cells = cellsOf(grid, row) ?? [];
    let first = row === start.row ? start.col : 0;
    const final = row === end.row ? end.col : cols - 1;
    // Starting on a wide character's tail takes the character.
    if (first > 0 && cells[first]?.width === 0) first -= 1;
    for (let col = first; col <= Math.min(final, cells.length - 1); col += 1) line += cellText(grid, row, col, cells[col]);
    if (row < last && continues(grid, row + 1)) continue;
    lines.push(line.replace(/[ \t]+$/, ""));
    line = "";
  }
  return lines.join("\n");
}

function isBoundary(cell: GridCell | undefined): boolean {
  return cell === undefined || wordBoundaries.has(cell.codepoint);
}

/**
 * The word at a cell by Ghostty's rule: the run of cells on the same side of
 * its boundary characters (a run of blanks when you click a blank), across
 * soft wraps. Null when the cell is not on the screen or in the scrollback.
 */
export function wordAt(grid: Grid, row: number, col: number): Span | null {
  const cols = grid.getDimensions().cols;
  if (row < 0 || row >= rowCount(grid) || col < 0 || col >= cols) return null;
  const rows = new Map<number, readonly GridCell[]>();
  const cell = (r: number, c: number): GridCell | undefined => {
    let cells = rows.get(r);
    if (cells === undefined) {
      cells = cellsOf(grid, r) ?? [];
      rows.set(r, cells);
    }
    // A wide character's tail is the character.
    const found = cells[c];
    return found?.width === 0 && c > 0 ? cells[c - 1] : found;
  };
  const kind = isBoundary(cell(row, col));
  let start: Point = { col, row };
  for (;;) {
    const previous: Point | null = start.col > 0 ? { col: start.col - 1, row: start.row } : continues(grid, start.row) ? { col: cols - 1, row: start.row - 1 } : null;
    if (previous === null || isBoundary(cell(previous.row, previous.col)) !== kind) break;
    start = previous;
  }
  let end: Point = { col, row };
  for (;;) {
    const next: Point | null = end.col < cols - 1 ? { col: end.col + 1, row: end.row } : continues(grid, end.row + 1) ? { col: 0, row: end.row + 1 } : null;
    if (next === null || isBoundary(cell(next.row, next.col)) !== kind) break;
    end = next;
  }
  return { start, end };
}

/** The line a row belongs to, its soft-wrapped rows included (Ghostty's triple click). */
export function lineAt(grid: Grid, row: number): Span | null {
  if (row < 0 || row >= rowCount(grid)) return null;
  const cols = grid.getDimensions().cols;
  let top = row;
  while (top > 0 && continues(grid, top)) top -= 1;
  let bottom = row;
  while (continues(grid, bottom + 1)) bottom += 1;
  return { start: { col: 0, row: top }, end: { col: cols - 1, row: bottom } };
}

interface Anchor {
  col: number;
  absoluteRow: number;
}

/** ghostty-web 0.4.0's SelectionManager, its private parts this copy takes over. */
interface GhosttySelection {
  selectionStart: Anchor | null;
  selectionEnd: Anchor | null;
  isSelecting: boolean;
  hasSelection(): boolean;
  copyToClipboard(text: string): Promise<void>;
  getWordAtCell(col: number, row: number): unknown;
  markCurrentSelectionDirty(): void;
  requestRender(): void;
}

function isGhosttySelection(value: unknown): value is GhosttySelection {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    "selectionStart" in v &&
    "selectionEnd" in v &&
    typeof v.hasSelection === "function" &&
    typeof v.copyToClipboard === "function" &&
    typeof v.getWordAtCell === "function" &&
    typeof v.markCurrentSelectionDirty === "function" &&
    typeof v.requestRender === "function"
  );
}

interface PressLike {
  readonly button?: number;
  readonly detail?: number;
}

interface CanvasLike {
  addEventListener(type: "mousedown", listener: (event: PressLike) => void): void;
  removeEventListener(type: "mousedown", listener: (event: PressLike) => void): void;
}

export interface SelectionCopyOptions {
  /** ghostty-web's SelectionManager (the terminal's `selectionManager`). */
  readonly selection: unknown;
  readonly grid: Grid;
  /** The canvas ghostty-web listens on (its renderer's). */
  readonly canvas: CanvasLike | EventTarget;
  copy(text: string): void;
  /** Said once a text went to the clipboard ("Copied"). */
  copied?(): void;
  /** A line to show (a selection too large to copy). */
  note(text: string): void;
}

export interface SelectionCopy {
  /** The selection's text as Ghostty copies it ("" with none); ⌘C copies this too. */
  text(): string;
  dispose(): void;
}

function utf8Length(text: string): number {
  return text.length * 3 <= maxSelectionCopyBytes ? text.length : new TextEncoder().encode(text).length;
}

/**
 * Copy on select over ghostty-web's SelectionManager. Null when the terminal
 * has none of the shape this version is known to have (nothing is changed then).
 */
export function installSelectionCopy(options: SelectionCopyOptions): SelectionCopy | null {
  const { selection, grid } = options;
  if (!isGhosttySelection(selection)) return null;
  const canvas = options.canvas as CanvasLike;
  let live = true;

  const api: SelectionCopy = {
    text: () => {
      const start = selection.selectionStart;
      const end = selection.selectionEnd;
      if (start === null || end === null) return "";
      return selectedText(grid, { col: start.col, row: start.absoluteRow }, { col: end.col, row: end.absoluteRow });
    },
    dispose: () => {
      live = false;
      canvas.removeEventListener("mousedown", onPress);
      selection.copyToClipboard = async () => undefined;
    },
  };

  /** A selection that just ended goes to the clipboard: never a cleared one, a blank one or one too large. */
  const copyNow = (taken: boolean): void => {
    if (!live) return;
    // A single click leaves ghostty-web a one-cell "selection": nothing you selected.
    if (!taken && !selection.hasSelection()) return;
    const text = api.text();
    if (text.trim() === "") return;
    if (utf8Length(text) > maxSelectionCopyBytes) {
      options.note(`Not copied: the selection is over ${maxSelectionCopyBytes / 1_048_576} MB.`);
      return;
    }
    options.copy(text);
    options.copied?.();
  };

  // ghostty-web calls this when a drag ends (and on its double click, turned off below).
  selection.copyToClipboard = async () => copyNow(false);
  // Its double click is replaced by Ghostty's, on the press below.
  selection.getWordAtCell = () => null;

  // After ghostty-web's own press (registered first): it has cleared the old
  // selection and put the anchor on the cell pressed.
  const onPress = (event: PressLike): void => {
    if (!live || event.button !== 0 || (event.detail ?? 1) < 2) return;
    const anchor = selection.selectionStart;
    if (anchor === null) return;
    const span = (event.detail ?? 1) === 2 ? wordAt(grid, anchor.absoluteRow, anchor.col) : lineAt(grid, anchor.absoluteRow);
    if (span === null) return;
    selection.markCurrentSelectionDirty();
    selection.selectionStart = { col: span.start.col, absoluteRow: span.start.row };
    selection.selectionEnd = { col: span.end.col, absoluteRow: span.end.row };
    // Chosen on the press: a move or the button coming up neither changes nor copies it again.
    selection.isSelecting = false;
    selection.markCurrentSelectionDirty();
    selection.requestRender();
    copyNow(true);
  };
  canvas.addEventListener("mousedown", onPress);
  return api;
}

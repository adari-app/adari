// Web addresses in the terminal are links. A provider
// for ghostty-web's link detector (registerLinkProvider) finds each http or
// https URL in a row, the rows a soft wrap joins to it included, by T3 Code's
// rules (apps/web/src/terminal-links.ts: URL_PATTERN, trimClosingDelimiters,
// isTerminalUrl, isTerminalLinkActivation): trailing punctuation off, a
// closing bracket kept only when the URL opened it. ⌘-click (Ctrl-click on
// Windows and Linux) opens it in the default browser through main
// (open-link.ts), as T3's handleLinkActivate does
// (apps/web/src/components/ThreadTerminalDrawer.tsx:1040); a plain click does
// what it did before (focus, selection). The pointer over a link is
// ghostty-web's own: a hand while over it, the link underlined.
//
// ghostty-web ships its own URL provider whose ⌘- or Ctrl-click calls
// window.open (the window's guard then opens http and https); this one takes
// its place (replaceUrlProvider) so one rule, and one open, holds. Its OSC 8
// provider (a program's own hyperlinks) stays as it is.
//
// The row text is rebuilt as
// the engine keeps it. In ghostty-web 0.4.0 `isWrapped` is set on the
// continuation row (the row a soft wrap carried on to), so a run starts at the
// last row above that is not a continuation and goes on while the next row is
// one. A two-column character fills its cell and a width-0 spacer cell after
// it (and a width-0 spacer head at a row's end when it wrapped to the next
// row); spacers add no text, and each character keeps every cell it covers.
// Scrollback rows carry no wrap data. When a run cannot be rebuilt whole (wrap
// data missing, a row bound, a cell that cannot be read), a URL that could go
// on past what was read is not offered, rather than a part of it.

import { isSafeExternalUrl } from "../../shared/external-url";

export interface TerminalUrlMatch {
  readonly text: string;
  /** Index of the first character in the line. */
  readonly start: number;
  /** Index after the last character. */
  readonly end: number;
}

// T3 Code's URL_PATTERN.
const urlPattern = /https?:\/\/[^\s"'`<>]+/giu;
// T3 Code's TRAILING_PUNCTUATION_PATTERN (URLs keep a trailing colon off too only for paths).
const trailingPunctuation = /[.,;!?]+$/;

/** T3 Code's trimClosingDelimiters for a URL: punctuation off, then each closing bracket the URL did not open. */
function trimClosingDelimiters(value: string): string {
  let output = value.replace(trailingPunctuation, "");
  if (output.length === 0) return output;
  const trimUnbalanced = (open: string, close: string): void => {
    while (output.endsWith(close)) {
      const opens = output.split(open).length - 1;
      const closes = output.split(close).length - 1;
      if (opens >= closes) return;
      output = output.slice(0, -1);
    }
  };
  trimUnbalanced("(", ")");
  trimUnbalanced("[", "]");
  trimUnbalanced("{", "}");
  return output;
}

/** A match with the end of its untrimmed run, which tells whether it reaches the end of the text. */
interface RawUrlMatch extends TerminalUrlMatch {
  readonly rawEnd: number;
}

function matchUrls(line: string): RawUrlMatch[] {
  const out: RawUrlMatch[] = [];
  urlPattern.lastIndex = 0;
  for (const match of line.matchAll(urlPattern)) {
    const text = trimClosingDelimiters(match[0]);
    if (!isTerminalUrl(text) || !isSafeExternalUrl(text)) continue;
    out.push({ text, start: match.index, end: match.index + text.length, rawEnd: match.index + match[0].length });
  }
  return out;
}

/** The http and https URLs in a line of terminal text, in order. */
export function extractTerminalUrls(line: string): TerminalUrlMatch[] {
  return matchUrls(line).map(({ text, start, end }) => ({ text, start, end }));
}

/** T3 Code's isTerminalUrl. */
export function isTerminalUrl(value: string): boolean {
  return /^https?:\/\/\S/iu.test(value);
}

/** T3 Code's isTerminalLinkActivation: ⌘-click on a Mac (not with Ctrl), Ctrl-click elsewhere (not with ⌘). */
export function isTerminalLinkActivation(
  event: { readonly metaKey: boolean; readonly ctrlKey: boolean },
  platform: string = typeof navigator === "undefined" ? "" : (navigator.platform ?? ""),
): boolean {
  if (platform.length === 0) return false;
  return /Mac|iPhone|iPad|iPod/.test(platform) ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

// MARK: - the provider (ghostty-web's ILinkProvider, by shape, so the tests need no engine)

interface CellLike {
  getCodepoint(): number;
  /** 1, 2 for a wide character, 0 for the spacer cell a wide character leaves (missing: 1). */
  getWidth?(): number;
}
interface LineLike {
  readonly length: number;
  /** True on a continuation row: the row above soft-wrapped onto this one. */
  readonly isWrapped: boolean;
  getCell(x: number): CellLike | undefined;
}
/** What the provider reads: the active buffer's rows (absolute, 0-based). */
export interface LinkBuffer {
  getLine(y: number): LineLike | undefined;
  /** False for a row whose `isWrapped` is not known (ghostty-web's scrollback rows); missing: every row's is. */
  wrapKnown?(y: number): boolean;
  /**
   * The cell's whole text, a grapheme's later code points included; null when it cannot be read; undefined when the
   * cell's code point is all of it.
   */
  cellText?(y: number, x: number, cell: CellLike): string | null | undefined;
}
export interface TerminalLink {
  readonly text: string;
  readonly range: { readonly start: { x: number; y: number }; readonly end: { x: number; y: number } };
  activate(event: MouseEvent | { readonly metaKey: boolean; readonly ctrlKey: boolean }): void;
}

/** A soft-wrapped run of rows is read as one line, at most this many rows above the row asked about. */
const maxJoinedRows = 16;

/** Where a character of the joined text sits: its row, its first cell and its last (a wide character covers two). */
interface CellSpan {
  readonly y: number;
  readonly x: number;
  readonly lastX: number;
}

interface JoinedRun {
  readonly text: string;
  /** One per UTF-16 unit of `text`. */
  readonly cells: readonly CellSpan[];
  /** Indexes of `text` standing for a cell that could not be read. */
  readonly unreadable: ReadonlySet<number>;
  /** The run may begin before what was read (a continuation with nothing above it, or no wrap data). */
  readonly startOpen: boolean;
  /** The run may go on after what was read. */
  readonly endOpen: boolean;
}

/** Stands for an unreadable cell: a character a URL may hold, so a match through it is seen and refused. */
const unreadableMark = "\uFFFD";

function codepointText(code: number): string | null {
  if (code === 0) return " ";
  if (code < 32 || code === 0x7f) return " ";
  if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return null;
  return String.fromCodePoint(code);
}

/** The row's run of soft-wrapped rows as text, with each UTF-16 unit's cells; null when the row is not there. */
function joinedRow(buffer: LinkBuffer, y: number): JoinedRun | null {
  const known = (row: number): boolean => buffer.wrapKnown?.(row) ?? true;
  if (buffer.getLine(y) === undefined) return null;
  // Back to the run's first row: up while this row is a continuation of the one above.
  let first = y;
  let startOpen = false;
  for (;;) {
    if (!known(first)) {
      startOpen = true;
      break;
    }
    if (buffer.getLine(first)?.isWrapped !== true) break;
    if (y - first >= maxJoinedRows || buffer.getLine(first - 1) === undefined) {
      startOpen = true;
      break;
    }
    first -= 1;
  }
  let text = "";
  const cells: CellSpan[] = [];
  const unreadable = new Set<number>();
  let endOpen = false;
  for (let row = first; ; row += 1) {
    const line = buffer.getLine(row);
    if (line === undefined) break;
    for (let x = 0; x < line.length; x += 1) {
      const cell = line.getCell(x);
      if (cell === undefined) {
        text += " ";
        cells.push({ y: row, x, lastX: x });
        continue;
      }
      const width = cell.getWidth?.() ?? 1;
      // The spacer a wide character leaves (after it, or at a row's end when it wrapped) holds no text.
      if (width === 0) continue;
      const lastX = Math.min(x + Math.max(width, 1) - 1, line.length - 1);
      const full = buffer.cellText?.(row, x, cell);
      let char = full === undefined ? codepointText(cell.getCodepoint()) : full;
      if (char !== null && char.length === 0) char = " ";
      if (char === null) {
        unreadable.add(text.length);
        char = unreadableMark;
      }
      text += char;
      for (let unit = 0; unit < char.length; unit += 1) cells.push({ y: row, x, lastX });
    }
    // On while the next row is a continuation of this one.
    const next = buffer.getLine(row + 1);
    if (next === undefined) break;
    if (!known(row + 1)) {
      endOpen = true;
      break;
    }
    if (!next.isWrapped) break;
    if (row + 1 - first >= maxJoinedRows * 2) {
      endOpen = true;
      break;
    }
  }
  return { text, cells, unreadable, startOpen, endOpen };
}

/** Where a URL's run of URL characters begins: just after the last character that ends one, before `start`. */
function runStart(text: string, start: number): number {
  let index = start;
  while (index > 0 && !/[\s"'`<>]/u.test(text[index - 1]!)) index -= 1;
  return index;
}

/** True when the match is the whole URL: no part of it may lie past what was read, and every cell of it was read. */
function wholeMatch(run: JoinedRun, match: RawUrlMatch): boolean {
  const from = runStart(run.text, match.start);
  if (run.startOpen && from === 0) return false;
  if (run.endOpen && match.rawEnd >= run.text.length) return false;
  for (const index of run.unreadable) if (index >= from && index < match.rawEnd) return false;
  return true;
}

/**
 * The provider: the URLs on row `y` (a URL that wraps onto or from it included), each opened by `open` on ⌘-click
 * (Ctrl-click off a Mac); a plain click opens nothing.
 */
export function terminalLinkProvider(buffer: () => LinkBuffer, open: (url: string) => void, platform?: string) {
  return {
    provideLinks(y: number, callback: (links: TerminalLink[] | undefined) => void): void {
      const row = joinedRow(buffer(), y);
      if (row === null) {
        callback(undefined);
        return;
      }
      const links: TerminalLink[] = [];
      for (const match of matchUrls(row.text)) {
        const start = row.cells[match.start];
        const end = row.cells[match.end - 1];
        if (start === undefined || end === undefined || start.y > y || end.y < y) continue;
        if (!wholeMatch(row, match)) continue;
        links.push({
          text: match.text,
          range: { start: { x: start.x, y: start.y }, end: { x: end.lastX, y: end.y } },
          activate: (event) => {
            if (isTerminalLinkActivation(event, platform)) open(match.text);
          },
        });
      }
      callback(links.length > 0 ? links : undefined);
    },
  };
}

// MARK: - ghostty-web's buffer, read as the engine keeps it

/** The parts of ghostty-web's Terminal the buffer reads, by shape. */
export interface GhosttyLinkSource {
  readonly buffer: { readonly active: { readonly type?: string; getLine(y: number): LineLike | undefined } };
  readonly wasmTerm?: {
    getScrollbackLength(): number;
    getGrapheme?(row: number, col: number): number[] | null;
    getScrollbackGrapheme?(offset: number, col: number): number[] | null;
  };
}

/** The cell's grapheme length when ghostty-web's cell shows it (its cell data is not public); undefined when not. */
function graphemeLength(cell: CellLike): number | undefined {
  const value = (cell as { cell?: { grapheme_len?: unknown } }).cell?.grapheme_len;
  return typeof value === "number" ? value : undefined;
}

/**
 * The terminal's active buffer for the provider, as of now: a normal screen's scrollback rows (absolute rows before
 * the scrollback length) have no wrap data, and a cell holding a grapheme is read whole through the engine.
 */
export function ghosttyLinkBuffer(terminal: GhosttyLinkSource): LinkBuffer {
  const active = terminal.buffer.active;
  const wasm = terminal.wasmTerm;
  const scrollback = active.type === "alternate" || wasm === undefined ? 0 : wasm.getScrollbackLength();
  return {
    getLine: (y) => active.getLine(y),
    wrapKnown: (y) => y >= scrollback,
    cellText: (y, x, cell) => {
      const code = cell.getCodepoint();
      if (code === 0) return undefined;
      const length = graphemeLength(cell);
      if (length === 0) return undefined;
      const lookup = y < scrollback ? wasm?.getScrollbackGrapheme?.bind(wasm, y) : wasm?.getGrapheme?.bind(wasm, y - scrollback);
      if (lookup === undefined) return length === undefined ? undefined : null;
      const codes = lookup(x);
      if (codes === null || codes.length === 0) return length === undefined ? undefined : null;
      let out = "";
      for (const each of codes) {
        const char = codepointText(each);
        if (char === null) return null;
        out += char;
      }
      return out;
    },
  };
}

/** ghostty-web's link detector, by shape (it is private there). */
interface DetectorLike {
  providers?: unknown[];
  registerProvider?(provider: unknown): void;
  invalidateCache?(): void;
}

/**
 * Puts `provider` in place of ghostty-web's own URL provider (`isBuiltIn` tells it), keeping its OSC 8 one; true
 * when it did. When the detector is not the shape this expects, the provider is added after the others (theirs
 * then answers first, still through the window's guard).
 */
export function replaceUrlProvider(terminal: { registerLinkProvider?(provider: never): void }, provider: unknown, isBuiltIn: (provider: unknown) => boolean): boolean {
  const detector = (terminal as unknown as { linkDetector?: DetectorLike }).linkDetector;
  if (detector !== undefined && detector !== null && Array.isArray(detector.providers)) {
    detector.providers = detector.providers.filter((each) => !isBuiltIn(each));
    detector.providers.push(provider);
    detector.invalidateCache?.();
    return true;
  }
  if (typeof terminal.registerLinkProvider === "function") terminal.registerLinkProvider(provider as never);
  return false;
}

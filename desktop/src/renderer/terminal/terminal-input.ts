// The terminal's wheel, copy and paste, as Ghostty does them. Ghostty's own docs (ghostty.5) give the defaults followed here:
// mouse-scroll-multiplier "precision:1,discrete:3" (a trackpad scrolls by its
// pixels, a wheel's notch three lines), mouse-reporting true (a program that
// asks for mouse reports gets the wheel), mouse-shift-capture false (Shift
// keeps the wheel for the scrollback), ⌘C copies (and, unlike Ghostty's
// macOS copy-on-select none, a selection copies as it ends:
// terminal-copy.ts), clipboard-paste-bracketed-safe (a bracketed paste goes as
// it is).
// Its scroll handling gives the routing: mouse reports when the program asked
// (button 64 up, 65 down, plus Alt 8 and Ctrl 16, in the format it asked for:
// SGR 1006, SGR pixels 1016, urxvt 1015, UTF-8 1005, else X10), else on the
// alternate screen with alternate scroll (1007, on by default) the cursor
// keys (DECCKM's form), else the scrollback; Shift held is the scrollback on
// either screen. One gesture is one scroll: what
// goes to a program is at most five lines an event and never a trackpad's
// momentum (the decaying run after the swipe; the browser reports no phase),
// and a change of direction starts over. A paste types the text as a person
// would, bracketed when the program
// asked; a pasted or dropped image or file uploads to the machine
// and its path is typed.

import { maxResidentBytes } from "../../shared/attachments";
import type { ClipboardFiles, UploadedAttachment } from "../../shared/ipc-contract";
import { carriesFiles, clipboardAnswers, clipboardLeftNote, intakeFiles, pasteTakesFiles, sourceOf, type FileLike, type ImagePreparer } from "../components/attachments";
import { failureText } from "../components/composer-drafts";
import type { SourceFile } from "../components/image-prepare";

/** What the input needs of the terminal (ghostty-web's Terminal in the app, Ghostty's VT core in the tests). */
export interface TerminalSurface {
  getMode(mode: number): boolean;
  alternateScreen(): boolean;
  mouseTracking(): boolean;
  bracketedPaste(): boolean;
  hasSelection(): boolean;
  getSelection(): string;
  /** Moves the viewport: negative up into the scrollback. */
  scrollLines(lines: number): void;
  cellHeight(): number;
  /** The cell under the pointer, 1-based, and its pixel position (for SGR pixels). */
  cellAt(event: WheelEventLike): { col: number; row: number; x?: number; y?: number };
}

export interface WheelEventLike {
  readonly deltaY: number;
  /** 0 pixels, 1 lines, 2 pages (WheelEvent.deltaMode). */
  readonly deltaMode: number;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly clientX?: number;
  readonly clientY?: number;
}

export interface KeyEventLike {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}

interface TransferLike {
  readonly types: readonly string[] | ArrayLike<string>;
  readonly files: ArrayLike<FileLike>;
  getData?(type: string): string;
}

export interface TerminalInputDeps {
  /** Typed into the program: text (UTF-8 on the way), or raw bytes (a legacy X10 mouse report). */
  send(data: string | Uint8Array): void;
  copy(text: string): void;
  /** A line to show (an attachment refused or not uploaded). */
  note(text: string): void;
  upload(data: Uint8Array, extension: string): Promise<UploadedAttachment>;
  clipboardFiles(): Promise<ClipboardFiles>;
  prepareImage: ImagePreparer;
  now?: () => number;
}

/** Ghostty's discrete multiplier: lines per wheel notch. */
export const linesPerNotch = 3;
/** At most this many lines go to a program for one event. */
export const maxProgramLines = 5;
/** A pause this long (ms) between wheel events starts a new gesture. */
export const gesturePauseMs = 150;

const DECCKM = 1;
const ALTERNATE_SCROLL = 1007;
const MOUSE_UTF8 = 1005;
const MOUSE_SGR = 1006;
const MOUSE_URXVT = 1015;
const MOUSE_SGR_PIXELS = 1016;

const bracketStart = "\x1b[200~";
const bracketEnd = "\x1b[201~";

/**
 * Clipboard text as a person would type it: a
 * line feed becomes a carriage return (CRLF once), tabs stay, and every other
 * control character is dropped, so a paste cannot carry escape sequences or
 * bracketed-paste markers.
 */
export function safePaste(text: string): string {
  let out = "";
  let afterCR = false;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code === 0x0d) {
      out += char;
      afterCR = true;
      continue;
    }
    if (code === 0x0a) {
      if (!afterCR) out += "\r";
    } else if (code === 0x09) {
      out += char;
    } else if (!(code <= 0x1f || (code >= 0x7f && code <= 0x9f))) {
      out += char;
    }
    afterCR = false;
  }
  return out;
}

export class TerminalInput {
  private readonly now: () => number;
  private lastAt = -Infinity;
  private direction = 0;
  private pending = 0;
  private lastAbs = 0;
  private peak = 0;
  private decaying = 0;
  private momentum = false;

  constructor(
    private readonly surface: TerminalSurface,
    private readonly deps: TerminalInputDeps,
  ) {
    this.now = deps.now ?? (() => performance.now());
  }

  /** Bytes as one paste: bracketed when the program asked for it. */
  private pasted(text: string): string {
    return this.surface.bracketedPaste() ? bracketStart + text + bracketEnd : text;
  }

  /** A wheel event; true when it was handled here (ghostty-web's own handling is skipped). */
  wheel(event: WheelEventLike): boolean {
    const now = this.now();
    const discrete = event.deltaMode !== 0;
    const lines =
      event.deltaMode === 1 ? event.deltaY * linesPerNotch : event.deltaMode === 2 ? event.deltaY * 24 : event.deltaY / Math.max(1, this.surface.cellHeight());
    const direction = Math.sign(lines);
    if (direction === 0) return true;
    const abs = Math.abs(event.deltaY);
    if (now - this.lastAt > gesturePauseMs || direction !== this.direction) {
      // A new gesture (or a turn): nothing carried over.
      this.pending = 0;
      this.peak = 0;
      this.lastAbs = 0;
      this.decaying = 0;
      this.momentum = false;
    }
    this.lastAt = now;
    this.direction = direction;
    if (!discrete) {
      if (abs > this.lastAbs) {
        this.decaying = 0;
        // Fingers back on the pad during the momentum: a new swipe.
        if (this.momentum && abs > this.lastAbs * 1.5) this.momentum = false;
      } else if (abs < this.lastAbs) {
        this.decaying += 1;
      }
      this.peak = Math.max(this.peak, abs);
      if (this.decaying >= 2 && abs < this.peak) this.momentum = true;
      this.lastAbs = abs;
    }

    const route = this.route(event);
    if (route !== "scrollback" && this.momentum) {
      this.pending = 0;
      return true;
    }
    this.pending += lines;
    let whole = Math.trunc(this.pending);
    this.pending -= whole;
    if (whole === 0) return true;
    if (route === "scrollback") {
      this.surface.scrollLines(whole);
      return true;
    }
    if (Math.abs(whole) > maxProgramLines) whole = Math.sign(whole) * maxProgramLines;
    const up = whole < 0;
    const sequence = route === "mouse" ? this.mouseReport(event, up) : this.arrow(up);
    if (sequence === null) return true;
    for (let n = 0; n < Math.abs(whole); n += 1) this.deps.send(sequence);
    return true;
  }

  private route(event: WheelEventLike): "mouse" | "arrows" | "scrollback" {
    // Shift keeps the wheel for the scrollback (mouse-shift-capture false),
    // before either route to a program: mouse reports or alternate-scroll arrows.
    if (event.shiftKey) return "scrollback";
    if (this.surface.mouseTracking()) return "mouse";
    if (this.surface.alternateScreen() && this.mode(ALTERNATE_SCROLL, true)) return "arrows";
    return "scrollback";
  }

  private mode(mode: number, fallback: boolean): boolean {
    try {
      return this.surface.getMode(mode);
    } catch {
      return fallback;
    }
  }

  private arrow(up: boolean): string {
    const application = this.mode(DECCKM, false);
    return `\x1b${application ? "O" : "["}${up ? "A" : "B"}`;
  }

  /**
   * One wheel press in the program's mouse format; null where X10 cannot say
   * the cell. X10 is raw bytes (32 + coordinate, up to 255), never UTF-8
   * encoded on the way; the UTF-8 mode (1005) is text.
   */
  private mouseReport(event: WheelEventLike, up: boolean): string | Uint8Array | null {
    let button = up ? 64 : 65;
    if (event.altKey || event.metaKey) button += 8;
    if (event.ctrlKey) button += 16;
    const cell = this.surface.cellAt(event);
    if (this.mode(MOUSE_SGR_PIXELS, false) && cell.x !== undefined && cell.y !== undefined) {
      return `\x1b[<${button};${Math.max(1, Math.round(cell.x))};${Math.max(1, Math.round(cell.y))}M`;
    }
    if (this.mode(MOUSE_SGR, false)) return `\x1b[<${button};${cell.col};${cell.row}M`;
    if (this.mode(MOUSE_URXVT, false)) return `\x1b[${32 + button};${cell.col};${cell.row}M`;
    if (this.mode(MOUSE_UTF8, false)) {
      if (32 + cell.col > 0x7ff || 32 + cell.row > 0x7ff) return null;
      return `\x1b[M${String.fromCharCode(32 + button)}${String.fromCodePoint(32 + cell.col)}${String.fromCodePoint(32 + cell.row)}`;
    }
    if (32 + cell.col > 255 || 32 + cell.row > 255) return null;
    return Uint8Array.of(0x1b, 0x5b, 0x4d, 32 + button, 32 + cell.col, 32 + cell.row);
  }

  /**
   * A key, before ghostty-web encodes it; true when it was handled here. ⌘C
   * (Ctrl+Shift+C elsewhere) copies the selection and never reaches the
   * program; ⌘V is left to the Edit menu's paste (paste below).
   */
  key(event: KeyEventLike): boolean {
    const copy = (event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === "c") ||
      (event.ctrlKey && event.shiftKey && !event.metaKey && event.key.toLowerCase() === "c");
    if (!copy) return false;
    if (this.surface.hasSelection()) {
      const text = this.surface.getSelection();
      if (text !== "") this.deps.copy(text);
    }
    return true;
  }

  /** A paste event on the terminal; true when it was taken here. */
  paste(event: { clipboardData: TransferLike | null; preventDefault(): void; stopPropagation(): void }): boolean {
    const data = event.clipboardData;
    if (data === null) return false;
    if (pasteTakesFiles({ types: data.types, getData: (type) => data.getData?.(type) ?? "" })) {
      event.preventDefault();
      event.stopPropagation();
      void this.pasteFiles(Array.from(data.files));
      return true;
    }
    const text = data.getData?.("text/plain") ?? "";
    event.preventDefault();
    event.stopPropagation();
    const safe = safePaste(text);
    if (safe !== "") this.deps.send(this.pasted(safe));
    return true;
  }

  /** Files dropped on the terminal: uploaded, their paths typed. */
  drop(event: { dataTransfer: TransferLike | null; preventDefault(): void; stopPropagation?(): void }): boolean {
    if (!carriesFiles(event.dataTransfer)) return false;
    event.preventDefault();
    event.stopPropagation?.();
    void this.typeUploads(Array.from(event.dataTransfer!.files).map((file) => sourceOf(file)));
    return true;
  }

  private async pasteFiles(domFiles: FileLike[]): Promise<void> {
    let copied: ClipboardFiles | null = null;
    try {
      copied = await this.deps.clipboardFiles();
    } catch {
      copied = null;
    }
    // Main's read of a Finder copy is the answer whenever it says anything
    // (Chat's attachPasted rule): a refused, too large or unreadable file is
    // said, never swapped for the icon Chromium pastes beside it.
    if (clipboardAnswers(copied)) {
      const sources = copied.files.map((file): SourceFile => ({ name: file.name, type: file.type, size: file.data.byteLength, bytes: async () => file.data }));
      await this.typeUploads(sources, clipboardLeftNote(copied));
      return;
    }
    await this.typeUploads(domFiles.map((file) => sourceOf(file, file.type.startsWith("image/") ? `Pasted image.${file.name.split(".").pop() ?? "png"}` : file.name)));
  }

  /** Each file uploads in turn; once all have, their paths are typed as one paste. */
  private async typeUploads(files: readonly SourceFile[], left: string | null = null): Promise<void> {
    const intake = await intakeFiles(files, this.deps.prepareImage, maxResidentBytes);
    const note = [left, intake.note].filter((line): line is string => line !== null).join(" ");
    if (note !== "") this.deps.note(note);
    const paths: string[] = [];
    for (const payload of intake.payloads) {
      try {
        paths.push((await this.deps.upload(payload.data, payload.extension)).path);
      } catch (failure) {
        this.deps.note(`${payload.name} did not upload (${failureText(failure, "the upload stopped")}).`);
        return;
      }
    }
    if (paths.length > 0) this.deps.send(this.pasted(paths.join(" ")));
  }
}

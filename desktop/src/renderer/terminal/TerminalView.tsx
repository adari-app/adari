// One pane's terminal: Ghostty's VT core (ghostty-web: the Ghostty parser and
// screen compiled to WebAssembly, drawn on a canvas) fed the bytes Herdr's
// attach sends, keys sent back. It fills its area edge to edge, as Ghostty's
// own window does (no column cap, no centring, Ghostty's 2-point padding);
// every size change, and every text size change (⌘+ / ⌘- / ⌘0), is passed on
// so the remote PTY follows. The wheel, ⌘C, a paste and a drop go through
// terminal-input.ts, by Ghostty's rules. What you
// select is copied as the selection ends (terminal-copy.ts), with a "Copied" note in the tile's corner;
// a program's own copy (an OSC 52 write) only right after your own key or
// mouse in the tile on show (osc52.ts). A web address is a link that
// ⌘-click opens in the default browser (terminal-links.ts).
// Each terminal runs on a Ghostty engine of its own, so a new one never shows
// a closed one's text (terminal-core.ts).

import { FitAddon, Terminal, UrlRegexProvider } from "ghostty-web";
import { useEffect, useRef, useState } from "react";

import type { ClipboardFiles, UploadedAttachment } from "../../shared/ipc-contract";
import { prepareImage } from "../components/image-prepare";
import { openLink } from "../open-link";
import { Osc52Clipboard } from "./osc52";
import { installSelectionCopy, type SelectionCopy } from "./terminal-copy";
import { newTerminalCore, openTerminal } from "./terminal-core";
import { ghosttyLinkBuffer, replaceUrlProvider, terminalLinkProvider } from "./terminal-links";
import { TerminalInput, type TerminalSurface, type WheelEventLike } from "./terminal-input";
import { darkPastel, terminalFontFamily, terminalFontSize } from "./theme";

/** Where a terminal's bytes come from and its keys go. */
export interface TerminalPort {
  subscribe(onData: (bytes: Uint8Array) => void): () => void;
  /** Text (UTF-8 on the way) or raw bytes (a legacy X10 mouse report). */
  input(data: string | Uint8Array): void;
  resize(cols: number, rows: number): void;
  /** An attachment to the pane's machine (a pasted or dropped image or file); absent where nothing uploads. */
  upload?(data: Uint8Array, extension: string): Promise<UploadedAttachment>;
  /**
   * The engine parsed `bytes` more of what `subscribe` delivered, in order (Ghostty's
   * write parses before it returns). Bytes kept while the engine loads are not parsed until written.
   */
  parsed?(bytes: number): void;
}

const noClipboardFiles: ClipboardFiles = { files: [], refused: [], excess: [], failures: [] };

/** How long "Copied" shows after a copy (the app's code-block Copy, T3 Code's 1.2 s). */
export const copiedMs = 1_200;

/** ghostty-web's Terminal as the input needs it; the selection reads as the copy reads it. */
function surfaceOf(terminal: Terminal, host: HTMLElement, copy: SelectionCopy | null): TerminalSurface {
  return {
    getMode: (mode) => terminal.getMode(mode),
    alternateScreen: () => terminal.buffer.active.type === "alternate",
    mouseTracking: () => terminal.hasMouseTracking(),
    bracketedPaste: () => terminal.hasBracketedPaste(),
    hasSelection: () => terminal.hasSelection(),
    getSelection: () => (copy === null ? terminal.getSelection() : copy.text()),
    scrollLines: (lines) => terminal.scrollLines(lines),
    cellHeight: () => terminal.renderer?.charHeight ?? 17,
    cellAt: (event: WheelEventLike) => {
      const canvas = host.querySelector("canvas");
      const width = terminal.renderer?.charWidth ?? 8;
      const height = terminal.renderer?.charHeight ?? 17;
      if (canvas === null || event.clientX === undefined || event.clientY === undefined) return { col: 1, row: 1 };
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      return {
        col: Math.min(terminal.cols, Math.max(1, Math.floor(x / width) + 1)),
        row: Math.min(terminal.rows, Math.max(1, Math.floor(y / height) + 1)),
        x,
        y,
      };
    },
  };
}

export interface TerminalViewProps {
  readonly port: TerminalPort;
  /** Takes the keyboard when shown. */
  readonly autoFocus?: boolean;
  readonly onSize?: (cols: number, rows: number) => void;
  /** The window's text size (points). */
  readonly fontSize?: number;
  /** Changing it gives the terminal the keyboard again (the message box closed). */
  readonly focusSignal?: number;
  /** A line to show over the terminal (an attachment refused or not uploaded). */
  readonly onNote?: (text: string) => void;
  /** The visible screen as text, about once a second after new output (the context ring reads it). */
  readonly onScreen?: (text: string) => void;
}

/** How long after output the screen is read for onScreen. */
const screenReadDelayMs = 1_000;

/** The live screen (not a scrolled-back view) as text, one line per row. */
function visibleText(terminal: Terminal): string {
  const buffer = terminal.buffer.active;
  const lines: string[] = [];
  for (let y = 0; y < terminal.rows; y += 1) lines.push(buffer.getLine(buffer.baseY + y)?.translateToString(true) ?? "");
  return lines.join("\n");
}

export function TerminalView({ port, autoFocus = true, onSize, fontSize = terminalFontSize, focusSignal = 0, onNote, onScreen }: TerminalViewProps) {
  const noteListener = useRef(onNote);
  noteListener.current = onNote;
  const frame = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const sizeListener = useRef(onSize);
  sizeListener.current = onSize;
  const size = useRef(fontSize);
  size.current = fontSize;
  const live = useRef<{ terminal: Terminal; layout: () => void } | null>(null);
  // Whether this view should have the keyboard: read when the terminal comes
  // up (a focus asked while the engine loads), never a reason to rebuild it.
  const wantsFocus = useRef(autoFocus);
  wantsFocus.current = autoFocus;
  // The screen listener (after the refs the tests place by their order).
  const screenListener = useRef(onScreen);
  screenListener.current = onScreen;
  // "Copied" for a moment after each copy; a new copy shows it afresh.
  const [copied, setCopied] = useState<number | null>(null);
  useEffect(() => {
    if (copied === null) return;
    const timer = setTimeout(() => setCopied(null), copiedMs);
    return () => clearTimeout(timer);
  }, [copied]);

  useEffect(() => {
    const frameElement = frame.current;
    const hostElement = host.current;
    if (frameElement === null || hostElement === null) return;
    let disposed = false;
    let terminal: Terminal | null = null;
    let fit: FitAddon | null = null;
    let observer: ResizeObserver | null = null;
    let unsubscribe: (() => void) | null = null;
    let detach: (() => void) | null = null;
    // What the terminal's open left listening, taken back after its dispose (terminal-core.ts).
    let closeTerminal: (() => void) | null = null;
    let selectionCopy: SelectionCopy | null = null;
    const markCopied = (): void => setCopied((n) => (n ?? 0) + 1);
    // A program's OSC 52 write: honoured right after your own action here, while the tile is on show.
    const programCopy = new Osc52Clipboard({
      now: () => Date.now(),
      shown: () => document.visibilityState !== "hidden" && hostElement.isConnected && hostElement.getClientRects().length > 0,
      copy: (text) => window.herdrDesktop.copyText(text),
      copied: markCopied,
      note: (text) => noteListener.current?.(text),
    });
    const onAction = (): void => programCopy.action();
    for (const type of ["keydown", "mousedown"] as const) frameElement.addEventListener(type, onAction, { capture: true });
    const pending: Uint8Array[] = [];
    let screenTimer: ReturnType<typeof setTimeout> | null = null;
    const screenSoon = (): void => {
      if (screenTimer !== null || screenListener.current === undefined) return;
      screenTimer = setTimeout(() => {
        screenTimer = null;
        if (terminal !== null && !disposed) screenListener.current?.(visibleText(terminal));
      }, screenReadDelayMs);
    };
    // Bytes that arrive before the engine is up are kept, in order.
    unsubscribe = port.subscribe((bytes) => {
      programCopy.bytes(bytes);
      if (terminal === null) pending.push(bytes);
      else {
        terminal.write(bytes);
        port.parsed?.(bytes.length);
        screenSoon();
      }
    });

    const layout = (): void => {
      if (terminal === null || fit === null) return;
      const proposed = fit.proposeDimensions();
      if (proposed === undefined) return;
      const cols = Math.max(2, proposed.cols);
      const rows = Math.max(1, proposed.rows);
      if (cols !== terminal.cols || rows !== terminal.rows) terminal.resize(cols, rows);
      port.resize(cols, rows);
      sizeListener.current?.(cols, rows);
    };

    void (async () => {
      // Its own engine, never the window's shared one (terminal-core.ts).
      const [ghostty] = await Promise.all([newTerminalCore(), document.fonts.load(`${size.current}px "JetBrains Mono"`)]);
      if (disposed) return;
      terminal = new Terminal({
        ghostty,
        fontFamily: terminalFontFamily,
        fontSize: size.current,
        theme: darkPastel,
        cursorBlink: false,
        cursorStyle: "block",
        scrollback: 10_000,
        // The wheel moves the scrollback at once, by the trackpad's own pixels (terminal-input.ts).
        smoothScrollDuration: 0,
      });
      fit = new FitAddon();
      terminal.loadAddon(fit);
      closeTerminal = openTerminal(terminal, hostElement);
      terminal.onData((data) => port.input(data));
      const term = terminal;
      // Http and https URLs are links; ⌘-click opens one in the default browser (terminal-links.ts).
      replaceUrlProvider(
        term,
        terminalLinkProvider(() => ghosttyLinkBuffer(term), (url) => void openLink(url)),
        (provider) => provider instanceof UrlRegexProvider,
      );
      const bridge = window.herdrDesktop;
      const canvas = term.renderer?.getCanvas();
      // Copy on select, by Ghostty's rules, in place of ghostty-web's own copy (terminal-copy.ts).
      selectionCopy =
        term.wasmTerm === undefined || canvas === undefined
          ? null
          : installSelectionCopy({
              selection: (term as unknown as { selectionManager?: unknown }).selectionManager,
              grid: term.wasmTerm,
              canvas,
              copy: (text) => bridge.copyText(text),
              copied: markCopied,
              note: (text) => noteListener.current?.(text),
            });
      const input = new TerminalInput(surfaceOf(term, hostElement, selectionCopy), {
        send: (data) => port.input(data),
        copy: (text) => {
          bridge.copyText(text);
          markCopied();
        },
        note: (text) => noteListener.current?.(text),
        upload: (data, extension) =>
          port.upload === undefined ? Promise.reject(new Error("Uploads are not available for this machine.")) : port.upload(data, extension),
        clipboardFiles: () => bridge.clipboardFiles?.() ?? Promise.resolve(noClipboardFiles),
        prepareImage,
      });
      term.attachCustomWheelEventHandler((event) => input.wheel(event));
      term.attachCustomKeyEventHandler((event) => input.key(event));
      // Before ghostty-web's own two paste handlers (its box and the hidden textarea, which would both
      // type it): text typed safely and once, files uploaded. The host may be the target itself, so no
      // other listener on it runs either.
      const onPaste = (event: ClipboardEvent): void => {
        if (input.paste(event)) event.stopImmediatePropagation();
      };
      const onDragOver = (event: DragEvent): void => {
        if (event.dataTransfer !== null && Array.from(event.dataTransfer.types).includes("Files")) {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }
      };
      const onDrop = (event: DragEvent): void => {
        if (input.drop(event)) term.focus();
      };
      hostElement.addEventListener("paste", onPaste, { capture: true });
      frameElement.addEventListener("dragover", onDragOver);
      frameElement.addEventListener("drop", onDrop);
      detach = () => {
        hostElement.removeEventListener("paste", onPaste, { capture: true });
        frameElement.removeEventListener("dragover", onDragOver);
        frameElement.removeEventListener("drop", onDrop);
      };
      for (const bytes of pending.splice(0)) {
        terminal.write(bytes);
        port.parsed?.(bytes.length);
      }
      screenSoon();
      layout();
      live.current = { terminal, layout };
      observer = new ResizeObserver(() => requestAnimationFrame(layout));
      observer.observe(frameElement);
      if (wantsFocus.current) terminal.focus();
    })();

    return () => {
      disposed = true;
      if (screenTimer !== null) clearTimeout(screenTimer);
      live.current = null;
      observer?.disconnect();
      detach?.();
      selectionCopy?.dispose();
      for (const type of ["keydown", "mousedown"] as const) frameElement.removeEventListener(type, onAction, { capture: true });
      unsubscribe?.();
      terminal?.dispose();
      closeTerminal?.();
      hostElement.replaceChildren();
    };
    // The terminal's lifetime follows its port alone: a change of focus keeps
    // the same screen and scrollback.
  }, [port]);

  // Focus is its own effect: a tile clicked takes the keyboard on the terminal
  // it already has. Before the terminal is up, `wantsFocus` carries the ask.
  useEffect(() => {
    if (autoFocus) live.current?.terminal.focus();
  }, [autoFocus]);

  // ⌘+ / ⌘- / ⌘0: the new size, then the grid that fits it, passed on to the PTY.
  useEffect(() => {
    const current = live.current;
    if (current === null || current.terminal.options.fontSize === fontSize) return;
    current.terminal.options.fontSize = fontSize;
    requestAnimationFrame(current.layout);
  }, [fontSize]);

  useEffect(() => {
    if (focusSignal > 0) live.current?.terminal.focus();
  }, [focusSignal]);

  return (
    <div className="term-frame" ref={frame}>
      <div className="term-host" ref={host} />
      {copied === null ? null : (
        <div className="term-copied" role="status">
          Copied
        </div>
      )}
    </div>
  );
}

// A TerminalPort backed by the main process: the attach opens at the first
// size the view lays out (so the remote PTY starts at the right grid), keys
// typed before it opens are held in order, and bytes the main process sends
// before the open call returns are kept until the session id is known.
//
// One port is one attach. Its life is idle -> opening -> open -> ended, or
// opening -> failed; ended and failed are final: the
// view's ResizeObserver keeps calling resize() on layout changes, and that
// must never start another attach, nor carry keys typed after the end into
// one. Held keys and early buffers are dropped when it ends. Reopening is a
// deliberate act that makes a new port (the terminal's Reconnect button).

import type { HerdrDesktopBridge, UploadedAttachment } from "../../shared/ipc-contract";
import type { TerminalPort } from "./TerminalView";
import { uploadsStore } from "../settings/uploads-store";

export type RemoteTerminalState = "idle" | "opening" | "open" | "ended" | "failed" | "disposed";

function describe(error: unknown): string {
  return error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(error);
}

export class RemoteTerminalPort implements TerminalPort {
  private stateValue: RemoteTerminalState = "idle";
  private sessionId: string | null = null;
  private readonly listeners = new Set<(bytes: Uint8Array) => void>();
  private readonly pendingInput: (string | Uint8Array)[] = [];
  /** Bytes for sessions not yet known to this port (the open reply may trail the first bytes). */
  private readonly early = new Map<string, Uint8Array[]>();
  private readonly earlyExit = new Map<string, string | null>();
  private readonly unsubscribers: (() => void)[] = [];
  private latest: { cols: number; rows: number } | null = null;
  /** Parsed bytes not yet told to main (told once per turn of the event loop). */
  private parsedBytes = 0;

  constructor(
    private readonly bridge: HerdrDesktopBridge,
    private readonly hostId: string,
    private readonly paneId: string,
    private readonly onExit: (reason: string | null) => void,
    private readonly onError: (message: string) => void,
  ) {
    this.unsubscribers.push(
      bridge.onTerminalData((event) => {
        if (this.stateValue === "open" && event.sessionId === this.sessionId) {
          this.deliver(event.data);
        } else if (this.stateValue === "opening") {
          const list = this.early.get(event.sessionId) ?? [];
          list.push(event.data);
          this.early.set(event.sessionId, list);
        }
      }),
      bridge.onTerminalExit((event) => {
        if (this.stateValue === "open" && event.sessionId === this.sessionId) {
          this.end("ended");
          this.onExit(event.reason);
        } else if (this.stateValue === "opening") {
          this.earlyExit.set(event.sessionId, event.reason);
        }
      }),
    );
  }

  get state(): RemoteTerminalState {
    return this.stateValue;
  }

  /** A pasted or dropped attachment, to this pane's machine. */
  upload(data: Uint8Array, extension: string): Promise<UploadedAttachment> {
    // Once it settles, Settings' count of this machine's uploads is stale.
    return this.bridge.uploadAttachment(this.hostId, data, extension).finally(() => uploadsStore.invalidate(this.hostId));
  }

  private deliver(bytes: Uint8Array): void {
    for (const listener of this.listeners) listener(bytes);
    // No view takes them: dropped, so nothing holds them (a credited stream is not held back by them).
    if (this.listeners.size === 0) this.parsed(bytes.length);
  }

  /** The view's terminal parsed `bytes` more of this session's output; main is told, gathered. */
  parsed(bytes: number): void {
    if (this.stateValue !== "open" || this.sessionId === null || bytes <= 0) return;
    const first = this.parsedBytes === 0;
    this.parsedBytes += bytes;
    if (!first) return;
    const sessionId = this.sessionId;
    queueMicrotask(() => {
      const told = this.parsedBytes;
      this.parsedBytes = 0;
      if (told > 0 && this.stateValue === "open" && this.sessionId === sessionId) this.bridge.terminalParsed?.(sessionId, told);
    });
  }

  /** Final: forget the session, held keys and early buffers. */
  private end(state: "ended" | "failed" | "disposed"): void {
    this.stateValue = state;
    this.sessionId = null;
    this.parsedBytes = 0;
    this.pendingInput.length = 0;
    this.early.clear();
    this.earlyExit.clear();
  }

  subscribe(onData: (bytes: Uint8Array) => void): () => void {
    this.listeners.add(onData);
    return () => this.listeners.delete(onData);
  }

  input(data: string | Uint8Array): void {
    if (this.stateValue === "open" && this.sessionId !== null) this.bridge.terminalInput(this.sessionId, data);
    else if (this.stateValue === "idle" || this.stateValue === "opening") this.pendingInput.push(data);
    // ended, failed, disposed: dropped
  }

  resize(cols: number, rows: number): void {
    this.latest = { cols, rows };
    if (this.stateValue === "open" && this.sessionId !== null) {
      this.bridge.terminalResize(this.sessionId, cols, rows);
      return;
    }
    if (this.stateValue !== "idle") return;
    this.stateValue = "opening";
    this.bridge.openTerminal({ hostId: this.hostId, paneId: this.paneId, cols, rows }).then(
      ({ sessionId }) => this.opened(sessionId, cols, rows),
      (error: unknown) => {
        if (this.stateValue !== "opening") return;
        this.end("failed");
        this.onError(describe(error));
      },
    );
  }

  private opened(sessionId: string, cols: number, rows: number): void {
    if (this.stateValue !== "opening") {
      // Disposed while opening: the session is not wanted.
      this.bridge.closeTerminal(sessionId);
      return;
    }
    this.stateValue = "open";
    this.sessionId = sessionId;
    for (const bytes of this.early.get(sessionId) ?? []) this.deliver(bytes);
    this.early.clear();
    if (this.earlyExit.has(sessionId)) {
      const reason = this.earlyExit.get(sessionId) ?? null;
      this.end("ended");
      this.onExit(reason);
      return;
    }
    this.earlyExit.clear();
    for (const data of this.pendingInput.splice(0)) this.bridge.terminalInput(sessionId, data);
    if (this.latest !== null && (this.latest.cols !== cols || this.latest.rows !== rows)) {
      this.bridge.terminalResize(sessionId, this.latest.cols, this.latest.rows);
    }
  }

  dispose(): void {
    const sessionId = this.stateValue === "open" ? this.sessionId : null;
    this.end("disposed");
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    this.listeners.clear();
    if (sessionId !== null) this.bridge.closeTerminal(sessionId);
  }
}

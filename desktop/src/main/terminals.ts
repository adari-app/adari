// Open terminals, one per shown pane: the backend's attach on one side, the
// page that asked on the other. Bytes go to that page only; a page that goes
// away takes its terminals with it.

import { randomUUID } from "node:crypto";

import type { WebContents } from "electron";

import { IPC, type TerminalDataEvent, type TerminalExitEvent, type TerminalOpenRequest } from "../shared/ipc-contract";
import type { TerminalHandle } from "./herdr/backend";
import { boxChecks as sharedBoxChecks, type BoxChecks } from "./herdr/claude-box";
import { clampDimensions } from "./herdr/terminal";
import type { HostRegistry } from "./hosts";
import type { PaneInputs } from "./pane-inputs";

interface OpenTerminal {
  readonly owner: WebContents;
  /** The pane its input counts for. */
  readonly hostId: string;
  readonly paneId: string;
  handle: TerminalHandle | null;
  closed: boolean;
  /** Aborted when the page closes it before it opened, so the backend stops opening. */
  readonly opening: AbortController;
}

export class TerminalSessions {
  private readonly sessions = new Map<string, OpenTerminal>();

  /**
   * `inputs`: each pane's Terminal input counted (a chip pick stops on any). `boxes`: the
   * Claude box checks the Send IPC reads, marked by any input.
   */
  constructor(
    private readonly hosts: HostRegistry,
    private readonly inputs?: PaneInputs,
    private readonly boxes: BoxChecks = sharedBoxChecks,
  ) {}

  async open(owner: WebContents, request: TerminalOpenRequest): Promise<{ sessionId: string }> {
    const backend = this.hosts.backend(request.hostId);
    const pane = this.hosts.pane(request.hostId, request.paneId);
    if (backend === null || pane === null) throw new Error("That pane is no longer listed.");
    const sessionId = randomUUID();
    const session: OpenTerminal = { owner, hostId: request.hostId, paneId: request.paneId, handle: null, closed: false, opening: new AbortController() };
    this.sessions.set(sessionId, session);
    const send = (channel: string, payload: TerminalDataEvent | TerminalExitEvent): void => {
      if (!owner.isDestroyed()) owner.send(channel, payload);
    };
    try {
      session.handle = await backend.openTerminal(
        pane,
        clampDimensions(request.cols, request.rows),
        {
          data: (data) => {
            if (!session.closed) send(IPC.terminalData, { sessionId, data });
          },
          exit: (reason) => {
            if (session.closed) return;
            session.closed = true;
            this.sessions.delete(sessionId);
            send(IPC.terminalExit, { sessionId, reason });
          },
        },
        session.opening.signal,
      );
    } catch (error) {
      this.sessions.delete(sessionId);
      throw error;
    }
    if (session.closed) session.handle.close();
    return { sessionId };
  }

  /** Text goes UTF-8 encoded; raw bytes (a legacy X10 mouse report) go as they are, copied. */
  input(owner: WebContents, sessionId: string, data: string | Uint8Array): void {
    const session = this.owned(owner, sessionId);
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : Uint8Array.from(data);
    if (session !== null) {
      this.inputs?.bump(session.hostId, session.paneId);
      // Any input written here can change Claude's box (an Escape putting a
      // message back, an arrow recalling one, plain typed text): the next Chat send to this pane reads the box
      // first. Bound to the terminal's own machine and pane (that machine's writer, as the Send IPC keys it),
      // never the current selection.
      const backend = session.handle !== null ? this.hosts.backend(session.hostId) : null;
      if (backend !== null) this.boxes.mark(backend, session.paneId);
    }
    session?.handle?.input(bytes);
  }

  /** The page's terminal parsed `bytes` more of this session's output. */
  parsed(owner: WebContents, sessionId: string, bytes: number): void {
    this.owned(owner, sessionId)?.handle?.parsed?.(bytes);
  }

  resize(owner: WebContents, sessionId: string, cols: number, rows: number): void {
    const size = clampDimensions(cols, rows);
    this.owned(owner, sessionId)?.handle?.resize(size.cols, size.rows);
  }

  close(owner: WebContents, sessionId: string): void {
    const session = this.owned(owner, sessionId);
    if (session === null) return;
    session.closed = true;
    this.sessions.delete(sessionId);
    session.opening.abort();
    session.handle?.close();
  }

  closeAll(owner?: WebContents): void {
    for (const [sessionId, session] of this.sessions) {
      if (owner !== undefined && session.owner !== owner) continue;
      session.closed = true;
      this.sessions.delete(sessionId);
      // One still opening stops now (no handle yet to close).
      session.opening.abort();
      session.handle?.close();
    }
  }

  private owned(owner: WebContents, sessionId: string): OpenTerminal | null {
    const session = this.sessions.get(sessionId);
    return session !== undefined && session.owner === owner ? session : null;
  }
}

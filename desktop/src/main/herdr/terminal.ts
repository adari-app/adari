// The pieces of CitadelTransport's PTY attach that are policy rather than SSH
// plumbing (Sources/HerdrKit/CitadelTransport.swift, OfficialTerminalConnection):
//
// - readiness: the attach is ready for keys once Herdr's first frame prefix
//   appears in the output (the prefix may straddle two packets);
// - ordered input: every keystroke takes a ticket when it is sent; one sent
//   before the attach was ready is dropped (it would have landed in the login
//   shell, not the pane) but keeps its place, so later keys still go in order;
// - the ending: Herdr's last diagnostic line says whether another client holds
//   the pane or took it over.

export const officialFramePrefix = Buffer.from("\u001b[?2026h\u001b[?25l\u001b]8;;\u001b\\", "utf8");

export interface TerminalDimensions {
  readonly cols: number;
  readonly rows: number;
}

/** TerminalDimensions.clamped: at least 4 columns and 2 rows. */
export function clampDimensions(cols: number, rows: number): TerminalDimensions {
  return { cols: Math.max(4, Math.floor(cols)), rows: Math.max(2, Math.floor(rows)) };
}

export class AttachReadiness {
  private probe = Buffer.alloc(0);
  private ready = false;

  constructor(initiallyReady = false) {
    this.ready = initiallyReady;
  }

  get isReady(): boolean {
    return this.ready;
  }

  /** Feeds output; returns true exactly once, when the attach becomes ready. */
  record(data: Uint8Array): boolean {
    if (this.ready) return false;
    this.probe = Buffer.concat([this.probe, Buffer.from(data)]);
    if (this.probe.indexOf(officialFramePrefix) >= 0) {
      this.ready = true;
      this.probe = Buffer.alloc(0);
      return true;
    }
    const overlap = Math.max(0, officialFramePrefix.length - 1);
    if (this.probe.length > overlap) this.probe = this.probe.subarray(this.probe.length - overlap);
    return false;
  }
}

/**
 * OrderedTerminalInputBuffer with the send-time readiness rule. `issue` is
 * called synchronously at send time (so tickets follow the user's key order);
 * `accept` places the data, empty when it was sent before readiness; `takeNext`
 * hands out the next ticket's bytes in order once they are present.
 */
export class OrderedTerminalInput {
  private nextTicket = 0;
  private nextToWrite = 0;
  private readonly pending = new Map<number, Uint8Array>();

  issue(): number {
    const ticket = this.nextTicket;
    this.nextTicket += 1;
    return ticket;
  }

  accept(ticket: number, data: Uint8Array, acceptedAtSend: boolean): void {
    this.pending.set(ticket, acceptedAtSend ? data : new Uint8Array(0));
  }

  /** The next bytes to write, in ticket order; undefined while the next ticket is missing. */
  takeNext(): Uint8Array | undefined {
    const data = this.pending.get(this.nextToWrite);
    if (data === undefined) return undefined;
    this.pending.delete(this.nextToWrite);
    this.nextToWrite += 1;
    return data;
  }

  clear(): void {
    this.pending.clear();
    this.nextToWrite = this.nextTicket;
  }
}

export type AttachEnding = "held-elsewhere" | "taken-over";

const diagnosticPrefix = "herdr: server shut down: ";
const attachKinds = ["terminal", "agent"] as const;
const refusalSuffix = " already has an attached client; retry with --takeover";

/** Strips CSI and string escapes, then splits into trimmed lines (OfficialAttachEnding.lines). */
export function plainLines(text: string): string[] {
  let plain = "";
  const scalars = [...text];
  for (let i = 0; i < scalars.length; i += 1) {
    const scalar = scalars[i];
    if (scalar !== "\u001b") {
      plain += scalar;
      continue;
    }
    i += 1;
    const next = scalars[i];
    if (next === undefined) break;
    if (next === "[") {
      for (i += 1; i < scalars.length; i += 1) {
        const code = scalars[i]?.codePointAt(0) ?? 0;
        if (code >= 0x40 && code <= 0x7e) break;
      }
    } else if (next === "]" || next === "P" || next === "_" || next === "^" || next === "X") {
      for (i += 1; i < scalars.length; i += 1) {
        if (scalars[i] === "\u0007") break;
        if (scalars[i] === "\u001b") {
          i += 1;
          break;
        }
      }
    }
  }
  return plain
    .split(/[\r\n]/)
    .map((line) => line.replace(/^[ \t]+|[ \t]+$/g, ""))
    .filter((line) => line !== "");
}

export function classifyAttachEndingLine(line: string): AttachEnding | null {
  if (!line.startsWith(diagnosticPrefix)) return null;
  const message = line.slice(diagnosticPrefix.length);
  for (const kind of attachKinds) {
    if (message === `${kind} attach taken over`) return "taken-over";
    const failed = `${kind} attach failed: terminal `;
    if (!message.startsWith(failed) || !message.endsWith(refusalSuffix)) continue;
    const id = message.slice(failed.length, message.length - refusalSuffix.length);
    if (id !== "" && !/[ \t]/.test(id)) return "held-elsewhere";
  }
  return null;
}

/** OfficialAttachEnding.classify: only the LAST line counts. */
export function classifyAttachEnding(text: string): AttachEnding | null {
  const lines = plainLines(text);
  const last = lines[lines.length - 1];
  return last === undefined ? null : classifyAttachEndingLine(last);
}

export function describeAttachEnding(ending: AttachEnding): string {
  // OfficialTerminalError.controllerBusy / .takenOver, word for word.
  return ending === "held-elsewhere"
    ? "This terminal already has a controller. The companion did not take it over. Detach the other controller, then reconnect."
    : "This terminal was opened on another device.";
}

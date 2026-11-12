// How a request reaches a Herdr server (HerdrKit `HerdrTransport`): the command
// socket is single-shot, so every request is its own exec: write one line, read
// one reply line. The demo transport and the SSH transport both implement it,
// so the same HerdrClient and the same decoders serve both.

import { maxDiagnosticBytes, maxResponseLineBytes, socketMissingSentinel } from "./commands";
import { ClosedBeforeResponseError, RemoteSocketFailedError, ResponseTooLargeError, type TransportError } from "./errors";

/** One request's own deadline (agent.prompt's), instead of the transport's default. */
export interface RoundTripOptions {
  readonly timeoutMs?: number;
  /**
   * The caller's deadline, which owns the request.
   * Aborted, the request's connection is let go of and ended (a newer one is
   * never touched), and a request still connecting is never sent.
   */
  readonly signal?: AbortSignal;
}

export interface HerdrTransport {
  /** Opens a connection, writes one request line, reads one reply line, closes. */
  roundTrip(requestLine: string, options?: RoundTripOptions): Promise<string>;
  /** Drops any held connection. */
  close(): void;
  /**
   * The held connection's epoch: every new connection takes the next number, so
   * a request sent now goes on the connection of this number; null while none
   * is held (the next request opens a new one). Absent where a request holds
   * nothing between calls (the demo).
   */
  connectionEpoch?(): number | null;
}

/** The detail of a socket that is not there (the sentinel): This Mac reads it as Herdr not running there. */
export const socketMissingDetail = "the session is not running or the socket path is wrong";

/** CitadelTransport.classifySocketFailure: the sentinel, else the remote diagnostic, else the exit code. */
export function classifySocketFailure(stderr: string, exitCode: number, remoteSocketPath: string): TransportError {
  let detail: string;
  if (stderr.includes(socketMissingSentinel)) {
    detail = socketMissingDetail;
  } else {
    const trimmed = stderr.trim();
    detail = trimmed === "" ? `remote command exited ${exitCode}` : trimmed;
  }
  return new RemoteSocketFailedError(remoteSocketPath, detail);
}

const newline = 0x0a;

/**
 * Collects one exec's output the way CitadelTransport.parseBridgeOutput does:
 * raw stdout bytes, decoded as UTF-8 only at a newline (so a multi-byte
 * character split across two SSH packets is never corrupted); the first
 * complete line is the reply; stderr is kept, bounded, as the diagnostic; a
 * non-zero exit without a reply is classified; a reply without its trailing
 * newline still counts when the channel ends.
 */
export class ReplyCollector {
  private buffered: Buffer[] = [];
  private bufferedBytes = 0;
  private stderr = "";
  private reply: string | null = null;

  constructor(private readonly remoteSocketPath: string) {}

  /** Feeds stdout; returns the reply once its line is complete. Throws on an oversized line. */
  stdout(chunk: Uint8Array): string | null {
    if (this.reply !== null) return this.reply;
    const data = Buffer.from(chunk);
    const index = data.indexOf(newline);
    if (index >= 0) {
      const line = Buffer.concat([...this.buffered, data.subarray(0, index)]);
      this.buffered = [];
      this.bufferedBytes = 0;
      if (line.length > maxResponseLineBytes) throw new ResponseTooLargeError(line.length, maxResponseLineBytes);
      this.reply = line.toString("utf8");
      return this.reply;
    }
    this.buffered.push(data);
    this.bufferedBytes += data.length;
    if (this.bufferedBytes > maxResponseLineBytes) {
      throw new ResponseTooLargeError(this.bufferedBytes, maxResponseLineBytes);
    }
    return null;
  }

  stderrChunk(chunk: Uint8Array): void {
    if (Buffer.byteLength(this.stderr, "utf8") >= maxDiagnosticBytes) return;
    this.stderr += Buffer.from(chunk).toString("utf8");
    if (Buffer.byteLength(this.stderr, "utf8") > maxDiagnosticBytes) {
      this.stderr = Buffer.from(this.stderr, "utf8").subarray(0, maxDiagnosticBytes).toString("utf8");
    }
  }

  /** The channel ended (exit code null when the server sent none). Returns the reply or throws. */
  finish(exitCode: number | null): string {
    if (this.reply !== null) return this.reply;
    const remainder = this.bufferedBytes > 0 ? Buffer.concat(this.buffered).toString("utf8") : null;
    if (exitCode !== null && exitCode !== 0) {
      if (remainder !== null) return remainder;
      throw classifySocketFailure(this.stderr, exitCode, this.remoteSocketPath);
    }
    if (remainder !== null) return remainder;
    if (this.stderr !== "") throw classifySocketFailure(this.stderr, 0, this.remoteSocketPath);
    throw new ClosedBeforeResponseError();
  }
}

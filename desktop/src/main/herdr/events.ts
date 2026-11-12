// Herdr's event stream (`events.subscribe`), as HerdrKit reads it
// (HerdrClient.subscribe and classify, CitadelTransport.stream): one request
// line written to the API socket through `nc -U` on an SSH exec of its OWN
// (not the shared command connection), stdin left open (closing it ends the
// subscription on the server), then one JSON line per event, decoded as UTF-8
// only at a newline. The first line is `subscription_started`; each event is
// `{ "event": "<kind>", "data": { ... } }`, the kind dotted or snake case.
// The desktop follows the layout kinds with it.

import type { Client, ClientChannel } from "ssh2";

import { heldSocketCommand, maxDiagnosticBytes, maxResponseLineBytes, requestLine, sessionSocketPath, socketPayload } from "./commands";
import { ResponseTooLargeError } from "./errors";
import type { PinningHostKeyPolicy } from "./host-key-pinning";
import { paneMethods } from "./pane-methods";
import type { RelayClient, RelayHandle } from "./relay";
import { connectSsh, type SshHostConfig } from "./ssh";
import { classifySocketFailure } from "./transport";

/** What a stream tells its follower. */
export interface EventSink {
  /** Herdr acknowledged the subscription: events follow. */
  started(): void;
  /** One event: its kind dotted ("layout.updated"), and the pane it names, if any. */
  event(kind: string, paneId: string | null): void;
  /** The stream ended by itself (not by close()), with why when known. */
  ended(reason: string | null): void;
}

export interface EventSubscription {
  /** Ends the stream; the sink hears nothing more. */
  close(): void;
}

/** A pane-scoped subscription (the agent status, one per pane). */
export interface PaneSubscription {
  readonly type: string;
  readonly paneId: string;
}

/** The subscribe request line (HerdrKit's id "herdrkit:events.subscribe"); `panes` adds pane-scoped subscriptions. */
export function subscribeRequestLine(kinds: readonly string[], panes: readonly PaneSubscription[] = []): string {
  return requestLine("herdrkit:events.subscribe", paneMethods.subscribe.method, paneMethods.subscribe.params(kinds, panes));
}

/** `pane_agent_status_changed` → `pane.agent_status_changed` (SidebarRefresh.dotted); a dotted kind as is. */
export function dottedKind(kind: string): string {
  if (kind.includes(".")) return kind;
  const underscore = kind.indexOf("_");
  return underscore < 0 ? kind : `${kind.slice(0, underscore)}.${kind.slice(underscore + 1)}`;
}

export type StreamLine =
  | { readonly type: "started" }
  | { readonly type: "event"; readonly kind: string; readonly paneId: string | null }
  | { readonly type: "refused"; readonly message: string }
  | { readonly type: "other" };

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const text = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** One stream line, read as HerdrClient.classify does (and a refused subscribe as such). */
export function classifyStreamLine(line: string): StreamLine {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { type: "other" };
  }
  const object = record(parsed);
  if (object === null) return { type: "other" };
  if (record(object["result"])?.["type"] === "subscription_started") return { type: "started" };
  const error = record(object["error"]);
  if (error !== null && text(error["code"]) !== null) {
    return { type: "refused", message: `${text(error["code"])}: ${text(error["message"]) ?? ""}` };
  }
  const kind = text(object["event"]);
  if (kind !== null) {
    const data = record(object["data"]);
    const paneId = text(data?.["pane_id"]) ?? text(record(data?.["pane"])?.["pane_id"]);
    return { type: "event", kind: dottedKind(kind), paneId };
  }
  const nested = record(object["event"]);
  if (nested !== null) {
    return { type: "event", kind: dottedKind(text(nested["type"]) ?? text(nested["kind"]) ?? "unknown"), paneId: text(nested["pane_id"]) };
  }
  const type = text(object["type"]);
  if (type !== null) return { type: "event", kind: dottedKind(type), paneId: text(object["pane_id"]) };
  return { type: "other" };
}

/** Whole lines from a byte stream split anywhere; refuses a line past the reply bound. */
export class LineSplitter {
  private parts: Buffer[] = [];
  private bytes = 0;

  push(chunk: Uint8Array): string[] {
    const lines: string[] = [];
    let data = Buffer.from(chunk);
    for (let index = data.indexOf(0x0a); index >= 0; index = data.indexOf(0x0a)) {
      const line = Buffer.concat([...this.parts, data.subarray(0, index)]);
      this.parts = [];
      this.bytes = 0;
      if (line.length > maxResponseLineBytes) throw new ResponseTooLargeError(line.length, maxResponseLineBytes);
      lines.push(line.toString("utf8"));
      data = data.subarray(index + 1);
    }
    if (data.length > 0) {
      this.parts.push(data);
      this.bytes += data.length;
      if (this.bytes > maxResponseLineBytes) throw new ResponseTooLargeError(this.bytes, maxResponseLineBytes);
    }
    return lines;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Subscribes to `kinds` on one machine over SSH and hands each line to `sink`
 * until close(), or until the stream ends (sink.ended, once).
 */
export function openSshEventStream(
  config: SshHostConfig,
  policy: PinningHostKeyPolicy,
  kinds: readonly string[],
  sink: EventSink,
  connect: (config: SshHostConfig, policy: PinningHostKeyPolicy) => Promise<Client> = (c, p) => connectSsh(c, p),
  panes: readonly PaneSubscription[] = [],
): EventSubscription {
  let closed = false;
  let over = false;
  let client: Client | null = null;
  let channel: ClientChannel | null = null;
  let stderr = "";

  const end = (reason: string | null): void => {
    if (closed || over) return;
    over = true;
    channel?.close();
    channel = null;
    client?.end();
    client = null;
    sink.ended(reason);
  };

  const deliver = (line: string): void => {
    if (closed || over || line.trim() === "") return;
    const read = classifyStreamLine(line);
    if (read.type === "started") sink.started();
    else if (read.type === "event") sink.event(read.kind, read.paneId);
    else if (read.type === "refused") end(`Herdr refused the event stream (${read.message})`);
  };

  void (async () => {
    let opened: Client;
    try {
      opened = await connect(config, policy);
    } catch (error) {
      end(describe(error));
      return;
    }
    if (closed) {
      opened.end();
      return;
    }
    client = opened;
    opened.once("close", () => end("the connection closed"));
    opened.exec(heldSocketCommand(config.herdrSession), (error, opening) => {
      if (error) {
        end(`exec failed: ${error.message}`);
        return;
      }
      if (closed || over) {
        opening.close();
        return;
      }
      channel = opening;
      const splitter = new LineSplitter();
      // The request, and stdin left open: nc's stdin closing ends the subscription.
      opening.write(socketPayload(subscribeRequestLine(kinds, panes)));
      opening.on("data", (chunk: Buffer) => {
        let lines: string[];
        try {
          lines = splitter.push(chunk);
        } catch (failure) {
          end(describe(failure));
          return;
        }
        for (const line of lines) deliver(line);
      });
      opening.stderr.on("data", (chunk: Buffer) => {
        if (Buffer.byteLength(stderr) < maxDiagnosticBytes) stderr += Buffer.from(chunk).toString("utf8").slice(0, maxDiagnosticBytes);
      });
      opening.on("close", () => end(stderr.trim() === "" ? "the event stream closed" : classifySocketFailure(stderr, 1, sessionSocketPath(config.herdrSession)).message));
    });
  })();

  return {
    close(): void {
      if (closed) return;
      closed = true;
      channel?.close();
      channel = null;
      client?.end();
      client = null;
    },
  };
}

/**
 * The same subscription as a relay `stream` on the command connection (no SSH
 * connection of its own). `relay` gives the held relay (opening the connection when none is held), or
 * null when the connection has none: then `fallback` opens the stream over SSH, or, absent, the stream
 * ends at once with `relayOffReason` (the sidebar's, which never opens a connection of its own).
 */
export const relayOffReason = "the relay is off";

export function openRelayEventStream(
  relay: () => Promise<RelayClient | null>,
  line: string,
  sink: EventSink,
  fallback?: (sink: EventSink) => EventSubscription,
): EventSubscription {
  let closed = false;
  let over = false;
  let handle: RelayHandle | null = null;
  let instead: EventSubscription | null = null;
  const end = (reason: string | null): void => {
    if (closed || over) return;
    over = true;
    handle?.close();
    handle = null;
    sink.ended(reason);
  };
  const deliver = (text: string): void => {
    if (closed || over || text.trim() === "") return;
    const read = classifyStreamLine(text);
    if (read.type === "started") sink.started();
    else if (read.type === "event") sink.event(read.kind, read.paneId);
    else if (read.type === "refused") end(`Herdr refused the event stream (${read.message})`);
  };
  void (async () => {
    let held: RelayClient | null;
    try {
      held = await relay();
    } catch (error) {
      end(describe(error));
      return;
    }
    if (closed || over) return;
    if (held === null) {
      if (fallback === undefined) end(relayOffReason);
      else instead = fallback(sink);
      return;
    }
    handle = held.stream(line, { line: deliver, ended: (reason) => end(reason) });
  })();
  return {
    close(): void {
      if (closed) return;
      closed = true;
      handle?.close();
      handle = null;
      instead?.close();
      instead = null;
    },
  };
}

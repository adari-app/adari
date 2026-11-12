// The TS port of the iPhone app's FakeCore.swift: an in-process
// herdr-core for tests. It speaks framed mode exactly as herdr-core
// schema/README.md describes it ("Framed mode", "Attach streams", "Events",
// "Documents") and answers with the shapes hc.openrpc.json (v0.1.16,
// generation 1) gives each result. No socket, no process: bytes in, bytes
// out, on a CoreLink.

import { CoreFrameDecoder, CoreFrameKind, CoreFrames, coreFrame, creditAmount, encodeCoreFrame, resizeGrid, type CoreFrame } from "../../src/main/herdr/core-frames";
import {
  coreJSONBytes,
  coreJSONString,
  jsonArray,
  jsonBool,
  jsonInt,
  jsonObject,
  jsonString,
  member,
  tryParseCoreJSON,
  utf8Bytes,
  type CoreJSON,
} from "../../src/main/herdr/core-json";
import type { CoreLink } from "../../src/main/herdr/core-connection";
import { CoreQueue } from "../../src/main/herdr/core-queue";
import { CoreFixtures } from "./core-test-link";

type Mutable = Record<string, CoreJSON>;

export interface TerminalFixture {
  readonly argv?: readonly string[];
  readonly cwd?: string;
  readonly labels?: Readonly<Record<string, string>>;
  readonly state?: string;
  readonly status?: CoreJSON;
  readonly turn?: number | bigint;
  readonly title?: string;
  readonly foreground?: CoreJSON;
  readonly keep?: boolean;
  /** null: no pid (lost, waiting for its new shell). Default 4242. */
  readonly pid?: number | null;
  readonly name?: string;
  readonly cols?: number;
  readonly rows?: number;
}

export interface LayoutSpace {
  readonly id: string;
  readonly name: string;
  readonly folder: string;
  readonly tabs: readonly { readonly id: string; readonly name: string; readonly terminals: readonly string[] }[];
}

const encoder = new TextEncoder();
const defaultPaint = (): Uint8Array => encoder.encode("\u001b[2J\u001b[H$ \u001b[?9001l");

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class FakeCore {
  // MARK: - Fixtures

  /** One `Terminal` (hc.openrpc.json :1106-1325). */
  static terminal(address: string, fixture: TerminalFixture = {}): CoreJSON {
    const status = fixture.status;
    const out: Mutable = {
      address,
      argv: [...(fixture.argv ?? ["/bin/zsh", "-l"])],
      cwd: fixture.cwd ?? "/Users/me/code/app",
      labels: { ...fixture.labels },
      state: fixture.state ?? "live",
      created_ms: 1_761_000_000_000,
      screen: "exact",
      cols: fixture.cols ?? 120,
      rows: fixture.rows ?? 40,
      keep: fixture.keep ?? false,
      title: fixture.title ?? "",
      turn: fixture.turn ?? 0,
      reported: status !== undefined,
      records: status === undefined ? {} : { "7501": status },
    };
    if (status !== undefined) out["status"] = status;
    if (fixture.foreground !== undefined) out["foreground"] = fixture.foreground;
    const pid = fixture.pid === undefined ? 4242 : fixture.pid;
    if (pid !== null) out["pid"] = pid;
    if (fixture.name !== undefined) out["name"] = fixture.name;
    return out;
  }

  /** One OSC 7501 record (`Status`; `state` required). */
  static status(state: string, app: string | null = "claude", kind?: string): CoreJSON {
    const out: Mutable = { state };
    if (app !== null) out["app"] = app;
    if (kind !== undefined) out["kind"] = kind;
    return out;
  }

  /** What runs in it (`Foreground`; all four required). */
  static foreground(name: string, argv: readonly string[], cwd: string, pid = 5151): CoreJSON {
    return { pid, name, argv: [...argv], cwd };
  }

  /** A machine (`MachineView`). */
  static machine(name: string, state = "connected"): CoreJSON {
    return { name, target: `me@${name}`, id: `id-${name}`, host: `${name}.local`, version: "0.1.16", state };
  }

  /** Herdr App's `herdr-app` document (spaces with tabs whose layout `root` names terminals). */
  static layout(spaces: readonly LayoutSpace[]): CoreJSON {
    return {
      spaces: spaces.map((space) => ({
        id: space.id,
        name: space.name,
        folder: space.folder,
        tabs: space.tabs.map((tab) => {
          const leaves: CoreJSON[] = tab.terminals.map((terminal) => ({ terminal }));
          const root: CoreJSON = leaves.length === 1 ? (leaves[0] as CoreJSON) : { split: { direction: "horizontal", ratio: 0.5, children: leaves } };
          return { id: tab.id, name: tab.name, root };
        }),
      })),
    };
  }

  // MARK: - State (one core process)

  seq = 100;
  private order: string[] = [];
  private records = new Map<string, Mutable>();
  private documents = new Map<string, { value: CoreJSON; version: number }>();
  machines: CoreJSON[] = [];
  hello: CoreJSON = CoreFixtures.helloResult();
  private links: FakeCoreLink[] = [];
  private nextAddress = 50;
  /** Every request any link sent, in order (method, params). */
  readonly calls: { method: string; params: CoreJSON }[] = [];
  /** Bytes typed into each terminal through attach DATA. */
  readonly typed = new Map<string, number[]>();
  /** Text and keys sent with terminal.send / terminal.keys. */
  readonly sent: { terminal: string; text: string }[] = [];
  readonly keys: { terminal: string; keys: string[] }[] = [];
  /** RESIZE and FOCUS frames from viewers, per terminal. */
  readonly resizes: { terminal: string; cols: number; rows: number }[] = [];
  readonly focuses: { terminal: string; gained: boolean }[] = [];
  /** A method's answer the test sets (an error is `{"error": {...}}`). */
  readonly overrides = new Map<string, (params: CoreJSON) => CoreJSON>();
  /** Attach first paint per terminal. */
  readonly paint = new Map<string, Uint8Array>();

  constructor(terminals: readonly CoreJSON[] = []) {
    for (const terminal of terminals) this.add(terminal);
  }

  private add(terminal: CoreJSON): void {
    const address = jsonString(member(terminal, "address"));
    if (address === undefined) return;
    if (!this.records.has(address)) this.order.push(address);
    this.records.set(address, clone(terminal) as Mutable);
  }

  record(address: string): Mutable | undefined {
    const record = this.records.get(address);
    return record === undefined ? undefined : clone(record);
  }

  setDocument(name: string, value: CoreJSON, version = 1): void {
    this.documents.set(name, { value: clone(value), version });
  }

  document(name: string): { value: CoreJSON; version: number } | undefined {
    return this.documents.get(name);
  }

  typedText(address: string): string {
    return new TextDecoder().decode(Uint8Array.from(this.typed.get(address) ?? []));
  }

  methods(): string[] {
    return this.calls.map((call) => call.method);
  }

  /** A new connection (what `hc connect` would be). */
  makeLink(): FakeCoreLink {
    const link = new FakeCoreLink(this);
    this.links.push(link);
    return link;
  }

  get allLinks(): readonly FakeCoreLink[] {
    return this.links;
  }

  get liveLinks(): FakeCoreLink[] {
    return this.links.filter((link) => !link.isClosed);
  }

  /** Ends every connection (the SSH channel went). */
  dropConnections(): void {
    for (const link of this.liveLinks) link.endFromCore();
  }

  // MARK: - Events

  /** Emits one event to every subscriber and applies it here. */
  event(type: string, terminal: string | undefined, data: CoreJSON, machine?: string): void {
    this.seq += 1;
    const params: Mutable = { seq: this.seq, type, data };
    if (terminal !== undefined) params["terminal"] = terminal;
    if (machine !== undefined) params["machine"] = machine;
    if (terminal !== undefined) this.apply(type, terminal, data);
    const line: CoreJSON = { jsonrpc: "2.0", method: "event", params };
    for (const link of this.links) link.pushEvent(line);
  }

  private apply(type: string, address: string, data: CoreJSON): void {
    switch (type) {
      case "created":
      case "restarted":
        this.add(data);
        return;
      case "removed":
        this.records.delete(address);
        this.order = this.order.filter((item) => item !== address);
        return;
      case "foreground": {
        // README: `{pid, name, argv, cwd}` or null, "set `foreground`".
        const record = this.records.get(address);
        if (record === undefined) return;
        if (data === null) delete record["foreground"];
        else record["foreground"] = clone(data);
        return;
      }
      default: {
        const record = this.records.get(address);
        const fields = jsonObject(data);
        if (record === undefined || fields === undefined) return;
        switch (type) {
          case "status":
            record["status"] = fields["status"] ?? null;
            record["records"] = fields["records"] ?? {};
            record["reported"] = fields["reported"] ?? false;
            break;
          case "turn":
            if (fields["turn"] !== undefined) record["turn"] = fields["turn"];
            break;
          case "finished":
            record["state"] = "finished";
            for (const [key, value] of Object.entries(fields)) record[key] = clone(value);
            delete record["foreground"];
            break;
          case "lost":
            for (const [key, value] of Object.entries(fields)) record[key] = clone(value);
            delete record["pid"];
            delete record["foreground"];
            break;
          default:
            for (const [key, value] of Object.entries(fields)) record[key] = clone(value);
        }
      }
    }
  }

  /** `status` with the root status, every record, reported. */
  setStatus(address: string, status: CoreJSON | null): void {
    this.event("status", address, { status, records: status === null ? {} : { "7501": status }, reported: true });
  }

  /** A turn ended (`turn` event: `{turn, state}`). */
  endTurn(address: string, turn: number | bigint, state = "done"): void {
    this.event("turn", address, { turn, state });
  }

  setForeground(address: string, foreground: CoreJSON | null): void {
    this.event("foreground", address, foreground);
  }

  create(terminal: CoreJSON): void {
    this.event("created", jsonString(member(terminal, "address")), terminal);
  }

  /** The program ended: status cleared just before, then `finished`, then every attach stream gets CLOSE with the reason. */
  finish(address: string, exitCode = 0, reason = "exited"): void {
    this.setStatus(address, null);
    this.event("finished", address, { reason, exit_code: exitCode, signal: null, finished_ms: 1_761_000_100_000 });
    for (const link of this.liveLinks) link.closeAttaches(address, { reason, exit_code: exitCode, signal: null });
  }

  /** A kept terminal lost its program (`lost`; attach streams close with its reason). */
  lose(address: string): void {
    this.event("lost", address, { reason: "signaled", exit_code: null, signal: 9, finished_ms: null });
    for (const link of this.liveLinks) link.closeAttaches(address, { reason: "signaled", exit_code: null, signal: 9 });
  }

  /** Its new shell (`restarted`: the whole record). */
  restart(address: string): void {
    const record = this.record(address);
    if (record === undefined) return;
    record["pid"] = 4343;
    delete record["reason"];
    delete record["signal"];
    delete record["finished_ms"];
    delete record["foreground"];
    this.event("restarted", address, record);
  }

  /** A seq that never reaches subscribers (they see a gap next). */
  skipEvent(): void {
    this.seq += 1;
  }

  heartbeat(): void {
    const line: CoreJSON = { jsonrpc: "2.0", method: "heartbeat", params: { seq: this.seq } };
    for (const link of this.links) link.pushEvent(line);
  }

  /** `missed` with a fresh snapshot (a subscriber fell behind). */
  missed(): void {
    const line: CoreJSON = { jsonrpc: "2.0", method: "missed", params: { seq: this.seq, terminals: this.snapshot() } };
    for (const link of this.links) link.pushEvent(line);
  }

  private snapshot(): CoreJSON[] {
    return this.order.flatMap((address) => {
      const record = this.records.get(address);
      return record === undefined ? [] : [clone(record)];
    });
  }

  /** Program output on every attach stream of `address`. */
  output(address: string, bytes: Uint8Array | string): void {
    const data = typeof bytes === "string" ? utf8Bytes(bytes) : bytes;
    for (const link of this.liveLinks) link.output(address, data);
  }

  /** A doc changed (`doc` event: `{name, version}`, `machine` when remote). */
  setDocumentAndNotify(name: string, value: CoreJSON): void {
    const version = (this.documents.get(name)?.version ?? 0) + 1;
    this.documents.set(name, { value: clone(value), version });
    this.event("doc", undefined, { name, version });
  }

  // MARK: - Answers (channel 0)

  static rpcError(message: string, kind: string, hint = ""): CoreJSON {
    return { error: { code: -32000, message, data: { kind, hint } } };
  }

  /** The schema's `IdleOrWorking`. */
  static readonly idleOrWorking = new Set(["idle", "working"]);

  /** A param outside its schema (`invalid_params`, code -32602). */
  static invalidParams(message: string): CoreJSON {
    return { error: { code: -32602, message, data: { kind: "invalid_params" } } };
  }

  /** The result (or `{"error"}`) for one call. */
  answer(method: string, params: CoreJSON, link: FakeCoreLink): CoreJSON {
    this.calls.push({ method, params: clone(params) });
    const override = this.overrides.get(method);
    if (override !== undefined) return override(params);
    const p = (key: string): CoreJSON | undefined => member(params, key);
    const address = jsonString(p("terminal")) ?? "";
    switch (method) {
      case "events.subscribe": {
        const snapshot: Mutable = { seq: this.seq, terminals: this.snapshot() };
        snapshot["channel"] = link.openSubscription();
        return { result: snapshot };
      }
      case "doc.get": {
        const name = jsonString(p("name")) ?? "";
        const on = jsonString(p("on"));
        const doc = this.document(on === undefined ? name : `${on}:${name}`);
        return { result: { value: doc === undefined ? null : clone(doc.value), version: doc?.version ?? 0 } };
      }
      case "doc.set": {
        const name = jsonString(p("name")) ?? "";
        const on = jsonString(p("on"));
        const key = on === undefined ? name : `${on}:${name}`;
        const current = this.document(key)?.version ?? 0;
        if (jsonInt(p("version")) !== current) return FakeCore.rpcError(`version ${current} is newer`, "conflict", "read it again");
        this.setDocumentAndNotify(key, p("value") ?? null);
        return { result: { version: current + 1 } };
      }
      case "machine.list":
        return { result: { machines: clone(this.machines) } };
      case "terminal.attach": {
        const record = this.records.get(address);
        if (record === undefined) return FakeCore.rpcError(`no terminal ${address}`, "not_found");
        if (record["state"] === "finished") return FakeCore.rpcError(`${address} has finished`, "finished");
        if (record["pid"] === undefined || record["pid"] === null) return FakeCore.rpcError("lost, waiting for its new shell", "unavailable");
        const channel = link.openAttach(address);
        return { result: { channel, terminal: clone(record), resize_notifications: false } };
      }
      case "terminal.get": {
        const record = this.records.get(address);
        if (record === undefined) return FakeCore.rpcError(`no terminal ${address}`, "not_found");
        return { result: clone(record) };
      }
      case "terminal.send": {
        // `if` is `IdleOrWorking` (idle | working) or null; anything else is invalid_params.
        const condition = p("if");
        if (condition !== undefined && condition !== null && !(typeof condition === "string" && FakeCore.idleOrWorking.has(condition))) {
          return FakeCore.invalidParams(`if: expected idle or working, got ${coreJSONString(condition)}`);
        }
        const record = this.records.get(address);
        if (record === undefined) return FakeCore.rpcError(`no terminal ${address}`, "not_found");
        if (record["state"] === "finished") return FakeCore.rpcError(`${address} has finished`, "finished");
        // herdr-core input.rs `send`, checked when it types: a blocked program unless `force`, then `if`.
        const word = jsonString(member(record["status"], "state"));
        if (word === "blocked" && jsonBool(p("force")) !== true) {
          return FakeCore.rpcError(`${address} is blocked`, "blocked", "typing would answer its dialog");
        }
        const want = jsonString(p("if"));
        if (want !== undefined && word !== want) {
          return FakeCore.rpcError(`${address} is ${word ?? "silent"}, not ${want}`, "status_mismatch", "nothing was typed");
        }
        this.sent.push({ terminal: address, text: jsonString(p("text")) ?? "" });
        return { result: { turn: record["turn"] ?? 0, started: true } };
      }
      case "terminal.keys": {
        const record = this.records.get(address);
        if (record === undefined) return FakeCore.rpcError(`no terminal ${address}`, "not_found");
        if (record["state"] === "finished") return FakeCore.rpcError(`${address} has finished`, "finished");
        const list = (jsonArray(p("keys")) ?? []).flatMap((key) => (typeof key === "string" ? [key] : []));
        this.keys.push({ terminal: address, keys: list });
        return { result: { turn: record["turn"] ?? 0 } };
      }
      case "terminal.interrupt":
        if (!this.records.has(address)) return FakeCore.rpcError(`no terminal ${address}`, "not_found");
        return { result: { outcome: "stopped", key: "esc" } };
      case "terminal.read":
        if (!this.records.has(address)) return FakeCore.rpcError(`no terminal ${address}`, "not_found");
        return { result: { text: "$ ls\nREADME.md\n$ ", complete: true, how: "screen" } };
      case "terminal.run": {
        this.nextAddress += 1;
        const fresh = `t${this.nextAddress}`;
        const labels: Record<string, string> = {};
        for (const [key, value] of Object.entries(jsonObject(p("labels")) ?? {})) if (typeof value === "string") labels[key] = value;
        const argv = (jsonArray(p("argv")) ?? []).flatMap((item) => (typeof item === "string" ? [item] : []));
        const name = jsonString(p("name"));
        const record = FakeCore.terminal(fresh, {
          argv: argv.length === 0 ? ["/bin/zsh", "-l"] : argv,
          cwd: jsonString(p("cwd")) ?? "/Users/me",
          labels,
          keep: jsonBool(p("keep")) ?? false,
          ...(name === undefined ? {} : { name }),
        });
        this.create(record);
        return { result: record };
      }
      case "terminal.kill":
        if (!this.records.has(address)) return FakeCore.rpcError(`no terminal ${address}`, "not_found");
        this.finish(address, 0, "killed");
        return { result: this.record(address) ?? null };
      case "terminal.rm": {
        const record = this.records.get(address);
        if (record === undefined) return FakeCore.rpcError(`no terminal ${address}`, "not_found");
        if (record["state"] !== "finished") return FakeCore.rpcError(`${address} is live`, "live");
        this.event("removed", address, {});
        return { result: { removed: address } };
      }
      case "terminal.label": {
        const record = this.records.get(address);
        if (record === undefined) return FakeCore.rpcError(`no terminal ${address}`, "not_found");
        const labels: Mutable = { ...jsonObject(record["labels"]) };
        for (const [key, value] of Object.entries(jsonObject(p("labels")) ?? {})) {
          if (typeof value !== "string" || value === "") delete labels[key];
          else labels[key] = value;
        }
        record["labels"] = labels;
        this.event("labels", address, { labels: clone(labels) });
        return { result: this.record(address) ?? null };
      }
      default:
        return FakeCore.rpcError(`unknown method ${method}`, "unknown_method");
    }
  }

  noteTyped(address: string, bytes: Uint8Array): void {
    const list = this.typed.get(address) ?? [];
    for (const byte of bytes) list.push(byte);
    this.typed.set(address, list);
  }

  noteResize(address: string, cols: number, rows: number): void {
    this.resizes.push({ terminal: address, cols, rows });
    this.event("size", address, { cols, rows });
  }

  noteFocus(address: string, gained: boolean): void {
    this.focuses.push({ terminal: address, gained });
  }
}

interface FakeStream {
  /** null: the event subscription. */
  readonly terminal: string | null;
  credit: number;
  queued: number[];
  /** The program ended: CLOSE (this reason) once the queued DATA is out. */
  closing: Uint8Array | null;
}

/** One connection to the fake core. */
export class FakeCoreLink implements CoreLink {
  /** README "Flow control": "A viewer that falls more than 4 MiB behind gets a fresh repaint instead of the backlog." */
  static readonly repaintBehind = 4 << 20;

  readonly inbound = new CoreQueue<Uint8Array>();
  private buffer: number[] = [];
  private saidHello = false;
  private decoder = new CoreFrameDecoder();
  private closed = false;
  private nextChannel = 1;
  private readonly streams = new Map<number, FakeStream>();
  /** Credit the viewer gave, per channel (CREDIT frames). */
  readonly credits = new Map<number, number>();
  /** DATA bytes sent, per channel. */
  readonly sentBytes = new Map<number, number>();
  /** Fresh repaints sent instead of a backlog, per channel. */
  readonly repaints = new Map<number, number>();
  /** Channels the viewer closed (CLOSE frames). */
  readonly viewerClosed: number[] = [];
  /** The app's hello, as it came (plain line, before framing). */
  helloRequest: CoreJSON | undefined;
  /** When false, the fake does not answer calls (a core gone silent). */
  answering = true;

  constructor(private readonly core: FakeCore) {}

  get isClosed(): boolean {
    return this.closed;
  }

  channelOf(terminal: string): number | undefined {
    for (const [channel, stream] of this.streams) if (stream.terminal === terminal) return channel;
    return undefined;
  }

  get subscriptionChannels(): number[] {
    return [...this.streams].filter(([, stream]) => stream.terminal === null).map(([channel]) => channel);
  }

  send(bytes: Uint8Array): boolean {
    if (this.closed) return false;
    if (!this.saidHello) {
      for (const byte of bytes) this.buffer.push(byte);
      const newline = this.buffer.indexOf(10);
      if (newline < 0) return true;
      const line = Uint8Array.from(this.buffer.slice(0, newline));
      const rest = Uint8Array.from(this.buffer.slice(newline + 1));
      this.buffer = [];
      this.saidHello = true;
      const request = tryParseCoreJSON(line) ?? null;
      this.helloRequest = request;
      // The reply to hello is a plain line; framing starts after it.
      this.yieldBytes(utf8Bytes(`${coreJSONString({ jsonrpc: "2.0", id: member(request, "id") ?? 0, result: this.core.hello })}\n`));
      if (rest.length > 0) this.send(rest);
      return true;
    }
    let frames: CoreFrame[];
    try {
      frames = this.decoder.push(bytes);
    } catch {
      this.endFromCore();
      return false;
    }
    for (const frame of frames) this.handle(frame);
    return true;
  }

  private yieldBytes(bytes: Uint8Array): void {
    if (!this.closed) this.inbound.push(bytes);
  }

  private handle(frame: CoreFrame): void {
    switch (frame.kind) {
      case CoreFrameKind.data: {
        if (frame.channel === 0) {
          this.call(tryParseCoreJSON(frame.payload) ?? null);
          return;
        }
        const terminal = this.streams.get(frame.channel)?.terminal;
        if (terminal !== undefined && terminal !== null) this.core.noteTyped(terminal, frame.payload);
        return;
      }
      case CoreFrameKind.credit: {
        const amount = creditAmount(frame) ?? 0;
        this.credits.set(frame.channel, (this.credits.get(frame.channel) ?? 0) + amount);
        const stream = this.streams.get(frame.channel);
        if (stream !== undefined) {
          stream.credit += amount;
          const flush = stream.queued.splice(0, Math.max(0, Math.min(stream.credit, stream.queued.length)));
          stream.credit -= flush.length;
          if (flush.length > 0) {
            this.sentBytes.set(frame.channel, (this.sentBytes.get(frame.channel) ?? 0) + flush.length);
            this.yieldBytes(encodeCoreFrame(CoreFrames.data(frame.channel, Uint8Array.from(flush))));
          }
          if (stream.queued.length === 0 && stream.closing !== null) {
            this.yieldBytes(encodeCoreFrame(coreFrame(frame.channel, CoreFrameKind.close, stream.closing)));
            this.streams.delete(frame.channel);
          }
        }
        return;
      }
      case CoreFrameKind.close:
        this.viewerClosed.push(frame.channel);
        if (this.streams.delete(frame.channel)) {
          // "A viewer detaches by sending CLOSE; the core answers with an empty CLOSE."
          this.yieldBytes(encodeCoreFrame(coreFrame(frame.channel, CoreFrameKind.close)));
        }
        return;
      case CoreFrameKind.resize: {
        const terminal = this.streams.get(frame.channel)?.terminal;
        const grid = resizeGrid(frame);
        if (terminal !== undefined && terminal !== null && grid !== null) this.core.noteResize(terminal, grid.cols, grid.rows);
        return;
      }
      case CoreFrameKind.focus: {
        const terminal = this.streams.get(frame.channel)?.terminal;
        if (terminal !== undefined && terminal !== null) this.core.noteFocus(terminal, frame.payload[0] === 1);
        return;
      }
      default:
        return;
    }
  }

  private call(request: CoreJSON): void {
    const method = jsonString(member(request, "method"));
    if (!this.answering || method === undefined) return;
    const answer = this.core.answer(method, member(request, "params") ?? {}, this);
    const reply: Mutable = { jsonrpc: "2.0", id: member(request, "id") ?? null };
    const error = member(answer, "error");
    if (error !== undefined) reply["error"] = error;
    else reply["result"] = member(answer, "result") ?? null;
    if (this.closed) return;
    this.yieldBytes(encodeCoreFrame(CoreFrames.data(0, coreJSONBytes(reply))));
    // The attach reply precedes the stream's frames (README): its first paint now.
    const channel = jsonInt(member(member(answer, "result"), "channel"));
    const terminal = jsonString(member(member(request, "params"), "terminal"));
    if (method === "terminal.attach" && typeof channel === "number" && terminal !== undefined) {
      this.write(channel, this.core.paint.get(terminal) ?? defaultPaint());
    }
  }

  openSubscription(): number {
    const channel = this.nextChannel;
    this.nextChannel += 1;
    // Every stream starts with 256 KiB of credit (README "Flow control").
    this.streams.set(channel, { terminal: null, credit: 256 * 1024, queued: [], closing: null });
    return channel;
  }

  openAttach(terminal: string): number {
    const channel = this.nextChannel;
    this.nextChannel += 1;
    this.streams.set(channel, { terminal, credit: 256 * 1024, queued: [], closing: null });
    return channel;
  }

  /** One JSON line on every event subscription of this link. */
  pushEvent(line: CoreJSON): void {
    if (this.closed) return;
    const bytes = utf8Bytes(`${coreJSONString(line)}\n`);
    for (const [channel, stream] of this.streams) if (stream.terminal === null) this.write(channel, bytes);
  }

  output(terminal: string, bytes: Uint8Array): void {
    if (this.closed) return;
    for (const [channel, stream] of this.streams) if (stream.terminal === terminal) this.write(channel, bytes);
  }

  /** DATA within the channel's credit; the rest waits for CREDIT. A viewer more than 4 MiB behind gets a fresh repaint. */
  private write(channel: number, bytes: Uint8Array): void {
    const stream = this.streams.get(channel);
    if (stream === undefined || stream.closing !== null) return;
    for (const byte of bytes) stream.queued.push(byte);
    if (stream.terminal !== null && stream.queued.length > FakeCoreLink.repaintBehind) {
      stream.queued = [0x18, ...(this.core.paint.get(stream.terminal) ?? encoder.encode("\u001b[2J\u001b[H$ "))];
      this.repaints.set(channel, (this.repaints.get(channel) ?? 0) + 1);
    }
    const now = stream.queued.splice(0, Math.max(0, Math.min(stream.credit, stream.queued.length)));
    stream.credit -= now.length;
    if (now.length > 0) {
      this.sentBytes.set(channel, (this.sentBytes.get(channel) ?? 0) + now.length);
      this.yieldBytes(encodeCoreFrame(CoreFrames.data(channel, Uint8Array.from(now))));
    }
  }

  /** Bytes waiting for credit on a channel. */
  queued(channel: number): number {
    return this.streams.get(channel)?.queued.length ?? 0;
  }

  /** CLOSE with a JSON reason on every attach stream of `terminal`. */
  closeAttaches(terminal: string, reason: CoreJSON): void {
    if (this.closed) return;
    for (const [channel, stream] of this.streams) {
      if (stream.terminal !== terminal) continue;
      // CLOSE follows the stream's DATA, which still waits for credit.
      if (stream.queued.length > 0) {
        stream.closing = coreJSONBytes(reason);
        continue;
      }
      this.yieldBytes(encodeCoreFrame(coreFrame(channel, CoreFrameKind.close, coreJSONBytes(reason))));
      this.streams.delete(channel);
    }
  }

  /** The core closes a subscription channel (CLOSE with a reason). */
  closeSubscriptions(reason = "server_stop"): void {
    for (const [channel, stream] of this.streams) {
      if (stream.terminal !== null) continue;
      this.yieldBytes(encodeCoreFrame(coreFrame(channel, CoreFrameKind.close, coreJSONBytes({ reason }))));
      this.streams.delete(channel);
    }
  }

  /** The line ends from the core's side. */
  endFromCore(): void {
    if (this.closed) return;
    this.closed = true;
    this.inbound.finish();
  }

  close(): void {
    this.endFromCore();
  }
}

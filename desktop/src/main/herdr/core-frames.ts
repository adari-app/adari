// herdr-core's two connection modes (the Swift client's
// CoreFrames.swift; herdr-core schema/README.md "Connecting", "Framed mode"):
//
// - plain: JSON-RPC 2.0, one message per line;
// - framed, after `hello {"framed": true}` answers: every frame is
//   `[channel u32 LE][kind u8][len u32 LE][payload]`, the payload at most
//   16 MiB. Channel 0 carries JSON-RPC both ways; every other channel is one
//   stream (an attach, or the event subscription).
//
// Pure: bytes in, frames or lines out. The connection (core-connection.ts)
// owns the I/O.

/** A frame's kind byte (the README's table). */
export const CoreFrameKind = {
  /** Channel 0: one JSON-RPC message; other channels: stream bytes. */
  data: 0,
  /** u32 LE: bytes the receiver consumed. */
  credit: 1,
  /** The channel is over; from the core, a JSON reason. */
  close: 2,
  /** u16 LE cols, u16 LE rows. */
  resize: 3,
  /** Viewer to core: 1 gained focus, 0 lost it. */
  focus: 4,
  /** Viewer to core: JSON display facts (`Display` in the schema). */
  facts: 5,
} as const;
export type CoreFrameKind = (typeof CoreFrameKind)[keyof typeof CoreFrameKind];

export const coreFrameHeaderSize = 9;
/** "payload at most 16 MiB". */
export const coreFrameMaximumPayload = 16 * 1024 * 1024;

const empty = new Uint8Array(0);

export interface CoreFrame {
  readonly channel: number;
  readonly kind: CoreFrameKind;
  readonly payload: Uint8Array;
}

export function coreFrame(channel: number, kind: CoreFrameKind, payload: Uint8Array = empty): CoreFrame {
  return { channel, kind, payload };
}

/** The frame's bytes: header, then payload. */
export function encodeCoreFrame(frame: CoreFrame): Uint8Array {
  const out = new Uint8Array(coreFrameHeaderSize + frame.payload.length);
  writeLE32(out, 0, frame.channel);
  out[4] = frame.kind;
  writeLE32(out, 5, frame.payload.length);
  out.set(frame.payload, coreFrameHeaderSize);
  return out;
}

export const CoreFrames = {
  data: (channel: number, bytes: Uint8Array): CoreFrame => coreFrame(channel, CoreFrameKind.data, bytes),
  /** CREDIT: the bytes this side consumed on `channel`. */
  credit: (channel: number, bytes: number): CoreFrame => {
    const payload = new Uint8Array(4);
    writeLE32(payload, 0, bytes);
    return coreFrame(channel, CoreFrameKind.credit, payload);
  },
  /** RESIZE: u16 LE cols, u16 LE rows. */
  resize: (channel: number, cols: number, rows: number): CoreFrame =>
    coreFrame(channel, CoreFrameKind.resize, Uint8Array.of(cols & 0xff, (cols >>> 8) & 0xff, rows & 0xff, (rows >>> 8) & 0xff)),
  /** FOCUS: one byte, 1 gained, 0 lost. */
  focus: (channel: number, focused: boolean): CoreFrame => coreFrame(channel, CoreFrameKind.focus, Uint8Array.of(focused ? 1 : 0)),
  /** A viewer's CLOSE carries nothing. */
  close: (channel: number): CoreFrame => coreFrame(channel, CoreFrameKind.close),
};

/** The CREDIT amount, when this is a well-formed CREDIT. */
export function creditAmount(frame: CoreFrame): number | null {
  return frame.kind === CoreFrameKind.credit && frame.payload.length === 4 ? readLE32(frame.payload, 0) : null;
}

/** The RESIZE grid, when this is a well-formed RESIZE. */
export function resizeGrid(frame: CoreFrame): { readonly cols: number; readonly rows: number } | null {
  if (frame.kind !== CoreFrameKind.resize || frame.payload.length !== 4) return null;
  const p = frame.payload;
  return { cols: (p[0] as number) | ((p[1] as number) << 8), rows: (p[2] as number) | ((p[3] as number) << 8) };
}

export function writeLE32(out: Uint8Array, offset: number, value: number): void {
  out[offset] = value & 0xff;
  out[offset + 1] = (value >>> 8) & 0xff;
  out[offset + 2] = (value >>> 16) & 0xff;
  out[offset + 3] = (value >>> 24) & 0xff;
}

export function readLE32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] as number) |
      ((bytes[offset + 1] as number) << 8) |
      ((bytes[offset + 2] as number) << 16) |
      ((bytes[offset + 3] as number) << 24)) >>>
    0
  );
}

export type CoreFrameFault =
  | { readonly kind: "oversize"; readonly channel: number; readonly length: number }
  | { readonly kind: "unknownKind"; readonly byte: number };

/** A frame refused: the stream is not herdr-core's (or is corrupt), and nothing after it can be trusted. */
export class CoreFrameError extends Error {
  constructor(readonly fault: CoreFrameFault) {
    super(
      fault.kind === "oversize"
        ? `herdr-core sent a ${fault.length}-byte frame on channel ${fault.channel}; the limit is 16 MiB`
        : `herdr-core sent a frame of unknown kind ${fault.byte}`,
    );
    this.name = "CoreFrameError";
  }
}

const kinds = new Set<number>(Object.values(CoreFrameKind));

/** A growable byte buffer with a read position (no quadratic copies for a big frame read in small chunks). */
class ByteBuffer {
  private buffer = new Uint8Array(0);
  start = 0;
  end = 0;

  get bytes(): Uint8Array {
    return this.buffer;
  }

  get count(): number {
    return this.end - this.start;
  }

  append(bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    if (this.end + bytes.length > this.buffer.length) {
      const live = this.end - this.start;
      if (live + bytes.length <= this.buffer.length) {
        this.buffer.copyWithin(0, this.start, this.end);
      } else {
        const next = new Uint8Array(Math.max(this.buffer.length * 2, live + bytes.length, 4096));
        next.set(this.buffer.subarray(this.start, this.end));
        this.buffer = next;
      }
      this.start = 0;
      this.end = live;
    }
    this.buffer.set(bytes, this.end);
    this.end += bytes.length;
  }

  consume(count: number): void {
    this.start += count;
    if (this.start === this.end) {
      this.start = 0;
      this.end = 0;
    }
  }

  take(): Uint8Array {
    const out = this.buffer.slice(this.start, this.end);
    this.start = 0;
    this.end = 0;
    return out;
  }
}

/** Frames from a byte stream that splits them anywhere: a frame across several reads, several in one read. */
export class CoreFrameDecoder {
  private readonly buffer = new ByteBuffer();
  /** Set once a frame is refused; the decoder then refuses everything. */
  failure: CoreFrameError | null = null;

  /** Appends bytes and returns every whole frame now available, in order. Throws (and stays failed) on an oversize length or an unknown kind. */
  push(bytes: Uint8Array): CoreFrame[] {
    if (this.failure !== null) throw this.failure;
    this.buffer.append(bytes);
    const frames: CoreFrame[] = [];
    while (this.buffer.count >= coreFrameHeaderSize) {
      const data = this.buffer.bytes;
      const at = this.buffer.start;
      const channel = readLE32(data, at);
      const kindByte = data[at + 4] as number;
      const length = readLE32(data, at + 5);
      if (length > coreFrameMaximumPayload) {
        this.failure = new CoreFrameError({ kind: "oversize", channel, length });
        throw this.failure;
      }
      if (!kinds.has(kindByte)) {
        this.failure = new CoreFrameError({ kind: "unknownKind", byte: kindByte });
        throw this.failure;
      }
      const total = coreFrameHeaderSize + length;
      if (this.buffer.count < total) break;
      const payloadStart = at + coreFrameHeaderSize;
      frames.push(coreFrame(channel, kindByte as CoreFrameKind, data.slice(payloadStart, payloadStart + length)));
      this.buffer.consume(total);
    }
    return frames;
  }

  /** Bytes held for a frame not yet complete. */
  get pendingByteCount(): number {
    return this.buffer.count;
  }
}

export class CoreLineOversizeError extends Error {
  constructor(readonly bytes: number) {
    super(`a line of ${bytes} bytes is over the limit`);
    this.name = "CoreLineOversizeError";
  }
}

/** Lines from a byte stream (plain mode, and the event channel's JSON lines), split anywhere. A line longer than `maximumLine` is refused. */
export class CoreLineSplitter {
  static readonly defaultMaximumLine = 16 * 1024 * 1024;
  private readonly pending = new ByteBuffer();

  constructor(private readonly maximumLine = CoreLineSplitter.defaultMaximumLine) {}

  /** Whole lines now available, without their `\n` (a `\r` before it is dropped). */
  push(bytes: Uint8Array): Uint8Array[] {
    const lines: Uint8Array[] = [];
    let from = 0;
    for (;;) {
      const newline = bytes.indexOf(10, from);
      if (newline < 0) break;
      const piece = bytes.subarray(from, newline);
      if (this.pending.count + piece.length > this.maximumLine) throw new CoreLineOversizeError(this.pending.count + piece.length);
      this.pending.append(piece);
      let line = this.pending.take();
      if (line.length > 0 && line[line.length - 1] === 13) line = line.subarray(0, line.length - 1);
      lines.push(line);
      from = newline + 1;
    }
    const rest = bytes.subarray(from);
    if (this.pending.count + rest.length > this.maximumLine) throw new CoreLineOversizeError(this.pending.count + rest.length);
    this.pending.append(rest);
    return lines;
  }

  /** The bytes after the last newline, taken out. */
  takeRemainder(): Uint8Array {
    return this.pending.take();
  }
}

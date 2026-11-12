// Recorded Herdr attach streams (the repo's HRDRFX01 fixtures), after the
// Swift app's CompanionReplayRecording (App/CompanionReplayFixture.swift):
// "HRDRFX01", u16 LE cols, u16 LE rows, then chunks of u64 LE microseconds,
// u32 LE length, bytes. The demo host plays them into a pane's terminal; the
// engine test feeds them to Ghostty and reads the screens back.

export interface ReplayChunk {
  /** Seconds from the start of the recording. */
  readonly time: number;
  readonly bytes: Uint8Array;
}

export interface ReplayRecording {
  readonly cols: number;
  readonly rows: number;
  readonly chunks: readonly ReplayChunk[];
}

const magic = "HRDRFX01";

export class ReplayFormatError extends Error {
  constructor(readonly reason: "not-a-recording" | "truncated") {
    super(reason === "not-a-recording" ? "not a HRDRFX01 recording" : "the recording is truncated");
    this.name = "ReplayFormatError";
  }
}

function integer(bytes: Uint8Array, offset: number, width: number): number {
  let value = 0;
  for (let index = width - 1; index >= 0; index -= 1) value = value * 256 + (bytes[offset + index] ?? 0);
  return value;
}

export function parseReplay(bytes: Uint8Array): ReplayRecording {
  if (bytes.length < 12) throw new ReplayFormatError("not-a-recording");
  for (let i = 0; i < magic.length; i += 1) {
    if (bytes[i] !== magic.charCodeAt(i)) throw new ReplayFormatError("not-a-recording");
  }
  const cols = integer(bytes, 8, 2);
  const rows = integer(bytes, 10, 2);
  const chunks: ReplayChunk[] = [];
  let offset = 12;
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) throw new ReplayFormatError("truncated");
    const time = integer(bytes, offset, 8) / 1_000_000;
    const length = integer(bytes, offset + 8, 4);
    offset += 12;
    if (offset + length > bytes.length) throw new ReplayFormatError("truncated");
    chunks.push({ time, bytes: bytes.subarray(offset, offset + length) });
    offset += length;
  }
  return { cols, rows, chunks };
}

export function replayDuration(recording: ReplayRecording): number {
  return recording.chunks[recording.chunks.length - 1]?.time ?? 0;
}

/** The chunk numbers (1-based) after which a screen is read: every tenth, as the Swift test reads them. */
export function checkpointMarks(total: number, count = 10): number[] {
  const marks = new Set<number>();
  const n = Math.max(1, count);
  for (let i = 1; i <= n; i += 1) marks.add(Math.max(1, Math.floor((total * i) / n)));
  return [...marks].sort((a, b) => a - b);
}

/** Exactly `rows` lines with trailing spaces trimmed (the Swift test's `lines`). */
export function screenLines(text: string, rows: number): string[] {
  const lines = text.split("\n").map((line) => line.replace(/ +$/, ""));
  while (lines.length < rows) lines.push("");
  return lines.slice(0, rows);
}

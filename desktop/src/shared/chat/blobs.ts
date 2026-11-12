// Relay contract v1.2 (docs/relay.md "Contract addendum v1.2", client rules 1-7) on
// the client side. With `"omit":1024` the relay leaves runs of 1,024 or more base64 bytes out of a transcript
// read and lists them as `omitted` (absolute file ranges). This module:
// - rebuilds a reply into the file's own bytes (rule 2): the kept bytes where they were, each run left out
//   filled with `A` (`blobFill`), so every offset (lines, the follower, `historyStart`, the carried reader, the
//   chips' tap) stays a file offset and nothing else changes; the fill is never decoded or shown;
// - builds a line's text with `￼blob:<offset>:<length>` where each run was (rule 3);
// - says which placeholders a parse may keep (an image's payload, a field nothing shows) and which must be
//   put back first (a field shown as text: rule 6), or when the whole line is read again (rule 3);
// - finds an image's parts from its ranges, never by reading digits (rule 4), for a fetch on show (rule 5).
// T3 Code keeps image data out of its message stream the same way and fetches it by reference
// (`omitToolOutputImageData`, packages/shared/src/toolOutput.ts:296; the `tool-output-image` asset,
// packages/contracts/src/assets.ts:42).

import { payloadScan } from "./line-scan";
import type { ChatImageBlob } from "./model";

/** A run the relay left out: its file offset and length. */
export type BlobRange = readonly [offset: number, length: number];

/** Transcript reads and watches send this (client rule 1). */
export const omitBytes = 1_024;
/** The most one relay `read` frame covers (docs/relay.md: `max` is capped at 4 MiB). */
export const relayFrameBytes = 4 * 1_024 * 1_024;
/** What a left-out run's bytes are in a rebuilt read: `A`, a base64 letter (never decoded or shown). */
export const blobFill = 0x41;
const markHead = "￼blob:";

/** Rule 3: the placeholder where a run was: U+FFFC, then `blob:<file offset>:<length>` in ASCII. */
export function blobMark(range: BlobRange): string {
  return `${markHead}${range[0]}:${range[1]}`;
}

/** Whether `text` holds a placeholder. */
export const holdsBlobMark = (text: string): boolean => text.includes(markHead);

/** The most file bytes one relay `grew` covers (docs/relay.md: 256 KB a frame). */
export const relayGrowthBytes = 256 * 1_024;

/**
 * Rule 2: a v1.2 reply (kept bytes from `offset`, the runs left out) as the file's bytes it covered, each run
 * filled with `blobFill`; null when the ranges do not fit (not ascending from `offset`, empty, or past the
 * kept bytes). Also null, before anything is allocated, when the bytes
 * covered (kept plus left out) are more than `maxCovered` (the read's maximum, at most a relay frame's 4 MiB;
 * a `grew`'s 256 KB) or their end is past the safe whole numbers. Each length is checked before it is added (the
 * covered sum never passes the cap, a run's end never passes 2^53 - 1), so no sum can lose precision.
 */
export function rebuildOmitted(offset: number, kept: Uint8Array, omitted: readonly BlobRange[], maxCovered: number = relayFrameBytes): Uint8Array | null {
  const limit = Math.min(maxCovered, relayFrameBytes);
  if (!Number.isSafeInteger(offset) || offset < 0 || !(kept.length <= limit)) return null;
  let covered = kept.length;
  let at = offset;
  let keptLeft = kept.length;
  for (const [start, length] of omitted) {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < at || length <= 0) return null;
    const before = start - at;
    if (before > keptLeft) return null;
    keptLeft -= before;
    if (length > limit - covered || length > Number.MAX_SAFE_INTEGER - start) return null;
    covered += length;
    at = start + length;
  }
  if (offset > Number.MAX_SAFE_INTEGER - covered) return null;
  if (omitted.length === 0) return kept;
  const out = new Uint8Array(covered);
  let from = 0;
  at = offset;
  for (const [start, length] of omitted) {
    const take = start - at;
    out.set(kept.subarray(from, from + take), at - offset);
    out.fill(blobFill, start - offset, start - offset + length);
    from += take;
    at = start + length;
  }
  out.set(kept.subarray(from), at - offset);
  return out;
}

/** The parts of `ranges` inside [from, to) (a run cut there is cut the same way: rule 4's touching ranges). */
export function clipBlobs(ranges: readonly BlobRange[], from: number, to: number): BlobRange[] {
  const out: BlobRange[] = [];
  for (const [start, length] of ranges) {
    const low = Math.max(start, from);
    const high = Math.min(start + length, to);
    if (high > low) out.push([low, high - low]);
  }
  return out;
}

const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

/**
 * A line's text with a placeholder where each of `ranges` (inside it, ascending) was: `bytes` are the line's
 * (its line break not included) from file offset `at`. A trailing CR is dropped and a blank line is null, as
 * for any line. Run edges are ASCII, so no character is cut.
 */
export function blobLineText(bytes: Uint8Array, at: number, ranges: readonly BlobRange[]): string | null {
  const end = bytes.length > 0 && bytes[bytes.length - 1] === 0x0d ? bytes.length - 1 : bytes.length;
  let text = "";
  let from = 0;
  for (const range of ranges) {
    const start = range[0] - at;
    text += decoder.decode(bytes.subarray(from, start)) + blobMark(range);
    from = start + range[1];
  }
  text += decoder.decode(bytes.subarray(from, Math.max(from, end)));
  return /^\s*$/u.test(text) ? null : text;
}

/** Fields no parser reads (a thinking block's signature, Codex's encrypted reasoning): a placeholder there stays. */
const unreadKeys: ReadonlySet<string> = new Set(["signature", "encrypted_content"]);

/** Where each of `ranges` has its placeholder in `text` (found from the range, rule 4), or -1. */
function markPositions(text: string, ranges: readonly BlobRange[]): number[] {
  const positions: number[] = [];
  let from = 0;
  for (const range of ranges) {
    const at = text.indexOf(blobMark(range), from);
    positions.push(at);
    if (at >= 0) from = at + blobMark(range).length;
  }
  return positions;
}

/**
 * Rules 3 and 6: what a line's placeholders stand for, from the JSON around them. Each placeholder in an image's
 * payload (an image block's base64 source, an image read's `toolUseResult.file.base64`, a data URL's base64,
 * Grok's `{"type":"image","mimeType":…,"data":…}`: line-scan's rule) or in a field nothing reads stays; one in any other string (a field shown as text, a hex dump
 * in a tool's output, a long token) is to be put back first (`restore`); one outside any string (a number of over
 * 1,024 digits), or a line the scan cannot read, makes the whole line read again (`whole`).
 */
export function blobsToRestore(text: string, ranges: readonly BlobRange[]): { readonly restore: BlobRange[]; readonly whole: boolean } {
  const scanned = payloadScan(text);
  if (scanned === null) return { restore: [], whole: true };
  const positions = markPositions(text, ranges);
  const restore: BlobRange[] = [];
  let string = 0;
  let payload = 0;
  for (const [index, range] of ranges.entries()) {
    const at = positions[index]!;
    if (at < 0) return { restore: [], whole: true };
    const end = at + blobMark(range).length;
    while (payload < scanned.payloads.length && scanned.payloads[payload]![1] < end) payload += 1;
    const inPayload = payload < scanned.payloads.length && scanned.payloads[payload]![0] <= at && end <= scanned.payloads[payload]![1];
    if (inPayload) continue;
    while (string < scanned.strings.length && scanned.strings[string]![1] < end) string += 1;
    const holder = scanned.strings[string];
    if (holder === undefined || holder[0] > at) return { restore: [], whole: true };
    if (holder[2] !== null && unreadKeys.has(holder[2])) continue;
    restore.push(range);
  }
  return { restore, whole: false };
}

/** What stands in a field shown as text for a run that could not be fetched (rule 6's elided marker). */
export const elidedBlob = (range: BlobRange): string => `[${range[1].toLocaleString("en-US")} bytes of data not shown]`;

/**
 * `text` with each of `ranges` put back: the run's bytes (ASCII base64) in place of its placeholder, or the
 * elided marker when they are not there (`bytes` null). Placeholders are found from their ranges (rule 4).
 */
export function restoreBlobs(text: string, ranges: readonly BlobRange[], bytes: (range: BlobRange) => Uint8Array | null): string {
  const positions = markPositions(text, ranges);
  let out = "";
  let from = 0;
  for (const [index, range] of ranges.entries()) {
    const at = positions[index]!;
    if (at < 0) continue;
    const got = bytes(range);
    out += text.slice(from, at) + (got === null ? elidedBlob(range) : decoder.decode(got));
    from = at + blobMark(range).length;
  }
  return out + text.slice(from);
}

/** One part of an image's base64: kept text, or a range of the transcript to fetch. */
export type ChatBlobPart = string | BlobRange;

/**
 * Rule 4: the parts of a string value that holds placeholders (an image's base64): kept base64 between them,
 * and each range, its placeholder found from the range (kept base64 right after one may begin with a digit);
 * null when it holds none of `ranges`.
 */
export function blobParts(value: string, ranges: readonly BlobRange[]): ChatBlobPart[] | null {
  if (!holdsBlobMark(value)) return null;
  const parts: ChatBlobPart[] = [];
  let from = 0;
  let found = false;
  for (const range of ranges) {
    const mark = blobMark(range);
    const at = value.indexOf(mark, from);
    if (at < 0) continue;
    if (at > from) parts.push(value.slice(from, at));
    parts.push([range[0], range[1]]);
    from = at + mark.length;
    found = true;
  }
  if (!found) return null;
  if (from < value.length) parts.push(value.slice(from));
  // A placeholder of no range of this line (not ours): not an image this client can fetch.
  return parts.some((part) => typeof part === "string" && holdsBlobMark(part)) ? null : parts;
}

/** What a line read with runs left out tells the parser: the transcript, its inode and the runs still left out. */
export interface ChatLineBlobs {
  readonly path: string;
  readonly ino: number | null;
  readonly ranges: readonly BlobRange[];
}

/** The bytes of a read of `length` file bytes that came over the link: the runs in `omitted` did not. */
export function keptLength(length: number, omitted: readonly BlobRange[] | undefined): number {
  return omitted === undefined ? length : omitted.reduce((left, range) => left - range[1], length);
}

/** What a relay read with identity gives, as `fetchRange` needs it. */
export interface RangeReading {
  readWithIdentity(path: string, offset: number, maxBytes: number): Promise<{ readonly size: number; readonly ino: number; readonly data: Uint8Array } | null>;
}

/**
 * Rule 5: a range's bytes by plain relay `read`s (no `omit`), one frame per 4 MiB, written at once (one trip);
 * null when any reply's `ino` is not `ino` (the file was replaced; `ino` null: the replies' own must agree),
 * one comes back short or fails, or the relay is not up.
 */
export async function fetchRange(reader: RangeReading, path: string, range: BlobRange, ino: number | null): Promise<Uint8Array | null> {
  const [offset, length] = range;
  const asks: [number, number][] = [];
  for (let at = 0; at < length; at += relayFrameBytes) asks.push([offset + at, Math.min(relayFrameBytes, length - at)]);
  let replies: Awaited<ReturnType<RangeReading["readWithIdentity"]>>[];
  try {
    replies = await Promise.all(asks.map(([at, max]) => reader.readWithIdentity(path, at, max)));
  } catch {
    return null;
  }
  const parts: Uint8Array[] = [];
  let known = ino;
  for (const [index, reply] of replies.entries()) {
    if (reply === null || (known !== null && reply.ino !== known) || reply.data.length !== asks[index]![1]) return null;
    known = reply.ino;
    parts.push(reply.data);
  }
  if (parts.length === 1) return parts[0]!;
  const out = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/**
 * Rule 5: an image's base64, its kept parts and each range fetched (all at once: one trip); null when a range
 * cannot be fetched (rule 5's checks) or a fetched byte is not base64 (the file changed under the range).
 */
export async function fetchImageBase64(reader: RangeReading, blob: ChatImageBlob): Promise<string | null> {
  const fetched = await Promise.all(blob.parts.map((part) => (typeof part === "string" ? Promise.resolve(null) : fetchRange(reader, blob.path, part, blob.ino))));
  let out = "";
  for (const [index, part] of blob.parts.entries()) {
    if (typeof part === "string") {
      out += part;
      continue;
    }
    const bytes = fetched[index];
    if (bytes === null || bytes === undefined || !isBase64Run(bytes)) return null;
    out += decoder.decode(bytes);
  }
  return out;
}

/** Every byte is in a run's alphabet (`[A-Za-z0-9+/=]`). */
export function isBase64Run(bytes: Uint8Array): boolean {
  for (const byte of bytes) {
    const letter = (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a) || (byte >= 0x30 && byte <= 0x39);
    if (!letter && byte !== 0x2b && byte !== 0x2f && byte !== 0x3d) return false;
  }
  return true;
}

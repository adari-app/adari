// A long transcript line read by a scan, not a parse.
// The user's screenshots make lines of 0.5 to 1.3 MB (a user line with the
// image's base64; the agent's image read, with the image twice: in its tool
// result and in `toolUseResult.file.base64`), and Claude Code 2.1.316 writes an
// `api-request-blob` line of about 1 MB each time they send while the agent
// works. Of all that the timeline needs an image's media type and the line's
// other fields, never the image's bytes.
//
// One pass over the line (each string skipped to its closing quote with
// `indexOf`, never decoded) finds its top-level `type` and its image payloads
// of `minimumPayloadLength` or more, with no escape or space in them. A
// payload is cut only inside an image's structure, as the object
// it is in (and the one around that) says when it closes, whatever order its
// keys come in:
// - an image block's base64 source, `{"type":"image","source":{"type":"base64",
//   "data":…}}` (their screenshot, an image in a tool's result);
// - an image read's metadata, `toolUseResult.file.base64` with the file's type
//   `image/…` or the result's type `image`;
// - an image block's data URL, the `image_url` or `url` of a
//   `{"type":"input_image"}` or `{"type":"image"}` block (Codex): its base64
//   only, its `data:<type>;base64,` head stays, as the Codex parser reads it.
// Their text, the agent's and a tool's (a data URL in them too) are never cut.
// The parser then skips a type it shows nothing of with no parse at all, and
// parses any other line with its payloads cut. A port of HerdrKit's
// TranscriptLineScan.swift (which counts UTF-8 bytes; here UTF-16 code units,
// the same for these lines).

/** Lines shorter than this are parsed as they are. */
export const minimumLineLength = 64 * 1_024;
/** A shorter string is never a payload. */
export const minimumPayloadLength = 1_024;

export interface LineScan {
  /** The top-level `type`, when it is a string with no escape in it. */
  readonly type: string | null;
  /** The line with its payloads cut; null when it has none. */
  readonly slimmed: string | null;
  /** Payloads cut. */
  readonly cuts: number;
}

const QUOTE = 0x22;
const BACKSLASH = 0x5c;

function isSpace(code: number): boolean {
  return code === 0x20 || code === 0x0a || code === 0x0d || code === 0x09;
}

/** Where the string whose body starts at `start` ends (its closing quote: one after an even run of backslashes), or -1. */
function stringEnd(line: string, start: number): number {
  let at = start;
  for (;;) {
    const end = line.indexOf('"', at);
    if (end < 0) return -1;
    let slashes = 0;
    for (let before = end - 1; before >= start && line.charCodeAt(before) === BACKSLASH; before -= 1) slashes += 1;
    if (slashes % 2 === 0) return end;
    at = end + 1;
  }
}

/**
 * What a payload is to be cut as, before the objects around it say it is an image's: the `data`
 * of an object that is to be an image block's `source`, the `base64` of one that is to be
 * `toolUseResult.file`, a data URL's base64 under `image_url` or `url` in one that is to be an
 * image block.
 */
type Candidate = "sourceData" | "fileBase64" | "imageURL";

/** A `{` or `[` still open. */
interface Container {
  readonly isObject: boolean;
  /** The key it is the value of, in the object around it. */
  readonly key: string | null;
  /** Its `type`, when it is a string with no escape in it. */
  type: string | null;
  /** Its `mimeType`, the same way (Grok's image block). */
  mimeType: string | null;
  /** Payloads read in it, cut if it says it is what each needs. */
  candidates: [number, number, Candidate][];
  /** Payloads in the objects in it, cut if its type is `image`. */
  cutIfImage: [number, number][];
}

/**
 * The part of the string [start, end) to cut and what it must be in, when it is a payload; null otherwise. A payload has no escape and no space.
 * `keepsMarks`, the parser's scan: a payload that holds a relay placeholder (U+FFFC, relay v1.2) is not cut, so its
 * image is still found by reference (a placeholder is a few bytes).
 */
function payload(line: string, start: number, end: number, key: string, keepsMarks: boolean): [number, number, Candidate] | null {
  const body = line.slice(start, end);
  if (body.includes("\\")) return null;
  if (keepsMarks && body.includes("\uFFFC")) return null;
  let cut: [number, number] = [start, end];
  let kind: Candidate;
  if (key === "data") {
    kind = "sourceData";
  } else if (key === "base64") {
    kind = "fileBase64";
  } else if (key === "image_url" || key === "url") {
    if (!body.startsWith("data:")) return null;
    const comma = body.slice(0, 128).indexOf(",");
    if (comma < 0 || !body.slice(0, comma).endsWith(";base64")) return null;
    cut = [start + comma + 1, end];
    kind = "imageURL";
  } else {
    return null;
  }
  if (line.slice(cut[0], cut[1]).includes(" ")) return null;
  return [cut[0], cut[1], kind];
}

/**
 * A container just closed: what it says of the payloads read in it (cut, handed to the object around it, or kept).
 * `dataImages` (the relay placeholders' scan only): Grok's image block, `{"type":"image",
 * "mimeType":…,"data":…}`, its `data` an image's payload too.
 */
function settle(container: Container, open: Container[], cuts: [number, number][], dataImages: boolean): void {
  if (!container.isObject) return;
  if (container.type === "image") cuts.push(...container.cutIfImage);
  for (const [start, end, kind] of container.candidates) {
    if (kind === "sourceData") {
      // An image block's `source`, once the block says `image`.
      const around = open[open.length - 1];
      if (container.type === "base64" && container.key === "source" && around?.isObject === true) around.cutIfImage.push([start, end]);
      else if (dataImages && container.type === "image" && container.mimeType !== null) cuts.push([start, end]);
    } else if (kind === "fileBase64") {
      // `toolUseResult.file`, the top level's.
      const result = open[1];
      if (container.key !== "file" || open.length !== 2 || result?.key !== "toolUseResult") continue;
      if (container.type?.startsWith("image/") === true) cuts.push([start, end]);
      else result.cutIfImage.push([start, end]);
    } else if (container.type === "input_image" || container.type === "image") {
      cuts.push([start, end]);
    }
  }
}

/**
 * The line's top-level type and its payloads cut; null when the line is not
 * one JSON object as far as a scan can tell (a bracket that does not pair, a
 * string left open, anything after the object): the parser reads it as it is.
 */
export function scanLine(line: string): LineScan | null {
  const scanned = scan(line, minimumPayloadLength, true, null, false);
  if (scanned === null) return null;
  const { type, cuts } = scanned;
  if (cuts.length === 0) return { type, slimmed: null, cuts: 0 };
  cuts.sort((a, b) => a[0] - b[0]);
  const parts: string[] = [];
  let from = 0;
  for (const [start, end] of cuts) {
    parts.push(line.slice(from, start));
    from = end;
  }
  parts.push(line.slice(from));
  return { type, slimmed: parts.join(""), cuts: cuts.length };
}

/** One string value of a line: [start, end) of its body, and the key it is the value of (null: in an array, or none). */
export type ScannedString = readonly [start: number, end: number, key: string | null];

/**
 * Relay v1.2, client rule 6 (docs/relay.md): a line's image payloads as the scan finds them, of any length
 * ([start, end) of the string), and every string value with its key, in order; null when the line is not one
 * JSON object as far as a scan can tell. What a relay placeholder stands for is read from these.
 */
export function payloadScan(line: string): { readonly payloads: readonly (readonly [number, number])[]; readonly strings: readonly ScannedString[] } | null {
  const strings: [number, number, string | null][] = [];
  const scanned = scan(line, 1, false, strings, true);
  if (scanned === null) return null;
  return { payloads: scanned.cuts.sort((a, b) => a[0] - b[0]), strings };
}

/**
 * The scan: the top-level type and the payloads of `minimum` or more to cut (unsorted), every string value into `strings` when given;
 * `dataImages`, Grok's image block's `data` a payload too (settle).
 */
function scan(
  line: string,
  minimum: number,
  keepsMarks: boolean,
  strings: [number, number, string | null][] | null,
  dataImages: boolean,
): { type: string | null; cuts: [number, number][] } | null {
  const count = line.length;
  let index = 0;
  while (index < count && isSpace(line.charCodeAt(index))) index += 1;
  if (index >= count || line.charCodeAt(index) !== 0x7b) return null;
  const open: Container[] = [];
  let expectsKey = false;
  let key: string | null = null;
  let type: string | null = null;
  const cuts: [number, number][] = [];
  let closed = false;
  while (index < count) {
    const code = line.charCodeAt(index);
    if (code === 0x7b || code === 0x5b) {
      open.push({ isObject: code === 0x7b, key, type: null, mimeType: null, candidates: [], cutIfImage: [] });
      expectsKey = code === 0x7b;
      key = null;
      index += 1;
    } else if (code === 0x7d || code === 0x5d) {
      const container = open.pop();
      if (container === undefined || container.isObject !== (code === 0x7d)) return null;
      index += 1;
      key = null;
      expectsKey = false;
      settle(container, open, cuts, dataImages);
      if (open.length === 0) {
        closed = true;
        break;
      }
    } else if (code === 0x2c) {
      expectsKey = open[open.length - 1]?.isObject === true;
      key = null;
      index += 1;
    } else if (code === 0x3a) {
      expectsKey = false;
      index += 1;
    } else if (code === QUOTE) {
      const start = index + 1;
      const end = stringEnd(line, start);
      if (end < 0) return null;
      if (expectsKey) {
        // A key is short: it is read as text.
        key = end - start <= 64 ? line.slice(start, end) : "";
        expectsKey = false;
      } else {
        const container = open[open.length - 1];
        if (key === "type" && container !== undefined && container.type === null) {
          const value = line.slice(start, end);
          if (!value.includes("\\")) {
            container.type = value;
            if (open.length === 1) type = value;
          }
        }
        if (key === "mimeType" && container !== undefined && container.mimeType === null && end - start <= 128) container.mimeType = line.slice(start, end);
        if (end - start >= minimum && key !== null && container !== undefined) {
          const candidate = payload(line, start, end, key, keepsMarks);
          if (candidate !== null) container.candidates.push(candidate);
        }
        strings?.push([start, end, key]);
        key = null;
      }
      index = end + 1;
    } else {
      // Whitespace, a number, true, false or null.
      index += 1;
    }
  }
  if (!closed) return null;
  for (; index < count; index += 1) if (!isSpace(line.charCodeAt(index))) return null;
  return { type, cuts };
}

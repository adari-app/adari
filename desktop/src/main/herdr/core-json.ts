// herdr-core's JSON (the Swift client's CoreJSON.swift). Params and results
// are open JSON, so the port carries them as plain parsed values and reads
// the typed records (core-wire.ts) out of them. Integers stay exact:
// parseJsonLine (decode.ts) gives an integer beyond
// 2^53 as the exact bigint, and coreJSONString writes a bigint back as its
// digits, so a u64 seq or turn round-trips without rounding.

import { parseJsonLine } from "./decode";
import { exactInteger, int64Max, int64Min, uint64Max, type WideInt } from "../../shared/wide-int";

export type CoreJSON = null | boolean | number | bigint | string | readonly CoreJSON[] | { readonly [key: string]: CoreJSON };
export type CoreObject = { readonly [key: string]: CoreJSON };

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** Text from UTF-8 bytes (invalid sequences become U+FFFD, as Swift's String(decoding:as:)). */
export function utf8Text(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

export function utf8Bytes(text: string): Uint8Array {
  return encoder.encode(text);
}

/** One JSON value from text or bytes; throws when it is not JSON. */
export function parseCoreJSON(input: string | Uint8Array): CoreJSON {
  return parseJsonLine(typeof input === "string" ? input : utf8Text(input)) as CoreJSON;
}

/** One JSON value, or null when the bytes are not JSON. */
export function tryParseCoreJSON(input: string | Uint8Array): CoreJSON | undefined {
  try {
    return parseCoreJSON(input);
  } catch {
    return undefined;
  }
}

/**
 * One line of JSON (no newline), keys sorted so the same value is the same bytes (Swift's .sortedKeys).
 * A bigint is written as its digits; an undefined member is left out.
 */
export function coreJSONString(value: unknown): string {
  const out: string[] = [];
  write(value, out);
  return out.join("");
}

export function coreJSONBytes(value: unknown): Uint8Array {
  return utf8Bytes(coreJSONString(value));
}

function write(value: unknown, out: string[]): void {
  if (value === null || value === undefined) {
    out.push("null");
  } else if (typeof value === "boolean") {
    out.push(value ? "true" : "false");
  } else if (typeof value === "number") {
    out.push(Number.isFinite(value) ? JSON.stringify(value) : "null");
  } else if (typeof value === "bigint") {
    out.push(value.toString());
  } else if (typeof value === "string") {
    out.push(JSON.stringify(value));
  } else if (Array.isArray(value)) {
    out.push("[");
    value.forEach((item: unknown, index) => {
      if (index > 0) out.push(",");
      write(item, out);
    });
    out.push("]");
  } else if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    out.push("{");
    let first = true;
    for (const key of Object.keys(record).sort()) {
      const member = record[key];
      if (member === undefined) continue;
      if (!first) out.push(",");
      first = false;
      out.push(JSON.stringify(key), ":");
      write(member, out);
    }
    out.push("}");
  } else {
    out.push("null");
  }
}

// MARK: - Reading (CoreJSON's subscript and accessors)

export function jsonObject(value: CoreJSON | undefined): CoreObject | undefined {
  return value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value) ? (value as CoreObject) : undefined;
}

export function jsonArray(value: CoreJSON | undefined): readonly CoreJSON[] | undefined {
  return Array.isArray(value) ? (value as readonly CoreJSON[]) : undefined;
}

/** `value[key]` when value is an object. */
export function member(value: CoreJSON | undefined, key: string): CoreJSON | undefined {
  const object = jsonObject(value);
  return object !== undefined && Object.hasOwn(object, key) ? object[key] : undefined;
}

export function jsonString(value: CoreJSON | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function jsonBool(value: CoreJSON | undefined): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/** A signed 64-bit integer, exact (Swift `.int`). */
export function jsonInt(value: CoreJSON | undefined): WideInt | undefined {
  return exactInteger(value, int64Min, int64Max);
}

/** An unsigned 64-bit integer, exact (Swift `.uint64`). */
export function jsonU64(value: CoreJSON | undefined): WideInt | undefined {
  return exactInteger(value, 0n, uint64Max);
}

/** A small integer within [min, max] as a number. */
export function jsonSmallInt(value: CoreJSON | undefined, min: number, max: number): number | undefined {
  const exact = exactInteger(value, BigInt(min), BigInt(max));
  return typeof exact === "number" ? exact : undefined;
}

export function isJsonNull(value: CoreJSON | undefined): boolean {
  return value === null;
}

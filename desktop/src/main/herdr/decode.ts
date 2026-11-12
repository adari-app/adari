// A small strict decoder, with the semantics of Swift's Decodable as HerdrKit
// uses it: a required key that is missing, null or of the wrong type throws; an
// optional key (decodeIfPresent) that is missing or null reads as undefined,
// and one of the wrong type throws; unknown keys are ignored.
//
// Integers are checked against the width of the Swift field: Int and Int64
// (64-bit signed), UInt32, UInt64; and kept exact:
// parseJsonLine reads an integer literal beyond 2^53 as a bigint, and the
// integer readers return a WideInt (a number when safe, else a bigint).

import { exactInteger, int64Max, int64Min, uint32Max, uint64Max, type WideInt } from "../../shared/wide-int";

export class DecodingError extends Error {
  constructor(
    readonly path: string,
    readonly detail: string,
  ) {
    super(`${path}: ${detail}`);
    this.name = "DecodingError";
  }
}

export type JsonObject = Readonly<Record<string, unknown>>;

export function asObject(value: unknown, path: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DecodingError(path, "expected an object");
  }
  return value as JsonObject;
}

function present(o: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, key) && o[key] !== null && o[key] !== undefined;
}

/** The value read as T, or undefined when it is not one. */
type Read<T> = (value: unknown) => T | undefined;

const asString: Read<string> = (v) => (typeof v === "string" ? v : undefined);
const asBool: Read<boolean> = (v) => (typeof v === "boolean" ? v : undefined);
/** Swift Int (64-bit on every platform HerdrKit runs on) and Int64. */
const asInt64: Read<WideInt> = (v) => exactInteger(v, int64Min, int64Max);
const asUInt64: Read<WideInt> = (v) => exactInteger(v, 0n, uint64Max);
/** Always a number: a UInt32 is a safe integer. */
const asUInt32: Read<number> = (v) => exactInteger(v, 0n, uint32Max) as number | undefined;
/** Swift Double: any finite number (a wide integer literal read as a bigint becomes its nearest double). */
const asNumber: Read<number> = (v) =>
  typeof v === "number" && Number.isFinite(v) ? v : typeof v === "bigint" ? Number(v) : undefined;

const int64Kind = "64-bit integer (Int)";
const uint64Kind = "unsigned 64-bit integer (UInt64)";
const uint32Kind = "unsigned 32-bit integer (UInt32)";

function required<T>(o: JsonObject, key: string, path: string, read: Read<T>, kind: string): T {
  if (!present(o, key)) throw new DecodingError(`${path}.${key}`, `missing ${kind}`);
  const value = read(o[key]);
  if (value === undefined) throw new DecodingError(`${path}.${key}`, `expected ${kind}`);
  return value;
}

function optional<T>(o: JsonObject, key: string, path: string, read: Read<T>, kind: string): T | undefined {
  if (!present(o, key)) return undefined;
  const value = read(o[key]);
  if (value === undefined) throw new DecodingError(`${path}.${key}`, `expected ${kind}`);
  return value;
}

export const req = {
  string: (o: JsonObject, key: string, path: string) => required(o, key, path, asString, "string"),
  bool: (o: JsonObject, key: string, path: string) => required(o, key, path, asBool, "bool"),
  /** Swift Int / Int64. */
  int64: (o: JsonObject, key: string, path: string) => required(o, key, path, asInt64, int64Kind),
  uint64: (o: JsonObject, key: string, path: string) => required(o, key, path, asUInt64, uint64Kind),
  uint32: (o: JsonObject, key: string, path: string) => required(o, key, path, asUInt32, uint32Kind),
  object: (o: JsonObject, key: string, path: string): JsonObject => {
    if (!present(o, key)) throw new DecodingError(`${path}.${key}`, "missing object");
    return asObject(o[key], `${path}.${key}`);
  },
  array: <T>(o: JsonObject, key: string, path: string, item: (value: unknown, path: string) => T): T[] => {
    if (!present(o, key)) throw new DecodingError(`${path}.${key}`, "missing array");
    const value = o[key];
    if (!Array.isArray(value)) throw new DecodingError(`${path}.${key}`, "expected array");
    return value.map((entry, index) => item(entry, `${path}.${key}[${index}]`));
  },
};

export const opt = {
  string: (o: JsonObject, key: string, path: string) => optional(o, key, path, asString, "string"),
  bool: (o: JsonObject, key: string, path: string) => optional(o, key, path, asBool, "bool"),
  /** Swift Int? / Int64?. */
  int64: (o: JsonObject, key: string, path: string) => optional(o, key, path, asInt64, int64Kind),
  uint64: (o: JsonObject, key: string, path: string) => optional(o, key, path, asUInt64, uint64Kind),
  uint32: (o: JsonObject, key: string, path: string) => optional(o, key, path, asUInt32, uint32Kind),
  number: (o: JsonObject, key: string, path: string) => optional(o, key, path, asNumber, "number"),
  object: <T>(o: JsonObject, key: string, path: string, decode: (value: JsonObject, path: string) => T): T | undefined =>
    present(o, key) ? decode(asObject(o[key], `${path}.${key}`), `${path}.${key}`) : undefined,
  array: <T>(o: JsonObject, key: string, path: string, item: (value: unknown, path: string) => T): T[] | undefined => {
    if (!present(o, key)) return undefined;
    const value = o[key];
    if (!Array.isArray(value)) throw new DecodingError(`${path}.${key}`, "expected array");
    return value.map((entry, index) => item(entry, `${path}.${key}[${index}]`));
  },
};

/**
 * JSON.parse's reviver with the literal's source text (ES2025 JSON.parse
 * source text access): an integer literal beyond 2^53 becomes the exact bigint.
 * Where a runtime gives no source, the rounded number stays, and the integer
 * readers refuse it rather than take it as exact.
 */
function exactIntegers(_key: string, value: unknown, context?: { readonly source?: string }): unknown {
  if (typeof value !== "number" || Number.isSafeInteger(value) || context?.source === undefined) return value;
  return /^-?(0|[1-9]\d*)$/.test(context.source) ? BigInt(context.source) : value;
}

/** Parses one JSON line; integers beyond 2^53 come back as exact bigints. */
export function parseJsonLine(line: string, path = "$"): unknown {
  try {
    return JSON.parse(line, exactIntegers) as unknown;
  } catch (error) {
    throw new DecodingError(path, `not JSON (${error instanceof Error ? error.message : String(error)})`);
  }
}

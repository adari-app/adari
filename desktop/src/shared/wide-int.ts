// Integers from the wire, exact. HerdrKit decodes
// them into 64-bit Swift types (Int, Int64, UInt64), which hold values a JS
// number cannot: past 2^53 a number rounds, so two counters one apart compare
// equal. A WideInt is a number while it is a safe integer and a bigint beyond,
// never both for one value, so ===, <, > and sorting work across the two forms
// (JS compares a number with a bigint exactly). Arithmetic needs one form:
// use the helpers here rather than mixing.

export type WideInt = number | bigint;

export const int64Min = -(2n ** 63n);
export const int64Max = 2n ** 63n - 1n;
export const uint32Max = 2n ** 32n - 1n;
export const uint64Max = 2n ** 64n - 1n;

const safeMin = BigInt(Number.MIN_SAFE_INTEGER);
const safeMax = BigInt(Number.MAX_SAFE_INTEGER);

/** The one form of an exact integer: a number when safe, else the bigint. */
export function wideInt(value: bigint): WideInt {
  return value >= safeMin && value <= safeMax ? Number(value) : value;
}

/** An exact comparison for sorting (ascending). */
export function compareWide(a: WideInt, b: WideInt): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * An integer in [min, max], in its one form; undefined for anything else: not
 * a number or bigint, a fraction, out of range, or a number beyond 2^53 (it
 * may have been rounded on the way, so it is never taken as exact).
 */
export function exactInteger(value: unknown, min: bigint, max: bigint): WideInt | undefined {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= min && value <= max ? value + 0 : undefined;
  }
  if (typeof value === "bigint") return value >= min && value <= max ? wideInt(value) : undefined;
  return undefined;
}

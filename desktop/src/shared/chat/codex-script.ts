// Finds the tool calls in a Codex 0.166 `exec` script ("code mode"), such as
// `text(await tools.exec_command({cmd:"cat /path"}));`. Not a JavaScript
// parser: it skips strings and comments, finds `tools.<name>(` in order, and
// reads the first argument when it is a literal (strings in all three quotes
// with escapes, objects, arrays, numbers, `+` joined strings). Template `${…}`
// parts are kept as written. Never fails; an argument it cannot read is null.
// A port of HerdrKit's CodexScript.swift.

/** A literal value read from a Codex "code mode" script, or from JSON. */
export type ScriptValue =
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "bool"; readonly value: boolean }
  | { readonly kind: "null" }
  | { readonly kind: "array"; readonly values: readonly ScriptValue[] }
  | { readonly kind: "object"; readonly fields: ReadonlyMap<string, ScriptValue> }
  /** A name the scanner cannot evaluate (a variable, a call). */
  | { readonly kind: "identifier"; readonly name: string };

export const Script = {
  string: (value: string): ScriptValue => ({ kind: "string", value }),
  number: (value: number): ScriptValue => ({ kind: "number", value }),
  bool: (value: boolean): ScriptValue => ({ kind: "bool", value }),
  null: (): ScriptValue => ({ kind: "null" }),
  array: (values: readonly ScriptValue[]): ScriptValue => ({ kind: "array", values }),
  object: (fields: Iterable<readonly [string, ScriptValue]>): ScriptValue => ({ kind: "object", fields: new Map(fields) }),
  identifier: (name: string): ScriptValue => ({ kind: "identifier", name }),
};

/** `value[key]`: a field of an object, else null. */
export function scriptField(value: ScriptValue | null | undefined, key: string): ScriptValue | null {
  return value?.kind === "object" ? (value.fields.get(key) ?? null) : null;
}

export function scriptString(value: ScriptValue | null | undefined): string | null {
  return value?.kind === "string" ? value.value : null;
}

export function scriptArray(value: ScriptValue | null | undefined): readonly ScriptValue[] | null {
  return value?.kind === "array" ? value.values : null;
}

const sortedKeys = (fields: ReadonlyMap<string, ScriptValue>): string[] => [...fields.keys()].sort();

/** The first non-empty string under any of `keys`, searching depth first. */
export function firstString(value: ScriptValue | null | undefined, keys: readonly string[]): string | null {
  if (value?.kind === "object") {
    for (const key of keys) {
      const found = scriptString(value.fields.get(key));
      if (found !== null && found.length > 0) return found;
    }
    for (const key of sortedKeys(value.fields)) {
      const found = firstString(value.fields.get(key), keys);
      if (found !== null) return found;
    }
    return null;
  }
  if (value?.kind === "array") {
    for (const item of value.values) {
      const found = firstString(item, keys);
      if (found !== null) return found;
    }
  }
  return null;
}

/** Any first non-empty string value, depth first (keys in sorted order). */
export function anyString(value: ScriptValue | null | undefined): string | null {
  switch (value?.kind) {
    case "string":
      return value.value.length === 0 ? null : value.value;
    case "object":
      for (const key of sortedKeys(value.fields)) {
        const found = anyString(value.fields.get(key));
        if (found !== null) return found;
      }
      return null;
    case "array":
      for (const item of value.values) {
        const found = anyString(item);
        if (found !== null) return found;
      }
      return null;
    default:
      return null;
  }
}

/** From a parsed JSON value; null for a missing one (`undefined`), `{kind: "null"}` for JSON null. */
export function scriptValueFromJSON(value: unknown): ScriptValue | null {
  if (value === undefined) return null;
  if (value === null) return Script.null();
  if (typeof value === "string") return Script.string(value);
  if (typeof value === "boolean") return Script.bool(value);
  if (typeof value === "number") return Script.number(value);
  if (Array.isArray(value)) {
    const values: ScriptValue[] = [];
    for (const item of value) {
      const converted = scriptValueFromJSON(item);
      if (converted !== null) values.push(converted);
    }
    return Script.array(values);
  }
  if (typeof value === "object") {
    const fields = new Map<string, ScriptValue>();
    for (const [key, item] of Object.entries(value)) {
      const converted = scriptValueFromJSON(item);
      if (converted !== null) fields.set(key, converted);
    }
    return { kind: "object", fields };
  }
  return null;
}

/** One `tools.<name>(…)` call found in a script, with its first argument when that is a literal. */
export interface ScriptCall {
  readonly name: string;
  readonly argument: ScriptValue | null;
}

const maxCodePoint = 0x10ffff;
const isDigit = (c: string | undefined): boolean => c !== undefined && c >= "0" && c <= "9";
const isSpace = (c: string): boolean => c === " " || c === "\n" || c === "\t" || c === "\r" || c === "\u000b" || c === "\u000c" || c === " ";
const isIdentifierStart = (c: string): boolean =>
  c === "_" || c === "$" || (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c.codePointAt(0)! > 0x7f && /^\p{Alphabetic}$/u.test(c));
const isIdentifierPart = (c: string): boolean => isIdentifierStart(c) || isDigit(c);
const isNumberCharacter = (c: string): boolean =>
  isDigit(c) || (c >= "a" && c <= "f") || (c >= "A" && c <= "F") || c === "." || c === "-" || c === "+" || c === "x" || c === "X" || c === "_";

function hexValue(c: string | undefined): number | null {
  if (c === undefined) return null;
  if (c >= "0" && c <= "9") return c.charCodeAt(0) - 48;
  if (c >= "a" && c <= "f") return c.charCodeAt(0) - 87;
  if (c >= "A" && c <= "F") return c.charCodeAt(0) - 55;
  return null;
}

/** A Unicode scalar (no surrogates, at most U+10FFFF) as a string, or null. */
function scalar(value: number): string | null {
  if (value < 0 || value > maxCodePoint || (value >= 0xd800 && value <= 0xdfff)) return null;
  return String.fromCodePoint(value);
}

/** Swift's `Double(String)` over what a number may hold here: decimal (with exponent) or hexadecimal. */
function parseDouble(text: string): number | null {
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text)) return Number(text);
  const hex = /^([+-]?)0[xX]([0-9a-fA-F]+)$/.exec(text);
  if (hex !== null) {
    const magnitude = Number.parseInt(hex[2]!, 16);
    return hex[1] === "-" ? -magnitude : magnitude;
  }
  return null;
}

const int64Max = 2n ** 63n - 1n;

export class CodexScript {
  /** The script as Unicode scalars, one string each. */
  private readonly s: readonly string[];
  private i = 0;
  private depth = 0;
  /** The `${…}` code of the templates read by the call scan, which may itself call tools. */
  private templateCode: string[] = [];
  private templateNesting = 0;
  /** Malformed escapes seen so far: a string holding one is unextractable. */
  private malformedEscapes = 0;

  private constructor(source: readonly string[]) {
    this.s = source;
  }

  static calls(source: string): ScriptCall[] {
    return new CodexScript(Array.from(source)).scanCalls();
  }

  /** A copy (Swift's value semantics: the argument is read on a copy). */
  private copy(): CodexScript {
    const copy = new CodexScript(this.s);
    copy.i = this.i;
    copy.depth = this.depth;
    copy.templateCode = [...this.templateCode];
    copy.templateNesting = this.templateNesting;
    copy.malformedEscapes = this.malformedEscapes;
    return copy;
  }

  private scanCalls(): ScriptCall[] {
    const s = this.s;
    const calls: ScriptCall[] = [];
    while (this.i < s.length) {
      const c = s[this.i]!;
      if (c === "'" || c === '"') {
        this.readString(c);
        continue;
      }
      if (c === "`") {
        this.templateCode = [];
        this.readTemplate();
        for (const code of this.templateCode) calls.push(...CodexScript.calls(code));
        continue;
      }
      if (c === "/" && this.peek(1) === "/") {
        this.skipLineComment();
        continue;
      }
      if (c === "/" && this.peek(1) === "*") {
        this.skipBlockComment();
        continue;
      }
      if (isIdentifierStart(c)) {
        const start = this.i;
        const word = this.readIdentifier();
        if (word === "tools" && (start === 0 || s[start - 1] !== ".")) {
          let j = this.i;
          while (j < s.length && isSpace(s[j]!)) j += 1;
          if (!(j < s.length && s[j] === ".")) continue;
          j += 1;
          while (j < s.length && isSpace(s[j]!)) j += 1;
          if (!(j < s.length && isIdentifierStart(s[j]!))) continue;
          this.i = j;
          const name = this.readIdentifier();
          let k = this.i;
          while (k < s.length && isSpace(s[k]!)) k += 1;
          if (!(k < s.length && s[k] === "(")) continue;
          this.i = k + 1;
          const argumentScanner = this.copy();
          argumentScanner.depth = 0;
          argumentScanner.skipSpaceAndComments();
          const argument = argumentScanner.peek(0) === ")" ? null : argumentScanner.parseValue();
          calls.push({ name, argument });
        }
        continue;
      }
      this.i += 1;
    }
    return calls;
  }

  // MARK: values

  private parseValue(): ScriptValue | null {
    this.depth += 1;
    try {
      if (this.depth >= 64) return null;
      this.skipSpaceAndComments();
      const c = this.peek(0);
      if (c === undefined) return null;
      if (c === "{") return this.parseObject();
      if (c === "[") return this.parseArray();
      if (c === "'" || c === '"' || c === "`") {
        const malformedBefore = this.malformedEscapes;
        let text = c === "`" ? this.readTemplate() : this.readString(c);
        // "a" + "b" + `c`
        for (;;) {
          const save = this.i;
          this.skipSpaceAndComments();
          if (this.peek(0) !== "+") {
            this.i = save;
            break;
          }
          this.i += 1;
          this.skipSpaceAndComments();
          const q = this.peek(0);
          if (!(q === "'" || q === '"' || q === "`")) {
            this.i = save;
            break;
          }
          text += q === "`" ? this.readTemplate() : this.readString(q);
        }
        return this.malformedEscapes === malformedBefore ? Script.string(text) : null;
      }
      if (c === "-" || c === "." || isDigit(c)) return this.parseNumber();
      if (isIdentifierStart(c)) {
        const word = this.readIdentifier();
        switch (word) {
          case "true":
            return Script.bool(true);
          case "false":
            return Script.bool(false);
          case "null":
          case "undefined":
            return Script.null();
          default:
            return Script.identifier(word);
        }
      }
      return null;
    } finally {
      this.depth -= 1;
    }
  }

  private parseObject(): ScriptValue | null {
    this.i += 1;
    const fields = new Map<string, ScriptValue>();
    for (;;) {
      this.skipSpaceAndComments();
      const c = this.peek(0);
      if (c === undefined) return null;
      if (c === "}") {
        this.i += 1;
        return { kind: "object", fields };
      }
      if (c === "." && this.peek(1) === "." && this.peek(2) === ".") {
        this.i += 3;
        this.parseValue();
      } else {
        let key: string;
        const malformedBefore = this.malformedEscapes;
        if (c === "'" || c === '"') key = this.readString(c);
        else if (c === "`") key = this.readTemplate();
        else if (isIdentifierStart(c) || isDigit(c)) key = this.readIdentifier();
        else return null;
        if (this.malformedEscapes !== malformedBefore) return null;
        this.skipSpaceAndComments();
        const next = this.peek(0);
        if (next === ":") {
          this.i += 1;
          const value = this.parseValue();
          if (value === null) return null;
          fields.set(key, value);
        } else if (next === "," || next === "}") {
          fields.set(key, Script.identifier(key));
        } else {
          return null;
        }
      }
      this.skipSpaceAndComments();
      if (this.peek(0) === ",") {
        this.i += 1;
        continue;
      }
      if (this.peek(0) === "}") {
        this.i += 1;
        return { kind: "object", fields };
      }
      return null;
    }
  }

  private parseArray(): ScriptValue | null {
    this.i += 1;
    const values: ScriptValue[] = [];
    for (;;) {
      this.skipSpaceAndComments();
      const c = this.peek(0);
      if (c === undefined) return null;
      if (c === "]") {
        this.i += 1;
        return Script.array(values);
      }
      if (c === "." && this.peek(1) === "." && this.peek(2) === ".") {
        this.i += 3;
        this.parseValue();
      } else {
        const value = this.parseValue();
        if (value === null) return null;
        values.push(value);
      }
      this.skipSpaceAndComments();
      if (this.peek(0) === ",") {
        this.i += 1;
        continue;
      }
      if (this.peek(0) === "]") {
        this.i += 1;
        return Script.array(values);
      }
      return null;
    }
  }

  private parseNumber(): ScriptValue | null {
    const start = this.i;
    while (this.i < this.s.length && isNumberCharacter(this.s[this.i]!)) this.i += 1;
    let text = this.s.slice(start, this.i).join("").split("_").join("");
    if (text.length === 0 || text === "-") return null;
    if (text.startsWith("0x") || text.startsWith("0X")) {
      text = text.slice(2);
      // Swift's Int(text, radix: 16): an optional sign, hex digits, within Int64.
      const match = /^([+-]?)([0-9a-fA-F]+)$/.exec(text);
      if (match === null) return null;
      const magnitude = BigInt("0x" + match[2]!);
      const value = match[1] === "-" ? -magnitude : magnitude;
      if (value > int64Max || value < -int64Max - 1n) return null;
      return Script.number(Number(value));
    }
    const value = parseDouble(text);
    return value === null ? null : Script.number(value);
  }

  // MARK: strings

  /** A quoted string from its opening quote; ends at the closing quote (or at a newline, unterminated). */
  private readString(quote: string): string {
    this.i += 1;
    let out = "";
    while (this.i < this.s.length) {
      const c = this.s[this.i]!;
      if (c === quote) {
        this.i += 1;
        return out;
      }
      if (c === "\n") return out;
      if (c === "\\") {
        const escaped = this.readEscape();
        if (escaped === null) this.malformedEscapes += 1;
        else out += escaped;
        continue;
      }
      out += c;
      this.i += 1;
    }
    return out;
  }

  /** A template literal from its backtick; `${…}` kept as written. */
  private readTemplate(): string {
    this.i += 1;
    this.templateNesting += 1;
    try {
      let out = "";
      while (this.i < this.s.length) {
        const c = this.s[this.i]!;
        if (c === "`") {
          this.i += 1;
          return out;
        }
        if (c === "\\") {
          const escaped = this.readEscape();
          if (escaped === null) this.malformedEscapes += 1;
          else out += escaped;
          continue;
        }
        if (c === "$" && this.peek(1) === "{") {
          const start = this.i;
          this.i += 2;
          this.skipExpression("}");
          const end = Math.min(this.i, this.s.length);
          out += this.s.slice(start, end).join("");
          if (this.templateNesting === 1 && end - 1 > start + 2) {
            this.templateCode.push(this.s.slice(start + 2, end - 1).join(""));
          }
          continue;
        }
        out += c;
        this.i += 1;
      }
      return out;
    } finally {
      this.templateNesting -= 1;
    }
  }

  /** Skips code up to and past the matching `close`, minding nesting, strings, templates and comments. */
  private skipExpression(close: string): void {
    let level = 0;
    while (this.i < this.s.length) {
      const c = this.s[this.i]!;
      if (c === "'" || c === '"') {
        this.readString(c);
        continue;
      }
      if (c === "`") {
        this.readTemplate();
        continue;
      }
      if (c === "/" && this.peek(1) === "/") {
        this.skipLineComment();
        continue;
      }
      if (c === "/" && this.peek(1) === "*") {
        this.skipBlockComment();
        continue;
      }
      if (c === "{" || c === "(" || c === "[") level += 1;
      if (c === "}" || c === ")" || c === "]") {
        if (level === 0 && c === close) {
          this.i += 1;
          return;
        }
        level -= 1;
      }
      this.i += 1;
    }
  }

  /**
   * Reads one escape after its backslash: what it stands for, or null for a
   * malformed one (a bad hex escape, a code point past U+10FFFF, a lone
   * surrogate), which makes the string holding it unextractable.
   */
  private readEscape(): string | null {
    this.i += 1;
    if (this.i >= this.s.length) return null;
    const c = this.s[this.i]!;
    this.i += 1;
    switch (c) {
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "r":
        return "\r";
      case "b":
        return "\u0008";
      case "f":
        return "\u000c";
      case "v":
        return "\u000b";
      case "0":
        return isDigit(this.peek(0)) ? "0" : "\u0000";
      case "\n":
        return ""; // line continuation
      case "\r":
        if (this.peek(0) === "\n") this.i += 1;
        return "";
      case "x": {
        const value = this.hex(2);
        return value === null ? null : scalar(value);
      }
      case "u": {
        if (this.peek(0) === "{") {
          this.i += 1;
          // Any number of digits, bounded as they are read so the value never passes U+10FFFF.
          let value = 0;
          let digits = 0;
          let inRange = true;
          for (;;) {
            const digit = hexValue(this.peek(0));
            if (digit === null) break;
            this.i += 1;
            digits += 1;
            if (inRange) {
              if (value > Math.floor((maxCodePoint - digit) / 16)) inRange = false;
              else value = value * 16 + digit;
            }
          }
          if (this.peek(0) !== "}") return null;
          this.i += 1;
          if (digits === 0 || !inRange) return null;
          return scalar(value);
        }
        const value = this.hex(4);
        if (value === null) return null;
        // A surrogate pair is two \u escapes.
        if (value >= 0xd800 && value <= 0xdbff && this.peek(0) === "\\" && this.peek(1) === "u") {
          const save = this.i;
          this.i += 2;
          const low = this.hex(4);
          if (low !== null && low >= 0xdc00 && low <= 0xdfff) {
            const paired = scalar(0x10000 + ((value - 0xd800) << 10) + (low - 0xdc00));
            if (paired !== null) return paired;
          }
          this.i = save;
        }
        return scalar(value);
      }
      default:
        return c;
    }
  }

  private hex(count: number): number | null {
    if (this.i + count > this.s.length) return null;
    let value = 0;
    for (let offset = 0; offset < count; offset += 1) {
      const digit = hexValue(this.s[this.i + offset]);
      if (digit === null) return null;
      value = value * 16 + digit;
    }
    this.i += count;
    return value;
  }

  // MARK: lexing

  private peek(offset: number): string | undefined {
    return this.s[this.i + offset];
  }

  private readIdentifier(): string {
    const start = this.i;
    while (this.i < this.s.length && isIdentifierPart(this.s[this.i]!)) this.i += 1;
    return this.s.slice(start, this.i).join("");
  }

  private skipSpaceAndComments(): void {
    while (this.i < this.s.length) {
      const c = this.s[this.i]!;
      if (isSpace(c)) {
        this.i += 1;
        continue;
      }
      if (c === "/" && this.peek(1) === "/") {
        this.skipLineComment();
        continue;
      }
      if (c === "/" && this.peek(1) === "*") {
        this.skipBlockComment();
        continue;
      }
      return;
    }
  }

  private skipLineComment(): void {
    while (this.i < this.s.length && this.s[this.i] !== "\n") this.i += 1;
  }

  private skipBlockComment(): void {
    this.i += 2;
    while (this.i < this.s.length) {
      if (this.s[this.i] === "*" && this.peek(1) === "/") {
        this.i += 2;
        return;
      }
      this.i += 1;
    }
  }
}

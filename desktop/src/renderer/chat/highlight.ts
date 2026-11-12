// Syntax colours for the Chat view's code blocks: a small tokenizer per
// language family (C-like, Swift, Rust, Go, Python, Ruby, shell, JSON, YAML,
// TOML, CSS, markup, diff, SQL), the way T3 Code colours its fences but
// without a grammar engine or a new package. It reads one pass left to right
// (linear in the code, every search bounded), loses nothing (the tokens put
// together are the code) and makes no HTML: the view turns each token into a
// span with a class. Unknown languages, "text" and code over the cap stay plain.

export type CodeTokenKind =
  | "plain"
  | "keyword"
  | "literal"
  | "string"
  | "number"
  | "comment"
  | "type"
  | "function"
  | "property"
  | "variable"
  | "punct"
  | "meta"
  | "tag"
  | "attr"
  | "add"
  | "del";

export interface CodeToken {
  readonly kind: CodeTokenKind;
  readonly text: string;
}

/** Longer code is shown plain: colouring it would cost more than it helps. */
export const maxHighlightLength = 100_000;

type Family = "js" | "swift" | "rust" | "go" | "clike" | "python" | "ruby" | "shell" | "json" | "yaml" | "toml" | "css" | "markup" | "diff" | "sql";

const aliases: Readonly<Record<string, Family>> = {
  js: "js", jsx: "js", mjs: "js", cjs: "js", javascript: "js", ts: "js", tsx: "js", mts: "js", cts: "js", typescript: "js", node: "js",
  swift: "swift",
  rust: "rust", rs: "rust",
  go: "go", golang: "go",
  c: "clike", h: "clike", cpp: "clike", cc: "clike", cxx: "clike", hpp: "clike", "c++": "clike", objc: "clike", "objective-c": "clike", m: "clike",
  java: "clike", kotlin: "clike", kt: "clike", kts: "clike", scala: "clike", cs: "clike", csharp: "clike", "c#": "clike", dart: "clike", php: "clike", zig: "clike", groovy: "clike", gradle: "clike",
  python: "python", py: "python", python3: "python", py3: "python",
  ruby: "ruby", rb: "ruby",
  sh: "shell", bash: "shell", zsh: "shell", shell: "shell", console: "shell", shellsession: "shell", fish: "shell", ksh: "shell", dockerfile: "shell", make: "shell", makefile: "shell",
  json: "json", jsonc: "json", json5: "json", jsonl: "json", ndjson: "json",
  yaml: "yaml", yml: "yaml",
  toml: "toml", ini: "toml", cfg: "toml", conf: "toml", properties: "toml", env: "toml", dotenv: "toml",
  css: "css", scss: "css", less: "css", sass: "css",
  html: "markup", htm: "markup", xml: "markup", svg: "markup", plist: "markup", xhtml: "markup", vue: "markup", svelte: "markup",
  diff: "diff", patch: "diff", udiff: "diff",
  sql: "sql", sqlite: "sql", postgres: "sql", postgresql: "sql", mysql: "sql", psql: "sql",
};

/** The family a fence's language belongs to, or null (plain). */
export function codeLanguage(info: string | null): Family | null {
  if (info === null) return null;
  return aliases[info.trim().toLowerCase()] ?? null;
}

const words = (list: string): ReadonlySet<string> => new Set(list.split(/\s+/).filter(Boolean));

interface Spec {
  readonly lineComments: readonly string[];
  readonly blockComments: readonly (readonly [string, string])[];
  readonly quotes: string;
  /** Strings that may run over lines (backticks, shell). */
  readonly multiline: string;
  readonly triple: string;
  readonly keywords: ReadonlySet<string>;
  readonly literals: ReadonlySet<string>;
  readonly builtins: ReadonlySet<string>;
  /** A capitalised name reads as a type. */
  readonly capitalTypes: boolean;
  /** `@name` reads as an attribute or decorator. */
  readonly decorators: boolean;
  /** Names may hold a hyphen (CSS, YAML). */
  readonly hyphens: boolean;
  readonly caseInsensitive: boolean;
}

const none: ReadonlySet<string> = new Set();
const cComments = { lineComments: ["//"], blockComments: [["/*", "*/"]] as const };

const specs: Readonly<Record<Exclude<Family, "markup" | "diff">, Spec>> = {
  js: {
    ...cComments,
    quotes: "\"'`",
    multiline: "`",
    triple: "",
    keywords: words(
      "abstract as async await break case catch class const continue debugger declare default delete do else enum export extends finally for from function if implements import in instanceof interface keyof let namespace new of private protected public readonly return satisfies static super switch this throw try type typeof var void while with yield",
    ),
    literals: words("true false null undefined NaN Infinity"),
    builtins: words("string number boolean any unknown never object bigint symbol"),
    capitalTypes: true,
    decorators: true,
    hyphens: false,
    caseInsensitive: false,
  },
  swift: {
    ...cComments,
    quotes: '"',
    multiline: "",
    triple: '"',
    keywords: words(
      "actor any as associatedtype async await break case catch class consume continue convenience default defer deinit didSet do dynamic else enum extension fallthrough fileprivate final for func get guard if import in indirect init inout internal is lazy let mutating nonisolated nonmutating open operator optional override package private protocol public repeat required rethrows return self Self set some static struct subscript super switch throw throws try typealias unowned var weak where while willSet",
    ),
    literals: words("true false nil"),
    builtins: none,
    capitalTypes: true,
    decorators: true,
    hyphens: false,
    caseInsensitive: false,
  },
  rust: {
    ...cComments,
    quotes: '"',
    multiline: '"',
    triple: "",
    keywords: words("as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait type union unsafe use where while"),
    literals: words("true false"),
    builtins: words("i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 bool char str"),
    capitalTypes: true,
    decorators: false,
    hyphens: false,
    caseInsensitive: false,
  },
  go: {
    ...cComments,
    quotes: "\"'`",
    multiline: "`",
    triple: "",
    keywords: words("break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var"),
    literals: words("true false nil iota"),
    builtins: words("bool byte complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string uint uint8 uint16 uint32 uint64 uintptr any"),
    capitalTypes: false,
    decorators: false,
    hyphens: false,
    caseInsensitive: false,
  },
  clike: {
    lineComments: ["//"],
    blockComments: [["/*", "*/"]],
    quotes: "\"'",
    multiline: "",
    triple: '"',
    keywords: words(
      "abstract as auto break case catch class companion const constexpr continue data default delete do else enum extends extern final finally for friend fun goto if implements import in inline interface internal is lateinit namespace new object open operator out override package private protected public return sealed sizeof static struct super suspend switch template this throw throws try typedef typename union using val var virtual volatile when while #include #define #import #pragma #if #ifdef #ifndef #endif",
    ),
    literals: words("true false null nullptr NULL YES NO nil"),
    builtins: words("void int char bool boolean double float long short unsigned signed byte size_t String"),
    capitalTypes: true,
    decorators: true,
    hyphens: false,
    caseInsensitive: false,
  },
  python: {
    lineComments: ["#"],
    blockComments: [],
    quotes: "\"'",
    multiline: "",
    triple: "\"'",
    keywords: words("and as assert async await break case class continue def del elif else except finally for from global if import in is lambda match nonlocal not or pass raise return self try while with yield"),
    literals: words("True False None"),
    builtins: words("int str float bool list dict set tuple bytes object"),
    capitalTypes: true,
    decorators: true,
    hyphens: false,
    caseInsensitive: false,
  },
  ruby: {
    lineComments: ["#"],
    blockComments: [],
    quotes: "\"'",
    multiline: "",
    triple: "",
    keywords: words("alias and begin break case class def defined do else elsif end ensure for if in module next not or redo rescue retry return self super then undef unless until when while yield require attr_reader attr_accessor"),
    literals: words("true false nil"),
    builtins: none,
    capitalTypes: true,
    decorators: false,
    hyphens: false,
    caseInsensitive: false,
  },
  shell: {
    lineComments: ["#"],
    blockComments: [],
    quotes: "\"'",
    multiline: "\"'",
    triple: "",
    keywords: words("if then else elif fi for while until do done case esac in function select return exit export local readonly declare unset shift source alias set time"),
    literals: words("true false"),
    builtins: none,
    capitalTypes: false,
    decorators: false,
    hyphens: true,
    caseInsensitive: false,
  },
  json: {
    ...cComments,
    quotes: '"',
    multiline: "",
    triple: "",
    keywords: none,
    literals: words("true false null"),
    builtins: none,
    capitalTypes: false,
    decorators: false,
    hyphens: false,
    caseInsensitive: false,
  },
  yaml: {
    lineComments: ["#"],
    blockComments: [],
    quotes: "\"'",
    multiline: "",
    triple: "",
    keywords: none,
    literals: words("true false null yes no on off True False Null ~"),
    builtins: none,
    capitalTypes: false,
    decorators: false,
    hyphens: true,
    caseInsensitive: false,
  },
  toml: {
    lineComments: ["#", ";"],
    blockComments: [],
    quotes: "\"'",
    multiline: "",
    triple: "\"'",
    keywords: none,
    literals: words("true false"),
    builtins: none,
    capitalTypes: false,
    decorators: false,
    hyphens: true,
    caseInsensitive: false,
  },
  css: {
    lineComments: [],
    blockComments: [["/*", "*/"]],
    quotes: "\"'",
    multiline: "",
    triple: "",
    keywords: words("important"),
    literals: none,
    builtins: none,
    capitalTypes: false,
    decorators: true,
    hyphens: true,
    caseInsensitive: false,
  },
  sql: {
    lineComments: ["--"],
    blockComments: [["/*", "*/"]],
    quotes: "'\"",
    multiline: "'",
    triple: "",
    keywords: words(
      "add all alter and as asc begin between by case check column commit constraint create cross default delete desc distinct drop else end exists foreign from full group having if in index inner insert into is join key left like limit not null offset on or order outer primary references returning right rollback select set table then transaction union unique update using values view when where with",
    ),
    literals: words("true false null"),
    builtins: words("int integer text varchar char boolean real blob date timestamp serial bigint"),
    capitalTypes: false,
    decorators: false,
    hyphens: false,
    caseInsensitive: true,
  },
};

/** The tokens, plain runs merged. */
class Tokens {
  readonly list: { kind: CodeTokenKind; text: string }[] = [];

  push(kind: CodeTokenKind, text: string): void {
    if (text === "") return;
    const last = this.list[this.list.length - 1];
    if (kind === "plain" && last !== undefined && last.kind === "plain") last.text += text;
    else this.list.push({ kind, text });
  }
}

const isDigit = (c: string | undefined): boolean => c !== undefined && c >= "0" && c <= "9";
const isLetter = (c: string | undefined): boolean => c !== undefined && ((c >= "a" && c <= "z") || (c >= "A" && c <= "Z"));
const isIdentStart = (c: string | undefined): boolean => c !== undefined && (isLetter(c) || c === "_" || c === "$");
const isIdentChar = (c: string | undefined): boolean => c !== undefined && (isIdentStart(c) || isDigit(c));
const isSpace = (c: string | undefined): boolean => c === " " || c === "\t" || c === "\r";
const punctChars = "{}[]()<>=+-*/%!&|^~?:;,.\\@#";
const shellPunct = ";|&()<>`";
const shellWordStop = " \t\r\n;|&()<>\"'$`";

/** The next character after spaces (not newlines), or undefined. */
function nextSolid(code: string, from: number): string | undefined {
  let j = from;
  while (j < code.length && isSpace(code[j])) j += 1;
  return code[j];
}

/** The end of a quoted string starting at `start` (one past the closing quote, or the line's or code's end). */
function stringEnd(code: string, start: number, quote: string, multiline: boolean, escapes: boolean): number {
  let j = start + 1;
  while (j < code.length) {
    const c = code[j]!;
    if (escapes && c === "\\") {
      j += 2;
      continue;
    }
    if (c === quote) return j + 1;
    if (c === "\n" && !multiline) return j;
    j += 1;
  }
  return code.length;
}

function numberEnd(code: string, start: number): number {
  let j = start;
  const n = code.length;
  if (code[j] === "0" && (code[j + 1] === "x" || code[j + 1] === "X" || code[j + 1] === "b" || code[j + 1] === "o")) {
    j += 2;
    while (j < n && (isIdentChar(code[j]) || code[j] === "_")) j += 1;
    return j;
  }
  while (j < n && (isDigit(code[j]) || code[j] === "_")) j += 1;
  if (code[j] === "." && isDigit(code[j + 1])) {
    j += 1;
    while (j < n && (isDigit(code[j]) || code[j] === "_")) j += 1;
  }
  if ((code[j] === "e" || code[j] === "E") && (isDigit(code[j + 1]) || ((code[j + 1] === "+" || code[j + 1] === "-") && isDigit(code[j + 2])))) {
    j += 2;
    while (j < n && isDigit(code[j])) j += 1;
  }
  // Suffixes and units: 10px, 1.5em, 50%, 8u8, 10n.
  while (j < n && (isLetter(code[j]) || code[j] === "%")) j += 1;
  return j;
}

function scan(code: string, family: Exclude<Family, "markup" | "diff">): CodeToken[] {
  const spec = specs[family];
  const out = new Tokens();
  const n = code.length;
  let i = 0;
  // Shell: the next word is a command. CSS: inside a rule or parentheses.
  let commandStart = true;
  let braces = 0;
  let parens = 0;
  const wordChar = (c: string | undefined): boolean => isIdentChar(c) || (spec.hyphens && c === "-");

  while (i < n) {
    const c = code[i]!;
    if (c === "\n") {
      out.push("plain", c);
      i += 1;
      commandStart = true;
      continue;
    }
    if (isSpace(c)) {
      let j = i + 1;
      while (j < n && isSpace(code[j])) j += 1;
      out.push("plain", code.slice(i, j));
      i = j;
      continue;
    }

    // Comments. A shell or YAML # needs a space or a line start before it.
    const line = spec.lineComments.find(
      (open) => code.startsWith(open, i) && (open !== "#" || family === "python" || family === "ruby" || i === 0 || isSpace(code[i - 1]) || code[i - 1] === "\n" || code[i - 1] === ";"),
    );
    if (line !== undefined) {
      let end = code.indexOf("\n", i);
      if (end < 0) end = n;
      out.push("comment", code.slice(i, end));
      i = end;
      continue;
    }
    const block = spec.blockComments.find(([open]) => code.startsWith(open, i));
    if (block !== undefined) {
      const close = code.indexOf(block[1], i + block[0].length);
      const end = close < 0 ? n : close + block[1].length;
      out.push("comment", code.slice(i, end));
      i = end;
      continue;
    }

    // Strings.
    if (spec.triple.includes(c) && code.startsWith(c.repeat(3), i)) {
      const close = code.indexOf(c.repeat(3), i + 3);
      const end = close < 0 ? n : close + 3;
      out.push("string", code.slice(i, end));
      i = end;
      continue;
    }
    if (c === "'" && family === "rust") {
      // A char ('x', '\n') or a lifetime ('a).
      const end = code[i + 1] === "\\" ? code.indexOf("'", i + 2) : code[i + 2] === "'" ? i + 2 : -1;
      if (end >= 0 && end - i <= 10) {
        out.push("string", code.slice(i, end + 1));
        i = end + 1;
      } else if (isIdentStart(code[i + 1])) {
        let j = i + 1;
        while (j < n && isIdentChar(code[j])) j += 1;
        out.push("meta", code.slice(i, j));
        i = j;
      } else {
        out.push("punct", c);
        i += 1;
      }
      continue;
    }
    if (spec.quotes.includes(c)) {
      const end = stringEnd(code, i, c, spec.multiline.includes(c), !(family === "shell" && c === "'") && family !== "sql");
      const text = code.slice(i, end);
      out.push((family === "json" || family === "yaml") && nextSolid(code, end) === ":" ? "property" : "string", text);
      i = end;
      commandStart = false;
      continue;
    }

    if (family === "shell") {
      if (c === "$") {
        let j = i + 1;
        if (code[j] === "{") {
          const close = code.indexOf("}", j);
          const lineEnd = code.indexOf("\n", j);
          j = close >= 0 && (lineEnd < 0 || close < lineEnd) && close - i <= 200 ? close + 1 : j + 1;
        } else if (code[j] === "(") {
          out.push("punct", "$(");
          i = j + 1;
          commandStart = true;
          continue;
        } else if (isIdentChar(code[j])) {
          while (j < n && isIdentChar(code[j])) j += 1;
        } else if (code[j] !== undefined && "?@#*!$-".includes(code[j]!)) {
          j += 1;
        }
        out.push("variable", code.slice(i, j));
        i = j;
        commandStart = false;
        continue;
      }
      if (shellPunct.includes(c)) {
        let j = i + 1;
        while (j < n && shellPunct.includes(code[j]!)) j += 1;
        const run = code.slice(i, j);
        out.push("punct", run);
        if (/[;|&(`]/.test(run)) commandStart = true;
        i = j;
        continue;
      }
      let j = i;
      while (j < n && !shellWordStop.includes(code[j]!)) j += 1;
      const word = code.slice(i, j);
      const assignment = /^[A-Za-z_]\w*=/.exec(word);
      if (commandStart && assignment !== null) {
        const name = assignment[0].slice(0, -1);
        out.push("variable", name);
        out.push("punct", "=");
        out.push("plain", word.slice(name.length + 1));
      } else if (commandStart && spec.keywords.has(word)) {
        out.push("keyword", word);
      } else if (commandStart) {
        out.push("function", word);
        commandStart = false;
      } else {
        out.push(/^\d+$/.test(word) ? "number" : "plain", word);
      }
      i = j;
      continue;
    }

    // Attributes, decorators, at-rules.
    if (c === "@" && spec.decorators && (isIdentStart(code[i + 1]) || (family === "css" && code[i + 1] === "-"))) {
      let j = i + 1;
      while (j < n && wordChar(code[j])) j += 1;
      out.push("meta", code.slice(i, j));
      i = j;
      continue;
    }
    // CSS colours.
    if (c === "#" && family === "css" && /^[0-9a-fA-F]{3,8}\b/.test(code.slice(i + 1, i + 10))) {
      let j = i + 1;
      while (j < n && /[0-9a-fA-F]/.test(code[j]!)) j += 1;
      out.push("number", code.slice(i, j));
      i = j;
      continue;
    }
    // C preprocessor lines.
    if (c === "#" && family === "clike" && isLetter(code[i + 1])) {
      let j = i + 1;
      while (j < n && isIdentChar(code[j])) j += 1;
      out.push("meta", code.slice(i, j));
      i = j;
      continue;
    }

    if (isDigit(c) && !(i > 0 && wordChar(code[i - 1]))) {
      const end = numberEnd(code, i);
      out.push("number", code.slice(i, end));
      i = end;
      continue;
    }

    if (isIdentStart(c) || (spec.hyphens && c === "-" && isLetter(code[i + 1]) && !(i > 0 && wordChar(code[i - 1])))) {
      let j = i + 1;
      while (j < n && wordChar(code[j])) j += 1;
      const word = code.slice(i, j);
      const key = spec.caseInsensitive ? word.toLowerCase() : word;
      const after = code[j];
      let kind: CodeTokenKind = "plain";
      if (family === "json" || family === "yaml" || family === "toml") {
        const solid = nextSolid(code, j);
        if (spec.literals.has(word)) kind = "literal";
        else if ((family === "toml" && solid === "=") || (family === "yaml" && solid === ":")) kind = "property";
      } else if (family === "css") {
        if (nextSolid(code, j) === ":" && (braces > 0 || parens > 0)) kind = "property";
        else if (spec.keywords.has(word)) kind = "keyword";
        else if (after === "(") kind = "function";
      } else if (spec.keywords.has(key)) kind = "keyword";
      else if (spec.literals.has(key)) kind = "literal";
      else if (after === "(") kind = "function";
      else if (spec.builtins.has(key)) kind = "type";
      else if (spec.capitalTypes && c >= "A" && c <= "Z" && word.length > 1) kind = "type";
      out.push(kind, word);
      i = j;
      continue;
    }

    if (punctChars.includes(c)) {
      let j = i;
      while (
        j < n &&
        punctChars.includes(code[j]!) &&
        (j === i ||
          !(
            spec.lineComments.some((open) => open !== "#" && code.startsWith(open, j)) ||
            spec.blockComments.some(([open]) => code.startsWith(open, j)) ||
            code[j] === "@" ||
            code[j] === "#"
          ))
      ) {
        const p = code[j]!;
        if (p === "{") braces += 1;
        else if (p === "}") braces = Math.max(0, braces - 1);
        else if (p === "(") parens += 1;
        else if (p === ")") parens = Math.max(0, parens - 1);
        j += 1;
      }
      out.push("punct", code.slice(i, j));
      i = j;
      continue;
    }

    out.push("plain", c);
    i += 1;
  }
  return out.list;
}

function scanDiff(code: string): CodeToken[] {
  const out = new Tokens();
  let i = 0;
  while (i < code.length) {
    let end = code.indexOf("\n", i);
    end = end < 0 ? code.length : end + 1;
    const line = code.slice(i, end);
    if (/^(\+\+\+|---|@@|diff |index )/.test(line)) out.push("meta", line);
    else if (line.startsWith("+")) out.push("add", line);
    else if (line.startsWith("-")) out.push("del", line);
    else out.push("plain", line);
    i = end;
  }
  return out.list;
}

function scanMarkup(code: string): CodeToken[] {
  const out = new Tokens();
  const n = code.length;
  let i = 0;
  const nameChar = (c: string | undefined): boolean => c !== undefined && (isIdentChar(c) || c === "-" || c === ":" || c === ".");
  while (i < n) {
    if (code.startsWith("<!--", i)) {
      const close = code.indexOf("-->", i + 4);
      const end = close < 0 ? n : close + 3;
      out.push("comment", code.slice(i, end));
      i = end;
      continue;
    }
    const next = code[i + 1];
    if (code[i] === "<" && (isLetter(next) || ((next === "/" || next === "?" || next === "!") && isLetter(code[i + 2])))) {
      const open = isLetter(next) ? "<" : code.slice(i, i + 2);
      out.push("punct", open);
      let j = i + open.length;
      const start = j;
      while (j < n && nameChar(code[j])) j += 1;
      out.push("tag", code.slice(start, j));
      // Inside the tag: attributes, values, up to its end.
      while (j < n) {
        const c = code[j]!;
        if (c === ">" || (c === "/" && code[j + 1] === ">") || (c === "?" && code[j + 1] === ">")) {
          const end = c === ">" ? j + 1 : j + 2;
          out.push("punct", code.slice(j, end));
          j = end;
          break;
        }
        if (c === "<") break;
        if (c === '"' || c === "'") {
          const end = stringEnd(code, j, c, true, false);
          out.push("string", code.slice(j, end));
          j = end;
        } else if (c === "=") {
          out.push("punct", c);
          j += 1;
        } else if (isSpace(c) || c === "\n" || c === "/") {
          out.push("plain", c);
          j += 1;
        } else {
          let k = j + 1;
          while (k < n && !" \t\r\n=>/<\"'".includes(code[k]!)) k += 1;
          out.push("attr", code.slice(j, k));
          j = k;
        }
      }
      i = j;
      continue;
    }
    const lt = code.indexOf("<", i + 1);
    const end = lt < 0 ? n : lt;
    out.push("plain", code.slice(i, end));
    i = end;
  }
  return out.list;
}

/** The code as coloured tokens; one plain token when its language is unknown or it is too long. */
export function highlight(code: string, language: string | null): CodeToken[] {
  const family = codeLanguage(language);
  if (family === null || code.length > maxHighlightLength || code === "") return code === "" ? [] : [{ kind: "plain", text: code }];
  if (family === "diff") return scanDiff(code);
  if (family === "markup") return scanMarkup(code);
  return scan(code, family);
}

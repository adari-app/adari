// The agent's replies in the Chat view: a small, pure markdown reader to an AST
// the renderer turns into React elements (never HTML: raw HTML in a reply shows
// as text). The block rules follow App/CompanionChatMarkdown.swift (paragraphs
// keep their line breaks, ATX headings, ``` and ~~~ fences, rules, GFM tables,
// - * + and 1. 1) list items nested by indent with indented continuation lines,
// > quotes); the inline rules follow CommonMark's delimiter algorithm (code
// spans, ** __ * _ emphasis with the intraword `_` rule, ~~strike~~, links,
// <autolinks> and bare web URLs, backslash escapes), as Foundation's inline
// markdown does for the Swift app. Only web links (http, https) stay links.
//
// Bounded work: every scan is linear or bounded (no backtracking regexes on
// the text), and nesting is capped, so a 200 KB reply of `*` or `[` reads in
// a few milliseconds and the renderer never recurses deeply.

export type MdInline =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "code"; readonly text: string }
  | { readonly type: "strong" | "em" | "strike"; readonly children: readonly MdInline[] }
  | { readonly type: "link"; readonly href: string; readonly children: readonly MdInline[] }
  | { readonly type: "break" };

export type MdAlign = "left" | "center" | "right" | null;

export type MdBlock =
  | { readonly type: "paragraph"; readonly inlines: readonly MdInline[] }
  | { readonly type: "heading"; readonly level: number; readonly inlines: readonly MdInline[] }
  | { readonly type: "code"; readonly language: string | null; readonly text: string }
  | { readonly type: "list"; readonly ordered: boolean; readonly start: number; readonly items: readonly (readonly MdBlock[])[] }
  | { readonly type: "quote"; readonly blocks: readonly MdBlock[] }
  | { readonly type: "rule" }
  | {
      readonly type: "table";
      readonly align: readonly MdAlign[];
      readonly head: readonly (readonly MdInline[])[];
      readonly rows: readonly (readonly (readonly MdInline[])[])[];
    };

/** Inline wrappers (emphasis, links) nest at most this deep; deeper markup reads as its text. */
export const maxInlineDepth = 16;
/** Quotes nest at most this deep; a deeper `>` line is paragraph text. */
export const maxQuoteDepth = 8;
/** Lists nest at most this deep; a deeper item is a sibling. */
export const maxListDepth = 10;
/** A link destination or autolink is at most this long. */
const maxDestination = 2_048;

// MARK: - characters

const isSpaceOrTab = (code: number): boolean => code === 0x20 || code === 0x09;

function isWhitespace(char: string | undefined): boolean {
  if (char === undefined) return true;
  const code = char.charCodeAt(0);
  if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d || code === 0x0c || code === 0x0b) return true;
  return code > 0x7f && /\s/u.test(char);
}

const asciiPunctuation = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";

function isPunctuation(char: string | undefined): boolean {
  if (char === undefined) return false;
  if (asciiPunctuation.includes(char)) return true;
  return char.charCodeAt(0) > 0x7f && /[\p{P}\p{S}]/u.test(char);
}

/** Spaces and tabs off both ends, by a scan (no regex: a long run of spaces stays linear). */
function trimSpaces(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && isSpaceOrTab(text.charCodeAt(start))) start += 1;
  while (end > start && isSpaceOrTab(text.charCodeAt(end - 1))) end -= 1;
  return start === 0 && end === text.length ? text : text.slice(start, end);
}

/** The line's indent in columns (a tab is four). */
function indentOf(line: string): { columns: number; length: number } {
  let columns = 0;
  let length = 0;
  while (length < line.length) {
    const code = line.charCodeAt(length);
    if (code === 0x20) columns += 1;
    else if (code === 0x09) columns += 4;
    else break;
    length += 1;
  }
  return { columns, length };
}

export function isWebLink(href: string): boolean {
  const head = href.slice(0, 8).toLowerCase();
  return (head.startsWith("http://") && href.length > 7) || (head.startsWith("https://") && href.length > 8);
}

// MARK: - blocks

/** The reply's blocks. Line ends may be CRLF, CR or LF. */
export function parseMarkdown(source: string): MdBlock[] {
  return parseBlocks(source.split(/\r\n|\r|\n/), 0);
}

interface Fence {
  readonly char: string;
  readonly length: number;
  readonly indent: number;
  readonly language: string | null;
}

/** "```swift", "~~~", any indent; a backtick fence's info has no backtick. */
function openingFence(line: string): Fence | null {
  const indent = indentOf(line);
  const body = line.slice(indent.length);
  const char = body[0];
  if (char !== "`" && char !== "~") return null;
  let length = 0;
  while (body[length] === char) length += 1;
  if (length < 3) return null;
  const info = trimSpaces(body.slice(length));
  if (char === "`" && info.includes("`")) return null;
  let word = 0;
  while (word < info.length && !isWhitespace(info[word])) word += 1;
  return { char, length, indent: indent.columns, language: word === 0 ? null : info.slice(0, word) };
}

function closesFence(line: string, fence: Fence): boolean {
  const trimmed = trimSpaces(line);
  let length = 0;
  while (trimmed[length] === fence.char) length += 1;
  return length >= fence.length && length === trimmed.length;
}

/** A code line without up to the fence's own indent (so code in a list item keeps its shape). */
function dropIndent(line: string, columns: number): string {
  let index = 0;
  let removed = 0;
  while (index < line.length && removed < columns && line.charCodeAt(index) === 0x20) {
    index += 1;
    removed += 1;
  }
  return line.slice(index);
}

/** Three or more of one of - * _, spaces allowed between (CompanionChatMarkdown.isRule). */
function isRule(trimmed: string): boolean {
  let first: string | null = null;
  let count = 0;
  for (const char of trimmed) {
    if (char === " " || char === "\t") continue;
    if (first === null) {
      if (char !== "-" && char !== "*" && char !== "_") return false;
      first = char;
    } else if (char !== first) {
      return false;
    }
    count += 1;
  }
  return count >= 3;
}

/** "# Title" to "###### Title" (a space after the hashes); a closing run of # is dropped. */
function heading(trimmed: string): MdBlock | null {
  let hashes = 0;
  while (trimmed[hashes] === "#") hashes += 1;
  if (hashes < 1 || hashes > 6 || trimmed[hashes] !== " ") return null;
  let text = trimSpaces(trimmed.slice(hashes + 1));
  let end = text.length;
  while (end > 0 && text[end - 1] === "#") end -= 1;
  if (end < text.length && (end === 0 || text[end - 1] === " ")) text = trimSpaces(text.slice(0, end));
  return { type: "heading", level: hashes, inlines: parseInline(text) };
}

/** "|---|:--:|" (CompanionChatMarkdown.isTableSeparator). */
function isTableSeparator(line: string): boolean {
  const trimmed = trimSpaces(line);
  if (!trimmed.includes("-") || !(trimmed.includes("|") || trimmed.startsWith("-"))) return false;
  for (const char of trimmed) {
    if (char !== "|" && char !== "-" && char !== ":" && char !== " ") return false;
  }
  return true;
}

/** A row's cells: outer pipes dropped, split at pipes not escaped (`\|` is a pipe in the cell). */
function cells(row: string): string[] {
  let text = trimSpaces(row);
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|") && !text.endsWith("\\|")) text = text.slice(0, -1);
  const parts: string[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\\" && text[index + 1] === "|") {
      index += 1;
      continue;
    }
    if (text[index] === "|") {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((part) => trimSpaces(part).split("\\|").join("|"));
}

function alignOf(cell: string): MdAlign {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":") && cell.length > 1;
  if (left && right) return "center";
  if (right) return "right";
  if (left) return "left";
  return null;
}

interface ListEntry {
  readonly indent: number;
  readonly ordered: boolean;
  readonly number: number;
  text: string;
}

/** "- item", "* item", "+ item", "1. item", "2) item" with its indent (CompanionChatMarkdown.listItem). */
function listEntry(line: string): ListEntry | null {
  const indent = indentOf(line);
  const body = line.slice(indent.length);
  const first = body[0];
  if ((first === "-" || first === "*" || first === "+") && body[1] === " ") {
    const text = trimSpaces(body.slice(2));
    return text === "" ? null : { indent: indent.columns, ordered: false, number: 1, text };
  }
  let digits = 0;
  while (digits < body.length && body.charCodeAt(digits) >= 0x30 && body.charCodeAt(digits) <= 0x39) digits += 1;
  if (digits === 0 || digits > 3) return null;
  const mark = body[digits];
  if ((mark !== "." && mark !== ")") || body[digits + 1] !== " ") return null;
  const text = trimSpaces(body.slice(digits + 2));
  return text === "" ? null : { indent: indent.columns, ordered: true, number: Number(body.slice(0, digits)), text };
}

/** One list from `start`: siblings at its indent, deeper entries nested in the item above them. */
function buildList(entries: readonly ListEntry[], start: number, depth: number): { block: MdBlock; next: number } {
  const first = entries[start]!;
  const base = first.indent;
  const items: MdBlock[][] = [];
  let index = start;
  while (index < entries.length) {
    const entry = entries[index]!;
    if (entry.indent < base) break;
    const last = items[items.length - 1];
    if (entry.indent >= base + 2 && last !== undefined && depth + 1 < maxListDepth) {
      const nested = buildList(entries, index, depth + 1);
      last.push(nested.block);
      index = nested.next;
      continue;
    }
    if (entry.ordered !== first.ordered) break;
    items.push([{ type: "paragraph", inlines: parseInline(entry.text) }]);
    index += 1;
  }
  return { block: { type: "list", ordered: first.ordered, start: first.number, items }, next: index };
}

function parseBlocks(lines: readonly string[], depth: number): MdBlock[] {
  const blocks: MdBlock[] = [];
  let paragraph: string[] = [];
  const flush = (): void => {
    if (paragraph.length === 0) return;
    blocks.push({ type: "paragraph", inlines: parseInline(paragraph.join("\n")) });
    paragraph = [];
  };

  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    const trimmed = trimSpaces(line);
    if (trimmed === "") {
      flush();
      index += 1;
      continue;
    }

    const fence = openingFence(line);
    if (fence !== null) {
      flush();
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !closesFence(lines[index]!, fence)) {
        code.push(dropIndent(lines[index]!, fence.indent));
        index += 1;
      }
      index += 1; // the closing fence (past the end when the fence never closes)
      blocks.push({ type: "code", language: fence.language, text: code.join("\n") });
      continue;
    }

    if (isRule(trimmed)) {
      flush();
      blocks.push({ type: "rule" });
      index += 1;
      continue;
    }

    const head = heading(trimmed);
    if (head !== null) {
      flush();
      blocks.push(head);
      index += 1;
      continue;
    }

    const next = lines[index + 1];
    if (trimmed.includes("|") && next !== undefined && isTableSeparator(next)) {
      flush();
      const align = cells(next).map(alignOf);
      const headCells = cells(trimmed).map(parseInline);
      const rows: MdInline[][][] = [];
      index += 2;
      while (index < lines.length) {
        const row = trimSpaces(lines[index]!);
        if (row === "" || !row.includes("|")) break;
        rows.push(cells(row).map(parseInline));
        index += 1;
      }
      blocks.push({ type: "table", align, head: headCells, rows });
      continue;
    }

    if (listEntry(line) !== null) {
      flush();
      const entries: ListEntry[] = [];
      while (index < lines.length) {
        const current = lines[index]!;
        const entry = listEntry(current);
        if (entry !== null) {
          entries.push(entry);
          index += 1;
          continue;
        }
        const rest = trimSpaces(current);
        if (rest === "") {
          // A blank line between items keeps one list (numbering goes on).
          let after = index + 1;
          while (after < lines.length && trimSpaces(lines[after]!) === "") after += 1;
          if (after < lines.length && listEntry(lines[after]!) !== null) {
            index = after;
            continue;
          }
          break;
        }
        // An indented line under an item goes on with it.
        const last = entries[entries.length - 1];
        if (last !== undefined && indentOf(current).columns >= 2 && openingFence(current) === null) {
          last.text += " " + rest;
          index += 1;
          continue;
        }
        break;
      }
      let at = 0;
      while (at < entries.length) {
        const built = buildList(entries, at, 0);
        blocks.push(built.block);
        at = built.next;
      }
      continue;
    }

    if (trimmed.startsWith(">") && depth < maxQuoteDepth) {
      flush();
      const quoted: string[] = [];
      while (index < lines.length) {
        const current = trimSpaces(lines[index]!);
        if (!current.startsWith(">")) break;
        quoted.push(current.startsWith("> ") ? current.slice(2) : current.slice(1));
        index += 1;
      }
      blocks.push({ type: "quote", blocks: parseBlocks(quoted, depth + 1) });
      continue;
    }

    paragraph.push(trimmed);
    index += 1;
  }
  flush();
  return blocks;
}

// MARK: - inlines

interface InlineNode {
  value: MdInline;
  /** Wrappers above the deepest leaf inside (a leaf is 0). */
  depth: number;
  prev: InlineNode | null;
  next: InlineNode | null;
}

interface Delimiter {
  readonly char: string;
  count: number;
  readonly original: number;
  readonly canOpen: boolean;
  readonly canClose: boolean;
  readonly node: InlineNode;
  prev: Delimiter | null;
  next: Delimiter | null;
}

interface Bracket {
  readonly node: InlineNode;
  readonly bottom: Delimiter | null;
  readonly image: boolean;
  readonly index: number;
}

interface Destination {
  readonly href: string;
  readonly end: number;
}

const backslash = 0x5c;
const backtick = 0x60;
const star = 0x2a;
const underscore = 0x5f;
const tilde = 0x7e;
const bang = 0x21;
const openBracket = 0x5b;
const closeBracket = 0x5d;
const lessThan = 0x3c;
const newline = 0x0a;
const lowerH = 0x68;
const upperH = 0x48;

const special = new Uint8Array(128);
for (const code of [backslash, backtick, star, underscore, tilde, bang, openBracket, closeBracket, lessThan, newline, lowerH, upperH]) {
  special[code] = 1;
}

/** Backslash escapes in a link destination. */
function unescape(text: string): string {
  let out = "";
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    const next = text[index + 1];
    if (char === "\\" && next !== undefined && asciiPunctuation.includes(next)) {
      out += next;
      index += 1;
    } else {
      out += char;
    }
  }
  return out;
}

/** `(dest)`, `(<dest>)` or `(dest "title")` right after a `]`; bounded scans. */
function destinationAt(source: string, open: number): Destination | null {
  if (source.charCodeAt(open) !== 0x28) return null;
  let index = open + 1;
  const limit = Math.min(source.length, open + 1 + maxDestination);
  while (index < limit && isSpaceOrTab(source.charCodeAt(index))) index += 1;
  let href: string;
  if (source[index] === "<") {
    const start = index + 1;
    index = start;
    while (index < limit && source[index] !== ">" && source[index] !== "<" && source[index] !== "\n") index += 1;
    if (source[index] !== ">") return null;
    href = source.slice(start, index);
    index += 1;
  } else {
    const start = index;
    let depth = 0;
    while (index < limit) {
      const char = source[index]!;
      if (isWhitespace(char) || char === "<" || char === "[" || char === "]" || source.charCodeAt(index) < 0x20) break;
      if (char === "\\" && index + 1 < limit) {
        index += 2;
        continue;
      }
      if (char === "(") depth += 1;
      if (char === ")") {
        if (depth === 0) break;
        depth -= 1;
      }
      index += 1;
    }
    if (depth !== 0) return null;
    href = source.slice(start, index);
  }
  while (index < limit && isSpaceOrTab(source.charCodeAt(index))) index += 1;
  const quote = source[index];
  if (quote === '"' || quote === "'" || quote === "(") {
    const close = quote === "(" ? ")" : quote;
    index += 1;
    while (index < limit && source[index] !== close) {
      if (source[index] === "\\") index += 1;
      index += 1;
    }
    if (source[index] !== close) return null;
    index += 1;
    while (index < limit && isSpaceOrTab(source.charCodeAt(index))) index += 1;
  }
  if (source[index] !== ")") return null;
  return { href: unescape(href), end: index + 1 };
}

/** A bare web URL at `start`: up to whitespace, `<`, `[` or `]`; trailing punctuation and unmatched `)` left out. */
function bareURLEnd(source: string, start: number): number {
  const limit = Math.min(source.length, start + maxDestination);
  let index = start;
  while (index < limit && !isWhitespace(source[index]) && source[index] !== "<" && source[index] !== "[" && source[index] !== "]") index += 1;
  let end = index;
  for (;;) {
    const last = source[end - 1];
    if (last !== undefined && "?!.,:;*_~'\"".includes(last)) {
      end -= 1;
      continue;
    }
    if (last === ")") {
      let opens = 0;
      let closes = 0;
      for (let at = start; at < end; at += 1) {
        if (source[at] === "(") opens += 1;
        else if (source[at] === ")") closes += 1;
      }
      if (closes > opens) {
        end -= 1;
        continue;
      }
    }
    break;
  }
  return end;
}

function startsWithWebScheme(source: string, at: number): number {
  const head = source.slice(at, at + 8).toLowerCase();
  if (head.startsWith("https://")) return 8;
  if (head.startsWith("http://")) return 7;
  return 0;
}

/** Inner links of a link's text become their text (a link is never inside a link). */
function withoutLinks(inlines: readonly MdInline[]): MdInline[] {
  const out: MdInline[] = [];
  for (const inline of inlines) {
    if (inline.type === "link") out.push(...withoutLinks(inline.children));
    else if (inline.type === "strong" || inline.type === "em" || inline.type === "strike") {
      out.push({ type: inline.type, children: withoutLinks(inline.children) });
    } else out.push(inline);
  }
  return out;
}

/** Adjacent text joined, empty text dropped, at every level. */
function normalised(inlines: readonly MdInline[]): MdInline[] {
  const out: MdInline[] = [];
  for (const inline of inlines) {
    if (inline.type === "text") {
      if (inline.text === "") continue;
      const last = out[out.length - 1];
      if (last !== undefined && last.type === "text") out[out.length - 1] = { type: "text", text: last.text + inline.text };
      else out.push(inline);
    } else if (inline.type === "strong" || inline.type === "em" || inline.type === "strike") {
      out.push({ type: inline.type, children: normalised(inline.children) });
    } else if (inline.type === "link") {
      out.push({ type: "link", href: inline.href, children: normalised(inline.children) });
    } else {
      out.push(inline);
    }
  }
  return out;
}

/** The inline parts of one paragraph, heading, list item or cell. */
export function parseInline(source: string): MdInline[] {
  let head: InlineNode | null = null;
  let tail: InlineNode | null = null;
  let delimHead: Delimiter | null = null;
  let delimTail: Delimiter | null = null;
  const brackets: Bracket[] = [];
  /** Brackets below this index are inactive (a link formed after them: links do not nest). */
  let activeFloor = 0;

  const append = (value: MdInline, depth = 0): InlineNode => {
    const node: InlineNode = { value, depth, prev: tail, next: null };
    if (tail === null) head = node;
    else tail.next = node;
    tail = node;
    return node;
  };
  const removeNode = (node: InlineNode): void => {
    if (node.prev === null) head = node.next;
    else node.prev.next = node.next;
    if (node.next === null) tail = node.prev;
    else node.next.prev = node.prev;
  };
  const addDelimiter = (delimiter: Delimiter): void => {
    delimiter.prev = delimTail;
    if (delimTail === null) delimHead = delimiter;
    else delimTail.next = delimiter;
    delimTail = delimiter;
  };
  const removeDelimiter = (delimiter: Delimiter): void => {
    if (delimiter.prev === null) delimHead = delimiter.next;
    else delimiter.prev.next = delimiter.next;
    if (delimiter.next === null) delimTail = delimiter.prev;
    else delimiter.next.prev = delimiter.prev;
    delimiter.prev = null;
    delimiter.next = null;
  };

  /** Wraps the nodes strictly between `start` and `end`; past the depth cap they stay as they are. */
  const wrap = (start: InlineNode, end: InlineNode, type: "strong" | "em" | "strike"): void => {
    const children: MdInline[] = [];
    let depth = 0;
    for (let node = start.next; node !== null && node !== end; node = node.next) {
      children.push(node.value);
      depth = Math.max(depth, node.depth);
    }
    if (depth + 1 > maxInlineDepth) return;
    const wrapper: InlineNode = { value: { type, children }, depth: depth + 1, prev: start, next: end };
    start.next = wrapper;
    end.prev = wrapper;
  };

  /** CommonMark's process_emphasis over the delimiters above `bottom`. */
  const processEmphasis = (bottom: Delimiter | null): void => {
    const openersBottom = new Map<string, Delimiter | null>();
    let closer: Delimiter | null = bottom === null ? delimHead : bottom.next;
    while (closer !== null) {
      if (!closer.canClose) {
        closer = closer.next;
        continue;
      }
      const key = closer.char + (closer.canOpen ? "1" : "0") + String(closer.original % 3);
      const stored = openersBottom.get(key);
      const limit = stored === undefined ? bottom : stored;
      let opener: Delimiter | null = closer.prev;
      let found: Delimiter | null = null;
      while (opener !== null && opener !== bottom && opener !== limit) {
        if (opener.char === closer.char && opener.canOpen) {
          if (closer.char === "~") {
            found = opener;
            break;
          }
          const odd =
            (opener.canClose || closer.canOpen) &&
            (opener.original + closer.original) % 3 === 0 &&
            !(opener.original % 3 === 0 && closer.original % 3 === 0);
          if (!odd) {
            found = opener;
            break;
          }
        }
        opener = opener.prev;
      }
      if (found === null) {
        openersBottom.set(key, closer.prev);
        const next: Delimiter | null = closer.next;
        if (!closer.canOpen) removeDelimiter(closer);
        closer = next;
        continue;
      }
      const use = closer.char === "~" ? 2 : found.count >= 2 && closer.count >= 2 ? 2 : 1;
      const type = closer.char === "~" ? "strike" : use === 2 ? "strong" : "em";
      found.count -= use;
      closer.count -= use;
      found.node.value = { type: "text", text: found.char.repeat(found.count) };
      closer.node.value = { type: "text", text: closer.char.repeat(closer.count) };
      for (let between = closer.prev; between !== null && between !== found; ) {
        const previous: Delimiter | null = between.prev;
        removeDelimiter(between);
        between = previous;
      }
      wrap(found.node, closer.node, type);
      if (found.count === 0) {
        removeNode(found.node);
        removeDelimiter(found);
      }
      if (closer.count === 0) {
        const next: Delimiter | null = closer.next;
        removeNode(closer.node);
        removeDelimiter(closer);
        closer = next;
      }
    }
    while (delimTail !== null && delimTail !== bottom) removeDelimiter(delimTail);
  };

  // Code spans: every backtick run is recorded once, so finding a closer stays linear.
  const runs = new Map<number, number[]>();
  let scanned = 0;
  let scannedAll = false;
  const closingRun = (from: number, length: number): number => {
    const known = runs.get(length);
    if (known !== undefined) {
      let low = 0;
      let high = known.length;
      while (low < high) {
        const mid = (low + high) >> 1;
        if (known[mid]! < from) low = mid + 1;
        else high = mid;
      }
      if (low < known.length) return known[low]!;
    }
    if (scannedAll) return -1;
    let index = Math.max(scanned, from);
    while (index < source.length) {
      if (source.charCodeAt(index) !== backtick) {
        index += 1;
        continue;
      }
      const start = index;
      while (index < source.length && source.charCodeAt(index) === backtick) index += 1;
      const size = index - start;
      const list = runs.get(size);
      if (list === undefined) runs.set(size, [start]);
      else list.push(start);
      scanned = index;
      if (size === length) return start;
    }
    scanned = source.length;
    scannedAll = true;
    return -1;
  };

  let textStart = 0;
  let index = 0;
  const flushText = (): void => {
    if (index > textStart) append({ type: "text", text: source.slice(textStart, index) });
  };

  while (index < source.length) {
    const code = source.charCodeAt(index);
    if (code >= 128 || special[code] !== 1) {
      index += 1;
      continue;
    }
    switch (code) {
      case backslash: {
        const next = source[index + 1];
        if (next === "\n") {
          flushText();
          append({ type: "break" });
          index += 2;
          textStart = index;
        } else if (next !== undefined && asciiPunctuation.includes(next)) {
          flushText();
          append({ type: "text", text: next });
          index += 2;
          textStart = index;
        } else {
          index += 1;
        }
        break;
      }
      case backtick: {
        let end = index;
        while (end < source.length && source.charCodeAt(end) === backtick) end += 1;
        const length = end - index;
        const close = closingRun(end, length);
        if (close < 0) {
          index = end; // literal backticks
          break;
        }
        flushText();
        let text = source.slice(end, close).replace(/\n/g, " ");
        if (text.length >= 2 && text.startsWith(" ") && text.endsWith(" ") && text.trim() !== "") text = text.slice(1, -1);
        append({ type: "code", text });
        index = close + length;
        textStart = index;
        break;
      }
      case star:
      case underscore:
      case tilde: {
        const char = source[index]!;
        let end = index;
        while (end < source.length && source[end] === char) end += 1;
        const length = end - index;
        const before = index === 0 ? undefined : source[index - 1];
        const after = source[end];
        const leftFlanking = !isWhitespace(after) && (!isPunctuation(after) || isWhitespace(before) || isPunctuation(before));
        const rightFlanking = !isWhitespace(before) && (!isPunctuation(before) || isWhitespace(after) || isPunctuation(after));
        let canOpen = leftFlanking;
        let canClose = rightFlanking;
        if (char === "_") {
          canOpen = leftFlanking && (!rightFlanking || isPunctuation(before));
          canClose = rightFlanking && (!leftFlanking || isPunctuation(after));
        }
        if ((char === "~" && length !== 2) || (!canOpen && !canClose)) {
          index = end;
          break;
        }
        flushText();
        const node = append({ type: "text", text: source.slice(index, end) });
        addDelimiter({ char, count: length, original: length, canOpen, canClose, node, prev: null, next: null });
        index = end;
        textStart = index;
        break;
      }
      case bang: {
        if (source.charCodeAt(index + 1) !== openBracket) {
          index += 1;
          break;
        }
        flushText();
        const node = append({ type: "text", text: "![" });
        brackets.push({ node, bottom: delimTail, image: true, index: brackets.length });
        index += 2;
        textStart = index;
        break;
      }
      case openBracket: {
        flushText();
        const node = append({ type: "text", text: "[" });
        brackets.push({ node, bottom: delimTail, image: false, index: brackets.length });
        index += 1;
        textStart = index;
        break;
      }
      case closeBracket: {
        flushText();
        const opener = brackets[brackets.length - 1];
        const destination = opener === undefined || opener.index < activeFloor ? null : destinationAt(source, index + 1);
        if (opener === undefined || destination === null) {
          if (opener !== undefined) brackets.pop();
          append({ type: "text", text: "]" });
          index += 1;
          textStart = index;
          break;
        }
        processEmphasis(opener.bottom);
        const children: MdInline[] = [];
        const nodes: InlineNode[] = [];
        let depth = 0;
        for (let node = opener.node.next; node !== null; node = node.next) {
          children.push(node.value);
          nodes.push(node);
          depth = Math.max(depth, node.depth);
        }
        // Drop the bracket and its text from the list, then put back a link (or, for a
        // link that is not to the web or past the depth cap, the text alone).
        tail = opener.node.prev;
        if (tail === null) head = null;
        else tail.next = null;
        if (isWebLink(destination.href) && depth + 1 <= maxInlineDepth) {
          append({ type: "link", href: destination.href, children: withoutLinks(children) }, depth + 1);
        } else {
          for (const node of nodes) append(node.value, node.depth);
        }
        brackets.pop();
        if (!opener.image) activeFloor = brackets.length;
        index = destination.end;
        textStart = index;
        break;
      }
      case lessThan: {
        const scheme = startsWithWebScheme(source, index + 1);
        if (scheme === 0) {
          index += 1;
          break;
        }
        const limit = Math.min(source.length, index + 1 + maxDestination);
        let end = index + 1 + scheme;
        while (end < limit && source[end] !== ">" && source[end] !== "<" && !isWhitespace(source[end])) end += 1;
        if (source[end] !== ">" || end === index + 1 + scheme) {
          index += 1;
          break;
        }
        flushText();
        const href = source.slice(index + 1, end);
        append({ type: "link", href, children: [{ type: "text", text: href }] }, 1);
        index = end + 1;
        textStart = index;
        break;
      }
      case newline: {
        flushText();
        append({ type: "break" });
        index += 1;
        while (index < source.length && isSpaceOrTab(source.charCodeAt(index))) index += 1;
        textStart = index;
        break;
      }
      default: {
        // h / H: a bare web URL at a word start.
        const before = index === 0 ? undefined : source[index - 1];
        const atStart = before === undefined || isWhitespace(before) || "(*_~\"'".includes(before);
        const scheme = atStart ? startsWithWebScheme(source, index) : 0;
        if (scheme === 0) {
          index += 1;
          break;
        }
        const end = bareURLEnd(source, index);
        if (end <= index + scheme) {
          index += 1;
          break;
        }
        flushText();
        const href = source.slice(index, end);
        append({ type: "link", href, children: [{ type: "text", text: href }] }, 1);
        index = end;
        textStart = index;
        break;
      }
    }
  }
  flushText();
  processEmphasis(null);

  const out: MdInline[] = [];
  // `head` is set inside the closures above, which flow analysis does not follow.
  for (let node = head as InlineNode | null; node !== null; node = node.next) out.push(node.value);
  return normalised(out);
}

/** A block's plain text (for Copy of a whole reply part). */
export function inlineText(inlines: readonly MdInline[]): string {
  let out = "";
  for (const inline of inlines) {
    switch (inline.type) {
      case "text":
      case "code":
        out += inline.text;
        break;
      case "break":
        out += "\n";
        break;
      default:
        out += inlineText(inline.children);
    }
  }
  return out;
}

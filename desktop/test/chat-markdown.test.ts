// The Chat view's markdown reader (src/shared/chat/markdown.ts): the block
// rules of App/CompanionChatMarkdown.swift, CommonMark's inline rules, and
// bounded work on hostile input.

import { describe, expect, it } from "vitest";

import { inlineText, maxInlineDepth, parseInline, parseMarkdown, type MdBlock, type MdInline } from "../src/shared/chat/markdown";

const text = (value: string): MdInline => ({ type: "text", text: value });
const paragraph = (...inlines: MdInline[]): MdBlock => ({ type: "paragraph", inlines });

/** The deepest wrapper nesting in a tree of inlines. */
function depthOf(inlines: readonly MdInline[]): number {
  let deepest = 0;
  for (const inline of inlines) {
    if (inline.type === "strong" || inline.type === "em" || inline.type === "strike" || inline.type === "link") {
      deepest = Math.max(deepest, 1 + depthOf(inline.children));
    }
  }
  return deepest;
}

function allInlines(blocks: readonly MdBlock[]): MdInline[] {
  return blocks.flatMap((block) => {
    switch (block.type) {
      case "paragraph":
      case "heading":
        return [...block.inlines];
      case "list":
        return block.items.flatMap((item) => allInlines(item));
      case "quote":
        return allInlines(block.blocks);
      case "table":
        return [...block.head.flat(), ...block.rows.flat(2)];
      default:
        return [];
    }
  });
}

describe("blocks", () => {
  it("keeps a paragraph's line breaks and splits paragraphs at blank lines", () => {
    expect(parseMarkdown("One line\nand the next\n\nA second paragraph")).toEqual([
      paragraph(text("One line"), { type: "break" }, text("and the next")),
      paragraph(text("A second paragraph")),
    ]);
  });

  it("reads ATX headings one to six, with a space after the hashes", () => {
    expect(parseMarkdown("# One\n### Three ###\n###### Six\n####### Seven\n#tag")).toEqual([
      { type: "heading", level: 1, inlines: [text("One")] },
      { type: "heading", level: 3, inlines: [text("Three")] },
      { type: "heading", level: 6, inlines: [text("Six")] },
      paragraph(text("####### Seven"), { type: "break" }, text("#tag")),
    ]);
    expect(parseMarkdown("## Fix in C#")).toEqual([{ type: "heading", level: 2, inlines: [text("Fix in C#")] }]);
  });

  it("reads a fenced code block with its language, and one without", () => {
    const source = "Before\n```swift\nlet x = 1\n\n  print(x)\n```\n~~~\nplain *not emphasis*\n~~~\nAfter";
    expect(parseMarkdown(source)).toEqual([
      paragraph(text("Before")),
      { type: "code", language: "swift", text: "let x = 1\n\n  print(x)" },
      { type: "code", language: null, text: "plain *not emphasis*" },
      paragraph(text("After")),
    ]);
  });

  it("takes the info string's first word as the language and needs a long enough closing fence", () => {
    expect(parseMarkdown("````ts title=a.ts\nconst a = 1;\n```\nstill code\n````")).toEqual([
      { type: "code", language: "ts", text: "const a = 1;\n```\nstill code" },
    ]);
  });

  it("runs an unclosed fence to the end", () => {
    expect(parseMarkdown("Text\n```bash\nmake\nmake test")).toEqual([
      paragraph(text("Text")),
      { type: "code", language: "bash", text: "make\nmake test" },
    ]);
  });

  it("keeps a code block's shape under an indented fence", () => {
    expect(parseMarkdown("  ```\n  if a {\n      b()\n  }\n  ```")).toEqual([{ type: "code", language: null, text: "if a {\n    b()\n}" }]);
  });

  it("does not take inline code on one line for a fence", () => {
    expect(parseMarkdown("```inline``` code")).toEqual([paragraph({ type: "code", text: "inline" }, text(" code"))]);
  });

  it("reads rules of - * _ with spaces between", () => {
    expect(parseMarkdown("a\n---\nb\n* * *\n___")).toEqual([paragraph(text("a")), { type: "rule" }, paragraph(text("b")), { type: "rule" }, { type: "rule" }]);
  });

  it("reads bullet and numbered lists with nesting and continuation lines", () => {
    const source = ["- one", "  goes on", "- two", "  - nested a", "  - nested b", "    1. deeper", "- three", "", "3. first", "4) second"].join("\n");
    const item = (value: string, ...nested: MdBlock[]): MdBlock[] => [paragraph(text(value)), ...nested];
    expect(parseMarkdown(source)).toEqual([
      {
        type: "list",
        ordered: false,
        start: 1,
        items: [
          item("one goes on"),
          item("two", {
            type: "list",
            ordered: false,
            start: 1,
            items: [item("nested a"), item("nested b", { type: "list", ordered: true, start: 1, items: [item("deeper")] })],
          }),
          item("three"),
        ],
      },
      { type: "list", ordered: true, start: 3, items: [item("first"), item("second")] },
    ]);
  });

  it("keeps a list with blank lines between its items as one list", () => {
    const blocks = parseMarkdown("1. a\n\n2. b\n\n\n3. c\n\nAfter");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ type: "list", ordered: true, start: 1 });
    expect(blocks[0]?.type === "list" ? blocks[0].items : []).toHaveLength(3);
    expect(blocks[1]).toEqual(paragraph(text("After")));
  });

  it("starts a list mid-paragraph and needs text after the marker", () => {
    expect(parseMarkdown("Steps:\n- run\n-\n1.")).toEqual([
      paragraph(text("Steps:")),
      { type: "list", ordered: false, start: 1, items: [[paragraph(text("run"))]] },
      paragraph(text("-"), { type: "break" }, text("1.")),
    ]);
    expect(parseMarkdown("2024. was long")).toEqual([paragraph(text("2024. was long"))]);
  });

  it("reads quotes, nested quotes and blocks inside them", () => {
    expect(parseMarkdown("> Quoted **bold**\n> - item\n>> deeper\nafter")).toEqual([
      {
        type: "quote",
        blocks: [
          paragraph(text("Quoted "), { type: "strong", children: [text("bold")] }),
          { type: "list", ordered: false, start: 1, items: [[paragraph(text("item"))]] },
          { type: "quote", blocks: [paragraph(text("deeper"))] },
        ],
      },
      paragraph(text("after")),
    ]);
  });

  it("reads a table with its alignment, inline cells and escaped pipes", () => {
    const source = "| File | Lines | Note |\n|:-----|------:|:----:|\n| `a.ts` | 12 | **new** |\n| b\\|c | 3 |\nafter";
    expect(parseMarkdown(source)).toEqual([
      {
        type: "table",
        align: ["left", "right", "center"],
        head: [[text("File")], [text("Lines")], [text("Note")]],
        rows: [
          [[{ type: "code", text: "a.ts" }], [text("12")], [{ type: "strong", children: [text("new")] }]],
          [[text("b|c")], [text("3")]],
        ],
      },
      paragraph(text("after")),
    ]);
  });

  it("reads CRLF and CR line ends like LF", () => {
    const lf = parseMarkdown("# Title\n\nText\nmore\n```\ncode\n```\n- a\n- b");
    expect(parseMarkdown("# Title\r\n\r\nText\r\nmore\r\n```\r\ncode\r\n```\r\n- a\r\n- b")).toEqual(lf);
    expect(parseMarkdown("# Title\r\rText\rmore\r```\rcode\r```\r- a\r- b")).toEqual(lf);
  });

  it("returns nothing for an empty or blank reply", () => {
    expect(parseMarkdown("")).toEqual([]);
    expect(parseMarkdown("  \n\t\n")).toEqual([]);
  });
});

describe("inlines", () => {
  it("reads code spans of any backtick count, trimming one space each side", () => {
    expect(parseInline("run `swift test` now")).toEqual([text("run "), { type: "code", text: "swift test" }, text(" now")]);
    expect(parseInline("`` a ` b ``")).toEqual([{ type: "code", text: "a ` b" }]);
    expect(parseInline("``` ``` ")).toEqual([{ type: "code", text: " " }, text(" ")]);
    expect(parseInline("an ` unmatched")).toEqual([text("an ` unmatched")]);
    expect(parseInline("`*not em*`")).toEqual([{ type: "code", text: "*not em*" }]);
  });

  it("reads strong, emphasis and strike, nested", () => {
    expect(parseInline("**bold** and *it* and __b__ and _i_ and ~~gone~~")).toEqual([
      { type: "strong", children: [text("bold")] },
      text(" and "),
      { type: "em", children: [text("it")] },
      text(" and "),
      { type: "strong", children: [text("b")] },
      text(" and "),
      { type: "em", children: [text("i")] },
      text(" and "),
      { type: "strike", children: [text("gone")] },
    ]);
    expect(parseInline("***both***")).toEqual([{ type: "em", children: [{ type: "strong", children: [text("both")] }] }]);
    expect(parseInline("**a *b* c**")).toEqual([{ type: "strong", children: [text("a "), { type: "em", children: [text("b")] }, text(" c")] }]);
  });

  it("leaves intraword underscores, lone stars and single tildes as text", () => {
    expect(parseInline("snake_case_name and file_v2_final.txt")).toEqual([text("snake_case_name and file_v2_final.txt")]);
    expect(parseInline("2 * 3 * 4")).toEqual([text("2 * 3 * 4")]);
    expect(parseInline("~/proj and ~~~ and ~x~")).toEqual([text("~/proj and ~~~ and ~x~")]);
    expect(parseInline("un*frigging*believable")).toEqual([text("un"), { type: "em", children: [text("frigging")] }, text("believable")]);
  });

  it("reads web links, autolinks and bare URLs, and keeps other links as their text", () => {
    expect(parseInline("see [the docs](https://ghostty.org/docs) now")).toEqual([
      text("see "),
      { type: "link", href: "https://ghostty.org/docs", children: [text("the docs")] },
      text(" now"),
    ]);
    expect(parseInline('[a](https://x.dev/a_(b) "title")')).toEqual([{ type: "link", href: "https://x.dev/a_(b)", children: [text("a")] }]);
    expect(parseInline("<https://example.com/a?b=1>")).toEqual([
      { type: "link", href: "https://example.com/a?b=1", children: [text("https://example.com/a?b=1")] },
    ]);
    expect(parseInline("Open https://example.com/x_y. Then (http://a.b/c).")).toEqual([
      text("Open "),
      { type: "link", href: "https://example.com/x_y", children: [text("https://example.com/x_y")] },
      text(". Then ("),
      { type: "link", href: "http://a.b/c", children: [text("http://a.b/c")] },
      text(")."),
    ]);
    expect(parseInline("[file](./src/a.ts) and [run](javascript:alert(1))")).toEqual([text("file and run")]);
    expect(parseInline("[not a link] (https://x.dev)")).toEqual([
      text("[not a link] ("),
      { type: "link", href: "https://x.dev", children: [text("https://x.dev")] },
      text(")"),
    ]);
  });

  it("does not nest links, and keeps emphasis inside a link", () => {
    expect(parseInline("[**b** https://in.side](https://out.side)")).toEqual([
      { type: "link", href: "https://out.side", children: [{ type: "strong", children: [text("b")] }, text(" https://in.side")] },
    ]);
    expect(parseInline("[a [b](https://b.dev) c](https://a.dev)")).toEqual([
      text("[a "),
      { type: "link", href: "https://b.dev", children: [text("b")] },
      text(" c]("),
      { type: "link", href: "https://a.dev", children: [text("https://a.dev")] },
      text(")"),
    ]);
  });

  it("shows an image as a link to it, never loading it", () => {
    expect(parseInline("![shot](https://x.dev/a.png)")).toEqual([{ type: "link", href: "https://x.dev/a.png", children: [text("shot")] }]);
  });

  it("shows raw HTML as text", () => {
    const html = '<script>alert("x")</script> <img src=x onerror=alert(1)> <b>bold</b>';
    expect(parseInline(html)).toEqual([text(html)]);
    expect(parseMarkdown("<div>\n<b>hi</b>\n</div>")).toEqual([
      paragraph(text("<div>"), { type: "break" }, text("<b>hi</b>"), { type: "break" }, text("</div>")),
    ]);
  });

  it("reads backslash escapes and a backslash line break", () => {
    expect(parseInline("\\*not em\\* and \\_x\\_ and \\`y\\` and C:\\path")).toEqual([text("*not em* and _x_ and `y` and C:\\path")]);
    expect(parseMarkdown("one\\\ntwo")).toEqual([paragraph(text("one"), { type: "break" }, text("two"))]);
  });

  it("gives a block's plain text", () => {
    expect(inlineText(parseInline("**a** `b` [c](https://c.dev)\nd"))).toBe("a b c\nd");
  });
});

describe("bounded work", () => {
  // Each input parses in well under 100 ms alone; the bound is wider so a busy
  // machine running every suite at once does not fail it, and still catches
  // backtracking that grows with the input (seconds, not milliseconds).
  const budgetMs = 750;
  const time = (run: () => void): number => {
    const start = performance.now();
    run();
    return performance.now() - start;
  };

  it("reads 200 KB of hostile input quickly", () => {
    const inputs = [
      "*".repeat(200_000),
      "[".repeat(200_000),
      "[a](".repeat(50_000),
      "*a ".repeat(66_000),
      "_a ".repeat(66_000),
      "a*".repeat(100_000),
      "**a ".repeat(25_000) + "*".repeat(100_000),
      "*_".repeat(50_000) + "a" + "_*".repeat(50_000),
      "` ``".repeat(50_000),
      "`".repeat(50_000) + "a" + "``".repeat(50_000),
      "<https://".repeat(22_000),
      "https://a ".repeat(20_000),
      "\\".repeat(200_000),
      "> ".repeat(100_000),
      Array.from({ length: 400 }, (_, i) => " ".repeat(i) + "- item").join("\n"),
      Array.from({ length: 20_000 }, () => "| a | b |").join("\n"),
      " ".repeat(200_000) + "x",
      "](".repeat(100_000),
    ];
    // One warm-up so the first case does not pay for compiling the parser.
    parseMarkdown(inputs.join("\n").slice(0, 10_000));
    for (const input of inputs) {
      const elapsed = time(() => parseMarkdown(input));
      expect(elapsed, input.slice(0, 12)).toBeLessThan(budgetMs);
    }
  });

  it("caps inline nesting", () => {
    const deep = "*_".repeat(5_000) + "a" + "_*".repeat(5_000);
    const blocks = parseMarkdown(deep);
    expect(depthOf(allInlines(blocks))).toBeLessThanOrEqual(maxInlineDepth);
    expect(inlineText(allInlines(blocks))).toContain("a");
  });

  it("caps quote and list nesting", () => {
    const quotes = parseMarkdown(">".repeat(50) + " deep");
    let depth = 0;
    for (let block: MdBlock | undefined = quotes[0]; block?.type === "quote"; block = block.blocks[0]) depth += 1;
    expect(depth).toBeLessThanOrEqual(8);
    const lists = parseMarkdown(Array.from({ length: 40 }, (_, i) => "  ".repeat(i) + "- level " + i).join("\n"));
    let listDepth = 0;
    for (let block: MdBlock | undefined = lists[0]; block?.type === "list"; block = block.items.at(-1)?.at(-1)) listDepth += 1;
    expect(listDepth).toBeLessThanOrEqual(10);
    expect(JSON.stringify(lists)).toContain("level 39");
  });
});

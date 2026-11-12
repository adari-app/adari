// The code block highlighter (src/renderer/chat/highlight.ts): a small,
// bounded tokenizer per language family, lossless (the tokens put together are
// the code), never HTML. Kinds become classes in the Chat view (hl-keyword…).

import { describe, expect, it } from "vitest";

import { codeLanguage, highlight, maxHighlightLength, type CodeToken } from "../src/renderer/chat/highlight";

/** The tokens that are not plain, as "kind:text". */
const marked = (tokens: readonly CodeToken[]): string[] => tokens.filter((t) => t.kind !== "plain" && t.text.trim() !== "").map((t) => `${t.kind}:${t.text}`);
const joined = (tokens: readonly CodeToken[]): string => tokens.map((t) => t.text).join("");

describe("languages", () => {
  it("maps a fence's language to its family, any case, and nothing for text or unknown", () => {
    expect(["ts", "tsx", "TypeScript", "js", "jsx", "mjs", "javascript"].map(codeLanguage)).toEqual(Array(7).fill("js"));
    expect(["swift", "Swift"].map(codeLanguage)).toEqual(["swift", "swift"]);
    expect(["py", "python", "python3"].map(codeLanguage)).toEqual(["python", "python", "python"]);
    expect(["sh", "bash", "zsh", "shell", "console"].map(codeLanguage)).toEqual(Array(5).fill("shell"));
    expect(["json", "jsonc", "yaml", "yml", "diff", "patch", "html", "xml", "css", "sql", "rust", "rs", "go"].map(codeLanguage)).toEqual([
      "json",
      "json",
      "yaml",
      "yaml",
      "diff",
      "diff",
      "markup",
      "markup",
      "css",
      "sql",
      "rust",
      "rust",
      "go",
    ]);
    expect([null, "", "text", "txt", "plaintext", "markdown", "brainfuck"].map(codeLanguage)).toEqual(Array(7).fill(null));
  });

  it("leaves code with no known language as one plain run", () => {
    expect(highlight("let x = 1 // not read", null)).toEqual([{ kind: "plain", text: "let x = 1 // not read" }]);
    expect(highlight("whatever", "cobol")).toEqual([{ kind: "plain", text: "whatever" }]);
  });
});

describe("tokens", () => {
  it("reads TypeScript: keywords, strings, template strings, numbers, comments, calls and types", () => {
    const code = 'const total: Total = sum(items, 0x1F) + 2.5e3; // add\nreturn `${total}` /* done */';
    const tokens = highlight(code, "ts");
    expect(joined(tokens)).toBe(code);
    expect(marked(tokens)).toEqual([
      "keyword:const",
      "punct::",
      "type:Total",
      "punct:=",
      "function:sum",
      "punct:(",
      "punct:,",
      "number:0x1F",
      "punct:)",
      "punct:+",
      "number:2.5e3",
      "punct:;",
      "comment:// add",
      "keyword:return",
      "string:`${total}`",
      "comment:/* done */",
    ]);
  });

  it("reads Swift with attributes, nil and multi-line strings", () => {
    const code = '@MainActor func greet(_ name: String?) -> String {\n  guard let name else { return nil }\n  return """\n  Hi \\(name)\n  """\n}';
    const tokens = highlight(code, "swift");
    expect(joined(tokens)).toBe(code);
    const kinds = marked(tokens);
    expect(kinds).toContain("meta:@MainActor");
    expect(kinds).toContain("keyword:func");
    expect(kinds).toContain("function:greet");
    expect(kinds).toContain("type:String");
    expect(kinds).toContain("keyword:guard");
    expect(kinds).toContain("literal:nil");
    expect(kinds).toContain('string:"""\n  Hi \\(name)\n  """');
  });

  it("reads Python with # comments, triple-quoted strings and literals", () => {
    const code = 'def area(r):\n    """Circle."""\n    return 3.14 * r ** 2  # pi r squared\nprint(area(2), None)';
    const kinds = marked(highlight(code, "python"));
    expect(kinds).toEqual(
      expect.arrayContaining(['keyword:def', 'function:area', 'string:"""Circle."""', "keyword:return", "number:3.14", "comment:# pi r squared", "function:print", "literal:None"]),
    );
  });

  it("reads shell: the command at each command position, flags, variables and comments only after a space", () => {
    const code = 'npm test -- --filter "Chat view" # run it\nFOO=1 echo $HOME ${PATH} a#b | grep -n x && git status';
    const tokens = highlight(code, "bash");
    expect(joined(tokens)).toBe(code);
    const kinds = marked(tokens);
    expect(kinds).toEqual(
      expect.arrayContaining(["function:npm", 'string:"Chat view"', "comment:# run it", "variable:$HOME", "variable:${PATH}", "function:grep", "function:git"]),
    );
    expect(kinds).not.toContain("comment:#b | grep -n x && git status");
    expect(kinds.filter((k) => k.startsWith("comment:"))).toEqual(["comment:# run it"]);
  });

  it("reads JSON keys as properties and values as strings, numbers and literals", () => {
    const code = '{"name": "herdr", "port": 22, "ok": true, "none": null}';
    expect(marked(highlight(code, "json"))).toEqual([
      "punct:{",
      'property:"name"',
      "punct::",
      'string:"herdr"',
      "punct:,",
      'property:"port"',
      "punct::",
      "number:22",
      "punct:,",
      'property:"ok"',
      "punct::",
      "literal:true",
      "punct:,",
      'property:"none"',
      "punct::",
      "literal:null",
      "punct:}",
    ]);
  });

  it("reads YAML keys, comments and values", () => {
    const kinds = marked(highlight("name: herdr # the app\nport: 22\nlive: true\n- 'quoted'", "yaml"));
    expect(kinds).toEqual(expect.arrayContaining(["property:name", "comment:# the app", "property:port", "number:22", "literal:true", "string:'quoted'"]));
  });

  it("reads a diff by its lines", () => {
    const code = "--- a/x.ts\n+++ b/x.ts\n@@ -1,2 +1,2 @@\n-old line\n+new line\n context";
    const tokens = highlight(code, "diff");
    expect(joined(tokens)).toBe(code);
    expect(marked(tokens)).toEqual(["meta:--- a/x.ts\n", "meta:+++ b/x.ts\n", "meta:@@ -1,2 +1,2 @@\n", "del:-old line\n", "add:+new line\n"]);
  });

  it("reads markup tags, attributes, strings and comments", () => {
    const code = '<!-- note --><a href="/x" data-on>Link</a>';
    const tokens = highlight(code, "html");
    expect(joined(tokens)).toBe(code);
    expect(marked(tokens)).toEqual(["comment:<!-- note -->", "punct:<", "tag:a", "attr:href", "punct:=", 'string:"/x"', "attr:data-on", "punct:>", "punct:</", "tag:a", "punct:>"]);
  });

  it("reads CSS properties, numbers with units, colours and at-rules", () => {
    const kinds = marked(highlight("@media (min-width: 640px) { .a { color: #fff; margin: 0 4px; } } /* c */", "css"));
    expect(kinds).toEqual(expect.arrayContaining(["meta:@media", "property:min-width", "number:640px", "property:color", "number:#fff", "number:4px", "comment:/* c */"]));
  });

  it("reads SQL keywords in any case", () => {
    const kinds = marked(highlight("select id from panes where name = 'x' -- one\nORDER BY id", "sql"));
    expect(kinds).toEqual(expect.arrayContaining(["keyword:select", "keyword:from", "keyword:where", "string:'x'", "comment:-- one", "keyword:ORDER", "keyword:BY"]));
  });

  it("keeps Rust lifetimes out of strings", () => {
    const code = "fn first<'a>(s: &'a str) -> char { 'x' }";
    const tokens = highlight(code, "rust");
    expect(joined(tokens)).toBe(code);
    expect(marked(tokens)).toContain("string:'x'");
    expect(marked(tokens).filter((k) => k.startsWith("string:"))).toEqual(["string:'x'"]);
  });

  it("ends an unclosed one-line string at the line's end", () => {
    const tokens = highlight('let a = "open\nlet b = 2', "js");
    expect(marked(tokens)).toEqual(expect.arrayContaining(['string:"open', "keyword:let", "number:2"]));
  });
});

describe("bounded work", () => {
  const budgetMs = 750;
  const time = (run: () => void): number => {
    const start = performance.now();
    run();
    return performance.now() - start;
  };

  it("tokenizes hostile input quickly and losslessly in every family", () => {
    const families = ["js", "swift", "python", "shell", "json", "yaml", "diff", "markup", "css", "sql", "rust", "go"];
    const inputs = [
      '"'.repeat(60_000),
      "/*".repeat(30_000),
      "'".repeat(60_000),
      "<".repeat(60_000),
      "$" + "{".repeat(60_000),
      "a(".repeat(30_000),
      "1.".repeat(30_000),
      "\\".repeat(60_000),
      '"""'.repeat(20_000),
      "<!--".repeat(15_000),
    ];
    highlight(inputs.join("\n").slice(0, 5_000), "js");
    for (const family of families) {
      for (const input of inputs) {
        let tokens: CodeToken[] = [];
        const elapsed = time(() => {
          tokens = highlight(input, family);
        });
        expect(elapsed, `${family} ${input.slice(0, 6)}`).toBeLessThan(budgetMs);
        expect(joined(tokens)).toBe(input);
      }
    }
  });

  it("shows code longer than the cap plain", () => {
    const long = "const a = 1;\n".repeat(Math.ceil(maxHighlightLength / 13) + 1);
    expect(long.length).toBeGreaterThan(maxHighlightLength);
    expect(highlight(long, "ts")).toEqual([{ kind: "plain", text: long }]);
  });
});

// Chat's type and spacing at T3 Code's bar. The real
// components rendered to static markup (react-dom/server, no DOM), and the
// style sheets' contract: the reading column, body size and line height, the user's
// bubble, bold only where the reply bolds, quiet tool rows, code blocks with a
// header (language, Wrap, Copy) and highlighted tokens, the "Worked for" row.

import { readFileSync } from "node:fs";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Turn } from "../src/renderer/chat/ChatView";
import { Markdown } from "../src/renderer/chat/Markdown";
import { ToolRow } from "../src/renderer/chat/ToolRows";
import { reply, result, timelineOf, tool, user } from "./support/chat-lines";

const css = (name: string): string => readFileSync(new URL(`../src/renderer/styles/${name}`, import.meta.url), "utf8");
const sheets = (): string => ["tokens.css", "app.css", "chat.css", "markdown.css"].map(css).join("\n");

/** The declarations of every rule whose selector list names `selector`, joined. */
function rule(text: string, selector: string): string {
  return [...text.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter((match) => match[1]!.split(",").some((part) => part.trim() === selector))
    .map((match) => match[2]!)
    .join(";");
}

/** One declaration's value in a rule (the last one wins, as in CSS). */
function decl(text: string, selector: string, property: string): string | undefined {
  const found = [...rule(text, selector).matchAll(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, "g"))];
  return found.at(-1)?.[1]?.trim();
}

const noop = (): void => undefined;

describe("the reading column and body type", () => {
  it("reads in a 720 px column at 14 px on a 22.75 px line, the reply at 90% ink", () => {
    const all = sheets();
    expect(decl(all, ":root", "--col")).toBe("720px");
    expect(decl(all, ":root", "--fs-chat")).toBe("14px");
    expect(decl(all, ":root", "--lh-chat")).toBe("22.75px");
    expect(decl(all, ".msg-a", "color")).toBe("var(--ink-reply)");
    expect(decl(all, ":root", "--ink-reply")).toBe("rgba(237, 237, 235, 0.9)");
  });

  it("gives the user's bubble T3's shape: radius 16, padding 12, at most 80% of the column", () => {
    const all = sheets();
    expect(decl(all, ".bubble", "border-radius")).toBe("16px");
    expect(decl(all, ".bubble", "padding")).toBe("12px");
    expect(decl(all, ".bubble", "max-width")).toBe("80%");
  });

  it("bolds only where the reply bolds: tool verbs and folded lines at normal weight", () => {
    const all = sheets();
    expect(decl(all, ".tr .v", "font-weight")).toBe("400");
    expect(decl(all, ".md strong", "font-weight")).toBe("600");
    // No other chat rule sets a weight above normal.
    const weighted = [...css("chat.css").matchAll(/([^{}]+)\{([^}]*font-weight\s*:\s*(\d+)[^}]*)\}/g)]
      .filter((match) => Number(match[3]) > 400)
      .map((match) => match[1]!.trim());
    expect(weighted).toEqual([]);
  });
});

describe("code blocks", () => {
  it("have a header with the language, Wrap and Copy, over a highlighted body", () => {
    const html = renderToStaticMarkup(createElement(Markdown, { source: "```ts\nconst a = 1; // one\n```", onCopy: noop }));
    expect(html).toContain('<div class="md-code-h"><span class="md-code-lang">ts</span>');
    expect(html).toMatch(/<button[^>]*class="md-act"[^>]*aria-pressed="false"[^>]*aria-label="Wrap lines"/);
    expect(html).toMatch(/<button[^>]*class="md-act"[^>]*aria-label="Copy code"/);
    expect(html).toContain(
      '<pre class="md-code-b"><code><span class="hl-keyword">const</span> a <span class="hl-punct">=</span> <span class="hl-number">1</span><span class="hl-punct">;</span> <span class="hl-comment">// one</span></code></pre>',
    );
  });

  it("names a block with no language text and leaves it plain", () => {
    const html = renderToStaticMarkup(createElement(Markdown, { source: "```\nconst a = 1\n```", onCopy: noop }));
    expect(html).toContain('<span class="md-code-lang">text</span>');
    expect(html).toContain("<code>const a = 1</code>");
  });

  it("sit on a borderless fill with an 8 px radius; the body in 12.5 px mono, wrapping when asked", () => {
    const all = sheets();
    expect(decl(all, ".md-code", "border")).toBe("0");
    expect(decl(all, ".md-code", "border-radius")).toBe("8px");
    expect(decl(all, ".md-code-b", "font-size")).toBe("12.5px");
    expect(decl(all, ".md-code-b.wrap", "white-space")).toBe("pre-wrap");
    for (const kind of ["keyword", "string", "number", "comment", "function", "type"]) expect(rule(all, `.hl-${kind}`), kind).toMatch(/color\s*:/);
  });
});

describe("the turn's rows", () => {
  const timeline = timelineOf([
    user("Run the tests", "u1", 0),
    tool("t1", "npm test", "a1", 2),
    result("t1", "ok", "r1", 30),
    reply("All **green**.", "a2", 68, true),
  ]).timeline;

  it("ends a finished turn with a quiet Worked for row and a hairline", () => {
    const html = renderToStaticMarkup(createElement(Turn, { turn: timeline.turns[0]!, onCopy: noop, onMenu: noop }));
    expect(html).toMatch(/<div class="worked"><span class="worked-t">Worked for 1m 8s<\/span><span class="worked-c">[^<]+<\/span><span class="worked-rule"><\/span><\/div>/);
    expect(html).toContain("<strong>green</strong>");
  });

  it("draws tool rows muted: the verb and target in quiet ink, a chevron that turns", () => {
    const call = timeline.turns[0]!.items.find((item) => item.type === "toolCall")!;
    const html = renderToStaticMarkup(createElement(ToolRow, { call: call.value as never }));
    expect(html).toMatch(/<button class="tr open-able"[^>]*aria-expanded="false"/);
    expect(html).toContain('<span class="chev"><svg');
    const all = sheets();
    expect(decl(all, ".tr", "color")).toBe("var(--ink-3)");
    expect(decl(all, ".tr .v", "color")).toBe("var(--ink-3)");
    expect(decl(all, ".tr .chev", "transition")).toMatch(/transform 200ms/);
    expect(decl(all, '.tr[aria-expanded="true"] .chev', "transform")).toBe("rotate(90deg)");
  });
});

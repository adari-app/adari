// Web addresses in the terminal are links. The
// provider (registered with ghostty-web's link detector in place of its own
// URL provider) finds each http or https URL in a row by T3 Code's rules
// (apps/web/src/terminal-links.ts): trailing punctuation off, a closing
// bracket kept only when the URL opened it, a URL soft-wrapped across rows
// whole. ⌘-click opens it through the open-link path; a plain click does not.

import { describe, expect, it } from "vitest";

import {
  extractTerminalUrls,
  isTerminalLinkActivation,
  isTerminalUrl,
  replaceUrlProvider,
  terminalLinkProvider,
  type LinkBuffer,
  type TerminalLink,
} from "../src/renderer/terminal/terminal-links";

const texts = (line: string): string[] => extractTerminalUrls(line).map((match) => match.text);

/** A buffer of fixed-width rows; `wrapped` rows are continuations (the row above soft-wrapped onto them), as ghostty-web marks them. */
function buffer(rows: readonly string[], cols: number, wrapped: readonly number[] = []): LinkBuffer {
  return {
    getLine: (y) => {
      const row = rows[y];
      if (row === undefined) return undefined;
      const chars = Array.from(row.padEnd(cols, "\u0000").slice(0, cols));
      return {
        length: cols,
        isWrapped: wrapped.includes(y),
        getCell: (x) => (x < 0 || x >= cols ? undefined : { getCodepoint: () => chars[x]!.codePointAt(0)! }),
      };
    },
  };
}

function linksOn(source: LinkBuffer, y: number, open: (url: string) => void = () => undefined, platform = "MacIntel"): TerminalLink[] {
  let out: TerminalLink[] | undefined;
  terminalLinkProvider(() => source, open, platform).provideLinks(y, (links) => (out = links));
  return out ?? [];
}

const mouse = (metaKey: boolean, ctrlKey = false) => ({ metaKey, ctrlKey });

describe("URLs in a terminal line", () => {
  it("finds http and https URLs, nothing else", () => {
    expect(texts("Blog slot 2 is live: https://example.invalid/blog/2 and http://a.invalid/x")).toEqual(["https://example.invalid/blog/2", "http://a.invalid/x"]);
    expect(texts("ssh://host/x ftp://a.invalid/f file:///etc/hosts mailto:a@b.invalid www.example.invalid")).toEqual([]);
    expect(texts("no links here")).toEqual([]);
  });

  it("drops trailing punctuation and the brackets the URL did not open (T3's trimClosingDelimiters)", () => {
    expect(texts("See https://example.invalid/a.")).toEqual(["https://example.invalid/a"]);
    expect(texts("Done (https://example.invalid/b), then https://example.invalid/c!?")).toEqual(["https://example.invalid/b", "https://example.invalid/c"]);
    expect(texts("[docs](https://example.invalid/d)")).toEqual(["https://example.invalid/d"]);
    expect(texts("https://en.wikipedia.invalid/wiki/Foo_(bar)")).toEqual(["https://en.wikipedia.invalid/wiki/Foo_(bar)"]);
    expect(texts("{https://example.invalid/e}")).toEqual(["https://example.invalid/e"]);
    expect(texts("[https://example.invalid/f[1]]")).toEqual(["https://example.invalid/f[1]"]);
    expect(texts('"https://example.invalid/g" and <https://example.invalid/h>')).toEqual(["https://example.invalid/g", "https://example.invalid/h"]);
    expect(texts("https://example.invalid/q?x=1&y=2#top;")).toEqual(["https://example.invalid/q?x=1&y=2#top"]);
  });

  it("gives each URL's place in the line", () => {
    expect(extractTerminalUrls("go: https://a.invalid/x.")).toEqual([{ text: "https://a.invalid/x", start: 4, end: 23 }]);
  });

  it("T3's isTerminalUrl and activation rule", () => {
    expect(isTerminalUrl("https://a.invalid")).toBe(true);
    expect(isTerminalUrl("HTTP://A.INVALID")).toBe(true);
    expect(isTerminalUrl("src/a.ts")).toBe(false);
    expect(isTerminalLinkActivation(mouse(true), "MacIntel")).toBe(true);
    expect(isTerminalLinkActivation(mouse(false), "MacIntel")).toBe(false);
    expect(isTerminalLinkActivation(mouse(true, true), "MacIntel")).toBe(false);
    expect(isTerminalLinkActivation(mouse(false, true), "MacIntel")).toBe(false);
    expect(isTerminalLinkActivation(mouse(false, true), "Win32")).toBe(true);
    expect(isTerminalLinkActivation(mouse(true), "Linux x86_64")).toBe(false);
    expect(isTerminalLinkActivation(mouse(true), "")).toBe(false);
  });
});

describe("the terminal's link provider", () => {
  it("gives the row's links with their cells; ⌘-click opens one, a plain click does not", () => {
    const opened: string[] = [];
    const rows = ["$ npm run deploy", "Blog slot 2 is live: https://example.invalid/blog/2.", ""];
    const links = linksOn(buffer(rows, 80), 1, (url) => opened.push(url));
    expect(links.map((link) => link.text)).toEqual(["https://example.invalid/blog/2"]);
    expect(links[0]!.range).toEqual({ start: { x: 21, y: 1 }, end: { x: 50, y: 1 } });
    links[0]!.activate(mouse(false));
    expect(opened).toEqual([]);
    links[0]!.activate(mouse(false, true));
    expect(opened).toEqual([]);
    links[0]!.activate(mouse(true));
    expect(opened).toEqual(["https://example.invalid/blog/2"]);
    expect(linksOn(buffer(rows, 80), 0)).toEqual([]);
    expect(linksOn(buffer(rows, 80), 9)).toEqual([]);
  });

  it("off a Mac, Ctrl-click opens it", () => {
    const opened: string[] = [];
    const [link] = linksOn(buffer(["at http://example.invalid/x"], 40), 0, (url) => opened.push(url), "Win32");
    link!.activate(mouse(true));
    link!.activate(mouse(false, true));
    expect(opened).toEqual(["http://example.invalid/x"]);
  });

  it("a URL soft-wrapped across rows is one link, found from either row", () => {
    // A soft-wrapped row fills every column.
    const rows = ["see https://examp", "le.invalid/long/p", "ath now", "next"];
    expect(rows.slice(0, 2).map((row) => row.length)).toEqual([17, 17]);
    const source = buffer(rows, 17, [1, 2]);
    for (const y of [0, 1, 2]) {
      const links = linksOn(source, y);
      expect(links.map((link) => link.text)).toEqual(["https://example.invalid/long/path"]);
      expect(links[0]!.range).toEqual({ start: { x: 4, y: 0 }, end: { x: 2, y: 2 } });
    }
    expect(linksOn(source, 3)).toEqual([]);
  });

  it("takes the place of ghostty-web's own URL provider and keeps its OSC 8 one", () => {
    class BuiltInUrl {}
    class Osc8 {}
    const osc8 = new Osc8();
    let invalidated = 0;
    const detector = { providers: [osc8, new BuiltInUrl()] as unknown[], invalidateCache: () => (invalidated += 1) };
    const ours = terminalLinkProvider(() => buffer([], 1), () => undefined);
    const term = { linkDetector: detector, registerLinkProvider: () => undefined };
    expect(replaceUrlProvider(term, ours, (provider) => provider instanceof BuiltInUrl)).toBe(true);
    expect(detector.providers).toEqual([osc8, ours]);
    expect(invalidated).toBe(1);
    // A terminal without the detector's shape: added after the others.
    const added: unknown[] = [];
    expect(replaceUrlProvider({ registerLinkProvider: (provider: never) => void added.push(provider) }, ours, () => true)).toBe(false);
    expect(added).toEqual([ours]);
  });
});

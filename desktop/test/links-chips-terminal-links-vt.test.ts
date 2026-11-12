// The terminal's link provider read against real buffers of ghostty-web
// 0.4.0's VT core (its WASM, as test/terminal-engine.test.ts loads it), not a
// fake. Two addresses were cut before: a soft-wrapped URL (the engine marks the continuation row `isWrapped`,
// not the row before it) opened `https://examp` from its first row and was no
// link on its second, and a two-column character (its spacer cell has width 0
// and code point 0) cut `https://例え.invalid/a` to `https://例`. Each address
// here must open whole from every row it covers, and its range must cover its
// cells; when the buffer cannot tell where a URL ends (scrollback rows have no
// wrap data), no link is offered rather than a part. The opener is a fake.

import { readFileSync } from "node:fs";
import path from "node:path";

import { Ghostty, Terminal } from "ghostty-web";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { ghosttyLinkBuffer, terminalLinkProvider, type LinkBuffer, type TerminalLink } from "../src/renderer/terminal/terminal-links";
import { desktopRoot } from "./support/swift-fixtures";

let engine: WebAssembly.Module;
const open: Terminal[] = [];

beforeAll(async () => {
  engine = await WebAssembly.compile(readFileSync(path.join(desktopRoot, "node_modules/ghostty-web/ghostty-vt.wasm")));
});

afterEach(() => {
  for (const each of open.splice(0)) each.wasmTerm?.free();
});

/**
 * A terminal of `cols` by `rows` that has been sent `text`. Each gets its own instance of the core: one instance
 * reused after a terminal is freed can show the freed one's cells (seen while probing), which is not under test here.
 */
async function vt(text: string, cols: number, rows = 6): Promise<Terminal> {
  const ghostty = new Ghostty(await WebAssembly.instantiate(engine, { env: { log: () => undefined } }));
  const terminal = new Terminal({ ghostty, cols, rows });
  terminal.wasmTerm = ghostty.createTerminal(cols, rows);
  open.push(terminal);
  terminal.wasmTerm.write(text);
  terminal.wasmTerm.update();
  return terminal;
}

const wrapFlags = (terminal: Terminal): boolean[] =>
  Array.from({ length: terminal.buffer.active.length }, (_, y) => terminal.buffer.active.getLine(y)!.isWrapped);

const rowText = (terminal: Terminal, y: number): string => terminal.buffer.active.getLine(y)!.translateToString(true);

function linksOn(terminal: Terminal, y: number, opened: string[] = []): TerminalLink[] {
  let out: TerminalLink[] | undefined;
  terminalLinkProvider(() => ghosttyLinkBuffer(terminal), (url) => opened.push(url), "MacIntel").provideLinks(y, (links) => (out = links));
  return out ?? [];
}

/** ⌘-clicks the link on row `y` and gives what the opener was called with. */
function cmdClick(terminal: Terminal, y: number): string[] {
  const opened: string[] = [];
  const links = linksOn(terminal, y, opened);
  for (const link of links) link.activate({ metaKey: true, ctrlKey: false });
  return opened;
}

const cmd = { metaKey: true, ctrlKey: false };

describe("a soft-wrapped URL, as the real engine marks it", () => {
  it("opens whole from its first row and is a link on its second", async () => {
    const url = "https://example.invalid/path";
    const terminal = await vt(`see ${url} now`, 17, 3);
    expect([0, 1, 2].map((y) => rowText(terminal, y))).toEqual(["see https://examp", "le.invalid/path n", "ow"]);
    // The continuation rows carry the flag, not the rows before them.
    expect(wrapFlags(terminal)).toEqual([false, true, true]);
    for (const y of [0, 1]) {
      const links = linksOn(terminal, y);
      expect(links.map((link) => link.text)).toEqual([url]);
      expect(links[0]!.range).toEqual({ start: { x: 4, y: 0 }, end: { x: 14, y: 1 } });
      expect(cmdClick(terminal, y)).toEqual([url]);
    }
    expect(linksOn(terminal, 2)).toEqual([]);
  });

  it("a URL wrapped over three rows opens whole from each row", async () => {
    const url = "https://example.invalid/long/path/more/x";
    const terminal = await vt(`see ${url} now`, 17, 4);
    expect([0, 1, 2].map((y) => rowText(terminal, y))).toEqual(["see https://examp", "le.invalid/long/p", "ath/more/x now"]);
    expect(wrapFlags(terminal)).toEqual([false, true, true, false]);
    for (const y of [0, 1, 2]) {
      const links = linksOn(terminal, y);
      expect(links.map((link) => link.text)).toEqual([url]);
      expect(links[0]!.range).toEqual({ start: { x: 4, y: 0 }, end: { x: 9, y: 2 } });
      expect(cmdClick(terminal, y)).toEqual([url]);
    }
    expect(linksOn(terminal, 3)).toEqual([]);
  });

  it("a wrapped URL whose last row is the buffer's last row", async () => {
    const url = "https://example.invalid/long/path/x";
    const terminal = await vt(`see ${url}`, 17, 3);
    expect(terminal.buffer.active.length).toBe(3);
    expect(rowText(terminal, 2)).toBe("ath/x");
    expect(wrapFlags(terminal)).toEqual([false, true, true]);
    for (const y of [0, 1, 2]) {
      expect(linksOn(terminal, y)[0]!.range).toEqual({ start: { x: 4, y: 0 }, end: { x: 4, y: 2 } });
      expect(cmdClick(terminal, y)).toEqual([url]);
    }
  });

  it("a wrapped URL next to a URL on the following row that does not wrap: each row gives its own", async () => {
    const first = "https://example.invalid/path";
    const second = "http://b.invalid";
    const terminal = await vt(`see ${first}\r\n${second}`, 17, 3);
    expect([0, 1, 2].map((y) => rowText(terminal, y))).toEqual(["see https://examp", "le.invalid/path", second]);
    expect(wrapFlags(terminal)).toEqual([false, true, false]);
    expect(cmdClick(terminal, 0)).toEqual([first]);
    expect(cmdClick(terminal, 1)).toEqual([first]);
    const links = linksOn(terminal, 2);
    expect(links.map((link) => link.text)).toEqual([second]);
    expect(links[0]!.range).toEqual({ start: { x: 0, y: 2 }, end: { x: 15, y: 2 } });
    expect(cmdClick(terminal, 2)).toEqual([second]);
  });

  it("a plain click on a wrapped URL still opens nothing", async () => {
    const terminal = await vt("see https://example.invalid/path now", 17, 3);
    const opened: string[] = [];
    for (const link of linksOn(terminal, 1, opened)) link.activate({ metaKey: false, ctrlKey: false });
    expect(opened).toEqual([]);
  });
});

describe("wide characters", () => {
  it("an IDN host and a wide-character path open whole, their ranges over every cell", async () => {
    for (const [url, endX] of [
      ["https://例え.invalid/a", 21],
      ["https://example.invalid/文書", 27],
    ] as const) {
      const terminal = await vt(url, 80, 3);
      const links = linksOn(terminal, 0);
      expect(links.map((link) => link.text)).toEqual([url]);
      // The last cell of a wide last character is its spacer: the range takes both halves.
      expect(links[0]!.range).toEqual({ start: { x: 0, y: 0 }, end: { x: endX, y: 0 } });
      expect(cmdClick(terminal, 0)).toEqual([url]);
    }
  });

  it("a URL after wide characters starts at the right cell", async () => {
    const url = "https://example.invalid/x";
    const terminal = await vt(`文書 ${url} 例`, 80, 3);
    expect(linksOn(terminal, 0)[0]!.range).toEqual({ start: { x: 5, y: 0 }, end: { x: 29, y: 0 } });
    expect(cmdClick(terminal, 0)).toEqual([url]);
  });

  it("a wide-character path wrapped over three rows opens whole from each", async () => {
    const url = "https://example.invalid/文書文書文書";
    const terminal = await vt(url, 17, 4);
    expect([0, 1, 2].map((y) => rowText(terminal, y))).toEqual(["https://example.i", "nvalid/文書文書文", "書"]);
    for (const y of [0, 1, 2]) {
      expect(linksOn(terminal, y)[0]!.range).toEqual({ start: { x: 0, y: 0 }, end: { x: 1, y: 2 } });
      expect(cmdClick(terminal, y)).toEqual([url]);
    }
  });

  it("an IDN host whose wide character wrapped (a spacer at the row's end) opens whole from each row", async () => {
    const url = "https://abcd例え.invalid/x";
    const terminal = await vt(`see ${url}`, 17, 3);
    // 例 did not fit in the last column: the engine left a spacer there and carried it to the next row.
    expect([0, 1].map((y) => rowText(terminal, y))).toEqual(["see https://abcd", "例え.invalid/x"]);
    expect(terminal.buffer.active.getLine(0)!.getCell(16)!.getWidth()).toBe(0);
    expect(wrapFlags(terminal)).toEqual([false, true, false]);
    for (const y of [0, 1]) {
      expect(linksOn(terminal, y)[0]!.range).toEqual({ start: { x: 4, y: 0 }, end: { x: 13, y: 1 } });
      expect(cmdClick(terminal, y)).toEqual([url]);
    }
  });

  it("emoji and graphemes (a skin tone, a joined family, a combining accent) in a path stay in the address", async () => {
    const url = "https://e.invalid/a😀b/👍🏽/👨‍👩‍👧/café/x";
    const terminal = await vt(url, 80, 3);
    const links = linksOn(terminal, 0);
    expect(links.map((link) => link.text)).toEqual([url]);
    // h..a 0-18, 😀 19-20, b 21, / 22, 👍🏽 23-24, / 25, the family 26-27, / 28, café 29-32, / 33, x 34.
    expect(links[0]!.range).toEqual({ start: { x: 0, y: 0 }, end: { x: 34, y: 0 } });
    expect(cmdClick(terminal, 0)).toEqual([url]);
  });

  it("graphemes on a row below scrollback and in scrollback are read from the right row", async () => {
    const first = "https://e.invalid/👍🏽";
    const second = "https://f.invalid/👨‍👩‍👧/z";
    const terminal = await vt(`one\r\nat ${first}\r\ntwo\r\nthree\r\n${second}\r\nend`, 40, 3);
    expect(terminal.wasmTerm!.getScrollbackLength()).toBe(3);
    expect(rowText(terminal, 1)).toBe("at https://e.invalid/👍");
    expect(cmdClick(terminal, 1)).toEqual([first]);
    expect(rowText(terminal, 4)).toBe("https://f.invalid/👨/z");
    expect(cmdClick(terminal, 4)).toEqual([second]);
  });
});

describe("where the buffer cannot tell where a URL ends", () => {
  it("a wrapped URL now in scrollback (no wrap data) is no link, never a part of it", async () => {
    const terminal = await vt("l1\r\nl2\r\nsee https://example.invalid/path/long/more now\r\nx\r\ny\r\nz", 17, 4);
    expect(terminal.wasmTerm!.getScrollbackLength()).toBe(4);
    expect([2, 3, 4].map((y) => rowText(terminal, y))).toEqual(["see https://examp", "le.invalid/path/l", "ong/more now"]);
    // ghostty-web gives no wrap data for scrollback rows; the first screen row still says it continues.
    expect(wrapFlags(terminal)).toEqual([false, false, false, false, true, false, false, false]);
    for (let y = 0; y < terminal.buffer.active.length; y += 1) expect(cmdClick(terminal, y)).toEqual([]);
  });

  it("a URL in scrollback that cannot go on past its row is still a link", async () => {
    const url = "https://a.invalid/x";
    const terminal = await vt(`go ${url} now\r\n1\r\n2\r\n3`, 40, 2);
    expect(terminal.wasmTerm!.getScrollbackLength()).toBe(2);
    expect(linksOn(terminal, 0)[0]!.range).toEqual({ start: { x: 3, y: 0 }, end: { x: 21, y: 0 } });
    expect(cmdClick(terminal, 0)).toEqual([url]);
  });

  it("a URL at the start of a scrollback row (it may have begun on the row above) is not offered", async () => {
    const terminal = await vt("https://a.invalid/x now\r\n1\r\n2\r\n3", 40, 2);
    expect(rowText(terminal, 0)).toBe("https://a.invalid/x now");
    expect(cmdClick(terminal, 0)).toEqual([]);
  });

  it("a URL from the last scrollback row onto the screen's first row opens whole", async () => {
    const url = "https://example.invalid/pa";
    const terminal = await vt(`1\r\nsee ${url}\r\nz`, 17, 2);
    expect(terminal.wasmTerm!.getScrollbackLength()).toBe(2);
    expect([1, 2].map((y) => rowText(terminal, y))).toEqual(["see https://examp", "le.invalid/pa"]);
    for (const y of [1, 2]) {
      expect(linksOn(terminal, y)[0]!.range).toEqual({ start: { x: 4, y: 1 }, end: { x: 12, y: 2 } });
      expect(cmdClick(terminal, y)).toEqual([url]);
    }
  });
});

/** A fake buffer with what the real one cannot be made to show: a continuation with nothing above, a cell unread. */
function fake(rows: readonly string[], cols: number, continuations: readonly number[], unreadable: readonly [number, number][] = []): LinkBuffer {
  return {
    getLine: (y) => {
      const row = rows[y];
      if (row === undefined) return undefined;
      const chars = Array.from(row.padEnd(cols, "\u0000").slice(0, cols));
      return {
        length: cols,
        isWrapped: continuations.includes(y),
        getCell: (x) => ({ getCodepoint: () => chars[x]!.codePointAt(0)!, getWidth: () => 1 }),
      };
    },
    cellText: (y, x) => (unreadable.some(([row, col]) => row === y && col === x) ? null : undefined),
  };
}

function fakeLinks(source: LinkBuffer, y: number): string[] {
  let out: TerminalLink[] | undefined;
  const opened: string[] = [];
  terminalLinkProvider(() => source, (url) => opened.push(url), "MacIntel").provideLinks(y, (links) => (out = links));
  for (const link of out ?? []) link.activate(cmd);
  return opened;
}

describe("a run that cannot be rebuilt whole (fake buffers)", () => {
  it("a continuation row with no row above: a URL that may have begun above is not offered; one after a space is", () => {
    const source = fake(["https://a.invalid/x https://b.invalid/y"], 40, [0]);
    expect(fakeLinks(source, 0)).toEqual(["https://b.invalid/y"]);
    expect(fakeLinks(fake(["https://a.invalid/x https://b.invalid/y"], 40, []), 0)).toEqual(["https://a.invalid/x", "https://b.invalid/y"]);
  });

  it("a URL through a cell that cannot be read is not offered", () => {
    const rows = ["https://a.invalid/xy https://b.invalid/y"];
    expect(fakeLinks(fake(rows, 40, [], [[0, 19]]), 0)).toEqual(["https://b.invalid/y"]);
  });

  it("past the joined-row bound the URL is not offered rather than cut", () => {
    // 40 continuation rows of path: more than the provider joins.
    const rows = ["see https://a.in", ...Array.from({ length: 40 }, () => "xxxxxxxxxxxxxxxx")];
    const source = fake(rows, 16, rows.map((_, y) => y).slice(1));
    expect(fakeLinks(source, 0)).toEqual([]);
    expect(fakeLinks(source, 20)).toEqual([]);
  });
});

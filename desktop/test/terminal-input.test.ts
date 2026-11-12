// The terminal scrolls, copies and pastes as
// Ghostty does (its ghostty.5 for mouse-scroll-multiplier, mouse-reporting,
// mouse-shift-capture, copy-on-select; its scroll handling for the rest):
// - a normal screen: the wheel scrolls the scrollback at the display's rate
//   (a trackpad by pixels, one line per cell height; a wheel notch 3 lines);
// - the program asked for mouse reports (any tracking mode): the wheel goes to
//   it as button 64/65 presses in the format it asked for (SGR, urxvt, UTF-8,
//   X10), one per line; Shift held scrolls the scrollback instead;
// - the alternate screen without mouse reports (alternate scroll, 1007, on as
//   Ghostty's default): arrow keys, in the cursor-key mode it asked for;
// - one gesture, one scroll: a trackpad's momentum after the swipe never goes
//   to a program, and a single event sends at most five lines;
// - ⌘C copies the selection (and a selection copies as it ends: terminal-copy.test.ts);
//   a paste types the text as a person would (Ghostty and the Swift app's
//   CompanionSafePaste), bracketed when the program asked for it; a pasted or
//   dropped image or file uploads and its path is typed.
// Modes are read back from Ghostty's own VT core (the WASM build) fed the
// sequences a program sends.

import { readFileSync } from "node:fs";
import path from "node:path";

import { Ghostty } from "ghostty-web";
import { beforeAll, describe, expect, it } from "vitest";

import type { ClipboardFiles } from "../src/shared/ipc-contract";
import { safePaste, TerminalInput, type TerminalSurface, type WheelEventLike } from "../src/renderer/terminal/terminal-input";
import { desktopRoot } from "./support/swift-fixtures";

let ghostty: Ghostty;

beforeAll(async () => {
  const wasm = readFileSync(path.join(desktopRoot, "node_modules/ghostty-web/ghostty-vt.wasm"));
  const { instance } = await WebAssembly.instantiate(wasm, { env: { log: () => undefined } });
  ghostty = new Ghostty(instance);
});

/** A surface over Ghostty's VT core after `program` wrote these bytes. */
function surface(program: string, selection = "") {
  const vt = ghostty.createTerminal(80, 24);
  if (program !== "") vt.write(new TextEncoder().encode(program));
  vt.update();
  const scrolled: number[] = [];
  const s: TerminalSurface & { scrolled: number[] } = {
    scrolled,
    getMode: (mode) => vt.getMode(mode, false),
    alternateScreen: () => vt.isAlternateScreen(),
    mouseTracking: () => vt.hasMouseTracking(),
    bracketedPaste: () => vt.hasBracketedPaste(),
    hasSelection: () => selection !== "",
    getSelection: () => selection,
    scrollLines: (lines) => scrolled.push(lines),
    cellHeight: () => 17,
    cellAt: () => ({ col: 10, row: 5 }),
  };
  return s;
}

const noClipboard: ClipboardFiles = { files: [], refused: [], excess: [], failures: [] };

function harness(program: string, selection = "", clipboard: ClipboardFiles = noClipboard) {
  const sent: string[] = [];
  // Raw bytes (a legacy X10 mouse report) as they go, and in `sent` one character a byte.
  const raw: number[][] = [];
  const copied: string[] = [];
  const notes: string[] = [];
  const uploads: { data: number[]; extension: string }[] = [];
  const term = surface(program, selection);
  let clock = 0;
  const input = new TerminalInput(term, {
    send: (data) => {
      if (typeof data === "string") sent.push(data);
      else {
        raw.push([...data]);
        sent.push(String.fromCharCode(...data));
      }
    },
    copy: (text) => copied.push(text),
    note: (text) => notes.push(text),
    upload: async (data, extension) => {
      uploads.push({ data: [...data], extension });
      return { path: `/Users/fixture/.adari-attachments-0123456789abcdef0123456789abcdef/attachment-1111111${uploads.length}-1111-4111-8111-111111111111.${extension}`, byteCount: data.byteLength };
    },
    clipboardFiles: async () => clipboard,
    prepareImage: async () => ({ data: new Uint8Array([0x89, 0x50]), extension: "png" }),
    now: () => clock,
  });
  const wheel = (deltaY: number, extra: Partial<WheelEventLike> = {}) => {
    clock += 16;
    return input.wheel({ deltaY, deltaMode: 0, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, ...extra });
  };
  return { input, term, sent, raw, copied, notes, uploads, wheel, wait: (ms: number) => (clock += ms) };
}

const ALT = "\x1b[?1049h";

describe("the terminal's wheel", () => {
  it("scrolls the scrollback on a normal screen, one line per cell height of a trackpad's pixels", () => {
    const t = harness("hello\r\n");
    expect(t.wheel(-34)).toBe(true);
    t.wheel(-10);
    t.wheel(-10);
    expect(t.term.scrolled).toEqual([-2, -1]);
    expect(t.sent).toEqual([]);
  });

  it("scrolls three lines for a wheel's notch", () => {
    const t = harness("");
    t.wheel(1, { deltaMode: 1 });
    expect(t.term.scrolled).toEqual([3]);
  });

  it("sends arrow keys on the alternate screen when the program takes no mouse reports", () => {
    const t = harness(ALT);
    t.wheel(-34);
    expect(t.sent).toEqual(["\x1b[A", "\x1b[A"]);
    expect(t.term.scrolled).toEqual([]);
    const app = harness(`${ALT}\x1b[?1h`);
    app.wheel(17);
    expect(app.sent).toEqual(["\x1bOB"]);
  });

  it("scrolls on the alternate screen when the program turned alternate scroll off", () => {
    const t = harness(`${ALT}\x1b[?1007l`);
    t.wheel(-34);
    expect(t.sent).toEqual([]);
  });

  it("reports the wheel to a program that asked for mouse reports, in its format", () => {
    const sgr = harness(`${ALT}\x1b[?1000h\x1b[?1006h`);
    sgr.wheel(-17);
    sgr.wheel(17);
    expect(sgr.sent).toEqual(["\x1b[<64;10;5M", "\x1b[<65;10;5M"]);
    const x10 = harness("\x1b[?1000h");
    x10.wheel(-17);
    expect(x10.raw).toEqual([[0x1b, 0x5b, 0x4d, 32 + 64, 32 + 10, 32 + 5]]);
    const urxvt = harness("\x1b[?1002h\x1b[?1015h");
    urxvt.wheel(-17);
    expect(urxvt.sent).toEqual(["\x1b[96;10;5M"]);
    expect(sgr.term.scrolled).toEqual([]);
  });

  it("adds Alt and Ctrl to a report, and lets Shift scroll the scrollback (Ghostty's mouse-shift-capture false)", () => {
    const t = harness("\x1b[?1000h\x1b[?1006h");
    t.wheel(-17, { ctrlKey: true });
    expect(t.sent).toEqual(["\x1b[<80;10;5M"]);
    t.wheel(-17, { shiftKey: true });
    expect(t.sent.length).toBe(1);
    expect(t.term.scrolled).toEqual([-1]);
  });

  // Shift keeps the wheel for the scrollback
  // before either route to a program (mouse reports, alternate-scroll arrows).
  it("scrolls the scrollback for Shift on the alternate screen, with or without mouse reports", () => {
    for (const program of [
      ALT, // alternate scroll (1007) on by default: arrows without Shift
      `${ALT}\x1b[?1007h`,
      `${ALT}\x1b[?1007h\x1b[?1h`, // DECCKM
      `${ALT}\x1b[?1000h\x1b[?1006h`, // mouse reports, SGR
      `${ALT}\x1b[?1000h\x1b[?1006h\x1b[?1007h`,
      `${ALT}\x1b[?1002h`, // mouse reports, X10
    ]) {
      const t = harness(program);
      t.wheel(-17, { shiftKey: true });
      t.wheel(17, { shiftKey: true });
      expect(t.sent).toEqual([]);
      expect(t.term.scrolled).toEqual([-1, 1]);
      // Without Shift the same screen still goes to the program.
      t.wait(500);
      t.wheel(-17);
      expect(t.sent.length).toBe(1);
    }
  });

  it("sends nothing more once a mouse report turns off", () => {
    const vtOff = harness("\x1b[?1000h\x1b[?1000l");
    vtOff.wheel(-17);
    expect(vtOff.sent).toEqual([]);
    expect(vtOff.term.scrolled).toEqual([-1]);
  });

  it("sends at most five lines for one event, and none of a swipe's momentum", () => {
    const t = harness(`${ALT}\x1b[?1000h\x1b[?1006h`);
    t.wheel(-400);
    expect(t.sent.length).toBe(5);
    t.sent.length = 0;
    t.wait(500);
    // A swipe: the finger's events rise and hold, then the momentum decays.
    for (const delta of [-20, -40, -60, -60]) t.wheel(delta);
    const during = t.sent.length;
    expect(during).toBeGreaterThan(0);
    // Known for momentum by its second decaying event: the one before it is all that goes.
    for (const delta of [-48, -36, -27, -20, -15, -11, -8, -6, -4, -3, -2, -1]) t.wheel(delta);
    expect(t.sent.length - during).toBeLessThanOrEqual(3);
    // The next swipe, after a pause, scrolls again.
    t.wait(500);
    const before = t.sent.length;
    t.wheel(-34);
    expect(t.sent.length - before).toBe(2);
  });

  it("turns around at once: a change of direction drops what was left over", () => {
    const t = harness(ALT);
    t.wheel(-10);
    t.wheel(10);
    t.wheel(10);
    expect(t.sent).toEqual(["\x1b[B"]);
  });
});

describe("the terminal's copy and paste", () => {
  const key = (k: string, meta = true) => ({ key: k, metaKey: meta, ctrlKey: false, altKey: false, shiftKey: false, type: "keydown" });

  it("copies the selection with ⌘C and sends nothing", () => {
    const t = harness("", "selected text");
    expect(t.input.key(key("c"))).toBe(true);
    expect(t.copied).toEqual(["selected text"]);
    expect(t.sent).toEqual([]);
  });

  it("leaves ⌘C without a selection, and ⌘V, to the app (the Edit menu's paste)", () => {
    const t = harness("");
    expect(t.input.key(key("c"))).toBe(true);
    expect(t.copied).toEqual([]);
    expect(t.input.key(key("v"))).toBe(false);
    expect(t.input.key(key("c", false))).toBe(false);
  });

  it("types pasted text as a person would: new lines as Return, other control bytes dropped", () => {
    expect(safePaste("one\ntwo\r\nthree\tfour\x1b[201~\x07")).toBe("one\rtwo\rthree\tfour[201~");
    const t = harness("");
    const event = { clipboardData: { types: ["text/plain"], files: [], getData: () => "ls -la\npwd" }, preventDefault: () => undefined, stopPropagation: () => undefined };
    expect(t.input.paste(event)).toBe(true);
    expect(t.sent).toEqual(["ls -la\rpwd"]);
  });

  it("brackets a paste when the program asked for it", () => {
    const t = harness("\x1b[?2004h");
    t.input.paste({ clipboardData: { types: ["text/plain"], files: [], getData: () => "two\nlines" }, preventDefault: () => undefined, stopPropagation: () => undefined });
    expect(t.sent).toEqual(["\x1b[200~two\rlines\x1b[201~"]);
  });

  it("uploads a pasted image and types its path", async () => {
    const t = harness("\x1b[?2004h");
    const image = { name: "image.png", type: "image/png", size: 3, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
    expect(t.input.paste({ clipboardData: { types: ["Files"], files: [image], getData: () => "" }, preventDefault: () => undefined, stopPropagation: () => undefined })).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(t.uploads).toEqual([{ data: [0x89, 0x50], extension: "png" }]);
    expect(t.sent).toEqual(["\x1b[200~/Users/fixture/.adari-attachments-0123456789abcdef0123456789abcdef/attachment-11111111-1111-4111-8111-111111111111.png\x1b[201~"]);
  });

  it("uploads dropped files and types their paths, one space between", async () => {
    const t = harness("");
    const files = [
      { name: "a.png", type: "image/png", size: 1, arrayBuffer: async () => new Uint8Array([1]).buffer },
      { name: "b.log", type: "text/plain", size: 2, arrayBuffer: async () => new Uint8Array([2, 2]).buffer },
      { name: "c.sh", type: "text/x-sh", size: 1, arrayBuffer: async () => new Uint8Array([3]).buffer },
    ];
    let prevented = false;
    t.input.drop({ dataTransfer: { types: ["Files"], files }, preventDefault: () => (prevented = true), stopPropagation: () => undefined });
    expect(prevented).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(t.uploads.map((u) => u.extension)).toEqual(["png", "log"]);
    expect(t.sent.length).toBe(1);
    expect(t.sent[0]!.split(" ").map((p) => p.slice(p.lastIndexOf(".")))).toEqual([".png", ".log"]);
    expect(t.notes).toEqual(["Not attached: c.sh. Only images, PDF, text, logs, Markdown, JSON, CSV and zip files upload."]);
  });

  // Main's read of a Finder copy is the answer
  // whenever it says anything (Chat's attachPasted rule); the icon Chromium
  // pastes beside a Finder copy is used only when main found nothing at all.
  const finderPaste = (t: ReturnType<typeof harness>) => {
    const icon = { name: "image.png", type: "image/png", size: 3, arrayBuffer: async () => new Uint8Array([7, 7, 7]).buffer };
    t.input.paste({ clipboardData: { types: ["Files", "text/plain"], files: [icon], getData: () => "script.sh" }, preventDefault: () => undefined, stopPropagation: () => undefined });
    return new Promise((resolve) => setTimeout(resolve, 5));
  };

  it("says why a Finder file was refused and never uploads its icon", async () => {
    for (const clipboard of [
      { ...noClipboard, refused: ["script.sh"] },
      { ...noClipboard, excess: ["eleventh.txt"] },
      { ...noClipboard, failures: ["huge.log: The file is too large to upload. Choose one under 12 MB."] },
    ]) {
      const t = harness("", "", clipboard);
      await finderPaste(t);
      expect(t.uploads).toEqual([]);
      expect(t.sent).toEqual([]);
      expect(t.notes.length).toBe(1);
      expect(t.notes[0]).toContain([...clipboard.refused, ...clipboard.excess, ...clipboard.failures.map((f) => f.split(":")[0]!)][0]);
    }
  });

  it("uploads a mixed Finder copy's accepted files and names every one it left", async () => {
    const t = harness("", "", {
      files: [{ name: "notes.txt", type: "text/plain", data: new Uint8Array([1, 2]) }],
      refused: ["script.sh"],
      excess: ["eleventh.txt"],
      failures: ["huge.log: The file is too large to upload. Choose one under 12 MB.", "gone.pdf: ENOENT"],
    });
    await finderPaste(t);
    expect(t.uploads).toEqual([{ data: [1, 2], extension: "txt" }]);
    expect(t.sent.length).toBe(1);
    expect(t.sent[0]).toMatch(/attachment-[0-9a-f-]+\.txt$/);
    const note = t.notes.join(" ");
    for (const name of ["script.sh", "eleventh.txt", "huge.log", "gone.pdf"]) expect(note).toContain(name);
  });

  it("uploads the pasted image itself when main found no Finder copy", async () => {
    const t = harness("");
    await finderPaste(t);
    expect(t.uploads).toEqual([{ data: [0x89, 0x50], extension: "png" }]);
    expect(t.notes).toEqual([]);
  });

  it("says why when an upload fails, and types nothing", async () => {
    const t = harness("");
    const failing = new TerminalInput(t.term, {
      send: (data) => t.sent.push(String(data)),
      copy: () => undefined,
      note: (text) => t.notes.push(text),
      upload: async () => {
        throw new Error("Error invoking remote method 'herdr:attachment-upload': Error: Uploads are not available for this machine.");
      },
      clipboardFiles: async () => ({ files: [], refused: [], excess: [], failures: [] }),
      prepareImage: async () => ({ data: new Uint8Array([1]), extension: "png" }),
    });
    failing.drop({ dataTransfer: { types: ["Files"], files: [{ name: "a.png", type: "image/png", size: 1, arrayBuffer: async () => new Uint8Array([1]).buffer }] }, preventDefault: () => undefined });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(t.sent).toEqual([]);
    expect(t.notes).toEqual(["a.png did not upload (Uploads are not available for this machine.)."]);
  });
});

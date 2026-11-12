// Question boxes and input boxes on agents' start screens.
// - A folder name holding " > " can wrap onto its own row inside Gemini's trust question box (a 247-character
//   name at 40 columns); read as Gemini's input box, it would send text and Return into the live question.
//   A box is the agent's input box only in its real layout: its top edge read and its prompt row its first row that is
//   not blank.
// - An empty paragraph in Grok's input can hide the ❯ row, so the last row ("directory?") could read as
//   a piece of the question. Grok's ❯ row is found across blank rows when no row between it and the last
//   paragraph is a part of the question and that paragraph does not hold all of its choices; an older prompt above a
//   live question stays the question or unverified.
// Fake Herdr and fake screens only.

import { afterEach, describe, expect, it, vi } from "vitest";

const registered = vi.hoisted(() => ({ handles: new Map<string, (...args: unknown[]) => unknown>() }));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, listener: (...args: unknown[]) => unknown) => registered.handles.set(channel, listener),
    on: () => undefined,
  },
}));

import { readStartScreen, readStartScreenState, startScreenLines, startScreenNotSent } from "../src/shared/prompt/start-screen";
import { cursorTrustFrame, geminiTrustFrame, grokTrustFrame } from "./support/start-question-frames";
import { flush, last, redraw, startQuestionWorld, tallGrok, type Kind } from "./support/start-question-world";

afterEach(() => vi.useRealTimers());

const world = (kind: Kind) => startQuestionWorld(kind, registered.handles);
const lines = startScreenLines("grok");
const version = "Grok Build  1.0.77 [stable]";
const grokTyped = (text: string, width: number) => `${redraw(`❯ ${text}`, width)}\n${version}`;
const grokParts = ["Do you trust the contents of this directory?", "Grok Build may run or modify contents in this directory,", "posing security risks.", "Yes, proceed y", "No, quit n"];
const glyphs = [">", "→", "❯"] as const;

/** Gemini's folder trust, or Cursor's workspace trust, with folder `name`, drawn at `width` columns. */
function withFolder(kind: "gemini" | "cursor", name: string, width: number): string {
  if (kind === "gemini") return redraw(geminiTrustFrame.replace("Trust folder (gemini)", `Trust folder (${name})`), width);
  expect(cursorTrustFrame.split("/private/tmp/z-frames-1794346091/cursor")).toHaveLength(2);
  return redraw(cursorTrustFrame.replace("/private/tmp/z-frames-1794346091/cursor", `/fixture/${name}`), width);
}
/** A folder name `length` characters long with `glyph` standing alone at character `at` (UTF-8 at most 255 bytes). */
function glyphName(glyph: string, length: number, at: number): string {
  const name = at === 0 ? `${glyph} ${"x".repeat(length - 2)}` : `${"x".repeat(at)} ${glyph} ${"x".repeat(Math.max(0, length - at - 3))}`;
  return Buffer.byteLength(name) <= 255 ? name : name.slice(0, name.length - (Buffer.byteLength(name) - 255));
}

async function sendsWithWatch(text: string, typed: string): Promise<void> {
  const w = await world("grok");
  w.onText(() => {
    w.screens.set("w1:p1", typed);
    w.tickNow();
  });
  const error = await w.send(text).then(
    () => null,
    (failure: Error) => failure.message,
  );
  expect({ text, error, writes: w.writes().map((call) => call[0]), marked: w.service.showing("mini", "w1:p1") }).toEqual({ text, error: null, writes: ["text", "keys"], marked: null });
}

describe("a folder glyph inside a question's box is not the agent's input box", () => {
  const wrappedNames = [17, 18, 35].map((at) => `${"x".repeat(at)} > ${"x".repeat(227 + 17 - at)}`);

  it("three folder names (247 characters, ' > ' at 17, 18 and 35) at 40 columns: a > row in the box, never clear", () => {
    for (const name of wrappedNames) {
      expect(name).toHaveLength(247);
      const frame = withFolder("gemini", name, 40);
      expect(frame.split("\n").some((row) => /^│ >\s*│$/u.test(row) || row.startsWith("│ > "))).toBe(true);
      expect(["geminiTrust", "unverified"]).toContain(readStartScreenState(frame, "gemini", lines));
    }
  });

  it("through main's real IPC handler: nothing written, the could-not-check note or the question's, no mark from an unverified read", async () => {
    for (const name of wrappedNames) {
      const frame = withFolder("gemini", name, 40);
      const state = readStartScreenState(frame, "gemini", lines);
      const w = await world("gemini");
      w.screens.set("w1:p1", frame);
      w.tickNow();
      await flush();
      expect(w.service.showing("mini", "w1:p1")).toBe(state === "unverified" ? null : state);
      await expect(w.send("Reply with exactly one word: pong")).rejects.toThrow(startScreenNotSent("gemini", state === "unverified" ? null : "geminiTrust"));
      expect(w.writes()).toEqual([]);
    }
  });

  it("sweep: Gemini's and Cursor's question with >, → and ❯ at every position of folder names of 20 to 255 characters, at 40, 48, 50, 60, 80 and 119 columns: never clear", () => {
    let cases = 0;
    let glyphRows = 0;
    for (const kind of ["gemini", "cursor"] as const) {
      for (const length of [20, 47, 100, 160, 200, 247, 255]) {
        for (const glyph of glyphs) {
          for (let at = 0; at <= length - 3; at += 1) {
            const name = glyphName(glyph, length, at);
            for (const width of [40, 48, 50, 60, 80, 119]) {
              const frame = withFolder(kind, name, width);
              const state = readStartScreenState(frame, kind, lines);
              if (state === null) expect({ kind, length, glyph, at, width, state }).toEqual("never clear");
              if (frame.split("\n").some((row) => /^[>→❯](?:\s|$)/u.test(row.replace(/^\s*│?\s*/u, "")))) glyphRows += 1;
              cases += 1;
            }
          }
        }
      }
    }
    expect(cases).toBeGreaterThan(20_000);
    // Glyphs did land at the start of drawn rows (the case that mattered).
    expect(glyphRows).toBeGreaterThan(100);
  });

  it("the input boxes themselves: prompt row first is input; a > row under a question's title in a box is not", () => {
    const box = (rows: readonly string[], width = 60) => ["╭" + "─".repeat(width - 2) + "╮", ...rows.map((row) => `│ ${row.padEnd(width - 3)}│`), "╰" + "─".repeat(width - 2) + "╯"].join("\n");
    expect(readStartScreenState(box(["", "> Do you trust the files in this folder?"]), "gemini", lines)).toBeNull();
    expect(readStartScreenState(box(["→ Workspace Trust Required"]), "cursor", lines)).toBeNull();
    expect(readStartScreenState(box(["Do you trust the files in this folder?", "> demo", "3. Don't trust"]), "gemini", lines)).toBe("unverified");
    expect(readStartScreenState(box(["Workspace Trust Required", "→ demo", "[q] Quit"]), "cursor", lines)).toBe("unverified");
    // A box whose top edge is above the read (the read starts inside it) is never taken for an input box.
    expect(readStartScreenState(box(["> demo", "Do you trust the files in this folder?", "3. Don't trust"]).split("\n").slice(1).join("\n"), "gemini", lines)).toBe("unverified");
  });
});

describe("empty paragraphs in Grok's input", () => {
  const paragraphs = [
    ["Please inspect this repository.\n\nCan you list the files in this directory?", 40],
    ["Please review the implementation.\n\nPlease explain all of the security risks.", 40],
    ["Please inspect this repository.\n\nCan you list the files in this\ndirectory?", 119],
  ] as const;

  it("three messages: the reader says clear", () => {
    expect(grokTyped(paragraphs[0][0], 40).split("\n")).toEqual(["❯ Please inspect this repository.", "", "Can you list the files in this", "directory?", version]);
    for (const [text, width] of paragraphs) expect([text, readStartScreenState(grokTyped(text, width), "grok", lines)]).toEqual([text, null]);
  });

  it("three messages through main's real IPC handler, the watch reading the typed input: text and Return, no mark", async () => {
    for (const [text, width] of paragraphs) await sendsWithWatch(text, grokTyped(text, width));
  });

  it("a 3-second final snapshot with the watch due at 2.5 s still gets the Return", async () => {
    vi.useFakeTimers();
    const text = paragraphs[0][0];
    const w = await world("grok");
    let finished = false;
    w.onText(() => {
      w.screens.set("w1:p1", grokTyped(text, 40));
      setTimeout(() => w.tickNow(2_500), 2_500);
      w.onSnapshot(() => new Promise<void>((done) => setTimeout(done, 3_000)));
    });
    const sending = w.send(text).then(
      () => ((finished = true), null),
      (failure: Error) => ((finished = true), failure.message),
    );
    await flush();
    await vi.advanceTimersByTimeAsync(2_499);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(501);
    expect({ error: await sending, writes: w.writes().map((call) => call[0]) }).toEqual({ error: null, writes: ["text", "keys"] });
  });

  it("sweep: two and three paragraphs whose last is each question part or suffix, at every width from 40 to 119: clear; sends at 40, 60, 80 and 119", async () => {
    const suffixes = [...new Set(grokParts.flatMap((part) => Array.from({ length: part.length }, (_, at) => part.slice(at).trim()).filter((suffix) => suffix !== "")))];
    expect(suffixes).toHaveLength(124);
    let cases = 0;
    for (let width = 40; width <= 119; width += 1) {
      for (const suffix of suffixes) {
        for (const text of [`Please inspect this repository.\n\n${suffix}`, `Please inspect this repository.\n\nThen read the build output.\n\n${suffix}`]) {
          const typed = grokTyped(text, width);
          if (readStartScreenState(typed, "grok", lines) !== null) expect({ width, text }).toEqual("clear");
          if ([40, 60, 80, 119].includes(width)) await sendsWithWatch(text, typed);
          cases += 1;
        }
      }
    }
    expect(cases).toBe(80 * 124 * 2);
  });

  it("ordinary paragraphs with no question words at every width from 40 to 160: clear", () => {
    for (const text of ["Please inspect this repository.\n\nThen summarize what you found.", "Please review the implementation.\n\nMake the smallest safe correction.", "One.\n\nTwo.\n\nThree."]) {
      for (let width = 40; width <= 160; width += 1) if (readStartScreenState(grokTyped(text, width), "grok", lines) !== null) expect({ width, text }).toEqual("clear");
    }
  });
});

describe("an older ❯ prompt above Grok's live question: the question or unverified, never clear", () => {
  it("the whole question, its description and choices, or its choices alone under an older prompt and empty rows", async () => {
    const question = grokTrustFrame.split("\n");
    const title = question.findIndex((row) => row.includes("Do you trust the contents"));
    const description = question.findIndex((row) => row.includes("Grok Build may run"));
    const yes = question.findIndex((row) => row.includes("Yes, proceed"));
    const frames: string[] = [];
    for (const width of [40, 60, 80, 119, 160]) {
      for (const from of [0, title, description, yes]) {
        for (const gap of [1, 2, 5]) frames.push(redraw(["❯ an older message", ...Array<string>(gap).fill(""), ...question.slice(from)].join("\n"), width));
      }
    }
    // A tall screen with the older prompt above the whole question: the 200-line read as Herdr returns it.
    for (let height = 190; height <= 420; height += 1) frames.push(last(["❯ an older message", "", tallGrok(height)].join("\n"), lines));
    frames.push(["❯ an older message", "", "Yes, proceed  y", "No, quit  n", "", version].join("\n"));
    for (const frame of frames) expect(["grokTrust", "unverified"]).toContain(readStartScreenState(frame, "grok", lines));
    const w = await world("grok");
    w.screens.set("w1:p1", frames[frames.length - 1]!);
    await expect(w.send("Reply with exactly one word: pong")).rejects.toThrow(startScreenNotSent("grok", null));
    expect(w.writes()).toEqual([]);
    expect(readStartScreen(frames[0]!, "grok")).toBe("grokTrust");
  });
});

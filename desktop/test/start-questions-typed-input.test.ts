// In normal use, a Grok pane at its ordinary prompt with a message typed in it ("Can you list the files in this
// directory?" at 40 columns: its last row "directory?") could read as a piece of Grok's trust question, and a watch
// read after the text would withhold the Return. The agent's own input at the bottom (Grok's rows from its ❯ prompt
// row down; Cursor's and Gemini's input box with their prompt row in it) is typed input, never a part of a question,
// whatever words it holds. Promptless tails of a question stay unverified, and no question frame draws an input
// prompt. Fake Herdr and fake screens only.

import { afterEach, describe, expect, it, vi } from "vitest";

const registered = vi.hoisted(() => ({ handles: new Map<string, (...args: unknown[]) => unknown>() }));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, listener: (...args: unknown[]) => unknown) => registered.handles.set(channel, listener),
    on: () => undefined,
  },
}));

import { readStartScreen, readStartScreenState, startScreenLines } from "../src/shared/prompt/start-screen";
import { cursorTrustFrame, geminiSignInFrame, geminiTrustFrame, grokTrustFrame } from "./support/start-question-frames";
import { flush, last, prompts, redraw, startQuestionWorld, tallGrok, type Kind } from "./support/start-question-world";

afterEach(() => vi.useRealTimers());

const world = (kind: Kind) => startQuestionWorld(kind, registered.handles);
const lines = startScreenLines("grok");
const version = "Grok Build  1.0.77 [stable]";
/** Grok at its prompt with `text` typed, drawn at `width` columns (the input row over the version line). */
const grokTyped = (text: string, width: number) => `${redraw(`❯ ${text}`, width)}\n${version}`;
/** Grok's five question parts as drawn (spaces collapsed). */
const grokParts = ["Do you trust the contents of this directory?", "Grok Build may run or modify contents in this directory,", "posing security risks.", "Yes, proceed y", "No, quit n"];

/**
 * A Send of `text` to a pane of `kind` whose screen shows `typed` once the text is in, with the watch reading it then
 * (its newer read is waited for before the Return): the text and the Return both go, and nothing is marked.
 */
async function sendsWithWatch(kind: Kind, text: string, typed: string): Promise<void> {
  const w = await world(kind);
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

describe("Grok's own typed input is never read as a piece of its question", () => {
  const cases = [
    ["Can you list the files in this directory?", 40],
    ["Please inspect the files in this directory?", 40],
    ["Please explain all of the security risks.", 40],
    ["Can you list the files in this\ndirectory?", 119],
  ] as const;

  it("four typed messages: the reader says clear", () => {
    const rows = grokTyped(cases[0][0], 40).split("\n");
    expect(rows).toEqual(["❯ Can you list the files in this", "directory?", version]);
    for (const [text, width] of cases) {
      const typed = grokTyped(text, width);
      expect(typed.split("\n").at(-2)).toMatch(/^(?:directory\?|risks\.)$/);
      expect([text, readStartScreenState(typed, "grok", lines)]).toEqual([text, null]);
    }
  });

  it("four typed messages through main's real IPC handler, the watch reading the typed input: text and Return, no mark", async () => {
    for (const [text, width] of cases) await sendsWithWatch("grok", text, grokTyped(text, width));
  });

  it("a 3-second final snapshot with the watch due at 2.5 s still gets the Return (the elapsed-time case)", async () => {
    vi.useFakeTimers();
    const text = cases[0][0];
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
    expect(w.reads().length).toBeGreaterThanOrEqual(2);
  });

  it("every suffix of each of the five parts as the last row of a wrapped input under a ❯ row, at 40, 60, 80 and 119 columns", async () => {
    let cases = 0;
    for (const width of [40, 60, 80, 119]) {
      const suffixes = new Set(grokParts.flatMap((part) => Array.from({ length: part.length }, (_, at) => part.slice(at).trim()).filter((suffix) => suffix !== "")));
      for (const suffix of suffixes) {
        const typed = `${redraw("❯ Please look at this and then tell me about", width)}\n${redraw(suffix, width)}\n${version}`;
        expect([width, suffix, readStartScreenState(typed, "grok", lines)]).toEqual([width, suffix, null]);
        await sendsWithWatch("grok", `Please look at this and then tell me about ${suffix}`, typed);
        cases += 1;
      }
    }
    // 124 distinct suffixes of the five parts, at each of the four widths.
    expect(cases).toBe(496);
  });

  it("the exact question text, and each part, typed as a message under the ❯ prompt: clear, sends", async () => {
    for (const width of [40, 60, 80, 119, 160]) {
      for (const text of [...grokParts, "Do you trust the contents of this directory?\nYes, proceed y\nNo, quit n"]) {
        const typed = grokTyped(text, width);
        expect([width, text, readStartScreenState(typed, "grok", lines)]).toEqual([width, text, null]);
        await sendsWithWatch("grok", text, typed);
      }
    }
  });
});

describe("Cursor's and Gemini's input boxes: typed text in the agent's own prompt box is input", () => {
  /** An input box `width` columns wide holding the prompt row and `text` wrapped under it, as the screen's last rows. */
  const inputBox = (glyph: string, text: string, width: number) => redraw(["╭" + "─".repeat(width - 2) + "╮", `│ ${glyph} ${text}│`, "╰" + "─".repeat(width - 2) + "╯"].join("\n"), width);

  it("their ordinary screens (rows under the input box) with the question's words typed in: clear, sends", async () => {
    const typed: Record<"cursor" | "gemini", (text: string) => string> = {
      cursor: (text) => prompts.cursor.replace("Plan, search, build anything", text),
      gemini: (text) => prompts.gemini.replace("Type your message or @path/to/file", text),
    };
    for (const [kind, text] of [
      ["cursor", "Workspace Trust Required. Do you trust the contents of this directory? [a] Trust this workspace"],
      ["gemini", "Do you trust the files in this folder? 1. Trust folder (demo) 3. Don't trust"],
      ["gemini", "How would you like to authenticate for this project? (Use Enter to select)"],
    ] as const) {
      expect(readStartScreenState(typed[kind](text), kind, lines)).toBeNull();
      await sendsWithWatch(kind, text, typed[kind](text));
    }
  });

  it("their input box as the very last row, the question's words wrapped inside it, at 40, 60, 80 and 119 columns: clear, sends", async () => {
    for (const width of [40, 60, 80, 119]) {
      for (const [kind, glyph, text] of [
        ["cursor", "→", "Workspace Trust Required. Do you trust the contents of this directory? Use arrow keys to navigate, Enter to select, or press the key shown"],
        ["gemini", ">", "Do you trust the files in this folder? Trusting a folder allows Gemini CLI to load its local configurations"],
        ["gemini", ">", "Get started. How would you like to authenticate for this project? Terms of Services and Privacy Notice for Gemini CLI"],
      ] as const) {
        const typed = inputBox(glyph, text, width);
        expect(typed.split("\n").at(-1)).toMatch(/^╰─+╯$/u);
        expect([kind, width, readStartScreenState(typed, kind, lines)]).toEqual([kind, width, null]);
        await sendsWithWatch(kind, text, typed);
      }
    }
  });
});

describe("safety kept: no question frame draws an input prompt, and promptless tails stay unverified", () => {
  /** A row as the readers compare it, a box's edges taken off. */
  const inner = (row: string) => row.trim().replace(/^│|│$/gu, "").trim();
  const frames = (): readonly [Kind, string][] => {
    const out: [Kind, string][] = [];
    for (const [kind, frame] of [
      ["grok", grokTrustFrame],
      ["cursor", cursorTrustFrame],
      ["gemini", geminiTrustFrame],
      ["gemini", geminiSignInFrame],
    ] as const) {
      out.push([kind, frame]);
      for (const width of [40, 48, 60, 80, 119, 160]) out.push([kind, redraw(frame, width)]);
    }
    for (let height = 190; height <= 420; height += 1) out.push(["grok", last(tallGrok(height), lines)]);
    for (const length of [50, 100, 150, 200, 255]) for (const width of [40, 48, 60, 80, 119]) out.push(["gemini", redraw(geminiTrustFrame.replace("Trust folder (gemini)", `Trust folder (${"x".repeat(length)})`), width)]);
    return out;
  };

  it("no captured or generated question frame has a row starting with ❯, → or >", () => {
    for (const [, frame] of frames()) for (const row of frame.split("\n")) expect(inner(row)).not.toMatch(/^[❯→>](?:\s|$)/u);
  });

  it("every one of those frames is the question or unverified; the 405 and 406-row tails unverified", () => {
    for (const [kind, frame] of frames()) expect(["grokTrust", "cursorTrust", "geminiTrust", "geminiSignIn", "unverified"]).toContain(readStartScreenState(frame, kind, lines));
    for (const height of [405, 406]) expect(readStartScreenState(last(tallGrok(height), lines), "grok", lines)).toBe("unverified");
    expect(readStartScreen(grokTrustFrame, "grok")).toBe("grokTrust");
  });

  it("a ❯ row above a blank row does not make a promptless question tail input", () => {
    const tail = ["❯ an older input row", "", "Yes, proceed  y", "No, quit  n", "", version].join("\n");
    expect(readStartScreenState(tail, "grok", lines)).toBe("unverified");
  });
});

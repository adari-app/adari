// Start questions the reader cannot fully see. Two boundaries show the class: Gemini's folder trust with a
// 255-character folder name at 40 columns (its first choice wraps over eight rows, past the join's six) and Grok's
// centred question on a 405 or 406-row pane (the 200-line read starts on its last choice). They are handled as one
// class rather than two more bounds: for Grok Build, Cursor Agent and Gemini CLI, a read
// whose bottom is any part of one of the kind's questions, with no ordinary prompt of the agent under it, is the
// question or unverified, never clear. Unverified: the Send is refused before any byte with the could-not-check note,
// and the watch keeps its last mark. Sweeps rather than single points, and the normal-use controls stay clear and send.
// Fake Herdr and fake screens only: no socket, no network, no agent.

import { describe, expect, it, vi } from "vitest";

const registered = vi.hoisted(() => ({ handles: new Map<string, (...args: unknown[]) => unknown>() }));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, listener: (...args: unknown[]) => unknown) => registered.handles.set(channel, listener),
    on: () => undefined,
  },
}));

import { readStartScreen, readStartScreenState, startScreenLines, startScreenNotSent, type StartScreenKind } from "../src/shared/prompt/start-screen";
import { grokModelScreen } from "./support/grok-model-fixtures";
import { modeScreen } from "./support/mode-fixtures";
import { cursorTrustFrame, geminiSignInFrame, geminiTrustFrame, grokTrustFrame } from "./support/start-question-frames";
import { flush, last, prompts, redraw, startQuestionWorld, tallGrok, type Kind } from "./support/start-question-world";

const world = (kind: Kind) => startQuestionWorld(kind, registered.handles);
const lines = startScreenLines("grok");
/** What one 200-line read of `screen` says. */
const stateOf = (screen: string, kind: Kind) => readStartScreenState(last(screen, lines), kind, lines);
/** Gemini's folder trust with a folder name `length` characters long, drawn at `width` columns. */
const geminiFolder = (length: number, width: number) => redraw(geminiTrustFrame.replace("Trust folder (gemini)", `Trust folder (${"x".repeat(length)})`), width);

const questions: readonly { readonly kind: Kind; readonly screen: StartScreenKind; readonly frame: string }[] = [
  { kind: "grok", screen: "grokTrust", frame: grokTrustFrame },
  { kind: "cursor", screen: "cursorTrust", frame: cursorTrustFrame },
  { kind: "gemini", screen: "geminiTrust", frame: geminiTrustFrame },
  { kind: "gemini", screen: "geminiSignIn", frame: geminiSignInFrame },
];

/** A Send of a test message to a pane showing `screen`: refused with `note`, nothing written. */
async function refused(kind: Kind, screen: string, note: string): Promise<void> {
  const w = await world(kind);
  w.screens.set("w1:p1", screen);
  await expect(w.send("Reply with exactly one word: pong")).rejects.toThrow(note);
  expect(w.writes()).toEqual([]);
}

/** A pane at `screen`: the watch does not mark it and a Send goes with its Return. */
async function sends(kind: Kind, screen: string): Promise<void> {
  const w = await world(kind);
  w.screens.set("w1:p1", screen);
  w.tickNow();
  await flush();
  expect(w.service.showing("mini", "w1:p1")).toBeNull();
  await w.send("hello");
  expect(w.writes().map((call) => call[0])).toEqual(["text", "keys"]);
}

// MARK: - The two boundaries

describe("the boundaries: the 255-character folder at 40 columns, Grok on 405 and 406 rows", () => {
  it("the reader: not clear", () => {
    const folder = geminiFolder(255, 40);
    expect(folder.split("\n").every((row) => Array.from(row).length <= 40)).toBe(true);
    expect(folder.split("\n")).toHaveLength(58);
    expect(readStartScreenState(folder, "gemini", lines)).toBe("unverified");
    for (const height of [405, 406]) {
      const read = last(tallGrok(height), lines);
      expect(read.split("\n").filter((row) => row.trim() !== "")).toEqual(["No, quit  n", "Grok Build  1.0.77 [stable]"]);
      expect(readStartScreenState(read, "grok", lines)).toBe("unverified");
    }
  });

  it("main's real IPC handler: refused before any byte with the could-not-check note", async () => {
    await refused("gemini", geminiFolder(255, 40), startScreenNotSent("gemini", null));
    for (const height of [405, 406]) await refused("grok", tallGrok(height), startScreenNotSent("grok", null));
  });

  it("the watch never marks them, and keeps the mark it had", async () => {
    for (const [kind, partial, whole, screen] of [
      ["gemini", geminiFolder(255, 40), geminiTrustFrame, "geminiTrust"],
      ["grok", tallGrok(405), tallGrok(200), "grokTrust"],
      ["grok", tallGrok(406), tallGrok(200), "grokTrust"],
    ] as const) {
      const w = await world(kind);
      for (const [shown, expected] of [
        [partial, null],
        [whole, screen],
        [partial, screen],
      ] as const) {
        w.screens.set("w1:p1", shown);
        w.tickNow();
        await flush();
        expect(w.service.showing("mini", "w1:p1")).toBe(expected);
      }
      expect(w.writes()).toEqual([]);
    }
  });
});

// MARK: - sweeps

describe("sweeps: every case is the question or unverified, never clear", () => {
  it("Gemini's folder name at 50, 100, 150, 200 and 255 characters, at 40, 48, 60, 80 and 119 columns", async () => {
    const seen = new Set<string | null>();
    for (const length of [50, 100, 150, 200, 255]) {
      for (const width of [40, 48, 60, 80, 119]) {
        const screen = geminiFolder(length, width);
        const state = stateOf(screen, "gemini");
        seen.add(state);
        expect([`${length} at ${width}`, state === "geminiTrust" || state === "unverified"]).toEqual([`${length} at ${width}`, true]);
        const w = await world("gemini");
        w.screens.set("w1:p1", screen);
        await expect(w.send("Reply with exactly one word: pong")).rejects.toThrow(/^Not sent: /);
        expect(w.writes()).toEqual([]);
      }
    }
    // Both sides of the join's bound are in the sweep.
    expect([...seen].sort()).toEqual(["geminiTrust", "unverified"]);
  });

  it("Grok's centred question on every pane height from 190 to 420 rows, read 200 lines", async () => {
    const seen = new Set<string | null>();
    for (let height = 190; height <= 420; height += 1) {
      const screen = tallGrok(height);
      expect(readStartScreen(screen, "grok")).toBe("grokTrust");
      const state = stateOf(screen, "grok");
      seen.add(state);
      expect([height, state === "grokTrust" || state === "unverified"]).toEqual([height, true]);
      const w = await world("grok");
      w.screens.set("w1:p1", screen);
      await expect(w.send("Reply with exactly one word: pong")).rejects.toThrow(/^Not sent: /);
      expect(w.writes()).toEqual([]);
    }
    expect([...seen].sort()).toEqual(["grokTrust", "unverified"]);
  });
});

// MARK: - the class: what cannot be proven whole is unverified

describe("a part of the question at the bottom that cannot be proven whole is unverified", () => {
  it("a choice row that will not join, a box of the question with a row not known, a read beginning inside the question, one choice and the footer", () => {
    // Cursor's box with a row in it that is none of the question's.
    const cursorRows = cursorTrustFrame.split("\n");
    const quit = cursorRows.findIndex((row) => row.includes("[q] Quit"));
    const extra = [...cursorRows.slice(0, quit + 1), cursorRows[quit]!.replace("[q] Quit", "[r] Remember this choice"), ...cursorRows.slice(quit + 1)].join("\n");
    expect(readStartScreen(extra, "cursor")).toBeNull();
    expect(readStartScreenState(extra, "cursor", lines)).toBe("unverified");
    // Cursor's box once answered ("Trusting workspace..."), before its prompt is drawn: no marker, nothing under it.
    const trusting = cursorTrustFrame.replace("▶ [a] Trust this workspace", "  [a] Trust this workspace").replace("Use arrow keys to navigate, Enter to select, or press the key shown", "⏳ Trusting workspace...                                            ");
    expect(readStartScreenState(trusting, "cursor", lines)).toBe("unverified");
    // Short reads (not full) beginning inside the question: Cursor's and Gemini's boxes, Grok's choices.
    for (const question of questions) {
      const rows = question.frame.split("\n");
      const at = rows.findIndex((row) => /\[a\]|1\. (?:Trust folder|Sign in)|Yes, proceed/.test(row));
      expect([question.screen, readStartScreenState(rows.slice(at).join("\n"), question.kind, lines)]).toEqual([question.screen, "unverified"]);
    }
    // One known choice and Grok's footer, nothing else, short or full.
    expect(readStartScreenState("No, quit  n\n\nGrok Build  1.0.77 [stable]", "grok", lines)).toBe("unverified");
    // Grok's last choice wrapped, the read starting on its last piece.
    expect(readStartScreenState("quit n\nGrok Build  1.0.77 [stable]", "grok", lines)).toBe("unverified");
    expect(readStartScreenState("n\n\nGrok Build  1.0.77 [stable]", "grok", lines)).toBe("unverified");
  });

  it("a whole proven question stays the question", () => {
    for (const question of questions) {
      for (const width of [40, 48, 60, 80, 119, 160]) expect([question.screen, width, stateOf(redraw(question.frame, width), question.kind)]).toEqual([question.screen, width, question.screen]);
    }
  });
});

// MARK: - normal use

describe("normal use: an ordinary prompt under the text stays clear and sends", () => {
  it("fresh and quiet Grok prompts, and output above a prompt, at 200, 400 and 1000 rows", async () => {
    for (const height of [200, 400, 1000]) {
      for (const filler of ["", "previous output"]) {
        const screen = [...Array<string>(height - 2).fill(filler), prompts.grok].join("\n");
        expect(stateOf(screen, "grok")).toBeNull();
        await sends("grok", screen);
      }
    }
  });

  it("Grok 1.0.70's captured idle screen padded to 200, 400 and 1000 rows; Cursor's captured idle screen under its answered trust box", async () => {
    const idle = grokModelScreen("00-idle");
    for (const height of [200, 400, 1000]) {
      const screen = [...Array<string>(Math.max(0, height - idle.split("\n").length)).fill(""), idle].join("\n");
      expect(stateOf(screen, "grok")).toBeNull();
      await sends("grok", screen);
    }
    const cursorIdle = modeScreen("cursor-00-idle");
    expect(stateOf(cursorIdle, "cursor")).toBeNull();
    await sends("cursor", cursorIdle);
  });

  it("wrapped quotations with each agent's prompt under them, at every width", async () => {
    for (const question of questions) {
      for (const width of [40, 48, 50, 60, 80, 119, 160]) {
        const screen = `Here is the old question:\n${redraw(question.frame, width)}\n${prompts[question.kind]}`;
        expect([question.screen, width, stateOf(screen, question.kind)]).toEqual([question.screen, width, null]);
        await sends(question.kind, screen);
      }
    }
  });

  it("separate prose rows holding a title and choices above a prompt", async () => {
    const prose: Record<Kind, readonly string[]> = {
      grok: ["Do you trust the contents of this directory?", "Yes, proceed  y", "No, quit  n"],
      cursor: ["Workspace Trust Required", "Do you trust the contents of this directory?", "▶ [a] Trust this workspace", "[q] Quit"],
      gemini: ["Get started", "How would you like to authenticate for this project?", "● 1. Sign in with Google", "2. Use Gemini API Key", "3. Vertex AI", "Error from last attempt.", "(Use Enter to select)"],
    };
    for (const kind of ["grok", "cursor", "gemini"] as const) {
      const screen = [...prose[kind], prompts[kind]].join("\n");
      expect(stateOf(screen, kind)).toBeNull();
      await sends(kind, screen);
    }
  });
});

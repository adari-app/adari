// Start questions on screens that wrapped, grew tall or changed a status line. The principle: a screen that may be one of these
// questions never gets a byte (matched, or refused as not checkable), and a pane at its ordinary prompt is never refused
// in ordinary use.
// - A question whose rows wrapped (Cursor's box at 60 columns, Gemini's sign-in at 48, Gemini's folder trust
//   with a long folder name at 119) is still the question: the reader joins its own wrapped rows back.
// - Gemini's sign-in picker is the question whatever its one status line says (an error after a failed
//   sign-in), with its Enter hint under it.
// - A Grok screen taller than the read (a 200-row pane, more): the read takes 200 lines, and a read that
//   came back full with the question's choices at its bottom and the title cut off above is not clear: refused.
// - A read the watch asks for while a Send waits on its last snapshot is waited for, so an ordinary prompt
//   gets its Return.
// - The ANSI captures with their original CRLF line endings read as their questions.
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
import {
  cursorTrustFrame,
  cursorTrustFrameAnsiOriginal,
  geminiSignInFrame,
  geminiTrustFrame,
  geminiTrustFrameAnsiOriginal,
  grokTrustFrame,
  grokTrustFrameAnsiOriginal,
} from "./support/start-question-frames";
import { deferred, flush, last, prompts, redraw, startQuestionWorld, tallGrok, type Kind } from "./support/start-question-world";

const questions: readonly { readonly kind: Kind; readonly screen: StartScreenKind; readonly frame: string; readonly title: string }[] = [
  { kind: "grok", screen: "grokTrust", frame: grokTrustFrame, title: "Do you trust the contents of this directory?" },
  { kind: "cursor", screen: "cursorTrust", frame: cursorTrustFrame, title: "Workspace Trust Required" },
  { kind: "gemini", screen: "geminiTrust", frame: geminiTrustFrame, title: "Do you trust the files in this folder?" },
  { kind: "gemini", screen: "geminiSignIn", frame: geminiSignInFrame, title: "Get started" },
];

const longFolder = (width: number) => redraw(geminiTrustFrame.replace("Trust folder (gemini)", `Trust folder (${"customer-project-".repeat(8)})`), width);
/** A made-up error in place of the picker's "No authentication method selected." (not Gemini's own words). */
const geminiError = (error = "Failed to login. Please try again.") => geminiSignInFrame.replace("No authentication method selected.", error);

// MARK: - the readers

describe("a question whose own rows wrapped is still the question", () => {
  it("Cursor's box at 60 columns (its hint and description wrap)", () => {
    const frame = redraw(cursorTrustFrame, 60);
    expect(frame.split("\n").every((row) => Array.from(row).length <= 60)).toBe(true);
    expect(frame).toContain("Use arrow keys to navigate, Enter to select, or press");
    expect(readStartScreen(frame, "cursor")).toBe("cursorTrust");
  });

  it("Gemini's sign-in at 48 columns (its question, terms line and link wrap)", () => {
    const frame = redraw(geminiSignInFrame, 48);
    expect(frame.split("\n").every((row) => Array.from(row).length <= 48)).toBe(true);
    expect(readStartScreen(frame, "gemini")).toBe("geminiSignIn");
  });

  it("Gemini's folder trust with a long folder name at the captured 119 columns (the first choice wraps over 3 rows)", () => {
    const frame = longFolder(119);
    expect(frame.split("\n").every((row) => Array.from(row).length <= 119)).toBe(true);
    expect(readStartScreen(frame, "gemini")).toBe("geminiTrust");
    expect(readStartScreen(longFolder(60), "gemini")).toBe("geminiTrust");
  });

  it("narrower still: every question at 40 and 50 columns; Grok's title and choices wrapped", () => {
    for (const width of [40, 50]) {
      expect(readStartScreen(redraw(cursorTrustFrame, width), "cursor"), `cursor ${width}`).toBe("cursorTrust");
      expect(readStartScreen(redraw(geminiSignInFrame, width), "gemini"), `sign-in ${width}`).toBe("geminiSignIn");
      expect(readStartScreen(redraw(geminiTrustFrame, width), "gemini"), `trust ${width}`).toBe("geminiTrust");
    }
    expect(readStartScreen(["Do you trust the contents of", "this directory?", "/fixture", "", "Yes, proceed", "y", "No, quit  n", "", "Grok Build  1.0.77 [stable]"].join("\n"), "grok")).toBe("grokTrust");
  });

  it("controls kept: 80, 119 and 160 columns (and coloured) read as their questions", () => {
    for (const question of questions) {
      for (const width of [80, 119, 160]) {
        expect(readStartScreen(redraw(question.frame, width), question.kind), `${question.screen} ${width}`).toBe(question.screen);
        expect(readStartScreen(`\u001b[32m${redraw(question.frame, width)}\u001b[0m`, question.kind)).toBe(question.screen);
      }
    }
  });

  it("controls kept: wrapped or not, the question quoted with the agent's prompt under it, cut, or missing a choice is not the question", () => {
    for (const question of questions) {
      for (const frame of [question.frame, redraw(question.frame, 60), redraw(question.frame, 48)]) {
        expect(readStartScreen(`${"old output\n".repeat(100)}Quoted screen:\n${frame}\n${prompts[question.kind]}`, question.kind)).toBeNull();
        const rows = frame.split("\n");
        const title = rows.findIndex((row) => row.includes(question.title));
        expect(readStartScreen(rows.slice(title + 1).join("\n"), question.kind)).toBeNull();
        const choice = rows.findIndex((row) => /Yes, proceed|\[a\]|1\. Trust folder|1\. Sign in/.test(row));
        expect(readStartScreen(rows.filter((_, index) => index !== choice).join("\n"), question.kind)).toBeNull();
      }
      for (const other of ["grok", "cursor", "gemini", "claude", "codex", null]) if (other !== question.kind) expect(readStartScreen(question.frame, other)).toBeNull();
      expect(readStartScreen(prompts[question.kind], question.kind)).toBeNull();
    }
    // A wrapped choice is joined only into its own label: two markers, or a label made up of other words, are not it.
    expect(readStartScreen(redraw(cursorTrustFrame, 60).replace("    [q] Quit", "▶ [q] Quit"), "cursor")).toBeNull();
    expect(readStartScreen(redraw(geminiSignInFrame, 48).replace("2. Use Gemini API Key", "2. Use Gemini API Lock"), "gemini")).toBeNull();
  });
});

describe("Gemini's sign-in picker whatever its one status line says", () => {
  it("an error in place of No authentication method selected. is still the picker", () => {
    expect(readStartScreen(geminiError(), "gemini")).toBe("geminiSignIn");
    expect(readStartScreen(geminiError("Authentication failed: the request timed out. Choose a method and press Enter to try again."), "gemini")).toBe("geminiSignIn");
    // A long one wrapped over two rows at 48 columns.
    expect(readStartScreen(redraw(geminiError("Authentication failed: the request timed out. Choose a method and press Enter to try again."), 48), "gemini")).toBe("geminiSignIn");
    expect(readStartScreen(geminiSignInFrame.replace("   No authentication method selected.", ""), "gemini")).toBe("geminiSignIn");
  });

  it("near misses: a status of text with no Enter hint under it, a choice-like status, or the agent's prompt under the box", () => {
    expect(readStartScreen(geminiError().replace("(Use Enter to select)", "                     "), "gemini")).toBeNull();
    expect(readStartScreen(geminiError("4. Something else"), "gemini")).toBeNull();
    expect(readStartScreen(geminiError("● 4. Something else"), "gemini")).toBeNull();
    expect(readStartScreen(`${geminiError()}\n${prompts.gemini}`, "gemini")).toBeNull();
  });
});

describe("a Grok screen taller than the read is never clear", () => {
  it("a 200-row screen: the 200-line read has the whole question", () => {
    expect(startScreenLines("grok")).toBe(200);
    expect(readStartScreen(tallGrok(200), "grok")).toBe("grokTrust");
    expect(readStartScreenState(last(tallGrok(200), startScreenLines("grok")), "grok", startScreenLines("grok"))).toBe("grokTrust");
    for (const height of [120, 180]) expect(readStartScreenState(last(tallGrok(height), 200), "grok", 200)).toBe("grokTrust");
  });

  it("taller than the read: the choices and version line with the title cut off above a full read are unverified", () => {
    expect(readStartScreenState(last(tallGrok(200), 100), "grok", 100)).toBe("unverified");
    expect(readStartScreenState(last(tallGrok(400), 200), "grok", 200)).toBe("unverified");
    // So tall that the read holds only blank rows and the version line: unverified as well.
    expect(readStartScreenState(last(tallGrok(1000), 200), "grok", 200)).toBe("unverified");
    expect(readStartScreenState(Array<string>(200).fill("").join("\n"), "grok", 200)).toBe("unverified");
    // A read starting inside the question is unverified whether or not it came back full.
    const cut = grokTrustFrame.split("\n").slice(16).join("\n");
    expect(readStartScreenState(cut, "grok", 200)).toBe("unverified");
    // A box cut by a full read above its top edge, with the choices in it: unverified too.
    const box = redraw(geminiSignInFrame, 119).split("\n");
    const choices = box.findIndex((row) => row.includes("1. Sign in with Google"));
    const read = box.slice(choices - 1).join("\n");
    expect(readStartScreenState(read, "gemini", read.split("\n").length)).toBe("unverified");
    expect(readStartScreenState(read, "gemini", 200)).toBe("unverified");
  });

  it("controls: an ordinary prompt read full is clear; the old question above the prompt is not it; Codex's hook review still reads", () => {
    const filler = Array.from({ length: 300 }, (_, index) => `output line ${index}`).join("\n");
    for (const kind of ["grok", "cursor", "gemini"] as const) {
      expect(readStartScreenState(last(`${filler}\n${prompts[kind]}`, 200), kind, 200)).toBeNull();
      const question = questions.find((each) => each.kind === kind)!;
      expect(readStartScreenState(last(`${filler}\n${question.frame}\n${prompts[kind]}`, 200), kind, 200)).toBeNull();
    }
    // A choice row of the question at the bottom with no prompt under it is never clear, whatever the other says.
    expect(readStartScreenState(last(tallGrok(400), 200).replace(/Yes, proceed {2}y/, "Yes, proceed  n"), "grok", 200)).toBe("unverified");
    const hook = ["  Hooks need review", "", "› 1. Review hooks", "  2. Trust all and continue", "  3. Continue without trusting (hooks won't run)", "", "  enter confirm · esc skip"].join("\n");
    expect(readStartScreenState(hook, "codex", 40)).toBe("codexHookReview");
    expect(readStartScreenState(hook.split("\n").slice(1).join("\n"), "codex", 6)).toBeNull();
  });
});

describe("the ANSI captures with their original CRLF line endings", () => {
  it("read as their questions", () => {
    expect(grokTrustFrameAnsiOriginal.split("\r\n")).toHaveLength(40);
    expect(grokTrustFrameAnsiOriginal.replace(/\r\n/g, "").includes("\n")).toBe(false);
    expect(readStartScreen(grokTrustFrameAnsiOriginal, "grok")).toBe("grokTrust");
    expect(readStartScreen(cursorTrustFrameAnsiOriginal, "cursor")).toBe("cursorTrust");
    expect(readStartScreen(geminiTrustFrameAnsiOriginal, "gemini")).toBe("geminiTrust");
  });
});

// MARK: - a machine: the real watch and guard on a real HostRegistry, main's real IPC handler (start-question-world.ts)

const world = (kind: Kind) => startQuestionWorld(kind, registered.handles);

describe("wrapped, re-labelled and tall questions through main's real IPC handler: refused before any byte", () => {
  it.each([
    ["Cursor at 60 columns", "cursor", redraw(cursorTrustFrame, 60), startScreenNotSent("cursor", "cursorTrust")],
    ["Gemini's sign-in at 48 columns", "gemini", redraw(geminiSignInFrame, 48), startScreenNotSent("gemini", "geminiSignIn")],
    ["Gemini's folder trust with a long folder name", "gemini", longFolder(119), startScreenNotSent("gemini", "geminiTrust")],
    ["Gemini's sign-in with an error", "gemini", geminiError(), startScreenNotSent("gemini", "geminiSignIn")],
    ["Grok on a 200-row screen", "grok", tallGrok(200), startScreenNotSent("grok", "grokTrust")],
    ["Grok on a 400-row screen (taller than the read)", "grok", tallGrok(400), startScreenNotSent("grok", null)],
    ["Grok on a 1000-row screen (only blank rows and its version line read)", "grok", tallGrok(1000), startScreenNotSent("grok", null)],
  ] as const)("%s", async (_name, kind, frame, note) => {
    const w = await world(kind);
    w.screens.set("w1:p1", frame);
    await expect(w.send("Reply with exactly one word: pong")).rejects.toThrow(note);
    expect(w.writes()).toEqual([]);
  });

  it("the watch never marks a cut question (unverified), and keeps its last mark through one", async () => {
    const w = await world("grok");
    w.screens.set("w1:p1", tallGrok(400));
    w.tickNow();
    await flush();
    expect(w.service.showing("mini", "w1:p1")).toBeNull();
    w.screens.set("w1:p1", tallGrok(200));
    w.tickNow();
    await flush();
    expect(w.service.showing("mini", "w1:p1")).toBe("grokTrust");
    w.screens.set("w1:p1", tallGrok(400));
    w.tickNow();
    await flush();
    expect(w.service.showing("mini", "w1:p1")).toBe("grokTrust");
    expect(w.writes()).toEqual([]);
  });

  it("an ordinary prompt read full (200 lines of output above it) sends", async () => {
    for (const kind of ["grok", "cursor", "gemini"] as const) {
      const w = await world(kind);
      w.screens.set("w1:p1", `${Array.from({ length: 300 }, (_, index) => `output ${index}`).join("\n")}\n${prompts[kind]}`);
      await w.send("hello");
      expect(w.writes().map((call) => call[0])).toEqual(["text", "keys"]);
    }
  });
});

describe("a read asked for during the last snapshot is waited for; an ordinary prompt gets its Return", () => {
  it.each(["cursor", "gemini", "grok"] as const)("%s: the snapshot answers before the newer read; the read then answers the prompt: the Return goes", async (kind) => {
    const w = await world(kind);
    const snapshot = deferred<void>();
    const newer = deferred<string>();
    let finalSnapshot = false;
    w.onText(() => {
      w.onSnapshot(() => {
        if (finalSnapshot) return;
        finalSnapshot = true;
        w.onRead(() => newer.promise);
        w.tickNow();
        return snapshot.promise;
      });
    });
    const result = w.send("hello").then(
      () => null,
      (error: Error) => error.message,
    );
    await flush();
    expect(finalSnapshot).toBe(true);
    expect(w.writes().map((call) => call[0])).toEqual(["text"]);
    snapshot.resolve();
    await flush();
    expect(w.writes().map((call) => call[0]), "no Return while the newer read is out").toEqual(["text"]);
    newer.resolve(prompts[kind]);
    await flush();
    expect({ error: await result, writes: w.writes().map((call) => call[0]) }).toEqual({ error: null, writes: ["text", "keys"] });
  });

  it.each(["failed", "question", "reconnect"] as const)("cursor: that newer read %s: no Return", async (mode) => {
    const w = await world("cursor");
    const snapshot = deferred<void>();
    const newer = deferred<string>();
    let finalSnapshot = false;
    w.onText(() => {
      w.onSnapshot(() => {
        if (finalSnapshot) return;
        finalSnapshot = true;
        w.onRead(() => newer.promise);
        w.tickNow();
        return snapshot.promise;
      });
    });
    const result = w.send("hello").then(
      () => null,
      (error: Error) => error.message,
    );
    await flush();
    snapshot.resolve();
    await flush();
    if (mode === "failed") newer.reject(new Error("fake failure"));
    else {
      if (mode === "reconnect") w.setEpoch(2);
      newer.resolve(mode === "question" ? cursorTrustFrame : prompts.cursor);
    }
    expect(await result).toMatch(/no Return was pressed/);
    expect(w.writes().map((call) => call[0])).toEqual(["text"]);
  });
});

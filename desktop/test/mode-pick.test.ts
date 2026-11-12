// The four Permissions drivers (src/main/herdr/mode-pick.ts)
// against the agents as the reference recorded them (support/mode-agents.ts):
// every target from every start within bound, Cursor's cross-toggle, Codex's
// Full Access confirmation answered only inside the pick (anything else: Esc
// and a refusal), the user's own Terminal input mid-pick stops it with no further
// key, a busy pane or a box with text refuses, the result read off the screen.
// The same cases as Tests/HerdrKitTests/ApprovalModeDriverTests.swift.

import { describe, expect, it } from "vitest";

import { codexConfirmShowing, driveModePick, modePickTexts, modeSettleReads, pickModeBound, type ModeIO } from "../src/main/herdr/mode-pick";
import { cursorPickTexts, pickTypedMeanwhile } from "../src/main/herdr/send";
import { cursorMenuScreen } from "./support/cursor-menu-fixtures";
import { FakeClaude, FakeCodex, FakeCursor, FakeGrok, type FakeAgent } from "./support/mode-agents";
import { modeScreen } from "./support/mode-fixtures";

/** The pane's IO over a fake agent; `stopAfter`: the user's Terminal input after that many writes. */
function io(agent: FakeAgent, stopAfter = Infinity): ModeIO & { reads: number } {
  const state = { reads: 0 };
  return Object.assign(state, {
    read: async () => {
      state.reads += 1;
      return agent.screen();
    },
    type: async (text: string) => agent.type(text),
    keys: async (keys: readonly string[]) => agent.keys(keys),
    check: () => (agent.writes.length >= stopAfter ? pickTypedMeanwhile : null),
    wait: async () => undefined,
  });
}

const cycleCases = (order: readonly string[]) => order.flatMap((start) => order.map((target) => [start, target] as const));

describe("Claude Code: Shift+Tab, reading its footer after each press", () => {
  it.each(cycleCases(FakeClaude.order))("from %s to %s within four presses", async (start, target) => {
    const claude = new FakeClaude(start);
    const done = await driveModePick(io(claude), "claude", target);
    expect(done.result).toEqual({ type: "set", mode: target });
    expect(claude.mode).toBe(target);
    expect(claude.writes.every((write) => write === "BTab")).toBe(true);
    expect(claude.writes.length).toBe((FakeClaude.order.indexOf(target) - FakeClaude.order.indexOf(start) + 4) % 4);
    expect(claude.writes.length).toBeLessThanOrEqual(4);
  });

  it("a press that changes nothing stops there: one press, the screen's mode", async () => {
    const claude = new FakeClaude("auto");
    claude.stuck = true;
    const done = await driveModePick(io(claude), "claude", "plan");
    expect(done.result).toEqual({ type: "refused", note: modePickTexts.cycleStopped("claude"), mode: "auto" });
    expect(claude.writes).toEqual(["BTab"]);
  });

  it("a mode it never reaches in four presses: refused with the mode it shows", async () => {
    const claude = new FakeClaude("auto");
    claude.skips = true;
    const done = await driveModePick(io(claude), "claude", "manual");
    expect(done.result).toEqual({ type: "refused", note: modePickTexts.cycleBound("claude"), mode: "auto" });
    expect(claude.writes).toHaveLength(4);
  });

  it("the user's draft in the box: nothing pressed", async () => {
    const claude = new FakeClaude("auto");
    claude.draft = "fix the shed door";
    const done = await driveModePick(io(claude), "claude", "plan");
    expect(done.result).toEqual({ type: "refused", note: modePickTexts.draft("claude"), mode: "auto" });
    expect(claude.writes).toEqual([]);
  });

  it("bypass is never a target", async () => {
    const claude = new FakeClaude("auto");
    expect((await driveModePick(io(claude), "claude", "bypass")).result).toEqual({ type: "refused", note: modePickTexts.notOffered, mode: null });
    expect(claude.writes).toEqual([]);
  });

  // Every route is kept; a pick stopped on a mode more permissive than
  // both its start and its target shows that mode with a warning, and nothing more is pressed.
  it("Manual to Plan passes Accept edits: stopped after its first key, the warning names it, no further key", async () => {
    const claude = new FakeClaude("manual");
    const done = await driveModePick(io(claude, 1), "claude", "plan");
    expect(done.result).toEqual({ type: "refused", note: modePickTexts.passed("Accept edits", "you typed in Terminal"), mode: "acceptEdits", warning: true });
    expect(claude.writes).toEqual(["BTab"]);
    expect(claude.mode).toBe("acceptEdits");
  });

  it("Manual to Plan with nothing in the way: the route is kept", async () => {
    const claude = new FakeClaude("manual");
    expect((await driveModePick(io(claude), "claude", "plan")).result).toEqual({ type: "set", mode: "plan" });
    expect(claude.writes).toEqual(["BTab", "BTab"]);
  });

  it("a stop on a mode that allows no more than the start: no warning", async () => {
    const claude = new FakeClaude("auto");
    const done = await driveModePick(io(claude, 1), "claude", "plan");
    expect(done.result).toEqual({ type: "refused", note: modePickTexts.stopped(pickTypedMeanwhile), mode: "manual" });
  });

  it("a press followed by an unreadable screen: unknown, never the mode before it", async () => {
    const claude = new FakeClaude("auto");
    const ops = io(claude);
    ops.read = async () => (claude.writes.length > 0 ? "a dialog with no mode" : claude.screen());
    const done = await driveModePick(ops, "claude", "manual");
    expect(done.result).toEqual({ type: "refused", note: modePickTexts.cycleStopped("claude"), mode: null, unknown: true });
    expect(claude.writes).toEqual(["BTab"]);
  });

  it("a press whose box reads but shows no mode word: unknown", async () => {
    const claude = new FakeClaude("auto");
    const ops = io(claude);
    ops.read = async () => (claude.writes.length > 0 ? claude.screen().replace("manual mode on", "something else on") : claude.screen());
    const done = await driveModePick(ops, "claude", "manual");
    expect(done.result).toEqual({ type: "refused", note: modePickTexts.cycleStopped("claude"), mode: null, unknown: true });
  });

  it("the user's Terminal input after a press, the screen then unreadable: unknown", async () => {
    const claude = new FakeClaude("auto");
    const ops = io(claude, 1);
    let reads = 0;
    ops.read = async () => (++reads > 3 ? "a dialog with no mode" : claude.screen());
    const done = await driveModePick(ops, "claude", "plan");
    expect(done.result).toMatchObject({ type: "refused", mode: null, unknown: true });
    expect(claude.writes).toEqual(["BTab"]);
  });

  it("bypass as the start: read-only, refused before any key", async () => {
    const bypass = modeScreen("claude-00-start").replace("auto mode on", "bypass permissions on");
    const writes: string[] = [];
    const still: ModeIO = {
      read: async () => bypass,
      type: async (text) => void writes.push(`type ${text}`),
      keys: async (keys) => void writes.push(keys.join(",")),
      check: () => null,
      wait: async () => undefined,
    };
    for (const target of ["manual", "acceptEdits", "plan", "auto"]) {
      const done = await driveModePick(still, "claude", target);
      expect(done.result).toEqual({ type: "refused", note: modePickTexts.bypassStart, mode: "bypass" });
    }
    expect(writes).toEqual([]);
  });

  it("the user's typing in its Terminal mid-pick: no further key", async () => {
    const claude = new FakeClaude("auto");
    const done = await driveModePick(io(claude, 1), "claude", "plan");
    expect(done.result).toEqual({ type: "refused", note: modePickTexts.stopped(pickTypedMeanwhile), mode: "manual" });
    expect(claude.writes).toEqual(["BTab"]);
  });
});

describe("Grok: Shift+Tab, reading its border after each press", () => {
  it.each(cycleCases(FakeGrok.order))("from %s to %s within four presses", async (start, target) => {
    const grok = new FakeGrok(start);
    const done = await driveModePick(io(grok), "grok", target);
    expect(done.result).toEqual({ type: "set", mode: target });
    expect(grok.writes.every((write) => write === "BTab")).toBe(true);
    expect(grok.writes.length).toBe((FakeGrok.order.indexOf(target) - FakeGrok.order.indexOf(start) + 4) % 4);
  });

  it.each([
    [1, "autoReview", "Auto-review"],
    [2, "alwaysApprove", "Always-approve"],
  ] as const)("Plan to Supervised stopped after key %i: %s shown with the warning, no further key", async (keys, mode, label) => {
    const grok = new FakeGrok("plan");
    const done = await driveModePick(io(grok, keys), "grok", "default");
    expect(done.result).toEqual({ type: "refused", note: modePickTexts.passed(label, "you typed in Terminal"), mode, warning: true });
    expect(grok.writes).toEqual(Array(keys).fill("BTab"));
    expect(grok.mode).toBe(mode);
  });

  it("Plan to Supervised stopped by its screen past a key: the warning too", async () => {
    const grok = new FakeGrok("plan");
    const ops = io(grok);
    // After the first press its border stops changing (a dialog took Shift+Tab).
    ops.keys = async (keys) => {
      grok.keys(keys);
      grok.stuck = true;
    };
    const done = await driveModePick(ops, "grok", "default");
    expect(done.result).toEqual({ type: "refused", note: modePickTexts.passed("Auto-review", "Grok Build's mode did not change as expected"), mode: "autoReview", warning: true });
  });

  it("the user's draft: nothing pressed", async () => {
    const grok = new FakeGrok("default");
    grok.draft = "ship it";
    expect((await driveModePick(io(grok), "grok", "plan")).result).toEqual({ type: "refused", note: modePickTexts.draft("grok"), mode: "default" });
    expect(grok.writes).toEqual([]);
  });
});

describe("Cursor: /auto-review and /run-everything, reading its model row", () => {
  const modes = ["default", "autoReview", "runEverything"] as const;
  const cases = modes.flatMap((start) => modes.map((target) => [start, target] as const));
  it.each(cases)("from %s to %s within two commands", async (start, target) => {
    const cursor = new FakeCursor(start);
    const done = await driveModePick(io(cursor), "cursor", target);
    expect(done.result.type).toBe("set");
    expect(done.result.type === "set" ? done.result.mode : null).toBe(target);
    expect(cursor.mode).toBe(target);
    const commands = cursor.writes.filter((write) => write.startsWith("type "));
    expect(commands.length).toBeLessThanOrEqual(2);
    // Each command typed, then Enter alone.
    for (let index = 0; index < cursor.writes.length; index += 2) {
      expect(cursor.writes[index]).toMatch(/^type \/(auto-review|run-everything)$/);
      expect(cursor.writes[index + 1]).toBe("Enter");
    }
  });

  it("Auto-review to Run Everything turns both off first: two /run-everything", async () => {
    const cursor = new FakeCursor("autoReview");
    const done = await driveModePick(io(cursor), "cursor", "runEverything");
    expect(done.result.type === "set" && done.result.mode).toBe("runEverything");
    expect(cursor.writes).toEqual(["type /run-everything", "Enter", "type /run-everything", "Enter"]);
  });

  it("Run Everything to Auto-review is one /auto-review", async () => {
    const cursor = new FakeCursor("runEverything");
    await driveModePick(io(cursor), "cursor", "autoReview");
    expect(cursor.writes).toEqual(["type /auto-review", "Enter"]);
  });

  it("its list highlighting another command: Esc, the command taken back, nothing entered", async () => {
    const cursor = new FakeCursor("default");
    cursor.wrongHighlight = true;
    const done = await driveModePick(io(cursor), "cursor", "runEverything");
    expect(done.result).toMatchObject({ type: "refused", note: modePickTexts.cursorUnexpected, mode: "default" });
    expect(cursor.writes).toEqual(["type /run-everything", "Escape", Array(15).fill("Backspace").join(",")]);
    expect(cursor.draft).toBe("");
  });

  // Esc only on the list of the command it typed, read fresh.
  it("after its command is typed, a screen that is not its own list (the model selector, a list for other text, an unknown screen): no key after the typing", async () => {
    expect(modePickTexts.cursorElsewhere).toBe(cursorPickTexts.elsewhere);
    const other = new FakeCursor("default");
    other.type("/run");
    const foreign: [string, string][] = [
      ["the model selector", cursorMenuScreen("selector")],
      ["its list holding other text", other.screen()],
      ["an unknown screen", "  Something Cursor has not shown before"],
    ];
    for (const [name, shown] of foreign) {
      const cursor = new FakeCursor("default");
      const base = io(cursor);
      let reads = 0;
      const done = await driveModePick({ ...base, read: async () => ((reads += 1) === 3 ? shown : cursor.screen()) }, "cursor", "runEverything");
      expect(cursor.writes, name).toEqual(["type /run-everything"]);
      expect(done.result, name).toMatchObject({ type: "refused", note: modePickTexts.cursorElsewhere });
    }
  });

  it("Enter that changes nothing: refused with the row's word", async () => {
    const cursor = new FakeCursor("default");
    cursor.deaf = true;
    const done = await driveModePick(io(cursor), "cursor", "autoReview");
    expect(done.result).toMatchObject({ type: "refused", mode: null });
    expect(cursor.writes).toEqual(["type /auto-review", "Enter"]);
  });

  it("while it works: busy, nothing typed", async () => {
    const working = { writes: [] as string[], screen: () => cursorMenuScreen("stream-00019"), type: () => undefined, keys: () => undefined };
    expect((await driveModePick(io(working), "cursor", "autoReview")).result).toEqual({ type: "busy" });
  });

  it("the user's draft: nothing typed", async () => {
    const cursor = new FakeCursor("default");
    cursor.draft = "rename it";
    expect((await driveModePick(io(cursor), "cursor", "autoReview")).result).toMatchObject({ type: "refused", note: modePickTexts.draft("cursor"), mode: "default" });
    expect(cursor.writes).toEqual([]);
  });

  it("the user's typing in its Terminal after the command: no Enter", async () => {
    const cursor = new FakeCursor("default");
    const done = await driveModePick(io(cursor, 1), "cursor", "autoReview");
    expect(done.result).toMatchObject({ type: "refused", note: modePickTexts.stopped(pickTypedMeanwhile) });
    expect(cursor.writes).toEqual(["type /auto-review"]);
  });
});

describe("Codex: /permissions, its list, the target's digit", () => {
  const modes = ["ask", "approve", "full", "readOnly"];
  const digits: Record<string, string> = { ask: "1", approve: "2", full: "3", readOnly: "4" };
  it.each(cycleCases(modes))("from %s to %s", async (start, target) => {
    const codex = new FakeCodex(start);
    const done = await driveModePick(io(codex), "codex", target);
    expect(done.result).toEqual({ type: "set", mode: target });
    expect(codex.mode).toBe(target);
    expect(codex.escOnBox).toBe(0);
    if (start === target) expect(codex.writes).toEqual(["type /permissions", "Enter", "Escape"]);
    else if (target === "full") expect(codex.writes).toEqual(["type /permissions", "Enter", "3", "1"]);
    else expect(codex.writes).toEqual(["type /permissions", "Enter", digits[target]]);
  });

  it("Full Access's confirmation drawn otherwise: Esc out, nothing confirmed", async () => {
    const codex = new FakeCodex("ask");
    codex.oddConfirm = true;
    const done = await driveModePick(io(codex), "codex", "full");
    expect(done.result).toEqual({ type: "refused", note: modePickTexts.codexConfirm, mode: "ask" });
    expect(codex.writes).not.toContain("1");
    expect(codex.mode).toBe("ask");
    expect(codex.view).toBe("box");
    expect(codex.escOnBox).toBe(0);
  });

  it("a confirmation for another pick: Esc out, never answered", async () => {
    const codex = new FakeCodex("ask");
    codex.confirmsAll = true;
    const done = await driveModePick(io(codex), "codex", "approve");
    expect(done.result).toEqual({ type: "refused", note: modePickTexts.codexUnasked, mode: "ask" });
    expect(codex.writes).toEqual(["type /permissions", "Enter", "2", "Escape", "Escape"]);
    expect(codex.mode).toBe("ask");
    expect(codex.escOnBox).toBe(0);
  });

  it.each(["readOnly", "full"])("a narrow two-row list: Esc before any digit, nothing picked (target %s)", async (target) => {
    const codex = new FakeCodex("ask");
    codex.rows = codex.rows.filter((row) => row.mode === "ask" || row.mode === "full");
    const done = await driveModePick(io(codex), "codex", target);
    expect(done.result).toEqual({ type: "refused", note: modePickTexts.codexListShape, mode: null });
    expect(codex.writes).toEqual(["type /permissions", "Enter", "Escape"]);
    expect(codex.mode).toBe("ask");
    expect(codex.view).toBe("box");
    expect(codex.escOnBox).toBe(0);
  });

  it("a list with a row's words changed: Esc before any digit", async () => {
    const codex = new FakeCodex("ask");
    codex.rows = codex.rows.map((row) => (row.mode === "approve" ? { ...row, words: "Approves everything it can" } : row));
    const done = await driveModePick(io(codex), "codex", "approve");
    expect(done.result).toEqual({ type: "refused", note: modePickTexts.codexListShape, mode: null });
    expect(codex.writes).toEqual(["type /permissions", "Enter", "Escape"]);
    expect(codex.mode).toBe("ask");
  });

  it("a third option in its confirmation: Esc, nothing confirmed", async () => {
    const codex = new FakeCodex("ask");
    const ops = io(codex);
    ops.read = async () =>
      codex.view === "confirm" ? codex.screen().replace("  enter select \u{B7} esc back", "  3. Unrecorded option\n  enter select \u{B7} esc back") : codex.screen();
    const done = await driveModePick(ops, "codex", "full");
    expect(done.result).toEqual({ type: "refused", note: modePickTexts.codexConfirm, mode: "ask" });
    expect(codex.writes).toEqual(["type /permissions", "Enter", "3", "Escape", "Escape"]);
    expect(codex.mode).toBe("ask");
    expect(codex.view).toBe("box");
    expect(codex.escOnBox).toBe(0);
  });

  it("Enter that opens no list: the command taken back, no Esc on its box", async () => {
    const codex = new FakeCodex("ask");
    codex.deaf = true;
    const done = await driveModePick(io(codex), "codex", "approve");
    expect(done.result).toEqual({ type: "refused", note: modePickTexts.codexList, mode: null });
    expect(codex.writes).toEqual(["type /permissions", "Enter", Array(12).fill("Backspace").join(",")]);
    expect(codex.draft).toBe("");
    expect(codex.escOnBox).toBe(0);
  });

  it("an old row naming the target is no acknowledgement: not confirmed, unknown, no key to re-check", async () => {
    const codex = new FakeCodex("approve");
    codex.history = "Permission selection requested: Ask for approval";
    codex.dropsDigit = true;
    const done = await driveModePick(io(codex), "codex", "ask");
    expect(done.result).toEqual({ type: "refused", note: modePickTexts.codexUnconfirmed, mode: null, unknown: true });
    expect(codex.writes).toEqual(["type /permissions", "Enter", "1"]);
    expect(codex.mode).toBe("approve");
  });

  it("a new row like an older one is this pick's acknowledgement", async () => {
    const codex = new FakeCodex("approve");
    codex.earlier = "Permission selection requested: Ask for approval";
    expect((await driveModePick(io(codex), "codex", "ask")).result).toEqual({ type: "set", mode: "ask" });
    expect(codex.writes).toEqual(["type /permissions", "Enter", "1"]);
  });

  describe("Codex's box read as Herdr's recent 80 lines, its oldest rows scrolling out", () => {
    const ask = "\u{2022} Permission selection requested: Ask for approval";
    const approve = "\u{2022} Permission selection requested: Approve for me";
    const base = modeScreen("codex-02-digit-1").split("\n");
    const below = base.slice(base.indexOf(ask) + 1);
    /** The pane's recent 80 lines: `history`, then (once its digit went) a new Ask row, then the box. */
    const bounded = (codex: FakeCodex, history: string[]): ModeIO => {
      const ops = io(codex);
      ops.read = async () => {
        if (codex.view !== "box") return codex.screen();
        const rows = [...history, ...(codex.writes.includes("1") ? ["", ask] : []), ...below].slice(-80);
        expect(rows).toHaveLength(80);
        const raw = rows.join("\n");
        return codex.draft === "" ? raw : raw.replace("\u{203A} Ask Codex to do anything", `\u{203A} ${codex.draft}`);
      };
      return ops;
    };
    const filler = (rows: number): string[] => Array<string>(rows).fill("  earlier output");

    it("a new Ask row while an old Ask row scrolls out: set, no key more", async () => {
      const codex = new FakeCodex("approve");
      const done = await driveModePick(bounded(codex, [ask, ...filler(80 - below.length - 2), approve]), "codex", "ask");
      expect(done.result).toEqual({ type: "set", mode: "ask" });
      expect(codex.writes).toEqual(["type /permissions", "Enter", "1"]);
    });

    it("two Ask rows before and two after, the oldest gone: not telling new from old, not confirmed, no key more", async () => {
      const codex = new FakeCodex("approve");
      const done = await driveModePick(bounded(codex, [ask, ...filler(80 - below.length - 2), ask]), "codex", "ask");
      expect(done.result).toEqual({ type: "refused", note: modePickTexts.codexUnconfirmed, mode: null, unknown: true });
      expect(codex.writes).toEqual(["type /permissions", "Enter", "1"]);
    });
  });

  it("Full Access's own row after its confirmation is new to the pick", async () => {
    const codex = new FakeCodex("ask");
    codex.earlier = "Permissions updated to Full Access";
    expect((await driveModePick(io(codex), "codex", "full")).result).toEqual({ type: "set", mode: "full" });
  });

  it("after its digit the screen does not read: unknown until its next turn", async () => {
    const codex = new FakeCodex("ask");
    const ops = io(codex);
    ops.read = async () => (codex.writes.includes("2") ? "a dialog with no box" : codex.screen());
    const done = await driveModePick(ops, "codex", "approve");
    expect(done.result).toEqual({ type: "refused", note: modePickTexts.codexNotShown, mode: null, unknown: true });
  });

  it("the user's draft: nothing typed", async () => {
    const codex = new FakeCodex("ask");
    codex.draft = "what changed?";
    expect((await driveModePick(io(codex), "codex", "approve")).result).toEqual({ type: "refused", note: modePickTexts.draft("codex"), mode: null });
    expect(codex.writes).toEqual([]);
  });

  it("a multiline draft whose first line is blank: nothing typed", async () => {
    const codex = new FakeCodex("ask");
    const ops = io(codex);
    ops.read = async () => codex.screen().replace("\u{203A} Ask Codex to do anything", "\u{203A} \n  a continued user draft");
    expect((await driveModePick(ops, "codex", "approve")).result).toEqual({ type: "refused", note: modePickTexts.draft("codex"), mode: null });
    expect(codex.writes).toEqual([]);
  });

  it("a multiline draft: nothing typed", async () => {
    const codex = new FakeCodex("ask");
    codex.draft = "fix the shed door";
    codex.continued = ["and the gate"];
    expect((await driveModePick(io(codex), "codex", "approve")).result).toEqual({ type: "refused", note: modePickTexts.draft("codex"), mode: null });
    expect(codex.writes).toEqual([]);
  });

  it("the user's words under the typed command: no Enter, nothing taken back", async () => {
    const codex = new FakeCodex("ask");
    const ops = io(codex);
    ops.read = async () => {
      if (codex.writes.length > 0) codex.continued = ["and their words"];
      return codex.screen();
    };
    expect((await driveModePick(ops, "codex", "approve")).result).toEqual({ type: "refused", note: modePickTexts.codexList, mode: null });
    expect(codex.writes).toEqual(["type /permissions"]);
    expect(codex.draft).toBe("/permissions");
  });

  it("Enter that opens no list, the user's words then under the command: nothing taken back", async () => {
    const codex = new FakeCodex("ask");
    codex.deaf = true;
    const ops = io(codex);
    ops.read = async () => {
      if (codex.writes.includes("Enter")) codex.continued = ["and their words"];
      return codex.screen();
    };
    expect((await driveModePick(ops, "codex", "approve")).result).toEqual({ type: "refused", note: modePickTexts.codexList, mode: null });
    expect(codex.writes).toEqual(["type /permissions", "Enter"]);
  });

  it("the user's typing in its Terminal before the digit: the list left, no digit", async () => {
    const codex = new FakeCodex("ask");
    const done = await driveModePick(io(codex, 2), "codex", "full");
    expect(done.result).toEqual({ type: "refused", note: modePickTexts.stopped(pickTypedMeanwhile), mode: null });
    expect(codex.writes).toEqual(["type /permissions", "Enter"]);
  });

  it("the result is Codex's own history row", async () => {
    const codex = new FakeCodex("approve");
    const done = await driveModePick(io(codex), "codex", "ask");
    expect(done.screen).toContain("\u{2022} Permission selection requested: Ask for approval");
  });

  it("its confirmation shows only above the newest history row", () => {
    expect(codexConfirmShowing(modeScreen("codex-04-full-access-confirm"))).toBe(true);
    expect(codexConfirmShowing(modeScreen("codex-00-start"))).toBe(false);
    expect(codexConfirmShowing(modeScreen("codex-02-digit-1"))).toBe(false);
  });
});

describe("a bound pick (main)", () => {
  type Pane = import("../src/main/herdr/wire").TopologyPaneInfo;
  type Agent = import("../src/main/herdr/wire").AgentInfo;
  function site(agent: FakeAgent, kind: string, status = "idle") {
    const pane = { paneID: "w1:p1", terminalID: "term-1", workspaceID: "w1", tabID: "w1:t1", focused: false, agent: kind, agentStatus: status, revision: 1 } as unknown as Pane;
    const info = { paneID: "w1:p1", agent: kind, agentStatus: status } as unknown as Agent;
    return {
      writer: { sendText: async (_pane: string, text: string) => agent.type(text) } as never,
      calls: { paneRead: async () => agent.screen(), paneSendKeys: async (_pane: string, keys: readonly string[]) => agent.keys(keys) },
      fresh: async () => true,
      pane: () => pane,
      agent: () => info,
      run: () => ({ connection: 3, arrival: 2 }),
    };
  }
  const binding = (kind: string) => ({ terminalID: "term-1", isAgent: true, kind, session: null, run: { connection: 3, arrival: 2 } });
  const now = async () => undefined;

  it("goes in the pane's turn at its prompt", async () => {
    const claude = new FakeClaude("auto");
    expect((await pickModeBound(site(claude, "claude"), "w1:p1", "claude", "plan", binding("claude"), now)).result).toEqual({ type: "set", mode: "plan" });
    expect(claude.writes).toEqual(["BTab", "BTab", "BTab"]);
  });

  it("a busy pane: held, nothing read or pressed", async () => {
    const grok = new FakeGrok("default");
    expect((await pickModeBound(site(grok, "grok", "working"), "w1:p1", "grok", "plan", binding("grok"), now)).result).toEqual({ type: "busy" });
    expect(grok.writes).toEqual([]);
  });

  it("another agent's binding or another run: refused, nothing pressed", async () => {
    const codex = new FakeCodex("ask");
    expect((await pickModeBound(site(codex, "codex"), "w1:p1", "codex", "full", binding("claude"), now)).result.type).toBe("refused");
    expect((await pickModeBound(site(codex, "codex"), "w1:p1", "codex", "full", { ...binding("codex"), run: { connection: 3, arrival: 1 } }, now)).result.type).toBe("refused");
    expect(codex.writes).toEqual([]);
  });
});

describe("the read right before each key is fresh", () => {
  const dialog = "Do you want to proceed?\n\u{276F} 1. Yes\n  2. No\n\nEsc to cancel";

  it.each([
    ["claude", () => new FakeClaude("auto"), "manual"],
    ["grok", () => new FakeGrok("default"), "plan"],
  ] as const)("%s: a draft that arrives on the second read (the one right before Shift+Tab) sends no key", async (agent, make, target) => {
    const fake = make();
    const ops = io(fake);
    let reads = 0;
    ops.read = async () => {
      if (++reads === 2) fake.draft = "user draft";
      return fake.screen();
    };
    const done = await driveModePick(ops, agent, target);
    expect(done.result.type).toBe("refused");
    expect(fake.writes).toEqual([]);
    expect(reads).toBe(2);
  });

  it.each([
    ["claude", () => new FakeClaude("auto"), "manual"],
    ["grok", () => new FakeGrok("default"), "plan"],
  ] as const)("%s: a dialog that shows on the second read sends no key", async (agent, make, target) => {
    const fake = make();
    const ops = io(fake);
    let reads = 0;
    ops.read = async () => (++reads >= 2 ? dialog : fake.screen());
    const done = await driveModePick(ops, agent, target);
    expect(done.result).toEqual({ type: "refused", note: modePickTexts.cycleStopped(agent), mode: null });
    expect(fake.writes).toEqual([]);
  });

  it("Codex: its list changing between the read that chose the row and the digit: Esc, no digit", async () => {
    const codex = new FakeCodex("ask");
    const ops = io(codex);
    let listReads = 0;
    ops.read = async () => {
      if (codex.view === "list" && ++listReads === 2) codex.mode = "readOnly";
      return codex.screen();
    };
    const done = await driveModePick(ops, "codex", "approve");
    expect(done.result).toEqual({ type: "refused", note: modePickTexts.codexMoved, mode: "ask" });
    expect(codex.writes).toEqual(["type /permissions", "Enter", "Escape"]);
  });

  it("Codex: its confirmation changing before its answer: Esc, nothing confirmed", async () => {
    const codex = new FakeCodex("ask");
    const ops = io(codex);
    let confirmReads = 0;
    ops.read = async () => {
      if (codex.view === "confirm" && ++confirmReads >= 2) return codex.screen().replace("Apply full access for this session", "Apply full access for every session");
      return codex.screen();
    };
    const done = await driveModePick(ops, "codex", "full");
    expect(done.result).toEqual({ type: "refused", note: modePickTexts.codexConfirm, mode: "ask" });
    expect(codex.writes).toEqual(["type /permissions", "Enter", "3", "Escape", "Escape"]);
    expect(codex.mode).toBe("ask");
  });

  it("Codex: its box changing after the reads that found no list, before the cleanup's Backspaces: nothing taken back", async () => {
    const codex = new FakeCodex("ask");
    codex.deaf = true;
    const ops = io(codex);
    let after = 0;
    ops.read = async () => {
      if (codex.writes.includes("Enter") && ++after > modeSettleReads) codex.continued = ["and their words"];
      return codex.screen();
    };
    const done = await driveModePick(ops, "codex", "approve");
    expect(done.result).toEqual({ type: "refused", note: modePickTexts.codexList, mode: null });
    expect(codex.writes).toEqual(["type /permissions", "Enter"]);
    expect(after).toBe(modeSettleReads + 1);
  });
});

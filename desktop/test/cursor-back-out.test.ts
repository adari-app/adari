// A Cursor pick that backs out sends Esc only after a fresh read positively
// recognizes the menu this pick opened (its `/model` list, the selector
// after its Enter, Edit Parameters after its Tab). An unknown, unreadable or
// foreign screen after any read stops with no key and a note. The same cases
// and results as Tests/HerdrKitTests/CursorBackOutTests.swift.

import { describe, expect, it } from "vitest";

import { DemoCursorMenu } from "../src/main/demo/demo-cursor-menu";
import { cursorPickTexts, driveCursorPick, type CursorMenuIO } from "../src/main/herdr/send";
import { readCursorScreen, type CursorPick } from "../src/shared/agent-settings";
import type { CursorPickResult } from "../src/shared/ipc-contract";
import { cursorMenuScreen } from "./support/cursor-menu-fixtures";

const head = cursorMenuScreen("model-00002").split("\n").slice(0, 10);
const folder = "/Users/demo/shed-plan";
const other = "  Something Cursor has not shown before";
/** cursorPickTexts.elsewhere, spelled out (the test keeps its own copy of the text). */
const elsewhere = "Not set: Cursor showed something else, so nothing more was pressed. Check Terminal.";
const down = (count: number): string[] => Array.from({ length: count }, () => "Down");

/** The fake Cursor pane; `glitch` puts another screen in a read's place (null: the read throws); every write logged, and how many had gone at each read. */
async function drive(pick: CursorPick, glitch: (read: number, screen: string) => string | null = (_read, screen) => screen): Promise<{ result: CursorPickResult; log: string[]; writesAtRead: number[]; menu: DemoCursorMenu }> {
  const menu = new DemoCursorMenu(head, folder);
  const log: string[] = [];
  const writesAtRead: number[] = [];
  const io: CursorMenuIO = {
    read: async () => {
      writesAtRead.push(log.length);
      const shown = glitch(writesAtRead.length, menu.screen());
      if (shown === null) throw new Error("unreadable");
      return shown;
    },
    type: async (text) => {
      log.push(`type ${text}`);
      menu.type(text);
    },
    keys: async (keys) => {
      log.push(keys.join(","));
      menu.keys(keys);
    },
    check: () => null,
  };
  const done = await driveCursorPick(io, pick);
  return { result: done.result, log, writesAtRead, menu };
}

describe("a Cursor pick backs out only from its own menu, read fresh", () => {
  it("the note says to check Terminal", () => {
    expect(cursorPickTexts.elsewhere).toBe(elsewhere);
  });

  const picks: { pick: CursorPick; reads: number }[] = [
    { pick: { kind: "effort", value: "high" }, reads: 13 },
    { pick: { kind: "fast", value: true }, reads: 15 },
    { pick: { kind: "model" }, reads: 4 },
  ];
  for (const { pick, reads } of picks) {
    it(`${JSON.stringify(pick)}: an unknown screen after each of its ${reads} reads sends no key after it`, async () => {
      const clean = await drive(pick);
      expect(clean.writesAtRead.length).toBe(reads);
      for (let read = 1; read <= reads; read += 1) {
        const done = await drive(pick, (count, shown) => (count === read ? other : shown));
        expect(done.log, `read ${read}: no key after it`).toEqual(clean.log.slice(0, done.writesAtRead[read - 1]));
        expect(done.writesAtRead.length, `read ${read}: nothing read after it either`).toBe(read);
        expect(done.result, `read ${read}`).toEqual({ type: "refused", note: read === 1 ? cursorPickTexts.noFooter : elsewhere, footer: null });
      }
    });
  }

  it("a read that does not answer, at each step: no key after it", async () => {
    const pick: CursorPick = { kind: "effort", value: "high" };
    const clean = await drive(pick);
    for (let read = 1; read <= 13; read += 1) {
      const done = await drive(pick, (count, shown) => (count === read ? null : shown));
      expect(done.log, `read ${read}`).toEqual(clean.log.slice(0, done.writesAtRead[read - 1]));
      expect(done.result, `read ${read}`).toEqual({ type: "refused", note: cursorPickTexts.unanswered, footer: null });
    }
  });

  it("a Cursor menu this pick had not opened yet (the selector before its Enter, Edit Parameters before its Tab): no Esc", async () => {
    const selector = cursorMenuScreen("selector");
    const parameters = cursorMenuScreen("edit-parameters");
    expect(readCursorScreen(selector)).toEqual({ kind: "models", current: "Grok 4.7" });
    expect(readCursorScreen(parameters).kind).toBe("parameters");
    const early = await drive({ kind: "effort", value: "high" }, (count, shown) => (count === 2 ? selector : shown));
    expect(early.log).toEqual(["type /model"]);
    expect(early.result).toEqual({ type: "refused", note: elsewhere, footer: null });
    const skipped = await drive({ kind: "effort", value: "high" }, (count, shown) => (count === 4 ? parameters : shown));
    expect(skipped.log).toEqual(["type /model", "Enter"]);
    expect(skipped.result).toEqual({ type: "refused", note: elsewhere, footer: null });
  });

  it("backing out reads after each Esc: its own menu gets Esc, then an unknown screen stops it", async () => {
    const done = await drive({ kind: "effort", value: "high" }, (count, shown) => {
      if (count === 6) return shown.replace("  \u{2192} \u{25CF} 256K", "    \u{25CF} 256K").replace("    \u{25CB} Low", "  \u{2192} \u{25CB} Low");
      return count === 7 ? other : shown;
    });
    expect(done.log).toEqual(["type /model", "Enter", "Tab", "Down", "Escape"]);
    expect(done.result).toEqual({ type: "refused", note: elsewhere, footer: null });
    expect(done.menu.state.stage).toBe("models");
  });

  // Another model's Edit Parameters after the target's Enter is not this pick's menu.
  it("another model's Edit Parameters after the target's Enter (same rows, target chosen): no Esc after it, not set", async () => {
    const foreign = (shown: string) => shown.replace("Grok 4.7 \u{2014} Edit Parameters", "Other model \u{2014} Edit Parameters");
    expect(readCursorScreen(foreign(cursorMenuScreen("edit-parameters")))).toMatchObject({ kind: "parameters", model: "Other model" });
    const cases: { pick: CursorPick; read: number }[] = [
      { pick: { kind: "effort", value: "high" }, read: 11 },
      { pick: { kind: "fast", value: true }, read: 13 },
      { pick: { kind: "context", value: "500K" }, read: 8 },
    ];
    for (const { pick, read } of cases) {
      const clean = await drive(pick);
      const done = await drive(pick, (count, shown) => (count === read ? foreign(shown) : shown));
      expect(done.log, JSON.stringify(pick)).toEqual(clean.log.slice(0, done.writesAtRead[read - 1]));
      expect(done.log.at(-1)).toBe("Enter");
      expect(done.result, JSON.stringify(pick)).toEqual({ type: "refused", note: elsewhere, footer: null });
    }
  });

  it("its own menus, recognized on a fresh read, still back out as before: Esc to the box, /model taken back", async () => {
    const listed = await drive({ kind: "effort", value: "high" }, (count, shown) =>
      count === 2 ? shown.replace("   \u{2192} /model [filter]", "     /model [filter]").replace("     /model-usage", "   \u{2192} /model-usage") : shown,
    );
    expect(listed.log).toEqual(["type /model", "Escape", "Backspace,Backspace,Backspace,Backspace,Backspace,Backspace"]);
    const chosen = await drive({ kind: "effort", value: "high" }, (count, shown) =>
      count === 11 ? shown.replace("\u{25CF} High \u{2713}", "\u{25CB} High").replace("\u{25CB} Medium", "\u{25CF} Medium \u{2713}") : shown,
    );
    expect(chosen.log).toEqual(["type /model", "Enter", "Tab", ...down(4), "Enter", "Escape", "Escape"]);
    for (const done of [listed, chosen]) {
      expect(done.menu.state.stage).toBe("box");
      expect(done.menu.state.draft).toBe("");
      expect(done.result).toMatchObject({ type: "refused", note: cursorPickTexts.unexpected });
    }
  });
});

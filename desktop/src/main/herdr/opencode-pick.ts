// An OpenCode model pick on a running pane, driven in main as one checked
// sequence through OpenCode's own list (send.ts driveCursorPick is the model),
// every key made here from the machine's list (the page sends only the pane and
// the model's id):
//
//   `/models` typed and read back twice, Return; "Select model" waited for;
//   the model's display name typed and the search read back; the rows read:
//   exactly one row of that exact name whose provider is the model's
//   (letters and digits, case ignored), Down to it one row at a time (the
//   rows read after each key, unchanged), read again, Return; "Select
//   variant" (a model with variants) answered with Return on Default; then
//   the footer must read that name.
//
// Anything else at any step (no list, rows that cannot be told apart, a screen
// this does not know, a wait that runs out): Esc until the prompt is back
// (at least one; at most openCodeEscLimit), nothing more, and the note says
// what happened. `/models` typed but not run is taken back with Backspaces
// first, only while the box holds exactly it. Nothing goes unless the first
// read shows OpenCode's box empty under a footer that reads, and Herdr says
// it is idle: a pick never starts while it works or waits on a question.
//
// Every exit after the list was opened, a stop (the user's Terminal input, the
// pane changing) or a failed read or write too, ends in one bounded cleanup
// that reads the screen again (a failed read retried openCodeCleanupReads
// times) and, while OpenCode's list is what shows and the pane is still the
// same OpenCode and run, closes it with Esc until the prompt is back. The
// user's Terminal input does not call the cleanup off (the list is read on
// screen first); a pane whose agent or run changed gets no key at all.

import type { OpenCodePickResult } from "../../shared/ipc-contract";
import { footerNames, openCodeModelsCommand, readOpenCodeScreen, sameProvider, type OpenCodeModelRow, type OpenCodeScreen } from "../../shared/opencode-screen";
import type { SendBinding } from "../../shared/send-binding";
import { runChangedText } from "../../shared/send-binding";
import { atPrompt, cursorKeys, cursorPickReadLines, inPaneTurn, mismatch, noReturnWhy, pickCheck, sameRun, type CursorMenuIO, type CursorPickSite } from "./send";

/** The pane's screen and keys, the check before each write, and the pause between reads. */
export interface OpenCodePickIO extends CursorMenuIO {
  wait(): Promise<void>;
  /**
   * The check before a cleanup key: the same pane, agent and run only (the user's Terminal input
   * does not stop a cleanup of the list this pick opened; the list is read on screen first). Absent: `check`.
   */
  owned?(): string | null;
}

/** What the pick types and looks for: the model's id, its display name and its provider's id (main's list's). */
export interface OpenCodeTarget {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
}

/** Reads (each after a pause) before a screen that does not come is given up. */
export const openCodeSettleReads = 8;
/** Between them (main's pause; the tests wait for nothing). */
export const openCodeSettleMs = 250;
/** Esc presses at most when backing out. */
export const openCodeEscLimit = 4;
/** Reads a cleanup tries (a pause between) before it gives up on seeing the screen. */
export const openCodeCleanupReads = 3;

/** An OpenCode pick's words (the menu's line). */
export const openCodePickTexts = {
  notIdle: "Not set: OpenCode's model can be picked when OpenCode is idle.",
  noBox: "Not set: OpenCode's box is not on its screen now (a dialog or a list). Check its terminal.",
  draft: "Not set: OpenCode's box has text in it. Send or clear it, then pick again.",
  notTyped: "Not set: OpenCode's box did not show /models as typed",
  noList: "Not set: OpenCode's model list did not open",
  noSearch: "Not set: OpenCode's list did not show the model's name as typed",
  noRow: (name: string) => `Not set: OpenCode's list shows no row ${name} of its provider`,
  several: (name: string) => `Not set: OpenCode's list shows more than one ${name} it cannot tell apart`,
  moved: "Not set: OpenCode's list changed while the pick moved in it",
  noVariant: "Not set: OpenCode's variant list did not show Default first",
  unknown: "Not set: OpenCode showed a screen this app does not know",
  notShown: (footer: string | null) => (footer === null ? "Not set: OpenCode's footer does not show the model now" : `Not set: OpenCode's footer says ${footer}`),
  closed: "so it was closed with Esc.",
  takenBack: "so /models was taken back and the list closed with Esc.",
  notClosed: "and it did not come back to its prompt after Esc. Check its terminal.",
  leftInBox: "and its box was left as it is. Check its terminal.",
  unanswered: "Not set: the pane did not answer. Check its terminal.",
  failedRead: "Not set: the pane did not answer",
  listGone: "and OpenCode's list is closed.",
  stopped: (why: string) => `Not set: ${why}. Check its terminal.`,
  running: "Not set: a model pick is still on its way in this pane.",
} as const;

class OpenCodeStop extends Error {
  constructor(readonly why: string) {
    super(why);
  }
}

const sameRows = (a: readonly OpenCodeModelRow[] | null, b: readonly OpenCodeModelRow[] | null): boolean =>
  a !== null && b !== null && a.length === b.length && a.every((row, index) => row.name === b[index]!.name && row.provider === b[index]!.provider);

/**
 * Drives OpenCode's own list for one pick (the steps above). Resolves with the result and the last screen read
 * (null: none); never throws.
 */
export async function driveOpenCodePick(io: OpenCodePickIO, target: OpenCodeTarget): Promise<{ readonly result: OpenCodePickResult; readonly screen: string | null }> {
  let last: string | null = null;
  let screen = { kind: "other" } as OpenCodeScreen;
  const look = async (): Promise<OpenCodeScreen> => {
    last = await io.read();
    screen = readOpenCodeScreen(last);
    return screen;
  };
  const done = (result: OpenCodePickResult) => ({ result, screen: last });
  // From the Return after `/models` on, OpenCode's list may be open: every exit cleans up.
  let opened = false;
  const refused = (note: string) => done({ type: "refused", note });
  const write = async (action: () => Promise<void>): Promise<void> => {
    const why = io.check();
    if (why !== null) throw new OpenCodeStop(why);
    await action();
  };
  /** Reads until `wanted` says the screen is there, at most openCodeSettleReads (a pause before each but the first). */
  const until = async (wanted: (read: OpenCodeScreen) => boolean): Promise<boolean> => {
    for (let read = 0; read < openCodeSettleReads; read += 1) {
      if (read > 0) await io.wait();
      if (wanted(await look())) return true;
    }
    return false;
  };
  /**
   * Back out: `/models` typed and not run taken back (Backspaces, only while the box holds exactly it), then Esc until
   * the prompt is back and empty (at least one Esc, at most openCodeEscLimit), nothing more. The note: why, and how.
   */
  const backOut = async (why: string, typedOnly = false) => {
    let tookBack = false;
    if (typedOnly) {
      const now = await look();
      if (now.kind === "prompt" && now.draft === openCodeModelsCommand) {
        await write(() => io.keys(Array.from({ length: openCodeModelsCommand.length }, () => cursorKeys.backspace)));
        tookBack = true;
      }
    }
    for (let press = 0; press < openCodeEscLimit; press += 1) {
      await write(() => io.keys([cursorKeys.escape]));
      const now = await look();
      if (now.kind === "prompt" && now.empty) return refused(`${why}, ${tookBack ? openCodePickTexts.takenBack : openCodePickTexts.closed}`);
      if (now.kind === "prompt") return refused(`${why}, ${openCodePickTexts.leftInBox}`);
    }
    return refused(`${why}, ${openCodePickTexts.notClosed}`);
  };
  try {
    let first: OpenCodeScreen;
    try {
      first = await look();
    } catch {
      return refused(openCodePickTexts.unanswered);
    }
    if (first.kind !== "prompt" || first.footer === null) return refused(openCodePickTexts.noBox);
    if (!first.empty) return refused(openCodePickTexts.draft);
    if (footerNames(first.footer, target.name, target.provider)) return done({ type: "set", model: target.id, label: target.name });
    // `/models`, read back twice (the second right before Return): the box holds exactly it.
    await write(() => io.type(openCodeModelsCommand));
    const typed = (read: OpenCodeScreen): boolean => read.kind === "prompt" && read.draft === openCodeModelsCommand;
    if (!typed(await look()) || !typed(await look())) return await backOut(openCodePickTexts.notTyped, true);
    await write(async () => {
      opened = true;
      await io.keys([cursorKeys.enter]);
    });
    // "Select model", its search empty.
    if (!(await until((read) => read.kind === "models" && read.search === null))) return await backOut(openCodePickTexts.noList);
    await write(() => io.type(target.name));
    const searched = (read: OpenCodeScreen): boolean => read.kind === "models" && read.search === target.name && read.rows !== null;
    if (!(await until(searched))) return await backOut(screen.kind === "models" ? openCodePickTexts.noSearch : openCodePickTexts.unknown);
    // The rows read twice the same (the list settled on the search), then the one row of that name and provider.
    let rows = screen.kind === "models" ? screen.rows : null;
    const again = await look();
    if (!searched(again) || again.kind !== "models" || !sameRows(again.rows, rows)) return await backOut(openCodePickTexts.moved);
    rows = again.rows!;
    const named = rows.map((row, index) => ({ row, index })).filter(({ row }) => row.name === target.name && sameProvider(target.provider, row.provider));
    if (named.length === 0) return await backOut(openCodePickTexts.noRow(target.name));
    if (named.length > 1) return await backOut(openCodePickTexts.several(target.name));
    // The list is OpenCode's own: the highlight starts on the first row; each Down moves it one row (the rows read
    // after every key, unchanged), then a read right before Return.
    const goal = named[0]!.index;
    const still = (read: OpenCodeScreen): boolean => read.kind === "models" && read.search === target.name && sameRows(read.rows, rows);
    for (let step = 0; step < goal; step += 1) {
      await write(() => io.keys([cursorKeys.down]));
      if (!still(await look())) return await backOut(openCodePickTexts.moved);
    }
    if (!still(await look())) return await backOut(openCodePickTexts.moved);
    await write(() => io.keys([cursorKeys.enter]));
    // Its variants (Return on Default), or the prompt at once.
    if (!(await until((read) => read.kind === "variants" || (read.kind === "prompt" && read.footer !== null)))) return await backOut(openCodePickTexts.unknown);
    if (screen.kind === "variants") {
      if (screen.search !== null || screen.rows[0] !== "Default") return await backOut(openCodePickTexts.noVariant);
      // Read again right before Return: still the variant list, Default first.
      const ready = await look();
      if (ready.kind !== "variants" || ready.search !== null || ready.rows[0] !== "Default") return await backOut(openCodePickTexts.noVariant);
      await write(() => io.keys([cursorKeys.enter]));
      if (!(await until((read) => read.kind === "prompt" && read.footer !== null))) return await backOut(openCodePickTexts.unknown);
    }
    // The footer names it (a moment for it to redraw).
    const shown = (read: OpenCodeScreen): boolean => read.kind === "prompt" && read.footer !== null && footerNames(read.footer, target.name, target.provider);
    if (shown(screen) || (await until(shown))) return done({ type: "set", model: target.id, label: target.name });
    const footer = screen.kind === "prompt" ? screen.footer : null;
    return await backOut(openCodePickTexts.notShown(footer));
  } catch (error) {
    const stopped = error instanceof OpenCodeStop;
    if (!opened) return refused(stopped ? openCodePickTexts.stopped(error.why) : openCodePickTexts.unanswered);
    return await cleanUp(stopped ? `Not set: ${error.why}` : openCodePickTexts.failedRead);
  }

  /**
   * The bounded, screen-aware cleanup of the list this pick opened. The screen is read again
   * (a failed read retried, openCodeCleanupReads in all); while it shows OpenCode's model or variant list and the pane
   * is still the same OpenCode and run (`owned`, checked right before each key), Esc, then read, until the prompt is
   * back (at most openCodeEscLimit). Anything else (the prompt already back, a screen not known, the pane changed, the
   * reads failing) gets no key; the note says what happened.
   */
  async function cleanUp(why: string) {
    const owned = (): string | null => (io.owned ?? io.check)();
    const readAgain = async (): Promise<OpenCodeScreen | null> => {
      for (let attempt = 0; attempt < openCodeCleanupReads; attempt += 1) {
        if (attempt > 0) await io.wait();
        try {
          return await look();
        } catch {
          // Read again.
        }
      }
      return null;
    };
    try {
      for (let press = 0; ; press += 1) {
        const now = await readAgain();
        if (now === null) return refused(`${why}, ${openCodePickTexts.notClosed}`);
        if (now.kind === "prompt") {
          if (press > 0 && now.empty) return refused(`${why}, ${openCodePickTexts.closed}`);
          return refused(`${why}, ${now.empty ? openCodePickTexts.listGone : openCodePickTexts.leftInBox}`);
        }
        if ((now.kind !== "models" && now.kind !== "variants") || press >= openCodeEscLimit || owned() !== null) {
          return refused(`${why}, ${openCodePickTexts.notClosed}`);
        }
        await io.keys([cursorKeys.escape]);
      }
    } catch {
      return refused(`${why}, ${openCodePickTexts.notClosed}`);
    }
  }
}

/** The panes with an OpenCode pick under way (one at a time per pane). */
const running = new Set<string>();

/**
 * An OpenCode pick bound to the pane the user chose, in the pane's send turn: a fresh snapshot must still show the
 * pane, terminal, OpenCode and run the user saw, idle (never while it works or waits on a question: refused, not held),
 * else nothing is written; then driveOpenCodePick, every write checked on the latest snapshot (the same pane, terminal,
 * agent, session and run; no typing in its Terminal since). One pick per pane at a time: another is refused.
 */
export async function pickOpenCodeBound(
  site: CursorPickSite,
  paneID: string,
  target: OpenCodeTarget,
  expected: SendBinding,
  wait: () => Promise<void> = () => new Promise((resolve) => setTimeout(resolve, openCodeSettleMs)),
  key: string = paneID,
): Promise<{ readonly result: OpenCodePickResult; readonly screen: string | null }> {
  const refused = (note: string) => ({ result: { type: "refused", note } as OpenCodePickResult, screen: null });
  if (running.has(key)) return refused(openCodePickTexts.running);
  running.add(key);
  try {
    return await inPaneTurn(site.writer, paneID, async () => {
      if (expected.kind !== "opencode" || !expected.isAgent || expected.run === undefined) return refused(runChangedText(expected));
      if (!(await site.fresh())) return refused("Not set: the app could not check that OpenCode is still in its pane.");
      if (!sameRun(expected, site)) return refused(runChangedText(expected));
      const found = mismatch(expected, site.pane(), site.agent());
      if (found !== null) return refused(`Not set: ${noReturnWhy[found]}.`);
      if (!atPrompt(site.pane(), site.agent())) return refused(openCodePickTexts.notIdle);
      const started = site.inputGeneration?.();
      const read = (): Promise<string> => site.calls.paneRead(paneID, cursorPickReadLines);
      return driveOpenCodePick(
        {
          read: () => (site.reading === undefined ? read() : site.reading(read)),
          type: (text) => site.writer.sendText(paneID, text),
          keys: (keys) => site.calls.paneSendKeys(paneID, keys),
          // The lists are OpenCode's own while it stays idle; Herdr's word for them is not counted on (as Cursor's).
          check: pickCheck(site, expected, started, false),
          // A cleanup key's check: the pane, agent and run only (no Terminal input counted).
          owned: pickCheck(site, expected, undefined, false),
          wait,
        },
        target,
      );
    });
  } finally {
    running.delete(key);
  }
}

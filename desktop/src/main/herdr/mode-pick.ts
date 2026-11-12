// A Permissions pick, driven by the agent's own keys or
// command, reading the screen before every key and after it (never counting
// keys blind), the way T3 Code switches a runtime mode but through each
// agent's own Terminal UI:
//
// - Claude Code and Grok: Shift+Tab (tmux's BTab) cycles their modes; at most
//   cyclePressLimit presses, each only after a read shows the same mode and
//   an empty box, each followed by reads until the mode changed. Anything
//   else stops the cycle where it is (nothing more is pressed).
// - Cursor: `/auto-review` or `/run-everything` typed and read back (its
//   command list with it highlighted, or the box holding exactly it) twice,
//   the second right before Enter; then reads until its model row's word
//   changed. At most cursorCommandLimit commands (Auto-review to Run
//   Everything turns both off first). Anything else backs out: Esc until the
//   box shows, the command taken back with Backspaces only when the box holds
//   exactly it.
// - Codex: `/permissions` typed and read back twice, Enter, its list read
//   (four rows, `(current)`), the target's own digit alone (no Enter). Full
//   Access: its confirmation, exactly as recorded, answered `1` inside the
//   same pick, else Esc out and refused. The result is Codex's own history
//   row naming the mode. Esc only while its list or confirmation shows
//   (never on its box: Esc there primes its backtrack).
//
// Nothing goes unless the first read shows the agent's box empty at its
// prompt (Cursor: not working); `check` runs before every write (the same
// pane, terminal, agent, session and run, no typing in its Terminal since the
// pick began); a refusal stops every key. The result is the mode the screen
// showed last. The same steps as Sources/HerdrKit ApprovalModeDriver.

import type { ModePickResult } from "../../shared/ipc-contract";
import { knownAgentName } from "../../shared/agent-names";
import {
  allowsMore,
  approvalMode,
  bypassStartNote,
  codexAcknowledgements,
  codexListShowing,
  codexNewAcknowledgement,
  codexHistoryMode,
  codexPermissionsCommand,
  cursorCommandLimit,
  cursorModeCommand,
  cyclePassing,
  cyclePressLimit,
  isOfferedMode,
  readClaudeModeScreen,
  readCodexScreen,
  shiftTabKey,
  type CodexScreen,
  type ModeAgent,
} from "../../shared/approval-modes";
import { cursorFooterMode, readCursorScreen, readGrokScreen, type CursorFooter, type CursorScreen } from "../../shared/agent-settings";
import type { SendBinding } from "../../shared/send-binding";
import { runChangedText } from "../../shared/send-binding";
import {
  atPrompt,
  cursorKeys,
  cursorPickReadLines,
  inPaneTurn,
  mismatch,
  noReturnWhy,
  pickCheck,
  pickTypedMeanwhile,
  sameRun,
  type CursorMenuIO,
  type CursorPickSite,
} from "./send";

/** The pane's screen and keys for one pick, the check before each write, and the pause between settle reads. */
export interface ModeIO extends CursorMenuIO {
  wait(): Promise<void>;
}

/** Reads after a key before a change that does not show is given up. */
export const modeSettleReads = 8;
/** Between them (main's pause; the tests wait for nothing). */
export const modeSettleMs = 250;

// The shared table's names ("Grok Build", "Cursor Agent").
const agentNames: Record<ModeAgent, string> = { claude: knownAgentName("claude")!, codex: knownAgentName("codex")!, grok: knownAgentName("grok")!, cursor: knownAgentName("cursor")! };

/** A Permissions pick's words (the chip's note). */
export const modePickTexts = {
  notOffered: "Not set: that is not one of the menu's choices.",
  bypassStart: bypassStartNote,
  noBox: (agent: ModeAgent) => `Not set: ${agentNames[agent]}'s box is not on its screen now (a dialog or a list). Check its terminal.`,
  draft: (agent: ModeAgent) => `Not set: ${agentNames[agent]}'s box has text in it. Send or clear it, then pick again.`,
  noMode: (agent: ModeAgent) => `Not set: ${agentNames[agent]}'s screen does not show its mode now. Check its terminal.`,
  cycleStopped: (agent: ModeAgent) => `Not set: ${agentNames[agent]}'s mode did not change as expected, so nothing more was pressed. Check its terminal.`,
  cycleBound: (agent: ModeAgent) => `Not set: ${agentNames[agent]}'s mode did not come round to it in ${cyclePressLimit} presses of Shift+Tab.`,
  cursorUnexpected: "Not set: Cursor did not show its command as expected, so it was taken back.",
  /** A screen that is not its own command's list: nothing more was pressed. */
  cursorElsewhere: "Not set: Cursor showed something else, so nothing more was pressed. Check Terminal.",
  cursorNotShown: "Not set: Cursor's model row did not show the change.",
  cursorBound: `Not set: Cursor did not reach it in ${cursorCommandLimit} commands.`,
  codexList: "Not set: Codex's permissions list did not show as expected, so nothing was picked.",
  codexNoRow: (label: string) => `Not set: Codex's list does not offer ${label} here, so it was closed with Esc.`,
  codexMoved: "Not set: Codex's list changed before the pick, so it was closed with Esc.",
  codexListShape: "Not set: Codex's permissions list was not the one this app knows (its four rows as recorded), so it was closed with Esc and nothing was picked.",
  codexConfirm: "Not set: Codex's Full Access confirmation did not show as recorded, so it was closed with Esc and nothing was confirmed.",
  codexUnasked: "Not set: Codex asked to confirm Full Access for another pick, so it was closed with Esc and nothing was confirmed.",
  codexNotShown: "Not set: Codex did not show the change, so the chip shows what its last turn says.",
  codexUnconfirmed: "Not confirmed yet: Codex did not show a new line saying it took the change, so the chip shows Permissions until its next turn says.",
  unanswered: "Not set: the pane did not answer. Check its terminal.",
  stopped: (why: string) => `Not set: ${why}. Check its terminal.`,
  /** A pick stopped on a mode more permissive than both its start and its target. */
  passed: (label: string, reason: string) => `Stopped at ${label} because ${reason}. It is still on; pick again.`,
  /** The same, its mode not reading after the stop. */
  passedUnread: (agent: ModeAgent, reason: string) =>
    `Stopped because ${reason}, past a mode that allows more than the one picked, and ${agentNames[agent]}'s mode does not read now. Check its terminal and pick again.`,
} as const;

class ModeStop extends Error {
  constructor(readonly why: string) {
    super(why);
  }
}

type Done = { readonly result: ModePickResult; readonly screen: string | null };

/** What a driver does to the pane: every write checked first (`check`), every read kept as the last screen. */
interface Ops {
  look(): Promise<string>;
  type(text: string): Promise<void>;
  keys(keys: readonly string[]): Promise<void>;
  wait(): Promise<void>;
  /** A key that may change the mode went (Shift+Tab, Cursor's Enter, Codex's digit or its confirmation). */
  moved(): void;
}

/** One pick toward `target`, by the agent's own way (see above). Resolves with the result and the last screen read (null: none). */
export async function driveModePick(io: ModeIO, agent: ModeAgent, target: string): Promise<Done> {
  if (!isOfferedMode(agent, target)) return { result: { type: "refused", note: modePickTexts.notOffered, mode: null }, screen: null };
  let last: string | null = null;
  let moved = false;
  // The mode a Shift+Tab pick started from (its route is kept; a stop past a mode allowing more warns).
  const route: { start: string | null } = { start: null };
  const checked = async (action: () => Promise<void>): Promise<void> => {
    const why = io.check();
    if (why !== null) throw new ModeStop(why);
    await action();
  };
  const ops: Ops = {
    look: async () => {
      last = await io.read();
      return last;
    },
    type: (text) => checked(() => io.type(text)),
    keys: (keys) => checked(() => io.keys(keys)),
    wait: () => io.wait(),
    moved: () => {
      moved = true;
    },
  };
  const name = agentNames[agent];
  try {
    const result =
      agent === "claude" || agent === "grok" ? await cycle(agent, target, ops, route) : agent === "cursor" ? await cursor(target, ops) : await codex(target, ops);
    if (result.type !== "refused") return { result, screen: last };
    const reason =
      result.note === modePickTexts.cycleBound(agent) ? `${name}'s mode did not come round to it in ${cyclePressLimit} presses` : `${name}'s mode did not change as expected`;
    return { result: passing(agent, target, route.start, moved, result, reason), screen: last };
  } catch (error) {
    // The mode as the last read showed it (none for Codex: its screen does not show one).
    const mode = last === null ? null : shownMode(agent, last);
    const note = error instanceof ModeStop ? modePickTexts.stopped(error.why) : modePickTexts.unanswered;
    // After a key that may have changed it, a screen with no mode is an unknown mode.
    const result: ModePickResult = moved && mode === null ? unknown(note) : { type: "refused", note, mode };
    const reason = !(error instanceof ModeStop) ? "the pane did not answer" : error.why === pickTypedMeanwhile ? "you typed in Terminal" : error.why;
    return { result: passing(agent, target, route.start, moved, result, reason), screen: last };
  }
}

/**
 * Every route is kept: a Shift+Tab pick refused past a key on a mode that allows more than both its start and its
 * target, or with no mode reading past such a route, says so plainly and the chip warns. No key goes after the stop
 * (the user's input may be why).
 */
function passing(agent: ModeAgent, target: string, start: string | null, moved: boolean, result: ModePickResult, reason: string): ModePickResult {
  if (result.type !== "refused" || !moved || start === null || (agent !== "claude" && agent !== "grok")) return result;
  if (result.mode !== null) {
    if (!allowsMore(agent, result.mode, start, target)) return result;
    return { type: "refused", note: modePickTexts.passed(approvalMode(agent, result.mode)?.label ?? result.mode, reason), mode: result.mode, warning: true };
  }
  if (cyclePassing(agent, start, target).length === 0) return result;
  return { type: "refused", note: modePickTexts.passedUnread(agent, reason), mode: null, unknown: true, warning: true };
}

const refused = (note: string, mode: string | null, footer?: CursorFooter | null): ModePickResult =>
  footer === undefined ? { type: "refused", note, mode } : { type: "refused", note, mode, footer };

/** Refused with the mode not known (a key went and the screen did not read after it). */
const unknown = (note: string, footer?: CursorFooter | null): ModePickResult =>
  footer === undefined ? { type: "refused", note, mode: null, unknown: true } : { type: "refused", note, mode: null, footer, unknown: true };

/** Claude's or Grok's box (empty or not) and mode on a screen; null when its box is not there. */
function cycleScreen(agent: "claude" | "grok", screen: string): { readonly empty: boolean; readonly mode: string | null } | null {
  if (agent === "claude") {
    const read = readClaudeModeScreen(screen);
    return read === null ? null : { empty: read.empty, mode: read.mode };
  }
  const read = readGrokScreen(screen);
  return read === null ? null : { empty: read.draft === "", mode: read.mode };
}

/** The mode a screen shows for the agent (null: none reads; Codex's screen shows none). */
function shownMode(agent: ModeAgent, screen: string): string | null {
  if (agent === "claude" || agent === "grok") return cycleScreen(agent, screen)?.mode ?? null;
  if (agent === "cursor") {
    const read = readCursorScreen(screen);
    return read.kind === "box" && read.footer !== null ? cursorFooterMode(read.footer) : null;
  }
  return null;
}

// MARK: - Claude Code and Grok: Shift+Tab

async function cycle(agent: "claude" | "grok", target: string, ops: Ops, route: { start: string | null }): Promise<ModePickResult> {
  const first = cycleScreen(agent, await ops.look());
  if (first === null) return refused(modePickTexts.noBox(agent), null);
  if (!first.empty) return refused(modePickTexts.draft(agent), first.mode);
  if (first.mode === null) return refused(modePickTexts.noMode(agent), null);
  // A mode the cycle does not reach (Claude's bypass, as it was started): read-only, no key.
  if (approvalMode(agent, first.mode)?.offered !== true) return refused(modePickTexts.bypassStart, first.mode);
  let current = first.mode;
  if (current === target) return { type: "set", mode: current };
  route.start = current;
  for (let press = 0; press < cyclePressLimit; press += 1) {
    // Read again right before the key: the same mode, the box still empty.
    const before = cycleScreen(agent, await ops.look());
    if (before === null || !before.empty || before.mode !== current) {
      // Past a press, a screen with no mode is an unknown mode.
      const seen = before?.mode ?? null;
      return press > 0 && seen === null ? unknown(modePickTexts.cycleStopped(agent)) : refused(modePickTexts.cycleStopped(agent), seen);
    }
    await ops.keys([shiftTabKey]);
    ops.moved();
    // "Unchanged and readable" (it still shows `current`) is not "unreadable or the box gone" (unknown).
    let next: { readonly empty: boolean; readonly mode: string | null } | undefined;
    let unreadable = false;
    for (let read = 0; read < modeSettleReads; read += 1) {
      const now = cycleScreen(agent, await ops.look());
      if (now === null) {
        unreadable = true;
        break;
      }
      if (now.mode !== current) {
        next = now;
        break;
      }
      await ops.wait();
    }
    if (unreadable) return unknown(modePickTexts.cycleStopped(agent));
    if (next === undefined) return refused(modePickTexts.cycleStopped(agent), current);
    if (next.mode === null) return unknown(modePickTexts.cycleStopped(agent));
    if (!next.empty) return refused(modePickTexts.cycleStopped(agent), next.mode);
    current = next.mode;
    if (current === target) return { type: "set", mode: current };
  }
  return refused(modePickTexts.cycleBound(agent), current);
}

// MARK: - Cursor: its toggle commands

async function cursor(target: string, ops: Ops): Promise<ModePickResult> {
  let screen: CursorScreen = readCursorScreen(await ops.look());
  if (screen.kind !== "box" || screen.footer === null) return refused(modePickTexts.noBox("cursor"), null);
  if (screen.working) return { type: "busy" };
  if (!screen.empty) return refused(modePickTexts.draft("cursor"), cursorFooterMode(screen.footer), screen.footer);
  let footer: CursorFooter = screen.footer;
  let current = cursorFooterMode(footer);
  if (current === null) return refused(modePickTexts.noMode("cursor"), null, footer);
  if (current === target) return { type: "set", mode: current, footer };
  let typed: string | null = null;
  const look = async (): Promise<CursorScreen> => readCursorScreen(await ops.look());
  /**
   * Esc until the box shows (its list closes); the command taken back only when the box holds exactly it.
   * Esc only on the list of the command it typed, read fresh; any other screen (Cursor's model
   * menus, a list for other text, an unknown screen) stops with no key.
   */
  const backOut = async (note: string): Promise<ModePickResult> => {
    for (let round = 0; round < 4; round += 1) {
      if (screen.kind === "box") {
        if (typed !== null && screen.draft === typed) {
          const length = typed.length;
          typed = null;
          await ops.keys(Array<string>(length).fill(cursorKeys.backspace));
          screen = await look();
          continue;
        }
        return refused(note, screen.footer === null ? null : cursorFooterMode(screen.footer), screen.footer);
      }
      if (screen.kind !== "commands" || typed === null || screen.draft !== typed) return refused(modePickTexts.cursorElsewhere, null, null);
      await ops.keys([cursorKeys.escape]);
      screen = await look();
    }
    return refused(note, null, null);
  };
  const shows = (read: CursorScreen, command: string): boolean =>
    (read.kind === "commands" && read.draft === command && read.highlighted === command) || (read.kind === "box" && read.draft === command);
  for (let step = 0; step < cursorCommandLimit; step += 1) {
    const command = cursorModeCommand(current, target);
    if (command === null) break;
    // Read again right before typing: the box empty, Cursor idle, the same word on its model row.
    screen = await look();
    if (screen.kind !== "box" || screen.footer === null || !screen.empty || screen.working || cursorFooterMode(screen.footer) !== current) {
      return refused(modePickTexts.cursorUnexpected, screen.kind === "box" && screen.footer !== null ? cursorFooterMode(screen.footer) : null, screen.kind === "box" ? screen.footer : null);
    }
    await ops.type(command);
    typed = command;
    screen = await look();
    if (!shows(screen, command)) return await backOut(modePickTexts.cursorUnexpected);
    // Read again right before Enter: exactly the command, nothing else.
    screen = await look();
    if (!shows(screen, command)) return await backOut(modePickTexts.cursorUnexpected);
    await ops.keys([cursorKeys.enter]);
    ops.moved();
    typed = null;
    let changed: CursorFooter | null = null;
    for (let read = 0; read < modeSettleReads; read += 1) {
      screen = await look();
      if (screen.kind === "box" && screen.footer !== null && screen.empty && cursorFooterMode(screen.footer) !== current) {
        changed = screen.footer;
        break;
      }
      await ops.wait();
    }
    if (changed === null) {
      const seen = screen.kind === "box" ? screen.footer : null;
      const word = seen === null ? null : cursorFooterMode(seen);
      return word === null ? unknown(modePickTexts.cursorNotShown, seen) : refused(modePickTexts.cursorNotShown, word, seen);
    }
    footer = changed;
    const now = cursorFooterMode(footer);
    if (now === null) return refused(modePickTexts.noMode("cursor"), null, footer);
    current = now;
    if (current === target) return { type: "set", mode: current, footer };
  }
  return refused(modePickTexts.cursorBound, current, footer);
}

// MARK: - Codex: /permissions and its list

async function codex(target: string, ops: Ops): Promise<ModePickResult> {
  const label = approvalMode("codex", target)?.label ?? target;
  let raw = await ops.look();
  let screen: CodexScreen = readCodexScreen(raw);
  if (screen.kind !== "box") return refused(modePickTexts.noBox("codex"), null);
  if (!screen.empty) return refused(modePickTexts.draft("codex"), null);
  // The acknowledgement rows before the pick, in order; only a row appended after
  // what survives of them acknowledges it (an older row for the same mode may scroll out of the recent lines).
  const baseline = codexAcknowledgements(raw);
  const look = async (): Promise<CodexScreen> => {
    raw = await ops.look();
    return readCodexScreen(raw);
  };
  /** Esc only while its list or confirmation shows (never on its box), also one not as recorded. */
  const closeList = async (note: string, mode: string | null): Promise<ModePickResult> => {
    if (screen.kind === "permissions" || screen.kind === "fullAccess" || codexListShowing(raw) || codexConfirmShowing(raw)) {
      await ops.keys([cursorKeys.escape]);
      screen = await look();
      // From the confirmation Esc goes back to the list: once more.
      if (screen.kind === "permissions" || codexListShowing(raw)) {
        await ops.keys([cursorKeys.escape]);
        screen = await look();
      }
    }
    return refused(note, mode);
  };
  const typedBack = (read: CodexScreen): boolean => read.kind === "box" && read.draft === codexPermissionsCommand;
  await ops.type(codexPermissionsCommand);
  screen = await look();
  const takeBack = async (): Promise<ModePickResult> => {
    // Read fresh; the whole input region exactly its own command: taken back; anything else is left as it is.
    screen = await look();
    if (typedBack(screen)) await ops.keys(Array<string>(codexPermissionsCommand.length).fill(cursorKeys.backspace));
    return refused(modePickTexts.codexList, null);
  };
  if (!typedBack(screen)) return await takeBack();
  // Read again right before Enter: exactly the command, nothing else.
  screen = await look();
  if (!typedBack(screen)) return await takeBack();
  await ops.keys([cursorKeys.enter]);
  for (let read = 0; read < modeSettleReads && screen.kind !== "permissions"; read += 1) {
    screen = await look();
    if (screen.kind === "permissions" || codexListShowing(raw)) break;
    await ops.wait();
  }
  // A list not as recorded: Esc, nothing picked (no digit is read off it).
  if (screen.kind !== "permissions" && codexListShowing(raw)) return await closeList(modePickTexts.codexListShape, null);
  // No list: its command taken back if the box still holds exactly it (no Esc: that is its box).
  if (screen.kind !== "permissions") return await takeBack();
  const rows = screen.rows;
  const shape = JSON.stringify(rows.map((row) => [row.digit, row.label, row.current]));
  const current = rows.find((row) => row.current)?.mode ?? null;
  const row = rows.find((candidate) => candidate.mode === target);
  if (row === undefined) return await closeList(modePickTexts.codexNoRow(label), current);
  if (row.current) {
    // Already so, as its list says: closed, nothing picked.
    await ops.keys([cursorKeys.escape]);
    screen = await look();
    return { type: "set", mode: target };
  }
  // Read again right before the digit: the same list.
  screen = await look();
  if (screen.kind !== "permissions" || JSON.stringify(screen.rows.map((each) => [each.digit, each.label, each.current])) !== shape) {
    return await closeList(modePickTexts.codexMoved, current);
  }
  await ops.keys([String(row.digit)]);
  ops.moved();
  let confirmed = false;
  for (let read = 0; read < modeSettleReads; read += 1) {
    screen = await look();
    if (screen.kind === "fullAccess") {
      if (target !== "full" || confirmed) return await closeList(modePickTexts.codexUnasked, current);
      // Its confirmation exactly as recorded, read again right before the answer.
      screen = await look();
      if (screen.kind !== "fullAccess") return await closeList(modePickTexts.codexConfirm, current);
      await ops.keys(["1"]);
      confirmed = true;
      continue;
    }
    if (codexConfirmShowing(raw)) {
      // Its confirmation over the box, not as recorded: Esc out of it (it sits over the box, so Esc goes to it), nothing confirmed.
      await ops.keys([cursorKeys.escape]);
      screen = await look();
      return await closeList(target === "full" ? modePickTexts.codexConfirm : modePickTexts.codexUnasked, current);
    }
    if (screen.kind === "box" && codexHistoryMode(screen.last) === target && codexNewAcknowledgement(baseline, codexAcknowledgements(raw)) === target) {
      return { type: "set", mode: target };
    }
    await ops.wait();
  }
  if (screen.kind === "permissions" || screen.kind === "fullAccess") return await closeList(modePickTexts.codexNotShown, current);
  // Its box back with no row new to the pick (an old one may name the target): not confirmed, no key to re-check.
  if (screen.kind === "box") return unknown(modePickTexts.codexUnconfirmed);
  // Its digit went and nothing says what came of it: unknown until its next turn.
  return unknown(modePickTexts.codexNotShown);
}

/** Codex's Full Access confirmation's title below its newest history row: the confirmation is up over the box (in any drawing). */
export function codexConfirmShowing(screen: string): boolean {
  const lines = screen.split("\n");
  const title = lines.findLastIndex((line) => line.trim() === "Enable full access?");
  if (title < 0) return false;
  return title > lines.findLastIndex((line) => line.startsWith("\u{2022} "));
}

// MARK: - bound to the pane the user picked on

/**
 * A Permissions pick bound to the pane the user chose, in the pane's send
 * turn (pickCursorBound's rules): a fresh snapshot must still show the pane,
 * terminal, agent and run the user saw, at its prompt (else busy: held for the
 * next turn), then driveModePick, every write checked on the latest snapshot
 * and against the user's Terminal input since the pick began.
 */
export function pickModeBound(
  site: CursorPickSite,
  paneID: string,
  agent: ModeAgent,
  target: string,
  expected: SendBinding,
  wait: () => Promise<void> = () => new Promise((resolve) => setTimeout(resolve, modeSettleMs)),
): Promise<Done> {
  return inPaneTurn(site.writer, paneID, async () => {
    const no = (note: string): Done => ({ result: { type: "refused", note, mode: null }, screen: null });
    if (expected.kind !== agent || !expected.isAgent || expected.run === undefined) return no(runChangedText(expected));
    if (!(await site.fresh())) return no(`Not set: the app could not check that ${agentNames[agent]} is still in its pane.`);
    if (!sameRun(expected, site)) return no(runChangedText(expected));
    const found = mismatch(expected, site.pane(), site.agent());
    if (found !== null) return no(`Not set: ${noReturnWhy[found]}.`);
    if (!atPrompt(site.pane(), site.agent())) return { result: { type: "busy" }, screen: null };
    const started = site.inputGeneration?.();
    const read = (): Promise<string> => site.calls.paneRead(paneID, cursorPickReadLines);
    return driveModePick(
      {
        read: () => (site.reading === undefined ? read() : site.reading(read)),
        type: (text) => site.writer.sendText(paneID, text),
        keys: (keys) => site.calls.paneSendKeys(paneID, keys),
        // Claude's and Grok's cycle keeps their box: Herdr's word that it started working stops it. Codex's list and
        // Cursor's command list may read to Herdr as something else: past the first key their screen says the rest.
        check: pickCheck(site, expected, started, agent === "claude" || agent === "grok"),
        wait,
      },
      agent,
      target,
    );
  });
}

// Claude Code's own box, read
// and emptied from the main process (shared/claude-screen.ts reads a screen).
//
// - After our Esc: the screen is read a few times; Claude's box
//   holding the text of the last message Chat sent to the pane means Claude
//   Code cancelled it before any answer and put it back there. The box is then
//   emptied (Ctrl+U, then Backspace, per row) and a fresh read must show it
//   empty, once more if not; the text goes back to Chat's composer.
// - Before every Chat send to a Claude pane: a fresh read. Our own
//   sent message in the box is cleared first (proved empty) and the send goes;
//   other text (Claude Code's suggested prompt, or typing in the terminal) is
//   left alone and the send goes ahead; an empty box sends.
// - A press while neither Herdr nor the last read showed working: one
//   fresh read; Esc goes only when the working line is on screen.
//
// One take-back per sent message. The reads after an Esc run
// one at a time per pane (afterStopOnce), and the send is claimed (forgotten)
// at the moment the box matches it, before the clear: a second Esc's reads,
// or any concurrent read, never match the same send again.
//
// The same reads say whether Claude's working line still shows;
// the read that shows it gone ends the turn on the page at once (Herdr's
// status says so a second or two later). They go on, within the 5, until it
// is gone, also when no message came back.
//
// Detection is by the screen (the cheapest that is correct: the transcript
// writes nothing for the cancel until the user's next message). The transcript's
// orphan rule (claude-parser.ts) keeps such a message out of the timeline
// later on, as the cancel left it.
//
// The clearing keys are bound.
// Each message Chat sent is kept with the agent run it went to (BoxRun), and
// only a message sent to the run in the pane now counts as ours. The keys go
// through a bound site (boundBoxSite) whose check runs right before each key
// write, nothing awaited between: the same machine and connection, terminal,
// agent kind, session and run, and no Terminal input (nor, for a send, Stop,
// Esc or failed send) since the binding was taken, before the first read.
// A send's own checks run before its first key (beforeSend's `allow`). A
// second attempt goes only while the box still holds exactly our message;
// any other text is left alone.

import {
  boxChips,
  boxClearKeys,
  claudeBoxTexts,
  held as heldIn,
  imagePaths,
  isOwn,
  claudeBoxWidth,
  pullClearKeys,
  pulledStart,
  takeBackMost,
  readClaudeScreenFacts,
  remnant,
  showsExactly,
  showsOwnSend,
  settled as settledFor,
  takeBackTexts,
  type BoxBefore,
  type ClaudeScreenFacts,
  type Held,
  type QueuedTakeBack,
} from "../../shared/claude-screen";

import { noAccount, queueAccount, type QueueAccount, type QueueRecord } from "../../shared/claude-queue-record";

export type { BoxBefore, QueuedTakeBack } from "../../shared/claude-screen";

/** Lines read for the box (it and the working line stand at the bottom). */
export const boxReadLines = 60;
/** Reads after an Esc until the box shows text (Claude Code puts the message back within a frame or two) and its working line is gone. */
export const afterStopReads = 5;
export const afterStopGapMs = 200;
/** After keys, before the read that proves the box empty. */
export const clearSettleMs = 120;

/** The pane as these steps need it. */
export interface ClaudeBoxSite {
  /** The pane's screen now (`pane.read`, plain text). */
  read(): Promise<string>;
  /** Keys to the pane's agent (`agent.send_keys`). */
  keys(keys: readonly string[]): Promise<void>;
  /** Waits `ms`. */
  wait(ms: number): Promise<void>;
  /**
   * Milliseconds on a steady clock. The reads after a prompt
   * with pictures (`afterPrompt`) start no read past their bound on it, however long each read takes. Absent: the
   * process's monotonic clock (`steadyNow`).
   */
  now?(): number;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
export const realWait = sleep;
/** The main process's monotonic clock, in milliseconds (never moves back with the wall clock). */
export const steadyNow = (): number => performance.now();

async function facts(site: ClaudeBoxSite): Promise<ClaudeScreenFacts | null> {
  try {
    return readClaudeScreenFacts(await site.read());
  } catch {
    return null;
  }
}

/**
 * Empties a box that holds `draft` (our message `mine`): per row Ctrl+U then
 * Backspace, then a fresh read must show it empty; once more if not. True when
 * proved empty. The second attempt goes only while the box
 * still holds exactly our message; other text (typed meanwhile, part of it
 * gone) is left alone and the box is not proved empty (false).
 * Exactly ours by `isOwn`, so a message with
 * pictures shown as Claude Code's chips (chips first or in place) is ours too.
 * A Send's cleanup gives its own exact test (`ours`).
 */
export async function clearClaudeBox(site: ClaudeBoxSite, draft: string, mine: string = draft, ours: (draft: string) => boolean = (shown) => isOwn(shown, mine)): Promise<boolean> {
  let left = draft;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await site.keys(boxClearKeys(left));
    } catch {
      return false;
    }
    await site.wait(clearSettleMs);
    const now = await facts(site);
    if (now === null || now.draft === null) return false;
    if (now.draft === "") return true;
    if (!ours(now.draft)) return false;
    left = now.draft;
  }
  return false;
}

/** A cleanup key its binding refused (boundBoxSite): it was never written. */
export class BoxKeysCalledOff extends Error {
  constructor() {
    super("the pane, its run or its input changed: no key");
    this.name = "BoxKeysCalledOff";
  }
}

/**
 * `site` with every key write bound to `holds`, asked right
 * before the write with nothing awaited between; false: nothing is written
 * and the write fails with BoxKeysCalledOff. Reads and waits as `site`.
 */
export function boundBoxSite(site: ClaudeBoxSite, holds: () => boolean): ClaudeBoxSite {
  return {
    read: () => site.read(),
    keys: (keys) => (holds() ? site.keys(keys) : Promise.reject(new BoxKeysCalledOff())),
    wait: (ms) => site.wait(ms),
    ...(site.now === undefined ? {} : { now: () => site.now!() }),
  };
}

/**
 * The agent run a message went to, as the main process knows
 * it: the pane's terminal, the agent's Herdr session (null: not reported), the
 * pane's agent arrival (PaneLife: a new agent in the pane is a new arrival) and
 * Herdr's generation for it (`turn_epoch`, decimal; null: not reported).
 */
export interface BoxRun {
  readonly terminalID: string;
  readonly session: string | null;
  readonly arrival: number;
  readonly epoch: string | null;
}

/** The same run, every field as it was (the binding between a read and a key). */
export function sameBoxRun(a: BoxRun | null, b: BoxRun | null): boolean {
  return a !== null && b !== null && a.terminalID === b.terminalID && a.session === b.session && a.arrival === b.arrival && a.epoch === b.epoch;
}

/**
 * A message sent to `sent` belongs to the run `now`: the same
 * terminal and arrival, and the same session and generation where both name
 * one (a session or `turn_epoch` reported later says nothing either way).
 */
export function ownRun(sent: BoxRun, now: BoxRun): boolean {
  const both = <T>(x: T | null, y: T | null): boolean => x === null || y === null || x === y;
  return sent.terminalID !== "" && sent.terminalID === now.terminalID && sent.arrival === now.arrival && both(sent.session, now.session) && both(sent.epoch, now.epoch);
}

/** What the reads after an Esc found. */
export interface AfterStop {
  /** The text Claude Code put back in its box (our last send); null: none. */
  readonly cancelled: string | null;
  /** The box was proved empty afterwards (meaningful only with `cancelled`). */
  readonly cleared: boolean;
}

/**
 * The pane's sends as one Esc's reads claim them. `claim` takes
 * the send at the moment the box matches it (before the clear): false when it
 * is no longer one of the pane's sends (another read took it), so one send
 * comes back once.
 */
export interface SentClaim {
  /** The last message Chat sent to the pane (null: none). */
  last(): string | null;
  /** Takes `text` from the pane's sends; false when it was not there. */
  claim(text: string): boolean;
}

const nothingFound: AfterStop = { cancelled: null, cleared: false };

/**
 * Each read after an Esc that shows Claude's box says
 * whether its working line still shows (`working`), until a read shows it
 * gone; the page ends the turn at that read (Herdr says so a second or two later).
 */
export type ScreenSeen = (working: boolean) => void;

/**
 * The box after our Esc, for the last message Chat sent to the pane (`sent`: a claim on the pane's sends, or just that text, null: none).
 * Every read with a box reports its working line to `seen`; the reads go on, within the 5,
 * until the line is gone, also when no message came back (none sent, the box stays empty, or other text is there).
 */
export async function afterStop(site: ClaudeBoxSite, sent: SentClaim | string | null, seen: ScreenSeen = () => undefined): Promise<AfterStop> {
  const claims: SentClaim = typeof sent === "object" && sent !== null ? sent : { last: () => sent, claim: () => true };
  const lastSent = claims.last();
  // Still looking for our last send back in Claude's box (until the box first shows text).
  let looking = lastSent !== null && lastSent.trim() !== "";
  let gone = false;
  let found = nothingFound;
  for (let read = 0; read < afterStopReads; read += 1) {
    await site.wait(afterStopGapMs);
    const now = await facts(site);
    // No read, or no box (a dialog, a menu): nothing to say about the box or the line above it.
    if (now === null || now.draft === null) continue;
    seen(now.working);
    if (!now.working) gone = true;
    if (looking && now.draft !== "") {
      looking = false;
      // Claimed as it matches, so no later or concurrent read matches the same send.
      // It matches by `isOwn` (its pictures as chips too); text around it never.
      if (isOwn(now.draft, lastSent!) && claims.claim(lastSent!)) found = { cancelled: lastSent, cleared: await clearClaudeBox(site, now.draft, lastSent!) };
    }
    if (!looking && gone) break;
  }
  return found;
}

/**
 * Work for one pane at a time, per machine (its writer object):
 * a call while one runs for the same pane waits for it, then runs.
 */
export class PaneTurns {
  private readonly tails = new WeakMap<object, Map<string, Promise<void>>>();

  run<T>(writer: object, paneID: string, body: () => Promise<T>): Promise<T> {
    let panes = this.tails.get(writer);
    if (panes === undefined) {
      panes = new Map();
      this.tails.set(writer, panes);
    }
    const before = panes.get(paneID) ?? Promise.resolve();
    const result = before.then(body);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    panes.set(paneID, tail);
    const own = panes;
    void tail.then(() => {
      if (own.get(paneID) === tail) own.delete(paneID);
    });
    return result;
  }
}

/** The reads after an Esc, one at a time per pane. */
export const afterStopTurns = new PaneTurns();

/**
 * The reads after an Esc to the pane `paneID`
 * of `writer`'s machine. A second Esc's reads wait for the first's, then
 * look for the pane's last send then; the send is claimed as it matches, so
 * one cancelled message comes back once.
 */
export function afterStopOnce(
  writer: object,
  paneID: string,
  site: ClaudeBoxSite,
  sent: SentTexts = sentTexts,
  turns: PaneTurns = afterStopTurns,
  seen: ScreenSeen = () => undefined,
  run?: BoxRun | null,
): Promise<AfterStop> {
  // With `run` (the main process always gives it), only a last send that went to that run is ours.
  return turns.run(writer, paneID, () => afterStop(site, sent.claims(writer, paneID, run), seen));
}

/** What the box allows before a send. */
export type BeforeSend =
  /**
   * Empty, or emptied of our own message (`cleared`: the text that was there).
   * `unverified` when no box was read (the read failed, or a screen with no box): the send goes ahead,
   * but the box is not known to be clear, so its check stays due.
   */
  | { readonly type: "go"; readonly cleared: string | null; readonly unverified?: true }
  /** The note; nothing goes, the composer keeps the text. */
  | { readonly type: "refused"; readonly note: string };

/**
 * A take-back's row as a Send's cleanup sees it: what the take-back left
 * (PulledRows), and `resolved`, told once a read shows the row empty or the cleanup emptied it.
 */
export interface PulledRowCheck {
  readonly left: PulledRow | null;
  resolved(): void;
}

/**
 * A fresh read before a send; `own` the messages Chat sent to the pane lately.
 * Only our own message in the box is cleared before the send. Any
 * other text there (Claude Code's dimmed suggested prompt at idle reads as text, or
 * the user's own typing in the terminal) never blocks the send and is never cleared: the
 * send goes with no key and no note.
 * Our own message found, `allow` (the send's own checks: a fresh
 * snapshot, the same run, the same pane, terminal, agent and session) runs before
 * any key; its note refuses the send with no key written. The keys then go through
 * the caller's bound site; a key it called off leaves the box as it is and the send
 * is refused with the still-has-text note, as for a box that would not empty.
 * Our own message is the box holding
 * exactly one of `own`: a message with pictures that went unconfirmed, shown chips first or in place,
 * is cleared and read empty before the next prompt goes, so that prompt never joins it; if it will not empty
 * the Send is refused and its draft kept. `within` (the user's typing with it) or any other text is never cleared.
 * A message with no picture matches exactly by `showsExactly` (word boundaries
 * kept: `a bc` is not `abc`), as the take-back's own match. One with
 * pictures matches the same way, by `showsOwnSend` (Claude Code's chip layout, a path still going in, the caption's word
 * boundaries kept), never `isOwn`'s whitespace-blind match. While a take-back's row
 * is unresolved (`pulled.left`), the send goes only once a read shows the row empty, or exactly the texts the take-back left as spare and the cleanup emptied it;
 * else it is refused (the draft kept), never into the row, and never clearing text the take-back called other.
 */
export async function beforeSend(site: ClaudeBoxSite, own: readonly string[], allow?: () => Promise<string | null>, pulled?: PulledRowCheck): Promise<BeforeSend> {
  const read = await boxRead(site);
  const now = read?.facts ?? null;
  const unresolved = pulled?.left ?? null;
  if (unresolved !== null) {
    if (now === null || now.draft === null) return { type: "refused", note: claudeBoxTexts.pulledNotSent };
    if (now.draft === "") {
      pulled!.resolved();
      return { type: "go", cleared: null };
    }
    const spare = unresolved.spare === null ? null : showsSpare(now.draft, unresolved.spare);
    if (spare === null) return { type: "refused", note: claudeBoxTexts.pulledNotSent };
    const refusal = allow === undefined ? null : await allow();
    if (refusal !== null) return { type: "refused", note: refusal };
    if (!(await clearClaudeBox(site, now.draft, spare, (shown) => showsSpare(shown, unresolved.spare!) !== null))) return { type: "refused", note: claudeBoxTexts.pulledNotSent };
    pulled!.resolved();
    return { type: "go", cleared: spare };
  }
  // No read, or no box that reads (a dialog: Herdr's agent.prompt refuses there itself): the send goes.
  if (now === null || now.draft === null) return { type: "go", cleared: null, unverified: true };
  if (now.draft === "") return { type: "go", cleared: null };
  // Exactly ours, word boundaries kept for a message with pictures too
  // (`showsOwnSend`: Claude Code's chip layout, a path still going in included, never a caption with other spaces).
  const mine = own.find((text) => showsOwnSend(now.draft!, text, read!.width));
  if (mine === undefined) return { type: "go", cleared: null };
  const refusal = allow === undefined ? null : await allow();
  if (refusal !== null) return { type: "refused", note: refusal };
  const ours = (shown: string): boolean => showsOwnSend(shown, mine, null);
  return (await clearClaudeBox(site, now.draft, mine, ours)) ? { type: "go", cleared: mine } : { type: "refused", note: claudeBoxTexts.notSentStillHasText };
}

/** One fresh read: the working line is on screen. */
export async function screenWorking(site: Pick<ClaudeBoxSite, "read">): Promise<boolean> {
  try {
    return readClaudeScreenFacts(await site.read()).working;
  } catch {
    return false;
  }
}

/** Backstop: messages wait in Claude's queue by a fresh read; null when it could not be read. */
export async function screenQueued(site: Pick<ClaudeBoxSite, "read">): Promise<boolean | null> {
  try {
    const read = readClaudeScreenFacts(await site.read());
    return read.queued;
  } catch {
    return null;
  }
}

// MARK: - A message still waiting in Claude's queue, taken back
//
// Claude Code 2.1.322 sends a queued message as the next prompt on Esc (with "abc" queued, an Esc to send
// "abcd" sends both). Its own way to take one back, proved live: Up
// moves the queue into its input row (the "ctrl+enter to send now" line goes), then ctrl+u empties the row; the
// turn runs on and the message is never sent. Here that is done for Chat, bound as the cleanup keys are
// (boundBoxSite), with a screen read before each key and after the last. Never Escape, never Return.

/** Reads after Up until the input row shows the pulled queue (Claude Code redraws within a frame or two). */
export const pullReads = 3;
/** Reads of Claude Code's queue record after Up, until it says (about 3 s on the clock at most). */
export const recordReads = 16;
export const recordGapMs = 200;
export const recordWaitMs = 3_000;

const none: QueuedTakeBack = { type: "none" };
const left = (note: string, pressed: boolean): QueuedTakeBack => ({ type: "left", note, pressed });

/**
 * The turn a take-back is for, by Herdr's latest snapshot: `on` (the
 * turn the send was queued in still runs), `ended` (Claude is not working: Claude Code sent its queue then),
 * `moved` (Claude works in another episode: a new turn, maybe with the queue as its prompt), or `dialog` (a
 * question or a menu is open).
 */
export type TakeBackTurn = "on" | "ended" | "moved" | "dialog";

/** The note for a take-back called off by the turn (`turn` not `on`) before any key. */
function turnNote(turn: Exclude<TakeBackTurn, "on">): string {
  if (turn === "dialog") return takeBackTexts.dialog;
  return turn === "ended" ? takeBackTexts.alreadyGot : takeBackTexts.notSure;
}

/**
 * What a take-back left in Claude's input row, per machine and pane,
 * until a fresh read shows the row empty (or a Send's cleanup clears what it may). `spare`: texts the row may hold
 * that are safe to clear because the user's words are elsewhere too (back in Chat's box, or already received by Claude);
 * a Send's cleanup clears the row only when it shows exactly them (or one of them). null: nothing in it may be
 * cleared by a Send (the user's only copy, or text typed in Terminal, or not known): every Send is refused until the row
 * reads empty.
 */
export interface PulledRow {
  readonly spare: readonly string[] | null;
}

export class PulledRows {
  private readonly rows = new WeakMap<object, Map<string, PulledRow>>();

  /** The pane's row as the last take-back left it; null: resolved (or never left). */
  get(writer: object, paneID: string): PulledRow | null {
    return this.rows.get(writer)?.get(paneID) ?? null;
  }

  /** What a take-back left (null: nothing, the row is known empty). */
  set(writer: object, paneID: string, row: PulledRow | null): void {
    let panes = this.rows.get(writer);
    if (panes === undefined) {
      panes = new Map();
      this.rows.set(writer, panes);
    }
    if (row === null) panes.delete(paneID);
    else panes.set(paneID, row);
  }
}

export const pulledRows = new PulledRows();

/** The row shows exactly `texts` joined, or exactly one of them (no wrap read into a row break). */
export function showsSpare(draft: string, texts: readonly string[]): string | null {
  if (texts.length === 0 || draft.trim() === "") return null;
  if (showsExactly(draft, texts, null)) return texts.join("\n");
  return texts.find((text) => showsExactly(draft, [text], null)) ?? null;
}

/**
 * What a take-back is for: `asked` the texts the page shows waiting in Claude's queue (oldest first); `own` the
 * messages Chat sent to the run in the pane now (SentTexts.recent for the bound run: none when either run is not
 * known); `forget` takes one from the pane's sends once it is Chat's again. `turn` the turn by
 * Herdr's snapshot (absent: not known here), asked before the first read and right before Up.
 * `record` Claude Code's queue record for the pane's session (absent: no session or no transcript, so no key);
 * `row` told what the take-back left in Claude's input row (PulledRows).
 */
export interface TakeBackFor {
  readonly asked: readonly string[];
  readonly own: readonly string[];
  forget(text: string): void;
  turn?(): TakeBackTurn;
  readonly record?: QueueRecord;
  row?(left: PulledRow | null): void;
}

async function keysWent(site: ClaudeBoxSite, keys: readonly string[]): Promise<"went" | "calledOff" | "failed"> {
  try {
    await site.keys(keys);
    return "went";
  } catch (error) {
    return error instanceof BoxKeysCalledOff ? "calledOff" : "failed";
  }
}

/** One read: its facts and the box's width; null when it could not be read. */
async function boxRead(site: ClaudeBoxSite): Promise<{ readonly facts: ClaudeScreenFacts; readonly width: number | null } | null> {
  try {
    const screen = await site.read();
    return { facts: readClaudeScreenFacts(screen), width: claudeBoxWidth(screen) };
  } catch {
    return null;
  }
}

/** Reads after Up until the input row shows text or no box shows (a read that failed is read again): the last read that answered; null: none did. */
async function rowAfterUp(site: ClaudeBoxSite): Promise<ClaudeScreenFacts | null> {
  let shown: ClaudeScreenFacts | null = null;
  for (let attempt = 0; attempt < pullReads; attempt += 1) {
    await site.wait(clearSettleMs);
    const now = await facts(site);
    if (now === null) continue;
    shown = now;
    if (now.draft === null || now.draft !== "") break;
  }
  return shown;
}

/**
 * What the record and the row together prove after Up.
 * - `pulled`: the user's `texts` (the newest of the asked, each with its own popAll line) are what the row holds
 *   (`shown`, the row as read; null, no box or empty: the row could not be seen, and nothing is cleared).
 * - `recalled`: every asked text is proved delivered, none pulled: Up recalled history (`texts` delivered).
 * - `other`: the pull held text that is not the user's (a popAll of Terminal's text, or Terminal's typing in the row).
 * - `unproven`: within the bound some text in the row has no proof (no popAll for it, or a delivery proved for
 *   another text only), or the record could not be read: nothing is cleared.
 */
type AfterUp =
  | { readonly type: "pulled"; readonly texts: readonly string[]; readonly shown: ClaudeScreenFacts | null }
  | { readonly type: "recalled"; readonly texts: readonly string[]; readonly shown: ClaudeScreenFacts | null }
  | { readonly type: "other" }
  | { readonly type: "unproven" };

/**
 * The record's lines past `from` and the row after Up, read until every text in the
 * row has its proof, bounded by count and clock. A pull is proved only when the popAll lines reach the user's newest asked
 * text and the row shows exactly those texts (each line one text: a missing line is no proof, so reading goes on);
 * a recall only when every asked text is proved delivered and none pulled. One text proved delivered never stands
 * for another: with `one` taken mid-turn and `two`'s popAll late, reading goes on until `two`'s line comes.
 */
async function proofAfterUp(site: ClaudeBoxSite, record: QueueRecord, from: number, asked: readonly string[]): Promise<AfterUp> {
  const clock = site.now ?? steadyNow;
  const by = clock() + recordWaitMs;
  // The row after Up, read when the record first says enough to check it, and again (one read) while it does not match.
  let shown: ClaudeScreenFacts | null | undefined;
  const rowNow = async (): Promise<ClaudeScreenFacts | null> => {
    if (shown === undefined) shown = await rowAfterUp(site);
    else shown = (await facts(site)) ?? shown;
    return shown;
  };
  for (let read = 0; read < recordReads; read += 1) {
    await site.wait(recordGapMs);
    const lines = await record.since(from).catch(() => null);
    // A record that cannot be read now proves nothing: no key from here on clears anything.
    if (lines === null) return { type: "unproven" };
    const account: QueueAccount = lines.length === 0 ? noAccount : queueAccount(lines, asked);
    if (account.other) return { type: "other" };
    const everyText = account.pulled.length + account.delivered.length === asked.length;
    if (account.pulled.length > 0 && account.reachesNewest) {
      const texts = account.pulled.map((index) => asked[index]!);
      const row = await rowNow();
      if (row === null || row.draft === null || row.draft === "") return { type: "pulled", texts, shown: row };
      // The row as read after Up: the pull's text, its whitespace and pictures as Claude Code draws them.
      if (isOwn(row.draft, texts.join("\n"))) return { type: "pulled", texts, shown: row };
      // Every text proved and the row holds more: typed in Terminal since the pull, not cleared.
      if (everyText) return { type: "other" };
    } else if (account.pulled.length === 0 && account.delivered.length > 0 && everyText) {
      return { type: "recalled", texts: account.delivered.map((index) => asked[index]!), shown: await rowNow() };
    }
    if (clock() >= by) break;
  }
  return { type: "unproven" };
}

/**
 * Takes back the user's newest messages waiting in Claude's queue (`site` bound by the caller: each key
 * goes only while the machine, its connection, pane, terminal, agent, session and run are the send's, no dialog
 * shows by Herdr's snapshot, and no Terminal input or composer write came since).
 *
 * - Before: Claude Code's queue record's end (the baseline, before any read or key), then a fresh
 *   read must show Claude's box and the queue (else `none`: Esc only stops) and the box empty (the user's typing
 *   there: no key, said). Every asked text must be one Chat sent to this run, and the record must be readable
 *   (no session, no transcript: no key, said). A read that failed or a screen with no box is `left` with its note,
 *   never `none`; the turn moved on or a dialog by Herdr: no key.
 * - Up, then the record's lines written past the baseline,
 *   read until every text in the row has its own proof (proofAfterUp):
 *   - one popAll line per text, reaching the user's newest asked text, with the row showing exactly those texts, proves
 *     the pull: the row is cleared (Ctrl+U per row, then a read), and they are Chat's again (`taken`). Cleared keys
 *     that went with the empty row not seen still give the texts back (`taken`, said), the row left marked so no
 *     Send joins it.
 *   - every asked text proved delivered, each by a line holding exactly it (taken mid-turn, the user's prompt; a bare
 *     dequeue proves none): `left` with "already received"; Up recalled history, and the row is cleared only when
 *     it shows exactly the user's own delivered text.
 *   - a popAll of anything else, or Terminal's typing in the row once every text is proved: `left`, nothing cleared.
 *   - any text in the row unproven when the bound ends (a popAll line missing, only another text proved
 *     delivered), or the record unreadable: `left`, nothing cleared, said.
 *   Whatever is left in the row is told to `row` (PulledRows): no Send goes into it until it reads empty.
 */
export async function takeBackQueued(site: ClaudeBoxSite, take: TakeBackFor): Promise<QueuedTakeBack> {
  const turn = (): TakeBackTurn => take.turn?.() ?? "on";
  const row = (state: PulledRow | null): void => take.row?.(state);
  const early = turn();
  if (early !== "on") return left(turnNote(early), false);
  // The baseline before the first read (so a delivery between the read and Up shows past it).
  const base = take.record === undefined ? null : await take.record.end().catch(() => null);
  const read = await boxRead(site);
  // A read that failed says nothing about the queue: no key, and no stop on this press.
  if (read === null) return left(takeBackTexts.unread, false);
  const before = read.facts;
  // A dialog or a menu over the box (no box that reads): no key at all, and never a stop that falls through.
  if (before.draft === null) return left(before.queued ? takeBackTexts.dialog : takeBackTexts.noBox, false);
  // A fresh read shows the row empty: nothing a take-back left is there.
  if (before.draft === "") row(null);
  if (!before.queued) return none;
  const asked = take.asked.filter((text) => text.trim() !== "");
  if (asked.length === 0 || !asked.every((text) => take.own.includes(text))) return left(takeBackTexts.notOurs, false);
  if (before.draft !== "") return left(takeBackTexts.boxHasText, false);
  // No record to prove the pull by: no key.
  if (take.record === undefined || base === null) return left(takeBackTexts.unrecorded, false);
  // Right before Up, nothing awaited between: the same turn, no dialog by Herdr.
  const beforeUp = turn();
  if (beforeUp !== "on") return left(turnNote(beforeUp), false);
  const up = await keysWent(site, ["Up"]);
  if (up === "calledOff") return left(takeBackTexts.changed, false);
  // An Up that threw may have gone: the record says, text by text.
  const proof = await proofAfterUp(site, take.record, base, asked);
  if (proof.type === "unproven") {
    row({ spare: null });
    return left(takeBackTexts.notSureTaken, true);
  }
  if (proof.type === "other") {
    row({ spare: null });
    return left(takeBackTexts.alsoTerminal, true);
  }
  if (proof.type === "recalled") return recalled(site, proof.shown, proof.texts, row);
  const texts = proof.texts;
  const shown = proof.shown;
  if (shown === null || shown.draft === null || shown.draft === "") {
    row({ spare: null });
    return left(shown === null ? takeBackTexts.changed : shown.draft === null ? takeBackTexts.dialog : takeBackTexts.notSureTaken, true);
  }
  const pulled = shown.draft;
  let rest = pulled;
  let wrote = false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const cleared = await keysWent(site, pullClearKeys(rest));
    if (cleared === "calledOff") break;
    wrote = true;
    if (cleared === "failed") break;
    await site.wait(clearSettleMs);
    const after = await facts(site);
    if (after === null || after.draft === null) break;
    if (after.draft === "") {
      for (const text of texts) take.forget(text);
      row(null);
      // The hint back in the box (or the send-now line) with the row empty: another message still waits.
      return { type: "taken", texts, note: after.queued ? takeBackTexts.takenStillQueued : takeBackTexts.taken };
    }
    // Only the start of the pulled row (a row Ctrl+U did not reach) gets one more round.
    if (!pulledStart(after.draft, pulled)) break;
    rest = after.draft;
  }
  if (!wrote) {
    // No clearing key went (a dialog, the pane changed): the user's texts are in Claude's row, its only copy.
    row({ spare: null });
    return left(turn() === "dialog" ? takeBackTexts.dialog : takeBackTexts.changed, true);
  }
  // A clearing key went and the empty row was not seen: they may be gone from it, so they come back
  // to Chat all the same (never nowhere), and a Send may clear only exactly them from the row.
  for (const text of texts) take.forget(text);
  row({ spare: texts });
  return { type: "taken", texts, note: takeBackTexts.takenCheckBox };
}

/**
 * Claude already received the user's texts, so Up recalled history: the row is cleared only
 * when it shows exactly one of those texts (or them joined); anything else is left, and no Send joins it.
 * `asked` here holds only texts the record proves delivered, each by its own line.
 */
async function recalled(site: ClaudeBoxSite, shown: ClaudeScreenFacts | null, asked: readonly string[], row: (state: PulledRow | null) => void): Promise<QueuedTakeBack> {
  if (shown === null || shown.draft === null) {
    row({ spare: asked });
    return left(takeBackTexts.alreadyGotBoxText, true);
  }
  if (shown.draft === "") {
    row(null);
    return left(takeBackTexts.alreadyGot, true);
  }
  if (showsSpare(shown.draft, asked) === null) {
    row({ spare: null });
    return left(takeBackTexts.alreadyGotBoxText, true);
  }
  const cleared = await keysWent(site, pullClearKeys(shown.draft));
  if (cleared === "went") {
    await site.wait(clearSettleMs);
    const after = await facts(site);
    if (after !== null && after.draft === "") {
      row(null);
      return left(takeBackTexts.alreadyGot, true);
    }
  }
  row({ spare: asked });
  return left(takeBackTexts.alreadyGotBoxText, true);
}

/** The reads and keys of a take-back, one at a time per pane, in turn with the reads after an Esc. */
export function takeBackQueuedOnce(writer: object, paneID: string, site: ClaudeBoxSite, take: TakeBackFor, turns: PaneTurns = afterStopTurns): Promise<QueuedTakeBack> {
  return turns.run(writer, paneID, () => takeBackQueued(site, take));
}

// MARK: - After a prompt that carries pictures
//
// The Mac counterpart of Sources/HerdrKit/ClaudeScreenFacts.swift
// (ClaudeBoxSteps.boxBefore, afterPrompt and their bounds), for a Chat send to Claude Code that carries
// pictures. Herdr's `agent.prompt` answers once it wrote the text and its Return; Claude Code then takes in
// each picture and draws its `[Image #N]` chip, and a Return that lands meanwhile is lost: three pictures
// can sit in Claude's box (`[Image #18] [Image #19] [Image #20]compare these`) while Chat says Sent.

/** Reads after the prompt, before the one Return, per picture (12 at 0.25 s: 3 s of gaps per picture). */
export const afterPromptReads = 12;
/** Reads after the one Return (about 2 s of gaps). */
export const afterReturnReads = 8;
/** The wait before each of those reads. */
export const afterPromptGapMs = 250;
/** The wait before the Return is sized for up to this many pictures (three or four full-size ones); more share it. */
export const settlePicturesMost = 4;
/** On the clock, per picture: Claude Code reads each picture, scales it and draws its chip, one at a time. */
export const settleMsPerPicture = 3_000;
/** On the clock, for the reads' own round trips on top. */
export const settleReadMs = 3_000;
/** After the one Return, on the clock: no read starts past this (the 8 reads' 2 s of gaps and 3 s for their round trips). */
export const afterReturnMs = 5_000;
/** The corrective Return, as Herdr's `agent.send_keys` names it. */
export const promptReturnKey = "Enter";

const settlePictures = (pictures: number): number => Math.min(Math.max(pictures, 1), settlePicturesMost);

/** As ClaudeBoxSteps.settleReads: the reads before the Return for `pictures` image paths: 12 per picture, 1 to 4. */
export function settleReads(pictures: number): number {
  return afterPromptReads * settlePictures(pictures);
}

/**
 * As ClaudeBoxSteps.settleSeconds: no read before the Return starts later than this after the prompt
 * went, on the site's clock: 3 s per picture (1 to 4) and 3 s for the reads (6 s for one picture, 12 s for three,
 * 15 s for four or more), whatever each read takes.
 */
export function settleMs(pictures: number): number {
  return settleMsPerPicture * settlePictures(pictures) + settleReadMs;
}

/**
 * What the reads after a prompt found (ClaudeBoxSteps.AfterPrompt). No `unchanged`
 * here: a box empty for the whole wait, the message never seen and nothing that took it, is no proof it went
 * (`agent.prompt`'s reply says only that Herdr wrote it), so it is `unknown`, unconfirmed.
 */
export type AfterPrompt =
  /** Claude took it, as read: the box emptied after the message was seen, this prompt's queued hint, or Claude going from idle to working. */
  | "taken"
  /**
   * The message seen in the box and still there, or a piece of it: after the one Return, with Claude working,
   * other text around it, a picture not in or a chip not new at the end of the wait (no key then), or seen
   * before a read failed or the binding changed. Unconfirmed; never sent again by itself.
   */
  | "stillInBox"
  /**
   * Nothing read says it went (a read failed or showed no box, the binding changed, the user's text alone, an earlier
   * turn's working line, or the box empty all along with the message never seen): unconfirmed.
   */
  | "unknown";

/**
 * As ClaudeBoxSteps.boxBefore: the box before a prompt's write, from a fresh read. Null when
 * the read fails or shows no box: then no chip can be shown to be the prompt's, and no Return goes.
 */
export async function boxBefore(site: ClaudeBoxSite): Promise<BoxBefore | null> {
  const now = await facts(site);
  if (now === null || now.draft === null) return null;
  return { chips: new Set(boxChips(now.draft)), queued: now.queued };
}

/** What the reads after a prompt are bound to. */
export interface AfterPromptBinding {
  /** Herdr said Claude was idle (or done) before the prompt: a working line after it is this prompt's. */
  readonly idleBefore: boolean;
  /** The box as read right before the write (`boxBefore`); null: not read, so no Return goes. */
  readonly before: BoxBefore | null;
  /**
   * Asked after every read (also after the Return): the machine, pane, terminal, agent, session, connection
   * and run are the prompt's, and no Terminal input, Stop, Esc, pick, failed send or other composer write came
   * since. False: the reads stop at once and no key goes.
   */
  readonly holds: () => boolean;
  /** Asked right before the Return: the run is known and the one the prompt went to (a fresh snapshot). False: no key. */
  readonly mayPress: () => Promise<boolean>;
}

/**
 * The reads after a prompt that carries pictures, on a steady clock (as ClaudeBoxSteps
 * .afterPrompt). Up to `settleReads(pictures)` reads 0.25 s apart, none starting past `settleMs(pictures)` on the
 * clock, which is checked before and after every wait, the first included (no frame
 * read at all says nothing: `unknown`).
 *
 * - The one Return goes only when the box shows exactly `sent` with every picture in as a chip new since
 *   `before` (`settled`), Claude is not working, `mayPress` says the run is known and unchanged, and `holds`
 *   still holds; the site's own key check runs right before the write. Never a second Return.
 * - Sent (`taken`) only on positive evidence: the box empty once the message was seen in it, Claude's queued
 *   hint not there before the write with the box empty, or Claude going from idle to working with the box empty
 *   or holding other text alone. A box empty all along, the message never seen,
 *   is `unknown` (late intake past the window included), whatever Claude's status was before.
 * - A box that still holds a chip, one of our paths or our caption without being exactly ours (a picture
 *   missing, another caption, more text) never says it went, before or after the Return, whatever an earlier
 *   read saw: `stillInBox` when ours was seen, else `unknown`. The user's text alone with Claude idle: `unknown`.
 */
export async function afterPrompt(site: ClaudeBoxSite, sent: string, binding: AfterPromptBinding): Promise<AfterPrompt> {
  const { idleBefore, before, holds, mayPress } = binding;
  const clock = site.now === undefined ? steadyNow : () => site.now!();
  let held: Held = "none";
  let working = false;
  // The message alone with every picture in, each chip new since `before`.
  let settled = false;
  // The last box read was empty (or held only the queued hint).
  let empty = true;
  // The message was seen in the box at a read (alone or with other text).
  let seen = false;
  // Frames read before the Return.
  let frames = 0;
  const unread = (): AfterPrompt => (seen ? "stillInBox" : "unknown");
  const pictures = imagePaths(sent).length;
  const settleBy = clock() + settleMs(pictures);
  for (let read = 0; read < settleReads(pictures); read += 1) {
    // Past the bound on the clock no read starts: checked before the wait and once it ended.
    if (clock() >= settleBy) break;
    await site.wait(afterPromptGapMs);
    if (clock() >= settleBy) break;
    const now = await facts(site);
    // A read that was out when the binding changed says nothing.
    if (!holds()) return unread();
    // No read, or no box (a dialog, a menu): nothing to say about the box.
    if (now === null || now.draft === null) return unread();
    frames += 1;
    const box = now.draft;
    empty = box === "";
    held = empty ? "none" : heldIn(box, sent);
    settled = held !== "none" && before !== null && settledFor(box, sent, before);
    working = now.working;
    if (held !== "none") {
      seen = true;
    } else if (empty) {
      // Its queued hint, not there before the write (this prompt's): Claude took it behind a turn still going.
      if (now.queued && before !== null && !before.queued) return "taken";
      // Working: the message seen and gone, or Claude idle before.
      if (working && (seen || idleBefore)) return "taken";
    } else if (!remnant(box, sent)) {
      // The user's text alone: only Claude going from idle to working says ours went.
      if (working && idleBefore) return "taken";
    }
    // A piece of it (a picture missing, another caption, more text) is neither ours nor gone: read on.
    // Every picture in, Claude idle: the Return now.
    if (pictures > 0 && settled && !working) break;
  }
  // The clock ran out before any frame was read: nothing says it went, and no key.
  if (frames === 0) return "unknown";
  switch (held) {
    case "none":
      // A box not empty and not ours is no proof it went, whatever an earlier read saw.
      if (!empty) return unread();
      // An earlier turn's working line alone says nothing of this prompt.
      if (working) return "unknown";
      if (seen) return "taken";
      // Never seen and nothing took it: the box empty all along says nothing (intake may come
      // later than the reads, or Herdr's reply may stand for a write that changed nothing). Unconfirmed.
      return "unknown";
    case "within":
      return "stillInBox";
    case "mine":
      // Claude working, or a picture still not in (or a chip not new since the write, or no read before it)
      // at the end of the wait: a Return then would be lost or not ours. No key.
      if (working || (pictures > 0 && !settled)) return "stillInBox";
  }
  const press = await mayPress().catch(() => false);
  if (!press || !holds()) return "stillInBox";
  try {
    await site.keys([promptReturnKey]);
  } catch (error) {
    // Refused by the site's own last check: it never went.
    if (error instanceof BoxKeysCalledOff) return "stillInBox";
    // A Return that threw otherwise may or may not have gone: the reads say.
  }
  const returnedBy = clock() + afterReturnMs;
  for (let read = 0; read < afterReturnReads; read += 1) {
    if (clock() >= returnedBy) break;
    await site.wait(afterPromptGapMs);
    if (clock() >= returnedBy) break;
    const now = await facts(site);
    if (!holds()) return "stillInBox";
    if (now === null || now.draft === null) continue;
    // The box emptied (or holds only the queued hint): it went.
    if (now.draft === "") return "taken";
    // The user's text alone with Claude working (idle when the Return went): it went. Ours still, a piece of it (a
    // picture missing, another caption) or the user's text with Claude idle: read on.
    if (now.working && heldIn(now.draft, sent) === "none" && !remnant(now.draft, sent)) return "taken";
  }
  return "stillInBox";
}

/** One message Chat sent, and the run it went to (null: not known then; absent: recorded unbound). */
interface SentText {
  readonly text: string;
  readonly run?: BoxRun | null;
}

/**
 * The messages Chat sent to each Claude pane by `agent.prompt` (newest last),
 * per machine (its writer object) and pane: what "our own" text in the box is.
 * The main process records each with the run it went to and asks
 * with the run in the pane now (`run`: a BoxRun, or null when not readable): only a
 * message sent to that run is ours, and none when either run is not known. Asked
 * with no `run` (the unbound form, kept for the older tests), every one counts.
 */
export class SentTexts {
  /** As many as a take-back asks for (takeBackMost). */
  static readonly kept = takeBackMost;
  private readonly byWriter = new WeakMap<object, Map<string, SentText[]>>();

  record(writer: object, paneID: string, text: string, run?: BoxRun | null): void {
    let panes = this.byWriter.get(writer);
    if (panes === undefined) {
      panes = new Map();
      this.byWriter.set(writer, panes);
    }
    const entry: SentText = run === undefined ? { text } : { text, run };
    const list = [...(panes.get(paneID) ?? []), entry].slice(-SentTexts.kept);
    panes.set(paneID, list);
  }

  recent(writer: object, paneID: string, run?: BoxRun | null): readonly string[] {
    return this.entries(writer, paneID)
      .filter((entry) => SentTexts.owns(entry, run))
      .map((entry) => entry.text);
  }

  /** The last message sent to the pane, when it is ours for `run` (an earlier one sent to that run is not its last). */
  last(writer: object, paneID: string, run?: BoxRun | null): string | null {
    const entry = this.entries(writer, paneID).at(-1);
    return entry !== undefined && SentTexts.owns(entry, run) ? entry.text : null;
  }

  /** The text went back to Chat's box: it is no longer in Claude's. False when it was not among the pane's sends. */
  forget(writer: object, paneID: string, text: string): boolean {
    const panes = this.byWriter.get(writer);
    const list = panes?.get(paneID);
    if (panes === undefined || list === undefined) return false;
    const at = list.map((entry) => entry.text).lastIndexOf(text);
    if (at < 0) return false;
    panes.set(paneID, [...list.slice(0, at), ...list.slice(at + 1)]);
    return true;
  }

  /** The pane's sends as afterStop claims them (a claim forgets the send), for `run`. */
  claims(writer: object, paneID: string, run?: BoxRun | null): SentClaim {
    return { last: () => this.last(writer, paneID, run), claim: (text) => this.forget(writer, paneID, text) };
  }

  private entries(writer: object, paneID: string): readonly SentText[] {
    return this.byWriter.get(writer)?.get(paneID) ?? [];
  }

  /** Whether `entry` is ours when asked for `run` (see the class). */
  private static owns(entry: SentText, run: BoxRun | null | undefined): boolean {
    if (run === undefined || entry.run === undefined) return true;
    return run !== null && entry.run !== null && ownRun(entry.run, run);
  }
}

export const sentTexts = new SentTexts();

/**
 * When a send to a Claude pane reads its box first. Only after this app pressed Stop or
 * Esc on that pane (or a pick that may press Esc), or a send to it failed, since the box was last read:
 * that is when our own message can be back in Claude's box. Otherwise no read (0 trips). Per machine
 * (its writer object) and pane.
 */
export class BoxChecks {
  private readonly due = new WeakMap<object, Set<string>>();
  private readonly counts = new WeakMap<object, Map<string, number>>();

  /** Stop, Esc or a failed send on the pane: the next send reads the box first. */
  mark(writer: object, paneID: string): void {
    let panes = this.due.get(writer);
    if (panes === undefined) {
      panes = new Set();
      this.due.set(writer, panes);
    }
    panes.add(paneID);
    let counts = this.counts.get(writer);
    if (counts === undefined) {
      counts = new Map();
      this.counts.set(writer, counts);
    }
    counts.set(paneID, (counts.get(paneID) ?? 0) + 1);
  }

  /**
   * How many times the pane was marked so far (Stop, Esc, a pick, a failed send, Terminal input);
   * one more since a send's box read means its box may have changed after it.
   */
  marks(writer: object, paneID: string): number {
    return this.counts.get(writer)?.get(paneID) ?? 0;
  }

  /** Whether the next send reads the box. */
  isDue(writer: object, paneID: string): boolean {
    return this.due.get(writer)?.has(paneID) ?? false;
  }

  /** The box was read. */
  checked(writer: object, paneID: string): void {
    this.due.get(writer)?.delete(paneID);
  }
}

export const boxChecks = new BoxChecks();

/**
 * Each pane's composer writes on this machine (per writer object and
 * pane), counted at the start of each write: a Send's prompt, input, paste or Return. A cleanup of Claude's box
 * bound before one (the reads after an Esc, or another Send's) writes no key after it starts, so its Ctrl+U and
 * Backspace never take newer text out of the box with the old. A cleanup's own keys are not counted.
 */
export class ComposerWrites {
  private readonly counts = new WeakMap<object, Map<string, number>>();

  /** A composer write to the pane starts now. */
  wrote(writer: object, paneID: string): void {
    let panes = this.counts.get(writer);
    if (panes === undefined) {
      panes = new Map();
      this.counts.set(writer, panes);
    }
    panes.set(paneID, (panes.get(paneID) ?? 0) + 1);
  }

  /** The pane's composer writes so far. */
  count(writer: object, paneID: string): number {
    return this.counts.get(writer)?.get(paneID) ?? 0;
  }
}

export const composerWrites = new ComposerWrites();

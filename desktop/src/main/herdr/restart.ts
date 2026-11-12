// Restart: `/exit` and Return to the pane's agent (the text as pane.send_text,
// its Return as agent.send_keys, which Herdr refuses for a pane whose process
// is no longer an agent, so a Return never reaches a bare shell), then, once a
// snapshot shows the pane's shell (no agent in it, the same terminal), the
// resume command and Return typed into that shell (pane.send_input). Never
// Herdr's agent.restart.
//
// Only when it's safe, as Stop checks (stop.ts): on the connection the page
// showed, a fresh snapshot right before /exit must still show the same pane,
// terminal, agent kind and Herdr session, idle or done with no dialog or
// pending menu, and nothing is awaited between that check and the key. Between
// the exit and the resume every snapshot must show the same pane and terminal
// on the same connection; otherwise nothing more is typed and the note says
// why. At most 20 s for the exit. One restart per pane at a time: a second one
// while it runs gets the first one's answer and types nothing.
//
// Codex 0.167.0 can keep a typed `/exit` in its input row after the Return (its
// slash list takes it). For such a kind (exitRowKinds) its screen is read while
// it has not left; with the row holding exactly `/exit` and nothing else, one
// more Return goes, once, under the same checks as the first (the machine's
// entry, the connection, the pane, terminal, agent, session and run, no
// dialog). Anything else in the row, or a dialog: no key, and the note says so.
// Giving up with `/exit` still in the row, the note says that too.
//
// The extra Return goes only for a screen that proves `/exit` (codexExitRow
// reads the whole bottom of the screen); any input to the pane since the
// restart began (the user's Terminal typing, a composer write, a box mark)
// calls it off with a note; and the run the page showed at the user's click is
// the one every key is bound to.
//
// Rows under the box shaped like a slash list prove `/exit` only with exactly
// one row marked selected and that row `/exit`; a wholly unmarked list may be
// the user's draft's next rows: no key.
//
// A Codex started in daemon mode (a plain `codex`, or Herdr's session restore)
// leaves its background service holding the conversation, so the resumed `codex
// resume <id> --no-daemon` can draw "This conversation is open in another app"
// and wait there. For such a kind (resumeLockKinds) the screen is read after
// the resume: Codex's prompt ends the restart; the exact lock screen
// (codexLockShown) shows a note on the page (site.note), and every 15 s for up
// to 5 min the single key `r` goes, only when the latest read still shows the
// exact lock screen and, checked with nothing awaited before the key, the same
// machine entry and connection, terminal, Codex run and session, no input to
// the pane since the restart began and no dialog. Never any other key. Five
// minutes still locked, or a check failing: a lasting note says to press R
// there.

import {
  codexExitRow,
  codexResumeScreen,
  exitCommand,
  exitRowKinds,
  lockRetryKey,
  lockStopReasons,
  restartCommand,
  restartRefusal,
  restartTexts,
  resumeLockKinds,
  type ExitRow,
  type RestartBinding,
  type ResumeScreen,
} from "../../shared/agent-restart";
import type { AgentStartCommands } from "../../shared/start-commands";
import { agentKind, agentSession, runsAgent } from "../../shared/send-binding";
import { errorWords } from "./new-agent";
import { returnKey } from "./send";
import { type StopIdentity } from "./stop";
import { APIError, type AgentInfo, type TopologyPaneInfo } from "./wire";

/** How long the agent has to leave its pane after its /exit. */
export const restartExitTimeoutMs = 20_000;
/** How often the pane is looked at while it exits. */
export const restartPollMs = 1_000;

export interface RestartWriter {
  sendText(paneID: string, text: string): Promise<void>;
  agentKeys(paneID: string, keys: readonly string[]): Promise<void>;
  sendInput(paneID: string, text: string, keys: readonly string[]): Promise<void>;
}

/** The machine for one restart (HostRegistry has it all). */
export interface RestartSite {
  readonly writer: RestartWriter;
  /** The machine's name, for the notes. */
  readonly machine: string;
  /** A snapshot asked for after this call began; false when none came. */
  fresh(): Promise<boolean>;
  pane(): TopologyPaneInfo | null;
  agent(): AgentInfo | null;
  identity(): StopIdentity | null;
  snapshotEpoch(): number | null;
  /** The machine's start commands (agents.json), read before the fresh check (null: not known). */
  startCommands(): Promise<AgentStartCommands | null>;
  /** The pane's screen as plain text (`pane.read`); absent where it cannot be read. */
  read?(): Promise<string>;
  /** The machine's entry still holds this writer (false: removed or replaced); absent: not known. */
  entry?(): boolean;
  /** The connection and the pane's agent run now (HostRegistry.run); absent: not known. */
  run?(): { readonly connection: number; readonly arrival: number } | null;
  /**
   * The pane's input counts now: its Terminal input generation (PaneInputs),
   * its composer writes and its box marks. Each only grows; any change means something was typed or written to
   * the pane. Absent: not known here.
   */
  inputs?(): readonly number[];
  /** A note for the page while the restart still runs (the lock wait's); absent: none shown. */
  note?(text: string): void;
  now?(): number;
  sleep?(ms: number): Promise<void>;
}

/** How long a screen read may take before it counts as none. */
export const restartReadMs = 2_000;
/** How long the resumed Codex has to draw its prompt or its lock screen after the resume command. */
export const restartResumeWatchMs = 20_000;
/** How often the lock screen is read again (and, still locked, `r` sent). */
export const restartLockRetryMs = 15_000;
/** How long the lock is waited out, from the read that first showed it (an absolute deadline set at that read). */
export const restartLockWaitMs = 5 * 60_000;

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** `answer`, or false when it has not come within `ms` (the time the exit has left). */
function within(answer: Promise<boolean>, ms: number): Promise<boolean> {
  if (ms <= 0) {
    answer.catch(() => undefined);
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    answer.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(false);
      },
    );
  });
}

/** `answer`, or `none` when it fails or has not come within `ms`. */
function withinOr<T>(answer: Promise<T>, ms: number, none: T): Promise<T> {
  if (ms <= 0) {
    answer.catch(() => undefined);
    return Promise.resolve(none);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(none), ms);
    answer.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(none);
      },
    );
  });
}

/** The note for a write that threw before the exit (in words; `agent_not_ready` says the agent waits in its tab). */
function exitFailure(error: unknown, name: string): string {
  if (!(error instanceof APIError)) return restartTexts.unconfirmed;
  return error.code === "agent_not_ready" ? restartTexts.notReady(name) : restartTexts.refused(errorWords(error));
}

/** Per machine (its writer) and pane: the restart under way. */
const underWay = new WeakMap<object, Map<string, Promise<string | null>>>();

export function restartAgent(site: RestartSite, paneID: string, expected: RestartBinding): Promise<string | null> {
  let panes = underWay.get(site.writer);
  if (panes === undefined) {
    panes = new Map();
    underWay.set(site.writer, panes);
  }
  const running = panes.get(paneID);
  if (running !== undefined) return running;
  const map = panes;
  const restart = restartNow(site, paneID, expected).finally(() => {
    if (map.get(paneID) === restart) map.delete(paneID);
  });
  map.set(paneID, restart);
  return restart;
}

/** The machine is still on the connection and command connection the page showed (an epoch must be known where there is one). */
function onPageConnection(identity: StopIdentity, expected: RestartBinding): boolean {
  return identity.incarnation === expected.incarnation && identity.connection === expected.connection && identity.epoch === expected.epoch;
}

/** Why the connection is not the page's now (null: it is). */
function connectionNote(site: RestartSite, expected: RestartBinding): string | null {
  const identity = site.identity();
  if (identity === null || identity.connection === null) return restartTexts.offline(site.machine);
  if (!onPageConnection(identity, expected)) return restartTexts.connectionChanged(site.machine);
  if (identity.epoch !== null && site.snapshotEpoch() !== identity.epoch) return restartTexts.connectionChanged(site.machine);
  return null;
}

/**
 * Why the next key must not go by the latest snapshot
 * (null: it may): the pane, its terminal, and the agent kind and session the
 * page showed, still there.
 */
function bindingNote(site: RestartSite, expected: RestartBinding): string | null {
  const pane = site.pane();
  if (pane === null) return restartTexts.paneGone;
  if (expected.terminalID !== "" && pane.terminalID !== expected.terminalID) return restartTexts.otherTerminal;
  const agent = site.agent();
  const kind = agentKind(agent, pane);
  if (kind === null) return restartTexts.noAgent(expected.name);
  if (kind !== expected.kind || agentSession(agent) !== expected.session) return restartTexts.otherAgent;
  return null;
}

type Run = { readonly connection: number; readonly arrival: number } | null;

const sameRun = (a: Run, b: Run): boolean => (a === null ? b === null : b !== null && a.connection === b.connection && a.arrival === b.arrival);

type Inputs = readonly number[] | null;

const sameInputs = (a: Inputs, b: Inputs): boolean => (a === null ? b === null : b !== null && a.length === b.length && a.every((count, index) => count === b[index]));

/** Why no key may go because the pane had input since `inputs` were counted (null: none). */
function inputNote(site: RestartSite, expected: RestartBinding, inputs: Inputs): string | null {
  if (site.inputs === undefined) return null;
  return sameInputs(inputs, site.inputs()) ? null : restartTexts.typedMeanwhile(expected.name);
}

/**
 * Why the Return after /exit must not go now (null: it may),
 * on the latest snapshot: the machine's entry, the connection, the pane,
 * terminal, agent and session, and the run seen before /exit.
 */
function keyNote(site: RestartSite, expected: RestartBinding, run: Run): string | null {
  if (site.entry?.() === false) return restartTexts.connectionChanged(site.machine);
  const binding = connectionNote(site, expected) ?? bindingNote(site, expected);
  if (binding !== null) return binding;
  if (site.run !== undefined && !sameRun(run, site.run())) return restartTexts.otherAgent;
  return null;
}

/** The one more Return's checks: the first one's, no input to the pane since the restart began, and no dialog. */
function extraKeyNote(site: RestartSite, expected: RestartBinding, run: Run, inputs: Inputs): string | null {
  const binding = keyNote(site, expected, run) ?? inputNote(site, expected, inputs);
  if (binding !== null) return binding;
  const agent = site.agent();
  if (agent?.inputPending === true || (agent?.agentStatus ?? site.pane()?.agentStatus) === "blocked") return restartTexts.waiting(expected.name);
  return null;
}

/** The agent's input row now (null: not read, or no row to say). */
async function exitRow(site: RestartSite): Promise<ExitRow> {
  if (site.read === undefined) return null;
  const screen = await withinOr<string | null>(site.read(), restartReadMs, null);
  return screen === null ? null : codexExitRow(screen);
}

/** The resumed agent's screen now (null: not read, or nothing known). */
async function resumeScreen(site: RestartSite): Promise<ResumeScreen> {
  if (site.read === undefined) return null;
  const screen = await withinOr<string | null>(site.read(), restartReadMs, null);
  return screen === null ? null : codexResumeScreen(screen);
}

/** "Gone" when no agent shows in the pane by the latest snapshot (yet, or any more). */
const noAgentYet = "\u0000gone";

/**
 * Why the lock wait must stop by the latest snapshot (null: it may go on, and an `r` may go now):
 * the machine's entry and connection, the pane and its terminal, the agent kind, a session other than the one
 * resumed (none told yet is fine: Codex reports its session once it has the conversation), the resumed run `run`
 * (where it is known), no input to the pane since the restart began, no dialog. noAgentYet: no agent in the pane.
 */
function lockStop(site: RestartSite, expected: RestartBinding, run: Run, inputs: Inputs): string | null {
  if (site.entry?.() === false) return lockStopReasons.connectionChanged(site.machine);
  const identity = site.identity();
  if (identity === null || identity.connection === null) return lockStopReasons.offline(site.machine);
  if (!onPageConnection(identity, expected)) return lockStopReasons.connectionChanged(site.machine);
  if (identity.epoch !== null && site.snapshotEpoch() !== identity.epoch) return lockStopReasons.connectionChanged(site.machine);
  const pane = site.pane();
  if (pane === null) return lockStopReasons.paneGone;
  if (expected.terminalID !== "" && pane.terminalID !== expected.terminalID) return lockStopReasons.otherTerminal;
  const agent = site.agent();
  if (!runsAgent(pane, agent)) return noAgentYet;
  if (agentKind(agent, pane) !== expected.kind) return lockStopReasons.otherAgent;
  const session = agentSession(agent);
  if (session !== null && session !== expected.session) return lockStopReasons.otherAgent;
  if (site.run !== undefined && !sameRun(run, site.run())) return lockStopReasons.otherAgent;
  if (site.inputs !== undefined && !sameInputs(inputs, site.inputs())) return lockStopReasons.typed(expected.name);
  if (agent?.inputPending === true || (agent?.agentStatus ?? pane.agentStatus) === "blocked") return lockStopReasons.waiting(expected.name);
  return null;
}

/**
 * After the resume command went. Codex's prompt: done (null). Its lock screen, with Codex in the pane: the note,
 * then waitLock. Neither within restartResumeWatchMs: done (the resume went).
 *
 * Each read comes after a fresh snapshot, and the run that snapshot shows is taken before the read. A read showing
 * the lock binds that run, checked again right after the read; no later snapshot ever supplies it. The five minutes
 * count from the first read that showed the lock.
 *
 * Whether the snapshot before the read already showed an agent in the pane is recorded. If it did and the read
 * shows the lock, that run is bound for good: no agent in the pane after that read (or at any later locked read)
 * stops with the lasting gone note and no key, and every later read is checked against that same run, never a
 * later snapshot's. Looking again is only for a snapshot that had no agent in the pane before the read (Codex not
 * registered yet).
 */
async function afterResume(site: RestartSite, paneID: string, expected: RestartBinding, inputs: Inputs, now: () => number, sleep: (ms: number) => Promise<void>): Promise<string | null> {
  const end = now() + restartResumeWatchMs;
  // The absolute end of the lock wait, set at the first read that showed the lock (null: none yet).
  let lockEnd: number | null = null;
  // The run a locked read showed with an agent already in the pane before it (undefined: none yet).
  let bound: Run | undefined;
  for (;;) {
    const fresh = now() < end && (await within(site.fresh(), end - now()));
    // The run seen with this read: the one every `r` goes to if the read shows the lock (once bound, that one).
    const run: Run = bound !== undefined ? bound : (site.run?.() ?? null);
    // Whether the snapshot before this read already showed an agent in the pane.
    const pane = site.pane();
    const shown = pane !== null && runsAgent(pane, site.agent());
    // When the read began (the earlier bound): a lock it shows counts its five minutes from here.
    const readAt = now();
    const screen = await resumeScreen(site);
    if (screen === "prompt") return null;
    if (screen === "locked") {
      lockEnd ??= readAt + restartLockWaitMs;
      if (shown) bound ??= run;
      if (fresh && now() < end) {
        const stop = lockStop(site, expected, run, inputs);
        if (stop === null) return await waitLock(site, paneID, expected, run, inputs, lockEnd, now, sleep);
        // No agent in the pane by Herdr's snapshot: look again only while no run is bound (Codex not there yet);
        // a bound run that is gone stops, with the lasting note.
        if (stop !== noAgentYet) return restartTexts.lockStopped(expected.name, stop);
        if (bound !== undefined) return restartTexts.lockStopped(expected.name, lockStopReasons.gone(expected.name));
      }
    }
    if (now() >= end) return null;
    await sleep(Math.min(restartPollMs, end - now()));
  }
}

/**
 * The lock wait. Every restartLockRetryMs a fresh snapshot and a read: the prompt ends it (null);
 * the exact lock screen gets one `r`, the checks (lockStop) made with nothing awaited before the key; anything else
 * gets no key. At `end` (restartLockWaitMs from the first read that showed the lock, set by the
 * caller, so the time before the wait began counts), one last read: the prompt, null; else the lasting note. Never
 * another key, and none at or after `end`: that check is the last thing before each key.
 */
async function waitLock(site: RestartSite, paneID: string, expected: RestartBinding, run: Run, inputs: Inputs, end: number, now: () => number, sleep: (ms: number) => Promise<void>): Promise<string | null> {
  site.note?.(restartTexts.lockWait(expected.name));
  const last = async (): Promise<string | null> => ((await resumeScreen(site)) === "prompt" ? null : restartTexts.lockGaveUp(expected.name));
  const stopped = (why: string): string => restartTexts.lockStopped(expected.name, why === noAgentYet ? lockStopReasons.gone(expected.name) : why);
  for (;;) {
    if (now() >= end) return await last();
    await sleep(Math.min(restartLockRetryMs, end - now()));
    if (now() >= end) return await last();
    const fresh = await within(site.fresh(), end - now());
    const before = lockStop(site, expected, run, inputs);
    if (before !== null) return stopped(before);
    const screen = await resumeScreen(site);
    if (screen === "prompt") return null;
    if (now() >= end) return await last();
    // Only on a fresh snapshot and a read showing the exact lock screen.
    if (!fresh || screen !== "locked") continue;
    const stop = lockStop(site, expected, run, inputs);
    if (stop !== null) return stopped(stop);
    // Nothing awaited since: the deadline checked right before the key.
    if (now() >= end) return await last();
    try {
      await site.writer.agentKeys(paneID, [lockRetryKey]);
    } catch {
      return stopped(lockStopReasons.refused);
    }
  }
}

async function restartNow(site: RestartSite, paneID: string, expected: RestartBinding): Promise<string | null> {
  const now = (): number => site.now?.() ?? Date.now();
  const sleep = (ms: number): Promise<void> => site.sleep?.(ms) ?? pause(ms);
  const before = connectionNote(site, expected);
  if (before !== null) return before;
  // The start commands first: nothing is awaited between the fresh check and the key.
  if (expected.session === null) return restartTexts.noSession;
  const commands = await site.startCommands();
  const checked = await site.fresh();
  const after = connectionNote(site, expected);
  if (after !== null) return after;
  if (!checked) return restartTexts.unchecked(expected.name);
  const refusal = restartRefusal(expected, site.pane(), site.agent());
  if (refusal !== null) return refusal;
  // The command from the session the fresh snapshot
  // just showed (the tap's, by the refusal), never an older cached one.
  const command = restartCommand(expected.kind, site.agent()?.agentSession ?? null, commands);
  if (command === null) return restartTexts.noSession;
  // The run the page showed at the user's click (else the one the fresh snapshot shows), compared before /exit
  // and before each Return.
  const run: Run = expected.run ?? site.run?.() ?? null;
  if (site.run !== undefined && !sameRun(run, site.run())) return restartTexts.otherAgent;
  // The pane's input counts before /exit; any change since calls off each Return.
  const inputs: Inputs = site.inputs?.() ?? null;
  try {
    await site.writer.sendText(paneID, exitCommand);
    // A snapshot or a new connection while the text was acknowledged: no Enter.
    const between = keyNote(site, expected, run) ?? inputNote(site, expected, inputs);
    if (between !== null) return between;
    await site.writer.agentKeys(paneID, [returnKey]);
  } catch (error) {
    return exitFailure(error, expected.name);
  }
  const deadline = now() + restartExitTimeoutMs;
  // Whether its row is still looked at for the one more Return (once at most).
  const rowKind = exitRowKinds.has(expected.kind) && site.read !== undefined;
  let watching = rowKind;
  // Gave up: the note, and whether /exit is still in the row (only where the row is read).
  const gaveUp = async (): Promise<string> => {
    const row = rowKind ? await exitRow(site) : null;
    return row === "exit" || row === "typed" || row === "unsure" ? restartTexts.exitTyped(expected.name) : restartTexts.didNotExit(expected.name);
  };
  for (;;) {
    // Each wait bounded by the time left, the limit checked before a shell is taken.
    if (now() >= deadline) return await gaveUp();
    await sleep(Math.min(restartPollMs, deadline - now()));
    const fresh = await within(site.fresh(), deadline - now());
    if (now() >= deadline) return await gaveUp();
    const changed = connectionNote(site, expected);
    if (changed !== null) return changed;
    if (fresh) {
      const pane = site.pane();
      if (pane === null) return restartTexts.paneGone;
      if (pane.terminalID !== expected.terminalID) return restartTexts.otherTerminal;
      const agent = site.agent();
      if (!runsAgent(pane, agent)) break;
      const kind = agentKind(agent, pane);
      if (kind !== expected.kind || (agent?.agentSession?.value ?? null) !== expected.session) return restartTexts.otherAgent;
      if (watching) {
        // A dialog: no key, and the note says it waits for an answer.
        if (agent?.inputPending === true || (agent?.agentStatus ?? pane.agentStatus) === "blocked") return restartTexts.waiting(expected.name);
        const row = await exitRow(site);
        if (now() >= deadline) return await gaveUp();
        // Other text in its row with the /exit: no key, it stays typed.
        if (row === "typed") return restartTexts.exitTyped(expected.name);
        // A screen that does not prove /exit (row "unsure"): no key; read again on the next poll.
        // Its row no longer holds /exit: it took it; the wait goes on as before.
        if (row === "clear") watching = false;
        if (row === "exit") {
          watching = false;
          // The same checks as the first Return, on the latest snapshot; nothing awaited between them and the key.
          const refused = extraKeyNote(site, expected, run, inputs);
          if (refused !== null) return refused;
          try {
            await site.writer.agentKeys(paneID, [returnKey]);
          } catch {
            // Refused (it may be leaving: Herdr takes no keys for a shell) or not confirmed: the wait below says how it ended.
          }
        }
      }
    }
  }
  // The shell just showed on the page's connection: nothing awaited before the resume.
  try {
    await site.writer.sendInput(paneID, command, [returnKey]);
  } catch {
    return restartTexts.resumeUnconfirmed;
  }
  // The resumed Codex may land on its "open in another app" lock.
  if (!resumeLockKinds.has(expected.kind) || site.read === undefined) return null;
  return await afterResume(site, paneID, expected, inputs, now, sleep);
}

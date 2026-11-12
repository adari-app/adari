// Stop's state per pane. Each
// press is one plain Esc to the pane, as in its terminal: nothing holds a press
// back, a press while one is under way goes too. After a press the square shows
// a spinner until Herdr reports the agent not working (or 10 s pass): a look
// only. The note a key that could not go left shows on the note line under the
// box. Keyed by the pane's draft key (machine and pane), so a tile's stop is its own.

import type { SessionTopology } from "../../main/herdr/wire";
import { stopBindingOf, stopEpisodeKey, stoppingLookMs } from "../../shared/agent-stop";
import { draftKey, failureText } from "./composer-drafts";

export class AgentStops {
  /** Per pane: when the last press was (the spinner's look). */
  private readonly pressed = new Map<string, number>();
  private readonly notes = new Map<string, string>();
  private readonly timers = new Map<string, unknown>();
  private readonly listeners = new Set<() => void>();
  private count = 0;

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly schedule: (run: () => void, ms: number) => unknown = (run, ms) => setTimeout(run, ms),
    private readonly cancel: (timer: unknown) => void = (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  ) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** A new number on every change (for useSyncExternalStore). */
  version = (): number => this.count;

  /** The spinner shows: a press less than 10 s ago, the agent not yet reported not working. Never blocks a press. */
  isStopping(key: string): boolean {
    const at = this.pressed.get(key);
    return at !== undefined && this.now() - at < stoppingLookMs;
  }

  note(key: string): string | null {
    return this.notes.get(key) ?? null;
  }

  dismiss(key: string): void {
    if (this.notes.delete(key)) this.changed();
  }

  /** A note about Claude's box after a press, on the same line. */
  setNote(key: string, note: string): void {
    this.notes.set(key, note);
    this.changed();
  }

  /**
   * One press: `run` (the main process's stop: its note, or null when Esc
   * went) runs now, whatever came before. The spinner shows from the press; a
   * note (the key could not go) ends it.
   */
  stop(key: string, run: () => Promise<string | null>): void {
    this.press(key);
    void run()
      .then(
        (note) => note,
        (failure: unknown) => `Esc did not go: ${failureText(failure, "the request did not go")}`,
      )
      .then((note) => {
        if (note === null) return;
        this.release(key);
        this.notes.set(key, note);
        this.changed();
      });
  }

  /** The pane's agent is `status` now: anything but working ends the spinner. */
  observe(key: string, status: string | null): void {
    if (status !== "working" && this.pressed.has(key)) {
      this.release(key);
      this.changed();
    }
  }

  clear(): void {
    for (const timer of this.timers.values()) this.cancel(timer);
    this.timers.clear();
    this.pressed.clear();
    this.notes.clear();
    this.changed();
  }

  private press(key: string): void {
    this.release(key);
    const at = this.now();
    this.pressed.set(key, at);
    // At 10 s the square shows again (a re-render), still a look only.
    this.timers.set(
      key,
      this.schedule(() => {
        if (this.pressed.get(key) !== at) return;
        this.release(key);
        this.changed();
      }, stoppingLookMs),
    );
    this.changed();
  }

  private release(key: string): void {
    const timer = this.timers.get(key);
    if (timer !== undefined) this.cancel(timer);
    this.timers.delete(key);
    this.pressed.delete(key);
  }

  private changed(): void {
    this.count += 1;
    for (const listener of this.listeners) listener();
  }
}

export const agentStops = new AgentStops();

/**
 * The turn an Esc stopped, as the page shows it
 * before Herdr says so (its status trails Claude Code by a second or two).
 *
 * - From the press of an Esc that went, the Working row reads "Stopping…"
 *   (no counter, no "Esc to stop") until a read after the Esc shows Claude's
 *   working line gone, Herdr reports the pane not working, or 5 s pass; then
 *   it follows Herdr's status again.
 * - A read after the Esc that shows the working line gone ends the turn on the
 *   page at once: the Working row, the Stop square and "Esc to stop" go, while
 *   Herdr still says working.
 * - Herdr reporting the pane not working, or working with another status than
 *   at the press (a new turn), or a send to the pane, ends both: the page
 *   follows Herdr at once and never hides a new turn.
 */
export const escStoppingMs = 5_000;

/** What the page shows for the pane's turn: Herdr's status, "Stopping…", or the turn ended by the screen. */
export type EscTurnLook = "herdr" | "stopping" | "ended";

export class EscTurns {
  private readonly turns = new Map<string, { readonly at: number; readonly episode: string; ended: boolean; readonly timer: unknown }>();
  private readonly listeners = new Set<() => void>();
  private count = 0;
  private bridge: { onEscScreen?(listener: (event: { readonly hostId: string; readonly paneId: string; readonly working: boolean }) => void): () => void } | null = null;
  private detach: (() => void) | null = null;

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly schedule: (run: () => void, ms: number) => unknown = (run, ms) => setTimeout(run, ms),
    private readonly cancel: (timer: unknown) => void = (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
    private readonly keyOf: (hostId: string, paneId: string) => string = draftKey,
  ) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  version = (): number => this.count;

  /** Main's word at the read that showed Claude's working line gone (one listener for the page's bridge). */
  attach(bridge: EscTurns["bridge"]): void {
    if (bridge === this.bridge) return;
    this.detach?.();
    this.bridge = bridge;
    this.detach =
      bridge?.onEscScreen?.((event) => {
        if (!event.working) this.screenIdle(this.keyOf(event.hostId, event.paneId));
      }) ?? null;
  }

  /** An Esc went to the pane `key` at the press, Herdr showing it in `episode` (stopEpisodeKey). */
  pressed(key: string, episode: string): number {
    this.drop(key);
    const at = this.now();
    const timer = this.schedule(() => {
      if (this.turns.get(key)?.at === at) this.changed();
    }, escStoppingMs);
    this.turns.set(key, { at, episode, ended: false, timer });
    this.changed();
    return at;
  }

  /** The Esc of the press at `at` did not go (a note says why): no "Stopping…". */
  withdrawn(key: string, at: number): void {
    if (this.turns.get(key)?.at === at) this.drop(key);
  }

  /** A read after the Esc showed Claude's working line gone: the turn ends on the page now. */
  screenIdle(key: string): void {
    const turn = this.turns.get(key);
    if (turn === undefined || turn.ended) return;
    turn.ended = true;
    this.cancel(turn.timer);
    this.changed();
  }

  /** Herdr's report for the pane: not working, or working with another status than at the press, ends it. */
  observe(key: string, herdrWorking: boolean, episode: string): void {
    const turn = this.turns.get(key);
    if (turn !== undefined && (!herdrWorking || turn.episode !== episode)) this.drop(key);
  }

  /** You sent to the pane: whatever runs next is a new turn. */
  sent(key: string): void {
    this.drop(key);
  }

  /** The pane's box went (another pane shown): its Esc's turn goes with it, as an armed stop does. */
  forget(key: string): void {
    this.drop(key);
  }

  /** What the page shows for the pane now, Herdr reporting `herdrWorking` in `episode`. */
  look(key: string, herdrWorking: boolean, episode: string): EscTurnLook {
    const turn = this.turns.get(key);
    if (!herdrWorking || turn === undefined || turn.episode !== episode) return "herdr";
    if (turn.ended) return "ended";
    return this.now() - turn.at < escStoppingMs ? "stopping" : "herdr";
  }

  clear(): void {
    for (const key of this.turns.keys()) this.drop(key);
    this.changed();
  }

  private drop(key: string): void {
    const turn = this.turns.get(key);
    if (turn === undefined) return;
    this.cancel(turn.timer);
    this.turns.delete(key);
    this.changed();
  }

  private changed(): void {
    this.count += 1;
    for (const listener of this.listeners) listener();
  }
}

export const escTurns = new EscTurns();

/** The pane's agent and its status episode as Herdr shows them (a new turn is another). */
export function turnEpisodeOf(host: Parameters<typeof stopBindingOf>[0], paneId: string): string {
  return stopEpisodeKey(stopBindingOf(host, paneId, ""));
}

/**
 * Esc right after a send. Between Send
 * and Herdr reporting the turn it started (a second or two) the agent is not
 * "working" yet, so Stop is not possible and Esc did nothing. Esc then, your
 * just-sent message still pending, arms one stop for the pane: when Herdr
 * reports the same agent (terminal, kind, session, on the same machine entry
 * and connection) working in an episode other than the one it was in at the
 * press (so one that began after it, and after the send), within 5 s of the
 * press, the stop goes once through the usual path (main's fresh check, one
 * Escape); otherwise nothing goes. A second Esc while armed does nothing more.
 */
export const armedStopMs = 5_000;
/** A pending bubble this young is "just sent" (Esc arms only then). */
export const justSentMs = 30_000;

/** The pane's agent as the page shows it, for an armed stop. */
export interface ArmedScope {
  readonly terminalID: string;
  readonly kind: string | null;
  readonly session: string | null;
  readonly incarnation: number;
  readonly connection: number;
  /** The command connection the snapshot came on (StopBinding.epoch): a replaced one, even with the same connection number, is another. */
  readonly epoch: number | null;
  /** stopEpisodeKey of the agent as shown. */
  readonly episode: string;
  /** Its `state_change_seq` (decimal; null: not reported) and generation (`turn_epoch`), paired as one episode's identity. */
  readonly seq: string | null;
  readonly generation: string | null;
}

/** The generation (`turn_epoch`) of the pane's agent as `topology` shows it; null when not reported. */
export function agentGeneration(topology: SessionTopology | null | undefined, paneId: string): string | null {
  const value = topology?.agents.find((agent) => agent.paneID === paneId)?.turnEpoch;
  return typeof value === "number" || typeof value === "bigint" ? String(value) : null;
}

/**
 * A working episode that began after the press: with a
 * sequence reported then and now, a higher one (the generation is the same:
 * armedScopeChanged dropped any other); with none reported either time,
 * another episode than at the press (at the press the agent was not working).
 * A sequence reported only one of those times never gets here: armedScopeChanged
 * drops the arm.
 */
function newerEpisode(armed: ArmedScope, now: ArmedScope): boolean {
  if (armed.seq != null && now.seq != null) return BigInt(now.seq) > BigInt(armed.seq);
  return now.episode !== armed.episode;
}

function armedScopeChanged(armed: ArmedScope, now: ArmedScope): boolean {
  if (armed.incarnation !== now.incarnation || armed.connection !== now.connection || armed.epoch !== now.epoch) return true;
  // Another generation (a boot, respawn or restore: its counter starts again) proves nothing about the turn you started.
  if (armed.generation !== now.generation) return true;
  // A sequence reported at the press and not now, or the reverse, leaves nothing to order by.
  if ((armed.seq == null) !== (now.seq == null)) return true;
  if (armed.terminalID !== "" && now.terminalID !== "" && armed.terminalID !== now.terminalID) return true;
  if (armed.kind !== null && now.kind !== null && armed.kind !== now.kind) return true;
  // A session you saw must still be the one; a new session, or one no longer named, is another agent.
  return armed.session !== null && armed.session !== now.session;
}

export class ArmedStops {
  private readonly armed = new Map<string, { readonly scope: ArmedScope; readonly at: number; readonly timer: unknown; readonly sendID: string | null }>();
  private readonly listeners = new Set<() => void>();
  private count = 0;

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly schedule: (run: () => void, ms: number) => unknown = (run, ms) => setTimeout(run, ms),
    private readonly cancel: (timer: unknown) => void = (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  ) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  version = (): number => this.count;

  /** Armed and not yet 5 s old (the Stop square shows in Send's place). */
  isArmed(key: string): boolean {
    const armed = this.armed.get(key);
    return armed !== undefined && this.now() - armed.at < armedStopMs;
  }

  /**
   * Arms one stop for `key` with the agent as shown at the press, for the send
   * `sendID` (your newest pending one: its failure cancels it);
   * false when one is armed already (one Escape per press).
   */
  arm(key: string, scope: ArmedScope, sendID: string | null = null): boolean {
    if (this.isArmed(key)) return false;
    this.drop(key);
    const at = this.now();
    const timer = this.schedule(() => {
      const armed = this.armed.get(key);
      if (armed !== undefined && armed.at === at) this.drop(key);
    }, armedStopMs);
    this.armed.set(key, { scope, at, timer, sendID });
    this.changed();
    return true;
  }

  /** The send `sendID` failed (never written): the stop armed for it goes; a bubble that only cleared keeps it. */
  cancelSend(sendID: string): void {
    for (const [key, armed] of this.armed) if (armed.sendID === sendID) this.drop(key);
  }

  /** You sent again, or the pane changed: nothing goes. */
  disarm(key: string): void {
    this.drop(key);
  }

  /**
   * The pane's agent as shown now. True (and disarmed) when the armed stop is
   * due: the same agent, working, in another episode than at the press, within
   * 5 s. Another agent, session, terminal or connection, or the 5 s past,
   * disarms it (false); anything else keeps it waiting (false).
   */
  take(key: string, now: ArmedScope, working: boolean): boolean {
    const armed = this.armed.get(key);
    if (armed === undefined) return false;
    if (this.now() - armed.at >= armedStopMs || armedScopeChanged(armed.scope, now)) {
      this.drop(key);
      return false;
    }
    if (!working || !newerEpisode(armed.scope, now)) return false;
    this.drop(key);
    return true;
  }

  clear(): void {
    for (const key of this.armed.keys()) this.drop(key);
    this.changed();
  }

  private drop(key: string): void {
    const armed = this.armed.get(key);
    if (armed === undefined) return;
    this.cancel(armed.timer);
    this.armed.delete(key);
    this.changed();
  }

  private changed(): void {
    this.count += 1;
    for (const listener of this.listeners) listener();
  }
}

export const armedStops = new ArmedStops();

/** The focused element as the window's Esc reads it (document.activeElement). */
export interface FocusedElement {
  readonly tagName?: string;
  readonly type?: string;
  readonly isContentEditable?: boolean;
  closest?(selector: string): { getAttribute?(name: string): string | null } | null;
}

/** Inputs that take no text: Esc on them is nobody's but Stop's. */
const keylessInputs = new Set(["button", "checkbox", "radio", "submit", "reset", "range", "color", "file", "image"]);

/**
 * Another feature's own text field has the focus, so Esc stays its own:
 * the sidebar's search, a rename field, a
 * dialog's inputs, any textarea or contenteditable, a terminal.
 */
export function textFieldFocused(active: FocusedElement | null | undefined): boolean {
  if (active === null || active === undefined) return false;
  if (active.isContentEditable === true) return true;
  const tag = (active.tagName ?? "").toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") return !keylessInputs.has((active.type ?? "text").toLowerCase());
  return active.closest?.(".term-host") != null;
}

/**
 * The window's Esc stops the agent of the Chat whose box is `ownBox` (pane
 * `paneId`) with the focus at `active`: wherever
 * the focus is (the sidebar, the header, the conversation, nothing), except in
 * the box itself (its own handler took the key), in another feature's text
 * field, or inside another tile of a split (focus moved there by the keyboard,
 * that tile not focused: no agent is stopped rather than the wrong one).
 *
 * `origins` are where the key started (the event's
 * target, its composed path's first element). A field whose own handler
 * closes it on Esc (Search) may be gone, the focus on the body, by the time
 * the key reaches the window; the same key is still that field's, never Stop.
 * Every place, where it started and where the focus is now, must allow it.
 */
export function windowEscStops(active: FocusedElement | null | undefined, ownBox: unknown, paneId: string, origins: readonly unknown[] = []): boolean {
  const places = [...origins.filter(isElementLike), active];
  return places.every((place) => {
    if (place !== null && place !== undefined && place === ownBox) return false;
    if (textFieldFocused(place)) return false;
    const tile = place?.closest?.("[data-tile]")?.getAttribute?.("data-tile") ?? null;
    return tile === null || tile === paneId;
  });
}

/** An element (a tag name), not the window or the document a key event can also name. */
function isElementLike(value: unknown): value is FocusedElement {
  return typeof value === "object" && value !== null && typeof (value as { tagName?: unknown }).tagName === "string";
}

/** Where a key event started: its target and its composed path's first element. */
export function keyOrigins(event: { readonly target?: unknown; composedPath?(): readonly unknown[] }): unknown[] {
  const path = typeof event.composedPath === "function" ? event.composedPath() : [];
  return [event.target, path[0]];
}

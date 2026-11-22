// Your sent messages before the transcript has them. Send shows the message at
// once as a pending bubble at the end of the chat ("Queued" while the agent
// works); once a user message with the same text appears in the transcript
// after it was sent, the bubble goes and the real message stays at its place,
// so it is never shown twice. Two sends of the same words are two bubbles, each
// matched to its own message. A send that failed leaves no bubble (its text
// stays in the box with the note). Not seen after ten minutes, the bubble says
// so; nothing is ever sent again. Per pane, renderer-wide, so a bubble survives
// switching panes and tabs.
//
// The rules:
// - Each send has a baseline. Sent while Chat holds the pane's live
//   transcript, it is what Chat showed then (its user messages and its last
//   item); otherwise the first live timeline delivered after the send, which is
//   never taken as the match. Only a message placed after the baseline counts;
//   the clock slack applies on top of that.
// - A send made while the pane's own Chat said its session's transcript was
//   not found (`noTranscript`, told by the sender; Pi and Claude Code name a
//   session before they write its file with the first message): that file did
//   not exist then, so the pane's first live transcript after it holds no
//   history from before it. There the send settles into the first message of
//   its text and attachments not taken by another bubble, in its terminal and
//   session, timed no more than the clock slack before it or with no time (one
//   bubble, at the message's place, no note). Nothing there: that timeline is
//   its baseline as usual. Until a live transcript of the pane comes, the
//   backstop does not call it Not sent (at most `notSentWhileWorkingMs`).
// - Both sides are normalised by the same visible-text rules
//   (pasted_content unwrapped, uploads and image markers out, whitespace).
// - Bubbles belong to the pane's terminal and agent session; each
//   snapshot reconciles them (reconcile): a pane gone or no longer an agent's
//   forgets its own, and a new terminal or session drops them with a quiet line.
// - What Chat showed of a pane is a baseline only while the
//   pane stays live and the same: an update that is not live, or a snapshot
//   with another terminal or session (a known session no longer named counts),
//   lets it go, so a send in that gap takes the next live timeline.
// - After your stop, once a later send's bubble goes, the older
//   ones still waiting go with it (a stopped message Claude Code took back
//   never matches).
// - A bubble also settles when its text is contained in a later message of
//   yours (a queued_command too), the interrupt line taken off
//   first: Claude Code's joined queue after an Esc, glued text from older
//   builds, a message absorbed mid-turn. A message Esc cancelled before
//   any answer comes back to the box (takeBack): its bubble goes, or the
//   message it settled into is hidden. The backstop (PendingBackstop): idle or
//   done for 5 s with no queue on Claude's screen, a bubble still waiting turns
//   "Not sent"; one tap puts its text back in the box.
// - A Claude Code send is shown sent by Claude's own record, not by its
//   screen: the composer empties at the Return, and a bubble main's check
//   could not prove waits until the bound (sendProofBoundMs) before it says
//   so (`unconfirmed`, with Show the terminal and Put back); one seen still in
//   Claude's box after its one corrective Return says that (`inBox`). Neither
//   is put back nor typed again by the app; both still settle by the match.
// - A picture message past its Return (`typed`) is kept by main in drafts.json
//   until the transcript settles it, Put back or Dismiss (`kept`; released
//   then, onReleased), with where its session's transcript stood (its
//   baseline's last item, a line id of Claude Code's own, onHistory). A page
//   reload or an app start brings it back as its bubble (`restore`), never into
//   the composer. It settles only by its own message: one of its own session
//   placed after that item; an identical one before it, or in another
//   session, never settles it nor releases its copy. One kept with no such
//   item settles by nothing but Put back or Dismiss (or, once its record
//   proved it, into its session's newest unclaimed message of its text). One
//   the record proved (`proved`) is never turned Not sent by the screen
//   backstop. A new session in its pane turns every unproved one "could not
//   confirm" at once, still in the box included, its destination kept: the new
//   session never settles it. A receipt that comes after its bubble settled
//   releases its copy and ends its check at once.
// - The attachments count too. The same number in all, and every path the
//   transcript names is one you sent, as many times; its images with no path
//   (inline, or an [Image #N] marker) stand for the rest only then.

import type { SessionTopology } from "../../main/herdr/wire";
import type { UnprovedSend } from "../drafts";
import { agentKind, agentSession, runsAgent } from "../send-binding";
import { interruptedThen, unwrapPasted } from "./claude-parser";
import { backstopMs, sendProofBoundMs } from "../claude-screen";
import { ChatAttachmentText } from "./tools";
import type { ChatTimeline, ChatUserMessage } from "./model";

/**
 * While the agent works, a bubble the transcript
 * never showed turns "Not sent" this long after it went (the one late
 * state; idle or done, the 5 s backstop comes first).
 */
export const notSentWhileWorkingMs = 10 * 60_000;
/** Transcript times come from the agent's machine: its clock may be behind this one by this much. */
export const clockSlackSeconds = 120;

/**
 * `notSent`, the backstop's: never seen, the agent idle with nothing queued; a tap puts it back in the box.
 * `terminalOnly`: Herdr took it for a pane with no session named, so no
 * transcript can confirm it; it is never turned Not sent and never put back (a second send would send it twice).
 * `unconfirmed`: a picture message to Claude Code whose keys and Return went, and that neither the check after it,
 * Claude Code's record nor the transcript showed by the bound (sendProofBoundMs): it says so, with Show the
 * terminal and Put back (only on that press). It still settles when the transcript shows it.
 * `inBox`: the check saw it still in Claude Code's box after its one corrective Return: the terminal holds it,
 * unsent; it says so with Show the terminal, and is never put back on the app's word (that would make two copies).
 * It settles when the transcript shows it (a Return pressed in the terminal).
 */
export type PendingState = "sending" | "sent" | "notSent" | "terminalOnly" | "unconfirmed" | "inBox";

/** The pane's terminal and agent session a bubble belongs to. */
export interface PaneScope {
  readonly terminalID: string;
  /** Null when not known yet. */
  readonly session: string | null;
}

export interface PendingMessage {
  /** Local id (the bubble's key). */
  readonly id: string;
  /** The pane: `hostId/paneId` (composer-drafts' draftKey). */
  readonly key: string;
  readonly text: string;
  /** The text as the transcript will show it, for matching. */
  readonly match: string;
  /** What it carries besides its text, for matching. */
  readonly attachments: MatchAttachments;
  readonly sentAtMs: number;
  readonly state: PendingState;
  /** The terminal and session it was sent to; null when not known. */
  readonly scope: PaneScope | null;
  /**
   * Sent with no usable session, as it went: Herdr named none
   * for the pane and Chat was not showing its transcript live. Kept from the send on, whatever Chat shows later
   * (loading, switched away, a session named before its next effect): once Herdr takes it, it is `terminalOnly`.
   */
  readonly noSession?: true;
  /**
   * Sent while the pane's own Chat said its session's transcript was not found (the sender tells it, never derived
   * from which pane Chat follows): the first live transcript after it may already hold it (adoptedMatch).
   */
  readonly noTranscript?: true;
  /** Main keeps it in drafts.json under this id until the transcript settles it, Put back or Dismiss. */
  readonly kept?: string;
  /** Main's check after its Return (the receipt's id), ended when the bubble settles. */
  readonly check?: string;
  /** Past its Return with main's check still pending: a candidate for Esc's take-back while Claude works. */
  readonly checking?: true;
  /** Claude Code's record showed it: the screen backstop never turns it Not sent. */
  readonly proved?: true;
  /** Brought back from drafts.json after a reload or a start: the first live transcript that holds it settles it. */
  readonly restored?: true;
}

/** What a bubble's end tells main: its kept copy (drafts.json) and its check, when it had them. */
export type ReleasedSend = Pick<PendingMessage, "id" | "kept" | "check">;

/** `item` with no check pending any more (it left sending). */
function withoutChecking(item: PendingMessage): PendingMessage {
  if (item.checking !== true) return item;
  const { checking: _checking, ...rest } = item;
  return rest;
}

/** What the chat held at (or first after) the send: only messages after it may be the match. */
interface Baseline {
  /** Your messages it held. */
  readonly before: ReadonlySet<string>;
  /** Its last item; null for an empty chat. */
  readonly anchor: string | null;
}

/** What a message carries besides its text. */
export interface MatchAttachments {
  /** The paths known, each as often as it is there. */
  readonly paths: readonly string[];
  /** Every attachment, its path known or not (an inline image, an [Image #N] marker). */
  readonly count: number;
}

/** The attachments of the text you sent, read as the transcript's parser reads your message. */
export function sentAttachments(text: string): MatchAttachments {
  const extracted = ChatAttachmentText.extract(unwrapPasted(text.replace(/\r\n?/g, "\n")));
  const paths = extracted.attachments.flatMap((attachment) => (attachment.path === null ? [] : [attachment.path]));
  return { paths, count: extracted.attachments.length + extracted.imageMarkers };
}

/** The attachments of a message in the transcript. */
export function shownAttachments(message: ChatUserMessage): MatchAttachments {
  const paths = message.attachments.flatMap((attachment) => (attachment.path === null ? [] : [attachment.path]));
  return { paths, count: message.attachments.length };
}

/**
 * The same attachments: as many in all, and every path the transcript names is
 * one you sent, as many times. Its images with no path (inline, numbered) stand
 * for the rest, which the count makes as many.
 */
export function attachmentsMatch(sent: MatchAttachments, shown: MatchAttachments): boolean {
  if (sent.count !== shown.count) return false;
  const left = new Map<string, number>();
  for (const path of sent.paths) left.set(path, (left.get(path) ?? 0) + 1);
  for (const path of shown.paths) {
    const count = left.get(path) ?? 0;
    if (count === 0) return false;
    left.set(path, count - 1);
  }
  return true;
}

/** The text as Chat shows your message: pasted tags unwrapped, uploads and image markers out, whitespace runs as one space. */
export function matchText(text: string): string {
  return ChatAttachmentText.extract(unwrapPasted(text.replace(/\r\n?/g, "\n")))
    .text.replace(/\s+/g, " ")
    .trim();
}

/** Your messages in the timeline, in order. */
export function userMessages(timeline: ChatTimeline): ChatUserMessage[] {
  return timeline.turns.flatMap((turn) => turn.items.flatMap((item) => (item.type === "user" ? [item.value] : [])));
}

function baselineOf(timeline: ChatTimeline): Baseline {
  const items = timeline.turns.flatMap((turn) => turn.items);
  return { before: new Set(userMessages(timeline).map((message) => message.id)), anchor: items.at(-1)?.value.id ?? null };
}

/** Your messages placed after the baseline's anchor (all of them when the anchor is no longer in the timeline). */
function messagesAfter(timeline: ChatTimeline, baseline: Baseline): ChatUserMessage[] {
  const items = timeline.turns.flatMap((turn) => turn.items);
  const at = baseline.anchor === null ? -1 : items.findIndex((item) => item.value.id === baseline.anchor);
  return items.slice(at + 1).flatMap((item) => (item.type === "user" ? [item.value] : []));
}

/** As T3 Code's optimistic send: "Sending…" shows only for a send still unconfirmed this long after it went. */
export const sendingLabelAfterMs = 1_500;

/**
 * What the bubble says under the text ("" for nothing: the message shows at once as a normal one, "Sending…"
 * only once it is still unconfirmed after 1.5 s; "Queued" while the agent works).
 */
export function pendingLabel(message: PendingMessage, agentWorking: boolean, nowMs: number): string {
  if (message.state === "notSent") return notSentLabel;
  if (message.state === "terminalOnly") return terminalOnlyLabel;
  if (message.state === "unconfirmed") return notConfirmedLabel;
  if (message.state === "inBox") return inBoxLabel;
  // No late label of its own; the backstop turns it "Not sent".
  if (agentWorking) return "Queued";
  if (message.state === "sending") return nowMs - message.sentAtMs >= sendingLabelAfterMs ? "Sending…" : "";
  return "Sent";
}

/**
 * Where a "Not sent" bubble stands in `timeline`:
 * before the first turn that began after it went (the turns' count: after
 * them all). Never below anything newer.
 */
export function notSentPlace(sentAtMs: number, timeline: ChatTimeline): number {
  const at = timeline.turns.findIndex((turn) => turn.startedAt !== null && turn.startedAt * 1_000 > sentAtMs);
  return at < 0 ? timeline.turns.length : at;
}

/** The "Not sent" bubbles by their place (`notSentPlace`), oldest first; the rest wait at the bottom. */
export function placePending(
  pending: readonly PendingMessage[],
  timeline: ChatTimeline,
): { readonly placed: ReadonlyMap<number, readonly PendingMessage[]>; readonly waiting: readonly PendingMessage[] } {
  const placed = new Map<number, PendingMessage[]>();
  for (const message of [...pending].filter((item) => placedStates.has(item.state)).sort((a, b) => a.sentAtMs - b.sentAtMs)) {
    const at = notSentPlace(message.sentAtMs, timeline);
    placed.set(at, [...(placed.get(at) ?? []), message]);
  }
  return { placed, waiting: pending.filter((item) => !placedStates.has(item.state)) };
}

/** The backstop's bubble. */
export const notSentLabel = "Not sent \u00B7 tap to put it back in the box";

/** A send Herdr took for a pane with no session named. */
export const terminalOnlyLabel = "Sent to the terminal. Chat cannot show the reply without a session.";

/** A picture message nothing proved by the bound (its actions: Show the terminal, Put back). */
export const notConfirmedLabel = "Adari could not confirm Claude Code got this.";

/** Still in Claude Code's box after the one corrective Return (its action: Show the terminal). */
export const inBoxLabel = "Still in Claude Code's box in the terminal, not sent.";

/**
 * Bubbles that stand at their place in time (never below anything newer): Not sent, sent with no session, not
 * confirmed, and still in the terminal's box.
 */
const placedStates: ReadonlySet<PendingState> = new Set<PendingState>(["notSent", "terminalOnly", "unconfirmed", "inBox"]);

/** Your message's text for containment: the interrupt line off, as Chat shows it. */
function containedText(text: string): string {
  return matchText(interruptedThen(text) ?? text);
}

/** The timeline without your messages that came back to the box. */
export function withoutTakenBack(timeline: ChatTimeline, ids: ReadonlySet<string>): ChatTimeline {
  if (ids.size === 0) return timeline;
  const turns = timeline.turns
    .map((turn) => (turn.items.some((item) => item.type === "user" && ids.has(item.value.id)) ? { ...turn, items: turn.items.filter((item) => !(item.type === "user" && ids.has(item.value.id))) } : turn))
    .filter((turn) => turn.items.length > 0);
  return turns.length === timeline.turns.length && turns.every((turn, index) => turn === timeline.turns[index]) ? timeline : { ...timeline, turns };
}

/** The quiet line for bubbles dropped because the pane's agent session (or terminal) changed. */
export function droppedText(count: number): string {
  return count === 1
    ? "A message sent to the agent's previous session is no longer shown here."
    : `${count} messages sent to the agent's previous session are no longer shown here.`;
}

function scopeChanged(sent: PaneScope, now: PaneScope): boolean {
  if (sent.terminalID !== "" && now.terminalID !== "" && sent.terminalID !== now.terminalID) return true;
  return sent.session !== null && now.session !== null && sent.session !== now.session;
}

/** The followed timeline is not this pane's any more: a scope change, or a known session no longer named. */
function followedScopeChanged(shown: PaneScope, now: PaneScope): boolean {
  return scopeChanged(shown, now) || (shown.session !== null && now.session === null);
}

type ScopeHost = { readonly id: string; readonly topology: SessionTopology | null };

/**
 * The panes Restart asked to /exit and
 * resume the same session. While one runs, and after it typed the resume
 * until an agent shows in the pane again (at most `restartHoldMs`), the
 * pane's shell in the same terminal counts as the bound agent for its
 * bubbles (pendingScopes), so they are not cleared by the exit. A pane gone,
 * another terminal, or any agent back ends the hold; the bubbles then go
 * by the usual rules (another session drops them with the quiet line).
 */
export const restartHoldMs = 60_000;

/** A scope no bubble was sent to: the pane's agent is another kind than the one held. */
const anotherAgent = "\u0000another-agent";

export class RestartHolds {
  private readonly holds = new Map<string, { readonly scope: PaneScope; readonly kind: string | null; untilMs: number | null }>();

  /** Restart started for the pane `key` (host/pane) bound to `scope` and the agent `kind` (the kind, the terminal and the session). */
  hold(key: string, scope: PaneScope, _nowMs: number, kind: string | null = null): void {
    this.holds.set(key, { scope, kind, untilMs: null });
  }

  /** Restart ended: `resumed` (the resume command went) keeps the hold until the agent is back; otherwise it ends now. */
  ended(key: string, resumed: boolean, nowMs: number): void {
    const hold = this.holds.get(key);
    if (hold === undefined) return;
    if (resumed) hold.untilMs = nowMs + restartHoldMs;
    else this.holds.delete(key);
  }

  /** The holds still in force by these snapshots (each pane's shell in its bound terminal); the others end here. */
  held(hosts: readonly ScopeHost[], nowMs: number): ReadonlyMap<string, PaneScope> {
    const out = new Map<string, PaneScope>();
    for (const [key, hold] of this.holds) {
      const slash = key.indexOf("/");
      const host = hosts.find((candidate) => candidate.id === key.slice(0, slash));
      if (host === undefined || host.topology === null) continue;
      const paneID = key.slice(slash + 1);
      const pane = host.topology.panes.find((candidate) => candidate.paneID === paneID) ?? null;
      const agent = host.topology.agents.find((candidate) => candidate.paneID === paneID) ?? null;
      const resumed = hold.untilMs !== null;
      const over = resumed && nowMs >= hold.untilMs!;
      const agentRuns = pane !== null && runsAgent(pane, agent);
      if (pane === null || (hold.scope.terminalID !== "" && pane.terminalID !== hold.scope.terminalID) || over) {
        this.holds.delete(key);
        continue;
      }
      if (agentRuns) {
        // Another kind in the pane, its session told or not: the held bubbles go.
        const kind = agentKind(agent, pane);
        if (hold.kind !== null && kind !== null && kind !== hold.kind) {
          this.holds.delete(key);
          out.set(key, { terminalID: pane.terminalID, session: anotherAgent });
          continue;
        }
        // The same kind back after the resume: the usual rules (another session drops them).
        // Before the resume went it is the one asked to exit: the hold stays.
        if (resumed) this.holds.delete(key);
        continue;
      }
      out.set(key, hold.scope);
    }
    return out;
  }
}

export const restartHolds = new RestartHolds();

/** Every agent pane's scope by the machines' snapshots, and which bubbles those snapshots speak for; `held`: Restart's panes (their shell counts as the bound agent). */
export function pendingScopes(hosts: readonly ScopeHost[], held: ReadonlyMap<string, PaneScope> = new Map()): {
  scopes: Map<string, PaneScope>;
  covers: (key: string) => boolean;
} {
  const scopes = new Map<string, PaneScope>();
  const known = new Set<string>();
  for (const host of hosts) {
    if (host.topology === null) continue;
    known.add(host.id);
    for (const pane of host.topology.panes) {
      const key = `${host.id}/${pane.paneID}`;
      const agent = host.topology.agents.find((candidate) => candidate.paneID === pane.paneID) ?? null;
      const bound = held.get(key);
      if (bound !== undefined) {
        scopes.set(key, bound);
        continue;
      }
      if (!runsAgent(pane, agent)) continue;
      scopes.set(key, { terminalID: pane.terminalID, session: agentSession(agent) });
    }
  }
  return {
    scopes,
    covers: (key) => {
      const slash = key.indexOf("/");
      return slash > 0 && known.has(key.slice(0, slash));
    },
  };
}

const emptyIDs: ReadonlySet<string> = new Set();
/** The texts an Esc brought back kept per pane (as many as a take-back asks for). */
const takeBackKept = 8;
/** Settled bubbles remembered for a receipt still on its way (its ids are released at once). */
const settledIdsKept = 64;

export class PendingMessages {
  private items: PendingMessage[] = [];
  /** Per pane, the user messages already taken as a bubble's match. */
  private readonly claimed = new Map<string, Set<string>>();
  /** Per message, what containment has not used of its text yet. */
  /** Per pane, the newest bubbles settled (their message and text), and the messages that came back to the box. */
  private readonly settled = new Map<string, { readonly message: string; readonly match: string }[]>();
  private readonly takenBack = new Map<string, ReadonlySet<string>>();
  /** Per pane, the texts (by match) whose latest send already came back to the box. */
  private readonly back = new Map<string, Set<string>>();
  /**
   * Per pane, the texts (by match) an Esc brought back to the box, newest last (a new send of the same words keeps
   * them): a start of one may stay in Claude Code's box and join the next prompt.
   */
  private readonly returned = new Map<string, string[]>();
  /** Per bubble, its baseline once known. */
  private readonly baselines = new Map<string, Baseline>();
  /**
   * Bubbles whose baseline came back from drafts.json (restore): only a timeline that holds its anchor can settle
   * them (none other tells their own message from history).
   */
  private readonly anchored = new Set<string>();
  /** Kept copies whose history main was told (onHistory), once each. */
  private readonly historyTold = new Set<string>();
  /** Told each kept copy's history once its bubble has a baseline. */
  private readonly histories = new Set<(kept: string, anchor: string | null) => void>();
  /** The newest bubbles the transcript settled (a receipt after that releases its ids at once), oldest first. */
  private readonly settledIds: string[] = [];
  /** The pane Chat follows now, its last live timeline, and the pane's terminal and session as the snapshots had them then. */
  private following: { readonly key: string; readonly timeline: ChatTimeline; readonly scope: PaneScope | null } | null = null;
  /** Each agent pane's terminal and session by the latest snapshots (reconcile). */
  private readonly scopes = new Map<string, PaneScope>();
  /** Per pane, bubbles dropped because its session changed (the quiet line). */
  private readonly dropped = new Map<string, number>();
  private readonly listeners = new Set<() => void>();
  /** Told the id of each send that failed (a stop armed for it goes). */
  private readonly failures = new Set<(id: string) => void>();
  /** Told each bubble with a kept copy or a check that settled, was put back, dismissed or taken back. */
  private readonly releases = new Set<(item: ReleasedSend) => void>();
  /** Kept copies released here: a later word of main's about one never brings its bubble back. */
  private readonly released = new Set<string>();
  private serial = 0;
  private readonly cache = new Map<string, readonly PendingMessage[]>();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** `listener` is told the id of each send that fails from now on. */
  onFailed(listener: (id: string) => void): () => void {
    this.failures.add(listener);
    return () => this.failures.delete(listener);
  }

  /**
   * `listener` is told each bubble with a kept copy or a check that the transcript settled, or that was put back,
   * dismissed or taken back (main releases its kept copy and stops its check). A pane gone tells nothing: main moves
   * its kept copy to Kept drafts itself.
   */
  onReleased(listener: (item: ReleasedSend) => void): () => void {
    this.releases.add(listener);
    return () => this.releases.delete(listener);
  }

  /**
   * `listener` is told, once per kept copy, where its session's transcript stood when it went: its bubble's baseline's
   * last item (null: the transcript held nothing), once the bubble has a baseline and its copy an id.
   */
  onHistory(listener: (kept: string, anchor: string | null) => void): () => void {
    this.histories.add(listener);
    return () => this.histories.delete(listener);
  }

  /** Tells main where `item`'s transcript stood, once, when it has both a kept copy and a baseline (not a restored one). */
  private tellHistory(item: PendingMessage): void {
    if (item.kept === undefined || item.restored === true || this.historyTold.has(item.kept)) return;
    const baseline = this.baselines.get(item.id);
    if (baseline === undefined) return;
    this.historyTold.add(item.kept);
    for (const listener of this.histories) listener(item.kept, baseline.anchor);
  }

  private release(items: readonly ReleasedSend[]): void {
    for (const item of items) {
      if (item.kept === undefined && item.check === undefined) continue;
      if (item.kept !== undefined) this.released.add(item.kept);
      for (const listener of this.releases) listener({ id: item.id, kept: item.kept, check: item.check });
    }
  }

  /** The pane's bubbles, oldest first; the same array until they change. */
  forPane(key: string): readonly PendingMessage[] {
    let cached = this.cache.get(key);
    if (cached === undefined) {
      cached = this.items.filter((item) => item.key === key);
      this.cache.set(key, cached);
    }
    return cached;
  }

  /** Every pane that has a bubble. */
  keys(): string[] {
    return [...new Set(this.items.map((item) => item.key))];
  }

  /** How many of the pane's bubbles went with its previous session (0: no quiet line). */
  droppedFor(key: string): number {
    return this.dropped.get(key) ?? 0;
  }

  /**
   * A Send began: the bubble shows now. Returns its id. `noTranscript`: the pane's own Chat said its session's
   * transcript was not found as it went (ignored for a send Chat follows the pane's live transcript for, or with no
   * session named).
   */
  add(key: string, text: string, nowMs: number, scope: PaneScope | null = null, noTranscript = false): string {
    this.serial += 1;
    const id = `pending-${this.serial}`;
    const followed = this.following?.key === key;
    if (followed) this.baselines.set(id, baselineOf(this.following!.timeline));
    this.dropped.delete(key);
    // A new send of these words has not come back yet.
    this.back.get(key)?.delete(matchText(text));
    // No session Herdr names and no live transcript Chat follows: nothing can confirm it.
    const noSession = scope !== null && scope.session === null && !followed;
    const unwritten = noTranscript && !followed && !noSession;
    const message: PendingMessage = {
      id,
      key,
      text,
      match: matchText(text),
      attachments: sentAttachments(text),
      sentAtMs: nowMs,
      state: "sending",
      scope,
      ...(noSession ? { noSession: true as const } : {}),
      ...(unwritten ? { noTranscript: true as const } : {}),
    };
    this.items = [...this.items, message];
    this.changed();
    return id;
  }

  /** Herdr took it: a send made with no usable session is "Sent to the terminal" now, any other waits. */
  delivered(id: string): void {
    const index = this.items.findIndex((item) => item.id === id);
    if (index < 0) return;
    this.items = this.items.map((item) => (item.id === id ? withoutChecking({ ...item, state: item.noSession === true ? "terminalOnly" : "sent" }) : item));
    this.changed();
  }

  /**
   * Herdr took a picture message and main's check runs on (`check`), its copy kept in drafts.json (`kept`): the
   * bubble, still sending, is past its Return (a candidate for Esc's take-back while Claude works).
   */
  typed(id: string, follow: { readonly check?: string | null; readonly kept?: string | null }): void {
    const check = follow.check ?? undefined;
    const kept = follow.kept ?? undefined;
    if (!this.items.some((item) => item.id === id && item.state === "sending")) {
      // The transcript settled it before its receipt came: its copy and its check are retired at once, so nothing is
      // left to come back on a reload. A bubble gone another way (Put back, Dismiss, a take-back) is left as it was.
      if (this.settledIds.includes(id) && !this.items.some((item) => item.id === id)) {
        this.release([{ id, ...(kept === undefined ? {} : { kept }), ...(check === undefined ? {} : { check }) }]);
      }
      return;
    }
    this.items = this.items.map((item) =>
      item.id === id
        ? {
            ...item,
            checking: true as const,
            ...(follow.check === undefined || follow.check === null ? {} : { check: follow.check }),
            ...(follow.kept === undefined || follow.kept === null ? {} : { kept: follow.kept }),
          }
        : item,
    );
    const typed = this.items.find((item) => item.id === id);
    if (typed !== undefined) this.tellHistory(typed);
    this.changed();
  }

  /**
   * Main's check after a picture message's Return answered, at once or late (only while its bubble is still here):
   * `taken` (Claude Code's record proved it; for a pane with no session, its screen) is delivered and keeps that
   * proof (`proved`: the screen backstop never turns it Not sent), from sending, could not confirm or still in the box;
   * `stillInBox` turns a bubble sending or could-not-confirm `inBox`; `unknown` changes nothing (the bound turns it).
   */
  checked(id: string, outcome: "taken" | "unknown" | "stillInBox"): void {
    const item = this.items.find((candidate) => candidate.id === id);
    if (item === undefined) return;
    if (outcome === "taken") {
      if (item.state !== "sending" && item.state !== "unconfirmed" && item.state !== "inBox") return;
      this.items = this.items.map((candidate) =>
        candidate.id === id
          ? withoutChecking({ ...candidate, state: candidate.noSession === true ? "terminalOnly" : "sent", ...(candidate.noSession === true ? {} : { proved: true as const }) })
          : candidate,
      );
      this.changed();
      return;
    }
    if (outcome === "stillInBox" && (item.state === "sending" || item.state === "unconfirmed")) {
      this.items = this.items.map((candidate) => (candidate.id === id ? withoutChecking({ ...candidate, state: "inBox" }) : candidate));
      this.changed();
    }
  }

  /** The bound passed with nothing showing it: a bubble still sending says Adari could not confirm it. */
  unconfirmed(id: string): void {
    this.turn(id, "unconfirmed");
  }

  /** A bubble still sending turns `state`. */
  private turn(id: string, state: PendingState): void {
    if (!this.items.some((item) => item.id === id && item.state === "sending")) return;
    this.items = this.items.map((item) => (item.id === id ? withoutChecking({ ...item, state }) : item));
    this.changed();
  }

  /**
   * Dismiss on a bubble Adari could not confirm, or one still in the terminal's box: it goes, nothing put back and
   * nothing sent (its kept copy released). False when there is no such bubble.
   */
  dismiss(id: string): boolean {
    const bubble = this.items.find((item) => item.id === id && (item.state === "unconfirmed" || item.state === "inBox"));
    if (bubble === undefined) return false;
    this.baselines.delete(id);
    this.items = this.items.filter((item) => item.id !== id);
    this.release([bubble]);
    this.changed();
    return true;
  }

  /**
   * The messages main kept from their Return (drafts.json `unproved`), after a page reload or an app start: each not
   * shown yet and not released comes back as its bubble, never into the composer: `sent` (proved) when Claude Code's
   * record showed it, `inBox` when main's check saw it still in Claude's box, `sending` while its check may still
   * answer and the bound (sendProofBoundMs from its Return) has not passed, else `unconfirmed`. Its session and
   * where its transcript stood (`history`) are its baseline: only its own session's message after that item settles
   * it (one kept with none settles by nothing the transcript shows, unless proved). One sent with no session named
   * keeps that rule (noSession: only a message provably after it). A bubble already shown takes main's newer word
   * only (checked); with `add` false no bubble is added. The ids of the restored bubbles still sending and when their
   * bound passes.
   */
  restore(entries: readonly UnprovedSend[], nowMs: number, add = true): { readonly id: string; readonly boundAt: number }[] {
    const pending: { id: string; boundAt: number }[] = [];
    let added = false;
    for (const entry of entries) {
      if (this.released.has(entry.id)) continue;
      const shown = this.items.find((item) => item.kept === entry.id);
      if (shown !== undefined) {
        if (entry.outcome !== "checking") this.checked(shown.id, entry.outcome);
        continue;
      }
      if (!add) continue;
      const boundAt = entry.sentAt + sendProofBoundMs;
      const noSession = entry.session === null;
      const state: PendingState =
        entry.outcome === "taken"
          ? noSession
            ? "terminalOnly"
            : "sent"
          : entry.outcome === "stillInBox"
            ? "inBox"
            : entry.outcome === "checking" && nowMs < boundAt
              ? "sending"
              : "unconfirmed";
      this.serial += 1;
      const id = `pending-${this.serial}`;
      const key = `${entry.hostId}/${entry.paneId}`;
      if (entry.history !== undefined) {
        this.baselines.set(id, { before: emptyIDs, anchor: entry.history.anchor });
        this.anchored.add(id);
      }
      this.items = [
        ...this.items,
        {
          id,
          key,
          text: entry.text,
          match: matchText(entry.text),
          attachments: sentAttachments(entry.text),
          sentAtMs: entry.sentAt,
          state,
          scope: { terminalID: entry.terminalID, session: entry.session },
          kept: entry.id,
          restored: true,
          ...(noSession ? { noSession: true as const } : {}),
          ...(state === "sent" ? { proved: true as const } : {}),
          ...(state === "sending" ? { checking: true as const } : {}),
        },
      ];
      added = true;
      if (state === "sending") pending.push({ id, boundAt });
    }
    if (added) this.changed();
    return pending;
  }

  /** It was not sent: no bubble (the box keeps the text and says why). */
  failed(id: string): void {
    // The send failed whether or not the transcript already took its bubble; told first, before the list changes.
    for (const listener of this.failures) listener(id);
    const next = this.items.filter((item) => item.id !== id);
    if (next.length === this.items.length) return;
    this.baselines.delete(id);
    this.items = next;
    this.changed();
  }

  /** Chat stopped following the pane: what it held is no baseline for later sends. */
  unfollow(key: string): void {
    if (this.following?.key === key) this.following = null;
  }

  /**
   * A new timeline for the pane. Only a live one counts: it becomes the
   * baseline of the sends that had none (never their match), and the others'
   * messages that it now has after their baseline make their bubbles go. One
   * that is not live lets the pane's followed timeline go.
   */
  observe(key: string, timeline: ChatTimeline, live = true): void {
    if (!live) {
      // Loading or unavailable: what it showed is no baseline for a send now.
      if (this.following?.key === key) this.following = null;
      return;
    }
    const shownScope = this.scopes.get(key) ?? null;
    this.following = { key, timeline, scope: shownScope };
    // A kept message waits only on its own session: a timeline of another (or, for one brought back, of a session not
    // known yet) is no baseline and no match for it. One brought back with its history is matched only by a timeline
    // that still holds its anchor.
    const waiting = this.items.filter((item) => item.key === key && !this.blindTo(item, shownScope, timeline));
    if (waiting.length === 0) return;
    let claimed = this.claimed.get(key);
    const matched = new Set<string>();
    /** Each matched bubble's message. */
    const landed = new Map<string, string>();
    /** Bubbles whose baseline is this timeline (never their match). */
    const fresh = new Set<string>();
    for (const item of waiting) {
      const baseline = this.baselines.get(item.id);
      if (baseline === undefined) {
        // A send made with no session, or into a transcript not written yet, and the first live transcript
        // already holds it: it settles into that message (one bubble, no note) instead of taking it as its baseline.
        // One brought back with no history takes no baseline either: nothing tells its message from history.
        const adopted = this.adoptedMatch(item, timeline, (id) => (claimed?.has(id) ?? false) || [...landed.values()].includes(id));
        if (adopted !== null) {
          if (claimed === undefined) {
            claimed = new Set();
            this.claimed.set(key, claimed);
          }
          claimed.add(adopted);
          matched.add(item.id);
          landed.set(item.id, adopted);
          continue;
        }
        if (item.restored === true && item.noSession !== true) continue;
        this.baselines.set(item.id, baselineOf(timeline));
        fresh.add(item.id);
        this.tellHistory(item);
        continue;
      }
      const found = messagesAfter(timeline, baseline).find(
        (message) =>
          !baseline.before.has(message.id) &&
          !(claimed?.has(message.id) ?? false) &&
          (message.time === null || message.time >= item.sentAtMs / 1_000 - clockSlackSeconds) &&
          matchText(message.text) === item.match &&
          attachmentsMatch(item.attachments, shownAttachments(message)),
      );
      if (found === undefined) continue;
      if (claimed === undefined) {
        claimed = new Set();
        this.claimed.set(key, claimed);
      }
      claimed.add(found.id);
      matched.add(item.id);
      landed.set(item.id, found.id);
    }
    // The rest settle on a later message of yours made
    // of their texts, the interrupt line taken off first: Claude's joined
    // queue after an Esc, glued text from older builds. Only a message they
    // cover whole (with the texts that settled before; nothing else in it but
    // space) settles them, and it takes two parts, or one after an interrupt
    // line: "yes" never settles on "yes please".
    const open = waiting.filter((item) => !matched.has(item.id) && !fresh.has(item.id) && item.match !== "" && this.baselines.has(item.id));
    if (open.length > 0) {
      const earlier = (this.settled.get(key) ?? []).map((entry) => entry.match).filter((match) => match !== "");
      const after = new Map(open.map((item) => [item.id, new Set(messagesAfter(timeline, this.baselines.get(item.id)!).map((message) => message.id))]));
      for (const message of userMessages(timeline)) {
        if (claimed?.has(message.id) ?? false) continue;
        const stripped = interruptedThen(message.text) !== null;
        let text = containedText(message.text);
        if (text === "") continue;
        const parts: PendingMessage[] = [];
        for (const item of open) {
          if (matched.has(item.id) || !(after.get(item.id)?.has(message.id) ?? false)) continue;
          if (this.baselines.get(item.id)!.before.has(message.id)) continue;
          if (message.time !== null && message.time < item.sentAtMs / 1_000 - clockSlackSeconds) continue;
          const at = text.indexOf(item.match);
          if (at < 0) continue;
          text = `${text.slice(0, at)}\u0000${text.slice(at + item.match.length)}`;
          parts.push(item);
        }
        if (parts.length === 0) continue;
        let count = parts.length;
        for (const match of earlier) {
          const at = text.indexOf(match);
          if (at < 0) continue;
          text = `${text.slice(0, at)}\u0000${text.slice(at + match.length)}`;
          count += 1;
        }
        // What is left is a start of a message an Esc brought back (whole rows of it its clear did not reach,
        // joined to the next prompt in Claude's box): it counts as a part.
        const rest = text.split("\u0000").join(" ").replace(/\s+/g, " ").trim();
        if (rest !== "" && (this.returned.get(key) ?? []).some((back) => back === rest || back.startsWith(`${rest} `))) {
          text = "";
          count += 1;
        }
        if (text.split("\u0000").join("").replace(/\s/g, "") !== "" || count < (stripped ? 1 : 2)) continue;
        if (claimed === undefined) {
          claimed = new Set();
          this.claimed.set(key, claimed);
        }
        claimed.add(message.id);
        for (const item of parts) {
          matched.add(item.id);
          landed.set(item.id, message.id);
        }
      }
    }
    if (matched.size === 0) return;
    const log = [...(this.settled.get(key) ?? [])];
    for (const item of waiting) {
      const message = landed.get(item.id);
      if (message !== undefined) log.push({ message, match: item.match });
    }
    this.settled.set(key, log.slice(-16));
    this.settleStopped(waiting, matched, landed, timeline);
    for (const id of matched) {
      this.baselines.delete(id);
      this.anchored.delete(id);
      this.settledIds.push(id);
    }
    this.settledIds.splice(0, Math.max(0, this.settledIds.length - settledIdsKept));
    const settled = this.items.filter((item) => matched.has(item.id));
    this.items = this.items.filter((item) => !matched.has(item.id));
    this.release(settled);
    this.changed();
  }

  /**
   * `item` is not this timeline's to settle: a kept message whose session is not the one shown (its destination is
   * kept through a session change), one brought back while the shown session is not known yet, or one brought back
   * with its history whose anchor this timeline does not hold.
   */
  private blindTo(item: PendingMessage, shown: PaneScope | null, timeline: ChatTimeline): boolean {
    if (item.kept === undefined && item.restored !== true) return false;
    if (item.scope !== null && shown !== null && scopeChanged(item.scope, shown)) return true;
    if (item.restored !== true) return false;
    if (shown === null || (item.scope !== null && item.scope.session !== null && shown.session !== item.scope.session)) return true;
    if (!this.anchored.has(item.id)) return false;
    const anchor = this.baselines.get(item.id)?.anchor ?? null;
    return anchor !== null && !timeline.turns.some((turn) => turn.items.some((one) => one.value.id === anchor));
  }

  /**
   * The message a send made with no session (noSession, or made Sent to the terminal) settles into in the first live
   * timeline after it, or null (the timeline is its baseline as usual).
   *
   * Only a message that is provably this send: timed strictly after the send (no negative slack; a message with no
   * time never), its text and attachments, not taken by another bubble, and the
   * pane's terminal and session the send's. The first such message in the transcript's order: `observe` asks for the
   * sends in the order they went, so with two identical sends the first takes the first new message and the second the
   * second (take-back then hides the right one). An identical message timed before the send (history, or the send
   * itself on a machine whose clock is behind) cannot be told from history: the acknowledgement stays.
   *
   * A message timed exactly at the send's stored time is no proof either (history on the same second looks the
   * same), so it keeps the acknowledgement too.
   *
   * A send made into a transcript not written yet (noTranscript) settles the same way, in its terminal and session,
   * into a message timed no more than the clock slack before it or with no time: the file did not exist at the send,
   * so this first live transcript holds no history from before it. One older than the slack is never taken.
   */
  private adoptedMatch(item: PendingMessage, timeline: ChatTimeline, taken: (id: string) => boolean): string | null {
    // Brought back with no history but proved by Claude Code's record (a line of its session after its Return): it
    // settles into its session's newest message of its text not taken by another bubble (the session is checked by
    // blindTo). Not proved: nothing tells it from history, so nothing settles it.
    if (item.restored === true && item.noSession !== true) {
      if (item.proved !== true) return null;
      const newest = userMessages(timeline).findLast(
        (message) => !taken(message.id) && matchText(message.text) === item.match && attachmentsMatch(item.attachments, shownAttachments(message)),
      );
      return newest?.id ?? null;
    }
    const unwritten = item.noTranscript === true;
    if (item.noSession !== true && item.state !== "terminalOnly" && !unwritten) return null;
    const now = this.following?.key === item.key ? this.following.scope : null;
    if (item.scope !== null && now !== null && scopeChanged(item.scope, now)) return null;
    const sentAt = item.sentAtMs / 1_000;
    // Sent into a transcript not written yet: its first live transcript has no history from before the send, so
    // the clock slack applies (the other machine's clock may be behind), and a message with no time counts.
    const timely = (time: number | null): boolean => (unwritten ? time === null || time >= sentAt - clockSlackSeconds : time !== null && time > sentAt);
    const found = userMessages(timeline).find(
      (message) => !taken(message.id) && timely(message.time) && matchText(message.text) === item.match && attachmentsMatch(item.attachments, shownAttachments(message)),
    );
    return found?.id ?? null;
  }

  /**
   * A bubble the backstop leaves alone at `nowMs`: sent into a transcript not written yet, no live transcript of the
   * pane seen since (no baseline), and not yet `notSentWhileWorkingMs` old.
   */
  private awaitingTranscript(item: PendingMessage, nowMs: number): boolean {
    return item.noTranscript === true && !this.baselines.has(item.id) && nowMs - item.sentAtMs < notSentWhileWorkingMs;
  }

  /** Whether the pane has a bubble Herdr took that the backstop leaves alone for now (awaitingTranscript). */
  awaitsTranscript(key: string, nowMs: number = Date.now()): boolean {
    return this.items.some((item) => item.key === key && item.state === "sent" && this.awaitingTranscript(item, nowMs));
  }

  /**
   * Claude Code put `text` (your last send) back in its box:
   * the newest bubble with that text goes, or, already settled, the message it
   * settled into is no longer shown. False when neither is found.
   */
  takeBack(key: string, text: string): boolean {
    const match = matchText(text);
    this.markBack(key, match);
    if (match !== "") this.returned.set(key, [...(this.returned.get(key) ?? []).filter((back) => back !== match), match].slice(-takeBackKept));
    const bubble = this.items.findLast((item) => item.key === key && item.match === match);
    if (bubble !== undefined) {
      this.baselines.delete(bubble.id);
      this.items = this.items.filter((item) => item.id !== bubble.id);
      this.release([bubble]);
      this.changed();
      return true;
    }
    const log = this.settled.get(key) ?? [];
    const found = log.findLast((entry) => entry.match === match);
    if (found === undefined) return false;
    this.settled.set(key, log.filter((entry) => entry !== found));
    this.takenBack.set(key, new Set([...(this.takenBack.get(key) ?? []), found.message]));
    this.changed();
    return true;
  }

  /**
   * The pane's latest send of `text` already came back to the
   * box (an Esc's take-back, or a tap on its "Not sent" bubble), and no send
   * of the same words went since: another answer for it is a repeat.
   */
  cameBack(key: string, text: string): boolean {
    return this.back.get(key)?.has(matchText(text)) ?? false;
  }

  private markBack(key: string, match: string): void {
    const texts = this.back.get(key) ?? new Set<string>();
    texts.add(match);
    this.back.set(key, texts);
  }

  /** The pane's messages that came back to the box (not shown). */
  takenBackFor(key: string): ReadonlySet<string> {
    return this.takenBack.get(key) ?? emptyIDs;
  }

  /**
   * The backstop: the pane's bubbles Herdr took and the transcript never showed turn "Not sent"; one still awaiting
   * the pane's first live transcript (awaitingTranscript at `nowMs`) waits.
   */
  markNotSent(key: string, sentByMs: number | null = null, nowMs: number = Date.now()): boolean {
    let changed = false;
    this.items = this.items.map((item) => {
      if (item.key !== key || item.state !== "sent") return item;
      // Claude Code's record proved it went: the screen never says otherwise.
      if (item.proved === true) return item;
      if (sentByMs !== null && item.sentAtMs > sentByMs) return item;
      if (this.awaitingTranscript(item, nowMs)) return item;
      changed = true;
      return { ...item, state: "notSent" };
    });
    if (changed) this.changed();
    return changed;
  }

  /**
   * The pane has no session named: its bubbles Herdr took read "Sent to the
   * terminal" (nothing can confirm them, so the backstop never turns them Not sent).
   */
  markTerminalOnly(key: string): boolean {
    let changed = false;
    this.items = this.items.map((item) => {
      if (item.key !== key || item.state !== "sent") return item;
      changed = true;
      return { ...item, state: "terminalOnly" };
    });
    if (changed) this.changed();
    return changed;
  }

  /**
   * A tap on a "Not sent" bubble, or Put back on one Adari could not confirm: it goes, its text returned for the
   * box (null: no such bubble).
   */
  takeNotSent(id: string): string | null {
    const bubble = this.items.find((item) => item.id === id && (item.state === "notSent" || item.state === "unconfirmed"));
    if (bubble === undefined) return null;
    this.markBack(bubble.key, bubble.match);
    this.baselines.delete(id);
    this.items = this.items.filter((item) => item.id !== id);
    this.release([bubble]);
    this.changed();
    return bubble.text;
  }

  /**
   * Your stop (the interrupt line) after an older bubble's
   * baseline, then a later send of yours the transcript has: the older bubble
   * still waiting settles (into `matched`). Claude Code can take a queued
   * message back on Esc (enqueued, never written as your line), so nothing
   * would ever match it: it would stay at the bottom as "Queued" until the app
   * was reopened. Without a stop between, a later send may land first and each
   * clears its own.
   */
  private settleStopped(waiting: readonly PendingMessage[], matched: Set<string>, landed: ReadonlyMap<string, string>, timeline: ChatTimeline): void {
    const last = waiting.reduce((at, item, index) => (matched.has(item.id) ? index : at), -1);
    if (last <= 0) return;
    const items = timeline.turns.flatMap((turn) => turn.items);
    const message = landed.get(waiting[last]!.id);
    const end = items.findIndex((item) => item.value.id === message);
    for (const item of waiting.slice(0, last)) {
      if (matched.has(item.id)) continue;
      const baseline = this.baselines.get(item.id);
      if (baseline === undefined) continue;
      const start = baseline.anchor === null ? -1 : items.findIndex((candidate) => candidate.value.id === baseline.anchor);
      const between = items.slice(start + 1, end < 0 ? items.length : end);
      if (between.some((candidate) => candidate.type === "notice" && candidate.value.kind === "interrupted")) matched.add(item.id);
    }
  }

  /**
   * The machines' latest snapshots (`scopes`: every agent pane's terminal and
   * session; `covers`: the panes those snapshots speak for). A pane gone or no
   * longer an agent's forgets its bubbles; a new terminal or session drops them
   * with the quiet line; a session first learned is kept with the bubble. The
   * followed timeline goes with a new terminal or session too, or a known
   * session no longer named, bubbles or not.
   */
  reconcile(scopes: ReadonlyMap<string, PaneScope>, covers: (key: string) => boolean): void {
    let changed = false;
    const next: PendingMessage[] = [];
    for (const item of this.items) {
      if (!covers(item.key)) {
        next.push(item);
        continue;
      }
      const now = scopes.get(item.key);
      if (now === undefined) {
        changed = true;
        this.baselines.delete(item.id);
        continue;
      }
      if (item.scope !== null && scopeChanged(item.scope, now)) {
        // A picture message nothing proved yet, still in the box included: the old session's record can no longer
        // prove it, and the box it was seen in was the old session's, so it says Adari could not confirm it at once
        // (Show the terminal, Put back, Dismiss). Its destination stays the session it went to: the new one never
        // settles it (blindTo) nor releases its copy; its baseline stays for a return of that session.
        if (item.kept !== undefined && item.proved !== true && item.state !== "notSent") {
          if (item.state === "unconfirmed" && item.checking !== true) {
            next.push(item);
            continue;
          }
          changed = true;
          next.push(withoutChecking({ ...item, state: "unconfirmed" }));
          continue;
        }
        changed = true;
        this.baselines.delete(item.id);
        // One the record proved went to the old session: its kept copy goes with the bubble.
        if (item.kept !== undefined) this.release([item]);
        this.dropped.set(item.key, (this.dropped.get(item.key) ?? 0) + 1);
        continue;
      }
      if (item.scope !== null && item.scope.session === null && now.session !== null) {
        changed = true;
        next.push({ ...item, scope: { terminalID: item.scope.terminalID, session: now.session } });
        continue;
      }
      next.push(item);
    }
    for (const key of [...this.claimed.keys(), ...this.dropped.keys()]) {
      if (covers(key) && !scopes.has(key)) {
        this.claimed.delete(key);
        if (this.dropped.delete(key)) changed = true;
      }
    }
    for (const key of this.scopes.keys()) if (covers(key) && !scopes.has(key)) this.scopes.delete(key);
    for (const [key, scope] of scopes) this.scopes.set(key, scope);
    if (this.following !== null && covers(this.following.key)) {
      // Another terminal or session in the followed pane: its timeline is no baseline, with or without bubbles.
      const now = scopes.get(this.following.key);
      if (now === undefined || (this.following.scope !== null && followedScopeChanged(this.following.scope, now))) this.following = null;
      else this.following = { ...this.following, scope: now };
    }
    if (!changed) return;
    this.items = next;
    this.changed();
  }

  /** Drops everything (tests start from here). */
  clear(): void {
    this.items = [];
    this.released.clear();
    this.anchored.clear();
    this.historyTold.clear();
    this.settledIds.length = 0;
    this.claimed.clear();
    this.settled.clear();
    this.takenBack.clear();
    this.back.clear();
    this.returned.clear();
    this.baselines.clear();
    this.dropped.clear();
    this.scopes.clear();
    this.following = null;
    this.changed();
  }

  private changed(): void {
    this.cache.clear();
    for (const listener of this.listeners) listener();
  }
}

/**
 * The backstop: no bubble says "Queued" until restart.
 * While a pane's agent is idle or done and a bubble Herdr took still waits, a
 * timer of 5 s runs; then one read of Claude's screen (`queued`; null when not
 * read or not Claude) showing no queued messages turns the pane's waiting
 * bubbles "Not sent". Queued on screen: it waits 5 s more. Working again, or
 * nothing waiting, ends the timer.
 */
export class PendingBackstop {
  private readonly timers = new Map<string, unknown>();
  /** Per pane: whether its timer runs for an idle agent (5 s) or a working one (10 minutes). */
  private readonly idle = new Map<string, boolean>();

  constructor(
    private readonly store: PendingMessages,
    private readonly schedule: (run: () => void, ms: number) => unknown = (run, ms) => setTimeout(run, ms),
    private readonly cancel: (timer: unknown) => void = (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * The pane's agent `status` now (Herdr's); `queued` reads Claude's queue off
   * its screen. While the agent works, the oldest waiting bubble
   * turns "Not sent" 10 minutes after it went.
   */
  watch(key: string, status: string, queued: () => Promise<boolean | null>, noSession = false): void {
    const settled = status === "idle" || status === "done";
    // A bubble Claude Code's record proved is never the backstop's: no timer, no screen read for it.
    const waiting = this.store.forPane(key).filter((item) => item.state === "sent" && item.proved !== true);
    if (waiting.length === 0) {
      this.stop(key);
      return;
    }
    // No session named, so no transcript to confirm against: Herdr took
    // it, and that is what the bubble says (no timer, never Not sent). With a session the backstop runs.
    if (noSession) {
      this.stop(key);
      this.store.markTerminalOnly(key);
      return;
    }
    if (this.timers.has(key) && this.idle.get(key) === settled) return;
    this.stop(key);
    this.idle.set(key, settled);
    if (settled) {
      this.arm(key, queued);
      return;
    }
    const due = Math.min(...waiting.map((item) => item.sentAtMs)) + notSentWhileWorkingMs;
    const timer = this.schedule(() => {
      if (this.timers.get(key) !== timer) return;
      this.timers.delete(key);
      this.idle.delete(key);
      this.store.markNotSent(key, this.now() - notSentWhileWorkingMs, this.now());
    }, Math.max(0, due - this.now()));
    this.timers.set(key, timer);
  }

  stop(key: string): void {
    this.idle.delete(key);
    const timer = this.timers.get(key);
    if (timer === undefined) return;
    this.cancel(timer);
    this.timers.delete(key);
  }

  private arm(key: string, queued: () => Promise<boolean | null>): void {
    const timer = this.schedule(() => {
      void queued().then(
        (onScreen) => this.fire(key, timer, onScreen, queued),
        () => this.fire(key, timer, null, queued),
      );
    }, backstopMs);
    this.timers.set(key, timer);
  }

  private fire(key: string, timer: unknown, onScreen: boolean | null, queued: () => Promise<boolean | null>): void {
    if (this.timers.get(key) !== timer) return;
    this.timers.delete(key);
    if (onScreen === true) {
      this.arm(key, queued);
      return;
    }
    this.store.markNotSent(key, null, this.now());
    // A bubble sent into a transcript not written yet waits for it: looked at again after the same wait.
    if (this.store.awaitsTranscript(key, this.now())) this.arm(key, queued);
  }
}

// The Model and Effort chips' picks, per pane,
// renderer-wide (a pick held for the next turn survives switching panes).
//
// A pick goes once, as the agent's own command line (agent-settings.ts
// pickCommand), through the same bound send as a message (the pane, its
// terminal, agent, session and run as the row showed them; the main process
// refuses it once the pane changed) and never through your box: your draft is
// untouched and nothing shows a slash command. It goes
// only while the pane is at its prompt (idle or done): while it works or shows
// a dialog it is held, one per kind, the newest winning (the chip says "next
// turn"), and goes once the pane is back; a held pick is dropped when the pane
// changes or closes. A refusal because the pane changed copies the command and
// says so; nothing is sent again by itself. After it goes the chip shows the
// pick until the transcript confirms it, or, after 10 s, what the transcript
// says; once confirmed, Chat shows one quiet line in the turn ("Model: Opus
// 5.5").
//
// A Cursor pane's chips show what its footer says (main
// reads it: CursorFooterEvent), and only while a footer reads; its picks drive
// Cursor's own menu by keys in main (cursorPick), never as a command line.
//
// The Permissions chip shows the pane's approval mode as the
// agent shows it: Claude Code's and Grok's screens (main's mode watch,
// PaneModeEvent), Cursor's footer, Codex's rollout (the chat update's
// settings; after a pick, what its screen showed until a newer turn says
// otherwise, with no deadline). A pick goes to main's modePick by the same
// rules as the others' (only at the prompt, else held for the next turn, the
// newest winning; once on its way, not twice) and settles on the mode the
// screen showed at its end; a refusal is a note.

import type { CursorFooterEvent, CursorPickResult, GrokPickResult, HerdrDesktopBridge, HostView, ModelPickOutcome, ModePickResult, OpenCodePickResult, PaneModeEvent } from "../../shared/ipc-contract";
import { approvalMode, bypassStartNote, isOfferedMode, unknownModeLabel, type ModeAgent, type ModeIcon } from "../../shared/approval-modes";
import type { ContextLimits } from "../../shared/context-meter";
import type { CompactOutcome } from "../../shared/drafts";
import { agentStatusFromWire, type AgentStatus } from "../../shared/sidebar-model";
import { isCompactCommand, isPaneChangedNote, notAtPromptText, runBindingOf, type SendBinding } from "../../shared/send-binding";
import {
  cursorEffortChip,
  cursorEfforts,
  cursorFooterMode,
  cursorFooterSettings,
  cursorWindows,
  effortLabel,
  emptySettings,
  grokPickOf,
  grokWindowWord,
  modelFamily,
  pickCommand,
  type AgentSettings,
  type ChipAgent,
  type ChipKind,
  type CursorEffort,
  type CursorFooter,
  type CursorPick,
  type GrokFiles,
  type GrokPick,
  type PaneSettings,
  type SettingsScope,
} from "../../shared/agent-settings";
import { cursorFamilyName, sameCursorFamily, type ModelPick } from "../../shared/model-choices";
import { isModelId } from "../../shared/model-catalog";
import { composerDrafts } from "./composer-drafts";
import { draftPersistence } from "./draft-persistence";

/** The agents whose panes get chips: Claude and Codex (their transcripts), Cursor (its footer). */
export type PickAgent = ChipAgent | "cursor" | "grok" | "opencode";

/** After this long without the transcript confirming a pick, the chip shows what the transcript says. */
export const confirmWaitMs = 10_000;
/** A compaction takes longer; the ring spins this long at most without the transcript showing it. */
export const compactWaitMs = 5 * 60_000;
/**
 * Claude's Compact never spins longer than this from its send, however
 * Claude works meanwhile. An hour: a long agentic turn it may be queued behind (main lets it go into a turn
 * just begun) plus a large compaction fit in it with room to spare; a spinner stuck any longer is not a
 * compaction any more, and the ring's button is free again for a retry.
 */
export const compactLimitMs = 60 * 60_000;
/**
 * The working periods after its send that can still be Claude's
 * Compact: the turn it may be queued behind (main's working-state permission) and the compaction's own run.
 * Herdr's status cannot tell the two apart, so both are allowed; never any later turn.
 */
export const compactTurns = 2;
/** After the last of those ends, this long for the transcript's compaction line to arrive. */
export const compactGraceMs = 30_000;
/** The line when Claude's Compact ended without a compaction. */
export const compactFailedText = "Compact did not finish. Try again from the ring.";
/** A second `/compact` you send while one is held stays in the box with this note. */
export const compactAlreadyText = "A Compact is already queued for after this turn.";
/**
 * A typed `/compact` that did not go while your box held newer text is
 * in the pane's Kept drafts (kept through a reload, another pick or Compact, until Put in box or Discard); the note
 * says so, after why it did not go when that is known.
 */
export function compactKeptText(why: string | null, outcome: CompactOutcome = "refused"): string {
  if (why !== null) return `${why} Your line is in Kept drafts.`;
  return outcome === "refused" ? "Compact not sent: your line is in Kept drafts." : "Compact may have gone: your line is in Kept drafts. Check the agent before sending it again.";
}
/** Kept drafts could not take it (no room): your line is back in the box, before your newer text. */
export function compactBoxText(why: string | null, outcome: CompactOutcome = "refused"): string {
  return `${why ?? (outcome === "refused" ? "Compact not sent." : "Compact may have gone. Check the agent before sending it again.")} Your line is back in the box.`;
}

/**
 * What a held Compact's failed send says of
 * its outcome. "refused" only for main's own refusals before any key went (a "Not sent:" or "Not run:" note, or the
 * pane no longer the one picked); anything else (a Return typed but not confirmed, "Sent, but the Mac did not
 * confirm it", a failure that is not main's note) may have gone: "unknown".
 */
export function compactOutcomeOf(failure: unknown): CompactOutcome {
  if (!(failure instanceof Error)) return "unknown";
  const message = failure.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "").trim();
  return /^Not (sent|run):/.test(message) || isPaneChangedNote(message) ? "refused" : "unknown";
}

const waitOf = (kind: ChipKind): number => (kind === "compact" ? compactWaitMs : confirmWaitMs);

/** Where Compact is for the pane: held for its next turn, sent and not shown in the transcript yet, or neither. */
export type CompactState = "held" | "running" | null;

/** The pane a pick is for, as the box's row shows it now. */
export interface PickContext {
  readonly hostId: string;
  readonly paneId: string;
  readonly agent: PickAgent;
  readonly status: AgentStatus;
  readonly binding: SendBinding;
}

/** One pick from a chip's menu. */
export interface PickRequest {
  readonly kind: ChipKind;
  /** A model alias ("opus"), a level ("high"), or Codex's "picker". */
  readonly value: string;
  /** What the chip shows for it meanwhile ("Opus", "High"). */
  readonly label: string;
  /**
   * Compact only: the `/compact` line you typed in Chat's box (`/compact keep the
   * plan`), sent as you typed it; absent: `/compact`.
   * A model from the picker: the agent's own `/model …` line
   * (model-choices.ts modelPickCommand), with `expect` and `modelPick`; only shown and copied (main makes
   * what goes from `modelPick`).
   */
  readonly command?: string;
  /**
   * A model from the picker, or Codex's Effort (which names its model): the
   * structured pick main checks against the machine's list and makes its command from (never a finished line).
   */
  readonly modelPick?: ModelPick;
  /**
   * What confirms a picked model: the transcript's model id among `ids`, or its label among
   * `labels` (Cursor's model is no live pick).
   */
  readonly expect?: { readonly ids: readonly string[]; readonly labels: readonly string[] };
  /**
   * An OpenCode model from the picker: its id only (main makes every key of the pick from the
   * machine's list: IPC.openCodePick).
   */
  readonly openCodeModel?: string;
}

/** A picker's `/model` line (a model id of any agent's pattern, Codex's `--reasoning=<level>` after it). */
export const modelLineCommand = /^\/model [A-Za-z0-9~][A-Za-z0-9~._:@+/[\]-]{0,255}(?: --reasoning=[a-z]{1,16})?$/;

/**
 * A pick main makes into its command (IPC.modelPick): a model from the picker,
 * or Codex's Effort; with the line it will be, to show and copy.
 */
const isModelPickRequest = (request: PickRequest): boolean =>
  request.modelPick !== undefined &&
  request.command !== undefined &&
  (modelLineCommand.test(request.command) || (request.modelPick.agent === "cursor" && cursorFamilyCommand.test(request.command))) &&
  (request.kind === "model" || (request.kind === "effort" && request.modelPick.agent === "codex"));

/** Cursor's `/model <family name>` line, as shown and copied (main makes the one that goes). */
const cursorFamilyCommand = /^\/model [A-Za-z0-9][A-Za-z0-9 .-]{0,63}$/;

/** A model pick main types for Grok or Cursor (one at a time per pane). */
const typedLivePick = (agent: PickAgent, request: PickRequest): boolean => (agent === "grok" || agent === "cursor") && request.kind === "model" && isModelPickRequest(request);

/** The line when a model pick for the pane is still on its way. */
export const pickOnItsWayText = "Not set: the last model pick is still on its way.";
/** The same model pick made again while it is still on its way (it goes once). */
/**
 * The first border read after a Grok pick its "Switched to …" line alone
 * confirmed names that pick: the line's own name for it ("Grok 4.7 Fast"), its row's label, or its id's words
 * ("grok-4.6": "Grok 4.6"), case aside. Anything else names another model.
 */
export function grokBorderNamesKept(kept: { readonly model: string; readonly label: string; readonly said: string | null }, border: string): boolean {
  const name = border.trim().toLowerCase();
  return (kept.said !== null && name === kept.said.trim().toLowerCase()) || name === kept.label.trim().toLowerCase() || name.split(/\s+/u).join("-") === kept.model.toLowerCase();
}

export const pickStillGoingText = "Not set again: that model pick is still on its way. Its result shows here when it ends.";
/** OpenCode's model is picked only while it is idle. */
export const openCodeIdleText = "Not set: OpenCode's model can be picked when OpenCode is idle.";
/** Cursor took another family than the one asked for (nothing is retried). */
export function cursorChoseText(modelLine: string): string {
  return `Cursor chose ${modelLine}.`;
}

/** What New agent started a pane with, for the chips before its first reply. */
export interface StartShown {
  /** The agent kind started ("codex"). */
  readonly kind: string;
  /** The model chosen (null: the agent's default) and its label. */
  readonly model: string | null;
  readonly modelLabel: string | null;
  /** The effort chosen (null: the agent's default). */
  readonly effort: string | null;
}

/** The Model chip's words while nothing says the model: the agent's default. */
export const defaultModelChip = { label: "Default", title: "The agent's default model" } as const;

/** The box's note for a `/compact` you typed while Claude works: held, then sent at the turn's end. */
export const compactQueuedText = "Compact queued: it runs when this turn ends.";

/**
 * A `/compact` line (with or without your instructions), one line.
 * By main's own rule (send-binding.ts isCompactCommand), trimmed.
 */
export function isCompactLine(text: string): boolean {
  return isCompactCommand(text.trim());
}

export interface PickDeps {
  send(hostId: string, paneId: string, text: string, binding: SendBinding): Promise<void>;
  /** A model pick, checked and made into its command in main (absent: refused). */
  modelPick?(hostId: string, paneId: string, pick: ModelPick, binding: SendBinding): Promise<ModelPickOutcome | void>;
  /** An OpenCode model pick by its id, driven through its own list in main. */
  openCodePick?(hostId: string, paneId: string, model: string, binding: SendBinding): Promise<OpenCodePickResult>;
  /** A Cursor pick, driven through its menu in main. */
  cursorPick?(hostId: string, paneId: string, pick: CursorPick, binding: SendBinding): Promise<CursorPickResult>;
  /** A Grok pick, its one command typed in main. */
  grokPick?(hostId: string, paneId: string, pick: GrokPick, files: GrokFiles, binding: SendBinding): Promise<GrokPickResult>;
  /** A Permissions pick, driven in main. */
  modePick?(hostId: string, paneId: string, agent: ModeAgent, target: string, binding: SendBinding): Promise<ModePickResult>;
  copy(text: string): void;
  now(): number;
  /** The pane's draft, which owns a typed `/compact` line while it is held. */
  box?: HeldBox;
}

/**
 * Where a typed `/compact` line stays yours while it is held
 * (composer-drafts.ts hold, heldWent, heldBack: saved with the pane's draft).
 */
export interface HeldBox {
  hold(key: string, line: string): void;
  went(key: string, line: string): void;
  /**
   * Back in the box ("box"), or the box has newer text ("keep": the draft keeps the line until `keep` has moved it
   * to Kept drafts), or no longer held there ("gone").
   */
  back(key: string, line: string): "box" | "keep" | "gone";
  /**
   * The line `back` kept, to the pane's Kept drafts ("kept"), or into the box when they cannot take it ("box").
   * `outcome`, refused before any key went or not known, for main's reason.
   */
  keep(key: string, line: string, outcome: CompactOutcome): Promise<"kept" | "box" | "gone">;
}

interface Pick extends PickWait {
  readonly request: PickRequest;
  readonly agent: PickAgent;
  readonly command: string;
  readonly hostId: string;
  readonly paneId: string;
  readonly binding: SendBinding;
  state: "held" | "sending" | "sent";
  /** The order picks were made in (the newest one names the model and effort). */
  readonly seq: number;
  sentAt: number;
  /** Compact: the transcript's newest compaction when it went (a newer one confirms it). */
  baseline: number;
  /** Codex: its newest turn_context read when the line went (PaneSettings.modeAt; -1: none). */
  turnAt?: number;
  readonly onSent: (() => void) | null;
}

/**
 * The Codex model and effort line typed last into a pane, for the run it went to.
 * What Codex runs until a turn_context read after it says otherwise (whatever it says), or the run changes; the
 * chip's 10 s confirm wait has no say in it.
 */
interface CodexTyped {
  readonly model: string;
  readonly effort: string | null;
  readonly seq: number;
  readonly binding: SendBinding;
  /** The newest turn_context read when it went (PaneSettings.modeAt; -1: none): a newer one retires it. */
  readonly turnAt: number;
}

/** A Codex pick naming its model and effort (a model from the picker, or Codex's Effort). */
const codexNamed = (pick: Pick): boolean => pick.agent === "codex" && pick.request.modelPick !== undefined;

/** A pick's own wait (Claude's Compact uses it; the others start and keep it unused). */
interface PickWait {
  /** A `/compact` line you typed (its words are yours: they come back if it does not go). */
  readonly typed: boolean;
  /** Claude's Compact: the newest compaction-failed line when it went (a newer one ends it). */
  failBaseline: number;
  /** Claude's Compact: the last time it was seen working in a period that can still be its own. */
  activeAt: number;
  /** Claude's Compact: the working periods seen since it went, and whether one runs now. */
  periods: number;
  working: boolean;
  /** Claude's Compact: when the wait ends at the latest once its last allowed period ended. */
  endsAt: number | null;
}

export interface ChipView {
  readonly label: string;
  /** Held for the pane's next turn. */
  readonly next: boolean;
  /** The chip's own title when it says more than "<Model>: <label>" ("The agent's default model"). */
  readonly title?: string;
}

/** What the Permissions chip shows: the mode's word and icon ("Permissions" and a plain shield while none reads). */
export interface ModeChipView extends ChipView {
  readonly mode: string | null;
  readonly icon: ModeIcon | "unknown";
  readonly description: string | null;
  /** A pick stopped on this mode, which allows more than both its start and its target (amber). */
  readonly warning: boolean;
}

/** A Claude or Grok pane's mode as main read it off its screen, with the identity it was read under. */
interface ModeSeen {
  readonly scope: SettingsScope;
  readonly run: { readonly connection: number; readonly arrival: number } | null;
  readonly agent: "claude" | "grok";
  readonly mode: string | null;
}

/** A Codex pick's mode as its screen showed it, the identity, and the rollout's newest turn then (a newer one retires it). */
interface CodexModeSeen {
  readonly terminalID: string;
  readonly session: string | null;
  readonly run: SendBinding["run"];
  /** Null: the pick's result is not known (Permissions until a newer turn). */
  readonly mode: string | null;
  readonly baseline: number;
}

const atPrompt = (status: AgentStatus): boolean => status === "idle" || status === "done";

/** A new pick's wait fields (`typed`: a `/compact` line you typed). */
function waitFields(typed: boolean): PickWait {
  return { typed, failBaseline: -1, activeAt: 0, periods: 0, working: false, endsAt: null };
}

/** Claude's Compact (typed or the ring's): its wait is bounded by compactEnd. */
const claudeCompact = (pick: Pick): boolean => pick.request.kind === "compact" && pick.agent === "claude";

/**
 * The pane as a snapshot shows it, for Claude's sent Compact: a working
 * period (working, or a dialog in it) starts or goes on; one ends at the prompt. Once the last period that can be
 * its own ended, the wait ends compactGraceMs later at the latest, whatever Claude does next.
 */
function observeCompact(pick: Pick, status: AgentStatus, now: number): void {
  if (status === "working" || status === "blocked") {
    if (!pick.working) {
      pick.working = true;
      pick.periods += 1;
    }
    if (pick.endsAt === null) pick.activeAt = now;
    return;
  }
  if (!atPrompt(status) || !pick.working) return;
  pick.working = false;
  pick.activeAt = now;
  if (pick.periods >= compactTurns && pick.endsAt === null) pick.endsAt = now + compactGraceMs;
}

/**
 * When Claude's sent Compact stops waiting for the transcript: five
 * minutes at the prompt (`failed` false: nothing said), or the end of its periods (plus the grace), or
 * compactLimitMs from the send, whichever comes first (`failed`: the note says it did not finish).
 */
function compactEnd(pick: Pick): { readonly at: number; readonly failed: boolean } {
  const idle = pick.working ? Infinity : pick.activeAt + compactWaitMs;
  const bound = Math.min(pick.sentAt + compactLimitMs, pick.endsAt ?? Infinity);
  return bound <= idle ? { at: bound, failed: true } : { at: idle, failed: false };
}

/** The same pane, agent, session and run; a session named only now (none before) is the same. */
export function sameBinding(a: SendBinding, b: SendBinding): boolean {
  return (
    a.terminalID === b.terminalID &&
    a.isAgent === b.isAgent &&
    a.kind === b.kind &&
    (a.session === null || a.session === b.session) &&
    a.run?.connection === b.run?.connection &&
    a.run?.arrival === b.run?.arrival
  );
}

/** The values belong to the terminal and session shown (a session not named on one side is not compared). */
function inScope(settings: PaneSettings, binding: SendBinding): boolean {
  if (settings.scope.terminalID !== binding.terminalID) return false;
  return settings.scope.session === null || binding.session === null || settings.scope.session === binding.session;
}

/** A footer as main read it, with the terminal, session, connection and run it was read under. */
interface FooterSeen {
  readonly scope: SettingsScope;
  readonly run: { readonly connection: number; readonly arrival: number } | null;
  readonly footer: CursorFooter | null;
}

/** The footer was read for the pane shown with `binding`: its terminal, its session (when both name one), its connection and run (when both say). */
function footerFits(seen: { readonly scope: SettingsScope; readonly run: FooterSeen["run"] }, binding: SendBinding): boolean {
  if (seen.scope.terminalID !== binding.terminalID) return false;
  if (seen.scope.session !== null && binding.session !== null && seen.scope.session !== binding.session) return false;
  if (seen.run !== null && binding.run !== undefined && (seen.run.connection !== binding.run.connection || seen.run.arrival !== binding.run.arrival)) return false;
  return true;
}

/** Two reads under the same identity, by footerFits's rule (the terminal; the session and run when both say). */
function seenFits(a: { readonly scope: SettingsScope; readonly run: FooterSeen["run"] }, b: { readonly scope: SettingsScope; readonly run?: FooterSeen["run"] }): boolean {
  if (a.scope.terminalID !== b.scope.terminalID) return false;
  if (a.scope.session !== null && b.scope.session !== null && a.scope.session !== b.scope.session) return false;
  const run = b.run ?? null;
  return a.run === null || run === null || (a.run.connection === run.connection && a.run.arrival === run.arrival);
}

/** A pick's binding as a read's identity (its terminal, session and run). */
function seenOf(binding: SendBinding): { readonly scope: SettingsScope; readonly run: FooterSeen["run"] } {
  return { scope: { terminalID: binding.terminalID, session: binding.session }, run: binding.run ?? null };
}

/** Herdr's refusal as the chip's note: "Not set: …", without the box's "The text is kept." */
function refusalNote(message: string): string {
  const body = message
    .replace(/\s*The text is kept\.?$/, "")
    .replace(/^Not sent:\s*/, "")
    .replace(/^Not run:\s*/, "")
    .trim()
    .replace(/\.$/, "");
  return `Not set: ${body}.`;
}

export class AgentPicks {
  private readonly picks = new Map<string, Map<ChipKind, Pick>>();
  /** The next pick's place in the order picks were made in. */
  private nextSeq = 0;
  private readonly values = new Map<string, PaneSettings>();
  /** Each Cursor pane's footer as main last read it, with the terminal and session it was read under. */
  private readonly footers = new Map<string, FooterSeen>();
  /** Each Claude or Grok pane's mode as main last read it off its screen. */
  private readonly modes = new Map<string, ModeSeen>();
  /** Each Codex pane's mode as a pick's screen showed it, until a newer turn. */
  private readonly codexModes = new Map<string, CodexModeSeen>();
  /** Each pane's Codex model and effort line typed last (CodexTyped). */
  private readonly codexTyped = new Map<string, CodexTyped>();
  /** A pick stopped past a mode allowing more: the mode it stopped on, for the identity, until the next pick. */
  private readonly modeWarnings = new Map<string, { readonly binding: SendBinding; readonly mode: string | null }>();
  private readonly notes = new Map<string, string>();
  /**
   * Notes that stay until you dismiss them (a dropped `/compact` line, a Compact
   * that did not finish): kept while the pane's note is still that text.
   */
  private readonly keptNotes = new Map<string, string>();
  private readonly confirmed = new Map<string, Map<ChipKind, { readonly text: string; readonly turn: string | null }>>();
  /** The newest turn of each pane's transcript as last received (a confirmation's turn). */
  private readonly turns = new Map<string, string | null>();
  private readonly listeners = new Set<() => void>();
  private revision = 0;
  /**
   * Each new pane's New agent choice, shown by its chips until its transcript (or footer, or
   * files) says the model; pinned to the terminal and run first seen with it, dropped when either changes.
   */
  private readonly starts = new Map<string, { readonly shown: StartShown; terminalID: string | null; run: NonNullable<SendBinding["run"]> | null }>();

  constructor(private readonly deps: PickDeps) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Changes with every change (useSyncExternalStore's snapshot). */
  version = (): number => this.revision;

  private changed(): void {
    this.revision += 1;
    for (const listener of Array.from(this.listeners)) listener();
  }

  /** The transcript's values for the pane shown with `binding`, or the empty ones (a Cursor pane's: its footer's). */
  settings(key: string, binding: SendBinding): AgentSettings {
    if (binding.kind === "cursor") {
      const footer = this.cursorFooter(key, binding);
      return footer === null ? emptySettings : cursorFooterSettings(footer);
    }
    const value = this.values.get(key);
    // A Grok pick its screen confirmed stands over Grok's files for the pane run (read late, or
    // naming an id they cannot say: they never replace it).
    const kept = this.grokKeptPick(key, binding);
    if (kept !== null) {
      const files = value !== undefined && inScope(value, binding) ? value : undefined;
      const base: AgentSettings = files ?? emptySettings;
      const picked: AgentSettings = { ...base, model: kept.model, modelLabel: kept.label, effort: kept.effort ?? (base.model === kept.model ? base.effort : null) };
      const switched = this.liveGrokSwitch(key, binding, files);
      if (switched === undefined) return picked;
      return { ...picked, effort: switched.effort ?? picked.effort, window: switched.window === "500k" ? 500_000 : switched.window === "256k" ? 256_000 : (picked.window ?? null) };
    }
    if (value === undefined || !inScope(value, binding)) return emptySettings;
    // A Grok switch its screen showed, until its files say something else.
    const seen = binding.kind === "grok" ? this.liveGrokSwitch(key, binding, value) : undefined;
    if (seen === undefined) return value;
    return { ...value, effort: seen.effort ?? value.effort, window: seen.window === "500k" ? 500_000 : seen.window === "256k" ? 256_000 : (value.window ?? null) };
  }

  /**
   * The effort and window a Grok switch put on its screen, with the identity it was
   * made under (the terminal, session, connection and run, as the app's liveIdentity),
   * the files' values then and when. It retires for good (deleted, never brought back by a later return to
   * those values): once the files say anything newer (they acknowledge it, or another model, effort or
   * window), under another identity, when the pane goes, and at the usual settle deadline (confirmWaitMs).
   */
  private readonly grokSwitches = new Map<
    string,
    {
      readonly terminalID: string;
      readonly session: string | null;
      readonly run: SendBinding["run"];
      readonly effort: string | null;
      readonly window: string | null;
      readonly fileModel: string | null;
      readonly fileEffort: string | null;
      readonly fileWindow: number | null;
      readonly at: number;
    }
  >();

  /**
   * Each OpenCode pane's model as its footer named it at the end of a pick (OpenCode's chips read
   * nothing else), with the binding it was picked under; it goes when the pane's terminal, agent, session or run
   * changes, or another pick for it is set.
   */
  private readonly openCodeSeen = new Map<string, { readonly binding: SendBinding; readonly model: string; readonly label: string }>();

  /**
   * Each Cursor pane's model line as main read it under the
   * box after a model pick (`Composer 2.5 Fast`, `Auto`: no effort word, so no footer reads), with its family and the
   * binding it was picked under. It stands for the Model chip and the row tick, and the older footer stops counting
   * (its effort, context and mode unknown), until a footer that reads arrives or the pane's run changes.
   */
  // Also as the footer reads after a change in its terminal (whoever made it), with the identity it
  // was read under (scope and run, footerFits's rule).
  private readonly cursorLines = new Map<string, { readonly scope: SettingsScope; readonly run: FooterSeen["run"]; readonly line: string; readonly family: string }>();

  /** The Cursor model line read after the pane's last model pick, for the pane shown with `binding`, or null. */
  cursorModelLine(key: string, binding: SendBinding): { readonly line: string; readonly family: string } | null {
    const seen = this.cursorLines.get(key);
    return seen === undefined || !footerFits(seen, binding) ? null : { line: seen.line, family: seen.family };
  }

  /**
   * Each Grok pane's model pick once Grok's screen confirmed it (its footer, or a new "Switched to …"
   * line: main's grokAfterPick), for that pane run: the row picked (its id and label), the level the screen showed,
   * and the border's name for it ("Grok 4.7 Fast"; null: none read). It is what the Model chip, the Effort chip and the
   * row tick show, whatever Grok's files say later, until a later pick goes, a border naming another model is read,
   * or the run changes. `said`: the "Switched to …" line's name for it; a pick
   * confirmed by that line alone (no border then) records the first border that names it as its `shown`, and a first
   * border naming anything else retires it.
   */
  private readonly grokKept = new Map<
    string,
    { readonly scope: SettingsScope; readonly run: FooterSeen["run"]; readonly model: string; readonly label: string; effort: string | null; shown: string | null; readonly said: string | null }
  >();

  /** The Grok pick kept for the pane shown with `binding`, or null. */
  grokKeptPick(key: string, binding: SendBinding): { readonly model: string; readonly label: string; readonly effort: string | null; readonly shown: string | null } | null {
    const kept = this.grokKept.get(key);
    if (kept === undefined || binding.kind !== "grok" || !footerFits(kept, binding)) return null;
    return { model: kept.model, label: kept.label, effort: kept.effort, shown: kept.shown };
  }

  /**
   * Why the pane's last model pick (any of the five agents) was not sent or set, for its Model menu:
   * until the next model pick, or until the menu, opened with it on show, closes (`seen`).
   */
  private readonly modelLines = new Map<string, { readonly text: string; readonly binding: SendBinding; seen: boolean }>();

  /** The Model menu's not-sent line for the pane shown with `binding`, or null. */
  modelNotSent(key: string, binding: SendBinding): string | null {
    const line = this.modelLines.get(key);
    return line === undefined || line.binding.terminalID !== binding.terminalID ? null : line.text;
  }

  /** The pane's Model menu opened: the line it shows now goes when it closes. */
  modelMenuOpened(key: string): void {
    const line = this.modelLines.get(key);
    if (line !== undefined) line.seen = true;
  }

  /** The pane's Model menu closed: a line it showed when it opened goes (one set since stays for the next open). */
  modelMenuClosed(key: string): void {
    const line = this.modelLines.get(key);
    if (line === undefined || !line.seen) return;
    this.modelLines.delete(key);
    this.changed();
  }

  /** A row the menu showed that makes no pick here: the line says why, as a refused pick's does. */
  refuseModel(context: PickContext, text: string): void {
    const key = `${context.hostId}/${context.paneId}`;
    this.notes.set(key, text);
    this.modelLines.set(key, { text, binding: context.binding, seen: false });
    this.changed();
  }

  /** The note for a pick; for a Model pick also the Model menu's line. */
  private say(key: string, about: { readonly request: PickRequest; readonly binding: SendBinding }, text: string): void {
    this.notes.set(key, text);
    if (about.request.kind === "model") this.modelLines.set(key, { text, binding: about.binding, seen: false });
  }

  /** The OpenCode model the pane's footer named after its last pick, for the pane shown with `binding`, or null. */
  openCodeModel(key: string, binding: SendBinding): { readonly model: string; readonly label: string } | null {
    const seen = this.openCodeSeen.get(key);
    return seen === undefined || !sameBinding(seen.binding, binding) ? null : { model: seen.model, label: seen.label };
  }

  /** The pane's Grok switch while it still stands for `binding` and `files`; retired (deleted) otherwise. */
  private liveGrokSwitch(key: string, binding: SendBinding, files: AgentSettings | undefined) {
    const seen = this.grokSwitches.get(key);
    if (seen === undefined) return undefined;
    const sameIdentity =
      seen.terminalID === binding.terminalID &&
      seen.session === binding.session &&
      seen.run !== undefined &&
      binding.run !== undefined &&
      seen.run.connection === binding.run.connection &&
      seen.run.arrival === binding.run.arrival;
    const filesSame = files === undefined || this.grokFilesUnchanged(seen, files);
    if (sameIdentity && filesSame && this.deps.now() - seen.at < confirmWaitMs) return seen;
    this.grokSwitches.delete(key);
    return undefined;
  }

  private grokFilesUnchanged(seen: { readonly fileModel: string | null; readonly fileEffort: string | null; readonly fileWindow: number | null }, files: AgentSettings): boolean {
    return seen.fileModel === files.model && seen.fileEffort === files.effort && seen.fileWindow === (files.window ?? null);
  }

  /** The transcript's values for the pane shown with `binding`, or null when none were read for it. */
  known(key: string, binding: SendBinding): PaneSettings | null {
    const value = this.values.get(key);
    return value === undefined || !inScope(value, binding) ? null : value;
  }

  /** Your auto-compact settings beside the pane's transcript (only those keys), or null. */
  limits(key: string, binding: SendBinding): ContextLimits | null {
    const value = this.values.get(key);
    return value === undefined || !inScope(value, binding) ? null : (value.limits ?? null);
  }

  /**
   * The Cursor pane's footer for the pane shown with `binding`, or null (none read, none that
   * reads, another terminal or session, another connection or agent run).
   */
  cursorFooter(key: string, binding: SendBinding): CursorFooter | null {
    // A model line read after a pick is newer than the footer kept: that footer no longer says.
    if (this.cursorModelLine(key, binding) !== null) return null;
    const seen = this.footers.get(key);
    return seen === undefined || !footerFits(seen, binding) ? null : seen.footer;
  }

  /** A footer main read for a Cursor pane, with the connection and run it was read under. */
  receiveFooter(key: string, event: { readonly scope: SettingsScope; readonly run?: FooterSeen["run"]; readonly footer: CursorFooter | null; readonly modelLine?: string | null }): void {
    const seen: FooterSeen = { scope: event.scope, run: event.run ?? null, footer: event.footer };
    let changed = false;
    // A footer that reads, newer than the model line kept, replaces it: only one read under that line's own
    // identity, and before the footer is compared with the one held (the same footer read again after a pick back
    // still replaces the line).
    const kept = this.cursorLines.get(key);
    if (event.footer !== null && kept !== undefined && seenFits(kept, seen)) {
      this.cursorLines.delete(key);
      changed = true;
    }
    // A model line with no effort word ("Composer 2.5 Fast", "Auto") read under the box, whoever
    // changed it: kept as a pick's is (its family the Model chip's; effort and context unknown).
    const line = event.footer === null ? (event.modelLine ?? null) : null;
    if (line !== null && /\p{L}/u.test(line) && (kept === undefined || kept.line !== line || !seenFits(kept, seen))) {
      this.cursorLines.set(key, { scope: event.scope, run: event.run ?? null, line, family: cursorFamilyName(line) });
      changed = true;
    }
    const before = this.footers.get(key);
    if (before === undefined || JSON.stringify(before) !== JSON.stringify(seen)) {
      this.footers.set(key, seen);
      changed = true;
    }
    // A Cursor model sent as its `/model <id>` line is confirmed by the footer that names it.
    const pick = this.picks.get(key)?.get("model");
    if (pick !== undefined && pick.state === "sent" && event.footer !== null && footerFits(seen, pick.binding) && this.confirms(pick, cursorFooterSettings(event.footer))) {
      this.drop(key, pick);
      changed = true;
    }
    if (changed) this.changed();
  }

  /** Listens to main's footers and screen modes once for the page's life. */
  attach(bridge: { readonly onCursorFooter?: HerdrDesktopBridge["onCursorFooter"]; readonly onPaneMode?: HerdrDesktopBridge["onPaneMode"] }): () => void {
    const footers = bridge.onCursorFooter?.((event: CursorFooterEvent) => this.receiveFooter(`${event.hostId}/${event.paneId}`, event)) ?? (() => undefined);
    const modes = bridge.onPaneMode?.((event: PaneModeEvent) => this.receiveMode(`${event.hostId}/${event.paneId}`, event)) ?? (() => undefined);
    return () => {
      footers();
      modes();
    };
  }

  /** A mode main read off a Claude or Grok pane's screen (null: none that reads), with the identity it was read under. */
  receiveMode(key: string, event: { readonly scope: SettingsScope; readonly run?: ModeSeen["run"]; readonly agent: "claude" | "grok"; readonly mode: string | null; readonly borderModel?: string | null }): void {
    // A screen a mode reads on retires a pick's warning, one showing the same mode too. Main
    // sends a pick's own last screen before its answer, and the next read after it even when unchanged
    // (live-reads.ts notePick); the pick's own result is applied below without it (goMode).
    let retired = event.mode !== null && this.modeWarnings.delete(key);
    // Grok's border naming another model than the kept pick's (under its identity): the pick goes.
    // A pick confirmed by its "Switched to …" line alone has no border yet: the
    // first one read names it (recorded, the pick stays) or names another model (the pick goes).
    const kept = this.grokKept.get(key);
    const border = event.borderModel ?? null;
    if (event.agent === "grok" && border !== null && kept !== undefined && seenFits(kept, { scope: event.scope, run: event.run ?? null })) {
      if (kept.shown === null && grokBorderNamesKept(kept, border)) kept.shown = border;
      else if (border !== kept.shown) {
        this.grokKept.delete(key);
        retired = true;
      }
    }
    if (!this.applyMode(key, event) && retired) this.changed();
  }

  /** The pane's mode as seen (a pick's own result too; its warning stays); true when it changed. */
  private applyMode(key: string, event: { readonly scope: SettingsScope; readonly run?: ModeSeen["run"]; readonly agent: "claude" | "grok"; readonly mode: string | null }): boolean {
    const seen: ModeSeen = { scope: event.scope, run: event.run ?? null, agent: event.agent, mode: event.mode };
    const before = this.modes.get(key);
    if (before !== undefined && JSON.stringify(before) === JSON.stringify(seen)) return false;
    this.modes.set(key, seen);
    this.changed();
    return true;
  }

  /**
   * The pane's approval mode as its agent shows it, for the pane shown with `binding` (null: none
   * reads): Claude's and Grok's screens, Cursor's footer, Codex's pick (until a newer turn) or rollout.
   */
  mode(key: string, binding: SendBinding): string | null {
    if (binding.kind === "cursor") {
      const footer = this.cursorFooter(key, binding);
      return footer === null ? null : cursorFooterMode(footer);
    }
    if (binding.kind === "claude" || binding.kind === "grok") {
      const seen = this.modes.get(key);
      return seen !== undefined && seen.agent === binding.kind && footerFits(seen, binding) ? seen.mode : null;
    }
    if (binding.kind !== "codex") return null;
    const value = this.values.get(key);
    const picked = this.liveCodexMode(key, binding, value);
    if (picked !== undefined) return picked.mode;
    return value === undefined || !inScope(value, binding) ? null : (value.mode ?? null);
  }

  /** The pane's Codex pick while it stands for `binding` and no newer turn was read; retired (deleted) otherwise. */
  private liveCodexMode(key: string, binding: SendBinding, value: PaneSettings | undefined): CodexModeSeen | undefined {
    const seen = this.codexModes.get(key);
    if (seen === undefined) return undefined;
    const sameIdentity =
      seen.terminalID === binding.terminalID &&
      seen.session === binding.session &&
      seen.run?.connection === binding.run?.connection &&
      seen.run?.arrival === binding.run?.arrival;
    if (sameIdentity && (value?.modeAt ?? -1) <= seen.baseline) return seen;
    this.codexModes.delete(key);
    return undefined;
  }

  /** What the Permissions chip shows for the pane shown with `binding`. */
  modeChip(key: string, binding: SendBinding, agent: ModeAgent): ModeChipView {
    const pick = this.picks.get(key)?.get("mode");
    const id = pick !== undefined && sameBinding(pick.binding, binding) ? pick.request.value : this.mode(key, binding);
    const shown = approvalMode(agent, id);
    const next = pick !== undefined && sameBinding(pick.binding, binding) && pick.state === "held";
    // Amber while the screen still shows the mode the pick stopped on.
    const warned = this.modeWarnings.get(key);
    const warning = pick === undefined && warned !== undefined && sameBinding(warned.binding, binding) && warned.mode === (shown?.id ?? null);
    return { label: shown?.label ?? unknownModeLabel, next, mode: shown?.id ?? null, icon: shown?.icon ?? "unknown", description: shown?.description ?? null, warning };
  }

  /** A chat update's values (null: it carried none; what was read stays) and the turn it ends with. */
  receive(key: string, settings: PaneSettings | null, turn: string | null): void {
    if (settings === null) return;
    this.turns.set(key, turn);
    let changed0 = false;
    const before = this.values.get(key);
    this.values.set(key, settings);
    // A newer turn (or another terminal or session) retires a Codex pick's mode.
    const picked = this.codexModes.get(key);
    if (picked !== undefined && ((settings.modeAt ?? -1) > picked.baseline || settings.scope.terminalID !== picked.terminalID || settings.scope.session !== picked.session)) {
      this.codexModes.delete(key);
      changed0 = true;
    }
    // Newer metadata (another value, or another terminal or session) retires a Grok switch for good.
    const seen = this.grokSwitches.get(key);
    if (seen !== undefined && (!this.grokFilesUnchanged(seen, settings) || settings.scope.terminalID !== seen.terminalID || settings.scope.session !== seen.session)) {
      this.grokSwitches.delete(key);
    }
    let changed = changed0 || before === undefined || JSON.stringify(before) !== JSON.stringify(settings);
    // A turn_context read after Codex's line went is the truth again, whatever it
    // says: the line typed is no longer what Codex runs (another terminal or session: it goes too).
    const turnAt = settings.modeAt ?? -1;
    const typed = this.codexTyped.get(key);
    if (typed !== undefined && (!inScope(settings, typed.binding) || turnAt > typed.turnAt)) {
      this.codexTyped.delete(key);
      changed = true;
    }
    const picks = this.picks.get(key);
    for (const [kind, pick] of Array.from(picks?.entries() ?? [])) {
      if (pick.state !== "sent" || !inScope(settings, pick.binding)) continue;
      if (!this.confirms(pick, settings)) {
        // Codex's choice sent before a newer turn_context that says otherwise retires (no line), never shown again.
        if (codexNamed(pick) && turnAt > (pick.turnAt ?? -1)) {
          picks!.delete(kind);
          changed = true;
        }
        continue;
      }
      picks!.delete(kind);
      const said =
        kind === "model" ? `Model: ${settings.modelLabel ?? pick.request.label}` : kind === "effort" ? `Effort: ${effortLabel(settings.effort)}` : "Compacted";
      const lines = this.confirmed.get(key) ?? new Map();
      lines.set(kind, { text: said, turn });
      this.confirmed.set(key, lines);
      changed = true;
    }
    // Claude's word that its compaction failed ends the wait.
    const compact = picks?.get("compact");
    if (compact !== undefined && compact.state === "sent" && inScope(settings, compact.binding) && this.compactFailed(compact, settings)) {
      this.endCompact(key, compact);
      changed = true;
    }
    if (changed) this.changed();
  }

  /** Claude's transcript says a compaction failed since its Compact went. */
  private compactFailed(pick: Pick, settings: AgentSettings): boolean {
    return pick.agent === "claude" && pick.request.kind === "compact" && (settings.compactFailedAt ?? -1) > pick.failBaseline;
  }

  /** Claude's Compact ended without a compaction: the ring is free, the note says so. */
  private endCompact(key: string, pick: Pick): void {
    this.drop(key, pick);
    this.keepNote(key, compactFailedText);
  }

  /** A note that stays until you dismiss it. */
  private keepNote(key: string, text: string): void {
    this.notes.set(key, text);
    this.keptNotes.set(key, text);
  }

  /**
   * A typed `/compact` line that did not go comes back: into the box
   * while it is empty; `note` says why.
   * With newer text in the box, your newer text stays
   * and the line goes to the pane's Kept drafts, durable until you put it in the box or discard it there (never in
   * a note only, which another pick or a reload would take away); the note, kept until dismissed, says where it is.
   * Kept drafts with no room: back in the box before your newer text. Never sent again by itself.
   */
  private giveBack(key: string, pick: Pick, note: string | null, outcome: CompactOutcome): void {
    const box = this.deps.box;
    const back = pick.typed && box !== undefined ? box.back(key, pick.command) : "gone";
    if (back !== "keep") {
      if (note !== null) this.notes.set(key, note);
      return;
    }
    // Main keeps one that may have gone with a reason saying so.
    void box!.keep(key, pick.command, outcome).then((where) => {
      if (where === "kept") this.keepNote(key, compactKeptText(note, outcome));
      else if (where === "box") this.keepNote(key, compactBoxText(note, outcome));
      else if (note !== null) this.notes.set(key, note);
      this.changed();
    });
  }

  /** The transcript read last already confirms a pick that just went: its line, once. */
  private confirmNow(key: string, pick: Pick): boolean {
    const settings = this.values.get(key);
    if (settings === undefined || this.picks.get(key)?.get(pick.request.kind) !== pick || !inScope(settings, pick.binding)) return false;
    // Or already says its compaction failed (receive ends it then).
    if (!this.confirms(pick, settings) && !this.compactFailed(pick, settings)) return false;
    this.receive(key, settings, this.turns.get(key) ?? null);
    return true;
  }

  private confirms(pick: Pick, settings: AgentSettings): boolean {
    if (pick.request.kind === "compact") return (settings.compactedAt ?? -1) > pick.baseline;
    // Codex's Effort names its model too: both, as its turn says them.
    if (pick.request.kind === "effort") return settings.effort === pick.request.value && (pick.request.modelPick === undefined || settings.model === pick.request.modelPick.model);
    // A model from the picker: the id or label it expects.
    const expect = pick.request.expect;
    if (expect !== undefined) {
      if (settings.model !== null && expect.ids.includes(settings.model)) return true;
      const label = settings.modelLabel;
      if (label === null) return false;
      return expect.labels.some((one) => one.toLowerCase() === label.toLowerCase());
    }
    if (pick.agent === "claude") return modelFamily(settings.modelLabel ?? settings.model) === pick.request.value;
    return false;
  }

  /** Chat's quiet lines for the pane: the picks the transcript confirmed in the turn it ends with. */
  confirmations(key: string, turn: string | null): string[] {
    const lines = this.confirmed.get(key);
    if (lines === undefined) return [];
    return (["model", "effort", "compact"] as const).flatMap((kind) => {
      const line = lines.get(kind);
      return line !== undefined && line.turn === turn ? [line.text] : [];
    });
  }

  /** Why the last pick did not go, or null. */
  note(key: string): string | null {
    return this.notes.get(key) ?? null;
  }

  /** The pane's note stays until you dismiss it (a dropped `/compact` line, a Compact that did not finish). */
  noteKept(key: string): boolean {
    const kept = this.keptNotes.get(key);
    return kept !== undefined && kept === this.notes.get(key);
  }

  dismissNote(key: string): void {
    this.keptNotes.delete(key);
    if (this.notes.delete(key)) this.changed();
  }

  /** A pick from a chip's menu. `onSent` runs once it went (Codex's picker: the tile shows its Terminal). */
  pick(context: PickContext, request: PickRequest, onSent: (() => void) | null = null): void {
    const key = `${context.hostId}/${context.paneId}`;
    if (request.kind === "mode") return this.pickMode(key, context, request);
    // A new model pick: the Model menu's line of the last one goes (this one's own may follow).
    if (request.kind === "model" && this.modelLines.delete(key)) this.changed();
    const about = { request, binding: context.binding };
    // A model pick goes to main as itself (IPC.modelPick), which makes its line.
    const typedModel = isModelPickRequest(request);
    // Every other Cursor pick drives its own menu; a family from the picker is a model pick
    // main types (`/model <family name>`).
    if (context.agent === "cursor" && !(request.kind === "model" && typedModel)) return this.pickCursor(key, context, request, onSent);
    // Grok's model from the picker is a model pick main types (`/model <id>`); its other picks go through pickGrok.
    if (context.agent === "grok" && !(request.kind === "model" && typedModel)) return this.pickGrok(key, context, request, onSent);
    if (context.agent === "opencode") return this.pickOpenCode(key, context, request);
    // One model pick at a time per Grok or Cursor pane (not for Claude Code or Codex).
    const going = this.picks.get(key)?.get("model");
    if (typedLivePick(context.agent, request) && going !== undefined && going.state === "sending" && going.command !== request.command) {
      this.say(key, about, pickOnItsWayText);
      this.changed();
      return;
    }
    const typed = request.kind === "compact" && request.command !== undefined ? request.command.trim() : null;
    // A model, and Codex's Effort (it names the model), only as a model pick main checks; nothing else builds one.
    const namesModel = request.kind === "model" || (context.agent === "codex" && request.kind === "effort");
    const command =
      typed !== null
        ? isCompactLine(typed)
          ? typed
          : null
        : typedModel
          ? request.command!
          : namesModel
            ? null
            : context.agent === "cursor" || context.agent === "grok"
              ? null
              : pickCommand(context.agent, request.kind, request.value, this.settings(key, context.binding));
    this.notes.delete(key);
    if (command === null) {
      this.say(
        key,
        about,
        context.agent === "codex" && request.kind === "effort"
          ? "Not set: Codex's model is not known yet. Pick one on the Model chip."
          : "Not set: that is not one of the menu's choices.",
      );
      this.changed();
      return;
    }
    const picks = this.picks.get(key) ?? new Map<ChipKind, Pick>();
    this.picks.set(key, picks);
    const current = picks.get(request.kind);
    // The same pick on its way already: once (a model pick's menu says so).
    if (current !== undefined && current.state === "sending" && current.command === command) {
      if (request.kind === "model") {
        this.say(key, about, pickStillGoingText);
        this.changed();
      }
      return;
    }
    // Codex's model and effort are one choice: the same line on its way from the other chip, once.
    const otherKind: ChipKind = request.kind === "model" ? "effort" : "model";
    const other = typedModel && context.agent === "codex" ? picks.get(otherKind) : undefined;
    if (other !== undefined && other.state === "sending" && other.command === command) return;
    const pick: Pick = {
      request,
      agent: context.agent,
      command,
      hostId: context.hostId,
      paneId: context.paneId,
      binding: context.binding,
      state: "held",
      seq: this.nextSeq++,
      sentAt: 0,
      baseline: -1,
      onSent,
      ...waitFields(typed !== null),
    };
    // A typed `/compact` held is yours: another Compact taking its place gives it back.
    if (current !== undefined && current.state === "held" && current.typed) this.giveBack(key, current, null, "refused");
    // Codex's model and effort are one choice: this pick names both (the effective model and
    // effort), so the other one goes no more (one command, never the earlier model). Held,
    // on its way or sent, it retires for good (one on its way still types; the line typed last is kept apart).
    if (other !== undefined && other.request.modelPick !== undefined) picks.delete(otherKind);
    picks.set(request.kind, pick);
    if (atPrompt(context.status)) this.go(key, pick);
    this.changed();
  }

  /**
   * A `/compact` you typed in Chat's box while Claude works (the box's Send): held
   * as the ring's Compact is, and sent when the turn ends, with its words; the note says so. True when it is held
   * (the box then lets the text go); false when it is not one to hold (not Claude, not working, not `/compact`):
   * the box sends it as any message.
   */
  //
  // The line stays yours while it is held (the box's draft keeps it,
  // saved: deps.box) until it goes or comes back. A second one while one you typed is held (or on its way) never
  // takes its place: it stays in the box with compactAlreadyText (true: the box sends nothing).
  holdTypedCompact(context: PickContext, text: string): boolean {
    if (context.agent !== "claude" || context.status !== "working" || !isCompactLine(text)) return false;
    const key = `${context.hostId}/${context.paneId}`;
    const line = text.trim();
    const current = this.picks.get(key)?.get("compact");
    if (current !== undefined && current.typed && (current.state === "held" || current.state === "sending")) {
      this.notes.set(key, compactAlreadyText);
      this.changed();
      return true;
    }
    this.pick(context, { kind: "compact", value: "compact", label: "Compact", command: line });
    if (this.picks.get(key)?.get("compact")?.state !== "held") return false;
    this.deps.box?.hold(key, line);
    this.notes.set(key, compactQueuedText);
    this.changed();
    return true;
  }

  /**
   * A Cursor pane's pick, by the same rules as the
   * others' (it goes only while the pane is at its prompt, else it is held
   * for the next turn, the newest per chip; one on its way is not sent
   * twice), but as a walk through Cursor's own menu in main (cursorPick),
   * which reads its screen after every key. It settles on the footer main
   * read at the end; anything else is a note, and the chip shows the footer.
   */
  private pickCursor(key: string, context: PickContext, request: PickRequest, onSent: (() => void) | null): void {
    this.notes.delete(key);
    const about = { request, binding: context.binding };
    if (cursorPickOf(request) === null || this.cursorFooter(key, context.binding) === null || this.deps.cursorPick === undefined) {
      // Cursor's own list asked for while no footer reads (a kept model line, a menu on its screen).
      const why =
        request.kind === "model" && cursorPickOf(request) !== null && this.deps.cursorPick !== undefined
          ? "Not set: Cursor's footer does not read now, so its own list was not opened. Use Show the Terminal and type /model there."
          : "Not set: that is not one of the menu's choices.";
      this.say(key, about, why);
      this.changed();
      return;
    }
    const picks = this.picks.get(key) ?? new Map<ChipKind, Pick>();
    this.picks.set(key, picks);
    const current = picks.get(request.kind);
    if (current !== undefined && current.state === "sending" && current.command === request.value) {
      if (request.kind === "model") {
        this.say(key, about, pickStillGoingText);
        this.changed();
      }
      return;
    }
    const pick: Pick = { request, agent: "cursor", command: request.value, hostId: context.hostId, paneId: context.paneId, binding: context.binding, state: "held", seq: this.nextSeq++, sentAt: 0, baseline: -1, onSent, ...waitFields(false) };
    picks.set(request.kind, pick);
    if (atPrompt(context.status)) this.go(key, pick);
    this.changed();
  }

  /**
   * An OpenCode model from the picker: its id goes to main (openCodePick), which drives OpenCode's
   * own list. Only while OpenCode is idle (refused otherwise, never held); one at a time per pane. It settles on what
   * the footer named at its end; anything else is the note.
   */
  private pickOpenCode(key: string, context: PickContext, request: PickRequest): void {
    this.notes.delete(key);
    const about = { request, binding: context.binding };
    const model = request.kind === "model" ? request.openCodeModel : undefined;
    if (model === undefined || !isModelId("opencode", model)) {
      this.say(key, about, "Not set: that is not one of the menu's choices.");
      this.changed();
      return;
    }
    if (this.deps.openCodePick === undefined) {
      this.say(key, about, "Not set: this window cannot drive OpenCode's list.");
      this.changed();
      return;
    }
    const picks = this.picks.get(key) ?? new Map<ChipKind, Pick>();
    this.picks.set(key, picks);
    const current = picks.get("model");
    if (current !== undefined && current.state === "sending") {
      // The same pick again while it is on its way (main may still be reading the list) says so too.
      this.say(key, about, current.command !== model ? pickOnItsWayText : pickStillGoingText);
      this.changed();
      return;
    }
    if (!atPrompt(context.status)) {
      this.say(key, about, openCodeIdleText);
      this.changed();
      return;
    }
    const pick: Pick = { request, agent: "opencode", command: model, hostId: context.hostId, paneId: context.paneId, binding: context.binding, state: "held", seq: this.nextSeq++, sentAt: 0, baseline: -1, onSent: null, ...waitFields(false) };
    picks.set("model", pick);
    this.goOpenCode(key, pick);
    this.changed();
  }

  /** An OpenCode pick's sequence in main, and what it came to. */
  private goOpenCode(key: string, pick: Pick): void {
    pick.state = "sending";
    this.deps.openCodePick!(pick.hostId, pick.paneId, pick.command, { ...pick.binding, atPromptOnly: true }).then(
      (result) => {
        if (this.picks.get(key)?.get("model") === pick) this.drop(key, pick);
        if (result.type === "set") this.openCodeSeen.set(key, { binding: pick.binding, model: result.model, label: result.label });
        else this.say(key, pick, result.note.startsWith("Not set:") ? result.note : refusalNote(result.note));
        this.changed();
      },
      (failure: unknown) => {
        if (this.picks.get(key)?.get("model") === pick) this.drop(key, pick);
        const message = failure instanceof Error ? failure.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : "Not sent";
        this.say(key, pick, refusalNote(message));
        this.changed();
      },
    );
  }

  /** A Grok chip's pick: its one command, typed in main once Grok is at its prompt. */
  private pickGrok(key: string, context: PickContext, request: PickRequest, onSent: (() => void) | null): void {
    this.notes.delete(key);
    const about = { request, binding: context.binding };
    if (grokPickOf(request.value) === null || this.deps.grokPick === undefined) {
      this.say(key, about, "Not set: that is not one of the menu's choices.");
      this.changed();
      return;
    }
    const picks = this.picks.get(key) ?? new Map<ChipKind, Pick>();
    this.picks.set(key, picks);
    const current = picks.get(request.kind);
    if (current !== undefined && current.state === "sending" && current.command === request.value) {
      if (request.kind === "model") {
        this.say(key, about, pickStillGoingText);
        this.changed();
      }
      return;
    }
    const pick: Pick = { request, agent: "grok", command: request.value, hostId: context.hostId, paneId: context.paneId, binding: context.binding, state: "held", seq: this.nextSeq++, sentAt: 0, baseline: -1, onSent, ...waitFields(false) };
    picks.set(request.kind, pick);
    if (atPrompt(context.status)) this.go(key, pick);
    this.changed();
  }

  /**
   * A Permissions pick: one of the agent's own modes, not the one shown; it goes to main
   * (modePick) only at the prompt, else it is held for the next turn (the newest wins).
   */
  private pickMode(key: string, context: PickContext, request: PickRequest): void {
    this.notes.delete(key);
    // OpenCode's pane has no Permissions chip.
    const agent = context.agent;
    if (agent === "opencode") return;
    // A new pick takes the warning away (its own result says what is on).
    this.modeWarnings.delete(key);
    if (!isOfferedMode(agent, request.value)) {
      this.notes.set(key, "Not set: that is not one of the menu's choices.");
      this.changed();
      return;
    }
    // A mode the menu does not offer is on (Claude's bypass): read-only, nothing goes.
    const shownMode = approvalMode(agent, this.mode(key, context.binding));
    if (shownMode !== null && !shownMode.offered) {
      this.notes.set(key, bypassStartNote);
      this.changed();
      return;
    }
    if (this.deps.modePick === undefined) {
      this.notes.set(key, "Not set: this window cannot switch the agent's mode.");
      this.changed();
      return;
    }
    const picks = this.picks.get(key) ?? new Map<ChipKind, Pick>();
    this.picks.set(key, picks);
    const current = picks.get("mode");
    if (current !== undefined && current.state === "sending") {
      if (current.command !== request.value) this.notes.set(key, "Not set: the last switch is still on its way.");
      this.changed();
      return;
    }
    if (current === undefined && this.mode(key, context.binding) === request.value) return;
    if (current !== undefined && this.mode(key, context.binding) === request.value) {
      // Back to the mode it shows: the held one goes.
      picks.delete("mode");
      this.changed();
      return;
    }
    const pick: Pick = { request, agent: agent, command: request.value, hostId: context.hostId, paneId: context.paneId, binding: context.binding, state: "held", seq: this.nextSeq++, sentAt: 0, baseline: -1, onSent: null, ...waitFields(false) };
    picks.set("mode", pick);
    if (atPrompt(context.status)) this.go(key, pick);
    this.changed();
  }

  /** A Permissions pick in main, and the mode its screen showed at its end. */
  private goMode(key: string, pick: Pick): void {
    const agent = pick.agent;
    if (agent === "opencode") return;
    pick.state = "sending";
    const scope = { terminalID: pick.binding.terminalID, session: pick.binding.session };
    const run = pick.binding.run ?? null;
    const baseline = this.values.get(key)?.modeAt ?? -1;
    this.deps.modePick!(pick.hostId, pick.paneId, agent, pick.request.value, { ...pick.binding, atPromptOnly: true }).then(
      (result) => {
        if (this.picks.get(key)?.get("mode") !== pick) return;
        if (result.type === "busy") {
          pick.state = "held";
          this.changed();
          return;
        }
        this.drop(key, pick);
        if (result.type === "refused" && result.warning === true) this.modeWarnings.set(key, { binding: pick.binding, mode: result.mode });
        if (agent === "cursor") {
          if (result.footer !== undefined && result.footer !== null) this.receiveFooter(key, { scope, run, footer: result.footer });
        } else if (agent === "claude" || agent === "grok") {
          // The screen's word (main noted each screen it read; a pick refused before reading leaves the chip as it was).
          // An unknown result clears it (never the word from before the pick).
          // Applied, not observed: the warning set above shows first.
          if (result.type === "refused" && result.unknown === true) this.applyMode(key, { scope, run, agent, mode: null });
          else if (result.mode !== null) this.applyMode(key, { scope, run, agent, mode: result.mode });
        } else if (result.mode !== null || (result.type === "refused" && result.unknown === true)) {
          // Codex: its screen's word (or unknown), until a turn newer than the one read now.
          this.codexModes.set(key, { terminalID: pick.binding.terminalID, session: pick.binding.session, run: pick.binding.run, mode: result.mode, baseline });
        }
        // "Not confirmed yet:" and "Stopped …" are their own notes (the mode may have changed).
        if (result.type === "refused") this.notes.set(key, /^(?:Not set:|Not confirmed yet:|Stopped )/.test(result.note) ? result.note : refusalNote(result.note));
        this.changed();
      },
      (failure: unknown) => {
        if (this.picks.get(key)?.get("mode") === pick) this.drop(key, pick);
        const message = failure instanceof Error ? failure.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : "Not sent";
        this.notes.set(key, refusalNote(message));
        this.changed();
      },
    );
  }

  /** A Grok pick's command in main, and what it came to. */
  private goGrok(key: string, pick: Pick): void {
    pick.state = "sending";
    const files = this.values.get(key);
    const shown = this.settings(key, pick.binding);
    const request = grokPickOf(pick.request.value)!;
    const sent: GrokFiles = { model: shown.model, effort: shown.effort, window: grokWindowWord(shown.window) };
    this.deps.grokPick!(pick.hostId, pick.paneId, request, sent, { ...pick.binding, atPromptOnly: true }).then(
      (result) => {
        if (this.picks.get(key)?.get(pick.request.kind) !== pick) return;
        if (result.type === "busy") {
          pick.state = "held";
          this.changed();
          return;
        }
        this.drop(key, pick);
        // The kept pick's level follows a level the screen showed set.
        const kept = this.grokKept.get(key);
        if (result.type === "set" && result.effort !== null && kept !== undefined && footerFits(kept, pick.binding)) kept.effort = result.effort;
        if (result.type === "set") {
          this.grokSwitches.set(key, {
            terminalID: pick.binding.terminalID,
            session: pick.binding.session,
            run: pick.binding.run,
            effort: result.effort,
            window: result.window,
            fileModel: files?.model ?? null,
            fileEffort: files?.effort ?? null,
            fileWindow: files?.window ?? null,
            at: this.deps.now(),
          });
        }
        if (result.type === "opened") pick.onSent?.();
        if (result.type === "refused") this.say(key, pick, result.note.startsWith("Not set:") ? result.note : refusalNote(result.note));
        this.changed();
      },
      (failure: unknown) => {
        if (this.picks.get(key)?.get(pick.request.kind) === pick) this.drop(key, pick);
        const message = failure instanceof Error ? failure.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : "Not sent";
        this.say(key, pick, refusalNote(message));
        this.changed();
      },
    );
  }

  /** A Cursor pick's walk in main, and what it came to. */
  private goCursor(key: string, pick: Pick): void {
    pick.state = "sending";
    const request = cursorPickOf(pick.request)!;
    const scope = { terminalID: pick.binding.terminalID, session: pick.binding.session };
    const run = pick.binding.run ?? null;
    this.deps.cursorPick!(pick.hostId, pick.paneId, request, { ...pick.binding, atPromptOnly: true }).then(
      (result) => {
        if (this.picks.get(key)?.get(pick.request.kind) !== pick) return;
        if (result.type === "busy") {
          pick.state = "held";
          this.changed();
          return;
        }
        this.drop(key, pick);
        if (result.type === "set") this.receiveFooter(key, { scope, run, footer: result.footer });
        if (result.type === "opened") pick.onSent?.();
        if (result.type === "refused") {
          if (result.footer !== null) this.receiveFooter(key, { scope, run, footer: result.footer });
          this.say(key, pick, result.note.startsWith("Not set:") ? result.note : refusalNote(result.note));
        }
        this.changed();
      },
      (failure: unknown) => {
        if (this.picks.get(key)?.get(pick.request.kind) === pick) this.drop(key, pick);
        const message = failure instanceof Error ? failure.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : "Not sent";
        this.say(key, pick, refusalNote(message));
        this.changed();
      },
    );
  }

  /**
   * The pane as the row shows it now (null: gone or closed): a held pick goes
   * once it is at its prompt, or is dropped when it changed; a sent one
   * stops showing once its wait is over.
   */
  sync(key: string, context: PickContext | null): void {
    // A footer read under another identity (or for a pane gone) goes for good.
    const footer = this.footers.get(key);
    if (footer !== undefined && (context === null || !footerFits(footer, context.binding))) {
      this.footers.delete(key);
      this.changed();
    }
    // A screen mode read under another identity (or for a pane gone) goes; a Codex pick's mode retires.
    const mode = this.modes.get(key);
    if (mode !== undefined && (context === null || !footerFits(mode, context.binding))) {
      this.modes.delete(key);
      this.changed();
    }
    if (this.codexModes.has(key) && (context === null || this.liveCodexMode(key, context.binding, this.values.get(key)) === undefined)) {
      this.codexModes.delete(key);
      this.changed();
    }
    // The pane gone, or another run in it: the Codex line typed last goes with it.
    const typed = this.codexTyped.get(key);
    if (typed !== undefined && (context === null || !sameBinding(typed.binding, context.binding))) {
      this.codexTyped.delete(key);
      this.changed();
    }
    // The pane gone, or another run in it: Cursor's model line kept goes too.
    const cursorLine = this.cursorLines.get(key);
    if (cursorLine !== undefined && (context === null || !footerFits(cursorLine, context.binding))) {
      this.cursorLines.delete(key);
      this.changed();
    }
    // The pane gone, or a new run in it: the Grok pick kept for the last one goes.
    const grokKept = this.grokKept.get(key);
    if (grokKept !== undefined && (context === null || !footerFits(grokKept, context.binding))) {
      this.grokKept.delete(key);
      this.changed();
    }
    // The pane gone: its Model menu's line too.
    if (context === null && this.modelLines.delete(key)) this.changed();
    // The pane gone, or another run in it: the OpenCode model its footer named goes with it.
    const openCode = this.openCodeSeen.get(key);
    if (openCode !== undefined && (context === null || !sameBinding(openCode.binding, context.binding))) {
      this.openCodeSeen.delete(key);
      this.changed();
    }
    // The pane gone (or its connection), or another identity in it: its Grok switch retires.
    if (this.grokSwitches.has(key) && (context === null || this.liveGrokSwitch(key, context.binding, this.values.get(key)) === undefined)) {
      this.grokSwitches.delete(key);
      this.changed();
    }
    const picks = this.picks.get(key);
    if (picks === undefined) return;
    let changed = false;
    for (const [kind, pick] of Array.from(picks.entries())) {
      if (pick.state === "held") {
        if (context === null || !sameBinding(pick.binding, context.binding)) {
          picks.delete(kind);
          // A typed line comes back (box or note).
          this.giveBack(key, pick, "Not set: the pane changed before its turn ended.", "refused");
          changed = true;
        } else if (atPrompt(context.status)) {
          this.go(key, pick);
          changed = true;
        }
      } else if (pick.state === "sent" && claudeCompact(pick)) {
        // Claude may have queued it behind a long turn (or be compacting): the ring
        // spins while it works, only through the periods that can be
        // its own (compactTurns), and never past compactLimitMs from the send.
        const now = this.deps.now();
        if (context !== null && sameBinding(pick.binding, context.binding)) observeCompact(pick, context.status, now);
        else pick.working = false;
        const end = compactEnd(pick);
        if (now >= end.at) {
          if (end.failed) this.endCompact(key, pick);
          else picks.delete(kind);
          changed = true;
        }
      } else if (pick.state === "sent" && this.deps.now() - pick.sentAt >= waitOf(kind)) {
        picks.delete(kind);
        changed = true;
      }
    }
    if (changed) this.changed();
  }

  /** When the pane's oldest sent pick stops showing (ms since 1970), or null. */
  nextExpiry(key: string): number | null {
    const times = Array.from(this.picks.get(key)?.values() ?? [])
      .filter((pick) => pick.state === "sent")
      .map((pick) => (claudeCompact(pick) ? compactEnd(pick).at : pick.sentAt + waitOf(pick.request.kind)))
      .filter((at) => Number.isFinite(at));
    // A Grok switch's settle deadline (the chips look again then).
    const seen = this.grokSwitches.get(key);
    if (seen !== undefined) times.push(seen.at + confirmWaitMs);
    return times.length === 0 ? null : Math.min(...times);
  }

  private go(key: string, pick: Pick): void {
    if (pick.request.kind === "mode") return this.goMode(key, pick);
    if (pick.agent === "cursor" && !isModelPickRequest(pick.request)) return this.goCursor(key, pick);
    if (pick.agent === "grok" && !isModelPickRequest(pick.request)) return this.goGrok(key, pick);
    if (pick.agent === "opencode") return this.goOpenCode(key, pick);
    pick.state = "sending";
    pick.baseline = this.values.get(key)?.compactedAt ?? -1;
    pick.failBaseline = this.values.get(key)?.compactFailedAt ?? -1;
    // It goes only if the agent is still at its prompt when its turn in the pane's queue comes.
    // Claude's Compact also while it works again by then (it queues it), never into a dialog.
    const queues = pick.request.kind === "compact" && pick.agent === "claude";
    const binding: SendBinding = { ...pick.binding, atPromptOnly: true, ...(queues ? { queuesWhileWorking: true } : {}) };
    // A model pick goes as itself; main checks it against the machine's list (again for one
    // held for this turn) and makes its line.
    const named = isModelPickRequest(pick.request) ? pick.request.modelPick! : null;
    const going =
      named === null
        ? this.deps.send(pick.hostId, pick.paneId, pick.command, binding)
        : this.deps.modelPick === undefined
          ? Promise.reject(new Error("Not sent: this window cannot send a model pick."))
          : this.deps.modelPick(pick.hostId, pick.paneId, named, binding);
    going.then(
      (outcome: ModelPickOutcome | void) => {
        pick.state = "sent";
        pick.sentAt = this.deps.now();
        pick.activeAt = pick.sentAt;
        // Cursor's model line read after its Return: its footer for the chips; another family than the
        // one asked for is said in the line, and nothing is retried.
        if (outcome !== undefined && outcome.type === "cursor" && pick.agent === "cursor") {
          if (outcome.footer !== null) this.receiveFooter(key, { scope: { terminalID: pick.binding.terminalID, session: pick.binding.session }, run: pick.binding.run ?? null, footer: outcome.footer });
          // A model line with no effort word (no footer reads) is kept for this pane run.
          else if (outcome.modelLine !== null) {
            this.cursorLines.set(key, { ...seenOf(pick.binding), line: outcome.modelLine, family: cursorFamilyName(outcome.modelLine) });
            this.changed();
          }
          if (outcome.modelLine !== null && !sameCursorFamily(outcome.modelLine, pick.request.label)) {
            this.drop(key, pick);
            this.say(key, pick, cursorChoseText(outcome.modelLine));
            this.changed();
            return;
          }
        }
        // Grok's screen confirmed the pick (its footer or a new "Switched to …" line): kept for the
        // pane run, over Grok's files; not confirmed: the pick shows its usual wait, and an older kept one goes (the
        // Return went: what Grok runs is not known from it any more).
        if (outcome !== undefined && outcome.type === "grok" && pick.agent === "grok" && pick.request.kind === "model") {
          if (outcome.confirmed) {
            this.grokKept.set(key, { ...seenOf(pick.binding), model: pick.request.value, label: pick.request.label, effort: outcome.effort, shown: outcome.shown, said: outcome.said });
            this.grokSwitches.delete(key);
            this.drop(key, pick);
          } else {
            this.grokKept.delete(key);
          }
        }
        // Codex's line went: what it runs now, until a newer turn_context or another run.
        if (codexNamed(pick)) this.typedCodex(key, pick);
        // Your typed line went: the draft lets it go.
        if (pick.typed) this.deps.box?.went(key, pick.command);
        // Codex's picker is answered in its terminal, not in the transcript (a model by name waits for it).
        if (pick.agent === "codex" && pick.request.kind === "model" && pick.request.value === "picker") this.drop(key, pick);
        pick.onSent?.();
        // A compaction the transcript showed while Compact was still on its way confirms it now.
        if (pick.request.kind === "compact" && this.confirmNow(key, pick)) return;
        this.changed();
      },
      (failure: unknown) => {
        const message = failure instanceof Error ? failure.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : "Not sent";
        // Busy again by its turn (a pick before it started work): held for the next turn, once.
        if (message === notAtPromptText) {
          if (this.picks.get(key)?.get(pick.request.kind) === pick) pick.state = "held";
          this.changed();
          return;
        }
        this.drop(key, pick);
        let note = refusalNote(message);
        if (isPaneChangedNote(message)) {
          this.deps.copy(pick.command);
          note = `${note.replace(/\.$/, "")}. The command is copied.`;
        }
        // A model pick not sent says so in its Model menu too.
        if (pick.request.kind === "model") this.modelLines.set(key, { text: note, binding: pick.binding, seen: false });
        // A typed line comes back (box or note), with the same wording
        // (an outcome not known keeps its own: "Check the agent before sending again"); never sent again by itself.
        // With what main's note says of its outcome (refused or may have gone).
        this.giveBack(key, pick, note, compactOutcomeOf(failure));
        this.changed();
      },
    );
  }

  private drop(key: string, pick: Pick): void {
    const picks = this.picks.get(key);
    if (picks?.get(pick.request.kind) === pick) picks.delete(pick.request.kind);
  }

  /** Compact for the pane shown with `binding`: held for its next turn, on its way or waiting for the transcript, or neither. */
  compacting(key: string, binding: SendBinding): CompactState {
    const pick = this.picks.get(key)?.get("compact");
    if (pick === undefined || !sameBinding(pick.binding, binding)) return null;
    if (pick.state === "held") return "held";
    if (pick.state === "sending") return "running";
    // Claude's by its bounded wait; any other agent's five minutes from the send.
    const end = claudeCompact(pick) ? compactEnd(pick).at : pick.sentAt + compactWaitMs;
    return this.deps.now() < end ? "running" : null;
  }

  /** What a chip shows: a held pick ("next turn"), a pick on its way or waiting for the transcript, else the transcript's value. */
  chip(key: string, kind: ChipKind, binding: SendBinding): ChipView {
    // Codex's Model and Effort show its one latest choice: the one the next Effort
    // command names (codexChoice), so the chip and the command never disagree.
    if (binding.kind === "codex" && (kind === "model" || kind === "effort")) {
      const choice = this.codexChoice(key, binding);
      if (choice !== null) {
        const label = kind === "model" ? choice.model : effortLabel(choice.effort ?? this.settings(key, binding).effort);
        return { label, next: choice.held };
      }
    }
    const pick = this.picks.get(key)?.get(kind);
    if (pick !== undefined && sameBinding(pick.binding, binding)) {
      if (pick.state === "held") return { label: pick.request.label, next: true };
      if (pick.state === "sending" || this.deps.now() - pick.sentAt < confirmWaitMs) return { label: pick.request.label, next: false };
    }
    // Before the transcript (or footer, or files) says the model, New agent's choice, else
    // "Default" (the agent's own), never a bare "Model".
    const start = this.startShown(key, binding);
    if (binding.kind === "cursor") {
      // The model line read after a pick (its family); effort and context unknown with it.
      const line = this.cursorModelLine(key, binding);
      if (line !== null) {
        return kind === "model" ? { label: line.family, next: false, title: `Model: ${line.line} (as Cursor's line under its box said after the pick)` } : { label: effortLabel(null), next: false };
      }
      const footer = this.cursorFooter(key, binding);
      if (kind === "model") return footer !== null ? { label: footer.model, next: false } : startModelChip(start);
      return footer !== null ? { label: cursorEffortChip(footer), next: false } : { label: effortLabel(start?.effort ?? null), next: false };
    }
    const settings = this.settings(key, binding);
    // OpenCode's model as its footer named it after a pick here.
    const openCode = binding.kind === "opencode" && kind === "model" ? this.openCodeModel(key, binding) : null;
    if (openCode !== null) return { label: openCode.label, next: false, title: `Model: ${openCode.label} (as OpenCode's footer said after the pick)` };
    if (kind === "model") return settings.modelLabel !== null ? { label: settings.modelLabel, next: false } : startModelChip(start);
    return { label: effortLabel(settings.effort ?? (settings.modelLabel === null ? (start?.effort ?? null) : null)), next: false };
  }

  /** A pick of `kind` the chips still show: held, on its way, or sent and within its wait. */
  private shownPick(key: string, kind: ChipKind, binding: SendBinding): Pick | null {
    const pick = this.picks.get(key)?.get(kind);
    if (pick === undefined || !sameBinding(pick.binding, binding)) return null;
    return pick.state === "held" || pick.state === "sending" || this.deps.now() - pick.sentAt < confirmWaitMs ? pick : null;
  }

  /**
   * Codex's one latest model and effort choice for the pane run shown with
   * `binding`: its pick naming them (one at a time: accepting one retires the other; held, on its way, or sent until
   * a turn_context read after it), else the line typed last in this run while no turn_context since was read; null:
   * the transcript's. The 10 s confirm wait never decides it.
   */
  private codexChoice(key: string, binding: SendBinding): { readonly model: string; readonly effort: string | null; readonly held: boolean } | null {
    const picks = this.picks.get(key);
    const entries = [picks?.get("model"), picks?.get("effort")].filter((pick): pick is Pick => pick !== undefined && codexNamed(pick) && sameBinding(pick.binding, binding));
    const newest = entries.sort((a, b) => b.seq - a.seq)[0];
    if (newest !== undefined) return { model: newest.request.modelPick!.model, effort: newest.request.modelPick!.effort, held: newest.state === "held" };
    const typed = this.codexTyped.get(key);
    if (typed === undefined) return null;
    // Another run in the pane: the line typed into the last one is not this one's (it goes; sync says so too).
    if (!sameBinding(typed.binding, binding)) {
      this.codexTyped.delete(key);
      return null;
    }
    return { model: typed.model, effort: typed.effort, held: false };
  }

  /** Codex's line `pick` went: the line typed last, unless a later choice's went first. */
  private typedCodex(key: string, pick: Pick): void {
    const value = this.values.get(key);
    const turnAt = value !== undefined && inScope(value, pick.binding) ? (value.modeAt ?? -1) : -1;
    pick.turnAt = turnAt;
    const before = this.codexTyped.get(key);
    if (before !== undefined && before.seq > pick.seq && sameBinding(before.binding, pick.binding)) return;
    const named = pick.request.modelPick!;
    this.codexTyped.set(key, { model: named.model, effort: named.effort, seq: pick.seq, binding: pick.binding, turnAt });
  }

  /** The newest shown pick that names a model (a model from the picker, Codex's Effort), or null. */
  private newestNamed(key: string, binding: SendBinding): Pick | null {
    const named = [this.shownPick(key, "model", binding), this.shownPick(key, "effort", binding)].filter((pick): pick is Pick => pick?.request.modelPick !== undefined);
    return named.sort((a, b) => b.seq - a.seq)[0] ?? null;
  }

  /**
   * The model and effort the pane is on as its chips show them: the newest pick
   * not yet confirmed that names them (a model from the picker; Codex's Effort names its model and level), else the
   * transcript's. The Effort menu's levels and an Effort or Model pick's command resolve against it, so a later
   * pick never names the earlier model.
   */
  effective(key: string, binding: SendBinding): { readonly model: string | null; readonly effort: string | null } {
    const settings = this.settings(key, binding);
    // Codex by its one latest choice, never by the 10 s wait (codexChoice).
    if (binding.kind === "codex") {
      const choice = this.codexChoice(key, binding);
      return choice === null ? { model: settings.model, effort: settings.effort } : { model: choice.model, effort: choice.effort ?? settings.effort };
    }
    const named = this.newestNamed(key, binding);
    const model = named?.request.modelPick!.model ?? settings.model;
    let effort = settings.effort;
    if (named !== null && named.request.modelPick!.agent === "codex") effort = named.request.modelPick!.effort ?? effort;
    const effortPick = this.shownPick(key, "effort", binding);
    if (effortPick !== null && (named === null || effortPick.seq >= named.seq)) effort = effortPick.request.value;
    return { model, effort };
  }

  /** New agent started this pane with `shown` (its chips say so until the agent does). */
  noteStart(hostId: string, paneId: string, shown: StartShown): void {
    this.starts.set(`${hostId}/${paneId}`, { shown, terminalID: null, run: null });
    this.changed();
  }

  /**
   * The pane's New agent choice for the pane shown with `binding`: the same kind; pinned to the
   * terminal and run it is first seen with, and dropped for good once either changes (another agent in the pane).
   */
  startShown(key: string, binding: SendBinding): StartShown | null {
    const entry = this.starts.get(key);
    if (entry === undefined) return null;
    if (entry.shown.kind !== binding.kind) return null;
    if (entry.terminalID === null) {
      entry.terminalID = binding.terminalID;
      entry.run = binding.run ?? null;
      return entry.shown;
    }
    const run = binding.run ?? null;
    const sameRun = entry.run === null || run === null || (entry.run.connection === run.connection && entry.run.arrival === run.arrival);
    if (entry.terminalID !== binding.terminalID || !sameRun) {
      this.starts.delete(key);
      return null;
    }
    if (entry.run === null && run !== null) entry.run = run;
    return entry.shown;
  }

  /**
   * Every snapshot: each pane with a pick is looked at again, shown or not (a
   * pick held for pane A goes when A is back at its prompt while you look at
   * B). A machine no longer listed, or answering without the pane, drops
   * them; a machine not answering keeps them until it does.
   */
  syncHosts(hosts: readonly HostView[]): void {
    for (const [key, picks] of Array.from(this.picks.entries())) {
      const any = picks.values().next().value;
      if (any === undefined) continue;
      const host = hosts.find((candidate) => candidate.id === any.hostId);
      if (host === undefined) {
        this.sync(key, null);
        continue;
      }
      if (host.state !== "connected" || host.topology === null) continue;
      this.sync(key, pickContext(host, any.paneId));
    }
  }

  /** Forgets everything (a fresh page; the tests start from it). */
  clear(): void {
    this.picks.clear();
    this.values.clear();
    this.footers.clear();
    this.modes.clear();
    this.codexModes.clear();
    this.codexTyped.clear();
    this.modeWarnings.clear();
    this.grokSwitches.clear();
    this.openCodeSeen.clear();
    this.cursorLines.clear();
    this.grokKept.clear();
    this.modelLines.clear();
    this.notes.clear();
    this.keptNotes.clear();
    this.confirmed.clear();
    this.turns.clear();
    this.starts.clear();
    this.changed();
  }
}

/** The Model chip from New agent's choice, or the agent's default. */
function startModelChip(start: StartShown | null): ChipView {
  if (start?.model !== null && start?.model !== undefined) return { label: start.modelLabel ?? start.model, next: false, title: `Model: ${start.modelLabel ?? start.model} (chosen in New agent)` };
  return { label: defaultModelChip.label, next: false, title: defaultModelChip.title };
}

/**
 * The pane as the machine's snapshot shows it, for the chips: a Claude,
 * Codex or Cursor agent's (else null: no chips), its status as the sidebar reads it (a
 * pending menu is a dialog), and the binding a message would have, with the
 * connection and the agent run the row showed.
 */
export function pickContext(host: HostView, paneId: string): PickContext | null {
  const topology = host.topology;
  if (topology === null || topology === undefined) return null;
  const pane = topology.panes.find((candidate) => candidate.paneID === paneId);
  if (pane === undefined) return null;
  const agentInfo = topology.agents.find((candidate) => candidate.paneID === paneId) ?? null;
  const isAgent = pane.agent !== undefined && pane.agent !== "";
  const binding = runBindingOf(host, paneId, isAgent);
  // OpenCode's Model chip too.
  const agent =
    isAgent && (binding.kind === "claude" || binding.kind === "codex" || binding.kind === "cursor" || binding.kind === "grok" || binding.kind === "opencode") ? binding.kind : null;
  if (agent === null) return null;
  let status = agentStatusFromWire(pane.agentStatus);
  if (agentInfo !== null && (agentInfo.agentStatus === "blocked" || agentInfo.inputPending === true)) status = "blocked";
  return { hostId: host.id, paneId, agent, status, binding };
}

/** A Cursor menu item's pick (`picker`, `effort:high`, `context:500K`, `fast:on`), or null. */
export function cursorPickOf(request: PickRequest): CursorPick | null {
  if (request.kind === "model") return request.value === "picker" ? { kind: "model" } : null;
  if (request.kind !== "effort") return null;
  const [what, value] = request.value.split(":") as [string, string | undefined];
  if (value === undefined) return null;
  if (what === "effort") return (cursorEfforts as readonly string[]).includes(value) ? { kind: "effort", value: value as CursorEffort } : null;
  if (what === "context") return cursorWindows.includes(value) ? { kind: "context", value } : null;
  if (what === "fast") return value === "on" || value === "off" ? { kind: "fast", value: value === "on" } : null;
  return null;
}

/** The app's picks (renderer-wide), sent through the page's bridge. */
export const agentPicks = new AgentPicks({
  send: (hostId, paneId, text, binding) => window.herdrDesktop.sendToPane(hostId, paneId, text, binding),
  // A model pick, checked and made into its line in main.
  modelPick: (hostId, paneId, pick, binding) =>
    window.herdrDesktop.modelPick === undefined ? Promise.reject(new Error("Not sent: this window cannot send a model pick.")) : window.herdrDesktop.modelPick(hostId, paneId, pick, binding),
  // OpenCode's model, driven through its own list in main.
  openCodePick: (hostId, paneId, model, binding) =>
    window.herdrDesktop.openCodePick === undefined ? Promise.reject(new Error("Not set: this window cannot drive OpenCode's list")) : window.herdrDesktop.openCodePick(hostId, paneId, model, binding),
  cursorPick: (hostId, paneId, pick, binding) =>
    window.herdrDesktop.cursorPick === undefined ? Promise.reject(new Error("Not set: this window cannot drive Cursor's menu")) : window.herdrDesktop.cursorPick(hostId, paneId, pick, binding),
  grokPick: (hostId, paneId, pick, files, binding) =>
    window.herdrDesktop.grokPick === undefined ? Promise.reject(new Error("Not set: this window cannot send Grok's command")) : window.herdrDesktop.grokPick(hostId, paneId, pick, files, binding),
  // Absent in a window without the switch (the pick says so).
  get modePick() {
    const bridge = typeof window === "undefined" ? undefined : window.herdrDesktop;
    return bridge?.modePick === undefined ? undefined : (hostId: string, paneId: string, agent: ModeAgent, target: string, binding: SendBinding) => bridge.modePick!(hostId, paneId, agent, target, binding);
  },
  copy: (text) => window.herdrDesktop.copyText(text),
  now: () => Date.now(),
  // A typed `/compact` held is kept with the pane's draft.
  box: {
    hold: (key, line) => composerDrafts.hold(key, line),
    went: (key, line) => composerDrafts.heldWent(key, line),
    back: (key, line) => composerDrafts.heldBack(key, line),
    // A line that did not go, with newer text in the box, to Kept drafts.
    keep: (key, line, outcome) => draftPersistence.keepHeld(key, line, outcome),
  },
});

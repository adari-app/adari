// The selected pane: a header (name, workspace, status, folder) with an agent
// pane's switch, Chat · <the agent's own name> · Changes
// (its middle tab is the agent's own screen,
// "Claude Code", "Codex"…; a plain shell shows its terminal with no switch).
// Chat is the agent's transcript (src/renderer/chat) under the
// message box, which floats over the column's bottom as T3 Code's composer does
// (its controls in one row: the agent, the workspace, the machine, attach, Send). Terminal is the pane's live terminal filling the area, keys
// going straight to it; the header's box button (and ⇧⌘T) brings the message
// box over it and hides it again. The box sends by the main process's rule
// (src/main/herdr/send.ts); what it sends to an agent shows in Chat at once.
// Under an agent pane's view, its terminal drawer (⌘J, the header's terminal
// button; src/renderer/terminal/TerminalDrawer.tsx): real shells in its
// workspace's folder, T3 Code's drawer under its chat.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import type { GhosttyAvailability, HostView, MainTab } from "../../shared/ipc-contract";
import { bindingOf, runBindingOf } from "../../shared/send-binding";
import type { SidebarRow } from "../../shared/sidebar-model";
import { pickerAccept } from "../../shared/attachments";
import { agentSessionKey } from "../../shared/changes/content";
import { shownTab } from "../../shared/changes/tabs";
import { ChangesIcon, ChatIcon, CloseIcon, ExternalIcon, FileIcon, FolderIcon, ImageIcon, MessageBoxIcon, MonitorIcon, MoreIcon, PaperclipIcon, SendIcon, SplitIcon, TerminalDrawerIcon, TerminalIcon } from "../icons";
import { ChangesView } from "../changes/ChangesView";
import { ChatView } from "../chat/ChatView";
import { RunningStrip } from "../chat/RunningStrip";
import { chatSends, pendingMessages, sendWithPending, subscribePending } from "../chat/chat-state";
import type { PendingMessage } from "../../shared/chat/pending";
import { sendCommandRow } from "../chat/command-rows";
import { isSlashCommand, takesCommands } from "../../shared/slash-command";
import { RemoteTerminalPort } from "../terminal/remote-port";
import { TerminalView } from "../terminal/TerminalView";
import { TerminalDrawer, type DrawerView } from "../terminal/TerminalDrawer";
import { AgentGlyph, agentName, agentOwnName, agentScreenTitle, ChatEarlyBadge } from "./agent-kind";
import { attachFiles, attachPasted, dragOverFiles, dropFiles, pasteTakesFiles } from "./attachments";
import { composerDrafts, draftKey, isSendable, sendDraft, sendsAfterUploadText, subscribeComposerDrafts, type AttachmentChip } from "./composer-drafts";
import { composerSettings } from "./composer-settings";
import { returnSends, sendButtonTitle } from "../../shared/settings";
import { AgentChips } from "./AgentChips";
import { ContextRing } from "./ContextRing";
import { contextScreens } from "./context-screens";
import { draftPersistence } from "./draft-persistence";
import { KeptDraftsRow } from "./KeptDrafts";
import { agentPicks, isCompactLine, pickContext } from "./agent-picks";
import { fitBox } from "./composer-size";
import { handoffStore } from "../handoff/handoff-state";
import { shellPlaceholder, type ResumeOffer } from "../../shared/pane-life";
import { useResumeOffer } from "./resume";
import { agentGeneration, agentStops, armedStops, escTurns, justSentMs, keyOrigins, turnEpisodeOf, windowEscStops, type ArmedScope } from "./agent-stop";
import { isStopKey, stopBindingOf, stopEpisodeKey, stopPossible } from "../../shared/agent-stop";
import { escapeOwners, useEscapeOwner } from "./escape-owners";
import { takeBackAfterStop, WorkEdges } from "../chat/esc-back";
import { queuedSends, sayNoQueue, takeBackDeps, takeBacks } from "../chat/take-back";
import { escGoes } from "../../shared/claude-screen";
import { Glyph } from "./Sidebar";
import { UpdateMark } from "./UpdateMark";
import { ContextMenu } from "./ContextMenu";
import { useRestart } from "./restart-view";
import { agentRestarts } from "./restart";
import { composerNoteMs, noteLineOf, type NoteSource } from "./note-line";
import { restartCardLabel, restartMenuLabel } from "../../shared/agent-restart";
import { needsCards } from "../chat/needs-card-store";
import { needsCardShown } from "../chat/NeedsCard";
import { boxAnswer } from "../../shared/prompt/box";
import { boxStartScreenNote } from "../../shared/prompt/start-screen";
import { notAnswering, type PaneMenuContext } from "../../shared/pane-manage";
import type { MenuItem } from "./ContextMenu";

const statusLabel: Record<SidebarRow["glyph"], string> = {
  needsYou: "Needs you",
  working: "Working",
  doneUnseen: "Done",
  idle: "Idle",
  unknown: "Unknown",
  shell: "Shell",
};

/** The last three folders, as the design shows a path ("…/demo/code/aurora-web"). */
export function shortPath(path: string | undefined): string {
  if (path === undefined || path === "") return "";
  const parts = path.split("/").filter((part) => part !== "");
  return parts.length <= 3 ? path : `…/${parts.slice(-3).join("/")}`;
}

/**
 * One port per attach: an ended or failed terminal reopens only when Reconnect
 * makes a new one. A tile's terminal takes the keyboard only when its tile is
 * focused (autoFocus).
 */
export function TerminalTab({
  host,
  row,
  fontSize,
  focusSignal,
  autoFocus = true,
}: {
  host: HostView;
  row: SidebarRow;
  fontSize: number;
  focusSignal: number;
  autoFocus?: boolean;
}) {
  const [note, setNote] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const port = useMemo(
    () =>
      new RemoteTerminalPort(
        window.herdrDesktop,
        host.id,
        row.paneID,
        (reason) => setNote(reason ?? "The terminal closed."),
        (message) => setNote(message),
      ),
    // `attempt` is the deliberate reopen.
    [host.id, row.paneID, attempt],
  );
  useEffect(() => () => port.dispose(), [port]);
  useEffect(() => setNote(null), [host.id, row.paneID]);
  // An attachment pasted or dropped on the terminal that did not go: said for a moment.
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    if (toast === null) return;
    const timer = setTimeout(() => setToast(null), 6_000);
    return () => clearTimeout(timer);
  }, [toast]);
  return (
    <div className="term">
      {toast === null ? null : (
        <div className="term-toast" role="status" onClick={() => setToast(null)}>
          {toast}
        </div>
      )}
      {note === null ? null : (
        <div className="term-note">
          {note}
          <button
            className="btn sm"
            onClick={() => {
              setNote(null);
              setAttempt((n) => n + 1);
            }}
          >
            Reconnect
          </button>
        </div>
      )}
      <TerminalView
        port={port}
        fontSize={fontSize}
        focusSignal={focusSignal}
        autoFocus={autoFocus}
        onNote={setToast}
        onScreen={(text) => {
          // The reading is kept with the run shown and the transcript's baseline then.
          const key = draftKey(host.id, row.paneID);
          const binding = runBindingOf(host, row.paneID, row.isAgent);
          const known = agentPicks.known(key, binding);
          contextScreens.report(key, text, binding, known === null ? null : { compactedAt: known.compactedAt ?? null, usedAt: known.usedAt ?? null });
        }}
      />
    </div>
  );
}

/** The message box for the shown pane; its draft and send state belong to that pane (composer-drafts.ts). */
export interface ComposerProps {
  readonly host: HostView;
  readonly row: SidebarRow;
  /** Over the terminal: takes the keyboard when shown; Escape hides it. */
  readonly overlay?: boolean;
  readonly onDismiss?: () => void;
  /** Floating over the bottom of the chat column (T3 Code's composer); its height goes to `onHeight`. */
  readonly floating?: boolean;
  readonly onHeight?: (height: number) => void;
  /** A tile's box: no strip or hint line. */
  readonly compact?: boolean;
  /** A tile's box takes the keys while its tile is focused; a change of `focusSignal` gives them to it again. */
  readonly takesKeys?: boolean;
  readonly focusSignal?: number;
  /** Shows the pane's Terminal (Codex's model picker opens there). */
  readonly onShowTerminal?: () => void;
  /** Chat's box: Stop stands in Send's place while the agent works and the box is empty. */
  readonly stops?: boolean;
}

const agentPlaceholder = "Ask for changes, send follow-ups, or attach images";

/** A chip's line under its name: where its upload stands, and its removal. */
function chipStatus(chip: AttachmentChip): string | null {
  switch (chip.state.kind) {
    case "uploading":
      return "Uploading…";
    case "failed":
      return "Did not upload";
    case "removing":
      return "Removing…";
    case "cleanup":
      return "Not removed";
    default:
      return null;
  }
}

/** Retry shows on a chip that did not upload, or whose removal failed. */
const retries = (chip: AttachmentChip): boolean => chip.state.kind === "failed" || chip.state.kind === "cleanup";

/** A chip's tooltip: its name, and why it did not upload or was not removed. */
function chipTitle(chip: AttachmentChip): string {
  switch (chip.state.kind) {
    case "failed":
      return `${chip.name}: ${chip.state.reason}`;
    case "cleanup":
      return `${chip.name} is still on the machine: ${chip.state.reason}`;
    default:
      return chip.name;
  }
}

/**
 * The Resume chip: after Claude or Codex exits in the
 * pane, "Resume 0f2c9a6e" fills the pane's box with its resume command
 * (`cl --resume <id>` with the Mac's start command); your Return runs it. With
 * text in the box it waits, so a draft is never written over.
 */
export function ResumeChip({ offer, boxEmpty, onFill, floating = false }: { offer: ResumeOffer; boxEmpty: boolean; onFill(): void; floating?: boolean }) {
  return (
    <button
      className={`resume${boxEmpty ? "" : " off"}${floating ? " float" : ""}`}
      aria-disabled={!boxEmpty}
      aria-label={offer.title}
      title={boxEmpty ? `Puts ${offer.command} in the box. Return runs it.` : `Empty the box first: it puts ${offer.command} in the box.`}
      onClick={() => {
        if (boxEmpty) onFill();
      }}
    >
      <span className="i">↩</span>
      {offer.title}
    </button>
  );
}

/** Fills the pane's box with the resume command (never runs it), only while the box is empty. */
export function fillResume(hostId: string, paneId: string, offer: ResumeOffer): boolean {
  const key = draftKey(hostId, paneId);
  if (composerDrafts.get(key).text !== "") return false;
  handoffStore.expectLanding(key, offer.command.length);
  composerDrafts.edit(key, offer.command);
  return true;
}

/**
 * Your newest pending bubble for the pane went from this
 * Chat less than 30 s ago, to the terminal shown now (or one not known).
 */
export function justSentFrom(pending: readonly PendingMessage[], terminalID: string, nowMs: number): boolean {
  const last = pending.at(-1);
  if (last === undefined || nowMs - last.sentAtMs >= justSentMs || nowMs < last.sentAtMs - justSentMs) return false;
  const sentTo = last.scope?.terminalID ?? "";
  return sentTo === "" || terminalID === "" || sentTo === terminalID;
}

export function Composer({
  host,
  row,
  overlay = false,
  onDismiss,
  floating = false,
  onHeight,
  compact = false,
  takesKeys = false,
  focusSignal = 0,
  onShowTerminal,
  stops = false,
}: ComposerProps) {
  const key = draftKey(host.id, row.paneID);
  const draft = useSyncExternalStore(subscribeComposerDrafts, () => composerDrafts.get(key));
  // Why the last Model or Effort pick did not go.
  const pickNote = useSyncExternalStore(agentPicks.subscribe, () => agentPicks.note(key));
  // A dropped `/compact` line or a Compact that did not finish stays until dismissed.
  const pickNoteKept = useSyncExternalStore(agentPicks.subscribe, () => agentPicks.noteKept(key));
  const { text, error, chips, sending, lost, waiting } = draft;
  // How Return and ⌘Return act here (Settings › Chat).
  const pressesReturn = useSyncExternalStore(composerSettings.subscribe, composerSettings.sendPressesReturn);
  const macKeys = useSyncExternalStore(composerSettings.subscribe, composerSettings.isMac);
  // The chips that go with a Send (not one you removed).
  const sendableCount = chips.filter(isSendable).length;
  // While this box shows the pane, a Send waiting for its uploads may go; when the last box of the
  // pane goes (its Chat left, another pane or machine), the Send is let go, unsent, and the draft stays.
  useEffect(() => composerDrafts.showing(key), [key]);
  // Drafts of this machine's gone panes (Kept drafts).
  useSyncExternalStore(draftPersistence.subscribe, draftPersistence.version);
  const kept = draftPersistence.keptFor(host.id);
  const picker = useRef<HTMLInputElement>(null);
  // While Chat's card shows the agent's question, the box answers with its "No, tell…" option or keeps the text.
  useSyncExternalStore(needsCards.subscribe, needsCards.version, needsCards.version);
  const asking = !overlay && needsCardShown(row, needsCards.forPane(host.id, row.paneID));
  const prompt = asking ? needsCards.forPane(host.id, row.paneID) : null;
  const promptCard = needsCards.card(host.id, row.paneID);
  const boxAnswering = boxAnswer({ asking, reading: prompt?.reading ?? null, kind: row.kind, busy: promptCard.busy || promptCard.sent !== null });
  // Bound to the pane as shown when you pressed Send: main sends only while it still is.
  const send = (): void => {
    // The next send clears the note line.
    if (text.trim() !== "" || sendableCount > 0) clearNotes();
    if (boxAnswering !== null) {
      if (text.trim() === "" && chips.length === 0) return;
      // Grok Build's, Cursor Agent's or Gemini CLI's own start question: the note names it.
      const refusal = boxStartScreenNote(host, row.paneID) ?? boxAnswering.refusal(text, chips.length);
      if (refusal !== null || boxAnswering.match === null || boxAnswering.tell === null) {
        needsCards.setBoxNote(host.id, row.paneID, refusal);
        return;
      }
      const sentText = text;
      void needsCards.answer(window.herdrDesktop, host, row.paneID, row.kind, boxAnswering.match, boxAnswering.tell, sentText).then((result) => {
        if (result?.type !== "sent" || composerDrafts.get(key).text !== sentText) return;
        composerDrafts.edit(key, "");
        chatSends.sent(key);
      });
      return;
    }
    // `/compact` while Claude works is held as the ring's Compact is and sent when
    // the turn ends (the ring then spins and Chat says Compacted); the box lets it go and its note says so.
    const held =
      chips.length === 0 && row.isAgent && row.kind === "claude" && row.status === "working" && !sending && isCompactLine(text) ? pickContext(host, row.paneID) : null;
    // The held line moves into the draft's `held` (saved, yours until it
    // goes); a second one while one is held stays in the box with its note.
    if (held !== null && agentPicks.holdTypedCompact(held, text)) return;
    const binding = bindingOf(host.topology, row.paneID, row.isAgent);
    const bridge = window.herdrDesktop;
    // A command line for Claude Code or Codex shows as a command row, not your bubble.
    const command = (t: string): boolean => row.isAgent && takesCommands(binding.kind ?? row.kind) && isSlashCommand(t);
    // It carries the connection and the pane's run shown, as the chips' picks do (send.ts refuses one without).
    const commandBinding = runBindingOf(host, row.paneID, row.isAgent);
    sendDraft(
      composerDrafts,
      (h, p, t) =>
        command(t)
          ? sendCommandRow((hh, pp, tt) => bridge.sendToPane(hh, pp, tt, commandBinding), h, p, t)
          : sendWithPending((hh, pp, tt) => bridge.sendToPane(hh, pp, tt, binding), h, p, t, row.isAgent, {
              terminalID: binding.terminalID,
              session: binding.session,
            }),
      host.id,
      row.paneID,
      // The chips uploaded as they were attached (the bridge, composer-drafts.ts bridgeTransport).
      null,
      // When the message goes: at the press, or once a waiting Send's uploads finished.
      () => {
        // What you send to an agent adds a row (your bubble, a command's row): its Chat goes to the end.
        if (row.isAgent) chatSends.sent(key);
        // A stop armed for the last send is not one for this send.
        armedStops.disarm(key);
        // What runs after this send is a new turn: Herdr's status shows it.
        escTurns.sent(key);
      },
    );
  };
  const canSend = (text.trim() !== "" || sendableCount > 0) && !sending;
  // Stop for the agent of this Chat, Escape to this box's own pane.
  useSyncExternalStore(agentStops.subscribe, agentStops.version);
  // The spinner after a press is a look only; every press is one Esc.
  const stopping = agentStops.isStopping(key);
  const stopNote = agentStops.note(key);
  const online = host.state === "connected";
  // A read after an Esc showed Claude's working line gone: the turn has ended here (the square
  // back to Send, Esc as after a turn), while Herdr still says working; a new turn (another status) shows at once.
  useSyncExternalStore(escTurns.subscribe, escTurns.version);
  useEffect(() => escTurns.attach(window.herdrDesktop), []);
  const herdrWorking = row.isAgent && row.status === "working";
  const turnEpisode = turnEpisodeOf(host, row.paneID);
  const endedHere = escTurns.look(key, herdrWorking, turnEpisode) === "ended";
  useEffect(() => escTurns.observe(key, herdrWorking, turnEpisode), [key, herdrWorking, turnEpisode]);
  const shownWork = endedHere ? "idle" : row.status;
  const herdrStops = stops && !overlay && stopPossible({ isAgent: row.isAgent, status: shownWork, online });
  // Herdr's status trails Claude's screen at a turn's edges: within 2 s after the pane
  // stopped showing working Esc still goes; outside that, a press at a Claude pane asks its screen (stopIfWorking).
  // Kept by this box (its pane's edges since it showed), so a box shown anew starts with none.
  const edgesRef = useRef<WorkEdges | null>(null);
  if (edgesRef.current === null) edgesRef.current = new WorkEdges();
  const workEdges = edgesRef.current;
  workEdges.observe(key, herdrWorking && !endedHere, Date.now());
  const claudePane = stops && !overlay && row.isAgent && online && row.kind === "claude" && row.status !== "blocked";
  const canStop = herdrStops || (claudePane && escGoes({ herdrWorking: false, screenWorking: false, lastWorkingMs: workEdges.endedAt(key), nowMs: Date.now() }));
  // After an Esc went to Claude, its box is read: Chat's last send put back there comes back to this box.
  const afterEsc = (binding: ReturnType<typeof stopBindingOf>): void => {
    const bridge = window.herdrDesktop;
    if (row.kind !== "claude" || bridge.afterStop === undefined) return;
    void bridge.afterStop(host.id, row.paneID, binding).then(
      (found) => {
        // The reads ended with Claude's working line gone (told at that read too, by onEscScreen).
        if (found.working === false) escTurns.screenIdle(key);
        takeBackAfterStop(
          {
            drafts: composerDrafts,
            pending: pendingMessages,
            landing: (at, start) => handoffStore.expectLanding(at, start),
            note: (at, text) => agentStops.setNote(at, text),
          },
          key,
          found,
        );
      },
      () => undefined,
    );
  };
  const stop = (): void => {
    const binding = stopBindingOf(host, row.paneID, agentName(row.kind));
    const live = herdrStops || (claudePane && escGoes({ herdrWorking: false, screenWorking: false, lastWorkingMs: workEdges.endedAt(key), nowMs: Date.now() }));
    if (live) {
      // "Stopping…" from the press; a key that did not go takes it back.
      const pressedAt = escTurns.pressed(key, turnEpisode);
      agentStops.stop(key, async () => {
        const note = await window.herdrDesktop.stopAgent(host.id, row.paneID, binding).catch((failure: unknown) => {
          escTurns.withdrawn(key, pressedAt);
          throw failure;
        });
        if (note === null) afterEsc(binding);
        else escTurns.withdrawn(key, pressedAt);
        return note;
      });
      return;
    }
    // Neither Herdr nor the last 2 s showed working: Esc only when Claude's screen shows its working line (never at a settled idle).
    const bridge = window.herdrDesktop;
    if (!claudePane || bridge.stopIfWorking === undefined) return;
    void bridge.stopIfWorking(host.id, row.paneID, binding).then(
      (result) => {
        if (result.note !== null) agentStops.setNote(key, result.note);
        if (result.sent) {
          escTurns.pressed(key, turnEpisode);
          afterEsc(binding);
        }
      },
      () => undefined,
    );
  };
  // Esc right after a send, before Herdr reports the turn, arms one stop.
  useSyncExternalStore(armedStops.subscribe, armedStops.version);
  const pending = useSyncExternalStore(subscribePending, () => pendingMessages.forPane(key));
  const shownBinding = stopBindingOf(host, row.paneID, agentName(row.kind));
  // A dialog or a pending menu shown for the pane, by any word Herdr gives.
  const shownAgent = host.topology?.agents.find((agent) => agent.paneID === row.paneID) ?? null;
  const shownPane = host.topology?.panes.find((pane) => pane.paneID === row.paneID) ?? null;
  const shownBlocked = row.status === "blocked" || shownPane?.agentStatus === "blocked" || shownAgent?.agentStatus === "blocked" || shownAgent?.inputPending === true;
  // The pane shown now, with its machine, connection, terminal, agent, session and run,
  // and its episode (status and state_change_seq) and dialog state. A press that
  // waits acts only while all of it is still what is shown.
  const shownTarget = JSON.stringify([
    host.id,
    row.paneID,
    host.incarnation ?? 0,
    host.connection ?? 0,
    host.epoch ?? null,
    shownBinding.terminalID,
    shownBinding.kind,
    shownBinding.session,
    agentGeneration(host.topology, row.paneID),
    shownBinding.episode.status,
    shownBinding.episode.seq,
    shownBlocked,
  ]);
  const armScope: ArmedScope = {
    terminalID: shownBinding.terminalID,
    kind: shownBinding.kind,
    session: shownBinding.session,
    incarnation: host.incarnation ?? 0,
    connection: host.connection ?? 0,
    epoch: shownBinding.epoch,
    episode: stopEpisodeKey(shownBinding),
    seq: shownBinding.episode.seq,
    generation: agentGeneration(host.topology, row.paneID),
  };
  const armed = stops && !overlay && armedStops.isArmed(key);
  const canArm =
    stops &&
    !overlay &&
    !canStop &&
    row.isAgent &&
    host.state === "connected" &&
    row.status !== "blocked" &&
    // For what shows and whether Esc is listened for; stopOrArm checks again at the press.
    justSentFrom(pending, armScope.terminalID, Date.now());
  // What a waiting press may still act on: the target shown now, while no
  // dialog shows and this view allows a stop at all (null: none, also once this box is gone). Every waiting press
  // (`deferred`) whose target is not it is called off here, at once and for good, so a dialog or an episode that came
  // and went meanwhile never lets it through.
  const liveTarget = !shownBlocked && stops && !overlay && (canStop || canArm || claudePane) ? shownTarget : null;
  const liveTargetRef = useRef<string | null>(liveTarget);
  liveTargetRef.current = liveTarget;
  const deferred = useRef(new Set<{ readonly pressed: string; cancelled: boolean }>());
  for (const waiting of deferred.current) if (waiting.pressed !== liveTarget) waiting.cancelled = true;
  useEffect(() => {
    liveTargetRef.current = liveTarget;
    const waiting = deferred.current;
    return () => {
      // Another target, or this box gone: every press waiting for the one before is called off.
      liveTargetRef.current = null;
      for (const press of waiting) press.cancelled = true;
    };
  }, [liveTarget]);
  // The square follows Herdr's status (or an armed stop); the 2 s grace after it (above) is the key's only.
  const showStop = (herdrStops || armed) && text === "" && chips.length === 0;
  // While your last sends from Chat still wait in Claude's queue (their bubbles say Queued), Esc's
  // first press, Up in an empty box, or a bubble's Take back takes them back (Up, then Ctrl+U in Claude's box) instead
  // of stopping Claude; Claude keeps working. Nothing of that on Claude's screen: Esc stops as usual.
  const takesBack = stops && !overlay && claudePane && herdrWorking && !endedHere;
  const takeBackItems = (): ReturnType<typeof queuedSends> =>
    takesBack ? takeBacks.untried(key, queuedSends(pendingMessages.forPane(key), shownBinding.terminalID)) : [];
  /** Starts a take-back; false when there is none to try (`then` is not called). */
  const takeBack = (then: (end: "none" | "taken" | "left") => void = () => undefined): boolean => {
    const items = takeBackItems();
    if (items.length === 0 || takeBackDeps.bridge.takeBackQueued === undefined) return false;
    void takeBacks.run(takeBackDeps, host.id, row.paneID, key, stopBindingOf(host, row.paneID, agentName(row.kind)), items).then(then);
    return true;
  };
  const stopOrArm = (tookBack = false): void => {
    // A press that acts later acts only on the pane it was pressed for:
    // this render's stop, for the machine, connection, terminal, agent, session and run shown at the press, and
    // only while the same pane is still shown with all of them (never whatever stop is current by then).
    // Bound to the episode and dialog state too, and called off for good once
    // the view shown is not that (`deferred`, above); checked again, synchronously, right before it acts.
    const defer = (): ((act: boolean) => void) => {
      const waiting = { pressed: shownTarget, cancelled: liveTarget !== shownTarget };
      deferred.current.add(waiting);
      return (act) => {
        deferred.current.delete(waiting);
        if (act && !waiting.cancelled && liveTargetRef.current === waiting.pressed) stopOrArm(true);
      };
    };
    // A second press while a take-back is under way: once it ends, this press acts as the next Esc (it stops).
    const under = takeBacks.under(key);
    if (under !== null) {
      const later = defer();
      void under.then(() => later(true));
      return;
    }
    // A read that showed none of your queued messages (`none`): this same press stops as usual.
    if (!tookBack) {
      const later = defer();
      if (takeBack((end) => later(end === "none"))) return;
      later(false);
    }
    if (canStop) {
      stop();
      return;
    }
    if (canArm) {
      // "just sent" is decided at the press, by the pending sends and the clock now (the render's may be old).
      const now = pendingMessages.forPane(key);
      if (justSentFrom(now, armScope.terminalID, Date.now())) {
        armedStops.arm(key, armScope, now.at(-1)?.id ?? null);
        return;
      }
    }
    // A Claude pane Herdr shows idle: its screen decides (stop() reads it first).
    if (claudePane) stop();
  };
  // The armed stop goes once Herdr shows the same agent working in a new episode (main's fresh check, one Escape).
  useEffect(() => {
    if (armedStops.take(key, armScope, herdrStops)) stopRef.current();
  }, [key, herdrStops, armScope.episode, armScope.terminalID, armScope.kind, armScope.session, armScope.incarnation, armScope.connection, armScope.epoch, armScope.seq, armScope.generation]);
  // Another pane, or the box gone: an armed stop goes with it, and an Esc's "Stopping…" or its ended turn.
  useEffect(
    () => () => {
      armedStops.disarm(key);
      escTurns.forget(key);
    },
    [key],
  );
  // Herdr reporting the agent not working ends the spinner.
  const shownStatus = row.isAgent ? shownWork : null;
  useEffect(() => agentStops.observe(key, shownStatus), [key, shownStatus]);
  // Every composer note on the one line under the box, in full.
  const restartKey = `${host.id}|${row.paneID}`;
  const restartState = useSyncExternalStore(agentRestarts.subscribe, () => agentRestarts.state(restartKey));
  const noteSources: NoteSource[] = [
    // A Send waiting for its uploads; it stays until it goes, and its × lets the Send go (the draft stays).
    { text: waiting ? sendsAfterUploadText : null, dismiss: () => composerDrafts.abandonWait(key), held: true },
    { text: error, dismiss: () => composerDrafts.clearNote(key) },
    { text: asking ? promptCard.boxNote : null, dismiss: () => needsCards.setBoxNote(host.id, row.paneID, null) },
    { text: stopNote, dismiss: () => agentStops.dismiss(key) },
    // Chat's box carries the restart's note (the header's line shows it elsewhere); its "Restarting…" stays while it runs,
    // and how it ended stays until the next send, its × or the next restart.
    { text: stops ? restartState.note : null, dismiss: () => agentRestarts.dismiss(restartKey), held: restartState.busy, lasting: !restartState.busy },
    { text: pickNote, dismiss: () => agentPicks.dismissNote(key), held: pickNoteKept },
  ];
  const noteLine = noteLineOf(noteSources);
  const sourcesRef = useRef(noteSources);
  sourcesRef.current = noteSources;
  const clearNotes = (): void => {
    for (const source of sourcesRef.current) if (source.text !== null && source.held !== true) source.dismiss();
  };
  // A note clears when the agent's status changes...
  const lastStatus = useRef(row.status);
  useEffect(() => {
    if (lastStatus.current === row.status) return;
    lastStatus.current = row.status;
    for (const source of sourcesRef.current) if (source.text !== null && source.held !== true && source.lasting !== true) source.dismiss();
  }, [row.status]);
  // ...and 8 s after it showed.
  const shownNote = noteLine === null || noteLine.held || noteLine.lasting ? null : noteLine.text;
  useEffect(() => {
    if (shownNote === null || typeof setTimeout !== "function") return;
    const timer = setTimeout(() => {
      for (const source of sourcesRef.current) if (source.text === shownNote && source.held !== true) source.dismiss();
    }, composerNoteMs);
    return () => clearTimeout(timer);
  }, [shownNote]);
  // Esc stops it too, with text in the box (the draft and caret untouched), unless something on top owns Esc.
  const stopRef = useRef(stop);
  stopRef.current = stop;
  const stopOrArmRef = useRef(stopOrArm);
  stopOrArmRef.current = stopOrArm;
  const escStops = (event: React.KeyboardEvent): boolean =>
    (canStop || canArm || claudePane) &&
    isStopKey({ key: event.key, metaKey: event.metaKey, altKey: event.altKey, ctrlKey: event.ctrlKey, shiftKey: event.shiftKey, isComposing: event.nativeEvent.isComposing, repeat: event.repeat }) &&
    !event.defaultPrevented &&
    event.nativeEvent.defaultPrevented !== true &&
    !escapeOwners.any();
  // The box over the terminal owns Esc (it hides the box).
  useEscapeOwner(overlay);
  // Focus anywhere else (the sidebar, the header, the conversation, nothing): the
  // window's Esc, unless another feature's text field has the focus. A tile's only while it is focused.
  const takesWindowEsc = (canStop || canArm || armed || claudePane) && (!compact || takesKeys);
  const paneId = row.paneID;
  useEffect(() => {
    if (!takesWindowEsc || typeof window.addEventListener !== "function") return;
    const onKey = (event: KeyboardEvent): void => {
      if (!isStopKey(event) || event.defaultPrevented || escapeOwners.any()) return;
      const active = typeof document === "undefined" ? null : document.activeElement;
      // Where the key started counts too (a field gone or blurred on its own Esc keeps it).
      if (!windowEscStops(active, box.current, paneId, keyOrigins(event))) return;
      event.preventDefault();
      stopOrArmRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [takesWindowEsc, paneId]);

  // The box grows with its text (composer-size.ts) and tells the chat its new
  // height in the same event, so the chat pins its end before the next paint.
  const wrap = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const reportHeight = useRef(onHeight);
  reportHeight.current = onHeight;
  const fit = useCallback((): void => {
    const element = box.current;
    if (element === null) return;
    const lineHeight = (typeof getComputedStyle === "function" ? parseFloat(getComputedStyle(element).lineHeight) : NaN) || 22.75;
    element.style.height = "auto";
    const size = fitBox(element.scrollHeight, lineHeight, window.innerHeight || 900);
    element.style.height = `${size.height}px`;
    element.style.overflowY = size.scrolls ? "auto" : "hidden";
    const outer = wrap.current;
    if (outer !== null) reportHeight.current?.(outer.offsetHeight);
  }, []);
  // Text that changed without typing (sent, another pane's draft) and a resized window fit again.
  useEffect(() => fit(), [text, fit]);
  useEffect(() => {
    if (typeof window.addEventListener !== "function") return;
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [fit]);

  // The floating box tells the chat its height, so the chat's last row clears it.
  useEffect(() => {
    const element = wrap.current;
    if (element === null || onHeight === undefined || typeof ResizeObserver === "undefined") return;
    const report = (): void => onHeight(element.offsetHeight);
    report();
    const observer = new ResizeObserver(report);
    observer.observe(element);
    return () => observer.disconnect();
  }, [onHeight]);

  // A hand-off just put in this box (Send to…): the box takes the keys, its cursor where the hand-off starts.
  useEffect(() => {
    const start = handoffStore.takeLanding(key);
    const element = box.current;
    if (start === null || element === null) return;
    element.focus();
    element.setSelectionRange(start, start);
  }, [key, text]);
  // A focused tile's box: the keys come to it when the tile is focused from the keyboard or a click off the field.
  useEffect(() => {
    if (takesKeys && focusSignal > 0) box.current?.focus();
  }, [takesKeys, focusSignal]);
  const offer = useResumeOffer(host, row);

  return (
    <div
      ref={wrap}
      className={["cmp-wrap", overlay ? "over" : floating ? "float" : "", compact ? "compact" : ""].filter(Boolean).join(" ")}
      onDragOver={dragOverFiles}
      onDrop={(event) => dropFiles(key, event)}
    >
      {offer === null ? null : (
        <div className="resume-row">
          <ResumeChip offer={offer} boxEmpty={text === ""} onFill={() => fillResume(host.id, row.paneID, offer)} />
        </div>
      )}
      {kept.length === 0
        ? null
        : KeptDraftsRow({
            items: kept,
            boxEmpty: text === "" && chips.length === 0,
            onPut: (item) => void draftPersistence.take(item, key),
            onCopy: (item) => window.herdrDesktop.copyText(item.text),
            onDiscard: (item) => void draftPersistence.discard(item),
          })}
      {floating && row.isAgent ? <RunningStrip host={host} row={row} /> : null}
      <div className="cmp">
        {chips.length === 0 && lost.length === 0 ? null : (
          <div className="atts">
            {chips.map((chip) => (
              <div key={chip.id} className={`att ${chip.image ? "img" : "file"} ${chip.state.kind}`} title={chipTitle(chip)}>
                {chip.image ? (
                  chip.preview === null ? (
                    <span className="ph">
                      <ImageIcon size={16} />
                    </span>
                  ) : (
                    <img src={chip.preview} alt={chip.name} draggable={false} />
                  )
                ) : (
                  <span className="nm">
                    <FileIcon size={14} />
                    {chip.name}
                  </span>
                )}
                {chipStatus(chip) === null || (chip.image && retries(chip)) ? null : <span className="st">{chipStatus(chip)}</span>}
                {retries(chip) ? (
                  <button className="rt" aria-label={`Retry ${chip.name}`} title={`${chipTitle(chip)}. Retry`} onClick={() => composerDrafts.retryChip(key, chip.id)}>
                    Retry
                  </button>
                ) : null}
                <button
                  className="x"
                  aria-label={`Remove ${chip.name}`}
                  title={`Remove ${chip.name}`}
                  disabled={(sending && !waiting) || chip.state.kind === "removing"}
                  onClick={() => composerDrafts.removeChip(key, chip.id)}
                >
                  <CloseIcon size={11} />
                </button>
              </div>
            ))}
            {lost.length === 0 ? null : (
              <div className="att-note" title="Only files already on the machine are kept with a draft">
                {`Not kept: ${lost.join(", ")} (${lost.length === 1 ? "it" : "they"} had not uploaded when the app closed)`}
              </div>
            )}
          </div>
        )}
        <textarea
          ref={box}
          rows={1}
          placeholder={boxAnswering !== null ? boxAnswering.placeholder : row.isAgent ? agentPlaceholder : offer !== null || row.exitedAgent !== undefined ? shellPlaceholder : `Type a command for ${row.name}`}
          value={text}
          autoFocus={overlay}
          onChange={(event) => {
            composerDrafts.edit(key, event.target.value);
            fit();
          }}
          onPaste={(event) => {
            // Text pastes as text (multi-line kept); an image or a copied file becomes a chip.
            if (!pasteTakesFiles(event.clipboardData)) return;
            event.preventDefault();
            void attachPasted(key, Array.from(event.clipboardData.files), window.herdrDesktop);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape" && overlay && onDismiss !== undefined) {
              event.preventDefault();
              onDismiss();
              return;
            }
            if (escStops(event)) {
              event.preventDefault();
              stopOrArm();
              return;
            }
            // Up in an empty box takes back your newest queued messages (Claude Code's own key for it).
            if (
              event.key === "ArrowUp" &&
              !event.metaKey &&
              !event.altKey &&
              !event.ctrlKey &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing &&
              text === "" &&
              chips.length === 0 &&
              takeBacks.under(key) === null &&
              takeBack(sayNoQueue(takeBackDeps, key))
            ) {
              event.preventDefault();
              return;
            }
            // Settings › Chat › Send presses Return (off: Return adds a line and ⌘Return sends).
            const keys = { key: event.key, shiftKey: event.shiftKey, metaKey: event.metaKey, ctrlKey: event.ctrlKey, altKey: event.altKey };
            if (returnSends({ ...keys, isComposing: event.nativeEvent.isComposing }, pressesReturn, macKeys)) {
              event.preventDefault();
              send();
            }
          }}
        />
        <div className="cmp-bar">
          <span className="chip agent" title={row.isAgent ? `The agent: ${agentName(row.kind)}` : "A shell"}>
            <AgentGlyph kind={row.kind} isAgent={row.isAgent} size={13} />
            <span className="ct">{agentName(row.kind, row.isAgent)}</span>
          </span>
          <AgentChips host={host} row={row} {...(onShowTerminal === undefined ? {} : { onShowTerminal })} />
          <span className="chip" title="The workspace">
            <FolderIcon size={13} />
            <span className="ct">{row.workspaceLabel}</span>
          </span>
          <span className="chip" title="The machine">
            <MonitorIcon size={13} />
            <span className="ct">{host.name}</span>
          </span>
          <span className="sp" />
          {/* The context ring, just left of the paperclip. */}
          <ContextRing host={host} row={row} />
          {/* The paperclip opens the picker. */}
          <button className="cmp-ib" aria-label="Attach files" title="Attach images or files" onClick={() => picker.current?.click()}>
            <PaperclipIcon />
          </button>
          <input
            ref={picker}
            type="file"
            multiple
            accept={pickerAccept}
            hidden
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              event.target.value = "";
              void attachFiles(key, files);
            }}
          />
          {showStop ? (
            <button className={stopping ? "send stop busy" : "send stop"} onClick={stop} aria-label="Stop" aria-busy={stopping} title={stopping ? "Stopping…" : "Stop (Esc)"}>
              {stopping ? <span className="stop-spin" /> : <span className="stop-sq" />}
            </button>
          ) : (
            <button className={canSend ? "send on" : "send off"} onClick={send} aria-label="Send" title={sendButtonTitle(pressesReturn, macKeys)}>
              <SendIcon size={15} />
            </button>
          )}
        </div>
      </div>
      {noteLine === null ? null : (
        <div className="cmp-note" role="status">
          <span className="cmp-note-t">{noteLine.text}</span>
          <button className="cmp-note-x" aria-label="Dismiss" title="Dismiss" onClick={noteLine.dismiss}>
            <CloseIcon size={10} />
          </button>
        </div>
      )}
    </div>
  );
}

export interface MainPaneProps {
  readonly host: HostView;
  readonly row: SidebarRow;
  readonly tab: MainTab;
  onTab(tab: MainTab): void;
  readonly mac: boolean;
  /** The terminal's text size, kept per window. */
  readonly fontSize: number;
  /** The message box over the terminal. */
  readonly boxShown: boolean;
  onBoxShown(shown: boolean): void;
  /** Open in Ghostty for this pane: hidden when Ghostty is not installed; greyed, with the reason, when it cannot open. */
  readonly ghostty: GhosttyAvailability;
  onOpenInGhostty(): void;
  /** Herdr has this pane zoomed in its tab. */
  readonly zoomed?: boolean;
  /** The quiet line under the header (a tab with more panes than the main area shows). */
  readonly note?: string | null;
  /** The split menu at the header's Split button; no button without it. */
  onSplitMenu?(x: number, y: number): void;
  /** Ends Herdr's zoom: the Zoomed chip becomes its button. */
  onUnzoom?(): void;
  /**
   * What More is about, taken when it opens (the pane's binding and the name shown); Close pane
   * and Rename… get it, so a pane changed or a machine reconnected while it was open is refused (null: not listed).
   */
  menuContext?(): PaneMenuContext | null;
  /** More's Close pane (the window's close: asked first for a working agent), with More's context. */
  onClose?(kept?: PaneMenuContext | null): void;
  /** More's Rename… (the field opens on the pane's sidebar row), with More's context. */
  onRename?(kept?: PaneMenuContext | null): void;
  /** An agent pane's terminal drawer (its header button, the drawer under the view); none on a shell. */
  readonly drawer?: DrawerView | null;
}

export function MainPane(props: MainPaneProps) {
  const { host, row, tab: picked, onTab, mac, fontSize, boxShown, onBoxShown, ghostty, onOpenInGhostty, zoomed = false, note = null, onSplitMenu, onUnzoom, onClose, onRename, menuContext } = props;
  const drawer = row.isAgent ? (props.drawer ?? null) : null;
  // Changes is an agent pane's; a plain shell shows its terminal (always, with no switch).
  const tab = shownTab(picked, row.isAgent);
  // The Resume chip over the terminal while its box is hidden: a tap brings the box up holding the command.
  const offer = useResumeOffer(host, row);
  // Restart, from the Update ready card and the header's menu.
  const restart = useRestart(host, row);
  const [moreMenu, setMoreMenu] = useState<{ x: number; y: number; kept: PaneMenuContext | null | undefined } | null>(null);
  // More is about the pane it opened on: another pane shown closes it.
  useEffect(() => setMoreMenu(null), [host.id, row.paneID]);
  // Hiding the box gives the terminal the keyboard back: one handoff for every
  // way it hides (the button, Escape, ⇧⌘T and the View menu, an app command).
  const [focusSignal, setFocusSignal] = useState(0);
  const wasShown = useRef(boxShown);
  useEffect(() => {
    if (wasShown.current && !boxShown) setFocusSignal((n) => n + 1);
    wasShown.current = boxShown;
  }, [boxShown]);
  const showBox = (shown: boolean): void => onBoxShown(shown);
  // The floating box's height: the chat keeps its end clear by it.
  const [boxHeight, setBoxHeight] = useState(0);
  const boxKey = mac ? "⇧⌘T" : "Ctrl+Shift+T";
  // More on every pane, agent or shell, in Chat, Terminal and Changes: Rename…, Restart (an agent's, as
  // before) and Close pane; Rename… and Close pane greyed with the reason while the machine does not answer.
  const offline = host.state === "connected" ? null : notAnswering(host.name);
  const moreItems: MenuItem[] = [
    ...(onRename === undefined
      ? []
      : [
          {
            label: "Rename…",
            disabledReason: offline,
            onSelect: () => {
              setMoreMenu(null);
              onRename(moreMenu?.kept);
            },
          },
        ]),
    ...(row.isAgent
      ? [
          {
            label: restartMenuLabel,
            disabledReason: restart.disabledReason,
            onSelect: () => {
              setMoreMenu(null);
              restart.run();
            },
          },
        ]
      : []),
    ...(onClose === undefined
      ? []
      : [
          {
            label: "Close pane",
            disabledReason: offline,
            onSelect: () => {
              setMoreMenu(null);
              onClose(moreMenu?.kept);
            },
          },
        ]),
  ];
  return (
    <main className="main">
      <div className="mh">
        {/* T3 Code's breadcrumb: the project, then the agent. */}
        <span className="crumb" title={`${row.workspaceLabel} / ${row.name}`}>
          <span className="proj">{row.workspaceLabel}</span>
          <span className="sl">/</span>
          <span className="nm">{row.name}</span>
        </span>
        {/* Right after the crumb's last part, the agent's name. */}
        {row.updateReady === true ? (
          <UpdateMark card kind={row.kind} restart={{ label: restartCardLabel, disabledReason: restart.disabledReason, onRestart: restart.run }} />
        ) : null}
        <span className={row.glyph === "needsYou" ? "stt ny" : "stt"}>
          <Glyph glyph={row.glyph} />
          {statusLabel[row.glyph]}
        </span>
        <span className="path">{shortPath(row.cwd)}</span>
        {zoomed && onUnzoom !== undefined ? (
          <button className="zoomed-chip" title="Zoomed in Herdr: show the tab's panes again" onClick={onUnzoom}>
            Zoomed · Unzoom
          </button>
        ) : zoomed ? (
          <span className="zoomed-chip">Zoomed</span>
        ) : null}
        <span className="sp" />
        {onSplitMenu === undefined ? null : (
          <button
            className="ib"
            title="Split"
            aria-label="Split"
            onClick={(event) => {
              const box = event.currentTarget.getBoundingClientRect();
              onSplitMenu(box.left, box.bottom + 4);
            }}
          >
            <SplitIcon size={16} />
          </button>
        )}
        {ghostty.shown ? (
          <button
            className={ghostty.enabled ? "ib" : "ib off"}
            title={ghostty.enabled ? "Open in Ghostty" : `Open in Ghostty: ${ghostty.reason}`}
            aria-label="Open in Ghostty"
            aria-disabled={!ghostty.enabled}
            onClick={() => {
              if (ghostty.enabled) onOpenInGhostty();
            }}
          >
            <ExternalIcon size={16} />
          </button>
        ) : null}
        {tab === "terminal" ? (
          <button
            className={boxShown ? "ib on" : "ib"}
            title={boxShown ? `Hide the message box (${boxKey})` : `Show the message box (${boxKey})`}
            aria-pressed={boxShown}
            onClick={() => showBox(!boxShown)}
          >
            <MessageBoxIcon size={16} />
          </button>
        ) : null}
        {drawer === null ? null : (
          <button
            className={drawer.state.open ? "ib on tdr-btn" : "ib tdr-btn"}
            title={`${drawer.state.open ? `Hide the terminal (${mac ? "⌘J" : "Ctrl+J"})` : `Terminal: a shell in ${drawer.folder === null ? "the machine's home folder" : shortPath(drawer.folder)} (${mac ? "⌘J" : "Ctrl+J"})`}${drawer.needsYou === true ? " · a shell needs you" : ""}`}
            aria-label="Terminal drawer"
            aria-pressed={drawer.state.open}
            data-drawer-toggle=""
            onClick={drawer.onToggle}
          >
            <TerminalDrawerIcon size={16} />
            {/* A drawer shell needs you (the sidebar leaves drawer shells out). */}
            {drawer.needsYou === true ? <span className="tdr-ny" aria-hidden="true" /> : null}
          </button>
        )}
        {moreItems.length > 0 ? (
          <button
            className="ib"
            title="More"
            aria-label="More"
            aria-haspopup="menu"
            data-more="pane"
            onClick={(event) => {
              const box = event.currentTarget.getBoundingClientRect();
              setMoreMenu({ x: box.left, y: box.bottom + 4, kept: menuContext?.() });
            }}
          >
            <MoreIcon size={16} />
          </button>
        ) : null}
        {/* Chat · <the agent's own name> · Changes; a plain shell has no switch. */}
        {row.isAgent ? (
          <div className="seg sm three agent-seg">
            <button className={tab === "chat" ? "on" : ""} onClick={() => onTab("chat")}>
              <ChatIcon />
              Chat
              {/* An early kind's Chat tab says Early (supported kinds show nothing new). */}
              <ChatEarlyBadge kind={row.kind} />
            </button>
            <button className={tab === "terminal" ? "on" : ""} title={agentScreenTitle(row.kind)} onClick={() => onTab("terminal")}>
              <TerminalIcon />
              <span className="seg-t">{agentOwnName(row.kind)}</span>
            </button>
            <button className={tab === "changes" ? "on" : ""} title={mac ? "Changes (⌃⌘C)" : "Changes (Ctrl+Alt+C)"} onClick={() => onTab("changes")}>
              <ChangesIcon />
              Changes
            </button>
          </div>
        ) : null}
      </div>
      {note === null ? null : <div className="split-note">{note}</div>}
      {restart.note === null || tab === "chat" ? null : (
        <div className="split-note restart-note" role="status">
          {restart.note}
        </div>
      )}
      {moreMenu === null ? null : (
        <ContextMenu
          x={moreMenu.x}
          y={moreMenu.y}
          items={moreItems}
          onClose={() => setMoreMenu(null)}
        />
      )}
      {tab === "changes" ? (
        <ChangesView
          bridge={window.herdrDesktop}
          hostId={host.id}
          paneId={row.paneID}
          kind={row.kind}
          folder={row.cwd ?? null}
          working={row.status === "working"}
          online={host.state !== "offline"}
          session={agentSessionKey(host.topology, row.paneID)}
        />
      ) : tab === "terminal" ? (
        <div className="term-area">
          <TerminalTab key={`${host.id}/${row.paneID}`} host={host} row={row} fontSize={fontSize} focusSignal={focusSignal} />
          {boxShown ? <Composer host={host} row={row} overlay onDismiss={() => showBox(false)} /> : null}
          {!boxShown && offer !== null ? (
            <ResumeChip
              offer={offer}
              boxEmpty={composerDrafts.get(draftKey(host.id, row.paneID)).text === ""}
              floating
              onFill={() => {
                fillResume(host.id, row.paneID, offer);
                showBox(true);
              }}
            />
          ) : null}
        </div>
      ) : (
        <div className="chat-area">
          <ChatView key={`${host.id}/${row.paneID}`} host={host} row={row} onShowTerminal={() => onTab("terminal")} bottomInset={boxHeight} />
          <Composer host={host} row={row} floating stops onHeight={setBoxHeight} onShowTerminal={() => onTab("terminal")} />
        </div>
      )}
      {drawer === null || !drawer.state.open ? null : <TerminalDrawer host={host} drawer={drawer} fontSize={fontSize} mac={mac} />}
    </main>
  );
}

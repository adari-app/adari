// The Chat tab: the open pane's transcript as T3-style rows.
// Your messages are bubbles on the right (pictures as thumbnails, a click opens
// one full size); the agent's
// replies are markdown (code blocks with their language, Wrap and Copy, in
// syntax colours); tool calls are quiet rows, a finished turn's folded into one
// line that opens; progress updates show between them; a finished turn ends
// with a quiet "Worked for 1m 8s  3:09 PM" row. The view follows the newest message while it
// is at the bottom; scrolled up, new messages show a "↓ New" button. Load
// earlier at the top reads back through the transcript. Copy is in the
// context menu. What you sent shows at once as a pending bubble until the
// transcript has it. Files dropped on it go to the pane's message box as
// chips.

import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ReactElement } from "react";

import type { ChatViewState, HostView } from "../../shared/ipc-contract";
import {
  attachmentFileName,
  attachmentIsImage,
  compactDuration,
  emptyTimeline,
  noticeRowText,
  noticeText,
  rowID,
  runningSubagents,
  turnFooter,
  turnRows,
  workedForText,
  workingAgentsText,
  workingSince,
  type ChatAttachment,
  type ChatImageBlob,
  type ChatItem,
  type ChatTimeline,
  type ChatTurn,
} from "../../shared/chat/model";
import { droppedText, pendingLabel, placePending, withoutTakenBack, type PendingMessage } from "../../shared/chat/pending";
import { putBackInBox } from "./esc-back";
import { ChatAttachmentText } from "../../shared/chat/tools";
import type { HandoffKind, HandoffSource } from "../../shared/handoff";
import type { SidebarRow } from "../../shared/sidebar-model";
import type { WideInt } from "../../shared/wide-int";
import { ContextMenu, type MenuItem } from "../components/ContextMenu";
import { dragOverFiles, dropFiles } from "../components/attachments";
import { composerDrafts, draftKey, localPictures } from "../components/composer-drafts";
import { ArrowDownIcon, CheckIcon, CopyIcon, FileIcon, ImageIcon, SparkIcon } from "../icons";
import { handoffStore } from "../handoff/handoff-state";
import { selectionHandoffKind } from "../handoff/selection";
import { chatSends, chatUpdates, pendingBackstop, pendingMessages, subscribePending } from "./chat-state";
import { shownTimeline } from "./running-strip";
import { agentPicks } from "../components/agent-picks";
import { commandRows } from "./command-rows";
import { Markdown, type SendCode } from "./Markdown";
import { revealRequests, useReveal } from "../search/reveal";
import { FoldedRow, ToolRow } from "./ToolRows";
import { AgentMessageRow, SubagentsRow } from "./SubagentRows";
import { useEscapeOwner } from "../components/escape-owners";
import { stopBindingOf, stopPossible } from "../../shared/agent-stop";
import { queuedSends, sayNoQueue, takeBackDeps, takeBacks } from "./take-back";
import { agentName } from "../components/agent-kind";
import { escTurns, turnEpisodeOf } from "../components/agent-stop";
import { NeedsCard, needsCardShown } from "./NeedsCard";
import { needsCards } from "./needs-card-store";
import { liveRows } from "./live-rows";
import { ChatFollowGate, chatScrollOutcome, classicScrollbar, editableTarget, scrollbarHit, scrollsUpKey } from "./follow-gate";
import { chatEarlyText } from "../../shared/chat/kinds";
import { chatUnreadLine } from "../../shared/chat/unread";
import { pendingToolCalls } from "../../shared/prompt/subject";
import { readerKind } from "../../shared/agent-names";
import { codexNoDaemonFlag, codexNoSessionText, codexOtherFolderText } from "../../shared/chat/codex-header";
import { integrationTargetOf } from "../../shared/integrations";
import { ChatIntegration, chatIntegrationLook, useIntegrationNote } from "../components/integrations";
import { restartResumes } from "../components/restart-view";
import { startScreenOf, startScreenTexts } from "../../shared/prompt/start-screen";

/** Within this many pixels of the end counts as at the bottom. */
const bottomSlack = 48;

const unavailableText: Record<Extract<ChatViewState, { status: "unavailable" }>["reason"], string> = {
  notAgent: "A shell has no chat. Its terminal shows what it does.",
  noSession: "Herdr names no session for this agent yet, so there is no transcript to show.",
  notFound: "No transcript was found for this agent's session.",
  unreadable: "The transcript could not be read over SSH.",
  unrecognisedFormat: "This transcript is not in a format Chat reads.",
  sessionMismatch: "The session Herdr gave this pane belongs to another folder, so it is not shown.",
  noAccess: "Chat cannot read transcripts on this machine yet.",
  ambiguousSession: "Two Grok sessions are open in this folder, so Chat can't tell which is this pane's.",
  ambiguousCursorSession: "Two Cursor sessions are open in this folder, so Chat can't tell which is this pane's.",
  ambiguousPiSession: "Two Pi sessions are open in this folder, so Chat can't tell which is this pane's.",
  ambiguousOmpSession: "Two omp sessions are open in this folder, so Chat can't tell which is this pane's.",
  ambiguousOpenCodeSession: "Two OpenCode sessions are open in this folder, so Chat can't tell which is this pane's.",
  ambiguousKiloSession: "Two Kilo sessions are open in this folder, so Chat can't tell which is this pane's.",
  ambiguousGeminiSession: "Two Gemini sessions are open in this folder, so Chat can't tell which is this pane's.",
  ambiguousQwenSession: "Two Qwen sessions are open in this folder, so Chat can't tell which is this pane's.",
  ambiguousCopilotSession: "Two Copilot sessions are open in this folder, so Chat can't tell which is this pane's.",
  ambiguousDroidSession: "Two Droid sessions are open in this folder, so Chat can't tell which is this pane's.",
  ambiguousKimiSession: "Two Kimi sessions are open in this folder, so Chat can't tell which is this pane's.",
  // Two Maki panes in one folder.
  ambiguousMakiSession: "Two Maki sessions are open in this folder, so Chat can't tell which is this pane's.",
  ambiguousClineSession: "Two Cline sessions are open in this folder, so Chat can't tell which is this pane's.",
  ambiguousKiroSession: "Two Kiro sessions are open in this folder, so Chat can't tell which is this pane's.",
  // As core-pane-session.ts words them (claudeAmbiguousNote, codexAmbiguousNote).
  ambiguousClaudeSession: "Two Claude sessions are open in this folder, so Chat can't tell which is this pane's.",
  ambiguousCodexSession: "Two Codex sessions are open in this folder, so Chat can't tell which is this pane's.",
  // Said with the folder (chatUnavailableLine); this is its line when the folder is not known.
  codexOtherFolder: "Herdr names a Codex session from another folder for this agent, so it is not shown. Restart Codex from Adari to give it its own.",
};

/**
 * The line Chat shows for an unavailable state of a pane running `kind`: a Codex session from
 * another folder names that folder; a Codex pane with no session adds why (Codex's shared background server).
 * Every other state and kind keeps its line.
 */
export function chatUnavailableLine(state: Extract<ChatViewState, { status: "unavailable" }>, kind: string | null | undefined): string {
  if (state.reason === "codexOtherFolder" && state.folder !== undefined) return codexOtherFolderText(state.folder);
  const line = unavailableText[state.reason];
  if (state.reason === "noSession" && kind !== null && kind !== undefined && readerKind(kind) === "codex") return `${line} ${codexNoSessionText}`;
  return line;
}

/**
 * An unavailable line as Chat shows it, with `--no-daemon` in a no-wrap span (chat.css
 * `.chat-nowrap`) so the flag never breaks across lines at its hyphens. The text stays plain ASCII, so a copied line
 * still holds a flag Codex takes.
 */
export function ChatUnavailableLine({ line }: { readonly line: string }): ReactElement {
  const parts = line.split(codexNoDaemonFlag);
  return (
    <div>
      {parts.map((part, index) => (
        <Fragment key={index}>
          {index > 0 ? <span className="chat-nowrap">{codexNoDaemonFlag}</span> : null}
          {part}
        </Fragment>
      ))}
    </div>
  );
}

/** "Working for 2m 18s"; with the pane's subagents running, "Working for 2m 18s · 2 agents". */
/**
 * When the Working line counts from (seconds): the
 * running turn's start, else when Herdr's status became working, else when the
 * view first saw it working.
 */
export function workingStart(turnStart: number | null, statusSinceUnixMs: WideInt | undefined, firstSeen: number): number {
  if (turnStart !== null) return turnStart;
  if (statusSinceUnixMs !== undefined) return Number(statusSinceUnixMs) / 1_000;
  return firstSeen;
}

/** The Working row from an Esc's press until the turn ends (no counter, no "Esc to stop"). */
export const stoppingText = "Stopping…";

export function workingLine(since: number, now: number, agents: number): string {
  const line = `Working for ${compactDuration(Math.max(0, now - since))}`;
  const running = workingAgentsText(agents);
  return running === null ? line : `${line} · ${running}`;
}

function clockTime(seconds: number): string {
  return new Date(seconds * 1_000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function useNow(active: boolean, intervalMs = 1_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs]);
  return now;
}

const images = new Map<string, Promise<string | null>>();

/** The chat a message's inline picture is asked of: its machine and slot (none: the one pane view's). */
export interface PicturePlace {
  readonly hostId: string;
  readonly slot?: string;
}

/**
 * The inline pictures fetched in this window, kept for a show again by their characters (data URL
 * and key; one byte each), the least recently shown going first; one being fetched counts once it has come; a
 * chat's go when it closes (forgetBlobPictures). 64 MiB keeps several screens of a long image-heavy chat (a
 * Retina screenshot is 0.3 to 7 MB of base64, the largest allowed 16 MiB) for a scroll back without asking main;
 * main keeps its own 32 MiB while the chat's feed is kept, so one asked again here costs no read over the link.
 * The pictures by path (`images`) are not counted here.
 */
export const blobPictureBudget = 64 * 1_024 * 1_024;
const blobPictures = new Map<string, { readonly request: Promise<string | null>; bytes: number }>();
let blobPictureBytes = 0;

const blobPlaceKey = (hostId: string, slot: string | undefined): string => `blob:${JSON.stringify([hostId, slot ?? ""])}\n`;

/** An inline picture's key here: its chat (machine and slot) and its reference. */
const blobPictureKey = (place: PicturePlace, blob: ChatImageBlob): string => blobPlaceKey(place.hostId, place.slot) + JSON.stringify(blob);

/** The picture for `key`, asked once (kept within the budget; a failed ask is not kept). */
function blobPicture(key: string, ask: () => Promise<string | null>): Promise<string | null> {
  const kept = blobPictures.get(key);
  if (kept !== undefined) {
    // Shown again: the newest.
    blobPictures.delete(key);
    blobPictures.set(key, kept);
    return kept.request;
  }
  const made: { readonly request: Promise<string | null>; bytes: number } = { request: ask().catch(() => null), bytes: 0 };
  blobPictures.set(key, made);
  void made.request.then((url) => {
    // Let go meanwhile (its chat closed, or trimmed): nothing to count.
    if (blobPictures.get(key) !== made) return;
    if (url === null) {
      blobPictures.delete(key);
      return;
    }
    made.bytes = key.length + url.length;
    blobPictureBytes += made.bytes;
    for (const [other, entry] of blobPictures) {
      if (blobPictureBytes <= blobPictureBudget) break;
      if (other === key) continue;
      blobPictures.delete(other);
      blobPictureBytes -= entry.bytes;
    }
  });
  return made.request;
}

/** The inline pictures of a chat that closed (its machine and slot) go. */
export function forgetBlobPictures(hostId: string, slot: string | undefined): void {
  const prefix = blobPlaceKey(hostId, slot);
  for (const [key, entry] of Array.from(blobPictures)) {
    if (!key.startsWith(prefix)) continue;
    blobPictures.delete(key);
    blobPictureBytes -= entry.bytes;
  }
}

/** The picture shown full size over the window (a thumbnail clicked), as Quick Look shows it. */
export interface OpenPicture {
  readonly url: string;
  readonly name: string;
}

class PictureViewerStore {
  private current: OpenPicture | null = null;
  private readonly listeners = new Set<() => void>();
  get = (): OpenPicture | null => this.current;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private set(next: OpenPicture | null): void {
    this.current = next;
    for (const listener of this.listeners) listener();
  }
  open(picture: OpenPicture): void {
    this.set(picture);
  }
  close(): void {
    if (this.current !== null) this.set(null);
  }
}

export const pictureViewer = new PictureViewerStore();

/**
 * One picture of a message: one you sent from this Mac shows from its local
 * copy (composer-drafts localPictures); any other is read back from the
 * machine (only a path a message in the open chat carries). Click opens it full size.
 */
export function Thumb({ attachment, place = null }: { attachment: ChatAttachment; place?: PicturePlace | null }) {
  const path = attachment.path;
  const local = path === null ? undefined : localPictures.get(path);
  // A pasted picture a relay read left out is fetched on show by its
  // reference (its frame until it comes); the key is the reference's text, so the effect runs once per picture.
  // Asked of its chat (machine and slot), and kept by it: the same file coordinates on another
  // machine are another picture. No chat: its frame.
  const blob = attachment.blob;
  const blobKey = path === null && blob !== undefined && place !== null ? blobPictureKey(place, blob) : null;
  const key = path ?? blobKey;
  // The picture shown is its reference's: another reference (or none) shows its frame until its
  // own comes.
  const [fetched, setFetched] = useState<{ readonly key: string; readonly url: string } | null>(null);
  const url = local ?? (fetched !== null && fetched.key === key ? fetched.url : null);
  useEffect(() => {
    if (key === null) return;
    if (path !== null && localPictures.get(path) !== undefined) return;
    let live = true;
    let request: Promise<string | null>;
    if (path !== null) {
      const asked = images.get(path);
      request = asked ?? window.herdrDesktop.chatImage(path).catch(() => null);
      if (asked === undefined) images.set(path, request);
    } else request = blobPicture(key, () => window.herdrDesktop.chatBlobImage(blob!, place!.hostId, place!.slot));
    void request.then((value) => {
      // A late answer (the reference changed, the row went) changes nothing.
      if (live && value !== null) setFetched({ key, url: value });
      if (value === null && path !== null) images.delete(path);
    });
    return () => {
      live = false;
    };
    // The blob and its chat are the same while the key is.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const name = attachmentFileName(attachment) ?? "Picture";
  return (
    <button
      className="thumb"
      title={path ?? "A picture pasted into the message"}
      aria-label={`Open ${name}`}
      onClick={() => {
        if (url !== null) pictureViewer.open({ url, name });
      }}
    >
      {url === null ? (
        <div className="ph">
          <ImageIcon size={18} />
        </div>
      ) : (
        <img src={url} alt={name} draggable={false} />
      )}
    </button>
  );
}

/** The open picture, full size over the window; a click or Escape closes it. */
export function PictureViewer() {
  const picture = useSyncExternalStore(pictureViewer.subscribe, pictureViewer.get);
  useEscapeOwner(picture !== null);
  useEffect(() => {
    if (picture === null) return;
    const onKey = (event: { key: string }): void => {
      if (event.key === "Escape") pictureViewer.close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [picture]);
  if (picture === null) return null;
  return (
    <div className="viewer" role="dialog" aria-label={picture.name} onClick={() => pictureViewer.close()}>
      <img src={picture.url} alt={picture.name} draggable={false} />
      <div className="viewer-name">{picture.name}</div>
    </div>
  );
}

/** A message's pictures (thumbnails) and files (named chips). */
function attachmentsView(attachments: readonly ChatAttachment[], place: PicturePlace | null = null): React.ReactNode {
  if (attachments.length === 0) return null;
  const pictures = attachments.filter(attachmentIsImage);
  const files = attachments.filter((attachment) => !attachmentIsImage(attachment));
  return (
    <>
      {pictures.length > 0 ? (
        <div className="thumbs">
          {pictures.map((attachment, index) => (
            <Thumb key={`${attachment.path ?? "inline"}-${index}`} attachment={attachment} place={place} />
          ))}
        </div>
      ) : null}
      {files.map((attachment, index) => (
        <div key={`${attachment.path ?? "file"}-${index}`} className="file-chip" title={attachment.path ?? undefined}>
          <FileIcon size={14} />
          {attachmentFileName(attachment) ?? "File"}
        </div>
      ))}
    </>
  );
}

/** The text Copy takes for an item. */
function itemText(item: ChatItem): string {
  switch (item.type) {
    case "user":
      return item.value.text;
    case "agentText":
    case "progress":
      return item.value.markdown;
    case "toolCall":
      return item.value.target;
    case "notice":
      return noticeText(item.value.kind);
    case "agents":
      return item.value.agents.map((agent) => agent.description).join("\n");
    case "agentMessage":
      return item.value.text;
  }
}

/** How long the check shows after a message's Copy. */
const copiedMs = 1_500;

/**
 * Copy under a message: faint until the pointer is over the message,
 * a check for a moment once copied.
 */
export function CopyMessage({ text, onCopy }: { text: string; onCopy(text: string): void }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );
  const copy = (): void => {
    onCopy(text);
    setCopied(true);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), copiedMs);
  };
  return (
    <div className="msg-tools">
      <button className={copied ? "msg-copy done" : "msg-copy"} onClick={copy} title="Copy message" aria-label={copied ? "Copied" : "Copy message"}>
        {copied ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
      </button>
    </div>
  );
}

/** What Send to… sends an item as (handoff): a reply, a progress update, your own message; null: no Send to…. */
function itemHandoff(item: ChatItem): HandoffKind | null {
  switch (item.type) {
    case "user":
      return item.value.text.trim() === "" ? null : { type: "ownMessage" };
    case "agentText":
      return { type: "reply" };
    case "progress":
      return { type: "progress" };
    case "toolCall":
    case "notice":
    case "agents":
      return null;
    case "agentMessage":
      return { type: "reply" };
  }
}

/** A row's menu: the text Copy takes and, when it has one, what Send to… sends it as. */
type OpenMenu = (event: React.MouseEvent, text: string, send?: HandoffKind | null) => void;

/** A cached row's handlers: nothing happens (no Copy, no menu). */
const ignoreCopy = (): void => undefined;
const ignoreMenu: OpenMenu = (event) => event.preventDefault();

interface RowProps {
  readonly item: ChatItem;
  onCopy(text: string): void;
  onMenu: OpenMenu;
  readonly onSendCode?: SendCode;
  /** The row's turn (a stop's row says how long it ran). */
  readonly turn?: ChatTurn;
  /** The chat its inline pictures are asked of (none: their frames). */
  readonly place?: PicturePlace | null;
}

export function ItemRow({ item, onCopy, onMenu, onSendCode, turn, place = null }: RowProps) {
  const menu = (event: React.MouseEvent): void => onMenu(event, itemText(item), itemHandoff(item));
  switch (item.type) {
    case "user":
      return (
        <div className="msg-u" onContextMenu={menu}>
          {attachmentsView(item.value.attachments, place)}
          {item.value.text === "" ? null : <div className="bubble">{item.value.text}</div>}
          {item.value.text === "" ? null : <CopyMessage text={item.value.text} onCopy={onCopy} />}
        </div>
      );
    case "agentText":
      return (
        <div className="msg-a" onContextMenu={menu}>
          <Markdown source={item.value.markdown} onCopy={onCopy} onSendCode={onSendCode} />
          <CopyMessage text={item.value.markdown} onCopy={onCopy} />
        </div>
      );
    case "progress":
      return (
        <div className="msg-p" onContextMenu={menu}>
          <span className="i">
            <SparkIcon size={13} />
          </span>
          <div className="t">
            <Markdown source={item.value.markdown} onCopy={onCopy} onSendCode={onSendCode} />
          </div>
        </div>
      );
    case "toolCall":
      return (
        <div onContextMenu={menu}>
          <ToolRow call={item.value} />
        </div>
      );
    case "notice":
      // In the chat's flow, at its place (never the app's toast). A stop says how long the turn ran.
      return <div className="chat-notice">{noticeRowText(item.value, turn ?? null)}</div>;
    case "agents":
      // The turn's subagents, one row; a report opens in the reply's style.
      return (
        <div onContextMenu={menu}>
          <SubagentsRow group={item.value} renderText={(text) => <ReplyText text={text} onCopy={onCopy} onMenu={onMenu} onSendCode={onSendCode} />} />
        </div>
      );
    case "agentMessage":
      return (
        <div onContextMenu={menu}>
          <AgentMessageRow message={item.value} renderText={(text) => <ReplyText text={text} onCopy={onCopy} onMenu={onMenu} onSendCode={onSendCode} />} />
        </div>
      );
  }
}

/**
 * A subagent's report or another session's message, drawn as a reply (markdown
 * and its Copy), with its own menu (its text, Send to…
 * as a reply), not the row's around it (a grouped report's row would copy the
 * agents' descriptions).
 */
function ReplyText({ text, onCopy, onMenu, onSendCode }: { text: string; onCopy(text: string): void; onMenu: OpenMenu; onSendCode?: SendCode }) {
  const menu = (event: React.MouseEvent): void => {
    event.stopPropagation();
    onMenu(event, text, { type: "reply" });
  };
  return (
    <div className="msg-a" onContextMenu={menu}>
      <Markdown source={text} onCopy={onCopy} onSendCode={onSendCode} />
      <CopyMessage text={text} onCopy={onCopy} />
    </div>
  );
}

/** One turn: its rows, then, once it is finished, T3's quiet "Worked for" row (the time it ended, a hairline). */
/**
 * The reply as it is written, read off the pane's screen
 * (live-rows.ts): its Markdown as the reply rows render it, marked live by a
 * small breathing dot in the margin (no height of its own, so the
 * transcript's row takes its place without a jump).
 */
export function LiveRow({ text, onCopy, onSendCode }: { text: string; onCopy(text: string): void; onSendCode?: SendCode }) {
  return (
    <div className="msg-a live" aria-label={`Writing now: ${text}`} data-chat-live="">
      <span className="live-dot" aria-hidden="true" />
      <Markdown source={text} onCopy={onCopy} onSendCode={onSendCode} />
    </div>
  );
}

/** One turn's rows; `live` (the last turn's): the reply being written, its last row before the footer. */
export function Turn({
  turn,
  onCopy,
  onMenu,
  onSendCode,
  live = null,
  place = null,
}: {
  turn: ChatTurn;
  onCopy(text: string): void;
  onMenu: OpenMenu;
  onSendCode?: SendCode;
  live?: string | null;
  place?: PicturePlace | null;
}) {
  const rows = turnRows(turn);
  const footer = turnFooter(turn);
  return (
    <div className="turn">
      {rows.map((row) => (
        <Fragment key={rowID(row)}>
          {/* Where a search result or an away card opens: the ids the next row shows (search/reveal.ts). */}
          <i className="chat-anchor" data-chat-ids={row.type === "folded" ? [row.folded.id, ...row.folded.calls.map((call) => call.id)].join(" ") : rowID(row)} />
          {row.type === "folded" ? <FoldedRow folded={row.folded} /> : <ItemRow item={row.item} onCopy={onCopy} onMenu={onMenu} onSendCode={onSendCode} turn={turn} place={place} />}
        </Fragment>
      ))}
      {live === null ? null : <LiveRow text={live} onCopy={onCopy} onSendCode={onSendCode} />}
      {footer === null ? null : (
        <div className="worked">
          <span className="worked-t">{workedForText(footer)}</span>
          <span className="worked-c">{clockTime(footer.end)}</span>
          <span className="worked-rule" />
        </div>
      )}
    </div>
  );
}

/** Your message as you sent it, until the transcript has it: your text without the upload paths, its pictures as thumbnails. */
export function PendingBubble({
  message,
  working,
  now,
  onMenu,
  onTakeBack,
}: {
  message: PendingMessage;
  working: boolean;
  now: number;
  onMenu: OpenMenu;
  /** Shown on a Claude bubble that says Queued (Herdr took it, the transcript does not have it): takes it back. */
  onTakeBack?: () => void;
}) {
  const label = pendingLabel(message, working, now);
  const shown = useMemo(() => ChatAttachmentText.extract(message.text), [message.text]);
  // A "Not sent" bubble: one tap puts its text back in the box.
  const notSent = message.state === "notSent";
  // A normal message at once; dimmed only while "Sending…", "Queued" or not sent.
  const waiting = notSent || label === "Sending…" || label === "Queued";
  const putBack = (): void => {
    const text = pendingMessages.takeNotSent(message.id);
    if (text !== null) putBackInBox(composerDrafts, (at, start) => handoffStore.expectLanding(at, start), message.key, text);
  };
  return (
    <div
      className={notSent ? "msg-u pending not-sent" : waiting ? "msg-u pending" : "msg-u"}
      data-pending={message.state}
      onContextMenu={(event) => onMenu(event, shown.text, shown.text.trim() === "" ? null : { type: "ownMessage" })}
      {...(notSent ? { role: "button", title: "Puts it back in the box", onClick: putBack } : {})}
    >
      {attachmentsView(shown.attachments)}
      {shown.text === "" ? null : <div className="bubble">{shown.text}</div>}
      {label === "" ? null : (
        <div className="pst">
          {label}
          {onTakeBack !== undefined && label === "Queued" && message.state === "sent" ? (
            <button className="pst-take" title="Takes it back into the box; Claude keeps working (Esc or Up does the same)" onClick={onTakeBack}>
              Take back
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}

function Earlier({ timeline, onLoad }: { timeline: ChatTimeline; onLoad(): void }) {
  switch (timeline.earlier) {
    case "none":
      return null;
    case "available":
      return (
        <div className="earlier">
          <button className="btn sm" onClick={onLoad}>
            Load earlier messages
          </button>
        </div>
      );
    case "loading":
      return <div className="earlier note">Loading earlier messages…</div>;
    case "failed":
      return (
        <div className="earlier note">
          Earlier messages could not be read.
          <button className="btn sm" onClick={onLoad}>
            Try again
          </button>
        </div>
      );
    case "capped":
      return <div className="earlier note">Showing the newest 2,000 messages.</div>;
  }
}

export interface ChatViewProps {
  readonly host: HostView;
  readonly row: SidebarRow;
  onShowTerminal(): void;
  /** The floating box's height: the column ends with that much room, so its last row clears the box. */
  readonly bottomInset?: number;
  /** A tile's Chat: its own feed in the main process; none for the one pane view. */
  readonly tile?: boolean;
  /** The needs-you card takes the keys (the one pane view, or the focused tile). */
  readonly keysActive?: boolean;
}

export function ChatView({ host, row, onShowTerminal, bottomInset = 0, tile = false, keysActive = true }: ChatViewProps) {
  const bridge = window.herdrDesktop;
  const key = draftKey(host.id, row.paneID);
  // A tile's feed is its pane's (a window shows a pane once); the one pane view's is the window's.
  const slot = tile ? key : undefined;

  // Registered with the page before its feed opens, unregistered (what it
  // showed dropped, late updates refused) before its slot closes below: the
  // page keeps only the updates of Chats on screen.
  useEffect(() => {
    chatUpdates.attach(bridge);
    liveRows.attach(bridge);
    const follow = chatUpdates.follow(host.id, row.paneID);
    bridge.openChat(host.id, row.paneID, slot, follow);
    return () => {
      chatUpdates.unfollow(host.id, row.paneID, follow);
      liveRows.left(host.id, row.paneID);
    };
  }, [bridge, host.id, row.paneID, slot]);
  useEffect(() => () => bridge.closeChat(slot), [bridge, slot]);
  // Its inline pictures are asked of this chat (machine and slot) and kept until it closes.
  const picturePlace = useMemo((): PicturePlace => ({ hostId: host.id, ...(slot === undefined ? {} : { slot }) }), [host.id, slot]);
  useEffect(() => () => forgetBlobPictures(host.id, slot), [host.id, slot]);
  // What Chat held for this pane is no baseline for sends made once it stopped following it.
  useEffect(() => () => pendingMessages.unfollow(key), [key]);

  const mine = useSyncExternalStore(chatUpdates.subscribe, () => chatUpdates.forPane(host.id, row.paneID));
  // An agent whose kind Chat doesn't read (kinds.ts) has no transcript here; its one plain line shows instead.
  const unread = chatUnreadLine(row.isAgent, row.kind);
  // An early kind's empty Chat says, in one plain line at its top, what its Early badge's title says.
  const early = row.isAgent ? chatEarlyText(row.kind) : null;
  const earlyLine = early === null ? null : <div className="chat-early-line">{early}</div>;
  const state: ChatViewState = unread !== null ? { status: "unavailable", reason: "noSession" } : (mine?.state ?? { status: "loading" });
  // No session named: nothing a send could be confirmed against (the backstop
  // never calls it Not sent), and, for a kind Chat reads, the cause when Herdr's integration for it is missing or old.
  const noSession = state.status === "unavailable" && state.reason === "noSession";
  const integrationNote = useIntegrationNote(host.id, integrationTargetOf(row.kind));
  // After an install, the agent's Restart only where it can work, else the steps.
  const integrationLook = noSession && unread === null ? chatIntegrationLook(host, row.kind, integrationNote, restartResumes(host, row.paneID), row.paneID) : null;
  // After an Esc went, "Stopping…" (no counter, no key hint) until a read shows Claude's working line
  // gone (the row goes, while Herdr still says working), Herdr says not working, or 5 s pass.
  useSyncExternalStore(escTurns.subscribe, escTurns.version);
  const herdrWorking = row.status === "working";
  const turnLook = escTurns.look(key, herdrWorking, turnEpisodeOf(host, row.paneID));
  const working = herdrWorking && turnLook !== "ended";
  const stoppingRow = working && turnLook === "stopping";
  const canStop = working && !stoppingRow && stopPossible({ isAgent: row.isAgent, status: row.status, online: host.state === "connected" });
  const raw = mine?.timeline ?? emptyTimeline;
  // A pane Herdr reports idle or done has no running turn, whatever the transcript's last line says.
  // A pane whose agent is gone ran its session out: nothing it started runs on (running-strip.ts's rule, the strip's too).
  const status = row.status;
  // Your messages Esc cancelled before any answer came back to the box: not shown.
  const takenBack = useSyncExternalStore(subscribePending, () => pendingMessages.takenBackFor(key));
  const timeline = useMemo(() => withoutTakenBack(shownTimeline(raw, status), takenBack), [raw, status, takenBack]);
  const pendingCalls = useMemo(() => pendingToolCalls(timeline), [timeline]);
  const pending = useSyncExternalStore(subscribePending, () => pendingMessages.forPane(key));
  // The backstop: idle or done 5 s, no queue on Claude's screen: a bubble still waiting turns "Not sent".
  // With no session named, a send Herdr took is "Sent to the terminal" instead.
  const isClaude = row.kind === "claude";
  useEffect(() => {
    pendingBackstop.watch(
      key,
      row.isAgent ? row.status : "",
      () => (isClaude && bridge.paneQueued !== undefined ? bridge.paneQueued(host.id, row.paneID) : Promise.resolve(null)),
      noSession,
    );
  }, [key, row.isAgent, row.status, pending, isClaude, bridge, host.id, row.paneID, noSession]);
  useEffect(() => () => pendingBackstop.stop(key), [key]);
  // A Queued bubble's Take back, in a Claude pane that works on a machine that answers: the
  // queued sends come back to the box (Up, then Ctrl+U in Claude's box), as Esc's first press or Up does.
  const takeBackShown = isClaude && row.isAgent && working && host.state === "connected" && bridge.takeBackQueued !== undefined;
  const takeBackBubble = (): void => {
    if (takeBacks.under(key) !== null) return;
    const terminalID = host.topology?.panes.find((pane) => pane.paneID === row.paneID)?.terminalID ?? "";
    void takeBacks
      .run(takeBackDeps, host.id, row.paneID, key, stopBindingOf(host, row.paneID, agentName(row.kind)), queuedSends(pendingMessages.forPane(key), terminalID))
      .then(sayNoQueue(takeBackDeps, key));
  };
  const dropped = useSyncExternalStore(subscribePending, () => pendingMessages.droppedFor(key));
  // With no running turn (only background agents left), from when Herdr says the pane began working, else from when this view first saw it working.
  const firstSeenWorking = useMemo(() => Date.now() / 1_000, [herdrWorking]);
  const since = workingStart(workingSince(timeline), row.statusSinceUnixMs, firstSeenWorking);
  // A Model or Effort pick the transcript confirmed, one quiet line in the turn it ends.
  useSyncExternalStore(agentPicks.subscribe, agentPicks.version);
  const confirmedPicks = agentPicks.confirmations(key, raw.turns.at(-1)?.id ?? null);
  // The command lines you typed, as small rows.
  useSyncExternalStore(commandRows.subscribe, commandRows.version);
  const commands = commandRows.forPane(key);
  // A half-second clock while a send is unconfirmed, so "Sending…" shows at 1.5 s.
  const now = useNow(working || pending.length > 0, pending.some((message) => message.state === "sending") ? 500 : 1_000);

  const copy = useCallback((text: string) => bridge.copyText(text), [bridge]);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  // Send to… (handoff): the text comes from this pane, as the sidebar names it.
  const source = useMemo<HandoffSource>(
    () => ({ hostId: host.id, paneId: row.paneID, name: row.name, kind: row.kind, workspace: row.workspaceLabel, macName: host.name }),
    [host.id, host.name, row.paneID, row.name, row.kind, row.workspaceLabel],
  );
  const sendTo = useCallback(
    (text: string, kind: HandoffKind, x: number, y: number) => handoffStore.openPicker({ text, kind, source }, x, y),
    [source],
  );
  const sendCode = useCallback<SendCode>((language, text, x, y) => sendTo(text, { type: "code", language }, x, y), [sendTo]);
  const openMenu = useCallback<OpenMenu>(
    (event, text, send = null) => {
      event.preventDefault();
      const selection = window.getSelection();
      const selected = selection?.toString() ?? "";
      const x = event.clientX;
      const y = event.clientY;
      const items: MenuItem[] =
        selected.trim() === ""
          ? [{ label: "Copy", onSelect: () => copy(text) }]
          : [
              { label: "Copy", onSelect: () => copy(selected) },
              { label: "Copy message", onSelect: () => copy(text) },
            ];
      if (send !== null) {
        // A selection in a reply goes as what it is (prose quoted, code fenced); the whole message as written.
        const selectionKind = selected.trim() === "" || send.type === "ownMessage" ? null : selectionHandoffKind(selection);
        if (selectionKind !== null) items.push({ label: "Send selection to…", onSelect: () => sendTo(selected, { type: "selection", selection: selectionKind }, x, y) });
        items.push({ label: "Send to…", onSelect: () => sendTo(text, send, x, y) });
      }
      setMenu({ x, y, items });
    },
    [copy, sendTo],
  );
  const closeMenu = useCallback(() => setMenu(null), []);
  // The launch cache's rows on show (catching up)
  // cannot be acted on until the live read confirms them: no Copy, Send to… or code send on a row.
  const confirmed = mine?.catchingUp !== true;
  const rowCopy = confirmed ? copy : ignoreCopy;
  const rowMenu = confirmed ? openMenu : ignoreMenu;
  const rowSendCode = confirmed ? sendCode : undefined;
  // The reply being written, over the transcript's own timeline (the merge's), until its text lands.
  const liveVersion = useSyncExternalStore(liveRows.subscribe, liveRows.version);
  const liveText = useMemo(() => liveRows.row(host.id, row.paneID, raw), [liveVersion, host.id, row.paneID, raw]);
  // The turns' elements, kept until the timeline changes: the working clock's
  // tick re-renders the chat once a second, and React skips the turns (no
  // markdown parsed again on the main thread while the chat scrolls).
  // The last turn's kept apart, as the live row (its last row) changes it.
  const earlierTurnRows = useMemo(
    () => timeline.turns.slice(0, -1).map((turn) => <Turn key={turn.id} turn={turn} onCopy={rowCopy} onMenu={rowMenu} onSendCode={rowSendCode} place={picturePlace} />),
    [timeline.turns, rowCopy, rowMenu, rowSendCode, picturePlace],
  );
  const finalTurn = timeline.turns.at(-1);
  const finalTurnRow = useMemo(
    () =>
      finalTurn === undefined ? null : (
        <Turn key={finalTurn.id} turn={finalTurn} onCopy={rowCopy} onMenu={rowMenu} onSendCode={rowSendCode} live={liveText} place={picturePlace} />
      ),
    [finalTurn, liveText, rowCopy, rowMenu, rowSendCode, picturePlace],
  );
  const plainTurnRows = useMemo(() => (finalTurnRow === null ? earlierTurnRows : [...earlierTurnRows, finalTurnRow]), [earlierTurnRows, finalTurnRow]);
  // A "Not sent" bubble stands at its place in time,
  // never below anything newer; those still waiting stay at the bottom.
  const pendingPlaces = useMemo(() => placePending(pending, timeline), [pending, timeline]);
  const turnRows = useMemo(() => {
    if (pendingPlaces.placed.size === 0) return plainTurnRows;
    const notSentAt = (at: number) =>
      (pendingPlaces.placed.get(at) ?? []).map((message) => <PendingBubble key={message.id} message={message} working={false} now={0} onMenu={openMenu} />);
    return [...plainTurnRows.flatMap((row, index) => [...notSentAt(index), row]), ...notSentAt(plainTurnRows.length)];
  }, [plainTurnRows, pendingPlaces, openMenu]);

  // Following the newest message.
  const scroller = useRef<HTMLDivElement>(null);
  const column = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const [hasNew, setHasNew] = useState(false);
  const earlierAnchor = useRef<{ height: number; top: number; first: string | null } | null>(null);
  const firstID = timeline.turns[0] === undefined ? null : timeline.turns[0].id;
  const lastTurn = timeline.turns.at(-1);
  // The live row coming is a new row, as a landed reply is.
  const endID = `${lastTurn?.id ?? ""}/${lastTurn?.items.at(-1)?.value.id ?? ""}/${pending.length}${liveText === null ? "" : "/live"}`;
  const lastEnd = useRef(endID);

  // Where the chat was scrolled when last seen (a scroll event, a pin): a scroll event that did not go up is not you leaving the end.
  const lastTop = useRef(0);
  // And how tall it was then: a scroll event after the content got shorter is a clamp, not you.
  const lastHeight = useRef(0);
  // Only your own wheel or key up, touch or scrollbar drag lets go of the newest (the T3 Code way).
  const [gate] = useState(() => new ChatFollowGate());
  const pinToBottom = useCallback(() => {
    const element = scroller.current;
    if (element === null) return;
    element.scrollTop = element.scrollHeight;
    lastTop.current = element.scrollTop;
    lastHeight.current = element.scrollHeight;
    // Our own scroll: what is left of your last gesture's window is not yours any more
    // (T3 holds its programmatic scrolls); a scrollbar drag still held stays yours.
    gate.revoke({ keepsHeldDrag: true });
  }, [gate]);

  const onWheel = useCallback((event: { deltaY: number; ctrlKey: boolean }) => gate.heard({ source: "wheel", deltaY: event.deltaY, ctrlKey: event.ctrlKey }, performance.now()), [gate]);
  const onTouchMove = useCallback(() => gate.heard({ source: "touch" }, performance.now()), [gate]);
  const onPointerDown = useCallback(
    (event: { target: unknown; currentTarget: unknown; clientX?: number }) => {
      // A press on the scroller itself (not a row) and in its scrollbar's own area, not the blank gutter.
      let onScrollbar = event.target === event.currentTarget;
      let candidate = false;
      const element = event.currentTarget as HTMLElement;
      // (A press with no position, a synthetic one, goes by its target alone.)
      if (onScrollbar && typeof event.clientX === "number" && typeof element.getBoundingClientRect === "function") {
        const rect = element.getBoundingClientRect();
        const box = {
          left: rect.left,
          width: rect.right - rect.left,
          clientLeft: element.clientLeft ?? 0,
          clientWidth: element.clientWidth,
          overflows: element.scrollHeight > element.clientHeight,
        };
        onScrollbar = scrollbarHit(event.clientX, box);
        // The overlay bar's strip may be the content under it: only a candidate,
        // its release gives the glide only once it moved the Chat up.
        candidate = !classicScrollbar(box);
      }
      gate.heard({ source: "pointerDown", onScrollbar, candidate }, performance.now());
    },
    [gate],
  );
  // A key on the page (after a click on a message's text) is the focused tile's; the
  // one pane view's Chat always has the keys.
  const keysActiveNow = useRef(keysActive);
  useEffect(() => {
    keysActiveNow.current = keysActive;
  }, [keysActive]);
  // The scroller's document hears your keys and the end of a scrollbar drag. Checked
  // after every commit, so a scroller that went away (the unavailable note) or was replaced is let go of
  // with its gesture: nothing you did to the old one carries over.
  const attached = useRef<{ readonly element: HTMLDivElement | null; readonly detach: () => void } | null>(null);
  useEffect(() => {
    const element = scroller.current;
    if (attached.current !== null && attached.current.element === element) return;
    attached.current?.detach();
    attached.current = null;
    gate.revoke();
    const page = element?.ownerDocument ?? null;
    if (element === null || page === null) {
      attached.current = { element, detach: () => undefined };
      return;
    }
    // Keys scroll the Chat with the focus in it, or on the page after a click on its text (T3 hears them app-wide).
    const onKey = (event: KeyboardEvent): void => {
      if (!scrollsUpKey(event.key, event.shiftKey)) return;
      const target = event.target;
      const inChat = target !== null && element.contains(target as Node);
      const onPage = target === null || target === page.body || target === page.documentElement;
      if (!inChat && !(onPage && keysActiveNow.current)) return;
      gate.heard({ source: "key", key: event.key, shiftKey: event.shiftKey, editable: editableTarget(target), composing: event.isComposing }, performance.now());
    };
    // Pointer-up gives a track click's animation its glide; a cancelled press or the window losing focus ends it all.
    const onPointerUp = (): void => {
      // The browser tells a scroll in a later frame, so a drag can move the Chat up and be
      // released before its event comes: the press navigated if the Chat already sits above where the last scroll
      // event or pin saw it, with no clamp after a shrink (onScroll's guard).
      if (element.scrollTop < lastTop.current && element.scrollHeight >= lastHeight.current) gate.movedUp();
      gate.heard({ source: "pointerUp" }, performance.now());
    };
    const onCancel = (): void => gate.revoke();
    const view = page.defaultView;
    page.addEventListener("keydown", onKey, true);
    page.addEventListener("pointerup", onPointerUp, true);
    page.addEventListener("pointercancel", onCancel, true);
    view?.addEventListener("blur", onCancel);
    attached.current = {
      element,
      detach: () => {
        page.removeEventListener("keydown", onKey, true);
        page.removeEventListener("pointerup", onPointerUp, true);
        page.removeEventListener("pointercancel", onCancel, true);
        view?.removeEventListener("blur", onCancel);
      },
    };
  });
  useEffect(
    () => () => {
      attached.current?.detach();
      attached.current = null;
      gate.revoke();
    },
    [gate],
  );

  const onScroll = useCallback(() => {
    const element = scroller.current;
    if (element === null) return;
    const wentUp = element.scrollTop < lastTop.current;
    const shrank = element.scrollHeight < lastHeight.current;
    lastTop.current = element.scrollTop;
    lastHeight.current = element.scrollHeight;
    // A press still held that moves the Chat up (no clamp) navigates:
    // its release gives the glide. A pin or a return to the end below revokes that again.
    if (wentUp && !shrank) gate.movedUp();
    const atEnd = element.scrollHeight - element.scrollTop - element.clientHeight < bottomSlack;
    const outcome = chatScrollOutcome({ following: following.current, atEnd, wentUp, shrank, own: gate.ownScroll(performance.now()) });
    if (outcome === "stay") return;
    if (outcome === "pin") {
      // A row grew under the end you follow before the browser delivered the
      // pin's scroll event (the Working line, a picture, the box's inset): you did not scroll away; stay at the end.
      // So does any move up you did not make (scroll anchoring, a clamp after a shrink).
      pinToBottom();
      setHasNew(false);
      return;
    }
    const bottom = outcome === "follow";
    // Back at the end, following again: the gesture that brought you there owns nothing more.
    if (bottom && !following.current) gate.revoke({ keepsHeldDrag: true });
    if (bottom !== following.current) {
      following.current = bottom;
      setAtBottom(bottom);
      bridge.setChatFollowing(bottom, slot);
    }
    if (bottom) setHasNew(false);
  }, [bridge, slot, pinToBottom, gate]);

  // You sent from this Chat's box (a message, pictures, a / command's row): to the
  // end and following again, wherever you were, the New pill gone. Load earlier's and a reveal's place give way.
  const sends = useSyncExternalStore(chatSends.subscribe, () => chatSends.count(key));
  const seenSends = useRef(sends);
  useLayoutEffect(() => {
    if (sends === seenSends.current) return;
    seenSends.current = sends;
    earlierAnchor.current = null;
    const reveal = revealRequests.peek(host.id, row.paneID);
    if (reveal !== null) revealRequests.take(reveal.serial);
    following.current = true;
    setAtBottom(true);
    setHasNew(false);
    // Following again on your send: no earlier gesture's window lets go.
    gate.revoke();
    bridge.setChatFollowing(true, slot);
    pinToBottom();
  }, [sends, host.id, row.paneID, bridge, slot, pinToBottom, gate]);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (element === null) return;
    const anchor = earlierAnchor.current;
    if (anchor !== null && anchor.first !== firstID) {
      // Earlier messages went in above: keep what was on screen where it was.
      element.scrollTop = element.scrollHeight - anchor.height + anchor.top;
      lastTop.current = element.scrollTop;
      lastHeight.current = element.scrollHeight;
      earlierAnchor.current = null;
    } else if (following.current) {
      pinToBottom();
    } else if (lastEnd.current !== endID) {
      setHasNew(true);
    }
    lastEnd.current = endID;
    // The live row grows as a reply is written: at the end while following.
  }, [timeline, endID, firstID, pinToBottom, liveText]);

  // The box grew or shrank: the end stays where it was on screen while following (no jump).
  useLayoutEffect(() => {
    if (following.current) pinToBottom();
  }, [bottomInset, pinToBottom]);

  // Pictures and code blocks change height after they render: stay at the bottom while following.
  useEffect(() => {
    const target = column.current;
    if (target === null) return;
    const observer = new ResizeObserver(() => {
      if (following.current) pinToBottom();
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, [pinToBottom]);

  const loadEarlier = useCallback(() => {
    const element = scroller.current;
    earlierAnchor.current = element === null ? null : { height: element.scrollHeight, top: element.scrollTop, first: firstID };
    void bridge.loadEarlierChat(slot);
  }, [bridge, firstID, slot]);

  // A search result or an away card opening this pane at a message (a UI command: it lets go on its own).
  // This chat's own feed is told (a tile's slot), as every other follow change.
  const stopFollowing = useCallback(() => {
    following.current = false;
    setAtBottom(false);
    bridge.setChatFollowing(false, slot);
  }, [bridge, slot]);
  const reveal = useReveal({
    hostId: host.id,
    paneId: row.paneID,
    timeline,
    chatLoading: state.status === "loading" || state.status === "idle",
    unavailable: state.status === "unavailable",
    scroller,
    loadEarlier,
    stopFollowing,
  });

  // Your sent messages and the quiet line, shown whether or not the transcript can be read.
  const sent = (
    <>
      {dropped > 0 ? <div className="chat-quiet">{droppedText(dropped)}</div> : null}
      {commands.map((command) => (
        <div key={command.id} className="cmd-row" title={command.state === "sent" ? "Sent as a command" : "Sending…"}>
          <span className="cmd">{command.text}</span>
          <span className="st">{command.state === "sent" ? "Command sent" : "Sending…"}</span>
        </div>
      ))}
      {confirmedPicks.map((line) => (
        <div key={line} className="chat-quiet pick-line">
          {line}
        </div>
      ))}
      {(state.status === "unavailable" ? pending : pendingPlaces.waiting).map((message) => (
        <PendingBubble key={message.id} message={message} working={working} now={now} onMenu={openMenu} {...(takeBackShown ? { onTakeBack: takeBackBubble } : {})} />
      ))}
    </>
  );

  // The needs-you card at the end of Chat, whatever the transcript shows.
  // With the running tool calls Chat shows (words for a question whose header is off screen).
  // Codex's hook review on the pane's screen: with no transcript, Chat's
  // line says it (the card would say it again); with one, the card does.
  const startScreen = startScreenOf(host, row.paneID);
  const card =
    startScreen !== null && state.status === "unavailable" ? null : (
      <NeedsCard host={host} row={row} onShowTerminal={onShowTerminal} keysActive={keysActive} pending={state.status === "unavailable" ? [] : pendingCalls} />
    );

  if (state.status === "unavailable") {
    const reason =
      unread !== null ? (
        <div className="chat-unread">{unread}</div>
      ) : startScreen !== null ? (
        <>
          <div className="chat-start" data-start-screen={startScreen.kind}>
            {startScreenTexts[startScreen.kind]}
          </div>
          <button className="btn sm" onClick={onShowTerminal}>
            Show the terminal
          </button>
        </>
      ) : integrationLook !== null ? (
        <ChatIntegration host={host} row={row} look={integrationLook} onShowTerminal={onShowTerminal} />
      ) : (
        <>
          <ChatUnavailableLine line={chatUnavailableLine(state, row.kind)} />
          <button className="btn sm" onClick={onShowTerminal}>
            Show the terminal
          </button>
        </>
      );
    const explanation = (
      <>
        {earlyLine}
        {reason}
      </>
    );
    if (pending.length === 0 && dropped === 0 && (card === null || !needsCardShown(row, needsCards.forPane(host.id, row.paneID)))) {
      return (
        <div className="chat" onDragOver={dragOverFiles} onDrop={(event) => dropFiles(key, event)}>
          <div className="chat-empty">{explanation}</div>
          <PictureViewer />
        </div>
      );
    }
    // The explanation on top, your sent messages under it.
    return (
      <div className="chat" onDragOver={dragOverFiles} onDrop={(event) => dropFiles(key, event)}>
        <div className="chat-scroll">
          <div className="chat-col">
            <div className="chat-empty in">{explanation}</div>
            {sent}
            {card}
            <div className="chat-inset" style={{ height: bottomInset }} />
          </div>
        </div>
        {menu === null ? null : <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={closeMenu} />}
        <PictureViewer />
      </div>
    );
  }

  const loading = state.status === "loading" || state.status === "idle";
  return (
    <div className="chat" onDragOver={dragOverFiles} onDrop={(event) => dropFiles(key, event)}>
      <div className="chat-scroll" ref={scroller} onScroll={onScroll} onWheel={onWheel} onTouchMove={onTouchMove} onPointerDown={onPointerDown}>
        <div className={mine?.catchingUp === true ? "chat-col catching" : "chat-col"} ref={column}>
          {/* An early kind's empty Chat (reading, or no messages yet): its one plain line, first. */}
          {timeline.turns.length === 0 ? earlyLine : null}
          {/* No Load earlier on the cached rows (the live read's own screenful reads back). */}
          {confirmed ? <Earlier timeline={timeline} onLoad={loadEarlier} /> : null}
          {/* The chat as it was last time, until the first read lands. */}
          {mine?.catchingUp === true ? <div className="chat-quiet">Catching up…</div> : null}
          {loading && timeline.turns.length === 0 ? <div className="chat-note">Reading the transcript…</div> : null}
          {!loading && timeline.turns.length === 0 && pending.length === 0 && liveText === null ? <div className="chat-note">No messages yet.</div> : null}
          {turnRows}
          {timeline.turns.length === 0 && liveText !== null ? <LiveRow text={liveText} onCopy={copy} onSendCode={sendCode} /> : null}
          {sent}
          {working ? (
            <div className="working">
              <span className="spin" />
              <span className="working-t">{stoppingRow ? stoppingText : workingLine(since, now / 1_000, runningSubagents(timeline))}</span>
              {/* The key hint while Stop is possible (its box's Esc or the Stop square). */}
              {canStop ? <span className="working-k">Esc to stop</span> : null}
            </div>
          ) : null}
          {card}
          <div className="chat-inset" style={{ height: bottomInset }} />
        </div>
      </div>
      {/* New lines below, or newer ones the feed holds back at the 2,000-item cap while you read earlier ones. */}
      {(!atBottom && hasNew) || timeline.newerWaiting ? (
        <button
          className="chat-new"
          style={{ bottom: bottomInset + 12 }}
          onClick={() => {
            following.current = true;
            setAtBottom(true);
            setHasNew(false);
            // Following again on New: no earlier gesture's window lets go.
            gate.revoke();
            bridge.setChatFollowing(true, slot);
            pinToBottom();
          }}
        >
          <ArrowDownIcon />
          New
        </button>
      ) : null}
      {reveal.note === null ? null : <div className="chat-reveal-note">{reveal.note}</div>}
      {menu === null ? null : <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={closeMenu} />}
      <PictureViewer />
    </div>
  );
}

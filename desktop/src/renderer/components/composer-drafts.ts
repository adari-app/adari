// The composer's drafts, one per pane per machine.
// A send carries a ticket for its own pane and the exact text it sent; when it
// completes it touches only that pane's draft: success clears the draft only if
// it is still exactly the text that was sent (anything typed meanwhile stays),
// failure keeps the text and shows the error on that pane. Another pane's draft,
// sending state and error are never affected.
//
// A draft also holds its attachments as chips; the
// message goes as the text with their paths after it (attachments.ts
// joinedMessage). A chip that uploaded keeps its
// path, so sending again after a failed send does not upload it again; a sent
// chip goes.
//
// The T3 way: each chip uploads as soon as it is attached, at most two at a
// time per machine (`concurrentUploads`), the rest waiting their turn as
// uploading chips. A chip shows uploading, then on the machine, or failed
// with Retry. Send with every chip on the machine goes at once. Send while a
// chip uploads waits for it (`waiting`, the note "Sends when the upload
// finishes." whose × lets it go and keeps the draft); an upload that fails
// meanwhile stops it, keeps the draft and the chip shows Retry. Send also
// starts a chip that failed again, as the Mac's Send always uploaded what was
// not on the machine.
//
// Remove (×): a chip waiting its turn leaves; one uploading stops (no request
// after it, and what it made goes); one on the machine is removed from there
// under one deadline (`removing`), and one whose removal failed or went
// silent stays with Retry (`cleanup`): a Send waiting meanwhile is refused
// rather than sent without knowing. Any removal running holds a Send as an
// upload does: one already under way at the press, and one
// started while it waits (× or Retry). A file another draft, a Kept draft or a
// Send that may have gone still names is never removed (the chip only). The
// pane's box going (its Chat left, another pane or machine, the window
// closing) lets a waiting Send go at once and sends nothing. A late upload or
// removal result only updates its own chip and never sends; one that landed
// for a chip already gone is removed again.
//
// Send empties the box on the press, the way T3
// Code does (the bubble shows at once, chat-state.ts sendWithPending), while
// the send runs. What the box shows from then on is only what you type next.
// A send that fails brings its text back with its note, first, then a newline
// and anything typed meanwhile (esc-back's putBackInBox rule). From the press
// to the result the text is the draft's `taken`, and the saved draft keeps it
// first (draft-persistence.ts draftInput), so a crash then does not lose it.

import { joinedMessage, maxResidentBytes } from "../../shared/attachments";
import { putBack } from "../../shared/claude-screen";
import type { HerdrDesktopBridge, UploadedAttachment } from "../../shared/ipc-contract";
import { uploadsStore } from "../settings/uploads-store";

/** What a picked, pasted or dropped file became, ready to upload. */
export interface AttachmentPayload {
  /** The name the chip shows (an image's with the extension it uploads as). */
  readonly name: string;
  /** The extension it uploads with (attachments.ts safeUploadExtension). */
  readonly extension: string;
  readonly image: boolean;
  readonly data: Uint8Array;
}

export type ChipState =
  /** Not uploading: nothing to upload with yet (Send starts it). */
  | { readonly kind: "ready" }
  /** Uploading, or waiting its turn to. */
  | { readonly kind: "uploading" }
  | { readonly kind: "uploaded"; readonly path: string }
  /** Retry uploads it again. */
  | { readonly kind: "failed"; readonly reason: string }
  /** × on it while on the machine: its removal from there runs. */
  | { readonly kind: "removing"; readonly path: string }
  /** Its removal failed or went silent: still on the machine; Retry removes it again. */
  | { readonly kind: "cleanup"; readonly path: string; readonly reason: string };

export interface AttachmentChip extends AttachmentPayload {
  readonly id: string;
  /** A picture of it for the chip (an object URL), or null. */
  readonly preview: string | null;
  readonly state: ChipState;
}

export interface Draft {
  readonly text: string;
  readonly sending: boolean;
  readonly error: string | null;
  readonly chips: readonly AttachmentChip[];
  /**
   * Files a restored draft had attached that had not
   * uploaded when the app closed (not kept), by name, for the chip row's note.
   */
  readonly lost: readonly string[];
  /**
   * The text of the send under way, out of the box since the
   * press (null: none). It comes back to the box if the send fails; until the
   * result the saved draft keeps it, before what is typed meanwhile.
   */
  readonly taken: string | null;
  /**
   * The Send pressed while its chips upload waits for them
   * (`sending` too); the note "Sends when the upload finishes." shows, and
   * its × lets the Send go, keeping the draft.
   */
  readonly waiting: boolean;
  /**
   * A `/compact` line you sent while Claude worked, held for the end
   * of the turn (agent-picks.ts holdTypedCompact): out of the box, still yours until it goes or comes back. The
   * saved draft keeps it first (draft-persistence.ts draftInput), so a reload, a quit or a crash before it goes
   * brings it back as text in the box (never sent again by itself). Null: none.
   */
  readonly held: string | null;
  /**
   * Held lines that did not go while the box held newer text, on their
   * way to the pane's Kept drafts (draft-persistence.ts keepHeld): still saved with the draft, oldest first, until
   * Kept drafts has each one (or it comes back into the box), so a line is at worst in both, never in neither.
   */
  readonly keeping: readonly string[];
}

export interface SendTicket {
  readonly key: string;
  readonly text: string;
  /** The chips that go with it, in the order attached. */
  readonly chips: readonly string[];
}

export const emptyDraft: Draft = { text: "", sending: false, error: null, chips: [], lost: [], taken: null, waiting: false, held: null, keeping: [] };

/** A chip that came back with a restored draft: already on the machine at `path` (no bytes here). */
export interface RestoredChip {
  readonly path: string;
  readonly name: string;
  readonly image: boolean;
}

export function draftKey(hostId: string, paneId: string): string {
  return `${hostId}/${paneId}`;
}

/** "mac-mini/w7:p1" → its machine (a pane id has no "/"). */
function hostOf(key: string): string {
  return key.slice(0, key.lastIndexOf("/"));
}

/** The note of a Send that waits for its uploads. */
export const sendsAfterUploadText = "Sends when the upload finishes.";
/** Its box went before the uploads finished. */
export const leftBeforeUploadText = "Not sent: the pane was left before its upload finished. The message is kept.";
/** A removal that did not answer within its deadline. */
export const discardTimedOutText = "The machine did not answer in time.";
export const noUploaderText = "Attachments cannot upload here.";

export function notUploadedText(name: string, reason: string): string {
  return `Not sent: ${name} did not upload (${reason}). The message is kept.`;
}

export function notRemovedText(name: string, reason: string): string {
  return `Not sent: ${name} was not removed from the machine (${reason}). Retry or remove it, then send. The message is kept.`;
}

/** At most this many uploads run at once per machine; the others wait their turn. */
export const concurrentUploads = 2;
/** One removal's deadline here; the main process bounds it too, sooner (backend.ts discardTimeoutMs, 40 s). */
export const discardDeadlineMs = 45_000;

let nextChip = 0;
let nextUpload = 0;

/** A picture for an image's chip and bubble: an object URL of its bytes, where the page can make one. */
function previewOf(payload: AttachmentPayload): string | null {
  if (!payload.image || typeof URL.createObjectURL !== "function" || typeof Blob === "undefined") return null;
  try {
    return URL.createObjectURL(new Blob([payload.data as BlobPart], { type: payload.extension === "jpg" ? "image/jpeg" : "image/png" }));
  } catch {
    return null;
  }
}

/** Pictures of what you sent, by the path on the machine: your bubble and the transcript show them without reading them back. */
export const localPictures = new Map<string, string>();

/** What still goes with a Send: on the machine, uploading or to upload; not one you removed. */
export function isSendable(chip: AttachmentChip): boolean {
  return chip.state.kind !== "removing" && chip.state.kind !== "cleanup";
}

export type Uploader = (hostId: string, data: Uint8Array, extension: string, uploadId: string) => Promise<UploadedAttachment>;

/** Where the chips upload (the page's bridge in the app). */
export interface AttachmentTransport {
  readonly upload: Uploader;
  /** × on a chip still uploading: its upload sends no further request. */
  readonly cancel?: (uploadId: string) => void;
  /** × on a chip on the machine: that upload goes from there; rejects with why. */
  readonly discard?: (hostId: string, path: string) => Promise<void>;
}

/** The page's bridge as the transport; null where it cannot upload (an older test's fake). */
export function bridgeTransport(): AttachmentTransport | null {
  const bridge = (globalThis as { window?: { herdrDesktop?: Partial<HerdrDesktopBridge> } }).window?.herdrDesktop;
  if (bridge === undefined || typeof bridge.uploadAttachment !== "function") return null;
  // Once an upload or a × settles, Settings' count of that machine's uploads is stale.
  return {
    upload: (hostId, data, extension, uploadId) => bridge.uploadAttachment!(hostId, data, extension, uploadId).finally(() => uploadsStore.invalidate(hostId)),
    ...(typeof bridge.cancelUpload === "function" ? { cancel: (uploadId: string) => bridge.cancelUpload!(uploadId) } : {}),
    ...(typeof bridge.discardAttachment === "function"
      ? { discard: (hostId: string, path: string) => bridge.discardAttachment!(hostId, path).finally(() => uploadsStore.invalidate(hostId)) }
      : {}),
  };
}

export interface ComposerDraftsOptions {
  /** Where the chips upload, read at each use (the page's bridge by default). */
  readonly transport?: () => AttachmentTransport | null;
  readonly concurrentUploads?: number;
  readonly discardDeadlineMs?: number;
}

/** One upload of one chip (an attempt: Retry makes another). */
interface UploadJob {
  readonly uploadId: string;
  readonly key: string;
  readonly chipId: string;
  readonly hostId: string;
  readonly data: Uint8Array;
  readonly extension: string;
  readonly upload: Uploader;
  readonly transport: AttachmentTransport | null;
  running: boolean;
}

/** A Send pressed while its chips upload. */
interface PendingSend {
  readonly ticket: SendTicket;
  readonly go: (sent: SendTicket, paths: readonly string[]) => void;
  /** Removals that hold it: under way at the press, or started meanwhile (× or Retry: startDiscard). */
  readonly discards: Set<string>;
  /** Why it will not go (a removal under it failed), or null. */
  failure: string | null;
}

type Verdict = { readonly kind: "wait" } | { readonly kind: "refuse"; readonly note: string } | { readonly kind: "go"; readonly chips: readonly AttachmentChip[] };

const chipRef = (key: string, id: string): string => `${key}\n${id}`;

export class ComposerDrafts {
  private readonly drafts = new Map<string, Draft>();
  private readonly listeners = new Set<() => void>();
  /** Each change of a pane's draft also goes here (the main process keeps it). */
  private saver: ((key: string, draft: Draft) => void) | null = null;
  private readonly transport: () => AttachmentTransport | null;
  private readonly concurrent: number;
  private readonly discardDeadline: number;
  /** Uploads under way or waiting their turn, in the order attached. */
  private jobs: UploadJob[] = [];
  /** Each uploading chip's current attempt. */
  private readonly attempts = new Map<string, string>();
  /** Chips whose removal runs (one at a time per chip). */
  private readonly discarding = new Set<string>();
  /** A Send waiting for its uploads, per pane. */
  private readonly waits = new Map<string, PendingSend>();
  /** The boxes showing each pane (MainPane's Composer). */
  private readonly shown = new Map<string, number>();
  /**
   * Chips whose path may have reached the pane (a Send that went and did not
   * confirm) or came back with a restored draft: × clears them here only; the
   * file stays for the 30-day sweep.
   */
  private readonly keptOnMachine = new Set<string>();
  /** A path something else here names (Kept drafts: draft-persistence.ts); its file is never removed. */
  private alsoNamed: ((path: string) => boolean) | null = null;
  /** clear() lets go of everything under way: their results apply nowhere. */
  private epoch = 0;

  constructor(options: ComposerDraftsOptions = {}) {
    this.transport = options.transport ?? bridgeTransport;
    this.concurrent = options.concurrentUploads ?? concurrentUploads;
    this.discardDeadline = options.discardDeadlineMs ?? discardDeadlineMs;
  }

  /** Every change from now on (null: nowhere). */
  setSaver(saver: ((key: string, draft: Draft) => void) | null): void {
    this.saver = saver;
  }

  /** What else names a path on the machine (Kept drafts), so × never removes its file. */
  setAlsoNamed(named: ((path: string) => boolean) | null): void {
    this.alsoNamed = named;
  }

  /** The same object until the draft changes (useSyncExternalStore needs a stable snapshot). */
  get(key: string): Draft {
    return this.drafts.get(key) ?? emptyDraft;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private set(key: string, draft: Draft, save = true): void {
    if (
      draft.text === "" &&
      draft.chips.length === 0 &&
      draft.lost.length === 0 &&
      !draft.sending &&
      draft.error === null &&
      draft.taken === null &&
      !draft.waiting &&
      draft.held === null &&
      draft.keeping.length === 0
    ) {
      this.drafts.delete(key);
    } else {
      this.drafts.set(key, draft);
    }
    if (save) this.saver?.(key, this.get(key));
    for (const listener of this.listeners) listener();
  }

  /**
   * A draft kept through a quit or a crash, back in its pane's box (nothing is
   * saved back). Never over one you have typed already this run. `note`: what
   * the bar says about it (a draft kept cut).
   */
  restore(key: string, text: string, chips: readonly RestoredChip[], lost: readonly string[], note: string | null = null): boolean {
    const current = this.get(key);
    if (current.text !== "" || current.chips.length > 0 || current.sending) return false;
    this.set(key, { text, sending: false, error: note, chips: this.restoredChips(key, chips), lost: [...lost], taken: null, waiting: false, held: null, keeping: [] }, false);
    return true;
  }

  /** A gone pane's draft, now under Kept drafts: it leaves this pane (nothing is saved back). */
  forget(key: string): void {
    const draft = this.get(key);
    if (draft === emptyDraft || (draft.sending && !draft.waiting)) return;
    this.waits.delete(key);
    this.letGo(key, draft.chips);
    this.set(key, emptyDraft, false);
  }

  /**
   * Your `/compact` line, held for the end of Claude's turn, leaves
   * the box (what you type next is the box's) and stays the draft's `held`, saved with it, until it goes
   * (heldWent) or comes back (heldBack).
   */
  hold(key: string, line: string): void {
    this.set(key, { ...this.get(key), text: "", held: line });
  }

  /** The held line went: the draft lets it go (only that line). */
  heldWent(key: string, line: string): void {
    const draft = this.get(key);
    if (draft.held === line) this.set(key, { ...draft, held: null });
  }

  /**
   * The held line did not go (refused, the pane or run changed, a
   * reconnect, an outcome not known): back in the box while it is empty ("box"). "gone": the draft no longer
   * holds it (the pane's draft went to Kept drafts with it, or it went already): nothing changes.
   * With newer text there, your newer text stays and the line waits in
   * `keeping` (still saved with the draft) for the caller to move it to Kept drafts ("keep": keptAway or
   * keptBack after).
   */
  heldBack(key: string, line: string): "box" | "keep" | "gone" {
    const draft = this.get(key);
    if (draft.held !== line) return "gone";
    if (draft.text.trim() === "") {
      this.set(key, { ...draft, text: line, held: null });
      return "box";
    }
    this.set(key, { ...draft, held: null, keeping: [...draft.keeping, line] });
    return "keep";
  }

  /** Kept drafts has the line now: the draft lets it go (only that line, once). */
  keptAway(key: string, line: string): void {
    const draft = this.get(key);
    const at = draft.keeping.indexOf(line);
    if (at >= 0) this.set(key, { ...draft, keeping: draft.keeping.filter((_, index) => index !== at) });
  }

  /**
   * Kept drafts could not take the line (no room, no main process to keep it):
   * it goes back into the box, before your newer text, so it is never lost. False when the draft no longer has it
   * (the pane's draft went to Kept drafts with it).
   */
  keptBack(key: string, line: string): boolean {
    const draft = this.get(key);
    const at = draft.keeping.indexOf(line);
    if (at < 0) return false;
    this.set(key, { ...draft, text: putBack(line, draft.text), keeping: draft.keeping.filter((_, index) => index !== at) });
    return true;
  }

  /** Put in box from Kept drafts: the text and its uploaded chips become the pane's draft, while its box is empty. */
  putBack(key: string, text: string, chips: readonly RestoredChip[]): boolean {
    const current = this.get(key);
    if (current.text !== "" || current.chips.length > 0 || current.sending) return false;
    this.set(key, { ...current, text, chips: this.restoredChips(key, chips), error: null });
    return true;
  }

  /** Drops every draft and lets go of everything under way (a fresh renderer state; the tests start from it). */
  clear(): void {
    this.epoch += 1;
    this.jobs = [];
    this.attempts.clear();
    this.discarding.clear();
    this.waits.clear();
    this.shown.clear();
    this.keptOnMachine.clear();
    this.drafts.clear();
    for (const listener of this.listeners) listener();
  }

  edit(key: string, text: string): void {
    this.set(key, { ...this.get(key), text });
  }

  /** The bytes the pane's chips still keep to upload or retry may grow by this much (64 MB in all). */
  residentAllowance(key: string): number {
    const kept = this.get(key).chips.reduce((sum, chip) => sum + (chip.state.kind === "uploaded" ? 0 : chip.data.byteLength), 0);
    return Math.max(0, maxResidentBytes - kept);
  }

  /** New chips at the end of the pane's draft; each starts uploading now (or waits its turn). */
  attach(key: string, payloads: readonly AttachmentPayload[]): void {
    if (payloads.length === 0) return;
    const draft = this.get(key);
    const transport = this.transport();
    const chips = payloads.map((payload): AttachmentChip => {
      nextChip += 1;
      return { ...payload, id: `chip-${nextChip}`, preview: previewOf(payload), state: transport === null ? { kind: "ready" } : { kind: "uploading" } };
    });
    this.set(key, { ...draft, chips: [...draft.chips, ...chips], error: null });
    if (transport === null) return;
    for (const chip of chips) this.enqueue(key, chip, transport.upload, transport);
    this.pump();
  }

  /** The note under the pane's box (what was not attached, and why). */
  note(key: string, message: string): void {
    this.set(key, { ...this.get(key), error: message });
  }

  /** The note line's note goes (its ×, a status change, a send, 8 s); the text stays. */
  clearNote(key: string): void {
    if (this.get(key).error !== null) this.set(key, { ...this.get(key), error: null });
  }

  /**
   * × on a chip (not while its message is being sent): one waiting its turn
   * leaves; one uploading stops; one on the machine is removed from there
   * (its chip shows removing until it is gone, or stays with Retry); a failed
   * one, or one whose removal failed, leaves (its file, if any, is the 30-day
   * sweep's).
   */
  removeChip(key: string, id: string): void {
    const draft = this.get(key);
    if (draft.sending && !draft.waiting) return;
    const chip = draft.chips.find((candidate) => candidate.id === id);
    if (chip === undefined) return;
    const ref = chipRef(key, id);
    switch (chip.state.kind) {
      case "removing":
        return;
      case "uploaded": {
        const path = chip.state.path;
        const discard = this.transport()?.discard ?? null;
        if (this.keptOnMachine.has(ref) || this.namedElsewhere(key, id, path)) {
          // A Send may have taken it, or something else names it: the chip goes, the file and its picture stay.
          this.drop(key, id);
          break;
        }
        if (discard === null) {
          // Nothing here removes it: left to the 30-day sweep.
          this.drop(key, id, path);
          break;
        }
        this.setChip(key, id, { kind: "removing", path });
        // A Send waiting holds until this removal settles (startDiscard registers it); failed, it stops.
        this.startDiscard(key, id, path, discard);
        break;
      }
      case "uploading": {
        const attempt = this.attempts.get(ref);
        this.attempts.delete(ref);
        const job = this.jobs.find((candidate) => candidate.uploadId === attempt);
        if (job !== undefined && !job.running) this.jobs = this.jobs.filter((candidate) => candidate !== job);
        else if (job !== undefined) job.transport?.cancel?.(job.uploadId);
        this.drop(key, id);
        break;
      }
      case "cleanup":
        // Its removal failed: the chip goes; the file is left to the 30-day sweep.
        this.drop(key, id, chip.state.path);
        break;
      default:
        this.drop(key, id);
    }
    this.evaluate(key);
  }

  /** Retry on a chip that did not upload uploads it again; on one whose removal failed, removes it again. */
  retryChip(key: string, id: string): void {
    const chip = this.chip(key, id);
    if (chip === null) return;
    if (chip.state.kind === "failed") {
      this.startUpload(key, id, null);
      this.pump();
    } else if (chip.state.kind === "cleanup") {
      const discard = this.transport()?.discard ?? null;
      if (discard === null) return;
      const path = chip.state.path;
      this.setChip(key, id, { kind: "removing", path });
      this.startDiscard(key, id, path, discard);
    }
  }

  chip(key: string, id: string): AttachmentChip | null {
    return this.get(key).chips.find((chip) => chip.id === id) ?? null;
  }

  setChip(key: string, id: string, state: ChipState): void {
    const draft = this.get(key);
    if (!draft.chips.some((chip) => chip.id === id)) return;
    this.set(key, { ...draft, chips: draft.chips.map((chip) => (chip.id === id ? { ...chip, state } : chip)) });
  }

  /**
   * Starts a send of the pane's draft; null when there is nothing to send or a
   * send is in flight (or waits). The box empties now (its text
   * is the draft's `taken` until the result); the chips stay until they went.
   */
  begin(key: string): SendTicket | null {
    const draft = this.get(key);
    const going = draft.chips.filter(isSendable);
    if ((draft.text.trim() === "" && going.length === 0) || draft.sending) return null;
    this.set(key, { ...draft, text: "", sending: true, error: null, taken: draft.text });
    return { key, text: draft.text, chips: going.map((chip) => chip.id) };
  }

  /**
   * The press's chips: one not on the machine and not uploading (or failed)
   * starts now; then the Send goes at once when every one is on the machine,
   * or waits for them (`waiting`), and goes (`go`) once they are, unless one
   * fails, a removal under it fails, its note's × lets it go, or the pane's
   * box goes. `upload`: what to upload with where there is no transport.
   */
  dispatch(ticket: SendTicket, upload: Uploader | null, go: (sent: SendTicket, paths: readonly string[]) => void): void {
    for (const id of ticket.chips) {
      const kind = this.chip(ticket.key, id)?.state.kind;
      if (kind === "ready" || kind === "failed") this.startUpload(ticket.key, id, upload);
    }
    this.pump();
    // A removal under way at the press holds it, as one started during it does
    // (startDiscard), also with no upload left: the wait is built first, so the first verdict counts its removals.
    const removing = this.get(ticket.key).chips.filter((chip) => chip.state.kind === "removing");
    const wait: PendingSend = { ticket, go, discards: new Set(removing.map((chip) => chip.id)), failure: null };
    const verdict = this.verdict(ticket, wait);
    if (verdict.kind === "refuse") {
      this.failed(ticket, verdict.note);
      return;
    }
    if (verdict.kind === "go") {
      this.launch(ticket, verdict.chips, go);
      return;
    }
    this.waits.set(ticket.key, wait);
    this.set(ticket.key, { ...this.get(ticket.key), waiting: true });
  }

  /** × on the waiting Send's note: nothing is sent; its text comes back, the chips and what is under way stay. */
  abandonWait(key: string): void {
    const wait = this.waits.get(key);
    if (wait === undefined) return;
    this.waits.delete(key);
    const draft = this.get(key);
    this.set(key, { ...draft, text: putBack(wait.ticket.text, draft.text), sending: false, error: null, taken: null, waiting: false });
  }

  /** A box shows the pane; the returned function says it went. When the last goes, a Send waiting there goes no further. */
  showing(key: string): () => void {
    this.shown.set(key, (this.shown.get(key) ?? 0) + 1);
    let gone = false;
    return () => {
      if (gone) return;
      gone = true;
      const left = (this.shown.get(key) ?? 1) - 1;
      if (left > 0) {
        this.shown.set(key, left);
        return;
      }
      this.shown.delete(key);
      this.left(key);
    };
  }

  /** The pane's box went (its Chat left, another pane or machine, the window closing): a Send waiting there is let go at once, unsent. */
  left(key: string): void {
    const wait = this.waits.get(key);
    if (wait === undefined) return;
    this.waits.delete(key);
    this.failed(wait.ticket, leftBeforeUploadText);
  }

  /** The window is closing: every waiting Send is let go, unsent. */
  leaveAll(): void {
    for (const key of Array.from(this.waits.keys())) this.left(key);
  }

  /** It went: the box keeps what was typed since the press; its chips go. */
  succeeded(ticket: SendTicket): void {
    const draft = this.get(ticket.key);
    const sent = new Set(ticket.chips);
    for (const id of ticket.chips) this.keptOnMachine.delete(chipRef(ticket.key, id));
    this.set(ticket.key, {
      text: draft.text,
      sending: false,
      error: null,
      chips: draft.chips.filter((chip) => !sent.has(chip.id)),
      lost: [],
      taken: null,
      waiting: false,
      held: draft.held,
      keeping: draft.keeping,
    });
  }

  /** It did not go: its text comes back first, then a newline and what was typed since, with the note. */
  failed(ticket: SendTicket, message: string): void {
    const draft = this.get(ticket.key);
    this.set(ticket.key, { ...draft, text: putBack(ticket.text, draft.text), sending: false, error: message, taken: null, waiting: false });
  }

  /** Whether a chip of the pane is uploading (or waiting its turn). */
  uploading(key: string): boolean {
    return this.get(key).chips.some((chip) => chip.state.kind === "uploading");
  }

  private restoredChips(key: string, chips: readonly RestoredChip[]): AttachmentChip[] {
    return chips.map((chip) => {
      const restored = restoredChip(chip);
      // It may have gone with a Send before the app closed: × clears it here only.
      this.keptOnMachine.add(chipRef(key, restored.id));
      return restored;
    });
  }

  /** Another chip here, or something else (a Kept draft), names the path. */
  private namedElsewhere(key: string, id: string, path: string): boolean {
    for (const [otherKey, draft] of this.drafts) {
      for (const chip of draft.chips) {
        if (otherKey === key && chip.id === id) continue;
        const state = chip.state;
        if ((state.kind === "uploaded" || state.kind === "removing" || state.kind === "cleanup") && state.path === path) return true;
      }
    }
    return this.alsoNamed?.(path) === true;
  }

  /** The chip leaves the draft; its picture goes unless your sent bubble shows it. */
  private drop(key: string, id: string, removedPath: string | null = null): void {
    const draft = this.get(key);
    const chip = draft.chips.find((candidate) => candidate.id === id);
    if (chip === undefined) return;
    this.keptOnMachine.delete(chipRef(key, id));
    if (removedPath !== null && localPictures.get(removedPath) === chip.preview) localPictures.delete(removedPath);
    if (chip.preview !== null && ![...localPictures.values()].includes(chip.preview)) URL.revokeObjectURL?.(chip.preview);
    this.set(key, { ...draft, chips: draft.chips.filter((candidate) => candidate.id !== id) });
  }

  /** The chips of a draft that left this pane: what waits its turn never starts, what uploads stops (a landed one is removed again). */
  private letGo(key: string, chips: readonly AttachmentChip[]): void {
    for (const chip of chips) {
      const ref = chipRef(key, chip.id);
      const attempt = this.attempts.get(ref);
      this.attempts.delete(ref);
      this.keptOnMachine.delete(ref);
      const job = this.jobs.find((candidate) => candidate.uploadId === attempt);
      if (job === undefined) continue;
      if (!job.running) this.jobs = this.jobs.filter((candidate) => candidate !== job);
      else job.transport?.cancel?.(job.uploadId);
    }
  }

  /** The chip uploads again (or for the first time); without anything to upload with, it fails at once. */
  private startUpload(key: string, id: string, fallback: Uploader | null): void {
    const chip = this.chip(key, id);
    if (chip === null) return;
    const transport = this.transport();
    const upload = transport?.upload ?? fallback;
    if (upload === null) {
      this.setChip(key, id, { kind: "failed", reason: noUploaderText });
      return;
    }
    this.setChip(key, id, { kind: "uploading" });
    this.enqueue(key, chip, upload, transport);
  }

  private enqueue(key: string, chip: AttachmentChip, upload: Uploader, transport: AttachmentTransport | null): void {
    nextUpload += 1;
    const random = typeof globalThis.crypto?.randomUUID === "function" ? globalThis.crypto.randomUUID() : String(Math.random()).slice(2);
    const job: UploadJob = {
      uploadId: `upload-${nextUpload}-${random}`,
      key,
      chipId: chip.id,
      hostId: hostOf(key),
      data: chip.data,
      extension: chip.extension,
      upload,
      transport,
      running: false,
    };
    this.jobs.push(job);
    this.attempts.set(chipRef(key, chip.id), job.uploadId);
  }

  /** Starts the next uploads waiting their turn, at most `concurrent` at once per machine. */
  private pump(): void {
    for (const job of this.jobs) {
      if (job.running) continue;
      const running = this.jobs.filter((other) => other.running && other.hostId === job.hostId).length;
      if (running >= this.concurrent) continue;
      this.run(job);
    }
  }

  private run(job: UploadJob): void {
    job.running = true;
    const epoch = this.epoch;
    let result: Promise<UploadedAttachment>;
    try {
      result = job.upload(job.hostId, job.data, job.extension, job.uploadId);
    } catch (failure) {
      result = Promise.reject(failure);
    }
    result.then(
      (remote) => this.finished(job, epoch, { path: remote.path, reason: null }),
      (failure: unknown) => this.finished(job, epoch, { path: null, reason: failureText(failure, "the upload stopped") }),
    );
  }

  /** An upload's result: only its own chip, while it still is this attempt's; never a send by itself. */
  private finished(job: UploadJob, epoch: number, outcome: { readonly path: string | null; readonly reason: string | null }): void {
    if (epoch !== this.epoch) return;
    this.jobs = this.jobs.filter((candidate) => candidate !== job);
    const ref = chipRef(job.key, job.chipId);
    const current = this.attempts.get(ref) === job.uploadId;
    if (current) this.attempts.delete(ref);
    const chip = this.chip(job.key, job.chipId);
    if (!current || chip === null || chip.state.kind !== "uploading") {
      // × while it ran, or its draft left: never shown, never sent; one that landed is removed again.
      if (outcome.path !== null) void job.transport?.discard?.(job.hostId, outcome.path).catch(() => undefined);
    } else if (outcome.path !== null) {
      if (chip.preview !== null) localPictures.set(outcome.path, chip.preview);
      // On the machine: its bytes are not needed again.
      const draft = this.get(job.key);
      const landed: AttachmentChip = { ...chip, data: new Uint8Array(0), state: { kind: "uploaded", path: outcome.path } };
      this.set(job.key, { ...draft, chips: draft.chips.map((candidate) => (candidate.id === chip.id ? landed : candidate)) });
    } else {
      this.setChip(job.key, job.chipId, { kind: "failed", reason: outcome.reason ?? "the upload stopped" });
    }
    this.pump();
    this.evaluate(job.key);
  }

  /** One removal of a chip's file under one deadline; its result only updates that chip (and a Send it holds). */
  private startDiscard(key: string, id: string, path: string, discard: (hostId: string, path: string) => Promise<void>): void {
    // Every removal started while a Send waits holds it (× and Retry alike); failed, it stops it.
    this.waits.get(key)?.discards.add(id);
    const ref = chipRef(key, id);
    if (this.discarding.has(ref)) return;
    this.discarding.add(ref);
    const epoch = this.epoch;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(discardTimedOutText)), this.discardDeadline);
    });
    let attempt: Promise<void>;
    try {
      attempt = discard(hostOf(key), path);
    } catch (failure) {
      attempt = Promise.reject(failure);
    }
    void Promise.race([attempt, deadline])
      .then(
        () => null,
        (failure: unknown) => failureText(failure, "it could not be removed"),
      )
      .then((reason) => {
        clearTimeout(timer);
        if (epoch !== this.epoch) return;
        this.discarding.delete(ref);
        const wait = this.waits.get(key);
        const held = wait?.discards.delete(id) === true;
        const chip = this.chip(key, id);
        if (reason === null) {
          if (chip?.state.kind === "removing") this.drop(key, id, path);
        } else {
          if (chip?.state.kind === "removing") this.setChip(key, id, { kind: "cleanup", path, reason });
          if (held && wait !== undefined) wait.failure ??= notRemovedText(chip?.name ?? "an attachment", reason);
        }
        this.evaluate(key);
      });
  }

  /** Where a Send stands: wait, refused (and why), or go with these chips on the machine. */
  private verdict(ticket: SendTicket, wait: PendingSend | null): Verdict {
    if (wait !== null && wait.failure !== null) return { kind: "refuse", note: wait.failure };
    const chips = ticket.chips.map((id) => this.chip(ticket.key, id)).filter((chip): chip is AttachmentChip => chip !== null);
    for (const chip of chips) {
      if (chip.state.kind === "failed") return { kind: "refuse", note: notUploadedText(chip.name, chip.state.reason) };
    }
    if (chips.some((chip) => chip.state.kind === "uploading" || chip.state.kind === "ready")) return { kind: "wait" };
    if (wait !== null && wait.discards.size > 0) return { kind: "wait" };
    return { kind: "go", chips: chips.filter((chip) => chip.state.kind === "uploaded") };
  }

  /** The pane's waiting Send looks again (an upload or a removal settled, or a chip left). */
  private evaluate(key: string): void {
    const wait = this.waits.get(key);
    if (wait === undefined) return;
    const verdict = this.verdict(wait.ticket, wait);
    if (verdict.kind === "wait") return;
    this.waits.delete(key);
    if (verdict.kind === "refuse") this.failed(wait.ticket, verdict.note);
    else this.launch(wait.ticket, verdict.chips, wait.go);
  }

  /** The message goes with these chips' paths, in the order attached. */
  private launch(ticket: SendTicket, chips: readonly AttachmentChip[], go: (sent: SendTicket, paths: readonly string[]) => void): void {
    const sent: SendTicket = { ...ticket, chips: chips.map((chip) => chip.id) };
    const draft = this.get(ticket.key);
    if (draft.waiting) this.set(ticket.key, { ...draft, waiting: false });
    // Until it is confirmed its paths may reach the pane: × on them then clears the chip only.
    for (const chip of chips) this.keptOnMachine.add(chipRef(ticket.key, chip.id));
    go(
      sent,
      chips.flatMap((chip) => (chip.state.kind === "uploaded" ? [chip.state.path] : [])),
    );
  }
}

function restoredChip(chip: RestoredChip): AttachmentChip {
  nextChip += 1;
  const dot = chip.path.lastIndexOf(".");
  return {
    id: `chip-${nextChip}`,
    name: chip.name,
    extension: dot < 0 ? "" : chip.path.slice(dot + 1).toLowerCase(),
    image: chip.image,
    data: new Uint8Array(0),
    preview: localPictures.get(chip.path) ?? null,
    state: { kind: "uploaded", path: chip.path },
  };
}

/** The app's drafts (renderer-wide: a pane's draft survives switching away and back). */
export const composerDrafts = new ComposerDrafts();

/** A stable subscribe function for useSyncExternalStore. */
export const subscribeComposerDrafts = (onChange: () => void): (() => void) => composerDrafts.subscribe(onChange);

/** An IPC rejection's own words. */
export function failureText(failure: unknown, fallback: string): string {
  return failure instanceof Error ? failure.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : fallback;
}

export type AttachmentUploader = (hostId: string, data: Uint8Array, extension: string) => Promise<UploadedAttachment>;

/**
 * Sends the pane's draft; the completion is bound to that pane's ticket, never
 * to what is shown. Its chips uploaded as they were attached;
 * the message goes at once when all are on the machine, else when they are
 * (`ComposerDrafts.dispatch`). True when a send began or waits
 * (the pane's Chat goes to its end). `upload`: what a
 * chip uploads with where the drafts have no transport; `went`: the message
 * is going now (at the press, or when its uploads finished).
 */
export function sendDraft(
  drafts: ComposerDrafts,
  send: (hostId: string, paneId: string, text: string) => Promise<void>,
  hostId: string,
  paneId: string,
  upload: AttachmentUploader | null = null,
  went: (() => void) | null = null,
): boolean {
  const ticket = drafts.begin(draftKey(hostId, paneId));
  if (ticket === null) return false;
  const uploader: Uploader | null = upload === null ? null : (h, data, extension) => upload(h, data, extension);
  drafts.dispatch(ticket, uploader, (sent, paths) => {
    went?.();
    void (async () => {
      try {
        await send(hostId, paneId, joinedMessage(sent.text, paths));
        drafts.succeeded(sent);
      } catch (failure) {
        drafts.failed(sent, failureText(failure, "Not sent"));
      }
    })();
  });
  return true;
}

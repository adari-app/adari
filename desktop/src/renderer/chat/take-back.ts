// A message still waiting in Claude's queue comes back to the box, so "abc" sent, then Esc and "abcd", does not
// send both. Claude Code 2.1.322 sends a queued message as the next prompt on Esc, so reading Claude's box after
// an Esc (esc-back.ts) finds nothing there any more.
// Instead, while one of your sends from Chat still waits there (its bubble says Queued: Herdr took it, the
// transcript does not have it), Esc's first press, Up in an empty box, or the bubble's Take back asks main to take
// it back (Up, then Ctrl+U: main/herdr/claude-box.ts takeBackQueued). Taken: its bubble goes, its text (its
// pictures as chips when the box is empty) goes back in the box as esc-back.ts puts a message back, and the note
// line says "Taken back. Claude keeps working." Nothing on screen to take back: Esc stops as usual. Anything
// else: the note says why, and the next Esc stops.

import { imagePaths, takeBackMost, takeBackTexts, type QueuedTakeBack } from "../../shared/claude-screen";
import type { StopBinding } from "../../shared/agent-stop";
import type { PendingMessage, PendingMessages } from "../../shared/chat/pending";
import { holdsSent, putBackInBox, type BoxDrafts } from "./esc-back";
import { pendingMessages } from "./chat-state";
import { composerDrafts } from "../components/composer-drafts";
import { agentStops } from "../components/agent-stop";
import { handoffStore } from "../handoff/handoff-state";

/**
 * Your sends to the pane that may wait in Claude's queue, oldest first: bubbles Herdr took (`sent`: not one still
 * going, nor one the backstop turned Not sent) to the terminal shown (or one not known).
 */
export function queuedSends(pending: readonly PendingMessage[], terminalID: string): PendingMessage[] {
  return pending.filter((item) => {
    if (item.state !== "sent" || item.text.trim() === "") return false;
    const sentTo = item.scope?.terminalID ?? "";
    return sentTo === "" || terminalID === "" || sentTo === terminalID;
  });
}

/** The last part of a path ("shot.png"). */
const basename = (path: string): string => path.slice(path.lastIndexOf("/") + 1) || path;

/** A picture that comes back as a chip: already on the machine at `path`. */
export interface TakenChip {
  readonly path: string;
  readonly name: string;
  readonly image: boolean;
}

/**
 * `texts` as the box takes them back: each one's caption, and its pictures as chips when every image path it
 * carries is at its end as Send put it there (joinedMessage). Null: a text with a picture path elsewhere (it goes
 * back as text, its path in it, as esc-back.ts puts one back).
 */
export function splitPictures(texts: readonly string[]): { readonly text: string; readonly chips: readonly TakenChip[] } | null {
  const captions: string[] = [];
  const chips: TakenChip[] = [];
  for (const text of texts) {
    const paths = imagePaths(text);
    if (paths.length === 0) {
      captions.push(text);
      continue;
    }
    const tail = paths.join(" ");
    if (!text.endsWith(tail)) return null;
    const head = text.slice(0, text.length - tail.length);
    captions.push(head.endsWith(" ") ? head.slice(0, -1) : head);
    for (const path of paths) chips.push({ path, name: basename(path), image: true });
  }
  return { text: captions.join("\n"), chips };
}

/** What putting the taken-back texts in the box needs (composer-drafts' ComposerDrafts). */
export interface TakeBackDrafts extends BoxDrafts {
  /** The text and its pictures as chips, only while the box is empty (Kept drafts' Put in box); false: not put. */
  putBack?(key: string, text: string, chips: readonly TakenChip[]): boolean;
}

/** Puts `texts` (oldest first) back in the pane's box: first, then a newline and your text; the cursor at the end. */
export function putTakenBack(drafts: TakeBackDrafts, landing: (key: string, at: number) => void, key: string, texts: readonly string[]): void {
  const fresh = texts.filter((text) => !holdsSent(text, drafts.get(key)));
  if (fresh.length === 0) return;
  const split = splitPictures(fresh);
  const now = drafts.get(key);
  if (split !== null && split.chips.length > 0 && now.text === "" && (now.chips?.length ?? 0) === 0 && drafts.putBack !== undefined) {
    landing(key, split.text.length);
    if (drafts.putBack(key, split.text, split.chips)) return;
  }
  putBackInBox(drafts, landing, key, fresh.join("\n"));
}

/** What a take-back touches on the page. */
export interface TakeBackDeps {
  readonly bridge: { takeBackQueued?(hostId: string, paneId: string, binding: StopBinding, texts: readonly string[]): Promise<QueuedTakeBack> };
  readonly drafts: TakeBackDrafts;
  readonly pending: Pick<PendingMessages, "forPane" | "takeBack">;
  landing(key: string, at: number): void;
  /** The note on the line under the box. */
  note(key: string, text: string): void;
}

/**
 * A take-back's end on the page: `none` (a read showed no queue: Esc stops as usual), `taken`, or `left` (said).
 * A request that failed or was refused is `left`, never `none`.
 */
export type TakeBackEnd = "none" | "taken" | "left";

/**
 * Per pane: the take-back under way (a second Esc waits for it, then stops), and the bubbles one already tried
 * and left (the next Esc stops instead of trying them again).
 */
export class TakeBacks {
  private readonly running = new Map<string, Promise<TakeBackEnd>>();
  private readonly tried = new Map<string, Set<string>>();

  /** The take-back under way for the pane, if any. */
  under(key: string): Promise<TakeBackEnd> | null {
    return this.running.get(key) ?? null;
  }

  /** The bubbles a take-back may still try (oldest first): the queued ones not tried and left before. */
  untried(key: string, queued: readonly PendingMessage[]): PendingMessage[] {
    const tried = this.tried.get(key);
    return tried === undefined ? [...queued] : queued.filter((item) => !tried.has(item.id));
  }

  /**
   * One take-back for the pane of `items` (your queued bubbles, oldest first). The bubbles' texts go to main;
   * taken, the bubbles go and the texts are back in the box; left, the note says why and they are not tried again.
   */
  run(deps: TakeBackDeps, hostId: string, paneId: string, key: string, binding: StopBinding, items: readonly PendingMessage[]): Promise<TakeBackEnd> {
    const ask = deps.bridge.takeBackQueued;
    if (ask === undefined || items.length === 0) return Promise.resolve("none");
    const texts = items.map((item) => item.text);
    const ids = items.map((item) => item.id);
    const refuse = (note: string): TakeBackEnd => {
      this.markTried(key, ids);
      deps.note(key, note);
      return "left";
    };
    // More than a take-back asks for is said; it never reads as no
    // queue (that would stop Claude and send them all) and is never cut short.
    const work =
      texts.length > takeBackMost
        ? Promise.resolve(refuse(takeBackTexts.tooMany))
        : ask.call(deps.bridge, hostId, paneId, binding, texts).then(
            (result): TakeBackEnd => {
              switch (result.type) {
                case "none":
                  return "none";
                case "left":
                  return refuse(result.note);
                case "taken": {
                  // Main answers taken only on Claude Code's own
                  // record of the pull (a popAll of exactly these texts), and the row in Claude's box may already be
                  // empty: the texts always come back here, so your words are never nowhere. Their bubbles still
                  // waiting go; a message the transcript already shows (the same words sent before) is never hidden.
                  const takenIds = ids.slice(Math.max(0, ids.length - result.texts.length));
                  const waiting = new Set(deps.pending.forPane(key).filter((item) => item.state === "sent").map((item) => item.id));
                  result.texts.forEach((text, index) => {
                    const id = takenIds[index - (result.texts.length - takenIds.length)];
                    if (id !== undefined && waiting.has(id)) deps.pending.takeBack(key, text);
                  });
                  putTakenBack(deps.drafts, deps.landing, key, result.texts);
                  deps.note(key, result.note);
                  return "taken";
                }
              }
            },
            // A request that failed or was refused says nothing about the queue: said, and no stop.
            (): TakeBackEnd => refuse(takeBackTexts.unread),
          );
    const own = work.finally(() => {
      if (this.running.get(key) === own) this.running.delete(key);
    });
    this.running.set(key, own);
    return own;
  }

  private markTried(key: string, ids: readonly string[]): void {
    const tried = this.tried.get(key) ?? new Set<string>();
    for (const id of ids) tried.add(id);
    // Only bubbles that may still show are kept (a few at most).
    this.tried.set(key, new Set([...tried].slice(-16)));
  }

  /** Drops everything (tests start from here). */
  clear(): void {
    this.running.clear();
    this.tried.clear();
  }
}

export const takeBacks = new TakeBacks();

/** Up's and the bubble's end: nothing on Claude's screen to take back is said (Esc stops instead, with no note). */
export function sayNoQueue(deps: Pick<TakeBackDeps, "note">, key: string): (end: TakeBackEnd) => void {
  return (end) => {
    if (end === "none") deps.note(key, takeBackTexts.noQueue);
  };
}

/** The page's stores a take-back touches: the bridge, the box, your bubbles, the note line under the box. */
export const takeBackDeps: TakeBackDeps = {
  get bridge() {
    return window.herdrDesktop;
  },
  drafts: composerDrafts,
  pending: pendingMessages,
  landing: (at, start) => handoffStore.expectLanding(at, start),
  note: (at, text) => agentStops.setNote(at, text),
};

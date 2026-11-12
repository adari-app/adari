// Esc and the queued send, the page's side:
//
// - After an Esc to a Claude pane, main reads Claude's box. When it
//   holds Chat's last send (Esc cancelled it before any answer and Claude Code
//   put it back there), the message comes back to our box as the terminal
//   does: its bubble goes (or the message it settled into is hidden), its text
//   goes first in our box, then a newline and what you had typed, the cursor at
//   the end. Claude's box was emptied by main; when it would not empty, the
//   note says to open Terminal.
// - A tap on a "Not sent" bubble puts its text back the same way.
// - When the pane last showed working (Herdr's status, by the page's
//   clock), so Esc still goes within 2 s after (escGoes).
// - A send with pictures that went
//   unconfirmed is already back in our box (its text, its picture chips kept);
//   an Esc's take-back of the same send then adds no second copy.

import { joinedMessage } from "../../shared/attachments";
import { claudeBoxTexts, imagePaths, putBack } from "../../shared/claude-screen";
import type { PendingMessages } from "../../shared/chat/pending";

/** What putting text back needs of the composer. */
export interface BoxDrafts {
  /** The pane's draft: its text and its chips, each uploaded one with its path on the machine. */
  get(key: string): { readonly text: string; readonly chips?: readonly { readonly state: { readonly kind: string; readonly path?: string } }[] };
  edit(key: string, text: string): void;
}

/**
 * The composer already
 * holds `line`, a send of its pane's that came back to it (an unconfirmed Send's text, put back first, its picture
 * chips kept). `line` whole as the composer would send it: its text first (`text` up to one of its newlines, or all
 * of it: putBack's order, what was typed since after it), then its paths (joinedMessage), each one of the
 * composer's uploaded chips; chips added since stay out of it. A line with no image path is never taken as
 * already here: text you typed again may match it.
 * Also your typing on the same line after the restored caption
 * (`caption and one more thing`): the composer's text starts with the line's caption unchanged, and every image
 * path the line carries is one of this composer's uploaded chips (`typedOnAfter`).
 */
export function holdsSent(line: string, draft: ReturnType<BoxDrafts["get"]>): boolean {
  if (imagePaths(line).length === 0) return false;
  const paths = (draft.chips ?? []).flatMap((chip) => (chip.state.kind === "uploaded" && chip.state.path !== undefined ? [chip.state.path] : []));
  const own = paths.filter((path) => line.includes(path));
  const text = draft.text;
  const ends = [...text.matchAll(/\n/g)].map((match) => match.index!);
  ends.push(text.length);
  return ends.some((end) => joinedMessage(text.slice(0, end), own) === line) || typedOnAfter(line, text, own);
}

/**
 * `line` went with its pictures as this composer's chips (`own`: every image path in it
 * is one), and `text` is the caption it went with, unchanged, then whatever you typed after it on the same line (or
 * on the next). The caption is `line` with its chip paths taken off the end as joinedMessage put them there: the
 * candidates are checked by joinedMessage itself, so a caption ending in a space is read either way.
 */
function typedOnAfter(line: string, text: string, own: readonly string[]): boolean {
  if (own.length === 0 || !imagePaths(line).every((path) => own.includes(path))) return false;
  const tail = own.join(" ");
  if (!line.endsWith(tail)) return false;
  const head = line.slice(0, line.length - tail.length);
  const captions = head.endsWith(" ") ? [head, head.slice(0, -1)] : [head];
  return captions.some((caption) => joinedMessage(caption, own) === line && text.startsWith(caption));
}

/** Text back in the pane's box: first, then a newline and your text; the cursor at the end (`landing`). */
export function putBackInBox(drafts: BoxDrafts, landing: (key: string, at: number) => void, key: string, text: string): void {
  const next = putBack(text, drafts.get(key).text);
  landing(key, next.length);
  drafts.edit(key, next);
}

/**
 * Main's answer after an Esc to the pane `key`. True when a message
 * came back to the box. One send comes back once: an answer for
 * a send whose text already came back (an earlier answer, or a tap on its
 * "Not sent" bubble) changes nothing, and touches no older message.
 * A send the composer already holds (`holdsSent`: an unconfirmed Send with
 * pictures put it back, your typing maybe after it) is not put back a second time; its bubble, the claim main
 * made and the note go as for any other.
 */
export function takeBackAfterStop(
  deps: {
    readonly drafts: BoxDrafts;
    readonly pending: Pick<PendingMessages, "takeBack" | "cameBack">;
    landing(key: string, at: number): void;
    /** The note on the line under the box. */
    note(key: string, text: string): void;
  },
  key: string,
  found: { readonly cancelled: string | null; readonly cleared: boolean },
): boolean {
  if (found.cancelled === null) return false;
  // A second answer for the same send changes nothing (main claims each send once; this is the page's own guard).
  if (deps.pending.cameBack(key, found.cancelled)) return false;
  deps.pending.takeBack(key, found.cancelled);
  if (!holdsSent(found.cancelled, deps.drafts.get(key))) putBackInBox(deps.drafts, deps.landing, key, found.cancelled);
  if (!found.cleared) deps.note(key, claudeBoxTexts.stillHasText);
  return true;
}

/** Per pane, whether it shows working, and when it last stopped showing it. */
export class WorkEdges {
  private readonly panes = new Map<string, { working: boolean; endedAt: number | null }>();

  /** The pane shows `working` (or not) at `nowMs`: the edge from working to not is when it stopped. */
  observe(key: string, working: boolean, nowMs: number): void {
    const pane = this.panes.get(key);
    if (working) this.panes.set(key, { working: true, endedAt: pane?.endedAt ?? null });
    else if (pane?.working === true) this.panes.set(key, { working: false, endedAt: nowMs });
  }

  /** When the pane last stopped showing working (null: never seen so, or working now). */
  endedAt(key: string): number | null {
    const pane = this.panes.get(key);
    return pane === undefined || pane.working ? null : pane.endedAt;
  }

  clear(): void {
    this.panes.clear();
  }
}

// The page's side of kept drafts: every change of a pane's draft
// goes to the main process (its text, its chips already uploaded by their
// paths, the names of local files not uploaded: those are not kept), which
// keeps it in drafts.json through a quit or a crash (src/main/drafts.ts). On
// launch each saved draft goes back into its pane's box (shown when its
// machine shows the pane), never over one typed already. A draft the main
// process found gone with its pane is under Kept drafts: listed above the box
// of that machine's panes (Put in box, Copy, Discard).
//
// A chip uploading (or waiting its turn, or failed) when the
// app closes is named, not kept: its bytes are not saved, so it never comes
// back as on the machine and never goes with a Send; attaching it again is
// its retry. A chip you removed (its removal running or failed) is not kept at
// all. A Kept draft's files are never removed by × on a chip naming the same
// path (ComposerDrafts.setAlsoNamed).

import type { HerdrDesktopBridge } from "../../shared/ipc-contract";
import type { CompactOutcome, DraftInput, DraftsChangedEvent, DraftsState, KeptDraft } from "../../shared/drafts";
import { putBack } from "../../shared/claude-screen";
import { composerDrafts, draftKey, isSendable, type ComposerDrafts, type Draft } from "./composer-drafts";

type Bridge = Pick<HerdrDesktopBridge, "saveDraft" | "keptDraft" | "keepDraft">;

/**
 * What is saved of a draft: null when there is nothing to keep.
 * A send under way keeps its text (out of the box since the press) first,
 * then a newline and what was typed since, until it went.
 * A held `/compact` line before both.
 * Lines on their way to Kept drafts before all of them (the oldest first).
 */
export function draftInput(draft: Draft): DraftInput | null {
  const typed = draft.taken === null ? draft.text : putBack(draft.taken, draft.text);
  // A `/compact` line held for the end of Claude's turn is yours
  // first (it was sent before the rest): after a reload, a quit or a crash it is text in the box, never re-sent.
  const withHeld = draft.held === null ? typed : putBack(draft.held, typed);
  // A held line that did not go, until Kept drafts has it.
  const text = draft.keeping.reduceRight((rest, line) => putBack(line, rest), withHeld);
  const uploaded = draft.chips.flatMap((chip) => (chip.state.kind === "uploaded" ? [{ path: chip.state.path, name: chip.name, image: chip.image }] : []));
  const local = draft.chips.filter((chip) => chip.state.kind !== "uploaded" && isSendable(chip)).map((chip) => chip.name);
  const lost = [...draft.lost, ...local];
  if (text === "" && uploaded.length === 0 && lost.length === 0) return null;
  return { text, chips: uploaded, lost };
}

/** "mac-mini/w7:p1" → its machine and pane (a pane id has no "/"). */
function split(key: string): { hostId: string; paneId: string } {
  const at = key.lastIndexOf("/");
  return { hostId: key.slice(0, at), paneId: key.slice(at + 1) };
}

export const cutNote = "This draft was kept cut to its first 100,000 bytes.";

export class DraftPersistence {
  private kept: readonly KeptDraft[] = [];
  private bridge: Bridge | null = null;
  private readonly listeners = new Set<() => void>();
  private revision = 0;

  constructor(private readonly drafts: ComposerDrafts) {
    drafts.setAlsoNamed((path) => this.kept.some((item) => item.chips.some((chip) => chip.path === path)));
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  version = (): number => this.revision;

  private changedKept(kept: readonly KeptDraft[]): void {
    this.kept = kept;
    this.revision += 1;
    for (const listener of Array.from(this.listeners)) listener();
  }

  /** Every change of a draft goes to the main process from now on. */
  attach(bridge: Bridge): void {
    this.bridge = bridge;
    this.drafts.setSaver((key, draft) => {
      const { hostId, paneId } = split(key);
      bridge.saveDraft(hostId, paneId, draftInput(draft));
    });
  }

  detach(): void {
    this.bridge = null;
    this.drafts.setSaver(null);
    this.changedKept([]);
  }

  /** What the main process kept, back in the boxes (launch). */
  restore(state: DraftsState): void {
    for (const draft of state.drafts) {
      this.drafts.restore(draftKey(draft.hostId, draft.paneId), draft.text, draft.chips, draft.lost, draft.cut === true ? cutNote : null);
    }
    this.changedKept(state.kept);
  }

  /** The main process moved drafts of gone panes to Kept drafts. */
  changed(event: DraftsChangedEvent): void {
    for (const gone of event.gone) this.drafts.forget(draftKey(gone.hostId, gone.paneId));
    this.changedKept(event.state.kept);
  }

  /** The machine's kept drafts, oldest first. */
  keptFor(hostId: string): readonly KeptDraft[] {
    return this.kept.filter((item) => item.hostId === hostId);
  }

  /**
   * Put in box: the kept text (and its uploaded chips) into the pane's empty
   * box. The box takes it first (at once, only while empty; it is saved
   * as that pane's draft), and only then does Kept let it go. A box not empty,
   * or a main process that does not answer, leaves it under Kept drafts (at
   * worst it is in both, never in neither). True when the box took it.
   */
  async take(item: KeptDraft, key: string): Promise<boolean> {
    if (this.bridge === null) return false;
    if (!this.drafts.putBack(key, item.text, item.chips)) return false;
    try {
      await this.bridge.keptDraft(item.id, "discard");
    } catch {
      return true;
    }
    this.changedKept(this.kept.filter((candidate) => candidate.id !== item.id));
    return true;
  }

  /**
   * A held typed `/compact` that did not go while the pane's box held
   * newer text (the draft has it in `keeping`) becomes a Kept draft of its own in the main process, kept through a
   * reload or a quit until Put in box or Discard. Only once main has it does the draft let it go. No room, no main
   * process to keep it, or no answer: back into the box before your newer text ("box"). "gone": the draft no longer
   * had it (it went to Kept drafts with its pane's draft).
   * `outcome` goes to main, which keeps a Compact that may have gone with
   * a reason saying so (never "not sent").
   */
  async keepHeld(key: string, line: string, outcome: CompactOutcome): Promise<"kept" | "box" | "gone"> {
    const { hostId, paneId } = split(key);
    let item: KeptDraft | null = null;
    const bridge = this.bridge;
    if (bridge?.keepDraft !== undefined) {
      try {
        item = await bridge.keepDraft(hostId, paneId, line, outcome);
      } catch {
        item = null;
      }
    }
    if (item === null) return this.drafts.keptBack(key, line) ? "box" : "gone";
    this.drafts.keptAway(key, line);
    if (!this.kept.some((candidate) => candidate.id === item.id)) this.changedKept([...this.kept, item]);
    return "kept";
  }

  async discard(item: KeptDraft): Promise<void> {
    if (this.bridge === null) return;
    await this.bridge.keptDraft(item.id, "discard");
    this.changedKept(this.kept.filter((candidate) => candidate.id !== item.id));
  }
}

export const draftPersistence = new DraftPersistence(composerDrafts);

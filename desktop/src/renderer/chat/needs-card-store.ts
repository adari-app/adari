// The page's side of the needs-you card. The main process's
// readings of the blocked panes (PanePrompt, pushed whenever one changes), and
// per pane what the card shows besides: the option the arrows chose, the
// answer that went ("Sent: Yes" until the screen moves on), and the last note.

import type { HerdrDesktopBridge, HostView } from "../../shared/ipc-contract";
import { stopBindingOf } from "../../shared/agent-stop";
import { readingMatch, sameFingerprint, type PromptFingerprint, type PromptMatch, type PromptOption } from "../../shared/prompt/matcher";
import type { AnswerResult, PanePrompt } from "../../shared/prompt/view";
import { agentName } from "../../shared/prompt/card";

export interface CardState {
  /** The option the arrows chose for this question (null: the one Return picks). */
  readonly selection: { readonly fingerprint: PromptFingerprint; readonly index: number } | null;
  /** The answer that went, for the question and block it went to. */
  readonly sent: { readonly label: string; readonly fingerprint: PromptFingerprint; readonly episode: string } | null;
  /** Why the last answer did not go (or went without confirming), under the card. */
  readonly note: string | null;
  /** The box's note: the text it keeps, and why. */
  readonly boxNote: string | null;
  /** An answer is under way from this card or its box. */
  readonly busy: boolean;
  /**
   * Grok's digit went and its screen did not show the
   * answer take: Answer in Terminal shows, for the block it went in.
   */
  readonly terminal: { readonly episode: string } | null;
}

const emptyCard: CardState = { selection: null, sent: null, note: null, boxNote: null, busy: false, terminal: null };

const keyOf = (hostId: string, paneId: string): string => `${hostId}\u0000${paneId}`;

type AnswerBridge = Pick<HerdrDesktopBridge, "listPrompts" | "onPromptsChanged" | "answerPrompt">;

export class NeedsCardStore {
  private prompts = new Map<string, PanePrompt>();
  private readonly cards = new Map<string, CardState>();
  private readonly listeners = new Set<() => void>();
  private attached: AnswerBridge | null = null;
  private detach: (() => void) | null = null;
  private count = 0;
  private clearedKey = "";
  private readonly clearedListeners = new Set<() => void>();

  /** Follows main's readings (once per bridge). */
  attach(bridge: AnswerBridge): void {
    if (this.attached === bridge || bridge.onPromptsChanged === undefined || bridge.listPrompts === undefined) return;
    this.detach?.();
    this.attached = bridge;
    this.detach = bridge.onPromptsChanged((prompts) => this.receive(prompts));
    void bridge.listPrompts().then(
      (prompts) => this.receive(prompts),
      () => undefined,
    );
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly version = (): number => this.count;

  private changed(): void {
    this.count += 1;
    for (const listener of Array.from(this.listeners)) listener();
  }

  receive(prompts: readonly PanePrompt[]): void {
    this.prompts = new Map(prompts.map((prompt) => [keyOf(prompt.hostId, prompt.paneId), prompt]));
    const cleared = prompts
      .filter((prompt) => prompt.cleared)
      .map((prompt) => keyOf(prompt.hostId, prompt.paneId))
      .sort()
      .join("\u0001");
    const clearedChanged = cleared !== this.clearedKey;
    this.clearedKey = cleared;
    // An answer shown as sent stays until its block ends or another question shows, read whole
    // (as main's claim: a partly drawn, clipped or quiet frame proves nothing).
    for (const [key, card] of this.cards) {
      const prompt = this.prompts.get(key);
      let next = card;
      // Answer in Terminal stays while the block it went in does.
      if (next.terminal !== null && prompt?.episode !== next.terminal.episode) next = { ...next, terminal: null, note: null };
      if (next.sent !== null) {
        const shown = prompt === undefined || prompt.reading === null ? null : readingMatch(prompt.reading);
        const another = shown !== null && !sameFingerprint(shown.fingerprint, next.sent.fingerprint);
        const movedOn = prompt === undefined || prompt.episode !== next.sent.episode || another;
        if (movedOn) next = { ...next, sent: null, note: null };
      }
      if (next !== card) this.cards.set(key, next);
    }
    this.changed();
    if (clearedChanged) for (const listener of Array.from(this.clearedListeners)) listener();
  }

  /** Called when the set of cleared panes changes (the page shows its machines again). */
  onCleared(listener: () => void): () => void {
    this.clearedListeners.add(listener);
    return () => this.clearedListeners.delete(listener);
  }

  forPane(hostId: string, paneId: string): PanePrompt | null {
    return this.prompts.get(keyOf(hostId, paneId)) ?? null;
  }

  /** Every blocked pane main reads (the cleared ones show as working until Herdr's status changes). */
  all(): readonly PanePrompt[] {
    return [...this.prompts.values()];
  }

  card(hostId: string, paneId: string): CardState {
    return this.cards.get(keyOf(hostId, paneId)) ?? emptyCard;
  }

  private update(hostId: string, paneId: string, change: (card: CardState) => CardState): void {
    this.cards.set(keyOf(hostId, paneId), change(this.card(hostId, paneId)));
    this.changed();
  }

  /** The option the arrows chose. */
  select(hostId: string, paneId: string, match: PromptMatch, index: number): void {
    this.update(hostId, paneId, (card) => ({ ...card, selection: { fingerprint: match.fingerprint, index } }));
  }

  /** The chosen option's index for `match` (Return picks it): the arrows' choice, else the one Return picks in the pane. */
  selection(hostId: string, paneId: string, match: PromptMatch, returnIndex: number): number {
    const selection = this.card(hostId, paneId).selection;
    return selection !== null && sameFingerprint(selection.fingerprint, match.fingerprint) ? Math.min(selection.index, match.options.length - 1) : returnIndex;
  }

  /** The box's note shown, the draft untouched. */
  setBoxNote(hostId: string, paneId: string, note: string | null): void {
    this.update(hostId, paneId, (card) => ({ ...card, boxNote: note }));
  }

  /**
   * Answers `option` of `match` (and with `text`, the box's "No, tell…"),
   * bound to the agent and connection `host` shows; the card shows the
   * outcome. Resolves with it, or null when nothing was asked (one under way).
   */
  async answer(bridge: AnswerBridge, host: HostView, paneId: string, kind: string | null | undefined, match: PromptMatch, option: PromptOption, text?: string): Promise<AnswerResult | null> {
    const prompt = this.forPane(host.id, paneId);
    if (bridge.answerPrompt === undefined || prompt === null || this.card(host.id, paneId).busy) return null;
    const episode = prompt.episode;
    this.update(host.id, paneId, (card) => ({ ...card, busy: true, note: null, boxNote: null, terminal: null }));
    let result: AnswerResult;
    try {
      result = await bridge.answerPrompt({
        hostId: host.id,
        paneId,
        binding: stopBindingOf(host, paneId, agentName(kind)),
        fingerprint: match.fingerprint,
        episode,
        key: option.key,
        ...(text === undefined ? {} : { text }),
      });
    } catch (error) {
      result = { type: "refused", note: error instanceof Error ? error.message : String(error) };
    }
    const fromBox = text !== undefined;
    // The pane may show the next question by now (its push came before this reply). A
    // result marks Sent only while the card still shows this block and no whole frame of another question.
    const now = this.forPane(host.id, paneId);
    const nowShown = now === null || now.reading === null ? null : readingMatch(now.reading);
    const same = now !== null && now.episode === episode && (nowShown === null || sameFingerprint(nowShown.fingerprint, match.fingerprint));
    this.update(host.id, paneId, (card) => {
      const done = { ...card, busy: false };
      if (!same && (result.type === "sent" || result.type === "unconfirmed")) return done;
      if (!same && result.type === "answeredOnly") return { ...done, boxNote: result.note };
      switch (result.type) {
        case "sent":
          return { ...done, sent: { label: result.label, fingerprint: match.fingerprint, episode }, note: null, boxNote: null };
        case "unconfirmed":
          return { ...done, sent: { label: result.label, fingerprint: match.fingerprint, episode }, note: result.note };
        case "answeredOnly":
          return { ...done, sent: { label: result.label, fingerprint: match.fingerprint, episode }, note: null, boxNote: result.note };
        case "changed":
          return fromBox ? { ...done, boxNote: result.note } : { ...done, note: result.note };
        // Stopped for your Terminal input: Answer in Terminal too.
        case "refused": {
          const terminal = result.terminal === true ? { terminal: { episode } } : {};
          return fromBox ? { ...done, boxNote: result.note, ...terminal } : { ...done, note: result.note, ...terminal };
        }
        // The card stays as the screen says, with Answer in Terminal.
        case "unsettled":
          return { ...done, note: result.note, terminal: { episode } };
      }
    });
    return result;
  }
}

export const needsCards = new NeedsCardStore();

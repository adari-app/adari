// The needs-you card's main process half (the Swift app's
// CompanionPromptAnswerer, its paneIO, and CompanionComposerModel's
// answerWithMessage).
//
// - While Herdr says a pane's agent is blocked or input-pending, and only while
//   its machine is connected, its screen is read (`pane.read`, plain text, 40
//   lines) every 2.5 s, one read at a time per pane; the matcher's reading goes
//   to the page (PanePrompt). No other pane is ever read.
// - An answer (AnswerRequest) is bound like Stop (src/main/herdr/stop.ts): the
//   machine's entry, connection and command connection the page saw, then a
//   fresh snapshot that still shows the same agent waiting; then the answerer
//   reads the pane again and sends the option's keys (`pane.send_keys`, as the
//   Swift app does: Herdr refuses agent input while the agent is blocked) only
//   while the question on screen has the fingerprint the page showed, with
//   nothing awaited between the last check and the keys. The keys are the
//   option's as main read it, never the page's.
// - The "No, tell…" option with text: the option first, then, once Herdr says
//   the agent is idle or done and its own empty text field shows, the text as
//   one agent.prompt (within 4 s; otherwise the text stays in the box).
// - The user's own Terminal input on this
//   machine (PaneInputs, the counter the chip picks use) is noted when an
//   answer begins and compared in the last gate, beside the connection, agent
//   and block checks: any input meanwhile (a key that cancelled the question
//   the last read still showed) sends nothing, keeps no claim, and the card
//   says Answer in Terminal. Every answer that sends keys: Claude's and
//   Codex's menus and [y/N] lines, Codex's form, Grok's frame, the box's
//   "No, tell…". Input from another device, or typed into Herdr on the Mac,
//   is not seen here.
// - Every read of a Claude pane for the card (the
//   watch's and an answer's) is readPromptScreen's: 40 lines, then once 200
//   when the 40 end in Claude's frame cut off at its top (a command or diff
//   taller than the read). A frame still cut after it is unmatched, so it is
//   never answered here.

import type { HerdrHostBackend, PromptPaneCalls } from "../herdr/backend";
import { APIError, type AgentInfo, type SessionTopology, type TopologyPaneInfo } from "../herdr/wire";
import type { ConnectionIdentity } from "../hosts";
import type { PaneInputs } from "../pane-inputs";
import type { HostView } from "../../shared/ipc-contract";
import { agentKind, agentSession } from "../../shared/send-binding";
import { PaneReadGate } from "../../shared/chat/live-reader";
import { episodeOf, type StopBinding } from "../../shared/agent-stop";
import { answerPrompt } from "../../shared/prompt/answerer";
import {
  matchPrompt,
  optionByKey,
  type PromptFingerprint,
  promptReadLines,
  readingForAgent,
  readingMatch,
  readPromptScreen,
  sameFingerprint,
  showsInputPrompt,
  type PromptReading,
} from "../../shared/prompt/matcher";
import { afterRead, marked, type QuietState } from "../../shared/prompt/quiet";
import { answerTexts, paneBlocked, promptEpisode, type AnswerRequest, type AnswerResult, type PanePrompt } from "../../shared/prompt/view";

/** What the service needs of the machines (HostRegistry has it all). */
export interface PromptHosts {
  list(): HostView[];
  backend(hostId: string): HerdrHostBackend | null;
  name(hostId: string): string | null;
  /** The answering connection's number; null while it does not answer. */
  connection(hostId: string): number | null;
  connectionIdentity(hostId: string): ConnectionIdentity | null;
  snapshotEpoch(hostId: string): number | null;
  fresh(hostId: string): Promise<boolean>;
  pane(hostId: string, paneId: string): TopologyPaneInfo | null;
  agent(hostId: string, paneId: string): AgentInfo | null;
  refresh(hostId: string): Promise<void>;
}

export interface PromptClock {
  now(): number;
  sleep(ms: number): Promise<void>;
  every(ms: number, tick: () => void): () => void;
}

export const realPromptClock: PromptClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  every: (ms, tick) => {
    const timer = setInterval(tick, ms);
    return () => clearInterval(timer);
  },
};

/** How often a blocked pane is read (every 2 to 3 s). */
export const promptReadIntervalMs = 2_500;
/** How long the text after a "No, tell…" option waits for the agent's empty field, and how often it looks. */
export const fieldWaitMs = 4_000;
export const fieldPollMs = 250;

interface Watch {
  readonly hostId: string;
  readonly paneId: string;
  readonly episode: string;
  readonly kind: string | null;
  /** The machine's entry and connection the block was seen on (and its command connection's epoch). */
  readonly incarnation: number;
  readonly connection: number;
  readonly epoch: number | null;
  /** When the app first saw this block. */
  readonly since: number;
  reading: PromptReading | null;
  /** The two-read rule's state (quiet.ts). */
  quiet: QuietState;
  /** A read of it is under way. */
  inFlight: boolean;
}

const keyOf = (hostId: string, paneId: string): string => `${hostId}\u0000${paneId}`;

/**
 * As the Swift app's CompanionAnswerOutbox claim: an answer's
 * keys went, or may have, to this question in this block. Another answer for
 * the pane is refused until a whole frame shows another question, or a
 * snapshot of the connected machine shows another block or agent, or the pane
 * no longer blocked. A partly drawn, clipped or quiet read proves nothing and
 * keeps it.
 */
interface Claim {
  readonly hostId: string;
  readonly episode: string;
  readonly fingerprint: PromptFingerprint;
}

function blockedPanes(topology: SessionTopology): { pane: TopologyPaneInfo; agent: AgentInfo | null }[] {
  return topology.panes
    .map((pane) => ({ pane, agent: topology.agents.find((candidate) => candidate.paneID === pane.paneID) ?? null }))
    .filter(({ pane, agent }) => paneBlocked(pane, agent));
}

export class PromptService {
  private readonly watches = new Map<string, Watch>();
  /** Per pane: the answer under way (a second one is refused). */
  private readonly answering = new Set<string>();
  /** Per pane, the question an answer went to. */
  private readonly claims = new Map<string, Claim>();
  private stopTimer: (() => void) | null = null;
  private last = "[]";

  constructor(
    private readonly hosts: PromptHosts,
    /** Every blocked pane's reading, whenever one changes. */
    private readonly push: (prompts: PanePrompt[]) => void,
    private readonly clock: PromptClock = realPromptClock,
    /** The panes with a read out, shared with Chat's live reads: a pane is never read twice at once. */
    private readonly gate: PaneReadGate = new PaneReadGate(),
    /** Each pane's Terminal input on this machine; absent: not counted here. */
    private readonly inputs?: Pick<PaneInputs, "generation">,
  ) {}

  start(intervalMs = promptReadIntervalMs): void {
    this.stop();
    this.stopTimer = this.clock.every(intervalMs, () => void this.tick());
    void this.tick();
  }

  stop(): void {
    this.stopTimer?.();
    this.stopTimer = null;
  }

  list(): PanePrompt[] {
    return [...this.watches.values()].map((watch) => ({
      hostId: watch.hostId,
      paneId: watch.paneId,
      episode: watch.episode,
      incarnation: watch.incarnation,
      connection: watch.connection,
      epoch: watch.epoch,
      reading: watch.reading,
      quiet: watch.quiet.lastQuietAt !== null,
      cleared: watch.quiet.cleared,
    }));
  }

  private emit(): void {
    const prompts = this.list();
    const text = JSON.stringify(prompts);
    if (text === this.last) return;
    this.last = text;
    this.push(prompts);
  }

  /**
   * One round: the blocked panes of the connected machines by their last
   * snapshots, each read once (unless a read of it is still under way); the
   * rest forgotten.
   */
  async tick(): Promise<void> {
    const seen = new Set<string>();
    const answering = new Set<string>();
    const reads: Promise<void>[] = [];
    for (const view of this.hosts.list()) {
      const connection = this.hosts.connection(view.id);
      if (view.state !== "connected" || connection === null || view.topology === null) continue;
      answering.add(view.id);
      for (const { pane, agent } of blockedPanes(view.topology)) {
        const key = keyOf(view.id, pane.paneID);
        seen.add(key);
        const episode = promptEpisode(pane, agent);
        const epoch = this.hosts.connectionIdentity(view.id)?.epoch ?? null;
        let watch = this.watches.get(key);
        if (
          watch === undefined ||
          watch.episode !== episode ||
          watch.connection !== connection ||
          watch.incarnation !== (view.incarnation ?? 0) ||
          watch.epoch !== epoch
        ) {
          watch = {
            hostId: view.id,
            paneId: pane.paneID,
            episode,
            kind: agentKind(agent, pane),
            incarnation: view.incarnation ?? 0,
            connection,
            epoch,
            since: this.clock.now(),
            reading: null,
            quiet: marked,
            inFlight: false,
          };
          this.watches.set(key, watch);
        }
        if (!watch.inFlight) reads.push(this.read(watch));
      }
    }
    for (const key of this.watches.keys()) if (!seen.has(key)) this.watches.delete(key);
    // A connected machine's snapshot shows the pane no longer blocked, or another block or agent: the claim ends.
    for (const [key, claim] of this.claims) {
      if (answering.has(claim.hostId) && (!seen.has(key) || this.watches.get(key)?.episode !== claim.episode)) this.claims.delete(key);
    }
    this.emit();
    await Promise.all(reads);
  }

  /** Reads the pane once; a read that crossed a reconnect, or a block that changed meanwhile, counts as failed. */
  private async read(watch: Watch): Promise<void> {
    const calls = this.hosts.backend(watch.hostId)?.promptIO?.();
    if (calls === undefined) return;
    // A live read of the pane is out: this round leaves it.
    const gateKey = keyOf(watch.hostId, watch.paneId);
    if (!this.gate.begin(gateKey)) return;
    watch.inFlight = true;
    const before = this.hosts.connectionIdentity(watch.hostId);
    const startedAt = this.clock.now();
    let text: string | null;
    try {
      // A Claude frame cut off at its top is read again, taller, once.
      text = await readPromptScreen((lines) => calls.paneRead(watch.paneId, lines), watch.kind);
    } catch {
      text = null;
    }
    this.gate.end(gateKey);
    watch.inFlight = false;
    if (this.watches.get(keyOf(watch.hostId, watch.paneId)) !== watch) return;
    const after = this.hosts.connectionIdentity(watch.hostId);
    const sameConnection =
      before !== null &&
      after !== null &&
      before.incarnation === after.incarnation &&
      before.epoch === after.epoch &&
      this.hosts.connection(watch.hostId) === watch.connection;
    this.observe(watch, sameConnection ? text : null, startedAt);
    this.emit();
  }

  /** A read's text (null: it failed or proves nothing). */
  private observe(watch: Watch, text: string | null, startedAt: number): void {
    if (text !== null) {
      // The pane's agent picks the reader (a Grok pane reads Grok 1.0.70's approval frame).
      watch.reading = readingForAgent(matchPrompt(text, watch.paneId, watch.kind), watch.kind);
      // A whole frame of another question ends the claim; anything else keeps it.
      const key = keyOf(watch.hostId, watch.paneId);
      const claim = this.claims.get(key);
      const shown = readingMatch(watch.reading);
      if (claim !== undefined && shown !== null && !sameFingerprint(shown.fingerprint, claim.fingerprint)) this.claims.delete(key);
    }
    // Two quiet reads in a row clear the mark; a prompt, or a read that failed, brings it back.
    // Read as the pane's agent (Grok's frame rows count on a Grok pane only).
    watch.quiet = afterRead(watch.quiet, { startedAt, text }, watch.since, watch.kind);
  }

  /** The machine's entry and connections now, as a Stop binding names them. */
  private identity(hostId: string): { incarnation: number; connection: number | null; epoch: number | null } | null {
    const identity = this.hosts.connectionIdentity(hostId);
    return identity === null ? null : { incarnation: identity.incarnation, connection: this.hosts.connection(hostId), epoch: identity.epoch };
  }

  /** The page's connection and command connection are the machine's now (an epoch must be known). */
  private onPageConnection(hostId: string, expected: StopBinding): boolean {
    const now = this.identity(hostId);
    return (
      now !== null &&
      now.incarnation === expected.incarnation &&
      now.connection === expected.connection &&
      now.epoch !== null &&
      now.epoch === expected.epoch
    );
  }

  /** Why the agent the page saw waiting is not the one in the pane now; null when it is. */
  private refusal(expected: StopBinding, pane: TopologyPaneInfo | null, agent: AgentInfo | null): string | null {
    if (pane === null) return answerTexts.paneGone;
    if (expected.terminalID !== "" && pane.terminalID !== expected.terminalID) return answerTexts.otherAgent;
    const kind = agentKind(agent, pane);
    if (kind === null || (expected.kind !== null && kind !== expected.kind)) return answerTexts.otherAgent;
    const session = agentSession(agent);
    if (expected.session !== null && session !== expected.session) return answerTexts.otherAgent;
    if (!paneBlocked(pane, agent)) return answerTexts.notAsking(expected.name);
    return null;
  }

  /**
   * Why the reading `watch` holds is not the question
   * of the agent the page saw, by the last snapshot (synchronous: the last
   * gate calls it right before the keys); null when it is. The watch must be
   * main's current one, read on the page's machine entry and connection, and
   * the pane must still show the agent of `expected` in the block the
   * reading was taken in (terminal, kind, session, status and its change).
   */
  private stale(hostId: string, paneId: string, expected: StopBinding, watch: Watch): string | null {
    const machine = this.hosts.name(hostId) ?? "the machine";
    if (this.watches.get(keyOf(hostId, paneId)) !== watch) return answerTexts.notAsking(expected.name);
    if (watch.incarnation !== expected.incarnation || watch.connection !== expected.connection || watch.epoch !== expected.epoch) {
      return answerTexts.connectionChanged(machine);
    }
    const pane = this.hosts.pane(hostId, paneId);
    const agent = this.hosts.agent(hostId, paneId);
    const refusal = this.refusal(expected, pane, agent);
    if (refusal !== null) return refusal;
    const now = episodeOf(pane, agent);
    const same = now.status === expected.episode.status && now.seq === expected.episode.seq && now.since === expected.episode.since;
    if (!same || pane === null || promptEpisode(pane, agent) !== watch.episode) return answerTexts.notAsking(expected.name);
    return null;
  }

  /** Answers from the page: one at a time per pane. */
  async answer(request: AnswerRequest): Promise<AnswerResult> {
    const key = keyOf(request.hostId, request.paneId);
    if (this.answering.has(key)) return { type: "refused", note: answerTexts.busy };
    this.answering.add(key);
    try {
      return await this.answerNow(request);
    } finally {
      this.answering.delete(key);
    }
  }

  private async answerNow(request: AnswerRequest): Promise<AnswerResult> {
    const { hostId, paneId, binding, fingerprint, text } = request;
    // The user's Terminal input so far; the last gate stops the answer at any change.
    const typedAt = this.inputs?.generation(hostId, paneId);
    const machine = this.hosts.name(hostId) ?? "the machine";
    const kept = (note: string): string => (text === undefined || note.endsWith("kept.") ? note : `${note}. The text is kept.`);
    const refused = (note: string): AnswerResult => ({ type: "refused", note: kept(note) });
    const backend = this.hosts.backend(hostId);
    const calls: PromptPaneCalls | undefined = backend?.promptIO?.();
    // One answer per question.
    if (this.claims.has(keyOf(hostId, paneId))) return refused(answerTexts.answered);
    if (backend === null || calls === undefined) return refused(answerTexts.offline(machine));
    const start = this.identity(hostId);
    if (start === null || start.connection === null) return refused(answerTexts.offline(machine));
    if (!this.onPageConnection(hostId, binding)) return refused(answerTexts.connectionChanged(machine));
    // The question the page showed must be the one main read last, and offer that option; its keys are main's.
    const watch = this.watches.get(keyOf(hostId, paneId));
    // The request names the reading (its block) it answers.
    const named = watch !== undefined && watch.episode === request.episode;
    const shown = !named || watch.reading === null ? null : readingMatch(watch.reading);
    const option = shown === null || !sameFingerprint(shown.fingerprint, fingerprint) ? null : optionByKey(shown, request.key);
    if (watch === undefined || shown === null || option === null) return { type: "changed", note: answerTexts.changed, now: watch?.reading ?? { type: "unmatched", lines: [] } };
    // A choice answered in the Terminal (Codex's update question): nothing is ever sent for it.
    if (option.inTerminal === true || option.keys.length === 0) return { type: "refused", note: answerTexts.inTerminal, terminal: true };
    if (text !== undefined) {
      if (!option.opensComposer) return refused(answerTexts.noText(option.label));
      if (text.trim() === "") return refused(answerTexts.emptyText);
    }
    const checked = await this.hosts.fresh(hostId);
    const now = this.identity(hostId);
    if (now === null || now.incarnation !== binding.incarnation) return refused(answerTexts.connectionChanged(machine));
    if (now.connection === null) return refused(answerTexts.offline(machine));
    if (!checked) return refused(answerTexts.unchecked(binding.name));
    if (!this.onPageConnection(hostId, binding) || this.hosts.snapshotEpoch(hostId) !== binding.epoch) return refused(answerTexts.connectionChanged(machine));
    const refusal = this.stale(hostId, paneId, binding, watch);
    if (refusal !== null) return refused(refusal);
    let late = null as string | null;
    let typed = false;
    const outcome = await answerPrompt(
      // The fingerprint's read takes the pane's turn with the live and watch reads.
      {
        // Read as the watch reads it (the taller read when the frame is cut off).
        read: (pane) => this.gate.reading(keyOf(hostId, pane), () => readPromptScreen((lines) => calls.paneRead(pane, lines), watch.kind)),
        sendKeys: (keys, pane) => calls.paneSendKeys(pane, keys),
        // Grok's wait between its key and the read that checks it, on the service's clock.
        sleep: (ms) => this.clock.sleep(ms),
      },
      option,
      shown,
      // Right before the keys, nothing awaited after: still the page's connection, the snapshot came on it,
      // and it still shows the same agent in the same block,
      // and nothing was typed into its Terminal here since the answer began.
      () => {
        if (!this.onPageConnection(hostId, binding) || this.hosts.snapshotEpoch(hostId) !== binding.epoch) return false;
        late = this.stale(hostId, paneId, binding, watch);
        if (late !== null) return false;
        typed = typedAt !== undefined && this.inputs?.generation(hostId, paneId) !== typedAt;
        return !typed;
      },
    );
    switch (outcome.type) {
      case "changed": {
        const reading = readingForAgent(outcome.now, watch?.kind ?? binding.kind);
        if (watch !== undefined && this.watches.get(keyOf(hostId, paneId)) === watch) {
          watch.reading = reading;
          this.emit();
        }
        return { type: "changed", note: text === undefined ? answerTexts.changed : `${answerTexts.changed}. The text is kept.`, now: reading };
      }
      case "unread":
        return refused(answerTexts.unread(outcome.reason));
      case "withdrawn":
        // Nothing went and no claim is kept; the card offers Answer in Terminal.
        if (typed) return { type: "refused", note: kept(answerTexts.typedMeanwhile), terminal: true };
        return refused(late ?? answerTexts.connectionChanged(machine));
      case "refused":
        return refused(outcome.reason);
      case "unconfirmed":
        this.claims.set(keyOf(hostId, paneId), { hostId, episode: watch.episode, fingerprint: shown.fingerprint });
        void this.hosts.refresh(hostId);
        return text === undefined
          ? { type: "unconfirmed", label: option.label, note: answerTexts.unconfirmed }
          : { type: "answeredOnly", label: option.label, note: answerTexts.textUnconfirmed(option.label) };
      case "sent":
        this.claims.set(keyOf(hostId, paneId), { hostId, episode: watch.episode, fingerprint: shown.fingerprint });
        break;
      case "unsettled": {
        // Grok's digit went, its screen did not show the frame gone: nothing more goes
        // (this question is answered once), the card shows what the screen showed and Answer in Terminal.
        this.claims.set(keyOf(hostId, paneId), { hostId, episode: watch.episode, fingerprint: shown.fingerprint });
        if (outcome.now !== null && this.watches.get(keyOf(hostId, paneId)) === watch) {
          watch.reading = readingForAgent(outcome.now, watch.kind);
          this.emit();
        }
        void this.hosts.refresh(hostId);
        return { type: "unsettled", label: option.label, note: answerTexts.unsettled(binding.name) };
      }
    }
    void this.hosts.refresh(hostId);
    if (text === undefined) return { type: "sent", label: option.label };
    return this.sendText(request, backend, calls, option.label, machine);
  }

  /**
   * The text after a "No, tell…" option: once Herdr says the agent is idle or
   * done and a read shows its own empty text field, one agent.prompt; nothing
   * awaited between that read and the prompt but the prompt.
   */
  private async sendText(request: AnswerRequest, backend: HerdrHostBackend, calls: PromptPaneCalls, label: string, machine: string): Promise<AnswerResult> {
    const { hostId, paneId, binding } = request;
    const text = request.text ?? "";
    const notSent = (reason: string): AnswerResult => ({ type: "answeredOnly", label, note: answerTexts.textNotSent(label, reason) });
    /**
     * The text's destination by the last snapshot
     * (synchronous): the page's machine entry, connection and epoch, a
     * snapshot from it and the same writer; the same terminal, kind and
     * session; "wait" while the agent is not idle or done with no input
     * pending. Null when the text may go.
     */
    const destination = (): string | "wait" | null => {
      if (!this.onPageConnection(hostId, binding) || this.hosts.snapshotEpoch(hostId) !== binding.epoch || this.hosts.backend(hostId) !== backend) {
        return `the connection to ${machine} changed`;
      }
      const pane = this.hosts.pane(hostId, paneId);
      const agent = this.hosts.agent(hostId, paneId);
      if (pane === null) return "the agent is gone";
      const kind = agentKind(agent, pane);
      if (
        (binding.terminalID !== "" && pane.terminalID !== binding.terminalID) ||
        kind === null ||
        (binding.kind !== null && kind !== binding.kind) ||
        (binding.session !== null && agentSession(agent) !== binding.session)
      ) {
        return "another agent is in this pane now";
      }
      const status = agent?.agentStatus ?? pane.agentStatus;
      return (status !== "idle" && status !== "done") || agent?.inputPending === true ? "wait" : null;
    };
    const deadline = this.clock.now() + fieldWaitMs;
    while (this.clock.now() < deadline) {
      await this.clock.sleep(fieldPollMs);
      if (!(await this.hosts.fresh(hostId))) continue;
      const before = destination();
      if (before === "wait") continue;
      if (before !== null) return notSent(before);
      let screen: string;
      try {
        // The field's read takes the pane's turn too.
        screen = await this.gate.reading(keyOf(hostId, paneId), () => calls.paneRead(paneId, promptReadLines));
      } catch {
        continue;
      }
      if (!showsInputPrompt(screen, binding.kind)) continue;
      // Right before the text, nothing awaited after: the same destination, still ready.
      const after = destination();
      if (after !== null) return notSent(after === "wait" ? `${binding.name} is not waiting for text now` : after);
      try {
        await backend.prompt(paneId, text);
      } catch (error) {
        return error instanceof APIError ? notSent(`Herdr refused the message (${error.code})`) : notSent(`${binding.name} did not take it`);
      }
      void this.hosts.refresh(hostId);
      return { type: "sent", label };
    }
    return notSent(`${binding.name} did not open its text field yet`);
  }
}

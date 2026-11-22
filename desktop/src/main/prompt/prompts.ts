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
// - Antigravity CLI's own questions: an agy pane Herdr says is done or idle
//   (agy 1.5.13 reports `done` while its create and edit questions show) is
//   read too, by the same reads and gate: on sight of each new status (its
//   block, promptEpisode) and then every 2.5 s for its first 10 s, and for as
//   long as one of agy's questions shows. Only agy panes, never while working.
//   Its reading is listed (PanePrompt.whileNotBlocked) only while it is one of
//   agy's questions; the page shows the pane as needing you then
//   (applyAgyQuestions), and an answer is bound to that done or idle block as a
//   blocked pane's is to its block.
// - Codex's "Implement this
//   plan?" list the same way. Codex 0.171.0 marks its turn done before it draws
//   the list, and the list reports no blocking, so a Codex pane Herdr says is
//   done or idle is read on each new status, every 2.5 s for its first 10 s
//   (four reads), and for as long as the list shows. Its reading is listed only
//   while it is that list (`codexPlan`); every other screen on such a pane
//   makes no card and no needs-you mark.
// - Every read of a Claude pane for the card (the
//   watch's and an answer's) is readPromptScreen's: 40 lines, then once 200
//   when the 40 end in Claude's frame cut off at its top (a command or diff
//   taller than the read). A frame still cut after it is unmatched, so it is
//   never answered here.
// - "The same question" is matcher.ts
//   `sameFingerprint` everywhere here (the card's reading against main's last,
//   the answerer's fresh read, the claim): the question's words, not how its
//   rows wrap. Each answer not sent because the question changed is recorded
//   (`refusals`, the last 50, in memory; Report a Problem carries them):
//   `shown` (main's last reading is not the card's), `fresh` (the read before
//   the key), `trustStep` (agy's trust read between the arrow and Return).

import type { HerdrHostBackend, PromptPaneCalls } from "../herdr/backend";
import { APIError, type AgentInfo, type SessionTopology, type TopologyPaneInfo } from "../herdr/wire";
import type { ConnectionIdentity } from "../hosts";
import type { PaneInputs } from "../pane-inputs";
import type { HostView } from "../../shared/ipc-contract";
import { agentKind, agentSession } from "../../shared/send-binding";
import { PaneReadGate } from "../../shared/chat/live-reader";
import { episodeOf, type StopBinding } from "../../shared/agent-stop";
import { answerPrompt, readWithColumns } from "../../shared/prompt/answerer";
import {
  agyKind,
  matchPrompt,
  optionByKey,
  type PromptFingerprint,
  promptReadLines,
  readingForAgent,
  readingMatch,
  readPromptScreen,
  sameFingerprint,
  showsInputPrompt,
  type PromptMatch,
  type PromptReading,
} from "../../shared/prompt/matcher";
import { afterRead, marked, type QuietState } from "../../shared/prompt/quiet";
import { RefusalLog, refusalRecord, type RefusalPlace } from "../../shared/prompt/refusals";
import { answerTexts, doneAskingPane, paneBlocked, promptEpisode, showsDoneQuestion, type AnswerRequest, type AnswerResult, type PanePrompt } from "../../shared/prompt/view";

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
/** How long after an agy pane is seen done or idle (a new block) it is read while none of agy's questions shows. */
export const agyDoneWindowMs = 10_000;

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
  /** An agy or Codex pane read while Herdr says done or idle (doneAskingPane), not blocked. */
  readonly whileNotBlocked: boolean;
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

/**
 * The panes read: every blocked one, and every agy or Codex pane Herdr says is done or idle (agy's own questions show
 * then; Codex's "Implement this plan?" list does). No other pane, and no other kind's done or idle pane.
 */
function readPanes(topology: SessionTopology): { pane: TopologyPaneInfo; agent: AgentInfo | null; whileNotBlocked: boolean }[] {
  return topology.panes.flatMap((pane): { pane: TopologyPaneInfo; agent: AgentInfo | null; whileNotBlocked: boolean }[] => {
    const agent = topology.agents.find((candidate) => candidate.paneID === pane.paneID) ?? null;
    if (paneBlocked(pane, agent)) return [{ pane, agent, whileNotBlocked: false }];
    return doneAskingPane(pane, agent) ? [{ pane, agent, whileNotBlocked: true }] : [];
  });
}


/**
 * The pane's width in columns around a read, for the readers that use it (Codex's, whose
 * frame shows no width): its cell rectangle in `pane.layout` (Herdr's panes tile the tab with no border, so a pane's
 * rectangle is its terminal). Undefined for any other agent's pane, so no layout call is made for it.
 */
function paneColumns(calls: PromptPaneCalls, paneId: string, kind: string | null): (() => Promise<number | null>) | undefined {
  const layout = calls.paneLayout;
  if (kind?.toLowerCase() !== "codex" || layout === undefined) return undefined;
  return async () => (await layout.call(calls, paneId)).panes.find((pane) => pane.paneId === paneId)?.rect.width ?? null;
}
export class PromptService {
  private readonly watches = new Map<string, Watch>();
  /** Per pane: the answer under way (a second one is refused). */
  private readonly answering = new Set<string>();
  /** Per pane, the question an answer went to. */
  private readonly claims = new Map<string, Claim>();
  private stopTimer: (() => void) | null = null;
  private last = "[]";
  /** Each answer not sent because the question changed (counts only), for Report a Problem. */
  readonly refusals = new RefusalLog();

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
    // A done or idle agy pane's reading only while it is one of agy's questions; a Codex pane's while it is the plan list.
    return [...this.watches.values()]
      .filter((watch) => !watch.whileNotBlocked || showsDoneQuestion(watch.reading))
      .map((watch) => ({
        hostId: watch.hostId,
        paneId: watch.paneId,
        episode: watch.episode,
        incarnation: watch.incarnation,
        connection: watch.connection,
        epoch: watch.epoch,
        reading: watch.reading,
        quiet: watch.quiet.lastQuietAt !== null,
        cleared: watch.quiet.cleared,
        ...(watch.whileNotBlocked ? { whileNotBlocked: true as const } : {}),
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
      for (const { pane, agent, whileNotBlocked } of readPanes(view.topology)) {
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
            whileNotBlocked,
          };
          this.watches.set(key, watch);
        }
        // A done or idle agy or Codex pane: in its first 10 s, and while its question (agy's, Codex's plan list) shows.
        const due = !watch.whileNotBlocked || showsDoneQuestion(watch.reading) || this.clock.now() - watch.since < agyDoneWindowMs;
        if (!watch.inFlight && due) reads.push(this.read(watch));
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

  /**
   * A Send's own read of an agy pane Herdr says is idle or done (send.ts sendBoundNow, before any text), through the
   * pane's read gate (waiting its turn, never two reads of a pane at once): the text, or null when there is no reader,
   * the read failed or it crossed a reconnect. A question it shows becomes the pane's card as the watch's own read
   * would (the watch of this block, on this connection, takes the reading).
   */
  async sendRead(hostId: string, paneId: string): Promise<string | null> {
    const calls = this.hosts.backend(hostId)?.promptIO?.();
    const before = this.hosts.connectionIdentity(hostId);
    const connection = this.hosts.connection(hostId);
    if (calls === undefined || before === null || connection === null) return null;
    const startedAt = this.clock.now();
    let text: string | null;
    try {
      text = await this.gate.reading(keyOf(hostId, paneId), () => readPromptScreen((lines) => calls.paneRead(paneId, lines), agyKind));
    } catch {
      text = null;
    }
    const after = this.hosts.connectionIdentity(hostId);
    if (text === null || after === null || after.incarnation !== before.incarnation || after.epoch !== before.epoch || this.hosts.connection(hostId) !== connection) return null;
    const watch = this.watches.get(keyOf(hostId, paneId));
    const pane = this.hosts.pane(hostId, paneId);
    const agent = this.hosts.agent(hostId, paneId);
    if (watch !== undefined && watch.whileNotBlocked && watch.connection === connection && pane !== null && promptEpisode(pane, agent) === watch.episode) {
      this.observe(watch, text, startedAt);
      this.emit();
    }
    return text;
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
    let columns: number | null = null;
    try {
      // A Claude frame cut off at its top is read again, taller, once; the pane's width around it.
      const screen = await readWithColumns(() => readPromptScreen((lines) => calls.paneRead(watch.paneId, lines), watch.kind), paneColumns(calls, watch.paneId, watch.kind));
      text = screen.text;
      columns = screen.columns;
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
    this.observe(watch, sameConnection ? text : null, startedAt, columns);
    this.emit();
  }

  /** A read's text (null: it failed or proves nothing). */
  private observe(watch: Watch, text: string | null, startedAt: number, columns: number | null = null): void {
    if (text !== null) {
      // The pane's agent picks the reader (a Grok pane reads Grok 1.0.70's approval frame).
      watch.reading = readingForAgent(matchPrompt(text, watch.paneId, watch.kind, columns), watch.kind);
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
  private refusal(expected: StopBinding, pane: TopologyPaneInfo | null, agent: AgentInfo | null, whileNotBlocked = false): string | null {
    if (pane === null) return answerTexts.paneGone;
    if (expected.terminalID !== "" && pane.terminalID !== expected.terminalID) return answerTexts.otherAgent;
    const kind = agentKind(agent, pane);
    if (kind === null || (expected.kind !== null && kind !== expected.kind)) return answerTexts.otherAgent;
    const session = agentSession(agent);
    if (expected.session !== null && session !== expected.session) return answerTexts.otherAgent;
    // A done or idle pane's question (agy's, Codex's plan list): the pane still done or idle; else blocked.
    if (!(whileNotBlocked ? doneAskingPane(pane, agent) : paneBlocked(pane, agent))) return answerTexts.notAsking(expected.name);
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
    const refusal = this.refusal(expected, pane, agent, watch.whileNotBlocked);
    if (refusal !== null) return refusal;
    const now = episodeOf(pane, agent);
    const same = now.status === expected.episode.status && now.seq === expected.episode.seq && now.since === expected.episode.since;
    if (!same || pane === null || promptEpisode(pane, agent) !== watch.episode) return answerTexts.notAsking(expected.name);
    return null;
  }

  /** One record of an answer not sent because the question changed: the part that differed and the two readings' shapes. */
  private noteRefusal(agent: string | null, place: RefusalPlace, shown: Pick<PromptMatch, "kind" | "fingerprint">, now: Pick<PromptMatch, "kind" | "fingerprint"> | null): void {
    this.refusals.record(refusalRecord(this.clock.now(), agent, place, shown, now));
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
    if (watch === undefined || shown === null || option === null) {
      // The page's question is known by its fingerprint alone: compared as one of the same kind (a kind of its own shows in its words).
      const kind = shown?.kind ?? "menu";
      this.noteRefusal(watch?.kind ?? binding.kind, "shown", { kind, fingerprint }, shown);
      return { type: "changed", note: answerTexts.changed, now: watch?.reading ?? { type: "unmatched", lines: [] } };
    }
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
        // The pane's width around each read, for the readers that use it.
        columns: (pane) => paneColumns(calls, pane, watch.kind)?.() ?? Promise.resolve(null),
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
      // Each refusal because the question changed: recorded, counts only.
      (place, now) => this.noteRefusal(watch.kind ?? binding.kind, place, shown, now),
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

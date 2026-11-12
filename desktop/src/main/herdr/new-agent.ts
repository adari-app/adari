// New agent (Sources/HerdrKit/WorkspaceActions.swift newAgent, newPane):
// a new tab in the workspace at the folder (focus unchanged), then
//
// - an agent: `agent.list` (to pick a name no agent has), `tab.create`
//   labelled with that name, then `agent.start` (Herdr runs the kind's own
//   executable), or, with a start command for the kind on the Mac
//   (`~/.adari/agents.json`, the user's `{"claude": "cl"}`), the command
//   and Return typed into the new pane's shell (only a plain command: the
//   executable and plain words, the Resume chip's rule; any other goes to
//   `agent.start` with a line saying why) (one `pane.send_input`) and
//   `agent.list` once a second until Herdr reports that kind in that pane (at
//   most 90 seconds; the pane stays either way, showing what the shell printed).
//   A refused start closes the pane it made (`pane.close`), so a retry leaves
//   no orphan tab; typing that got no answer may have arrived: the pane stays
//   and the wait decides. Never `agent.restart` or a session transfer;
// - a shell: `tab.create` alone.
//
// No first message: the agent starts at its prompt (the desktop's New agent
// has no message field).
//
// Where: a new tab as above, or a split of the focused pane right or down
// (`pane.split`, Herdr's focus left where it is, the folder as cwd), the agent
// then started in the new pane the same way. The split pane gets no label
// (Herdr names a tab, not a pane); a refused start closes it as it closes a
// tab's pane.
//
// Starting (as Herdr 0.9.5 behaves on a clean home): the folder goes as a whole
// path (folder-cwd.ts, `~` read as the machine's home); a new pane Herdr put
// elsewhere is said so; a new shell still in its startup files
// (`agent_pane_busy`) is asked again every 250 ms for 15 s, the same pane,
// never a second one; an agent at its own screen (`agent_not_ready`, signing
// in) keeps its pane and is shown; a shell that says it cannot find the program
// is named ("… is not installed on …"), read for at most 3 s after Herdr's
// start and on every look of the typed command's wait; Herdr's refusals in its
// words, never its codes.
//
// Bound to the machine and kept in time:
// - every request after the folder is read (the name's agent.list,
//   tab.create or pane.split, each agent.start, the typed pane.send_input, each
//   look's pane.read and agent.list, the cleanup pane.close) is checked against
//   the machine link (machine-link.ts) right before it goes, nothing awaited
//   between. A machine removed, edited, not answering or reconnected since stops
//   New agent with a plain line and nothing more is sent: never a request on a
//   new connection, never a reconnect to close an old pane id.
// - one deadline per phase (the busy retry's 15 s, the look's 3 s,
//   the typed wait's 90 s), checked before each request and after every await
//   and every sleep's wake; a read waits at most the time left (the clock's
//   alarm) and a reply that comes after the deadline is not used. A start whose
//   answer did not come keeps its pane: it may still be coming up.

import { knownAgentName } from "../../shared/agent-names";
import type { PaneBinding } from "../../shared/pane-binding";
import type { AgentStartCommands } from "../../shared/start-commands";
import { typedStart } from "../../shared/start-commands";
import { herdrStartArgs } from "../../shared/codex-start";
import { flagWords, isPlainWord, typedFlags, type StartFlag } from "../../shared/model-choices";
import { RequestTimedOutError } from "./errors";
import { placedElsewhere, resolveFolderCwd, type FolderMachine } from "./folder-cwd";
import type { MachineLink } from "./machine-link";
import type { SplitParams } from "./pane-methods";
import { APIError, type AgentInfo, type TabCreation, type TopologyPaneInfo, type WorkspaceCreation } from "./wire";

/** What New agent needs of Herdr (HerdrClient has it). */
export interface NewAgentHerdr {
  agentList(): Promise<AgentInfo[]>;
  createTerminalTab(workspaceID: string, label: string | null, cwd: string | null): Promise<TabCreation>;
  /** `args` for Herdr's start (Codex's `["--no-daemon"]`; absent for every other kind). */
  startAgent(name: string, kind: string, paneID: string, args?: readonly string[]): Promise<AgentInfo>;
  closePane(paneID: string): Promise<void>;
  sendInput(pane: string, text: string, keys: readonly string[]): Promise<void>;
  /** Where is a split: `pane.split` (absent where the machine cannot split). */
  splitPane?(split: SplitParams): Promise<TopologyPaneInfo>;
  /** The new pane's recent text (`pane.read`), read for a missing program's line; absent where it cannot. */
  paneText?(paneID: string, lines: number): Promise<string>;
  /** New workspace: `workspace.create` (absent where the machine cannot make one; new-workspace.ts). */
  createWorkspace?(label: string, cwd: string | null): Promise<WorkspaceCreation>;
}

export interface NewAgentClock {
  now(): number;
  sleep(ms: number): Promise<void>;
  /**
   * A timer that ends the wait for a reply at a deadline (it rings after `ms`; `cancel` stops
   * it). Absent (a test's clock): a reply is still checked against the deadline when it comes.
   */
  alarm?(ms: number): { readonly rang: Promise<void>; cancel(): void };
}

export const liveClock: NewAgentClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  alarm: (ms) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const rang = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, Math.max(0, ms));
    });
    return { rang, cancel: () => clearTimeout(timer) };
  },
};

/**
 * Where the new pane goes: a new tab of the workspace, or a split of a pane in
 * it, bound to that pane as the window showed it (src/shared/pane-binding.ts;
 * optional here, required from the page).
 */
export type NewAgentWhere =
  | { readonly type: "tab" }
  | { readonly type: "split"; readonly direction: "right" | "down"; readonly targetPaneId: string; readonly binding?: PaneBinding };

/** What to start: an agent kind ("claude", "codex", "grok", …) or "shell". */
export interface NewAgentRequest {
  readonly workspaceId: string;
  readonly folder: string | null;
  readonly kind: string;
  /** A new tab when absent. */
  readonly where?: NewAgentWhere;
  /**
   * New agent's Model and Effort (absent or null: the agent's default, no flag);
   * main checks each against the machine's list for the agent before anything is made (model-choices.ts startFlags).
   */
  readonly model?: string | null;
  readonly effort?: string | null;
}

export type NewAgentStart =
  | { readonly type: "herdr" }
  | { readonly type: "typed"; readonly command: string }
  | { readonly type: "noAgent"; readonly command: string }
  | { readonly type: "shell" };

export interface NewAgentResult {
  readonly paneId: string;
  readonly tabId: string;
  readonly name: string | null;
  readonly kind: string;
  readonly start: NewAgentStart;
  /** The line to show, or null: no agent after the command, or the configured command not typed. */
  readonly summary: string | null;
}

export const firstAgentTimeoutMs = 90_000;
export const agentPollMs = 1_000;

/** Herdr's agent name grammar `^[a-z][a-z0-9_-]{0,31}$` (AgentName.normalize). */
export function normalizeAgentName(raw: string): string {
  let out = "";
  for (const c of raw.toLowerCase()) {
    if (out === "") {
      if (c >= "a" && c <= "z") out += c;
    } else if ((c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c === "-" || c === "_") {
      out += c;
    } else {
      out += "-";
    }
    if (out.length >= 32) break;
  }
  return out === "" ? "agent" : out;
}

/** A name for a new `kind` agent no agent in `taken` has: the kind when free, else kind-2, kind-3, … */
export function agentName(kind: string, taken: ReadonlySet<string>): string {
  const base = normalizeAgentName(kind);
  if (!taken.has(base)) return base;
  for (let number = 2; ; number += 1) {
    const suffix = `-${number}`;
    const candidate = base.slice(0, 32 - suffix.length) + suffix;
    if (!taken.has(candidate)) return candidate;
  }
}

/** "Claude Code", "Codex", "Grok Build", … (the shared table's name), else the kind capitalised. */
export function kindTitle(kind: string): string {
  return knownAgentName(kind) ?? kind.slice(0, 1).toUpperCase() + kind.slice(1);
}


/** A start refused after its tab was made: the pane closed again (unless the close failed too). */
export class AgentStartFailed extends Error {
  constructor(
    readonly paneId: string,
    message: string,
    readonly paneClosed: boolean,
  ) {
    super(message);
    this.name = "AgentStartFailed";
  }
}

/**
 * The machine or connection New agent began on changed (machine-link.ts); the request was not
 * sent. Its message is the link's sentence.
 */
export class MachineChanged extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MachineChanged";
  }
}

/** `text` ending as a sentence ends (a full stop added when it has none). */
const sentence = (text: string): string => (/[.!?”"')]$/.test(text) ? text : `${text}.`);

/** The pane closed through `close` (bound to the machine link); a changed machine leaves it open and says so, a failed close too. */
async function failedStart(close: () => Promise<void>, paneId: string, message: string, place: "tab" | "pane"): Promise<AgentStartFailed> {
  try {
    await close();
    return new AgentStartFailed(paneId, message, true);
  } catch (error) {
    if (error instanceof MachineChanged) return new AgentStartFailed(paneId, newAgentTexts.leftOpen(message, error.message, place), false);
    return new AgentStartFailed(paneId, `${message} (its tab could not be closed)`, false);
  }
}

/** A message without Herdr's `snake_case:` code in front (`agent_pane_busy: …` reads as its words). */
export function withoutCode(text: string): string {
  let out = text.trim();
  for (let i = 0; i < 4; i += 1) {
    const next = out.replace(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+:\s*/, "");
    if (next === out) break;
    out = next;
  }
  return out === "" ? "it did not say why" : out;
}

/** What an error says, in words: Herdr's message without its code, any other error's own message. */
export function errorWords(error: unknown): string {
  if (error instanceof APIError) return withoutCode(error.serverMessage);
  return withoutCode(error instanceof Error ? error.message : String(error));
}

/** How long a new shell has to reach its prompt (`agent_pane_busy` answered meanwhile), and how often it is asked again. */
export const paneBusyTimeoutMs = 15_000;
export const paneBusyRetryMs = 250;
/** How long the new pane's text is read after Herdr's start for a missing program, how often, and how much. */
export const missingLookMs = 3_000;
export const missingPollMs = 500;
export const missingReadLines = 20;

/**
 * The machine New agent starts on: its name (for the lines), its home (for a `~` folder, folder-cwd.ts) and, from the
 * main process's door, its link (machine-link.ts; absent: nothing to check against).
 */
export type NewAgentMachine = FolderMachine & { readonly link?: MachineLink };

const unnamedMachine: NewAgentMachine = { name: "the machine" };

/** The sentences New agent says; no Herdr code in any. */
export const newAgentTexts = {
  busy: (machine: string, title: string) => `The new shell on ${machine} did not reach its prompt in 15 seconds, so ${title} was not started.`,
  waiting: (title: string) => `${title} started in its tab but is waiting there, for example to sign in. Answer it in the tab.`,
  notInstalled: (title: string, machine: string, line: string) => `${title} is not installed on ${machine}: its shell says “${line}”.`,
  refused: (title: string, message: string) => `Herdr did not start ${title}: ${message}`,
  notMade: (what: "tab" | "pane", message: string) => `Herdr did not make the new ${what}: ${message}`,
  elsewhere: (what: string, place: "tab" | "pane", shell: string, sent: string) =>
    `${what}, but its ${place} is in ${shell}, not ${sent} (Herdr could not use that folder).`,
  // The machine changed (`why`, the link's sentence); nothing more was sent.
  nothingMade: (why: string) => `${why} Nothing was made.`,
  notStarted: (why: string, title: string, place: "tab" | "pane") => `${why} ${title} was not started and nothing more was sent; its new ${place} was left as it is.`,
  notTyped: (why: string, command: string, place: "tab" | "pane") => `${why} “${command}” was not typed; its new ${place} was left as it is.`,
  leftOpen: (message: string, why: string, place: "tab" | "pane") => `${sentence(message)} ${why} Its ${place} was left open.`,
  lookStopped: (why: string, place: "tab" | "pane") => `${why} Nothing more was read from its ${place}.`,
  waitStopped: (why: string, title: string, command: string) => `${why} The wait for ${title} after typing “${command}” stopped. The pane is left open.`,
  // `unsure`: a start sent whose answer did not come; the pane stays.
  // A chosen model whose name Herdr's start cannot carry as a plain word (nothing was made).
  flagsNotPlain: (title: string) => `That model's name cannot go to Herdr's start of ${title} as it is. Set ${title}'s start command in Settings, or choose another model. Nothing was made.`,
  unsure: (title: string, machine: string, place: "tab" | "pane") =>
    `Herdr did not answer the start of ${title} on ${machine} in time, so it may still be coming up in its ${place}.`,
} as const;

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The line a shell prints when it cannot find `program`, from `text` (the pane's recent lines),
 * or null. Only these whole lines count: zsh `zsh: command not found: <name>`, bash `bash: <name>: command not found`
 * (also `-bash:` and `bash: line N:`), fish `fish: Unknown command: <name>`, sh `sh: <name>: not found` (also dash's
 * `sh: 1:`). Anything else in the pane (a file named "not found", the program's own words) is not acted on.
 */
export function missingProgramLine(text: string, program: string): string | null {
  if (program === "" || /\s/.test(program)) return null;
  const name = escaped(program);
  const shell = (names: string): string => `(?:\\S*/)?-?(?:${names})`;
  const patterns = [
    new RegExp(`^${shell("zsh")}: command not found: ${name}$`),
    new RegExp(`^${shell("bash")}: (?:line \\d+: )?${name}: command not found$`),
    new RegExp(`^${shell("fish")}: Unknown command: '?${name}'?$`),
    new RegExp(`^${shell("sh|dash|ash|ksh|mksh")}: (?:\\d+: )?(?:line \\d+: )?${name}: not found$`),
  ];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (patterns.some((pattern) => pattern.test(line))) return line;
  }
  return null;
}

/** The executable a typed start command runs (its first word). */
const programOf = (command: string): string => command.trim().split(/\s+/)[0] ?? "";

/** The agent in the pane is running its own program (it answers, or works): no shell line to look for. */
const programRuns = (info: AgentInfo | undefined): boolean =>
  info !== undefined && (info.interactiveReady === true || ["idle", "working", "blocked", "done"].includes(info.agentStatus ?? ""));


/** A read within its phase's deadline: its reply, the read failing, or no reply by the deadline. */
type Timed<T> = { readonly type: "value"; readonly value: T } | { readonly type: "failed" } | { readonly type: "late" };

/** Starts the agent (or the shell) the request names. Throws when no pane was made, or AgentStartFailed. */
export async function newAgent(
  herdr: NewAgentHerdr,
  commands: AgentStartCommands,
  request: NewAgentRequest,
  clock: NewAgentClock = liveClock,
  timeoutMs = firstAgentTimeoutMs,
  pollMs = agentPollMs,
  machine: NewAgentMachine = unnamedMachine,
  /** The model and effort flags New agent's choice adds (checked by the caller against the machine's list). */
  flags: readonly StartFlag[] = [],
): Promise<NewAgentResult> {
  // A whole path on the machine, before anything is read or made (a refusal sends nothing). It is
  // read before the creation's check, so nothing is awaited between that check and the creation.
  const cwd = await resolveFolderCwd(request.folder, machine);
  const where = request.where ?? { type: "tab" };
  const placeWord = where.type === "tab" ? "tab" : "pane";
  // Every request checked against the machine link right before it goes, nothing awaited
  // between; a changed machine refuses (MachineChanged) and the request is never sent.
  const bound = <T>(send: () => Promise<T>): Promise<T> => {
    const why = machine.link?.check() ?? null;
    if (why !== null) return Promise.reject(new MachineChanged(why));
    let sent: Promise<T>;
    try {
      sent = send();
    } catch (error) {
      sent = Promise.reject(error);
    }
    machine.link?.sent();
    return sent;
  };
  // A read in a phase ending at `end`: not sent once the end has passed, waited for at most
  // the time left (the clock's alarm), and its reply not used when it comes after the end. A changed machine throws.
  const timed = async <T>(end: number, read: () => Promise<T>): Promise<Timed<T>> => {
    if (clock.now() > end) return { type: "late" };
    const reply: Promise<Timed<T> | MachineChanged> = bound(read).then(
      (value): Timed<T> => ({ type: "value", value }),
      (error: unknown): Timed<T> | MachineChanged => (error instanceof MachineChanged ? error : { type: "failed" }),
    );
    const alarm = clock.alarm?.(end - clock.now());
    let outcome: Timed<T> | MachineChanged;
    try {
      outcome = alarm === undefined ? await reply : await Promise.race([reply, alarm.rang.then((): Timed<T> => ({ type: "late" }))]);
    } finally {
      alarm?.cancel();
    }
    if (outcome instanceof MachineChanged) throw outcome;
    return clock.now() > end ? { type: "late" } : outcome;
  };
  // The new pane: a tab's (labelled with the agent's name), or a split's beside the focused pane.
  const place = async (label: string | null): Promise<{ paneId: string; tabId: string; cwd: string | undefined }> => {
    try {
      if (where.type === "tab") {
        const created = await bound(() => herdr.createTerminalTab(request.workspaceId, label, cwd));
        return { paneId: created.rootPane.paneID, tabId: created.tab.tabID, cwd: created.rootPane.cwd };
      }
      const split = herdr.splitPane?.bind(herdr);
      if (split === undefined) throw new Error("This machine cannot split a pane from here.");
      const pane = await bound(() => split({ workspaceId: request.workspaceId, targetPaneId: where.targetPaneId, direction: where.direction, cwd, focus: false }));
      return { paneId: pane.paneID, tabId: pane.tabID, cwd: pane.cwd };
    } catch (error) {
      if (error instanceof MachineChanged) throw new Error(newAgentTexts.nothingMade(error.message));
      // Herdr's refusal in its words, never its code.
      if (error instanceof APIError) throw new Error(newAgentTexts.notMade(placeWord, errorWords(error)));
      throw error;
    }
  };
  // Where Herdr put the new pane, when that is not the folder sent.
  const elsewhereLine = (what: string, reported: string | undefined): string | null => {
    const shell = placedElsewhere(cwd, reported);
    return shell === null || cwd === null ? null : newAgentTexts.elsewhere(what, placeWord, shell, cwd);
  };
  const lines = (...parts: (string | null)[]): string | null => {
    const kept = parts.filter((part): part is string => part !== null);
    return kept.length === 0 ? null : kept.join(" ");
  };
  if (request.kind === "shell") {
    const created = await place(null);
    return { paneId: created.paneId, tabId: created.tabId, name: null, kind: "shell", start: { type: "shell" }, summary: elsewhereLine("The shell was made", created.cwd) };
  }
  const kind = request.kind.toLowerCase();
  const title = kindTitle(kind);
  // Only a plain command is typed; another goes to Herdr's own start, and the line says why.
  const plan = typedStart(commands, kind);
  // The choice's flags after a typed command, each value single-quoted; for Herdr's own start,
  // its args after Codex's --no-daemon, each a plain word (anything else is refused before anything is made).
  const command = plan.type === "typed" ? (flags.length === 0 ? plan.command : `${plan.command} ${typedFlags(flags)}`) : null;
  const notTyped = plan.type === "herdr" ? plan.notTyped : null;
  const startArgs = [...(herdrStartArgs(kind) ?? []), ...flagWords(flags)];
  if (command === null && !startArgs.every(isPlainWord)) throw new Error(newAgentTexts.flagsNotPlain(title));
  let listed: AgentInfo[];
  try {
    listed = await bound(() => herdr.agentList());
  } catch (error) {
    if (error instanceof MachineChanged) throw new Error(newAgentTexts.nothingMade(error.message));
    throw error;
  }
  const taken = new Set(listed.map((agent) => agent.name?.toLowerCase()).filter((name): name is string => name !== undefined));
  const name = agentName(kind, taken);
  const created = await place(name);
  const paneId = created.paneId;
  const elsewhere = elsewhereLine(`${title} started`, created.cwd);
  const result = (start: NewAgentStart, summary: string | null = null): NewAgentResult => ({ paneId, tabId: created.tabId, name, kind, start, summary });
  const close = (): Promise<void> => bound(() => herdr.closePane(paneId));
  const notInstalled = (line: string): string => newAgentTexts.notInstalled(title, machine.name, line);
  const paneText = herdr.paneText?.bind(herdr);
  if (command !== null) {
    try {
      await bound(() => herdr.sendInput(paneId, command, ["Enter"]));
    } catch (error) {
      if (error instanceof MachineChanged) throw new AgentStartFailed(paneId, newAgentTexts.notTyped(error.message, command, placeWord), false);
      if (error instanceof APIError) throw await failedStart(close, paneId, `typing “${command}” was refused: ${errorWords(error)}`, placeWord);
      // No answer: the command may have been typed. The pane stays and the wait decides; it is never typed twice.
    }
  } else {
    // A new shell still running its startup files answers agent_pane_busy; the same start to the same pane
    // again every 250 ms, for 15 s from the first try. Only that code is tried again. One deadline, checked
    // after each answer and after each wake, so no start goes after it.
    const busyEnd = clock.now() + paneBusyTimeoutMs;
    const gaveUp = (): Promise<AgentStartFailed> => failedStart(close, paneId, newAgentTexts.busy(machine.name, title), placeWord);
    // Codex with `--no-daemon` (its hooks then report the session for this pane); no args for any other kind.
    const args = startArgs.length === 0 ? undefined : startArgs;
    for (;;) {
      try {
        await bound(() => (args === undefined ? herdr.startAgent(name, kind, paneId) : herdr.startAgent(name, kind, paneId, args)));
        break;
      } catch (error) {
        if (error instanceof MachineChanged) throw new AgentStartFailed(paneId, newAgentTexts.notStarted(error.message, title, placeWord), false);
        if (error instanceof APIError && error.code === "agent_pane_busy") {
          if (clock.now() >= busyEnd) throw await gaveUp();
          await clock.sleep(Math.min(paneBusyRetryMs, busyEnd - clock.now()));
          // A late wake sends no other start.
          if (clock.now() > busyEnd) throw await gaveUp();
          continue;
        }
        // The agent runs in the pane, at its own screen (signing in): the pane stays and is shown.
        if (error instanceof APIError && error.code === "agent_not_ready") return result({ type: "herdr" }, lines(newAgentTexts.waiting(title), elsewhere));
        // No answer to a start that may have reached Herdr is no proof nothing started: the pane stays.
        if (error instanceof RequestTimedOutError && error.mayHaveLanded) return result({ type: "herdr" }, lines(newAgentTexts.unsure(title, machine.name, placeWord), elsewhere));
        if (error instanceof APIError) throw await failedStart(close, paneId, newAgentTexts.refused(title, errorWords(error)), placeWord);
        throw await failedStart(close, paneId, errorWords(error), placeWord);
      }
    }
    // Herdr took the start; the pane's text read for at most 3 s for its shell's "not found" line.
    const notTypedLine = notTyped === null ? null : `Herdr started ${title}: ${notTyped}; it was not typed.`;
    if (paneText !== undefined) {
      const lookEnd = clock.now() + missingLookMs;
      try {
        for (;;) {
          const text = await timed(lookEnd, () => paneText(paneId, missingReadLines));
          // Late, or the pane cannot be read (no pane.read there): nothing to look at.
          if (text.type !== "value") break;
          const line = missingProgramLine(text.value, kind);
          if (line !== null) return result({ type: "herdr" }, notInstalled(line));
          if (clock.now() >= lookEnd) break;
          const agents = await timed(lookEnd, () => herdr.agentList());
          if (agents.type === "late") break;
          if (programRuns(agents.type === "value" ? agents.value.find((agent) => agent.paneID === paneId) : undefined)) break;
          await clock.sleep(Math.min(missingPollMs, Math.max(0, lookEnd - clock.now())));
        }
      } catch (error) {
        if (error instanceof MachineChanged) return result({ type: "herdr" }, lines(notTypedLine, elsewhere, newAgentTexts.lookStopped(error.message, placeWord)));
        throw error;
      }
    }
    return result({ type: "herdr" }, lines(notTypedLine, elsewhere));
  }
  // The typed command's wait: agent.list (and the pane's text) once a poll until the kind is in the pane, for at most
  // `timeoutMs`. Its one deadline is checked before each read and after every reply and wake.
  const typedEnd = clock.now() + timeoutMs;
  const noAgent = (): NewAgentResult =>
    result({ type: "noAgent", command }, lines(`No ${title} agent appeared after typing “${command}”. The pane is left open.`, elsewhere));
  try {
    for (;;) {
      const agents = await timed(typedEnd, () => herdr.agentList());
      if (agents.type === "late") return noAgent();
      const info = agents.type === "value" ? agents.value.find((agent) => agent.paneID === paneId) : undefined;
      if (info !== undefined && info.agent?.toLowerCase() === kind) return result({ type: "typed", command }, elsewhere);
      // On every look of the wait, the shell's "not found" line for the command's program ends it.
      if (paneText !== undefined) {
        const text = await timed(typedEnd, () => paneText(paneId, missingReadLines));
        if (text.type === "late") return noAgent();
        const line = text.type === "value" ? missingProgramLine(text.value, programOf(command)) : null;
        if (line !== null) return result({ type: "noAgent", command }, notInstalled(line));
      }
      if (clock.now() >= typedEnd) return noAgent();
      await clock.sleep(Math.min(pollMs, Math.max(0, typedEnd - clock.now())));
    }
  } catch (error) {
    if (error instanceof MachineChanged) return result({ type: "noAgent", command }, lines(newAgentTexts.waitStopped(error.message, title, command), elsewhere));
    throw error;
  }
}

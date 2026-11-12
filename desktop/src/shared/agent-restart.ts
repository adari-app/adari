// Restart: on your tap only, the agent in a pane
// exits and comes back on the same session, in the same pane and terminal:
// `/exit` and Return typed to the agent (Claude Code, Codex and Grok all take
// /exit), then, once Herdr shows the pane's shell (no agent in the pane, the
// terminal the same), the agent's resume command and Return typed into that
// shell. Never Herdr's agent.restart. Shared by the page (the card's button,
// the header menu's item, why it is greyed) and the main process (the keys).

import type { AgentInfo, AgentSessionInfo, TopologyPaneInfo } from "../main/herdr/wire";
import { isPlainLine, resumeSessionID } from "./pane-life";
import { agentKind, agentSession } from "./send-binding";
import { commandFor, plainCommandRefusal, type AgentStartCommands } from "./start-commands";
import { codexResumeLine } from "./codex-start";

/** The card's main button. */
export const restartCardLabel = "Restart on the new version";
/** The header menu's item. */
export const restartMenuLabel = "Restart (keeps the conversation)";
/** What the agent is typed to leave. */
export const exitCommand = "/exit";

/** One row per agent the app can bring back: its executable and its resume form. */
export interface RestartKind {
  readonly executable: string;
  /** The line that resumes `id` with `start` (the configured command or the executable). */
  resume(start: string, id: string): string;
  /** The session id this agent resumes from Herdr's report, or null when none is known. */
  sessionID(session: AgentSessionInfo | null): string | null;
}

/** A Grok session id as Chat reports it: one word, never an option. */
const grokID = /^[A-Za-z0-9][A-Za-z0-9_-]{5,127}$/;

/**
 * The table: Claude `cl --resume <id>` (with `{"claude": "cl"}`, the same as
 * the Resume chip), Codex `codex resume <id> --no-daemon`, Grok `grok --resume <id>` (only
 * where Herdr reports its session id).
 */
export const restartKinds: Readonly<Record<string, RestartKind>> = {
  claude: { executable: "claude", resume: (start, id) => `${start} --resume ${id}`, sessionID: resumeSessionID },
  // With `--no-daemon` once (codex-start.ts codexResumeLine), the Resume chip's line.
  codex: { executable: "codex", resume: codexResumeLine, sessionID: resumeSessionID },
  grok: {
    executable: "grok",
    resume: (start, id) => `${start} --resume ${id}`,
    sessionID: (session) => (session !== null && session.kind === "id" && grokID.test(session.value) ? session.value : null),
  },
};

/** The start command for `kind`: the configured plain one, the executable when none is configured; null while not known or refused. */
function startCommand(kind: string, row: RestartKind, commands: AgentStartCommands | null): string | null {
  if (commands === null) return null;
  switch (commands.status.type) {
    case "absent":
      return row.executable;
    case "malformed":
    case "unreadable":
      return null;
    case "read": {
      const configured = commandFor(commands, kind);
      if (configured !== null) return plainCommandRefusal(configured) === null ? configured : null;
      return commands.refused[kind] === undefined ? row.executable : null;
    }
  }
}

/** The resume command for the agent `kind` on `session`; null for another kind, no session id, or no plain command. */
export function restartCommand(kind: string | null, session: AgentSessionInfo | null, commands: AgentStartCommands | null): string | null {
  if (kind === null) return null;
  const row = Object.hasOwn(restartKinds, kind) ? restartKinds[kind]! : undefined;
  if (row === undefined) return null;
  const id = row.sessionID(session);
  if (id === null) return null;
  const start = startCommand(kind, row, commands);
  if (start === null) return null;
  const line = row.resume(start, id);
  return isPlainLine(line) ? line : null;
}

/** While the agent works, the button's reason. */
export const restartWaitText = "Wait for it to finish, or Stop it first";

/** What the button stands on, as the page sees the pane. */
export interface RestartInput {
  /** An agent runs in the pane. */
  readonly isAgent: boolean;
  /** Herdr's status for the agent (idle, done, working, blocked, …). */
  readonly status: string;
  /** A dialog or a pending menu on its screen (input_pending, or blocked). */
  readonly dialog: boolean;
  /** The machine answers now. */
  readonly online: boolean;
  /** Herdr reports a session id this agent resumes from. */
  readonly sessionKnown: boolean;
  /** A restart of this pane is under way. */
  readonly busy: boolean;
  readonly name: string;
  readonly machine: string;
}

/** Why the card's button and the menu's item are greyed now; null: a click restarts. */
export function restartDisabledReason(input: RestartInput): string | null {
  if (!input.online) return `${input.machine} is offline`;
  if (!input.isAgent) return "No agent in this pane";
  if (input.busy) return `Restarting ${input.name}…`;
  if (input.dialog || input.status === "blocked") return `${input.name} is waiting for an answer: answer it first`;
  if (input.status !== "idle" && input.status !== "done") return restartWaitText;
  if (!input.sessionKnown) return "No session id known to resume";
  return null;
}

/** Herdr reports a session id the agent `kind` resumes from. */
export function restartSessionKnown(kind: string | null, session: AgentSessionInfo | null): boolean {
  if (kind === null || !Object.hasOwn(restartKinds, kind)) return false;
  return restartKinds[kind]!.sessionID(session) !== null;
}

/** The notes under the header. */
export const restartTexts = {
  didNotExit: (name: string) => `Not restarted: ${name} did not exit`,
  // It gave up with the /exit it typed still in the agent's input row.
  exitTyped: (name: string) => `Not restarted: ${name} did not exit. ${exitCommand} is still typed in its terminal.`,
  // Input to the pane while it exited calls off the next Return.
  typedMeanwhile: (name: string) => `Not restarted: you typed in ${name}'s terminal while it was exiting. ${exitCommand} may still be typed there.`,
  paneGone: "Not restarted: the pane closed",
  otherTerminal: "Not restarted: another terminal is in this pane now",
  otherAgent: "Not restarted: another agent is in this pane now",
  connectionChanged: (machine: string) => `Not restarted: the connection to ${machine} changed`,
  offline: (machine: string) => `Not restarted: ${machine} is offline`,
  unchecked: (name: string) => `Not restarted: the app could not check ${name}. Try again.`,
  // Herdr's words, never its code; an agent at its own screen keeps its pane (Restart closes none).
  refused: (message: string) => `Not restarted: Herdr refused the keys: ${message}`,
  notReady: (name: string) => `Not restarted: ${name} is not ready for keys. If it is waiting in its tab, for example to sign in, answer it there.`,
  unconfirmed: "Not restarted: the Mac did not confirm the keys. Check the terminal.",
  resumeUnconfirmed: "The resume command went, but the Mac did not confirm it. Check the terminal.",
  working: (name: string) => `Not restarted: ${name} is working. ${restartWaitText}`,
  waiting: (name: string) => `Not restarted: ${name} is waiting for an answer`,
  noSession: "Not restarted: no session id known to resume",
  noAgent: (name: string) => `Not restarted: ${name} is no longer in this pane`,
  // The resumed Codex shows "This conversation is open in another app" (its background service, the
  // daemon a plain `codex` or Herdr's session restore started, still holds the conversation).
  lockWait: (name: string) => `${name} is still holding this conversation in its background service. Adari retries every 15 seconds for up to 5 minutes.`,
  lockGaveUp: (name: string) => `Not resumed yet: ${name} says this conversation is open in another app. Press R in its terminal to retry.`,
  lockStopped: (name: string, why: string) =>
    `Not resumed yet: ${why}, so Adari stopped retrying. If ${name} still says this conversation is open in another app, press R in its terminal.`,
} as const;

/** Why the lock wait stopped (lockStopped's `why`). */
export const lockStopReasons = {
  typed: (name: string) => `you typed in ${name}'s terminal`,
  paneGone: "the pane closed",
  otherTerminal: "another terminal is in this pane now",
  otherAgent: "another agent is in this pane now",
  gone: (name: string) => `${name} is no longer in this pane`,
  waiting: (name: string) => `${name} is waiting for an answer`,
  connectionChanged: (machine: string) => `the connection to ${machine} changed`,
  offline: (machine: string) => `${machine} is offline`,
  refused: "Herdr did not take the key",
} as const;

/**
 * Why /exit must not go by this snapshot; null when it may: the same pane,
 * terminal, agent kind and Herdr session the page showed, idle or done, with
 * no dialog or pending menu.
 */
export function restartRefusal(expected: RestartBinding, pane: TopologyPaneInfo | null, agent: AgentInfo | null): string | null {
  if (pane === null) return restartTexts.paneGone;
  if (expected.terminalID !== "" && pane.terminalID !== expected.terminalID) return restartTexts.otherTerminal;
  const kind = agentKind(agent, pane);
  if (kind === null) return restartTexts.noAgent(expected.name);
  if (kind !== expected.kind || agentSession(agent) !== expected.session) return restartTexts.otherAgent;
  const status = agent?.agentStatus ?? pane.agentStatus;
  if (status === "blocked" || agent?.inputPending === true) return restartTexts.waiting(expected.name);
  if (status !== "idle" && status !== "done") return restartTexts.working(expected.name);
  return null;
}

// MARK: - /exit left typed in Codex's input row

/**
 * The kinds whose slash list can take the Return after a typed `/exit`
 * (Codex 0.167.0: `› /exit` stays in its row until one more Return). Claude
 * Code and Grok are not among them; Cursor has no Restart.
 */
export const exitRowKinds: ReadonlySet<string> = new Set(["codex"]);

/** What Codex's input row shows after /exit's Return. */
export type ExitRow =
  /**
   * The whole bottom of the screen proves the row holds exactly `/exit`: the
   * box, then only blank rows, or a slash list with exactly one row marked
   * selected and that row `/exit` (an unmarked list proves nothing), then one
   * complete footer as the last row. One more Return may run it.
   */
  | "exit"
  /** `/exit` stands in your row with other text (your draft, a continuation row, another command selected): no key, it stays typed. */
  | "typed"
  /**
   * The row holds `/exit`, but the screen
   * under it is not a frame the reader knows (no complete footer as the last
   * row, text after it, a frame cut mid-draw): no key now; read again.
   */
  | "unsure"
  /** The row holds no `/exit` (its placeholder, or other text): it took the /exit or never had it. */
  | "clear"
  /** No input row at the bottom (a dialog, a list, a shell, a frame not known): nothing to say. */
  | null;

const codexMark = "\u{203A}"; // ›
const atMargin = (line: string): boolean => line !== "" && line[0] !== " ";
/** A slash list's row under the box ("  /exit    exit Codex"; the selected one "  › /exit    exit Codex"). */
const slashRow = /^ +(\u{203A} )?(\/[a-z][a-z-]*)(?: {2,}\S.*)?$/u;
/**
 * Codex's footer, whole: two spaces, the model (and its
 * effort), " · ", the folder (from `~` or `/`), and optionally " · " and the
 * session's title, as the recorded frame draws it:
 * "  GPT-6.1-Sol default · ~/code/hello-app · Reply exactly hello". A draft's
 * row with a middle dot ("  notes · keep this draft") is no footer.
 */
const footerRow = /^ {2}[A-Za-z0-9][A-Za-z0-9._:/-]*(?: [a-z]+)? \u{B7} [~/][^\u{B7}]*?(?: \u{B7} \S.*)?$/u;

/** The box row's text: "› " and the draft at the margin (a list's "› 1. Yes" is none); null for another row. */
function boxText(line: string): string | null {
  if (!atMargin(line) || !line.startsWith(codexMark)) return null;
  const rest = line.slice(codexMark.length);
  if (rest !== "" && rest[0] !== " " && rest[0] !== "\u{00A0}") return null;
  if (/^[ \u{00A0}]\d+[.)] /u.test(rest)) return null;
  return rest.trim();
}

/**
 * What the rows under the box `/exit` stands in say: the whole bottom, never
 * cut at the first row with a middle dot.
 * `rows` runs from the row under the box to the last non-blank row.
 */
function underExit(rows: readonly string[]): Exclude<ExitRow, "clear" | null> {
  // One complete footer, the last row; anything else there (a frame cut mid-draw, text after the footer): not known.
  if (rows.length === 0 || !footerRow.test(rows[rows.length - 1]!)) return "unsure";
  const between = rows.slice(0, -1);
  // Blank rows, then the slash list's rows together, then blank rows: anything else is your draft's next row.
  const list = between.map((line, index) => ({ line, index, match: slashRow.exec(line) })).filter((row) => row.line !== "");
  if (list.some((row) => row.match === null)) return "typed";
  if (list.length > 0 && list[list.length - 1]!.index - list[0]!.index !== list.length - 1) return "typed";
  if (list.length === 0) return "exit";
  // Rows shaped like a slash list need positive proof, exactly one row
  // marked "› " (Codex marks its selected row so) and that row `/exit`. A wholly unmarked list can be your draft's
  // next rows ("› /exit" then "  /exit"): typed, never exit.
  const marked = list.filter((row) => row.match![1] !== undefined);
  if (marked.length !== 1 || marked[0]!.match![2] !== exitCommand) return "typed";
  return "exit";
}

/**
 * Codex's input row on `screen` (plain text, the pane's recent lines): the last
 * row at the margin must be the "› " box. "exit" only where the whole bottom of
 * the screen proves it (underExit); with the box's own text other than `/exit`,
 * "typed" when `/exit` stands in it or in one of its next rows, else "clear".
 */
export function codexExitRow(screen: string): ExitRow {
  const lines = screen.split("\n").map((line) => line.replace(/[ \t\u{00A0}]+$/u, ""));
  const box = lines.findLastIndex(atMargin);
  if (box < 0) return null;
  const text = boxText(lines[box]!);
  if (text === null) return null;
  const last = lines.findLastIndex((line) => line !== "");
  const rows = lines.slice(box + 1, last + 1);
  if (text === exitCommand) return underExit(rows);
  if (text.includes(exitCommand)) return "typed";
  // Your draft's next rows (the footer, the last row, is Codex's own).
  const draft = rows.length > 0 && footerRow.test(rows[rows.length - 1]!) ? rows.slice(0, -1) : rows;
  return draft.some((line) => line.includes(exitCommand)) ? "typed" : "clear";
}

// MARK: - The resumed Codex's "open in another app" lock

/**
 * The kinds whose resume can land on a lock screen while another process holds the conversation (Codex 0.167.0:
 * Herdr's session restore and a plain `codex` run in daemon mode; `codex resume <id> --no-daemon` then shows the lock
 * until the daemon lets go). Only these are read after the resume.
 */
export const resumeLockKinds: ReadonlySet<string> = new Set(["codex"]);

/** The single key Codex's lock screen takes to try again ("r retry"). */
export const lockRetryKey = "r";

/** The lock row: "This conversation is open in another app", with the lock glyph or without it, and its "r to retry" at the right. */
const lockRow = /^ *(?:\u{1F512}\u{FE0F}? +)?This conversation is open in another app(?: {2,}r to retry)?$/u;
/** The row right under it. */
const lockHelpRow = /^ *Close it there and press R to continue here\.$/u;
/** Its key row: "r retry", then "f fork", then Codex's other keys. */
const lockKeysRow = /^ *r retry {2,}f fork(?: {2,}\S.*)?$/u;

/**
 * Codex's lock screen is the bottom of `screen`, exactly: the lock row, the help row right under it,
 * then (after blank rows at most) the key row, then only blank rows. A quotation of it (Codex's box or anything else
 * under it), a partial frame (a row missing) or other text between or after: false.
 */
export function codexLockShown(screen: string): boolean {
  const lines = screen.split("\n").map((line) => line.replace(/[ \t\u{00A0}]+$/u, ""));
  const keys = lines.findLastIndex((line) => line !== "");
  if (keys < 2 || !lockKeysRow.test(lines[keys]!)) return false;
  let help = keys - 1;
  while (help >= 0 && lines[help] === "") help -= 1;
  if (help < 1 || !lockHelpRow.test(lines[help]!)) return false;
  return lockRow.test(lines[help - 1]!);
}

/** What the resumed Codex's screen shows. */
export type ResumeScreen =
  /** The lock screen, exactly (codexLockShown): one `r` may try again. */
  | "locked"
  /** Codex's input box is the last row at the margin: it is back at its prompt; the restart is done. */
  | "prompt"
  /** Anything else (the shell's line, a frame mid-draw, a dialog): no key; look again. */
  | null;

/** The resumed Codex's screen, read after the resume command went. */
export function codexResumeScreen(screen: string): ResumeScreen {
  if (codexLockShown(screen)) return "locked";
  const lines = screen.split("\n").map((line) => line.replace(/[ \t\u{00A0}]+$/u, ""));
  const box = lines.findLastIndex(atMargin);
  return box >= 0 && boxText(lines[box]!) !== null ? "prompt" : null;
}

/** What a restart is for: the agent as the page showed it. */
export interface RestartBinding {
  readonly terminalID: string;
  readonly kind: string;
  readonly session: string | null;
  readonly incarnation: number;
  readonly connection: number;
  readonly epoch: number | null;
  /** The agent's name for the notes ("Claude Code"). */
  readonly name: string;
  /**
   * The connection and the pane's agent run the page showed at the click
   * (HostView.run); every key goes only to that run. Absent: the page showed none (fixtures).
   */
  readonly run?: { readonly connection: number; readonly arrival: number };
}

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isText = (value: unknown, max = 512): value is string => typeof value === "string" && value.length <= max;

/** A page's run, when one is given. */
function isRun(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return isCount(v["connection"]) && isCount(v["arrival"]);
}

/** A well-formed restart from the page (anything else is refused). */
export function isRestartBinding(value: unknown): value is RestartBinding {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    isText(v["terminalID"]) &&
    isText(v["kind"], 64) &&
    v["kind"] !== "" &&
    (v["session"] === null || isText(v["session"])) &&
    isCount(v["incarnation"]) &&
    isCount(v["connection"]) &&
    (v["epoch"] === null || isCount(v["epoch"])) &&
    isText(v["name"], 64) &&
    v["name"] !== "" &&
    isRun(v["run"])
  );
}

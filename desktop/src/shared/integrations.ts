// Herdr's agent integrations, as Chat and
// Settings show them. Herdr learns an agent's session only from its
// integration's hook (`herdr integration install <target>`), so a machine
// whose Herdr has none for Codex never names a Codex session, and Chat has no
// transcript to show. Herdr's socket (0.9.5 schema) answers `integration.list`
// (IntegrationInfo: target, label, command, available, state, one of
// not_installed, current, outdated) and `integration.install { target }`
// (IntegrationInstallResult { messages }). Adari reads the list (main:
// src/main/integrations.ts) and shows an Install or Update button. Herdr
// installs one only on that click, or when Adari's New agent starts an agent
// of a shown kind whose integration the list says is missing or old (with the
// Settings switch on, autoInstallTexts): then the install goes first, bounded,
// and the agent starts either way. Adari never writes a hook file itself.
//
// Only the kinds whose session Chat reads from Herdr are shown: the targets
// whose `herdr:<target>` session the locator turns into a transcript
// (src/shared/chat/locator.ts sessionRefFromAgentSession) and whose Herdr kind
// Chat reads (src/shared/chat/kinds.ts). Devin and Qoder (Chat reads neither)
// are not.

import { knownAgentName, readerKind } from "./agent-names";

/** Herdr's IntegrationState. */
export type IntegrationState = "not_installed" | "current" | "outdated";

export const integrationStates: readonly IntegrationState[] = ["not_installed", "current", "outdated"];

/** Herdr 0.9.5's IntegrationTarget, every one. */
export const integrationTargets: readonly string[] = [
  "pi",
  "omp",
  "claude",
  "codex",
  "copilot",
  "devin",
  "droid",
  "kimi",
  "opencode",
  "kilo",
  "hermes",
  "qodercli",
  "qwen",
  "cursor",
  "mastracode",
  "antigravity_cli",
  "grok",
];

/**
 * The targets shown, each with the Herdr agent kind it serves (the pane's `agent`), in the agent table's order
 * (agent-names.ts agentKinds): the kinds Chat reads whose session comes from Herdr's hook.
 */
export const shownIntegrations: readonly { readonly target: string; readonly kind: string }[] = [
  { target: "claude", kind: "claude" },
  { target: "codex", kind: "codex" },
  { target: "pi", kind: "pi" },
  { target: "opencode", kind: "opencode" },
  { target: "cursor", kind: "cursor" },
  { target: "copilot", kind: "copilot" },
  { target: "grok", kind: "grok" },
  { target: "antigravity_cli", kind: "agy" },
  { target: "droid", kind: "droid" },
  { target: "hermes", kind: "hermes" },
  { target: "kilo", kind: "kilo" },
  { target: "kimi", kind: "kimi" },
  { target: "mastracode", kind: "mastracode" },
  { target: "omp", kind: "omp" },
  { target: "qwen", kind: "qwen" },
];

/** The target Herdr installs for an agent of `kind` (any case, an alias as its kind), or null for a kind not shown. */
export function integrationTargetOf(kind: string | null | undefined): string | null {
  if (kind === null || kind === undefined || kind === "") return null;
  const reader = readerKind(kind);
  return shownIntegrations.find((entry) => entry.kind === reader)?.target ?? null;
}

/** The agent's own name for a shown target ("Codex", "Grok Build"). */
export function integrationName(target: string): string {
  const kind = shownIntegrations.find((entry) => entry.target === target)?.kind ?? target;
  return knownAgentName(kind) ?? target;
}

/** One shown target as Herdr listed it on the machine. */
export interface IntegrationItem {
  readonly target: string;
  /** The Herdr agent kind it serves. */
  readonly kind: string;
  /** The agent's own name ("Codex"). */
  readonly name: string;
  readonly state: IntegrationState;
  /** Herdr's `available` (its agent's command found on the machine); Settings lists only these. */
  readonly available: boolean;
}

/** What the last Install or Update click on this connection came to (the main process keeps it). */
export interface IntegrationOutcome {
  readonly phase: "installing" | "installed" | "failed";
  /** "Installing Codex's integration…", "Installed. Restart Codex so it uses it.", "Not installed: …". */
  readonly text: string;
  /** Herdr's own lines (IntegrationInstallResult.messages), bounded (integrationMessageLines). */
  readonly messages: readonly string[];
  /** Update (the state was outdated) or Install. */
  readonly action: IntegrationAction;
}

export type IntegrationAction = "install" | "update";

/** A machine's integrations as read on one connection (HostView.integrations). */
export interface HostIntegrations {
  /** The entry and connection the list was read on (HostView.incarnation, HostView.connection). */
  readonly incarnation: number;
  readonly connection: number;
  /** The command connection it was read on (HostView.epoch). */
  readonly epoch: number | null;
  /** The shown targets Herdr listed, in shownIntegrations' order. */
  readonly items: readonly IntegrationItem[];
  /** The last click's outcome per target, on this connection. */
  readonly outcomes: Readonly<Record<string, IntegrationOutcome>>;
  /**
   * Per target, the panes Adari's New agent started on this machine, entry, connection and
   * command connection after Herdr listed that target's integration as installed and current, or after an Install of
   * it succeeded here. Their agent started with the integration in place, so Chat does not tell them to restart.
   * Absent: none (and every pane not listed keeps the steps: Adari cannot tell when it started).
   */
  readonly startedAfter?: Readonly<Record<string, readonly string[]>>;
  /**
   * Per target, the panes whose screen showed the agent's hook review on this read
   * and whose session is not named yet. Codex runs on without the hook if you chose Continue without trusting, and
   * nothing on the screen says which choice you made, so Chat gives the conservative line (integrationTexts.hookOff),
   * never the first-message one. Absent: none.
   */
  readonly hookReviewed?: Readonly<Record<string, readonly string[]>>;
  /** Settings' Update all runs on this read now (its button waits); absent: none. */
  readonly updatingAll?: true;
}

/** What an Install click is for: the machine's entry and connection as the window showed them. */
export interface IntegrationBinding {
  readonly incarnation: number;
  readonly connection: number;
  readonly epoch: number | null;
}

/** The main process's answer to a click: sent (Herdr asked) or refused before anything went (with why). */
export type IntegrationInstallReply =
  | { readonly sent: true; readonly outcome: IntegrationOutcome }
  | { readonly sent: false; readonly note: string };

/**
 * Settings' Update all on one machine: each target it asked, in order, with what came of it (sent: Herdr was asked;
 * refused: nothing went, with why). `note`: why nothing was asked at all (the machine changed), else null.
 */
export interface IntegrationUpdateAllReply {
  readonly results: readonly { readonly target: string; readonly reply: IntegrationInstallReply }[];
  readonly note: string | null;
}

/**
 * The targets Update all updates on a machine, in Settings' order: the rows Settings shows (Herdr finds the agent
 * there: `available`) that Herdr lists as out of date. A missing one is never among them: it keeps its own Install.
 */
export function updateAllTargets(items: readonly IntegrationItem[]): string[] {
  return items.filter((item) => item.available && item.state === "outdated").map((item) => item.target);
}

/** Update all's button ("Update all (3)") and its line. No em dash. */
export const updateAllTexts = {
  button: (count: number): string => `Update all (${count})`,
  title: (count: number): string =>
    count === 1 ? "Update the one out-of-date integration" : `Update the ${count} out-of-date integrations, one after the other`,
} as const;

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** A well-formed binding from the page (anything else is refused). */
export function isIntegrationBinding(value: unknown): value is IntegrationBinding {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return isCount(v["incarnation"]) && isCount(v["connection"]) && (v["epoch"] === null || isCount(v["epoch"]));
}

/** A target the page may ask to install (a shown one). */
export function isShownTarget(value: unknown): value is string {
  return typeof value === "string" && shownIntegrations.some((entry) => entry.target === value);
}

/** At most this many of Herdr's lines are shown, each at most this long. */
export const maxIntegrationLines = 8;
export const maxIntegrationLineLength = 240;

/**
 * Herdr's messages as plain lines: split on line breaks, control characters out, blank lines dropped, each cut at
 * 240 characters and at most 8 lines (one more line says how many were left out). Shown as text, never markup.
 */
export function integrationMessageLines(messages: readonly unknown[]): string[] {
  const lines = messages
    .filter((message): message is string => typeof message === "string")
    .flatMap((message) => message.split(/\r\n|\r|\n/))
    // eslint-disable-next-line no-control-regex
    .map((line) => line.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim())
    .filter((line) => line !== "")
    .map((line) => (line.length > maxIntegrationLineLength ? `${line.slice(0, maxIntegrationLineLength - 1)}…` : line));
  if (lines.length <= maxIntegrationLines) return lines;
  const left = lines.length - (maxIntegrationLines - 1);
  return [...lines.slice(0, maxIntegrationLines - 1), `(${left} more lines not shown)`];
}

/** The words for each state in Settings' line. */
export const integrationStateWords: Readonly<Record<IntegrationState, string>> = {
  current: "installed",
  not_installed: "not installed",
  outdated: "out of date",
};

/** The click a state offers (null: none, it is current). */
export function integrationActionOf(state: IntegrationState): IntegrationAction | null {
  if (state === "not_installed") return "install";
  if (state === "outdated") return "update";
  return null;
}

export const integrationButton: Readonly<Record<IntegrationAction, string>> = { install: "Install", update: "Update" };

/** The sentences (no Herdr code in any, no em dash). */
export const integrationTexts = {
  /** Chat's no-session state for an agent whose integration is missing or old. */
  cause: (name: string, machine: string, state: Exclude<IntegrationState, "current">): string =>
    state === "not_installed"
      ? `Chat needs Herdr's ${name} integration on ${machine}, and it is not installed.`
      : `Chat needs Herdr's ${name} integration on ${machine}, and it is out of date (Herdr can update it).`,
  installing: (name: string, action: IntegrationAction): string => (action === "update" ? `Updating Herdr's ${name} integration…` : `Installing Herdr's ${name} integration…`),
  installed: (name: string): string => `Installed. Restart ${name} so it uses it.`,
  /**
   * Chat's line after an install where the agent's Restart cannot run (no session
   * id to resume, or a kind with no resume-based Restart). New agent starts it with Adari's own start command.
   */
  installedSteps: (name: string): string => `Installed. To use it, quit ${name} in its terminal when it is done, then start it again with New agent.`,
  /**
   * Chat's no-session line for a pane whose agent Adari's New agent started after the
   * integration was in place: Herdr names the session once the agent's first turn runs.
   */
  firstMessage: (name: string): string => `Chat shows ${name}'s replies after your first message.`,
  /**
   * Chat's no-session line for a pane that showed the agent's hook review and has
   * no session yet: your choice there is not known, and Adari never chooses for you.
   */
  hookOff: (name: string): string =>
    `If you chose Continue without trusting, ${name}'s hook is off: quit ${name} in its terminal, then start it again with New agent and choose Trust all and continue.`,
  /** Herdr's words without its code. */
  failed: (action: IntegrationAction, words: string): string => `${action === "update" ? "Not updated" : "Not installed"}: ${words}`,
  /** Herdr answered the install in a shape that is not its schema's. */
  unreadable: (action: IntegrationAction): string => `${action === "update" ? "Not updated" : "Not installed"}: Herdr's reply could not be read.`,
  /** Refusals before anything went. */
  removed: "Not installed: that machine is no longer listed. Nothing was sent.",
  offline: (machine: string): string => `Not installed: ${machine} is offline. Nothing was sent.`,
  connectionChanged: (machine: string): string => `Not installed: the connection to ${machine} changed since this showed. Nothing was sent.`,
  notListed: (machine: string): string => `Not installed: Herdr on ${machine} does not list this integration as missing now. Nothing was sent.`,
  unavailable: "Not installed: this build cannot ask Herdr to install it.",
} as const;

/**
 * New agent's install in front of its start (Settings' switch, on by default) and Chat's line for a machine whose
 * list was not read. No Herdr code in any, no em dash.
 */
export const autoInstallTexts = {
  /** Settings › Machines' switch and the line under it. */
  title: "Install Herdr's integrations when I start an agent",
  help: "When New agent starts an agent whose Herdr integration is missing or out of date on that machine, Herdr adds a small hook file to the agent's settings there first, so Chat can show its conversation.",
  /** New agent's one line (its notice), before what the start itself says. */
  installed: (name: string, machine: string): string => `Installed Herdr's ${name} integration on ${machine}.`,
  updated: (name: string, machine: string): string => `Updated Herdr's ${name} integration on ${machine}.`,
  /** The install had not ended within the bound (autoInstallWaitMs); the agent started without waiting. */
  stalled: (name: string, action: IntegrationAction, seconds: number): string =>
    `${action === "update" ? "Not updated" : "Not installed"} yet: Herdr had not finished ${action === "update" ? "updating" : "installing"} its ${name} integration after ${seconds} seconds, so New agent did not wait for it.`,
  /** Chat's no-session state when the machine's list was not read on this connection (rule 6), and its button. */
  unread: (machine: string): string => `Adari could not read Herdr's integrations on ${machine}, so it cannot tell whether this agent's integration is installed.`,
  retry: "Retry",
} as const;

/** The switch as kept (a missing or unreadable file: on). */
export function decodeAutoInstall(value: unknown): boolean {
  const kept = typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  return kept["autoInstall"] !== false;
}

/** The item for a shown target on a machine, or null when Herdr did not list it (or the machine has no list). */
export function integrationItem(integrations: HostIntegrations | undefined, target: string | null): IntegrationItem | null {
  if (integrations === undefined || target === null) return null;
  return integrations.items.find((item) => item.target === target) ?? null;
}

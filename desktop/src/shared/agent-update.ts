// An agent CLI's update, run from Adari (the twin of HerdrKit's
// AgentUpdateRun.swift).
//
// Settings › Updates › Agent CLIs gives each covered CLI that updates by a
// command (Codex; update-mark.ts updateLineKinds) an "Update command" per
// machine (and every other agent kind the machine's start-command table
// lists, in a plain list with no mark: updateKinds), empty until the person sets one, kept in that machine's
// `~/.adari/agents.json` as `<kind>.update` (start-commands.ts). Where the CLI's
// own screen named its command (Codex's "Run <command> to update."), that
// command is offered as a suggestion the person takes with one click; nothing
// is filled in or run by itself, and no command is built into the app. Claude
// Code installs its own updates: its row says so and has no command.
//
// Update (a CLI with a command set, on its row and beside the update mark where
// the app offers the restart): a click shows the exact command and the
// machine's name and asks once; on yes the main process (main/herdr/
// agent-update.ts) opens a new shell tab named "Update <CLI>" in a workspace of
// that machine through New agent's shell path (`tab.create` alone), types the
// command and Return into it exactly as written (one `pane.send_input`), and the
// window shows that tab's terminal. The shell is the person's own interactive
// shell, so their aliases and functions work. Adari reads nothing from it,
// closes nothing and judges no result. Bound to the machine as New agent is
// (machine-link.ts): a changed machine sends nothing. Never at connect, never on
// a timer, never for a CLI nobody clicked.
//
// The question is bound to what it showed. When it opens, the window takes
// the machine's entry, connection and command connection as it shows them (the
// binding, as an Install click's), the kind, the exact command and the
// workspace; Run carries that and nothing else. The main process refuses a
// binding that no longer holds before anything is read or sent, then reads the
// machine's file afresh (one read per click, never the connection's cached
// read): a command that is no longer exactly the one shown asks again with the
// one there now; one gone, refused or unreadable says so. Nothing is sent then.

import { agentUpdateWords } from "./update-mark";
import { isAgentStartCommands, maximumSaveRequestLength, updateCommandRefusal, type AgentStartCommands } from "./start-commands";
import { newAgentKindTitle, newAgentKinds } from "./new-agent";
import { isIntegrationBinding, type IntegrationBinding } from "./integrations";

/**
 * The kind-name check at the door (the save's and Update's): New agent's own check for a kind agents.json may add
 * (new-agent.ts newAgentKinds, `/^[a-z][a-z0-9_-]{0,31}$/`), never Shell (not an agent) and never Claude Code (it
 * installs its own updates and has no command). HerdrKit's AgentUpdateRun.isCovered is the same check.
 */
export const updateKindPattern = /^[a-z][a-z0-9_-]{0,31}$/;
const noUpdateCommand: readonly string[] = ["shell", "claude"];

export function isUpdateCommandKind(value: unknown): value is string {
  return typeof value === "string" && updateKindPattern.test(value) && !noUpdateCommand.includes(value);
}

/**
 * The kinds whose update command a machine's Settings row edits, in New agent's order: every kind its
 * start-command table lists (New agent's kinds there, extras from agents.json included, never Shell), any other kind
 * the file already holds an update command for, never Claude Code.
 */
export function updateKinds(commands: AgentStartCommands | null): string[] {
  const listed = newAgentKinds(commands).map((choice) => choice.kind);
  const saved = Object.keys(commands?.updates ?? {}).filter((kind) => !listed.includes(kind)).sort();
  return [...listed, ...saved].filter(isUpdateCommandKind);
}

/** The CLI's own name ("Codex", "Grok Build"; an extra kind by its word, first letter up). */
export function updateCliName(kind: string): string {
  return Object.hasOwn(agentUpdateWords, kind) ? agentUpdateWords[kind]!.cli : newAgentKindTitle(kind);
}

/**
 * The machine as the question showed it: its entry (incarnation), its connection and its command connection
 * (epoch), as an Install click binds them (integrations.ts IntegrationBinding, the same check).
 */
export type AgentUpdateBinding = IntegrationBinding;

/** The binding of a question opened on `host` as the window shows it now. */
export function agentUpdateBindingOf(host: { readonly incarnation?: number; readonly connection?: number; readonly epoch?: number | null }): AgentUpdateBinding {
  return { incarnation: host.incarnation ?? 0, connection: host.connection ?? 0, epoch: host.epoch ?? null };
}

/** Two bindings name the same entry, connection and command connection. */
export function sameUpdateBinding(a: AgentUpdateBinding, b: AgentUpdateBinding): boolean {
  return a.incarnation === b.incarnation && a.connection === b.connection && a.epoch === b.epoch;
}

/**
 * The page's Update request: the question as it showed, taken when it opened: the CLI, the exact command, the
 * workspace for the tab and the machine's binding.
 */
export interface AgentUpdateRequest {
  readonly kind: string;
  readonly command: string;
  readonly workspaceId: string;
  readonly binding: AgentUpdateBinding;
}

/** Where the update's command was typed: the new tab and its pane. */
export interface AgentUpdateResult {
  readonly paneId: string;
  readonly tabId: string;
}

/**
 * Run found the machine's file no longer holding the command the question showed; nothing was sent. `command`:
 * the one there now (the window asks again with it), or null with `note` (gone, refused or unreadable). `commands`:
 * the file as just read (the window keeps it), or null when it could not be read.
 */
export interface AgentUpdateStale {
  readonly stale: {
    readonly command: string | null;
    readonly note: string | null;
    readonly commands: AgentStartCommands | null;
  };
}

/** What Run answers: the tab opened and typed into, or the file no longer holding the shown command. */
export type AgentUpdateAnswer = AgentUpdateResult | AgentUpdateStale;

/** A main-process answer as the page takes it (anything else: none). */
export function isAgentUpdateAnswer(value: unknown): value is AgentUpdateAnswer {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v["paneId"] === "string" && typeof v["tabId"] === "string") return true;
  const stale = v["stale"] as Record<string, unknown> | null | undefined;
  if (typeof stale !== "object" || stale === null) return false;
  const command = stale["command"];
  const note = stale["note"];
  const commands = stale["commands"];
  return (
    (command === null || (typeof command === "string" && updateCommandRefusal(command) === null)) &&
    (note === null || typeof note === "string") &&
    (command !== null || note !== null) &&
    (commands === null || isAgentStartCommands(commands))
  );
}

/** A well-formed request from the page (anything else is refused before anything is read). */
export function isAgentUpdateRequest(value: unknown): value is AgentUpdateRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (!Object.keys(v).every((key) => key === "kind" || key === "command" || key === "workspaceId" || key === "binding")) return false;
  if (!isIntegrationBinding(v["binding"])) return false;
  const command = v["command"];
  const workspace = v["workspaceId"];
  return (
    isUpdateCommandKind(v["kind"]) &&
    typeof command === "string" &&
    command.length <= maximumSaveRequestLength &&
    updateCommandRefusal(command) === null &&
    typeof workspace === "string" &&
    workspace.length <= 256
  );
}

/** The new tab's name ("Update Codex"). */
export function updateTabLabel(kind: string): string {
  return `Update ${updateCliName(kind)}`;
}

/**
 * The workspace the tab goes in: the workspace of the first agent of that CLI on the machine in the order given (the
 * callers give its marked agents first, then the rest), else the one in view when it is on that machine; null:
 * none (the shell path then refuses in its words).
 */
export function updateWorkspace(marked: readonly { readonly workspaceId: string | null }[], inView: string | null): string | null {
  const first = marked.find((pane) => pane.workspaceId !== null && pane.workspaceId !== "");
  return first?.workspaceId ?? (inView === null || inView === "" ? null : inView);
}

/** The words (no em dash). */
export const agentUpdateTexts = {
  field: "Update command",
  help: (cli: string): string =>
    `What Update types on that machine, in a new shell tab there, exactly as written. Your own shell runs it, so an alias works. Empty: no Update button for ${cli}.`,
  claude: "Claude Code installs its own updates; it only needs the restart.",
  /** The plain list of the other agents (no mark). */
  othersTitle: "Other agents",
  othersHelp: "Their screens say nothing Adari reads about a newer version, so they have no mark here. An update command still runs from Update, as for Codex.",
  add: "Add update command",
  /** The section's foot: the editable kinds with no mark. */
  unmarked: (names: readonly string[]): string =>
    `No mark for ${names.join(" and ")}: ${names.length === 1 ? "it prints" : "they print"} no update notice Adari can read. Their update commands are under Other agents.`,
  suggestion: (cli: string): string => `${cli} says to run`,
  take: "Use this",
  button: "Update",
  buttonTitle: (command: string, machine: string): string => `Run ${command} on ${machine}, in a new shell tab`,
  confirmTitle: (command: string, machine: string): string => `Run \`${command}\` on ${machine}?`,
  confirmBody: (cli: string): string =>
    `Adari opens a shell tab named "Update ${cli}" there and types this command into it, then shows you the tab. It reads nothing from it and closes nothing.`,
  confirmButton: "Run",
  saved: (command: string): string => (command === "" ? "Saved. No Update button here now." : `Saved. Update types ${command}.`),
  unsaved: "Not saved yet: Return saves it on the machine, Esc puts it back.",
  /** The main process's refusals before anything went. */
  changed: (machine: string): string => `The update command on ${machine} changed since this showed. Nothing was sent.`,
  /** The machine's entry, connection or command connection is not the one the question showed. */
  machineChanged: (machine: string): string => `${machine} changed since this question showed (reconnected, edited or another connection). Nothing was sent.`,
  /** Asked again with the command the file holds now. */
  askedAgain: (machine: string): string => `The update command on ${machine} changed since the last question. This is the one there now; nothing was sent.`,
  gone: (cli: string, machine: string): string => `There is no update command for ${cli} on ${machine} now. Nothing was sent.`,
  refusedNow: (cli: string, machine: string, why: string): string => `The update command for ${cli} on ${machine} cannot be typed: ${why}. Nothing was sent.`,
  unreadable: (machine: string, why: string): string => `The update command on ${machine} could not be read (${why}). Nothing was sent.`,
  /** The tab's creation got no answer in time; it is never asked for again. */
  mayHaveOpened: (cli: string, machine: string, why: string): string =>
    `An "Update ${cli}" tab may have opened on ${machine} with nothing typed in it (${why}). It is not opened again.`,
  running: (cli: string, machine: string): string => `An update of ${cli} on ${machine} is being opened already.`,
  notTyped: (why: string): string => `The tab opened, but the command was not typed: ${why}`,
  unanswered: (why: string): string => `The tab opened; typing the command got no answer (${why}). The tab shows whether it arrived; it is not typed again.`,
} as const;

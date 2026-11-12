// The Mac's start command per agent kind (Sources/HerdrKit/AgentStartCommands.swift):
// `~/.adari/agents.json`, e.g. `{"claude": "cl"}`; while it is absent, the file
// from before the app's rename, `~/.herdr-companion/agents.json`. The
// main process reads the file; both sides use these rules.
//
// Settings › Chat › Start commands edits it too, one kind at a
// time (`editableStartKinds`): the main process writes `~/.adari/agents.json`
// over the machine's SFTP connection (src/main/start-commands-write.ts), with
// the reader's own checks (`startCommandSaveRefusal`), the other keys kept.

import { withNoDaemon } from "./codex-start";

/** The file, relative to the SSH account's home (SFTP resolves it against the login folder). */
export const startCommandsRelativePath = ".adari/agents.json";
export const startCommandsDisplayPath = `~/${startCommandsRelativePath}`;
/** The file before the app's rename, read only while the new one is absent; never written. */
export const legacyStartCommandsRelativePath = ".herdr-companion/agents.json";

/**
 * The first start-commands file there is, the new one first: null when
 * neither is there. A read that fails is not an absence and is not passed over.
 */
export async function readFirstStartCommandsFile(read: (relativePath: string) => Promise<Uint8Array | null>): Promise<Uint8Array | null> {
  for (const path of [startCommandsRelativePath, legacyStartCommandsRelativePath]) {
    const data = await read(path);
    if (data !== null) return data;
  }
  return null;
}
/** A command's limit, in characters (Unicode scalars). */
export const maximumCommandLength = 64;
/** A bigger file is not read. */
export const maximumStartCommandsBytes = 16 * 1_024;

export type StartCommandsStatus =
  /** There is no file: every kind starts as Herdr starts it. */
  | { readonly type: "absent" }
  /** Read. A kind whose command was refused is in `refused`. */
  | { readonly type: "read" }
  /** The file was not read (why). */
  | { readonly type: "malformed"; readonly reason: string }
  /** The machine did not give the file (why); the next use asks again. */
  | { readonly type: "unreadable"; readonly reason: string };

export interface AgentStartCommands {
  readonly status: StartCommandsStatus;
  /** Kind → the command to type, only those that passed. */
  readonly commands: Readonly<Record<string, string>>;
  /** Kind → why its command is not used. */
  readonly refused: Readonly<Record<string, string>>;
}

export const absentStartCommands: AgentStartCommands = { status: { type: "absent" }, commands: {}, refused: {} };

export function startCommandsWith(status: StartCommandsStatus, commands: Record<string, string> = {}, refused: Record<string, string> = {}): AgentStartCommands {
  return { status, commands, refused };
}

/** The command for `kind`, or null for Herdr's default. */
export function commandFor(commands: AgentStartCommands, kind: string): string | null {
  return Object.hasOwn(commands.commands, kind) ? commands.commands[kind]! : null;
}

/** Why `command` is not typed into a shell, or null when it may be: one line, no control or invisible character, at most 64 characters. */
export function startCommandRefusal(command: string): string | null {
  if (command.trim() === "") return "its command is empty";
  const scalars = [...command];
  if (scalars.length > maximumCommandLength) return `its command is longer than ${maximumCommandLength} characters`;
  for (const scalar of scalars) {
    if (/[\p{Zl}\p{Zp}]/u.test(scalar)) return "its command has a line break";
    if (/\p{Cc}/u.test(scalar)) {
      return scalar === "\n" || scalar === "\r" || scalar === "\u0085" ? "its command has a line break" : "its command has a control character";
    }
    if (/\p{Cf}/u.test(scalar)) return "its command has an invisible formatting character";
  }
  return null;
}

/** The characters a start command's words are made of. */
const commandCharacters = /^[A-Za-z0-9._/+\-=:,@]*$/;

/**
 * Why `command` is not a plain command the chip may fill; null when it is:
 * words separated by single spaces, each only of letters, digits and
 * `. _ / + - = : , @`, where a word may begin with `~/` but not with `=`.
 */
export function plainCommandRefusal(command: string): string | null {
  if (command === "") return "is empty";
  const words = command.split(" ");
  if (words.some((word) => word === "")) return "is not words separated by single spaces";
  for (const word of words) {
    if (word.startsWith("=")) return "has a word that starts with \u201c=\u201d";
    const rest = word.startsWith("~/") ? word.slice(2) : word;
    if (!commandCharacters.test(rest)) {
      const bad = [...rest].find((c) => !commandCharacters.test(c))!;
      const shown = /\p{Cc}/u.test(bad) ? `U+${bad.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}` : `\u201c${bad}\u201d`;
      return `has ${shown}, not allowed in a plain command`;
    }
  }
  return null;
}

/**
 * What New agent does for `kind`: type the Mac's
 * command when it is a plain command (the Resume chip's rule: the executable
 * and plain words, nothing a shell would read as syntax), else Herdr's own
 * `agent.start`, with why the configured command was not typed.
 */
export type TypedStart = { readonly type: "typed"; readonly command: string } | { readonly type: "herdr"; readonly notTyped: string | null };

export function typedStart(commands: AgentStartCommands, kind: string): TypedStart {
  const command = commandFor(commands, kind);
  if (command === null) {
    // A command the file named but the read refused (a line break, a control character, too long).
    const refused = Object.hasOwn(commands.refused, kind) ? commands.refused[kind]! : null;
    return { type: "herdr", notTyped: refused === null ? null : `the ${kind} command in ${startCommandsDisplayPath} ${refused.replace(/^its command /, "")}` };
  }
  const refusal = plainCommandRefusal(command);
  // A Codex command whose program is `codex` gets `--no-daemon` once (codex-start.ts withNoDaemon).
  if (refusal === null) return { type: "typed", command: kind === "codex" ? withNoDaemon(command) : command };
  return { type: "herdr", notTyped: `the ${kind} command in ${startCommandsDisplayPath} ${refusal}` };
}

/** How Cursor's agent starts when no command is set (and its Resume: `cursor agent --resume <id>`). */
export const cursorAgentCommand = "cursor agent";

/** One kind Settings › Chat edits: its name and the command Herdr types when none is set (the field's placeholder). */
export interface EditableStartKind {
  readonly kind: string;
  readonly name: string;
  readonly stock: string;
  /** The grey line under the row's name, or absent. */
  readonly note?: string;
}

/** Codex's row in Settings › Chat (its stock line stays `codex`). */
export const codexStartNote = "Adari adds --no-daemon so Chat can find the session.";

/**
 * The kinds whose start command the file sets and the app uses (New agent's typedStart, the Resume
 * chip's resumeStartCommand; restart's restartKinds for Claude Code, Codex and Grok Build, not Cursor Agent), Claude
 * Code first. Cursor's agent starts as `cursor agent` (Cursor's own CLI shim says "Use
 * 'cursor agent' or 'agent'"; with only the Cursor app, `cursor` is its launcher and takes `agent`; `cursor-agent` is an
 * older alias such a Mac does not have). Never a bare `agent`: Grok Build installs one too.
 */
export const editableStartKinds: readonly EditableStartKind[] = [
  { kind: "claude", name: "Claude Code", stock: "claude" },
  { kind: "codex", name: "Codex", stock: "codex", note: codexStartNote },
  { kind: "grok", name: "Grok Build", stock: "grok" },
  { kind: "cursor", name: "Cursor Agent", stock: cursorAgentCommand },
];

export function isEditableStartKind(value: unknown): value is string {
  return typeof value === "string" && editableStartKinds.some((entry) => entry.kind === value);
}

/** The longest text the save request carries (a longer one is refused before any check: 64 characters is the limit). */
export const maximumSaveRequestLength = 1_024;

/**
 * Why `command` may not be saved as a start command, in a sentence; null when it may. Empty (after
 * the field's trim) saves no command: the kind starts with its stock command again. Otherwise the reader's checks,
 * both of them: at most 64 characters, one line, no control or invisible character (startCommandRefusal), and a
 * plain command New agent and Resume will type (plainCommandRefusal). A command the file would carry but the app
 * would not type is never written.
 */
export function startCommandSaveRefusal(command: string): string | null {
  if (command === "") return null;
  const read = startCommandRefusal(command);
  if (read !== null) return `The command ${read.replace(/^its command /, "")}.`;
  const plain = plainCommandRefusal(command);
  return plain === null ? null : `The command ${plain}.`;
}

/** The file's bytes (null: there is no file) as start commands. */
export function parseStartCommands(data: Uint8Array | null): AgentStartCommands {
  if (data === null) return absentStartCommands;
  if (data.length > maximumStartCommandsBytes) {
    return startCommandsWith({ type: "malformed", reason: `it is larger than ${maximumStartCommandsBytes / 1_024} KB` });
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    return startCommandsWith({ type: "malformed", reason: "it is not UTF-8 text" });
  }
  let object: unknown;
  try {
    object = JSON.parse(text);
  } catch {
    object = null;
  }
  if (typeof object !== "object" || object === null || Array.isArray(object)) {
    return startCommandsWith({ type: "malformed", reason: 'it is not a JSON object such as {"claude": "cl"}' });
  }
  const commands: Record<string, string> = {};
  const refused: Record<string, string> = {};
  for (const [kind, value] of Object.entries(object as Record<string, unknown>)) {
    if (typeof value !== "string") {
      refused[kind] = "its command is not text";
      continue;
    }
    const reason = startCommandRefusal(value);
    if (reason === null) commands[kind] = value;
    else refused[kind] = reason;
  }
  return startCommandsWith({ type: "read" }, commands, refused);
}

/** A value from the main process (or anywhere untrusted) as start commands, or null when it is not one. */
export function isAgentStartCommands(value: unknown): value is AgentStartCommands {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  const status = v["status"] as Record<string, unknown> | null;
  const map = (raw: unknown) =>
    typeof raw === "object" && raw !== null && !Array.isArray(raw) && Object.values(raw).every((item) => typeof item === "string");
  return (
    typeof status === "object" &&
    status !== null &&
    ["absent", "read", "malformed", "unreadable"].includes(status["type"] as string) &&
    map(v["commands"]) &&
    map(v["refused"])
  );
}

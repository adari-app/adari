// Settings › Chat › Start commands saves one kind's start command into the
// machine's `~/.adari/agents.json`, over the machine's own SFTP connection
// (the transcript reader's, as the reads and uploads use).
//
// One save, in order, stopping at the first refusal with its reason:
//
// 1. the command passes the reader's checks (startCommandSaveRefusal: at most
//    64 characters, one line, no control or invisible character, a plain
//    command New agent and Resume will type); empty removes the kind's key, so
//    it starts with its stock command again;
// 2. the file as it is: absent (then the old `~/.herdr-companion/agents.json`,
//    when there, gives the keys to keep, as the reader read it while the new
//    file was absent; when it is there it must read as one JSON object,
//    or nothing is written); a regular file read whole (at most the reader's 16 KB),
//    UTF-8, one JSON object, or the save is refused and nothing is written; a
//    symlink is followed and the file it names is the one replaced (a dotfiles
//    link stays a link); anything else is refused;
// 3. every key it does not edit kept as it is, in its place (JSON values,
//    written again as JSON with two-space indents); the result at most 16 KB;
//    a file with a number JSON.parse cannot give back
//    exactly (9007199254740993, 1e400) is refused, nothing made or written;
// 4. `~/.adari` made (0700) when it is missing;
// 5. a temporary file beside the real one, created exclusively with the file's
//    mode (0600 for a new file), written and closed, then renamed over the file
//    in one step (OpenSSH's posix-rename): a reader sees the old file or the
//    new one, never part of one. A failure takes the temporary file away again.
//
// What it returns is the new file as the reader reads it; the main process
// keeps it as the machine's start commands (src/main/start-commands.ts), so
// New agent and Resume use it from then on, and restart for the kinds it
// restarts (Claude Code, Codex, Grok Build).

import {
  legacyStartCommandsRelativePath,
  maximumStartCommandsBytes,
  parseStartCommands,
  startCommandSaveRefusal,
  startCommandsDisplayPath,
  startCommandsRelativePath,
  type AgentStartCommands,
} from "../shared/start-commands";

/** What one path is: lstat's kind for `lstat`, the followed file's for `stat`. */
export interface StartFileInfo {
  readonly kind: "file" | "directory" | "symlink" | "other";
  /** The permission bits (no type bits). */
  readonly mode: number;
  readonly size: number;
}

/** The SFTP requests a save makes; `lstat` answers null for a path that is not there. */
export interface StartCommandsFileAccess {
  /** The login folder (SFTP's REALPATH of "."). */
  home(): Promise<string>;
  lstat(path: string): Promise<StartFileInfo | null>;
  stat(path: string): Promise<StartFileInfo>;
  realpath(path: string): Promise<string>;
  /** At most `limit` bytes from the file's start. */
  read(path: string, limit: number): Promise<Uint8Array>;
  mkdir(path: string, mode: number): Promise<void>;
  /** Creates `path` exclusively with `mode` (set again on the handle: the umask does not narrow it), writes `data`, closes it. */
  writeNew(path: string, data: Uint8Array, mode: number): Promise<void>;
  /** Renames `from` over `to` in one step, `to` replaced when it is there (POSIX rename). */
  replace(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
}

/** A refusal in words (the page shows "Not saved: " and this). */
export class StartCommandSaveError extends Error {}

/** A new file's mode, and the folder's. */
export const newStartCommandsMode = 0o600;
export const newStartCommandsFolderMode = 0o700;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The bytes as one JSON object and their text; null when they are not UTF-8 JSON holding one object. */
function jsonObjectOf(data: Uint8Array): { object: Record<string, unknown>; text: string } | null {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(data);
    const parsed: unknown = JSON.parse(text);
    return isObject(parsed) ? { object: parsed, text } : null;
  } catch {
    return null;
  }
}

/** A JSON number literal as sign, significant digits and exponent ("1.50e2" and "150" alike: "15e1"). */
function numberValueOf(literal: string): string | null {
  const parts = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(literal);
  if (parts === null) return null;
  let digits = `${parts[2]}${parts[3] ?? ""}`.replace(/^0+/, "");
  let exponent = Number(parts[4] ?? "0") - (parts[3]?.length ?? 0);
  if (digits === "") return `${parts[1]}0`;
  const trailing = /0+$/.exec(digits)?.[0].length ?? 0;
  digits = digits.slice(0, digits.length - trailing);
  exponent += trailing;
  return `${parts[1]}${digits}e${exponent}`;
}

/**
 * The first number in the JSON text that JSON.parse and JSON.stringify would not give back
 * as the same value (9007199254740993 comes back as ...992, 1e400 as null, -0 as 0); null when every one does.
 * The text is valid JSON (parsed already), so outside strings a run of number characters is one number.
 */
export function inexactNumberIn(text: string): string | null {
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === '"') {
      for (index += 1; index < text.length && text[index] !== '"'; index += 1) if (text[index] === "\\") index += 1;
      continue;
    }
    if (char !== "-" && (char < "0" || char > "9")) continue;
    let end = index + 1;
    while (end < text.length && /[0-9eE.+-]/.test(text[end]!)) end += 1;
    const literal = text.slice(index, end);
    const value = Number(literal);
    if (!Number.isFinite(value) || numberValueOf(literal) !== numberValueOf(JSON.stringify(value))) return literal;
    index = end - 1;
  }
  return null;
}

/** The bytes as one JSON object, or the reason they are not one (the reader's words). */
function objectOf(data: Uint8Array, shown: string): Record<string, unknown> {
  if (data.length > maximumStartCommandsBytes) {
    throw new StartCommandSaveError(`${shown} is larger than ${maximumStartCommandsBytes / 1_024} KB, so Adari does not rewrite it. Change it on the machine.`);
  }
  const read = jsonObjectOf(data);
  if (read === null) {
    throw new StartCommandSaveError(`${shown} is not a JSON object such as {"claude": "cl"}, so Adari does not rewrite it. Fix it on the machine first.`);
  }
  const inexact = inexactNumberIn(read.text);
  if (inexact !== null) {
    throw new StartCommandSaveError(`${shown} holds the number ${inexact}, which Adari cannot write back exactly, so it does not rewrite the file. Change it on the machine.`);
  }
  return read.object;
}

const parentOf = (path: string): string => {
  const slash = path.lastIndexOf("/");
  return slash <= 0 ? "/" : path.slice(0, slash);
};

const join = (home: string, relative: string): string => `${home === "/" ? "" : home}/${relative}`;

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Random hex for the temporary file's name. */
function randomHex(): string {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface SaveOptions {
  /** The temporary file's random part (tests give their own). */
  readonly random?: () => string;
}

/**
 * Saves `command` as `kind`'s start command (empty: removes it) in the machine's `~/.adari/agents.json`; the file as
 * the reader reads it after. Throws StartCommandSaveError with the reason when it does not save.
 */
export async function saveStartCommand(files: StartCommandsFileAccess, kind: string, command: string, options: SaveOptions = {}): Promise<AgentStartCommands> {
  const refusal = startCommandSaveRefusal(command);
  if (refusal !== null) throw new StartCommandSaveError(refusal);

  const home = await files.home();
  const path = join(home, startCommandsRelativePath);
  const folder = parentOf(path);

  // The file as it is now: the one to replace, the keys to keep, and its mode.
  let target = path;
  let keys: Record<string, unknown> = {};
  let mode = newStartCommandsMode;
  let exists = false;
  const entry = await files.lstat(path);
  if (entry !== null) {
    if (entry.kind === "symlink") target = await files.realpath(path);
    const real = entry.kind === "symlink" ? await files.stat(target) : entry;
    if (real.kind !== "file") throw new StartCommandSaveError(`${startCommandsDisplayPath} is not a file, so Adari does not replace it.`);
    keys = objectOf(await files.read(target, maximumStartCommandsBytes + 1), startCommandsDisplayPath);
    mode = real.mode & 0o7777;
    exists = true;
  } else {
    // The reader reads the old file while the new one is absent; its keys stay in effect in the new one.
    // Only "no such file" is an absence. An old file that is there must read whole as one
    // JSON object, or nothing is written: a new file in front of it would drop its commands.
    const legacy = join(home, legacyStartCommandsRelativePath);
    const refused = (why: string) =>
      new StartCommandSaveError(
        `~/${legacyStartCommandsRelativePath}, the old file in use while ${startCommandsDisplayPath} is absent, ${why}, so a new file would drop its commands. Nothing was saved: fix the old file on the machine first.`,
      );
    const old = await files.lstat(legacy).catch((error: unknown) => {
      throw refused(`could not be read (${reasonOf(error)})`);
    });
    if (old !== null) {
      const real = old.kind === "symlink" ? await files.stat(legacy).catch((error: unknown) => {
        throw refused(`could not be read (${reasonOf(error)})`);
      }) : old;
      if (real.kind !== "file") throw refused("is not a file");
      const data = await files.read(legacy, maximumStartCommandsBytes + 1).catch((error: unknown) => {
        throw refused(`could not be read (${reasonOf(error)})`);
      });
      if (data.length > maximumStartCommandsBytes) throw refused(`is larger than ${maximumStartCommandsBytes / 1_024} KB`);
      const read = jsonObjectOf(data);
      if (read === null) throw refused("is not a JSON object");
      const inexact = inexactNumberIn(read.text);
      if (inexact !== null) throw refused(`holds the number ${inexact}, which Adari cannot write back exactly`);
      keys = read.object;
    }
  }

  // The edit: every other key as it was, in its place; this kind's set, or taken out.
  const next: Record<string, unknown> = {};
  let placed = false;
  for (const [key, value] of Object.entries(keys)) {
    if (key === kind) {
      if (command !== "") next[key] = command;
      placed = true;
    } else {
      Object.defineProperty(next, key, { value, enumerable: true, writable: true, configurable: true });
    }
  }
  if (!placed && command !== "") next[kind] = command;
  const data = new TextEncoder().encode(`${JSON.stringify(next, null, 2)}\n`);
  if (data.length > maximumStartCommandsBytes) {
    throw new StartCommandSaveError(`${startCommandsDisplayPath} would be larger than ${maximumStartCommandsBytes / 1_024} KB, so it is not saved.`);
  }

  // The folder (only `~/.adari` itself is ever made, never a folder a link points into).
  const directory = parentOf(target);
  if (!exists) {
    const there = await files.lstat(folder);
    if (there === null) {
      try {
        await files.mkdir(folder, newStartCommandsFolderMode);
      } catch (error) {
        if ((await files.lstat(folder).catch(() => null))?.kind !== "directory") throw new StartCommandSaveError(`Could not make ~/.adari on the machine: ${reasonOf(error)}`);
      }
    } else if (there.kind !== "directory" && (there.kind !== "symlink" || (await files.stat(folder)).kind !== "directory")) {
      throw new StartCommandSaveError("~/.adari on the machine is not a folder, so the file is not saved.");
    }
  }

  // A temporary file beside the real one, then one rename over it.
  const name = target.slice(directory.length + 1);
  const temporary = `${directory === "/" ? "" : directory}/.${name}.${(options.random ?? randomHex)()}.adari-tmp`;
  try {
    await files.writeNew(temporary, data, mode);
  } catch (error) {
    await files.remove(temporary).catch(() => undefined);
    throw new StartCommandSaveError(`The machine did not take the new file: ${reasonOf(error)}`);
  }
  try {
    await files.replace(temporary, target);
  } catch (error) {
    await files.remove(temporary).catch(() => undefined);
    throw new StartCommandSaveError(`The machine did not put the new file in place: ${reasonOf(error)}`);
  }
  return parseStartCommands(data);
}

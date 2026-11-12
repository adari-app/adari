// Where a Maki session lives and how a pane finds it (Maki 0.x at tontinton/maki ac17ffe).
//
// Maki keeps one append-only log per session, `<state>/maki/sessions/<id>.jsonl`, with `<state>`
// `$XDG_STATE_HOME` when it is absolute, else `~/.local/state` (maki-storage/src/paths.rs:225-268,
// etcetera's XDG base strategy on macOS and Linux; sessions.rs:43, :1487 jsonl_path). The id is a
// UUIDv7 written in base58, 21 or 22 characters (maki-storage/src/id.rs:18-35). The file's first line
// is its header, `{"t":"header","v":3,"id":…,"model":…,"cwd":…,"created_at":…}` (sessions.rs:757-766,
// :1201-1214 write_full_session), so the folder a session belongs to is in the file itself.
//
// Herdr reports no session for Maki (agent_resume.rs is_official_agent_source has no `herdr:maki`), so a
// pane names one only through its argv (`maki -r <id>` and the rest, src/cli.rs:106-117) or follows its
// folder by Grok's rules (locator.ts folderFormats): the newest session whose header names the folder.
// Pure functions: the commands are unit-tested as text and only read.

/** POSIX single-quote escaping (locator.ts shellQuote, kept here so this file imports nothing of locator's). */
const quote = (value: string): string => "'" + value.split("'").join("'\"'\"'") + "'";

const hasControl = (value: string): boolean => {
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
};

const utf8Length = (value: string): number => new TextEncoder().encode(value).length;

const trimmed = (folder: string): string => {
  let value = folder;
  while (value.length > 1 && value.endsWith("/")) value = value.slice(0, -1);
  return value;
};

const usableFolder = (value: string): boolean => value.startsWith("/") && utf8Length(value) <= 4_096 && !hasControl(value);

/** A Maki session id: base58 (Bitcoin's alphabet), 16 to 22 characters; a v7 id is 21 or 22. */
export function isMakiSessionID(value: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{16,22}$/.test(value);
}

/** The session id a Maki session path is filed under, or null for any other path. */
export function makiSessionIDOfPath(path: string): string | null {
  if (!path.startsWith("/") || !path.endsWith(".jsonl") || utf8Length(path) > 4_096 || hasControl(path)) return null;
  const parts = path.split("/");
  const name = parts.at(-1) ?? "";
  const id = name.slice(0, -".jsonl".length);
  return parts.at(-2) === "sessions" && parts.at(-3) === "maki" && isMakiSessionID(id) ? id : null;
}

/** Whether `path` is a Maki session's log (`…/maki/sessions/<id>.jsonl`). */
export const isMakiSessionPath = (path: string): boolean => makiSessionIDOfPath(path) !== null;

/**
 * The session a Maki argv names (src/cli.rs:106-117, src/resume.rs:98-111, :203-209): `--session-id <id>`
 * (or `=`) is where the run writes; else `-r`, `-s`, `--resume` or `--session <id>` (or `=`), unless
 * `--fork-session` copies it under a new id. `-c` and a fork name none (the folder's newest then).
 */
export function makiSessionFromArgv(argv: readonly string[]): string | null {
  let resumed: string | null = null;
  let written: string | null = null;
  let forks = false;
  for (let index = 0; index < argv.length; index += 1) {
    const word = argv[index]!;
    const next = index + 1 < argv.length ? argv[index + 1]! : null;
    if (["-r", "-s", "--resume", "--session"].includes(word) && next !== null) resumed = next;
    else if (word.startsWith("--resume=")) resumed = word.slice("--resume=".length);
    else if (word.startsWith("--session=")) resumed = word.slice("--session=".length);
    else if (word === "--session-id" && next !== null) written = next;
    else if (word.startsWith("--session-id=")) written = word.slice("--session-id=".length);
    else if (word === "--fork-session") forks = true;
  }
  const id = written ?? (forks ? null : resumed);
  return id !== null && isMakiSessionID(id) ? id : null;
}

/** The `"cwd"` member a header gives the folder (serde_json writes it compact; JSON-escaped). */
export function makiHeaderCwd(folder: string): string {
  const escaped = trimmed(folder).split("\\").join("\\\\").split('"').join('\\"');
  return `"cwd":"${escaped}"`;
}

/** Maki's state folder, as sh: `$XDG_STATE_HOME` when absolute, else `$HOME/.local/state`. */
const stateFolder = 'case "${XDG_STATE_HOME:-}" in /*) d=$XDG_STATE_HOME;; *) d=$HOME/.local/state;; esac; ';

/** The sessions folder under `$d`, every literal part quoted. */
const sessions = '"$d"/' + quote("maki") + "/" + quote("sessions");

/** At most this many of the newest sessions are looked at for a folder's. */
export const makiFolderScanLimit = 256;

/** A session's header is its first line; this much of the file is read for it at most. */
export const maxMakiHeaderBytes = 64 * 1_024;

/** `/bin/sh` printing the session's log when it is a regular file, else nothing. Always exits 0. */
export function makiIDCommand(id: string): string | null {
  if (!isMakiSessionID(id)) return null;
  const script = stateFolder + "f=" + sessions + "/" + quote(id + ".jsonl") + '; [ -f "$f" ] && printf \'%s\\n\' "$f"; exit 0';
  return "/bin/sh -c " + quote(script);
}

/**
 * `/bin/sh` printing the newest session (by modification time, of the newest `makiFolderScanLimit`) whose
 * header names `folder` (head and grep read, nothing is written), skipping the ids in `exclude` (peers' and
 * earlier runs'). Always exits 0.
 */
export function makiFolderCommand(folder: string, exclude: readonly string[]): string | null {
  if (!usableFolder(folder) || !exclude.every(isMakiSessionID)) return null;
  const skip = exclude.length === 0 ? "" : " case \"$n\" in " + exclude.map((id) => quote(id + ".jsonl")).join("|") + ") continue;; esac;";
  const script =
    stateFolder +
    "cd -- " +
    sessions +
    " 2>/dev/null || exit 0; k=0; /bin/ls -t | while IFS= read -r n; do case \"$n\" in *.jsonl) ;; *) continue;; esac;" +
    skip +
    ' [ -f "$n" ] || continue; k=$((k+1)); [ "$k" -gt ' +
    String(makiFolderScanLimit) +
    " ] && break; if /usr/bin/head -c " +
    String(maxMakiHeaderBytes) +
    ' -- "$n" | /usr/bin/head -n 1 | /usr/bin/grep -qsF -e ' +
    quote(makiHeaderCwd(folder)) +
    "; then printf '%s/maki/sessions/%s\\n' \"$d\" \"$n\"; break; fi; done; exit 0";
  return "/bin/sh -c " + quote(script);
}

/** The path a command printed, when it is a Maki session log and the one asked for (by id, or not excluded). */
export function makiLocatedPath(output: string, lookup: { readonly kind: "id"; readonly id: string } | { readonly kind: "folder"; readonly exclude?: readonly string[] }): string | null {
  const line = output
    .split(/[\n\r]/)
    .map((part) => part.replace(/^[ \t]+|[ \t]+$/g, ""))
    .find((part) => part.length > 0);
  if (line === undefined) return null;
  const id = makiSessionIDOfPath(line);
  if (id === null) return null;
  if (lookup.kind === "id") return id === lookup.id ? line : null;
  return (lookup.exclude ?? []).includes(id) ? null : line;
}

/** A Maki log this reader does not know the format of (its header's `v` is newer or older than 2 to 3). */
export class MakiLogFormatError extends Error {
  constructor(readonly version: number) {
    super(`Maki log format ${version}`);
    this.name = "MakiLogFormatError";
  }
}

/** The log format versions read (sessions.rs:37-39: 3 now, 2 still read). */
export const makiLogVersions: readonly number[] = [2, 3];

/**
 * The folder a Maki session belongs to: its first line's header `cwd` (trailing slash ignored), read as JSON.
 * Null when the bytes hold no whole first line, it is not a header, or it names no usable folder. Throws
 * MakiLogFormatError for a header of a format this reader does not know (Maki refuses such a log whole too,
 * sessions.rs:1273-1284).
 */
export function makiHeaderFolder(bytes: Uint8Array): string | null {
  const end = bytes.indexOf(0x0a);
  if (end <= 0) return null;
  let header: unknown;
  try {
    header = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end)));
  } catch {
    return null;
  }
  if (typeof header !== "object" || header === null || Array.isArray(header)) return null;
  const record = header as Record<string, unknown>;
  if (record.t !== "header") return null;
  if (typeof record.v !== "number" || !makiLogVersions.includes(record.v)) throw new MakiLogFormatError(typeof record.v === "number" ? record.v : -1);
  const cwd = record.cwd;
  return typeof cwd === "string" && usableFolder(cwd) ? trimmed(cwd) : null;
}

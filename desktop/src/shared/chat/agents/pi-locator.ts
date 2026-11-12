// Where Pi and omp keep a session, and the one remote command that finds a pane's (the
// locator's, run by the readers' existing `locate`; read only). Imports nothing of locator.ts, which
// imports this file.
//
// - Herdr's pi and omp integrations report the session file's absolute path (`agent_session_path`,
//   the agent's `sessionManager.getSessionFile()`), else its id when the session is not saved
//   (`--no-session`): herdr src/integration/assets/pi/herdr-agent-state.ts:74-112 (omp's the same,
//   src/integration/assets/omp/herdr-agent-state.ts), src/agent_resume.rs:126-130 (path first, else id).
// - Pi files a session as `~/.pi/agent/sessions/--<cwd, its leading "/" dropped, "/" "\" ":" as "-">--/
//   <ISO time, ":" and "." as "-">_<id>.jsonl` (pi-mono packages/coding-agent/src/core/session-manager.ts:590-594,
//   :1079-1081), its id a UUID v7 (:264). The file is written at the user's first message, not before (:1162-1186).
// - omp: `~/.omp/agent/sessions/<dir>/<time>_<id>.jsonl` (oh-my-pi packages/coding-agent/src/session/
//   session-manager.ts:2119, packages/utils/src/dirs.ts:29), `<dir>` `-<path below the home folder, "/" "\"
//   ":" as "-">` (`-` for the home folder itself), else Pi's `--<path>--` (session-paths.ts:46-120); its id a
//   UUID v7 (session-manager.ts:150).
// - Either header names the session's folder: `{"type":"session",…,"cwd":"<folder>",…}` on the first line
//   (omp: the second, after its 256-byte title line), written by JSON.stringify (no spaces).

/** The two formats this file serves (TranscriptFormat's `pi` and `omp`, one parser: pi-parser.ts). */
export const piFormats = ["pi", "omp"] as const;
export type PiFormat = (typeof piFormats)[number];

/** Whether `format` is Pi's or omp's. */
export const isPiFormat = (format: string): format is PiFormat => (piFormats as readonly string[]).includes(format);

/** The sessions folder under the home folder. */
export const piSessionsDir: Readonly<Record<PiFormat, readonly string[]>> = {
  pi: [".pi", "agent", "sessions"],
  omp: [".omp", "agent", "sessions"],
};

/** A session file's name ends `_<UUID>.jsonl`. */
const fileID = /_([0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})\.jsonl$/;

/** The folder lookup reads this much of a file at most for its header (omp's title line, then the header). */
export const maxPiHeaderBytes = 64 * 1_024;

/** POSIX single-quote escaping (locator.ts shellQuote's rule). */
const quote = (value: string): string => "'" + value.split("'").join("'\"'\"'") + "'";

const home = '"$HOME"';

/** A trailing slash is not the folder's. */
const trimmed = (folder: string): string => {
  let value = folder;
  while (value.length > 1 && value.endsWith("/")) value = value.slice(0, -1);
  return value;
};

/** The session id a session file's name carries, or null. */
export function piSessionIDOfPath(path: string): string | null {
  const match = fileID.exec(path.slice(path.lastIndexOf("/") + 1));
  return match === null ? null : match[1]!;
}

/** Pi's folder name for a working folder (`--<path>--`, omp's for one outside the home folder too). */
export function piFolderName(folder: string): string {
  return "--" + trimmed(folder).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-") + "--";
}

/** The header's `cwd` member for the folder, as JSON.stringify writes it. */
export function piHeaderCwd(folder: string): string {
  return `"cwd":"${trimmed(folder).split("\\").join("\\\\").split('"').join('\\"')}"`;
}

const sessionsBase = (format: PiFormat): string => home + "/" + piSessionsDir[format].map(quote).join("/") + "/";

/** The glob for a session id: `*_<id>.jsonl` in any folder of the agent's sessions folder. */
export function piTranscriptGlobs(format: PiFormat, id: string): string[] {
  return [sessionsBase(format) + "*/*" + quote("_" + id + ".jsonl")];
}

/**
 * The folder's sessions whose header names the folder (head and grep read, never write; at most
 * `maxPiHeaderBytes` of each), the newest by modification time, sessions peers name skipped. Pi looks in
 * its folder for the path; omp in its name for the path below the home folder, then Pi's.
 */
export function piFolderCommand(format: PiFormat, folder: string, exclude: readonly string[]): string {
  const absolute = quote(piFolderName(folder));
  const names =
    format === "pi"
      ? "for d in " + absolute + "; do "
      : "f=" +
        quote(trimmed(folder)) +
        '; n=; case "$f" in "$HOME") n=-;; "$HOME"/*) r=${f#"$HOME"/}; n=-$(printf \'%s\' "$r" | /usr/bin/sed \'s#[/:\\\\]#-#g\');; esac; ' +
        'for d in "$n" ' +
        absolute +
        '; do [ -n "$d" ] || continue; ';
  const skip = exclude.length === 0 ? "" : ' case "$p" in ' + exclude.map((id) => "*" + quote("_" + id + ".jsonl")).join("|") + ") continue;; esac;";
  const script =
    "set --; " +
    names +
    "for p in " +
    sessionsBase(format) +
    '"$d"/*' +
    quote(".jsonl") +
    '; do [ -f "$p" ] || continue;' +
    skip +
    ` /usr/bin/head -c ${maxPiHeaderBytes} -- "$p" | /usr/bin/head -n 2 | /usr/bin/grep -F ` +
    quote('{"type":"session",') +
    " | /usr/bin/grep -qsF -e " +
    quote(piHeaderCwd(folder)) +
    ' && set -- "$@" "$p"; done; done; ' +
    '[ "$#" -gt 0 ] && /bin/ls -t -- "$@" | /usr/bin/head -n 1; exit 0';
  return "/bin/sh -c " + quote(script);
}

/** A lookup the locate command ran for (locator.ts TranscriptLookup's id and folder kinds). */
export type PiLookup = { readonly kind: "id"; readonly id: string } | { readonly kind: "folder"; readonly folder: string; readonly exclude?: readonly string[] };

/**
 * The path the command printed (already a usable absolute `.jsonl` path), when it is the file asked for:
 * `<home>/.pi|.omp/agent/sessions/<dir>/<time>_<id>.jsonl`, its id the one looked up, or for a folder Pi's
 * name for it (omp: a name of its own, which starts "-"), its id not one skipped.
 */
export function piLocatedPath(line: string, format: PiFormat, lookup: PiLookup): string | null {
  const parts = line.split("/");
  const count = parts.length;
  const dirs = piSessionsDir[format];
  if (count < 6 || parts.slice(0, -1).some((part) => part === "." || part === "..")) return null;
  if (parts[count - 5] !== dirs[0] || parts[count - 4] !== dirs[1] || parts[count - 3] !== dirs[2]) return null;
  const id = piSessionIDOfPath(line);
  if (id === null) return null;
  if (lookup.kind === "id") return id === lookup.id ? line : null;
  if ((lookup.exclude ?? []).includes(id)) return null;
  const dir = parts[count - 2]!;
  return (format === "pi" ? dir === piFolderName(lookup.folder) : dir.startsWith("-")) ? line : null;
}

/** The note two Pi (or omp) panes in one folder that name no session show (ChatView's unavailable texts). */
export function piAmbiguousReason(agent: string | null | undefined): "ambiguousPiSession" | "ambiguousOmpSession" | null {
  const name = agent?.toLowerCase();
  return name === "pi" ? "ambiguousPiSession" : name === "omp" ? "ambiguousOmpSession" : null;
}

// Which transcript a pane's agent session names, and the one remote command
// that finds it. Pure functions, so the command is unit-tested as text; the
// main process runs it over SSH and reads the file over SFTP, read only.
// A port of HerdrKit's TranscriptLocator.swift, CoreAgentKind.session
// (CoreProjection.swift: the session an argv names) and ChatFolderMatch
// (ChatFeed.swift), plus a desktop addition: with no session named, a Claude
// pane's newest transcript in its project folder.

import { cursorChatIDOfStore, cursorFolderHash, isCursorStorePath } from "./cursor-store";
import { isPiFormat, piFolderCommand, piFormats, piLocatedPath, piSessionIDOfPath, piTranscriptGlobs } from "./agents/pi-locator";
import { kimiAmbiguousNote, kimiLocateCommand, kimiLookupExcludes, kimiLookupValid, kimiParseLocateOutput, kimiArgvSession, kimiSessionIDOf } from "./agents/kimi-locate";
import type { TranscriptFormat } from "./parser";
import { isOpenCodeFormat, openCodeLocateCommand, openCodePeerSession, openCodeRefFromAgentSession, openCodeSessionFromArgv, openCodeSessionRef, parseOpenCodeLocateOutput } from "./agents/opencode-locate";
// Gemini CLI, Qwen Code and Antigravity CLI.
import {
  geminiFamilyFormatOfAgent,
  geminiFamilyFormatOfSource,
  geminiFamilyLocateCommand,
  geminiFamilyParseLocateOutput,
  isGeminiFamilyFormat,
  qwenLookupExcludes,
  qwenSessionIDOf,
} from "./agents/gemini-family";
import { copilotFolderCommand, copilotGlobs, copilotLocated, copilotLookupExcludes, copilotResumeID, copilotSessionIDOf } from "./agents/copilot-locate";
import { droidFolderCommand, droidGlobs, droidLocated, droidLookupExcludes, droidResumeID, droidSessionIDOf } from "./agents/droid-locate";
import { isMakiSessionID, makiFolderCommand, makiIDCommand, makiLocatedPath, makiSessionFromArgv, makiSessionIDOfPath } from "./agents/maki-session";
import { hermesLocateCommand, hermesRefFromAgentSession, hermesSessionFromArgv, hermesSessionRef, isHermesFormat, parseHermesLocateOutput } from "./agents/hermes-locate";
import { isMastraFormat, mastraLocateCommand, mastraRefFromAgentSession, mastraSessionFromArgv, mastraSessionRef, parseMastraLocateOutput } from "./agents/mastra-locate";
import { clineLocateCommand, clinePeerSession, clineSessionRef, isClineFormat, parseClineLocateOutput } from "./agents/cline-locate";
import { onlyOneFile } from "./agents/only-one";
import { isKiroFormat, kiroFormatOfAgent, kiroLocateCommand, kiroParseLocateOutput, kiroSessionRef } from "./agents/kiro-locate";
import { coreChatSession, type CoreFoundSessionLike } from "./core-pane-session";
import { isForeignCorePane } from "./core-pane-session";
import { readerKind } from "../agent-names"; // the one alias mapping
import { codexResumeArgvID } from "../codex-start";

/** Herdr's `agent_session` (wire.ts AgentSessionInfo), structurally. */
export interface AgentSessionLike {
  readonly source: string;
  readonly agent: string;
  readonly kind: string;
  readonly value: string;
}

/** The parts of an agent pane (wire.ts AgentInfo) the locator reads. */
export interface AgentPaneLike {
  readonly agent?: string;
  readonly agentSession?: AgentSessionLike;
  readonly cwd?: string;
}

/** How a transcript is found. */
export type TranscriptLookup =
  /** A session id, already checked against `^[0-9A-Za-z-]{8,64}$`. */
  | { readonly kind: "id"; readonly id: string }
  /** An absolute `.jsonl` path Herdr reported. */
  | { readonly kind: "path"; readonly path: string }
  /**
   * Desktop addition: the newest Claude Code transcript in this folder's project directory;
   * for Grok, the newest session filed under the folder (`~/.grok/sessions/<folder,
   * percent-encoded>/<id>/updates.jsonl`) whose summary.json names it.
   */
  | {
      readonly kind: "folder";
      readonly folder: string;
      /**
       * Grok's sessions already bound to peer panes (their ids), never this
       * pane's; absent or empty, none.
       */
      readonly exclude?: readonly string[];
    };

/** The transcript a pane's agent session names: which agent, and how to find the file. */
export interface TranscriptSessionRef {
  readonly format: TranscriptFormat;
  readonly lookup: TranscriptLookup;
}

/** Where a chat session came from. */
export type ChatSessionSource =
  | "herdr:claude"
  | "herdr:codex"
  | "herdr:grok"
  | "herdr:cursor"
  | "argv"
  | "folder"
  | "herdr:pi"
  | "herdr:omp"
  | "herdr:opencode"
  | "herdr:kilo"
  // The format a Herdr report named (`herdr:qwen`; `herdr:antigravity_cli` as `herdr:antigravity`; none names Gemini's).
  | "herdr:gemini"
  | "herdr:qwen"
  | "herdr:antigravity"
  | "herdr:copilot"
  | "herdr:droid"
  | "herdr:kimi"
  // Herdr reports no Maki session; an argv names one as herdr:maki (sessionFromArgv).
  | "herdr:maki"
  | "herdr:hermes"
  | "herdr:mastracode"
  // Herdr reports no Cline session: `herdr:cline` is never made, the type only.
  | "herdr:cline"
  | "herdr:kiro"; // Herdr reports no Kiro session: never made, the type only

/** What the chat follows for one pane. */
export interface ChatSession {
  readonly ref: TranscriptSessionRef;
  readonly source: ChatSessionSource;
  /** The pane's working folders (cwd, foreground cwd), for the folder check; empty skips it. */
  readonly paneFolders: readonly string[];
}

const maxPathBytes = 4_096;

const utf8Length = (value: string): number => new TextEncoder().encode(value).length;

const hasControl = (value: string): boolean => {
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
};

/** Herdr's session ids are UUIDs; anything else never reaches a command. */
export function isValidSessionID(value: string): boolean {
  return /^[0-9A-Za-z-]{8,64}$/.test(value);
}

/** Grok's session ids are UUIDs (v7), 36 characters; `--resume` takes a title too, which is not one. */
export function isGrokSessionID(value: string): boolean {
  return /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/.test(value);
}

/** The formats whose sessions are UUIDs and whose panes follow their folder by Grok's rules. */
export const folderFormats: readonly TranscriptFormat[] = [
  "grok",
  "cursor",
  /** Pi's and omp's (UUID v7 ids), when Herdr names no session. */
  ...piFormats,
  // Gemini CLI (no session Herdr names), Qwen Code (when Herdr names none).
  "gemini",
  "qwen",
  "copilot", // a pane that names no session follows its folder by the same rules
  "droid",
  "kimi", // Kimi's by the same rules
  // Maki's panes follow their folder by the same rules (its sessions are base58 ids, isMakiSessionID).
  "maki",
  // Kiro's V3 sessions, by the same rules (agents/kiro-locate.ts: the session.json's folder decides).
  "kiro",
];
const followsFolder = (format: TranscriptFormat): boolean => folderFormats.includes(format);

/** An absolute `.jsonl` path of at most 4,096 bytes with no control characters. */
export function isUsablePath(value: string): boolean {
  return value.startsWith("/") && value.endsWith(".jsonl") && utf8Length(value) <= maxPathBytes && !hasControl(value);
}

/** An absolute folder of at most 4,096 bytes with no control characters. */
export function isUsableFolder(value: string): boolean {
  return value.startsWith("/") && utf8Length(value) <= maxPathBytes && !hasControl(value);
}

/** POSIX single-quote escaping (the transport's own rule, commands.ts shellQuote). */
export function shellQuote(value: string): string {
  return "'" + value.split("'").join("'\"'\"'") + "'";
}

/** At most this many peers' sessions are skipped; more is refused. */
export const maxExcluded = 64;

/** A checked ref, or null when the lookup is not safe to use. */
export function makeSessionRef(format: TranscriptFormat, lookup: TranscriptLookup): TranscriptSessionRef | null {
  if (isOpenCodeFormat(format)) return openCodeSessionRef(format, lookup);
  if (format === "kimi") return kimiLookupValid(lookup) ? { format, lookup } : null; // `session_<uuid>` ids, wire paths
  if (isHermesFormat(format)) return hermesSessionRef(lookup);
  if (isMastraFormat(format)) return mastraSessionRef(lookup);
  if (isClineFormat(format)) return clineSessionRef(lookup);
  if (isKiroFormat(format)) return kiroSessionRef(lookup); // a folder lookup only
  switch (lookup.kind) {
    case "id":
      // A Maki session's id is base58, not a UUID.
      if (format === "maki") return isMakiSessionID(lookup.id) ? { format, lookup } : null;
      if (!isValidSessionID(lookup.id) || (followsFolder(format) && !isGrokSessionID(lookup.id))) return null;
      break;
    case "path":
      // A Cursor session is its store.db, never a `.jsonl`.
      if (format === "cursor" ? !isCursorStorePath(lookup.path) : !isUsablePath(lookup.path)) return null;
      break;
    case "folder":
      if (format === "codex" || !isUsableFolder(lookup.folder)) return null;
      // An Antigravity transcript names no folder: Herdr's id only.
      if (format === "antigravity") return null;
      // Maki's peers and earlier runs are skipped by their base58 ids.
      if (format === "maki") return lookup.exclude === undefined || (lookup.exclude.length <= maxExcluded && lookup.exclude.every(isMakiSessionID)) ? { format, lookup } : null;
      if (lookup.exclude !== undefined && (!followsFolder(format) || lookup.exclude.length > maxExcluded || !lookup.exclude.every(isGrokSessionID))) return null;
      break;
  }
  return { format, lookup };
}

/**
 * From Herdr's `agent_session`. Null when there is nothing safe to look up:
 * another source than `herdr:claude` / `herdr:codex`, an id that is not 8 to 64
 * letters, digits and dashes, or a path that is not an absolute `.jsonl` path.
 */
export function sessionRefFromAgentSession(session: AgentSessionLike): TranscriptSessionRef | null {
  if (session.source === "herdr:opencode" || session.source === "herdr:kilo") return openCodeRefFromAgentSession(session);
  if (session.source === "herdr:hermes") return hermesRefFromAgentSession(session);
  if (session.source === "herdr:mastracode") return mastraRefFromAgentSession(session);
  let format: TranscriptFormat;
  switch (session.source) {
    case "herdr:claude":
      format = "claude";
      break;
    case "herdr:codex":
      format = "codex";
      break;
    case "herdr:grok":
      format = "grok";
      break;
    case "herdr:cursor":
      format = "cursor";
      break;
    // Pi's and omp's session file (a path; an id when the session is not saved).
    case "herdr:pi":
    case "herdr:omp":
      format = session.source === "herdr:pi" ? "pi" : "omp";
      break;
    // Qwen Code's and Antigravity CLI's hooks (agents/gemini-family.ts).
    case "herdr:qwen":
    case "herdr:antigravity_cli":
      format = geminiFamilyFormatOfSource(session.source)!;
      break;
    case "herdr:copilot": format = "copilot"; break;
    case "herdr:droid": format = "droid"; break;
    case "herdr:kimi":
      format = "kimi";
      break;
    // Maki (named by an argv only).
    case "herdr:maki":
      format = "maki";
      break;
    default:
      return null;
  }
  switch (session.kind) {
    case "id":
      return makeSessionRef(format, { kind: "id", id: session.value });
    case "path":
      return makeSessionRef(format, { kind: "path", path: session.value });
    case "folder":
      // Only a format whose panes follow their folder (followsFolder).
      return followsFolder(format) ? makeSessionRef(format, { kind: "folder", folder: session.value }) : null;
    default:
      return null;
  }
}

/**
 * The agent session an agent's argv names, when it names one:
 * `claude --resume <id>` / `-r <id>` / `--session-id <id>` (or `--resume=<id>`),
 * `codex resume <id>` (`--no-daemon` before or after the id; CoreAgentKind.session). Null for an id that is not valid,
 * an empty `--resume=`, or a following word that is a flag.
 */
export function sessionFromArgv(argv: readonly string[], kind: string): AgentSessionLike | null {
  if (isOpenCodeFormat(kind)) return openCodeSessionFromArgv(argv, kind);
  if (kind === "kimi") return kimiArgvSession(argv); // -S/--session <id>
  if (isHermesFormat(kind)) return hermesSessionFromArgv(argv);
  if (isMastraFormat(kind)) return mastraSessionFromArgv(argv);
  if (isClineFormat(kind)) return null; // Cline binds by folder only
  let id: string | null = null;
  switch (kind) {
    case "claude":
      for (let index = 0; index < argv.length; index += 1) {
        const word = argv[index]!;
        if (["--resume", "-r", "--session-id"].includes(word) && index + 1 < argv.length) {
          id = argv[index + 1]!;
        } else if (word.startsWith("--resume=") || word.startsWith("--session-id=")) {
          id = word.slice(word.indexOf("=") + 1);
        }
      }
      break;
    case "codex":
      // `--no-daemon` before or after the id (codex-start.ts codexResumeArgvID).
      id = codexResumeArgvID(argv);
      break;
    case "grok":
      // `grok -r <id>`, `--resume <id>`, `--resume=<id>`; a title is no id.
      for (let index = 0; index < argv.length; index += 1) {
        const word = argv[index]!;
        if ((word === "--resume" || word === "-r") && index + 1 < argv.length) id = argv[index + 1]!;
        else if (word.startsWith("--resume=")) id = word.slice("--resume=".length);
      }
      if (id === null || !isGrokSessionID(id)) return null;
      break;
    case "cursor":
      // `cursor-agent --resume <id>` / `--resume=<id>` (a chat id, a UUID); `--resume`
      // alone and `--continue` name none (the folder's newest then, as a run that names no id).
      for (let index = 0; index < argv.length; index += 1) {
        const word = argv[index]!;
        if (word === "--resume" && index + 1 < argv.length) id = argv[index + 1]!;
        else if (word.startsWith("--resume=")) id = word.slice("--resume=".length);
      }
      if (id === null || !isGrokSessionID(id)) return null;
      break;
    case "copilot": id = copilotResumeID(argv); break; // `copilot --resume=<id>`
    case "droid": id = droidResumeID(argv); break; // `droid --resume <id>`
    // `maki --session-id <id>`, else `-r`/`-s`/`--resume`/`--session <id>` (not forked); `-c` names none.
    case "maki":
      id = makiSessionFromArgv(argv);
      break;
    default:
      return null;
  }
  if (id === null || id.startsWith("-") || !isValidSessionID(id)) return null;
  return { source: `herdr:${kind}`, agent: kind, kind: "id", value: id };
}

/** The project directory name Claude Code gives a folder: every character but A–Z, a–z, 0–9 becomes `-`. */
export function claudeProjectSlug(folder: string): string {
  return folder.replace(/[^A-Za-z0-9]/g, "-");
}

const home = '"$HOME"';

/**
 * The globs for a session id, every literal part quoted: Claude Code
 * `<config>/projects/<slug>/<id>.jsonl` with config `~/.claude` or
 * `~/.claude-seats/<account>`; Codex `~/.codex/sessions/YYYY/MM/DD/rollout-*-<id>.jsonl`.
 */
export function transcriptGlobs(format: TranscriptFormat, id: string): string[] {
  if (format === "claude") {
    const file = shellQuote(id + ".jsonl");
    return [
      home + "/" + shellQuote(".claude") + "/" + shellQuote("projects") + "/*/" + file,
      home + "/" + shellQuote(".claude-seats") + "/*/" + shellQuote("projects") + "/*/" + file,
    ];
  }
  if (isPiFormat(format)) return piTranscriptGlobs(format, id);
  if (format === "grok") return [home + "/" + shellQuote(".grok") + "/" + shellQuote("sessions") + "/*/" + shellQuote(id) + "/" + shellQuote("updates.jsonl")];
  // `~/.cursor/chats/<md5 of the cwd>/<chat id>/store.db`.
  if (format === "cursor") return [home + "/" + shellQuote(".cursor") + "/" + shellQuote("chats") + "/*/" + shellQuote(id) + "/" + shellQuote("store.db")];
  if (format === "copilot") return copilotGlobs(id); // `~/.copilot/session-state/<id>/events.jsonl`
  if (format === "droid") return droidGlobs(id); // `~/.factory/sessions/[<folder>/]<id>.jsonl`
  return [home + "/" + shellQuote(".codex") + "/" + shellQuote("sessions") + "/*/*/*/" + shellQuote("rollout-") + "*" + shellQuote("-" + id + ".jsonl")];
}

/** A trailing slash is not the folder's. */
const trimmedFolder = (folder: string): string => {
  let trimmed = folder;
  while (trimmed.length > 1 && trimmed.endsWith("/")) trimmed = trimmed.slice(0, -1);
  return trimmed;
};

/**
 * The folder Grok files a working folder's sessions in: the path percent-encoded
 * ("/" is %2F, " " is %20), every byte but A–Z, a–z, 0–9 and `-._~` as %XX.
 */
export function grokFolderName(folder: string): string {
  let name = "";
  for (const byte of new TextEncoder().encode(trimmedFolder(folder))) {
    const unreserved =
      (byte >= 48 && byte <= 57) || (byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122) || byte === 45 || byte === 46 || byte === 95 || byte === 126;
    name += unreserved ? String.fromCharCode(byte) : "%" + byte.toString(16).toUpperCase().padStart(2, "0");
  }
  return name;
}

/** The `"cwd"` member a Grok summary.json gives the folder, both ways it may be spaced (JSON-escaped). */
export function grokSummaryCwd(folder: string): string[] {
  const escaped = trimmedFolder(folder).split("\\").join("\\\\").split('"').join('\\"');
  return [`"cwd":"${escaped}"`, `"cwd": "${escaped}"`];
}

/** A Grok summary.json is a few hundred bytes; one this long or longer is not read. */
export const maxGrokSummaryBytes = 64 * 1_024;

/** The summary.json beside a Grok session's updates.jsonl, or null for another path. */
export function grokSummaryPath(transcript: string): string | null {
  return transcript.endsWith("/updates.jsonl") ? transcript.slice(0, -"updates.jsonl".length) + "summary.json" : null;
}

/**
 * The folder a Grok session belongs to, its summary.json's `info.cwd` read as
 * JSON (a folder named anywhere else in the file is not it), trailing slash ignored. Null when the
 * file is not JSON, too long, or names no usable folder there.
 */
export function grokSummaryFolder(bytes: Uint8Array): string | null {
  if (bytes.length === 0 || bytes.length >= maxGrokSummaryBytes) return null;
  let summary: unknown;
  try {
    summary = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
  const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
  if (!isObject(summary) || !isObject(summary.info)) return null;
  const cwd = summary.info.cwd;
  if (typeof cwd !== "string" || !isUsableFolder(cwd)) return null;
  return trimmedFolder(cwd);
}

/**
 * Whether a located Grok session is the pane's. Its summary's folder must be
 * the folder looked up (a folder lookup) or one of the pane's folders (an ID or a path); a session
 * whose summary names no folder never is. With no pane folders (the caller has none) an ID or path
 * is not checked against them, as the feeds' folder check skips.
 */
export function grokSessionOwned(owner: string | null, ref: TranscriptSessionRef, paneFolders: readonly string[]): boolean {
  if (owner === null) return false;
  if (ref.lookup.kind === "folder") return owner === trimmedFolder(ref.lookup.folder);
  const folders = paneFolders.map(trimmedFolder).filter((value) => value.length > 0);
  return folders.length === 0 || folders.includes(owner);
}

/**
 * Whether `path` is the updates.jsonl of a session the Grok folder lookup excludes
 * (a peer's, or an earlier run's): checked again on what a reader located, whichever reader it is.
 */
export function grokLookupExcludes(ref: TranscriptSessionRef, path: string): boolean {
  // A Qwen transcript, `<id>.jsonl`.
  if (ref.format === "qwen") return qwenLookupExcludes(ref, path);
  if (!followsFolder(ref.format) || ref.lookup.kind !== "folder" || ref.lookup.exclude === undefined) return false;
  if (isPiFormat(ref.format)) return ref.lookup.exclude.includes(piSessionIDOfPath(path) ?? "");
  if (ref.format === "kimi") return kimiLookupExcludes(ref.lookup, path); // `<id>/agents/main/wire.jsonl`
  // A Maki session's log is named by its id.
  if (ref.format === "maki") return ref.lookup.exclude.includes(makiSessionIDOfPath(path) ?? "");
  const parts = path.split("/");
  if (ref.format === "copilot") return copilotLookupExcludes(ref.lookup, path);
  if (ref.format === "droid") return droidLookupExcludes(ref.lookup, path);
  // A Cursor chat's store.db, its chat folder the id.
  return (parts.at(-1) === "updates.jsonl" || parts.at(-1) === "store.db") && ref.lookup.exclude.includes(parts.at(-2) ?? "");
}

/**
 * The folder's agent folders (`~/.cursor/chats/<md5>/<chat id>/`) holding a store.db
 * whose meta.json names the folder as its `cwd` (grep reads, never writes), each printed after its
 * meta.json `updatedAtMs` (sed reads it; 0 when it has none), sorted newest first, the newest's
 * store.db path kept. Chats peers name are skipped.
 */
function cursorFolderCommand(folder: string, exclude: readonly string[]): string {
  const base = home + "/" + shellQuote(".cursor") + "/" + shellQuote("chats") + "/" + shellQuote(cursorFolderHash(folder)) + "/*/";
  const patterns = grokSummaryCwd(folder)
    .map((pattern) => "-e " + shellQuote(pattern))
    .join(" ");
  const skip = exclude.length === 0 ? "" : ' case "$d" in ' + exclude.map((id) => "*/" + shellQuote(id)).join("|") + ") continue;; esac;";
  const updated = shellQuote('s/.*"updatedAtMs"[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p');
  const script =
    "for d in " +
    base +
    "; do d=${d%/};" +
    skip +
    ' [ -f "$d/store.db" ] || continue; ' +
    "/usr/bin/grep -qsF " +
    patterns +
    ' -- "$d/meta.json" || continue; ' +
    "t=$(/usr/bin/sed -n " +
    updated +
    ' -- "$d/meta.json" | /usr/bin/head -n 1); ' +
    "printf '%s %s\\n' \"${t:-0}\" \"$d/store.db\"; done | /usr/bin/sort -rn | /usr/bin/head -n 1 | /usr/bin/sed 's/^[0-9]* //'; exit 0";
  return "/bin/sh -c " + shellQuote(script);
}

/** The folder's sessions whose summary.json names the folder (grep reads, never writes), the newest. */
function grokFolderCommand(folder: string, exclude: readonly string[]): string {
  const glob = home + "/" + shellQuote(".grok") + "/" + shellQuote("sessions") + "/" + shellQuote(grokFolderName(folder)) + "/*/" + shellQuote("updates.jsonl");
  const patterns = grokSummaryCwd(folder)
    .map((pattern) => "-e " + shellQuote(pattern))
    .join(" ");
  // A session a peer pane names is never this pane's (its folder is skipped).
  const skip = exclude.length === 0 ? "" : ' case "${f%/*}" in ' + exclude.map((id) => "*/" + shellQuote(id)).join("|") + ") continue;; esac;";
  const script =
    "set --; for f in " +
    glob +
    "; do" +
    skip +
    ' [ -f "$f" ] && /usr/bin/grep -qsF ' +
    patterns +
    ' -- "${f%/*}/summary.json" && set -- "$@" "$f"; done; ' +
    '[ "$#" -gt 0 ] && /bin/ls -t -- "$@" | /usr/bin/head -n 1; exit 0';
  return "/bin/sh -c " + shellQuote(script);
}

/** The globs for a Claude folder: every transcript in its project directory, in either config. */
export function folderGlobs(folder: string): string[] {
  const slug = shellQuote(claudeProjectSlug(folder));
  const file = "*" + shellQuote(".jsonl");
  return [
    home + "/" + shellQuote(".claude") + "/" + shellQuote("projects") + "/" + slug + "/" + file,
    home + "/" + shellQuote(".claude-seats") + "/*/" + shellQuote("projects") + "/" + slug + "/" + file,
  ];
}

/** The one regular file the globs match, or nothing (none, or two distinct). */
function onlyOf(globs: readonly string[]): string {
  const script = "set --; for f in " + globs.join(" ") + '; do [ -f "$f" ] && set -- "$@" "$f"; done; ' + onlyOneFile;
  return "/bin/sh -c " + shellQuote(script);
}

function newestOf(globs: readonly string[]): string {
  const script =
    "set --; for f in " +
    globs.join(" ") +
    '; do [ -f "$f" ] && set -- "$@" "$f"; done; ' +
    '[ "$#" -gt 0 ] && /bin/ls -t -- "$@" | /usr/bin/head -n 1; exit 0';
  return "/bin/sh -c " + shellQuote(script);
}

/**
 * One `/bin/sh` command (so zsh's no-match error never applies) that keeps the
 * globs' matches that are regular files and prints the newest by modification
 * time, or nothing. Always exits 0. Null for a path lookup or anything not valid.
 */
export function locateCommand(ref: TranscriptSessionRef): string | null {
  if (isOpenCodeFormat(ref.format)) return openCodeLocateCommand(ref);
  if (isGeminiFamilyFormat(ref.format)) return geminiFamilyLocateCommand(ref);
  if (ref.format === "kimi") return kimiLocateCommand(ref.lookup);
  if (isHermesFormat(ref.format)) return hermesLocateCommand(ref);
  if (isMastraFormat(ref.format)) return mastraLocateCommand(ref);
  if (isClineFormat(ref.format)) return clineLocateCommand(ref);
  if (isKiroFormat(ref.format)) return kiroLocateCommand(ref);
  const lookup = ref.lookup;
  switch (lookup.kind) {
    case "id":
      // Maki's log by its id, in Maki's state folder.
      if (ref.format === "maki") return makiIDCommand(lookup.id);
      // For Pi, omp, Copilot and Droid an id names one file: two copies (another folder's, a
      // migrated one) are neither, never the newer.
      if (isPiFormat(ref.format) || ref.format === "copilot" || ref.format === "droid") return isValidSessionID(lookup.id) ? onlyOf(transcriptGlobs(ref.format, lookup.id)) : null;
      return isValidSessionID(lookup.id) ? newestOf(transcriptGlobs(ref.format, lookup.id)) : null;
    case "folder":
      if (!isUsableFolder(lookup.folder)) return null;
      // The newest Maki session whose header names the folder.
      if (ref.format === "maki") return makiFolderCommand(lookup.folder, lookup.exclude ?? []);
      if (ref.format === "grok") return grokFolderCommand(lookup.folder, lookup.exclude ?? []);
      if (ref.format === "cursor") return cursorFolderCommand(lookup.folder, lookup.exclude ?? []);
      if (isPiFormat(ref.format)) return piFolderCommand(ref.format, lookup.folder, lookup.exclude ?? []);
      if (ref.format === "copilot") return copilotFolderCommand(lookup.folder, lookup.exclude ?? []);
      if (ref.format === "droid") return droidFolderCommand(lookup.folder, lookup.exclude ?? []);
      return ref.format === "claude" ? newestOf(folderGlobs(lookup.folder)) : null;
    case "path":
      return null;
  }
}

/** The path the command printed, when it is the file asked for. */
export function parseLocateOutput(output: string, ref: TranscriptSessionRef): string | null {
  if (isOpenCodeFormat(ref.format)) return parseOpenCodeLocateOutput(output, ref);
  if (isGeminiFamilyFormat(ref.format)) return geminiFamilyParseLocateOutput(output, ref);
  if (ref.format === "kimi") return kimiParseLocateOutput(output, ref.lookup);
  if (isHermesFormat(ref.format)) return parseHermesLocateOutput(output, ref);
  if (isMastraFormat(ref.format)) return parseMastraLocateOutput(output, ref);
  if (isClineFormat(ref.format)) return parseClineLocateOutput(output, ref);
  if (isKiroFormat(ref.format)) return kiroParseLocateOutput(output, ref);
  const lookup = ref.lookup;
  if (lookup.kind === "path") return null;
  // A Maki session's log (`…/maki/sessions/<id>.jsonl`); its folder is checked on its header.
  if (ref.format === "maki") return makiLocatedPath(output, lookup);
  const line = output
    .split(/[\n\r]/)
    .map((part) => part.replace(/^[ \t]+|[ \t]+$/g, ""))
    .find((part) => part.length > 0);
  // `<home>/.cursor/chats/<md5 of the cwd>/<chat id>/store.db`.
  if (ref.format === "cursor") {
    if (line === undefined || !isCursorStorePath(line)) return null;
    const parts = line.split("/");
    const chat = parts[parts.length - 2]!;
    if (lookup.kind === "id") return chat === lookup.id ? line : null;
    return parts[parts.length - 3] === cursorFolderHash(lookup.folder) && !(lookup.exclude ?? []).includes(chat) ? line : null;
  }
  if (line === undefined || !isUsablePath(line)) return null;
  if (isPiFormat(ref.format)) return piLocatedPath(line, ref.format, lookup);
  if (ref.format === "copilot") return copilotLocated(line, lookup);
  if (ref.format === "droid") return droidLocated(line, lookup);
  const parts = line.split("/").filter((part) => part.length > 0);
  const name = parts[parts.length - 1] ?? "";
  if (ref.format === "grok") {
    // `<home>/sessions/<folder name>/<session id>/updates.jsonl`
    if (name !== "updates.jsonl" || parts.length < 4) return null;
    const session = parts[parts.length - 2]!;
    if (lookup.kind === "id") return session === lookup.id ? line : null;
    if ((lookup.exclude ?? []).includes(session)) return null;
    return isGrokSessionID(session) && parts[parts.length - 3] === grokFolderName(lookup.folder) && parts[parts.length - 4] === "sessions" ? line : null;
  }
  if (lookup.kind === "folder") {
    // `<config>/projects/<slug>/<session id>.jsonl`
    const parent = parts[parts.length - 2];
    const projects = parts[parts.length - 3];
    const session = name.slice(0, -".jsonl".length);
    return parent === claudeProjectSlug(lookup.folder) && projects === "projects" && isValidSessionID(session) ? line : null;
  }
  if (ref.format === "claude") return name === lookup.id + ".jsonl" ? line : null;
  return name.startsWith("rollout-") && name.endsWith("-" + lookup.id + ".jsonl") ? line : null;
}

// MARK: - the folder rule (ChatFolderMatch)

/** A trailing slash is ignored. */
export function normalisedFolder(path: string): string {
  let folder = path;
  while (folder.length > 1 && folder.endsWith("/")) folder = folder.slice(0, -1);
  return folder;
}

const isInside = (child: string, parent: string): boolean => (parent === "/" ? child.startsWith("/") : child.startsWith(parent + "/"));

/** Equal folders match, and so do a folder and one inside it (either way round). */
export function foldersMatch(first: string, second: string): boolean {
  const a = normalisedFolder(first);
  const b = normalisedFolder(second);
  if (a.length === 0 || b.length === 0) return false;
  return a === b || isInside(a, b) || isInside(b, a);
}

/** Whether a transcript's working folder is one of the pane's (or inside or around it). */
export function transcriptFolderMatches(folder: string, paneFolders: readonly string[]): boolean {
  return paneFolders.some((paneFolder) => foldersMatch(folder, paneFolder));
}

/** The same rule under the Swift name (ChatFeed.swift ChatFolderMatch); the feed uses this one. */
export const ChatFolderMatch = {
  normalised: normalisedFolder,
  matches: foldersMatch,
  transcript: transcriptFolderMatches,
} as const;

// MARK: - a pane's session

/** The agent kind a pane runs, as the transcript formats name them. */
/** The transcript format Chat reads for a pane Herdr says runs `agent` (its aliases too: `github-copilot` is Copilot), else null. */
export function agentFormat(agent: string | undefined): TranscriptFormat | null {
  // The one alias mapping (agent-names.ts readerKind), which
  // chatReads and the names read through too.
  const name = agent === undefined ? undefined : readerKind(agent);
  if (name === "claude") return "claude";
  if (name === "codex") return "codex";
  if (name === "grok") return "grok";
  // Herdr's kind `cursor` (Cursor's agent CLI; `agent` is Grok's, never Cursor's).
  if (name === "cursor") return "cursor";
  if (name === "pi" || name === "omp") return name; // Herdr's kinds `pi` and `omp`
  if (isOpenCodeFormat(name)) return name; // Herdr's kinds `opencode` and `kilo`
  // `gemini`, `qwen`, `agy` (Antigravity CLI).
  if (geminiFamilyFormatOfAgent(name) !== null) return geminiFamilyFormatOfAgent(name);
  if (name === "copilot") return "copilot"; // Herdr's kind (detect/mod.rs:137); `github-copilot` arrives as it (readerKind)
  if (name === "droid") return "droid";
  if (name === "kimi") return "kimi"; // Herdr's kind `kimi` (Kimi Code CLI)
  // Herdr's kind `maki`.
  if (name === "maki") return "maki";
  if (isHermesFormat(name) || isMastraFormat(name) || isClineFormat(name)) return name; // Herdr's kinds `hermes`, `mastracode`, `cline`
  if (kiroFormatOfAgent(name) !== null) return "kiro"; // Herdr's label `kiro` (detect/mod.rs:139)
  return null;
}

/**
 * What Chat follows for an agent pane: the session Herdr names (`agent_session`),
 * else the one its argv names (when the caller has an argv; for Grok, the argv's first), else, for Claude
 * only, the newest transcript in the project directory of the pane's folder
 * (checked against the pane's folders like any other). Codex has no folder
 * fallback (its rollouts are filed by date, not folder). Null when nothing safe
 * can be looked up.
 */
export function sessionForPane(
  pane: AgentPaneLike,
  options: { readonly foregroundCWD?: string; readonly argv?: readonly string[] } = {},
): ChatSession | null {
  const paneFolders = [pane.cwd, options.foregroundCWD].filter(
    (folder): folder is string => folder !== undefined && normalisedFolder(folder).length > 0,
  );
  const format = agentFormat(pane.agent);
  const fromArgv = (): ChatSession | null => {
    if (format === null || options.argv === undefined) return null;
    const named = sessionFromArgv(options.argv, format);
    const ref = named === null ? null : sessionRefFromAgentSession(named);
    return ref === null ? null : { ref, source: "argv", paneFolders };
  };
  // For Grok, the resume id in the foreground command first (an older session may
  // still be supplied), then Herdr's, then the folder; Claude and Codex keep Herdr's first.
  if (format !== null && followsFolder(format)) {
    const named = fromArgv();
    if (named !== null) return named;
  }
  if (pane.agentSession !== undefined) {
    const ref = sessionRefFromAgentSession(pane.agentSession);
    if (ref !== null) return { ref, source: `herdr:${ref.format}`, paneFolders };
    // For every kind but Claude's, Codex's, Grok's and Cursor's, a session Herdr reported that the reader rejects
    // is not followed, and nothing stands in for it (no argv, no folder's newest): only a pane Herdr names no
    // session for may use the folder rule.
    if (format !== null && !(["claude", "codex", "grok", "cursor"] as const).some((known) => known === format)) return null;
  }
  if (format === null) return null;
  const named = fromArgv();
  if (named !== null) return named;
  // A Grok pane that names no session follows its folder too (the newest session
  // Grok filed under it); two such panes in one folder are refused by the caller (grokFolderShared).
  if (format === "codex") return null;
  // Nor Antigravity's (its transcripts name no folder).
  if (format === "antigravity") return null;
  const folder = paneFolders.map(normalisedFolder).find(isUsableFolder);
  if (folder === undefined) return null;
  const ref = makeSessionRef(format, { kind: "folder", folder });
  return ref === null ? null : { ref, source: "folder", paneFolders };
}

/**
 * One string per distinct session: starting the same again is ignored.
 *
 * The session, not the pane's folders, as the iOS app keys it: a folder Herdr reports differently for the same
 * session (the agent's cwd, the foreground process's, the pane's) would make a new key and read the open Chat again
 * from scratch. The folders are checked once, when the transcript gives its own; a chat that failed that check
 * looks again when they change (ChatService.apply).
 */
export function chatSessionKey(session: ChatSession): string {
  const lookup = session.ref.lookup;
  const value = lookup.kind === "id" ? lookup.id : lookup.kind === "path" ? lookup.path : lookup.folder;
  const exclude = lookup.kind === "folder" && lookup.exclude !== undefined && lookup.exclude.length > 0 ? [lookup.exclude] : [];
  return JSON.stringify([session.ref.format, lookup.kind, value, session.source, ...exclude]);
}

// MARK: - two Grok panes in one folder

/** The note a Grok pane shows when another Grok pane naming no session is in its folder. */
export const grokAmbiguousNote = "Two Grok sessions are open in this folder, so Chat can't tell which is this pane's";
/** The same for two Cursor panes. */
export const cursorAmbiguousNote = "Two Cursor sessions are open in this folder, so Chat can't tell which is this pane's";
/** The same for two Maki panes. */
export const makiAmbiguousNote = "Two Maki sessions are open in this folder, so Chat can't tell which is this pane's";

/** The note for the pane's agent kind (Grok's by default). */
export const ambiguousNoteFor = (agent: string | null | undefined): string =>
  agent?.toLowerCase() === "kimi" ? kimiAmbiguousNote : // two Kimi panes say Kimi's note
  agent?.toLowerCase() === "cursor"
    ? cursorAmbiguousNote
    : // Maki's.
      agent?.toLowerCase() === "maki"
      ? makiAmbiguousNote
      : grokAmbiguousNote;

/** One agent pane on the same machine, for the rule below. */
export interface GrokPeerPane extends AgentPaneLike {
  readonly paneID: string;
  readonly foregroundCWD?: string;
}

/**
 * Whether `session` (a Grok pane's folder lookup) cannot be told from another Grok pane's: another
 * pane on the machine runs Grok, names no session Chat can look up, and is in the same folder.
 * Herdr reports no session for a Grok pane and no time its agent started, so Chat refuses rather
 * than show one pane the other's session.
 */
export function grokFolderShared(session: ChatSession, paneID: string, peers: readonly GrokPeerPane[]): boolean {
  if (!followsFolder(session.ref.format) || session.ref.lookup.kind !== "folder") return false;
  const folder = session.ref.lookup.folder;
  const kind = session.ref.format;
  return peers.some((peer) => {
    if (peer.paneID === paneID || peer.agent?.toLowerCase() !== kind) return false;
    const named = peer.agentSession === undefined ? null : sessionRefFromAgentSession(peer.agentSession);
    if (named !== null) return false;
    const peerFolder = [peer.cwd, peer.foregroundCWD].map((value) => (value === undefined ? "" : normalisedFolder(value))).find(isUsableFolder);
    return peerFolder === folder;
  });
}

/** The Grok session id a ref names: its id, or the folder an updates.jsonl path is filed in; null for a folder lookup or another path. */
export function grokSessionIDOf(ref: TranscriptSessionRef): string | null {
  if (ref.format === "kimi") return kimiSessionIDOf(ref.lookup);
  const lookup = ref.lookup;
  // A Maki session's id, or the one its log is named by.
  if (ref.format === "maki") return lookup.kind === "id" ? (isMakiSessionID(lookup.id) ? lookup.id : null) : lookup.kind === "path" ? makiSessionIDOfPath(lookup.path) : null;
  // A Cursor chat's id, or the chat folder its store.db is filed in.
  if (ref.format === "cursor") return lookup.kind === "id" ? (isGrokSessionID(lookup.id) ? lookup.id : null) : lookup.kind === "path" ? cursorChatIDOfStore(lookup.path) : null;
  // A Pi or omp session's id, or the one its file's name ends with.
  if (isPiFormat(ref.format)) return lookup.kind === "id" ? (isGrokSessionID(lookup.id) ? lookup.id : null) : lookup.kind === "path" ? piSessionIDOfPath(lookup.path) : null;
  // A Qwen session's id, or the id its transcript is named by.
  if (ref.format === "qwen") return qwenSessionIDOf(ref);
  if (ref.format === "copilot") return copilotSessionIDOf(lookup);
  if (ref.format === "droid") return droidSessionIDOf(lookup);
  if (ref.format !== "grok") return null;
  if (lookup.kind === "id") return isGrokSessionID(lookup.id) ? lookup.id : null;
  if (lookup.kind !== "path" || !lookup.path.endsWith("/updates.jsonl")) return null;
  const parts = lookup.path.split("/");
  const id = parts[parts.length - 2] ?? "";
  return isGrokSessionID(id) ? id : null;
}

/**
 * What a Grok pane that follows its folder follows, `peers` being the
 * machine's agent panes (Chat, Away and Changes share it). Refused ("ambiguous") when another Grok
 * pane naming no session is in the same folder, or a Grok peer names a session that cannot be told
 * (no id), or too many do; else the folder's newest session that no Grok peer names (their ids
 * excluded from the lookup). Any other session is returned as it is.
 */
export function grokPeerSession(session: ChatSession, paneID: string, peers: readonly GrokPeerPane[]): ChatSession | "ambiguous" {
  const lookup = session.ref.lookup;
  const kind = session.ref.format;
  if (!followsFolder(kind) || lookup.kind !== "folder") return session;
  if (grokFolderShared(session, paneID, peers)) return "ambiguous";
  const exclude = new Set<string>();
  for (const peer of peers) {
    if (peer.paneID === paneID || peer.agent?.toLowerCase() !== kind) continue;
    const named = peer.agentSession === undefined ? null : sessionRefFromAgentSession(peer.agentSession);
    if (named === null) continue;
    if (named.format !== kind) return "ambiguous";
    const id = grokSessionIDOf(named);
    if (id === null) return "ambiguous";
    exclude.add(id);
  }
  if (exclude.size === 0) return session;
  const ref = makeSessionRef(kind, { kind: "folder", folder: lookup.folder, exclude: [...exclude].sort() });
  return ref === null ? "ambiguous" : { ...session, ref };
}

/**
 * A Grok pane's folder lookup that also skips `ids` (sessions known to be its
 * earlier runs'), so a later run that names none waits for its own; refused ("ambiguous") when they do
 * not fit the lookup. A session that is not a Grok folder lookup (one named) is returned as it is.
 */
export function excludingGrokSessions(session: ChatSession, ids: readonly string[]): ChatSession | "ambiguous" {
  const lookup = session.ref.lookup;
  if (!followsFolder(session.ref.format) || lookup.kind !== "folder" || ids.length === 0) return session;
  const exclude = [...new Set([...(lookup.exclude ?? []), ...ids])].sort();
  const ref = makeSessionRef(session.ref.format, { kind: "folder", folder: lookup.folder, exclude });
  return ref === null ? "ambiguous" : { ...session, ref };
}

// MARK: - one machine's panes

/** A pane of a machine's snapshot (wire TopologyPaneInfo), the parts the session rule reads. */
export interface MachinePane {
  readonly paneID: string;
  readonly agent?: string;
  readonly cwd?: string;
  readonly foregroundCWD?: string;
}

/** An agent of a machine's snapshot (wire AgentInfo), the parts the session rule reads. */
export interface MachineAgent extends AgentPaneLike {
  readonly paneID: string;
  /** A herdr-core pane's session found by folder (core-pane-session.ts). */
  readonly coreFound?: CoreFoundSessionLike;
}

/** A machine's agents and panes, from its last snapshot. */
export interface MachinePanes {
  readonly agents: readonly MachineAgent[];
  readonly panes: readonly MachinePane[];
}

/**
 * The session Chat, Away and Changes follow for a pane of `machine`, one
 * rule for the three: sessionForPane, then for a Grok pane that follows its folder its peers'
 * (grokPeerSession): "ambiguous" when it cannot be told, null when there is none.
 */
export function paneSession(machine: MachinePanes, paneID: string): ChatSession | "ambiguous" | null {
  const paneOf = (id: string): MachinePane | undefined => machine.panes.find((candidate) => candidate.paneID === id);
  const pane = paneOf(paneID);
  const agent = machine.agents.find((candidate) => candidate.paneID === paneID);
  if (pane === undefined && agent === undefined) return null;
  // A herdr-core Claude or Codex pane of this machine whose argv names no session: the
  // one its finder proved, as the latest snapshot allows it, else the refusal or none (never the folder guess below).
  const core = coreChatSession(paneID, machine.agents, machine.panes);
  if (core === null || core === "ambiguous") return core;
  if (core !== undefined) return sessionForPane({ agent: agent?.agent ?? pane?.agent, agentSession: core, cwd: agent?.cwd ?? pane?.cwd }, { foregroundCWD: pane?.foregroundCWD });
  const session = sessionForPane(
    { agent: agent?.agent ?? pane?.agent, agentSession: agent?.agentSession, cwd: agent?.cwd ?? pane?.cwd },
    { foregroundCWD: pane?.foregroundCWD },
  );
  if (session === null) return null;
  // A pane on a machine the core added has no folder rule here (it would read this host's transcripts as that
  // machine's): none, until reads go to its own machine.
  if (session.source === "folder" && isForeignCorePane(paneID)) return null;
  const peers = machine.agents.map((peer): GrokPeerPane => {
    const peerPane = paneOf(peer.paneID);
    return { paneID: peer.paneID, agent: peer.agent ?? peerPane?.agent, agentSession: peer.agentSession, cwd: peer.cwd ?? peerPane?.cwd, foregroundCWD: peerPane?.foregroundCWD };
  });
  if (isOpenCodeFormat(session.ref.format)) return openCodePeerSession(session, paneID, peers);
  if (isClineFormat(session.ref.format)) return clinePeerSession(session, paneID, peers);
  return grokPeerSession(session, paneID, peers);
}

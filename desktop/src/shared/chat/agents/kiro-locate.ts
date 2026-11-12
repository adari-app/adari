// Chat for Kiro CLI's V3 sessions: where they are, which one is a pane's, and the folder each one
// records. Kiro CLI is closed source; its docs give no file layout. Two public readers do:
// - kiro-cli-history (mxmehl/kiro-cli-history f96f9f05, kiro_cli_history/main.py): four stores (:1-13); the V3
//   ("CLI 3.0, current") store `~/.kiro/sessions/<workspace-hash>/sess_*/` with `session.json` + `messages.jsonl`
//   (:5-6, :364-375); a session's folder is session.json's `workspacePaths[0]` (:332-361); it resumes a session from
//   that folder, `kiro-cli chat --resume-id <id>` (:822-842).
// - codeburn (getagentseal/codeburn bb952552, src/providers/kiro.ts): the same store, which it calls "Kiro IDE v2"
//   (:686-700); every `<hash>` folder but `cli`, each `sess_*` folder holding a messages.jsonl (:1100-1145); the
//   project from `workspacePaths[0]` (:795-796, :1130-1136); session.json's `schemaVersion: '1.0.0'` and
//   `dataModelVersion: 1` (tests/providers/kiro.test.ts:1118-1137).
// Herdr (herdrdev/herdr ee5bfb5) labels the agent `kiro` (src/detect/mod.rs:139; `kiro-cli` is its executable,
// :174, and a label it parses, :214) and reports no Kiro session (src/agent_resume.rs names none).
//
// So a Kiro pane follows its folder by Grok's rules (locator.ts folderFormats): the newest V3 session whose
// session.json names the pane's folder, two unnamed Kiro panes in one folder refused (Kiro's note). The hash
// folder's name is never trusted (its hash is not known): the command keeps only sessions whose session.json
// holds the folder as a JSON string, and the feed reads that session.json before anything shows and follows the
// session only when its `workspacePaths[0]` is the folder (feed.ts grokSessionFolder, locator.ts grokSessionOwned);
// none, or another folder, is no session. A session.json of a data model this reader does not know is refused whole.
// The 2.x stores (`~/.kiro/sessions/cli/`, the SQLite data.sqlite3; main.py:7-9) are not read: a pane whose
// sessions are only there finds none.

import type { TranscriptLookup, TranscriptSessionRef } from "../locator";

/** The format this file reads. */
export type KiroFormat = "kiro";
export const isKiroFormat = (format: string): format is KiroFormat => format === "kiro";

/** The format of a pane Herdr says runs `agent` (its label, `kiro`), or null for another agent. */
export function kiroFormatOfAgent(agent: string | undefined): KiroFormat | null {
  return agent?.toLowerCase() === "kiro" ? "kiro" : null;
}

/** The reason two Kiro panes in one folder give, or null for another agent. */
export type KiroAmbiguousReason = "ambiguousKiroSession";
export function kiroAmbiguousReason(agent: string | undefined): KiroAmbiguousReason | null {
  return kiroFormatOfAgent(agent) === null ? null : "ambiguousKiroSession";
}
export const kiroAmbiguousNote = "Two Kiro sessions are open in this folder, so Chat can't tell which is this pane's";

const maxPathBytes = 4_096;
const home = '"$HOME"';

/** POSIX single-quote escaping (locator.ts shellQuote, the transport's own rule). */
const quote = (value: string): string => "'" + value.split("'").join("'\"'\"'") + "'";

const hasControl = (value: string): boolean => [...value].some((character) => character.codePointAt(0)! < 0x20 || character.codePointAt(0) === 0x7f);

/** An absolute folder (trailing slash dropped) of at most 4,096 bytes with no control characters, else null. */
function usableFolder(value: string): string | null {
  let folder = value;
  while (folder.length > 1 && folder.endsWith("/")) folder = folder.slice(0, -1);
  if (!folder.startsWith("/") || new TextEncoder().encode(folder).length > maxPathBytes || hasControl(folder)) return null;
  return folder;
}

/** A Kiro ref: a folder lookup only (Herdr names no Kiro session; peers name none to skip), else null. */
export function kiroSessionRef(lookup: TranscriptLookup): TranscriptSessionRef | null {
  if (lookup.kind !== "folder" || (lookup.exclude?.length ?? 0) > 0 || usableFolder(lookup.folder) === null) return null;
  return { format: "kiro", lookup };
}

/**
 * The folder as a JSON string, each way a writer may give it: escaped `\` and `"`, with and without a trailing
 * slash, and (for a folder that is not ASCII) with `\uXXXX` escapes. A filter only: the feed reads the session.json.
 */
export function kiroFolderStrings(folder: string): string[] {
  const escaped = folder.split("\\").join("\\\\").split('"').join('\\"');
  const strings = [`"${escaped}"`, `"${escaped}/"`];
  const ascii = escaped.replace(/[\u0080-￿]/g, (character) => "\\u" + character.charCodeAt(0).toString(16).padStart(4, "0"));
  if (ascii !== escaped) strings.push(`"${ascii}"`, `"${ascii}/"`);
  return strings;
}

/**
 * The one `/bin/sh` command that prints the newest V3 messages.jsonl whose session.json holds the folder, or
 * nothing; always exits 0. Null for anything but a usable folder lookup with nothing to skip.
 */
export function kiroLocateCommand(ref: TranscriptSessionRef): string | null {
  const lookup = ref.lookup;
  if (ref.format !== "kiro" || lookup.kind !== "folder" || (lookup.exclude?.length ?? 0) > 0) return null;
  const folder = usableFolder(lookup.folder);
  if (folder === null) return null;
  const sessions = home + "/" + quote(".kiro") + "/" + quote("sessions");
  const patterns = kiroFolderStrings(folder)
    .map((text) => "-e " + quote(text))
    .join(" ");
  const script =
    "set --; for s in " +
    sessions +
    "/*/" +
    quote("sess_") +
    "*/" +
    quote("session.json") +
    '; do case "$s" in */' +
    quote(".kiro") +
    "/" +
    quote("sessions") +
    "/" +
    quote("cli") +
    '/*) continue;; esac; m="${s%/*}/messages.jsonl"; [ -f "$s" ] && [ -f "$m" ] && /usr/bin/grep -qsF ' +
    patterns +
    ' -- "$s" && set -- "$@" "$m"; done; ' +
    '[ "$#" -gt 0 ] && /bin/ls -t -- "$@" | /usr/bin/head -n 1; exit 0';
  return "/bin/sh -c " + quote(script);
}

/** `<home>/.kiro/sessions/<hash>/sess_<id>/messages.jsonl`, `<hash>` not `cli`, a usable path. */
export function isKiroMessagesPath(path: string): boolean {
  if (!path.startsWith("/") || new TextEncoder().encode(path).length > maxPathBytes || hasControl(path)) return false;
  const parts = path.split("/").filter((part) => part.length > 0);
  const at = (back: number): string => parts[parts.length - back] ?? "";
  return parts.length >= 5 && at(1) === "messages.jsonl" && /^sess_.+$/.test(at(2)) && at(3).length > 0 && at(3) !== "cli" && at(4) === "sessions" && at(5) === ".kiro";
}

/** The path the command printed, when it is a V3 messages.jsonl; else null. */
export function kiroParseLocateOutput(output: string, ref: TranscriptSessionRef): string | null {
  if (ref.format !== "kiro" || ref.lookup.kind !== "folder") return null;
  const line = output
    .split(/[\n\r]/)
    .map((part) => part.replace(/^[ \t]+|[ \t]+$/g, ""))
    .find((part) => part.length > 0);
  return line !== undefined && isKiroMessagesPath(line) ? line : null;
}

/** The session.json beside a V3 messages.jsonl, or null for another path. */
export function kiroSessionJSONPath(transcript: string): string | null {
  return isKiroMessagesPath(transcript) ? transcript.slice(0, -"messages.jsonl".length) + "session.json" : null;
}

/** A session.json is a few hundred bytes (kiro-cli-history's demo, codeburn's fixture); one this long or longer is not read. */
export const maxKiroSessionBytes = 64 * 1_024;

/** A session.json of a data model this reader does not know: the session is refused whole (unrecognised). */
export class KiroSessionFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KiroSessionFormatError";
  }
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The folder a Kiro V3 session records: its session.json's `workspacePaths[0]`, read as JSON (a folder named
 * anywhere else is not it), trailing slash ignored. Null when the file is not JSON, too long, or names no usable
 * folder there. Throws KiroSessionFormatError for a `dataModelVersion` other than 1 or a `schemaVersion` other
 * than 1.x (codeburn's fixture; neither reader checks them, so a newer one is refused rather than guessed).
 */
export function kiroSessionFolder(bytes: Uint8Array): string | null {
  if (bytes.length === 0 || bytes.length >= maxKiroSessionBytes) return null;
  let session: unknown;
  try {
    session = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
  if (!isObject(session)) return null;
  const model = session.dataModelVersion;
  if (model !== undefined && model !== 1) throw new KiroSessionFormatError(`dataModelVersion ${String(model)}`);
  const schema = session.schemaVersion;
  if (schema !== undefined && (typeof schema !== "string" || !/^1(\.|$)/.test(schema))) throw new KiroSessionFormatError(`schemaVersion ${String(schema)}`);
  const paths = session.workspacePaths;
  if (!Array.isArray(paths) || typeof paths[0] !== "string") return null;
  return usableFolder(paths[0]);
}

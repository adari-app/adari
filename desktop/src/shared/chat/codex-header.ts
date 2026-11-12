// A Codex session Herdr names for a pane is checked against
// the session's own header before anything of it shows. Codex 0.167 runs its
// sessions through one shared background server whose hooks carry the first
// pane's HERDR_PANE_ID, so Herdr can name another pane's session (another
// folder's) for this one. The header is the rollout's first line, a
// `session_meta` record whose payload has the session's `id` and `cwd`.
//
// It is read with the feed's own bounds: the head first (headerBytes' 64 KiB,
// enough for most), then on in the follower's poll window (1 MiB) while the
// line has not ended, never past one line's limit (maxLineBytes, 8 MiB).

import { maxLineBytes, pollWindow } from "./follower";
import { normalisedFolder, transcriptFolderMatches } from "./locator";

/** Chat's line for a Codex session another folder's by its header (`folder`, the header's cwd). */
export const codexOtherFolderText = (folder: string): string =>
  `Herdr names a Codex session from another folder (${folder}) for this agent, so it is not shown. Restart Codex from Adari to give it its own.`;

/**
 * What Chat adds, for Codex only, when Herdr names no session for the pane: the first step first
 * (Codex tells Herdr its session only with its first message), the shared-server case second, so a --no-daemon Codex
 * not yet messaged is not sent to a Restart that has no session to resume.
 */
export const codexNoSessionText =
  "Codex tells Herdr its session with its first message: send one and Chat shows the conversation. If Chat is still empty after Codex replies, this Codex was started without --no-daemon and reports to another pane: use Restart in the pane's More menu.";

/** The flag Chat keeps on one line wherever its lines name it. */
export const codexNoDaemonFlag = "--no-daemon";

/** The first read of the head (headerBytes' bound for every format but Kimi's). */
export const codexHeaderFirstBytes = 64 * 1_024;

/** What the rollout's first line says. */
export type CodexHeader =
  /** A `session_meta` line: its id and folder (either null when absent or not text). */
  | { readonly kind: "header"; readonly id: string | null; readonly cwd: string | null }
  /** The file has no complete first line yet (empty, or still being written, within the line's limit). */
  | { readonly kind: "pending" }
  /** The first line is not a `session_meta` record (not JSON, another type, or longer than a line may be). */
  | { readonly kind: "none" };

const decoder = new TextDecoder("utf-8", { fatal: true });

/** The header in `line` (one whole line, without its newline). */
export function codexHeaderOfLine(line: Uint8Array): CodexHeader {
  let record: unknown;
  try {
    record = JSON.parse(decoder.decode(line));
  } catch {
    return { kind: "none" };
  }
  if (typeof record !== "object" || record === null || Array.isArray(record)) return { kind: "none" };
  const fields = record as Record<string, unknown>;
  if (fields["type"] !== "session_meta") return { kind: "none" };
  const payload = fields["payload"];
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return { kind: "header", id: null, cwd: null };
  const meta = payload as Record<string, unknown>;
  const text = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);
  return { kind: "header", id: text(meta["id"]), cwd: text(meta["cwd"]) };
}

/**
 * The rollout's header, read from its start: `read(offset, maxBytes)` gives the bytes there (fewer at the file's
 * end). A read that fails throws (the caller says the file could not be read).
 */
export async function readCodexHeader(read: (offset: number, maxBytes: number) => Promise<Uint8Array>): Promise<CodexHeader> {
  const parts: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const want = Math.min(length === 0 ? codexHeaderFirstBytes : pollWindow, maxLineBytes - length);
    const bytes = await read(length, want);
    const newline = bytes.indexOf(0x0a);
    if (newline >= 0) {
      parts.push(bytes.subarray(0, newline));
      return codexHeaderOfLine(concat(parts, length + newline));
    }
    parts.push(bytes);
    length += bytes.length;
    // The file's end before a newline: the line is still being written (or the file is empty).
    if (bytes.length < want) return { kind: "pending" };
    // A first line longer than any line may be is no header Chat reads.
    if (length >= maxLineBytes) return { kind: "none" };
  }
}

function concat(parts: readonly Uint8Array[], length: number): Uint8Array {
  if (parts.length === 1) return parts[0]!;
  const out = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** What the header says of the pane: its own, another folder's (that folder), or not known to be its own. */
export type CodexHeaderVerdict =
  | { readonly kind: "own" }
  | { readonly kind: "otherFolder"; readonly folder: string }
  | { readonly kind: "otherSession" }
  | { readonly kind: "unproven" };

/**
 * Whether the session whose header is `header` is the pane's: its `id`, when the session was looked up by id, is that
 * id (case ignored), and its `cwd` is one of the pane's folders (Herdr's pane cwd, and the agent's own when known) by
 * Chat's folder rule (ChatFolderMatch: normalised, a trailing slash ignored, a folder inside the other either way
 * round, as the feed checks a transcript). A header naming another id is another session's with or without a
 * pane folder. Without a pane folder there is no folder to compare: own, when no id says otherwise. A header
 * without a folder, or no header, is unproven: not shown.
 */
export function codexHeaderVerdict(header: CodexHeader, paneFolders: readonly string[], sessionID: string | null): CodexHeaderVerdict {
  if (sessionID !== null && header.kind === "header" && header.id !== null && header.id.toLowerCase() !== sessionID.toLowerCase()) return { kind: "otherSession" };
  const folders = paneFolders.filter((folder) => normalisedFolder(folder).length > 0);
  if (folders.length === 0) return { kind: "own" };
  if (header.kind !== "header" || header.cwd === null) return { kind: "unproven" };
  return transcriptFolderMatches(header.cwd, folders) ? { kind: "own" } : { kind: "otherFolder", folder: normalisedFolder(header.cwd) };
}

/** Whether two reads of a rollout's head say the same (the same kind, id and folder). */
export function sameCodexHeader(a: CodexHeader, b: CodexHeader): boolean {
  if (a.kind !== "header" || b.kind !== "header") return a.kind === b.kind;
  return a.id === b.id && a.cwd === b.cwd;
}

// Where Cline keeps a pane's session, and how Chat finds it.
//
// Cline's CLI keeps each session in its own folder under `${CLINE_SESSION_DATA_DIR:-<data dir>/sessions}`, the
// data dir being `${CLINE_DATA_DIR:-${CLINE_DIR:-~/.cline}/data}` (cline sdk/packages/shared/src/storage/
// paths.ts:158-200): `<sessions>/<id>/<id>.messages.json`, the conversation, and `<sessions>/<id>/<id>.json`,
// the manifest naming the session's `cwd` (sdk/packages/core/src/runtime/host/local-runtime-host.ts:594-625;
// fixtures/session/session.json). A session id is `<Date.now()>_<nanoid(5)>` unless one was asked for
// (sdk/packages/core/src/session/services/persistence-service.ts:109). The manifest is written by
// `JSON.stringify(manifest, null, 2)` (session/stores/session-manifest-store.ts:112-119), so it holds the line
// `"cwd": <the folder as JSON>`.
//
// Herdr reports no Cline session (no `herdr:cline` in Herdr src/agent_resume.rs:328-349; Cline is a kind only,
// detect/mod.rs:133, :208), so a Cline pane binds by its folder only: the newest session (its messages file's
// modification time) whose manifest names exactly the pane's folder, refused when another Cline pane is in the
// same folder (the Grok and Cursor rule: Chat cannot tell whose it is). The document's own folder is checked
// against the pane's again before anything shows (agents/cline-store.ts).
//
// This file imports nothing but types from locator.ts (locator.ts registers these functions).

import type { ChatSession, GrokPeerPane, TranscriptLookup, TranscriptSessionRef } from "../locator";

export type ClineFormat = "cline";

export const isClineFormat = (value: string | null | undefined): value is ClineFormat => value === "cline";

/** Letters, digits, `_`, `-` and `.`: `<ms>_<nanoid>`, or a name of those. */
export function isClineSessionID(value: string): boolean {
  return /^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$/.test(value);
}

const maxPathBytes = 4_096;

const hasControl = (value: string): boolean => {
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
};

/** A messages file's parts. */
export interface ClineMessagesPath {
  readonly path: string;
  readonly session: string;
  /** The manifest beside it, `<id>.json`. */
  readonly manifest: string;
}

/** `…/sessions/<id>/<id>.messages.json`: absolute, no control characters, no `.` or `..`; null for any other path. */
export function parseClineMessagesPath(path: string): ClineMessagesPath | null {
  if (!path.startsWith("/") || new TextEncoder().encode(path).length > maxPathBytes || hasControl(path)) return null;
  const parts = path.split("/");
  const n = parts.length;
  if (n < 4 || parts.some((part) => part === "." || part === "..")) return null;
  const session = parts[n - 2]!;
  if (parts[n - 3] !== "sessions" || !isClineSessionID(session) || parts[n - 1] !== `${session}.messages.json`) return null;
  return { path, session, manifest: parts.slice(0, -1).join("/") + `/${session}.json` };
}

export const isClineMessagesPath = (path: string): boolean => parseClineMessagesPath(path) !== null;

const trimmedFolder = (folder: string): string => {
  let trimmed = folder;
  while (trimmed.length > 1 && trimmed.endsWith("/")) trimmed = trimmed.slice(0, -1);
  return trimmed;
};

/** makeSessionRef for Cline: a folder (absolute, no control characters, no exclusions: no peer ever names one), or a messages path. */
export function clineSessionRef(lookup: TranscriptLookup): TranscriptSessionRef | null {
  switch (lookup.kind) {
    case "folder":
      if (!lookup.folder.startsWith("/") || new TextEncoder().encode(lookup.folder).length > maxPathBytes || hasControl(lookup.folder)) return null;
      if (lookup.exclude !== undefined && lookup.exclude.length > 0) return null;
      return { format: "cline", lookup };
    case "path":
      return isClineMessagesPath(lookup.path) ? { format: "cline", lookup } : null;
    case "id":
      return null;
  }
}

// MARK: - finding the session (one /bin/sh command, read only)

const quote = (value: string): string => "'" + value.split("'").join("'\"'\"'") + "'";

/** The manifest line naming `folder` as Cline writes it (`JSON.stringify(manifest, null, 2)`). */
export const clineManifestNeedle = (folder: string): string => `"cwd": ${JSON.stringify(trimmedFolder(folder))}`;

/**
 * One `/bin/sh` command that prints the newest Cline session's messages file whose manifest names exactly
 * `folder`, or nothing; always exits 0. It lists `~/.cline/data/sessions/<id>/<id>.json` (each a regular file
 * with its `<id>.messages.json` beside it), keeps those holding the `"cwd": "<folder>"` line (a fixed-string
 * grep), and prints the newest messages file by modification time. Null for anything but a folder lookup.
 */
export function clineLocateCommand(ref: TranscriptSessionRef): string | null {
  if (!isClineFormat(ref.format)) return null;
  const checked = clineSessionRef(ref.lookup);
  if (checked === null || checked.lookup.kind !== "folder") return null;
  const script =
    'D="$HOME"/' +
    quote(".cline") +
    "/" +
    quote("data") +
    "/" +
    quote("sessions") +
    '; [ -d "$D" ] || exit 0; set --; for m in "$D"/*/*.json; do case "$m" in *.messages.json) continue;; esac; ' +
    'n=${m##*/}; s=${n%.json}; [ "$m" = "$D/$s/$s.json" ] || continue; f="$D/$s/$s.messages.json"; [ -f "$m" ] && [ -f "$f" ] || continue; ' +
    "/usr/bin/grep -q -F -e " +
    quote(clineManifestNeedle(checked.lookup.folder)) +
    ' -- "$m" 2>/dev/null || continue; set -- "$@" "$f"; done; ' +
    '[ "$#" -gt 0 ] && /bin/ls -t -- "$@" | /usr/bin/head -n 1; exit 0';
  return "/bin/sh -c " + quote(script);
}

/** The messages file the command printed, when it is one. */
export function parseClineLocateOutput(output: string, ref: TranscriptSessionRef): string | null {
  if (ref.lookup.kind !== "folder" || !isClineFormat(ref.format)) return null;
  const line = output
    .split(/[\n\r]/)
    .map((part) => part.replace(/^[ \t]+|[ \t]+$/g, ""))
    .find((part) => part.length > 0);
  return line !== undefined && isClineMessagesPath(line) ? line : null;
}

// MARK: - two panes in one folder (the Grok and Cursor rule)

/** The note a Cline pane shows when another Cline pane is in its folder (ChatView's texts). */
export const clineAmbiguousNote = "Two Cline sessions are open in this folder, so Chat can't tell which is this pane's";

/** ChatView's reason for the pane's agent kind; null for another kind. */
export const clineAmbiguousReason = (agent: string | null | undefined): "ambiguousClineSession" | null => (agent?.toLowerCase() === "cline" ? "ambiguousClineSession" : null);

const peerFolder = (peer: GrokPeerPane): string | undefined =>
  [peer.cwd, peer.foregroundCWD].map((value) => (value === undefined ? "" : trimmedFolder(value))).find((value) => value.startsWith("/") && !hasControl(value));

/**
 * What a Cline pane that follows its folder follows, `peers` the machine's agent panes: refused ("ambiguous")
 * when another Cline pane is in the same folder (Herdr names no Cline session, so neither can be told from the
 * other); else the session as it is.
 */
export function clinePeerSession(session: ChatSession, paneID: string, peers: readonly GrokPeerPane[]): ChatSession | "ambiguous" {
  const lookup = session.ref.lookup;
  if (!isClineFormat(session.ref.format) || lookup.kind !== "folder") return session;
  const folder = trimmedFolder(lookup.folder);
  const shared = peers.some((peer) => peer.paneID !== paneID && peer.agent?.toLowerCase() === "cline" && peerFolder(peer) === folder);
  return shared ? "ambiguous" : session;
}

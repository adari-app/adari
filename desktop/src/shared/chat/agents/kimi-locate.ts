// Which Kimi Code CLI session a pane runs, and the one remote command that finds its wire.
//
// Herdr reports `herdr:kimi` with the session's id (src/agent_resume.rs:117-133, 216-218; its hook sends
// Kimi's SessionStart `session_id`, src/integration/assets/kimi/herdr-agent-state.sh:30-50), which is Kimi's
// own `session_<uuid>` (kimi-code packages/agent-core-v2/src/workspace/sessionLifecycle/sessionLifecycleService.ts:1067,
// its hook payload's camelCase turned snake_case, features/externalHooks/internal/matchHooks.ts:150) or a
// session `kimi migrate` brought over from the old CLI, `ses_<uuid>` (packages/migration-legacy/src/sessions/migrate-one.ts:152).
// Its main agent's wire is `~/.kimi-code/sessions/<workspace>/<id>/agents/main/wire.jsonl`
// (docs/en/configuration/data-locations.md:73-83; workspace/sessionLifecycle/internal/addressing.ts:3-17).
// A working folder's own workspace is `wd_<slug>_<first 12 hex of sha256(folder)>`
// (src/_base/utils/workdir-slug.ts:1-23), so with no session named, the pane's folder finds its newest.
// Pure functions, no imports from locator.ts (it imports these): the command is tested as text.

import { onlyOneFile } from "./only-one";

/** Kimi's session ids: `session_` (or a migrated session's `ses_`) and a UUID. */
export function isKimiSessionID(value: string): boolean {
  return /^(?:session|ses)_[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/.test(value);
}

const hasControl = (value: string): boolean => {
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
};

const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);

/** An absolute folder of at most 4,096 bytes with no control characters (locator's isUsableFolder). */
const usableFolder = (value: string): boolean => value.startsWith("/") && utf8(value).length <= 4_096 && !hasControl(value);

/** A trailing slash is not the folder's. */
const trimmedFolder = (folder: string): string => {
  let trimmed = folder;
  while (trimmed.length > 1 && trimmed.endsWith("/")) trimmed = trimmed.slice(0, -1);
  return trimmed;
};

/** POSIX single-quote escaping (locator's shellQuote). */
const quote = (value: string): string => "'" + value.split("'").join("'\"'\"'") + "'";

/** locator's maxExcluded: at most this many peers' sessions are skipped; more is refused. */
const maxExcludedSessions = 64;

// MARK: - sha256 (Kimi's workspace key)

const k256 = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

/** The sha256 of `bytes`, 64 lower-case hex characters. */
export function sha256Hex(bytes: Uint8Array): string {
  const length = bytes.length;
  const padded = new Uint8Array((((length + 8) >> 6) + 1) << 6);
  padded.set(bytes);
  padded[length] = 0x80;
  const view = new DataView(padded.buffer);
  const bits = length * 8;
  view.setUint32(padded.length - 8, Math.floor(bits / 2 ** 32), false);
  view.setUint32(padded.length - 4, bits >>> 0, false);
  const hash = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));
  for (let chunk = 0; chunk < padded.length; chunk += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(chunk + i * 4, false);
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash as [number, number, number, number, number, number, number, number];
    for (let i = 0; i < 64; i += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const choice = (e & f) ^ (~e & g);
      const t1 = (h + s1 + choice + k256[i]! + w[i]!) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    hash[0] = (hash[0]! + a) >>> 0;
    hash[1] = (hash[1]! + b) >>> 0;
    hash[2] = (hash[2]! + c) >>> 0;
    hash[3] = (hash[3]! + d) >>> 0;
    hash[4] = (hash[4]! + e) >>> 0;
    hash[5] = (hash[5]! + f) >>> 0;
    hash[6] = (hash[6]! + g) >>> 0;
    hash[7] = (hash[7]! + h) >>> 0;
  }
  return hash.map((word) => word.toString(16).padStart(8, "0")).join("");
}

/**
 * The workspace Kimi files a working folder's sessions in (its encodeWorkDirKey): `wd_`, the folder's last
 * name lower-cased with every run of other characters than a–z, 0–9, `.`, `_`, `-` as one `-`, dashes
 * trimmed, at most 40 characters (`workspace` when nothing, `.` or `..` is left), `_`, and the first 12 hex
 * characters of the sha256 of the folder (its UTF-8, trailing slashes dropped).
 */
export function kimiWorkspaceKey(folder: string): string {
  const normalized = folder.replace(/\/+$/, "");
  const base = normalized.split("/").pop() ?? normalized;
  let slug = base
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/^-+|-+$/g, "");
  if (slug === "" || slug === "." || slug === "..") slug = "workspace";
  return `wd_${slug}_${sha256Hex(utf8(normalized)).slice(0, 12)}`;
}

/** A workspace folder name Kimi makes: `wd_<slug>_<12 hex>` (or a project's `wm_<uuid>`). */
const isWorkspaceName = (name: string): boolean =>
  /^wd_[a-z0-9._-]{1,40}_[0-9a-f]{12}$/.test(name) || /^wm_[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/.test(name);

// MARK: - lookups

/** How a Kimi session is looked up (locator's TranscriptLookup, structurally). */
export type KimiLookup =
  | { readonly kind: "id"; readonly id: string }
  | { readonly kind: "path"; readonly path: string }
  | { readonly kind: "folder"; readonly folder: string; readonly exclude?: readonly string[] };

/**
 * A main agent's wire path: absolute, at most 4,096 bytes, no control characters, no `.` or `..` part,
 * ending `/.kimi-code/sessions/<workspace>/<session id>/agents/main/wire.jsonl`.
 */
export function isKimiWirePath(path: string): boolean {
  if (!path.startsWith("/") || utf8(path).length > 4_096 || hasControl(path)) return false;
  const parts = path.split("/");
  const n = parts.length;
  if (n < 8 || parts.slice(1).some((part) => part === "" || part === "." || part === "..")) return false;
  return (
    parts[n - 1] === "wire.jsonl" &&
    parts[n - 2] === "main" &&
    parts[n - 3] === "agents" &&
    isKimiSessionID(parts[n - 4]!) &&
    isWorkspaceName(parts[n - 5]!) &&
    parts[n - 6] === "sessions" &&
    parts[n - 7] === ".kimi-code"
  );
}

/** The session id a wire path is filed under; null for another path. */
export function kimiSessionIDOfPath(path: string): string | null {
  return isKimiWirePath(path) ? path.split("/").at(-4)! : null;
}

/** Whether a lookup is safe to use: a Kimi id, a wire path, or a usable folder whose skipped ids are Kimi ids (at most 64). */
export function kimiLookupValid(lookup: KimiLookup): boolean {
  switch (lookup.kind) {
    case "id":
      return isKimiSessionID(lookup.id);
    case "path":
      return isKimiWirePath(lookup.path);
    case "folder":
      if (!usableFolder(lookup.folder)) return false;
      return lookup.exclude === undefined || (lookup.exclude.length <= maxExcludedSessions && lookup.exclude.every(isKimiSessionID));
  }
}

/** The Kimi session id a lookup names: its id, or the one its wire path is filed under; null for a folder lookup. */
export function kimiSessionIDOf(lookup: KimiLookup): string | null {
  if (lookup.kind === "id") return isKimiSessionID(lookup.id) ? lookup.id : null;
  return lookup.kind === "path" ? kimiSessionIDOfPath(lookup.path) : null;
}

/** Whether `path` is the wire of a session a folder lookup skips (a peer's, an earlier run's). */
export function kimiLookupExcludes(lookup: KimiLookup, path: string): boolean {
  if (lookup.kind !== "folder" || lookup.exclude === undefined) return false;
  const id = kimiSessionIDOfPath(path);
  return id !== null && lookup.exclude.includes(id);
}

/** `kimi -S <id>`, `--session <id>`, `--session=<id>` (and the hidden `-r`/`--resume`); null when no Kimi id is named. */
export function kimiSessionFromArgv(argv: readonly string[]): string | null {
  let id: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const word = argv[index]!;
    if (["-S", "--session", "-r", "--resume"].includes(word) && index + 1 < argv.length) id = argv[index + 1]!;
    else if (word.startsWith("--session=") || word.startsWith("--resume=")) id = word.slice(word.indexOf("=") + 1);
  }
  return id !== null && isKimiSessionID(id) ? id : null;
}

/** The session an argv names, as Herdr would report it (locator's AgentSessionLike); null when none. */
export function kimiArgvSession(argv: readonly string[]): { source: string; agent: string; kind: string; value: string } | null {
  const id = kimiSessionFromArgv(argv);
  return id === null ? null : { source: "herdr:kimi", agent: "kimi", kind: "id", value: id };
}

const home = '"$HOME"';
const sessionsRoot = home + "/" + quote(".kimi-code") + "/" + quote("sessions");
const mainWire = quote("agents") + "/" + quote("main") + "/" + quote("wire.jsonl");

/**
 * One `/bin/sh` command (so zsh's no-match error never applies) printing the newest main wire the lookup
 * names, or nothing; always exits 0. By id: `~/.kimi-code/sessions/*\/<id>/agents/main/wire.jsonl`. By
 * folder: the folder's workspace's sessions, peers' and earlier runs' skipped. Null for a path lookup or one
 * that is not valid.
 */
export function kimiLocateCommand(lookup: KimiLookup): string | null {
  if (!kimiLookupValid(lookup) || lookup.kind === "path") return null;
  const glob =
    lookup.kind === "id"
      ? sessionsRoot + "/*/" + quote(lookup.id) + "/" + mainWire
      : sessionsRoot + "/" + quote(kimiWorkspaceKey(trimmedFolder(lookup.folder))) + "/*/" + mainWire;
  const exclude = lookup.kind === "folder" ? (lookup.exclude ?? []) : [];
  const skip = exclude.length === 0 ? "" : ' case "$f" in ' + exclude.map((id) => "*/" + quote(id) + "/*").join("|") + ") continue;; esac;";
  // An id's wire is the one file the id names (two workspaces holding it: neither, never the newer); a folder's
  // is its newest.
  const pick = lookup.kind === "id" ? onlyOneFile : '[ "$#" -gt 0 ] && /bin/ls -t -- "$@" | /usr/bin/head -n 1; exit 0';
  const script = "set --; for f in " + glob + "; do" + skip + ' [ -f "$f" ] && set -- "$@" "$f"; done; ' + pick;
  return "/bin/sh -c " + quote(script);
}

/** The wire path the command printed, when it is the one asked for (the id's, or one in the folder's workspace that is not skipped). */
export function kimiParseLocateOutput(output: string, lookup: KimiLookup): string | null {
  if (lookup.kind === "path") return null;
  const line = output
    .split(/[\n\r]/)
    .map((part) => part.replace(/^[ \t]+|[ \t]+$/g, ""))
    .find((part) => part.length > 0);
  if (line === undefined || !isKimiWirePath(line)) return null;
  const parts = line.split("/");
  const session = parts.at(-4)!;
  if (lookup.kind === "id") return session === lookup.id ? line : null;
  if ((lookup.exclude ?? []).includes(session)) return null;
  return parts.at(-5) === kimiWorkspaceKey(trimmedFolder(lookup.folder)) ? line : null;
}

/** The note a Kimi pane shows when another Kimi pane naming no session is in its folder. */
export const kimiAmbiguousNote = "Two Kimi sessions are open in this folder, so Chat can't tell which is this pane's";

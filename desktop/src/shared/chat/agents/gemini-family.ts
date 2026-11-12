// Chat for Gemini CLI, Qwen Code and Antigravity CLI: their transcript formats, how Herdr
// names their panes and sessions, and the one remote command that finds each one's transcript. The shared
// files (parser.ts, locator.ts, …) register these at single lines.
//
// Herdr (herdrdev/herdr ee5bfb5):
// - agent kinds `gemini`, `qwen`, `agy` (src/detect/mod.rs:124-150; `antigravity` and `antigravity-cli` are
//   aliases of `agy`, :207);
// - `herdr:qwen` reports Qwen Code's session id from its SessionStart hook (src/integration/assets/qwen/
//   herdr-agent-session.sh:25-33; src/agent_resume.rs:263-265, `qwen --resume <id>`);
// - `herdr:antigravity_cli` reports Antigravity CLI's `conversationId` from its PreInvocation hook, agent `agy`
//   (src/integration/assets/antigravity_cli/herdr-agent-state.sh:43-55; src/agent_resume.rs:276-282,
//   `agy --conversation <id>`; detect/mod.rs:348, session identity only); its `transcriptPath` is dropped
//   (agent_resume.rs:116-133 keeps a path for pi and omp only);
// - nothing for Gemini CLI: no `herdr:gemini` source (agent_resume.rs:160-174, :200-290).
//
// So a Gemini pane follows its folder only (the Grok and Cursor folder rules, locator.ts folderFormats); a Qwen
// pane Herdr's id, else its folder by the same rules; an Antigravity pane Herdr's id only (its transcripts
// name no folder Chat could check).

import type { TranscriptLineResult } from "../claude-parser";
import type { TranscriptSessionRef } from "../locator";
import { AntigravityTranscriptParser } from "./antigravity-parser";
import { geminiSlimmed } from "./gemini-parts";
import { GeminiSessionParser } from "./gemini-parser";
import { QwenSessionParser } from "./qwen-parser";
import { onlyOneFile } from "./only-one";

/** The formats this file reads. */
export type GeminiFamilyFormat = "gemini" | "qwen" | "antigravity";

export const isGeminiFamilyFormat = (format: string): format is GeminiFamilyFormat => format === "gemini" || format === "qwen" || format === "antigravity";

/** The format of a pane Herdr says runs `agent` (its agent label), or null for another agent. */
export function geminiFamilyFormatOfAgent(agent: string | undefined): GeminiFamilyFormat | null {
  switch (agent?.toLowerCase()) {
    case "gemini":
      return "gemini";
    case "qwen":
      return "qwen";
    case "agy":
    case "antigravity":
    case "antigravity-cli":
      return "antigravity";
    default:
      return null;
  }
}

/** The format of a session Herdr reports from `source`, or null for another source. */
export function geminiFamilyFormatOfSource(source: string): GeminiFamilyFormat | null {
  if (source === "herdr:qwen") return "qwen";
  if (source === "herdr:antigravity_cli") return "antigravity";
  return null;
}

// MARK: - two panes in one folder

/** The note a Gemini or Qwen pane shows when another pane of its agent naming no session shares its folder. */
export type GeminiFamilyAmbiguousReason = "ambiguousGeminiSession" | "ambiguousQwenSession";

export function geminiFamilyAmbiguousReason(agent: string | undefined): GeminiFamilyAmbiguousReason | null {
  const format = geminiFamilyFormatOfAgent(agent);
  return format === "gemini" ? "ambiguousGeminiSession" : format === "qwen" ? "ambiguousQwenSession" : null;
}

// MARK: - the parser

/** One parser per format, behind the one face TranscriptParser calls. */
export class GeminiFamilyParser {
  private readonly parser: GeminiSessionParser | QwenSessionParser | AntigravityTranscriptParser;

  constructor(
    readonly format: GeminiFamilyFormat,
    parser?: GeminiSessionParser | QwenSessionParser | AntigravityTranscriptParser,
  ) {
    this.parser = parser ?? (format === "gemini" ? new GeminiSessionParser() : format === "qwen" ? new QwenSessionParser() : new AntigravityTranscriptParser());
  }

  clone(): GeminiFamilyParser {
    return new GeminiFamilyParser(this.format, this.parser.clone());
  }

  get cwd(): string | null {
    return this.parser.cwd;
  }

  set lineOffset(value: number | null) {
    this.parser.lineOffset = value;
  }

  /** A picture's base64 cut out of a long line before the parse (gemini-parts.ts); null when there is none. */
  slimmed(line: string): string | null {
    return this.format === "antigravity" ? null : geminiSlimmed(line);
  }

  parse(line: string): TranscriptLineResult {
    return this.parser.parse(line);
  }
}

// MARK: - finding the transcript

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

/** A UUID (Qwen Code's `randomUUID()` session ids, config/config.ts:3487; Antigravity's conversation ids). */
const isUUID = (value: string): boolean => /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/.test(value);

/** Qwen Code's project folder name for a working folder: every character but A–Z, a–z, 0–9 becomes `-` (utils/paths.ts:388-392). */
export const qwenProjectName = (folder: string): string => folder.replace(/[^A-Za-z0-9]/g, "-");

/** The newest regular file among `globs`' matches (skipping `skip`, a `case` pattern list), printed; always exits 0. */
/** The one regular file the globs match, or nothing. */
function onlyCommand(globs: readonly string[]): string {
  return "/bin/sh -c " + quote("set --; for f in " + globs.join(" ") + '; do [ -f "$f" ] && set -- "$@" "$f"; done; ' + onlyOneFile);
}

function newestCommand(globs: readonly string[], skip = ""): string {
  const script =
    "set --; for f in " +
    globs.join(" ") +
    "; do" +
    skip +
    ' [ -f "$f" ] && set -- "$@" "$f"; done; ' +
    '[ "$#" -gt 0 ] && /bin/ls -t -- "$@" | /usr/bin/head -n 1; exit 0';
  return "/bin/sh -c " + quote(script);
}

/**
 * Gemini CLI files a folder's sessions under `~/.gemini/tmp/<slug>/chats/` (storage.ts:229-233, :287-299), the slug
 * one its project registry gave the folder, and writes the folder in `<slug>/.project_root` (projectRegistry.ts:24,
 * :372-399; the path as `path.resolve` gives it, no newline). The command keeps the slugs whose `.project_root` is
 * the folder exactly (grep reads, never writes), and prints the newest `session-*.jsonl` filed directly in their
 * `chats/` (a subagent's sessions are in a folder below it, chatRecordingService.ts:803-813).
 */
function geminiFolderCommand(folder: string): string {
  const root = home + "/" + quote(".gemini") + "/" + quote("tmp") + "/*/";
  const script =
    "set --; for d in " +
    root +
    '; do [ -f "${d}.project_root" ] && /usr/bin/grep -qsxF -e ' +
    quote(folder) +
    ' -- "${d}.project_root" || continue; for f in "${d}chats/"' +
    quote("session-") +
    "*" +
    quote(".jsonl") +
    '; do [ -f "$f" ] && set -- "$@" "$f"; done; done; ' +
    '[ "$#" -gt 0 ] && /bin/ls -t -- "$@" | /usr/bin/head -n 1; exit 0';
  return "/bin/sh -c " + quote(script);
}

/** Antigravity CLI's runtime data, `~/.gemini/antigravity-cli` (Herdr src/integration/env.rs:204-208). */
const antigravityTranscript = (id: string): string =>
  [home, quote(".gemini"), quote("antigravity-cli"), quote("brain"), quote(id), quote(".system_generated"), quote("logs"), quote("transcript.jsonl")].join("/");

/** The one `/bin/sh` command that prints the transcript `ref` names, or null when there is none to run. */
export function geminiFamilyLocateCommand(ref: TranscriptSessionRef): string | null {
  const lookup = ref.lookup;
  if (lookup.kind === "path") return null;
  switch (ref.format) {
    case "gemini": {
      if (lookup.kind !== "folder" || (lookup.exclude?.length ?? 0) > 0) return null;
      const folder = usableFolder(lookup.folder);
      return folder === null ? null : geminiFolderCommand(folder);
    }
    case "qwen": {
      const projects = home + "/" + quote(".qwen") + "/" + quote("projects");
      // An id names one chat file across the projects
      // (two copies: neither, never the newer).
      if (lookup.kind === "id") return isUUID(lookup.id) ? onlyCommand([projects + "/*/" + quote("chats") + "/" + quote(lookup.id + ".jsonl")]) : null;
      const folder = usableFolder(lookup.folder);
      const exclude = lookup.exclude ?? [];
      if (folder === null || !exclude.every(isUUID)) return null;
      const skip = exclude.length === 0 ? "" : ' case "$f" in ' + exclude.map((id) => "*/" + quote(id + ".jsonl")).join("|") + ") continue;; esac;";
      return newestCommand([projects + "/" + quote(qwenProjectName(folder)) + "/" + quote("chats") + "/*" + quote(".jsonl")], skip);
    }
    case "antigravity":
      return lookup.kind === "id" && isUUID(lookup.id) ? newestCommand([antigravityTranscript(lookup.id)]) : null;
    default:
      return null;
  }
}

/** The path the command printed, when it is the file `ref` asks for; else null. */
export function geminiFamilyParseLocateOutput(output: string, ref: TranscriptSessionRef): string | null {
  const lookup = ref.lookup;
  if (lookup.kind === "path") return null;
  const line = output
    .split(/[\n\r]/)
    .map((part) => part.replace(/^[ \t]+|[ \t]+$/g, ""))
    .find((part) => part.length > 0);
  if (line === undefined || !line.startsWith("/") || !line.endsWith(".jsonl") || new TextEncoder().encode(line).length > maxPathBytes || hasControl(line)) return null;
  const parts = line.split("/").filter((part) => part.length > 0);
  const at = (back: number): string => parts[parts.length - back] ?? "";
  switch (ref.format) {
    case "gemini":
      // `<home>/.gemini/tmp/<slug>/chats/session-<time>-<id8>.jsonl`
      return lookup.kind === "folder" && /^session-[^/]+\.jsonl$/.test(at(1)) && at(2) === "chats" && at(4) === "tmp" && at(5) === ".gemini" ? line : null;
    case "qwen": {
      // `<home>/.qwen/projects/<project>/chats/<id>.jsonl`
      const id = at(1).slice(0, -".jsonl".length);
      if (!isUUID(id) || at(2) !== "chats" || at(4) !== "projects" || at(5) !== ".qwen") return null;
      if (lookup.kind === "id") return id === lookup.id ? line : null;
      const folder = usableFolder(lookup.folder);
      return folder !== null && at(3) === qwenProjectName(folder) && !(lookup.exclude ?? []).includes(id) ? line : null;
    }
    case "antigravity":
      // `<home>/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript.jsonl`
      return lookup.kind === "id" &&
        at(1) === "transcript.jsonl" &&
        at(2) === "logs" &&
        at(3) === ".system_generated" &&
        at(4) === lookup.id &&
        at(5) === "brain" &&
        at(6) === "antigravity-cli" &&
        at(7) === ".gemini"
        ? line
        : null;
    default:
      return null;
  }
}

/** The Qwen session id a ref names: its id, or the id its transcript file is named by; null for anything else. */
export function qwenSessionIDOf(ref: TranscriptSessionRef): string | null {
  if (ref.format !== "qwen") return null;
  const lookup = ref.lookup;
  if (lookup.kind === "id") return isUUID(lookup.id) ? lookup.id : null;
  if (lookup.kind !== "path") return null;
  const name = lookup.path.split("/").at(-1) ?? "";
  const id = name.endsWith(".jsonl") ? name.slice(0, -".jsonl".length) : "";
  return isUUID(id) ? id : null;
}

/** Whether `path` is a Qwen transcript whose session the folder lookup excludes (locator.ts grokLookupExcludes). */
export function qwenLookupExcludes(ref: TranscriptSessionRef, path: string): boolean {
  if (ref.format !== "qwen" || ref.lookup.kind !== "folder" || ref.lookup.exclude === undefined) return false;
  const name = path.split("/").at(-1) ?? "";
  return name.endsWith(".jsonl") && ref.lookup.exclude.includes(name.slice(0, -".jsonl".length));
}

// Each machine's model lists, read from the agents themselves
// (shared/model-catalog.ts says what each command is and how its answer
// reads).
//
// - This Mac runs the list command directly: argv, in its login environment
//   (the PATH its terminals get), its home as the folder, stdin empty or the
//   one line Claude Code's list needs.
// - Another Mac runs it over the read-only command path the away digest and
//   search use (RemoteCommandRunner): one `/bin/sh -c '<script>'` with every
//   value single-quoted; the script finds the program on the login shell's
//   PATH and says when it is missing, and the exit code after the output. The
//   demo machine answers the same intent from its fixtures.
// - Both run the list in the environment an agent has in
//   a pane on that Mac, the interactive login shell's (`$SHELL -ilc`: what
//   ~/.zshrc puts on PATH and exports, OpenCode in ~/.bun/bin and its
//   providers' keys). Another Mac's script runs the list inside that shell,
//   between its own markers (what the startup files print is never the list),
//   and falls back to the login shell's PATH when that shell cannot start or
//   prints no marker; This Mac reads that shell's environment once and runs
//   the program in it (its login environment when the read fails).
// - A list that fails says the program's own first plain
//   line (from its stderr); Cursor's and Claude Code's lists need the
//   machine's login keychain, which an SSH session cannot open, so another
//   Mac's list for them is shown from This Mac's when that one reads and the
//   other failed or is shorter (one quiet line says so; main's checks use the
//   same list). Each list stays under the machine it was read on.
// - Nothing runs until a picker first asks for that machine and agent. A list
//   is kept in memory and on disk (<userData>/model-catalogs.json, only each
//   model's own fields), shown at once from there, and read again in the
//   background once it is older than 10 minutes. One read at a time per
//   machine and agent. A failing read keeps the list it had and says why in
//   one line; Claude Code with no list at all shows its four aliases.

import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  borrowedLine,
  builtInCatalog,
  catalogErrorLine,
  catalogFreshMs,
  catalogModelFields,
  claudeFallback,
  claudeFallbackLine,
  cleanLabel,
  firstPlainLine,
  isCatalogAgent,
  isCatalogModel,
  keychainAgents,
  keychainLockedReason,
  listCommand,
  maxCatalogBytes,
  maxCatalogModels,
  parseCatalog,
  saysKeychainLocked,
  type CatalogAgent,
  type CatalogModel,
  type CatalogView,
  type ListCommand,
} from "../shared/model-catalog";
import { OutputCollector, withDeadline, type RemoteCommand, type RemoteCommandRunner } from "../shared/remote-command";

// MARK: - runs

/**
 * One list command's run: its stdout and exit code (and the first plain line it wrote to stderr, when it
 * wrote one), or the program is not on the machine.
 */
export type ListRun = { readonly kind: "ran"; readonly code: number | null; readonly output: string; readonly said?: string } | { readonly kind: "missing" };

/** Runs list commands on one machine. Rejects with an Error whose message is the plain reason (time, size, a cut answer). */
export interface CatalogRunner {
  /** The machine as the missing line names it ("this Mac", "Mac mini"). */
  readonly where: string;
  run(agent: CatalogAgent, command: ListCommand, signal: AbortSignal): Promise<ListRun>;
}

const megabytes = maxCatalogBytes / 1_048_576;
const tooLarge = (): Error => new Error(`its list is larger than ${megabytes} MB`);

type Spawn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

/** How much of a list program's stderr is kept (its first plain line is all that is read of it). */
const maxSaidBytes = 8_192;

/**
 * This Mac: the program run directly (argv), from the home folder, in the environment `environment` gives (the
 * interactive login shell's, as a pane has it; main.ts catalogEnvironment).
 */
export class LocalCatalogRunner implements CatalogRunner {
  readonly where = "this Mac";

  constructor(
    private readonly environment: () => NodeJS.ProcessEnv | Promise<NodeJS.ProcessEnv>,
    private readonly home: string,
    private readonly spawner: Spawn = spawn,
  ) {}

  async run(_agent: CatalogAgent, command: ListCommand, signal: AbortSignal): Promise<ListRun> {
    const program = command.program.startsWith("~/") ? path.join(this.home, command.program.slice(2)) : command.program;
    const env = await this.environment();
    return new Promise<ListRun>((resolve, reject) => {
      let child: ChildProcess;
      try {
        // The env's PATH finds the program (Node looks a bare name up in options.env.PATH).
        child = this.spawner(program, [...command.args], {
          env,
          cwd: this.home,
          stdio: [command.stdin === null ? "ignore" : "pipe", "pipe", "pipe"],
          windowsHide: true,
        });
      } catch (error) {
        reject(new Error(`it could not be started (${reasonOf(error)})`));
        return;
      }
      const collector = new OutputCollector(maxCatalogBytes);
      // Its stderr's start, for the failure line.
      const errors = new OutputCollector(maxSaidBytes);
      let settled = false;
      const finish = (outcome: () => void): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", stop);
        outcome();
      };
      const stop = (): void => {
        child.kill("SIGKILL");
        finish(() => reject(new Error("it was stopped")));
      };
      signal.addEventListener("abort", stop, { once: true });
      child.stdout?.on("data", (chunk: Buffer) => {
        if (collector.append(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength))) return;
        child.kill("SIGKILL");
        finish(() => reject(tooLarge()));
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        errors.append(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      });
      child.on("error", (error: NodeJS.ErrnoException) => {
        finish(() => (error.code === "ENOENT" ? resolve({ kind: "missing" }) : reject(new Error(`it could not be started (${error.code ?? reasonOf(error)})`))));
      });
      child.on("close", (code) => {
        const said = firstPlainLine(new TextDecoder().decode(errors.bytes));
        finish(() => resolve({ kind: "ran", code, output: new TextDecoder().decode(collector.bytes), ...(said === null ? {} : { said }) }));
      });
      if (command.stdin !== null && child.stdin !== null) {
        // A program that ends before reading its stdin is not a failure of the list's own.
        child.stdin.on("error", () => undefined);
        child.stdin.end(`${command.stdin}\n`);
      }
      if (signal.aborted) stop();
    });
  }
}

/** The lines the remote script prints around the list (or alone, for a missing program); each ends `-<token>`. */
export const listMissingMarker = "#adari-missing";
export const listExitMarker = "#adari-exit";
/** The line right before the list's own output (what a startup file printed comes before it). */
export const listBeginMarker = "#adari-list";
/** Each of the first plain lines a failed list wrote to stderr, after the exit line. */
export const listErrorMarker = "#adari-err";

/**
 * The markers of one read, each with that read's own token (made in main, fresh
 * for each read: `listToken`), so a line a startup file prints can never pass for one.
 */
export interface ListMarkers {
  readonly begin: string;
  readonly exit: string;
  readonly missing: string;
  readonly error: string;
}

/** A read's token: letters and digits only (quoted in the script like every other value all the same). */
const tokenForm = /^[A-Za-z0-9]{16,64}$/;

/** A fresh token for one read (24 hex digits). */
export function listToken(): string {
  return randomBytes(12).toString("hex");
}

/** The markers of the read with `token`; a token of any other form throws (nothing is built from it). */
export function listMarkers(token: string): ListMarkers {
  if (!tokenForm.test(token)) throw new Error("its read token is not letters and digits");
  return {
    begin: `${listBeginMarker}-${token}`,
    exit: `${listExitMarker}-${token}`,
    missing: `${listMissingMarker}-${token}`,
    error: `${listErrorMarker}-${token}`,
  };
}

const quote = (value: string): string => `'${value.split("'").join(`'"'"'`)}'`;

/** The folders searched after the shell's own PATH. */
const usualFolders = `PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin"; export PATH; `;

/**
 * The part of the script that runs the list, in whatever shell reads it (`/bin/sh`, or the user's zsh or bash read
 * interactively): the program found or `#adari-missing-<token>`; `#adari-list-<token>`; the program with its quoted
 * arguments (stdin the one quoted line, or empty), its stdout straight out and its stderr kept; `#adari-exit-<token>
 * <code>`; after a failure, stderr's first three lines with words, each after `#adari-err-<token>` (the read's own
 * token in each). Builtins are written `\printf` and `\command` and the
 * tools by their paths, so an alias in the user's startup files does not change them.
 */
function listBody(command: ListCommand, markers: ListMarkers): string {
  const run = `"$P" ${command.args.map(quote).join(" ")}`.trimEnd();
  const feed = command.stdin === null ? `${run} </dev/null` : `\\printf '%s\\n' ${quote(command.stdin)} | ${run}`;
  return (
    `P=${quote(command.program)}; case "$P" in "~/"*) P="$HOME/\${P#"~/"}";; esac; ` +
    `\\command -v "$P" >/dev/null 2>&1 || { \\printf '\\n%s\\n' ${quote(markers.missing)}; exit 0; }; ` +
    `\\printf '\\n%s\\n' ${quote(markers.begin)}; ` +
    `exec 3>&1; E=$(${feed} 2>&1 1>&3 3>&-); C=$?; exec 3>&-; ` +
    `\\printf '\\n%s %s\\n' ${quote(markers.exit)} "$C"; ` +
    `[ "$C" = 0 ] || \\printf '%s\\n' "$E" | /usr/bin/head -c ${maxSaidBytes} | /usr/bin/sed -e '/^[[:space:]]*$/d' -e ${quote(`s/^/${markers.error} /`)} | /usr/bin/head -n 3`
  );
}

/**
 * The shell check that the interactive shell's output holds exactly one whole frame of this read (its begin line
 * once, then its exit line once, no missing line), or the missing line alone; anything else (none, repeated, out of
 * order) sends the script to the fallback form. awk by its path, the markers passed as quoted values.
 */
function oneFrameCheck(markers: ListMarkers): string {
  const program =
    '$0 == b { nb++ } index($0, x) == 1 { nx++; if (nb == 1) after = 1 } $0 == m { nm++ } ' +
    "END { exit !((nb == 1 && nx == 1 && nm == 0 && after == 1) || (nb == 0 && nx == 0 && nm == 1)) }";
  return `\\printf '%s\\n' "$O" | /usr/bin/awk -v b=${quote(markers.begin)} -v x=${quote(`${markers.exit} `)} -v m=${quote(markers.missing)} ${quote(program)}`;
}

/**
 * The remote script for one list command. First in the environment an agent has in a pane there:
 * the user's shell read as an interactive login shell (`$SHELL -ilc`, stdin empty, its stderr dropped) runs the list between
 * the markers, and its output is printed whole only when it holds exactly one whole frame of this read's token (or
 * its missing line alone). Otherwise (the shell would not start, printed no frame, or a repeated or out-of-order
 * one: csh, fish, a startup file that ends the shell or prints a marker) the fallback: the login shell's PATH (and the usual places)
 * first, then the same list. Every value is single-quoted; nothing is read from a setting unquoted.
 */
export function remoteListCommand(agent: CatalogAgent, command: ListCommand, token: string): RemoteCommand {
  const markers = listMarkers(token);
  const body = listBody(command, markers);
  const script =
    `S="\${SHELL:-/bin/sh}"; case "$S" in /*) ;; *) S=/bin/sh;; esac; ` +
    `I=${quote(usualFolders + body)}; ` +
    `O=$("$S" -ilc "$I" </dev/null 2>/dev/null); ` +
    `if ${oneFrameCheck(markers)}; then \\printf '%s\\n' "$O"; exit 0; fi; ` +
    `LP=$("$S" -lc 'printf "%s\\n" "$PATH"' </dev/null 2>/dev/null | tail -n 1); ` +
    `[ -n "$LP" ] && PATH="$LP:$PATH"; ${usualFolders}` +
    body;
  return { text: `/bin/sh -c ${quote(script)}`, intent: { kind: "model-list", agent, token } };
}

/**
 * The remote script's output as a run: the list between this read's begin line and its exit line (what came before or
 * after is a startup file's), with the first plain line of its error lines; or the program missing.
 * Exactly one whole frame of this read's token, or its missing line alone. No frame (a cut
 * answer), a repeated begin or exit line, an exit before the begin, or a missing line with a frame: refused (a failed
 * read; the list held stays). Never the widest span between a first and a last marker.
 */
export function readRemoteList(text: string, token: string): ListRun {
  const markers = listMarkers(token);
  const lines = text.split("\n");
  const exitPrefix = `${markers.exit} `;
  const begins: number[] = [];
  const exits: number[] = [];
  let missing = 0;
  lines.forEach((line, index) => {
    if (line === markers.begin) begins.push(index);
    if (line.startsWith(exitPrefix)) exits.push(index);
    if (line === markers.missing) missing += 1;
  });
  if (begins.length === 0 && exits.length === 0) {
    if (missing === 1) return { kind: "missing" };
    if (missing === 0) throw new Error("its answer was cut off");
  }
  const [begin] = begins;
  const [exit] = exits;
  if (begins.length !== 1 || exits.length !== 1 || missing !== 0 || begin === undefined || exit === undefined || exit <= begin) {
    throw new Error("its answer did not hold exactly one list");
  }
  const code = Number.parseInt(lines[exit]!.slice(exitPrefix.length).trim(), 10);
  const errors: string[] = [];
  for (const line of lines.slice(exit + 1)) {
    if (!line.startsWith(`${markers.error} `)) break;
    errors.push(line.slice(markers.error.length + 1));
  }
  const said = firstPlainLine(errors.join("\n"));
  return { kind: "ran", code: Number.isFinite(code) ? code : null, output: lines.slice(begin + 1, exit).join("\n"), ...(said === null ? {} : { said }) };
}

/** The room past the list's own cap for the markers, the stderr lines and what the user's startup files print. */
const remoteRoomBytes = 65_536;

/** Another Mac (or the demo): the script over the read-only command path, its output capped. */
export class RemoteCatalogRunner implements CatalogRunner {
  constructor(
    private readonly runner: RemoteCommandRunner,
    readonly where: string,
  ) {}

  async run(agent: CatalogAgent, command: ListCommand, signal: AbortSignal): Promise<ListRun> {
    // A fresh token for this read alone.
    const token = listToken();
    const output = await this.runner.run(remoteListCommand(agent, command, token), maxCatalogBytes + remoteRoomBytes, signal);
    if (output.truncated) throw tooLarge();
    const run = readRemoteList(new TextDecoder().decode(output.bytes), token);
    // Cursor Agent's words for the keychain an SSH session cannot open (on stderr or stdout), said plainly.
    if (run.kind !== "ran" || run.code === 0) return run;
    const line = run.said ?? firstPlainLine(run.output);
    return line !== null && saysKeychainLocked(line) ? { ...run, said: keychainLockedReason } : run;
  }
}

/** Words a program's stdout line has when it is a message, not a list's row (a failed list that printed why there). */
const messageWords = /\b(?:error|failed|cannot|can't|could not|unable|not|locked|denied|expired|sign(?:ed)? in|log(?:ged)? in)\b/i;

/**
 * A line that is (or looks like) structured data: JSON, a JSON-like object or array, or
 * `"key": value` fields. Such a line is never shown as a reason.
 */
export function looksStructured(line: string): boolean {
  const text = line.trim();
  if (/^[[{]/u.test(text) || /[\]}]$/u.test(text)) return true;
  if (/"[^"]*"\s*:/u.test(text) || /\b[A-Za-z_][\w-]*\s*[:=]\s*[[{"]/u.test(text)) return true;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null;
  } catch {
    return false;
  }
}

/** Claude Code's stream-JSON answer holds an initialize response with subtype "error" (read, never shown). */
function claudeAnsweredError(output: string): boolean {
  for (const line of output.split("\n")) {
    try {
      const value: unknown = JSON.parse(line);
      if (typeof value !== "object" || value === null) continue;
      const response = (value as { response?: unknown }).response;
      if (typeof response === "object" && response !== null && (response as { subtype?: unknown }).subtype === "error") return true;
    } catch {
      // not a JSON line
    }
  }
  return false;
}

/**
 * Why a list that ended with a failing exit code failed: the first plain line it wrote to stderr,
 * else its stdout's first plain line when that reads as a message, else the exit code.
 * It is agent-aware. Claude Code's stdout and stderr are never shown (its answer carries account
 * fields): a fixed reason only, the keychain's (itself fixed), "it answered with an error" or the exit code. For the
 * others, a line that parses as JSON or looks like a structured object is never the reason.
 */
export function failedReason(agent: CatalogAgent, run: { readonly code: number | null; readonly output: string; readonly said?: string }): string {
  const exit = `it ended with exit ${run.code}`;
  if (agent === "claude") {
    if (run.said === keychainLockedReason) return keychainLockedReason;
    return claudeAnsweredError(run.output) ? "it answered with an error" : exit;
  }
  if (run.said !== undefined && run.said !== "" && !looksStructured(run.said)) return run.said;
  const line = firstPlainLine(run.output);
  if (line !== null && messageWords.test(line) && !looksStructured(line)) return line;
  return exit;
}

/** An error's message as one short plain line. */
function reasonOf(error: unknown): string {
  const text = cleanLabel(error instanceof Error ? error.message : String(error));
  return text === "" ? "it failed" : [...text].slice(0, 120).join("");
}

// MARK: - the disk cache

/** One list as the disk keeps it. */
export interface StoredCatalog {
  readonly host: string;
  readonly agent: CatalogAgent;
  readonly readAt: number;
  readonly models: readonly CatalogModel[];
}

export interface CatalogStore {
  load(): Promise<readonly StoredCatalog[]>;
  save(catalogs: readonly StoredCatalog[]): Promise<void>;
}

/** At most this many lists are kept on disk (the newest). */
export const maxStoredCatalogs = 64;
/** A cache file past this is not read. */
const maxCacheFileBytes = 16 * 1_048_576;

/** The stored lists of a cache file's text: each checked, only each model's own fields kept; anything else dropped. */
export function parseCatalogCache(text: string): StoredCatalog[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const record = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  if (record?.["version"] !== 1 || !Array.isArray(record["catalogs"])) return [];
  const out: StoredCatalog[] = [];
  for (const raw of record["catalogs"].slice(0, maxStoredCatalogs)) {
    const entry = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : null;
    if (entry === null || typeof entry["host"] !== "string" || entry["host"].length > 256 || !isCatalogAgent(entry["agent"])) continue;
    if (typeof entry["readAt"] !== "number" || !Number.isFinite(entry["readAt"]) || !Array.isArray(entry["models"])) continue;
    const models = entry["models"].slice(0, maxCatalogModels).filter(isCatalogModel).map(catalogModelFields);
    if (models.length === 0) continue;
    // An OpenCode list kept from before its display names were read (`--verbose`) is read again.
    if (entry["agent"] === "opencode" && !models.some((model) => model.variants !== undefined)) continue;
    out.push({ host: entry["host"], agent: entry["agent"], readAt: entry["readAt"], models });
  }
  return out;
}

/** The cache file's text for `catalogs` (the newest maxStoredCatalogs, each model's own fields only). */
export function catalogCacheText(catalogs: readonly StoredCatalog[]): string {
  const newest = [...catalogs].sort((a, b) => b.readAt - a.readAt).slice(0, maxStoredCatalogs);
  return JSON.stringify({
    version: 1,
    catalogs: newest.map((entry) => ({ host: entry.host, agent: entry.agent, readAt: entry.readAt, models: entry.models.map(catalogModelFields) })),
  });
}

/** The cache in one file, written whole (a temporary file renamed over it), readable by its owner only. */
export class FileCatalogStore implements CatalogStore {
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {}

  async load(): Promise<readonly StoredCatalog[]> {
    try {
      const stat = await fs.stat(this.file);
      if (!stat.isFile() || stat.size > maxCacheFileBytes) return [];
      return parseCatalogCache(await fs.readFile(this.file, "utf8"));
    } catch {
      return [];
    }
  }

  save(catalogs: readonly StoredCatalog[]): Promise<void> {
    const text = catalogCacheText(catalogs);
    const next = this.writing.then(async () => {
      const temporary = `${this.file}.${process.pid}.tmp`;
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.writeFile(temporary, text, { mode: 0o600 });
      await fs.rename(temporary, this.file);
    });
    this.writing = next.catch(() => undefined);
    return next;
  }
}

// MARK: - the service

/** A machine a list can be read on: its runner and its start command for the agent. */
export interface CatalogMachine {
  readonly runner: CatalogRunner;
  startCommand(): Promise<string | null>;
}

export interface ModelCatalogDeps {
  /** The machine as it answers now, or null (not listed, not connected, or it cannot run commands). */
  machine(hostId: string, agent: CatalogAgent): CatalogMachine | null;
  readonly store: CatalogStore | null;
  now(): number;
  /** A list changed (a read began or ended): the pages are told. */
  changed(hostId: string, view: CatalogView): void;
  /** The tests' shorter time for a run (absent: the list command's own, 15 or 20 s). */
  readonly deadlineMs?: number;
  /** This Mac's id when it is listed (its lists may stand in for another Mac's), else null. */
  thisMac?(): string | null;
  /** A machine's name for the line over This Mac's list shown for it. */
  machineName?(hostId: string): string | null;
}

interface Entry {
  readonly models: readonly CatalogModel[];
  /** When the list was read; null: never (Claude Code's fallback, or nothing). */
  readonly readAt: number | null;
  readonly error: string | null;
  /** When a read was last begun (a failing one is not begun again within retryMs). */
  readonly triedAt: number | null;
}

/** A failed read is tried again after this long (a fresh one after catalogFreshMs). */
export const catalogRetryMs = 60_000;

const keyOf = (hostId: string, agent: CatalogAgent): string => `${hostId}\u{0}${agent}`;

export class ModelCatalogs {
  private readonly entries = new Map<string, Entry>();
  private readonly running = new Map<string, Promise<void>>();
  private loading: Promise<void> | null = null;

  constructor(private readonly deps: ModelCatalogDeps) {}

  /** The list as held now (at once), a read begun in the background when there is none or it is old. */
  async view(hostId: string, agent: CatalogAgent): Promise<CatalogView> {
    if (agent === "agy") return builtInCatalog("agy");
    await this.loaded();
    for (const host of this.readFor(hostId, agent)) if (this.stale(host, agent)) void this.refresh(host, agent);
    return this.viewOf(hostId, agent);
  }

  /**
   * The list, read first when none is held yet (New agent's check of a choice, a live pick); an old one is refreshed
   * behind. For Cursor or Claude Code on another Mac, This Mac's list too, so the list checked is
   * the one the picker shows.
   */
  async settled(hostId: string, agent: CatalogAgent): Promise<CatalogView> {
    if (agent === "agy") return builtInCatalog("agy");
    await this.loaded();
    await Promise.all(
      this.readFor(hostId, agent).map(async (host) => {
        const entry = this.entries.get(keyOf(host, agent));
        if (entry === undefined || entry.models.length === 0) await this.refresh(host, agent);
        else if (this.stale(host, agent)) void this.refresh(host, agent);
      }),
    );
    return this.viewOf(hostId, agent);
  }

  /**
   * The list once every read of it under way now has ended (none begun here): a live pick of a row
   * the held list does not name (or names without what the pick needs) is checked again against the list being read.
   */
  async afterReading(hostId: string, agent: CatalogAgent): Promise<CatalogView> {
    if (agent === "agy") return builtInCatalog("agy");
    await this.loaded();
    await Promise.all(this.readFor(hostId, agent).map((host) => this.running.get(keyOf(host, agent))?.catch(() => undefined)));
    return this.viewOf(hostId, agent);
  }

  /** The machines whose lists a view of `hostId`'s list reads: its own, and This Mac's for a keychain agent on another Mac. */
  private readFor(hostId: string, agent: CatalogAgent): string[] {
    const local = this.localFor(hostId, agent);
    return local === null ? [hostId] : [hostId, local];
  }

  /** This Mac's id when its list may stand in for `hostId`'s (a keychain agent on another Mac), else null. */
  private localFor(hostId: string, agent: CatalogAgent): string | null {
    if (!keychainAgents.has(agent)) return null;
    const local = this.deps.thisMac?.() ?? null;
    return local === null || local === hostId ? null : local;
  }

  /** Reads the list now, unless a read for that machine and agent is under way (that one is waited for). */
  refresh(hostId: string, agent: CatalogAgent): Promise<void> {
    const key = keyOf(hostId, agent);
    const under = this.running.get(key);
    if (under !== undefined) return under;
    const read = this.read(hostId, agent).finally(() => {
      this.running.delete(key);
      this.deps.changed(hostId, this.viewOf(hostId, agent));
      // This Mac's list may be what another Mac's picker shows: those views change with it.
      if (keychainAgents.has(agent) && hostId === (this.deps.thisMac?.() ?? null)) {
        for (const other of this.hostsWith(agent)) if (other !== hostId) this.deps.changed(other, this.viewOf(other, agent));
      }
    });
    this.running.set(key, read);
    return read;
  }

  private stale(hostId: string, agent: CatalogAgent): boolean {
    const key = keyOf(hostId, agent);
    if (this.running.has(key)) return false;
    const entry = this.entries.get(key);
    if (entry === undefined) return true;
    const now = this.deps.now();
    if (entry.readAt !== null && now - entry.readAt < catalogFreshMs) return false;
    return entry.triedAt === null || now - entry.triedAt >= catalogRetryMs;
  }

  /** Demo captures only: the machine's list for `agent` dropped from memory, as if never read. */
  forgetForCapture(hostId: string, agent: CatalogAgent): void {
    if (!this.running.has(keyOf(hostId, agent))) this.entries.delete(keyOf(hostId, agent));
  }

  /** The machines with an entry for `agent`. */
  private hostsWith(agent: CatalogAgent): string[] {
    const hosts: string[] = [];
    for (const key of this.entries.keys()) {
      const [host, entryAgent] = key.split("\u{0}") as [string, string];
      if (entryAgent === agent) hosts.push(host);
    }
    return hosts;
  }

  /**
   * The view the picker and main's checks get. For Cursor or Claude Code on another Mac, This
   * Mac's list (read, not Claude Code's fallback) when the other Mac's own failed or is shorter, under the quiet line;
   * nothing merged. Without This Mac's list the other Mac's own answer stands.
   */
  private viewOf(hostId: string, agent: CatalogAgent): CatalogView {
    const entry = this.entries.get(keyOf(hostId, agent));
    const loading = this.running.has(keyOf(hostId, agent));
    const local = this.localFor(hostId, agent);
    const there = local === null ? undefined : this.entries.get(keyOf(local, agent));
    if (local !== null && there !== undefined && there.readAt !== null && there.models.length > 0) {
      const own = entry !== undefined && entry.readAt !== null ? entry.models.length : 0;
      if (own < there.models.length) {
        const machine = this.deps.machineName?.(hostId) ?? "that Mac";
        return { ...builtInCatalog(agent), models: there.models, readAt: there.readAt, error: null, loading: loading || this.running.has(keyOf(local, agent)), borrowed: borrowedLine(machine) };
      }
    }
    return {
      ...builtInCatalog(agent),
      models: entry?.models ?? [],
      readAt: entry?.readAt ?? null,
      error: entry?.error ?? null,
      loading,
    };
  }

  private loaded(): Promise<void> {
    if (this.loading === null) {
      const store = this.deps.store;
      this.loading =
        store === null
          ? Promise.resolve()
          : store
              .load()
              .then((catalogs) => {
                for (const stored of catalogs) {
                  const key = keyOf(stored.host, stored.agent);
                  if (!this.entries.has(key)) this.entries.set(key, { models: stored.models, readAt: stored.readAt, error: null, triedAt: null });
                }
              })
              .catch(() => undefined);
    }
    return this.loading;
  }

  private async read(hostId: string, agent: CatalogAgent): Promise<void> {
    const key = keyOf(hostId, agent);
    const before = this.entries.get(key);
    const triedAt = this.deps.now();
    this.entries.set(key, { models: before?.models ?? [], readAt: before?.readAt ?? null, error: before?.error ?? null, triedAt });
    this.deps.changed(hostId, { ...this.viewOf(hostId, agent), loading: true });
    try {
      const machine = this.deps.machine(hostId, agent);
      if (machine === null) throw new Error("the machine is not connected");
      const start = await machine.startCommand().catch(() => null);
      const command = listCommand(agent, start);
      if (command === null) return;
      const run = await withDeadline(
        this.deps.deadlineMs ?? command.timeoutMs,
        (signal) => machine.runner.run(agent, command, signal),
        () => new Error(`it did not answer within ${Math.round(command.timeoutMs / 1_000)} s`),
      );
      if (run.kind === "missing") throw new Error(`${path.basename(command.program)} was not found on ${machine.runner.where}`);
      const parsed = parseCatalog(agent, run.output);
      if (!parsed.ok) throw new Error(run.code !== null && run.code !== 0 ? failedReason(agent, run) : parsed.reason);
      this.entries.set(key, { models: parsed.models.map(catalogModelFields), readAt: this.deps.now(), error: null, triedAt });
      await this.save();
    } catch (error) {
      const reason = reasonOf(error);
      const held = this.entries.get(key);
      const read = held !== undefined && held.readAt !== null && held.models.length > 0;
      if (read) this.entries.set(key, { ...held, error: catalogErrorLine(agent, reason), triedAt });
      else if (agent === "claude") this.entries.set(key, { models: claudeFallback, readAt: null, error: claudeFallbackLine(reason), triedAt });
      else this.entries.set(key, { models: [], readAt: null, error: catalogErrorLine(agent, reason), triedAt });
    }
  }

  private async save(): Promise<void> {
    const store = this.deps.store;
    if (store === null) return;
    const catalogs: StoredCatalog[] = [];
    for (const [key, entry] of this.entries) {
      if (entry.readAt === null || entry.models.length === 0) continue;
      const [host, agent] = key.split("\u{0}") as [string, string];
      if (isCatalogAgent(agent)) catalogs.push({ host, agent, readAt: entry.readAt, models: entry.models });
    }
    await store.save(catalogs).catch(() => undefined);
  }
}

// Synthetic homes for the core folder lookup, as the iPhone app's tests make
// them (its boundary tests: home(), file(), locate();
// CoreChatSessionTests: LocalHomeReader). Homes in the test scratch folder
// (HERDR_TEST_SCRATCH), their names with a quote, `$()`
// and backticks; commands run as the Mac's exec runs them (`/bin/sh -s`, the
// command's UTF-8 on stdin, HOME the synthetic home).

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { coreTranscriptLocator, type CoreTranscriptLocating } from "../../src/main/herdr/core-session-finder";
import { coreClaudeProjectSlug, type CoreEarlierSession, type CoreFolderFormat, type CoreFolderRef, type CoreFolderResult } from "../../src/shared/chat/core-folder-lookup";

export const scratch = realpathSync(process.env["HERDR_TEST_SCRATCH"] || os.tmpdir());

/** The folder these fixtures work in, and their sessions. */
export const projectFolder = "/Users/fixture/proj";
export const a = "11111111-1111-4111-8111-111111111111";
export const b = "22222222-2222-4222-8222-222222222222";
export const c = "33333333-3333-4333-8333-333333333333";

export function home(): string {
  const dir = path.join(scratch, `core-chat-home-${randomUUID()} ' $() \`literal\``);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** `command` as the exec runs it: `/bin/sh -s`, its UTF-8 on stdin, HOME `at`. */
export function runAt(command: string, at: string): string {
  const result = spawnSync("/bin/sh", ["-s"], { input: command + "\n", env: { ...process.env, HOME: at }, encoding: "utf8", timeout: 30_000 });
  return result.stdout;
}

/** A pid whose process has ended. */
export function goneProcess(): number {
  return spawnSync("/usr/bin/true").pid;
}

export interface FileOptions {
  readonly folder?: string;
  readonly filedUnder?: string;
  readonly extra?: Record<string, unknown>;
  readonly source?: unknown;
  /** Seconds from now its mtime is (positive: ahead). Default 10. */
  readonly age?: number;
  readonly filename?: string;
  readonly seat?: string;
  /** The whole file, in place of the one record. */
  readonly lines?: readonly string[];
}

/** A transcript with one record: Claude's user line, or Codex's session_meta. */
export function transcript(at: string, format: CoreFolderFormat, id: string, options: FileOptions = {}): string {
  const cwd = options.folder ?? projectFolder;
  let target: string;
  let object: Record<string, unknown>;
  if (format === "claude") {
    const config = options.seat === undefined ? ".claude" : `.claude-seats/${options.seat}`;
    target = path.join(at, config, "projects", coreClaudeProjectSlug(options.filedUnder ?? cwd), options.filename ?? `${id}.jsonl`);
    object = { type: "user", cwd, sessionId: id, isSidechain: false, message: { role: "user", content: "synthetic prompt text" }, ...options.extra };
  } else {
    target = path.join(at, ".codex/sessions/2026/11/09", options.filename ?? `rollout-2026-11-09T00-00-00-${id}.jsonl`);
    const payload: Record<string, unknown> = { id, cwd, source: options.source === undefined ? "cli" : options.source, ...options.extra };
    object = { type: "session_meta", payload };
  }
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, (options.lines ?? [JSON.stringify(object)]).join("\n") + "\n");
  setModified(target, Date.now() / 1000 + (options.age ?? 10));
  return target;
}

export function setModified(target: string, seconds: number): void {
  utimesSync(target, seconds, seconds);
}

/**
 * The Mac's lookup over a synthetic home (`coreTranscriptLocator` on a read-only runner that runs the command as the
 * exec does), every lookup and process-start check recorded.
 */
export class LocalHomeReader implements CoreTranscriptLocating {
  readonly located: CoreFolderRef[] = [];
  readonly checked: number[] = [];
  private readonly inner: CoreTranscriptLocating;

  constructor(readonly home: string) {
    this.inner = coreTranscriptLocator(() => ({ runReadOnlyCommand: async (command, max) => runAt(command, home).slice(0, max) }));
  }

  locateCore(ref: CoreFolderRef, earlier: readonly CoreEarlierSession[]): Promise<CoreFolderResult | null> {
    this.located.push(ref);
    return this.inner.locateCore(ref, earlier);
  }

  coreProcessGeneration(pid: number): Promise<string | null> {
    this.checked.push(pid);
    return this.inner.coreProcessGeneration(pid);
  }
}

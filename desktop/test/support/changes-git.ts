// git for the Changes tests (HerdrKit's AgentChangesGitTests helpers): temporary
// repositories made under the test scratch folder (HERDR_TEST_SCRATCH, else
// the temporary folder), git run with a scratch global config that is empty
// (GIT_CONFIG_GLOBAL), no system config (GIT_CONFIG_NOSYSTEM=1) and a ceiling at
// the scratch folder, so no repository outside it is ever found; and a local
// shell that runs a Changes command as a Mac's SSH exec does (the shell's -c),
// taking its exit as the app's runner does (a failure with nothing on stdout
// rejects). Never a real repository, never this Mac's own git config.

import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { shellQuote } from "../../src/shared/chat/locator";
import type { ReadOnlyCommandRunner } from "../../src/shared/changes/reader";

export const scratch = realpathSync(process.env["HERDR_TEST_SCRATCH"] || os.tmpdir());

let globalConfig: string | null = null;

/** An empty file: the "global" git config every test git reads (and a test may write its own). */
export function emptyGlobalConfig(): string {
  if (globalConfig === null) {
    const folder = path.join(scratch, `desktop-changes-config-${randomUUID()}`);
    mkdirSync(folder, { recursive: true });
    globalConfig = path.join(folder, "empty.gitconfig");
    writeFileSync(globalConfig, "");
  }
  return globalConfig;
}

/** git's environment: no user or system config, no repository found above the scratch folder. */
export function gitEnvironment(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_COMMON_DIR"]) delete environment[name];
  return {
    ...environment,
    GIT_CONFIG_GLOBAL: emptyGlobalConfig(),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CEILING_DIRECTORIES: scratch,
    GIT_TERMINAL_PROMPT: "0",
    ...extra,
  };
}

export function makeRoot(name: string): string {
  const root = path.join(scratch, `desktop-changes-${name}-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  return root;
}

/** git in `folder` with a fixture identity and no hooks; throws on a failure. */
export function git(args: readonly string[], folder: string, options: { date?: string; global?: string } = {}): string {
  const extra: Record<string, string> = {};
  if (options.date !== undefined) {
    extra["GIT_AUTHOR_DATE"] = options.date;
    extra["GIT_COMMITTER_DATE"] = options.date;
  }
  if (options.global !== undefined) extra["GIT_CONFIG_GLOBAL"] = options.global;
  const result = spawnSync(
    "/usr/bin/git",
    ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args],
    { cwd: folder, env: gitEnvironment(extra), encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed (${result.status}): ${result.stderr}`);
  return result.stdout;
}

export function write(text: string, name: string, folder: string): void {
  const file = path.join(folder, name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/** One commit, then a file changed and not staged, one staged, one renamed, one untracked with a newline in its name. */
export function makeRepository(folder: string): void {
  mkdirSync(folder, { recursive: true });
  git(["init", "-q", "-b", "main", "."], folder);
  write("a\nb\nc\n", "work file.swift", folder);
  write("one\n", "staged.swift", folder);
  write(
    Array.from({ length: 20 }, (_, i) => String(i + 1)).join("\n") + "\n",
    "old.txt",
    folder,
  );
  git(["add", "-A"], folder);
  git(["commit", "-q", "-m", "First"], folder, { date: "2026-11-02T00:30:00Z" });
  write("a\nB\nc\nd\n", "work file.swift", folder);
  write("one\ntwo\n", "staged.swift", folder);
  git(["add", "staged.swift"], folder);
  git(["mv", "old.txt", "new.txt"], folder);
  write("u\n", "un\ntracked $x.txt", folder);
}

export class ShellFailed extends Error {
  constructor(readonly status: number | null) {
    super(`the shell exited ${String(status)} with nothing on stdout`);
  }
}

/**
 * Runs a command as a Mac's SSH exec does (`<shell> -c`; zsh without its
 * startup files), in the scratch folder, with git's scratch environment
 * (`environment` on top). Like the app's runner, a command that fails with
 * nothing on stdout rejects (fix 2); `strictExit` false takes any exit.
 */
export class LocalShell implements ReadOnlyCommandRunner {
  readonly commands: string[] = [];

  constructor(
    readonly shell: string,
    readonly environment: Record<string, string> = {},
    readonly strictExit = true,
  ) {}

  runReadOnlyCommand(command: string, maxOutputBytes: number, signal?: AbortSignal): Promise<string> {
    this.commands.push(command);
    return new Promise((resolve, reject) => {
      const args = this.shell.endsWith("zsh") ? ["-f", "-c", command] : ["-c", command];
      const child = spawn(this.shell, args, { cwd: scratch, env: gitEnvironment(this.environment), stdio: ["ignore", "pipe", "ignore"] });
      const chunks: Buffer[] = [];
      let bytes = 0;
      const abort = (): void => {
        child.kill("SIGKILL");
      };
      signal?.addEventListener("abort", abort, { once: true });
      child.stdout.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
        bytes += chunk.length;
      });
      child.on("error", reject);
      child.on("close", (status) => {
        signal?.removeEventListener("abort", abort);
        if (this.strictExit && status !== 0 && bytes === 0) {
          reject(new ShellFailed(status));
          return;
        }
        resolve(Buffer.concat(chunks).subarray(0, maxOutputBytes).toString("utf8"));
      });
    });
  }
}

/** A plain git command line in `folder` (the user's own `git diff`), for the controls. */
export function plainGitCommand(args: readonly string[], folder: string): string {
  return ["git", "-C", folder, ...args].map(shellQuote).join(" ") + " 2>/dev/null";
}

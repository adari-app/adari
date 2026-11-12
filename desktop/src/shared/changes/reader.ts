// A port of HerdrKit's AgentCommandGate and
// AgentChangesGitReader: the commands on one Mac run through its gate (3 at
// once), each with its timeout (5 s) and its bound, over the connection the app
// already has. A command waiting its turn leaves the line when cancelled; a
// running one is ended (its signal aborts, the runner closes its exec). Nothing
// here throws but cancellation: a runner that fails reads as a failure, never as
// a clean folder.

import {
  defaultChangesLimits,
  fileDiffCommand,
  isFolder,
  logCommand,
  makeNonce,
  parseLog,
  parseStatus,
  parseText,
  showCommand,
  statusCommand,
  type AgentChangesLimits,
  type AgentCommitsRead,
  type GitFileChange,
  type GitFolderRead,
  type GitTextResult,
} from "./git";

/**
 * Runs one read-only command on the Mac and gives what it printed, at most
 * `maxOutputBytes` (the rest dropped); rejects when it cannot run. Aborting the
 * signal ends the command (the exec's channel is closed) and rejects.
 */
export interface ReadOnlyCommandRunner {
  runReadOnlyCommand(command: string, maxOutputBytes: number, signal?: AbortSignal): Promise<string>;
}

/** The read was cancelled (another read took its place, or the view went away). */
export class ChangesCancelled extends Error {
  constructor() {
    super("The Changes read was cancelled.");
    this.name = "ChangesCancelled";
  }
}

interface Waiter {
  readonly grant: () => void;
}

/** At most `permits` operations at once; the rest wait their turn, in order. */
export class CommandGate {
  private free: number;
  private readonly line: Waiter[] = [];

  constructor(permits: number) {
    this.free = Math.max(1, Math.floor(permits));
  }

  /** Permits not in use. */
  get available(): number {
    return this.free;
  }

  async run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal);
    try {
      return await operation();
    } finally {
      this.release();
    }
  }

  private acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted === true) return Promise.reject(new ChangesCancelled());
    if (this.free > 0) {
      this.free -= 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        const index = this.line.indexOf(waiter);
        if (index >= 0) this.line.splice(index, 1);
        reject(new ChangesCancelled());
      };
      const waiter: Waiter = {
        grant: () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        },
      };
      this.line.push(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private release(): void {
    const next = this.line.shift();
    if (next === undefined) this.free += 1;
    else next.grant();
  }
}

/** What a command gave: its output, or why there is none. */
type Run = { readonly kind: "output"; readonly text: string } | { readonly kind: "failed" } | { readonly kind: "timedOut" };

/** A little more than the bound: the Mac's `head -c` cuts there, and the exits come after it. */
const slack = 4_096;

export class AgentChangesGitReader {
  constructor(
    private readonly runner: ReadOnlyCommandRunner,
    /** The Mac's gate: the across-agents screen's transcript reads go through it too. */
    readonly gate: CommandGate,
    private readonly limits: AgentChangesLimits = defaultChangesLimits,
    private readonly nonce: () => string = makeNonce,
  ) {}

  /** The branch, the top folder and every change with its counts. */
  async status(folder: string, signal?: AbortSignal): Promise<GitFolderRead> {
    const nonce = this.nonce();
    const run = await this.run(statusCommand(folder, nonce, this.limits.statusBytes), this.limits.statusBytes, signal);
    return run.kind === "output" ? parseStatus(run.text, nonce) : { kind: run.kind };
  }

  /** One file's diff; an untracked folder has none here (nothing runs). */
  async fileDiff(folder: string, change: GitFileChange, signal?: AbortSignal): Promise<GitTextResult> {
    if (isFolder(change)) {
      if (signal?.aborted === true) throw new ChangesCancelled();
      return { kind: "text", text: { parts: [], cut: false } };
    }
    const nonce = this.nonce();
    const run = await this.run(fileDiffCommand(folder, change, nonce, this.limits.fileDiffBytes), this.limits.fileDiffBytes, signal);
    return run.kind === "output" ? parseText(run.text, nonce) : { kind: run.kind };
  }

  /** One commit with its stat and diff; anything but a full hash fails without running. */
  async show(folder: string, hash: string, signal?: AbortSignal): Promise<GitTextResult> {
    const nonce = this.nonce();
    const command = showCommand(folder, hash, nonce, this.limits.commitBytes);
    if (command === null) {
      if (signal?.aborted === true) throw new ChangesCancelled();
      return { kind: "failed" };
    }
    const run = await this.run(command, this.limits.commitBytes, signal);
    return run.kind === "output" ? parseText(run.text, nonce) : { kind: run.kind };
  }

  /** The commits since `since` (seconds since 1970), newest first. */
  async commits(folder: string, since: number, signal?: AbortSignal): Promise<AgentCommitsRead> {
    const nonce = this.nonce();
    const run = await this.run(logCommand(folder, since, this.limits.maxCommits, nonce, this.limits.logBytes), this.limits.logBytes, signal);
    return run.kind === "output" ? parseLog(run.text, since, nonce) : { kind: run.kind };
  }

  /**
   * Through the gate, with the timeout: the first of the output, the runner's
   * failure, the timeout (which ends the command) and the cancel (which ends it
   * and throws) wins.
   */
  private run(command: string, maxBytes: number, signal?: AbortSignal): Promise<Run> {
    return this.gate.run(
      () =>
        new Promise<Run>((resolve, reject) => {
          if (signal?.aborted === true) {
            reject(new ChangesCancelled());
            return;
          }
          const exec = new AbortController();
          const done = (): void => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onCancel);
          };
          const timer = setTimeout(() => {
            done();
            exec.abort();
            resolve({ kind: "timedOut" });
          }, Math.max(0, this.limits.timeoutMs));
          const onCancel = (): void => {
            done();
            exec.abort();
            reject(new ChangesCancelled());
          };
          signal?.addEventListener("abort", onCancel, { once: true });
          this.runner.runReadOnlyCommand(command, maxBytes + slack, exec.signal).then(
            (text) => {
              done();
              resolve({ kind: "output", text });
            },
            () => {
              done();
              resolve({ kind: "failed" });
            },
          );
        }),
      signal,
    );
  }
}

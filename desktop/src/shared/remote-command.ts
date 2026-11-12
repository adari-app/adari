// One read-only command run on a machine: `git log` in an
// agent's folder for "While you were away", the one `grep` of a conversation
// search, an agent's model list. The command's text is what runs over SSH (`/bin/sh -c '…'`, every
// value quoted); `intent` says what it was built for, so the demo machine
// (src/main/demo/demo-remote.ts) can answer from its fixtures without a shell.
// Nothing here writes on the machine.

/** What the command was built for (the demo answers by this; SSH runs `text`). */
export type RemoteCommandIntent =
  | { readonly kind: "git-log"; readonly folder: string; readonly since: number; readonly maxCount: number }
  | {
      readonly kind: "search";
      /** grep's patterns (`-F -i`, ASCII case folded). */
      readonly patterns: readonly string[];
      /** Each searched target, by its index in the command. */
      readonly targets: readonly RemoteSearchTarget[];
      readonly maxHitsPerFile: number;
    }
  /** An agent's own model list command (src/main/model-catalogs.ts remoteListCommand). */
  | {
      readonly kind: "model-list";
      readonly agent: string;
      /** This read's marker token (the demo frames its answer with it). */
      readonly token: string;
    };

/** One transcript a search command looks in. */
export interface RemoteSearchTarget {
  readonly index: number;
  /** The path asked for, or null when the file is found by the session's globs. */
  readonly path: string | null;
  /** The session id or Claude folder the globs are made from (null for a path). */
  readonly lookup: { readonly kind: "id"; readonly id: string; readonly format: "claude" | "codex" } | { readonly kind: "folder"; readonly folder: string } | null;
}

export interface RemoteCommand {
  /** `/bin/sh -c '<script>'`. */
  readonly text: string;
  readonly intent: RemoteCommandIntent;
}

/** A command's stdout, cut at the cap. */
export interface RemoteCommandOutput {
  readonly bytes: Uint8Array;
  /** The output passed the cap: what follows was not read (the channel was closed). */
  readonly truncated: boolean;
}

/** Runs read-only commands on one machine (its transcript connection over SSH, or the demo's fixtures). */
export interface RemoteCommandRunner {
  /**
   * Runs `command` once: its stdout up to `maxOutputBytes` (past it the channel
   * closes and the output is `truncated`), stderr ignored. An aborted `signal`
   * closes the channel and rejects.
   */
  run(command: RemoteCommand, maxOutputBytes: number, signal?: AbortSignal): Promise<RemoteCommandOutput>;
}

/** Collects a command's stdout up to the cap (ConversationSearchOutputCollector). */
export class OutputCollector {
  private readonly chunks: Uint8Array[] = [];
  private length = 0;
  truncated = false;

  constructor(readonly limit: number) {}

  /** Adds a chunk; false once the cap is reached: stop reading, the rest is not shown. */
  append(chunk: Uint8Array): boolean {
    if (this.truncated) return false;
    const room = Math.max(0, this.limit) - this.length;
    if (chunk.length > room) {
      this.chunks.push(chunk.slice(0, room));
      this.length += room;
      this.truncated = true;
      return false;
    }
    this.chunks.push(chunk);
    this.length += chunk.length;
    return true;
  }

  get bytes(): Uint8Array {
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, at);
      at += chunk.length;
    }
    return out;
  }

  get output(): RemoteCommandOutput {
    return { bytes: this.bytes, truncated: this.truncated };
  }
}

/** The error an aborted signal rejects with. */
export class CancelledError extends Error {
  constructor() {
    super("cancelled");
    this.name = "CancelledError";
  }
}

export function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new CancelledError();
}

export const isCancelled = (error: unknown, signal?: AbortSignal): boolean => error instanceof CancelledError || signal?.aborted === true;

/** `work`, or `onTimeout()`'s error after `ms` (the work's own signal is aborted then). */
export async function withDeadline<T>(
  ms: number,
  work: (signal: AbortSignal) => Promise<T>,
  timeoutError: () => Error,
  outer?: AbortSignal,
): Promise<T> {
  throwIfCancelled(outer);
  const inner = new AbortController();
  const forward = (): void => inner.abort();
  outer?.addEventListener("abort", forward, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // The deadline's error first: work that fails as its signal aborts must not win the race.
      reject(timeoutError());
      inner.abort();
    }, ms);
  });
  const cancelled = new Promise<never>((_, reject) => {
    if (outer !== undefined) outer.addEventListener("abort", () => reject(new CancelledError()), { once: true });
  });
  try {
    return await Promise.race([work(inner.signal), deadline, cancelled]);
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", forward);
  }
}

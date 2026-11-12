// A machine that answers a search from memory (the Swift tests' SearchFakeRemote):
// the command's output as given (or never, or a failure), and reads of
// in-memory files. Fixtures only.

import { OutputCollector, type RemoteCommand } from "../../src/shared/remote-command";
import type { SearchRemote, SearchRun, SearchUpdate } from "../../src/shared/search/runner";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

/** A machine that answers a search from memory: the command's output as given (or never, or a failure), and reads of in-memory files. */
export class SearchFakeRemote implements SearchRemote {
  readonly commands: RemoteCommand[] = [];
  cancelledRuns = 0;
  readonly reads: { path: string; offset: number; maxBytes: number }[] = [];
  readsInFlight = 0;
  mostReadsAtOnce = 0;

  constructor(
    private readonly output: string,
    private readonly options: { hang?: boolean; failure?: Error; files?: Record<string, Uint8Array>; readDelayMs?: number } = {},
  ) {}

  run(command: RemoteCommand, maxOutputBytes: number, signal?: AbortSignal): Promise<{ bytes: Uint8Array; truncated: boolean }> {
    this.commands.push(command);
    if (this.options.failure !== undefined) return Promise.reject(this.options.failure);
    if (this.options.hang === true) {
      return new Promise((_, reject) => {
        signal?.addEventListener("abort", () => {
          this.cancelledRuns += 1;
          reject(new Error("closed"));
        });
      });
    }
    const collector = new OutputCollector(maxOutputBytes);
    collector.append(bytes(this.output));
    return Promise.resolve(collector.output);
  }

  async read(file: string, offset: number, maxBytes: number): Promise<Uint8Array> {
    this.reads.push({ path: file, offset, maxBytes });
    this.readsInFlight += 1;
    this.mostReadsAtOnce = Math.max(this.mostReadsAtOnce, this.readsInFlight);
    try {
      if ((this.options.readDelayMs ?? 0) > 0) await new Promise((resolve) => setTimeout(resolve, this.options.readDelayMs));
      const data = this.options.files?.[file];
      if (data === undefined) throw new Error(`no such file: ${file}`);
      return data.slice(offset, Math.min(data.length, offset + maxBytes));
    } finally {
      this.readsInFlight -= 1;
    }
  }
}

/** The run's updates until one passes `done` (or it ends). */
export function until(run: SearchRun, done: (update: SearchUpdate) => boolean, timeoutMs = 5_000): Promise<SearchUpdate> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no such update")), timeoutMs);
    const off = run.onUpdate((update) => {
      if (!done(update)) return;
      clearTimeout(timer);
      queueMicrotask(() => off());
      resolve(update);
    });
    run.start();
  });
}


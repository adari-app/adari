// When the user last looked at each machine (CompanionAwaySinceStore in the Swift
// app): seconds since 1970 per saved machine id, in a small JSON file in the
// app's data folder. At most 64 machines (the most recent kept). A file that
// does not read is an empty store (the first look then covers 12 hours).

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export const maxSinceEntries = 64;

export interface SinceStore {
  get(hostId: string): number | null;
  set(hostId: string, seconds: number): void;
}

/** The store in memory (tests, and demo runs: a demo's looks are never kept). */
export class MemorySinceStore implements SinceStore {
  readonly entries = new Map<string, number>();

  get(hostId: string): number | null {
    return this.entries.get(hostId) ?? null;
  }

  set(hostId: string, seconds: number): void {
    this.entries.delete(hostId);
    this.entries.set(hostId, seconds);
    while (this.entries.size > maxSinceEntries) this.entries.delete(this.entries.keys().next().value!);
  }
}

export class FileSinceStore implements SinceStore {
  private readonly memory = new MemorySinceStore();

  constructor(private readonly file: string) {
    try {
      const saved: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (typeof saved === "object" && saved !== null && !Array.isArray(saved)) {
        const entries = Object.entries(saved as Record<string, unknown>)
          .filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]))
          .sort((a, b) => a[1] - b[1]);
        for (const [hostId, seconds] of entries) this.memory.set(hostId, seconds);
      }
    } catch {
      // No file yet, or one that does not read: nothing is known.
    }
  }

  get(hostId: string): number | null {
    return this.memory.get(hostId);
  }

  set(hostId: string, seconds: number): void {
    this.memory.set(hostId, seconds);
    const out: Record<string, number> = {};
    for (const [key, value] of this.memory.entries) out[key] = value;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const next = this.file + ".tmp";
      writeFileSync(next, JSON.stringify(out), { mode: 0o600 });
      renameSync(next, this.file);
    } catch {
      // Kept in memory for this run.
    }
  }
}

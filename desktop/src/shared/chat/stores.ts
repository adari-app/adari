// The store registry. Every agent whose session Chat reads from a store (a database, or one
// document rewritten in place) instead of appended lines is one entry here: the formats it serves, the view
// paths it owns, and how a reader makes its view (a JSONL file the feed follows, TranscriptStoreReading).
// The feed asks `isStoreFormat(format)` where it asked `format === "cursor"` (a store's view is never watched,
// never read with its identity or with runs left out, and is read again from its end when its revision moves);
// the SSH reader hands a store path's size, read, revision and context to its entry's view (`StoreViews`, each
// made on first use). A new store format is one entry here and nothing else in those two files.

import { CursorStoreView, isCursorStorePath, type CursorQuery, type CursorStamp, type NotFound, type TranscriptStoreReading } from "./cursor-store";
import type { TranscriptFormat } from "./parser";
import { isOpenCodeViewPath } from "./agents/opencode-locate";
import { OpenCodeStoreView } from "./agents/opencode-store";
import { isHermesViewPath } from "./agents/hermes-locate";
import { HermesStoreView } from "./agents/hermes-store";
import { isMastraViewPath } from "./agents/mastra-locate";
import { MastraStoreView } from "./agents/mastra-store";
import { isClineMessagesPath } from "./agents/cline-locate";
import { ClineStoreView, type ClineFileRead } from "./agents/cline-store";

/** What a reader gives a store's view: read-only queries (a bounded exec), file stamps (size and time), its not-found error, and its own file read. */
export interface StoreIO {
  readonly query: CursorQuery;
  readonly stamp: CursorStamp;
  readonly notFound: NotFound;
  readonly readFile: ClineFileRead;
}

/** A store's view: the JSONL a feed follows, with its revision. */
export interface StoreView extends TranscriptStoreReading {
  size(path: string): Promise<number>;
  read(path: string, offset: number, maxBytes: number): Promise<Uint8Array>;
}

export interface StoreEntry {
  readonly name: string;
  readonly formats: readonly TranscriptFormat[];
  /** Whether `path` is one of this store's view paths. */
  readonly owns: (path: string) => boolean;
  /** What the reader says while it runs this store's queries. */
  readonly activity: string;
  readonly make: (io: StoreIO) => StoreView;
}

export const storeEntries: readonly StoreEntry[] = [
  // A Cursor chat's store.db (cursor-store.ts).
  { name: "cursor", formats: ["cursor"], owns: isCursorStorePath, activity: "Reading the Cursor chat", make: (io) => new CursorStoreView(io.query, io.stamp, io.notFound) },
  // OpenCode's and Kilo's SQLite store (agents/opencode-store.ts).
  { name: "opencode", formats: ["opencode", "kilo"], owns: isOpenCodeViewPath, activity: "Reading the OpenCode session", make: (io) => new OpenCodeStoreView(io.query, io.stamp, io.notFound) },
  // Hermes's state.db (agents/hermes-store.ts).
  { name: "hermes", formats: ["hermes"], owns: isHermesViewPath, activity: "Reading the Hermes session", make: (io) => new HermesStoreView(io.query, io.stamp, io.notFound) },
  // Mastra Code's mastra.db (agents/mastra-store.ts).
  { name: "mastracode", formats: ["mastracode"], owns: isMastraViewPath, activity: "Reading the Mastra Code thread", make: (io) => new MastraStoreView(io.query, io.stamp, io.notFound) },
  // Cline's messages.json, read whole (agents/cline-store.ts).
  { name: "cline", formats: ["cline"], owns: isClineMessagesPath, activity: "Reading the Cline session", make: (io) => new ClineStoreView(io.stamp, io.readFile, io.notFound) },
];

/** Whether a format's sessions are read from a store (its view), not from appended lines. */
export const isStoreFormat = (format: string | null | undefined): boolean =>
  format !== null && format !== undefined && storeEntries.some((entry) => (entry.formats as readonly string[]).includes(format));

/** The store that owns `path` (a view path), or null. */
export const storeEntryOf = (path: string): StoreEntry | null => storeEntries.find((entry) => entry.owns(path)) ?? null;

export const isStorePath = (path: string): boolean => storeEntryOf(path) !== null;

/** One reader's store views, each made on first use. */
export class StoreViews {
  private readonly made = new Map<string, StoreView>();

  constructor(private readonly io: (entry: StoreEntry) => StoreIO) {}

  /** The view that reads `path`; null for a path no store owns. */
  of(path: string): StoreView | null {
    const entry = storeEntryOf(path);
    if (entry === null) return null;
    let view = this.made.get(entry.name);
    if (view === undefined) {
      view = entry.make(this.io(entry));
      this.made.set(entry.name, view);
    }
    return view;
  }
}

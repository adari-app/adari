// Builds Cursor stores for the desktop tests with /usr/bin/sqlite3 from
// desktop/fixtures/chat/cursor-store.json (shared with HerdrKit's CursorStoreSupport.swift): each
// root entry is a blob's exact text (`json`, `raw`), a non-JSON blob (`proto`, hex) or a ref the
// store does not hold (`missing`); a blob's id is the sha256 of its bytes. Stores go under the
// test scratch folder (HERDR_TEST_SCRATCH, else the system's temporary folder).

import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { CursorStoreView, cursorFolderHash, cursorHexBytes } from "../../src/shared/chat/cursor-store";
import { TranscriptNotFoundError, type TranscriptFileReader } from "../../src/shared/chat/feed";
import type { TranscriptSessionRef } from "../../src/shared/chat/locator";
import { fixturesRoot } from "./swift-fixtures";

interface Entry {
  readonly json?: string;
  readonly raw?: string;
  readonly proto?: string;
  readonly missing?: string;
}

interface Spec {
  readonly chatID: string;
  readonly cwd: string;
  readonly meta: Record<string, unknown>;
  readonly metaJSON: Record<string, unknown>;
  readonly context: { readonly used: number; readonly window: number };
  readonly root: readonly Entry[];
  readonly extra: readonly Entry[];
}

export const cursorSpec = JSON.parse(readFileSync(path.join(fixturesRoot, "chat/cursor-store.json"), "utf8")) as Spec;
export const fixtureKey = String(cursorSpec.meta["blobEncryptionKey"]);

export interface Blob {
  readonly id: string;
  readonly bytes: Uint8Array | null;
}

export const sha256 = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

export function blobsOf(entries: readonly Entry[], salt = ""): Blob[] {
  return entries.map((entry, index) => {
    const text = entry.json ?? entry.raw;
    if (text !== undefined) {
      const bytes = new TextEncoder().encode(text);
      return { id: sha256(bytes), bytes };
    }
    if (entry.proto !== undefined) {
      const bytes = cursorHexBytes(entry.proto)!;
      return { id: sha256(bytes), bytes };
    }
    return { id: sha256(`missing:${salt}${index}`), bytes: null };
  });
}

function varint(value: number): number[] {
  const out: number[] = [];
  let rest = value;
  do {
    let byte = rest & 0x7f;
    rest = Math.floor(rest / 128);
    if (rest !== 0) byte |= 0x80;
    out.push(byte);
  } while (rest !== 0);
  return out;
}

/** A root: field 1 per ref, then field 5 (used, window, a nested part), field 8 a ref, and a few small fields (CursorFixture.root). */
export function rootBytes(refs: readonly string[], used: number | null = null, window: number | null = null): Uint8Array {
  const bytes: number[] = [];
  for (const ref of refs) bytes.push(0x0a, 0x20, ...cursorHexBytes(ref)!);
  if (used !== null && window !== null) {
    const nested = [0x0a, 0x05, ...new TextEncoder().encode("tools"), 0x18, 0x07];
    const context = [0x08, ...varint(used), 0x10, ...varint(window), 0x1a, ...varint(nested.length), ...nested];
    bytes.push(0x2a, ...varint(context.length), ...context);
  }
  bytes.push(0x42, 0x20, ...Array.from({ length: 32 }, () => 0xab));
  bytes.push(0x4a, 0x03, ...new TextEncoder().encode("abc"), 0x50, 0x01);
  return Uint8Array.from(bytes);
}

const scratch = realpathSync(process.env["HERDR_TEST_SCRATCH"] || os.tmpdir());

export function newHome(name: string): string {
  return mkdtempSync(path.join(scratch, `hc-cursor-${name}-`));
}

export const chatFolder = (home: string, cwd = cursorSpec.cwd, chatID = cursorSpec.chatID): string =>
  path.join(home, ".cursor", "chats", cursorFolderHash(cwd), chatID);

export function sqlite(db: string, sql: string): void {
  execFileSync("/usr/bin/sqlite3", ["-init", "/dev/null", "-batch", db], { input: sql, stdio: ["pipe", "ignore", "pipe"] });
}

const sortedJSON = (value: Record<string, unknown>): string =>
  JSON.stringify(Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]])));

/** Writes a store (WAL mode) with `blobs` and a root listing `refs`, its meta row pointing at it. */
export function writeStore(db: string, blobs: readonly Blob[], refs: readonly string[], options: { used?: number; window?: number; fresh?: boolean } = {}): string {
  const root = rootBytes(refs, options.used ?? null, options.window ?? null);
  const rootID = sha256(root);
  const meta = sortedJSON({ ...cursorSpec.meta, latestRootBlobId: rootID });
  let sql =
    options.fresh === false
      ? ""
      : "pragma journal_mode=wal;\ncreate table if not exists blobs (id text primary key, data blob);\ncreate table if not exists meta (key text primary key, value text);\n";
  sql += "begin;\n";
  for (const blob of blobs) if (blob.bytes !== null) sql += `insert or ignore into blobs values ('${blob.id}', x'${hex(blob.bytes)}');\n`;
  sql += `insert or ignore into blobs values ('${rootID}', x'${hex(root)}');\n`;
  sql += `insert or replace into meta values ('0', '${Buffer.from(meta, "utf8").toString("hex")}');\ncommit;\n`;
  mkdirSync(path.dirname(db), { recursive: true });
  sqlite(db, sql);
  return rootID;
}

/** Adds blobs without moving the root (a message being written). */
export function insertBlobs(db: string, blobs: readonly Blob[]): void {
  let sql = "begin;\n";
  for (const blob of blobs) if (blob.bytes !== null) sql += `insert or ignore into blobs values ('${blob.id}', x'${hex(blob.bytes)}');\n`;
  sqlite(db, sql + "commit;\n");
}

/** The fixture's store and meta.json in `home`. */
export function makeStore(home: string): { store: string; blobs: Blob[] } {
  const folder = chatFolder(home);
  const store = path.join(folder, "store.db");
  const blobs = blobsOf(cursorSpec.root);
  writeStore(store, [...blobs, ...blobsOf(cursorSpec.extra, "extra")], blobs.map((blob) => blob.id), cursorSpec.context);
  writeFileSync(path.join(folder, "meta.json"), sortedJSON(cursorSpec.metaJSON));
  return { store, blobs };
}

/** Runs a command under /bin/sh here, its stdout up to `maxOutputBytes`. */
export function runHere(command: string, maxOutputBytes: number): string {
  const result = spawnSync("/bin/sh", ["-c", command], { maxBuffer: Math.max(maxOutputBytes, 1_024) * 2 });
  return (result.stdout ?? Buffer.alloc(0)).subarray(0, maxOutputBytes).toString("utf8");
}

/** A Mac's files and Cursor stores read here: commands run under /bin/sh (as over SSH), files read from disk. */
export class LocalCursorReader implements TranscriptFileReader<TranscriptSessionRef> {
  readonly commands: string[] = [];
  readonly view: CursorStoreView;

  constructor(private readonly located: string | null) {
    this.view = new CursorStoreView(
      (command, maxOutputBytes) => {
        this.commands.push(command);
        return Promise.resolve(runHere(command, maxOutputBytes));
      },
      (file) => {
        try {
          const stats = statSync(file);
          return Promise.resolve(stats.isFile() ? `${stats.size}:${stats.mtimeMs}` : null);
        } catch {
          return Promise.resolve(null);
        }
      },
      (file) => new TranscriptNotFoundError(file),
    );
  }

  locate(): Promise<string | null> {
    return Promise.resolve(this.located);
  }

  size(file: string): Promise<number> {
    if (file.endsWith("/store.db")) return this.view.size(file);
    try {
      return Promise.resolve(statSync(file).size);
    } catch {
      return Promise.reject(new TranscriptNotFoundError(file));
    }
  }

  read(file: string, offset: number, maxBytes: number): Promise<Uint8Array> {
    if (file.endsWith("/store.db")) return this.view.read(file, offset, maxBytes);
    try {
      return Promise.resolve(Uint8Array.from(readFileSync(file).subarray(offset, offset + maxBytes)));
    } catch {
      return Promise.reject(new TranscriptNotFoundError(file));
    }
  }

  storeRevision(file: string): Promise<number> {
    return this.view.storeRevision(file);
  }

  storeContext(file: string): ReturnType<CursorStoreView["storeContext"]> {
    return this.view.storeContext(file);
  }
}

// A Cline session's document read whole, as the JSONL file the other readers follow
// (agents/store-lines.ts).
//
// Cline rewrites `<id>.messages.json` in place on every persist: `JSON.stringify(payload, null, 2)` then
// `writeFileSync(path, …)` (cline sdk/packages/core/src/session/stores/session-manifest-store.ts:220-238), the
// payload `{version: 1, updated_at, agent, sessionId, messages: [{id, role, content: [blocks], ts, modelInfo,
// metrics}], system_prompt}` (sdk/packages/core/docs/messages-contract-v1.md; services/session-data.ts:334-359).
// It is one JSON document, not lines, so the view reads it whole: at most `maxDocumentBytes` (4 MiB, the
// relay's read frame; a larger one is refused, one line the parser marks unknown), through the transcript
// reader's own read (SFTP or the relay, their bounds), and again only when its size or modification time
// changed, or while that stamp is young (`youngMs` after it was first seen: SFTP's times are whole seconds, so
// a rewrite of the same size in the same second keeps the stamp). A read that the writer overlapped (the size or time moved, or the text is not JSON yet) waits for
// the next poll; one that stays not JSON is a line the parser marks malformed.
//
// The view is one line per message, `{"cl":1,"i":<index>,"cwd":<folder>,"d":{id, role, content, ts}}` (the
// model and token counts left out: they are added to a turn's last message when it ends, and would rewrite a
// line already read). A message already laid out that changed moves the view to a new revision (the feed
// starts over). `cwd` is the document's own folder when it names one, else its manifest's (`<id>.json`,
// local-runtime-host.ts:596, :617): the feed's folder check, so a session of another folder is never shown; a
// session whose folder cannot be read (no manifest naming it) is not shown at all.

import type { CursorStamp, NotFound } from "../cursor-store";
import { parseClineMessagesPath, type ClineMessagesPath } from "./cline-locate";
import { StoreGoneError, storeFolder, StoreLinesView, type StoreLine, type StoreLinesSource } from "./store-lines";

/** Reads up to `maxBytes` of a file from `offset` (the transcript reader's own read). */
export type ClineFileRead = (path: string, offset: number, maxBytes: number) => Promise<Uint8Array>;

/** The largest document read (a relay read frame's 4 MiB). */
export const clineMaxDocumentBytes = 4 * 1_024 * 1_024;
/** The largest manifest read. */
export const clineMaxManifestBytes = 64 * 1_024;

export interface ClineState {
  /** The document's stamp the lines were laid out from. */
  stamp: string | null;
  /** When that stamp was first seen (this side's clock). */
  seenAt: number;
  /** A read that was not JSON: its stamp and when, so one that stays so is said once it settled. */
  failed: { readonly stamp: string; readonly at: number } | null;
  shown: "lines" | "tooLarge" | "malformed" | "version" | null;
  texts: Map<string, Uint8Array>;
}

export const clinePlaceholder = (why: string): string => `{"cl":1,"k":"bad","bad":"${why}"}`;

/** FNV-1a over a line's bytes: with its length, what it shows. */
const fnv = (bytes: Uint8Array): string => {
  let hash = 0x811c9dc5;
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  return hash.toString(16);
};

const encoder = new TextEncoder();

const stampSize = (stamp: string): number | null => {
  const size = Number(stamp.split(":")[0]);
  return Number.isSafeInteger(size) && size >= 0 ? size : null;
};

export class ClineStoreSource implements StoreLinesSource<ClineMessagesPath, ClineState> {
  /** A document still not JSON this long after it was first read so (and not changed since) is malformed. */
  static readonly settleMs = 1_500;
  /**
   * A stamp first seen this recently is read again on each refresh: a stamp's time may be whole seconds (SFTP),
   * and a same-size rewrite within that second keeps it. Every such rewrite is before the stamp was first seen
   * plus a second; the view refreshes every `StoreLinesView.pollMs` (900 ms), so two more reads cover it.
   */
  static readonly youngMs = 2_500;

  constructor(
    private readonly stamp: CursorStamp,
    private readonly readFile: ClineFileRead,
    private readonly now: () => number = () => Date.now(),
  ) {}

  parse(path: string): ClineMessagesPath | null {
    return parseClineMessagesPath(path);
  }

  stamped(view: ClineMessagesPath): readonly string[] {
    return [view.path, view.manifest];
  }

  fresh(): ClineState {
    return { stamp: null, seenAt: 0, failed: null, shown: null, texts: new Map() };
  }

  private note(state: ClineState, shown: "tooLarge" | "malformed" | "version", head: string): readonly StoreLine[] | null {
    if (state.shown === shown) return null;
    state.shown = shown;
    state.texts.clear();
    return [{ key: shown, identity: shown, head, dataBytes: -1, firstByte: null }];
  }

  async lines(view: ClineMessagesPath, state: ClineState, force: boolean): Promise<readonly StoreLine[] | null> {
    const stamp = await this.stamp(view.path);
    if (stamp === null) throw new StoreGoneError();
    const size = stampSize(stamp);
    if (size === null) return null;
    if (size > clineMaxDocumentBytes) {
      state.stamp = stamp;
      return this.note(state, "tooLarge", clinePlaceholder("tooLarge"));
    }
    if (!force && stamp === state.stamp && this.now() - state.seenAt >= ClineStoreSource.youngMs) return null;
    const bytes = size === 0 ? new Uint8Array(0) : await this.readFile(view.path, 0, size);
    // Written while it was read: the next poll reads it again.
    if (bytes.length !== size || (await this.stamp(view.path)) !== stamp) return null;
    let document: unknown;
    try {
      document = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      const time = this.now();
      if (state.failed === null || state.failed.stamp !== stamp) {
        state.failed = { stamp, at: time };
        return null;
      }
      if (time - state.failed.at < ClineStoreSource.settleMs) return null;
      this.keepStamp(state, stamp);
      return this.note(state, "malformed", clinePlaceholder("malformed"));
    }
    state.failed = null;
    this.keepStamp(state, stamp);
    const object = document !== null && typeof document === "object" && !Array.isArray(document) ? (document as Record<string, unknown>) : null;
    const messages = object?.messages;
    if (object === null || object.version !== 1 || !Array.isArray(messages)) {
      const version = object === null ? (Array.isArray(document) ? "array" : typeof document) : JSON.stringify(object.version ?? null);
      return this.note(state, "version", `{"cl":1,"k":"version","v":${JSON.stringify(version)}}`);
    }
    const folder = await this.folder(view, object);
    if (folder === null) throw new StoreGoneError();
    const cwd = JSON.stringify(folder);
    const texts = new Map<string, Uint8Array>();
    const lines: StoreLine[] = messages.map((message, index) => {
      const shown =
        message !== null && typeof message === "object" && !Array.isArray(message)
          ? { id: (message as Record<string, unknown>).id, role: (message as Record<string, unknown>).role, content: (message as Record<string, unknown>).content, ts: (message as Record<string, unknown>).ts }
          : message;
      const data = encoder.encode(JSON.stringify(shown) ?? "null");
      const key = `c:${index}`;
      texts.set(key, data);
      return { key, identity: `${key}:${data.length}:${fnv(data)}`, head: `{"cl":1,"i":${index},"cwd":${cwd},"d":`, dataBytes: data.length, firstByte: data[0] ?? null };
    });
    state.shown = "lines";
    state.texts = texts;
    return lines;
  }

  /** The stamp the lines are laid out from, and when it was first seen. */
  private keepStamp(state: ClineState, stamp: string): void {
    if (state.stamp !== stamp) state.seenAt = this.now();
    state.stamp = stamp;
  }

  /** The document's own folder when it names one, else its manifest's (`cwd`, the session id its own); null when neither does. */
  private async folder(view: ClineMessagesPath, document: Record<string, unknown>): Promise<string | null> {
    const own = typeof document.cwd === "string" ? storeFolder(document.cwd) : null;
    if (own !== null) return own;
    let bytes: Uint8Array;
    try {
      bytes = await this.readFile(view.manifest, 0, clineMaxManifestBytes);
    } catch {
      return null;
    }
    let manifest: unknown;
    try {
      manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      return null;
    }
    if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) return null;
    const fields = manifest as Record<string, unknown>;
    if (typeof fields.session_id === "string" && fields.session_id !== view.session) return null;
    return typeof fields.cwd === "string" ? storeFolder(fields.cwd) : null;
  }

  data(_view: ClineMessagesPath, state: ClineState, lines: readonly StoreLine[]): Promise<Map<string, Uint8Array>> {
    const out = new Map<string, Uint8Array>();
    for (const line of lines) {
      const text = state.texts.get(line.key);
      if (text !== undefined) out.set(line.key, text);
    }
    return Promise.resolve(out);
  }

  placeholder(why: "notJSON" | "oversized" | "changed"): string {
    return clinePlaceholder(why);
  }
}

/** Cline sessions as JSONL views: the store-lines view over ClineStoreSource. */
export class ClineStoreView extends StoreLinesView<ClineMessagesPath, ClineState> {
  constructor(stamp: CursorStamp, readFile: ClineFileRead, notFound: NotFound, now?: () => number) {
    super(new ClineStoreSource(stamp, readFile, now), stamp, notFound, now);
  }
}

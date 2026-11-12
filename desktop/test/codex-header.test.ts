// Never another folder's transcript.
// When Herdr names a Codex session for a pane, Chat reads the session's own
// header first (the rollout's first line, `session_meta` with `id` and `cwd`,
// within the feed's bounds) and shows nothing of it when its folder is not the
// pane's: "Herdr names a Codex session from another folder (<its folder>) …".
// A Codex pane with no session says what to do (send a first
// message, then the shared background server case); other kinds keep their line. Fake rollout files with invented ids and folders only.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ChatUnavailableLine, chatUnavailableLine } from "../src/renderer/chat/ChatView";
import { codexHeaderFirstBytes, codexHeaderOfLine, codexHeaderVerdict, codexNoDaemonFlag, codexNoSessionText, codexOtherFolderText, readCodexHeader, type CodexHeader } from "../src/shared/chat/codex-header";
import { ChatFeed, type ChatFeedUpdate } from "../src/shared/chat/feed";
import { makeSessionRef, type TranscriptSessionRef } from "../src/shared/chat/locator";
import { turnUserMessage } from "../src/shared/chat/model";
import { eventually, FakeTranscriptReader, ReadFailure } from "./support/chat-lines";

const id = "8e3b1f02-6a4c-4d9e-a7b5-1c2d3e4f5a6b";
const otherId = "2a9c7e14-3b5d-4f6a-8c9e-0b1a2c3d4e5f";
const path = `/Users/invented/.codex/sessions/2026/11/10/rollout-2026-11-10T09-00-00-${id}.jsonl`;
const ownFolder = "/Users/invented/code/lantern";
const otherFolder = "/Users/invented/code/harbor";
const session: TranscriptSessionRef = makeSessionRef("codex", { kind: "id", id })!;

const encode = (text: string) => new TextEncoder().encode(text);
const meta = (payload: Record<string, unknown>): string =>
  JSON.stringify({ timestamp: "2026-11-10T09:00:00.000Z", type: "session_meta", payload: { timestamp: "2026-11-10T09:00:00.000Z", originator: "codex-tui", cli_version: "0.167.0", source: "cli", ...payload } });
const userLine = (text: string, ordinal: number): string =>
  JSON.stringify({ timestamp: "2026-11-10T09:00:01.000Z", type: "response_item", payload: { type: "message", role: "user", id: `m${ordinal}`, content: [{ type: "input_text", text }] } });
const rollout = (header: string | null, ...asks: string[]): string => [...(header === null ? [] : [header]), ...asks.map((ask, index) => userLine(ask, index))].join("\n") + "\n";

/** Reads `bytes` as the reader would (fewer at the end), each read recorded. */
function bytesReader(bytes: Uint8Array, reads: [number, number][] = []) {
  return (offset: number, maxBytes: number): Promise<Uint8Array> => {
    reads.push([offset, maxBytes]);
    return Promise.resolve(bytes.slice(offset, Math.min(bytes.length, offset + maxBytes)));
  };
}

describe("the rollout's header, read within the feed's bounds", () => {
  it("a session_meta line gives its id and cwd", async () => {
    expect(await readCodexHeader(bytesReader(encode(rollout(meta({ id, cwd: ownFolder }), "hello"))))).toEqual({ kind: "header", id, cwd: ownFolder });
  });

  it("a header without cwd, or with an empty one, gives none", async () => {
    expect(await readCodexHeader(bytesReader(encode(rollout(meta({ id }), "hello"))))).toEqual({ kind: "header", id, cwd: null });
    expect(await readCodexHeader(bytesReader(encode(rollout(meta({ id, cwd: "" }), "hello"))))).toEqual({ kind: "header", id, cwd: null });
    expect(codexHeaderOfLine(encode('{"type":"session_meta","payload":"not an object"}'))).toEqual({ kind: "header", id: null, cwd: null });
  });

  it("no header: a first line of another type, not JSON, or not UTF-8", async () => {
    expect(await readCodexHeader(bytesReader(encode(rollout(null, "hello"))))).toEqual({ kind: "none" });
    expect(await readCodexHeader(bytesReader(encode("not json\n" + meta({ id, cwd: ownFolder }) + "\n")))).toEqual({ kind: "none" });
    expect(codexHeaderOfLine(new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]))).toEqual({ kind: "none" });
    expect(codexHeaderOfLine(encode("[1,2]"))).toEqual({ kind: "none" });
  });

  it("an empty file, or a first line still being written, is pending", async () => {
    expect(await readCodexHeader(bytesReader(new Uint8Array(0)))).toEqual({ kind: "pending" });
    expect(await readCodexHeader(bytesReader(encode(meta({ id, cwd: ownFolder }).slice(0, 80))))).toEqual({ kind: "pending" });
  });

  it("a header longer than the first read is read on, from where the first stopped", async () => {
    const reads: [number, number][] = [];
    const long = meta({ id, cwd: ownFolder, base_instructions: { text: "x".repeat(200 * 1_024) } });
    expect(await readCodexHeader(bytesReader(encode(rollout(long, "hello")), reads))).toEqual({ kind: "header", id, cwd: ownFolder });
    expect(reads[0]).toEqual([0, codexHeaderFirstBytes]);
    expect(reads[1]?.[0]).toBe(codexHeaderFirstBytes);
    expect(reads.length).toBe(2);
  });

  it("a read that fails throws (the feed says the file could not be read)", async () => {
    await expect(readCodexHeader(() => Promise.reject(new ReadFailure()))).rejects.toBeInstanceOf(ReadFailure);
  });
});

describe("the folder check", () => {
  const header = (cwd: string | null, headerId: string | null = id): CodexHeader => ({ kind: "header", id: headerId, cwd });
  it("the same folder, a trailing slash either side, the foreground folder: its own", () => {
    expect(codexHeaderVerdict(header(ownFolder), [ownFolder], id)).toEqual({ kind: "own" });
    expect(codexHeaderVerdict(header(`${ownFolder}/`), [ownFolder], id)).toEqual({ kind: "own" });
    expect(codexHeaderVerdict(header(ownFolder), [`${ownFolder}//`], id)).toEqual({ kind: "own" });
    expect(codexHeaderVerdict(header(ownFolder), [otherFolder, ownFolder], id)).toEqual({ kind: "own" });
  });

  it("another folder (a sibling, or one sharing a prefix): that folder, trailing slash dropped", () => {
    expect(codexHeaderVerdict(header(otherFolder), [ownFolder], id)).toEqual({ kind: "otherFolder", folder: otherFolder });
    expect(codexHeaderVerdict(header(`${otherFolder}/`), [ownFolder], id)).toEqual({ kind: "otherFolder", folder: otherFolder });
    expect(codexHeaderVerdict(header(`${ownFolder}-old`), [ownFolder], id)).toEqual({ kind: "otherFolder", folder: `${ownFolder}-old` });
  });

  it("a header missing, unreadable as a header, or without cwd: not proven, not shown", () => {
    expect(codexHeaderVerdict({ kind: "none" }, [ownFolder], id)).toEqual({ kind: "unproven" });
    expect(codexHeaderVerdict(header(null), [ownFolder], id)).toEqual({ kind: "unproven" });
  });

  it("another session's id is never this one", () => {
    expect(codexHeaderVerdict(header(ownFolder, otherId), [ownFolder], id)).toEqual({ kind: "otherSession" });
    expect(codexHeaderVerdict(header(ownFolder, id.toUpperCase()), [ownFolder], id)).toEqual({ kind: "own" });
    expect(codexHeaderVerdict(header(ownFolder, null), [ownFolder], id)).toEqual({ kind: "own" });
  });

  it("without a pane folder there is nothing to compare: as before", () => {
    expect(codexHeaderVerdict(header(otherFolder), [], id)).toEqual({ kind: "own" });
    expect(codexHeaderVerdict({ kind: "none" }, [""], id)).toEqual({ kind: "own" });
  });
});

/** The feed over `content` at the rollout's path, started for `folders`; every published update kept. */
function follow(content: string | Uint8Array, folders: readonly string[], reader = new FakeTranscriptReader()) {
  if (typeof content === "string") reader.put(path, content, path);
  else {
    reader.put(path, "", path);
    reader.appendBytes(path, content);
  }
  const feed = new ChatFeed(reader, { pollIntervalMs: 5 });
  const updates: ChatFeedUpdate[] = [];
  feed.subscribe((update) => updates.push(update));
  feed.start(session, folders);
  return { feed, updates, reader };
}
const firstAsk = (feed: ChatFeed<TranscriptSessionRef>): string | null => {
  const turn = feed.timeline.turns[0];
  return turn === undefined ? null : (turnUserMessage(turn)?.text ?? null);
};

describe("the feed checks a Codex session's header before anything shows", () => {
  it("the pane's own folder (and with a trailing slash): shown", async () => {
    for (const folders of [[ownFolder], [`${ownFolder}/`]]) {
      const { feed } = follow(rollout(meta({ id, cwd: ownFolder }), "Plan the lantern release"), folders);
      expect(await eventually(() => firstAsk(feed) === "Plan the lantern release", 5_000), JSON.stringify(folders)).toBe(true);
      expect(feed.state.status).toBe("live");
      feed.stop();
    }
  });

  it("another folder's: unavailable with that folder, never live, nothing of it published", async () => {
    const { feed, updates } = follow(rollout(meta({ id, cwd: otherFolder }), "Harbor's secret plan"), [ownFolder]);
    expect(await eventually(() => feed.state.status === "unavailable", 5_000)).toBe(true);
    expect(feed.state).toEqual({ status: "unavailable", reason: "codexOtherFolder", folder: otherFolder });
    expect(updates.some((update) => update.state.status === "live")).toBe(false);
    expect(updates.every((update) => update.timeline.turns.length === 0)).toBe(true);
    feed.stop();
  });

  it("a long rollout whose tail has no header: still another folder's, before the tail is read", async () => {
    const filler = "z".repeat(4_000);
    const asks = Array.from({ length: 1_500 }, (_, index) => `ask ${index} ${filler}`);
    const { feed, updates, reader } = follow(rollout(meta({ id, cwd: otherFolder }), ...asks), [ownFolder]);
    expect(await eventually(() => feed.state.status === "unavailable", 5_000)).toBe(true);
    expect(feed.state).toEqual({ status: "unavailable", reason: "codexOtherFolder", folder: otherFolder });
    expect(updates.some((update) => update.state.status === "live")).toBe(false);
    expect(reader.calls.filter((call) => call.startsWith("read ")), "only the head was read").toEqual([`read 0 ${codexHeaderFirstBytes}`]);
    feed.stop();
  });

  it("no header, or a header without cwd: not shown", async () => {
    for (const content of [rollout(null, "no header here"), rollout(meta({ id }), "no folder here")]) {
      const { feed, updates } = follow(content, [ownFolder]);
      expect(await eventually(() => feed.state.status === "unavailable", 5_000)).toBe(true);
      expect(feed.state).toEqual({ status: "unavailable", reason: "unrecognisedFormat" });
      expect(updates.every((update) => update.timeline.turns.length === 0)).toBe(true);
      feed.stop();
    }
  });

  it("another session's header at this id's path: a mismatch", async () => {
    const { feed } = follow(rollout(meta({ id: otherId, cwd: ownFolder }), "someone else"), [ownFolder]);
    expect(await eventually(() => feed.state.status === "unavailable", 5_000)).toBe(true);
    expect(feed.state).toEqual({ status: "unavailable", reason: "sessionMismatch" });
    feed.stop();
  });

  it("a header that cannot be read: unreadable; a file gone since it was located: not found", async () => {
    class FailingReader extends FakeTranscriptReader {
      override read(): Promise<Uint8Array> {
        return Promise.reject(new ReadFailure());
      }
    }
    const failing = follow(rollout(meta({ id, cwd: ownFolder }), "hello"), [ownFolder], new FailingReader());
    expect(await eventually(() => failing.feed.state.status === "unavailable", 5_000)).toBe(true);
    expect(failing.feed.state).toEqual({ status: "unavailable", reason: "unreadable" });
    failing.feed.stop();
    const gone = new FakeTranscriptReader();
    gone.setLocated(path);
    const feed = new ChatFeed(gone, { pollIntervalMs: 5 });
    feed.start(session, [ownFolder]);
    expect(await eventually(() => feed.state.status === "unavailable", 5_000)).toBe(true);
    expect(feed.state).toEqual({ status: "unavailable", reason: "notFound" });
    feed.stop();
  });

  it("an empty rollout waits for its header, then shows once it is the pane's", async () => {
    const { feed, reader, updates } = follow("", [ownFolder]);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(feed.state.status).not.toBe("unavailable");
    expect(updates.some((update) => update.state.status === "live")).toBe(false);
    reader.append(path, rollout(meta({ id, cwd: ownFolder }), "Now it starts"));
    expect(await eventually(() => firstAsk(feed) === "Now it starts", 5_000)).toBe(true);
    feed.stop();
  });
});

describe("Chat's lines", () => {
  it("another folder's Codex session names that folder, with what to do", () => {
    const line = chatUnavailableLine({ status: "unavailable", reason: "codexOtherFolder", folder: otherFolder }, "codex");
    expect(line).toBe(`Herdr names a Codex session from another folder (${otherFolder}) for this agent, so it is not shown. Restart Codex from Adari to give it its own.`);
    expect(line).toBe(codexOtherFolderText(otherFolder));
  });

  it("a Codex pane with no session adds why, for Codex only", () => {
    const base = "Herdr names no session for this agent yet, so there is no transcript to show.";
    const said =
      "Codex tells Herdr its session with its first message: send one and Chat shows the conversation. If Chat is still empty after Codex replies, this Codex was started without --no-daemon and reports to another pane: use Restart in the pane's More menu.";
    expect(codexNoSessionText).toBe(said);
    expect(chatUnavailableLine({ status: "unavailable", reason: "noSession" }, "codex")).toBe(`${base} ${said}`);
    expect(chatUnavailableLine({ status: "unavailable", reason: "noSession" }, "Codex")).toBe(`${base} ${said}`);
    for (const kind of ["claude", "grok", "cursor", "pi", undefined, null]) {
      expect(chatUnavailableLine({ status: "unavailable", reason: "noSession" }, kind), String(kind)).toBe(base);
    }
    // Other reasons keep their lines for Codex too.
    expect(chatUnavailableLine({ status: "unavailable", reason: "notFound" }, "codex")).toBe("No transcript was found for this agent's session.");
    expect(chatUnavailableLine({ status: "unavailable", reason: "sessionMismatch" }, "codex")).toBe("The session Herdr gave this pane belongs to another folder, so it is not shown.");
  });

  // The first step (a first message) before the shared-server case, and --no-daemon on one line.
  it("a Codex pane with no session says to send a first message first, then the daemon case, with --no-daemon kept on one line", () => {
    expect(codexNoSessionText.indexOf("send one")).toBeGreaterThanOrEqual(0);
    expect(codexNoSessionText.indexOf("send one")).toBeLessThan(codexNoSessionText.indexOf(codexNoDaemonFlag));
    expect(codexNoSessionText).not.toMatch(/background server|Restart it from Adari/);
    expect(codexNoSessionText).not.toMatch(/[\u2013\u2014]/);
    const line = chatUnavailableLine({ status: "unavailable", reason: "noSession" }, "codex");
    const html = renderToStaticMarkup(createElement(ChatUnavailableLine, { line }));
    expect(html).toBe(`<div>${line.replace("--no-daemon", '<span class="chat-nowrap">--no-daemon</span>').replace(/'/g, "&#x27;")}</div>`);
    // The flag is plain ASCII (a copied line still works) and appears only inside the no-wrap span.
    expect(html.match(/--no-daemon/g)).toHaveLength(1);
    expect(html).not.toMatch(/\u2011/);
    // A line without the flag renders as it is, with no span.
    expect(renderToStaticMarkup(createElement(ChatUnavailableLine, { line: "No transcript was found." }))).toBe("<div>No transcript was found.</div>");
    // chat.css keeps the span on one line.
    expect(readFileSync(join(__dirname, "../src/renderer/styles/chat.css"), "utf8")).toMatch(/\.chat-nowrap \{ white-space: nowrap; \}/);
  });

  it("no em dash in any new line", () => {
    for (const line of [codexOtherFolderText(otherFolder), codexNoSessionText, chatUnavailableLine({ status: "unavailable", reason: "codexOtherFolder" }, "codex")]) {
      expect(line).not.toMatch(/\u2014/);
    }
  });
});

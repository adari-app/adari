// A Kiro CLI V3 session followed in Chat: the session.json owner check before anything shows, live growth, a long
// file through the cold window and Load earlier, and the unrecognised note. The service follows nothing for a Kiro pane for 0.1.0 (as Maki); the reader stays.
// Synthetic fixtures only, from codeburn's V3 shape (getagentseal/codeburn bb952552
// tests/providers/kiro.test.ts:1095-1137) and kiro-cli-history's demo (mxmehl/kiro-cli-history f96f9f05
// demo/data/kiro/sessions/workspacehash/sess_cfbd0cbbe482/).

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ChatService, type ChatHosts, type ChatOwner } from "../src/main/chat/service";
import type { HerdrHostBackend } from "../src/main/herdr/backend";
import { ChatFeed, standardColdLoad } from "../src/shared/chat/feed";
import { chatKinds, chatReads } from "../src/shared/chat/kinds";
import { locateCommand, makeSessionRef, paneSession, parseLocateOutput, type TranscriptSessionRef } from "../src/shared/chat/locator";
import { turnToolCalls, turnUserMessage } from "../src/shared/chat/model";
import { chatUnreadLine } from "../src/shared/chat/unread";
import type { ChatUpdateEvent } from "../src/shared/ipc-contract";
import { defaultView } from "../src/shared/pane-view";
import { eventually, FakeTranscriptReader, loadAll, shown } from "./support/chat-lines";

const folder = "/Users/fixture/proj";
const dir = "/Users/fixture/.kiro/sessions/4748323122002acb/sess_test-001";
const messages = `${dir}/messages.jsonl`;
const sessionFile = `${dir}/session.json`;
const ref: TranscriptSessionRef = makeSessionRef("kiro", { kind: "folder", folder })!;
const at = "2026-11-08T10:00:00.000Z";

const line = (id: string, payload: Record<string, unknown>): string => JSON.stringify({ id, timestamp: at, payload });
const user = (id: string, text: string): string => line(id, { type: "user", content: text, images: [], documents: [] });
const say = (id: string, text: string): string => line(id, { type: "assistant", operationType: "Say", content: text });
const end = (id: string): string => line(id, { type: "turn_end", stopReason: "end_turn" });
const fileOf = (rows: readonly string[]): string => rows.join("\n") + "\n";
const sessionJSON = (workspacePaths: readonly string[], extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ schemaVersion: "1.0.0", dataModelVersion: 1, id: "sess_test-001", title: "Fixture", workspacePaths, status: "in_progress", ...extra });

function readerWith(rows: readonly string[], json: string | null): FakeTranscriptReader {
  const reader = new FakeTranscriptReader();
  reader.put(messages, fileOf(rows), messages);
  if (json !== null) reader.put(sessionFile, json, null);
  return reader;
}

async function settle(reader: FakeTranscriptReader, cold = false): Promise<ChatFeed<TranscriptSessionRef>> {
  const feed = new ChatFeed(reader, { pollIntervalMs: 5, ...(cold ? { cold: standardColdLoad } : {}) });
  feed.start(ref, [folder]);
  await feed.loaded();
  return feed;
}

const turnOne = [line("s", { type: "session_start", agentType: "vibe" }), user("u1", "Hello Kiro"), say("a1", "Hello."), end("e1")];

describe("kiro feed: the session.json decides before anything shows", () => {
  it("one session that records the pane's folder: live", async () => {
    const feed = await settle(readerWith(turnOne, sessionJSON([folder])));
    expect(feed.state).toEqual({ status: "live" });
    expect(shown(feed.timeline)).toEqual(["user:Hello Kiro", "agent:Hello."]);
    expect(feed.transcriptFolder).toBe(folder);
    feed.stop();
  });

  it("a recorded workspace elsewhere is sessionMismatch, nothing shown (the locate filter let it by: it names the folder second)", async () => {
    for (const json of [sessionJSON(["/Users/fixture/elsewhere", folder]), sessionJSON([folder + "/packages/app"]), sessionJSON([folder + "-two"])]) {
      const reader = readerWith(turnOne, json);
      const feed = await settle(reader);
      expect(feed.state, json).toEqual({ status: "unavailable", reason: "sessionMismatch" });
      expect(feed.timeline.turns, json).toEqual([]);
      expect(reader.readPaths.includes(messages), json).toBe(false);
      feed.stop();
    }
  });

  it("a missing session.json, or one that records no workspace, is no session of the pane's", async () => {
    for (const json of [null, JSON.stringify({ id: "sess_test-001", title: "no workspace" }), "not json"]) {
      const feed = await settle(readerWith(turnOne, json));
      expect(feed.state, String(json)).toEqual({ status: "unavailable", reason: "sessionMismatch" });
      expect(feed.timeline.turns).toEqual([]);
      feed.stop();
    }
  });

  it("a session.json of a newer data model is unrecognised, nothing shown", async () => {
    for (const extra of [{ dataModelVersion: 2 }, { schemaVersion: "2.0.0" }]) {
      const reader = readerWith(turnOne, sessionJSON([folder], extra));
      const feed = await settle(reader);
      expect(feed.state).toEqual({ status: "unavailable", reason: "unrecognisedFormat" });
      expect(feed.timeline.turns).toEqual([]);
      // Refused on the session.json alone: its lines are never read.
      expect(reader.readPaths.includes(sessionFile)).toBe(true);
      expect(reader.readPaths.includes(messages)).toBe(false);
      feed.stop();
    }
  });

  it("lines it does not know are the unrecognised note (after the session.json named the pane's folder)", async () => {
    const rows = Array.from({ length: 6 }, (_, index) => line(`x${index}`, { type: "conversation_v4", index }));
    const reader = readerWith(rows, sessionJSON([folder]));
    const feed = await settle(reader);
    expect(feed.state).toEqual({ status: "unavailable", reason: "unrecognisedFormat" });
    expect(reader.readPaths.includes(sessionFile)).toBe(true);
    expect(reader.readPaths.includes(messages)).toBe(true);
    feed.stop();
  });
});

describe("kiro feed: growth and history", () => {
  it("follows the file as it grows; a partial last line waits", async () => {
    const reader = readerWith(turnOne.slice(0, 2), sessionJSON([folder]));
    const feed = await settle(reader);
    expect(shown(feed.timeline)).toEqual(["user:Hello Kiro"]);
    const next = new TextEncoder().encode(fileOf([say("a1", "Hello."), line("c1", { type: "tool_call", toolName: "readFile", toolCallId: "t1" })]));
    reader.appendBytes(messages, next.slice(0, 20));
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(shown(feed.timeline)).toEqual(["user:Hello Kiro"]);
    reader.appendBytes(messages, next.slice(20));
    expect(await eventually(() => shown(feed.timeline).length === 3)).toBe(true);
    expect(turnToolCalls(feed.timeline.turns[0]!)[0]?.state).toBe("running");
    reader.append(messages, fileOf([line("r1", { type: "tool_result", toolCallId: "t1", content: "ok", success: true }), end("e1"), user("u2", "Next")]));
    expect(await eventually(() => feed.timeline.turns.length === 2)).toBe(true);
    expect(turnToolCalls(feed.timeline.turns[0]!)[0]?.state).toBe("ok");
    expect(feed.timeline.turns[0]?.isFinished).toBe(true);
    feed.stop();
  });

  it("reads a long file's newest window first, its folder from the session.json; Load earlier reaches the start and gives a call its result", async () => {
    // The first turn's call is at the start; its result lies in the newest window, after ~600 KiB of the agent's text.
    const filler = Array.from({ length: 300 }, (_, index) => say(`f${index}`, `Part ${index} ` + "p".repeat(2_000)));
    const rows = [
      line("s", { type: "session_start", agentType: "vibe" }),
      user("u1", "First question"),
      line("c1", { type: "tool_call", toolName: "grepSearch", toolCallId: "t1" }),
      ...filler,
      line("r1", { type: "tool_result", toolCallId: "t1", content: "3 matches", success: true }),
      end("e1"),
      user("u2", "Last question"),
      say("a2", "Last answer"),
      end("e2"),
    ];
    const reader = readerWith(rows, sessionJSON([folder]));
    const feed = await settle(reader, true);
    expect(feed.state).toEqual({ status: "live" });
    expect(feed.bytesRead).toBeLessThanOrEqual(standardColdLoad.window * 2 + 64 * 1_024);
    expect(feed.timeline.earlier).toBe("available");
    expect(feed.transcriptFolder).toBe(folder);
    expect(turnUserMessage(feed.timeline.turns.at(-1)!)?.text).toBe("Last question");
    expect(shown(feed.timeline)).not.toContain("user:First question");
    await loadAll(feed);
    expect(feed.timeline.earlier).not.toBe("available");
    expect(turnUserMessage(feed.timeline.turns[0]!)?.text).toBe("First question");
    expect(turnToolCalls(feed.timeline.turns[0]!).map((call) => [call.toolName, call.state])).toEqual([["grepSearch", "ok"]]);
    expect(shown(feed.timeline).filter((item) => item.startsWith("agent:Part ")).length).toBe(300);
    feed.stop();
  });
});

class Page implements ChatOwner {
  readonly updates: ChatUpdateEvent[] = [];
  constructor(readonly id: number) {}
  send(_channel: string, payload: ChatUpdateEvent): void {
    this.updates.push(payload);
  }
  isDestroyed(): boolean {
    return false;
  }
}

/** The chat service over fake Herdr panes (all Kiro unless named), one reader for the host. */
function service(reader: FakeTranscriptReader, panes: readonly { readonly paneID: string; readonly agent?: string; readonly cwd: string }[]): ChatService {
  const backend = { kind: "herdr", transcripts: () => reader } as unknown as HerdrHostBackend;
  const info = (paneId: string) => {
    const pane = panes.find((candidate) => candidate.paneID === paneId);
    return pane === undefined ? null : ({ paneID: paneId, agent: pane.agent ?? "kiro", cwd: pane.cwd } as never);
  };
  const hosts: ChatHosts = { backend: () => backend, pane: (_host, paneId) => info(paneId), agent: (_host, paneId) => info(paneId), hostAgentPanes: () => panes.map((pane) => pane.paneID) };
  return new ChatService(hosts, "chat", { pollIntervalMs: 5 });
}

let pages = 0;
/** Opens the pane's Chat on a fresh page and waits for it to settle (live or unavailable); every update it sent. */
async function opened(chat: ChatService, paneId: string): Promise<readonly ChatUpdateEvent[]> {
  pages += 1;
  const page = new Page(pages);
  chat.open(page, "mac", paneId);
  expect(await eventually(() => page.updates.at(-1)?.state.status === "live" || page.updates.at(-1)?.state.status === "unavailable")).toBe(true);
  return page.updates;
}

// Herdr gives no Kiro session identity, so the folder's
// newest V3 session can be another session of the same folder (a resumed older one, or a new run before its first
// record). Kiro is off Chat for 0.1.0, as Maki (chat-integrate-boundaries.test.ts): its own screen and the
// Chat line; the service follows nothing for a Kiro pane. The reader, locate and parser stay (the tests above and
// chat-kiro-locator / chat-kiro-parser) for a later exact binding.
describe("kiro in the chat service: off Chat for 0.1.0, as Maki", () => {
  it("is not a kind Chat reads: its own screen, and the Chat line with its name", () => {
    expect(chatKinds).not.toContain("kiro");
    for (const kind of ["kiro", "Kiro"]) {
      expect(chatReads(kind), kind).toBe(false);
      expect(defaultView({ paneID: "w1:p1", isAgent: true, kind }), kind).toBe("terminal");
    }
    expect(chatUnreadLine(true, "kiro")).toBe("Chat doesn't read Kiro CLI's sessions yet. Its own screen is on the Kiro CLI tab.");
  });

  it("one Kiro pane, its resumed older session and a newer other one in its folder: the locator names the newer, and Chat follows neither", async () => {
    const scratch = realpathSync(process.env["HERDR_TEST_SCRATCH"] || os.tmpdir());
    const home = mkdtempSync(path.join(scratch, "hc-kiro-locate-"));
    const put = (file: string, body: string): void => {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, body);
    };
    // Both sessions' own session.json records the pane's folder: the owner check cannot tell them apart.
    const sessions = [
      ["sess_resumed-old", "INTENDED OLDER SESSION", 100],
      ["sess_newer", "OTHER SESSION", 200],
    ] as const;
    const files = sessions.map(([id, text, modified]) => {
      const session = path.join(home, ".kiro/sessions/4748323122002acb", id);
      put(path.join(session, "session.json"), JSON.stringify({ schemaVersion: "1.0.0", dataModelVersion: 1, id, title: id, workspacePaths: [folder] }));
      put(path.join(session, "messages.jsonl"), fileOf([user(`${id}-u`, text)]));
      utimesSync(path.join(session, "messages.jsonl"), modified, modified);
      return path.join(session, "messages.jsonl");
    });
    // The locator (kept, with its tests) names the folder's newest: the other session, not the resumed one.
    const pane = { paneID: "k", agent: "kiro", cwd: folder };
    const bound = paneSession({ agents: [pane], panes: [pane] }, "k");
    expect(bound === null || bound === "ambiguous" ? bound : parseLocateOutput(execFileSync("/bin/sh", ["-c", locateCommand(bound.ref)!], { cwd: home, env: { ...process.env, HOME: home }, encoding: "utf8", timeout: 10_000 }), bound.ref)).toBe(files[1]);
    // The service over the same files: it follows neither, reads nothing, and shows no session's text.
    const reader = new FakeTranscriptReader();
    for (const file of files) {
      reader.put(file, readFileSync(file, "utf8"), file);
      reader.put(file.replace(/messages\.jsonl$/, "session.json"), readFileSync(file.replace(/messages\.jsonl$/, "session.json"), "utf8"), null);
    }
    reader.setLocated(files[1]!);
    const chat = service(reader, [{ paneID: "k", cwd: folder }]);
    try {
      const updates = await opened(chat, "k");
      expect(updates.at(-1)?.state).toEqual({ status: "unavailable", reason: "noSession" });
      expect(updates.some((update) => shown(update.timeline).length > 0)).toBe(false);
      expect(reader.calls).not.toContain("locate");
      expect(reader.readPaths).toEqual([]);
    } finally {
      chat.closeAll();
    }
  });

  it("two Kiro panes in one folder, or one whose sessions are only 2.x ones, follow nothing either (no locate, nothing read)", async () => {
    const reader = readerWith(turnOne, sessionJSON([folder]));
    const chat = service(reader, [
      { paneID: "k1", cwd: folder },
      { paneID: "k2", cwd: folder },
    ]);
    try {
      for (const pane of ["k1", "k2"]) {
        const updates = await opened(chat, pane);
        expect(updates.at(-1)?.state, pane).toEqual({ status: "unavailable", reason: "noSession" });
        expect(updates.some((update) => shown(update.timeline).length > 0), pane).toBe(false);
      }
      expect(reader.calls).not.toContain("locate");
      expect(reader.readPaths).toEqual([]);
    } finally {
      chat.closeAll();
    }
    const older = new FakeTranscriptReader();
    older.setLocated(null);
    const alone = service(older, [{ paneID: "k", cwd: folder }]);
    try {
      expect((await opened(alone, "k")).at(-1)?.state).toEqual({ status: "unavailable", reason: "noSession" });
      expect(older.calls).not.toContain("locate");
    } finally {
      alone.closeAll();
    }
  });
});

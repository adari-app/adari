// A Cursor agent chat's store.db in Chat, the desktop twin of HerdrKit's
// CursorSessionLocatorTests, CursorStoreTests and CursorStoreLiveTests. The fixture
// (desktop/fixtures/chat/cursor-store.json) is shared with the Swift tests; stores are built with
// /usr/bin/sqlite3 under the scratch folder.

import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ChatTimelineBuilder } from "../src/shared/chat/builder";
import {
  CursorStoreError,
  CursorStoreView,
  cursorBlobsSQL,
  cursorFolderHash,
  cursorLengthsSQL,
  cursorMetaFolder,
  cursorQueryCommand,
  cursorRoot,
  cursorRootIDSQL,
  cursorRootSQL,
  cursorRows,
  isCursorStorePath,
  md5Hex,
} from "../src/shared/chat/cursor-store";
import { CursorStoreParser } from "../src/shared/chat/cursor-parser";
import { ChatFeed, defaultPollIntervalMs, standardColdLoad } from "../src/shared/chat/feed";
import {
  cursorAmbiguousNote,
  ambiguousNoteFor,
  grokAmbiguousNote,
  locateCommand,
  makeSessionRef,
  paneSession,
  parseLocateOutput,
  sessionForPane,
  sessionFromArgv,
  sessionRefFromAgentSession,
  type TranscriptSessionRef,
} from "../src/shared/chat/locator";
import { turnFooter, turnToolCalls, turnUserMessage, type ChatTimeline, type ChatTurn } from "../src/shared/chat/model";
import { TranscriptParser } from "../src/shared/chat/parser";
import type { SessionTopology } from "../src/main/herdr/wire";
import { PaneLife, resumeCommand, resumeTitle, type PaneAgentMemory } from "../src/shared/pane-life";
import { absentStartCommands, startCommandsWith } from "../src/shared/start-commands";
import { DemoTranscriptReader, demoTranscripts } from "../src/main/demo/demo-chat";
import {
  LocalCursorReader,
  blobsOf,
  chatFolder,
  cursorSpec,
  fixtureKey,
  insertBlobs,
  makeStore,
  newHome,
  rootBytes,
  runHere,
  sha256,
  sqlite,
  writeStore,
} from "./support/cursor-store";

const cwd = cursorSpec.cwd;
const chatID = cursorSpec.chatID;

async function eventually(condition: () => boolean, timeoutMs = 8_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return condition();
}

const texts = (turn: ChatTurn | undefined): string[] => (turn?.items ?? []).flatMap((item) => (item.type === "agentText" ? [item.value.markdown] : []));

const storeRef = (store: string): TranscriptSessionRef => makeSessionRef("cursor", { kind: "path", path: store })!;

async function follow(reader: LocalCursorReader, store: string, until: (timeline: ChatTimeline) => boolean, cold = false): Promise<ChatFeed<TranscriptSessionRef>> {
  const feed = new ChatFeed<TranscriptSessionRef>(reader, { pollIntervalMs: 10, ...(cold ? { cold: standardColdLoad } : {}) });
  feed.start(storeRef(store), [cwd]);
  await eventually(() => until(feed.timeline));
  return feed;
}

// MARK: - the pane's session

describe("cursor: finding the pane's chat", () => {
  it("hashes a folder as Cursor does (md5 of the path, no trailing slash)", () => {
    for (const value of ["/Users/fixture/code/aurora-web", "/Volumes/Data/code/projects/tidepool", "/Users/f it's/ünïcödé", "", "x".repeat(200)]) {
      expect(md5Hex(new TextEncoder().encode(value))).toBe(createHash("md5").update(value, "utf8").digest("hex"));
    }
    expect(cursorFolderHash(cwd + "/")).toBe(cursorFolderHash(cwd));
    expect(cursorFolderHash(cwd)).toBe("2124d1c8a9e0c21439be41efae2f431a");
  });

  it("forms a path only from a 32-hex folder hash and a UUID chat folder", () => {
    const good = `/Users/fixture/.cursor/chats/2124d1c8a9e0c21439be41efae2f431a/${chatID}/store.db`;
    expect(isCursorStorePath(good)).toBe(true);
    for (const bad of [
      `/Users/fixture/.cursor/chats/2124D1C8A9E0C21439BE41EFAE2F431A/${chatID}/store.db`,
      `/Users/fixture/.cursor/chats/2124d1c8/${chatID}/store.db`,
      "/Users/fixture/.cursor/chats/2124d1c8a9e0c21439be41efae2f431a/not-a-uuid/store.db",
      `/Users/fixture/.cursor/chats/2124d1c8a9e0c21439be41efae2f431a/${chatID}/meta.json`,
      `/Users/fixture/.cursor/../chats/2124d1c8a9e0c21439be41efae2f431a/${chatID}/store.db`,
      `relative/.cursor/chats/2124d1c8a9e0c21439be41efae2f431a/${chatID}/store.db`,
    ]) {
      expect(isCursorStorePath(bad), bad).toBe(false);
    }
    expect(makeSessionRef("cursor", { kind: "path", path: good })).not.toBeNull();
    expect(makeSessionRef("cursor", { kind: "path", path: "/Users/fixture/x.jsonl" })).toBeNull();
    expect(makeSessionRef("cursor", { kind: "id", id: "my-chat-title" })).toBeNull();
    expect(makeSessionRef("cursor", { kind: "folder", folder: cwd, exclude: ["not-a-uuid"] })).toBeNull();
  });

  it("reads the chat id from cursor-agent's argv: --resume <id> or --resume=<id>; --continue and a bare --resume name none", () => {
    expect(sessionFromArgv(["cursor-agent", "--resume", chatID], "cursor")?.value).toBe(chatID);
    expect(sessionFromArgv(["cursor-agent", `--resume=${chatID}`], "cursor")?.value).toBe(chatID);
    for (const argv of [["cursor-agent", "--continue"], ["cursor-agent", "--resume"], ["cursor-agent", "-r", chatID], ["cursor-agent", "resume", chatID], ["cursor-agent", "--resume", "--model"], ["cursor-agent", "ls"]]) {
      expect(sessionFromArgv(argv, "cursor"), argv.join(" ")).toBeNull();
    }
    // The argv's id wins over Herdr's session, then the folder.
    const pane = { agent: "cursor", cwd, agentSession: { source: "herdr:cursor", agent: "cursor", kind: "id", value: "9a8b7c6d-1111-4222-8333-944455556666" } };
    expect(sessionForPane(pane, { argv: ["cursor-agent", "--resume", chatID] })?.ref.lookup).toEqual({ kind: "id", id: chatID });
    expect(sessionForPane(pane)?.ref.lookup).toEqual({ kind: "id", id: "9a8b7c6d-1111-4222-8333-944455556666" });
    expect(sessionForPane({ agent: "cursor", cwd })?.ref).toEqual({ format: "cursor", lookup: { kind: "folder", folder: cwd } });
    expect(sessionForPane({ agent: "cursor", cwd })?.source).toBe("folder");
    expect(sessionRefFromAgentSession({ source: "herdr:cursor", agent: "cursor", kind: "path", value: `/Users/fixture/.cursor/chats/${cursorFolderHash(cwd)}/${chatID}/store.db` })?.format).toBe("cursor");
  });

  it("finds the folder's newest chat whose meta.json names the folder, skipping peers' (the command run here under a scratch home)", () => {
    const home = newHome("locate");
    const make = (id: string, updatedAtMs: number, folder = cwd, store = true): void => {
      const dir = chatFolder(home, cwd, id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ cwd: folder, updatedAtMs, title: "x" }));
      if (store) writeFileSync(path.join(dir, "store.db"), "");
    };
    const older = "11111111-1111-4111-8111-111111111111";
    const newest = "22222222-2222-4222-8222-222222222222";
    const otherFolder = "33333333-3333-4333-8333-333333333333";
    const noStore = "44444444-4444-4444-8444-444444444444";
    make(older, 1_000);
    make(newest, 5_000);
    make(otherFolder, 9_000, "/Users/fixture/elsewhere");
    make(noStore, 9_500, cwd, false);
    const ref = makeSessionRef("cursor", { kind: "folder", folder: cwd })!;
    const command = locateCommand(ref)!;
    const run = (text: string): string => (spawnSync("/bin/sh", ["-c", text], { env: { HOME: home, PATH: "/usr/bin:/bin" } }).stdout ?? Buffer.alloc(0)).toString("utf8");
    expect(parseLocateOutput(run(command), ref)).toBe(path.join(chatFolder(home, cwd, newest), "store.db"));
    // A peer names the newest: the older one is this pane's.
    const excluding = makeSessionRef("cursor", { kind: "folder", folder: cwd, exclude: [newest] })!;
    expect(parseLocateOutput(run(locateCommand(excluding)!), excluding)).toBe(path.join(chatFolder(home, cwd, older), "store.db"));
    // By id: the glob finds it under any folder hash.
    const byID = makeSessionRef("cursor", { kind: "id", id: older })!;
    expect(parseLocateOutput(run(locateCommand(byID)!), byID)).toBe(path.join(chatFolder(home, cwd, older), "store.db"));
    // The command reads only: grep, sed, sort, head and printf; nothing written.
    for (const word of [" rm ", " mv ", "touch", " tee ", " >", "mkdir"]) expect(command.includes(word), word).toBe(false);
    // Output from another folder hash, or an excluded chat, is not taken.
    expect(parseLocateOutput(`/Users/x/.cursor/chats/${"0".repeat(32)}/${newest}/store.db\n`, ref)).toBeNull();
    expect(parseLocateOutput(`/Users/x/.cursor/chats/${cursorFolderHash(cwd)}/${newest}/store.db\n`, excluding)).toBeNull();
  });

  it("refuses two Cursor panes in one folder that name no chat, with Cursor's note", () => {
    const machine = {
      agents: [
        { paneID: "p1", agent: "cursor", cwd },
        { paneID: "p2", agent: "cursor", cwd },
      ],
      panes: [],
    };
    expect(paneSession(machine, "p1")).toBe("ambiguous");
    expect(ambiguousNoteFor("cursor")).toBe(cursorAmbiguousNote);
    expect(cursorAmbiguousNote).toBe("Two Cursor sessions are open in this folder, so Chat can't tell which is this pane's");
    expect(ambiguousNoteFor("grok")).toBe(grokAmbiguousNote);
    // A Grok pane in the same folder is not a Cursor peer.
    expect(paneSession({ agents: [{ paneID: "p1", agent: "cursor", cwd }, { paneID: "p2", agent: "grok", cwd }], panes: [] }, "p1")).not.toBe("ambiguous");
    // A peer naming a chat: this pane's lookup skips it.
    const named = paneSession(
      { agents: [{ paneID: "p1", agent: "cursor", cwd }, { paneID: "p2", agent: "cursor", cwd, agentSession: { source: "herdr:cursor", agent: "cursor", kind: "id", value: chatID } }], panes: [] },
      "p1",
    );
    expect(named !== "ambiguous" && named !== null ? named.ref.lookup : null).toEqual({ kind: "folder", folder: cwd, exclude: [chatID] });
  });

  it("takes a chat's folder from its meta.json's cwd only", () => {
    const bytes = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
    expect(cursorMetaFolder(bytes({ cwd: cwd + "/", updatedAtMs: 1 }))).toBe(cwd);
    expect(cursorMetaFolder(bytes({ title: cwd }))).toBeNull();
    expect(cursorMetaFolder(bytes({ cwd: "relative" }))).toBeNull();
    expect(cursorMetaFolder(new TextEncoder().encode("{"))).toBeNull();
  });
});

// MARK: - the store into the timeline

describe("cursor: the store's queries", () => {
  it("reads the root id inside sqlite, the encryption key never in the output", () => {
    const home = newHome("key");
    const { store } = makeStore(home);
    expect(cursorRootIDSQL.includes("blobEncryptionKey")).toBe(false);
    const output = runHere(cursorQueryCommand(store, cursorRootIDSQL)!, 4_096);
    expect(output.includes(fixtureKey)).toBe(false);
    expect(output.includes("blobEncryptionKey")).toBe(false);
    const rows = cursorRows(output)!;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatch(/^[0-9a-f]{64}$/);
    // The key is in the store, though: the meta row as a whole would carry it.
    expect(runHere(cursorQueryCommand(store, "select cast(unhex(value) as text) from meta;")!, 4_096).includes(fixtureKey)).toBe(true);
  });

  it("is read-only and takes only hex ids", () => {
    const store = `/Users/f it's/.cursor/chats/${cursorFolderHash(cwd)}/${chatID}/store.db`;
    const command = cursorQueryCommand(store, cursorRootIDSQL)!;
    expect(command).toContain("-readonly");
    expect(command).toContain("mode=ro");
    expect(command).toContain("immutable=1");
    expect(command).toContain("-init /dev/null");
    expect(command).toContain("%20it%27s");
    expect(cursorQueryCommand("/Users/f/notes.db", cursorRootIDSQL)).toBeNull();
    expect(cursorBlobsSQL(["abc' or 1=1 --"])).toBeNull();
    expect(cursorLengthsSQL(["A".repeat(64)])).toBeNull();
    expect(cursorRootSQL("x")).toBeNull();
    expect(cursorBlobsSQL(["a".repeat(64)])).not.toBeNull();
  });

  it("walks the root's refs in order and its context (field 5) when sane", () => {
    const refs = [0, 1, 2].map((index) => sha256(`r${index}`));
    expect(cursorRoot(rootBytes(refs, 61_234, 200_000))).toEqual({ refs, used: 61_234, window: 200_000 });
    expect(cursorRoot(rootBytes(refs, 300_000, 200_000))?.window).toBeNull();
    expect(cursorRoot(rootBytes(refs, 5, 12))?.window).toBeNull();
    expect(cursorRoot(rootBytes(refs))?.used).toBeNull();
    expect(cursorRoot(Uint8Array.from([0x0a, 0x40, 0x01]))).toBeNull();
    expect(cursorRoot(Uint8Array.from([0x0b]))).toBeNull();
  });
});

describe("cursor: the store as lines", () => {
  it("is one line per root ref; the missing ref and the non-JSON blob placeholders; any range the same bytes", async () => {
    const home = newHome("view");
    const { store, blobs } = makeStore(home);
    const reader = new LocalCursorReader(store);
    const size = await reader.size(store);
    const bytes = await reader.read(store, 0, size);
    expect(bytes.length).toBe(size);
    const lines = new TextDecoder().decode(bytes).split("\n").slice(0, -1);
    expect(lines).toHaveLength(blobs.length);
    expect(lines.filter((line) => line === '{"cursorRef":"missing"}')).toHaveLength(1);
    expect(lines.filter((line) => line === '{"cursorRef":"notJSON"}')).toHaveLength(1);
    const raw = cursorSpec.root.find((entry) => entry.raw !== undefined)!.raw!;
    expect(lines).toContain(raw.replace(/\n/g, " "));
    for (const [offset, count] of [[0, 10], [100, 5_000], [size - 7, 7], [1_234, 1]] as const) {
      expect(Array.from(await reader.read(store, offset, count))).toEqual(Array.from(bytes.subarray(offset, offset + count)));
    }
    expect(reader.view.stats.rootReads).toBe(1);
  });

  it("makes bad hex a placeholder as long as the blob, and a query that did not run an error", async () => {
    const store = `/Users/fixture/.cursor/chats/${cursorFolderHash(cwd)}/${chatID}/store.db`;
    const blob = new TextEncoder().encode('{"role":"assistant","content":[{"type":"text","text":"hello"}]}');
    const id = sha256(blob);
    const root = rootBytes([id]);
    const rootID = sha256(root);
    const notFound = (file: string): Error => new Error(file);
    const view = new CursorStoreView(
      (command) => {
        if (command.includes("latestRootBlobId")) return Promise.resolve(`${rootID}\n#ok\n`);
        if (command.includes("select hex(data) from blobs where id=")) return Promise.resolve(Buffer.from(root).toString("hex").toUpperCase() + "\n#ok\n");
        if (command.includes("length(cast")) return Promise.resolve(`${id} ${blob.length} 7B\n#ok\n`);
        return Promise.resolve(`${id} ZZ${Buffer.from(blob).toString("hex").slice(2)}\n#ok\n`);
      },
      () => Promise.resolve("1:1"),
      notFound,
    );
    const size = await view.size(store);
    expect(size).toBe(blob.length + 1);
    const line = await view.read(store, 0, size);
    expect(line.length).toBe(blob.length + 1);
    expect(new TextDecoder().decode(line).startsWith('{"cursorRef":"badHex"}')).toBe(true);
    const parser = new TranscriptParser("cursor");
    expect(parser.parse(new TextDecoder().decode(line.subarray(0, -1))).outcome).toEqual({ kind: "skipped", type: "cursor badHex ref" });
    const failing = new CursorStoreView(() => Promise.resolve(""), () => Promise.resolve("1:1"), notFound);
    await expect(failing.size(store)).rejects.toBeInstanceOf(CursorStoreError);
  });

  it("reads a store with a WAL and no -shm immutable, creating nothing beside it; neither file reads too", async () => {
    const home = newHome("wal");
    const { store, blobs } = makeStore(home);
    const wal = `${store}-wal`;
    const shm = `${store}-shm`;
    const folder = path.dirname(store);
    // Cursor open: both files (an open connection leaves them); nothing new in the folder after a read.
    if (!existsSync(wal)) writeFileSync(wal, "");
    if (!existsSync(shm)) sqlite(store, "select 1;");
    const before = readdirSync(folder).sort();
    let reader = new LocalCursorReader(store);
    expect(await reader.size(store)).toBeGreaterThan(0);
    expect(readdirSync(folder).sort()).toEqual(before);
    // Closed with its WAL kept and no -shm: an ro open would create the -shm; immutable reads it.
    if (existsSync(shm)) unlinkSync(shm);
    reader = new LocalCursorReader(store);
    const size = await reader.size(store);
    const text = new TextDecoder().decode(await reader.read(store, 0, size));
    expect(text.split("\n").filter((line) => line.length > 0)).toHaveLength(blobs.length);
    expect(existsSync(shm)).toBe(false);
    // Neither file: ro fails on a WAL store; immutable reads it.
    if (existsSync(wal)) unlinkSync(wal);
    reader = new LocalCursorReader(store);
    expect(await reader.size(store)).toBeGreaterThan(0);
    expect(existsSync(shm)).toBe(false);
    expect(existsSync(wal)).toBe(false);
  });

  // A read of a store a live writer holds open in WAL
  // mode creates no file in Cursor's folder and changes neither store.db, its -wal nor meta.json;
  // SQLite's read marks in the existing -shm may change (every WAL reader's coordination).
  it("reads a store a live writer holds in WAL mode, creating no file and changing no store, WAL or meta.json", async () => {
    const { store } = makeStore(newHome("live-wal"));
    const folder = path.dirname(store);
    const writer = spawn("/usr/bin/sqlite3", ["-init", "/dev/null", "-batch", store], { stdio: ["pipe", "pipe", "pipe"] });
    const closed = new Promise((resolve) => writer.once("close", resolve));
    let said = "";
    const ready = new Promise<void>((resolve, reject) => {
      writer.stdout.on("data", (chunk: Buffer) => {
        said += chunk.toString();
        if (said.includes("ready-marker")) resolve();
      });
      writer.once("error", reject);
    });
    try {
      writer.stdin.write("pragma journal_mode=wal; pragma wal_autocheckpoint=0; create table live_probe (n integer); insert into live_probe values (1); select 'ready-marker';\n");
      await ready;
      const hashes = (): Record<string, string> =>
        Object.fromEntries(readdirSync(folder).sort().map((name) => [name, sha256(readFileSync(path.join(folder, name)))]));
      const before = hashes();
      expect(before["store.db-wal"]).toBeDefined();
      expect(before["store.db-shm"]).toBeDefined();
      const printed = runHere(cursorQueryCommand(store, cursorRootIDSQL)!, 4_096);
      expect(printed.endsWith("#ok\n")).toBe(true);
      const after = hashes();
      expect(Object.keys(after)).toEqual(Object.keys(before));
      for (const name of ["store.db", "store.db-wal", "meta.json"]) expect(after[name], name).toBe(before[name]);
    } finally {
      writer.stdin.end();
      await closed;
    }
  });
});

describe("cursor: the timeline", () => {
  it("shows every message and part kind as the other readers show them", async () => {
    const home = newHome("timeline");
    const { store } = makeStore(home);
    const reader = new LocalCursorReader(store);
    const feed = await follow(reader, store, (timeline) => timeline.turns.length === 2);
    expect(feed.state.status).toBe("live");
    const turns = feed.timeline.turns;
    feed.stop();
    expect(turns.map(turnUserMessage).map((message) => message?.text)).toEqual(["Add a retry to the upload sweep and run its tests.", "Also bump the version in the changelog."]);
    expect(turnUserMessage(turns[0]!)?.time).toBe(Date.parse("2026-11-04T07:43:00Z") / 1_000);
    expect(turnUserMessage(turns[1]!)?.time).toBe(Date.parse("2026-11-04T03:35:00Z") / 1_000);
    const first = turns[0]!;
    expect(texts(first)).toEqual(["I'll read the sweep first.", "Adding the retry.", "Done: the sweep retries twice, and UploadSweepTests passes."]);
    expect(first.isFinished).toBe(true);
    // No time but the user message's: no "Worked for" (its length is not known).
    expect(turnFooter(first)).toBeNull();
    const calls = turnToolCalls(first);
    expect(calls.map((call) => call.kind)).toEqual(["read", "search", "search", "edit", "bash", "edit", { other: "GetDynamicTools" }, { other: "CallDynamicTool" }]);
    expect(calls[0]!.target).toBe(`${cwd}/Sources/HerdrKit/UploadSweep.swift`);
    expect(calls[0]!.state).toBe("ok");
    expect(calls[1]!.target).toBe("func run\\(");
    expect(calls[2]!.target).toBe("**/UploadSweep*Tests.swift");
    const diff = calls[3]!.detail;
    expect(diff.type === "diff" ? [diff.diff.added, diff.diff.removed] : null).toEqual([3, 1]);
    expect(calls[4]!.state).toBe("failed");
    expect(calls[4]!.detail.type === "bash" ? calls[4]!.detail.bash.command : null).toBe("swift test --filter UploadSweepTests");
    const written = calls[5]!.detail;
    expect(written.type === "diff" ? [written.diff.added, written.diff.removed] : null).toEqual([3, 0]);
    expect(calls[7]!.target).toBe("fixture-mcp/run_check");
    expect(first.items.some((item) => item.type === "progress" && item.value.markdown.startsWith("Checking which dynamic tools"))).toBe(true);
    const second = turns[1]!;
    expect(texts(second)).toEqual(["Bumping it.", "Picking up: bumping the changelog now."]);
    expect(turnToolCalls(second).map((call) => call.kind)).toEqual([{ other: "TodoWrite" }, "bash"]);
    expect(turnToolCalls(second).at(-1)!.state).toBe("running");
    expect(second.isFinished).toBe(false);
    expect(second.items.some((item) => item.type === "notice" && item.value.kind === "compacted")).toBe(true);
    const shown = JSON.stringify(turns);
    for (const hidden of ["invented coding agent", "<user_info>", "todo list is empty", "sweep-check exited", "An older message", "srgb"]) expect(shown.includes(hidden), hidden).toBe(false);
  });

  // The outer envelope decides, not tags inside the text.
  it("lets the outer envelope decide: example queries in a context pack or reminder skipped, a query naming the summary tag the user's, a query in a notification the user's", () => {
    const parse = (content: unknown) => new CursorStoreParser().parse(JSON.stringify({ content, role: "user" }));
    const pack = "<user_info>fixture</user_info><rules>Example: <user_query>example only</user_query></rules>";
    expect(parse(pack).events).toEqual([]);
    expect(parse(pack).outcome).toEqual({ kind: "skipped", type: "context" });
    const reminder = "<system_reminder>Example: <user_query>example only</user_query></system_reminder>";
    expect(parse(reminder).events).toEqual([]);
    expect(parse([{ text: reminder, type: "text" }]).events).toEqual([]);
    const asked = parse("<timestamp>Tuesday, Nov 4, 2026, 8:43 AM (UTC+1)</timestamp>\n<user_query>Explain the <conversation_summary> tag.</user_query>");
    const message = asked.events[0];
    expect(message?.type).toBe("userMessage");
    if (message?.type === "userMessage") {
      expect(message.message.text).toBe("Explain the <conversation_summary> tag.");
      expect(message.message.time).not.toBeNull();
    }
    const summary = parse("<conversation_summary>\nThe chat so far.\n<user_query>an old ask quoted</user_query>\n</conversation_summary>");
    expect(summary.events[0]?.type).toBe("notice");
    // A notification with no timestamp is not a recorded shape (the user's query follows the
    // notification's close, after a timestamp): unknown, whatever it holds.
    const inside = parse("<system_notification>\nA background task finished.\n<user_query>\nShip it.\n</user_query>\n</system_notification>");
    expect(inside.events).toEqual([]);
    expect(inside.outcome).toEqual({ kind: "unknown", type: "user envelope" });
    expect(parse("<system_notification>\nA background task finished.\n</system_notification>").outcome).toEqual({ kind: "unknown", type: "user envelope" });
  });

  // A same-name envelope closes at its own depth, and an
  // unclosed envelope other than a query runs to the end of the text, promoting nothing inside it.
  it("nests same-name envelopes by depth, and an unclosed non-query envelope promotes nothing", () => {
    const parse = (content: string) => new CursorStoreParser().parse(JSON.stringify({ content, role: "user" }));
    const said = (content: string): string | null => {
      const event = parse(content).events[0];
      return event?.type === "userMessage" ? event.message.text : null;
    };
    const words = "Explain <user_query>example only</user_query> and its closing tag.";
    expect(said(`<user_query>${words}</user_query>`)).toBe(words);
    expect(parse("<system_reminder>Outer. <system_reminder>Inner.</system_reminder><user_query>example only</user_query></system_reminder>").events).toEqual([]);
    expect(parse("<system_reminder>Example: <user_query>example only</user_query>").events).toEqual([]);
    expect(parse("<user_info>fixture</user_info><rules>Example: <user_query>example only</user_query>").events).toEqual([]);
    expect(parse("<system_notification>Done. <user_query>example only</user_query>").events).toEqual([]);
    expect(parse("<conversation_summary>Quoted <user_query>old ask</user_query>").events).toEqual([]);
    // The user's words run from the opener to the final close, so sibling queries are one text;
    // a notification with no timestamp is unknown; a cut-off query is the user's words to the end.
    expect(said("<user_query>one</user_query><user_query>two</user_query>")).toBe("one</user_query><user_query>two");
    expect(said("<user_query>Check x < y and a < b > c.</user_query>")).toBe("Check x < y and a < b > c.");
    expect(parse("<system_notification>Done.\n<user_query>Ship it.</user_query>\n</system_notification>").events).toEqual([]);
    expect(said("<user_query>unfinished")).toBe("unfinished");
    expect(parse("<conversation_summary>Quoted <user_query>old ask</user_query></conversation_summary>").events[0]?.type).toBe("notice");
  });

  // Cursor's user messages are anchored. One known envelope
  // starts the text and the user's words run to the end; a tag inside the user's words or the harness text is
  // never structure.
  it("reads the user's words between the recorded anchors only", () => {
    const parse = (content: string) => new CursorStoreParser().parse(JSON.stringify({ content, role: "user" }));
    const message = (content: string) => {
      const event = parse(content).events[0];
      return event?.type === "userMessage" ? event.message : null;
    };
    const stamp = "<timestamp>Tuesday, Nov 4, 2026, 9:05 AM (UTC+5:30)</timestamp>\n";
    const at = Date.parse("2026-11-04T03:35:00Z") / 1_000;
    const notice = "<system_notification>\nA background task finished.\n<task>sweep-check exited 0</task>\n</system_notification>";
    // Four anchoring cases.
    expect(message("<user_query>Explain the <user_query> tag.</user_query>")?.text).toBe("Explain the <user_query> tag.");
    const code = "Explain `<user_query>` and when it starts a message.";
    expect(message(`<user_query>${code}</user_query>`)?.text).toBe(code);
    const wrapped = parse(`<system_notification><user_query>${code}</user_query></system_notification>`);
    expect(wrapped.events, "not a recorded shape").toEqual([]);
    expect(wrapped.outcome).toEqual({ kind: "unknown", type: "user envelope" });
    const reminder = parse("<system_reminder>Documentation says `<system_reminder>` starts a reminder.</system_reminder><user_query>Ship it.</user_query>");
    expect(reminder.events, "a reminder is a message of its own").toEqual([]);
    expect(reminder.outcome).toEqual({ kind: "skipped", type: "system_reminder" });
    // The notification case in its recorded shape keeps the user's words verbatim.
    const after = message(`${stamp}${notice}\n<user_query>\n${code}\n</user_query>`);
    expect(after?.text).toBe(code);
    expect(after?.time).toBe(at);
    // The user's words holding </user_query> or another harness tag mid-text.
    const closes = "Close with </user_query> then <system_reminder> and <conversation_summary> go on.";
    expect(message(`${stamp}<user_query>\n${closes}\n</user_query>`)?.text).toBe(closes);
    // A cut-off query is the user's words to the end.
    const cut = message(`${stamp}<user_query>\nCut off <user_query> here`);
    expect(cut?.text).toBe("Cut off <user_query> here");
    expect(cut?.time).toBe(at);
    // A notification without the user's query, or with a cut-off one, is harness.
    expect(parse(stamp + notice).outcome).toEqual({ kind: "skipped", type: "system_notification" });
    expect(parse(`${stamp}${notice}\n<user_query>cut off`).outcome).toEqual({ kind: "skipped", type: "system_notification" });
    // A summary with harness text after its close is the compaction row alone.
    const summary = parse("<conversation_summary>\nThe chat so far.\n<summary>Done.</summary>\n</conversation_summary>\nContinue from here. <user_query>example only</user_query>");
    expect(summary.events.map((event) => (event.type === "notice" ? event.notice.kind : event.type))).toEqual(["compacted"]);
    // A context pack holding example tags, and a real-looking query after it.
    const pack = parse("<user_info>\nfixture\n</user_info>\n\n<git_status>\n## main\n</git_status>\n\n<rules>\nExample: <user_query>example only</user_query>\n</rules>\n<user_query>also harness</user_query>");
    expect(pack.events).toEqual([]);
    expect(pack.outcome).toEqual({ kind: "skipped", type: "context" });
    expect(parse("<agent_transcripts>x</agent_transcripts>").outcome).toEqual({ kind: "skipped", type: "context" });
    // Plain text is the user's as is; any other opening tag is unknown.
    expect(message("  Just <words> and a </user_query>.  ")?.text).toBe("Just <words> and a </user_query>.");
    expect(parse("<task>x</task><user_query>Ship it.</user_query>").outcome).toEqual({ kind: "unknown", type: "user envelope" });
    expect(parse(`${stamp}<task>x</task>`).outcome).toEqual({ kind: "unknown", type: "user envelope" });
  });

  it("skips and counts what it does not show; parses Cursor's local times", () => {
    const parser = new TranscriptParser("cursor");
    for (const entry of cursorSpec.root) {
      const text = entry.json ?? entry.raw;
      if (text !== undefined) parser.parse(text.replace(/\n/g, " "), 0);
    }
    const skipped = Object.fromEntries(parser.stats.skippedTypes);
    expect(skipped["system"]).toBe(1);
    expect(skipped["context"]).toBe(1);
    expect(skipped["system_reminder"]).toBe(1);
    expect(skipped["system_notification"]).toBe(1);
    expect(skipped["no role"]).toBe(1);
    expect(parser.stats.malformed).toBe(1);
    expect(parser.parse('{"cursorRef":"missing"}').outcome).toEqual({ kind: "skipped", type: "cursor missing ref" });
    expect(parser.parse('{"cursorRef":"notJSON"}').outcome).toEqual({ kind: "skipped", type: "cursor notJSON ref" });
    expect(parser.parse("\u0001\u0002binary").outcome).toEqual({ kind: "malformed" });
    expect(CursorStoreParser.time("Wednesday, November 12, 2026, 12:05 PM (UTC-3)")).toBe(Date.parse("2026-11-12T15:05:00Z") / 1_000);
    expect(CursorStoreParser.time("Monday, Nov 2, 2026, 12:10 AM (UTC+5.5)")).toBe(Date.parse("2026-11-01T18:40:00Z") / 1_000);
    expect(CursorStoreParser.time("yesterday")).toBeNull();
  });

  it("builds the same timeline read line by line as through the feed", async () => {
    const home = newHome("lines");
    const { store } = makeStore(home);
    const reader = new LocalCursorReader(store);
    const size = await reader.size(store);
    const text = new TextDecoder().decode(await reader.read(store, 0, size));
    const parser = new TranscriptParser("cursor");
    const builder = new ChatTimelineBuilder();
    let offset = 0;
    for (const line of text.split("\n")) {
      const at = offset;
      offset += new TextEncoder().encode(line).length + 1;
      if (line !== "") builder.apply(parser.parse(line, at).events, at);
    }
    const feed = await follow(new LocalCursorReader(store), store, (timeline) => timeline.turns.length === 2);
    const followed = feed.timeline.turns;
    feed.stop();
    expect(followed).toHaveLength(2);
    expect(followed).toEqual(builder.timeline.turns);
  });
});

// MARK: - live, per message

// A view under a controlled stamp and clock.
function clockedView(): { view: CursorStoreView; clock: { now: number; stamp: string } } {
  const clock = { now: 1_000_000, stamp: "20480:1000" };
  const view = new CursorStoreView(
    (command, max) => Promise.resolve(runHere(command, max)),
    () => Promise.resolve(clock.stamp),
    (file) => new Error(file),
    () => clock.now,
  );
  return { view, clock };
}

const replies = (texts: readonly string[]) => blobsOf(texts.map((text) => ({ json: JSON.stringify({ content: [{ text, type: "text" }], role: "assistant" }) })));

async function viewText(view: CursorStoreView, store: string): Promise<string> {
  return new TextDecoder().decode(await view.read(store, 0, await view.size(store)));
}

describe("cursor: a missing ref in the middle", () => {
  it("is asked for again while the root stays, and lands as a cold read shows it (a new revision)", async () => {
    const store = path.join(chatFolder(newHome("middle")), "store.db");
    const all = replies(["first", "late-middle", "last"]);
    writeStore(store, [all[0]!, all[2]!], all.map((blob) => blob.id));
    const { view, clock } = clockedView();
    const initial = await viewText(view, store);
    expect(initial).toContain('{"cursorRef":"missing"}');
    const revision = await view.storeRevision(store);
    insertBlobs(store, [all[1]!]);
    clock.stamp = "20480:1001";
    clock.now += 20_000;
    const after = await viewText(view, store);
    const cold = new LocalCursorReader(store);
    const expected = new TextDecoder().decode(await cold.read(store, 0, await cold.size(store)));
    expect(after).toBe(expected);
    expect(after).toContain("late-middle");
    expect(await view.storeRevision(store)).toBeGreaterThan(revision);
  });

  it("stops asking for a ref that never lands after its attempts; then a refresh is the root id alone", async () => {
    const store = path.join(chatFolder(newHome("never")), "store.db");
    const all = replies(["first", "never", "last"]);
    writeStore(store, [all[0]!, all[2]!], all.map((blob) => blob.id));
    const { view, clock } = clockedView();
    await view.size(store);
    let asked = 0;
    for (let round = 1; round <= CursorStoreView.maxRefAttempts + 5; round += 1) {
      clock.stamp = `20480:${1_000 + round}`;
      clock.now += 20_000;
      const before = view.stats.queries;
      await view.size(store);
      if (view.stats.queries - before > 1) asked += 1;
    }
    expect(asked).toBe(CursorStoreView.maxRefAttempts - 1);
    clock.stamp = "20480:2000";
    clock.now += 20_000;
    const before = view.stats.queries;
    await view.size(store);
    expect(view.stats.queries - before).toBe(1);
  }, 60_000);
});

describe("cursor: coarse stamps", () => {
  it("shows a new root under an unchanged size and whole-second time at the feed's cadence, asks nothing between polls, fetches only the new blob", async () => {
    expect(CursorStoreView.rootPollMs).toBeLessThan(defaultPollIntervalMs);
    const store = path.join(chatFolder(newHome("coarse")), "store.db");
    const all = replies(["first", "next"]);
    writeStore(store, all, [all[0]!.id]);
    const { view, clock } = clockedView();
    expect(await viewText(view, store)).not.toContain("next");
    const fetched = view.stats.blobsFetched;
    writeStore(store, [], all.map((blob) => blob.id), { fresh: false });
    clock.now += 200;
    const queries = view.stats.queries;
    await view.size(store);
    expect(view.stats.queries).toBe(queries);
    clock.now += defaultPollIntervalMs - 200;
    expect(await viewText(view, store)).toContain("next");
    expect(view.stats.blobsFetched - fetched).toBe(1);
  });
});

describe("cursor: followed per message", () => {
  it("shows each message as it lands; a ref listed before its blob waits; the settled timeline is a fresh read's", async () => {
    const home = newHome("live");
    const folder = chatFolder(home);
    const store = path.join(folder, "store.db");
    const all = blobsOf(cursorSpec.root);
    writeStore(store, all.slice(0, 12), all.slice(0, 12).map((blob) => blob.id));
    writeFileSync(path.join(folder, "meta.json"), JSON.stringify(cursorSpec.metaJSON));
    const reader = new LocalCursorReader(store);
    const feed = new ChatFeed<TranscriptSessionRef>(reader, { pollIntervalMs: 10 });
    feed.start(storeRef(store), [cwd]);
    expect(await eventually(() => turnToolCalls(feed.timeline.turns[0] ?? ({ items: [] } as never)).length === 5)).toBe(true);
    const fetchedAtFirst = reader.view.stats.blobsFetched;
    // The next message's ref lands in the root before its blob: it waits.
    writeStore(store, [], all.slice(0, 14).map((blob) => blob.id), { fresh: false });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(turnToolCalls(feed.timeline.turns[0]!)).toHaveLength(5);
    insertBlobs(store, all.slice(0, 14));
    expect(await eventually(() => turnToolCalls(feed.timeline.turns[0]!).length === 6)).toBe(true);
    expect(reader.view.stats.blobsFetched - fetchedAtFirst).toBeLessThanOrEqual(2);
    for (let end = 15; end <= all.length; end += 1) writeStore(store, all.slice(0, end), all.slice(0, end).map((blob) => blob.id), { fresh: false, ...cursorSpec.context });
    expect(await eventually(() => feed.timeline.turns.length === 2 && turnToolCalls(feed.timeline.turns[1]!).length === 2)).toBe(true);
    const settled = feed.timeline.turns;
    feed.stop();
    const fresh = await follow(new LocalCursorReader(store), store, (timeline) => timeline.turns.length === 2);
    const freshTurns = fresh.timeline.turns;
    fresh.stop();
    expect(settled).toHaveLength(2);
    expect(settled).toEqual(freshTurns);
  });

  it("starts over when the root lists other messages (a compaction)", async () => {
    const home = newHome("rewrite");
    const { store, blobs } = makeStore(home);
    const reader = new LocalCursorReader(store);
    const feed = await follow(reader, store, (timeline) => timeline.turns.length === 2);
    const revision = await reader.storeRevision(store);
    const summary = cursorSpec.root.findIndex((entry) => entry.json?.includes("conversation_summary") === true);
    writeStore(store, [], [blobs[0]!.id, ...blobs.slice(summary).map((blob) => blob.id)], { fresh: false });
    expect(feed.timeline.turns).toHaveLength(2);
    expect(await eventually(() => feed.timeline.turns.length === 2 && feed.timeline.turns[0]!.items.length === 1)).toBe(true);
    const turns = feed.timeline.turns;
    feed.stop();
    expect(await reader.storeRevision(store)).toBe(revision + 1);
    expect(turns[0]!.items[0]!.type).toBe("notice");
    expect(turnToolCalls(turns.at(-1)!).map((call) => call.kind)).toEqual(["bash"]);
    expect(turns.some((turn) => turnUserMessage(turn) !== null)).toBe(false);
  });

  it("reads only the newest window's blobs on a cold load of a large store, and pages back by ref", async () => {
    const home = newHome("large");
    const folder = chatFolder(home);
    const store = path.join(folder, "store.db");
    const filler = "lorem ipsum dolor sit amet ".repeat(150);
    const entries: { json: string }[] = [];
    for (let turn = 0; turn < 600; turn += 1) {
      entries.push(
        { json: JSON.stringify({ role: "user", content: [{ type: "text", text: `<timestamp>Tuesday, Nov 4, 2026, 8:43 AM (UTC+1)</timestamp>\n<user_query>question ${turn}</user_query>` }] }) },
        { json: JSON.stringify({ role: "assistant", content: [{ type: "tool-call", toolCallId: `call-${turn}`, toolName: "Read", args: { path: `/p/f${turn}.swift` } }] }) },
        { json: JSON.stringify({ role: "tool", content: [{ type: "tool-result", toolCallId: `call-${turn}`, toolName: "Read", result: `${turn} ${filler}` }] }) },
        { json: JSON.stringify({ role: "assistant", content: [{ type: "text", text: `answer ${turn}` }] }) },
      );
    }
    const blobs = blobsOf(entries);
    writeStore(store, blobs, blobs.map((blob) => blob.id));
    writeFileSync(path.join(folder, "meta.json"), JSON.stringify(cursorSpec.metaJSON));
    const total = blobs.reduce((sum, blob) => sum + (blob.bytes?.length ?? 0), 0);
    expect(total).toBeGreaterThan(2_400_000);
    const reader = new LocalCursorReader(store);
    const feed = new ChatFeed<TranscriptSessionRef>(reader, { pollIntervalMs: 10, cold: standardColdLoad });
    feed.start(storeRef(store), [cwd]);
    expect(await feed.loaded()).toBe(true);
    const cold = reader.view.stats.blobBytesFetched;
    expect(cold).toBeLessThan(700_000);
    expect(turnUserMessage(feed.timeline.turns.at(-1)!)?.text).toBe("question 599");
    expect(feed.timeline.earlier).toBe("available");
    const turns = feed.timeline.turns.length;
    await feed.loadEarlier();
    expect(reader.view.stats.blobBytesFetched).toBeGreaterThan(cold);
    expect(feed.timeline.turns.length).toBeGreaterThan(turns);
    feed.stop();
    expect(turns).toBeGreaterThan(0);
  }, 30_000);
});

// MARK: - Resume

describe("cursor: the Resume chip", () => {
  const memory = (fields: Record<string, unknown>): never => ({ kind: "cursor", title: "Cursor", terminalID: "term-cursor", session: null, ...fields }) as never;
  const found = `/Users/fixture/.cursor/chats/${cursorFolderHash(cwd)}/${chatID}/store.db`;

  it("offers cursor agent --resume <id>: the chat Chat followed, or Herdr's", () => {
    expect(resumeCommand(memory({ followed: chatID }), absentStartCommands)).toBe(`cursor agent --resume ${chatID}`);
    expect(resumeTitle(memory({ followed: chatID }))).toBe("Resume 3f2a9c1e");
    expect(resumeCommand(memory({ session: { source: "herdr:cursor", agent: "cursor", kind: "path", value: found } }), absentStartCommands)).toBe(`cursor agent --resume ${chatID}`);
    expect(resumeCommand(memory({ followed: chatID }), startCommandsWith({ type: "read" }, { cursor: "~/.local/bin/cursor-agent" }))).toBe(`~/.local/bin/cursor-agent --resume ${chatID}`);
    expect(resumeCommand(memory({ followed: chatID }), startCommandsWith({ type: "read" }, { claude: "cl" }))).toBe(`cursor agent --resume ${chatID}`);
  });

  it("offers nothing with no chat, a title for an id, or a refused start command", () => {
    expect(resumeCommand(memory({}), absentStartCommands)).toBeNull();
    expect(resumeCommand(memory({ followed: "my-chat" }), absentStartCommands)).toBeNull();
    expect(resumeCommand(memory({ followed: chatID }), startCommandsWith({ type: "read" }, { cursor: "cursor-agent; echo x" }))).toBeNull();
    expect(resumeCommand(memory({ followed: chatID }), null)).toBeNull();
  });

  // Herdr's name for run 1 is run 1's; a new unnamed Cursor run in the same
  // terminal keeps none (as the Swift app's followsPerRun), while one run's dropped name is kept.
  it("never offers run 1's named chat after an unnamed run 2 in the same terminal", () => {
    const pane = { paneID: "p", terminalID: "t" };
    const host = (running: boolean, named: boolean): never =>
      ({
        id: "fixture",
        address: "fixture",
        state: "connected",
        topology: {
          panes: [{ ...pane, ...(running ? { agent: "cursor" } : {}) }],
          agents: running
            ? [{ paneID: "p", terminalID: "t", agent: "cursor", ...(named ? { agentSession: { source: "herdr:cursor", agent: "cursor", kind: "id", value: chatID } } : {}) }]
            : [],
        },
      }) as never;
    const exitedMemory = (life: PaneLife): PaneAgentMemory => {
      const ended = host(false, false) as { topology: SessionTopology };
      life.observe(ended as never);
      return life.exited(ended as never, pane as never, ended.topology)!;
    };
    // Run 1 named A: Resume offers A.
    const life = new PaneLife();
    life.observe(host(true, true));
    expect(resumeCommand(exitedMemory(life), absentStartCommands)).toBe(`cursor agent --resume ${chatID}`);
    // Run 2 in the same terminal names none and followed nothing: no chip, never A.
    life.observe(host(true, false));
    expect(resumeCommand(exitedMemory(life), absentStartCommands)).toBeNull();
    // One run whose name drops while it runs keeps its own name.
    const same = new PaneLife();
    same.observe(host(true, true));
    same.observe(host(true, false));
    expect(resumeCommand(exitedMemory(same), absentStartCommands)).toBe(`cursor agent --resume ${chatID}`);
  });
});

// MARK: - the demo

describe("cursor: the demo's Cursor pane", () => {
  it("is found by its folder and reads as a finished chat", async () => {
    const transcripts = demoTranscripts(Date.now());
    const cursorChat = transcripts.find((transcript) => transcript.agent === "cursor")!;
    expect(cursorChat.paneID).toBe("wC:p1");
    expect(isCursorStorePath(cursorChat.path)).toBe(true);
    const reader = new DemoTranscriptReader(transcripts);
    const session = sessionForPane({ agent: "cursor", cwd: cursorChat.cwd })!;
    const feed = new ChatFeed<TranscriptSessionRef>(reader, { pollIntervalMs: 10 });
    feed.start(session.ref, session.paneFolders);
    expect(await eventually(() => feed.timeline.turns.length === 1 && feed.timeline.turns[0]!.isFinished)).toBe(true);
    const turn = feed.timeline.turns[0]!;
    feed.stop();
    expect(turnUserMessage(turn)?.text).toBe("The rate limiter lets one extra request through per window. Fix it and run its tests.");
    expect(turnToolCalls(turn).map((call) => [call.kind, call.state])).toEqual([["read", "ok"], ["search", "ok"], ["edit", "ok"], ["bash", "failed"], ["bash", "ok"]]);
  });
});

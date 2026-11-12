// Mastra Code threads read from their LibSQL mastra.db as Chat's lines (MastraStoreView, through
// the store registry), followed by the feed, and found by Herdr's id. Databases are built here with
// /usr/bin/sqlite3 under the test scratch folder (HERDR_TEST_SCRATCH), their tables as LibSQL makes them
// (mastra 6dec94bc packages/core/src/storage/constants.ts:933-949 TABLE_SCHEMAS, typed by
// stores/libsql/src/storage/db/index.ts:713-727 and made at :755-770; jsonb and timestamp columns are TEXT),
// rows as Mastra writes them (stores/libsql/src/storage/domains/memory/index.ts:907-923 the message upsert,
// `content` the message's JSON and `createdAt` ISO text; :1763 a thread's metadata through `jsonb(?)`), parts
// as AI SDK v4 UI parts (packages/core/src/agent/message-list/state/types.ts:24-130). Never a real thread.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ChatFeed, TranscriptNotFoundError, type ChatFeedState, type TranscriptFileReader } from "../src/shared/chat/feed";
import { locateCommand, makeSessionRef, parseLocateOutput, sessionForPane, sessionFromArgv, sessionRefFromAgentSession, type TranscriptSessionRef } from "../src/shared/chat/locator";
import { turnToolCalls, turnUserMessage } from "../src/shared/chat/model";
import { MastraStoreView } from "../src/shared/chat/agents/mastra-store";
import { mastraViewPath, parseMastraViewPath } from "../src/shared/chat/agents/mastra-locate";
import { isStoreFormat, storeEntryOf } from "../src/shared/chat/stores";

const scratch = realpathSync(process.env["HERDR_TEST_SCRATCH"] || os.tmpdir());
const cwd = "/Users/fixture/project";
const thread = "6f1d3c2a-9b8e-4c7d-a1b2-c3d4e5f60718";
const other = "0a1b2c3d-4e5f-4061-8728-394a5b6c7d8e";
const resource = "mastracode-fixture";
const t0 = Date.parse("2026-11-09T10:15:00.000Z");

function newHome(name: string): string {
  return mkdtempSync(path.join(scratch, `hc-ms-${name}-`));
}

/** The Mac's database (project.ts:180-222): `~/Library/Application Support/mastracode/mastra.db`; Linux's with `linux`. */
function databaseOf(home: string, linux = false): string {
  const folder = linux ? path.join(home, ".local", "share", "mastracode") : path.join(home, "Library", "Application Support", "mastracode");
  mkdirSync(folder, { recursive: true });
  return path.join(folder, "mastra.db");
}

function sqlite(db: string, sql: string): void {
  execFileSync("/usr/bin/sqlite3", ["-init", "/dev/null", "-batch", db], { input: sql, stdio: ["pipe", "ignore", "pipe"] });
}

const text = (value: string): string => "'" + value.split("'").join("''") + "'";
const iso = (ms: number): string => text(new Date(ms).toISOString());

// LibSQL's tables for TABLE_THREADS and TABLE_MESSAGES (constants.ts:933-949), with its message index (memory/index.ts:252).
const tables = `
pragma journal_mode=wal;
create table if not exists mastra_threads ("id" TEXT NOT NULL PRIMARY KEY, "resourceId" TEXT NOT NULL, "title" TEXT NOT NULL, "metadata" TEXT, "createdAt" TEXT NOT NULL, "updatedAt" TEXT NOT NULL);
create table if not exists mastra_messages ("id" TEXT NOT NULL PRIMARY KEY, "thread_id" TEXT NOT NULL, "content" TEXT NOT NULL, "role" TEXT NOT NULL, "type" TEXT NOT NULL, "createdAt" TEXT NOT NULL, "resourceId" TEXT);
create index if not exists idx_messages_thread_created_at on mastra_messages (thread_id, "createdAt");
`;

/** A thread row; its metadata through jsonb() as LibSQL writes it (memory/index.ts:1763), Mastra Code's projectPath tag (thread-startup.ts:103). */
const threadRow = (id: string, folder: string | null): string =>
  `insert into mastra_threads (id, "resourceId", title, metadata, "createdAt", "updatedAt") values (${text(id)}, ${text(resource)}, 'title', ${folder === null ? "null" : `jsonb(${text(JSON.stringify({ projectPath: folder, gitBranch: "main" }))})`}, ${iso(t0)}, ${iso(t0)});\n`;

/** A message upserted as memory/index.ts:907-923 does it. */
const messageRow = (id: string, threadID: string, role: string, at: number, parts: readonly unknown[], format: number = 2): string =>
  `insert into mastra_messages (id, thread_id, content, role, type, "createdAt", "resourceId") values (${text(id)}, ${text(threadID)}, ${text(JSON.stringify({ format, parts }))}, ${text(role)}, 'v2', ${iso(at)}, ${text(resource)})` +
  ` on conflict(id) do update set content=excluded.content, role=excluded.role;\n`;

const picture = "data:image/png;base64," + "iVBORw0KGgo".repeat(40);
const running = (id: string, command: string): unknown => ({ type: "tool-invocation", toolInvocation: { state: "call", toolCallId: id, toolName: "execute_command", args: { command } } });
const finished = (id: string, command: string, output: string): unknown => ({ type: "tool-invocation", toolInvocation: { state: "result", toolCallId: id, toolName: "execute_command", args: { command }, result: { output, exitCode: 0 } } });

/** One thread among another's: a prompt with a picture, the agent's step (thinking, a tool) and its reply. */
function writeThread(db: string, folder: string | null = cwd): void {
  sqlite(
    db,
    tables +
      "begin;\n" +
      threadRow(thread, folder) +
      threadRow(other, "/Users/fixture/elsewhere") +
      messageRow("msg-1", thread, "user", t0, [{ type: "text", text: "Run the tests" }, { type: "file", mimeType: "image/png", data: picture }]) +
      messageRow("msg-x", other, "user", t0 + 500, [{ type: "text", text: "Another thread's prompt" }]) +
      messageRow("msg-2", thread, "assistant", t0 + 1_000, [
        { type: "step-start" },
        { type: "reasoning", reasoning: "", details: [{ type: "text", text: "Run them first." }] },
        finished("call-1", "npm test", "42 passed"),
        { type: "text", text: "All green." },
      ]) +
      "commit;\n",
  );
}

function runHere(command: string, max: number, env?: NodeJS.ProcessEnv): string {
  const result = spawnSync("/bin/sh", ["-c", command], { maxBuffer: Math.max(max, 1_024) * 2, ...(env === undefined ? {} : { env }) });
  return (result.stdout ?? Buffer.alloc(0)).subarray(0, max).toString("utf8");
}

/** A Mac's Mastra Code store read here: queries run under /bin/sh, stamps from stat. */
class LocalMastraReader implements TranscriptFileReader<TranscriptSessionRef> {
  readonly commands: string[] = [];
  readonly view: MastraStoreView;

  constructor(private readonly located: string | null) {
    this.view = new MastraStoreView(
      (command, max) => {
        this.commands.push(command);
        return Promise.resolve(runHere(command, max));
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
    return this.view.size(file);
  }

  read(file: string, offset: number, maxBytes: number): Promise<Uint8Array> {
    return this.view.read(file, offset, maxBytes);
  }

  storeRevision(file: string): Promise<number> {
    return this.view.storeRevision(file);
  }

  storeContext(): Promise<null> {
    return Promise.resolve(null);
  }
}

async function viewText(view: MastraStoreView, file: string): Promise<string> {
  return new TextDecoder().decode(await view.read(file, 0, await view.size(file)));
}

async function eventually(condition: () => boolean, timeoutMs = 8_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return condition();
}

function follow(reader: LocalMastraReader, file: string, folders: readonly string[] = [cwd]): ChatFeed<TranscriptSessionRef> {
  const feed = new ChatFeed<TranscriptSessionRef>(reader, { pollIntervalMs: 10 });
  feed.start(makeSessionRef("mastracode", { kind: "path", path: file })!, folders);
  return feed;
}

const isUnavailable = (state: ChatFeedState, reason: string): boolean => state.status === "unavailable" && state.reason === reason;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const kinds = (body: string): string[] =>
  body
    .split("\n")
    .slice(0, -1)
    .map((line) => {
      const object = JSON.parse(line) as { k: string; i?: number; d?: { type?: string } };
      return object.k === "part" ? `part:${object.d?.type ?? "?"}` : object.k;
    });

describe("mastra store: one thread as lines", () => {
  it("is each part in message order, the user message's line after its parts, the reply's end; a picture's data left out; any range reads the same", async () => {
    const db = databaseOf(newHome("lines"));
    writeThread(db);
    const listed = readdirSync(path.dirname(db)).sort();
    const file = mastraViewPath(db, thread);
    expect(storeEntryOf(file)?.name).toBe("mastracode");
    expect(isStoreFormat("mastracode")).toBe(true);
    const reader = new LocalMastraReader(file);
    const body = await viewText(reader.view, file);
    expect(kinds(body)).toEqual(["part:text", "part:file", "user", "part:step-start", "part:reasoning", "part:tool-invocation", "part:text", "end"]);
    expect(body).not.toContain("iVBORw0KGgo");
    expect(body).not.toContain("Another thread's prompt");
    for (const line of body.split("\n").slice(0, -1)) expect(JSON.parse(line)).toMatchObject({ ms: 1, cwd });
    const size = await reader.view.size(file);
    let pieced = "";
    for (let offset = 0; offset < size; offset += 31) pieced += new TextDecoder().decode(await reader.view.read(file, offset, 31));
    expect(pieced).toBe(body);
    for (const command of reader.commands) {
      expect(command).toContain("/usr/bin/sqlite3 -init /dev/null -readonly -batch");
      expect(command).toContain("mode=ro");
    }
    expect(readdirSync(path.dirname(db)).sort()).toEqual(listed);
  });

  it("follows it: the user's prompt and picture, the agent's thinking, the command with its result, the reply that ends the turn", async () => {
    const db = databaseOf(newHome("follow"));
    writeThread(db);
    const file = mastraViewPath(db, thread);
    const feed = follow(new LocalMastraReader(file), file);
    expect(await eventually(() => feed.timeline.turns.length === 1 && feed.timeline.turns[0]!.isFinished)).toBe(true);
    const turn = feed.timeline.turns[0]!;
    expect(turnUserMessage(turn)?.text).toBe("Run the tests");
    expect(turnUserMessage(turn)?.attachments).toEqual([{ path: null, mediaType: "image/png" }]);
    expect(turnToolCalls(turn).map((call) => [call.kind, call.state])).toEqual([["bash", "ok"]]);
    expect(feed.state.status).toBe("live");
    feed.stop();
  });

  it("a thread Mastra Code did not tag with a folder is shown by its id (no folder to check)", async () => {
    const db = databaseOf(newHome("untagged"));
    writeThread(db, null);
    const file = mastraViewPath(db, thread);
    const reader = new LocalMastraReader(file);
    expect(JSON.parse((await viewText(reader.view, file)).split("\n")[0]!)).toMatchObject({ cwd: null });
    const feed = follow(reader, file);
    expect(await eventually(() => feed.timeline.turns[0]?.isFinished === true)).toBe(true);
    feed.stop();
  });
});

describe("mastra store: a reply being written, and revisions", () => {
  it("holds back the last message from a tool still running; grows as it settles (revision kept); a part rewritten is a new revision", async () => {
    const db = databaseOf(newHome("growing"));
    sqlite(
      db,
      tables +
        threadRow(thread, cwd) +
        messageRow("msg-1", thread, "user", t0, [{ type: "text", text: "Run the tests" }]) +
        messageRow("msg-2", thread, "assistant", t0 + 1_000, [{ type: "step-start" }, { type: "text", text: "Running them." }, running("call-1", "npm test")]),
    );
    const file = mastraViewPath(db, thread);
    const reader = new LocalMastraReader(file);
    const first = await viewText(reader.view, file);
    expect(kinds(first)).toEqual(["part:text", "user", "part:step-start", "part:text"]);
    const feed = follow(new LocalMastraReader(file), file);
    expect(await eventually(() => feed.timeline.turns.length === 1)).toBe(true);
    expect(feed.timeline.turns[0]!.isFinished).toBe(false);
    expect(turnToolCalls(feed.timeline.turns[0]!)).toHaveLength(0);

    sqlite(db, messageRow("msg-2", thread, "assistant", t0 + 1_000, [{ type: "step-start" }, { type: "text", text: "Running them." }, finished("call-1", "npm test", "42 passed"), { type: "text", text: "All green." }]));
    await sleep(5);
    const grown = await viewText(reader.view, file);
    expect(grown.startsWith(first)).toBe(true);
    expect(kinds(grown)).toEqual(["part:text", "user", "part:step-start", "part:text", "part:tool-invocation", "part:text", "end"]);
    expect(await reader.view.storeRevision(file)).toBe(0);
    expect(await eventually(() => feed.timeline.turns[0]!.isFinished && turnToolCalls(feed.timeline.turns[0]!).length === 1, 10_000)).toBe(true);

    // The user's prompt rewritten in place (an upsert): a line already laid out changed, the view starts over.
    sqlite(db, messageRow("msg-1", thread, "user", t0, [{ type: "text", text: "Run the whole suite" }]));
    await sleep(5);
    expect(await viewText(reader.view, file)).toContain("Run the whole suite");
    expect(await reader.view.storeRevision(file)).toBe(1);
    expect(await eventually(() => turnUserMessage(feed.timeline.turns[0]!)?.text === "Run the whole suite", 10_000)).toBe(true);
    expect(feed.timeline.turns).toHaveLength(1);
    feed.stop();
  });
});

describe("mastra store: what is never shown", () => {
  it("a thread tagged with another folder: the folder note, no turn ever shown", async () => {
    const db = databaseOf(newHome("mismatch"));
    writeThread(db, "/Users/fixture/other-project");
    const file = mastraViewPath(db, thread);
    const feed = follow(new LocalMastraReader(file), file);
    expect(await eventually(() => isUnavailable(feed.state, "sessionMismatch"))).toBe(true);
    expect(feed.timeline.turns).toHaveLength(0);
    feed.stop();
  });

  it("a database without a column or table it reads, or messages of another format: the unrecognised-format note", async () => {
    const noMetadata = databaseOf(newHome("nometa"));
    sqlite(
      noMetadata,
      `create table mastra_threads ("id" TEXT NOT NULL PRIMARY KEY, "resourceId" TEXT NOT NULL, "title" TEXT NOT NULL, "createdAt" TEXT NOT NULL, "updatedAt" TEXT NOT NULL);\n` +
        `create table mastra_messages ("id" TEXT NOT NULL PRIMARY KEY, "thread_id" TEXT NOT NULL, "content" TEXT NOT NULL, "role" TEXT NOT NULL, "type" TEXT NOT NULL, "createdAt" TEXT NOT NULL, "resourceId" TEXT);\n` +
        `insert into mastra_threads values (${text(thread)}, ${text(resource)}, 't', ${iso(t0)}, ${iso(t0)});\n` +
        messageRow("msg-1", thread, "user", t0, [{ type: "text", text: "hi" }]),
    );
    const first = mastraViewPath(noMetadata, thread);
    const one = follow(new LocalMastraReader(first), first);
    expect(await eventually(() => isUnavailable(one.state, "unrecognisedFormat"))).toBe(true);
    expect(one.timeline.turns).toHaveLength(0);
    one.stop();

    const noMessages = databaseOf(newHome("notable"));
    sqlite(noMessages, `create table mastra_threads ("id" TEXT NOT NULL PRIMARY KEY, "resourceId" TEXT NOT NULL, "title" TEXT NOT NULL, "metadata" TEXT, "createdAt" TEXT NOT NULL, "updatedAt" TEXT NOT NULL);\n` + threadRow(thread, cwd));
    const second = mastraViewPath(noMessages, thread);
    const two = follow(new LocalMastraReader(second), second);
    expect(await eventually(() => isUnavailable(two.state, "unrecognisedFormat"))).toBe(true);
    two.stop();

    const format3 = databaseOf(newHome("format3"));
    sqlite(format3, tables + threadRow(thread, cwd) + messageRow("msg-1", thread, "user", t0, [{ type: "text", text: "hi" }], 3) + messageRow("msg-2", thread, "assistant", t0 + 1, [{ type: "text", text: "hello" }], 3));
    const third = mastraViewPath(format3, thread);
    const three = follow(new LocalMastraReader(third), third);
    expect(await eventually(() => isUnavailable(three.state, "unrecognisedFormat"))).toBe(true);
    expect(three.timeline.turns).toHaveLength(0);
    three.stop();
  });

  it("a thread not in the database is not found", async () => {
    const db = databaseOf(newHome("gone"));
    writeThread(db);
    const file = mastraViewPath(db, "ffffffff-0000-4000-8000-000000000000");
    const feed = follow(new LocalMastraReader(file), file);
    expect(await eventually(() => isUnavailable(feed.state, "notFound") || isUnavailable(feed.state, "unreadable"))).toBe(true);
    feed.stop();
  });
});

describe("mastra store: binding (Herdr's id, the argv's; never the folder)", () => {
  const run = (command: string, home: string): string => runHere(command, 64 * 1_024, { HOME: home, PATH: "/usr/bin:/bin" });

  it("takes herdr:mastracode ids and `mastracode --thread <id>`; refuses a cloned thread, bad ids and any folder lookup", () => {
    expect(sessionRefFromAgentSession({ source: "herdr:mastracode", agent: "mastracode", kind: "id", value: thread })).toEqual({ format: "mastracode", lookup: { kind: "id", id: thread } });
    expect(sessionRefFromAgentSession({ source: "herdr:mastracode", agent: "mastracode", kind: "id", value: "a b" })).toBeNull();
    expect(sessionFromArgv(["mastracode", "--thread", thread], "mastracode")).toEqual({ source: "herdr:mastracode", agent: "mastracode", kind: "id", value: thread });
    expect(sessionFromArgv(["mastracode", `--thread=${thread}`], "mastracode")?.value).toBe(thread);
    expect(sessionFromArgv(["mastracode", "--thread", thread, "--clone-thread"], "mastracode")).toBeNull();
    expect(sessionFromArgv(["mastracode", "--thread", "$(id)"], "mastracode")).toBeNull();
    expect(makeSessionRef("mastracode", { kind: "folder", folder: cwd })).toBeNull();
    expect(sessionForPane({ agent: "mastracode", cwd })).toBeNull();
    expect(parseMastraViewPath(`/Users/a/Library/Application Support/mastracode/mastra.db#${thread}`)).toEqual({ database: "/Users/a/Library/Application Support/mastracode/mastra.db", thread });
    expect(parseMastraViewPath(`/Users/a/elsewhere/mastra.db#${thread}`)).toBeNull();
    expect(parseMastraViewPath(`/Users/a/mastracode/../mastracode/mastra.db#${thread}`)).toBeNull();
  });

  it("finds the thread in the Mac's database (a folder with a space), else Linux's, by a read-only command; prints nothing for none", () => {
    const home = newHome("locate");
    const mac = databaseOf(home);
    sqlite(mac, tables + threadRow(thread, cwd));
    const listed = readdirSync(path.dirname(mac)).sort();
    const ref = makeSessionRef("mastracode", { kind: "id", id: thread })!;
    expect(parseLocateOutput(run(locateCommand(ref)!, home), ref)).toBe(mastraViewPath(mac, thread));
    expect(readdirSync(path.dirname(mac)).sort()).toEqual(listed);
    const linuxHome = newHome("linux");
    const linux = databaseOf(linuxHome, true);
    sqlite(linux, tables + threadRow(other, cwd));
    const onLinux = makeSessionRef("mastracode", { kind: "id", id: other })!;
    expect(parseLocateOutput(run(locateCommand(onLinux)!, linuxHome), onLinux)).toBe(mastraViewPath(linux, other));
    expect(run(locateCommand(onLinux)!, home)).toBe("");
    expect(run(locateCommand(ref)!, newHome("empty"))).toBe("");
    expect(parseLocateOutput(mastraViewPath(mac, other) + "\n", ref)).toBeNull();
  });
});

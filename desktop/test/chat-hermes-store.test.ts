// Hermes sessions read from their SQLite state.db as Chat's lines (HermesStoreView, through the
// store registry), followed by the feed, and found by Herdr's id. Databases are built here with /usr/bin/sqlite3
// under the test scratch folder (HERDR_TEST_SCRATCH), their tables and triggers as Hermes's own schema makes
// them (hermes-agent fb45ae7a hermes_state_common.py:467-567 `sessions` and `messages`, :793-811 the
// transcript_revision triggers); rows as Hermes writes them (hermes_state_messages.py: content text, tool_calls
// as the OpenAI JSON list; a compaction's `active = 0, compacted = 1`, :74). Never a real session.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ChatFeed, TranscriptNotFoundError, type ChatFeedState, type TranscriptFileReader } from "../src/shared/chat/feed";
import { locateCommand, makeSessionRef, paneSession, parseLocateOutput, sessionForPane, sessionFromArgv, sessionRefFromAgentSession, type TranscriptSessionRef } from "../src/shared/chat/locator";
import { turnToolCalls, turnUserMessage } from "../src/shared/chat/model";
import { HermesStoreView, hermesRowsSQL } from "../src/shared/chat/agents/hermes-store";
import { hermesViewPath, parseHermesViewPath } from "../src/shared/chat/agents/hermes-locate";
import { isStoreFormat, storeEntryOf } from "../src/shared/chat/stores";

const scratch = realpathSync(process.env["HERDR_TEST_SCRATCH"] || os.tmpdir());
const cwd = "/Users/fixture/project";
const session = "20261109_101500_a1b2c3";
const other = "20261109_093000_d4e5f6";
const t0 = 1_762_680_000;

function newHome(name: string): string {
  return mkdtempSync(path.join(scratch, `hc-hm-${name}-`));
}

function databaseOf(home: string, profile: string | null = null): string {
  const folder = profile === null ? path.join(home, ".hermes") : path.join(home, ".hermes", "profiles", profile);
  mkdirSync(folder, { recursive: true });
  return path.join(folder, "state.db");
}

function sqlite(db: string, sql: string): void {
  execFileSync("/usr/bin/sqlite3", ["-init", "/dev/null", "-batch", db], { input: sql, stdio: ["pipe", "ignore", "pipe"] });
}

const text = (value: string): string => "'" + value.split("'").join("''") + "'";

// hermes_state_common.py:467-535 (the columns this reader and Hermes's own writes touch), :537-567 (all), :793-811.
const tables = `
pragma journal_mode=wal;
create table if not exists sessions (id text primary key, source text not null, model text, parent_session_id text, started_at real not null, ended_at real, message_count integer default 0, cwd text, title text, transcript_revision integer not null default 0);
create table if not exists messages (id integer primary key autoincrement, session_id text not null references sessions(id), role text not null, content text, tool_call_id text, tool_calls text, tool_name text, effect_disposition text, timestamp real not null, token_count integer, finish_reason text, reasoning text, reasoning_content text, reasoning_details text, codex_reasoning_items text, codex_message_items text, platform_message_id text, observed integer default 0, _compressed_summary integer not null default 0, active integer not null default 1, compacted integer not null default 0, api_content text, display_kind text, display_metadata text, display_identity blob, display_order integer, message_uid text, absorbed_message_uids text, tool_call_uids text, tool_call_uid text);
create trigger if not exists messages_transcript_revision_update after update of role, content, api_content, tool_calls, tool_call_id, tool_name, reasoning, reasoning_content, reasoning_details on messages
begin update sessions set transcript_revision = transcript_revision + 1 where id = new.session_id; end;
create trigger if not exists messages_display_revision_update after update of codex_reasoning_items, codex_message_items, display_kind, display_metadata on messages
begin update sessions set transcript_revision = transcript_revision + 1 where id = new.session_id; end;
create index if not exists idx_messages_session_active on messages(session_id, active, timestamp);
`;

const sessionRow = (id: string, folder: string | null): string =>
  `insert into sessions (id, source, model, started_at, cwd, title) values (${text(id)}, 'cli', 'claude-sonnet-4', ${t0}, ${folder === null ? "null" : text(folder)}, 'title');\n`;

interface Row {
  readonly role: string;
  readonly content?: string | null;
  readonly toolCalls?: unknown;
  readonly toolCallID?: string;
  readonly toolName?: string;
  readonly finish?: string;
  readonly reasoning?: string;
  readonly active?: number;
  readonly compacted?: number;
  readonly summary?: number;
  readonly kind?: string;
}

const message = (sessionID: string, at: number, row: Row): string =>
  "insert into messages (session_id, role, content, tool_call_id, tool_calls, tool_name, timestamp, finish_reason, reasoning, active, compacted, _compressed_summary, display_kind) values (" +
  [
    text(sessionID),
    text(row.role),
    row.content === undefined || row.content === null ? "null" : text(row.content),
    row.toolCallID === undefined ? "null" : text(row.toolCallID),
    row.toolCalls === undefined ? "null" : text(JSON.stringify(row.toolCalls)),
    row.toolName === undefined ? "null" : text(row.toolName),
    String(at),
    row.finish === undefined ? "null" : text(row.finish),
    row.reasoning === undefined ? "null" : text(row.reasoning),
    String(row.active ?? 1),
    String(row.compacted ?? 0),
    String(row.summary ?? 0),
    row.kind === undefined ? "null" : text(row.kind),
  ].join(", ") +
  ");\n";

const terminalCall = (id: string, command: string): unknown => [{ id, type: "function", function: { name: "terminal", arguments: JSON.stringify({ command }) } }];

/** One session among another's rows: an archived prompt, a taken-back one, then a prompt, a tool step and a reply. */
function writeSession(db: string, folder: string | null = cwd): void {
  sqlite(
    db,
    tables +
      "begin;\n" +
      sessionRow(session, folder) +
      sessionRow(other, "/Users/fixture/elsewhere") +
      message(session, t0, { role: "user", content: "An old prompt the compaction summarised", active: 0, compacted: 1 }) +
      message(other, t0 + 1, { role: "user", content: "Another session's prompt" }) +
      message(session, t0 + 2, { role: "user", content: "A prompt taken back", active: 0, compacted: 0 }) +
      message(session, t0 + 3, { role: "user", content: "Run the tests" }) +
      message(session, t0 + 4, { role: "assistant", content: "", reasoning: "Run them first.", toolCalls: terminalCall("call_1", "npm test"), finish: "tool_calls" }) +
      message(other, t0 + 5, { role: "assistant", content: "Another session's reply", finish: "stop" }) +
      message(session, t0 + 6, { role: "tool", toolCallID: "call_1", toolName: "terminal", content: JSON.stringify({ output: "42 passed", exit_code: 0, error: null }) }) +
      message(session, t0 + 7, { role: "assistant", content: "All green.", finish: "stop" }) +
      "commit;\n",
  );
}

/** Runs a command under /bin/sh here (as over SSH), its stdout up to `max`. */
function runHere(command: string, max: number, env?: NodeJS.ProcessEnv): string {
  const result = spawnSync("/bin/sh", ["-c", command], { maxBuffer: Math.max(max, 1_024) * 2, ...(env === undefined ? {} : { env }) });
  return (result.stdout ?? Buffer.alloc(0)).subarray(0, max).toString("utf8");
}

const stampOf = (file: string): Promise<string | null> => {
  try {
    const stats = statSync(file);
    return Promise.resolve(stats.isFile() ? `${stats.size}:${stats.mtimeMs}` : null);
  } catch {
    return Promise.resolve(null);
  }
};

/** A Mac's Hermes store read here: queries run under /bin/sh, stamps from stat. */
class LocalHermesReader implements TranscriptFileReader<TranscriptSessionRef> {
  readonly commands: string[] = [];
  readonly view: HermesStoreView;

  constructor(private readonly located: string | null) {
    this.view = new HermesStoreView(
      (command, max) => {
        this.commands.push(command);
        return Promise.resolve(runHere(command, max));
      },
      stampOf,
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

async function viewText(view: HermesStoreView, file: string): Promise<string> {
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

function follow(reader: LocalHermesReader, file: string, folders: readonly string[] = [cwd]): ChatFeed<TranscriptSessionRef> {
  const feed = new ChatFeed<TranscriptSessionRef>(reader, { pollIntervalMs: 10 });
  feed.start(makeSessionRef("hermes", { kind: "path", path: file })!, folders);
  return feed;
}

const isUnavailable = (state: ChatFeedState, reason: string): boolean => state.status === "unavailable" && state.reason === reason;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("hermes store: one session as lines", () => {
  it("is the session's active rows in id order (another session's, a compacted and a taken-back row left out); any range reads the same bytes", async () => {
    const db = databaseOf(newHome("lines"));
    writeSession(db);
    const listed = readdirSync(path.dirname(db)).sort();
    const file = hermesViewPath(db, session);
    expect(storeEntryOf(file)?.name).toBe("hermes");
    expect(isStoreFormat("hermes")).toBe(true);
    const reader = new LocalHermesReader(file);
    const body = await viewText(reader.view, file);
    const lines = body.split("\n").slice(0, -1).map((line) => JSON.parse(line) as { hm: number; id: number; cwd: string; d: { role: string; content: string | null } });
    expect(lines.map((line) => [line.id, line.d.role])).toEqual([
      [4, "user"],
      [5, "assistant"],
      [7, "tool"],
      [8, "assistant"],
    ]);
    for (const line of lines) expect(line).toMatchObject({ hm: 1, cwd });
    const size = await reader.view.size(file);
    let pieced = "";
    for (let offset = 0; offset < size; offset += 29) pieced += new TextDecoder().decode(await reader.view.read(file, offset, 29));
    expect(pieced).toBe(body);
    // Every query is read-only sqlite3 on the store; the store's folder gains no file.
    for (const command of reader.commands) {
      expect(command).toContain("/usr/bin/sqlite3 -init /dev/null -readonly -batch");
      expect(command).toContain("mode=ro");
    }
    expect(readdirSync(path.dirname(db)).sort()).toEqual(listed);
    expect(hermesRowsSQL(session, new Set(["active", "compacted"]), 7)).toContain("id>7");
  });

  it("follows it: the user's prompt, the agent's thinking, a terminal call with its result, the reply that ends the turn", async () => {
    const db = databaseOf(newHome("follow"));
    writeSession(db);
    const file = hermesViewPath(db, session);
    const feed = follow(new LocalHermesReader(file), file);
    expect(await eventually(() => feed.timeline.turns.length === 1 && feed.timeline.turns[0]!.isFinished)).toBe(true);
    const turn = feed.timeline.turns[0]!;
    expect(turnUserMessage(turn)?.text).toBe("Run the tests");
    expect(turnToolCalls(turn).map((call) => [call.kind, call.state, call.toolName])).toEqual([["bash", "ok", "terminal"]]);
    expect(feed.state.status).toBe("live");
    feed.stop();
  });
});

describe("hermes store: revisions", () => {
  it("grows as rows come (revision kept); a rewrite (transcript_revision) or a compaction moves it to a new revision and the feed starts over", async () => {
    const db = databaseOf(newHome("revision"));
    writeSession(db);
    const file = hermesViewPath(db, session);
    const reader = new LocalHermesReader(file);
    const first = await viewText(reader.view, file);
    expect(await reader.view.storeRevision(file)).toBe(0);
    sqlite(db, message(session, t0 + 20, { role: "user", content: "Thanks" }) + message(other, t0 + 21, { role: "user", content: "noise" }));
    await sleep(5);
    const grown = await viewText(reader.view, file);
    expect(grown.startsWith(first)).toBe(true);
    expect(grown.length).toBeGreaterThan(first.length);
    expect(await reader.view.storeRevision(file)).toBe(0);
    // An in-place rewrite bumps transcript_revision (the trigger): the same lines, read again.
    sqlite(db, "update messages set content = 'All green, twice.' where id = 8;\n");
    await sleep(5);
    expect(await viewText(reader.view, file)).toContain("All green, twice.");
    expect(await reader.view.storeRevision(file)).toBe(1);
    // A compaction archives the live rows and inserts its summary as new ones: rows went, a new revision.
    sqlite(
      db,
      `update messages set active = 0, compacted = 1 where session_id = ${text(session)} and active = 1;\n` +
        message(session, t0 + 30, { role: "user", content: "[CONTEXT SUMMARY] the tests ran green", summary: 1 }) +
        message(session, t0 + 31, { role: "user", content: "And now the docs" }),
    );
    await sleep(5);
    const compacted = await viewText(reader.view, file);
    expect(compacted).not.toContain("Run the tests");
    expect(await reader.view.storeRevision(file)).toBe(2);

    const feed = follow(new LocalHermesReader(file), file);
    expect(await eventually(() => feed.timeline.turns.some((turn) => turnUserMessage(turn)?.text === "And now the docs"))).toBe(true);
    expect(feed.timeline.turns.some((turn) => turnUserMessage(turn)?.text === "Run the tests")).toBe(false);
    feed.stop();
  });

  it("follows a rewrite live: the feed reads the view again and shows the rewritten row once", async () => {
    const db = databaseOf(newHome("live"));
    writeSession(db);
    const file = hermesViewPath(db, session);
    const feed = follow(new LocalHermesReader(file), file);
    expect(await eventually(() => feed.timeline.turns[0]?.isFinished === true)).toBe(true);
    sqlite(db, "update messages set content = 'Run the tests again' where id = 4;\n");
    expect(await eventually(() => turnUserMessage(feed.timeline.turns[0]!)?.text === "Run the tests again", 10_000)).toBe(true);
    expect(feed.timeline.turns).toHaveLength(1);
    feed.stop();
  });
});

describe("hermes store: what is never shown", () => {
  it("a session filed under another folder: the folder note, no turn ever shown", async () => {
    const db = databaseOf(newHome("mismatch"));
    writeSession(db, "/Users/fixture/other-project");
    const file = hermesViewPath(db, session);
    const feed = follow(new LocalHermesReader(file), file);
    expect(await eventually(() => isUnavailable(feed.state, "sessionMismatch"))).toBe(true);
    expect(feed.timeline.turns).toHaveLength(0);
    feed.stop();
  });

  it("a database without a column or a table it reads: the unrecognised-format note", async () => {
    const noActive = databaseOf(newHome("noactive"));
    sqlite(
      noActive,
      "create table sessions (id text primary key, source text, started_at real, cwd text, transcript_revision integer not null default 0);\n" +
        "create table messages (id integer primary key autoincrement, session_id text, role text, content text, tool_call_id text, tool_calls text, tool_name text, timestamp real);\n" +
        sessionRow(session, cwd).replace("model, ", "").replace("'claude-sonnet-4', ", "").replace(", title", "").replace(", 'title'", "") +
        `insert into messages (session_id, role, content, timestamp) values (${text(session)}, 'user', 'hi', ${t0});\n`,
    );
    const file = hermesViewPath(noActive, session);
    const feed = follow(new LocalHermesReader(file), file);
    expect(await eventually(() => isUnavailable(feed.state, "unrecognisedFormat"))).toBe(true);
    expect(feed.timeline.turns).toHaveLength(0);
    feed.stop();

    const noMessages = databaseOf(newHome("notable"));
    sqlite(noMessages, "create table sessions (id text primary key, source text, started_at real, cwd text, transcript_revision integer not null default 0);\n" + `insert into sessions (id, source, started_at, cwd) values (${text(session)}, 'cli', ${t0}, ${text(cwd)});\n`);
    const second = hermesViewPath(noMessages, session);
    const missing = follow(new LocalHermesReader(second), second);
    expect(await eventually(() => isUnavailable(missing.state, "unrecognisedFormat"))).toBe(true);
    missing.stop();
  });

  it("a session not in the store is not found", async () => {
    const db = databaseOf(newHome("gone"));
    writeSession(db);
    const file = hermesViewPath(db, "20261109_000000_ffffff");
    const feed = follow(new LocalHermesReader(file), file);
    expect(await eventually(() => isUnavailable(feed.state, "notFound") || isUnavailable(feed.state, "unreadable"))).toBe(true);
    feed.stop();
  });
});

describe("hermes store: binding (Herdr's id, the argv's; never the folder)", () => {
  const run = (command: string, home: string): string => runHere(command, 64 * 1_024, { HOME: home, PATH: "/usr/bin:/bin" });

  it("takes herdr:hermes ids and `hermes --resume <id>`; refuses bad ids and any folder lookup", () => {
    expect(sessionRefFromAgentSession({ source: "herdr:hermes", agent: "hermes", kind: "id", value: session })).toEqual({ format: "hermes", lookup: { kind: "id", id: session } });
    expect(sessionRefFromAgentSession({ source: "herdr:hermes", agent: "hermes", kind: "path", value: "/tmp/x" })).toBeNull();
    expect(sessionRefFromAgentSession({ source: "herdr:hermes", agent: "hermes", kind: "id", value: "bad'id" })).toBeNull();
    expect(sessionFromArgv(["hermes", "--resume", session], "hermes")).toEqual({ source: "herdr:hermes", agent: "hermes", kind: "id", value: session });
    expect(sessionFromArgv(["hermes", "-r", "cron_job-1_20261109_101500"], "hermes")?.value).toBe("cron_job-1_20261109_101500");
    expect(sessionFromArgv(["hermes", `--resume=${session}`], "hermes")?.value).toBe(session);
    expect(sessionFromArgv(["hermes", "--resume", "../../etc"], "hermes")).toBeNull();
    expect(makeSessionRef("hermes", { kind: "folder", folder: cwd })).toBeNull();
    // A pane Herdr names no session for has none (a database holds every folder's sessions).
    expect(sessionForPane({ agent: "hermes", cwd })).toBeNull();
    const named = paneSession(
      { agents: [{ paneID: "p1", agent: "hermes", cwd, agentSession: { source: "herdr:hermes", agent: "hermes", kind: "id", value: session } }], panes: [{ paneID: "p1", agent: "hermes", cwd }] },
      "p1",
    );
    expect(named !== null && named !== "ambiguous" ? named.ref : null).toEqual({ format: "hermes", lookup: { kind: "id", id: session } });
    // View paths: a checked database and id only.
    expect(parseHermesViewPath("/Users/a/.hermes/state.db#" + session)).toEqual({ database: "/Users/a/.hermes/state.db", session });
    expect(parseHermesViewPath("/Users/a/.hermes/state.db#bad'id")).toBeNull();
    expect(parseHermesViewPath("/Users/a/other/state.db#" + session)).toBeNull();
    expect(parseHermesViewPath("/Users/a/.hermes/../x/state.db#" + session)).toBeNull();
    expect(parseHermesViewPath("relative/.hermes/state.db#" + session)).toBeNull();
  });

  it("finds the session in the default home's database, else a profile's, by a read-only command; prints nothing for none", () => {
    const home = newHome("locate");
    const main = databaseOf(home);
    const work = databaseOf(home, "work");
    sqlite(main, tables + sessionRow(other, cwd));
    sqlite(work, tables + sessionRow(session, cwd));
    const listed = [readdirSync(path.dirname(main)).sort(), readdirSync(path.dirname(work)).sort()];
    const ref = makeSessionRef("hermes", { kind: "id", id: session })!;
    expect(parseLocateOutput(run(locateCommand(ref)!, home), ref)).toBe(hermesViewPath(work, session));
    const inMain = makeSessionRef("hermes", { kind: "id", id: other })!;
    expect(parseLocateOutput(run(locateCommand(inMain)!, home), inMain)).toBe(hermesViewPath(main, other));
    const none = makeSessionRef("hermes", { kind: "id", id: "20200101_000000_000000" })!;
    expect(run(locateCommand(none)!, home)).toBe("");
    expect(run(locateCommand(ref)!, newHome("empty"))).toBe("");
    // A printed path for another session is refused.
    expect(parseLocateOutput(hermesViewPath(main, other) + "\n", ref)).toBeNull();
    expect([readdirSync(path.dirname(main)).sort(), readdirSync(path.dirname(work)).sort()]).toEqual(listed);
    expect(existsSync(main + "-journal")).toBe(false);
  });
});

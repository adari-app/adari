// OpenCode and Kilo sessions read from their SQLite store as Chat's lines
// (OpenCodeStoreView), followed by the feed. Databases are built here with /usr/bin/sqlite3 under the
// test scratch folder (HERDR_TEST_SCRATCH), their tables as the agents' own migrations make them:
// V1 `session`, `message`, `part` (opencode v1.18.29 packages/core/src/database/migration/
// 20260127222353_familiar_lady_ursula.ts; Kilo's the same), V2 `session_v2` and `session_message`
// (opencode 2.2.5 .../migration/20260804233008_loose_psylocke.ts). Rows' data from the agents' types
// (packages/schema/src/v1/session.ts, packages/schema/src/session-message.ts); never a real session.

import { spawnSync, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ChatTimelineBuilder } from "../src/shared/chat/builder";
import { ChatFeed, TranscriptNotFoundError, type ChatFeedState, type TranscriptFileReader } from "../src/shared/chat/feed";
import { locateCommand, makeSessionRef, parseLocateOutput, type TranscriptSessionRef } from "../src/shared/chat/locator";
import { turnToolCalls, turnUserMessage, type ChatTimeline } from "../src/shared/chat/model";
import { TranscriptParser } from "../src/shared/chat/parser";
import { maxLineBytes } from "../src/shared/chat/follower";
import { OpenCodeStoreView, openCodeQueryCommand, openCodeRowsSQL } from "../src/shared/chat/agents/opencode-store";
import { openCodeViewPath, type OpenCodeFormat } from "../src/shared/chat/agents/opencode-locate";

const scratch = realpathSync(process.env["HERDR_TEST_SCRATCH"] || os.tmpdir());
const cwd = "/Users/fixture/project";
const session = "ses_6a1f0c2b3d4eAbCdEfGhIjKlMn";
const t0 = 1_762_680_000_000;

function newHome(name: string): string {
  return mkdtempSync(path.join(scratch, `hc-oc-${name}-`));
}

function databaseOf(home: string, format: OpenCodeFormat = "opencode"): string {
  const file = format === "opencode" ? "opencode.db" : "kilo.db";
  const folder = path.join(home, ".local", "share", format);
  mkdirSync(folder, { recursive: true });
  return path.join(folder, file);
}

function sqlite(db: string, sql: string): void {
  execFileSync("/usr/bin/sqlite3", ["-init", "/dev/null", "-batch", db], { input: sql, stdio: ["pipe", "ignore", "pipe"] });
}

const text = (value: string): string => "'" + value.split("'").join("''") + "'";
const json = (value: unknown): string => text(JSON.stringify(value));

// familiar_lady_ursula's tables (the columns the reader reads, with the rest as there).
const v1Tables = `
pragma journal_mode=wal;
create table if not exists session (id text primary key, project_id text not null, parent_id text, slug text not null, directory text not null, title text not null, version text not null, share_url text, summary_additions integer, summary_deletions integer, summary_files integer, summary_diffs text, revert text, permission text, time_created integer not null, time_updated integer not null, time_compacting integer, time_archived integer);
create table if not exists message (id text primary key, session_id text not null, time_created integer not null, time_updated integer not null, data text not null);
create table if not exists part (id text primary key, message_id text not null, session_id text not null, time_created integer not null, time_updated integer not null, data text not null);
`;

// loose_psylocke's tables.
const v2Tables = `
pragma journal_mode=wal;
create table if not exists session_v2 (id text primary key, project_id text not null, workspace_id text, parent_id text, fork_session_id text, fork_boundary text, slug text not null, directory text not null, path text, title text, version text not null, share_url text, summary_additions integer, summary_deletions integer, summary_files integer, summary_diffs text, metadata text, cost real default 0 not null, tokens_input integer default 0 not null, tokens_output integer default 0 not null, tokens_reasoning integer default 0 not null, tokens_cache_read integer default 0 not null, tokens_cache_write integer default 0 not null, revert text, permission text, agent text, model text, time_created integer not null, time_updated integer not null, time_compacting integer, time_archived integer, time_suspended integer);
create table if not exists session_message (id text primary key, session_id text not null, type text not null, seq integer not null, time_created integer not null, time_updated integer not null, data text not null);
`;

const v1Session = (id: string, folder: string, updated: number, parent: string | null = null): string =>
  `insert into session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated) values (${text(id)}, 'prj_1', ${parent === null ? "null" : text(parent)}, 'slug', ${text(folder)}, 'title', '1.18.29', ${updated}, ${updated});\n`;
const v2Session = (id: string, folder: string, updated: number, parent: string | null = null): string =>
  `insert into session_v2 (id, project_id, parent_id, slug, directory, version, time_created, time_updated) values (${text(id)}, 'prj_1', ${parent === null ? "null" : text(parent)}, 'slug', ${text(folder)}, '2.2.5', ${updated}, ${updated});\n`;

const message = (id: string, created: number, data: unknown, updated = created, sessionID = session): string =>
  `insert or replace into message (id, session_id, time_created, time_updated, data) values (${text(id)}, ${text(sessionID)}, ${created}, ${updated}, ${json(data)});\n`;
const part = (id: string, messageID: string, created: number, data: unknown, updated = created, sessionID = session): string =>
  `insert or replace into part (id, message_id, session_id, time_created, time_updated, data) values (${text(id)}, ${text(messageID)}, ${text(sessionID)}, ${created}, ${updated}, ${json(data)});\n`;
const row = (id: string, seq: number, created: number, data: { type: string } & Record<string, unknown>, updated = created): string =>
  `insert or replace into session_message (id, session_id, type, seq, time_created, time_updated, data) values (${text(id)}, ${text(session)}, ${text(data.type)}, ${seq}, ${created}, ${updated}, ${json({ id, ...data })});\n`;

const userData = (created: number): Record<string, unknown> => ({ role: "user", time: { created }, agent: "build", model: { providerID: "anthropic", modelID: "claude-sonnet-4" } });
const assistantData = (created: number, fields: Record<string, unknown> = {}): Record<string, unknown> => ({
  role: "assistant",
  time: { created, completed: created + 500 },
  parentID: "msg_01",
  modelID: "claude-sonnet-4",
  providerID: "anthropic",
  mode: "build",
  agent: "build",
  path: { cwd, root: cwd },
  cost: 0,
  tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
  finish: "stop",
  ...fields,
});
const bash = (command: string, output: string, exit: number, start: number): Record<string, unknown> => ({
  type: "tool",
  callID: `toolu_${start}`,
  tool: "bash",
  state: { status: "completed", input: { command, description: command }, output, title: command, metadata: { exit, output }, time: { start, end: start + 100 } },
});

/** One V1 session: a prompt, a tool step, a reply that ends the turn. */
function writeV1(db: string, folder = cwd, sessionID = session): void {
  sqlite(
    db,
    v1Tables +
      "begin;\n" +
      v1Session(sessionID, folder, t0) +
      message("msg_01", t0, userData(t0), t0, sessionID) +
      part("prt_01", "msg_01", t0, { type: "text", text: "Run the tests" }, t0, sessionID) +
      message("msg_02", t0 + 100, assistantData(t0 + 100, { finish: "tool-calls" }), t0 + 700, sessionID) +
      part("prt_02", "msg_02", t0 + 100, { type: "step-start" }, t0 + 100, sessionID) +
      part("prt_03", "msg_02", t0 + 100, bash("npm test", "ok", 0, t0 + 200), t0 + 300, sessionID) +
      message("msg_03", t0 + 800, assistantData(t0 + 800), t0 + 1_300, sessionID) +
      part("prt_04", "msg_03", t0 + 800, { type: "text", text: "All green.", time: { start: t0 + 900, end: t0 + 1_000 } }, t0 + 1_000, sessionID) +
      "commit;\n",
  );
}

/** Runs a command under /bin/sh here (as over SSH), its stdout up to `max`. */
function runHere(command: string, max: number, env?: NodeJS.ProcessEnv): string {
  const result = spawnSync("/bin/sh", ["-c", command], { maxBuffer: Math.max(max, 1_024) * 2, ...(env === undefined ? {} : { env }) });
  return (result.stdout ?? Buffer.alloc(0)).subarray(0, max).toString("utf8");
}

/** A Mac's OpenCode store read here: queries run under /bin/sh, stamps from stat. */
class LocalOpenCodeReader implements TranscriptFileReader<TranscriptSessionRef> {
  readonly commands: string[] = [];
  readonly view: OpenCodeStoreView;

  constructor(private readonly located: string | null) {
    this.view = new OpenCodeStoreView(
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

async function viewText(view: OpenCodeStoreView, file: string): Promise<string> {
  return new TextDecoder().decode(await view.read(file, 0, await view.size(file)));
}

function timelineOfText(format: OpenCodeFormat, body: string): { timeline: ChatTimeline; parser: TranscriptParser } {
  const parser = new TranscriptParser(format);
  const builder = new ChatTimelineBuilder();
  let offset = 0;
  for (const line of body.split("\n")) {
    const at = offset;
    offset += new TextEncoder().encode(line).length + 1;
    if (line !== "") builder.apply(parser.parse(line, at).events, at);
  }
  return { timeline: builder.timeline, parser };
}

async function eventually(condition: () => boolean, timeoutMs = 8_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return condition();
}

const viewRef = (file: string, format: OpenCodeFormat = "opencode"): TranscriptSessionRef => makeSessionRef(format, { kind: "path", path: file })!;

function follow(reader: LocalOpenCodeReader, file: string, folders: readonly string[] = [cwd], format: OpenCodeFormat = "opencode"): ChatFeed<TranscriptSessionRef> {
  const feed = new ChatFeed<TranscriptSessionRef>(reader, { pollIntervalMs: 10 });
  feed.start(viewRef(file, format), folders);
  return feed;
}

const isUnavailable = (state: ChatFeedState, reason: string): boolean => state.status === "unavailable" && state.reason === reason;

describe("opencode store: V1 as lines", () => {
  it("is each part, then its message's line, in order; any range reads the same bytes; the timeline reads right", async () => {
    const db = databaseOf(newHome("v1"));
    writeV1(db);
    const listed = readdirSync(path.dirname(db)).sort();
    const file = openCodeViewPath(db, session);
    const reader = new LocalOpenCodeReader(file);
    const body = await viewText(reader.view, file);
    const lines = body.split("\n").slice(0, -1);
    expect(lines.map((line) => { const o = JSON.parse(line) as { k: string; id: string }; return `${o.k}:${o.id}`; })).toEqual([
      "part:prt_01",
      "user:msg_01",
      "part:prt_02",
      "part:prt_03",
      "msg:msg_02",
      "part:prt_04",
      "msg:msg_03",
    ]);
    for (const line of lines) expect(JSON.parse(line)).toMatchObject({ oc: "v1", cwd });
    const size = await reader.view.size(file);
    let pieced = "";
    for (let offset = 0; offset < size; offset += 37) pieced += new TextDecoder().decode(await reader.view.read(file, offset, 37));
    expect(pieced).toBe(body);
    const { timeline, parser } = timelineOfText("opencode", body);
    expect(parser.stats.unparseable).toBe(0);
    expect(timeline.turns).toHaveLength(1);
    expect(turnUserMessage(timeline.turns[0]!)?.text).toBe("Run the tests");
    expect(turnToolCalls(timeline.turns[0]!).map((call) => [call.kind, call.state])).toEqual([["bash", "ok"]]);
    expect(timeline.turns[0]!.isFinished).toBe(true);
    // Every query is read-only sqlite3 on the store; the store's folder gains no file.
    for (const command of reader.commands) {
      expect(command).toContain("/usr/bin/sqlite3 -init /dev/null -readonly -batch");
      expect(command).toContain("mode=ro");
    }
    expect(readdirSync(path.dirname(db)).sort()).toEqual(listed);
  });

  it("reads a Kilo store (kilo.db, the same tables) the same way", async () => {
    const db = databaseOf(newHome("kilo"), "kilo");
    writeV1(db);
    const file = openCodeViewPath(db, session);
    const feed = follow(new LocalOpenCodeReader(file), file, [cwd], "kilo");
    expect(await eventually(() => feed.timeline.turns.length === 1 && feed.timeline.turns[0]!.isFinished)).toBe(true);
    feed.stop();
  });

  it("asks only for what changed: a refresh lists the rows updated since, a read fetches only the rows it covers", async () => {
    const db = databaseOf(newHome("delta"));
    writeV1(db);
    const file = openCodeViewPath(db, session);
    const reader = new LocalOpenCodeReader(file);
    await viewText(reader.view, file);
    const fetched = reader.view.stats.rowsFetched;
    sqlite(db, message("msg_04", t0 + 5_000, userData(t0 + 5_000), t0 + 5_000) + part("prt_05", "msg_04", t0 + 5_000, { type: "text", text: "Thanks" }, t0 + 5_000));
    const before = await reader.view.size(file).then(() => reader.view.stats.rowsFetched);
    expect(before).toBe(fetched);
    const sizeBefore = (await viewText(reader.view, file)).length;
    expect(reader.view.stats.rowsFetched - fetched).toBeLessThanOrEqual(7 + 1);
    const tail = new TextDecoder().decode(await reader.view.read(file, sizeBefore - 200, 200));
    expect(tail).toContain('"k":"user","id":"msg_04"');
    expect(openCodeRowsSQL("v1", session, t0 + 1_300)).toContain(`time_updated>=${t0 + 1_300}`);
    expect(() => openCodeRowsSQL("v1", "ses_x' or 1=1 --", 0)).toThrow();
    expect(openCodeQueryCommand("/tmp/elsewhere.db", "select 1;")).toBeNull();
  });
});

describe("opencode store: V2 as lines", () => {
  it("is one line per message in seq order, preferred over V1's tables when both hold the session", async () => {
    const db = databaseOf(newHome("v2"));
    // A V1 store V2 moved into its own tables (loose_psylocke keeps V1's): V2's rows are the session's.
    writeV1(db);
    sqlite(
      db,
      v2Tables +
        "begin;\n" +
        v2Session(session, cwd, t0) +
        row("msg_a1", 1, t0, { type: "user", text: "From V2", time: { created: t0 } }) +
        row("msg_a2", 2, t0 + 100, {
          type: "assistant",
          agent: "build",
          model: { providerID: "anthropic", id: "claude-sonnet-4" },
          content: [
            { type: "tool", id: "call_1", name: "read", state: { status: "completed", input: { path: "src/a.ts" }, content: [{ type: "text", text: "1: x" }] }, time: { created: t0 + 110 } },
            { type: "text", text: "Read it." },
          ],
          finish: "stop",
          time: { created: t0 + 100, completed: t0 + 400 },
        }) +
        row("msg_a3", 3, t0 + 450, { type: "idle", outcome: "succeeded", time: { created: t0 + 450 } }) +
        "commit;\n",
    );
    const file = openCodeViewPath(db, session);
    const reader = new LocalOpenCodeReader(file);
    const body = await viewText(reader.view, file);
    expect(body.split("\n").slice(0, -1).map((line) => (JSON.parse(line) as { type: string }).type)).toEqual(["user", "assistant", "idle"]);
    const { timeline, parser } = timelineOfText("opencode", body);
    expect(parser.stats.unparseable).toBe(0);
    expect(turnUserMessage(timeline.turns[0]!)?.text).toBe("From V2");
    expect(turnToolCalls(timeline.turns[0]!).map((call) => [call.kind, call.target])).toEqual([["read", "src/a.ts"]]);
    expect(timeline.turns[0]!.isFinished).toBe(true);
  });

  it("holds back the assistant row still being written; shows it once complete", async () => {
    const db = databaseOf(newHome("v2live"));
    sqlite(db, v2Tables + v2Session(session, cwd, t0) + row("msg_b1", 1, t0, { type: "user", text: "Go", time: { created: t0 } }));
    const open = (texts: string[], completed: boolean, updated: number): string =>
      row(
        "msg_b2",
        2,
        t0 + 100,
        { type: "assistant", agent: "build", model: { providerID: "p", id: "m" }, content: texts.map((value) => ({ type: "text", text: value })), time: completed ? { created: t0 + 100, completed: updated } : { created: t0 + 100 } },
        updated,
      );
    sqlite(db, open(["Work"], false, t0 + 200));
    const file = openCodeViewPath(db, session);
    const reader = new LocalOpenCodeReader(file);
    const feed = follow(reader, file);
    expect(await eventually(() => feed.timeline.turns.length === 1)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(feed.timeline.turns[0]!.items.map((item) => item.type)).toEqual(["user"]);
    sqlite(db, open(["Working on it", "Done."], true, t0 + 900) + row("msg_b3", 3, t0 + 950, { type: "idle", outcome: "succeeded", time: { created: t0 + 950 } }));
    expect(await eventually(() => feed.timeline.turns[0]!.isFinished)).toBe(true);
    expect(feed.timeline.turns[0]!.items.map((item) => item.type)).toEqual(["user", "agentText", "agentText"]);
    expect(await reader.storeRevision(file)).toBe(0);
    feed.stop();
  });
});

describe("opencode store: followed", () => {
  it("shows each part as it settles (a text written at its start and end, a tool pending, running, completed), never a line moved; the settled timeline is a fresh read's", async () => {
    const db = databaseOf(newHome("live"));
    sqlite(db, v1Tables + v1Session(session, cwd, t0) + message("msg_01", t0, userData(t0)) + part("prt_01", "msg_01", t0, { type: "text", text: "Go" }));
    const file = openCodeViewPath(db, session);
    const reader = new LocalOpenCodeReader(file);
    const feed = follow(reader, file);
    expect(await eventually(() => feed.timeline.turns.length === 1)).toBe(true);
    let at = t0 + 100;
    const step = (sql: string): void => {
      at += 100;
      sqlite(db, sql);
    };
    const running = assistantData(t0 + 100, { finish: undefined, time: { created: t0 + 100 } });
    // processor.ts: the message, then a text part written empty at its start.
    step(message("msg_02", t0 + 100, running, at) + part("prt_02", "msg_02", t0 + 150, { type: "text", text: "", time: { start: t0 + 150 } }, at));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(feed.timeline.turns[0]!.items.map((item) => item.type)).toEqual(["user"]);
    step(part("prt_02", "msg_02", t0 + 150, { type: "text", text: "Running it.", time: { start: t0 + 150, end: t0 + 160 } }, at));
    expect(await eventually(() => feed.timeline.turns[0]!.items.some((item) => item.type === "agentText"))).toBe(true);
    const pending = (status: string): Record<string, unknown> => ({ type: "tool", callID: "toolu_x", tool: "bash", state: { status, input: { command: "make" }, ...(status === "running" ? { time: { start: at } } : { raw: "" }) } });
    step(part("prt_03", "msg_02", t0 + 170, pending("pending"), at));
    step(part("prt_03", "msg_02", t0 + 170, pending("running"), at));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(turnToolCalls(feed.timeline.turns[0]!)).toHaveLength(0);
    step(part("prt_03", "msg_02", t0 + 170, bash("make", "built", 0, t0 + 180), at));
    expect(await eventually(() => turnToolCalls(feed.timeline.turns[0]!).length === 1)).toBe(true);
    step(message("msg_02", t0 + 100, assistantData(t0 + 100), at));
    expect(await eventually(() => feed.timeline.turns[0]!.isFinished)).toBe(true);
    expect(await reader.storeRevision(file)).toBe(0);
    const settled = feed.timeline.turns;
    feed.stop();
    const fresh = follow(new LocalOpenCodeReader(file), file);
    expect(await eventually(() => fresh.timeline.turns.length === 1 && fresh.timeline.turns[0]!.isFinished)).toBe(true);
    const freshTurns = fresh.timeline.turns;
    fresh.stop();
    expect(settled).toEqual(freshTurns);
  });

  it("starts over when rows went (a revert) or one was rewritten; a store gone is not found", async () => {
    const db = databaseOf(newHome("revert"));
    writeV1(db);
    sqlite(db, message("msg_04", t0 + 5_000, userData(t0 + 5_000)) + part("prt_05", "msg_04", t0 + 5_000, { type: "text", text: "Undo this" }) + message("msg_05", t0 + 5_100, assistantData(t0 + 5_100)) + part("prt_06", "msg_05", t0 + 5_100, { type: "text", text: "Sure." }));
    const file = openCodeViewPath(db, session);
    const reader = new LocalOpenCodeReader(file);
    const feed = follow(reader, file);
    expect(await eventually(() => feed.timeline.turns.length === 2)).toBe(true);
    // revert.ts: the reverted messages and their parts are deleted.
    sqlite(db, "delete from part where message_id in ('msg_04','msg_05'); delete from message where id in ('msg_04','msg_05');");
    expect(await eventually(() => feed.timeline.turns.length === 1)).toBe(true);
    expect(await reader.storeRevision(file)).toBe(1);
    expect(turnUserMessage(feed.timeline.turns[0]!)?.text).toBe("Run the tests");
    feed.stop();
    // A row rewritten between a refresh and a read (a longer output): a placeholder as long, then a new revision.
    const view = new LocalOpenCodeReader(file).view;
    const size = await view.size(file);
    sqlite(db, part("prt_03", "msg_02", t0 + 100, bash("npm test", "ok, and much more output than before", 0, t0 + 200), t0 + 9_000));
    const read = new TextDecoder().decode(await view.read(file, 0, size));
    expect(read).toContain('"bad":"changed"');
    expect(view.stats.placeholders.get("changed")).toBe(1);
    await view.size(file);
    expect(await view.storeRevision(file)).toBe(1);
    expect(await viewText(view, file)).toContain("much more output");
    // The session deleted, or the store gone: not found.
    sqlite(db, `delete from session where id=${text(session)};`);
    await expect(new LocalOpenCodeReader(file).view.size(file)).rejects.toBeInstanceOf(TranscriptNotFoundError);
    await expect(new LocalOpenCodeReader(file).view.size(openCodeViewPath(databaseOf(newHome("none")), session))).rejects.toBeInstanceOf(TranscriptNotFoundError);
  });
});

describe("opencode store: bounds", () => {
  it("makes a row past a line's bound, or one that is not JSON, a short placeholder it never fetches, counted and skipped", async () => {
    const db = databaseOf(newHome("bounds"));
    writeV1(db);
    const huge = Math.ceil(maxLineBytes / 2) + 1_024;
    sqlite(
      db,
      `insert into part (id, message_id, session_id, time_created, time_updated, data) values ('prt_09', 'msg_03', ${text(session)}, ${t0 + 800}, ${t0 + 2_000}, '{"type":"text","text":"'||hex(randomblob(${huge}))||'"}');\n` +
        `insert into part (id, message_id, session_id, time_created, time_updated, data) values ('prt_0a', 'msg_03', ${text(session)}, ${t0 + 800}, ${t0 + 2_000}, 'not json');\n`,
    );
    const file = openCodeViewPath(db, session);
    const reader = new LocalOpenCodeReader(file);
    const body = await viewText(reader.view, file);
    expect(body.length).toBeLessThan(16_384);
    expect(body).toContain('{"oc":"v1","k":"bad","bad":"oversized","id":"prt_09"}');
    expect(body).toContain('{"oc":"v1","k":"bad","bad":"notJSON","id":"prt_0a"}');
    expect(reader.view.stats.bytesFetched).toBeLessThan(16_384);
    expect(reader.view.stats.placeholders.get("oversized")).toBe(1);
    expect(reader.view.stats.placeholders.get("notJSON")).toBe(1);
    const { timeline, parser } = timelineOfText("opencode", body);
    expect(parser.stats.skippedTypes.get("opencode oversized")).toBe(1);
    expect(parser.stats.skippedTypes.get("opencode notJSON")).toBe(1);
    expect(timeline.turns[0]!.isFinished).toBe(true);
    // Every listing and fetch asked for a bounded output.
    expect(reader.commands.every((command) => command.length < 64 * 1_024)).toBe(true);
  });

  it("shows the unrecognised-format note for rows of a newer schema, and the folder note for a session of another folder", async () => {
    const db = databaseOf(newHome("newer"));
    sqlite(db, v2Tables + v2Session(session, cwd, t0) + [1, 2, 3].map((seq) => row(`msg_n${seq}`, seq, t0 + seq, { type: "hologram", time: { created: t0 + seq } })).join(""));
    const file = openCodeViewPath(db, session);
    const newer = follow(new LocalOpenCodeReader(file), file);
    expect(await eventually(() => isUnavailable(newer.state, "unrecognisedFormat"))).toBe(true);
    newer.stop();
    const elsewhere = databaseOf(newHome("mismatch"));
    writeV1(elsewhere, "/Users/fixture/other-project");
    const other = openCodeViewPath(elsewhere, session);
    const mismatch = follow(new LocalOpenCodeReader(other), other);
    expect(await eventually(() => isUnavailable(mismatch.state, "sessionMismatch"))).toBe(true);
    expect(mismatch.timeline.turns).toHaveLength(0);
    mismatch.stop();
  });

  it("reads a store with a WAL and no -shm immutable, creating nothing beside it and changing no byte", async () => {
    const db = databaseOf(newHome("wal"));
    writeV1(db);
    // Closed with its WAL kept and no -shm (an ro open would make the -shm in the agent's folder).
    const wal = `${db}-wal`;
    const shm = `${db}-shm`;
    if (!existsSync(wal)) writeFileSync(wal, "");
    if (existsSync(shm)) unlinkSync(shm);
    const before = readFileSync(db);
    const walBefore = readFileSync(wal);
    const file = openCodeViewPath(db, session);
    const reader = new LocalOpenCodeReader(file);
    expect(await viewText(reader.view, file)).toContain('"k":"msg","id":"msg_03"');
    expect(existsSync(shm)).toBe(false);
    expect(readFileSync(db).equals(before)).toBe(true);
    expect(readFileSync(wal).equals(walBefore)).toBe(true);
    // Neither file: immutable reads it too.
    unlinkSync(wal);
    expect(await viewText(new LocalOpenCodeReader(file).view, file)).toContain('"k":"msg","id":"msg_03"');
    expect(readdirSync(path.dirname(db)).sort()).toEqual(["opencode.db"]);
  });
});

describe("opencode store: finding the session (the locate command run here under a scratch home)", () => {
  const run = (command: string, home: string): string => runHere(command, 64 * 1_024, { HOME: home, PATH: "/usr/bin:/bin" });

  it("prints the folder's newest root session not excluded, V2's table first; by id, the store when it is there", () => {
    const home = newHome("locate");
    const db = databaseOf(home);
    const older = "ses_6a1f0c2b3d40OlderOlderOldr";
    const child = "ses_6a1f0c2b3d41ChildChildChld";
    const elsewhere = "ses_6a1f0c2b3d42ElsewhereElse";
    sqlite(db, v1Tables + v1Session(older, cwd, t0) + v1Session(session, cwd, t0 + 10) + v1Session(child, cwd, t0 + 20, session) + v1Session(elsewhere, "/Users/fixture/x", t0 + 30));
    const listed = readdirSync(path.dirname(db)).sort();
    const folder = makeSessionRef("opencode", { kind: "folder", folder: cwd + "/" })!;
    expect(parseLocateOutput(run(locateCommand(folder)!, home), folder)).toBe(openCodeViewPath(db, session));
    const excluding = makeSessionRef("opencode", { kind: "folder", folder: cwd, exclude: [session] })!;
    expect(parseLocateOutput(run(locateCommand(excluding)!, home), excluding)).toBe(openCodeViewPath(db, older));
    // V2's table answers first once there.
    const v2Newest = "ses_6a1f0c2b3d43VersionTwoVrsn";
    sqlite(db, v2Tables + v2Session(v2Newest, cwd, t0 - 1_000));
    expect(parseLocateOutput(run(locateCommand(folder)!, home), folder)).toBe(openCodeViewPath(db, v2Newest));
    const byID = makeSessionRef("opencode", { kind: "id", id: older })!;
    expect(parseLocateOutput(run(locateCommand(byID)!, home), byID)).toBe(openCodeViewPath(db, older));
    // Kilo's store is its own; a home with none prints nothing.
    const kilo = makeSessionRef("kilo", { kind: "id", id: older })!;
    expect(run(locateCommand(kilo)!, home)).toBe("");
    expect(run(locateCommand(folder)!, newHome("empty"))).toBe("");
    // Nothing was made beside the store (the -wal and -shm macOS's sqlite3 keeps after the writes above stay as they were).
    expect(readdirSync(path.dirname(db)).sort()).toEqual(listed);
  });
});

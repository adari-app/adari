// Cline sessions read whole from their messages.json as Chat's lines (ClineStoreView, through
// the store registry), followed by the feed, and found by the pane's folder. Documents are written here under
// the test scratch folder (HERDR_TEST_SCRATCH) as Cline writes them: the messages file
// `JSON.stringify(buildMessagesFilePayload(…), null, 2)` rewritten in place on every persist (cline 5413dc1
// sdk/packages/core/src/session/stores/session-manifest-store.ts:220-238, src/services/session-data.ts:334-359),
// the manifest `<id>.json` beside it naming `cwd` (sdk/packages/core/fixtures/session/session.json), under
// `~/.cline/data/sessions/<id>/` (sdk/packages/shared/src/storage/paths.ts:158-200). Never a real session.

import { spawnSync } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, readSync, realpathSync, statSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ChatFeed, TranscriptNotFoundError, type ChatFeedState, type TranscriptFileReader } from "../src/shared/chat/feed";
import { locateCommand, makeSessionRef, paneSession, parseLocateOutput, sessionForPane, sessionFromArgv, sessionRefFromAgentSession, type TranscriptSessionRef } from "../src/shared/chat/locator";
import { turnToolCalls, turnUserMessage } from "../src/shared/chat/model";
import { ClineStoreView, clineMaxDocumentBytes } from "../src/shared/chat/agents/cline-store";
import { clineAmbiguousNote, clineAmbiguousReason, clineManifestNeedle, parseClineMessagesPath } from "../src/shared/chat/agents/cline-locate";
import { isStoreFormat, storeEntryOf } from "../src/shared/chat/stores";

const scratch = realpathSync(process.env["HERDR_TEST_SCRATCH"] || os.tmpdir());
const cwd = "/Users/fixture/project";
const session = "1784094124598_rruoq";
const t0 = 1_783_376_868_634;

function newHome(name: string): string {
  return mkdtempSync(path.join(scratch, `hc-cl-${name}-`));
}

/** A session's folder and its two files' paths. */
function sessionOf(home: string, id: string = session): { messages: string; manifest: string } {
  const folder = path.join(home, ".cline", "data", "sessions", id);
  mkdirSync(folder, { recursive: true });
  return { messages: path.join(folder, `${id}.messages.json`), manifest: path.join(folder, `${id}.json`) };
}

/** The manifest as Cline writes it (fixtures/session/session.json; JSON.stringify(…, null, 2)). */
const manifestText = (id: string, folder: string): string =>
  JSON.stringify({ version: 1, session_id: id, source: "cli", pid: 4242, started_at: "2026-11-09T10:00:00.000Z", status: "running", interactive: true, provider: "cline", model: "anthropic/claude-sonnet-4", cwd: folder, workspace_root: folder, enable_tools: true }, null, 2);

interface Message {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly content: readonly unknown[];
  readonly ts: number;
  readonly modelInfo?: unknown;
  readonly metrics?: unknown;
}

/** The messages file (buildMessagesFilePayload, session-data.ts:334-359), written whole as Cline does. */
const documentText = (messages: readonly Message[], fields: Record<string, unknown> = {}): string =>
  JSON.stringify({ version: 1, updated_at: "2026-11-09T10:01:00.000Z", agent: "lead", sessionId: session, origin: "cli", messages, system_prompt: "You are Cline.", ...fields }, null, 2) + "\n";

const prompt: Message = { id: "msg_1", role: "user", content: [{ type: "text", text: '<user_input mode="act">Run the tests</user_input>' }], ts: t0 };
const step: Message = {
  id: "msg_2",
  role: "assistant",
  content: [
    { type: "thinking", thinking: "Run them first." },
    { type: "tool_use", id: "toolu_1", name: "run_commands", input: { commands: ["npm test"] } },
  ],
  ts: t0 + 100,
  modelInfo: { id: "claude-sonnet-4", provider: "anthropic" },
};
const results: Message = { id: "msg_3", role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "42 passed" }] }], ts: t0 + 200 };
const reply: Message = { id: "msg_4", role: "assistant", content: [{ type: "text", text: "All green." }], ts: t0 + 300, metrics: { inputTokens: 10, outputTokens: 5, cost: 0.01 } };

function writeSession(home: string, messages: readonly Message[], folder = cwd): { messages: string; manifest: string } {
  const files = sessionOf(home);
  writeFileSync(files.manifest, manifestText(session, folder));
  writeFileSync(files.messages, documentText(messages));
  return files;
}

function runHere(command: string, max: number, env?: NodeJS.ProcessEnv): string {
  const result = spawnSync("/bin/sh", ["-c", command], { maxBuffer: Math.max(max, 1_024) * 2, ...(env === undefined ? {} : { env }) });
  return (result.stdout ?? Buffer.alloc(0)).subarray(0, max).toString("utf8");
}

/** A Mac's Cline session read here: stamps from stat (whole seconds with `seconds`, as SFTP's), the document read as SFTP would (offset, length). */
class LocalClineReader implements TranscriptFileReader<TranscriptSessionRef> {
  readonly reads: { path: string; offset: number; maxBytes: number }[] = [];
  readonly view: ClineStoreView;

  constructor(
    private readonly located: string | null,
    now?: () => number,
    seconds = false,
  ) {
    this.view = new ClineStoreView(
      (file) => {
        try {
          const stats = statSync(file);
          return Promise.resolve(stats.isFile() ? `${stats.size}:${seconds ? Math.floor(stats.mtimeMs / 1_000) : stats.mtimeMs}` : null);
        } catch {
          return Promise.resolve(null);
        }
      },
      (file, offset, maxBytes) => {
        this.reads.push({ path: file, offset, maxBytes });
        const fd = openSync(file, "r");
        try {
          const buffer = Buffer.alloc(maxBytes);
          const count = readSync(fd, buffer, 0, maxBytes, offset);
          return Promise.resolve(new Uint8Array(buffer.subarray(0, count)));
        } finally {
          closeSync(fd);
        }
      },
      (file) => new TranscriptNotFoundError(file),
      now,
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

async function viewText(view: ClineStoreView, file: string): Promise<string> {
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

function follow(reader: LocalClineReader, file: string, folders: readonly string[] = [cwd]): ChatFeed<TranscriptSessionRef> {
  const feed = new ChatFeed<TranscriptSessionRef>(reader, { pollIntervalMs: 10 });
  feed.start(makeSessionRef("cline", { kind: "path", path: file })!, folders);
  return feed;
}

const isUnavailable = (state: ChatFeedState, reason: string): boolean => state.status === "unavailable" && state.reason === reason;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("cline store: one document as lines", () => {
  it("is one line per message (model and token counts left out), the manifest's folder on each; any range reads the same bytes", async () => {
    const files = writeSession(newHome("lines"), [prompt, step, results, reply]);
    expect(storeEntryOf(files.messages)?.name).toBe("cline");
    expect(isStoreFormat("cline")).toBe(true);
    const reader = new LocalClineReader(files.messages);
    const body = await viewText(reader.view, files.messages);
    const lines = body.split("\n").slice(0, -1).map((line) => JSON.parse(line) as { cl: number; i: number; cwd: string; d: Record<string, unknown> });
    expect(lines.map((line) => [line.i, line.d.id, line.d.role])).toEqual([
      [0, "msg_1", "user"],
      [1, "msg_2", "assistant"],
      [2, "msg_3", "user"],
      [3, "msg_4", "assistant"],
    ]);
    for (const line of lines) {
      expect(line).toMatchObject({ cl: 1, cwd });
      expect(Object.keys(line.d).sort()).toEqual(["content", "id", "role", "ts"]);
    }
    const size = await reader.view.size(files.messages);
    let pieced = "";
    for (let offset = 0; offset < size; offset += 37) pieced += new TextDecoder().decode(await reader.view.read(files.messages, offset, 37));
    expect(pieced).toBe(body);
    // The document is read whole, once (it did not change), and its manifest once for the folder.
    expect(reader.reads.filter((read) => read.path === files.messages)).toEqual([{ path: files.messages, offset: 0, maxBytes: statSync(files.messages).size }]);
    expect(reader.reads.filter((read) => read.path === files.manifest)).toHaveLength(1);
  });

  it("follows it: the user's words without Cline's wrapper, the agent's thinking, the command with its result, the reply that ends the turn", async () => {
    const files = writeSession(newHome("follow"), [prompt, step, results, reply]);
    const feed = follow(new LocalClineReader(files.messages), files.messages);
    expect(await eventually(() => feed.timeline.turns.length === 1 && feed.timeline.turns[0]!.isFinished)).toBe(true);
    const turn = feed.timeline.turns[0]!;
    expect(turnUserMessage(turn)?.text).toBe("Run the tests");
    expect(turnToolCalls(turn).map((call) => [call.kind, call.state])).toEqual([["bash", "ok"]]);
    expect(feed.state.status).toBe("live");
    feed.stop();
  });

  it("takes the document's own folder when it names one", async () => {
    const home = newHome("ownfolder");
    const files = sessionOf(home);
    writeFileSync(files.messages, documentText([prompt, reply], { cwd: "/Users/fixture/own" }));
    const reader = new LocalClineReader(files.messages);
    expect(JSON.parse((await viewText(reader.view, files.messages)).split("\n")[0]!)).toMatchObject({ cwd: "/Users/fixture/own" });
    expect(reader.reads.some((read) => read.path === files.manifest)).toBe(false);
  });
});

describe("cline store: a document rewritten in place", () => {
  it("grows as messages are added (revision kept); a rewrite of what was shown (a compaction) is a new revision and the feed starts over", async () => {
    const files = writeSession(newHome("grows"), [prompt, step]);
    const reader = new LocalClineReader(files.messages);
    const first = await viewText(reader.view, files.messages);
    const feed = follow(new LocalClineReader(files.messages), files.messages);
    expect(await eventually(() => feed.timeline.turns.length === 1 && turnToolCalls(feed.timeline.turns[0]!).length === 1)).toBe(true);
    expect(feed.timeline.turns[0]!.isFinished).toBe(false);

    await sleep(5);
    writeFileSync(files.messages, documentText([prompt, step, results, reply]));
    const grown = await viewText(reader.view, files.messages);
    expect(grown.startsWith(first)).toBe(true);
    expect(await reader.view.storeRevision(files.messages)).toBe(0);
    expect(await eventually(() => feed.timeline.turns[0]!.isFinished)).toBe(true);
    // The model's info added to a message when its turn ends rewrites no line.
    await sleep(5);
    writeFileSync(files.messages, documentText([prompt, { ...step, metrics: { inputTokens: 1 } }, results, reply]));
    expect(await viewText(reader.view, files.messages)).toBe(grown);
    expect(await reader.view.storeRevision(files.messages)).toBe(0);

    // A compaction rewrites the history: a summary in place of the first messages.
    await sleep(5);
    const summary: Message = { id: "msg_s", role: "user", content: [{ type: "text", text: "Summary: the tests ran green." }], ts: t0 + 400 };
    const next: Message = { id: "msg_5", role: "user", content: [{ type: "text", text: "Now the docs" }], ts: t0 + 500 };
    writeFileSync(files.messages, documentText([summary, next]));
    const rewritten = await viewText(reader.view, files.messages);
    expect(rewritten).not.toContain("Run the tests");
    expect(await reader.view.storeRevision(files.messages)).toBe(1);
    expect(await eventually(() => feed.timeline.turns.some((turn) => turnUserMessage(turn)?.text === "Now the docs"))).toBe(true);
    expect(feed.timeline.turns.some((turn) => turnUserMessage(turn)?.text === "Run the tests")).toBe(false);
    feed.stop();
  });

  it("sees a rewrite of the same size in the same second (a whole-second stamp, as SFTP's): the stamp is read again while young", async () => {
    const files = writeSession(newHome("samesecond"), [prompt, reply]);
    const second = 1_784_000_000;
    utimesSync(files.messages, second, second);
    let clock = 5_000_000;
    const reader = new LocalClineReader(files.messages, () => clock, true);
    expect(await viewText(reader.view, files.messages)).toContain("All green.");
    // Rewritten within that second, to the same size: the stamp does not move.
    const before = statSync(files.messages).size;
    writeFileSync(files.messages, documentText([prompt, { ...reply, content: [{ type: "text", text: "All clean." }] }]));
    utimesSync(files.messages, second, second);
    expect(statSync(files.messages).size).toBe(before);
    clock += 1_000;
    expect(await viewText(reader.view, files.messages)).toContain("All clean.");
    expect(await reader.view.storeRevision(files.messages)).toBe(1);
    // Once the stamp is old, an unchanged document is not read again.
    clock += 5_000;
    const reads = reader.reads.length;
    await reader.view.size(files.messages);
    clock += 1_000;
    await reader.view.size(files.messages);
    expect(reader.reads.length).toBe(reads);
  });

  it("a read the writer overlapped (not JSON yet) waits for the next; a document that stays malformed is the unrecognised-format note", async () => {
    const files = writeSession(newHome("overlap"), [prompt, step]);
    let clock = 1_000_000;
    const reader = new LocalClineReader(files.messages, () => clock);
    const whole = documentText([prompt, step, results, reply]);
    writeFileSync(files.messages, whole.slice(0, Math.floor(whole.length / 2)));
    expect(await reader.view.size(files.messages)).toBe(0);
    await sleep(5);
    writeFileSync(files.messages, whole);
    clock += 1_000;
    expect(await viewText(reader.view, files.messages)).toContain("All green.");

    const broken = writeSession(newHome("malformed"), [prompt]);
    writeFileSync(broken.messages, '{"version": 1, "messages": [');
    const feed = follow(new LocalClineReader(broken.messages), broken.messages);
    expect(await eventually(() => isUnavailable(feed.state, "unrecognisedFormat"), 10_000)).toBe(true);
    expect(feed.timeline.turns).toHaveLength(0);
    feed.stop();
  });
});

describe("cline store: what is never shown", () => {
  it("a document over 4 MiB is never read: the unrecognised-format note", async () => {
    const home = newHome("oversize");
    const files = sessionOf(home);
    writeFileSync(files.manifest, manifestText(session, cwd));
    const big: Message = { id: "msg_big", role: "assistant", content: [{ type: "text", text: "x".repeat(clineMaxDocumentBytes) }], ts: t0 };
    writeFileSync(files.messages, documentText([prompt, big]));
    expect(statSync(files.messages).size).toBeGreaterThan(clineMaxDocumentBytes);
    const reader = new LocalClineReader(files.messages);
    const feed = follow(reader, files.messages);
    expect(await eventually(() => isUnavailable(feed.state, "unrecognisedFormat"))).toBe(true);
    expect(feed.timeline.turns).toHaveLength(0);
    expect(reader.reads.filter((read) => read.path === files.messages)).toHaveLength(0);
    feed.stop();
  });

  it("a session of another folder: the folder note, no turn ever shown", async () => {
    const files = writeSession(newHome("mismatch"), [prompt, step, results, reply], "/Users/fixture/other-project");
    const feed = follow(new LocalClineReader(files.messages), files.messages);
    expect(await eventually(() => isUnavailable(feed.state, "sessionMismatch"))).toBe(true);
    expect(feed.timeline.turns).toHaveLength(0);
    feed.stop();
  });

  it("a session whose folder can't be read (no manifest, or another session's) is not shown; another version is the unrecognised-format note", async () => {
    const home = newHome("nofolder");
    const files = sessionOf(home);
    writeFileSync(files.messages, documentText([prompt, reply]));
    const none = follow(new LocalClineReader(files.messages), files.messages);
    expect(await eventually(() => isUnavailable(none.state, "notFound") || isUnavailable(none.state, "unreadable"))).toBe(true);
    expect(none.timeline.turns).toHaveLength(0);
    none.stop();
    writeFileSync(files.manifest, manifestText("1784000000000_other", cwd));
    const wrong = follow(new LocalClineReader(files.messages), files.messages);
    expect(await eventually(() => isUnavailable(wrong.state, "notFound") || isUnavailable(wrong.state, "unreadable"))).toBe(true);
    expect(wrong.timeline.turns).toHaveLength(0);
    wrong.stop();

    const v2 = writeSession(newHome("v2"), [prompt]);
    writeFileSync(v2.messages, documentText([prompt, reply], { version: 2 }));
    const newer = follow(new LocalClineReader(v2.messages), v2.messages);
    expect(await eventually(() => isUnavailable(newer.state, "unrecognisedFormat"))).toBe(true);
    newer.stop();
  });
});

describe("cline store: binding (the pane's folder only)", () => {
  const run = (command: string, home: string): string => runHere(command, 64 * 1_024, { HOME: home, PATH: "/usr/bin:/bin" });

  it("binds a Cline pane by its folder only: Herdr names no Cline session, the argv names none", () => {
    expect(sessionForPane({ agent: "cline", cwd })?.ref).toEqual({ format: "cline", lookup: { kind: "folder", folder: cwd } });
    expect(sessionForPane({ agent: "cline", cwd })?.source).toBe("folder");
    expect(sessionRefFromAgentSession({ source: "herdr:cline", agent: "cline", kind: "id", value: session })).toBeNull();
    expect(sessionFromArgv(["cline", "--id", session], "cline")).toBeNull();
    expect(makeSessionRef("cline", { kind: "id", id: session })).toBeNull();
    expect(makeSessionRef("cline", { kind: "folder", folder: "relative/path" })).toBeNull();
    expect(parseClineMessagesPath(`/Users/a/.cline/data/sessions/${session}/${session}.messages.json`)?.manifest).toBe(`/Users/a/.cline/data/sessions/${session}/${session}.json`);
    expect(parseClineMessagesPath(`/Users/a/.cline/data/sessions/${session}/other.messages.json`)).toBeNull();
    expect(parseClineMessagesPath(`/Users/a/.cline/data/sessions/../${session}/${session}.messages.json`)).toBeNull();
  });

  it("refuses two Cline panes in one folder (Chat can't tell whose), with Cline's note; a pane of another agent there is no peer", () => {
    const machine = { agents: [{ paneID: "p1", agent: "cline", cwd }, { paneID: "p2", agent: "cline", cwd: cwd + "/" }], panes: [] };
    expect(paneSession(machine, "p1")).toBe("ambiguous");
    expect(clineAmbiguousReason("cline")).toBe("ambiguousClineSession");
    expect(clineAmbiguousReason("grok")).toBeNull();
    expect(clineAmbiguousNote).toBe("Two Cline sessions are open in this folder, so Chat can't tell which is this pane's");
    expect(paneSession({ agents: [{ paneID: "p1", agent: "cline", cwd }, { paneID: "p2", agent: "grok", cwd }], panes: [] }, "p1")).not.toBe("ambiguous");
    expect(paneSession({ agents: [{ paneID: "p1", agent: "cline", cwd }, { paneID: "p2", agent: "cline", cwd: "/Users/fixture/elsewhere" }], panes: [] }, "p1")).not.toBe("ambiguous");
  });

  it("finds the newest session whose manifest names exactly the folder, by a read-only command; prints nothing for none", () => {
    const home = newHome("locate");
    const write = (id: string, folder: string, seconds: number): string => {
      const files = sessionOf(home, id);
      writeFileSync(files.manifest, manifestText(id, folder));
      writeFileSync(files.messages, documentText([prompt]));
      utimesSync(files.messages, seconds, seconds);
      return files.messages;
    };
    write("1784000000001_aaaaa", cwd, 1_784_000_100);
    const newest = write("1784000000002_bbbbb", cwd, 1_784_000_300);
    write("1784000000003_ccccc", cwd + "-two", 1_784_000_900);
    write("1784000000004_ddddd", "/Users/fixture/elsewhere", 1_784_000_950);
    const ref = sessionForPane({ agent: "cline", cwd })!.ref;
    const command = locateCommand(ref)!;
    expect(command).toContain(clineManifestNeedle(cwd));
    for (const word of [" rm ", " mv ", "touch", " tee ", " >", "mkdir"]) expect(command.includes(word), word).toBe(false);
    expect(parseLocateOutput(run(command, home), ref)).toBe(newest);
    const trailing = makeSessionRef("cline", { kind: "folder", folder: cwd + "/" })!;
    expect(parseLocateOutput(run(locateCommand(trailing)!, home), trailing)).toBe(newest);
    const none = makeSessionRef("cline", { kind: "folder", folder: "/Users/fixture/nothing" })!;
    expect(run(locateCommand(none)!, home)).toBe("");
    expect(run(command, newHome("empty"))).toBe("");
  });
});

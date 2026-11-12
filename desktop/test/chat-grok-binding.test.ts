// Grok Build in Chat, Away and Changes: which session a pane binds to, how a reply split at a history seam
// reads, a completion's diff, resume IDs, prompts written in chunks, and how a binding follows its run.

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { paneSessions } from "../src/main/away/service";
import { chatSession, herdrSession } from "../src/main/changes/service";
import { ChatService, type ChatHosts, type ChatOwner } from "../src/main/chat/service";
import type { AwayPane } from "../src/shared/away/digest";
import { readPane } from "../src/shared/away/readers";
import { readTools } from "../src/shared/changes/overview";
import { defaultChangesLimits } from "../src/shared/changes/git";
import type { HerdrHostBackend } from "../src/main/herdr/backend";
import { ChatTimelineBuilder } from "../src/shared/chat/builder";
import { ChatFeed } from "../src/shared/chat/feed";
import { TranscriptParser } from "../src/shared/chat/parser";
import { turnToolCalls, type ChatTimeline } from "../src/shared/chat/model";
import { toolChangesFromLines } from "../src/shared/changes/tools";
import type { ChatUpdateEvent } from "../src/shared/ipc-contract";
import {
  excludingGrokSessions,
  grokFolderName,
  grokLookupExcludes,
  grokPeerSession,
  grokSummaryFolder,
  locateCommand,
  makeSessionRef,
  parseLocateOutput,
  sessionForPane,
  type ChatSession,
  type GrokPeerPane,
  type TranscriptSessionRef,
} from "../src/shared/chat/locator";
import { scratch } from "./support/changes-git";
import { PaneLife, resumeOffer } from "../src/shared/pane-life";
import { absentStartCommands } from "../src/shared/start-commands";
import { FakeTranscriptReader } from "./support/chat-lines";
import { paneTopology } from "./support/pane-topology";

const id = "01a19e72-280e-7291-9d2d-8c2ac0bdb217";
const other = "01a19e80-1111-7222-8333-944455556666";
const folder = "/Users/fixture/proj";
const idRef: TranscriptSessionRef = makeSessionRef("grok", { kind: "id", id })!;
const folderRef: TranscriptSessionRef = makeSessionRef("grok", { kind: "folder", folder })!;
const fileIn = (cwd: string, session = id): string => `/Users/fixture/.grok/sessions/${grokFolderName(cwd)}/${session}/updates.jsonl`;
const summaryBeside = (file: string): string => file.slice(0, -"updates.jsonl".length) + "summary.json";

function line(update: object, n = 0): string {
  return JSON.stringify({ timestamp: 1793502000000 + n * 1000, method: "session/update", params: { sessionId: id, update, _meta: { chunkId: n } } });
}
const chunk = (text: string, n = 0): string => line({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } }, n);
const user = (text: string, n = 0): string => line({ sessionUpdate: "user_message_chunk", content: { type: "text", text }, _meta: { promptIndex: 0 } }, n);

/** A session's updates.jsonl (located) and, unless null, its summary.json. */
function putSession(reader: FakeTranscriptReader, file: string, text: string, summary: object | null): void {
  reader.put(file, text, file);
  if (summary !== null) reader.put(summaryBeside(file), JSON.stringify(summary), null);
}

async function stateAfterLoad(reader: FakeTranscriptReader, ref: TranscriptSessionRef, paneFolders: string[]): Promise<{ state: unknown; folder: string | null }> {
  const feed = new ChatFeed(reader, { pollIntervalMs: 5 });
  feed.start(ref, paneFolders);
  try {
    await feed.loaded();
    return { state: feed.state, folder: feed.transcriptFolder };
  } finally {
    feed.stop();
  }
}

describe("the right session or none, by its summary's info.cwd", () => {
  const text = user("Go") + "\n" + chunk("a reply") + "\n";

  it("refuses a valid ID filed under another folder", async () => {
    const reader = new FakeTranscriptReader();
    putSession(reader, fileIn("/other"), text, { info: { cwd: "/other" } });
    expect((await stateAfterLoad(reader, idRef, [folder])).state).toEqual({ status: "unavailable", reason: "sessionMismatch" });
  });

  it("refuses a path lookup whose session is another folder's", async () => {
    const reader = new FakeTranscriptReader();
    const file = fileIn("/other");
    putSession(reader, file, text, { info: { cwd: "/other" } });
    const byPath = makeSessionRef("grok", { kind: "path", path: file })!;
    expect((await stateAfterLoad(reader, byPath, [folder])).state).toEqual({ status: "unavailable", reason: "sessionMismatch" });
  });

  it("refuses a summary that names the folder only in a nested object", async () => {
    const reader = new FakeTranscriptReader();
    putSession(reader, fileIn(folder), text, { info: { cwd: "/another-folder" }, unrelated: { cwd: folder } });
    expect((await stateAfterLoad(reader, folderRef, [folder])).state).toEqual({ status: "unavailable", reason: "sessionMismatch" });
    expect(grokSummaryFolder(new TextEncoder().encode(JSON.stringify({ unrelated: { cwd: folder } })))).toBeNull();
    expect(grokSummaryFolder(new TextEncoder().encode(JSON.stringify({ info: { cwd: "/another-folder/" } })))).toBe("/another-folder");
  });

  it("refuses a session with no summary.json, or one whose info.cwd is not a folder", async () => {
    const none = new FakeTranscriptReader();
    putSession(none, fileIn(folder), text, null);
    expect((await stateAfterLoad(none, idRef, [folder])).state).toEqual({ status: "unavailable", reason: "sessionMismatch" });
    const bad = new FakeTranscriptReader();
    putSession(bad, fileIn(folder), text, { info: { cwd: 7 } });
    expect((await stateAfterLoad(bad, folderRef, [folder])).state).toEqual({ status: "unavailable", reason: "sessionMismatch" });
  });

  it("follows the pane's own session by ID and by folder, the parser carrying its folder", async () => {
    for (const ref of [idRef, folderRef]) {
      const reader = new FakeTranscriptReader();
      putSession(reader, fileIn(folder), text, { info: { cwd: folder, title: "t" }, other: 1 });
      const loaded = await stateAfterLoad(reader, ref, [folder + "/"]);
      expect(loaded.state, ref.lookup.kind).toEqual({ status: "live" });
      expect(loaded.folder, ref.lookup.kind).toBe(folder);
    }
  });
});

/** A synthetic home under the test scratch folder with Grok sessions in it (never ~/.grok). */
function grokHome(): string {
  const home = path.join(scratch, `grok-home-${randomUUID()}`);
  mkdirSync(home, { recursive: true });
  return home;
}

/** A session filed under `cwd` in `home`, its summary naming `cwd`, last written at `stamp` (seconds). */
function putOnDisk(home: string, cwd: string, session: string, stamp: number): string {
  const dir = path.join(home, ".grok", "sessions", grokFolderName(cwd), session);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "summary.json"), JSON.stringify({ info: { cwd } }));
  writeFileSync(path.join(dir, "updates.jsonl"), "{}\n");
  utimesSync(path.join(dir, "updates.jsonl"), stamp, stamp);
  return path.join(dir, "updates.jsonl");
}

/** The locator's command run as a Mac's SSH exec runs it, with HOME the synthetic home. */
function located(home: string, ref: TranscriptSessionRef): string | null {
  const output = execFileSync("/bin/sh", ["-c", locateCommand(ref)!], { env: { PATH: "/usr/bin:/bin", HOME: home }, encoding: "utf8" });
  return parseLocateOutput(output, ref);
}

describe("an unnamed Grok pane never takes a named peer's session", () => {
  const unnamed: GrokPeerPane = { paneID: "A", agent: "grok", cwd: folder };
  const namedByID: GrokPeerPane = { paneID: "B", agent: "grok", cwd: folder, agentSession: { source: "herdr:grok", agent: "grok", kind: "id", value: other } };

  it("skips the session a peer names (by ID) and finds the pane's own, older one", () => {
    const home = grokHome();
    const own = putOnDisk(home, folder, id, 100);
    const peers = putOnDisk(home, folder, other, 200);
    const plain = sessionForPane(unnamed)!;
    expect(located(home, plain.ref), "the newest, unexcluded").toBe(peers);
    const session = grokPeerSession(plain, "A", [unnamed, namedByID]);
    expect(session).not.toBe("ambiguous");
    expect(located(home, (session as ChatSession).ref)).toBe(own);
  });

  it("skips a peer's session named by path too, and finds none when only the peer's is there", () => {
    const home = grokHome();
    const peers = putOnDisk(home, folder, other, 200);
    const byPath: GrokPeerPane = { ...namedByID, agentSession: { source: "herdr:grok", agent: "grok", kind: "path", value: peers } };
    const session = grokPeerSession(sessionForPane(unnamed)!, "A", [unnamed, byPath]) as ChatSession;
    expect(session.ref.lookup).toEqual({ kind: "folder", folder, exclude: [other] });
    expect(located(home, session.ref)).toBeNull();
  });

  it("never parses an excluded session as the pane's", () => {
    const ref = makeSessionRef("grok", { kind: "folder", folder, exclude: [other] })!;
    expect(parseLocateOutput(fileIn(folder, other) + "\n", ref)).toBeNull();
    expect(parseLocateOutput(fileIn(folder, id) + "\n", ref)).toBe(fileIn(folder, id));
    expect(makeSessionRef("grok", { kind: "folder", folder, exclude: ["a title"] })).toBeNull();
  });

  it("refuses when a peer's session cannot be told, and when another unnamed pane shares the folder", () => {
    const unclear: GrokPeerPane = { ...namedByID, agentSession: { source: "herdr:grok", agent: "grok", kind: "path", value: "/Users/fixture/notes/session.jsonl" } };
    expect(grokPeerSession(sessionForPane(unnamed)!, "A", [unnamed, unclear])).toBe("ambiguous");
    expect(grokPeerSession(sessionForPane(unnamed)!, "A", [unnamed, { ...unnamed, paneID: "C" }])).toBe("ambiguous");
    const alone = sessionForPane(unnamed)!;
    expect(grokPeerSession(alone, "A", [unnamed])).toBe(alone);
  });
});

/** A window's page for ChatService: what it was sent. */
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

/** A machine with these agent panes for ChatService; its reader records what it is asked to locate. */
function grokHosts(agents: { paneID: string; agent: string; cwd: string; agentSession?: GrokPeerPane["agentSession"] }[], reader: FakeTranscriptReader & { refs?: TranscriptSessionRef[] }): ChatHosts {
  const refs: TranscriptSessionRef[] = [];
  reader.refs = refs;
  const locate = reader.locate.bind(reader);
  reader.locate = (ref: TranscriptSessionRef) => {
    refs.push(ref);
    return locate(ref);
  };
  const backend = { kind: "herdr", transcripts: () => reader } as unknown as HerdrHostBackend;
  return {
    backend: () => backend,
    pane: (_host, paneId) => {
      const agent = agents.find((candidate) => candidate.paneID === paneId);
      return agent === undefined ? null : ({ paneID: paneId, agent: agent.agent, cwd: agent.cwd } as never);
    },
    agent: (_host, paneId) => (agents.find((candidate) => candidate.paneID === paneId) as never) ?? null,
    hostAgentPanes: () => agents.map((agent) => agent.paneID),
  };
}

describe("Chat's service binds an unnamed pane past its named peers", () => {
  it("looks up pane A's folder without the session pane B names, and refuses two unnamed panes", async () => {
    const reader = new FakeTranscriptReader() as FakeTranscriptReader & { refs?: TranscriptSessionRef[] };
    const hosts = grokHosts(
      [
        { paneID: "A", agent: "grok", cwd: folder },
        { paneID: "B", agent: "grok", cwd: folder, agentSession: { source: "herdr:grok", agent: "grok", kind: "id", value: other } },
      ],
      reader,
    );
    const service = new ChatService(hosts, "chat", { pollIntervalMs: 5 });
    const page = new Page(1);
    service.open(page, "mac", "A");
    const deadline = Date.now() + 3_000;
    while ((reader.refs ?? []).length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(reader.refs?.[0]?.lookup).toEqual({ kind: "folder", folder, exclude: [other] });
    service.closeAll();

    const twoUnnamed = grokHosts(
      [
        { paneID: "A", agent: "grok", cwd: folder },
        { paneID: "C", agent: "grok", cwd: folder },
      ],
      new FakeTranscriptReader(),
    );
    const refused = new ChatService(twoUnnamed, "chat", { pollIntervalMs: 5 });
    const second = new Page(2);
    refused.open(second, "mac", "A");
    expect(second.updates.at(-1)?.state).toEqual({ status: "unavailable", reason: "ambiguousSession" });
    refused.closeAll();
  });
});

/** A machine's snapshot (wire SessionTopology), the parts the session rule reads. */
function topology(agents: { paneID: string; agent: string; cwd: string; agentSession?: GrokPeerPane["agentSession"] }[]): never {
  return { agents, panes: agents.map(({ paneID, agent, cwd }) => ({ paneID, agent, cwd })) } as never;
}

const editLine = (n: number): string =>
  line({ sessionUpdate: "tool_call", toolCallId: `e${n}`, kind: "edit", title: "Edit", rawInput: { file_path: `${folder}/a.txt`, old_string: "old", new_string: "new" } }, n) +
  "\n" +
  line({ sessionUpdate: "tool_call_update", toolCallId: `e${n}`, status: "completed" }, n + 1);

describe("Away and Changes bind a Grok pane as Chat does", () => {
  const pair = topology([
    { paneID: "p1", agent: "grok", cwd: folder },
    { paneID: "p2", agent: "grok", cwd: folder },
  ]);

  it("refuses two unnamed Grok panes in one folder everywhere", () => {
    expect(paneSessions(pair)["p1"]).toBeNull();
    expect(paneSessions(pair)["p2"]).toBeNull();
    expect(chatSession(pair, "p2")).toBeNull();
    expect(herdrSession(pair, "p1")).toBeNull();
  });

  it("gives a no-ID Grok pane Chat follows its transcript in Away, Changes and the Changes overview, peers' sessions excluded", () => {
    const machine = topology([
      { paneID: "p1", agent: "grok", cwd: folder },
      { paneID: "p2", agent: "grok", cwd: folder, agentSession: { source: "herdr:grok", agent: "grok", kind: "id", value: other } },
    ]);
    const lookup = { kind: "folder", folder, exclude: [other] };
    expect(paneSessions(machine)["p1"]?.ref.lookup).toEqual(lookup);
    expect(chatSession(machine, "p1")?.lookup).toEqual(lookup);
    expect(herdrSession(machine, "p1")?.lookup).toEqual(lookup);
    expect(herdrSession(machine, "p2")?.lookup).toEqual({ kind: "id", id: other });
    const alone = topology([{ paneID: "p1", agent: "grok", cwd: folder }]);
    expect(herdrSession(alone, "p1")?.lookup).toEqual({ kind: "folder", folder });
  });

  it("reads a Grok session in Away and Changes only when its summary names the pane's folder", async () => {
    const text = user("Go") + "\n" + editLine(1) + "\n" + chunk("done", 3) + "\n";
    const pane: AwayPane = { paneID: "p1", name: "grok", kind: "grok", folder, status: "done", statusSince: null, session: null };
    const session: ChatSession = { ref: idRef, source: "herdr:grok", paneFolders: [folder] };
    const owned = new FakeTranscriptReader();
    putSession(owned, fileIn(folder), text, { info: { cwd: folder } });
    expect((await readPane(pane, session, owned, 0)).kind).toBe("read");
    expect((await readTools(idRef, folder, owned, defaultChangesLimits)).kind).toBe("read");
    const foreign = new FakeTranscriptReader();
    putSession(foreign, fileIn("/other"), text, { info: { cwd: "/other" } });
    expect((await readPane(pane, session, foreign, 0)).kind).toBe("unreadable");
    expect((await readTools(idRef, folder, foreign, defaultChangesLimits)).kind).toBe("unreadable");
    const nested = new FakeTranscriptReader();
    putSession(nested, fileIn(folder), text, { info: { cwd: "/another-folder" }, unrelated: { cwd: folder } });
    expect((await readPane(pane, { ...session, ref: folderRef, source: "folder" }, nested, 0)).kind).toBe("unreadable");
    expect((await readTools(folderRef, folder, nested, defaultChangesLimits)).kind).toBe("unreadable");
  });
});

/** The reply rows (agentText) and the thinking rows (progress) of a timeline, in order. */
const rows = (timeline: ChatTimeline): string[] =>
  timeline.turns.flatMap((turn) => turn.items.flatMap((item) => (item.type === "agentText" ? [item.value.markdown] : item.type === "progress" ? [`(${item.value.markdown})`] : [])));

/** One parse of the whole text, line by line with offsets. */
function wholeParse(text: string): ChatTimeline {
  const parser = new TranscriptParser("grok");
  const builder = new ChatTimelineBuilder();
  let offset = 0;
  for (const part of text.split("\n")) {
    const at = offset;
    offset += new TextEncoder().encode(part).length + 1;
    if (part !== "") builder.apply(parser.parse(part, at).events, at);
  }
  return builder.timeline;
}

async function coldLoad(text: string): Promise<{ feed: ChatFeed<TranscriptSessionRef>; reader: FakeTranscriptReader }> {
  const reader = new FakeTranscriptReader();
  putSession(reader, fileIn(folder), text, { info: { cwd: folder } });
  const feed = new ChatFeed(reader, { pollIntervalMs: 5, cold: { window: 250, turns: 4, chunkBytes: 250 } });
  feed.start(idRef, [folder]);
  await feed.loaded();
  return { feed, reader };
}

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!condition() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
}

const thought = (text: string, n: number): string => line({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text } }, n);

describe("a reply split by a Load earlier seam reads as one row", () => {
  it("joins a reply a bounded cold load reads in pieces, as one parse does", async () => {
    const text = user("Go") + "\n" + chunk("First", 1) + "\n" + chunk(" then second", 2) + "\n" + chunk(" and third", 3) + "\n";
    const { feed } = await coldLoad(text);
    try {
      expect(rows(feed.timeline)).toEqual(["First then second and third"]);
      expect(rows(feed.timeline)).toEqual(rows(wholeParse(text)));
    } finally {
      feed.stop();
    }
  });

  it("goes on growing the joined row live, and joins thinking too", async () => {
    const text = user("Go") + "\n" + thought("Look", 1) + "\n" + thought("ing", 2) + "\n" + chunk("First", 3) + "\n" + chunk(" then second", 4) + "\n";
    const { feed, reader } = await coldLoad(text);
    try {
      expect(rows(feed.timeline)).toEqual(rows(wholeParse(text)));
      expect(rows(feed.timeline)).toEqual(["(Looking)", "First then second"]);
      reader.append(fileIn(folder), chunk(" and live", 5) + "\n");
      await until(() => rows(feed.timeline).at(-1) === "First then second and live");
      expect(rows(feed.timeline)).toEqual(["(Looking)", "First then second and live"]);
    } finally {
      feed.stop();
    }
  });

  it("keeps two replies a line between them parts as two rows", async () => {
    const text = user("Go") + "\n" + chunk("One", 1) + "\n" + line({ sessionUpdate: "plan", entries: [{ content: "step", status: "pending" }] }, 2) + "\n" + chunk("Two", 3) + "\n";
    const { feed } = await coldLoad(text);
    try {
      expect(rows(feed.timeline)).toEqual(["One", "Two"]);
    } finally {
      feed.stop();
    }
  });
});

/** Lines with their offsets, as a reader gives them. */
function linesOf(text: string): { text: string; offset: number }[] {
  let offset = 0;
  return text
    .split("\n")
    .map((part) => {
      const at = offset;
      offset += new TextEncoder().encode(part).length + 1;
      return { text: part, offset: at };
    })
    .filter((part) => part.text !== "");
}

describe("a completion update's diff is applied", () => {
  const file = `${folder}/a.txt`;
  const start = (preview: object[] = []): string =>
    line({ sessionUpdate: "tool_call", toolCallId: "e", title: "Edit a.txt", kind: "edit", rawInput: { file_path: file }, content: preview, _meta: { "x.ai/tool": { name: "edit_file", kind: "edit" } } }, 1);
  // The reference's completed edit: toolCallId, status, content [diff], rawOutput; no kind, title or rawInput.
  const completed = (oldText: string, newText: string): string =>
    line(
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "e",
        status: "completed",
        content: [{ type: "diff", path: file, oldText, newText, _meta: { details: [{}] } }],
        rawOutput: { type: "EditsApplied", EditsApplied: { old_string: oldText, new_string: newText, tool_output_for_prompt: "Edited a.txt", absolute_path: file } },
      },
      2,
    );

  it("shows the diff a completion-only update carries, and Changes counts its lines", () => {
    const text = user("Go") + "\n" + start() + "\n" + completed("one\ntwo", "one\n2\nthree") + "\n";
    const call = turnToolCalls(wholeParse(text).turns[0]!)[0]!;
    expect(call.kind).toBe("edit");
    expect(call.target).toBe(file);
    expect(call.state).toBe("ok");
    expect(call.detail.type).toBe("diff");
    if (call.detail.type === "diff") expect([call.detail.diff.added, call.detail.diff.removed]).toEqual([2, 1]);
    const changes = toolChangesFromLines(linesOf(text), "grok", folder, true);
    expect(changes.session.map((changed) => [changed.path, changed.added, changed.removed])).toEqual([[file, 2, 1]]);
  });

  it("takes the final diff over the preview when they differ", () => {
    const preview = [{ type: "diff", path: file, oldText: "alpha", newText: "beta" }];
    const text = user("Go") + "\n" + start(preview) + "\n" + completed("alpha", "gamma\ndelta") + "\n";
    const call = turnToolCalls(wholeParse(text).turns[0]!)[0]!;
    expect(call.detail.type).toBe("diff");
    if (call.detail.type === "diff") {
      expect(call.detail.diff.lines.map((diffLine) => diffLine.text)).toEqual(["alpha", "gamma", "delta"]);
      expect([call.detail.diff.added, call.detail.diff.removed]).toEqual([2, 1]);
    }
    const changes = toolChangesFromLines(linesOf(text), "grok", folder, true);
    expect(changes.session.map((changed) => [changed.added, changed.removed])).toEqual([[2, 1]]);
  });
});

describe("a resume ID in the foreground command wins over an older supplied session", () => {
  const supplied = { source: "herdr:grok", agent: "grok", kind: "id", value: other };

  it("takes Grok's argv, then Herdr's session, then its folder", () => {
    expect(sessionForPane({ agent: "grok", cwd: folder, agentSession: supplied }, { argv: ["grok", "--resume", id] })?.ref.lookup).toEqual({ kind: "id", id });
    expect(sessionForPane({ agent: "grok", cwd: folder, agentSession: supplied }, { argv: ["grok"] })?.ref.lookup).toEqual({ kind: "id", id: other });
    expect(sessionForPane({ agent: "grok", cwd: folder, agentSession: supplied }, { argv: ["grok", "--resume", "a title"] })?.ref.lookup).toEqual({ kind: "id", id: other });
    expect(sessionForPane({ agent: "grok", cwd: folder }, { argv: ["grok"] })?.ref.lookup).toEqual({ kind: "folder", folder });
  });

  it("keeps Claude's and Codex's supplied session first", () => {
    const claude = { source: "herdr:claude", agent: "claude", kind: "id", value: other };
    expect(sessionForPane({ agent: "claude", cwd: folder, agentSession: claude }, { argv: ["claude", "--resume", id] })?.ref.lookup).toEqual({ kind: "id", id: other });
    const codex = { source: "herdr:codex", agent: "codex", kind: "id", value: other };
    expect(sessionForPane({ agent: "codex", cwd: folder, agentSession: codex }, { argv: ["codex", "resume", id] })?.ref.lookup).toEqual({ kind: "id", id: other });
  });
});

describe("desktop Resume uses the session Chat followed", () => {
  const host = (panes: Parameters<typeof paneTopology>[0]) => ({ id: "mini", address: "r@mini:22", state: "connected" as const, topology: paneTopology(panes) });

  it("fills grok --resume <the id Chat followed> once an ordinary no-ID Grok pane quits", () => {
    const life = new PaneLife();
    life.observeHosts([host([{ id: "p1", agent: "grok", terminal: "t1" }])]);
    life.followed("mini", "p1", { terminalID: "t1", session: id });
    // /quit: the pane's terminal is a shell again.
    const after = host([{ id: "p1", terminal: "t1" }]);
    life.observeHosts([after]);
    const exited = life.exited(after, after.topology.panes[0]!, after.topology);
    expect(resumeOffer(exited, absentStartCommands)).toEqual({ title: `Resume ${id.slice(0, 8)}`, command: `grok --resume ${id}` });
  });

  it("keeps it for that pane's run only, refuses what is no Grok session id, and lets Herdr's session win", () => {
    const life = new PaneLife();
    life.observeHosts([host([{ id: "p1", agent: "grok", terminal: "t1" }])]);
    life.followed("mini", "p1", { terminalID: "t9", session: id });
    life.followed("mini", "p1", { terminalID: "t1", session: "--latest" });
    life.followed("mini", "p2", { terminalID: "t1", session: id });
    expect(life.memory({ id: "mini", address: "r@mini:22" }, "p1")?.followed ?? null).toBeNull();
    life.followed("mini", "p1", { terminalID: "t1", session: id });
    // It quits, and another Grok run starts in the same terminal: the first run's session is not this one's.
    life.observeHosts([host([{ id: "p1", terminal: "t1" }])]);
    life.observeHosts([host([{ id: "p1", agent: "grok", terminal: "t1" }])]);
    const quit = host([{ id: "p1", terminal: "t1" }]);
    life.observeHosts([quit]);
    expect(resumeOffer(life.exited(quit, quit.topology.panes[0]!, quit.topology), absentStartCommands)).toBeNull();
    // Herdr's own session for the run wins over the one Chat followed.
    const named = new PaneLife();
    named.observeHosts([host([{ id: "p1", agent: "grok", terminal: "t1", session: other }])]);
    named.followed("mini", "p1", { terminalID: "t1", session: id });
    named.observeHosts([quit]);
    expect(resumeOffer(named.exited(quit, quit.topology.panes[0]!, quit.topology), absentStartCommands)?.command).toBe(`grok --resume ${other}`);
  });

  it("sends the Grok session Chat follows, with the pane's terminal, in its updates", async () => {
    const reader = new FakeTranscriptReader();
    putSession(reader, fileIn(folder), user("Go") + "\n" + chunk("a reply") + "\n", { info: { cwd: folder } });
    const hosts = grokHosts([{ paneID: "A", agent: "grok", cwd: folder }], reader);
    const terminal = { ...hosts, pane: (hostId: string, paneId: string) => ({ ...(hosts.pane(hostId, paneId) as object), terminalID: "t1" }) as never };
    const service = new ChatService(terminal, "chat", { pollIntervalMs: 5 });
    const page = new Page(1);
    service.open(page, "mac", "A");
    await until(() => page.updates.at(-1)?.state.status === "live");
    expect(page.updates.at(-1)?.followed).toEqual({ terminalID: "t1", session: id });
    service.closeAll();
  });
});

describe("a prompt written in chunks keeps its exact text", () => {
  const picture = (n: number): string => line({ sessionUpdate: "user_message_chunk", content: { type: "image", mimeType: "image/png", data: "" }, _meta: { promptIndex: 0 } }, n);
  const prompts = (text: string) =>
    wholeParse(text).turns.flatMap((turn) => turn.items.flatMap((item) => (item.type === "user" ? [{ text: item.value.text, attachments: item.value.attachments.map((a) => [a.path, a.mediaType]) }] : [])));

  it("joins the chunks in order with nothing added", () => {
    expect(prompts([user("Hel", 0), user("lo", 1)].join("\n"))).toEqual([{ text: "Hello", attachments: [] }]);
    expect(prompts([user("Fix the ", 0), user("bug\n\nthen ", 1), user("test it", 2)].join("\n"))).toEqual([{ text: "Fix the bug\n\nthen test it", attachments: [] }]);
  });

  it("keeps the spaces around a marker the chunks split", () => {
    const text = [user("Compare ", 0), user("[Image ", 1), user("#1]", 2), user(" with the old one", 3), picture(4)].join("\n");
    expect(prompts(text)).toEqual([{ text: "Compare with the old one", attachments: [[null, "image/png"]] }]);
  });

  it("keeps the spaces around an attachment path the chunks split", () => {
    const upload = "/Users/fixture/.herdr-companion-attachments-0123456789abcdef0123456789abcdef/attachment-5b1d7c2e-8f3a-4e6b-9c0d-1a2b3c4d5e6f.png";
    const text = [user("Look at ", 0), user(upload.slice(0, 40), 1), user(upload.slice(40), 2), user(" and fix it", 3)].join("\n");
    expect(prompts(text)).toEqual([{ text: "Look at and fix it", attachments: [[upload, null]] }]);
  });
});

describe("the followed session belongs to the run that followed it", () => {
  it.each(["t1", "t2"])("never offers a prior run's session after a no-ID run in %s", async (nextTerminal) => {
    const reader = new FakeTranscriptReader();
    putSession(reader, fileIn(folder), user("Old run") + "\n" + chunk("old reply", 1) + "\n", { info: { cwd: folder } });
    let terminal = "t1";
    let running = true;
    const backend = { kind: "herdr", transcripts: () => reader } as unknown as HerdrHostBackend;
    const hosts: ChatHosts = {
      backend: () => backend,
      pane: () => ({ paneID: "A", terminalID: terminal, agent: running ? "grok" : undefined, cwd: folder }) as never,
      agent: () => (running ? ({ paneID: "A", terminalID: terminal, agent: "grok", cwd: folder } as never) : null),
      hostAgentPanes: () => (running ? ["A"] : []),
    };
    const service = new ChatService(hosts, "chat", { pollIntervalMs: 5 });
    const page = new Page(12);
    try {
      // Run 1 follows A and quits; its live feed is kept on the shelf.
      service.open(page, "mac", "A");
      await until(() => page.updates.at(-1)?.followed?.session === id);
      running = false;
      service.refresh();
      // Run 2 starts in the same folder (the same terminal, or a new one) with B on disk.
      putSession(reader, fileIn(folder, other), user("New run") + "\n" + chunk("new reply", 1) + "\n", { info: { cwd: folder } });
      terminal = nextTerminal;
      running = true;
      const before = page.updates.length;
      service.refresh();
      await until(() => page.updates.slice(before).some((event) => event.state.status === "live"));
      const followed = page.updates.slice(before).flatMap((event) => (event.followed === undefined ? [] : [event.followed]));
      expect(followed.filter((value) => value.session === id)).toEqual([]);
      expect(followed.every((value) => value.terminalID === nextTerminal)).toBe(true);
      // The page's Resume after run 2 quits: B (the session run 2 followed) or nothing, never A.
      const life = new PaneLife();
      const current = { id: "mac", address: "fixture:22", state: "connected" as const, topology: paneTopology([{ id: "A", agent: "grok", terminal: nextTerminal }]) };
      life.observeHosts([current]);
      for (const event of page.updates.slice(before)) if (event.followed) life.followed("mac", "A", event.followed);
      const quit = { ...current, topology: paneTopology([{ id: "A", terminal: nextTerminal }]) };
      life.observeHosts([quit]);
      const offer = resumeOffer(life.exited(quit, quit.topology.panes[0]!, quit.topology), absentStartCommands);
      expect([undefined, `grok --resume ${other}`]).toContain(offer?.command);
      expect(offer?.command).not.toBe(`grok --resume ${id}`);
    } finally {
      service.closeAll();
    }
  });

  it("drops a kept no-ID Grok feed once its run ended, and keeps a named session's", async () => {
    const reader = new FakeTranscriptReader();
    putSession(reader, fileIn(folder), user("Old run") + "\n" + chunk("old reply", 1) + "\n", { info: { cwd: folder } });
    let running = true;
    let named = false;
    const backend = { kind: "herdr", transcripts: () => reader } as unknown as HerdrHostBackend;
    const session = () => (named ? { agentSession: { source: "herdr:grok", agent: "grok", kind: "id", value: id } } : {});
    const hosts: ChatHosts = {
      backend: () => backend,
      pane: () => ({ paneID: "A", terminalID: "t1", agent: running ? "grok" : undefined, cwd: folder }) as never,
      agent: () => (running ? ({ paneID: "A", terminalID: "t1", agent: "grok", cwd: folder, ...session() } as never) : null),
      hostAgentPanes: () => (running ? ["A"] : []),
    };
    const service = new ChatService(hosts, "chat", { pollIntervalMs: 5 });
    const page = new Page(13);
    try {
      service.open(page, "mac", "A");
      await until(() => page.updates.at(-1)?.state.status === "live");
      running = false;
      service.refresh();
      expect(service.keptKeys).toEqual([]);
      // A session Herdr names stays kept after its run, for a quick way back.
      named = true;
      running = true;
      service.refresh();
      await until(() => page.updates.at(-1)?.state.status === "live");
      running = false;
      service.refresh();
      expect(service.keptKeys.length).toBe(1);
    } finally {
      service.closeAll();
    }
  });
});

describe("a whitespace-only slice at a history seam keeps its bytes and its run", () => {
  it("keeps First\\n\\n cold and grows one row First\\n\\nlast live", async () => {
    const text = [user("Go"), chunk("First", 1), chunk("\n\n", 2)].join("\n") + "\n";
    expect(rows(wholeParse(text))).toEqual(["First\n\n"]);
    const { feed, reader } = await coldLoad(text);
    try {
      expect(rows(feed.timeline)).toEqual(["First\n\n"]);
      reader.append(fileIn(folder), chunk("last", 3) + "\n");
      await until(() => rows(feed.timeline).some((row) => row.includes("last")));
      expect(rows(feed.timeline)).toEqual(["First\n\nlast"]);
    } finally {
      feed.stop();
    }
  });

  it("keeps the tail when the default 512 KiB window begins inside a 600,000-character chunk", async () => {
    const text = [user("Go"), chunk("x".repeat(600_000), 1), chunk("\n\n", 2)].join("\n") + "\n";
    const reader = new FakeTranscriptReader();
    putSession(reader, fileIn(folder), text, { info: { cwd: folder } });
    const feed = new ChatFeed(reader, { pollIntervalMs: 5, cold: { window: 512 * 1024, turns: 15, chunkBytes: 128 * 1024 } });
    feed.start(idRef, [folder]);
    await feed.loaded();
    const shape = (values: string[]) => values.map((value) => ({ length: value.length, tail: value.slice(-8) }));
    try {
      expect(shape(rows(feed.timeline))).toEqual([{ length: 600_002, tail: "xxxxxx\n\n" }]);
      reader.append(fileIn(folder), chunk("last", 3) + "\n");
      await until(() => rows(feed.timeline).some((row) => row.includes("last")));
      expect(shape(rows(feed.timeline))).toEqual([{ length: 600_006, tail: "xx\n\nlast" }]);
    } finally {
      feed.stop();
    }
  });

  it("does not carry a reply's whitespace into a later reply at a seam", async () => {
    const text = [user("Go"), chunk("One", 1), chunk("\n", 2), thought("Thinking", 3), chunk("Two", 4)].join("\n") + "\n";
    const { feed } = await coldLoad(text);
    try {
      expect(rows(feed.timeline)).toEqual(rows(wholeParse(text)));
    } finally {
      feed.stop();
    }
  });
});

describe("a later unnamed run never rediscovers a previous run's session", () => {
  it.each(["t1", "t2"])("shows none until run 2 writes its own session, then follows it, in %s", async (nextTerminal) => {
    const reader = new FakeTranscriptReader();
    putSession(reader, fileIn(folder), user("Old") + "\n" + chunk("old reply", 1) + "\n", { info: { cwd: folder } });
    let running = true;
    let terminal = "t1";
    const backend = { kind: "herdr", transcripts: () => reader } as unknown as HerdrHostBackend;
    const hosts: ChatHosts = {
      backend: () => backend,
      pane: () => ({ paneID: "A", terminalID: terminal, agent: running ? "grok" : undefined, cwd: folder }) as never,
      agent: () => (running ? ({ paneID: "A", terminalID: terminal, agent: "grok", cwd: folder } as never) : null),
      hostAgentPanes: () => (running ? ["A"] : []),
    };
    const service = new ChatService(hosts, "chat", { pollIntervalMs: 5 });
    const page = new Page(41);
    const life = new PaneLife();
    const host = () => ({
      id: "mac",
      address: "fixture:22",
      state: "connected" as const,
      topology: paneTopology([{ id: "A", terminal, ...(running ? { agent: "grok" } : {}) }]),
    });
    const followedIn = (events: readonly ChatUpdateEvent[]) => events.flatMap((event) => (event.followed === undefined ? [] : [event.followed]));
    try {
      // Run 1 follows A and quits.
      life.observeHosts([host()]);
      service.open(page, "mac", "A");
      await until(() => page.updates.some((event) => event.followed?.session === id));
      for (const event of page.updates) if (event.followed) life.followed("mac", "A", event.followed);
      running = false;
      life.observeHosts([host()]);
      service.refresh();
      expect(service.keptKeys).toEqual([]);
      // Run 2 starts before it writes a transcript: A is still the folder's newest, but it was run 1's.
      terminal = nextTerminal;
      running = true;
      life.observeHosts([host()]);
      const before = page.updates.length;
      service.refresh();
      await until(() => page.updates.slice(before).some((event) => event.state.status === "unavailable" || event.state.status === "live"));
      await new Promise((resolve) => setTimeout(resolve, 25));
      const initial = page.updates.slice(before);
      expect(followedIn(initial)).toEqual([]);
      expect(initial.at(-1)?.state.status).toBe("unavailable");
      // Run 2 writes B: the next snapshot's retry finds it.
      putSession(reader, fileIn(folder, other), user("New run") + "\n" + chunk("new reply", 1) + "\n", { info: { cwd: folder } });
      service.refresh();
      await until(() => page.updates.at(-1)?.followed?.session === other);
      const updates = page.updates.slice(before);
      expect(followedIn(updates).map((value) => value.session)).not.toContain(id);
      expect(page.updates.at(-1)?.followed).toEqual({ terminalID: nextTerminal, session: other });
      for (const event of updates) if (event.followed) life.followed("mac", "A", event.followed);
      // Run 2 quits: Resume offers B.
      running = false;
      const quit = host();
      life.observeHosts([quit]);
      service.refresh();
      const offer = resumeOffer(life.exited(quit, quit.topology.panes[0]!, quit.topology), absentStartCommands);
      expect(offer?.command).toBe(`grok --resume ${other}`);
    } finally {
      service.closeAll();
    }
  });

  it("still follows a previous run's session when the new run names it", async () => {
    const reader = new FakeTranscriptReader();
    putSession(reader, fileIn(folder), user("Old") + "\n" + chunk("old reply", 1) + "\n", { info: { cwd: folder } });
    let running = true;
    let named = false;
    const backend = { kind: "herdr", transcripts: () => reader } as unknown as HerdrHostBackend;
    const session = () => (named ? { agentSession: { source: "herdr:grok", agent: "grok", kind: "id", value: id } } : {});
    const hosts: ChatHosts = {
      backend: () => backend,
      pane: () => ({ paneID: "A", terminalID: "t1", agent: running ? "grok" : undefined, cwd: folder }) as never,
      agent: () => (running ? ({ paneID: "A", terminalID: "t1", agent: "grok", cwd: folder, ...session() } as never) : null),
      hostAgentPanes: () => (running ? ["A"] : []),
    };
    const service = new ChatService(hosts, "chat", { pollIntervalMs: 5 });
    const page = new Page(42);
    try {
      service.open(page, "mac", "A");
      await until(() => page.updates.some((event) => event.followed?.session === id));
      running = false;
      service.refresh();
      // grok --resume A: Herdr names it; Chat follows it again.
      named = true;
      running = true;
      const before = page.updates.length;
      service.refresh();
      await until(() => page.updates.slice(before).some((event) => event.state.status === "live"));
      expect(page.updates.at(-1)?.state.status).toBe("live");
      expect(page.updates.at(-1)?.followed?.session).toBe(id);
    } finally {
      service.closeAll();
    }
  });
});

describe("the lookup's exclusions", () => {
  it("adds earlier runs' sessions to a Grok folder lookup only, and refuses a located excluded session", () => {
    const session: ChatSession = { ref: folderRef, source: "folder", paneFolders: [folder] };
    const excluded = excludingGrokSessions(session, [id]);
    expect(excluded).not.toBe("ambiguous");
    const ref = (excluded as ChatSession).ref;
    expect(ref.lookup).toEqual({ kind: "folder", folder, exclude: [id] });
    expect(grokLookupExcludes(ref, fileIn(folder))).toBe(true);
    expect(grokLookupExcludes(ref, fileIn(folder, other))).toBe(false);
    expect(grokLookupExcludes(folderRef, fileIn(folder))).toBe(false);
    // A named session is never excluded.
    const named: ChatSession = { ref: idRef, source: "herdr:grok", paneFolders: [folder] };
    expect(excludingGrokSessions(named, [id])).toBe(named);
    expect(grokLookupExcludes(idRef, fileIn(folder))).toBe(false);
    // More than the lookup holds: refused.
    const many = Array.from({ length: 65 }, (_, n) => `01a19e72-280e-7291-9d2d-${n.toString(16).padStart(12, "0")}`);
    expect(excludingGrokSessions(session, many)).toBe("ambiguous");
  });
});

describe("a session the current run follows is never excluded", () => {
  /** A machine with pane A in `folder`; its reader locates as the real one does: a named id, else the newest not excluded. */
  function resumedRun() {
    const reader = new FakeTranscriptReader();
    let available: string[] = [];
    reader.locate = async (ref: TranscriptSessionRef) => {
      const lookup = ref.lookup;
      if (lookup.kind === "path") return lookup.path;
      const match = lookup.kind === "id" ? available.find((value) => value === lookup.id) : available.find((value) => !(lookup.exclude ?? []).includes(value));
      return match === undefined ? null : fileIn(folder, match);
    };
    /** A session written now (the folder's newest). */
    const put = (session: string): void => {
      putSession(reader, fileIn(folder, session), user(session) + "\n", { info: { cwd: folder } });
      available = [session, ...available.filter((value) => value !== session)];
    };
    const state = { running: true, terminal: "t1", named: null as string | null };
    const backend = { kind: "herdr", transcripts: () => reader } as unknown as HerdrHostBackend;
    const hosts: ChatHosts = {
      backend: () => backend,
      pane: () => ({ paneID: "A", terminalID: state.terminal, agent: state.running ? "grok" : undefined, cwd: folder }) as never,
      agent: () =>
        state.running
          ? ({
              paneID: "A",
              terminalID: state.terminal,
              agent: "grok",
              cwd: folder,
              ...(state.named === null ? {} : { agentSession: { source: "herdr:grok", agent: "grok", kind: "id", value: state.named } }),
            } as never)
          : null,
      hostAgentPanes: () => (state.running ? ["A"] : []),
    };
    const service = new ChatService(hosts, "chat", { pollIntervalMs: 5 }, { afterMs: 0, maxMs: 0 });
    const page = new Page(60);
    return { put, state, service, page };
  }

  /** Run 1 follows A by folder and quits; run 2 (in `terminal`) resumes A by name; then a snapshot omits its session. */
  async function resumeThenOmit(run: ReturnType<typeof resumedRun>, terminal: string): Promise<ChatUpdateEvent[]> {
    run.service.open(run.page, "mac", "A");
    await until(() => run.page.updates.at(-1)?.followed?.session === id);
    run.state.running = false;
    run.service.refresh();
    run.state.terminal = terminal;
    run.state.running = true;
    run.state.named = id;
    run.service.refresh();
    await until(() => run.page.updates.at(-1)?.followed?.session === id && run.page.updates.at(-1)?.followed?.terminalID === terminal);
    expect(run.page.updates.at(-1)?.followed).toEqual({ terminalID: terminal, session: id });
    const before = run.page.updates.length;
    run.state.named = null;
    run.service.refresh();
    await until(() => run.page.updates.slice(before).some((event) => event.state.status === "live" || event.state.status === "unavailable"));
    await new Promise((resolve) => setTimeout(resolve, 25));
    return run.page.updates.slice(before);
  }

  it.each(["t1", "t2"])("stays on the resumed A, not the older B, when a snapshot omits its session (%s)", async (terminal) => {
    const run = resumedRun();
    try {
      run.put(other);
      run.put(id);
      const after = await resumeThenOmit(run, terminal);
      expect(after.flatMap((event) => (event.followed === undefined ? [] : [event.followed.session]))).not.toContain(other);
      expect(run.page.updates.at(-1)?.state.status).toBe("live");
      expect(run.page.updates.at(-1)?.followed).toEqual({ terminalID: terminal, session: id });
    } finally {
      run.service.closeAll();
    }
  });

  it.each(["t1", "t2"])("stays on the resumed A, not unavailable, with only A in the folder (%s)", async (terminal) => {
    const run = resumedRun();
    try {
      run.put(id);
      await resumeThenOmit(run, terminal);
      expect(run.page.updates.at(-1)?.state.status).toBe("live");
      expect(run.page.updates.at(-1)?.followed).toEqual({ terminalID: terminal, session: id });
    } finally {
      run.service.closeAll();
    }
  });

  it("still shows none for an unnamed run 2 while only run 1's A exists", async () => {
    const run = resumedRun();
    try {
      run.put(id);
      run.service.open(run.page, "mac", "A");
      await until(() => run.page.updates.at(-1)?.followed?.session === id);
      run.state.running = false;
      run.service.refresh();
      run.state.running = true;
      const before = run.page.updates.length;
      run.service.refresh();
      await until(() => run.page.updates.slice(before).some((event) => event.state.status === "live" || event.state.status === "unavailable"));
      await new Promise((resolve) => setTimeout(resolve, 25));
      const after = run.page.updates.slice(before);
      expect(after.flatMap((event) => (event.followed === undefined ? [] : [event.followed]))).toEqual([]);
      expect(run.page.updates.at(-1)?.state.status).toBe("unavailable");
    } finally {
      run.service.closeAll();
    }
  });
});

/** Pane A in `folder` on a machine whose sessions are in a synthetic home, located by the real command. */
function realLocator() {
  const home = grokHome();
  const reader = new FakeTranscriptReader();
  const lookups: TranscriptSessionRef[] = [];
  reader.locate = async (ref: TranscriptSessionRef) => {
    lookups.push(ref);
    return ref.lookup.kind === "path" ? ref.lookup.path : located(home, ref);
  };
  let stamp = 100;
  /** A session written now (the folder's newest), its first prompt its id. */
  const put = (session: string): void => {
    const file = putOnDisk(home, folder, session, (stamp += 1));
    const text = user(session) + "\n";
    writeFileSync(file, text);
    utimesSync(file, stamp, stamp);
    reader.put(file, text, null);
    reader.put(summaryBeside(file), JSON.stringify({ info: { cwd: folder } }), null);
  };
  const state = { running: true, terminal: "t1", named: null as string | null };
  const backend = { kind: "herdr", transcripts: () => reader } as unknown as HerdrHostBackend;
  const hosts: ChatHosts = {
    backend: () => backend,
    pane: () => ({ paneID: "A", terminalID: state.terminal, agent: state.running ? "grok" : undefined, cwd: folder }) as never,
    agent: () =>
      state.running
        ? ({
            paneID: "A",
            terminalID: state.terminal,
            agent: "grok",
            cwd: folder,
            ...(state.named === null ? {} : { agentSession: { source: "herdr:grok", agent: "grok", kind: "id", value: state.named } }),
          } as never)
        : null,
    hostAgentPanes: () => (state.running ? ["A"] : []),
  };
  const service = new ChatService(hosts, "chat", { pollIntervalMs: 5 }, { afterMs: 0, maxMs: 0 });
  const page = new Page(70);
  const life = new PaneLife();
  const host = () => ({
    id: "mac",
    address: "fixture:22",
    state: "connected" as const,
    topology: paneTopology([
      { id: "A", terminal: state.terminal, ...(state.running ? { agent: "grok", ...(state.named === null ? {} : { session: state.named }) } : {}) },
    ]),
  });
  return { put, state, hosts, service, page, life, host, lookups };
}

describe("the current run keeps the session it already follows", () => {
  const third = "01a19e81-2222-7333-8444-955566667777";


  const prompts = (event: ChatUpdateEvent | undefined): string[] =>
    (event?.timeline.turns ?? []).flatMap((turn) => turn.items.flatMap((item) => (item.type === "user" ? [item.value.text] : [])));

  it.each(["t1", "t2"])("stays on resumed A when its name drops while a newer finished C is in the folder (%s)", async (terminal) => {
    const m = realLocator();
    const observe = (): void => {
      m.life.observeHosts([m.host()]);
      for (const event of m.page.updates) if (event.followed) m.life.followed("mac", "A", event.followed);
    };
    try {
      m.put(other); // B, older
      m.put(id); // A, newer
      // Run 1 follows A by folder and quits.
      observe();
      m.service.open(m.page, "mac", "A");
      await until(() => m.page.updates.at(-1)?.followed?.session === id);
      m.state.running = false;
      observe();
      m.service.refresh();
      // Run 2 resumes A by name.
      m.state.terminal = terminal;
      m.state.running = true;
      m.state.named = id;
      observe();
      m.service.refresh();
      await until(() => m.page.updates.at(-1)?.followed?.terminalID === terminal && m.page.updates.at(-1)?.followed?.session === id);
      // Another conversation C is written later in the folder and has finished (no peer names it).
      m.put(third);
      const lookups = m.lookups.length;
      m.service.refresh();
      expect(m.lookups.length).toBe(lookups);
      // A snapshot of the same running pane and terminal omits the session: Chat stays on A, no lookup.
      const before = m.page.updates.length;
      m.state.named = null;
      observe();
      m.service.refresh();
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(m.lookups.length).toBe(lookups);
      expect(m.page.updates.slice(before).flatMap((event) => (event.followed === undefined ? [] : [event.followed.session]))).not.toContain(third);
      expect(m.page.updates.at(-1)?.state.status).toBe("live");
      expect(m.page.updates.at(-1)?.followed).toEqual({ terminalID: terminal, session: id });
      expect(prompts(m.page.updates.at(-1))).toEqual([id]);
      // Run 2 quits: Resume offers A.
      observe();
      m.state.running = false;
      const quit = m.host();
      m.life.observeHosts([quit]);
      m.service.refresh();
      const offer = resumeOffer(m.life.exited(quit, quit.topology.panes[0]!, quit.topology), absentStartCommands);
      expect(offer?.command).toBe(`grok --resume ${id}`);
    } finally {
      m.service.closeAll();
    }
  });

  it("re-resolves an explicit different name, and a new run that names nothing looks again", async () => {
    const m = realLocator();
    try {
      m.put(other);
      m.put(id);
      m.state.named = id;
      m.service.open(m.page, "mac", "A");
      await until(() => m.page.updates.at(-1)?.followed?.session === id);
      m.put(third);
      // The same run names C: Chat follows C.
      m.state.named = third;
      m.service.refresh();
      await until(() => m.page.updates.at(-1)?.followed?.session === third);
      // The name drops: the run keeps C.
      m.state.named = null;
      m.service.refresh();
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(m.page.updates.at(-1)?.followed?.session).toBe(third);
      // A new run that names nothing looks again, past the sessions earlier runs followed (A and C): never A or C.
      m.state.running = false;
      m.service.refresh();
      m.state.running = true;
      const before = m.page.updates.length;
      m.service.refresh();
      await until(() => m.page.updates.slice(before).some((event) => event.state.status === "live" || event.state.status === "unavailable"));
      await new Promise((resolve) => setTimeout(resolve, 30));
      const followed = m.page.updates.slice(before).flatMap((event) => (event.followed === undefined ? [] : [event.followed.session]));
      expect(followed).not.toContain(id);
      expect(followed).not.toContain(third);
    } finally {
      m.service.closeAll();
    }
  });
});

describe("a kept named binding ends with its run, while Chat is closed or paused too", () => {
  /** HostRegistry's warm candidates too: the pane is listed while it runs (working), not once it exited. */
  function machine() {
    const m = realLocator();
    m.hosts.agentPanes = () => (m.state.running ? [{ hostId: "mac", paneId: "A" }] : []);
    const agent = m.hosts.agent;
    m.hosts.agent = (host, pane) => {
      const info = agent(host, pane);
      return info === null ? null : ({ ...info, agentStatus: "working" } as never);
    };
    return m;
  }

  /** Run 1 names A and Chat follows it; then Chat is closed or its window paused. */
  async function followNamedThenLeave(m: ReturnType<typeof machine>, mode: string): Promise<void> {
    m.put(id);
    m.state.named = id;
    m.service.open(m.page, "mac", "A");
    await until(() => m.page.updates.at(-1)?.followed?.session === id);
    if (mode === "closed") m.service.close(m.page);
    else m.service.setPaused(m.page, true);
  }

  const back = (m: ReturnType<typeof machine>, mode: string): void => {
    if (mode === "closed") m.service.open(m.page, "mac", "A");
    else m.service.setPaused(m.page, false);
  };

  it.each(["closed", "paused"])("follows the new run's B, with one lookup that skips A, after Chat was %s", async (mode) => {
    const m = machine();
    try {
      await followNamedThenLeave(m, mode);
      // A delivered exit snapshot, then a new run in the same terminal that names nothing and writes B.
      m.state.running = false;
      m.state.named = null;
      m.service.refresh();
      m.put(other);
      m.state.running = true;
      m.service.refresh();
      const before = m.page.updates.length;
      const lookups = m.lookups.length;
      back(m, mode);
      await until(() => m.page.updates.slice(before).some((event) => event.followed?.session === other));
      expect(m.page.updates.at(-1)?.followed).toEqual({ terminalID: "t1", session: other });
      expect(m.page.updates.slice(before).flatMap((event) => (event.followed === undefined ? [] : [event.followed.session]))).not.toContain(id);
      const looked = m.lookups.slice(lookups);
      expect(looked.length).toBe(1);
      expect(looked[0]!.lookup).toEqual({ kind: "folder", folder, exclude: [id] });
    } finally {
      m.service.closeAll();
    }
  });

  it.each(["closed", "paused"])("shows none until the new run writes B, then follows B, after Chat was %s", async (mode) => {
    const m = machine();
    try {
      await followNamedThenLeave(m, mode);
      m.state.running = false;
      m.state.named = null;
      m.service.refresh();
      m.state.running = true;
      m.service.refresh();
      const before = m.page.updates.length;
      back(m, mode);
      await until(() => m.page.updates.slice(before).some((event) => event.state.status === "unavailable" || event.state.status === "live"));
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(m.page.updates.slice(before).flatMap((event) => (event.followed === undefined ? [] : [event.followed]))).toEqual([]);
      expect(m.page.updates.at(-1)?.state.status).toBe("unavailable");
      m.put(other);
      m.service.refresh();
      await until(() => m.page.updates.at(-1)?.followed?.session === other);
      expect(m.page.updates.at(-1)?.followed).toEqual({ terminalID: "t1", session: other });
    } finally {
      m.service.closeAll();
    }
  });

  it("keeps A with no lookup when the window is paused and restored within the same run, its name dropped", async () => {
    const m = machine();
    try {
      await followNamedThenLeave(m, "paused");
      m.put(other);
      m.state.named = null;
      m.service.refresh();
      const before = m.page.updates.length;
      const lookups = m.lookups.length;
      m.service.setPaused(m.page, false);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(m.lookups.length).toBe(lookups);
      expect(m.page.updates.slice(before).flatMap((event) => (event.followed === undefined ? [] : [event.followed.session]))).not.toContain(other);
      expect(m.page.updates.at(-1)?.state.status).toBe("live");
      expect(m.page.updates.at(-1)?.followed).toEqual({ terminalID: "t1", session: id });
    } finally {
      m.service.closeAll();
    }
  });

  it("leaves a Claude pane's named feed unchanged: closed, an exit and a new run naming another session", async () => {
    const reader = new FakeTranscriptReader();
    const claudeFile = (session: string): string => `/Users/fixture/.claude/projects/-Users-fixture-proj/${session}.jsonl`;
    const first = "5b1d7c2e-8f3a-4e6b-9c0d-1a2b3c4d5e6f";
    const second = "6c2e8d3f-9a4b-4f7c-8d1e-2b3c4d5e6f70";
    reader.put(claudeFile(first), "", claudeFile(first));
    const state = { running: true, session: first };
    const backend = { kind: "herdr", transcripts: () => reader } as unknown as HerdrHostBackend;
    const hosts: ChatHosts = {
      backend: () => backend,
      pane: () => ({ paneID: "A", terminalID: "t1", agent: state.running ? "claude" : undefined, cwd: folder }) as never,
      agent: () =>
        state.running
          ? ({ paneID: "A", terminalID: "t1", agent: "claude", cwd: folder, agentSession: { source: "herdr:claude", agent: "claude", kind: "id", value: state.session } } as never)
          : null,
      hostAgentPanes: () => (state.running ? ["A"] : []),
    };
    const service = new ChatService(hosts, "chat", { pollIntervalMs: 5 });
    const page = new Page(80);
    try {
      service.open(page, "mac", "A");
      await until(() => page.updates.at(-1)?.state.status === "live");
      expect(page.updates.at(-1)?.followed).toBeUndefined();
      service.close(page);
      state.running = false;
      service.refresh();
      reader.put(claudeFile(second), "", claudeFile(second));
      state.running = true;
      state.session = second;
      service.refresh();
      reader.clearCalls();
      const before = page.updates.length;
      service.open(page, "mac", "A");
      await until(() => page.updates.slice(before).some((event) => event.state.status === "live"));
      expect(reader.calls.filter((call) => call === "locate").length).toBe(1);
      expect(page.updates.at(-1)?.followed).toBeUndefined();
    } finally {
      service.closeAll();
    }
  });
});

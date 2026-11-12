// Which Pi or omp session is a pane's: Herdr's report (a path; an id when unsaved), else its
// folder by Grok's and Cursor's rule (one unnamed pane of the agent in the folder), with fake Herdr
// snapshots; the folder command run as an SSH exec runs it, under a synthetic home in the test scratch
// folder (never ~/.pi or ~/.omp).

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { piAmbiguousReason, piFolderName, piHeaderCwd, piSessionIDOfPath, piTranscriptGlobs } from "../src/shared/chat/agents/pi-locator";
import { ChatService, type ChatHosts, type ChatOwner } from "../src/main/chat/service";
import type { HerdrHostBackend } from "../src/main/herdr/backend";
import { ChatFeed } from "../src/shared/chat/feed";
import {
  grokLookupExcludes,
  grokSessionIDOf,
  locateCommand,
  makeSessionRef,
  paneSession,
  parseLocateOutput,
  sessionRefFromAgentSession,
  type AgentSessionLike,
  type ChatSession,
  type MachinePanes,
  type TranscriptSessionRef,
} from "../src/shared/chat/locator";
import { readsChat } from "../src/shared/chat/kinds";
import type { ChatUpdateEvent } from "../src/shared/ipc-contract";
import { scratch } from "./support/changes-git";
import { FakeTranscriptReader } from "./support/chat-lines";
import { agentTexts, eventually, header, ompID, ompPath, ompSession, otherID, piFolder, piID, piPath, piSession, titleLine } from "./chat-pi-fixtures";

const report = (agent: "pi" | "omp", kind: "path" | "id", value: string): AgentSessionLike => ({ source: `herdr:${agent}`, agent, kind, value });

/** One machine's snapshot: these agent panes, each its own terminal pane. */
function machine(agents: { paneID: string; agent: string; cwd: string; agentSession?: AgentSessionLike }[]): MachinePanes {
  return { agents, panes: agents.map(({ paneID, agent, cwd }) => ({ paneID, agent, cwd })) };
}

describe("pi and omp: the session Herdr reports", () => {
  it("binds the reported path, for pi and for omp", () => {
    const pi = paneSession(machine([{ paneID: "A", agent: "pi", cwd: piFolder, agentSession: report("pi", "path", piPath()) }]), "A") as ChatSession;
    expect(pi).toEqual({ ref: { format: "pi", lookup: { kind: "path", path: piPath() } }, source: "herdr:pi", paneFolders: [piFolder] });
    const omp = paneSession(machine([{ paneID: "B", agent: "omp", cwd: piFolder, agentSession: report("omp", "path", ompPath()) }]), "B") as ChatSession;
    expect(omp.ref).toEqual({ format: "omp", lookup: { kind: "path", path: ompPath() } });
    expect(omp.source).toBe("herdr:omp");
  });

  it("binds a reported id (an unsaved session) by its file's name, in the agent's own sessions folder", () => {
    const ref = sessionRefFromAgentSession(report("pi", "id", piID))!;
    expect(ref).toEqual({ format: "pi", lookup: { kind: "id", id: piID } });
    expect(piTranscriptGlobs("pi", piID)).toEqual([`"$HOME"/'.pi'/'agent'/'sessions'/*/*'_${piID}.jsonl'`]);
    expect(locateCommand(ref)).toContain(piID);
    expect(parseLocateOutput(piPath() + "\n", ref)).toBe(piPath());
    expect(parseLocateOutput(piPath(otherID) + "\n", ref), "another id").toBeNull();
    expect(parseLocateOutput(piPath().replace("/.pi/", "/.omp/") + "\n", ref), "omp's folder is not Pi's").toBeNull();
    const omp = sessionRefFromAgentSession(report("omp", "id", ompID))!;
    expect(piTranscriptGlobs("omp", ompID)).toEqual([`"$HOME"/'.omp'/'agent'/'sessions'/*/*'_${ompID}.jsonl'`]);
    expect(parseLocateOutput(ompPath() + "\n", omp)).toBe(ompPath());
  });

  it("refuses what is not safe to look up: a path not .jsonl or relative, an id that is not a UUID", () => {
    expect(sessionRefFromAgentSession(report("pi", "path", "/Users/fixture/notes.txt"))).toBeNull();
    expect(sessionRefFromAgentSession(report("pi", "path", "sessions/a.jsonl"))).toBeNull();
    expect(sessionRefFromAgentSession(report("pi", "id", "my-session"))).toBeNull();
    expect(sessionRefFromAgentSession(report("omp", "path", `/Users/fixture/a\n.jsonl`))).toBeNull();
    // An unusable report is no session, never the folder
    // rule's guess (a pane Herdr names no session for still follows its folder).
    expect(paneSession(machine([{ paneID: "A", agent: "pi", cwd: piFolder, agentSession: report("pi", "path", "/Users/fixture/notes.txt") }]), "A")).toBeNull();
    const session = paneSession(machine([{ paneID: "A", agent: "pi", cwd: piFolder }]), "A") as ChatSession;
    expect(session.ref.lookup).toEqual({ kind: "folder", folder: piFolder });
  });

  it("names the session id a path carries, for the peer rule", () => {
    expect(piSessionIDOfPath(piPath())).toBe(piID);
    expect(piSessionIDOfPath("/Users/fixture/custom.jsonl")).toBeNull();
    expect(grokSessionIDOf(makeSessionRef("omp", { kind: "path", path: ompPath() })!)).toBe(ompID);
    expect(grokSessionIDOf(makeSessionRef("pi", { kind: "id", id: piID })!)).toBe(piID);
  });

  it("is read by Chat: pi and omp are in the kinds list", () => {
    expect(["pi", "omp", "Pi", "claude"].map(readsChat)).toEqual([true, true, true, true]);
    // gemini is a Chat kind; amp stays unread.
    expect(readsChat("amp")).toBe(false);
  });
});

describe("pi and omp: a pane Herdr names no session for follows its folder", () => {
  it("looks up the folder when exactly one unnamed pane of the agent is in it", () => {
    const alone = paneSession(machine([{ paneID: "A", agent: "pi", cwd: piFolder }]), "A") as ChatSession;
    expect(alone).toEqual({ ref: { format: "pi", lookup: { kind: "folder", folder: piFolder } }, source: "folder", paneFolders: [piFolder] });
    // An omp pane in the same folder is another agent's: it does not make the Pi pane's folder ambiguous.
    const mixed = paneSession(machine([{ paneID: "A", agent: "pi", cwd: piFolder }, { paneID: "B", agent: "omp", cwd: piFolder }]), "A");
    expect(mixed).not.toBe("ambiguous");
  });

  it("refuses two unnamed Pi panes (or omp panes) in one folder, with the agent's own note", () => {
    expect(paneSession(machine([{ paneID: "A", agent: "pi", cwd: piFolder }, { paneID: "B", agent: "pi", cwd: piFolder + "/" }]), "A")).toBe("ambiguous");
    expect(paneSession(machine([{ paneID: "A", agent: "omp", cwd: piFolder }, { paneID: "B", agent: "omp", cwd: piFolder }]), "A")).toBe("ambiguous");
    expect([piAmbiguousReason("pi"), piAmbiguousReason("omp"), piAmbiguousReason("grok")]).toEqual(["ambiguousPiSession", "ambiguousOmpSession", null]);
  });

  it("skips the session a named peer follows (its id from its path)", () => {
    const session = paneSession(machine([{ paneID: "A", agent: "pi", cwd: piFolder }, { paneID: "B", agent: "pi", cwd: piFolder, agentSession: report("pi", "path", piPath(otherID)) }]), "A") as ChatSession;
    expect(session.ref.lookup).toEqual({ kind: "folder", folder: piFolder, exclude: [otherID] });
    expect(locateCommand(session.ref)).toContain(`'_${otherID}.jsonl'`);
    expect(parseLocateOutput(piPath(otherID) + "\n", session.ref)).toBeNull();
    expect(grokLookupExcludes(session.ref, piPath(otherID))).toBe(true);
    expect(grokLookupExcludes(session.ref, piPath())).toBe(false);
    expect(parseLocateOutput(piPath() + "\n", session.ref)).toBe(piPath());
  });

  it("parses only a session in Pi's folder for the pane's folder", () => {
    const ref = makeSessionRef("pi", { kind: "folder", folder: piFolder })!;
    expect(piFolderName("/Users/fixture/proj/")).toBe("--Users-fixture-proj--");
    expect(parseLocateOutput(piPath(piID, "/Users/fixture/other") + "\n", ref)).toBeNull();
    expect(parseLocateOutput("/Users/fixture/.pi/agent/sessions/--Users-fixture-proj--/notes.jsonl\n", ref)).toBeNull();
    expect(parseLocateOutput("/Users/fixture/.pi/agent/sessions/--Users-fixture-proj--/../x_" + piID + ".jsonl\n", ref)).toBeNull();
    expect(piHeaderCwd('/a/"q"\\b')).toBe('"cwd":"/a/\\"q\\"\\\\b"');
  });
});

/** A synthetic home under the test scratch folder (never ~/.pi or ~/.omp). */
function fakeHome(): string {
  const home = path.join(scratch, `chat-pi-home-${randomUUID()}`);
  mkdirSync(home, { recursive: true });
  return home;
}

/** A session file in `home`'s sessions folder `dir`, its header naming `cwd`, last written at `stamp` (seconds). */
function putSession(home: string, agent: "pi" | "omp", dir: string, id: string, cwd: string, stamp: number): string {
  const folder = path.join(home, `.${agent}`, "agent", "sessions", dir);
  mkdirSync(folder, { recursive: true });
  const file = path.join(folder, `2026-11-09T09-00-0${stamp % 10}-000Z_${id}.jsonl`);
  const first = agent === "omp" ? titleLine("t") + "\n" : "";
  writeFileSync(file, first + header({}, id, cwd) + "\n");
  utimesSync(file, stamp, stamp);
  return file;
}

/** The locator's command run as an SSH exec runs it, HOME the synthetic home. */
function located(home: string, ref: TranscriptSessionRef): string | null {
  const output = execFileSync("/bin/sh", ["-c", locateCommand(ref)!], { env: { PATH: "/usr/bin:/bin", HOME: home }, encoding: "utf8" });
  return parseLocateOutput(output, ref);
}

describe("pi and omp: the folder command, run", () => {
  it("Pi: the newest session whose header names the folder, never one whose header names another", () => {
    const home = fakeHome();
    const folder = "/Users/fixture/a-b";
    const older = putSession(home, "pi", piFolderName(folder), piID, folder, 100);
    // "/Users/fixture/a/b" files under the same name ("--Users-fixture-a-b--"); its header tells it apart.
    putSession(home, "pi", piFolderName(folder), otherID, "/Users/fixture/a/b", 300);
    const ref = makeSessionRef("pi", { kind: "folder", folder })!;
    expect(located(home, ref)).toBe(older);
    const newer = putSession(home, "pi", piFolderName(folder), "019a6b30-0000-7000-8000-000000000002", folder, 200);
    expect(located(home, ref)).toBe(newer);
    expect(located(home, makeSessionRef("pi", { kind: "folder", folder, exclude: ["019a6b30-0000-7000-8000-000000000002"] })!)).toBe(older);
    expect(located(home, makeSessionRef("pi", { kind: "folder", folder: "/Users/fixture/none" })!)).toBeNull();
    expect(located(home, makeSessionRef("pi", { kind: "id", id: piID })!)).toBe(older);
  });

  it("omp: below the home folder its own name (`-<path>`), elsewhere Pi's; the header after its title line", () => {
    const home = fakeHome();
    const inside = path.join(home, "work", "app");
    const own = putSession(home, "omp", "-work-app", ompID, inside, 100);
    expect(located(home, makeSessionRef("omp", { kind: "folder", folder: inside })!)).toBe(own);
    const outside = "/opt/work/app";
    const legacy = putSession(home, "omp", piFolderName(outside), otherID, outside, 100);
    expect(located(home, makeSessionRef("omp", { kind: "folder", folder: outside })!)).toBe(legacy);
    expect(located(home, makeSessionRef("omp", { kind: "folder", folder: home })!), "the home folder itself (`-`), none there").toBeNull();
    const atHome = putSession(home, "omp", "-", "019a6b30-0000-7000-8000-000000000003", home, 100);
    expect(located(home, makeSessionRef("omp", { kind: "folder", folder: home })!)).toBe(atHome);
  });

  it("finds nothing (and exits 0) with no sessions folder at all", () => {
    expect(located(fakeHome(), makeSessionRef("omp", { kind: "folder", folder: "/Users/fixture/x y'z" })!)).toBeNull();
  });
});

describe("pi and omp: a session that belongs to another folder", () => {
  it("is never shown (sessionMismatch): the header's folder is not the pane's", async () => {
    const reader = new FakeTranscriptReader();
    const file = piPath();
    reader.put(file, piSession(), file);
    const feed = new ChatFeed(reader, { pollIntervalMs: 5 });
    feed.start(makeSessionRef("pi", { kind: "path", path: file })!, ["/Users/fixture/elsewhere"]);
    expect(await eventually(() => feed.state.status === "unavailable")).toBe(true);
    expect(feed.state).toEqual({ status: "unavailable", reason: "sessionMismatch" });
    feed.stop();
    const own = new ChatFeed(reader, { pollIntervalMs: 5 });
    own.start(makeSessionRef("pi", { kind: "path", path: file })!, [piFolder + "/src"]);
    expect(await eventually(() => own.state.status === "live" && own.timeline.turns.length === 6), "a folder inside the session's is the pane's").toBe(true);
    own.stop();
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

/** A machine with these agent panes for ChatService. */
function hosts(agents: { paneID: string; agent: string; cwd: string; agentSession?: AgentSessionLike }[], reader: FakeTranscriptReader): ChatHosts {
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

describe("pi and omp: Chat's service", () => {
  it("opens a Pi pane's reported session live", async () => {
    const reader = new FakeTranscriptReader();
    reader.put(piPath(), piSession(), piPath());
    const service = new ChatService(hosts([{ paneID: "A", agent: "pi", cwd: piFolder, agentSession: report("pi", "path", piPath()) }], reader), "chat", { pollIntervalMs: 5 });
    const page = new Page(1);
    service.open(page, "mac", "A");
    expect(await eventually(() => page.updates.at(-1)?.state.status === "live" && (page.updates.at(-1)?.timeline.turns.length ?? 0) === 6)).toBe(true);
    expect(agentTexts(page.updates.at(-1)!.timeline.turns[0])).toEqual(["Let me look.", "Fixed: `sum` subtracted."]);
    service.closeAll();
  });

  it("opens an omp pane's reported session live", async () => {
    const reader = new FakeTranscriptReader();
    reader.put(ompPath(), ompSession(), ompPath());
    const service = new ChatService(hosts([{ paneID: "B", agent: "omp", cwd: piFolder, agentSession: report("omp", "path", ompPath()) }], reader), "chat", { pollIntervalMs: 5 });
    const page = new Page(2);
    service.open(page, "mac", "B");
    expect(await eventually(() => page.updates.at(-1)?.state.status === "live" && (page.updates.at(-1)?.timeline.turns.length ?? 0) === 2)).toBe(true);
    service.closeAll();
  });

  it("says Pi's and omp's own note for two unnamed panes in one folder", () => {
    for (const [agent, reason] of [
      ["pi", "ambiguousPiSession"],
      ["omp", "ambiguousOmpSession"],
    ] as const) {
      const service = new ChatService(hosts([{ paneID: "A", agent, cwd: piFolder }, { paneID: "C", agent, cwd: piFolder }], new FakeTranscriptReader()), "chat", { pollIntervalMs: 5 });
      const page = new Page(3);
      service.open(page, "mac", "A");
      expect(page.updates.at(-1)?.state).toEqual({ status: "unavailable", reason });
      service.closeAll();
    }
  });
});

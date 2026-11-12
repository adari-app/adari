// Which Kimi Code session a pane runs. Herdr reports `herdr:kimi` with Kimi's session id
// (herdr src/agent_resume.rs:117-133, 216-218); the wire is `~/.kimi-code/sessions/<workspace>/<id>/agents/main/wire.jsonl`
// (kimi-code 27bd9ba docs/en/configuration/data-locations.md:73-83), the workspace `wd_<slug>_<sha256[:12]>` of the folder
// (src/_base/utils/workdir-slug.ts:1-23). Fake Herdr snapshots only; the locate command runs here under a scratch home.

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  isKimiSessionID,
  isKimiWirePath,
  kimiAmbiguousNote,
  kimiSessionFromArgv,
  kimiWorkspaceKey,
  sha256Hex,
} from "../src/shared/chat/agents/kimi-locate";
import { ChatFeed, standardColdLoad } from "../src/shared/chat/feed";
import {
  ambiguousNoteFor,
  locateCommand,
  makeSessionRef,
  paneSession,
  parseLocateOutput,
  sessionForPane,
  sessionFromArgv,
  sessionRefFromAgentSession,
} from "../src/shared/chat/locator";
import { SearchCommand, SearchQuery } from "../src/shared/search/search";
import { paneSessions } from "../src/main/away/service";
import { herdrSession } from "../src/main/changes/service";
import type { SessionTopology } from "../src/main/herdr/wire";
import { FakeTranscriptReader } from "./support/chat-lines";
import { runClock } from "./support/cold-link";

const cwd = "/Users/fixture/proj";
const id = "session_5b1d7c2e-8f3a-4e6b-9c0d-1a2b3c4d5e6f";
const migrated = "ses_11111111-2222-4333-8444-555555555555";
const peer = "session_22222222-2222-4222-8222-222222222222";
const scratch = realpathSync(process.env["HERDR_TEST_SCRATCH"] || os.tmpdir());
const wirePath = (home: string, folder: string, session: string): string =>
  path.join(home, ".kimi-code", "sessions", kimiWorkspaceKey(folder), session, "agents", "main", "wire.jsonl");
const report = (value: string) => ({ source: "herdr:kimi", agent: "kimi", kind: "id", value });

describe("kimi: Herdr's report and argv", () => {
  it("binds Herdr's reported id, and refuses one that is not Kimi's", () => {
    expect(sessionRefFromAgentSession(report(id))).toEqual({ format: "kimi", lookup: { kind: "id", id } });
    expect(sessionRefFromAgentSession(report(migrated))?.lookup).toEqual({ kind: "id", id: migrated });
    for (const bad of ["5b1d7c2e-8f3a-4e6b-9c0d-1a2b3c4d5e6f", "session_x", "session_5b1d7c2e-8f3a-4e6b-9c0d-1a2b3c4d5e6f/..", "../session"]) {
      expect(sessionRefFromAgentSession(report(bad)), bad).toBeNull();
    }
    expect(isKimiSessionID(id)).toBe(true);
  });

  it("reads -S, --session, --session=, -r and --resume from kimi's argv; the argv wins over Herdr, then the folder", () => {
    for (const argv of [["kimi", "-S", id], ["kimi", "--session", id], ["kimi", `--session=${id}`], ["kimi", "-r", id], ["kimi", `--resume=${id}`]]) {
      expect(sessionFromArgv(argv, "kimi"), argv.join(" ")).toEqual(report(id));
    }
    for (const argv of [["kimi", "-S"], ["kimi", "-S", "title"], ["kimi", "--continue"], ["kimi"]]) expect(kimiSessionFromArgv(argv), argv.join(" ")).toBeNull();
    const pane = { agent: "kimi", cwd, agentSession: report(peer) };
    expect(sessionForPane(pane, { argv: ["kimi", "-S", id] })?.ref.lookup).toEqual({ kind: "id", id });
    expect(sessionForPane(pane)?.ref.lookup).toEqual({ kind: "id", id: peer });
    expect(sessionForPane({ agent: "kimi", cwd })?.ref).toEqual({ format: "kimi", lookup: { kind: "folder", folder: cwd } });
    expect(sessionForPane({ agent: "kimi", cwd })?.source).toBe("folder");
  });

  it("forms a path lookup only from a main wire under a Kimi workspace", () => {
    const good = `/Users/fixture/.kimi-code/sessions/${kimiWorkspaceKey(cwd)}/${id}/agents/main/wire.jsonl`;
    expect(isKimiWirePath(good)).toBe(true);
    expect(isKimiWirePath(`/Users/fixture/.kimi-code/sessions/wm_11111111-2222-4333-8444-555555555555/${id}/agents/main/wire.jsonl`)).toBe(true);
    for (const bad of [
      good.replace("/main/", "/sub_1/"),
      good.replace("wire.jsonl", "state.json"),
      good.replace(kimiWorkspaceKey(cwd), "wd_proj_XYZ"),
      good.replace(id, "not-an-id"),
      good.replace("/.kimi-code/", "/.kimi-code/../.kimi-code/"),
      "relative" + good,
      good.replace("proj", "pr\u0001oj"),
    ]) {
      expect(isKimiWirePath(bad), bad).toBe(false);
    }
    expect(makeSessionRef("kimi", { kind: "path", path: good })).not.toBeNull();
    expect(makeSessionRef("kimi", { kind: "path", path: "/Users/fixture/x.jsonl" })).toBeNull();
    expect(makeSessionRef("kimi", { kind: "folder", folder: "relative" })).toBeNull();
    expect(makeSessionRef("kimi", { kind: "folder", folder: cwd, exclude: ["not-an-id"] })).toBeNull();
    expect(makeSessionRef("kimi", { kind: "folder", folder: cwd, exclude: Array.from({ length: 65 }, () => peer) })).toBeNull();
  });
});

describe("kimi: the folder rule", () => {
  it("computes Kimi's workspace key: sha256 of the folder, its slug", () => {
    expect(sha256Hex(new TextEncoder().encode("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex(new Uint8Array(0))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    const long = "x".repeat(1_000) + "é";
    expect(sha256Hex(new TextEncoder().encode(long))).toBe(createHash("sha256").update(long).digest("hex"));
    const node = (folder: string): string => createHash("sha256").update(folder.replace(/\/+$/, "")).digest("hex").slice(0, 12);
    expect(kimiWorkspaceKey(cwd)).toBe(`wd_proj_${node(cwd)}`);
    expect(kimiWorkspaceKey(cwd + "/")).toBe(kimiWorkspaceKey(cwd));
    expect(kimiWorkspaceKey("/Users/fixture/My Project! (v2)")).toBe(`wd_my-project-v2_${node("/Users/fixture/My Project! (v2)")}`);
    expect(kimiWorkspaceKey("/Users/fixture/日本")).toBe(`wd_workspace_${node("/Users/fixture/日本")}`);
    expect(kimiWorkspaceKey("/Users/fixture/" + "a".repeat(50))).toBe(`wd_${"a".repeat(40)}_${node("/Users/fixture/" + "a".repeat(50))}`);
  });

  it("finds the folder's newest session, skipping a peer's, and an id under any workspace (the command run here)", () => {
    const home = mkdtempSync(path.join(scratch, "hc-kimi-locate-"));
    const make = (folder: string, session: string, mtime: number): string => {
      const file = wirePath(home, folder, session);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, "{}\n");
      utimesSync(file, mtime, mtime);
      return file;
    };
    const older = make(cwd, migrated, 1_000);
    const newest = make(cwd, peer, 5_000);
    const elsewhere = make("/Users/fixture/elsewhere", id, 9_000);
    mkdirSync(path.join(path.dirname(wirePath(home, cwd, id)), "..", "..", "..", "session_33333333-3333-4333-8333-333333333333", "agents", "main"), { recursive: true });
    const run = (command: string): string => (spawnSync("/bin/sh", ["-c", command], { env: { HOME: home, PATH: "/usr/bin:/bin" } }).stdout ?? Buffer.alloc(0)).toString("utf8");

    const ref = makeSessionRef("kimi", { kind: "folder", folder: cwd })!;
    const command = locateCommand(ref)!;
    expect(parseLocateOutput(run(command), ref)).toBe(newest);
    const excluding = makeSessionRef("kimi", { kind: "folder", folder: cwd, exclude: [peer] })!;
    expect(parseLocateOutput(run(locateCommand(excluding)!), excluding)).toBe(older);
    const byID = makeSessionRef("kimi", { kind: "id", id })!;
    expect(parseLocateOutput(run(locateCommand(byID)!), byID)).toBe(elsewhere);
    const none = makeSessionRef("kimi", { kind: "folder", folder: "/Users/fixture/empty" })!;
    expect(run(locateCommand(none)!)).toBe("");
    // Reads only; every part of the path is quoted.
    for (const word of [" rm ", " mv ", "touch", " tee ", " >", "mkdir"]) expect(command.includes(word), word).toBe(false);
    expect(locateCommand(makeSessionRef("kimi", { kind: "folder", folder: "/Users/fixture/it's $(x)" })!)).toContain("'\"'\"'");
  });

  it("takes from the command's output only the session asked for", () => {
    const at = (folder: string, session: string): string => `/Users/x/.kimi-code/sessions/${kimiWorkspaceKey(folder)}/${session}/agents/main/wire.jsonl`;
    const byFolder = makeSessionRef("kimi", { kind: "folder", folder: cwd, exclude: [peer] })!;
    expect(parseLocateOutput(at(cwd, id) + "\n", byFolder)).toBe(at(cwd, id));
    expect(parseLocateOutput(at("/Users/fixture/elsewhere", id), byFolder)).toBeNull();
    expect(parseLocateOutput(at(cwd, peer), byFolder)).toBeNull();
    const byID = makeSessionRef("kimi", { kind: "id", id })!;
    expect(parseLocateOutput(at("/Users/fixture/elsewhere", id), byID)).toBe(at("/Users/fixture/elsewhere", id));
    expect(parseLocateOutput(at(cwd, peer), byID)).toBeNull();
    expect(parseLocateOutput("ls: no such file\n", byID)).toBeNull();
    expect(parseLocateOutput("", byID)).toBeNull();
  });

  it("refuses two Kimi panes in one folder that name no session, with Kimi's note; a peer that names one is skipped", () => {
    const machine = { agents: [{ paneID: "p1", agent: "kimi", cwd }, { paneID: "p2", agent: "kimi", cwd }], panes: [] };
    expect(paneSession(machine, "p1")).toBe("ambiguous");
    expect(ambiguousNoteFor("kimi")).toBe(kimiAmbiguousNote);
    expect(kimiAmbiguousNote).toBe("Two Kimi sessions are open in this folder, so Chat can't tell which is this pane's");
    // A Grok or Cursor pane in the same folder is not a Kimi peer.
    expect(paneSession({ agents: [{ paneID: "p1", agent: "kimi", cwd }, { paneID: "p2", agent: "cursor", cwd }], panes: [] }, "p1")).not.toBe("ambiguous");
    const named = paneSession({ agents: [{ paneID: "p1", agent: "kimi", cwd }, { paneID: "p2", agent: "kimi", cwd, agentSession: report(peer) }], panes: [] }, "p1");
    expect(named !== "ambiguous" && named !== null ? named.ref.lookup : null).toEqual({ kind: "folder", folder: cwd, exclude: [peer] });
    // The pane Herdr names a session for is bound by it, whatever its peers are.
    const reported = paneSession({ agents: [{ paneID: "p1", agent: "kimi", cwd, agentSession: report(id) }, { paneID: "p2", agent: "kimi", cwd }], panes: [] }, "p1");
    expect(reported !== "ambiguous" && reported !== null ? reported.ref.lookup : null).toEqual({ kind: "id", id });
  });
});

describe("kimi: a session from another folder", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const wire = (folder: string): string =>
    [
      JSON.stringify({ type: "metadata", protocol_version: "1.5", min_protocol_version: "1.5", created_at: 1 }),
      JSON.stringify({ type: "profile.bind", environmentDisclosure: { cwd: folder }, time: 1_793_502_000_000 }),
      JSON.stringify({ type: "context.append_message", message: { role: "user", content: [{ type: "text", text: "Hello" }], origin: { kind: "user" } }, time: 1_793_502_001_000 }),
    ].join("\n") + "\n";

  async function stateFor(folder: string): Promise<{ state: unknown; shown: number }> {
    const reader = new FakeTranscriptReader();
    const file = `/Users/fixture/.kimi-code/sessions/${kimiWorkspaceKey(folder)}/${id}/agents/main/wire.jsonl`;
    reader.put(file, wire(folder), file);
    const feed = new ChatFeed(reader, { cold: standardColdLoad });
    let done = false;
    feed.start(makeSessionRef("kimi", { kind: "id", id })!, [cwd]);
    void feed.loaded().then(() => (done = true));
    await runClock(() => done || feed.state.status === "unavailable", 10_000);
    const result = { state: feed.state, shown: feed.timeline.turns.length };
    feed.stop();
    return result;
  }

  it("never shows a session whose wire names another folder (sessionMismatch); its own folder's shows", async () => {
    expect(await stateFor("/Users/fixture/elsewhere")).toEqual({ state: { status: "unavailable", reason: "sessionMismatch" }, shown: 0 });
    expect(await stateFor(cwd)).toEqual({ state: { status: "live" }, shown: 1 });
    // Chat's folder rule: inside or around the pane's folder is its own; a sibling whose name starts the same is not.
    expect((await stateFor(cwd + "/packages/app")).state).toEqual({ status: "live" });
    expect((await stateFor(cwd + "-two")).state).toEqual({ status: "unavailable", reason: "sessionMismatch" });
  });
});

describe("kimi: the screens that do not read Kimi yet", () => {
  const topology = (agentSession?: ReturnType<typeof report>): SessionTopology =>
    ({
      agents: [{ paneID: "p1", agent: "kimi", cwd, ...(agentSession === undefined ? {} : { agentSession }) }],
      panes: [{ paneID: "p1", agent: "kimi", cwd }],
    }) as unknown as SessionTopology;

  it("Away, Changes and Search find no Kimi session", () => {
    expect(paneSessions(topology(report(id)))).toEqual({ p1: null });
    expect(paneSessions(topology())).toEqual({ p1: null });
    expect(herdrSession(topology(report(id)), "p1")).toBeNull();
    expect(herdrSession(topology(), "p1")).toBeNull();
    const ref = makeSessionRef("kimi", { kind: "id", id })!;
    expect(SearchCommand.make(SearchQuery.make("paywall")!, [{ paneID: "p1", session: ref }])).toBeNull();
  });
});

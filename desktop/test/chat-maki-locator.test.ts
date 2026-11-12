// How a Maki pane finds its session (agents/maki-session.ts, the locator's Maki lines).
// Herdr reports no Maki session (agent_resume.rs has no `herdr:maki`), so a pane binds by its argv or
// by its folder (Grok's rules). Fake Herdr snapshots only; the locate commands run under a scratch HOME
// with synthetic logs (Maki's header, maki-storage/src/sessions.rs:757-766), never a real session.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { paneSessions } from "../src/main/away/service";
import { herdrSession } from "../src/main/changes/service";
import {
  isMakiSessionID,
  makiFolderCommand,
  makiHeaderCwd,
  makiHeaderFolder,
  makiIDCommand,
  makiLocatedPath,
  makiSessionFromArgv,
  makiSessionIDOfPath,
  MakiLogFormatError,
} from "../src/shared/chat/agents/maki-session";
import { ChatFeed } from "../src/shared/chat/feed";
import { chatKinds, chatReadsKind } from "../src/shared/chat/kinds";
import {
  ambiguousNoteFor,
  excludingGrokSessions,
  grokAmbiguousNote,
  grokLookupExcludes,
  grokSessionIDOf,
  locateCommand,
  makeSessionRef,
  makiAmbiguousNote,
  paneSession,
  parseLocateOutput,
  sessionForPane,
  sessionFromArgv,
  type ChatSession,
} from "../src/shared/chat/locator";
import { SearchCommand, SearchQuery } from "../src/shared/search/search";
import { FakeTranscriptReader } from "./support/chat-lines";

const folder = "/Users/fixture/it's maki proj";
const id = "1C3vwUbZ2nGEr1q5wQ2xaY";
const older = "1C3vwUbZ2nGEr1q5wQ2xaX";
const other = "1C3vwUbZ2nGEr1q5wQ2xaW";
const prefixed = "1C3vwUbZ2nGEr1q5wQ2xaV";

const header = (cwd: string, v = 3, sessionID = id): string =>
  JSON.stringify({ t: "header", v, id: sessionID, model: "anthropic/claude-sonnet-4-5", cwd, created_at: 1_793_502_000 });

describe("maki locator: ids, paths and argv", () => {
  it("takes Maki's base58 ids only", () => {
    expect(isMakiSessionID(id)).toBe(true);
    for (const bad of ["", "0OIl0OIl0OIl0OIl0OIl", "0190f5b3-7a3e-7c2b-9f1e-1234567890ab", "short", "a".repeat(23), "../../etc/passwd"]) expect(isMakiSessionID(bad), bad).toBe(false);
  });

  it("knows a session log by its path", () => {
    expect(makiSessionIDOfPath(`/Users/x/.local/state/maki/sessions/${id}.jsonl`)).toBe(id);
    expect(makiSessionIDOfPath(`/state/maki/sessions/${id}.jsonl`)).toBe(id);
    for (const bad of [
      `relative/maki/sessions/${id}.jsonl`,
      `/Users/x/.local/state/maki/sessions/${id}.json`,
      `/Users/x/.local/state/maki/other/${id}.jsonl`,
      `/Users/x/.local/state/grok/sessions/${id}.jsonl`,
      `/Users/x/.local/state/maki/sessions/not-base58!.jsonl`,
      `/Users/x/.local/state/maki/sessions/${id}\n.jsonl`,
    ])
      expect(makiSessionIDOfPath(bad), bad).toBeNull();
  });

  it("reads the session an argv names (src/cli.rs:106-117)", () => {
    expect(makiSessionFromArgv(["maki", "-r", id])).toBe(id);
    expect(makiSessionFromArgv(["maki", "-s", id])).toBe(id);
    expect(makiSessionFromArgv(["maki", "--resume", id])).toBe(id);
    expect(makiSessionFromArgv(["maki", "--session", id])).toBe(id);
    expect(makiSessionFromArgv(["maki", `--resume=${id}`])).toBe(id);
    expect(makiSessionFromArgv(["maki", `--session=${id}`])).toBe(id);
    // Where the run writes wins; a fork writes under a new id, so it names none.
    expect(makiSessionFromArgv(["maki", "-r", older, "--session-id", id])).toBe(id);
    expect(makiSessionFromArgv(["maki", `--session-id=${id}`])).toBe(id);
    expect(makiSessionFromArgv(["maki", "-r", id, "--fork-session"])).toBeNull();
    expect(makiSessionFromArgv(["maki", "-r", id, "--fork-session", "--session-id", older])).toBe(older);
    // `-c`, a bare `-r` (the picker), a flag or a legacy hex id name none.
    expect(makiSessionFromArgv(["maki", "-c"])).toBeNull();
    expect(makiSessionFromArgv(["maki", "-r"])).toBeNull();
    expect(makiSessionFromArgv(["maki", "-r", "--yolo"])).toBeNull();
    expect(makiSessionFromArgv(["maki", "-r", "0190f5b3-7a3e-7c2b-9f1e-1234567890ab"])).toBeNull();
    expect(sessionFromArgv(["maki", "-r", id], "maki")).toEqual({ source: "herdr:maki", agent: "maki", kind: "id", value: id });
  });

  it("checks every lookup it is given", () => {
    expect(makeSessionRef("maki", { kind: "id", id })).toEqual({ format: "maki", lookup: { kind: "id", id } });
    expect(makeSessionRef("maki", { kind: "id", id: "0190f5b3-7a3e-7c2b-9f1e-1234567890ab" })).toBeNull();
    expect(makeSessionRef("maki", { kind: "folder", folder })).not.toBeNull();
    expect(makeSessionRef("maki", { kind: "folder", folder: "relative" })).toBeNull();
    expect(makeSessionRef("maki", { kind: "folder", folder, exclude: [older] })).not.toBeNull();
    expect(makeSessionRef("maki", { kind: "folder", folder, exclude: ["not base58!"] })).toBeNull();
    expect(makeSessionRef("maki", { kind: "folder", folder, exclude: Array.from({ length: 65 }, () => older) })).toBeNull();
    expect(makiFolderCommand("relative", [])).toBeNull();
    expect(makiFolderCommand(folder, ["x'; touch /tmp/p; '"])).toBeNull();
    expect(makiIDCommand("x'; touch /tmp/p; '")).toBeNull();
  });

  it("is a kind Chat reads; the five skipped agents are not", () => {
    // Maki opens on its own screen for 0.1.0 (no Herdr
    // report and no argv in production, so only the folder's newest could be followed); this reader and its tests stay.
    expect(chatKinds).not.toContain("maki");
    expect(chatReadsKind("Maki")).toBe(false);
    // cline is read; qodercli and devin have no reader; kiro is unread for 0.1.0, as Maki.
    for (const skipped of ["amp", "qodercli", "devin", "kiro", "letta", "muse"]) expect(chatReadsKind(skipped), skipped).toBe(false);
  });
});

describe("maki locator: a pane's session (fake Herdr snapshots)", () => {
  it("binds the argv's session first, else the folder", () => {
    const pane = { agent: "maki", cwd: folder };
    expect(sessionForPane(pane, { argv: ["maki", "-r", id] })).toEqual({ ref: { format: "maki", lookup: { kind: "id", id } }, source: "argv", paneFolders: [folder] });
    expect(sessionForPane(pane)).toEqual({ ref: { format: "maki", lookup: { kind: "folder", folder } }, source: "folder", paneFolders: [folder] });
    expect(sessionForPane(pane, { argv: ["maki", "-c"] })?.source).toBe("folder");
    expect(sessionForPane({ agent: "Maki", cwd: folder + "/" })?.ref.lookup).toEqual({ kind: "folder", folder });
    // The foreground folder when the pane's is not usable.
    expect(sessionForPane({ agent: "maki" }, { foregroundCWD: folder })?.ref.lookup).toEqual({ kind: "folder", folder });
    expect(sessionForPane({ agent: "maki" })).toBeNull();
  });

  it("refuses two Maki panes in one folder that name no session, with Maki's note", () => {
    const machine = {
      agents: [
        { paneID: "p1", agent: "maki", cwd: folder },
        { paneID: "p2", agent: "maki", cwd: folder },
      ],
      panes: [],
    };
    expect(paneSession(machine, "p1")).toBe("ambiguous");
    expect(paneSession(machine, "p2")).toBe("ambiguous");
    expect(ambiguousNoteFor("maki")).toBe(makiAmbiguousNote);
    expect(makiAmbiguousNote).toBe("Two Maki sessions are open in this folder, so Chat can't tell which is this pane's");
    expect(ambiguousNoteFor("grok")).toBe(grokAmbiguousNote);
    // A Grok pane in the same folder, or a Maki pane in another, is no Maki peer.
    expect(paneSession({ agents: [{ paneID: "p1", agent: "maki", cwd: folder }, { paneID: "p2", agent: "grok", cwd: folder }], panes: [] }, "p1")).not.toBe("ambiguous");
    expect(paneSession({ agents: [{ paneID: "p1", agent: "maki", cwd: folder }, { paneID: "p2", agent: "maki", cwd: "/Users/fixture/elsewhere" }], panes: [] }, "p1")).not.toBe("ambiguous");
  });

  it("skips the session a peer names, and an earlier run's", () => {
    const peer = { source: "herdr:maki", agent: "maki", kind: "id", value: older };
    const named = paneSession({ agents: [{ paneID: "p1", agent: "maki", cwd: folder }, { paneID: "p2", agent: "maki", cwd: folder, agentSession: peer }], panes: [] }, "p1");
    expect(named !== "ambiguous" && named !== null ? named.ref.lookup : null).toEqual({ kind: "folder", folder, exclude: [older] });
    const ref = makeSessionRef("maki", { kind: "folder", folder, exclude: [older] })!;
    expect(grokLookupExcludes(ref, `/h/.local/state/maki/sessions/${older}.jsonl`)).toBe(true);
    expect(grokLookupExcludes(ref, `/h/.local/state/maki/sessions/${id}.jsonl`)).toBe(false);
    expect(grokSessionIDOf(makeSessionRef("maki", { kind: "id", id })!)).toBe(id);
    expect(grokSessionIDOf(makeSessionRef("maki", { kind: "path", path: `/h/.local/state/maki/sessions/${id}.jsonl` })!)).toBe(id);
    expect(grokSessionIDOf(makeSessionRef("maki", { kind: "folder", folder })!)).toBeNull();
    const session: ChatSession = { ref: makeSessionRef("maki", { kind: "folder", folder })!, source: "folder", paneFolders: [folder] };
    const later = excludingGrokSessions(session, [id, older]);
    expect(later !== "ambiguous" ? later.ref.lookup : null).toEqual({ kind: "folder", folder, exclude: [id, older].sort() });
  });

  it("Away, Changes and search read no Maki session yet (carded)", () => {
    const topology = { agents: [{ paneID: "p1", agent: "maki", cwd: folder }], panes: [{ paneID: "p1", agent: "maki", cwd: folder }] } as never;
    expect(paneSessions(topology)["p1"]).toBeNull();
    expect(herdrSession(topology, "p1")).toBeNull();
    const target = { paneID: "p1", session: makeSessionRef("maki", { kind: "id", id })! };
    expect(SearchCommand.make(SearchQuery.make("paywall")!, [target])).toBeNull();
  });
});

const scratch = realpathSync(process.env.HERDR_TEST_SCRATCH || tmpdir());

/** A scratch HOME with Maki logs, each `[id, header cwd, modified at (s)]`; returns the sessions folder. */
function makiHome(name: string, logs: readonly (readonly [string, string, number])[], state?: string): { home: string; sessions: string } {
  const home = mkdtempSync(path.join(scratch, `hc-maki-${name}-`));
  const sessions = path.join(state ?? path.join(home, ".local", "state"), "maki", "sessions");
  mkdirSync(sessions, { recursive: true });
  for (const [sessionID, cwd, at] of logs) {
    const file = path.join(sessions, `${sessionID}.jsonl`);
    writeFileSync(file, header(cwd, 3, sessionID) + "\n" + JSON.stringify({ t: "msg", d: { role: "user", content: [{ type: "text", text: "hi" }] } }) + "\n");
    utimesSync(file, at, at);
  }
  return { home, sessions };
}

const run = (command: string, env: Record<string, string>): string =>
  (spawnSync("/bin/sh", ["-c", command], { env: { PATH: "/usr/bin:/bin", ...env } }).stdout ?? Buffer.alloc(0)).toString("utf8");

describe("maki locator: the locate commands, run under a scratch HOME", () => {
  it("finds the folder's newest session by its header, skipping other folders, peers' and non-logs", () => {
    const { home, sessions } = makiHome("folder", [
      [older, folder, 1_000],
      [id, folder, 2_000],
      [other, "/Users/fixture/elsewhere", 3_000],
      // A header naming a folder that merely starts with this one's is another folder's.
      [prefixed, folder + "-two", 4_000],
    ]);
    // A folder named like a log, and a file that is not one, newer than all: skipped.
    mkdirSync(path.join(sessions, `${"1".repeat(22)}.jsonl`));
    writeFileSync(path.join(sessions, "index.json"), "{}");
    const ref = makeSessionRef("maki", { kind: "folder", folder })!;
    const command = locateCommand(ref)!;
    expect(parseLocateOutput(run(command, { HOME: home }), ref)).toBe(path.join(sessions, `${id}.jsonl`));
    // A peer names the newest: the older one is this pane's.
    const excluding = makeSessionRef("maki", { kind: "folder", folder, exclude: [id] })!;
    expect(parseLocateOutput(run(locateCommand(excluding)!, { HOME: home }), excluding)).toBe(path.join(sessions, `${older}.jsonl`));
    // Every session excluded: none.
    const none = makeSessionRef("maki", { kind: "folder", folder, exclude: [id, older] })!;
    expect(run(locateCommand(none)!, { HOME: home })).toBe("");
    // The command reads only: ls, head, grep and printf; nothing written (its one redirect is cd's errors to /dev/null).
    for (const word of [" rm ", " mv ", "touch", " tee ", "mkdir", "eval"]) expect(command.includes(word), word).toBe(false);
    expect(command.split("2>/dev/null").join("").includes(">")).toBe(false);
    // The agent's name is never a bare word a shell could run.
    for (const plain of [makiFolderCommand("/Users/fixture/p", [older])!, makiIDCommand(id)!]) expect(/(?:^|[\s;|&(])maki(?:[\s;|&)]|$)/.test(plain), plain).toBe(false);
  });

  it("finds a session by id, honours an absolute XDG_STATE_HOME and ignores a relative one", () => {
    const { home, sessions } = makiHome("id", [[id, folder, 1_000]]);
    const ref = makeSessionRef("maki", { kind: "id", id })!;
    expect(parseLocateOutput(run(locateCommand(ref)!, { HOME: home }), ref)).toBe(path.join(sessions, `${id}.jsonl`));
    expect(run(locateCommand(makeSessionRef("maki", { kind: "id", id: older })!)!, { HOME: home })).toBe("");
    const state = path.join(home, "xdg-state");
    const xdg = makiHome("xdg", [[older, folder, 1_000]], state);
    const byXDG = makeSessionRef("maki", { kind: "id", id: older })!;
    expect(parseLocateOutput(run(locateCommand(byXDG)!, { HOME: home, XDG_STATE_HOME: state }), byXDG)).toBe(path.join(xdg.sessions, `${older}.jsonl`));
    expect(parseLocateOutput(run(locateCommand(ref)!, { HOME: home, XDG_STATE_HOME: "xdg-state" }), ref)).toBe(path.join(sessions, `${id}.jsonl`));
    // No Maki folder at all: nothing, exit 0.
    const empty = mkdtempSync(path.join(scratch, "hc-maki-empty-"));
    const result = spawnSync("/bin/sh", ["-c", locateCommand(makeSessionRef("maki", { kind: "folder", folder })!)!], { env: { HOME: empty, PATH: "/usr/bin:/bin" } });
    expect(result.status).toBe(0);
    expect(result.stdout.toString()).toBe("");
  });

  it("takes only a Maki log it asked for from the output", () => {
    const byID = makeSessionRef("maki", { kind: "id", id })!;
    const byFolder = makeSessionRef("maki", { kind: "folder", folder, exclude: [older] })!;
    expect(makiLocatedPath(`\n  /h/.local/state/maki/sessions/${id}.jsonl  \n`, byID.lookup as never)).toBe(`/h/.local/state/maki/sessions/${id}.jsonl`);
    expect(parseLocateOutput(`/h/.local/state/maki/sessions/${older}.jsonl\n`, byID)).toBeNull();
    expect(parseLocateOutput(`/h/.local/state/maki/sessions/${older}.jsonl\n`, byFolder)).toBeNull();
    expect(parseLocateOutput(`/h/.local/state/maki/sessions/${id}.jsonl\n`, byFolder)).toBe(`/h/.local/state/maki/sessions/${id}.jsonl`);
    expect(parseLocateOutput(`/h/.grok/sessions/x/${id}/updates.jsonl\n`, byFolder)).toBeNull();
    expect(parseLocateOutput("", byFolder)).toBeNull();
  });

  it("reads a session's folder from its header only", () => {
    const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
    expect(makiHeaderFolder(bytes(header(folder + "/") + "\n"))).toBe(folder);
    expect(makiHeaderFolder(bytes(header(folder)))).toBeNull();
    expect(makiHeaderFolder(bytes(header("relative") + "\n"))).toBeNull();
    expect(makiHeaderFolder(bytes(JSON.stringify({ t: "msg", cwd: folder }) + "\n"))).toBeNull();
    expect(() => makiHeaderFolder(bytes(header(folder, 4) + "\n"))).toThrow(MakiLogFormatError);
    expect(makiHeaderCwd('/a "b"\\c/')).toBe('"cwd":"/a \\"b\\"\\\\c"');
    expect(makiHeaderCwd('/a "b"\\c').slice("\"cwd\":".length)).toBe(JSON.stringify('/a "b"\\c'));
  });
});

describe("maki locator: a located session that is not the pane's", () => {
  it("refuses a folder lookup's session whose header names another folder (sessionMismatch)", async () => {
    const reader = new FakeTranscriptReader();
    const located = `/Users/fixture/.local/state/maki/sessions/${id}.jsonl`;
    reader.put(located, header("/Users/fixture/elsewhere") + "\n", located);
    const feed = new ChatFeed(reader, { pollIntervalMs: 5 });
    feed.start(makeSessionRef("maki", { kind: "folder", folder })!, [folder]);
    await feed.loaded();
    expect(feed.state).toEqual({ status: "unavailable", reason: "sessionMismatch" });
    expect(feed.timeline.turns).toEqual([]);
    feed.stop();
  });

  it("follows a folder lookup's session whose header names the folder", async () => {
    const reader = new FakeTranscriptReader();
    const located = `/Users/fixture/.local/state/maki/sessions/${id}.jsonl`;
    reader.put(located, header(folder) + "\n" + JSON.stringify({ t: "msg", d: { role: "user", content: [{ type: "text", text: "Hello Maki" }] } }) + "\n", located);
    const feed = new ChatFeed(reader, { pollIntervalMs: 5 });
    feed.start(makeSessionRef("maki", { kind: "folder", folder })!, [folder]);
    expect(await feed.loaded()).toBe(true);
    expect(feed.state).toEqual({ status: "live" });
    expect(feed.timeline.turns).toHaveLength(1);
    feed.stop();
  });
});

// The chat readers' boundaries: each case below could show the wrong chat; these tests say what 0.1.0 does
// instead. Synthetic fixtures only, under the test scratch folder.
//
// 1. A long Pi/omp, Copilot, Droid or Kimi transcript whose header (folder, version) lies before the cold tail:
//    the header is read first (one bounded read), so another folder's is sessionMismatch and an unknown version
//    unrecognisedFormat before anything shows; Copilot keeps its latest-resume folder.
// 2. Maki (no Herdr report, no argv in production) opens on its own screen; Chat follows nothing for it.
// 3. A reported id is honoured exactly or not at all: one that matches two files or databases is not found
//    (never the newest, never the first profile), and one the reader rejects is no session (never the folder's).
// 4. Away and Changes skip Pi/omp, Copilot, Droid, OpenCode and Kilo sessions.
// 5. Antigravity is read: its step kinds, statuses and result association are covered in
//    chat-antigravity-parser.test.ts; its rejected ids are still no session (case 3 above).

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { paneSessions } from "../src/main/away/service";
import { herdrSession } from "../src/main/changes/service";
import { ChatService, type ChatHosts, type ChatOwner } from "../src/main/chat/service";
import type { HerdrHostBackend } from "../src/main/herdr/backend";
import { agentName } from "../src/renderer/components/agent-kind";
import { ChatFeed, standardColdLoad } from "../src/shared/chat/feed";
import { chatKinds, chatReads } from "../src/shared/chat/kinds";
import { locateCommand, makeSessionRef, paneSession, parseLocateOutput, type TranscriptSessionRef } from "../src/shared/chat/locator";
import type { TranscriptFormat } from "../src/shared/chat/parser";
import { chatUnreadLine } from "../src/shared/chat/unread";
import type { ChatUpdateEvent } from "../src/shared/ipc-contract";
import { defaultView } from "../src/shared/pane-view";
import { eventually, FakeTranscriptReader, shown } from "./support/chat-lines";

const scratch = realpathSync(process.env["HERDR_TEST_SCRATCH"] || os.tmpdir());
const id = "5b1d7c2e-8f3a-4e6b-9c0d-1a2b3c4d5e6f";
const mine = "/fixture/project";
const other = "/fixture/other";
const j = (value: unknown): string => JSON.stringify(value);
const sq = (value: string): string => "'" + value.replaceAll("'", "''") + "'";
const home = (): string => mkdtempSync(path.join(scratch, "hc-integrate-"));
const put = (file: string, text: string): void => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};
const sqlite = (db: string, sql: string): string => {
  mkdirSync(path.dirname(db), { recursive: true });
  return execFileSync("/usr/bin/sqlite3", ["-init", "/dev/null", db, sql], { encoding: "utf8", timeout: 10_000 });
};
const run = (command: string, folder: string): string =>
  execFileSync("/bin/sh", ["-c", command], { env: { ...process.env, HOME: folder }, encoding: "utf8", timeout: 10_000 });
const idOf = (format: TranscriptFormat): string => (format === "kimi" ? "session_" + id : id);
const ref = (format: TranscriptFormat, value = idOf(format)): TranscriptSessionRef => makeSessionRef(format, { kind: "id", id: value })!;

type HeaderFormat = "pi" | "omp" | "copilot" | "droid" | "kimi";

/** A ~900 KiB transcript: its header (folder, version) first, then 100 turns of ~9 KiB each. */
function transcript(format: HeaderFormat, cwd: string, options: { readonly version?: boolean; readonly resume?: string; readonly turns?: number } = {}): string {
  const rows: string[] = [];
  const newer = options.version === true;
  if (format === "pi" || format === "omp") rows.push(j({ type: "session", version: newer ? 99 : 3, id, cwd }));
  if (format === "copilot") rows.push(j({ type: "session.start", data: { version: newer ? 99 : 1, sessionId: id, context: { cwd } } }));
  if (format === "droid") rows.push(j({ type: "session_start", cwd }));
  if (format === "kimi") {
    const version = newer ? "99.0" : "1.5";
    rows.push(j({ type: "metadata", protocol_version: version, min_protocol_version: version }), j({ type: "profile.bind", environmentDisclosure: { cwd } }));
  }
  for (let n = 0; n < (options.turns ?? 100); n += 1) {
    const text = `${n}: ${"fixture ".repeat(1100)}`;
    // A Copilot resume late in the session (inside the cold tail): the folder it names is the session's now.
    if (format === "copilot" && n === 95 && options.resume !== undefined) rows.push(j({ type: "session.resume", data: { context: { cwd: options.resume } } }));
    if (format === "pi" || format === "omp")
      rows.push(j({ type: "message", id: `u${n}`, message: { role: "user", content: "prompt " + n } }), j({ type: "message", id: `a${n}`, message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" } }));
    if (format === "copilot") rows.push(j({ id: `u${n}`, type: "user.message", data: { content: "prompt " + n } }), j({ id: `a${n}`, type: "assistant.message", data: { content: text } }));
    if (format === "droid")
      rows.push(
        j({ type: "message", message: { id: `u${n}`, role: "user", content: [{ type: "text", text: "prompt " + n }] } }),
        j({ type: "message", message: { id: `a${n}`, role: "assistant", content: [{ type: "text", text }] } }),
      );
    if (format === "kimi")
      rows.push(
        j({ type: "context.append_message", message: { role: "user", content: [{ type: "text", text: "prompt " + n }], origin: { kind: "user" } } }),
        j({ type: "context.append_loop_event", event: { type: "content.part", part: { type: "text", text } } }),
        j({ type: "turn.ended", reason: "completed" }),
      );
  }
  return rows.join("\n") + "\n";
}

/** A cold load (Chat's standard 512 KiB tail) of one transcript for a pane in `mine`. */
async function coldLoad(format: HeaderFormat, text: string): Promise<{ feed: ChatFeed; reader: FakeTranscriptReader }> {
  const reader = new FakeTranscriptReader();
  const file = "/fixture/session.jsonl";
  reader.put(file, text, file);
  const feed = new ChatFeed(reader, { cold: standardColdLoad });
  feed.start(ref(format), [mine]);
  await feed.loaded();
  return { feed, reader };
}

const readLengths = (reader: FakeTranscriptReader): number[] => reader.calls.filter((call) => call.startsWith("read ")).map((call) => Number(call.split(" ")[2]));

describe("a long transcript's header is read before its cold tail shows", () => {
  const formats: HeaderFormat[] = ["pi", "omp", "copilot", "droid", "kimi"];

  it("the transcripts are longer than the cold tail, so the tail alone never reads the header", () => {
    for (const format of formats) expect(new TextEncoder().encode(transcript(format, other)).length, format).toBeGreaterThan(standardColdLoad.window + 300 * 1_024);
  });

  for (const format of formats) {
    it(`${format}: a header naming another folder is sessionMismatch, and nothing of it shows`, async () => {
      const { feed, reader } = await coldLoad(format, transcript(format, other));
      try {
        expect(feed.state).toEqual({ status: "unavailable", reason: "sessionMismatch" });
        expect(shown(feed.timeline)).toEqual([]);
        // Bounded: the header's one read from the start (at most 256 KiB), the tail's at most the cold window.
        expect(reader.calls).toContain(`read 0 ${format === "kimi" ? 256 * 1_024 : 64 * 1_024}`);
        expect(readLengths(reader).every((length) => length <= standardColdLoad.window)).toBe(true);
      } finally {
        feed.stop();
      }
    });

    it(`${format}: the same transcript in the pane's folder shows its tail (and loads earlier history)`, async () => {
      const { feed } = await coldLoad(format, transcript(format, mine));
      try {
        expect(feed.state).toEqual({ status: "live" });
        const before = shown(feed.timeline);
        expect(before).toContain("user:prompt 99");
        expect(before).not.toContain("user:prompt 0");
        await feed.loadEarlier();
        expect(feed.state).toEqual({ status: "live" });
        expect(shown(feed.timeline).length).toBeGreaterThan(before.length);
      } finally {
        feed.stop();
      }
    });
  }

  for (const format of ["pi", "omp", "copilot", "kimi"] as const) {
    it(`${format}: a header of a version this reader doesn't know is unrecognisedFormat, and nothing shows`, async () => {
      const { feed } = await coldLoad(format, transcript(format, mine, { version: true }));
      try {
        expect(feed.state).toEqual({ status: "unavailable", reason: "unrecognisedFormat" });
        expect(shown(feed.timeline)).toEqual([]);
      } finally {
        feed.stop();
      }
    });
  }

  it("copilot keeps its latest-resume folder: a resume into the pane's folder shows, one out of it doesn't", async () => {
    const into = await coldLoad("copilot", transcript("copilot", other, { resume: mine }));
    try {
      expect(into.feed.state).toEqual({ status: "live" });
      expect(shown(into.feed.timeline)).toContain("user:prompt 99");
    } finally {
      into.feed.stop();
    }
    const out = await coldLoad("copilot", transcript("copilot", mine, { resume: other }));
    try {
      expect(out.feed.state).toEqual({ status: "unavailable", reason: "sessionMismatch" });
      expect(shown(out.feed.timeline)).toEqual([]);
    } finally {
      out.feed.stop();
    }
  });

  it("a short transcript of another folder is still sessionMismatch (control)", async () => {
    for (const format of formats) {
      const short = transcript(format, other).split("\n").slice(0, 6).join("\n") + "\n";
      const { feed } = await coldLoad(format, short);
      try {
        expect(feed.state, format).toEqual({ status: "unavailable", reason: "sessionMismatch" });
      } finally {
        feed.stop();
      }
    }
  });
});

describe("a reported id is honoured exactly, or not at all", () => {
  for (const format of ["pi", "omp", "kimi", "droid"] as const) {
    it(`${format}: an id two session files hold is found nowhere (not the newer one); one file is found`, () => {
      const folder = home();
      const files =
        format === "pi" || format === "omp"
          ? ["one", "two"].map((name) => path.join(folder, "." + format, "agent/sessions", name, `time_${id}.jsonl`))
          : format === "droid"
            ? ["one", "two"].map((name) => path.join(folder, ".factory/sessions", name, `${id}.jsonl`))
            : ["wd_one_111111111111", "wd_two_222222222222"].map((name) => path.join(folder, ".kimi-code/sessions", name, `session_${id}`, "agents/main/wire.jsonl"));
      files.forEach((file, index) => {
        put(file, "synthetic\n");
        utimesSync(file, 100 + index, 100 + index);
      });
      const asked = ref(format);
      expect(parseLocateOutput(run(locateCommand(asked)!, folder), asked)).toBeNull();
      // One copy: found.
      execFileSync("/bin/mv", [files[0]!, files[0]! + ".moved"]);
      expect(parseLocateOutput(run(locateCommand(asked)!, folder), asked)).toBe(files[1]);
    });
  }

  for (const format of ["hermes", "mastracode"] as const) {
    it(`${format}: an id two databases hold is found in neither (not the first); one database is found`, () => {
      const folder = home();
      const table = format === "hermes" ? "sessions" : "mastra_threads";
      const databases =
        format === "hermes"
          ? [path.join(folder, ".hermes/state.db"), path.join(folder, ".hermes/profiles/work/state.db")]
          : [path.join(folder, "Library/Application Support/mastracode/mastra.db"), path.join(folder, ".local/share/mastracode/mastra.db")];
      for (const db of databases) sqlite(db, `create table ${table}(id text);insert into ${table} values (${sq(id)});`);
      const asked = ref(format);
      expect(parseLocateOutput(run(locateCommand(asked)!, folder), asked)).toBeNull();
      sqlite(databases[0]!, `delete from ${table};`);
      expect(parseLocateOutput(run(locateCommand(asked)!, folder), asked)).toBe(databases[1] + "#" + id);
    });
  }

  it("copilot: an exact id path is found, another id's beside it is not (control)", () => {
    const folder = home();
    const file = path.join(folder, ".copilot/session-state", id, "events.jsonl");
    put(file, "synthetic\n");
    put(file.replace(id, "11111111-1111-1111-1111-111111111111"), "synthetic other\n");
    const asked = ref("copilot");
    expect(parseLocateOutput(run(locateCommand(asked)!, folder), asked)).toBe(file);
  });

  it("a reported id the reader rejects is no session: never the folder's newest (Pi, omp, Copilot, Droid, Kimi; agy, Hermes, Mastra)", () => {
    for (const agent of ["pi", "omp", "copilot", "droid", "kimi", "agy", "hermes", "mastracode"]) {
      const source = agent === "agy" ? "herdr:antigravity_cli" : "herdr:" + agent;
      const crafted = "../../crafted'; $(touch NEVER); #";
      const result = paneSession(
        { agents: [{ paneID: "a", agent, cwd: mine, agentSession: { source, agent, kind: "id", value: crafted } }], panes: [{ paneID: "a", agent, cwd: mine }] },
        "a",
      );
      expect(result, agent).toBeNull();
    }
  });

  it("a crafted id never becomes a command (control, eight readers)", () => {
    for (const format of ["pi", "omp", "kimi", "copilot", "droid", "antigravity", "hermes", "mastracode"] as TranscriptFormat[])
      expect(makeSessionRef(format, { kind: "id", id: "../../x'; $(touch NEVER); #" }), format).toBeNull();
  });

  it("two unnamed panes of a folder reader are ambiguous, and a named peer's session is excluded (control)", () => {
    for (const format of ["pi", "omp", "qwen", "copilot", "droid", "kimi", "maki", "opencode", "kilo", "cline", "gemini"]) {
      const machine = {
        agents: [
          { paneID: "a", agent: format, cwd: mine },
          { paneID: "b", agent: format, cwd: mine },
        ],
        panes: [
          { paneID: "a", agent: format, cwd: mine },
          { paneID: "b", agent: format, cwd: mine },
        ],
      };
      expect(paneSession(machine, "a"), format).toBe("ambiguous");
      if (["cline", "gemini", "maki"].includes(format)) continue;
      const value = format === "kimi" ? "session_" + id : format === "opencode" || format === "kilo" ? "ses_1234567890ABCDEF" : id;
      const named = { ...machine, agents: [machine.agents[0]!, { ...machine.agents[1]!, agentSession: { source: "herdr:" + format, agent: format, kind: "id", value } }] };
      const result = paneSession(named, "a");
      expect(result === null || result === "ambiguous" ? result : result.ref.lookup.kind === "folder" ? result.ref.lookup.exclude : null, format).toEqual([value]);
    }
  });

  it("a pane Herdr names no session for still follows its folder (Pi, omp, Copilot, Droid, Kimi)", () => {
    for (const agent of ["pi", "omp", "copilot", "droid", "kimi"]) {
      const result = paneSession({ agents: [{ paneID: "a", agent, cwd: mine }], panes: [{ paneID: "a", agent, cwd: mine }] }, "a");
      expect(result === null || result === "ambiguous" ? result : result.ref.lookup, agent).toEqual({ kind: "folder", folder: mine });
    }
  });
});

describe("Away and Changes skip Pi/omp, Copilot, Droid, OpenCode and Kilo sessions", () => {
  for (const format of ["pi", "omp", "copilot", "droid", "opencode", "kilo"]) {
    it(`${format}: neither service takes the pane's session (named or by folder)`, () => {
      const value = format === "opencode" || format === "kilo" ? "ses_1234567890ABCDEF" : id;
      for (const agentSession of [{ source: "herdr:" + format, agent: format, kind: "id", value }, undefined]) {
        const agent = { paneID: "a", agent: format, cwd: mine, ...(agentSession === undefined ? {} : { agentSession }) };
        const topology = { agents: [agent], panes: [{ paneID: "a", agent: format, cwd: mine }], workspaces: [], tabs: [] };
        // Chat itself still binds it (its parser checks the folder); Away and Changes don't.
        expect(paneSession(topology, "a"), format).not.toBeNull();
        expect(paneSessions(topology as never)["a"], format).toBeNull();
        expect(herdrSession(topology as never, "a"), format).toBeNull();
      }
    });
  }

  it("a short Pi transcript naming another folder no longer reaches Away", () => {
    const agent = { paneID: "a", agent: "pi", cwd: mine, agentSession: { source: "herdr:pi", agent: "pi", kind: "id", value: id } };
    const topology = { agents: [agent], panes: [{ paneID: "a", agent: "pi", cwd: mine }], workspaces: [], tabs: [] };
    expect(paneSessions(topology as never)).toEqual({ a: null });
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

describe("Maki opens on its own screen for 0.1.0 (Antigravity is read)", () => {
  it("is not a kind Chat reads: its own screen, and the Chat line with its name; Antigravity is read", () => {
    for (const kind of ["maki"]) {
      expect(chatKinds, kind).not.toContain(kind);
      expect(chatReads(kind), kind).toBe(false);
      expect(defaultView({ paneID: "w1:p1", isAgent: true, kind }), kind).toBe("terminal");
      const name = agentName(kind);
      expect(chatUnreadLine(true, kind), kind).toBe(`Chat doesn't read ${name}'s sessions yet. Its own screen is on the ${name} tab.`);
    }
    expect(agentName("maki")).toBe("Maki");
    expect(agentName("agy")).toBe("Antigravity CLI");
    expect(chatKinds).toContain("agy");
    expect(defaultView({ paneID: "w1:p1", isAgent: true, kind: "agy" })).toBe("chat");
  });

  it("Chat follows nothing for it: a resumed Maki pane never shows the folder's newer session", async () => {
    // Two Maki logs in the pane's folder: the resumed (older) one and a newer one.
    const folder = home();
    const old = "CwJNLTqLsEgPFJmq61cR6N";
    const newer = "CyJNLTqLsEgPFJmq61cR6N";
    const files = [old, newer].map((session) => path.join(folder, ".local/state/maki/sessions", session + ".jsonl"));
    files.forEach((file, index) => {
      put(file, [j({ t: "header", v: 3, id: index === 0 ? old : newer, cwd: mine }), j({ t: "msg", d: { role: "user", content: [{ type: "text", text: index === 0 ? "INTENDED RESUME" : "OTHER CONVERSATION" } ] } })].join("\n") + "\n");
      utimesSync(file, 100 + index, 100 + index);
    });
    // The locator (kept, with its tests) still names the folder's newest for a Maki pane: the service must not follow it.
    const machine = { agents: [{ paneID: "m", agent: "maki", cwd: mine }], panes: [{ paneID: "m", agent: "maki", cwd: mine }] };
    const bound = paneSession(machine, "m");
    expect(bound === null || bound === "ambiguous" ? bound : parseLocateOutput(run(locateCommand(bound.ref)!, folder), bound.ref)).toBe(files[1]);
    const reader = new FakeTranscriptReader();
    reader.put(files[1]!, readFileSync(files[1]!, "utf8"), files[1]!);
    const agents = [{ paneID: "m", agent: "maki", cwd: mine }];
    const backend = { kind: "herdr", transcripts: () => reader } as unknown as HerdrHostBackend;
    const hosts: ChatHosts = {
      backend: () => backend,
      pane: (_host, paneId) => {
        const agent = agents.find((candidate) => candidate.paneID === paneId);
        return agent === undefined ? null : ({ paneID: paneId, agent: agent.agent, cwd: agent.cwd } as never);
      },
      agent: (_host, paneId) => (agents.find((candidate) => candidate.paneID === paneId) as never) ?? null,
      hostAgentPanes: () => agents.map((agent) => agent.paneID),
    };
    const service = new ChatService(hosts, "chat", { pollIntervalMs: 5 });
    try {
      for (const pane of ["m"]) {
        const page = new Page(1);
        service.open(page, "mac", pane);
        expect(await eventually(() => page.updates.at(-1)?.state.status === "unavailable"), pane).toBe(true);
        expect(page.updates.at(-1)?.state, pane).toEqual({ status: "unavailable", reason: "noSession" });
        expect(page.updates.some((update) => shown(update.timeline).length > 0), pane).toBe(false);
      }
      expect(reader.calls).not.toContain("locate");
    } finally {
      service.closeAll();
    }
  });
});

// A Copilot resume or a Kimi config.update between the head and the cold tail (the unread middle) is the
// session's latest folder: one out of the pane's folder is sessionMismatch with nothing shown, one into it shows the
// session, and Load earlier through it keeps that folder. Herdr's `github-copilot` alias passes the service gate
// as Copilot. A long transcript whose header is not read within its bound is unrecognisedFormat.

const headBound = (format: "copilot" | "kimi"): number => (format === "kimi" ? 256 * 1_024 : 64 * 1_024);
const ownershipRow = (format: "copilot" | "kimi", cwd: string, pad = ""): string =>
  format === "copilot"
    ? j({ type: "session.resume", data: { context: { cwd } }, ...(pad === "" ? {} : { pad }) })
    : j({ type: "config.update", environmentDisclosure: { cwd }, ...(pad === "" ? {} : { pad }) });

/** The session starts in `start`; an ownership record into `moved` lies past the head, before the tail. */
function middle(format: "copilot" | "kimi", start: string, moved: string): string {
  const rows = transcript(format, start).trimEnd().split("\n");
  const row = ownershipRow(format, moved);
  rows.splice(rows.findIndex((line) => line.includes(format === "copilot" ? '"prompt 20"' : '"prompt 35"')), 0, row);
  const text = rows.join("\n") + "\n";
  const at = text.indexOf(row);
  expect(at).toBeGreaterThan(headBound(format));
  expect(at + row.length).toBeLessThan(text.length - standardColdLoad.window);
  return text;
}

/** A Copilot resume into `moved` whose line starts before the cold tail's first byte and ends after it. */
function straddling(start: string, moved: string): string {
  const rows = transcript("copilot", start).trimEnd().split("\n");
  const threshold = rows.join("\n").length + 2 - standardColdLoad.window;
  let offset = 0;
  let index = 0;
  for (; index < rows.length && offset <= threshold; index += 1) offset += rows[index]!.length + 1;
  const row = ownershipRow("copilot", moved, "x".repeat(offset - threshold - ownershipRow("copilot", moved, "-").length + 101));
  rows.splice(index, 0, row);
  const text = rows.join("\n") + "\n";
  const tailStart = text.length - standardColdLoad.window;
  expect(offset < tailStart && tailStart < offset + row.length, "the resume straddles the tail's start").toBe(true);
  return text;
}

const readTotal = (reader: FakeTranscriptReader): number => readLengths(reader).reduce((sum, length) => sum + length, 0);

describe("the latest ownership in the unread middle (Copilot, Kimi)", () => {
  for (const format of ["copilot", "kimi"] as const) {
    it(`${format}: a latest record out of the pane's folder in the unread middle is sessionMismatch, and nothing shows`, async () => {
      const { feed, reader } = await coldLoad(format, middle(format, mine, other));
      try {
        expect(feed.state).toEqual({ status: "unavailable", reason: "sessionMismatch" });
        expect(shown(feed.timeline)).toEqual([]);
        // Bounded: reads of at most 1 MiB, the middle's at most 4 MiB in all.
        expect(readLengths(reader).every((length) => length <= 1_024 * 1_024)).toBe(true);
        expect(readTotal(reader)).toBeLessThanOrEqual(headBound(format) + 4 * 1_024 * 1_024 + standardColdLoad.window);
      } finally {
        feed.stop();
      }
    });

    it(`${format}: a latest record into the pane's folder there shows the session, and Load earlier through it keeps that folder`, async () => {
      const { feed } = await coldLoad(format, middle(format, other, mine));
      try {
        expect(feed.state).toEqual({ status: "live" });
        expect(feed.transcriptFolder).toBe(mine);
        expect(shown(feed.timeline)).toContain("user:prompt 99");
        for (let step = 0; step < 6 && !shown(feed.timeline).includes("user:prompt 0"); step += 1) await feed.loadEarlier();
        expect(shown(feed.timeline)).toContain("user:prompt 0");
        expect(feed.state).toEqual({ status: "live" });
        expect(feed.transcriptFolder).toBe(mine);
      } finally {
        feed.stop();
      }
    });
  }

  it("copilot: a resume whose line straddles the cold tail's start is the latest too, both directions", async () => {
    const into = await coldLoad("copilot", straddling(other, mine));
    try {
      expect(into.feed.state).toEqual({ status: "live" });
      expect(into.feed.transcriptFolder).toBe(mine);
    } finally {
      into.feed.stop();
    }
    const out = await coldLoad("copilot", straddling(mine, other));
    try {
      expect(out.feed.state).toEqual({ status: "unavailable", reason: "sessionMismatch" });
      expect(shown(out.feed.timeline)).toEqual([]);
    } finally {
      out.feed.stop();
    }
  });

  it("copilot: an unread middle longer than 4 MiB is unavailable before any of it is read, never the head's folder", async () => {
    const text = transcript("copilot", mine, { turns: 560 });
    expect(text.length - standardColdLoad.window - 64 * 1_024).toBeGreaterThan(4 * 1_024 * 1_024);
    const { feed, reader } = await coldLoad("copilot", text);
    try {
      expect(feed.state).toEqual({ status: "unavailable", reason: "unrecognisedFormat" });
      expect(shown(feed.timeline)).toEqual([]);
      expect(reader.calls.filter((call) => call.startsWith("read "))).toEqual([`read 0 ${64 * 1_024}`]);
    } finally {
      feed.stop();
    }
  });

  it("copilot: a long same-folder log whose middle fits the 4 MiB cap is live, read in reads of at most 1 MiB (control)", async () => {
    const text = transcript("copilot", mine, { turns: 450 });
    const gap = text.length - standardColdLoad.window - 64 * 1_024;
    expect(gap).toBeGreaterThan(3 * 1_024 * 1_024);
    expect(gap).toBeLessThan(4 * 1_024 * 1_024 - 64 * 1_024);
    const { feed, reader } = await coldLoad("copilot", text);
    try {
      expect(feed.state).toEqual({ status: "live" });
      expect(shown(feed.timeline)).toContain("user:prompt 449");
      expect(readLengths(reader).every((length) => length <= 1_024 * 1_024)).toBe(true);
      await feed.loadEarlier();
      expect(feed.state).toEqual({ status: "live" });
    } finally {
      feed.stop();
    }
  });
});

describe("a long transcript whose header is not read within its bound fails closed", () => {
  for (const format of ["pi", "copilot", "kimi"] as const) {
    it(`${format}: a header line longer than its ${format === "kimi" ? "256" : "64"} KiB bound is unrecognisedFormat, nothing shows (the pane's own folder)`, async () => {
      const rows = transcript(format, mine).trimEnd().split("\n");
      const pad = "x".repeat((format === "kimi" ? 260 : 70) * 1_024);
      // Kimi's first line is its `metadata` (the wire's version): past the bound, nothing of its header is read.
      rows[0] =
        format === "pi" ? j({ type: "session", version: 3, id, cwd: mine, padding: pad })
        : format === "copilot" ? j({ type: "session.start", data: { version: 1, sessionId: id, context: { cwd: mine } }, padding: pad })
        : j({ type: "metadata", protocol_version: "1.5", min_protocol_version: "1.5", padding: pad });
      const { feed } = await coldLoad(format, rows.join("\n") + "\n");
      try {
        expect(feed.state).toEqual({ status: "unavailable", reason: "unrecognisedFormat" });
        expect(shown(feed.timeline)).toEqual([]);
      } finally {
        feed.stop();
      }
    });
  }

  it("kimi: a profile.bind longer than the head, after its metadata, is read whole by the middle's bounded scan: its folder counts (control)", async () => {
    for (const [cwd, state] of [
      [mine, { status: "live" }],
      [other, { status: "unavailable", reason: "sessionMismatch" }],
    ] as const) {
      const rows = transcript("kimi", cwd).trimEnd().split("\n");
      rows[1] = j({ type: "profile.bind", environmentDisclosure: { cwd }, padding: "x".repeat(260 * 1_024) });
      const { feed } = await coldLoad("kimi", rows.join("\n") + "\n");
      try {
        expect(feed.state, cwd).toEqual(state);
      } finally {
        feed.stop();
      }
    }
  });

  it("a short transcript with the same oversized header is parsed whole, as before (control)", async () => {
    const rows = transcript("pi", mine).trimEnd().split("\n").slice(0, 21);
    rows[0] = j({ type: "session", version: 3, id, cwd: mine, padding: "x".repeat(70 * 1_024) });
    const text = rows.join("\n") + "\n";
    expect(text.length).toBeLessThan(standardColdLoad.window);
    const { feed } = await coldLoad("pi", text);
    try {
      expect(feed.state).toEqual({ status: "live" });
      expect(feed.transcriptFolder).toBe(mine);
      expect(shown(feed.timeline)).toContain("user:prompt 9");
    } finally {
      feed.stop();
    }
  });
});

describe("Herdr's github-copilot alias passes the service gate as Copilot", () => {
  it("a github-copilot pane with a valid Copilot id shows its session; Maki still follows nothing", async () => {
    const reader = new FakeTranscriptReader();
    const file = "/fixture/events.jsonl";
    reader.put(file, transcript("copilot", mine).split("\n").slice(0, 3).join("\n") + "\n", file);
    const agent = { paneID: "c", agent: "github-copilot", cwd: mine, agentSession: { source: "herdr:copilot", agent: "github-copilot", kind: "id", value: id } };
    const backend = { kind: "herdr", transcripts: () => reader } as unknown as HerdrHostBackend;
    const hosts: ChatHosts = {
      backend: () => backend,
      pane: () => ({ paneID: "c", agent: "github-copilot", cwd: mine }) as never,
      agent: () => agent as never,
      hostAgentPanes: () => ["c"],
    };
    const service = new ChatService(hosts, "chat", { pollIntervalMs: 5 });
    const page = new Page(1);
    try {
      service.open(page, "mac", "c");
      expect(await eventually(() => page.updates.at(-1)?.state.status === "live")).toBe(true);
      expect(shown(page.updates.at(-1)!.timeline)).toContain("user:prompt 0");
      expect(reader.calls).toContain("locate");
    } finally {
      service.closeAll();
    }
    for (const kind of ["maki", "Maki"]) expect(chatReads(kind), kind).toBe(false);
    expect(chatReads("agy")).toBe(true); // Antigravity is read
  });
});

// A Copilot session.resume or a Kimi config.update appended while
// Chat follows the session names its folder from then on. One out of the pane's folders ends the follow
// (sessionMismatch, the timeline emptied) before anything after it shows, in that batch or later. One in the
// pane's folders (the same folder, one inside it, back into it) keeps following. Qwen's per-record `cwd` can move
// the same way and is checked the same way. Herdr's `github-copilot` alias reads as Copilot in the UI
// helpers too: Chat opens, no fallback line, and the name GitHub Copilot.

type MovingFormat = "copilot" | "kimi";

/** A message the user typed, in the format's own record. */
const userRow = (format: MovingFormat, text: string): string =>
  format === "copilot"
    ? j({ id: `user-${text}`, type: "user.message", data: { content: text } })
    : j({ type: "context.append_message", message: { role: "user", content: [{ type: "text", text }], origin: { kind: "user" } } });

/** A one-turn session in `mine`, followed live (polled every 5 ms), every snapshot it publishes kept. */
async function followLive(format: MovingFormat, folders: readonly string[] = [mine]): Promise<{ feed: ChatFeed; reader: FakeTranscriptReader; file: string; seen: string[] }> {
  const reader = new FakeTranscriptReader();
  const file = "/fixture/session.jsonl";
  reader.put(file, transcript(format, mine, { turns: 1 }), file);
  const feed = new ChatFeed(reader, { cold: standardColdLoad, pollIntervalMs: 5 });
  const seen: string[] = [];
  feed.subscribe((update) => seen.push(...shown(update.timeline)));
  feed.start(ref(format), folders);
  await feed.loaded();
  expect(feed.state).toEqual({ status: "live" });
  expect(feed.transcriptFolder).toBe(mine);
  expect(shown(feed.timeline)).toContain("user:prompt 0");
  return { feed, reader, file, seen };
}

describe("an ownership record appended while live is checked against the pane's folders", () => {
  for (const format of ["copilot", "kimi"] as const) {
    it(`${format}: a record into another folder, then the user's message: sessionMismatch, and nothing after it ever shows`, async () => {
      const { feed, reader, file, seen } = await followLive(format);
      try {
        reader.append(file, ownershipRow(format, other) + "\n" + userRow(format, "FOREIGN POST-RESUME") + "\n");
        expect(await eventually(() => feed.state.status === "unavailable", 3_000)).toBe(true);
        expect(feed.state).toEqual({ status: "unavailable", reason: "sessionMismatch" });
        expect(shown(feed.timeline)).toEqual([]);
        expect(seen).not.toContain("user:FOREIGN POST-RESUME");
      } finally {
        feed.stop();
      }
    });

    it(`${format}: the record alone in its batch, the user's message in the next: sessionMismatch on the record`, async () => {
      const { feed, reader, file, seen } = await followLive(format);
      try {
        reader.append(file, ownershipRow(format, other) + "\n");
        expect(await eventually(() => feed.state.status === "unavailable", 3_000)).toBe(true);
        expect(feed.state).toEqual({ status: "unavailable", reason: "sessionMismatch" });
        reader.append(file, userRow(format, "FOREIGN LATER") + "\n");
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(feed.state).toEqual({ status: "unavailable", reason: "sessionMismatch" });
        expect(seen).not.toContain("user:FOREIGN LATER");
      } finally {
        feed.stop();
      }
    });

    it(`${format}: another folder's stretch inside one batch, back into the pane's folder by its end: sessionMismatch, nothing of it shows`, async () => {
      const { feed, reader, file, seen } = await followLive(format);
      try {
        reader.append(file, [ownershipRow(format, other), userRow(format, "FOREIGN STRETCH"), ownershipRow(format, mine), userRow(format, "HOME AGAIN")].join("\n") + "\n");
        expect(await eventually(() => feed.state.status === "unavailable", 3_000)).toBe(true);
        expect(feed.state).toEqual({ status: "unavailable", reason: "sessionMismatch" });
        expect(seen).not.toContain("user:FOREIGN STRETCH");
        expect(seen).not.toContain("user:HOME AGAIN");
      } finally {
        feed.stop();
      }
    });

    it(`${format}: a same-folder record keeps following`, async () => {
      const { feed, reader, file } = await followLive(format);
      try {
        reader.append(file, ownershipRow(format, mine) + "\n" + userRow(format, "SAME FOLDER") + "\n");
        expect(await eventually(() => shown(feed.timeline).includes("user:SAME FOLDER"), 3_000)).toBe(true);
        expect(feed.state).toEqual({ status: "live" });
        expect(feed.transcriptFolder).toBe(mine);
      } finally {
        feed.stop();
      }
    });

    it(`${format}: into a folder inside the pane's, then back into the pane's own: keeps following`, async () => {
      const { feed, reader, file } = await followLive(format);
      const inside = mine + "/packages/app";
      try {
        reader.append(file, ownershipRow(format, inside) + "\n" + userRow(format, "INSIDE") + "\n");
        expect(await eventually(() => shown(feed.timeline).includes("user:INSIDE"), 3_000)).toBe(true);
        expect(feed.transcriptFolder).toBe(inside);
        reader.append(file, ownershipRow(format, mine) + "\n" + userRow(format, "BACK INTO THE FOLDER") + "\n");
        expect(await eventually(() => shown(feed.timeline).includes("user:BACK INTO THE FOLDER"), 3_000)).toBe(true);
        expect(feed.state).toEqual({ status: "live" });
        expect(feed.transcriptFolder).toBe(mine);
        expect(shown(feed.timeline)).toEqual(expect.arrayContaining(["user:prompt 0", "user:INSIDE", "user:BACK INTO THE FOLDER"]));
      } finally {
        feed.stop();
      }
    });

    it(`${format}: a pane with two folders: a record into its other folder and back keeps following`, async () => {
      const second = "/fixture/second";
      const { feed, reader, file } = await followLive(format, [mine, second]);
      try {
        reader.append(file, ownershipRow(format, second) + "\n" + userRow(format, "SECOND FOLDER") + "\n" + ownershipRow(format, mine) + "\n" + userRow(format, "FIRST AGAIN") + "\n");
        expect(await eventually(() => shown(feed.timeline).includes("user:FIRST AGAIN"), 3_000)).toBe(true);
        expect(feed.state).toEqual({ status: "live" });
        expect(shown(feed.timeline)).toContain("user:SECOND FOLDER");
      } finally {
        feed.stop();
      }
    });

    it(`${format}: a pane with no folders follows on (no folder check, as before)`, async () => {
      const { feed, reader, file } = await followLive(format, []);
      try {
        reader.append(file, ownershipRow(format, other) + "\n" + userRow(format, "NO FOLDERS") + "\n");
        expect(await eventually(() => shown(feed.timeline).includes("user:NO FOLDERS"), 3_000)).toBe(true);
        expect(feed.state).toEqual({ status: "live" });
      } finally {
        feed.stop();
      }
    });

    it(`${format}: through ChatService, a record into another folder is sessionMismatch and no update ever holds what follows it`, async () => {
      const reader = new FakeTranscriptReader();
      const file = "/fixture/file.jsonl";
      reader.put(file, transcript(format, mine, { turns: 1 }), file);
      const named = { source: "herdr:" + format, agent: format, kind: "id", value: idOf(format) };
      const agent = { paneID: "a", agent: format, cwd: mine, agentSession: named };
      const backend = { kind: "herdr", transcripts: () => reader } as unknown as HerdrHostBackend;
      const hosts: ChatHosts = {
        backend: () => backend,
        pane: () => ({ paneID: "a", agent: format, cwd: mine }) as never,
        agent: () => agent as never,
        hostAgentPanes: () => ["a"],
      };
      const service = new ChatService(hosts, "chat", { pollIntervalMs: 5 });
      const page = new Page(1);
      try {
        service.open(page, "fake-machine", "a");
        expect(await eventually(() => page.updates.at(-1)?.state.status === "live", 3_000)).toBe(true);
        expect(shown(page.updates.at(-1)!.timeline)).toContain("user:prompt 0");
        reader.append(file, ownershipRow(format, mine) + "\n" + userRow(format, "SAME FOLDER SERVICE") + "\n");
        expect(await eventually(() => shown(page.updates.at(-1)!.timeline).includes("user:SAME FOLDER SERVICE"), 3_000)).toBe(true);
        expect(page.updates.at(-1)!.state).toEqual({ status: "live" });
        reader.append(file, ownershipRow(format, other) + "\n" + userRow(format, "FOREIGN SERVICE") + "\n");
        expect(await eventually(() => page.updates.at(-1)?.state.status === "unavailable", 3_000)).toBe(true);
        expect(page.updates.at(-1)!.state).toEqual({ status: "unavailable", reason: "sessionMismatch" });
        expect(shown(page.updates.at(-1)!.timeline)).toEqual([]);
        expect(page.updates.flatMap((update) => shown(update.timeline))).not.toContain("user:FOREIGN SERVICE");
      } finally {
        service.closeAll();
      }
    });
  }

  it("qwen: a record naming another folder appended while live is sessionMismatch; the pane's own keeps following", async () => {
    const reader = new FakeTranscriptReader();
    const file = "/fixture/qwen.jsonl";
    const qwen = (uuid: string, cwd: string, text: string): string =>
      j({ uuid, parentUuid: null, sessionId: id, timestamp: "2026-11-01T03:00:00.000Z", type: "user", cwd, version: "0.9.0", message: { role: "user", parts: [{ text }] } });
    reader.put(file, qwen("q1", mine, "prompt 0") + "\n", file);
    const feed = new ChatFeed(reader, { cold: standardColdLoad, pollIntervalMs: 5 });
    const seen: string[] = [];
    feed.subscribe((update) => seen.push(...shown(update.timeline)));
    try {
      feed.start(ref("qwen"), [mine]);
      await feed.loaded();
      expect(feed.state).toEqual({ status: "live" });
      expect(shown(feed.timeline)).toContain("user:prompt 0");
      reader.append(file, qwen("q2", mine, "SAME FOLDER") + "\n");
      expect(await eventually(() => shown(feed.timeline).includes("user:SAME FOLDER"), 3_000)).toBe(true);
      reader.append(file, qwen("q3", other, "FOREIGN QWEN") + "\n");
      expect(await eventually(() => feed.state.status === "unavailable", 3_000)).toBe(true);
      expect(feed.state).toEqual({ status: "unavailable", reason: "sessionMismatch" });
      expect(seen).not.toContain("user:FOREIGN QWEN");
    } finally {
      feed.stop();
    }
  });

  it("a cold load still takes the latest record in its tail (both directions), as before", async () => {
    for (const [start, moved, status] of [
      [other, mine, "live"],
      [mine, other, "unavailable"],
    ] as const) {
      const { feed } = await coldLoad("copilot", transcript("copilot", start, { turns: 3 }) + ownershipRow("copilot", moved) + "\n" + userRow("copilot", "AFTER") + "\n");
      try {
        expect(feed.state.status, `${start} → ${moved}`).toBe(status);
        if (status === "live") expect(shown(feed.timeline)).toContain("user:AFTER");
        else expect(shown(feed.timeline)).toEqual([]);
      } finally {
        feed.stop();
      }
    }
  });
});

describe("Herdr's github-copilot alias reads as Copilot in the UI helpers", () => {
  it("opens in Chat with no fallback line and the name GitHub Copilot, as copilot does (any case)", () => {
    for (const kind of ["github-copilot", "GitHub-Copilot"]) {
      expect(chatReads(kind), kind).toBe(true);
      expect(defaultView({ paneID: "a", isAgent: true, kind }), kind).toBe(defaultView({ paneID: "a", isAgent: true, kind: "copilot" }));
      expect(defaultView({ paneID: "a", isAgent: true, kind }), kind).toBe("chat");
      expect(chatUnreadLine(true, kind), kind).toBe(chatUnreadLine(true, "copilot"));
      expect(chatUnreadLine(true, kind), kind).toBeNull();
      expect(agentName(kind), kind).toBe(agentName("copilot"));
      expect(agentName(kind), kind).toBe("GitHub Copilot");
    }
  });

  it("Maki still falls back: its own screen and the line with its name (Antigravity is read)", () => {
    for (const [kind, name] of [["maki", "Maki"]] as const) {
      expect(chatReads(kind), kind).toBe(false);
      expect(defaultView({ paneID: "a", isAgent: true, kind }), kind).toBe("terminal");
      expect(chatUnreadLine(true, kind), kind).toBe(`Chat doesn't read ${name}'s sessions yet. Its own screen is on the ${name} tab.`);
    }
  });
});

// A follow that ended because a line it read moved the session's folder out of
// the pane's stays ended for that binding: while the pane names the same session and has the same folders, the
// service's refresh, its retry (on the next snapshot or after the backoff), a reopened window and warming start no
// follow of it again. The pane stays unavailable (sessionMismatch), and the stretch it refused never shows. A new
// session id or new pane folders resolve afresh. A cold load's mismatch (never followed live) retries as before.

interface Rig {
  readonly reader: FakeTranscriptReader;
  readonly service: ChatService;
  readonly page: Page;
  readonly pane: { paneID: string; agent: string; cwd: string; foregroundCWD?: string };
  readonly agent: { paneID: string; agent: string; cwd: string; agentStatus: string; agentSession: { source: string; agent: string; kind: string; value: string } };
  tick(ms: number): void;
  locates(): number;
  /** Every item any page of the rig was sent. */
  seen(): string[];
  readonly pages: Page[];
}

const servicePath = "/fixture/events.jsonl";
const mismatch = { status: "unavailable", reason: "sessionMismatch" } as const;
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25));

/** A pane `p` on machine `mac` whose named session (one turn in `mine`, or `start`) is open in a page, through ChatService. */
async function serviceRig(format: MovingFormat, options: { readonly start?: string; readonly status?: "live" | "unavailable" } = {}): Promise<Rig> {
  let clock = 1_000;
  const reader = new FakeTranscriptReader();
  reader.put(servicePath, transcript(format, options.start ?? mine, { turns: 1 }), servicePath);
  const agent = { paneID: "p", agent: format, cwd: mine, agentStatus: "working", agentSession: { source: "herdr:" + format, agent: format, kind: "id", value: idOf(format) } };
  const pane: Rig["pane"] = { paneID: "p", agent: format, cwd: mine };
  const backend = { kind: "herdr", transcripts: () => reader } as unknown as HerdrHostBackend;
  const hosts: ChatHosts = {
    backend: () => backend,
    pane: () => pane as never,
    agent: () => agent as never,
    hostAgentPanes: () => ["p"],
    agentPanes: () => [{ hostId: "mac", paneId: "p" }],
  };
  const service = new ChatService(hosts, "chat", { pollIntervalMs: 5 }, { now: () => clock });
  const page = new Page(1);
  const pages = [page];
  service.open(page, "mac", "p");
  expect(await eventually(() => page.updates.at(-1)?.state.status === (options.status ?? "live"), 3_000)).toBe(true);
  return {
    reader,
    service,
    page,
    pane,
    agent,
    pages,
    tick: (ms) => {
      clock += ms;
    },
    locates: () => reader.calls.filter((call) => call === "locate").length,
    seen: () => pages.flatMap((each) => each.updates.flatMap((update) => shown(update.timeline))),
  };
}

/** Refreshes the way the app does on each snapshot: several at once, then after the backoff's waits (5 s, then 60 s). */
async function refreshes(rig: Rig): Promise<void> {
  for (let n = 0; n < 3; n += 1) {
    rig.service.refresh();
    await settle();
  }
  for (const wait of [5_000, 10_000, 60_000]) {
    rig.tick(wait);
    rig.service.refresh();
    await settle();
  }
}

describe("a follow ended on a moved ownership stays ended for that binding", () => {
  for (const format of ["copilot", "kimi"] as const) {
    it(`${format}: out and back in one batch, then refresh (several, and after the backoff): still sessionMismatch, nothing of it ever shows`, async () => {
      const rig = await serviceRig(format);
      try {
        rig.reader.append(servicePath, [ownershipRow(format, other), userRow(format, "BATCH FOREIGN HISTORY"), ownershipRow(format, mine), userRow(format, "BATCH HOME AGAIN")].join("\n") + "\n");
        expect(await eventually(() => rig.page.updates.at(-1)?.state.status === "unavailable", 3_000)).toBe(true);
        expect(rig.page.updates.at(-1)!.state).toEqual(mismatch);
        const located = rig.locates();
        await refreshes(rig);
        expect(rig.page.updates.at(-1)!.state).toEqual(mismatch);
        expect(shown(rig.page.updates.at(-1)!.timeline)).toEqual([]);
        expect(rig.seen()).not.toContain("user:BATCH FOREIGN HISTORY");
        expect(rig.seen()).not.toContain("user:BATCH HOME AGAIN");
        // No follow of it was started again (a restart locates the session first).
        expect(rig.locates()).toBe(located);
      } finally {
        rig.service.closeAll();
      }
    });

    it(`${format}: out in one batch, back in a later one, refreshed between and after (the backoff too): still sessionMismatch, nothing of it ever shows`, async () => {
      const rig = await serviceRig(format);
      try {
        rig.reader.append(servicePath, ownershipRow(format, other) + "\n" + userRow(format, "FOREIGN RETRY HISTORY") + "\n");
        expect(await eventually(() => rig.page.updates.at(-1)?.state.status === "unavailable", 3_000)).toBe(true);
        rig.service.refresh();
        await settle();
        expect(rig.page.updates.at(-1)!.state).toEqual(mismatch);
        rig.reader.append(servicePath, ownershipRow(format, mine) + "\n" + userRow(format, "RETURNED") + "\n");
        await refreshes(rig);
        expect(rig.page.updates.at(-1)!.state).toEqual(mismatch);
        expect(rig.seen()).not.toContain("user:FOREIGN RETRY HISTORY");
        expect(rig.seen()).not.toContain("user:RETURNED");
      } finally {
        rig.service.closeAll();
      }
    });

    it(`${format}: the window closed and the pane opened again (it is working, so warming runs between): still sessionMismatch, nothing of it shows`, async () => {
      const rig = await serviceRig(format);
      try {
        rig.reader.append(servicePath, [ownershipRow(format, other), userRow(format, "FOREIGN BEFORE REOPEN"), ownershipRow(format, mine), userRow(format, "HOME BEFORE REOPEN")].join("\n") + "\n");
        expect(await eventually(() => rig.page.updates.at(-1)?.state.status === "unavailable", 3_000)).toBe(true);
        const located = rig.locates();
        rig.service.close(rig.page);
        rig.service.refresh();
        await settle();
        // Warming started no follow of it (a warm feed locates the session first).
        expect(rig.locates()).toBe(located);
        const again = new Page(2);
        rig.pages.push(again);
        rig.service.open(again, "mac", "p");
        await settle();
        await refreshes(rig);
        expect(again.updates.at(-1)!.state).toEqual(mismatch);
        expect(rig.locates()).toBe(located);
        expect(rig.seen()).not.toContain("user:FOREIGN BEFORE REOPEN");
        expect(rig.seen()).not.toContain("user:HOME BEFORE REOPEN");
      } finally {
        rig.service.closeAll();
      }
    });

    it(`${format}: the pane's folders changed while it read on (its follow keeps its own): the hold is for the pane's folders, so refreshes still start nothing`, async () => {
      const rig = await serviceRig(format);
      try {
        rig.pane.foregroundCWD = mine + "/packages/app";
        rig.service.refresh();
        await settle();
        expect(rig.page.updates.at(-1)!.state).toEqual({ status: "live" });
        rig.reader.append(servicePath, [ownershipRow(format, other), userRow(format, "FOREIGN WHILE READING ON"), ownershipRow(format, mine), userRow(format, "HOME WHILE READING ON")].join("\n") + "\n");
        expect(await eventually(() => rig.page.updates.at(-1)?.state.status === "unavailable", 3_000)).toBe(true);
        const located = rig.locates();
        await refreshes(rig);
        expect(rig.page.updates.at(-1)!.state).toEqual(mismatch);
        expect(rig.locates()).toBe(located);
        expect(rig.seen()).not.toContain("user:FOREIGN WHILE READING ON");
        expect(rig.seen()).not.toContain("user:HOME WHILE READING ON");
      } finally {
        rig.service.closeAll();
      }
    });

    it(`${format}: new pane folders after the mismatch resolve afresh (control: the folder it moved to is the pane's now)`, async () => {
      const rig = await serviceRig(format);
      try {
        rig.reader.append(servicePath, ownershipRow(format, other) + "\n" + userRow(format, "NOW ALLOWED") + "\n");
        expect(await eventually(() => rig.page.updates.at(-1)?.state.status === "unavailable", 3_000)).toBe(true);
        rig.service.refresh();
        await settle();
        expect(rig.page.updates.at(-1)!.state).toEqual(mismatch);
        rig.pane.foregroundCWD = other;
        rig.service.refresh();
        expect(await eventually(() => rig.page.updates.at(-1)?.state.status === "live", 3_000)).toBe(true);
        expect(shown(rig.page.updates.at(-1)!.timeline)).toContain("user:NOW ALLOWED");
      } finally {
        rig.service.closeAll();
      }
    });

    it(`${format}: a new session id after the mismatch resolves afresh, and the refused stretch never shows`, async () => {
      const rig = await serviceRig(format);
      try {
        rig.reader.append(servicePath, [ownershipRow(format, other), userRow(format, "OLD FOREIGN"), ownershipRow(format, mine), userRow(format, "OLD HOME")].join("\n") + "\n");
        expect(await eventually(() => rig.page.updates.at(-1)?.state.status === "unavailable", 3_000)).toBe(true);
        const next = "/fixture/events-2.jsonl";
        rig.reader.put(next, transcript(format, mine, { turns: 1 }).replace('"prompt 0"', '"NEW SESSION"'), next);
        const newID = "6c2e8d3f-9a4b-4f7c-8d1e-2b3c4d5e6f70";
        rig.agent.agentSession = { ...rig.agent.agentSession, value: format === "kimi" ? "session_" + newID : newID };
        rig.service.refresh();
        expect(await eventually(() => rig.page.updates.at(-1)?.state.status === "live", 3_000)).toBe(true);
        expect(shown(rig.page.updates.at(-1)!.timeline)).toContain("user:NEW SESSION");
        expect(rig.seen()).not.toContain("user:OLD FOREIGN");
        expect(rig.seen()).not.toContain("user:OLD HOME");
      } finally {
        rig.service.closeAll();
      }
    });

    it(`${format}: a cold load's mismatch (never followed live) still retries as before (control)`, async () => {
      const rig = await serviceRig(format, { start: other, status: "unavailable" });
      try {
        expect(rig.page.updates.at(-1)!.state).toEqual(mismatch);
        rig.reader.append(servicePath, ownershipRow(format, mine) + "\n" + userRow(format, "MOVED IN") + "\n");
        rig.tick(5_000);
        rig.service.refresh();
        expect(await eventually(() => rig.page.updates.at(-1)?.state.status === "live", 3_000)).toBe(true);
        expect(shown(rig.page.updates.at(-1)!.timeline)).toContain("user:MOVED IN");
      } finally {
        rig.service.closeAll();
      }
    });
  }

  it("the feed says which mismatch it was: a follow's moved ownership, not a cold load's; a new start clears it", async () => {
    const { feed, reader, file } = await followLive("copilot");
    try {
      expect(feed.ownershipMoved).toBe(false);
      reader.append(file, ownershipRow("copilot", other) + "\n");
      expect(await eventually(() => feed.state.status === "unavailable", 3_000)).toBe(true);
      expect(feed.ownershipMoved).toBe(true);
      feed.start(ref("copilot"), [other]);
      expect(feed.ownershipMoved).toBe(false);
      expect(await eventually(() => feed.state.status === "live", 3_000)).toBe(true);
    } finally {
      feed.stop();
    }
    const cold = await coldLoad("copilot", transcript("copilot", other, { turns: 1 }));
    try {
      expect(cold.feed.state).toEqual(mismatch);
      expect(cold.feed.ownershipMoved).toBe(false);
    } finally {
      cold.feed.stop();
    }
  });
});

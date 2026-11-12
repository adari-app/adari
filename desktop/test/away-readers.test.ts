// A port of HerdrKit's AwayReadersTests.swift: the digest's
// readers. Transcripts are served from memory by a fake reader (fixtures only);
// git runs against throwaway repositories in the test scratch folder, with
// a scratch git config, through the shells a Mac's SSH exec uses.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { TranscriptNotFoundError, type TranscriptFileReader } from "../src/shared/chat/feed";
import { makeSessionRef, type ChatSession, type TranscriptSessionRef } from "../src/shared/chat/locator";
import { awayActivityOf, buildAwayDigest, type AwayPane } from "../src/shared/away/digest";
import {
  AwayReadChanged,
  collectAway,
  defaultAwayLimits,
  firstSince,
  gitLogCommand,
  lineTime,
  notARepositoryMarker,
  parseGitLog,
  readTranscriptEnd,
  type AwayLimits,
} from "../src/shared/away/readers";
import { CancelledError, type RemoteCommand, type RemoteCommandRunner } from "../src/shared/remote-command";
import type { AgentStatus } from "../src/shared/sidebar-model";
import { json } from "./support/chat-lines";

const date = (iso: string): number => Date.parse(iso) / 1000;
const since = date("2026-11-02T01:00:00.000Z");
const now = date("2026-11-02T03:00:00.000Z");
const sessionID = "5b1d7c2e-8f3a-4e6b-9c0d-1a2b3c4d5e6f";
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A Claude transcript of `count` exchanges a minute apart from `start`, each reply padded to about `padding` bytes, written in `cwd`. */
function transcript(start: number, count: number, padding = 0, cwd = "/Users/fixture/proj"): string {
  const iso = (seconds: number): string => new Date(seconds * 1000).toISOString();
  const lines: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const time = start + index * 60;
    lines.push(json({ type: "user", uuid: `u${index}`, timestamp: iso(time), cwd, isSidechain: false, message: { role: "user", content: `Question ${index}` } }));
    lines.push(
      json({
        type: "assistant",
        uuid: `a${index}`,
        timestamp: iso(time + 30),
        isSidechain: false,
        message: { id: `msg_a${index}`, role: "assistant", type: "message", stop_reason: "end_turn", content: [{ type: "text", text: `Answer ${index} ` + "x".repeat(padding) }] },
      }),
    );
  }
  return lines.join("\n") + "\n";
}

/** Counts how many fake operations run at once across a test (reads and git). */
const probe = { now: 0, most: 0 };

/** Transcripts in memory; records every read. */
class FakeTranscripts implements TranscriptFileReader<TranscriptSessionRef> {
  readonly files: Map<string, Uint8Array>;
  requests: { offset: number; maxBytes: number }[] = [];
  bytesServed = 0;
  started = 0;
  private inFlight = 0;
  mostAtOnce = 0;

  constructor(
    files: Record<string, string>,
    private readonly delayMs = 0,
    private readonly shortReads = false,
  ) {
    this.files = new Map(Object.entries(files).map(([key, value]) => [key, new TextEncoder().encode(value)]));
  }

  async locate(ref: TranscriptSessionRef): Promise<string | null> {
    if (ref.lookup.kind !== "id") return null;
    const file = `/t/${ref.lookup.id}.jsonl`;
    return this.files.has(file) ? file : null;
  }

  async size(file: string): Promise<number> {
    const data = this.files.get(file);
    if (data === undefined) throw new TranscriptNotFoundError(file);
    return data.length;
  }

  async read(file: string, offset: number, maxBytes: number): Promise<Uint8Array> {
    const data = this.files.get(file);
    if (data === undefined) throw new TranscriptNotFoundError(file);
    this.started += 1;
    this.inFlight += 1;
    this.mostAtOnce = Math.max(this.mostAtOnce, this.inFlight);
    probe.now += 1;
    probe.most = Math.max(probe.most, probe.now);
    try {
      if (this.delayMs > 0) await sleep(this.delayMs);
    } finally {
      this.inFlight -= 1;
      probe.now -= 1;
    }
    this.requests.push({ offset, maxBytes });
    const start = Math.min(offset, data.length);
    let end = Math.min(data.length, offset + maxBytes);
    if (this.shortReads) end = Math.max(start, end - 1);
    this.bytesServed += end - start;
    return data.slice(start, end);
  }
}

/** `git log` that answers `output` after `delayMs`. */
class FakeGit implements RemoteCommandRunner {
  commands: RemoteCommand[] = [];
  constructor(
    private readonly output = "",
    private readonly delayMs = 0,
  ) {}

  async run(command: RemoteCommand, _max: number, signal?: AbortSignal): Promise<{ bytes: Uint8Array; truncated: boolean }> {
    this.commands.push(command);
    probe.now += 1;
    probe.most = Math.max(probe.most, probe.now);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, this.delayMs);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new CancelledError());
        });
      });
    } finally {
      probe.now -= 1;
    }
    return { bytes: new TextEncoder().encode(this.output), truncated: false };
  }
}

const limits = (changes: Partial<AwayLimits>): AwayLimits => ({ ...defaultAwayLimits, ...changes });

function session(id: string, folder: string): ChatSession {
  return { ref: makeSessionRef("claude", { kind: "id", id })!, source: "herdr:claude", paneFolders: [folder] };
}

function panes(count: number, status: (index: number) => AgentStatus = () => "idle"): AwayPane[] {
  return Array.from({ length: count }, (_, index) => {
    const folder = `/p/${index}`;
    return {
      paneID: `p${index}`,
      name: `Agent ${index}`,
      kind: "claude",
      folder,
      status: status(index),
      statusSince: 1_793_570_000 + index,
      session: session(`5b1d7c2e-0000-0000-0000-${String(index).padStart(12, "0")}`, folder),
    };
  });
}

function filesFor(list: readonly AwayPane[], text: (pane: AwayPane) => string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const pane of list) {
    const lookup = pane.session?.ref.lookup;
    if (lookup?.kind === "id") files[`/t/${lookup.id}.jsonl`] = text(pane);
  }
  return files;
}

describe("the bounded backward read", () => {
  it("stops once it passes since", async () => {
    // 300 exchanges from 22:00 (one a minute): `since` (01:00) is the 180th; each reply about 1 KB.
    const text = transcript(date("2026-11-01T22:00:00.000Z"), 300, 700);
    const reader = new FakeTranscripts({ "/t/a.jsonl": text });
    const read = await readTranscriptEnd(reader, "/t/a.jsonl", since, limits({ chunkBytes: 16 * 1_024 }));
    expect(read.truncated).toBe(false);
    expect(read.reachedStart).toBe(false);
    // Every line after `since` is there, and some before (the chunk it crossed in).
    const times = read.lines.map((line) => lineTime(line.text)!);
    expect(times[0]!).toBeLessThan(since);
    expect(times.filter((time) => time >= since).length).toBe(2 * 120);
    const bytes = new TextEncoder().encode(text);
    const all = text.split("\n").filter((line) => line !== "");
    const afterSince = all.filter((line) => lineTime(line)! >= since).reduce((sum, line) => sum + new TextEncoder().encode(line).length + 1, 0);
    expect(read.bytesRead).toBeGreaterThanOrEqual(afterSince);
    expect(read.bytesRead).toBeLessThanOrEqual(afterSince + 2 * 16 * 1_024);
    expect(read.bytesRead).toBeLessThan(bytes.length / 2);
    // Backwards, chunk after chunk, never more than a chunk at a time.
    expect(reader.requests[0]?.offset).toBe(bytes.length - 16 * 1_024);
    for (let index = 1; index < reader.requests.length; index += 1) expect(reader.requests[index]!.offset).toBeLessThan(reader.requests[index - 1]!.offset);
    expect(reader.requests.every((request) => request.maxBytes <= 16 * 1_024)).toBe(true);
    // The lines are the file's, oldest first, with their offsets.
    expect(read.lines.map((line) => line.text)).toEqual(all.slice(all.length - read.lines.length));
    const first = read.lines[0]!;
    expect(new TextDecoder().decode(bytes.slice(first.offset, first.offset + new TextEncoder().encode(first.text).length))).toBe(first.text);
  });

  it("is capped at 2 MB and marks more", async () => {
    // About 5 MB, all after `since`.
    const text = transcript(date("2026-11-02T01:00:30.000Z"), 2_500, 1_400);
    expect(text.length).toBeGreaterThan(4 * 1_024 * 1_024);
    const reader = new FakeTranscripts({ "/t/big.jsonl": text });
    const read = await readTranscriptEnd(reader, "/t/big.jsonl", since);
    expect(defaultAwayLimits.bytesPerPane).toBe(2 * 1_024 * 1_024);
    expect(read.truncated).toBe(true);
    expect(read.bytesRead).toBe(2 * 1_024 * 1_024);
    expect(reader.bytesServed).toBe(2 * 1_024 * 1_024);
    // The newest lines, whole.
    expect(read.lines.at(-1)?.text).toBe(text.split("\n").filter((line) => line !== "").at(-1));
    expect(read.lines.every((line) => lineTime(line.text) !== null)).toBe(true);
    const activity = awayActivityOf(read.lines, "claude", since, read.truncated);
    expect(activity.truncated).toBe(true);
    expect(activity.turnsFinished).toBeGreaterThan(100);
  });

  it("costs one chunk for a quiet transcript", async () => {
    const text = transcript(date("2026-11-01T20:00:00.000Z"), 200, 400);
    const reader = new FakeTranscripts({ "/t/q.jsonl": text });
    const read = await readTranscriptEnd(reader, "/t/q.jsonl", since, limits({ chunkBytes: 32 * 1_024 }));
    expect(reader.requests.length).toBe(1);
    expect(read.bytesRead).toBe(32 * 1_024);
    expect(read.truncated).toBe(false);
    const activity = awayActivityOf(read.lines, "claude", since);
    expect(activity.turnsFinished).toBe(0);
    expect(activity.firstNewItemID).toBeNull();
  });

  it("reads a small file to its start", async () => {
    const reader = new FakeTranscripts({ "/t/s.jsonl": transcript(date("2026-11-02T01:10:00.000Z"), 3) });
    const read = await readTranscriptEnd(reader, "/t/s.jsonl", since);
    expect(read.reachedStart).toBe(true);
    expect(read.truncated).toBe(false);
    expect(read.lines.length).toBe(6);
    expect(read.lines[0]?.offset).toBe(0);
  });

  it("fails a file that shrank under the read", async () => {
    const reader = new FakeTranscripts({ "/t/s.jsonl": transcript(date("2026-11-02T01:10:00.000Z"), 3) }, 0, true);
    await expect(readTranscriptEnd(reader, "/t/s.jsonl", since)).rejects.toBeInstanceOf(AwayReadChanged);
  });
});

describe("git", () => {
  it("quotes the folder", () => {
    const command = gitLogCommand("/Users/me/it's a $HOME `x`\nfolder", since, 50).text;
    expect(command.startsWith("/bin/sh -c '")).toBe(true);
    for (const part of ["--since=", "2026-11-02T01:00:00Z", "--no-optional-locks", "--max-count=50", " -C "]) expect(command).toContain(part);
  });

  it("parses the log", () => {
    const us = "\u001f";
    const rs = "\u001e";
    const a = "a".repeat(40);
    const b = "b".repeat(40);
    const output =
      `${a}${us}1793583000${us}Retry pairing once "now"${rs}\n` + `garbage line${rs}\n` + `${b}${us}1793582000${us}Fix: a${us}b${rs}\n` + `${"c".repeat(40)}${us}1793570000${us}Before since${rs}\n`;
    const parsed = parseGitLog(output, since);
    expect(parsed.kind).toBe("commits");
    if (parsed.kind !== "commits") return;
    expect(parsed.commits.map((commit) => commit.subject)).toEqual(['Retry pairing once "now"', `Fix: a${us}b`]);
    expect(parsed.commits.map((commit) => commit.hash)).toEqual([a, b]);
    expect(parsed.commits[0]!.time).toBe(1_793_583_000);
    expect(parseGitLog(notARepositoryMarker + "\n", since)).toEqual({ kind: "notARepository" });
    expect(parseGitLog("", since)).toEqual({ kind: "commits", commits: [] });
  });

  const scratch = process.env["HERDR_TEST_SCRATCH"] ?? "";
  const canRun = process.platform !== "win32" && existsSync("/usr/bin/git") && existsSync("/bin/sh");
  const roots: string[] = [];
  afterAll(() => {
    // Left for the scratch folder to be trashed with it (no rm in tests).
    roots.length = 0;
  });

  it.runIf(canRun)("runs in awkward folders through zsh and sh", () => {
    const base = existsSync(scratch) ? scratch : tmpdir();
    const root = mkdtempSync(path.join(base, "away-git-"));
    roots.push(root);
    const config = path.join(root, "gitconfig");
    writeFileSync(config, "[user]\n\tname = Fixture\n\temail = fixture@example.invalid\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n");
    const env = { ...process.env, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: "1" };
    const git = (args: string[], cwd: string, when?: string): void => {
      execFileSync("/usr/bin/git", ["-c", "core.hooksPath=/dev/null", ...args], {
        cwd,
        env: when === undefined ? env : { ...env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when },
        stdio: "ignore",
      });
    };
    const names = ["plain", "with space", "it's quoted", "dollar $HOME and $(echo no)", "back`tick`", "new\nline", 'double"quote', "-dash", "semi;colon && echo no"];
    for (const name of names) {
      const folder = path.join(root, name);
      mkdirSync(folder, { recursive: true });
      git(["init", "-q", "."], folder);
      git(["commit", "-q", "--allow-empty", "-m", `Before since in ${name}`], folder, "2026-11-02T00:30:00Z");
      git(["commit", "-q", "--allow-empty", "-m", `After since in ${name}`], folder, "2026-11-02T01:30:00Z");
    }
    const plain = path.join(root, "not a repo");
    mkdirSync(plain);
    const run = (shell: string, command: string): string =>
      execFileSync(shell, ["-c", command], { env, stdio: ["ignore", "pipe", "ignore"], cwd: plain }).toString("utf8");
    for (const shell of ["/bin/zsh", "/bin/sh"].filter((candidate) => existsSync(candidate))) {
      for (const name of names) {
        const parsed = parseGitLog(run(shell, gitLogCommand(path.join(root, name), since, 50).text), since);
        // git's subject line folds a line break in the message into a space.
        expect(parsed, `${shell} ${name}`).toEqual({
          kind: "commits",
          commits: [expect.objectContaining({ subject: "After since in " + name.replace("\n", " ") })],
        });
      }
      expect(parseGitLog(run(shell, gitLogCommand(plain, since, 50).text), since)).toEqual({ kind: "notARepository" });
      expect(parseGitLog(run(shell, gitLogCommand(path.join(root, "gone"), since, 50).text), since)).toEqual({ kind: "notARepository" });
    }
  });
});

describe("collecting a machine", () => {
  it("reads at most three at once", async () => {
    probe.now = 0;
    probe.most = 0;
    const list = panes(9);
    const start = date("2026-11-02T01:10:00.000Z");
    const reader = new FakeTranscripts(filesFor(list, (pane) => transcript(start, 2, 0, pane.folder!)), 30);
    const runner = new FakeGit("", 30);
    const input = await collectAway({ id: "studio", name: "Studio Mac", since, panes: list, reader, runner });
    expect(reader.mostAtOnce).toBe(3);
    expect(probe.most).toBeLessThanOrEqual(3);
    expect(input.panes.map((entry) => entry.pane.paneID)).toEqual(list.map((pane) => pane.paneID));
    expect(input.panes.every((entry) => entry.transcript.kind === "read" && entry.transcript.activity.turnsFinished === 2)).toBe(true);
    // One git per folder.
    expect(runner.commands.length).toBe(9);
    expect(Object.keys(input.git).sort()).toEqual(list.map((pane) => pane.folder!).sort());
  });

  it("reads twenty panes and marks the rest not read", async () => {
    const list = panes(25, (index) => (index === 24 ? "blocked" : index === 23 ? "working" : "idle"));
    const start = date("2026-11-02T01:10:00.000Z");
    const reader = new FakeTranscripts(filesFor(list, (pane) => transcript(start, 1, 0, pane.folder!)));
    const input = await collectAway({ id: "studio", name: "Studio Mac", since, panes: list, reader, runner: null });
    expect(defaultAwayLimits.panesPerMac).toBe(20);
    expect(input.panes.filter((entry) => entry.transcript.kind === "notRead").map((entry) => entry.pane.paneID)).toEqual(["p0", "p1", "p2", "p3", "p4"]);
    expect(input.git).toEqual({});
    expect(buildAwayDigest([input], now).cards.filter((card) => card.transcript === "notRead").length).toBe(5);
  });

  it("says no transcript for a pane without a session and unreadable for a file that is gone", async () => {
    const list = panes(2);
    list[0] = { ...list[0]!, kind: "grok", session: null };
    const input = await collectAway({ id: "studio", name: "Studio Mac", since, panes: list, reader: new FakeTranscripts({}), runner: null });
    expect(input.panes.map((entry) => entry.transcript.kind)).toEqual(["noTranscript", "unreadable"]);
  });

  it("does not read another pane's session as this one", async () => {
    const list = panes(1);
    const text = transcript(date("2026-11-02T01:10:00.000Z"), 2);
    const lookup = list[0]!.session!.ref;
    const other: AwayPane = { ...list[0]!, folder: "/Users/fixture/other", session: { ref: lookup, source: "herdr:claude", paneFolders: ["/Users/fixture/other"] } };
    const reader = new FakeTranscripts(filesFor(list, () => text));
    const input = await collectAway({ id: "studio", name: "Studio Mac", since, panes: [other], reader, runner: null });
    expect(input.panes[0]!.transcript.kind).toBe("unreadable");
    // The same transcript in its own folder is read.
    const own: AwayPane = { ...other, folder: "/Users/fixture/proj", session: { ref: lookup, source: "herdr:claude", paneFolders: ["/Users/fixture/proj"] } };
    const same = await collectAway({ id: "studio", name: "Studio Mac", since, panes: [own], reader, runner: null });
    const state = same.panes[0]!.transcript;
    expect(state.kind === "read" ? state.activity.turnsFinished : -1).toBe(2);
  });

  it("times git out after its limit", async () => {
    const started = Date.now();
    const input = await collectAway(
      { id: "studio", name: "Studio Mac", since, panes: panes(1), reader: new FakeTranscripts({}), runner: new FakeGit("", 5_000) },
      limits({ gitTimeoutMs: 200 }),
    );
    expect(input.git["/p/0"]).toEqual({ kind: "timedOut" });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(defaultAwayLimits.gitTimeoutMs).toBe(5_000);
  });

  it("stops the reads when cancelled", async () => {
    const list = panes(12);
    const start = date("2026-11-02T01:10:00.000Z");
    const reader = new FakeTranscripts(filesFor(list, (pane) => transcript(start, 2, 0, pane.folder!)), 300);
    const controller = new AbortController();
    const collecting = collectAway({ id: "studio", name: "Studio Mac", since, panes: list, reader, runner: null }, defaultAwayLimits, controller.signal);
    for (let waited = 0; reader.started < 3 && waited < 100; waited += 1) await sleep(10);
    expect(reader.started).toBe(3);
    controller.abort();
    await expect(collecting).rejects.toBeInstanceOf(CancelledError);
    await sleep(400);
    expect(reader.started).toBe(3);
  });

  it("looks twelve hours back the first time", () => {
    expect(firstSince(now)).toBe(now - 12 * 3600);
    expect(sessionID.length).toBe(36);
  });
});

// Grok dates its lines in milliseconds since 1970.
const grokSession = "01a19e72-280e-7291-9d2d-8c2ac0bdb217";

/** A Grok updates.jsonl of `count` exchanges a minute apart from `start` (seconds), each reply padded to about `padding` bytes. */
function grokTranscript(start: number, count: number, padding = 0): string {
  const line = (seconds: number, update: Parameters<typeof json>[0]): string =>
    json({ timestamp: Math.round(seconds * 1000), method: "session/update", params: { sessionId: grokSession, update } });
  const lines: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const time = start + index * 60;
    lines.push(line(time, { sessionUpdate: "user_message_chunk", content: { type: "text", text: `Question ${index}` } }));
    lines.push(line(time + 30, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `Answer ${index} ` + "x".repeat(padding) } }));
  }
  return lines.join("\n") + "\n";
}

describe("the backward read dates Grok's millisecond lines", () => {
  it("reads a Grok line's time and keeps ISO", () => {
    const text = grokTranscript(date("2026-11-02T01:10:00.000Z"), 1);
    expect(lineTime(text.split("\n")[0]!)).toBe(date("2026-11-02T01:10:00.000Z"));
    expect(lineTime(text.split("\n")[1]!)).toBe(date("2026-11-02T01:10:30.000Z"));
    expect(lineTime(json({ type: "user", timestamp: "2026-11-02T01:10:00.250Z" }))).toBe(date("2026-11-02T01:10:00.250Z"));
    expect(lineTime(json({ type: "user", timestamp: "1793582000000" }))).toBeNull();
    expect(lineTime(json({ type: "user", timestamp: 0 }))).toBeNull();
  });

  it("stops once it passes since", async () => {
    const text = grokTranscript(date("2026-11-01T22:00:00.000Z"), 300, 700);
    const reader = new FakeTranscripts({ "/t/g.jsonl": text });
    const read = await readTranscriptEnd(reader, "/t/g.jsonl", since, limits({ chunkBytes: 16 * 1_024 }));
    expect(read.truncated).toBe(false);
    expect(read.reachedStart).toBe(false);
    const times = read.lines.map((line) => lineTime(line.text)).filter((time): time is number => time !== null);
    expect(times[0]!).toBeLessThan(since);
    expect(times.filter((time) => time >= since).length).toBe(2 * 120);
    expect(read.bytesRead).toBeLessThan(text.length / 2);
  });

  it("costs one chunk for a quiet Grok transcript", async () => {
    const text = grokTranscript(date("2026-11-01T20:00:00.000Z"), 200, 400);
    const reader = new FakeTranscripts({ "/t/gq.jsonl": text });
    const read = await readTranscriptEnd(reader, "/t/gq.jsonl", since, limits({ chunkBytes: 32 * 1_024 }));
    expect(reader.requests.length).toBe(1);
    expect(read.truncated).toBe(false);
    expect(read.reachedStart).toBe(false);
  });

  it("marks truncation only when the cap stops it before since", async () => {
    // About 5 MB in all; `since` is about 1 MB from the end: crossed inside the cap.
    const crossing = grokTranscript(date("2026-11-01T22:00:00.000Z"), 2_500, 1_400);
    expect(crossing.length).toBeGreaterThan(4 * 1_024 * 1_024);
    const crossed = await readTranscriptEnd(new FakeTranscripts({ "/t/gc.jsonl": crossing }), "/t/gc.jsonl", date("2026-11-03T05:00:00.000Z"));
    expect(crossed.truncated).toBe(false);
    expect(crossed.bytesRead).toBeLessThan(2 * 1_024 * 1_024);
    // All of it after `since`: the cap stops it.
    const recent = grokTranscript(date("2026-11-02T01:00:30.000Z"), 2_500, 1_400);
    const capped = await readTranscriptEnd(new FakeTranscripts({ "/t/gr.jsonl": recent }), "/t/gr.jsonl", since);
    expect(capped.truncated).toBe(true);
    expect(capped.bytesRead).toBe(2 * 1_024 * 1_024);
    expect(capped.lines.every((line) => lineTime(line.text) !== null)).toBe(true);
  });
});

// The cases of HerdrKit's ConversationSearchCommandTests.swift: the one remote
// command of a search, its output, the results by pane, and the run's bounds
// and cancellation. The command is also run for real on this machine (through
// /bin/sh and zsh, a Mac's login shell) against a fake home of fixture files in
// the tests' scratch folder; nothing reaches a machine.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { makeSessionRef } from "../src/shared/chat/locator";
import type { TranscriptFormat } from "../src/shared/chat/parser";
import { OutputCollector, type RemoteCommand } from "../src/shared/remote-command";
import { SearchRun, isFinal, type SearchUpdate } from "../src/shared/search/runner";
import { SearchFakeRemote, until } from "./support/search-fake";
import { SearchCommand, SearchQuery, SearchResults, paneMore, paneShown, searchBounds, type SearchAuthor, type SearchMatch, type SearchTarget } from "../src/shared/search/search";

const claudeID = "5b1d7c2e-8f3a-4e6b-9c0d-1a2b3c4d5e6f";
const otherClaudeID = "7c2e5b1d-3a8f-6b4e-0d9c-6f5e4d3c2b1a";
const codexID = "019a3c2e-7d41-7b20-9f3e-2c1d0e9f8a7b";
const encoder = new TextEncoder();
const bytes = (text: string): Uint8Array => encoder.encode(text);

function byID(pane: string, format: TranscriptFormat, id: string): SearchTarget {
  return { paneID: pane, session: makeSessionRef(format, { kind: "id", id })! };
}
function byPath(pane: string, format: TranscriptFormat, file: string): SearchTarget {
  return { paneID: pane, session: makeSessionRef(format, { kind: "path", path: file })! };
}
const query = (text: string): SearchQuery => SearchQuery.make(text)!;

// MARK: - helpers for the real runs

const scratch = process.env["HERDR_TEST_SCRATCH"] ?? "";
const shells = ["/bin/sh", "/bin/zsh"].filter((shell) => existsSync(shell));

function makeHome(): string {
  // Left in the tests' scratch folder (HERDR_TEST_SCRATCH), trashed with it (no rm in tests).
  return mkdtempSync(path.join(existsSync(scratch) ? scratch : tmpdir(), "search-home-"));
}

function write(file: string, lines: readonly string[], modified?: number): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, lines.join("\n") + "\n");
  if (modified !== undefined) utimesSync(file, modified, modified);
}

/** The command as a machine's login shell gets it over SSH (`$SHELL -c`): from a script file, its bytes exact. */
function run(command: RemoteCommand, shell: string, home: string): { status: number; stdout: Uint8Array } {
  const script = path.join(home, `command-${Math.random().toString(36).slice(2)}.sh`);
  writeFileSync(script, command.text);
  try {
    const stdout = execFileSync(shell, [script], { env: { HOME: home, PATH: "/usr/bin:/bin" }, cwd: home, stdio: ["ignore", "pipe", "ignore"] });
    return { status: 0, stdout: new Uint8Array(stdout) };
  } catch (error) {
    const failed = error as { status?: number; stdout?: Buffer };
    return { status: failed.status ?? 1, stdout: new Uint8Array(failed.stdout ?? Buffer.alloc(0)) };
  }
}

function lineStart(lineNumber: number, text: string): number {
  let offset = 0;
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    if (index + 1 === lineNumber) return offset;
    offset += bytes(lines[index]!).length + 1;
  }
  return Number.MAX_SAFE_INTEGER;
}

describe("the query", () => {
  it("needs two characters, is trimmed and cut", () => {
    expect(SearchQuery.make("")).toBeNull();
    expect(SearchQuery.make("  a \n")).toBeNull();
    expect(SearchQuery.make("  ab  ")?.text).toBe("ab");
    expect(SearchQuery.make("é́x")?.text).toBe("é́x");
    const long = "paywall ".repeat(60);
    expect([...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(SearchQuery.make(long)!.text)].length).toBe(searchBounds.maximumQueryCharacters);
  });

  it("gives grep the query and how JSON writes it", () => {
    expect(query('say "hi" \\ there').remotePatterns).toEqual(['say "hi" \\ there', 'say \\"hi\\" \\\\ there']);
    // ASCII case is grep's (-i): one pattern for every ASCII spelling.
    expect(query("Paywall Bug").remotePatterns).toEqual(["Paywall Bug"]);
    // Letters grep cannot fold: composed and decomposed, upper case composed, and without diacritics.
    const accented = query("Café Crème");
    expect(accented.remotePatterns).toEqual(["Café Crème", "Café Crème", "CAFÉ CRÈME", "Cafe Creme"]);
    // A control character never stands raw in a JSON line: only escaped.
    expect(query("a\tb").remotePatterns).toEqual(["a\\tb"]);
    expect(SearchQuery.jsonEscaped("\u0001\n\r\u0008\u000c")).toBe("\\u0001\\n\\r\\b\\f");
    expect(accented.remotePatterns.length).toBeLessThanOrEqual(searchBounds.maximumPatterns);
  });
});

describe("the command", () => {
  it("is bounded, read only and uses stock tools", () => {
    const targets = Array.from({ length: 35 }, (_, index) => byID(`pane-${index}`, "claude", "5b1d7c2e-8f3a-4e6b-9c0d-" + String(index).padStart(12, "0")));
    const command = SearchCommand.make(query("paywall"), targets)!;
    expect(command.targets.length).toBe(30);
    expect(command.skipped.map((target) => target.paneID)).toEqual(Array.from({ length: 5 }, (_, index) => `pane-${30 + index}`));
    const text = command.command.text;
    expect(text.startsWith("/bin/sh -c '")).toBe(true);
    for (const part of ["export LC_ALL=C;", "ulimit -t 20", "/usr/bin/grep -F -i -a -H -b -n -s -m 50 -e ", "| /usr/bin/cut -b ", "exit 0"]) {
      expect(text).toContain(part);
    }
    // Nothing is written: no redirection but stderr's to /dev/null, no tool that changes a file.
    expect(text.replaceAll("2>/dev/null", "")).not.toContain(">");
    for (const tool of ["rm ", "mv ", "touch ", "tee ", "sed ", "chmod ", "cp "]) expect(text).not.toContain(tool);
    expect(SearchCommand.make(query("paywall"), [])).toBeNull();
    // The same transcript twice is searched once.
    const twice = SearchCommand.make(query("paywall"), [byID("a", "claude", claudeID), byID("b", "claude", claudeID)])!;
    expect(twice.targets.map((target) => target.paneID)).toEqual(["a"]);
    expect(twice.skipped.map((target) => target.paneID)).toEqual(["b"]);
    // What it is for, for the demo machine.
    expect(twice.command.intent).toEqual({
      kind: "search",
      patterns: ["paywall"],
      targets: [{ index: 0, path: null, lookup: { kind: "id", id: claudeID, format: "claude" } }],
      maxHitsPerFile: 50,
    });
  });

  it("quotes every argument and finds the lines, through sh and zsh", () => {
    const home = makeHome();
    const marker = path.join(home, "ran");
    const claudeFolder = path.join(home, `.claude/projects/-Users-f-it's a "proj" $HOME \`id\` é`);
    const claude = path.join(claudeFolder, `${claudeID}.jsonl`);
    const seatsFile = path.join(home, `.claude-seats/dev/projects/-Users-f-other/${otherClaudeID}.jsonl`);
    const codexPath = path.join(home, `.codex/sessions/2026/11/01/rollout-2026-11-01T03-00-00-${codexID}.jsonl`);
    const pathFile = path.join(home, "named: by path/a:b.jsonl");
    const queries = ["paywall bug", `it's "quoted"`, "costs $5 `today`", "-v starts with a dash", "back\\slash", `$(touch ${marker})`, "Crème brûlée", "two\nlines", "a:b:c"];
    const lines: string[] = [];
    queries.forEach((raw, index) => {
      lines.push(`{"type":"user","n":${index},"message":{"content":"before"}}`);
      lines.push(`{"type":"user","n":${index},"message":{"content":"x ${SearchQuery.jsonEscaped(raw)} y"}}`);
    });
    write(claude, lines);
    write(seatsFile, ['{"type":"user","message":{"content":"PAYWALL BUG upper"}}']);
    write(codexPath, ['{"type":"response_item","payload":{"text":"paywall bug in codex"}}', '{"type":"response_item","payload":{"text":"une crème brûlée"}}']);
    write(pathFile, ['{"type":"user","message":{"content":"paywall bug by path"}}']);
    const targets = [
      byID("cl", "claude", claudeID),
      byID("seats", "claude", otherClaudeID),
      byID("cx", "codex", codexID),
      byPath("path", "claude", pathFile),
      byID("none", "codex", "00000000-0000-0000-0000-000000000000"),
    ];
    const fileText = lines.join("\n") + "\n";
    expect(shells.length).toBeGreaterThan(0);
    for (const shell of shells) {
      queries.forEach((raw, index) => {
        const command = SearchCommand.make(query(raw), targets)!;
        const output = run(command.command, shell, home);
        expect(output.status, `${shell} ${raw}`).toBe(0);
        const listing = command.parse(output.stdout, false);
        expect(listing.files.get(0), `${shell} ${raw}`).toBe(claude);
        expect(listing.files.has(4)).toBe(false);
        const inClaude = listing.hits.filter((hit) => hit.target === 0);
        expect(inClaude.length, `${shell} ${raw}: ${JSON.stringify(listing.hits)}`).toBe(1);
        expect(inClaude[0]!.lineNumber).toBe(index * 2 + 2);
        expect(inClaude[0]!.offset, `${shell} ${raw}: the offset is the line's start`).toBe(lineStart(inClaude[0]!.lineNumber, fileText));
        expect(existsSync(marker), `${shell} ${raw}: nothing ran`).toBe(false);
      });
      const creme = SearchCommand.make(query("crème brûlée"), targets)!;
      const decomposed = creme.parse(run(creme.command, shell, home).stdout, false);
      expect(decomposed.hits.filter((hit) => hit.target === 2).map((hit) => hit.lineNumber), `${shell}: a decomposed line found by a composed query`).toEqual([2]);
      const paywall = SearchCommand.make(query("paywall bug"), targets)!;
      const listing = paywall.parse(run(paywall.command, shell, home).stdout, false);
      expect(new Set(listing.hits.map((hit) => hit.target))).toEqual(new Set([0, 1, 2, 3]));
      expect(listing.files.get(1)).toBe(seatsFile);
      expect(listing.files.get(2)).toBe(codexPath);
      expect(listing.files.get(3), "a path with colons and spaces").toBe(pathFile);
    }
  });

  it("stops at fifty hits a file and takes the newest file; finds a Claude folder's newest transcript", () => {
    const home = makeHome();
    const older = path.join(home, `.claude/projects/-a/${claudeID}.jsonl`);
    const newer = path.join(home, `.claude-seats/x/projects/-b/${claudeID}.jsonl`);
    write(older, ['{"m":"paywall in the old one"}'], 1_700_000_000);
    write(newer, Array.from({ length: 80 }, (_, index) => `{"m":"paywall ${index}"}`), 1_800_000_000);
    const folderOld = path.join(home, `.claude/projects/-srv-app/${otherClaudeID}.jsonl`);
    const folderNew = path.join(home, `.claude/projects/-srv-app/11111111-2222-3333-4444-555555555555.jsonl`);
    write(folderOld, ['{"m":"paywall old session"}'], 1_700_000_000);
    write(folderNew, ['{"m":"paywall new session"}'], 1_800_000_000);
    const command = SearchCommand.make(query("PayWall"), [byID("cl", "claude", claudeID)])!;
    const byFolder = SearchCommand.make(query("paywall"), [{ paneID: "f", session: makeSessionRef("claude", { kind: "folder", folder: "/srv/app" })! }])!;
    for (const shell of shells) {
      const listing = command.parse(run(command.command, shell, home).stdout, false);
      expect(listing.files.get(0), shell).toBe(newer);
      expect(listing.hits.length, shell).toBe(50);
      expect(listing.hits.at(-1)?.lineNumber, shell).toBe(50);
      const folder = byFolder.parse(run(byFolder.command, shell, home).stdout, false);
      expect(folder.files.get(0), shell).toBe(folderNew);
      expect(folder.hits.length).toBe(1);
    }
  });
});

describe("the output", () => {
  it("handles colons in paths and in the text", () => {
    const first = "/Users/f/a:1:2:/x.jsonl";
    const second = "/Users/f/a:1:2:/x.jsonl:3:4:.jsonl";
    const command = SearchCommand.make(query("paywall"), [byPath("one", "claude", first), byPath("two", "codex", second)])!;
    const output = [
      `#0:${first}`,
      `#1:${second}`,
      `${first}:12:3456:{"text":"a:b:c paywall 1:2:3:"}`,
      `${first}:13:3500:{"x":"`,
      `${second}:3:99:{"y":"paywall"}`,
      `${second}:4:150:`,
      "/elsewhere.jsonl:1:0:{}",
      `${first}x:1:2:{}`,
      `${second}:notanumber:1:{}`,
      "",
    ].join("\n");
    const listing = command.parse(bytes(output), false);
    expect([...listing.files]).toEqual([
      [0, first],
      [1, second],
    ]);
    expect(listing.hits).toEqual([
      { target: 0, lineNumber: 12, offset: 3456 },
      { target: 0, lineNumber: 13, offset: 3500 },
      { target: 1, lineNumber: 3, offset: 99 },
      { target: 1, lineNumber: 4, offset: 150 },
    ]);
    expect(listing.truncated).toBe(false);
  });

  it("drops the line the cap cut; a file must be the one asked for", () => {
    const claudePath = `/Users/f/.claude/projects/-p/${claudeID}.jsonl`;
    const command = SearchCommand.make(query("paywall"), [byID("cl", "claude", claudeID), byPath("p", "codex", "/Users/f/asked.jsonl")])!;
    const output = `#0:${claudePath}\n#1:/Users/f/other.jsonl\n#7:/Users/f/x.jsonl\n${claudePath}:1:0:{}\n${claudePath}:2:40:{"cut`;
    let listing = command.parse(bytes(output), true);
    expect([...listing.files]).toEqual([[0, claudePath]]);
    expect(listing.hits).toEqual([{ target: 0, lineNumber: 1, offset: 0 }]);
    expect(listing.truncated).toBe(true);
    listing = command.parse(bytes(`#0:${claudePath}\n${claudePath}:1:0:{}\n${claudePath}:2:4`), true);
    expect(listing.hits.length).toBe(1);
    const wrong = `/Users/f/.claude/projects/-p/${otherClaudeID}.jsonl`;
    listing = command.parse(bytes(`#0:${wrong}\n${wrong}:1:0:{}\n`), false);
    expect(listing.files.size).toBe(0);
    expect(listing.hits).toEqual([]);
  });
});

describe("results", () => {
  const base = 1_800_000_000;
  const match = (pane: string, offset: number, minutesAgo: number | null, author: SearchAuthor = "you"): SearchMatch => ({
    paneID: pane,
    lineOffset: offset,
    messageID: `${pane}-${offset}`,
    author,
    time: minutesAgo === null ? null : base - minutesAgo * 60,
    snippet: { text: "paywall", highlights: [{ start: 0, end: 7 }] },
  });

  it("group by pane, newest match first", () => {
    const results = new SearchResults(["a", "b", "c", "d"]);
    results.expect(7, "a");
    results.expect(2, "b");
    results.expect(1, "c");
    results.expect(1, "d");
    expect(results.panes.map((pane) => pane.paneID)).toEqual([]);
    results.add(match("a", 100, 30));
    results.add(match("b", 10, 5));
    results.add(match("c", 5, null));
    results.drop("d");
    expect(results.panes.map((pane) => pane.paneID)).toEqual(["b", "a", "c"]);
    for (const [offset, minutes] of [
      [200, 20],
      [300, 10],
      [50, 60],
      [400, 40],
      [500, 1],
    ] as const) {
      results.add(match("a", offset, minutes));
    }
    expect(results.panes.map((pane) => pane.paneID)).toEqual(["a", "b", "c"]);
    const a = results.panes[0]!;
    expect(a.matches.map((found) => found.lineOffset)).toEqual([500, 300, 200, 100, 400, 50]);
    expect(paneShown(a).length).toBe(5);
    expect(a.unread).toBe(1);
    expect(paneMore(a)).toBe(1);
    results.add(match("a", 500, 1));
    expect(results.panes[0]!.matches.length).toBe(6);
    expect(results.matchCount).toBe(8);
  });

  it("without a time follow the file", () => {
    const results = new SearchResults();
    results.add(match("a", 10, null));
    results.add(match("a", 30, null));
    results.add(match("a", 20, 5));
    expect(results.panes[0]!.matches.map((found) => found.lineOffset)).toEqual([20, 30, 10]);
  });
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("the run", () => {
  it("caps the output and says more are not shown", () => {
    const collector = new OutputCollector(10);
    expect(collector.append(bytes("12345"))).toBe(true);
    expect(collector.append(bytes("6789012"))).toBe(false);
    expect([new TextDecoder().decode(collector.output.bytes), collector.output.truncated]).toEqual(["1234567890", true]);
    expect(collector.append(bytes("x"))).toBe(false);
    expect(collector.bytes.length).toBe(10);
  });

  it("lists the hits per pane with one exec", async () => {
    const file = `/Users/f/.claude/projects/-p/${claudeID}.jsonl`;
    const remote = new SearchFakeRemote(`#0:${file}\n${file}:1:0:x\n${file}:3:90:x\n`);
    const run = new SearchRun(query("paywall"), [byID("cl", "claude", claudeID)], remote);
    const last = await until(run, isFinal);
    run.cancel();
    expect(last.phase).toBe("done");
    expect(remote.commands.length).toBe(1);
    expect(last.results.unread).toBe(0);
    expect(last.unreadable).toBe(2);
    expect(remote.reads.map((read) => read.offset).sort((a, b) => a - b)).toEqual([0, 90]);
  });

  it("says when the command gets no answer in time, and stops it", async () => {
    const remote = new SearchFakeRemote("", { hang: true });
    const run = new SearchRun(query("paywall"), [byID("cl", "claude", claudeID)], remote, 200);
    const started = Date.now();
    const last = await until(run, isFinal);
    expect(last.phase).toBe("timedOut");
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(remote.cancelledRuns).toBe(1);
  });

  it("cancelling stops the command and publishes nothing more", async () => {
    const remote = new SearchFakeRemote("", { hang: true });
    const run = new SearchRun(query("paywall"), [byID("cl", "claude", claudeID)], remote);
    const updates: SearchUpdate[] = [];
    run.onUpdate((update) => updates.push(update));
    run.start();
    await sleep(10);
    expect(remote.commands.length).toBe(1);
    run.cancel();
    await sleep(10);
    expect(remote.cancelledRuns).toBe(1);
    expect(updates.every((update) => update.phase === "searching")).toBe(true);
  });

  it("says when the command failed", async () => {
    const run = new SearchRun(query("paywall"), [byID("cl", "claude", claudeID)], new SearchFakeRemote("", { failure: new Error("closed before response") }));
    expect((await until(run, isFinal)).phase).toBe("failed");
  });
});

// The same cases as HerdrKit's ConversationSearchHitsTests.swift:
// the hit reader. A hit's line is read by its offset (bounded at 1 MB), parsed
// with the agent's parser and searched in what the chat shows: the user's messages
// (typed, queued, pasted), the agent's replies, the commands run; a hit in a
// tool's output, thinking, a subagent's line or a field the chat does not show
// is dropped. Then the run's reads: newest lines first, three at once, the
// rest on "N more"; one input written both ways is one result. Fixtures are
// hand-built in the shapes of the chat tests, never a real transcript.

import { describe, expect, it } from "vitest";

import { ChatTimelineBuilder } from "../src/shared/chat/builder";
import { makeSessionRef } from "../src/shared/chat/locator";
import type { TranscriptFormat } from "../src/shared/chat/parser";
import { TranscriptParser } from "../src/shared/chat/parser";
import { parseChatDate } from "../src/shared/chat/tools";
import { hitOutcome, readLine, snippet, snippetLength, type SearchHitOutcome } from "../src/shared/search/hits";
import { SearchRun, isFinal, type SearchUpdate } from "../src/shared/search/runner";
import { SearchCommand, SearchQuery, graphemes, paneMore, paneShown, searchBounds, type SearchMatch, type SearchSnippet, type SearchTarget } from "../src/shared/search/search";
import { claudePath, codexPath, json, queued, reply, result, stamp, tool, user } from "./support/chat-lines";
import { tonight, tonightText } from "./support/pasted-tonight";
import { SearchFakeRemote, until } from "./support/search-fake";

const encoder = new TextEncoder();
const query = (text: string): SearchQuery => SearchQuery.make(text)!;
const target = (pane: string, format: TranscriptFormat, file: string): SearchTarget => ({ paneID: pane, session: makeSessionRef(format, { kind: "path", path: file })! });
const fileBytes = (lines: readonly string[]): Uint8Array => encoder.encode(lines.join("\n") + "\n");

function offsets(lines: readonly string[]): number[] {
  const out: number[] = [];
  let next = 0;
  for (const line of lines) {
    out.push(next);
    next += encoder.encode(line).length + 1;
  }
  return out;
}

/** A Claude Code transcript: typed, queued and pasted messages, a reply after thinking, a Bash call and its output, a `!` command, a subagent's line, a folder-only hit and a message over 1 MB. */
function claudeLines(): string[] {
  const longText = "lighthouse " + "x".repeat(1_100_000);
  return [
    user("Can you look at the Lighthouse banner? It wraps on the phone.", "u1", 0),
    json({
      isSidechain: false,
      sessionId: "5b1d7c2e-8f3a-4e6b-9c0d-1a2b3c4d5e6f",
      timestamp: stamp(5),
      type: "assistant",
      uuid: "a1",
      message: {
        content: [
          { thinking: "the lighthouse thinking, never searched", signature: "c2ln", type: "thinking" },
          { text: "The banner comes from Banner.swift; the **Lighthouse** view draws it.", type: "text" },
        ],
        id: "msg_a1",
        role: "assistant",
        stop_reason: null,
        type: "message",
      },
    }),
    tool("toolu_1", "swift test --filter LighthouseBannerTests", "a2", 8),
    result("toolu_1", "Test Suite 'LighthouseBannerTests' passed", "r1", 9),
    queued("also check the lighthouse icon", "q1", "s1", 12),
    user('<pasted_content id="713e">\nLighthouse crash log, line one\nline two\n</pasted_content>', "u2", 20),
    user("a subagent's lighthouse prompt", "side1", 21, { isSidechain: true }),
    user("<bash-input>ls Sources/Lighthouse</bash-input>", "u3", 24),
    user("hello from the folder", "u4", 26, { cwd: "/Users/fixture/lighthouse" }),
    user(longText, "u5", 30),
    reply("Done: the Lighthouse banner fits.", "a3", 40, true),
  ];
}

/** A Codex rollout: a session line, a message, reasoning, a patch, a script's command and its output, a classified search, its output and a reply. */
function codexLines(): string[] {
  const item = (ordinal: number, second: number, payload: Record<string, unknown>): string =>
    json({ ordinal, payload, type: "response_item", timestamp: `2026-11-01T03:10:${String(second).padStart(2, "0")}.000Z` } as never);
  return [
    json({ ordinal: 0, type: "session_meta", timestamp: "2026-11-01T03:10:00.000Z", payload: { cwd: "/Users/fixture/lighthouse", id: "019a3c2e", source: "cli" } }),
    item(1, 1, { content: [{ text: "Rename the Lighthouse target", type: "input_text" }], id: "m1", role: "user", type: "message" }),
    item(2, 2, { encrypted_content: "gAAAAB", id: "rs1", type: "reasoning", summary: [{ text: "lighthouse reasoning", type: "summary_text" }] }),
    item(3, 3, {
      call_id: "call_patch",
      id: "ctc1",
      name: "exec",
      status: "completed",
      type: "custom_tool_call",
      input: 'text(await tools.apply_patch("*** Begin Patch\\n*** Update File: /Users/fixture/proj/Lighthouse.swift\\n@@\\n-let a = 1\\n+let a = 2\\n*** End Patch"));',
    }),
    item(4, 4, { call_id: "call_build", id: "ctc2", name: "exec", status: "completed", type: "custom_tool_call", input: 'text(await tools.exec_command({cmd:"swift build --product Lighthouse"}));' }),
    item(5, 6, { call_id: "call_build", id: "ctco2", type: "custom_tool_call_output", output: [{ text: "Script completed\nOutput:\nCompiling Lighthouse\n", type: "input_text" }] }),
    item(6, 7, { call_id: "call_rg", name: "exec_command", type: "function_call", arguments: '{"cmd":"rg -n Lighthouse Sources"}' }),
    item(7, 8, { call_id: "call_rg", type: "function_call_output", output: "Sources/Lighthouse.swift:1:x" }),
    item(8, 9, {
      content: [{ annotations: [], text: "Renamed; Lighthouse builds.", type: "output_text" }],
      id: "m4",
      phase: "final_answer",
      role: "assistant",
      status: "completed",
      type: "message",
    }),
  ];
}

/** What the search command prints for these files (ASCII case folded, as `grep -F -i` with `LC_ALL=C`). */
function grepOutput(files: readonly { path: string; lines: readonly string[] }[], searched: SearchQuery): string {
  const lower = (bytes: Uint8Array): number[] => Array.from(bytes, (byte) => (byte >= 65 && byte <= 90 ? byte + 32 : byte));
  const needles = searched.remotePatterns.map((pattern) => lower(encoder.encode(pattern)));
  let out = "";
  files.forEach((file, index) => {
    out += `#${index}:${file.path}\n`;
    const starts = offsets(file.lines);
    file.lines.forEach((line, number) => {
      const hay = lower(encoder.encode(line));
      const found = needles.some((needle) => {
        for (let at = 0; at + needle.length <= hay.length; at += 1) {
          let same = true;
          for (let j = 0; j < needle.length; j += 1) {
            if (hay[at + j] !== needle[j]) {
              same = false;
              break;
            }
          }
          if (same) return true;
        }
        return false;
      });
      if (found) out += `${file.path}:${number + 1}:${starts[number]}:x\n`;
    });
  });
  return out;
}

/** The ids of the rows one parse of the whole file shows (the chat's). */
function chatIDs(lines: readonly string[], format: TranscriptFormat): Set<string> {
  const parser = new TranscriptParser(format);
  const builder = new ChatTimelineBuilder();
  const starts = offsets(lines);
  lines.forEach((line, index) => builder.apply(parser.parse(line, starts[index]).events, starts[index]));
  return new Set(builder.timeline.turns.flatMap((turn) => turn.items.map((item) => item.value.id)));
}

/** Every hit of `searched` in one file read through the hit reader. */
async function outcomes(lines: readonly string[], file: string, format: TranscriptFormat, searched: SearchQuery): Promise<SearchHitOutcome[]> {
  const remote = new SearchFakeRemote("", { files: { [file]: fileBytes(lines) } });
  const command = SearchCommand.make(searched, [target("p", format, file)])!;
  const listing = command.parse(encoder.encode(grepOutput([{ path: file, lines }], searched)), false);
  const out: SearchHitOutcome[] = [];
  for (const hit of listing.hits) out.push(await hitOutcome(hit, file, target("p", format, file), searched, remote));
  return out;
}

const matchesOf = (found: readonly SearchHitOutcome[]): SearchMatch[] => found.flatMap((outcome) => (outcome.kind === "matches" ? outcome.matches : []));

function highlighted(snip: SearchSnippet | null | undefined): string[] {
  if (snip == null) return [];
  const characters = graphemes(snip.text);
  return snip.highlights.map((range) => characters.slice(range.start, range.end).join(""));
}

describe("Claude Code hits", () => {
  it("are the chat's messages, replies and commands", async () => {
    const lines = claudeLines();
    const found = await outcomes(lines, claudePath, "claude", query("lighthouse"));
    expect(found.length).toBe(11);
    const matches = matchesOf(found);
    expect(matches.map((match) => match.author)).toEqual(["you", "agent", "command", "you", "you", "command", "agent"]);
    expect(matches.map((match) => highlighted(match.snippet))).toEqual([["Lighthouse"], ["Lighthouse"], ["Lighthouse"], ["lighthouse"], ["Lighthouse"], ["Lighthouse"], ["Lighthouse"]]);
    expect(matches.map((match) => match.snippet?.text)).toEqual([
      "Can you look at the Lighthouse banner? It wraps on the phone.",
      "The banner comes from Banner.swift; the **Lighthouse** view draws it.",
      "swift test --filter LighthouseBannerTests",
      "also check the lighthouse icon",
      "Lighthouse crash log, line one\nline two",
      "ls Sources/Lighthouse",
      "Done: the Lighthouse banner fits.",
    ]);
    const ids = chatIDs(lines, "claude");
    for (const match of matches) expect(ids.has(match.messageID ?? "-"), `${match.messageID} is not a chat row`).toBe(true);
    const starts = offsets(lines);
    expect(matches.map((match) => match.lineOffset)).toEqual([0, 1, 2, 4, 5, 7, 10].map((index) => starts[index]));
    expect(matches[0]!.time).toBe(parseChatDate(stamp(0)));
    expect(matches[0]!.messageID).toBe("u1");
    expect(matches[2]!.messageID).toBe("toolu_1");
    expect(matches.some((match) => match.snippet?.text.includes("thinking"))).toBe(false);
    expect(found[3]).toEqual({ kind: "matches", matches: [] });
    expect(found[6]).toEqual({ kind: "matches", matches: [] });
    expect(found[8]).toEqual({ kind: "matches", matches: [] });
    expect(found[9]).toEqual({ kind: "longLine", match: { paneID: "p", lineOffset: starts[9], messageID: null, author: null, time: null, snippet: null } });
    expect(matches.some((match) => (match.snippet?.text ?? "").includes('"type"'))).toBe(false);
  });

  it("a query with quotes and a backslash matches the parsed text", async () => {
    const text = 'Run it as say "hi" \\ there and tell me';
    const found = await outcomes([user(text, "u1", 0)], claudePath, "claude", query('say "hi" \\ there'));
    const matches = matchesOf(found);
    expect(matches[0]?.snippet?.text).toBe(text);
    expect(highlighted(matches[0]?.snippet)).toEqual(['say "hi" \\ there']);
  });

  it("a paste closed with its id is a hit without its tags", async () => {
    const lines = [user(tonight, "u-713e", 0)];
    const matches = matchesOf(await outcomes(lines, claudePath, "claude", query("jerky")));
    expect(matches.length).toBe(1);
    expect(matches[0]!.messageID).toBe("u-713e");
    const text = matches[0]!.snippet!.text;
    expect(text).not.toContain("pasted_content");
    expect(tonightText.includes(text) || text.includes("jerky")).toBe(true);
    expect(await outcomes(lines, claudePath, "claude", query("pasted_content"))).toEqual([{ kind: "matches", matches: [] }]);
  });
});

describe("Codex hits", () => {
  it("are the message, the commands and the reply", async () => {
    const lines = codexLines();
    const found = await outcomes(lines, codexPath, "codex", query("LIGHTHOUSE"));
    expect(found.length).toBe(9);
    const matches = matchesOf(found);
    expect(matches.map((match) => match.author)).toEqual(["you", "command", "command", "agent"]);
    expect(matches.map((match) => match.snippet?.text)).toEqual(["Rename the Lighthouse target", "swift build --product Lighthouse", "rg Lighthouse", "Renamed; Lighthouse builds."]);
    expect(matches.map((match) => match.messageID)).toEqual(["m1", "call_build", "call_rg", "m4"]);
    const ids = chatIDs(lines, "codex");
    for (const match of matches) expect(ids.has(match.messageID ?? "-"), `${match.messageID} is not a chat row`).toBe(true);
    for (const index of [0, 2, 3, 5, 7]) expect(found[index], `line ${index}`).toEqual({ kind: "matches", matches: [] });
  });
});

describe("reading a line", () => {
  it("stays within its bound", async () => {
    const file = "/f.jsonl";
    const exact = "e".repeat(16);
    const over = "o".repeat(17);
    const text = "abc\n" + exact + "\n" + over + "\n" + "crlf\r\n" + "\n" + "last";
    const remote = new SearchFakeRemote("", { files: { [file]: encoder.encode(text) } });
    const read = async (offset: number) => {
      const before = remote.reads.length;
      const line = await readLine(remote, file, offset, 4, 16);
      return [line, remote.reads.slice(before).map((entry) => entry.maxBytes)] as const;
    };
    expect(await read(0)).toEqual([{ kind: "line", text: "abc" }, [4]]);
    expect(await read(4)).toEqual([{ kind: "line", text: exact }, [4, 13]]);
    expect(await read(21)).toEqual([{ kind: "tooLong" }, [4, 13]]);
    expect((await read(39))[0]).toEqual({ kind: "line", text: "crlf" });
    expect((await read(45))[0]).toEqual({ kind: "line", text: "" });
    expect((await read(46))[0]).toEqual({ kind: "line", text: "last" });
    expect((await read(50))[0]).toEqual({ kind: "gone" });
  });

  it("reads a message over one megabyte no further", async () => {
    const file = "/f.jsonl";
    const big = new Uint8Array(3_000_001).fill(0x7a);
    big[3_000_000] = 0x0a;
    const remote = new SearchFakeRemote("", { files: { [file]: big } });
    expect(await readLine(remote, file, 0)).toEqual({ kind: "tooLong" });
    expect(remote.reads[0]!.maxBytes).toBe(searchBounds.firstLineReadBytes);
    expect(remote.reads.reduce((sum, entry) => sum + entry.maxBytes, 0)).toBe(searchBounds.maximumLineBytes + 1);
  });
});

describe("the snippet", () => {
  it("folds case and diacritics", () => {
    expect(highlighted(snippet("Le CAFÉ crème est prêt", query("cafe creme")))).toEqual(["CAFÉ crème"]);
    const decomposed = snippet("Café Crème!", query("café crème"));
    expect(highlighted(decomposed)).toEqual(["Café Crème"]);
    expect(decomposed?.text).toBe("Café Crème!");
    expect(highlighted(snippet("needle and Needle", query("needle")))).toEqual(["needle", "Needle"]);
    expect(snippet("no match here", query("needle"))).toBeNull();
  });

  it("keeps the lines around the match and folds blank space", () => {
    const lines = snippet("first line\nsecond line has the needle\nthird line\nfourth line", query("needle"));
    expect(lines?.text).toBe("first line\nsecond line has the needle\nthird line…");
    expect(highlighted(lines)).toEqual(["needle"]);
    const space = snippet("a   lot\n\n\n  of \t space needle  ", query("needle"));
    expect(space?.text).toBe("a lot\nof space needle");
    expect(highlighted(space)).toEqual(["needle"]);
  });

  it("cuts between words and never inside a character", () => {
    const words = Array.from({ length: 200 }, (_, index) => `word${index + 1}`);
    const cut = snippet(words.join(" "), query("word100 word101"));
    const shown = cut?.text ?? "";
    expect(shown.startsWith("…")).toBe(true);
    expect(shown.endsWith("…")).toBe(true);
    const kept = shown.slice(1, -1).split(" ");
    expect(kept.every((word) => words.includes(word)), `a word was cut: ${kept.join(" ")}`).toBe(true);
    expect(graphemes(shown).length).toBeLessThanOrEqual(snippetLength + 2);
    expect(highlighted(cut)).toEqual(["word100 word101"]);

    const family = "\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}";
    const flag = "\u{1F1EB}\u{1F1F7}";
    const wide = family.repeat(150) + "néedle" + flag.repeat(300);
    const emoji = snippet(wide, query("needle"));
    const allowed = new Set([family, flag, "…", "n", "é", "e", "d", "l"]);
    expect(graphemes(emoji!.text).every((character) => allowed.has(character)), emoji?.text).toBe(true);
    expect(highlighted(emoji)).toEqual(["néedle"]);
    expect(graphemes(emoji!.text).length).toBeLessThanOrEqual(snippetLength + 2);
  });
});

/** `count` user messages that match, one a minute from `minute`, and a tool output that matches too. */
function messages(count: number, minute: number, word: string): string[] {
  const lines = Array.from({ length: count }, (_, index) => user(`${word} message ${index + 1}`, `${word}-${index + 1}`, (minute + index) * 60));
  lines.push(result("toolu_x", `${word} in a tool's output`, `${word}-r`, (minute + count) * 60));
  return lines;
}

describe("the run's reads", () => {
  it("reads each pane's newest lines three at once, then the rest on expand", async () => {
    const one = "/Users/fixture/.claude/projects/-Users-fixture-proj/11111111-1111-1111-1111-111111111111.jsonl";
    const two = "/Users/fixture/.claude/projects/-Users-fixture-proj/22222222-2222-2222-2222-222222222222.jsonl";
    const oneLines = messages(12, 0, "beacon");
    const twoLines = messages(3, 30, "beacon");
    const searched = query("beacon");
    const remote = new SearchFakeRemote(grepOutput([{ path: one, lines: oneLines }, { path: two, lines: twoLines }], searched), {
      files: { [one]: fileBytes(oneLines), [two]: fileBytes(twoLines) },
      readDelayMs: 20,
    });
    const run = new SearchRun(searched, [target("p1", "claude", one), target("p2", "claude", two)], remote);
    const phases: string[] = [];
    run.onUpdate((update) => {
      if (phases.at(-1) !== update.phase) phases.push(update.phase);
    });
    const final = await until(run, isFinal);
    expect(phases).toEqual(["searching", "reading", "done"]);
    const results = final.results;
    expect(results.panes.map((pane) => pane.paneID)).toEqual(["p2", "p1"]);
    expect(results.matchesIn("p1").map((match) => match.messageID)).toEqual([12, 11, 10, 9, 8].map((n) => `beacon-${n}`));
    expect(results.matchesIn("p2").map((match) => match.messageID)).toEqual([3, 2, 1].map((n) => `beacon-${n}`));
    expect(results.unreadIn("p1")).toBe(7);
    expect(results.unreadIn("p2")).toBe(0);
    expect(paneMore(results.panes.at(-1)!)).toBe(0);
    expect(remote.reads.length).toBe(6 + 4);
    expect(remote.mostReadsAtOnce).toBe(searchBounds.concurrentReads);

    const expanded = new Promise<SearchUpdate>((resolve) => {
      run.onUpdate((update) => {
        if (update.expanding.size === 0 && update.results.unreadIn("p1") === 0) resolve(update);
      });
    });
    run.expand("p1");
    const all = (await expanded).results;
    expect(all.matchesIn("p1").map((match) => match.messageID)).toEqual(Array.from({ length: 12 }, (_, index) => `beacon-${12 - index}`));
    expect(paneMore(all.panes.at(-1)!)).toBe(7);
    expect(paneShown(all.panes.at(-1)!).length).toBe(5);
    expect(remote.reads.length).toBe(13 + 4);
    expect(remote.mostReadsAtOnce).toBeLessThanOrEqual(searchBounds.concurrentReads);
    run.cancel();
  });

  it("counts a long line and a failed read", async () => {
    const file = "/Users/fixture/.claude/projects/-Users-fixture-proj/33333333-3333-3333-3333-333333333333.jsonl";
    const missing = "/Users/fixture/.claude/projects/-Users-fixture-proj/44444444-4444-4444-4444-444444444444.jsonl";
    const lines = [user("beacon short", "u1", 0), user("beacon " + "y".repeat(1_100_000), "u2", 60)];
    const gone = [user("beacon gone", "g1", 0)];
    const searched = query("beacon");
    const remote = new SearchFakeRemote(grepOutput([{ path: file, lines }, { path: missing, lines: gone }], searched), { files: { [file]: fileBytes(lines) } });
    const run = new SearchRun(searched, [target("p1", "claude", file), target("p2", "claude", missing)], remote);
    const final = await until(run, isFinal);
    expect([final.phase, final.longLines, final.unreadable]).toEqual(["done", 1, 1]);
    const p1 = final.results.matchesIn("p1");
    expect(p1.length).toBe(2);
    expect(p1.filter((match) => match.snippet === null).length).toBe(1);
    expect(p1.find((match) => match.snippet !== null)?.messageID).toBe("u1");
    expect(final.results.matchesIn("p2").length).toBe(0);
    run.cancel();
  });

  it("a read that does not answer in time is unreadable", async () => {
    const file = "/Users/fixture/.claude/projects/-Users-fixture-proj/55555555-5555-5555-5555-555555555555.jsonl";
    const lines = [user("beacon one", "u1", 0), user("beacon two", "u2", 60)];
    const searched = query("beacon");
    const remote = new SearchFakeRemote(grepOutput([{ path: file, lines }], searched), { files: { [file]: fileBytes(lines) }, readDelayMs: 5_000 });
    const run = new SearchRun(searched, [target("p1", "claude", file)], remote, 200);
    const started = Date.now();
    const final = await until(run, isFinal);
    expect([final.phase, final.unreadable]).toEqual(["done", 2]);
    expect(Date.now() - started).toBeLessThan(3_000);
    run.cancel();
  });

  it("cancel stops the reads and publishes nothing more; no read starts after it", async () => {
    const file = "/Users/fixture/.claude/projects/-Users-fixture-proj/66666666-6666-6666-6666-666666666666.jsonl";
    const lines = messages(6, 0, "beacon");
    const searched = query("beacon");
    const remote = new SearchFakeRemote(grepOutput([{ path: file, lines }], searched), { files: { [file]: fileBytes(lines) }, readDelayMs: 300 });
    const run = new SearchRun(searched, [target("p1", "claude", file)], remote);
    await until(run, (update) => update.phase === "reading");
    for (let i = 0; i < 100 && remote.readsInFlight < searchBounds.concurrentReads; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    const after: unknown[] = [];
    run.onUpdate((update) => after.push(update));
    after.length = 0;
    run.cancel();
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(after).toEqual([]);
    expect(remote.reads.length).toBe(searchBounds.concurrentReads);
  });
});

describe("lines that are no match never hide one", () => {
  it("fifteen tool results do not hide the one message", async () => {
    const searched = query("needle");
    const lines = [user("needle is the answer", "wanted", 0), ...Array.from({ length: 15 }, (_, index) => result(`tool-${index + 1}`, "needle", `r-${index + 1}`, index + 1))];
    const remote = new SearchFakeRemote(grepOutput([{ path: claudePath, lines }], searched), { files: { [claudePath]: fileBytes(lines) } });
    const run = new SearchRun(searched, [target("p", "claude", claudePath)], remote);
    const update = await until(run, isFinal);
    expect(update.results.panes.map((pane) => pane.paneID)).toEqual(["p"]);
    expect(update.results.matchesIn("p").map((match) => match.messageID)).toEqual(["wanted"]);
    expect(update.results.unread).toBe(0);
    expect(remote.reads.length).toBe(16);
    run.cancel();
  });

  it("N more counts only the matches read", async () => {
    const searched = query("needle");
    const lines = [user("needle old", "old", 0), result("tool", "needle", "r", 1), ...[2, 3, 4, 5, 6].map((n) => user(`needle ${n}`, `u-${n}`, n))];
    const remote = new SearchFakeRemote(grepOutput([{ path: claudePath, lines }], searched), { files: { [claudePath]: fileBytes(lines) } });
    const run = new SearchRun(searched, [target("p", "claude", claudePath)], remote);
    const update = await until(run, isFinal);
    const pane = update.results.panes[0]!;
    expect(pane.matches.map((match) => match.messageID)).toEqual([6, 5, 4, 3, 2].map((n) => `u-${n}`));
    expect(paneMore(pane)).toBe(0);
    expect(pane.unread).toBe(2);
    const expanded = new Promise<number[]>((resolve) => {
      run.onUpdate((next) => {
        if (next.expanding.size === 0 && next.results.unread === 0) resolve([next.results.panes[0]!.matches.length, paneMore(next.results.panes[0]!)]);
      });
    });
    run.expand("p");
    expect(await expanded).toEqual([6, 1]);
    run.cancel();
  });
});

describe("one input written both ways is one result", () => {
  async function searched(lines: readonly string[], word: string): Promise<readonly SearchMatch[]> {
    const q = query(word);
    const remote = new SearchFakeRemote(grepOutput([{ path: claudePath, lines }], q), { files: { [claudePath]: fileBytes(lines) } });
    const run = new SearchRun(q, [target("p", "claude", claudePath)], remote);
    const update = await until(run, isFinal);
    run.cancel();
    return update.results.matchesIn("p");
  }

  it("a queued message and its typed copy are one result with Chat's id", async () => {
    const lines = [queued("needle queued", "q1", "u9", 0), user("needle queued", "u9", 1)];
    expect(chatIDs(lines, "claude")).toEqual(new Set(["q1"]));
    const matches = await searched(lines, "needle");
    expect(matches.map((match) => match.messageID)).toEqual(["q1"]);
    expect(matches[0]!.lineOffset).toBe(0);
    const typedFirst = [user("needle typed", "u7", 0), queued("needle typed", "q7", "u7", 1)];
    expect(chatIDs(typedFirst, "claude")).toEqual(new Set(["u7"]));
    expect((await searched(typedFirst, "needle")).map((match) => match.messageID)).toEqual(["u7"]);
  });

  it("the same text within 120 seconds is one input", async () => {
    const near = [queued("needle again", "q3", null, 0), user("needle again", "u3", 90)];
    expect(chatIDs(near, "claude")).toEqual(new Set(["q3"]));
    expect((await searched(near, "needle")).map((match) => match.messageID)).toEqual(["q3"]);
    const far = [queued("needle again", "q4", null, 0), user("needle again", "u4", 300)];
    expect(chatIDs(far, "claude")).toEqual(new Set(["q4", "u4"]));
    expect(new Set((await searched(far, "needle")).map((match) => match.messageID))).toEqual(new Set(["q4", "u4"]));
  });

  it("two real yes messages stay two", async () => {
    const typed = [user("yes", "y1", 0), user("yes", "y2", 5)];
    expect(chatIDs(typed, "claude")).toEqual(new Set(["y1", "y2"]));
    expect(new Set((await searched(typed, "yes")).map((match) => match.messageID))).toEqual(new Set(["y1", "y2"]));
    const mixed = [user("yes", "y3", 0), queued("yes", "q5", "y5", 30)];
    expect(chatIDs(mixed, "claude")).toEqual(new Set(["y3", "q5"]));
    expect(new Set((await searched(mixed, "yes")).map((match) => match.messageID))).toEqual(new Set(["y3", "q5"]));
  });
});

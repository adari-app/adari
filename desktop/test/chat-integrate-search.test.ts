// Search skips OpenCode and Kilo panes as it does every other format it does not
// read (Pi, Copilot, Droid, Kimi, Maki, Grok, Cursor, the Gemini family, the store agents). Before, an OpenCode or
// Kilo folder session fell through to the Claude branch, so its folder was grepped as a Claude project folder and
// an id lookup was looked for among Claude's transcripts (search.ts SearchCommand.make).

import { describe, expect, it } from "vitest";

import { chatKinds } from "../src/shared/chat/kinds";
import { makeSessionRef, type TranscriptSessionRef } from "../src/shared/chat/locator";
import type { TranscriptFormat } from "../src/shared/chat/parser";
import { SearchCommand, SearchQuery } from "../src/shared/search/search";

const folder = "/Users/fixture/opencode-project";
const claudeFolder = "/Users/fixture/claude-project";
const openCodeID = "ses_0123456789abABCDEFGHIJKLMN";
const uuid = "0192f3a4-5b6c-7d8e-9f01-23456789abcd";
const query = SearchQuery.make("deploy")!;

const ref = (format: TranscriptFormat, lookup: Parameters<typeof makeSessionRef>[1]): TranscriptSessionRef => {
  const made = makeSessionRef(format, lookup);
  expect(made, `${format} ${lookup.kind}`).not.toBeNull();
  return made!;
};

describe("Search and OpenCode or Kilo panes", () => {
  it("skips an OpenCode or Kilo pane, by its folder or by Herdr's id: there is nothing to search", () => {
    const targets = [
      { paneID: "A", session: ref("opencode", { kind: "folder", folder }) },
      { paneID: "B", session: ref("opencode", { kind: "id", id: openCodeID }) },
      { paneID: "C", session: ref("kilo", { kind: "folder", folder }) },
      { paneID: "D", session: ref("kilo", { kind: "id", id: openCodeID }) },
    ];
    for (const target of targets) expect(SearchCommand.make(query, [target]), target.paneID).toBeNull();
    expect(SearchCommand.make(query, targets)).toBeNull();
  });

  it("never greps their folder as Claude's project folder beside a Claude pane", () => {
    const openCode = { paneID: "A", session: ref("opencode", { kind: "folder", folder }) };
    const kilo = { paneID: "B", session: ref("kilo", { kind: "folder", folder }) };
    const claude = { paneID: "C", session: ref("claude", { kind: "folder", folder: claudeFolder }) };
    const command = SearchCommand.make(query, [openCode, kilo, claude])!;
    expect([command.targets.map((target) => target.paneID), command.skipped.map((target) => target.paneID)]).toEqual([["C"], ["A", "B"]]);
    // Claude's project folder name for a folder is the path with "/" as "-"; the OpenCode folder's is never in the script.
    expect(command.command.text).toContain("-Users-fixture-claude-project");
    expect(command.command.text).not.toContain("opencode-project");
  });

  it("still searches Claude's and Codex's sessions, and only theirs, of every kind Chat reads", () => {
    const claude = { paneID: "C", session: ref("claude", { kind: "id", id: uuid }) };
    const codex = { paneID: "X", session: ref("codex", { kind: "id", id: uuid }) };
    const command = SearchCommand.make(query, [claude, codex])!;
    expect(command.targets.map((target) => target.paneID)).toEqual(["C", "X"]);
    // Every other format a reader kind maps to is skipped by its folder (OpenCode and Kilo now among them).
    const searchedFormats = new Set(["claude", "codex"]);
    const others = (["opencode", "kilo", "pi", "omp", "gemini", "qwen", "copilot", "droid", "kimi", "maki", "grok", "cursor", "cline"] as const).map(
      (format, index) => ({ paneID: `o${index}`, session: { format, lookup: { kind: "folder", folder } } as TranscriptSessionRef }),
    );
    for (const other of others) {
      expect(searchedFormats.has(other.session.format), other.session.format).toBe(false);
      expect(SearchCommand.make(query, [other]), other.session.format).toBeNull();
    }
    expect(chatKinds).toEqual(expect.arrayContaining(["opencode", "kilo"]));
  });
});

// An honest Chat for agents it can't read. kinds.ts lists the kinds Chat
// reads, one line each (each new reader adds its own); a pane of
// any other kind says so in one plain line in its Chat tab.

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { chatKinds, chatReads } from "../src/shared/chat/kinds";
import { chatUnreadLine } from "../src/shared/chat/unread";

describe("kinds.ts: the kinds Chat reads", () => {
  it("starts with Claude Code, Codex, Grok Build and Cursor Agent", () => {
    for (const kind of ["claude", "codex", "grok", "cursor"]) expect(chatKinds).toContain(kind);
    for (const kind of ["claude", "codex", "grok", "cursor", "CLAUDE"]) expect(chatReads(kind)).toBe(true);
    // Gemini is a Chat kind; amp stays unread.
    for (const kind of ["amp", "aider", "", "shell"]) expect(chatReads(kind)).toBe(false);
    expect(chatReads(null)).toBe(false);
    expect(chatReads(undefined)).toBe(false);
  });

  it("holds one kind per line, so each new reader adds its own line", () => {
    const source = readFileSync(new URL("../src/shared/chat/kinds.ts", import.meta.url), "utf8");
    const lines = source.split("\n").filter((line) => /^\s+"[a-z][a-z0-9_-]*",(\s*\/\/.*)?$/.test(line));
    expect(lines.map((line) => line.trim().replace(/,.*$/, "").replace(/"/g, ""))).toEqual([...chatKinds]);
  });
});

describe("the Chat line for a kind Chat doesn't read", () => {
  it("names the agent twice, in one plain line", () => {
    // Gemini CLI reads; Kiro CLI and Devin CLI (table names too) stay unread
    // (Kiro for 0.1.0, as Maki).
    expect(chatUnreadLine(true, "kiro")).toBe("Chat doesn't read Kiro CLI's sessions yet. Its own screen is on the Kiro CLI tab.");
    expect(chatUnreadLine(true, "devin")).toBe("Chat doesn't read Devin CLI's sessions yet. Its own screen is on the Devin CLI tab.");
    // GitHub Copilot and Hermes Agent read; Letta Code stays unread.
    expect(chatUnreadLine(true, "letta")).toBe("Chat doesn't read Letta Code's sessions yet. Its own screen is on the Letta Code tab.");
    expect(chatUnreadLine(true, "aider")).toBe("Chat doesn't read Aider's sessions yet. Its own screen is on the Aider tab.");
  });

  it("none for a kind Chat reads, a shell, or an agent with no kind", () => {
    for (const kind of ["claude", "codex", "grok", "cursor"]) expect(chatUnreadLine(true, kind)).toBeNull();
    expect(chatUnreadLine(false, "shell")).toBeNull();
    expect(chatUnreadLine(true, "")).toBeNull();
  });
});

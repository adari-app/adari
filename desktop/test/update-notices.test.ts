// Each agent CLI in the start-command table whose screen says it
// has an update is read (src/shared/update-mark.ts readAgentUpdate): Claude
// Code's "✔ Update installed · Restart to update" line; Codex's
// "Update available! A -> B" with one of its own following lines, as the
// published @openai/codex 0.167.0 binary carries them (its history cell
// codex-rs tui/src/history_cell, its startup prompt tui/src/update_prompt.rs).
// Grok Build and Cursor Agent print nothing a public source shows: never read.
// Each CLI's mark has its own words; Settings › Updates groups the marked
// agents by CLI.

import { describe, expect, it, vi } from "vitest";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  return { ...actual, ...fakeReact, default: { ...actual, ...fakeReact } };
});

import { demoCodexUpdateScreen } from "../src/main/demo/demo-hosts";
import { editableStartKinds } from "../src/shared/start-commands";
import { UpdateWatch, agentUpdateWords, readAgentUpdate, readCodexUpdateNotice, readUpdateLine, updateLineKinds, updateWordsFor } from "../src/shared/update-mark";
import { HookHost, elements } from "./support/fake-hooks";

const { UpdateMark, updateMarkLabel, updateMarkWords } = await import("../src/renderer/components/UpdateMark");

/** Codex's history cell as it draws it: a rounded border, each row padded to the cell's width. */
function cell(rows: readonly string[], width = 52): string {
  return [`╭${"─".repeat(width + 2)}╮`, ...rows.map((row) => `│ ${row}${" ".repeat(Math.max(0, width - [...row].length))} │`), `╰${"─".repeat(width + 2)}╯`].join("\n");
}

const first = "✨ Update available! 0.167.0 -> 0.168.0";

describe("Codex's update notice (readCodexUpdateNotice)", () => {
  it("matches its history cell: the first line, then Run <command> to update. (npm, bun, pnpm, brew)", () => {
    for (const command of ["npm install -g @openai/codex", "bun install -g @openai/codex", "pnpm add -g @openai/codex", "brew upgrade --cask codex"]) {
      expect(readCodexUpdateNotice(cell([first, `Run ${command} to update.`, "", "See full release notes:", "https://github.com/openai/codex/releases/latest"])), command).toBe(true);
    }
  });

  it("matches the cell's other forms: no install command known, no border, colour codes, no sparkle, a v before the versions", () => {
    expect(readCodexUpdateNotice(cell([first, "See https://github.com/openai/codex for installation options."]))).toBe(true);
    expect(readCodexUpdateNotice(`${first}\nRun npm install -g @openai/codex to update.`)).toBe(true);
    expect(readCodexUpdateNotice(`\u001b[1m\u001b[35m✨ Update available!\u001b[0m 0.167.0 -> \u001b[36m0.168.0-alpha.2\u001b[0m\n\u001b[2mSee full release notes:\u001b[0m`)).toBe(true);
    expect(readCodexUpdateNotice("Update available! v0.167.0 -> v0.168.0\nSee full release notes:")).toBe(true);
  });

  it("matches its startup prompt: Release notes and Update now (runs `<command>`)", () => {
    const prompt = ["  ✨ Update available! 0.167.0 -> 0.168.0", "", "  Release notes: https://github.com/openai/codex/releases/latest", "", "› 1. Update now (runs `npm install -g @openai/codex`)", "  2. Skip", "  3. Skip until next version"].join("\n");
    expect(readCodexUpdateNotice(prompt)).toBe(true);
  });

  it("matches the demo's build-box screen (its trendline pane), the capture's Codex mark", () => {
    expect(readCodexUpdateNotice(demoCodexUpdateScreen)).toBe(true);
  });

  it("does not match a quoted notice: in Codex’s reply (•), in the user's message (›), mid-line, or with words after it", () => {
    const follower = "Run npm install -g @openai/codex to update.";
    expect(readCodexUpdateNotice(`• Update available! 0.167.0 -> 0.168.0\n  ${follower}`)).toBeNull();
    expect(readCodexUpdateNotice(`› Update available! 0.167.0 -> 0.168.0\n${follower}`)).toBeNull();
    expect(readCodexUpdateNotice(`It said "Update available! 0.167.0 -> 0.168.0"\n${follower}`)).toBeNull();
    expect(readCodexUpdateNotice(`Update available! 0.167.0 -> 0.168.0 (from the log)\n${follower}`)).toBeNull();
  });

  it("does not match the first line alone, a follower more than five rows on, a follower alone, or no versions", () => {
    expect(readCodexUpdateNotice(cell([first]))).toBeNull();
    expect(readCodexUpdateNotice([first, "", "", "", "", "", "See full release notes:"].join("\n"))).toBeNull();
    expect(readCodexUpdateNotice("Run npm install -g @openai/codex to update.\nSee full release notes:")).toBeNull();
    expect(readCodexUpdateNotice("✨ Update available! soon\nSee full release notes:")).toBeNull();
    expect(readCodexUpdateNotice("✨ Update available! 0.167.0\nSee full release notes:")).toBeNull();
    expect(readCodexUpdateNotice("")).toBeNull();
  });

  it("says nothing either way once the notice scrolled away (null keeps the mark as it is, as Claude's dialog does)", () => {
    expect(readCodexUpdateNotice("• Done. The tests pass.\n\n› Ask Codex to do anything")).toBeNull();
  });
});

describe("which CLI's screen is read for what (readAgentUpdate)", () => {
  const claudeLine = ["⏺ Done.", "", "                                   ✔ Update installed · Restart to update", "─".repeat(60), "❯ ", "─".repeat(60)].join("\n");

  it("Claude Code: its own line (readUpdateLine)", () => {
    expect(readAgentUpdate("claude", claudeLine)).toBe(readUpdateLine(claudeLine));
    expect(readAgentUpdate("claude", claudeLine)).toBe(true);
    expect(readAgentUpdate("claude", demoCodexUpdateScreen)).not.toBe(true);
  });

  it("Codex: its notice, not Claude Code's line", () => {
    expect(readAgentUpdate("codex", demoCodexUpdateScreen)).toBe(true);
    expect(readAgentUpdate("Codex", demoCodexUpdateScreen)).toBe(true);
    expect(readAgentUpdate("codex", claudeLine)).toBeNull();
  });

  it("Grok Build, Cursor Agent and any other kind: nothing is read (null), whatever the screen says", () => {
    for (const kind of ["grok", "cursor", "gemini", "amp", "pi"]) {
      expect(readAgentUpdate(kind, claudeLine), kind).toBeNull();
      expect(readAgentUpdate(kind, demoCodexUpdateScreen), kind).toBeNull();
    }
  });

  it("the covered kinds are Claude Code and Codex; every kind of the start-command table is either covered or said not to be", () => {
    expect([...updateLineKinds].sort()).toEqual(["claude", "codex"]);
    expect(editableStartKinds.map((entry) => entry.kind).filter((kind) => !updateLineKinds.has(kind))).toEqual(["grok", "cursor"]);
  });

  it("the watch reads a Codex pane, marks it on its notice, and never reads Grok or Cursor panes", () => {
    const watch = new UpdateWatch();
    const pane = (id: string, kind: string) => ({ id, kind, identity: `s-${id}`, settled: true, exited: false });
    expect(watch.due([pane("c", "codex"), pane("g", "grok"), pane("cu", "cursor")], 0, true)).toEqual(["c"]);
    watch.observe("c", "s-c", watch.token("c") ?? -1, demoCodexUpdateScreen, 1);
    expect([...watch.marked()]).toEqual(["c"]);
    // The notice scrolled away (null): the mark stays for the session.
    watch.observe("c", "s-c", watch.token("c") ?? -1, "• Done.", 2);
    expect(watch.ready("c")).toBe(true);
  });
});

describe("each CLI's mark has its own words", () => {
  it("Claude Code: Update ready, installed, /exit then Resume", () => {
    expect(updateWordsFor("claude")).toEqual({ label: "Update ready", cli: "Claude Code", words: "Claude Code update installed. /exit when it’s idle, then Resume." });
    expect(updateMarkLabel).toBe("Update ready");
    expect(updateMarkWords).toBe("Claude Code update installed. /exit when it’s idle, then Resume.");
  });

  it("Codex: Update available, update it on the machine first, then /exit and Resume", () => {
    expect(updateWordsFor("codex").label).toBe("Update available");
    expect(updateWordsFor("codex").words).toBe("Codex has a newer version. Update it on the machine with the command Codex shows, then /exit when it’s idle and Resume.");
    // An unknown kind (an older main process said nothing of it): Claude Code's, the only mark before.
    expect(updateWordsFor(null)).toBe(agentUpdateWords["claude"]);
    expect(updateWordsFor("gemini")).toBe(agentUpdateWords["claude"]);
  });

  it("the sidebar's mark and the header's card say the pane's own CLI's words", () => {
    const words = (props: object) => {
      const view = new HookHost<object>(UpdateMark as (props: object) => unknown, props);
      view.render();
      const all = elements(view.tree);
      view.unmount();
      return { label: all[0]!.props["aria-label"] ?? all.find((element) => element.props["aria-label"] !== undefined)?.props["aria-label"], title: all.find((element) => element.props["title"] !== undefined)?.props["title"] };
    };
    expect(words({ kind: "codex" })).toEqual({ label: "Update available", title: agentUpdateWords["codex"]!.words });
    expect(words({ kind: "claude" })).toEqual({ label: "Update ready", title: updateMarkWords });
    expect(words({})).toEqual({ label: "Update ready", title: updateMarkWords });
    expect(words({ kind: "codex", card: true })).toEqual({ label: "Update available", title: agentUpdateWords["codex"]!.words });
  });

  it("no word of it uses an em dash", () => {
    for (const entry of Object.values(agentUpdateWords)) expect(`${entry.label} ${entry.cli} ${entry.words}`).not.toMatch(/\u2014/u);
  });
});

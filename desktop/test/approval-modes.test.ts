// Each agent's approval mode, read the way the agent shows
// it (src/shared/approval-modes.ts and agent-settings.ts), from the recorded
// screens (test/support/mode-fixtures.ts; the same screens and results as
// Tests/HerdrKitTests/ApprovalModeReadTests.swift): Claude Code's footer
// row, Codex's rollout turn_context and its /permissions list, Grok's
// border, Cursor's model row. No word that reads: no mode (the chip shows
// "Permissions").

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  codexNewAcknowledgement,
  approvalMode,
  approvalModes,
  claudeModeOfRow,
  codexHistoryMode,
  codexModeOfTurn,
  cursorModeCommand,
  menuModes,
  readClaudeModeScreen,
  readCodexScreen,
} from "../src/shared/approval-modes";
import { AgentSettingsReader, parseCursorFooter, readCursorScreen, readGrokScreen, screenMode } from "../src/shared/agent-settings";
import { modeScreen, modeScreens } from "./support/mode-fixtures";
import { repoRoot } from "./support/swift-fixtures";

const escaped = (text: string): string =>
  [...text]
    .map((c) => {
      if (c === "\\") return "\\\\";
      if (c === '"') return '\\"';
      if (c === "\n") return "\\n";
      const v = c.codePointAt(0)!;
      return v < 0x20 || v > 0x7e ? `\\u{${v.toString(16).toUpperCase()}}` : c;
    })
    .join("");

describe("the recorded screens", () => {
  it("are the same fixtures in HerdrKit's tests", () => {
    const swift = readFileSync(path.join(repoRoot, "Tests/HerdrKitTests/ModeFixtures.swift"), "utf8");
    expect(modeScreens.length).toBe(31);
    for (const each of modeScreens) {
      expect(swift.includes(`Screen(name: "${each.name}", what: "${escaped(each.what)}", screen: "${escaped(each.screen)}")`), each.name).toBe(true);
    }
  });
});

describe("the modes and their words", () => {
  it("each agent's own, in its order, T3 Code's icons and Supervised for a default with no word", () => {
    const words = (agent: keyof typeof approvalModes) => menuModes(agent).map((mode) => `${mode.label}/${mode.icon}`);
    expect(words("claude")).toEqual(["Manual/lock", "Accept edits/pen", "Plan/plan", "Auto/sparkles"]);
    expect(words("codex")).toEqual(["Ask for approval/lock", "Approve for me/sparkles", "Full Access/shieldOff", "Read Only/lock"]);
    expect(words("grok")).toEqual(["Supervised/lock", "Plan/plan", "Auto-review/sparkles", "Always-approve/shieldOff"]);
    expect(words("cursor")).toEqual(["Supervised/lock", "Auto-review/sparkles", "Run Everything/shieldOff"]);
  });

  it("Claude's bypass is a mode it shows, never one the menu offers", () => {
    expect(approvalMode("claude", "bypass")).toMatchObject({ label: "Bypass permissions", icon: "shieldOff", offered: false });
    expect(menuModes("claude").some((mode) => mode.id === "bypass")).toBe(false);
  });

  it("Codex's rows carry its own descriptions, Full Access its caution", () => {
    expect(approvalMode("codex", "full")?.description).toBe("Use with caution: Codex can edit files outside this workspace and access the internet without approval");
    expect(approvalMode("codex", "approve")?.description).toBe("Only ask for actions detected as potentially unsafe");
    expect(approvalModes.claude.every((mode) => mode.description.length > 0)).toBe(true);
  });
});

describe("Claude Code's footer", () => {
  const expected: Record<string, string> = {
    "claude-00-start": "auto",
    "claude-01-shift-tab": "manual",
    "claude-02-shift-tab": "acceptEdits",
    "claude-03-shift-tab": "plan",
    "claude-04-shift-tab": "auto",
    "claude-05-shift-tab": "manual",
    "claude-06-shift-tab": "acceptEdits",
  };
  for (const [name, mode] of Object.entries(expected)) {
    it(`${name}: ${mode}, the box empty (its suggestion)`, () => {
      expect(readClaudeModeScreen(modeScreen(name))).toEqual({ draft: "", empty: true, mode });
      expect(screenMode("claude", modeScreen(name))).toBe(mode);
    });
  }

  it("reads each row's words, cut or not; bypass; anything else is none", () => {
    expect(claudeModeOfRow("  \u{23F8} manual mode on")).toBe("manual");
    expect(claudeModeOfRow("  \u{23F5}\u{23F5} accept edits on (shift+tab to cycle)")).toBe("acceptEdits");
    expect(claudeModeOfRow("  \u{23F5}\u{23F5} accept edits on (shift+tab to\u{2026}")).toBe("acceptEdits");
    expect(claudeModeOfRow("  \u{23F5}\u{23F5} bypass permissions on (shift+tab to cycle)")).toBe("bypass");
    expect(claudeModeOfRow("  \u{23F5}\u{23F5} accept edi\u{2026}")).toBeNull();
    expect(claudeModeOfRow("  ? for shortcuts")).toBeNull();
    expect(claudeModeOfRow("  Opus 5.5 | ctx:- | aurora-web | v2.1.318")).toBeNull();
  });

  it("a background shell's suffix (` · 1 shell`) after ` on`, cut or not, reads; prose with \"mode on\" does not", () => {
    expect(claudeModeOfRow("  \u{23F5}\u{23F5} auto mode on \u{00B7} 1 shell")).toBe("auto");
    expect(claudeModeOfRow("  \u{23F5}\u{23F5} auto mode on \u{00B7} 2 shells")).toBe("auto");
    expect(claudeModeOfRow("  \u{23F8} manual mode on \u{00B7} 1 shell")).toBe("manual");
    expect(claudeModeOfRow("  \u{23F5}\u{23F5} accept edits on \u{00B7} 1 shell")).toBe("acceptEdits");
    expect(claudeModeOfRow("  \u{23F5}\u{23F5} plan mode on \u{00B7} 1 shell")).toBe("plan");
    expect(claudeModeOfRow("  \u{23F5}\u{23F5} auto mode on \u{00B7} 1 sh\u{2026}")).toBe("auto");
    expect(claudeModeOfRow("  \u{23F5}\u{23F5} auto mode on \u{00B7}\u{2026}")).toBe("auto");
    expect(claudeModeOfRow("  \u{23F5}\u{23F5} auto mode on \u{2026}")).toBe("auto");
    // The existing shapes, unchanged.
    expect(claudeModeOfRow("  \u{23F5}\u{23F5} auto mode on")).toBe("auto");
    expect(claudeModeOfRow("  \u{23F5}\u{23F5} auto mode on (shift+tab to cycle)")).toBe("auto");
    expect(claudeModeOfRow("  \u{23F5}\u{23F5} auto mode on\u{2026}")).toBe("auto");
    expect(claudeModeOfRow("  \u{23F5}\u{23F5} auto mode on    Context left until auto-compact: 12%")).toBe("auto");
    // Prose that merely contains "mode on" stays none.
    expect(claudeModeOfRow("  \u{23F5}\u{23F5} auto mode on, then the shell")).toBeNull();
    expect(claudeModeOfRow("  \u{23F5}\u{23F5} auto mode only \u{00B7} 1 shell")).toBeNull();
    expect(claudeModeOfRow("  \u{23F5}\u{23F5} auto mode on\u{00B7}1 shell")).toBeNull();
    expect(claudeModeOfRow("  turned auto mode on \u{00B7} 1 shell")).toBeNull();
    expect(claudeModeOfRow("  \u{23F5}\u{23F5} the auto mode on \u{00B7} 1 shell")).toBeNull();
  });

  it("a full screen with a working spinner, the auto-compact line over the box and ` · 1 shell` reads auto", () => {
    const rule = "\u{2500}".repeat(80);
    const screen = [
      "\u{23FA} Monitor started.",
      "",
      "\u{273B} Pondering\u{2026} (12s \u{00B7} \u{2193} 1.2k tokens \u{00B7} esc to interrupt)",
      "",
      "                                                       36% until auto-compact",
      rule,
      "\u{276F}\u{00A0}",
      rule,
      "  Opus 5.5 | 36% ctx | herdr-companion | Adari Mac app build 0.1.0 | v2.1.318",
      "  \u{23F5}\u{23F5} auto mode on \u{00B7} 1 shell",
      "",
    ].join("\n");
    expect(readClaudeModeScreen(screen)).toEqual({ draft: "", empty: true, mode: "auto" });
    expect(screenMode("claude", screen)).toBe("auto");
  });

  it("no mode row, or no box at the bottom: no mode", () => {
    const start = modeScreen("claude-00-start");
    const rowless = start.replace("  \u{23F5}\u{23F5} auto mode on (shift+tab to cycle)", "  ? for shortcuts");
    expect(readClaudeModeScreen(rowless)).toEqual({ draft: "", empty: true, mode: null });
    expect(readClaudeModeScreen("just a shell\n% ")).toBeNull();
    expect(screenMode("claude", "just a shell\n% ")).toBeNull();
  });

  it("the user's draft in the box is not empty", () => {
    const drafted = modeScreen("claude-01-shift-tab").replace('Try "how does dispatch-test work?"', "fix the shed door");
    expect(readClaudeModeScreen(drafted)).toEqual({ draft: "fix the shed door", empty: false, mode: "manual" });
  });
});

describe("Codex's mode", () => {
  const turn = (payload: Record<string, unknown>) => JSON.stringify({ timestamp: "2026-11-06T00:46:00.000Z", type: "turn_context", payload: { cwd: "/Users/demo/x", model: "gpt-6.1-sol", effort: "xhigh", ...payload } });
  const workspace = { type: "workspace-write", writable_roots: [], network_access: false, exclude_tmpdir_env_var: false, exclude_slash_tmp: false };

  it("a turn_context by Codex's presets (status_surfaces.rs, tests_permissions.rs)", () => {
    expect(codexModeOfTurn({ approval_policy: "on-request", approvals_reviewer: "user", sandbox_policy: workspace })).toBe("ask");
    expect(codexModeOfTurn({ approval_policy: "on-request", approvals_reviewer: "auto_review", sandbox_policy: workspace })).toBe("approve");
    expect(codexModeOfTurn({ approval_policy: "never", approvals_reviewer: "user", sandbox_policy: { type: "danger-full-access" } })).toBe("full");
    expect(codexModeOfTurn({ approval_policy: "on-request", approvals_reviewer: "user", sandbox_policy: { type: "read-only" } })).toBe("readOnly");
    expect(codexModeOfTurn({ approval_policy: "on-request", sandbox_policy: workspace })).toBe("ask");
  });

  it("no preset, or nothing to tell: none (nothing guessed)", () => {
    expect(codexModeOfTurn({ approval_policy: "never", sandbox_policy: workspace })).toBeNull();
    expect(codexModeOfTurn({ approval_policy: "on-request", sandbox_policy: { type: "danger-full-access" } })).toBeNull();
    expect(codexModeOfTurn({ approval_policy: "untrusted", sandbox_policy: workspace })).toBeNull();
    expect(codexModeOfTurn({ approval_policy: "on-request" })).toBeNull();
    expect(codexModeOfTurn({ approval_policy: "on-request", approvals_reviewer: "someone", sandbox_policy: workspace })).toBeNull();
    expect(codexModeOfTurn({})).toBeNull();
  });

  it("the reader takes the newest turn_context's; a fresh session before its first turn has none", () => {
    const reader = new AgentSettingsReader("codex");
    expect(reader.settings.mode ?? null).toBeNull();
    reader.line(turn({ approval_policy: "on-request", approvals_reviewer: "auto_review", sandbox_policy: workspace }), 100);
    expect(reader.settings).toMatchObject({ mode: "approve", modeAt: 100, model: "gpt-6.1-sol", effort: "xhigh" });
    reader.line(turn({ approval_policy: "on-request", approvals_reviewer: "user", sandbox_policy: workspace }), 400);
    expect(reader.settings).toMatchObject({ mode: "ask", modeAt: 400 });
    // An older line read later (Load earlier) never replaces it.
    reader.line(turn({ approval_policy: "never", sandbox_policy: { type: "danger-full-access" } }), 50);
    expect(reader.settings).toMatchObject({ mode: "ask", modeAt: 400 });
    // A newer one with no preset says so.
    reader.line(turn({ approval_policy: "untrusted", sandbox_policy: workspace }), 900);
    expect(reader.settings).toMatchObject({ mode: null, modeAt: 900 });
  });

  it("a Claude transcript has no mode in its lines (its footer has it)", () => {
    const reader = new AgentSettingsReader("claude");
    reader.line(JSON.stringify({ type: "assistant", effort: "xhigh", message: { model: "claude-opus-5-5" } }), 0);
    expect(reader.settings.mode ?? null).toBeNull();
  });

  it("its screens: the box, the /permissions list and its (current), the Full Access confirmation", () => {
    expect(readCodexScreen(modeScreen("codex-00-start"))).toEqual({ kind: "box", draft: "", empty: true, last: null });
    const list = readCodexScreen(modeScreen("codex-01-permissions"));
    expect(list).toEqual({
      kind: "permissions",
      rows: [
        { digit: 1, label: "Ask for approval", mode: "ask", current: false, cursor: false },
        { digit: 2, label: "Approve for me", mode: "approve", current: true, cursor: true },
        { digit: 3, label: "Full Access", mode: "full", current: false, cursor: false },
        { digit: 4, label: "Read Only", mode: "readOnly", current: false, cursor: false },
      ],
    });
    const after = readCodexScreen(modeScreen("codex-03-permissions-after-1"));
    expect(after.kind === "permissions" && after.rows.filter((row) => row.current).map((row) => row.mode)).toEqual(["ask"]);
    expect(readCodexScreen(modeScreen("codex-04-full-access-confirm"))).toEqual({ kind: "fullAccess" });
    const cancelled = readCodexScreen(modeScreen("codex-05-full-access-cancel"));
    expect(cancelled.kind === "permissions" && cancelled.rows.find((row) => row.current)?.mode).toBe("ask");
    const restored = readCodexScreen(modeScreen("codex-08-restored"));
    expect(restored.kind === "permissions" && restored.rows.find((row) => row.current)?.mode).toBe("approve");
  });

  it("after a pick the newest history row above the box names the mode Codex set", () => {
    const picked = readCodexScreen(modeScreen("codex-02-digit-1"));
    expect(picked).toEqual({ kind: "box", draft: "", empty: true, last: "\u{2022} Permission selection requested: Ask for approval" });
    expect(codexHistoryMode(picked.kind === "box" ? picked.last : null)).toBe("ask");
    expect(codexHistoryMode("\u{2022} Permissions updated to Full Access")).toBe("full");
    expect(codexHistoryMode("\u{2022} Permissions updated to Full Access.")).toBe("full");
    // A later turn's row is not one.
    const turned = readCodexScreen(modeScreen("codex-06-turn"));
    expect(turned.kind === "box" && codexHistoryMode(turned.last)).toBeNull();
  });

  it("the user's draft is not empty", () => {
    const drafted = modeScreen("codex-00-start").replace("\u{203A} Ask Codex to do anything", "\u{203A} fix the shed door");
    expect(readCodexScreen(drafted)).toEqual({ kind: "box", draft: "fix the shed door", empty: false, last: null });
  });

  describe("only the recorded shapes: the four rows, the whole confirmation", () => {
    const list = modeScreen("codex-01-permissions");
    const confirm = modeScreen("codex-04-full-access-confirm");
    const indent = " ".repeat(25);

    it("the four rows wrapped at another width read the same", () => {
      const narrow = [
        "  Update Model Permissions",
        "",
        "",
        "  1. Ask for approval          Read and edit workspace files and run",
        "                               commands, with approval required for",
        "                               internet access or edits outside the",
        "                               workspace",
        "\u{203A} 2. Approve for me (current)  Only ask for actions detected as",
        "                               potentially unsafe",
        "  3. Full Access               Use with caution: Codex can edit files",
        "                               outside this workspace and access the",
        "                               internet without approval",
        "  4. Read Only                 Read workspace files, with approval",
        "                               required for edits or internet access",
        "",
        "  enter select \u{B7} esc back",
      ].join("\n");
      expect(readCodexScreen(narrow)).toEqual(readCodexScreen(list));
    });

    it("anything else in the list reads as other (refused before any digit)", () => {
      const variants: Record<string, string> = {
        "no (current)": list.replace(" (current)", "  "),
        "two (current)": list.replace("1. Ask for approval          Read", "1. Ask for approval (current)  Read"),
        "a label changed": list.replace("4. Read Only     ", "4. Read Mostly   "),
        "a description changed": list.replace("Only ask for actions detected as potentially unsafe", "Only ask for actions it deems unsafe"),
        "a wrapped rest changed": list.replace("without approval", "without asking"),
        "rows out of order": list.replace("  3. Full Access", "  5. Full Access"),
        "a fifth row": list.replace("\n\n  enter select", "\n  5. Danger Zone               Everything, always\n\n  enter select"),
        "no arrow": list.replace("\u{203A} 2.", "  2."),
        "a row with no description": list.replace("  4. Read Only                 Read workspace files, with approval required for edits or internet access", "  4. Read Only"),
        "a line at the margin between rows": list.replace("  3. Full Access", "stray\n  3. Full Access"),
        "a row after a blank line": list.replace("  4. Read Only", "\n  4. Read Only"),
      };
      for (const [name, raw] of Object.entries(variants)) {
        expect(raw, name).not.toBe(list);
        expect(readCodexScreen(raw).kind, name).toBe("other");
      }
    });

    it("the confirmation rewrapped narrower is still it", () => {
      const rewrapped = confirm
        .replace(
          `${indent}When Codex runs with full access, it can edit any file on your\n${indent}computer and run commands with network, without your approval.`,
          `${indent}When Codex runs with full access, it can edit\n${indent}any file on your computer and run commands with\n${indent}network, without your approval.`,
        );
      expect(rewrapped).not.toBe(confirm);
      expect(readCodexScreen(rewrapped)).toEqual({ kind: "fullAccess" });
    });

    it("any other confirmation is not it: a third option, other words, the arrow on Cancel, the box over it, more under its hint", () => {
      const variants: Record<string, string> = {
        "a third option": confirm.replace("  enter select \u{B7} esc back", "  3. Changed confirmation semantics\n  enter select \u{B7} esc back"),
        "other words": confirm.replace("significantly", "slightly"),
        "the arrow on Cancel": confirm.replace("\u{203A} 1. Yes", "  1. Yes").replace("  2. Cancel", "\u{203A} 2. Cancel"),
        "the box drawn over it": confirm.replace(`${indent}When Codex`, `\u{203A} As${" ".repeat(20)}When Codex`),
        "more under its hint": confirm.replace(`${indent}enter select \u{B7} esc back\n`, `${indent}enter select \u{B7} esc back\n  and one more line\n`),
      };
      for (const [name, raw] of Object.entries(variants)) {
        expect(raw, name).not.toBe(confirm);
        expect(readCodexScreen(raw).kind, name).not.toBe("fullAccess");
      }
    });
  });

  it("a narrow two-row list (codex-src's test snapshot) reads as other", () => {
    const narrow = [
      "  Update Model Permissions",
      "",
      "",
      "\u{203A} 1. Ask for approval  Read and edit workspace files and run commands, with",
      "                       approval required for internet access or edits outside",
      "                       the workspace",
      "  2. Full Access       Use with caution: Codex can edit files outside this",
      "                       workspace and access the internet without approval",
      "",
      "  enter select \u{B7} esc back",
    ].join("\n");
    expect(readCodexScreen(narrow)).toEqual({ kind: "other" });
  });

  describe("the box is its whole input region, the box row through every row above its footer", () => {
    const start = modeScreen("codex-00-start");
    const boxed = (...rows: string[]): string => start.replace("\u{203A} Ask Codex to do anything", rows.join("\n"));
    const lines = start.split("\n");
    const boxAt = lines.findIndex((line) => line.startsWith("\u{203A} "));
    const above = lines.slice(0, boxAt);

    it("a blank first line with the user's draft going on under it is not empty", () => {
      expect(readCodexScreen(boxed("\u{203A} ", "  a continued user draft"))).toEqual({ kind: "box", draft: "\na continued user draft", empty: false, last: null });
    });

    it("a multiline draft reads whole", () => {
      expect(readCodexScreen(boxed("\u{203A} fix the shed door", "  and the gate", "  then the fence"))).toEqual({
        kind: "box",
        draft: "fix the shed door\nand the gate\nthen the fence",
        empty: false,
        last: null,
      });
    });

    it("the cursor on the first line (empty), a blank row, then the user's text: not empty", () => {
      const read = readCodexScreen(boxed("\u{203A} ", "", "  the rest of the draft"));
      expect(read).toEqual({ kind: "box", draft: "\n\nthe rest of the draft", empty: false, last: null });
    });

    it("the user's first line reading like the placeholder, their draft going on under it: not empty", () => {
      const read = readCodexScreen(boxed("\u{203A} Ask Codex to do anything", "  and then fix the gate"));
      expect(read.kind === "box" && read.empty).toBe(false);
    });

    it("a bare box row with no placeholder is not empty", () => {
      expect(readCodexScreen(boxed("\u{203A} "))).toEqual({ kind: "box", draft: "", empty: false, last: null });
    });

    it("an extent that is not certain reads as other: no footer, a footer with no blank above it, a line at the margin in the region", () => {
      expect(readCodexScreen([...above, "\u{203A} Ask Codex to do anything", ""].join("\n")).kind).toBe("other");
      expect(readCodexScreen(start.replace("Ask Codex to do anything\n\n", "Ask Codex to do anything\n")).kind).toBe("other");
      expect(readCodexScreen(boxed("\u{203A} fix the shed door", "and this at the margin")).kind).toBe("other");
      expect(readCodexScreen(boxed("\u{203A} fix the shed door", "  ", "  model \u{B7} looks like a footer", "")).kind).toBe("box");
    });

    it("the pick's read-back: exactly /permissions over a slash popup whose first row is it (unrecorded), else other", () => {
      const popup = ["  /permissions  choose what Codex is allowed to do", "  /personality  choose a communication style"];
      expect(readCodexScreen([...above, "\u{203A} /permissions", "", ...popup].join("\n"))).toEqual({ kind: "box", draft: "/permissions", empty: false, last: null });
      expect(readCodexScreen([...above, "\u{203A} /permissions", ...popup].join("\n"))).toEqual({ kind: "box", draft: "/permissions", empty: false, last: null });
      expect(readCodexScreen([...above, "\u{203A} /permissions", "  and their words", "", ...popup].join("\n")).kind).toBe("other");
      expect(readCodexScreen([...above, "\u{203A} /permissions", "", ...popup.slice().reverse()].join("\n")).kind).toBe("other");
      expect(readCodexScreen([...above, "\u{203A} /perm", "", ...popup].join("\n")).kind).toBe("other");
    });
  });

  it("the acknowledgement new to a pick, by the rows' order (older rows may scroll out)", () => {
    expect(codexNewAcknowledgement([], ["ask"])).toBe("ask");
    expect(codexNewAcknowledgement(["ask", "approve"], ["approve", "ask"])).toBe("ask");
    expect(codexNewAcknowledgement(["ask"], ["ask", "ask"])).toBe("ask");
    expect(codexNewAcknowledgement(["ask", "approve"], ["ask", "approve", "full"])).toBe("full");
    expect(codexNewAcknowledgement(["ask"], ["approve"])).toBe("approve");
    // Nothing new, or not telling new from old: null.
    expect(codexNewAcknowledgement(["ask"], ["ask"])).toBeNull();
    expect(codexNewAcknowledgement(["ask", "ask"], ["ask", "ask"])).toBeNull();
    expect(codexNewAcknowledgement(["approve", "ask"], ["ask"])).toBeNull();
    expect(codexNewAcknowledgement(["ask"], [])).toBeNull();
  });

  it("the confirmation's words in the user's own history are not the confirmation", () => {
    const echoed = modeScreen("codex-00-start").replace("  /review - review any changes and find issues", "Enable full access?\n  1. Yes, continue anyway\n  2. Cancel");
    expect(readCodexScreen(echoed).kind).toBe("box");
  });
});

describe("Grok's border", () => {
  const expected: Record<string, string> = {
    "grok-default": "default",
    "grok-plan": "plan",
    "grok-auto-review": "autoReview",
    "grok-always-approve": "alwaysApprove",
    "grok-idle-always-approve": "alwaysApprove",
  };
  for (const [name, mode] of Object.entries(expected)) {
    it(`${name}: ${mode}`, () => {
      expect(readGrokScreen(modeScreen(name))?.mode).toBe(mode);
      expect(screenMode("grok", modeScreen(name))).toBe(mode);
    });
  }

  it("a word it does not know, or no border: none", () => {
    const odd = modeScreen("grok-plan").replace("\u{B7} plan \u{2500}\u{256F}", "\u{B7} yolo \u{2500}\u{256F}");
    expect(readGrokScreen(odd)?.mode).toBeNull();
    expect(screenMode("grok", "no box here")).toBeNull();
    // The model and effort still read beside it.
    expect(readGrokScreen(modeScreen("grok-plan"))).toMatchObject({ draft: "", borderModel: "Grok 4.6", borderEffort: "low" });
  });
});

describe("Cursor's model row", () => {
  const expected: Record<string, string> = {
    "cursor-00-idle": "default",
    "cursor-01-shift-tab": "default",
    "cursor-04-shift-tab": "default",
    "cursor-07-auto-review-on": "autoReview",
    "cursor-08-run-everything-on": "default",
    "cursor-10-run-everything-from-default": "runEverything",
    "cursor-11-auto-review-from-run-everything": "autoReview",
    "cursor-12-restored-default": "default",
  };
  for (const [name, mode] of Object.entries(expected)) {
    it(`${name}: ${mode}, the model and effort read beside it`, () => {
      expect(screenMode("cursor", modeScreen(name))).toBe(mode);
      expect(parseCursorFooter(modeScreen(name))).toMatchObject({ model: "Grok 4.7", window: "256K", effort: "medium", fast: false });
      expect(readCursorScreen(modeScreen(name))).toMatchObject({ kind: "box", empty: true, working: false });
    });
  }

  it("the `/` list is no box (no mode read from it); an unknown word on the right reads as none", () => {
    expect(screenMode("cursor", modeScreen("cursor-06-slash"))).toBeNull();
    const odd = modeScreen("cursor-07-auto-review-on").replace(/ {10}Auto-review$/mu, "          Something Else");
    expect(screenMode("cursor", odd)).toBeNull();
    expect(parseCursorFooter(odd)).toMatchObject({ model: "Grok 4.7", effort: "medium" });
  });

  it("the command toward each target from each start (one setting, three ways)", () => {
    expect(cursorModeCommand("default", "autoReview")).toBe("/auto-review");
    expect(cursorModeCommand("default", "runEverything")).toBe("/run-everything");
    expect(cursorModeCommand("autoReview", "default")).toBe("/auto-review");
    expect(cursorModeCommand("runEverything", "default")).toBe("/run-everything");
    expect(cursorModeCommand("autoReview", "runEverything")).toBe("/run-everything");
    expect(cursorModeCommand("runEverything", "autoReview")).toBe("/auto-review");
    expect(cursorModeCommand("autoReview", "autoReview")).toBeNull();
  });
});

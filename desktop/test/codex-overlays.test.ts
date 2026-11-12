// Every approval_overlay snapshot in Codex 0.166.0's source
// (tui/src/bottom_pane/approval_overlay.rs tests) through the matcher, on a
// Codex pane and on none (the same reading).
//
// additional_permissions_prompt, patch_destination_unavailable,
// permissions_prompt and network_exec_prompt match as Codex's menu;
// approval_header_wrapped_url is the header alone (no options: nothing to
// answer, unmatched); cross_thread_prompt matches too: the same numbered list
// and keys (its list's digit shortcuts, the same view as every overlay here),
// only its footer goes on: "Press enter to confirm or esc to cancel or o to open
// thread". Its footer is read the same way as Codex's own. Same expected
// results as
// Tests/HerdrCompanionTests/CompanionCodexFormTests.swift (CompanionCodexOverlayTests).

import { describe, expect, it } from "vitest";

import { codexForm, matchPrompt, readingMatch, type PromptMatch } from "../src/shared/prompt/matcher";
import { CO } from "./support/prompt-fixtures";

const pane = "w1:p1";

function menu(text: string): PromptMatch {
  const reading = matchPrompt(text, pane, "codex");
  const match = readingMatch(reading);
  if (match === null) throw new Error(`not matched: ${JSON.stringify(reading)}`);
  return match;
}

const rows = (match: PromptMatch) => match.options.map((option) => [option.key, option.label, option.keys, option.isReturnDefault, option.isSessionWide, option.opensComposer]);

describe("Codex 0.166.0's approval overlays", () => {
  it("each reads the same on a Codex pane as on none, and none is Codex's tool-call form", () => {
    for (const text of Object.values(CO)) {
      expect(matchPrompt(text, pane, "codex")).toEqual(matchPrompt(text, pane));
      expect(codexForm(text, pane)).toBeNull();
    }
  });

  it("additional_permissions_prompt: Codex's command menu", () => {
    const match = menu(CO.additionalPermissions);
    expect(match.kind).toBe("menu");
    expect(match.question).toBe("Would you like to run the following command?");
    expect(match.context).toEqual({ type: "command", text: "cat /tmp/readme.txt" });
    expect(rows(match)).toEqual([
      ["1", "Yes, proceed", ["1"], true, false, false],
      ["2", "No, and tell Codex what to do differently", ["2"], false, false, true],
    ]);
  });

  it("patch_destination_unavailable: the edits menu", () => {
    const match = menu(CO.patchDestinationUnavailable);
    expect(match.kind).toBe("menu");
    expect(match.question).toBe("Would you like to make the following edits?");
    expect(rows(match)).toEqual([
      ["1", "Yes, proceed", ["1"], true, false, false],
      ["2", "Yes, and don't ask again for these files", ["2"], false, true, false],
      ["3", "No, and tell Codex what to do differently", ["3"], false, false, true],
    ]);
  });

  it("permissions_prompt: the permissions menu", () => {
    const match = menu(CO.permissions);
    expect(match.kind).toBe("menu");
    expect(match.question).toBe("Would you like to grant these permissions?");
    expect(rows(match)).toEqual([
      ["1", "Yes, grant these permissions for this turn", ["1"], true, false, false],
      ["2", "Yes, grant for this turn with strict auto review", ["2"], false, false, false],
      ["3", "Yes, grant these permissions for this session", ["3"], false, true, false],
      ["4", "No, continue without permissions", ["4"], false, false, false],
    ]);
  });

  it("network_exec_prompt: the network menu", () => {
    const match = menu(CO.networkExec);
    expect(match.kind).toBe("menu");
    expect(match.question).toBe('Do you want to approve network access to "example.com"?');
    expect(rows(match)).toEqual([
      ["1", "Yes, just this once", ["1"], true, false, false],
      ["2", "Yes, and allow this host for this conversation", ["2"], false, false, false],
      ["3", "Yes, and allow this host in the future", ["3"], false, false, false],
      ["4", "No, and tell Codex what to do differently", ["4"], false, false, true],
    ]);
  });

  it("approval_header_wrapped_url: the header alone, no options: unmatched", () => {
    expect(matchPrompt(CO.headerWrappedUrl, pane, "codex")).toEqual({
      type: "unmatched",
      lines: ["Reason:", "https://github.com/openai/codex/", "pull/12345?diff=split", "$ echo hi"],
    });
  });

  it("cross_thread_prompt: the same command menu, its footer naming o to open thread", () => {
    const match = menu(CO.crossThread);
    expect(match.kind).toBe("menu");
    expect(match.question).toBe("Would you like to run the following command?");
    expect(match.context).toEqual({ type: "command", text: "echo hi" });
    expect(rows(match)).toEqual([
      ["1", "Yes, proceed", ["1"], true, false, false],
      ["2", "No, and tell Codex what to do differently", ["2"], false, false, true],
    ]);
    // The key that opens the other thread is never one the card sends.
    expect(match.options.flatMap((option) => option.keys)).not.toContain("o");
  });
});

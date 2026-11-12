// Cursor's catalog as the families its own `/model` list shows (src/shared/model-choices.ts cursorFamilies;
// cursor-02: "Auto", "Grok 4.7", "Claude Opus 5.5", … "1-10 of 46"), worked out of the captured catalog's labels
// (cursor-agent 2026.11.05's list of models: 276 models), and which of them are never typed because their name is
// inside another's (cursor-08: `/model Claude Opus 5` gives "Claude Opus 5.5 300K Medium").

import { describe, expect, it } from "vitest";

import { parseCursorModels } from "../src/shared/model-catalog";
import { cursorFamilies, cursorFamilyInside, cursorFamilyName, cursorFamilyOf, modelPickCommand, sameCursorFamily } from "../src/shared/model-choices";
import { cursorModelLineOf, readCursorScreen } from "../src/shared/agent-settings";
import { frame } from "./support/livepick-frames";

const catalog = (() => {
  const parsed = parseCursorModels(frame("cursor-list-models-2026.11.05"));
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.models;
})();

/** The families as worked out of the 2026.11.05 catalog, in its order. */
const expectedFamilies = [
  "Auto",
  "Codex 5.3",
  "GPT-5.2",
  "Composer 2.5",
  "Claude Opus 5",
  "GPT-5.6 Sol",
  "Claude Fable 5",
  "Grok 4.5",
  "Claude Sonnet 5",
  "GPT-5.6 Luna",
  "Grok 4.7",
  "Grok 4.6",
  "Claude Opus 5.5",
  "Claude Opus 4.8",
  "Gemini 4 Carbon",
  "Gemini 4 Argon",
  "Muse Wonder",
  "GPT-5.5",
  "Claude Fable 5.2",
  "Claude Fable 5.1",
  "Gemini 3.8 Flash",
  "Muse Spark 1.3",
  "GPT-5.6 Terra",
  "Claude Sonnet 5.5",
  "Claude Sonnet 4.6",
  "Claude Opus 4.7",
  "GPT-5.4",
  "Claude Opus 4.6",
  "Claude Opus 4.5",
  "Gemini 3.1 Pro",
  "GPT-5.4 Mini",
  "GPT-5.4 Nano",
  "Claude Haiku 5.5",
  "Claude Sonnet 4.5",
  "GPT-5.1",
  "Gemini 3 Flash",
  "Gemini 3.5 Flash",
  "Claude Sonnet 4",
  "GPT-5 Mini",
  "Kimi K3",
  "Kimi K2.7 Code",
  "GLM 5.2",
  "DeepSeek V4.1 Flash 1017",
];

describe("Cursor's families from its captured catalog", () => {
  it("276 models, 43 families, each named as Cursor's list names it; every id in exactly one", () => {
    expect(catalog).toHaveLength(276);
    const families = cursorFamilies(catalog);
    expect(families.map((family) => family.name)).toEqual(expectedFamilies);
    expect(families).toHaveLength(43);
    const ids = families.flatMap((family) => family.ids);
    expect(ids).toHaveLength(276);
    expect(new Set(ids).size).toBe(276);
    // The ten rows cursor-02 shows (Cursor Agent 2026.11.11) are all among them.
    for (const name of ["Auto", "Grok 4.7", "Grok 4.6", "Composer 2.5", "Claude Opus 5.5", "Claude Opus 5", "Claude Opus 4.8", "Gemini 4 Carbon", "Gemini 4 Argon", "Muse Wonder"]) {
      expect(families.some((family) => family.name === name)).toBe(true);
    }
  });

  it("the words after a family's name come off: levels, Fast, Thinking and No Thinking, 1M, (NO ZDR)", () => {
    expect(cursorFamilyName("Claude Opus 5 1M Low Thinking Fast")).toBe("Claude Opus 5");
    expect(cursorFamilyName("Claude Haiku 5.5  Low No Thinking")).toBe("Claude Haiku 5.5");
    expect(cursorFamilyName("Claude Fable 5.2 1M Extra High Fast (NO ZDR)")).toBe("Claude Fable 5.2");
    expect(cursorFamilyName("Grok 4.7  Low Fast\u{200B}\u{200B}")).toBe("Grok 4.7");
    expect(cursorFamilyName("GPT-5.5 None Fast")).toBe("GPT-5.5");
    // Footer lines too (cursor-02, -06, -08, -11).
    expect(cursorFamilyName("Composer 2.5 Fast")).toBe("Composer 2.5");
    expect(cursorFamilyName("Claude Opus 5.5 300K Medium")).toBe("Claude Opus 5.5");
    expect(cursorFamilyName("Grok 4.7 256K High Fast")).toBe("Grok 4.7");
    expect(cursorFamilyName("Auto")).toBe("Auto");
    expect(sameCursorFamily("Composer 2.5 Fast", "Composer 2.5")).toBe(true);
    expect(sameCursorFamily("Claude Opus 5.5 300K Medium", "Claude Opus 5")).toBe(false);
  });

  it("a family whose words are inside another's is never typed (its row opens Cursor's own list)", () => {
    const families = cursorFamilies(catalog);
    const terminal = families.filter((family) => family.terminalOnly !== null).map((family) => family.name);
    // "GPT-5 Mini" too: its words sit inside "GPT-5.4 Mini" (the rule is wider than a plain substring on purpose).
    expect(terminal).toEqual(["Claude Opus 5", "Claude Fable 5", "Claude Sonnet 5", "GPT-5.4", "Gemini 3 Flash", "Claude Sonnet 4", "GPT-5 Mini"]);
    expect(families.find((family) => family.name === "Claude Opus 5")!.terminalOnly).toBe("Opens Cursor's own list in the Terminal: typed, \u{201C}Claude Opus 5\u{201D} would pick Claude Opus 5.5.");
    expect(cursorFamilyInside("Claude Opus 5", "Claude Opus 5.5")).toBe(true);
    expect(cursorFamilyInside("Gemini 3 Flash", "Gemini 3.8 Flash")).toBe(true);
    expect(cursorFamilyInside("Claude Opus 5.5", "Claude Opus 5")).toBe(false);
    expect(cursorFamilyInside("Auto", "Auto")).toBe(false);
  });

  it("main's command: /model <family> for a plain family; refused for one inside another's or not in the list", () => {
    expect(modelPickCommand({ agent: "cursor", model: "composer-2.5-fast", effort: null }, catalog)).toEqual({ ok: true, command: "/model Composer 2.5" });
    expect(modelPickCommand({ agent: "cursor", model: "auto", effort: null }, catalog)).toEqual({ ok: true, command: "/model Auto" });
    expect(modelPickCommand({ agent: "cursor", model: "claude-haiku-5-5-thinking-max", effort: null }, catalog)).toEqual({ ok: true, command: "/model Claude Haiku 5.5" });
    expect(modelPickCommand({ agent: "cursor", model: "claude-opus-5-high", effort: null }, catalog)).toEqual({
      ok: false,
      reason: "Claude Opus 5 is chosen in Cursor's own list (its name is inside another family's).",
    });
    expect(modelPickCommand({ agent: "cursor", model: "claude-opus-9", effort: null }, catalog).ok).toBe(false);
    expect(modelPickCommand({ agent: "cursor", model: "composer-2.5", effort: "high" }, catalog).ok).toBe(false);
    expect(cursorFamilyOf(catalog, "grok-4.7-xhigh-fast")!.name).toBe("Grok 4.7");
  });

  it("the model line under Cursor's box, read or not as a footer (cursor-05, -06, -08, -11); none while its list is open", () => {
    expect(cursorModelLineOf(frame("cursor-05-after-esc"))).toBe("Auto");
    expect(cursorModelLineOf(frame("cursor-06-model-words-enter"))).toBe("Composer 2.5 Fast");
    expect(cursorModelLineOf(frame("cursor-08-two-matches"))).toBe("Claude Opus 5.5 300K Medium");
    expect(cursorModelLineOf(frame("cursor-11-restore-auto"))).toBe("Auto");
    expect(cursorModelLineOf(frame("cursor-02-list-open"))).toBeNull();
    expect(readCursorScreen(frame("cursor-05-after-esc"))).toMatchObject({ kind: "box", empty: true });
  });
});

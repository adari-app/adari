// Each agent's own model list read into one shape (src/shared/model-catalog.ts),
// on cut-down copies of what the CLIs printed (src/main/demo/demo-model-lists.ts)
// and on small hand-made outputs: the
// counts, the default, hidden ones left out, Codex's levels and defaults,
// Claude Code's models only (its account, commands and agents never kept),
// Cursor's invisible characters cleaned, a cut or foreign output refused
// without a throw, an output past the size bound refused; and which command
// lists each agent's models.

import { describe, expect, it } from "vitest";

import { demoModelLists } from "../src/main/demo/demo-model-lists";
import {
  antigravityNoList,
  builtInCatalog,
  catalogErrorLine,
  claudeFallback,
  claudeFallbackLine,
  claudeInitializeLine,
  claudeListArgs,
  cleanLabel,
  isCatalogView,
  isModelId,
  listCommand,
  maxCatalogBytes,
  parseCatalog,
  type CatalogAgent,
  type CatalogModel,
} from "../src/shared/model-catalog";

function models(agent: CatalogAgent, text: string): readonly CatalogModel[] {
  const parsed = parseCatalog(agent, text);
  if (!parsed.ok) throw new Error(`refused: ${parsed.reason}`);
  return parsed.models;
}

const refusal = (agent: CatalogAgent, text: string): string => {
  const parsed = parseCatalog(agent, text);
  if (parsed.ok) throw new Error("read");
  return parsed.reason;
};

describe("Claude Code's answer to the initialize request", () => {
  const listed = models("claude", demoModelLists.claude);

  it("lists its 14 models in its order: `default` first, then the aliases, then older full names", () => {
    expect(listed).toHaveLength(14);
    expect(listed.map((model) => model.id).slice(0, 6)).toEqual(["default", "opus", "fable", "sonnet", "haiku", "claude-fable-5-1"]);
  });

  it("`default` is Claude Code's default: \"Default\", the model it names now beside it", () => {
    expect(listed[0]).toEqual({
      id: "default",
      label: "Default",
      group: null,
      efforts: ["low", "medium", "high", "xhigh", "max"],
      defaultEffort: null,
      isDefault: true,
      note: "Fable 5.2",
      resolves: "claude-fable-5-2",
    });
    expect(listed.filter((model) => model.isDefault)).toHaveLength(1);
  });

  it("an alias carries its display name and the full model it names now", () => {
    expect(listed.find((model) => model.id === "opus")).toMatchObject({ label: "Opus 5.5", resolves: "claude-opus-5-5", note: "For complex work and everyday tasks" });
    expect(listed.find((model) => model.id === "haiku")).toMatchObject({ label: "Haiku 5.5", resolves: "claude-haiku-5-5" });
  });

  it("a model with no effort (Haiku 4.5) has no levels; one without xhigh (Opus 4.6, Sonnet 4.6) has four", () => {
    expect(listed.find((model) => model.id === "claude-haiku-4-5-20251001")!.efforts).toEqual([]);
    expect(listed.find((model) => model.id === "claude-opus-4-6")!.efforts).toEqual(["low", "medium", "high", "max"]);
    expect(listed.find((model) => model.id === "claude-sonnet-4-6")!.efforts).toEqual(["low", "medium", "high", "max"]);
  });

  it("keeps only the models: the account, its commands and agents are never read into the catalog", () => {
    // The demo answer carries made-up ones, as the real one carries real ones.
    expect(demoModelLists.claude).toContain("someone@example.invalid");
    const text = JSON.stringify(listed);
    for (const word of ["example.invalid", "Example Org", "account", "organization", "subscriptionType", "general-purpose", "review", "commands", "agents", "output_style"]) {
      expect(text).not.toContain(word);
    }
    for (const model of listed) {
      expect(Object.keys(model).every((key) => ["id", "label", "group", "efforts", "defaultEffort", "isDefault", "note", "resolves"].includes(key))).toBe(true);
    }
  });

  it("reads the answer among other stream lines, and refuses an error, a cut answer or none, without a throw", () => {
    const line = demoModelLists.claude.trim();
    expect(models("claude", `{"type":"system","subtype":"hook"}\nnot json\n${line}\n`)).toHaveLength(14);
    expect(refusal("claude", '{"type":"control_response","response":{"subtype":"error","error":"no"}}')).toBe("it answered the initialize request with an error");
    expect(refusal("claude", line.slice(0, 900))).toBe("it gave no answer to the initialize request (cut off, or not Claude Code)");
    expect(refusal("claude", "")).toBe("it gave no answer to the initialize request (cut off, or not Claude Code)");
    expect(refusal("claude", '{"type":"control_response","response":{"subtype":"success","response":{"models":"x"}}}')).toBe("its answer has no models");
    // A value that is not a model name of Claude Code's shape is left out.
    const odd = JSON.stringify({ type: "control_response", response: { response: { models: [{ value: "opus; touch ~/x", displayName: "x" }, { value: "sonnet", displayName: "Sonnet" }] } } });
    expect(models("claude", odd).map((model) => model.id)).toEqual(["sonnet"]);
  });

  it("the fallback when it cannot be read: the four aliases with the five levels, no default level claimed", () => {
    expect(claudeFallback.map((model) => [model.id, model.label, model.efforts.length, model.defaultEffort])).toEqual([
      ["fable", "Fable", 5, null],
      ["opus", "Opus", 5, null],
      ["sonnet", "Sonnet", 5, null],
      ["haiku", "Haiku", 5, null],
    ]);
    expect(claudeFallbackLine("claude was not found on this Mac")).toBe("Could not read Claude Code's models: claude was not found on this Mac. Showing its four aliases.");
  });
});

describe("Codex's `codex debug models`", () => {
  const listed = models("codex", demoModelLists.codex);

  it("lists the 9 models it shows (of 11), by its priority; the hidden ones are left out", () => {
    expect(listed.map((model) => model.id)).toEqual([
      "gpt-6.1-sol",
      "gpt-6-astra",
      "gpt-6.1-terra",
      "gpt-6-sol",
      "gpt-6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-daybreak-blue-latest",
    ]);
    expect(listed.some((model) => model.id === "gpt-reserve" || model.id === "codex-auto-review")).toBe(false);
  });

  it("each model has its own levels and default", () => {
    expect(listed[0]).toMatchObject({ label: "GPT-6.1-Sol", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"], defaultEffort: "low", isDefault: false });
    expect(listed.find((model) => model.id === "gpt-6-luna")).toMatchObject({ efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "medium" });
    expect(listed.find((model) => model.id === "gpt-6-sol")!.defaultEffort).toBe("medium");
  });

  it("reads only the keys it needs, and refuses a cut or foreign output without a throw", () => {
    const one = JSON.stringify([{ slug: "m-1", display_name: "M\u{200B}1", base_instructions: "x".repeat(50_000), supported_reasoning_levels: ["low", { effort: "high" }, { effort: "WEIRD" }], default_reasoning_level: "max" }]);
    expect(models("codex", one)).toEqual([{ id: "m-1", label: "M1", group: null, efforts: ["low", "high"], defaultEffort: null, isDefault: false }]);
    expect(refusal("codex", demoModelLists.codex.slice(0, 2_000))).toBe("its list is not JSON (cut off, or not Codex's)");
    expect(refusal("codex", "Error: not logged in")).toBe("its list is not JSON (cut off, or not Codex's)");
    expect(refusal("codex", '{"models": 3}')).toBe("its list has no models");
    expect(refusal("codex", '{"models": [{"slug": "a b"}]}')).toBe("its list named no model");
  });
});

describe("Grok's `grok models`", () => {
  it("lists its models, the starred one its default", () => {
    const listed = models("grok", demoModelLists.grok);
    expect(listed.map((model) => [model.id, model.label, model.isDefault])).toEqual([
      ["grok-4.7", "Grok 4.7", false],
      ["grok-4.7-build-fast", "Grok 4.7 Build Fast", false],
      ["grok-4.6", "Grok 4.6", true],
      ["grok-4.5", "Grok 4.5", false],
    ]);
  });

  it("refuses an output with no list", () => {
    expect(refusal("grok", "error: not signed in\n")).toBe("its list has no “Available models”");
  });
});

describe("Cursor's `cursor-agent --list-models`", () => {
  const listed = models("cursor", demoModelLists.cursor);

  it("lists its rows, Auto its default, the Tip line not a model", () => {
    expect(listed).toHaveLength(143);
    expect(listed[0]).toMatchObject({ id: "auto", label: "Auto", isDefault: true });
    expect(listed.filter((model) => model.isDefault)).toHaveLength(1);
    expect(listed.some((model) => model.id.startsWith("Tip"))).toBe(false);
  });

  it("cleans the zero-width spaces after Fast and the double spaces in its labels", () => {
    expect(demoModelLists.cursor).toContain("Grok 4.7  Low Fast\u{200B}\u{200B}");
    expect(listed.find((model) => model.id === "grok-4.7-low-fast")!.label).toBe("Grok 4.7 Low Fast");
    expect(listed.every((model) => !/\u{200B}|\u{200C}|\u{200D}|\u{FEFF}| {2}/u.test(model.label))).toBe(true);
    expect(cleanLabel("A\u{0007}B\u{2028} C")).toBe("AB C");
  });

  it("groups a row by its family when the label makes it plain", () => {
    expect(listed.find((model) => model.id === "grok-4.7-medium")!.group).toBe("Grok");
    expect(listed.find((model) => model.id === "gpt-5.3-codex")!.group).toBe("Codex");
    expect(listed.find((model) => model.id === "auto")!.group).toBeNull();
  });

  it("refuses an output with no row", () => {
    expect(refusal("cursor", "Error: You are not logged in\n")).toBe("its list named no model");
  });
});

describe("OpenCode's `opencode models`", () => {
  it("lists provider/model rows grouped by provider, OpenRouter's ~ names kept", () => {
    const listed = models("opencode", demoModelLists.opencode);
    expect(listed).toHaveLength(48);
    expect(new Set(listed.map((model) => model.group))).toEqual(new Set(["opencode", "openrouter"]));
    expect(listed.find((model) => model.id === "openrouter/~anthropic/claude-fable-latest")).toMatchObject({
      id: "openrouter/~anthropic/claude-fable-latest",
      label: "Anthropic: Claude Fable Latest",
      group: "openrouter",
      variants: ["low", "medium", "high"],
    });
    expect(listed.filter((model) => model.group === "opencode")).toHaveLength(12);
  });

  it("the demo's `--verbose` objects: only id, name, provider and variant names are kept", () => {
    expect(demoModelLists.opencode).toContain("demo-key-not-kept");
    const listed = models("opencode", demoModelLists.opencode);
    expect(JSON.stringify(listed)).not.toMatch(/not-kept|example\.invalid|reasoningEffort|cost/);
    expect(listed.find((model) => model.id === "opencode/beam-free")).toMatchObject({ id: "opencode/beam-free", label: "Beam Free", group: "opencode", variants: ["low", "medium", "high", "xhigh", "max"] });
    expect(listed.find((model) => model.id === "opencode/big-pickle")!.variants).toEqual([]);
  });
});

describe("the bounds", () => {
  it("an output past the size bound is refused, never read", () => {
    const big = "a".repeat(maxCatalogBytes + 1);
    for (const agent of ["claude", "codex", "grok", "cursor", "opencode"] as const) expect(refusal(agent, big)).toBe("its list is larger than 4 MB");
  });

  it("at most 2000 models from one list, each id once", () => {
    const text = Array.from({ length: 2_500 }, (_, index) => `opencode/m-${index % 2_400}`).join("\n");
    expect(models("opencode", text)).toHaveLength(2_000);
    expect(models("grok", "Available models:\n  - grok-1\n  - grok-1\n")).toHaveLength(1);
  });

  it("each agent's ids are of its own strict shape", () => {
    expect(isModelId("claude", "opus[1m]")).toBe(true);
    expect(isModelId("claude", "claude-haiku-4-5-20251001")).toBe(true);
    expect(isModelId("claude", "opus --dangerously")).toBe(false);
    expect(isModelId("codex", "gpt-6.1-sol")).toBe(true);
    expect(isModelId("codex", "-c")).toBe(false);
    expect(isModelId("cursor", "claude-opus-4-8[context=1m]")).toBe(false);
    expect(isModelId("opencode", "openrouter/~anthropic/claude-fable-latest")).toBe(true);
    expect(isModelId("opencode", "nope")).toBe(false);
    expect(isModelId("opencode", "a/b;c")).toBe(false);
    expect(isModelId("agy", "anything")).toBe(false);
  });
});

describe("the command that lists each agent's models", () => {
  it("is the machine's own binary for the agent, never a wrapper (`cl`), argv only", () => {
    expect(listCommand("codex", null)).toEqual({ program: "codex", args: ["debug", "models"], stdin: null, timeoutMs: 20_000 });
    expect(listCommand("codex", "/opt/homebrew/bin/codex --yolo")).toMatchObject({ program: "/opt/homebrew/bin/codex", args: ["debug", "models"] });
    expect(listCommand("codex", "cx")).toMatchObject({ program: "codex" });
    expect(listCommand("codex", "CODEX_HOME=~/x ~/.local/bin/codex")).toMatchObject({ program: "~/.local/bin/codex" });
    expect(listCommand("codex", "../../codex")).toMatchObject({ program: "codex" });
    expect(listCommand("codex", "codex;rm")).toMatchObject({ program: "codex" });
    expect(listCommand("grok", null)).toMatchObject({ program: "grok", args: ["models"] });
    expect(listCommand("opencode", null)).toMatchObject({ program: "opencode", args: ["models", "--verbose"] });
    expect(listCommand("cursor", null)).toMatchObject({ program: "cursor", args: ["agent", "--list-models"] });
    expect(listCommand("cursor", "cursor agent")).toMatchObject({ program: "cursor", args: ["agent", "--list-models"] });
    expect(listCommand("cursor", "~/.local/bin/cursor-agent")).toMatchObject({ program: "~/.local/bin/cursor-agent", args: ["--list-models"] });
    // `cursor` alone is the editor's launcher: the stock command instead.
    expect(listCommand("cursor", "cursor")).toMatchObject({ program: "cursor", args: ["agent", "--list-models"] });
  });

  it("Claude Code: `claude` with the initialize request on stdin, 15 s; a wrapper such as `cl` is never run", () => {
    const stock = { program: "claude", args: claudeListArgs, stdin: claudeInitializeLine, timeoutMs: 15_000 };
    expect(listCommand("claude", null)).toEqual(stock);
    expect(listCommand("claude", "cl")).toEqual(stock);
    expect(listCommand("claude", "claude --dangerously-skip-permissions")).toEqual(stock);
    expect(listCommand("claude", "/usr/local/bin/claude")).toEqual({ ...stock, program: "/usr/local/bin/claude" });
    expect(claudeListArgs).toEqual(["-p", "--no-session-persistence", "--setting-sources", "", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"]);
    expect(JSON.parse(claudeInitializeLine)).toEqual({ type: "control_request", request_id: "adari-models", request: { subtype: "initialize" } });
  });

  it("Antigravity CLI: none (its picker says so)", () => {
    expect(listCommand("agy", "agy")).toBeNull();
    expect(builtInCatalog("agy")).toEqual({ agent: "agy", models: [], readAt: null, error: null, loading: false, none: antigravityNoList });
    expect(antigravityNoList).toBe("Antigravity CLI's models are in its own picker.");
  });

  it("the failure line names the agent and the reason", () => {
    expect(catalogErrorLine("cursor", "it ended with exit 1.")).toBe("Could not read Cursor's models: it ended with exit 1.");
  });

  it("a view main sends is checked by the page", () => {
    expect(isCatalogView(builtInCatalog("codex"))).toBe(true);
    expect(isCatalogView({ ...builtInCatalog("codex"), models: [{ id: 1 }] })).toBe(false);
    expect(isCatalogView({ ...builtInCatalog("codex"), agent: "gemini" })).toBe(false);
  });
});

// OpenCode's list read with `--verbose` (only the id, the display name, the
// provider id and the variant names kept; never `api`, `headers`, `options` or `cost`), its screen read off the
// captured frames, and the pick main drives through its own list (src/main/herdr/opencode-pick.ts) against a
// fake OpenCode built from those frames: one row, two rows told apart by provider, two that cannot be, the variant
// step and none, the list never opening, a wait running out, the agent working. Every failing case writes Esc last
// and leaves the prompt clear.

import { describe, expect, it } from "vitest";

import { parseCatalog, parseOpenCodeModels, maxOpenCodeObjectBytes } from "../src/shared/model-catalog";
import { catalogCacheText, parseCatalogCache } from "../src/main/model-catalogs";
import { footerNames, readOpenCodeScreen, sameProvider } from "../src/shared/opencode-screen";
import { driveOpenCodePick, openCodePickTexts, pickOpenCodeBound, type OpenCodeTarget } from "../src/main/herdr/opencode-pick";
import { FakeOpenCode, frame, frameModels } from "./support/livepick-frames";

const verboseSample = frame("opencode-models-verbose-first3");

/** One `--verbose` entry as OpenCode prints it (an id line, then its object pretty-printed). */
const entry = (id: string, object: Record<string, unknown>): string => `${id}\n${JSON.stringify(object, null, 2)}\n`;

describe("OpenCode's list with --verbose: four fields only", () => {
  it("the sample (opencode-models-verbose-first3): ids, display names, provider ids, variant names", () => {
    const parsed = parseOpenCodeModels(verboseSample);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.models).toEqual([
      { id: "opencode/beam-free", label: "Beam Free", group: "opencode", efforts: [], defaultEffort: null, isDefault: false, variants: ["low", "medium", "high", "xhigh", "max"] },
      { id: "opencode/big-pickle", label: "Big Pickle", group: "opencode", efforts: [], defaultEffort: null, isDefault: false, variants: [] },
      { id: "opencode/deepseek-v4.1-flash-free", label: "DeepSeek V4.1 Flash Free", group: "opencode", efforts: [], defaultEffort: null, isDefault: false, variants: ["low", "high", "max"] },
    ]);
    // Nothing of api, headers, options, cost, limit or capabilities rides along.
    const text = JSON.stringify(parsed.models);
    for (const word of ["inference", "npm", "cost", "capabilities", "reasoning_content", "1048576", "release_date"]) expect(text).not.toContain(word);
    expect(parseCatalog("opencode", verboseSample)).toEqual(parsed);
  });

  it("hostile rows: control characters and markup in a name, a huge object, a missing name, options holding a key", () => {
    const text = [
      entry("opencode/evil", { id: "evil", providerID: "opencode", name: "Evil\u0007\u001b[31m Name​ <b>bold</b>", variants: { low: {}, "bad key!": {} } }),
      entry("opencode/huge", { id: "huge", providerID: "opencode", name: "Huge", options: { pad: "x".repeat(maxOpenCodeObjectBytes + 10) } }),
      entry("openrouter/anthropic/nameless", { id: "anthropic/nameless", providerID: "openrouter", variants: {} }),
      entry("acme/keyed", { id: "keyed", providerID: "acme", name: "Keyed", options: { apiKey: "sk-live-SECRET-123" }, headers: { Authorization: "Bearer SECRET-456" }, api: { url: "https://acme.example/v1" }, cost: { input: 9 } }),
      entry("opencode/badprovider", { id: "badprovider", providerID: "x y\nz", name: "Bad Provider", variants: "not an object" }),
    ].join("");
    const parsed = parseOpenCodeModels(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.models.map((model) => Object.keys(model).sort())).toEqual(Array(5).fill(["defaultEffort", "efforts", "group", "id", "isDefault", "label", "variants"]));
    const [evil, huge, nameless, keyed, badProvider] = parsed.models;
    // Control and invisible characters out; markup stays text (the page draws it as text).
    expect(evil).toMatchObject({ id: "opencode/evil", label: "Evil[31m Name <b>bold</b>", variants: ["low"] });
    // Too large to read: its id alone, no name (no live pick types one), the next one read.
    expect(huge).toMatchObject({ id: "opencode/huge", label: "huge", group: "opencode", variants: [] });
    expect(nameless).toMatchObject({ id: "openrouter/anthropic/nameless", label: "anthropic/nameless", group: "openrouter", variants: [] });
    expect(keyed).toMatchObject({ id: "acme/keyed", label: "Keyed", group: "acme", variants: [] });
    expect(badProvider).toMatchObject({ label: "Bad Provider", group: "opencode", variants: [] });
    const out = JSON.stringify(parsed.models);
    for (const secret of ["SECRET", "sk-live", "Bearer", "acme.example", "xxxxxxxx"]) expect(out).not.toContain(secret);
  });

  it("the plain list still reads (an older OpenCode): no variants field; an old cache of it is read again", () => {
    const parsed = parseOpenCodeModels("opencode/beam-free\nopenrouter/~anthropic/claude-opus-latest\n");
    expect(parsed.ok && parsed.models).toEqual([
      { id: "opencode/beam-free", label: "beam-free", group: "opencode", efforts: [], defaultEffort: null, isDefault: false },
      { id: "openrouter/~anthropic/claude-opus-latest", label: "~anthropic/claude-opus-latest", group: "openrouter", efforts: [], defaultEffort: null, isDefault: false },
    ]);
    const fresh = parseOpenCodeModels(verboseSample);
    if (!parsed.ok || !fresh.ok) throw new Error("parse");
    const text = catalogCacheText([
      { host: "mini", agent: "opencode", readAt: 1, models: parsed.models },
      { host: "box", agent: "opencode", readAt: 2, models: fresh.models },
    ]);
    // The cache holds the same four fields; the old one (no names) is not taken back.
    expect(parseCatalogCache(text)).toEqual([{ host: "box", agent: "opencode", readAt: 2, models: fresh.models }]);
  });
});

describe("OpenCode's screens (the frames)", () => {
  it("its box, its model list with a search, its variant list", () => {
    expect(readOpenCodeScreen(frame("opencode-10-after-variant"))).toEqual({ kind: "prompt", draft: "", empty: true, footer: "Beam Free OpenCode" });
    expect(readOpenCodeScreen(frame("opencode-01-typed-models"))).toEqual({ kind: "prompt", draft: "/models", empty: false, footer: "GLM-5.3-Flash Free OpenCode" });
    expect(readOpenCodeScreen(frame("opencode-02-list-open"))).toEqual({ kind: "models", search: null, rows: null });
    expect(readOpenCodeScreen(frame("opencode-05-filter-beam"))).toEqual({
      kind: "models",
      search: "beam",
      rows: [
        { name: "Beam Free", provider: "OpenCode" },
        { name: "Beam 1.0 501B A23B", provider: "OpenRouter" },
      ],
    });
    expect(readOpenCodeScreen(frame("opencode-07-filter-beam-free"))).toEqual({ kind: "models", search: "Beam Free", rows: [{ name: "Beam Free", provider: "OpenCode" }] });
    expect(readOpenCodeScreen(frame("opencode-09-variant-list"))).toEqual({ kind: "variants", search: null, rows: ["Default", "low", "medium"] });
    expect(readOpenCodeScreen("")).toEqual({ kind: "other" });
  });

  it("a provider by letters and digits, case ignored; the footer names the model", () => {
    expect(sameProvider("opencode", "OpenCode")).toBe(true);
    expect(sameProvider("open-router", "OpenRouter")).toBe(true);
    expect(sameProvider("opencode", "OpenRouter")).toBe(false);
    expect(footerNames("Beam Free OpenCode", "Beam Free", "opencode")).toBe(true);
    expect(footerNames("Beam Free OpenCode", "Beam", "opencode")).toBe(false);
    expect(footerNames("GLM-5.3-Flash Free OpenCode", "Beam Free", "opencode")).toBe(false);
  });
});

const beamFree: OpenCodeTarget = { id: "opencode/beam-free", name: "Beam Free", provider: "opencode" };
const glm: OpenCodeTarget = { id: "opencode/glm-5.3-flash-free", name: "GLM-5.3-Flash Free", provider: "opencode" };

/**
 * The driver over a fake OpenCode; `check` may stop it (its answer before each write); `owned` is a cleanup key's
 * check (the pane, agent and run only; absent: `check`); `read` may stand in for the fake's screen (a read failing).
 */
async function drive(
  target: OpenCodeTarget,
  fake: FakeOpenCode,
  check: () => string | null = () => null,
  options: { readonly owned?: () => string | null; readonly read?: () => Promise<string> } = {},
) {
  const done = await driveOpenCodePick(
    {
      read: options.read ?? (async () => fake.screen()),
      type: async (text) => fake.type(text),
      keys: async (keys) => fake.keys(keys),
      check,
      ...(options.owned === undefined ? {} : { owned: options.owned }),
      wait: async () => undefined,
    },
    target,
  );
  return done.result;
}

/** A failing case: the keys end with Esc and the prompt is clear. */
function backedOut(fake: FakeOpenCode): void {
  expect(fake.keyLog().at(-1)).toBe("Escape");
  expect(readOpenCodeScreen(fake.screen())).toMatchObject({ kind: "prompt", empty: true });
}

describe("the pick through OpenCode's own list", () => {
  it("one row, then its variants: Return on Default; the footer reads it", async () => {
    const fake = new FakeOpenCode(frameModels, "GLM-5.3-Flash Free OpenCode");
    expect(await drive(beamFree, fake)).toEqual({ type: "set", model: "opencode/beam-free", label: "Beam Free" });
    expect(fake.keyLog()).toEqual(["type:/models", "Enter", "type:Beam Free", "Enter", "Enter"]);
    expect(fake.footer).toBe("Beam Free OpenCode");
  });

  it("no variant step: the prompt at once (as OpenCode 1.18.21 went back to it)", async () => {
    const fake = new FakeOpenCode(frameModels, "Beam Free OpenCode");
    expect(await drive(glm, fake)).toEqual({ type: "set", model: glm.id, label: glm.name });
    expect(fake.keyLog()).toEqual(["type:/models", "Enter", "type:GLM-5.3-Flash Free", "Enter"]);
  });

  it("two rows of the same name told apart by provider: Down to the model's own, then Return", async () => {
    const models = [
      { name: "Claude Opus 5.5", provider: "OpenRouter", variants: [] },
      { name: "Claude Opus 5.5", provider: "Anthropic", variants: ["high"] },
      ...frameModels,
    ];
    const fake = new FakeOpenCode(models, "Beam Free OpenCode");
    const target = { id: "anthropic/claude-opus-5-5", name: "Claude Opus 5.5", provider: "anthropic" };
    expect(await drive(target, fake)).toEqual({ type: "set", model: target.id, label: target.name });
    expect(fake.keyLog()).toEqual(["type:/models", "Enter", "type:Claude Opus 5.5", "Down", "Enter", "Enter"]);
    expect(fake.footer).toBe("Claude Opus 5.5 Anthropic");
  });

  it("the beam search's two rows (opencode-05): only the exact name, so Beam 1.0 501B A23B under OpenRouter is the second row", async () => {
    const fake = new FakeOpenCode(frameModels, "Beam Free OpenCode");
    const target = { id: "openrouter/acme/beam-1.0", name: "Beam 1.0 501B A23B", provider: "openrouter" };
    expect(await drive(target, fake)).toEqual({ type: "set", model: target.id, label: target.name });
    expect(fake.keyLog()).toEqual(["type:/models", "Enter", "type:Beam 1.0 501B A23B", "Enter"]);
  });

  it("the same name under two providers that cannot be told apart: Esc, nothing picked", async () => {
    const models = [
      { name: "Claude Opus 5.5", provider: "Open Router", variants: [] },
      { name: "Claude Opus 5.5", provider: "OpenRouter", variants: [] },
    ];
    const fake = new FakeOpenCode(models, "Beam Free OpenCode");
    const result = await drive({ id: "openrouter/anthropic/claude-opus-5.5", name: "Claude Opus 5.5", provider: "openrouter" }, fake);
    expect(result).toEqual({ type: "refused", note: `${openCodePickTexts.several("Claude Opus 5.5")}, ${openCodePickTexts.closed}` });
    expect(fake.footer).toBe("Beam Free OpenCode");
    expect(fake.keyLog()).not.toContain("Down");
    backedOut(fake);
  });

  it("no row of its name and provider: Esc, nothing picked", async () => {
    const fake = new FakeOpenCode(frameModels, "Beam Free OpenCode");
    const result = await drive({ id: "openrouter/x/beam-free", name: "Beam Free", provider: "openrouter" }, fake);
    expect(result).toEqual({ type: "refused", note: `${openCodePickTexts.noRow("Beam Free")}, ${openCodePickTexts.closed}` });
    backedOut(fake);
  });

  it("the list never opening: Esc, the prompt clear", async () => {
    const fake = new FakeOpenCode(frameModels, "Beam Free OpenCode", { listNeverOpens: true });
    const result = await drive(glm, fake);
    expect(result).toEqual({ type: "refused", note: `${openCodePickTexts.noList}, ${openCodePickTexts.closed}` });
    expect(fake.keyLog()).toEqual(["type:/models", "Enter", "Escape"]);
    backedOut(fake);
  });

  it("a wait running out (the search never shows what was typed): Esc, the prompt clear", async () => {
    const fake = new FakeOpenCode(frameModels, "Beam Free OpenCode", { searchNeverShows: true });
    const result = await drive(glm, fake);
    expect(result).toEqual({ type: "refused", note: `${openCodePickTexts.noSearch}, ${openCodePickTexts.closed}` });
    expect(fake.keyLog()).toEqual(["type:/models", "Enter", "type:GLM-5.3-Flash Free", "Escape"]);
    backedOut(fake);
  });

  it("the footer naming something else after the pick: said, and Esc last", async () => {
    const fake = new FakeOpenCode(frameModels, "Beam Free OpenCode", { footerAfter: "Big Pickle OpenCode" });
    const result = await drive(glm, fake);
    expect(result).toEqual({ type: "refused", note: `${openCodePickTexts.notShown("Big Pickle OpenCode")}, ${openCodePickTexts.closed}` });
    backedOut(fake);
  });

  it("the user's draft in the box, or a list already open: nothing written", async () => {
    const drafted = new FakeOpenCode(frameModels, "Beam Free OpenCode", { draft: "fix the tests" });
    expect(await drive(glm, drafted)).toEqual({ type: "refused", note: openCodePickTexts.draft });
    expect(drafted.writes).toEqual([]);
    const open = new FakeOpenCode(frameModels, "Beam Free OpenCode");
    open.view = { kind: "models", search: "", highlight: 0 };
    expect(await drive(glm, open)).toEqual({ type: "refused", note: openCodePickTexts.noBox });
    expect(open.writes).toEqual([]);
  });

  it("already on it: set, nothing written", async () => {
    const fake = new FakeOpenCode(frameModels, "GLM-5.3-Flash Free OpenCode");
    expect(await drive(glm, fake)).toEqual({ type: "set", model: glm.id, label: glm.name });
    expect(fake.writes).toEqual([]);
  });

  it("stopped mid-way by typing in its Terminal, the list open: read on screen, closed with Esc", async () => {
    const fake = new FakeOpenCode(frameModels, "Beam Free OpenCode");
    let writes = 0;
    const result = await drive(glm, fake, () => (++writes > 2 ? "there was typing in its Terminal meanwhile" : null), { owned: () => null });
    expect(result).toEqual({ type: "refused", note: `Not set: there was typing in its Terminal meanwhile, ${openCodePickTexts.closed}` });
    expect(fake.keyLog()).toEqual(["type:/models", "Enter", "Escape"]);
    backedOut(fake);
  });

  it("stopped before /models went (typing in its Terminal): no cleanup key, as before", async () => {
    const fake = new FakeOpenCode(frameModels, "Beam Free OpenCode");
    let writes = 0;
    const result = await drive(glm, fake, () => (++writes > 1 ? "there was typing in its Terminal meanwhile" : null), { owned: () => null });
    expect(result).toEqual({ type: "refused", note: openCodePickTexts.stopped("there was typing in its Terminal meanwhile") });
    expect(fake.keyLog()).toEqual(["type:/models"]);
  });

  it("a read failing once after the search was typed: read again, the list closed with Esc", async () => {
    const fake = new FakeOpenCode(frameModels, "Beam Free OpenCode");
    let failed = false;
    const read = async (): Promise<string> => {
      if (!failed && fake.view.kind === "models" && fake.view.search !== "") {
        failed = true;
        throw new Error("the pane did not answer");
      }
      return fake.screen();
    };
    const result = await drive(glm, fake, () => null, { read });
    expect(failed).toBe(true);
    expect(result).toEqual({ type: "refused", note: `${openCodePickTexts.failedRead}, ${openCodePickTexts.closed}` });
    expect(fake.keyLog()).toEqual(["type:/models", "Enter", "type:GLM-5.3-Flash Free", "Escape"]);
    backedOut(fake);
  });

  it("reads failing for good after the search: no key sent blind; the note says to check its terminal", async () => {
    const fake = new FakeOpenCode(frameModels, "Beam Free OpenCode");
    const read = async (): Promise<string> => {
      if (fake.view.kind === "models" && fake.view.search !== "") throw new Error("the pane did not answer");
      return fake.screen();
    };
    const result = await drive(glm, fake, () => null, { read });
    expect(result).toEqual({ type: "refused", note: `${openCodePickTexts.failedRead}, ${openCodePickTexts.notClosed}` });
    expect(fake.keyLog()).toEqual(["type:/models", "Enter", "type:GLM-5.3-Flash Free"]);
  });

  it("the pane's agent or run changed with the list open: no cleanup key at all", async () => {
    const fake = new FakeOpenCode(frameModels, "Beam Free OpenCode");
    let writes = 0;
    const gone = (): string | null => (writes > 2 ? "the agent in the pane started again" : null);
    const result = await drive(glm, fake, () => (++writes > 2 ? "the agent in the pane started again" : null), { owned: gone });
    expect(result).toEqual({ type: "refused", note: `Not set: the agent in the pane started again, ${openCodePickTexts.notClosed}` });
    expect(fake.keyLog()).toEqual(["type:/models", "Enter"]);
  });
});

describe("bound to the pane: never while OpenCode works or waits on a question; one at a time", () => {
  const binding = { terminalID: "term", isAgent: true, kind: "opencode", session: null, run: { connection: 1, arrival: 1 }, atPromptOnly: true };

  function site(fake: FakeOpenCode, status: { value: string; pending?: boolean; input?: number; arrival?: number; agent?: string }) {
    return {
      writer: {
        prompt: async () => undefined,
        sendInput: async () => undefined,
        sendText: async (_pane: string, text: string) => fake.type(text),
        agentKeys: async () => undefined,
      },
      calls: { paneRead: async () => fake.screen(), paneSendKeys: async (_pane: string, keys: readonly string[]) => fake.keys(keys) },
      fresh: async () => true,
      pane: () => ({ paneID: "pane", terminalID: "term", workspaceID: "w", tabID: "t", focused: false, revision: 1, agent: status.agent ?? "opencode", agentStatus: status.value }) as never,
      agent: () => ({ paneID: "pane", terminalID: "term", agent: status.agent ?? "opencode", agentStatus: status.value, inputPending: status.pending === true }) as never,
      run: () => ({ connection: 1, arrival: status.arrival ?? 1 }),
      inputGeneration: () => status.input ?? 0,
    };
  }

  it("working, or a question pending: refused with the idle line, nothing written", async () => {
    for (const status of [{ value: "working" }, { value: "blocked" }, { value: "idle", pending: true }]) {
      const fake = new FakeOpenCode(frameModels, "Beam Free OpenCode");
      const { result } = await pickOpenCodeBound(site(fake, status), "pane", glm, binding, async () => undefined);
      expect(result).toEqual({ type: "refused", note: openCodePickTexts.notIdle });
      expect(fake.writes).toEqual([]);
    }
  });

  it("idle: the whole sequence in the pane's turn; a second pick for the pane meanwhile is refused", async () => {
    const fake = new FakeOpenCode(frameModels, "Beam Free OpenCode");
    const shared = site(fake, { value: "idle" });
    const [first, second] = await Promise.all([
      pickOpenCodeBound(shared, "pane", glm, binding, async () => undefined, "mini/pane"),
      pickOpenCodeBound(shared, "pane", beamFree, binding, async () => undefined, "mini/pane"),
    ]);
    expect(first.result).toEqual({ type: "set", model: glm.id, label: glm.name });
    expect(second.result).toEqual({ type: "refused", note: openCodePickTexts.running });
    expect(fake.keyLog()).toEqual(["type:/models", "Enter", "type:GLM-5.3-Flash Free", "Enter"]);
  });

  it("the user's Terminal input after the search: the open list closed with Esc, the prompt clear, no Return", async () => {
    const fake = new FakeOpenCode(frameModels, "GLM-5.3-Flash Free OpenCode");
    const status = { value: "idle", input: 0 };
    const bound = site(fake, status);
    const typeName = bound.writer.sendText;
    bound.writer.sendText = async (pane: string, text: string) => {
      await typeName(pane, text);
      if (text !== "/models") status.input += 1;
    };
    const { result } = await pickOpenCodeBound(bound, "pane", beamFree, binding, async () => undefined);
    expect(result).toEqual({ type: "refused", note: `Not set: there was typing in its Terminal meanwhile, ${openCodePickTexts.closed}` });
    expect(fake.keyLog()).toEqual(["type:/models", "Enter", "type:Beam Free", "Escape"]);
    expect(fake.footer).toBe("GLM-5.3-Flash Free OpenCode");
    backedOut(fake);
  });

  it("another run, or another agent, in the pane after the search: no key after, none to clean up", async () => {
    for (const change of [{ arrival: 2 }, { agent: "claude" }]) {
      const fake = new FakeOpenCode(frameModels, "Beam Free OpenCode");
      const status: { value: string; arrival?: number; agent?: string } = { value: "idle" };
      const bound = site(fake, status);
      const typeName = bound.writer.sendText;
      bound.writer.sendText = async (pane: string, text: string) => {
        await typeName(pane, text);
        if (text !== "/models") Object.assign(status, change);
      };
      const { result } = await pickOpenCodeBound(bound, "pane", glm, binding, async () => undefined);
      expect(result.type).toBe("refused");
      expect(fake.keyLog()).toEqual(["type:/models", "Enter", "type:GLM-5.3-Flash Free"]);
    }
  });

  it("another agent in the pane, or another run: refused before any key", async () => {
    const fake = new FakeOpenCode(frameModels, "Beam Free OpenCode");
    const { result } = await pickOpenCodeBound(site(fake, { value: "idle" }), "pane", glm, { ...binding, run: { connection: 1, arrival: 9 } }, async () => undefined);
    expect(result.type).toBe("refused");
    expect(fake.writes).toEqual([]);
  });
});

// The model picker's rows and ranking
// (src/shared/model-search.ts, T3 Code's ModelPickerContent and
// modelPickerSearch as the model): "Agent's default" first, Favourites on top,
// group headers; a search ranks an exact id, then a prefix, then a word inside
// the label, a starred model ahead of an equal one; 400 rows stay quick and
// only the rows in view are drawn; the keys skip headers. And the picker
// component's own handling (search, keys, stars) on the small hooks host.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { demoModelLists } from "../src/main/demo/demo-model-lists";
import { parseCatalog, type CatalogModel } from "../src/shared/model-catalog";
import { firstHighlight, modelScore, nextPickable, pickerRows, rankModels, rowOffsets, visibleRange, type PickerRow } from "../src/shared/model-search";
import { HookHost, elements } from "./support/fake-hooks";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  return { ...actual, ...fakeReact, default: { ...actual, ...fakeReact } };
});

const { ModelPicker, pickerLine } = await import("../src/renderer/components/ModelPicker");

const model = (id: string, label: string, group: string | null = null): CatalogModel => ({ id, label, group, efforts: [], defaultEffort: null, isDefault: false });

function listOf(agent: "cursor" | "opencode" | "codex"): readonly CatalogModel[] {
  const parsed = parseCatalog(agent, demoModelLists[agent]);
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.models;
}

const none = new Set<string>();
const words = (rows: readonly PickerRow[]): string[] => rows.map((row) => (row.kind === "header" ? `# ${row.label}` : row.kind === "default" ? "default" : row.model.id));

describe("the ranking", () => {
  const models = [model("gpt-5.6-sol", "GPT-5.6 Sol"), model("sol-mini", "Sol Mini"), model("gpt-6.1-sol", "GPT-6.1-Sol"), model("grok-4.7", "Grok 4.7"), model("sol", "Solar")];

  it("an exact id first, then a prefix, then a word inside the label, then anywhere", () => {
    expect(rankModels(models, "sol", none).map((one) => one.id)).toEqual(["sol", "sol-mini", "gpt-5.6-sol", "gpt-6.1-sol"]);
    expect(modelScore(models[4]!, "sol")).toBeLessThan(modelScore(models[1]!, "sol")!);
    expect(rankModels(models, "grok 4.7", none).map((one) => one.id)).toEqual(["grok-4.7"]);
  });

  it("every word must match; letters in order count only for three or more", () => {
    expect(rankModels(models, "gpt sol", none).map((one) => one.id)).toEqual(["gpt-5.6-sol", "gpt-6.1-sol"]);
    expect(rankModels(models, "gk47", none).map((one) => one.id)).toEqual(["grok-4.7"]);
    expect(rankModels(models, "zz", none)).toEqual([]);
  });

  it("a starred model ahead of an equal one; the list's order last", () => {
    expect(rankModels(models, "gpt", none).map((one) => one.id)).toEqual(["gpt-5.6-sol", "gpt-6.1-sol"]);
    expect(rankModels(models, "gpt", new Set(["gpt-6.1-sol"])).map((one) => one.id)).toEqual(["gpt-6.1-sol", "gpt-5.6-sol"]);
  });

  it("matches the label and the id: Cursor's Extra High rows by either", () => {
    const cursor = listOf("cursor");
    expect(rankModels(cursor, "grok 4.7 extra", none)[0]!.id).toBe("grok-4.7-xhigh");
    expect(rankModels(cursor, "grok-4.7-medium-fast", none)[0]!.id).toBe("grok-4.7-medium-fast");
  });
});

describe("the rows", () => {
  const defaultRow = { label: "Agent's default", note: "Auto", ticked: false };

  it("Agent's default first, Favourites on top, then each group under its header", () => {
    const models = [model("a/one", "one", "a"), model("b/two", "two", "b"), model("a/three", "three", "a")];
    const rows = pickerRows({ models, query: "", favourites: new Set(["b/two"]), current: "a/three", defaultRow });
    expect(words(rows)).toEqual(["default", "# Favourites", "b/two", "# a", "a/one", "a/three"]);
    expect(rows.find((row) => row.kind === "model" && row.model.id === "a/three")).toMatchObject({ ticked: true });
    expect(rows.find((row) => row.kind === "model" && row.model.id === "b/two")).toMatchObject({ favourite: true });
  });

  it("a list without groups has no headers but Favourites and All models", () => {
    const models = [model("x", "X"), model("y", "Y")];
    expect(words(pickerRows({ models, query: "", favourites: none, current: null, defaultRow: null }))).toEqual(["x", "y"]);
    expect(words(pickerRows({ models, query: "", favourites: new Set(["y"]), current: null, defaultRow: null }))).toEqual(["# Favourites", "y", "# All models", "x"]);
  });

  it("a search is one ranked list; Agent's default stays only for its own words", () => {
    const models = listOf("opencode");
    expect(words(pickerRows({ models, query: "big", favourites: none, current: null, defaultRow }))).toEqual(["opencode/big-pickle"]);
    // Letters in order count, but not strewn across a long name.
    expect(words(pickerRows({ models, query: "nemo", favourites: none, current: null, defaultRow })).slice(0, 2)).toEqual(["opencode/nemotron-3.5-lightning-free", "opencode/nemotron-3.5-super-vl-free"]);
    expect(words(pickerRows({ models, query: "default", favourites: none, current: null, defaultRow }))[0]).toBe("default");
  });

  it("OpenCode's list under its providers", () => {
    const rows = pickerRows({ models: listOf("opencode"), query: "", favourites: none, current: null, defaultRow });
    expect(rows.filter((row) => row.kind === "header").map((row) => (row as { label: string }).label)).toEqual(["opencode", "openrouter"]);
  });

  it("the keys skip headers; a fresh list highlights the ticked row", () => {
    const models = [model("a/one", "one", "a"), model("b/two", "two", "b")];
    const rows = pickerRows({ models, query: "", favourites: none, current: "b/two", defaultRow });
    expect(words(rows)).toEqual(["default", "# a", "a/one", "# b", "b/two"]);
    expect(firstHighlight(rows, "")).toBe(4);
    expect(nextPickable(rows, 0, 1)).toBe(2);
    expect(nextPickable(rows, 2, 1)).toBe(4);
    expect(nextPickable(rows, 4, 1)).toBe(4);
    expect(nextPickable(rows, 2, -1)).toBe(0);
    expect(firstHighlight(pickerRows({ models, query: "two", favourites: none, current: "a/one", defaultRow }), "two")).toBe(0);
  });
});

describe("400 rows", () => {
  const many = Array.from({ length: 400 }, (_, index) => model(`provider${index % 7}/model-${index}`, `Model ${index}`, `provider${index % 7}`));

  it("rank and lay out quickly, and only the rows in view are drawn", () => {
    const started = performance.now();
    for (let i = 0; i < 20; i += 1) {
      rankModels(many, `model ${i}`, new Set(["provider1/model-1"]));
      pickerRows({ models: many, query: "", favourites: new Set(["provider3/model-3"]), current: "provider0/model-0", defaultRow: null });
    }
    // Twenty searches and twenty layouts of 400 rows: well under a frame each.
    expect((performance.now() - started) / 40).toBeLessThan(16);
    const rows = pickerRows({ models: many, query: "", favourites: none, current: null, defaultRow: null });
    const { tops, height } = rowOffsets(rows);
    expect(rows).toHaveLength(407);
    const range = visibleRange(tops, height, 3_000, 320);
    expect(range.end - range.start).toBeLessThan(30);
    expect(tops[range.start]!).toBeLessThanOrEqual(3_000);
    expect(visibleRange(tops, height, 0, 320).start).toBe(0);
    expect(visibleRange(tops, height, 1e9, 320).end).toBe(rows.length);
  });
});

describe("the picker component", () => {
  let picked: (string | null)[];
  let closed: number;
  let starred: string[];

  beforeEach(() => {
    picked = [];
    closed = 0;
    starred = [];
    vi.stubGlobal("window", { addEventListener: () => undefined, removeEventListener: () => undefined });
  });

  type Node = { type: unknown; props: Record<string, unknown> };
  function picker(models: readonly CatalogModel[], extra: Record<string, unknown> = {}) {
    const props = {
      agent: "codex",
      view: { agent: "codex", models, readAt: 1, error: null, loading: false, none: null },
      models,
      current: "gpt-6-sol",
      defaultRow: { ticked: false, note: null, disabledReason: "Codex's default is the one in its config; pick a model by name" },
      favourites: new Set<string>(),
      onToggleFavourite: (id: string) => starred.push(id),
      onPick: (id: string | null) => picked.push(id),
      onClose: () => (closed += 1),
      ...extra,
    };
    const ui = new HookHost(ModelPicker as (props: object) => unknown, props);
    ui.render();
    const all = (): Node[] => elements(ui.tree) as Node[];
    const input = () => all().find((e) => e.type === "input")!;
    const options = () => all().filter((e) => e.props["role"] === "option");
    const key = (name: string) => {
      const root = all().find((e) => e.props["role"] === "dialog")!;
      (root.props["onKeyDown"] as (event: object) => void)({ key: name, preventDefault: () => undefined, stopPropagation: () => undefined });
      ui.render();
    };
    const type = (text: string) => {
      (input().props["onChange"] as (event: object) => void)({ target: { value: text } });
      ui.render();
    };
    return { ui, all, input, options, key, type };
  }

  it("opens with the search, the current model ticked and highlighted; Enter picks it, Esc closes", () => {
    const p = picker(listOf("codex"));
    expect(p.input().props["placeholder"]).toBe("Search models");
    const ticked = p.options().find((e) => e.props["aria-selected"] === true)!;
    expect(String(ticked.props["className"])).toContain("hl");
    expect(ticked.props["title"]).toBe(listOf("codex").find((one) => one.id === "gpt-6-sol")!.note);
    p.key("Enter");
    expect(picked).toEqual(["gpt-6-sol"]);
    p.key("Escape");
    expect(closed).toBe(2);
  });

  it("typing ranks; arrows move past the greyed default row; Enter picks the highlighted one", () => {
    const p = picker(listOf("codex"));
    p.type("luna");
    expect(p.options().map((e) => String(e.props["title"]).length > 0)).toHaveLength(2);
    p.key("ArrowDown");
    p.key("Enter");
    expect(picked).toEqual(["gpt-5.6-luna"]);
  });

  it("the greyed default row cannot be picked", () => {
    const p = picker(listOf("codex"), { current: null });
    const row = p.options()[0]!;
    expect(row.props["aria-disabled"]).toBe(true);
    (row.props["onClick"] as () => void)();
    expect(picked).toEqual([]);
  });

  it("closes when the focus goes outside it and its chip or field (a dialog opening), not inside them or to nothing", () => {
    const p = picker(listOf("codex"));
    const root = p.all().find((e) => e.props["role"] === "dialog")!;
    const inside = { name: "the chip's button" };
    const outside = { name: "New agent's dialog" };
    (root.props["ref"] as { current: unknown }).current = { parentElement: { contains: (node: unknown) => node === inside } };
    const blur = (relatedTarget: unknown) => (root.props["onBlur"] as (event: object) => void)({ relatedTarget });
    blur(inside);
    blur(null);
    expect(closed).toBe(0);
    blur(outside);
    expect(closed).toBe(1);
  });

  it("a star toggles a favourite and never picks the row", () => {
    const p = picker(listOf("codex"));
    const star = p.all().find((e) => e.type === "button" && String(e.props["aria-label"]).startsWith("Add GPT-6-Astra"))!;
    (star.props["onClick"] as (event: object) => void)({ stopPropagation: () => undefined });
    expect(starred).toEqual(["gpt-6-astra"]);
    expect(picked).toEqual([]);
  });

  it("says why there is nothing: a read under way, a failed read, no match, Antigravity's none, read only", () => {
    expect(pickerLine("cursor", null, [], "", null)).toBe("Reading Cursor's models\u{2026}");
    expect(pickerLine("cursor", { agent: "cursor", models: [], readAt: null, error: "Could not read Cursor's models: x.", loading: false, none: null }, [], "", null)).toBe("Could not read Cursor's models: x.");
    expect(pickerLine("codex", { agent: "codex", models: [], readAt: 1, error: null, loading: false, none: null }, [], "zz", null)).toBe("No model matches \u{201C}zz\u{201D}.");
    expect(pickerLine("agy", { agent: "agy", models: [], readAt: null, error: null, loading: false, none: "Antigravity CLI's models are in its own picker." }, [], "", null)).toBe("Antigravity CLI's models are in its own picker.");
    const p = picker(listOf("codex"), { readOnly: "Read only here." });
    expect(p.all().some((e) => e.props["className"] === "mp-line" && e.props["children"] === "Read only here.")).toBe(true);
    (p.options()[2]!.props["onClick"] as () => void)();
    expect(picked).toEqual([]);
  });
});

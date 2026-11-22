// An Antigravity CLI pane's three chips (src/renderer/components/AgentChips.tsx, agent-picks.ts): the model, the level
// and the mode its screen's last row shows (main's watch sends it: PaneModeEvent's agyRow), read from each of the
// samples' idle screens; the Model picker lists the CLI's models grouped (Gemini 4 Neon first) with the one it runs
// ticked; the Effort menu lists that model's levels, each a pick of its own row's id; a model with no level has no
// Effort chip; a pick proved by the row shows on the chips, one not proved keeps them and says so.

import { readFileSync } from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { HostView } from "../src/shared/ipc-contract";
import type { SidebarRow } from "../src/shared/sidebar-model";
import { decodeSessionTopology } from "../src/main/herdr/wire";
import { HookHost, elements } from "./support/fake-hooks";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  return { ...actual, ...fakeReact, default: { ...actual, ...fakeReact } };
});

const { AgentChips, agyEffortMenu, chipPickerSpec, modelPickRequest } = await import("../src/renderer/components/AgentChips");
const { agentPicks, agyNotConfirmedText } = await import("../src/renderer/components/agent-picks");
const { modelCatalogStore } = await import("../src/renderer/components/model-catalog-store");
const { agyBuiltIn, agySshSignInLine, parseCatalog } = await import("../src/shared/model-catalog");
const { pickerLine } = await import("../src/renderer/components/ModelPicker");
const { readAgyStatusRow } = await import("../src/shared/agy-input");

type Node = { type: unknown; props: Record<string, unknown> };

const listText = readFileSync(path.join(__dirname, "..", "fixtures", "agy", "models-1.5.14.txt"), "utf8");
const idle = (name: string): string => readFileSync(path.join(__dirname, "fixtures", "agy-input", `${name}.txt`), "utf8");

function agyView() {
  const parsed = parseCatalog("agy", listText);
  if (!parsed.ok) throw new Error(parsed.reason);
  return { agent: "agy" as const, models: parsed.models, readAt: 1, error: null, loading: false, none: null };
}

const key = "mac-mini/w1:p1";
const binding = { terminalID: "t-7", isAgent: true, kind: "agy", session: null, run: { connection: 3, arrival: 2 } };
const context = { hostId: "mac-mini", paneId: "w1:p1", agent: "agy", status: "idle", binding } as never;
const scope = { terminalID: "t-7", session: null };

let picked: unknown[] = [];
let answer: unknown = undefined;

beforeEach(() => {
  agentPicks.clear();
  modelCatalogStore.clear();
  picked = [];
  answer = undefined;
  vi.stubGlobal("window", {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    herdrDesktop: {
      sendToPane: async () => undefined,
      modelPick: async (_host: string, _pane: string, pick: unknown) => {
        picked.push(pick);
        return answer;
      },
      modePick: async () => undefined,
      copyText: () => undefined,
      modelCatalog: async () => agyView(),
    },
  });
});

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};

/** Main's watch: the last row read off `screen` (null when it does not read). */
function seen(screen: string): void {
  const row = readAgyStatusRow(screen);
  agentPicks.receiveMode(key, { scope, run: binding.run, agent: "agy", mode: row?.mode ?? null, agyRow: row });
}

function hostWithAgy(): HostView {
  const topology = decodeSessionTopology({
    version: "0.9.5",
    protocol: 22,
    workspaces: [],
    tabs: [],
    panes: [{ pane_id: "w1:p1", terminal_id: "t-7", workspace_id: "w1", tab_id: "w1:t1", focused: false, agent: "agy", agent_status: "idle", revision: 1 }],
    layouts: [],
    agents: [{ pane_id: "w1:p1", agent: "agy", agent_status: "idle" }],
  });
  return { id: "mac-mini", name: "Mac mini", state: "connected", topology, run: { connection: 3, arrivals: { "w1:p1": 2 } } } as unknown as HostView;
}

/** The chips' buttons as they draw (their aria labels). */
async function chipLabels(): Promise<string[]> {
  const row = { paneID: "w1:p1", name: "Notes", workspaceLabel: "notes", kind: "agy", isAgent: true, status: "idle" } as unknown as SidebarRow;
  const ui = new HookHost(AgentChips as (props: object) => unknown, { host: hostWithAgy(), row });
  ui.render();
  await flush();
  ui.render();
  return (elements(ui.tree) as Node[]).filter((e) => typeof e.props["aria-label"] === "string").map((e) => String(e.props["aria-label"]));
}

describe("the chips' values from the last row of each idle screen", () => {
  it.each([
    ["idle-start", "auto", "Gemini 4 Hydrogen", "low"],
    ["idle-after-reply", "auto", "Gemini 4 Hydrogen", "low"],
    ["idle-after-esc", "auto", "Gemini 4 Hydrogen", "low"],
    ["idle-cleared", "auto", "Gemini 4 Hydrogen", "low"],
    ["idle-typed", "auto", "Gemini 4 Hydrogen", "low"],
    ["idle-two-lines", "auto", "Gemini 4 Hydrogen", "low"],
    ["idle-plan", "plan", "Gemini 4 Hydrogen", "low"],
    ["idle-accept-edits", "acceptEdits", "Gemini 4 Hydrogen", "low"],
    // No mode word: the mode that asks every time.
    ["idle-ask-mode", "default", "Gemini 4 Hydrogen", "low"],
    ["working", "auto", "Gemini 4 Hydrogen", "low"],
  ] as const)("%s: mode %s, model %s, level %s", (name, mode, model, level) => {
    expect(readAgyStatusRow(idle(name))).toEqual({ mode, model, level });
    seen(idle(name));
    expect(agentPicks.chip(key, "model", binding as never).label).toBe(model);
    expect(agentPicks.chip(key, "effort", binding as never).label).toBe("Low");
    expect(agentPicks.mode(key, binding as never)).toBe(mode);
  });

  it("the mode chip's names: Auto, Accept edits, Plan, and Supervised for no mode word", () => {
    for (const [name, label] of [
      ["idle-start", "Auto"],
      ["idle-accept-edits", "Accept edits"],
      ["idle-plan", "Plan"],
      ["idle-ask-mode", "Supervised"],
    ] as const) {
      seen(idle(name));
      expect(agentPicks.modeChip(key, binding as never, "agy").label).toBe(label);
    }
  });

  it("no last row (a question, a frame cut): nothing read, the chips show nothing of it", () => {
    expect(readAgyStatusRow("Accept this file edit?\n1. Yes, accept this change\n2. No, reject this change\n")).toBeNull();
    expect(readAgyStatusRow("")).toBeNull();
    // The row alone with no rule above it.
    expect(readAgyStatusRow("? for shortcuts            auto · Gemini 4 Hydrogen · low\n")).toBeNull();
    seen("Accept this file edit?\n");
    expect(agentPicks.settings(key, binding as never)).toEqual({ model: null, modelLabel: null, effort: null });
    expect(agentPicks.mode(key, binding as never)).toBeNull();
  });

  it("three chips on the pane: Model, Effort, Permissions", async () => {
    seen(idle("idle-start"));
    const labels = await chipLabels();
    expect(labels.some((label) => label.startsWith("Model: Gemini 4 Hydrogen"))).toBe(true);
    expect(labels.some((label) => label.startsWith("Effort: Low"))).toBe(true);
    expect(labels.some((label) => label.includes("Auto"))).toBe(true);
  });

  it("a model with no level (Orchestrator (Neon), drawn either way): no Effort chip", async () => {
    agentPicks.receiveMode(key, { scope, run: binding.run, agent: "agy", mode: "auto", agyRow: { mode: "auto", model: "Orchestrator", level: "neon" } });
    expect(agentPicks.settings(key, binding as never)).toEqual({ model: null, modelLabel: "Orchestrator (neon)", effort: null });
    expect((await chipLabels()).some((label) => label.startsWith("Effort"))).toBe(false);
    agentPicks.receiveMode(key, { scope, run: binding.run, agent: "agy", mode: "auto", agyRow: { mode: "auto", model: "Orchestrator (Neon)", level: null } });
    expect((await chipLabels()).some((label) => label.startsWith("Effort"))).toBe(false);
  });
});

describe("the Model picker and the Effort menu", () => {
  it("the CLI's models grouped, in its order (Gemini 4 Neon first), the one running ticked, no ids shown", () => {
    seen(idle("idle-start"));
    const spec = chipPickerSpec(context, key, agyView());
    expect(spec.models.map((row) => row.label)).toEqual([
      "Gemini 4 Neon",
      "Gemini 4 Argon",
      "Gemini 4 Hydrogen",
      "Orchestrator (Neon)",
      "Orchestrator (Argon)",
      "Gemini 3.8 Flash",
      "Claude Opus 5.5",
      "Claude Sonnet 5.5",
      "GPT-OSS 120B",
    ]);
    expect(spec.current).toBe("gemini-4-hydrogen-high");
    expect(spec.hideIds).toBe(true);
    expect(spec.defaultRow).toBeNull();
  });

  it("the Effort menu: the running model's levels, the one it runs ticked, each its own row's id", () => {
    seen(idle("idle-start"));
    const items = agyEffortMenu(context, key, agyView());
    expect(items.map((item) => [item.label, item.ticked])).toEqual([
      ["Low", true],
      ["Medium", false],
      ["High", false],
      ["Extra high", false],
    ]);
    expect(items.map((item) => (item.pick as { modelPick?: unknown } | null)?.modelPick)).toEqual([
      { agent: "agy", model: "gemini-4-hydrogen-low", effort: null },
      { agent: "agy", model: "gemini-4-hydrogen-medium", effort: null },
      { agent: "agy", model: "gemini-4-hydrogen-high", effort: null },
      { agent: "agy", model: "gemini-4-hydrogen-xhigh", effort: null },
    ]);
    expect(items.map((item) => (item.pick as { command?: string } | null)?.command)).toEqual([
      "/model gemini-4-hydrogen-low",
      "/model gemini-4-hydrogen-medium",
      "/model gemini-4-hydrogen-high",
      "/model gemini-4-hydrogen-xhigh",
    ]);
  });

  it("a model picked keeps the level it runs at (low); its command is the row's id", () => {
    const request = modelPickRequest("agy", agyView().models, "gemini-4-neon-high", "low")!;
    expect(request).toMatchObject({ kind: "model", label: "Gemini 4 Neon", modelPick: { agent: "agy", model: "gemini-4-neon-low", effort: null }, command: "/model gemini-4-neon-low" });
  });
});

// Over SSH the CLI cannot list its models (its sign-in is in the keychain): the chips' menus list the
// built-in models exactly as a read list's, under the one line.
describe("the Model picker and the Effort menu over the built-in list", () => {
  const builtIn = { agent: "agy" as const, models: agyBuiltIn, readAt: null, error: agySshSignInLine, loading: false, none: null };

  it("the same groups, the one running ticked; the picker's line says why", () => {
    seen(idle("idle-start"));
    const spec = chipPickerSpec(context, key, builtIn);
    const read = chipPickerSpec(context, key, agyView());
    expect(spec.models).toEqual(read.models);
    expect(spec.models[0]).toMatchObject({ id: "gemini-4-neon-high", label: "Gemini 4 Neon" });
    expect(spec.current).toBe("gemini-4-hydrogen-high");
    expect(pickerLine("agy", builtIn, [], "", spec.readOnly, spec.note)).toBe(
      "Antigravity CLI cannot list its models over SSH (its sign-in is in the Mac's keychain). Showing the models Adari knows.",
    );
  });

  it("the Effort menu: the running model's levels, each its own row's id, as with a read list", () => {
    seen(idle("idle-start"));
    expect(agyEffortMenu(context, key, builtIn)).toEqual(agyEffortMenu(context, key, agyView()));
  });
});

describe("a pick from the chips", () => {
  it("proved by the row: the chips show the new model and level", async () => {
    seen(idle("idle-start"));
    answer = { type: "agy", confirmed: true, row: { mode: "auto", model: "Gemini 4 Neon", level: "low" } };
    agentPicks.pick(context, modelPickRequest("agy", agyView().models, "gemini-4-neon-high", "low")!);
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(picked).toEqual([{ agent: "agy", model: "gemini-4-neon-low", effort: null }]);
    expect(agentPicks.chip(key, "model", binding as never).label).toBe("Gemini 4 Neon");
    expect(agentPicks.note(key)).toBeNull();
  });

  it("not proved: sent once, the chips keep what the screen said, the not-confirmed words", async () => {
    seen(idle("idle-start"));
    answer = { type: "agy", confirmed: false, row: { mode: "auto", model: "Gemini 4 Hydrogen", level: "low" } };
    agentPicks.pick(context, modelPickRequest("agy", agyView().models, "gemini-4-neon-high", "low")!);
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(picked).toHaveLength(1);
    expect(agentPicks.chip(key, "model", binding as never).label).toBe("Gemini 4 Hydrogen");
    expect(agentPicks.note(key)).toBe(agyNotConfirmedText("Gemini 4 Neon"));
    expect(agyNotConfirmedText("Gemini 4 Neon")).toBe("Not confirmed yet: Antigravity CLI's last row did not show Gemini 4 Neon, so the chips show what its screen says.");
  });
});

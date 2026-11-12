// The Model and Effort chips in the box's row
// (src/renderer/components/AgentChips.tsx) on the small hooks host, and the
// main process's chat updates carrying their values (src/main/chat/service.ts
// over the demo machine). A pick never touches the user's draft.

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

const { AgentChips } = await import("../src/renderer/components/AgentChips");
const { agentPicks } = await import("../src/renderer/components/agent-picks");
const { composerDrafts } = await import("../src/renderer/components/composer-drafts");
const { modelCatalogStore } = await import("../src/renderer/components/model-catalog-store");
const { ModelPicker } = await import("../src/renderer/components/ModelPicker");
const { parseCatalog } = await import("../src/shared/model-catalog");
const { demoModelLists } = await import("../src/main/demo/demo-model-lists");
const { modelPickCommand } = await import("../src/shared/model-choices");

let sends: { paneId: string; text: string; binding: unknown }[];
/** The lists main was asked for (machine, agent). */
let asked: string[];

/** The demo machine's list for `agent`, as main answers it. */
function catalogView(agent: "claude" | "codex" | "grok" | "cursor" | "opencode") {
  const parsed = parseCatalog(agent, demoModelLists[agent]);
  if (!parsed.ok) throw new Error(parsed.reason);
  return { agent, models: parsed.models, readAt: 1, error: null, loading: false, none: null };
}

beforeEach(() => {
  sends = [];
  asked = [];
  agentPicks.clear();
  composerDrafts.clear();
  modelCatalogStore.clear();
  vi.stubGlobal("window", {
    herdrDesktop: {
      sendToPane: async (_hostId: string, paneId: string, text: string, binding: unknown) => {
        sends.push({ paneId, text, binding });
      },
      // A model pick goes to main as itself; main checks it on the machine's list and makes the
      // line (model-pick-main.test.ts runs main's own handler), as here.
      modelPick: async (_hostId: string, paneId: string, pick: { agent: "claude" | "codex"; model: string; effort: string | null }, binding: unknown) => {
        const built = modelPickCommand(pick, catalogView(pick.agent).models);
        if (!built.ok) throw new Error(`Not sent: ${built.reason}`);
        sends.push({ paneId, text: built.command, binding });
      },
      copyText: () => undefined,
      modelCatalog: async (hostId: string, agent: "claude" | "codex") => {
        asked.push(`${hostId} ${agent}`);
        return catalogView(agent);
      },
    },
  });
});

const flush = async (): Promise<void> => {
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
};

function hostWith(agent: string | null, status = "idle"): HostView {
  const topology = decodeSessionTopology({
    version: "0.9.5",
    protocol: 22,
    workspaces: [],
    tabs: [],
    panes: [
      {
        pane_id: "w1:p1",
        terminal_id: "t-7",
        workspace_id: "w1",
        tab_id: "w1:t1",
        focused: false,
        ...(agent === null ? {} : { agent }),
        agent_status: status,
        revision: 1,
      },
    ],
    layouts: [],
    agents: agent === null ? [] : [{ pane_id: "w1:p1", agent, agent_status: status, agent_session: { source: `herdr:${agent}`, agent, kind: "id", value: "s-1" } }],
  });
  return { id: "mac-mini", name: "Mac mini", state: "connected", topology, run: { connection: 3, arrivals: { "w1:p1": 2 } } } as unknown as HostView;
}

const row = (kind: string, isAgent = true) => ({ paneID: "w1:p1", name: "Notes", workspaceLabel: "notes", kind, isAgent, status: "idle" }) as unknown as SidebarRow;

type Node = { type: unknown; props: Record<string, unknown> };

function chips(host: HostView, pane: SidebarRow) {
  const ui = new HookHost(AgentChips as (props: object) => unknown, { host, row: pane });
  ui.render();
  const all = (): Node[] => elements(ui.tree) as Node[];
  const button = (kind: "model" | "effort") => all().find((e) => e.props["className"] === "pick-b" && String(e.props["aria-label"]).startsWith(kind === "model" ? "Model" : "Effort"));
  const label = (kind: "model" | "effort") => {
    const found = button(kind);
    return found === undefined ? undefined : String(found.props["aria-label"]).replace(/^(Model|Effort): /, "");
  };
  const menu = () => all().find((e) => Array.isArray(e.props["items"])) as Node | undefined;
  /** The Model chip's picker (its props: models, current, defaultRow, onPick, …). */
  const picker = () => all().find((e) => e.type === ModelPicker) as Node | undefined;
  return { ui, button, label, menu, picker, open: (kind: "model" | "effort") => (button(kind)!.props["onClick"] as () => void)() };
}

const scope = { terminalID: "t-7", session: "s-1" };

describe("the Model and Effort chips", () => {
  it("sit in a Claude pane's row with the transcript's values, Default until it names an effort", () => {
    const c = chips(hostWith("claude"), row("claude"));
    // The agent's default before the transcript names a model, never a bare "Model".
    expect(c.label("model")).toBe("Default");
    expect(String(c.button("model")!.props["title"])).toBe("The agent's default model");
    expect(c.label("effort")).toBe("Default");
    agentPicks.receive("mac-mini/w1:p1", { model: "claude-opus-5-5", modelLabel: "Opus 5.5", effort: "high", scope }, "t1");
    c.ui.render();
    expect(c.label("model")).toBe("Opus 5.5");
    expect(c.label("effort")).toBe("High");
  });

  it("open a menu at the chip with the current value ticked; a pick sends its command bound to the pane, the draft untouched", async () => {
    composerDrafts.edit("mac-mini/w1:p1", "my half-written message");
    agentPicks.receive("mac-mini/w1:p1", { model: "claude-opus-5-5", modelLabel: "Opus 5.5", effort: "high", scope }, null);
    const c = chips(hostWith("claude"), row("claude"));
    c.open("effort");
    const items = c.menu()!.props["items"] as { label: string; ticked: boolean; pick: unknown }[];
    expect(items.map((item) => [item.label, item.ticked])).toEqual([
      ["Low", false],
      ["Medium", false],
      ["High", true],
      ["Extra high", false],
      ["Max", false],
    ]);
    (c.menu()!.props["onPick"] as (pick: unknown) => void)(items[4]!.pick);
    await Promise.resolve();
    expect(sends).toEqual([
      { paneId: "w1:p1", text: "/effort max", binding: { terminalID: "t-7", isAgent: true, kind: "claude", session: "s-1", run: { connection: 3, arrival: 2 }, atPromptOnly: true } },
    ]);
    expect(composerDrafts.get("mac-mini/w1:p1").text).toBe("my half-written message");
    c.ui.render();
    expect(c.label("effort")).toBe("Max");
    // The Model chip opens the picker on Claude Code's own list, the alias that names the transcript's model ticked.
    c.open("model");
    await flush();
    c.ui.render();
    // Each open asks main (the Effort menu's, then the picker's): main answers from its cache and reads behind when old.
    expect(asked).toEqual(["mac-mini claude", "mac-mini claude"]);
    const picker = c.picker()!.props as { models: { id: string; label: string }[]; current: string | null; defaultRow: { ticked: boolean; note: string | null } };
    expect(picker.models.slice(0, 4).map((model) => [model.id, model.label])).toEqual([
      ["opus", "Opus 5.5"],
      ["fable", "Fable 5.2"],
      ["sonnet", "Sonnet 5.5"],
      ["haiku", "Haiku 5.5"],
    ]);
    expect(picker.current).toBe("opus");
    expect(picker.defaultRow).toEqual({ ticked: false, note: "Fable 5.2" });
  });

  it("say next turn while the pane works, and send nothing yet", async () => {
    const c = chips(hostWith("claude", "working"), row("claude"));
    c.open("model");
    await flush();
    c.ui.render();
    (c.picker()!.props["onPick"] as (id: string | null) => void)("sonnet");
    c.ui.render();
    expect(sends).toEqual([]);
    expect(c.label("model")).toBe("Sonnet 5.5 (next turn)");
    // The next snapshot shows it back at its prompt: it goes, once.
    agentPicks.syncHosts([hostWith("claude", "idle")]);
    agentPicks.syncHosts([hostWith("claude", "idle")]);
    expect(sends.map((sent) => sent.text)).toEqual(["/model sonnet"]);
  });

  it("Codex: Model opens the picker on Codex's own list (no Terminal); Effort waits for the model", async () => {
    const c = chips(hostWith("codex"), row("codex"));
    c.open("model");
    await flush();
    c.ui.render();
    const picker = c.picker()!.props as { models: { id: string }[]; defaultRow: { disabledReason?: string }; action: unknown };
    // The listed models by Codex's priority, the hidden ones left out.
    expect(picker.models.map((model) => model.id)).toEqual([
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
    expect(picker.defaultRow.disabledReason).toBe("Codex's default is the one in its config; pick a model by name");
    expect(picker.action).toBeNull();
    c.open("effort");
    const effort = c.menu()!.props["items"] as { label: string; disabledReason?: string }[];
    // Before Codex names its model: the levels every listed model takes, greyed until the model is known.
    expect(effort.map((item) => item.label)).toEqual(["Low", "Medium", "High", "Extra high", "Max"]);
    expect(effort[0]!.disabledReason).toBe("Codex's model is not known yet");
  });

  it("Codex: a model by name goes as /model <slug> --reasoning=<level>, the level the new model keeps or its default", async () => {
    agentPicks.receive("mac-mini/w1:p1", { model: "gpt-6.1-sol", modelLabel: "gpt-6.1-sol", effort: "ultra", scope }, null);
    const c = chips(hostWith("codex"), row("codex"));
    c.open("effort");
    await flush();
    c.ui.render();
    const levels = c.menu()!.props["items"] as { label: string; ticked: boolean; tag?: string }[];
    expect(levels.map((item) => [item.label, item.ticked, item.tag ?? ""])).toEqual([
      ["Low", false, "default"],
      ["Medium", false, ""],
      ["High", false, ""],
      ["Extra high", false, ""],
      ["Max", false, ""],
      ["Ultra", true, ""],
    ]);
    c.open("model");
    c.ui.render();
    // GPT-6-Luna takes no ultra: its own default (medium), no nearest level.
    (c.picker()!.props["onPick"] as (id: string | null) => void)("gpt-6-luna");
    await flush();
    expect(sends.map((sent) => sent.text)).toEqual(["/model gpt-6-luna --reasoning=medium"]);
    c.ui.render();
    expect(c.label("model")).toBe("gpt-6-luna");
    // The transcript's next turn context confirms it.
    agentPicks.receive("mac-mini/w1:p1", { model: "gpt-6-luna", modelLabel: "gpt-6-luna", effort: "medium", scope }, "t2");
    expect(agentPicks.confirmations("mac-mini/w1:p1", "t2")).toEqual(["Model: gpt-6-luna"]);
  });

  it("OpenCode gets the Model chip only (its rows pick); no chips for a shell or another agent", () => {
    const open = chips(hostWith("opencode"), row("opencode"));
    expect(open.label("model")).toBe("Default");
    expect(open.button("effort")).toBeUndefined();
    expect(elements(open.ui.tree).some((e) => String((e as Node).props["aria-label"] ?? "").startsWith("Permissions"))).toBe(false);
    open.open("model");
    open.ui.render();
    expect((open.picker()!.props as { readOnly: string | null }).readOnly).toBeNull();
    expect(chips(hostWith("gemini"), row("gemini")).button("model")).toBeUndefined();
    expect(chips(hostWith(null), row("zsh", false)).button("model")).toBeUndefined();
  });
});

describe("the capture", () => {
  it("shows both chips and the open Effort menu on the demo's own pane, after the split steps", async () => {
    const { demoCaptureSteps } = await import("../src/main/capture");
    const { demoHostIds } = await import("../src/main/demo/demo-hosts");
    const steps = demoCaptureSteps(demoHostIds);
    // The card step (38) follows it (37 and 38 come after the terminal copy's 36, which closed step 35's dialog).
    const chips = steps.find((step) => step.name === "37-model-effort-chips")!;
    // The new workspace's two steps (39, 40) come after 38.
    expect(steps.at(-4)).toBe(chips);
    expect(steps.at(-5)!.name).toBe("36-terminal-copied");
    expect(chips.commands).toEqual([
      { type: "select-pane", hostId: demoHostIds.macMini, paneId: "w7:p1H" },
      { type: "set-tab", tab: "chat" },
      { type: "click", selector: ".cmp-bar .chip.pick.effort .pick-b" },
    ]);
  });
});

describe("the chat update", () => {
  it("carries the chips' values read from the same transcript reads, with their terminal and session", async () => {
    const { ChatService } = await import("../src/main/chat/service");
    const { DemoBackend } = await import("../src/main/demo/demo-backend");
    const { demoHostIds, demoHosts } = await import("../src/main/demo/demo-hosts");
    const { HostRegistry } = await import("../src/main/hosts");
    const { bundledFixturesForTests } = await import("./support/demo-fixtures");
    const { eventually } = await import("./support/chat-lines");
    const registry = new HostRegistry(() => undefined);
    const fixtures = bundledFixturesForTests();
    for (const host of demoHosts(fixtures, Date.now())) registry.add(host.descriptor, new DemoBackend(host, fixtures));
    await registry.refreshAll();
    const service = new ChatService(registry, "chat", { pollIntervalMs: 5 });
    const updates: { settings?: { modelLabel: string | null; effort: string | null; scope: { terminalID: string } } }[] = [];
    const page = { id: 1, send: (_channel: string, payload: never) => updates.push(payload), isDestroyed: () => false };
    service.open(page, demoHostIds.macMini, "w7:p1G");
    await eventually(() => updates.at(-1)?.settings?.modelLabel === "Opus 5.5");
    const pane = registry.pane(demoHostIds.macMini, "w7:p1G")!;
    expect(updates.at(-1)!.settings).toMatchObject({ modelLabel: "Opus 5.5", effort: "xhigh", scope: { terminalID: pane.terminalID } }); // The demo's replies carry it
    // A shell's chat carries none.
    service.open(page, demoHostIds.buildBox, "w2:p3");
    expect(updates.at(-1)!.settings).toBeUndefined();
    service.closeAll();
    registry.close();
  });
});

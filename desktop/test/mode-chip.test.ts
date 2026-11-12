// The Permissions chip in the box's row beside Model and
// Effort (src/renderer/components/AgentChips.tsx), T3 Code's
// ComposerContextPermissions: the mode's icon and the agent's own word
// (Supervised for a default with none, "Permissions" while none reads), a
// menu of the agent's modes with each one's description, the current one
// ticked. Its values: Claude Code's and Grok's screens (main's mode watch,
// PaneModeEvent), Cursor's footer, Codex's rollout (the chat update's
// settings, a pick's screen until a newer turn says otherwise). Opening the
// menu never types; a pick goes to main's modePick, only at the prompt.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HostView, ModePickResult } from "../src/shared/ipc-contract";
import type { SidebarRow } from "../src/shared/sidebar-model";
import { decodeSessionTopology } from "../src/main/herdr/wire";
import { HookHost, elements } from "./support/fake-hooks";
import { modeScreen } from "./support/mode-fixtures";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  return { ...actual, ...fakeReact, default: { ...actual, ...fakeReact } };
});

const { AgentChips } = await import("../src/renderer/components/AgentChips");
const { agentPicks, pickContext } = await import("../src/renderer/components/agent-picks");
const { parseCursorFooter } = await import("../src/shared/agent-settings");
const { bypassStartNote } = await import("../src/shared/approval-modes");

interface ModeCall {
  readonly paneId: string;
  readonly agent: string;
  readonly target: string;
  readonly binding: unknown;
}

let calls: ModeCall[];
let sends: string[];
let answer: (call: ModeCall) => Promise<ModePickResult>;

beforeEach(() => {
  calls = [];
  sends = [];
  answer = async (call) => ({ type: "set", mode: call.target });
  agentPicks.clear();
  vi.stubGlobal("window", {
    herdrDesktop: {
      sendToPane: async (_hostId: string, _paneId: string, text: string) => {
        sends.push(text);
      },
      modePick: (_hostId: string, paneId: string, agent: string, target: string, binding: unknown) => {
        const call = { paneId, agent, target, binding };
        calls.push(call);
        return answer(call);
      },
      copyText: () => undefined,
    },
  });
});

afterEach(() => vi.unstubAllGlobals());

const key = "mac-mini/w1:p1";
const scope = { terminalID: "t-7", session: "s-1" };
const run = { connection: 3, arrival: 2 };

function hostWith(agent: string | null, status = "idle"): HostView {
  const topology = decodeSessionTopology({
    version: "0.9.5",
    protocol: 22,
    workspaces: [],
    tabs: [],
    panes: [{ pane_id: "w1:p1", terminal_id: "t-7", workspace_id: "w1", tab_id: "w1:t1", focused: false, ...(agent === null ? {} : { agent }), agent_status: status, revision: 1 }],
    layouts: [],
    agents: agent === null ? [] : [{ pane_id: "w1:p1", agent, agent_status: status, agent_session: { source: `herdr:${agent}`, agent, kind: "id", value: "s-1" } }],
  });
  return { id: "mac-mini", name: "Mac mini", state: "connected", topology, run: { connection: 3, arrivals: { "w1:p1": 2 } } } as unknown as HostView;
}

const row = (kind: string, isAgent = true) => ({ paneID: "w1:p1", name: "Notes", workspaceLabel: "notes", kind, isAgent, status: "idle" }) as unknown as SidebarRow;

type Node = { type: unknown; props: Record<string, unknown> };
interface Item {
  readonly label: string;
  readonly ticked: boolean;
  readonly icon?: string;
  readonly description?: string;
  readonly group?: string;
  readonly disabledReason?: string;
  readonly pick: unknown;
}

function chips(host: HostView, pane: SidebarRow) {
  const ui = new HookHost(AgentChips as (props: object) => unknown, { host, row: pane });
  ui.render();
  const all = (): Node[] => elements(ui.tree) as Node[];
  const button = (name: string) => all().find((e) => e.props["className"] === "pick-b" && String(e.props["aria-label"]).startsWith(`${name}:`));
  const label = (name = "Permissions") => {
    const found = button(name);
    return found === undefined ? undefined : String(found.props["aria-label"]).slice(name.length + 2);
  };
  const chip = () => all().find((e) => typeof e.props["className"] === "string" && /^chip pick mode(?: |$)/.test(String(e.props["className"])));
  const icon = () => all().find((e) => typeof e.props["data-mode-icon"] === "string")?.props["data-mode-icon"];
  const menu = () => all().find((e) => Array.isArray(e.props["items"])) as Node | undefined;
  const items = () => menu()!.props["items"] as Item[];
  const open = () => (button("Permissions")!.props["onClick"] as () => void)();
  const pick = (label: string) => {
    const item = items().find((candidate) => candidate.label === label)!;
    (menu()!.props["onPick"] as (pick: unknown) => void)(item.pick);
  };
  return { ui, button, label, chip, icon, menu, items, open, pick };
}

describe("the Permissions chip", () => {
  it("sits after Model and Effort in a Claude pane's row; Permissions with no word until the screen names a mode", () => {
    const c = chips(hostWith("claude"), row("claude"));
    expect(c.label()).toBe("Permissions");
    expect(c.icon()).toBe("unknown");
    const labels = elements(c.ui.tree)
      .map((e) => (e as Node).props["aria-label"])
      .filter((label): label is string => typeof label === "string")
      .map((label) => label.split(":")[0]);
    expect(labels).toEqual(["Model", "Effort", "Permissions"]);
    agentPicks.receiveMode(key, { scope, run, agent: "claude", mode: "plan" });
    c.ui.render();
    expect(c.label()).toBe("Plan");
    expect(c.icon()).toBe("plan");
    agentPicks.receiveMode(key, { scope, run, agent: "claude", mode: "manual" });
    c.ui.render();
    expect([c.label(), c.icon()]).toEqual(["Manual", "lock"]);
  });

  it("a screen read under another terminal, session or run is not the pane's", () => {
    agentPicks.receiveMode(key, { scope: { terminalID: "t-8", session: "s-1" }, run, agent: "claude", mode: "plan" });
    expect(chips(hostWith("claude"), row("claude")).label()).toBe("Permissions");
    agentPicks.receiveMode(key, { scope, run: { connection: 4, arrival: 2 }, agent: "claude", mode: "plan" });
    expect(chips(hostWith("claude"), row("claude")).label()).toBe("Permissions");
    agentPicks.receiveMode(key, { scope, run, agent: "grok", mode: "plan" });
    expect(chips(hostWith("claude"), row("claude")).label()).toBe("Permissions");
  });

  it("Codex: the rollout's mode; none before its first turn", () => {
    const c = chips(hostWith("codex"), row("codex"));
    expect(c.label()).toBe("Permissions");
    agentPicks.receive(key, { model: "gpt-6.1-sol", modelLabel: "GPT-6.1-Sol", effort: "xhigh", mode: "approve", modeAt: 100, scope }, null);
    c.ui.render();
    expect([c.label(), c.icon()]).toEqual(["Approve for me", "sparkles"]);
    agentPicks.receive(key, { model: "gpt-6.1-sol", modelLabel: "GPT-6.1-Sol", effort: "xhigh", mode: "full", modeAt: 400, scope }, null);
    c.ui.render();
    expect([c.label(), c.icon()]).toEqual(["Full Access", "shieldOff"]);
    agentPicks.receive(key, { model: "gpt-6.1-sol", modelLabel: "GPT-6.1-Sol", effort: "xhigh", mode: null, modeAt: 900, scope }, null);
    c.ui.render();
    expect(c.label()).toBe("Permissions");
  });

  it("Grok: the border's word, Supervised for none; shown even before its files name a model", () => {
    const c = chips(hostWith("grok"), row("grok"));
    // The Model chip says the agent's default until its files name one; no Effort chip yet.
    expect(c.label("Model")).toBe("Default");
    expect(c.label("Effort")).toBeUndefined();
    expect(c.label()).toBe("Permissions");
    agentPicks.receiveMode(key, { scope, run, agent: "grok", mode: "default" });
    c.ui.render();
    expect([c.label(), c.icon()]).toEqual(["Supervised", "lock"]);
    agentPicks.receiveMode(key, { scope, run, agent: "grok", mode: "alwaysApprove" });
    c.ui.render();
    expect([c.label(), c.icon()]).toEqual(["Always-approve", "shieldOff"]);
  });

  it("Cursor: its footer's right side, Supervised for none; Permissions while no footer reads", () => {
    const c = chips(hostWith("cursor"), row("cursor"));
    // The Model chip says the agent's default until its footer reads; no Effort chip yet.
    expect(c.label("Model")).toBe("Default");
    expect(c.label("Effort")).toBeUndefined();
    expect(c.label()).toBe("Permissions");
    agentPicks.receiveFooter(key, { scope, run, footer: parseCursorFooter(modeScreen("cursor-10-run-everything-from-default")) });
    c.ui.render();
    expect([c.label("Model"), c.label(), c.icon()]).toEqual(["Grok 4.7", "Run Everything", "shieldOff"]);
    agentPicks.receiveFooter(key, { scope, run, footer: parseCursorFooter(modeScreen("cursor-12-restored-default")) });
    c.ui.render();
    expect([c.label(), c.icon()]).toEqual(["Supervised", "lock"]);
  });

  it("no chip for another agent or a shell", () => {
    expect(chips(hostWith("opencode"), row("opencode")).label()).toBeUndefined();
    expect(chips(hostWith(null), row("zsh", false)).label()).toBeUndefined();
  });
});

describe("the Permissions menu", () => {
  it("lists the agent's own modes with their descriptions and icons, the current one ticked, under Permissions", () => {
    agentPicks.receive(key, { model: "gpt-6.1-sol", modelLabel: "GPT-6.1-Sol", effort: "xhigh", mode: "approve", modeAt: 100, scope }, null);
    const c = chips(hostWith("codex"), row("codex"));
    c.open();
    expect(c.items().map((item) => [item.label, item.ticked, item.icon])).toEqual([
      ["Ask for approval", false, "lock"],
      ["Approve for me", true, "sparkles"],
      ["Full Access", false, "shieldOff"],
      ["Read Only", false, "lock"],
    ]);
    expect(c.items()[0]!.group).toBe("Permissions");
    expect(c.items()[2]!.description).toBe("Use with caution: Codex can edit files outside this workspace and access the internet without approval");
    expect(c.items().every((item) => item.disabledReason === undefined)).toBe(true);
  });

  it("each agent's words in its order", () => {
    const labels = (agent: string) => {
      agentPicks.clear();
      const c = chips(hostWith(agent), row(agent));
      c.open();
      return c.items().map((item) => item.label);
    };
    expect(labels("claude")).toEqual(["Manual", "Accept edits", "Plan", "Auto"]);
    expect(labels("grok")).toEqual(["Supervised", "Plan", "Auto-review", "Always-approve"]);
    expect(labels("cursor")).toEqual(["Supervised", "Auto-review", "Run Everything"]);
  });

  it("Claude's bypass shows ticked and greyed while it is on, never as a choice", () => {
    agentPicks.receiveMode(key, { scope, run, agent: "claude", mode: "bypass" });
    const c = chips(hostWith("claude"), row("claude"));
    expect([c.label(), c.icon()]).toEqual(["Bypass permissions", "shieldOff"]);
    c.open();
    const bypass = c.items().find((item) => item.label === "Bypass permissions")!;
    expect(bypass.ticked).toBe(true);
    expect(bypass.disabledReason).toBeDefined();
    expect(c.items().filter((item) => item.ticked)).toHaveLength(1);
  });

  it("while bypass is on the menu offers no other choice: every mode greyed, a pick sends nothing", () => {
    agentPicks.receiveMode(key, { scope, run, agent: "claude", mode: "bypass" });
    const c = chips(hostWith("claude"), row("claude"));
    c.open();
    const others = c.items().filter((item) => item.label !== "Bypass permissions");
    expect(others.map((item) => item.label)).toEqual(["Manual", "Accept edits", "Plan", "Auto"]);
    expect(others.every((item) => item.disabledReason !== undefined && !item.ticked)).toBe(true);
    // A pick that reaches the menu anyway (an old window's): refused, nothing goes to main.
    agentPicks.pick(pickContext(hostWith("claude"), "w1:p1")!, { kind: "mode", value: "manual", label: "Manual" });
    expect(calls).toEqual([]);
    expect(agentPicks.note(key)).toBe(bypassStartNote);
  });

  it("opening it types nothing; a pick goes to main bound to the pane, at its prompt only", async () => {
    agentPicks.receiveMode(key, { scope, run, agent: "claude", mode: "auto" });
    const c = chips(hostWith("claude"), row("claude"));
    c.open();
    c.ui.render();
    expect(calls).toEqual([]);
    expect(sends).toEqual([]);
    c.pick("Plan");
    expect(calls).toEqual([
      { paneId: "w1:p1", agent: "claude", target: "plan", binding: { terminalID: "t-7", isAgent: true, kind: "claude", session: "s-1", run, atPromptOnly: true } },
    ]);
    expect(sends).toEqual([]);
    await Promise.resolve();
    await Promise.resolve();
    c.ui.render();
    expect(c.label()).toBe("Plan");
  });

  it("the current mode again sends nothing", () => {
    agentPicks.receiveMode(key, { scope, run, agent: "claude", mode: "auto" });
    const c = chips(hostWith("claude"), row("claude"));
    c.open();
    c.pick("Auto");
    expect(calls).toEqual([]);
  });

  it("after a pick the chip shows the mode the screen showed, and a refusal its note", async () => {
    agentPicks.receiveMode(key, { scope, run, agent: "grok", mode: "default" });
    answer = async () => ({ type: "refused", note: "Not set: Grok's screen changed during the switch.", mode: "autoReview" });
    const c = chips(hostWith("grok"), row("grok"));
    c.open();
    c.pick("Always-approve");
    c.ui.render();
    expect(c.label()).toBe("Always-approve");
    await Promise.resolve();
    await Promise.resolve();
    c.ui.render();
    expect(c.label()).toBe("Auto-review");
    expect(agentPicks.note(key)).toBe("Not set: Grok's screen changed during the switch.");
  });

  it("a pick stopped past a more permissive mode: the chip shows it in amber with the note", async () => {
    agentPicks.receiveMode(key, { scope, run, agent: "grok", mode: "plan" });
    const note = "Stopped at Always-approve because you typed in Terminal. It is still on; pick again.";
    answer = async () => ({ type: "refused", note, mode: "alwaysApprove", warning: true });
    const c = chips(hostWith("grok"), row("grok"));
    c.open();
    c.pick("Supervised");
    await Promise.resolve();
    await Promise.resolve();
    c.ui.render();
    expect(c.label()).toBe("Always-approve");
    expect(String(c.chip()!.props["className"])).toContain(" warn");
    expect(agentPicks.note(key)).toBe(note);
    // The screen then says otherwise (the user's own Shift+Tab): no warning.
    agentPicks.receiveMode(key, { scope, run, agent: "grok", mode: "default" });
    c.ui.render();
    expect(String(c.chip()!.props["className"])).not.toContain(" warn");
  });

  it("the warning goes with the next pick", async () => {
    agentPicks.receiveMode(key, { scope, run, agent: "claude", mode: "manual" });
    answer = async () => ({ type: "refused", note: "Stopped at Accept edits because you typed in Terminal. It is still on; pick again.", mode: "acceptEdits", warning: true });
    const c = chips(hostWith("claude"), row("claude"));
    c.open();
    c.pick("Plan");
    await Promise.resolve();
    await Promise.resolve();
    c.ui.render();
    expect(String(c.chip()!.props["className"])).toContain(" warn");
    answer = async (call) => ({ type: "set", mode: call.target });
    agentPicks.pick(pickContext(hostWith("claude"), "w1:p1")!, { kind: "mode", value: "manual", label: "Manual" });
    c.ui.render();
    expect(String(c.chip()!.props["className"])).not.toContain(" warn");
  });

  it("the warning shows first after the pick's own result; the next readable screen retires it, the same mode too", async () => {
    agentPicks.receiveMode(key, { scope, run, agent: "grok", mode: "plan" });
    const note = "Stopped at Always-approve because you typed in Terminal. It is still on; pick again.";
    // Main sends the pick's last screen to the page before its answer (ipc.ts: notePick, then the result).
    answer = async () => {
      agentPicks.receiveMode(key, { scope, run, agent: "grok", mode: "alwaysApprove" });
      return { type: "refused", note, mode: "alwaysApprove", warning: true };
    };
    const c = chips(hostWith("grok"), row("grok"));
    c.open();
    c.pick("Supervised");
    await Promise.resolve();
    await Promise.resolve();
    c.ui.render();
    expect(c.label()).toBe("Always-approve");
    expect(String(c.chip()!.props["className"])).toContain(" warn");
    // The next screen read (the Chat shown again, a turn's end) shows the same mode: no warning from then on.
    agentPicks.receiveMode(key, { scope, run, agent: "grok", mode: "alwaysApprove" });
    c.ui.render();
    expect(c.label()).toBe("Always-approve");
    expect(String(c.chip()!.props["className"])).not.toContain(" warn");
  });

  it("the user's Terminal changes away and back never bring an old pick's warning back", async () => {
    agentPicks.receiveMode(key, { scope, run, agent: "grok", mode: "plan" });
    answer = async () => ({ type: "refused", note: "Stopped at Always-approve because you typed in Terminal. It is still on; pick again.", mode: "alwaysApprove", warning: true });
    const c = chips(hostWith("grok"), row("grok"));
    c.open();
    c.pick("Supervised");
    await Promise.resolve();
    await Promise.resolve();
    c.ui.render();
    expect(String(c.chip()!.props["className"])).toContain(" warn");
    agentPicks.receiveMode(key, { scope, run, agent: "grok", mode: "default" });
    c.ui.render();
    expect(c.label()).toBe("Supervised");
    expect(String(c.chip()!.props["className"])).not.toContain(" warn");
    agentPicks.receiveMode(key, { scope, run, agent: "grok", mode: "alwaysApprove" });
    c.ui.render();
    expect(c.label()).toBe("Always-approve");
    expect(String(c.chip()!.props["className"])).not.toContain(" warn");
  });

  it("an unknown result clears the word: Permissions, never the mode before the pick", async () => {
    agentPicks.receiveMode(key, { scope, run, agent: "grok", mode: "default" });
    answer = async () => ({ type: "refused", note: "Not set: Grok's mode did not change as expected, so nothing more was pressed. Check its terminal.", mode: null, unknown: true });
    const c = chips(hostWith("grok"), row("grok"));
    c.open();
    c.pick("Plan");
    await Promise.resolve();
    await Promise.resolve();
    c.ui.render();
    expect(c.label()).toBe("Permissions");
  });

  it("Codex: an unknown result shows Permissions until a newer turn", async () => {
    agentPicks.receive(key, { model: "gpt-6.1-sol", modelLabel: "GPT-6.1-Sol", effort: "xhigh", mode: "approve", modeAt: 100, scope }, null);
    answer = async () => ({ type: "refused", note: "Not set: Codex did not show the change.", mode: null, unknown: true });
    const c = chips(hostWith("codex"), row("codex"));
    c.open();
    c.pick("Ask for approval");
    await Promise.resolve();
    await Promise.resolve();
    c.ui.render();
    expect(c.label()).toBe("Permissions");
    agentPicks.receive(key, { model: "gpt-6.1-sol", modelLabel: "GPT-6.1-Sol", effort: "xhigh", mode: "approve", modeAt: 100, scope }, null);
    c.ui.render();
    expect(c.label()).toBe("Permissions");
    agentPicks.receive(key, { model: "gpt-6.1-sol", modelLabel: "GPT-6.1-Sol", effort: "xhigh", mode: "approve", modeAt: 900, scope }, null);
    c.ui.render();
    expect(c.label()).toBe("Approve for me");
  });

  it("Cursor's pick settles on the footer main read at its end", async () => {
    agentPicks.receiveFooter(key, { scope, run, footer: parseCursorFooter(modeScreen("cursor-12-restored-default")) });
    answer = async () => ({ type: "set", mode: "autoReview", footer: parseCursorFooter(modeScreen("cursor-07-auto-review-on")) });
    const c = chips(hostWith("cursor"), row("cursor"));
    c.open();
    c.pick("Auto-review");
    await Promise.resolve();
    await Promise.resolve();
    c.ui.render();
    expect(c.label()).toBe("Auto-review");
    expect(calls.map((call) => [call.agent, call.target])).toEqual([["cursor", "autoReview"]]);
  });

  it("while the pane works: held for the next turn, sent once it is back", async () => {
    agentPicks.receiveMode(key, { scope, run, agent: "claude", mode: "auto" });
    const c = chips(hostWith("claude", "working"), row("claude"));
    c.open();
    c.pick("Accept edits");
    c.ui.render();
    expect(calls).toEqual([]);
    expect(c.label()).toBe("Accept edits (next turn)");
    agentPicks.syncHosts([hostWith("claude", "idle")]);
    agentPicks.syncHosts([hostWith("claude", "idle")]);
    expect(calls.map((call) => call.target)).toEqual(["acceptEdits"]);
  });

  it("main finding the pane busy holds it again", async () => {
    agentPicks.receiveMode(key, { scope, run, agent: "claude", mode: "auto" });
    answer = async () => ({ type: "busy" });
    const c = chips(hostWith("claude"), row("claude"));
    c.open();
    c.pick("Manual");
    await Promise.resolve();
    await Promise.resolve();
    c.ui.render();
    expect(c.label()).toBe("Manual (next turn)");
  });

  it("Codex: the pick's mode, as its screen showed it, until a newer turn says otherwise", async () => {
    agentPicks.receive(key, { model: "gpt-6.1-sol", modelLabel: "GPT-6.1-Sol", effort: "xhigh", mode: "approve", modeAt: 100, scope }, null);
    const c = chips(hostWith("codex"), row("codex"));
    c.open();
    c.pick("Read Only");
    await Promise.resolve();
    await Promise.resolve();
    c.ui.render();
    expect(c.label()).toBe("Read Only");
    // The same turn read again (or an older one): still the pick, with no deadline.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 5 * 60_000);
    agentPicks.receive(key, { model: "gpt-6.1-sol", modelLabel: "GPT-6.1-Sol", effort: "xhigh", mode: "approve", modeAt: 100, scope }, null);
    agentPicks.sync(key, pickContext(hostWith("codex"), "w1:p1"));
    c.ui.render();
    expect(c.label()).toBe("Read Only");
    vi.useRealTimers();
    // A newer turn: its mode.
    agentPicks.receive(key, { model: "gpt-6.1-sol", modelLabel: "GPT-6.1-Sol", effort: "xhigh", mode: "ask", modeAt: 700, scope }, null);
    c.ui.render();
    expect(c.label()).toBe("Ask for approval");
  });

  it("a window with no switch says so", () => {
    vi.stubGlobal("window", { herdrDesktop: { sendToPane: async () => undefined, copyText: () => undefined } });
    agentPicks.receiveMode(key, { scope, run, agent: "claude", mode: "auto" });
    const c = chips(hostWith("claude"), row("claude"));
    c.open();
    c.pick("Plan");
    expect(agentPicks.note(key)).toMatch(/^Not set: /);
  });
});

// MARK: - main's reads of the mode

const { LiveReads } = await import("../src/main/chat/live-reads");
const { HostRegistry } = await import("../src/main/hosts");
const { PaneReadGate } = await import("../src/shared/chat/live-reader");
const { backend, FakeHerdr, snapshot } = await import("./support/prompt-herdr");
type ShownChat = import("../src/main/chat/service").ShownChat;
type ChatOwner = import("../src/main/chat/service").ChatOwner;
type ModeEvent = import("../src/shared/ipc-contract").PaneModeEvent;

/** The fake Herdr with each pane's screen as the test sets it. */
class ScreenHerdr extends FakeHerdr {
  shownScreens: Record<string, string> = {};

  override roundTrip(line: string): Promise<string> {
    const request = JSON.parse(line) as { id: unknown; method: string; params: Record<string, unknown> };
    const paneId = String(request.params["pane_id"]);
    if (request.method !== "pane.read" || this.shownScreens[paneId] === undefined) return super.roundTrip(line);
    this.requests.push(line);
    const read = { pane_id: paneId, workspace_id: "w1", tab_id: "w1:t1", source: "recent", format: "text", text: this.shownScreens[paneId], revision: 1, truncated: false };
    return Promise.resolve(JSON.stringify({ id: request.id, result: { type: "pane_read", read } }));
  }
}

async function modeSetup() {
  const json = snapshot();
  const panes = json["panes"] as Record<string, unknown>[];
  const agents = json["agents"] as Record<string, unknown>[];
  panes[0]!["agent_status"] = "idle";
  agents[0]!["agent_status"] = "idle";
  panes[2]!["agent"] = "grok";
  panes[2]!["agent_status"] = "idle";
  const herdr = new ScreenHerdr(json, {});
  herdr.shownScreens = { "w1:p1": modeScreen("claude-03-shift-tab"), "w1:p3": modeScreen("grok-auto-review") };
  const registry = new HostRegistry(() => undefined);
  registry.add({ id: "mac", name: "Mac mini", kind: "demo", address: "demo", platform: "macOS" }, backend(herdr, { value: 1 }));
  await registry.refreshAll();
  const events: ModeEvent[] = [];
  let chats: ShownChat[] = [];
  const owner: ChatOwner = { id: 1, send: () => undefined, isDestroyed: () => false };
  const live = new LiveReads(registry, () => chats, () => undefined, { gate: new PaneReadGate(), mode: (_chat, event) => events.push(event) });
  const show = (...ids: string[]): void => {
    chats = ids.map((paneId) => ({ owner, slot: paneId, follow: 1, hostId: "mac", paneId }));
    live.sync();
  };
  const snapshotNow = async (): Promise<void> => {
    await registry.refreshAll();
    live.sync();
  };
  const reads = (paneId: string): unknown[] => herdr.sent("pane.read").filter((params) => params["pane_id"] === paneId);
  return { herdr, live, show, snapshotNow, events, reads };
}

describe("main reads a shown Claude or Grok Chat's mode off its screen", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("once when the Chat shows, never on a timer while idle; a Codex pane's is not read", async () => {
    const { live, show, events, reads } = await modeSetup();
    show("w1:p1", "w1:p3", "w1:p2");
    await vi.advanceTimersByTimeAsync(0);
    expect(reads("w1:p1")).toHaveLength(1);
    expect(reads("w1:p3")).toHaveLength(1);
    const claude = events.filter((event) => event.paneId === "w1:p1");
    expect(claude).toEqual([
      { hostId: "mac", paneId: "w1:p1", agent: "claude", scope: { terminalID: "term-1", session: "s-1" }, run: expect.any(Object), mode: null },
      { hostId: "mac", paneId: "w1:p1", agent: "claude", scope: { terminalID: "term-1", session: "s-1" }, run: expect.any(Object), mode: "plan" },
    ]);
    expect(events.filter((event) => event.paneId === "w1:p3").map((event) => [event.agent, event.mode])).toEqual([
      ["grok", null],
      ["grok", "autoReview"],
    ]);
    expect(events.some((event) => event.paneId === "w1:p2")).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reads("w1:p1")).toHaveLength(1);
    live.closeAll();
  });

  it("again when the turn ends", async () => {
    const { herdr, live, show, snapshotNow, events, reads } = await modeSetup();
    show("w1:p3");
    await vi.advanceTimersByTimeAsync(0);
    herdr.paneEntry("w1:p3")["agent_status"] = "working";
    await snapshotNow();
    herdr.paneEntry("w1:p3")["agent_status"] = "done";
    herdr.shownScreens["w1:p3"] = modeScreen("grok-plan");
    await snapshotNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(reads("w1:p3")).toHaveLength(2);
    expect(events.map((event) => event.mode)).toEqual([null, "autoReview", "plan"]);
    live.closeAll();
  });

  it("a screen read for a pick goes to the Chat too", async () => {
    const { live, show, events } = await modeSetup();
    show("w1:p1");
    await vi.advanceTimersByTimeAsync(0);
    live.noteScreen("mac", "w1:p1", modeScreen("claude-02-shift-tab"));
    expect(events.map((event) => event.mode)).toEqual([null, "plan", "acceptEdits"]);
    live.closeAll();
  });

  it("after a pick the next read goes to the Chat even when it shows the same mode: it retires the pick's warning", async () => {
    const { herdr, live, show, snapshotNow, events, reads } = await modeSetup();
    show("w1:p3");
    await vi.advanceTimersByTimeAsync(0);
    // The pick's last screen: Always-approve, a change, so it goes.
    live.notePick("mac", "w1:p3", modeScreen("grok-always-approve"));
    expect(events.map((event) => event.mode)).toEqual([null, "autoReview", "alwaysApprove"]);
    // A turn that ends on the same mode: its read goes too.
    herdr.shownScreens["w1:p3"] = modeScreen("grok-always-approve");
    herdr.paneEntry("w1:p3")["agent_status"] = "working";
    await snapshotNow();
    herdr.paneEntry("w1:p3")["agent_status"] = "done";
    await snapshotNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(reads("w1:p3")).toHaveLength(2);
    expect(events.map((event) => event.mode)).toEqual([null, "autoReview", "alwaysApprove", "alwaysApprove"]);
    // Only the first: the turn after that, the same mode again, goes nowhere.
    herdr.paneEntry("w1:p3")["agent_status"] = "working";
    await snapshotNow();
    herdr.paneEntry("w1:p3")["agent_status"] = "done";
    await snapshotNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(reads("w1:p3")).toHaveLength(3);
    expect(events).toHaveLength(4);
    live.closeAll();
  });

  it("a read with no mode (a dialog, an unknown footer) keeps the last mode: Auto throughout; a new identity starts with nothing", async () => {
    const { herdr, live, show, snapshotNow, events } = await modeSetup();
    herdr.shownScreens["w1:p1"] = modeScreen("claude-00-start");
    const chipKey = "mac/w1:p1";
    const binding = (terminalID: string) => ({ terminalID, isAgent: true, kind: "claude", session: "s-1" });
    const chip = (terminalID = "term-1"): string => {
      for (const event of events.splice(0)) agentPicks.receiveMode(chipKey, event);
      return agentPicks.modeChip(chipKey, binding(terminalID), "claude").label;
    };
    const sent: (string | null)[] = [];
    const seen = (): (string | null)[] => (sent.push(...events.map((event) => event.mode)), sent);
    show("w1:p1");
    await vi.advanceTimersByTimeAsync(0);
    expect(seen()).toEqual([null, "auto"]);
    expect(chip()).toBe("Auto");
    // A dialog over the box: no box, no mode row.
    const dialog = "\u{256D}\u{2500}\u{2500} Do you want to proceed? \u{2500}\u{2500}\u{256E}\n\u{2502} \u{276F} 1. Yes \u{2502}\n\u{2502}   2. No  \u{2502}\n\u{2570}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{256F}\n";
    live.noteScreen("mac", "w1:p1", dialog);
    expect(seen()).toEqual([null, "auto"]);
    expect(chip()).toBe("Auto");
    // An unknown footer: the box, but no row that reads.
    live.noteScreen("mac", "w1:p1", modeScreen("claude-00-start").replace("  \u{23F5}\u{23F5} auto mode on (shift+tab to cycle)", "  \u{23F5}\u{23F5} something new on \u{00B7} 1 shell"));
    expect(seen()).toEqual([null, "auto"]);
    expect(chip()).toBe("Auto");
    // A turn's end on the same unknown screen: still Auto.
    herdr.shownScreens["w1:p1"] = dialog;
    herdr.paneEntry("w1:p1")["agent_status"] = "working";
    await snapshotNow();
    herdr.paneEntry("w1:p1")["agent_status"] = "done";
    await snapshotNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(seen()).toEqual([null, "auto"]);
    expect(chip()).toBe("Auto");
    // Auto again: nothing new to send; another mode does change it.
    live.noteScreen("mac", "w1:p1", modeScreen("claude-00-start"));
    expect(seen()).toEqual([null, "auto"]);
    expect(chip()).toBe("Auto");
    live.noteScreen("mac", "w1:p1", modeScreen("claude-03-shift-tab"));
    expect(seen()).toEqual([null, "auto", "plan"]);
    expect(chip()).toBe("Plan");
    // A new identity (another terminal) starts with nothing; its screen with no mode keeps it so.
    herdr.paneEntry("w1:p1")["terminal_id"] = "term-9";
    await snapshotNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(seen()).toEqual([null, "auto", "plan", null]);
    expect(chip("term-9")).toBe("Permissions");
    live.closeAll();
  });

  it("a pick that read no screen: the next read still goes", async () => {
    const { herdr, live, show, snapshotNow, events } = await modeSetup();
    show("w1:p3");
    await vi.advanceTimersByTimeAsync(0);
    live.notePick("mac", "w1:p3", null);
    expect(events.map((event) => event.mode)).toEqual([null, "autoReview"]);
    herdr.paneEntry("w1:p3")["agent_status"] = "working";
    await snapshotNow();
    herdr.paneEntry("w1:p3")["agent_status"] = "done";
    await snapshotNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(events.map((event) => event.mode)).toEqual([null, "autoReview", "autoReview"]);
    live.closeAll();
  });
});

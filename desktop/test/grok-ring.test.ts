// Grok's context ring (parity with the iPhone app's CompanionGrokContextRing): Adari shows a Grok pane's
// context ring from the signals.json beside its session
// (`contextTokensUsed` of `contextWindowTokens`), as the app does; no ring
// without both numbers, and no Compact on its card.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { AgentSettingsReader, parseGrokSignals, tapReader } from "../src/shared/agent-settings";
import { contextView } from "../src/shared/context-meter";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  return { ...actual, ...fakeReact, default: { ...actual, ...fakeReact } };
});

const { decodeSessionTopology } = await import("../src/main/herdr/wire");
const { HookHost, elements } = await import("./support/fake-hooks");
const { ContextRing } = await import("../src/renderer/components/ContextRing");
const { agentPicks } = await import("../src/renderer/components/agent-picks");
type HostView = import("../src/shared/ipc-contract").HostView;
type SidebarRow = import("../src/shared/sidebar-model").SidebarRow;
type Node = { type: unknown; props: Record<string, unknown> };

function grokHost(): HostView {
  const topology = decodeSessionTopology({
    version: "0.9.5",
    protocol: 22,
    workspaces: [],
    tabs: [],
    panes: [{ pane_id: "w1:p1", terminal_id: "t-7", workspace_id: "w1", tab_id: "w1:t1", focused: false, agent: "grok", agent_status: "idle", revision: 1 }],
    layouts: [],
    agents: [{ pane_id: "w1:p1", agent: "grok", agent_status: "idle" }],
  });
  return { id: "mac-mini", name: "Mac mini", state: "connected", topology, run: { connection: 3, arrivals: { "w1:p1": 2 } } } as unknown as HostView;
}

const row = { paneID: "w1:p1", name: "tidepool", workspaceLabel: "notes", kind: "grok", isAgent: true, status: "idle" } as unknown as SidebarRow;
const key = "mac-mini/w1:p1";
const scope = { terminalID: "t-7", session: null };

function ring() {
  const ui = new HookHost(ContextRing as (props: object) => unknown, { host: grokHost(), row });
  ui.render();
  const all = (): Node[] => elements(ui.tree) as Node[];
  return { ui, all, button: () => all().find((e) => String(e.props["className"] ?? "").includes("ctx-ring ")) };
}

describe("a Grok pane's ring in Adari", () => {
  beforeEach(() => {
    agentPicks.clear();
    vi.stubGlobal("window", { herdrDesktop: { sendToPane: async () => undefined, copyText: () => undefined } });
  });

  it("signals.json's numbers: used of the window, as the app words them", () => {
    expect(parseGrokSignals('{"contextTokensUsed":61000,"contextWindowTokens":256000}')).toEqual({ used: 61_000, window: 256_000 });
    expect(parseGrokSignals('{"contextWindowTokens":256000}')).toEqual({ used: null, window: 256_000 });
    expect(parseGrokSignals('{"contextTokensUsed":-1,"contextWindowTokens":256000}')).toEqual({ used: null, window: 256_000 });
    expect(parseGrokSignals("not json")).toEqual({ used: null, window: null });
    const view = contextView({ agent: "grok", used: 61_000, window: 256_000, model: "grok-4.7", limits: null, screenRemaining: null });
    expect([view.headline, view.tooltip, view.source]).toEqual(["24% \u{B7} 61k / 256k", "61k of 256k", "Grok's signals.json (256k window)"]);
  });

  it("the session's reads fill used and window from signals.json", async () => {
    const path = "/Users/demo/.grok/sessions/x/019a/updates.jsonl";
    const files = new Map<string, string>([
      [path, '{"update":1}\n'],
      ["/Users/demo/.grok/sessions/x/019a/summary.json", '{"current_model_id":"grok-4.7","reasoning_effort":"high"}'],
      ["/Users/demo/.grok/sessions/x/019a/signals.json", '{"contextTokensUsed":61000,"contextWindowTokens":256000}'],
    ]);
    const base = {
      locate: async () => path,
      size: async (file: string) => new TextEncoder().encode(files.get(file) ?? "").length,
      read: async (file: string, offset: number, max: number) => new TextEncoder().encode(files.get(file) ?? "").slice(offset, offset + max),
    };
    const settings = new AgentSettingsReader("grok");
    const tapped = tapReader(base as never, settings, () => undefined);
    await tapped.size(path);
    await tapped.read(path, 0, 100);
    await expect.poll(() => settings.settings.used).toBe(61_000);
    expect(settings.settings.window).toBe(256_000);
  });

  it("shows with both numbers, its card without Compact; none without them", () => {
    expect(ring().button()).toBeUndefined();
    agentPicks.receive(key, { model: "grok-4.7", modelLabel: "Grok 4.7", effort: "high", used: 61_000, window: 256_000, scope }, null);
    const shown = ring();
    expect(String(shown.button()!.props["aria-label"])).toBe("Context: 61k of 256k");
    (shown.button()!.props["onClick"] as () => void)();
    shown.ui.render();
    expect(shown.all().some((e) => e.props["className"] === "ctx-card")).toBe(true);
    expect(shown.all().some((e) => String(e.props["className"] ?? "").startsWith("btn sm"))).toBe(false);
    shown.ui.unmount();
    agentPicks.receive(key, { model: "grok-4.7", modelLabel: "Grok 4.7", effort: "high", used: null, window: 256_000, scope }, null);
    expect(ring().button()).toBeUndefined();
  });
});

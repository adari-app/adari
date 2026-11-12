// `/compact` typed in Chat's box for a Claude pane while a turn runs (a monitor's event turn, background
// tasks still running). It is held as the ring's Compact is and sent when the turn ends, never typed into
// Claude's queue mid-turn (an Esc puts a queued line back in Claude's box, where Chat's next message would
// join it), never dropped silently and never refused: the box empties and its note says it is queued. At
// the prompt, for Codex, and for any other command line, the box sends at once. The bridge and Herdr are
// fakes.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SendBinding } from "../src/shared/send-binding";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  return { ...actual, ...fakeReact, default: { ...actual, ...fakeReact } };
});

const flush = async (): Promise<void> => {
  for (let i = 0; i < 40; i += 1) await Promise.resolve();
};

type Sent = [string, string, string, SendBinding];

async function composerOn(kind: "claude" | "codex", status: string) {
  const { Composer } = await import("../src/renderer/components/MainPane");
  const { composerDrafts } = await import("../src/renderer/components/composer-drafts");
  const { agentPicks } = await import("../src/renderer/components/agent-picks");
  const { commandRows } = await import("../src/renderer/chat/command-rows");
  const { decodeSessionTopology } = await import("../src/main/herdr/wire");
  const { HookHost, find, elements } = await import("./support/fake-hooks");
  composerDrafts.clear();
  agentPicks.clear();
  commandRows.clear();
  const sent: Sent[] = [];
  vi.stubGlobal("window", {
    innerHeight: 900,
    herdrDesktop: { sendToPane: async (...args: Sent) => void sent.push(args), copyText: () => undefined },
  });
  const topologyAt = (now: string) =>
    decodeSessionTopology({
      version: "0.9.5",
      protocol: 22,
      workspaces: [],
      tabs: [],
      layouts: [],
      panes: [{ pane_id: "p1", terminal_id: "t1", workspace_id: "w1", tab_id: "tab1", focused: false, agent: kind, agent_status: now, revision: 1 }],
      agents: [{ pane_id: "p1", agent: kind, agent_status: now, agent_session: { source: `herdr:${kind}`, agent: kind, kind: "id", value: "session-1" } }],
    });
  const hostAt = (now: string) => ({ id: "mac-a", name: "fake", state: "connected", topology: topologyAt(now), run: { connection: 2, arrivals: { p1: 1 } } });
  const row = { paneID: "p1", kind, isAgent: true, status, workspaceLabel: "fixture" };
  const ui = new HookHost(Composer as (props: object) => unknown, { host: hostAt(status), row });
  ui.render();
  const type = async (text: string): Promise<void> => {
    (find(ui.tree, "textarea")!.props["onChange"] as (event: unknown) => void)({ target: { value: text } });
    (find(ui.tree, "textarea")!.props["onKeyDown"] as (event: unknown) => void)({
      key: "Enter",
      shiftKey: false,
      nativeEvent: { isComposing: false },
      preventDefault: () => undefined,
    });
    await flush();
  };
  const note = (): string | null => {
    const line = elements(ui.tree).find((e) => e.props["className"] === "cmp-note-t");
    return line === undefined ? null : String(line.props["children"]);
  };
  const draft = (): string => composerDrafts.get("mac-a/p1").text;
  return { ui, sent, type, note, draft, agentPicks, commandRows, hostAt, composerDrafts };
}

let cleanup: (() => void) | null = null;
beforeEach(() => {
  cleanup = null;
});
afterEach(() => {
  cleanup?.();
  vi.unstubAllGlobals();
});

describe("typed /compact while Claude works", () => {
  it("is held, not typed into Claude mid-turn; the box empties and says it is queued; it goes when the turn ends", async () => {
    const box = await composerOn("claude", "working");
    cleanup = () => box.ui.unmount();
    await box.type("/compact");
    // Nothing went to the pane mid-turn, nothing was refused, nothing dropped.
    expect(box.sent).toEqual([]);
    expect(box.draft()).toBe("");
    expect(box.note()).toBe("Compact queued: it runs when this turn ends.");
    expect(box.agentPicks.compacting("mac-a/p1", { terminalID: "t1", isAgent: true, kind: "claude", session: "session-1", run: { connection: 2, arrival: 1 } })).toBe("held");
    // The monitor's turn ends (Herdr: done, the background tasks still running): it goes, bound as a held Compact.
    box.agentPicks.syncHosts([box.hostAt("done") as never]);
    await flush();
    expect(box.sent.map((s) => s[2])).toEqual(["/compact"]);
    expect(box.sent[0]![3]).toMatchObject({ terminalID: "t1", kind: "claude", session: "session-1", run: { connection: 2, arrival: 1 }, atPromptOnly: true, queuesWhileWorking: true });
  });

  it("keeps the user's instructions: /compact keep the plan goes as typed", async () => {
    const box = await composerOn("claude", "working");
    cleanup = () => box.ui.unmount();
    await box.type("  /compact keep the plan and the open questions ");
    expect(box.sent).toEqual([]);
    box.agentPicks.syncHosts([box.hostAt("idle") as never]);
    await flush();
    expect(box.sent.map((s) => s[2])).toEqual(["/compact keep the plan and the open questions"]);
  });
});

describe("what stays as it was", () => {
  it("at the prompt (done, background tasks running) /compact is typed at once as a command row", async () => {
    const box = await composerOn("claude", "done");
    cleanup = () => box.ui.unmount();
    await box.type("/compact");
    expect(box.sent.map((s) => s[2])).toEqual(["/compact"]);
    expect(box.sent[0]![3].atPromptOnly).toBeUndefined();
    expect(box.commandRows.forPane("mac-a/p1").map((r) => r.text)).toEqual(["/compact"]);
  });

  it("another command while Claude works, and /compact for Codex while it works, are typed at once", async () => {
    const claude = await composerOn("claude", "working");
    await claude.type("/model opus");
    expect(claude.sent.map((s) => s[2])).toEqual(["/model opus"]);
    claude.ui.unmount();
    const codex = await composerOn("codex", "working");
    cleanup = () => codex.ui.unmount();
    await codex.type("/compact");
    expect(codex.sent.map((s) => s[2])).toEqual(["/compact"]);
  });

  it("a message that only starts with /compact's letters is a message (a bubble's route), not held", async () => {
    const box = await composerOn("claude", "working");
    cleanup = () => box.ui.unmount();
    await box.type("/compactor is broken");
    expect(box.sent.map((s) => s[2])).toEqual(["/compactor is broken"]);
  });
});

// A restart that ends without resuming leaves its note on Chat's note line,
// where the user clicked, and it stays: through the 8 s every other note
// keeps, a status change and the next render, until the next send, its × or
// the next restart. (The did-not-exit note comes at about 20 s, so the 8 s
// timer alone would take it by about 28 s.) The real Composer on the hooks host.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { decodeSessionTopology, type SessionTopology } from "../src/main/herdr/wire";
import type { HostView } from "../src/shared/ipc-contract";
import type { SidebarRow } from "../src/shared/sidebar-model";
import { restartTexts } from "../src/shared/agent-restart";
import { HookHost, elements } from "./support/fake-hooks";

type Element = ReturnType<typeof elements>[number];

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  const hooks = { ...fakeReact, useLayoutEffect: fakeReact.useEffect };
  return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});

const { Composer } = await import("../src/renderer/components/MainPane");
const { composerDrafts } = await import("../src/renderer/components/composer-drafts");
const { agentRestarts, restartHeld } = await import("../src/renderer/components/restart");
const { restartHolds } = await import("../src/shared/chat/pending");

const restartKey = "mac-mini|w1:p1";

beforeEach(() => {
  vi.useFakeTimers();
  composerDrafts.clear();
  agentRestarts.dismiss(restartKey);
  vi.stubGlobal("window", {
    herdrDesktop: { sendToPane: () => Promise.resolve() },
    innerWidth: 1200,
    innerHeight: 800,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
  vi.stubGlobal("document", { body: {}, activeElement: null });
});

afterEach(() => {
  agentRestarts.dismiss(restartKey);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const flush = async (): Promise<void> => {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
};

function topologyOf(status: string): SessionTopology {
  return decodeSessionTopology({
    version: "0.9.5",
    protocol: 22,
    workspaces: [],
    tabs: [],
    panes: [{ pane_id: "w1:p1", terminal_id: "t-7", workspace_id: "w1", tab_id: "w1:t1", focused: false, agent: "codex", agent_status: status, revision: 1 }],
    layouts: [],
    agents: [
      {
        pane_id: "w1:p1",
        agent: "codex",
        agent_status: status,
        terminal_id: "t-7",
        state_change_seq: 12,
        agent_session: { source: "herdr:codex", agent: "codex", kind: "id", value: "01a1c609-0000-4000-8000-000000000000" },
      },
    ],
  });
}

const hostOf = (status: string): HostView =>
  ({ id: "mac-mini", name: "Mac mini", state: "connected", topology: topologyOf(status), connection: 3, incarnation: 1, epoch: 7 }) as HostView;
const rowOf = (status: string): SidebarRow =>
  ({ paneID: "w1:p1", name: "codex 1", workspaceLabel: "hello-app", isAgent: true, kind: "codex", status, glyph: "idle" }) as SidebarRow;

const textOf = (node: unknown): string => {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (typeof node === "object" && node !== null && "props" in node) return textOf((node as Element).props["children"]);
  return "";
};

function box(status = "done") {
  const props = { host: hostOf(status), row: rowOf(status), floating: true, stops: true };
  const ui = new HookHost(Composer as (p: object) => unknown, props);
  ui.render();
  const all = () => elements(ui.tree);
  const byClass = (name: string) => all().find((e) => String(e.props["className"] ?? "").split(" ").includes(name));
  return {
    ui,
    noteText: () => {
      const n = byClass("cmp-note");
      return n === undefined ? null : textOf(n.props["children"]);
    },
    dismiss: () => (all().find((e) => e.type === "button" && e.props["aria-label"] === "Dismiss")!.props["onClick"] as () => void)(),
    type: (value: string) => (all().find((e) => e.type === "textarea")!.props["onChange"] as (e: unknown) => void)({ target: { value } }),
    send: () => (all().find((e) => e.type === "button" && e.props["aria-label"] === "Send")!.props["onClick"] as () => void)(),
    show: (next: string) => ui.render({ ...props, host: hostOf(next), row: rowOf(next) }),
  };
}

/** The user's Restart on the page (useRestart's run: restartHeld), ending with the main process's `note`. */
async function restartEnding(c: ReturnType<typeof box>, note: string | null): Promise<void> {
  let end: (value: string | null) => void = () => undefined;
  restartHeld(agentRestarts, restartHolds, hostOf("done"), "w1:p1", "Codex", () => new Promise((resolve) => (end = resolve)));
  c.ui.render();
  expect(c.noteText()).toBe("Restarting Codex…");
  // The main process waits up to 20 s for the exit; the "Restarting" note stays meanwhile.
  vi.advanceTimersByTime(20_000);
  c.ui.render();
  expect(c.noteText()).toBe("Restarting Codex…");
  end(note);
  await flush();
  c.ui.render();
}

describe("a failed restart's note stays where the user clicked", () => {
  it("did not exit: visible on the page, still there after 8 s, 40 s and the next render", async () => {
    const c = box();
    await restartEnding(c, restartTexts.didNotExit("Codex"));
    expect(c.noteText()).toBe("Not restarted: Codex did not exit");
    vi.advanceTimersByTime(8_100);
    c.ui.render();
    expect(c.noteText()).toBe("Not restarted: Codex did not exit");
    vi.advanceTimersByTime(40_000);
    c.ui.render();
    c.ui.render();
    expect(c.noteText()).toBe("Not restarted: Codex did not exit");
    expect(agentRestarts.state(restartKey)).toEqual({ busy: false, note: "Not restarted: Codex did not exit" });
    c.ui.unmount();
  });

  it("the note naming /exit still typed stays the same way", async () => {
    const c = box();
    await restartEnding(c, restartTexts.exitTyped("Codex"));
    vi.advanceTimersByTime(30_000);
    c.ui.render();
    expect(c.noteText()).toBe("Not restarted: Codex did not exit. /exit is still typed in its terminal.");
    c.ui.unmount();
  });

  it("a status change leaves it", async () => {
    const c = box();
    await restartEnding(c, restartTexts.didNotExit("Codex"));
    c.show("idle");
    c.ui.render();
    expect(c.noteText()).toBe("Not restarted: Codex did not exit");
    c.ui.unmount();
  });

  it("the next send clears it", async () => {
    const c = box();
    await restartEnding(c, restartTexts.didNotExit("Codex"));
    c.type("go on");
    c.ui.render();
    c.send();
    c.ui.render();
    expect(c.noteText()).toBeNull();
    c.ui.unmount();
  });

  it("its × clears it", async () => {
    const c = box();
    await restartEnding(c, restartTexts.didNotExit("Codex"));
    c.dismiss();
    c.ui.render();
    expect(c.noteText()).toBeNull();
    c.ui.unmount();
  });

  it("the next restart replaces it with its own Restarting note", async () => {
    const c = box();
    await restartEnding(c, restartTexts.didNotExit("Codex"));
    let end: (value: string | null) => void = () => undefined;
    restartHeld(agentRestarts, restartHolds, hostOf("done"), "w1:p1", "Codex", () => new Promise((resolve) => (end = resolve)));
    c.ui.render();
    expect(c.noteText()).toBe("Restarting Codex…");
    end(null);
    await flush();
    c.ui.unmount();
  });

  it("a restart that resumed leaves no note", async () => {
    const c = box();
    await restartEnding(c, null);
    expect(c.noteText()).toBeNull();
    c.ui.unmount();
  });
});

// The four-pane limit holds on fresh state: a tile's split and New agent's Where go through one guarded
// split, one at a time per machine and tab; right before pane.split the
// target and its tab's pane count are read fresh (a snapshot asked after the
// request began, and the tab's layout), a split is refused when that state is
// unavailable, and the slot is held through the new pane's creation (and its
// agent's start) and the refresh. Herdr here is LiveHerdr, whose state changes
// behind the app's cached snapshot. (The cases cover a stale cache with four
// live panes, two overlapping splits on three, and Where with no topology.)

import { beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({ handles: new Map<string, (...args: unknown[]) => unknown>() }));
vi.mock("electron", () => ({
  ipcMain: { handle: (channel: string, run: (...args: unknown[]) => unknown) => electron.handles.set(channel, run), on: () => undefined },
  protocol: {},
}));

import { HostRegistry } from "../src/main/hosts";
import { LayoutService, type LayoutOwner } from "../src/main/layouts";
import { runPaneAction } from "../src/main/pane-actions";
import { APP_ORIGIN } from "../src/main/protocol";
import { IPC, type LayoutUpdateEvent } from "../src/shared/ipc-contract";
import { paneBindingOf, type PaneBinding } from "../src/shared/pane-binding";
import type { PaneLayout } from "../src/shared/pane-layout";
import { eventually } from "./support/chat-lines";
import { LiveHerdr } from "./support/live-herdr";

const { registerIpc } = await import("../src/main/ipc");

const descriptor = { id: "mini", name: "Mac mini", kind: "ssh" as const, address: "fixture", platform: null };

function deferred(): { promise: Promise<void>; open: () => void } {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

/**
 * One machine over LiveHerdr, its snapshot taken once (the cache), a window
 * showing the tab (LayoutService), the main process's IPC registered over it.
 * Each request is bound to the pane as that window shows it.
 */
async function machine(panes: readonly string[] = ["w1:p1", "w1:p2", "w1:p3"], answering = true) {
  const live = new LiveHerdr();
  live.addTab("w1:t1", panes);
  live.offline = !answering;
  const registry = new HostRegistry(() => undefined);
  registry.add(descriptor, live.backend());
  await registry.refreshAll();
  const service = new LayoutService(registry, "layout");
  // The shown layouts read again: in the same log as Herdr's requests, to see the order.
  const layouts = {
    reread: (hostId: string) => {
      live.sent.push({ method: `(reread ${hostId})`, params: {} });
      return service.reread(hostId);
    },
    accept: (hostId: string, layout: PaneLayout) => service.accept(hostId, layout),
    watched: (owner: { readonly id: number }) => service.watched(owner),
  };
  const updates: LayoutUpdateEvent[] = [];
  const page: LayoutOwner = { id: 10, send: (_channel, payload) => updates.push(payload), isDestroyed: () => false };
  if (answering) {
    service.watch(page, "mini", panes[0]!);
    await eventually(() => updates.at(-1)?.layout != null);
  }
  registerIpc({ hosts: registry, layouts, chat: {}, terminals: {}, ghostty: {} } as never);
  const event = { sender: page, senderFrame: { url: `${APP_ORIGIN}/` } };
  /** The pane as the window shows it (a stand-in when it shows nothing). */
  const bind = (paneId: string): PaneBinding =>
    paneBindingOf(registry.list()[0]!, updates.at(-1)?.layout ?? null, paneId) ?? {
      connection: 0,
      incarnation: 0,
      epoch: null,
      workspaceId: "w1",
      tabId: "w1:t1",
      paneId,
      terminalID: `term-${paneId}`,
      agent: null,
      session: null,
    };
  const split = (paneId: string, direction: "right" | "down" = "right") =>
    runPaneAction(registry, layouts, page, "mini", { type: "split", paneId, direction, binding: bind(paneId) });
  const where = (paneId: string, kind = "shell", direction: "right" | "down" = "down") =>
    electron.handles.get(IPC.newAgent)!(event, "mini", {
      workspaceId: "w1",
      folder: null,
      kind,
      where: { type: "split", direction, targetPaneId: paneId, binding: bind(paneId) },
    }) as Promise<{ paneId: string }>;
  return { live, registry, layouts, split, where };
}

const splits = (live: LiveHerdr) => live.sent.filter((request) => request.method === "pane.split").length;

beforeEach(() => electron.handles.clear());

describe("one guarded split for the tile menu and New agent's Where", () => {
  it("a stale cache with four live panes: both refuse on fresh state, nothing split", async () => {
    const m = await machine();
    // Another client splits the tab: Herdr has four, the cached snapshot still three.
    m.live.splitBehind("w1:t1", "w1:p3", "w1:p4");
    expect(m.registry.topology("mini")!.panes).toHaveLength(3);
    await expect(m.split("w1:p1")).rejects.toThrow("This tab already shows 4 panes; Adari shows up to 4.");
    await expect(m.where("w1:p1")).rejects.toThrow("This tab already shows 4 panes; Adari shows up to 4.");
    expect(splits(m.live)).toBe(0);
    expect(m.live.tabPanes("w1:t1")).toHaveLength(4);
  });

  it("two overlapping splits on three panes: one is made, the other refused once the first is in", async () => {
    const m = await machine();
    const gate = deferred();
    m.live.splitGate = () => gate.promise;
    const first = m.split("w1:p1", "right");
    const second = m.split("w1:p2", "down");
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    gate.open();
    const [a, b] = await Promise.allSettled([first, second]);
    expect(a.status).toBe("fulfilled");
    expect(b).toMatchObject({ status: "rejected", reason: { message: "This tab already shows 4 panes; Adari shows up to 4." } });
    expect(splits(m.live)).toBe(1);
    expect(m.live.tabPanes("w1:t1")).toHaveLength(4);
    // The second waited until the first's pane was made and the layouts read again, then read fresh.
    const methods = m.live.sent.map((request) => request.method);
    const madeAt = methods.indexOf("pane.split");
    const rereadAt = methods.indexOf("(reread mini)");
    expect(rereadAt).toBeGreaterThan(madeAt);
    expect(methods.slice(rereadAt + 1)).toContain("pane.layout");
  });

  it("a tile split and a Where overlapping on three panes: one is made, the other refused", async () => {
    const m = await machine();
    const gate = deferred();
    m.live.splitGate = () => gate.promise;
    const tile = m.split("w1:p1");
    const agent = m.where("w1:p2", "claude");
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    gate.open();
    const results = await Promise.allSettled([tile, agent]);
    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(splits(m.live)).toBe(1);
    expect(m.live.tabPanes("w1:t1")).toHaveLength(4);
  });

  it("Where with no topology (the machine never answered) is refused, nothing sent", async () => {
    const m = await machine(["w1:p1", "w1:p2"], false);
    expect(m.registry.topology("mini")).toBeNull();
    // The workspace check refuses a machine that is not answering
    // before the guarded split is reached; refused either way, nothing sent.
    await expect(m.where("w1:p1")).rejects.toThrow(/not known|is not answering/);
    await expect(m.where("unlisted")).rejects.toThrow(/not known|is not answering/);
    expect(m.live.sent).toEqual([]);
    await expect(m.split("w1:p1")).rejects.toThrow("That pane is not shown in this window.");
    expect(m.live.sent).toEqual([]);
  });

  it("fresh state unavailable (the machine stopped answering, or its layout cannot be read): refused, nothing split", async () => {
    const m = await machine();
    m.live.offline = true;
    await expect(m.split("w1:p1")).rejects.toThrow(/could not be checked/);
    // The failed fresh snapshot marks the machine offline, so the workspace check refuses first.
    await expect(m.where("w1:p1")).rejects.toThrow(/could not be checked|is not answering/);
    m.live.offline = false;
    expect(splits(m.live)).toBe(0);
    expect(m.live.tabPanes("w1:t1")).toHaveLength(3);
  });

  it("Where on two panes makes its pane, starts its agent there, and holds the slot until the refresh", async () => {
    const m = await machine(["w1:p1", "w1:p2"]);
    const made = await m.where("w1:p2", "claude", "right");
    expect(m.live.tabPanes("w1:t1")).toEqual(["w1:p1", "w1:p2", made.paneId]);
    expect(m.live.panes.get(made.paneId)?.agent).toBe("claude");
    const methods = m.live.sent.map((request) => request.method);
    expect(methods.indexOf("agent.start")).toBeGreaterThan(methods.indexOf("pane.split"));
    expect(methods.indexOf("(reread mini)")).toBeGreaterThan(methods.indexOf("agent.start"));
    // The snapshot after it lists the new pane: the next split counts it.
    expect(m.registry.topology("mini")!.panes).toHaveLength(3);
  });
});

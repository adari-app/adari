// Kept drafts on the IPC surface (src/main/drafts-ipc.ts): the
// page's saves are checked before they are kept, a kept draft is taken or
// discarded once, and only a machine answering now (connected, with its
// snapshot) moves its gone panes' drafts to Kept drafts; one not answering
// keeps them as they are.

import { describe, expect, it, vi } from "vitest";

import { DraftStore, MemoryDraftFiles } from "../src/main/drafts";
import type { HostView } from "../src/shared/ipc-contract";
import { IPC } from "../src/shared/ipc-contract";
import type { DraftsChangedEvent } from "../src/shared/drafts";

const registered = vi.hoisted(() => ({
  handles: new Map<string, (...args: unknown[]) => unknown>(),
  ons: new Map<string, (...args: unknown[]) => unknown>(),
}));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, listener: (...args: unknown[]) => unknown) => registered.handles.set(channel, listener),
    on: (channel: string, listener: (...args: unknown[]) => unknown) => registered.ons.set(channel, listener),
  },
}));

const { registerDraftsIpc, draftsAnswered } = await import("../src/main/drafts-ipc");
const { APP_ORIGIN } = await import("../src/main/protocol");

const event = { senderFrame: { url: APP_ORIGIN }, sender: { id: 1 } };
const stranger = { senderFrame: { url: "https://example.invalid" }, sender: { id: 2 } };

function setup() {
  const store = new DraftStore(new MemoryDraftFiles());
  const notified: DraftsChangedEvent[] = [];
  registerDraftsIpc(store, { agentOf: () => "claude", notify: (e) => notified.push(e) });
  const save = (...args: unknown[]) => registered.ons.get(IPC.draftSave)!(event, ...args);
  const kept = (...args: unknown[]) => registered.handles.get(IPC.draftKept)!(event, ...args);
  return { store, notified, save, kept };
}

const host = (state: string, panes: string[] | null): HostView =>
  ({
    id: "mac-mini",
    name: "Mac mini",
    state,
    topology: panes === null ? null : { panes: panes.map((paneID) => ({ paneID })), agents: [], workspaces: [], tabs: [] },
  }) as unknown as HostView;

describe("the drafts' IPC", () => {
  it("keeps a well-formed save with the pane's agent; refuses anything else and any other sender", () => {
    const { store, save } = setup();
    save("mac-mini", "w7:p1", { text: "hello", chips: [], lost: [] });
    save("mac-mini", "", { text: "no pane", chips: [], lost: [] });
    save("mac-mini", "w7:p2", { text: 5, chips: [], lost: [] });
    registered.ons.get(IPC.draftSave)!(stranger, "mac-mini", "w7:p3", { text: "not ours", chips: [], lost: [] });
    expect(store.state().drafts.map((draft) => [draft.paneId, draft.text, draft.agent])).toEqual([["w7:p1", "hello", "claude"]]);
    save("mac-mini", "w7:p1", null);
    expect(store.state().drafts).toEqual([]);
  });

  it("only a machine answering now moves its gone panes' drafts", () => {
    const { store, save, kept, notified } = setup();
    save("mac-mini", "w7:p1", { text: "keep", chips: [], lost: [] });
    expect(draftsAnswered(store, [host("offline", ["w7:p2"])])).toBeNull();
    expect(draftsAnswered(store, [host("connected", null)])).toBeNull();
    expect(draftsAnswered(store, [host("connected", ["w7:p1"])])).toBeNull();
    const moved = draftsAnswered(store, [host("connected", ["w7:p2"])])!;
    expect(moved.gone).toEqual([{ hostId: "mac-mini", paneId: "w7:p1" }]);
    expect(moved.state.kept.map((item) => [item.text, item.agentName])).toEqual([["keep", "claude"]]);
    const id = moved.state.kept[0]!.id;
    expect(kept(id, "take")).toMatchObject({ text: "keep" });
    expect(kept(id, "take")).toBeNull();
    expect(notified.at(-1)!.state.kept).toEqual([]);
    expect(() => kept(id, "eat")).toThrow("bad request");
  });
});

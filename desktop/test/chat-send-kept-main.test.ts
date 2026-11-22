// Main's side: a picture message past its Return is kept in drafts.json from
// the Return until the transcript settles it, Put back or Dismiss: written at once (before the Send's receipt, so before
// the page retires its draft), with its text (its pictures by their paths), its scope and main's check's outcome.
// Bounds: 8 per pane and 64 in all (the oldest beyond goes to Kept drafts), a week old at most (dropped at load). A
// machine that answers without its pane moves it to Kept drafts, its pictures as chips. Through the real DraftStore
// on a temp file, and the real IPC (registerIpc, registerDraftsIpc) with a fake machine. Fakes only: no socket.

const registered = vi.hoisted(() => ({
  handles: new Map<string, (...args: unknown[]) => unknown>(),
  ons: new Map<string, (...args: unknown[]) => void>(),
}));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, listener: (...args: unknown[]) => unknown) => registered.handles.set(channel, listener),
    on: (channel: string, listener: (...args: unknown[]) => void) => registered.ons.set(channel, listener),
  },
}));

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { DraftStore, fileDrafts, MemoryDraftFiles } from "../src/main/drafts";
import { draftsAnswered, registerDraftsIpc } from "../src/main/drafts-ipc";
import { unprovedKeptReason, unprovedMaxAgeMs, unprovedNoRoomText, unprovedPerPane, type UnprovedSend } from "../src/shared/drafts";
import { IPC, type HostView, type SendReceipt } from "../src/shared/ipc-contract";
import { FakeClaudeQueue } from "./support/claude-queue-screens";

const { registerIpc } = await import("../src/main/ipc");
const { APP_ORIGIN } = await import("../src/main/protocol");

const picture = "/fake/.adari-attachments-0123/attachment-11111111-1111-1111-1111-111111111111.png";
const message = `kept caption ${picture}`;
const entry = (paneId = "w1:p1", text = message): Omit<UnprovedSend, "id" | "outcome" | "sentAt"> => ({ hostId: "fixture-host", paneId, text, terminalID: "t1", session: "s1" });

describe("the kept copy in drafts.json (DraftStore)", () => {
  it("is written at once, before any timer, and comes back after a quit and a start with its outcome", () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "herdr-unproved-")), "drafts.json");
    const store = new DraftStore(fileDrafts(file), { now: () => 1_000 });
    const id = store.keepUnproved(entry())!;
    // On disk now: a quit or a crash right after the receipt keeps it.
    const onDisk = JSON.parse(readFileSync(file, "utf8")) as { unproved: UnprovedSend[] };
    expect(onDisk.unproved).toEqual([{ ...entry(), id, sentAt: 1_000, outcome: "checking" }]);
    expect(store.unprovedOutcome(id, "taken")).toBe(true);
    expect(store.unprovedOutcome(id, "taken")).toBe(false);
    store.flush();
    const started = new DraftStore(fileDrafts(file), { now: () => 2_000 });
    expect(started.state().unproved).toEqual([{ ...entry(), id, sentAt: 1_000, outcome: "taken" }]);
    // Released (the transcript settled it, Put back or Dismiss): gone, and the state is as before it.
    expect(started.releaseUnproved(id)).toBe(true);
    expect(started.state()).toEqual({ drafts: [], kept: [] });
  });

  it("a file from before unproved messages loads as it did", () => {
    const files = new MemoryDraftFiles();
    files.text = JSON.stringify({ version: 1, drafts: [], kept: [] });
    expect(new DraftStore(files).state()).toEqual({ drafts: [], kept: [] });
  });

  it("bounds: 8 per pane (the oldest beyond goes to Kept drafts, its pictures as chips); a week old at most", () => {
    let now = 10_000;
    const files = new MemoryDraftFiles();
    const store = new DraftStore(files, { now: () => now });
    const ids: string[] = [];
    for (let n = 0; n <= unprovedPerPane; n += 1) {
      now += 1;
      ids.push(store.keepUnproved(entry("w1:p1", `message ${n} ${picture}`))!);
    }
    store.keepUnproved(entry("w1:p2"));
    const state = store.state();
    expect(state.unproved!.filter((one) => one.paneId === "w1:p1").map((one) => one.id)).toEqual(ids.slice(1));
    expect(state.kept).toMatchObject([{ paneId: "w1:p1", text: "message 0", chips: [{ path: picture, name: picture.slice(picture.lastIndexOf("/") + 1), image: true }], reason: unprovedKeptReason }]);
    store.flush();
    // A week and a day later, every one is dropped at load (logged).
    const lines: string[] = [];
    now += unprovedMaxAgeMs + 86_400_000;
    const later = new DraftStore(files, { now: () => now, log: (line) => lines.push(line) });
    expect(later.state().unproved).toBeUndefined();
    expect(lines.some((line) => line.includes("older than a week"))).toBe(true);
  });

  it("a machine that answers without its pane: the kept copy goes to Kept drafts, where Put in box finds it; the page is told", () => {
    const store = new DraftStore(new MemoryDraftFiles(), { now: () => 5_000 });
    store.keepUnproved(entry("w1:p1"));
    store.keepUnproved(entry("w1:p2", "on a pane still there"));
    const view = { id: "fixture-host", name: "Fixture host", state: "connected", topology: { panes: [{ paneID: "w1:p2" }] } } as unknown as HostView;
    const told = draftsAnswered(store, [view]);
    expect(told).not.toBeNull();
    expect(told!.state.unproved!.map((one) => one.paneId)).toEqual(["w1:p2"]);
    expect(told!.state.kept).toMatchObject([{ hostId: "fixture-host", hostLabel: "Fixture host", paneId: "w1:p1", agentName: "claude", text: "kept caption", chips: [{ path: picture, image: true }], reason: "Adari could not confirm Claude Code got this. Its pane is gone." }]);
    // A machine removed takes its kept copies with it.
    store.forgetHost("fixture-host");
    expect(store.state().unproved).toBeUndefined();
  });
});

/** One Claude pane through the IPC, its box as the queue fake draws it, the kept copies in `store`. */
function mac(claude: FakeClaudeQueue, store: DraftStore, options: { readonly reserving?: boolean; readonly refusing?: boolean } = {}) {
  const order: string[] = [];
  /** What reached the pane: the prompt's text and every key. */
  const typed: string[] = [];
  const backend = {
    promptIO: () => ({ paneRead: async () => claude.read(), paneSendKeys: async () => void typed.push("keys") }),
    prompt: async (_pane: string, text: string) => {
      if (options.refusing === true) throw new Error("the transport refused");
      typed.push("prompt");
      claude.prompt(text);
      // Claude starts working on it: the check's first read sees that (no record on this machine).
      claude.state.working = true;
    },
    agentKeys: async (_pane: string, keys: readonly string[]) => {
      typed.push("keys");
      return claude.keys(keys);
    },
    sendText: async () => undefined,
    sendInput: async () => undefined,
  };
  const pane = { paneID: "w1:p1", terminalID: "t1", workspaceID: "w1", tabID: "w1:t1", focused: false, agent: "claude", agentStatus: "idle", revision: 1 };
  const agent = { paneID: "w1:p1", agent: "claude", agentStatus: "idle", terminalID: "t1", agentSession: { source: "herdr:claude", agent: "claude", kind: "id", value: "s1" }, turnEpoch: 7 };
  const hosts = {
    backend: () => backend,
    name: () => "Fixture host",
    pane: () => pane,
    agent: () => agent,
    run: () => ({ connection: 3, arrival: 1 }),
    fresh: async () => true,
    refresh: async () => undefined,
    connection: () => 3,
    connectionIdentity: () => ({ incarnation: 1, epoch: 7 }),
  };
  const outcomes: string[] = [];
  registerIpc({
    hosts,
    unproved: {
      ...(options.reserving === true
        ? {
            reserve: (kept: Omit<UnprovedSend, "id" | "outcome" | "sentAt">) => {
              order.push("reserved");
              return store.reserveUnproved(kept);
            },
            release: (reservation: string) => {
              order.push("given back");
              store.releaseReservation(reservation);
            },
          }
        : {}),
      keep: (kept: Omit<UnprovedSend, "id" | "outcome" | "sentAt">, reservation?: string | null) => {
        order.push("kept");
        return store.keepUnproved(kept, reservation ?? null);
      },
      outcome: (id: string, outcome: "taken" | "unknown" | "stillInBox") => {
        outcomes.push(outcome);
        store.unprovedOutcome(id, outcome);
      },
    },
  } as never);
  registerDraftsIpc(store, { agentOf: () => "claude", notify: () => undefined });
  const event = { senderFrame: { url: APP_ORIGIN }, sender: { id: 1, isDestroyed: () => false, send: () => undefined } };
  const binding = { terminalID: "t1", isAgent: true, kind: "claude", session: "s1" };
  return {
    order,
    typed,
    outcomes,
    history: async (id: unknown, anchor: unknown) => registered.handles.get(IPC.unprovedHistory)!(event, id, anchor) as Promise<void>,
    send: (text: string) =>
      (registered.handles.get(IPC.paneSend)!(event, "fixture-host", "w1:p1", text, binding) as Promise<SendReceipt>).then((receipt) => {
        order.push("receipt");
        return receipt;
      }),
    check: (id: string) => registered.handles.get(IPC.paneSendCheck)!(event, id) as Promise<string | null>,
    release: (id: string) => registered.handles.get(IPC.unprovedRelease)!(event, id) as Promise<void>,
    end: (id: string) => registered.handles.get(IPC.paneSendCheckEnd)!(event, id) as Promise<void>,
  };
}

describe("the Send IPC keeps a picture message from its Return", () => {
  it("written before the receipt answers (so before the page retires its draft); the receipt names it; main's outcome goes with it", async () => {
    const store = new DraftStore(new MemoryDraftFiles());
    const m = mac(new FakeClaudeQueue({ working: false }), store);
    const receipt = await m.send(message);
    expect(m.order).toEqual(["kept", "receipt"]);
    expect(receipt.check).not.toBeNull();
    expect(receipt.kept).toBe(store.state().unproved![0]!.id);
    expect(store.state().unproved).toMatchObject([{ hostId: "fixture-host", paneId: "w1:p1", text: message, terminalID: "t1", session: "s1" }]);
    // Session s1 is named and this machine has no record reader: the screen alone never proves it.
    expect(await m.check(receipt.check!)).toBe("unknown");
    expect(m.outcomes).toEqual(["unknown"]);
    expect(store.state().unproved![0]!.outcome).toBe("unknown");
    // The page releases it (the transcript settled it): gone from disk; ending a check that answered is harmless.
    await m.release(receipt.kept!);
    await m.end(receipt.check!);
    expect(store.state().unproved).toBeUndefined();
  });

  it("a message with no picture: no check, nothing kept", async () => {
    const store = new DraftStore(new MemoryDraftFiles());
    const m = mac(new FakeClaudeQueue({ working: false }), store);
    expect(await m.send("plain words")).toEqual({ check: null });
    expect(m.order).toEqual(["receipt"]);
    expect(store.state().unproved).toBeUndefined();
  });
});

describe("the Send IPC takes the copy's room before any key", () => {
  it("room: taken before the first key, the copy kept at the Return with it, nothing given back", async () => {
    const store = new DraftStore(new MemoryDraftFiles());
    const m = mac(new FakeClaudeQueue({ working: false }), store, { reserving: true });
    const receipt = await m.send(message);
    expect(m.order).toEqual(["reserved", "kept", "receipt"]);
    expect(receipt.kept).toBe(store.state().unproved![0]!.id);
  });

  it("no room (the drafts fill drafts.json): refused before any key in the refusal's words; nothing kept, no draft dropped", async () => {
    const files = new MemoryDraftFiles();
    const store = new DraftStore(files);
    for (let n = 0; n < 20; n += 1) store.put("fixture-host", `d${n}`, { text: "d".repeat(100_000), chips: [], lost: [] }, "claude");
    const m = mac(new FakeClaudeQueue({ working: false }), store, { reserving: true });
    await expect(m.send(`${"y".repeat(95_000)} ${picture}`)).rejects.toThrow(unprovedNoRoomText);
    expect(m.typed).toEqual([]);
    expect(m.order).toEqual(["reserved"]);
    expect(store.state().unproved).toBeUndefined();
    expect(store.state().drafts).toHaveLength(20);
    // A message with no picture keeps no copy and still goes.
    expect(await m.send("plain words")).toEqual({ check: null });
  });

  it("a Send that fails before its Return gives its room back", async () => {
    const store = new DraftStore(new MemoryDraftFiles());
    const refused = mac(new FakeClaudeQueue({ working: false }), store, { reserving: true, refusing: true });
    await expect(refused.send(message)).rejects.toThrow();
    expect(refused.typed).toEqual([]);
    expect(refused.order).toEqual(["reserved", "given back"]);
    expect(store.state().unproved).toBeUndefined();
  });
});

describe("where the transcript stood comes from the page once", () => {
  it("an id and a line id (or null) are kept once; anything else is refused and changes nothing", async () => {
    const store = new DraftStore(new MemoryDraftFiles());
    const m = mac(new FakeClaudeQueue({ working: false }), store);
    const id = store.keepUnproved(entry())!;
    await expect(m.history(id, 5)).rejects.toThrow("bad request");
    await expect(m.history(7, "a-0")).rejects.toThrow("bad request");
    await expect(m.history(id, "")).rejects.toThrow("bad request");
    await m.history("another-id", "a-0");
    expect(store.state().unproved![0]!.history).toBeUndefined();
    await m.history(id, "a-0");
    await m.history(id, null);
    expect(store.state().unproved![0]!.history).toEqual({ anchor: "a-0" });
  });
});

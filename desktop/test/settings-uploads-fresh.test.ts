// The upload counts in Settings are read again each time Uploaded images
// shows (Machines does not show them), when a machine connects
// again, and after an upload to it (or a chip's × taking one back) settles,
// so Delete now is never left off on a stale "None" or a failed count.
// A Delete now that stopped at an error after removing some files
// says so plainly.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  return { ...actual, ...fakeReact, default: { ...actual, ...fakeReact } };
});

import type { HostView } from "../src/shared/ipc-contract";
import { deleteOutcome, type UploadsInventory } from "../src/shared/settings";
import { HookHost, elements } from "./support/fake-hooks";
import { flush, loadSettings, mountSettings, settingsBridge, sshHost } from "./support/settings-page";

const { uploadsStore } = await import("../src/renderer/settings/uploads-store");
const settingsModule = await import("../src/renderer/settings/SettingsPage");
const { bridgeTransport } = await import("../src/renderer/components/composer-drafts");
const { RemoteTerminalPort } = await import("../src/renderer/terminal/remote-port");
await loadSettings();

const studio = sshHost("studio", "Studio", { connection: 1 } as Partial<HostView>);
let inventory: UploadsInventory;
let failNext: string | null;

beforeEach(() => {
  uploadsStore.reset();
  inventory = { files: 0, bytes: 0 };
  failNext = null;
});

afterEach(() => vi.unstubAllGlobals());

/** The fake bridge, its count answering what the machine holds now (or failing once). */
function machine() {
  const { bridge, fake } = settingsBridge();
  fake.count = () => {
    if (failNext !== null) {
      const reason = failNext;
      failNext = null;
      return Promise.reject(new Error(reason));
    }
    return Promise.resolve(inventory);
  };
  const counts = () => fake.calls.filter((call) => call[0] === "uploadsCount").length;
  return { bridge, fake, counts };
}

/** A machine's uploads line as the page draws it: its words and whether Delete now can be pressed. */
function line(hostView: HostView = studio) {
  const UploadsLine = (settingsModule as unknown as { UploadsLine?: (props: object) => unknown }).UploadsLine;
  if (UploadsLine === undefined) throw new Error("SettingsPage.tsx does not export UploadsLine");
  const view = new HookHost<object>(UploadsLine, { host: hostView, onDelete: () => undefined });
  view.render();
  const all = elements(view.tree);
  const words = all.find((element) => element.props["className"] === "set-up-c")!.props["children"] as string;
  const button = all.find((element) => element.props["children"] === "Delete now")!;
  view.unmount();
  return { words, canDelete: button.props["disabled"] !== true };
}

describe("the counts are read again", () => {
  it("None, Settings closed, a file uploaded elsewhere, Settings opened again: one file, Delete now on", async () => {
    const { bridge, counts } = machine();
    const first = mountSettings("uploads", { bridge, hosts: [studio] });
    await flush();
    expect(uploadsStore.state("studio")).toEqual({ kind: "counted", inventory: { files: 0, bytes: 0 } });
    first.view.unmount();

    inventory = { files: 1, bytes: 2_400_000 };
    const again = mountSettings("uploads", { bridge, hosts: [studio] });
    await flush();
    expect(counts()).toBe(2);
    expect(line()).toEqual({ words: "1 file, 2.4 MB", canDelete: true });
    expect(line({ ...studio, id: "never-counted" } as HostView).canDelete).toBe(false);
    again.view.unmount();
  });

  it("a failed count is tried again when the page opens again", async () => {
    const { bridge, counts } = machine();
    failNext = "the machine did not answer";
    const first = mountSettings("uploads", { bridge, hosts: [studio] });
    await flush();
    expect(uploadsStore.state("studio")).toEqual({ kind: "failed", reason: "the machine did not answer" });
    first.view.unmount();

    inventory = { files: 2, bytes: 1_000 };
    const again = mountSettings("uploads", { bridge, hosts: [studio] });
    await flush();
    expect(counts()).toBe(2);
    expect(line().canDelete).toBe(true);
    again.view.unmount();
  });

  // Machines shows no upload lines, so only Uploaded images counts (Machines, Chat: no request).
  it("each time Uploaded images shows: going away and back reads again; Machines does not count", async () => {
    const { bridge, counts } = machine();
    const page = mountSettings("machines", { bridge, hosts: [studio] });
    await flush();
    expect(counts()).toBe(0);
    expect(page.part("UploadsLine")).toBeUndefined();
    page.rerender({ section: "uploads" });
    await flush();
    expect(counts()).toBe(1);
    page.rerender({ section: "chat" });
    await flush();
    expect(counts()).toBe(1);
    inventory = { files: 1, bytes: 10 };
    page.rerender({ section: "uploads" });
    await flush();
    expect(counts()).toBe(2);
    expect(line().canDelete).toBe(true);
    page.view.unmount();
  });

  it("a machine that connects again is read again while the page shows it (a failed count too)", async () => {
    const { bridge, counts } = machine();
    failNext = "connection lost";
    const page = mountSettings("uploads", { bridge, hosts: [studio] });
    await flush();
    expect(uploadsStore.state("studio").kind).toBe("failed");
    page.rerender({ hosts: [{ ...studio, state: "offline" } as HostView] });
    await flush();
    expect(counts()).toBe(1);

    inventory = { files: 3, bytes: 300 };
    page.rerender({ hosts: [{ ...studio, state: "connected", connection: 2 } as HostView] });
    await flush();
    expect(counts()).toBe(2);
    expect(line().words).toBe("3 files, 300 bytes");

    // Connected again without the page seeing it go (a new connection number).
    inventory = { files: 4, bytes: 400 };
    page.rerender({ hosts: [{ ...studio, state: "connected", connection: 3 } as HostView] });
    await flush();
    expect(counts()).toBe(3);

    // Gone and back on the same connection number: read again too.
    page.rerender({ hosts: [{ ...studio, state: "connecting", connection: 3 } as HostView] });
    page.rerender({ hosts: [{ ...studio, state: "connected", connection: 3 } as HostView] });
    await flush();
    expect(counts()).toBe(4);
    page.view.unmount();
  });

  it("an upload from the message box, or one taken back with ×, makes the count stale: a page that shows it reads again", async () => {
    const { bridge, counts } = machine();
    const uploads = {
      uploadAttachment: () => Promise.resolve({ path: "/Users/fixture/.adari-attachments-0/attachment-1.png", kind: "image" }),
      discardAttachment: () => Promise.resolve(),
    };
    vi.stubGlobal("window", { herdrDesktop: uploads, addEventListener: () => undefined, removeEventListener: () => undefined });
    const page = mountSettings("uploads", { bridge, hosts: [studio] });
    await flush();
    expect(counts()).toBe(1);

    inventory = { files: 1, bytes: 8 };
    await bridgeTransport()!.upload("studio", new Uint8Array(8), "png", "u1");
    await flush();
    expect(counts()).toBe(2);
    expect(line().canDelete).toBe(true);

    inventory = { files: 0, bytes: 0 };
    await bridgeTransport()!.discard!("studio", "/Users/fixture/.adari-attachments-0/attachment-1.png");
    await flush();
    expect(counts()).toBe(3);
    expect(line().words).toBe("None");

    // Another machine's upload leaves this one's count alone.
    await bridgeTransport()!.upload("box", new Uint8Array(8), "png", "u2");
    await flush();
    expect(counts()).toBe(3);
    page.view.unmount();
  });

  it("an upload that fails still makes the count stale (it may have left part of a file until its cleanup)", async () => {
    const { bridge, counts } = machine();
    vi.stubGlobal("window", { herdrDesktop: { uploadAttachment: () => Promise.reject(new Error("no space")) }, addEventListener: () => undefined, removeEventListener: () => undefined });
    const page = mountSettings("uploads", { bridge, hosts: [studio] });
    await flush();
    await expect(bridgeTransport()!.upload("studio", new Uint8Array(8), "png", "u1")).rejects.toThrow("no space");
    await flush();
    expect(counts()).toBe(2);
    page.view.unmount();
  });

  it("a paste or drop in the terminal uploads through its port: the count is stale after it too", async () => {
    const { bridge, counts } = machine();
    const terminalBridge = {
      onTerminalData: () => () => undefined,
      onTerminalExit: () => () => undefined,
      uploadAttachment: () => Promise.resolve({ path: "/Users/fixture/.adari-attachments-0/attachment-2.png", kind: "image" }),
    };
    const page = mountSettings("uploads", { bridge, hosts: [studio] });
    await flush();
    const port = new RemoteTerminalPort(terminalBridge as never, "studio", "w1:p1", () => undefined, () => undefined);
    inventory = { files: 1, bytes: 8 };
    await port.upload(new Uint8Array(8), "png");
    await flush();
    expect(counts()).toBe(2);
    expect(line().canDelete).toBe(true);
    page.view.unmount();
  });

  it("an upload that settles while a count runs is not lost: it is read again after", async () => {
    const { bridge, fake } = machine();
    let answer: (value: UploadsInventory) => void = () => undefined;
    fake.count = () => new Promise((resolve) => (answer = resolve));
    const page = mountSettings("uploads", { bridge, hosts: [studio] });
    await flush();
    uploadsStore.invalidate("studio");
    answer({ files: 0, bytes: 0 });
    await flush();
    expect(fake.calls.filter((call) => call[0] === "uploadsCount")).toHaveLength(2);
    page.view.unmount();
  });
});

describe("a Delete now stopped by an error says what it already removed", () => {
  it("some files removed before the error: said plainly, with what is left", () => {
    const text = deleteOutcome({ removedFiles: 1, removedBytes: 8, removedFolders: 0, keptFiles: 0, stopped: "permission denied", remaining: null });
    expect(text).toBe("Delete now stopped at an error (permission denied). 1 file (8 bytes) was already deleted before it; the rest are still on the machine.");
  });

  it("an error before anything was removed: nothing was deleted", () => {
    const text = deleteOutcome({ removedFiles: 0, removedBytes: 0, removedFolders: 0, keptFiles: 0, stopped: "permission denied", remaining: null });
    expect(text).toBe("Delete now stopped at an error (permission denied). Nothing was deleted.");
  });

  it("a Delete now that finished says what it deleted and kept", () => {
    expect(deleteOutcome({ removedFiles: 3, removedBytes: 3_200_000, removedFolders: 1, keptFiles: 1, stopped: null, remaining: null })).toBe(
      "Delete now: deleted 3 files (3.2 MB), kept 1 still used in Adari.",
    );
  });
});

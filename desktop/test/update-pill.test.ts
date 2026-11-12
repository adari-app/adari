// How the user sees the app's own updates. The
// sidebar footer's pill reads Download, then a progress ring while it
// downloads, then Restart; one toast when a download finishes; nothing is
// downloaded or installed but by a click on it (and Restart asks first, in
// the main process: test/updates.test.ts). The window over a fake bridge.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  const hooks = { ...fakeReact, useLayoutEffect: fakeReact.useEffect };
  return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});
vi.mock("electron", () => ({ ipcMain: { handle: () => undefined, on: () => undefined } }));

import {
  automaticFoot,
  initialUpdateView,
  installQuestion,
  lastCheckLine,
  onAvailable,
  onCheckFailed,
  onDownloaded,
  onDownloadProgress,
  onDownloadStart,
  onInstallStart,
  onNotAvailable,
  updateDownloadedToast,
  updateFailureText,
  updatePill,
  updateStatusLine,
  type UpdateView,
} from "../src/shared/updates";
import { elements } from "./support/fake-hooks";
import { one, page, settle, text } from "./support/manage-page";

const { UpdatePill, ringOffset } = await import("../src/renderer/components/UpdatePill");
const { UpdateStore, updateStore } = await import("../src/renderer/updates/update-store");

const at = Date.UTC(2026, 10, 9, 14, 2, 0);
const start = initialUpdateView("0.1.0", null, true);
const available = onAvailable(start, "0.1.1", at);
const downloading = onDownloadProgress(onDownloadStart(available), 42.6);
const downloaded = onDownloaded(downloading, "0.1.1");
const installing = onInstallStart(downloaded);

describe("the pill's states", () => {
  it("none while nothing newer is known, while off, or after a failed check", () => {
    expect(updatePill(start)).toBeNull();
    expect(updatePill(onNotAvailable(start, at))).toBeNull();
    expect(updatePill(initialUpdateView("0.1.0", "unsigned", true))).toBeNull();
    expect(updatePill(onCheckFailed(start, "No release is published on GitHub yet.", at))).toBeNull();
  });

  it("available: Download; downloading: the ring with its percent; downloaded: Restart; restarting: greyed", () => {
    expect(updatePill(available)).toEqual({ action: "download", icon: "download", label: "Download", title: "Adari 0.1.1 is available. Click to download it.", percent: null, busy: false });
    expect(updatePill(downloading)).toEqual({ action: "none", icon: "progress", label: "42%", title: "Downloading Adari 0.1.1 (42%)", percent: 42, busy: true });
    expect(updatePill(downloaded)).toEqual({ action: "install", icon: "restart", label: "Restart", title: "Adari 0.1.1 is downloaded. Click to restart and install it.", percent: 100, busy: false });
    expect(updatePill(installing)).toMatchObject({ action: "none", icon: "restart", label: "Restarting…", busy: true });
  });

  it("drawn: a button with its state, label and tooltip; the ring's arc follows the percent; greyed with nothing to click", () => {
    const clicks: string[] = [];
    const draw = (view: UpdateView) => UpdatePill({ pill: updatePill(view), onAction: (action) => clicks.push(action) }) as unknown;
    expect(draw(start)).toBeNull();
    const button = (view: UpdateView) => elements(draw(view)).find((element) => element.type === "button")!;
    const download = button(available);
    expect(download.props).toMatchObject({ className: "upd-pill upd-download", "data-update-pill": "download", title: "Adari 0.1.1 is available. Click to download it.", disabled: false });
    expect(text(elements(download).find((element) => element.props["className"] === "upd-l"))).toBe("Download");
    (download.props["onClick"] as () => void)();
    const ring = button(downloading);
    expect(ring.props).toMatchObject({ "data-update-pill": "downloading", disabled: true, "aria-busy": true });
    const arc = elements(ring).find((element) => element.props["className"] === "upd-ring-v")!;
    expect(arc.props["strokeDashoffset"]).toBe(ringOffset(42));
    expect(ringOffset(0)).toBeCloseTo(2 * Math.PI * 6, 1);
    expect(ringOffset(100)).toBe(0);
    expect(ringOffset(50)).toBeCloseTo(Math.PI * 6, 1);
    const restart = button(downloaded);
    expect(restart.props).toMatchObject({ "data-update-pill": "install", disabled: false });
    (restart.props["onClick"] as () => void)();
    (ring.props["onClick"] as () => void)();
    const restarting = button(installing);
    expect(restarting.props).toMatchObject({ "data-update-pill": "installing", disabled: true });
    (restarting.props["onClick"] as () => void)();
    expect(clicks).toEqual(["download", "install"]);
  });
});

describe("the words", () => {
  it("the toast, the Restart question, and Settings' lines", () => {
    expect(updateDownloadedToast).toBe("Update downloaded. Restart Adari from the update button to install it.");
    expect(installQuestion("0.1.1").message).toBe("Install update 0.1.1 and restart Adari?");
    expect(installQuestion("0.1.1").buttons).toEqual(["Restart", "Cancel"]);
    expect(updateStatusLine(available)).toBe("Adari 0.1.1 is available.");
    expect(updateStatusLine(downloading)).toBe("Downloading Adari 0.1.1… 42%");
    expect(updateStatusLine(downloaded)).toBe("Adari 0.1.1 is downloaded. Restart Adari to install it.");
    expect(updateStatusLine(initialUpdateView("0.1.0", "unsigned", true))).toBe("Updates come with the signed download.");
    const words = (when: number) => (when === at ? "today at 14:02" : "?");
    expect(lastCheckLine(available, at, words)).toBe("Last checked today at 14:02.");
    expect(lastCheckLine(onCheckFailed(start, "No release is published on GitHub yet.", at), at, words)).toBe("Last check today at 14:02 failed. No release is published on GitHub yet.");
    expect(lastCheckLine(start, at, words)).toBe("Not checked yet. The first check is about 15 seconds after Adari opens.");
    expect(automaticFoot(true)).toBe("About 15 seconds after Adari opens, then every 4 minutes. Nothing downloads or installs until you click.");
    expect(automaticFoot(false)).toBe("Adari checks only when you ask (Check for Updates…).");
  });

  it("failures in short words: no release yet, no update files, no network, else the first line", () => {
    expect(updateFailureText(Object.assign(new Error("x"), { code: "ERR_UPDATER_LATEST_VERSION_NOT_FOUND" }), "GitHub")).toBe("No release is published on GitHub yet.");
    expect(updateFailureText(new Error("No published versions on GitHub"), "GitHub")).toBe("No release is published on GitHub yet.");
    expect(updateFailureText(Object.assign(new Error("Cannot find latest-mac.yml"), { code: "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND" }), "GitHub")).toBe("The latest release has no update files (latest-mac.yml).");
    expect(updateFailureText(new Error("net::ERR_NAME_NOT_RESOLVED"), "GitHub")).toBe("Could not reach GitHub.");
    expect(updateFailureText(new Error("sha512 checksum mismatch\nat …"), "GitHub")).toBe("sha512 checksum mismatch");
    expect(updateFailureText("x".repeat(300), "GitHub")).toHaveLength(200);
  });
});

describe("the toast, once", () => {
  it("once for each download that finishes while the page is open; never for one that finished before it opened", () => {
    const store = new UpdateStore();
    store.receive(downloading, false);
    expect(store.takeToast()).toBe(false);
    store.receive(downloaded, true);
    expect(store.takeToast()).toBe(true);
    expect(store.takeToast()).toBe(false);
    store.receive(onAvailable(downloaded, "0.1.1", at + 1), true);
    store.receive(installing, true);
    expect(store.takeToast()).toBe(false);
    const later = new UpdateStore();
    later.receive(downloaded, false);
    expect(later.takeToast()).toBe(false);
  });

  it("a change pushed before the first answer arrives wins over it", async () => {
    const store = new UpdateStore();
    let push: ((view: UpdateView) => void) | null = null;
    let answer: ((view: UpdateView) => void) | null = null;
    store.attach({
      onUpdateState: (listener) => {
        push = listener;
        return () => undefined;
      },
      updateState: () => new Promise<UpdateView>((resolve) => (answer = resolve)),
    });
    push!(available);
    answer!(start);
    await settle();
    expect(store.view()).toBe(available);
  });
});

describe("in the window", () => {
  let cleanups: (() => void)[] = [];
  beforeEach(() => updateStore.reset());
  afterEach(async () => {
    for (let i = 0; i < 4; i += 1) await settle();
    for (const run of cleanups.splice(0)) run();
    updateStore.reset();
    vi.unstubAllGlobals();
  });

  async function window(initial: UpdateView) {
    const calls: string[] = [];
    let push: ((view: UpdateView) => void) | null = null;
    const p = await page({
      bridge: {
        updateState: () => Promise.resolve(initial),
        onUpdateState: (listener: (view: UpdateView) => void) => {
          push = listener;
          return () => undefined;
        },
        downloadUpdate: () => (calls.push("downloadUpdate"), Promise.resolve(true)),
        installUpdate: () => (calls.push("installUpdate"), Promise.resolve("cancelled")),
        setAutomaticUpdates: (on: boolean) => (calls.push(`setAutomaticUpdates ${on}`), Promise.resolve(initial)),
      },
    });
    cleanups.push(() => p.app.unmount());
    for (let i = 0; i < 4; i += 1) await settle();
    /** The footer's pill as App hands it to the Sidebar (null: none, the agent count shows). */
    const pill = () => {
      const slot = p.sidebar()["updatePill"] as { props: { pill: ReturnType<typeof updatePill>; onAction(action: string): void } } | null;
      return slot === null ? null : slot.props;
    };
    return { p, calls, pill, push: (view: UpdateView) => push!(view) };
  }

  it("the footer's pill follows the state: none, Download, the ring, Restart; each click is the bridge's, and only a click", async () => {
    const w = await window(start);
    expect(one(w.p.app.tree, "Sidebar")).toBeDefined();
    expect(w.pill()).toBeNull();
    w.push(available);
    expect(w.pill()!.pill).toMatchObject({ label: "Download", action: "download" });
    expect(w.calls).toEqual([]);
    w.pill()!.onAction("download");
    await settle();
    expect(w.calls).toEqual(["downloadUpdate"]);
    w.push(downloading);
    expect(w.pill()!.pill).toMatchObject({ icon: "progress", label: "42%" });
    w.push(downloaded);
    expect(w.pill()!.pill).toMatchObject({ label: "Restart", action: "install" });
    expect(w.calls).toEqual(["downloadUpdate"]);
    w.pill()!.onAction("install");
    await settle();
    expect(w.calls).toEqual(["downloadUpdate", "installUpdate"]);
  });

  it("one toast when the download finishes; not again for the same download", async () => {
    const w = await window(available);
    expect(w.p.toast()).toBeNull();
    w.push(downloading);
    expect(w.p.toast()).toBeNull();
    w.push(downloaded);
    expect(w.p.toast()).toBe(updateDownloadedToast);
    // Dismissed (a click), then a later check finding the same download: no second toast.
    const toast = elements(w.p.app.tree).find((element) => element.props["className"] === "app-toast")!;
    (toast.props["onClick"] as () => void)();
    expect(w.p.toast()).toBeNull();
    w.push(onAvailable(downloaded, "0.1.1", at + 240_000));
    w.push(installing);
    expect(w.p.toast()).toBeNull();
  });

  it("a window opened after the download finished shows Restart but no toast", async () => {
    const w = await window(downloaded);
    expect(w.pill()!.pill).toMatchObject({ label: "Restart" });
    expect(w.p.toast()).toBeNull();
  });

  it("an older bridge without the update calls: no pill, nothing breaks", async () => {
    const p = await page();
    cleanups.push(() => p.app.unmount());
    await settle();
    expect(p.sidebar()["updatePill"]).toBeNull();
  });
});

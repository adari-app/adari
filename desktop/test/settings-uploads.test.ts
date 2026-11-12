// Settings › Uploaded images (only there, not on Machines). The page shows
// the size of Adari's own upload folders on each machine and Delete now,
// which asks first. The main process does the work
// over the sweep's file access and walk (src/main/uploads/service.ts,
// sweep.ts with every age): only the uploader's own files in its own folders,
// never through a symlink, never a path the page names (only the machine's id
// crosses), and nothing while an upload to that machine is under way.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  return { ...actual, ...fakeReact, default: { ...actual, ...fakeReact } };
});
const registered = vi.hoisted(() => ({ handles: new Map<string, (...args: unknown[]) => unknown>() }));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, listener: (...args: unknown[]) => unknown) => registered.handles.set(channel, listener),
    on: () => undefined,
  },
}));

import { IPC } from "../src/shared/ipc-contract";
import type { DraftsState } from "../src/shared/drafts";
import { MemoryUploadSftp } from "../src/main/uploads/memory";
import { draftsNameUpload, recentUploadMs, UploadService } from "../src/main/uploads/service";
import { inventoryUploads, sweepUploads } from "../src/main/uploads/sweep";
import { elements } from "./support/fake-hooks";
import { flush, loadSettings, mountSettings, settingsBridge, sshHost } from "./support/settings-page";

const { registerIpc } = await import("../src/main/ipc");
const { APP_ORIGIN } = await import("../src/main/protocol");
const { uploadsStore } = await import("../src/renderer/settings/uploads-store");
await loadSettings();

const home = "/Users/fixture";
const day = 24 * 60 * 60 * 1_000;
const now = 100 * day;
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
const folderA = `${home}/.adari-attachments-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`;
const folderB = `${home}/.herdr-companion-attachments-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`;
const fileA = `${folderA}/attachment-11111111-1111-4111-8111-111111111111.png`;
const fileA2 = `${folderA}/attachment-22222222-2222-4222-8222-222222222222.jpg`;
const fileB = `${folderB}/attachment-33333333-3333-4333-8333-333333333333.png`;
const stranger = `${folderA}/notes.txt`;
const loose = `${home}/attachment-44444444-4444-4444-8444-444444444444.png`;
const elsewhere = `${home}/elsewhere/attachment-55555555-5555-4555-8555-555555555555.png`;

/** A machine with Adari's uploads (one a minute old, one a day old) and what is not Adari's beside them. */
function machine(): MemoryUploadSftp {
  const sftp = new MemoryUploadSftp(home);
  sftp.addFolder(folderA, now - day);
  sftp.addFile(fileA, png, now - day);
  sftp.addFile(fileA2, png, now - 60_000);
  sftp.addFile(stranger, png, now - 40 * day);
  sftp.addFolder(folderB, now - 2 * day);
  sftp.addFile(fileB, png, now - 2 * day);
  sftp.addFile(loose, png, now - 40 * day);
  sftp.addFolder(`${home}/elsewhere`, now - 40 * day);
  sftp.addFile(elsewhere, png, now - 40 * day);
  sftp.addSymlink(`${home}/.adari-attachments-cccccccccccccccccccccccccccccccc`, `${home}/elsewhere`);
  return sftp;
}

/** The upload service over one machine whose uploads wait until the test lets them finish. */
function service(sftp: MemoryUploadSftp) {
  let clock = now;
  const waiting: { path: string; resolve(): void }[] = [];
  const backend = {
    uploads: () => ({
      machineKey: "me@studio:22",
      upload: (_data: Uint8Array, extension: string) =>
        new Promise<{ path: string; kind: string }>((resolve) => {
          const path = `${folderA}/attachment-66666666-6666-4666-8666-66666666666${waiting.length}.${extension}`;
          waiting.push({
            path,
            resolve: () => {
              sftp.addFile(path, png, clock);
              resolve({ path, kind: "image" });
            },
          });
        }),
      withFiles: <T>(work: (s: MemoryUploadSftp) => Promise<T>) => work(sftp),
    }),
  };
  const log = { lastSweep: () => now, noteSweep: () => undefined };
  const uploads = new UploadService({ backend: (id) => (id === "studio" ? (backend as never) : null) }, log, () => clock);
  return { uploads, waiting, advance: (ms: number) => (clock += ms) };
}

describe("Delete now in the main process", () => {
  it("every age: removes each of Adari's uploads and the folders it emptied; nothing else", async () => {
    const sftp = machine();
    const result = await sweepUploads(sftp, now, null);
    expect(result).toEqual({ removedFiles: 3, removedBytes: 3 * png.byteLength, removedFolders: 1, keptFiles: 0, stopped: null });
    for (const path of [fileA, fileA2, fileB]) expect(sftp.file(path)).toBeNull();
    // folderA keeps a file that is not Adari's, so it stays; folderB was emptied.
    expect(sftp.nodes.has(folderA)).toBe(true);
    expect(sftp.nodes.has(folderB)).toBe(false);
    for (const path of [stranger, loose, elsewhere]) expect(sftp.file(path)).toEqual(png);
  });

  it("counts only Adari's own uploads (not another name, a loose file, or a folder that is a symlink)", async () => {
    expect(await inventoryUploads(machine())).toEqual({ files: 3, bytes: 3 * png.byteLength });
  });

  it("removes them and says what is left; a path outside the folders is never touched", async () => {
    const sftp = machine();
    const { uploads } = service(sftp);
    const result = await uploads.deleteNow("studio");
    expect(result).toMatchObject({ removedFiles: 3, keptFiles: 0, stopped: null, remaining: { files: 0, bytes: 0 } });
    for (const path of [stranger, loose, elsewhere]) expect(sftp.file(path)).toEqual(png);
    expect(sftp.requests.filter((line) => line.startsWith("unlink ")).map((line) => line.slice(7))).toEqual(expect.arrayContaining([fileA, fileA2, fileB]));
    expect(sftp.requests.filter((line) => line.startsWith("unlink ")).every((line) => /\/\.(adari|herdr-companion)-attachments-[0-9a-f]{32}\/attachment-/.test(line))).toBe(true);
  });

  it("leaves every file alone while an upload to that machine is under way", async () => {
    const sftp = machine();
    const { uploads, waiting } = service(sftp);
    const sending = uploads.upload("studio", png, "png");
    await flush();
    expect(uploads.uploading("studio")).toBe(1);
    const result = await uploads.deleteNow("studio");
    expect(result.removedFiles).toBe(0);
    expect(result.keptFiles).toBe(3);
    waiting[0]!.resolve();
    const sent = await sending;
    expect(sftp.file(sent.path)).toEqual(png);
    expect(uploads.uploading("studio")).toBe(0);
  });

  it("keeps an upload finished in the last few seconds, and what a draft still names; removes it later", async () => {
    const sftp = machine();
    const { uploads, waiting, advance } = service(sftp);
    const sending = uploads.upload("studio", png, "png");
    await flush();
    waiting[0]!.resolve();
    const sent = await sending;
    const drafts: DraftsState = { drafts: [{ hostId: "studio", paneId: "w1:p1", text: "look", chips: [{ path: fileB }] } as never], kept: [] };
    const first = await uploads.deleteNow("studio", (path) => draftsNameUpload(drafts, path));
    expect(first.removedFiles).toBe(2);
    expect(sftp.file(sent.path)).toEqual(png);
    expect(sftp.file(fileB)).toEqual(png);

    advance(recentUploadMs + 1);
    const second = await uploads.deleteNow("studio", () => false);
    expect(second.removedFiles).toBe(2);
    expect(sftp.file(sent.path)).toBeNull();
    expect(sftp.file(fileB)).toBeNull();
  });

  it("a draft names a path by its chip or in its text, a kept draft too", () => {
    const state = (text: string, chips: string[] = [], kept = false): DraftsState => {
      const item = { hostId: "h", paneId: "p", text, chips: chips.map((path) => ({ path })) } as never;
      return kept ? { drafts: [], kept: [item] } : { drafts: [item], kept: [] };
    };
    expect(draftsNameUpload(state("", [fileA]), fileA)).toBe(true);
    expect(draftsNameUpload(state(`see ${fileA}`), fileA)).toBe(true);
    expect(draftsNameUpload(state("", [fileA], true), fileA)).toBe(true);
    expect(draftsNameUpload(state("nothing", [fileB]), fileA)).toBe(false);
  });

  it("a second press while one runs gets the same one; a machine without uploads says so", async () => {
    const { uploads } = service(machine());
    const one = uploads.deleteNow("studio");
    expect(uploads.deleteNow("studio")).toBe(one);
    await one;
    await expect(uploads.deleteNow("nowhere")).rejects.toThrow("Uploads are not available for this machine.");
  });
});

describe("the uploads IPC", () => {
  const event = { senderFrame: { url: APP_ORIGIN }, sender: { id: 1 } };
  function ipc() {
    const asked: unknown[][] = [];
    registerIpc({
      hosts: {},
      uploadsCount: async (hostId: string, fresh: boolean) => (asked.push(["count", hostId, fresh]), { files: 0, bytes: 0 }),
      deleteUploadsNow: async (hostId: string) => (asked.push(["delete", hostId]), { removedFiles: 0, removedBytes: 0, removedFolders: 0, keptFiles: 0, stopped: null, remaining: null }),
    } as never);
    const call = (channel: string, ...args: unknown[]) => Promise.resolve().then(() => registered.handles.get(channel)!(event, ...args));
    return { asked, call };
  }

  it("takes only the machine's id: a second argument or another shape is refused before anything runs", async () => {
    const { asked, call } = ipc();
    await expect(call(IPC.uploadsDeleteNow, "studio")).resolves.toMatchObject({ removedFiles: 0 });
    await expect(call(IPC.uploadsDeleteNow, "studio", "/Users/fixture/Documents")).rejects.toThrow("bad request");
    await expect(call(IPC.uploadsDeleteNow, { path: "/" })).rejects.toThrow("bad request");
    await expect(call(IPC.uploadsDeleteNow)).rejects.toThrow("bad request");
    await expect(call(IPC.uploadsCount, "studio", "extra")).rejects.toThrow("bad request");
    expect(asked).toEqual([["delete", "studio"]]);
  });

  it("a count takes the id and, at most, whether it is a fresh ask (a boolean)", async () => {
    const { asked, call } = ipc();
    await call(IPC.uploadsCount, "studio");
    await call(IPC.uploadsCount, "studio", true);
    await call(IPC.uploadsCount, "studio", false);
    for (const extra of [[1], ["true"], [null], [true, true], [{ fresh: true }]]) {
      await expect(call(IPC.uploadsCount, "studio", ...extra), JSON.stringify(extra)).rejects.toThrow("bad request");
    }
    expect(asked).toEqual([
      ["count", "studio", false],
      ["count", "studio", true],
      ["count", "studio", false],
    ]);
  });

  it("a path sent as the id is no machine: refused, and nothing on any machine is touched", async () => {
    const sftp = machine();
    const { uploads } = service(sftp);
    registerIpc({ hosts: {}, deleteUploadsNow: (hostId: string) => uploads.deleteNow(hostId) } as never);
    const call = (...args: unknown[]) => Promise.resolve().then(() => registered.handles.get(IPC.uploadsDeleteNow)!(event, ...args));
    await expect(call(folderA)).rejects.toThrow("Uploads are not available for this machine.");
    await expect(call("/")).rejects.toThrow("Uploads are not available for this machine.");
    expect(sftp.requests.filter((line) => line.startsWith("unlink ") || line.startsWith("rmdir "))).toEqual([]);
    for (const path of [fileA, fileA2, fileB, stranger]) expect(sftp.file(path)).toEqual(png);
  });

  it("refuses a page that is not the app's", async () => {
    const { asked } = ipc();
    const stranger = { senderFrame: { url: "https://example.com" }, sender: { id: 1 } };
    await expect(Promise.resolve().then(() => registered.handles.get(IPC.uploadsDeleteNow)!(stranger, "studio"))).rejects.toThrow();
    expect(asked).toEqual([]);
  });
});

describe("Delete now on the page", () => {
  beforeEach(() => uploadsStore.reset());
  afterEach(() => vi.unstubAllGlobals());

  it("counts each connected machine's uploads, and asks before deleting (Cancel deletes nothing)", async () => {
    const { bridge, fake } = settingsBridge();
    const page = mountSettings("uploads", { bridge, hosts: [sshHost("studio", "Studio"), sshHost("off", "Off", { state: "offline" } as never)] });
    await flush();
    expect(fake.calls).toEqual([["uploadsCount", "studio"]]);
    expect(uploadsStore.state("studio")).toEqual({ kind: "counted", inventory: { files: 3, bytes: 3_200_000 } });

    (page.part("UploadsLine", (props) => (props["host"] as { id: string }).id === "studio")!.props["onDelete"] as () => void)();
    const dialog = page.find((element) => element.props["role"] === "alertdialog")!;
    expect(dialog.props["aria-label"]).toBe("Delete the uploaded images on Studio?");
    const confirm = page.find((element) => element.props["data-confirm"] === "delete")!;
    expect(confirm.props["children"]).toBe("Delete 3 files");
    expect(fake.calls.some((call) => call[0] === "deleteUploadsNow")).toBe(false);

    const cancel = elements(dialog).find((element) => element.props["children"] === "Cancel")!;
    (cancel.props["onClick"] as () => void)();
    expect(page.find((element) => element.props["role"] === "alertdialog")).toBeUndefined();
    expect(fake.calls.some((call) => call[0] === "deleteUploadsNow")).toBe(false);
    page.view.unmount();
  });

  it("deletes after the confirmation (only the machine's id crosses) and shows what it did", async () => {
    const { bridge, fake } = settingsBridge();
    const page = mountSettings("uploads", { bridge, hosts: [sshHost("studio", "Studio")] });
    await flush();
    (page.part("UploadsLine")!.props["onDelete"] as () => void)();
    (page.find((element) => element.props["data-confirm"] === "delete")!.props["onClick"] as () => void)();
    await flush();
    expect(fake.calls.filter((call) => call[0] === "deleteUploadsNow")).toEqual([["deleteUploadsNow", "studio"]]);
    expect(uploadsStore.state("studio")).toEqual({ kind: "counted", inventory: { files: 0, bytes: 0 } });
    expect(uploadsStore.outcome("studio")).toMatchObject({ removedFiles: 3 });
    page.view.unmount();
  });

  it("Esc closes the confirmation first, then the page", async () => {
    const listeners: ((event: unknown) => void)[] = [];
    vi.stubGlobal("window", { addEventListener: (_k: string, l: (event: unknown) => void) => listeners.push(l), removeEventListener: () => undefined });
    const events: unknown[][] = [];
    const { bridge } = settingsBridge();
    const page = mountSettings("uploads", { bridge, hosts: [sshHost("studio", "Studio")], events });
    await flush();
    (page.part("UploadsLine")!.props["onDelete"] as () => void)();
    const esc = () => listeners.forEach((listener) => listener({ key: "Escape", defaultPrevented: false, preventDefault: () => undefined }));
    esc();
    expect(page.find((element) => element.props["role"] === "alertdialog")).toBeUndefined();
    expect(events).toEqual([]);
    esc();
    expect(events).toEqual([["onClose"]]);
    page.view.unmount();
  });

  it("a refusal shows as the outcome and nothing is counted as gone", async () => {
    const { bridge, fake } = settingsBridge();
    fake.remove = () => Promise.reject(new Error("Error invoking remote method 'herdr:uploads-delete-now': Error: Uploads are not available for this machine."));
    const page = mountSettings("uploads", { bridge, hosts: [sshHost("studio", "Studio")] });
    await flush();
    (page.part("UploadsLine")!.props["onDelete"] as () => void)();
    (page.find((element) => element.props["data-confirm"] === "delete")!.props["onClick"] as () => void)();
    await flush();
    expect(uploadsStore.outcome("studio")).toBe("Not deleted: Uploads are not available for this machine.");
    expect(uploadsStore.state("studio")).toEqual({ kind: "counted", inventory: { files: 3, bytes: 3_200_000 } });
    page.view.unmount();
  });
});

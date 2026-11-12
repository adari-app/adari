// Attachments, the main process's side, as HerdrKit's upload
// (CitadelTransport.swift uploadLink, AttachmentWritePermits,
// RemoteAttachmentUploadOperation.run): the login folder is asked once per
// link; the folder's REALPATH and STAT, the final file's REALPATH and STAT,
// and the close and the rename are asked together; the writes go 12 × 32 KB
// in flight, shared by the link's uploads; every check stays (the folder 0700,
// the file 0600 of the size written, a temp name renamed, the final verify).
// × stops an upload under way (no write after it, what it made goes) and
// takes one on the machine back (removeUpload: only the uploader's own file,
// checked first, then its folder). A photo is drawn at most 2,048 pixels on
// its longest side; a PNG keeps its size up to 4,096 pixels.

import type { SFTPWrapper } from "ssh2";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LatencySftp } from "./support/latency-sftp";

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

const { ssh2UploadSftp, writeWindow } = await import("../src/main/uploads/sftp");
const { removeUpload, uploadAttachment, uploadStoppedText, notAnUploadText, uploadChangedText } = await import("../src/main/uploads/upload");
const { MemoryUploadSftp } = await import("../src/main/uploads/memory");
const { UploadService } = await import("../src/main/uploads/service");
const { registerIpc } = await import("../src/main/ipc");
const { IPC } = await import("../src/shared/ipc-contract");
const { APP_ORIGIN } = await import("../src/main/protocol");
const { maxDimension, maxPhotoDimension, prepareImage } = await import("../src/renderer/components/image-prepare");

const home = "/Users/fixture";
const link = (rttMs = 65) => new LatencySftp({ rttMs, bytesPerSecond: 1_500_000 }, home);
const files = (sftp: LatencySftp) => ssh2UploadSftp(sftp as unknown as SFTPWrapper);
const bytes = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 7) & 0xff);
const owned = (path: string) => path.startsWith(`${home}/.adari-attachments-`);
const folder = `${home}/.adari-attachments-0123abcd456789ef0123456789abcdef`;
const file = `${folder}/attachment-11111111-2222-4333-8444-555555555555.png`;

async function settle<T>(work: Promise<T>): Promise<T> {
  let done = false;
  const tracked = work.finally(() => {
    done = true;
  });
  // Its failure is the caller's to check, after the timers ran.
  tracked.catch(() => undefined);
  for (let i = 0; i < 2_000 && !done; i += 1) await vi.advanceTimersByTimeAsync(50);
  return tracked;
}

beforeEach(() => {
  vi.useFakeTimers({ now: 0 });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("an upload on a held link", () => {
  it("asks the machine's home once per link", async () => {
    const sftp = link();
    const first = await settle(uploadAttachment(files(sftp), bytes(1_000), "png"));
    const second = await settle(uploadAttachment(files(sftp), bytes(2_000), "jpg"));
    expect(sftp.lines().filter((line) => line === "realpath .")).toEqual(["realpath ."]);
    expect(sftp.file(first.path)?.byteLength).toBe(1_000);
    expect(sftp.file(second.path)?.byteLength).toBe(2_000);
    // Another link asks it again.
    const other = link();
    await settle(uploadAttachment(files(other), bytes(10), "png"));
    expect(other.lines().filter((line) => line === "realpath .")).toEqual(["realpath ."]);
  });

  it("asks the independent checks at once and keeps every one", async () => {
    const sftp = link();
    const remote = await settle(uploadAttachment(files(sftp), bytes(40_000), "png"));
    const folder = remote.path.slice(0, remote.path.lastIndexOf("/"));
    const at = (op: string, path: string) => sftp.requests.find((request) => request.op === op && request.path === path)!.sentAt;
    // The folder: its REALPATH and STAT together; it came out 0700, so no CHMOD.
    expect(at("realpath", folder)).toBe(at("stat", folder));
    expect(sftp.lines().some((line) => line.startsWith("chmod"))).toBe(false);
    const partial = sftp.requests.find((request) => request.op === "open")!.path;
    // The file's mode beside its writes; the close and the rename together once every write is answered.
    expect(at("fchmod", partial)).toBe(at("write", partial));
    expect(at("close", partial)).toBe(at("rename", partial));
    const lastWrite = Math.max(...sftp.requests.filter((request) => request.op === "write").map((request) => request.answeredAt!));
    expect(at("close", partial)).toBeGreaterThanOrEqual(lastWrite);
    // The final file: REALPATH and STAT together, after the rename.
    expect(at("realpath", remote.path)).toBe(at("stat", remote.path));
    expect(at("realpath", remote.path)).toBeGreaterThan(at("rename", partial));
    // Every safety check: a private folder, a 0600 file of the size written under a temp name first.
    expect(sftp.nodes.get(folder)!.mode).toBe(0o040700);
    expect(sftp.nodes.get(remote.path)!.mode).toBe(0o100600);
    expect(partial.endsWith(".uploading")).toBe(true);
    expect(sftp.lines()).toEqual([
      "realpath .",
      `mkdir ${folder}`,
      `realpath ${folder}`,
      `stat ${folder}`,
      `open ${partial}`,
      `fchmod ${partial}`,
      `write ${partial}`,
      `write ${partial}`,
      `close ${partial}`,
      `rename ${partial}`,
      `realpath ${remote.path}`,
      `stat ${remote.path}`,
    ]);
  });

  it("sets and checks the folder's mode again only when it did not come out 0700", async () => {
    const loose = new MemoryUploadSftp(home);
    loose.mkdir = async (path) => {
      loose.requests.push(`mkdir ${path}`);
      loose.addFolder(path, 0, 0o040755);
    };
    const remote = await uploadAttachment(loose, bytes(8), "png");
    const folder = remote.path.slice(0, remote.path.lastIndexOf("/"));
    expect(loose.requests.slice(1, 6)).toEqual([`mkdir ${folder}`, `realpath ${folder}`, `stat ${folder}`, `chmod ${folder}`, `stat ${folder}`]);
    expect(loose.nodes.get(folder)?.mode).toBe(0o040700);
  });

  it("windows the writes: 12 slices of 32 KB in flight, shared by the link's uploads", async () => {
    expect(writeWindow).toBe(12);
    const sftp = link(226);
    const photo = bytes(500_000);
    const remote = await settle(uploadAttachment(files(sftp), photo, "jpg"));
    expect(sftp.file(remote.path)).toEqual(photo);
    expect(sftp.requests.filter((request) => request.op === "write").length).toBe(Math.ceil(500_000 / 32_768));
    expect(sftp.maxWrites).toBe(12);
    // Two uploads at once on one link share the window.
    const shared = link(226);
    const both = await settle(Promise.all([uploadAttachment(files(shared), photo, "jpg"), uploadAttachment(files(shared), bytes(300_000), "jpg")]));
    expect(shared.maxWrites).toBe(12);
    expect(shared.file(both[0].path)).toEqual(photo);
    expect(shared.file(both[1].path)?.byteLength).toBe(300_000);
  });

  it("a stop sends no further write, and what it made goes", async () => {
    const sftp = link(226);
    const stop = new AbortController();
    const upload = uploadAttachment(files(sftp), bytes(500_000), "jpg", undefined, { signal: stop.signal });
    const outcome = upload.then(
      () => "landed",
      (error: Error) => error.message,
    );
    for (let i = 0; i < 200 && !sftp.lines().some((line) => line.startsWith("write")); i += 1) await vi.advanceTimersByTimeAsync(10);
    stop.abort();
    expect(await settle(outcome)).toBe(uploadStoppedText);
    expect(sftp.requests.filter((request) => request.op === "write").length).toBeLessThanOrEqual(12);
    expect(sftp.paths().filter(owned)).toEqual([]);
  });

  it("a write that fails ends the upload and takes back what it made", async () => {
    const sftp = link();
    sftp.failures.set("write", "the link dropped");
    await expect(settle(uploadAttachment(files(sftp), bytes(200_000), "jpg"))).rejects.toThrow("The upload did not finish: the link dropped");
    expect(sftp.paths().filter(owned)).toEqual([]);
  });
});

describe("taking an upload back (× on a chip on the machine)", () => {
  it("checks the folder and the file together, then removes the file and its folder", async () => {
    const sftp = link();
    const remote = await settle(uploadAttachment(files(sftp), bytes(100), "png"));
    const before = sftp.requests.length;
    await settle(removeUpload(files(sftp), remote.path));
    const remoteFolder = remote.path.slice(0, remote.path.lastIndexOf("/"));
    const lines = sftp.lines().slice(before);
    expect(lines).toEqual([`realpath ${remoteFolder}`, `stat ${remoteFolder}`, `realpath ${remote.path}`, `stat ${remote.path}`, `unlink ${remote.path}`, `rmdir ${remoteFolder}`]);
    const sent = sftp.requests.slice(before);
    expect(new Set(sent.slice(0, 4).map((request) => request.sentAt)).size).toBe(1);
    expect(sftp.paths().filter(owned)).toEqual([]);
  });

  it("removes only the uploader's own file, never through a symlink, and one already gone is not a failure", async () => {
    const sftp = new MemoryUploadSftp(home);
    await expect(removeUpload(sftp, `${home}/notes.txt`)).rejects.toThrow(notAnUploadText);
    await expect(removeUpload(sftp, `/elsewhere/.adari-attachments-0123abcd456789ef0123456789abcdef/attachment-11111111-2222-4333-8444-555555555555.png`)).rejects.toThrow(
      notAnUploadText,
    );
    await removeUpload(sftp, file);
    sftp.addFolder(folder, 0);
    await removeUpload(sftp, file);
    expect(sftp.nodes.has(folder)).toBe(false);
    // A folder that is a symlink now: left there.
    sftp.addFolder("/tmp", 0, 0o040755);
    sftp.addFolder("/tmp/other", 0);
    sftp.addFile("/tmp/other/attachment-11111111-2222-4333-8444-555555555555.png", bytes(4), 0);
    sftp.addSymlink(folder, "/tmp/other");
    await expect(removeUpload(sftp, file)).rejects.toThrow(uploadChangedText);
    expect(sftp.file("/tmp/other/attachment-11111111-2222-4333-8444-555555555555.png")).not.toBeNull();
  });
});

describe("the main process's uploads", () => {
  const backend = (uploads: object) => ({ backend: () => ({ uploads: () => uploads }) }) as never;
  const log = { lastSweep: () => null, noteSweep: () => undefined };

  it("× on a chip uploading stops that upload only", async () => {
    vi.useRealTimers();
    const signals: (AbortSignal | undefined)[] = [];
    const service = new UploadService(
      backend({
        machineKey: "m",
        upload: (_data: Uint8Array, _extension: string, signal?: AbortSignal) =>
          new Promise((resolve, reject) => {
            signals.push(signal);
            signal?.addEventListener("abort", () => reject(new Error(uploadStoppedText)));
            if (signal === undefined) resolve({ path: "/p", byteCount: 1 });
          }),
        withFiles: async () => null,
      }),
      log,
    );
    const first = service.upload("h", bytes(1), "png", "upload-a");
    const second = service.upload("h", bytes(1), "png", "upload-b");
    service.cancel("upload-a");
    await expect(first).rejects.toThrow(uploadStoppedText);
    expect(signals[1]?.aborted).toBe(false);
    service.cancel("upload-b");
    await expect(second).rejects.toThrow(uploadStoppedText);
    // No id (the terminal's uploads): no stop signal, and the upload completes.
    await expect(service.upload("h", bytes(1), "png")).resolves.toEqual({ path: "/p", byteCount: 1 });
  });

  it("× on a chip on the machine removes it there and no longer keeps it from the sweep", async () => {
    vi.useRealTimers();
    const discarded: string[] = [];
    const path = "/Users/fixture/.adari-attachments-0123abcd456789ef0123456789abcdef/attachment-11111111-2222-4333-8444-555555555555.png";
    const service = new UploadService(
      backend({
        machineKey: "m",
        upload: async () => ({ path, byteCount: 1 }),
        discard: async (removed: string) => void discarded.push(removed),
        withFiles: async () => null,
      }),
      log,
    );
    await service.upload("h", bytes(1), "png", "upload-a");
    expect(service.names(path)).toBe(true);
    await service.discard("h", path);
    expect(discarded).toEqual([path]);
    expect(service.names(path)).toBe(false);
  });

  it("the discard channel takes only one of the uploader's own paths, and cancel only an id", async () => {
    vi.useRealTimers();
    const discards: string[] = [];
    const cancels: string[] = [];
    registered.handles.clear();
    registerIpc({
      info: {} as never,
      hosts: { list: () => [], refreshAll: async () => [] } as never,
      terminals: {} as never,
      chat: {} as never,
      changes: {} as never,
      layouts: {} as never,
      ghostty: {} as never,
      copyText: () => undefined,
      uploadAttachment: async () => ({ path: "/p", byteCount: 1 }),
      cancelUpload: (id: string) => void cancels.push(id),
      discardAttachment: async (_host: string, path: string) => void discards.push(path),
      clipboardFiles: async () => ({ files: [], refused: [], excess: [], failures: [] }),
      addHost: () => [],
      updateHost: () => [],
      removeHost: () => [],
      hostSettings: () => null,
      retryHost: async () => [],
      trustHostKey: async () => [],
      cancelHostKey: async () => [],
      pickKeyFile: async () => null,
      commandDone: () => undefined,
      redact: (text: string) => text,
    } as never);
    const event = { senderFrame: { url: APP_ORIGIN }, sender: { id: 1 } };
    const discard = registered.handles.get(IPC.attachmentDiscard)!;
    await (async () => discard(event, "a", file))();
    expect(discards).toEqual([file]);
    for (const bad of [`${home}/Documents/key.pem`, `${folder}/../x/attachment-11111111-2222-4333-8444-555555555555.png`, "relative/attachment-1.png", `${folder}/attachment-1.sh`]) {
      await expect((async () => discard(event, "a", bad))()).rejects.toThrow("bad request");
    }
    expect(discards).toEqual([file]);
    const cancel = registered.ons.get(IPC.attachmentCancel)!;
    cancel(event, "upload-1");
    cancel(event, 42);
    expect(cancels).toEqual(["upload-1"]);
  });
});

describe("a photo as it uploads", () => {
  function stubCanvas(width: number, height: number) {
    const drawn: { width: number; height: number; type: string; quality: number | undefined }[] = [];
    vi.stubGlobal("createImageBitmap", async () => ({ width, height, close: () => undefined }));
    vi.stubGlobal(
      "OffscreenCanvas",
      class {
        constructor(
          readonly width: number,
          readonly height: number,
        ) {}
        getContext() {
          return { fillStyle: "", fillRect: () => undefined, drawImage: () => undefined };
        }
        async convertToBlob(options: { type: string; quality?: number }) {
          drawn.push({ width: this.width, height: this.height, type: options.type, quality: options.quality });
          return new Blob([new Uint8Array(16)]);
        }
      },
    );
    return drawn;
  }
  const source = (name: string, type: string) => ({ name, type, size: 1_000, bytes: async () => new Uint8Array(1_000) });

  it("draws a photo (JPEG or HEIC) at most 2,048 on its longest side, as JPEG 0.86", async () => {
    vi.useRealTimers();
    expect(maxPhotoDimension).toBe(2_048);
    const drawn = stubCanvas(4_032, 3_024);
    expect((await prepareImage(source("IMG_0001.JPG", "image/jpeg"))).extension).toBe("jpg");
    expect((await prepareImage(source("IMG_0002.HEIC", ""))).extension).toBe("jpg");
    expect(drawn).toEqual([
      { width: 2_048, height: 1_536, type: "image/jpeg", quality: 0.86 },
      { width: 2_048, height: 1_536, type: "image/jpeg", quality: 0.86 },
    ]);
  });

  it("keeps a PNG screenshot as it is, and a large PNG at 4,096", async () => {
    vi.useRealTimers();
    expect(maxDimension).toBe(4_096);
    const screenshot = stubCanvas(2_880, 1_800);
    expect((await prepareImage(source("Screenshot 2026-11-09.png", "image/png"))).extension).toBe("png");
    expect(screenshot).toEqual([{ width: 2_880, height: 1_800, type: "image/png", quality: undefined }]);
    const large = stubCanvas(6_000, 4_000);
    await prepareImage(source("diagram.png", "image/png"));
    await prepareImage(source("clip.webp", "image/webp"));
    expect(large.map((d) => `${d.width}x${d.height} ${d.type}`)).toEqual(["4096x2730 image/png", "4096x2730 image/png"]);
  });
});

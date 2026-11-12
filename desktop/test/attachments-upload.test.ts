// An attachment uploads over the machine's SFTP to
// the Swift app's folder scheme (`<home>/.adari-attachments-<32 hex>/attachment-<uuid>.<ext>`,
// the folder 0700, the file 0600), checked at every step and taken back when a
// step fails; the message carries the text then each path, as the Swift app's
// `joined` writes it; the 30-day sweep removes only the uploader's own old
// files (UploadSweep.swift); a Finder copy's files are read for a paste.

import { describe, expect, it } from "vitest";

import { isOwnedUploadPath, joinedMessage, maxUploadBytes, safeUploadExtension, uploadKind } from "../src/shared/attachments";
import { sentAttachments } from "../src/shared/chat/pending";
import { ChatAttachmentText } from "../src/shared/chat/tools";
import { clipboardPaths, osFormat, readClipboardFiles } from "../src/main/uploads/clipboard-files";
import { MemoryUploadSftp } from "../src/main/uploads/memory";
import { UploadService } from "../src/main/uploads/service";
import { isSweepDue, maximumAgeMs, runSweepIfDue, sweepUploads, type UploadSweepLog } from "../src/main/uploads/sweep";
import { uploadAttachment, UploadNotFoundError } from "../src/main/uploads/upload";

const home = "/Users/fixture";
const uuids = (...values: string[]) => {
  const queue = [...values];
  return () => queue.shift() ?? "99999999-9999-4999-8999-999999999999";
};
const nonceUUID = "0123ABCD-4567-89EF-0123-456789ABCDEF";
const fileUUID = "11111111-2222-4333-8444-555555555555";
const folder = `${home}/.adari-attachments-0123abcd456789ef0123456789abcdef`;
const finalPath = `${folder}/attachment-${fileUUID}.png`;
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

describe("an upload to the machine", () => {
  it("writes the Swift app's private folder and file, and returns the path", async () => {
    const sftp = new MemoryUploadSftp(home, () => 1_000);
    const remote = await uploadAttachment(sftp, png, "png", uuids(nonceUUID, fileUUID));
    expect(remote).toEqual({ path: finalPath, byteCount: png.byteLength });
    expect(isOwnedUploadPath(remote.path, home)).toBe(true);
    expect(sftp.file(finalPath)).toEqual(png);
    expect(sftp.nodes.get(folder)?.mode).toBe(0o040700);
    expect(sftp.nodes.get(finalPath)?.mode).toBe(0o100600);
    // Partial written first, renamed, then checked. The folder's REALPATH and STAT are asked
    // together, and its mode is set again only when it did not come out 0700 (mkdir made it 0700 here).
    expect(sftp.requests).toEqual([
      "realpath .",
      `mkdir ${folder}`,
      `realpath ${folder}`,
      `stat ${folder}`,
      `writeNew ${folder}/.attachment-${fileUUID}.uploading`,
      `rename ${folder}/.attachment-${fileUUID}.uploading`,
      `realpath ${finalPath}`,
      `stat ${finalPath}`,
    ]);
  });

  it("names a JPEG .jpg and refuses a kind that does not upload, or one over 12 MB", async () => {
    const sftp = new MemoryUploadSftp(home);
    const jpeg = await uploadAttachment(sftp, png, "JPEG", uuids(nonceUUID, fileUUID));
    expect(jpeg.path.endsWith(".jpg")).toBe(true);
    await expect(uploadAttachment(sftp, png, "sh")).rejects.toThrow("The selected image could not be converted to PNG or JPEG.");
    await expect(uploadAttachment(sftp, new Uint8Array(maxUploadBytes + 1), "png")).rejects.toThrow(
      "The image is too large to upload. Choose one under 12 MB.",
    );
    expect(safeUploadExtension("markdown")).toBe("md");
    expect(safeUploadExtension("exe")).toBeNull();
  });

  it("takes back what it made when a step fails, and says why", async () => {
    const sftp = new MemoryUploadSftp(home);
    sftp.fail("rename", new Error("the link dropped"));
    await expect(uploadAttachment(sftp, png, "png", uuids(nonceUUID, fileUUID))).rejects.toThrow("The upload did not finish: the link dropped");
    expect(sftp.paths().filter((path) => path.includes(".adari-attachments-"))).toEqual([]);
  });

  it("refuses a folder that is not private, and an unsafe home", async () => {
    const loose = new MemoryUploadSftp(home);
    loose.chmod = async () => undefined;
    loose.mkdir = async (path) => loose.addFolder(path, 0, 0o040755);
    await expect(uploadAttachment(loose, png, "png", uuids(nonceUUID, fileUUID))).rejects.toThrow(
      "The attachment directory on the Mac is not private (0700).",
    );
    expect(loose.paths().some((path) => path.includes(".adari-attachments-"))).toBe(false);
    const odd = new MemoryUploadSftp(home);
    odd.realpath = async () => "relative/home";
    await expect(uploadAttachment(odd, png, "png")).rejects.toThrow("The Mac returned an unsafe home-directory path.");
  });
});

describe("the message an upload goes with", () => {
  const path = finalPath;
  it("is the text, then each path, by single spaces (CompanionComposerSession.joined)", () => {
    expect(joinedMessage("look at this", [path])).toBe(`look at this ${path}`);
    expect(joinedMessage("look at this ", [path])).toBe(`look at this ${path}`);
    expect(joinedMessage("two lines\n", [path, path.replace(".png", ".jpg")])).toBe(`two lines\n${path} ${path.replace(".png", ".jpg")}`);
    expect(joinedMessage("", [path])).toBe(path);
    expect(joinedMessage("no pictures", [])).toBe("no pictures");
  });

  it("reads back as the user's text with the attachments (the transcript's parser and the pending bubble's count)", () => {
    const sent = joinedMessage("look at this", [path, path.replace(".png", ".jpg")]);
    const extracted = ChatAttachmentText.extract(sent);
    expect(extracted.text).toBe("look at this");
    expect(extracted.attachments.map((attachment) => attachment.path)).toEqual([path, path.replace(".png", ".jpg")]);
    expect(sentAttachments(sent)).toEqual({ paths: [path, path.replace(".png", ".jpg")], count: 2 });
  });

  it("takes images and the Files kinds, nothing else", () => {
    expect(uploadKind("shot.png", "image/png")).toEqual({ kind: "image" });
    expect(uploadKind("photo.HEIC", "")).toEqual({ kind: "image" });
    expect(uploadKind("build.log", "")).toEqual({ kind: "file", extension: "log" });
    expect(uploadKind("notes.markdown", "text/markdown")).toEqual({ kind: "file", extension: "md" });
    expect(uploadKind("tool.sh", "text/x-sh")).toEqual({ kind: "unsupported" });
  });
});

describe("the 30-day sweep", () => {
  const day = 24 * 60 * 60 * 1_000;
  const now = 100 * day;
  const old = now - maximumAgeMs - day;
  const oldFolder = `${home}/.herdr-companion-attachments-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`;
  const newFolder = `${home}/.herdr-companion-attachments-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`;
  const oldFile = `${oldFolder}/attachment-11111111-1111-4111-8111-111111111111.png`;
  const newFile = `${newFolder}/attachment-22222222-2222-4222-8222-222222222222.jpg`;

  function machine(): MemoryUploadSftp {
    const sftp = new MemoryUploadSftp(home);
    sftp.addFolder(oldFolder, old);
    sftp.addFile(oldFile, png, old);
    sftp.addFolder(newFolder, now - day);
    sftp.addFile(newFile, png, now - day);
    return sftp;
  }

  it("removes uploads older than 30 days and their emptied folder, keeps newer ones", async () => {
    const sftp = machine();
    const result = await sweepUploads(sftp, now, maximumAgeMs);
    expect(result).toEqual({ removedFiles: 1, removedBytes: png.byteLength, removedFolders: 1, keptFiles: 0, stopped: null });
    expect(sftp.file(oldFile)).toBeNull();
    expect(sftp.nodes.has(oldFolder)).toBe(false);
    expect(sftp.file(newFile)).toEqual(png);
  });

  it("never touches another name, a symlink, or an upload this device still names", async () => {
    const sftp = machine();
    const stranger = `${oldFolder}/notes.txt`;
    sftp.addFile(stranger, png, old);
    sftp.addFile(`${home}/attachment-33333333-3333-4333-8333-333333333333.png`, png, old);
    const linked = `${home}/.herdr-companion-attachments-cccccccccccccccccccccccccccccccc`;
    sftp.addFolder(`${home}/elsewhere`, old);
    sftp.addFile(`${home}/elsewhere/attachment-44444444-4444-4444-8444-444444444444.png`, png, old);
    sftp.addSymlink(linked, `${home}/elsewhere`);
    const result = await sweepUploads(sftp, now, maximumAgeMs, (path) => path === oldFile);
    expect(result.removedFiles).toBe(0);
    expect(result.keptFiles).toBe(1);
    expect(sftp.file(oldFile)).toEqual(png);
    expect(sftp.file(stranger)).toEqual(png);
    expect(sftp.file(`${home}/elsewhere/attachment-44444444-4444-4444-8444-444444444444.png`)).toEqual(png);
  });

  it("stops quietly at a failure and says why; a file already gone is not one", async () => {
    const sftp = machine();
    // Gone between the listing and the removal (another device's sweep).
    sftp.unlink = async (path) => {
      sftp.nodes.delete(path);
      throw new UploadNotFoundError(path);
    };
    expect((await sweepUploads(sftp, now, maximumAgeMs)).stopped).toBeNull();
    const failing = machine();
    failing.fail(`unlink ${oldFile}`, new Error("permission denied"));
    expect((await sweepUploads(failing, now, maximumAgeMs)).stopped).toBe("permission denied");
  });

  it("runs once a day per machine, noted before it starts", async () => {
    const notes = new Map<string, number>();
    const log: UploadSweepLog = { lastSweep: (m) => notes.get(m) ?? null, noteSweep: (m, at) => notes.set(m, at) };
    expect(await runSweepIfDue("me@mac:22", machine(), log, now)).not.toBeNull();
    expect(notes.get("me@mac:22")).toBe(now);
    expect(await runSweepIfDue("me@mac:22", machine(), log, now + day / 2)).toBeNull();
    expect(isSweepDue(now, now + day)).toBe(true);
    expect(isSweepDue(now, now - 2 * day)).toBe(true);
  });

  it("starts when a machine connects, keeps what this run uploaded, and says when a machine takes no uploads", async () => {
    const sftp = machine();
    const notes = new Map<string, number>();
    const log: UploadSweepLog = { lastSweep: (m) => notes.get(m) ?? null, noteSweep: (m, at) => notes.set(m, at) };
    let sweeps = 0;
    const backend = {
      uploads: () => ({
        machineKey: "me@mac:22",
        upload: (data: Uint8Array, extension: string) => uploadAttachment(sftp, data, extension),
        withFiles: <T>(work: (s: MemoryUploadSftp) => Promise<T>) => {
          sweeps += 1;
          return work(sftp);
        },
      }),
    };
    const service = new UploadService({ backend: (id) => (id === "mac" ? (backend as never) : ({} as never)) }, log, () => now);
    const sent = await service.upload("mac", png, "png");
    expect(service.names(sent.path)).toBe(true);
    service.hostsChanged([{ id: "mac", state: "connecting" } as never]);
    expect(sweeps).toBe(0);
    service.hostsChanged([{ id: "mac", state: "connected" } as never]);
    service.hostsChanged([{ id: "mac", state: "connected" } as never]);
    expect(sweeps).toBe(1);
    await expect(service.upload("demo-less", png, "png")).rejects.toThrow("Uploads are not available for this machine.");
  });
});

describe("files copied in the Finder", () => {
  const source = (formats: Record<string, string>) => ({ read: async (format: string) => formats[format] ?? "" });

  it("are named by the file URL list, else macOS's file list, else one file URL", async () => {
    expect(await clipboardPaths(source({ "text/uri-list": "file:///Users/me/Desktop/shot%201.png\r\nfile:///Users/me/a.log" }))).toEqual([
      "/Users/me/Desktop/shot 1.png",
      "/Users/me/a.log",
    ]);
    const plist = `<plist><array><string>/Users/me/a &amp; b.png</string><string>/Users/me/c.pdf</string></array></plist>`;
    expect(await clipboardPaths(source({ [osFormat("NSFilenamesPboardType")]: plist }))).toEqual(["/Users/me/a & b.png", "/Users/me/c.pdf"]);
    expect(await clipboardPaths(source({ [osFormat("public.file-url")]: "file:///Users/me/one.png" }))).toEqual(["/Users/me/one.png"]);
    expect(await clipboardPaths(source({}))).toEqual([]);
  });

  it("are read by the picker's kinds and limits", async () => {
    const files = {
      statSync: (path: string) => ({ isFile: () => !path.endsWith("folder.png"), size: path.endsWith("big.pdf") ? maxUploadBytes + 1 : 3 }),
      readFileSync: () => Buffer.from([1, 2, 3]),
    };
    const list = ["/a/shot.png", "/a/tool.sh", "/a/big.pdf", "/a/folder.png"].map((p) => `file://${p}`).join("\n");
    const read = await readClipboardFiles(source({ "text/uri-list": list }), files as never);
    expect(read.files.map((file) => [file.name, [...file.data]])).toEqual([["shot.png", [1, 2, 3]]]);
    expect(read.refused).toEqual(["tool.sh", "folder.png"]);
    expect(read.failures).toEqual(["big.pdf: The file is too large to upload. Choose one under 12 MB."]);
  });
});

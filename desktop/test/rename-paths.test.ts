// The app is Adari. New uploads go to `<home>/.adari-attachments-<32 hex>/`,
// and the start commands are `~/.adari/agents.json`; the paths from before the
// rename (`.herdr-companion-attachments-<32 hex>`, `~/.herdr-companion/agents.json`)
// are still read: an older upload still shows and is still swept after 30
// days, and the old agents.json is used while the new one is absent. Nothing
// is ever written under the old names.

import { describe, expect, it } from "vitest";

import { isOwnedUploadPath, isUploadFolderName, uploadFolderPrefix } from "../src/shared/attachments";
import { sentAttachments } from "../src/shared/chat/pending";
import { ChatAttachmentText } from "../src/shared/chat/tools";
import {
  legacyStartCommandsRelativePath,
  parseStartCommands,
  readFirstStartCommandsFile,
  startCommandsDisplayPath,
  startCommandsRelativePath,
  typedStart,
} from "../src/shared/start-commands";
import { MemoryUploadSftp } from "../src/main/uploads/memory";
import { maximumAgeMs, sweepUploads } from "../src/main/uploads/sweep";
import { uploadAttachment } from "../src/main/uploads/upload";

const home = "/Users/fixture";
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
const hex = (c: string) => c.repeat(32);
const oldFolder = (c: string) => `${home}/.herdr-companion-attachments-${hex(c)}`;
const newFolder = (c: string) => `${home}/.adari-attachments-${hex(c)}`;
const file = (folder: string, c: string) => `${folder}/attachment-${c.repeat(8)}-${c.repeat(4)}-4${c.repeat(3)}-8${c.repeat(3)}-${c.repeat(12)}.png`;

describe("uploads under the new and the old folder names", () => {
  it("lands a new upload under .adari-attachments-<hex>", async () => {
    const sftp = new MemoryUploadSftp(home);
    const remote = await uploadAttachment(sftp, png, "png");
    expect(uploadFolderPrefix).toBe(".adari-attachments-");
    expect(remote.path.startsWith(`${home}/.adari-attachments-`)).toBe(true);
    expect(isOwnedUploadPath(remote.path, home)).toBe(true);
    expect(sftp.paths().some((path) => path.includes(".herdr-companion-attachments-"))).toBe(false);
  });

  it("still shows an image under the old prefix, and one under the new", () => {
    const old = file(oldFolder("a"), "1");
    const fresh = file(newFolder("b"), "2");
    const sent = `look ${old} ${fresh}`;
    const extracted = ChatAttachmentText.extract(sent);
    expect(extracted.text).toBe("look");
    expect(extracted.attachments.map((attachment) => attachment.path)).toEqual([old, fresh]);
    expect(sentAttachments(sent)).toEqual({ paths: [old, fresh], count: 2 });
    expect(isOwnedUploadPath(old, home)).toBe(true);
    expect(isOwnedUploadPath(fresh, home)).toBe(true);
    expect(isUploadFolderName(`.herdr-companion-attachments-${hex("c")}`)).toBe(true);
    expect(isUploadFolderName(`.adari-attachments-${hex("c")}`)).toBe(true);
  });

  it("sweeps uploads under either prefix after 30 days, and keeps newer ones", async () => {
    const day = 24 * 60 * 60 * 1_000;
    const now = 100 * day;
    const old = now - maximumAgeMs - day;
    const sftp = new MemoryUploadSftp(home);
    const entries: [string, number][] = [
      [oldFolder("a"), old],
      [newFolder("b"), old],
      [oldFolder("c"), now - day],
      [newFolder("d"), now - day],
    ];
    for (const [folder, at] of entries) {
      sftp.addFolder(folder, at);
      sftp.addFile(file(folder, "1"), png, at);
    }
    const result = await sweepUploads(sftp, now, maximumAgeMs);
    expect(result).toEqual({ removedFiles: 2, removedBytes: 2 * png.byteLength, removedFolders: 2, keptFiles: 0, stopped: null });
    expect(sftp.nodes.has(oldFolder("a"))).toBe(false);
    expect(sftp.nodes.has(newFolder("b"))).toBe(false);
    expect(sftp.file(file(oldFolder("c"), "1"))).toEqual(png);
    expect(sftp.file(file(newFolder("d"), "1"))).toEqual(png);
  });

  it("never sweeps a path that merely contains either name outside the home-level folder", async () => {
    const day = 24 * 60 * 60 * 1_000;
    const now = 100 * day;
    const old = now - maximumAgeMs - day;
    const sftp = new MemoryUploadSftp(home);
    const nested = [`${home}/Code/.adari-attachments-${hex("e")}`, `${home}/Code/.herdr-companion-attachments-${hex("f")}`];
    const lookalike = [`${home}/x.adari-attachments-${hex("1")}`, `${home}/x.herdr-companion-attachments-${hex("2")}`];
    sftp.addFolder(`${home}/Code`, old);
    for (const folder of [...nested, ...lookalike]) {
      sftp.addFolder(folder, old);
      sftp.addFile(file(folder, "3"), png, old);
    }
    const result = await sweepUploads(sftp, now, 0);
    expect(result.removedFiles).toBe(0);
    expect(result.removedFolders).toBe(0);
    for (const folder of [...nested, ...lookalike]) {
      expect(sftp.file(file(folder, "3"))).toEqual(png);
      expect(isOwnedUploadPath(file(folder, "3"), home)).toBe(false);
    }
  });
});

describe("the start commands file, new and old", () => {
  const cl = new TextEncoder().encode(JSON.stringify({ claude: "cl" }));
  const cx = new TextEncoder().encode(JSON.stringify({ claude: "cx" }));
  const reader = (files: Record<string, Uint8Array>) => {
    const asked: string[] = [];
    const read = async (path: string) => (asked.push(path), files[path] ?? null);
    return { asked, read };
  };

  it("is ~/.adari/agents.json, the old ~/.herdr-companion/agents.json read only while it is absent", () => {
    expect(startCommandsRelativePath).toBe(".adari/agents.json");
    expect(startCommandsDisplayPath).toBe("~/.adari/agents.json");
    expect(legacyStartCommandsRelativePath).toBe(".herdr-companion/agents.json");
  });

  it("takes the new file when both are there, and does not read the old one", async () => {
    const { asked, read } = reader({ ".adari/agents.json": cx, ".herdr-companion/agents.json": cl });
    const commands = parseStartCommands(await readFirstStartCommandsFile(read));
    expect(typedStart(commands, "claude")).toEqual({ type: "typed", command: "cx" });
    expect(asked).toEqual([".adari/agents.json"]);
  });

  it("reads the old file when the new one is absent", async () => {
    const { asked, read } = reader({ ".herdr-companion/agents.json": cl });
    const commands = parseStartCommands(await readFirstStartCommandsFile(read));
    expect(typedStart(commands, "claude")).toEqual({ type: "typed", command: "cl" });
    expect(asked).toEqual([".adari/agents.json", ".herdr-companion/agents.json"]);
  });

  it("uses Herdr's own start command when neither is there", async () => {
    const { read } = reader({});
    const commands = parseStartCommands(await readFirstStartCommandsFile(read));
    expect(commands.status).toEqual({ type: "absent" });
    expect(typedStart(commands, "claude")).toEqual({ type: "herdr", notTyped: null });
  });

  it("does not fall back when the new file could not be read (the failure is reported)", async () => {
    const read = async (path: string) => {
      if (path === ".adari/agents.json") throw new Error("permission denied");
      return cl;
    };
    await expect(readFirstStartCommandsFile(read)).rejects.toThrow("permission denied");
  });
});

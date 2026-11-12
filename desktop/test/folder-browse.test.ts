// The folder field's list, its pure rules and the main side.
// What is typed becomes a folder and a filter (T3 Code's getFilesystemBrowsePath),
// the names shown (folders only, sorted, hidden ones only for a "." filter, at
// most 200), and one folder read on a fake machine with macOS and Linux paths:
// its home for "~", a missing, file or unreadable folder said so, the read
// capped and never recursive, links to folders followed (a few). The same
// reader on This Mac's LocalSftp over a temp tree (never the real home), the
// IPC doors (offline, unavailable, bad requests), and Choose… (This Mac only,
// the folder window mocked).

import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

const registered = vi.hoisted(() => ({ handles: new Map<string, (...args: unknown[]) => unknown>() }));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, listener: (...args: unknown[]) => unknown) => registered.handles.set(channel, listener),
    on: () => undefined,
  },
}));

import {
  browseQuery,
  enteredFolder,
  isBrowseDirectory,
  listingLine,
  maxLinksFollowed,
  maxReadEntries,
  maxShownFolders,
  pickedFolder,
  sortFolderNames,
  visibleFolders,
  type FolderListing,
} from "../src/shared/folder-browse";
import { browseFolder, sftpFolderReader } from "../src/main/folder-browse";
import { folderPickOptions, folderPickStart, pickFolderOnThisMac, typedFolderOnThisMac } from "../src/main/folder-pick";
import { DemoFolderTree, demoFolderTree } from "../src/main/demo/demo-folders";
import { LocalSftp } from "../src/main/herdr/local";
import type { HostView } from "../src/shared/ipc-contract";

const { registerIpc } = await import("../src/main/ipc");
const { APP_ORIGIN } = await import("../src/main/protocol");
const { IPC } = await import("../src/shared/ipc-contract");

const scratchRoot = process.env["HERDR_TEST_SCRATCH"] ?? os.tmpdir();

/** A fake machine: macOS's home and a project tree, or Linux's. */
function machine(platform: "macOS" | "Linux"): DemoFolderTree {
  const home = platform === "macOS" ? "/Users/r" : "/home/r";
  const tree = new DemoFolderTree(home);
  for (const name of ["Code", "Desktop", "Documents", "code-old", ".config", ".ssh-fake"]) tree.addFolder(`${home}/${name}`);
  for (const name of ["koala", "Kiosk", "app", "app2", "app10"]) tree.addFolder(`${home}/Code/${name}`);
  tree.addFolder(`${home}/Code/koala/src/deep/deeper`);
  tree.addFile(`${home}/Code/README.md`);
  tree.addFile(`${home}/notes.txt`);
  tree.addFolder(`${home}/private`, true);
  return tree;
}

describe("what is typed: the folder to list and the filter", () => {
  it("a / or ~ path lists the folder before its last segment, filtered by that segment", () => {
    expect(browseQuery("~")).toEqual({ directory: "~/", filter: "" });
    expect(browseQuery("~/")).toEqual({ directory: "~/", filter: "" });
    expect(browseQuery("~/Co")).toEqual({ directory: "~/", filter: "Co" });
    expect(browseQuery("~/Code/ku")).toEqual({ directory: "~/Code/", filter: "ku" });
    expect(browseQuery("/Users/r/")).toEqual({ directory: "/Users/r/", filter: "" });
    expect(browseQuery("/home/r/.co")).toEqual({ directory: "/home/r/", filter: ".co" });
    expect(browseQuery("/")).toEqual({ directory: "/", filter: "" });
    expect(browseQuery("  /srv/  ")).toEqual({ directory: "/srv/", filter: "" });
  });

  it("anything else lists nothing: empty, relative, another account's ~name", () => {
    for (const typed of ["", "   ", "code/app", "./app", "~root", "~root/x"]) expect(browseQuery(typed)).toBeNull();
  });

  it("main is asked only for a one-line / or ~/ folder ending in /", () => {
    expect(isBrowseDirectory("~/")).toBe(true);
    expect(isBrowseDirectory("/Users/r/Code/")).toBe(true);
    for (const bad of ["~", "/Users/r", "code/", "~root/", "/a\n/", `/${"x".repeat(5_000)}/`, 7, null]) expect(isBrowseDirectory(bad)).toBe(false);
  });

  it("a pick appends the name; Tab appends it with / to list inside it", () => {
    expect(pickedFolder("~/Code/", "koala")).toBe("~/Code/koala");
    expect(enteredFolder("~/Code/", "koala")).toBe("~/Code/koala/");
    expect(enteredFolder("/", "srv")).toBe("/srv/");
  });
});

describe("the names shown", () => {
  const names = sortFolderNames(["koala", "Kiosk", ".config", "app10", "app2", "app", "Code", "code-old"]);

  it("sorted by name, any case, numbers by value", () => {
    expect(names).toEqual([".config", "app", "app2", "app10", "Code", "code-old", "Kiosk", "koala"]);
  });

  it("filtered by the start of the name, any case; hidden ones only when the filter starts with .", () => {
    expect(visibleFolders(names, "").shown).toEqual(["app", "app2", "app10", "Code", "code-old", "Kiosk", "koala"]);
    expect(visibleFolders(names, "k").shown).toEqual(["Kiosk", "koala"]);
    expect(visibleFolders(names, "CO").shown).toEqual(["Code", "code-old"]);
    expect(visibleFolders(names, ".").shown).toEqual([".config"]);
    expect(visibleFolders(names, ".c").shown).toEqual([".config"]);
    expect(visibleFolders(names, "zz").shown).toEqual([]);
  });

  it("at most 200 shown, with how many more", () => {
    const many = sortFolderNames(Array.from({ length: 250 }, (_, i) => `f${i}`));
    const { shown, more } = visibleFolders(many, "");
    expect(shown).toHaveLength(maxShownFolders);
    expect(more).toBe(50);
  });

  it("each listing that shows no folder has its plain line", () => {
    const q = browseQuery("~/Code/zz")!;
    expect(listingLine({ type: "listed", folder: "/Users/r/Code", names: [], truncated: false }, browseQuery("~/Code/")!, "Mini", 0)).toBe("No folders in ~/Code");
    expect(listingLine({ type: "listed", folder: "/Users/r/Code", names: ["koala"], truncated: false }, q, "Mini", 0)).toBe("No folder in ~/Code starts with zz");
    expect(listingLine({ type: "missing", folder: "/Users/r/Code" }, q, "Mini", 0)).toBe("There is no ~/Code on Mini");
    expect(listingLine({ type: "not-folder", folder: "/Users/r/Code" }, q, "Mini", 0)).toBe("~/Code is a file on Mini, not a folder");
    expect(listingLine({ type: "unreadable", folder: "/Users/r/Code", reason: "permission denied" }, q, "Mini", 0)).toBe("Mini cannot read ~/Code (permission denied)");
    expect(listingLine({ type: "offline" }, q, "Mini", 0)).toBe("Mini is not answering, so its folders cannot be listed");
    expect(listingLine({ type: "unavailable" }, q, "Mini", 0)).toBe("Mini cannot list folders from here");
    expect(listingLine({ type: "listed", folder: "/Users/r/Code", names: ["koala"], truncated: false }, q, "Mini", 1)).toBeNull();
  });
});

describe.each(["macOS", "Linux"] as const)("one folder on a %s machine", (platform) => {
  const home = platform === "macOS" ? "/Users/r" : "/home/r";

  it("~/ is the machine's home: its folders only (no files), sorted, hidden ones kept for the filter", async () => {
    const tree = machine(platform);
    expect(await browseFolder(tree, "~/")).toEqual({
      type: "listed",
      folder: home,
      names: [".config", ".ssh-fake", "Code", "code-old", "Desktop", "Documents", "private"],
      truncated: false,
    });
    expect(tree.listed).toEqual([home]);
  });

  it("a typed path: that folder alone, never what is inside its folders", async () => {
    const tree = machine(platform);
    const listing = await browseFolder(tree, `${home}/Code/`);
    expect(listing).toMatchObject({ type: "listed", folder: `${home}/Code`, names: ["app", "app2", "app10", "Kiosk", "koala"] });
    expect(tree.listed).toEqual([`${home}/Code`]);
    expect(await browseFolder(tree, "~/Code/koala/")).toMatchObject({ folder: `${home}/Code/koala`, names: ["src"] });
    expect(tree.listed).toEqual([`${home}/Code`, `${home}/Code/koala`]);
  });

  it("a missing folder, a file and a folder it may not read are said so, never thrown", async () => {
    const tree = machine(platform);
    expect(await browseFolder(tree, "~/nope/")).toEqual({ type: "missing", folder: `${home}/nope` });
    expect(await browseFolder(tree, "~/notes.txt/")).toEqual({ type: "not-folder", folder: `${home}/notes.txt` });
    expect(await browseFolder(tree, "~/private/")).toEqual({ type: "unreadable", folder: `${home}/private`, reason: "permission denied" });
  });

  it("the root and .. read as the folder they name", async () => {
    const tree = machine(platform);
    expect(await browseFolder(tree, "/")).toMatchObject({ type: "listed", folder: "/", names: [platform === "macOS" ? "Users" : "home"] });
    expect(await browseFolder(tree, "~/Code/../")).toMatchObject({ type: "listed", folder: home });
  });
});

describe("the demo machines' invented trees", () => {
  it("Mac mini: its invented projects with a pane's folder among them; build-box: /root; nothing of this Mac's", async () => {
    const mini = demoFolderTree("macOS", { panes: [{ cwd: "/Users/demo/code/aurora-web" }] });
    expect(await browseFolder(mini, "/Users/demo/code/")).toMatchObject({ names: expect.arrayContaining(["herdr-site", "herdr-companion", "aurora-web"]) });
    expect(await browseFolder(mini, "~/")).toMatchObject({ folder: "/Users/demo" });
    const box = demoFolderTree("Linux", { panes: [{ cwd: "/root/trendline" }] });
    expect(await browseFolder(box, "~/")).toMatchObject({ folder: "/root", names: expect.arrayContaining(["trendline", "scratch"]) });
  });
});

// MARK: - The SFTP reader

type Entry = { filename: string; attrs: { mode: number } };
const dir = (filename: string): Entry => ({ filename, attrs: { mode: 0o040755 } });
const file = (filename: string): Entry => ({ filename, attrs: { mode: 0o100644 } });
const link = (filename: string): Entry => ({ filename, attrs: { mode: 0o120777 } });
const status = (code: number, message: string) => Object.assign(new Error(message), { code });

/** ssh2's SFTP calls over a fake folder table, served `batch` entries per READDIR, recording every call. */
function fakeSftp(folders: Record<string, Entry[]>, options: { batch?: number; targets?: Record<string, "folder" | "file">; refuse?: string[] } = {}) {
  const calls: string[] = [];
  const batch = options.batch ?? 100;
  const handles = new Map<string, { folder: string; at: number }>();
  let next = 0;
  const kindAt = (target: string): number | null => {
    if (options.targets?.[target] !== undefined) return options.targets[target] === "folder" ? 0o040755 : 0o100644;
    if (folders[target] !== undefined) return 0o040755;
    return null;
  };
  return {
    calls,
    open: () => handles.size,
    sftp: {
      realpath: (target: string, done: (error: Error | undefined, real?: string) => void) => (calls.push(`realpath ${target}`), done(undefined, "/home/r")),
      stat: (target: string, done: (error: Error | undefined, stats?: { mode: number }) => void) => {
        calls.push(`stat ${target}`);
        const mode = kindAt(target);
        if (mode === null) done(status(2, "No such file"));
        else done(undefined, { mode });
      },
      opendir: (target: string, done: (error: Error | undefined, handle?: Buffer) => void) => {
        calls.push(`opendir ${target}`);
        if (options.refuse?.includes(target)) return done(status(3, "Permission denied"));
        const handle = Buffer.from(String(next++));
        handles.set(handle.toString(), { folder: target, at: 0 });
        done(undefined, handle);
      },
      readdir: (where: string | Buffer, done: (error: Error | undefined, list?: Entry[]) => void) => {
        if (typeof where === "string") throw new Error("the reader lists through a handle");
        const open = handles.get(where.toString())!;
        calls.push(`readdir ${open.folder}`);
        const all = [dir("."), dir(".."), ...folders[open.folder]!];
        if (open.at >= all.length) return done(status(1, "EOF"));
        const part = all.slice(open.at, open.at + batch);
        open.at += batch;
        done(undefined, part);
      },
      close: (handle: Buffer, done: (error?: Error | null) => void) => {
        calls.push("close");
        handles.delete(handle.toString());
        done();
      },
    },
  };
}

describe("the SFTP reader (a saved machine's connection)", () => {
  it("one folder, batch by batch: its folders, links that point to folders, never files; the handle closed", async () => {
    const fake = fakeSftp(
      { "/home/r/Code": [dir("web"), file("README.md"), link("shared"), link("notes"), dir("api")], "/srv/shared": [] },
      { batch: 2, targets: { "/home/r/Code/shared": "folder", "/home/r/Code/notes": "file" } },
    );
    const listing = await browseFolder(sftpFolderReader(fake.sftp as never), "~/Code/");
    expect(listing).toEqual({ type: "listed", folder: "/home/r/Code", names: ["api", "shared", "web"], truncated: false });
    expect(fake.open()).toBe(0);
    // One folder listed; only the two links stat'ed, nothing below them read.
    expect(fake.calls.filter((call) => call.startsWith("opendir"))).toEqual(["opendir /home/r/Code"]);
    expect(fake.calls.filter((call) => call.startsWith("stat"))).toEqual(["stat /home/r/Code", "stat /home/r/Code/shared", "stat /home/r/Code/notes"]);
  });

  it("stops reading at the entry cap and says the folder holds more", async () => {
    const huge = Array.from({ length: maxReadEntries + 300 }, (_, i) => dir(`d${i}`));
    const fake = fakeSftp({ "/big": huge }, { batch: 1_000 });
    const listing = await browseFolder(sftpFolderReader(fake.sftp as never), "/big/");
    expect(listing.type).toBe("listed");
    expect((listing as Extract<FolderListing, { type: "listed" }>).names).toHaveLength(maxReadEntries);
    expect((listing as Extract<FolderListing, { type: "listed" }>).truncated).toBe(true);
    expect(fake.calls.filter((call) => call.startsWith("readdir")).length).toBe(6);
    expect(fake.open()).toBe(0);
  });

  it(`follows at most ${maxLinksFollowed} links in one folder`, async () => {
    const links = Array.from({ length: maxLinksFollowed + 20 }, (_, i) => link(`l${i}`));
    const targets = Object.fromEntries(links.map((entry) => [`/x/${entry.filename}`, "folder" as const]));
    const fake = fakeSftp({ "/x": links }, { targets });
    const listing = (await browseFolder(sftpFolderReader(fake.sftp as never), "/x/")) as Extract<FolderListing, { type: "listed" }>;
    expect(listing.names).toHaveLength(maxLinksFollowed);
    expect(fake.calls.filter((call) => call.startsWith("stat /x/"))).toHaveLength(maxLinksFollowed);
  });

  it("permission denied and a missing folder", async () => {
    const fake = fakeSftp({ "/root": [] }, { refuse: ["/root"] });
    expect(await browseFolder(sftpFolderReader(fake.sftp as never), "/root/")).toEqual({ type: "unreadable", folder: "/root", reason: "permission denied" });
    expect(await browseFolder(sftpFolderReader(fake.sftp as never), "/gone/")).toEqual({ type: "missing", folder: "/gone" });
  });
});

describe("This Mac's local reader (LocalSftp over a temp tree)", () => {
  it("lists the folder's folders and a link to a folder; ~ is the session's home; files and a broken link left out", async () => {
    mkdirSync(scratchRoot, { recursive: true });
    const home = mkdtempSync(path.join(scratchRoot, "fb-home-"));
    for (const name of ["Code/app", "Code/web", "Documents", ".hidden"]) mkdirSync(path.join(home, name), { recursive: true });
    writeFileSync(path.join(home, "Code", "README.md"), "x");
    symlinkSync(path.join(home, "Documents"), path.join(home, "Code", "docs"));
    symlinkSync(path.join(home, "nowhere"), path.join(home, "Code", "broken"));
    const local = new LocalSftp(home);
    try {
      expect(await browseFolder(sftpFolderReader(local as never), "~/")).toEqual({ type: "listed", folder: home, names: [".hidden", "Code", "Documents"], truncated: false });
      expect(await browseFolder(sftpFolderReader(local as never), "~/Code/")).toEqual({ type: "listed", folder: path.join(home, "Code"), names: ["app", "docs", "web"], truncated: false });
      expect(await browseFolder(sftpFolderReader(local as never), `${home}/Code/README.md/`)).toMatchObject({ type: "not-folder" });
      expect(await browseFolder(sftpFolderReader(local as never), "~/missing/")).toMatchObject({ type: "missing" });
    } finally {
      local.end();
    }
  });
});

// MARK: - The doors

const event = { senderFrame: { url: APP_ORIGIN }, sender: { id: 1 } };
const host = (id: string, kind: HostView["kind"], state: HostView["state"] = "connected"): HostView =>
  ({ id, name: id === "this-mac" ? "This Mac" : id, kind, address: kind, platform: "macOS", state, error: null, topology: null, fetchedAtMs: null }) as HostView;

function doors(options: { picked?: string | null } = {}) {
  const tree = machine("macOS");
  const asked: string[] = [];
  const picks: { typed: string }[] = [];
  const views = [host("this-mac", "local"), host("mini", "ssh"), host("box", "ssh", "offline"), host("old", "ssh")];
  registered.handles.clear();
  registerIpc({
    hosts: {
      list: () => views,
      backend: (id: string) =>
        id === "old"
          ? {}
          : views.some((view) => view.id === id)
            ? { browseFolder: (directory: string) => (asked.push(`${id} ${directory}`), browseFolder(tree, directory)) }
            : null,
    },
    pickFolder: async (_owner: unknown, typed: string) => (picks.push({ typed }), options.picked ?? null),
  } as never);
  const call = (channel: string, ...args: unknown[]) => Promise.resolve().then(() => registered.handles.get(channel)!(event, ...args));
  return { asked, picks, browse: (...args: unknown[]) => call(IPC.folderBrowse, ...args), pick: (...args: unknown[]) => call(IPC.folderPick, ...args) };
}

describe("the IPC doors", () => {
  it("lists one folder on a machine that answers, over its own backend", async () => {
    const d = doors();
    expect(await d.browse("mini", "~/Code/")).toMatchObject({ type: "listed", names: ["app", "app2", "app10", "Kiosk", "koala"] });
    expect(d.asked).toEqual(["mini ~/Code/"]);
  });

  it("an offline or unlisted machine says offline; one that cannot list says so; nothing is asked", async () => {
    const d = doors();
    expect(await d.browse("box", "~/")).toEqual({ type: "offline" });
    expect(await d.browse("gone", "~/")).toEqual({ type: "offline" });
    expect(await d.browse("old", "~/")).toEqual({ type: "unavailable" });
    expect(d.asked).toEqual([]);
  });

  it("refuses a bad request", async () => {
    const d = doors();
    for (const args of [["mini", "~"], ["mini", "code/"], ["mini", "/a\u0000/"], ["", "/"], ["mini", "/", "extra"]]) {
      await expect(d.browse(...args)).rejects.toThrow("bad request");
    }
    expect(d.asked).toEqual([]);
  });

  it("Choose… opens the folder window for This Mac only; any other machine is refused before a window opens", async () => {
    const d = doors({ picked: "/Users/r/Code/koala" });
    expect(await d.pick("this-mac", "~/Code")).toBe("/Users/r/Code/koala");
    expect(d.picks).toEqual([{ typed: "~/Code" }]);
    await expect(d.pick("mini", "~/Code")).rejects.toThrow("Only This Mac's folders can be chosen in a window");
    await expect(d.pick("gone", "~/")).rejects.toThrow("Only This Mac's folders");
    await expect(d.pick("this-mac", 5)).rejects.toThrow("bad request");
    expect(d.picks).toHaveLength(1);
  });
});

describe("the folder window (Electron's dialog mocked)", () => {
  it("opens to choose a folder, at the typed folder when it is one here, else at home", async () => {
    const isFolder = (target: string) => target === "/Users/r/Code" || target === "/Users/r";
    expect(typedFolderOnThisMac("~", "/Users/r")).toBe("/Users/r");
    expect(typedFolderOnThisMac("~/Code/", "/Users/r")).toBe("/Users/r/Code");
    expect(typedFolderOnThisMac("code", "/Users/r")).toBeNull();
    expect(folderPickStart("~/Code", "/Users/r", isFolder)).toBe("/Users/r/Code");
    expect(folderPickStart("~/Nope", "/Users/r", isFolder)).toBe("/Users/r");
    expect(folderPickStart("", "/Users/r", isFolder)).toBe("/Users/r");
    const asked: unknown[] = [];
    const open = vi.fn(async (options: unknown) => (asked.push(options), { canceled: false, filePaths: ["/Users/r/Code/koala"] }));
    expect(await pickFolderOnThisMac(open, "/Users/r/Code", "/Users/r", isFolder)).toBe("/Users/r/Code/koala");
    expect(asked).toEqual([folderPickOptions("/Users/r/Code")]);
    expect(folderPickOptions("/Users/r/Code")).toMatchObject({ defaultPath: "/Users/r/Code", properties: expect.arrayContaining(["openDirectory"]) });
    expect(await pickFolderOnThisMac(async () => ({ canceled: true, filePaths: [] }), "", "/Users/r", isFolder)).toBeNull();
  });
});

// A demo machine's folders for New workspace's and New agent's
// folder field: a small invented tree in memory (its panes' folders and every
// folder above them, a few more under its home and its projects, hidden ones,
// one file and one folder it may not read), listed by the same browseFolder
// as a real machine's (src/main/folder-browse.ts). Nothing on this Mac is
// read.

import path from "node:path";

import type { FolderEntry, FolderReader } from "../folder-browse";

/** The folder a demo machine refuses to list (permission denied), and a file where a folder could be. */
export const demoLockedFolder = "private";
export const demoFileName = "notes.txt";

type Node = { readonly kind: "folder"; readonly children: Map<string, Node>; readonly locked: boolean } | { readonly kind: "file" };

const folder = (locked = false): Node => ({ kind: "folder", children: new Map(), locked });

const sftpError = (message: string, code: number): Error => Object.assign(new Error(message), { code });

/** An in-memory folder tree with a home, read as a machine's folders are. */
export class DemoFolderTree implements FolderReader {
  private readonly root: Node = folder();
  private readonly lists: string[] = [];

  constructor(readonly homePath: string) {
    this.addFolder(homePath);
  }

  /** Every folder `list` was asked for, in order (a test sees one folder at a time, never a walk). */
  get listed(): readonly string[] {
    return this.lists;
  }

  addFolder(target: string, locked = false): this {
    let node = this.root;
    const parts = target.split("/").filter((part) => part !== "");
    parts.forEach((part, index) => {
      if (node.kind !== "folder") return;
      let next = node.children.get(part);
      if (next === undefined || next.kind !== "folder") {
        next = folder(locked && index === parts.length - 1);
        node.children.set(part, next);
      }
      node = next;
    });
    return this;
  }

  addFile(target: string): this {
    const parent = path.posix.dirname(target);
    this.addFolder(parent);
    const node = this.node(parent);
    if (node?.kind === "folder") node.children.set(path.posix.basename(target), { kind: "file" });
    return this;
  }

  private node(target: string): Node | null {
    let node: Node = this.root;
    for (const part of target.split("/").filter((piece) => piece !== "")) {
      if (node.kind !== "folder") return null;
      const next = node.children.get(part);
      if (next === undefined) return null;
      node = next;
    }
    return node;
  }

  home(): Promise<string> {
    return Promise.resolve(this.homePath);
  }

  /** A folder the tree has (the demo's Herdr gives a pane in the home for any other). */
  hasFolder(target: string): boolean {
    let folder = target;
    while (folder.length > 1 && folder.endsWith("/")) folder = folder.slice(0, -1);
    return this.node(folder)?.kind === "folder";
  }

  kind(target: string): Promise<"folder" | "other" | null> {
    const node = this.node(target);
    return Promise.resolve(node === null ? null : node.kind === "folder" ? "folder" : "other");
  }

  list(target: string, limit: number): Promise<{ readonly entries: readonly FolderEntry[]; readonly truncated: boolean }> {
    this.lists.push(target);
    const node = this.node(target);
    if (node === null) return Promise.reject(sftpError("No such file", 2));
    if (node.kind !== "folder") return Promise.reject(sftpError("Not a folder", 4));
    if (node.locked) return Promise.reject(sftpError("Permission denied", 3));
    const entries = [...node.children].map(([name, child]): FolderEntry => ({ name, kind: child.kind === "folder" ? "folder" : "other" }));
    return Promise.resolve({ entries: entries.slice(0, limit), truncated: entries.length > limit });
  }
}

/** The pane folders in a demo snapshot (Herdr's wire JSON: cwd and foreground_cwd). */
function paneFolders(snapshot: Record<string, unknown>): string[] {
  const panes = Array.isArray(snapshot["panes"]) ? (snapshot["panes"] as unknown[]) : [];
  const found: string[] = [];
  for (const pane of panes) {
    if (typeof pane !== "object" || pane === null) continue;
    for (const key of ["cwd", "foreground_cwd"]) {
      const value = (pane as Record<string, unknown>)[key];
      if (typeof value === "string" && value.startsWith("/")) found.push(value);
    }
  }
  return found;
}

/** A demo machine's tree: its home, its panes' folders, a few more under its home and its projects. */
export function demoFolderTree(platform: string | null, snapshot: Record<string, unknown>): DemoFolderTree {
  const linux = platform === "Linux";
  const home = linux ? "/root" : "/Users/demo";
  const tree = new DemoFolderTree(home);
  const homeFolders = linux ? ["scratch", "backups", ".cache", ".config", ".local"] : ["Code", "Desktop", "Documents", "Downloads", "Library", "Movies", ".config", ".local"];
  for (const name of homeFolders) tree.addFolder(`${home}/${name}`);
  tree.addFolder(`${home}/${demoLockedFolder}`, true);
  tree.addFile(`${home}/${demoFileName}`);
  const folders = paneFolders(snapshot);
  for (const each of folders) tree.addFolder(each);
  if (!linux) {
    // The Mac mini's projects folder (the panes' parent) with a few more, the one New workspace's captures make
    // (demoNewWorkspaceFolder) among them, and what is inside herdr-companion.
    const projects = "/Users/demo/code";
    for (const name of ["herdr-site", "recipe-box", "toolbox"]) tree.addFolder(`${projects}/${name}`);
    for (const name of ["desktop", "docs", "ios", "scripts", ".github"]) tree.addFolder(`${projects}/herdr-companion/${name}`);
    for (const name of ["journal", "bin"]) tree.addFolder(`/Users/demo/code/notes/${name}`);
    // A project under the home's Code, New workspace's `~/Code/hello-app` capture.
    tree.addFolder(`${home}/Code/hello-app`);
  } else {
    for (const name of ["api", "web", "deploy"]) tree.addFolder(`/root/herdr/${name}`);
  }
  return tree;
}

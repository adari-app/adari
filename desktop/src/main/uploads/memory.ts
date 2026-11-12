// A machine's files in memory, with SFTP's answers (upload.ts UploadSftp):
// the demo machines' uploads, and the tests' fake SFTP. Folders and files
// keep a mode and a modification time; a symlink points at another path.
// Each request is recorded, and `fail` makes the next matching one fail.

import { UploadNotFoundError, type UploadEntry, type UploadSftp, type UploadStat } from "./upload";

interface Node {
  kind: "file" | "directory" | "symlink";
  mode: number;
  modifiedMs: number;
  data?: Uint8Array;
  target?: string;
}

const parentOf = (path: string): string => {
  const slash = path.lastIndexOf("/");
  return slash <= 0 ? "/" : path.slice(0, slash);
};

export class MemoryUploadSftp implements UploadSftp {
  readonly nodes = new Map<string, Node>();
  /** Every request, as "op path". */
  readonly requests: string[] = [];
  /** The next request whose "op path" starts with the key fails with the error. */
  readonly failures = new Map<string, Error>();

  constructor(
    readonly home: string = "/Users/fixture",
    readonly now: () => number = Date.now,
  ) {
    this.nodes.set("/", { kind: "directory", mode: 0o040755, modifiedMs: 0 });
    let path = "";
    for (const part of home.split("/").filter((p) => p !== "")) {
      path += `/${part}`;
      this.nodes.set(path, { kind: "directory", mode: 0o040755, modifiedMs: 0 });
    }
  }

  fail(prefix: string, error: Error = new Error(`${prefix} failed`)): void {
    this.failures.set(prefix, error);
  }

  private request(op: string, path: string): void {
    const line = `${op} ${path}`;
    this.requests.push(line);
    for (const [prefix, error] of this.failures) {
      if (line.startsWith(prefix)) {
        this.failures.delete(prefix);
        throw error;
      }
    }
  }

  private node(path: string): Node {
    const node = this.nodes.get(path);
    if (node === undefined) throw new UploadNotFoundError(path);
    return node;
  }

  /** Follows symlinks, as the server's REALPATH and STAT do. */
  private resolve(path: string): string {
    let resolved = path === "." ? this.home : path;
    for (let hops = 0; hops < 8; hops += 1) {
      const node = this.nodes.get(resolved);
      if (node?.kind !== "symlink") break;
      resolved = node.target!;
    }
    // A symlinked folder in the middle of the path.
    const parent = parentOf(resolved);
    if (resolved !== "/" && parent !== "/" && this.nodes.get(parent)?.kind === "symlink") {
      return this.resolve(`${this.resolve(parent)}/${resolved.slice(parent.length + 1)}`);
    }
    return resolved;
  }

  addFolder(path: string, modifiedMs: number, mode = 0o040700): void {
    this.nodes.set(path, { kind: "directory", mode, modifiedMs });
  }

  addFile(path: string, data: Uint8Array, modifiedMs: number, mode = 0o100600): void {
    this.nodes.set(path, { kind: "file", mode, modifiedMs, data });
  }

  addSymlink(path: string, target: string): void {
    this.nodes.set(path, { kind: "symlink", mode: 0o120777, modifiedMs: 0, target });
  }

  file(path: string): Uint8Array | null {
    const node = this.nodes.get(path);
    return node?.kind === "file" ? (node.data ?? new Uint8Array()) : null;
  }

  paths(): string[] {
    return [...this.nodes.keys()].sort();
  }

  async realpath(path: string): Promise<string> {
    this.request("realpath", path);
    const resolved = this.resolve(path);
    this.node(resolved);
    return resolved;
  }

  async mkdir(path: string, mode: number): Promise<void> {
    this.request("mkdir", path);
    if (this.nodes.has(path)) throw new Error(`${path} exists`);
    this.node(parentOf(path));
    this.nodes.set(path, { kind: "directory", mode: 0o040000 | (mode & 0o777), modifiedMs: this.now() });
  }

  async chmod(path: string, mode: number): Promise<void> {
    this.request("chmod", path);
    const node = this.node(this.resolve(path));
    node.mode = (node.mode & 0o170000) | (mode & 0o777);
  }

  async stat(path: string): Promise<UploadStat> {
    this.request("stat", path);
    const node = this.node(this.resolve(path));
    return { mode: node.mode, size: node.data?.byteLength ?? 0 };
  }

  async writeNew(path: string, data: Uint8Array, mode: number): Promise<void> {
    this.request("writeNew", path);
    if (this.nodes.has(path)) throw new Error(`${path} exists`);
    this.node(parentOf(path));
    this.nodes.set(path, { kind: "file", mode: 0o100000 | (mode & 0o777), modifiedMs: this.now(), data: data.slice() });
  }

  async rename(from: string, to: string): Promise<void> {
    this.request("rename", from);
    const node = this.node(from);
    if (this.nodes.has(to)) throw new Error(`${to} exists`);
    this.nodes.delete(from);
    this.nodes.set(to, node);
  }

  async unlink(path: string): Promise<void> {
    this.request("unlink", path);
    const node = this.node(path);
    if (node.kind === "directory") throw new Error(`${path} is a folder`);
    this.nodes.delete(path);
  }

  async rmdir(path: string): Promise<void> {
    this.request("rmdir", path);
    const node = this.node(path);
    if (node.kind !== "directory") throw new Error(`${path} is not a folder`);
    if ([...this.nodes.keys()].some((other) => other.startsWith(`${path}/`))) throw new Error(`${path} is not empty`);
    this.nodes.delete(path);
  }

  async list(path: string): Promise<UploadEntry[]> {
    this.request("list", path);
    const resolved = this.resolve(path);
    if (this.node(resolved).kind !== "directory") throw new Error(`${path} is not a folder`);
    const prefix = resolved === "/" ? "/" : `${resolved}/`;
    const entries: UploadEntry[] = [];
    for (const [other, node] of this.nodes) {
      if (other === resolved || !other.startsWith(prefix) || other.slice(prefix.length).includes("/")) continue;
      entries.push({ name: other.slice(prefix.length), kind: node.kind, size: node.data?.byteLength ?? 0, modifiedMs: node.modifiedMs });
    }
    return entries;
  }
}

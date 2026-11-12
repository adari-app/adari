// An in-memory machine for the start-commands save
// (start-commands-write.ts): the demo machines' `~/.adari/agents.json`, which
// Settings › Chat edits like a real one, and the tests' machine (every request
// recorded; one made to fail; a symlink; a file's mode).

import type { StartCommandsFileAccess, StartFileInfo } from "./start-commands-write";

interface Node {
  kind: "file" | "directory" | "symlink";
  mode: number;
  data?: Uint8Array;
  target?: string;
}

const parentOf = (path: string): string => {
  const slash = path.lastIndexOf("/");
  return slash <= 0 ? "/" : path.slice(0, slash);
};

export class MemoryStartCommandsFiles implements StartCommandsFileAccess {
  readonly nodes = new Map<string, Node>();
  /** Every request, as "op path". */
  readonly requests: string[] = [];
  /** The next request whose "op path" starts with the key fails with the error. */
  readonly failures = new Map<string, Error>();

  constructor(readonly homePath: string = "/Users/demo") {
    this.nodes.set("/", { kind: "directory", mode: 0o755 });
    let path = "";
    for (const part of homePath.split("/").filter((p) => p !== "")) {
      path += `/${part}`;
      this.nodes.set(path, { kind: "directory", mode: 0o755 });
    }
  }

  fail(prefix: string, error: Error = new Error(`${prefix} failed`)): void {
    this.failures.set(prefix, error);
  }

  addFolder(path: string, mode = 0o700): void {
    this.nodes.set(path, { kind: "directory", mode });
  }

  addFile(path: string, text: string | Uint8Array, mode = 0o600): void {
    this.nodes.set(path, { kind: "file", mode, data: typeof text === "string" ? new TextEncoder().encode(text) : text.slice() });
  }

  addSymlink(path: string, target: string): void {
    this.nodes.set(path, { kind: "symlink", mode: 0o777, target });
  }

  text(path: string): string | null {
    const node = this.nodes.get(path);
    return node?.kind === "file" ? new TextDecoder().decode(node.data) : null;
  }

  modeOf(path: string): number | null {
    return this.nodes.get(path)?.mode ?? null;
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

  private resolve(path: string): string {
    let resolved = path;
    for (let hops = 0; hops < 8; hops += 1) {
      const node = this.nodes.get(resolved);
      if (node?.kind !== "symlink") break;
      resolved = node.target!;
    }
    return resolved;
  }

  private node(path: string): Node {
    const node = this.nodes.get(path);
    if (node === undefined) throw Object.assign(new Error("No such file"), { code: 2 });
    return node;
  }

  private info(node: Node): StartFileInfo {
    return { kind: node.kind, mode: node.mode, size: node.data?.byteLength ?? 0 };
  }

  async home(): Promise<string> {
    this.request("home", ".");
    return this.homePath;
  }

  async lstat(path: string): Promise<StartFileInfo | null> {
    this.request("lstat", path);
    const node = this.nodes.get(path);
    return node === undefined ? null : this.info(node);
  }

  async stat(path: string): Promise<StartFileInfo> {
    this.request("stat", path);
    return this.info(this.node(this.resolve(path)));
  }

  async realpath(path: string): Promise<string> {
    this.request("realpath", path);
    const resolved = this.resolve(path);
    this.node(resolved);
    return resolved;
  }

  async read(path: string, limit: number): Promise<Uint8Array> {
    this.request("read", path);
    const node = this.node(this.resolve(path));
    if (node.kind !== "file") throw new Error(`${path} is not a file`);
    return (node.data ?? new Uint8Array()).slice(0, limit);
  }

  async mkdir(path: string, mode: number): Promise<void> {
    this.request("mkdir", path);
    if (this.nodes.has(path)) throw new Error(`${path} exists`);
    this.node(this.resolve(parentOf(path)));
    this.nodes.set(path, { kind: "directory", mode: mode & 0o7777 });
  }

  async writeNew(path: string, data: Uint8Array, mode: number): Promise<void> {
    this.request("writeNew", path);
    if (this.nodes.has(path)) throw new Error(`${path} exists`);
    if (this.node(this.resolve(parentOf(path))).kind !== "directory") throw new Error(`${parentOf(path)} is not a folder`);
    this.nodes.set(path, { kind: "file", mode: mode & 0o7777, data: data.slice() });
  }

  async replace(from: string, to: string): Promise<void> {
    this.request("replace", `${from} -> ${to}`);
    const node = this.node(from);
    if (this.nodes.get(to)?.kind === "directory") throw new Error(`${to} is a folder`);
    this.nodes.delete(from);
    this.nodes.set(to, node);
  }

  async remove(path: string): Promise<void> {
    this.request("remove", path);
    const node = this.node(path);
    if (node.kind === "directory") throw new Error(`${path} is a folder`);
    this.nodes.delete(path);
  }
}

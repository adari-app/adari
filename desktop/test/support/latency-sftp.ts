// An ssh2 SFTP session (the callback API sftp.ts uses) over an
// in-memory file system, with a link model: each request goes up a shared
// link at `bytesPerSecond` (writes carry their bytes), reaches the machine
// half a round trip later, is answered in order, and the answer comes back
// half a round trip after that. Timers are setTimeout, so a test drives them
// with vitest's fake timers and reads the model's time from Date.now().
// Every request is recorded with when it was sent and answered; `rounds`
// counts the requests sent while none was in flight (the waits for the
// machine one after another), `maxWrites` the writes in flight at once.
// `silent` makes matching requests never answer.

interface Node {
  kind: "file" | "directory";
  mode: number;
  data: Uint8Array;
  mtime: number;
}

export interface LinkModel {
  readonly rttMs: number;
  readonly bytesPerSecond: number;
}

export interface SentRequest {
  readonly op: string;
  readonly path: string;
  readonly sentAt: number;
  answeredAt: number | null;
}

type Callback = (error: Error | null | undefined, value?: unknown) => void;

const noSuchFile = (): Error => Object.assign(new Error("No such file"), { code: 2 });
const failure = (message: string): Error => Object.assign(new Error(message), { code: 4 });
const parentOf = (path: string): string => {
  const slash = path.lastIndexOf("/");
  return slash <= 0 ? "/" : path.slice(0, slash);
};

export class LatencySftp {
  readonly nodes = new Map<string, Node>();
  readonly requests: SentRequest[] = [];
  /** Requests whose "op path" starts with one of these are never answered. */
  readonly silent: string[] = [];
  /** The next request whose "op path" starts with the key fails with that message. */
  readonly failures = new Map<string, string>();
  rounds = 0;
  maxWrites = 0;
  private inFlight = 0;
  private writes = 0;
  private uplinkFree = 0;
  private machineFree = 0;
  private readonly handles = new Map<string, string>();
  private nextHandle = 0;

  constructor(
    readonly link: LinkModel,
    readonly home: string = "/Users/fixture",
  ) {
    this.nodes.set("/", { kind: "directory", mode: 0o040755, data: new Uint8Array(), mtime: 0 });
    let path = "";
    for (const part of home.split("/").filter((p) => p !== "")) {
      path += `/${part}`;
      this.nodes.set(path, { kind: "directory", mode: 0o040755, data: new Uint8Array(), mtime: 0 });
    }
  }

  /** The requests sent, as "op path". */
  lines(): string[] {
    return this.requests.map((request) => `${request.op} ${request.path}`);
  }

  file(path: string): Uint8Array | null {
    const node = this.nodes.get(path);
    return node?.kind === "file" ? node.data : null;
  }

  paths(): string[] {
    return [...this.nodes.keys()].sort();
  }

  /** One request: sent now, answered by the model; `work` runs on the machine when it arrives. */
  private request(op: string, path: string, bytes: number, done: Callback, work: () => unknown): void {
    const sentAt = Date.now();
    const record: SentRequest = { op, path, sentAt, answeredAt: null };
    this.requests.push(record);
    if (this.inFlight === 0) this.rounds += 1;
    this.inFlight += 1;
    if (op === "write") {
      this.writes += 1;
      this.maxWrites = Math.max(this.maxWrites, this.writes);
    }
    const line = `${op} ${path}`;
    if (this.silent.some((prefix) => line.startsWith(prefix))) return;
    const leaves = Math.max(sentAt, this.uplinkFree) + ((64 + bytes) * 1_000) / this.link.bytesPerSecond;
    this.uplinkFree = leaves;
    const arrives = Math.max(leaves + this.link.rttMs / 2, this.machineFree);
    this.machineFree = arrives;
    const answered = arrives + this.link.rttMs / 2;
    setTimeout(() => {
      let error: Error | null = null;
      let value: unknown;
      const failing = [...this.failures.keys()].find((prefix) => line.startsWith(prefix));
      if (failing !== undefined) {
        error = failure(this.failures.get(failing)!);
        this.failures.delete(failing);
      } else {
        try {
          value = work();
        } catch (thrown) {
          error = thrown as Error;
        }
      }
      record.answeredAt = Date.now();
      this.inFlight -= 1;
      if (op === "write") this.writes -= 1;
      done(error, value);
    }, Math.max(0, answered - sentAt));
  }

  private node(path: string): Node {
    const node = this.nodes.get(path);
    if (node === undefined) throw noSuchFile();
    return node;
  }

  private resolve(path: string): string {
    return path === "." ? this.home : path;
  }

  realpath(path: string, done: Callback): void {
    this.request("realpath", path, path.length, done, () => {
      const resolved = this.resolve(path);
      this.node(resolved);
      return resolved;
    });
  }

  mkdir(path: string, attrs: { mode: number }, done: Callback): void {
    this.request("mkdir", path, path.length, done, () => {
      if (this.nodes.has(path)) throw failure(`${path} exists`);
      this.node(parentOf(path));
      this.nodes.set(path, { kind: "directory", mode: 0o040000 | (attrs.mode & 0o777), data: new Uint8Array(), mtime: Date.now() });
    });
  }

  chmod(path: string, mode: number, done: Callback): void {
    this.request("chmod", path, path.length, done, () => {
      const node = this.node(this.resolve(path));
      node.mode = (node.mode & 0o170000) | (mode & 0o777);
    });
  }

  stat(path: string, done: Callback): void {
    this.request("stat", path, path.length, done, () => {
      const node = this.node(this.resolve(path));
      return { mode: node.mode, size: node.data.byteLength, mtime: node.mtime };
    });
  }

  open(path: string, flags: string, attrs: { mode: number }, done: Callback): void {
    this.request("open", path, path.length, done, () => {
      if (flags !== "wx") throw failure(`flags ${flags}`);
      if (this.nodes.has(path)) throw failure(`${path} exists`);
      this.node(parentOf(path));
      this.nodes.set(path, { kind: "file", mode: 0o100000 | (attrs.mode & 0o777), data: new Uint8Array(), mtime: Date.now() });
      this.nextHandle += 1;
      const handle = `h${this.nextHandle}`;
      this.handles.set(handle, path);
      return Buffer.from(handle);
    });
  }

  private handlePath(handle: Buffer): string {
    const path = this.handles.get(handle.toString());
    if (path === undefined) throw failure("bad handle");
    return path;
  }

  write(handle: Buffer, buffer: Buffer, offset: number, length: number, position: number, done: Callback): void {
    const path = this.handles.get(handle.toString()) ?? "?";
    const bytes = Uint8Array.from(buffer.subarray(offset, offset + length));
    this.request("write", path, length, done, () => {
      const node = this.node(this.handlePath(handle));
      const grown = new Uint8Array(Math.max(node.data.byteLength, position + length));
      grown.set(node.data);
      grown.set(bytes, position);
      node.data = grown;
    });
  }

  fchmod(handle: Buffer, mode: number, done: Callback): void {
    const path = this.handles.get(handle.toString()) ?? "?";
    this.request("fchmod", path, 8, done, () => {
      const node = this.node(this.handlePath(handle));
      node.mode = (node.mode & 0o170000) | (mode & 0o777);
    });
  }

  close(handle: Buffer, done: Callback): void {
    const path = this.handles.get(handle.toString()) ?? "?";
    this.request("close", path, 8, done, () => {
      this.handlePath(handle);
      this.handles.delete(handle.toString());
    });
  }

  rename(from: string, to: string, done: Callback): void {
    this.request("rename", from, from.length + to.length, done, () => {
      const node = this.node(from);
      if (this.nodes.has(to)) throw failure(`${to} exists`);
      this.nodes.delete(from);
      this.nodes.set(to, node);
    });
  }

  unlink(path: string, done: Callback): void {
    this.request("unlink", path, path.length, done, () => {
      const node = this.node(path);
      if (node.kind === "directory") throw failure(`${path} is a folder`);
      this.nodes.delete(path);
    });
  }

  rmdir(path: string, done: Callback): void {
    this.request("rmdir", path, path.length, done, () => {
      const node = this.node(path);
      if (node.kind !== "directory") throw failure(`${path} is not a folder`);
      if ([...this.nodes.keys()].some((other) => other.startsWith(`${path}/`))) throw failure(`${path} is not empty`);
      this.nodes.delete(path);
    });
  }

  readdir(path: string, done: Callback): void {
    this.request("readdir", path, path.length, done, () => {
      const resolved = this.resolve(path);
      if (this.node(resolved).kind !== "directory") throw failure(`${path} is not a folder`);
      const prefix = resolved === "/" ? "/" : `${resolved}/`;
      return [...this.nodes.entries()]
        .filter(([other]) => other !== resolved && other.startsWith(prefix) && !other.slice(prefix.length).includes("/"))
        .map(([other, node]) => ({ filename: other.slice(prefix.length), attrs: { mode: node.mode, size: node.data.byteLength, mtime: Math.floor(node.mtime / 1_000) } }));
    });
  }
}

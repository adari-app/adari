// The SSH transcript reader (src/main/chat/ssh-reader.ts) against a fake ssh2
// client: the locate exec, SFTP stat and bounded reads, "no such file", the
// output bound, a missed deadline dropping the connection, and close. No
// network, no SSH.

import { EventEmitter } from "node:events";

import type { Client } from "ssh2";
import { describe, expect, it } from "vitest";

import { maxLocateOutputBytes, maxReadBytes, SshTranscriptReader } from "../src/main/chat/ssh-reader";
import { TranscriptNotFoundError } from "../src/shared/chat/feed";
import { locateCommand, makeSessionRef } from "../src/shared/chat/locator";

const id = "5b1d7c2e-8f3a-4e6b-9c0d-1a2b3c4d5e6f";
const path = `/home/me/.claude/projects/-home-me-proj/${id}.jsonl`;

class FakeChannel extends EventEmitter {
  readonly stderr = new EventEmitter();
  closed = false;
  close(): void {
    this.closed = true;
  }
}

class FakeSftp {
  readonly files = new Map<string, Buffer>();
  /** At most this many bytes per read reply (SFTP servers split reads). */
  chunk = 5;
  hang = false;
  reads = 0;
  stat(file: string, cb: (error: unknown, stats: { size: number }) => void): void {
    if (this.hang) return;
    const data = this.files.get(file);
    if (data === undefined) cb(Object.assign(new Error("No such file"), { code: 2 }), { size: 0 });
    else cb(undefined, { size: data.length });
  }
  open(file: string, _flags: string, cb: (error: unknown, handle: Buffer) => void): void {
    const data = this.files.get(file);
    if (data === undefined) cb(Object.assign(new Error("No such file"), { code: 2 }), Buffer.alloc(0));
    else cb(undefined, Buffer.from(file));
  }
  read(handle: Buffer, buffer: Buffer, offset: number, length: number, position: number, cb: (error: unknown, bytesRead: number) => void): void {
    this.reads += 1;
    const data = this.files.get(handle.toString())!;
    const part = data.subarray(position, Math.min(data.length, position + Math.min(length, this.chunk)));
    part.copy(buffer, offset);
    cb(undefined, part.length);
  }
  close(_handle: Buffer, cb: () => void): void {
    cb();
  }
}

class FakeClient extends EventEmitter {
  readonly commands: string[] = [];
  ended = false;
  output: string | Buffer = path + "\n";
  constructor(readonly sftpServer: FakeSftp) {
    super();
  }
  exec(command: string, cb: (error: Error | undefined, channel: FakeChannel) => void): void {
    this.commands.push(command);
    const channel = new FakeChannel();
    cb(undefined, channel);
    queueMicrotask(() => {
      channel.emit("data", Buffer.isBuffer(this.output) ? this.output : Buffer.from(this.output));
      channel.emit("close");
    });
  }
  sftp(cb: (error: Error | undefined, sftp: FakeSftp) => void): void {
    cb(undefined, this.sftpServer);
  }
  end(): void {
    this.ended = true;
    this.emit("end");
  }
}

function reader(sftp = new FakeSftp(), timeoutMs = 1_000) {
  const clients: FakeClient[] = [];
  const instance = new SshTranscriptReader({ host: "box", port: 22, username: "me", privateKeyPath: "/k", herdrSession: "default" }, {} as never, {
    timeoutMs,
    connect: () => {
      const client = new FakeClient(sftp);
      clients.push(client);
      return Promise.resolve(client as unknown as Client);
    },
  });
  return { instance, clients, sftp };
}

describe("the SSH transcript reader", () => {
  it("finds a session's transcript with the locator's one command", async () => {
    const { instance, clients } = reader();
    const ref = makeSessionRef("claude", { kind: "id", id })!;
    expect(await instance.locate(ref)).toBe(path);
    expect(clients[0]!.commands).toEqual([locateCommand(ref)]);
    clients[0]!.output = "/etc/passwd\n";
    expect(await instance.locate(ref)).toBeNull();
    clients[0]!.output = "";
    expect(await instance.locate(ref)).toBeNull();
    expect(clients.length).toBe(1);
  });

  it("checks a path Herdr names with a stat", async () => {
    const { instance, sftp, clients } = reader();
    sftp.files.set(path, Buffer.from("x\n"));
    expect(await instance.locate(makeSessionRef("claude", { kind: "path", path })!)).toBe(path);
    expect(await instance.locate(makeSessionRef("claude", { kind: "path", path: "/gone/a.jsonl" })!)).toBeNull();
    expect(clients[0]!.commands).toEqual([]);
  });

  it("gives the size, and TranscriptNotFoundError for a file that is gone", async () => {
    const { instance, sftp } = reader();
    sftp.files.set(path, Buffer.from("0123456789"));
    expect(await instance.size(path)).toBe(10);
    await expect(instance.size("/gone.jsonl")).rejects.toBeInstanceOf(TranscriptNotFoundError);
    await expect(instance.read("/gone.jsonl", 0, 4)).rejects.toBeInstanceOf(TranscriptNotFoundError);
  });

  it("reads a range across several SFTP replies, fewer bytes at the end", async () => {
    const { instance, sftp } = reader();
    sftp.files.set(path, Buffer.from("0123456789abcdef"));
    expect(Buffer.from(await instance.read(path, 3, 9)).toString()).toBe("3456789ab");
    expect(Buffer.from(await instance.read(path, 12, 100)).toString()).toBe("cdef");
    expect((await instance.read(path, 16, 10)).length).toBe(0);
    expect((await instance.read(path, 0, 0)).length).toBe(0);
    expect(maxReadBytes).toBe(16 * 1_024 * 1_024);
  });

  it("refuses a locate answer longer than a path", async () => {
    const { instance, clients } = reader();
    const ref = makeSessionRef("claude", { kind: "id", id })!;
    await instance.locate(ref);
    clients[0]!.output = Buffer.alloc(maxLocateOutputBytes + 1, 0x61);
    await expect(instance.locate(ref)).rejects.toThrow("more than a path");
  });

  it("drops the connection at a missed deadline and reconnects next time", async () => {
    const { instance, sftp, clients } = reader(new FakeSftp(), 20);
    sftp.files.set(path, Buffer.from("abc"));
    sftp.hang = true;
    await expect(instance.size(path)).rejects.toThrow("did not finish");
    expect(clients[0]!.ended).toBe(true);
    sftp.hang = false;
    expect(await instance.size(path)).toBe(3);
    expect(clients.length).toBe(2);
  });

  it("ends its connection on close and refuses afterwards", async () => {
    const { instance, sftp, clients } = reader();
    sftp.files.set(path, Buffer.from("abc"));
    await instance.size(path);
    instance.close();
    await Promise.resolve();
    expect(clients[0]!.ended).toBe(true);
    await expect(instance.size(path)).rejects.toThrow("closed");
  });

  // The deadline covers connecting and the SFTP setup,
  // and close or a dropped connection ends a client whose setup never finished.
  describe("while the connection is set up", () => {
    class SilentSftpClient extends EventEmitter {
      ended = 0;
      sftp(_cb: unknown): void {}
      end(): void {
        this.ended += 1;
      }
    }
    const config = { host: "box", port: 22, username: "me", privateKeyPath: "/k", herdrSession: "default" };
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    it("misses the deadline when the SFTP callback never arrives, and ends that client", async () => {
      const client = new SilentSftpClient();
      const instance = new SshTranscriptReader(config, {} as never, { timeoutMs: 10, connect: async () => client as unknown as Client });
      let outcome: unknown = "pending";
      void instance.size("/fixture.jsonl").then(
        () => (outcome = "resolved"),
        (error: Error) => (outcome = error.message),
      );
      await wait(60);
      expect(outcome).toMatch(/did not finish within/);
      expect(client.ended).toBe(1);
    });

    it("ends the client on close while its SFTP setup is still waiting", async () => {
      const client = new SilentSftpClient();
      const instance = new SshTranscriptReader(config, {} as never, { timeoutMs: 60_000, connect: async () => client as unknown as Client });
      const sized = instance.size("/fixture.jsonl");
      await wait(5);
      instance.close();
      await expect(sized).rejects.toThrow("closed");
      expect(client.ended).toBe(1);
    });

    it("ends a client whose connect finished after close or after the deadline", async () => {
      const late = new SilentSftpClient();
      let arrive: (client: Client) => void = () => undefined;
      const instance = new SshTranscriptReader(config, {} as never, {
        timeoutMs: 10,
        connect: () => new Promise<Client>((resolve) => (arrive = resolve)),
      });
      await expect(instance.size("/fixture.jsonl")).rejects.toThrow(/did not finish within/);
      arrive(late as unknown as Client);
      await wait(5);
      expect(late.ended).toBe(1);

      const afterClose = new SilentSftpClient();
      const second = new SshTranscriptReader(config, {} as never, {
        timeoutMs: 60_000,
        connect: () => new Promise<Client>((resolve) => (arrive = resolve)),
      });
      const sized = second.size("/fixture.jsonl");
      second.close();
      await expect(sized).rejects.toThrow("closed");
      arrive(afterClose as unknown as Client);
      await wait(5);
      expect(afterClose.ended).toBe(1);
    });

    it("fails the setup at once when the connection closes before SFTP answers", async () => {
      const client = new SilentSftpClient();
      const instance = new SshTranscriptReader(config, {} as never, { timeoutMs: 60_000, connect: async () => client as unknown as Client });
      const sized = instance.size("/fixture.jsonl");
      await wait(5);
      client.emit("close");
      await expect(sized).rejects.toThrow("closed");
    });

    // ssh2 throws "Not connected" from sftp() when the socket is
    // gone. The throw fails the setup at once, with that error, through the same
    // cleanup, and leaves no rejected promise behind.
    it("fails the setup at once with the error sftp() throws, ending the client once", async () => {
      let ended = 0;
      const client = Object.assign(new EventEmitter(), {
        sftp: () => {
          throw new Error("Not connected");
        },
        end: () => {
          ended += 1;
        },
      });
      const escaped: string[] = [];
      const onEscaped = (reason: unknown): void => void escaped.push(reason instanceof Error ? reason.message : String(reason));
      process.on("unhandledRejection", onEscaped);
      const instance = new SshTranscriptReader(config, {} as never, { timeoutMs: 60_000, connect: async () => client as unknown as Client });
      let outcome: unknown = "pending";
      void instance.size("/fixture.jsonl").then(
        () => (outcome = "resolved"),
        (error: Error) => (outcome = error.message),
      );
      try {
        await wait(20);
      } finally {
        process.off("unhandledRejection", onEscaped);
        instance.close();
      }
      expect({ outcome, escaped, ended }).toEqual({ outcome: "Not connected", escaped: [], ended: 1 });
    });
  });
});

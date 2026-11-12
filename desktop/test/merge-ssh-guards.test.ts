// Changes' guard (runReadOnlyCommand and execBounded) and the away/search
// guard (run and cappedExec) cover the same SshTranscriptReader. On one reader and one link still being
// made, a Changes git command and an away/search command each cancelled (or
// past its deadline) are never sent; the link Chat shares is left up and runs
// the next command of each kind. A fake ssh2 client; no network, no SSH.

import { EventEmitter } from "node:events";

import type { Client } from "ssh2";
import { describe, expect, it } from "vitest";

import { SshTranscriptReader, cappedExec, execBounded } from "../src/main/chat/ssh-reader";
import { CancelledError, withDeadline, type RemoteCommand } from "../src/shared/remote-command";

class FakeChannel extends EventEmitter {
  readonly stderr = new EventEmitter();
  closed = false;
  close(): void {
    if (this.closed) return;
    this.closed = true;
    queueMicrotask(() => this.emit("close"));
  }
}

/** An SSH client whose SFTP setup waits until the test lets it finish. */
class HeldSsh extends EventEmitter {
  readonly commands: string[] = [];
  ended = false;
  private ready: ((error: Error | undefined, sftp: object) => void) | null = null;
  sftp(cb: (error: Error | undefined, sftp: object) => void): void {
    this.ready = cb;
  }
  get waiting(): boolean {
    return this.ready !== null;
  }
  finishSetup(): void {
    this.ready?.(undefined, {});
  }
  exec(command: string, cb: (error: Error | undefined, channel: FakeChannel) => void): void {
    this.commands.push(command);
    const channel = new FakeChannel();
    cb(undefined, channel);
    queueMicrotask(() => {
      if (!channel.closed) channel.emit("data", Buffer.from("out"));
      channel.close();
    });
  }
  end(): void {
    this.ended = true;
  }
}

const config = { host: "box", port: 22, username: "me", privateKeyPath: "/k", herdrSession: "default" };
const grep: RemoteCommand = { text: "/bin/sh -c 'grep needle'", intent: { kind: "git-log", folder: "/srv", since: 0, maxCount: 1 } };
const gitStatus = "git -C /srv status --porcelain=v2";
const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

describe("both exec guards on one SSH reader", () => {
  it("a Changes command and an away/search command cancelled while the link is made are never sent", async () => {
    const ssh = new HeldSsh();
    const reader = new SshTranscriptReader(config, {} as never, { timeoutMs: 60_000, connect: async () => ssh as unknown as Client });
    const away = new AbortController();
    const changes = new AbortController();
    const awayRun = reader.run(grep, 64, away.signal).catch((error: unknown) => error);
    const changesRun = reader.runReadOnlyCommand(gitStatus, 64, changes.signal).catch((error: unknown) => error);
    await settle();
    expect(ssh.waiting).toBe(true);
    away.abort();
    changes.abort();
    expect(await awayRun).toBeInstanceOf(CancelledError);
    expect(((await changesRun) as Error).message).toBe("the command was cancelled");
    ssh.finishSetup();
    await settle();
    expect(ssh.commands).toEqual([]);
    expect(ssh.ended).toBe(false);
    // The same link runs the next of each.
    expect(Buffer.from((await reader.run(grep, 64)).bytes).toString()).toBe("out");
    expect(await reader.runReadOnlyCommand(gitStatus, 64)).toBe("out");
    expect(ssh.commands).toEqual([grep.text, gitStatus]);
    reader.close();
  });

  it("neither is sent once its deadline passed while the link was made", async () => {
    const ssh = new HeldSsh();
    const reader = new SshTranscriptReader(config, {} as never, { timeoutMs: 5, connect: async () => ssh as unknown as Client });
    const awayRun = withDeadline(
      5,
      (signal) => reader.run(grep, 64, signal),
      () => new Error("deadline"),
    ).catch((error: unknown) => error);
    const changesRun = reader.runReadOnlyCommand(gitStatus, 64).catch((error: unknown) => error);
    expect(((await awayRun) as Error).message).toBe("deadline");
    await new Promise((resolve) => setTimeout(resolve, 20));
    ssh.finishSetup();
    await settle();
    expect(await changesRun).toBeInstanceOf(Error);
    expect(ssh.commands).toEqual([]);
    reader.close();
  });

  it("cappedExec and execBounded send nothing for a signal already aborted", async () => {
    const ssh = new HeldSsh();
    const abort = new AbortController();
    abort.abort();
    await expect(cappedExec(ssh as unknown as Client, "true", 64, abort.signal)).rejects.toBeInstanceOf(CancelledError);
    await expect(execBounded(ssh as unknown as Client, "true", 64, abort.signal)).rejects.toBeInstanceOf(Error);
    expect(ssh.commands).toEqual([]);
  });
});

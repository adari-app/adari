// Changes' git on an SSH machine runs over the transcript
// connection (src/main/chat/ssh-reader.ts runReadOnlyCommand, the Swift
// transport's runReadOnlyCommand): one exec per command, stdout bounded,
// stderr ignored, a failure after some output keeps it, the signal closes the
// channel. A fake ssh2 client; no network, no SSH.

import { EventEmitter } from "node:events";

import type { Client } from "ssh2";
import { describe, expect, it } from "vitest";

import { SshTranscriptReader, execBounded } from "../src/main/chat/ssh-reader";
import { changesLimits } from "../src/shared/changes/git";
import { AgentChangesGitReader, CommandGate } from "../src/shared/changes/reader";

class FakeChannel extends EventEmitter {
  readonly stderr = new EventEmitter();
  closed = false;
  close(): void {
    if (this.closed) return;
    this.closed = true;
    queueMicrotask(() => this.emit("close"));
  }
}

type Script = (channel: FakeChannel) => void;

class FakeClient extends EventEmitter {
  readonly commands: string[] = [];
  readonly channels: FakeChannel[] = [];
  script: Script = (channel) => {
    channel.emit("data", Buffer.from("out"));
    channel.close();
  };
  exec(command: string, cb: (error: Error | undefined, channel: FakeChannel) => void): void {
    this.commands.push(command);
    const channel = new FakeChannel();
    this.channels.push(channel);
    cb(undefined, channel);
    queueMicrotask(() => this.script(channel));
  }
  /** SFTP setup held until the test answers it. */
  holdSftp = false;
  heldSftp: ((error: Error | undefined, sftp: unknown) => void) | null = null;
  ended = false;
  sftp(cb: (error: Error | undefined, sftp: unknown) => void): void {
    if (this.holdSftp) this.heldSftp = cb;
    else cb(undefined, {});
  }
  end(): void {
    this.ended = true;
    for (const channel of this.channels) channel.close();
    this.emit("end");
  }
}

function reader() {
  const clients: FakeClient[] = [];
  const instance = new SshTranscriptReader({ host: "box", port: 22, username: "me", privateKeyPath: "/k", herdrSession: "default" }, {} as never, {
    timeoutMs: 1_000,
    connect: () => {
      const client = new FakeClient();
      clients.push(client);
      return Promise.resolve(client as unknown as Client);
    },
  });
  return { instance, clients };
}

describe("Changes' git over the SSH transcript connection", () => {
  it("runs the command as given in one exec and answers its stdout, stderr left out", async () => {
    const { instance, clients } = reader();
    const command = "/bin/sh -c 'git status'";
    expect(await instance.runReadOnlyCommand(command, 100)).toBe("out");
    const client = clients[0]!;
    client.script = (channel) => {
      channel.stderr.emit("data", Buffer.from("warning"));
      channel.emit("data", Buffer.from("HERDR-"));
      channel.emit("data", Buffer.from("CHANGES"));
      channel.emit("close");
    };
    expect(await instance.runReadOnlyCommand(command, 100)).toBe("HERDR-CHANGES");
    expect(client.commands).toEqual([command, command]);
    expect(clients.length).toBe(1);
  });

  it("keeps at most the bound and closes the channel there", async () => {
    const { instance, clients } = reader();
    await instance.runReadOnlyCommand("x", 10);
    const client = clients[0]!;
    client.script = (channel) => {
      channel.emit("data", Buffer.from("0123456"));
      channel.emit("data", Buffer.from("789abcdef"));
      channel.emit("data", Buffer.from("more"));
    };
    expect(await instance.runReadOnlyCommand("x", 10)).toBe("0123456789");
    expect(client.channels[1]!.closed).toBe(true);
  });

  it("keeps what came before a failure, and fails when nothing came", async () => {
    const { instance, clients } = reader();
    await instance.runReadOnlyCommand("x", 10);
    const client = clients[0]!;
    client.script = (channel) => {
      channel.emit("data", Buffer.from("part"));
      channel.emit("error", new Error("reset"));
    };
    expect(await instance.runReadOnlyCommand("x", 100)).toBe("part");
    client.script = (channel) => channel.emit("error", new Error("reset"));
    await expect(instance.runReadOnlyCommand("x", 100)).rejects.toThrow("reset");
  });

  it("ends the command when the signal fires, and runs nothing once it has", async () => {
    const { instance, clients } = reader();
    await instance.runReadOnlyCommand("x", 10);
    const client = clients[0]!;
    client.script = () => undefined;
    const control = new AbortController();
    const running = instance.runReadOnlyCommand("slow", 100, control.signal);
    await new Promise((resolve) => setTimeout(resolve, 5));
    control.abort();
    await expect(running).rejects.toThrow("cancelled");
    expect(client.channels[1]!.closed).toBe(true);
    await expect(instance.runReadOnlyCommand("never", 100, control.signal)).rejects.toThrow("cancelled");
    expect(client.commands).not.toContain("never");
  });
});

// A Changes command whose signal or deadline
// fires while the transcript connection is being made (SSH connecting, or
// SFTP opening) is never sent: the call ends at once, and when the link comes
// nothing is run on it. Through the gate (3 at once, 5 s made 10 ms here), six
// timed-out reads leave no command to start later.
const pause = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const config = { host: "box", port: 22, username: "me", privateKeyPath: "/k", herdrSession: "default" };
/** Settles within `ms` or says it is still waiting. */
const within = <T>(promise: Promise<T>, ms = 50) => Promise.race([promise, pause(ms).then(() => "still waiting" as const)]);

/** A reader whose SSH connection (or, with `holdSftp`, its SFTP) waits for the test. */
function heldReader(options: { timeoutMs?: number; holdSftp?: boolean } = {}) {
  const client = new FakeClient();
  client.holdSftp = options.holdSftp === true;
  let connect: ((client: Client) => void) | null = null;
  const instance = new SshTranscriptReader(config, {} as never, {
    timeoutMs: options.timeoutMs ?? 1_000,
    connect: () =>
      options.holdSftp === true
        ? Promise.resolve(client as unknown as Client)
        : new Promise<Client>((resolve) => {
            connect = resolve;
          }),
  });
  const release = async (): Promise<void> => {
    if (options.holdSftp === true) client.heldSftp?.(undefined, {});
    else connect!(client as unknown as Client);
    await pause(10);
  };
  return { instance, client, release };
}

describe("no Changes command after its signal or deadline fires during link setup", () => {
  for (const held of ["SSH", "SFTP"] as const) {
    const holdSftp = held === "SFTP";

    it(`a signal fired while ${held} is being set up ends the call at once and nothing is sent when it comes`, async () => {
      const { instance, client, release } = heldReader({ holdSftp });
      const control = new AbortController();
      const call = instance.runReadOnlyCommand("status", 100, control.signal);
      await pause(5);
      if (holdSftp) expect(client.heldSftp, "SFTP is being opened").not.toBeNull();
      control.abort();
      await expect(within(call)).rejects.toThrow("cancelled");
      await release();
      expect(client.commands, "nothing sent after the signal").toEqual([]);
      // The link itself is fine: the next command runs on it.
      expect(await instance.runReadOnlyCommand("next", 100)).toBe("out");
      expect(client.commands).toEqual(["next"]);
    });

    it(`the deadline passing while ${held} is being set up ends the call and nothing is sent when it comes`, async () => {
      const { instance, client, release } = heldReader({ holdSftp, timeoutMs: 20 });
      const call = instance.runReadOnlyCommand("status", 100);
      await expect(within(call, 200)).rejects.toThrow("did not finish within");
      await release();
      expect(client.commands, "nothing sent after the deadline").toEqual([]);
      expect(client.channels).toEqual([]);
    });
  }

  it("execBounded sends nothing for a signal that has already fired", async () => {
    const client = new FakeClient();
    const control = new AbortController();
    control.abort();
    await expect(execBounded(client as unknown as Client, "status", 100, control.signal)).rejects.toThrow("cancelled");
    expect(client.commands).toEqual([]);
  });

  it("six reads through the 3-permit gate time out while SSH connects; none starts when it comes, and the permits are free", async () => {
    const { instance, client, release } = heldReader();
    const gate = new CommandGate(3);
    const git = new AgentChangesGitReader(instance, gate, changesLimits({ timeoutMs: 10 }));
    const results = await Promise.all(Array.from({ length: 6 }, () => git.status("/fixture/repo")));
    expect(results.map((result) => result.kind)).toEqual(Array(6).fill("timedOut"));
    expect(gate.available).toBe(3);
    await release();
    expect(client.commands.length, "late commands").toBe(0);
    expect(client.channels.filter((channel) => !channel.closed).length, "open channels").toBe(0);
  });

  it("a signal fired after the exec is sent still closes its channel (unchanged)", async () => {
    const { instance, client, release } = heldReader();
    const control = new AbortController();
    client.script = () => undefined;
    const call = instance.runReadOnlyCommand("slow", 100, control.signal);
    await release();
    expect(client.commands).toEqual(["slow"]);
    control.abort();
    await expect(call).rejects.toThrow("cancelled");
    expect(client.channels[0]!.closed).toBe(true);
  });
});

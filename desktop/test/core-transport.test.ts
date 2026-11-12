// The connection: herdr-core over one SSH exec channel running `hc connect`,
// found as herdr is found, kept connected with backoff. The same cases as the
// iPhone app's CoreTransportTests.swift, plus the link's own close on the
// desktop's exec seam.

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { CoreCommands, CoreCancelledError, CoreLinkError, CoreSshLink, type CoreExecChannel, type CoreExecClient } from "../src/main/herdr/core-ssh";
import { CoreBackoff, CoreSession, CoreSessionError } from "../src/main/herdr/core-session";
import { CoreConnectionError, type CoreLink, type CoreStreamItem } from "../src/main/herdr/core-connection";
import { HostKeyRejectedError } from "../src/main/herdr/host-key-pinning";
import type { CoreJSON } from "../src/main/herdr/core-json";
import { CoreFixtures, CoreTestLink, eventually, pause } from "./support/core-test-link";

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected an error");
}

async function drain(stream: AsyncIterable<CoreStreamItem>): Promise<CoreStreamItem[]> {
  const items: CoreStreamItem[] = [];
  for await (const item of stream) items.push(item);
  return items;
}

describe("finding herdr-core", () => {
  it("the channel runs the lookup, then becomes hc connect", () => {
    const command = CoreCommands.connect;
    expect(command.endsWith('exec "$HC" connect')).toBe(true);
    expect(command.startsWith(CoreCommands.resolution)).toBe(true);
    const execLookup = command.indexOf("C=$(command -v herdr-core");
    const loginLookup = command.indexOf("-lc 'command -v herdr-core");
    const paths = command.indexOf('"$HOME/.local/bin/herdr-core"');
    const anyHC = command.indexOf("command -v hc");
    for (const at of [execLookup, loginLookup, paths, anyHC]) expect(at).toBeGreaterThanOrEqual(0);
    expect(execLookup).toBeLessThan(loginLookup);
    expect(loginLookup).toBeLessThan(paths);
    expect(paths, "every herdr-core place before any hc").toBeLessThan(anyHC);
    expect(command).toContain('hc_is_core "$C"');
    expect(command).toContain(CoreCommands.notInstalledMarker);
  });

  // The lookup runs in /bin/sh with a scratch HOME, only fake executables, and SHELL a non-login wrapper (no
  // /etc/profile path_helper), so no real herdr-core or hc is ever found or run.
  const systemCopies = [
    "/opt/homebrew/bin/herdr-core",
    "/usr/local/bin/herdr-core",
    "/opt/homebrew/bin/hc",
    "/usr/local/bin/hc",
    "/usr/bin/hc",
    "/bin/hc",
    "/usr/bin/herdr-core",
    "/bin/herdr-core",
  ];
  it.skipIf(systemCopies.some((path) => existsSync(path)))("the lookup prefers herdr-core and falls back to the install paths", () => {
    const scratch = process.env["HERDR_TEST_SCRATCH"] ?? tmpdir();
    const home = mkdtempSync(join(scratch, "core-lookup-"));
    const bin = join(home, ".local/bin");
    mkdirSync(bin, { recursive: true });
    const shell = join(home, "plain-sh");
    writeFileSync(shell, '#!/bin/sh\nshift\nexec /bin/sh -c "$1"\n');
    chmodSync(shell, 0o755);
    const makeExecutable = (path: string, version?: string): void => {
      const answer = version === undefined ? "" : `[ "$1" = --version ] && echo '${version}'\n`;
      writeFileSync(path, `#!/bin/sh\n${answer}exit 99\n`);
      chmodSync(path, 0o755);
    };
    const resolve = (extraPath?: string): { status: number; found: string; stderr: string } => {
      try {
        const found = execFileSync("/bin/sh", ["-c", `${CoreCommands.resolution}printf '%s' "$HC"`], {
          env: { HOME: home, SHELL: shell, PATH: [extraPath, "/usr/bin:/bin"].filter((part) => part !== undefined).join(":") },
          stdio: ["ignore", "pipe", "pipe"],
          encoding: "utf8",
        });
        return { status: 0, found, stderr: "" };
      } catch (error) {
        const failed = error as { status: number; stdout: string; stderr: string };
        return { status: failed.status, found: failed.stdout, stderr: failed.stderr };
      }
    };

    // Nothing installed: the marker, exit 127.
    let result = resolve();
    expect(result.status).toBe(127);
    expect(result.stderr).toContain(CoreCommands.notInstalledMarker);

    // Only an hc: used when it says it is hc; one that does not is another program.
    makeExecutable(join(bin, "hc"));
    result = resolve();
    expect(result.status).toBe(127);
    makeExecutable(join(bin, "hc"), "hc 0.1.16");
    expect(resolve().found).toBe(join(bin, "hc"));

    // herdr-core beside it: herdr-core first.
    makeExecutable(join(bin, "herdr-core"));
    expect(resolve().found).toBe(join(bin, "herdr-core"));

    // On PATH: the exec shell's herdr-core wins over the install paths; an hc on PATH never wins over a herdr-core.
    const onPath = join(home, "tools");
    mkdirSync(onPath, { recursive: true });
    makeExecutable(join(onPath, "hc"), "hc 0.1.16");
    expect(resolve(onPath).found).toBe(join(bin, "herdr-core"));
    makeExecutable(join(onPath, "herdr-core"));
    expect(resolve(onPath).found).toBe(join(onPath, "herdr-core"));
  });

  it("the link says why it ended", () => {
    expect((CoreSshLink.ending("__HC_NOT_INSTALLED__\n", null) as CoreLinkError).fault).toEqual({ kind: "notInstalled" });
    expect((CoreSshLink.ending("hc: cannot start the core\n", null) as CoreLinkError).fault).toEqual({
      kind: "transport",
      detail: "hc: cannot start the core",
    });
    expect(CoreSshLink.ending("", null)).toBeNull();
    expect(CoreSshLink.ending("", new CoreCancelledError())).toBeNull();
    const rejected = new HostKeyRejectedError("h", 22, "ff", "SHA256:f");
    expect(CoreSshLink.ending("", rejected), "host-key rejection keeps its own error").toBe(rejected);
  });
});

/** A fake remote: one exec channel per client, recording what reached it. */
class FakeExec implements CoreExecChannel {
  readonly written: Uint8Array[] = [];
  closed = false;
  private stdout: ((bytes: Uint8Array) => void) | null = null;
  private stderr: ((bytes: Uint8Array) => void) | null = null;
  private ends: ((error: unknown) => void)[] = [];
  /** A write the remote holds (its window exhausted) never completes. */
  holdWrites = false;
  write(bytes: Uint8Array): void {
    this.written.push(bytes);
  }
  onStdout(listener: (bytes: Uint8Array) => void): void {
    this.stdout = listener;
  }
  onStderr(listener: (bytes: Uint8Array) => void): void {
    this.stderr = listener;
  }
  onEnd(listener: (error: unknown) => void): void {
    this.ends.push(listener);
  }
  close(): void {
    this.closed = true;
  }
  out(text: string): void {
    this.stdout?.(new TextEncoder().encode(text));
  }
  err(text: string): void {
    this.stderr?.(new TextEncoder().encode(text));
  }
  end(error: unknown = null): void {
    for (const listener of this.ends.splice(0)) listener(error);
  }
}

class FakeClient implements CoreExecClient {
  readonly commands: string[] = [];
  readonly channel = new FakeExec();
  closes = 0;
  exec(command: string): Promise<CoreExecChannel> {
    this.commands.push(command);
    return Promise.resolve(this.channel);
  }
  close(): void {
    this.closes += 1;
  }
}

describe("the SSH link", () => {
  it("runs hc connect on its own client; bytes sent before the channel opens are queued, then written in order", async () => {
    const client = new FakeClient();
    const link = new CoreSshLink(CoreCommands.connect, () => Promise.resolve(client));
    expect(link.send(Uint8Array.of(1))).toBe(true);
    expect(link.send(Uint8Array.of(2))).toBe(true);
    await eventually(() => client.commands.length === 1);
    expect(client.commands).toEqual([CoreCommands.connect]);
    await eventually(() => client.channel.written.length === 2);
    link.send(Uint8Array.of(3));
    expect(client.channel.written.map((bytes) => [...bytes])).toEqual([[1], [2], [3]]);
    client.channel.out("hello");
    expect(new TextDecoder().decode((await link.inbound.take()) ?? new Uint8Array())).toBe("hello");
    link.close();
  });

  it("close ends the client at once, even with a write the remote holds", async () => {
    const client = new FakeClient();
    client.channel.holdWrites = true;
    const link = new CoreSshLink(CoreCommands.connect, () => Promise.resolve(client));
    await eventually(() => client.commands.length === 1);
    link.send(new Uint8Array(1 << 20));
    link.close();
    expect(client.closes).toBe(1);
    expect(client.channel.closed).toBe(true);
    expect(link.send(Uint8Array.of(1))).toBe(false);
    expect(await link.inbound.take()).toBeNull();
  });

  it("a client that connects after the link closed is closed with no exec opened", async () => {
    const client = new FakeClient();
    let connect: (value: CoreExecClient) => void = () => undefined;
    const link = new CoreSshLink(CoreCommands.connect, () => new Promise<CoreExecClient>((resolve) => (connect = resolve)));
    link.close();
    connect(client);
    await pause(5);
    expect(client.closes).toBe(1);
    expect(client.commands).toEqual([]);
  });

  it("the remote ending ends the link with what stderr said, and the client goes", async () => {
    const client = new FakeClient();
    const link = new CoreSshLink(CoreCommands.connect, () => Promise.resolve(client));
    await eventually(() => client.commands.length === 1);
    client.channel.err("__HC_NOT_INSTALLED__\n");
    client.channel.end();
    const error = await rejection(link.inbound.take());
    expect((error as CoreLinkError).fault.kind).toBe("notInstalled");
    expect(client.closes).toBe(1);
  });
});

/** Hands the session one link per attempt, as planned. */
type Step = { kind: "answer" } | { kind: "answerWith"; hello: CoreJSON } | { kind: "fail"; error: unknown };

class LinkRecorder {
  private steps: Step[] = [];
  private readonly links = new Map<number, CoreTestLink>();
  made = 0;
  plan(steps: Step[]): void {
    this.steps = steps;
  }
  next(): CoreLink {
    const index = this.made;
    this.made += 1;
    const step = this.steps.shift() ?? { kind: "answer" };
    if (step.kind === "fail") throw step.error;
    const link = new CoreTestLink(step.kind === "answer" ? CoreFixtures.helloResult() : step.hello);
    this.links.set(index, link);
    return link;
  }
  link(index: number): CoreTestLink | undefined {
    return this.links.get(index);
  }
}

describe("reconnecting", () => {
  it("a dropped core is reconnected with backoff, and the wait resets", async () => {
    const recorder = new LinkRecorder();
    const sleeps: number[] = [];
    const session = new CoreSession({
      backoff: new CoreBackoff(1, 4),
      sleep: (seconds) => {
        sleeps.push(seconds);
        return Promise.resolve();
      },
      makeLink: async () => recorder.next(),
    });
    recorder.plan([
      { kind: "fail", error: new CoreLinkError({ kind: "transport", detail: "network down" }) },
      { kind: "fail", error: new CoreLinkError({ kind: "transport", detail: "still down" }) },
      { kind: "answer" },
      { kind: "answer" },
    ]);
    const connections: unknown[] = [];
    session.onConnection((connection) => connections.push(connection));
    session.start();
    await eventually(() => connections.length === 1);
    expect(sleeps, "doubling while it fails").toEqual([1, 2]);
    const first = connections[0] as import("../src/main/herdr/core-connection").CoreConnection;
    // The link drops: every stream on it ends with a reason, then a new one.
    const stream = first.stream(9);
    recorder.link(2)?.end();
    const items = await drain(stream);
    const last = items.at(-1);
    expect(last?.kind).toBe("lost");
    expect(last?.kind === "lost" && last.reason.includes("closed")).toBe(true);
    await eventually(() => connections.length === 2);
    expect(connections[1]).not.toBe(first);
    expect(sleeps, "a good connection resets the wait").toEqual([1, 2, 1]);
    const state = session.state;
    expect(state.kind).toBe("connected");
    expect(state.kind === "connected" && state.hello.core.name).toBe("studio");
    session.close();
  });

  it("a refusal is not retried", async () => {
    const recorder = new LinkRecorder();
    const sleeps: number[] = [];
    const session = new CoreSession({
      sleep: (seconds) => {
        sleeps.push(seconds);
        return Promise.resolve();
      },
      makeLink: async () => recorder.next(),
    });
    recorder.plan([{ kind: "answerWith", hello: CoreFixtures.helloResult({ generation: 2 }) }]);
    const error = (await rejection(session.connection())) as CoreConnectionError;
    expect(error.fault).toEqual({ kind: "newerGeneration", generation: 2 });
    await pause(20);
    const state = session.state;
    expect(state.kind).toBe("refused");
    const reason = state.kind === "refused" ? state.reason : "";
    expect(reason.startsWith("This Mac runs a newer herdr-core than this app understands")).toBe(true);
    const again = (await rejection(session.connection())) as CoreSessionError;
    expect(again.kind).toBe("refused");
    expect(again.message).toBe(reason);
    expect(sleeps).toEqual([]);
    expect(recorder.made).toBe(1);
    session.close();
  });

  it("no herdr-core is a refusal, and a waiting caller hears the attempt's error", async () => {
    const recorder = new LinkRecorder();
    const session = new CoreSession({ sleep: () => Promise.resolve(), makeLink: async () => recorder.next() });
    recorder.plan([{ kind: "fail", error: new CoreLinkError({ kind: "notInstalled" }) }]);
    const error = (await rejection(session.connection())) as CoreLinkError;
    expect(error.fault).toEqual({ kind: "notInstalled" });
    await pause(20);
    expect(session.state).toEqual({ kind: "refused", reason: new CoreLinkError({ kind: "notInstalled" }).message });
    session.close();
  });

  it("closing ends everything", async () => {
    const recorder = new LinkRecorder();
    const session = new CoreSession({ sleep: () => Promise.resolve(), makeLink: async () => recorder.next() });
    recorder.plan([{ kind: "answer" }]);
    const connection = await session.connection();
    const stream = connection.stream(3);
    session.close();
    const items = await drain(stream);
    expect(items.at(-1)?.kind).toBe("lost");
    const error = (await rejection(session.connection())) as CoreSessionError;
    expect(error.kind).toBe("closed");
    expect(session.state).toEqual({ kind: "closed" });
    expect(recorder.link(0)?.isClosed).toBe(true);
  });
});

// This Mac's first connection (the first snapshot carries the command
// connection's epoch, so New workspace works right after it), one deadline
// for a snapshot, a stale socket left by an exited Herdr read as not running
// (a malformed reply or Herdr's own error still an error), a closed or
// timed-out command's whole process group ended (a child that ignores SIGHUP
// included), and an ended local SFTP that changes nothing more. Against the fake This Mac in the
// scratch folder; never this Mac's own Herdr, socket or home.

import { spawn } from "node:child_process";
import {
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import path from "node:path";

import type { Client, ClientChannel } from "ssh2";
import { afterEach, describe, expect, it } from "vitest";

import { SshTranscriptReader } from "../src/main/chat/ssh-reader";
import { MemoryPinStore, PinningHostKeyPolicy } from "../src/main/herdr/host-key-pinning";
import { connectLocal, LocalSftp } from "../src/main/herdr/local";
import { newWorkspace } from "../src/main/herdr/new-workspace";
import { HostRegistry } from "../src/main/hosts";
import { addThisMac, ThisMacBackend, thisMacConfig, thisMacId, thisMacText, type ThisMacOptions } from "../src/main/this-mac";
import { ssh2UploadSftp } from "../src/main/uploads/sftp";
import { maximumAgeMs, sweepUploads } from "../src/main/uploads/sweep";
import { uploadAttachment } from "../src/main/uploads/upload";
import { isOwnedUploadPath, isUploadFolder } from "../src/shared/attachments";
import { newWorkspaceMachines } from "../src/shared/new-workspace";
import { closeFakeMacs, eventually, makeFakeMac, scratch, type FakeMac } from "./support/this-mac-fake";

const backends: ThisMacBackend[] = [];
const registries: HostRegistry[] = [];
const closers: Array<() => void> = [];
/** Pids a test started that must not outlive it (killed in afterEach only if a test failed to end them). */
const started: number[] = [];

afterEach(async () => {
  for (const close of closers.splice(0)) close();
  for (const registry of registries.splice(0)) registry.close();
  for (const backend of backends.splice(0)) backend.close();
  for (const pid of started.splice(0)) if (alive(pid)) process.kill(pid, "SIGKILL");
  await closeFakeMacs();
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const quoted = (value: string): string => "'" + value.split("'").join("'\"'\"'") + "'";

const policy = (): PinningHostKeyPolicy => new PinningHostKeyPolicy(new MemoryPinStore());

function backendWith(options: ThisMacOptions): ThisMacBackend {
  const backend = new ThisMacBackend(options);
  backends.push(backend);
  return backend;
}

function registryWith(options: ThisMacOptions): { registry: HostRegistry; backend: ThisMacBackend } {
  const registry = new HostRegistry(() => undefined);
  registries.push(registry);
  return { registry, backend: addThisMac(registry, options) };
}

/** A socket file at `socketPath` whose server (a child process of this test) has exited: what an unclean Herdr quit leaves. */
async function leaveStaleSocket(socketPath: string): Promise<void> {
  mkdirSync(path.dirname(socketPath), { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", 'require("node:net").createServer().listen(process.argv[1], () => process.exit(0));', socketPath], { stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`the stale-socket server exited ${String(code)}`))));
  });
  expect(lstatSync(socketPath).isSocket()).toBe(true);
}

/** A script that ignores SIGHUP, writes its pid to its first argument and sleeps (stdio away from the command's pipes). */
function hupProofChild(fake: FakeMac): { command: string; pid: () => number } {
  const script = path.join(fake.root, "hup-proof.sh");
  const pidFile = path.join(fake.root, "hup-proof.pid");
  writeFileSync(script, 'trap "" HUP\nprintf "%s" "$$" > "$1"\nexec /bin/sleep 30\n');
  return {
    command: `/bin/sh ${quoted(script)} ${quoted(pidFile)} </dev/null >/dev/null 2>&1 & wait`,
    pid: () => (existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8")) || 0 : 0),
  };
}

type Done<T> = (error: Error | null | undefined, value?: T) => void;

/** The call's error, or its value. */
function settle<T>(start: (done: Done<T>) => void): Promise<Error | T | undefined> {
  return new Promise((resolve) => start((error, value) => resolve(error ?? value)));
}

/** This process's open descriptors on the file `target` names. */
function descriptorsOn(target: Stats): number[] {
  return readdirSync("/dev/fd")
    .map(Number)
    .filter((fd) => {
      try {
        const stats = fstatSync(fd);
        return stats.ino === target.ino && stats.dev === target.dev;
      } catch {
        return false;
      }
    });
}

describe.skipIf(process.platform !== "darwin")("This Mac's first connection and its deadline", () => {
  it("New workspace right after the first connect: the first snapshot carries the command connection's epoch", async () => {
    const fake = makeFakeMac();
    const server = await fake.serve();
    const { registry, backend } = registryWith(fake.options());

    // The first refresh (add() asked for it): connected, on the command connection requests go on now.
    await registry.refresh(thisMacId);
    const host = registry.list()[0]!;
    expect(host).toMatchObject({ id: thisMacId, state: "connected", error: null });
    expect(backend.connectionEpoch()).not.toBeNull();
    expect(host.epoch).toBe(backend.connectionEpoch());
    expect(registry.snapshotEpoch(thisMacId)).toBe(backend.connectionEpoch());
    expect(registry.connectionIdentity(thisMacId)?.epoch).toBe(host.epoch);

    // New workspace with the binding the window has now: made, on that connection.
    const binding = newWorkspaceMachines(registry.list()).find((machine) => machine.hostId === thisMacId)!.binding;
    const made = await newWorkspace(registry, thisMacId, { folder: fake.home, name: "tidepool", binding });
    expect(made).toMatchObject({ workspaceId: "wE", tabId: "wE:t1", paneId: "wE:p1", folder: fake.home });
    expect(server.requests.filter((request) => request.method === "workspace.create")).toHaveLength(1);
  });

  it("one deadline for a snapshot: a Herdr that never answers ends it on time", async () => {
    const fake = makeFakeMac();
    await fake.serve({ answer: () => sleep(5_000).then(() => "{}") });
    const backend = backendWith({ ...fake.options(), requestTimeoutMs: 400 });
    const began = Date.now();
    await expect(backend.snapshot()).rejects.toThrow(/did not answer within/);
    expect(Date.now() - began).toBeLessThan(2_000);
  });

  // The snapshot's deadline owns its request. Real zsh reads only the fake home's
  // startup files (HOME and ZDOTDIR are the fake home), whose .zprofile makes the login read slow.
  it("a slow first login and a Herdr that answers late: the deadline lets go of its request's connection, and a retry answered in budget succeeds", async () => {
    const fake = makeFakeMac();
    let asked = 0;
    await fake.serve({
      answer: async (_request, line) => {
        asked += 1;
        await sleep(asked === 1 ? 2_000 : 450);
        return fake.live.roundTrip(line);
      },
    });
    writeFileSync(path.join(fake.home, ".zprofile"), "export PATH=/usr/bin:/bin\n/bin/sleep 0.3\n");
    const backend = backendWith({ ...fake.options({ ZDOTDIR: fake.home }), shell: "/bin/zsh", login: true, requestTimeoutMs: 600 });

    const began = Date.now();
    await expect(backend.snapshot()).rejects.toThrow(/did not answer within/);
    expect(Date.now() - began).toBeLessThan(1_500);
    // The command connection it opened is let go of with it.
    expect(backend.connectionEpoch()).toBeNull();

    // Retried at once, on a new connection, answered in 450 ms of its 600: nothing of the first request ends it.
    expect((await backend.snapshot()).panes).toHaveLength(2);
    expect(backend.connectionEpoch()).toBe(2);
    await sleep(500);
    expect(backend.connectionEpoch()).toBe(2);
    expect((await backend.snapshot()).panes).toHaveLength(2);
  }, 12_000);

  it("a login read longer than the deadline: the expired request is never sent once the connection is there", async () => {
    const fake = makeFakeMac();
    const server = await fake.serve();
    const done = path.join(fake.home, "login-read.done");
    writeFileSync(path.join(fake.home, ".zprofile"), `export PATH=/usr/bin:/bin\n/bin/sleep 0.8\n: > ${quoted(done)}\n`);
    const backend = backendWith({ ...fake.options({ ZDOTDIR: fake.home }), shell: "/bin/zsh", login: true, requestTimeoutMs: 400 });

    await expect(backend.snapshot()).rejects.toThrow(/did not answer within/);
    expect(backend.connectionEpoch()).toBeNull();
    // The login read finishes later and the connection opens: the expired request is not sent on it.
    await eventually(() => existsSync(done), "the login read", 4_000);
    await sleep(300);
    expect(server.requests).toHaveLength(0);

    // The next snapshot sends one.
    expect((await backend.snapshot()).panes).toHaveLength(2);
    expect(server.requests.map((request) => request.method)).toEqual(["session.snapshot"]);
  }, 12_000);
});

describe.skipIf(process.platform !== "darwin")("a dead socket", () => {
  it("a stale socket left by an exited Herdr reads not running with the hint, refresh after refresh; once Herdr starts, the next refresh connects", async () => {
    const fake = makeFakeMac();
    const socket = path.join(fake.home, ".config", "herdr", "herdr.sock");
    await leaveStaleSocket(socket);
    const { registry } = registryWith(fake.options());

    for (let look = 0; look < 2; look += 1) {
      await registry.refresh(thisMacId);
      expect(registry.list()[0]).toMatchObject({
        state: "offline",
        error: null,
        notRunning: { text: thisMacText.notRunning, hint: thisMacText.startHint },
      });
    }

    // Herdr starts: it replaces its stale socket and listens there.
    unlinkSync(socket);
    await fake.serve();
    await registry.refresh(thisMacId);
    expect(registry.list()[0]).toMatchObject({ state: "connected", error: null });
    expect(registry.list()[0]).not.toHaveProperty("notRunning");
  });

  it("a malformed reply or Herdr's own error is still an error, never 'not running'", async () => {
    const fake = makeFakeMac();
    await fake.serve({ answer: () => "this is not a JSON reply" });
    const { registry } = registryWith(fake.options());
    await registry.refresh(thisMacId);
    const malformed = registry.list()[0]!;
    expect(malformed.state).toBe("offline");
    expect(malformed.error).not.toBeNull();
    expect(malformed).not.toHaveProperty("notRunning");

    await fake.close();
    await fake.serve({ answer: (request) => JSON.stringify({ id: request.id, error: { code: "internal_error", message: "the snapshot failed" } }) });
    await registry.refresh(thisMacId);
    const refused = registry.list()[0]!;
    expect(refused.state).toBe("offline");
    expect(refused.error).toMatch(/the snapshot failed/);
    expect(refused).not.toHaveProperty("notRunning");
  });
});

describe.skipIf(process.platform !== "darwin")("nothing left running", () => {
  it("closing a command ends a child that ignores SIGHUP, after the command's own pipes have closed", async () => {
    const fake = makeFakeMac({ herdr: false });
    const child = hupProofChild(fake);
    const client: Client = await connectLocal(fake.options());
    closers.push(() => client.end());
    let channel: ClientChannel | null = null;
    const closed = new Promise<void>((resolve, reject) =>
      client.exec(child.command, (error, opened) => {
        if (error) {
          reject(error);
          return;
        }
        channel = opened;
        opened.once("close", () => resolve());
      }),
    );
    await eventually(() => child.pid() !== 0, "the child's pid");
    const pid = child.pid();
    started.push(pid);
    (channel as ClientChannel | null)?.close();
    await closed;
    await eventually(() => !alive(pid), "the SIGHUP-ignoring child to end", 5_000);
  });

  it("a command past its deadline: its SIGHUP-ignoring child is gone too", async () => {
    const fake = makeFakeMac({ herdr: false });
    const child = hupProofChild(fake);
    const reader = new SshTranscriptReader(thisMacConfig(), policy(), { connect: () => connectLocal(fake.options()), timeoutMs: 500 });
    closers.push(() => reader.close());
    await expect(reader.runReadOnlyCommand(child.command, 64)).rejects.toThrow(/did not finish within/);
    await eventually(() => child.pid() !== 0, "the child's pid");
    const pid = child.pid();
    started.push(pid);
    await eventually(() => !alive(pid), "the SIGHUP-ignoring child to end", 5_000);
  });

  it("ending the session ends such a child as well", async () => {
    const fake = makeFakeMac({ herdr: false });
    const child = hupProofChild(fake);
    const client: Client = await connectLocal(fake.options());
    client.exec(child.command, () => undefined);
    await eventually(() => child.pid() !== 0, "the child's pid");
    const pid = child.pid();
    started.push(pid);
    client.end();
    await eventually(() => !alive(pid), "the SIGHUP-ignoring child to end", 5_000);
  });
});

describe("an ended local SFTP", () => {
  it("an operation released after its deadline changes nothing on disk", async () => {
    const fake = makeFakeMac({ herdr: false });
    const file = path.join(fake.home, "own-test-file");
    writeFileSync(file, "keep");
    const reader = new SshTranscriptReader(thisMacConfig(), policy(), { connect: () => connectLocal(fake.options()) });
    closers.push(() => reader.close());
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let began: () => void = () => undefined;
    const begun = new Promise<void>((resolve) => {
      began = resolve;
    });
    let late: Promise<unknown> | null = null;
    const request = reader.withSftp(
      "a delayed operation",
      (sftp) => {
        late = (async () => {
          began();
          await gate;
          return settle((done) => sftp.unlink(file, done));
        })();
        return late;
      },
      200,
    );
    await begun;
    await expect(request).rejects.toThrow(/did not finish/);
    release();
    const outcome = await late;
    expect(outcome).toBeInstanceOf(Error);
    expect(readFileSync(file, "utf8")).toBe("keep");
  });

  it("after end: every new call fails, an open that finishes after end is closed at once, a rename stops half way", async () => {
    const home = mkdtempSync(path.join(scratch, "tm-sftp-end-"));
    writeFileSync(path.join(home, "keep.txt"), "keep");
    const ended = new LocalSftp(home);
    ended.end();
    const outcomes = await Promise.all([
      settle((done) => ended.stat("keep.txt", done)),
      settle((done) => ended.lstat("keep.txt", done)),
      settle((done) => ended.realpath(".", done)),
      settle((done) => ended.readdir(".", done)),
      settle<Buffer>((done) => ended.open("new.txt", "w", { mode: 0o600 }, done)),
      settle((done) => ended.mkdir("made", { mode: 0o700 }, done)),
      settle((done) => ended.chmod("keep.txt", 0o600, done)),
      settle((done) => ended.rename("keep.txt", "moved.txt", done)),
      settle((done) => ended.unlink("keep.txt", done)),
      settle((done) => ended.rmdir("made", done)),
    ]);
    for (const outcome of outcomes) {
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toBe("No response from server");
    }
    expect(readdirSync(home)).toEqual(["keep.txt"]);
    expect(readFileSync(path.join(home, "keep.txt"), "utf8")).toBe("keep");

    // An open under way when the session ends: its handle is closed at once, never handed out.
    const racing = new LocalSftp(home);
    const opening = settle<Buffer>((done) => racing.open("raced.txt", "w", { mode: 0o600 }, done));
    racing.end();
    expect(await opening).toBeInstanceOf(Error);
    expect(descriptorsOn(statSync(path.join(home, "raced.txt")))).toEqual([]);

    // A rename (link, then unlink) under way when the session ends: its next step never runs.
    writeFileSync(path.join(home, "from.txt"), "from");
    const renaming = new LocalSftp(home);
    const moving = settle((done) => renaming.rename("from.txt", "to.txt", done));
    renaming.end();
    expect(await moving).toBeInstanceOf(Error);
    expect(readFileSync(path.join(home, "from.txt"), "utf8")).toBe("from");
    expect(existsSync(path.join(home, "to.txt"))).toBe(false);
  });

  it("the local upload and sweep keep a symlink's target and names they do not own out of their reach", async () => {
    const fake = makeFakeMac({ herdr: false });
    const local = new LocalSftp(fake.home);
    const files = ssh2UploadSftp(local as never);
    const outside = path.join(fake.root, "outside");
    mkdirSync(outside);
    const external = path.join(outside, "precious.txt");
    writeFileSync(external, "keep");
    const ownedName = "attachment-11111111-1111-4111-8111-111111111111.txt";
    // A folder named as the app's attachments folder that is a symlink to elsewhere, with an owned-looking name in it.
    symlinkSync(outside, path.join(fake.home, `.herdr-companion-attachments-${"a".repeat(32)}`));
    writeFileSync(path.join(outside, ownedName), "keep too");
    const uploaded = await uploadAttachment(files, Buffer.from("upload"), "txt");
    const link = path.join(path.dirname(uploaded.path), ownedName);
    symlinkSync(external, link);
    writeFileSync(path.join(path.dirname(uploaded.path), "arbitrary.txt"), "keep");
    const old = new Date(Date.now() - 40 * 86_400_000);
    utimesSync(uploaded.path, old, old);

    expect(await sweepUploads(files, Date.now(), maximumAgeMs)).toMatchObject({ removedFiles: 1, removedFolders: 0, stopped: null });
    expect(readFileSync(external, "utf8")).toBe("keep");
    expect(readFileSync(path.join(outside, ownedName), "utf8")).toBe("keep too");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(isOwnedUploadPath(`${fake.home}/../outside/${ownedName}`, fake.home)).toBe(false);
    expect(isOwnedUploadPath(`/absolute/${ownedName}`, fake.home)).toBe(false);
    expect(isUploadFolder(`${fake.home}/../outside`, fake.home)).toBe(false);
    await expect(uploadAttachment(files, Buffer.from("x"), "../txt")).rejects.toThrow();
    local.end();
  });
});

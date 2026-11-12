// The local session's own rules (src/main/herdr/local.ts), under
// the scratch folder: which shell runs the command lines, a login shell's
// banner kept out of a reply, a closed command ending what it started, and
// SFTP's answers over node fs (an absence is NO_SUCH_FILE, a rename never
// replaces a name, a relative path is read from the home).
//
// The account's own login shell, whatever it is, is asked once, as a login
// shell, to run only the environment helper; every command line and the
// terminal then run under /bin/sh with what it wrote. No marker line: no
// profile runs before a command.

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { Client } from "ssh2";
import { afterEach, describe, expect, it } from "vitest";

import { execBounded } from "../src/main/chat/ssh-reader";
import { HerdrNotRunningHereError } from "../src/main/herdr/errors";
import {
  LocalSftp,
  accountLoginShell,
  connectLocal,
  environmentCommand,
  localCommandArgv,
  localTerminalArgv,
  loginShellInvocation,
  parseEnvironmentZero,
  sftpError,
  sftpStatus,
  terminalInnerScript,
  terminalOuterScript,
} from "../src/main/herdr/local";
import { ThisMacBackend } from "../src/main/this-mac";
import { closeFakeMacs, eventually, makeFakeMac, scratch } from "./support/this-mac-fake";

afterEach(async () => {
  await closeFakeMacs();
});

describe("the shell the command lines run under", () => {
  it("the login shell read for the environment is the account's own, whatever it is (fish and csh too)", () => {
    expect(accountLoginShell({ SHELL: "/bin/bash" }, "/opt/homebrew/bin/fish", "darwin")).toBe("/opt/homebrew/bin/fish");
    expect(accountLoginShell({ SHELL: "/bin/tcsh" }, null, "darwin")).toBe("/bin/tcsh");
    expect(accountLoginShell({ SHELL: "fish" }, "", "darwin")).toBe("/bin/zsh");
    expect(accountLoginShell({}, null, "linux")).toBe("/bin/sh");
  });

  it("every command runs as `/bin/sh -c <line>`; the login shell is asked once, as a login shell, to run only /bin/sh with the helper", () => {
    expect(localCommandArgv("git status")).toEqual({ file: "/bin/sh", args: ["-c", "git status"] });
    expect(environmentCommand("/t/hc-env-a/capture")).toBe("/bin/sh /t/hc-env-a/capture");
    expect(loginShellInvocation("/bin/zsh", "/t/hc-env-a/capture")).toEqual({ file: "/bin/zsh", argv0: "-zsh", args: ["-l", "-c", "/t/hc-env-a/capture"] });
    expect(loginShellInvocation("/opt/homebrew/bin/fish", "/t/x/capture")).toEqual({ file: "/opt/homebrew/bin/fish", argv0: "-fish", args: ["-l", "-c", "/t/x/capture"] });
    // csh and tcsh take -l only alone: a leading "-" in argv[0] makes them a login shell, as login(1) does.
    expect(loginShellInvocation("/bin/tcsh", "/t/x/capture")).toEqual({ file: "/bin/tcsh", argv0: "-tcsh", args: ["-c", "/t/x/capture"] });
    expect(loginShellInvocation("/bin/csh", "/t/x/capture")).toEqual({ file: "/bin/csh", argv0: "-csh", args: ["-c", "/t/x/capture"] });
    // The terminal: /bin/sh in the PTY (no login shell), typed into directly.
    expect(localTerminalArgv(30, 90)).toEqual({ file: "/bin/sh", args: ["-c", terminalOuterScript, terminalInnerScript, "30", "90", "/bin/sh"] });
  });

  it("`env -0`'s output: NAME=value entries split at NUL, a value may hold '=' or a newline, nameless entries dropped", () => {
    expect(parseEnvironmentZero(Buffer.from("A=1\0B=x=y\0\0C=multi\nline\0=bad\0noequals\0EMPTY=\0"))).toEqual({ A: "1", B: "x=y", C: "multi\nline", EMPTY: "" });
  });
});

describe.skipIf(process.platform !== "darwin")("the local session's commands", () => {
  it("a login shell that prints a banner first does not spoil a reply: the snapshot still reads", async () => {
    const fake = makeFakeMac();
    await fake.serve();
    // A login shell whose startup prints (as a ~/.zprofile with an echo would), then runs what it was asked to.
    // It is asked once, for the environment, and what it prints goes nowhere.
    const noisy = path.join(fake.root, "noisy-sh");
    writeFileSync(noisy, '#!/bin/sh\nprintf "Welcome back!\\nLast login: today\\n"\nprintf "no newline at the end"\n[ "$1" = "-l" ] && shift\nexec /bin/sh "$@"\n');
    chmodSync(noisy, 0o755);
    const backend = new ThisMacBackend({ ...fake.options(), shell: noisy, login: true });
    try {
      const topology = await backend.snapshot();
      expect(topology.panes.map((pane) => pane.paneID)).toEqual(["w1:p1", "w1:p2"]);
      expect(await backend.changesRunner().runReadOnlyCommand("printf 'only this'", 1_024)).toBe("only this");
    } finally {
      backend.close();
    }
  });

  it("closing a command ends what it started (its process group), and end() closes the session", async () => {
    const fake = makeFakeMac({ herdr: false });
    const client = await connectLocal(fake.options());
    const pidFile = path.join(fake.root, "sleeper.pid");
    let output = "";
    const finished = new Promise<void>((resolve) => {
      client.exec(`sleep 30 & printf '%s' "$!" > '${pidFile}'; printf 'started\\n'; wait`, (error, channel) => {
        expect(error).toBeUndefined();
        channel.on("data", (chunk: Buffer) => {
          output += chunk.toString("utf8");
          if (output.includes("started")) channel.close();
        });
        channel.on("close", () => resolve());
      });
    });
    await finished;
    const sleeper = Number(readFileSync(pidFile, "utf8"));
    await eventually(() => {
      try {
        process.kill(sleeper, 0);
        return false;
      } catch {
        return true;
      }
    }, "the background sleep to end with its group");

    let closed = false;
    client.once("close", () => {
      closed = true;
    });
    client.end();
    await eventually(() => closed, "the session's close");
    await expect(execBounded(client as Client, "printf late", 100)).rejects.toThrow(/Not connected/);
  });

  it("presence never runs herdr: it only asks the shell to resolve it", async () => {
    const fake = makeFakeMac();
    const backend = new ThisMacBackend(fake.options());
    try {
      expect(await backend.presence()).toEqual({ herdr: true, socket: false });
      expect(fake.argv()).toEqual([]);
      await expect(backend.snapshot()).rejects.toBeInstanceOf(HerdrNotRunningHereError);
      expect(fake.argv()).toEqual([]);
    } finally {
      backend.close();
    }
  });
});

describe("the local SFTP", () => {
  const call = <T>(start: (done: (error: Error | undefined | null, value?: T) => void) => void): Promise<T> =>
    new Promise((resolve, reject) => start((error, value) => (error ? reject(error) : resolve(value as T))));

  it("reads a relative path from the home folder and says NO_SUCH_FILE (2) for an absence", async () => {
    const home = mkdtempSync(path.join(scratch, "tm-sftp-"));
    writeFileSync(path.join(home, "agents.json"), "{}\n");
    const sftp = new LocalSftp(home);
    expect((await call<{ size: number }>((done) => sftp.stat("agents.json", done))).size).toBe(3);
    await expect(call((done) => sftp.stat("missing.json", done))).rejects.toMatchObject({ code: sftpStatus.noSuchFile });
    await expect(call((done) => sftp.readdir("missing", done))).rejects.toMatchObject({ code: 2 });
    expect(await call<string>((done) => sftp.realpath(".", done))).toBe(home);
  });

  it("creates a file only when its name is free, and a rename never replaces a name (OpenSSH's rules)", async () => {
    const home = mkdtempSync(path.join(scratch, "tm-sftp-"));
    const sftp = new LocalSftp(home);
    const handle = await call<Buffer>((done) => sftp.open("a.txt", "wx", { mode: 0o600 }, done));
    await call((done) => sftp.write(handle, Buffer.from("one"), 0, 3, 0, done));
    await call((done) => sftp.close(handle, done));
    await expect(call((done) => sftp.open("a.txt", "wx", { mode: 0o600 }, done))).rejects.toMatchObject({ code: sftpStatus.failure });

    writeFileSync(path.join(home, "b.txt"), "two");
    await expect(call((done) => sftp.rename("a.txt", "b.txt", done))).rejects.toMatchObject({ code: sftpStatus.failure });
    expect(readFileSync(path.join(home, "b.txt"), "utf8")).toBe("two");
    expect(readFileSync(path.join(home, "a.txt"), "utf8")).toBe("one");
    await call((done) => sftp.rename("a.txt", "c.txt", done));
    expect(existsSync(path.join(home, "a.txt"))).toBe(false);
    expect(readFileSync(path.join(home, "c.txt"), "utf8")).toBe("one");

    mkdirSync(path.join(home, "folder"));
    await call((done) => sftp.rename("folder", "moved", done));
    expect(existsSync(path.join(home, "moved"))).toBe(true);
  });

  it("maps node's errors as sftp-server's errno_to_portable does", () => {
    expect(sftpError(Object.assign(new Error("x"), { code: "ENOENT" })).code).toBe(2);
    expect(sftpError(Object.assign(new Error("x"), { code: "ENOTDIR" })).code).toBe(2);
    expect(sftpError(Object.assign(new Error("x"), { code: "EACCES" })).code).toBe(3);
    expect(sftpError(Object.assign(new Error("x"), { code: "EEXIST" })).code).toBe(4);
    expect(sftpError(Object.assign(new Error("x"), { code: "EINVAL" })).code).toBe(5);
  });
});

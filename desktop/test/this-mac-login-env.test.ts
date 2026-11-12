// This Mac reads its login environment once. The account's own login shell, whatever
// it is, runs one command: a helper that writes `env -0` into a private file
// (0600, in a 0700 folder made for it), and nothing the shell prints goes
// anywhere. Every command and terminal then runs under /bin/sh with that
// environment: no profile runs before a command, so nothing a profile prints,
// now or later, reaches a reply, and a PATH or XDG_CONFIG_HOME set only in a
// non-POSIX shell's own setup is the one This Mac uses. A profile that hangs
// gives way, after a timeout, to the app's environment with path_helper's
// PATH, with one line in the log and nothing left running.
//
// Each case has its own HOME and ZDOTDIR under the scratch folder (real zsh
// then reads only /etc/zprofile and these startup files, and each .zprofile
// sets PATH itself after path_helper), or a stand-in login shell; never this
// Mac's own profile, its Herdr or its socket.

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { Client } from "ssh2";
import { afterEach, describe, expect, it } from "vitest";

import { execBounded } from "../src/main/chat/ssh-reader";
import { GhosttyActions, ghosttyLocal, systemProbe, type GhosttyInstall } from "../src/main/ghostty";
import { defaultSessionName } from "../src/main/herdr/commands";
import { HerdrNotRunningHereError } from "../src/main/herdr/errors";
import { connectLocal, LoginEnvironment, type LocalSessionOptions } from "../src/main/herdr/local";
import { HostRegistry } from "../src/main/hosts";
import { addThisMac, ThisMacBackend, thisMacId, thisMacText, type ThisMacOptions } from "../src/main/this-mac";
import { closeFakeMacs, eventually, makeFakeMac, type FakeMac } from "./support/this-mac-fake";

const backends: ThisMacBackend[] = [];
const registries: HostRegistry[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.end();
  for (const registry of registries.splice(0)) registry.close();
  for (const backend of backends.splice(0)) backend.close();
  await closeFakeMacs();
});

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const quoted = (value: string): string => "'" + value.split("'").join("'\"'\"'") + "'";

/** The fake home's .zprofile (HOME and ZDOTDIR are the fake home): PATH set again after /etc/zprofile's path_helper, then `body`. */
function zprofile(fake: FakeMac, body: string): void {
  writeFileSync(path.join(fake.home, ".zprofile"), `export PATH=${quoted(`${fake.bin}:/usr/bin:/bin`)}\n${body}`);
}

/** The fake's options with real zsh as the login shell, reading only the fake home's startup files. */
function zshOptions(fake: FakeMac, more: Partial<ThisMacOptions> = {}): ThisMacOptions {
  return { ...fake.options({ ZDOTDIR: fake.home }), shell: "/bin/zsh", login: true, ...more };
}

/** A stand-in login shell (a POSIX script) in the fake's folder: `lines` after the shebang. */
function standIn(fake: FakeMac, name: string, lines: readonly string[]): string {
  const folder = path.join(fake.root, `${name}-bin`);
  mkdirSync(folder, { recursive: true });
  const file = path.join(folder, name);
  writeFileSync(file, ["#!/bin/sh", ...lines, ""].join("\n"));
  chmodSync(file, 0o755);
  return file;
}

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

async function localClient(options: LocalSessionOptions): Promise<Client> {
  const client = await connectLocal(options);
  clients.push(client);
  return client;
}

/** path_helper's PATH, starting from `base` (the fallback's PATH). */
function pathHelperPath(base: string): string {
  const printed = spawnSync("/usr/libexec/path_helper", ["-s"], { env: { PATH: base }, encoding: "utf8" }).stdout;
  return /PATH="([^"]*)"/.exec(printed)?.[1] ?? "";
}

describe.skipIf(process.platform !== "darwin")("This Mac's login environment, read once (commands under /bin/sh)", () => {
  it("a profile that prints late from a background job: nothing of it reaches a command's output or a reply", async () => {
    const fake = makeFakeMac();
    await fake.serve();
    zprofile(fake, '(/bin/sleep 0.05; printf "late-login-banner\\n"; /bin/sleep 0.3; printf "later-login-banner\\n") &\n');

    const client = await localClient(zshOptions(fake));
    expect(await execBounded(client, "/bin/sleep 0.2; printf 'command-output'", 4_096)).toBe("command-output");

    const backend = backendWith(zshOptions(fake));
    const topology = await backend.snapshot();
    expect(topology.panes.map((pane) => pane.paneID)).toEqual(["w1:p1", "w1:p2"]);
    await sleep(400);
    expect(await backend.changesRunner().runReadOnlyCommand("printf 'only this'", 1_024)).toBe("only this");
  });

  it("a profile that reads its command string sees only the environment helper, and cannot print its way into a reply", async () => {
    const fake = makeFakeMac();
    await fake.serve();
    zprofile(
      fake,
      [
        'print -r -- "$ZSH_EXECUTION_STRING" >> "$HOME/seen-commands"',
        "printf '%s\\n' \"$ZSH_EXECUTION_STRING\"",
        "if [[ \"$ZSH_EXECUTION_STRING\" =~ '__herdr_local_[0-9a-f]+__' ]]; then printf '%s\\nprofile-output\\n' \"$MATCH\"; fi",
        "",
      ].join("\n"),
    );
    const seen = (): string[] => readFileSync(path.join(fake.home, "seen-commands"), "utf8").split("\n").filter((line) => line !== "");

    const client = await localClient(zshOptions(fake));
    expect(await execBounded(client, "printf 'command-output'", 4_096)).toBe("command-output");
    expect(await execBounded(client, "printf 'second'", 4_096)).toBe("second");
    // The login shell ran once for that session, and what it was asked to run was the helper's path, never a command line of the app's.
    expect(seen()).toHaveLength(1);

    const backend = backendWith(zshOptions(fake));
    expect((await backend.snapshot()).panes).toHaveLength(2);
    expect(await backend.changesRunner().runReadOnlyCommand("printf 'git-like'", 1_024)).toBe("git-like");
    expect(seen()).toHaveLength(2);
    for (const command of seen()) {
      // /bin/sh reading the helper: two bare absolute paths (no quote, `;` or pipe), never one of the app's lines.
      expect(command).toMatch(/^\/bin\/sh \/[A-Za-z0-9._/-]+$/);
      expect(path.basename(command)).not.toMatch(/printf|base64|herdr/);
    }
  });

  it("real zsh with a noisy profile: requests, Changes' command and a terminal attach and close all run in its environment", async () => {
    const fake = makeFakeMac();
    await fake.serve();
    zprofile(fake, 'printf "login banner\\nno newline"\n');
    const backend = backendWith(zshOptions(fake));

    const topology = await backend.snapshot();
    expect(topology.panes).toHaveLength(2);
    await backend.prompt("w1:p1", "fake prompt");
    expect(fake.prompts).toEqual([{ target: "w1:p1", text: "fake prompt" }]);
    expect(await backend.changesRunner().runReadOnlyCommand("command -v herdr", 4_096)).toBe(`${path.join(fake.bin, "herdr")}\n`);
    expect(fake.argv()).toEqual([]);

    const program = path.join(fake.bin, "herdr");
    writeFileSync(program, readFileSync(program, "utf8").replace("#!/bin/sh\n", '#!/bin/sh\nprintf %s "$$" > "$HOME/terminal.pid"\n'));
    let output = "";
    const handle = await backend.openTerminal(topology.panes[0]!, { rows: 24, cols: 80 }, {
      data: (bytes) => {
        output += Buffer.from(bytes).toString("utf8");
      },
      exit: () => undefined,
    });
    let terminalPid = 0;
    try {
      await eventually(() => output.includes("fake herdr: attached"), "the attach in the login environment");
      terminalPid = Number(readFileSync(path.join(fake.home, "terminal.pid"), "utf8"));
      expect(fake.argv()).toEqual(["--session default terminal attach term-w1:p1"]);
      handle.close();
      await eventually(() => !alive(terminalPid), "the attached program to end with the terminal");
    } finally {
      handle.close();
      if (terminalPid !== 0 && alive(terminalPid)) process.kill(terminalPid, "SIGKILL");
    }
  });

  it("a login shell that reads no POSIX lines (fish-style): the PATH and XDG_CONFIG_HOME its own setup makes are This Mac's", async () => {
    const fake = makeFakeMac();
    const xdg = path.join(fake.root, "xdg");
    const runs = path.join(fake.root, "fish-runs.log");
    // A stand-in for fish: its own setup (config.fish) is the only place PATH and XDG_CONFIG_HOME are set, and it
    // refuses POSIX lines (`${X:-y}`, `[ -S ]`, `;`, pipes) as fish does; a simple command of bare paths runs, as in fish.
    const fish = standIn(fake, "fish", [
      `printf '%s\\n' "$*" >> ${quoted(runs)}`,
      "login=no",
      'if [ "$1" = "-l" ]; then login=yes; shift; fi',
      '[ "$1" = "-c" ] || exit 64',
      'if [ "$login" = yes ]; then',
      `  export PATH=${quoted(`${fake.bin}:/usr/bin:/bin`)}`,
      `  export XDG_CONFIG_HOME=${quoted(xdg)}`,
      "fi",
      'plain=$(printf "%s" "$2" | /usr/bin/tr -d "A-Za-z0-9._/ -")',
      'if [ -z "$plain" ]; then',
      "  set -f",
      "  set -- $2",
      '  for word in "$@"; do case "$word" in /*) ;; *) exit 127 ;; esac; done',
      '  [ -x "$1" ] && exec "$@"',
      "fi",
      "printf 'fish: Unsupported use of POSIX syntax\\n' >&2",
      "exit 127",
    ]);
    // The app's own environment has neither: no fake bin on PATH, no XDG_CONFIG_HOME.
    const options: ThisMacOptions = { ...fake.options(), env: { PATH: "/usr/bin:/bin", HOME: fake.home, LANG: "en_US.UTF-8" }, shell: fish, login: true };
    const { registry, backend } = registryWith(options);

    // Herdr not running yet: herdr resolves through fish's PATH, so the hint is the start hint.
    await registry.refresh(thisMacId);
    expect(registry.list()[0]).toMatchObject({ state: "offline", error: null, notRunning: { text: thisMacText.notRunning, hint: thisMacText.startHint } });

    // Herdr starts with its socket under fish's XDG_CONFIG_HOME: the next refresh finds it.
    await fake.serve({ socketPath: path.join(xdg, "herdr", "herdr.sock") });
    await registry.refresh(thisMacId);
    expect(registry.list()[0]).toMatchObject({ state: "connected", error: null });
    expect(registry.list()[0]).not.toHaveProperty("notRunning");
    expect(await backend.presence()).toEqual({ herdr: true, socket: true });

    // A terminal: the attach line is typed into /bin/sh (fish would refuse it) and finds herdr on fish's PATH.
    const pane = registry.pane(thisMacId, "w1:p2")!;
    let output = "";
    const handle = await backend.openTerminal(pane, { rows: 24, cols: 80 }, {
      data: (bytes) => {
        output += Buffer.from(bytes).toString("utf8");
      },
      exit: () => undefined,
    });
    try {
      await eventually(() => output.includes("fake herdr: attached"), "the attach through fish's PATH");
      expect(fake.argv()).toEqual(["--session default terminal attach term-w1:p2"]);
    } finally {
      handle.close();
    }
    // fish ran as a login shell and was only ever asked to run /bin/sh with the helper.
    const asked = readFileSync(runs, "utf8").split("\n").filter((line) => line !== "");
    expect(asked.length).toBeGreaterThanOrEqual(1);
    for (const line of asked) expect(line).toMatch(/^-l -c \/bin\/sh \/[A-Za-z0-9._/-]+$/);
  });

  it("a profile that hangs: after the timeout the app's environment with path_helper's PATH, one log line, nothing left running", async () => {
    const fake = makeFakeMac({ herdr: false });
    zprofile(fake, 'printf "%s" "$$" > "$HOME/profile.pid"\n/bin/sleep 30 &\nprintf "%s" "$!" > "$HOME/child.pid"\nwait\n');
    const lines: string[] = [];
    const backend = backendWith(zshOptions(fake, { environmentTimeoutMs: 500, log: (line) => lines.push(line) }));

    const began = Date.now();
    await expect(backend.snapshot()).rejects.toBeInstanceOf(HerdrNotRunningHereError);
    expect(Date.now() - began).toBeLessThan(3_000);

    // The app's environment (its HOME) with path_helper's PATH, and one plain line in the log.
    const shown = await backend.changesRunner().runReadOnlyCommand('printf "%s\\n%s" "$PATH" "$HOME"', 8_192);
    expect(shown).toBe(`${pathHelperPath(`${fake.bin}:/usr/bin:/bin`)}\n${fake.home}`);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^This Mac: .*login shell.*path_helper/);

    // Nothing of the login shell is left: neither the shell nor what its profile started.
    const pids = ["profile.pid", "child.pid"].map((name) => Number(readFileSync(path.join(fake.home, name), "utf8")));
    for (const pid of pids) await eventually(() => !alive(pid), `pid ${pid} to end`, 4_000);
    await expect(backend.snapshot()).rejects.toBeInstanceOf(HerdrNotRunningHereError);
    expect(lines).toHaveLength(1);
  }, 12_000);

  it("a profile that waits for input gets none: it reads end of file and the login environment is read at once", async () => {
    const fake = makeFakeMac({ herdr: false });
    zprofile(fake, 'read waiting\nexport HC_AFTER_READ=yes\n');
    const lines: string[] = [];
    const client = await localClient(zshOptions(fake, { environmentTimeoutMs: 4_000, log: (line) => lines.push(line) }));
    const began = Date.now();
    expect(await execBounded(client, 'printf "%s" "$HC_AFTER_READ"', 64)).toBe("yes");
    expect(Date.now() - began).toBeLessThan(2_000);
    expect(lines).toEqual([]);
  }, 12_000);

  it("read once for This Mac, and again when it reconnects (Herdr found after not running, a new command connection)", async () => {
    const fake = makeFakeMac();
    const counter = path.join(fake.root, "login-reads");
    const shell = standIn(fake, "counting-sh", [
      'if [ "$1" = "-l" ]; then shift; fi',
      '[ "$1" = "-c" ] || exit 64',
      `n=$(( $(/bin/cat ${quoted(counter)} 2>/dev/null || printf 0) + 1 ))`,
      `printf '%s' "$n" > ${quoted(counter)}`,
      'export HC_LOGIN_READ="$n"',
      'exec /bin/sh -c "$2"',
    ]);
    const reads = (): number => (existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0);
    const generation = (): Promise<string> => backend.changesRunner().runReadOnlyCommand('printf "%s" "$HC_LOGIN_READ"', 64);
    const backend = backendWith({ ...fake.options(), shell, login: true, requestTimeoutMs: 1_500 });

    // Not running, looked at three times, and commands: one read.
    for (let look = 0; look < 3; look += 1) await expect(backend.snapshot()).rejects.toBeInstanceOf(HerdrNotRunningHereError);
    expect(await generation()).toBe("1");
    expect(reads()).toBe(1);

    // Herdr starts: This Mac finds it after it was not running (a reconnect), and reads the environment again.
    await fake.serve();
    expect((await backend.snapshot()).panes).toHaveLength(2);
    await eventually(() => reads() === 2, "the second read");
    for (let tries = 0; tries < 50 && (await generation()) !== "2"; tries += 1) await sleep(20);
    expect(await generation()).toBe("2");
    await backend.snapshot();
    await backend.snapshot();
    expect(reads()).toBe(2);

    // A Herdr that does not answer in time: the command connection is dropped, and the next one reads it again.
    await fake.close();
    await fake.serve({ answer: () => sleep(4_000).then(() => "{}") });
    const before = backend.connectionEpoch();
    await expect(backend.snapshot()).rejects.toThrow(/did not answer within/);
    await sleep(300);
    await fake.close();
    await fake.serve();
    expect((await backend.snapshot()).panes).toHaveLength(2);
    expect(backend.connectionEpoch()).not.toBe(before);
    await eventually(() => reads() === 3, "the read for the new command connection");
  }, 20_000);

  it("the environment goes through a private file (0600 in a 0700 folder made for it), removed once read", async () => {
    const fake = makeFakeMac({ herdr: false });
    const seen = path.join(fake.root, "helper-folder.txt");
    // A stand-in login shell that runs the helper, then looks at its folder before it exits.
    const shell = standIn(fake, "peeking-sh", [
      'if [ "$1" = "-l" ]; then shift; fi',
      '[ "$1" = "-c" ] || exit 64',
      'export HC_FROM_LOGIN="set by the login shell"',
      '/bin/sh -c "$2" || exit 1',
      'helper=${2##* }',
      'folder=$(/usr/bin/dirname "$helper")',
      `/usr/bin/stat -f '%Lp %N' "$folder" "$folder"/* > ${quoted(seen)}`,
    ]);
    const environment = new LoginEnvironment({ ...fake.options(), shell, login: true });
    const env = await environment.ready();
    expect(env["HC_FROM_LOGIN"]).toBe("set by the login shell");
    expect(env["HOME"]).toBe(fake.home);

    const entries = readFileSync(seen, "utf8").trim().split("\n").map((line) => {
      const space = line.indexOf(" ");
      return { mode: line.slice(0, space), name: line.slice(space + 1) };
    });
    const [folder, ...files] = entries;
    expect(folder?.mode).toBe("700");
    expect(files.length).toBeGreaterThanOrEqual(2);
    // The helper (read by /bin/sh, never run as a program) and the environment file: both 0600.
    for (const file of files) {
      expect(path.dirname(file.name)).toBe(folder?.name);
      expect(file.mode).toBe("600");
    }
    expect(existsSync(folder!.name)).toBe(false);
  });
});

/**
 * A stand-in login shell whose read number n (1, 2, …) exports PATH, XDG_CONFIG_HOME and
 * HC_GENERATION of its own; read 3 and later `failure` (exits 9, or hangs past the deadline).
 */
function generationsShell(fake: FakeMac, failure: "fails" | "hangs"): { shell: string; reads: () => number } {
  const counter = path.join(fake.root, "generation");
  const shell = standIn(fake, `generations-${failure}`, [
    'if [ "$1" = "-l" ]; then shift; fi',
    '[ "$1" = "-c" ] || exit 64',
    `n=$(( $(/bin/cat ${quoted(counter)} 2>/dev/null || printf 0) + 1 ))`,
    `printf '%s' "$n" > ${quoted(counter)}`,
    `if [ "$n" -ge 3 ]; then ${failure === "fails" ? "exit 9" : "exec /bin/sleep 30"}; fi`,
    `export PATH=${quoted(fake.root)}"/bin-$n:/usr/bin:/bin"`,
    `export XDG_CONFIG_HOME=${quoted(fake.root)}"/xdg-$n"`,
    'export HC_GENERATION="$n"',
    'exec /bin/sh -c "$2"',
  ]);
  return { shell, reads: () => (existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0) };
}

describe.skipIf(process.platform !== "darwin")("a failed refresh keeps the latest environment; Ghostty finds the in-app Herdr", () => {
  for (const failure of ["fails", "hangs"] as const) {
    it(`read 1, read 2 with a new PATH and XDG_CONFIG_HOME, then read 3 ${failure}: This Mac stays on read 2`, async () => {
      const fake = makeFakeMac({ herdr: false });
      const { shell, reads } = generationsShell(fake, failure);
      const lines: string[] = [];
      const environment = new LoginEnvironment({ ...fake.options(), shell, login: true, environmentTimeoutMs: 1_500, log: (line) => lines.push(line) });
      const client = await localClient({ ...fake.options(), environment });
      const seen = (): Promise<string> => execBounded(client, 'printf "%s|%s|%s" "$HC_GENERATION" "$PATH" "$XDG_CONFIG_HOME"', 4_096);
      const second = `2|${fake.root}/bin-2:/usr/bin:/bin|${fake.root}/xdg-2`;

      expect(await seen()).toBe(`1|${fake.root}/bin-1:/usr/bin:/bin|${fake.root}/xdg-1`);
      // Read 2: refreshes asked at the same time share one read.
      await Promise.all([environment.refresh(), environment.refresh()]);
      expect(reads()).toBe(2);
      expect(await seen()).toBe(second);

      // Read 3 fails or runs out: the environment read last stays, not the first.
      await environment.refresh();
      expect(reads()).toBe(3);
      expect(environment.current()["HC_GENERATION"]).toBe("2");
      expect(await seen()).toBe(second);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/^This Mac: reading the login shell's environment again failed .*; the one read before stays\.$/);
    }, 12_000);
  }

  it("Open in Ghostty for a fish-style account: its argv reaches the Herdr on the captured PATH, outside the three fallbacks (P13)", async () => {
    const fake = makeFakeMac();
    const xdg = path.join(fake.root, "xdg");
    // fish-style: PATH (with the fake herdr, which is in none of /opt/homebrew/bin, /usr/local/bin or ~/.local/bin)
    // and XDG_CONFIG_HOME are set only in its own login setup.
    const fish = standIn(fake, "fish", [
      'if [ "$1" = "-l" ]; then shift; fi',
      '[ "$1" = "-c" ] || exit 64',
      `export PATH=${quoted(`${fake.bin}:/usr/bin:/bin`)}`,
      `export XDG_CONFIG_HOME=${quoted(xdg)}`,
      'exec /bin/sh -c "$2"',
    ]);
    const { registry, backend } = registryWith({ ...fake.options(), env: { PATH: "/usr/bin:/bin", HOME: fake.home, LANG: "en_US.UTF-8" }, shell: fish, login: true });
    await fake.serve({ socketPath: path.join(xdg, "herdr", "herdr.sock") });
    await registry.refresh(thisMacId);
    expect(registry.list()[0]).toMatchObject({ state: "connected", error: null });

    // main.ts's Ghostty lookup for This Mac, with an injected spawner: Ghostty is never started.
    const mac: GhosttyInstall = { platform: "darwin", appPath: "/Applications/Ghostty.app" };
    const ran: { command: string; args: string[] }[] = [];
    const actions = new GhosttyActions(
      () => mac,
      (hostId, paneId) => {
        const pane = registry.pane(hostId, paneId);
        if (pane === null) return null;
        return {
          pane: { hostKind: "local", paneID: pane.paneID, terminalID: pane.terminalID, ...(pane.agent === undefined ? {} : { agent: pane.agent }) },
          address: null,
          local: ghosttyLocal(backend.loginEnvironment(), defaultSessionName, systemProbe()),
        };
      },
      (command, args) => ran.push({ command, args }),
    );
    expect(actions.availability(thisMacId, "w1:p1")).toEqual({ shown: true, enabled: true });
    expect(actions.open(thisMacId, "w1:p1")).toBeNull();
    expect(ran).toEqual([
      {
        command: "/usr/bin/open",
        args: [
          "-na",
          "/Applications/Ghostty.app",
          "--args",
          "-e",
          "/usr/bin/env",
          "-u",
          "HERDR_SOCKET_PATH",
          `PATH=${fake.bin}:/usr/bin:/bin`,
          `HOME=${fake.home}`,
          `XDG_CONFIG_HOME=${xdg}`,
          path.join(fake.bin, "herdr"),
          "--session",
          "default",
          "terminal",
          "attach",
          "term-w1:p1",
        ],
      },
    ]);

    // What Ghostty would run after -e (never Ghostty), from an environment with neither the fake's PATH nor its HOME: the fake herdr.
    const command = ran[0]!.args.slice(4);
    const run = spawnSync(command[0]!, command.slice(1), { env: { PATH: "/usr/bin:/bin" }, stdio: "ignore", timeout: 5_000 });
    expect(run.status).toBe(0);
    expect(fake.argv()).toEqual(["--session default terminal attach term-w1:p1"]);
  });
});

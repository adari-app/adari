// This Mac without SSH: one LocalSession that gives the app's
// features what an ssh2 Client and its SFTP session give them, run on this
// computer. Every SSH user in the app opens its client through one function
// (HerdrTuiBackend's connect: connectSsh for a saved machine, connectLocal
// here) and calls only these on it:
//
// - exec(command): the same command line under `/bin/sh -c`, started in the
//   home folder, as sshd starts a command, with the login environment (below);
//   its stdout as "data", its stderr on `stderr`, "exit" with the code, then
//   "close"; write() feeds its stdin (the event stream's held socket), close()
//   ends it and everything it started (its own process group);
// - shell(window): a PTY (macOS /usr/bin/script) running /bin/sh
//   interactively at the window's size, in the login environment, typed into
//   as over SSH; setWindow() resizes it (stty -f on its terminal device, so
//   the program hears SIGWINCH);
// - sftp(): node fs behind SFTP's calls (stat, lstat, readdir, realpath, open,
//   read, write, fchmod, close, mkdir, chmod, rename, unlink, rmdir), a
//   relative path read from the home folder as SFTP reads it from the login
//   folder, and errors with SFTP's status codes (an absence is NO_SUCH_FILE,
//   2), as OpenSSH's sftp-server maps them;
// - end(): every command and terminal ended, every SFTP session ended (a call
//   after that, or one under way, does nothing more), then
//   "end" and "close".
//
// The login environment: the account's own login
// shell, whatever it is (zsh, bash, fish, csh, …), is run once as a login
// shell with one simple command, `/bin/sh <helper>` (two bare paths, which
// every shell runs as they are), and the helper writes `env -0` into a
// private file (0600, in a 0700 folder made for it). Its stdin, stdout
// and stderr go nowhere, so nothing a profile prints, then or later, reaches
// any result, and it never sees a command line of the app's. The command
// lines (commands.ts's, POSIX) then run under /bin/sh with that environment,
// so a PATH or XDG_CONFIG_HOME set only in fish's config is still This Mac's.
// The read has a deadline; when it fails or runs out, the app's own
// environment with the PATH from `/usr/libexec/path_helper -s` stands in, and
// one plain line goes to the log. Whatever the login shell left running is
// ended. One LoginEnvironment serves all of This Mac's connections; it is
// read again when This Mac reconnects (this-mac.ts).
//
// Every child is the leader of its own process group, and ending one ends the
// group: SIGHUP, then SIGKILL after a grace and again until none of the group
// is left, whether or not the leader's pipes closed first.
//
// No address, no password, no host key: connectLocal never looks at the host
// key policy or the secret store, so nothing is asked or written for this
// computer. Wire formats and the Herdr protocol are the SSH route's, byte for
// byte: the command lines are commands.ts's.

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Client } from "ssh2";

import { shellQuote } from "./commands";

export interface LocalSessionOptions {
  /**
   * The account's login shell, run once as a login shell to read its
   * environment (default: accountLoginShell(), whatever shell it is).
   */
  readonly shell?: string;
  /** Read the login shell's environment (default true); false: `env` as it is (the tests' fake PATH and HOME). */
  readonly login?: boolean;
  /** The environment the login shell starts with, and the fallback's (default: this process's). */
  readonly env?: NodeJS.ProcessEnv;
  /** The home folder: SFTP's login folder and where commands start (default: os.homedir()). */
  readonly home?: string;
  /** The platform (default: process.platform): the PTY and stty spellings are macOS's on darwin. */
  readonly platform?: NodeJS.Platform;
  /** How long the login shell has to write its environment before the fallback (default 5 s). */
  readonly environmentTimeoutMs?: number;
  /** Where the one plain line about a fallback goes (default console.warn). */
  readonly log?: (line: string) => void;
  /** One login environment for every connection of a This Mac (ThisMacBackend's); default: one for this connection. */
  readonly environment?: LoginEnvironment;
}

function accountShell(): string | null {
  try {
    return os.userInfo().shell;
  } catch {
    return null;
  }
}

/**
 * The account's own login shell, whatever it is (fish and csh too): the
 * account's shell (its directory record), else $SHELL, when it is an absolute
 * path; else /bin/zsh on macOS, /bin/sh elsewhere.
 */
export function accountLoginShell(
  env: NodeJS.ProcessEnv = process.env,
  account: string | null = accountShell(),
  platform: NodeJS.Platform = process.platform,
): string {
  for (const candidate of [account, env["SHELL"]]) {
    if (typeof candidate === "string" && path.isAbsolute(candidate)) return candidate;
  }
  return platform === "darwin" ? "/bin/zsh" : "/bin/sh";
}

/** Shells that take -l only as their one flag (csh, tcsh): a "-" in front of argv[0] alone makes them a login shell. */
const loginByNameOnly = new Set(["csh", "tcsh"]);

/**
 * How the login shell is asked for its environment: as a login shell
 * (argv[0] "-<name>", as login(1) starts one, and `-l` where the shell takes
 * it with -c), running `command` (environmentCommand's: bare absolute paths,
 * which every shell runs as they are).
 */
export function loginShellInvocation(shell: string, command: string, interactive = false): { file: string; argv0: string; args: string[] } {
  const name = path.basename(shell);
  // `-i` too reads the interactive startup files (~/.zshrc), as a terminal's shell does.
  const first = interactive ? ["-i"] : [];
  return { file: shell, argv0: `-${name}`, args: loginByNameOnly.has(name) ? [...first, "-c", command] : [...first, "-l", "-c", command] };
}

/**
 * The one command the login shell runs: /bin/sh reading the helper.
 * The helper is read as a script, never run as a program of its own (macOS
 * checks a new executable before its first run, which takes a while).
 */
export function environmentCommand(helper: string): string {
  return `/bin/sh ${helper}`;
}

/** What one command line runs as: `/bin/sh -c <command>`, in the login environment. */
export function localCommandArgv(command: string): { file: string; args: string[] } {
  return { file: "/bin/sh", args: ["-c", command] };
}

/** `env -0`'s output as an environment: NAME=value entries split at NUL (a value may hold '=' or a newline); an entry with no name is dropped. */
export function parseEnvironmentZero(data: Buffer): Record<string, string> {
  const env: Record<string, string> = {};
  for (const entry of data.toString("utf8").split("\0")) {
    const equals = entry.indexOf("=");
    if (equals <= 0) continue;
    env[entry.slice(0, equals)] = entry.slice(equals + 1);
  }
  return env;
}

/** How long the login shell has to write its environment. */
export const defaultEnvironmentTimeoutMs = 5_000;
/** An environment file larger than this is not one. */
const maxEnvironmentBytes = 1_048_576;
/** Names that describe the shell that read the environment, not the account's environment. */
const readerOnlyNames = ["_", "SHLVL", "PWD", "OLDPWD"];
const pathHelper = "/usr/libexec/path_helper";

/** The private folder's parent: the temporary folder, when its path is plain enough to give any shell as it is; else /tmp. */
function privateParent(): string {
  const temporary = os.tmpdir();
  return /^\/[A-Za-z0-9._/-]*$/.test(temporary) ? temporary : "/tmp";
}

/** The helper the login shell runs: `env -0` into `output` (0600), written whole or not at all. */
function helperScript(output: string): string {
  const partial = `${output}.part`;
  return `#!/bin/sh\numask 077\n/usr/bin/env -0 > ${shellQuote(partial)} && /bin/mv -f ${shellQuote(partial)} ${shellQuote(output)}\n`;
}

interface EnvironmentSettings {
  readonly shell: string;
  readonly login: boolean;
  /** Read as an interactive login shell (absent: a login shell only). */
  readonly interactive?: boolean;
  readonly base: NodeJS.ProcessEnv;
  readonly home: string;
  readonly timeoutMs: number;
  readonly log: (line: string) => void;
}

type EnvironmentRead = { readonly env: NodeJS.ProcessEnv } | { readonly reason: string };

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function seconds(ms: number): string {
  const whole = Math.max(1, Math.round(ms / 1_000));
  return whole === 1 ? "1 second" : `${whole} seconds`;
}

/** The login shell's environment, read once through the helper in a new private folder (removed after). */
async function readLoginEnvironment(settings: EnvironmentSettings): Promise<EnvironmentRead> {
  let folder: string;
  try {
    // mkdtemp makes it 0700.
    folder = fs.mkdtempSync(path.join(privateParent(), "hc-env-"));
  } catch (error) {
    return { reason: `no private folder for it: ${describeError(error)}` };
  }
  try {
    const helper = path.join(folder, "capture");
    const output = path.join(folder, "env");
    fs.writeFileSync(helper, helperScript(output), { mode: 0o600 });
    return await runLoginShell(settings, environmentCommand(helper), output);
  } catch (error) {
    return { reason: describeError(error) };
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
}

/**
 * Runs the login shell with the helper's command: stdio to /dev/null, its own process
 * group. Its environment is read when it exits; at the deadline the group is
 * killed (an environment written by then still counts). Either way, what it
 * left running is ended.
 */
function runLoginShell(settings: EnvironmentSettings, command: string, output: string): Promise<EnvironmentRead> {
  return new Promise((resolve) => {
    const { file, argv0, args } = loginShellInvocation(settings.shell, command, settings.interactive === true);
    let child: ChildProcess;
    try {
      child = spawn(file, args, { argv0, cwd: settings.home, env: settings.base, stdio: "ignore", detached: true });
    } catch (error) {
      resolve({ reason: describeError(error) });
      return;
    }
    let settled = false;
    const collect = (): EnvironmentRead | null => {
      try {
        const data = fs.readFileSync(output);
        if (data.length > maxEnvironmentBytes) return { reason: "its environment was too large" };
        const env = parseEnvironmentZero(data);
        for (const name of readerOnlyNames) delete env[name];
        return { env };
      } catch {
        return null;
      }
    };
    const finish = (read: EnvironmentRead, graceMs: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.pid !== undefined) endGroup(child.pid, graceMs);
      resolve(read);
    };
    const timer = setTimeout(() => finish(collect() ?? { reason: `it did not finish within ${seconds(settings.timeoutMs)}` }, 0), settings.timeoutMs);
    child.once("error", (error) => finish({ reason: describeError(error) }, 0));
    child.once("exit", (code, signal) => {
      finish(collect() ?? { reason: code !== null ? `it exited ${code} without writing it` : `it ended on ${signal ?? "a signal"}` }, killGraceMs);
    });
  });
}

/** path_helper's PATH (from /etc/paths and /etc/paths.d, then `base`'s own), or null when there is none. */
function pathHelperPath(base: NodeJS.ProcessEnv): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(pathHelper, ["-s"], { env: { PATH: base["PATH"] ?? "" }, timeout: 2_000, encoding: "utf8" }, (error, stdout) => {
        resolve(error ? null : (/^PATH="([^"]*)"; export PATH;$/m.exec(stdout)?.[1] ?? null));
      });
    } catch {
      resolve(null);
    }
  });
}

/**
 * This Mac's login environment: read once from the account's login
 * shell (ready()), shared by every connection, read again on refresh(). A
 * first read that fails gives the app's environment with path_helper's PATH;
 * a later one that fails keeps the environment there is (the latest read).
 */
/**
 * The environment an agent has in a pane on This Mac: the account's shell read as an interactive
 * login shell (its ~/.zshrc too: OpenCode's ~/.bun/bin, the keys its providers read), through the same helper and
 * within the same time; null when that read fails (the caller keeps the login environment).
 */
export async function readInteractiveEnvironment(options: Pick<LocalSessionOptions, "shell" | "env" | "home" | "platform" | "environmentTimeoutMs"> = {}): Promise<NodeJS.ProcessEnv | null> {
  const base = options.env ?? process.env;
  const read = await readLoginEnvironment({
    shell: options.shell ?? accountLoginShell(base, accountShell(), options.platform ?? process.platform),
    login: true,
    interactive: true,
    base,
    home: options.home ?? os.homedir(),
    timeoutMs: options.environmentTimeoutMs ?? defaultEnvironmentTimeoutMs,
    log: () => undefined,
  }).catch(() => null);
  return read !== null && "env" in read ? read.env : null;
}

export class LoginEnvironment {
  private readonly settings: EnvironmentSettings;
  private value: NodeJS.ProcessEnv | null = null;
  private first: Promise<NodeJS.ProcessEnv> | null = null;
  private again: Promise<void> | null = null;

  constructor(options: LocalSessionOptions = {}) {
    const base = options.env ?? process.env;
    const platform = options.platform ?? process.platform;
    this.settings = {
      shell: options.shell ?? accountLoginShell(base, accountShell(), platform),
      login: options.login ?? true,
      base,
      home: options.home ?? os.homedir(),
      timeoutMs: options.environmentTimeoutMs ?? defaultEnvironmentTimeoutMs,
      log: options.log ?? ((line) => console.warn(line)),
    };
  }

  /** The environment, read on the first call: the login shell's, or the fallback. */
  ready(): Promise<NodeJS.ProcessEnv> {
    this.first ??= this.read(null).then((env) => {
      this.value = env;
      return env;
    });
    return this.first;
  }

  /** The environment commands and terminals start with now (the app's own until ready() has one). */
  current(): NodeJS.ProcessEnv {
    return this.value ?? this.settings.base;
  }

  /**
   * Reads it again, one read at a time (calls meanwhile share it); commands
   * keep the one there is until the new one is in. A read that fails keeps
   * the latest one, not the first.
   */
  refresh(): Promise<void> {
    if (!this.settings.login) return Promise.resolve();
    const first = this.first;
    if (first === null) return this.ready().then(() => undefined);
    this.again ??= first
      .then(() => this.read(this.current()))
      .then((env) => {
        this.value = env;
      })
      .finally(() => {
        this.again = null;
      });
    return this.again;
  }

  private async read(before: NodeJS.ProcessEnv | null): Promise<NodeJS.ProcessEnv> {
    const { base, login, shell, log } = this.settings;
    if (!login) return base;
    const read = await readLoginEnvironment(this.settings).catch((error: unknown) => ({ reason: describeError(error) }));
    if ("env" in read) return read.env;
    if (before !== null) {
      log(`This Mac: reading the login shell's environment again failed (${shell}: ${read.reason}); the one read before stays.`);
      return before;
    }
    const helperPath = await pathHelperPath(base);
    log(`This Mac: the login shell gave no environment (${shell}: ${read.reason}); using the app's environment with the PATH from path_helper.`);
    return helperPath === null ? { ...base } : { ...base, PATH: helperPath };
  }
}

/**
 * The terminal's PTY (macOS): /usr/bin/script makes it and runs `inner` in it,
 * which sets the window size, writes the terminal device's path to fd 3 (for
 * resizes), closes fd 3 and becomes the shell. script refuses a socket on its
 * stdin (node's stdio is a socketpair), so `cat` copies our stdin into a pipe;
 * once script ends (after copying the PTY's last output) the right side ends
 * `cat` and the group, and the outer shell exits with script's status, which
 * is the shell's (or the attached program's) exit status.
 */
export const terminalInnerScript = 'stty rows "$1" cols "$2" 2>/dev/null; tty >&3; exec 3>&-; shift 2; exec "$@"';
export const terminalOuterScript = [
  "exec 4<&0",
  "trap ':' TERM",
  "/bin/cat <&4 4<&- 3>&- | { exec 4<&-; /usr/bin/script -q /dev/null /bin/sh -c \"$0\" sh \"$@\"; status=$?; trap '' TERM; kill -TERM 0 2>/dev/null; exit $status; }",
].join("\n");

/** What a terminal runs as: the outer script, then the inner one with the size and /bin/sh (in the login environment, no login shell). */
export function localTerminalArgv(rows: number, cols: number): { file: string; args: string[] } {
  return {
    file: "/bin/sh",
    args: ["-c", terminalOuterScript, terminalInnerScript, String(rows), String(cols), "/bin/sh"],
  };
}

/** How long a closed command or terminal has to end after SIGHUP before SIGKILL. */
const killGraceMs = 2_000;
/** SIGKILL again this often while any of the group is left, at most this many times. */
const killRetryMs = 100;
const maxKills = 50;

function signalGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    // EPERM: one of the group is there but cannot be signalled.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Ends the process group `pid` leads: SIGHUP now (unless
 * `graceMs` is 0), then SIGKILL after the grace and again until none of the
 * group is left. It does not stop when the leader exits or its pipes close: a
 * child that ignores SIGHUP and let go of the pipes is still in the group.
 */
export function endGroup(pid: number, graceMs: number = killGraceMs): void {
  if (graceMs > 0 && !signalGroup(pid, "SIGHUP")) return;
  let kills = 0;
  const kill = (): void => {
    if (!signalGroup(pid, 0)) return;
    signalGroup(pid, "SIGKILL");
    kills += 1;
    if (kills >= maxKills) return;
    setTimeout(kill, killRetryMs).unref?.();
  };
  if (graceMs <= 0) kill();
  else setTimeout(kill, graceMs).unref?.();
}

/**
 * One command (or terminal): an ssh2 ClientChannel's events and calls over a
 * child process that leads its own process group.
 */
export class LocalChannel extends EventEmitter {
  readonly stderr = new EventEmitter();
  private exited = false;
  private finished = false;
  private closing = false;

  constructor(
    protected readonly child: ChildProcess,
    private readonly gone: (channel: LocalChannel) => void,
  ) {
    super();
    child.stdout?.on("data", (chunk: Buffer) => this.emit("data", chunk));
    child.stderr?.on("data", (chunk: Buffer) => this.stderr.emit("data", chunk));
    // A write after the command ended (EPIPE) is dropped, as a closed SSH channel drops it.
    child.stdin?.on("error", () => undefined);
    child.once("exit", (code, signal) => this.exit(code, signal));
    child.once("error", (error: Error) => {
      this.stderr.emit("data", Buffer.from(`${error.message}\n`, "utf8"));
      if (child.pid === undefined) {
        // It never started: the shell is missing or the home folder is.
        this.exit(127, null);
        this.finish();
      }
    });
    child.once("close", (code: number | null, signal: NodeJS.Signals | null) => {
      this.exit(code, signal);
      this.finish();
    });
  }

  /** ssh2's "exit": the code, or null and the signal's name without SIG. */
  private exit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) return;
    this.exited = true;
    if (code !== null) this.emit("exit", code);
    else this.emit("exit", null, (signal ?? "SIGKILL").replace(/^SIG/, ""), false, "");
  }

  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.ended();
    this.gone(this);
    this.emit("close");
  }

  /** Called once when it is over (the terminal stops resizing). */
  protected ended(): void {}

  protected get isOver(): boolean {
    return this.finished;
  }

  write(data: string | Uint8Array): boolean {
    if (this.finished || this.child.stdin === null || this.child.stdin.destroyed) return false;
    this.child.stdin.write(data);
    return true;
  }

  /** Closes its stdin (EOF), as ssh2's channel.end(). */
  end(): void {
    if (!this.finished) this.child.stdin?.end();
  }

  /**
   * Ends the command and what it started: its process group, SIGHUP then
   * SIGKILL until none of it is left (endGroup), however soon its own pipes
   * close.
   */
  close(): void {
    if (this.finished || this.closing) return;
    this.closing = true;
    const pid = this.child.pid;
    if (pid === undefined) {
      this.finish();
      return;
    }
    endGroup(pid);
  }

  /** Only a terminal has a window. */
  setWindow(_rows: number, _cols: number, _height: number, _width: number): boolean {
    return false;
  }
}

/** A terminal: its PTY's device, read off fd 3, and the window size set on it with stty. */
class LocalTerminalChannel extends LocalChannel {
  private device: string | null = null;
  private wanted: { rows: number; cols: number } | null = null;
  private resizing = false;

  constructor(
    child: ChildProcess,
    gone: (channel: LocalChannel) => void,
    private readonly env: NodeJS.ProcessEnv,
    private readonly platform: NodeJS.Platform,
  ) {
    super(child, gone);
    let text = "";
    child.stdio[3]?.on("data", (chunk: Buffer) => {
      if (this.device !== null) return;
      text += chunk.toString("utf8");
      const newline = text.indexOf("\n");
      if (newline < 0) {
        if (text.length > 1_024) text = "";
        return;
      }
      const name = text.slice(0, newline).trim();
      text = "";
      if (/^\/dev\/[A-Za-z0-9._/-]{1,64}$/.test(name) && !name.includes("..")) {
        this.device = name;
        this.resize();
      }
    });
  }

  override setWindow(rows: number, cols: number): boolean {
    this.wanted = { rows: Math.max(1, Math.floor(rows)), cols: Math.max(1, Math.floor(cols)) };
    this.resize();
    return true;
  }

  /** One stty at a time, with the latest size asked for. */
  private resize(): void {
    if (this.device === null || this.wanted === null || this.resizing || this.isOver) return;
    const { rows, cols } = this.wanted;
    this.wanted = null;
    this.resizing = true;
    const deviceFlag = this.platform === "darwin" ? "-f" : "-F";
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      this.resizing = false;
      this.resize();
    };
    try {
      const stty = spawn("/bin/stty", [deviceFlag, this.device, "rows", String(rows), "cols", String(cols)], { stdio: "ignore", env: this.env });
      stty.once("error", done);
      stty.once("exit", done);
    } catch {
      done();
    }
  }

  protected override ended(): void {
    this.wanted = null;
  }
}

/** SFTP's status codes (draft-ietf-secsh-filexfer-02), as ssh2 puts them on an error's `code`. */
export const sftpStatus = { eof: 1, noSuchFile: 2, permissionDenied: 3, failure: 4, badMessage: 5 } as const;

/** An SFTP status error, as ssh2 gives one: the status on `code`. */
export class LocalSftpError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
    this.name = "LocalSftpError";
  }
}

/** A node fs error as OpenSSH's sftp-server reports it (errno_to_portable). */
export function sftpError(error: unknown): LocalSftpError {
  const code = typeof error === "object" && error !== null ? (error as NodeJS.ErrnoException).code : undefined;
  switch (code) {
    case "ENOENT":
    case "ENOTDIR":
    case "EBADF":
    case "ELOOP":
      return new LocalSftpError("No such file", sftpStatus.noSuchFile);
    case "EPERM":
    case "EACCES":
    case "EFAULT":
      return new LocalSftpError("Permission denied", sftpStatus.permissionDenied);
    case "ENAMETOOLONG":
    case "EINVAL":
      return new LocalSftpError("Bad message", sftpStatus.badMessage);
    default:
      return new LocalSftpError(error instanceof Error ? error.message : "Failure", sftpStatus.failure);
  }
}

/** SFTP's file attributes (ssh2's Stats): mode, ids, size, times in whole seconds, and the type checks. */
export interface LocalStats {
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
  readonly size: number;
  readonly atime: number;
  readonly mtime: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  isBlockDevice(): boolean;
  isCharacterDevice(): boolean;
  isFIFO(): boolean;
  isSocket(): boolean;
}

function attributes(stats: fs.Stats): LocalStats {
  return {
    mode: stats.mode,
    uid: stats.uid,
    gid: stats.gid,
    size: stats.size,
    atime: Math.floor(stats.atimeMs / 1_000),
    mtime: Math.floor(stats.mtimeMs / 1_000),
    isFile: () => stats.isFile(),
    isDirectory: () => stats.isDirectory(),
    isSymbolicLink: () => stats.isSymbolicLink(),
    isBlockDevice: () => stats.isBlockDevice(),
    isCharacterDevice: () => stats.isCharacterDevice(),
    isFIFO: () => stats.isFIFO(),
    isSocket: () => stats.isSocket(),
  };
}

export interface LocalDirectoryEntry {
  readonly filename: string;
  readonly longname: string;
  readonly attrs: LocalStats;
}

type Done<T = void> = (error: Error | undefined | null, value?: T) => void;

/**
 * What a call on an ended local SFTP session gets, new or
 * under way, as ssh2 fails a request its closed SFTP channel never answered.
 */
export class LocalSftpEndedError extends Error {
  constructor() {
    super("No response from server");
    this.name = "LocalSftpEndedError";
  }
}

/**
 * SFTP's calls over node fs, for one home folder. A handle is an opaque
 * Buffer, as ssh2's are; it stays valid until close. After end() nothing more
 * happens: a new call fails at once, a call under way stops before its next
 * step and fails, and a file whose open finishes after end is closed at once.
 */
export class LocalSftp extends EventEmitter {
  private readonly handles = new Map<string, number>();
  private nextHandle = 0;
  private over = false;

  constructor(private readonly home: string) {
    super();
  }

  /** A path as the SFTP server reads it: relative to the login (home) folder. */
  private full(target: string): string {
    return path.resolve(this.home, target);
  }

  /** True (and `done` told) when the session has ended. */
  private ended(done: (error: Error) => void): boolean {
    if (!this.over) return false;
    done(new LocalSftpEndedError());
    return true;
  }

  /** A node callback for `done`: the error as SFTP's, or the ended error when the session ended meanwhile. */
  private settle<T>(done: Done<T>): (error: NodeJS.ErrnoException | null, value?: T) => void {
    return (error, value) => {
      if (this.ended(done)) return;
      if (error) done(sftpError(error));
      else done(undefined, value);
    };
  }

  private statsDone(done: Done<LocalStats>): (error: NodeJS.ErrnoException | null, stats: fs.Stats) => void {
    return (error, stats) => {
      if (this.ended(done)) return;
      if (error) done(sftpError(error));
      else done(undefined, attributes(stats));
    };
  }

  private fd(handle: Buffer): number | null {
    return this.handles.get(handle.toString("hex")) ?? null;
  }

  stat(target: string, done: Done<LocalStats>): void {
    if (this.ended(done)) return;
    fs.stat(this.full(target), this.statsDone(done));
  }

  lstat(target: string, done: Done<LocalStats>): void {
    if (this.ended(done)) return;
    fs.lstat(this.full(target), this.statsDone(done));
  }

  realpath(target: string, done: Done<string>): void {
    if (this.ended(done)) return;
    fs.realpath.native(this.full(target), this.settle(done));
  }

  /** The folder's entries with their lstat attributes (READDIR's: a symlink is itself); one gone meanwhile is left out. */
  readdir(target: string, done: Done<LocalDirectoryEntry[]>): void {
    if (this.ended(done)) return;
    const folder = this.full(target);
    fs.readdir(folder, (error, names) => {
      if (this.ended(done)) return;
      if (error) {
        done(sftpError(error));
        return;
      }
      const entries: LocalDirectoryEntry[] = [];
      let waiting = names.length;
      if (waiting === 0) {
        done(undefined, entries);
        return;
      }
      for (const name of names) {
        fs.lstat(path.join(folder, name), (statError, stats) => {
          if (!statError) entries.push({ filename: name, longname: name, attrs: attributes(stats) });
          waiting -= 1;
          if (waiting === 0 && !this.ended(done)) done(undefined, entries);
        });
      }
    });
  }

  open(target: string, flags: string, attributesOrDone: { mode?: number } | Done<Buffer>, maybeDone?: Done<Buffer>): void {
    const done = typeof attributesOrDone === "function" ? attributesOrDone : maybeDone!;
    const mode = typeof attributesOrDone === "function" ? 0o666 : (attributesOrDone.mode ?? 0o666);
    if (this.ended(done)) return;
    fs.open(this.full(target), flags, mode, (error, fd) => {
      if (error) {
        if (!this.ended(done)) done(sftpError(error));
        return;
      }
      if (this.over) {
        // Opened after the session ended: closed at once, never handed out.
        fs.close(fd, () => done(new LocalSftpEndedError()));
        return;
      }
      const handle = Buffer.alloc(4);
      handle.writeUInt32BE(this.nextHandle);
      this.nextHandle = (this.nextHandle + 1) >>> 0;
      this.handles.set(handle.toString("hex"), fd);
      done(undefined, handle);
    });
  }

  read(handle: Buffer, buffer: Buffer, offset: number, length: number, position: number, done: (error: Error | undefined, bytesRead?: number, buffer?: Buffer, position?: number) => void): void {
    if (this.ended(done)) return;
    const fd = this.fd(handle);
    if (fd === null) {
      done(new LocalSftpError("Invalid handle", sftpStatus.failure));
      return;
    }
    fs.read(fd, buffer, offset, length, position, (error, bytesRead) => {
      if (this.ended(done)) return;
      if (error) done(sftpError(error));
      else done(undefined, bytesRead, buffer, position);
    });
  }

  write(handle: Buffer, buffer: Buffer, offset: number, length: number, position: number, done: Done): void {
    if (this.ended(done)) return;
    const fd = this.fd(handle);
    if (fd === null) {
      done(new LocalSftpError("Invalid handle", sftpStatus.failure));
      return;
    }
    const writeAll = (written: number): void => {
      if (this.ended(done)) return;
      if (written >= length) {
        done(undefined);
        return;
      }
      fs.write(fd, buffer, offset + written, length - written, position + written, (error, count) => {
        if (error) {
          if (!this.ended(done)) done(sftpError(error));
        } else if (count <= 0) {
          if (!this.ended(done)) done(new LocalSftpError("Failure", sftpStatus.failure));
        } else writeAll(written + count);
      });
    };
    writeAll(0);
  }

  fchmod(handle: Buffer, mode: number, done: Done): void {
    if (this.ended(done)) return;
    const fd = this.fd(handle);
    if (fd === null) {
      done(new LocalSftpError("Invalid handle", sftpStatus.failure));
      return;
    }
    fs.fchmod(fd, mode, this.settle(done));
  }

  fstat(handle: Buffer, done: Done<LocalStats>): void {
    if (this.ended(done)) return;
    const fd = this.fd(handle);
    if (fd === null) {
      done(new LocalSftpError("Invalid handle", sftpStatus.failure));
      return;
    }
    fs.fstat(fd, this.statsDone(done));
  }

  close(handle: Buffer, done: Done): void {
    if (this.ended(done)) return;
    const key = handle.toString("hex");
    const fd = this.handles.get(key);
    if (fd === undefined) {
      done(new LocalSftpError("Invalid handle", sftpStatus.failure));
      return;
    }
    this.handles.delete(key);
    fs.close(fd, this.settle(done));
  }

  mkdir(target: string, attributesOrDone: { mode?: number } | Done, maybeDone?: Done): void {
    const done = typeof attributesOrDone === "function" ? attributesOrDone : maybeDone!;
    const mode = typeof attributesOrDone === "function" ? 0o777 : (attributesOrDone.mode ?? 0o777);
    if (this.ended(done)) return;
    fs.mkdir(this.full(target), { mode }, (error) => this.settle(done)(error ?? null));
  }

  chmod(target: string, mode: number, done: Done): void {
    if (this.ended(done)) return;
    fs.chmod(this.full(target), mode, this.settle(done));
  }

  /**
   * OpenSSH's posix-rename@openssh.com extension (ssh2's
   * ext_openssh_rename): rename(2), the new name replaced in one step when it
   * is there (the start-commands save, start-commands-sftp.ts).
   */
  ext_openssh_rename(from: string, to: string, done: Done): void {
    if (this.ended(done)) return;
    fs.rename(this.full(from), this.full(to), this.settle(done));
  }

  /**
   * SFTP's rename as OpenSSH's sftp-server does it: never over an existing
   * name. A regular file is linked to the new name and then unlinked from the
   * old (EEXIST is a failure); anything else is renamed only when the new name
   * is free. Each step starts only while the session is open.
   */
  rename(from: string, to: string, done: Done): void {
    if (this.ended(done)) return;
    const source = this.full(from);
    const target = this.full(to);
    fs.lstat(source, (error, stats) => {
      if (this.ended(done)) return;
      if (error) {
        done(sftpError(error));
        return;
      }
      if (stats.isFile()) {
        fs.link(source, target, (linkError) => {
          if (linkError) {
            if (!this.ended(done)) done(sftpError(linkError));
            return;
          }
          if (this.over) {
            // Ended between the two steps: the old name stays, the new one goes again.
            fs.unlink(target, () => done(new LocalSftpEndedError()));
            return;
          }
          fs.unlink(source, (unlinkError) => {
            if (!unlinkError) {
              this.settle(done)(null);
              return;
            }
            // Leave it as it was: the new name goes again.
            fs.unlink(target, () => (this.ended(done) ? undefined : done(sftpError(unlinkError))));
          });
        });
        return;
      }
      fs.lstat(target, (targetError) => {
        if (this.ended(done)) return;
        if (!targetError) {
          done(new LocalSftpError("Failure", sftpStatus.failure));
          return;
        }
        fs.rename(source, target, this.settle(done));
      });
    });
  }

  unlink(target: string, done: Done): void {
    if (this.ended(done)) return;
    fs.unlink(this.full(target), this.settle(done));
  }

  rmdir(target: string, done: Done): void {
    if (this.ended(done)) return;
    fs.rmdir(this.full(target), this.settle(done));
  }

  /** Ends the session: every handle still open is closed, and nothing more happens. */
  end(): void {
    this.over = true;
    for (const fd of this.handles.values()) fs.close(fd, () => undefined);
    this.handles.clear();
  }
}

type ChannelDone = (error: Error | undefined, channel?: LocalChannel) => void;

/** What a local session needs: the login environment its children start with, the home folder and the platform. */
interface LocalSession {
  readonly environment: LoginEnvironment;
  readonly home: string;
  readonly platform: NodeJS.Platform;
}

/**
 * The local session: ssh2 Client's exec, shell, sftp and end, with its "end"
 * and "close" events. It never emits "error". Callbacks run before any of the
 * channel's events can (a child's events come on later turns), so a caller's
 * listeners are in place first.
 */
export class LocalClient extends EventEmitter {
  private readonly channels = new Set<LocalChannel>();
  private readonly sftps = new Set<LocalSftp>();
  private over = false;

  constructor(private readonly session: LocalSession) {
    super();
  }

  /** The home folder its commands start in and its SFTP reads relative paths from. */
  get home(): string {
    return this.session.home;
  }

  /** The command line under /bin/sh in the login environment (no login shell, no marker). */
  exec(command: string, optionsOrDone: object | ChannelDone, maybeDone?: ChannelDone): boolean {
    const done = typeof optionsOrDone === "function" ? (optionsOrDone as ChannelDone) : maybeDone!;
    if (this.over) {
      done(new Error("Not connected"));
      return false;
    }
    const { file, args } = localCommandArgv(command);
    let child: ChildProcess;
    try {
      child = spawn(file, args, { cwd: this.session.home, env: this.session.environment.current(), stdio: ["pipe", "pipe", "pipe"], detached: true });
    } catch (error) {
      done(error instanceof Error ? error : new Error(String(error)));
      return false;
    }
    const channel = new LocalChannel(child, (gone) => this.channels.delete(gone));
    this.channels.add(channel);
    done(undefined, channel);
    return true;
  }

  /** A PTY running /bin/sh in the login environment (no login shell), typed into as over SSH. */
  shell(window: { term?: string; rows?: number; cols?: number } | ChannelDone, maybeDone?: ChannelDone): boolean {
    const done = typeof window === "function" ? window : maybeDone!;
    const asked = typeof window === "function" ? {} : window;
    if (this.over) {
      done(new Error("Not connected"));
      return false;
    }
    if (this.session.platform !== "darwin") {
      done(new Error("A terminal on this computer needs macOS"));
      return false;
    }
    const rows = Math.max(1, Math.floor(asked.rows ?? 24));
    const cols = Math.max(1, Math.floor(asked.cols ?? 80));
    const env = { ...this.session.environment.current(), TERM: asked.term ?? "xterm-256color" };
    const { file, args } = localTerminalArgv(rows, cols);
    let child: ChildProcess;
    try {
      child = spawn(file, args, { cwd: this.session.home, env, stdio: ["pipe", "pipe", "pipe", "pipe"], detached: true });
    } catch (error) {
      done(error instanceof Error ? error : new Error(String(error)));
      return false;
    }
    const channel = new LocalTerminalChannel(child, (gone) => this.channels.delete(gone), env, this.session.platform);
    this.channels.add(channel);
    done(undefined, channel);
    return true;
  }

  sftp(done: (error: Error | undefined, sftp?: LocalSftp) => void): boolean {
    if (this.over) {
      done(new Error("Not connected"));
      return false;
    }
    const sftp = new LocalSftp(this.session.home);
    this.sftps.add(sftp);
    done(undefined, sftp);
    return true;
  }

  /** Ends every command and terminal it started (their process groups) and every SFTP session, then "end" and "close" (once). */
  end(): this {
    if (this.over) return this;
    this.over = true;
    for (const channel of this.channels) channel.close();
    for (const sftp of this.sftps) sftp.end();
    this.sftps.clear();
    setImmediate(() => {
      this.emit("end");
      this.emit("close");
    });
    return this;
  }
}

/**
 * Opens This Mac's local session: what connectSsh opens for a saved machine,
 * with nothing to sign in to, once the login environment is there (read now
 * if no session of this This Mac has read it yet). The features take it as
 * the ssh2 Client they call (LocalClient has every call they make: exec,
 * shell, sftp, end, on, once).
 */
export async function connectLocal(options: LocalSessionOptions = {}): Promise<Client> {
  const environment = options.environment ?? new LoginEnvironment(options);
  await environment.ready();
  return new LocalClient({ environment, home: options.home ?? os.homedir(), platform: options.platform ?? process.platform }) as unknown as Client;
}

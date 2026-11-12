// "Open in Ghostty": opens a pane in the real Ghostty app, attached to the
// same Herdr pane over SSH. Pure parts only (detection with injected probes,
// the argv, whether the item is shown and enabled); the one real spawner,
// `detachedSpawn`, is passed in by the caller. Nothing here runs ssh or
// Ghostty by itself.
//
// Ghostty's docs this follows:
// - https://ghostty.org/docs/config/reference#command: "Ghostty supports the
//   common `-e` flag for executing a command with arguments. For example,
//   `ghostty -e fish --with --custom --args`."
// - https://ghostty.org/docs/config/reference#initial-command: `-e` "Disables
//   shell expansion since the input is expected to already be shell-expanded by
//   the upstream". So every argv element below goes through as it is; the only
//   shell that parses anything is the remote login shell, which gets the attach
//   command already single-quoted by commands.ts (attachCommand/typedAttachLine).
//   This Mac's argv goes through no shell at all.
// - https://ghostty.org/docs/config/reference#working-directory: on macOS
//   Ghostty can tell it was "launched from launchd (double-clicked) or `open`".
// - https://ghostty.org/docs/config#syntax: "Every configuration key is a valid
//   CLI flag when launching Ghostty from the command-line."
// The docs do not spell out `open -na Ghostty.app --args …` for macOS; it is
// the macOS way to start a new instance of an app with arguments, and launching
// through `open` is the case the working-directory entry names.

import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";

import type { GhosttyAvailability } from "../shared/ipc-contract";
import { officialSessionName, typedAttachLine, type AttachTarget } from "./herdr/commands";
import { UnsafeAttachTargetError } from "./herdr/errors";
import { attachTargetFor } from "./herdr/ssh";

// MARK: - detection

/** What detection may look at; the tests pass a fake one. */
export interface GhosttyProbe {
  exists(path: string): boolean;
  isExecutable(path: string): boolean;
  readonly home: string;
  readonly pathEnv: string | undefined;
}

/** The real file system, home folder and PATH (no child processes, no Spotlight query). */
export function systemProbe(): GhosttyProbe {
  return {
    exists(path) {
      try {
        statSync(path);
        return true;
      } catch {
        return false;
      }
    },
    isExecutable(path) {
      try {
        if (!statSync(path).isFile()) return false;
        accessSync(path, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
    home: homedir(),
    pathEnv: process.env["PATH"],
  };
}

export type GhosttyInstall =
  | { readonly platform: "darwin"; readonly appPath: string }
  | { readonly platform: "linux"; readonly binaryPath: string };

/**
 * Where Ghostty is installed, or null. macOS: the app bundle at
 * /Applications/Ghostty.app, else ~/Applications/Ghostty.app (a bundle with its
 * Contents/Info.plist). Checked by path, not by bundle id: the docs name
 * `com.mitchellh.ghostty` only as the macOS config folder and the GTK class,
 * never as the bundle id, and looking an id up needs a Spotlight query (a
 * child process). Linux: the first executable `ghostty` in an absolute PATH
 * entry. Windows and anything else: null (the item is not shown).
 */
export function findGhostty(platform: NodeJS.Platform, probe: GhosttyProbe): GhosttyInstall | null {
  if (platform === "darwin") {
    const candidates = ["/Applications/Ghostty.app"];
    if (probe.home.startsWith("/")) candidates.push(probe.home.replace(/\/+$/, "") + "/Applications/Ghostty.app");
    const appPath = candidates.find((path) => probe.exists(path + "/Contents/Info.plist"));
    return appPath === undefined ? null : { platform: "darwin", appPath };
  }
  if (platform === "linux") {
    for (const entry of (probe.pathEnv ?? "").split(":")) {
      if (!entry.startsWith("/")) continue;
      const binaryPath = entry.replace(/\/+$/, "") + "/ghostty";
      if (probe.isExecutable(binaryPath)) return { platform: "linux", binaryPath };
    }
    return null;
  }
  return null;
}

// MARK: - the command

/** The saved host and the pane to attach. */
export interface GhosttyTarget {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly herdrSession: string;
  readonly attach: AttachTarget;
}

/** Why a pane cannot open in Ghostty; nothing is run. */
export class GhosttyRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GhosttyRefusal";
  }
}

const maxNameBytes = 255;

/** Printable ASCII, no spaces, not starting with "-" (so ssh never reads it as an option). */
function checkName(value: string, what: string): void {
  if (value === "") throw new GhosttyRefusal(`The ${what} is empty, so this pane cannot open in Ghostty.`);
  if (value.startsWith("-")) throw new GhosttyRefusal(`The ${what} starts with "-", so this pane cannot open in Ghostty.`);
  if (!/^[\x21-\x7e]+$/.test(value)) {
    throw new GhosttyRefusal(`The ${what} has a space, a control or a non-ASCII character, so this pane cannot open in Ghostty.`);
  }
  if (Buffer.byteLength(value, "utf8") > maxNameBytes) {
    throw new GhosttyRefusal(`The ${what} is over ${maxNameBytes} bytes, so this pane cannot open in Ghostty.`);
  }
}

/**
 * The system ssh's argv (the user's own ssh config and agent): a terminal
 * (`-t`), the saved port and user, `--` before the host, and the attach
 * command commands.ts builds, checked by typedAttachLine (unsafe ids refused).
 */
export function sshArgv(target: GhosttyTarget): string[] {
  checkName(target.host, "host");
  checkName(target.username, "user name");
  if (!Number.isInteger(target.port) || target.port < 1 || target.port > 65_535) {
    throw new GhosttyRefusal("The port is not a number from 1 to 65535, so this pane cannot open in Ghostty.");
  }
  const session = officialSessionName(target.herdrSession);
  if (session === null || session !== target.herdrSession) {
    throw new GhosttyRefusal("The Herdr session name is not valid, so this pane cannot open in Ghostty.");
  }
  let line: string;
  try {
    line = typedAttachLine(target.attach, session);
  } catch (error) {
    if (error instanceof UnsafeAttachTargetError) {
      throw new GhosttyRefusal(`This pane's id cannot be passed safely to the remote shell (${error.reason}).`);
    }
    throw error;
  }
  const remoteCommand = line.endsWith("\n") ? line.slice(0, -1) : line;
  return ["ssh", "-t", "-p", String(target.port), "-l", target.username, "--", target.host, remoteCommand];
}

/** What runs: macOS `open -na <Ghostty.app> --args -e ssh …`; Linux `ghostty -e ssh …`. */
export function ghosttyCommand(install: GhosttyInstall, target: GhosttyTarget): { command: string; args: string[] } {
  return ghosttyRunning(install, sshArgv(target));
}

function ghosttyRunning(install: GhosttyInstall, argv: readonly string[]): { command: string; args: string[] } {
  if (install.platform === "darwin") {
    return { command: "/usr/bin/open", args: ["-na", install.appPath, "--args", "-e", ...argv] };
  }
  return { command: install.binaryPath, args: ["-e", ...argv] };
}

/**
 * This Mac's Herdr and session (no address: nothing goes through ssh):
 * the herdr the in-app pane finds and the login environment it runs in
 * (ThisMacBackend.loginEnvironment).
 */
export interface GhosttyLocal {
  /** localHerdr's: herdr's absolute path, or null when the login environment has none. */
  readonly herdr: string | null;
  readonly env: NodeJS.ProcessEnv;
  readonly herdrSession: string;
}

/** A This Mac pane to attach, and its Herdr. */
export interface GhosttyLocalTarget extends GhosttyLocal {
  readonly attach: AttachTarget;
}

/** A herdr path /usr/bin/env runs as a program (absolute; with "=" env would read it as a setting). */
function usableHerdr(file: string): boolean {
  return file.startsWith("/") && !file.includes("=");
}

/**
 * This Mac's herdr as the in-app pane's attach line finds
 * it in the login environment: the first executable `herdr` in PATH's
 * absolute entries, else /opt/homebrew/bin, /usr/local/bin, then
 * ~/.local/bin; null when there is none.
 */
export function localHerdr(env: NodeJS.ProcessEnv, probe: Pick<GhosttyProbe, "isExecutable">): string | null {
  const home = env["HOME"];
  const folders = [
    ...(env["PATH"] ?? "").split(":"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    ...(home !== undefined && home.startsWith("/") ? [home.replace(/\/+$/, "") + "/.local/bin"] : []),
  ];
  for (const folder of folders) {
    if (!folder.startsWith("/")) continue;
    const file = folder.replace(/\/+$/, "") + "/herdr";
    if (usableHerdr(file) && probe.isExecutable(file)) return file;
  }
  return null;
}

/** This Mac's Ghostty settings from its login environment (`env`): its herdr, and that environment. */
export function ghosttyLocal(env: NodeJS.ProcessEnv, herdrSession: string, probe: Pick<GhosttyProbe, "isExecutable">): GhosttyLocal {
  return { herdr: localHerdr(env, probe), env, herdrSession };
}

/**
 * This Mac's argv: that herdr attaching the
 * pane, started by /usr/bin/env with the login environment's PATH, HOME and
 * XDG_CONFIG_HOME (each one set there; XDG_CONFIG_HOME and
 * HERDR_SOCKET_PATH cleared otherwise, as the attach line clears the
 * latter), so it finds the socket and config the in-app pane does. Every
 * value is an argv value of its own; no shell reads any of it. The session
 * and the id are checked as for SSH (typedAttachLine: unsafe ids refused).
 */
export function localArgv(target: GhosttyLocalTarget): string[] {
  const session = officialSessionName(target.herdrSession);
  if (session === null || session !== target.herdrSession) {
    throw new GhosttyRefusal("The Herdr session name is not valid, so this pane cannot open in Ghostty.");
  }
  try {
    typedAttachLine(target.attach, session);
  } catch (error) {
    if (error instanceof UnsafeAttachTargetError) {
      throw new GhosttyRefusal(`This pane's id cannot be passed safely to Herdr (${error.reason}).`);
    }
    throw error;
  }
  if (target.herdr === null || !usableHerdr(target.herdr)) {
    throw new GhosttyRefusal("Herdr is not on This Mac's login PATH, so this pane cannot open in Ghostty.");
  }
  const set = (["PATH", "HOME", "XDG_CONFIG_HOME"] as const).filter((name) => (target.env[name] ?? "") !== "");
  const identifier = target.attach.kind === "agent" ? target.attach.paneID : target.attach.terminalID;
  return [
    "/usr/bin/env",
    "-u",
    "HERDR_SOCKET_PATH",
    ...(set.includes("XDG_CONFIG_HOME") ? [] : ["-u", "XDG_CONFIG_HOME"]),
    ...set.map((name) => `${name}=${target.env[name]}`),
    target.herdr,
    "--session",
    session,
    target.attach.kind,
    "attach",
    identifier,
  ];
}

/** What runs for This Mac: macOS `open -na <Ghostty.app> --args -e /usr/bin/env … <herdr> --session … attach <id>`. */
export function ghosttyLocalCommand(install: GhosttyInstall, target: GhosttyLocalTarget): { command: string; args: string[] } {
  return ghosttyRunning(install, localArgv(target));
}

// MARK: - the menu item

export type { GhosttyAvailability };

export type GhosttyHostKind = "ssh" | "demo" | "herdr-core" | "local";

export interface GhosttyPane {
  readonly hostKind: GhosttyHostKind;
  readonly paneID: string;
  readonly terminalID: string;
  readonly agent?: string;
}

/** The saved SSH host's address (null for a host that has none). */
export interface GhosttyHostAddress {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly herdrSession: string;
}

export const ghosttyReasons = {
  core: "herdr-core panes cannot open in Ghostty yet: the core backend has no attach command.",
  demo: "A demo machine has no SSH address to open.",
  noTerminal: "This pane has no terminal to attach.",
  gone: "That pane is no longer listed.",
  notInstalled: "Ghostty is not installed.",
} as const;

/** The target for a pane on an SSH host, or null when the pane has nothing to attach. */
export function ghosttyTarget(pane: GhosttyPane, address: GhosttyHostAddress): GhosttyTarget | null {
  const attach = attachTargetFor(pane);
  return attach === null ? null : { ...address, attach };
}

/** The target for a pane on This Mac, or null when the pane has nothing to attach. */
export function ghosttyLocalTarget(pane: GhosttyPane, local: GhosttyLocal): GhosttyLocalTarget | null {
  const attach = attachTargetFor(pane);
  return attach === null ? null : { ...local, attach };
}

/**
 * Whether "Open in Ghostty" is shown for a pane, and if not enabled, why:
 * hidden when Ghostty is not installed; disabled for herdr-core panes, demo
 * machines, a pane with no terminal, or a target ssh would refuse. A This Mac
 * pane opens its Herdr directly, with no ssh and no shell.
 */
export function ghosttyAvailability(
  install: GhosttyInstall | null,
  pane: GhosttyPane,
  address: GhosttyHostAddress | null,
  local: GhosttyLocal | null = null,
): GhosttyAvailability {
  if (install === null) return { shown: false };
  if (pane.hostKind === "herdr-core" || pane.paneID.startsWith("hc:")) {
    return { shown: true, enabled: false, reason: ghosttyReasons.core };
  }
  if (pane.hostKind === "local" && local !== null) {
    const target = ghosttyLocalTarget(pane, local);
    if (target === null) return { shown: true, enabled: false, reason: ghosttyReasons.noTerminal };
    try {
      localArgv(target);
    } catch (error) {
      if (error instanceof GhosttyRefusal) return { shown: true, enabled: false, reason: error.message };
      throw error;
    }
    return { shown: true, enabled: true };
  }
  if (pane.hostKind === "demo" || pane.hostKind === "local" || address === null) return { shown: true, enabled: false, reason: ghosttyReasons.demo };
  const target = ghosttyTarget(pane, address);
  if (target === null) return { shown: true, enabled: false, reason: ghosttyReasons.noTerminal };
  try {
    sshArgv(target);
  } catch (error) {
    if (error instanceof GhosttyRefusal) return { shown: true, enabled: false, reason: error.message };
    throw error;
  }
  return { shown: true, enabled: true };
}

/** Builds the command and hands it to `spawn` once; a refused target throws before anything runs. */
export function launchGhostty(
  install: GhosttyInstall,
  target: GhosttyTarget,
  run: (command: string, args: string[]) => void,
): void {
  const { command, args } = ghosttyCommand(install, target);
  run(command, args);
}

/** The real spawner: detached, no stdio, not waited for. Passed in by the caller only. */
export function detachedSpawn(command: string, args: string[]): void {
  const child = spawn(command, args, { detached: true, stdio: "ignore", shell: false });
  child.on("error", () => undefined);
  child.unref();
}

// MARK: - the IPC's side

/** A listed pane and its machine's saved address (null for a machine with none, such as a demo one). */
export interface GhosttyPaneFound {
  readonly pane: GhosttyPane;
  readonly address: GhosttyHostAddress | null;
  /** This Mac's Herdr, login environment and session (absent for any other machine). */
  readonly local?: GhosttyLocal;
}

/**
 * What the page may ask: whether the item shows for a pane, and to open it.
 * Ghostty is looked for on every ask (a few stat calls), so installing it
 * shows the item without a restart. Open asks the same question again before
 * anything runs, and runs once.
 */
export class GhosttyActions {
  constructor(
    private readonly detect: () => GhosttyInstall | null,
    private readonly lookup: (hostId: string, paneId: string) => GhosttyPaneFound | null,
    private readonly run: (command: string, args: string[]) => void,
  ) {}

  availability(hostId: string, paneId: string): GhosttyAvailability {
    const install = this.detect();
    if (install === null) return { shown: false };
    const found = this.lookup(hostId, paneId);
    if (found === null) return { shown: true, enabled: false, reason: ghosttyReasons.gone };
    return ghosttyAvailability(install, found.pane, found.address, found.local ?? null);
  }

  /** Starts Ghostty for the pane: null once started, else why nothing ran. */
  open(hostId: string, paneId: string): string | null {
    const install = this.detect();
    if (install === null) return ghosttyReasons.notInstalled;
    const found = this.lookup(hostId, paneId);
    if (found === null) return ghosttyReasons.gone;
    const availability = ghosttyAvailability(install, found.pane, found.address, found.local ?? null);
    if (!availability.shown) return ghosttyReasons.notInstalled;
    if (!availability.enabled) return availability.reason;
    if (found.pane.hostKind === "local" && found.local !== undefined) {
      const local = ghosttyLocalTarget(found.pane, found.local);
      if (local === null) return ghosttyReasons.noTerminal;
      try {
        const { command, args } = ghosttyLocalCommand(install, local);
        this.run(command, args);
      } catch (error) {
        if (error instanceof GhosttyRefusal) return error.message;
        return `Ghostty did not start: ${error instanceof Error ? error.message : String(error)}`;
      }
      return null;
    }
    const target = found.address === null ? null : ghosttyTarget(found.pane, found.address);
    if (target === null) return ghosttyReasons.noTerminal;
    try {
      launchGhostty(install, target, this.run);
    } catch (error) {
      if (error instanceof GhosttyRefusal) return error.message;
      return `Ghostty did not start: ${error instanceof Error ? error.message : String(error)}`;
    }
    return null;
  }
}

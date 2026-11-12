// "Open in Ghostty": the argv per platform, quoting, refusals, and
// detection, all with injected probes and spawners. Nothing here runs ssh,
// `open` or Ghostty.

import { describe, expect, it } from "vitest";

import {
  findGhostty,
  GhosttyActions,
  type GhosttyPaneFound,
  ghosttyAvailability,
  ghosttyCommand,
  ghosttyReasons,
  GhosttyRefusal,
  launchGhostty,
  sshArgv,
  type GhosttyInstall,
  type GhosttyProbe,
  type GhosttyTarget,
} from "../src/main/ghostty";
import { attachCommand, type AttachTarget } from "../src/main/herdr/commands";

const mac: GhosttyInstall = { platform: "darwin", appPath: "/Applications/Ghostty.app" };
const linux: GhosttyInstall = { platform: "linux", binaryPath: "/usr/bin/ghostty" };

const terminal: AttachTarget = { kind: "terminal", terminalID: "t-7" };
const agent: AttachTarget = { kind: "agent", paneID: "w2:p1" };

function target(overrides: Partial<GhosttyTarget> = {}): GhosttyTarget {
  return { host: "build-box.local", port: 22, username: "robin", herdrSession: "default", attach: terminal, ...overrides };
}

function probe(files: readonly string[], options: { executable?: readonly string[]; home?: string; path?: string } = {}): GhosttyProbe {
  const present = new Set(files);
  const executable = new Set(options.executable ?? []);
  return {
    exists: (path) => present.has(path),
    isExecutable: (path) => executable.has(path),
    home: options.home ?? "/Users/fixture",
    pathEnv: options.path,
  };
}

describe("the argv", () => {
  it("opens a new Ghostty instance with ssh -t on macOS", () => {
    expect(ghosttyCommand(mac, target())).toEqual({
      command: "/usr/bin/open",
      args: ["-na", "/Applications/Ghostty.app", "--args", "-e", "ssh", "-t", "-p", "22", "-l", "robin", "--", "build-box.local", attachCommand(terminal, "default")],
    });
  });

  it("runs ghostty -e ssh -t on Linux", () => {
    expect(ghosttyCommand(linux, target())).toEqual({
      command: "/usr/bin/ghostty",
      args: ["-e", "ssh", "-t", "-p", "22", "-l", "robin", "--", "build-box.local", attachCommand(terminal, "default")],
    });
  });

  it("passes hosts, users and ports as their own argv elements", () => {
    expect(sshArgv(target({ host: "::1", username: "first.last", port: 2222 }))).toEqual([
      "ssh",
      "-t",
      "-p",
      "2222",
      "-l",
      "first.last",
      "--",
      "::1",
      attachCommand(terminal, "default"),
    ]);
    expect(sshArgv(target({ host: "10.0.0.5", herdrSession: "work" })).at(-1)).toBe(attachCommand(terminal, "work"));
  });

  it("uses the attach command commands.ts builds, for terminals and agents", () => {
    const forTerminal = sshArgv(target()).at(-1)!;
    const forAgent = sshArgv(target({ attach: agent })).at(-1)!;
    expect(forTerminal).toBe(attachCommand(terminal, "default"));
    expect(forTerminal).toContain(" terminal attach 't-7'");
    expect(forAgent).toBe(attachCommand(agent, "default"));
    expect(forAgent).toContain(" agent attach 'w2:p1'");
    expect(forAgent.endsWith("\n")).toBe(false);
  });

  it("single-quotes an id with a quote inside the remote command", () => {
    const quoted: AttachTarget = { kind: "agent", paneID: "w1:p'1" };
    const command = sshArgv(target({ attach: quoted })).at(-1)!;
    expect(command).toBe(attachCommand(quoted, "default"));
    expect(command).toContain(` agent attach 'w1:p'"'"'1'`);
  });
});

describe("refusals", () => {
  it("refuses unsafe ids", () => {
    for (const terminalID of ["", "t\u0007", "t-é", "t\n", "x".repeat(257)]) {
      expect(() => sshArgv(target({ attach: { kind: "terminal", terminalID } })), JSON.stringify(terminalID)).toThrow(GhosttyRefusal);
    }
    expect(() => sshArgv(target({ attach: { kind: "terminal", terminalID: "x".repeat(256) } }))).not.toThrow();
  });

  it("refuses hosts and users that ssh could read as options or that hold spaces", () => {
    for (const host of ["", "-oProxyCommand=evil", "build box", "box\nother", "box\t", "höst", "a".repeat(256)]) {
      expect(() => sshArgv(target({ host })), JSON.stringify(host)).toThrow(GhosttyRefusal);
    }
    for (const username of ["", "-l", "ro bin", "robin\n", "r\u0000"]) {
      expect(() => sshArgv(target({ username })), JSON.stringify(username)).toThrow(GhosttyRefusal);
    }
  });

  it("refuses ports outside 1 to 65535 and session names Herdr would not take", () => {
    for (const port of [0, 65_536, 1.5, -22, Number.NaN]) {
      expect(() => sshArgv(target({ port })), String(port)).toThrow(GhosttyRefusal);
    }
    expect(() => sshArgv(target({ port: 65_535 }))).not.toThrow();
    for (const herdrSession of ["", "..", "a b", "x;y"]) {
      expect(() => sshArgv(target({ herdrSession })), herdrSession).toThrow(GhosttyRefusal);
    }
  });
});

describe("detection", () => {
  it("finds the app in /Applications, then in ~/Applications", () => {
    expect(findGhostty("darwin", probe(["/Applications/Ghostty.app/Contents/Info.plist"]))).toEqual(mac);
    expect(findGhostty("darwin", probe(["/Users/fixture/Applications/Ghostty.app/Contents/Info.plist"]))).toEqual({
      platform: "darwin",
      appPath: "/Users/fixture/Applications/Ghostty.app",
    });
    expect(
      findGhostty("darwin", probe(["/Applications/Ghostty.app/Contents/Info.plist", "/Users/fixture/Applications/Ghostty.app/Contents/Info.plist"])),
    ).toEqual(mac);
  });

  it("finds nothing on a Mac without Ghostty", () => {
    expect(findGhostty("darwin", probe([]))).toBeNull();
    // A folder named like the app without a bundle inside is not the app.
    expect(findGhostty("darwin", probe(["/Applications/Ghostty.app"]))).toBeNull();
  });

  it("finds ghostty on the Linux PATH", () => {
    const found = findGhostty("linux", probe([], { path: "/usr/local/bin:/usr/bin", executable: ["/usr/bin/ghostty"] }));
    expect(found).toEqual(linux);
    expect(findGhostty("linux", probe([], { path: "/opt/g/:/usr/bin", executable: ["/opt/g/ghostty", "/usr/bin/ghostty"] }))).toEqual({
      platform: "linux",
      binaryPath: "/opt/g/ghostty",
    });
  });

  it("skips relative and empty PATH entries and files that are not executable", () => {
    expect(findGhostty("linux", probe([], { path: "bin::./tools", executable: ["bin/ghostty", "./tools/ghostty", "/ghostty"] }))).toBeNull();
    expect(findGhostty("linux", probe(["/usr/bin/ghostty"], { path: "/usr/bin" }))).toBeNull();
    expect(findGhostty("linux", probe([], { path: "/usr/bin" }))).toBeNull();
    expect(findGhostty("linux", probe([], { path: undefined }))).toBeNull();
  });

  it("is never shown on Windows", () => {
    expect(findGhostty("win32", probe(["/Applications/Ghostty.app/Contents/Info.plist"], { path: "/usr/bin", executable: ["/usr/bin/ghostty"] }))).toBeNull();
  });
});

describe("the menu item", () => {
  const address = { host: "build-box.local", port: 22, username: "robin", herdrSession: "default" };
  const pane = { hostKind: "ssh" as const, paneID: "w1:p1", terminalID: "t-1", agent: "claude" };

  it("is hidden when Ghostty is not installed", () => {
    expect(ghosttyAvailability(null, pane, address)).toEqual({ shown: false });
  });

  it("is disabled with a reason for herdr-core panes", () => {
    expect(ghosttyAvailability(mac, { ...pane, paneID: "hc:abc" }, address)).toEqual({ shown: true, enabled: false, reason: ghosttyReasons.core });
    expect(ghosttyAvailability(mac, { ...pane, hostKind: "herdr-core" }, address)).toEqual({ shown: true, enabled: false, reason: ghosttyReasons.core });
  });

  it("is disabled for a demo machine", () => {
    expect(ghosttyAvailability(mac, { ...pane, hostKind: "demo" }, null)).toEqual({ shown: true, enabled: false, reason: ghosttyReasons.demo });
  });

  it("is disabled for a pane with nothing to attach", () => {
    expect(ghosttyAvailability(linux, { hostKind: "ssh", paneID: "w1:p2", terminalID: "" }, address)).toEqual({
      shown: true,
      enabled: false,
      reason: ghosttyReasons.noTerminal,
    });
  });

  it("is disabled with the refusal for an unsafe target", () => {
    const unsafe = ghosttyAvailability(mac, { ...pane, terminalID: "t\u0007" }, address);
    expect(unsafe.shown && !unsafe.enabled ? unsafe.reason : null).toMatch(/cannot be passed safely/);
    const badHost = ghosttyAvailability(mac, pane, { ...address, host: "-oProxyCommand=x" });
    expect(badHost.shown && !badHost.enabled ? badHost.reason : null).toMatch(/starts with "-"/);
  });

  it("is enabled for an SSH pane with a terminal", () => {
    expect(ghosttyAvailability(mac, pane, address)).toEqual({ shown: true, enabled: true });
    expect(ghosttyAvailability(linux, { hostKind: "ssh", paneID: "w1:p3", terminalID: "", agent: "codex" }, address)).toEqual({
      shown: true,
      enabled: true,
    });
  });
});

describe("launching", () => {
  it("hands the command to the injected spawner once", () => {
    const calls: [string, string[]][] = [];
    launchGhostty(mac, target(), (command, args) => calls.push([command, args]));
    expect(calls).toEqual([[ghosttyCommand(mac, target()).command, ghosttyCommand(mac, target()).args]]);
  });

  it("spawns nothing for a refused target", () => {
    const calls: string[] = [];
    expect(() => launchGhostty(linux, target({ host: "-x" }), (command) => calls.push(command))).toThrow(GhosttyRefusal);
    expect(() => launchGhostty(linux, target({ attach: { kind: "terminal", terminalID: "" } }), (command) => calls.push(command))).toThrow(GhosttyRefusal);
    expect(calls).toEqual([]);
  });
});

describe("the page's asks", () => {
  const address = { host: "build-box.local", port: 2222, username: "robin", herdrSession: "default" };
  const panes = new Map<string, GhosttyPaneFound>([
    ["ssh/w1:p1", { pane: { hostKind: "ssh", paneID: "w1:p1", terminalID: "t-1" }, address }],
    ["demo/w7:p1G", { pane: { hostKind: "demo", paneID: "w7:p1G", terminalID: "t-9" }, address: null }],
    ["ssh/hc:w1:p2", { pane: { hostKind: "ssh", paneID: "hc:w1:p2", terminalID: "t-2" }, address }],
    ["ssh/w1:p3", { pane: { hostKind: "ssh", paneID: "w1:p3", terminalID: "t\u0007" }, address }],
  ]);
  function actions(install: GhosttyInstall | null) {
    const calls: [string, string[]][] = [];
    const subject = new GhosttyActions(
      () => install,
      (hostId, paneId) => panes.get(`${hostId}/${paneId}`) ?? null,
      (command, args) => calls.push([command, args]),
    );
    return { subject, calls };
  }

  it("answers per pane and is hidden everywhere without Ghostty", () => {
    const { subject } = actions(mac);
    expect(subject.availability("ssh", "w1:p1")).toEqual({ shown: true, enabled: true });
    expect(subject.availability("demo", "w7:p1G")).toEqual({ shown: true, enabled: false, reason: ghosttyReasons.demo });
    expect(subject.availability("ssh", "hc:w1:p2")).toEqual({ shown: true, enabled: false, reason: ghosttyReasons.core });
    expect(subject.availability("ssh", "gone")).toEqual({ shown: true, enabled: false, reason: ghosttyReasons.gone });
    expect(actions(null).subject.availability("ssh", "w1:p1")).toEqual({ shown: false });
  });

  it("opens an SSH pane once, with the saved port, user and host", () => {
    const { subject, calls } = actions(linux);
    expect(subject.open("ssh", "w1:p1")).toBeNull();
    expect(calls).toHaveLength(1);
    const [command, args] = calls[0]!;
    expect(command).toBe("/usr/bin/ghostty");
    expect(args.slice(0, 9)).toEqual(["-e", "ssh", "-t", "-p", "2222", "-l", "robin", "--", "build-box.local"]);
    expect(args[9]).toBe(attachCommand({ kind: "terminal", terminalID: "t-1" }, "default"));
  });

  it("runs nothing for a demo, herdr-core, unknown or refused pane, or without Ghostty, and says why", () => {
    const { subject, calls } = actions(mac);
    expect(subject.open("demo", "w7:p1G")).toBe(ghosttyReasons.demo);
    expect(subject.open("ssh", "hc:w1:p2")).toBe(ghosttyReasons.core);
    expect(subject.open("ssh", "gone")).toBe(ghosttyReasons.gone);
    expect(subject.open("ssh", "w1:p3")).toMatch(/cannot be passed safely/);
    expect(calls).toEqual([]);
    const none = actions(null);
    expect(none.subject.open("ssh", "w1:p1")).toBe(ghosttyReasons.notInstalled);
    expect(none.calls).toEqual([]);
  });

  it("reports a spawner that throws instead of throwing", () => {
    const subject = new GhosttyActions(
      () => mac,
      (hostId, paneId) => panes.get(`${hostId}/${paneId}`) ?? null,
      () => {
        throw new Error("spawn EACCES");
      },
    );
    expect(subject.open("ssh", "w1:p1")).toBe("Ghostty did not start: spawn EACCES");
  });
});

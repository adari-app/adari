// The This Mac entry in the machines list. Built in, first in
// the list, no address, no password, no host key, no trust step. It shows its
// Herdr when the herdr command resolves in the login shell or Herdr's socket
// is where Herdr puts it (~/.config/herdr/herdr.sock, XDG_CONFIG_HOME first);
// otherwise it reads "Herdr is not running on this Mac" with a short hint,
// as a note and not an error. Nothing about it is ever written to hosts.json,
// host-secrets.json or known_hosts.json. Against the fake This Mac in the
// scratch folder (test/support/this-mac-fake.ts); never this Mac's own.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { thisMacCaptureSteps } from "../src/main/capture";
import { ghosttyAvailability, ghosttyLocalCommand, localArgv, localHerdr, type GhosttyInstall } from "../src/main/ghostty";
import { herdrPresenceCommand, parseHerdrPresence } from "../src/main/herdr/commands";
import { FilePinStore, PinningHostKeyPolicy } from "../src/main/herdr/host-key-pinning";
import { HostStore, SavedHosts } from "../src/main/host-store";
import { HostRegistry } from "../src/main/hosts";
import { SecretStore } from "../src/main/secret-store";
import {
  addThisMac,
  isBuiltInHost,
  thisMacAvailable,
  thisMacDescriptor,
  thisMacId,
  thisMacText,
  ThisMacBackend,
} from "../src/main/this-mac";
import { Sidebar, type SidebarProps } from "../src/renderer/components/Sidebar";
import { buildDesktopSidebar, type SidebarHost } from "../src/shared/desktop-sidebar";
import { fakeCipher } from "./support/fake-cipher";
import { closeFakeMacs, makeFakeMac, scratch } from "./support/this-mac-fake";

const registries: HostRegistry[] = [];

function registryWith(options: ReturnType<ReturnType<typeof makeFakeMac>["options"]>): { registry: HostRegistry; backend: ThisMacBackend } {
  const registry = new HostRegistry(() => undefined);
  registries.push(registry);
  const backend = addThisMac(registry, options);
  return { registry, backend };
}

afterEach(async () => {
  for (const registry of registries.splice(0)) registry.close();
  await closeFakeMacs();
});

describe.skipIf(process.platform !== "darwin")("the This Mac entry", () => {
  it("shows when the fake herdr resolves in the shell and Herdr's socket is there", async () => {
    const fake = makeFakeMac();
    await fake.serve();
    const { registry } = registryWith(fake.options());
    await registry.refreshAll();
    const [entry] = registry.list();
    expect(entry).toMatchObject({ id: thisMacId, name: "This Mac", kind: "local", state: "connected", error: null });
    expect(entry?.topology?.workspaces.length).toBeGreaterThan(0);
    expect(entry).not.toHaveProperty("notRunning");
    expect(entry).not.toHaveProperty("hostKey");
    expect(entry).not.toHaveProperty("authRefused", true);
  });

  it('reads "Herdr is not running on this Mac" with a hint when herdr does not resolve and there is no socket; nothing errors', async () => {
    const fake = makeFakeMac({ herdr: false });
    const { registry, backend } = registryWith(fake.options());
    await registry.refreshAll();
    const [entry] = registry.list();
    expect(entry).toMatchObject({ id: thisMacId, name: "This Mac", kind: "local", state: "offline", error: null, topology: null });
    expect(entry?.notRunning).toEqual({ text: "Herdr is not running on this Mac", hint: thisMacText.installHint });
    expect(thisMacText.installHint.length).toBeLessThan(90);
    // No request was sent anywhere: the presence check is the only command.
    await expect(backend.snapshot()).rejects.toMatchObject({ message: "Herdr is not running on this Mac", hint: thisMacText.installHint });
  });

  it("herdr resolves but Herdr is not running: the same words with the start hint; once its socket is there, the next refresh connects", async () => {
    const fake = makeFakeMac();
    const { registry } = registryWith(fake.options());
    await registry.refreshAll();
    expect(registry.list()[0]).toMatchObject({ state: "offline", error: null, notRunning: { text: "Herdr is not running on this Mac", hint: thisMacText.startHint } });

    await fake.serve();
    await registry.refreshAll();
    expect(registry.list()[0]).toMatchObject({ state: "connected", error: null });
    expect(registry.list()[0]).not.toHaveProperty("notRunning");

    // Herdr quits: its socket goes, and the entry reads not running again (not an error).
    await fake.close();
    await registry.refreshAll();
    expect(registry.list()[0]).toMatchObject({ state: "offline", error: null, notRunning: { text: "Herdr is not running on this Mac" } });
  });

  it("a socket where Herdr puts it is enough, with herdr not on PATH", async () => {
    const fake = makeFakeMac({ herdr: false });
    await fake.serve();
    const { registry } = registryWith(fake.options());
    await registry.refreshAll();
    expect(registry.list()[0]).toMatchObject({ state: "connected", error: null });
  });

  it("XDG_CONFIG_HOME moves the socket as Herdr moves it", async () => {
    const fake = makeFakeMac({ herdr: false });
    const config = path.join(fake.root, "xdg");
    mkdirSync(config);
    const presence = async (env: Record<string, string>): Promise<string> =>
      new ThisMacBackend(fake.options(env)).changesRunner().runReadOnlyCommand(herdrPresenceCommand("default"), 4_096);
    expect(parseHerdrPresence(await presence({ XDG_CONFIG_HOME: config }))).toEqual({ herdr: false, socket: false });
    await fake.serve();
    expect(parseHerdrPresence(await presence({}))).toEqual({ herdr: false, socket: true });
    expect(parseHerdrPresence(await presence({ XDG_CONFIG_HOME: config }))).toEqual({ herdr: false, socket: false });
  });

  it("is never written to hosts.json, host-secrets.json or known_hosts.json", async () => {
    const userData = mkdtempSync(path.join(scratch, "tm-ud-"));
    const files = { hosts: path.join(userData, "hosts.json"), secrets: path.join(userData, "host-secrets.json"), pins: path.join(userData, "known_hosts.json") };
    const book = new SavedHosts(new HostStore(files.hosts), new SecretStore(files.secrets, fakeCipher()));
    // A saved SSH machine with its password, as the app keeps one.
    book.add({ name: "Studio Mac", host: "studio.local", port: 22, username: "me", auth: "password", keyPath: "", herdrSession: "", secret: "pw-1" });
    const policy = new PinningHostKeyPolicy(new FilePinStore(files.pins));
    const before = { hosts: readFileSync(files.hosts), secrets: readFileSync(files.secrets) };

    const fake = makeFakeMac();
    await fake.serve();
    const { registry, backend } = registryWith(fake.options());
    await registry.refreshAll();
    expect(registry.list()[0]).toMatchObject({ id: thisMacId, state: "connected" });
    await backend.uploads().upload(Buffer.from("text\n"), "txt");
    await backend.transcripts().home();
    await registry.retry(thisMacId);

    // Built in: no settings to edit, nothing to remove from the saved machines.
    expect(isBuiltInHost(thisMacId)).toBe(true);
    expect(isBuiltInHost(book.list()[0]!.id)).toBe(false);
    expect(book.settings(thisMacId)).toBeNull();
    expect(book.remove(thisMacId)).toBe(false);
    expect(policy.pinnedFingerprint("this Mac", 0)).toBeUndefined();

    expect(readFileSync(files.hosts).equals(before.hosts)).toBe(true);
    expect(readFileSync(files.secrets).equals(before.secrets)).toBe(true);
    expect(existsSync(files.pins)).toBe(false);
    expect(readFileSync(files.hosts, "utf8")).not.toContain(thisMacId);
    expect(readdirSync(userData).sort()).toEqual(["host-secrets.json", "hosts.json"]);
  });
});

describe("This Mac's place, look and actions", () => {
  it("is listed on macOS only, built in, with no address, and sits first", () => {
    expect(thisMacAvailable("darwin")).toBe(true);
    expect(thisMacAvailable("linux")).toBe(false);
    expect(thisMacAvailable("win32")).toBe(false);
    expect(thisMacDescriptor()).toEqual({ id: "this-mac", name: "This Mac", kind: "local", address: "local", platform: "macOS" });

    const registry = new HostRegistry(() => undefined);
    registries.push(registry);
    const idle = { kind: "demo" as const, snapshot: () => new Promise<never>(() => undefined), sendInput: async () => undefined, prompt: async () => undefined, sendText: async () => undefined, agentKeys: async () => undefined, transcripts: () => null, openTerminal: () => Promise.reject(new Error("none")), close: () => undefined };
    registry.add({ id: "a", name: "A", kind: "ssh", address: "a", platform: null }, idle);
    registry.add(thisMacDescriptor(), idle);
    registry.add({ id: "b", name: "B", kind: "ssh", address: "b", platform: null }, idle);
    expect(registry.list().map((host) => host.id)).toEqual(["this-mac", "a", "b"]);
  });

  it("the sidebar draws the words and the hint as a note under This Mac, not an error, with Not running", () => {
    const host: SidebarHost = {
      id: thisMacId,
      name: "This Mac",
      platform: "macOS",
      state: "offline",
      error: null,
      topology: null,
      notRunning: { text: thisMacText.notRunning, hint: thisMacText.installHint },
    };
    const none = (): void => undefined;
    const props: SidebarProps = {
      sidebar: buildDesktopSidebar([host], { nowUnixMs: Date.now() }),
      selectedKey: null,
      search: null,
      demo: false,
      foldedHosts: new Set(),
      onSelect: none,
      onRowMenu: none,
      onToggleHost: none,
      onHostMenu: none,
      onRetryHost: none,
      onMode: none,
      onToggleWorkspace: none,
      onToggleExpanded: none,
      onToggleSection: none,
      onSearch: none,
      onAddHost: none,
      onNewAgent: none,
      onWorkspaceMenu: none,
    };
    const html = renderToStaticMarkup(createElement(Sidebar, props));
    expect(html).toContain('<div class="host-note"><span class="nt">Herdr is not running on this Mac</span>');
    expect(html).toContain(`<span class="hint">${thisMacText.installHint.replaceAll("'", "&#x27;")}</span>`);
    expect(html).toContain('<span class="hs">Not running</span>');
    expect(html).not.toContain("host-err");
    expect(html).not.toContain("Offline");
    expect(html).not.toContain("Try again");

    const priority = renderToStaticMarkup(createElement(Sidebar, { ...props, sidebar: { ...props.sidebar, mode: "priority" } }));
    expect(priority).toContain('<span class="hs">Not running</span>');
    // Priority shows the same words and hint as Projects, as a note, not an error.
    expect(priority).toContain('<div class="host-note"><span class="nt">Herdr is not running on this Mac</span>');
    expect(priority).toContain(`<span class="hint">${thisMacText.installHint.replaceAll("'", "&#x27;")}</span>`);
    expect(priority).not.toContain("host-err");
    expect(priority).not.toContain("Offline");
    expect(priority).not.toContain("Try again");
    // And the start hint, in both modes.
    const starting: SidebarHost = { ...host, notRunning: { text: thisMacText.notRunning, hint: thisMacText.startHint } };
    for (const mode of ["projects", "priority"] as const) {
      const sidebar = { ...buildDesktopSidebar([starting], { nowUnixMs: Date.now() }), mode };
      const html = renderToStaticMarkup(createElement(Sidebar, { ...props, sidebar }));
      expect(html).toContain('<span class="nt">Herdr is not running on this Mac</span>');
      expect(html).toContain(`<span class="hint">${thisMacText.startHint.replaceAll("'", "&#x27;")}</span>`);
    }
  });

  it("Open in Ghostty on This Mac runs its Herdr with the login environment's PATH, HOME and XDG_CONFIG_HOME as argv: no ssh, no shell", () => {
    const mac: GhosttyInstall = { platform: "darwin", appPath: "/Applications/Ghostty.app" };
    const pane = { hostKind: "local" as const, paneID: "w1:p1", terminalID: "term-w1:p1", agent: "claude" };
    const env = { PATH: "/Users/me/fish-bin:/usr/bin:/bin", HOME: "/Users/me", XDG_CONFIG_HOME: "/Users/me/cfg", OTHER: "not passed" };
    const local = { herdr: "/Users/me/fish-bin/herdr", env, herdrSession: "default" };
    const terminal = { kind: "terminal" as const, terminalID: "term-w1:p1" };
    expect(ghosttyAvailability(mac, pane, null, local)).toEqual({ shown: true, enabled: true });
    const { command, args } = ghosttyLocalCommand(mac, { ...local, attach: terminal });
    expect(command).toBe("/usr/bin/open");
    expect(args).toEqual([
      "-na",
      "/Applications/Ghostty.app",
      "--args",
      "-e",
      "/usr/bin/env",
      "-u",
      "HERDR_SOCKET_PATH",
      "PATH=/Users/me/fish-bin:/usr/bin:/bin",
      "HOME=/Users/me",
      "XDG_CONFIG_HOME=/Users/me/cfg",
      "/Users/me/fish-bin/herdr",
      "--session",
      "default",
      "terminal",
      "attach",
      "term-w1:p1",
    ]);
    // An agent pane, and no XDG_CONFIG_HOME in the login environment: Ghostty's own is cleared, so Herdr looks where the app does.
    expect(localArgv({ herdr: "/opt/homebrew/bin/herdr", env: { PATH: "/opt/homebrew/bin:/usr/bin", HOME: "/Users/me" }, herdrSession: "default", attach: { kind: "agent", paneID: "w1:p1" } })).toEqual([
      "/usr/bin/env",
      "-u",
      "HERDR_SOCKET_PATH",
      "-u",
      "XDG_CONFIG_HOME",
      "PATH=/opt/homebrew/bin:/usr/bin",
      "HOME=/Users/me",
      "/opt/homebrew/bin/herdr",
      "--session",
      "default",
      "agent",
      "attach",
      "w1:p1",
    ]);
    // A login value goes as one argv value, as it is: never shell text.
    const odd = "/Users/me/a b;$(touch x)`id`'q\"\nz";
    expect(localArgv({ ...local, env: { ...env, HOME: odd }, attach: terminal })).toContain(`HOME=${odd}`);
    // Refused before anything runs: an unsafe id, a session Herdr would not take, no herdr found, a herdr path env would read as a setting.
    const refused = [
      ghosttyAvailability(mac, { ...pane, terminalID: "term\u0007" }, null, local),
      ghosttyAvailability(mac, pane, null, { ...local, herdrSession: "bad name" }),
      ghosttyAvailability(mac, pane, null, { ...local, herdr: null }),
      ghosttyAvailability(mac, pane, null, { ...local, herdr: "/Users/me/a=b/herdr" }),
    ];
    for (const availability of refused) expect(availability).toMatchObject({ shown: true, enabled: false });
    expect(refused[2]).toEqual({ shown: true, enabled: false, reason: "Herdr is not on This Mac's login PATH, so this pane cannot open in Ghostty." });
  });

  it("This Mac's herdr for Ghostty: the first on the login PATH (absolute entries, in order), else the attach line's fallbacks, else none", () => {
    const probe = (present: readonly string[]) => ({ isExecutable: (file: string) => present.includes(file) });
    const env = { PATH: "bin::/a:/b/:/c=d", HOME: "/Users/me" };
    expect(localHerdr(env, probe(["/a/herdr", "/b/herdr", "/opt/homebrew/bin/herdr"]))).toBe("/a/herdr");
    expect(localHerdr(env, probe(["/b/herdr", "/opt/homebrew/bin/herdr"]))).toBe("/b/herdr");
    // Relative entries and a path env would read as a setting are skipped; then Homebrew's two, then ~/.local/bin.
    expect(localHerdr(env, probe(["bin/herdr", "/c=d/herdr", "/usr/local/bin/herdr", "/Users/me/.local/bin/herdr"]))).toBe("/usr/local/bin/herdr");
    expect(localHerdr(env, probe(["/Users/me/.local/bin/herdr"]))).toBe("/Users/me/.local/bin/herdr");
    expect(localHerdr({ PATH: "/a" }, probe(["/.local/bin/herdr"]))).toBeNull();
    expect(localHerdr({}, probe([]))).toBeNull();
  });

  it("the captures: 99 shows This Mac found, 100 reads not running, then This Mac is taken out again, all through main's hook", async () => {
    const placed: string[] = [];
    const steps = thisMacCaptureSteps(async (state) => {
      placed.push(state);
    });
    expect(steps.map((step) => step.name)).toEqual(["99-this-mac", "100-this-mac-not-running"]);
    expect(steps.every((step) => step.measure?.includes('data-host="this-mac"') === true)).toBe(true);
    for (const step of steps) {
      await step.before?.();
      await step.afterCapture?.();
    }
    expect(placed).toEqual(["found", "missing", "gone"]);
    // 83's selection is left for 86, which follows.
    expect(steps.flatMap((step) => step.commands).some((command) => command.type === "clear-selection")).toBe(false);
    // In main, before 86-87 (so the host-key captures 97-98 stay last), after the Grok card's 80-83.
    const main = readFileSync(path.join(__dirname, "../src/main/main.ts"), "utf8");
    const at = (call: string): number => main.indexOf(`...${call}(`);
    expect(at("thisMacCaptureSteps")).toBeGreaterThan(at("grokCardCaptureSteps"));
    expect(at("thisMacCaptureSteps")).toBeLessThan(at("sidebarFoldedCaptureSteps"));
  });
});

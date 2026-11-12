// The Mac app updates itself the T3 Code way
// (src/main/updates.ts). On only in a signed, packaged Mac build: unsigned
// packages, development runs, the demo and the captures never load
// electron-updater. The first check 15 s after opening, then every 4 minutes,
// while "Check for updates automatically" is on; a failed automatic check is
// a log line only, Check for Updates… says what happened; nothing downloads or
// installs without the user's click, and Restart asks first. The feed is the github
// provider for adari-app/adari, the same in electron-builder's publish config.
// A launch with a demo, capture or probe flag never checks, also in
// a signed package; the app checks its own signature before it loads
// electron-updater; a signed release ignores the feed override; one native
// install attempt at a time. Every updater here is a fake: no network.

import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loaded = vi.hoisted(() => ({ imports: 0, updater: null as unknown }));
vi.mock("electron-updater", () => {
  loaded.imports += 1;
  return { autoUpdater: loaded.updater };
});
const registered = vi.hoisted(() => ({ handles: new Map<string, (...args: unknown[]) => unknown>() }));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, listener: (...args: unknown[]) => unknown) => registered.handles.set(channel, listener),
    on: () => undefined,
  },
}));

import { parseLaunchOptions } from "../src/main/launch-options";
import {
  anonymousStagingId,
  checkIntervalMs,
  configureUpdater,
  fileUpdatePrefs,
  firstCheckDelayMs,
  installWaitMs,
  memoryUpdatePrefs,
  UPDATE_GITHUB_FEED,
  UpdateController,
  updateSettings,
  type UpdateBuild,
  type Updater,
  type UpdaterLogger,
  type UpdateSettings,
} from "../src/main/updates";
import { IPC } from "../src/shared/ipc-contract";
import { describeManualCheck, installQuestion, updatePill, type UpdateView } from "../src/shared/updates";

const require = createRequire(import.meta.url);
const root = path.join(__dirname, "..");
const read = (file: string): string => readFileSync(path.join(root, file), "utf8");

const signed: UpdateBuild = { platform: "darwin", packaged: true, signed: true, demo: false };
const on = updateSettings({}, signed);

/** An electron-updater stand-in: counts every call; answers as the test sets. */
class FakeUpdater implements Updater {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  allowPrerelease = true;
  allowDowngrade = true;
  fullChangelog = true;
  logger: UpdaterLogger | null = null;
  stagingUserIdPromise: unknown = "per-install";
  readonly feeds: unknown[] = [];
  checks = 0;
  downloads = 0;
  installs = 0;
  answer: () => Promise<{ isUpdateAvailable?: boolean; updateInfo: { version: string } } | null> = () =>
    Promise.resolve({ isUpdateAvailable: false, updateInfo: { version: "0.1.0" } });
  downloadAnswer: () => Promise<unknown> = () => Promise.resolve([]);
  private readonly listeners = new Map<string, ((value: never) => void)[]>();

  setFeedURL(options: { readonly provider: string }): void {
    this.feeds.push(options);
  }
  checkForUpdates() {
    this.checks += 1;
    return this.answer();
  }
  downloadUpdate(): Promise<unknown> {
    this.downloads += 1;
    return this.downloadAnswer();
  }
  quitAndInstall(): void {
    this.installs += 1;
  }
  on(event: string, listener: (value: never) => void): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }
  emit(event: string, value: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(value as never);
  }
}

interface Harness {
  readonly controller: UpdateController;
  readonly updater: FakeUpdater;
  readonly logs: string[];
  readonly asked: ReturnType<typeof installQuestion>[];
  /** What Restart's question answers next (true: Restart). */
  answers: boolean[];
  loads: number;
  readonly views: UpdateView[];
  /** What the signature check answers (null: the Developer ID one), and how often it ran. */
  signature: string | null;
  verifications: number;
}

function harness(settings: UpdateSettings = on, automatic = true): Harness {
  const updater = new FakeUpdater();
  const h: Harness = {
    updater,
    logs: [],
    asked: [],
    answers: [],
    loads: 0,
    views: [],
    signature: null,
    verifications: 0,
    controller: null as unknown as UpdateController,
  };
  (h as { controller: UpdateController }).controller = new UpdateController({
    settings,
    version: "0.1.0",
    prefs: memoryUpdatePrefs(automatic),
    confirmInstall: (question) => {
      h.asked.push(question);
      return Promise.resolve(h.answers.shift() ?? false);
    },
    verifySignature: () => {
      h.verifications += 1;
      return Promise.resolve(h.signature);
    },
    load: () => {
      h.loads += 1;
      return Promise.resolve(updater);
    },
    log: (line) => h.logs.push(line),
    now: () => Date.UTC(2026, 10, 9, 12, 0, 0),
  });
  h.controller.subscribe((view) => h.views.push(view));
  return h;
}

const verified = (): Promise<string | null> => Promise.resolve(null);

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

const notFound = (): Error =>
  Object.assign(
    new Error(
      "Unable to find latest version on GitHub (https://github.com/adari-app/adari/releases/latest), please ensure a production release exists: HttpError: 404 \n\"method: GET url: https://github.com/adari-app/adari/releases.atom\"",
    ),
    { code: "ERR_UPDATER_LATEST_VERSION_NOT_FOUND" },
  );

afterEach(() => {
  vi.useRealTimers();
});

describe("where updates run", () => {
  it("off in an unsigned package, a development run, the demo, a capture run and off the Mac; on in a signed packaged Mac build", () => {
    expect(updateSettings({}, { ...signed, signed: false })).toMatchObject({ enabled: false, off: "unsigned" });
    expect(updateSettings({}, { ...signed, packaged: false })).toMatchObject({ enabled: false, off: "development" });
    expect(updateSettings({}, { ...signed, demo: true })).toMatchObject({ enabled: false, off: "demo" });
    // `--capture` is a demo run (launch-options.ts), so its settings are the demo's.
    const capture = parseLaunchOptions(["--capture=/Users/demo/captures"], { packaged: false });
    expect(capture.demo).toBe(true);
    expect(updateSettings({}, { ...signed, packaged: false, demo: capture.demo })).toMatchObject({ enabled: false, off: "demo" });
    expect(updateSettings({}, { ...signed, platform: "linux" })).toMatchObject({ enabled: false, off: "platform" });
    // A signed package opened with a demo, capture or probe flag (which it otherwise ignores).
    expect(updateSettings({}, { ...signed, flags: true })).toMatchObject({ enabled: false, off: "flags" });
    expect(updateSettings({}, { ...signed, flags: false })).toMatchObject({ enabled: true, off: null });
    expect(on).toEqual({ enabled: true, off: null, feed: UPDATE_GITHUB_FEED, feedName: "GitHub", feedUrl: "https://github.com/adari-app/adari/releases" });
  });

  it("HERDR_COMPANION_UPDATE_FEED is for tests and development: a signed release ignores it (GitHub, stable only); elsewhere an https URL names a generic feed, and never turns updates on", () => {
    // The production feed is only GitHub, so allowPrerelease's stable-only rule holds.
    expect(updateSettings({ HERDR_COMPANION_UPDATE_FEED: "https://feed.test:8443/adari/" }, signed)).toEqual(on);
    const development = updateSettings({ HERDR_COMPANION_UPDATE_FEED: "https://feed.test:8443/adari/" }, { ...signed, packaged: false, signed: false });
    expect(development).toMatchObject({ enabled: false, off: "development", feed: { provider: "generic", url: "https://feed.test:8443/adari/" }, feedName: "feed.test:8443" });
    expect(updateSettings({ HERDR_COMPANION_UPDATE_FEED: "https://feed.test/adari" }, { ...signed, signed: false }).enabled).toBe(false);
    expect(updateSettings({ HERDR_COMPANION_UPDATE_FEED: "http://feed.test/adari" }, { ...signed, signed: false }).feed).toEqual(UPDATE_GITHUB_FEED);
    expect(updateSettings({ HERDR_COMPANION_UPDATE_FEED: "file:///tmp/feed" }, { ...signed, signed: false }).feed).toEqual(UPDATE_GITHUB_FEED);
  });

  it("main.ts decides from the baked Developer ID team, app.isPackaged, the demo flag and the raw launch flags, and checks its own signature; build.mjs bakes the team only for a checked identity", () => {
    const main = read("src/main/main.ts");
    expect(main).toContain("const updateTeam: string = __ADARI_UPDATE_TEAM__;");
    expect(main).toContain('const signedBuild = updateTeam !== "";');
    expect(main).toContain(
      "updateSettings(process.env, { platform: process.platform, packaged: app.isPackaged, signed: signedBuild, demo: options.demo, flags: hasInstrumentFlag(process.argv) })",
    );
    expect(main).toContain("verifySignature: () => checkOwnSignature(appBundleOf(process.execPath), updateTeam),");
    const build = read("scripts/build.mjs");
    expect(build).toContain("signing = signedReleaseIdentity();");
    expect(build).toContain('common.define.__ADARI_UPDATE_TEAM__ = JSON.stringify(signing === null ? "" : signing.team);');
    // Asked before anything is built (the team is baked into the first bundle).
    expect(build.indexOf("signing = signedReleaseIdentity();")).toBeLessThan(build.indexOf("await esbuild("));
    expect(build).not.toContain("__ADARI_UPDATES__");
  });

  it("nothing in the app imports electron-updater but the one lazy load, run on the first check of a build that updates", () => {
    const sources = ["src/main/main.ts", "src/main/updates.ts", "src/main/ipc.ts", "src/main/menu.ts", "src/main/dev-modes.ts", "src/main/update-captures.ts", "src/main/demo/demo-updater.ts"];
    for (const file of sources) {
      const text = read(file);
      expect(text, file).not.toMatch(/^import (?!type )[^;]*from "electron-updater";$/mu);
      expect(text, file).not.toMatch(/require\("electron-updater"\)/u);
    }
    expect(read("src/main/updates.ts").match(/import\("electron-updater"\)/gu)).toHaveLength(1);
  });
});

describe("the feed: GitHub Releases of adari-app/adari, stable only", () => {
  it("electron-builder's publish config is the runtime feed, and no script publishes", () => {
    const config = require("../electron-builder.config.cjs") as { publish: unknown[] };
    expect(config.publish).toEqual([{ ...UPDATE_GITHUB_FEED }]);
    expect(UPDATE_GITHUB_FEED).toEqual({ provider: "github", owner: "adari-app", repo: "adari", releaseType: "release" });
    const scripts = (JSON.parse(read("package.json")) as { scripts: Record<string, string> }).scripts;
    for (const [name, command] of Object.entries(scripts)) {
      if (command.includes("electron-builder")) expect(command, name).toContain("--publish never");
    }
  });

  it("the updater is set up as the app runs it: no auto download or install, no prereleases or downgrades, the same feed, the all-zero staging id", async () => {
    const fake = new FakeUpdater();
    const lines: string[] = [];
    configureUpdater(fake, on.feed, (line) => lines.push(line));
    expect([fake.autoDownload, fake.autoInstallOnAppQuit, fake.allowPrerelease, fake.allowDowngrade, fake.fullChangelog]).toEqual([false, false, false, false, false]);
    expect(fake.feeds).toEqual([{ ...UPDATE_GITHUB_FEED }]);
    expect(await (fake.stagingUserIdPromise as { value: Promise<string> }).value).toBe(anonymousStagingId);
    fake.logger!.info("Checking for update");
    expect(lines).toEqual(["updater: Checking for update"]);
  });
});

describe("off builds never load electron-updater", () => {
  it("unsigned, development, demo, capture and a signed package opened with a demo or capture flag: no timer check, no manual check, no download, no install, no import, no signature check", async () => {
    vi.useFakeTimers();
    let verifications = 0;
    for (const build of [{ ...signed, signed: false }, { ...signed, packaged: false }, { ...signed, demo: true }, { ...signed, flags: true }]) {
      const asked: unknown[] = [];
      const controller = new UpdateController({
        settings: updateSettings({}, build),
        version: "0.1.0",
        prefs: memoryUpdatePrefs(),
        confirmInstall: (question) => (asked.push(question), Promise.resolve(true)),
        verifySignature: () => ((verifications += 1), Promise.resolve(null)),
      });
      controller.start();
      await vi.advanceTimersByTimeAsync(firstCheckDelayMs + 3 * checkIntervalMs);
      expect(await controller.check("manual")).toEqual({ kind: "off" });
      expect(describeManualCheck({ kind: "off" })).toBe("Updates come with the signed download.");
      expect(await controller.download()).toBe(false);
      expect(await controller.requestInstall()).toBe("not-ready");
      expect(controller.view().status).toBe("off");
      expect(updatePill(controller.view())).toBeNull();
      expect(asked).toEqual([]);
      controller.stop();
    }
    expect(loaded.imports).toBe(0);
    expect(verifications).toBe(0);
  });

  it("a signed packaged build loads it on its first check, 15 s after opening, and sets it up", async () => {
    const fake = new FakeUpdater();
    loaded.updater = fake;
    vi.useFakeTimers();
    const controller = new UpdateController({ settings: on, version: "0.1.0", prefs: memoryUpdatePrefs(), confirmInstall: () => Promise.resolve(false), verifySignature: verified });
    controller.start();
    await vi.advanceTimersByTimeAsync(firstCheckDelayMs - 1);
    expect(loaded.imports).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(loaded.imports).toBe(1);
    expect(fake.checks).toBe(1);
    expect(fake.feeds).toEqual([{ ...UPDATE_GITHUB_FEED }]);
    expect([fake.autoDownload, fake.autoInstallOnAppQuit]).toEqual([false, false]);
    expect(controller.view().status).toBe("current");
    controller.stop();
  });
});

describe("when it checks (a fake clock)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("the first check at 15 s, then every 4 minutes", async () => {
    const h = harness();
    h.controller.start();
    await vi.advanceTimersByTimeAsync(14_999);
    expect(h.updater.checks).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.updater.checks).toBe(1);
    await vi.advanceTimersByTimeAsync(checkIntervalMs - firstCheckDelayMs - 1);
    expect(h.updater.checks).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.updater.checks).toBe(2);
    await vi.advanceTimersByTimeAsync(checkIntervalMs);
    expect(h.updater.checks).toBe(3);
    await vi.advanceTimersByTimeAsync(2 * checkIntervalMs);
    expect(h.updater.checks).toBe(5);
    expect([firstCheckDelayMs, checkIntervalMs]).toEqual([15_000, 240_000]);
    h.controller.stop();
    await vi.advanceTimersByTimeAsync(10 * checkIntervalMs);
    expect(h.updater.checks).toBe(5);
  });

  it("with the setting off: no automatic check at all (not even the first); Check for Updates… still works; on again, the next tick checks", async () => {
    const h = harness(on, false);
    h.controller.start();
    await vi.advanceTimersByTimeAsync(firstCheckDelayMs + 5 * checkIntervalMs);
    expect(h.updater.checks).toBe(0);
    expect(h.loads).toBe(0);
    expect(await h.controller.check("manual")).toEqual({ kind: "current", version: "0.1.0" });
    expect(h.updater.checks).toBe(1);
    h.controller.setAutomatic(true);
    expect(h.controller.view().automatic).toBe(true);
    await vi.advanceTimersByTimeAsync(checkIntervalMs);
    expect(h.updater.checks).toBe(2);
    h.controller.setAutomatic(false);
    await vi.advanceTimersByTimeAsync(3 * checkIntervalMs);
    expect(h.updater.checks).toBe(2);
    h.controller.stop();
  });

  it("no automatic check while one runs, while it downloads or while it restarts", async () => {
    const h = harness();
    let release: (() => void) | null = null;
    h.updater.answer = () => new Promise((resolve) => (release = () => resolve({ isUpdateAvailable: true, updateInfo: { version: "0.1.1" } })));
    h.controller.start();
    await vi.advanceTimersByTimeAsync(firstCheckDelayMs + 2 * checkIntervalMs);
    expect(h.updater.checks).toBe(1);
    release!();
    await flush();
    h.updater.answer = () => Promise.resolve({ isUpdateAvailable: true, updateInfo: { version: "0.1.1" } });
    h.updater.downloadAnswer = () => new Promise(() => undefined);
    void h.controller.download();
    await flush();
    await vi.advanceTimersByTimeAsync(2 * checkIntervalMs);
    expect(h.updater.checks).toBe(1);
    h.controller.stop();
  });
});

describe("quiet automatic failures, spoken manual ones", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("the repo not there yet (before publish): the automatic check is a log line; no question, no pill, the state as it was", async () => {
    const h = harness();
    h.updater.answer = () => Promise.reject(notFound());
    h.controller.start();
    await vi.advanceTimersByTimeAsync(firstCheckDelayMs);
    await flush();
    expect(h.logs).toContain("automatic check failed: No release is published on GitHub yet.");
    expect(h.asked).toEqual([]);
    const view = h.controller.view();
    expect(view.status).toBe("idle");
    expect(view.lastCheck).toEqual({ at: Date.UTC(2026, 10, 9, 12, 0, 0), outcome: "failed" });
    expect(updatePill(view)).toBeNull();
    h.controller.stop();
  });

  it("a found version stays when a later automatic check fails (the pill never goes away on a failure)", async () => {
    const h = harness();
    h.updater.answer = () => Promise.resolve({ isUpdateAvailable: true, updateInfo: { version: "0.1.1" } });
    h.controller.start();
    await vi.advanceTimersByTimeAsync(firstCheckDelayMs);
    expect(updatePill(h.controller.view())?.label).toBe("Download");
    h.updater.answer = () => Promise.reject(Object.assign(new Error("net::ERR_INTERNET_DISCONNECTED"), {}));
    await vi.advanceTimersByTimeAsync(checkIntervalMs);
    expect(h.logs.at(-1)).toBe("automatic check failed: Could not reach GitHub.");
    expect(updatePill(h.controller.view())?.label).toBe("Download");
    h.controller.stop();
  });

  it("Check for Updates… says what happened: the latest, a newer version, a failure in words", async () => {
    const h = harness();
    expect(describeManualCheck(await h.controller.check("manual"))).toBe("Adari 0.1.0 is the latest version.");
    h.updater.answer = () => Promise.reject(notFound());
    expect(describeManualCheck(await h.controller.check("manual"))).toBe("Could not check for updates: No release is published on GitHub yet.");
    expect(h.logs.at(-1)).toBe("manual check failed: No release is published on GitHub yet.");
    h.updater.answer = () => Promise.resolve({ isUpdateAvailable: true, updateInfo: { version: "0.1.1" } });
    expect(describeManualCheck(await h.controller.check("manual"))).toBe("Adari 0.1.1 is available.");
    expect(h.updater.downloads).toBe(0);
  });

  it("the menu's Check for Updates… shows a dialog for every outcome; the automatic path has no dialog at all", () => {
    const main = read("src/main/main.ts");
    expect(main).toMatch(/checkForUpdates: \(\) => void checkFromMenu\(updates\)/u);
    expect(main).toMatch(/checkForUpdates: async \(\) => describeManualCheck\(await updates\.check\("manual"\)\)/u);
    const controller = read("src/main/updates.ts");
    // The controller has no window, dialog or notification to show: it imports nothing from Electron.
    expect(controller).not.toMatch(/from "electron"|require\("electron"\)|showMessageBox|new Notification/u);
  });
});

describe("nothing downloads or installs without a click; Restart asks first", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("a newer version found by the timer is only shown: no download, no install, however long it waits", async () => {
    const h = harness();
    h.updater.answer = () => Promise.resolve({ isUpdateAvailable: true, updateInfo: { version: "0.1.1" } });
    h.controller.start();
    await vi.advanceTimersByTimeAsync(firstCheckDelayMs + 20 * checkIntervalMs);
    expect(h.updater.checks).toBe(21);
    expect([h.updater.downloads, h.updater.installs, h.asked.length]).toEqual([0, 0, 0]);
    expect(h.controller.view()).toMatchObject({ status: "available", available: "0.1.1" });
    h.controller.stop();
  });

  it("Download: the progress, then downloaded (counted once for the page's toast), and nothing installs", async () => {
    const h = harness();
    h.updater.answer = () => Promise.resolve({ isUpdateAvailable: true, updateInfo: { version: "0.1.1" } });
    await h.controller.check("manual");
    let finish: (() => void) | null = null;
    h.updater.downloadAnswer = () => new Promise((resolve) => (finish = () => resolve([])));
    const done = h.controller.download();
    expect(h.controller.view()).toMatchObject({ status: "downloading", percent: 0 });
    await flush();
    h.updater.emit("download-progress", { percent: 42.7 });
    expect(updatePill(h.controller.view())).toMatchObject({ icon: "progress", label: "42%", percent: 42, action: "none" });
    finish!();
    expect(await done).toBe(true);
    expect(h.controller.view()).toMatchObject({ status: "downloaded", downloaded: "0.1.1", downloads: 1 });
    expect(updatePill(h.controller.view())).toMatchObject({ icon: "restart", label: "Restart", action: "install" });
    // A later check finding the same version keeps the download (no second download, no second toast).
    await h.controller.check("manual");
    expect(h.controller.view()).toMatchObject({ status: "downloaded", downloads: 1 });
    expect([h.updater.downloads, h.updater.installs]).toEqual([1, 0]);
  });

  it("Restart asks first; Cancel keeps the download for later; Restart then quits into it", async () => {
    const h = harness();
    h.updater.answer = () => Promise.resolve({ isUpdateAvailable: true, updateInfo: { version: "0.1.1" } });
    await h.controller.check("manual");
    await h.controller.download();
    h.answers = [false];
    expect(await h.controller.requestInstall()).toBe("cancelled");
    expect(h.asked).toEqual([
      {
        message: "Install update 0.1.1 and restart Adari?",
        detail: "Your agents keep running in Herdr on each machine. Adari connects to them again when it opens.",
        buttons: ["Restart", "Cancel"],
      },
    ]);
    expect(h.updater.installs).toBe(0);
    expect(h.controller.view()).toMatchObject({ status: "downloaded", downloaded: "0.1.1" });
    h.answers = [true];
    expect(await h.controller.requestInstall()).toBe("installing");
    expect(h.asked).toHaveLength(2);
    expect(h.updater.installs).toBe(1);
    expect(updatePill(h.controller.view())).toMatchObject({ label: "Restarting…", action: "none" });
  });

  it("an install refused (the updater's error) goes back to Restart with the reason; one that takes long stays Restarting…, said honestly, with no second attempt", async () => {
    const h = harness();
    h.updater.answer = () => Promise.resolve({ isUpdateAvailable: true, updateInfo: { version: "0.1.1" } });
    await h.controller.check("manual");
    await h.controller.download();
    h.answers = [true, true, true];
    await h.controller.requestInstall();
    h.updater.emit("error", new Error("Code signature at URL file:///… did not pass validation"));
    expect(h.controller.view()).toMatchObject({ status: "downloaded", error: { during: "install" } });
    expect(updatePill(h.controller.view())?.title).toMatch(/^Installing 0\.1\.1 failed: Code signature/u);
    // Tried again (the first attempt ended with that error): a second attempt.
    expect(await h.controller.requestInstall()).toBe("installing");
    expect(h.updater.installs).toBe(2);
    // Still under way after 90 s is not a failure; nothing to click, nothing handed over again.
    await vi.advanceTimersByTimeAsync(installWaitMs);
    expect(h.controller.view()).toMatchObject({ status: "installing", stillPreparing: true, error: null });
    expect(updatePill(h.controller.view())).toMatchObject({ label: "Restarting…", action: "none", title: "Still preparing Adari 0.1.1. Adari restarts when it is ready." });
    expect(await h.controller.requestInstall()).toBe("installing");
    await vi.advanceTimersByTimeAsync(10 * installWaitMs);
    expect(h.controller.view()).toMatchObject({ status: "installing", stillPreparing: true });
    expect(h.updater.installs).toBe(2);
    expect(h.asked).toHaveLength(2);
    expect(h.logs).toContain("still preparing 0.1.1 after 90 s");
    // When that attempt really ends (the updater's error), Restart is offered again.
    h.updater.emit("error", new Error("Squirrel.Mac: the update could not be applied"));
    expect(h.controller.view()).toMatchObject({ status: "downloaded", stillPreparing: false, error: { during: "install", message: "Squirrel.Mac: the update could not be applied" } });
  });

  it("an install the updater refuses during the hand-over itself ends that attempt: Restart is offered again, and asks again", async () => {
    const h = harness();
    h.updater.answer = () => Promise.resolve({ isUpdateAvailable: true, updateInfo: { version: "0.1.1" } });
    await h.controller.check("manual");
    await h.controller.download();
    h.updater.quitAndInstall = () => {
      h.updater.installs += 1;
      h.updater.emit("error", new Error("Squirrel.Mac refused it at once"));
    };
    h.answers = [true, false];
    expect(await h.controller.requestInstall()).toBe("installing");
    expect(h.controller.view()).toMatchObject({ status: "downloaded", error: { during: "install", message: "Squirrel.Mac refused it at once" } });
    expect(await h.controller.requestInstall()).toBe("cancelled");
    expect([h.asked.length, h.updater.installs]).toEqual([2, 1]);
  });

  it("Restart before a download, and Download before a check, do nothing", async () => {
    const h = harness();
    expect(await h.controller.download()).toBe(false);
    expect(await h.controller.requestInstall()).toBe("not-ready");
    h.updater.answer = () => Promise.resolve({ isUpdateAvailable: true, updateInfo: { version: "0.1.1" } });
    await h.controller.check("manual");
    expect(await h.controller.requestInstall()).toBe("not-ready");
    expect([h.updater.downloads, h.updater.installs, h.asked.length]).toEqual([0, 0, 0]);
  });

  it("a Download clicked while a check runs waits for it; a failed download goes back to Download with the reason", async () => {
    const h = harness();
    let release: (() => void) | null = null;
    h.updater.answer = () => new Promise((resolve) => (release = () => resolve({ isUpdateAvailable: true, updateInfo: { version: "0.1.1" } })));
    const checking = h.controller.check("manual");
    h.updater.downloadAnswer = () => Promise.reject(new Error("sha512 checksum mismatch"));
    const download = h.controller.download();
    await flush();
    expect(h.updater.downloads).toBe(0);
    release!();
    await checking;
    expect(await download).toBe(false);
    expect(h.updater.downloads).toBe(1);
    expect(h.controller.view()).toMatchObject({ status: "available", error: { during: "download", message: "sha512 checksum mismatch" } });
    expect(updatePill(h.controller.view())).toMatchObject({ label: "Download", title: "The download failed: sha512 checksum mismatch. Click to try again." });
  });
});

describe("the app's own signature, before electron-updater is ever loaded", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("checked once, when the controller starts; passed, the first check loads and checks as before", async () => {
    const h = harness();
    h.controller.start();
    await flush();
    expect(h.verifications).toBe(1);
    expect(h.loads).toBe(0);
    await vi.advanceTimersByTimeAsync(firstCheckDelayMs + checkIntervalMs);
    expect([h.verifications, h.loads, h.updater.checks]).toEqual([1, 1, 2]);
    expect(h.logs[0]).toBe("signature check passed");
    h.controller.stop();
  });

  it("refused (unsigned, ad-hoc, another team): off for the run, said in Settings; no load, no check, no timers, Check for Updates… says off", async () => {
    const h = harness();
    h.signature = "the app is not signed with a Developer ID of team ABCDE12345 (codesign: code object is not signed at all)";
    h.controller.start();
    await flush();
    expect(h.controller.view()).toMatchObject({ status: "off", off: "unsigned" });
    expect(h.logs).toContain("off: the app is not signed with a Developer ID of team ABCDE12345 (codesign: code object is not signed at all); no update checks in this run");
    await vi.advanceTimersByTimeAsync(firstCheckDelayMs + 5 * checkIntervalMs);
    expect(await h.controller.check("manual")).toEqual({ kind: "off" });
    expect(await h.controller.download()).toBe(false);
    expect(await h.controller.requestInstall()).toBe("not-ready");
    expect([h.verifications, h.loads, h.updater.checks]).toEqual([1, 0, 0]);
  });

  it("a manual check before the timers started waits for the check too; one that throws counts as refused", async () => {
    const h = harness();
    h.signature = "the app is not signed with a Developer ID of team ABCDE12345 (codesign: exit 3)";
    expect(await h.controller.check("manual")).toEqual({ kind: "off" });
    expect([h.verifications, h.loads]).toEqual([1, 0]);
    const thrown = new UpdateController({
      settings: on,
      version: "0.1.0",
      prefs: memoryUpdatePrefs(),
      confirmInstall: () => Promise.resolve(false),
      verifySignature: () => Promise.reject(new Error("spawn /usr/bin/codesign ENOENT")),
      load: () => Promise.reject(new Error("must not load")),
    });
    expect(await thrown.check("manual")).toEqual({ kind: "off" });
    expect(thrown.view()).toMatchObject({ status: "off", off: "unsigned" });
  });
});

describe("the setting, kept", () => {
  it("on by default; off is kept in the app's data folder (owner only) and read back", () => {
    const base = process.env["HERDR_TEST_SCRATCH"] || os.tmpdir();
    const dir = mkdtempSync(path.join(base, "update-prefs-"));
    const file = path.join(dir, "update-settings.json");
    expect(fileUpdatePrefs(file).automatic()).toBe(true);
    fileUpdatePrefs(file).setAutomatic(false);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ automatic: false });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(fileUpdatePrefs(file).automatic()).toBe(false);
    const h = new UpdateController({ settings: on, version: "0.1.0", prefs: fileUpdatePrefs(file), confirmInstall: () => Promise.resolve(false), verifySignature: verified });
    expect(h.view().automatic).toBe(false);
    expect(h.setAutomatic(true).automatic).toBe(true);
    expect(fileUpdatePrefs(file).automatic()).toBe(true);
  });
});

describe("the page's update calls (IPC)", () => {
  it("take no arguments (the setting only its boolean) and reach the controller; Download and Restart act only on what main found", async () => {
    const h = harness();
    const { registerIpc } = await import("../src/main/ipc");
    const { APP_ORIGIN } = await import("../src/main/protocol");
    const event = { senderFrame: { url: APP_ORIGIN }, sender: { id: 1 } };
    registerIpc({ hosts: {}, updates: h.controller } as never);
    // Async, so a refusal thrown at once arrives as the page sees it: a rejected call.
    const call = async (channel: string, ...args: unknown[]): Promise<unknown> => registered.handles.get(channel)!(event, ...args);
    expect(await call(IPC.updateState)).toMatchObject({ status: "idle", current: "0.1.0" });
    await expect(call(IPC.updateState, "x")).rejects.toThrow("bad request");
    await expect(call(IPC.updateDownload, "https://elsewhere.example/evil.zip")).rejects.toThrow("bad request");
    await expect(call(IPC.updateInstall, true)).rejects.toThrow("bad request");
    await expect(call(IPC.updateAutomatic, "no")).rejects.toThrow("bad request");
    expect(await call(IPC.updateDownload)).toBe(false);
    expect(await call(IPC.updateInstall)).toBe("not-ready");
    expect(await call(IPC.updateAutomatic, false)).toMatchObject({ automatic: false });
    expect([h.updater.downloads, h.updater.installs]).toEqual([0, 0]);
  });
});

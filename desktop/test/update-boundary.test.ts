// The updater's boundaries:
// - a package updates only with a real Developer ID signature: an
//   ad-hoc "-" and a pull-request build (electron-builder's own isSignAllowed
//   guard, which returns before forceCodeSigning is read) fail the build, and
//   the app checks its own signature with codesign before it loads anything;
// - a signed package opened with --demo or --capture (which the
//   shipped parser drops) never loads electron-updater or sends a request;
// - About's privacy line is true for the running build;
// - a signed release ignores HERDR_COMPANION_UPDATE_FEED, so its
//   only feed is GitHub, stable releases only;
// - one native install attempt: 90 s on, still "Restarting…", and
//   no second Squirrel hand-over until the first has ended.
//
// No network: every provider request goes to a Unix socket in the test
// scratch folder; Electron's autoUpdater (Squirrel.Mac) is a counting
// EventEmitter; no app, signing, Keychain or installer runs. codesign only
// verifies bundles already on disk.

import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Namespace imports, so a missing export is undefined and fails only the cases that use it.
import * as launch from "../src/main/launch-options";
import * as updates from "../src/main/updates";
import * as settingsText from "../src/shared/settings";
import * as shared from "../src/shared/updates";

const require = createRequire(import.meta.url);
const root = path.join(__dirname, "..");
// The copy of builder-util-runtime electron-updater itself uses.
const runtime = createRequire(require.resolve("electron-updater"))("builder-util-runtime") as {
  HttpExecutor: new () => object;
  configureRequestUrl(url: URL, options: object): void;
  configureRequestOptions(options: object): object;
};
const { AppUpdater } = require("electron-updater/out/AppUpdater") as { AppUpdater: new (options: unknown, app: unknown) => Record<string, unknown> };

const scratch = mkdtempSync(path.join(process.env["HERDR_TEST_SCRATCH"] || os.tmpdir(), "update-boundary-"));
const socket = path.join(scratch, "feed.sock");
const signed = { platform: "darwin" as NodeJS.Platform, packaged: true, signed: true, demo: false };
const stable = updates.updateSettings({}, signed);
const verified = (): Promise<string | null> => Promise.resolve(null);

interface Sent {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
}
const records: Sent[] = [];
const controllers: updates.UpdateController[] = [];
const macs: { closeServerIfExists(): void }[] = [];
let version = "0.1.1";
let mode: "published" | "no-repo" | "no-release" = "published";
let corrupt = false;
const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x05, 0x06]), Buffer.alloc(18)]);
const digest = createHash("sha512").update(zip).digest("base64");
// The feed lists a prerelease first, as GitHub's atom feed would.
const atom = (): string =>
  `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">${
    mode === "no-release" ? "" : ["v0.2.0-beta.1", "v0.1.1"].map((t) => `<entry><link href="https://github.com/adari-app/adari/releases/tag/${t}"/><title>${t}</title><content>No content.</content></entry>`).join("")
  }</feed>`;
const manifest = (): string => `version: ${version}\nfiles:\n  - url: Adari-${version}-arm64.zip\n    sha512: ${digest}\n    size: ${zip.length}\n`;
const server = http.createServer((request, response) => {
  const url = request.url ?? "";
  if (mode === "no-repo") return void (response.writeHead(404), response.end("Not Found"));
  if (url.endsWith(".atom")) return void (response.setHeader("set-cookie", "probe=1"), response.end(atom()));
  if (url.endsWith("/latest")) return void response.end(JSON.stringify({ tag_name: "v0.1.1" }));
  if (url.split("?")[0]!.endsWith("latest-mac.yml")) return void response.end(manifest());
  if (url.endsWith(".zip")) return void response.end(corrupt ? Buffer.from("corrupt archive") : zip);
  response.writeHead(404);
  response.end("unexpected local route");
});

/** builder-util-runtime's executor, every connection (checks and the download) to the fake feed's socket. */
class LocalExecutor extends (runtime.HttpExecutor as unknown as new () => {
  doDownload(options: object, task: object, redirects: number): void;
}) {
  download(url: URL, destination: string, options: { headers?: object; cancellationToken: { createPromise<T>(run: (resolve: (v: T) => void, reject: (e: unknown) => void, onCancel: unknown) => void): Promise<T> } }): Promise<string> {
    return options.cancellationToken.createPromise<string>((resolve, reject, onCancel) => {
      const requestOptions = { headers: options.headers || undefined, redirect: "manual" };
      runtime.configureRequestUrl(url, requestOptions);
      runtime.configureRequestOptions(requestOptions);
      this.doDownload(requestOptions, { destination, options, onCancel, callback: (error: unknown) => (error == null ? resolve(destination) : reject(error)), responseHandler: null }, 0);
    });
  }
  createRequest(options: { method?: string; protocol?: string; hostname?: string; path: string; headers: Record<string, string> }, callback: (response: unknown) => void): unknown {
    records.push({ method: options.method ?? "GET", url: `${options.protocol}//${options.hostname}${options.path}`, headers: { ...options.headers } });
    return http.request({ socketPath: socket, agent: false, method: options.method ?? "GET", path: options.path, headers: { ...options.headers, host: options.hostname } }, callback);
  }
}

function adapter() {
  const home = mkdtempSync(path.join(scratch, "app-"));
  mkdirSync(path.join(home, "data"));
  const config = path.join(home, "app-update.yml");
  writeFileSync(config, "updaterCacheDirName: boundary-updater\n");
  return { version: "0.1.0", name: "Adari", isPackaged: true, appUpdateConfigPath: config, userDataPath: path.join(home, "data"), baseCachePath: path.join(home, "cache"), whenReady: () => Promise.resolve(), relaunch() {}, quit() {}, onQuit() {} };
}

/** electron-updater's AppUpdater as the Mac one checks; its download and install only counted. */
class CheckingUpdater extends AppUpdater {
  downloads = 0;
  installs = 0;
  constructor() {
    super(null, adapter());
    this["httpExecutor"] = new LocalExecutor();
    this["_testOnlyOptions"] = { platform: "darwin" };
  }
  doDownloadUpdate(): Promise<string[]> {
    this.downloads += 1;
    return Promise.resolve([]);
  }
  quitAndInstall(): void {
    this.installs += 1;
  }
}

function controller(updater: unknown, settings: updates.UpdateSettings = stable, automatic = true, confirmInstall: () => Promise<boolean> = () => Promise.resolve(false)) {
  const logs: string[] = [];
  const c = new updates.UpdateController({ settings, version: "0.1.0", prefs: updates.memoryUpdatePrefs(automatic), load: () => Promise.resolve(updater as updates.Updater), log: (line) => logs.push(line), confirmInstall, verifySignature: verified });
  controllers.push(c);
  return { c, logs };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 15; i += 1) await Promise.resolve();
};

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(socket, resolve));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const c of controllers.splice(0)) c.stop();
  version = "0.1.1";
  mode = "published";
  corrupt = false;
  records.length = 0;
});

afterAll(async () => {
  for (const mac of macs) mac.closeServerIfExists();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("the feed: GitHub, stable only, anonymous", () => {
  it("a check passes over the prerelease listed first and sends only the anonymous headers; nothing is downloaded or installed", async () => {
    const u = new CheckingUpdater();
    const { c } = controller(u);
    expect(await c.check("manual")).toEqual({ kind: "available", version: "0.1.1" });
    expect(records.map((r) => r.url)).toEqual([
      "https://github.com/adari-app/adari/releases.atom",
      "https://github.com/adari-app/adari/releases/latest",
      "https://github.com/adari-app/adari/releases/download/v0.1.1/latest-mac.yml",
    ]);
    for (const r of records) {
      expect(r.method).toBe("GET");
      expect(r.headers["x-user-staging-id"]).toBe(updates.anonymousStagingId);
      expect(Object.keys(r.headers).filter((k) => !["accept", "user-agent", "cache-control", "x-user-staging-id"].includes(k.toLowerCase()))).toEqual([]);
    }
    expect(existsSync(path.join((u["app"] as { userDataPath: string }).userDataPath, ".updaterId"))).toBe(false);
    expect([u.downloads, u.installs]).toEqual([0, 0]);
  });

  it("both providers refuse an older manifest, with the flags still off", async () => {
    const generic: updates.UpdateSettings = { ...stable, feed: { provider: "generic", url: "https://feed.invalid/adari/" }, feedName: "feed.invalid", feedUrl: "https://feed.invalid/adari/" };
    for (const settings of [stable, generic]) {
      version = "0.0.9";
      const u = new CheckingUpdater();
      const { c } = controller(u, settings);
      expect(await c.check("manual")).toEqual({ kind: "current", version: "0.1.0" });
      expect([u["allowDowngrade"], u["allowPrerelease"], u["autoDownload"], u["autoInstallOnAppQuit"]]).toEqual([false, false, false, false]);
    }
  });

  it("a signed release ignores HERDR_COMPANION_UPDATE_FEED; its check goes to GitHub only, and a prerelease manifest on another feed is never asked", async () => {
    version = "0.2.0-beta.1";
    const settings = updates.updateSettings({ HERDR_COMPANION_UPDATE_FEED: "https://feed.invalid/adari/" }, signed);
    expect(settings).toEqual(stable);
    const u = new CheckingUpdater();
    const { c } = controller(u, settings);
    await c.check("manual");
    expect(records.length).toBeGreaterThan(0);
    expect(records.every((r) => r.url.startsWith("https://github.com/adari-app/adari/"))).toBe(true);
    expect(u["allowPrerelease"]).toBe(false);
    // The GitHub provider with allowPrerelease off takes the latest stable tag, never v0.2.0-beta.1.
    expect(records.some((r) => r.url.includes("0.2.0-beta.1"))).toBe(false);
  });

  it("the repo not there yet, or no release: a quiet failure, nothing downloaded", async () => {
    for (const missing of ["no-repo", "no-release"] as const) {
      mode = missing;
      const u = new CheckingUpdater();
      const { c, logs } = controller(u);
      expect(await c.check("automatic")).toEqual({ kind: "failed", message: "No release is published on GitHub yet." });
      expect(c.view()).toMatchObject({ status: "idle", lastCheck: { outcome: "failed" } });
      expect(u.downloads).toBe(0);
      expect(logs.at(-1)).toBe("automatic check failed: No release is published on GitHub yet.");
    }
  });
});

describe("About's privacy line is true for the running build", () => {
  it("builds that never check say only SSH, no relay, no account, no telemetry; a build that checks names GitHub and the switch", () => {
    const base = "Adari talks to your Macs over SSH. No relay, no account, no telemetry.";
    for (const build of [{ ...signed, signed: false }, { ...signed, packaged: false }, { ...signed, demo: true }, { ...signed, flags: true }, { ...signed, platform: "linux" as NodeJS.Platform }]) {
      const settings = updates.updateSettings({ HERDR_COMPANION_UPDATE_FEED: "https://different.invalid/adari/" }, build);
      expect(settings.enabled).toBe(false);
      const view = shared.initialUpdateView("0.1.0", settings.off, true);
      expect(settingsText.privacyLine(view)).toBe(base);
    }
    // A signed build whose own signature check failed is off too.
    expect(settingsText.privacyLine(shared.onUpdatesOff(shared.initialUpdateView("0.1.0", null, true), "unsigned"))).toBe(base);
    const on = shared.initialUpdateView("0.1.0", null, true);
    expect(settingsText.privacyLine(on)).toBe(`${base} It checks GitHub for updates, which you can turn off.`);
    expect(settingsText.privacyLine({ ...on, automatic: false })).toBe(`${base} It checks GitHub for updates only when you ask.`);
    // The README says the same of the signed download.
    expect(readFileSync(path.join(root, "..", "README.md"), "utf8").replace(/\s+/gu, " ")).toContain("The signed download checks GitHub for updates, which you can turn off.");
  });
});

describe("off where it must be", () => {
  it("every off build never loads the updater, even with a feed override and direct calls", async () => {
    vi.useFakeTimers();
    const builds = [{ ...signed, signed: false }, { ...signed, packaged: false }, { ...signed, demo: true }, { ...signed, flags: true }, { ...signed, platform: "linux" as NodeJS.Platform }, { ...signed, platform: "win32" as NodeJS.Platform }];
    for (const build of builds) {
      let loads = 0;
      let verifications = 0;
      const settings = updates.updateSettings({ HERDR_COMPANION_UPDATE_FEED: "https://feed.invalid/" }, build);
      const c = new updates.UpdateController({
        settings,
        version: "0.1.0",
        prefs: updates.memoryUpdatePrefs(),
        load: () => ((loads += 1), Promise.reject(new Error("must not load"))),
        confirmInstall: () => Promise.resolve(true),
        verifySignature: () => ((verifications += 1), Promise.resolve(null)),
      });
      controllers.push(c);
      c.start();
      await vi.advanceTimersByTimeAsync(updates.firstCheckDelayMs + 4 * updates.checkIntervalMs);
      expect(await c.check("manual")).toEqual({ kind: "off" });
      expect(await c.download()).toBe(false);
      expect(await c.requestInstall()).toBe("not-ready");
      expect([loads, verifications]).toEqual([0, 0]);
    }
  });

  it("turned off before the first tick or between ticks: no request; a long check skips ticks", async () => {
    vi.useFakeTimers();
    let checks = 0;
    let loads = 0;
    let finish: ((value: unknown) => void) | null = null;
    const u = new CheckingUpdater();
    u["checkForUpdates"] = () => ((checks += 1), new Promise((resolve) => (finish = resolve)));
    const c = new updates.UpdateController({ settings: stable, version: "0.1.0", prefs: updates.memoryUpdatePrefs(), load: () => ((loads += 1), Promise.resolve(u as unknown as updates.Updater)), confirmInstall: () => Promise.resolve(false), verifySignature: verified });
    controllers.push(c);
    c.start();
    await vi.advanceTimersByTimeAsync(updates.firstCheckDelayMs - 1);
    c.setAutomatic(false);
    await vi.advanceTimersByTimeAsync(4 * updates.checkIntervalMs);
    expect([checks, loads]).toEqual([0, 0]);
    c.setAutomatic(true);
    await vi.advanceTimersByTimeAsync(updates.checkIntervalMs);
    expect(checks).toBe(1);
    await vi.advanceTimersByTimeAsync(4 * updates.checkIntervalMs);
    expect(checks).toBe(1);
    c.setAutomatic(false);
    finish!({ isUpdateAvailable: true, updateInfo: { version: "0.1.1" } });
    await flush();
    await vi.advanceTimersByTimeAsync(4 * updates.checkIntervalMs);
    expect([checks, u.downloads, u.installs]).toEqual([1, 0, 0]);
  });

  it("a signed package opened with --demo, --capture or another instrument flag (which it ignores) never loads electron-updater or sends a request", async () => {
    vi.useFakeTimers();
    const flags = ["--demo", "--capture=/unused", "--capture", "--capture-only=134", "--capture-quit", "--showcase", "--showcase-capture=/unused", "--look-probe=/unused", "--flicker-probe=/unused", "--splits-probe=/unused/f.json"];
    for (const flag of flags) {
      const argv = ["/Applications/Adari.app/Contents/MacOS/Adari", flag];
      const shipped = launch.parseLaunchOptions(argv, { packaged: true });
      // The shipped parser still drops it (no demo, no capture in the release bundle)...
      expect([shipped.demo, shipped.captureDir], flag).toEqual([false, null]);
      // ...and the raw flag still turns this run's updates off, exactly as main.ts reads it.
      expect(launch.hasInstrumentFlag(argv), flag).toBe(true);
      const settings = updates.updateSettings({}, { ...signed, demo: shipped.demo, flags: launch.hasInstrumentFlag(argv) });
      expect(settings, flag).toMatchObject({ enabled: false, off: "flags" });
      let loads = 0;
      const u = new CheckingUpdater();
      const c = new updates.UpdateController({ settings, version: "0.1.0", prefs: updates.memoryUpdatePrefs(), confirmInstall: () => Promise.resolve(false), verifySignature: verified, load: () => ((loads += 1), Promise.resolve(u as unknown as updates.Updater)) });
      controllers.push(c);
      c.start();
      await vi.advanceTimersByTimeAsync(updates.firstCheckDelayMs + 2 * updates.checkIntervalMs);
      expect(await c.check("manual")).toEqual({ kind: "off" });
      expect([loads, records.length], flag).toEqual([0, 0]);
    }
    // Ordinary launches still check: no flag, or only the size and data-folder flags the shipped app keeps.
    expect(launch.hasInstrumentFlag(["/Applications/Adari.app/Contents/MacOS/Adari"])).toBe(false);
    expect(launch.hasInstrumentFlag(["/Applications/Adari.app/Contents/MacOS/Adari", "--window-size=1440x900", "--herdr-user-data=/tmp/x", "--demonstrate"])).toBe(false);
    expect(readFileSync(path.join(root, "src/main/main.ts"), "utf8")).toContain("flags: hasInstrumentFlag(process.argv)");
  });
});

describe("updates only with a real Developer ID signature", () => {
  it("electron-builder's own pull-request guard returns before forceCodeSigning is read; the release identity check refuses such a build instead of baking updates on", async () => {
    const releaseSigning = (await import("../scripts/release-signing.cjs")) as typeof import("../scripts/release-signing.cjs");
    vi.stubEnv("GITHUB_BASE_REF", "main");
    vi.stubEnv("CSC_FOR_PULL_REQUEST", "false");
    vi.stubEnv("ADARI_SIGN_IDENTITY", "Example Co (ABCDE12345)");
    require("app-builder-lib");
    const { MacPackager } = require("app-builder-lib/out/macPackager") as { MacPackager: { prototype: { sign(this: unknown, ...args: unknown[]): Promise<boolean> } } };
    let reads = 0;
    const receiver = {
      get forceCodeSigning() {
        reads += 1;
        return true;
      },
      get platformSpecificBuildOptions(): never {
        throw new Error("past the guard");
      },
    };
    // The real guard: unsigned, forceCodeSigning never read.
    expect(await MacPackager.prototype.sign.call(receiver, "/never-used/Adari.app", undefined, 3, false)).toBe(false);
    expect(reads).toBe(0);
    // Ours, the same environment: the build fails (build.mjs and the config both ask this).
    expect(() => releaseSigning.signedReleaseIdentity()).toThrow(/pull-request build/u);
    expect(releaseSigning.signingSkipReason()).toMatch(/pull-request build/u);
    // CSC_FOR_PULL_REQUEST=true: electron-builder goes on to sign, and so does ours.
    vi.stubEnv("CSC_FOR_PULL_REQUEST", "true");
    await expect(MacPackager.prototype.sign.call(receiver, "/never-used/Adari.app", undefined, 3, false)).rejects.toThrow("past the guard");
    expect(releaseSigning.signedReleaseIdentity()).toEqual({ name: "Example Co (ABCDE12345)", team: "ABCDE12345" });
  });

  it("an ad-hoc '-' identity, a hash, another certificate kind or a name without its team ID is no Developer ID: refused", async () => {
    const releaseSigning = (await import("../scripts/release-signing.cjs")) as typeof import("../scripts/release-signing.cjs");
    // electron-builder 26.16.1 really does take "-" as ad-hoc signing (MacTargetHelper.findSigningIdentity).
    expect(readFileSync(require.resolve("app-builder-lib/out/mac/MacTargetHelper"), "utf8")).toContain('if (qualifier === "-")');
    expect(() => releaseSigning.developerIdIdentity("-")).toThrow(/ad-hoc/u);
    expect(() => releaseSigning.developerIdIdentity("0123456789abcdef0123456789abcdef01234567")).toThrow(/hash/u);
    expect(() => releaseSigning.developerIdIdentity("Apple Development: Someone (ABCDE12345)")).toThrow(/certificate of kind "Apple Development"/u);
    expect(() => releaseSigning.developerIdIdentity("Developer ID Installer: Example Co (ABCDE12345)")).toThrow(/certificate of kind "Developer ID Installer"/u);
    expect(() => releaseSigning.developerIdIdentity("Example Co")).toThrow(/no team ID/u);
    expect(releaseSigning.developerIdIdentity("Developer ID Application: Example Co (ABCDE12345)")).toEqual({ name: "Example Co (ABCDE12345)", team: "ABCDE12345" });
    expect(releaseSigning.developerIdIdentity(undefined)).toBeNull();
    vi.stubEnv("ADARI_SIGN_IDENTITY", "-");
    expect(() => releaseSigning.signedReleaseIdentity()).toThrow(/ad-hoc/u);
  });

  it("the app checks its own signature with codesign: an unsigned bundle, an ad-hoc one and Apple's own are refused (real codesign, read-only)", async () => {
    const unsigned = path.join(mkdtempSync(path.join(scratch, "bundle-")), "Adari.app");
    mkdirSync(path.join(unsigned, "Contents", "MacOS"), { recursive: true });
    writeFileSync(path.join(unsigned, "Contents", "MacOS", "Adari"), "#!/bin/sh\n");
    expect(await updates.checkOwnSignature(unsigned, "ABCDE12345")).toMatch(/^the app is not signed with a Developer ID of team ABCDE12345 \(codesign: .*not signed at all/u);
    // Electron's own download, as installed: ad-hoc (linker) signed.
    const electronApp = path.join(root, "node_modules", "electron", "dist", "Electron.app");
    expect(await updates.checkOwnSignature(electronApp, "ABCDE12345")).toMatch(/^the app is not signed with a Developer ID of team ABCDE12345/u);
    // Signed by Apple, but not with a Developer ID.
    const calculator = "/System/Applications/Calculator.app";
    if (existsSync(calculator)) expect(await updates.checkOwnSignature(calculator, "ABCDE12345")).toMatch(/^the app is not signed with a Developer ID/u);
    // No team baked in, or not a bundle: refused without running anything.
    expect(await updates.checkOwnSignature(unsigned, "")).toBe("this build has no Developer ID team");
    expect(await updates.checkOwnSignature("/usr/bin/true", "ABCDE12345")).toBe("/usr/bin/true is not an app bundle");
  });

  it("what it asks codesign: the running bundle against the Developer ID requirement for the baked team; exit 0 alone passes", async () => {
    const calls: (readonly string[])[] = [];
    const ok = await updates.checkOwnSignature("/Applications/Adari.app", "ABCDE12345", (file, args) => (calls.push([file, ...args]), Promise.resolve({ code: 0, stderr: "" })));
    expect(ok).toBeNull();
    expect(calls).toEqual([
      [
        "/usr/bin/codesign",
        "--verify",
        "--test-requirement",
        '=anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] and certificate leaf[field.1.2.840.113635.100.6.1.13] and certificate leaf[subject.OU] = "ABCDE12345"',
        "/Applications/Adari.app",
      ],
    ]);
    expect(await updates.checkOwnSignature("/Applications/Adari.app", "ABCDE12345", () => Promise.resolve({ code: 3, stderr: "test-requirement: code failed to satisfy specified code requirement(s)\n" }))).toBe(
      "the app is not signed with a Developer ID of team ABCDE12345 (codesign: test-requirement: code failed to satisfy specified code requirement(s))",
    );
    expect(updates.appBundleOf("/Applications/Adari.app/Contents/MacOS/Adari")).toBe("/Applications/Adari.app");
  });

  it("a signed release whose own signature is refused: off for the run, no load, no request, About says only SSH", async () => {
    vi.useFakeTimers();
    let loads = 0;
    const u = new CheckingUpdater();
    const c = new updates.UpdateController({
      settings: stable,
      version: "0.1.0",
      prefs: updates.memoryUpdatePrefs(),
      confirmInstall: () => Promise.resolve(false),
      verifySignature: () => updates.checkOwnSignature(path.join(root, "node_modules", "electron", "dist", "Electron.app"), "ABCDE12345"),
      load: () => ((loads += 1), Promise.resolve(u as unknown as updates.Updater)),
    });
    controllers.push(c);
    c.start();
    await vi.advanceTimersByTimeAsync(updates.firstCheckDelayMs + 2 * updates.checkIntervalMs);
    await vi.waitFor(() => expect(c.view().status).toBe("off"));
    expect(await c.check("manual")).toEqual({ kind: "off" });
    expect([loads, records.length]).toEqual([0, 0]);
    expect(settingsText.privacyLine(c.view())).toBe("Adari talks to your Macs over SSH. No relay, no account, no telemetry.");
  });
});

describe("the real MacUpdater: download, and the hand-over to Squirrel.Mac (a stub)", () => {
  function mac() {
    class Native extends EventEmitter {
      checks = 0;
      installs = 0;
      feeds: unknown[] = [];
      setFeedURL(feed: unknown) {
        this.feeds.push(feed);
      }
      checkForUpdates() {
        this.checks += 1;
      }
      quitAndInstall() {
        this.installs += 1;
      }
    }
    const native = new Native();
    const electronPath = require.resolve("electron");
    const old = require.cache[electronPath];
    require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: { autoUpdater: native } } as unknown as NodeJS.Module;
    let u: Record<string, unknown> & { closeServerIfExists(): void };
    try {
      const { MacUpdater } = require("electron-updater/out/MacUpdater") as { MacUpdater: new (options: unknown, app: unknown) => typeof u };
      u = new MacUpdater(null, adapter());
    } finally {
      if (old) require.cache[electronPath] = old;
      else delete require.cache[electronPath];
    }
    u["httpExecutor"] = new LocalExecutor();
    u["disableDifferentialDownload"] = true;
    u["_testOnlyOptions"] = { platform: "darwin" };
    macs.push(u);
    return { u, native };
  }

  it("a tampered ZIP fails its sha512 before Squirrel sees a feed", async () => {
    const { u, native } = mac();
    const { c } = controller(u);
    corrupt = true;
    await c.check("manual");
    expect(await c.download()).toBe(false);
    expect(c.view()).toMatchObject({ status: "available", error: { during: "download" } });
    expect(c.view().error?.message).toContain("sha512 checksum mismatch");
    expect([native.feeds, native.checks]).toEqual([[], 0]);
  });

  it("Download does not stage with Squirrel; Cancel does nothing; a confirmed Restart stages, and its completion installs once", async () => {
    const { u, native } = mac();
    let yes = false;
    const { c } = controller(u, stable, true, () => Promise.resolve(yes));
    await c.check("manual");
    expect(await c.download()).toBe(true);
    expect([native.checks, native.installs]).toEqual([0, 0]);
    expect(await c.requestInstall()).toBe("cancelled");
    expect(native.checks).toBe(0);
    yes = true;
    await c.requestInstall();
    expect([native.checks, native.installs]).toEqual([1, 0]);
    native.emit("update-downloaded");
    expect(native.installs).toBe(1);
  });

  it("90 s on, still Restarting… (still preparing), and no second hand-over; after a real failure, a retry installs once per completion", async () => {
    const { u, native } = mac();
    let asked = 0;
    const { c, logs } = controller(u, stable, true, () => ((asked += 1), Promise.resolve(true)));
    await c.check("manual");
    expect(await c.download()).toBe(true);
    vi.useFakeTimers();
    expect(await c.requestInstall()).toBe("installing");
    await vi.advanceTimersByTimeAsync(updates.installWaitMs);
    expect(c.view()).toMatchObject({ status: "installing", stillPreparing: true, error: null });
    expect(shared.updateStatusLine(c.view())).toBe("Still preparing Adari 0.1.1. Adari restarts when it is ready.");
    // Restart again while that attempt is under way: nothing asked, nothing handed over.
    expect(await c.requestInstall()).toBe("installing");
    expect([asked, native.checks]).toEqual([1, 1]);
    expect(logs).toContain("still preparing 0.1.1 after 90 s");
    // Squirrel ends that attempt with an error: Restart is offered again, and the attempt's listener is let go.
    native.emit("error", new Error("Squirrel.Mac could not apply the update"));
    expect(c.view()).toMatchObject({ status: "downloaded", stillPreparing: false, error: { during: "install", message: "Squirrel.Mac could not apply the update" } });
    expect(await c.requestInstall()).toBe("installing");
    expect([asked, native.checks]).toEqual([2, 2]);
    native.emit("update-downloaded");
    expect(native.installs).toBe(1);
  });

  it("a slow attempt that completes after 90 s installs once", async () => {
    const { u, native } = mac();
    const { c } = controller(u, stable, true, () => Promise.resolve(true));
    await c.check("manual");
    expect(await c.download()).toBe(true);
    vi.useFakeTimers();
    await c.requestInstall();
    await vi.advanceTimersByTimeAsync(3 * updates.installWaitMs);
    expect(await c.requestInstall()).toBe("installing");
    native.emit("update-downloaded");
    expect([native.checks, native.installs]).toEqual([1, 1]);
  });
});

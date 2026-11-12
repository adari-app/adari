// The release build loads electron-updater's real updater. Every other update test hands the controller a fake
// updater, so none sees what the release build does with `import("electron-updater")`: esbuild leaves it a real
// dynamic import (electron-updater is external), Node's ESM loader names a CommonJS module's exports by reading its
// source, and electron-updater 6.8.9 makes `autoUpdater` an arrow-function getter (out/main.js: `get: () => {…}`)
// that reading does not see, so the namespace's autoUpdater is undefined and, taken from there alone, the first
// check fails with "Cannot set properties of undefined (setting 'autoDownload')".
//
// This check builds the controller with scripts/build.mjs's own options for the main bundle, lays it out as the
// package does (the bundle beside node_modules), starts it in a real Electron main process (node_modules/electron's
// binary, what `npm start`'s `electron .` runs) with a temp user-data folder, and has the controller's own default
// loader load electron-updater and set it up. Nothing checks for updates: no request leaves this machine.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { build } from "esbuild";
import { describe, expect, it } from "vitest";

import { UpdateController, updaterFrom, updaterLoadFailure, memoryUpdatePrefs, updateSettings, type Updater } from "../src/main/updates";

const root = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);

/** scripts/build.mjs's options for the main bundle of a release build (the first test checks they are its own). */
const releaseMainOptions = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  outExtension: { ".js": ".cjs" },
  external: ["electron", "ssh2", "electron-updater"],
} as const;

describe("the release build's main bundle loads electron-updater's real updater", () => {
  it("the options this check builds with are scripts/build.mjs's own", () => {
    const script = readFileSync(path.join(root, "scripts/build.mjs"), "utf8");
    for (const line of ["bundle: true,", 'platform: "node",', 'format: "cjs",', 'target: "node22",', 'outExtension: { ".js": ".cjs" },', 'entryPoints: { main: "src/main/main.ts" },', 'external: ["electron", "ssh2", "electron-updater"],']) {
      expect(script, line).toContain(line);
    }
  });

  it(
    "built as the release builds it and run in Electron, the controller's own loader gets the updater and sets it up",
    async () => {
      const electron = require("electron") as unknown as string;
      expect(existsSync(electron), `no Electron binary at ${electron}: run npm run ensure:electron once`).toBe(true);
      const scratch = mkdtempSync(path.join(process.env["HERDR_TEST_SCRATCH"] || os.tmpdir(), "updater-load-"));
      // The package's layout: the app folder holds package.json, dist/main/<bundle>.cjs and node_modules.
      const app = path.join(scratch, "app");
      const userData = path.join(scratch, "user-data");
      mkdirSync(path.join(app, "dist", "main"), { recursive: true });
      mkdirSync(userData);
      symlinkSync(path.join(root, "node_modules"), path.join(app, "node_modules"), "dir");
      writeFileSync(path.join(app, "package.json"), `${JSON.stringify({ name: "adari-updater-load-check", version: "0.1.0", main: "dist/main/probe.cjs" })}\n`);
      const entry = path.join(scratch, "probe.ts");
      writeFileSync(entry, probeSource(path.join(root, "src/main/updates.ts")));
      await build({
        ...releaseMainOptions,
        external: [...releaseMainOptions.external],
        absWorkingDir: root,
        logLevel: "warning",
        define: { __ADARI_DEMO__: "false", __ADARI_COMMIT__: '""', __ADARI_UPDATE_TEAM__: '"ABCDE12345"' },
        entryPoints: { probe: entry },
        outdir: path.join(app, "dist", "main"),
      });
      const built = readFileSync(path.join(app, "dist", "main", "probe.cjs"), "utf8");
      // The release build's shape: electron-updater left out of the bundle and loaded by a dynamic import.
      expect(built).toContain('import("electron-updater")');
      expect(built).not.toMatch(/require\("electron-updater"\)/u);

      const env: NodeJS.ProcessEnv = { ...process.env, ADARI_UPDATER_LOAD_USER_DATA: userData };
      delete env["ELECTRON_RUN_AS_NODE"];
      const run = spawnSync(electron, [app, `--user-data-dir=${userData}`], { env, encoding: "utf8", timeout: 60_000 });
      const line = run.stdout.split("\n").find((text) => text.startsWith("UPDATER-LOAD "));
      expect(line, `Electron exited ${run.status} (${run.signal ?? "no signal"}): ${run.stderr.slice(-2000)}`).toBeDefined();
      const result = JSON.parse(line!.slice("UPDATER-LOAD ".length)) as Record<string, unknown>;
      expect(result["error"]).toBeUndefined();
      expect(result["methods"]).toEqual({ checkForUpdates: "function", downloadUpdate: "function", quitAndInstall: "function", setFeedURL: "function", on: "function" });
      expect(result["className"]).toBe(process.platform === "darwin" ? "MacUpdater" : process.platform === "win32" ? "NsisUpdater" : "AppImageUpdater");
      // configureUpdater ran on electron-updater's own object.
      expect(result["settings"]).toEqual({ autoDownload: false, autoInstallOnAppQuit: false, allowPrerelease: false, allowDowngrade: false, fullChangelog: false });
      expect(result["stagingId"]).toBe("00000000-0000-0000-0000-000000000000");
      expect(result["listeners"]).toEqual({ "download-progress": 1, error: 2 });
      expect(result["nativeUpdater"]).toBe(process.platform === "darwin");
      // No check ran.
      expect(result["log"]).toEqual(["signature check passed"]);
    },
    90_000,
  );
});

/** The Electron main process: the controller as main.ts makes it for a signed release, asked only to load and set up. */
function probeSource(updates: string): string {
  return `
import { app } from "electron";
import { UpdateController, memoryUpdatePrefs, updateSettings } from ${JSON.stringify(updates)};

app.setPath("userData", process.env["ADARI_UPDATER_LOAD_USER_DATA"]);
app.dock?.hide();
const out = (result) => {
  process.stdout.write("UPDATER-LOAD " + JSON.stringify(result) + "\\n");
  app.exit(0);
};
app.whenReady().then(async () => {
  const log = [];
  const settings = updateSettings({}, { platform: "darwin", packaged: true, signed: true, demo: false, flags: false });
  const controller = new UpdateController({
    settings,
    version: app.getVersion(),
    prefs: memoryUpdatePrefs(),
    confirmInstall: async () => false,
    verifySignature: async () => null,
    log: (line) => log.push(line),
  });
  try {
    // The first check's own step: signature, load, configureUpdater, the listeners. (No checkForUpdates.)
    const updater = await controller["configured"]();
    out({
      methods: Object.fromEntries(["checkForUpdates", "downloadUpdate", "quitAndInstall", "setFeedURL", "on"].map((name) => [name, typeof updater[name]])),
      className: updater.constructor.name,
      settings: { autoDownload: updater.autoDownload, autoInstallOnAppQuit: updater.autoInstallOnAppQuit, allowPrerelease: updater.allowPrerelease, allowDowngrade: updater.allowDowngrade, fullChangelog: updater.fullChangelog },
      stagingId: await updater.stagingUserIdPromise.value,
      listeners: { "download-progress": updater.listenerCount("download-progress"), error: updater.listenerCount("error") },
      nativeUpdater: typeof updater.nativeUpdater?.listeners === "function" && typeof updater.nativeUpdater?.removeListener === "function",
      log,
    });
  } catch (error) {
    out({ error: error instanceof Error ? error.name + ": " + error.message : String(error), log });
  }
});
`;
}

describe("the loader takes the updater from wherever the module has it", () => {
  const fake = (): Updater =>
    ({
      setFeedURL: () => undefined,
      checkForUpdates: () => Promise.resolve(null),
      downloadUpdate: () => Promise.resolve([]),
      quitAndInstall: () => undefined,
      on: () => undefined,
    }) as unknown as Updater;

  it("a named export (a bundler's interop) or module.exports (Node's import of electron-updater's CommonJS)", () => {
    const one = fake();
    expect(updaterFrom({ autoUpdater: one })).toBe(one);
    const two = fake();
    expect(updaterFrom({ default: { autoUpdater: two }, AppUpdater: class {} })).toBe(two);
    const three = fake();
    expect(updaterFrom({ "module.exports": { autoUpdater: three } })).toBe(three);
  });

  it("nowhere, or not an updater, or its getter throws: the plain sentence, never a TypeError", () => {
    for (const loaded of [undefined, null, {}, { default: {} }, { autoUpdater: {} }, { default: { autoUpdater: { on: () => undefined } } }, 7]) {
      expect(() => updaterFrom(loaded)).toThrow(updaterLoadFailure);
    }
    const throwing = {
      get autoUpdater(): never {
        throw new TypeError("Cannot read properties of undefined (reading 'getVersion')");
      },
    };
    expect(() => updaterFrom({ default: throwing })).toThrow(updaterLoadFailure);
    expect(() => updaterFrom({ default: throwing })).not.toThrow(TypeError);
    expect(updaterLoadFailure).toBe("Adari could not load its updater.");
  });

  it("Settings' last-check line says the sentence when the load fails", async () => {
    const lines: string[] = [];
    const controller = new UpdateController({
      settings: updateSettings({}, { platform: "darwin", packaged: true, signed: true, demo: false, flags: false }),
      version: "0.1.0",
      prefs: memoryUpdatePrefs(),
      confirmInstall: () => Promise.resolve(false),
      verifySignature: () => Promise.resolve(null),
      load: () => Promise.resolve(updaterFrom({ default: {} })),
      log: (line) => lines.push(line),
    });
    expect(await controller.check("manual")).toEqual({ kind: "failed", message: updaterLoadFailure });
    expect(controller.view().error).toEqual({ during: "check", message: updaterLoadFailure });
    expect(lines).toContain(`manual check failed: ${updaterLoadFailure}`);
  });
});

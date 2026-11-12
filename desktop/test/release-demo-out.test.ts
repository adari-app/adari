// The demo and the showcase are out of the shipped app.
// (1) In a packaged app the demo, capture, look-probe, splits-probe, showcase and
// showcase-capture flags are ignored; unpackaged (`npm start -- --demo`) they
// work. (2) main.ts reaches the demo, showcase, captures and probes only
// through dev-modes.ts, behind the __ADARI_DEMO__ constant scripts/build.mjs sets
// false for `npm run dist:mac|win|linux` (each runs `node scripts/build.mjs --release`), so esbuild leaves them and their fixtures
// out of dist/main (a grep of the packaged app.asar confirms it).

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { parseLaunchOptions } from "../src/main/launch-options";

const devFlags = [
  "--demo",
  "--capture=/tmp/c",
  "--capture-quit",
  "--look-probe=/tmp/l",
  "--flicker-probe=/tmp/f",
  "--splits-probe=/tmp/p.json",
  "--showcase",
  "--showcase-capture=/tmp/s",
];

describe("the demo flags in the shipped app", () => {
  it("are all ignored in a packaged app: no demo, capture, probe or showcase", () => {
    const options = parseLaunchOptions(["/Applications/Adari.app/Contents/MacOS/Adari", ...devFlags], { packaged: true });
    expect(options.demo).toBe(false);
    expect(options.captureDir).toBeNull();
    expect(options.lookProbeDir).toBeNull();
    expect(options.flickerProbeDir).toBeNull();
    expect(options.probeFile).toBeNull();
    expect(options.showcase).toBe(false);
    expect(options.showcaseCaptureDir).toBeNull();
  });

  it("are each ignored alone in a packaged app", () => {
    for (const flag of devFlags.filter((name) => name !== "--capture-quit")) {
      const options = parseLaunchOptions(["app", flag], { packaged: true });
      expect({ flag, demo: options.demo, showcase: options.showcase }).toEqual({ flag, demo: false, showcase: false });
    }
  });

  it("keeps the window size and the userData folder in a packaged app", () => {
    const options = parseLaunchOptions(["app", "--demo", "--window-size=1280x800", "--herdr-user-data=/tmp/u"], { packaged: true });
    expect(options.windowSize).toEqual({ width: 1280, height: 800 });
    expect(options.userDataDir).toBe("/tmp/u");
  });

  it("work unpackaged, as before: npm start -- --demo, the captures, the probes, the showcase", () => {
    for (const context of [{ packaged: false }, {}]) {
      expect(parseLaunchOptions(["app", "--demo"], context).demo).toBe(true);
      const options = parseLaunchOptions(["app", ...devFlags], context);
      expect(options.demo).toBe(true);
      expect(options.captureDir).toBe("/tmp/c");
      expect(options.lookProbeDir).toBe("/tmp/l");
      expect(options.flickerProbeDir).toBe("/tmp/f");
      expect(options.probeFile).toBe("/tmp/p.json");
      expect(options.showcase).toBe(true);
      expect(options.showcaseCaptureDir).toBe("/tmp/s");
    }
  });
});

describe("the demo code in a dist build", () => {
  const read = (file: string): string => readFileSync(path.join(__dirname, "..", file), "utf8");

  it("main.ts imports no demo, showcase, capture or probe module; it requires dev-modes.ts behind __ADARI_DEMO__", () => {
    const main = read("src/main/main.ts");
    const imports = main.match(/^import[\s\S]*?from "([^"]+)";$/gmu) ?? [];
    expect(imports.length).toBeGreaterThan(10);
    for (const line of imports) expect(line).not.toMatch(/"\.\/(demo|showcase)\/|"\.\/(capture|look-probe|flicker-probe|frame-probe|dev-modes)"/u);
    // This Mac's fake-herdr fixture too; only its type may be named (erased by esbuild).
    for (const line of imports.filter((text) => !text.startsWith("import type "))) expect(line).not.toMatch(/"\.\/this-mac-fixture"/u);
    expect(read("src/main/dev-modes.ts")).toMatch(/export \{ openThisMacFixture \} from "\.\/this-mac-fixture";/u);
    expect(main).toMatch(/__ADARI_DEMO__ \? \(require\("\.\/dev-modes"\)/u);
    expect(main).toContain("packaged: app.isPackaged || devModes === null");
  });

  it("build.mjs defines __ADARI_DEMO__ false for a release build and true otherwise", () => {
    const build = read("scripts/build.mjs");
    expect(build).toContain('define: { __ADARI_DEMO__: release ? "false" : "true" }');
    expect(build).toMatch(/dist:\(mac\|win\|linux\)/u);
    expect(build).toContain("electron-builder");
  });

  // The release build comes from the dist scripts themselves, not from spotting a parent process.
  it("every dist:* script builds with build.mjs --release before electron-builder", () => {
    const scripts = (JSON.parse(read("package.json")) as { scripts: Record<string, string> }).scripts;
    const dist = Object.keys(scripts).filter((name) => name.startsWith("dist"));
    expect(dist.sort()).toEqual(["dist:linux", "dist:mac", "dist:win"]);
    for (const name of dist) {
      expect(scripts[name]).toMatch(/^node scripts\/build\.mjs --release && electron-builder /u);
      expect(scripts[name]).not.toContain("npm run build");
    }
    expect(read("scripts/build.mjs")).toContain('process.argv.includes("--release")');
  });

  it("the command channel the shipped app answers through is outside capture.ts, which re-exports it", async () => {
    const commands = await import("../src/main/app-commands");
    const capture = await import("../src/main/capture");
    expect(capture.AppCommands).toBe(commands.AppCommands);
    expect(read("src/main/app-commands.ts").match(/^import[\s\S]*?from "([^"]+)";$/gmu)?.join("\n")).not.toMatch(/demo|showcase|capture/iu);
  });
});

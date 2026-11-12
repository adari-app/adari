// The flicker probe is off in the shipped app. In a packaged build `--flicker-probe=<dir>` is ignored
// before it changes demo or window behaviour (no demo, no probe directory), and
// the runner refuses too, before it touches the window. Unpackaged (npm start)
// it works as before.

import { describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({ isPackaged: true }));
vi.mock("electron", () => ({
  app: {
    get isPackaged() {
      return electron.isPackaged;
    },
  },
  contentTracing: {},
}));

const { parseLaunchOptions } = await import("../src/main/launch-options");
const { runFlickerProbe } = await import("../src/main/flicker-probe");

describe("the flicker probe in the shipped app", () => {
  it("is ignored in a packaged build: no probe, no demo", () => {
    const options = parseLaunchOptions(["/Applications/Adari.app", "--flicker-probe=/tmp/x"], { packaged: true });
    expect(options.flickerProbeDir).toBeNull();
    expect(options.demo).toBe(false);
  });

  // --demo is ignored in the packaged app too (test/release-demo-out.test.ts).
  it("ignores --demo with it as well", () => {
    expect(parseLaunchOptions(["app", "--demo", "--flicker-probe=/tmp/x"], { packaged: true }).demo).toBe(false);
  });

  it("works unpackaged, as before (and when not told)", () => {
    for (const options of [parseLaunchOptions(["app", "--flicker-probe=/tmp/x"], { packaged: false }), parseLaunchOptions(["app", "--flicker-probe=/tmp/x"])]) {
      expect(options.flickerProbeDir).toBe("/tmp/x");
      expect(options.demo).toBe(true);
    }
  });

  // The capture flag is off in the packaged app too; the window size still applies.
  it("leaves the window size alone in a packaged build, and drops the capture flag", () => {
    const options = parseLaunchOptions(["app", "--capture=/tmp/c", "--window-size=1280x600"], { packaged: true });
    expect(options.captureDir).toBeNull();
    expect(options.windowSize).toEqual({ width: 1280, height: 600 });
  });

  it("the runner refuses in a packaged build before it touches the window", async () => {
    electron.isPackaged = true;
    const touched: string[] = [];
    const window = new Proxy({}, { get: (_t, name) => void touched.push(String(name)) });
    const commands = { ready: async () => void touched.push("ready"), send: async () => void touched.push("send") };
    await expect(runFlickerProbe(window as never, commands as never, "/nonexistent", { macMini: "m" }, "run")).rejects.toThrow("the flicker probe is off in the shipped app");
    expect(touched).toEqual([]);
  });
});

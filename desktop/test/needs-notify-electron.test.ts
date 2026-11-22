// The real NotifyPort (src/main/needs-notify-electron.ts) on a fake Electron: never a real notification. On the Mac
// a notification's answer comes from Electron's own events (Electron 44.9.3: `show` when macOS took it, `failed` with
// macOS's error text when it refused it), the error's words go to the log only, the click and close still work, and
// Open Notification Settings opens the one fixed address of macOS's Notifications pane. Elsewhere nothing changes:
// no answer is read ("unknown") and nothing is opened.

import { EventEmitter } from "node:events";

import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  made: [] as { options: unknown; shows: number; closes: number; emitter: import("node:events").EventEmitter }[],
  opened: [] as string[],
}));

vi.mock("electron", async () => {
  const { EventEmitter: Emitter } = await import("node:events");
  class Notification extends Emitter {
    static isSupported = () => true;
    readonly record: { options: unknown; shows: number; closes: number; emitter: import("node:events").EventEmitter };
    constructor(options: unknown) {
      super();
      this.record = { options, shows: 0, closes: 0, emitter: this };
      fake.made.push(this.record);
    }
    show(): void {
      this.record.shows += 1;
    }
    close(): void {
      this.record.closes += 1;
    }
  }
  return {
    app: { focus: () => undefined, dock: { setBadge: () => undefined }, quit: () => undefined },
    Menu: { buildFromTemplate: () => ({}) },
    nativeImage: { createEmpty: () => ({ addRepresentation: () => undefined, setTemplateImage: () => undefined }) },
    Notification,
    shell: {
      openExternal: (url: string) => {
        fake.opened.push(url);
        return Promise.resolve();
      },
    },
    Tray: class {},
  };
});

const { electronNotifyPort } = await import("../src/main/needs-notify-electron");
const { macNotificationSettingsUrl } = await import("../src/shared/needs-notify");

const content = { title: "Claude w1:p1", body: "Pending Approval · web · Mac mini", silent: false };

function port(platform: NodeJS.Platform) {
  const lines: string[] = [];
  const made = electronNotifyPort({ platform, window: () => null, select: () => undefined, openSettings: () => undefined, log: (line) => lines.push(line) });
  return { port: made, lines };
}

beforeEach(() => {
  fake.made.length = 0;
  fake.opened.length = 0;
});

describe("the Electron notification port", () => {
  it("on the Mac: `failed` answers failed once, its error text only in the log", () => {
    const { port: mac, lines } = port("darwin");
    const outcomes: string[] = [];
    mac.notify(content, () => undefined, (outcome) => outcomes.push(outcome));
    expect(fake.made).toHaveLength(1);
    expect(fake.made[0]!.shows).toBe(1);
    expect(outcomes).toEqual([]);
    const emitter = fake.made[0]!.emitter as EventEmitter;
    emitter.emit("failed", {}, "Notifications are not allowed for this application");
    expect(outcomes).toEqual(["failed"]);
    expect(lines).toEqual(["macOS did not show a notification: Notifications are not allowed for this application"]);
    // One answer per notification; nothing retried.
    emitter.emit("show", {});
    emitter.emit("failed", {}, "again");
    expect(outcomes).toEqual(["failed"]);
    expect(fake.made[0]!.shows).toBe(1);
    expect(fake.made).toHaveLength(1);
  });

  it("on the Mac: `show` answers shown; the click handler and close still work", () => {
    const { port: mac, lines } = port("darwin");
    const outcomes: string[] = [];
    let clicks = 0;
    const shown = mac.notify(content, () => (clicks += 1), (outcome) => outcomes.push(outcome));
    const emitter = fake.made[0]!.emitter as EventEmitter;
    emitter.emit("show", {});
    expect(outcomes).toEqual(["shown"]);
    emitter.emit("click", {});
    expect(clicks).toBe(1);
    shown.close();
    expect(fake.made[0]!.closes).toBe(1);
    expect(fake.made[0]!.options).toEqual(content);
    expect(lines).toEqual([]);
  });

  it("off the Mac: unchanged; the answer is unknown at once, no listener on show or failed, nothing opened", () => {
    for (const platform of ["win32", "linux"] as const) {
      fake.made.length = 0;
      const { port: other, lines } = port(platform);
      const outcomes: string[] = [];
      let clicks = 0;
      const shown = other.notify(content, () => (clicks += 1), (outcome) => outcomes.push(outcome));
      expect(outcomes).toEqual(["unknown"]);
      const emitter = fake.made[0]!.emitter as EventEmitter;
      expect(emitter.listenerCount("show")).toBe(0);
      expect(emitter.listenerCount("failed")).toBe(0);
      emitter.emit("click", {});
      expect(clicks).toBe(1);
      shown.close();
      expect(fake.made[0]!.closes).toBe(1);
      other.openSystemSettings();
      expect(fake.opened).toEqual([]);
      expect(lines).toEqual([]);
    }
  });

  it("Open Notification Settings opens exactly macOS's Notifications pane, from main's own constant", () => {
    expect(macNotificationSettingsUrl).toBe("x-apple.systempreferences:com.apple.Notifications-Settings.extension");
    const { port: mac } = port("darwin");
    mac.openSystemSettings();
    expect(fake.opened).toEqual(["x-apple.systempreferences:com.apple.Notifications-Settings.extension"]);
    // The port takes no address: there is nothing for the page to pass.
    expect(mac.openSystemSettings.length).toBe(0);
  });
});

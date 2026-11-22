// Settings › Notifications (SettingsPage.tsx NotificationsSection): a section in the list between Appearance and
// Updates; three switches, all on by default, read from and changed in the main process; Send a test notification
// and what it said; the line that macOS decides. The menu bar switch is the Mac's only. On the Mac the line that macOS
// decides is a row with Open Notification Settings (it asks main, with nothing the page could make an address of), and
// the line that macOS is not showing Adari's notifications shows only after one failed, gone after one shows.

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  const hooks = { ...fakeReact, useLayoutEffect: fakeReact.useEffect };
  return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});
vi.mock("electron", () => ({ ipcMain: { handle: () => undefined, on: () => undefined } }));

import { defaultNotifySettings, notifyTexts, testSentText, type NotifyDelivery, type NotifySettings } from "../src/shared/needs-notify";
import { settingsSections } from "../src/shared/settings";
import { elements, HookHost } from "./support/fake-hooks";
import { appInfo, flush, loadSettings, mountSettings, settingsBridge } from "./support/settings-page";

const { NotificationsSection } = await import("../src/renderer/settings/SettingsPage");
await loadSettings();

const hosts: HookHost<object>[] = [];
afterEach(() => {
  for (const host of hosts.splice(0)) host.unmount();
});

function bridge(start: NotifySettings = defaultNotifySettings, answers: { delivery?: NotifyDelivery | null; test?: string } = {}) {
  const calls: unknown[][] = [];
  let kept = start;
  const state = { delivery: answers.delivery ?? null, test: answers.test ?? testSentText };
  return {
    calls,
    state,
    notifyDelivery: () => (calls.push(["notifyDelivery"]), Promise.resolve(state.delivery)),
    openNotificationSettings: (...args: unknown[]) => void calls.push(["openNotificationSettings", ...args]),
    notifySettings: () => (calls.push(["notifySettings"]), Promise.resolve(kept)),
    setNotifySettings: (change: Partial<NotifySettings>) => {
      calls.push(["setNotifySettings", change]);
      kept = { ...kept, ...change };
      return Promise.resolve(kept);
    },
    testNotification: () => (calls.push(["testNotification"]), Promise.resolve(state.test)),
  };
}

function mount(fake: object, mac = true) {
  const host = new HookHost<object>(NotificationsSection as (props: object) => unknown, { bridge: fake, mac });
  hosts.push(host);
  host.render();
  const switches = () => elements(host.tree).filter((element) => element.type !== undefined && (element.props as Record<string, unknown>)["data"] !== undefined);
  const find = (predicate: (props: Record<string, unknown>) => boolean) => elements(host.tree).find((element) => predicate(element.props));
  return { host, switches, find, words: () => JSON.stringify(host.tree) };
}

describe("Settings › Notifications", () => {
  it("is listed between Appearance and Updates, and the page shows it", () => {
    expect(settingsSections.map((section) => section.id)).toEqual(["machines", "chat", "uploads", "appearance", "notifications", "updates", "about"]);
    expect(settingsSections.find((section) => section.id === "notifications")?.title).toBe("Notifications");
    const run = mountSettings("notifications", { bridge: settingsBridge().bridge, extra: { info: appInfo } });
    expect(run.part("NotificationsSection")?.props["mac"]).toBe(true);
    run.view.unmount();
  });

  it("shows three switches, all on by default, as the main process keeps them, then the test button and macOS's line", async () => {
    const fake = bridge({ notify: true, sound: false, menuBar: true });
    const view = mount(fake);
    await flush();
    view.host.render();
    const switches = view.switches().map((element) => (element.props as Record<string, unknown>)["data"]);
    expect(switches).toEqual([{ "data-notify-switch": "notify" }, { "data-notify-switch": "sound" }, { "data-notify-switch": "menuBar" }]);
    const on = view.switches().map((element) => (element.props as Record<string, unknown>)["on"]);
    expect(on).toEqual([true, false, true]);
    const text = view.words();
    for (const words of [notifyTexts.title, notifyTexts.notify, notifyTexts.sound, notifyTexts.menuBar, notifyTexts.test, notifyTexts.macLine]) expect(text).toContain(words);
    expect(text).not.toContain(String.fromCharCode(0x2014));
  });

  it("a switch changes the setting in the main process at once", async () => {
    const fake = bridge();
    const view = mount(fake);
    await flush();
    view.host.render();
    const menuBar = view.switches().find((element) => ((element.props as Record<string, unknown>)["data"] as Record<string, string>)["data-notify-switch"] === "menuBar")!;
    ((menuBar.props as Record<string, unknown>)["onChange"] as (on: boolean) => void)(false);
    await flush();
    view.host.render();
    expect(fake.calls).toContainEqual(["setNotifySettings", { menuBar: false }]);
    const after = view.switches().map((element) => (element.props as Record<string, unknown>)["on"]);
    expect(after).toEqual([true, true, false]);
  });

  it("Send a test notification asks the main process and says what it answered", async () => {
    const fake = bridge();
    const view = mount(fake);
    const button = view.find((props) => props["children"] === notifyTexts.test)!;
    (button.props["onClick"] as () => void)();
    await flush();
    view.host.render();
    expect(fake.calls).toContainEqual(["testNotification"]);
    expect(view.words()).toContain(testSentText);
  });

  it("off the Mac: no menu bar switch, and the system's line in place of macOS's", async () => {
    const view = mount(bridge(), false);
    await flush();
    view.host.render();
    expect(view.switches()).toHaveLength(2);
    expect(view.words()).toContain(notifyTexts.otherLine);
    expect(view.words()).not.toContain(notifyTexts.macLine);
  });

  it("on the Mac: Open Notification Settings beside macOS's line, always; a click asks main with no argument", async () => {
    const fake = bridge();
    const view = mount(fake);
    await flush();
    view.host.render();
    const button = view.find((props) => props["children"] === notifyTexts.openSettings)!;
    expect(button).toBeDefined();
    expect(button.props["data-notify-open-settings"]).toBe("");
    expect(button.props["disabled"]).toBe(false);
    const system = view.find((props) => props["data-notify-system"] === "")!;
    expect(JSON.stringify(system)).toContain(notifyTexts.macLine);
    expect(JSON.stringify(system)).toContain(notifyTexts.openSettings);
    (button.props["onClick"] as (event: unknown) => void)({ target: "x-apple.systempreferences:com.apple.preference.security" });
    expect(fake.calls.filter((call) => call[0] === "openNotificationSettings")).toEqual([["openNotificationSettings"]]);
    // Nothing known: no off line, and the words are the section's own.
    expect(view.words()).not.toContain(notifyTexts.offLine);
    expect(notifyTexts.offLine).not.toContain(String.fromCharCode(0x2014));
    expect(notifyTexts.openSettings).not.toContain(String.fromCharCode(0x2014));
  });

  it("off the Mac: no Open Notification Settings, no off line, the delivery not read", async () => {
    const fake = bridge(defaultNotifySettings, { delivery: { outcome: "failed", at: 1 } });
    const view = mount(fake, false);
    await flush();
    view.host.render();
    expect(view.find((props) => props["children"] === notifyTexts.openSettings)).toBeUndefined();
    expect(view.words()).not.toContain(notifyTexts.offLine);
    expect(fake.calls).not.toContainEqual(["notifyDelivery"]);
  });

  it("the off line shows only after a notification failed, in the section's warning style, and goes after one shows", async () => {
    const fake = bridge(defaultNotifySettings, { delivery: { outcome: "shown", at: 1 } });
    const view = mount(fake);
    await flush();
    view.host.render();
    expect(view.words()).not.toContain(notifyTexts.offLine);
    // A notification failed since; the section opens again.
    view.host.unmount();
    fake.state.delivery = { outcome: "failed", at: 2 };
    const again = mount(fake);
    await flush();
    again.host.render();
    const off = again.find((props) => props["data-notify-off"] === "")!;
    expect(off.props["className"]).toBe("set-bad");
    expect(off.props["children"]).toBe(notifyTexts.offLine);
    expect(again.words().split(notifyTexts.offLine)).toHaveLength(2);
    // One shows (a test that showed): the line goes.
    fake.state.delivery = { outcome: "shown", at: 3 };
    const button = again.find((props) => props["children"] === notifyTexts.test)!;
    (button.props["onClick"] as () => void)();
    await flush();
    again.host.render();
    expect(again.words()).toContain(testSentText);
    expect(again.words()).not.toContain(notifyTexts.offLine);
  });

  it("a failed test says the off line in place of Sent., once, with Open Notification Settings in the section", async () => {
    const fake = bridge(defaultNotifySettings, { test: notifyTexts.offLine });
    const view = mount(fake);
    await flush();
    view.host.render();
    fake.state.delivery = { outcome: "failed", at: 5 };
    const button = view.find((props) => props["children"] === notifyTexts.test)!;
    (button.props["onClick"] as () => void)();
    await flush();
    view.host.render();
    expect(view.words()).not.toContain(testSentText);
    expect(view.words().split(notifyTexts.offLine)).toHaveLength(2);
    const test = view.find((props) => props["data-notify-test"] === "")!;
    expect(JSON.stringify(test)).toContain(notifyTexts.offLine);
    expect(view.find((props) => props["children"] === notifyTexts.openSettings)).toBeDefined();
    expect(fake.calls.filter((call) => call[0] === "testNotification")).toHaveLength(1);
  });

  it("an odd answer from main is no failure", async () => {
    const fake = bridge(defaultNotifySettings, { delivery: { outcome: "failed", at: 1, extra: true } as unknown as NotifyDelivery });
    const view = mount(fake);
    await flush();
    view.host.render();
    expect(view.words()).not.toContain(notifyTexts.offLine);
  });
});

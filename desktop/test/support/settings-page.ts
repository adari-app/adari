// The Settings page (src/renderer/settings/SettingsPage.tsx)
// on its own hooks host, over a fake bridge that records what it is asked. The
// test file mocks "react" with fakeReact, then calls loadSettings().

import { vi } from "vitest";

import type { AppInfo, HostView } from "../../src/shared/ipc-contract";
import type { SettingsSection, UploadsDeleteResult, UploadsInventory } from "../../src/shared/settings";
import { parseStartCommands } from "../../src/shared/start-commands";
import { HookHost, elements } from "./fake-hooks";

type Element = ReturnType<typeof elements>[number];

export const sshHost = (id: string, name: string, extra: Partial<HostView> = {}): HostView =>
  ({ id, name, kind: "ssh", address: `me@${id}:22`, platform: "macOS", state: "connected", error: null, topology: null, fetchedAtMs: 0, ...extra }) as HostView;

export const thisMac: HostView = { ...sshHost("local", "This Mac"), kind: "local", address: "local" } as HostView;

export interface FakeSettingsBridge {
  readonly calls: [string, ...unknown[]][];
  count: (hostId: string) => Promise<UploadsInventory>;
  remove: (hostId: string) => Promise<UploadsDeleteResult>;
}

export function settingsBridge() {
  const fake: FakeSettingsBridge = {
    calls: [],
    count: () => Promise.resolve({ files: 3, bytes: 3_200_000 }),
    remove: () => Promise.resolve({ removedFiles: 3, removedBytes: 3_200_000, removedFolders: 1, keptFiles: 0, stopped: null, remaining: { files: 0, bytes: 0 } }),
  };
  const bridge = {
    uploadsCount: (hostId: string) => {
      fake.calls.push(["uploadsCount", hostId]);
      return fake.count(hostId);
    },
    deleteUploadsNow: (hostId: string) => {
      fake.calls.push(["deleteUploadsNow", hostId]);
      return fake.remove(hostId);
    },
    startCommands: (hostId: string) => {
      fake.calls.push(["startCommands", hostId]);
      return Promise.resolve(parseStartCommands(null));
    },
    checkForUpdates: () => {
      fake.calls.push(["checkForUpdates"]);
      return Promise.resolve("Adari 0.1.0 is the latest version.");
    },
  };
  return { fake, bridge };
}

export const appInfo = { version: "0.1.0", platform: "darwin", demo: false, capture: false, updates: { enabled: true, feedUrl: "" }, commit: "abc12345" } as unknown as AppInfo;

export interface SettingsRun {
  readonly view: HookHost<object>;
  props: Record<string, unknown>;
  /** The page again with some props changed (App's next render). */
  rerender(next: Record<string, unknown>): void;
  find(predicate: (element: Element) => boolean): Element | undefined;
  all(predicate: (element: Element) => boolean): Element[];
  /** A nested component's element (UploadsLine, Switch) by its name. */
  part(name: string, where?: (props: Record<string, unknown>) => boolean): Element | undefined;
}

let settingsModule: typeof import("../../src/renderer/settings/SettingsPage") | null = null;

/** Loads SettingsPage (after the test's react mock is in place). */
export async function loadSettings(): Promise<void> {
  settingsModule = await import("../../src/renderer/settings/SettingsPage");
}

/** The page at `section`, over `bridge`; every App callback recorded in `events`. */
export function mountSettings(section: SettingsSection, options: { bridge: object; hosts?: HostView[]; extra?: Record<string, unknown>; events?: unknown[][] }): SettingsRun {
  const events = options.events ?? [];
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      events.push([name, ...args]);
    };
  const initial: Record<string, unknown> = {
    bridge: options.bridge,
    info: appInfo,
    hosts: options.hosts ?? [thisMac, sshHost("studio", "Studio")],
    section,
    onSection: record("onSection"),
    onClose: record("onClose"),
    covered: false,
    fontSize: 13,
    onFontCommand: record("onFontCommand"),
    onAddMachine: record("onAddMachine"),
    onEditMachine: record("onEditMachine"),
    onRemoveMachine: (hostId: string) => {
      events.push(["onRemoveMachine", hostId]);
      return Promise.resolve();
    },
    updateReady: [],
    onOpenPane: record("onOpenPane"),
    ...options.extra,
  };
  if (typeof (globalThis as { window?: unknown }).window === "undefined") vi.stubGlobal("window", { addEventListener: () => undefined, removeEventListener: () => undefined });
  const view = new HookHost<object>(settingsModule!.SettingsPage as (props: object) => unknown, initial);
  view.render();
  const run: SettingsRun = {
    view,
    props: initial,
    rerender(next) {
      run.props = { ...run.props, ...next };
      view.render(run.props);
    },
    find: (predicate) => elements(view.tree).find(predicate),
    all: (predicate) => elements(view.tree).filter(predicate),
    part: (name, where = () => true) =>
      elements(view.tree).find((element) => typeof element.type === "function" && (element.type as { name: string }).name === name && where(element.props)),
  };
  return run;
}

export const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};

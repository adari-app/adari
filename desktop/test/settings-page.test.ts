// What the Settings page does in the window. Text size is the
// View menu's (both ways); Machines' Add and Edit open the sidebar's
// AddHostDialog and Remove is its removeHost, after a confirmation; Updates
// shows the version and build commit and runs the menu's Check for Updates…;
// About shows the privacy line. Machines has one row each with
// its actions in the right-hand column; Updates' Agent CLIs grouped by CLI;
// About's one Open-source licenses row (no credits list).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  const hooks = { ...fakeReact, useLayoutEffect: fakeReact.useEffect };
  return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});
vi.mock("electron", () => ({ ipcMain: { handle: () => undefined, on: () => undefined } }));

import type { HostView } from "../src/shared/ipc-contract";
import { privacyBase, privacyLine } from "../src/shared/settings";
import { initialUpdateView, onAvailable, onCheckFailed, onDownloaded, onDownloadProgress, onDownloadStart, onNotAvailable, onUpdatesOff, type UpdatesOffReason } from "../src/shared/updates";
import { elements } from "./support/fake-hooks";
import { host, one, page, settle } from "./support/manage-page";
import { appInfo, flush, loadSettings, mountSettings, settingsBridge, sshHost, thisMac } from "./support/settings-page";

const { escapeOwners, keyOwners } = await import("../src/renderer/components/escape-owners");
const { uploadsStore } = await import("../src/renderer/settings/uploads-store");
await loadSettings();

let cleanups: (() => void)[] = [];

beforeEach(() => {
  escapeOwners.reset();
  keyOwners.reset();
  uploadsStore.reset();
});

afterEach(async () => {
  for (let i = 0; i < 6; i += 1) await settle();
  for (const run of cleanups.splice(0)) run();
  vi.unstubAllGlobals();
});

async function open() {
  const p = await page();
  cleanups.push(p.unmount);
  p.select("w1:p1");
  (p.sidebar()["onOpenSettings"] as () => void)();
  return p;
}

type Page = Awaited<ReturnType<typeof open>>;
const settingsProps = (p: Page) => one(p.app.tree, "SettingsPage")!.props as Record<string, unknown>;
/** The page's bridge (the window's), to give it the calls a test needs. */
const bridgeOf = () => (globalThis as unknown as { window: { herdrDesktop: Record<string, unknown> } }).window.herdrDesktop;
const words = (tree: unknown): string[] =>
  elements(tree)
    .map((element) => element.props["children"])
    .filter((children): children is string => typeof children === "string");

describe("text size follows the View menu both ways", () => {
  it("the page's stepper changes the terminal's size (the same setting as View › Bigger Text)", async () => {
    const p = await open();
    expect(settingsProps(p)["fontSize"]).toBe(13);
    (settingsProps(p)["onFontCommand"] as (command: string) => void)("font-bigger");
    expect(settingsProps(p)["fontSize"]).toBe(14);
    expect(p.main()?.["fontSize"]).toBe(14);
    (settingsProps(p)["onFontCommand"] as (command: string) => void)("font-reset");
    expect(p.main()?.["fontSize"]).toBe(13);
  });

  it("View › Bigger Text and Smaller Text change what the page shows", async () => {
    const p = await open();
    p.view("font-bigger");
    p.view("font-bigger");
    expect(settingsProps(p)["fontSize"]).toBe(15);
    p.view("font-smaller");
    expect(settingsProps(p)["fontSize"]).toBe(14);
  });

  it("the stepper shows the size, and its buttons send the View menu's commands", () => {
    const events: unknown[][] = [];
    const { bridge } = settingsBridge();
    const run = mountSettings("appearance", { bridge, events, extra: { fontSize: 15 } });
    expect(run.find((element) => element.props["data-font-size"] !== undefined)!.props["data-font-size"]).toBe(15);
    for (const label of ["Bigger Text", "Smaller Text"]) (run.find((element) => element.props["aria-label"] === label)!.props["onClick"] as () => void)();
    const reset = run.find((element) => element.props["children"] === "Actual Size")!;
    (reset.props["onClick"] as () => void)();
    expect(events).toEqual([
      ["onFontCommand", "font-bigger"],
      ["onFontCommand", "font-smaller"],
      ["onFontCommand", "font-reset"],
    ]);
    run.view.unmount();
  });
});

describe("Machines go through the sidebar's dialogs and calls", () => {
  it("Add a machine… opens AddHostDialog, empty", async () => {
    const p = await open();
    (settingsProps(p)["onAddMachine"] as () => void)();
    expect(one(p.app.tree, "AddHostDialog")?.props["editing"]).toBeNull();
    // The dialog over the page has Esc (the page is covered).
    expect(settingsProps(p)["covered"]).toBe(true);
  });

  it("Edit… opens AddHostDialog with the machine's settings (bridge.hostSettings)", async () => {
    const p = await open();
    const editing = { id: "host", name: "Mac mini", host: "mini.local", port: 22, username: "me", auth: "agent", keyPath: "", herdrSession: "", secretSaved: false };
    const asked: string[] = [];
    bridgeOf()["hostSettings"] = (hostId: string) => (asked.push(hostId), Promise.resolve(editing));
    (settingsProps(p)["onEditMachine"] as (hostId: string) => void)("host");
    await flush();
    expect(asked).toEqual(["host"]);
    expect(one(p.app.tree, "AddHostDialog")?.props["editing"]).toEqual(editing);
  });

  it("Remove… is bridge.removeHost; the machines it answers show", async () => {
    const p = await open();
    const removed: string[] = [];
    bridgeOf()["removeHost"] = (hostId: string) => (removed.push(hostId), Promise.resolve([] as HostView[]));
    await (settingsProps(p)["onRemoveMachine"] as (hostId: string) => Promise<void>)("host");
    await flush();
    expect(removed).toEqual(["host"]);
    expect(settingsProps(p)["hosts"]).toEqual([]);
  });

  it("a refused Remove says why", async () => {
    const p = await open();
    bridgeOf()["removeHost"] = () => Promise.reject(new Error("Error invoking remote method 'herdr:hosts-remove': Error: that machine is busy"));
    await (settingsProps(p)["onRemoveMachine"] as (hostId: string) => Promise<void>)("host");
    await flush();
    expect(p.toast()).toBe("Not removed: that machine is busy");
    expect(settingsProps(p)["hosts"]).toEqual([host]);
  });

  it("on the page: Edit… and Add for an SSH machine; Remove… asks first; This Mac has neither", async () => {
    const events: unknown[][] = [];
    const { bridge } = settingsBridge();
    const run = mountSettings("machines", { bridge, events, hosts: [thisMac, sshHost("studio", "Studio")] });
    const row = (id: string) => run.find((element) => element.props["data-machine"] === id)!;
    const button = (id: string, label: string) => elements(row(id)).find((element) => element.props["children"] === label);
    expect(button("local", "Edit…")).toBeUndefined();
    expect(button("local", "Remove…")).toBeUndefined();
    expect(words(row("local"))).toContain("Built in");

    (button("studio", "Edit…")!.props["onClick"] as () => void)();
    (run.find((element) => element.props["title"] === "Add a machine (SSH)")!.props["onClick"] as () => void)();
    expect(events).toEqual([["onEditMachine", "studio"], ["onAddMachine"]]);

    (button("studio", "Remove…")!.props["onClick"] as () => void)();
    expect(events.some((event) => event[0] === "onRemoveMachine")).toBe(false);
    const confirm = run.find((element) => element.props["data-confirm"] === "remove")!;
    (confirm.props["onClick"] as () => void)();
    await flush();
    expect(events.at(-1)).toEqual(["onRemoveMachine", "studio"]);
    run.view.unmount();
  });
  // One row per machine, its actions in the one right-hand
  // column (This Mac's Built in where the others' Edit… and Remove… are); the upload lines left Machines.
  it("one row per machine: name, status, address; actions (or Built in) in the right-hand column; no uploads here", async () => {
    const { bridge, fake } = settingsBridge();
    const run = mountSettings("machines", { bridge, hosts: [thisMac, sshHost("studio", "Studio"), sshHost("off", "Off", { state: "offline" } as Partial<HostView>)] });
    await flush();
    const row = (id: string) => run.find((element) => element.props["data-machine"] === id)!;
    const column = (id: string) => elements(row(id)).find((element) => element.props["className"] === "set-rc")!;
    expect(words(column("local"))).toEqual(["Built in"]);
    expect(elements(column("studio")).filter((element) => element.type === "button").map((element) => element.props["children"])).toEqual(["Edit…", "Remove…"]);
    expect(words(row("studio"))).toEqual(expect.arrayContaining(["Studio", "Connected", "me@studio:22 · macOS"]));
    expect(words(row("off"))).toContain("Offline");
    expect(words(row("local"))).toEqual(expect.arrayContaining(["This Mac", "This Mac, no SSH"]));
    expect(run.all((element) => element.props["data-machine"] !== undefined)).toHaveLength(3);
    expect(run.part("UploadsLine")).toBeUndefined();
    // (The section list on the left still names Uploaded images; the page's column does not.)
    expect(words(run.find((element) => element.props["className"] === "set-col")).some((word) => /Uploaded images|Delete now/u.test(word))).toBe(false);
    expect(fake.calls.filter((call) => call[0] === "uploadsCount")).toEqual([]);
    run.view.unmount();
  });
});

describe("Updates and About", () => {
  afterEach(() => vi.unstubAllGlobals());

  // Adari's own updates (the main process's state, src/main/updates.ts).
  const at = Date.UTC(2026, 10, 9, 14, 2, 0);
  const fresh = initialUpdateView("0.1.0", null, true);
  const updateLines = (run: ReturnType<typeof mountSettings>) => {
    const by = (name: string) => run.find((element) => element.props[name] !== undefined);
    const actions = elements(by("data-update-actions"))
      .filter((element) => element.type === "button")
      .map((element) => ({ label: [element.props["children"]].flat().join(""), disabled: element.props["disabled"] === true }));
    return {
      status: by("data-update-status")?.props["children"],
      last: by("data-update-last")?.props["children"] ?? null,
      foot: by("data-update-foot")?.props["children"],
      actions,
    };
  };

  it("shows the version and build commit, the state, and Check for Updates… runs the main process's check and says its outcome", async () => {
    const { bridge, fake } = settingsBridge();
    const run = mountSettings("updates", { bridge, extra: { update: fresh } });
    expect(words(run.view.tree)).toContain("0.1.0 · abc12345");
    expect(updateLines(run)).toEqual({
      status: "Not checked yet.",
      last: "Not checked yet. The first check is about 15 seconds after Adari opens.",
      foot: "About 15 seconds after Adari opens, then every 4 minutes. Nothing downloads or installs until you click.",
      actions: [{ label: "Check for Updates…", disabled: false }],
    });
    const check = run.find((element) => element.props["children"] === "Check for Updates…")!;
    (check.props["onClick"] as () => void)();
    await flush();
    expect(fake.calls).toContainEqual(["checkForUpdates"]);
    expect(updateLines(run).last).toBe("Adari 0.1.0 is the latest version.");
    // A later check (an automatic one) replaces the outcome with its own line.
    run.rerender({ update: onNotAvailable(fresh, Date.now() + 240_000) });
    expect(updateLines(run).last).toMatch(/^Last checked /u);
    run.view.unmount();
  });

  it("with a newer version: Download; downloaded: Restart…; each is the pill's action, only on a click", () => {
    const events: unknown[][] = [];
    const { bridge, fake } = settingsBridge();
    const available = onAvailable(fresh, "0.1.1", at);
    const run = mountSettings("updates", { bridge, events, extra: { update: available, onUpdateAction: (action: string) => events.push(["onUpdateAction", action]) } });
    expect(updateLines(run).status).toBe("Adari 0.1.1 is available.");
    expect(updateLines(run).actions).toEqual([
      { label: "Download", disabled: false },
      { label: "Check for Updates…", disabled: false },
    ]);
    expect(events).toEqual([]);
    (run.find((element) => element.props["children"] === "Download")!.props["onClick"] as () => void)();
    expect(events).toEqual([["onUpdateAction", "download"]]);
    run.rerender({ update: onDownloadProgress(onDownloadStart(available), 42) });
    expect(updateLines(run).actions).toEqual([
      { label: "Downloading… 42%", disabled: true },
      { label: "Check for Updates…", disabled: true },
    ]);
    run.rerender({ update: onDownloaded(onDownloadStart(available), "0.1.1") });
    expect(updateLines(run).status).toBe("Adari 0.1.1 is downloaded. Restart Adari to install it.");
    (run.find((element) => element.props["children"] === "Restart…")!.props["onClick"] as () => void)();
    expect(events).toEqual([
      ["onUpdateAction", "download"],
      ["onUpdateAction", "install"],
    ]);
    expect(fake.calls.filter((call) => call[0] === "checkForUpdates")).toEqual([]);
    run.view.unmount();
  });

  it("Check for updates automatically: on by default; the switch sets it in the main process", () => {
    const { bridge: base, fake } = settingsBridge();
    const bridge = {
      ...base,
      setAutomaticUpdates: (on: boolean) => {
        fake.calls.push(["setAutomaticUpdates", on]);
        return Promise.resolve({ ...fresh, automatic: on });
      },
    };
    const run = mountSettings("updates", { bridge, extra: { update: fresh } });
    expect(words(run.view.tree)).toContain("Check for updates automatically");
    const toggle = run.part("Switch", (props) => props["label"] === "Check for updates automatically")!;
    expect(toggle.props["on"]).toBe(true);
    (toggle.props["onChange"] as (on: boolean) => void)(false);
    expect(fake.calls).toContainEqual(["setAutomaticUpdates", false]);
    run.rerender({ update: { ...fresh, automatic: false } });
    expect(updateLines(run).foot).toBe("Adari checks only when you ask (Check for Updates…).");
    expect(updateLines(run).actions).toEqual([{ label: "Check for Updates…", disabled: false }]);
    run.view.unmount();
  });

  it("a failed automatic check shows only here, as the last check's line", () => {
    const { bridge } = settingsBridge();
    const run = mountSettings("updates", { bridge, extra: { update: onCheckFailed(fresh, "No release is published on GitHub yet.", Date.now()) } });
    expect(updateLines(run).status).toBe("Not checked yet.");
    expect(updateLines(run).last).toMatch(/^Last check today at .+ failed\. No release is published on GitHub yet\.$/u);
    run.view.unmount();
  });

  it("in a build that does not update itself: the signed download does, and why; Check for Updates… greyed; no switch", () => {
    const { bridge } = settingsBridge();
    const run = mountSettings("updates", { bridge, extra: { info: { ...appInfo, updates: { enabled: false, feedUrl: "" } }, update: initialUpdateView("0.1.0", "unsigned", true) } });
    expect(updateLines(run)).toEqual({
      status: "Updates come with the signed download.",
      last: null,
      foot: "This build is not signed with a Developer ID, so it does not check for updates or install them. The signed download from GitHub Releases updates itself.",
      actions: [{ label: "Check for Updates…", disabled: true }],
    });
    expect(run.part("Switch", (props) => props["label"] === "Check for updates automatically")).toBeUndefined();
    run.rerender({ update: initialUpdateView("0.1.0", "development", true) });
    expect(updateLines(run).foot).toBe("A development run never checks for updates.");
    // A signed package opened with a demo, capture or probe flag.
    run.rerender({ update: initialUpdateView("0.1.0", "flags", true) });
    expect(updateLines(run).foot).toBe("Adari was opened with a demo, capture or probe flag, so it does not check for updates until it is opened without one.");
    run.view.unmount();
  });

  it("before the state arrives, from the build's info alone", () => {
    const { bridge } = settingsBridge();
    const run = mountSettings("updates", { bridge, extra: { info: { ...appInfo, updates: { enabled: false, feedUrl: "" } } } });
    expect(updateLines(run).status).toBe("Updates come with the signed download.");
    expect(updateLines(run).actions).toEqual([{ label: "Check for Updates…", disabled: true }]);
    run.view.unmount();
  });

  it("lists the agents whose update is ready; one opens its pane", () => {
    const events: unknown[][] = [];
    const { bridge } = settingsBridge();
    const run = mountSettings("updates", { bridge, events, extra: { updateReady: [{ hostId: "studio", paneId: "w1:p2", name: "claude 2", place: "app · Studio" }] } });
    const entry = run.find((element) => element.props["className"] === "set-upd")!;
    (entry.props["onClick"] as () => void)();
    expect(events).toEqual([["onOpenPane", "studio", "w1:p2"]]);
    run.view.unmount();
  });

  // The privacy line is true for the running build, from one formatter.
  it("About in a build that never checks (unsigned, development, demo or capture, a launch flag, off the Mac, a refused signature): no word of GitHub", () => {
    const privacy = (run: ReturnType<typeof mountSettings>) => run.find((element) => element.props["className"] === "set-privacy")!.props["children"];
    const { bridge } = settingsBridge();
    const off = (reason: UpdatesOffReason) => initialUpdateView("0.1.0", reason, true);
    const run = mountSettings("about", { bridge, extra: { info: { ...appInfo, updates: { enabled: false, feedUrl: "" } }, update: off("unsigned") } });
    for (const update of [off("unsigned"), off("development"), off("demo"), off("flags"), off("platform"), onUpdatesOff(onAvailable(fresh, "0.1.1", at), "unsigned")]) {
      run.rerender({ update });
      expect(privacy(run)).toBe("Adari talks to your Macs over SSH. No relay, no account, no telemetry.");
      expect(privacy(run)).toBe(privacyBase);
    }
    run.view.unmount();
  });

  it("About in a build that checks: GitHub, and the switch (or that it checks only when asked)", () => {
    const privacy = (run: ReturnType<typeof mountSettings>) => run.find((element) => element.props["className"] === "set-privacy")!.props["children"];
    const { bridge } = settingsBridge();
    const run = mountSettings("about", { bridge, extra: { update: fresh } });
    expect(privacy(run)).toBe("Adari talks to your Macs over SSH. No relay, no account, no telemetry. It checks GitHub for updates, which you can turn off.");
    run.rerender({ update: onAvailable(fresh, "0.1.1", at) });
    expect(privacy(run)).toBe("Adari talks to your Macs over SSH. No relay, no account, no telemetry. It checks GitHub for updates, which you can turn off.");
    run.rerender({ update: { ...fresh, automatic: false } });
    expect(privacy(run)).toBe("Adari talks to your Macs over SSH. No relay, no account, no telemetry. It checks GitHub for updates only when you ask.");
    run.view.unmount();
  });

  // About is the version, the privacy line
  // and one Open-source licenses row, whose View licenses opens the notices file the app ships (no list, no fetch).
  it("About: the version, the privacy line, and Open-source licenses (View licenses opens the shipped file); no list in the page", async () => {
    const fetched: string[] = [];
    vi.stubGlobal("fetch", (url: string) => (fetched.push(url), Promise.reject(new Error("no fetch"))));
    const { bridge: base } = settingsBridge();
    const opened: string[] = [];
    let answer: string | null = null;
    const bridge = { ...base, openLicenses: () => (opened.push("openLicenses"), Promise.resolve(answer)) };
    const run = mountSettings("about", { bridge });
    await flush();
    expect(fetched).toEqual([]);
    // No update state (an older bridge, or before it arrives): only what is true of every build.
    expect(words(run.view.tree)).toContain(privacyLine(null));
    expect(words(run.view.tree)).toContain("0.1.0 · abc12345");
    const titles = run.all((element) => element.props["className"] === "set-k").map((element) => element.props["children"]);
    expect(titles).toEqual(["Version", "Privacy", "Open-source licenses"]);
    expect(run.find((element) => element.props["data-components"] !== undefined)).toBeUndefined();
    expect(run.all((element) => element.type === "pre" || element.type === "details")).toEqual([]);
    const view = () => run.find((element) => element.type === "button" && [element.props["children"]].flat().includes("View licenses"))!;
    expect(view().props["disabled"]).toBe(false);
    (view().props["onClick"] as () => void)();
    await flush();
    expect(opened).toEqual(["openLicenses"]);
    expect(run.find((element) => element.props["className"] === "set-bad")).toBeUndefined();
    // Not opened: why, under the row.
    answer = "THIRD_PARTY_NOTICES.md is not in this build.";
    (view().props["onClick"] as () => void)();
    await flush();
    expect(run.find((element) => element.props["className"] === "set-bad")?.props["children"]).toBe("THIRD_PARTY_NOTICES.md is not in this build.");
    run.view.unmount();
    // An older bridge with no opener: the button greyed.
    const old = mountSettings("about", { bridge: base });
    expect(old.find((element) => element.type === "button" && [element.props["children"]].flat().includes("View licenses"))!.props["disabled"]).toBe(true);
    old.view.unmount();
  });

  // Agent CLIs, grouped by CLI, each with its own words and its Resume; a CLI with no readable notice not listed.
  it("Agent CLIs: the marked agents grouped by CLI (Claude Code, then Codex), each CLI with its instruction and Resume", () => {
    const events: unknown[][] = [];
    const { bridge } = settingsBridge();
    const run = mountSettings("updates", {
      bridge,
      events,
      extra: {
        updateReady: [
          { hostId: "studio", paneId: "w1:p2", name: "claude 2", place: "app · Studio", kind: "claude" },
          { hostId: "box", paneId: "w2:p1", name: "trendline", place: "herdr · Box", kind: "codex" },
          { hostId: "studio", paneId: "w1:p5", name: "claude 5", place: "api · Studio" },
        ],
      },
    });
    const group = (kind: string) => run.find((element) => element.props["data-update-kind"] === kind)!;
    expect(run.all((element) => element.props["data-update-kind"] !== undefined).map((element) => element.props["data-update-kind"])).toEqual(["claude", "codex"]);
    const agents = (kind: string) => elements(group(kind)).filter((element) => element.props["className"] === "set-upd").map((element) => elements(element).find((part) => part.props["className"] === "set-mn")!.props["children"]);
    expect(agents("claude")).toEqual(["claude 2", "claude 5"]);
    expect(agents("codex")).toEqual(["trendline"]);
    expect(words(group("claude"))).toContain("Claude Code update installed. /exit when it’s idle, then Resume.");
    expect(words(group("codex"))).toContain("Codex has a newer version. Update it on the machine with the command Codex shows, then /exit when it’s idle and Resume.");
    expect(words(group("claude"))).toContain("claude --resume <session>");
    expect(words(group("codex"))).toContain("codex resume <session> --no-daemon"); // what restart types
    expect(words(group("codex"))).toContain("1 agent");
    expect(words(run.view.tree)).toContain("Not listed: Grok Build and Cursor Agent. They print no update notice Adari can read.");
    (elements(group("codex")).find((element) => element.props["className"] === "set-upd")!.props["onClick"] as () => void)();
    expect(events).toEqual([["onOpenPane", "box", "w2:p1"]]);
    // The marks in the rows say each CLI's own words.
    const marks = elements(group("codex")).filter((element) => typeof element.type === "function" && (element.type as { name: string }).name === "UpdateMark");
    expect(marks.map((element) => element.props["kind"])).toEqual(["codex"]);
    run.rerender({ updateReady: [] });
    expect(words(group("claude"))).toContain("None now");
    expect(words(group("codex"))).toContain("None now");
    run.view.unmount();
  });
});

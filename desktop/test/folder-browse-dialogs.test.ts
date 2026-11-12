// The folder field's list in New workspace and New agent, on
// a fake machine (macOS and Linux paths) behind fake folder calls, with fake
// timers for the debounce. Typing a / or ~ path lists that folder's folders
// (one request per folder, after the last key), filtered by the last segment,
// hidden ones only for a "." filter; ↑ ↓ move, Tab goes into the highlighted
// folder and lists inside it, Return or a click picks it, Esc closes the list
// and a second Esc the dialog; a missing, file or unreadable folder, an
// offline machine and a failed call each say so and the field stays
// typeable; at most 200 shown; a late answer for a folder no longer typed is
// dropped. Choose… only on This Mac (the call mocked). New
// workspace's machine picker first and its recent folders as rows of name
// and whole path; New agent's "Starts in … · Change…".

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  const hooks = { ...fakeReact, useLayoutEffect: fakeReact.useEffect };
  return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});
vi.mock("electron", () => ({ ipcMain: { handle: () => undefined, on: () => undefined } }));

import { browseFolder } from "../src/main/folder-browse";
import { DemoFolderTree } from "../src/main/demo/demo-folders";
import { browseDebounceMs, type FolderListing } from "../src/shared/folder-browse";
import type { NewAgentPlace } from "../src/shared/new-agent";
import type { NewWorkspaceHost, NewWorkspaceMachine } from "../src/shared/new-workspace";
import { absentStartCommands } from "../src/shared/start-commands";
import type { FolderCalls } from "../src/renderer/components/folder-browse";
import { HookHost, elements } from "./support/fake-hooks";

const { NewWorkspaceDialog } = await import("../src/renderer/components/NewWorkspaceDialog");
const { NewAgentDialog } = await import("../src/renderer/components/NewAgentDialog");
const { escapeOwners } = await import("../src/renderer/components/escape-owners");
const { startCommandsStore } = await import("../src/renderer/components/resume");
const { handoffStore } = await import("../src/renderer/handoff/handoff-state");

type Element = { type: unknown; props: Record<string, unknown> };
const text = (node: unknown): string => {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  if (typeof node === "object" && node !== null && "props" in node) return text((node as Element).props["children"]);
  return "";
};
const byLabel = (tree: unknown, label: string) => elements(tree).find((e) => e.props["aria-label"] === label) as Element | undefined;

function machineTree(platform: "macOS" | "Linux"): DemoFolderTree {
  const home = platform === "macOS" ? "/Users/r" : "/home/r";
  const tree = new DemoFolderTree(home);
  for (const name of ["Code", "Desktop", "Documents", ".config"]) tree.addFolder(`${home}/${name}`);
  for (const name of ["kite", "kiosk", "app"]) tree.addFolder(`${home}/Code/${name}`);
  tree.addFolder(`${home}/Code/kite/src`);
  tree.addFile(`${home}/notes.txt`);
  tree.addFolder(`${home}/private`, true);
  for (let i = 0; i < 230; i += 1) tree.addFolder(`${home}/many/f${String(i).padStart(3, "0")}`);
  return tree;
}

/** Folder calls over a fake machine: every request recorded; `hold` keeps answers until released. */
function fakeCalls(tree: DemoFolderTree, options: { local?: boolean; picked?: string | null; offline?: boolean; fail?: string } = {}) {
  const asked: string[] = [];
  const picks: string[] = [];
  const held: (() => void)[] = [];
  let hold = false;
  const calls: FolderCalls = {
    browse: (hostId, directory) => {
      asked.push(`${hostId} ${directory}`);
      if (options.fail !== undefined) return Promise.reject(new Error(`Error invoking remote method 'herdr:folder-browse': Error: ${options.fail}`));
      const answer = (): Promise<FolderListing> => (options.offline === true ? Promise.resolve({ type: "offline" }) : browseFolder(tree, directory));
      if (!hold) return answer();
      return new Promise((resolve) => held.push(() => void answer().then(resolve)));
    },
    pick: async (hostId, typed) => (picks.push(`${hostId} ${typed}`), options.picked ?? null),
  };
  return {
    calls,
    asked,
    picks,
    hold: () => (hold = true),
    release: (index: number) => held[index]!(),
  };
}

const binding = { connection: 3, incarnation: 1, epoch: 7 };
const mini: NewWorkspaceMachine = { hostId: "mini", hostName: "Mac mini", suggestions: ["/Users/r/Code/app", "/Users/demo/code/aurora-web"], binding };
const box: NewWorkspaceMachine = { hostId: "box", hostName: "build-box", suggestions: ["/home/r/Code/kite"], binding: { connection: 4, incarnation: 2, epoch: 1 } };
const here: NewWorkspaceMachine = { hostId: "this-mac", hostName: "This Mac", suggestions: [], binding: { connection: 1, incarnation: 1, epoch: 1 }, local: true };
const view = (machine: NewWorkspaceMachine, state: NewWorkspaceHost["state"] = "connected"): NewWorkspaceHost => ({
  id: machine.hostId,
  name: machine.hostName,
  state,
  topology: state === "connected" ? ({ workspaces: [], tabs: [], panes: [] } as never) : null,
  ...machine.binding,
});

function keyEvent(key: string, extra: Record<string, unknown> = {}) {
  let prevented = false;
  return {
    event: { key, shiftKey: false, target: { tagName: "INPUT" }, nativeEvent: { isComposing: false }, preventDefault: () => (prevented = true), ...extra },
    prevented: () => prevented,
  };
}

/** What a dialog shows and the hands on it: type, press, click. */
function handsOn(host: { readonly tree: unknown }) {
  const root = () => elements(host.tree).find((e) => e.props["role"] === "dialog")!;
  return {
    type: (value: string) => (byLabel(host.tree, "Folder")!.props["onChange"] as (event: unknown) => void)({ target: { value } }),
    press: (key: string, extra?: Record<string, unknown>) => {
      const k = keyEvent(key, extra);
      (root().props["onKeyDown"] as (event: unknown) => void)(k.event);
      return k.prevented();
    },
    folder: () => byLabel(host.tree, "Folder")?.props["value"],
    open: () => elements(host.tree).some((e) => e.props["className"] === "fb"),
    shown: () => elements(host.tree).filter((e) => typeof e.props["data-folder"] === "string" && e.props["role"] === "option").map((e) => e.props["data-folder"]),
    highlighted: () => elements(host.tree).find((e) => e.props["className"] === "fb-i on")?.props["data-folder"],
    lines: () => elements(host.tree).filter((e) => e.props["className"] === "fb-line" || e.props["className"] === "fb-keys").map((e) => text(e.props["children"])),
    click: (name: string) => (elements(host.tree).find((e) => e.props["data-folder"] === name && e.props["role"] === "option")!.props["onClick"] as () => void)(),
    blur: () => (byLabel(host.tree, "Folder")!.props["onBlur"] as () => void)(),
    choose: () => byLabel(host.tree, "Choose a folder on this Mac"),
    note: () => text(elements(host.tree).find((e) => e.props["role"] === "status")),
  };
}

function workspaceDialog(calls: FolderCalls | null, overrides: Record<string, unknown> = {}) {
  const creates: unknown[] = [];
  let closed = 0;
  const machines = (overrides["machines"] as NewWorkspaceMachine[] | undefined) ?? [mini, box, here];
  const host = new HookHost(NewWorkspaceDialog as (props: object) => unknown, {
    machines,
    hosts: machines.map((machine) => view(machine)),
    wanted: "mini",
    folders: calls,
    create: (_machine: unknown, request: unknown) => (creates.push(request), new Promise(() => undefined)),
    onCreated: () => undefined,
    onClose: () => (closed += 1),
    ...overrides,
  });
  host.render();
  return { host, ...handsOn(host), creates, closed: () => closed };
}

const settle = async (ms = browseDebounceMs) => {
  await vi.advanceTimersByTimeAsync(ms);
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  escapeOwners.reset();
  startCommandsStore.clear();
  handoffStore.reset();
  vi.unstubAllGlobals();
});

describe.each([
  ["macOS", "mini", "/Users/r"],
  ["Linux", "box", "/home/r"],
] as const)("New workspace's folder list on a %s machine", (platform, hostId, home) => {
  const open = (calls: FolderCalls) => workspaceDialog(calls, { wanted: hostId });

  it("typing ~/ lists the home's folders after the last key: one request, folders only, hidden ones left out", async () => {
    const fake = fakeCalls(machineTree(platform));
    const d = open(fake.calls);
    expect(d.open()).toBe(false);
    d.type("~");
    d.type("~/");
    expect(fake.asked).toEqual([]);
    expect(d.lines()).toEqual(["Listing folders…"]);
    await settle();
    expect(fake.asked).toEqual([`${hostId} ~/`]);
    expect(d.shown()).toEqual(["Code", "Desktop", "Documents", "many", "private"]);
    expect(d.highlighted()).toBe("Code");
    expect(d.lines()).toEqual(["↑ ↓ move · Tab opens · ↩ picks · esc closes"]);
  });

  it("the last segment filters without asking again; a . shows the hidden ones; a whole path lists that folder", async () => {
    const fake = fakeCalls(machineTree(platform));
    const d = open(fake.calls);
    d.type("~/D");
    await settle();
    d.type("~/Do");
    await settle();
    expect(d.shown()).toEqual(["Documents"]);
    d.type("~/.");
    await settle();
    expect(d.shown()).toEqual([".config"]);
    expect(fake.asked).toEqual([`${hostId} ~/`]);
    d.type(`${home}/Code/k`);
    await settle();
    expect(d.shown()).toEqual(["kiosk", "kite"]);
    expect(fake.asked).toEqual([`${hostId} ~/`, `${hostId} ${home}/Code/`]);
  });

  it("keys typed quickly ask once, for the folder typed last (the debounce)", async () => {
    const fake = fakeCalls(machineTree(platform));
    const d = open(fake.calls);
    d.type("~/C");
    await settle(browseDebounceMs - 50);
    d.type("~/Code/");
    await settle(browseDebounceMs - 50);
    d.type("~/Code/k");
    await settle();
    expect(fake.asked).toEqual([`${hostId} ~/Code/`]);
    expect(d.shown()).toEqual(["kiosk", "kite"]);
  });

  it("↑ ↓ move, Tab goes into the highlighted folder and lists inside it, Return picks it (no create), then Return creates", async () => {
    const fake = fakeCalls(machineTree(platform));
    const d = open(fake.calls);
    d.type("~/Code/");
    await settle();
    expect(d.shown()).toEqual(["app", "kiosk", "kite"]);
    expect(d.press("ArrowDown")).toBe(true);
    d.press("ArrowDown");
    d.press("ArrowDown");
    expect(d.highlighted()).toBe("kite");
    d.press("ArrowUp");
    expect(d.highlighted()).toBe("kiosk");
    d.press("ArrowDown");
    expect(d.press("Tab")).toBe(true);
    expect(d.folder()).toBe("~/Code/kite/");
    await settle();
    expect(fake.asked.at(-1)).toBe(`${hostId} ~/Code/kite/`);
    expect(d.shown()).toEqual(["src"]);
    d.press("Enter");
    expect(d.folder()).toBe("~/Code/kite/src");
    expect(d.open()).toBe(false);
    expect(d.creates).toEqual([]);
    d.press("Enter");
    expect(d.creates).toEqual([expect.objectContaining({ folder: "~/Code/kite/src", name: "src" })]);
  });

  it("a click picks a folder; the name follows it", async () => {
    const fake = fakeCalls(machineTree(platform));
    const d = open(fake.calls);
    d.type("~/Code/");
    await settle();
    d.click("app");
    expect(d.folder()).toBe("~/Code/app");
    expect(byLabel(d.host.tree, "Name")!.props["value"]).toBe("app");
    expect(d.open()).toBe(false);
  });

  it("Esc closes the list and keeps the dialog; a second Esc closes the dialog", async () => {
    const fake = fakeCalls(machineTree(platform));
    const d = open(fake.calls);
    d.type("~/");
    await settle();
    d.press("Escape");
    expect(d.open()).toBe(false);
    expect(d.closed()).toBe(0);
    expect(d.folder()).toBe("~/");
    d.press("Escape");
    expect(d.closed()).toBe(1);
  });

  it("a missing folder, a file and an unreadable folder each say so; the field stays typeable", async () => {
    const fake = fakeCalls(machineTree(platform));
    const d = open(fake.calls);
    const name = hostId === "mini" ? "Mac mini" : "build-box";
    d.type("~/nope/");
    await settle();
    expect(d.lines()).toEqual([`There is no ~/nope on ${name}`]);
    expect(byLabel(d.host.tree, "Folder")!.props["disabled"]).toBe(false);
    d.type("~/notes.txt/");
    await settle();
    expect(d.lines()).toEqual([`~/notes.txt is a file on ${name}, not a folder`]);
    d.type("~/private/");
    await settle();
    expect(d.lines()).toEqual([`${name} cannot read ~/private (permission denied)`]);
    // Return with nothing listed creates (Create's own checks apply).
    d.press("Enter");
    expect(d.creates).toEqual([expect.objectContaining({ folder: "~/private/" })]);
  });

  it("no folder matching the filter, and a folder with no folders", async () => {
    const fake = fakeCalls(machineTree(platform));
    const d = open(fake.calls);
    d.type("~/Code/zz");
    await settle();
    expect(d.lines()).toEqual(["No folder in ~/Code starts with zz"]);
    d.type("~/Code/app/");
    await settle();
    expect(d.lines()).toEqual(["No folders in ~/Code/app"]);
    expect(d.press("ArrowDown")).toBe(false);
  });

  it("at most 200 folders shown, with how many more", async () => {
    const fake = fakeCalls(machineTree(platform));
    const d = open(fake.calls);
    d.type("~/many/");
    await settle();
    expect(d.shown()).toHaveLength(200);
    expect(d.lines()).toContain("30 more; type to narrow the list");
    d.type("~/many/f22");
    expect(d.shown()).toEqual(["f220", "f221", "f222", "f223", "f224", "f225", "f226", "f227", "f228", "f229"]);
  });
});

describe("New workspace's list: offline, failures, late answers", () => {
  it("a machine the window shows offline says so, and nothing is asked", async () => {
    const fake = fakeCalls(machineTree("macOS"));
    const d = workspaceDialog(fake.calls, { hosts: [view(mini, "offline"), view(box), view(here)] });
    d.type("~/");
    await settle();
    expect(d.lines()).toEqual(["Mac mini is not answering, so its folders cannot be listed"]);
    expect(fake.asked).toEqual([]);
  });

  it("main's offline answer and a failed call are said; the field stays typeable", async () => {
    const offline = workspaceDialog(fakeCalls(machineTree("macOS"), { offline: true }).calls);
    offline.type("~/");
    await settle();
    expect(offline.lines()).toEqual(["Mac mini is not answering, so its folders cannot be listed"]);
    const failed = workspaceDialog(fakeCalls(machineTree("macOS"), { fail: "Listing a folder timed out" }).calls);
    failed.type("~/");
    await settle();
    expect(failed.lines()).toEqual(["Mac mini did not list the folder: Listing a folder timed out"]);
    expect(byLabel(failed.host.tree, "Folder")!.props["disabled"]).toBe(false);
  });

  it("an answer for a folder no longer typed is dropped", async () => {
    const fake = fakeCalls(machineTree("macOS"));
    fake.hold();
    const d = workspaceDialog(fake.calls);
    d.type("~/");
    await settle();
    d.type("~/Code/");
    await settle();
    fake.release(1);
    await settle(0);
    expect(d.shown()).toEqual(["app", "kiosk", "kite"]);
    fake.release(0);
    await settle(0);
    expect(d.shown()).toEqual(["app", "kiosk", "kite"]);
  });

  it("the list closes when the field loses focus, and on another machine; a chip or row never opens it", async () => {
    const fake = fakeCalls(machineTree("macOS"));
    const d = workspaceDialog(fake.calls);
    d.type("~/");
    await settle();
    d.blur();
    expect(d.open()).toBe(false);
    (byLabel(d.host.tree, "Folder /Users/r/Code/app")!.props["onClick"] as () => void)();
    expect(d.folder()).toBe("/Users/r/Code/app");
    expect(d.open()).toBe(false);
    d.type("~/");
    await settle();
    (byLabel(d.host.tree, "Machine")!.props["onChange"] as (event: unknown) => void)({ target: { value: "box" } });
    expect(d.open()).toBe(false);
  });

  it("with no folder calls (an older bridge) the field is plain: no list, no Choose…", async () => {
    const d = workspaceDialog(null, { wanted: "this-mac" });
    d.type("~/");
    await settle();
    expect(d.open()).toBe(false);
    expect(d.choose()).toBeUndefined();
  });
});

describe("New workspace, T3's Add project shape", () => {
  it("the machine picker first, on the machine it was opened from; the title follows it", () => {
    const d = workspaceDialog(fakeCalls(machineTree("macOS")).calls, { wanted: "box" });
    const labels = elements(d.host.tree).filter((e) => e.props["className"] === "lb").map((e) => text(e.props["children"]));
    expect(labels).toEqual(["Machine", "Folder on build-box", "Name"]);
    const picker = byLabel(d.host.tree, "Machine")!;
    expect(picker.props["value"]).toBe("box");
    expect(elements(picker.props["children"]).filter((e) => e.type === "option").map((e) => text(e.props["children"]))).toEqual(["Mac mini", "build-box", "This Mac"]);
    (picker.props["onChange"] as (event: unknown) => void)({ target: { value: "mini" } });
    expect(elements(d.host.tree).find((e) => e.props["role"] === "dialog")!.props["aria-label"]).toBe("New workspace on Mac mini");
  });

  it("recent folders as rows: the folder's name and its whole path, nothing cut to …/", () => {
    const d = workspaceDialog(fakeCalls(machineTree("macOS")).calls);
    const rows = elements(d.host.tree).filter((e) => e.props["className"] === "nw-row");
    expect(rows.map((row) => elements(row.props["children"]).map((part) => text(part.props["children"])).filter((part) => part !== ""))).toEqual([
      ["app", "/Users/r/Code/app"],
      ["aurora-web", "/Users/demo/code/aurora-web"],
    ]);
    expect(text(d.host.tree)).not.toContain("…/");
    expect(text(d.host.tree)).toContain("Recent folders on Mac mini");
    expect(elements(d.host.tree).some((e) => e.props["className"] === "na-sugg")).toBe(false);
  });

  it("Choose… only on This Mac: it opens the folder window at what is typed and fills the field", async () => {
    const remote = workspaceDialog(fakeCalls(machineTree("macOS")).calls);
    expect(remote.choose()).toBeUndefined();
    const fake = fakeCalls(machineTree("macOS"), { picked: "/Users/r/Code/kite" });
    const d = workspaceDialog(fake.calls, { wanted: "this-mac" });
    const choose = d.choose()!;
    expect(text(choose.props["children"])).toBe("Choose…");
    d.type("~/Code");
    (d.choose()!.props["onClick"] as () => void)();
    await settle(0);
    expect(fake.picks).toEqual(["this-mac ~/Code"]);
    expect(d.folder()).toBe("/Users/r/Code/kite");
    expect(byLabel(d.host.tree, "Name")!.props["value"]).toBe("kite");
    (byLabel(d.host.tree, "Machine")!.props["onChange"] as (event: unknown) => void)({ target: { value: "box" } });
    expect(d.choose()).toBeUndefined();
  });

  it("Choose… cancelled leaves the field; refused, it says why", async () => {
    const cancelled = fakeCalls(machineTree("macOS"), { picked: null });
    const d = workspaceDialog(cancelled.calls, { wanted: "this-mac" });
    d.type("/tmp/x");
    (d.choose()!.props["onClick"] as () => void)();
    await settle(0);
    expect(d.folder()).toBe("/tmp/x");
    const refused = fakeCalls(machineTree("macOS"));
    refused.calls.pick = () => Promise.reject(new Error("Error invoking remote method 'herdr:folder-pick': Error: Choosing a folder is not available here."));
    const e = workspaceDialog(refused.calls, { wanted: "this-mac" });
    (e.choose()!.props["onClick"] as () => void)();
    await settle(0);
    expect(elements(e.host.tree).find((el) => el.props["className"] === "fb-note")!.props["children"]).toBe("Choosing a folder is not available here.");
  });
});

// MARK: - New agent

const place = (overrides: Partial<NewAgentPlace> = {}): NewAgentPlace => ({
  hostId: "mini",
  hostName: "Mac mini",
  workspaceId: "w1",
  workspace: "aurora-web",
  folder: "/Users/demo/code/aurora-web",
  suggestions: ["/Users/demo/code/aurora-web", "/Users/r/Code/app"],
  ...overrides,
});

function agentDialog(calls: FolderCalls | null, places: NewAgentPlace[] = [place()], overrides: Record<string, unknown> = {}) {
  vi.stubGlobal("window", { herdrDesktop: { startCommands: () => Promise.resolve(absentStartCommands) } });
  const starts: { folder: string | null; kind: string }[] = [];
  const host = new HookHost(NewAgentDialog as (props: object) => unknown, {
    places,
    wanted: { hostId: places[0]!.hostId, workspaceId: places[0]!.workspaceId },
    storage: null,
    folders: calls,
    start: (_place: unknown, folder: string | null, kind: string) => (starts.push({ folder, kind }), new Promise(() => undefined)),
    onStarted: () => undefined,
    onClose: () => undefined,
    ...overrides,
  });
  host.render();
  const hands = handsOn(host);
  return {
    host,
    ...hands,
    starts,
    startsIn: () => elements(host.tree).find((e) => e.props["className"] === "na-in"),
    change: () => (byLabel(host.tree, "Change the folder")!.props["onClick"] as () => void)(),
    kind: () => elements(host.tree).find((e) => e.props["className"] === "na-kind on")?.props["data-kind"],
  };
}

describe("New agent: Starts in … · Change…, then the same list", () => {
  it("the workspace's folder, said; no field and no chip until Change…", () => {
    const d = agentDialog(fakeCalls(machineTree("macOS")).calls);
    const line = d.startsIn()!;
    expect(text(line.props["children"])).toBe("Starts in/Users/demo/code/aurora-web·Change…");
    expect(line.props["data-folder"]).toBe("/Users/demo/code/aurora-web");
    expect(byLabel(d.host.tree, "Folder")).toBeUndefined();
    expect(elements(d.host.tree).some((e) => e.props["className"] === "chip" || e.props["className"] === "chip on")).toBe(false);
    // Return starts in it; the footer names the folder.
    expect(d.note()).toBe("Starts Claude Code in …/demo/code/aurora-web");
    d.press("Enter", { target: { tagName: "DIV" } });
    expect(d.starts).toEqual([{ folder: "/Users/demo/code/aurora-web", kind: "claude" }]);
  });

  it("a workspace with no folder opens with the field", () => {
    const d = agentDialog(fakeCalls(machineTree("macOS")).calls, [place({ folder: null, suggestions: [] })]);
    expect(d.startsIn()).toBeUndefined();
    expect(d.folder()).toBe("");
  });

  it("Change… opens the field with the folder, the pane folders as rows; a prefilled field leaves the list closed so Return starts", async () => {
    const fake = fakeCalls(machineTree("macOS"));
    const d = agentDialog(fake.calls);
    d.change();
    expect(d.folder()).toBe("/Users/demo/code/aurora-web");
    expect(d.open()).toBe(false);
    const rows = elements(d.host.tree).filter((e) => e.props["className"] === "nw-row on" || e.props["className"] === "nw-row");
    expect(rows.map((row) => row.props["title"])).toEqual(["/Users/demo/code/aurora-web", "/Users/r/Code/app"]);
    await settle();
    expect(fake.asked).toEqual([]);
    d.press("ArrowDown");
    expect(d.kind()).toBe("codex");
  });

  it("typing lists the folders; while open the arrows move the list (not the agent) and Return picks; closed, Return starts", async () => {
    const fake = fakeCalls(machineTree("macOS"));
    const d = agentDialog(fake.calls);
    d.change();
    d.type("~/Code/");
    await settle();
    expect(d.shown()).toEqual(["app", "kiosk", "kite"]);
    d.press("ArrowDown");
    expect(d.highlighted()).toBe("kiosk");
    expect(d.kind()).toBe("claude");
    d.press("Tab");
    expect(d.folder()).toBe("~/Code/kiosk/");
    await settle();
    expect(d.lines()).toEqual(["No folders in ~/Code/kiosk"]);
    // Nothing to move or pick: the arrows are the agent's again.
    d.press("ArrowDown");
    expect(d.kind()).toBe("codex");
    d.press("Escape");
    expect(d.open()).toBe(false);
    d.press("Enter");
    expect(d.starts).toEqual([{ folder: "~/Code/kiosk/", kind: "codex" }]);
  });

  it("Choose… on This Mac's workspace only", () => {
    expect(agentDialog(fakeCalls(machineTree("macOS")).calls).choose()).toBeUndefined();
    const d = agentDialog(fakeCalls(machineTree("macOS")).calls, [place({ hostId: "this-mac", hostName: "This Mac", local: true })]);
    d.change();
    expect(text(d.choose()!.props["children"])).toBe("Choose…");
  });

  it("another workspace: its folder, said; one with none opens the field", () => {
    const d = agentDialog(fakeCalls(machineTree("macOS")).calls, [place(), place({ workspaceId: "w2", workspace: "scratch", folder: null, suggestions: [] })]);
    const picker = byLabel(d.host.tree, "Workspace")!;
    (picker.props["onChange"] as (event: unknown) => void)({ target: { value: "mini|w2" } });
    expect(d.startsIn()).toBeUndefined();
    expect(d.folder()).toBe("");
    (byLabel(d.host.tree, "Workspace")!.props["onChange"] as (event: unknown) => void)({ target: { value: "mini|w1" } });
    expect(d.startsIn()!.props["data-folder"]).toBe("/Users/demo/code/aurora-web");
  });
});

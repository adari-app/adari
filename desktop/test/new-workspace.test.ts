// New workspace, ported from
// App/CompanionSidebarNewSheet.swift's Workspace tab and HerdrKit's
// WorkspaceActions.newWorkspace / HerdrClient.createWorkspace: the name from
// the folder's last part, the machines it can make one on and their folder
// suggestions, the request the main process takes, the main process's one
// `workspace.create` on the machine and connection it was asked on (a fake
// Herdr records every line; no real connection), its refusals (offline,
// reconnected, removed) that send nothing, the dialog (Return creates, Esc
// cancels and owns the key, the name follows the folder until edited, Herdr's
// error stays in it), and its entry points: the sidebar's row, ⇧⌘N (Ctrl+Shift+N
// off the Mac) and the File menu.

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  const hooks = { ...fakeReact, useLayoutEffect: fakeReact.useEffect };
  return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});
const registered = vi.hoisted(() => ({ handles: new Map<string, (...args: unknown[]) => unknown>() }));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, listener: (...args: unknown[]) => unknown) => registered.handles.set(channel, listener),
    on: () => undefined,
  },
}));

import { HerdrClient } from "../src/main/herdr/client";
import { decodeSessionTopology } from "../src/main/herdr/wire";
import { viewMenuItems, fileMenuItems } from "../src/main/view-menu";
import { appShortcut, tileShortcut } from "../src/shared/app-keys";
import { buildDesktopSidebar } from "../src/shared/desktop-sidebar";
import type { AppCommand, HostView } from "../src/shared/ipc-contract";
import {
  defaultMachine,
  defaultWorkspaceName,
  isNewWorkspaceRequest,
  newWorkspaceMachines,
  workspaceNameSent,
  type NewWorkspaceMachine,
  type NewWorkspaceRequest,
  type NewWorkspaceResult,
} from "../src/shared/new-workspace";
import { emptyFoldState } from "../src/shared/sidebar-model";
import { absentStartCommands } from "../src/shared/start-commands";
import type { ViewCommand } from "../src/shared/view-commands";
import { HookHost, elements } from "./support/fake-hooks";

const { registerIpc } = await import("../src/main/ipc");
const { APP_ORIGIN } = await import("../src/main/protocol");
const { IPC } = await import("../src/shared/ipc-contract");
const { NewWorkspaceDialog } = await import("../src/renderer/components/NewWorkspaceDialog");
const { Sidebar } = await import("../src/renderer/components/Sidebar");
const { App } = await import("../src/renderer/App");
const { escapeOwners } = await import("../src/renderer/components/escape-owners");

type Element = { type: unknown; props: Record<string, unknown> };
const text = (node: unknown): string => {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  if (typeof node === "object" && node !== null && "props" in node) return text((node as Element).props["children"]);
  return "";
};
const byLabel = (tree: unknown, label: string) => elements(tree).find((e) => e.props["aria-label"] === label) as Element | undefined;
const byName = (tree: unknown, name: string) =>
  elements(tree).find((candidate) => typeof candidate.type === "function" && (candidate.type as { name: string }).name === name) as Element | undefined;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function topology(workspaces: { id: string; label: string; panes: { id: string; cwd?: string }[] }[]) {
  return decodeSessionTopology({
    version: "0.9.5",
    protocol: 22,
    workspaces: workspaces.map((w, i) => ({
      workspace_id: w.id,
      number: i + 1,
      label: w.label,
      focused: i === 0,
      pane_count: w.panes.length,
      tab_count: 1,
      active_tab_id: `${w.id}:t1`,
      agent_status: "idle",
    })),
    tabs: workspaces.map((w) => ({ tab_id: `${w.id}:t1`, workspace_id: w.id, number: 1, label: "", focused: false, pane_count: w.panes.length, agent_status: "idle" })),
    panes: workspaces.flatMap((w) =>
      w.panes.map((p) => ({ pane_id: p.id, terminal_id: `term-${p.id}`, workspace_id: w.id, tab_id: `${w.id}:t1`, focused: false, ...(p.cwd === undefined ? {} : { cwd: p.cwd }), agent_status: "unknown", revision: 1 })),
    ),
    agents: [],
  });
}

const mini: HostView = {
  id: "mini",
  name: "Mac mini",
  kind: "ssh",
  address: "fixture",
  platform: null,
  state: "connected",
  error: null,
  fetchedAtMs: 0,
  connection: 3,
  incarnation: 1,
  epoch: 7,
  topology: topology([
    { id: "w1", label: "app", panes: [{ id: "w1:p1", cwd: "/Users/r/code/app" }, { id: "w1:p2", cwd: "/Users/r/code/app/web" }] },
    { id: "w2", label: "ops", panes: [{ id: "w2:p1", cwd: "/Users/r/ops" }, { id: "w2:p2", cwd: "/Users/r/code/app" }] },
  ]),
};
const box: HostView = {
  ...mini,
  id: "box",
  name: "build-box",
  connection: 4,
  incarnation: 2,
  epoch: 1,
  topology: topology([{ id: "w9", label: "builds", panes: [{ id: "w9:p1", cwd: "/srv/builds" }] }]),
};

afterEach(() => {
  escapeOwners.reset();
  vi.unstubAllGlobals();
});

// MARK: - The model

describe("New workspace's model", () => {
  it("the name is the folder's last part (WorkspaceActions.defaultWorkspaceName)", () => {
    expect(defaultWorkspaceName("/Users/demo/code/harbor")).toBe("harbor");
    expect(defaultWorkspaceName("/Users/demo/code/harbor///")).toBe("harbor");
    expect(defaultWorkspaceName("~/Desktop/Studio")).toBe("Studio");
    expect(defaultWorkspaceName("~")).toBe("~");
    expect(defaultWorkspaceName("/")).toBe("/");
    expect(defaultWorkspaceName(" ")).toBe("workspace");
  });

  it("the name sent: the user's own once they typed one, else the folder's last part", () => {
    expect(workspaceNameSent("~/code/harbor", { text: "", edited: false })).toBe("harbor");
    expect(workspaceNameSent("~/code/harbor", { text: " Head Quarters ", edited: true })).toBe("Head Quarters");
    expect(workspaceNameSent("~/code/harbor", { text: "  ", edited: true })).toBe("harbor");
  });

  it("every answering machine, with the folders its panes are in as suggestions and the connection it shows", () => {
    const machines = newWorkspaceMachines([mini, { ...box, state: "offline" }]);
    expect(machines).toEqual([
      {
        hostId: "mini",
        hostName: "Mac mini",
        suggestions: ["/Users/r/code/app", "/Users/r/code/app/web", "/Users/r/ops"],
        binding: { connection: 3, incarnation: 1, epoch: 7 },
      },
    ]);
    expect(newWorkspaceMachines([mini, box]).map((m) => m.hostId)).toEqual(["mini", "box"]);
  });

  it("opens on the selected pane's machine, else the first", () => {
    const machines = newWorkspaceMachines([mini, box]);
    expect(defaultMachine(machines, "box")?.hostId).toBe("box");
    expect(defaultMachine(machines, "gone")?.hostId).toBe("mini");
    expect(defaultMachine(machines, null)?.hostId).toBe("mini");
    expect(defaultMachine([], "mini")).toBeNull();
  });

  it("the request: a folder on one line (a ~ path allowed), a name, and the connection it was asked on", () => {
    const good: NewWorkspaceRequest = { folder: "~/code/harbor", name: "harbor", binding: { connection: 3, incarnation: 1, epoch: 7 } };
    expect(isNewWorkspaceRequest(good)).toBe(true);
    expect(isNewWorkspaceRequest({ ...good, folder: "/Volumes/Data/My Projects/código" })).toBe(true);
    expect(isNewWorkspaceRequest({ ...good, binding: { ...good.binding, epoch: null } })).toBe(true);
    for (const folder of ["", "  ", "~/a\nb", "/x\u0000", "/x\u001b[2J", "/x‮y", null, 3]) expect(isNewWorkspaceRequest({ ...good, folder })).toBe(false);
    for (const name of ["", "   ", "a\nb", "x".repeat(257), null]) expect(isNewWorkspaceRequest({ ...good, name })).toBe(false);
    expect(isNewWorkspaceRequest({ ...good, binding: undefined })).toBe(false);
    expect(isNewWorkspaceRequest({ ...good, binding: { connection: -1, incarnation: 1, epoch: 7 } })).toBe(false);
  });
});

// MARK: - The main process, with a fake Herdr

const event = { senderFrame: { url: APP_ORIGIN }, sender: { id: 1 } };

/** A fake Herdr transport: records each line; answers workspace.create with a new workspace, or Herdr's error. */
function fakeHerdr(answer: "ok" | { code: string; message: string } = "ok") {
  const lines: string[] = [];
  const transport = {
    roundTrip: async (line: string) => {
      lines.push(line);
      const request = JSON.parse(line) as { id: string; method: string; params: Record<string, unknown> };
      if (typeof answer !== "string") return JSON.stringify({ id: request.id, error: answer });
      const label = String(request.params["label"]);
      return JSON.stringify({
        id: request.id,
        result: {
          type: "workspace_created",
          workspace: { workspace_id: "wE", number: 3, label, focused: false, pane_count: 1, tab_count: 1, active_tab_id: "wE:t1", agent_status: "unknown" },
          tab: { tab_id: "wE:t1", workspace_id: "wE", number: 1, label: "", focused: false, pane_count: 1, agent_status: "unknown" },
          root_pane: { pane_id: "wE:p1", terminal_id: "tE", workspace_id: "wE", tab_id: "wE:t1", focused: false, cwd: request.params["cwd"], agent_status: "unknown", revision: 1 },
        },
      });
    },
    close: () => undefined,
  };
  return { lines, client: new HerdrClient(transport as never) };
}

function mainProcess(options: { views?: HostView[]; answer?: "ok" | { code: string; message: string } } = {}) {
  const views = options.views ?? [mini, box];
  const herdrs = new Map(views.map((view) => [view.id, fakeHerdr(options.answer)]));
  const refreshed: string[] = [];
  const now = new Map(views.map((view) => [view.id, { connection: view.connection ?? 0, incarnation: view.incarnation ?? 0, epoch: view.epoch ?? null }]));
  registered.handles.clear();
  registerIpc({
    hosts: {
      // Each machine's home, for the `~` folder (Mac mini a Mac's, build-box a Linux one).
      backend: (id: string) => (herdrs.has(id) ? { workspaceActions: () => herdrs.get(id)!.client, homeFolder: async () => (id === "box" ? "/root" : "/Users/fixture") } : null),
      list: () => views,
      fresh: async (id: string) => (refreshed.push(id), true),
      connection: (id: string) => {
        const view = views.find((candidate) => candidate.id === id);
        return view?.state === "connected" ? (now.get(id)?.connection ?? null) : null;
      },
      connectionIdentity: (id: string) => (now.has(id) ? { incarnation: now.get(id)!.incarnation, epoch: now.get(id)!.epoch } : null),
    },
  } as never);
  // The door may refuse at once (a thrown error) or later (a rejected promise): both read as a rejection here.
  const create = async (hostId: string, body: unknown) => (await registered.handles.get(IPC.newWorkspace)!(event, hostId, body)) as NewWorkspaceResult;
  const sent = () =>
    [...herdrs.entries()].flatMap(([host, h]) =>
      h.lines.map((line) => {
        const request = JSON.parse(line) as { method: string; params: unknown };
        return { host, method: request.method, params: request.params };
      }),
    );
  return { create, sent, refreshed, now, herdrs };
}

const asked = (binding = { connection: 3, incarnation: 1, epoch: 7 }): NewWorkspaceRequest => ({ folder: "~/code/harbor", name: "harbor", binding });

describe("the main process makes one workspace", () => {
  it("one workspace.create on the machine asked, with the folder and the name, focus left alone; the sidebar read again", async () => {
    const m = mainProcess();
    const made = await m.create("mini", { ...asked(), name: "Head Quarters" });
    // The `~` folder goes whole (the machine's home); the result keeps it as typed.
    expect(m.sent()).toEqual([{ host: "mini", method: "workspace.create", params: { cwd: "/Users/fixture/code/harbor", focus: false, label: "Head Quarters" } }]);
    expect(made).toEqual({ workspaceId: "wE", label: "Head Quarters", tabId: "wE:t1", paneId: "wE:p1", folder: "~/code/harbor", elsewhere: null });
    expect(m.refreshed).toEqual(["mini"]);
  });

  it("the other machine's own connection when that one is asked", async () => {
    const m = mainProcess();
    await m.create("box", asked({ connection: 4, incarnation: 2, epoch: 1 }));
    expect(m.sent().map((line) => line.host)).toEqual(["box"]);
  });

  it("a machine not answering: refused with a note, nothing sent", async () => {
    const m = mainProcess({ views: [{ ...mini, state: "offline" }] });
    await expect(m.create("mini", asked())).rejects.toThrow("Mac mini is not answering.");
    expect(m.sent()).toEqual([]);
  });

  it("a reconnect since the user asked (a new connection, or a new command connection): refused, nothing sent", async () => {
    const m = mainProcess();
    m.now.set("mini", { connection: 5, incarnation: 1, epoch: 7 });
    await expect(m.create("mini", asked())).rejects.toThrow("Mac mini reconnected since you asked; nothing was made.");
    m.now.set("mini", { connection: 3, incarnation: 1, epoch: 8 });
    await expect(m.create("mini", asked())).rejects.toThrow("Mac mini reconnected since you asked; nothing was made.");
    expect(m.sent()).toEqual([]);
  });

  it("a machine removed (or removed and added again): refused, nothing sent", async () => {
    const m = mainProcess();
    await expect(m.create("gone", asked())).rejects.toThrow("That machine is no longer listed.");
    m.now.set("mini", { connection: 3, incarnation: 9, epoch: 7 });
    await expect(m.create("mini", asked())).rejects.toThrow("Mac mini was removed and added again since you asked; nothing was made.");
    expect(m.sent()).toEqual([]);
  });

  it("Herdr's refusal comes back as Herdr says it, after one request (never retried)", async () => {
    const m = mainProcess({ answer: { code: "invalid_cwd", message: "no such directory: ~/code/harbor" } });
    await expect(m.create("mini", asked())).rejects.toThrow("Herdr did not make harbor: no such directory: ~/code/harbor");
    expect(m.sent()).toHaveLength(1);
  });

  it("a malformed request is refused before anything is read", async () => {
    const m = mainProcess();
    await expect(m.create("mini", { ...asked(), folder: "~/a\nb" })).rejects.toThrow("bad request");
    await expect(m.create("", asked())).rejects.toThrow("bad request");
    expect(m.sent()).toEqual([]);
  });
});

// MARK: - The dialog

function dialog(overrides: Record<string, unknown> = {}) {
  const creates: { machine: NewWorkspaceMachine; request: NewWorkspaceRequest }[] = [];
  const created: NewWorkspaceResult[] = [];
  let closed = 0;
  let answer: Promise<NewWorkspaceResult> = Promise.resolve({ workspaceId: "wE", label: "harbor", tabId: "wE:t1", paneId: "wE:p1", folder: "~/code/harbor" });
  const props = {
    machines: newWorkspaceMachines([mini]),
    // The machines as the window shows them now (only the refusal comes from these).
    hosts: [mini, box],
    wanted: "mini",
    create: (machine: NewWorkspaceMachine, request: NewWorkspaceRequest) => {
      creates.push({ machine, request });
      return answer;
    },
    onCreated: (_machine: NewWorkspaceMachine, result: NewWorkspaceResult) => created.push(result),
    onClose: () => (closed += 1),
    ...overrides,
  };
  const view = new HookHost(NewWorkspaceDialog as (props: object) => unknown, props);
  view.render();
  const root = () => elements(view.tree).find((e) => e.props["role"] === "dialog") as Element;
  const press = (key: string, extra: Record<string, unknown> = {}) =>
    (root().props["onKeyDown"] as (event: unknown) => void)({
      key,
      shiftKey: false,
      target: { tagName: "INPUT" },
      nativeEvent: { isComposing: false },
      preventDefault: () => undefined,
      ...extra,
    });
  const type = (label: string, value: string) => (byLabel(view.tree, label)!.props["onChange"] as (event: unknown) => void)({ target: { value } });
  return {
    view,
    creates,
    created,
    closed: () => closed,
    fail: (error: Error) => (answer = Promise.reject(error)),
    press,
    type,
    title: () => root().props["aria-label"],
    field: (label: string) => byLabel(view.tree, label)?.props["value"],
    note: () => text(elements(view.tree).find((e) => e.props["role"] === "status")),
    createButton: () => elements(view.tree).find((e) => e.type === "button" && text(e.props["children"]).startsWith("Create"))!,
    chips: () => elements(view.tree).filter((e) => typeof e.props["aria-label"] === "string" && (e.props["aria-label"] as string).startsWith("Folder ")),
  };
}

describe("the New workspace dialog", () => {
  it("one machine: the machine picker first, said in the title; the folder empty with the machine's folders as rows", () => {
    const d = dialog();
    expect(d.title()).toBe("New workspace on Mac mini");
    expect(byLabel(d.view.tree, "Machine")!.props["value"]).toBe("mini");
    expect(d.field("Folder")).toBe("");
    expect(d.chips().map((chip) => chip.props["title"])).toEqual(["/Users/r/code/app", "/Users/r/code/app/web", "/Users/r/ops"]);
    expect(d.createButton().props["disabled"]).toBe(true);
  });

  it("more than one machine: a choice, on the selected pane's machine", () => {
    const d = dialog({ machines: newWorkspaceMachines([mini, box]), wanted: "box" });
    expect(byLabel(d.view.tree, "Machine")!.props["value"]).toBe("box");
    expect(d.title()).toBe("New workspace on build-box");
    expect(d.chips().map((chip) => chip.props["title"])).toEqual(["/srv/builds"]);
  });

  it("the name follows the folder until the user edits it; then the folder no longer changes it", () => {
    const d = dialog();
    d.type("Folder", "~/code/harbor");
    expect(d.field("Name")).toBe("harbor");
    (d.chips()[2]!.props["onClick"] as () => void)();
    expect(d.field("Folder")).toBe("/Users/r/ops");
    expect(d.field("Name")).toBe("ops");
    d.type("Name", "Ops desk");
    d.type("Folder", "~/code/harbor");
    expect(d.field("Name")).toBe("Ops desk");
  });

  it("Return creates it once, with the folder, the name and the connection the machine shows", async () => {
    const d = dialog();
    d.type("Folder", "~/code/harbor");
    d.press("Enter");
    d.press("Enter");
    expect(d.creates).toEqual([
      { machine: expect.objectContaining({ hostId: "mini" }), request: { folder: "~/code/harbor", name: "harbor", binding: { connection: 3, incarnation: 1, epoch: 7 } } },
    ]);
    expect(d.note()).toBe("Creating harbor…");
    await settle();
    expect(d.created).toEqual([expect.objectContaining({ workspaceId: "wE", paneId: "wE:p1" })]);
  });

  it("no folder: Return does nothing; no machine answering: said, nothing can be made", () => {
    const d = dialog();
    d.press("Enter");
    expect(d.creates).toEqual([]);
    const none = dialog({ machines: [], wanted: null });
    none.type("Folder", "~/x");
    none.press("Enter");
    expect(none.creates).toEqual([]);
    expect(none.note()).toBe("No machine is answering.");
  });

  it("Esc cancels and is the dialog's own while it is open; a create under way opens nothing", async () => {
    const d = dialog();
    expect(escapeOwners.any()).toBe(true);
    d.press("Escape");
    expect(d.closed()).toBe(1);
    const late = dialog();
    late.type("Folder", "~/code/harbor");
    late.press("Enter");
    late.press("Escape");
    await settle();
    expect(late.created).toEqual([]);
  });

  it("Herdr's error shows in the dialog, which stays to try again", async () => {
    const d = dialog();
    d.fail(new Error("Error invoking remote method 'herdr:new-workspace': Error: no such directory: ~/code/harbor"));
    d.type("Folder", "~/code/harbor");
    d.press("Enter");
    await settle();
    expect(d.note()).toBe("Not created: no such directory: ~/code/harbor");
    expect(d.closed()).toBe(0);
    expect(d.created).toEqual([]);
    expect(d.createButton().props["disabled"]).toBe(false);
  });
});

// MARK: - Entry points

function press(key: string, mods: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>>) {
  return { key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods };
}

describe("⇧⌘N", () => {
  it("⇧⌘N (Ctrl+Shift+N off the Mac) is New workspace; ⌘N stays New agent", () => {
    expect(appShortcut(press("N", { metaKey: true, shiftKey: true }), true)).toBe("newWorkspace");
    expect(appShortcut(press("n", { metaKey: true, shiftKey: true }), true)).toBe("newWorkspace");
    expect(appShortcut(press("N", { ctrlKey: true, shiftKey: true }), false)).toBe("newWorkspace");
    expect(appShortcut(press("n", { metaKey: true }), true)).toBe("newAgent");
    expect(appShortcut(press("N", { metaKey: true, shiftKey: true, altKey: true }), true)).toBeNull();
    expect(appShortcut(press("N", { ctrlKey: true, shiftKey: true }), true)).toBeNull();
  });

  it("takes no key another feature uses: not a tile key, not a menu key, not the terminal's copy", () => {
    expect(tileShortcut(press("N", { metaKey: true, shiftKey: true }), true)).toBeNull();
    expect(tileShortcut(press("N", { ctrlKey: true, shiftKey: true }), false)).toBeNull();
    const accelerators = [...viewMenuItems(() => undefined, true), ...viewMenuItems(() => undefined, false)].map((item) => item.accelerator).filter(Boolean);
    expect(accelerators).not.toContain("Shift+Cmd+N");
    expect(accelerators).not.toContain("Shift+Ctrl+N");
    expect(accelerators).not.toContain("Shift+CmdOrCtrl+N");
  });

  it("the File menu's New Workspace… shows the key and asks the page", () => {
    const sent: ViewCommand[] = [];
    for (const mac of [true, false]) {
      const item = fileMenuItems((command) => sent.push(command), mac).find((candidate) => candidate.label === "New Workspace…")!;
      expect(item.accelerator).toBe(mac ? "Shift+Cmd+N" : "Shift+Ctrl+N");
      // The page's own key handles it off the Mac (Linux, Windows); the Mac's menu and the page both may: opening is once either way.
      expect(item.registerAccelerator).toBe(false);
      (item.click as () => void)();
    }
    expect(sent).toEqual(["new-workspace", "new-workspace"]);
  });
});

describe("the sidebar's New workspace", () => {
  it("a New workspace row under New agent, with its key", () => {
    const calls: string[] = [];
    const view = new HookHost(Sidebar as (props: object) => unknown, {
      sidebar: buildDesktopSidebar([mini], { fold: emptyFoldState, search: "", nowUnixMs: 0, seenDone: {} }),
      selectedKey: null,
      search: null,
      demo: false,
      foldedHosts: new Set<string>(),
      onSelect: () => undefined,
      onRowMenu: () => undefined,
      onToggleHost: () => undefined,
      onMode: () => undefined,
      onToggleWorkspace: () => undefined,
      onToggleExpanded: () => undefined,
      onToggleSection: () => undefined,
      onSearch: () => undefined,
      onAddHost: () => undefined,
      onNewAgent: () => calls.push("agent"),
      onNewWorkspace: () => calls.push("workspace"),
      onWorkspaceMenu: () => undefined,
      newWorkspaceKey: "⇧⌘N",
    });
    view.render();
    const rows = elements(view.tree).filter((e) => e.props["className"] === "sb-new");
    expect(rows.map((row) => text(row.props["children"]))).toEqual(["New agent⌘N", "New workspace⇧⌘N"]);
    (rows[1]!.props["onClick"] as () => void)();
    expect(calls).toEqual(["workspace"]);
  });
});

// MARK: - The window

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

async function window_(platform: "darwin" | "linux" = "darwin") {
  let view: (command: ViewCommand) => void = () => undefined;
  let command: (command: AppCommand) => void = () => undefined;
  const keys: ((event: unknown) => void)[] = [];
  let hosts: HostView[] = [mini, box];
  const hostListeners: ((hosts: HostView[]) => void)[] = [];
  const asks: { hostId: string; request: NewWorkspaceRequest }[] = [];
  vi.stubGlobal("window", {
    herdrDesktop: {
      appInfo: async () => ({ version: "0.0.0", platform, demo: false, capture: false, updates: { enabled: false, feedUrl: "" } }),
      listHosts: async () => hosts,
      onHostsChanged: (listener: (hosts: HostView[]) => void) => {
        hostListeners.push(listener);
        return () => undefined;
      },
      onAppCommand: (listener: (c: AppCommand) => void) => {
        command = listener;
        return () => undefined;
      },
      onViewCommand: (listener: (c: ViewCommand) => void) => {
        view = listener;
        return () => undefined;
      },
      newWorkspace: async (hostId: string, request: NewWorkspaceRequest) => {
        asks.push({ hostId, request });
        // The main process reads the machine again before it answers: the new workspace is in its snapshot.
        hosts = hosts.map((host) =>
          host.id !== hostId
            ? host
            : {
                ...host,
                topology: topology([
                  { id: "w1", label: "app", panes: [{ id: "w1:p1", cwd: "/Users/r/code/app" }] },
                  { id: "wE", label: request.name, panes: [{ id: "wE:p1", cwd: request.folder }] },
                ]),
              },
        );
        for (const listener of hostListeners) listener(hosts);
        return { workspaceId: "wE", label: request.name, tabId: "wE:t1", paneId: "wE:p1", folder: request.folder };
      },
      startCommands: async () => absentStartCommands,
      ghosttyInfo: async () => ({ shown: false }),
      appCommandDone: () => undefined,
      copyText: () => undefined,
      awayState: async () => ({ building: false, digest: null }),
      onAwayUpdate: () => () => undefined,
      awayShown: () => undefined,
      onSearchUpdate: () => () => undefined,
    },
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      if (type === "keydown") keys.push(listener);
    },
    removeEventListener: () => undefined,
    sessionStorage: { getItem: () => null, setItem: () => undefined },
  });
  vi.stubGlobal("document", { body: { classList: { add: () => undefined } }, fonts: { ready: Promise.resolve() }, querySelector: () => null });
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
  vi.stubGlobal("requestAnimationFrame", (callback: (time: number) => void) => {
    callback(0);
    return 0;
  });
  const app = new HookHost(App as (props: object) => unknown, {});
  app.render();
  await flush();
  const sidebar = () => byName(app.tree, "Sidebar")!;
  const key = (mods: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>>, name = "N") => {
    let prevented = false;
    const event = { ...press(name, mods), preventDefault: () => (prevented = true), stopPropagation: () => undefined };
    for (const listener of keys) listener(event);
    return prevented;
  };
  return {
    app,
    asks,
    key,
    /** A key event as the browser gives the window's capture listener (stopPropagation recorded by the caller). */
    rawKey: (event: unknown) => {
      for (const listener of keys) listener(event);
    },
    /** The machines change, as the main process's hosts-changed message says. */
    updateHosts: (next: HostView[]) => {
      hosts = next;
      for (const listener of hostListeners) listener(hosts);
    },
    getHosts: () => hosts,
    view: (c: ViewCommand) => view(c),
    command: (c: AppCommand) => command(c),
    sidebar,
    dialog: () => byName(app.tree, "NewWorkspaceDialog"),
    select: (hostId: string, paneId: string) => (sidebar().props["onSelect"] as (h: string, p: string) => void)(hostId, paneId),
    unmount: () => app.unmount(),
  };
}

describe("the window's New workspace", () => {
  it("each entry point opens the dialog, once: the sidebar's row, ⇧⌘N, the File menu", async () => {
    const w = await window_();
    expect(w.dialog()).toBeUndefined();
    (w.sidebar().props["onNewWorkspace"] as () => void)();
    expect(w.dialog()).toBeDefined();
    expect(w.sidebar().props["newWorkspaceKey"]).toBe("⇧⌘N");
    (w.dialog()!.props["onClose"] as () => void)();
    expect(w.dialog()).toBeUndefined();

    expect(w.key({ metaKey: true, shiftKey: true })).toBe(true);
    expect(w.dialog()).toBeDefined();
    // The menu's item after the page's key (the Mac may deliver both): still the one dialog, as it was.
    const first = w.dialog();
    w.view("new-workspace");
    expect(w.dialog()!.props).toBe(first!.props);
    (w.dialog()!.props["onClose"] as () => void)();

    w.view("new-workspace");
    expect(w.dialog()).toBeDefined();
    w.unmount();
  });

  it("Ctrl+Shift+N off the Mac, read as the sidebar shows it", async () => {
    const w = await window_("linux");
    expect(w.sidebar().props["newWorkspaceKey"]).toBe("Ctrl+Shift+N");
    expect(w.key({ ctrlKey: true, shiftKey: true })).toBe(true);
    expect(w.dialog()).toBeDefined();
    w.unmount();
  });

  it("opens on the selected pane's machine", async () => {
    const w = await window_();
    w.select("box", "w9:p1");
    w.key({ metaKey: true, shiftKey: true });
    expect(w.dialog()!.props["wanted"]).toBe("box");
    w.unmount();
  });

  it("made: the dialog closes and the new workspace's pane is selected in the sidebar", async () => {
    const w = await window_();
    w.key({ metaKey: true, shiftKey: true });
    const created = (w.dialog()!.props["create"] as (m: NewWorkspaceMachine, r: NewWorkspaceRequest) => Promise<NewWorkspaceResult>)(
      newWorkspaceMachines([mini])[0]!,
      { folder: "~/code/harbor", name: "harbor", binding: { connection: 3, incarnation: 1, epoch: 7 } },
    );
    const result = await created;
    (w.dialog()!.props["onCreated"] as (m: NewWorkspaceMachine, r: NewWorkspaceResult) => void)(newWorkspaceMachines([mini])[0]!, result);
    await flush();
    expect(w.asks).toEqual([{ hostId: "mini", request: expect.objectContaining({ folder: "~/code/harbor", name: "harbor" }) }]);
    expect(w.dialog()).toBeUndefined();
    expect(w.sidebar().props["selectedKey"]).toBe("mini/wE:p1");
    w.unmount();
  });
});

// MARK: - After it is made

const { NewAgentDialog } = await import("../src/renderer/components/NewAgentDialog");
const { newAgentPlaces } = await import("../src/shared/new-agent");

async function made() {
  const w = await window_();
  w.key({ metaKey: true, shiftKey: true });
  const machine = newWorkspaceMachines([mini])[0]!;
  const result = await (w.dialog()!.props["create"] as (m: NewWorkspaceMachine, r: NewWorkspaceRequest) => Promise<NewWorkspaceResult>)(machine, {
    folder: "~/code/harbor",
    name: "harbor",
    binding: machine.binding,
  });
  (w.dialog()!.props["onCreated"] as (m: NewWorkspaceMachine, r: NewWorkspaceResult) => void)(machine, result);
  await flush();
  const ready = () => byName(w.app.tree, "NewWorkspaceReady");
  const screen = (): string => {
    for (const name of ["NewWorkspaceReady", "SplitView", "MainPane", "EmptyState"]) if (byName(w.app.tree, name) !== undefined) return name;
    return "none";
  };
  return { ...w, ready, screen, newAgent: () => byName(w.app.tree, "NewAgentDialog") };
}

describe("after it is made", () => {
  it("the main area offers Start an agent in it, with the workspace selected in the sidebar", async () => {
    const w = await made();
    expect(w.screen()).toBe("NewWorkspaceReady");
    expect(w.ready()!.props).toMatchObject({ hostName: "Mac mini", label: "harbor", folder: "~/code/harbor", present: true });
    expect(w.sidebar().props["selectedKey"]).toBe("mini/wE:p1");
    w.unmount();
  });

  it("Start an agent in it opens New agent for that workspace, with its folder", async () => {
    const w = await made();
    (w.ready()!.props["onStartAgent"] as () => void)();
    expect(w.newAgent()!.props["wanted"]).toEqual({ hostId: "mini", workspaceId: "wE" });
    expect(w.newAgent()!.props["initialFolder"]).toBe("~/code/harbor");
    // Cancelled, the offer is still there; an agent started there opens its pane (the offer goes).
    (w.newAgent()!.props["onClose"] as () => void)();
    expect(w.screen()).toBe("NewWorkspaceReady");
    (w.ready()!.props["onStartAgent"] as () => void)();
    (w.newAgent()!.props["onStarted"] as (place: unknown, result: unknown) => void)(
      { hostId: "mini", workspaceId: "wE" },
      { paneId: "wE:p1", tabId: "wE:t1", name: "claude", kind: "claude", start: { type: "herdr" }, summary: null },
    );
    await flush();
    expect(w.screen()).not.toBe("NewWorkspaceReady");
    w.unmount();
  });

  it("Open its shell shows the shell in the main area; another row leaves the offer too", async () => {
    const w = await made();
    (w.ready()!.props["onOpenShell"] as () => void)();
    expect(w.screen()).toBe("MainPane");
    const again = await made();
    again.select("box", "w9:p1");
    expect(again.screen()).toBe("MainPane");
    w.unmount();
    again.unmount();
  });

  it("New agent opened with a folder shows that folder, not the workspace's", () => {
    vi.stubGlobal("window", { herdrDesktop: { startCommands: () => Promise.resolve(absentStartCommands) } });
    const view = new HookHost(NewAgentDialog as (props: object) => unknown, {
      places: newAgentPlaces([mini]),
      wanted: { hostId: "mini", workspaceId: "w2" },
      initialFolder: "~/code/harbor",
      storage: null,
      start: () => new Promise(() => undefined),
      onStarted: () => undefined,
      onClose: () => undefined,
    });
    view.render();
    // "Starts in ~/code/harbor · Change…"; Change… opens the field with it.
    expect(byLabel(view.tree, "Folder")).toBeUndefined();
    expect(elements(view.tree).find((e) => e.props["className"] === "na-in")!.props["data-folder"]).toBe("~/code/harbor");
    (byLabel(view.tree, "Change the folder")!.props["onClick"] as () => void)();
    expect(byLabel(view.tree, "Folder")!.props["value"]).toBe("~/code/harbor");
  });

  it("the screen: what was made, and its two ways on; Start is off once the workspace is gone", () => {
    const calls: string[] = [];
    const props = { hostName: "Mac mini", label: "harbor", folder: "~/code/harbor", present: true, onStartAgent: () => calls.push("agent"), onOpenShell: () => calls.push("shell") };
    const { NewWorkspaceReady } = NewWorkspaceDialogModule;
    const view = new HookHost(NewWorkspaceReady as (props: object) => unknown, props);
    view.render();
    expect(text(view.tree)).toContain("harbor is on Mac mini, with a shell in its first tab at ~/code/harbor");
    const buttons = elements(view.tree).filter((e) => e.type === "button");
    expect(buttons.map((b) => text(b.props["children"]))).toEqual(["Start an agent in it ↩", "Open its shell"]);
    (buttons[0]!.props["onClick"] as () => void)();
    (buttons[1]!.props["onClick"] as () => void)();
    expect(calls).toEqual(["agent", "shell"]);
    const gone = new HookHost(NewWorkspaceReady as (props: object) => unknown, { ...props, present: false });
    gone.render();
    expect(elements(gone.tree).filter((e) => e.type === "button")[0]!.props["disabled"]).toBe(true);
    expect(text(gone.tree)).toContain("harbor is not available on Mac mini now");
  });
});

const NewWorkspaceDialogModule = await import("../src/renderer/components/NewWorkspaceDialog");

// MARK: - The demo's Herdr

const { readFileSync } = await import("node:fs");
const pathModule = await import("node:path");
const { DemoBackend } = await import("../src/main/demo/demo-backend");
const { demoHosts } = await import("../src/main/demo/demo-hosts");
const { fixturesRoot } = await import("./support/swift-fixtures");
const { newWorkspace } = await import("../src/main/herdr/new-workspace");

function demoMachine() {
  const read = (file: string): Buffer => readFileSync(pathModule.join(fixturesRoot, file));
  const json = (file: string): unknown => JSON.parse(read(file).toString("utf8"));
  const fixtures = {
    sidebarWorkspaces: json("protocol22/sidebar-workspaces.json") as unknown[],
    sidebarTabs: json("protocol22/sidebar-tabs.json") as unknown[],
    sidebarPanes: json("protocol22/sidebar-panes.json") as unknown[],
    mockAgentList: json("protocol22/mock-agent-list.json"),
    idle: new Uint8Array(read("replay/idle.hfx")),
    heavy: new Uint8Array(read("replay/heavy-excerpt.hfx")),
    bashDialog: read("replay/claude-2.1.303-bash-dialog.txt").toString("utf8"),
  };
  const [host] = demoHosts(fixtures, 1_800_000_000_000);
  return new DemoBackend(host!, fixtures, { schedule: () => () => undefined });
}

describe("New workspace on the demo's Herdr", () => {
  it("workspace.create makes the workspace with one tab and a shell at the folder; the next snapshot lists it", async () => {
    const backend = demoMachine();
    const events: string[] = [];
    backend.transport.onEvent((kind) => events.push(kind));
    const before = await backend.snapshot();
    const made = await backend.workspaceActions().createWorkspace("harbor", "~/code/harbor");
    expect(made.workspace).toMatchObject({ label: "harbor", tabCount: 1, paneCount: 1, focused: false });
    expect(made.tab).toMatchObject({ workspaceID: made.workspace.workspaceID, label: "", focused: false });
    expect(made.rootPane).toMatchObject({ workspaceID: made.workspace.workspaceID, tabID: made.tab.tabID, cwd: "~/code/harbor", focused: false });
    expect(made.rootPane.agent).toBeUndefined();
    const after = await backend.snapshot();
    expect(after.workspaces.map((w) => w.workspaceID)).toEqual([...before.workspaces.map((w) => w.workspaceID), made.workspace.workspaceID]);
    expect(Number(after.workspaces.at(-1)!.number)).toBe(before.workspaces.length + 1);
    expect(after.panes.filter((pane) => pane.workspaceID === made.workspace.workspaceID).map((pane) => pane.paneID)).toEqual([made.rootPane.paneID]);
    expect(events).toEqual(["workspace.created"]);
    // Another one gets its own ids; Herdr's focus never moves.
    const second = await backend.workspaceActions().createWorkspace("harbor", null);
    expect(second.workspace.workspaceID).not.toBe(made.workspace.workspaceID);
    expect(second.rootPane.paneID).not.toBe(made.rootPane.paneID);
    expect((await backend.snapshot()).focusedWorkspaceID).toBe(before.focusedWorkspaceID);
    backend.close();
  });

  it("an empty name is refused as Herdr refuses it, and nothing is made", async () => {
    const backend = demoMachine();
    const before = await backend.snapshot();
    await expect(backend.workspaceActions().createWorkspace("", "~/x")).rejects.toThrow();
    expect((await backend.snapshot()).workspaces).toHaveLength(before.workspaces.length);
    backend.close();
  });

  it("through the main process's path: one request, the workspace in the machine's sidebar, selected as its shell's row", async () => {
    const backend = demoMachine();
    let view: HostView = { ...mini, id: "demo", name: "Mac mini", kind: "demo", connection: 1, incarnation: 1, epoch: 0, topology: await backend.snapshot() };
    const result = await newWorkspace(
      {
        backend: () => backend,
        list: () => [view],
        fresh: async () => {
          view = { ...view, topology: await backend.snapshot() };
          return true;
        },
        connection: () => 1,
        connectionIdentity: () => ({ incarnation: 1, epoch: 0 }),
      },
      "demo",
      { folder: "~/code/harbor", name: "harbor", binding: { connection: 1, incarnation: 1, epoch: 0 } },
    );
    expect(backend.transport.requests.filter((line) => line.includes("workspace.create"))).toHaveLength(1);
    const sidebar = buildDesktopSidebar([view], { fold: emptyFoldState, search: "", nowUnixMs: 0, seenDone: {} });
    const section = sidebar.hosts[0]!.model!.projects.find((candidate) => candidate.header.workspaceID === result.workspaceId);
    expect(section?.header.label).toBe("harbor");
    expect(section?.rows.map((row) => row.paneID)).toEqual([result.paneId]);
    backend.close();
  });
});

describe("the demo captures", () => {
  it("end with New workspace's dialog on the Mac mini, then the workspace it made, selected", async () => {
    const { demoCaptureSteps, demoNewWorkspaceFolder } = await import("../src/main/capture");
    const { demoHostIds } = await import("../src/main/demo/demo-hosts");
    const steps = demoCaptureSteps(demoHostIds);
    expect(steps.slice(-3).map((step) => step.name)).toEqual(["38-context-card", "39-new-workspace", "40-new-workspace-made"]);
    expect(steps.at(-2)!.commands).toEqual([
      { type: "clear-selection" },
      { type: "set-mode", mode: "priority" },
      { type: "set-mode", mode: "projects" },
      { type: "open-new-workspace", hostId: demoHostIds.macMini, folder: demoNewWorkspaceFolder },
    ]);
    expect(steps.at(-1)!.commands).toEqual([{ type: "create-workspace", hostId: demoHostIds.macMini, folder: demoNewWorkspaceFolder, name: null }]);
  });

  it("the window's capture commands: the dialog opened with the folder; the workspace made as Return would, selected", async () => {
    const w = await window_();
    w.command({ id: "c1", type: "open-new-workspace", hostId: "box", folder: "/srv/site" });
    expect(w.dialog()!.props).toMatchObject({ wanted: "box", initialFolder: "/srv/site" });
    w.command({ id: "c2", type: "create-workspace", hostId: "mini", folder: "~/code/harbor", name: null });
    await flush();
    expect(w.dialog()).toBeUndefined();
    expect(w.asks).toEqual([{ hostId: "mini", request: { folder: "~/code/harbor", name: "harbor", binding: { connection: 3, incarnation: 1, epoch: 7 } } }]);
    expect(w.sidebar().props["selectedKey"]).toBe("mini/wE:p1");
    expect(byName(w.app.tree, "NewWorkspaceReady")).toBeDefined();
    w.unmount();
  });
});

// MARK: - The dialog's connection, shortcuts, agent start and sidebar

describe("the dialog keeps the connection it was opened on", () => {
  for (const [caseName, changed] of [
    ["reconnect", { connection: 8, epoch: 8 }],
    ["command connection replacement", { epoch: 8 }],
    ["removed and re-added machine", { connection: 8, incarnation: 9, epoch: 1 }],
  ] as const) {
    it(`a ${caseName} while it is open: nothing is sent, Create stays refused until it is opened again`, async () => {
      const w = await window_();
      w.key({ metaKey: true, shiftKey: true });
      const main = mainProcess({ views: [{ ...mini, ...changed }, box] });
      const create = (machine: NewWorkspaceMachine, request: NewWorkspaceRequest) => main.create(machine.hostId, request);
      // The window's dialog, rendered on its own with the window's props (a create that goes to the real IPC door).
      const child = new HookHost(NewWorkspaceDialog as (p: object) => unknown, { ...w.dialog()!.props, create });
      child.render();
      (byLabel(child.tree, "Folder")!.props["onChange"] as (event: unknown) => void)({ target: { value: "/code/harbor" } });
      w.updateHosts([{ ...mini, ...changed }, box]);
      child.render({ ...w.dialog()!.props, create });
      const root = elements(child.tree).find((e) => e.props["role"] === "dialog")!;
      (root.props["onKeyDown"] as (event: unknown) => void)({ key: "Enter", shiftKey: false, target: { tagName: "INPUT" }, nativeEvent: {}, preventDefault() {} });
      await flush();
      expect(main.sent()).toEqual([]);
      const note = text(elements(child.tree).find((e) => e.props["role"] === "status"));
      expect(note).toBe(
        caseName === "removed and re-added machine"
          ? "Mac mini was removed and added again since this dialog opened; open New workspace again."
          : "Mac mini reconnected since this dialog opened; open New workspace again.",
      );
      const createButton = elements(child.tree).find((e) => e.type === "button" && text(e.props["children"]).startsWith("Create"))!;
      expect(createButton.props["disabled"]).toBe(true);
      child.unmount();
      // Opened again: the connection it shows now, and the create goes.
      (w.dialog()!.props["onClose"] as () => void)();
      w.key({ metaKey: true, shiftKey: true });
      const again = new HookHost(NewWorkspaceDialog as (p: object) => unknown, { ...w.dialog()!.props, create });
      again.render();
      (byLabel(again.tree, "Folder")!.props["onChange"] as (event: unknown) => void)({ target: { value: "/code/harbor" } });
      (elements(again.tree).find((e) => e.props["role"] === "dialog")!.props["onKeyDown"] as (event: unknown) => void)({
        key: "Enter",
        shiftKey: false,
        target: { tagName: "INPUT" },
        nativeEvent: {},
        preventDefault() {},
      });
      await flush();
      expect(main.sent()).toHaveLength(1);
      again.unmount();
      w.unmount();
    });
  }

  it("the chosen machine going offline: it stays chosen and says it is not answering; nothing is sent", async () => {
    const w = await window_();
    w.key({ metaKey: true, shiftKey: true });
    const child = new HookHost(NewWorkspaceDialog as (p: object) => unknown, w.dialog()!.props);
    child.render();
    (byLabel(child.tree, "Folder")!.props["onChange"] as (event: unknown) => void)({ target: { value: "/code/harbor" } });
    w.updateHosts([{ ...mini, state: "offline" }, box]);
    child.render(w.dialog()!.props);
    const root = elements(child.tree).find((e) => e.props["role"] === "dialog")!;
    (root.props["onKeyDown"] as (event: unknown) => void)({ key: "Enter", shiftKey: false, target: { tagName: "INPUT" }, nativeEvent: {}, preventDefault() {} });
    expect(w.asks).toEqual([]);
    // The chosen machine's own note, not "No machine is answering.".
    expect(text(elements(child.tree).find((e) => e.props["role"] === "status"))).toBe("Mac mini is not answering.");
    expect(byLabel(child.tree, "Machine")!.props["value"]).toBe("mini");
    expect(elements(child.tree).find((e) => e.type === "button" && text(e.props["children"]).startsWith("Create"))!.props["disabled"]).toBe(true);
    child.unmount();
    w.unmount();
  });

  it("the binding sent is the one the dialog opened with, though its props move on", async () => {
    const d = dialog();
    d.type("Folder", "~/code/harbor");
    d.view.render({ ...(d.view as unknown as { props: Parameters<typeof d.view.render>[0] & object }).props, machines: newWorkspaceMachines([{ ...mini, connection: 8 }]) });
    d.press("Enter");
    expect(d.creates[0]!.request.binding).toEqual({ connection: 3, incarnation: 1, epoch: 7 });
  });
});

const { Ghostty, InputHandler } = await import("ghostty-web");
const { TerminalInput } = await import("../src/renderer/terminal/terminal-input");
const { desktopRoot } = await import("./support/swift-fixtures");

describe("the window's shortcuts never reach the terminal", () => {
  /** The real ghostty-web key encoder behind the window's capture listener, as the browser orders them. */
  async function terminal(platform: "darwin" | "linux") {
    const wasm = readFileSync(pathModule.join(desktopRoot, "node_modules/ghostty-web/ghostty-vt.wasm"));
    const { instance } = await WebAssembly.instantiate(wasm, { env: { log: () => undefined } });
    const ghostty = new Ghostty(instance);
    const sent: string[] = [];
    let terminalKey!: (event: unknown) => void;
    const input = new TerminalInput({ hasSelection: () => false } as never, {} as never);
    const handler = new InputHandler(
      ghostty,
      {
        addEventListener(type: string, listener: (event: unknown) => void) {
          if (type === "keydown") terminalKey = listener;
        },
        removeEventListener() {},
      } as never,
      (data: string) => sent.push(data),
      () => undefined,
      undefined,
      (event: KeyboardEvent) => input.key(event),
    );
    const w = await window_(platform);
    const press = (key: string, mods: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>>) => {
      let stopped = false;
      const event = {
        key,
        code: `Key${key.toUpperCase()}`,
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        ...mods,
        defaultPrevented: false,
        preventDefault() {
          this.defaultPrevented = true;
        },
        stopPropagation() {
          stopped = true;
        },
      };
      // The window's capture listener first; the terminal's own listener only if propagation was not stopped.
      w.rawKey(event);
      if (!stopped) terminalKey(event);
    };
    return { w, sent, press, dispose: () => (handler.dispose(), w.unmount()) };
  }

  for (const platform of ["darwin", "linux"] as const) {
    const mac = platform === "darwin";
    it(`${mac ? "⇧⌘N" : "Ctrl+Shift+N"} opens New workspace and the focused terminal gets nothing (${platform})`, async () => {
      const t = await terminal(platform);
      t.press("N", { metaKey: mac, ctrlKey: !mac, shiftKey: true });
      expect(t.w.dialog()).toBeDefined();
      expect(t.sent).toEqual([]);
      t.dispose();
    });

    it(`${mac ? "⌘N" : "Ctrl+N"}, the same path, reaches no terminal either; a plain key still does (${platform})`, async () => {
      const t = await terminal(platform);
      t.press("n", { metaKey: mac, ctrlKey: !mac });
      expect(byName(t.w.app.tree, "NewAgentDialog")).toBeDefined();
      expect(t.sent).toEqual([]);
      t.press("a", {});
      expect(t.sent).toEqual(["a"]);
      t.dispose();
    });
  }
});

describe("Start an agent in it starts only there", () => {
  it("its machine offline (its last topology kept): Start and Open its shell are off; New agent opens nowhere else", async () => {
    const w = await made();
    w.updateHosts(w.getHosts().map((host) => (host.id === "mini" ? { ...host, state: "offline" as const } : host)));
    const ready = w.ready()!;
    expect(ready.props["present"]).toBe(false);
    const view = new HookHost(NewWorkspaceDialogModule.NewWorkspaceReady as (p: object) => unknown, ready.props);
    view.render();
    const buttons = elements(view.tree).filter((e) => e.type === "button");
    expect(buttons.map((b) => b.props["disabled"])).toEqual([true, true]);
    expect(text(view.tree)).toContain("harbor is not available on Mac mini now");
    w.unmount();
  });

  it("the callback checks that exact workspace again: a Start taken before it went offline opens nothing", async () => {
    const w = await made();
    const start = w.ready()!.props["onStartAgent"] as () => void;
    w.updateHosts(w.getHosts().map((host) => (host.id === "mini" ? { ...host, state: "offline" as const } : host)));
    start();
    expect(w.newAgent()).toBeUndefined();
    w.unmount();
  });

  it("while it is there, New agent opens for exactly that workspace, with no fallback", async () => {
    const w = await made();
    (w.ready()!.props["onStartAgent"] as () => void)();
    expect(w.newAgent()!.props).toMatchObject({ wanted: { hostId: "mini", workspaceId: "wE" }, initialFolder: "~/code/harbor", exact: true });
    w.unmount();
  });

  it("New agent for an exact workspace that is not there refuses it instead of taking another machine's", () => {
    vi.stubGlobal("window", { herdrDesktop: { startCommands: () => Promise.resolve(absentStartCommands) } });
    const starts: unknown[] = [];
    const view = new HookHost(NewAgentDialog as (props: object) => unknown, {
      places: newAgentPlaces([box]),
      wanted: { hostId: "mini", workspaceId: "wE" },
      exact: true,
      initialFolder: "~/code/harbor",
      storage: null,
      start: (...args: unknown[]) => (starts.push(args), new Promise(() => undefined)),
      onStarted: () => undefined,
      onClose: () => undefined,
    });
    view.render();
    expect(byLabel(view.tree, "Workspace")!.props["value"]).toBe("");
    expect(text(elements(view.tree).find((e) => e.props["role"] === "status"))).toBe("That workspace is not available now.");
    (elements(view.tree).find((e) => e.props["role"] === "dialog")!.props["onKeyDown"] as (event: unknown) => void)({
      key: "Enter",
      shiftKey: false,
      target: { tagName: "INPUT" },
      nativeEvent: { isComposing: false },
      preventDefault: () => undefined,
    });
    expect(starts).toEqual([]);
  });
});

const { HostRegistry } = await import("../src/main/hosts");

describe("the new workspace is in the sidebar when Create answers", () => {
  const deferred = <T,>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((yes) => {
      resolve = yes;
    });
    return { promise, resolve };
  };

  it("a topology read already under way (from before the create) is followed by one that began after it; one create", async () => {
    const old = mini.topology!;
    const next = topology([
      { id: "w1", label: "app", panes: [{ id: "w1:p1", cwd: "/code/app" }] },
      { id: "wE", label: "harbor", panes: [{ id: "wE:p1", cwd: "/code/harbor" }] },
    ]);
    const slow = deferred<typeof old>();
    const h = fakeHerdr();
    let reads = 0;
    const registry = new HostRegistry(() => undefined);
    registry.add({ id: "mini", name: "Mac mini", kind: "ssh", address: "fixture", platform: null }, {
      kind: "herdr-tui",
      snapshot: () => {
        reads += 1;
        return reads === 1 ? Promise.resolve(old) : reads === 2 ? slow.promise : Promise.resolve(next);
      },
      workspaceActions: () => h.client,
      close: () => undefined,
    } as never);
    await flush();
    const binding = newWorkspaceMachines(registry.list())[0]!.binding;
    // A periodic read is in flight; its answer predates the create.
    const poll = registry.refresh("mini");
    const creating = newWorkspace(registry, "mini", { folder: "/code/harbor", name: "harbor", binding });
    await flush();
    slow.resolve(old);
    await poll;
    const result = await creating;
    expect(h.lines).toHaveLength(1);
    expect(reads).toBe(3);
    expect(registry.list()[0]!.topology!.workspaces.some((w) => w.workspaceID === result.workspaceId)).toBe(true);
    expect(registry.list()[0]!.topology!.panes.some((p) => p.paneID === result.paneId)).toBe(true);
  });

  it("a read after the create that fails leaves the made workspace made (never created again)", async () => {
    const h = fakeHerdr();
    let reads = 0;
    const registry = new HostRegistry(() => undefined);
    registry.add({ id: "mini", name: "Mac mini", kind: "ssh", address: "fixture", platform: null }, {
      kind: "herdr-tui",
      snapshot: () => ((reads += 1) === 1 ? Promise.resolve(mini.topology!) : Promise.reject(new Error("connection lost"))),
      workspaceActions: () => h.client,
      close: () => undefined,
    } as never);
    await flush();
    const binding = newWorkspaceMachines(registry.list())[0]!.binding;
    await expect(newWorkspace(registry, "mini", { folder: "/code/harbor", name: "harbor", binding })).resolves.toMatchObject({ workspaceId: "wE" });
    expect(h.lines).toHaveLength(1);
  });
});

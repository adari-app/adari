// Rename a workspace. The workspace
// header's right-click menu gets Rename workspace…: the same inline field on
// the header (its name selected; the sidebar shows the header first), Return
// sends one workspace.rename on that machine's connection, bound to the
// workspace as the sidebar showed it (a reconnect, a machine not answering or
// the workspace gone refuses with a note and sends nothing), Esc or a click
// away cancels. Herdr's workspace.rename takes a label string (0.9.5 schema:
// WorkspaceRenameParams { workspace_id, label }, both required), so an empty
// name sends nothing and says so. Close workspace is out of scope.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  const hooks = { ...fakeReact, useLayoutEffect: fakeReact.useEffect };
  return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});
vi.mock("electron", () => ({ ipcMain: { handle: () => undefined, on: () => undefined } }));

import { HerdrClient } from "../src/main/herdr/client";
import type { HerdrHostBackend } from "../src/main/herdr/backend";
import type { HerdrTransport } from "../src/main/herdr/transport";
import { isWorkspaceRename, runWorkspaceRename, type PaneActionHosts } from "../src/main/pane-actions";
import type { DesktopSidebar } from "../src/shared/desktop-sidebar";
import type { HostView } from "../src/shared/ipc-contract";
import { bindingTexts, workspaceBindingOf } from "../src/shared/pane-binding";
import { HookHost } from "./support/fake-hooks";
import { fixturePanes, host, machine, named, page, settle } from "./support/manage-page";

const { layoutStore } = await import("../src/renderer/split/layout-store");
const { handoffStore } = await import("../src/renderer/handoff/handoff-state");
const { startCommandsStore } = await import("../src/renderer/components/resume");
const { escapeOwners } = await import("../src/renderer/components/escape-owners");
const { Sidebar } = await import("../src/renderer/components/Sidebar");

let cleanup: (() => void) | null = null;

beforeEach(() => {
  layoutStore.reset();
  escapeOwners.reset();
});

afterEach(() => {
  cleanup?.();
  cleanup = null;
  startCommandsStore.clear();
  handoffStore.reset();
  vi.unstubAllGlobals();
});

async function open(options: Parameters<typeof page>[0] = {}) {
  const p = await page(options);
  const before = cleanup;
  cleanup = () => {
    before?.();
    p.unmount();
  };
  return p;
}

function sidebarView(props: Record<string, unknown>) {
  const view = new HookHost<object>(Sidebar as (props: object) => unknown, props);
  view.render();
  return view;
}

/** The workspace headers' labels the sidebar shows for the machine (Projects). */
const headers = (props: Record<string, unknown>): string[] =>
  (props["sidebar"] as DesktopSidebar).hosts.flatMap((section) => section.model?.projects.map((project) => project.header.label) ?? []);

const save = (p: Awaited<ReturnType<typeof page>>, text: string) => (p.sidebar()["onRenameSave"] as (text: string) => void)(text);

describe("Rename workspace… in the header's menu", () => {
  it("follows New agent here, greyed with the reason while the machine does not answer", async () => {
    const p = await open();
    p.workspaceMenu("w1");
    expect(p.menu()!.map((item) => [item.label, item.disabledReason ?? null])).toEqual([
      ["New agent here", null],
      ["Rename workspace…", null],
    ]);
    const q = await open({ hosts: [machine(undefined, { state: "offline" })] });
    q.workspaceMenu("w1");
    expect(q.menu()!.map((item) => [item.label, item.disabledReason ?? null])).toEqual([
      ["New agent here", "Mac mini is not answering"],
      ["Rename workspace…", "Mac mini is not answering"],
    ]);
    q.menu()![1]!.onSelect();
    expect(q.sidebar()["renaming"]).toBeNull();
    expect(q.toast()).toBe("Not renamed: Mac mini is not answering.");
  });

  it("opens the field on the header with its name, and Return sends one workspace.rename", async () => {
    const p = await open();
    p.workspaceMenu("w1");
    p.pick("Rename workspace…");
    expect(p.sidebar()["renaming"]).toEqual({ key: "ws:host/w1", initial: "app" });
    const drawn = sidebarView(p.sidebar());
    const fields = named(drawn.tree, "RenameField");
    expect(fields.map((field) => [field.props["kind"], field.props["initial"], field.props["label"]])).toEqual([["header", "app", "Rename workspace app"]]);
    save(p, " aurora-web ");
    expect(p.calls).toEqual([["renameWorkspace", "host", { workspaceId: "w1", label: "aurora-web", binding: { connection: 3, incarnation: 2, epoch: 5, workspaceId: "w1" } }]]);
    expect(p.actions).toEqual([]);
    expect(p.sidebar()["renaming"]).toBeNull();
  });

  it("an empty name sends nothing and says so; the same name sends nothing; Esc sends nothing", async () => {
    const p = await open();
    p.workspaceMenu("w2");
    p.pick("Rename workspace…");
    save(p, "   ");
    expect(p.toast()).toBe("Not renamed: a workspace needs a name.");
    p.workspaceMenu("w2");
    p.pick("Rename workspace…");
    save(p, "ops");
    p.workspaceMenu("w2");
    p.pick("Rename workspace…");
    (p.sidebar()["onRenameCancel"] as () => void)();
    expect(p.sidebar()["renaming"]).toBeNull();
    expect(p.calls).toEqual([]);
  });

  it("the sidebar shows the header first: its machine unfolded, Priority left for Projects, a search ended", async () => {
    const p = await open();
    (p.sidebar()["onToggleHost"] as (h: string) => void)("host");
    (p.sidebar()["onMode"] as (mode: string) => void)("priority");
    (p.sidebar()["onSearch"] as (text: string | null) => void)("claude");
    p.workspaceMenu("w2");
    p.pick("Rename workspace…");
    expect((p.sidebar()["sidebar"] as DesktopSidebar).mode).toBe("projects");
    expect((p.sidebar()["foldedHosts"] as ReadonlySet<string>).has("host")).toBe(false);
    expect(p.sidebar()["search"]).toBeNull();
    expect(named(sidebarView(p.sidebar()).tree, "RenameField")).toHaveLength(1);
  });
});

describe("refusals: nothing sent, and why", () => {
  it("the machine reconnected or stopped answering, or the workspace went, while the field was open", async () => {
    const p = await open();
    const cases: [HostView, string][] = [
      [{ ...host, connection: 4 }, bindingTexts.reconnected],
      [{ ...host, epoch: 6 }, bindingTexts.reconnected],
      [{ ...host, incarnation: 3 }, bindingTexts.readded],
      [{ ...host, state: "offline" }, "Mac mini is not answering."],
    ];
    for (const [now, why] of cases) {
      p.hosts([host]);
      p.workspaceMenu("w1");
      p.pick("Rename workspace…");
      p.hosts([now]);
      save(p, "app v2");
      expect(p.calls).toEqual([]);
      expect(p.toast()).toBe(`Not renamed: ${why}`);
    }
    // The workspace gone: its field goes with its header.
    p.hosts([host]);
    p.workspaceMenu("w2");
    p.pick("Rename workspace…");
    p.hosts([machine(fixturePanes.filter((pane) => pane.workspace !== "w2"))]);
    expect(p.sidebar()["renaming"]).toBeNull();
  });

  it("Herdr's refusal says why after Not renamed", async () => {
    const p = await open();
    p.answerOther(() => Promise.reject(new Error("Error invoking remote method 'herdr:workspace-rename': Error: That workspace is no longer listed.")));
    p.workspaceMenu("w1");
    p.pick("Rename workspace…");
    save(p, "app v2");
    await settle();
    expect(p.toast()).toBe("Not renamed: That workspace is no longer listed.");
  });
});

describe("the new name", () => {
  it("shows on the header, and in the rows' place and the pane header's crumb, once the snapshot brings it", async () => {
    const p = await open();
    p.select("w1:p4");
    p.workspaceMenu("w1");
    p.pick("Rename workspace…");
    save(p, "aurora-web");
    expect(headers(p.sidebar())).toEqual(["app", "ops"]);
    p.hosts([machine(undefined, {}, { w1: "aurora-web" })]);
    expect(headers(p.sidebar())).toEqual(["aurora-web", "ops"]);
    expect((p.main()!["row"] as { workspaceLabel: string }).workspaceLabel).toBe("aurora-web");
  });
});

// MARK: - The main process: one workspace.rename on that machine's connection

class Recorder implements HerdrTransport {
  readonly sent: { method: string; params: Record<string, unknown> }[] = [];
  roundTrip(line: string): Promise<string> {
    const request = JSON.parse(line) as { id: string; method: string; params: Record<string, unknown> };
    this.sent.push({ method: request.method, params: request.params });
    const result =
      request.method === "workspace.rename"
        ? { type: "workspace_info", workspace: { workspace_id: request.params["workspace_id"], number: 1, label: request.params["label"], focused: true, pane_count: 4, tab_count: 3, agent_status: "idle" } }
        : { type: "ok" };
    return Promise.resolve(JSON.stringify({ id: request.id, result }));
  }
  close(): void {}
}

function machineHosts(options: { answering?: boolean; epoch?: number; view?: HostView } = {}) {
  const view = options.view ?? host;
  const recorder = new Recorder();
  const client = new HerdrClient(recorder);
  const refreshes: string[] = [];
  const answering = options.answering ?? true;
  const hosts: PaneActionHosts = {
    backend: () => ({ paneActions: () => client }) as unknown as HerdrHostBackend,
    topology: () => view.topology,
    refresh: async (hostId) => {
      refreshes.push(hostId);
    },
    fresh: async () => answering,
    connection: () => (answering ? (view.connection ?? 0) : null),
    connectionIdentity: () => ({ incarnation: view.incarnation ?? 0, epoch: options.epoch ?? view.epoch ?? null }),
  };
  const rename = (workspaceId: string, label: string, binding = workspaceBindingOf(host, workspaceId)!) => runWorkspaceRename(hosts, "host", { workspaceId, label, binding });
  return { recorder, refreshes, rename };
}

describe("main's workspace.rename", () => {
  it("is one request, workspace_id and label, then the snapshot read again", async () => {
    const m = machineHosts();
    await m.rename("w1", "aurora-web");
    expect(m.recorder.sent).toEqual([{ method: "workspace.rename", params: { workspace_id: "w1", label: "aurora-web" } }]);
    expect(m.refreshes).toEqual(["host"]);
  });

  it("binds a workspace to the machine's connection as the sidebar shows it", () => {
    expect(workspaceBindingOf(host, "w2")).toEqual({ connection: 3, incarnation: 2, epoch: 5, workspaceId: "w2" });
    expect(workspaceBindingOf(host, "w9")).toBeNull();
  });

  it("accepts only a well-formed rename: a label of 1 to 256 characters and a binding for that workspace", () => {
    const binding = workspaceBindingOf(host, "w1")!;
    expect(isWorkspaceRename({ workspaceId: "w1", label: "app", binding })).toBe(true);
    expect(isWorkspaceRename({ workspaceId: "w1", label: "", binding })).toBe(false);
    expect(isWorkspaceRename({ workspaceId: "w1", label: null, binding })).toBe(false);
    expect(isWorkspaceRename({ workspaceId: "w1", label: "x".repeat(257), binding })).toBe(false);
    expect(isWorkspaceRename({ workspaceId: "w2", label: "app", binding })).toBe(false);
    expect(isWorkspaceRename({ workspaceId: "w1", label: "app", binding: { ...binding, epoch: "5" } })).toBe(false);
    expect(isWorkspaceRename({ workspaceId: "w1", label: "app" })).toBe(false);
  });

  it("refuses, sending nothing, when the workspace went, the machine reconnected or does not answer", async () => {
    const gone = machineHosts({ view: machine(fixturePanes.filter((pane) => pane.workspace !== "w2")) });
    await expect(gone.rename("w2", "x")).rejects.toThrow("That workspace is no longer listed.");
    const reconnected = machineHosts({ epoch: 6 });
    await expect(reconnected.rename("w1", "x")).rejects.toThrow(bindingTexts.reconnected);
    const offline = machineHosts({ answering: false });
    await expect(offline.rename("w1", "x")).rejects.toThrow("The machine did not answer, so the workspace could not be checked.");
    for (const m of [gone, reconnected, offline]) expect(m.recorder.sent).toEqual([]);
  });
});

// A refused password is not tried again by itself.
// After a sign-in refusal the machine's connections stop (the latch in
// connectSsh: no client is even made) and the sidebar's 5 s refresh skips it,
// until the user presses Try again beside the error or edits the machine. A network
// failure keeps the automatic retry.

import { EventEmitter } from "node:events";

import type { ConnectConfig } from "ssh2";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { HostView } from "../src/shared/ipc-contract";
import { AuthenticationFailedError, ConnectFailedError } from "../src/main/herdr/errors";
import { MemoryPinStore, PinningHostKeyPolicy } from "../src/main/herdr/host-key-pinning";
import { AuthLatch, connectSsh, type SshHostConfig } from "../src/main/herdr/ssh";
import { HostRegistry } from "../src/main/hosts";
import { buildDesktopSidebar } from "../src/shared/desktop-sidebar";
import { HookHost, elements } from "./support/fake-hooks";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  return { ...actual, ...fakeReact, default: { ...actual, ...fakeReact } };
});

const { Sidebar } = await import("../src/renderer/components/Sidebar");

afterEach(() => {
  vi.useRealTimers();
});

const descriptor = { id: "a", name: "Mac mini", kind: "ssh" as const, address: "robin@a.invalid:22", platform: null };

function backend(snapshot: () => Promise<never>) {
  return { snapshot: vi.fn(snapshot), close: vi.fn() } as never as { snapshot: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
}

describe("the sidebar's refresh", () => {
  it("stops after a refused password; Try again makes one attempt; an edit makes one", async () => {
    vi.useFakeTimers();
    const refused = backend(() => Promise.reject(new AuthenticationFailedError("a.invalid", "password")));
    const registry = new HostRegistry(() => undefined);
    registry.add(descriptor, refused as never);
    await vi.advanceTimersByTimeAsync(0);
    registry.start(5_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refused.snapshot).toHaveBeenCalledTimes(1);
    expect(registry.list()[0]).toMatchObject({ state: "offline", authRefused: true, error: "The Mac refused the password. Check it in Edit machine." });
    // A send's check does not sign in again either.
    await expect(registry.fresh("a")).resolves.toBe(false);
    await registry.refreshAll();
    expect(refused.snapshot).toHaveBeenCalledTimes(1);

    await registry.retry("a");
    expect(refused.snapshot).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refused.snapshot).toHaveBeenCalledTimes(2);

    const edited = backend(() => Promise.reject(new AuthenticationFailedError("a.invalid", "password")));
    registry.replace(descriptor, edited as never);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(edited.snapshot).toHaveBeenCalledTimes(1);
    registry.close();
  });

  it("a network failure keeps the automatic retry", async () => {
    vi.useFakeTimers();
    const offline = backend(() => Promise.reject(new ConnectFailedError("a.invalid", "the connection closed")));
    const registry = new HostRegistry(() => undefined);
    registry.add(descriptor, offline as never);
    await vi.advanceTimersByTimeAsync(0);
    registry.start(5_000);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(offline.snapshot).toHaveBeenCalledTimes(4);
    expect(registry.list()[0]?.authRefused).toBe(false);
    registry.close();
  });

  it("an answer clears the pause", async () => {
    let answer: () => Promise<never> = () => Promise.reject(new AuthenticationFailedError("a.invalid", "password"));
    const registry = new HostRegistry(() => undefined);
    registry.add(descriptor, backend(() => answer()) as never);
    await registry.refresh("a");
    expect(registry.list()[0]?.authRefused).toBe(true);
    answer = () => Promise.resolve({ panes: [], agents: [], workspaces: [], tabs: [] } as never);
    await registry.retry("a");
    expect(registry.list()[0]).toMatchObject({ state: "connected", authRefused: false, error: null });
  });
});

class FakeClient extends EventEmitter {
  config: ConnectConfig | null = null;
  connect(config: ConnectConfig): this {
    this.config = config;
    return this;
  }
  end(): this {
    return this;
  }
}

describe("connectSsh's latch", () => {
  it("after a refusal no connection is made until it is reset", async () => {
    const latch = new AuthLatch();
    const config: SshHostConfig = { host: "a.invalid", port: 22, username: "robin", herdrSession: "default", auth: "password", privateKeyPath: "", secret: () => "wrong", authLatch: latch };
    const policy = new PinningHostKeyPolicy(new MemoryPinStore());
    const clients: FakeClient[] = [];
    const makeClient = () => {
      const client = new FakeClient();
      clients.push(client);
      return client as never;
    };
    const first = connectSsh(config, policy, 5_000, { makeClient });
    clients[0]!.emit("error", Object.assign(new Error("All configured authentication methods failed"), { level: "client-authentication" }));
    await expect(first).rejects.toBeInstanceOf(AuthenticationFailedError);
    // Polling, a terminal, Chat: all refused at once, no client made.
    await expect(connectSsh(config, policy, 5_000, { makeClient })).rejects.toThrow("The Mac refused the password");
    await expect(connectSsh(config, policy, 5_000, { makeClient })).rejects.toBeInstanceOf(AuthenticationFailedError);
    expect(clients).toHaveLength(1);
    latch.reset();
    const again = connectSsh(config, policy, 5_000, { makeClient });
    expect(clients).toHaveLength(2);
    clients[1]!.emit("ready");
    await expect(again).resolves.toBe(clients[1]);
  });

  it("a network failure does not latch", async () => {
    const latch = new AuthLatch();
    const config: SshHostConfig = { host: "a.invalid", port: 22, username: "robin", herdrSession: "default", auth: "password", privateKeyPath: "", secret: () => "pw", authLatch: latch };
    const policy = new PinningHostKeyPolicy(new MemoryPinStore());
    const client = new FakeClient();
    const first = connectSsh(config, policy, 5_000, { makeClient: () => client as never });
    client.emit("error", Object.assign(new Error("connect ECONNREFUSED"), { level: "client-socket", code: "ECONNREFUSED" }));
    await expect(first).rejects.toThrow("refused the connection");
    expect(latch.refused).toBeNull();
  });
});

describe("Try again beside the error", () => {
  it("shows for a refused sign-in only, and asks the main process", () => {
    const host = (authRefused: boolean, error: string): HostView => ({
      ...descriptor,
      state: "offline",
      error,
      topology: null,
      fetchedAtMs: null,
      authRefused,
    });
    const retried: string[] = [];
    const render = (hosts: HostView[]) => {
      const ui = new HookHost(Sidebar, {
        sidebar: buildDesktopSidebar(hosts, { nowUnixMs: 0 }),
        selectedKey: null,
        search: null,
        demo: false,
        foldedHosts: new Set<string>(),
        onSelect: () => undefined,
        onRowMenu: () => undefined,
        onToggleHost: () => undefined,
        onHostMenu: () => undefined,
        onRetryHost: (id: string) => retried.push(id),
        onMode: () => undefined,
        onToggleWorkspace: () => undefined,
        onToggleExpanded: () => undefined,
        onToggleSection: () => undefined,
        onSearch: () => undefined,
        onAddHost: () => undefined,
        onNewAgent: () => undefined,
        onWorkspaceMenu: () => undefined,
      });
      ui.render();
      return (elements(ui.tree) as { type: unknown; props: Record<string, unknown> }[]).find(
        (e) => e.type === "button" && e.props["className"] === "host-retry",
      );
    };
    expect(render([host(false, "Can't reach a.invalid.")])).toBeUndefined();
    const button = render([host(true, "The Mac refused the password. Check it in Edit machine.")]);
    expect(button).toBeDefined();
    (button!.props["onClick"] as () => void)();
    expect(retried).toEqual(["a"]);
  });
});

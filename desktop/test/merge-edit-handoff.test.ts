// Edit machine (HostRegistry.replace: a new backend in the old one's place,
// maybe at a new address) and the hand-off's own count of each machine's
// connections (PaneLife, the
// `run` a hand-off's Send is bound to). An edit is a new connection: a binding
// picked before it no longer matches after it, even when the pane ids and the
// agent runs on the new connection look the same.

import { describe, expect, it } from "vitest";

import type { HerdrHostBackend } from "../src/main/herdr/backend";
import type { SessionTopology } from "../src/main/herdr/wire";
import { HostRegistry } from "../src/main/hosts";
import { paneTopology } from "./support/pane-topology";

const session = "0f2c9a6e-3b1d-4c5e-8f7a-9b0c1d2e3f4a";
const panes = paneTopology([{ id: "p1", agent: "claude", session }]);

function backend(topology: SessionTopology) {
  let closed = 0;
  return {
    snapshot: () => Promise.resolve(topology),
    close: () => {
      closed += 1;
    },
    closed: () => closed,
  };
}

const descriptor = (address: string) => ({ id: "mini", name: "Mac mini", kind: "ssh" as const, address, platform: null });

describe("an edited machine and a hand-off's binding", () => {
  it("counts the edit as a new connection, at the same address", async () => {
    const registry = new HostRegistry(() => undefined);
    const first = backend(panes);
    registry.add(descriptor("robin@mini.invalid:22"), first as unknown as HerdrHostBackend);
    await registry.refresh("mini");
    const before = registry.run("mini", "p1");
    expect(before).not.toBeNull();

    registry.replace(descriptor("robin@mini.invalid:22"), backend(panes) as unknown as HerdrHostBackend);
    expect(first.closed()).toBe(1);
    // Until the new connection answers there is no run to send on.
    expect(registry.run("mini", "p1")).toBeNull();
    await registry.refresh("mini");
    const after = registry.run("mini", "p1");
    expect(after).not.toBeNull();
    expect(after!.connection).toBe(before!.connection + 1);
    registry.close();
  });

  it("counts the edit as a new connection when it points at another Mac with the same pane ids", async () => {
    const registry = new HostRegistry(() => undefined);
    registry.add(descriptor("robin@old.invalid:22"), backend(panes) as unknown as HerdrHostBackend);
    await registry.refresh("mini");
    const before = registry.run("mini", "p1")!;

    registry.replace(descriptor("robin@new.invalid:22"), backend(panes) as unknown as HerdrHostBackend);
    await registry.refresh("mini");
    const after = registry.run("mini", "p1")!;
    expect(after).not.toEqual(before);
    expect(after.connection).toBe(before.connection + 1);
    // The listed run (what a pick binds to) is the new one.
    expect(registry.list()[0]?.run?.connection).toBe(after.connection);
    registry.close();
  });
});

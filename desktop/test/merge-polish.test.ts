// The per-machine across-agents read (ChangesService.overview(owner, hostId))
// beside its neighbours: one agent read per window, which is why split tiles
// show Changes in one tile at a time, and the demo backend's Changes on the
// demo (its many-languages chat, its 4-pane tab). The real ChangesService on
// the demo machine with the demo's fixture git.

import { describe, expect, it } from "vitest";

import { ChangesService, type ChangesHosts } from "../src/main/changes/service";
import { DemoBackend } from "../src/main/demo/demo-backend";
import { demoHostIds, demoHosts, demoSplitTab } from "../src/main/demo/demo-hosts";
import type { HerdrHostBackend } from "../src/main/herdr/backend";
import type { HostView } from "../src/shared/ipc-contract";
import { bundledFixturesForTests } from "./support/demo-fixtures";

const start = 1_793_588_400_000;

async function macMini(): Promise<ChangesHosts> {
  const host = demoHosts(bundledFixturesForTests(), start).find((candidate) => candidate.descriptor.id === demoHostIds.macMini)!;
  const backend = new DemoBackend(host, bundledFixturesForTests(), undefined, () => start);
  const view: HostView = { ...host.descriptor, state: "connected", error: null, topology: await backend.snapshot(), fetchedAtMs: start };
  return { list: () => [view], backend: (id) => (id === view.id ? (backend as unknown as HerdrHostBackend) : null) };
}

describe("the per-machine overview beside a window's one agent read", () => {
  it("an overview read and a tile's agent read go on together; neither ends the other", async () => {
    const changes = new ChangesService(await macMini(), { now: () => start });
    const owner = { id: 1 };
    const [agent, overview] = await Promise.all([
      changes.agent(owner, demoHostIds.macMini, demoSplitTab.chats[0]!),
      changes.overview(owner, demoHostIds.macMini),
    ]);
    expect(agent).not.toBeNull();
    expect(overview?.state).toBe("read");
    changes.close(owner);
  });

  it("a second tile's agent read still ends the first (one tile in Changes), and the overview read is left to finish", async () => {
    const changes = new ChangesService(await macMini(), { now: () => start });
    const owner = { id: 1 };
    const first = changes.agent(owner, demoHostIds.macMini, demoSplitTab.chats[0]!);
    const overview = changes.overview(owner, demoHostIds.macMini);
    const second = changes.agent(owner, demoHostIds.macMini, demoSplitTab.chats[1]!);
    expect(await first).toBeNull();
    expect(await second).not.toBeNull();
    expect((await overview)?.state).toBe("read");
    changes.close(owner);
  });

  it("the demo machine's overview lists the 4-pane tab's live agents and the many-languages chat's agent", async () => {
    const changes = new ChangesService(await macMini(), { now: () => start });
    const overview = (await changes.overview({ id: 2 }, demoHostIds.macMini))!;
    const panes = overview.groups.flatMap((group) => group.rows.map((row) => row.pane.paneId));
    expect(panes).toEqual(expect.arrayContaining([...demoSplitTab.chats, "w6:p1"]));
  });
});

// New agent's runs for the recorded-order comparison: each a machine
// (new-agent-world.ts) and what is asked of it. The same file ran on 34da24eb to record what that build sent
// (new-agent-speed.test.ts keeps those logs); nothing here is newer than its door except a start id, which it ignores.

import { flush, newAgentWorld, type WorldOptions } from "./new-agent-world";

type World = Awaited<ReturnType<typeof newAgentWorld>>;

export interface Scenario {
  readonly name: string;
  readonly options: WorldOptions;
  /** Runs New agent (or two) and returns what each answered, or its error's words. */
  run(world: World, start: (request: Record<string, unknown>) => Promise<unknown>): Promise<unknown>;
}

const answered = (work: Promise<unknown>): Promise<unknown> =>
  work.then(
    (result) => result,
    (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }),
  );

const tab = (kind: string) => ({ workspaceId: "w1", folder: "/fixture", kind });

export const scenarios: readonly Scenario[] = [
  {
    name: "Herdr's own start, integration current",
    options: { integrations: { claude: "current" } },
    run: (_world, start) => answered(start(tab("claude"))),
  },
  {
    name: "Herdr's own start, integration outdated (updated first)",
    options: { integrations: { claude: "outdated" } },
    run: (_world, start) => answered(start(tab("claude"))),
  },
  {
    name: "Herdr's own start, integration missing (installed first)",
    options: { integrations: { codex: "not_installed" } },
    run: (_world, start) => answered(start(tab("codex"))),
  },
  {
    name: "Herdr's own start, integration install stalled past its bound",
    options: { integrations: { codex: "not_installed" }, install: "hold" },
    run: async (world, start) => {
      const run = answered(start(tab("codex")));
      await flush();
      world.rings[0]?.();
      const result = await run;
      world.release();
      await flush();
      return result;
    },
  },
  {
    name: "Herdr's own start, integration install refused",
    options: { integrations: { codex: "not_installed" }, install: "refuse" },
    run: (_world, start) => answered(start(tab("codex"))),
  },
  {
    name: "Herdr refuses the start: its pane closed",
    options: { integrations: { claude: "current" }, refuseStart: "launch_failed" },
    run: (_world, start) => answered(start(tab("claude"))),
  },
  {
    name: "Herdr's own start, the program not installed",
    options: { integrations: { claude: "current" }, paneText: "zsh: command not found: claude" },
    run: (_world, start) => answered(start(tab("claude"))),
  },
  {
    name: "a typed start, integration current",
    options: { integrations: { claude: "current" }, agentsJson: { claude: "cl" } },
    run: (_world, start) => answered(start(tab("claude"))),
  },
  {
    name: "a typed start whose agent comes on the third look",
    options: { integrations: { claude: "current" }, agentsJson: { claude: "cl" }, typedAfterLooks: 2 },
    run: (_world, start) => answered(start(tab("claude"))),
  },
  {
    name: "a typed start, integration outdated",
    options: { integrations: { claude: "outdated" }, agentsJson: { claude: "cl" } },
    run: (_world, start) => answered(start(tab("claude"))),
  },
  {
    name: "a split right, Herdr's own start",
    options: { integrations: { claude: "current" } },
    run: (world, start) =>
      answered(start({ workspaceId: "w1", folder: "/fixture", kind: "claude", where: { type: "split", direction: "right", targetPaneId: "w1:p1", binding: world.bind("w1:p1") } })),
  },
  {
    name: "a shell",
    options: { integrations: { claude: "current" } },
    run: (_world, start) => answered(start(tab("shell"))),
  },
  {
    name: "two typed starts at once",
    options: { integrations: { claude: "current" }, agentsJson: { claude: "cl" } },
    run: async (_world, start) => Promise.all([answered(start(tab("claude"))), answered(start(tab("claude")))]),
  },
];

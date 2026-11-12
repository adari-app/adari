// The demo's fixtures read from the repo (what src/main/demo/bundled.ts bundles), for tests.

import { readFileSync } from "node:fs";
import path from "node:path";

import type { DemoFixtures } from "../../src/main/demo/demo-hosts";
import { fixturesRoot } from "./swift-fixtures";

const read = (file: string): Buffer => readFileSync(path.join(fixturesRoot, file));
const json = (file: string): unknown => JSON.parse(read(file).toString("utf8"));

export function bundledFixturesForTests(): DemoFixtures {
  return {
    sidebarWorkspaces: json("protocol22/sidebar-workspaces.json") as unknown[],
    sidebarTabs: json("protocol22/sidebar-tabs.json") as unknown[],
    sidebarPanes: json("protocol22/sidebar-panes.json") as unknown[],
    mockAgentList: json("protocol22/mock-agent-list.json"),
    idle: new Uint8Array(read("replay/idle.hfx")),
    heavy: new Uint8Array(read("replay/heavy-excerpt.hfx")),
    bashDialog: read("replay/claude-2.1.303-bash-dialog.txt").toString("utf8"),
  };
}

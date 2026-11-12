// The demo's fixtures, bundled into the main process by esbuild
// (scripts/build.mjs: JSON as data, .hfx as bytes, .txt as text). These are
// copies of the repo's own fixtures (test/fixtures-sync.test.ts keeps them
// identical to Tests/HerdrKitTests and the replay recordings).

import mockAgentList from "../../../fixtures/protocol22/mock-agent-list.json";
import sidebarPanes from "../../../fixtures/protocol22/sidebar-panes.json";
import sidebarTabs from "../../../fixtures/protocol22/sidebar-tabs.json";
import sidebarWorkspaces from "../../../fixtures/protocol22/sidebar-workspaces.json";
import bashDialog from "../../../fixtures/replay/claude-2.1.303-bash-dialog.txt";
import heavy from "../../../fixtures/replay/heavy-excerpt.hfx";
import idle from "../../../fixtures/replay/idle.hfx";
import type { DemoFixtures } from "./demo-hosts";

export const bundledDemoFixtures: DemoFixtures = {
  sidebarWorkspaces,
  sidebarTabs,
  sidebarPanes,
  mockAgentList,
  idle,
  heavy,
  bashDialog,
};

// The window's report for the notifications, the Dock badge and the menu bar item (src/renderer/needs-report.ts,
// wired in App.tsx): the sidebar's own Needs you rows, each with the pill its row shows and its machine answering
// now; a search in the sidebar hides nothing from it; a list that did not change is not sent again.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  const hooks = { ...fakeReact, useLayoutEffect: fakeReact.useEffect };
  return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});
vi.mock("electron", () => ({ ipcMain: { handle: () => undefined, on: () => undefined } }));

import type { NeedsYouReport } from "../src/shared/needs-notify";
import { fixturePanes, machine, page, settle } from "./support/manage-page";

const { layoutStore } = await import("../src/renderer/split/layout-store");
const { escapeOwners } = await import("../src/renderer/components/escape-owners");
const { handoffStore } = await import("../src/renderer/handoff/handoff-state");
const { startCommandsStore } = await import("../src/renderer/components/resume");

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

const waiting = fixturePanes.map((pane) => (pane.id === "w1:p3" ? { ...pane, status: "blocked" } : pane));

async function open() {
  const reports: NeedsYouReport[] = [];
  const p = await page({ hosts: [machine(waiting)], bridge: { reportNeedsYou: (report: NeedsYouReport) => reports.push(report) } });
  cleanup = p.unmount;
  for (let i = 0; i < 4; i += 1) await settle();
  return { p, reports };
}

describe("the window's needs-you report", () => {
  it("sends the sidebar's Needs you rows with their shown texts, and the machine answering on its connection", async () => {
    const { p, reports } = await open();
    const sidebar = p.sidebar()["sidebar"] as { needsYou: { row: { paneID: string } }[] };
    expect(sidebar.needsYou.map((entry) => entry.row.paneID)).toEqual(["w1:p3"]);
    expect(reports.at(-1)).toEqual({
      rows: [{ hostId: "host", paneId: "w1:p3", name: "claude", pill: "Awaiting Input", project: "app", machine: "Mac mini", summary: null }],
      waiting: [["host", "w1:p3"]],
      total: 1,
      live: [{ hostId: "host", epoch: "2:3" }],
    });
  });

  it("keeps every needing agent while the sidebar searches for something else, and sends a change once", async () => {
    const { p, reports } = await open();
    const before = reports.length;
    (p.sidebar()["onSearch"] as (text: string | null) => void)("codex");
    await settle();
    expect((p.sidebar()["sidebar"] as { needsYou: unknown[] }).needsYou).toEqual([]);
    expect(reports.length).toBe(before);
    expect(reports.at(-1)!.rows.map((row) => row.paneId)).toEqual(["w1:p3"]);
    // The agent stops needing you: one report with none.
    p.hosts([machine(fixturePanes)]);
    await settle();
    expect(reports.at(-1)).toMatchObject({ rows: [], waiting: [], total: 0 });
    expect(reports.length).toBe(before + 1);
  });
});

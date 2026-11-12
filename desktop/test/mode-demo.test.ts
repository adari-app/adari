// The demo's Claude, Codex, Grok and Cursor panes (Mac
// mini) show their approval modes and take a pick the way the agents do,
// through the demo's own pane.read, pane.send_text and pane.send_keys:
// Claude's and Grok's Shift+Tab, Cursor's toggles, Codex's /permissions list
// (and its Full Access confirmation); captures 91-96 come after 86-87, the
// last ones on main.

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { cursorFooterMode, readCursorScreen, readGrokScreen } from "../src/shared/agent-settings";
import { codexHistoryMode, codexModeOfTurn, readClaudeModeScreen, readCodexScreen } from "../src/shared/approval-modes";
import { driveModePick, type ModeIO } from "../src/main/herdr/mode-pick";

const claudePane = "w7:p1G";
const codexPane = "w5:pH";
const grokPane = "wD:pK";
const cursorPane = "wC:p1";

async function macMini() {
  const { DemoBackend } = await import("../src/main/demo/demo-backend");
  const { demoHostIds, demoHosts } = await import("../src/main/demo/demo-hosts");
  const { bundledFixturesForTests } = await import("./support/demo-fixtures");
  const fixtures = bundledFixturesForTests();
  const host = demoHosts(fixtures, Date.now()).find((each) => each.descriptor.id === demoHostIds.macMini)!;
  const backend = new DemoBackend(host, fixtures);
  // The approval over the Grok pane's box, answered as capture 82 does (its 3 alone): its box shows again.
  await backend.promptIO().paneSendKeys(grokPane, ["3"]);
  return { backend, host };
}

type Backend = Awaited<ReturnType<typeof macMini>>["backend"];

/** The pick's IO over the demo machine's own requests (what main's bound pick sends). */
function io(backend: Backend, paneID: string): ModeIO {
  return {
    read: () => backend.paneText(paneID, 80),
    type: (text) => backend.sendText(paneID, text),
    keys: (keys) => backend.promptIO().paneSendKeys(paneID, keys),
    check: () => null,
    wait: async () => undefined,
  };
}


describe("the demo's panes show their modes", () => {
  it("Claude auto, Grok always-approve, Cursor's default, Codex's rollout Ask for approval", async () => {
    const { backend, host } = await macMini();
    expect(readClaudeModeScreen(await backend.paneText(claudePane, 80))?.mode).toBe("auto");
    expect(readGrokScreen(await backend.paneText(grokPane, 80))?.mode).toBe("alwaysApprove");
    const cursor = readCursorScreen(await backend.paneText(cursorPane, 80));
    expect(cursor.kind === "box" && cursor.footer !== null ? cursorFooterMode(cursor.footer) : null).toBe("default");
    const rollout = host.transcripts.find((each) => each.paneID === codexPane)!;
    const turns = rollout.lines.map((line) => JSON.parse(line) as { type: string; payload: Record<string, unknown> }).filter((line) => line.type === "turn_context");
    expect(turns.map((turn) => codexModeOfTurn(turn.payload))).toEqual(["ask"]);
    const codex = readCodexScreen(await backend.paneText(codexPane, 80));
    expect(codex.kind === "box" && codex.empty).toBe(true);
    backend.close();
  });
});

describe("the demo's panes take a pick as the agents do", () => {
  it("Claude: Shift+Tab to plan, then round to auto", async () => {
    const { backend } = await macMini();
    expect((await driveModePick(io(backend, claudePane), "claude", "plan")).result).toEqual({ type: "set", mode: "plan" });
    expect(readClaudeModeScreen(await backend.paneText(claudePane, 80))?.mode).toBe("plan");
    expect((await driveModePick(io(backend, claudePane), "claude", "auto")).result).toEqual({ type: "set", mode: "auto" });
    backend.close();
  });

  it("Grok: Shift+Tab to plan (always-approve, default, plan)", async () => {
    const { backend } = await macMini();
    expect((await driveModePick(io(backend, grokPane), "grok", "plan")).result).toEqual({ type: "set", mode: "plan" });
    expect(readGrokScreen(await backend.paneText(grokPane, 80))?.mode).toBe("plan");
    backend.close();
  });

  it("Cursor: /run-everything, then Auto-review, then back to Run Everything through both off", async () => {
    const { backend } = await macMini();
    for (const target of ["runEverything", "autoReview", "runEverything", "default"]) {
      const done = await driveModePick(io(backend, cursorPane), "cursor", target);
      expect(done.result.type === "set" ? done.result.mode : done.result).toBe(target);
    }
    backend.close();
  });

  it("Codex: /permissions, its list, the digit; Full Access confirmed in the pick; its history row says so", async () => {
    const { backend } = await macMini();
    expect((await driveModePick(io(backend, codexPane), "codex", "approve")).result).toEqual({ type: "set", mode: "approve" });
    let screen = readCodexScreen(await backend.paneText(codexPane, 80));
    expect(screen.kind === "box" ? codexHistoryMode(screen.last) : null).toBe("approve");
    expect((await driveModePick(io(backend, codexPane), "codex", "full")).result).toEqual({ type: "set", mode: "full" });
    screen = readCodexScreen(await backend.paneText(codexPane, 80));
    expect(screen.kind === "box" ? codexHistoryMode(screen.last) : null).toBe("full");
    expect((await driveModePick(io(backend, codexPane), "codex", "full")).result).toEqual({ type: "set", mode: "full" });
    expect(readCodexScreen(await backend.paneText(codexPane, 80)).kind).toBe("box");
    backend.close();
  });
});

describe("captures 91-96", () => {
  it("the chip on each agent, Codex's menu open, a pick's result; after 86-87, only the drawer's, the agents' 121-125 and the ring's 126-130 after them", async () => {
    const { modesCaptureSteps } = await import("../src/main/capture");
    const { demoHostIds } = await import("../src/main/demo/demo-hosts");
    const steps = modesCaptureSteps(demoHostIds);
    expect(steps.map((step) => step.name)).toEqual([
      "91-mode-chip-claude",
      "92-mode-chip-grok",
      "93-mode-chip-cursor",
      "94-mode-chip-codex",
      "95-mode-menu-codex",
      "96-mode-pick-codex",
    ]);
    const panes = steps.slice(0, 4).map((step) => step.commands.find((command) => command.type === "select-pane"));
    expect(panes.map((command) => (command?.type === "select-pane" ? command.paneId : null))).toEqual([claudePane, grokPane, cursorPane, codexPane]);
    expect(steps[4]!.commands).toEqual([{ type: "click", selector: ".cmp-bar .chip.pick.mode .pick-b" }]);
    // 91 zooms the Claude pane out of its split (its box has room for the word); 92 puts its tab back.
    expect(steps[0]!.commands.at(-1)).toEqual({ type: "zoom-pane", hostId: demoHostIds.macMini, paneId: claudePane, zoomed: true });
    expect(steps[1]!.commands[0]).toEqual({ type: "zoom-pane", hostId: demoHostIds.macMini, paneId: claudePane, zoomed: false });
    expect(steps.every((step) => step.measure !== undefined)).toBe(true);
    const main = readFileSync(path.join(__dirname, "../src/main/main.ts"), "utf8");
    const at = (call: string): number => main.indexOf(`...${call}(demoHostIds)`);
    expect(at("modesCaptureSteps")).toBeGreaterThan(at("sidebarFoldedCaptureSteps"));
    // Only the drawer's captures come after these, of the demo's, then the agents' 121-125, then the ring's 126-130.
    expect(main.slice(at("modesCaptureSteps") + 1).match(/\.\.\.\w+CaptureSteps\(demoHostIds\)/gu)).toEqual([
      "...terminalDrawerCaptureSteps(demoHostIds)",
      "...agentsCaptureSteps(demoHostIds)",
      "...ringCaptureSteps(demoHostIds)",
      // Cursor's Model chip read only 200 last (the steps between take callbacks).
      "...cursorPickCaptureSteps(demoHostIds)",
      // The three Early kinds' badge, a Claude Code pane without it 230-233 (last).
      "...twotierCaptureSteps(demoHostIds)",
    ]);
  });
});

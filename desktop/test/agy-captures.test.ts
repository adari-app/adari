// Antigravity CLI's model captures (src/main/agy-models-captures.ts, 294-299) and the demo's Antigravity CLI pane they start
// (src/main/demo/demo-agy-pane.ts): its screen reads as the samples' do (the box empty and idle, the last row's mode,
// model and level), `/model <id>` and Return set the model ("Model set to <label>" above the box), Shift+Tab cycles
// the mode as the samples' README says, a draft takes what is typed after it.

import { describe, expect, it } from "vitest";

import { agyModelsCaptureSteps } from "../src/main/agy-models-captures";
import { DemoAgyPane, demoAgyModeOrder } from "../src/main/demo/demo-agy-pane";
import { demoHostIds } from "../src/main/demo/demo-hosts";
import { agyBoxEmpty, readAgyStatusRow } from "../src/shared/agy-input";

describe("the captures 294-299", () => {
  it("New agent's two rows, the start, the pane's chips and their two menus", () => {
    const steps = agyModelsCaptureSteps(demoHostIds);
    expect(steps.map((step) => step.name)).toEqual([
      "294-agy-new-agent-models",
      "295-agy-new-agent-neon-xhigh",
      "296-agy-started",
      "297-agy-chat-chips",
      "298-agy-model-list",
      "299-agy-effort-menu",
    ]);
    expect(steps[0]!.commands).toContainEqual({ type: "open-new-agent", hostId: demoHostIds.buildBox, workspaceId: "w3" });
    expect(steps[0]!.page![0]).toContain('[data-kind="agy"]');
    expect(steps[1]!.page![0]).toContain("gemini-4-neon-high");
    expect(steps[1]!.page![0]).toContain('"xhigh"');
    // New agent opens the pane it made, in Chat: no pane id named.
    expect(steps[3]!.commands).toEqual([{ type: "set-tab", tab: "chat" }]);
  });
});

describe("the demo's Antigravity CLI pane", () => {
  it("at its start: the box empty and idle, the last row auto · Gemini 4 Hydrogen · low", () => {
    const pane = new DemoAgyPane("w3:pn1");
    expect(agyBoxEmpty(pane.screen())).toBe(true);
    expect(readAgyStatusRow(pane.screen())).toEqual({ mode: "auto", model: "Gemini 4 Hydrogen", level: "low" });
  });

  it("started with --model <id>: that row's model and level", () => {
    expect(readAgyStatusRow(new DemoAgyPane("p", "gemini-4-neon-xhigh").screen())).toEqual({ mode: "auto", model: "Gemini 4 Neon", level: "xhigh" });
    expect(readAgyStatusRow(new DemoAgyPane("p", "gemini-pro-orchestrator-neon").screen())).toEqual({ mode: "auto", model: "Orchestrator", level: "neon" });
    expect(readAgyStatusRow(new DemoAgyPane("p", "nope").screen())?.model).toBe("Gemini 4 Hydrogen");
  });

  it("/model <id> and Return: Model set to <label> above the box, the last row says it", () => {
    const pane = new DemoAgyPane("p");
    pane.type("/model gemini-3.8-flash-medium");
    expect(agyBoxEmpty(pane.screen())).toBe(false);
    pane.keys(["Enter"]);
    expect(pane.screen()).toContain("Model set to Gemini 3.8 Flash (Medium)");
    expect(agyBoxEmpty(pane.screen())).toBe(true);
    expect(readAgyStatusRow(pane.screen())).toEqual({ mode: "auto", model: "Gemini 3.8 Flash", level: "medium" });
    // An id not on the list changes nothing.
    pane.type("/model gemini-9");
    pane.keys(["Enter"]);
    expect(readAgyStatusRow(pane.screen())?.model).toBe("Gemini 3.8 Flash");
  });

  it("Shift+Tab: auto, plan, none shown (asks), accept-edits, auto", () => {
    const pane = new DemoAgyPane("p");
    const seen: (string | undefined)[] = [];
    for (let press = 0; press < 4; press += 1) {
      pane.keys(["BTab"]);
      seen.push(readAgyStatusRow(pane.screen())?.mode);
    }
    expect(seen).toEqual(["plan", "default", "acceptEdits", "auto"]);
    expect([...demoAgyModeOrder]).toEqual(["auto", "plan", "default", "acceptEdits"]);
  });

  it("a draft takes what is typed after it; Backspace takes a character back", () => {
    const pane = new DemoAgyPane("p");
    pane.type("half");
    pane.type("/model gemini-4-neon-high");
    pane.keys(["Backspace"]);
    expect(pane.draft).toBe("half/model gemini-4-neon-hig");
    pane.keys(["Enter"]);
    expect(readAgyStatusRow(pane.screen())?.model).toBe("Gemini 4 Hydrogen");
  });
});

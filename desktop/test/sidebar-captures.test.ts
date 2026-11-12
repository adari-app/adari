// The demo's captures of the left list. 84 without the
// Changes and While you were away cards and 85 the agents that need you with
// T3's pill beside the working ones come after send's 44 and before the
// needs-card captures (45-50) answer the demo's dialogs, so the Edit and the
// Bash still read as approvals (Pending Approval) and bookshop's question as
// Awaiting Input. 86, a folded project that keeps its agent that needs you
// (the header's amber dot and count), comes last, after closing the rename
// field 61 leaves on that header. Each is measured: the cards absent, each
// needs-you row's pill, color and fit, the working rows without a pill, the
// folded headers' counts.

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { sidebarCaptureSteps, sidebarFoldedCaptureSteps } from "../src/main/capture";
import { demoHostIds } from "../src/main/demo/demo-hosts";

describe("the sidebar's captures", () => {
  it("84 without the cards, 85 the needs-you pills, 86 a folded project with one, each measured", () => {
    const steps = [...sidebarCaptureSteps(demoHostIds), ...sidebarFoldedCaptureSteps(demoHostIds)];
    expect(steps.map((step) => step.name)).toEqual(["84-sidebar-no-cards", "85-needs-you-row", "86-folded-needs", "87-folded-machine-needs"]);
    for (const step of steps) {
      for (const probe of [".sb-changes", ".away-line", ".row.ny", ".pill", "fits", ".fit", ".g.work", ".nyn", ".host-ny"]) {
        expect(step.measure, `${step.name} measures ${probe}`).toContain(probe);
      }
    }
    // 84: nothing open, both machines unfolded, then a mode change puts the list at its top.
    const [first, second, folded, machine] = steps as [(typeof steps)[number], (typeof steps)[number], (typeof steps)[number], (typeof steps)[number]];
    expect(first.commands).toEqual(
      expect.arrayContaining([
        { type: "show-away", shown: false },
        { type: "set-changes-overview", shown: false },
        { type: "set-host-folded", hostId: demoHostIds.macMini, folded: false },
        { type: "set-host-folded", hostId: demoHostIds.buildBox, folded: false },
        { type: "clear-selection" },
      ]),
    );
    expect(first.commands.slice(-2)).toEqual([
      { type: "set-mode", mode: "priority" },
      { type: "set-mode", mode: "projects" },
    ]);
    // 85: a working agent open, the list at Quartz, where Notes Opus needs you.
    expect(second.commands).toEqual([{ type: "select-pane", hostId: demoHostIds.macMini, paneId: "w7:p1" }]);
    expect(second.page).toEqual([expect.stringContaining(`.host[data-host=\\"${demoHostIds.macMini}\\"] .ws-hw[data-ws=\\"w2\\"]`)]);
    // 86: 61's rename field closed (its Esc cancels it), then Quartz's header clicked and shown.
    expect(folded.page).toHaveLength(3);
    expect(folded.page![0]).toContain(".rn-in");
    expect(folded.page![0]).toContain(`key: "Escape"`);
    expect(folded.page![1]).toContain(`.ws-hw[data-ws=\\"w2\\"] .ws-h`);
    expect(folded.page![1]).toContain("click()");
    // 87: both machines folded and the Needs you group folded; each machine keeps its row.
    expect(machine.commands).toEqual(
      expect.arrayContaining([
        { type: "set-host-folded", hostId: demoHostIds.macMini, folded: true },
        { type: "set-host-folded", hostId: demoHostIds.buildBox, folded: true },
      ]),
    );
    expect(machine.page).toEqual([expect.stringContaining(".grp-h")]);
  });

  it("84-85 come between send's 44 and the needs card's 45, 86-87 after the cursor captures (the Codex tool calls' 88-90 follow, then the modes' 91-96, then the host key's 97-98, then the settings' 106-114, then the terminal drawer's 115-120, then the agents' 121-125, then the ring's 126-130, then the tall card's 131-133, then the updates' 134-140, then the folder pick's 141-148, then the start errors' 149-154, then the Codex session's 155-157, then the integrations' 158-162, then the links and chips' 163-168, then the first chat's 169-172, then the compact's 173-174, then the take-back's 175-176, then the start questions' 177-180, then the pickers' 181-187, then the Chat support's 190-196, then the Cursor pick's 200, then the later groups)", async () => {
    const { sendCaptureSteps, needsCardCaptureSteps, cursorLiveCaptureSteps } = await import("../src/main/capture");
    expect(sendCaptureSteps(demoHostIds).at(-1)!.name).toBe("44-multiline-sent-at-end");
    expect(needsCardCaptureSteps(demoHostIds)[0]!.name).toBe("45-needs-card-run");
    expect(cursorLiveCaptureSteps(demoHostIds).at(-1)!.name).toBe("67-cursor-live-landed");
    const main = readFileSync(path.join(__dirname, "../src/main/main.ts"), "utf8");
    const at = (call: string): number => main.indexOf(`...${call}(demoHostIds)`);
    expect(at("sendCaptureSteps")).toBeGreaterThan(0);
    expect(at("sidebarCaptureSteps")).toBeGreaterThan(at("sendCaptureSteps"));
    expect(at("needsCardCaptureSteps")).toBeGreaterThan(at("sidebarCaptureSteps"));
    expect(at("sidebarFoldedCaptureSteps")).toBeGreaterThan(at("cursorLiveCaptureSteps"));
    // The Codex tool-call captures (88-90) come after 86-87; the modes' 91-96 after them;
    // the host key's 97-98 (a machine's new host key, then Cancel) after every earlier capture, so its dialog covers none.
    // The agents captures come after 98 (its Cancel closed the dialog), so the earlier captures see none of its agents.
    const after = main.slice(at("sidebarFoldedCaptureSteps") + 1);
    // The terminal drawer's 115-120 come after the settings' 106-114; then the agents' 121-125; the ring's 126-130;
    // the tall card's 131-133; the updates' 134-140 (its fake updater is put back after 140); the folder pick's 141-148
    // (its This Mac is taken out again after 148); the start errors' 149-154, the Codex session's 155-157 and
    // the integrations' 158-162 after them; the links and chips' 163-168 (the window's size and build-box's build shell
    // put back after 168 and 164); the compact's 173-174 (its pane's status put back after 174); the take-back's
    // 175-176 (its pane's status and screen put back after 176); the start questions' 177-180
    // (each closes the pane its New agent made); the pickers' 181-187 (the pane its New agent made
    // closed after 187); the Chat support's 190-196 (the demo's integrations put back after 194);
    // the Cursor pick's 200 (Cursor's Model chip read only; nothing picked).
    expect(after.match(/\.\.\.\w+CaptureSteps\(/gu)).toEqual([
      "...codexAskCaptureSteps(",
      "...modesCaptureSteps(",
      "...hostKeyCaptureSteps(",
      "...settingsCaptureSteps(",
      "...terminalDrawerCaptureSteps(",
      "...agentsCaptureSteps(",
      "...ringCaptureSteps(",
      "...tallCardCaptureSteps(",
      "...updateCaptureSteps(",
      "...folderPickCaptureSteps(",
      "...startFixCaptureSteps(",
      "...codexSessionCaptureSteps(",
      "...integrationsCaptureSteps(",
      "...linksChipsCaptureSteps(",
      "...firstChatCaptureSteps(",
      "...compactCaptureSteps(",
      "...takeBackCaptureSteps(",
      "...startQuestionCaptureSteps(",
      "...pickersCaptureSteps(",
      "...chatSupportCaptureSteps(",
      "...cursorPickCaptureSteps(",
      // The icons, Cursor's list from This Mac, Codex's update card, Claude's note 201-204.
      "...listsCaptureSteps(",
      "...livepickCaptureSteps(",
      // The not-sent line and Grok's kept pick 220-222 (Grok's pane put back after 222).
      "...livefixCaptureSteps(",
      // The three Early kinds' badge, a Claude Code pane without it 230-233 (last).
      "...twotierCaptureSteps(",
    ]);
  });
});

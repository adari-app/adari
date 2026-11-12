// The frame probe: `--splits-probe=<file>` runs the demo, sets the window up as
// each scenario says (the app commands the captures use), then times the
// page's animation frames for a while and collects the long tasks Chromium
// reports (PerformanceObserver "longtask"), in the page itself through
// executeJavaScript. The numbers (shared/frame-probe.ts) go to <file> as JSON.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { BrowserWindow } from "electron";

import { frameStats, type FrameStats, type LongTask } from "../shared/frame-probe";
import type { AppCommands, CommandBody } from "./capture";
import { demoSplitTab } from "./demo/demo-hosts";

export interface ProbeScenario {
  readonly name: string;
  readonly what: string;
  readonly commands: readonly CommandBody[];
  /** Let it run before timing (terminals attached, chats loaded). */
  readonly settleMs: number;
  readonly durationMs: number;
}

export interface ProbeResult {
  readonly name: string;
  readonly what: string;
  readonly stats: FrameStats;
}

/** The page's side: every frame's time since the one before, and the long tasks, over `durationMs`. */
export function framesProbeScript(durationMs: number): string {
  return `new Promise((resolve) => {
  const deltas = [];
  const tasks = [];
  let observer = null;
  try {
    observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) tasks.push({ durationMs: entry.duration });
    });
    observer.observe({ type: "longtask", buffered: false });
  } catch (error) {
    observer = null;
  }
  let last = null;
  let start = null;
  const tick = (now) => {
    if (start === null) start = now;
    if (last !== null) deltas.push(now - last);
    last = now;
    if (now - start < ${Math.max(100, Math.round(durationMs))}) {
      requestAnimationFrame(tick);
      return;
    }
    if (observer !== null) observer.disconnect();
    resolve({ deltas, tasks, durationMs: now - start, longTasksObserved: observer !== null });
  };
  requestAnimationFrame(tick);
})`;
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface RawProbe {
  readonly deltas: number[];
  readonly tasks: LongTask[];
  readonly durationMs: number;
  readonly longTasksObserved: boolean;
}

/** Runs each scenario and writes the numbers to `file`. */
export async function runFramesProbe(window: BrowserWindow, commands: AppCommands, file: string, scenarios: readonly ProbeScenario[]): Promise<ProbeResult[]> {
  await commands.ready(30_000);
  const results: ProbeResult[] = [];
  let observed = true;
  for (const scenario of scenarios) {
    for (const command of scenario.commands) await commands.send(window.webContents, command);
    await wait(scenario.settleMs);
    const raw = (await window.webContents.executeJavaScript(framesProbeScript(scenario.durationMs), true)) as RawProbe;
    observed &&= raw.longTasksObserved;
    results.push({ name: scenario.name, what: scenario.what, stats: frameStats(raw.deltas, raw.tasks, raw.durationMs) });
  }
  const [contentWidth, contentHeight] = window.getContentSize();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    `${JSON.stringify(
      {
        probedAt: new Date().toISOString(),
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        window: { contentWidth, contentHeight, scaleFactor: window.webContents.zoomFactor },
        longTasksObserved: observed,
        results,
      },
      null,
      2,
    )}\n`,
  );
  return results;
}

/**
 * The probe's scenarios on the demo: the Mac mini's split tab as four tiles,
 * its two agents' Chats following their live transcripts and its two shells'
 * terminals printing, timed for 10 s; then a two-tile tab for comparison.
 */
export function demoProbeScenarios(ids: { macMini: string }): ProbeScenario[] {
  return [
    {
      name: "four-tiles-live",
      what: "The demo's split tab as four tiles: two Claude panes in Chat following their live transcripts (a step every 1.4 s), two shells in Terminal printing a log (the heavy-excerpt recording, looping)",
      commands: [
        { type: "set-mode", mode: "projects" },
        { type: "set-host-folded", hostId: ids.macMini, folded: false },
        { type: "select-pane", hostId: ids.macMini, paneId: demoSplitTab.panes[0] },
      ],
      settleMs: 4_000,
      durationMs: 10_000,
    },
    {
      name: "two-tiles",
      what: "For comparison: workers 1 as two tiles, both Claude panes in Chat (aurora-web-mac's following its transcript, which grows only when sent to)",
      commands: [{ type: "select-pane", hostId: ids.macMini, paneId: "w7:p1G" }],
      settleMs: 3_000,
      durationMs: 10_000,
    },
  ];
}

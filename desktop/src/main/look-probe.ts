// The look probe (--look-probe=<dir>, in demo mode): it scrolls the
// long demo chat with real wheel input while Chromium traces, and writes the
// frame times the page saw (its animation frames) and the layout work traced
// in the scroll's window (Layout, UpdateLayoutTree, Paint, PrePaint); the same
// on a working pane, whose clock ticks once a second; then it types 1, 3, 10
// and 30 lines into the message box, captures each, and sends.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

import { contentTracing, type BrowserWindow } from "electron";

import type { AppCommands, CommandBody } from "./capture";

export interface FrameStats {
  readonly frames: number;
  readonly seconds: number;
  readonly fps: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
  /** Frame intervals over 1.5 times the median: a display frame missed. */
  readonly missed: number;
}

const round = (value: number): number => Math.round(value * 100) / 100;

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]!;
}

/** Frame times from the page's requestAnimationFrame stamps (ms). */
export function frameStats(stamps: readonly number[]): FrameStats {
  const intervals = stamps.slice(1).map((stamp, i) => stamp - stamps[i]!);
  const sorted = [...intervals].sort((a, b) => a - b);
  const seconds = stamps.length < 2 ? 0 : (stamps.at(-1)! - stamps[0]!) / 1_000;
  const p50 = quantile(sorted, 0.5);
  return {
    frames: intervals.length,
    seconds: round(seconds),
    fps: seconds === 0 ? 0 : round(intervals.length / seconds),
    p50Ms: round(p50),
    p95Ms: round(quantile(sorted, 0.95)),
    p99Ms: round(quantile(sorted, 0.99)),
    maxMs: round(sorted.at(-1) ?? 0),
    missed: intervals.filter((ms) => ms > p50 * 1.5).length,
  };
}

export interface TraceEvent {
  readonly name?: string;
  readonly ph?: string;
  readonly ts?: number;
  readonly dur?: number;
  readonly pid?: number;
  readonly tid?: number;
  readonly args?: { readonly data?: { readonly message?: string }; readonly name?: string };
}

function markWindow(events: readonly TraceEvent[], start: string, end: string): { from: number; to: number } | null {
  const mark = (message: string): number | undefined => events.find((event) => event.name === "TimeStamp" && event.args?.data?.message === message)?.ts;
  const from = mark(start);
  const to = mark(end);
  return from === undefined || to === undefined ? null : { from, to };
}

function threadNames(events: readonly TraceEvent[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const event of events) {
    if (event.ph === "M" && event.name === "thread_name" && event.args?.name !== undefined) names.set(`${event.pid}/${event.tid}`, event.args.name);
  }
  return names;
}

/** The compositor's frames (DrawFrame on a Compositor thread) between the marks, as frame times. */
export function compositorFrames(events: readonly TraceEvent[], start: string, end: string): FrameStats | null {
  const window = markWindow(events, start, end);
  if (window === null) return null;
  const names = threadNames(events);
  const stamps = events
    .filter((event) => event.name === "DrawFrame" && event.ts !== undefined && event.ts >= window.from && event.ts <= window.to && names.get(`${event.pid}/${event.tid}`) === "Compositor")
    .map((event) => event.ts! / 1_000)
    .sort((a, b) => a - b);
  return frameStats(stamps);
}

export interface Stall {
  readonly thread: string;
  readonly name: string;
  readonly atMs: number;
  readonly ms: number;
}

/** Tasks over `overMs` on any thread between the marks, longest first (at most 8). */
export function stalls(events: readonly TraceEvent[], start: string, end: string, overMs = 50): Stall[] {
  const window = markWindow(events, start, end);
  if (window === null) return [];
  const names = threadNames(events);
  return events
    .filter((event) => event.ph === "X" && (event.dur ?? 0) > overMs * 1_000 && event.ts !== undefined && event.ts >= window.from && event.ts <= window.to)
    .map((event) => ({
      thread: names.get(`${event.pid}/${event.tid}`) ?? `${event.pid}/${event.tid}`,
      name: event.name ?? "",
      atMs: round((event.ts! - window.from) / 1_000),
      ms: round(event.dur! / 1_000),
    }))
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 8);
}

export const layoutEventNames = ["Layout", "UpdateLayoutTree", "Paint", "PrePaint"] as const;

export interface LayoutWork {
  readonly windowMs: number;
  readonly counts: Readonly<Record<(typeof layoutEventNames)[number], number>>;
  readonly totalMs: Readonly<Record<(typeof layoutEventNames)[number], number>>;
}

/** The layout work traced between the page's two console.timeStamp marks. */
export function layoutWork(events: readonly TraceEvent[], start: string, end: string): LayoutWork | null {
  const window = markWindow(events, start, end);
  if (window === null) return null;
  const { from, to } = window;
  const counts = { Layout: 0, UpdateLayoutTree: 0, Paint: 0, PrePaint: 0 };
  const totals = { Layout: 0, UpdateLayoutTree: 0, Paint: 0, PrePaint: 0 };
  for (const event of events) {
    const name = event.name as (typeof layoutEventNames)[number] | undefined;
    if (name === undefined || !layoutEventNames.includes(name)) continue;
    if (event.ph !== "X" && event.ph !== "B") continue;
    if (event.ts === undefined || event.ts < from || event.ts > to) continue;
    counts[name] += 1;
    totals[name] += (event.dur ?? 0) / 1_000;
  }
  return {
    windowMs: round((to - from) / 1_000),
    counts,
    totalMs: { Layout: round(totals.Layout), UpdateLayoutTree: round(totals.UpdateLayoutTree), Paint: round(totals.Paint), PrePaint: round(totals.PrePaint) },
  };
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function page<T>(window: BrowserWindow, script: string): Promise<T> {
  return window.webContents.executeJavaScript(script, true) as Promise<T>;
}

export interface ScrollRun {
  readonly label: string;
  readonly what: string;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  readonly scrolledDownTo: number;
  readonly scrolledBackTo: number;
  readonly frames: FrameStats;
  /** Frames over 50 ms the page reported (long-animation-frame entries). */
  readonly longFrames: number;
  readonly layout: LayoutWork | null;
  readonly layoutPerFrame: number | null;
  /** The renderer compositor's frames (DrawFrame): what reached the screen. */
  readonly compositor: FrameStats | null;
  /** Tasks over 50 ms on any thread while it scrolled. */
  readonly stalls: readonly Stall[];
  readonly trace: string;
}

const startScript = `(() => {
  const probe = { stamps: [], long: 0, on: true };
  window.__lookProbe = probe;
  const tick = (t) => { if (!probe.on) return; probe.stamps.push(t); requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  try { new PerformanceObserver((list) => { probe.long += list.getEntries().length; }).observe({ type: "long-animation-frame" }); } catch {}
  console.timeStamp("look-probe-start");
  return true;
})()`;

const stopScript = `(() => {
  const probe = window.__lookProbe;
  probe.on = false;
  console.timeStamp("look-probe-end");
  return { stamps: probe.stamps, long: probe.long };
})()`;

/** Wheel input down the whole chat over 3 s, then back up over 3 s, one event every 8 ms. */
async function scrollRun(window: BrowserWindow, commands: AppCommands, directory: string, label: string, what: string, setup: readonly CommandBody[]): Promise<ScrollRun> {
  for (const command of setup) await commands.send(window.webContents, command);
  await wait(1_500);
  const geometry = await page<{ x: number; y: number; height: number; client: number } | null>(
    window,
    // A wheel event first (only the user's gesture lets the Chat go of its end; a bare scroll goes back to it).
    `(() => { const s = document.querySelector(".chat-scroll"); if (s === null) return null; s.dispatchEvent(new WheelEvent("wheel", { deltaY: -1, bubbles: true })); s.scrollTop = 0; const r = s.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 3), height: s.scrollHeight, client: s.clientHeight }; })()`,
  );
  if (geometry === null) throw new Error(`${label}: no chat to scroll`);
  await wait(500);
  await contentTracing.startRecording({ included_categories: ["devtools.timeline", "disabled-by-default-devtools.timeline.frame", "toplevel"] });
  await page(window, startScript);
  const stepMs = 8;
  const steps = Math.round(3_000 / stepMs);
  const delta = Math.max(1, (geometry.height - geometry.client) / steps);
  let scrolledDownTo = 0;
  for (const direction of [1, -1]) {
    for (let i = 0; i < steps; i += 1) {
      window.webContents.sendInputEvent({ type: "mouseWheel", x: geometry.x, y: geometry.y, deltaX: 0, deltaY: -direction * delta, hasPreciseScrollingDeltas: true, canScroll: true });
      await wait(stepMs);
    }
    await wait(200);
    if (direction === 1) scrolledDownTo = await page<number>(window, `document.querySelector(".chat-scroll").scrollTop`);
  }
  const result = await page<{ stamps: number[]; long: number }>(window, stopScript);
  const scrolledBackTo = await page<number>(window, `document.querySelector(".chat-scroll").scrollTop`);
  const trace = await contentTracing.stopRecording(path.join(directory, `trace-${label}.json`));
  const parsed = JSON.parse(readFileSync(trace, "utf8")) as TraceEvent[] | { traceEvents: TraceEvent[] };
  const events = Array.isArray(parsed) ? parsed : parsed.traceEvents;
  const layout = layoutWork(events, "look-probe-start", "look-probe-end");
  const frames = frameStats(result.stamps);
  return {
    label,
    what,
    scrollHeight: geometry.height,
    clientHeight: geometry.client,
    scrolledDownTo: Math.round(scrolledDownTo),
    scrolledBackTo: Math.round(scrolledBackTo),
    frames,
    longFrames: result.long,
    layout,
    layoutPerFrame: layout === null || frames.frames === 0 ? null : round((layout.counts.Layout + layout.counts.UpdateLayoutTree) / frames.frames),
    compositor: compositorFrames(events, "look-probe-start", "look-probe-end"),
    stalls: stalls(events, "look-probe-start", "look-probe-end"),
    trace,
  };
}

export interface BoxStep {
  readonly lines: number | "sent";
  readonly file: string;
  readonly boxHeight: number;
  readonly overflowY: string;
  readonly wrapHeight: number;
  readonly insetHeight: number;
  /** The chat's distance from its end: 0 while it keeps its end pinned. */
  readonly gapToEnd: number;
}

const measureScript = `(() => {
  const t = document.querySelector(".cmp textarea");
  const s = document.querySelector(".chat-scroll");
  const w = document.querySelector(".cmp-wrap.float");
  const i = document.querySelector(".chat-inset");
  return { boxHeight: Math.round(t.getBoundingClientRect().height * 100) / 100, overflowY: getComputedStyle(t).overflowY, wrapHeight: w.offsetHeight, insetHeight: i.offsetHeight, gapToEnd: Math.round(s.scrollHeight - s.scrollTop - s.clientHeight) };
})()`;

function typeScript(text: string): string {
  return `(() => {
    const t = document.querySelector(".cmp textarea");
    t.focus();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(t, ${JSON.stringify(text)});
    t.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`;
}

const sample = (n: number): string =>
  Array.from({ length: n }, (_, i) => `Line ${i + 1}: check the release notes against the tests and say what is missing.`).join("\n");

async function boxRun(window: BrowserWindow, commands: AppCommands, directory: string, setup: readonly CommandBody[]): Promise<BoxStep[]> {
  for (const command of setup) await commands.send(window.webContents, command);
  await wait(1_500);
  await page(window, `(() => { const s = document.querySelector(".chat-scroll"); s.scrollTop = s.scrollHeight; return true; })()`);
  await wait(300);
  const steps: BoxStep[] = [];
  const shoot = async (lines: number | "sent"): Promise<void> => {
    await wait(500);
    const file = path.join(directory, lines === "sent" ? "11-box-after-send.png" : `11-box-${String(lines).padStart(2, "0")}-lines.png`);
    writeFileSync(file, (await window.webContents.capturePage()).toPNG());
    steps.push({ lines, file, ...(await page<Omit<BoxStep, "lines" | "file">>(window, measureScript)) });
  };
  for (const lines of [1, 3, 10, 30]) {
    await page(window, typeScript(sample(lines)));
    await shoot(lines);
  }
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Return" });
  window.webContents.sendInputEvent({ type: "char", keyCode: "\r" });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Return" });
  await wait(1_000);
  await shoot("sent");
  return steps;
}

/** Runs the probe (the page ready) and writes look-probe.json, the traces and the box's captures to `directory`. */
export async function runLookProbe(window: BrowserWindow, commands: AppCommands, directory: string, ids: { macMini: string }): Promise<string> {
  mkdirSync(directory, { recursive: true });
  const [width, height] = window.getContentSize();
  const scrolls = [
    await scrollRun(window, commands, directory, "finished-chat", "The long finished demo chat (Mac mini, sundial pane: 11 exchanges, code blocks in 12 languages, a table)", [
      { type: "set-mode", mode: "projects" },
      { type: "set-host-folded", hostId: ids.macMini, folded: false },
      { type: "select-pane", hostId: ids.macMini, paneId: "w6:p1" },
      { type: "set-tab", tab: "chat" },
    ]),
    await scrollRun(window, commands, directory, "working-chat", "A working pane's chat (Mac mini, aurora-web-mac): its Working for clock ticks once a second while it scrolls", [
      { type: "select-pane", hostId: ids.macMini, paneId: "w7:p1G" },
      { type: "set-tab", tab: "chat" },
    ]),
  ];
  const box = await boxRun(window, commands, directory, [
    { type: "select-pane", hostId: ids.macMini, paneId: "w6:p1" },
    { type: "set-tab", tab: "chat" },
  ]);
  const file = path.join(directory, "look-probe.json");
  writeFileSync(
    file,
    `${JSON.stringify({ probedAt: new Date().toISOString(), electron: process.versions.electron, chrome: process.versions.chrome, window: { width, height }, scrolls, box }, null, 2)}\n`,
  );
  return file;
}

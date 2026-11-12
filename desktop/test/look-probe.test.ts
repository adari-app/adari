// The look probe's arithmetic. Frame times from the page's
// animation-frame stamps (rate, percentiles, frames missed), and the layout
// work Chromium traced between the page's two marks.

import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ contentTracing: {} }));

const { compositorFrames, frameStats, layoutWork, stalls } = await import("../src/main/look-probe");

describe("frame times", () => {
  it("reads 120 Hz from a steady 8.33 ms cadence, with nothing missed", () => {
    const stamps = Array.from({ length: 121 }, (_, i) => 1_000 + i * (1_000 / 120));
    expect(frameStats(stamps)).toEqual({ frames: 120, seconds: 1, fps: 120, p50Ms: 8.33, p95Ms: 8.33, p99Ms: 8.33, maxMs: 8.33, missed: 0 });
  });

  it("counts a frame that took two display frames as missed, and shows it at the tail", () => {
    const stamps = [0, 16.7, 33.4, 66.8, 83.5, 100.2];
    const stats = frameStats(stamps);
    expect(stats.frames).toBe(5);
    expect(stats.p50Ms).toBe(16.7);
    expect(stats.maxMs).toBe(33.4);
    expect(stats.missed).toBe(1);
  });

  it("is all zeros with fewer than two stamps", () => {
    expect(frameStats([5])).toEqual({ frames: 0, seconds: 0, fps: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0, missed: 0 });
  });
});

describe("layout work in the scroll's window", () => {
  const mark = (message: string, ts: number) => ({ name: "TimeStamp", ph: "I", ts, args: { data: { message } } });
  const work = (name: string, ts: number, dur: number) => ({ name, ph: "X", ts, dur });

  it("counts Layout, UpdateLayoutTree, Paint and PrePaint between the marks only, with their time", () => {
    const events = [
      work("Layout", 500, 3_000),
      mark("start", 1_000),
      work("Layout", 2_000, 1_500),
      work("UpdateLayoutTree", 3_000, 200),
      work("Paint", 4_000, 800),
      work("Paint", 5_000, 400),
      work("FunctionCall", 5_500, 900),
      mark("end", 11_000),
      work("PrePaint", 12_000, 100),
    ];
    expect(layoutWork(events, "start", "end")).toEqual({
      windowMs: 10,
      counts: { Layout: 1, UpdateLayoutTree: 1, Paint: 2, PrePaint: 0 },
      totalMs: { Layout: 1.5, UpdateLayoutTree: 0.2, Paint: 1.2, PrePaint: 0 },
    });
  });

  it("is null when a mark is missing", () => {
    expect(layoutWork([mark("start", 1)], "start", "end")).toBeNull();
  });
});

describe("the compositor's frames and the stalls", () => {
  const meta = (pid: number, tid: number, name: string) => ({ ph: "M", name: "thread_name", pid, tid, args: { name } });
  const mark = (message: string, ts: number) => ({ name: "TimeStamp", ph: "I", ts, pid: 2, tid: 1, args: { data: { message } } });

  it("times the renderer compositor's DrawFrame events between the marks", () => {
    const events = [
      meta(2, 1, "CrRendererMain"),
      meta(2, 7, "Compositor"),
      meta(3, 4, "VizCompositorThread"),
      mark("start", 0),
      ...[1_000, 17_700, 34_400, 51_100].map((ts) => ({ name: "DrawFrame", ph: "I", ts, pid: 2, tid: 7 })),
      { name: "DrawFrame", ph: "I", ts: 20_000, pid: 3, tid: 4 },
      mark("end", 60_000),
      { name: "DrawFrame", ph: "I", ts: 67_800, pid: 2, tid: 7 },
    ];
    expect(compositorFrames(events, "start", "end")).toMatchObject({ frames: 3, p50Ms: 16.7, missed: 0 });
  });

  it("lists tasks over 50 ms on any thread, longest first, named by thread", () => {
    const events = [
      meta(1, 1, "CrBrowserMain"),
      meta(2, 1, "CrRendererMain"),
      mark("start", 0),
      { name: "ThreadControllerImpl::RunTask", ph: "X", ts: 10_000, dur: 120_000, pid: 1, tid: 1 },
      { name: "ThreadControllerImpl::RunTask", ph: "X", ts: 20_000, dur: 60_000, pid: 2, tid: 1 },
      { name: "ThreadControllerImpl::RunTask", ph: "X", ts: 30_000, dur: 40_000, pid: 2, tid: 1 },
      mark("end", 500_000),
    ];
    expect(stalls(events, "start", "end")).toEqual([
      { thread: "CrBrowserMain", name: "ThreadControllerImpl::RunTask", atMs: 10, ms: 120 },
      { thread: "CrRendererMain", name: "ThreadControllerImpl::RunTask", atMs: 20, ms: 60 },
    ]);
  });
});

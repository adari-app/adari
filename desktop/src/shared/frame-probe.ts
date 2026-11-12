// The frame probe's numbers: the time between
// animation frames over a run, and the long tasks the page reported, read
// into frames per second, percentiles, slow frames and a verdict (smooth:
// at least 55 fps and no long task over 50 ms).

export interface LongTask {
  readonly durationMs: number;
}

export interface FrameStats {
  readonly frames: number;
  readonly seconds: number;
  readonly fps: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
  /** Frames that took longer than one and a half 60 Hz frames (25 ms). */
  readonly slowFrames: number;
  readonly longTasks: number;
  readonly longTasksOver50: number;
  readonly longestTaskMs: number;
  readonly smooth: boolean;
}

const tenth = (value: number): number => Math.round(value * 10) / 10;

/** The nearest-rank percentile of sorted values. */
function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.max(1, Math.ceil(fraction * sorted.length));
  return sorted[Math.min(sorted.length, rank) - 1]!;
}

export function frameStats(deltasMs: readonly number[], longTasks: readonly LongTask[], durationMs: number): FrameStats {
  const sorted = [...deltasMs].sort((a, b) => a - b);
  const seconds = durationMs / 1_000;
  const fps = seconds > 0 ? Math.round(deltasMs.length / seconds) : 0;
  const over50 = longTasks.filter((task) => task.durationMs > 50).length;
  return {
    frames: deltasMs.length,
    seconds: tenth(seconds),
    fps,
    p50Ms: tenth(percentile(sorted, 0.5)),
    p95Ms: tenth(percentile(sorted, 0.95)),
    p99Ms: tenth(percentile(sorted, 0.99)),
    maxMs: tenth(sorted.at(-1) ?? 0),
    slowFrames: deltasMs.filter((delta) => delta > 25).length,
    longTasks: longTasks.length,
    longTasksOver50: over50,
    longestTaskMs: tenth(Math.max(0, ...longTasks.map((task) => task.durationMs))),
    smooth: fps >= 55 && over50 === 0,
  };
}

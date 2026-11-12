// The cold open's measurement (printed; the budgets are in chat-mac-cold.test.ts). A long, image-heavy
// Claude session opened cold in the Mac Chat over a 226 ms, 1.5 MB/s link (test/support/cold-link.ts), relay
// on and relay off: time to the first full screen, trips, bytes, bytes read twice, the blob share, and the
// launch cache's hand-over (the counts on show, cached then live). Part 3 (relay v1.2 reads): then the pictures
// on show fetched as their thumbnails ask, and one Load earlier as a click does.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { afterLine, cachedChat, coldFeedOpen, coldFetchShown, coldLoadEarlier, coldServiceOpen, coldSession, type ColdRun, type LinkMode } from "./support/cold-link";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
});

afterEach(() => {
  vi.useRealTimers();
});

const imageTurns = coldSession();
const longTurns = coldSession({ textTurns: 100, imageTurns: 8, rounds: 4 });
const modes: LinkMode[] = ["relay", "sftp"];

function report(run: ColdRun): void {
  console.log(run.summary);
}

describe("the cold open measured", () => {
  for (const mode of modes) {
    for (const [label, text] of [
      ["image turns", imageTurns],
      ["long image turns", longTurns],
    ] as const) {
      it(`${label}, no launch cache, relay ${mode === "relay" ? "on" : "off"}`, async () => {
        const { run, feed } = await coldFeedOpen({ mode, text, label });
        report(run);
        expect(run.firstLive).toBeDefined();
        // Part 3: the pictures on show fetched on show (relay v1.2; none to fetch on SFTP), then Load earlier once.
        console.log("  " + afterLine("pictures on show fetched", await coldFetchShown(run.link, feed), "pictures"));
        console.log("  " + afterLine("load earlier", await coldLoadEarlier(run.link, feed)));
        feed.stop();
      });
    }

    it(`image turns, the 60-item launch cache, relay ${mode === "relay" ? "on" : "off"}`, async () => {
      const cache = cachedChat(imageTurns);
      const { run, service } = await coldServiceOpen({ mode, text: imageTurns, cache, label: "image turns with the launch cache" });
      report(run);
      const counts = run.steps.map((step) => `${step.catchingUp ? "cache " : ""}${step.items}`);
      console.log(`  hand-over: on show ${counts.join(" -> ")}; live from ${run.handOver === undefined ? "never" : `${(run.handOver.at / 1_000).toFixed(2)} s with ${run.handOver.items} items`}`);
      console.log("  " + run.line("hand-over", run.handOver));
      expect(run.steps[0]?.catchingUp).toBe(true);
      service.closeAll();
    });
  }
});

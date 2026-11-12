// A Claude pane in virtual time (vitest's fake
// timers). Claude Code puts a cancelled message back in its box at a given
// moment; the box holds it until a clear (Ctrl+U) lands, `clearLatencyMs`
// after the keys went (Herdr's agent.send_keys and the terminal's redraw).
// Reads see the box as it is at that moment; keys are logged with the time.

import type { ClaudeBoxSite } from "../../src/main/herdr/claude-box";
import { claudeScreen } from "./claude-screens";
import { checkHerdrKeys } from "./herdr-keys";

export interface TimedBox extends ClaudeBoxSite {
  /** Keys as they went: [ms since the box was made, keys]. */
  readonly keyLog: [number, readonly string[]][];
  /** Reads: ms since the box was made. */
  readonly readLog: number[];
  /** Claude Code puts `text` in its box `atMs` after the box was made. */
  show(text: string, atMs: number): void;
  /** The box's text now. */
  draft(): string;
}

export function timedBox(clearLatencyMs: number): TimedBox {
  const start = Date.now();
  const now = (): number => Date.now() - start;
  const shows: { text: string; from: number }[] = [];
  const clears: { sent: number; lands: number }[] = [];
  const keyLog: [number, readonly string[]][] = [];
  const readLog: number[] = [];
  const draft = (): string => {
    const at = now();
    const current = shows.filter((show) => show.from <= at).at(-1);
    if (current === undefined) return "";
    return clears.some((clear) => clear.sent >= current.from && clear.lands <= at) ? "" : current.text;
  };
  return {
    keyLog,
    readLog,
    show: (text, atMs) => void shows.push({ text, from: atMs }),
    draft,
    read: async () => {
      readLog.push(now());
      return claudeScreen({ draft: draft() });
    },
    keys: async (keys) => {
      checkHerdrKeys(keys);
      keyLog.push([now(), [...keys]]);
      if (keys.includes("ctrl+u")) clears.push({ sent: now(), lands: now() + clearLatencyMs });
    },
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

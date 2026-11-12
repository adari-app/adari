// The terminal engine is Ghostty's VT core (ghostty-web's WASM build). As the
// Swift app's EngineReplayComparisonTests do, the repo's recorded Herdr attach
// streams are fed byte for byte at the grid they were recorded at, and at every
// tenth of each stream the screen must read as recorded, line for line.

import { readFileSync } from "node:fs";
import path from "node:path";

import { Ghostty } from "ghostty-web";
import { beforeAll, describe, expect, it } from "vitest";

import { screenText } from "../src/shared/ghostty-screen";
import { checkpointMarks, parseReplay, replayDuration, screenLines, ReplayFormatError } from "../src/shared/replay";
import { desktopRoot, fixturesRoot } from "./support/swift-fixtures";

interface Expected {
  readonly cols: number;
  readonly rows: number;
  readonly checkpoints: readonly { readonly chunk: number; readonly lines: readonly string[] }[];
}

let ghostty: Ghostty;

beforeAll(async () => {
  // Ghostty.load() resolves its embedded data: URL against `self.location`
  // (a browser global); in Node the same WASM (byte-identical to the embedded
  // copy) is instantiated from the package file with the one import it needs.
  const wasm = readFileSync(path.join(desktopRoot, "node_modules/ghostty-web/ghostty-vt.wasm"));
  const { instance } = await WebAssembly.instantiate(wasm, { env: { log: () => undefined } });
  ghostty = new Ghostty(instance);
});

function load(name: string): { recording: ReturnType<typeof parseReplay>; expected: Expected } {
  const bytes = new Uint8Array(readFileSync(path.join(fixturesRoot, "replay", `${name}.hfx`)));
  const expected = JSON.parse(readFileSync(path.join(fixturesRoot, "replay", `${name}.expected.json`), "utf8")) as Expected;
  return { recording: parseReplay(bytes), expected };
}

function compare(name: string): string {
  const { recording, expected } = load(name);
  expect(recording.cols).toBe(48);
  expect(recording.rows).toBe(30);
  expect(expected.cols).toBe(recording.cols);
  expect(expected.rows).toBe(recording.rows);
  expect(expected.checkpoints).toHaveLength(10);

  const marks = new Set(checkpointMarks(recording.chunks.length, 10));
  const terminal = ghostty.createTerminal(recording.cols, recording.rows);
  const screens: { chunk: number; text: string }[] = [];
  try {
    recording.chunks.forEach((chunk, index) => {
      terminal.write(chunk.bytes);
      if (marks.has(index + 1)) {
        terminal.update();
        screens.push({ chunk: index + 1, text: screenText(terminal, recording.rows) });
      }
    });
  } finally {
    terminal.free();
  }

  expect(screens.map((s) => s.chunk)).toEqual(expected.checkpoints.map((c) => c.chunk));
  screens.forEach((screen, i) => {
    const recorded = expected.checkpoints[i]!;
    expect(recorded.lines).toHaveLength(recording.rows);
    expect(screenLines(screen.text, recording.rows), `${name}: chunk ${screen.chunk}`).toEqual(recorded.lines);
  });
  return screens[screens.length - 1]?.text ?? "";
}

describe("Ghostty reads the recorded Herdr streams as recorded", () => {
  it("idle shell (colours, CJK, emoji, box drawing)", () => {
    const last = compare("idle");
    expect(last).toContain("日本語のテキスト 中文字符 한국어");
    expect(last).toContain("┌──────┬──────┐ ╔════╗ ╭────╮");
    expect(last).toContain("idle prompt: 日本語 ✓ ┃█░");
  });

  it("heavy log pane", () => {
    const last = compare("heavy-excerpt");
    for (const level of ["INFO", "DEBUG", "WARN", "ERROR", "TRACE"]) expect(last).toContain(level);
  });
});

describe("the HRDRFX01 reader", () => {
  it("reads the grid, the chunks and the duration", () => {
    const { recording } = load("idle");
    expect(recording.chunks.length).toBeGreaterThan(10);
    expect(replayDuration(recording)).toBeGreaterThan(0);
    for (let i = 1; i < recording.chunks.length; i += 1) {
      expect(recording.chunks[i]!.time).toBeGreaterThanOrEqual(recording.chunks[i - 1]!.time);
    }
  });

  it("marks every tenth chunk like the Swift checkpoints", () => {
    expect(checkpointMarks(12)).toEqual([1, 2, 3, 4, 6, 7, 8, 9, 10, 12]);
    expect(checkpointMarks(161)).toEqual([16, 32, 48, 64, 80, 96, 112, 128, 144, 161]);
  });

  it("refuses what is not a recording, or is cut short", () => {
    expect(() => parseReplay(new TextEncoder().encode("NOTAFIXTURE!"))).toThrow(ReplayFormatError);
    const { recording } = load("idle");
    const bytes = new Uint8Array(readFileSync(path.join(fixturesRoot, "replay", "idle.hfx")));
    expect(() => parseReplay(bytes.subarray(0, bytes.length - 1))).toThrow(ReplayFormatError);
    expect(recording.cols).toBe(48);
  });
});

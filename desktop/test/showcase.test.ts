// The invented setup (`--showcase`). Two machines answered
// through the real client and decoders, the sidebar they make (Needs you on top,
// every status), each pane's state, transcripts that parse cleanly in both
// formats (the live ones through every step), the split tabs of two and four,
// the terminals drawn at their size, and a permission dialog answered from the
// terminal moving the pane to Working.

import { readFileSync } from "node:fs";
import path from "node:path";

import { Ghostty } from "ghostty-web";
import { beforeAll, describe, expect, it } from "vitest";

import { DemoBackend, type DemoClock } from "../src/main/demo/demo-backend";
import type { DemoTranscript } from "../src/main/demo/demo-chat";
import { showcaseFolders, showcasePaneIds as ids } from "../src/main/showcase/showcase-chat";
import { showcaseStudioGit, showcaseGpuGit } from "../src/main/showcase/showcase-git";
import { showcaseFourTab, showcaseHeroTab, showcaseHostIds, showcaseHosts } from "../src/main/showcase/showcase-hosts";
import { claudeScene, fit, visibleLength, wrap } from "../src/main/showcase/showcase-terminal";
import { parseLaunchOptions } from "../src/main/launch-options";
import { HerdrClient } from "../src/main/herdr/client";
import type { SessionTopology } from "../src/main/herdr/wire";
import { ChatTimelineBuilder } from "../src/shared/chat/builder";
import { TranscriptParser } from "../src/shared/chat/parser";
import { buildDesktopSidebar, type SidebarHost } from "../src/shared/desktop-sidebar";
import { screenText } from "../src/shared/ghostty-screen";
import { screenLines } from "../src/shared/replay";
import { desktopRoot } from "./support/swift-fixtures";

const start = 1_800_000_000_000;
const minute = 60_000;

/** Timers that run only when the test advances them. */
class FakeClock implements DemoClock {
  now = 0;
  private sequence = 0;
  private tasks: { at: number; seq: number; run: () => void; cancelled: boolean }[] = [];

  schedule(run: () => void, delayMs: number): () => void {
    const task = { at: this.now + delayMs, seq: this.sequence++, run, cancelled: false };
    this.tasks.push(task);
    return () => {
      task.cancelled = true;
    };
  }

  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      const due = this.tasks.filter((t) => !t.cancelled && t.at <= end).sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
      if (due === undefined) break;
      this.tasks.splice(this.tasks.indexOf(due), 1);
      this.now = due.at;
      due.run();
    }
    this.now = end;
  }
}

async function machines(clock = new FakeClock()) {
  return Promise.all(
    showcaseHosts(start, () => start + clock.now).map(async (host) => {
      const backend = new DemoBackend(host, null, clock, () => start + clock.now);
      return { host, backend, topology: await backend.snapshot() };
    }),
  );
}

function sidebarHosts(list: Awaited<ReturnType<typeof machines>>): SidebarHost[] {
  return list.map(({ host, topology }) => ({ id: host.descriptor.id, name: host.descriptor.name, platform: host.descriptor.platform, state: "connected", error: null, topology }));
}

describe("the showcase setup", () => {
  it("is two invented machines answered through the real client", async () => {
    const [studio, gpu] = await machines();
    expect([studio!.host.descriptor.name, studio!.host.descriptor.platform, gpu!.host.descriptor.name, gpu!.host.descriptor.platform]).toEqual(["Mac Studio", "macOS", "gpu-box", "Linux"]);
    expect(studio!.topology.workspaces.map((w) => w.label)).toEqual(["storefront", "ios-app", "docs"]);
    expect(gpu!.topology.workspaces.map((w) => w.label)).toEqual(["api", "infra"]);
    const panes = studio!.topology.panes.length + gpu!.topology.panes.length;
    expect(panes).toBeGreaterThanOrEqual(10);
    expect(panes).toBeLessThanOrEqual(14);
    expect(JSON.parse(studio!.backend.transport.requests[0] ?? "{}")).toMatchObject({ method: "session.snapshot" });
  });

  it("is reached with --showcase or --showcase-capture, each a demo", () => {
    expect(parseLaunchOptions(["--showcase"])).toMatchObject({ demo: true, showcase: true, showcaseCaptureDir: null });
    expect(parseLaunchOptions(["--showcase-capture=/x/shots"])).toMatchObject({ demo: true, showcase: true, showcaseCaptureDir: "/x/shots" });
    expect(parseLaunchOptions(["--demo"])).toMatchObject({ demo: true, showcase: false });
  });

  it("gives the sidebar Needs you first, then every status, with each pane's state", async () => {
    const list = await machines();
    const sidebar = buildDesktopSidebar(sidebarHosts(list), { nowUnixMs: start + minute / 2 });
    expect(sidebar.needsYou.map((row) => [row.key, row.row.name])).toEqual([[`${showcaseHostIds.gpu}/${ids.passkeys}`, "Passkeys for sign in"]]);
    expect(sidebar.badge).toBe(1);
    const rows = sidebar.hosts.flatMap((h) => h.model?.projects.flatMap((p) => p.rows.map((r) => [h.host.name, r.workspaceLabel, r.name, r.kind, r.glyph])) ?? []);
    expect(rows).toEqual([
      ["Mac Studio", "storefront", "Add Apple Pay", "claude", "working"],
      ["Mac Studio", "storefront", "Fix the flaky cart test", "claude", "working"],
      ["Mac Studio", "storefront", "Faster product page", "claude", "working"],
      ["Mac Studio", "ios-app", "Order Live Activity", "claude", "doneUnseen"],
      ["Mac Studio", "ios-app", "Dark mode receipts", "codex", "working"],
      ["Mac Studio", "ios-app", "Reorder widget", "claude", "working"],
      ["Mac Studio", "ios-app", "Cart sheet crash", "codex", "working"],
      ["Mac Studio", "docs", "Apple Pay guide", "claude", "doneUnseen"],
      ["Mac Studio", "docs", "terminal", "shell", "shell"],
      ["gpu-box", "api", "Passkeys for sign in", "claude", "needsYou"],
      ["gpu-box", "api", "Rate limit search", "codex", "doneUnseen"],
      ["gpu-box", "infra", "Postgres 17 upgrade", "claude", "doneUnseen"],
      ["gpu-box", "infra", "Restore check", "codex", "idle"],
    ]);
    // One idle shell.
    expect(rows.filter((row) => row[4] === "shell")).toHaveLength(1);
  });

  it("has the split tabs: the hero's two and the release tab's four", async () => {
    const [studio] = await machines();
    const client = new HerdrClient(studio!.backend.transport);
    const hero = await client.paneLayout(showcaseHeroTab.chat);
    expect(hero.panes.map((p) => p.paneId)).toEqual([showcaseHeroTab.chat, showcaseHeroTab.terminal]);
    const four = await client.paneLayout(showcaseFourTab.chats[0]);
    expect(four.panes.map((p) => p.paneId).sort()).toEqual([...showcaseFourTab.chats, ...showcaseFourTab.terminals].sort());
    expect(studio!.topology.tabs.find((t) => t.tabID === showcaseHeroTab.tabId)?.label).toBe("checkout");
  });

  it("gives every agent pane a transcript and every agent folder git", async () => {
    const list = await machines();
    for (const { host, topology } of list) {
      for (const pane of topology.panes.filter((p) => p.agent !== undefined)) {
        const transcript = host.transcripts.find((t) => t.paneID === pane.paneID);
        expect(transcript?.cwd, pane.paneID).toBe(pane.cwd);
        expect(transcript?.agent, pane.paneID).toBe(pane.agent);
      }
    }
    const folders = [...Object.keys(showcaseStudioGit.folders), ...Object.keys(showcaseGpuGit.folders)].sort();
    expect(folders).toEqual(Object.values(showcaseFolders).sort());
  });
});

/** A transcript's whole text, its live steps included (once through). */
function wholeText(transcript: DemoTranscript): string {
  const lines = [...transcript.lines];
  if (transcript.live !== undefined) {
    for (let index = 0; index < 200; index += 1) lines.push(...transcript.live.step(index, start + index * transcript.live.everyMs));
  }
  return lines.join("\n") + "\n";
}

describe("the showcase transcripts", () => {
  it("parse cleanly in their agent's format, working ones mid-turn and the rest finished", async () => {
    const transcripts = (await machines()).flatMap(({ host }) => host.transcripts);
    expect(transcripts.length).toBe(12);
    for (const transcript of transcripts) {
      const parser = new TranscriptParser(transcript.agent);
      const builder = new ChatTimelineBuilder();
      builder.apply(parser.parseText(wholeText(transcript)));
      const turns = builder.timeline.turns;
      expect(parser.stats.unparseable, transcript.paneID).toBe(0);
      expect(parser.stats.malformed, transcript.paneID).toBe(0);
      expect(turns.length, transcript.paneID).toBeGreaterThan(0);
      // The pane that needs you is mid-turn too: its last call waits on the dialog.
      expect(turns.at(-1)!.isFinished, transcript.paneID).toBe(!transcript.working && transcript.paneID !== ids.passkeys);
    }
  });

  it("has a reply with a code block and a table, tool rows and progress lines", async () => {
    const transcripts = (await machines()).flatMap(({ host }) => host.transcripts);
    const text = transcripts.map((t) => t.lines.join("\n")).join("\n");
    expect(text).toContain("```ts");
    expect(text).toContain("| Browser | Apple Pay | Fallback |");
    expect(text).toContain('"type":"tool_use"');
    expect(text).toContain('"thinkingDisplay":"updates"');
    expect(text).toContain('"type":"function_call"');
    expect(transcripts.filter((t) => t.live !== undefined).map((t) => t.paneID).sort()).toEqual([ids.applePay, ids.pdp, ids.receipts].sort());
  });

  it("stops a live transcript after its last step", async () => {
    const live = (await machines()).flatMap(({ host }) => host.transcripts).find((t) => t.paneID === ids.applePay)!.live!;
    expect(live.step(0, start).length).toBeGreaterThan(0);
    expect(live.step(500, start)).toEqual([]);
  });
});

describe("the showcase terminals", () => {
  let ghostty: Ghostty;

  beforeAll(async () => {
    const wasm = readFileSync(path.join(desktopRoot, "node_modules/ghostty-web/ghostty-vt.wasm"));
    const { instance } = await WebAssembly.instantiate(wasm, { env: { log: () => undefined } });
    ghostty = new Ghostty(instance);
  });

  async function screen(paneId: string, cols: number, rows: number, ms: number, keys?: string) {
    const clock = new FakeClock();
    const list = await machines(clock);
    const machine = list.find(({ topology }) => topology.panes.some((p) => p.paneID === paneId))!;
    const terminal = ghostty.createTerminal(cols, rows);
    const handle = await machine.backend.openTerminal(machine.topology.panes.find((p) => p.paneID === paneId)!, { cols, rows }, { data: (bytes) => terminal.write(bytes), exit: () => undefined });
    clock.advance(ms);
    if (keys !== undefined) {
      handle.input(new TextEncoder().encode(keys));
      clock.advance(ms);
    }
    terminal.update();
    const lines = screenLines(screenText(terminal, rows), rows);
    terminal.free();
    return { lines, machine };
  }

  it("draws Claude Code's look at the terminal's size, the cart suite running", async () => {
    expect((await screen(ids.cart, 80, 60, 500)).lines.join("\n")).toContain("Claude Code");
    const { lines } = await screen(ids.cart, 80, 40, 12_000);
    expect(lines.join("\n")).toContain("vitest run test/cart --repeat=50");
    expect(lines.join("\n")).toMatch(/Testing… \(\d+s/);
    expect(lines.every((line) => line.length <= 80)).toBe(true);
  });

  it("draws Codex's look and an idle shell with its prompt", async () => {
    expect((await screen(ids.sheet, 90, 40, 6_000)).lines.join("\n")).toContain(">_ OpenAI Codex");
    expect((await screen(ids.docsShell, 80, 24, 100)).lines.join("\n")).toContain("sam@Mac-Studio docs %");
  });

  it("answers the permission dialog from the terminal: the migration runs and the pane is working", async () => {
    const waiting = await screen(ids.passkeys, 100, 40, 1_000);
    expect(waiting.lines.join("\n")).toContain("Do you want to proceed?");
    const answered = await screen(ids.passkeys, 100, 40, 3_000, "\r");
    expect(answered.lines.join("\n")).not.toContain("Do you want to proceed?");
    expect(answered.lines.join("\n")).toContain("applying 0042_add_passkeys.sql");
    const topology: SessionTopology = await answered.machine.backend.snapshot();
    const sidebar = buildDesktopSidebar(
      [{ id: showcaseHostIds.gpu, name: "gpu-box", platform: "Linux", state: "connected", error: null, topology }],
      { nowUnixMs: start + minute },
    );
    expect(sidebar.needsYou).toEqual([]);
    expect(sidebar.hosts[0]!.model!.projects[0]!.rows[0]).toMatchObject({ name: "Passkeys for sign in", glyph: "working" });
  });

  it("keeps a scene's lines within the width, its styles closed", () => {
    expect(wrap("one two three four", 9)).toEqual(["one two", "three", "four"]);
    const styled = "\u001b[1mBold\u001b[0m and plain text";
    expect(visibleLength(styled)).toBe(19);
    expect(visibleLength(fit(styled, 6))).toBe(6);
    const frame = claudeScene({ folder: "~/x", items: [{ at: 0, kind: "say", text: "a ".repeat(100) }], working: true }).frame(1_000, 40, 20);
    expect(frame).toHaveLength(20);
    expect(frame.every((line) => visibleLength(fit(line, 40)) <= 40)).toBe(true);
  });
});

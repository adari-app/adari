// Cursor and Grok chips: the boundaries of each pick's guards, the same
// results as the iPhone app's Cursor chips tests where both apps have it.

import { describe, expect, it, vi } from "vitest";

import { DemoCursorMenu } from "../src/main/demo/demo-cursor-menu";
import { DemoGrokPane } from "../src/main/demo/demo-grok-pane";
import { cursorPickTexts, driveCursorPick, driveGrokPick, grokPickTexts, pickCursorBound, pickGrokBound, type CursorMenuIO } from "../src/main/herdr/send";
import { PaneInputs } from "../src/main/pane-inputs";
import { AgentSettingsReader, readCursorScreen, tapReader, type CursorPick } from "../src/shared/agent-settings";
import { cursorMenuScreen } from "./support/cursor-menu-fixtures";

const head = cursorMenuScreen("model-00002").split("\n").slice(0, 10);
const folder = "/Users/demo/shed-plan";

/** The fake Cursor pane as the driver's IO; `glitch` may change what a read shows (the 1st read is the first look). */
function cursorPane(menu: DemoCursorMenu, glitch: (read: number, screen: string) => string = (_read, screen) => screen) {
  const log: string[] = [];
  let reads = 0;
  const io: CursorMenuIO = {
    read: async () => glitch(++reads, menu.screen()),
    type: async (text) => {
      log.push(`type ${text}`);
      menu.type(text);
    },
    keys: async (keys) => {
      log.push(keys.join(","));
      menu.keys(keys);
    },
    check: () => null,
  };
  return { io, log };
}

const driveCursor = (menu: DemoCursorMenu, pick: CursorPick, glitch?: (read: number, screen: string) => string) => {
  const p = cursorPane(menu, glitch);
  return driveCursorPick(p.io, pick).then((done) => ({ ...done, log: p.log }));
};

describe("only Cursor's own selector, unfiltered with one current row, is driven", () => {
  it("the recorded selectors read; a filter, no current row or two do not", () => {
    for (const name of ["model-00004", "selector", "selector-after-high", "after-esc-1"]) {
      expect(readCursorScreen(cursorMenuScreen(name)), name).toEqual({ kind: "models", current: "Grok 4.7" });
    }
    const selector = cursorMenuScreen("selector");
    expect(readCursorScreen(selector.replace("\n Filter:", "\n Filter: Grok")).kind).toBe("other");
    expect(readCursorScreen(selector.replace(" \u{2192}  Grok 4.7", "    Grok 4.7")).kind).toBe("other");
    expect(readCursorScreen(selector.replace("    Auto", " \u{2192}  Auto")).kind).toBe("other");
    expect(readCursorScreen(selector.replace("\n Filter:", "\n Search:")).kind).toBe("other");
  });

  // A filtered selector does not read as the selector, so it gets no Esc either.
  it("a filtered selector gets no key: nothing after Enter, no pick, a note", async () => {
    const menu = new DemoCursorMenu(head, folder);
    // The 4th read is the selector after Enter (the 3rd, the list again right before it).
    const done = await driveCursor(menu, { kind: "effort", value: "high" }, (read, shown) => (read === 4 ? shown.replace("\n Filter:", "\n Filter: Grok") : shown));
    expect(done.log).toEqual(["type /model", "Enter"]);
    expect(done.result).toEqual({ type: "refused", note: cursorPickTexts.elsewhere, footer: null });
    expect(menu.state).toMatchObject({ stage: "models", effort: "medium" });
  });
});

// MARK: - Cursor footer cache

const { AgentPicks, confirmWaitMs } = await import("../src/renderer/components/agent-picks");
const cursorFooterValue = { model: "Grok 4.7", window: "256K", effort: "medium", fast: false, percent: 6.8 } as const;
const cursorBinding = (connection: number, arrival: number, session: string | null = null) =>
  ({ terminalID: "t", isAgent: true, kind: "cursor", session, run: { connection, arrival } }) as const;

describe("Desktop's Cursor footer cache follows the connection, run and session", () => {
  it("a footer read under one run shows only for that run", () => {
    const picks = new AgentPicks({ send: async () => undefined, copy: () => undefined, now: () => 0 });
    picks.receiveFooter("h/p", { scope: { terminalID: "t", session: null }, run: { connection: 1, arrival: 1 }, footer: cursorFooterValue });
    expect(picks.cursorFooter("h/p", cursorBinding(1, 1))).toEqual(cursorFooterValue);
    expect(picks.cursorFooter("h/p", cursorBinding(2, 1))).toBeNull();
    expect(picks.cursorFooter("h/p", cursorBinding(1, 2))).toBeNull();
  });

  it("the pane gone, or shown under another run: the footer is dropped, not kept for later", () => {
    const picks = new AgentPicks({ send: async () => undefined, copy: () => undefined, now: () => 0 });
    picks.receiveFooter("h/p", { scope: { terminalID: "t", session: null }, footer: cursorFooterValue });
    picks.sync("h/p", null);
    expect(picks.cursorFooter("h/p", cursorBinding(1, 1))).toBeNull();
    picks.receiveFooter("h/p", { scope: { terminalID: "t", session: null }, run: { connection: 1, arrival: 1 }, footer: cursorFooterValue });
    picks.sync("h/p", { hostId: "h", paneId: "p", agent: "cursor", status: "idle", binding: cursorBinding(2, 1) });
    expect(picks.cursorFooter("h/p", cursorBinding(1, 1))).toBeNull();
  });

  it("main clears the page's footer for a new identity before its read; an unread footer leaves none", async () => {
    const { LiveReads } = await import("../src/main/chat/live-reads");
    const { HostRegistry } = await import("../src/main/hosts");
    const { PaneReadGate } = await import("../src/shared/chat/live-reader");
    const { backend, FakeHerdr, snapshot } = await import("./support/prompt-herdr");
    class CursorHerdr extends FakeHerdr {
      shown: string | null = cursorMenuScreen("model-00002");
      override roundTrip(line: string): Promise<string> {
        const request = JSON.parse(line) as { id: unknown; method: string; params: Record<string, unknown> };
        if (request.method !== "pane.read" || request.params["pane_id"] !== "w1:p3") return super.roundTrip(line);
        if (this.shown === null) return Promise.resolve(JSON.stringify({ id: request.id, error: { code: "pane_not_found", message: "gone" } }));
        const read = { pane_id: "w1:p3", workspace_id: "w1", tab_id: "w1:t1", source: "recent", format: "text", text: this.shown, revision: 1, truncated: false };
        return Promise.resolve(JSON.stringify({ id: request.id, result: { type: "pane_read", read } }));
      }
    }
    for (const fails of [false, true]) {
      const json = snapshot();
      const pane = (json["panes"] as Record<string, unknown>[])[2]!;
      pane["agent"] = "cursor";
      pane["agent_status"] = "idle";
      const herdr = new CursorHerdr(json, {});
      if (fails) herdr.shown = null;
      const registry = new HostRegistry(() => undefined);
      registry.add({ id: "mac", name: "Mac mini", kind: "demo", address: "demo", platform: "macOS" }, backend(herdr, { value: 1 }));
      await registry.refreshAll();
      const events: { footer: unknown; run?: unknown }[] = [];
      const owner = { id: 1, send: () => undefined, isDestroyed: () => false };
      const live = new LiveReads(registry, () => [{ owner, slot: "", follow: 1, hostId: "mac", paneId: "w1:p3" }], () => undefined, {
        gate: new PaneReadGate(),
        footer: (_chat, event) => events.push(event),
      });
      live.sync();
      await new Promise((resolve) => setTimeout(resolve, 20));
      const run = registry.run("mac", "w1:p3");
      expect(run).not.toBeNull();
      expect(events[0]).toMatchObject({ footer: null, run });
      expect(events.slice(1).map((event) => event.footer)).toEqual(fails ? [] : [{ model: "Grok 4.7", window: "256K", effort: "medium", fast: false, percent: null }]);
      live.closeAll();
    }
  });
});

// MARK: - Enter and the user's text

const typedOver = "send this user text";

/** A pane whose state `before` may change ahead of a read (the 1st read is the first look); every write logged. */
function scripted<T extends { screen(): string; type(text: string): void; keys(keys: readonly string[]): void }>(fake: T, before: (read: number) => void = () => undefined) {
  const log: string[] = [];
  let reads = 0;
  const io: CursorMenuIO = {
    read: async () => {
      before(++reads);
      return fake.screen();
    },
    type: async (text) => {
      log.push(`type ${text}`);
      fake.type(text);
    },
    keys: async (keys) => {
      log.push(keys.join(","));
      fake.keys(keys);
    },
    check: () => null,
  };
  return { io, log };
}

const grokFiles = { model: "grok-4.7", effort: "high", window: "256k" };

/** A bound pick's machine: the fake pane behind Herdr's calls, its status and its input generation as the test sets them. */
function boundSite<T extends { screen(): string; type(text: string): void; keys(keys: readonly string[]): void }>(fake: T, kind: "cursor" | "grok", afterType: (site: { status: string; generation: number }) => void = () => undefined) {
  const state = { status: "idle", generation: 4 };
  const writes: string[] = [];
  const site = {
    writer: {
      sendText: async (_pane: string, text: string) => {
        writes.push(text);
        fake.type(text);
        afterType(state);
      },
    } as never,
    calls: {
      paneRead: async () => fake.screen(),
      paneSendKeys: async (_pane: string, keys: readonly string[]) => {
        writes.push(keys.join(","));
        fake.keys(keys);
      },
    },
    fresh: async () => true,
    pane: () => ({ paneID: "p", terminalID: "t", agent: kind, agentStatus: state.status }) as never,
    agent: () => ({ paneID: "p", agent: kind, agentStatus: state.status }) as never,
    run: () => ({ connection: 1, arrival: 1 }),
    inputGeneration: () => state.generation,
  };
  const binding = { terminalID: "t", isAgent: true, kind, session: null, run: { connection: 1, arrival: 1 } } as const;
  return { site, binding, writes, state };
}

describe("Enter goes only on the screen just verified, with no Terminal input since the pick began", () => {
  it("Cursor: the command replaced by the user's text right after its read: no Enter, their text left", async () => {
    const menu = new DemoCursorMenu(head, folder);
    const p = scripted(menu, (read) => {
      if (read === 3) Object.assign(menu.state, { stage: "box", draft: typedOver });
    });
    const done = await driveCursorPick(p.io, { kind: "effort", value: "high" });
    expect(p.log).toEqual(["type /model"]);
    expect(menu.state.draft).toBe(typedOver);
    expect(done.result.type).toBe("refused");
  });

  it("Cursor: the menu dismissed before Enter: no Enter; only its own /model taken back", async () => {
    const menu = new DemoCursorMenu(head, folder);
    const p = scripted(menu, (read) => {
      if (read === 3) Object.assign(menu.state, { stage: "box", draft: "/model" });
    });
    const done = await driveCursorPick(p.io, { kind: "effort", value: "high" });
    expect(p.log).toEqual(["type /model", "Backspace,Backspace,Backspace,Backspace,Backspace,Backspace"]);
    expect(menu.state).toMatchObject({ stage: "box", draft: "" });
    expect(done.result).toMatchObject({ type: "refused", note: cursorPickTexts.unexpected });
  });

  it("Cursor: a working turn on screen before a row's Enter: no Enter", async () => {
    const menu = new DemoCursorMenu(head, folder);
    // Reads: 1 box, 2 list, 3 list again, 4 selector, 5 Edit Parameters, 6-9 the arrow down to High, 10 right before its Enter.
    const done = await driveCursor(menu, { kind: "effort", value: "high" }, (read, shown) => (read === 10 ? cursorMenuScreen("stream-00019") : shown));
    expect(done.log).toEqual(["type /model", "Enter", "Tab", "Down", "Down", "Down", "Down"]);
    expect(done.result.type).toBe("refused");
    expect(menu.state.effort).toBe("medium");
  });

  it("Cursor: the user's Terminal input mid-pick stops it: no further key, a note", async () => {
    const menu = new DemoCursorMenu(head, folder);
    const { site, binding, writes } = boundSite(menu, "cursor", (state) => (state.generation += 1));
    const done = await pickCursorBound(site, "p", { kind: "effort", value: "high" }, binding);
    expect(writes).toEqual(["/model"]);
    expect(done.result).toMatchObject({ type: "refused", note: cursorPickTexts.stopped("there was typing in its Terminal meanwhile") });
  });

  it("Grok: the command replaced by the user's text right after its read: no Enter, their text left", async () => {
    const grok = new DemoGrokPane("p", "/U/demo/shed-plan", "Done.");
    const p = scripted(grok, (read) => {
      if (read === 3) grok.state.draft = typedOver;
    });
    const done = await driveGrokPick(p.io, { kind: "effort", value: "medium" }, grokFiles, async () => undefined);
    expect(p.log).toEqual(["type /model grok-4.7 256k medium"]);
    expect(grok.state.draft).toBe(typedOver);
    expect(done.result).toEqual({ type: "refused", note: grokPickTexts.unexpected });
  });

  it("Grok: a dialog in the box's place before Enter: no Enter, no key", async () => {
    const grok = new DemoGrokPane("p", "/U/demo/shed-plan", "Done.");
    const p = scripted(grok);
    let count = 0;
    const glitched: CursorMenuIO = { ...p.io, read: async () => (++count === 3 ? (await p.io.read(), "  Allow Grok to run swift test?\n  1. Yes\n  2. No") : p.io.read()) };
    const done = await driveGrokPick(glitched, { kind: "effort", value: "medium" }, grokFiles, async () => undefined);
    expect(p.log).toEqual(["type /model grok-4.7 256k medium"]);
    expect(done.result.type).toBe("refused");
  });

  it("Grok: a working turn starting mid-pick, or the user's Terminal input: no Enter", async () => {
    for (const change of [(state: { status: string }) => (state.status = "working"), (state: { generation: number }) => (state.generation += 1)]) {
      const grok = new DemoGrokPane("p", "/U/demo/shed-plan", "Done.");
      const { site, binding, writes } = boundSite(grok, "grok", change as never);
      const done = await pickGrokBound(site, "p", { kind: "effort", value: "medium" }, grokFiles, binding, async () => undefined);
      expect(writes).toEqual(["/model grok-4.7 256k medium"]);
      expect(done.result.type).toBe("refused");
      expect(grok.state.effort).toBe("high");
    }
  });

  it("Desktop's Terminal input counts for its pane only", async () => {
    const { TerminalSessions } = await import("../src/main/terminals");
    const inputs = new PaneInputs();
    const handle = { input: () => undefined, resize: () => undefined, close: () => undefined };
    const hosts = { backend: () => ({ openTerminal: async () => handle }), pane: () => ({ paneID: "p" }) };
    const terminals = new TerminalSessions(hosts as never, inputs);
    const owner = { send: () => undefined, isDestroyed: () => false } as never;
    const { sessionId } = await terminals.open(owner, { hostId: "h", paneId: "p", cols: 80, rows: 24 } as never);
    expect([inputs.generation("h", "p"), inputs.generation("h", "q")]).toEqual([0, 0]);
    terminals.input(owner, sessionId, "x");
    expect([inputs.generation("h", "p"), inputs.generation("h", "q"), inputs.generation("g", "p")]).toEqual([1, 0, 0]);
  });
});

describe("a failed Grok pick never deletes the user's text", () => {
  it("the user's text in place of the command after typing: no Backspace, no Enter, their text kept", async () => {
    const grok = new DemoGrokPane("p", "/U/demo/shed-plan", "Done.");
    const p = scripted(grok);
    const typing: CursorMenuIO = {
      ...p.io,
      type: async (text) => {
        await p.io.type(text);
        grok.state.draft = "preserve my draft";
      },
    };
    const done = await driveGrokPick(typing, { kind: "effort", value: "medium" }, grokFiles, async () => undefined);
    expect(p.log).toEqual(["type /model grok-4.7 256k medium"]);
    expect(grok.state.draft).toBe("preserve my draft");
    expect(done.result).toEqual({ type: "refused", note: grokPickTexts.unexpected });
  });
});

/** A Grok pane as the driver's IO: `glitch` may change what a read shows (1: the first look); every write logged. */
function grokPane(grok: DemoGrokPane, glitch: (read: number, screen: string) => string = (_read, screen) => screen) {
  const log: string[] = [];
  let reads = 0;
  const io: CursorMenuIO = {
    read: async () => glitch(++reads, grok.screen()),
    type: async (text) => {
      log.push(`type ${text}`);
      grok.type(text);
    },
    keys: async (keys) => {
      log.push(keys.join(","));
      grok.keys(keys);
    },
    check: () => null,
  };
  return { io, log, reads: () => reads };
}

const unknownFiles = { model: null, effort: null, window: null };

describe("a Grok pick keeps the traits not chosen (its command from the screen read in its turn)", () => {
  it("the screen's model and window go into an effort pick's command; files that agree or are unknown let it go", async () => {
    const grok = new DemoGrokPane("p", "/demo", "Done.", () => undefined, { model: "grok-4.7", window: "500k", effort: "high" });
    const p = grokPane(grok);
    const done = await driveGrokPick(p.io, { kind: "effort", value: "medium" }, unknownFiles, async () => undefined);
    expect(done.result).toEqual({ type: "set", effort: "medium", window: "500k" });
    expect(p.log).toEqual(["type /model grok-4.7 500k medium", "Enter"]);
    expect(grok.state).toMatchObject({ model: "grok-4.7", window: "500k", effort: "medium" });
    const wide = grokPane(grok);
    const widened = await driveGrokPick(wide.io, { kind: "context", value: "256k" }, { model: "grok-4.7", effort: "medium", window: "500k" }, async () => undefined);
    expect(widened.result).toEqual({ type: "set", effort: "medium", window: "256k" });
    expect(wide.log).toEqual(["type /model grok-4.7 256k medium", "Enter"]);
  });

  it("files that say another model, window or effort than the screen: nothing typed, a note", async () => {
    for (const files of [
      { model: "grok-4.6", effort: "high", window: "500k" },
      { model: "grok-4.7", effort: "high", window: "256k" },
      { model: "grok-4.7", effort: "low", window: "500k" },
    ]) {
      const grok = new DemoGrokPane("p", "/demo", "Done.", () => undefined, { model: "grok-4.7", window: "500k", effort: "high" });
      const p = grokPane(grok);
      const done = await driveGrokPick(p.io, { kind: "effort", value: "medium" }, files, async () => undefined);
      expect(done.result, JSON.stringify(files)).toEqual({ type: "refused", note: grokPickTexts.disagree });
      expect(p.log).toEqual([]);
      expect(grok.state).toMatchObject({ model: "grok-4.7", window: "500k", effort: "high" });
    }
  });

  it("a screen part unknown (no window on its top line, a border without a model): nothing typed", async () => {
    const noWindow = grokPane(new DemoGrokPane("p", "/demo", "Done."), (_read, screen) => screen.replace(/ 12\.4K \/ 256K │/u, "             │"));
    expect((await driveGrokPick(noWindow.io, { kind: "effort", value: "medium" }, unknownFiles, async () => undefined)).result).toEqual({ type: "refused", note: grokPickTexts.unknown });
    const noModel = grokPane(new DemoGrokPane("p", "/demo", "Done."), (_read, screen) => screen.replace("Grok 4.7 (high)", "(high)"));
    expect((await driveGrokPick(noModel.io, { kind: "context", value: "500k" }, unknownFiles, async () => undefined)).result).toEqual({ type: "refused", note: grokPickTexts.unknown });
    expect([...noWindow.log, ...noModel.log]).toEqual([]);
  });

  it("the settle wants the whole tuple: the effort shown under another window does not settle", async () => {
    const grok = new DemoGrokPane("p", "/demo", "Done.", () => undefined, { window: "500k" });
    // After Enter (read 4 on), the top line says 256K though the border says the effort picked.
    const p = grokPane(grok, (read, screen) => (read >= 4 ? screen.replace("/ 500K │", "/ 256K │") : screen));
    const done = await driveGrokPick(p.io, { kind: "effort", value: "medium" }, unknownFiles, async () => undefined);
    expect(done.result).toEqual({ type: "refused", note: grokPickTexts.notShown });
    expect(p.log).toEqual(["type /model grok-4.7 500k medium", "Enter"]);
  });

  it("the screen's model or window moved before Enter: its own exact command taken back, no Enter", async () => {
    const grok = new DemoGrokPane("p", "/demo", "Done.");
    const p = grokPane(grok, (read, screen) => (read === 3 ? screen.replace("Grok 4.7 (high)", "Grok 4.6 (high)") : screen));
    const done = await driveGrokPick(p.io, { kind: "effort", value: "medium" }, unknownFiles, async () => undefined);
    expect(done.result).toEqual({ type: "refused", note: grokPickTexts.moved });
    expect(p.log).toEqual(["type /model grok-4.7 256k medium", Array(27).fill("Backspace").join(",")]);
    expect(grok.state.draft).toBe("");
  });
});

describe("Grok's files refresh outside the growth throttle and can settle a pick", () => {
  const sessionFile = "/demo/.grok/sessions/x/019a/updates.jsonl";
  function remote(grok: { effort: string; window: number }) {
    let text = '{"update":1}\n';
    const body = (path: string): string =>
      path === sessionFile
        ? text
        : path.endsWith("summary.json")
          ? JSON.stringify({ current_model_id: "grok-4.6", reasoning_effort: grok.effort })
          : JSON.stringify({ contextTokensUsed: 1_800, contextWindowTokens: grok.window });
    return {
      grow: (line: string) => (text += line),
      length: () => new TextEncoder().encode(text).length,
      reader: {
        locate: async () => sessionFile,
        size: async (path: string) => new TextEncoder().encode(body(path)).length,
        read: async (path: string, offset: number, max: number) => new TextEncoder().encode(body(path)).slice(offset, offset + max),
      },
    };
  }
  const settle = async () => {
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
  };

  it("a short turn's last bytes inside the interval: the next read after it reads the files", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    try {
      const files = { effort: "high", window: 256_000 };
      const r = remote(files);
      const settings = new AgentSettingsReader("grok");
      const tap = tapReader(r.reader as never, settings, () => undefined);
      await tap.size(sessionFile);
      await tap.read(sessionFile, 0, 100);
      await settle();
      expect(settings.settings.effort).toBe("high");
      vi.setSystemTime(101_000);
      files.effort = "medium";
      const at = r.length();
      r.grow('{"update":2}\n');
      await tap.size(sessionFile);
      await tap.read(sessionFile, at, 100);
      await settle();
      expect(settings.settings.effort, "held by the throttle").toBe("high");
      vi.setSystemTime(120_000);
      await tap.size(sessionFile);
      await tap.read(sessionFile, r.length(), 100);
      await settle();
      expect(settings.settings.effort).toBe("medium");
      // No bytes and nothing held: no read of the files (no idle timer, no read per empty poll).
      files.effort = "low";
      vi.setSystemTime(140_000);
      await tap.read(sessionFile, r.length(), 100);
      await settle();
      expect(settings.settings.effort).toBe("medium");
    } finally {
      vi.useRealTimers();
    }
  });

  it("refreshGrok reads them at once, inside the interval", async () => {
    const files = { effort: "high", window: 256_000 };
    const r = remote(files);
    const settings = new AgentSettingsReader("grok");
    const tap = tapReader(r.reader as never, settings, () => undefined);
    await tap.size(sessionFile);
    await tap.read(sessionFile, 0, 100);
    await settle();
    files.effort = "xhigh";
    files.window = 500_000;
    expect(await tap.refreshGrok()).toBe(true);
    expect(settings.settings).toMatchObject({ effort: "xhigh", window: 500_000 });
    const claude = tapReader(r.reader as never, new AgentSettingsReader("claude"), () => undefined);
    expect(await claude.refreshGrok()).toBe(false);
  });
});

describe("the screen-confirmed Grok value retires for good", () => {
  const grokBinding = { terminalID: "t", kind: "grok", isAgent: true, session: "s1", run: { connection: 1, arrival: 1 } } as const;
  const grokContext = { hostId: "h", paneId: "p", agent: "grok", status: "idle", binding: grokBinding } as const;
  const files = { scope: { terminalID: "t", session: "s1" }, model: "grok-4.6", modelLabel: "Grok 4.6", effort: "high", window: 256_000 };
  const flush = async () => {
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
  };
  async function switched(clock = { now: 0 }) {
    const picks = new AgentPicks({
      send: async () => undefined,
      copy: () => undefined,
      now: () => clock.now,
      grokPick: async () => ({ type: "set", effort: "medium", window: "256k" }),
    });
    picks.receive("h/p", files, null);
    picks.pick(grokContext as never, { kind: "effort", value: "effort:medium", label: "Medium" });
    await flush();
    expect(picks.settings("h/p", grokBinding).effort, "the screen's word over the old file").toBe("medium");
    return picks;
  }

  it("High, a local Medium, the file's Medium, an external High: High", async () => {
    const picks = await switched();
    picks.receive("h/p", { ...files, effort: "medium" }, null);
    expect(picks.settings("h/p", grokBinding).effort).toBe("medium");
    picks.receive("h/p", files, null);
    expect(picks.settings("h/p", grokBinding).effort).toBe("high");
  });

  it("any newer file value (its model, its window) retires it; a return to the old values never brings it back", async () => {
    for (const newer of [{ ...files, model: "grok-4.7", modelLabel: "Grok 4.7" }, { ...files, window: 500_000 }]) {
      const picks = await switched();
      picks.receive("h/p", newer, null);
      expect(picks.settings("h/p", grokBinding).effort).toBe("high");
      picks.receive("h/p", files, null);
      expect(picks.settings("h/p", grokBinding).effort, JSON.stringify(newer)).toBe("high");
    }
  });

  it("another session, connection or run, or the pane gone: retired, and not back for the old identity", async () => {
    const session = await switched();
    session.receive("h/p", { ...files, scope: { terminalID: "t", session: "s2" } }, null);
    expect(session.settings("h/p", { ...grokBinding, session: "s2" }).effort).toBe("high");
    session.receive("h/p", files, null);
    expect(session.settings("h/p", grokBinding).effort, "back to s1: not revived").toBe("high");
    const reconnect = await switched();
    expect(reconnect.settings("h/p", { ...grokBinding, run: { connection: 2, arrival: 1 } }).effort).toBe("high");
    expect(reconnect.settings("h/p", grokBinding).effort, "the old run again: not revived").toBe("high");
    const gone = await switched();
    gone.sync("h/p", null);
    gone.receive("h/p", files, null);
    expect(gone.settings("h/p", grokBinding).effort).toBe("high");
  });

  it("at the usual settle deadline: the files' word, for good", async () => {
    const clock = { now: 1_000 };
    const picks = await switched(clock);
    expect(picks.nextExpiry("h/p"), "the chips look again at its deadline").toBe(1_000 + confirmWaitMs);
    clock.now += confirmWaitMs;
    expect(picks.settings("h/p", grokBinding).effort).toBe("high");
    clock.now = 1_000;
    expect(picks.settings("h/p", grokBinding).effort, "never back").toBe("high");
  });
});

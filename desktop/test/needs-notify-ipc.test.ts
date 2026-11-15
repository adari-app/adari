// The notifications on the IPC surface (src/main/needs-notify-ipc.ts): the page's Needs you report is checked as
// every payload is (types, lengths, at most 100 rows and 2000 identities, no row or identity twice, every row among
// the identities, every index of every array so a structured clone's holes are refused, nothing extra) and dropped
// otherwise, only from the app's own page; the switches take booleans only; a test notification takes no arguments.
// Nothing the page sends on the four channels throws in main past the handles' own "bad request".

import { describe, expect, it, vi } from "vitest";

import { IPC } from "../src/shared/ipc-contract";
import { isNeedsYouReport, maxReportRows, maxReportWaiting, type NeedsYouEntry, type NeedsYouReport } from "../src/shared/needs-notify";

const registered = vi.hoisted(() => ({
  handles: new Map<string, (...args: unknown[]) => unknown>(),
  ons: new Map<string, (...args: unknown[]) => unknown>(),
}));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, listener: (...args: unknown[]) => unknown) => registered.handles.set(channel, listener),
    on: (channel: string, listener: (...args: unknown[]) => unknown) => registered.ons.set(channel, listener),
  },
}));

const { registerNotifyIpc } = await import("../src/main/needs-notify-ipc");
const { NeedsNotifier, RecordedNotifyPort } = await import("../src/main/needs-notifier");
const { APP_ORIGIN } = await import("../src/main/protocol");

const event = { senderFrame: { url: APP_ORIGIN }, sender: { id: 1 } };
const stranger = { senderFrame: { url: "https://example.invalid" }, sender: { id: 2 } };

const row = (paneId: string, more: Partial<NeedsYouEntry> = {}): NeedsYouEntry => ({
  hostId: "mini",
  paneId,
  name: "Claude Code",
  pill: "Pending Approval",
  project: "web",
  machine: "Mac mini",
  summary: null,
  ...more,
});
const good: NeedsYouReport = { rows: [row("w1:p1")], waiting: [["mini", "w1:p1"]], total: 1, live: [{ hostId: "mini", epoch: "1:1" }] };

/** An array of `length` with nothing at the indexes in `holes`, as it comes out of a structured clone (holes kept). */
function holey<T>(items: readonly T[], holes: readonly number[]): T[] {
  const array = [...items];
  for (const index of holes) delete array[index];
  const cloned = structuredClone(array);
  for (const index of holes) expect(Object.hasOwn(cloned, index)).toBe(false);
  return cloned;
}

function setup() {
  const port = new RecordedNotifyPort();
  const notifier = new NeedsNotifier(port);
  registerNotifyIpc(notifier);
  const send = (...args: unknown[]) => registered.ons.get(IPC.needsYouReport)!(event, ...args);
  const invoke = (channel: string, ...args: unknown[]) => registered.handles.get(channel)!(event, ...args);
  return { port, notifier, send, invoke };
}

describe("the needs-you report's checks", () => {
  it("takes a well-formed report", () => {
    expect(isNeedsYouReport(good)).toBe(true);
    expect(isNeedsYouReport({ rows: [], waiting: [], total: 0, live: [] })).toBe(true);
    // Identities past the shown rows, and a total past the identities (the list cut off).
    expect(isNeedsYouReport({ ...good, waiting: [["mini", "w1:p1"], ["mini", "w2:p1"]], total: 5 })).toBe(true);
    expect(isNeedsYouReport({ ...good, rows: [row("w1:p1", { summary: "Run npm test?", project: "" })] })).toBe(true);
  });

  it("refuses malformed ones: wrong types, unknown words, extra fields, a row twice, a total below the rows", () => {
    const bad: unknown[] = [
      null,
      [],
      "report",
      { rows: [], total: 0 },
      { rows: [], total: 0, live: [] },
      { ...good, waiting: [] },
      { ...good, waiting: [["mini", "w9:p9"]] },
      { ...good, waiting: [["mini", "w1:p1"], ["mini", "w1:p1"]], total: 2 },
      { ...good, waiting: [["mini", "w1:p1"], ["mini", "w2:p1"]], total: 1 },
      { ...good, waiting: [["mini", "w1:p1", "x"]] },
      { ...good, waiting: [["mini"]] },
      { ...good, waiting: [["mini", 7]] },
      { ...good, waiting: [["", "w1:p1"]] },
      { ...good, waiting: ["mini/w1:p1"] },
      { ...good, waiting: { 0: ["mini", "w1:p1"], length: 1 } },
      { ...good, extra: 1 },
      { ...good, total: 0 },
      { ...good, total: 1.5 },
      { ...good, total: -1 },
      { ...good, rows: [row("w1:p1"), row("w1:p1")], total: 2 },
      { ...good, rows: [{ ...row("w1:p1"), path: "/etc/passwd" }] },
      { ...good, rows: [row("w1:p1", { pill: "Click me" })] },
      { ...good, rows: [row("w1:p1", { name: "" })] },
      { ...good, rows: [row("")] },
      { ...good, rows: [row("w1:p1", { hostId: 7 as unknown as string })] },
      { ...good, rows: [row("w1:p1", { summary: "" })] },
      { ...good, live: [{ hostId: "mini" }] },
      { ...good, live: [{ hostId: "mini", epoch: "1:1", secret: "x" }] },
      { ...good, live: "mini" },
    ];
    for (const value of bad) expect(isNeedsYouReport(value), JSON.stringify(value)).toBe(false);
  });

  it("refuses oversized ones: a text past 160 characters, more than 100 rows, more than 64 machines, a long id", () => {
    expect(isNeedsYouReport({ ...good, rows: [row("w1:p1", { name: "x".repeat(161) })] })).toBe(false);
    expect(isNeedsYouReport({ ...good, rows: [row("w1:p1", { summary: "x".repeat(161) })] })).toBe(false);
    expect(isNeedsYouReport({ ...good, rows: [row("p".repeat(257))] })).toBe(false);
    const many = Array.from({ length: maxReportRows + 1 }, (_, index) => row(`w1:p${index}`));
    const keys = many.map((entry): [string, string] => [entry.hostId, entry.paneId]);
    expect(isNeedsYouReport({ rows: many, waiting: keys, total: many.length, live: [] })).toBe(false);
    expect(isNeedsYouReport({ rows: many.slice(0, maxReportRows), waiting: keys, total: 5000, live: [] })).toBe(true);
    expect(isNeedsYouReport({ rows: [], waiting: [], total: 1_000_000, live: [] })).toBe(false);
    const machines = Array.from({ length: 65 }, (_, index) => ({ hostId: `m${index}`, epoch: "1:1" }));
    expect(isNeedsYouReport({ rows: [], waiting: [], total: 0, live: machines })).toBe(false);
    expect(isNeedsYouReport({ rows: [], waiting: [], total: 0, live: [{ hostId: "m", epoch: "9".repeat(49) }] })).toBe(false);
  });

  it("takes 2000 identities and refuses 2001 (one past the cap)", () => {
    const identities = (count: number) => Array.from({ length: count }, (_, index): [string, string] => ["mini", `w${index}:p1`]);
    expect(maxReportWaiting).toBe(2_000);
    expect(isNeedsYouReport({ rows: [], waiting: identities(2_000), total: 2_000, live: [] })).toBe(true);
    expect(isNeedsYouReport({ rows: [], waiting: identities(2_001), total: 2_001, live: [] })).toBe(false);
    expect(isNeedsYouReport({ rows: [], waiting: [["mini", "p".repeat(257)]], total: 1, live: [] })).toBe(false);
  });

  it("refuses a report whose rows, identities, an identity or machines have a missing index (a structured clone keeps holes)", () => {
    const two = [row("w1:p1"), row("w2:p1")];
    const twoKeys: [string, string][] = [["mini", "w1:p1"], ["mini", "w2:p1"]];
    expect(isNeedsYouReport({ ...good, rows: holey([row("w1:p1")], [0]) })).toBe(false);
    expect(isNeedsYouReport({ ...good, rows: holey(two, [1]), waiting: twoKeys, total: 2 })).toBe(false);
    expect(isNeedsYouReport({ ...good, live: holey(good.live, [0]) })).toBe(false);
    expect(isNeedsYouReport({ ...good, waiting: holey(twoKeys, [1]), total: 2 })).toBe(false);
    expect(isNeedsYouReport({ ...good, waiting: [holey(["mini", "w1:p1"], [1])] })).toBe(false);
  });
});

describe("a report with holes, through the real handler", () => {
  it("a sparse rows array is dropped: nothing thrown, nothing changed", () => {
    const { port, send } = setup();
    send(good);
    const before = { badges: [...port.badges], notifications: port.notifications.length };
    expect(() => send({ ...good, rows: holey([row("w1:p1")], [0]) })).not.toThrow();
    expect(() => send({ rows: holey([row("w1:p1"), row("w2:p1")], [0]), waiting: [["mini", "w1:p1"], ["mini", "w2:p1"]], total: 2, live: good.live })).not.toThrow();
    expect({ badges: port.badges, notifications: port.notifications.length }).toEqual(before);
  });

  it("a sparse live array (and a sparse identity list) is dropped: nothing thrown, nothing changed", () => {
    const { port, send } = setup();
    send(good);
    const before = [...port.badges];
    expect(() => send({ ...good, live: holey([{ hostId: "mini", epoch: "1:2" }], [0]), total: 3 })).not.toThrow();
    expect(() => send({ ...good, waiting: holey([["mini", "w1:p1"]], [0]), total: 4 })).not.toThrow();
    expect(port.badges).toEqual(before);
  });

  it("a notifier that throws all the same: the report is dropped and logged, the listener does not throw", () => {
    const lines: string[] = [];
    const throwing = { update: () => { throw new TypeError("boom"); }, settings: () => ({ notify: true, sound: true, menuBar: true }), setSettings: () => ({ notify: true, sound: true, menuBar: true }), test: () => "" };
    registerNotifyIpc(throwing, (line) => lines.push(line));
    expect(() => registered.ons.get(IPC.needsYouReport)!(event, good)).not.toThrow();
    expect(lines).toEqual(["a Needs you report was dropped: boom"]);
  });

  it("nothing the page sends on the four channels throws past the handles' own bad request (a seeded fuzz of 3000 payloads)", () => {
    const { send, invoke } = setup();
    let seed = 7;
    const random = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648);
    const leaf = (): unknown => [null, undefined, 0, -1, 1.5, Number.NaN, "", "x", "mini", "w1:p1", "Pending Approval", true, false, 2 ** 53, "1:1"][Math.floor(random() * 15)];
    const value = (depth: number): unknown => {
      const pick = random();
      if (depth > 3 || pick < 0.35) return leaf();
      if (pick < 0.55) {
        const array = Array.from({ length: Math.floor(random() * 4) }, () => value(depth + 1));
        if (array.length > 0 && random() < 0.4) delete array[Math.floor(random() * array.length)];
        return array;
      }
      if (pick < 0.75) return { ...good, [["rows", "waiting", "total", "live"][Math.floor(random() * 4)]!]: value(depth + 1) };
      const fields = ["rows", "waiting", "total", "live", "hostId", "paneId", "name", "pill", "summary", "epoch", "notify", "sound", "menuBar"];
      return Object.fromEntries(Array.from({ length: Math.floor(random() * 5) }, () => [fields[Math.floor(random() * fields.length)]!, value(depth + 1)]));
    };
    for (let round = 0; round < 3_000; round += 1) {
      const payload = structuredClone(value(0));
      expect(() => send(payload)).not.toThrow();
      expect(() => send(payload, payload)).not.toThrow();
      for (const channel of [IPC.notifySettings, IPC.notifySettingsSet, IPC.notifyTest]) {
        try {
          invoke(channel, payload);
        } catch (error) {
          expect(error).toBeInstanceOf(Error);
          expect((error as Error).message).toBe("bad request");
        }
      }
    }
  });
});

describe("the notifications' IPC", () => {
  it("passes a checked report from the app's page to the notifier, and drops anything else", () => {
    const { port, send } = setup();
    send(good);
    expect(port.badges.at(-1)).toBe(1);
    send({ ...good, total: 9, rows: [row("w1:p1", { pill: "Click me" })] });
    send(good, "extra");
    registered.ons.get(IPC.needsYouReport)!(stranger, { ...good, total: 7 });
    expect(port.badges.at(-1)).toBe(1);
  });

  it("reads and changes the switches (booleans of the three only), and sends a test notification", () => {
    const { port, invoke } = setup();
    expect(invoke(IPC.notifySettings)).toEqual({ notify: true, sound: true, menuBar: true });
    expect(invoke(IPC.notifySettingsSet, { sound: false })).toEqual({ notify: true, sound: false, menuBar: true });
    for (const change of [{}, { sound: "off" }, { volume: true }, null, [true]]) {
      expect(() => invoke(IPC.notifySettingsSet, change)).toThrow("bad request");
    }
    expect(() => invoke(IPC.notifySettings, "extra")).toThrow("bad request");
    expect(invoke(IPC.notifyTest)).toContain("Sent.");
    expect(port.notifications).toHaveLength(1);
    expect(() => invoke(IPC.notifyTest, 1)).toThrow("bad request");
    expect(() => registered.handles.get(IPC.notifyTest)!(stranger)).toThrow("untrusted sender");
  });
});

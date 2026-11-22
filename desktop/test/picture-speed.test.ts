// The Mac: a picture message to Claude Code from Chat is timed step by step and
// kept (picture-timing.ts), measured only. Through the real Send IPC (registerIpc, Electron's ipcMain faked) and the
// attachment upload door, a fake machine whose every call moves a fake clock by a fixed cost; the same sends with and
// without the timing must send the same calls in the same order (the send's own tests, mac-img-send*.test.ts, are the
// oracle for what that order is, and its first case is repeated here).

const registered = vi.hoisted(() => ({
  handles: new Map<string, (...args: unknown[]) => unknown>(),
  ons: new Map<string, (...args: unknown[]) => void>(),
}));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, listener: (...args: unknown[]) => unknown) => registered.handles.set(channel, listener),
    on: (channel: string, listener: (...args: unknown[]) => void) => registered.ons.set(channel, listener),
  },
}));

import { describe, expect, it, vi } from "vitest";

import { IPC } from "../src/shared/ipc-contract";
import { speedLine, type SpeedRecord } from "../src/shared/speed-record";
import { AttachTimes } from "../src/main/picture-timing";
import { claudeScreen } from "./support/claude-screens";

const { registerIpc } = await import("../src/main/ipc");
const { APP_ORIGIN } = await import("../src/main/protocol");
const { PaneInputs } = await import("../src/main/pane-inputs");

const folder = "/Users/fixture/.adari-attachments-0123456789abcdef0123456789abcdef/";
const pictures = [
  `${folder}attachment-11111111-1111-1111-1111-111111111111.png`,
  `${folder}attachment-22222222-2222-2222-2222-222222222222.png`,
  `${folder}attachment-33333333-3333-3333-3333-333333333333.jpg`,
];
const caption = "found this on X";
const binding = { terminalID: "t1", isAgent: true, kind: "claude", session: null };

/** Each call's cost on the fake clock. */
const cost = { read: 40, prompt: 60, keys: 30, fresh: 5, upload: 700 } as const;

/**
 * One machine through the Send IPC (mac-img-send-steps.test.ts's): its box's screen per read, every call logged; real
 * 250 ms waits between the reads after the prompt. `timed`: the Send's timings kept (deps.speed).
 */
function mac(chips: string, timed: boolean, keep?: (record: SpeedRecord) => void) {
  const log: unknown[][] = [];
  let now = 0;
  let reads = 0;
  let prompted = false;
  let returns = 0;
  const backend = {
    promptIO: () => ({
      paneRead: async () => {
        const index = reads;
        reads += 1;
        log.push(["read"]);
        now += cost.read;
        // Empty before the prompt and for its first read after; then the chips and the caption; empty after the Return.
        return claudeScreen({ draft: !prompted || returns > 0 ? "" : index < 3 ? "" : `${chips}${caption}`, working: returns > 0 });
      },
      paneSendKeys: async () => undefined,
    }),
    prompt: async (_pane: string, text: string) => {
      prompted = true;
      log.push(["prompt", text]);
      now += cost.prompt;
    },
    agentKeys: async (_pane: string, keys: readonly string[]) => {
      if (keys.includes("Enter")) returns += 1;
      log.push(["keys", [...keys]]);
      now += cost.keys;
    },
    sendText: async () => undefined,
    sendInput: async () => undefined,
  };
  const hosts = {
    backend: () => backend,
    name: () => "Mac mini",
    pane: () => ({ paneID: "w1:p1", terminalID: "t1", workspaceID: "w1", tabID: "w1:t1", focused: false, agent: "claude", agentStatus: "idle", revision: 1 }),
    agent: () => ({ paneID: "w1:p1", agent: "claude", agentStatus: "idle", terminalID: "t1", turnEpoch: 7 }),
    run: () => ({ connection: 3, arrival: 1 }),
    fresh: async () => {
      log.push(["fresh"]);
      now += cost.fresh;
      return true;
    },
    refresh: async () => undefined,
    connection: () => 3,
    connectionIdentity: () => ({ incarnation: 1, epoch: 7 }),
  };
  const records: SpeedRecord[] = [];
  let uploads = 0;
  const uploadAttachment = async (_host: string, data: Uint8Array) => {
    now += cost.upload;
    uploads += 1;
    return { path: pictures[uploads - 1]!, byteCount: data.byteLength };
  };
  registerIpc({
    hosts,
    paneInputs: new PaneInputs(),
    uploadAttachment,
    ...(timed
      ? {
          speed: {
            record: (record: SpeedRecord) => {
              records.push(record);
              keep?.(record);
            },
          },
          speedNow: () => now,
        }
      : {}),
  } as never);
  const event = { senderFrame: { url: APP_ORIGIN }, sender: { id: 1, isDestroyed: () => false, send: () => undefined } };
  const checked = async (receipt: { readonly check: string | null }): Promise<string> => {
    if (receipt.check === null) return "sent";
    const found = await (registered.handles.get(IPC.paneSendCheck)!(event, receipt.check) as Promise<string | null>);
    return found === "taken" ? "sent" : String(found);
  };
  return {
    log,
    records,
    upload: (bytes: number) => registered.handles.get(IPC.attachmentUpload)!(event, "mini", new Uint8Array(bytes), "png") as Promise<{ path: string }>,
    // The Send's answer and its check's, then a later turn (the record is kept after them: speed-record.ts keepLater).
    send: (text: string) =>
      (registered.handles.get(IPC.paneSend)!(event, "mini", "w1:p1", text, binding) as Promise<{ readonly check: string | null }>)
        .then(checked, (error: Error) => error.message)
        .then(async (said) => {
          await new Promise((done) => setTimeout(done, 0));
          return said;
        }),
    /** The Send and its check alone, with no later turn. */
    sendNow: (text: string) =>
      (registered.handles.get(IPC.paneSend)!(event, "mini", "w1:p1", text, binding) as Promise<{ readonly check: string | null }>).then(checked, (error: Error) => error.message),
  };
}

describe("a picture message's timings (measured only)", () => {
  it("one picture: attach with its bytes, each read before the write, the write, the wait for its chip, the Return, the proof", async () => {
    const m = mac("[Image #18] ", true);
    await m.upload(48_211);
    const text = `${caption} ${pictures[0]}`;
    expect(await m.send(text)).toBe("sent");
    const record = m.records[0]!;
    expect(record.what).toBe("picture");
    expect(record.kind).toBe("claude");
    expect(record.outcome).toBe("taken");
    // The box read (due: the sidebar's events are not live here), the box before the write, the snapshot check.
    expect(record.steps).toEqual([
      { name: "attach", ms: cost.upload, bytes: 48_211 },
      { name: "read", ms: cost.read },
      { name: "read", ms: cost.read },
      { name: "read", ms: cost.fresh },
      { name: "write", ms: cost.prompt },
      // Two reads after the prompt (the second shows the chip), then the Return; one read after it shows the box empty.
      { name: "marker", ms: 2 * cost.read + cost.fresh },
      { name: "return", ms: cost.keys },
      { name: "proof", ms: 2 * cost.read + cost.fresh + cost.keys + cost.read },
    ]);
    expect(record.shownMs).toBe(2 * cost.read + cost.fresh + cost.prompt);
    expect(speedLine(record)).toMatch(/^\S+Z picture claude: attach 700 48211b, read 40, read 40, read 5, write 60, marker 85, return 30, proof 155, shown 145, total 300; taken$/);
  });

  it("three pictures: one attach each, in the message's order, with their own bytes", async () => {
    const m = mac("[Image #18] [Image #19] [Image #20]", true);
    await m.upload(1_000);
    await m.upload(2_000);
    await m.upload(3_000);
    expect(await m.send(`${caption} ${pictures.join(" ")}`)).toBe("sent");
    const attaches = m.records[0]!.steps.filter((step) => step.name === "attach");
    expect(attaches).toEqual([
      { name: "attach", ms: 700, bytes: 1_000 },
      { name: "attach", ms: 700, bytes: 2_000 },
      { name: "attach", ms: 700, bytes: 3_000 },
    ]);
    expect(m.records[0]!.steps.map((step) => step.name)).toEqual(["attach", "attach", "attach", "read", "read", "read", "write", "marker", "return", "proof"]);
  });

  it("the same calls in the same order with the timings kept or not, and as the send's own test pins them", async () => {
    const text = `${caption} ${pictures.join(" ")}`;
    // One door at a time (registerIpc's handlers are the process's).
    const timed = mac("[Image #18] [Image #19] [Image #20]", true);
    expect(await timed.send(text)).toBe("sent");
    const plain = mac("[Image #18] [Image #19] [Image #20]", false);
    expect(await plain.send(text)).toBe("sent");
    expect(timed.log).toEqual(plain.log);
    // mac-img-send-steps.test.ts's first Send IPC case (its fake's log has no snapshot checks): the same order.
    expect(timed.log.filter((entry) => entry[0] !== "fresh")).toEqual([["read"], ["read"], ["prompt", text], ["read"], ["read"], ["keys", ["Enter"]], ["read"]]);
    expect(plain.records).toEqual([]);
  });

  it("a message with no picture, or a refused Send, keeps no picture record past what it is", async () => {
    const m = mac("", true);
    expect(await m.send(caption)).toBe("sent");
    expect(m.records).toEqual([]);
  });

  it("nothing but numbers and fixed words: no path, caption, machine or pane", async () => {
    const m = mac("[Image #18] ", true);
    await m.upload(10);
    await m.send(`${caption} ${pictures[0]}`);
    const line = speedLine(m.records[0]!);
    for (const word of ["fixture", "attachment", "found", "Mac", "w1", "/", ".png"]) expect(line).not.toContain(word);
  });

  it("an upload's time waits for its message at most 64 deep, and is taken once", () => {
    const times = new AttachTimes();
    for (let n = 0; n < 70; n += 1) times.set("mini", `/p/${n}.png`, { ms: n, bytes: n });
    expect(times.take("mini", ["/p/0.png", "/p/69.png"])).toEqual([{ ms: 69, bytes: 69 }]);
    expect(times.take("mini", ["/p/69.png"])).toEqual([]);
    expect(times.take("other", ["/p/68.png"])).toEqual([]);
  });

  // The review's throwing-recorder probe taken in: timing only watches.
  it("a recorder that throws leaves the send as it is: sent, the same calls in the same order", async () => {
    const text = `${caption} ${pictures[0]}`;
    const plain = mac("[Image #18] ", false);
    expect(await plain.send(text)).toBe("sent");
    const throwing = mac("[Image #18] ", true, () => {
      throw new Error("record failed");
    });
    await throwing.upload(10);
    expect(await throwing.send(text)).toBe("sent");
    expect(throwing.log).toEqual(plain.log);
    expect(throwing.records).toHaveLength(1);
  });

  it("a slow recorder is never in front of the send's receipt or its proof: the record is kept after both", async () => {
    let checkedAt: boolean | null = null;
    let answered = false;
    const m = mac("[Image #18] ", true, () => {
      checkedAt = answered;
      const until = Date.now() + 30;
      while (Date.now() < until) {
        // A slow log line.
      }
    });
    await m.upload(10);
    expect(await m.sendNow(`${caption} ${pictures[0]}`)).toBe("sent");
    answered = true;
    expect(checkedAt).toBeNull();
    await new Promise((done) => setTimeout(done, 0));
    expect(checkedAt).toBe(true);
  });

  it("a read the watch times comes back as the call's own promise, and a clock that throws is dropped", async () => {
    const { PictureWatch } = await import("../src/main/picture-timing");
    let reads = 0;
    const watch = new PictureWatch(
      () => {
        reads += 1;
        if (reads > 1) throw new Error("clock gone");
        return 0;
      },
      "claude",
      [],
      () => undefined,
    );
    const answer = Promise.resolve("screen");
    expect(watch.read(() => answer)).toBe(answer);
    await expect(watch.read(() => Promise.reject(new Error("its own")))).rejects.toThrow("its own");
    expect(() => watch.typed()).not.toThrow();
    expect(() => watch.checked("taken")).not.toThrow();
  });
});

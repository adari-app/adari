// Chat's cold-load edges:
//   an arrival in the same folder (only the terminal changes) starts a new feed, and a feed kept for
//     the run before is not taken back by the next one;
//   a Load earlier whose whole-line reread fails ends failed, keeps nothing, and reads the line again;
//   main's inline pictures are kept within blobImageBudget (the oldest go; one evicted is read again)
//     and go when the chat closes;
//   Grok's image block is an image payload (left out), its text still put back.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { blobImageBudget, ChatService, type ChatHosts } from "../src/main/chat/service";
import { blobMark, blobsToRestore, type BlobRange } from "../src/shared/chat/blobs";
import type { ChatFeed } from "../src/shared/chat/feed";
import type { TranscriptSessionRef } from "../src/shared/chat/locator";
import type { ChatTimeline } from "../src/shared/chat/model";
import {
  ColdLink,
  coldFeedOpen,
  coldHost,
  coldHosts,
  coldLines,
  coldLoadEarlier,
  coldPath,
  coldServiceOpen,
  coldSession,
  runClock,
  shownBlobs,
} from "./support/cold-link";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
});

afterEach(() => {
  vi.useRealTimers();
});

type Windows = Map<string, { feed: ChatFeed<TranscriptSessionRef> | null; timeline: ChatTimeline }>;
const windowsOf = (service: ChatService): Windows => (service as unknown as { windows: Windows }).windows;

describe("a real arrival of the same session starts over", () => {
  /** One Claude pane whose terminal the test changes (its folder stays). */
  function pane() {
    const link = new ColdLink(coldPath, coldSession({ textTurns: 10, imageTurns: 2 }));
    const reader = link.reader("relay");
    const base = coldHosts(reader, () => true);
    const terminals: Record<string, string> = { "w1:p1": "t-first", "w1:p2": "t-other" };
    // p2 is another session (its transcript not found): p1's feed is kept on the shelf while p2 shows.
    const other = "5c0ffee0-1111-4222-8333-944455556666";
    const hosts = {
      ...base,
      pane: (host: string, id: string) => ({ ...base.pane(host, id)!, terminalID: terminals[id]! }),
      agent: (host: string, id: string) => {
        const agent = base.agent(host, id)!;
        return { ...agent, terminalID: terminals[id]!, ...(id === "w1:p2" ? { agentSession: { ...agent.agentSession!, value: other } } : {}) };
      },
    } as ChatHosts;
    const service = new ChatService(hosts, "chat");
    const owner = { id: 7, send: () => undefined, isDestroyed: () => false };
    const feed = (): ChatFeed<TranscriptSessionRef> | null => [...windowsOf(service).values()][0]?.feed ?? null;
    return { service, owner, terminals, feed };
  }

  it("in the same folder: a new terminal is a new feed; the same snapshot again keeps it", async () => {
    const { service, owner, terminals, feed } = pane();
    service.open(owner, coldHost, "w1:p1");
    const first = feed()!;
    let loaded = false;
    void first.loaded().then(() => (loaded = true));
    await runClock(() => loaded, 30_000);
    service.refresh();
    expect(feed()).toBe(first);
    terminals["w1:p1"] = "t-second";
    service.refresh();
    expect(feed()).not.toBe(first);
    expect(feed()).not.toBeNull();
    service.closeAll();
  });

  it("a feed kept for the run before is not taken back by the next run", async () => {
    const { service, owner, terminals, feed } = pane();
    service.open(owner, coldHost, "w1:p1");
    const first = feed()!;
    let loaded = false;
    void first.loaded().then(() => (loaded = true));
    await runClock(() => loaded, 30_000);
    // To another pane (the first kept paused), the first pane's agent starts again in a new terminal, back.
    service.open(owner, coldHost, "w1:p2");
    expect(service.keptKeys.length).toBeGreaterThan(0);
    terminals["w1:p1"] = "t-second";
    service.refresh();
    service.open(owner, coldHost, "w1:p1");
    expect(feed()).not.toBe(first);
    expect(first.state.status).toBe("idle");
    service.closeAll();
  });
});

describe("a Load earlier whose whole-line reread fails", () => {
  it("ends failed with nothing kept, and reads the line again once the relay answers", async () => {
    const oldest = coldLines.user("old", "the oldest question", 1).replace(/}$/, ',"n":' + "7".repeat(1_100) + "}");
    const text = [oldest, coldLines.agent("olda", "the oldest answer", 2)].join("\n") + "\n" + coldSession({ textTurns: 120, imageTurns: 0 });
    const { run, feed } = await coldFeedOpen({ mode: "relay", text });
    await runClock(() => feed.timeline.earlier !== "loading", 60_000);
    expect(JSON.stringify(feed.timeline)).not.toContain("the oldest answer");
    run.link.plainReadsFail = true;
    for (let load = 0; load < 80 && feed.timeline.earlier !== "failed" && feed.timeline.earlier !== "none"; load += 1) await coldLoadEarlier(run.link, feed);
    // The load that reached it failed: neither the line with its placeholder nor anything past it.
    expect(feed.timeline.earlier).toBe("failed");
    expect(JSON.stringify(feed.timeline)).not.toContain("the oldest question");
    run.link.plainReadsFail = false;
    for (let load = 0; load < 80 && feed.timeline.earlier !== "none"; load += 1) await coldLoadEarlier(run.link, feed);
    expect(JSON.stringify(feed.timeline)).toContain("the oldest question");
    expect(JSON.stringify(feed.timeline)).toContain("the oldest answer");
    feed.stop();
  });
});

describe("main's inline pictures within their byte budget", () => {
  it("keeps the newest within blobImageBudget, reads an evicted one again, and lets them go when the chat closes", async () => {
    // Five pasted pictures of 7 MiB of base64 each (under the 8 MiB line cap): 35 MiB, over the 32 MiB budget.
    const size = 7 * 1_024 * 1_024;
    const lines = ["A", "B", "C", "D", "E"].flatMap((char, index) => [
      coldLines.userWithShot(`u${index}`, `screen ${index}`, char.repeat(size), index * 2 + 1),
      coldLines.agent(`a${index}`, `seen ${index}`, index * 2 + 2),
    ]);
    const { run, service } = await coldServiceOpen({ mode: "relay", text: lines.join("\n") + "\n", cache: null, limitMs: 200_000 });
    // The screenful holds the newest few: the rest by Load earlier, as the user's click does.
    const chat = [...windowsOf(service).values()][0]!;
    for (let load = 0; load < 20 && chat.timeline.earlier !== "none"; load += 1) await coldLoadEarlier(run.link, chat.feed!);
    const blobs = shownBlobs([...windowsOf(service).values()][0]!.timeline);
    expect(blobs).toHaveLength(5);
    const owner = { id: 1 };
    const place = { hostId: coldHost, slot: "" };
    const ask = async (index: number): Promise<string | null> => {
      let got: string | null | undefined;
      void service.blobImage(owner, blobs[index]!, place).then((value) => (got = value));
      for (let turn = 0; turn < 20 && got === undefined; turn += 1) await Promise.resolve();
      await runClock(() => got !== undefined, 120_000);
      for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
      return got!;
    };
    for (const index of [0, 1, 2, 3, 4]) expect((await ask(index))?.length).toBe("data:image/png;base64,".length + size);
    // The first had to go for the fifth; the four newest are kept, within the budget.
    expect(service.blobImagesKept.count).toBe(4);
    expect(service.blobImagesKept.bytes).toBeLessThanOrEqual(blobImageBudget);
    let reads = run.link.readsOf().length;
    expect((await ask(4))?.endsWith("E")).toBe(true);
    expect(run.link.readsOf().length).toBe(reads);
    expect((await ask(0))?.endsWith("A")).toBe(true);
    expect(run.link.readsOf().length).toBeGreaterThan(reads);
    expect(service.blobImagesKept.bytes).toBeLessThanOrEqual(blobImageBudget);
    reads = run.link.readsOf().length;
    // The chat closes: its transcript is followed by no chat now; its pictures go.
    service.close(owner);
    expect(service.blobImagesKept).toEqual({ count: 0, bytes: 0 });
    service.closeAll();
  });
});

describe("Grok's image block", () => {
  it("leaves its data out (an image's payload) and puts its text back", () => {
    const image: BlobRange = [1_000, 200_000];
    const words: BlobRange = [300_000, 2_000];
    const line = `{"method":"session/update","params":{"update":{"sessionUpdate":"user_message_chunk","content":{"type":"image","mimeType":"image/png","data":"${blobMark(image)}"}}},"note":{"text":"${blobMark(words)}"}}`;
    expect(blobsToRestore(line, [image, words])).toEqual({ restore: [words], whole: false });
    // Without its mimeType it is not Grok's block: put back as text.
    const plain = line.replace(`"mimeType":"image/png",`, "");
    expect(blobsToRestore(plain, [image, words])).toEqual({ restore: [image, words], whole: false });
  });
});

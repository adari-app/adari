// The Mac Chat's cold open, its followers and watches:
//   a picture main fetched for a window chat goes with every transition that takes the last
//     follower's feed away (hidden, unavailable, the launch cache only), a fetch still on its way then is not
//     counted, and another window's chat that follows the same transcript keeps it (no second fetch);
//   a `grew` whose `omitted` is null or not ranges ends the watch with omit kept; one with no
//     `omitted` (an older relay) still turns omit off.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatService, type ChatOwner } from "../src/main/chat/service";
import { SshTranscriptReader } from "../src/main/chat/ssh-reader";
import { MemoryPinStore, PinningHostKeyPolicy } from "../src/main/herdr/host-key-pinning";
import { RelayClient } from "../src/main/herdr/relay";
import type { ChatFeed } from "../src/shared/chat/feed";
import type { TranscriptSessionRef } from "../src/shared/chat/locator";
import type { ChatImageBlob, ChatTimeline } from "../src/shared/chat/model";
import type { ChatViewState } from "../src/shared/ipc-contract";
import { ColdLink, coldHost, coldHosts, coldLines, coldPane, coldPath, runClock, shownBlobs } from "./support/cold-link";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
});

afterEach(() => {
  vi.useRealTimers();
});

type Chat = {
  owner: { id: number };
  feed: ChatFeed<TranscriptSessionRef> | null;
  handle: { feed: ChatFeed<TranscriptSessionRef> } | null;
  timeline: ChatTimeline;
  state: ChatViewState;
};
const chatsOf = (service: ChatService): Chat[] => [...(service as unknown as { windows: Map<string, Chat> }).windows.values()];
const chatOf = (service: ChatService, id: number): Chat => chatsOf(service).find((chat) => chat.owner.id === id)!;
const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 30; turn += 1) await Promise.resolve();
};
const owner = (id: number): ChatOwner => ({ id, send: () => undefined, isDestroyed: () => false }) as unknown as ChatOwner;
const place = { hostId: coldHost, slot: "" };
const picture = "A".repeat(2_000);

/**
 * One pasted picture's transcript, open in the windows `ids` (each its own window chat on the same pane), the
 * launch cache's catching up and the snapshot's answer as `set` says.
 */
async function openPicture(ids: readonly number[]) {
  const link = new ColdLink(coldPath, coldLines.userWithShot("u", "image", picture, 1) + "\n");
  let answered = true;
  let catching = false;
  const service = new ChatService(
    coldHosts(link.reader("relay"), () => answered),
    "chat",
  );
  service.useLaunchCache({ chat: () => null, catchingUp: () => catching, noteChat: () => undefined });
  for (const id of ids) service.open(owner(id), coldHost, coldPane);
  await runClock(() => chatsOf(service).every((chat) => chat.state.status === "live" && shownBlobs(chat.timeline).length === 1), 30_000);
  const blob: ChatImageBlob = shownBlobs(chatOf(service, ids[0]!).timeline)[0]!;
  return {
    service,
    blob,
    set: (value: { answered?: boolean; catching?: boolean }) => {
      answered = value.answered ?? answered;
      catching = value.catching ?? catching;
    },
  };
}

type Change = "hidden" | "unavailable" | "cache-only";
function take(service: ChatService, set: (value: { answered?: boolean; catching?: boolean }) => void, change: Change): void {
  if (change === "hidden") service.setPaused(owner(1), true);
  else {
    // The machine's snapshot names no pane now: unavailable, or (catching up after a launch) its cached chat.
    set({ answered: false, catching: change === "cache-only" });
    service.refresh();
  }
}

describe("main's pictures go with the last follower's feed", () => {
  it.each(["hidden", "unavailable", "cache-only"] as const)("when its only window chat is %s", async (change) => {
    const { service, blob, set } = await openPicture([1]);
    const chat = chatOf(service, 1);
    vi.spyOn(chat.handle!.feed, "fetchImage").mockResolvedValue(picture);
    expect(await service.blobImage(owner(1), blob, place)).toBe(`data:image/png;base64,${picture}`);
    await settle();
    expect(service.blobImagesKept.count).toBe(1);
    take(service, set, change);
    expect(chat.handle).toBeNull();
    expect(service.blobImagesKept).toEqual({ count: 0, bytes: 0 });
    service.closeAll();
  });

  it.each(["hidden", "unavailable", "cache-only"] as const)("a fetch that finishes after it is %s is not counted or kept", async (change) => {
    const { service, blob, set } = await openPicture([1]);
    const chat = chatOf(service, 1);
    let finish: (base64: string) => void = () => undefined;
    vi.spyOn(chat.handle!.feed, "fetchImage").mockImplementation(() => new Promise<string>((resolve) => (finish = resolve)));
    const request = service.blobImage(owner(1), blob, place);
    expect(service.blobImagesKept).toEqual({ count: 1, bytes: 0 });
    take(service, set, change);
    expect(service.blobImagesKept).toEqual({ count: 0, bytes: 0 });
    finish(picture);
    await request;
    await settle();
    expect(service.blobImagesKept).toEqual({ count: 0, bytes: 0 });
    service.closeAll();
  });

  it("another window's chat that follows the same transcript keeps it; the last one going lets it go", async () => {
    const { service, blob } = await openPicture([1, 2]);
    const one = chatOf(service, 1);
    const two = chatOf(service, 2);
    expect(two.handle!.feed.path).toBe(one.handle!.feed.path);
    const fetches = [vi.spyOn(one.handle!.feed, "fetchImage").mockResolvedValue(picture), vi.spyOn(two.handle!.feed, "fetchImage").mockResolvedValue(picture)];
    await service.blobImage(owner(1), blob, place);
    await settle();
    const kept = service.blobImagesKept;
    expect(kept.count).toBe(1);
    // Window 1 hides: window 2 still follows the transcript; its picture stays, and shows again with no fetch.
    service.setPaused(owner(1), true);
    expect(one.handle).toBeNull();
    expect(service.blobImagesKept).toEqual(kept);
    expect(await service.blobImage(owner(2), blob, place)).toBe(`data:image/png;base64,${picture}`);
    expect(fetches[0]!.mock.calls.length + fetches[1]!.mock.calls.length).toBe(1);
    // Window 2 hides too: no window's chat follows it now.
    service.setPaused(owner(2), true);
    expect(service.blobImagesKept).toEqual({ count: 0, bytes: 0 });
    service.closeAll();
  });
});

/** A relay that answers a read with `omitted` when asked, and a watch with one `grew` that carries `extra`. */
function watchReader(extra: Record<string, unknown>) {
  const frames: Record<string, unknown>[] = [];
  const data = Buffer.from("hello\n");
  const more = Buffer.from("again\n");
  const client: RelayClient = new RelayClient(
    {
      write: (raw: string) => {
        const frame = JSON.parse(raw) as Record<string, unknown>;
        frames.push(frame);
        let answer: Record<string, unknown> | null = null;
        if (frame["relay"] === "watch") {
          answer = { relay: "grew", id: frame["id"], offset: data.length, size: data.length + more.length, data: more.toString("base64"), ...extra };
        } else if (frame["relay"] === "read") {
          answer = { relay: "read", id: frame["id"], size: data.length, ino: 7, offset: 0, data: data.toString("base64"), ...(frame["omit"] === undefined ? {} : { omitted: [] }) };
        }
        if (answer !== null) {
          const line = JSON.stringify(answer) + "\n";
          queueMicrotask(() => client.data(Buffer.from(line)));
        }
      },
      close: () => undefined,
    },
    "/fake/relay.sock",
  );
  client.data(Buffer.from('{"relay":"hello","v":1}\n'));
  const reader = new SshTranscriptReader(
    { host: "fixture.invalid", port: 22, username: "fixture", privateKeyPath: "", herdrSession: "default" },
    new PinningHostKeyPolicy(new MemoryPinStore()),
    { relay: async () => client, timeoutMs: 20 },
  );
  return { reader, frames };
}

async function watchOnce(extra: Record<string, unknown>) {
  const { reader, frames } = watchReader(extra);
  const events: string[] = [];
  const watch = await reader.watch(coldPath, 6, {
    grew: (offset, _size, data) => events.push(`grew ${offset} ${Buffer.from(data).toString()}`),
    reset: () => events.push("reset"),
    gone: () => events.push("gone"),
    ended: () => events.push("ended"),
  });
  expect(watch).not.toBeNull();
  await settle();
  const asked = frames.find((frame) => frame["relay"] === "watch")!;
  // The next read: omit still asked (1024) or not (turned off).
  await reader.readWithIdentity(coldPath, 0, 512, { omit: true });
  const read = frames.filter((frame) => frame["relay"] === "read").at(-1)!;
  watch!.close();
  return { events, asked, frames, omit: read["omit"] };
}

describe("a watch's `grew` with a list that is not ranges", () => {
  it.each([
    ["null", { omitted: null }],
    ["a string", { omitted: "invalid" }],
    ["a pair short of a number", { omitted: [[5]] }],
    ["negative ranges", { omitted: [[-4, 2]] }],
  ] as const)("(%s) ends the watch with omit kept", async (_name, extra) => {
    const { events, asked, frames, omit } = await watchOnce(extra);
    expect(asked["omit"]).toBe(1024);
    expect(events).toEqual(["ended"]);
    expect(frames.filter((frame) => frame["relay"] === "unwatch").map((frame) => frame["id"])).toEqual([asked["id"]]);
    expect(omit).toBe(1024);
  });

  it("an empty list grows the file with omit kept", async () => {
    const { events, omit } = await watchOnce({ omitted: [] });
    expect(events).toEqual(["grew 6 again\n"]);
    expect(omit).toBe(1024);
  });

  it("no `omitted` at all (an older relay) still grows the file and turns omit off", async () => {
    const { events, omit } = await watchOnce({});
    expect(events).toEqual(["grew 6 again\n"]);
    expect(omit).toBeUndefined();
  });
});

// A routed stream is bounded by items as well as bytes.
// An empty DATA frame is dropped before it is counted or kept; a stream whose reader has not taken
// `routeItemLimit` items (DATA, RESIZE or any control item) ends the connection as a credit overrun does. The
// retained objects are asserted (the stream queue's pending items), not only payload bytes. All links are fakes.

import { afterEach, describe, expect, it } from "vitest";

import { CoreConnection, type CoreStreamItem } from "../src/main/herdr/core-connection";
import { CoreFrames } from "../src/main/herdr/core-frames";
import type { CoreQueue } from "../src/main/herdr/core-queue";
import { CoreBackoff, CoreSession } from "../src/main/herdr/core-session";
import { CoreFixtures, CoreTestLink, at, eventually, pause } from "./support/core-test-link";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0).reverse()) close();
});

async function open(): Promise<{ connection: CoreConnection; link: CoreTestLink }> {
  const link = new CoreTestLink(CoreFixtures.helloResult());
  const connection = await CoreConnection.open(link);
  cleanups.push(() => connection.close());
  return { connection, link };
}

/** A channel a reply named, the way an attach or a subscription opens one. */
async function named(connection: CoreConnection, link: CoreTestLink, channel: number): Promise<void> {
  const before = link.requests().length;
  const call = connection.call("terminal.attach", { terminal: "t1", cols: 80, rows: 24 });
  const request = (await link.waitForRequests(before + 1)).at(-1);
  link.deliverJson({ jsonrpc: "2.0", id: at(request ?? null, "id"), result: { channel, terminal: { address: "t1" } } });
  await call;
}

/** The stream, claimed and not read: a stalled reader (the follower while it reads documents and machines). */
async function stalled(connection: CoreConnection, link: CoreTestLink, channel: number): Promise<CoreQueue<CoreStreamItem>> {
  await named(connection, link, channel);
  return connection.stream(channel);
}

async function answers(connection: CoreConnection, link: CoreTestLink): Promise<boolean> {
  const before = link.requests().length;
  const call = connection.call("terminal.get", { terminal: "t1" });
  const request = (await link.waitForRequests(before + 1)).at(-1);
  link.deliverJson({ jsonrpc: "2.0", id: at(request ?? null, "id"), result: { address: "t1" } });
  return at(await call, "address") === "t1";
}

describe("empty DATA frames are not kept", () => {
  it("10,000 zero-byte DATA frames to a stalled stream retain nothing", async () => {
    const { connection, link } = await open();
    const stream = await stalled(connection, link, 33);
    for (let n = 0; n < 10_000; n++) link.deliverFrame(CoreFrames.data(33, new Uint8Array(0)));
    await pause(20);
    expect(stream.pendingCount, "retained items").toBe(0);
    expect(connection.uncreditedBytes(33)).toBe(0);
    expect(connection.isClosed).toBe(false);
    expect(await answers(connection, link)).toBe(true);
  });

  it("nor are they kept for a reader that has not come", async () => {
    const { connection, link } = await open();
    await named(connection, link, 35);
    for (let n = 0; n < 10_000; n++) link.deliverFrame(CoreFrames.data(35, new Uint8Array(0)));
    link.deliverFrame(CoreFrames.data(35, Uint8Array.of(65)));
    await pause(20);
    expect(connection.earlyKeptItems, "only the one with bytes").toBe(1);
    const stream = connection.stream(35);
    expect(stream.pendingCount).toBe(1);
    expect(await stream.take()).toEqual({ kind: "data", bytes: Uint8Array.of(65) });
  });
});

describe("a routed stream is bounded by items, control items included", () => {
  it("a RESIZE flood to a stalled reader ends the connection before it holds more than the item bound", async () => {
    const { connection, link } = await open();
    const stream = await stalled(connection, link, 41);
    for (let n = 0; n < 20_000; n++) link.deliverFrame(CoreFrames.resize(41, 80 + (n % 40), 24));
    expect(await eventually(() => connection.isClosed), "closed").toBe(true);
    expect((await connection.closed()).fault.kind).toBe("protocolViolation");
    expect(stream.pendingCount, "retained items: the bound and the `lost`").toBeLessThanOrEqual(CoreConnection.routeItemLimit + 1);
    const items: CoreStreamItem[] = [];
    for await (const item of stream) items.push(item);
    expect(items.filter((item) => item.kind === "resize").length).toBe(CoreConnection.routeItemLimit);
    expect(items.at(-1)?.kind).toBe("lost");
  });

  it("tiny DATA mixed with RESIZE ends it on items, long before the byte bound", async () => {
    const { connection, link } = await open();
    const stream = await stalled(connection, link, 43);
    for (let n = 0; n < 20_000; n++) link.deliverFrame(n % 2 === 0 ? CoreFrames.data(43, Uint8Array.of(n & 0x7f)) : CoreFrames.resize(43, 100, 30));
    expect(await eventually(() => connection.isClosed), "closed").toBe(true);
    expect((await connection.closed()).fault.kind).toBe("protocolViolation");
    expect(stream.pendingCount).toBeLessThanOrEqual(CoreConnection.routeItemLimit + 1);
    let bytes = 0;
    for await (const item of stream) if (item.kind === "data") bytes += item.bytes.length;
    expect(bytes, "the bytes were far inside window + overrun").toBeLessThan(CoreConnection.streamWindow);
  });

  it("the host session refuses such a core for good, as a credit overrun", async () => {
    const links: CoreTestLink[] = [];
    const session = new CoreSession({
      backoff: new CoreBackoff(0.01, 0.01),
      makeLink: () => {
        const link = new CoreTestLink(CoreFixtures.helloResult());
        links.push(link);
        return link;
      },
    });
    cleanups.push(() => session.close());
    const connection = await session.connection();
    await stalled(connection, links[0]!, 45);
    for (let n = 0; n < 20_000; n++) links[0]!.deliverFrame(CoreFrames.resize(45, 90, 30));
    expect(await eventually(() => session.state.kind === "refused")).toBe(true);
    await pause(50);
    expect(links.length).toBe(1);
  });
});

describe("normal paint and resize traffic is unaffected", () => {
  it("a stalled reader holds a realistic burst (paint, resizes, output within the window), then reads and credits on", async () => {
    const { connection, link } = await open();
    const stream = await stalled(connection, link, 51);
    // While the reader waits (the follower reading documents): a 64 KiB paint, 200 resizes and 500 output chunks.
    link.deliverFrame(CoreFrames.data(51, new Uint8Array(64 * 1024).fill(32)));
    for (let n = 0; n < 200; n++) link.deliverFrame(CoreFrames.resize(51, 80 + (n % 50), 24 + (n % 20)));
    for (let n = 0; n < 500; n++) link.deliverFrame(CoreFrames.data(51, new Uint8Array(256).fill(97)));
    await pause(20);
    expect(connection.isClosed).toBe(false);
    expect(stream.pendingCount).toBe(701);
    // The reader comes: it takes and credits what it took, and the traffic goes on at its own pace.
    let taken = 0;
    const reading = (async () => {
      for await (const item of stream) {
        taken += 1;
        if (item.kind === "data") connection.send(CoreFrames.credit(51, item.bytes.length));
      }
    })();
    for (let round = 0; round < 50; round++) {
      link.deliverFrame(CoreFrames.data(51, new Uint8Array(4096).fill(98)));
      for (let n = 0; n < 4; n++) link.deliverFrame(CoreFrames.resize(51, 120, 40));
      for (let n = 0; n < 40; n++) link.deliverFrame(CoreFrames.data(51, new Uint8Array(64).fill(99)));
      await pause(0);
    }
    expect(await eventually(() => taken === 701 + 50 * 45)).toBe(true);
    expect(connection.isClosed).toBe(false);
    expect(stream.pendingCount).toBe(0);
    expect(connection.uncreditedBytes(51)).toBe(0);
    expect(await answers(connection, link)).toBe(true);
    connection.forget(51);
    await reading;
  });
});

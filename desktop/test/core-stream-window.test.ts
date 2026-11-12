// What a connected core sends is kept within bounds whatever
// it sends. Unsolicited channel-0 notifications are dropped as they come (nothing in the app reads them); a
// stream that goes past its window and the credit sent back ends the connection. All links are fakes.

import { afterEach, describe, expect, it } from "vitest";

import { CoreConnection, type CoreStreamItem } from "../src/main/herdr/core-connection";
import { CoreFrames, encodeCoreFrame } from "../src/main/herdr/core-frames";
import { coreJSONBytes, type CoreJSON } from "../src/main/herdr/core-json";
import { CoreBackoff, CoreSession } from "../src/main/herdr/core-session";
import { CoreFixtures, CoreTestLink, at, eventually, pause } from "./support/core-test-link";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0).reverse()) close();
});

async function open(framed = true): Promise<{ connection: CoreConnection; link: CoreTestLink }> {
  const link = new CoreTestLink();
  const opened = CoreConnection.open(link, { framed });
  await link.waitForSent(1);
  link.deliver(CoreFixtures.helloReplyLine(CoreFixtures.helloResult({ framed })));
  const connection = await opened;
  cleanups.push(() => connection.close());
  return { connection, link };
}

/** What the connection still holds of its notifications (none: a `notifications` queue, if it had one, would hold them). */
function retainedNotifications(connection: CoreConnection): number {
  return (connection as unknown as { notifications?: { pendingCount: number } }).notifications?.pendingCount ?? 0;
}

/** A call that answers: the connection still works. */
async function answers(connection: CoreConnection, link: CoreTestLink, framed = true): Promise<boolean> {
  if (framed) {
    const before = link.requests().length;
    const call = connection.call("terminal.get", { terminal: "t1" });
    const request = (await link.waitForRequests(before + 1)).at(-1);
    link.deliverJson({ jsonrpc: "2.0", id: at(request ?? null, "id"), result: { address: "t1" } });
    return at(await call, "address") === "t1";
  }
  const sentBefore = link.sentBytes.length;
  const call = connection.call("terminal.get", { terminal: "t1" });
  await link.waitForSent(sentBefore + 10);
  const line = new TextDecoder().decode(link.sentBytes.subarray(sentBefore)).trim();
  const id = (JSON.parse(line) as { id: number }).id;
  link.deliver(`${JSON.stringify({ jsonrpc: "2.0", id, result: { address: "t1" } })}\n`);
  return at(await call, "address") === "t1";
}

/** Opens stream `channel` the way an attach does: a reply names it, then the reader claims it. */
async function attached(connection: CoreConnection, link: CoreTestLink, channel: number): Promise<CoreStreamItem[]> {
  const before = link.requests().length;
  const call = connection.call("terminal.attach", { terminal: "t1", cols: 80, rows: 24 });
  const request = (await link.waitForRequests(before + 1)).at(-1);
  link.deliverJson({ jsonrpc: "2.0", id: at(request ?? null, "id"), result: { channel, terminal: { address: "t1" } } });
  await call;
  const items: CoreStreamItem[] = [];
  const stream = connection.stream(channel);
  void (async () => {
    for await (const item of stream) {
      items.push(item);
      // The app's readers (the follower, the terminal's pipe) credit what they took.
      if (item.kind === "data" && credits.get(channel) === true) connection.send(CoreFrames.credit(channel, item.bytes.length));
    }
  })();
  return items;
}
const credits = new Map<number, boolean>();

const dataBytes = (items: readonly CoreStreamItem[]): number => items.reduce((sum, item) => sum + (item.kind === "data" ? item.bytes.length : 0), 0);

describe("core notifications nobody reads are not kept", () => {
  it("2,000 notifications of 4 KiB each leave nothing retained, and the connection still answers", async () => {
    const { connection, link } = await open();
    const padding = "x".repeat(4096);
    let wire = 0;
    for (let n = 0; n < 2000; n++) {
      const frame = CoreFrames.data(0, coreJSONBytes({ jsonrpc: "2.0", method: "heartbeat", params: { seq: n, padding } }));
      wire += encodeCoreFrame(frame).length;
      link.deliverFrame(frame);
    }
    await pause(20);
    expect(wire).toBeGreaterThan(8_000_000);
    expect(retainedNotifications(connection), "no notification is kept").toBe(0);
    expect(connection.isClosed).toBe(false);
    expect(await answers(connection, link)).toBe(true);
  });

  it("plain mode keeps none either", async () => {
    const { connection, link } = await open(false);
    const padding = "y".repeat(4096);
    for (let n = 0; n < 2000; n++) link.deliver(`${JSON.stringify({ jsonrpc: "2.0", method: "heartbeat", params: { seq: n, padding } })}\n`);
    await pause(20);
    expect(retainedNotifications(connection)).toBe(0);
    expect(await answers(connection, link, false)).toBe(true);
  });

  it("the test-only `notified` still sees each one as it comes", async () => {
    const link = new CoreTestLink();
    const seen: CoreJSON[] = [];
    const opened = CoreConnection.open(link, { notified: (message) => seen.push(message) });
    await link.waitForSent(1);
    link.deliver(CoreFixtures.helloReplyLine());
    const connection = await opened;
    cleanups.push(() => connection.close());
    link.deliverJson({ jsonrpc: "2.0", method: "heartbeat", params: { seq: 3 } });
    expect(await eventually(() => seen.length === 1)).toBe(true);
    expect(at(seen[0] ?? null, "params", "seq")).toBe(3);
  });
});

describe("a stream holds no more than its window and the credit sent back", () => {
  it("a core that ignores credit on a stream ends the connection before the app holds more than window + overrun", async () => {
    const { connection, link } = await open();
    credits.set(3, false);
    const items = await attached(connection, link, 3);
    for (let n = 0; n < 8; n++) link.deliverFrame(CoreFrames.data(3, new Uint8Array(1 << 20)));
    expect(await eventually(() => connection.isClosed), "closed").toBe(true);
    expect((await connection.closed()).fault.kind).toBe("protocolViolation");
    expect(dataBytes(items)).toBeLessThanOrEqual(CoreConnection.streamWindow + CoreConnection.streamOverrun);
    expect(await eventually(() => items.at(-1)?.kind === "lost"), "its reader is told").toBe(true);
  });

  it("a reader that credits what it reads gets far past the window with the connection open", async () => {
    const { connection, link } = await open();
    credits.set(5, true);
    const items = await attached(connection, link, 5);
    for (let n = 0; n < 200; n++) {
      link.deliverFrame(CoreFrames.data(5, new Uint8Array(128 * 1024)));
      await pause(0);
    }
    expect(await eventually(() => dataBytes(items) === 200 * 128 * 1024)).toBe(true);
    expect(connection.isClosed).toBe(false);
    expect(connection.uncreditedBytes(5)).toBeLessThanOrEqual(CoreConnection.streamWindow);
    expect(await answers(connection, link)).toBe(true);
  });

  it("frames kept for a reader that has not come count too; a forgotten stream's later frames are dropped, not counted", async () => {
    const { connection, link } = await open();
    const before = link.requests().length;
    const call = connection.call("terminal.attach", { terminal: "t1", cols: 80, rows: 24 });
    const request = (await link.waitForRequests(before + 1)).at(-1);
    link.deliverJson({ jsonrpc: "2.0", id: at(request ?? null, "id"), result: { channel: 7, terminal: { address: "t1" } } });
    await call;
    link.deliverFrame(CoreFrames.data(7, new Uint8Array(1000)));
    expect(await eventually(() => connection.uncreditedBytes(7) === 1000)).toBe(true);
    connection.forget(7);
    expect(connection.uncreditedBytes(7)).toBe(0);
    for (let n = 0; n < 8; n++) link.deliverFrame(CoreFrames.data(7, new Uint8Array(1 << 20)));
    await pause(20);
    expect(connection.isClosed, "nothing of it is kept, so nothing is owed").toBe(false);
    expect(connection.uncreditedBytes(7)).toBe(0);
  });

  it("the host session refuses such a core for good, as a malformed frame", async () => {
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
    credits.set(9, false);
    await attached(connection, links[0]!, 9);
    for (let n = 0; n < 8; n++) links[0]!.deliverFrame(CoreFrames.data(9, new Uint8Array(1 << 20)));
    expect(await eventually(() => session.state.kind === "refused")).toBe(true);
    await pause(50);
    expect(links.length).toBe(1);
  });
});

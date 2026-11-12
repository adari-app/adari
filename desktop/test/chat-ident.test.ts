// ChatService wraps the transcript reader in WarmingReader and then the chips' tapReader before ChatFeed
// sees it. Both pass the read with identity on (size, inode and bytes in one relay frame), only when the
// reader beneath has it: the warming gate still holds it, the chips still read its bytes and start over on
// another file, and a reader without it (SFTP, exec) stays without it.

import { describe, expect, it } from "vitest";

import { AgentSettingsReader, tapReader } from "../src/shared/agent-settings";
import { isTranscriptIdentityReading, type TranscriptIdentityRead, type TranscriptIdentityReading } from "../src/shared/chat/feed";
import { ChatWarmGate, WarmingReader } from "../src/shared/chat/shelf";
import { reply, text, user } from "./support/chat-lines";

const path = "/fake/one.jsonl";

/** A Claude reply naming its model and effort. */
function assistant(body: string, id: string, second: number, model: string, effort: string): string {
  const line = JSON.parse(reply(body, id, second, true)) as { effort?: string; message: { model?: string } };
  line.effort = effort;
  line.message.model = model;
  return JSON.stringify(line);
}

/** A file under `path`: its bytes and inode, read plainly or with identity (counted). */
class Machine {
  bytes = new Uint8Array();
  ino = 7;
  identityReads = 0;
  plainReads = 0;
  /** Set: the next read with identity answers null (no relay). */
  noRelay = false;
  put(content: string, ino = this.ino): void {
    this.bytes = new Uint8Array(Buffer.from(content));
    this.ino = ino;
  }
  async locate(): Promise<string | null> {
    return path;
  }
  async size(): Promise<number> {
    return this.bytes.length;
  }
  async read(_path: string, offset: number, maxBytes: number): Promise<Uint8Array> {
    this.plainReads += 1;
    return this.bytes.slice(offset, offset + maxBytes);
  }
}

class RelayMachine extends Machine implements TranscriptIdentityReading {
  async readWithIdentity(_path: string, offset: number, maxBytes: number): Promise<TranscriptIdentityRead | null> {
    this.identityReads += 1;
    if (this.noRelay) return null;
    return { size: this.bytes.length, ino: this.ino, data: this.bytes.slice(offset, offset + maxBytes) };
  }
}

/** A read the test lets go of. */
function held(): { promise: Promise<Uint8Array>; release: () => void } {
  let release: () => void = () => undefined;
  const promise = new Promise<Uint8Array>((resolve) => (release = () => resolve(new Uint8Array())));
  return { promise, release };
}

const flush = async (): Promise<void> => {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
};

describe("WarmingReader: the read with identity", () => {
  it("is there only when its base has it (an SFTP/exec reader stays without it)", () => {
    const gate = new ChatWarmGate();
    expect(isTranscriptIdentityReading(new WarmingReader(new Machine(), "mac-1", gate))).toBe(false);
    expect(isTranscriptIdentityReading(new WarmingReader(new RelayMachine(), "mac-1", gate))).toBe(true);
  });

  it("waits its turn at the machine's gate while warming, as every read; on show it goes straight through", async () => {
    const gate = new ChatWarmGate();
    const busyBase = new Machine();
    const hold = held();
    busyBase.read = () => hold.promise;
    const busy = new WarmingReader(busyBase, "mac-1", gate);
    const base = new RelayMachine();
    base.put("0123456789");
    const warming = new WarmingReader(base, "mac-1", gate);
    const first = busy.read(path, 0, 1);
    const second = warming.readWithIdentity!(path, 2, 4);
    await flush();
    expect(base.identityReads, "held at the gate behind the warming read in flight").toBe(0);
    hold.release();
    await first;
    const answer = await second;
    expect(base.identityReads).toBe(1);
    expect(answer).toMatchObject({ size: 10, ino: 7 });
    expect(Buffer.from(answer!.data).toString()).toBe("2345");
    // On show: not held, the gate busy or not.
    const again = held();
    busyBase.read = () => again.promise;
    const third = busy.read(path, 0, 1);
    warming.warming = false;
    await expect(warming.readWithIdentity!(path, 0, 2)).resolves.toMatchObject({ size: 10, ino: 7 });
    expect(base.identityReads).toBe(2);
    again.release();
    await third;
  });

  it("passes the base's null (no relay now) on as it is", async () => {
    const base = new RelayMachine();
    base.noRelay = true;
    const warming = new WarmingReader(base, "mac-1", new ChatWarmGate(), false);
    await expect(warming.readWithIdentity!(path, 0, 10)).resolves.toBeNull();
  });
});

describe("tapReader: the read with identity", () => {
  const first = (): string => text([user("question", "u1", 1), assistant("old", "a1", 2, "claude-opus-5-5", "max")]);

  it("is there only when the reader beneath has it", () => {
    expect(isTranscriptIdentityReading(tapReader(new Machine(), new AgentSettingsReader("claude"), () => undefined))).toBe(false);
    expect(isTranscriptIdentityReading(tapReader(new RelayMachine(), new AgentSettingsReader("claude"), () => undefined))).toBe(true);
  });

  it("through WarmingReader (the service's chain): the chips read its bytes, notified once; the answer is the base's", async () => {
    const base = new RelayMachine();
    base.put(first());
    const settings = new AgentSettingsReader("claude");
    let notified = 0;
    const tapped = tapReader(new WarmingReader(base, "mac-1", new ChatWarmGate(), false), settings, () => void (notified += 1));
    expect(isTranscriptIdentityReading(tapped)).toBe(true);
    if (!isTranscriptIdentityReading(tapped)) return;
    const answer = await tapped.readWithIdentity(path, 0, 1_000_000);
    expect(answer).toMatchObject({ size: base.bytes.length, ino: 7 });
    expect(answer!.data).toEqual(base.bytes);
    expect(settings.settings).toMatchObject({ model: "claude-opus-5-5", effort: "max" });
    expect(notified).toBe(1);
    expect(base.plainReads).toBe(0);
    // A poll at the end finds nothing new: nothing said.
    await tapped.readWithIdentity(path, base.bytes.length, 1_000_000);
    expect(notified).toBe(1);
  });

  it("another inode under the name starts the chips over (its lines win from their own offsets), said once with the reread", async () => {
    const base = new RelayMachine();
    base.put(first());
    const settings = new AgentSettingsReader("claude");
    const heard: { model: string | null; effort: string | null }[] = [];
    const tapped = tapReader(base, settings, () => void heard.push({ model: settings.settings.model, effort: settings.settings.effort }));
    if (!isTranscriptIdentityReading(tapped)) throw new Error("no read with identity");
    await tapped.readWithIdentity(path, 0, 1_000_000);
    const loaded = base.bytes.length;
    heard.length = 0;
    // Replaced by a longer file whose model line sits before the old one's offset; the poll reads past it.
    base.put(text([assistant("new", "a9", 3, "claude-sonnet-5-5", "low"), user("x".repeat(loaded), "u9", 4)]), 8);
    await tapped.readWithIdentity(path, loaded, 1_000_000);
    expect(heard, "said with the reread, not before (no blank chips)").toEqual([]);
    expect(settings.settings.model).toBeNull();
    // The feed reads it again from its start.
    await tapped.readWithIdentity(path, 0, 1_000_000);
    expect(settings.settings).toMatchObject({ model: "claude-sonnet-5-5", effort: "low" });
    expect(heard).toEqual([{ model: "claude-sonnet-5-5", effort: "low" }]);
  });

  it("a shorter file (same inode) starts the chips over as size() does; null (no relay) taps nothing and the plain reads still tap", async () => {
    const base = new RelayMachine();
    base.put(first());
    const settings = new AgentSettingsReader("claude");
    let notified = 0;
    const tapped = tapReader(base, settings, () => void (notified += 1));
    if (!isTranscriptIdentityReading(tapped)) throw new Error("no read with identity");
    await tapped.readWithIdentity(path, 0, 1_000_000);
    const loaded = base.bytes.length;
    base.put(text([assistant("short", "a2", 3, "claude-haiku-5-5", "low")]));
    expect(base.bytes.length).toBeLessThan(loaded);
    notified = 0;
    await tapped.readWithIdentity(path, loaded, 1_000_000);
    expect(settings.settings.model).toBeNull();
    expect(notified).toBe(0);
    base.noRelay = true;
    await expect(tapped.readWithIdentity(path, 0, 1_000_000)).resolves.toBeNull();
    expect(settings.settings.model).toBeNull();
    // The feed asks the size and reads: tapped there, as ever.
    await tapped.size(path);
    await tapped.read(path, 0, base.bytes.length);
    expect(settings.settings).toMatchObject({ model: "claude-haiku-5-5", effort: "low" });
    expect(notified).toBe(1);
  });
});

// A Desktop host-key question
// has an identity of its own, and an answer counts only for the question it was
// given to. Each question gets an opaque id (a UUID) kept with its machine's
// entry, endpoint and key; Trust and Cancel carry it, and main pins or clears
// only when it is the question still open. Any other id does nothing: no pin,
// no clear, no reconnect. That covers a question already answered, one replaced
// by an edit, one whose machine was removed or added again, and one asked again
// after Cancel. The machines are fakes in memory: no network.

import { describe, expect, it } from "vitest";

import type { HerdrHostBackend } from "../src/main/herdr/backend";
import {
  HostKeyRejectedError,
  MemoryPinStore,
  NewHostKeyError,
  PinningHostKeyPolicy,
  openSSHFingerprint,
  sshHostKeyFingerprintSHA256,
} from "../src/main/herdr/host-key-pinning";
import type { SessionTopology } from "../src/main/herdr/wire";
import { HostRegistry } from "../src/main/hosts";
import type { HostKeyQuestion } from "../src/shared/ipc-contract";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const topology: SessionTopology = { version: "test", protocolVersion: 1, workspaces: [], tabs: [], panes: [], agents: [] };
const keyA = Buffer.from("synthetic-host-key-A");
const keyB = Buffer.from("synthetic-host-key-B");

/** A machine at host:port presenting `wire`, judged by the app's own policy, as connectSsh's validator does. */
class FakeMac {
  /** Snapshots asked of it (each one a connection attempt). */
  asked = 0;
  /** Snapshots that got past the host key (the sign-in and the request). */
  signIns = 0;

  constructor(
    readonly host: string,
    readonly port: number,
    public wire: Buffer,
    private readonly policy: PinningHostKeyPolicy,
  ) {}

  get display(): string {
    return openSSHFingerprint(this.wire);
  }

  backend(): HerdrHostBackend {
    return {
      kind: "demo",
      snapshot: async () => {
        this.asked += 1;
        const fingerprint = sshHostKeyFingerprintSHA256(this.wire);
        const decision = this.policy.evaluate(this.host, this.port, fingerprint);
        if (decision === "ask") throw new NewHostKeyError(this.host, this.port, fingerprint, this.display, "ssh-ed25519");
        if (decision === "reject") throw new HostKeyRejectedError(this.host, this.port, fingerprint, this.display);
        this.signIns += 1;
        return topology;
      },
      close: () => undefined,
    } as unknown as HerdrHostBackend;
  }
}

function setup() {
  const policy = new PinningHostKeyPolicy(new MemoryPinStore());
  const registry = new HostRegistry(() => undefined);
  const pins: NewHostKeyError[] = [];
  const pin = (key: NewHostKeyError) => {
    pins.push(key);
    return policy.trustNewKey(key.host, key.port, key.fingerprint);
  };
  const mac = (host: string, wire = keyA, port = 22) => new FakeMac(host, port, wire, policy);
  const descriptor = (id: string, at: FakeMac) => ({ id, name: id, kind: "ssh" as const, address: `fixture-user@${at.host}:${at.port}`, platform: null });
  const add = async (id: string, at: FakeMac) => {
    registry.add(descriptor(id, at), at.backend());
    await registry.refresh(id);
  };
  const replace = async (id: string, at: FakeMac) => {
    registry.replace(descriptor(id, at), at.backend());
    await registry.refresh(id);
  };
  const view = (id: string) => registry.list().find((host) => host.id === id);
  const question = (id: string): HostKeyQuestion => {
    const asked = view(id)?.hostKey;
    if (asked === undefined) throw new Error(`no question for ${id}`);
    return asked;
  };
  return { policy, registry, pins, pin, mac, add, replace, view, question };
}

describe("a question's identity", () => {
  it("every question has an opaque id of its own; asking again gives a new one", async () => {
    const { registry, mac, add, question } = setup();
    await add("a", mac("a.invalid"));
    await add("b", mac("b.invalid"));
    const first = question("a");
    expect(first.id).toMatch(uuid);
    expect(question("b").id).toMatch(uuid);
    expect(question("b").id).not.toBe(first.id);

    registry.cancelHostKey("a", first.id);
    await registry.retry("a");
    expect(question("a").id).toMatch(uuid);
    expect(question("a").id).not.toBe(first.id);
    expect(question("a").fingerprint).toBe(first.fingerprint);
    registry.close();
  });
});

describe("an answer to a question no longer open does nothing", () => {
  it("an old Trust after an edit to a new endpoint with the same key pins nothing and reconnects nothing", async () => {
    const { policy, registry, pins, pin, mac, add, replace, view, question } = setup();
    await add("a", mac("a.invalid"));
    const old = question("a");
    const edited = mac("b.invalid"); // the same public key, another endpoint
    await replace("a", edited);
    const newer = question("a");
    expect(newer.fingerprint).toBe(old.fingerprint);
    expect(newer.id).not.toBe(old.id);

    await registry.trustHostKey("a", old.id, old.fingerprint, pin);

    expect(pins).toEqual([]);
    expect(policy.pinnedFingerprint("a.invalid", 22)).toBeUndefined();
    expect(policy.pinnedFingerprint("b.invalid", 22)).toBeUndefined();
    expect(question("a").id).toBe(newer.id);
    expect(view("a")?.hostKeyDeclined).not.toBe(true);
    expect(edited.asked).toBe(1);
    expect(edited.signIns).toBe(0);
    registry.close();
  });

  it("an old Cancel leaves the newer question open (a new key, or the same key elsewhere)", async () => {
    for (const edit of [{ host: "a.invalid", wire: keyB }, { host: "b.invalid", wire: keyA }]) {
      const { registry, mac, add, replace, view, question } = setup();
      await add("a", mac("a.invalid"));
      const old = question("a");
      await replace("a", mac(edit.host, edit.wire));
      const newer = question("a");
      const asking = view("a")?.error;

      registry.cancelHostKey("a", old.id);

      expect(question("a")).toEqual(newer);
      expect(view("a")?.hostKeyDeclined).not.toBe(true);
      expect(view("a")?.error).toBe(asking);
      registry.close();
    }
  });

  it("after the machine is removed, and after it is added again, the old question's answers do nothing", async () => {
    const { policy, registry, pins, pin, mac, add, view, question } = setup();
    const at = mac("a.invalid");
    await add("a", at);
    const old = question("a");
    registry.remove("a");
    await registry.trustHostKey("a", old.id, old.fingerprint, pin);
    registry.cancelHostKey("a", old.id);
    expect(pins).toEqual([]);

    await add("a", at); // the same machine, the same key
    const again = question("a");
    expect(again.id).not.toBe(old.id);
    await registry.trustHostKey("a", old.id, old.fingerprint, pin);
    registry.cancelHostKey("a", old.id);
    expect(pins).toEqual([]);
    expect(policy.pinnedFingerprint("a.invalid", 22)).toBeUndefined();
    expect(question("a")).toEqual(again);
    expect(view("a")?.hostKeyDeclined).not.toBe(true);
    expect(at.signIns).toBe(0);

    // The question open now still answers.
    await registry.trustHostKey("a", again.id, again.fingerprint, pin);
    expect(policy.pinnedFingerprint("a.invalid", 22)).toBe(sshHostKeyFingerprintSHA256(keyA));
    expect(view("a")?.state).toBe("connected");
    expect(at.signIns).toBe(1);
    registry.close();
  });

  it("after Cancel and Try again, the first question's Trust and Cancel do nothing", async () => {
    const { policy, registry, pins, pin, mac, add, view, question } = setup();
    const at = mac("a.invalid");
    await add("a", at);
    const first = question("a");
    registry.cancelHostKey("a", first.id);
    expect(view("a")?.hostKeyDeclined).toBe(true);
    await registry.retry("a");
    const second = question("a");
    expect(at.asked).toBe(2);

    await registry.trustHostKey("a", first.id, first.fingerprint, pin);
    registry.cancelHostKey("a", first.id);

    expect(pins).toEqual([]);
    expect(policy.pinnedFingerprint("a.invalid", 22)).toBeUndefined();
    expect(question("a")).toEqual(second);
    expect(view("a")?.hostKeyDeclined).not.toBe(true);
    expect(at.asked).toBe(2);

    registry.cancelHostKey("a", second.id);
    expect(view("a")?.hostKey).toBeUndefined();
    expect(view("a")?.hostKeyDeclined).toBe(true);
    registry.close();
  });

  it("an answer is retired once given: the same id a second time does nothing", async () => {
    const { registry, pins, mac, add, view, question } = setup();
    const at = mac("a.invalid");
    await add("a", at);
    const asked = question("a");
    let calls = 0;
    const refuse = () => {
      calls += 1;
      return "reject" as const;
    };
    await registry.trustHostKey("a", asked.id, asked.fingerprint, refuse);
    const declined = view("a");
    expect(declined?.hostKeyDeclined).toBe(true);
    expect(declined?.error).toContain("not saved");

    await registry.trustHostKey("a", asked.id, asked.fingerprint, refuse);
    registry.cancelHostKey("a", asked.id);
    expect(calls).toBe(1);
    expect(pins).toEqual([]);
    expect(view("a")?.error).toBe(declined?.error);
    expect(at.asked).toBe(1);
    registry.close();
  });

  it("a Trust that connected: its Cancel afterwards does nothing", async () => {
    const { registry, pin, mac, add, view, question } = setup();
    const at = mac("a.invalid");
    await add("a", at);
    const asked = question("a");
    await registry.trustHostKey("a", asked.id, asked.fingerprint, pin);
    registry.cancelHostKey("a", asked.id);
    expect(view("a")?.state).toBe("connected");
    expect(view("a")?.hostKeyDeclined).not.toBe(true);
    expect(view("a")?.error).toBeNull();
    registry.close();
  });

  it("another machine's question id does nothing on this one", async () => {
    const { policy, registry, pins, pin, mac, add, view, question } = setup();
    await add("a", mac("a.invalid"));
    await add("b", mac("b.invalid")); // the same key on another machine
    const forA = question("a");
    const forB = question("b");

    await registry.trustHostKey("b", forA.id, forA.fingerprint, pin);
    registry.cancelHostKey("b", forA.id);
    await registry.trustHostKey("a", forB.id, forB.fingerprint, pin);
    registry.cancelHostKey("a", forB.id);

    expect(pins).toEqual([]);
    expect(policy.pinnedFingerprint("a.invalid", 22)).toBeUndefined();
    expect(policy.pinnedFingerprint("b.invalid", 22)).toBeUndefined();
    expect(question("a")).toEqual(forA);
    expect(question("b")).toEqual(forB);
    expect(view("a")?.hostKeyDeclined).not.toBe(true);
    expect(view("b")?.hostKeyDeclined).not.toBe(true);
    registry.close();
  });
});

describe("controls", () => {
  it("two hosts and two ports keep answers and pins separate", async () => {
    const { policy, registry, pin, mac, add, question } = setup();
    const a = mac("a.invalid");
    const b = mac("b.invalid", keyB);
    const c = mac("a.invalid", Buffer.from("synthetic-host-key-C"), 2200);
    await add("a", a);
    await add("b", b);
    await add("c", c);
    const forA = question("a");
    const forB = question("b");

    // A's fingerprint on B's question: refused, whatever the id.
    await registry.trustHostKey("b", forB.id, forA.fingerprint, pin);
    expect(policy.pinnedFingerprint("b.invalid", 22)).toBeUndefined();
    expect(question("b")).toEqual(forB);
    registry.cancelHostKey("b", forB.id);

    await registry.trustHostKey("a", forA.id, forA.fingerprint, pin);
    expect(policy.pinnedFingerprint("a.invalid", 22)).toBe(sshHostKeyFingerprintSHA256(keyA));
    expect(policy.pinnedFingerprint("a.invalid", 2200)).toBeUndefined();
    expect(policy.pinnedFingerprint("b.invalid", 22)).toBeUndefined();
    expect(question("c").fingerprint).toBe(c.display);
    registry.close();
  });

  it("a different, newer key refuses a late Trust after Try again or an edit", async () => {
    for (const replaced of [false, true]) {
      const { policy, registry, pins, pin, mac, add, replace, question } = setup();
      const at = mac("a.invalid");
      await add("a", at);
      const old = question("a");
      if (replaced) {
        await replace("a", mac("a.invalid", keyB));
      } else {
        registry.cancelHostKey("a", old.id);
        at.wire = keyB; // the Mac now presents another key
        await registry.retry("a");
      }
      const newer = question("a");
      expect(newer.fingerprint).toBe(openSSHFingerprint(keyB));

      await registry.trustHostKey("a", old.id, old.fingerprint, pin);
      await registry.trustHostKey("a", newer.id, old.fingerprint, pin);

      expect(pins).toEqual([]);
      expect(policy.pinnedFingerprint("a.invalid", 22)).toBeUndefined();
      expect(question("a")).toEqual(newer);
      registry.close();
    }
  });
});

// The page's side of attaching, as the iPhone app's CompanionComposerSession
// does it (CompanionAttachSpeedTests):
// a chip uploads as it is attached (paste, drop, the picker), two at a time
// per machine, the rest waiting their turn; it shows uploading, then on the
// machine, or failed with Retry. Send with every chip on the machine goes at
// once; Send while one uploads waits ("Sends when the upload finishes.", its
// × lets the Send go and keeps the draft), and an upload failing meanwhile
// stops it (the draft stays, Retry shows). × stops an upload, removes a chip
// on the machine from there (a removal that fails or goes silent keeps Retry,
// and a waiting Send refuses; a removal already running at the press, or a
// Retry of one, holds the Send too). The pane's box going lets a waiting Send
// go unsent; a late result only updates its own chip and never sends. A restored
// draft's chip that was uploading never comes back as on the machine.

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { HostView } from "../src/shared/ipc-contract";
import type { SidebarRow } from "../src/shared/sidebar-model";
import { HookHost, elements, find } from "./support/fake-hooks";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  const hooks = { ...fakeReact, useLayoutEffect: fakeReact.useEffect };
  return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});

// Images are re-encoded in the page (canvas); here a fixed JPEG stands for it.
vi.mock("../src/renderer/components/image-prepare", () => ({
  prepareImage: async () => ({ data: new Uint8Array([0xff, 0xd8, 0xff]), extension: "jpg" }),
}));

const { Composer } = await import("../src/renderer/components/MainPane");
const drafting = await import("../src/renderer/components/composer-drafts");
const { ComposerDrafts, composerDrafts, draftKey, sendDraft } = drafting;
const { draftInput } = await import("../src/renderer/components/draft-persistence");
type Transport = import("../src/renderer/components/composer-drafts").AttachmentTransport;
type Drafts = InstanceType<typeof ComposerDrafts>;

const folder = "/Users/fixture/.adari-attachments-0123456789abcdef0123456789abcdef";
const remote = (n: number, ext = "jpg") => `${folder}/attachment-${String(n).repeat(8)}-1111-4111-8111-111111111111.${ext}`;

interface Upload {
  readonly hostId: string;
  readonly extension: string;
  readonly uploadId: string;
  readonly data: Uint8Array;
  resolve(path: string): void;
  reject(error: Error): void;
}
interface Discard {
  readonly hostId: string;
  readonly path: string;
  resolve(): void;
  reject(error: Error): void;
}
interface Sent {
  readonly text: string;
  resolve(): void;
  reject(error: Error): void;
}

function fakeMachine() {
  const uploads: Upload[] = [];
  const cancels: string[] = [];
  const discards: Discard[] = [];
  const transport: Transport = {
    upload: (hostId, data, extension, uploadId) =>
      new Promise((resolve, reject) =>
        uploads.push({ hostId, data, extension, uploadId, resolve: (path) => resolve({ path, byteCount: data.byteLength }), reject }),
      ),
    cancel: (uploadId) => void cancels.push(uploadId),
    discard: (hostId, path) => new Promise<void>((resolve, reject) => discards.push({ hostId, path, resolve, reject })),
  };
  return { uploads, cancels, discards, transport };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

const key = draftKey("mac-mini", "w1:p1");
const payload = (name: string) => ({ name, extension: name.slice(name.lastIndexOf(".") + 1), image: true, data: new Uint8Array([1, 2, 3]) });
const states = (drafts: Drafts, at = key) => drafts.get(at).chips.map((chip) => chip.state.kind);

function sender() {
  const sends: Sent[] = [];
  const send = (_h: string, _p: string, text: string) => new Promise<void>((resolve, reject) => sends.push({ text, resolve, reject }));
  return { sends, send };
}

describe("a chip uploads as it is attached", () => {
  it("starts at once, two at a time per machine; the third waits its turn", async () => {
    const machine = fakeMachine();
    const drafts = new ComposerDrafts({ transport: () => machine.transport });
    drafts.attach(key, [payload("a.jpg"), payload("b.jpg"), payload("shot.png")]);
    expect(machine.uploads.map((u) => [u.hostId, u.extension])).toEqual([
      ["mac-mini", "jpg"],
      ["mac-mini", "jpg"],
    ]);
    expect(states(drafts)).toEqual(["uploading", "uploading", "uploading"]);
    // Another machine's chip does not wait behind this one's.
    drafts.attach(draftKey("build-box", "w2:p1"), [payload("c.jpg")]);
    expect(machine.uploads.map((u) => u.hostId)).toEqual(["mac-mini", "mac-mini", "build-box"]);
    machine.uploads[0]!.resolve(remote(1));
    await flush();
    expect(states(drafts)).toEqual(["uploaded", "uploading", "uploading"]);
    expect(machine.uploads.map((u) => u.extension)).toEqual(["jpg", "jpg", "jpg", "png"]);
    expect(drafts.get(key).chips[0]!.state).toEqual({ kind: "uploaded", path: remote(1) });
  });

  it("Send with every chip on the machine goes at once, with no upload call", async () => {
    const machine = fakeMachine();
    const drafts = new ComposerDrafts({ transport: () => machine.transport });
    const { sends, send } = sender();
    drafts.attach(key, [payload("a.jpg"), payload("b.png")]);
    machine.uploads[0]!.resolve(remote(1));
    machine.uploads[1]!.resolve(remote(2, "png"));
    await flush();
    drafts.edit(key, "look");
    expect(sendDraft(drafts, send, "mac-mini", "w1:p1")).toBe(true);
    expect(sends.map((s) => s.text)).toEqual([`look ${remote(1)} ${remote(2, "png")}`]);
    expect(machine.uploads.length).toBe(2);
    expect(drafts.get(key).waiting).toBe(false);
    sends[0]!.resolve();
    await flush();
    expect(drafts.get(key).chips).toEqual([]);
  });

  it("Send while one uploads waits for it, then goes once, with every path in order", async () => {
    const machine = fakeMachine();
    const drafts = new ComposerDrafts({ transport: () => machine.transport });
    const { sends, send } = sender();
    const went: string[] = [];
    drafts.attach(key, [payload("a.jpg"), payload("b.jpg"), payload("c.jpg")]);
    drafts.edit(key, "three");
    expect(sendDraft(drafts, send, "mac-mini", "w1:p1", null, () => went.push("went"))).toBe(true);
    expect(drafts.get(key)).toMatchObject({ waiting: true, sending: true, text: "", taken: "three" });
    expect(sends).toEqual([]);
    // A second press while it waits does nothing.
    expect(sendDraft(drafts, send, "mac-mini", "w1:p1")).toBe(false);
    machine.uploads[1]!.resolve(remote(2));
    await flush();
    machine.uploads[0]!.resolve(remote(1));
    await flush();
    expect(sends).toEqual([]);
    machine.uploads[2]!.resolve(remote(3));
    await flush();
    expect(sends.map((s) => s.text)).toEqual([`three ${remote(1)} ${remote(2)} ${remote(3)}`]);
    expect(went).toEqual(["went"]);
    expect(drafts.get(key).waiting).toBe(false);
  });

  it("× on the waiting Send's note lets it go: the draft stays, and an upload landing later sends nothing", async () => {
    const machine = fakeMachine();
    const drafts = new ComposerDrafts({ transport: () => machine.transport });
    const { sends, send } = sender();
    drafts.attach(key, [payload("a.jpg")]);
    drafts.edit(key, "wait for it");
    sendDraft(drafts, send, "mac-mini", "w1:p1");
    drafts.abandonWait(key);
    expect(drafts.get(key)).toMatchObject({ waiting: false, sending: false, text: "wait for it", error: null, taken: null });
    expect(states(drafts)).toEqual(["uploading"]);
    machine.uploads[0]!.resolve(remote(1));
    await flush();
    expect(sends).toEqual([]);
    expect(states(drafts)).toEqual(["uploaded"]);
    // Pressed again: it goes at once.
    sendDraft(drafts, send, "mac-mini", "w1:p1");
    expect(sends.map((s) => s.text)).toEqual([`wait for it ${remote(1)}`]);
  });

  it("an upload failing while the Send waits stops it: the draft stays, the chip shows Retry, nothing is sent", async () => {
    const machine = fakeMachine();
    const drafts = new ComposerDrafts({ transport: () => machine.transport });
    const { sends, send } = sender();
    drafts.attach(key, [payload("a.jpg"), payload("b.jpg")]);
    drafts.edit(key, "see these");
    sendDraft(drafts, send, "mac-mini", "w1:p1");
    drafts.edit(key, "typed");
    machine.uploads[0]!.reject(new Error("Error invoking remote method 'herdr:attachment-upload': Error: The upload did not finish: the link dropped"));
    await flush();
    expect(sends).toEqual([]);
    expect(drafts.get(key)).toMatchObject({ waiting: false, sending: false, text: "see these\ntyped" });
    expect(drafts.get(key).error).toBe("Not sent: a.jpg did not upload (The upload did not finish: the link dropped). The message is kept.");
    expect(states(drafts)).toEqual(["failed", "uploading"]);
    // Retry uploads it again; with both on the machine Send goes at once.
    drafts.retryChip(key, drafts.get(key).chips[0]!.id);
    expect(machine.uploads.length).toBe(3);
    expect(states(drafts)).toEqual(["uploading", "uploading"]);
    machine.uploads[1]!.resolve(remote(2));
    machine.uploads[2]!.resolve(remote(1));
    await flush();
    sendDraft(drafts, send, "mac-mini", "w1:p1");
    expect(sends.map((s) => s.text)).toEqual([`see these\ntyped ${remote(1)} ${remote(2)}`]);
  });
});

describe("× on a chip", () => {
  it("stops one uploading; one that lands anyway is removed from the machine and never shown", async () => {
    const machine = fakeMachine();
    const drafts = new ComposerDrafts({ transport: () => machine.transport });
    drafts.attach(key, [payload("a.jpg")]);
    const chip = drafts.get(key).chips[0]!;
    drafts.removeChip(key, chip.id);
    expect(machine.cancels).toEqual([machine.uploads[0]!.uploadId]);
    expect(drafts.get(key).chips).toEqual([]);
    machine.uploads[0]!.resolve(remote(1));
    await flush();
    expect(machine.discards.map((d) => d.path)).toEqual([remote(1)]);
    expect(drafts.get(key).chips).toEqual([]);
  });

  it("one waiting its turn never starts; a Send waiting goes without the chip removed", async () => {
    const machine = fakeMachine();
    const drafts = new ComposerDrafts({ transport: () => machine.transport });
    const { sends, send } = sender();
    drafts.attach(key, [payload("a.jpg"), payload("b.jpg"), payload("c.jpg")]);
    const [, second, third] = drafts.get(key).chips;
    drafts.removeChip(key, third!.id);
    expect(machine.cancels).toEqual([]);
    sendDraft(drafts, send, "mac-mini", "w1:p1");
    drafts.removeChip(key, second!.id);
    expect(machine.cancels).toEqual([machine.uploads[1]!.uploadId]);
    machine.uploads[0]!.resolve(remote(1));
    await flush();
    expect(machine.uploads.length).toBe(2);
    expect(sends.map((s) => s.text)).toEqual([remote(1)]);
  });

  it("removes one on the machine from there: removing, then gone", async () => {
    const machine = fakeMachine();
    const drafts = new ComposerDrafts({ transport: () => machine.transport });
    drafts.attach(key, [payload("a.jpg")]);
    machine.uploads[0]!.resolve(remote(1));
    await flush();
    drafts.removeChip(key, drafts.get(key).chips[0]!.id);
    expect(states(drafts)).toEqual(["removing"]);
    expect(machine.discards.map((d) => [d.hostId, d.path])).toEqual([["mac-mini", remote(1)]]);
    machine.discards[0]!.resolve();
    await flush();
    expect(drafts.get(key).chips).toEqual([]);
  });

  it("a removal that goes silent keeps the chip with Retry at its deadline, and the waiting Send refuses", async () => {
    const machine = fakeMachine();
    const drafts = new ComposerDrafts({ transport: () => machine.transport, discardDeadlineMs: 30 });
    const { sends, send } = sender();
    drafts.attach(key, [payload("a.jpg"), payload("b.jpg")]);
    machine.uploads[0]!.resolve(remote(1));
    await flush();
    drafts.edit(key, "only b");
    sendDraft(drafts, send, "mac-mini", "w1:p1");
    expect(drafts.get(key).waiting).toBe(true);
    drafts.removeChip(key, drafts.get(key).chips[0]!.id);
    machine.uploads[1]!.resolve(remote(2));
    await flush();
    // b landed, but the removal of a holds the Send.
    expect(sends).toEqual([]);
    expect(drafts.get(key).waiting).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 60));
    await flush();
    expect(drafts.get(key).chips[0]!.state).toEqual({ kind: "cleanup", path: remote(1), reason: "The machine did not answer in time." });
    expect(sends).toEqual([]);
    expect(drafts.get(key)).toMatchObject({ waiting: false, sending: false, text: "only b" });
    expect(drafts.get(key).error).toBe(
      "Not sent: a.jpg was not removed from the machine (The machine did not answer in time.). Retry or remove it, then send. The message is kept.",
    );
    // Its late answer changes nothing; Retry removes it again.
    machine.discards[0]!.resolve();
    await flush();
    expect(states(drafts)).toEqual(["cleanup", "uploaded"]);
    drafts.retryChip(key, drafts.get(key).chips[0]!.id);
    expect(machine.discards.length).toBe(2);
    machine.discards[1]!.resolve();
    await flush();
    expect(states(drafts)).toEqual(["uploaded"]);
    sendDraft(drafts, send, "mac-mini", "w1:p1");
    expect(sends.map((s) => s.text)).toEqual([`only b ${remote(2)}`]);
  });

  it("a removal that fails refuses the waiting Send; one that succeeds lets it go without the chip", async () => {
    const machine = fakeMachine();
    const drafts = new ComposerDrafts({ transport: () => machine.transport });
    const { sends, send } = sender();
    drafts.attach(key, [payload("a.jpg"), payload("b.jpg")]);
    machine.uploads[0]!.resolve(remote(1));
    await flush();
    sendDraft(drafts, send, "mac-mini", "w1:p1");
    drafts.removeChip(key, drafts.get(key).chips[0]!.id);
    machine.discards[0]!.reject(new Error("Error invoking remote method 'herdr:attachment-discard': Error: permission denied"));
    await flush();
    expect(drafts.get(key).chips[0]!.state).toEqual({ kind: "cleanup", path: remote(1), reason: "permission denied" });
    machine.uploads[1]!.resolve(remote(2));
    await flush();
    expect(sends).toEqual([]);
    expect(drafts.get(key).error).toContain("Not sent: a.jpg was not removed from the machine (permission denied).");
    // × on a chip whose removal failed leaves it (its file is the 30-day sweep's).
    drafts.removeChip(key, drafts.get(key).chips[0]!.id);
    expect(machine.discards.length).toBe(1);
    // Removal that succeeds under a waiting Send: it goes without it.
    drafts.attach(key, [payload("c.jpg")]);
    sendDraft(drafts, send, "mac-mini", "w1:p1");
    drafts.removeChip(key, drafts.get(key).chips[0]!.id);
    machine.discards[1]!.resolve();
    await flush();
    expect(sends).toEqual([]);
    machine.uploads[2]!.resolve(remote(3));
    await flush();
    expect(sends.map((s) => s.text)).toEqual([remote(3)]);
  });

  // Also with no upload left at the press (b already on the machine), where only the removal holds it.
  for (const left of ["no upload left", "b still uploading"] as const) {
    it(`a Send pressed while a removal runs waits for it too (${left})`, async () => {
      const machine = fakeMachine();
      const drafts = new ComposerDrafts({ transport: () => machine.transport });
      const { sends, send } = sender();
      drafts.attach(key, [payload("a.jpg"), payload("b.jpg")]);
      machine.uploads[0]!.resolve(remote(1));
      if (left === "no upload left") machine.uploads[1]!.resolve(remote(2));
      await flush();
      drafts.removeChip(key, drafts.get(key).chips[0]!.id);
      sendDraft(drafts, send, "mac-mini", "w1:p1");
      expect(drafts.get(key).waiting).toBe(true);
      if (left === "b still uploading") machine.uploads[1]!.resolve(remote(2));
      await flush();
      expect(sends).toEqual([]);
      expect(drafts.get(key).waiting).toBe(true);
      machine.discards[0]!.reject(new Error("no answer"));
      await flush();
      expect(sends).toEqual([]);
      expect(drafts.get(key)).toMatchObject({ waiting: false, sending: false });
      expect(drafts.get(key).error).toContain("was not removed from the machine (no answer)");
    });
  }

  it("never removes a file a Send may have taken, a restored draft names, or a Kept draft names", async () => {
    const machine = fakeMachine();
    const drafts = new ComposerDrafts({ transport: () => machine.transport });
    const { sends, send } = sender();
    drafts.attach(key, [payload("a.jpg")]);
    machine.uploads[0]!.resolve(remote(1));
    await flush();
    sendDraft(drafts, send, "mac-mini", "w1:p1");
    sends[0]!.reject(new Error("the reply did not come"));
    await flush();
    drafts.removeChip(key, drafts.get(key).chips[0]!.id);
    expect(drafts.get(key).chips).toEqual([]);
    const other = draftKey("mac-mini", "w1:p2");
    drafts.restore(other, "", [{ path: remote(2), name: "kept.jpg", image: true }], []);
    drafts.removeChip(other, drafts.get(other).chips[0]!.id);
    expect(drafts.get(other).chips).toEqual([]);
    drafts.setAlsoNamed((path) => path === remote(3));
    drafts.attach(key, [payload("c.jpg")]);
    machine.uploads[1]!.resolve(remote(3));
    await flush();
    drafts.removeChip(key, drafts.get(key).chips[0]!.id);
    expect(drafts.get(key).chips).toEqual([]);
    expect(machine.discards).toEqual([]);
  });
});

// A removal already running at the press, or a Retry
// of one while a Send waits, holds that Send as × does: it goes when the removal succeeds, and a removal that
// fails or goes silent refuses it and puts the draft back.
describe("a removal holds a waiting Send", () => {
  for (const outcome of ["success", "failure", "silent"] as const) {
    it(`a removal already running at the press holds a Send with no upload left (${outcome})`, async () => {
      const machine = fakeMachine();
      const drafts = new ComposerDrafts({ transport: () => machine.transport, discardDeadlineMs: 30 });
      const { sends, send } = sender();
      drafts.attach(key, [payload("a.jpg"), payload("b.jpg")]);
      machine.uploads[0]!.resolve(remote(1));
      machine.uploads[1]!.resolve(remote(2));
      await flush();
      drafts.removeChip(key, drafts.get(key).chips[0]!.id);
      drafts.edit(key, "keep b");
      sendDraft(drafts, send, "mac-mini", "w1:p1");
      await flush();
      // Nothing uploads, but a's removal runs: the Send waits for it ("Sends when the upload finishes.").
      expect(sends).toEqual([]);
      expect(drafts.get(key)).toMatchObject({ waiting: true, sending: true, text: "" });
      if (outcome === "success") machine.discards[0]!.resolve();
      else if (outcome === "failure") machine.discards[0]!.reject(new Error("permission denied"));
      else await new Promise((resolve) => setTimeout(resolve, 60));
      await flush();
      if (outcome === "success") {
        expect(sends.map((s) => s.text)).toEqual([`keep b ${remote(2)}`]);
        expect(drafts.get(key).waiting).toBe(false);
        return;
      }
      const reason = outcome === "failure" ? "permission denied" : "The machine did not answer in time.";
      expect(sends).toEqual([]);
      expect(drafts.get(key)).toMatchObject({ waiting: false, sending: false, text: "keep b" });
      expect(drafts.get(key).error).toContain(`Not sent: a.jpg was not removed from the machine (${reason}).`);
      expect(drafts.get(key).chips[0]!.state).toEqual({ kind: "cleanup", path: remote(1), reason });
      expect(states(drafts)).toEqual(["cleanup", "uploaded"]);
      // A late answer to the silent removal changes nothing and sends nothing.
      machine.discards[0]!.resolve();
      await flush();
      expect(sends).toEqual([]);
    });
  }

  for (const outcome of ["failure", "success"] as const) {
    it(`Retry on a chip whose removal failed, while a Send waits, holds that Send until its result (${outcome})`, async () => {
      const machine = fakeMachine();
      const drafts = new ComposerDrafts({ transport: () => machine.transport });
      const { sends, send } = sender();
      drafts.attach(key, [payload("a.jpg")]);
      machine.uploads[0]!.resolve(remote(1));
      await flush();
      const a = drafts.get(key).chips[0]!.id;
      drafts.removeChip(key, a);
      machine.discards[0]!.reject(new Error("old failure"));
      await flush();
      expect(states(drafts)).toEqual(["cleanup"]);
      drafts.attach(key, [payload("b.jpg")]);
      drafts.edit(key, "keep b");
      sendDraft(drafts, send, "mac-mini", "w1:p1");
      expect(drafts.get(key).waiting).toBe(true);
      drafts.retryChip(key, a);
      expect(states(drafts)).toEqual(["removing", "uploading"]);
      machine.uploads[1]!.resolve(remote(2));
      await flush();
      // b is on the machine, but the Retry's removal holds the Send.
      expect(sends).toEqual([]);
      expect(drafts.get(key).waiting).toBe(true);
      if (outcome === "success") {
        machine.discards[1]!.resolve();
        await flush();
        expect(sends.map((s) => s.text)).toEqual([`keep b ${remote(2)}`]);
        return;
      }
      machine.discards[1]!.reject(new Error("retry failure"));
      await flush();
      expect(sends).toEqual([]);
      expect(drafts.get(key)).toMatchObject({ waiting: false, sending: false, text: "keep b" });
      expect(drafts.get(key).error).toContain("Not sent: a.jpg was not removed from the machine (retry failure).");
      expect(states(drafts)).toEqual(["cleanup", "uploaded"]);
    });
  }
});

describe("leaving", () => {
  it("the pane's last box going lets a waiting Send go at once, unsent; a late result never sends", async () => {
    const machine = fakeMachine();
    const drafts = new ComposerDrafts({ transport: () => machine.transport });
    const { sends, send } = sender();
    const chat = drafts.showing(key);
    const overlay = drafts.showing(key);
    drafts.attach(key, [payload("a.jpg")]);
    drafts.edit(key, "before I go");
    sendDraft(drafts, send, "mac-mini", "w1:p1");
    overlay();
    expect(drafts.get(key).waiting).toBe(true);
    chat();
    expect(drafts.get(key)).toMatchObject({ waiting: false, sending: false, text: "before I go", error: drafting.leftBeforeUploadText });
    machine.uploads[0]!.resolve(remote(1));
    await flush();
    expect(sends).toEqual([]);
    expect(states(drafts)).toEqual(["uploaded"]);
  });

  it("the window closing lets every waiting Send go, unsent", async () => {
    const machine = fakeMachine();
    const drafts = new ComposerDrafts({ transport: () => machine.transport });
    const { sends, send } = sender();
    const second = draftKey("build-box", "w2:p1");
    drafts.attach(key, [payload("a.jpg")]);
    drafts.attach(second, [payload("b.jpg")]);
    sendDraft(drafts, send, "mac-mini", "w1:p1");
    sendDraft(drafts, send, "build-box", "w2:p1");
    drafts.leaveAll();
    expect([drafts.get(key).waiting, drafts.get(second).waiting]).toEqual([false, false]);
    for (const upload of machine.uploads) upload.resolve(remote(1));
    await flush();
    expect(sends).toEqual([]);
  });

  it("a pane gone (its draft under Kept drafts): its uploads stop, and one that lands is removed again", async () => {
    const machine = fakeMachine();
    const drafts = new ComposerDrafts({ transport: () => machine.transport });
    drafts.attach(key, [payload("a.jpg"), payload("b.jpg"), payload("c.jpg")]);
    drafts.forget(key);
    expect(machine.cancels).toEqual([machine.uploads[0]!.uploadId, machine.uploads[1]!.uploadId]);
    machine.uploads[0]!.resolve(remote(1));
    machine.uploads[1]!.reject(new Error("stopped"));
    await flush();
    expect(machine.uploads.length).toBe(2);
    expect(machine.discards.map((d) => d.path)).toEqual([remote(1)]);
    expect(drafts.get(key).chips).toEqual([]);
  });
});

describe("a restored draft", () => {
  it("never brings back a chip that was uploading as on the machine: it is named, and Send goes without it", async () => {
    const machine = fakeMachine();
    const drafts = new ComposerDrafts({ transport: () => machine.transport });
    drafts.attach(key, [payload("on.jpg"), payload("going.jpg"), payload("failed.jpg"), payload("removed.jpg")]);
    // on.jpg lands, failed.jpg fails, removed.jpg lands; going.jpg is still uploading.
    machine.uploads[0]!.resolve(remote(1));
    await flush();
    machine.uploads[2]!.reject(new Error("dropped"));
    await flush();
    machine.uploads[3]!.resolve(remote(4));
    await flush();
    drafts.removeChip(key, drafts.get(key).chips[3]!.id);
    drafts.edit(key, "where I was");
    expect(states(drafts)).toEqual(["uploaded", "uploading", "failed", "removing"]);
    // What is kept through a quit.
    const saved = draftInput(drafts.get(key))!;
    expect(saved).toEqual({ text: "where I was", chips: [{ path: remote(1), name: "on.jpg", image: true }], lost: ["going.jpg", "failed.jpg"] });
    // The next launch.
    const next = fakeMachine();
    const restored = new ComposerDrafts({ transport: () => next.transport });
    restored.restore(key, saved.text, saved.chips, saved.lost);
    expect(restored.get(key).chips.map((chip) => [chip.name, chip.state])).toEqual([["on.jpg", { kind: "uploaded", path: remote(1) }]]);
    expect(restored.get(key).lost).toEqual(["going.jpg", "failed.jpg"]);
    const { sends, send } = sender();
    sendDraft(restored, send, "mac-mini", "w1:p1");
    expect(sends.map((s) => s.text)).toEqual([`where I was ${remote(1)}`]);
    expect(next.uploads).toEqual([]);
  });
});

describe("the real Composer", () => {
  interface BridgeUpload {
    readonly extension: string;
    readonly uploadId: string | undefined;
    resolve(path: string): void;
    reject(error: Error): void;
  }
  let sends: Sent[] = [];
  let uploads: BridgeUpload[] = [];
  let discards: { path: string; resolve(): void; reject(error: Error): void }[] = [];

  beforeEach(() => {
    sends = [];
    uploads = [];
    discards = [];
    composerDrafts.clear();
    vi.stubGlobal("window", {
      herdrDesktop: {
        sendToPane: (_h: string, _p: string, text: string) => new Promise<void>((resolve, reject) => sends.push({ text, resolve, reject })),
        uploadAttachment: (_hostId: string, data: Uint8Array, extension: string, uploadId?: string) =>
          new Promise((resolve, reject) => uploads.push({ extension, uploadId, resolve: (path) => resolve({ path, byteCount: data.byteLength }), reject })),
        cancelUpload: () => undefined,
        discardAttachment: (_hostId: string, path: string) => new Promise<void>((resolve, reject) => discards.push({ path, resolve, reject })),
        clipboardFiles: async () => ({ files: [], refused: [], excess: [], failures: [] }),
      },
      getSelection: () => null,
    });
  });

  const mac = { id: "mac-mini", name: "Mac mini", state: "connected" } as HostView;
  const pane = { paneID: "w1:p1", name: "A", workspaceLabel: "ops" } as SidebarRow;
  const file = (name: string, type: string) => ({ name, type, size: 3, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer });

  function composer() {
    const ui = new HookHost(Composer as (props: object) => unknown, { host: mac, row: pane });
    ui.render();
    const textarea = () => find(ui.tree, "textarea")!;
    const button = (label: string) => elements(ui.tree).find((e) => e.type === "button" && e.props["aria-label"] === label);
    return {
      ui,
      type: (value: string) => (textarea().props["onChange"] as (e: unknown) => void)({ target: { value } }),
      enter: () =>
        (textarea().props["onKeyDown"] as (e: unknown) => void)({ key: "Enter", shiftKey: false, nativeEvent: { isComposing: false }, preventDefault: () => undefined }),
      pick: (files: unknown[]) => {
        const input = elements(ui.tree).find((e) => e.type === "input" && e.props["type"] === "file")!;
        (input.props["onChange"] as (e: unknown) => void)({ target: { files, value: "x" } });
      },
      button,
      click: (label: string) => (button(label)!.props["onClick"] as () => void)(),
      note: () => find(ui.tree, "span", "cmp-note-t")?.props["children"],
      dismissNote: () => (find(ui.tree, "button", "cmp-note-x")!.props["onClick"] as () => void)(),
      value: () => textarea().props["value"],
      statuses: () => elements(ui.tree).filter((e) => e.props["className"] === "st").map((e) => e.props["children"]),
    };
  }

  it("uploads picked images before Send, two at a time; Send with all on the machine goes at once", async () => {
    const c = composer();
    c.pick([file("a.jpg", "image/jpeg"), file("b.jpg", "image/jpeg"), file("shot.png", "image/png")]);
    await flush();
    expect(uploads.map((u) => u.extension)).toEqual(["jpg", "jpg"]);
    expect(uploads.every((u) => typeof u.uploadId === "string")).toBe(true);
    expect(c.statuses()).toEqual(["Uploading…", "Uploading…", "Uploading…"]);
    uploads[0]!.resolve(remote(1));
    uploads[1]!.resolve(remote(2));
    await flush();
    expect(uploads.length).toBe(3);
    uploads[2]!.resolve(remote(3));
    await flush();
    expect(c.statuses()).toEqual([]);
    c.type("all three");
    c.enter();
    expect(sends.map((s) => s.text)).toEqual([`all three ${remote(1)} ${remote(2)} ${remote(3)}`]);
    expect(uploads.length).toBe(3);
  });

  it("Send while one uploads shows the note; its × lets the Send go and keeps the draft", async () => {
    const c = composer();
    c.pick([file("a.jpg", "image/jpeg")]);
    await flush();
    c.type("wait");
    c.enter();
    expect(c.note()).toBe("Sends when the upload finishes.");
    expect(c.value()).toBe("");
    // The note stays past the 8 s other notes have (held), until the Send goes or its ×.
    c.dismissNote();
    expect(c.note()).toBeUndefined();
    expect(c.value()).toBe("wait");
    uploads[0]!.resolve(remote(1));
    await flush();
    expect(sends).toEqual([]);
    c.enter();
    expect(sends.map((s) => s.text)).toEqual([`wait ${remote(1)}`]);
  });

  it("an upload failing while the Send waits: Retry on the chip, nothing sent, Retry uploads again", async () => {
    const c = composer();
    c.pick([file("a.jpg", "image/jpeg")]);
    await flush();
    c.type("see");
    c.enter();
    uploads[0]!.reject(new Error("The upload did not finish: the link dropped"));
    await flush();
    expect(sends).toEqual([]);
    expect(c.value()).toBe("see");
    expect(c.note()).toBe("Not sent: a.jpg did not upload (The upload did not finish: the link dropped). The message is kept.");
    expect(c.button("Retry a.jpg")).toBeDefined();
    c.click("Retry a.jpg");
    expect(uploads.length).toBe(2);
    expect(c.button("Retry a.jpg")).toBeUndefined();
  });

  it("× on an image on the machine removes the file there", async () => {
    const c = composer();
    c.pick([file("a.jpg", "image/jpeg")]);
    await flush();
    uploads[0]!.resolve(remote(1));
    await flush();
    c.click("Remove a.jpg");
    expect(discards.map((d) => d.path)).toEqual([remote(1)]);
    expect(c.statuses()).toEqual(["Removing…"]);
    discards[0]!.resolve();
    await flush();
    expect(composerDrafts.get(draftKey("mac-mini", "w1:p1")).chips).toEqual([]);
  });

  it("leaving the pane (another pane shown, or the box gone) lets a waiting Send go and sends nothing", async () => {
    const c = composer();
    c.pick([file("a.jpg", "image/jpeg")]);
    await flush();
    c.type("not yet");
    c.enter();
    // Another pane in the same box.
    c.ui.render({ host: mac, row: { ...pane, paneID: "w1:p2" } });
    const first = composerDrafts.get(draftKey("mac-mini", "w1:p1"));
    expect(first).toMatchObject({ waiting: false, sending: false, text: "not yet" });
    uploads[0]!.resolve(remote(1));
    await flush();
    expect(sends).toEqual([]);
    // The box going (its Chat left).
    c.ui.render({ host: mac, row: pane });
    c.pick([file("b.jpg", "image/jpeg")]);
    await flush();
    c.type("again");
    c.enter();
    c.ui.unmount();
    expect(composerDrafts.get(draftKey("mac-mini", "w1:p1")).waiting).toBe(false);
    uploads[1]!.resolve(remote(2));
    await flush();
    expect(sends).toEqual([]);
  });
});

// A fresh count of uploaded images
// asked for while a count or a Delete now is still pending (a reconnect, a
// section shown) is queued and runs once after it settles, success or failure;
// a failure is not retried in a loop. A machine's count and Delete now
// never run alongside each other: a confirmed Delete now waits behind a count
// (never dropped), and only the machine's current request settles what the
// page shows, so an older count cannot win.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  return { ...actual, ...fakeReact, default: { ...actual, ...fakeReact } };
});

import type { HostView } from "../src/shared/ipc-contract";
import type { UploadsDeleteResult, UploadsInventory } from "../src/shared/settings";
import { HookHost, elements } from "./support/fake-hooks";
import { flush, loadSettings, mountSettings, settingsBridge, sshHost } from "./support/settings-page";

const { uploadsStore } = await import("../src/renderer/settings/uploads-store");
const { UploadsLine } = await import("../src/renderer/settings/SettingsPage");
await loadSettings();

const studio = sshHost("studio", "Studio", { connection: 1 } as Partial<HostView>);

/** Pages mounted by a test: unmounted after it even when it fails, so a failure never leaks into the next test. */
const mounted: { view: { unmount(): void } }[] = [];
const mount = (...args: Parameters<typeof mountSettings>) => {
  const page = mountSettings(...args);
  mounted.push(page);
  return page;
};

beforeEach(() => uploadsStore.reset());
afterEach(() => {
  for (const page of mounted.splice(0)) page.view.unmount();
  vi.unstubAllGlobals();
});

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

/** The fake machine: each count and Delete now waits until the test answers it; how many ran at once is kept. */
function machine() {
  const { bridge, fake } = settingsBridge();
  const counts: Deferred<UploadsInventory>[] = [];
  const deletes: Deferred<UploadsDeleteResult>[] = [];
  const order: string[] = [];
  let running = 0;
  let most = 0;
  const track = <T>(kind: string, request: Deferred<T>): Promise<T> => {
    running += 1;
    most = Math.max(most, running);
    order.push(`${kind} ${kind === "count" ? counts.length : deletes.length}`);
    request.promise.then(
      () => (running -= 1),
      () => (running -= 1),
    );
    return request.promise;
  };
  fake.count = () => {
    const request = deferred<UploadsInventory>();
    counts.push(request);
    return track("count", request);
  };
  fake.remove = () => {
    const request = deferred<UploadsDeleteResult>();
    deletes.push(request);
    return track("delete", request);
  };
  return { bridge, counts, deletes, order, most: () => most };
}

/** The machine's uploads line as the page draws it. */
function line(hostView: HostView = studio) {
  const view = new HookHost<object>(UploadsLine as (props: object) => unknown, { host: hostView, onDelete: () => undefined });
  view.render();
  const all = elements(view.tree);
  const words = all.find((element) => element.props["className"] === "set-up-c")!.props["children"] as string;
  const button = all.find((element) => element.props["children"] === "Delete now")!;
  const outcome = all.find((element) => element.props["className"] === "set-up-o")?.props["children"] ?? null;
  view.unmount();
  return { words, canDelete: button.props["disabled"] !== true, outcome };
}

const offline = { ...studio, state: "offline" } as HostView;
const reconnected = (connection: number) => ({ ...studio, state: "connected", connection }) as HostView;

describe("a fresh count asked for while one is pending runs after it", () => {
  it("a reconnect during a slow count; the old count fails; one new count reads the file and Delete now is on", async () => {
    const m = machine();
    const page = mount("uploads", { bridge: m.bridge, hosts: [studio] });
    await flush();
    expect(m.counts).toHaveLength(1);

    page.rerender({ hosts: [offline] });
    page.rerender({ hosts: [reconnected(2)] });
    await flush();
    // Not alongside the old one.
    expect(m.counts).toHaveLength(1);

    m.counts[0]!.reject(new Error("old connection closed"));
    await flush();
    expect(m.counts).toHaveLength(2);
    m.counts[1]!.resolve({ files: 1, bytes: 9 });
    await flush();
    expect(line()).toMatchObject({ words: "1 file, 9 bytes", canDelete: true });
    expect(m.counts).toHaveLength(2);
    expect(m.most()).toBe(1);
  });

  it("the queued count runs once: if it fails too, nothing is retried in a loop", async () => {
    const m = machine();
    const page = mount("uploads", { bridge: m.bridge, hosts: [studio] });
    await flush();
    page.rerender({ hosts: [reconnected(2)] });
    page.rerender({ hosts: [reconnected(3)] });
    await flush();
    m.counts[0]!.reject(new Error("old connection closed"));
    await flush();
    expect(m.counts).toHaveLength(2);
    m.counts[1]!.reject(new Error("still not answering"));
    await flush();
    await flush();
    expect(m.counts).toHaveLength(2);
    expect(uploadsStore.state("studio")).toEqual({ kind: "failed", reason: "still not answering" });
  });

  // Uploaded images is the one section that counts (Machines has no upload lines).
  it("a section shown while a count is pending gets its own count after it", async () => {
    const m = machine();
    const page = mount("uploads", { bridge: m.bridge, hosts: [studio] });
    await flush();
    page.rerender({ section: "chat" });
    page.rerender({ section: "uploads" });
    await flush();
    expect(m.counts).toHaveLength(1);
    m.counts[0]!.resolve({ files: 0, bytes: 0 });
    await flush();
    expect(m.counts).toHaveLength(2);
    m.counts[1]!.resolve({ files: 2, bytes: 20 });
    await flush();
    expect(line()).toMatchObject({ words: "2 files, 20 bytes", canDelete: true });
  });

  it("a reconnect during a Delete now is counted after the delete settles", async () => {
    const m = machine();
    const page = mount("uploads", { bridge: m.bridge, hosts: [studio] });
    await flush();
    m.counts[0]!.resolve({ files: 1, bytes: 9 });
    await flush();
    const done = uploadsStore.deleteNow(m.bridge as never, "studio");
    await flush();
    expect(m.deletes).toHaveLength(1);
    page.rerender({ hosts: [reconnected(2)] });
    await flush();
    expect(m.counts).toHaveLength(1);
    m.deletes[0]!.reject(new Error("connection lost"));
    await flush();
    // One count after the failed delete (its own and the reconnect's are the same one).
    expect(m.counts).toHaveLength(2);
    m.counts[1]!.resolve({ files: 1, bytes: 9 });
    await done;
    await flush();
    expect(m.counts).toHaveLength(2);
    expect(line()).toMatchObject({ words: "1 file, 9 bytes", canDelete: true, outcome: "Not deleted: connection lost" });
  });
});

describe("a count and a Delete now never overlap; only the current request settles", () => {
  it("confirmation open, an upload's recount starts, confirm, the delete errors: the newest count shows", async () => {
    const m = machine();
    const page = mount("uploads", { bridge: m.bridge, hosts: [studio] });
    await flush();
    m.counts[0]!.resolve({ files: 1, bytes: 9 });
    await flush();

    // The confirmation opens.
    (page.part("UploadsLine")!.props["onDelete"] as () => void)();
    expect(page.find((element) => element.props["data-confirm"] === "delete")).toBeDefined();

    // An upload finishes: its recount starts while the confirmation stays open.
    uploadsStore.invalidate("studio");
    await flush();
    expect(m.counts).toHaveLength(2);

    // Confirmed: it waits for the count (never alongside it), and shows that it is deleting.
    (page.find((element) => element.props["data-confirm"] === "delete")!.props["onClick"] as () => void)();
    await flush();
    expect(m.deletes).toHaveLength(0);
    expect(line().words).toBe("Deleting…");

    // The recount answers (what was there before the delete): it does not settle what the page shows.
    m.counts[1]!.resolve({ files: 1, bytes: 9 });
    await flush();
    expect(m.deletes).toHaveLength(1);
    expect(line().words).toBe("Deleting…");

    // The delete errors; the count after it is the newest, and it is what shows.
    m.deletes[0]!.reject(new Error("permission denied"));
    await flush();
    expect(m.counts).toHaveLength(3);
    m.counts[2]!.resolve({ files: 0, bytes: 0 });
    await flush();
    expect(line()).toMatchObject({ words: "None", canDelete: false, outcome: "Not deleted: permission denied" });
    expect(m.most()).toBe(1);
    expect(m.order).toEqual(["count 1", "count 2", "delete 1", "count 3"]);
  });

  it("a confirmed Delete now is not dropped when the count it waits for fails", async () => {
    const m = machine();
    void uploadsStore.refresh(m.bridge as never, "studio");
    await flush();
    const done = uploadsStore.deleteNow(m.bridge as never, "studio");
    // A second confirmation while it waits is the same Delete now.
    void uploadsStore.deleteNow(m.bridge as never, "studio");
    m.counts[0]!.reject(new Error("timed out"));
    await flush();
    expect(m.deletes).toHaveLength(1);
    m.deletes[0]!.resolve({ removedFiles: 2, removedBytes: 20, removedFolders: 1, keptFiles: 0, stopped: null, remaining: { files: 0, bytes: 0 } });
    await done;
    expect(m.deletes).toHaveLength(1);
    expect(uploadsStore.state("studio")).toEqual({ kind: "counted", inventory: { files: 0, bytes: 0 } });
    expect(m.most()).toBe(1);
  });

  it("an upload that settles during the delete is counted after it; nothing ran alongside", async () => {
    const m = machine();
    void uploadsStore.refresh(m.bridge as never, "studio");
    m.counts[0]!.resolve({ files: 1, bytes: 9 });
    await flush();
    const done = uploadsStore.deleteNow(m.bridge as never, "studio");
    await flush();
    uploadsStore.invalidate("studio");
    m.deletes[0]!.resolve({ removedFiles: 1, removedBytes: 9, removedFolders: 1, keptFiles: 0, stopped: null, remaining: { files: 0, bytes: 0 } });
    await flush();
    expect(m.counts).toHaveLength(2);
    m.counts[1]!.resolve({ files: 1, bytes: 5 });
    await done;
    expect(uploadsStore.state("studio")).toEqual({ kind: "counted", inventory: { files: 1, bytes: 5 } });
    expect(m.most()).toBe(1);
  });

  it("a machine removed while its count is pending: the old answer does not bring its row back", async () => {
    const m = machine();
    void uploadsStore.refresh(m.bridge as never, "studio");
    await flush();
    uploadsStore.forget("studio");
    m.counts[0]!.resolve({ files: 4, bytes: 40 });
    await flush();
    expect(uploadsStore.state("studio")).toEqual({ kind: "unknown" });
  });
});

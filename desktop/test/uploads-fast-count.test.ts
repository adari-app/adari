// Settings' count of uploads must come back fast. Every upload
// is a folder of its own in the home (~/.adari-attachments-<32 hex>/
// attachment-<uuid>.<ext>), so walking the home and then each folder one after
// another would cost two waits for the machine per upload. Instead: one
// listing of the home, then the upload folders 32 at a time, each folder's
// REALPATH and READDIR asked together (src/main/uploads/sweep.ts
// inventoryUploads): a few hundred uploads come back well within 2 s over a
// home network. The rules: only the uploader's own names in
// its own folders, never through a symlink. A count that cannot finish within
// 2 s answers what it counted so far, marked partial, and goes on; the page's
// next ask joins it, and Delete now stops it (src/main/uploads/service.ts).
//
// The machine is test/support/latency-sftp.ts (an ssh2 SFTP session over a
// link with a round trip and a byte rate, on fake timers), its listings as
// macOS's and Linux's sftp-server answer them (longname, ".", "..", the
// home's other folders and files).

import { afterEach, describe, expect, it, vi } from "vitest";

import { countAnswerMs, keptCountMs, UploadService } from "../src/main/uploads/service";
import { ssh2UploadSftp } from "../src/main/uploads/sftp";
import { inventoryLanes, inventoryUploads, InventoryStoppedError } from "../src/main/uploads/sweep";
import type { UploadEntry, UploadSftp } from "../src/main/uploads/upload";
import { UploadsStore } from "../src/renderer/settings/uploads-store";
import { uploadFilePrefix, uploadFolderPrefix } from "../src/shared/attachments";
import { canDeleteUploads, deleteConfirmButton, deleteConfirmMessage } from "../src/shared/settings";
import { LatencySftp, type LinkModel } from "./support/latency-sftp";

afterEach(() => {
  vi.useRealTimers();
});

const hex = (n: number, width: number): string => n.toString(16).padStart(width, "0");

type Form = "macOS" | "Linux";

/**
 * A machine's sftp-server as each OS answers READDIR: "." and ".." first, a longname in that OS's `ls -l` form, the
 * home's own folders and files beside the uploads (a symlinked upload folder too, never counted).
 */
class OsSftp extends LatencySftp {
  constructor(
    link: LinkModel,
    readonly form: Form,
  ) {
    super(link, form === "macOS" ? "/Users/me" : "/home/me");
  }

  /** Folders that vanish as their listing is asked for (deleted between the home's listing and their own). */
  readonly vanishing = new Set<string>();

  override readdir(path: string, done: (error: Error | null | undefined, value?: unknown) => void): void {
    if (this.vanishing.has(path)) for (const key of this.nodes.keys()) if (key === path || key.startsWith(`${path}/`)) this.nodes.delete(key);
    super.readdir(path, (error, value) => {
      if (error) return done(error);
      const entries = value as { filename: string; attrs: { mode: number; size: number; mtime: number } }[];
      const dir = { mode: 0o040755, size: this.form === "macOS" ? 96 : 4_096, mtime: 1_800_000_000 };
      const named = [{ filename: ".", attrs: dir }, { filename: "..", attrs: dir }, ...entries].map((entry) => ({
        ...entry,
        attrs: { ...entry.attrs, uid: 501, gid: 20, atime: entry.attrs.mtime },
        longname: this.longname(entry.filename, entry.attrs),
      }));
      done(null, named);
    });
  }

  private longname(name: string, attrs: { mode: number; size: number }): string {
    const type = (attrs.mode & 0o170000) === 0o040000 ? "d" : (attrs.mode & 0o170000) === 0o120000 ? "l" : "-";
    const bits = (attrs.mode & 0o777).toString(2).padStart(9, "0").split("").map((bit, index) => (bit === "1" ? "rwx"[index % 3] : "-")).join("");
    return this.form === "macOS"
      ? `${type}${bits}    1 me       staff    ${String(attrs.size).padStart(8)} Nov 10 09:12 ${name}`
      : `${type}${bits}    2 me       me       ${String(attrs.size).padStart(8)} Nov 10 09:12 ${name}`;
  }
}

const homeLink: LinkModel = { rttMs: 40, bytesPerSecond: 1_000_000 };

/** `count` uploads (one file each, sizes cycling), the home's own things beside them; the bytes counted. */
function seed(sftp: LatencySftp, count: number): { files: number; bytes: number } {
  const node = (kind: "file" | "directory", mode: number, size = 0) => ({ kind, mode, data: new Uint8Array(size), mtime: 1_800_000_000_000 });
  const home = sftp.home;
  let bytes = 0;
  for (let i = 0; i < count; i += 1) {
    const folder = `${home}/${uploadFolderPrefix}${hex(0x5eed + i * 7919, 32)}`;
    const size = [182_400, 96_350, 411_900, 58_120][i % 4]!;
    sftp.nodes.set(folder, node("directory", 0o040700));
    sftp.nodes.set(`${folder}/${uploadFilePrefix}${hex(i + 1, 8)}-5e7a-4c1d-9a2b-${hex(0x3c0ffee + i, 12)}.png`, node("file", 0o100600, size));
    bytes += size;
  }
  // Not the app's: the home's own folders and files, a stray file in an upload folder, a folder named almost right.
  for (const name of ["Documents", "Library", ".cache", ".adari", "lost+found"]) sftp.nodes.set(`${home}/${name}`, node("directory", 0o040755));
  sftp.nodes.set(`${home}/.DS_Store`, node("file", 0o100644, 6_148));
  sftp.nodes.set(`${home}/${uploadFolderPrefix}${hex(0x5eed, 32)}/notes.txt`, node("file", 0o100644, 999));
  sftp.nodes.set(`${home}/${uploadFolderPrefix}NOT-HEX`, node("directory", 0o040700));
  // A symlinked "upload folder" (its listing would be the target's): never counted.
  sftp.nodes.set(`${home}/${uploadFolderPrefix}${hex(0xbad, 32)}`, { ...node("directory", 0o120777) });
  return { files: count, bytes };
}

/** Runs `work` on fake timers to its end (steps of `step` ms); the model's milliseconds it took. */
async function timed<T>(work: () => Promise<T>, step = 5): Promise<{ value: T; ms: number }> {
  const start = Date.now();
  let value: T | undefined;
  let failed: unknown = null;
  let done = false;
  void work().then(
    (result) => ((value = result), (done = true)),
    (error: unknown) => ((failed = error), (done = true)),
  );
  for (let i = 0; i < 20_000 && !done; i += 1) await vi.advanceTimersByTimeAsync(step);
  if (failed !== null) throw failed;
  if (!done) throw new Error("did not finish");
  return { value: value as T, ms: Date.now() - start };
}

describe("a few hundred uploads are counted within 2 s (the listing form of macOS and of Linux)", () => {
  for (const form of ["macOS", "Linux"] as const) {
    it(`${form}: 300 uploads over a 40 ms home link: the right count, within 2 s, in a dozen waits for the machine`, async () => {
      vi.useFakeTimers({ now: 1_800_000_000_000 });
      const sftp = new OsSftp(homeLink, form);
      const expected = seed(sftp, 300);
      const { value, ms } = await timed(() => inventoryUploads(ssh2UploadSftp(sftp as never)));
      expect(value).toEqual(expected);
      expect(ms).toBeLessThan(2_000);
      // One listing of the home, then the folders 32 at a time (each REALPATH and READDIR together): about 12 waits
      // where the walk before made two per upload (600 here, about 24 s at 40 ms).
      expect(sftp.rounds).toBeLessThanOrEqual(Math.ceil(300 / inventoryLanes) + 3);
      // The home once, then each upload folder once (not the folder named almost right, not the symlinked one).
      expect(sftp.lines().filter((line) => line.startsWith("readdir "))).toHaveLength(1 + 300);
      expect(sftp.lines().some((line) => /^(open|write|unlink|rmdir|rename|mkdir|chmod) /u.test(line))).toBe(false);
    });
  }

  it("a slow link (150 ms round trips): still within 2 s for 300", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    const sftp = new OsSftp({ rttMs: 150, bytesPerSecond: 250_000 }, "Linux");
    const expected = seed(sftp, 300);
    const { value, ms } = await timed(() => inventoryUploads(ssh2UploadSftp(sftp as never)));
    expect(value).toEqual(expected);
    expect(ms).toBeLessThan(2_000);
  });

  it("the walk one folder at a time takes about two round trips per upload: the reason for lanes", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    const sftp = new OsSftp(homeLink, "macOS");
    const expected = seed(sftp, 300);
    const { value, ms } = await timed(() => inventoryUploads(ssh2UploadSftp(sftp as never), { lanes: 1 }));
    expect(value).toEqual(expected);
    // One lane still asks each folder's REALPATH and READDIR together: one wait per upload, 12 s at 40 ms.
    expect(ms).toBeGreaterThan(300 * homeLink.rttMs);
  });

  it("an upload folder gone between the listing and its read is passed by; any other failure fails the count", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    const sftp = new OsSftp(homeLink, "Linux");
    seed(sftp, 40);
    sftp.vanishing.add(`${sftp.home}/${uploadFolderPrefix}${hex(0x5eed + 3 * 7919, 32)}`);
    const { value } = await timed(() => inventoryUploads(ssh2UploadSftp(sftp as never)));
    expect(value.files).toBe(39);
    const failing = new OsSftp(homeLink, "Linux");
    seed(failing, 40);
    failing.failures.set(`readdir ${failing.home}/${uploadFolderPrefix}${hex(0x5eed + 5 * 7919, 32)}`, "Permission denied");
    await expect(timed(() => inventoryUploads(ssh2UploadSftp(failing as never)))).rejects.toThrow("Permission denied");
  });

  it("says what it counted after each folder, and stops before its next request when asked to", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    const sftp = new OsSftp(homeLink, "macOS");
    seed(sftp, 100);
    const seen: number[] = [];
    const stop = new AbortController();
    const run = timed(() =>
      inventoryUploads(ssh2UploadSftp(sftp as never), {
        signal: stop.signal,
        progress: (counted) => {
          seen.push(counted.files);
          if (counted.files >= 40) stop.abort();
        },
      }),
    );
    await expect(run).rejects.toBeInstanceOf(InventoryStoppedError);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(sftp.lines().filter((line) => line.startsWith("readdir ")).length).toBeLessThan(1 + 100);
  });
});

describe("Settings' count answers within 2 s: the whole count, or what is counted so far (partial) while it goes on", () => {
  function service(sftp: LatencySftp) {
    const backend = { uploads: () => ({ machineKey: "me@box", withFiles: <T>(work: (s: unknown) => Promise<T>) => work(ssh2UploadSftp(sftp as never)) }) };
    const log = { lastSweep: () => Date.now(), noteSweep: () => undefined };
    return new UploadService({ backend: (id) => (id === "box" ? (backend as never) : null) }, log, () => Date.now());
  }

  it("a fast machine: the whole count, not partial", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    const sftp = new OsSftp(homeLink, "Linux");
    const expected = seed(sftp, 300);
    const { value, ms } = await timed(() => service(sftp).count("box"));
    expect(value).toEqual(expected);
    expect(value.partial).toBeUndefined();
    expect(ms).toBeLessThan(countAnswerMs);
  });

  it("a machine too slow for 2 s: what is counted so far, marked partial, at 2 s; the next ask joins the same count and gets the whole", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    // 400 ms round trips: the home in two (0.8 s), then a batch of 32 folders each 0.4 s: about 4.8 s for 300.
    const sftp = new OsSftp({ rttMs: 400, bytesPerSecond: 250_000 }, "macOS");
    const expected = seed(sftp, 300);
    const uploads = service(sftp);
    const first = await timed(() => uploads.count("box"));
    expect(first.ms).toBe(countAnswerMs);
    expect(first.value.partial).toBe(true);
    expect(first.value.files).toBeGreaterThan(0);
    expect(first.value.files).toBeLessThan(300);
    expect(first.value.bytes).toBeGreaterThan(0);
    const homes = sftp.lines().filter((line) => line === "realpath .").length;
    const again = await timed(() => uploads.count("box", 60_000));
    expect(again.value).toEqual(expected);
    // Joined: the machine was not walked again.
    expect(sftp.lines().filter((line) => line === "realpath .").length).toBe(homes);
    expect(sftp.lines().filter((line) => line.startsWith(`readdir ${sftp.home}`) && line.length === `readdir ${sftp.home}`.length)).toHaveLength(1);
  });

  it("Delete now stops a count running there (its answer would be stale), and a later count walks again", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    const sftp = new OsSftp({ rttMs: 700, bytesPerSecond: 250_000 }, "Linux");
    seed(sftp, 20);
    const uploads = service(sftp);
    const partial = await timed(() => uploads.count("box"));
    expect(partial.value.partial).toBe(true);
    const removed = await timed(() => uploads.deleteNow("box"), 50);
    expect(removed.value.removedFiles).toBe(20);
    const homes = sftp.lines().filter((line) => line === "realpath .").length;
    const after = await timed(() => uploads.count("box", 60_000), 50);
    expect(sftp.lines().filter((line) => line === "realpath .").length).toBeGreaterThan(homes);
    expect(after.value).toEqual({ files: 0, bytes: 0 });
  });
});

// A machine in memory whose upload folders each take `delay` to list.
describe("the count after a partial answer, after an upload, and after a failure", () => {
  const h = "/fake/uploads-home";
  const folder = (n: number) => `${h}/${uploadFolderPrefix}${hex(n, 32)}`;
  const name = (n: number) => `${uploadFilePrefix}${hex(n, 8)}-1111-4111-8111-111111111111.png`;
  const entry = (entryName: string, kind: UploadEntry["kind"], size: number | null = 3): UploadEntry => ({ name: entryName, kind, size, modifiedMs: 0 });
  const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  class Fake {
    readonly dirs = new Map<string, UploadEntry[]>();
    active = 0;
    max = 0;
    lists = 0;
    delay = 0;
    constructor(n = 2) {
      this.dirs.set(h, Array.from({ length: n }, (_, i) => entry(folder(i).slice(h.length + 1), "directory")));
      for (let i = 0; i < n; i += 1) this.dirs.set(folder(i), [entry(name(i), "file", 10 + i)]);
    }
    add(n: number, size: number): void {
      this.dirs.get(h)!.push(entry(folder(n).slice(h.length + 1), "directory"));
      this.dirs.set(folder(n), [entry(name(n), "file", size)]);
    }
    realpath = async (path: string) => (path === "." ? h : path);
    list = async (path: string) => {
      this.lists += 1;
      this.active += 1;
      this.max = Math.max(this.max, this.active);
      if (path !== h && this.delay > 0) await wait(this.delay);
      this.active -= 1;
      return [...(this.dirs.get(path) ?? [])];
    };
    unlink = async () => undefined;
    rmdir = async () => undefined;
  }

  function service(files: Fake) {
    const backend = { uploads: () => ({ machineKey: "fake@uploads", withFiles: <T>(work: (sftp: UploadSftp) => Promise<T>) => work(files as never) }) };
    return new UploadService({ backend: () => backend as never }, { lastSweep: () => 0, noteSweep: () => undefined });
  }

  it("a count that ends after its partial answer is kept for the next ask, which gets it without walking again", async () => {
    vi.useFakeTimers();
    const files = new Fake(1);
    files.delay = 2_010;
    const uploads = service(files);
    const first = uploads.count("box");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await first).toEqual({ files: 0, bytes: 0, partial: true });
    // The page's next ask arrives 25 ms later, after the walk ended.
    await vi.advanceTimersByTimeAsync(25);
    const lists = files.lists;
    const next = uploads.count("box");
    await vi.runAllTimersAsync();
    expect(await next).toEqual({ files: 1, bytes: 10 });
    expect(files.lists).toBe(lists);
    // Taken: the ask after that walks again.
    const again = uploads.count("box", 60_000);
    await vi.runAllTimersAsync();
    expect(await again).toEqual({ files: 1, bytes: 10 });
    expect(files.lists).toBeGreaterThan(lists);
  });

  it("a kept count is dropped by a Delete now, an upload's end, a fresh ask, and after 30 s", async () => {
    vi.useFakeTimers();
    const files = new Fake(1);
    files.delay = 2_010;
    const uploads = service(files);
    const keptThenAsk = async (drop: () => Promise<unknown> | void, fresh = false) => {
      const first = uploads.count("box");
      await vi.advanceTimersByTimeAsync(2_050);
      expect((await first).partial).toBe(true);
      await drop();
      const lists = files.lists;
      const next = uploads.count("box", 60_000, fresh);
      await vi.runAllTimersAsync();
      await next;
      return files.lists - lists;
    };
    expect(await keptThenAsk(() => undefined)).toBe(0);
    expect(await keptThenAsk(() => undefined, true)).toBeGreaterThan(0);
    expect(await keptThenAsk(() => vi.advanceTimersByTimeAsync(keptCountMs))).toBeGreaterThan(0);
    expect(
      await keptThenAsk(async () => {
        const deleting = uploads.deleteNow("box");
        await vi.runAllTimersAsync();
        await deleting;
      }),
    ).toBeGreaterThan(0);
  });

  it("the page: a 2.010 s walk and 25 ms replies settle on the whole count, never partial for good", async () => {
    vi.useFakeTimers();
    const files = new Fake(1);
    files.delay = 2_010;
    const uploads = service(files);
    const store = new UploadsStore();
    const bridge = {
      uploadsCount: async (id: string, fresh?: boolean) => {
        const answer = await uploads.count(id, countAnswerMs, fresh === true);
        await wait(25);
        return answer;
      },
      deleteUploadsNow: async () => {
        throw new Error("unused");
      },
    };
    const run = store.refresh(bridge, "box");
    await vi.advanceTimersByTimeAsync(6_200);
    const state = store.state("box");
    store.reset();
    await vi.runAllTimersAsync();
    await run;
    expect(state).toEqual({ kind: "counted", inventory: { files: 1, bytes: 10 } });
  });

  for (const forwards of [true, false]) {
    it(`the page: an upload during a slow count is in the count it settles on (a bridge that ${forwards ? "passes" : "drops"} "fresh")`, async () => {
      vi.useFakeTimers();
      const files = new Fake(60);
      files.delay = 1_200;
      const uploads = service(files);
      const store = new UploadsStore();
      const asked: boolean[] = [];
      const bridge = {
        uploadsCount: (id: string, fresh?: boolean) => (asked.push(fresh === true), uploads.count(id, countAnswerMs, forwards && fresh === true)),
        deleteUploadsNow: async () => {
          throw new Error("unused");
        },
      };
      const run = store.refresh(bridge, "box");
      await vi.advanceTimersByTimeAsync(100);
      // The home is listed already; an upload adds its own folder, and the page hears of it.
      files.add(61, 50);
      store.invalidate("box");
      await vi.runAllTimersAsync();
      await run;
      const state = store.state("box");
      store.reset();
      expect(state).toEqual({ kind: "counted", inventory: { files: 61, bytes: 2_420 } });
      // One fresh ask, after the walk that began before the upload had ended.
      expect(asked.filter(Boolean)).toHaveLength(1);
    });
  }

  it("an upload while nothing of the page's runs: the next count is a fresh ask", async () => {
    vi.useFakeTimers();
    const files = new Fake(2);
    const uploads = service(files);
    const store = new UploadsStore();
    const asked: boolean[] = [];
    const bridge = {
      uploadsCount: (id: string, fresh?: boolean) => (asked.push(fresh === true), uploads.count(id, countAnswerMs, fresh === true)),
      deleteUploadsNow: async () => {
        throw new Error("unused");
      },
    };
    await store.refresh(bridge, "box");
    files.add(7, 5);
    store.invalidate("box");
    expect(store.state("box")).toEqual({ kind: "unknown" });
    await store.refresh(bridge, "box");
    expect(asked).toEqual([false, true]);
    expect(store.state("box")).toEqual({ kind: "counted", inventory: { files: 3, bytes: 26 } });
    store.reset();
  });

  it("a fresh ask never joins a walk already running: it gets one started after that walk", async () => {
    vi.useFakeTimers();
    const files = new Fake(40);
    files.delay = 1_200;
    const uploads = service(files);
    const old = uploads.count("box", 60_000);
    await vi.advanceTimersByTimeAsync(100);
    files.add(41, 50);
    const fresh = uploads.count("box", 60_000, true);
    await vi.runAllTimersAsync();
    expect(await old).toEqual({ files: 40, bytes: 1_180 });
    expect(await fresh).toEqual({ files: 41, bytes: 1_230 });
    // Never beside it: at most 32 folders listed at once.
    expect(files.max).toBeLessThanOrEqual(inventoryLanes);
  });

  it("a failed folder: no lane takes another, the failure answers at once, and a new count starts only once the others settled", async () => {
    vi.useFakeTimers();
    const files = new Fake(100);
    files.delay = 100;
    const uploads = service(files);
    const list = files.list;
    let fail = true;
    files.list = async (path) => {
      if (path === folder(0) && fail) {
        fail = false;
        throw new Error("permission denied");
      }
      return list(path);
    };
    expect(await uploads.count("box").catch((error: Error) => error.message)).toBe("permission denied");
    const retry = uploads.count("box");
    await vi.runAllTimersAsync();
    expect((await retry).files).toBe(100);
    expect(files.max).toBeLessThanOrEqual(inventoryLanes);
    // The failed walk listed only what its lanes had under way: 31 folders, then nothing more.
    expect(files.lists).toBe(1 + 31 + 1 + 100);
  });

  it("the walk itself settles every listing under way before it fails, with the first error", async () => {
    vi.useFakeTimers();
    const files = new Fake(10);
    files.delay = 100;
    const list = files.list;
    files.list = async (path) => {
      if (path === folder(1)) throw new Error("first");
      if (path === folder(2)) {
        await wait(10);
        throw new Error("second");
      }
      return list(path);
    };
    const seen: unknown[] = [];
    let settled = false;
    const walk = inventoryUploads(files as never, { failed: (error) => seen.push(error) }).finally(() => (settled = true));
    walk.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(seen.map((error) => (error as Error).message)).toEqual(["first"]);
    expect(settled).toBe(false);
    await vi.runAllTimersAsync();
    await expect(walk).rejects.toThrow("first");
    expect(files.active).toBe(0);
  });

  it("Delete now is usable on a partial count, even one that has found nothing yet; not on a whole count of none", () => {
    expect(canDeleteUploads({ kind: "counted", inventory: { files: 0, bytes: 0, partial: true } })).toBe(true);
    expect(canDeleteUploads({ kind: "counted", inventory: { files: 3, bytes: 9, partial: true } })).toBe(true);
    expect(canDeleteUploads({ kind: "counted", inventory: { files: 0, bytes: 0 } })).toBe(false);
    expect(canDeleteUploads({ kind: "counting" })).toBe(false);
    // The confirmation names a number of files only for a whole count.
    const partial = { kind: "counted", inventory: { files: 3, bytes: 9, partial: true } } as const;
    expect(deleteConfirmButton(partial)).toBe("Delete files");
    expect(deleteConfirmMessage(partial, "Mac mini")).toBe(
      "The images and files Adari uploaded to Mac mini are deleted from Adari's upload folders there. Nothing else on the machine is touched. Files an upload under way, a draft or a send in this app still uses are kept.",
    );
    expect(deleteConfirmButton({ kind: "counted", inventory: { files: 3, bytes: 9 } })).toBe("Delete 3 files");
  });
});

// Main's model lists per
// machine and agent (src/main/model-catalogs.ts) with a fake runner: shown
// from the cache first and read again behind, the 10-minute rule, a failing
// CLI keeps the list and says why (Claude Code with none: its four aliases),
// one read at a time per machine and agent, nothing read until asked; the
// remote script quoted (run for real by /bin/sh against a stand-in program in
// the scratch folder, never an agent's CLI); the demo machine answering from
// its fixtures; This Mac's direct run; the disk cache holding only models.

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { DemoRemote } from "../src/main/demo/demo-remote";
import { demoModelLists } from "../src/main/demo/demo-model-lists";
import {
  catalogCacheText,
  catalogRetryMs,
  FileCatalogStore,
  LocalCatalogRunner,
  ModelCatalogs,
  parseCatalogCache,
  readRemoteList,
  RemoteCatalogRunner,
  remoteListCommand,
  type CatalogRunner,
  type CatalogStore,
  type ListRun,
  type StoredCatalog,
} from "../src/main/model-catalogs";
import { claudeFallback, claudeInitializeLine, listCommand, type CatalogAgent, type CatalogView, type ListCommand } from "../src/shared/model-catalog";
import { scratch as scratchRoot } from "./support/this-mac-fake";

// The test scratch folder (HERDR_TEST_SCRATCH), one folder per run.
const scratch = mkdtempSync(path.join(scratchRoot, "pickers-"));

/** A runner that answers from a script of runs, one per call, counting them. */
class FakeRunner implements CatalogRunner {
  readonly where = "Mac mini";
  readonly runs: { agent: CatalogAgent; command: ListCommand }[] = [];
  next: (() => Promise<ListRun>)[] = [];

  run(agent: CatalogAgent, command: ListCommand): Promise<ListRun> {
    this.runs.push({ agent, command });
    const answer = this.next.shift();
    return answer === undefined ? Promise.resolve({ kind: "ran", code: 0, output: demoModelLists[agent as Exclude<CatalogAgent, "agy">] }) : answer();
  }
}

class MemoryStore implements CatalogStore {
  saved: readonly StoredCatalog[] = [];
  constructor(private readonly initial: readonly StoredCatalog[] = []) {}
  load(): Promise<readonly StoredCatalog[]> {
    return Promise.resolve(this.initial);
  }
  save(catalogs: readonly StoredCatalog[]): Promise<void> {
    this.saved = catalogs;
    return Promise.resolve();
  }
}

function service(options: { runner?: FakeRunner; store?: CatalogStore | null; start?: string | null; connected?: boolean; deadlineMs?: number } = {}) {
  const runner = options.runner ?? new FakeRunner();
  let now = 1_000_000;
  const changes: { hostId: string; view: CatalogView }[] = [];
  const catalogs = new ModelCatalogs({
    machine: () => (options.connected === false ? null : { runner, startCommand: async () => options.start ?? null }),
    store: options.store === undefined ? new MemoryStore() : options.store,
    now: () => now,
    changed: (hostId, view) => changes.push({ hostId, view }),
    ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
  });
  return {
    catalogs,
    runner,
    changes,
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
  };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

describe("the catalog service", () => {
  it("runs nothing until asked; the first ask reads behind and the list comes as a change", async () => {
    const s = service();
    expect(s.runner.runs).toHaveLength(0);
    const first = await s.catalogs.view("mini", "codex");
    expect(first).toMatchObject({ agent: "codex", models: [], loading: true, error: null });
    await flush();
    expect(s.runner.runs.map((run) => run.command.args)).toEqual([["debug", "models"]]);
    const last = s.changes.at(-1)!;
    expect(last.hostId).toBe("mini");
    expect(last.view.loading).toBe(false);
    expect(last.view.models).toHaveLength(9);
    expect(last.view.readAt).toBe(s.now());
  });

  it("shows the cached list at once and reads it again behind only when older than 10 minutes", async () => {
    const s = service();
    await s.catalogs.settled("mini", "grok");
    expect(s.runner.runs).toHaveLength(1);
    s.advance(9 * 60_000);
    const fresh = await s.catalogs.view("mini", "grok");
    expect(fresh.models).toHaveLength(4);
    expect(fresh.loading).toBe(false);
    expect(s.runner.runs).toHaveLength(1);
    s.advance(60_001);
    const old = await s.catalogs.view("mini", "grok");
    // The old list shows while the new read runs.
    expect(old.models).toHaveLength(4);
    expect(old.loading).toBe(true);
    await flush();
    expect(s.runner.runs).toHaveLength(2);
  });

  it("the disk's list is shown first after a restart, and read again behind when old", async () => {
    const stored: StoredCatalog = { host: "mini", agent: "grok", readAt: 1_000_000 - 11 * 60_000, models: [{ id: "grok-4.5", label: "Grok 4.5", group: null, efforts: [], defaultEffort: null, isDefault: true }] };
    const s = service({ store: new MemoryStore([stored]) });
    const view = await s.catalogs.view("mini", "grok");
    expect(view.models.map((model) => model.id)).toEqual(["grok-4.5"]);
    expect(view.loading).toBe(true);
    await flush();
    expect(s.changes.at(-1)!.view.models).toHaveLength(4);
  });

  it("a failing CLI keeps the list it had and says why in one line, never a throw", async () => {
    const s = service();
    await s.catalogs.settled("mini", "cursor");
    s.advance(11 * 60_000);
    s.runner.next.push(() => Promise.resolve({ kind: "ran", code: 1, output: "Error: You are not logged in\n" }));
    await s.catalogs.refresh("mini", "cursor");
    const view = await s.catalogs.view("mini", "cursor");
    expect(view.models).toHaveLength(143);
    // The program's own line (stdout here, a message), not only its exit code.
    expect(view.error).toBe("Could not read Cursor's models: You are not logged in.");
    // A failure that says nothing plain: its exit code.
    s.runner.next.push(() => Promise.resolve({ kind: "ran", code: 1, output: "" }));
    await s.catalogs.refresh("mini", "cursor");
    expect((await s.catalogs.view("mini", "cursor")).error).toBe("Could not read Cursor's models: it ended with exit 1.");
    // A missing program, a time out, a cut answer: each in its words.
    s.runner.next.push(() => Promise.resolve({ kind: "missing" }));
    await s.catalogs.refresh("mini", "cursor");
    expect((await s.catalogs.view("mini", "cursor")).error).toBe("Could not read Cursor's models: cursor was not found on Mac mini.");
    s.runner.next.push(() => Promise.reject(new Error("its answer was cut off")));
    await s.catalogs.refresh("mini", "cursor");
    expect((await s.catalogs.view("mini", "cursor")).error).toBe("Could not read Cursor's models: its answer was cut off.");
    // Fixed: the next good read clears the line.
    await s.catalogs.refresh("mini", "cursor");
    expect((await s.catalogs.view("mini", "cursor")).error).toBeNull();
  });

  it("a run past its time is stopped and said so; the box is never held", async () => {
    const s = service({ deadlineMs: 20 });
    s.runner.next.push(() => new Promise<ListRun>(() => undefined));
    await s.catalogs.refresh("mini", "opencode");
    expect((await s.catalogs.view("mini", "opencode")).error).toBe("Could not read OpenCode's models: it did not answer within 20 s.");
  });

  it("Claude Code with no list yet and a failing run: its four aliases, marked as the fallback", async () => {
    const s = service();
    s.runner.next.push(() => Promise.resolve({ kind: "missing" }));
    const view = await s.catalogs.settled("mini", "claude");
    expect(view.models.map((model) => model.id)).toEqual(claudeFallback.map((model) => model.id));
    expect(view.error).toBe("Could not read Claude Code's models: claude was not found on Mac mini. Showing its four aliases.");
    expect(view.readAt).toBeNull();
    // The fallback is never written to disk.
    const store = new MemoryStore();
    const t = service({ store });
    t.runner.next.push(() => Promise.resolve({ kind: "missing" }));
    await t.catalogs.settled("mini", "claude");
    expect(store.saved).toEqual([]);
  });

  it("Claude Code's read sends the initialize request on stdin, through `claude`, never the wrapper", async () => {
    const s = service({ start: "cl" });
    const view = await s.catalogs.settled("mini", "claude");
    expect(s.runner.runs[0]!.command).toMatchObject({ program: "claude", stdin: claudeInitializeLine });
    expect(view.models[0]).toMatchObject({ id: "default", note: "Fable 5.2" });
  });

  it("one read at a time per machine and agent; another machine or agent reads on its own", async () => {
    const s = service();
    let release: (run: ListRun) => void = () => undefined;
    s.runner.next.push(() => new Promise<ListRun>((resolve) => (release = resolve)));
    const a = s.catalogs.refresh("mini", "codex");
    const b = s.catalogs.refresh("mini", "codex");
    void s.catalogs.view("mini", "codex");
    expect(a).toBe(b);
    void s.catalogs.refresh("box", "codex");
    void s.catalogs.refresh("mini", "grok");
    await flush();
    expect(s.runner.runs.map((run) => run.agent)).toEqual(["codex", "codex", "grok"]);
    release({ kind: "ran", code: 0, output: demoModelLists.codex });
    await a;
    expect((await s.catalogs.view("mini", "codex")).models).toHaveLength(9);
  });

  it("a machine not connected reads nothing and says so", async () => {
    const s = service({ connected: false });
    const view = await s.catalogs.settled("mini", "codex");
    expect(view.error).toBe("Could not read Codex's models: the machine is not connected.");
    expect(s.runner.runs).toHaveLength(0);
  });

  it("a failed read is tried again a minute later, not on every open", async () => {
    const s = service();
    s.runner.next.push(() => Promise.resolve({ kind: "missing" }));
    await s.catalogs.settled("mini", "grok");
    await s.catalogs.view("mini", "grok");
    await flush();
    expect(s.runner.runs).toHaveLength(1);
    s.advance(catalogRetryMs);
    await s.catalogs.view("mini", "grok");
    await flush();
    expect(s.runner.runs).toHaveLength(2);
  });

  it("Antigravity CLI: no read, its line", async () => {
    const s = service();
    expect((await s.catalogs.view("mini", "agy")).none).toBe("Antigravity CLI's models are in its own picker.");
    expect(s.runner.runs).toHaveLength(0);
  });
});

describe("another Mac: the remote script", () => {
  it("quotes every value: the program, each argument (the empty one too) and the stdin line", () => {
    const command = remoteListCommand("claude", listCommand("claude", null)!, "t0k3n0f0n3r3adAbc123");
    expect(command.intent).toEqual({ kind: "model-list", agent: "claude", token: "t0k3n0f0n3r3adAbc123" });
    expect(command.text.startsWith("/bin/sh -c '")).toBe(true);
    // The JSON line's double quotes stay inside single quotes; the empty --setting-sources value is ''.
    expect(command.text).toContain("control_request");
    expect(command.text).not.toMatch(/\$\(cat|`/);
  });

  it("runs as one /bin/sh line: the stand-in program gets its arguments and stdin exactly; a missing one says so", () => {
    const bin = path.join(scratch, "bin");
    mkdirSync(bin, { recursive: true });
    const program = path.join(bin, "fakeclaude");
    writeFileSync(program, '#!/bin/sh\nfor a in "$@"; do printf "[%s]" "$a"; done\nprintf "\\n"\ncat\nexit 3\n');
    chmodSync(program, 0o755);
    const env = { HOME: scratch, SHELL: "/bin/sh", PATH: "/usr/bin:/bin" };
    const run = (command: ListCommand): ListRun => {
      const text = remoteListCommand("claude", command, "t0k3n0f0n3r3adAbc123").text;
      const script = text.slice("/bin/sh -c ".length);
      // The text is what SSH runs: /bin/sh -c '<script>'; here /bin/sh reads it the same way.
      const out = execFileSync("/bin/sh", ["-c", `/bin/sh -c ${script}`], { env, encoding: "utf8" });
      return readRemoteList(out, "t0k3n0f0n3r3adAbc123");
    };
    const answer = run({ program, args: ["-p", "--setting-sources", "", "it's"], stdin: claudeInitializeLine, timeoutMs: 1_000 });
    expect(answer).toEqual({ kind: "ran", code: 3, output: `[-p][--setting-sources][][it's]\n${claudeInitializeLine}\n` });
    expect(run({ program: path.join(bin, "nothing-here"), args: [], stdin: null, timeoutMs: 1_000 })).toEqual({ kind: "missing" });
    // `~/` is the machine's home.
    writeFileSync(path.join(scratch, "tilde-prog"), '#!/bin/sh\nprintf "home"\n');
    chmodSync(path.join(scratch, "tilde-prog"), 0o755);
    expect(run({ program: "~/tilde-prog", args: [], stdin: null, timeoutMs: 1_000 })).toEqual({ kind: "ran", code: 0, output: "home" });
  });

  it("an answer without its exit line was cut: refused", () => {
    expect(() => readRemoteList("partial list", "t0k3n0f0n3r3adAbc123")).toThrow("its answer was cut off");
  });

  it("the demo machine answers from its fixtures, through the same runner", async () => {
    const remote = new RemoteCatalogRunner(new DemoRemote([], { read: async () => new Uint8Array(), size: async () => 0 } as never, Date.now()), "Mac mini");
    const s = service();
    const catalogs = new ModelCatalogs({ machine: () => ({ runner: remote, startCommand: async () => null }), store: null, now: () => 1, changed: () => undefined });
    for (const [agent, count] of [["codex", 9], ["grok", 4], ["cursor", 143], ["opencode", 48], ["claude", 14]] as const) {
      expect((await catalogs.settled("demo", agent)).models).toHaveLength(count);
    }
    expect(s.runner.runs).toHaveLength(0);
  });
});

describe("This Mac: the program run directly", () => {
  it("argv in the login environment, stdin the one line, stdout read; a missing program and a large list said so", async () => {
    const bin = path.join(scratch, "local");
    mkdirSync(bin, { recursive: true });
    writeFileSync(path.join(bin, "lister"), '#!/bin/sh\nfor a in "$@"; do printf "[%s]" "$a"; done\nprintf "\\n"\ncat\n');
    chmodSync(path.join(bin, "lister"), 0o755);
    writeFileSync(path.join(bin, "flood"), "#!/bin/sh\nhead -c 5000000 /dev/zero | tr '\\0' a\n");
    chmodSync(path.join(bin, "flood"), 0o755);
    const runner = new LocalCatalogRunner(() => ({ PATH: `${bin}:/usr/bin:/bin`, HOME: scratch }), scratch);
    const signal = new AbortController().signal;
    expect(await runner.run("claude", { program: "lister", args: ["-p", "", "a b"], stdin: '{"x":1}', timeoutMs: 1_000 }, signal)).toEqual({ kind: "ran", code: 0, output: '[-p][][a b]\n{"x":1}\n' });
    expect(await runner.run("codex", { program: "not-a-program-here", args: [], stdin: null, timeoutMs: 1_000 }, signal)).toEqual({ kind: "missing" });
    await expect(runner.run("codex", { program: "flood", args: [], stdin: null, timeoutMs: 5_000 }, signal)).rejects.toThrow("its list is larger than 4 MB");
  });
});

describe("the disk cache", () => {
  it("holds only each model's own fields: Claude Code's account never reaches it", async () => {
    const file = path.join(scratch, "cache", "model-catalogs.json");
    const store = new FileCatalogStore(file);
    const s = service({ store });
    await s.catalogs.settled("mini", "claude");
    await s.catalogs.settled("mini", "codex");
    const text = readFileSync(file, "utf8");
    for (const word of ["example.invalid", "Example Org", "account", "organization", "general-purpose", "output_style"]) expect(text).not.toContain(word);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const loaded = await store.load();
    expect(loaded.map((entry) => [entry.host, entry.agent, entry.models.length])).toEqual([
      ["mini", "claude", 14],
      ["mini", "codex", 9],
    ]);
  });

  it("drops anything that is not a list it wrote, and keeps at most 64", () => {
    expect(parseCatalogCache("not json")).toEqual([]);
    expect(parseCatalogCache('{"version":2,"catalogs":[]}')).toEqual([]);
    const model = { id: "m", label: "M", group: null, efforts: [], defaultEffort: null, isDefault: false, account: "x@y" };
    const parsed = parseCatalogCache(JSON.stringify({ version: 1, catalogs: [{ host: "h", agent: "codex", readAt: 1, models: [model, { id: 3 }] }, { host: "h", agent: "gemini", readAt: 1, models: [model] }] }));
    expect(parsed).toEqual([{ host: "h", agent: "codex", readAt: 1, models: [{ id: "m", label: "M", group: null, efforts: [], defaultEffort: null, isDefault: false }] }]);
    const many = Array.from({ length: 70 }, (_, index): StoredCatalog => ({ host: `h${index}`, agent: "grok", readAt: index, models: [{ id: "grok-1", label: "G", group: null, efforts: [], defaultEffort: null, isDefault: false }] }));
    expect(parseCatalogCache(catalogCacheText(many))).toHaveLength(64);
  });
});

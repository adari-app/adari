// Antigravity CLI's models when its own list cannot be read. `agy models` (1.5.14) prints its 23 rows on
// a signed-in Mac's terminal, but inside an SSH session it exits 1 with "Fetching available models..." and "Error:
// Please sign in to view available models. ..." on stderr (fixtures/agy/models-ssh-signin-1.5.14.txt; its sign-in is
// in the Mac's login keychain). While no list was ever read for the machine, the built-in list (agyBuiltIn: the 23
// rows of fixtures/agy/builtin-1.5.14.txt) stands in under one line, and is never stored; a later read replaces it.
// A CLI with no `agy models` (1.5.13: the command is unknown) keeps the bare line. The SSH read here is the real
// remote script run by /bin/sh against a stand-in `agy` in the test scratch folder that prints the sample's stderr.
// The same cases as Tests/HerdrKitTests/AgyListTests.swift.

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { agyListCaptureSteps } from "../src/main/agy-list-captures";
import { DemoRemote } from "../src/main/demo/demo-remote";
import { demoHostIds } from "../src/main/demo/demo-hosts";
import { ModelCatalogs, plainSaid, readRemoteList, RemoteCatalogRunner, type CatalogStore, type ListRun, type StoredCatalog } from "../src/main/model-catalogs";
import {
  agyBuiltIn,
  agyFallbackLine,
  agyLacksListCommand,
  agySshSignInLine,
  agySshSignInReason,
  antigravityNoList,
  firstPlainLine,
  parseCatalog,
  saidLine,
  saysAgySignIn,
  type CatalogView,
} from "../src/shared/model-catalog";
import { flagWords, listedModels } from "../src/shared/model-choices";
import { agyPreselect, lastStartChoice, rememberStartChoice } from "../src/shared/model-prefs";
import { OutputCollector, type RemoteCommand, type RemoteCommandOutput, type RemoteCommandRunner } from "../src/shared/remote-command";
import { scratch as scratchRoot } from "./support/this-mac-fake";

const { newAgentFlags } = await import("../src/main/ipc");

const fixture = (name: string): string => readFileSync(path.join(__dirname, "..", "fixtures", "agy", name), "utf8");
const signInStderr = fixture("models-ssh-signin-1.5.14.txt");
const localList = fixture("builtin-1.5.14.txt");
const listOutput = fixture("models-1.5.14.txt");

const scratch = mkdtempSync(path.join(scratchRoot, "agy-list-"));

/** What the stand-in `agy` does now: the sample's stderr and exit 1 (over SSH), a list, or 1.5.13's unknown command. */
type Answer = "ssh-sign-in" | "list" | "unknown-command";

/**
 * The machine reached over SSH: each command run by /bin/sh as SSH runs it, with a stand-in `agy` on its PATH that
 * answers as `answer` says (never the real CLI).
 */
class StandInMachine implements RemoteCommandRunner {
  answer: Answer = "ssh-sign-in";
  runs = 0;
  private readonly bin = path.join(scratch, "bin");

  constructor() {
    mkdirSync(this.bin, { recursive: true });
    writeFileSync(path.join(scratch, "ssh-stderr.txt"), signInStderr);
    writeFileSync(path.join(scratch, "list.txt"), listOutput);
    writeFileSync(
      path.join(this.bin, "agy"),
      [
        "#!/bin/sh",
        `A=$(cat ${JSON.stringify(path.join(scratch, "answer"))})`,
        `case "$A" in`,
        `  ssh-sign-in) cat ${JSON.stringify(path.join(scratch, "ssh-stderr.txt"))} >&2; exit 1;;`,
        `  list) cat ${JSON.stringify(path.join(scratch, "list.txt"))}; exit 0;;`,
        `  *) printf 'error: unknown command "%s"\\n' "$1" >&2; exit 1;;`,
        "esac",
        "",
      ].join("\n"),
    );
    chmodSync(path.join(this.bin, "agy"), 0o755);
  }

  run(command: RemoteCommand, maxOutputBytes: number): Promise<RemoteCommandOutput> {
    this.runs += 1;
    writeFileSync(path.join(scratch, "answer"), this.answer);
    const env = { HOME: scratch, SHELL: "/bin/sh", PATH: `${this.bin}:/usr/bin:/bin` };
    const out = execFileSync("/bin/sh", ["-c", command.text], { env, encoding: "utf8" });
    const collector = new OutputCollector(maxOutputBytes);
    collector.append(new TextEncoder().encode(out));
    return Promise.resolve(collector.output);
  }
}

class MemoryStore implements CatalogStore {
  saved: readonly StoredCatalog[] = [];
  saves = 0;
  load(): Promise<readonly StoredCatalog[]> {
    return Promise.resolve([]);
  }
  save(catalogs: readonly StoredCatalog[]): Promise<void> {
    this.saves += 1;
    this.saved = catalogs;
    return Promise.resolve();
  }
}

function overSsh() {
  const machine = new StandInMachine();
  const store = new MemoryStore();
  let now = 1_000_000;
  const changes: CatalogView[] = [];
  const catalogs = new ModelCatalogs({
    machine: () => ({ runner: new RemoteCatalogRunner(machine, "Mac mini"), startCommand: async () => null }),
    store,
    now: () => now,
    changed: (_hostId, view) => changes.push(view),
  });
  return { machine, store, catalogs, changes, advance: (ms: number) => (now += ms) };
}

describe("the samples and the built-in list", () => {
  it("the built-in list is the local sample's 23 rows, ids and names as printed, in the CLI's order", () => {
    const parsed = parseCatalog("agy", localList);
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(agyBuiltIn).toEqual(parsed.models);
    expect(agyBuiltIn).toHaveLength(23);
    expect(agyBuiltIn[0]).toEqual({ id: "gemini-4-neon-high", label: "Gemini 4 Neon (High)", group: null, efforts: [], defaultEffort: null, isDefault: false });
    expect(agyBuiltIn.at(-1)?.id).toBe("gpt-oss-120b-medium");
    // The recorded list of the merged round (its "Fetching" line first) names the same rows.
    const recorded = parseCatalog("agy", listOutput);
    expect(recorded.ok && recorded.models).toEqual(agyBuiltIn);
    // Grouped as a read list is: one row per model, Gemini 4 Neon first.
    expect(listedModels("agy", agyBuiltIn).map((row) => row.label)).toEqual([
      "Gemini 4 Neon",
      "Gemini 4 Argon",
      "Gemini 4 Hydrogen",
      "Orchestrator (Neon)",
      "Orchestrator (Argon)",
      "Gemini 3.8 Flash",
      "Claude Opus 5.5",
      "Claude Sonnet 5.5",
      "GPT-OSS 120B",
    ]);
  });

  it("the SSH sign-in output names no row; its said line is the sign-in, not the progress line", () => {
    expect(parseCatalog("agy", signInStderr).ok).toBe(false);
    expect(firstPlainLine(signInStderr)).toBe("Fetching available models...");
    expect(saidLine(signInStderr)).toBe("Please sign in to view available models. Launch the CLI without arguments to sign in.");
    expect(saysAgySignIn(saidLine(signInStderr)!)).toBe(true);
    expect(agyLacksListCommand(signInStderr)).toBe(false);
  });

  it("1.5.13's answer (the command is unknown) is told from it by its words", () => {
    for (const line of ['error: unknown command "models"', "unknown command", "error: unrecognized subcommand 'models'", "Error: no such command: models", "invalid command models"]) {
      expect(agyLacksListCommand(line)).toBe(true);
      expect(saysAgySignIn(line)).toBe(false);
    }
    for (const line of ["its answer was cut off", "it ended with exit 1", "Please sign in to view available models.", "agy was not found on Mac mini"]) expect(agyLacksListCommand(line)).toBe(false);
  });

  it("over SSH the sign-in becomes its fixed reason for Antigravity CLI only; another agent's words stay its own", () => {
    const run: ListRun = { kind: "ran", code: 1, output: "", said: saidLine(signInStderr)! };
    expect(plainSaid("agy", run)).toEqual({ ...run, said: agySshSignInReason });
    expect(plainSaid("codex", run)).toEqual(run);
    expect(plainSaid("agy", { ...run, code: 0 })).toEqual({ ...run, code: 0 });
    // Cursor's keychain words are said as before.
    expect(plainSaid("cursor", { kind: "ran", code: 1, output: "", said: "Your macOS login keychain is locked." })).toMatchObject({ said: "the Mac's login keychain is locked over SSH" });
  });

  it("the lines: the sign-in one, and any other failure's could-not-read line with the note", () => {
    expect(agySshSignInLine).toBe("Antigravity CLI cannot list its models over SSH (its sign-in is in the Mac's keychain). Showing the models Adari knows.");
    expect(agyFallbackLine(agySshSignInReason)).toBe(agySshSignInLine);
    expect(agyFallbackLine("its answer was cut off")).toBe("Could not read Antigravity CLI's models: its answer was cut off. Showing the models Adari knows.");
  });
});

describe("the SSH read, through the real remote script", () => {
  it("the frame holds exit 1 and the sample's two stderr lines; the run says the sign-in", async () => {
    const machine = new StandInMachine();
    machine.answer = "ssh-sign-in";
    const token = "t0k3n0f0n3r3adAbc123";
    const { remoteListCommand } = await import("../src/main/model-catalogs");
    const out = await machine.run(remoteListCommand("agy", { program: "agy", args: ["models"], stdin: null, timeoutMs: 1_000 }, token), 1 << 20);
    const run = readRemoteList(new TextDecoder().decode(out.bytes), token);
    expect(run).toEqual({ kind: "ran", code: 1, output: "", said: "Please sign in to view available models. Launch the CLI without arguments to sign in." });
  });

  it("the view: the 23 built-in rows under the sign-in line, nothing stored, never read", async () => {
    const s = overSsh();
    const view = await s.catalogs.settled("mini", "agy");
    expect(view).toMatchObject({ agent: "agy", readAt: null, error: agySshSignInLine, none: null, loading: false });
    expect(view.models).toEqual(agyBuiltIn);
    expect(s.store.saves).toBe(0);
    expect(s.store.saved).toEqual([]);
    // New agent's check of the preselect against the same list: `--model gemini-4-neon-high`; Default: no model.
    expect(flagWords(await newAgentFlags(s.catalogs, "mini", { workspaceId: "w1", folder: null, kind: "agy", ...agyPreselect }))).toEqual(["--model", "gemini-4-neon-high"]);
    expect(await newAgentFlags(s.catalogs, "mini", { workspaceId: "w1", folder: null, kind: "agy", model: null, effort: null })).toEqual([]);
    expect(await newAgentFlags(s.catalogs, "mini", { workspaceId: "w1", folder: null, kind: "agy" })).toEqual([]);
    // settled did not read again for each check (the built-in list is a list): the one read, and the one a picked
    // start begins behind it (ipc.ts newAgentFlags), which asks to sign in again and keeps the built-in list.
    expect(s.machine.runs).toBe(2);
    await s.catalogs.afterReading("mini", "agy");
    expect(await s.catalogs.view("mini", "agy")).toMatchObject({ models: agyBuiltIn, readAt: null, error: agySshSignInLine });
    expect(s.store.saves).toBe(0);
  });

  it("a later successful read replaces the built-in rows and clears the line; a failed read after it keeps the read rows (unchanged)", async () => {
    const s = overSsh();
    await s.catalogs.settled("mini", "agy");
    s.machine.answer = "list";
    s.advance(60_000);
    await s.catalogs.refresh("mini", "agy");
    const read = await s.catalogs.view("mini", "agy");
    expect(read).toMatchObject({ readAt: 1_060_000, error: null, none: null });
    expect(read.models).toEqual(agyBuiltIn);
    expect(read.models).not.toBe(agyBuiltIn);
    expect(s.store.saved).toEqual([{ host: "mini", agent: "agy", readAt: 1_060_000, models: agyBuiltIn }]);
    s.machine.answer = "ssh-sign-in";
    s.advance(11 * 60_000);
    await s.catalogs.refresh("mini", "agy");
    const after = await s.catalogs.view("mini", "agy");
    expect(after).toMatchObject({ readAt: 1_060_000, error: "Could not read Antigravity CLI's models: its sign-in is in the Mac's keychain, which SSH cannot open.", none: null });
    expect(after.models).toEqual(agyBuiltIn);
    expect(s.store.saved).toEqual([{ host: "mini", agent: "agy", readAt: 1_060_000, models: agyBuiltIn }]);
  });

  it("1.5.13 (no `agy models`): the bare line, no row, no model sent (unchanged)", async () => {
    const s = overSsh();
    s.machine.answer = "unknown-command";
    const view = await s.catalogs.settled("mini", "agy");
    expect(view).toMatchObject({ agent: "agy", models: [], readAt: null, error: null, none: antigravityNoList });
    expect(await newAgentFlags(s.catalogs, "mini", { workspaceId: "w1", folder: null, kind: "agy" })).toEqual([]);
    await expect(newAgentFlags(s.catalogs, "mini", { workspaceId: "w1", folder: null, kind: "agy", ...agyPreselect })).rejects.toThrow("Nothing was made.");
  });

  it("a sign-in asked on This Mac itself (not over SSH): the could-not-read line with the CLI's words and the note", async () => {
    const catalogs = new ModelCatalogs({
      machine: () => ({ runner: { where: "this Mac", run: async () => ({ kind: "ran", code: 1, output: "", said: saidLine(signInStderr)! }) }, startCommand: async () => null }),
      store: null,
      now: () => 0,
      changed: () => undefined,
    });
    const view = await catalogs.settled("local", "agy");
    expect(view.error).toBe("Could not read Antigravity CLI's models: Please sign in to view available models. Launch the CLI without arguments to sign in. Showing the models Adari knows.");
    expect(view.models).toEqual(agyBuiltIn);
  });
});

describe("New agent's pick for Antigravity CLI with nothing remembered", () => {
  const storage = () => {
    const map = new Map<string, string>();
    return { map, getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => void map.set(key, value) };
  };

  it("Gemini 4 Neon with High; a remembered choice wins, Default included; other agents unchanged", () => {
    const s = storage();
    expect(lastStartChoice(s, "mini", "agy")).toEqual({ model: "gemini-4-neon-high", effort: "high" });
    rememberStartChoice(s, "mini", "agy", { model: null, effort: null });
    expect(lastStartChoice(s, "mini", "agy")).toEqual({ model: null, effort: null });
    expect(JSON.parse(s.map.get("adari.newAgent.models")!)).toEqual({ "mini|agy": { model: null, effort: null } });
    rememberStartChoice(s, "mini", "agy", { model: "claude-opus-5-5-low", effort: "low" });
    expect(lastStartChoice(s, "mini", "agy")).toEqual({ model: "claude-opus-5-5-low", effort: "low" });
    // Another machine: nothing remembered there.
    expect(lastStartChoice(s, "box", "agy")).toEqual(agyPreselect);
    // The other agents: nothing remembered is their own default, and Default takes the entry out, as before.
    for (const agent of ["claude", "codex", "grok", "cursor", "opencode"] as const) {
      expect(lastStartChoice(s, "mini", agent)).toEqual({ model: null, effort: null });
      rememberStartChoice(s, "mini", agent, { model: null, effort: null });
      expect(Object.keys(JSON.parse(s.map.get("adari.newAgent.models")!))).not.toContain(`mini|${agent}`);
    }
  });
});

describe("the captures 303-304 and the demo's SSH answer", () => {
  it("the pane's Model chip, then New agent with nothing remembered for build-box; build-box's list set up and put back", async () => {
    const said: string[] = [];
    const steps = agyListCaptureSteps(demoHostIds, async (step) => void said.push(step));
    expect(steps.map((step) => step.name)).toEqual(["303-agy-builtin-model-menu", "304-agy-builtin-new-agent"]);
    await steps[0]!.before!();
    await steps[1]!.afterCapture!();
    expect(said).toEqual(["built-in", "restore"]);
    expect(steps[1]!.commands).toEqual([{ type: "open-new-agent", hostId: demoHostIds.buildBox, workspaceId: "w3" }]);
    expect(steps[1]!.page![0]).toContain(`${demoHostIds.buildBox}|agy`);
  });

  it("the demo machine's `agy models` answers as 1.5.14 does over SSH while a capture says: the built-in list under the sign-in line", async () => {
    const remote = new DemoRemote([], { read: async () => null } as never, 0);
    remote.keychainLocked.add("agy");
    const catalogs = new ModelCatalogs({
      machine: () => ({ runner: new RemoteCatalogRunner(remote, "build-box"), startCommand: async () => null }),
      store: null,
      now: () => 0,
      changed: () => undefined,
    });
    const view = await catalogs.settled("box", "agy");
    expect(view).toMatchObject({ models: agyBuiltIn, readAt: null, error: agySshSignInLine, none: null });
    remote.keychainLocked.delete("agy");
    catalogs.forgetForCapture("box", "agy");
    await catalogs.refresh("box", "agy");
    expect(await catalogs.view("box", "agy")).toMatchObject({ readAt: 0, error: null, none: null });
  });
});

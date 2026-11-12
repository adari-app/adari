// This Mac without SSH. The features an SSH machine has, run on
// the local session (src/main/herdr/local.ts) behind HerdrTuiBackend's
// connect seam, against a fake Herdr in the scratch folder
// (test/support/this-mac-fake.ts): a fake `herdr` on a temporary PATH and the
// API socket served in this process. The command lines are the SSH route's
// (commands.ts, locator.ts, git.ts), so the real /usr/bin/base64 and
// /usr/bin/nc carry each request to the fake socket, as they do on a Mac
// over SSH. No SSH, no real herdr, no real socket, no real home folder.

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { officialFramePrefix } from "../src/main/herdr/terminal";
import { HostRegistry } from "../src/main/hosts";
import { ThisMacBackend, thisMacDescriptor, thisMacId } from "../src/main/this-mac";
import { ssh2UploadSftp } from "../src/main/uploads/sftp";
import { UploadService } from "../src/main/uploads/service";
import type { UploadSweepLog } from "../src/main/uploads/sweep";
import { isOwnedUploadPath, isUploadFolder } from "../src/shared/attachments";
import { defaultChangesLimits } from "../src/shared/changes/git";
import { AgentChangesGitReader, CommandGate } from "../src/shared/changes/reader";
import { makeSessionRef } from "../src/shared/chat/locator";
import { gitEnvironment, makeRepository, makeRoot } from "./support/changes-git";
import { closeFakeMacs, eventually, makeFakeMac } from "./support/this-mac-fake";

const backends: ThisMacBackend[] = [];

function backendOn(fake: ReturnType<typeof makeFakeMac>, env: Readonly<Record<string, string>> = {}): ThisMacBackend {
  const backend = new ThisMacBackend(fake.options(env));
  backends.push(backend);
  return backend;
}

afterEach(async () => {
  for (const backend of backends.splice(0)) backend.close();
  await closeFakeMacs();
});

describe.skipIf(process.platform !== "darwin")("This Mac on the local session (no SSH)", () => {
  it("the sidebar loads: session.snapshot through the login shell's nc to Herdr's socket, This Mac first", async () => {
    const fake = makeFakeMac();
    const server = await fake.serve();
    const backend = backendOn(fake);

    const topology = await backend.snapshot();
    expect(topology.tabs.map((tab) => tab.tabID)).toEqual(["w1:t1"]);
    expect(topology.panes.map((pane) => pane.paneID)).toEqual(["w1:p1", "w1:p2"]);
    expect(topology.agents.map((agent) => agent.paneID)).toEqual(["w1:p1"]);
    expect(server.requests.map((request) => request.method)).toEqual(["session.snapshot"]);

    // In the machines list: This Mac sits first, ahead of a machine added before it, and answers.
    const registry = new HostRegistry(() => undefined);
    registry.add({ id: "studio", name: "Studio Mac", kind: "ssh", address: "me@studio.local:22", platform: null }, fake.live.backend());
    registry.add(thisMacDescriptor(), backend);
    await registry.refreshAll();
    const [first, second] = registry.list();
    expect(first).toMatchObject({ id: thisMacId, name: "This Mac", kind: "local", state: "connected", error: null });
    expect(first?.topology?.panes.map((pane) => pane.paneID)).toEqual(["w1:p1", "w1:p2"]);
    expect(first).not.toHaveProperty("notRunning");
    expect(second?.id).toBe("studio");
    registry.stop();
  });

  it("an agent.prompt round trip: the request reaches Herdr and its reply comes back", async () => {
    const fake = makeFakeMac();
    await fake.serve();
    const backend = backendOn(fake);

    await backend.prompt("w1:p1", "Run the tests, then tell me what failed.");
    expect(fake.prompts).toEqual([{ target: "w1:p1", text: "Run the tests, then tell me what failed." }]);
    const sent = fake.server!.requests.find((request) => request.method === "agent.prompt");
    expect(sent?.id).toMatch(/^herdrkit:agent\.prompt:\d+$/);
  });

  it("the held event stream delivers an event, and closing it ends the subscription", async () => {
    const fake = makeFakeMac();
    const server = await fake.serve();
    const backend = backendOn(fake);
    const heard: { kind: string; pane: string | null }[] = [];
    let started = false;
    const ended: (string | null)[] = [];

    const stream = backend.subscribeEvents(["pane.agent_status_changed", "layout.updated"], {
      started: () => {
        started = true;
      },
      event: (kind, pane) => heard.push({ kind, pane }),
      ended: (reason) => ended.push(reason),
    });
    await eventually(() => started, "subscription_started");
    expect(server.requests.at(-1)).toMatchObject({ method: "events.subscribe" });
    expect(server.subscribers()).toBe(1);

    server.push("pane_agent_status_changed", { pane_id: "w1:p1", agent_status: "blocked" });
    await eventually(() => heard.length === 1, "the event");
    expect(heard).toEqual([{ kind: "pane.agent_status_changed", pane: "w1:p1" }]);

    stream.close();
    await eventually(() => server.subscribers() === 0, "the subscription to end");
    expect(ended).toEqual([]);
  });

  it("a terminal attaches through a PTY, echoes what is typed and follows a resize", async () => {
    const fake = makeFakeMac();
    await fake.serve();
    const backend = backendOn(fake);
    // The fake is the herdr the login shell finds (never a real one).
    const found = await backend.changesRunner().runReadOnlyCommand("command -v herdr", 4_096);
    expect(found.trim()).toBe(path.join(fake.bin, "herdr"));

    const topology = await backend.snapshot();
    const pane = topology.panes.find((candidate) => candidate.paneID === "w1:p1")!;
    let output = Buffer.alloc(0);
    const exits: (string | null)[] = [];
    const handle = await backend.openTerminal(pane, { cols: 90, rows: 30 }, {
      data: (bytes) => {
        output = Buffer.concat([output, Buffer.from(bytes)]);
      },
      exit: (reason) => exits.push(reason),
    });
    await eventually(() => output.indexOf(officialFramePrefix) >= 0, "Herdr's first frame");
    // The pane's terminal id, as attachTargetFor picks it over SSH.
    expect(fake.argv()).toEqual(["--session default terminal attach term-w1:p1"]);

    handle.input(new TextEncoder().encode("hello from This Mac\r"));
    await eventually(() => output.toString("utf8").includes("echo:hello from This Mac"), "the echo");

    handle.input(new TextEncoder().encode("size\r"));
    await eventually(() => output.toString("utf8").includes("size 30 90"), "the first size");
    handle.resize(120, 40);
    await eventually(
      () => {
        if (output.toString("utf8").includes("size 40 120")) return true;
        handle.input(new TextEncoder().encode("size\r"));
        return false;
      },
      "the size after the resize",
    );

    handle.input(new TextEncoder().encode("quit\r"));
    await eventually(() => exits.length === 1, "the attach to end");
    expect(exits).toEqual([null]);
  });

  it("a Chat transcript is found by its session id under ~/.claude, read, and read again as it grows", async () => {
    const fake = makeFakeMac();
    const backend = backendOn(fake);
    const id = "6f1c2b9e-4d3a-4e8b-9c7d-2a1b3c4d5e6f";
    const folder = path.join(fake.home, ".claude", "projects", "-Users-me-shop");
    mkdirSync(folder, { recursive: true });
    const file = path.join(folder, `${id}.jsonl`);
    const first = `${JSON.stringify({ type: "user", message: { role: "user", content: "Fix the receipt layout." } })}\n`;
    writeFileSync(file, first);

    const reader = backend.transcripts();
    const ref = makeSessionRef("claude", { kind: "id", id })!;
    const located = await reader.locate(ref);
    expect(located).toBe(file);
    expect(await reader.size(file)).toBe(Buffer.byteLength(first));
    expect(Buffer.from(await reader.read(file, 0, 1_000_000)).toString("utf8")).toBe(first);

    const second = `${JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Done." }] } })}\n`;
    appendFileSync(file, second);
    const grown = await reader.size(file);
    expect(grown).toBe(Buffer.byteLength(first + second));
    expect(Buffer.from(await reader.read(file, Buffer.byteLength(first), 1_000_000)).toString("utf8")).toBe(second);
    // The subagents folder listing and a missing file read as over SFTP.
    await expect(reader.size(path.join(folder, "missing.jsonl"))).rejects.toThrow(/missing\.jsonl/);
    expect(await reader.home()).toBe(fake.home);
  });

  it("an image upload is a local copy in the attachments folder (the helpers' names), and the 30-day sweep removes it later", async () => {
    const fake = makeFakeMac();
    const backend = backendOn(fake);
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489", "hex");
    const log: UploadSweepLog & { notes: string[] } = {
      notes: [],
      lastSweep: () => null,
      noteSweep(machine) {
        this.notes.push(machine);
      },
    };
    const hosts = { backend: (hostId: string) => (hostId === thisMacId ? backend : null) };

    const uploaded = await new UploadService(hosts, log).upload(thisMacId, png, "png");
    expect(uploaded.byteCount).toBe(png.length);
    expect(isOwnedUploadPath(uploaded.path, fake.home)).toBe(true);
    expect(isUploadFolder(path.dirname(uploaded.path), fake.home)).toBe(true);
    expect(readFileSync(uploaded.path).equals(png)).toBe(true);
    expect(statSync(uploaded.path).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(uploaded.path)).mode & 0o777).toBe(0o700);

    // Forty days on (the file and its folder dated back), a fresh run's sweep removes both.
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1_000);
    utimesSync(uploaded.path, old, old);
    utimesSync(path.dirname(uploaded.path), old, old);
    const swept = await new UploadService(hosts, log).sweep(thisMacId);
    expect(swept).toMatchObject({ removedFiles: 1, removedFolders: 1, keptFiles: 0, stopped: null });
    expect(existsSync(path.dirname(uploaded.path))).toBe(false);
    expect(log.notes).toEqual([backend.uploads().machineKey]);
    expect(backend.uploads().machineKey).toMatch(/@this-mac$/);
  });

  it("a folder listing (SFTP readdir) lists a temporary tree, a symlink as itself", async () => {
    const fake = makeFakeMac();
    const backend = backendOn(fake);
    const tree = path.join(fake.home, "projects");
    mkdirSync(path.join(tree, "shop", "Receipts"), { recursive: true });
    mkdirSync(path.join(tree, "api"), { recursive: true });
    writeFileSync(path.join(tree, "notes.md"), "# notes\n");

    const reader = backend.transcripts();
    expect([...(await reader.list(tree))].sort()).toEqual(["api", "notes.md", "shop"]);
    expect([...(await reader.list(path.join(tree, "shop")))]).toEqual(["Receipts"]);
    await expect(reader.list(path.join(tree, "gone"))).rejects.toThrow(/gone/);

    const listed = await backend.uploads().withFiles((sftp) => sftp.list("projects"));
    expect(listed.map((entry) => `${entry.name}:${entry.kind}`).sort()).toEqual(["api:directory", "notes.md:file", "shop:directory"]);
    // The same calls as over ssh2 (uploads/sftp.ts), on the local SFTP.
    expect(await backend.uploads().withFiles((sftp) => sftp.realpath("."))).toBe(fake.home);
    expect(ssh2UploadSftp).toBeTypeOf("function");
  });

  it("Changes runs git in a temporary repository through the login shell", async () => {
    const fake = makeFakeMac();
    const env = Object.fromEntries(Object.entries(gitEnvironment()).filter(([name]) => name.startsWith("GIT_"))) as Record<string, string>;
    const backend = backendOn(fake, env);
    const repository = path.join(makeRoot("this-mac"), "shop");
    makeRepository(repository);

    const reader = new AgentChangesGitReader(backend.changesRunner(), new CommandGate(3), defaultChangesLimits);
    const read = await reader.status(repository);
    expect(read.kind).toBe("repository");
    if (read.kind !== "repository") return;
    expect(read.status.top).toBe(repository);
    expect(read.status.files.map((file) => file.path).sort()).toEqual(["new.txt", "staged.swift", "un\ntracked $x.txt", "work file.swift"]);
  });
});

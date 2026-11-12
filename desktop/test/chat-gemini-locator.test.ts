// Which Gemini CLI, Qwen Code or Antigravity session is a pane's, from fake Herdr snapshots
// (Herdr ee5bfb5: kinds `gemini`, `qwen`, `agy`, src/detect/mod.rs:124-150, :207; `herdr:qwen`, the qwen
// hook herdr-agent-session.sh:25-33; `herdr:antigravity_cli`, the antigravity hook herdr-agent-state.sh:43-55;
// no Gemini source, src/agent_resume.rs:160-174). The locate commands also run for real through /bin/sh and
// zsh against a fake HOME in a temporary folder (no SSH, no real agent folder).

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { geminiFamilyAmbiguousReason, qwenProjectName } from "../src/shared/chat/agents/gemini-family";
import { chatReadsKind } from "../src/shared/chat/kinds";
import {
  grokLookupExcludes,
  locateCommand,
  makeSessionRef,
  paneSession,
  parseLocateOutput,
  sessionForPane,
  sessionRefFromAgentSession,
  type TranscriptSessionRef,
} from "../src/shared/chat/locator";

const qwenID = "3d9a7c1b-2e4f-4a6b-8c0d-1e2f3a4b5c6d";
const peerID = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const agyID = "7e1f0a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const folder = "/Users/fixture/my proj";

function makeHome(): string {
  return mkdtempSync(path.join(tmpdir(), "hc-desktop-gemini-locate-"));
}

function write(file: string, modifiedSeconds: number, content = "{}\n"): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  utimesSync(file, modifiedSeconds, modifiedSeconds);
}

/** `<shell> -c <command>`, HOME set to `home`, as the transport hands the command over. */
function run(command: string, shell: string, home: string): string {
  return execFileSync(shell, ["-c", command], { env: { ...process.env, HOME: home }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** The command run through both shells: what each printed, parsed as the locator parses it. */
function located(ref: TranscriptSessionRef, home: string): (string | null)[] {
  const command = locateCommand(ref);
  expect(command, "a command to run").not.toBeNull();
  return ["/bin/sh", "/bin/zsh"].map((shell) => parseLocateOutput(run(command!, shell, home), ref));
}

describe("gemini family: what Herdr reports", () => {
  it("reads Chat for the three kinds", () => {
    // Antigravity (agy) is read once its steps are known (chat-antigravity-parser.test.ts).
    for (const kind of ["gemini", "qwen", "Gemini", "agy"]) expect(chatReadsKind(kind), kind).toBe(true);
  });

  it("takes herdr:qwen and herdr:antigravity_cli ids; Gemini has none", () => {
    expect(sessionRefFromAgentSession({ source: "herdr:qwen", agent: "qwen", kind: "id", value: qwenID })).toEqual({ format: "qwen", lookup: { kind: "id", id: qwenID } });
    expect(sessionRefFromAgentSession({ source: "herdr:antigravity_cli", agent: "agy", kind: "id", value: agyID })).toEqual({ format: "antigravity", lookup: { kind: "id", id: agyID } });
    expect(sessionRefFromAgentSession({ source: "herdr:qwen", agent: "qwen", kind: "id", value: "a title" })).toBeNull();
    expect(sessionRefFromAgentSession({ source: "herdr:gemini", agent: "gemini", kind: "id", value: qwenID })).toBeNull();
  });

  it("binds a pane by the reported id, else its folder; an Antigravity pane by the id only", () => {
    expect(sessionForPane({ agent: "qwen", agentSession: { source: "herdr:qwen", agent: "qwen", kind: "id", value: qwenID }, cwd: folder })?.ref).toEqual({
      format: "qwen",
      lookup: { kind: "id", id: qwenID },
    });
    expect(sessionForPane({ agent: "qwen", cwd: folder })?.ref).toEqual({ format: "qwen", lookup: { kind: "folder", folder } });
    expect(sessionForPane({ agent: "gemini", cwd: folder + "/" })?.ref).toEqual({ format: "gemini", lookup: { kind: "folder", folder } });
    expect(sessionForPane({ agent: "agy", agentSession: { source: "herdr:antigravity_cli", agent: "agy", kind: "id", value: agyID }, cwd: folder })?.ref).toEqual({
      format: "antigravity",
      lookup: { kind: "id", id: agyID },
    });
    expect(sessionForPane({ agent: "agy", cwd: folder }), "no report: noSession").toBeNull();
    expect(makeSessionRef("antigravity", { kind: "folder", folder })).toBeNull();
  });
});

describe("gemini family: two panes in one folder", () => {
  it("two Gemini panes in a folder are ambiguous, with Gemini's own note; another agent's pane is not a peer", () => {
    expect(paneSession({ agents: [{ paneID: "p1", agent: "gemini", cwd: folder }, { paneID: "p2", agent: "gemini", cwd: folder }], panes: [] }, "p1")).toBe("ambiguous");
    expect(geminiFamilyAmbiguousReason("gemini")).toBe("ambiguousGeminiSession");
    expect(geminiFamilyAmbiguousReason("qwen")).toBe("ambiguousQwenSession");
    expect(geminiFamilyAmbiguousReason("claude")).toBeNull();
    const alone = paneSession({ agents: [{ paneID: "p1", agent: "gemini", cwd: folder }, { paneID: "p2", agent: "qwen", cwd: folder }], panes: [] }, "p1");
    expect(alone !== "ambiguous" && alone !== null ? alone.ref : null).toEqual({ format: "gemini", lookup: { kind: "folder", folder } });
    const elsewhere = paneSession({ agents: [{ paneID: "p1", agent: "gemini", cwd: folder }, { paneID: "p2", agent: "gemini", cwd: "/Users/fixture/other" }], panes: [] }, "p1");
    expect(elsewhere).not.toBe("ambiguous");
  });

  it("a Qwen pane leaves out the session a peer pane reports; two unreported Qwen panes are ambiguous", () => {
    const named = paneSession(
      { agents: [{ paneID: "p1", agent: "qwen", cwd: folder }, { paneID: "p2", agent: "qwen", agentSession: { source: "herdr:qwen", agent: "qwen", kind: "id", value: peerID }, cwd: folder }], panes: [] },
      "p1",
    );
    expect(named !== "ambiguous" && named !== null ? named.ref.lookup : null).toEqual({ kind: "folder", folder, exclude: [peerID] });
    expect(paneSession({ agents: [{ paneID: "p1", agent: "qwen", cwd: folder }, { paneID: "p2", agent: "qwen", cwd: folder }], panes: [] }, "p1")).toBe("ambiguous");
  });
});

describe("gemini family: the locate commands, run against a fake HOME", () => {
  it("Gemini: the newest session filed directly in the chats of the slug whose .project_root is the folder exactly", () => {
    const home = makeHome();
    const chats = path.join(home, ".gemini/tmp/my-proj/chats");
    write(path.join(home, ".gemini/tmp/my-proj/.project_root"), 1_000, folder);
    write(path.join(chats, "session-2026-11-01T03-00-aaaa1111.jsonl"), 1_000);
    write(path.join(chats, "session-2026-11-02T03-00-bbbb2222.jsonl"), 2_000);
    // A subagent's session sits a folder below; another folder's slug and a longer folder's are not this one.
    write(path.join(chats, "bbbb2222/session-2026-11-03T03-00-cccc3333.jsonl"), 3_000);
    write(path.join(home, ".gemini/tmp/sub/.project_root"), 1_000, folder + "/sub");
    write(path.join(home, ".gemini/tmp/sub/chats/session-2026-11-04T03-00-dddd4444.jsonl"), 4_000);
    write(path.join(home, ".gemini/tmp/my-proj2/.project_root"), 1_000, folder + "2");
    write(path.join(home, ".gemini/tmp/my-proj2/chats/session-2026-11-04T03-00-eeee5555.jsonl"), 5_000);
    const ref = makeSessionRef("gemini", { kind: "folder", folder })!;
    expect(located(ref, home)).toEqual([path.join(chats, "session-2026-11-02T03-00-bbbb2222.jsonl"), path.join(chats, "session-2026-11-02T03-00-bbbb2222.jsonl")]);
    expect(located(makeSessionRef("gemini", { kind: "folder", folder: "/Users/fixture/none" })!, home)).toEqual([null, null]);
  });

  it("Gemini: a folder with a quote and a dollar sign is matched as written", () => {
    const home = makeHome();
    const odd = "/Users/fixture/it's $HOME `x`";
    write(path.join(home, ".gemini/tmp/odd/.project_root"), 1_000, odd);
    write(path.join(home, ".gemini/tmp/odd/chats/session-2026-11-01T03-00-aaaa1111.jsonl"), 1_000);
    expect(located(makeSessionRef("gemini", { kind: "folder", folder: odd })!, home)).toEqual(Array(2).fill(path.join(home, ".gemini/tmp/odd/chats/session-2026-11-01T03-00-aaaa1111.jsonl")));
  });

  it("Qwen: by Herdr's id in any project; by folder the newest but the excluded", () => {
    const home = makeHome();
    const chats = path.join(home, ".qwen/projects", qwenProjectName(folder), "chats");
    expect(qwenProjectName(folder)).toBe("-Users-fixture-my-proj");
    write(path.join(chats, `${qwenID}.jsonl`), 1_000);
    write(path.join(chats, `${peerID}.jsonl`), 2_000);
    expect(located(makeSessionRef("qwen", { kind: "id", id: qwenID })!, home)).toEqual(Array(2).fill(path.join(chats, `${qwenID}.jsonl`)));
    expect(located(makeSessionRef("qwen", { kind: "folder", folder })!, home)).toEqual(Array(2).fill(path.join(chats, `${peerID}.jsonl`)));
    const excluding = makeSessionRef("qwen", { kind: "folder", folder, exclude: [peerID] })!;
    expect(located(excluding, home)).toEqual(Array(2).fill(path.join(chats, `${qwenID}.jsonl`)));
    expect(grokLookupExcludes(excluding, path.join(chats, `${peerID}.jsonl`))).toBe(true);
    expect(grokLookupExcludes(excluding, path.join(chats, `${qwenID}.jsonl`))).toBe(false);
  });

  it("Antigravity: the conversation's own transcript", () => {
    const home = makeHome();
    const file = path.join(home, ".gemini/antigravity-cli/brain", agyID, ".system_generated/logs/transcript.jsonl");
    write(file, 1_000);
    expect(located(makeSessionRef("antigravity", { kind: "id", id: agyID })!, home)).toEqual([file, file]);
    expect(located(makeSessionRef("antigravity", { kind: "id", id: qwenID })!, home)).toEqual([null, null]);
  });

  it("accepts only each format's own paths", () => {
    const gemini = makeSessionRef("gemini", { kind: "folder", folder })!;
    expect(parseLocateOutput("/h/.gemini/tmp/p/chats/session-1.jsonl\n", gemini)).toBe("/h/.gemini/tmp/p/chats/session-1.jsonl");
    expect(parseLocateOutput("/h/.gemini/tmp/p/chats/x/session-1.jsonl\n", gemini)).toBeNull();
    expect(parseLocateOutput("/h/.gemini/tmp/p/chats/other.jsonl\n", gemini)).toBeNull();
    expect(parseLocateOutput("h/.gemini/tmp/p/chats/session-1.jsonl\n", gemini)).toBeNull();
    expect(parseLocateOutput("/h/.gemini/tmp/p/chats/session-\u0007.jsonl\n", gemini)).toBeNull();
    const byID = makeSessionRef("qwen", { kind: "id", id: qwenID })!;
    expect(parseLocateOutput(`/h/.qwen/projects/x/chats/${qwenID}.jsonl\n`, byID)).toBe(`/h/.qwen/projects/x/chats/${qwenID}.jsonl`);
    expect(parseLocateOutput(`/h/.qwen/projects/x/chats/${peerID}.jsonl\n`, byID)).toBeNull();
    const byFolder = makeSessionRef("qwen", { kind: "folder", folder, exclude: [peerID] })!;
    expect(parseLocateOutput(`/h/.qwen/projects/-Users-other/chats/${qwenID}.jsonl\n`, byFolder)).toBeNull();
    expect(parseLocateOutput(`/h/.qwen/projects/-Users-fixture-my-proj/chats/${peerID}.jsonl\n`, byFolder)).toBeNull();
    const agy = makeSessionRef("antigravity", { kind: "id", id: agyID })!;
    expect(parseLocateOutput(`/h/.gemini/antigravity-cli/brain/${qwenID}/.system_generated/logs/transcript.jsonl\n`, agy)).toBeNull();
    expect(locateCommand(makeSessionRef("gemini", { kind: "folder", folder, exclude: [peerID] })!), "Gemini has no ids to leave out").toBeNull();
  });
});

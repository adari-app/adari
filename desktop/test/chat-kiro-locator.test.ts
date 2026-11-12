// Which Kiro CLI V3 session is a pane's. Herdr labels the agent `kiro` (herdrdev/herdr ee5bfb5
// src/detect/mod.rs:139) and reports no Kiro session (src/agent_resume.rs names none), so a pane follows its folder:
// the newest V3 session (`~/.kiro/sessions/<workspace-hash>/sess_*/`, kiro-cli-history mxmehl/kiro-cli-history f96f9f05
// kiro_cli_history/main.py:5-6, :364-375; codeburn getagentseal/codeburn bb952552 src/providers/kiro.ts:1100-1145)
// whose session.json records the folder (`workspacePaths[0]`, main.py:345-353). Fake Herdr snapshots only; the locate
// command runs for real through /bin/sh and zsh against a fake HOME in the test scratch folder (no SSH, no ~/.kiro).

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { paneSessions } from "../src/main/away/service";
import { herdrSession } from "../src/main/changes/service";
import type { SessionTopology } from "../src/main/herdr/wire";
import {
  isKiroMessagesPath,
  KiroSessionFormatError,
  kiroAmbiguousNote,
  kiroAmbiguousReason,
  kiroSessionFolder,
  kiroSessionJSONPath,
  maxKiroSessionBytes,
} from "../src/shared/chat/agents/kiro-locate";
import { chatReads } from "../src/shared/chat/kinds";
import { agentFormat, locateCommand, makeSessionRef, paneSession, parseLocateOutput, sessionForPane, type TranscriptSessionRef } from "../src/shared/chat/locator";
import { SearchCommand, SearchQuery } from "../src/shared/search/search";

const scratch = realpathSync(process.env["HERDR_TEST_SCRATCH"] || os.tmpdir());
const folder = "/Users/fixture/proj";
const hash = "4748323122002acb";
const makeHome = (): string => mkdtempSync(path.join(scratch, "hc-kiro-locate-"));
const ref = (value = folder): TranscriptSessionRef => makeSessionRef("kiro", { kind: "folder", folder: value })!;
const encoder = new TextEncoder();

/** codeburn's session.json (kiro.test.ts:1118-1137), `workspacePaths` as given; `json` writes the text as is. */
const sessionJSON = (workspacePaths: readonly string[], extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ schemaVersion: "1.0.0", dataModelVersion: 1, id: "sess_x", title: "Fixture", agentMode: "vibe", workspacePaths, modelId: "claude-opus-4.8", status: "in_progress", ...extra });

/** A V3 session under `home`: its session.json (text) and, unless `messages` is false, its messages.jsonl at `modified`. */
function session(home: string, hashFolder: string, id: string, json: string, modified: number, messages = true): string {
  const dir = path.join(home, ".kiro", "sessions", hashFolder, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "session.json"), json);
  const file = path.join(dir, "messages.jsonl");
  if (messages) {
    writeFileSync(file, JSON.stringify({ id: "s", timestamp: "2026-11-08T10:00:00.000Z", payload: { type: "session_start", agentType: "vibe" } }) + "\n");
    utimesSync(file, modified, modified);
  }
  return file;
}

/** The command through /bin/sh and zsh, HOME set to `home`, each output parsed as the locator parses it. */
function located(asked: TranscriptSessionRef, home: string): (string | null)[] {
  const command = locateCommand(asked);
  expect(command, "a command to run").not.toBeNull();
  return ["/bin/sh", "/bin/zsh"].map((shell) =>
    parseLocateOutput(execFileSync(shell, ["-c", command!], { cwd: home, env: { ...process.env, HOME: home }, encoding: "utf8", timeout: 10_000 }), asked),
  );
}

describe("kiro: what Herdr reports", () => {
  it("maps Herdr's label `kiro` (any case) to the reader, which Chat does not follow for 0.1.0; `kiro-cli`, never Herdr's label, is neither", () => {
    for (const kind of ["kiro", "Kiro"]) {
      expect(chatReads(kind), kind).toBe(false); // Off Chat, as Maki
      expect(agentFormat(kind), kind).toBe("kiro");
    }
    expect(chatReads("kiro-cli")).toBe(false);
    expect(agentFormat("kiro-cli")).toBeNull();
  });

  it("binds a pane by its folder only; a session Herdr reports for it is refused, never the folder's", () => {
    expect(sessionForPane({ agent: "kiro", cwd: folder + "/" })).toEqual({ ref: { format: "kiro", lookup: { kind: "folder", folder } }, source: "folder", paneFolders: [folder + "/"] });
    expect(sessionForPane({ agent: "kiro", agentSession: { source: "herdr:kiro", agent: "kiro", kind: "id", value: "5b1d7c2e-8f3a-4e6b-9c0d-1a2b3c4d5e6f" }, cwd: folder })).toBeNull();
    expect(sessionForPane({ agent: "kiro", cwd: "relative/folder" })).toBeNull();
    expect(makeSessionRef("kiro", { kind: "id", id: "5b1d7c2e-8f3a-4e6b-9c0d-1a2b3c4d5e6f" })).toBeNull();
    expect(makeSessionRef("kiro", { kind: "path", path: `/Users/fixture/.kiro/sessions/${hash}/sess_x/messages.jsonl` })).toBeNull();
    expect(makeSessionRef("kiro", { kind: "folder", folder, exclude: ["sess_x"] })).toBeNull();
  });

  it("one Kiro pane in a folder takes it; two Kiro panes there are refused (Kiro's note); another agent's pane is no peer", () => {
    const pane = (paneID: string, agent: string, cwd = folder) => ({ paneID, agent, cwd });
    const one = paneSession({ agents: [pane("a", "kiro")], panes: [pane("a", "kiro")] }, "a");
    expect(one === null || one === "ambiguous" ? one : one.ref).toEqual(ref());
    expect(paneSession({ agents: [pane("a", "kiro"), pane("b", "kiro")], panes: [pane("a", "kiro"), pane("b", "kiro")] }, "a")).toBe("ambiguous");
    const mixed = paneSession({ agents: [pane("a", "kiro"), pane("b", "grok")], panes: [pane("a", "kiro"), pane("b", "grok")] }, "a");
    expect(mixed === null || mixed === "ambiguous" ? mixed : mixed.ref).toEqual(ref());
    const apart = paneSession({ agents: [pane("a", "kiro"), pane("b", "kiro", "/Users/fixture/other")], panes: [pane("a", "kiro"), pane("b", "kiro", "/Users/fixture/other")] }, "a");
    expect(apart === null || apart === "ambiguous" ? apart : apart.ref).toEqual(ref());
    expect(kiroAmbiguousReason("kiro")).toBe("ambiguousKiroSession");
    expect(kiroAmbiguousReason("grok")).toBeNull();
    expect(kiroAmbiguousNote).toBe("Two Kiro sessions are open in this folder, so Chat can't tell which is this pane's");
  });
});

describe("kiro: the locate command, run for real", () => {
  it("prints the newest V3 session whose session.json records the folder; another folder's newer one is never it", () => {
    const home = makeHome();
    session(home, hash, "sess_old", sessionJSON([folder]), 100);
    const newest = session(home, hash, "sess_new", sessionJSON([folder]), 200);
    session(home, "9f00aa11bb22cc33", "sess_other", sessionJSON(["/Users/fixture/other"]), 300);
    session(home, "1a2b3c4d5e6f7a8b", "sess_prefix", sessionJSON([folder + "-two"]), 400);
    expect(located(ref(), home)).toEqual([newest, newest]);
  });

  it("the folder's hash name alone is nothing: sessions there whose session.json records another workspace give none", () => {
    const home = makeHome();
    session(home, hash, "sess_a", sessionJSON(["/Users/fixture/other"]), 100);
    session(home, hash, "sess_b", JSON.stringify({ id: "sess_b", title: "no workspace" }), 200);
    session(home, hash, "sess_c", sessionJSON([folder]), 300, false); // no messages.jsonl
    expect(located(ref(), home)).toEqual([null, null]);
  });

  it("a pane whose only sessions are 2.x (classic `cli/`, the TUI's SQLite) finds none", () => {
    const home = makeHome();
    const cli = path.join(home, ".kiro", "sessions", "cli");
    mkdirSync(cli, { recursive: true });
    // kiro-cli-history's classic store (main.py:7, :266-300): `<id>.json` + `<id>.jsonl`.
    writeFileSync(path.join(cli, "448ec1fb-bcb2-4419-8292-a2e3ffb35038.json"), JSON.stringify({ cwd: folder, workspacePaths: [folder] }));
    writeFileSync(path.join(cli, "448ec1fb-bcb2-4419-8292-a2e3ffb35038.jsonl"), JSON.stringify({ kind: "Prompt", data: { content: [{ kind: "text", data: "hi" }] } }) + "\n");
    session(home, "cli", "sess_inside_cli", sessionJSON([folder]), 100); // never a V3 session, even shaped as one
    mkdirSync(path.join(home, "Library", "Application Support", "kiro-cli"), { recursive: true });
    writeFileSync(path.join(home, "Library", "Application Support", "kiro-cli", "data.sqlite3"), "SQLite format 3\0");
    expect(located(ref(), home)).toEqual([null, null]);
  });

  it("finds a folder with spaces, quotes, a backslash, `$(…)` and non-ASCII, written plainly or \\u-escaped, and runs none of it", () => {
    const home = makeHome();
    const odd = "/Users/fixture/it's \"q\" $(touch NEVER) `touch NEVER2` \\back café";
    const plain = session(home, hash, "sess_plain", sessionJSON([odd]), 100);
    expect(located(ref(odd), home)).toEqual([plain, plain]);
    const escaped = session(home, hash, "sess_escaped", sessionJSON([odd]).replace("café", "caf\\u00e9"), 200);
    expect(located(ref(odd), home)).toEqual([escaped, escaped]);
    expect(existsSync(path.join(home, "NEVER")) || existsSync(path.join(home, "NEVER2"))).toBe(false);
  });

  it("finds a session that recorded the folder with a trailing slash", () => {
    const home = makeHome();
    const file = session(home, hash, "sess_slash", sessionJSON([folder + "/"]), 100);
    expect(located(ref(), home)).toEqual([file, file]);
  });

  it("takes only a V3 messages.jsonl's path back", () => {
    const good = `/Users/fixture/.kiro/sessions/${hash}/sess_x/messages.jsonl`;
    expect(parseLocateOutput(good + "\n", ref())).toBe(good);
    for (const bad of [
      "/Users/fixture/.kiro/sessions/cli/sess_x/messages.jsonl",
      `/Users/fixture/.kiro/sessions/${hash}/sess_x/session.json`,
      `/Users/fixture/.kiro/sessions/${hash}/other/messages.jsonl`,
      `/Users/fixture/.kiro/other/${hash}/sess_x/messages.jsonl`,
      `relative/.kiro/sessions/${hash}/sess_x/messages.jsonl`,
      `/Users/fixture/.kiro/sessions/${hash}/sess_\u0007/messages.jsonl`,
    ]) {
      expect(parseLocateOutput(bad, ref()), bad).toBeNull();
      expect(isKiroMessagesPath(bad), bad).toBe(false);
    }
    expect(kiroSessionJSONPath(good)).toBe(`/Users/fixture/.kiro/sessions/${hash}/sess_x/session.json`);
    expect(locateCommand(makeSessionRef("kiro", { kind: "folder", folder: "/" })!)).not.toBeNull();
  });
});

describe("kiro: the folder a session.json records", () => {
  const read = (text: string): string | null => kiroSessionFolder(encoder.encode(text));

  it("is `workspacePaths[0]`, read as JSON, trailing slash ignored; none when it names none", () => {
    expect(read(sessionJSON([folder + "/", "/Users/fixture/second"]))).toBe(folder);
    expect(read(sessionJSON(["/Users/fixture/other", folder]))).toBe("/Users/fixture/other");
    expect(read(JSON.stringify({ id: "sess_x", workspacePaths: [] }))).toBeNull();
    expect(read(JSON.stringify({ id: "sess_x", title: folder }))).toBeNull();
    expect(read(JSON.stringify({ workspacePaths: ["relative"] }))).toBeNull();
    expect(read("not json")).toBeNull();
    expect(read(sessionJSON([folder], { pad: "x".repeat(maxKiroSessionBytes) }))).toBeNull();
    // kiro-cli-history's demo session.json has no versions (sess_cfbd0cbbe482/session.json).
    expect(read(JSON.stringify({ id: "sess_cfbd0cbbe482", title: "Deploy", workspacePaths: [folder], createdAt: "2026-10-05T07:47:12.000Z" }))).toBe(folder);
  });

  it("refuses a data model it does not know (a newer dataModelVersion or schemaVersion)", () => {
    expect(read(sessionJSON([folder], { schemaVersion: "1.4.2" }))).toBe(folder);
    expect(() => read(sessionJSON([folder], { dataModelVersion: 2 }))).toThrow(KiroSessionFormatError);
    expect(() => read(sessionJSON([folder], { schemaVersion: "2.0.0" }))).toThrow(KiroSessionFormatError);
    expect(() => read(sessionJSON([folder], { schemaVersion: 1 }))).toThrow(KiroSessionFormatError);
  });
});

describe("kiro: the screens that do not read Kiro yet", () => {
  const topology = { agents: [{ paneID: "p1", agent: "kiro", cwd: folder }], panes: [{ paneID: "p1", agent: "kiro", cwd: folder }] } as unknown as SessionTopology;

  it("Away, Changes and Search find no Kiro session (Search never greps its folder as Claude's)", () => {
    expect(paneSessions(topology)).toEqual({ p1: null });
    expect(herdrSession(topology, "p1")).toBeNull();
    expect(SearchCommand.make(SearchQuery.make("paywall")!, [{ paneID: "p1", session: ref() }])).toBeNull();
  });
});

// The transcript locator (HerdrKit TranscriptLocatorTests.swift, the folder
// rule from ChatFeedTests.swift, CoreAgentKind.session's argv rule) and the
// desktop's pane-to-session resolution. The locate commands also run for real
// on this machine through /bin/sh and zsh, against a fake HOME (no SSH).

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  chatSessionKey,
  claudeProjectSlug,
  foldersMatch,
  isUsableFolder,
  isUsablePath,
  isValidSessionID,
  locateCommand,
  makeSessionRef,
  normalisedFolder,
  parseLocateOutput,
  sessionForPane,
  sessionFromArgv,
  sessionRefFromAgentSession,
  shellQuote,
  transcriptFolderMatches,
  type AgentSessionLike,
  type TranscriptSessionRef,
} from "../src/shared/chat/locator";

const claudeID = "5b1d7c2e-8f3a-4e6b-9c0d-1a2b3c4d5e6f";
const codexID = "019a3c2e-7d41-7b20-9f3e-2c1d0e9f8a7b";

const session = (source: string, kind: string, value: string): AgentSessionLike => ({
  source,
  agent: source.replace("herdr:", ""),
  kind,
  value,
});

const ref = (value: TranscriptSessionRef | null): TranscriptSessionRef => {
  expect(value).not.toBeNull();
  return value!;
};

const command = (value: TranscriptSessionRef): string => {
  const text = locateCommand(value);
  expect(text).not.toBeNull();
  return text!;
};

const shells = ["/bin/sh", "/bin/zsh"].filter((shell) => existsSync(shell));

function makeHome(): string {
  return mkdtempSync(path.join(tmpdir(), "hc-desktop-transcript-locate-"));
}

function write(file: string, modifiedSeconds: number): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, "{}\n");
  utimesSync(file, modifiedSeconds, modifiedSeconds);
}

/** Runs `text` as the login shell would hand it over: `<shell> -c <text>`, HOME set to `home`. */
function run(text: string, shell: string, home: string): { status: number; stdout: string } {
  try {
    const stdout = execFileSync(shell, ["-c", text], { env: { ...process.env, HOME: home }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { status: 0, stdout };
  } catch (error) {
    const failed = error as { status?: number; stdout?: string };
    return { status: failed.status ?? -1, stdout: failed.stdout ?? "" };
  }
}

describe("which sessions are looked up", () => {
  it("accepts herdr:claude and herdr:codex ids and paths", () => {
    expect(sessionRefFromAgentSession(session("herdr:claude", "id", claudeID))).toEqual(makeSessionRef("claude", { kind: "id", id: claudeID }));
    expect(sessionRefFromAgentSession(session("herdr:codex", "id", codexID))?.format).toBe("codex");
    expect(sessionRefFromAgentSession(session("herdr:codex", "path", "/Users/f/.codex/sessions/2026/11/01/rollout-x.jsonl"))?.lookup).toEqual({
      kind: "path",
      path: "/Users/f/.codex/sessions/2026/11/01/rollout-x.jsonl",
    });
  });

  it("refuses anything unsafe or unknown", () => {
    const refused = [
      // Cursor is read; gemini is the agent no reader takes.
      session("herdr:gemini", "id", claudeID),
      session("claude", "id", claudeID),
      session("herdr:claude", "uuid", claudeID),
      session("herdr:claude", "id", "short"),
      session("herdr:claude", "id", "a".repeat(65)),
      session("herdr:claude", "id", "../../etc/passwd"),
      session("herdr:claude", "id", "abcd1234; reboot"),
      session("herdr:claude", "id", "abcd1234'$(id)'"),
      session("herdr:claude", "id", "abcd 1234 efgh"),
      session("herdr:claude", "id", "abcdé1234"),
      session("herdr:claude", "id", "abcd_1234"),
      session("herdr:claude", "path", "relative/session.jsonl"),
      session("herdr:claude", "path", "/Users/f/session.json"),
      session("herdr:claude", "path", "/Users/f/x\n/session.jsonl"),
    ];
    for (const info of refused) expect(sessionRefFromAgentSession(info), JSON.stringify(info)).toBeNull();
    expect(isValidSessionID("abcdefgh")).toBe(true);
    expect(isValidSessionID("A-9".repeat(21) + "x")).toBe(true);
  });

  it("checks paths and folders by bytes and control characters", () => {
    expect(isUsablePath("/a/" + "é".repeat(2_040) + ".jsonl")).toBe(true);
    expect(isUsablePath("/a/" + "é".repeat(2_046) + ".jsonl")).toBe(false);
    expect(isUsablePath("/a/b\u007f.jsonl")).toBe(false);
    expect(isUsableFolder("/Users/f/my proj")).toBe(true);
    expect(isUsableFolder("Users/f/proj")).toBe(false);
    expect(isUsableFolder("/Users/f/\tproj")).toBe(false);
    expect(isUsableFolder("/" + "a".repeat(4_096))).toBe(false);
  });
});

describe("the command", () => {
  it("searches both Claude config folders with every part quoted", () => {
    const value = ref(makeSessionRef("claude", { kind: "id", id: claudeID }));
    const script =
      `set --; for f in "$HOME"/'.claude'/'projects'/*/'5b1d7c2e-8f3a-4e6b-9c0d-1a2b3c4d5e6f.jsonl' ` +
      `"$HOME"/'.claude-seats'/*/'projects'/*/'5b1d7c2e-8f3a-4e6b-9c0d-1a2b3c4d5e6f.jsonl'; ` +
      `do [ -f "$f" ] && set -- "$@" "$f"; done; [ "$#" -gt 0 ] && /bin/ls -t -- "$@" | /usr/bin/head -n 1; exit 0`;
    expect(command(value)).toBe("/bin/sh -c " + shellQuote(script));
  });

  it("searches the dated Codex session folders", () => {
    const value = ref(makeSessionRef("codex", { kind: "id", id: codexID }));
    const script =
      `set --; for f in "$HOME"/'.codex'/'sessions'/*/*/*/'rollout-'*'-019a3c2e-7d41-7b20-9f3e-2c1d0e9f8a7b.jsonl'; ` +
      `do [ -f "$f" ] && set -- "$@" "$f"; done; [ "$#" -gt 0 ] && /bin/ls -t -- "$@" | /usr/bin/head -n 1; exit 0`;
    expect(command(value)).toBe("/bin/sh -c " + shellQuote(script));
  });

  it("is read only and has no path lookup", () => {
    const refs = [
      ref(makeSessionRef("claude", { kind: "id", id: claudeID })),
      ref(makeSessionRef("codex", { kind: "id", id: codexID })),
      ref(makeSessionRef("claude", { kind: "folder", folder: "/Users/f/my proj" })),
    ];
    for (const value of refs) {
      const text = command(value);
      expect(text.includes(">"), "no redirection, so nothing is written").toBe(false);
      for (const word of [" rm ", " mv ", "touch", " tee ", " cp ", "mkdir", "chmod", " ln "]) expect(text.includes(word), word).toBe(false);
    }
    expect(locateCommand(ref(makeSessionRef("claude", { kind: "path", path: "/a/b.jsonl" })))).toBeNull();
    expect(makeSessionRef("claude", { kind: "id", id: "bad id!" })).toBeNull();
    // A ref made by hand around a bad id or folder still gets no command.
    expect(locateCommand({ format: "claude", lookup: { kind: "id", id: "x'; reboot; '" } })).toBeNull();
    expect(locateCommand({ format: "claude", lookup: { kind: "folder", folder: "relative" } })).toBeNull();
    expect(locateCommand({ format: "codex", lookup: { kind: "folder", folder: "/Users/f/proj" } })).toBeNull();
  });

  it.skipIf(shells.length === 0)("finds the newest match and prints nothing when there is none", () => {
    const home = makeHome();
    const id = claudeID;
    const older = path.join(home, `.claude/projects/-Users-f-proj/${id}.jsonl`);
    const newer = path.join(home, `.claude-seats/seat-a/projects/-Users-f-other proj/${id}.jsonl`);
    const decoy = path.join(home, `.claude/projects/-Users-f-proj/${id}.jsonl.bak`);
    const folderNamedLikeIt = path.join(home, `.claude-seats/seat-b/projects/x/${id}.jsonl`);
    write(older, 1_700_000_000);
    write(newer, 1_800_000_000);
    write(decoy, 1_900_000_000);
    mkdirSync(folderNamedLikeIt, { recursive: true });
    const value = ref(makeSessionRef("claude", { kind: "id", id }));
    const text = command(value);
    for (const shell of shells) {
      const output = run(text, shell, home);
      expect(output.status, shell).toBe(0);
      expect(parseLocateOutput(output.stdout, value), shell).toBe(newer);
    }
    write(older, 1_850_000_000);
    expect(parseLocateOutput(run(text, "/bin/sh", home).stdout, value)).toBe(older);

    const codex = ref(makeSessionRef("codex", { kind: "id", id: codexID }));
    const codexCommand = command(codex);
    for (const shell of shells) {
      const none = run(codexCommand, shell, home);
      expect(none.status, `no match is not an error (${shell})`).toBe(0);
      expect(none.stdout).toBe("");
    }
    const rollout = path.join(home, `.codex/sessions/2026/11/01/rollout-2026-11-01T03-00-00-${codexID}.jsonl`);
    write(rollout, Date.now() / 1000);
    const shell = shells.includes("/bin/zsh") ? "/bin/zsh" : "/bin/sh";
    expect(parseLocateOutput(run(codexCommand, shell, home).stdout, codex)).toBe(rollout);
  });

  it("takes only the file asked for from the output", () => {
    const claude = ref(makeSessionRef("claude", { kind: "id", id: claudeID }));
    const codex = ref(makeSessionRef("codex", { kind: "id", id: codexID }));
    expect(parseLocateOutput(`/Users/f/.claude/projects/p/${claudeID}.jsonl\n`, claude)).toBe(`/Users/f/.claude/projects/p/${claudeID}.jsonl`);
    expect(parseLocateOutput("", claude)).toBeNull();
    expect(parseLocateOutput("ls: cannot access\n", claude)).toBeNull();
    expect(parseLocateOutput("/Users/f/.claude/projects/p/other.jsonl", claude)).toBeNull();
    expect(parseLocateOutput(`relative/${claudeID}.jsonl`, claude)).toBeNull();
    expect(parseLocateOutput(`/h/.codex/sessions/2026/11/01/rollout-2026-11-01T03-00-00-${codexID}.jsonl`, codex)).toBe(
      `/h/.codex/sessions/2026/11/01/rollout-2026-11-01T03-00-00-${codexID}.jsonl`,
    );
    expect(parseLocateOutput(`/h/.codex/sessions/2026/11/01/${codexID}.jsonl`, codex)).toBeNull();
    expect(parseLocateOutput(`/a/${claudeID}.jsonl`, ref(makeSessionRef("claude", { kind: "path", path: `/a/${claudeID}.jsonl` })))).toBeNull();
  });
});

describe("the newest transcript for a Claude folder (desktop addition)", () => {
  const folder = `/Users/f/my "odd" proj's`;

  it("names the project directory as Claude Code does", () => {
    expect(claudeProjectSlug("/Users/fixture/proj")).toBe("-Users-fixture-proj");
    expect(claudeProjectSlug("/Volumes/Data/code/worktrees/aurora-web-chat")).toBe(
      "-Volumes-Data-code-worktrees-aurora-web-chat",
    );
    expect(claudeProjectSlug(folder)).toBe("-Users-f-my--odd--proj-s");
    expect(claudeProjectSlug("/a/b_c.d é")).toBe("-a-b-c-d--");
  });

  it("lists the slug's transcripts in both configs, the folder itself never in the command", () => {
    const value = ref(makeSessionRef("claude", { kind: "folder", folder }));
    const script =
      `set --; for f in "$HOME"/'.claude'/'projects'/'-Users-f-my--odd--proj-s'/*'.jsonl' ` +
      `"$HOME"/'.claude-seats'/*/'projects'/'-Users-f-my--odd--proj-s'/*'.jsonl'; ` +
      `do [ -f "$f" ] && set -- "$@" "$f"; done; [ "$#" -gt 0 ] && /bin/ls -t -- "$@" | /usr/bin/head -n 1; exit 0`;
    const text = command(value);
    expect(text).toBe("/bin/sh -c " + shellQuote(script));
    expect(text.includes("odd")).toBe(true);
    expect(text.includes("my ")).toBe(false);
    expect(text.includes('"odd"')).toBe(false);
  });

  it("refuses folders that are not absolute, hold control characters or are too long, and Codex folders", () => {
    expect(makeSessionRef("claude", { kind: "folder", folder: "proj" })).toBeNull();
    expect(makeSessionRef("claude", { kind: "folder", folder: "/a/b\nc" })).toBeNull();
    expect(makeSessionRef("claude", { kind: "folder", folder: "/" + "x".repeat(4_096) })).toBeNull();
    expect(makeSessionRef("codex", { kind: "folder", folder: "/Users/f/proj" })).toBeNull();
  });

  it("takes only a session file in the folder's project directory from the output", () => {
    const value = ref(makeSessionRef("claude", { kind: "folder", folder: "/Users/f/proj" }));
    expect(parseLocateOutput(`/h/.claude/projects/-Users-f-proj/${claudeID}.jsonl\n`, value)).toBe(`/h/.claude/projects/-Users-f-proj/${claudeID}.jsonl`);
    expect(parseLocateOutput(`/h/.claude-seats/dev/projects/-Users-f-proj/${claudeID}.jsonl`, value)).toBe(
      `/h/.claude-seats/dev/projects/-Users-f-proj/${claudeID}.jsonl`,
    );
    expect(parseLocateOutput(`/h/.claude/projects/-Users-f-other/${claudeID}.jsonl`, value)).toBeNull();
    expect(parseLocateOutput(`/h/.claude/elsewhere/-Users-f-proj/${claudeID}.jsonl`, value)).toBeNull();
    expect(parseLocateOutput("/h/.claude/projects/-Users-f-proj/not a session.jsonl", value)).toBeNull();
    expect(parseLocateOutput("", value)).toBeNull();
  });

  it.skipIf(shells.length === 0)("finds the newest transcript of the folder, in either config, through sh and zsh", () => {
    const home = makeHome();
    const slug = claudeProjectSlug(folder);
    const older = path.join(home, `.claude/projects/${slug}/${claudeID}.jsonl`);
    const newer = path.join(home, `.claude-seats/dev/projects/${slug}/${codexID}.jsonl`);
    const otherFolder = path.join(home, `.claude/projects/-Users-f-other/0a0a0a0a-0000-4000-8000-000000000000.jsonl`);
    const decoy = path.join(home, `.claude/projects/${slug}/${claudeID}.jsonl.bak`);
    const value = ref(makeSessionRef("claude", { kind: "folder", folder }));
    const text = command(value);
    for (const shell of shells) {
      const none = run(text, shell, home);
      expect(none.status, shell).toBe(0);
      expect(none.stdout, shell).toBe("");
    }
    write(older, 1_700_000_000);
    write(newer, 1_800_000_000);
    write(otherFolder, 1_900_000_000);
    write(decoy, 1_950_000_000);
    for (const shell of shells) {
      const output = run(text, shell, home);
      expect(output.status, shell).toBe(0);
      expect(parseLocateOutput(output.stdout, value), shell).toBe(newer);
    }
    write(older, 1_850_000_000);
    expect(parseLocateOutput(run(text, "/bin/sh", home).stdout, value)).toBe(older);
  });
});

describe("the folder rule", () => {
  it("matches equal folders and folders inside each other, a trailing slash ignored", () => {
    expect(foldersMatch("/a/b", "/a/b")).toBe(true);
    expect(foldersMatch("/a/b/", "/a/b")).toBe(true);
    expect(foldersMatch("/a/b", "/a/b/c")).toBe(true);
    expect(foldersMatch("/a/b/c", "/a/b")).toBe(true);
    expect(foldersMatch("/", "/a"), "everything is inside the root").toBe(true);
    expect(foldersMatch("/a/b", "/a/bc")).toBe(false);
    expect(foldersMatch("/a/bc", "/a/b")).toBe(false);
    expect(foldersMatch("/a/b", "/x/b")).toBe(false);
    expect(foldersMatch("", "/a")).toBe(false);
    expect(normalisedFolder("/a/b///")).toBe("/a/b");
    expect(normalisedFolder("/")).toBe("/");
    expect(transcriptFolderMatches("/a", [])).toBe(false);
    expect(transcriptFolderMatches("/a", ["/x", "/a/"])).toBe(true);
  });
});

describe("the session an argv names (CoreAgentKind.session)", () => {
  it("reads claude --resume, -r, --session-id and their = forms; the last one wins", () => {
    expect(sessionFromArgv(["claude", "--resume", claudeID], "claude")).toEqual({ source: "herdr:claude", agent: "claude", kind: "id", value: claudeID });
    expect(sessionFromArgv(["/usr/local/bin/claude", "-r", claudeID], "claude")?.value).toBe(claudeID);
    expect(sessionFromArgv(["claude", "--session-id", claudeID, "--model", "opus"], "claude")?.value).toBe(claudeID);
    expect(sessionFromArgv(["claude", `--resume=${claudeID}`], "claude")?.value).toBe(claudeID);
    expect(sessionFromArgv(["claude", `--session-id=${claudeID}`], "claude")?.value).toBe(claudeID);
    expect(sessionFromArgv(["claude", "-r", "aaaaaaaa", "--resume", claudeID], "claude")?.value).toBe(claudeID);
  });

  it("reads codex resume <id>", () => {
    expect(sessionFromArgv(["codex", "resume", codexID], "codex")).toEqual({ source: "herdr:codex", agent: "codex", kind: "id", value: codexID });
    expect(sessionFromArgv(["codex", "resume", "--last"], "codex")).toBeNull();
    expect(sessionFromArgv(["codex", "resume"], "codex")).toBeNull();
    expect(sessionFromArgv(["codex", "--resume", codexID], "codex")).toBeNull();
  });

  it("names nothing for no id, a bad id, a flag after the option, or another agent", () => {
    expect(sessionFromArgv(["claude"], "claude")).toBeNull();
    expect(sessionFromArgv(["claude", "--resume"], "claude")).toBeNull();
    expect(sessionFromArgv(["claude", "--resume="], "claude")).toBeNull();
    expect(sessionFromArgv(["claude", "--resume", "--dangerously-skip-permissions"], "claude")).toBeNull();
    expect(sessionFromArgv(["claude", "--resume", "abc; reboot"], "claude")).toBeNull();
    expect(sessionFromArgv(["claude", "--resume", "short"], "claude")).toBeNull();
    expect(sessionFromArgv(["gemini", "--resume", claudeID], "gemini")).toBeNull();
  });
});

describe("a pane's session", () => {
  const cwd = "/Users/fixture/proj";

  it("is Herdr's agent_session when it is usable, with the pane's folders", () => {
    const found = sessionForPane(
      { agent: "claude", cwd, agentSession: session("herdr:claude", "id", claudeID) },
      { foregroundCWD: "/Users/fixture/proj/App", argv: ["claude", "--resume", "aaaaaaaa"] },
    );
    expect(found).toEqual({
      ref: { format: "claude", lookup: { kind: "id", id: claudeID } },
      source: "herdr:claude",
      paneFolders: [cwd, "/Users/fixture/proj/App"],
    });
    const codex = sessionForPane({ agent: "codex", cwd, agentSession: session("herdr:codex", "path", "/h/.codex/sessions/2026/11/01/rollout-x.jsonl") });
    expect(codex?.source).toBe("herdr:codex");
    expect(codex?.ref.lookup).toEqual({ kind: "path", path: "/h/.codex/sessions/2026/11/01/rollout-x.jsonl" });
  });

  it("falls back to the argv, then for Claude to the newest transcript of its folder", () => {
    const fromArgv = sessionForPane(
      { agent: "claude", cwd, agentSession: session("herdr:claude", "id", "bad id") },
      { argv: ["claude", "-r", claudeID] },
    );
    expect(fromArgv?.source).toBe("argv");
    expect(fromArgv?.ref).toEqual({ format: "claude", lookup: { kind: "id", id: claudeID } });

    const fromFolder = sessionForPane({ agent: "Claude", cwd: cwd + "/" }, { argv: ["claude"] });
    expect(fromFolder).toEqual({ ref: { format: "claude", lookup: { kind: "folder", folder: cwd } }, source: "folder", paneFolders: [cwd + "/"] });

    const foregroundOnly = sessionForPane({ agent: "claude" }, { foregroundCWD: "/Users/fixture/other" });
    expect(foregroundOnly?.ref.lookup).toEqual({ kind: "folder", folder: "/Users/fixture/other" });
  });

  it("has none for Codex without a session, other agents, shells, or no usable folder", () => {
    expect(sessionForPane({ agent: "codex", cwd })).toBeNull();
    expect(sessionForPane({ agent: "codex", cwd }, { argv: ["codex"] })).toBeNull();
    // Gemini's panes are read (test/chat-gemini-locator.test.ts); an agent with no reader stands here.
    expect(sessionForPane({ agent: "no-reader-agent", cwd })).toBeNull();
    expect(sessionForPane({ cwd })).toBeNull();
    expect(sessionForPane({ agent: "claude" })).toBeNull();
    expect(sessionForPane({ agent: "claude", cwd: "relative/proj" })).toBeNull();
    expect(sessionForPane({ agent: "claude", cwd: "/a/b\u0007c" })).toBeNull();
  });

  it("keys a session by what is looked up and where it came from, not the pane's folders", () => {
    const a = sessionForPane({ agent: "claude", cwd, agentSession: session("herdr:claude", "id", claudeID) })!;
    const b = sessionForPane({ agent: "claude", cwd, agentSession: session("herdr:claude", "id", claudeID) })!;
    const other = sessionForPane({ agent: "claude", cwd: "/Users/fixture/elsewhere", agentSession: session("herdr:claude", "id", claudeID) })!;
    const byFolder = sessionForPane({ agent: "claude", cwd })!;
    expect(chatSessionKey(a)).toBe(chatSessionKey(b));
    expect(chatSessionKey(a)).toBe(chatSessionKey(other));
    expect(chatSessionKey(a)).not.toBe(chatSessionKey(byFolder));
  });
});

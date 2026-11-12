// The one read-only lookup for a herdr-core
// Claude or Codex pane whose argv names no session (shared/chat/core-folder-lookup.ts),
// following the iPhone app's CoreChatSessionTests (the locate commands, refs
// and paths) and its boundary tests. Synthetic homes in the test
// scratch (HERDR_TEST_SCRATCH), their names with a quote, `$()` and backticks;
// the command runs as the Mac's exec runs it (`/bin/sh -s`, its UTF-8 on
// stdin, HOME the synthetic home); the agent's process is this test's own
// (`ps` reads its start) and every transcript written "since the agent
// started" is dated ahead.

import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  coreClaudeProjectSlug,
  coreFolderCommand,
  coreFolderScript,
  coreGenerationCommand,
  coreGenerationScript,
  coreStartPerl,
  makeCoreFolderRef,
  parseCoreFolderOutput,
  parseCoreGenerationOutput,
  transcriptSessionID,
  type CoreEarlierSession,
  type CoreFolderFormat,
  type CoreFolderRef,
} from "../src/shared/chat/core-folder-lookup";
import { sessionRefFromAgentSession, shellQuote } from "../src/shared/chat/locator";
import { a, b, c, goneProcess, home, projectFolder as folder, runAt as run, setModified, transcript as file } from "./support/core-chat-home";
import { hasRepoFile, readRepoFile } from "./support/swift-fixtures";

// The public copy holds the Mac app only: the comparison with the Swift file
// runs when that file is in the tree and is skipped when it is not.
const transcriptLocatorSource = "Sources/HerdrKit/TranscriptLocator.swift";

const me = process.pid;
const g1 = "20261108010000";

function ref(format: CoreFolderFormat, options: { folder?: string; pid?: number; excluding?: readonly string[] } = {}): CoreFolderRef {
  const made = makeCoreFolderRef(format, options.folder ?? folder, options.excluding ?? [], options.pid ?? me);
  if (made === null) throw new Error("no ref");
  return made;
}

function locate(at: string, format: CoreFolderFormat, options: { folder?: string; pid?: number; excluding?: readonly string[]; earlier?: readonly CoreEarlierSession[] } = {}): string | null {
  const lookup = ref(format, options);
  const command = coreFolderCommand(lookup, options.earlier ?? []);
  if (command === null) throw new Error("no command");
  return parseCoreFolderOutput(run(command, at), lookup)?.path ?? null;
}

function generationNow(at: string, format: CoreFolderFormat = "claude"): string {
  const lookup = ref(format);
  const result = parseCoreFolderOutput(run(coreFolderCommand(lookup) as string, at), lookup);
  if (result === null) throw new Error("no generation");
  return result.generation;
}

// MARK: - The scripts are the iPhone app's

describe("the lookup's scripts", () => {
  it.skipIf(!hasRepoFile(transcriptLocatorSource))("are TranscriptLocator.swift's text, byte for byte", () => {
    const swift = readRepoFile(transcriptLocatorSource);
    // `static let <name> = #"""…"""# + coreStartPerl + #"""…"""#`: a Swift raw multi-line literal is the lines
    // between its delimiters, the newline before the closing one not its own.
    const literal = (name: string, start: string): string => {
      const head = `static let ${name} = `;
      const at = swift.indexOf(head);
      if (at < 0) throw new Error(`no ${name}`);
      let rest = swift.slice(at + head.length);
      let text = "";
      for (;;) {
        if (rest.startsWith('#"""\n')) {
          const end = rest.indexOf('\n"""#');
          text += rest.slice(5, end);
          rest = rest.slice(end + 5);
        } else if (rest.startsWith("coreStartPerl")) {
          text += start;
          rest = rest.slice("coreStartPerl".length);
        } else {
          throw new Error(`unread ${name}: ${rest.slice(0, 40)}`);
        }
        if (!rest.startsWith(" + ")) return text;
        rest = rest.slice(3);
      }
    };
    const start = literal("coreStartPerl", "");
    expect(start).toBe(coreStartPerl);
    expect(literal("coreGenerationScript", start)).toBe(coreGenerationScript);
    expect(literal("coreFolderScript", start)).toBe(coreFolderScript);
  });
});

// MARK: - Refs, answers and commands (CoreChatSessionTests.testRefsAndLocatedPathsForClaudeAndCodexFolders)

describe("refs and located paths for Claude and Codex folders", () => {
  it("are only made with the process that bounds them; never from Herdr's agent_session", () => {
    // The generic lookup takes no Claude or Codex folder.
    expect(sessionRefFromAgentSession({ source: "herdr:claude", agent: "claude", kind: "folder", value: folder })).toBeNull();
    expect(sessionRefFromAgentSession({ source: "herdr:codex", agent: "codex", kind: "folder", value: folder })).toBeNull();
    expect(makeCoreFolderRef("claude", folder, [], 0)).toBeNull();
    expect(makeCoreFolderRef("codex", folder, ["not-a-uuid"], 7)).toBeNull();
    expect(makeCoreFolderRef("claude", folder, [b.toUpperCase(), b], 7)?.excluding).toEqual([b]);
    expect(coreClaudeProjectSlug(folder)).toBe("-Users-fixture-proj");
    expect(coreClaudeProjectSlug("/Users/me/my.app/é")).toBe("-Users-me-my-app--");
  });

  it("read the lookup's one line strictly", () => {
    const claude = ref("claude", { excluding: [b], pid: 7 });
    const slug = coreClaudeProjectSlug(folder);
    const start = "20261108210000";
    const parse = (line: string, lookup: CoreFolderRef): string | null => parseCoreFolderOutput(start + "\t" + line + "\n", lookup)?.path ?? null;
    expect(parseCoreFolderOutput(start + "\n", claude)).toEqual({ generation: start, path: null });
    expect(parseCoreFolderOutput("", claude)).toBeNull();
    // Never the generic lookup's answer.
    expect(parseCoreFolderOutput(`/h/.claude/projects/${slug}/${a}.jsonl\n`, claude)).toBeNull();
    for (const good of [`/h/.claude/projects/${slug}/${a}.jsonl`, `/h/.claude-seats/dev/projects/${slug}/${a}.jsonl`, `/h/.claude/projects/${slug}/${a.toUpperCase()}.jsonl`]) {
      expect(parse(good, claude)).toBe(good);
    }
    for (const wrong of [
      `/h/.claude/projects/${slug}/${b}.jsonl`,
      `/h/.claude/projects/${slug}/${b.toUpperCase()}.jsonl`,
      `/h/.claude/projects/-Users-fixture-other/${a}.jsonl`,
      `/h/.claude/projects/${slug}/agent-a1b2.jsonl`,
      `/h/.other/projects/${slug}/${a}.jsonl`,
      `/h/.claude/projects/${slug}/${a}/subagents/${c}.jsonl`,
      `relative/${a}.jsonl`,
    ]) {
      expect(parse(wrong, claude), wrong).toBeNull();
    }
    const codex = ref("codex", { excluding: [b], pid: 7 });
    const rollout = `/h/.codex/sessions/2026/11/08/rollout-2026-11-08T21-00-00-${a}.jsonl`;
    expect(parse(rollout, codex)).toBe(rollout);
    expect(parse(`/h/.codex/sessions/2026/11/08/rollout-2026-11-08T21-00-00-${b}.jsonl`, codex)).toBeNull();
    expect(parse(`/h/.codex/archive/2026/11/08/rollout-2026-11-08T21-00-00-${a}.jsonl`, codex)).toBeNull();
    for (const bad of [start + "\t" + rollout, start + "\t" + rollout + "\r\n", "2026110821000\t" + rollout + "\n", start + "\t" + rollout + "\n\n", "\n"]) {
      expect(parseCoreFolderOutput(bad, codex), bad).toBeNull();
    }
    expect(transcriptSessionID(rollout, "codex")).toBe(a);
    expect(transcriptSessionID(`/h/agent-${a}.jsonl`, "claude")).toBeNull();
  });

  it("make the one core lookup, its every value an argument", () => {
    const claude = ref("claude", { excluding: [b], pid: 7 });
    const command = coreFolderCommand(claude) as string;
    expect(command.startsWith("/usr/bin/perl -e '")).toBe(true);
    expect(command.endsWith(` -- 'claude' '7' '${folder}' '-Users-fixture-proj' '0' 'x:${b}'`)).toBe(true);
    expect(command).toContain("lstart=");
    expect(coreFolderCommand(claude, [{ generation: g1, id: a.toUpperCase() }])?.endsWith(` 'x:${b}' 'g:${g1}:${a}'`)).toBe(true);
  });

  it("unexpected output is rejected as a whole", () => {
    const lookup = ref("claude");
    const found = `/h/.claude/projects/${coreClaudeProjectSlug(folder)}/${a}.jsonl`;
    const line = g1 + "\t" + found;
    expect(parseCoreFolderOutput(line + "\n", lookup)?.path).toBe(found);
    expect(parseCoreFolderOutput(line + "\nUNEXPECTED\n", lookup)).toBeNull();
    expect(parseCoreFolderOutput(line + "\n" + line + "\n", lookup)).toBeNull();
    // Invalid remote UTF-8 never turns into an accepted replacement path.
    expect(parseCoreFolderOutput(g1 + "\t/h�" + found.slice(2) + "\n", lookup)).toBeNull();
  });

  it("refuses unsafe arguments and anything but the whole answer", () => {
    for (const value of ["/a\u0000b", "/a\u0001b", "/a\u007fb", "/a\nb", "-a", "/a\tb", "relative", "/Users/fixture/carriage\rname"]) {
      expect(makeCoreFolderRef("claude", value, [], 7), JSON.stringify(value)).toBeNull();
    }
    const lookup = ref("claude", { pid: 7 });
    for (const id of ["-x", "a'", "a\n", "$(touch SENTINEL)", "`touch SENTINEL`", a + "\n"]) {
      expect(makeCoreFolderRef("claude", folder, [id], 7)).toBeNull();
      expect(coreFolderCommand(lookup, [{ generation: g1, id }])).toBeNull();
    }
    expect(coreFolderCommand(lookup, [{ generation: "2026110801000", id: a }])).toBeNull();
    for (const output of [g1, g1 + "\n\n", g1 + "\r\n", "x".repeat(65536) + "\n", g1 + "\t/h�/.claude/projects/-Users-fixture-proj/" + a + ".jsonl\n"]) {
      expect(parseCoreFolderOutput(output, lookup)).toBeNull();
    }
    expect(coreGenerationCommand(0)).toBeNull();
    expect(coreGenerationCommand(0x80000000)).toBeNull();
    for (const bad of ["", g1, g1 + "\n\n", "1" + g1 + "\n", g1 + "\r\n"]) {
      expect(parseCoreGenerationOutput(bad), JSON.stringify(bad)).toBeNull();
    }
    expect(parseCoreGenerationOutput(g1 + "\n")).toBe(g1);
  });
});

// MARK: - The lookup, run (CoreChatSessionTests and its boundary tests)

describe("the Claude folder lookup, run", () => {
  it("finds the folder's newest written since the agent started", () => {
    const at = home();
    file(at, "claude", a, { age: -100_000_000 });
    const older = file(at, "claude", b, { age: 10 });
    const otherConfig = file(at, "claude", c, { seat: "dev", age: 20 });
    // Filed under the folder's project but another folder's (`/Users/fixture/proj` and `/Users/fixture-proj` share it).
    const d = "44444444-4444-4444-8444-444444444444";
    file(at, "claude", d, { filedUnder: folder, folder: "/Users/fixture-proj", age: 30 });
    // A subagent's file is no session.
    file(at, "claude", "x", { age: 40, filename: "agent-a1b2c3d4.jsonl" });
    expect(coreClaudeProjectSlug("/Users/fixture-proj")).toBe(coreClaudeProjectSlug(folder));
    expect(locate(at, "claude")).toBe(otherConfig);
    expect(locate(at, "claude", { excluding: [c] })).toBe(older);
    expect(locate(at, "claude", { excluding: [c, b] }), "a: written before the agent started").toBeNull();
    expect(locate(at, "claude", { pid: goneProcess() }), "a process that is gone has nothing").toBeNull();
  });

  it("reads quoted folder names as they are", () => {
    for (const format of ["claude", "codex"] as const) {
      for (const name of [folder, "/Users/fixture/a space/quote'and\"double", "/Users/fixture/$variable/`literal`/$(literal)", "/-leading/é/🙂"]) {
        const at = home();
        const own = file(at, format, a, { folder: name });
        expect(locate(at, format, { folder: name }), `${format} ${name}`).toBe(own);
        expect(locate(at, format, { folder: name, excluding: [a] })).toBeNull();
      }
    }
  });

  it("only the transcript's own top-level cwd claims the folder", () => {
    const at = home();
    const own = file(at, "claude", a);
    file(at, "claude", b, { folder: "/Users/fixture-proj", filedUnder: folder, extra: { tool: { cwd: folder } }, age: 20 });
    expect(locate(at, "claude")).toBe(own);
  });

  it("a non-session filename never hides a valid older session", () => {
    const at = home();
    const own = file(at, "claude", a);
    file(at, "claude", b, { age: 20, filename: `agent-${b}.jsonl` });
    expect(locate(at, "claude")).toBe(own);
  });

  it("takes user, assistant and system records; a sidechain or another session's record is none", () => {
    for (const type of ["user", "assistant", "system"]) {
      const at = home();
      const own = file(at, "claude", a, { extra: { type } });
      file(at, "claude", b, { extra: { isSidechain: true }, age: 30 });
      file(at, "claude", c, { extra: { sessionId: b }, age: 20 });
      expect(locate(at, "claude"), type).toBe(own);
    }
  });

  it("proves at most 32 candidates", () => {
    const at = home();
    const own = file(at, "claude", a);
    for (let n = 0; n < 31; n += 1) {
      file(at, "claude", `${n.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`, { extra: { isSidechain: true }, age: 20 + n });
    }
    expect(locate(at, "claude")).toBe(own);
    file(at, "claude", b, { extra: { isSidechain: true }, age: 100 });
    expect(locate(at, "claude"), "only 32 candidate proofs in all").toBeNull();
  });

  it("cuts the whole second the process started in", () => {
    const at = home();
    const start = Number(generationNow(at));
    const own = file(at, "claude", a);
    for (const delta of [0, 0.9, 0.999]) {
      setModified(own, start + delta);
      expect(locate(at, "claude"), String(delta)).toBeNull();
    }
    setModified(own, start + 1);
    expect(locate(at, "claude")).toBe(own);
  });

  it("takes the later possible start across a DST fold", () => {
    const at = home();
    const own = file(at, "claude", a);
    const lookup = ref("claude");
    // A synthetic ps line; everything after reading ps is the lookup's own script.
    const script = coreFolderScript.replace(
      "open(my $ps, '-|', '/bin/ps', '-o', 'lstart=', '-p', $pid) or exit 0;",
      "open(my $ps, '-|', '/usr/bin/printf', '%s', 'Sun Nov  1 01:30:00 2026') or exit 0;",
    );
    expect(script).not.toBe(coreFolderScript);
    const command = `TZ=America/New_York /usr/bin/perl -e ${shellQuote(script)} -- 'claude' '7' ${shellQuote(folder)} ${shellQuote(coreClaudeProjectSlug(folder))} '0'`;
    for (const date of ["2026-11-01T05:30:01Z", "2026-11-01T06:30:00Z"]) {
      setModified(own, Date.parse(date) / 1000);
      expect(parseCoreFolderOutput(run(command, at), lookup)?.path ?? null, date).toBeNull();
    }
    setModified(own, Date.parse("2026-11-01T06:30:01Z") / 1000);
    expect(parseCoreFolderOutput(run(command, at), lookup)?.path).toBe(own);
  });

  it("skips a session found for another process under the pid and keeps the current one's", () => {
    const at = home();
    const own = file(at, "claude", a);
    const lookup = ref("claude");
    const initial = parseCoreFolderOutput(run(coreFolderCommand(lookup) as string, at), lookup);
    expect(initial?.path).toBe(own);
    for (const [generation, expected] of [["19990101000000", null], [initial?.generation as string, own]] as const) {
      const command = coreFolderCommand(lookup, [{ generation, id: a.toUpperCase() }]) as string;
      expect(parseCoreFolderOutput(run(command, at), lookup)?.path ?? null).toBe(expected);
    }
  });

  it("gives one process start whatever the Mac's time zone; the same process keeps its session", () => {
    const at = home();
    const own = file(at, "claude", a);
    const lookup = ref("claude");
    const first = parseCoreFolderOutput(run("TZ=UTC " + (coreFolderCommand(lookup) as string), at), lookup);
    expect(first?.path).toBe(own);
    const generation = first?.generation as string;
    const second = parseCoreFolderOutput(run("TZ=America/New_York " + (coreFolderCommand(lookup, [{ generation, id: a }]) as string), at), lookup);
    expect(second?.generation).toBe(generation);
    expect(second?.path).toBe(own);
  });

  it("the process-start check reads the lookup's generation in every zone; nothing for a process gone", () => {
    const at = home();
    const generation = generationNow(at);
    for (const zone of ["UTC", "America/New_York", "Asia/Kolkata", "Australia/Lord_Howe"]) {
      expect(parseCoreGenerationOutput(run(`TZ=${zone} ` + (coreGenerationCommand(me) as string), at)), zone).toBe(generation);
    }
    expect(parseCoreGenerationOutput(run(coreGenerationCommand(goneProcess()) as string, at))).toBeNull();
  });

  it("has nothing with no transcript since the start, or with the process gone", () => {
    const at = home();
    for (const format of ["claude", "codex"] as const) {
      file(at, format, a, { age: -100_000_000 });
      expect(locate(at, format)).toBeNull();
      expect(locate(at, format, { pid: goneProcess() })).toBeNull();
    }
  });
});

describe("the Codex folder lookup, run", () => {
  it("reads only the session_meta cwd", () => {
    const at = home();
    file(at, "codex", a, { age: -100_000_000 });
    const mine = file(at, "codex", b, { age: 10 });
    file(at, "codex", c, { folder: "/Users/fixture/proj/sub", extra: { metadata: { cwd: folder } }, age: 20 });
    expect(locate(at, "codex"), "c names the folder elsewhere only").toBe(mine);
    expect(locate(at, "codex", { excluding: [b] })).toBeNull();
  });

  it("never takes a subagent's rollout, or one from anything but the interactive CLI", () => {
    for (const source of [{ subagent: { thread_spawn: { parent_thread_id: a, depth: 1 } } }, "exec", "mcp", "vscode", "CLI", "cli\n", { subagent: {} }, null]) {
      const at = home();
      const own = file(at, "codex", a);
      file(at, "codex", b, { source, age: 20 });
      expect(locate(at, "codex"), JSON.stringify(source)).toBe(own);
    }
  });

  it("sorts every rollout newest first, in one list", () => {
    const at = home();
    const ids: string[] = [];
    for (let n = 0; n < 6000; n += 1) {
      const id = randomUUID();
      ids.push(file(at, "codex", id, { filename: `rollout-${"x".repeat(130)}-${n}-${id}.jsonl` }));
    }
    const newest = ids[Math.floor(ids.length / 2)] as string;
    setModified(newest, Date.now() / 1000 + 100);
    expect(locate(at, "codex")).toBe(newest);
  });
});

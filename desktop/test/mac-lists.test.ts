// Model lists on another Mac, Codex's update question answered in Chat, and agent icons the user can read.
//
// - The remote script (src/main/model-catalogs.ts remoteListCommand) runs the list inside the user's shell read as an
//   interactive login shell, between its own markers, and falls back to the login shell's PATH. Run for real by
//   /bin/sh against stand-in shells and programs in the scratch folder (never an agent's CLI, never SSH): a banner
//   before and after, a program only the interactive startup files put on PATH (and a variable they export), a shell
//   that will not start or prints no marker. This Mac's runner gets the interactive shell's environment
//   (readInteractiveEnvironment) through a stand-in shell too.
// - A failed list says the program's own first plain line (cleaned); Cursor's and Claude Code's lists on
//   another Mac are shown from This Mac's when the other failed or is shorter, main checks the same list, and the
//   cache keeps each list under the machine it was read on.
// - Codex's update question is matched on a Codex pane, its card, and its keys through the real answer path
//   (PromptService, HostRegistry, HerdrClient) with a fake Herdr.
// - The three new drawings and the untinted monograms.

import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ ipcMain: { handle: () => undefined, on: () => undefined } }));

import { demoClaudeInitialize, demoModelLists } from "../src/main/demo/demo-model-lists";
import { readInteractiveEnvironment } from "../src/main/herdr/local";
import { HostRegistry } from "../src/main/hosts";
import {
  failedReason,
  listMarkers,
  listToken,
  LocalCatalogRunner,
  ModelCatalogs,
  readRemoteList,
  RemoteCatalogRunner,
  remoteListCommand,
  type CatalogRunner,
  type CatalogStore,
  type ListRun,
  type StoredCatalog,
} from "../src/main/model-catalogs";
import { PromptService } from "../src/main/prompt/prompts";
import { NeedsCard } from "../src/renderer/chat/NeedsCard";
import { needsCards } from "../src/renderer/chat/needs-card-store";
import { AgentGlyph, agentGlyphShape } from "../src/renderer/components/agent-kind";
import { stopBindingOf } from "../src/shared/agent-stop";
import type { HerdrDesktopBridge, HostView } from "../src/shared/ipc-contract";
import {
  borrowedLine,
  catalogErrorLine,
  claudeInitializeLine,
  firstPlainLine,
  keychainLockedReason,
  listCommand,
  parseCatalog,
  type CatalogAgent,
  type CatalogView,
  type ListCommand,
} from "../src/shared/model-catalog";
import { cardContent } from "../src/shared/prompt/card";
import { matchPrompt, readingMatch, type PromptMatch } from "../src/shared/prompt/matcher";
import { promptLike } from "../src/shared/prompt/quiet";
import type { AnswerRequest, PanePrompt } from "../src/shared/prompt/view";
import type { RemoteCommand, RemoteCommandRunner } from "../src/shared/remote-command";
import type { SidebarRow } from "../src/shared/sidebar-model";
import { backend, clock, FakeHerdr, show, snapshot } from "./support/prompt-herdr";
import { scratch as scratchRoot } from "./support/this-mac-fake";
import { HerdrClient } from "../src/main/herdr/client";
import { startCommandsWith, typedStart } from "../src/shared/start-commands";
import { modelPickCommand, startFlags, typedFlags } from "../src/shared/model-choices";
import { cursorFamilyRows } from "../src/renderer/components/AgentChips";
import { coreHost } from "./support/core-hosts";
import { FakeCore } from "./support/fake-core";
import { TUIFixtureTransport } from "./support/tui-fixture";
import { listsCodexUpdateScreen } from "../src/main/lists-captures";
import { answerPrompt } from "../src/shared/prompt/answerer";

const { newAgentFlags } = await import("../src/main/ipc");

// The tests' scratch folder (HERDR_TEST_SCRATCH), one folder per run.
const scratch = mkdtempSync(path.join(scratchRoot, "lists-"));

function executable(file: string, text: string): string {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  chmodSync(file, 0o755);
  return file;
}

// MARK: - The remote script

/**
 * Stand-in login shells: `-ilc <script>` as an interactive login shell (its startup files' banner before and after,
 * a folder on PATH and a variable exported only there), `-lc <script>` as a login shell only.
 */
const home = path.join(scratch, "home");
/** A stand-in shell: `interactive` runs for `-i` (joined, `-ilc`, or apart, `-i -l -c`), the command is the last argument. */
function standInShell(name: string, interactive: string): string {
  return executable(
    path.join(scratch, "shells", name),
    [
      "#!/bin/sh",
      "inter=no",
      'for a in "$@"; do case "$a" in -c) ;; -*i*) inter=yes;; esac; done',
      'eval "cmd=\\${$#}"',
      'if [ "$inter" = yes ]; then',
      interactive,
      "fi",
      'exec /bin/sh -c "$cmd"',
    ].join("\n") + "\n",
  );
}
const rcShell = standInShell(
  "rczsh",
  `printf 'Last login: Thu Nov 12 on ttys001\\nWelcome to the Mac\\n'; printf 'a banner with no newline'; PATH="$HOME/rcbin:$PATH"; export PATH; RC_KEY=fromzshrc; export RC_KEY; /bin/sh -c "$cmd"; s=$?; printf 'logout banner #adari\\n'; exit $s`,
);
/** A shell whose interactive start fails (its startup file ends it). */
const deadShell = standInShell("deadzsh", "exit 1");
/** A shell that starts interactively but runs nothing it is given (prints only its own words). */
const mutedShell = standInShell("mutedzsh", "printf 'oops\\n'; exit 0");

/**
 * A list program only the interactive startup files put on PATH (OpenCode in ~/.bun/bin), reading their variable. Its
 * name is the tests' own: no stock agent name is ever looked up on PATH here (an agent's CLI is never run).
 */
const rcOnly: ListCommand = { program: "zmlrcopencode", args: ["models"], stdin: null, timeoutMs: 1_000 };
executable(path.join(home, "rcbin", "zmlrcopencode"), "#!/bin/sh\nprintf 'prov/model-a\\nprov/model-%s\\n' \"$RC_KEY\"\n");
/** A program on the plain PATH, its arguments and stdin echoed, exit 3. */
const plainBin = path.join(scratch, "plainbin");
executable(path.join(plainBin, "echoer"), '#!/bin/sh\nfor a in "$@"; do printf "[%s]" "$a"; done\nprintf "\\n"\ncat\nexit 3\n');
/** Cursor Agent over SSH: its keychain words on stderr, coloured, exit 1. */
executable(path.join(plainBin, "lockedcursor"), "#!/bin/sh\nprintf '\\033[31mError: Your macOS login keychain is locked.\\033[0m\\nRun security unlock-keychain and try again.\\n' >&2\nexit 1\n");
/** A wrapper that must never run for a list (it leaves a mark if it does). */
const wrapperMark = path.join(scratch, "wrapper-ran");
executable(path.join(plainBin, "cl"), `#!/bin/sh\ntouch '${wrapperMark}'\n`);

/** What SSH runs: `/bin/sh -c '<script>'`, here run by /bin/sh the same way. */
function runRemote(command: RemoteCommand, shell: string): string {
  return execFileSync("/bin/sh", ["-c", command.text], { env: { HOME: home, SHELL: shell, PATH: `${plainBin}:/usr/bin:/bin` }, encoding: "utf8" });
}

/** One read's token (main makes a fresh one for each read; the tests fix one to read the output with). */
const token = "t0k3n0f0n3r3adAbc123";
const remoteRun = (command: ListCommand, shell: string): ListRun => readRemoteList(runRemote(remoteListCommand("opencode", command, token), shell), token);

/** One shell word made of single-quoted parts and `"'"` (quote()'s escapes) as its value. */
function unquote(word: string): string {
  let out = "";
  const parts = /'([^']*)'|"(')"/gy;
  let found: RegExpExecArray | null;
  while ((found = parts.exec(word)) !== null) out += found[1] ?? found[2] ?? "";
  return out;
}

/** The text with every single-quoted part (and quote()'s `"'"`) taken out: what a shell reads unquoted. */
const unquotedParts = (text: string): string => text.replace(/'[^']*'/g, "").replace(/"'"/g, "");

describe("another Mac's list runs in the user's interactive shell's environment", () => {
  it("the script for each agent holds every value quoted (program, arguments, stdin), in both its forms", () => {
    for (const agent of ["claude", "codex", "grok", "cursor", "opencode"] as const) {
      for (const start of [null, `/opt/homebrew/bin/${agent === "cursor" ? "cursor-agent" : agent} --flag`]) {
        const command = listCommand(agent, start)!;
        const text = remoteListCommand(agent, command, token).text;
        expect(text.startsWith("/bin/sh -c '")).toBe(true);
        const outer = unquote(text.slice("/bin/sh -c ".length));
        const assigned = /I=((?:'[^']*'|"'")+); /.exec(outer)!;
        const inner = unquote(assigned[1]!);
        const values = [command.program, ...command.args.filter((arg) => arg !== ""), ...(command.stdin === null ? [] : [command.stdin])];
        for (const script of [outer.replace(assigned[0], "I=...; "), inner]) {
          // Every value is there, and none of it outside quotes.
          for (const value of values) expect(script).toContain(`'${value}'`);
          const bare = unquotedParts(script);
          for (const value of values) expect(bare).not.toContain(value);
          expect(script).not.toMatch(/`/);
        }
        // The interactive form first, the login shell's PATH after.
        expect(outer).toContain('"$S" -ilc "$I"');
        expect(outer).toContain(assigned[0]);
        expect(outer.indexOf("-ilc")).toBeLessThan(outer.indexOf("-lc '"));
      }
    }
  });

  it("startup files that print a banner before and after: the list still reads, the banners are not part of it", () => {
    const out = runRemote(remoteListCommand("opencode", rcOnly, token), rcShell);
    expect(out).toContain("Welcome to the Mac");
    expect(out).toContain("logout banner");
    const run = readRemoteList(out, token);
    expect(run).toEqual({ kind: "ran", code: 0, output: "prov/model-a\nprov/model-fromzshrc\n" });
    // A program only ~/.zshrc puts on PATH is found, with the variable it exports (OpenCode's list reads 379 rows this way, not 12).
    const parsed = parseCatalog("opencode", run.kind === "ran" ? run.output : "");
    expect(parsed.ok && parsed.models.map((model) => model.id)).toEqual(["prov/model-a", "prov/model-fromzshrc"]);
  });

  it("arguments and stdin reach the program exactly; the exit code reads; a missing program says so", () => {
    const echo = (shell: string): ListRun => remoteRun({ program: "echoer", args: ["-p", "--setting-sources", "", "it's"], stdin: claudeInitializeLine, timeoutMs: 1_000 }, shell);
    for (const shell of [rcShell, deadShell, mutedShell]) {
      expect(echo(shell)).toEqual({ kind: "ran", code: 3, output: `[-p][--setting-sources][][it's]\n${claudeInitializeLine}\n` });
      expect(remoteRun({ program: path.join(plainBin, "nothing-here"), args: [], stdin: null, timeoutMs: 1_000 }, shell)).toEqual({ kind: "missing" });
    }
    // `~/` is the machine's home.
    executable(path.join(home, "tilde-prog"), '#!/bin/sh\nprintf "home"\n');
    expect(remoteRun({ program: "~/tilde-prog", args: [], stdin: null, timeoutMs: 1_000 }, rcShell)).toEqual({ kind: "ran", code: 0, output: "home" });
  });

  it("the interactive shell failing, or printing no marker, falls back to the login shell's PATH", () => {
    // Only the interactive PATH has the program: without that shell it is missing, never a banner read as a list.
    expect(remoteRun(rcOnly, deadShell)).toEqual({ kind: "missing" });
    expect(remoteRun(rcOnly, mutedShell)).toEqual({ kind: "missing" });
    // A shell that is not an absolute path is /bin/sh.
    expect(remoteRun({ program: "echoer", args: [], stdin: null, timeoutMs: 1_000 }, "zsh")).toEqual({ kind: "ran", code: 3, output: "\n" });
  });

  it("the markers read: a cut answer is refused, a banner alone is not a list", () => {
    const m = listMarkers(token);
    expect(() => readRemoteList("partial list", token)).toThrow("its answer was cut off");
    expect(() => readRemoteList(`Welcome\n${m.begin}\nrows`, token)).toThrow("exactly one list");
    expect(readRemoteList(`Welcome to the Mac\n${m.missing}\nbye\n`, token)).toEqual({ kind: "missing" });
    expect(readRemoteList(`banner\n${m.begin}\nrow\n\n${m.exit} 0\nlogout ${m.exit}\n`, token)).toEqual({ kind: "ran", code: 0, output: "row\n" });
    // Markers without this read's token are a startup file's words, never a frame.
    expect(() => readRemoteList("banner\n#adari-list\nrow\n\n#adari-exit 0\n", token)).toThrow("its answer was cut off");
  });

  it("a wrapper start command is still never run for a list (its script names only the agent's own program)", () => {
    for (const [agent, start, wrapper] of [["claude", "cl --resume", "'cl'"], ["codex", "cx --yolo", "'cx'"]] as const) {
      const command = listCommand(agent, start)!;
      expect(command.program).toBe(agent);
      const outer = unquote(remoteListCommand(agent, command, token).text.slice("/bin/sh -c ".length));
      expect(outer).toContain(`'${agent}'`);
      expect(outer).not.toContain(wrapper);
    }
    // Run with a stand-in in its place (no stock name looked up): the wrapper on PATH is not touched.
    runRemote(remoteListCommand("claude", { ...listCommand("claude", "cl --resume")!, program: "echoer" }, token), rcShell);
    expect(() => execFileSync("/bin/test", ["-e", wrapperMark])).toThrow();
  });

  it("This Mac: the interactive shell's environment finds a program only ~/.zshrc puts on PATH", async () => {
    const env = await readInteractiveEnvironment({ shell: rcShell, env: { HOME: home, PATH: "/usr/bin:/bin" }, home, environmentTimeoutMs: 5_000 });
    expect(env).not.toBeNull();
    expect(env!["PATH"]!.split(":")[0]).toBe(path.join(home, "rcbin"));
    expect(env!["RC_KEY"]).toBe("fromzshrc");
    const runner = new LocalCatalogRunner(async () => env!, home);
    const run = await runner.run("opencode", rcOnly, new AbortController().signal);
    expect(run).toEqual({ kind: "ran", code: 0, output: "prov/model-a\nprov/model-fromzshrc\n" });
    // A shell whose interactive start fails: null (main keeps the login environment).
    expect(await readInteractiveEnvironment({ shell: deadShell, env: { HOME: home, PATH: "/usr/bin:/bin" }, home, environmentTimeoutMs: 2_000 })).toBeNull();
  });
});

// MARK: - The failure line, the This Mac fallback

describe("a failed list says the program's own first plain line", () => {
  it("cleaned: escape codes, control characters, a second line, a very long line", () => {
    expect(firstPlainLine("\u001b[31mError: Your macOS login keychain is locked.\u001b[0m\nRun security unlock-keychain and try again.\n")).toBe("Your macOS login keychain is locked.");
    expect(firstPlainLine("\u001b]0;cursor-agent\u0007\u0000not\u0008 signed\u0007 in\r\nsecond")).toBe("not signed in");
    expect(firstPlainLine("\n  ---  \n\t\n  the real reason  \nmore")).toBe("the real reason");
    const long = firstPlainLine(`${"word ".repeat(60)}end`)!;
    expect([...long]).toHaveLength(100);
    expect(long.endsWith("\u2026")).toBe(true);
    expect(firstPlainLine("\u001b[2K\u001b[1G\n")).toBeNull();
    expect(firstPlainLine("")).toBeNull();
    // One line, never an escape or a control character, in the picker's line.
    const line = catalogErrorLine("cursor", failedReason("cursor", { code: 1, output: "", said: firstPlainLine("\u001b[1mError:\u001b[0m quota\u0007 reached\nline two")! }));
    expect(line).toBe("Could not read Cursor's models: quota reached.");
    expect([...line].every((character) => character.charCodeAt(0) >= 0x20 && character.charCodeAt(0) !== 0x7f)).toBe(true);
  });

  it("the reason: stderr's line, else stdout's when it reads as a message, else the exit code", () => {
    expect(failedReason("cursor", { code: 1, output: "auto - Auto\n", said: "Token expired" })).toBe("Token expired");
    expect(failedReason("cursor", { code: 1, output: "Error: You are not logged in\n" })).toBe("You are not logged in");
    expect(failedReason("cursor", { code: 2, output: "auto - Auto\n" })).toBe("it ended with exit 2");
    expect(failedReason("cursor", { code: 1, output: "" })).toBe("it ended with exit 1");
  });

  it("over SSH: Cursor's keychain words read as the plain reason, through the real script and runner", async () => {
    const ssh: RemoteCommandRunner = {
      run: async (command) => ({ bytes: new Uint8Array(Buffer.from(runRemote(command, rcShell))), truncated: false }),
    };
    const runner = new RemoteCatalogRunner(ssh, "Mac mini");
    const direct = await runner.run("cursor", { program: path.join(plainBin, "lockedcursor"), args: ["--list-models"], stdin: null, timeoutMs: 1_000 }, new AbortController().signal);
    expect(direct).toEqual({ kind: "ran", code: 1, output: "", said: keychainLockedReason });
    const catalogs = new ModelCatalogs({
      machine: () => ({ runner: { where: "Mac mini", run: (agent) => runner.run(agent, { program: path.join(plainBin, "lockedcursor"), args: [], stdin: null, timeoutMs: 1_000 }, new AbortController().signal) }, startCommand: async () => null }),
      store: null,
      now: () => 1,
      changed: () => undefined,
    });
    expect((await catalogs.settled("mini", "cursor")).error).toBe("Could not read Cursor's models: the Mac's login keychain is locked over SSH.");
  });

  it("This Mac: the program's stderr line, kept", async () => {
    const runner = new LocalCatalogRunner(() => ({ PATH: `${plainBin}:/usr/bin:/bin`, HOME: home }), home);
    const run = await runner.run("cursor", { program: "lockedcursor", args: [], stdin: null, timeoutMs: 1_000 }, new AbortController().signal);
    expect(run).toEqual({ kind: "ran", code: 1, output: "", said: "Your macOS login keychain is locked." });
  });
});

/** A runner that answers from a script of runs, one per call, counting them. */
class FakeRunner implements CatalogRunner {
  readonly runs: CatalogAgent[] = [];
  next: (() => Promise<ListRun>)[] = [];
  constructor(readonly where: string) {}
  run(agent: CatalogAgent): Promise<ListRun> {
    this.runs.push(agent);
    const answer = this.next.shift();
    return answer === undefined ? Promise.resolve({ kind: "ran", code: 0, output: demoModelLists[agent as Exclude<CatalogAgent, "agy">] }) : answer();
  }
}

class MemoryStore implements CatalogStore {
  saved: readonly StoredCatalog[] = [];
  load(): Promise<readonly StoredCatalog[]> {
    return Promise.resolve([]);
  }
  save(catalogs: readonly StoredCatalog[]): Promise<void> {
    this.saved = catalogs;
    return Promise.resolve();
  }
}

/** Claude Code over SSH, signed out: its answer with five models (This Mac's signed-in list has 14). */
const claudeSignedOut = (() => {
  const record = JSON.parse(demoClaudeInitialize) as { response: { response: { models: unknown[] } } };
  record.response.response.models = record.response.response.models.slice(0, 5);
  return `${JSON.stringify(record)}\n`;
})();

const keychainFailure = (): Promise<ListRun> => Promise.resolve({ kind: "ran", code: 1, output: "", said: keychainLockedReason });

function machines(options: { thisMac?: string | null } = {}) {
  const local = new FakeRunner("this Mac");
  const remote = new FakeRunner("Mac mini");
  const store = new MemoryStore();
  const changes: { hostId: string; view: CatalogView }[] = [];
  const catalogs = new ModelCatalogs({
    machine: (hostId) => ({ runner: hostId === "this-mac" ? local : remote, startCommand: async () => null }),
    store,
    now: () => 5_000_000,
    changed: (hostId, view) => changes.push({ hostId, view }),
    thisMac: () => (options.thisMac === undefined ? "this-mac" : options.thisMac),
    machineName: (hostId) => (hostId === "mini" ? "Mac mini" : null),
  });
  return { local, remote, store, catalogs, changes };
}

const line = borrowedLine("Mac mini");

describe("Cursor's and Claude Code's lists on another Mac, from This Mac's when that one reads", () => {
  it("the line's words", () => {
    expect(line).toBe("List read on This Mac; Mac mini's own list needs its login keychain.");
  });

  it("Cursor failed on the other Mac and read on This Mac: This Mac's list, the quiet line, no error", async () => {
    const m = machines();
    m.remote.next.push(keychainFailure);
    const view = await m.catalogs.settled("mini", "cursor");
    expect(view.models).toHaveLength(143);
    expect(view.borrowed).toBe(line);
    expect(view.error).toBeNull();
    expect(m.local.runs).toEqual(["cursor"]);
    expect(m.remote.runs).toEqual(["cursor"]);
    // The picker's later view is the same; This Mac's own view is its own list, no line.
    expect((await m.catalogs.view("mini", "cursor")).borrowed).toBe(line);
    expect((await m.catalogs.view("this-mac", "cursor")).borrowed).toBeUndefined();
    // When This Mac's read ends, the other Mac's picker is told too.
    expect(m.changes.some((change) => change.hostId === "mini" && change.view.borrowed === line)).toBe(true);
  });

  it("Claude Code shorter on the other Mac (signed out over SSH): This Mac's 14 with the line", async () => {
    const m = machines();
    m.remote.next.push(() => Promise.resolve({ kind: "ran", code: 0, output: claudeSignedOut }));
    const view = await m.catalogs.settled("mini", "claude");
    expect(view.models).toHaveLength(14);
    expect(view.borrowed).toBe(line);
    // As long as the other Mac's own: its own stands.
    const same = machines();
    const own = await same.catalogs.settled("mini", "claude");
    expect(own.models).toHaveLength(14);
    expect(own.borrowed).toBeUndefined();
  });

  it("neither when This Mac has none: the other Mac's own answer stands (Cursor's failure line, Claude Code's five)", async () => {
    const m = machines();
    m.remote.next.push(keychainFailure, () => Promise.resolve({ kind: "ran", code: 0, output: claudeSignedOut }));
    m.local.next.push(() => Promise.resolve({ kind: "missing" }), () => Promise.resolve({ kind: "missing" }));
    const cursor = await m.catalogs.settled("mini", "cursor");
    expect(cursor.models).toEqual([]);
    expect(cursor.error).toBe("Could not read Cursor's models: the Mac's login keychain is locked over SSH.");
    expect(cursor.borrowed).toBeUndefined();
    const claude = await m.catalogs.settled("mini", "claude");
    expect(claude.models).toHaveLength(5);
    expect(claude.borrowed).toBeUndefined();
    // No This Mac listed: nothing read there, nothing borrowed.
    const alone = machines({ thisMac: null });
    alone.remote.next.push(keychainFailure);
    expect((await alone.catalogs.settled("mini", "cursor")).borrowed).toBeUndefined();
    expect(alone.local.runs).toEqual([]);
  });

  it("only Cursor and Claude Code: another agent's shorter list on the other Mac is its own", async () => {
    const m = machines();
    m.remote.next.push(() => Promise.resolve({ kind: "ran", code: 0, output: "opencode/beam-free\n" }));
    const view = await m.catalogs.settled("mini", "opencode");
    expect(view.models).toHaveLength(1);
    expect(view.borrowed).toBeUndefined();
    expect(m.local.runs).toEqual([]);
  });

  it("main accepts a start with a model from the shown list and refuses one from neither list", async () => {
    const m = machines();
    m.remote.next.push(keychainFailure, () => Promise.resolve({ kind: "ran", code: 0, output: claudeSignedOut }));
    const request = { workspaceId: "w1", folder: null };
    expect((await newAgentFlags(m.catalogs, "mini", { ...request, kind: "cursor", model: "composer-2.5" })).length).toBeGreaterThan(0);
    await expect(newAgentFlags(m.catalogs, "mini", { ...request, kind: "cursor", model: "made-up-model" })).rejects.toThrow("Nothing was made.");
    // Claude Code: a model only This Mac's list has (the picker showed it) is taken; one in neither is refused.
    expect((await newAgentFlags(m.catalogs, "mini", { ...request, kind: "claude", model: "claude-opus-4-6" })).length).toBeGreaterThan(0);
    await expect(newAgentFlags(m.catalogs, "mini", { ...request, kind: "claude", model: "claude-made-up-9" })).rejects.toThrow("Nothing was made.");
  });

  it("the cache keeps each list under the machine it was read on", async () => {
    const m = machines();
    m.remote.next.push(keychainFailure, () => Promise.resolve({ kind: "ran", code: 0, output: claudeSignedOut }));
    await m.catalogs.settled("mini", "cursor");
    await m.catalogs.settled("mini", "claude");
    const saved = m.store.saved.map((entry) => `${entry.host} ${entry.agent} ${entry.models.length}`).sort();
    expect(saved).toEqual(["mini claude 5", "this-mac claude 14", "this-mac cursor 143"]);
  });
});

// MARK: - Codex's update question

/** Codex's update question as Codex 0.167.0 shows it at start, with its first lines. */
const updateScreen = [
  "",
  "  \u2728 Update available! 0.167.0 -> 0.168.0",
  "",
  "  Release notes: https://github.com/openai/codex/releases/latest",
  "",
  "\u203A 1. Update now (runs `npm install -g @openai/codex`)",
  "  2. Skip",
  "  3. Skip until next version",
  "",
  "  enter continue \u00B7 esc skip",
  "",
].join("\n");
/** The four lines alone (without its first line above them, not the prompt's own screen: unmatched). */
const fourLines = ["\u203A 1. Update now (runs `npm install -g @openai/codex`)", "  2. Skip", "  3. Skip until next version", "  enter continue \u00B7 esc skip"].join("\n");

const updateOf = (text: string): PromptMatch | null => readingMatch(matchPrompt(text, "w1:p1", "codex"));

describe("Codex's update question is read on a Codex pane", () => {
  it("the four lines match: three choices in Codex's words, the marked one Return's", () => {
    // Its first line at the read's top (nothing above it), and under the cell Codex draws at start (listsCodexUpdateScreen).
    const atTop = updateScreen.replace(/^\n/u, "");
    for (const text of [updateScreen, atTop, listsCodexUpdateScreen]) {
      const match = updateOf(text)!;
      expect(match.kind).toBe("codexUpdate");
      expect(match.options.map((option) => option.label)).toEqual(["Update now (runs `npm install -g @openai/codex`)", "Skip", "Skip until next version"]);
      expect(match.options.map((option) => option.keys)).toEqual([["Enter"], ["Escape"], []]);
      expect(match.options.map((option) => option.isReturnDefault)).toEqual([true, false, false]);
      expect(match.options[2]!.inTerminal).toBe(true);
    }
    expect(updateOf(updateScreen)!.question).toBe("Update available! 0.167.0 -> 0.168.0");
    // The four lines alone are not the prompt's own screen.
    expect(updateOf(fourLines)).toBeNull();
  });

  it("the mark on Skip: Return answers Skip; Update now and Skip until next version are the Terminal's", () => {
    const moved = updateScreen.replace("\u203A 1. Update", "  1. Update").replace("  2. Skip\n", "\u203A 2. Skip\n");
    const match = updateOf(moved)!;
    expect(match.options.map((option) => option.keys)).toEqual([[], ["Enter"], []]);
    expect(match.options.map((option) => option.inTerminal === true)).toEqual([true, false, true]);
    // Where the mark sits is part of the question answered (Return answers the marked one).
    expect(match.fingerprint).not.toEqual(updateOf(updateScreen)!.fingerprint);
  });

  it("a prompt that differs by a word stays the unmatched card", () => {
    const variants = [
      updateScreen.replace("2. Skip\n", "2. Skip it\n"),
      updateScreen.replace("Skip until next version", "Skip until the next version"),
      updateScreen.replace("(runs `npm", "(run `npm"),
      updateScreen.replace("enter continue", "enter confirm"),
      updateScreen.replace("esc skip", "esc quit"),
      updateScreen.replace("\u203A 1.", "  1."),
      updateScreen.replace("  2. Skip", "\u203A 2. Skip"),
      updateScreen.replace("  3. Skip until next version\n", "  3. Skip until next version\n  4. Something else\n"),
      `${updateScreen}\n› the next message\n`,
    ];
    for (const text of variants) expect(matchPrompt(text, "w1:p1", "codex").type).toBe("unmatched");
    // Another pane's kind never reads it as Codex's.
    for (const kind of [null, "claude", "grok", "cursor"]) expect(readingMatch(matchPrompt(updateScreen, "w1:p1", kind))?.kind).not.toBe("codexUpdate");
    // It stays prompt-like (the mark holds while it is on screen).
    expect(promptLike(updateScreen, "codex")).toBe(true);
  });

  it("the card: Codex has an update, its first line, its three choices; the update says what it runs", () => {
    const content = cardContent(updateOf(updateScreen)!, "codex");
    expect(content).toMatchObject({ kind: "update", header: "Codex has an update", target: null, question: "Update available! 0.167.0 -> 0.168.0", returnIndex: 0 });
    expect(content.options[0]!.label).toContain("runs `npm install -g @openai/codex`");
  });
});

describe("Codex's update card rendered", () => {
  const host = { id: "mac", name: "Mac mini", state: "connected" } as unknown as HostView;
  const codexRow = { paneID: "w1:p1", isAgent: true, status: "blocked", kind: "codex", name: "aurora" } as unknown as SidebarRow;
  const previous = (globalThis as { window?: unknown }).window;
  const bridge: Pick<HerdrDesktopBridge, "listPrompts" | "onPromptsChanged" | "answerPrompt"> = {
    listPrompts: () => Promise.resolve([]),
    onPromptsChanged: () => () => undefined,
    answerPrompt: () => Promise.resolve({ type: "sent", label: "Skip" }),
  };
  beforeEach(() => {
    (globalThis as { window?: unknown }).window = { herdrDesktop: bridge };
  });
  afterEach(() => {
    (globalThis as { window?: unknown }).window = previous;
    needsCards.receive([]);
  });
  const shown = (text: string): PanePrompt => ({
    hostId: "mac",
    paneId: "w1:p1",
    episode: "e1",
    incarnation: 1,
    connection: 1,
    epoch: 1,
    reading: matchPrompt(text, "w1:p1", "codex"),
    quiet: false,
    cleared: false,
  });
  const render = (): string => renderToStaticMarkup(createElement(NeedsCard, { host, row: codexRow, onShowTerminal: () => undefined }));

  it("three buttons in Codex's words; no Answer in Terminal line for the whole card", () => {
    needsCards.receive([shown(updateScreen)]);
    const html = render();
    expect(html).toContain('data-needs-card="update"');
    expect(html).toContain("Codex has an update");
    expect(html).toContain("Update available! 0.167.0 -&gt; 0.168.0");
    expect(html.match(/class="nc-opt( on)?"/g)).toHaveLength(3);
    expect(html).toContain("Update now (runs `npm install -g @openai/codex`)");
    expect(html).toContain(">Skip<");
    expect(html).toContain("Skip until next version");
    expect(html).toContain("Answered in the Terminal");
    expect(html).not.toContain("The app cannot read this question");
  });

  it("a prompt that differs by a word: the unmatched card, Answer in Terminal", () => {
    needsCards.receive([shown(updateScreen.replace("2. Skip\n", "2. Skip it\n"))]);
    const html = render();
    expect(html).toContain('data-needs-card="unmatched"');
    expect(html).toContain("Answer in Terminal");
  });
});

async function codexSetup(screens: string[]) {
  const json = snapshot();
  const panes = json["panes"] as Record<string, unknown>[];
  const agents = json["agents"] as Record<string, unknown>[];
  panes[0]!["agent"] = "codex";
  agents[0]!["agent"] = "codex";
  agents[0]!["agent_session"] = { source: "herdr:codex", agent: "codex", kind: "id", value: "c-1" };
  const herdr = new FakeHerdr(json, { "w1:p1": screens });
  const registry = new HostRegistry(() => undefined);
  registry.add({ id: "mac", name: "Mac mini", kind: "demo", address: "demo", platform: "macOS" }, backend(herdr, { value: 1 }));
  await registry.refreshAll();
  const time = clock();
  const service = new PromptService(registry, () => undefined, time);
  await service.tick();
  const prompt = (): PanePrompt => service.list().find((each) => each.paneId === "w1:p1")!;
  const request = (key: string): AnswerRequest => ({
    hostId: "mac",
    paneId: "w1:p1",
    binding: stopBindingOf(registry.list()[0]!, "w1:p1", "Codex"),
    fingerprint: readingMatch(prompt().reading!)!.fingerprint,
    episode: prompt().episode,
    key,
  });
  const keys = (): string[][] => herdr.sent("pane.send_keys").map((params) => params["keys"] as string[]);
  return { herdr, service, prompt, request, keys };
}

describe("each Codex update button writes exactly its keys, through the real answer path", () => {
  it("Update now (marked): Return, once", async () => {
    const context = await codexSetup([updateScreen, "updating\n"]);
    expect(readingMatch(context.prompt().reading!)?.kind).toBe("codexUpdate");
    expect(await context.service.answer(context.request("1"))).toEqual({ type: "sent", label: "Update now (runs `npm install -g @openai/codex`)" });
    expect(context.keys()).toEqual([["Enter"]]);
  });

  it("Skip: Esc, once", async () => {
    const context = await codexSetup([updateScreen, "\u203A \n"]);
    expect(await context.service.answer(context.request("2"))).toEqual({ type: "sent", label: "Skip" });
    expect(context.keys()).toEqual([["Escape"]]);
  });

  it("Skip until next version: nothing sent, Answer in Terminal", async () => {
    const context = await codexSetup([updateScreen]);
    expect(await context.service.answer(context.request("3"))).toEqual({ type: "refused", note: "Answer in Terminal: this choice's key is not known here, so nothing was sent", terminal: true });
    expect(context.keys()).toEqual([]);
  });

  it("the mark moved in the pane before the answer (another question): nothing sent", async () => {
    const moved = updateScreen.replace("\u203A 1. Update", "  1. Update").replace("  2. Skip\n", "\u203A 2. Skip\n");
    const context = await codexSetup([updateScreen]);
    const request = context.request("1");
    // The user pressed the down key in its Terminal: the screen shows the mark on Skip now.
    show(context.herdr, "w1:p1", moved);
    expect(await context.service.answer(request)).toMatchObject({ type: "changed" });
    expect(context.keys()).toEqual([]);
  });
});

// MARK: - The icons

describe("Cursor Agent, Grok Build and OpenCode drawn; the monograms untinted", () => {
  it("the three new drawings: line drawings in the row's ink, no letters, no tint", () => {
    for (const kind of ["cursor", "grok", "opencode"]) {
      expect(agentGlyphShape(kind)).toBe(kind);
      const svg = renderToStaticMarkup(createElement(AgentGlyph, { kind }));
      expect(svg).toContain(`ag-${kind}`);
      expect(svg).toContain('stroke="currentColor"');
      expect(svg).toMatch(/<path d="[^"]+"/);
      expect(svg).not.toContain("<text");
      expect(svg).not.toMatch(/style=|var\(--/);
    }
    // Each its own.
    const drawings = ["cursor", "grok", "opencode", "claude", "codex", "gemini"].map((kind) => renderToStaticMarkup(createElement(AgentGlyph, { kind })).replace(/class="[^"]*"/, ""));
    expect(new Set(drawings).size).toBe(6);
  });

  it("every remaining monogram: its letters in the row's ink, no tint", () => {
    for (const kind of ["pi", "amp", "agy", "copilot", "qwen", "kimi", "kilo"]) {
      const svg = renderToStaticMarkup(createElement(AgentGlyph, { kind }));
      expect(svg).toContain("ag-monogram");
      expect(svg).toContain('fill="currentColor"');
      expect(svg).not.toMatch(/style=|var\(--/);
    }
  });
});

// MARK: - The read's own frame, the failure line's agent, the update prompt's own screen

/** A program on the plain PATH whose whole list is one row. */
executable(path.join(plainBin, "zmlreallist"), "#!/bin/sh\nprintf 'prov/real\\n'\n");
const realList: ListCommand = { program: "zmlreallist", args: ["models"], stdin: null, timeoutMs: 1_000 };
/** The read's token as a startup file could find it in its command (to print this read's own markers). */
const tokenOfCmd = `t=$(printf '%s' "$cmd" | /usr/bin/sed -n 's/.*#adari-list-\\([A-Za-z0-9]*\\).*/\\1/p' | /usr/bin/head -n 1)`;
const startupOldBegin = standInShell("startupbegin", `printf '\\n#adari-list\\nprov/from-startup\\n'; /bin/sh -c "$cmd"; exit $?`);
const logoutOldExit = standInShell("logoutexit", `/bin/sh -c "$cmd"; s=$?; printf '\\nprov/from-logout\\n#adari-exit 0\\n'; exit $s`);
const startupOwnBegin = standInShell("startupownbegin", `${tokenOfCmd}; printf '\\n#adari-list-%s\\nprov/from-startup\\n' "$t"; /bin/sh -c "$cmd"; exit $?`);
const logoutOwnExit = standInShell("logoutownexit", `${tokenOfCmd}; /bin/sh -c "$cmd"; s=$?; printf '\\nprov/from-logout\\n#adari-exit-%s 0\\n' "$t"; exit $s`);
const ids = (run: ListRun): string[] => {
  const parsed = parseCatalog("opencode", run.kind === "ran" ? run.output : "");
  return parsed.ok ? parsed.models.map((model) => model.id) : [];
};

describe("one frame of this read's own token, never startup text", () => {
  it("a startup line imitating the begin marker, or a logout line imitating the exit marker, adds no model", () => {
    for (const shell of [startupOldBegin, logoutOldExit, startupOwnBegin, logoutOwnExit]) {
      const run = remoteRun(realList, shell);
      expect(run).toEqual({ kind: "ran", code: 0, output: "prov/real\n" });
      expect(ids(run)).toEqual(["prov/real"]);
    }
  });

  it("this read's own frame repeated in the interactive output: the script falls back to the login shell's form", () => {
    // The program only the interactive PATH has: the fallback cannot find it, so a repeated frame is never read.
    expect(remoteRun({ ...rcOnly }, startupOwnBegin)).toEqual({ kind: "missing" });
    expect(remoteRun({ ...rcOnly }, logoutOwnExit)).toEqual({ kind: "missing" });
  });

  it("the reader: exactly one whole frame, else refused (repeated, out of order, with a missing line)", () => {
    const m = listMarkers(token);
    expect(() => readRemoteList(`\n${m.begin}\nprov/banner\n\n${m.begin}\nprov/real\n\n${m.exit} 0\n`, token)).toThrow("exactly one list");
    expect(() => readRemoteList(`\n${m.begin}\nprov/real\n\n${m.exit} 0\nprov/logout\n${m.exit} 0\n`, token)).toThrow("exactly one list");
    expect(() => readRemoteList(`\n${m.exit} 0\n${m.begin}\nprov/real\n`, token)).toThrow("exactly one list");
    expect(() => readRemoteList(`\n${m.missing}\n${m.begin}\nprov/real\n\n${m.exit} 0\n`, token)).toThrow("exactly one list");
    expect(() => readRemoteList(`\n${m.missing}\n${m.missing}\n`, token)).toThrow("exactly one list");
    // Another read's token is not this read's frame.
    const other = listMarkers("an0th3rr3adt0k3n999");
    expect(() => readRemoteList(`\n${other.begin}\nprov/real\n\n${other.exit} 0\n`, token)).toThrow("its answer was cut off");
  });

  it("a token is fresh for each read, letters and digits only; any other form builds nothing", async () => {
    const tokens: string[] = [];
    const ssh: RemoteCommandRunner = {
      run: async (command) => {
        if (command.intent.kind === "model-list") tokens.push(command.intent.token);
        return { bytes: new Uint8Array(Buffer.from(runRemote(command, rcShell))), truncated: false };
      },
    };
    const runner = new RemoteCatalogRunner(ssh, "Mac mini");
    for (let i = 0; i < 2; i += 1) expect(await runner.run("opencode", realList, new AbortController().signal)).toEqual({ kind: "ran", code: 0, output: "prov/real\n" });
    expect(tokens).toHaveLength(2);
    expect(tokens[0]).not.toBe(tokens[1]);
    for (const each of tokens) expect(each).toMatch(/^[0-9a-f]{24}$/u);
    expect(listToken()).toMatch(/^[0-9a-f]{24}$/u);
    for (const bad of ["", "short", "has space in it 12345", "quote'd0123456789abc", "$(word)0123456789abc"]) {
      expect(() => remoteListCommand("opencode", realList, bad)).toThrow("letters and digits");
      expect(() => readRemoteList("", bad)).toThrow("letters and digits");
    }
  });

  it("New agent refuses a row printed by startup code that the list program never held", async () => {
    for (const shell of [startupOldBegin, logoutOldExit, startupOwnBegin, logoutOwnExit]) {
      const ssh: RemoteCommandRunner = { run: async (command) => ({ bytes: new Uint8Array(Buffer.from(runRemote(command, shell))), truncated: false }) };
      const runner = new RemoteCatalogRunner(ssh, "Mac mini");
      const catalogs = new ModelCatalogs({
        machine: () => ({ runner: { where: "Mac mini", run: (agent, _command, signal) => runner.run(agent, realList, signal) }, startCommand: async () => null }),
        store: null,
        now: () => 1,
        changed: () => undefined,
      });
      const request = { workspaceId: "w1", folder: null, kind: "opencode" };
      await expect(newAgentFlags(catalogs, "mini", { ...request, model: "prov/from-startup" })).rejects.toThrow("Nothing was made.");
      await expect(newAgentFlags(catalogs, "mini", { ...request, model: "prov/from-logout" })).rejects.toThrow("Nothing was made.");
      expect((await newAgentFlags(catalogs, "mini", { ...request, model: "prov/real" })).length).toBeGreaterThan(0);
    }
  });
});

describe("the failure line knows the agent; Claude Code's answer is never shown", () => {
  const account = `${JSON.stringify({ account: { email: "synthetic@example.invalid", organization: "not signed in" }, type: "control_response", response: { subtype: "error", error: "initialize failed" } })}\n`;

  it("Claude Code's account text never reaches the failure line (stdout or stderr)", async () => {
    for (const run of [
      { kind: "ran", code: 1, output: account },
      { kind: "ran", code: 1, output: account, said: "synthetic@example.invalid is not signed in" },
      { kind: "ran", code: 2, output: "Error: not signed in as synthetic@example.invalid\n" },
    ] as const) {
      const catalogs = new ModelCatalogs({ machine: () => ({ startCommand: async () => null, runner: { where: "fake", run: async () => run } }), store: null, now: () => 1, changed: () => undefined });
      const view = await catalogs.settled("r", "claude");
      expect(view.error).not.toContain("synthetic@example.invalid");
      expect(view.error).not.toContain("organization");
      expect(view.error).not.toContain("not signed in");
    }
    expect(failedReason("claude", { code: 1, output: account })).toBe("it answered with an error");
    expect(failedReason("claude", { code: 1, output: "Error: synthetic@example.invalid\n", said: "synthetic@example.invalid" })).toBe("it ended with exit 1");
    // The keychain's reason is fixed words, kept.
    expect(failedReason("claude", { code: 1, output: "", said: keychainLockedReason })).toBe(keychainLockedReason);
  });

  it("the other agents: their own plain line stays; a line that is JSON or looks structured is never shown", () => {
    expect(failedReason("cursor", { code: 1, output: "", said: "Your macOS login keychain is locked." })).toBe("Your macOS login keychain is locked.");
    expect(failedReason("opencode", { code: 1, output: '{"error":"not authorized","user":"synthetic@example.invalid"}\n' })).toBe("it ended with exit 1");
    expect(failedReason("grok", { code: 1, output: "", said: '{"error": "denied"}' })).toBe("it ended with exit 1");
    expect(failedReason("codex", { code: 1, output: 'error: "token": "abc", "user": "x"\n' })).toBe("it ended with exit 1");
    expect(failedReason("cursor", { code: 1, output: "", said: '[{"login":"failed"}]' })).toBe("it ended with exit 1");
  });
});

describe("only the update prompt's own screen is matched", () => {
  const promptOnly = ["Update available! 0.167.0 -> 0.168.0", "", "\u203A 1. Update now (runs `npm install -g @openai/codex`)", "  2. Skip", "  3. Skip until next version", "", "  enter continue \u00B7 esc skip"].join("\n");

  it("transcript and code-block quotes of the same lines stay unmatched", () => {
    const quoted = [
      `assistant: Historical screen, do not answer:\n${promptOnly}`,
      `assistant: Here is the previous update screen:\n\n${promptOnly}`,
      `user: what is this?\n\n${updateScreen}`,
      `\`\`\`text\n${promptOnly}`,
      `\`\`\`text\n\n${updateScreen}`,
      `~~~\n${updateScreen}`,
      `Codex showed this:\n\n${promptOnly}`,
      `\u2022 Codex printed\n\n${promptOnly}`,
      `> quoted\n\n${promptOnly}`,
      promptOnly.split("\n").map((row) => `> ${row}`).join("\n"),
      // Its first line missing, or too far up, or something other than the Release notes row between.
      fourLines,
      updateScreen.replace("  Release notes:", "  Some other line:"),
      updateScreen.replace("\n\n  Release notes:", "\n\nnote\n\n  Release notes:"),
    ];
    for (const text of quoted) expect(updateOf(text), text).toBeNull();
    // Genuine screens still read: the prompt alone at the read's top, updateScreen, listsCodexUpdateScreen.
    for (const text of [promptOnly, updateScreen, listsCodexUpdateScreen]) expect(updateOf(text)?.kind).toBe("codexUpdate");
    // A code block anywhere above it, closed or not, is conversation.
    expect(updateOf(`\`\`\`\ncode\n\`\`\`\n$ codex\n\n${updateScreen}`)).toBeNull();
    // A fence the nearest row above it: refused all the same (the conservative side).
    expect(updateOf(`\`\`\`\ncode\n\`\`\`\n\n${updateScreen}`)).toBeNull();
  });

  it("main sends no keys for update-shaped transcript text on a blocked Codex screen", async () => {
    for (const screen of [`assistant: Historical screen, do not answer:\n${promptOnly}`, `\`\`\`text\n${promptOnly}`]) {
      const context = await codexSetup([screen]);
      expect(readingMatch(context.prompt().reading!)).toBeNull();
      expect(context.keys()).toEqual([]);
    }
  });

  it("the re-read before a key holds the same rule: a genuine card answered against a transcript screen sends nothing", async () => {
    const shownMatch = updateOf(promptOnly)!;
    const sent: string[][] = [];
    for (const now of [`assistant: Historical screen, do not answer:\n${promptOnly}`, `\`\`\`text\n${promptOnly}`]) {
      const outcome = await answerPrompt({ read: async () => now, sendKeys: async (keys) => void sent.push([...keys]) }, shownMatch.options[0]!, shownMatch);
      expect(outcome.type).toBe("changed");
    }
    expect(sent).toEqual([]);
  });
});

// MARK: - Every row above the update prompt is one a real start shows

describe("nothing above the update prompt looks like conversation", () => {
  const promptOnly = ["Update available! 0.167.0 -> 0.168.0", "", "› 1. Update now (runs `npm install -g @openai/codex`)", "  2. Skip", "  3. Skip until next version", "", "  enter continue · esc skip"].join("\n");
  const speakerParagraph = `assistant: Here is the previous screen.\nThis is an example from earlier.\n\n${promptOnly}`;
  const bulletParagraph = `• Here is the previous screen.\n  This is an example from earlier.\n\n${promptOnly}`;
  const nestedFence = "````markdown\n```text\nexample\n\n" + promptOnly;
  const withNotes = promptOnly.replace("\n\n›", "\n\nRelease notes: https://github.com/openai/codex/releases/latest\n\n›");
  const underShell = `me@mini ~ % codex\n\n${withNotes}`;
  const underStart = `Last login: Thu Nov 12 01:50:11 on ttys001\nme@mini ~ % /opt/homebrew/bin/codex --yolo\n\n${listsCodexUpdateScreen}`;

  it.each([
    ["an assistant paragraph with a continuation row", speakerParagraph],
    ["a Codex reply of several rows", bulletParagraph],
    ["an open four-backtick fence holding a three-backtick line", nestedFence],
  ])("%s stays unmatched, and main sends no key", async (_name, screen) => {
    expect(updateOf(screen)).toBeNull();
    const context = await codexSetup([screen]);
    expect(context.prompt()?.reading === undefined || readingMatch(context.prompt().reading!) === null).toBe(true);
    expect(context.keys()).toEqual([]);
  });

  it("anything above it that is not a real start's row: unmatched", () => {
    const screens = [
      `• Done.\n\nme@mini ~ % codex\n\n${promptOnly}`,
      `user: show me\n\n\n\nme@mini ~ % codex\n\n${promptOnly}`,
      `\`\`\`\nclosed\n\`\`\`\n\n${promptOnly}`,
      `~~~~\nclosed\n~~~~\n\n${promptOnly}`,
      `› a prompt typed earlier\n\n${promptOnly}`,
      `Some plain row\n\n${promptOnly}`,
      `> quoted\n\nme@mini ~ % codex\n\n${promptOnly}`,
      `me@mini ~ % echo "codex"\n\n${promptOnly}`,
      `me@mini ~ % cx\n\n${promptOnly}`,
      // Codex's start cell cut at the read's top, or holding another row.
      `│ >_ OpenAI Codex (v0.167.0) │\n╰──╯\n\n${promptOnly}`,
      `╭──╮\n│ assistant: hi │\n╰──╯\n\n${promptOnly}`,
      `╭──╮\n│ >_ OpenAI Codex (v0.167.0) │\n\n${promptOnly}`,
    ];
    for (const screen of screens) expect(updateOf(screen), screen).toBeNull();
  });

  it("the genuine prompt with and without its Release notes row, under a shell prompt and its start command: three buttons, the same keys", async () => {
    for (const screen of [promptOnly, withNotes, updateScreen, listsCodexUpdateScreen, underShell, underStart, `user@host:~/code$ codex\n\n${promptOnly}`, `$ codex\n\n${promptOnly}`]) {
      const match = updateOf(screen);
      expect(match?.kind, screen).toBe("codexUpdate");
      expect(match!.options.map((option) => option.label)).toEqual(["Update now (runs `npm install -g @openai/codex`)", "Skip", "Skip until next version"]);
      expect(match!.options.map((option) => option.keys)).toEqual([["Enter"], ["Escape"], []]);
    }
    for (const screen of [promptOnly, withNotes, underShell]) {
      const context = await codexSetup([screen, "updating\n"]);
      expect(await context.service.answer(context.request("1"))).toMatchObject({ type: "sent" });
      expect(context.keys()).toEqual([["Enter"]]);
    }
  });

  it("a genuine card re-read against a multi-row transcript screen sends nothing (main, and the answerer)", async () => {
    for (const now of [bulletParagraph, speakerParagraph, nestedFence]) {
      const context = await codexSetup([promptOnly]);
      const request = context.request("1");
      show(context.herdr, "w1:p1", now);
      expect(await context.service.answer(request)).toMatchObject({ type: "changed" });
      expect(context.keys()).toEqual([]);
      const shown = updateOf(promptOnly)!;
      const sent: string[][] = [];
      expect((await answerPrompt({ read: async () => now, sendKeys: async (keys) => void sent.push([...keys]) }, shown.options[0]!, shown)).type).toBe("changed");
      expect(sent).toEqual([]);
    }
  });
});

// MARK: - The app's own Codex launch commands above the update prompt

describe("the update card shows under the app's own Codex start commands", () => {
  const promptOnly = ["Update available! 0.167.0 -> 0.168.0", "", "› 1. Update now (runs `npm install -g @openai/codex`)", "  2. Skip", "  3. Skip until next version", "", "  enter continue · esc skip"].join("\n");
  const codexModels = (() => {
    const parsed = parseCatalog("codex", demoModelLists.codex);
    if (!parsed.ok) throw new Error(parsed.reason);
    return parsed.models;
  })();
  const withEffort = codexModels.find((model) => model.efforts.length > 0)!;
  const effort = withEffort.efforts[0]!;

  /** What herdr-core's agent.start types for Codex, through the real client and bridge (FakeCore records it). */
  async function coreTyped(args: readonly string[]): Promise<string> {
    const core = new FakeCore([FakeCore.terminal("t2", { foreground: FakeCore.foreground("zsh", ["-zsh"], "/fixture") })]);
    const host = coreHost(new TUIFixtureTransport(), core);
    const client = new HerdrClient(host);
    try {
      await client.sessionTopology();
      await client.startAgent("codex", "codex", "hc:t2", args);
      return core.sent.at(-1)!.text as string;
    } finally {
      host.close();
      host.follower.close();
    }
  }

  /** What New agent types for a configured plain `codex` with a choice (typedStart, startFlags, typedFlags). */
  function newAgentTyped(choice: { model: string | null; effort: string | null }): string {
    const plan = typedStart(startCommandsWith({ type: "read" }, { codex: "codex" }), "codex");
    if (plan.type !== "typed") throw new Error("not typed");
    const flags = startFlags("codex", choice, codexModels);
    if (!flags.ok) throw new Error(flags.reason);
    return flags.flags.length === 0 ? plan.command : `${plan.command} ${typedFlags(flags.flags)}`;
  }

  it("the commands are the builders' own (pinned)", async () => {
    expect(await coreTyped(["--no-daemon"])).toBe("exec codex --no-daemon");
    expect(await coreTyped(["--no-daemon", "-m", withEffort.id, "-c", `model_reasoning_effort=${effort}`])).toBe(`exec codex --no-daemon -m '${withEffort.id}' -c 'model_reasoning_effort=${effort}'`);
    expect(newAgentTyped({ model: codexModels[0]!.id, effort: null })).toBe(`codex --no-daemon -m '${codexModels[0]!.id}'`);
    expect(newAgentTyped({ model: withEffort.id, effort })).toBe(`codex --no-daemon -m '${withEffort.id}' -c 'model_reasoning_effort=${effort}'`);
  });

  it("each, above the genuine prompt under a Mac shell prompt: three buttons, the same keys, Return sent by main", async () => {
    const commands = [
      await coreTyped(["--no-daemon"]),
      await coreTyped(["--no-daemon", "-m", withEffort.id, "-c", `model_reasoning_effort=${effort}`]),
      newAgentTyped({ model: null, effort: null }),
      newAgentTyped({ model: codexModels[0]!.id, effort: null }),
      newAgentTyped({ model: withEffort.id, effort }),
    ];
    for (const command of commands) {
      for (const screen of [`me@mini ~ % ${command}\n\n${promptOnly}`, `Last login: Thu Nov 12 01:50:11 on ttys001\nme@mini ~ % ${command}\n\n${listsCodexUpdateScreen}`]) {
        const match = updateOf(screen);
        expect(match?.kind, screen).toBe("codexUpdate");
        expect(match!.options.map((option) => option.keys)).toEqual([["Enter"], ["Escape"], []]);
        const context = await codexSetup([screen, "updating\n"]);
        expect(await context.service.answer(context.request("1"))).toMatchObject({ type: "sent" });
        expect(context.keys()).toEqual([["Enter"]]);
      }
    }
  });

  it("the two launch forms: the default herdr-core start and New agent's picked model", async () => {
    expect(updateOf(`me@mini ~ % ${await coreTyped(["--no-daemon"])}\n\n${promptOnly}`)?.kind).toBe("codexUpdate");
    expect(updateOf(`me@mini ~ % ${newAgentTyped({ model: codexModels[0]!.id, effort: null })}\n\n${promptOnly}`)?.kind).toBe("codexUpdate");
  });

  it("only those forms: other quoted words, other flags, another program after exec stay unmatched", () => {
    const rows = [
      "me@mini ~ % exec codex -m '$(touch x)'",
      "me@mini ~ % exec codex -m 'a'\"'\"'b'",
      "me@mini ~ % exec codex -m 'gpt`x`'",
      "me@mini ~ % exec codex -m 'gpt 5'",
      "me@mini ~ % exec codex -c 'model=other'",
      "me@mini ~ % exec codex -c 'model_reasoning_effort=High'",
      "me@mini ~ % exec codex --profile 'work'",
      "me@mini ~ % codex -m ''",
      "me@mini ~ % exec cx --no-daemon",
      "me@mini ~ % exec exec codex",
      "me@mini ~ % codex -m 'gpt-5' ; echo hi",
    ];
    for (const row of rows) expect(updateOf(`${row}\n\n${promptOnly}`), row).toBeNull();
  });

  it("conversation-shaped screens stay unmatched with the app's launch row among them, and main sends no key", async () => {
    const launch = await coreTyped(["--no-daemon"]);
    for (const prefix of [`• Here is the previous screen.\n  This is an example from earlier.\n\nme@mini ~ % ${launch}\n\n`, `assistant: Here is the screen.\nContinuation.\n\n$ ${launch}\n\n`, "````markdown\n```text\nexample\n\n", `\`\`\`text\nold\n\`\`\`\n$ ${launch}\n\n`]) {
      const screen = prefix + promptOnly;
      expect(updateOf(screen), screen).toBeNull();
      const context = await codexSetup([screen]);
      expect(context.keys()).toEqual([]);
    }
  });
});

// MARK: - A borrowed This Mac list where main's live picks check it

describe("This Mac's borrowed list is the one main's live pick checks", () => {
  it("Cursor's families on the other Mac are built from the borrowed list, and main's family check uses that list", async () => {
    const m = machines();
    m.remote.next.push(keychainFailure);
    const view = await m.catalogs.settled("mini", "cursor");
    expect(view.borrowed).toBe(line);
    const families = cursorFamilyRows(view.models);
    expect(families.length).toBeGreaterThan(0);
    const pickable = families.find((row) => row.note === undefined)!;
    expect(modelPickCommand({ agent: "cursor", model: pickable.id, effort: null }, view.models)).toEqual({ ok: true, command: `/model ${pickable.label}` });
    // A family in neither list: refused, nothing built.
    expect(modelPickCommand({ agent: "cursor", model: "zz-made-up-family", effort: null }, view.models).ok).toBe(false);
  });

  it("no This Mac list: the other Mac's own failure stands, no family to pick", async () => {
    const m = machines({ thisMac: null });
    m.remote.next.push(keychainFailure);
    const view = await m.catalogs.settled("mini", "cursor");
    expect(view.borrowed).toBeUndefined();
    expect(cursorFamilyRows(view.models)).toEqual([]);
  });
});

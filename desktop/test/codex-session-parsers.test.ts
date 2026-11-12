// Every place that reads a Codex
// session id from a command line reads `codex resume <id>` with
// `--no-daemon` before or after the id, and still refuses an id that is not
// valid: the chat locator's argv rule (sessionFromArgv) and herdr-core's
// (CoreAgentKind.session). Invented ids only.

import { describe, expect, it } from "vitest";

import { CoreAgentKind } from "../src/main/herdr/core-projection";
import type { CoreTerminal } from "../src/main/herdr/core-wire";
import { sessionFromArgv } from "../src/shared/chat/locator";

const id = "4d2f8b61-0c3e-4a7d-b9e5-6f1a2c3d4e5f";

/** A herdr-core terminal whose foreground program has `argv`. */
const terminal = (argv: readonly string[]): CoreTerminal => ({ foreground: { argv } }) as unknown as CoreTerminal;

const both = (argv: readonly string[]): [string | null, string | null] => [
  sessionFromArgv(argv, "codex")?.value ?? null,
  CoreAgentKind.session(terminal(argv), "codex")?.value ?? null,
];

describe("a Codex argv's session, --no-daemon before or after the id", () => {
  it("reads the id in every order Codex 0.167 takes", () => {
    for (const argv of [
      ["codex", "resume", id],
      ["codex", "resume", id, "--no-daemon"],
      ["codex", "resume", "--no-daemon", id],
      ["codex", "--no-daemon", "resume", id],
      ["codex", "--no-daemon", "resume", "--no-daemon", id],
      ["/opt/homebrew/bin/codex", "-m", "gpt-5.5", "resume", id, "--no-daemon"],
    ]) {
      expect(both(argv), argv.join(" ")).toEqual([id, id]);
    }
    expect(sessionFromArgv(["codex", "resume", "--no-daemon", id], "codex")).toEqual({ source: "herdr:codex", agent: "codex", kind: "id", value: id });
  });

  it("refuses an id that is not valid, another flag, and a resume with no id", () => {
    for (const argv of [
      ["codex", "resume"],
      ["codex", "resume", "--no-daemon"],
      ["codex", "--no-daemon"],
      ["codex", "--no-daemon", "resume", "--last"],
      ["codex", "resume", "--no-daemon", "--last"],
      ["codex", "resume", "--last", id],
      ["codex", "resume", "--no-daemon", "x"],
      ["codex", "resume", "--no-daemon", "bad/id/../../etc"],
      ["codex", "resume", "--no-daemon", "a b c"],
      ["codex", "resume", "--no-daemon", "a".repeat(200)],
      ["codex", "--no-daemon", "exec", id],
    ]) {
      expect(both(argv), argv.join(" ")).toEqual([null, null]);
    }
  });
});

// Antigravity CLI's own resume in argv (shared/chat/locator.ts sessionFromArgv): `agy --conversation <id>` and
// `agy --conversation=<id>` (the form agy 1.5.13 prints on quit) name the conversation, a UUID, as Herdr's
// integration names it (`herdr:antigravity_cli`). Today no caller on the Mac hands sessionForPane an argv for a pane
// (paneSession passes none), so a live pane still follows Herdr's id alone; this is the reading itself.

import { describe, expect, it } from "vitest";

import { sessionForPane, sessionFromArgv } from "../src/shared/chat/locator";

const id = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";

describe("agy's --conversation in argv", () => {
  it("both spellings name the conversation as Herdr's integration does", () => {
    for (const argv of [["agy", "--conversation", id], ["agy", `--conversation=${id}`], ["/usr/local/bin/agy", "--model", "x", `--conversation=${id}`]]) {
      expect(sessionFromArgv(argv, "antigravity")).toEqual({ source: "herdr:antigravity_cli", agent: "agy", kind: "id", value: id });
    }
  });

  it("no id, a word that is not a UUID, or -c / --continue: none", () => {
    for (const argv of [["agy"], ["agy", "--conversation"], ["agy", "--conversation=latest"], ["agy", "-c"], ["agy", "--continue"], ["agy", "--conversation=", id]]) {
      expect(sessionFromArgv(argv, "antigravity")).toBeNull();
    }
  });

  it("a pane given that argv opens that conversation", () => {
    expect(sessionForPane({ agent: "agy", cwd: "/tmp/demo/work" }, { argv: ["agy", `--conversation=${id}`] })?.ref).toEqual({ format: "antigravity", lookup: { kind: "id", id } });
  });
});

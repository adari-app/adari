// Cursor's agent starts as `cursor agent` (Cursor's own CLI shim: "Use 'cursor agent'
// or 'agent' to run the agent"; a Mac with only the Cursor app has `cursor`,
// which takes `agent`, and not the older `cursor-agent`). Its stock command,
// Settings' placeholder and save line, and its Resume say `cursor agent`; what
// a pane runs is read as Cursor's agent as `cursor-agent` or `cursor agent`,
// and `cursor` alone stays the editor. New agent's lines are as they were
// ("Herdr starts cursor"). A bare `agent` is not Cursor's (Grok Build installs
// `agent` beside `grok`, so on a Mac with both it can be Grok's), and
// Grok as `grok` or `grok-…` is still Grok.

import { describe, expect, it } from "vitest";

import { CoreAgentKind } from "../src/main/herdr/core-projection";
import { sessionFromArgv } from "../src/shared/chat/locator";
import { newAgentKinds } from "../src/shared/new-agent";
import { resumeCommand, resumeStartCommand, type PaneAgentMemory } from "../src/shared/pane-life";
import { absentStartCommands, cursorAgentCommand, editableStartKinds, parseStartCommands, startCommandsWith } from "../src/shared/start-commands";

const chatID = "3f2a9c1e-7b4d-4e8a-9c21-5d6e7f8a9b0c";
const memory = (followed: string): PaneAgentMemory => ({ kind: "cursor", followed, session: null }) as unknown as PaneAgentMemory;

describe("Cursor's agent starts as cursor agent", () => {
  it("the stock command, Settings' placeholder and the line it says after a save that clears the field", () => {
    expect(cursorAgentCommand).toBe("cursor agent");
    expect(editableStartKinds.find((entry) => entry.kind === "cursor")).toEqual({ kind: "cursor", name: "Cursor Agent", stock: "cursor agent" });
    expect(editableStartKinds.map((entry) => entry.stock)).toEqual(["claude", "codex", "grok", "cursor agent"]);
  });

  it("Resume types cursor agent --resume <chat id> when nothing is set; a set command is used as it is", () => {
    expect(resumeStartCommand("cursor", absentStartCommands)).toBe("cursor agent");
    expect(resumeCommand(memory(chatID), absentStartCommands)).toBe(`cursor agent --resume ${chatID}`);
    expect(resumeCommand(memory(chatID), startCommandsWith({ type: "read" }, { claude: "cl" }))).toBe(`cursor agent --resume ${chatID}`);
    expect(resumeCommand(memory(chatID), startCommandsWith({ type: "read" }, { cursor: "cursor-agent" }))).toBe(`cursor-agent --resume ${chatID}`);
    expect(resumeCommand(memory(chatID), startCommandsWith({ type: "read" }, { cursor: "agent --model gpt-5" }))).toBe(`agent --model gpt-5 --resume ${chatID}`);
  });

  it("New agent's lines are unchanged: Herdr starts cursor with no command; a set one is what runs", () => {
    const line = (commands: Parameters<typeof newAgentKinds>[0]) => newAgentKinds(commands).find((choice) => choice.kind === "cursor")?.detail;
    expect(line(absentStartCommands)).toBe("Herdr starts cursor");
    expect(line(null)).toBe("Herdr starts cursor");
    expect(line(parseStartCommands(new TextEncoder().encode('{"cursor": "cursor agent"}')))).toBe("Runs cursor agent");
    expect(newAgentKinds(absentStartCommands).find((choice) => choice.kind === "codex")?.detail).toBe("Herdr starts codex");
  });
});

describe("what a pane runs, read as Cursor's agent", () => {
  it("cursor-agent and cursor agent are Cursor's agent; cursor alone (the editor) and cursor with another word are not", () => {
    expect(CoreAgentKind.detectProcess("cursor-agent", ["cursor-agent", "--resume", chatID])).toBe("cursor");
    expect(CoreAgentKind.detectProcess(undefined, ["/Users/r/.local/bin/cursor-agent"])).toBe("cursor");
    expect(CoreAgentKind.detectProcess(undefined, ["cursor", "agent", "--resume", chatID])).toBe("cursor");
    expect(CoreAgentKind.detectProcess(undefined, ["/usr/local/bin/cursor", "agent"])).toBe("cursor");
    expect(CoreAgentKind.detectProcess("node", ["node", "/Users/r/.local/share/cursor-agent/versions/1/index.js"])).toBe("cursor");
    expect(CoreAgentKind.detectProcess(undefined, ["cursor"])).toBeUndefined();
    expect(CoreAgentKind.detectProcess(undefined, ["cursor", "."])).toBeUndefined();
    expect(CoreAgentKind.detectProcess("grok", ["grok"])).toBe("grok");
  });

  it("a bare agent is not Cursor's (Grok Build's agent link); Grok as grok or grok-… is still Grok", () => {
    for (const [name, argv] of [
      ["agent", ["agent"]],
      [undefined, ["agent", "--resume", chatID]],
      [undefined, ["/Users/r/.grok/bin/agent"]],
      ["agent", ["/Users/r/.grok/bin/agent", "--resume", chatID]],
      [undefined, ["/Users/r/.local/bin/agent", "-p", "hi"]],
    ] as const) {
      expect(CoreAgentKind.detectProcess(name, argv), argv.join(" ")).not.toBe("cursor");
    }
    const terminal = (name: string, argv: readonly string[]) => ({ state: "running", foreground: { name, argv, cwd: "/" } }) as never;
    expect(CoreAgentKind.detect(terminal("agent", ["agent", "--resume", chatID]))).toBeUndefined();
    expect(CoreAgentKind.detectProcess("grok", ["/Users/r/.grok/bin/grok", "-r", chatID])).toBe("grok");
    expect(CoreAgentKind.detectProcess(undefined, ["grok-build", "--resume", chatID])).toBe("grok");
    expect(CoreAgentKind.detectProcess("grok-1.4", ["grok-1.4"])).toBe("grok");
    expect(CoreAgentKind.detectProcess("cursor-agent", ["cursor-agent"])).toBe("cursor");
    expect(CoreAgentKind.detectProcess(undefined, ["cursor", "agent"])).toBe("cursor");
  });

  it("the chat id from each Cursor form's --resume, for herdr-core and for Chat's locator", () => {
    for (const argv of [
      ["cursor-agent", "--resume", chatID],
      ["cursor", "agent", "--resume", chatID],
      ["cursor", "agent", `--resume=${chatID}`],
    ]) {
      expect(CoreAgentKind.session({ foreground: { name: argv[0], argv } } as never, "cursor")?.value, argv.join(" ")).toBe(chatID);
      expect(sessionFromArgv(argv, "cursor")?.value, argv.join(" ")).toBe(chatID);
    }
    expect(CoreAgentKind.session({ foreground: { name: "cursor", argv: ["cursor", "agent", "--resume"] } } as never, "cursor")).toBeUndefined();
  });
});

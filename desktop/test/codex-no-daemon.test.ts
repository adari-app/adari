// Every Codex start Adari makes runs
// without Codex 0.167's shared background server (`--no-daemon`), so Codex's
// hooks run in the pane's own process and Herdr names the session for that
// pane: Herdr's start (`agent.start` args, Codex only), a typed start from
// ~/.adari/agents.json (the flag once, only for the program `codex`), Resume
// and restart (`codex resume <id> --no-daemon`, the flag once). Invented ids,
// a fake Herdr, no real connection.

import { describe, expect, it } from "vitest";

import { HerdrClient } from "../src/main/herdr/client";
import { newAgent, type NewAgentClock, type NewAgentHerdr } from "../src/main/herdr/new-agent";
import type { HerdrTransport } from "../src/main/herdr/transport";
import type { AgentInfo, AgentSessionInfo, TabCreation } from "../src/main/herdr/wire";
import { restartCommand } from "../src/shared/agent-restart";
import { newAgentKinds } from "../src/shared/new-agent";
import { resumeOffer, type PaneAgentMemory } from "../src/shared/pane-life";
import { absentStartCommands, editableStartKinds, parseStartCommands, typedStart, type AgentStartCommands } from "../src/shared/start-commands";

const encode = (text: string) => new TextEncoder().encode(text);
const commands = (json: string): AgentStartCommands => parseStartCommands(encode(json));
const id = "7c1e5a90-2b3d-4e8f-9a6b-0d1c2e3f4a5b";
const session = (agent: string): AgentSessionInfo => ({ source: `herdr:${agent}`, agent, kind: "id", value: id });
const exited = (kind: string): PaneAgentMemory => ({ kind, title: kind, terminalID: "term_fake1", session: session(kind) });
const count = (line: string, word: string): number => line.split(" ").filter((each) => each === word).length;

/** A fake Herdr for New agent: every call recorded, the new pane's agent reported once a command is typed. */
class StartHerdr implements NewAgentHerdr {
  readonly starts: { kind: string; args: readonly string[] | undefined; arity: number }[] = [];
  readonly typed: string[] = [];
  constructor(private readonly typedKind: string) {}
  agentList(): Promise<AgentInfo[]> {
    return Promise.resolve(this.typed.length > 0 ? [{ paneID: "w1:pn1", name: this.typedKind, agent: this.typedKind }] : []);
  }
  createTerminalTab(workspaceID: string, label: string | null): Promise<TabCreation> {
    return Promise.resolve({ tab: { tabID: "w1:tn1", workspaceID, label: label ?? "" }, rootPane: { paneID: "w1:pn1", workspaceID, tabID: "w1:tn1" } } as unknown as TabCreation);
  }
  startAgent(name: string, kind: string, paneID: string, ...rest: (readonly string[] | undefined)[]): Promise<AgentInfo> {
    this.starts.push({ kind, args: rest[0], arity: 3 + rest.length });
    return Promise.resolve({ paneID, name, agent: kind });
  }
  closePane(): Promise<void> {
    return Promise.resolve();
  }
  sendInput(_pane: string, text: string): Promise<void> {
    this.typed.push(text);
    return Promise.resolve();
  }
}

const clock: NewAgentClock = { now: () => 0, sleep: () => Promise.resolve() };

/** Herdr's socket as a recorder: each request kept, answered as Herdr answers agent.start. */
class Recorder implements HerdrTransport {
  readonly sent: { method: string; params: Record<string, unknown> }[] = [];
  roundTrip(line: string): Promise<string> {
    const request = JSON.parse(line) as { id: string; method: string; params: Record<string, unknown> };
    this.sent.push({ method: request.method, params: request.params });
    const agent = { pane_id: request.params["pane_id"], name: request.params["name"], agent: request.params["kind"], agent_status: "unknown" };
    return Promise.resolve(JSON.stringify({ id: request.id, result: { type: "agent_started", agent } }));
  }
  close(): void {}
}

describe("Herdr's start for Codex carries --no-daemon, and no other kind gets args", () => {
  it("New agent: agent.start for codex with [\"--no-daemon\"], every other kind without args", async () => {
    const codex = new StartHerdr("codex");
    await newAgent(codex, absentStartCommands, { workspaceId: "w1", folder: null, kind: "codex" }, clock);
    expect(codex.starts).toEqual([{ kind: "codex", args: ["--no-daemon"], arity: 4 }]);
    for (const kind of ["claude", "grok", "cursor", "pi", "opencode", "gemini"]) {
      const herdr = new StartHerdr(kind);
      await newAgent(herdr, absentStartCommands, { workspaceId: "w1", folder: null, kind }, clock);
      expect(herdr.starts, kind).toEqual([{ kind, args: undefined, arity: 3 }]);
    }
  });

  it("Codex in capitals is still Codex", async () => {
    const herdr = new StartHerdr("codex");
    await newAgent(herdr, absentStartCommands, { workspaceId: "w1", folder: null, kind: "Codex" }, clock);
    expect(herdr.starts[0]?.args).toEqual(["--no-daemon"]);
  });

  it("on the wire: agent.start's params have args only when given", async () => {
    const recorder = new Recorder();
    const client = new HerdrClient(recorder);
    await client.startAgent("codex", "codex", "w1:p9", ["--no-daemon"]);
    await client.startAgent("claude", "claude", "w1:p8");
    await client.startAgent("grok", "grok", "w1:p7", []);
    expect(recorder.sent).toEqual([
      { method: "agent.start", params: { name: "codex", kind: "codex", pane_id: "w1:p9", args: ["--no-daemon"] } },
      { method: "agent.start", params: { name: "claude", kind: "claude", pane_id: "w1:p8" } },
      { method: "agent.start", params: { name: "grok", kind: "grok", pane_id: "w1:p7" } },
    ]);
  });
});

describe("a Codex command from agents.json gets --no-daemon once, a non-codex program never", () => {
  it("typedStart: codex commands with the flag once; other programs and kinds as written", () => {
    const cases: [string, string, string][] = [
      ['{"codex": "codex"}', "codex", "codex --no-daemon"],
      ['{"codex": "codex -m gpt-5.5"}', "codex", "codex -m gpt-5.5 --no-daemon"],
      ['{"codex": "codex --no-daemon"}', "codex", "codex --no-daemon"],
      ['{"codex": "codex --no-daemon -m gpt-5.5"}', "codex", "codex --no-daemon -m gpt-5.5"],
      ['{"codex": "/opt/homebrew/bin/codex"}', "codex", "/opt/homebrew/bin/codex --no-daemon"],
      ['{"codex": "~/bin/codex -c model=o4"}', "codex", "~/bin/codex -c model=o4 --no-daemon"],
      ['{"codex": "CODEX_HOME=/tmp/fake codex"}', "codex", "CODEX_HOME=/tmp/fake codex --no-daemon"],
      ['{"codex": "cx"}', "codex", "cx"],
      ['{"codex": "codex-beta"}', "codex", "codex-beta"],
      ['{"codex": "npx codex"}', "codex", "npx codex"],
      ['{"codex": "mycodex"}', "codex", "mycodex"],
      ['{"claude": "codex"}', "claude", "codex"],
      ['{"claude": "cl"}', "claude", "cl"],
      ['{"grok": "grok --fast"}', "grok", "grok --fast"],
    ];
    for (const [file, kind, typed] of cases) {
      const plan = typedStart(commands(file), kind);
      expect(plan, `${file} ${kind}`).toEqual({ type: "typed", command: typed });
      expect(count(typed, "--no-daemon"), typed).toBeLessThanOrEqual(1);
    }
  });

  it("New agent types it so, and New agent's list says so", async () => {
    const herdr = new StartHerdr("codex");
    const file = commands('{"codex": "codex -m gpt-5.5", "claude": "cl"}');
    const result = await newAgent(herdr, file, { workspaceId: "w1", folder: null, kind: "codex" }, clock, 1_000, 10);
    expect(herdr.typed).toEqual(["codex -m gpt-5.5 --no-daemon"]);
    expect(herdr.starts).toEqual([]);
    expect(result.start).toEqual({ type: "typed", command: "codex -m gpt-5.5 --no-daemon" });
    const claude = new StartHerdr("claude");
    await newAgent(claude, file, { workspaceId: "w1", folder: null, kind: "claude" }, clock, 1_000, 10);
    expect(claude.typed).toEqual(["cl"]);
    const detail = newAgentKinds(file).find((choice) => choice.kind === "codex")?.detail;
    expect(detail).toBe("Runs codex -m gpt-5.5 --no-daemon");
  });
});

describe("Resume and restart lines for Codex carry the flag once", () => {
  it("the Resume chip", () => {
    expect(resumeOffer(exited("codex"), absentStartCommands)?.command).toBe(`codex resume ${id} --no-daemon`);
    expect(resumeOffer(exited("codex"), commands('{"codex": "codex -m gpt-5.5"}'))?.command).toBe(`codex -m gpt-5.5 resume ${id} --no-daemon`);
    expect(resumeOffer(exited("codex"), commands('{"codex": "codex --no-daemon"}'))?.command).toBe(`codex --no-daemon resume ${id}`);
    expect(resumeOffer(exited("codex"), commands('{"codex": "cx"}'))?.command).toBe(`cx resume ${id}`);
    // Other kinds as before.
    expect(resumeOffer(exited("claude"), absentStartCommands)?.command).toBe(`claude --resume ${id}`);
    expect(resumeOffer(exited("grok"), absentStartCommands)?.command).toBe(`grok --resume ${id}`);
  });

  it("restart's resume line", () => {
    expect(restartCommand("codex", session("codex"), absentStartCommands)).toBe(`codex resume ${id} --no-daemon`);
    expect(restartCommand("codex", session("codex"), commands('{"codex": "codex -c model=o4"}'))).toBe(`codex -c model=o4 resume ${id} --no-daemon`);
    expect(restartCommand("codex", session("codex"), commands('{"codex": "codex --no-daemon"}'))).toBe(`codex --no-daemon resume ${id}`);
    expect(restartCommand("codex", session("codex"), commands('{"codex": "cx"}'))).toBe(`cx resume ${id}`);
    expect(restartCommand("claude", session("claude"), absentStartCommands)).toBe(`claude --resume ${id}`);
    for (const line of [restartCommand("codex", session("codex"), absentStartCommands)!, resumeOffer(exited("codex"), absentStartCommands)!.command]) {
      expect(count(line, "--no-daemon"), line).toBe(1);
    }
  });
});

describe("Settings › Chat's Codex row", () => {
  it("keeps codex as its stock line, with the note that Adari adds --no-daemon", () => {
    const codex = editableStartKinds.find((entry) => entry.kind === "codex")!;
    expect(codex.stock).toBe("codex");
    expect(codex.note).toBe("Adari adds --no-daemon so Chat can find the session.");
    expect(codex.note).not.toMatch(/\u2014/);
    for (const entry of editableStartKinds.filter((each) => each.kind !== "codex")) expect(entry.note, entry.kind).toBeUndefined();
  });
});

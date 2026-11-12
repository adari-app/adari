// The Resume chip: the Swift app's pane-life rules
// (CompanionPaneLifeTests and AgentStartCommandsTests)
// ported to the desktop: the memory of the agent that left a pane, the Mac's
// start commands (read once per connection, a failed read asked again), the
// chip's command, and the chip in the shell box and over the terminal: a tap
// fills the box (never runs it), with text in the box it waits, it goes when
// the agent comes back.

import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import { DemoBackend } from "../src/main/demo/demo-backend";
import { startCommandsOf } from "../src/main/start-commands";
import type { HostView } from "../src/shared/ipc-contract";
import {
  PaneLife,
  plainCommandRefusal,
  resumeCommand,
  resumeOffer,
  resumeSessionID,
  resumeTitle,
  type PaneAgentMemory,
} from "../src/shared/pane-life";
import {
  absentStartCommands,
  parseStartCommands,
  startCommandRefusal,
  startCommandsWith,
  type AgentStartCommands,
} from "../src/shared/start-commands";
import type { SidebarRow } from "../src/shared/sidebar-model";
import { HookHost, elements } from "./support/fake-hooks";
import { paneTopology } from "./support/pane-topology";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  const hooks = { ...fakeReact, useLayoutEffect: fakeReact.useEffect };
  return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});

const claude = "0f2c9a6e-3b1d-4c5e-8f7a-9b0c1d2e3f4a";
const codex = "019a3c2e-7d41-7b20-9f3e-2c1d0e9f8a7b";
const encode = (text: string) => new TextEncoder().encode(text);
const file = (object: unknown) => parseStartCommands(encode(JSON.stringify(object)));
const cl = file({ claude: "cl" });
const memory = (kind = "claude", value: string | null = claude, sessionKind = "id"): PaneAgentMemory => ({
  kind,
  title: kind,
  terminalID: "t1",
  session: value === null ? null : { source: `herdr:${kind}`, agent: kind, kind: sessionKind, value },
});

describe("the Mac's start commands (agents.json)", () => {
  it("gives each kind its command; a kind not named keeps Herdr's default; no file is absent", () => {
    expect(cl.status).toEqual({ type: "read" });
    expect(cl.commands).toEqual({ claude: "cl" });
    expect(file({ claude: "cl", codex: "cx --profile work", grok: "gk" }).commands).toEqual({ claude: "cl", codex: "cx --profile work", grok: "gk" });
    expect(parseStartCommands(null)).toEqual(absentStartCommands);
  });

  it("does not read a malformed file and says so", () => {
    expect(parseStartCommands(encode("[1]")).status).toEqual({ type: "malformed", reason: 'it is not a JSON object such as {"claude": "cl"}' });
    expect(parseStartCommands(encode("{nope")).status.type).toBe("malformed");
    expect(parseStartCommands(new Uint8Array([0xff, 0xfe])).status).toEqual({ type: "malformed", reason: "it is not UTF-8 text" });
    expect(parseStartCommands(new Uint8Array(16 * 1024 + 1)).status).toEqual({ type: "malformed", reason: "it is larger than 16 KB" });
  });

  it("refuses a command over 64 characters, on several lines, with a control or an invisible character", () => {
    expect(startCommandRefusal("x".repeat(64))).toBeNull();
    expect(startCommandRefusal("é".repeat(64))).toBeNull();
    expect(startCommandRefusal("x".repeat(65))).toBe("its command is longer than 64 characters");
    for (const bad of ["cl\n", "cl\r", "cl x", "cl\u0085"]) expect(startCommandRefusal(bad)).toBe("its command has a line break");
    for (const bad of ["cl\tx", "cl\u0007", "cl\u001b[1m"]) expect(startCommandRefusal(bad)).toBe("its command has a control character");
    for (const bad of ["cl​", "cl‮"]) expect(startCommandRefusal(bad)).toBe("its command has an invisible formatting character");
    expect(startCommandRefusal("  ")).toBe("its command is empty");
    expect(file({ claude: 7 }).refused).toEqual({ claude: "its command is not text" });
  });

  it("is read once per connection, callers during the read join it, a failed read is asked again", async () => {
    let reads = 0;
    let fail = true;
    const mac = {
      readStartCommandsFile: () => {
        reads += 1;
        return fail ? Promise.reject(new Error("the Mac did not answer")) : Promise.resolve(encode('{"claude":"cl"}'));
      },
    };
    const first = await startCommandsOf(mac);
    expect(first.status).toEqual({ type: "unreadable", reason: "the Mac did not answer" });
    fail = false;
    const [a, b] = await Promise.all([startCommandsOf(mac), startCommandsOf(mac)]);
    expect(a).toBe(b);
    expect(a.commands).toEqual({ claude: "cl" });
    await startCommandsOf(mac);
    expect(reads).toBe(2);
    expect(await startCommandsOf({})).toEqual(absentStartCommands);
  });

  // The demo shows `claude`, Claude Code's own command, not a user's alias such as `cl`.
  it("is claude for Claude on the demo machines", async () => {
    const demo = new DemoBackend({ descriptor: { id: "d", name: "d", kind: "demo", address: "demo", platform: null }, snapshot: {}, transcripts: [] }, { heavy: "", idle: "", bashDialog: "" } as never);
    expect((await startCommandsOf(demo)).commands).toEqual({ claude: "claude" });
  });
});

describe("the Resume chip's command", () => {
  it("is cl --resume <id> for Claude with {\"claude\": \"cl\"}, titled with the session's first eight characters", () => {
    expect(resumeCommand(memory(), cl)).toBe(`cl --resume ${claude}`);
    expect(resumeTitle(memory())).toBe("Resume 0f2c9a6e");
  });

  it("is the kind's executable with no agents.json; never the executable for a file not read or a refused command", () => {
    expect(resumeCommand(memory(), absentStartCommands)).toBe(`claude --resume ${claude}`);
    expect(resumeCommand(memory("codex", codex), absentStartCommands)).toBe(`codex resume ${codex} --no-daemon`);
    expect(resumeCommand(memory(), startCommandsWith({ type: "malformed", reason: "it is not UTF-8 text" }))).toBeNull();
    expect(resumeCommand(memory(), startCommandsWith({ type: "unreadable", reason: "no answer" }))).toBeNull();
    expect(resumeCommand(memory(), startCommandsWith({ type: "read" }, {}, { claude: "its command has a control character" }))).toBeNull();
    expect(resumeCommand(memory(), file({ codex: "cx" }))).toBe(`claude --resume ${claude}`);
    expect(resumeCommand(memory(), null)).toBeNull();
  });

  it("is a configured Codex command of plain words and resume", () => {
    expect(resumeCommand(memory("codex", codex), file({ codex: "cx --profile work" }))).toBe(`cx --profile work resume ${codex}`);
    expect(resumeCommand(memory("codex", codex), file({ codex: "codex --yolo" }))).toBe(`codex --yolo resume ${codex} --no-daemon`);
  });

  it("takes the id a transcript path's file name ends with", () => {
    expect(resumeCommand(memory("claude", `/Users/fixture/.claude/projects/-Users-fixture-app/${claude}.jsonl`, "path"), cl)).toBe(`cl --resume ${claude}`);
    expect(resumeCommand(memory("codex", `/Users/fixture/.codex/sessions/2026/11/01/rollout-2026-11-01T14-36-12-${codex}.jsonl`, "path"), absentStartCommands)).toBe(
      `codex resume ${codex} --no-daemon`,
    );
    expect(resumeCommand(memory("codex", "/tmp/notes.jsonl", "path"), absentStartCommands)).toBeNull();
  });

  it("is nothing without a session, for another kind, or another session kind", () => {
    expect(resumeCommand(memory("claude", null), cl)).toBeNull();
    expect(resumeTitle(memory("claude", null))).toBeNull();
    // Cursor has its chip; gemini is the kind with none.
    expect(resumeCommand(memory("gemini", claude), cl)).toBeNull();
    expect(resumeCommand(memory("claude", claude, "url"), cl)).toBeNull();
  });

  it("is never anything with a line break or a control character", () => {
    for (const bad of [`${claude}\n`, `${claude}\nls`, "abc\u001b[200~defgh", "abcdefgh;ls", "abcdefgh ls", "\u0007abcdefgh"]) {
      expect(resumeCommand(memory("claude", bad), cl)).toBeNull();
    }
    for (const start of ["cl\n", "cl\u0007", "cl​", "cl\r"]) {
      expect(resumeCommand(memory(), startCommandsWith({ type: "read" }, { claude: start }))).toBeNull();
    }
  });

  it("fills only a plain command", () => {
    for (const start of ["cl", "codex --yolo", "cl --profile work", "~/bin/cl --model opus-5.5", "npx -y @openai/codex@latest", "cl --add-dir=/Users/fixture/app", "A=1 cl", "cl a,b:c+d"]) {
      expect(resumeCommand(memory(), file({ claude: start }))).toBe(`${start} --resume ${claude}`);
    }
    const refused = [
      "cl 'work'", 'cl "work"', "cl; echo x", "cl && echo x", "cl & echo", "cl | tee x", "cl > x", "cl < x",
      "cl $(echo x)", "cl `echo x`", "cl $HOME", "cl \\x", "cl (x)", "cl {a,b}", "cl [x]", "cl *", "cl x?",
      "cl !x", "cl #x", "cl  x", " cl", "cl ", "=cl", "cl =x", "~cl", "cl~", "~user/cl", "cl %x", "clé",
    ];
    for (const start of refused) expect(resumeCommand(memory(), file({ claude: start })), start).toBeNull();
    expect(plainCommandRefusal("cl; x")).toBe("has “;”, not allowed in a plain command");
  });
});

describe("the agent that left a pane", () => {
  const route = { id: "mini", address: "r@mini:22" };
  const host = (panes: Parameters<typeof paneTopology>[0], address = "r@mini:22") => ({ id: "mini", address, state: "connected" as const, topology: paneTopology(panes) });

  it("is remembered with its kind, terminal and last session, and shows only while no agent runs in its terminal", () => {
    const life = new PaneLife();
    life.observeHosts([host([{ id: "p1", agent: "claude", session: claude, terminal: "t1" }])]);
    life.observeHosts([host([{ id: "p1", agent: "claude", terminal: "t1" }])]);
    expect(life.memory(route, "p1")).toMatchObject({ kind: "claude", title: "Claude", terminalID: "t1", session: { value: claude } });
    const running = paneTopology([{ id: "p1", agent: "claude", terminal: "t1" }]);
    expect(life.exited(route, running.panes[0]!, running)).toBeNull();
    const after = paneTopology([{ id: "p1", terminal: "t1" }]);
    life.observeHosts([{ ...host([]), topology: after }]);
    expect(life.exited(route, after.panes[0]!, after)?.kind).toBe("claude");
    const other = paneTopology([{ id: "p1", terminal: "t9" }]);
    expect(life.exited(route, other.panes[0]!, other)).toBeNull();
  });

  it("starts afresh for another kind, and is never another machine's (an edited route)", () => {
    const life = new PaneLife();
    life.observeHosts([host([{ id: "p1", agent: "claude", session: claude }])]);
    life.observeHosts([host([{ id: "p1", agent: "codex" }])]);
    expect(life.memory(route, "p1")).toMatchObject({ kind: "codex", session: null });
    life.observeHosts([host([{ id: "p1", agent: "claude", session: claude }], "r@other:22")]);
    expect(life.memory(route, "p1")).toBeNull();
  });
});

// MARK: the chip on screen

const { Composer, MainPane } = await import("../src/renderer/components/MainPane");
const { handoffStore } = await import("../src/renderer/handoff/handoff-state");
const { composerDrafts } = await import("../src/renderer/components/composer-drafts");
const { startCommandsStore } = await import("../src/renderer/components/resume");

describe("the chip in the shell box and over the terminal", () => {
  afterEach(() => {
    handoffStore.reset();
    composerDrafts.clear();
    startCommandsStore.clear();
    vi.unstubAllGlobals();
  });

  const view = (panes: Parameters<typeof paneTopology>[0]): HostView => ({
    id: "mini",
    name: "Mac mini",
    kind: "ssh",
    address: "r@mini:22",
    platform: null,
    state: "connected",
    error: null,
    fetchedAtMs: 0,
    topology: paneTopology(panes),
  });
  const shellRow = { paneID: "p1", name: "zsh", kind: "shell", workspaceLabel: "app", isAgent: false, glyph: "shell", cwd: "/fixture" } as unknown as SidebarRow;
  const flush = async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  };

  function setup(commands: AgentStartCommands = cl) {
    const sends: unknown[] = [];
    const asked: string[] = [];
    vi.stubGlobal("window", {
      herdrDesktop: {
        startCommands: (hostId: string) => {
          asked.push(hostId);
          return Promise.resolve(commands);
        },
        sendToPane: (...args: unknown[]) => {
          sends.push(args);
          return Promise.resolve();
        },
      },
    });
    handoffStore.setHosts([view([{ id: "p1", agent: "claude", session: claude }])]);
    const exited = view([{ id: "p1" }]);
    handoffStore.setHosts([exited]);
    return { sends, asked, exited };
  }
  const chip = (tree: unknown) => elements(tree).find((e) => e.type === "ResumeChip" || (typeof e.type === "function" && (e.type as { name: string }).name === "ResumeChip"));

  it("offers Resume once the start commands are read; a tap fills the box with cl --resume <id> and sends nothing", async () => {
    const t = setup();
    const box = new HookHost(Composer as (props: object) => unknown, { host: t.exited, row: shellRow });
    box.render();
    expect(t.asked).toEqual(["mini"]);
    await flush();
    box.render();
    const shown = chip(box.tree)!;
    expect(shown.props["offer"]).toEqual({ title: "Resume 0f2c9a6e", command: `cl --resume ${claude}` });
    expect(shown.props["boxEmpty"]).toBe(true);
    expect(elements(box.tree).find((e) => e.type === "textarea")!.props["placeholder"]).toBe("Run a command");
    (shown.props["onFill"] as () => void)();
    expect(composerDrafts.get("mini/p1").text).toBe(`cl --resume ${claude}`);
    expect(t.sends).toEqual([]);
  });

  // The floating box (pointer-events off but on its card) keeps the chip above it, and clickable.
  it("shows in the floating box over Chat too, above the card, and takes clicks there", async () => {
    const t = setup();
    const box = new HookHost(Composer as (props: object) => unknown, { host: t.exited, row: shellRow, floating: true, onHeight: () => undefined });
    box.render();
    await flush();
    box.render();
    const wrap = elements(box.tree).find((e) => String(e.props["className"] ?? "").startsWith("cmp-wrap"))!;
    expect(wrap.props["className"]).toBe("cmp-wrap float");
    const children = (wrap.props["children"] as unknown[]).flat().filter((c) => c !== null && c !== false) as { props: Record<string, unknown> }[];
    expect(children.map((c) => c.props["className"])).toEqual(["resume-row", "cmp"]);
    expect(chip(box.tree)).toBeDefined();
    const css = readFileSync(new URL("../src/renderer/styles/app.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.cmp-wrap\.float\s*\{[^}]*pointer-events:\s*none/);
    expect(css).toMatch(/\.cmp-wrap\.float > \.resume-row > \.resume\s*\{\s*pointer-events:\s*auto/);
  });

  it("waits while the box holds text, never writing over it", async () => {
    const t = setup();
    composerDrafts.edit("mini/p1", "claude update");
    const box = new HookHost(Composer as (props: object) => unknown, { host: t.exited, row: shellRow });
    box.render();
    await flush();
    box.render();
    const shown = chip(box.tree)!;
    expect(shown.props["boxEmpty"]).toBe(false);
    (shown.props["onFill"] as () => void)();
    expect(composerDrafts.get("mini/p1").text).toBe("claude update");
  });

  it("goes when the agent comes back, and shows no chip when the start commands refuse it", async () => {
    const t = setup();
    const back = view([{ id: "p1", agent: "claude", session: claude }]);
    handoffStore.setHosts([back]);
    const box = new HookHost(Composer as (props: object) => unknown, { host: back, row: shellRow });
    box.render();
    await flush();
    box.render();
    expect(chip(box.tree)).toBeUndefined();
    expect(t.sends).toEqual([]);
    handoffStore.reset();
    startCommandsStore.clear();
    const u = setup(startCommandsWith({ type: "malformed", reason: "it is not UTF-8 text" }));
    const refused = new HookHost(Composer as (props: object) => unknown, { host: u.exited, row: shellRow });
    refused.render();
    await flush();
    refused.render();
    expect(chip(refused.tree)).toBeUndefined();
  });

  it("floats over the terminal while its box is hidden; a tap brings the box up holding the command", async () => {
    const t = setup();
    vi.stubGlobal("window", { ...(globalThis as unknown as { window: object }).window, herdrDesktop: { startCommands: () => Promise.resolve(cl) } });
    const shown: boolean[] = [];
    const pane = new HookHost(MainPane as (props: object) => unknown, {
      host: t.exited,
      row: shellRow,
      tab: "terminal",
      onTab: () => undefined,
      mac: true,
      fontSize: 13,
      boxShown: false,
      onBoxShown: (value: boolean) => shown.push(value),
      ghostty: { shown: false },
      onOpenInGhostty: () => undefined,
    });
    pane.render();
    await flush();
    pane.render();
    const floating = chip(pane.tree)!;
    expect(floating.props["floating"]).toBe(true);
    (floating.props["onFill"] as () => void)();
    expect(composerDrafts.get("mini/p1").text).toBe(`cl --resume ${claude}`);
    expect(shown).toEqual([true]);
  });

  it("is offered for the agent that left and its commands, nothing for a pane that never ran one", () => {
    expect(resumeOffer(null, cl)).toBeNull();
    expect(resumeOffer(memory(), cl)).toEqual({ title: "Resume 0f2c9a6e", command: `cl --resume ${claude}` });
  });
});

// MARK: - A resume id is a session id

describe("the chip resumes only a session id (a UUID), never an option", () => {
  it.each(["--latest", "-c", "--last", "-abcdefgh", "--resume", "latest", "abcdefgh", "0f2c9a6e3b1d4c5e8f7a9b0c1d2e3f4a", `${claude}x`, `-${claude}`, `${claude.slice(0, 35)}g`])(
    "%j forms no command and no chip",
    (value) => {
      expect(resumeSessionID({ source: "herdr:codex", agent: "codex", kind: "id", value })).toBeNull();
      expect(resumeCommand(memory("codex", value), absentStartCommands)).toBeNull();
      expect(resumeCommand(memory("claude", value), cl)).toBeNull();
      expect(resumeOffer(memory("claude", value), cl)).toBeNull();
    },
  );

  it("Claude's and Codex's session UUIDs (any case), as ids or at the end of a transcript's file name, still resume", () => {
    expect(resumeCommand(memory("claude", claude), cl)).toBe(`cl --resume ${claude}`);
    expect(resumeCommand(memory("codex", codex.toUpperCase()), absentStartCommands)).toBe(`codex resume ${codex.toUpperCase()} --no-daemon`);
    expect(resumeSessionID({ source: "herdr:codex", agent: "codex", kind: "path", value: `/fixture/rollout-2026-11-01T14-36-12-${codex}.jsonl` })).toBe(codex);
    expect(resumeSessionID({ source: "herdr:codex", agent: "codex", kind: "path", value: "/fixture/rollout---latest.jsonl" })).toBeNull();
  });
});

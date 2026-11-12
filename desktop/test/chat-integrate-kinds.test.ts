// kinds.ts is one list of every kind Chat reads (claude, codex, grok, cursor and the other readers);
// every kind Herdr reports (its `agent_label`s, src/shared/agent-names.ts) is either one of those, opening
// on Chat, or falls back to its own screen with the one Chat line (pane-view.ts defaultView,
// chat/unread.ts). A kept pick still wins.
// Hermes, Mastra Code and Cline read through the store registry. Antigravity (agy) reads (its steps,
// chat-antigravity-parser.test.ts). Maki and Kiro CLI fall back for 0.1.0 (their readers stay; Chat's service
// follows nothing for them, chat-integrate-boundaries.test.ts, chat-kiro-feed.test.ts), so Chat reads 16 kinds
// plus agy and the rest fall back.
// kinds.ts and the locator agree: a listed kind binds a session by at least one route (Herdr's report, its
// argv or its folder); any other kind Herdr reports binds none.

import { describe, expect, it } from "vitest";

import { agentGlyphShape, agentName } from "../src/renderer/components/agent-kind";
import { agentKinds, knownAgentName } from "../src/shared/agent-names";
import { chatKinds, chatReadKinds, chatReads, chatReadsKind, chatStoreKinds, readsChat } from "../src/shared/chat/kinds";
import { sessionForPane, type AgentPaneLike } from "../src/shared/chat/locator";
import { chatUnreadLine } from "../src/shared/chat/unread";
import { newAgentKinds } from "../src/shared/new-agent";
import { defaultView, PaneViews, paneViewsKey, type ViewStorage } from "../src/shared/pane-view";

/** Every kind Herdr reports (agent-names.ts follows Herdr's agent_label, src/detect/mod.rs:124-151). */
const herdrKinds = agentKinds.map((entry) => entry.kind);

/** The kinds Chat reads, in kinds.ts order. */
const readerKinds = [
  "claude",
  "codex",
  "grok",
  "cursor",
  "pi",
  "omp",
  "opencode",
  "kilo",
  "gemini",
  "qwen",
  "agy",
  "copilot",
  "droid",
  "kimi",
  "hermes", // the store registry
  "mastracode", // the store registry
  "cline", // the store registry
];

/** The kinds Herdr reports that Chat does not read: each falls back to its own screen. */
const fallbackKinds = ["amp", "devin", "kiro", "letta", "maki", "muse", "qodercli"];
/** The fallback kinds with no reader at all (Maki's and Kiro's readers stay in the locator). */
const readerless = ["amp", "devin", "letta", "muse", "qodercli"];

const folder = "/Users/fixture/integrate";
const uuid = "0192f3a4-5b6c-7d8e-9f01-23456789abcd";

/** One way each reader kind's pane binds (synthetic ids in each format's shape). */
const bindings: Readonly<Record<string, AgentPaneLike & { readonly argv?: readonly string[] }>> = {
  claude: { agentSession: { source: "herdr:claude", agent: "claude", kind: "id", value: uuid } },
  codex: { agentSession: { source: "herdr:codex", agent: "codex", kind: "id", value: uuid } },
  grok: {},
  cursor: {},
  pi: { agentSession: { source: "herdr:pi", agent: "pi", kind: "path", value: `/Users/fixture/.pi/agent/sessions/--Users-fixture-integrate--/2026-11-09T10-00-00-000Z_${uuid}.jsonl` } },
  omp: { agentSession: { source: "herdr:omp", agent: "omp", kind: "path", value: `/Users/fixture/.omp/agent/sessions/-integrate/2026-11-09T10-00-00-000Z_${uuid}.jsonl` } },
  opencode: { agentSession: { source: "herdr:opencode", agent: "opencode", kind: "id", value: "ses_0123456789abABCDEFGHIJKLMN" } },
  kilo: { agentSession: { source: "herdr:kilo", agent: "kilo", kind: "id", value: "ses_0123456789abABCDEFGHIJKLMN" } },
  gemini: {},
  qwen: { agentSession: { source: "herdr:qwen", agent: "qwen", kind: "id", value: uuid } },
  copilot: { agentSession: { source: "herdr:copilot", agent: "copilot", kind: "id", value: uuid } },
  droid: { agentSession: { source: "herdr:droid", agent: "droid", kind: "id", value: uuid } },
  kimi: { agentSession: { source: "herdr:kimi", agent: "kimi", kind: "id", value: `session_${uuid}` } },
  hermes: { agentSession: { source: "herdr:hermes", agent: "hermes", kind: "id", value: uuid } }, // by Herdr's id only
  mastracode: { agentSession: { source: "herdr:mastracode", agent: "mastracode", kind: "id", value: uuid } }, // by Herdr's id only
  cline: {}, // by its folder only (Herdr reports no Cline session)
  agy: { agentSession: { source: "herdr:antigravity_cli", agent: "agy", kind: "id", value: "7e1f0a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b" } }, // by Herdr's id only
};

class MemoryStorage implements ViewStorage {
  readonly items = new Map<string, string>();
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
  removeItem(key: string): void {
    this.items.delete(key);
  }
}

describe("kinds.ts", () => {
  it("is one list of every kind a reader reads, plus claude, codex, grok and cursor", () => {
    expect([...chatKinds]).toEqual(readerKinds);
    expect(new Set(chatKinds).size).toBe(chatKinds.length);
    // Each alias of the helpers reads the same list.
    expect(chatReadKinds).toBe(chatKinds);
    // The store registry's own list is the same three kinds, read from the one list.
    expect([...chatStoreKinds]).toEqual(["hermes", "mastracode", "cline"]);
    for (const kind of chatStoreKinds) expect(chatKinds, kind).toContain(kind);
    for (const kind of [...herdrKinds, "aider", "", "shell"]) {
      expect(readsChat(kind), kind).toBe(chatReads(kind));
      expect(chatReadsKind(kind), kind).toBe(chatReads(kind));
    }
  });

  it("splits Herdr's kinds: every one reads (Chat) or falls back (its own screen), never both, never neither", () => {
    expect(herdrKinds).toHaveLength(24);
    for (const kind of chatKinds) expect(herdrKinds, kind).toContain(kind);
    expect(herdrKinds.filter((kind) => !chatReads(kind)).sort()).toEqual(fallbackKinds);
    expect(readerKinds.length + fallbackKinds.length).toBe(herdrKinds.length);
  });

  it("names and draws every kind a reader reads, and New agent lists each", () => {
    const listed = newAgentKinds(null).map((choice) => choice.kind);
    for (const kind of herdrKinds) {
      expect(knownAgentName(kind), kind).not.toBeNull();
      expect(agentGlyphShape(kind), kind).not.toBe("agent");
      expect(listed, kind).toContain(kind);
    }
  });
});

describe("the default view of a kind Chat reads", () => {
  it("is Chat, with no Chat line", () => {
    for (const kind of chatKinds) {
      expect(defaultView({ paneID: "w1:p1", isAgent: true, kind }), kind).toBe("chat");
      expect(defaultView({ paneID: "w1:p1", isAgent: true, kind: kind.toUpperCase() }), kind).toBe("chat");
      expect(chatUnreadLine(true, kind), kind).toBeNull();
      expect(new PaneViews(new MemoryStorage()).view("mini", { paneID: "w1:p1", isAgent: true, kind }), kind).toBe("chat");
    }
  });
});

describe("the default view of every other kind Herdr reports", () => {
  it("is the agent's own screen, and its Chat tab says Chat doesn't read it", () => {
    for (const kind of fallbackKinds) {
      const name = agentName(kind);
      expect(defaultView({ paneID: "w1:p1", isAgent: true, kind }), kind).toBe("terminal");
      expect(new PaneViews(new MemoryStorage()).view("mini", { paneID: "w1:p1", isAgent: true, kind }), kind).toBe("terminal");
      expect(chatUnreadLine(true, kind), kind).toBe(`Chat doesn't read ${name}'s sessions yet. Its own screen is on the ${name} tab.`);
    }
    expect(chatUnreadLine(true, "amp")).toBe("Chat doesn't read Amp's sessions yet. Its own screen is on the Amp tab.");
    expect(chatUnreadLine(true, "qodercli")).toBe("Chat doesn't read Qoder CLI's sessions yet. Its own screen is on the Qoder CLI tab.");
  });

  it("is the same for a kind Herdr does not report, by its capitalised name; a shell and a pane with no kind keep theirs", () => {
    expect(defaultView({ paneID: "w1:p1", isAgent: true, kind: "aider" })).toBe("terminal");
    expect(chatUnreadLine(true, "aider")).toBe("Chat doesn't read Aider's sessions yet. Its own screen is on the Aider tab.");
    expect(defaultView({ paneID: "w1:p1", isAgent: false, kind: "shell" })).toBe("terminal");
    expect(chatUnreadLine(false, "shell")).toBeNull();
    expect(defaultView({ paneID: "w1:p1", isAgent: true })).toBe("chat");
  });
});

describe("a kept pick", () => {
  it("still wins over either default, across a restart", () => {
    const storage = new MemoryStorage();
    const views = new PaneViews(storage);
    const reader = { paneID: "w1:p1", isAgent: true, kind: "kimi" };
    const fallback = { paneID: "w1:p2", isAgent: true, kind: "amp" };
    expect(views.view("mini", reader)).toBe("chat");
    expect(views.view("mini", fallback)).toBe("terminal");
    views.pick("mini", reader, "terminal");
    views.pick("mini", fallback, "chat");
    expect(views.view("mini", reader)).toBe("terminal");
    expect(views.view("mini", fallback)).toBe("chat");
    const again = new PaneViews(storage);
    expect(again.view("mini", reader)).toBe("terminal");
    expect(again.view("mini", fallback)).toBe("chat");
    expect(JSON.parse(storage.getItem(paneViewsKey)!)).toEqual({ "mini|w1:p1": "terminal", "mini|w1:p2": "chat" });
  });

  it("wins for every kind, read or not", () => {
    const views = new PaneViews(new MemoryStorage());
    for (const kind of herdrKinds) {
      const pane = { paneID: `w1:${kind}`, isAgent: true, kind };
      const other = chatReads(kind) ? "terminal" : "chat";
      views.pick("mini", pane, other);
      expect(views.view("mini", pane), kind).toBe(other);
    }
  });
});

describe("kinds.ts and the locator agree", () => {
  it("binds a pane of each kind Chat reads by at least one route", () => {
    for (const kind of chatKinds) {
      const { argv, ...pane } = bindings[kind] ?? {};
      const session = sessionForPane({ agent: kind, cwd: folder, ...pane }, argv === undefined ? {} : { argv });
      expect(session, kind).not.toBeNull();
    }
  });

  it("binds none for a kind Herdr reports that no reader reads: by a report, an argv or a folder", () => {
    for (const kind of readerless) {
      const pane: AgentPaneLike = { agent: kind, cwd: folder, agentSession: { source: `herdr:${kind}`, agent: kind, kind: "id", value: uuid } };
      expect(sessionForPane(pane, { argv: [kind, "--resume", uuid] }), kind).toBeNull();
      expect(sessionForPane({ agent: kind, cwd: folder }), kind).toBeNull();
    }
  });
});

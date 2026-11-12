// Chat names the kinds it supports (Claude Code and Codex) and marks every other kind it reads Early: the pane's
// Chat tab (a split tile's header), New agent's list, Settings' agents (integrations and start commands) and one
// plain line at the top of an early kind's empty Chat. A supported kind shows nothing new; a kind Chat doesn't read
// keeps its own line. Grok Build, Cursor Agent and OpenCode carry the Early badge and line where the other early kinds
// do (their Chat, chips and Model picks are unchanged: livepick-main.test.ts and their own tests cover those).
// Antigravity CLI is early (Gemini CLI is deprecated in its favour) and takes Gemini CLI's place in New agent's first
// list; Gemini CLI stays startable after it by name, "Gemini CLI (deprecated)".

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  const hooks = { ...fakeReact, useLayoutEffect: fakeReact.useEffect };
  return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});

import { decodeSessionTopology } from "../src/main/herdr/wire";
import { agentKinds } from "../src/shared/agent-names";
import { chatEarly, chatEarlyLabel, chatEarlyText, chatKinds, chatReads, chatSupport, chatSupportedKinds } from "../src/shared/chat/kinds";
import { emptyTimeline } from "../src/shared/chat/model";
import { chatUnreadLine } from "../src/shared/chat/unread";
import type { IntegrationItem } from "../src/shared/integrations";
import type { HostView } from "../src/shared/ipc-contract";
import { coreStartKinds, herdrAppFirst, newAgentKinds, newAgentPlaces } from "../src/shared/new-agent";
import type { SidebarRow } from "../src/shared/sidebar-model";
import { absentStartCommands } from "../src/shared/start-commands";
import { timelineOf, user } from "./support/chat-lines";
import { HookHost, elements } from "./support/fake-hooks";
import { loadSettings, mountSettings, settingsBridge, sshHost } from "./support/settings-page";

const { ChatEarlyBadge } = await import("../src/renderer/components/agent-kind");
const { MainPane } = await import("../src/renderer/components/MainPane");
const { Tile } = await import("../src/renderer/split/SplitView");
const { NewAgentDialog } = await import("../src/renderer/components/NewAgentDialog");
const { IntegrationsLine, integrationNotes } = await import("../src/renderer/components/integrations");
const { ChatView } = await import("../src/renderer/chat/ChatView");
const { pendingMessages } = await import("../src/renderer/chat/chat-state");
const { startCommandsStore } = await import("../src/renderer/components/resume");
await loadSettings();

const supported = ["claude", "codex"];
/** Grok Build, Cursor Agent and OpenCode: Chat reads them, early. */
const nowEarly = ["grok", "cursor", "opencode"];
const early = [...nowEarly, "pi", "omp", "kilo", "gemini", "qwen", "agy", "copilot", "droid", "kimi", "hermes", "mastracode", "cline"];
/** Kinds Herdr reports that Chat doesn't read (Amp, Devin, Kiro, Letta, Maki, Muse, Qoder): neither. */
const unread = agentKinds.map((entry) => entry.kind).filter((kind) => !chatKinds.includes(kind));

type Element = { type: unknown; props: Record<string, unknown> };

/** Each Early badge element in a tree, as its kind and what it draws (its title, or null: nothing drawn). */
function badges(tree: unknown): { kind: unknown; title: string | null }[] {
  return elements(tree)
    .filter((element) => element.type === ChatEarlyBadge)
    .map((element) => {
      const drawn = ChatEarlyBadge(element.props as { kind: string }) as Element | null;
      return { kind: element.props["kind"], title: drawn === null ? null : (drawn.props["title"] as string) };
    });
}
const shown = (tree: unknown): string[] => badges(tree).flatMap((badge) => (badge.title === null ? [] : [badge.title]));

const text = (node: unknown): string => {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  if (typeof node === "object" && node !== null && "props" in node) return text((node as Element).props["children"]);
  return "";
};

afterEach(() => {
  startCommandsStore.clear();
  pendingMessages.clear();
  integrationNotes.reset();
  vi.unstubAllGlobals();
});

describe("one list of the kinds Chat supports, beside chatKinds", () => {
  it("the two are supported, the fifteen others Chat reads (Grok Build, Cursor Agent, OpenCode and Antigravity CLI among them) are early, and the two lists make chatKinds", () => {
    expect([...chatSupportedKinds]).toEqual(supported);
    expect(early).toHaveLength(15);
    for (const kind of supported) expect(chatSupport(kind), kind).toBe("supported");
    for (const kind of early) expect(chatSupport(kind), kind).toBe("early");
    expect([...supported, ...early].sort()).toEqual([...chatKinds].sort());
    expect(early.every(chatEarly)).toBe(true);
    expect(supported.some(chatEarly)).toBe(false);
  });

  it("a kind Chat doesn't read is neither, and keeps its own Chat line", () => {
    expect(unread.length).toBeGreaterThan(0);
    for (const kind of [...unread, "aider", "", null, undefined]) {
      expect(chatSupport(kind), String(kind)).toBeNull();
      expect(chatEarly(kind)).toBe(false);
      expect(chatEarlyText(kind)).toBeNull();
    }
    expect(chatUnreadLine(true, "amp")).toBe("Chat doesn't read Amp's sessions yet. Its own screen is on the Amp tab.");
  });

  it("any case, and an alias as the kind it names (github-copilot is Copilot: early)", () => {
    expect(chatSupport("Claude")).toBe("supported");
    expect(chatSupport("CODEX")).toBe("supported");
    expect(chatSupport("AGY")).toBe("early");
    expect(chatSupport("github-copilot")).toBe("early");
    expect(chatReads("github-copilot")).toBe(true);
  });

  it("the badge's word and title, by the agent's own name (Gemini CLI's pane keeps its name)", () => {
    expect(chatEarlyLabel).toBe("Early");
    expect(chatEarlyText("gemini")).toBe("Chat for Gemini CLI is early. It can miss things; the Terminal is always exact.");
    expect(chatEarlyText("qwen")).toBe("Chat for Qwen Code is early. It can miss things; the Terminal is always exact.");
    expect(chatEarlyText("agy")).toBe("Chat for Antigravity CLI is early. It can miss things; the Terminal is always exact.");
    expect(chatEarlyText("codex")).toBeNull();
    expect(chatEarlyText("amp")).toBeNull();
  });

  it("the badge draws for an early kind only: small text, its title, no em dash", () => {
    const drawn = ChatEarlyBadge({ kind: "copilot" }) as Element;
    expect(drawn.props["className"]).toBe("early-b");
    expect(drawn.props["children"]).toBe("Early");
    expect(drawn.props["title"]).toBe("Chat for GitHub Copilot is early. It can miss things; the Terminal is always exact.");
    expect(String(drawn.props["title"])).not.toContain("—");
    for (const kind of [...supported, ...unread, undefined]) expect(ChatEarlyBadge({ kind }), String(kind)).toBeNull();
  });
});

describe("Grok Build, Cursor Agent and OpenCode are Early", () => {
  it("each is early, its badge says Early with its own name in the title, and Claude Code and Codex stay supported", () => {
    expect(chatSupport("claude")).toBe("supported");
    expect(chatSupport("codex")).toBe("supported");
    expect(chatEarlyText("grok")).toBe("Chat for Grok Build is early. It can miss things; the Terminal is always exact.");
    expect(chatEarlyText("cursor")).toBe("Chat for Cursor Agent is early. It can miss things; the Terminal is always exact.");
    expect(chatEarlyText("opencode")).toBe("Chat for OpenCode is early. It can miss things; the Terminal is always exact.");
    for (const kind of nowEarly) {
      expect(chatSupport(kind), kind).toBe("early");
      expect(chatSupport(kind.toUpperCase()), kind).toBe("early");
      const drawn = ChatEarlyBadge({ kind }) as Element;
      expect(drawn.props["children"], kind).toBe("Early");
      expect(drawn.props["title"], kind).toBe(chatEarlyText(kind));
    }
  });
});

describe("New agent: Antigravity CLI takes Gemini CLI's place", () => {
  it("Antigravity CLI in the first list where Gemini CLI was; Gemini CLI after it by name, named deprecated", () => {
    expect([...herdrAppFirst]).toEqual(["claude", "codex", "pi", "opencode", "cursor", "copilot", "amp", "agy", "grok"]);
    const kinds = newAgentKinds(absentStartCommands);
    const order = kinds.map((choice) => choice.kind);
    expect(order.slice(0, 9)).toEqual([...herdrAppFirst]);
    expect(order.indexOf("gemini")).toBeGreaterThan(order.indexOf("agy"));
    // By name among the rest: after Factory Droid, before Hermes Agent.
    expect(order.slice(order.indexOf("droid"), order.indexOf("hermes") + 1)).toEqual(["droid", "gemini", "hermes"]);
    expect(kinds.find((choice) => choice.kind === "gemini")).toMatchObject({ title: "Gemini CLI (deprecated)", detail: "Herdr starts gemini" });
    expect(kinds.find((choice) => choice.kind === "agy")).toMatchObject({ title: "Antigravity CLI", detail: "Herdr starts agy" });
  });

  it("a herdr-core machine's three kinds are unchanged", () => {
    expect([...coreStartKinds]).toEqual(["claude", "codex", "grok"]);
    expect(newAgentKinds(absentStartCommands, "hc:space-1").map((choice) => choice.kind)).toEqual(["claude", "codex", "grok", "shell"]);
  });
});

// MARK: - The four places

const topology = (agent: string) =>
  decodeSessionTopology({
    version: "0.9.5",
    protocol: 22,
    workspaces: [{ workspace_id: "w1", number: 1, label: "app", focused: true, pane_count: 1, tab_count: 1, active_tab_id: "w1:t1", agent_status: "idle" }],
    tabs: [{ tab_id: "w1:t1", workspace_id: "w1", number: 1, label: "main", focused: true, pane_count: 1, agent_status: "idle" }],
    panes: [{ pane_id: "w1:p1", terminal_id: "term", workspace_id: "w1", tab_id: "w1:t1", focused: false, cwd: "/fixture", agent, agent_status: "idle", revision: 1 }],
    layouts: [],
    agents: [{ pane_id: "w1:p1", agent, agent_status: "idle" }],
  });
const machine = (agent: string): HostView => ({
  id: "host",
  name: "Mac mini",
  kind: "ssh",
  address: "fixture",
  platform: null,
  state: "connected",
  error: null,
  fetchedAtMs: 0,
  topology: topology(agent),
});
const paneRow = (kind: string): SidebarRow => ({ paneID: "w1:p1", name: "fixture", workspaceLabel: "app", kind, isAgent: true, glyph: "idle", status: "idle" }) as unknown as SidebarRow;

describe("the pane's Chat tab", () => {
  function pane(kind: string) {
    vi.stubGlobal("window", { herdrDesktop: { sendToPane: async () => undefined }, innerHeight: 900 });
    const props = { host: machine(kind), row: paneRow(kind), tab: "chat", onTab: () => undefined, mac: true, fontSize: 13, boxShown: false, onBoxShown: () => undefined, ghostty: { shown: false }, onOpenInGhostty: () => undefined };
    const view = new HookHost(MainPane as (props: object) => unknown, props);
    view.render();
    const seg = elements(view.tree).find((element) => element.props["className"] === "seg sm three agent-seg")!;
    const chatTab = (seg.props["children"] as Element[])[0]!;
    const result = { view, chatTab: shown(chatTab), all: shown(view.tree), words: text(chatTab) };
    view.unmount();
    return result;
  }

  it("an early kind's Chat tab carries the Early badge with its title", () => {
    for (const kind of [...nowEarly, "qwen", "gemini", "copilot", "agy"]) {
      const look = pane(kind);
      expect(look.chatTab, kind).toEqual([chatEarlyText(kind)]);
      expect(look.all, kind).toEqual([chatEarlyText(kind)]);
    }
  });

  it("a supported kind's, and a kind Chat doesn't read, show nothing new", () => {
    for (const kind of ["claude", "codex", "amp"]) {
      const look = pane(kind);
      expect(look.all, kind).toEqual([]);
      expect(look.words, kind).toBe("Chat");
    }
  });
});

describe("a split tile's header (its Chat is an icon there)", () => {
  function tile(kind: string, isAgent = true) {
    vi.stubGlobal("window", { herdrDesktop: { sendToPane: async () => undefined }, innerHeight: 900, getSelection: () => null });
    const row = { ...paneRow(kind), isAgent } as SidebarRow;
    const view = new HookHost(Tile as (props: object) => unknown, {
      host: machine(kind),
      entry: { paneId: "w1:p1", index: 0, frame: { left: 0, top: 0, width: 1, height: 1 }, row, view: "chat" },
      focused: true,
      focusSignal: 0,
      fontSize: 13,
      boxShown: false,
      onBoxShown: () => undefined,
      onFocus: () => undefined,
      onView: () => undefined,
      onZoom: () => undefined,
      onClose: () => undefined,
      onSplitMenu: () => undefined,
    });
    view.render();
    const header = elements(view.tree).find((element) => element.props["className"] === "tile-h")!;
    const result = { header: shown(header), all: shown(view.tree) };
    view.unmount();
    return result;
  }

  it("an early kind's tile has the badge beside its kind; a supported or unread kind's and a shell's none", () => {
    expect(tile("qwen").header).toEqual([chatEarlyText("qwen")]);
    expect(tile("qwen").all).toEqual([chatEarlyText("qwen")]);
    expect(tile("agy").header).toEqual([chatEarlyText("agy")]);
    for (const kind of nowEarly) expect(tile(kind).header, kind).toEqual([chatEarlyText(kind)]);
    for (const kind of ["claude", "codex", "amp"]) expect(tile(kind).all, kind).toEqual([]);
    expect(tile("qwen", false).all).toEqual([]);
  });
});

describe("New agent's list", () => {
  function dialog() {
    vi.stubGlobal("window", { herdrDesktop: { startCommands: () => Promise.resolve(absentStartCommands) } });
    const view = new HookHost(NewAgentDialog as (props: object) => unknown, {
      places: newAgentPlaces([{ id: "host", name: "Mac mini", state: "connected", topology: topology("claude") }]),
      wanted: { hostId: "host", workspaceId: "w1" },
      storage: null,
      start: () => new Promise(() => undefined),
      onStarted: () => undefined,
      onClose: () => undefined,
    });
    view.render();
    const rows = elements(view.tree).filter((element) => typeof element.props["data-kind"] === "string");
    const byKind = new Map(rows.map((element) => [element.props["data-kind"] as string, element]));
    view.unmount();
    return byKind;
  }

  it("each early kind's row has the badge beside its name; supported kinds, unread kinds and the shell none", () => {
    const rows = dialog();
    for (const kind of early) expect(shown(rows.get(kind)), kind).toEqual([chatEarlyText(kind)]);
    for (const kind of [...supported, ...unread, "shell"]) expect(shown(rows.get(kind)), kind).toEqual([]);
    const gemini = elements(rows.get("gemini")).find((element) => element.props["className"] === "t")!;
    expect(text(gemini)).toBe("Gemini CLI (deprecated)");
  });
});

describe("Settings' agents", () => {
  const item = (target: string, kind: string, name: string): IntegrationItem => ({ target, kind, name, state: "current", available: true });

  it("Machines' integrations line: the badge beside an early kind's name (Antigravity CLI's too), none beside a supported one's", () => {
    vi.stubGlobal("window", { addEventListener: () => undefined, removeEventListener: () => undefined });
    const host = sshHost("mini", "Mac mini", {
      incarnation: 2,
      connection: 4,
      epoch: 7,
      integrations: {
        incarnation: 2,
        connection: 4,
        epoch: 7,
        items: [item("claude", "claude", "Claude Code"), item("antigravity_cli", "agy", "Antigravity CLI"), item("copilot", "copilot", "GitHub Copilot"), item("qwen", "qwen", "Qwen Code")],
        outcomes: {},
      },
    });
    const view = new HookHost(IntegrationsLine as (props: object) => unknown, { host, bridge: {} });
    view.render();
    const items = elements(view.tree).filter((element) => element.props["className"] === "set-int-i");
    // The badge sits between the name and its state (its own words are the badge's: ChatEarlyBadge, drawn above).
    const look = Object.fromEntries(items.map((element) => [element.props["data-integration"] as string, { badges: shown(element), words: text(element) }]));
    const children = (items.find((element) => element.props["data-integration"] === "copilot")!.props["children"] as unknown[]).filter((child) => child !== null);
    expect(children.slice(0, 3).map((child) => (typeof child === "string" ? child : (child as Element).type))).toEqual(["GitHub Copilot", ChatEarlyBadge, ": installed"]);
    expect(look).toEqual({
      claude: { badges: [], words: "Claude Code: installed" },
      antigravity_cli: { badges: [chatEarlyText("agy")], words: "Antigravity CLI: installed" },
      copilot: { badges: [chatEarlyText("copilot")], words: "GitHub Copilot: installed" },
      qwen: { badges: [chatEarlyText("qwen")], words: "Qwen Code: installed" },
    });
    view.unmount();
  });

  it("Chat's start commands: each row asks the same question; Grok Build's and Cursor Agent's rows show the badge, Claude Code's and Codex's none", () => {
    const { bridge } = settingsBridge();
    const page = mountSettings("chat", { bridge, hosts: [sshHost("studio", "Studio")] });
    const rows = page.all((element) => typeof element.props["data-start-kind"] === "string");
    expect(rows.map((element) => element.props["data-start-kind"])).toEqual(["claude", "codex", "grok", "cursor"]);
    const all = badges(page.view.tree);
    expect(all).toEqual([
      { kind: "claude", title: null },
      { kind: "codex", title: null },
      { kind: "grok", title: chatEarlyText("grok") },
      { kind: "cursor", title: chatEarlyText("cursor") },
    ]);
    page.view.unmount();
  });
});

describe("an early kind's empty Chat", () => {
  let listener: ((event: unknown) => void) | null = null;
  function chat(kind: string) {
    vi.stubGlobal("window", {
      herdrDesktop: {
        onChatUpdate: (next: (event: unknown) => void) => {
          listener ??= next;
          return () => undefined;
        },
        openChat: () => undefined,
        closeChat: () => undefined,
        setChatFollowing: () => undefined,
        copyText: () => undefined,
      },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      getSelection: () => null,
      sessionStorage: { getItem: () => null, setItem: () => undefined },
    });
    vi.stubGlobal("document", { body: { classList: { add: () => undefined } }, fonts: { ready: Promise.resolve() } });
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
    vi.stubGlobal("requestAnimationFrame", (callback: (time: number) => void) => (callback(0), 0));
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe(): void {}
        disconnect(): void {}
      },
    );
    const view = new HookHost(ChatView as (props: object) => unknown, { host: machine(kind), row: paneRow(kind), onShowTerminal: () => undefined });
    view.render();
    return {
      view,
      deliver: (state: unknown, timeline = emptyTimeline) => {
        listener!({ hostId: "host", paneId: "w1:p1", state, timeline });
        view.render();
      },
      line: () => elements(view.tree).filter((element) => element.props["className"] === "chat-early-line").map(text),
      first: (className: string) => (elements(view.tree).find((element) => element.props["className"] === className)?.props["children"] as unknown[] | undefined) ?? [],
    };
  }

  it("no session yet: one plain line at the top, the badge's words, above the reason", () => {
    const c = chat("qwen");
    c.deliver({ status: "unavailable", reason: "notFound" });
    expect(c.line()).toEqual([chatEarlyText("qwen")]);
    // The explanation's first child is the line.
    const empty = elements(c.view.tree).find((element) => element.props["className"] === "chat-empty")!;
    const explanation = (empty.props["children"] as Element).props["children"] as unknown[];
    expect(text(explanation[0])).toBe(chatEarlyText("qwen"));
    c.view.unmount();
  });

  it("Grok Build's, Cursor Agent's and OpenCode's empty Chat has the line at the top too, gone once a message shows", () => {
    for (const kind of nowEarly) {
      const c = chat(kind);
      c.deliver({ status: "unavailable", reason: "notFound" });
      expect(c.line(), kind).toEqual([chatEarlyText(kind)]);
      c.deliver({ status: "live" });
      expect(c.line(), kind).toEqual([chatEarlyText(kind)]);
      c.deliver({ status: "live" }, timelineOf([user("hello", "u1", 0)]).timeline);
      expect(c.line(), kind).toEqual([]);
      c.view.unmount();
    }
  });

  it("read, with no messages yet (and while it reads): the same line at the top; gone once a message shows", () => {
    const c = chat("gemini");
    c.deliver({ status: "loading" });
    expect(c.line()).toEqual([chatEarlyText("gemini")]);
    c.deliver({ status: "live" });
    expect(c.line()).toEqual([chatEarlyText("gemini")]);
    const column = elements(c.view.tree).find((element) => typeof element.props["className"] === "string" && (element.props["className"] as string).startsWith("chat-col"))!;
    const firstShown = (column.props["children"] as unknown[]).find((child) => child !== null && child !== false && child !== undefined);
    expect(text(firstShown)).toBe(chatEarlyText("gemini"));
    c.deliver({ status: "live" }, timelineOf([user("hello", "u1", 0)]).timeline);
    expect(c.line()).toEqual([]);
    c.view.unmount();
  });

  it("a supported kind's empty Chat says nothing new; a kind Chat doesn't read keeps its own line", () => {
    for (const kind of ["claude", "codex"]) {
      const c = chat(kind);
      c.deliver({ status: "unavailable", reason: "notFound" });
      expect(c.line(), kind).toEqual([]);
      c.deliver({ status: "live" });
      expect(c.line(), kind).toEqual([]);
      c.view.unmount();
    }
    const amp = chat("amp");
    expect(amp.line()).toEqual([]);
    expect(text(elements(amp.view.tree).find((element) => element.props["className"] === "chat-unread"))).toBe(chatUnreadLine(true, "amp"));
    amp.view.unmount();
  });
});

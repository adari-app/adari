// The store registry (src/shared/chat/stores.ts), the one place every store format is: the feed's
// `isStoreFormat`, the SSH reader's `StoreViews` (each store's view made on first use, a path handed to the
// view of the store that owns it), and the registration and skip lines of the three store readers, Hermes,
// Mastra Code and Cline (kinds, parser, Away, Changes, Search, the settings tap).

import { describe, expect, it } from "vitest";

import { paneSessions } from "../src/main/away/service";
import { herdrSession } from "../src/main/changes/service";
import { AgentSettingsReader } from "../src/shared/agent-settings";
import { chatKinds, chatReadsKind, chatStoreKinds } from "../src/shared/chat/kinds";
import { makeSessionRef } from "../src/shared/chat/locator";
import { TranscriptParser } from "../src/shared/chat/parser";
import { isStoreFormat, isStorePath, storeEntries, storeEntryOf, StoreViews, type StoreEntry, type StoreIO } from "../src/shared/chat/stores";
import { SearchCommand, SearchQuery } from "../src/shared/search/search";

const cursorStore = "/Users/a/.cursor/chats/0123456789abcdef0123456789abcdef/9a8b7c6d-1111-4222-8333-944455556666/store.db";
const paths: Record<string, string> = {
  cursor: cursorStore,
  opencode: "/Users/a/.local/share/opencode/opencode.db/ses_6a1f0c2b3d4eAbCdEfGhIjKlMn",
  hermes: "/Users/a/.hermes/state.db#20261109_101500_a1b2c3",
  mastracode: "/Users/a/Library/Application Support/mastracode/mastra.db#6f1d3c2a-9b8e-4c7d-a1b2-c3d4e5f60718",
  cline: "/Users/a/.cline/data/sessions/1784094124598_rruoq/1784094124598_rruoq.messages.json",
};

const noIO = (): StoreIO => ({
  query: () => Promise.reject(new Error("no query in this test")),
  stamp: () => Promise.resolve(null),
  notFound: (path) => new Error(`not found: ${path}`),
  readFile: () => Promise.reject(new Error("no read in this test")),
});

describe("store registry", () => {
  it("has one entry per store, every store format in exactly one; the feed's question answers for them only", () => {
    expect(storeEntries.map((entry) => entry.name)).toEqual(["cursor", "opencode", "hermes", "mastracode", "cline"]);
    const formats = storeEntries.flatMap((entry) => entry.formats);
    expect(formats).toEqual(["cursor", "opencode", "kilo", "hermes", "mastracode", "cline"]);
    expect(new Set(formats).size).toBe(formats.length);
    for (const format of formats) expect(isStoreFormat(format), format).toBe(true);
    for (const format of ["claude", "codex", "grok", "", null, undefined]) expect(isStoreFormat(format), String(format)).toBe(false);
  });

  it("gives each view path to the one store that owns it; a transcript file is no store's", () => {
    for (const [name, path] of Object.entries(paths)) {
      expect(storeEntries.filter((entry) => entry.owns(path)).map((entry) => entry.name), name).toEqual([name]);
      expect(storeEntryOf(path)?.name).toBe(name);
      expect(isStorePath(path)).toBe(true);
    }
    expect(storeEntryOf("/Users/a/.claude/projects/-Users-a-p/0b6a3c6e-1111-4222-8333-944455556666.jsonl")).toBeNull();
    expect(storeEntryOf("/Users/a/.grok/sessions/x/0b6a3c6e-1111-4222-8333-944455556666/updates.jsonl")).toBeNull();
    expect(isStorePath("/Users/a/.hermes/state.db")).toBe(false);
  });

  it("makes a reader's view of a store once, on first use, with that store's IO; none for a path no store owns", () => {
    const asked: string[] = [];
    const views = new StoreViews((entry: StoreEntry) => {
      asked.push(entry.name);
      return noIO();
    });
    expect(views.of("/Users/a/notes.jsonl")).toBeNull();
    expect(asked).toEqual([]);
    const hermes = views.of(paths["hermes"]!);
    expect(hermes).not.toBeNull();
    expect(views.of("/Users/b/.hermes/profiles/work/state.db#other_session")).toBe(hermes);
    expect(views.of(paths["cline"]!)).not.toBe(hermes);
    expect(asked).toEqual(["hermes", "cline"]);
    for (const path of Object.values(paths)) views.of(path);
    expect(asked).toEqual(["hermes", "cline", "cursor", "opencode", "mastracode"]);
  });
});

describe("the three readers' registration and skip lines", () => {
  it("Chat reads their panes; the other kinds stay in the list", () => {
    // chatStoreKinds is joined into chatKinds with every other reader's kinds.
    expect(chatKinds).toEqual(expect.arrayContaining(["claude", "codex", "grok", "cursor", "opencode", "kilo", "hermes", "mastracode", "cline"]));
    expect(chatStoreKinds).toEqual(["hermes", "mastracode", "cline"]);
    for (const kind of ["hermes", "Hermes", "mastracode", "cline"]) expect(chatReadsKind(kind), kind).toBe(true);
    expect(chatReadsKind("mastra")).toBe(false);
    for (const format of ["hermes", "mastracode", "cline"] as const) {
      expect(new TranscriptParser(format).parse('{"x":1}').outcome.kind, format).toBe("unknown");
      expect(new AgentSettingsReader(format).settings).toEqual(new AgentSettingsReader("grok").settings);
    }
  });

  it("Away, Changes and Search read none of their sessions yet (carded)", () => {
    const folder = "/Users/fixture/project";
    const machine = {
      agents: [
        { paneID: "h", agent: "hermes", cwd: folder, agentSession: { source: "herdr:hermes", agent: "hermes", kind: "id", value: "20261109_101500_a1b2c3" } },
        { paneID: "m", agent: "mastracode", cwd: folder, agentSession: { source: "herdr:mastracode", agent: "mastracode", kind: "id", value: "6f1d3c2a-9b8e-4c7d-a1b2-c3d4e5f60718" } },
        { paneID: "c", agent: "cline", cwd: folder },
      ],
      panes: [
        { paneID: "h", agent: "hermes", cwd: folder },
        { paneID: "m", agent: "mastracode", cwd: folder },
        { paneID: "c", agent: "cline", cwd: folder },
      ],
    } as never;
    const away = paneSessions(machine);
    for (const pane of ["h", "m", "c"]) {
      expect(away[pane], pane).toBeNull();
      expect(herdrSession(machine, pane), pane).toBeNull();
    }
    const targets = [
      { paneID: "h", session: makeSessionRef("hermes", { kind: "id", id: "20261109_101500_a1b2c3" })! },
      { paneID: "m", session: makeSessionRef("mastracode", { kind: "id", id: "6f1d3c2a-9b8e-4c7d-a1b2-c3d4e5f60718" })! },
      { paneID: "c", session: makeSessionRef("cline", { kind: "folder", folder })! },
    ];
    expect(SearchCommand.make(SearchQuery.make("paywall")!, targets)).toBeNull();
  });
});

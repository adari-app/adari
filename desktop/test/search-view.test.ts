// "Search conversations" in the page, ported from the Swift app's
// CompanionSearchTextTests and CompanionSearchViewTests: the words (when a
// message was written, who wrote it, a group's and a row's labels, "N more",
// each machine's line, a snippet's marked parts), the groups' order and the
// keyboard's selection, then the screen on the small hooks host (the 300 ms
// pause, ↑ ↓ Return Escape, a result, "N more", Try again, no matches, the
// close), opening a result at its row in Chat (search/reveal.ts), and the real
// App: ⇧⌘F, the sidebar's "Search all conversations for …", the capture
// commands, a result opening its pane in Chat. Fixtures only.

import { afterEach, describe, expect, it, vi } from "vitest";

import { decodeSessionTopology } from "../src/main/herdr/wire";
import type { ChatTimeline } from "../src/shared/chat/model";
import type { AppCommand, HostView, MainTab } from "../src/shared/ipc-contract";
import type { SearchUpdate } from "../src/shared/search/runner";
import type { SearchMatch, SearchSnippet } from "../src/shared/search/search";
import {
  agentName,
  authorText,
  folderText,
  groupLabel,
  groupPlace,
  moreText,
  offersRetry,
  rowLabel,
  searchTime,
  snippetParts,
  statusText,
} from "../src/shared/search/text";
import {
  buildGroups,
  groupMore,
  groupShown,
  isSearching,
  isTooShort,
  keptSelection,
  moveSelection,
  selectedRequest,
  showsNoResults,
  visibleResults,
  type SearchGroup,
  type SearchMacStatus,
  type SearchMatchView,
  type SearchViewState,
} from "../src/shared/search/view";
import { HookHost, elements, find } from "./support/fake-hooks";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  return { ...actual, ...fakeReact, default: { ...actual, ...fakeReact } };
});

const { SearchScreen, longMessageText, searchAllText } = await import("../src/renderer/search/Search");
const { revealRequests, revealStep, maxRevealLoads, revealMissingText, useReveal } = await import("../src/renderer/search/reveal");
const { App } = await import("../src/renderer/App");
const { Sidebar } = await import("../src/renderer/components/Sidebar");
const { MainPane } = await import("../src/renderer/components/MainPane");

const date = (iso: string): number => Date.parse(iso) / 1000;
const now = date("2026-11-02T15:00:00.000Z");
const utc = { locale: "en-US", timeZone: "UTC" };
/** Intl's narrow spaces as plain ones. */
const plain = (text: string): string => text.replace(/[  ]/g, " ");

const snippetOf = (text: string, highlights: SearchSnippet["highlights"] = []): SearchSnippet => ({ text, highlights });

function match(paneID: string, offset: number, fields: Partial<SearchMatchView> = {}): SearchMatchView {
  return { paneID, lineOffset: offset, messageID: `m${offset}`, author: "you", time: now - offset, snippet: snippetOf(`text ${offset}`), ...fields };
}

function group(macID: string, paneID: string, matches: readonly SearchMatchView[], fields: Partial<SearchGroup> = {}): SearchGroup {
  return {
    id: `${macID}|${paneID}`,
    macID,
    macName: macID === "studio" ? "Studio" : "Laptop",
    pane: { id: paneID, name: `pane ${paneID}`, kind: "claude", folder: "/srv/app" },
    matches,
    unread: 0,
    expanded: false,
    expanding: false,
    ...fields,
  };
}

const macStatus = (fields: Partial<SearchMacStatus> = {}): SearchMacStatus => ({
  id: "studio",
  name: "Studio",
  phase: "done",
  truncated: false,
  skippedPanes: 0,
  unsearchedPanes: 0,
  ...fields,
});

const texts = (tree: unknown): string[] =>
  elements(tree)
    .map((element) => element.props.children)
    .filter((children): children is string => typeof children === "string");
const byClass = (tree: unknown, className: string) => elements(tree).filter((element) => element.props["className"] === className);

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  revealRequests.clear();
});

describe("the search screen's words", () => {
  it("says when a message was written: the time today, yesterday, the weekday this week, the date beyond", () => {
    expect(plain(searchTime(date("2026-11-02T09:30:00Z"), now, utc))).toBe("9:30 AM");
    expect(plain(searchTime(date("2026-11-01T20:15:00Z"), now, utc))).toBe("yesterday at 8:15 PM");
    expect(plain(searchTime(date("2026-10-29T10:00:00Z"), now, utc))).toBe("Thursday at 10:00 AM");
    expect(plain(searchTime(date("2026-10-27T10:00:00Z"), now, utc))).toBe("Tuesday at 10:00 AM");
    expect(plain(searchTime(date("2026-10-26T10:00:00Z"), now, utc))).toBe("Oct 26");
    expect(plain(searchTime(date("2025-10-12T10:00:00Z"), now, utc))).toBe("Oct 12, 2025");
    // The day is the reader's: 23:30 UTC on Nov 1 is 8:30 on Nov 2 in Tokyo, the same day as 10:00 UTC.
    const morning = date("2026-11-02T10:00:00Z");
    expect(plain(searchTime(date("2026-11-01T23:30:00Z"), morning, { locale: "en-US", timeZone: "Asia/Tokyo" }))).toBe("8:30 AM");
    expect(plain(searchTime(date("2026-11-01T23:30:00Z"), morning, utc))).toBe("yesterday at 11:30 PM");
  });

  it("names who wrote it, the agent, the folder, the group and the row", () => {
    expect([agentName("claude"), agentName("CODEX"), agentName("grok"), agentName("pi"), agentName(null)]).toEqual(["Claude Code", "Codex", "Grok Build", "Pi", "Agent"]);
    expect([authorText("you", "claude"), authorText("agent", "codex"), authorText("command", "claude"), authorText(null, "claude")]).toEqual([
      "You",
      "Codex",
      "Command",
      "A very long message",
    ]);
    expect([folderText("/srv/app/"), folderText("/"), folderText(null), folderText("")]).toEqual(["app", "/", null, null]);
    const one = group("studio", "p1", [match("p1", 10)]);
    const two = group("studio", "p1", [match("p1", 10), match("p1", 20)], { pane: { id: "p1", name: "shell", kind: null, folder: null } });
    expect(groupLabel(one)).toBe("1 match in claude, pane p1, Studio");
    expect(groupLabel(two)).toBe("2 matches in terminal, shell, Studio");
    expect([groupPlace(one), groupPlace(two)]).toEqual(["Studio · app", "Studio"]);
    const at = match("p1", 10, { author: "agent", time: date("2026-11-02T09:30:00Z"), snippet: snippetOf("The banner wraps") });
    expect(plain(rowLabel(at, "claude", now, utc))).toBe("Claude Code, 9:30 AM: The banner wraps");
    expect(rowLabel(match("p1", 10, { snippet: null, author: null, time: null }), "claude", now, utc)).toBe("A very long message, its text not shown");
  });

  it("says N more and each machine's line, with Try again only where the search did not finish", () => {
    expect([moreText(3), moreText(1, true), moreText(0, true)]).toEqual(["3 more in this pane", "1 more in this pane, more lines to check", "More lines to check in this pane"]);
    expect(statusText(macStatus({ phase: "waiting" }))).toBeNull();
    expect(statusText(macStatus({ phase: "searching" }))).toBe("Studio: searching…");
    expect(statusText(macStatus({ phase: "offline" }))).toBe("Studio: offline");
    expect(statusText(macStatus({ phase: "timedOut" }))).toBe("Studio: no answer in 10 s");
    expect(statusText(macStatus({ phase: "failed" }))).toBe("Studio: the search did not run");
    expect(statusText(macStatus())).toBeNull();
    expect(statusText(macStatus({ truncated: true, skippedPanes: 2, unsearchedPanes: 1 }))).toBe(
      "Studio: more results not shown; 2 panes not searched (over 30); 1 pane has no transcript to search",
    );
    expect(statusText(macStatus({ skippedPanes: 1, unsearchedPanes: 3 }))).toBe("Studio: 1 pane not searched (over 30); 3 panes have no transcript to search");
    const retries = (["waiting", "searching", "done", "offline", "timedOut", "failed"] as const).map((phase) => offersRetry(macStatus({ phase })));
    expect(retries).toEqual([false, false, false, false, true, true]);
  });

  it("cuts a snippet into plain and marked parts at characters, never inside one", () => {
    expect(snippetParts(snippetOf("the Lighthouse banner", [{ start: 4, end: 14 }]))).toEqual([
      { text: "the ", marked: false },
      { text: "Lighthouse", marked: true },
      { text: " banner", marked: false },
    ]);
    // A flag and a family are one character each.
    expect(snippetParts(snippetOf("🇫🇷 café 👨‍👩‍👧 x", [{ start: 2, end: 6 }]))).toEqual([
      { text: "🇫🇷 ", marked: false },
      { text: "café", marked: true },
      { text: " 👨‍👩‍👧 x", marked: false },
    ]);
    expect(snippetParts(snippetOf("ab", [{ start: 0, end: 9 }]))).toEqual([{ text: "ab", marked: true }]);
    expect(snippetParts(snippetOf(""))).toEqual([]);
  });

  it("offers the sidebar's filter as a search of every conversation once it is long enough", () => {
    expect(searchAllText("  lighthouse ")).toBe("Search all conversations for “lighthouse”");
    expect(searchAllText("l")).toBe("Search conversations ⇧⌘F");
    expect(searchAllText("")).toBe("Search conversations ⇧⌘F");
  });
});

describe("the groups and the keyboard", () => {
  const update = (panes: { paneID: string; matches: SearchMatchView[]; unread?: number }[], expanding: string[] = []): SearchUpdate =>
    ({ results: { panes: panes.map((pane) => ({ unread: 0, ...pane })) }, expanding: new Set(expanding) }) as unknown as SearchUpdate;
  const info = (id: string) => ({ id, name: `pane ${id}`, kind: "claude", folder: "/srv/app" });

  it("puts the pane with the newest match first across machines; an unknown time after known ones, then the machines' order", () => {
    const groups = buildGroups(
      [
        {
          id: "studio",
          name: "Studio",
          panes: [info("p1"), info("p2"), info("p3")],
          update: update([
            { paneID: "p1", matches: [match("p1", 300)] },
            { paneID: "p2", matches: [match("p2", 50)] },
            { paneID: "p3", matches: [match("p3", 1, { time: null })] },
          ]),
        },
        { id: "laptop", name: "Laptop", panes: [info("q1")], update: update([{ paneID: "q1", matches: [match("q1", 100)], unread: 4 }], ["q1"]) },
        { id: "offline", name: "Old", panes: [info("r1")], update: null },
      ],
      new Set(["laptop|q1"]),
    );
    expect(groups.map((entry) => entry.id)).toEqual(["studio|p2", "laptop|q1", "studio|p1", "studio|p3"]);
    expect(groups[1]).toMatchObject({ macName: "Laptop", unread: 4, expanded: true, expanding: true, pane: info("q1") });
    // A pane the sidebar no longer names keeps its id as its name.
    const unknown = buildGroups([{ id: "studio", name: "Studio", panes: [], update: update([{ paneID: "gone", matches: [match("gone", 1)] }]) }], new Set());
    expect(unknown[0]!.pane).toEqual({ id: "gone", name: "gone", kind: null, folder: null });
  });

  it("shows 5 of a pane until N more, and moves the selection through what is shown", () => {
    const many = group("studio", "p1", [1, 2, 3, 4, 5, 6, 7].map((offset) => match("p1", offset)));
    const other = group("laptop", "q1", [match("q1", 9)]);
    expect(groupShown(many)).toHaveLength(5);
    expect(groupMore(many)).toBe(2);
    expect(groupShown({ ...many, expanded: true })).toHaveLength(7);
    expect(groupMore({ ...many, expanded: true })).toBe(0);
    const groups = [many, other];
    expect(visibleResults(groups)).toHaveLength(6);
    const first = moveSelection(groups, null, 1);
    expect(first).toEqual({ groupID: "studio|p1", matchID: "p1|1|m1" });
    expect(moveSelection(groups, null, -1)).toEqual({ groupID: "laptop|q1", matchID: "q1|9|m9" });
    let selection = first;
    for (let step = 0; step < 9; step += 1) selection = moveSelection(groups, selection, 1);
    expect(selection).toEqual({ groupID: "laptop|q1", matchID: "q1|9|m9" });
    expect(moveSelection(groups, selection, -1)).toEqual({ groupID: "studio|p1", matchID: "p1|5|m5" });
    expect(moveSelection([], selection, 1)).toBeNull();
    expect(keptSelection([other], first)).toBeNull();
    expect(keptSelection(groups, first)).toEqual(first);
    // Return opens the selected result, else the first.
    expect(selectedRequest(groups, null)).toEqual({ macID: "studio", paneID: "p1", messageID: "m1", lineOffset: 1 });
    expect(selectedRequest(groups, selection)).toEqual({ macID: "laptop", paneID: "q1", messageID: "m9", lineOffset: 9 });
    expect(selectedRequest([], null)).toBeNull();
  });

  it("is searching while the pause runs or a machine searches; no results only once it is over", () => {
    const searched: SearchViewState = { searched: "lighthouse", statuses: [macStatus()], groups: [] };
    expect([isTooShort("l"), isTooShort(" l "), isTooShort("li"), isTooShort("🇫🇷")]).toEqual([true, true, false, true]);
    expect(isSearching("lighthouse", searched)).toBe(false);
    expect(isSearching("lighthouses", searched)).toBe(true);
    expect(isSearching("lighthouse", { ...searched, statuses: [macStatus({ phase: "searching" })] })).toBe(true);
    expect(showsNoResults("lighthouse", searched)).toBe(true);
    expect(showsNoResults("lighthouses", searched)).toBe(false);
    expect(showsNoResults("lighthouse", { ...searched, groups: [group("studio", "p1", [match("p1", 1)])] })).toBe(false);
    expect(showsNoResults("li", { searched: null, statuses: [], groups: [] })).toBe(false);
  });
});

describe("the search screen", () => {
  function screen(query: string, state: SearchViewState) {
    const calls: string[] = [];
    const opened: unknown[] = [];
    const bridge = {
      searchConversations: (text: string) => calls.push(`search ${text}`),
      searchExpand: (mac: string, pane: string) => calls.push(`expand ${mac} ${pane}`),
      searchRetry: (mac: string) => calls.push(`retry ${mac}`),
      searchClose: () => calls.push("close"),
      onSearchUpdate: () => () => undefined,
    };
    const props = {
      bridge,
      state,
      query,
      now,
      onQuery: (text: string) => calls.push(`query ${text}`),
      onOpen: (request: unknown) => opened.push(request),
      onClose: () => calls.push("closed"),
    };
    const ui = new HookHost(SearchScreen as (p: typeof props) => unknown, props);
    ui.render();
    return { ui, calls, opened, props, rerender: (fields: Partial<typeof props>) => ui.render({ ...props, ...fields }) };
  }
  const key = (ui: { readonly tree: unknown }, name: string) => {
    let prevented = false;
    (find(ui.tree, "input")!.props["onKeyDown"] as (event: object) => void)({ key: name, preventDefault: () => (prevented = true) });
    return prevented;
  };

  it("asks for the prompt until 2 characters; every edit goes to the main process at once (it cancels the old search then, and pauses before the new one)", () => {
    const s = screen("", { searched: null, statuses: [], groups: [] });
    expect(texts(s.ui.tree)).toContain("Search every conversation on your machines");
    expect(texts(s.ui.tree)).toContain("⇧⌘F");
    expect(s.calls).toEqual(["search "]);
    (find(s.ui.tree, "input")!.props["onChange"] as (event: object) => void)({ target: { value: "li" } });
    expect(s.calls.at(-1)).toBe("query li");
    s.rerender({ query: "li" });
    s.rerender({ query: "lig" });
    // No timer of its own: each edit is sent as it happens.
    expect(s.calls.filter((call) => call.startsWith("search"))).toEqual(["search ", "search li", "search lig"]);
    expect(texts(s.ui.tree)).toContain("Searching…");
    s.rerender({ query: "lig" });
    expect(s.calls.filter((call) => call.startsWith("search"))).toHaveLength(3);
    s.rerender({ query: "l" });
    expect(s.calls.at(-1)).toBe("search l");
    s.ui.unmount();
    expect(s.calls.at(-1)).toBe("close");
  });

  it("shows the groups, their rows with who, when and the marked text, a very long message, N more and the machines' lines", () => {
    const studio = group(
      "studio",
      "p1",
      [
        match("p1", 1, { author: "agent", time: date("2026-11-02T09:30:00Z"), snippet: snippetOf("the Lighthouse banner", [{ start: 4, end: 14 }]) }),
        match("p1", 2, { author: null, time: null, snippet: null, messageID: null }),
        ...[3, 4, 5, 6].map((offset) => match("p1", offset)),
      ],
      { unread: 2 },
    );
    const laptop = group("laptop", "q1", [match("q1", 9)], { pane: { id: "q1", name: "shell", kind: null, folder: null }, expanding: true, unread: 1, expanded: true });
    const state: SearchViewState = {
      searched: "lighthouse",
      statuses: [macStatus({ phase: "timedOut" }), macStatus({ id: "laptop", name: "Laptop", phase: "offline" }), macStatus({ id: "old", name: "Old", phase: "waiting" })],
      groups: [studio, laptop],
    };
    const s = screen("lighthouse", state);
    const tree = s.ui.tree;
    expect(byClass(tree, "search-mac").map((line) => texts(line)[0])).toEqual(["Studio: no answer in 10 s", "Laptop: offline"]);
    expect(texts(byClass(tree, "search-mac")[0])).toContain("Try again");
    expect(texts(byClass(tree, "search-mac")[1])).not.toContain("Try again");
    (find(byClass(tree, "search-mac")[0], "button")!.props["onClick"] as () => void)();
    expect(s.calls).toContain("retry studio");

    const sections = elements(tree).filter((element) => element.type === "section");
    expect(sections.map((section) => section.props["aria-label"])).toEqual(["6 matches in claude, pane p1, Studio", "1 match in terminal, shell, Laptop"]);
    expect(texts(sections[0])).toEqual(expect.arrayContaining(["pane p1", "claude", "Studio · app"]));
    const rows = elements(sections[0]).filter((element) => element.props["className"] === "search-row");
    expect(rows).toHaveLength(5);
    // In the reader's own time zone.
    const when = searchTime(date("2026-11-02T09:30:00Z"), now);
    expect(rows[0]!.props["aria-label"]).toBe(`Claude Code, ${when}: the Lighthouse banner`);
    expect(texts(rows[0])).toEqual(["Claude Code", when, "the ", "Lighthouse", " banner"]);
    expect(elements(rows[0]).filter((element) => element.type === "mark").map((element) => element.props.children)).toEqual(["Lighthouse"]);
    expect(texts(rows[1])).toEqual(["A very long message", longMessageText]);
    const more = byClass(tree, "search-more");
    expect(more.map((button) => button.props.children)).toEqual(["1 more in this pane, more lines to check", "Reading…"]);
    expect(more.map((button) => button.props["disabled"])).toEqual([false, true]);
    (more[0]!.props["onClick"] as () => void)();
    expect(s.calls).toContain("expand studio p1");

    (rows[1]!.props["onClick"] as () => void)();
    expect(s.opened).toEqual([{ macID: "studio", paneID: "p1", messageID: null, lineOffset: 2 }]);
    s.ui.unmount();
  });

  it("moves with ↑ and ↓, opens with Return (the first without a selection) and closes with Escape", () => {
    const state: SearchViewState = {
      searched: "lighthouse",
      statuses: [macStatus()],
      groups: [group("studio", "p1", [match("p1", 1), match("p1", 2)]), group("laptop", "q1", [match("q1", 3)])],
    };
    const s = screen("lighthouse", state);
    expect(key(s.ui, "Enter")).toBe(true);
    expect(s.opened.at(-1)).toEqual({ macID: "studio", paneID: "p1", messageID: "m1", lineOffset: 1 });
    expect(byClass(s.ui.tree, "search-row sel")).toHaveLength(0);
    key(s.ui, "ArrowDown");
    key(s.ui, "ArrowDown");
    key(s.ui, "ArrowDown");
    expect(byClass(s.ui.tree, "search-row sel").map((row) => row.props["data-match"])).toEqual(["laptop|q1#q1|3|m3"]);
    key(s.ui, "ArrowDown");
    key(s.ui, "ArrowUp");
    expect(byClass(s.ui.tree, "search-row sel").map((row) => row.props["data-match"])).toEqual(["studio|p1#p1|2|m2"]);
    key(s.ui, "Enter");
    expect(s.opened.at(-1)).toEqual({ macID: "studio", paneID: "p1", messageID: "m2", lineOffset: 2 });
    // A selection no longer shown is dropped: Return opens the first again.
    s.rerender({ state: { ...state, groups: [state.groups[1]!] } });
    key(s.ui, "Enter");
    expect(s.opened.at(-1)).toEqual({ macID: "laptop", paneID: "q1", messageID: "m3", lineOffset: 3 });
    expect(key(s.ui, "x")).toBe(false);
    key(s.ui, "Escape");
    expect(s.calls).toContain("closed");
    s.ui.unmount();
  });

  it("says no matches once every machine is done, and nothing while one still searches", () => {
    const s = screen("lighthouse", { searched: "lighthouse", statuses: [macStatus()], groups: [] });
    expect(texts(s.ui.tree)).toContain("No matches for “lighthouse”");
    expect(texts(s.ui.tree)).not.toContain("Searching…");
    s.rerender({ state: { searched: "lighthouse", statuses: [macStatus({ phase: "searching" })], groups: [] } });
    expect(texts(s.ui.tree)).not.toContain("No matches for “lighthouse”");
    expect(texts(s.ui.tree)).toContain("Searching…");
    expect(texts(s.ui.tree)).toContain("Studio: searching…");
    s.ui.unmount();
  });
});

describe("opening a result at its row in Chat", () => {
  const timeline = (ids: string[], earlier: ChatTimeline["earlier"]): ChatTimeline =>
    ({ turns: ids.length === 0 ? [] : [{ id: "t", items: ids.map((id) => ({ type: "message", value: { id } })) }], title: null, earlier, newerWaiting: false }) as unknown as ChatTimeline;

  it("finds the row, loads earlier messages for it (at most 50 times), waits for a read, and gives up at the start", () => {
    expect(revealStep(timeline(["u1", "c1"], "available"), "c1", 0, false)).toEqual({ kind: "found" });
    expect(revealStep(timeline(["u1"], "available"), "u0", 0, false)).toEqual({ kind: "load" });
    expect(revealStep(timeline(["u1"], "available"), "u0", maxRevealLoads, false)).toEqual({ kind: "missing" });
    expect(revealStep(timeline(["u1"], "loading"), "u0", 3, false)).toEqual({ kind: "wait" });
    expect(revealStep(timeline([], "none"), "u0", 0, true)).toEqual({ kind: "wait" });
    for (const earlier of ["none", "failed", "capped"] as const) expect(revealStep(timeline(["u1"], earlier), "u0", 0, false)).toEqual({ kind: "missing" });
  });

  it("keeps one request, for its pane, until that pane's Chat takes it", () => {
    revealRequests.ask("studio", "p1", "u1");
    revealRequests.ask("studio", "p2", "u2");
    expect(revealRequests.peek("studio", "p1")).toBeNull();
    const request = revealRequests.peek("studio", "p2")!;
    expect(request).toMatchObject({ hostId: "studio", paneId: "p2", messageId: "u2" });
    revealRequests.take(request.serial - 1);
    expect(revealRequests.peek("studio", "p2")).not.toBeNull();
    revealRequests.take(request.serial);
    expect(revealRequests.peek("studio", "p2")).toBeNull();
  });

  it("loads earlier messages until the row is there, then stops following, scrolls it to the middle and marks it", () => {
    const marks: string[] = [];
    const row = {
      scrollIntoView: (options: object) => marks.push("scroll " + JSON.stringify(options)),
      classList: { add: (name: string) => marks.push("add " + name), remove: (name: string) => marks.push("remove " + name) },
    };
    const selectors: string[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
      callback();
      return 0;
    });
    vi.stubGlobal("CSS", { escape: (text: string) => text });
    vi.stubGlobal("document", { body: { classList: { contains: () => false } } });
    vi.useFakeTimers();
    const calls: string[] = [];
    const props = {
      hostId: "studio",
      paneId: "p1",
      timeline: timeline(["u5"], "available"),
      chatLoading: false,
      unavailable: false,
      scroller: { current: { querySelector: (selector: string) => (selectors.push(selector), { nextElementSibling: row }) } as unknown as HTMLDivElement },
      loadEarlier: () => calls.push("load"),
      stopFollowing: () => calls.push("stop"),
    };
    const ui = new HookHost(useReveal as (p: typeof props) => unknown, props);
    ui.render();
    expect(calls).toEqual([]);
    revealRequests.ask("studio", "p1", "u1");
    expect(calls).toEqual(["load"]);
    ui.render({ ...props, timeline: timeline(["u5"], "loading") });
    expect(calls).toEqual(["load"]);
    ui.render({ ...props, timeline: timeline(["u3", "u5"], "available") });
    expect(calls).toEqual(["load", "load"]);
    ui.render({ ...props, timeline: timeline(["u1", "u3", "u5"], "available") });
    expect(calls).toEqual(["load", "load", "stop"]);
    expect(selectors).toEqual(['[data-chat-ids~="u1"]']);
    expect(marks).toEqual(['scroll {"block":"center"}', "add chat-reveal"]);
    expect(revealRequests.peek("studio", "p1")).toBeNull();
    vi.advanceTimersByTime(1_500);
    expect(marks.at(-1)).toBe("remove chat-reveal");
    expect((ui.tree as { note: string | null }).note).toBeNull();
    ui.unmount();
  });

  it("says a message out of reach is too far back, for a while; another pane's request waits", () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const props = {
      hostId: "studio",
      paneId: "p1",
      timeline: timeline(["u5"], "none"),
      chatLoading: false,
      unavailable: false,
      scroller: { current: null },
      loadEarlier: () => calls.push("load"),
      stopFollowing: () => calls.push("stop"),
    };
    const ui = new HookHost(useReveal as (p: typeof props) => unknown, props);
    ui.render();
    revealRequests.ask("studio", "p2", "u1");
    expect(revealRequests.peek("studio", "p2")).not.toBeNull();
    revealRequests.ask("studio", "p1", "u1");
    expect((ui.tree as { note: string | null }).note).toBe(revealMissingText);
    expect(calls).toEqual([]);
    vi.advanceTimersByTime(6_000);
    expect((ui.tree as { note: string | null }).note).toBeNull();
    // A very long message opens the Chat only.
    revealRequests.ask("studio", "p1", null);
    expect(revealRequests.peek("studio", "p1")).toBeNull();
    expect((ui.tree as { note: string | null }).note).toBeNull();
    ui.unmount();
  });
});

describe("search in the App", () => {
  function topology() {
    return decodeSessionTopology({
      version: "0.9.5",
      protocol: 22,
      workspaces: [{ workspace_id: "w1", number: 1, label: "app", focused: true, pane_count: 1, tab_count: 1, active_tab_id: "w1:t1", agent_status: "done" }],
      tabs: [{ tab_id: "w1:t1", workspace_id: "w1", number: 1, label: "main", focused: true, pane_count: 1, agent_status: "done" }],
      panes: [{ pane_id: "w1:p1", terminal_id: "t1", workspace_id: "w1", tab_id: "w1:t1", focused: true, cwd: "/srv/app", agent: "claude", agent_status: "done", revision: 1 }],
      layouts: [],
      agents: [{ pane_id: "w1:p1", agent: "claude", agent_status: "done", cwd: "/srv/app" }],
    });
  }

  async function app() {
    let onSearch: ((state: SearchViewState) => void) | null = null;
    let onCommand: ((command: AppCommand) => void) | null = null;
    const keys: ((event: object) => void)[] = [];
    const sent: string[] = [];
    const host: HostView = { id: "studio", name: "Studio", kind: "ssh", address: "me@studio:22", platform: "macOS", state: "connected", error: null, topology: topology(), fetchedAtMs: 0 };
    vi.stubGlobal("window", {
      herdrDesktop: {
        appInfo: async () => ({ version: "0.0.0", platform: "darwin", demo: false, capture: false, updates: { enabled: false, feedUrl: "" } }),
        listHosts: async () => [host],
        onHostsChanged: () => () => undefined,
        onAppCommand: (listener: (command: AppCommand) => void) => {
          onCommand = listener;
          return () => undefined;
        },
        onViewCommand: () => () => undefined,
        ghosttyInfo: async () => ({ shown: false }),
        appCommandDone: (id: string) => sent.push(`done ${id}`),
        awayState: async () => ({ digest: null, building: false, seenAt: null }),
        onAwayUpdate: () => () => undefined,
        awayShown: () => undefined,
        awayMarkSeen: () => undefined,
        searchConversations: (query: string) => sent.push(`search ${query}`),
        searchExpand: () => undefined,
        searchRetry: () => undefined,
        searchClose: () => sent.push("close"),
        onSearchUpdate: (listener: (state: SearchViewState) => void) => {
          onSearch = listener;
          return () => undefined;
        },
      },
      addEventListener: (type: string, listener: (event: object) => void) => {
        if (type === "keydown") keys.push(listener);
      },
      removeEventListener: (type: string, listener: (event: object) => void) => {
        const index = keys.indexOf(listener);
        if (type === "keydown" && index >= 0) keys.splice(index, 1);
      },
    });
    vi.stubGlobal("document", { body: { classList: { add: () => undefined, contains: () => false } }, fonts: { ready: Promise.resolve() } });
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
    vi.stubGlobal("requestAnimationFrame", (callback: (time: number) => void) => {
      callback(0);
      return 0;
    });
    const ui = new HookHost(App as (props: object) => unknown, {});
    ui.render();
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    const findType = (type: unknown) => elements(ui.tree).find((element) => element.type === type);
    const press = (event: Record<string, unknown>) => {
      // The window's shortcut handler stops the event's propagation (a real KeyboardEvent has it).
      for (const listener of keys.slice()) listener({ metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, preventDefault: () => undefined, stopPropagation: () => undefined, ...event });
    };
    return { ui, findType, press, sent, search: (state: SearchViewState) => onSearch!(state), command: (command: AppCommand) => onCommand!(command) };
  }

  const results: SearchViewState = {
    searched: "lighthouse",
    statuses: [macStatus()],
    groups: [group("studio", "w1:p1", [match("w1:p1", 40, { messageID: "u7" })])],
  };

  it("⇧⌘F opens the screen; a result opens its pane in Chat at the message; Escape leaves", async () => {
    const a = await app();
    expect(a.findType(SearchScreen)).toBeUndefined();
    a.press({ key: "f", metaKey: true });
    expect(a.findType(SearchScreen)).toBeUndefined();
    a.press({ key: "F", metaKey: true, shiftKey: true });
    const screenProps = () => a.findType(SearchScreen)!.props;
    expect(screenProps()["query"]).toBe("");
    (screenProps()["onQuery"] as (text: string) => void)("lighthouse");
    expect(screenProps()["query"]).toBe("lighthouse");
    a.search(results);
    expect(screenProps()["state"]).toEqual(results);
    (screenProps()["onOpen"] as (request: object) => void)({ macID: "studio", paneID: "w1:p1", messageID: "u7", lineOffset: 40 });
    expect(a.findType(SearchScreen)).toBeUndefined();
    const main = a.findType(MainPane)!.props;
    expect([(main["row"] as { paneID: string }).paneID, main["tab"] as MainTab]).toEqual(["w1:p1", "chat"]);
    expect(revealRequests.peek("studio", "w1:p1")).toMatchObject({ messageId: "u7" });

    // Opened again it keeps the query; Escape leaves.
    a.press({ key: "f", metaKey: true, shiftKey: true });
    expect(screenProps()["query"]).toBe("lighthouse");
    a.press({ key: "Escape" });
    expect(a.findType(SearchScreen)).toBeUndefined();
    a.ui.unmount();
  });

  it("the sidebar's filter offers every conversation; the capture commands search and open the first result", async () => {
    const a = await app();
    (a.findType(Sidebar)!.props["onSearch"] as (text: string) => void)("lighthouse");
    const offer = () => elements(a.findType(Sidebar)!.props["top"]).find((element) => element.type === "button");
    expect(offer()!.props.children).toBe("Search all conversations for “lighthouse”");
    (offer()!.props["onClick"] as () => void)();
    expect(a.findType(SearchScreen)!.props["query"]).toBe("lighthouse");
    expect(offer()!.props["className"]).toBe("search-all on");

    a.command({ id: "c1", type: "search", query: null });
    expect(a.findType(SearchScreen)).toBeUndefined();
    a.command({ id: "c2", type: "search", query: "banner" });
    expect(a.findType(SearchScreen)!.props["query"]).toBe("banner");
    a.search(results);
    a.command({ id: "c3", type: "search-open-first" });
    expect(a.findType(SearchScreen)).toBeUndefined();
    expect((a.findType(MainPane)!.props["row"] as { paneID: string }).paneID).toBe("w1:p1");
    expect(revealRequests.peek("studio", "w1:p1")).toMatchObject({ messageId: "u7" });
    for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(a.sent.filter((line) => line.startsWith("done c"))).toEqual(["done c1", "done c2", "done c3"]);
    a.ui.unmount();
  });
});

// Keeps the SearchMatch type in step with the view (a match crosses without its parser state).
const _view: SearchMatchView = { paneID: "p", lineOffset: 0, messageID: null, author: null, time: null, snippet: null } satisfies Omit<SearchMatch, "input" | "joined">;
void _view;

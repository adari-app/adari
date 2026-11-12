// Send to…: the Swift app's hand-off rules
// (Tests/HerdrCompanionTests/CompanionHandoffModelTests.swift) ported to the desktop model (src/shared/handoff.ts), the
// picker's state, and the delivery (src/renderer/handoff/handoff-state.ts):
// the draft lands in the picked pane's box after any draft there, Send now
// goes through the bound Send with no pending bubble, a stale pick is refused
// and copied.

import { afterEach, describe, expect, it } from "vitest";

import { decodeSessionTopology } from "../src/main/herdr/wire";
import {
  HandoffPicker,
  HandoffRecents,
  addingRecent,
  contextLine,
  fencedBlocks,
  fits,
  handoffBody,
  handoffList,
  handoffMacs,
  handoffMessage,
  handoffNotice,
  highlight,
  identitiesOf,
  land,
  listRows,
  matchesQuery,
  payloadSummary,
  quoted,
  refusalFor,
  selectionKindIn,
  selectionKindOfEnds,
  sendFailure,
  targetId,
  tooLongText,
  type HandoffHost,
  type HandoffKind,
  type HandoffPayload,
  type HandoffSource,
  type HandoffTarget,
} from "../src/shared/handoff";
import { PaneLife } from "../src/shared/pane-life";
import type { SendBinding } from "../src/shared/send-binding";
import { ComposerDrafts } from "../src/renderer/components/composer-drafts";
import { HandoffStore, checkPick, deliverHandoff, type DeliveryDeps } from "../src/renderer/handoff/handoff-state";
import { PendingMessages } from "../src/shared/chat/pending";

const source: HandoffSource = {
  hostId: "mini",
  paneId: "w1:p1",
  name: "claude",
  kind: "claude",
  workspace: "herdr-companion",
  macName: "Mac mini",
};
const payload = (text: string, kind: HandoffKind): HandoffPayload => ({ text, kind, source });

// MARK: fixtures: two machines, six panes

interface PaneSpec {
  readonly id: string;
  readonly ws: string;
  readonly agent?: string;
  readonly session?: string;
  readonly terminal?: string;
  readonly label?: string;
  readonly cwd?: string;
  readonly status?: string;
}

function topology(workspaces: readonly [string, string][], panes: readonly PaneSpec[]) {
  return decodeSessionTopology({
    version: "0.9.5",
    protocol: 22,
    workspaces: workspaces.map(([id, label], index) => ({
      workspace_id: id,
      number: index + 1,
      label,
      focused: index === 0,
      pane_count: 1,
      tab_count: 1,
      active_tab_id: `${id}:t1`,
      agent_status: "idle",
    })),
    tabs: workspaces.map(([id]) => ({ tab_id: `${id}:t1`, workspace_id: id, number: 1, label: "", focused: true, pane_count: 1, agent_status: "idle" })),
    panes: panes.map((pane) => ({
      pane_id: pane.id,
      terminal_id: pane.terminal ?? `term-${pane.id}`,
      workspace_id: pane.ws,
      tab_id: `${pane.ws}:t1`,
      focused: false,
      cwd: pane.cwd ?? `/Users/demo/${pane.ws}`,
      ...(pane.label === undefined ? {} : { label: pane.label }),
      ...(pane.agent === undefined ? {} : { agent: pane.agent }),
      agent_status: pane.agent === undefined ? "unknown" : (pane.status ?? "idle"),
      revision: 1,
    })),
    layouts: [],
    agents: panes
      .filter((pane) => pane.agent !== undefined)
      .map((pane) => ({
        pane_id: pane.id,
        agent: pane.agent,
        agent_status: pane.status ?? "idle",
        ...(pane.session === undefined ? {} : { agent_session: { source: `herdr:${pane.agent}`, agent: pane.agent, kind: "id", value: pane.session } }),
      })),
  });
}

const miniPanes: PaneSpec[] = [
  { id: "w1:p1", ws: "w1", agent: "claude", session: "s-claude" },
  { id: "w1:p2", ws: "w1" },
  { id: "w1:p3", ws: "w1", agent: "codex", session: "s-codex", status: "working" },
  { id: "w2:p1", ws: "w2", agent: "grok", label: "relay-tests" },
];
const bookPanes: PaneSpec[] = [
  { id: "w1:p1", ws: "w1", agent: "codex", session: "s-book" },
  { id: "w1:p2", ws: "w1", cwd: "/Users/demo/scratch" },
];

function mini(panes = miniPanes, state: HandoffHost["state"] = "connected"): HandoffHost {
  return {
    id: "mini",
    name: "Mac mini",
    address: "r@mini:22",
    state,
    topology: topology(
      [
        ["w1", "herdr-companion"],
        ["w2", "ops"],
      ],
      panes,
    ),
  };
}

function book(panes = bookPanes, state: HandoffHost["state"] = "connected"): HandoffHost {
  return { id: "book", name: "MacBook", address: "r@book:22", state, topology: topology([["w1", "tidepool"]], panes) };
}

function lifeOf(hosts: readonly HandoffHost[]): PaneLife {
  const life = new PaneLife();
  life.observeHosts(hosts);
  return life;
}

function listFor(hosts: readonly HandoffHost[], query = "", recents: { hostId: string; paneId: string }[] = []) {
  const life = lifeOf(hosts);
  return handoffList(handoffMacs(hosts, life, { nowUnixMs: 0 }), { hostId: "mini", paneId: "w1:p1" }, recents, query);
}

const names = (rows: readonly HandoffTarget[]) => rows.map((row) => `${row.hostId}/${row.paneId}`);

// MARK: how it is written

describe("how a hand-off is written", () => {
  it("names the pane, its workspace and its machine in the context line", () => {
    expect(contextLine(source)).toBe("From claude in herdr-companion (Mac mini):");
    expect(contextLine({ ...source, name: "codex", workspace: " ", macName: "MacBook" })).toBe("From codex (MacBook):");
    expect(contextLine({ ...source, name: "zsh", workspace: "ops", macName: null })).toBe("From zsh in ops:");
  });

  it("sends a reply and a progress update as written under the context line", () => {
    const reply = "**Done.** The QR code is no longer clipped.\n\n- the frame\n- the inset";
    expect(handoffMessage(payload(reply, { type: "reply" }))).toBe(`From claude in herdr-companion (Mac mini):\n${reply}`);
    expect(handoffMessage(payload("Checking the build", { type: "progress" }))).toBe(
      "From claude in herdr-companion (Mac mini):\nChecking the build",
    );
  });

  it("sends the user's own message as they wrote it, with no context line", () => {
    const mine = "also check the phone layout\nand the iPad";
    expect(handoffMessage(payload(mine, { type: "ownMessage" }))).toBe(mine);
  });

  it("keeps a code block's fence and language", () => {
    expect(handoffMessage(payload("let step = 1\nprint(step)\n", { type: "code", language: "swift" }))).toBe(
      "From claude in herdr-companion (Mac mini):\n```swift\nlet step = 1\nprint(step)\n```",
    );
    expect(handoffBody("ls -la", { type: "code", language: null })).toBe("```\nls -la\n```");
    expect(handoffBody("ls", { type: "code", language: "  " })).toBe("```\nls\n```");
  });

  it("gives a fence inside the code a longer fence; backticks inside a line do not count", () => {
    const code = "Write it as:\n```swift\nlet x = 1\n```\n";
    expect(handoffBody(code, { type: "code", language: "markdown" })).toBe(`\`\`\`\`markdown\n${code}\`\`\`\``);
    expect(handoffBody("  `````\nx\n", { type: "code", language: null }).startsWith("``````\n")).toBe(true);
    expect(handoffBody("a ```b``` c\n", { type: "code", language: null })).toBe("```\na ```b``` c\n```");
  });

  it("keeps CRLF as written and adds no bare LF", () => {
    const message = handoffMessage(payload("first\r\nsecond\r\n", { type: "code", language: "sh" }));
    expect(message).toBe("From claude in herdr-companion (Mac mini):\r\n```sh\r\nfirst\r\nsecond\r\n```");
    expect(message.replaceAll("\r\n", "").includes("\n")).toBe(false);
    expect(handoffMessage(payload("one\r\ntwo", { type: "selection", selection: { type: "prose" } }))).toBe(
      "From claude in herdr-companion (Mac mini):\r\n> one\r\n> two",
    );
  });

  it("quotes a prose selection line by line, fences a code one and sends a mixed one as written", () => {
    expect(quoted("The frame is wrong.\n\nFix the inset.\n")).toBe("> The frame is wrong.\n>\n> Fix the inset.\n");
    expect(handoffBody("let x = 1", { type: "selection", selection: { type: "code", language: "swift" } })).toBe("```swift\nlet x = 1\n```");
    const mixed = "Run this:\n```\nmake\n```";
    expect(handoffBody(mixed, { type: "selection", selection: { type: "mixed" } })).toBe(mixed);
  });

  it("tells a selection prose or code by where it lies", () => {
    const reply = "Run the build:\n\n```swift\nlet step = 1\nprint(step)\n```\n\nThen check the log.\n~~~\nraw\n~~~\n";
    const at = (text: string, whole = reply): [number, number] => {
      const start = whole.indexOf(text);
      return [start, start + text.length];
    };
    expect(selectionKindIn(reply, ...at("Run the build"))).toEqual({ type: "prose" });
    expect(selectionKindIn(reply, ...at("check the log"))).toEqual({ type: "prose" });
    expect(selectionKindIn(reply, ...at("let step = 1\nprint"))).toEqual({ type: "code", language: "swift" });
    expect(selectionKindIn(reply, ...at("raw"))).toEqual({ type: "code", language: null });
    expect(selectionKindIn(reply, ...at("build:\n\n```swift\nlet"))).toEqual({ type: "mixed" });
    expect(selectionKindIn(reply, ...at("```swift"))).toEqual({ type: "mixed" });
    const blocks = fencedBlocks(reply);
    expect(blocks).toHaveLength(2);
    expect(reply.slice(blocks[0]!.code[0], blocks[0]!.code[1])).toBe("let step = 1\nprint(step)\n");
    expect(selectionKindIn("Text\n```py\nx = 1\n", 11, 16)).toEqual({ type: "code", language: "py" });
    const nested = "````\n```\ninside\n```\n````\nafter";
    expect(fencedBlocks(nested)).toHaveLength(1);
    expect(selectionKindIn(nested, ...at("after", nested))).toEqual({ type: "prose" });
  });

  it("tells a selection in the rendered reply by its ends", () => {
    const block = {};
    const prose = { inCode: false, language: null, block: null };
    const code = { inCode: true, language: "swift", block };
    expect(selectionKindOfEnds(prose, prose, false)).toEqual({ type: "prose" });
    expect(selectionKindOfEnds(code, code, true)).toEqual({ type: "code", language: "swift" });
    expect(selectionKindOfEnds(prose, code, true)).toEqual({ type: "mixed" });
    expect(selectionKindOfEnds(prose, prose, true)).toEqual({ type: "mixed" });
    expect(selectionKindOfEnds(code, { ...code, block: {} }, true)).toEqual({ type: "mixed" });
  });

  it("bounds what lands at 64 KB of UTF-8, the context line included", () => {
    expect(fits("a".repeat(65_536))).toBe(true);
    expect(fits("a".repeat(65_537))).toBe(false);
    expect(fits("→".repeat(21_846))).toBe(false);
    expect(tooLongText(65_537)).toBe("Too long to send (65 KB); copy it instead");
    expect(tooLongText(200_000)).toBe("Too long to send (196 KB); copy it instead");
    expect(fits(handoffMessage(payload("b".repeat(65_530), { type: "reply" })))).toBe(false);
  });

  it("says what is sent in a few words", () => {
    expect(payloadSummary(payload("let x\nlet y\n", { type: "code", language: "swift" }))).toBe("Code block · swift · 2 lines");
    expect(payloadSummary(payload("one", { type: "reply" }))).toBe("Reply · 1 line");
    expect(payloadSummary(payload("one", { type: "progress" }))).toBe("Progress update · 1 line");
  });
});

describe("a draft already in the box", () => {
  it("is no draft when empty or white space: the hand-off goes alone", () => {
    expect(land("X", null)).toEqual({ text: "X", start: 0, appended: false });
    expect(land("X", "")).toEqual({ text: "X", start: 0, appended: false });
    expect(land("X", " \n ")).toEqual({ text: "X", start: 0, appended: false });
  });

  it("is kept, the hand-off after one blank line in its own line-break style", () => {
    const cases: [string, string][] = [
      ["check this", "check this\n\nX"],
      ["check this\n", "check this\n\nX"],
      ["check this\n\n", "check this\n\nX"],
      ["check this\n\n\n", "check this\n\n\nX"],
      ["check this\n  ", "check this\n  \nX"],
      ["check\r\nthis", "check\r\nthis\r\n\r\nX"],
    ];
    for (const [draft, joined] of cases) {
      const landing = land("X", draft);
      expect(landing.text).toBe(joined);
      expect(landing.text.startsWith(draft)).toBe(true);
      expect(landing.appended).toBe(true);
      expect(landing.text.slice(landing.start)).toBe("X");
    }
  });
});

describe("the recent targets", () => {
  it("keeps the last five on this computer, newest first, each once", () => {
    const store = new Map<string, string>();
    const recents = new HandoffRecents({ getItem: (key) => store.get(key) ?? null, setItem: (key, value) => void store.set(key, value) });
    for (let i = 1; i <= 7; i += 1) recents.record({ hostId: "mini", paneId: `p${i}` });
    recents.record({ hostId: "mini", paneId: "p5" });
    expect(recents.list().map((recent) => recent.paneId)).toEqual(["p5", "p7", "p6", "p4", "p3"]);
    expect(addingRecent({ hostId: "a", paneId: "1" }, [{ hostId: "a", paneId: "1" }])).toEqual([{ hostId: "a", paneId: "1" }]);
    expect(new HandoffRecents({ getItem: () => "not json", setItem: () => undefined }).list()).toEqual([]);
  });
});

describe("the targets", () => {
  it("lists every pane of both machines by workspace, agents first, without the current one", () => {
    const list = listFor([mini(), book()]);
    // The answering machines by name ("Mac mini" before "MacBook").
    expect(list.groups.map((group) => `${group.macName}/${group.workspace}`)).toEqual([
      "Mac mini/herdr-companion",
      "Mac mini/ops",
      "MacBook/tidepool",
    ]);
    expect(names(listRows(list))).toEqual(["mini/w1:p3", "mini/w1:p2", "mini/w2:p1", "book/w1:p1", "book/w1:p2"]);
    expect(listRows(list).every((row) => row.macState === null && row.identity !== null)).toBe(true);
  });

  it("shows a machine not answering as Offline (its last panes, not pickable) and one connecting as Not connected", () => {
    const list = listFor([mini(), book(bookPanes, "offline")]);
    expect(list.groups.map((group) => `${group.macName}:${group.macState ?? "live"}`)).toEqual([
      "Mac mini:live",
      "Mac mini:live",
      "MacBook:Offline",
    ]);
    const offline = listRows(list).filter((row) => row.hostId === "book");
    expect(offline.every((row) => row.macState === "Offline" && row.identity === null)).toBe(true);
    expect(listFor([mini(), book(bookPanes, "connecting")]).groups.at(-1)?.macState).toBe("Not connected");
  });

  it("leaves out a machine with nothing known", () => {
    const empty: HandoffHost = { ...book(), topology: null, state: "connecting" };
    expect(listFor([mini(), empty]).groups.every((group) => group.hostId === "mini")).toBe(true);
  });

  it("puts the recent targets first, once, while their pane is there", () => {
    const list = listFor([mini(), book()], "", [
      { hostId: "book", paneId: "w1:p2" },
      { hostId: "mini", paneId: "gone" },
      { hostId: "book", paneId: "w1:p2" },
      { hostId: "mini", paneId: "w1:p1" },
    ]);
    expect(names(list.recent)).toEqual(["book/w1:p2"]);
    expect(names(listRows(list)).filter((id) => id === "book/w1:p2")).toHaveLength(1);
  });

  it("filters by name, kind, folder and workspace, every word, case and accents aside", () => {
    expect(names(listRows(listFor([mini(), book()], "CODEX")))).toEqual(["mini/w1:p3", "book/w1:p1"]);
    expect(names(listRows(listFor([mini(), book()], "scratch")))).toEqual(["book/w1:p2"]);
    expect(names(listRows(listFor([mini(), book()], "relay ops")))).toEqual(["mini/w2:p1"]);
    const row = listRows(listFor([mini()]))[0]!;
    expect(matchesQuery({ ...row, name: "Café" }, "cafe")).toBe(true);
    expect(names(listRows(listFor([mini(), book()], "nothing-like-it")))).toEqual([]);
  });

  it("moves the highlight over pickable rows only, stopping at either end", () => {
    const rows = listRows(listFor([mini(), book(bookPanes, "offline")]));
    const first = highlight.settle(null, rows);
    expect(first).toBe("mini|w1:p3");
    expect(highlight.move(first, -1, rows)).toBe("mini|w1:p3");
    let id = first;
    for (let i = 0; i < 10; i += 1) id = highlight.move(id, 1, rows);
    expect(id).toBe("mini|w2:p1");
    expect(highlight.target("book|w1:p1", rows)).toBeNull();
    expect(highlight.settle("book|w1:p1", rows)).toBe("mini|w1:p3");
  });
});

describe("what a pick is bound to", () => {
  const picked = (hosts: readonly HandoffHost[], id: string, life = lifeOf(hosts)) =>
    listRows(handoffList(handoffMacs(hosts, life, { nowUnixMs: 0 }), null, [], "")).find((row) => targetId(row) === id)!;
  const paneNow = (hosts: readonly HandoffHost[], id: string, life: PaneLife) =>
    handoffMacs(hosts, life, { nowUnixMs: 0 })
      .flatMap((mac) => mac.workspaces.flatMap((workspace) => workspace.panes.map((pane) => ({ key: `${mac.hostId}|${pane.paneId}`, pane }))))
      .find((entry) => entry.key === id)?.pane ?? null;

  it("goes while the pane shows what was picked", () => {
    const life = lifeOf([mini()]);
    const target = picked([mini()], "mini|w1:p3", life);
    expect(refusalFor(target, paneNow([mini()], "mini|w1:p3", life), life.connection("mini"))).toBeNull();
  });

  it("is refused when another kind replaced the program, another of the kind runs, or the pane closed", () => {
    const life = lifeOf([mini()]);
    const target = picked([mini()], "mini|w2:p1", life);
    const zsh = miniPanes.map((pane) => (pane.id === "w2:p1" ? { id: "w2:p1", ws: "w2", label: "relay-tests" } : pane));
    life.observeHosts([mini(zsh)]);
    expect(refusalFor(target, paneNow([mini(zsh)], "mini|w2:p1", life), life.connection("mini"))).toEqual({ type: "replaced", now: "shell" });
    const codex = picked([mini()], "mini|w1:p3", life);
    const another = miniPanes.map((pane) => (pane.id === "w1:p3" ? { ...pane, session: "s-other" } : pane));
    expect(refusalFor(codex, paneNow([mini(another)], "mini|w1:p3", life), life.connection("mini"))).toEqual({ type: "another" });
    const closed = miniPanes.filter((pane) => pane.id !== "w1:p3");
    expect(refusalFor(codex, paneNow([mini(closed)], "mini|w1:p3", life), life.connection("mini"))).toEqual({ type: "closed" });
  });

  it("is refused after the machine reconnected, and while it is not connected", () => {
    const life = lifeOf([mini()]);
    const target = picked([mini()], "mini|w1:p3", life);
    life.observeHosts([mini(miniPanes, "offline")]);
    expect(refusalFor(target, null, null)).toEqual({ type: "notConnected" });
    life.observeHosts([mini()]);
    expect(life.connection("mini")).toBe(2);
    expect(refusalFor(target, paneNow([mini()], "mini|w1:p3", life), life.connection("mini"))).toEqual({ type: "reconnected" });
  });

  it("is refused after an exit and a start seen in between, even with no session; an unchanged run with none still goes", () => {
    const noSession = miniPanes.map((pane) => (pane.id === "w1:p3" ? { ...pane, session: undefined } : pane));
    const life = lifeOf([mini(noSession)]);
    const target = picked([mini(noSession)], "mini|w1:p3", life);
    expect(target.identity?.session).toBeNull();
    life.observeHosts([mini(noSession)]);
    expect(refusalFor(target, paneNow([mini(noSession)], "mini|w1:p3", life), life.connection("mini"))).toBeNull();
    const exited = noSession.map((pane) => (pane.id === "w1:p3" ? { id: "w1:p3", ws: "w1" } : pane));
    life.observeHosts([mini(exited)]);
    life.observeHosts([mini(noSession)]);
    expect(life.arrival(mini(), "w1:p3")).toBe(2);
    expect(refusalFor(target, paneNow([mini(noSession)], "mini|w1:p3", life), life.connection("mini"))).toEqual({ type: "another" });
  });

  it("reads each pane's program from the snapshot", () => {
    const ids = identitiesOf(mini().topology!, 3, (pane) => (pane === "w1:p3" ? 2 : 1));
    expect(ids.get("w1:p3")).toEqual({ connection: 3, terminalID: "term-w1:p3", agent: "codex", session: "s-codex", arrival: 2 });
    expect(ids.get("w1:p2")).toEqual({ connection: 3, terminalID: "term-w1:p2", agent: null, session: null, arrival: 1 });
  });
});

describe("the toasts", () => {
  const target = (): HandoffTarget => listRows(listFor([mini(), book()])).find((row) => targetId(row) === "mini|w2:p1")!;

  it("name the pane and say why a pick was refused", () => {
    expect(handoffNotice.sent(target())).toBe("Sent to relay-tests in ops");
    expect(handoffNotice.refused(target(), { type: "replaced", now: "shell" }, "sendNow")).toBe(
      "relay-tests now runs shell, not grok: not sent. The text is copied.",
    );
    expect(handoffNotice.refused(target(), { type: "reconnected" }, "draft")).toBe(
      "Mac mini reconnected after the pick: not put in its box. The text is copied.",
    );
    expect(handoffNotice.appended(target())).toBe("Added to relay-tests in ops after the draft already in its box");
    expect(handoffNotice.notSent(target(), "Not sent: the pane is gone")).toBe(
      "Not sent to relay-tests in ops. The pane is gone. The text is in its message box.",
    );
  });

  it("tell a refused Send now from one that may have arrived", () => {
    // The pane changed: stale, never put in the box of what is there now.
    expect(sendFailure("Not sent: another agent is in this pane now")).toBe("stale");
    expect(sendFailure("Claude exited; not sent")).toBe("stale");
    expect(sendFailure("Not run: a shell command is one line. The text is kept.")).toBe("refused");
    expect(sendFailure("Not sent: the app could not check the pane. The text is kept.")).toBe("refused");
    expect(sendFailure("Sent, but the Mac did not confirm it. Check the agent before sending again.")).toBe("unconfirmed");
    expect(sendFailure("Typed into codex, but the Mac did not confirm its Return. Check the agent before sending again.")).toBe("unconfirmed");
    // A prompt with no answer says it did not go: the text goes back in the box.
    expect(sendFailure("Not sent: Claude Code did not take the message. It is still in the box.")).toBe("refused");
  });
});

// MARK: the picker

describe("the picker", () => {
  function picker(hosts: () => HandoffHost[], text = "the reply", recents: { hostId: string; paneId: string }[] = []) {
    const life = new PaneLife();
    life.observeHosts(hosts());
    const acts: [string, string][] = [];
    const copied: string[] = [];
    const state = new HandoffPicker(
      payload(text, { type: "reply" }),
      () => {
        life.observeHosts(hosts());
        return handoffMacs(hosts(), life, { nowUnixMs: 0 });
      },
      recents,
      { hostId: "mini", paneId: "w1:p1" },
      (target, action) => acts.push([targetId(target), action]),
      (copiedText) => copied.push(copiedText),
    );
    return { state, acts, copied };
  }

  it("highlights the first pickable row; Return opens it with the draft, ⌘Return sends it now", () => {
    const a = picker(() => [mini(), book()]);
    expect(a.state.highlighted).toBe("mini|w1:p3");
    a.state.move(1);
    a.state.perform("sendNow");
    expect(a.acts).toEqual([["mini|w1:p2", "sendNow"]]);
    const b = picker(() => [mini(), book()]);
    b.state.perform("draft");
    expect(b.acts).toEqual([["mini|w1:p3", "draft"]]);
  });

  it("acts once: a second Send now, a Return or a click while it closes does nothing", () => {
    const a = picker(() => [mini(), book()]);
    a.state.perform("sendNow");
    a.state.perform("sendNow");
    a.state.perform("draft");
    a.state.click(a.state.rows[1]!);
    expect(a.acts).toHaveLength(1);
    expect(a.state.hasActed).toBe(true);
  });

  it("follows the machines while open: a machine going offline greys its rows and is not picked", () => {
    let bookState: HandoffHost["state"] = "connected";
    const a = picker(() => [mini(), book(bookPanes, bookState)]);
    const first = a.state.rows.find((row) => row.hostId === "book")!;
    a.state.hover(first);
    expect(a.state.highlighted).toBe("book|w1:p1");
    bookState = "offline";
    a.state.click(first);
    expect(a.acts).toEqual([]);
    expect(a.state.rows.filter((row) => row.hostId === "book").every((row) => row.macState === "Offline")).toBe(true);
    expect(a.state.highlighted).toBe("mini|w1:p3");
  });

  it("carries out the row as the user picked it, never what a refresh shows in its place", () => {
    let panes = miniPanes;
    const a = picker(() => [mini(panes)]);
    a.state.move(1);
    a.state.move(-1);
    const chosen = a.state.picked!;
    expect(targetId(chosen)).toBe("mini|w1:p3");
    panes = miniPanes.map((pane) => (pane.id === "w1:p3" ? { ...pane, agent: "claude", session: "s-new" } : pane));
    a.state.refresh();
    expect(a.state.shown?.kind).toBe("claude");
    a.state.perform("sendNow");
    expect(a.acts).toEqual([["mini|w1:p3", "sendNow"]]);
    expect(a.state.picked?.identity?.agent).toBe("codex");
  });

  it("says a text over 64 KB is too long, offers Copy and picks nothing", () => {
    const a = picker(() => [mini()], "x".repeat(70_000));
    expect(a.state.fits).toBe(false);
    a.state.perform("draft");
    a.state.move(1);
    expect(a.acts).toEqual([]);
    a.state.copy();
    expect(a.copied).toEqual(["x".repeat(70_000)]);
    expect(a.state.copied).toBe(true);
  });
});

// MARK: the delivery

describe("carrying out a pick", () => {
  const store = new HandoffStore();
  afterEach(() => store.reset());

  function deps(sendResult: () => Promise<void> = () => Promise.resolve()) {
    const drafts = new ComposerDrafts();
    const kv = new Map<string, string>();
    const sends: { hostId: string; paneId: string; text: string; binding: SendBinding }[] = [];
    const opened: string[] = [];
    const copied: string[] = [];
    const d: DeliveryDeps = {
      store,
      drafts,
      recents: new HandoffRecents({ getItem: (key) => kv.get(key) ?? null, setItem: (key, value) => void kv.set(key, value) }),
      copy: (text) => copied.push(text),
      open: (target) => opened.push(targetId(target)),
      send: (hostId, paneId, text, binding) => {
        sends.push({ hostId, paneId, text, binding });
        return sendResult();
      },
    };
    return { d, drafts, sends, opened, copied };
  }
  const code = payload("let x = 1\n", { type: "code", language: "swift" });
  const row = (id: string) => listRows(handoffList(store.macs(0), null, [], "")).find((candidate) => targetId(candidate) === id)!;

  it("opens a code block's pick with the draft and its context line in the box of codex on the other machine", async () => {
    store.setHosts([mini(), book()] as never);
    const t = deps();
    await deliverHandoff(t.d, code, row("book|w1:p1"), "draft");
    expect(t.drafts.get("book/w1:p1").text).toBe("From claude in herdr-companion (Mac mini):\n```swift\nlet x = 1\n```");
    expect(t.opened).toEqual(["book|w1:p1"]);
    expect(t.sends).toEqual([]);
    expect(store.takeLanding("book/w1:p1")).toBe(0);
    expect(t.d.recents.list()).toEqual([{ hostId: "book", paneId: "w1:p1" }]);
    expect(store.toast()).toBeNull();
  });

  it("keeps a draft already in the box and says so", async () => {
    store.setHosts([mini(), book()] as never);
    const t = deps();
    t.drafts.edit("book/w1:p1", "my own note");
    await deliverHandoff(t.d, payload("the reply", { type: "reply" }), row("book|w1:p1"), "draft");
    expect(t.drafts.get("book/w1:p1").text).toBe("my own note\n\nFrom claude in herdr-companion (Mac mini):\nthe reply");
    expect(store.toast()?.text).toBe("Added to codex in tidepool after the draft already in its box");
  });

  it("sends now through the bound Send with what was picked, and registers no pending bubble", async () => {
    store.setHosts([mini(), book()] as never);
    const t = deps();
    const pending = new PendingMessages();
    await deliverHandoff(t.d, payload("the reply", { type: "reply" }), row("book|w1:p1"), "sendNow");
    expect(t.sends).toEqual([
      {
        hostId: "book",
        paneId: "w1:p1",
        text: "From claude in herdr-companion (Mac mini):\nthe reply",
        binding: { terminalID: "term-w1:p1", isAgent: true, kind: "codex", session: "s-book", run: { connection: 1, arrival: 1 } },
      },
    ]);
    expect(pending.forPane("book/w1:p1")).toEqual([]);
    const { pendingMessages } = await import("../src/renderer/chat/chat-state");
    expect(pendingMessages.forPane("book/w1:p1")).toEqual([]);
    expect(store.toast()?.text).toBe("Sent to codex in tidepool");
    expect(store.toast()?.target?.paneId).toBe("w1:p1");
    expect(t.drafts.get("book/w1:p1").text).toBe("");
  });

  it("puts a refused Send now in the box, and never one that may have arrived", async () => {
    store.setHosts([mini(), book()] as never);
    const refused = deps(() =>
      Promise.reject(new Error("Error invoking remote method 'herdr:pane-send': Error: Not sent: the app could not check that codex is still in its pane. The text is kept.")),
    );
    await deliverHandoff(refused.d, payload("the reply", { type: "reply" }), row("book|w1:p1"), "sendNow");
    expect(refused.drafts.get("book/w1:p1").text).toContain("the reply");
    expect(store.toast()?.text).toBe(
      "Not sent to codex in tidepool. The app could not check that codex is still in its pane. The text is in its message box.",
    );
    // Another agent in the pane now: the text is copied and put in no box.
    const replaced = deps(() => Promise.reject(new Error("Error invoking remote method 'herdr:pane-send': Error: Not sent: another agent is in this pane now")));
    await deliverHandoff(replaced.d, payload("the reply", { type: "reply" }), row("book|w1:p1"), "sendNow");
    expect(replaced.drafts.get("book/w1:p1").text).toBe("");
    expect(store.toast()?.text).toBe("Not sent to codex in tidepool. Another agent is in this pane now. The text is copied.");
    const maybe = deps(() => Promise.reject(new Error("Sent, but the Mac did not confirm it. Check the agent before sending again.")));
    await deliverHandoff(maybe.d, payload("the reply", { type: "reply" }), row("book|w1:p1"), "sendNow");
    expect(maybe.drafts.get("book/w1:p1").text).toBe("");
    expect(store.toast()?.text).toMatch(/^Maybe sent to codex in tidepool\./);
  });

  it("refuses a pick whose pane now runs something else: nothing sent or put in a box, the text copied", async () => {
    store.setHosts([mini()] as never);
    const target = row("mini|w2:p1");
    const zsh = miniPanes.map((pane) => (pane.id === "w2:p1" ? { id: "w2:p1", ws: "w2", label: "relay-tests" } : pane));
    store.setHosts([mini(zsh)] as never);
    const t = deps();
    expect(checkPick(store, target)).toEqual({ type: "replaced", now: "shell" });
    await deliverHandoff(t.d, payload("the reply", { type: "reply" }), target, "sendNow");
    expect(t.sends).toEqual([]);
    expect(t.drafts.get("mini/w2:p1").text).toBe("");
    expect(t.copied).toEqual(["From claude in herdr-companion (Mac mini):\nthe reply"]);
    expect(store.toast()).toMatchObject({ text: "relay-tests now runs shell, not grok: not sent. The text is copied.", target: null });
  });

  it("refuses a pick across a reconnect", async () => {
    store.setHosts([mini()] as never);
    const target = row("mini|w1:p3");
    store.setHosts([mini(miniPanes, "offline")] as never);
    store.setHosts([mini()] as never);
    const t = deps();
    await deliverHandoff(t.d, code, target, "draft");
    expect(t.opened).toEqual([]);
    expect(store.toast()?.text).toBe("Mac mini reconnected after the pick: not put in its box. The text is copied.");
  });

  it("sends nothing over the bound", async () => {
    store.setHosts([mini()] as never);
    const t = deps();
    await deliverHandoff(t.d, payload("y".repeat(70_000), { type: "reply" }), row("mini|w1:p3"), "sendNow");
    expect(t.sends).toEqual([]);
    expect(t.copied).toEqual([]);
  });
});

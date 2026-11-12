// The page's side of kept drafts: every change of a pane's draft
// goes to the main process (its text, its uploaded chips by their paths, the
// names of local files not uploaded), a draft sent is cleared there, and on
// launch each pane's draft comes back into its box when its machine shows the
// pane, a file that had not uploaded named in the chip row. A draft whose pane
// was gone is listed above the box of that machine's panes (Kept drafts): Put
// in box, Copy, Discard.

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { HostView } from "../src/shared/ipc-contract";
import type { SidebarRow } from "../src/shared/sidebar-model";
import type { DraftInput, DraftsState } from "../src/shared/drafts";
import { HookHost, elements, find } from "./support/fake-hooks";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  const hooks = { ...fakeReact, useLayoutEffect: fakeReact.useEffect };
  return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});

const { Composer } = await import("../src/renderer/components/MainPane");
const { composerDrafts, draftKey } = await import("../src/renderer/components/composer-drafts");
const { draftPersistence } = await import("../src/renderer/components/draft-persistence");

let saved: { hostId: string; paneId: string; draft: DraftInput | null }[];
let sends: { text: string; resolve(): void }[];
let kept: { id: string; action: string }[];
let copied: string[];

beforeEach(() => {
  saved = [];
  sends = [];
  kept = [];
  copied = [];
  draftPersistence.detach();
  composerDrafts.clear();
  vi.stubGlobal("window", {
    herdrDesktop: {
      sendToPane: (_h: string, _p: string, text: string) => new Promise<void>((resolve) => sends.push({ text, resolve })),
      uploadAttachment: async () => {
        throw new Error("no upload expected");
      },
      saveDraft: (hostId: string, paneId: string, draft: DraftInput | null) => saved.push({ hostId, paneId, draft }),
      keptDraft: async (id: string, action: string) => {
        kept.push({ id, action });
        return action === "take" ? { text: "from a gone pane" } : null;
      },
      copyText: (text: string) => copied.push(text),
    },
    innerHeight: 900,
  });
});

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

const host = { id: "mac-mini", name: "Mac mini", state: "connected" } as HostView;
const pane = { paneID: "w7:p1", name: "Opus", workspaceLabel: "ops", kind: "claude", isAgent: false } as SidebarRow;
const key = draftKey(host.id, pane.paneID);
const path = "/Users/demo/.herdr-companion-attachments-0123/attachment-1.png";

const state = (extra: Partial<DraftsState> = {}): DraftsState => ({
  drafts: [{ hostId: "mac-mini", paneId: "w7:p1", text: "where I was", chips: [{ path, name: "Screenshot.png", image: true }], lost: ["build.log"], savedAt: 1 }],
  kept: [],
  ...extra,
});

function composer() {
  const ui = new HookHost(Composer as (props: object) => unknown, { host, row: pane });
  ui.render();
  const textarea = () => find(ui.tree, "textarea")!;
  return {
    ui,
    type: (value: string) => (textarea().props["onChange"] as (e: unknown) => void)({ target: { value } }),
    enter: () =>
      (textarea().props["onKeyDown"] as (e: unknown) => void)({ key: "Enter", shiftKey: false, nativeEvent: { isComposing: false }, preventDefault: () => undefined }),
    value: () => textarea().props["value"],
    text: () =>
      elements(ui.tree)
        .map((e) => e.props.children)
        .flat()
        .filter((child): child is string => typeof child === "string")
        .join("|"),
  };
}

describe("saving from the page", () => {
  it("each change goes to the main process with the pane's machine and pane", () => {
    draftPersistence.attach(window.herdrDesktop);
    composerDrafts.edit(key, "h");
    composerDrafts.edit(key, "hi");
    expect(saved).toEqual([
      { hostId: "mac-mini", paneId: "w7:p1", draft: { text: "h", chips: [], lost: [] } },
      { hostId: "mac-mini", paneId: "w7:p1", draft: { text: "hi", chips: [], lost: [] } },
    ]);
  });

  it("uploaded chips go by their paths; a local file not uploaded by its name only", () => {
    draftPersistence.attach(window.herdrDesktop);
    composerDrafts.attach(key, [
      { name: "Screenshot.png", extension: "png", image: true, data: new Uint8Array([1]) },
      { name: "build.log", extension: "log", image: false, data: new Uint8Array([2]) },
    ]);
    const [first] = composerDrafts.get(key).chips;
    composerDrafts.setChip(key, first!.id, { kind: "uploaded", path });
    expect(saved.at(-1)!.draft).toEqual({ text: "", chips: [{ path, name: "Screenshot.png", image: true }], lost: ["build.log"] });
  });

  it("a draft sent is cleared there", async () => {
    draftPersistence.attach(window.herdrDesktop);
    const c = composer();
    c.type("ship it");
    c.enter();
    sends[0]!.resolve();
    await flush();
    expect(saved.at(-1)).toEqual({ hostId: "mac-mini", paneId: "w7:p1", draft: null });
  });
});

describe("launching again", () => {
  it("puts each pane's draft back in its box, its uploaded chip with it and the file that had not uploaded named", async () => {
    draftPersistence.attach(window.herdrDesktop);
    draftPersistence.restore(state());
    // Restoring writes nothing back.
    expect(saved).toEqual([]);
    const c = composer();
    expect(c.value()).toBe("where I was");
    expect(composerDrafts.get(key).chips.map((chip) => [chip.name, chip.state])).toEqual([["Screenshot.png", { kind: "uploaded", path }]]);
    expect(c.text()).toContain("Not kept: build.log (it had not uploaded when the app closed)");
    // Sending it uploads nothing again: the path goes with the text.
    c.enter();
    expect(sends.map((sent) => sent.text)).toEqual([`where I was ${path}`]);
  });

  it("never writes over a draft typed before the saved ones arrived", () => {
    composerDrafts.edit(key, "typed already");
    draftPersistence.restore(state());
    expect(composerDrafts.get(key).text).toBe("typed already");
  });

  it("a pane the main process found gone loses its draft here (it is under Kept drafts now)", () => {
    draftPersistence.attach(window.herdrDesktop);
    draftPersistence.restore(state());
    draftPersistence.changed({ state: state({ drafts: [] }), gone: [{ hostId: "mac-mini", paneId: "w7:p1" }] });
    expect(composerDrafts.get(key).text).toBe("");
    expect(saved).toEqual([]);
  });
});

describe("Kept drafts above the box", () => {
  const keptState = state({
    drafts: [],
    kept: [
      { id: "k1", hostId: "mac-mini", hostLabel: "Mac mini", paneId: "w7:p9", agentName: "claude", text: "from a gone pane", chips: [], reason: "Its pane is gone.", at: 1 },
      { id: "k2", hostId: "build-box", hostLabel: "build-box", paneId: "w2:p1", agentName: null, text: "elsewhere", chips: [], reason: "Its pane is gone.", at: 2 },
    ],
  });

  it("lists this machine's, with Put in box, Copy and Discard", async () => {
    draftPersistence.attach(window.herdrDesktop);
    draftPersistence.restore(keptState);
    const c = composer();
    expect(c.text()).toContain("A draft for claude (pane w7:p9) whose pane is gone");
    expect(c.text()).not.toContain("elsewhere");
    const button = (label: string) => elements(c.ui.tree).find((e) => e.type === "button" && e.props["children"] === label)!;
    (button("Copy").props["onClick"] as () => void)();
    expect(copied).toEqual(["from a gone pane"]);
    (button("Put in box").props["onClick"] as () => void)();
    await flush();
    // The box takes it first; then Kept lets it go.
    expect(kept).toEqual([{ id: "k1", action: "discard" }]);
    expect(composerDrafts.get(key).text).toBe("from a gone pane");
  });

  it("Put in box waits for an empty box; Discard asks the main process", async () => {
    draftPersistence.attach(window.herdrDesktop);
    draftPersistence.restore(keptState);
    const c = composer();
    c.type("busy");
    const button = (label: string) => elements(c.ui.tree).find((e) => e.type === "button" && e.props["children"] === label)!;
    expect(button("Put in box").props["aria-disabled"]).toBe(true);
    (button("Discard").props["onClick"] as () => void)();
    await flush();
    expect(kept).toEqual([{ id: "k1", action: "discard" }]);
  });
});

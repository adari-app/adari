// Send empties the box at once, the way T3 Code
// does. On the press the box empties and the bubble shows while the send runs
// (it includes main's read of Claude's box first). A send that fails
// brings its text back with the same note, on top of anything typed since,
// with a newline (esc-back's putBackInBox rule), and its bubble goes. The
// saved draft keeps the text from the press to the result, so a crash then
// does not lose it.

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { HostView } from "../src/shared/ipc-contract";
import type { SidebarRow } from "../src/shared/sidebar-model";
import { HookHost, find } from "./support/fake-hooks";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  return { ...actual, ...fakeReact, default: { ...actual, ...fakeReact } };
});

const { Composer } = await import("../src/renderer/components/MainPane");
const { ComposerDrafts, composerDrafts, sendDraft } = await import("../src/renderer/components/composer-drafts");
const { draftInput } = await import("../src/renderer/components/draft-persistence");
const { pendingMessages, sendWithPending } = await import("../src/renderer/chat/chat-state");

interface Held {
  readonly text: string;
  resolve(): void;
  reject(error: Error): void;
}

let held: Held[] = [];
const key = "mac-mini/w1:p1";

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
};

/** A send that waits for the test, through the same pending-bubble path an agent pane's Send takes. */
const heldSend = (h: string, p: string, t: string): Promise<void> =>
  sendWithPending(
    (_hh, _pp, tt) => new Promise<void>((resolve, reject) => held.push({ text: tt, resolve, reject })),
    h,
    p,
    t,
    true,
  );

const bubbles = (): string[] => pendingMessages.forPane(key).map((message) => message.text);

beforeEach(() => {
  held = [];
  pendingMessages.clear();
  composerDrafts.clear();
});

describe("the box on Send", () => {
  it("is empty right after the press while the send is still pending, and the bubble shows", () => {
    const drafts = new ComposerDrafts();
    drafts.edit(key, "check the build");
    expect(sendDraft(drafts, heldSend, "mac-mini", "w1:p1")).toBe(true);
    expect(held.map((send) => send.text)).toEqual(["check the build"]);
    expect(drafts.get(key).text).toBe("");
    expect(drafts.get(key).sending).toBe(true);
    expect(bubbles()).toEqual(["check the build"]);
  });

  it("a refused send brings the text back with the note, and no bubble remains", async () => {
    const drafts = new ComposerDrafts();
    drafts.edit(key, "deploy it");
    sendDraft(drafts, heldSend, "mac-mini", "w1:p1");
    expect(drafts.get(key).text).toBe("");
    held[0]!.reject(new Error("Error invoking remote method 'herdr:pane-send': Error: Not sent: Claude Code's box still has text. Open Terminal to clear it."));
    await flush();
    expect(drafts.get(key).text).toBe("deploy it");
    expect(drafts.get(key).error).toBe("Not sent: Claude Code's box still has text. Open Terminal to clear it.");
    expect(drafts.get(key).sending).toBe(false);
    expect(bubbles()).toEqual([]);
  });

  it("text typed during a pending send that then fails: the box ends <failed>\\n<typed>", async () => {
    const drafts = new ComposerDrafts();
    drafts.edit(key, "first thought");
    sendDraft(drafts, heldSend, "mac-mini", "w1:p1");
    drafts.edit(key, "second thought");
    held[0]!.reject(new Error("not connected"));
    await flush();
    expect(drafts.get(key).text).toBe("first thought\nsecond thought");
    expect(drafts.get(key).error).toBe("not connected");
    expect(bubbles()).toEqual([]);
  });

  it("a send that succeeds leaves the box empty, with exactly one message", async () => {
    const drafts = new ComposerDrafts();
    drafts.edit(key, "ship it");
    sendDraft(drafts, heldSend, "mac-mini", "w1:p1");
    held[0]!.resolve();
    await flush();
    expect(drafts.get(key).text).toBe("");
    expect(drafts.get(key).sending).toBe(false);
    expect(drafts.get(key).error).toBeNull();
    expect(held).toHaveLength(1);
    expect(bubbles()).toEqual(["ship it"]);
  });

  it("text typed during a send that succeeds stays as it is", async () => {
    const drafts = new ComposerDrafts();
    drafts.edit(key, "ship it");
    sendDraft(drafts, heldSend, "mac-mini", "w1:p1");
    drafts.edit(key, "and then the docs");
    held[0]!.resolve();
    await flush();
    expect(drafts.get(key).text).toBe("and then the docs");
    expect(bubbles()).toEqual(["ship it"]);
  });

  it("a press does not lose the text to a crash: the saved draft keeps it until the result", async () => {
    const drafts = new ComposerDrafts();
    const saved: (string | null)[] = [];
    drafts.setSaver((_key, draft) => saved.push(draftInput(draft)?.text ?? null));
    drafts.edit(key, "keep me");
    sendDraft(drafts, heldSend, "mac-mini", "w1:p1");
    expect(drafts.get(key).text).toBe("");
    expect(saved.at(-1)).toBe("keep me");
    drafts.edit(key, "typed meanwhile");
    expect(saved.at(-1)).toBe("keep me\ntyped meanwhile");
    held[0]!.resolve();
    await flush();
    expect(saved.at(-1)).toBe("typed meanwhile");
  });

  it("a failed send's saved draft is the box as it ends", async () => {
    const drafts = new ComposerDrafts();
    const saved: (string | null)[] = [];
    drafts.setSaver((_key, draft) => saved.push(draftInput(draft)?.text ?? null));
    drafts.edit(key, "keep me");
    sendDraft(drafts, heldSend, "mac-mini", "w1:p1");
    held[0]!.reject(new Error("not connected"));
    await flush();
    expect(saved.at(-1)).toBe("keep me");
  });

  it("a draft kept through a crash is not restored over a send under way", () => {
    const drafts = new ComposerDrafts();
    drafts.edit(key, "going");
    sendDraft(drafts, heldSend, "mac-mini", "w1:p1");
    expect(drafts.restore(key, "older kept draft", [], [])).toBe(false);
    expect(drafts.get(key).text).toBe("");
  });

  it("an attachment that fails to upload brings the text back on top of what was typed", async () => {
    const drafts = new ComposerDrafts();
    drafts.edit(key, "the log");
    drafts.attach(key, [{ name: "run.log", extension: "log", image: false, data: new Uint8Array([1]) }]);
    sendDraft(drafts, heldSend, "mac-mini", "w1:p1", async () => {
      throw new Error("disk full");
    });
    drafts.edit(key, "typed");
    await flush();
    expect(drafts.get(key).text).toBe("the log\ntyped");
    expect(drafts.get(key).error).toBe("Not sent: run.log did not upload (disk full). The message is kept.");
    expect(drafts.get(key).chips.map((chip) => chip.state.kind)).toEqual(["failed"]);
    expect(held).toHaveLength(0);
  });
});

describe("the real Composer", () => {
  const mac = { id: "mac-mini", name: "Mac mini" } as HostView;
  const pane = { paneID: "w1:p1", name: "A", workspaceLabel: "ops" } as SidebarRow;
  let sends: Held[] = [];

  beforeEach(() => {
    sends = [];
    vi.stubGlobal("window", {
      herdrDesktop: {
        sendToPane: (_h: string, _p: string, text: string) =>
          new Promise<void>((resolve, reject) => sends.push({ text, resolve, reject })),
      },
    });
  });

  function composer() {
    const ui = new HookHost(Composer, { host: mac, row: pane });
    ui.render();
    const textarea = () => find(ui.tree, "textarea")!;
    return {
      ui,
      type: (value: string) => (textarea().props["onChange"] as (e: unknown) => void)({ target: { value } }),
      enter: () =>
        (textarea().props["onKeyDown"] as (e: unknown) => void)({
          key: "Enter",
          shiftKey: false,
          nativeEvent: { isComposing: false },
          preventDefault: () => undefined,
        }),
      value: () => textarea().props["value"],
      error: () => find(ui.tree, "span", "cmp-note-t")?.props["children"],
    };
  }

  it("Enter empties the box at once; a refusal brings it back with the note", async () => {
    const c = composer();
    c.type("hello");
    c.enter();
    expect(sends.map((send) => send.text)).toEqual(["hello"]);
    expect(c.value()).toBe("");
    c.type("more");
    sends[0]!.reject(new Error("Error invoking remote method 'herdr:pane-send': Error: not connected"));
    await flush();
    expect(c.value()).toBe("hello\nmore");
    expect(c.error()).toBe("not connected");
    c.ui.unmount();
  });
});

// The composer's attachments. The + button's
// picker, a paste (⌘V) of an image or a copied file, and a drop onto the box
// or the Chat each become a chip in the box (x removes it); each uploads to
// the machine as it is attached (not on Send), and the
// message goes with their paths after the text; an upload that fails keeps
// the draft and says why. The real Composer and ChatView run on the small
// hooks host with a fake bridge.

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { HostView } from "../src/shared/ipc-contract";
import type { SidebarRow } from "../src/shared/sidebar-model";
import { HookHost, elements, find } from "./support/fake-hooks";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  const hooks = { ...fakeReact, useLayoutEffect: fakeReact.useEffect };
  return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});

// Images are re-encoded in the page (canvas); here a fixed PNG stands for it.
vi.mock("../src/renderer/components/image-prepare", () => ({
  prepareImage: async (file: { name: string; size: number }) => {
    if (file.name.startsWith("broken")) throw new Error("That file is not a readable image.");
    return { data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), extension: "png" };
  },
}));

const { Composer } = await import("../src/renderer/components/MainPane");
const { composerDrafts, draftKey } = await import("../src/renderer/components/composer-drafts");
const { intakeFiles } = await import("../src/renderer/components/attachments");
const { ChatView } = await import("../src/renderer/chat/ChatView");

const home = "/Users/fixture/.herdr-companion-attachments-0123456789abcdef0123456789abcdef";
const remote = (n: number, ext = "png") => `${home}/attachment-${n}${n}${n}${n}${n}${n}${n}${n}-1111-4111-8111-111111111111.${ext}`;

interface Upload {
  readonly hostId: string;
  readonly data: Uint8Array;
  readonly extension: string;
  resolve(path: string): void;
  reject(error: Error): void;
}

let sends: { text: string; resolve(): void; reject(error: Error): void }[] = [];
let uploads: Upload[] = [];
let clipboardFiles = { files: [] as { name: string; type: string; data: Uint8Array }[], refused: [] as string[], excess: [] as string[], failures: [] as string[] };

beforeEach(() => {
  sends = [];
  uploads = [];
  clipboardFiles = { files: [], refused: [], excess: [], failures: [] };
  composerDrafts.clear();
  vi.stubGlobal("window", {
    herdrDesktop: {
      sendToPane: (_h: string, _p: string, text: string) => new Promise<void>((resolve, reject) => sends.push({ text, resolve, reject })),
      uploadAttachment: (hostId: string, data: Uint8Array, extension: string) =>
        new Promise((resolve, reject) =>
          uploads.push({ hostId, data, extension, resolve: (path) => resolve({ path, byteCount: data.byteLength }), reject }),
        ),
      clipboardFiles: async () => clipboardFiles,
      onChatUpdate: () => () => undefined,
      openChat: () => undefined,
      closeChat: () => undefined,
      setChatFollowing: () => undefined,
      copyText: () => undefined,
    },
    getSelection: () => null,
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      disconnect(): void {}
    },
  );
});

const mac = { id: "mac-mini", name: "Mac mini", state: "connected" } as HostView;
const pane = { paneID: "w1:p1", name: "A", workspaceLabel: "ops" } as SidebarRow;
const key = draftKey(mac.id, pane.paneID);

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

const file = (name: string, type: string, bytes: number[] = [1, 2, 3]) => ({
  name,
  type,
  size: bytes.length,
  arrayBuffer: async () => new Uint8Array(bytes).buffer,
});

function composer() {
  const ui = new HookHost(Composer, { host: mac, row: pane });
  ui.render();
  const textarea = () => find(ui.tree, "textarea")!;
  const wrap = () => elements(ui.tree).find((e) => String(e.props["className"] ?? "").startsWith("cmp-wrap"))!;
  return {
    ui,
    type: (value: string) => (textarea().props["onChange"] as (e: unknown) => void)({ target: { value } }),
    enter: () =>
      (textarea().props["onKeyDown"] as (e: unknown) => void)({ key: "Enter", shiftKey: false, nativeEvent: { isComposing: false }, preventDefault: () => undefined }),
    paste: (data: { types: string[]; files: unknown[]; text?: string }) => {
      let prevented = false;
      const clipboardData = { ...data, getData: (type: string) => (type === "text/plain" ? (data.text ?? "") : "") };
      (textarea().props["onPaste"] as (e: unknown) => void)({ clipboardData, preventDefault: () => (prevented = true) });
      return prevented;
    },
    drop: (files: unknown[]) => {
      let prevented = false;
      (wrap().props["onDrop"] as (e: unknown) => void)({ dataTransfer: { types: ["Files"], files }, preventDefault: () => (prevented = true), stopPropagation: () => undefined });
      return prevented;
    },
    pick: (files: unknown[]) => {
      const input = elements(ui.tree).find((e) => e.type === "input" && e.props["type"] === "file")!;
      (input.props["onChange"] as (e: unknown) => void)({ target: { files, value: "x" } });
    },
    plus: () => elements(ui.tree).find((e) => e.type === "button" && e.props["aria-label"] === "Attach files"),
    chips: () => elements(ui.tree).filter((e) => String(e.props["className"] ?? "").startsWith("att ")),
    removeButtons: () => elements(ui.tree).filter((e) => e.type === "button" && String(e.props["aria-label"] ?? "").startsWith("Remove ")),
    error: () => find(ui.tree, "span", "cmp-note-t")?.props["children"], // the note line under the box
    value: () => textarea().props["value"],
  };
}

describe("the composer's attachments", () => {
  it("has a + that opens the picker for images and the files the Swift app takes", () => {
    const c = composer();
    expect(c.plus()).toBeDefined();
    const input = elements(c.ui.tree).find((e) => e.type === "input" && e.props["type"] === "file")!;
    expect(input.props["accept"]).toBe("image/*,.pdf,.txt,.text,.log,.md,.markdown,.json,.csv,.zip");
    expect(input.props["multiple"]).toBe(true);
  });

  it("turns picked files into chips, refuses other kinds by name", async () => {
    const c = composer();
    c.pick([file("shot.png", "image/png"), file("build.log", "text/plain"), file("tool.sh", "text/x-sh")]);
    await flush();
    expect(composerDrafts.get(key).chips.map((chip) => [chip.name, chip.extension, chip.image])).toEqual([
      ["shot.png", "png", true],
      ["build.log", "log", false],
    ]);
    expect(c.chips().length).toBe(2);
    expect(c.error()).toBe("Not attached: tool.sh. Only images, PDF, text, logs, Markdown, JSON, CSV and zip files upload.");
  });

  it("takes a pasted image as a chip and leaves a text paste to the box", async () => {
    const c = composer();
    expect(c.paste({ types: ["text/plain"], files: [], text: "two\nlines" })).toBe(false);
    expect(c.paste({ types: ["Files"], files: [file("image.png", "image/png")] })).toBe(true);
    await flush();
    expect(composerDrafts.get(key).chips.map((chip) => chip.name)).toEqual(["Pasted image.png"]);
  });

  it("takes a file copied in the Finder (the main process reads it) before the icon Chromium pastes", async () => {
    clipboardFiles = { files: [{ name: "report.pdf", type: "", data: new Uint8Array([7]) }], refused: [], excess: [], failures: [] };
    const c = composer();
    expect(c.paste({ types: ["Files", "text/plain"], files: [file("report.pdf.tiff", "image/tiff")], text: "report.pdf" })).toBe(true);
    await flush();
    expect(composerDrafts.get(key).chips.map((chip) => [chip.name, chip.extension])).toEqual([["report.pdf", "pdf"]]);
  });

  it("takes files dropped on the box", async () => {
    const c = composer();
    expect(c.drop([file("diagram.jpg", "image/jpeg"), file("data.csv", "text/csv")])).toBe(true);
    await flush();
    expect(composerDrafts.get(key).chips.map((chip) => chip.name)).toEqual(["diagram.png", "data.csv"]);
  });

  it("removes a chip with its x", async () => {
    const c = composer();
    c.pick([file("a.png", "image/png"), file("b.txt", "text/plain")]);
    await flush();
    const remove = c.removeButtons();
    expect(remove.map((button) => button.props["aria-label"])).toEqual(["Remove a.png", "Remove b.txt"]);
    (remove[0]!.props["onClick"] as () => void)();
    expect(composerDrafts.get(key).chips.map((chip) => chip.name)).toEqual(["b.txt"]);
  });

  it("uploads each chip as it is attached, then Send sends the text with their paths after it", async () => {
    const c = composer();
    c.pick([file("a.png", "image/png"), file("b.log", "text/plain", [9, 9])]);
    await flush();
    // Both upload now (two at a time), before Send.
    expect(uploads.map((u) => [u.hostId, u.extension, [...u.data]])).toEqual([
      ["mac-mini", "png", [0x89, 0x50, 0x4e, 0x47]],
      ["mac-mini", "log", [9, 9]],
    ]);
    c.type("look at these");
    c.enter();
    await flush();
    // The Send waits for them.
    expect(sends).toEqual([]);
    uploads[0]!.resolve(remote(1));
    await flush();
    expect(sends).toEqual([]);
    uploads[1]!.resolve(remote(2, "log"));
    await flush();
    expect(uploads.length).toBe(2);
    expect(sends.map((s) => s.text)).toEqual([`look at these ${remote(1)} ${remote(2, "log")}`]);
    sends[0]!.resolve();
    await flush();
    expect(c.value()).toBe("");
    expect(composerDrafts.get(key).chips).toEqual([]);
  });

  it("sends an image alone (no text)", async () => {
    const c = composer();
    c.pick([file("a.png", "image/png")]);
    await flush();
    c.enter();
    await flush();
    uploads[0]!.resolve(remote(1));
    await flush();
    expect(sends.map((s) => s.text)).toEqual([remote(1)]);
  });

  it("keeps the draft and says why when an upload fails, and sends nothing", async () => {
    const c = composer();
    c.pick([file("a.png", "image/png")]);
    await flush();
    c.type("see this");
    c.enter();
    await flush();
    uploads[0]!.reject(new Error("Error invoking remote method 'herdr:attachment-upload': Error: The attachment directory on the Mac is not private (0700)."));
    await flush();
    expect(sends).toEqual([]);
    expect(c.value()).toBe("see this");
    expect(composerDrafts.get(key).chips.map((chip) => [chip.name, chip.state.kind])).toEqual([["a.png", "failed"]]);
    expect(c.error()).toBe("Not sent: a.png did not upload (The attachment directory on the Mac is not private (0700).). The message is kept.");
  });

  it("does not upload again after a failed send: the uploaded path goes with the retry", async () => {
    const c = composer();
    c.pick([file("a.png", "image/png")]);
    await flush();
    c.type("again");
    c.enter();
    await flush();
    uploads[0]!.resolve(remote(1));
    await flush();
    sends[0]!.reject(new Error("not connected"));
    await flush();
    expect(composerDrafts.get(key).chips.map((chip) => chip.state)).toEqual([{ kind: "uploaded", path: remote(1) }]);
    c.enter();
    await flush();
    expect(uploads.length).toBe(1);
    expect(sends.map((s) => s.text)).toEqual([`again ${remote(1)}`, `again ${remote(1)}`]);
  });
});

describe("a drop on the Chat", () => {
  it("attaches the files to the pane's message box", async () => {
    const view = new HookHost(ChatView as (props: object) => unknown, { host: mac, row: { ...pane, status: "idle" }, onShowTerminal: () => undefined });
    view.render();
    const root = elements(view.tree).find((e) => e.props["className"] === "chat")!;
    let over = false;
    (root.props["onDragOver"] as (e: unknown) => void)({ dataTransfer: { types: ["Files"] }, preventDefault: () => (over = true) });
    expect(over).toBe(true);
    // Text dragged from elsewhere is not a drop of files.
    let text = false;
    (root.props["onDragOver"] as (e: unknown) => void)({ dataTransfer: { types: ["text/plain"] }, preventDefault: () => (text = true) });
    expect(text).toBe(false);
    (root.props["onDrop"] as (e: unknown) => void)({
      dataTransfer: { types: ["Files"], files: [file("screen.png", "image/png")] },
      preventDefault: () => undefined,
      stopPropagation: () => undefined,
    });
    await flush();
    expect(composerDrafts.get(key).chips.map((chip) => chip.name)).toEqual(["screen.png"]);
    view.unmount();
  });
});

describe("what the composer takes in", () => {
  const prepare = async () => ({ data: new Uint8Array([1]), extension: "png" as const });
  const intake = (name: string, type: string, size: number) => ({ name, type, size, bytes: async () => new Uint8Array(size) });

  it("takes ten items at a time and says what it left", async () => {
    const files = Array.from({ length: 12 }, (_, n) => intake(`f${n}.txt`, "text/plain", 1));
    const result = await intakeFiles(files, prepare, Number.MAX_SAFE_INTEGER);
    expect(result.payloads.length).toBe(10);
    expect(result.note).toBe(
      "Not attached: f10.txt, f11.txt. One drop takes up to 10 items and 64 MB in all; drop the rest again once these have uploaded.",
    );
  });

  it("refuses a file over 12 MB and an image over 30 MB before reading them", async () => {
    const result = await intakeFiles([intake("big.pdf", "application/pdf", 12 * 1_048_576 + 1)], prepare, Number.MAX_SAFE_INTEGER);
    expect(result.note).toBe("big.pdf: The image is too large to upload. Choose one under 12 MB.");
    const image = await intakeFiles([intake("huge.png", "image/png", 30 * 1_048_576 + 1)], prepare, Number.MAX_SAFE_INTEGER);
    expect(image.note).toBe("huge.png: That image is over 30 MB. Choose a smaller photo or screenshot.");
  });

  it("names a picture it could not read", async () => {
    const failing = async () => {
      throw new Error("That file is not a readable image.");
    };
    const result = await intakeFiles([intake("broken.png", "image/png", 4)], failing, Number.MAX_SAFE_INTEGER);
    expect(result.payloads).toEqual([]);
    expect(result.note).toBe("broken.png: That file is not a readable image.");
  });
});

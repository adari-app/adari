// The images the user sent show as thumbnails in their
// bubble, the pending one at once and the transcript's once it has it, and a
// thumbnail opens the picture full size (as the Swift app's Quick Look); a
// demo machine's upload reads back for the transcript's thumbnail.

import { afterEach, describe, expect, it, vi } from "vitest";

import { ChatService, type ChatOwner } from "../src/main/chat/service";
import { DemoBackend } from "../src/main/demo/demo-backend";
import { demoHostIds, demoHosts } from "../src/main/demo/demo-hosts";
import { HostRegistry } from "../src/main/hosts";
import { joinedMessage, maxUploadBytes } from "../src/shared/attachments";
import type { ChatUpdateEvent } from "../src/shared/ipc-contract";
import { attachment, userMessage } from "../src/shared/chat/model";
import { bundledFixturesForTests } from "./support/demo-fixtures";
import { eventually } from "./support/chat-lines";
import { HookHost, elements } from "./support/fake-hooks";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  const hooks = { ...fakeReact, useLayoutEffect: fakeReact.useEffect };
  return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});

const { PendingBubble, Thumb, PictureViewer, pictureViewer } = await import("../src/renderer/chat/ChatView");
const { localPictures } = await import("../src/renderer/components/composer-drafts");

const folder = "/Users/fixture/.herdr-companion-attachments-0123456789abcdef0123456789abcdef";
const shot = `${folder}/attachment-11111111-1111-4111-8111-111111111111.png`;
const log = `${folder}/attachment-22222222-2222-4222-8222-222222222222.log`;

let reads: string[] = [];
afterEach(() => {
  localPictures.clear();
  pictureViewer.close();
  reads = [];
  vi.unstubAllGlobals();
});

function bridge(): void {
  vi.stubGlobal("window", {
    herdrDesktop: {
      chatImage: async (path: string) => {
        reads.push(path);
        return "data:image/png;base64,AAAA";
      },
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

describe("the user's pending bubble", () => {
  it("shows the user's text without the paths, and a thumbnail for each image they sent", () => {
    bridge();
    localPictures.set(shot, "blob:app://local/1");
    const message = { id: "p1", key: "h/w1:p1", text: joinedMessage("look at this", [shot, log]), match: "", attachments: { paths: [], count: 0 }, sentAtMs: Date.now(), state: "sent", scope: null };
    const bubble = new HookHost(PendingBubble as (props: object) => unknown, { message, working: false, now: Date.now(), onMenu: () => undefined });
    bubble.render();
    const text = elements(bubble.tree).find((e) => e.props["className"] === "bubble");
    expect(text?.props["children"]).toBe("look at this");
    const thumbs = elements(bubble.tree).filter((e) => e.type === Thumb);
    expect(thumbs.map((t) => (t.props["attachment"] as { path: string }).path)).toEqual([shot]);
    const files = elements(bubble.tree).filter((e) => e.props["className"] === "file-chip");
    expect(files.length).toBe(1);
  });
});

describe("a thumbnail", () => {
  it("shows a picture the user sent from this Mac without reading it back", async () => {
    bridge();
    localPictures.set(shot, "blob:app://local/1");
    const thumb = new HookHost(Thumb as (props: object) => unknown, { attachment: attachment(shot, "image/png") });
    thumb.render();
    await flush();
    expect(elements(thumb.tree).find((e) => e.type === "img")?.props["src"]).toBe("blob:app://local/1");
    expect(reads).toEqual([]);
  });

  it("reads one from the transcript, and opens it full size on click", async () => {
    bridge();
    const thumb = new HookHost(Thumb as (props: object) => unknown, { attachment: attachment(shot, "image/png") });
    thumb.render();
    await flush();
    expect(reads).toEqual([shot]);
    const button = elements(thumb.tree).find((e) => e.props["className"] === "thumb")!;
    expect(button.type).toBe("button");
    (button.props["onClick"] as () => void)();
    expect(pictureViewer.get()).toEqual({ url: "data:image/png;base64,AAAA", name: "attachment-11111111-1111-4111-8111-111111111111.png" });
  });

  it("shows full size in the viewer, which closes on click or Escape", () => {
    let keydown: ((event: { key: string }) => void) | null = null;
    vi.stubGlobal("window", {
      addEventListener: (type: string, listener: (event: { key: string }) => void) => {
        if (type === "keydown") keydown = listener;
      },
      removeEventListener: () => undefined,
    });
    pictureViewer.open({ url: "data:image/png;base64,AAAA", name: "shot.png" });
    const viewer = new HookHost(PictureViewer as (props: object) => unknown, {});
    viewer.render();
    const image = elements(viewer.tree).find((e) => e.type === "img")!;
    expect(image.props["src"]).toBe("data:image/png;base64,AAAA");
    keydown!({ key: "Escape" });
    expect(pictureViewer.get()).toBeNull();
    pictureViewer.open({ url: "data:image/png;base64,AAAA", name: "shot.png" });
    viewer.render();
    const backdrop = elements(viewer.tree).find((e) => e.props["className"] === "viewer")!;
    (backdrop.props["onClick"] as () => void)();
    expect(pictureViewer.get()).toBeNull();
  });

  it("is the user's message's image in the transcript too (the parser's attachments)", () => {
    const message = userMessage("u1", "look", 0, [attachment(shot, "image/png")]);
    expect(message.attachments[0]?.path).toBe(shot);
  });
});

class Page implements ChatOwner {
  readonly updates: ChatUpdateEvent[] = [];
  constructor(readonly id: number) {}
  send(_channel: string, payload: ChatUpdateEvent): void {
    this.updates.push(payload);
  }
  isDestroyed(): boolean {
    return false;
  }
}

describe("a demo machine's upload", () => {
  it("shows in the transcript as the user's message's thumbnail, read back up to the upload limit", async () => {
    const registry = new HostRegistry(() => undefined);
    const fixtures = bundledFixturesForTests();
    for (const host of demoHosts(fixtures, Date.now())) registry.add(host.descriptor, new DemoBackend(host, fixtures));
    await registry.refreshAll();
    const service = new ChatService(registry, "chat", { pollIntervalMs: 5 });
    const page = new Page(1);
    service.open(page, demoHostIds.macMini, "w7:p1H");
    await eventually(() => page.updates.at(-1)?.state.status === "live");
    const backend = registry.backend(demoHostIds.macMini) as DemoBackend;
    const big = new Uint8Array(9 * 1_048_576);
    big.set([0x89, 0x50, 0x4e, 0x47]);
    expect(big.byteLength).toBeLessThan(maxUploadBytes);
    const remote = await backend.uploads().upload(big, "png");
    backend.transcripts().record("w7:p1H", joinedMessage("the new screen", [remote.path]), false, Date.now());
    await eventually(() => page.updates.at(-1)!.timeline.turns.some((turn) => turn.items.some((item) => item.type === "user" && item.value.text === "the new screen")));
    const url = await service.image(page, remote.path);
    expect(url?.startsWith("data:image/png;base64,iVBORw")).toBe(true);
    service.closeAll();
    registry.close();
  });
});

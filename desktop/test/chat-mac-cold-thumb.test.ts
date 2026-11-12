// Relay v1.2, client rule 5 (docs/relay.md): a pasted picture a relay read left out shows its frame,
// is fetched on show by its reference (chatBlobImage), once per picture, and shows when it comes. A picture by
// path reads as before (chatImage). The real Thumb on the small hooks host.

import { afterEach, describe, expect, it, vi } from "vitest";

import { attachment, type ChatImageBlob } from "../src/shared/chat/model";
import { HookHost, find } from "./support/fake-hooks";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  const hooks = { ...fakeReact, useLayoutEffect: fakeReact.useEffect };
  return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});

const { Thumb, forgetBlobPictures } = await import("../src/renderer/chat/ChatView");

afterEach(() => {
  vi.unstubAllGlobals();
});

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
};

describe("a picture left out of the read, fetched on show", () => {
  it("shows its frame, asks main once by its reference, shows what comes; a picture by path asks as before", async () => {
    const asked: ChatImageBlob[] = [];
    const paths: string[] = [];
    vi.stubGlobal("window", {
      herdrDesktop: {
        chatBlobImage: (blob: ChatImageBlob) => {
          asked.push(blob);
          return Promise.resolve("data:image/png;base64,iVBORw0K");
        },
        chatImage: (path: string) => {
          paths.push(path);
          return Promise.resolve("data:image/png;base64,UE5H");
        },
      },
    });
    const blob: ChatImageBlob = { path: "/Users/fixture/.claude/projects/p/s.jsonl", ino: 7, parts: [[1_000, 5_000], "QUJD"] };
    // The chat it is asked of (its machine and slot).
    const place = { hostId: "mini" };
    const first = new HookHost(Thumb as (props: object) => unknown, { attachment: attachment(null, "image/png", blob), place });
    first.render();
    // The frame until it comes.
    expect(find(first.tree, "img")).toBeUndefined();
    expect(find(first.tree, "div", "ph")).toBeDefined();
    expect(asked).toEqual([blob]);
    await settle();
    first.render();
    expect(find(first.tree, "img")?.props["src"]).toBe("data:image/png;base64,iVBORw0K");
    first.unmount();

    // On show again (another row, the same picture): no second ask.
    const again = new HookHost(Thumb as (props: object) => unknown, { attachment: attachment(null, "image/png", JSON.parse(JSON.stringify(blob)) as ChatImageBlob), place });
    again.render();
    await settle();
    again.render();
    expect(asked).toHaveLength(1);
    expect(find(again.tree, "img")?.props["src"]).toBe("data:image/png;base64,iVBORw0K");
    again.unmount();

    // No reference (SFTP, a frame as before): nothing asked.
    const frame = new HookHost(Thumb as (props: object) => unknown, { attachment: attachment(null, "image/png"), place });
    frame.render();
    await settle();
    expect(asked).toHaveLength(1);
    expect(find(frame.tree, "div", "ph")).toBeDefined();
    frame.unmount();

    // A picture by path: chatImage, as before.
    const byPath = new HookHost(Thumb as (props: object) => unknown, { attachment: attachment("/Users/fixture/proj/shot.png", "image/png") });
    byPath.render();
    await settle();
    byPath.render();
    expect(paths).toEqual(["/Users/fixture/proj/shot.png"]);
    expect(asked).toHaveLength(1);
    byPath.unmount();
  });

  it("asked of its chat (machine and slot), kept per chat, let go when that chat closes", async () => {
    const asked: [ChatImageBlob, string, string | undefined][] = [];
    vi.stubGlobal("window", {
      herdrDesktop: {
        chatBlobImage: (blob: ChatImageBlob, hostId: string, slot?: string) => {
          asked.push([blob, hostId, slot]);
          return Promise.resolve("data:image/png;base64,iVBORw0K");
        },
      },
    });
    const blob: ChatImageBlob = { path: "/Users/fixture/.claude/projects/p/t.jsonl", ino: 9, parts: [[2_000, 4_000]] };
    const show = async (place: { hostId: string; slot?: string }): Promise<unknown> => {
      const view = new HookHost(Thumb as (props: object) => unknown, { attachment: attachment(null, "image/png", blob), place });
      view.render();
      await settle();
      view.render();
      const src = find(view.tree, "img")?.props["src"];
      view.unmount();
      return src;
    };
    expect(await show({ hostId: "mini", slot: "tile-1" })).toBe("data:image/png;base64,iVBORw0K");
    expect(asked).toEqual([[blob, "mini", "tile-1"]]);
    // The same chat again: kept. Another tile: its own ask.
    await show({ hostId: "mini", slot: "tile-1" });
    expect(asked).toHaveLength(1);
    await show({ hostId: "mini", slot: "tile-2" });
    expect(asked.map(([, hostId, slot]) => [hostId, slot])).toEqual([
      ["mini", "tile-1"],
      ["mini", "tile-2"],
    ]);
    // tile-1's chat closed: its pictures go (tile-2's stay).
    forgetBlobPictures("mini", "tile-1");
    await show({ hostId: "mini", slot: "tile-2" });
    expect(asked).toHaveLength(2);
    await show({ hostId: "mini", slot: "tile-1" });
    expect(asked).toHaveLength(3);
  });
});

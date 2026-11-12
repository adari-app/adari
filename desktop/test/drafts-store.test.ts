// Drafts survive a quit or a crash. The main process
// keeps each pane's draft (its text and the chips already uploaded, by their
// paths on the machine; the names of local files not uploaded yet) in
// userData/drafts.json, written atomically (a temp file, then a rename), 0600,
// at most 500 ms after the first change not yet written (so a crash loses at
// most the last 500 ms) and at quit; keyed by machine and pane; bounded; a
// draft whose pane is gone when its machine answers moves to Kept drafts (the
// Swift app's Kept items rule: 50 items, 256 KB; full, it stays a draft); a
// damaged file is moved aside, not fatal.

import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DraftStore, fileDrafts } from "../src/main/drafts";
import {
  draftSaveDelayMs,
  isDraftInput,
  keptByteLimit,
  keptLimit,
  maxDraftChips,
  maxDraftTextBytes,
  maxSavedDrafts,
  type DraftInput,
} from "../src/shared/drafts";

let folder: string;
let file: string;

beforeEach(() => {
  folder = mkdtempSync(path.join(tmpdir(), "herdr-drafts-"));
  file = path.join(folder, "drafts.json");
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const input = (text: string, extra: Partial<DraftInput> = {}): DraftInput => ({ text, chips: [], lost: [], ...extra });
const open = () => new DraftStore(fileDrafts(file));
const onDisk = (): { drafts: { hostId: string; paneId: string; text: string }[]; kept: { text: string }[] } => JSON.parse(readFileSync(file, "utf8"));

describe("saving a draft", () => {
  it("writes drafts.json about 500 ms after the change, 0600, keyed by machine and pane", () => {
    const store = open();
    store.put("mac-mini", "w7:p1", input("half a thought"), "claude");
    expect(() => readFileSync(file)).toThrow();
    vi.advanceTimersByTime(draftSaveDelayMs - 1);
    expect(() => readFileSync(file)).toThrow();
    vi.advanceTimersByTime(1);
    expect(onDisk().drafts).toMatchObject([{ hostId: "mac-mini", paneId: "w7:p1", text: "half a thought" }]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    // No temp file is left behind.
    expect(readdirSync(folder)).toEqual(["drafts.json"]);
  });

  it("a crash between a keystroke and its save loses at most the last 500 ms of typing", () => {
    const store = open();
    const typedAt: { at: number; text: string }[] = [];
    let text = "";
    for (let step = 0; step < 40; step += 1) {
      text += "x";
      store.put("mac-mini", "w7:p1", input(text), "claude");
      typedAt.push({ at: Date.now(), text });
      vi.advanceTimersByTime(90);
      // The app dies now: what a new launch reads is never older than 500 ms of typing.
      let saved = "";
      try {
        saved = new DraftStore(fileDrafts(file)).state().drafts[0]?.text ?? "";
      } catch {
        saved = "";
      }
      const oldestLost = typedAt.find((entry) => entry.text.length > saved.length);
      if (oldestLost !== undefined) expect(Date.now() - oldestLost.at).toBeLessThanOrEqual(draftSaveDelayMs);
    }
  });

  it("writes at once at quit (flush)", () => {
    const store = open();
    store.put("mac-mini", "w7:p1", input("quitting now"), null);
    store.flush();
    expect(onDisk().drafts[0]!.text).toBe("quitting now");
  });

  it("keeps the uploaded chips by their paths and the names of files not uploaded", () => {
    const store = open();
    store.put(
      "mac-mini",
      "w7:p1",
      input("see these", { chips: [{ path: "/Users/demo/.adari-attachments-x/attachment-1.png", name: "Screenshot.png", image: true }], lost: ["build.log"] }),
      "claude",
    );
    store.flush();
    const back = new DraftStore(fileDrafts(file)).state().drafts[0]!;
    expect(back.chips).toEqual([{ path: "/Users/demo/.adari-attachments-x/attachment-1.png", name: "Screenshot.png", image: true }]);
    expect(back.lost).toEqual(["build.log"]);
  });

  it("an empty draft (sent, or emptied) is cleared from the file", () => {
    const store = open();
    store.put("mac-mini", "w7:p1", input("going"), null);
    store.put("mac-mini", "w7:p2", input("staying"), null);
    store.flush();
    store.put("mac-mini", "w7:p1", null, null);
    vi.advanceTimersByTime(draftSaveDelayMs);
    expect(onDisk().drafts.map((draft) => draft.text)).toEqual(["staying"]);
  });
});

describe("the bounds", () => {
  it("a draft keeps at most 100,000 bytes of text (cut, and says so) and 10 chips", () => {
    const store = open();
    const chips = Array.from({ length: maxDraftChips + 2 }, (_, i) => ({ path: `/u/attachment-${i}.png`, name: `p${i}.png`, image: true }));
    store.put("mac-mini", "w7:p1", input("é".repeat(maxDraftTextBytes), { chips }), null);
    const draft = store.state().drafts[0]!;
    expect(Buffer.byteLength(draft.text)).toBeLessThanOrEqual(maxDraftTextBytes);
    expect(draft.text.endsWith("é")).toBe(true);
    expect(draft.cut).toBe(true);
    expect(draft.chips).toHaveLength(maxDraftChips);
    expect(draft.lost).toEqual(["p10.png", "p11.png"]);
  });

  it("at most 200 drafts: the least recently saved go first, never the one just saved", () => {
    const store = open();
    for (let i = 0; i < maxSavedDrafts + 5; i += 1) {
      store.put("mac-mini", `w1:p${i}`, input(`draft ${i}`), null);
      vi.advanceTimersByTime(1);
    }
    const panes = store.state().drafts.map((draft) => draft.paneId);
    expect(panes).toHaveLength(maxSavedDrafts);
    expect(panes).not.toContain("w1:p0");
    expect(panes).toContain(`w1:p${maxSavedDrafts + 4}`);
  });

  it("refuses inputs that are not a draft", () => {
    expect(isDraftInput(input("ok"))).toBe(true);
    expect(isDraftInput({ text: 3, chips: [], lost: [] })).toBe(false);
    expect(isDraftInput({ text: "x", chips: [{ path: 1 }], lost: [] })).toBe(false);
    expect(isDraftInput({ text: "x".repeat(4 * maxDraftTextBytes), chips: [], lost: [] })).toBe(false);
  });
});

describe("launching again", () => {
  it("brings each pane's draft back", () => {
    const store = open();
    store.put("mac-mini", "w7:p1", input("one"), "claude");
    store.put("build-box", "w2:p3", input("two"), null);
    store.flush();
    const back = new DraftStore(fileDrafts(file)).state();
    expect(back.drafts.map((draft) => [draft.hostId, draft.paneId, draft.text])).toEqual([
      ["mac-mini", "w7:p1", "one"],
      ["build-box", "w2:p3", "two"],
    ]);
  });

  it("a damaged drafts.json is moved aside and the app starts with none", () => {
    writeFileSync(file, "{ not json", { mode: 0o600 });
    const store = open();
    expect(store.state()).toEqual({ drafts: [], kept: [] });
    expect(store.damaged).not.toBeNull();
    expect(readdirSync(folder).some((name) => name.startsWith("drafts.json.damaged-"))).toBe(true);
    expect(readFileSync(store.damaged!, "utf8")).toBe("{ not json");
    // A file of the wrong shape too.
    writeFileSync(file, JSON.stringify({ version: 1, drafts: [{ hostId: 7 }], kept: [] }));
    expect(open().state().drafts).toEqual([]);
  });
});

describe("a draft whose pane is gone", () => {
  it("moves to Kept drafts when its machine answers without the pane, with its machine, agent and why", () => {
    const store = open();
    store.put("mac-mini", "w7:p1", input("keep me"), "claude");
    store.put("mac-mini", "w7:p2", input("still here"), "codex");
    store.put("build-box", "w2:p1", input("other machine"), null);
    const gone = store.hostAnswered("mac-mini", "Mac mini", new Set(["w7:p2"]));
    expect(gone).toEqual([{ hostId: "mac-mini", paneId: "w7:p1" }]);
    const state = store.state();
    expect(state.drafts.map((draft) => draft.paneId)).toEqual(["w7:p2", "w2:p1"]);
    expect(state.kept).toMatchObject([{ hostId: "mac-mini", hostLabel: "Mac mini", paneId: "w7:p1", agentName: "claude", text: "keep me", reason: "Its pane is gone." }]);
    store.flush();
    expect(new DraftStore(fileDrafts(file)).state().kept.map((item) => item.text)).toEqual(["keep me"]);
  });

  it("Put back or Discard takes it out of Kept drafts", () => {
    const store = open();
    store.put("mac-mini", "w7:p1", input("a"), null);
    store.put("mac-mini", "w7:p2", input("b"), null);
    store.hostAnswered("mac-mini", "Mac mini", new Set());
    const [first, second] = store.state().kept;
    expect(store.takeKept(first!.id)?.text).toBe("a");
    expect(store.discardKept(second!.id)).toBe(true);
    expect(store.state().kept).toEqual([]);
    expect(store.takeKept("nope")).toBeNull();
  });

  it("with Kept drafts full (50 items or 256 KB) it stays a draft until there is room", () => {
    const store = open();
    for (let i = 0; i < keptLimit; i += 1) store.put("mac-mini", `w1:p${i}`, input(`k${i}`), null);
    store.hostAnswered("mac-mini", "Mac mini", new Set());
    expect(store.state().kept).toHaveLength(keptLimit);
    store.put("mac-mini", "w9:p9", input("waits"), null);
    expect(store.hostAnswered("mac-mini", "Mac mini", new Set())).toEqual([]);
    expect(store.state().drafts.map((draft) => draft.text)).toEqual(["waits"]);
    store.discardKept(store.state().kept[0]!.id);
    expect(store.hostAnswered("mac-mini", "Mac mini", new Set())).toEqual([{ hostId: "mac-mini", paneId: "w9:p9" }]);
    // By bytes too: one too large for the room left stays a draft.
    const big = new DraftStore(fileDrafts(path.join(folder, "big.json")));
    big.put("mac-mini", "w1:p1", input("y".repeat(maxDraftTextBytes)), null);
    big.put("mac-mini", "w1:p2", input("y".repeat(maxDraftTextBytes)), null);
    big.put("mac-mini", "w1:p3", input("y".repeat(maxDraftTextBytes)), null);
    big.hostAnswered("mac-mini", "Mac mini", new Set());
    expect(Buffer.byteLength(JSON.stringify(big.state().kept))).toBeLessThanOrEqual(keptByteLimit);
    expect(big.state().kept).toHaveLength(2);
    expect(big.state().drafts).toHaveLength(1);
  });

  it("a machine removed takes its drafts and kept drafts with it", () => {
    const store = open();
    store.put("mac-mini", "w7:p1", input("a"), null);
    store.put("mac-mini", "w7:p2", input("b"), null);
    store.hostAnswered("mac-mini", "Mac mini", new Set(["w7:p2"]));
    store.put("build-box", "w2:p1", input("c"), null);
    store.forgetHost("mac-mini");
    expect(store.state().drafts.map((draft) => draft.text)).toEqual(["c"]);
    expect(store.state().kept).toEqual([]);
  });
});

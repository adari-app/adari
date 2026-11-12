// An attach measurement, on the desktop's own code with a link model
// (support/latency-sftp.ts): 65 ms (a Mac to a Mac mini over a distant peer
// relay) and 226 ms (the iPhone's direct path), 1.5 MB/s
// (1,500,000 bytes a second up). Three photos of about 500 KB and one PNG
// screenshot of about 80 KB (their bytes as they upload). Per upload: the
// requests, the waits for the machine one after another (trips) and the time,
// on a fresh link and on one already used. Then the time from the Send press
// to the message's send, pressed 2 s after the attach and at once. It uses
// only ComposerDrafts, sendDraft with an uploader and uploadAttachment over
// ssh2UploadSftp, so the same file measures a tree with or without
// ComposerDrafts.retryChip; it prints one JSON line per model.

import type { SFTPWrapper } from "ssh2";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LatencySftp } from "./support/latency-sftp";

const { ComposerDrafts, draftKey, sendDraft } = await import("../src/renderer/components/composer-drafts");
const { ssh2UploadSftp } = await import("../src/main/uploads/sftp");
const { uploadAttachment } = await import("../src/main/uploads/upload");

const after = "retryChip" in ComposerDrafts.prototype;
const tree = after ? "with retryChip" : "without retryChip";
const bandwidth = 1_500_000;
const photo = 500_000;
const screenshot = 80_000;
const bytes = (n: number, seed: number) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 0xff);
const files = (sftp: LatencySftp) => ssh2UploadSftp(sftp as unknown as SFTPWrapper);

async function drive(done: () => boolean): Promise<void> {
  for (let i = 0; i < 100_000 && !done(); i += 1) {
    if (vi.getTimerCount() === 0) await Promise.resolve();
    else await vi.advanceTimersToNextTimerAsync();
  }
}

async function single(link: LatencySftp, size: number, extension: string) {
  const startedAt = Date.now();
  const requests = link.requests.length;
  const rounds = link.rounds;
  let settled = false;
  void uploadAttachment(files(link), bytes(size, size), extension).finally(() => {
    settled = true;
  });
  await drive(() => settled);
  return { ms: Date.now() - startedAt, requests: link.requests.length - requests, trips: link.rounds - rounds };
}

/** Attach three photos and a screenshot at once, press Send `pressAfterMs` later; the time from the press to the send. */
async function flow(rttMs: number, pressAfterMs: number) {
  const link = new LatencySftp({ rttMs, bytesPerSecond: bandwidth });
  const upload = (_host: string, data: Uint8Array, extension: string) => uploadAttachment(files(link), data, extension);
  const drafts = new ComposerDrafts({ transport: () => ({ upload: (host: string, data: Uint8Array, extension: string) => upload(host, data, extension) }) } as never);
  const key = draftKey("mac-mini", "w1:p1");
  drafts.attach(key, [
    { name: "IMG_1.jpg", extension: "jpg", image: true, data: bytes(photo, 1) },
    { name: "IMG_2.jpg", extension: "jpg", image: true, data: bytes(photo, 2) },
    { name: "IMG_3.jpg", extension: "jpg", image: true, data: bytes(photo, 3) },
    { name: "Screenshot.png", extension: "png", image: true, data: bytes(screenshot, 4) },
  ]);
  drafts.edit(key, "look at these");
  if (pressAfterMs > 0) await vi.advanceTimersByTimeAsync(pressAfterMs);
  const uploadedAtPress = drafts.get(key).chips.filter((chip) => chip.state.kind === "uploaded").length;
  let sentAt: number | null = null;
  let sentText = "";
  const pressedAt = Date.now();
  sendDraft(
    drafts,
    async (_h, _p, text) => {
      sentAt = Date.now();
      sentText = text;
    },
    "mac-mini",
    "w1:p1",
    upload,
  );
  await drive(() => sentAt !== null);
  return {
    pressToSentMs: sentAt === null ? null : sentAt - pressedAt,
    uploadedAtPress,
    paths: sentText.split(" ").filter((part) => part.startsWith("/")).length,
    requests: link.requests.length,
    maxWritesInFlight: link.maxWrites,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ now: 0 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe(`attach measurement (${tree})`, () => {
  for (const rttMs of [65, 226]) {
    it(`at ${rttMs} ms and 1.5 MB/s`, async () => {
      const link = new LatencySftp({ rttMs, bytesPerSecond: bandwidth });
      const coldPhoto = await single(link, photo, "jpg");
      const warmPhoto = await single(link, photo, "jpg");
      const warmPng = await single(link, screenshot, "png");
      const pressedLater = await flow(rttMs, 2_000);
      const pressedAtOnce = await flow(rttMs, 0);
      const result = { tree, rttMs, coldPhoto, warmPhoto, warmPng, pressedLater, pressedAtOnce };
      console.log(`MEASURE ${JSON.stringify(result)}`);
      expect(pressedLater.paths).toBe(4);
      expect(pressedAtOnce.paths).toBe(4);
      if (after) {
        // The window and the checks asked together: a few waits per upload, not one per request.
        expect(warmPhoto.trips).toBeLessThanOrEqual(8);
        expect(warmPng.trips).toBeLessThanOrEqual(6);
        expect(pressedLater.maxWritesInFlight).toBe(12);
        if (rttMs === 65) expect(pressedLater.pressToSentMs).toBe(0);
      }
    });
  }
});

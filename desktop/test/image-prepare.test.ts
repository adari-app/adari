// An image re-encodes by the Swift app's
// CompanionImageNormalizer rules: at most 4,096 pixels on its longest side,
// 20% smaller each time until under 12 MB (nine tries), refused past 16,384
// pixels a side or 64 megapixels; PNG unless it is a photo (JPEG, HEIC).

import { describe, expect, it } from "vitest";

import { maxUploadBytes } from "../src/shared/attachments";
import { encodeWithin, prefersPNG } from "../src/renderer/components/image-prepare";

describe("an image as it uploads", () => {
  it("draws a large image at 4,096 on its longest side", async () => {
    const sizes: string[] = [];
    await encodeWithin(8_000, 6_000, async (w, h) => {
      sizes.push(`${w}x${h}`);
      return new Uint8Array(10);
    });
    expect(sizes).toEqual(["4096x3072"]);
  });

  it("draws it 20% smaller until it is under 12 MB, then gives up after nine tries", async () => {
    const sizes: number[] = [];
    const data = await encodeWithin(1_000, 1_000, async (w) => {
      sizes.push(w);
      return new Uint8Array(w > 700 ? maxUploadBytes + 1 : 1);
    });
    expect(sizes).toEqual([1_000, 800, 640]);
    expect(data.byteLength).toBe(1);
    await expect(encodeWithin(1_000, 1_000, async () => new Uint8Array(maxUploadBytes + 1))).rejects.toThrow(
      "The image is still over 12 MB after conversion. Crop it or choose a smaller image.",
    );
  });

  it("refuses an image with too many pixels", async () => {
    await expect(encodeWithin(20_000, 10, async () => new Uint8Array(1))).rejects.toThrow("That image has too many pixels to open safely.");
    await expect(encodeWithin(9_000, 9_000, async () => new Uint8Array(1))).rejects.toThrow("That image has too many pixels to open safely.");
  });

  it("keeps PNG for screenshots and transparent kinds, JPEG for photos", () => {
    expect(prefersPNG("shot.png", "image/png")).toBe(true);
    expect(prefersPNG("Pasted image.png", "image/png")).toBe(true);
    expect(prefersPNG("anim.gif", "image/gif")).toBe(true);
    expect(prefersPNG("IMG_1.jpeg", "image/jpeg")).toBe(false);
    expect(prefersPNG("IMG_2.HEIC", "")).toBe(false);
  });
});

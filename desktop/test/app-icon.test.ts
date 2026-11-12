// Our icon on the Mac. build/icon.icns
// (drawn from the iPhone app's artwork, in the macOS
// shape) holds the ten renditions 16 to 512 at 1x and 2x; electron-builder's
// mac config takes it; in development (`electron .`) the dock (macOS) and the
// window (Windows, Linux) take build/icon.png, so Electron's own icon never
// shows. The files are read as bytes: the .icns's chunks, the PNGs' headers,
// the master's corner pixel (transparent: the macOS shape, not a full square).

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { inflateSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { developmentIcon } from "../src/main/app-icon";

const root = new URL("..", import.meta.url).pathname;
const require = createRequire(import.meta.url);
const config = require("../electron-builder.config.cjs") as { directories: { buildResources?: string }; mac: { icon?: string } };

/** A PNG's width, height and colour type, from its IHDR chunk. */
function pngHeader(bytes: Buffer): { width: number; height: number; colourType: number } {
  expect(bytes.subarray(1, 4).toString("latin1")).toBe("PNG");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), colourType: bytes[25]! };
}

/** The length of icns run-length data unpacked: a byte under 0x80 copies that many plus one; otherwise the next byte repeats (byte - 125) times. */
function unpackedLength(data: Buffer): number {
  let length = 0;
  for (let at = 0; at < data.length; ) {
    const byte = data[at]!;
    if (byte < 0x80) {
      length += byte + 1;
      at += byte + 2;
    } else {
      length += byte - 125;
      at += 2;
    }
  }
  return length;
}

/** The first pixel of an 8-bit RGBA PNG (every filter leaves row 0's first pixel as stored). */
function firstPixel(bytes: Buffer): number[] {
  const parts: Buffer[] = [];
  for (let at = 8; at < bytes.length; ) {
    const length = bytes.readUInt32BE(at);
    const type = bytes.subarray(at + 4, at + 8).toString("latin1");
    if (type === "IDAT") parts.push(bytes.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(parts));
  return [...raw.subarray(1, 5)];
}

describe("the .icns", () => {
  const icns = readFileSync(path.join(root, "build/icon.icns"));
  const chunks = new Map<string, Buffer>();
  for (let at = 8; at < icns.length; ) {
    const type = icns.subarray(at, at + 4).toString("latin1");
    const length = icns.readUInt32BE(at + 4);
    chunks.set(type, icns.subarray(at + 8, at + length));
    at += length;
  }

  it("is an icns file holding the ten renditions, 16 to 512 points at 1x and 2x", () => {
    expect(icns.subarray(0, 4).toString("latin1")).toBe("icns");
    expect(icns.readUInt32BE(4)).toBe(icns.length);
    // iconutil keeps 16 and 32 pixels as run-length ARGB (ic04, ic05), the rest as PNG.
    const argb: Record<string, number> = { ic04: 16, ic05: 32 };
    for (const [type, size] of Object.entries(argb)) {
      const chunk = chunks.get(type);
      expect(chunk, type).toBeDefined();
      expect(chunk!.subarray(0, 4).toString("latin1")).toBe("ARGB");
      expect(unpackedLength(chunk!.subarray(4)), type).toBe(4 * size * size);
    }
    const png: Record<string, number> = { ic11: 32, ic12: 64, ic07: 128, ic13: 256, ic08: 256, ic14: 512, ic09: 512, ic10: 1024 };
    for (const [type, size] of Object.entries(png)) {
      const chunk = chunks.get(type);
      expect(chunk, type).toBeDefined();
      expect(pngHeader(chunk!), type).toMatchObject({ width: size, height: size, colourType: 6 });
    }
  });

  it("is the macOS shape: the master's corner is transparent, its centre the artwork", () => {
    const master = readFileSync(path.join(root, "build/icon.png"));
    expect(pngHeader(master)).toEqual({ width: 1024, height: 1024, colourType: 6 });
    expect(firstPixel(master)[3]).toBe(0);
    expect(firstPixel(chunks.get("ic10")!)[3]).toBe(0);
  });
});

describe("where the icon goes", () => {
  it("is electron-builder's mac icon, from build/", () => {
    expect(config.directories.buildResources).toBe("build");
    expect(config.mac.icon).toBe("build/icon.icns");
  });

  it("in development, the dock on macOS and the window elsewhere take build/icon.png; a packaged app has its own", () => {
    expect(developmentIcon("/repo/desktop", false, "darwin")).toEqual({ dock: "/repo/desktop/build/icon.png", window: null });
    expect(developmentIcon("/repo/desktop", false, "linux")).toEqual({ dock: null, window: "/repo/desktop/build/icon.png" });
    expect(developmentIcon("/repo/desktop", false, "win32")).toEqual({ dock: null, window: "/repo/desktop/build/icon.png" });
    expect(developmentIcon("/Applications/Adari.app/Contents/Resources/app.asar", true, "darwin")).toEqual({ dock: null, window: null });
  });
});

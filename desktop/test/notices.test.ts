// Every package carries a self-contained
// THIRD_PARTY_NOTICES.md. It is in electron-builder's file set (so it is in
// app.asar on every OS) and holds the full licence texts of what the build
// bundles from outside this repo: T3 Code (adapted code), ghostty-web
// (Coder) and Ghostty (the wasm terminal core inside ghostty-web, whose own
// LICENSE carries only Coder's text), React, React DOM and Scheduler (bundled
// into the renderer), and the three fonts (OFL). The packaged notices must not
// point at files the package does not contain.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);
const config = require("../electron-builder.config.cjs") as {
  files: string[];
  extraResources?: unknown;
  extraFiles?: unknown;
};
const notices = readFileSync(path.join(root, "THIRD_PARTY_NOTICES.md"), "utf8");

/** A package's LICENSE as npm ships it (the dev dependencies are bundled, so only the build has them). */
const licence = (pkg: string): string => readFileSync(path.join(root, "node_modules", pkg, "LICENSE"), "utf8").trim();

/** The MIT text with a given holder (the body as in ghostty-web's LICENSE). */
const mit = (holder: string): string =>
  ["MIT License", "", `Copyright (c) ${holder}`, ...licence("ghostty-web").split("\n").slice(3)].join("\n");

describe("THIRD_PARTY_NOTICES.md", () => {
  it("is in every package's file set (the root of app.asar)", () => {
    expect(config.files).toContain("THIRD_PARTY_NOTICES.md");
    const exclusions = config.files.filter((pattern) => pattern.startsWith("!"));
    expect(exclusions.filter((pattern) => /\.md\b|NOTICES/.test(pattern))).toEqual([]);
    // electron-builder leaves out of app.asar whatever extraResources or extraFiles copy.
    expect(JSON.stringify([config.extraResources, config.extraFiles])).not.toContain("NOTICES");
  });

  it("carries T3 Code's notice and full licence text", () => {
    expect(notices).toContain(mit("2026 T3 Tools Inc."));
  });

  it("carries ghostty-web's licence text (Coder) as its package has it", () => {
    expect(notices).toContain(licence("ghostty-web"));
  });

  it("carries Ghostty's notice and full licence text, which ghostty-web's LICENSE does not", () => {
    expect(licence("ghostty-web")).not.toContain("Mitchell Hashimoto");
    expect(notices).toContain(mit("2024 Mitchell Hashimoto, Ghostty contributors"));
  });

  it("carries the licence of every other package bundled into the renderer", () => {
    for (const pkg of ["react", "react-dom", "scheduler"]) expect(notices, pkg).toContain(licence(pkg));
  });

  it("carries each bundled font's copyright and OFL text", () => {
    for (const file of ["Geist-OFL.txt", "IBMPlexMono-OFL.txt", "JetBrainsMono-OFL.txt"]) {
      const text = readFileSync(path.join(root, "..", "App", "Fonts", file), "utf8").replace(/\r\n/g, "\n").trim();
      expect(notices, file).toContain(text);
    }
  });

  it("does not send the reader to a licence file the package does not contain", () => {
    expect(notices).not.toContain("ship in the package (`node_modules/ghostty-web/LICENSE`)");
    expect(notices).not.toContain("the licence texts\nare beside the fonts");
  });
});

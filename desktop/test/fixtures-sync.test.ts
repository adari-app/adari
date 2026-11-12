// desktop/fixtures holds copies of the repo's own fixtures (the Swift tests'
// protocol 22 replies, the replay recordings, a live dialog capture) so the
// demo host can bundle them. These tests fail when a copy drifts from its
// source; HERDR_UPDATE_FIXTURES=1 rewrites the copies instead.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { copiedFixtures, fixturesRoot, readSwiftFixture, repoRoot, swiftFixtures } from "./support/swift-fixtures";

const update = process.env["HERDR_UPDATE_FIXTURES"] === "1";

function write(file: string, data: string | Buffer): void {
  const target = path.join(fixturesRoot, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, data);
}

describe("fixtures copied from the Swift tests", () => {
  for (const fixture of swiftFixtures) {
    it(`${fixture.file} matches ${fixture.source}`, () => {
      const source = readSwiftFixture(fixture);
      if (update) write(fixture.file, source);
      expect(readFileSync(path.join(fixturesRoot, fixture.file), "utf8")).toBe(source);
    });
  }

  for (const fixture of copiedFixtures) {
    it(`${fixture.file} matches ${fixture.source}`, () => {
      const source = readFileSync(path.join(repoRoot, fixture.source));
      if (update) write(fixture.file, source);
      expect(readFileSync(path.join(fixturesRoot, fixture.file)).equals(source)).toBe(true);
    });
  }
});

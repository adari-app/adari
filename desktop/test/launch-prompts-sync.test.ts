// The nine launch prompts the desktop's tests read (`Launch` in
// support/prompt-fixtures.ts) are a byte-for-byte copy, in
// test/fixtures/launch-prompts.json, of the design's prompts in
// App/CompanionLaunchFixture.swift. The public copy holds the Mac app only, so
// the comparison runs when that Swift file is in the tree and is skipped when
// it is not.

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { Launch, extractSwiftString, launchPromptsFile, launchSwiftSource } from "./support/prompt-fixtures";
import { hasRepoFile, readRepoFile } from "./support/swift-fixtures";

const names = [
  "pairingPrompt",
  "pairingChangedPrompt",
  "pairingFeedbackField",
  "reviewerFeedbackField",
  "paywallPrompt",
  "paywallCommandPrompt",
  "stringsPrompt",
  "relayPrompt",
  "reviewerPrompt",
] as const;

const hasSwift = hasRepoFile(launchSwiftSource);
const swift = hasSwift ? readRepoFile(launchSwiftSource) : "";

describe("the launch prompts' copy", () => {
  it("holds the nine prompts and nothing else", () => {
    const copy = JSON.parse(readFileSync(launchPromptsFile, "utf8")) as Record<string, unknown>;
    expect(Object.keys(copy)).toEqual([...names]);
    for (const name of names) {
      expect(copy[name], name).toBeTypeOf("string");
      expect(Launch[name]).toBe(copy[name]);
    }
  });

  for (const name of names) {
    it.skipIf(!hasSwift)(`${name} is CompanionLaunchFixture.swift's, byte for byte`, () => {
      expect(Launch[name]).toBe(extractSwiftString(swift, `static let ${name} = `));
    });
  }
});

// The relay script has one source,
// Sources/HerdrKit/Resources/adari-relay.pl; scripts/gen-relay-script.sh writes
// relay-script.ts from it. A relay edit without regenerating goes red here.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { relayScript } from "../src/main/herdr/relay-script";

describe("relay-script.ts", () => {
  it("equals Sources/HerdrKit/Resources/adari-relay.pl byte for byte", () => {
    const source = readFileSync(fileURLToPath(new URL("../../Sources/HerdrKit/Resources/adari-relay.pl", import.meta.url)));
    expect(source.length).toBeGreaterThan(0);
    expect(Buffer.from(relayScript, "utf8").equals(source)).toBe(true);
  });
});

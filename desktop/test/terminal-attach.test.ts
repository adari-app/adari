// The attach's policy pieces, after HerdrKit's tests: readiness on Herdr's
// first frame prefix (even split across packets), ordered input with keys
// typed before readiness dropped (OfficialCompanionTests'
// testOutOfOrderInputTicketsDrainInOriginalOrder and the not-ready cases), the
// measured ending lines (OfficialAttachEndingTests), and the attach target the
// app picks for a pane (CompanionApp).

import { describe, expect, it } from "vitest";

import { attachTargetFor } from "../src/main/herdr/ssh";
import {
  AttachReadiness,
  OrderedTerminalInput,
  clampDimensions,
  classifyAttachEnding,
  officialFramePrefix,
} from "../src/main/herdr/terminal";

const text = (data: Uint8Array | undefined): string | undefined =>
  data === undefined ? undefined : Buffer.from(data).toString("utf8");

describe("AttachReadiness", () => {
  it("turns ready once, on the frame prefix", () => {
    const readiness = new AttachReadiness();
    expect(readiness.record(Buffer.from("Last login: today\r\n$ exec herdr ...\r\n"))).toBe(false);
    expect(readiness.isReady).toBe(false);
    expect(readiness.record(Buffer.concat([Buffer.from("x"), officialFramePrefix, Buffer.from("frame")]))).toBe(true);
    expect(readiness.isReady).toBe(true);
    expect(readiness.record(officialFramePrefix)).toBe(false);
  });

  it("finds a prefix split across packets", () => {
    for (let split = 1; split < officialFramePrefix.length; split += 1) {
      const readiness = new AttachReadiness();
      expect(readiness.record(Buffer.concat([Buffer.from("noise"), officialFramePrefix.subarray(0, split)]))).toBe(false);
      expect(readiness.record(officialFramePrefix.subarray(split))).toBe(true);
    }
  });
});

describe("OrderedTerminalInput", () => {
  it("drains out-of-order tickets in the original order", () => {
    const input = new OrderedTerminalInput();
    const first = input.issue();
    const second = input.issue();
    input.accept(second, Buffer.from("second"), true);
    expect(input.takeNext()).toBeUndefined();
    input.accept(first, Buffer.from("first"), true);
    expect(text(input.takeNext())).toBe("first");
    expect(text(input.takeNext())).toBe("second");
    expect(input.takeNext()).toBeUndefined();
  });

  it("drops a key sent before readiness but keeps its place", () => {
    const input = new OrderedTerminalInput();
    const early = input.issue();
    const late = input.issue();
    input.accept(early, Buffer.from("x"), false);
    input.accept(late, Buffer.from("typed after ready"), true);
    expect(input.takeNext()?.length).toBe(0);
    expect(text(input.takeNext())).toBe("typed after ready");
  });

  it("discards pending keys on close", () => {
    const input = new OrderedTerminalInput();
    input.accept(input.issue(), Buffer.from("discard on close"), true);
    input.clear();
    expect(input.takeNext()).toBeUndefined();
    const next = input.issue();
    input.accept(next, Buffer.from("after"), true);
    expect(text(input.takeNext())).toBe("after");
  });
});

describe("the attach's ending (OfficialAttachEndingTests)", () => {
  const refusal =
    "herdr: server shut down: terminal attach failed: terminal w7:p1 already has an attached client; retry with --takeover";
  const takeover = "herdr: server shut down: terminal attach taken over";

  it("classifies the measured refusal and takeover lines", () => {
    expect(classifyAttachEnding(refusal)).toBe("held-elsewhere");
    expect(classifyAttachEnding(takeover)).toBe("taken-over");
    expect(classifyAttachEnding("\u001b[?1049l\u001b[0m\r\n" + takeover + "\r\n")).toBe("taken-over");
    expect(
      classifyAttachEnding("unset HERDR_SOCKET_PATH; exec herdr …\r\n\u001b[31m" + refusal + "\u001b[0m\r\n"),
    ).toBe("held-elsewhere");
    expect(classifyAttachEnding(takeover + "\n")).toBe("taken-over");
  });

  it("classifies the refusal with other ids, and agent attach", () => {
    for (const id of ["w1:p2", "t_9f3a2c", "42", "w12:pZq", "term-root"]) {
      expect(
        classifyAttachEnding(
          `herdr: server shut down: terminal attach failed: terminal ${id} already has an attached client; retry with --takeover`,
        ),
      ).toBe("held-elsewhere");
    }
    expect(
      classifyAttachEnding(
        "herdr: server shut down: agent attach failed: terminal w3:p7 already has an attached client; retry with --takeover",
      ),
    ).toBe("held-elsewhere");
  });

  it("counts only Herdr's own last line", () => {
    expect(classifyAttachEnding("")).toBeNull();
    expect(classifyAttachEnding("herdr: server shut down")).toBeNull();
    expect(classifyAttachEnding("Connection to mac closed by remote host.\r\n")).toBeNull();
    expect(classifyAttachEnding("  > the old client prints terminal attach taken over\r\n")).toBeNull();
    expect(classifyAttachEnding("• stderr `herdr: server shut down: terminal attach taken over`.")).toBeNull();
    expect(classifyAttachEnding("terminal w7:p1 already has an attached client")).toBeNull();
  });
});

describe("attach target and size", () => {
  it("attaches by terminal id, else by the agent's pane, else not at all", () => {
    expect(attachTargetFor({ paneID: "w1:p1", terminalID: "term-1", agent: "claude" })).toEqual({
      kind: "terminal",
      terminalID: "term-1",
    });
    expect(attachTargetFor({ paneID: "w1:p1", terminalID: "", agent: "claude" })).toEqual({ kind: "agent", paneID: "w1:p1" });
    expect(attachTargetFor({ paneID: "w1:p1", terminalID: "" })).toBeNull();
    expect(attachTargetFor({ paneID: "", terminalID: "term-1" })).toBeNull();
  });

  it("clamps to at least 4 columns and 2 rows", () => {
    expect(clampDimensions(1, 0)).toEqual({ cols: 4, rows: 2 });
    expect(clampDimensions(120, 40)).toEqual({ cols: 120, rows: 40 });
  });
});

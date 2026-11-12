// `pane.read` and `pane.send_keys` as the client sends
// them (checked against Herdr 0.9.5's own API schema, protocol 22, its two
// params objects copied below from `herdr api schema --json`), and the
// demo machine's blocked panes read through the real client and matcher.

import { describe, expect, it } from "vitest";

import { DemoBackend, FixtureTransport, demoScriptFor } from "../src/main/demo/demo-backend";
import { demoCodexUpdatePaneId, demoHostIds, demoHosts, demoUpdateReadyPaneId } from "../src/main/demo/demo-hosts";
import { demoAskScreen, demoBashDone, demoEditScreen, demoQuartzDone, demoUnmatchedScreen } from "../src/main/demo/demo-prompts";
import { HerdrClient } from "../src/main/herdr/client";
import type { HerdrTransport } from "../src/main/herdr/transport";
import { cardContent } from "../src/shared/prompt/card";
import { matchPrompt, promptReadLines, readingMatch } from "../src/shared/prompt/matcher";
import { bundledFixturesForTests } from "./support/demo-fixtures";

type Json = Record<string, unknown>;

/** `#/schemas/request/$defs/PaneReadParams` and `PaneSendKeysParams`, with ReadSource and ReadFormat inlined. */
const schema = {
  "pane.read": {
    properties: {
      format: { enum: ["text", "ansi"] },
      lines: { type: "uint32|null" },
      pane_id: { type: "string" },
      source: { enum: ["visible", "recent", "recent_unwrapped", "detection"] },
      strip_ansi: { type: "boolean" },
    },
    required: ["pane_id", "source"],
  },
  "pane.send_keys": {
    properties: { keys: { type: "string[]" }, pane_id: { type: "string" } },
    required: ["pane_id", "keys"],
  },
} as const;

function conforms(method: keyof typeof schema, params: Json): void {
  const definition = schema[method];
  for (const key of definition.required) expect(params, `${method} requires ${key}`).toHaveProperty(key);
  for (const [key, value] of Object.entries(params)) {
    const property = (definition.properties as Record<string, { enum?: readonly string[]; type?: string }>)[key];
    expect(property, `${method} has no ${key}`).toBeDefined();
    if (property?.enum !== undefined) expect(property.enum).toContain(value);
    if (property?.type === "string") expect(typeof value).toBe("string");
    if (property?.type === "boolean") expect(typeof value).toBe("boolean");
    if (property?.type === "uint32|null") expect(value === null || (Number.isInteger(value) && (value as number) >= 0)).toBe(true);
    if (property?.type === "string[]") expect(Array.isArray(value) && value.every((item) => typeof item === "string")).toBe(true);
  }
}

/** A transport that records each request and answers as Herdr 0.9.5's schema says. */
class Recording implements HerdrTransport {
  readonly sent: { method: string; params: Json }[] = [];
  roundTrip(line: string): Promise<string> {
    const request = JSON.parse(line) as { id: string; method: string; params: Json };
    this.sent.push({ method: request.method, params: request.params });
    const result =
      request.method === "pane.read"
        ? {
            type: "pane_read",
            read: { pane_id: request.params["pane_id"], workspace_id: "w1", tab_id: "w1:t1", source: "recent", format: "text", text: "a\nb", revision: 7, truncated: false },
          }
        : { type: "ok" };
    return Promise.resolve(JSON.stringify({ id: request.id, result }));
  }
  close(): void {}
}

describe("pane.read and pane.send_keys (the Swift app's paneText and sendPaneKeys)", () => {
  it("reads the pane's last 40 lines as plain text, source recent, and presses keys in the pane", async () => {
    const transport = new Recording();
    const client = new HerdrClient(transport);
    expect(await client.paneRead("w1:p1", promptReadLines)).toBe("a\nb");
    await client.paneSendKeys("w1:p1", ["n", "Enter"]);
    expect(transport.sent).toEqual([
      { method: "pane.read", params: { pane_id: "w1:p1", source: "recent", lines: 40, format: "text", strip_ansi: true } },
      { method: "pane.send_keys", params: { pane_id: "w1:p1", keys: ["n", "Enter"] } },
    ]);
    conforms("pane.read", transport.sent[0]!.params);
    conforms("pane.send_keys", transport.sent[1]!.params);
  });

  it("a read without its text is a decoding error", async () => {
    const client = new HerdrClient({
      roundTrip: (line: string) => Promise.resolve(JSON.stringify({ id: (JSON.parse(line) as Json)["id"], result: { type: "pane_read", read: { pane_id: "p" } } })),
      close: () => undefined,
    });
    await expect(client.paneRead("p", 40)).rejects.toThrow();
  });
});

describe("the demo's blocked panes (demo-prompts.ts)", () => {
  const fixtures = bundledFixturesForTests();
  const hosts = demoHosts(fixtures, Date.UTC(2026, 10, 4, 9));
  const mac = hosts.find((host) => host.descriptor.id === demoHostIds.macMini)!;
  const box = hosts.find((host) => host.descriptor.id === demoHostIds.buildBox)!;

  // Also build-box's Codex pane, whose screen shows Codex's update notice (Settings › Updates › Agent CLIs).
  it("every blocked agent of the demo has screens, and nothing else does (but the update-ready pane, and build-box's Codex one)", () => {
    for (const host of hosts) {
      const blocked = (host.snapshot["agents"] as Json[])
        .filter((agent) => agent["agent_status"] === "blocked" || agent["input_pending"] === true)
        .map((agent) => String(agent["pane_id"]))
        .sort();
      const marks = host.descriptor.id === demoHostIds.buildBox ? [demoCodexUpdatePaneId] : [demoUpdateReadyPaneId];
      expect(Object.keys(host.screens ?? {}).filter((pane) => !marks.includes(pane)).sort()).toEqual(blocked);
    }
  });

  it("the Mac mini's Quartz pane: an edit with a diff, then a question, then no question", async () => {
    const backend = new DemoBackend(mac, fixtures);
    const io = backend.promptIO();
    const edit = readingMatch(matchPrompt(await io.paneRead("w2:p70", 40), "w2:p70"))!;
    const card = cardContent(edit, "claude");
    expect(card.header).toBe("Claude Code wants to edit");
    expect(card.target).toBe("src/sync/retry-config.ts");
    expect(card.lines).toHaveLength(6);
    expect(card.lines[1]).toEqual({ number: "19", kind: "removed", text: "     requestsPerMin: 120," });
    expect(card.moreLines).toBe(3);
    expect(card.question).toBe("Edit src/sync/retry-config.ts?");
    expect(card.options.map((option) => option.label)).toEqual(["Yes", "Yes, allow all edits this session", "No, and tell Claude what to do differently"]);
    expect(card.returnIndex).toBe(0);
    expect(card.tellOption?.key).toBe("3");

    await io.paneSendKeys("w2:p70", ["1"]);
    const ask = readingMatch(matchPrompt(await io.paneRead("w2:p70", 40), "w2:p70"))!;
    const asks = cardContent(ask, "claude");
    expect(asks.kind).toBe("asks");
    expect(asks.header).toBe("Claude Code asks");
    expect(asks.target).toBeNull();
    expect(asks.question).toBe("Which group should the rollout start with?");
    expect(asks.options.map((option) => option.key)).toEqual(["1", "2", "3", "4"]);

    await io.paneSendKeys("w2:p70", ["1"]);
    const done = await io.paneRead("w2:p70", 40);
    expect(done).toBe(demoQuartzDone);
    expect(readingMatch(matchPrompt(done, "w2:p70"))).toBeNull();
    await io.paneSendKeys("w2:p70", ["1"]);
    expect(await io.paneRead("w2:p70", 40)).toBe(demoQuartzDone);
    backend.close();
  });

  it("build-box's beacon: Claude Code's Bash dialog, then the command's result; bookshop: an unmatched question", async () => {
    const backend = new DemoBackend(box, fixtures);
    const io = backend.promptIO();
    const bash = readingMatch(matchPrompt(await io.paneRead("w1:p1", 40), "w1:p1"))!;
    expect(cardContent(bash, "claude").header).toBe("Claude Code wants to run");
    expect(cardContent(bash, "claude").target).toBe("echo shapes-c > /private/tmp/z-shapes/c.txt");
    await io.paneSendKeys("w1:p1", ["1"]);
    const after = await io.paneRead("w1:p1", 40);
    expect(after.split("\n").slice(-6)).toEqual(demoBashDone(fixtures.bashDialog).split("\n").slice(-6));
    expect(readingMatch(matchPrompt(after, "w1:p1"))).toBeNull();

    const bookshop = matchPrompt(await io.paneRead("w1:p2", 40), "w1:p2");
    expect(bookshop).toEqual({
      type: "unmatched",
      lines: [
        "• Merging the staging settings into src/config.ts.",
        "Codex wants to overwrite src/config.ts (412 lines) with the merged settings.",
        "› Overwrite      Keep mine      Show the diff",
        "Press enter to confirm or esc to cancel",
      ],
    });
    expect(demoUnmatchedScreen).toContain("Codex wants to overwrite");
    backend.close();
  });

  it("a pane without screens reads empty; an unknown pane is refused", async () => {
    const transport = new FixtureTransport(box.snapshot, box.screens);
    const client = new HerdrClient(transport);
    expect(await client.paneRead("w2:p3", 40)).toBe("");
    await expect(client.paneRead("w9:p9", 40)).rejects.toThrow(/pane_not_found/);
    await expect(client.paneSendKeys("w9:p9", ["1"])).rejects.toThrow(/pane_not_found/);
    expect(await client.paneRead("w1:p1", 3)).toBe(fixtures.bashDialog.split("\n").slice(-3).join("\n"));
  });

  it("the terminal shows the pane's screen", () => {
    const transport = new FixtureTransport(mac.snapshot, mac.screens);
    const pane = { paneID: "w2:p70", agent: "claude", agentStatus: "idle" } as Parameters<typeof demoScriptFor>[1];
    expect(demoScriptFor(mac.snapshot, pane, fixtures, [], transport.screen("w2:p70"))).toEqual({ kind: "text", text: demoEditScreen });
    expect(demoScriptFor(mac.snapshot, pane, fixtures)).toEqual({ kind: "text", text: fixtures.bashDialog });
    expect(demoAskScreen).toContain("Which group");
  });
});

describe("the needs-you card's captures (main.ts takes them after sendCaptureSteps' 44)", () => {
  it("45 to 50: a run, an edit, the asks menu after its answer, an unmatched question, Sent, the sidebar after; each measured", async () => {
    const { needsCardCaptureSteps, sendCaptureSteps } = await import("../src/main/capture");
    const steps = needsCardCaptureSteps(demoHostIds);
    expect(sendCaptureSteps(demoHostIds).at(-1)!.name).toBe("44-multiline-sent-at-end");
    expect(steps.map((step) => step.name)).toEqual([
      "45-needs-card-run",
      "46-needs-card-edit",
      "47-needs-card-asks",
      "48-needs-card-unmatched",
      "49-needs-card-sent",
      "50-needs-card-gone-sidebar",
    ]);
    expect(steps[2]!.commands).toEqual([{ type: "click", selector: '.ncard .nc-opt[data-key="1"]' }]);
    expect(steps.every((step) => step.measure?.includes("data-needs-card") === true)).toBe(true);
  });
});

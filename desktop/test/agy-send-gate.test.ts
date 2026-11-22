// A message never lands in an Antigravity CLI question that was not read. A
// Send to an agy pane Herdr says is idle or done reads the pane's screen in its own turn, the last thing awaited
// before the text, and writes only when that read shows agy's input box whole at the bottom (agyInputClear): a rule,
// the `>` box (more rows indented by two spaces for a longer draft), a rule, then the mode line's row, not "esc to
// cancel". A question, a frame cut anywhere, a screen not known, a read that failed or came late: nothing written,
// the text kept with the words for a pane that is asking. A working agy pane and every other kind: no read, the same
// calls as before. The screens are the live samples (agy 1.5.13, 119 columns), names and paths made neutral.

import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { pasteEnd, pasteStart, promptRefusal, sendBound, type SendSite } from "../src/main/herdr/send";
import { APIError } from "../src/main/herdr/wire";
import { HostRegistry } from "../src/main/hosts";
import { agyDoneWindowMs, PromptService } from "../src/main/prompt/prompts";
import { agyInputClear, agySendReadMs } from "../src/shared/agy-input";
import { readingMatch } from "../src/shared/prompt/matcher";
import { backend, clock, FakeHerdr, show, snapshot, type Json } from "./support/prompt-herdr";

const idleScreen = (name: string): string => readFileSync(path.join(__dirname, "fixtures/agy-input", `${name}.txt`), "utf8");
const question = (name: string): string => readFileSync(path.join(__dirname, "fixtures/antigravity", `${name}.txt`), "utf8");

const idleNames = ["idle-start", "idle-plan", "idle-ask-mode", "idle-accept-edits", "idle-typed", "idle-cleared", "idle-two-lines", "idle-after-reply", "idle-after-esc"];
const questionNames = ["trust-119", "command-ask", "create-file-ask", "edit-file-ask"];
const asking = promptRefusal(new APIError("agent_blocked", "agent is blocked"));

afterEach(() => vi.useRealTimers());

describe("agy's input box seen whole at the bottom (agyInputClear, the samples)", () => {
  for (const name of idleNames) {
    it(`${name}: clear`, () => {
      expect(agyInputClear(idleScreen(name))).toBe(true);
    });
  }
  it("working: not clear (its last row starts with esc to cancel)", () => {
    expect(agyInputClear(idleScreen("working"))).toBe(false);
  });
  for (const name of questionNames) {
    it(`${name}: not clear`, () => {
      expect(agyInputClear(question(name))).toBe(false);
    });
  }

  it("a question drawn only through its choices (no navigation row yet), or cut after its question: not clear", () => {
    const rows = question("create-file-ask").split("\n");
    const choices = rows.findIndex((row) => row.includes("2. No, deny creation"));
    expect(choices).toBeGreaterThan(0);
    expect(agyInputClear(rows.slice(0, choices + 1).join("\n"))).toBe(false);
    expect(agyInputClear(rows.slice(0, choices - 1).join("\n"))).toBe(false);
    const command = question("command-ask").split("\n");
    const last = command.findIndex((row) => row.includes("4. No, cancel"));
    expect(agyInputClear(command.slice(0, last + 1).join("\n"))).toBe(false);
  });

  it("an idle frame cut anywhere: not clear", () => {
    const rows = idleScreen("idle-two-lines").replace(/\n$/u, "").split("\n");
    const n = rows.length;
    // The mode line's row gone, the lower rule gone, the upper rule gone (the read starts in the box), only the bottom.
    expect(agyInputClear(rows.slice(0, n - 1).join("\n"))).toBe(false);
    expect(agyInputClear([...rows.slice(0, n - 2), rows[n - 1]!].join("\n"))).toBe(false);
    expect(agyInputClear(rows.slice(n - 4).join("\n"))).toBe(false);
    expect(agyInputClear(rows.slice(n - 3).join("\n"))).toBe(false);
    // The two rules not the same width (one cut short).
    expect(agyInputClear([...rows.slice(0, n - 5), "─".repeat(40), ...rows.slice(n - 4)].join("\n"))).toBe(false);
  });

  it("a screen it does not know: not clear", () => {
    for (const text of ["", "\n\n", "hello", "> ", `${"─".repeat(119)}\n> \n${"─".repeat(119)}`, `${"─".repeat(119)}\n> \n${"─".repeat(119)}\nPress Ctrl+C again to exit      auto · Gemini 4 Hydrogen · low`]) {
      expect(agyInputClear(text)).toBe(false);
    }
  });

  it("blank rows under the mode line are not part of the frame", () => {
    expect(agyInputClear(`${idleScreen("idle-cleared")}\n\n\n`)).toBe(true);
  });
});

/** An agy pane Herdr says is `status`; `screen` what its read shows (null: the read fails), `late`: it never answers. */
function agyPane(status: "idle" | "done" | "working", screen: () => string | null, kind = "agy") {
  const calls: unknown[][] = [];
  let answer = "";
  const order: string[] = [];
  const typed = (value: string): void => {
    const body = value.replace(pasteStart, "").replace(pasteEnd, "");
    // The file question takes a digit at once.
    if (screen() === question("create-file-ask") && /^\d/u.test(body)) answer = body[0]!;
  };
  const site: SendSite = {
    writer: {
      prompt: async () => undefined,
      sendInput: async (_p, value, keys) => {
        order.push("write");
        calls.push(["send_input", value, keys]);
        typed(value);
      },
      sendText: async (_p, value) => {
        order.push("write");
        calls.push(["send_text", value]);
        typed(value);
      },
      agentKeys: async (_p, keys) => {
        order.push("keys");
        calls.push(["agent_keys", keys]);
      },
    },
    fresh: async () => true,
    pane: () => ({ paneID: "p1", terminalID: "t1", agent: kind, agentStatus: status }) as never,
    agent: () => ({ paneID: "p1", terminalID: "t1", agent: kind, agentStatus: status, agentSession: { source: `herdr:${kind}`, kind: "id", value: "s1" } }) as never,
    run: () => ({ connection: 1, arrival: 1 }),
  };
  let reads = 0;
  const reader: Pick<SendSite, "agyScreen"> = {
    agyScreen: async () => {
      reads += 1;
      order.push("read");
      const text = screen();
      if (text === null) throw new Error("the read failed");
      return text;
    },
  };
  const binding = { terminalID: "t1", isAgent: true, kind, session: "s1", run: { connection: 1, arrival: 1 } };
  return {
    calls,
    order,
    answer: () => answer,
    reads: () => reads,
    send: (text: string, extra: Partial<SendSite> = reader) =>
      sendBound({ ...site, ...extra }, "p1", text, binding).then(
        () => "sent",
        (error: Error) => error.message,
      ),
  };
}

describe("a Send to an idle or done agy pane reads it first (the reviewer's file-question case)", () => {
  for (const status of ["idle", "done"] as const) {
    it(`${status}, its file question on screen: nothing written, the digit never reaches it, the asking words`, async () => {
      const pane = agyPane(status, () => question("create-file-ask"));
      expect(await pane.send("1 more change please")).toBe(asking);
      expect(pane.calls).toEqual([]);
      expect(pane.answer()).toBe("");
      expect(pane.reads()).toBe(1);
    });

    it(`${status}, each of agy's four questions: nothing written`, async () => {
      for (const name of questionNames) {
        const pane = agyPane(status, () => question(name));
        expect(await pane.send("hello")).toBe(asking);
        expect(pane.calls).toEqual([]);
      }
    });

    it(`${status}, its input box at the bottom: one read, then the same calls as before (the paste, then its Return)`, async () => {
      for (const name of idleNames) {
        const pane = agyPane(status, () => idleScreen(name));
        expect(await pane.send("hello")).toBe("sent");
        expect(pane.calls).toEqual([
          ["send_text", `${pasteStart}hello${pasteEnd}`],
          ["agent_keys", ["Enter"]],
        ]);
        expect(pane.order).toEqual(["read", "write", "keys"]);
      }
    });

    it(`${status}, the read failed, or there is no reader: nothing written`, async () => {
      const failed = agyPane(status, () => null);
      expect(await failed.send("hello")).toBe(asking);
      expect(failed.calls).toEqual([]);
      const none = agyPane(status, () => idleScreen("idle-cleared"));
      expect(await none.send("hello", {})).toBe(asking);
      expect(none.calls).toEqual([]);
    });
  }

  it("a read that answers later than its bound: nothing written, even when it shows the box", async () => {
    vi.useFakeTimers();
    const pane = agyPane("done", () => idleScreen("idle-cleared"));
    let answer: (text: string) => void = () => undefined;
    const outcome = pane.send("hello", { agyScreen: () => new Promise<string>((resolve) => (answer = resolve)) });
    await vi.advanceTimersByTimeAsync(agySendReadMs + 1);
    answer(idleScreen("idle-cleared"));
    expect(await outcome).toBe(asking);
    expect(pane.calls).toEqual([]);
  });

  it("a working agy pane: no read, the same calls as before", async () => {
    const pane = agyPane("working", () => question("create-file-ask"));
    expect(await pane.send("hello")).toBe("sent");
    expect(pane.reads()).toBe(0);
    expect(pane.calls).toEqual([
      ["send_text", `${pasteStart}hello${pasteEnd}`],
      ["agent_keys", ["Enter"]],
    ]);
  });

  it("another kind Herdr says is idle (the probe's `antigravity`, Gemini CLI, Codex): no read", async () => {
    for (const kind of ["antigravity", "gemini", "pi"]) {
      const pane = agyPane("idle", () => question("create-file-ask"), kind);
      expect(await pane.send("hello")).toBe("sent");
      expect(pane.reads()).toBe(0);
    }
  });
});

/** Three panes as prompt-agy-done's: agy (w1:p1) done since 1 s, its read through the real PromptService. */
function doneSnapshot(): Json {
  const json = snapshot();
  json["panes"] = [{ pane_id: "w1:p1", terminal_id: "term-1", workspace_id: "w1", tab_id: "w1:t1", focused: true, agent: "agy", agent_status: "done", revision: 1 }];
  json["agents"] = [{ pane_id: "w1:p1", agent: "agy", agent_status: "done", status_since_unix_ms: 1_000, completion_seq: 7085 }];
  return json;
}

describe("the Send's read through the prompt service (PromptService.sendRead)", () => {
  it("past the watch's 10 s window, a question the Send reads whole becomes the pane's card; the box shows none", async () => {
    const herdr = new FakeHerdr(doneSnapshot(), { "w1:p1": [idleScreen("idle-after-reply")] });
    const registry = new HostRegistry(() => undefined);
    registry.add({ id: "mac", name: "Fixture host", kind: "demo", address: "demo", platform: "macOS" }, backend(herdr, { value: 1 }));
    await registry.refreshAll();
    const time = clock();
    const service = new PromptService(registry, () => undefined, time);
    await service.tick();
    for (let at = 0; at < 6; at += 1) {
      time.t += 2_500;
      await service.tick();
    }
    expect(time.t).toBeGreaterThan(agyDoneWindowMs);
    const reads = () => herdr.sent("pane.read").filter((params) => params["pane_id"] === "w1:p1").length;
    const before = reads();
    // The watch no longer reads it; the file question shows now.
    show(herdr, "w1:p1", question("create-file-ask"));
    time.t += 2_500;
    await service.tick();
    expect(reads()).toBe(before);
    expect(service.list()).toEqual([]);
    const text = await service.sendRead("mac", "w1:p1");
    expect(text).not.toBeNull();
    expect(agyInputClear(text!)).toBe(false);
    expect(readingMatch(service.list()[0]?.reading)?.question).toBe("Allow creation of this file?");
    // The idle box: read, clear, no card.
    show(herdr, "w1:p1", idleScreen("idle-cleared"));
    const idle = await service.sendRead("mac", "w1:p1");
    expect(agyInputClear(idle!)).toBe(true);
    expect(service.list()).toEqual([]);
  });
});

// The card's answers in the main process
// (src/main/prompt/prompts.ts), through the real HostRegistry and HerdrClient
// on a fake Herdr (the demo's FixtureTransport: session.snapshot, pane.read,
// pane.send_keys and agent.prompt answered from a snapshot and per-pane
// screens). One key goes only while the question on screen has the
// fingerprint the page showed; nothing when the question changed, the pane
// changed, or the machine reconnected; the "No, tell…" text follows once the
// agent's empty field shows.

import { describe, expect, it } from "vitest";

import { readingMatch } from "../src/shared/prompt/matcher";
import { isAnswerRequest } from "../src/shared/prompt/view";
import { NeedsCardStore } from "../src/renderer/chat/needs-card-store";
import { F, L } from "./support/prompt-fixtures";
import { changeAgent, duringRead, setup, show, type FakeHerdr } from "./support/prompt-herdr";

describe("reading the blocked panes", () => {
  it("reads only the blocked pane, and sends the page its reading", async () => {
    const { herdr, service, pushed } = await setup(L.claude2_1_303Bash);
    expect(herdr.sent("pane.read")).toEqual([{ pane_id: "w1:p1", source: "recent", lines: 40, format: "text", strip_ansi: true }]);
    const prompts = service.list();
    expect(prompts.map((prompt) => prompt.paneId)).toEqual(["w1:p1"]);
    expect(readingMatch(prompts[0]!.reading!)?.question).toBe("Do you want to proceed?");
    // Claude's plain "No" opens its field: the reading is the agent's.
    expect(readingMatch(prompts[0]!.reading!)?.options.at(-1)?.opensComposer).toBe(true);
    expect(pushed.at(-1)).toEqual(prompts);
  });

  it("reads nothing while the machine does not answer", async () => {
    const { herdr, registry, service } = await setup(L.claude2_1_303Bash);
    const before = herdr.sent("pane.read").length;
    (registry as unknown as { entries: { state: string }[] }).entries[0]!.state = "offline";
    await service.tick();
    expect(herdr.sent("pane.read")).toHaveLength(before);
    expect(service.list()).toEqual([]);
  });
});

describe("an answer from the card", () => {
  it("sends the option's key once while the fingerprint matches", async () => {
    const { herdr, service, request } = await setup(L.claude2_1_303Bash, [L.claude2_1_303AfterNo]);
    expect(await service.answer(request("1"))).toEqual({ type: "sent", label: "Yes" });
    expect(herdr.sent("pane.send_keys")).toEqual([{ pane_id: "w1:p1", keys: ["1"] }]);
  });

  it("[y/N] sends its letter and Return", async () => {
    const { herdr, service, request } = await setup(F.codexYesNo);
    expect(await service.answer(request("n"))).toEqual({ type: "sent", label: "Deny" });
    expect(herdr.sent("pane.send_keys")).toEqual([{ pane_id: "w1:p1", keys: ["n", "Enter"] }]);
  });

  it("sends nothing when the question changed, and shows the new one", async () => {
    const { herdr, service, request } = await setup(L.claude2_1_303Bash);
    const asked = request("1");
    // The pane moves on to another question after the card showed this one.
    show(herdr, "w1:p1", L.claude2_1_303Write);
    const result = await service.answer(asked);
    expect(result.type).toBe("changed");
    if (result.type === "changed") {
      expect(result.note).toBe("Not sent: the question changed");
      expect(readingMatch(result.now)?.question).toBe("Do you want to create new.txt?");
    }
    expect(herdr.sent("pane.send_keys")).toEqual([]);
    expect(readingMatch(service.list()[0]!.reading!)?.question).toBe("Do you want to create new.txt?");
  });

  it("sends nothing for a fingerprint main never showed, or an option the question lacks", async () => {
    const { herdr, service, request } = await setup(L.claude2_1_303Bash);
    const asked = request("1");
    expect((await service.answer({ ...asked, fingerprint: { ...asked.fingerprint, question: "Delete everything?" } })).type).toBe("changed");
    expect((await service.answer(request("7"))).type).toBe("changed");
    expect(herdr.sent("pane.send_keys")).toEqual([]);
  });

  it("sends nothing when the pane changed (another terminal, another session, no longer asking)", async () => {
    for (const change of [
      (herdr: FakeHerdr) => (herdr.paneEntry("w1:p1")["terminal_id"] = "term-9"),
      (herdr: FakeHerdr) => (herdr.agentEntry("w1:p1")["agent_session"] = { source: "herdr:claude", agent: "claude", kind: "id", value: "s-2" }),
      (herdr: FakeHerdr) => {
        herdr.agentEntry("w1:p1")["agent_status"] = "working";
        herdr.paneEntry("w1:p1")["agent_status"] = "working";
      },
    ]) {
      const { herdr, service, request } = await setup(L.claude2_1_303Bash);
      const asked = request("1");
      change(herdr);
      const result = await service.answer(asked);
      expect(result.type).toBe("refused");
      expect(herdr.sent("pane.send_keys")).toEqual([]);
    }
  });

  it("sends nothing when the machine reconnected, before the check or right before the keys", async () => {
    const early = await setup(L.claude2_1_303Bash);
    const asked = early.request("1");
    early.epoch.value = 2;
    expect(await early.service.answer(asked)).toEqual({ type: "refused", note: "Not sent: the connection to Mac mini changed" });
    expect(early.herdr.sent("pane.send_keys")).toEqual([]);

    // Between the re-read and the keys: the gate closes, nothing is pressed.
    const late = await setup(L.claude2_1_303Bash);
    const request = late.request("1");
    const reads = late.herdr.sent("pane.read").length;
    const realRead = late.herdr.roundTrip.bind(late.herdr);
    late.herdr.roundTrip = (line: string) => {
      const reply = realRead(line);
      if ((JSON.parse(line) as { method: string }).method === "pane.read") late.epoch.value = 3;
      return reply;
    };
    expect(await late.service.answer(request)).toEqual({ type: "refused", note: "Not sent: the connection to Mac mini changed" });
    expect(late.herdr.sent("pane.read").length).toBe(reads + 1);
    expect(late.herdr.sent("pane.send_keys")).toEqual([]);
  });

  it("an unreadable pane sends nothing", async () => {
    const { herdr, service, request } = await setup(L.claude2_1_303Bash);
    herdr.readFails = true;
    expect(await service.answer(request("1"))).toEqual({ type: "refused", note: "Not sent: the pane could not be read" });
    expect(herdr.sent("pane.send_keys")).toEqual([]);
  });

  it("one answer at a time per pane", async () => {
    const { herdr, service, request } = await setup(L.claude2_1_303Bash);
    const [first, second] = await Promise.all([service.answer(request("1")), service.answer(request("1"))]);
    expect(first).toEqual({ type: "sent", label: "Yes" });
    expect(second).toEqual({ type: "refused", note: "Not sent: an answer to this question is already going" });
    expect(herdr.sent("pane.send_keys")).toHaveLength(1);
  });
});

describe("the box's text with the “No, tell…” option", () => {
  it("sends the option, then the text once Herdr says idle and the agent's empty field shows", async () => {
    const { herdr, service, request } = await setup(L.claude2_1_303Bash, [L.claude2_1_303AfterNo]);
    const asked = request("4", "Use the staging folder instead");
    // Claude goes idle with its field open once the No went.
    herdr.beforeKeys = () => {
      herdr.agentEntry("w1:p1")["agent_status"] = "idle";
      herdr.paneEntry("w1:p1")["agent_status"] = "idle";
    };
    expect(await service.answer(asked)).toEqual({ type: "sent", label: "No" });
    expect(herdr.sent("pane.send_keys")).toEqual([{ pane_id: "w1:p1", keys: ["4"] }]);
    expect(herdr.sent("agent.prompt")).toEqual([{ target: "w1:p1", text: "Use the staging folder instead" }]);
  });

  it("keeps the text when the field never shows (the option went)", async () => {
    const { herdr, service, request, time } = await setup(F.claudeEdit, [F.working]);
    const start = time.t;
    const result = await service.answer(request("3", "Use TestClock"));
    expect(result).toEqual({
      type: "answeredOnly",
      label: "No, tell the agent what to change",
      note: "“No, tell the agent what to change” went, but the text was not sent: Claude did not open its text field yet. It is kept.",
    });
    expect(time.t - start).toBeGreaterThanOrEqual(4_000);
    expect(herdr.sent("pane.send_keys")).toEqual([{ pane_id: "w1:p1", keys: ["3"] }]);
    expect(herdr.sent("agent.prompt")).toEqual([]);
  });

  it("refuses text for an option that takes none, and an empty text, sending nothing", async () => {
    const { herdr, service, request } = await setup(L.claude2_1_303Bash);
    expect(await service.answer(request("1", "hello"))).toEqual({ type: "refused", note: "Not sent: “Yes” takes no text. The text is kept." });
    expect(await service.answer(request("4", "   "))).toEqual({ type: "refused", note: "Not sent: the box is empty. The text is kept." });
    expect(herdr.sent("pane.send_keys")).toEqual([]);
  });
});

// The stored reading carries its whole binding, and the last gate checks the pane, its
// terminal, kind, session, block and status again with nothing awaited after.
describe("the last gate re-checks the agent and its block", () => {
  for (const change of ["terminal", "session", "kind", "unblocked", "closed"]) {
    it(`sends nothing when the ${change} changes while the answer's re-read is held`, async () => {
      const context = await setup(L.claude2_1_303Bash);
      const request = context.request("1");
      duringRead(context.herdr, async () => {
        changeAgent(context.herdr, change);
        await context.registry.refreshAll();
      });
      const result = await context.service.answer(request);
      expect(result.type).toBe("refused");
      expect(context.herdr.sent("pane.send_keys")).toEqual([]);
    });
  }

  it("sends nothing for a new block of the same agent showing the same question", async () => {
    const context = await setup(L.claude2_1_303Bash);
    const request = context.request("1");
    context.herdr.agentEntry("w1:p1")["status_since_unix_ms"] = 9_999;
    await context.registry.refreshAll();
    expect((await context.service.answer(request)).type).toBe("refused");
    expect(context.herdr.sent("pane.send_keys")).toEqual([]);
  });

  it("never pairs an old watch's reading with a newer binding (a replacement terminal)", async () => {
    const context = await setup(L.claude2_1_303Bash);
    context.herdr.paneEntry("w1:p1")["terminal_id"] = "replacement-terminal";
    await context.registry.refreshAll();
    // The page's binding is new; main's stored reading is the old terminal's.
    expect((await context.service.answer(context.request("1"))).type).not.toBe("sent");
    expect(context.herdr.sent("pane.send_keys")).toEqual([]);
  });

  it("the request names the reading it answers: another block's reading sends nothing", async () => {
    const context = await setup(L.claude2_1_303Bash);
    expect((await context.service.answer({ ...context.request("1"), episode: "another" })).type).toBe("changed");
    expect(context.herdr.sent("pane.send_keys")).toEqual([]);
    const { episode: _, ...unnamed } = context.request("1");
    expect(isAnswerRequest(context.request("1"))).toBe(true);
    expect(isAnswerRequest(unnamed)).toBe(false);
  });

  it("control: unchanged, the key goes once", async () => {
    const context = await setup(L.claude2_1_303Bash);
    duringRead(context.herdr, () => context.registry.refreshAll());
    expect(await context.service.answer(context.request("1"))).toEqual({ type: "sent", label: "Yes" });
    expect(context.herdr.sent("pane.send_keys")).toHaveLength(1);
  });
});

// After the read that shows the agent's empty field, the destination is checked again right before
// agent.prompt; any change keeps the text (the option already went).
describe("the tell text re-checks its destination after the field read", () => {
  for (const change of ["terminal", "session", "kind", "epoch", "offline"]) {
    it(`keeps the text when the ${change} changes while the field read is held`, async () => {
      const context = await setup(L.claude2_1_303Bash, [L.claude2_1_303AfterNo]);
      const request = context.request("4", "Do X instead");
      context.herdr.beforeKeys = () => {
        context.herdr.agentEntry("w1:p1")["agent_status"] = "idle";
        context.herdr.paneEntry("w1:p1")["agent_status"] = "idle";
      };
      // Read 1 is the answer's re-read; read 2 the first look at the field.
      duringRead(
        context.herdr,
        async () => {
          if (change === "epoch") context.epoch.value += 1;
          else if (change !== "offline") changeAgent(context.herdr, change);
          if (change === "offline") (context.registry as unknown as { entries: { state: string }[] }).entries[0]!.state = "offline";
          else await context.registry.refreshAll();
        },
        2,
      );
      const result = await context.service.answer(request);
      expect(result.type).toBe("answeredOnly");
      expect(context.herdr.sent("pane.send_keys")).toEqual([{ pane_id: "w1:p1", keys: ["4"] }]);
      expect(context.herdr.sent("agent.prompt")).toEqual([]);
    });
  }

  it("keeps the text when the agent is at work again, or asks again, by the time its field shows", async () => {
    for (const status of ["working", "blocked"]) {
      const context = await setup(L.claude2_1_303Bash, [L.claude2_1_303AfterNo]);
      context.herdr.beforeKeys = () => {
        context.herdr.agentEntry("w1:p1")["agent_status"] = "idle";
        context.herdr.paneEntry("w1:p1")["agent_status"] = "idle";
      };
      duringRead(
        context.herdr,
        async () => {
          context.herdr.agentEntry("w1:p1")["agent_status"] = status;
          context.herdr.paneEntry("w1:p1")["agent_status"] = status;
          await context.registry.refreshAll();
        },
        2,
      );
      expect((await context.service.answer(context.request("4", "Do X instead"))).type).toBe("answeredOnly");
      expect(context.herdr.sent("agent.prompt")).toEqual([]);
    }
  });
});

// One answer per question (as Swift's testFastRepeatAfterTheSendIsRefused and
// testRepeatAfterAPartlyDrawnReadOfTheSamePromptSendsOnce check), held in main
// from the keys going until the pane proves another question (a whole frame
// with another fingerprint), another block or agent.
describe("one answer per question, enforced in main", () => {
  const partly = (text: string): string => text.split("\n").slice(0, -3).join("\n");

  it("a second identical request after the first went sends nothing", async () => {
    const context = await setup(L.claude2_1_303Bash);
    const request = context.request("1");
    expect((await context.service.answer(request)).type).toBe("sent");
    expect(await context.service.answer(request)).toEqual({ type: "refused", note: "Not sent: this question was already answered" });
    expect((await context.service.answer(context.request("2"))).type).toBe("refused");
    expect(context.herdr.sent("pane.send_keys")).toHaveLength(1);
  });

  it("the recorded partly drawn frame, then the whole question again: the card keeps Sent and one key goes", async () => {
    const context = await setup(F.claudeEdit);
    const store = new NeedsCardStore();
    store.receive(context.service.list());
    const shown = context.shown();
    const bridge = { answerPrompt: context.service.answer.bind(context.service) };
    const host = () => context.registry.list()[0]!;
    await store.answer(bridge, host(), "w1:p1", "claude", shown, shown.options[0]!);
    expect(store.card("mac", "w1:p1").sent?.label).toBe("Yes");
    show(context.herdr, "w1:p1", partly(F.claudeEdit));
    await context.service.tick();
    store.receive(context.service.list());
    show(context.herdr, "w1:p1", F.claudeEdit);
    await context.service.tick();
    store.receive(context.service.list());
    expect(store.card("mac", "w1:p1").sent?.label).toBe("Yes");
    // Main refuses a second answer whatever the page shows.
    await store.answer(bridge, host(), "w1:p1", "claude", shown, shown.options[0]!);
    expect(context.herdr.sent("pane.send_keys")).toHaveLength(1);
  });

  it("the claim holds through a quiet screen and a partly drawn read in main", async () => {
    const context = await setup(F.claudeEdit, [F.working]);
    const request = context.request("1");
    expect((await context.service.answer(request)).type).toBe("sent");
    await context.service.tick();
    show(context.herdr, "w1:p1", partly(F.claudeEdit));
    await context.service.tick();
    show(context.herdr, "w1:p1", F.claudeEdit);
    await context.service.tick();
    expect((await context.service.answer(context.request("1"))).type).toBe("refused");
    expect(context.herdr.sent("pane.send_keys")).toHaveLength(1);
  });

  it("released by a whole frame of another question, and by another block", async () => {
    const context = await setup(L.claude2_1_303Bash, [L.claude2_1_303Write]);
    expect((await context.service.answer(context.request("1"))).type).toBe("sent");
    await context.service.tick();
    expect(readingMatch(context.service.list()[0]!.reading!)?.question).toBe("Do you want to create new.txt?");
    expect((await context.service.answer(context.request("1"))).type).toBe("sent");
    expect(context.herdr.sent("pane.send_keys")).toHaveLength(2);

    const again = await setup(L.claude2_1_303Bash);
    expect((await again.service.answer(again.request("1"))).type).toBe("sent");
    again.herdr.agentEntry("w1:p1")["status_since_unix_ms"] = 9_999;
    await again.registry.refreshAll();
    await again.service.tick();
    expect((await again.service.answer(again.request("1"))).type).toBe("sent");
    expect(again.herdr.sent("pane.send_keys")).toHaveLength(2);
  });
});

// A late answer result applies
// only to the question it answered.
describe("a late result leaves the next question live", () => {
  it("a slow key reply while the next question arrives: busy ends, the new question is not marked Sent", async () => {
    const context = await setup(L.claude2_1_303Bash, [L.claude2_1_303Write]);
    const store = new NeedsCardStore();
    store.receive(context.service.list());
    const shown = context.shown();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const real = context.herdr.roundTrip.bind(context.herdr);
    let waiting = false;
    context.herdr.roundTrip = async (line: string) => {
      // The pane moves to the next question as soon as the key goes; its reply is slow.
      const reply = real(line);
      if ((JSON.parse(line) as { method: string }).method === "pane.send_keys") {
        waiting = true;
        await held;
      }
      return reply;
    };
    const answer = store.answer({ answerPrompt: context.service.answer.bind(context.service) }, context.registry.list()[0]!, "w1:p1", "claude", shown, shown.options[0]!);
    for (let index = 0; index < 50 && !waiting; index += 1) await Promise.resolve();
    expect(waiting).toBe(true);
    await context.service.tick();
    store.receive(context.service.list());
    expect(readingMatch(store.forPane("mac", "w1:p1")!.reading!)?.question).toBe("Do you want to create new.txt?");
    release();
    expect((await answer)?.type).toBe("sent");
    expect(store.card("mac", "w1:p1")).toMatchObject({ sent: null, busy: false, note: null });
  });

  it("the same question still showing (or a frame that proves nothing): Sent as before", async () => {
    const context = await setup(L.claude2_1_303Bash, [L.claude2_1_303AfterNo]);
    const store = new NeedsCardStore();
    store.receive(context.service.list());
    const shown = context.shown();
    await store.answer({ answerPrompt: context.service.answer.bind(context.service) }, context.registry.list()[0]!, "w1:p1", "claude", shown, shown.options[0]!);
    expect(store.card("mac", "w1:p1").sent?.label).toBe("Yes");
  });
});

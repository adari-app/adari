// The first message of a new chat: five further cases (F1 to F5), each as what must hold, and a parity check
// against main's earlier pending.ts (loaded from git beside this one): every send
// not made into a transcript Chat said was not found keeps main's states, labels, places and answers at every step.
// Invented texts; no Herdr.

import { describe, expect, it } from "vitest";

import * as current from "../src/shared/chat/pending";
import { emptyTimeline, makeTurn, userMessage, type ChatItem, type ChatTimeline } from "../src/shared/chat/model";
import { hasMainPending, mainPending } from "./support/main-pending";

type Pending = typeof current;

// The cases that compare with the earlier pending.ts run only where this repository's history holds it: skipped in
// the public copy (one commit per release) and in a download with no history.
const hasMain = hasMainPending();

const { notSentLabel, notSentWhileWorkingMs, PendingBackstop, PendingMessages, pendingLabel } = current;

const key = "fixture/pane";
const other = "fixture/other";
const scope = { terminalID: "term", session: "session" };
const now = 1_800_000_000_000;
const user = (id: string, text: string, time: number | null): ChatItem => ({ type: "user", value: userMessage(id, text, time) });
const reply = (id: string, text: string): ChatItem => ({ type: "agentText", value: { id, markdown: text, time: null } });
const tl = (...items: ChatItem[]): ChatTimeline => ({ ...emptyTimeline, turns: items.map((item, index) => makeTurn(`t${index}`, { items: [item], isFinished: true, startedAt: item.value.time ?? null })) });

/** A fake scheduler for the backstop: timers run when the test says. */
function clock(start: number) {
  let at = start;
  const timers: { run: () => void; due: number; live: boolean }[] = [];
  return {
    now: () => at,
    schedule: (run: () => void, ms: number) => {
      const timer = { run, due: at + ms, live: true };
      timers.push(timer);
      return timer;
    },
    cancel: (timer: unknown) => {
      (timer as { live: boolean }).live = false;
    },
    /** Time moves to `to`; each timer due by then runs once, in order. */
    async advance(to: number) {
      at = to;
      // A timer that runs may arm another: only the ones there now run in this step.
      for (const timer of timers.slice()) {
        if (!timer.live || timer.due > at) continue;
        timer.live = false;
        timer.run();
        for (let i = 0; i < 10; i += 1) await Promise.resolve();
      }
    },
  };
}

describe("the further cases, as they must now end", () => {
  /** A named session loading in Chat (not "not found"): main's path. */
  function loading(store: InstanceType<typeof PendingMessages>): string {
    store.reconcile(new Map([[key, scope]]), () => true);
    store.observe(key, emptyTimeline, false);
    const id = store.add(key, "continue", now, scope);
    store.delivered(id);
    return id;
  }

  it("F1: loading, identical history 60 s old, the send never arrives: main's Not sent with the tap", () => {
    const store = new PendingMessages();
    const id = loading(store);
    store.observe(key, tl(user("history", "continue", now / 1_000 - 60)));
    expect(store.markNotSent(key, null, now + 10_000)).toBe(true);
    expect(pendingLabel(store.forPane(key)[0]!, false, now + 10_000)).toBe(notSentLabel);
    expect(store.takeNotSent(id)).toBe("continue");
  });

  it("F2: loading, a remote clock five minutes ahead, history: not taken, the bubble stays, take-back hides nothing of history", () => {
    const store = new PendingMessages();
    loading(store);
    store.observe(key, tl(user("history", "continue", now / 1_000 + 240)));
    expect(store.forPane(key)).toHaveLength(1);
    expect(store.takeBack(key, "continue")).toBe(true);
    expect([...store.takenBackFor(key)]).toEqual([]);
    expect(store.forPane(key)).toEqual([]);
  });

  it("F3: a not-found send, the backstop's turn before the transcript, then the message with no time or a second behind: one message, nothing to tap", async () => {
    for (const time of [null, now / 1_000 - 1]) {
      const store = new PendingMessages();
      const time0 = clock(now);
      const backstop = new PendingBackstop(store, time0.schedule, time0.cancel, time0.now);
      store.reconcile(new Map([[key, scope]]), () => true);
      store.observe(key, emptyTimeline, false);
      const id = store.add(key, "continue", now, scope, true);
      store.delivered(id);
      backstop.watch(key, "idle", () => Promise.resolve(null));
      // The idle backstop's turn comes (5 s) and again (10 s) before Chat's retry finds the file.
      await time0.advance(now + 5_000);
      await time0.advance(now + 10_000);
      expect(store.forPane(key).map((bubble) => bubble.state), String(time)).toEqual(["sent"]);
      store.observe(key, tl(user("actual", "continue", time), reply("a1", "ok")));
      expect(store.forPane(key), String(time)).toEqual([]);
      expect(store.takeNotSent(id)).toBeNull();
      await time0.advance(now + 15_000);
      expect(store.forPane(key)).toEqual([]);
    }
  });

  it("F3, after the ten minutes: Not sent then, and the transcript that comes later still settles it", async () => {
    const store = new PendingMessages();
    const time0 = clock(now);
    const backstop = new PendingBackstop(store, time0.schedule, time0.cancel, time0.now);
    store.reconcile(new Map([[key, scope]]), () => true);
    store.observe(key, emptyTimeline, false);
    store.delivered(store.add(key, "continue", now, scope, true));
    backstop.watch(key, "idle", () => Promise.resolve(null));
    for (let t = now + 5_000; t <= now + notSentWhileWorkingMs + 5_000; t += 5_000) await time0.advance(t);
    expect(store.forPane(key).map((bubble) => bubble.state)).toEqual(["notSent"]);
    store.observe(key, tl(user("actual", "continue", null)));
    expect(store.forPane(key)).toEqual([]);
  });

  it("F4: no state that never ends: once such a send settles no bubble is left, and later sends settle as usual", () => {
    const store = new PendingMessages();
    store.reconcile(new Map([[key, scope]]), () => true);
    store.observe(key, emptyTimeline, false);
    store.delivered(store.add(key, "continue", now, scope, true));
    const actual = user("actual", "continue", now / 1_000 - 1);
    store.observe(key, tl(actual));
    expect(store.forPane(key)).toEqual([]);
    store.delivered(store.add(key, "next task", now + 20_000, scope));
    store.observe(key, tl(actual, user("next", "next task", now / 1_000 + 21)));
    expect(store.forPane(key)).toEqual([]);
    expect(store.markNotSent(key, null, now + 60_000)).toBe(false);
    expect(Object.keys(current)).not.toContain("unconfirmedLabel");
  });

  it.skipIf(!hasMain)("F5: two live Chats in a split, an update for B, then a send in A: exactly main's result", async () => {
    const main = await mainPending();
    const run = (module: Pending): unknown[] => {
      const store = new module.PendingMessages();
      store.reconcile(
        new Map([
          [key, scope],
          [other, scope],
        ]),
        () => true,
      );
      const shown = tl(user("history", "continue", now / 1_000 - 60));
      store.observe(key, shown);
      store.observe(other, emptyTimeline);
      // A is live on screen: its sender never says not found.
      const id = store.add(key, "continue", now, scope, false);
      store.delivered(id);
      store.observe(key, shown);
      const marked = store.markNotSent(key);
      return [marked, store.forPane(key).map((bubble) => [bubble.state, module.pendingLabel(bubble, false, now + 10_000)]), store.takeNotSent(id)];
    };
    expect(run(current)).toEqual(run(main));
    expect(run(current)).toEqual([true, [["notSent", notSentLabel]], "continue"]);
  });
});

// MARK: - parity with main for every send that is not made into a transcript Chat said was not found

type Store = InstanceType<Pending["PendingMessages"]>;
type Step = (store: Store, module: Pending) => unknown;

/** What a store shows of the pane after a step: each bubble's state, labels, place, and the hidden and dropped. */
function look(store: Store, module: Pending, timeline: ChatTimeline): unknown {
  const bubbles = store.forPane(key);
  const places = module.placePending(bubbles, timeline);
  return {
    bubbles: bubbles.map((bubble) => [bubble.text, bubble.state, module.pendingLabel(bubble, false, now + 30_000), module.pendingLabel(bubble, true, now + 30_000)]),
    placed: [...places.placed].map(([at, list]) => [at, list.map((bubble) => bubble.text)]),
    waiting: places.waiting.map((bubble) => bubble.text),
    hidden: [...store.takenBackFor(key)],
    dropped: store.droppedFor(key),
  };
}

/** Runs `steps` on a fresh store of `module`, recording each step's answer and the look after it. */
function script(module: Pending, steps: readonly [Step, ChatTimeline][]): unknown[] {
  const store = new module.PendingMessages();
  return steps.map(([step, timeline]) => {
    const answer = step(store, module);
    return [answer === undefined ? null : answer, look(store, module, timeline)];
  });
}

const history = tl(user("h1", "continue", now / 1_000 - 600), reply("a-h1", "ok"));
const later = (...items: ChatItem[]): ChatTimeline => ({ ...history, turns: [...history.turns, ...tl(...items).turns.map((turn, index) => ({ ...turn, id: `n${index}` }))] });
const at = (second: number): number => now / 1_000 + second;

/** The pane's state at the send, set up by these steps (none says "not found"). */
const states: Record<string, readonly [Step, ChatTimeline][]> = {
  followed: [
    [(s) => s.reconcile(new Map([[key, scope]]), () => true), emptyTimeline],
    [(s) => s.observe(key, history), history],
  ],
  loading: [
    [(s) => s.reconcile(new Map([[key, scope]]), () => true), emptyTimeline],
    [(s) => s.observe(key, emptyTimeline, false), emptyTimeline],
  ],
  "not following": [
    [(s) => s.reconcile(new Map([[key, scope]]), () => true), emptyTimeline],
    [(s) => s.observe(key, history), history],
    [(s) => s.unfollow(key), history],
  ],
  "another pane following": [
    [
      (s) =>
        s.reconcile(
          new Map([
            [key, scope],
            [other, scope],
          ]),
          () => true,
        ),
      emptyTimeline,
    ],
    [(s) => s.observe(key, history), history],
    [(s) => s.observe(other, tl(user("o1", "elsewhere", at(-5)))), history],
  ],
  "tab closed": [
    [(s) => s.reconcile(new Map([[key, scope]]), () => true), emptyTimeline],
    [(s) => s.observe(key, history), history],
    [(s) => s.unfollow(key), history],
    [(s) => s.observe(key, emptyTimeline, false), history],
  ],
};

/** What happens after the send (each starts with "continue" sent at `now`, Herdr taking it). */
const sequences: Record<string, readonly [Step, ChatTimeline][]> = {
  "it lands in the next live timeline": [
    [(s) => s.observe(key, later(user("u1", "continue", at(1)), reply("a1", "ok"))), later(user("u1", "continue", at(1)))],
    [(s) => s.observe(key, later(user("u1", "continue", at(1)), reply("a1", "ok"), user("u2", "continue", at(9)))), later(user("u1", "continue", at(1)), user("u2", "continue", at(9)))],
    [(s) => s.markNotSent(key, null, now + 20_000), history],
  ],
  "it lands a second behind, with no time, then never": [
    [(s) => s.observe(key, later(user("u1", "continue", at(-1)))), later(user("u1", "continue", at(-1)))],
    [(s) => s.observe(key, later(user("u1", "continue", at(-1)), user("u2", "continue", null))), later(user("u1", "continue", at(-1)), user("u2", "continue", null))],
    [(s) => s.markNotSent(key, null, now + 20_000), history],
  ],
  "it never arrives: the backstop, then the tap": [
    [(s) => s.observe(key, later(reply("a1", "still working"))), later(reply("a1", "still working"))],
    [(s) => s.markNotSent(key, now - 1, now + 20_000), history],
    [(s) => s.markNotSent(key, null, now + 20_000), history],
    [(s) => s.takeNotSent(s.forPane(key)[0]?.id ?? ""), history],
  ],
  "two identical sends, then Esc's take-back": [
    [(s) => s.delivered(s.add(key, "continue", now + 1_000, scope, false)), history],
    [(s) => s.observe(key, later(user("u1", "continue", at(2)))), later(user("u1", "continue", at(2)))],
    [(s) => s.observe(key, later(user("u1", "continue", at(2)), user("u2", "continue", at(3)))), later(user("u1", "continue", at(2)), user("u2", "continue", at(3)))],
    [(s) => s.takeBack(key, "continue"), history],
  ],
  "the session changes": [
    [(s) => s.reconcile(new Map([[key, { terminalID: "term", session: "next" }]]), () => true), history],
    [(s) => s.observe(key, tl(user("u1", "continue", at(1)))), tl(user("u1", "continue", at(1)))],
  ],
  "a loading update, then history from a clock ahead": [
    [(s) => s.observe(key, emptyTimeline, false), emptyTimeline],
    [(s) => s.observe(key, later(user("ahead", "continue", at(240)))), later(user("ahead", "continue", at(240)))],
    [(s) => s.takeBack(key, "continue"), history],
  ],
};

describe.skipIf(!hasMain)("parity with main's pending.ts for every send not made into a transcript Chat said was not found", () => {
  for (const [state, setup] of Object.entries(states)) {
    for (const [name, after] of Object.entries(sequences)) {
      it(`${state}: ${name}`, async () => {
        const main = await mainPending();
        const steps: [Step, ChatTimeline][] = [
          ...setup,
          // The sender says false (the pane's Chat is not "not found"); main's add takes no such argument.
          [(s) => s.delivered(s.add(key, "continue", now, scope, false)), history],
          ...after,
        ];
        expect(script(current, steps)).toEqual(script(main, steps));
      });
    }
  }

  it("a followed send keeps main's path even if a sender said not found (the flag is ignored while Chat follows the pane)", async () => {
    const main = await mainPending();
    const steps: [Step, ChatTimeline][] = [
      ...states.followed!,
      [(s) => s.delivered(s.add(key, "continue", now, scope, true)), history],
      [(s) => s.observe(key, later(user("u1", "continue", at(-1)))), later(user("u1", "continue", at(-1)))],
      [(s) => s.markNotSent(key, null, now + 20_000), history],
    ];
    expect(script(current, steps)).toEqual(script(main, steps));
  });

  it("the backstop with no not-found send runs as main's: idle 5 s, then Not sent", async () => {
    const main = await mainPending();
    const run = async (module: Pending): Promise<unknown[]> => {
      const store = new module.PendingMessages();
      const time0 = clock(now);
      const backstop = new module.PendingBackstop(store, time0.schedule, time0.cancel, time0.now);
      store.reconcile(new Map([[key, scope]]), () => true);
      store.observe(key, emptyTimeline, false);
      store.delivered(store.add(key, "continue", now, scope, false));
      backstop.watch(key, "idle", () => Promise.resolve(null));
      const seen: unknown[] = [];
      for (const t of [now + 4_000, now + 5_000, now + 10_000]) {
        await time0.advance(t);
        seen.push(store.forPane(key).map((bubble) => bubble.state));
      }
      return seen;
    };
    expect(await run(current)).toEqual(await run(main));
    expect(await run(current)).toEqual([["sent"], ["notSent"], ["notSent"]]);
  });
});

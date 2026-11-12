// Esc and the queued send, the stopped row (as T3 Code's stopped row does): a
// turn that ends with "[Request interrupted by user]" ends with one quiet row, "You stopped after 12s" by the turn's length ("Stopped" when it is
// not known), as soon as the transcript has the interrupt line, also after a
// reply already complete on screen (22:35:08). A message cancelled before an
// answer gets no row (it goes back to the box).

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { stoppedText, turnFooter, turnStopped, type ChatTurn } from "../src/shared/chat/model";
import { Turn } from "../src/renderer/chat/ChatView";
import { timelineOf } from "./support/chat-lines";
import { beforeGlued, gluedLines } from "./support/esc-queue-lines";

const noop = (): void => undefined;

describe("the stopped row", () => {
  it("ends the turn interrupted at 22:35:08 (its reply already complete) with 'You stopped after 3s', no Worked for", () => {
    const first = timelineOf(gluedLines).timeline.turns[0]!;
    expect(turnStopped(first)).toBe(true);
    const last = first.items.at(-1)!;
    expect(last.type === "notice" ? stoppedText(first, last.value) : null).toBe("You stopped after 3s");
    expect(turnFooter(first)).toBeNull();
    const html = renderToStaticMarkup(createElement(Turn, { turn: first, onCopy: noop, onMenu: noop }));
    expect(html).toContain("You stopped after 3s");
    expect(html).not.toContain("Worked for");
  });

  it("shows as soon as the interrupt line is read", () => {
    const turns = timelineOf(beforeGlued.slice(0, 3)).timeline.turns;
    expect(turns.length).toBe(1);
    expect(renderToStaticMarkup(createElement(Turn, { turn: turns[0]!, onCopy: noop, onMenu: noop }))).toContain("You stopped after 3s");
  });

  it("reads 'Stopped' when the turn's length is not known", () => {
    expect(stoppedText({ startedAt: null }, { time: 100 })).toBe("Stopped");
    expect(stoppedText({ startedAt: 100 }, { time: null })).toBe("Stopped");
    expect(stoppedText({ startedAt: 100 }, { time: 112 })).toBe("You stopped after 12s");
  });

  it("gives a message cancelled before any answer no row", () => {
    const turns: readonly ChatTurn[] = timelineOf(gluedLines).timeline.turns;
    const notices = turns.flatMap((turn) => turn.items.filter((item) => item.type === "notice"));
    expect(notices.length).toBe(1);
  });
});

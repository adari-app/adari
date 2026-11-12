// A port of HerdrKit's ChatPastedContentTests.swift:
// Claude Code keeps pasted text inside `<pasted_content id="…">…</pasted_content>`;
// Chat shows the text inside, no tags.

import { describe, expect, it } from "vitest";

import { unwrapPasted } from "../src/shared/chat/claude-parser";
import { attachment, type ChatUserMessage } from "../src/shared/chat/model";
import { queued, timelineOf, upload, user } from "./support/chat-lines";
import { tonight, tonightText } from "./support/pasted-tonight";

const messages = (lines: readonly string[]): ChatUserMessage[] =>
  timelineOf(lines).timeline.turns.flatMap((turn) => turn.items.flatMap((item) => (item.type === "user" ? [item.value] : [])));

const texts = (lines: readonly string[]): string[] => messages(lines).map((message) => message.text);

describe("pasted content", () => {
  it("shows one pasted block as its text", () => {
    const text = '<pasted_content id="713e">\nThe Chat view drops what I send while you work.\nLine two.\n</pasted_content>';
    expect(texts([user(text, "u1", 0)])).toEqual(["The Chat view drops what I send while you work.\nLine two."]);
  });

  it("unwraps several blocks with typed text around them", () => {
    const text =
      'Look at these two:\n<pasted_content id="a1">first paste</pasted_content>\nand\n' +
      '<pasted_content id="b2" lines="2">\nsecond\npaste\n</pasted_content> thanks';
    expect(texts([user(text, "u1", 0)])).toEqual(["Look at these two:\nfirst paste\nand\nsecond\npaste thanks"]);
  });

  it("unwraps blocks in a content array, CRLF too, with an upload inside", () => {
    const found = messages([
      user(
        [
          { type: "text", text: `<pasted_content id="c3">\r\nfix the header ${upload}\r\n</pasted_content>` },
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "/9j/" } },
        ],
        "u1",
        0,
      ),
    ]);
    expect(found.map((message) => message.text)).toEqual(["fix the header"]);
    expect(found[0]?.attachments).toEqual([attachment(null, "image/jpeg"), attachment(upload)]);
  });

  it("unwraps a queued paste the same way", () => {
    expect(texts([user("start", "u1", 0), queued('<pasted_content id="9f">\nalso the phone\n</pasted_content>', "q1", "s1", 4)])).toEqual([
      "start",
      "also the phone",
    ]);
  });

  it("leaves an unclosed or other tag as typed", () => {
    expect(unwrapPasted('<pasted_content id="1">never closed')).toBe('<pasted_content id="1">never closed');
    expect(unwrapPasted("<pasted_contents>x</pasted_contents>")).toBe("<pasted_contents>x</pasted_contents>");
    expect(unwrapPasted("the tag is `<pasted_content>`")).toBe("the tag is `<pasted_content>`");
    expect(unwrapPasted('<pasted_content id="1">a</pasted_content><pasted_content id="2">b')).toBe('a<pasted_content id="2">b');
  });

  it("unwraps nested pastes whole", () => {
    expect(unwrapPasted("<pasted_content>A<pasted_content>B</pasted_content>C</pasted_content>")).toBe("ABC");
    expect(unwrapPasted('<pasted_content id="o">\nA\n<pasted_content id="i">\nB\n</pasted_content>\nC\n</pasted_content>')).toBe("A\nB\nC");
    expect(unwrapPasted("<pasted_content>1<pasted_content>2<pasted_content>3</pasted_content>4</pasted_content>5</pasted_content>")).toBe("12345");
    const line = '<pasted_content id="a">look: <pasted_content id="b">inner</pasted_content> done</pasted_content>';
    expect(texts([user(line, "u1", 0)])).toEqual(["look: inner done"]);
  });

  it("unwraps nested and adjacent pastes", () => {
    expect(
      unwrapPasted(
        "<pasted_content>A<pasted_content>B</pasted_content></pasted_content><pasted_content>C</pasted_content> and " +
          '<pasted_content id="d">D</pasted_content>',
      ),
    ).toBe("ABC and D");
    expect(unwrapPasted("<pasted_content><pasted_content>A</pasted_content><pasted_content>B</pasted_content></pasted_content>")).toBe("AB");
  });

  it("leaves an unclosed outer paste as typed", () => {
    expect(unwrapPasted("<pasted_content>A<pasted_content>B</pasted_content>C")).toBe("<pasted_content>ABC");
    expect(unwrapPasted("<pasted_content>A</pasted_content>B</pasted_content>")).toBe("AB</pasted_content>");
  });

  it("keeps a paste starting with a reminder tag as the user's message", () => {
    const text = '<pasted_content id="d4"><system-reminder> is what the agent sees</pasted_content>';
    expect(texts([user(text, "u1", 0)])).toEqual(["<system-reminder> is what the agent sees"]);
  });
});

// A port of ChatPastedIDCloseTests: Claude Code 2.1.316
// writes the close with the id (`</pasted_content id="713e">`).

describe("a pasted_content close with its id", () => {
  it("shows the recorded shape once, without its tags", () => {
    expect(unwrapPasted(tonight)).toBe(tonightText);
    expect(texts([user(tonight, "u1", 0)])).toEqual([tonightText]);
    expect(unwrapPasted(tonight.replace(/\n/g, "\r\n"))).toBe(tonightText.replace(/\n/g, "\r\n"));
  });

  it("still closes with the bare close, by the nearest open", () => {
    expect(unwrapPasted('<pasted_content id="713e">\nA\n</pasted_content>')).toBe("A");
    expect(unwrapPasted("<pasted_content>A</pasted_content >")).toBe("A");
    expect(unwrapPasted('<pasted_content id="a">A</pasted_content\n>')).toBe("A");
  });

  it("unwraps nested blocks with ids", () => {
    expect(
      unwrapPasted('<pasted_content id="o">\nA\n<pasted_content id="i">\nB\n</pasted_content id="i">\nC\n</pasted_content id="o">'),
    ).toBe("A\nB\nC");
    expect(unwrapPasted('<pasted_content id="o">A<pasted_content id="i">B</pasted_content>C</pasted_content id="o">')).toBe("ABC");
    expect(unwrapPasted('<pasted_content id="x">A<pasted_content id="x">B</pasted_content id="x">C</pasted_content id="x">')).toBe(
      "ABC",
    );
  });

  it("unwraps two blocks with different ids", () => {
    expect(
      unwrapPasted(
        '<pasted_content id="a1">\nfirst\n</pasted_content id="a1">\n<pasted_content id=\'b2\' lines="2">\nsecond\npaste\n</pasted_content id=\'b2\'>',
      ),
    ).toBe("first\nsecond\npaste");
  });

  it("leaves mismatched ids as typed", () => {
    expect(unwrapPasted('<pasted_content id="a">x</pasted_content id="b">')).toBe('<pasted_content id="a">x</pasted_content id="b">');
    expect(unwrapPasted('x</pasted_content id="b">')).toBe('x</pasted_content id="b">');
    expect(unwrapPasted('<pasted_content id="a">x</pasted_content id="b">y</pasted_content id="a">')).toBe('x</pasted_content id="b">y');
    expect(unwrapPasted('<pasted_content id="a">x</pasted_contents id="a">')).toBe('<pasted_content id="a">x</pasted_contents id="a">');
  });

  it("keeps typed text before and after", () => {
    expect(unwrapPasted(`Look at this:\n${tonight}\nthanks`)).toBe(`Look at this:\n${tonightText}\nthanks`);
    expect(unwrapPasted('before <pasted_content id="p">mid</pasted_content id="p"> after')).toBe("before mid after");
  });
});

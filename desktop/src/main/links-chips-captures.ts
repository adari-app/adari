// Captures 163-168 (development builds only, through
// dev-modes.ts): a chat reply's link under the mouse (sundial on the Mac
// mini), a URL in a terminal with ⌘ held over it (build-box's build shell), the
// message box with the Model chip reading Fable 5.2 from Claude Code's new
// /model line (written into the demo transcript) at 1440x900 and at the
// window's minimum size, and the box with the old parse's long label as a test
// string (put on the chip by a page script) at the minimum size and at
// 1440x900, Send inside the box. Each box
// capture measures Send's, the paperclip's and the ring's right edges against
// the box's. Nothing is clicked: no link is opened.

import type { CaptureStep } from "./capture";

/** What Claude Code now prints for /model (the model's name in quotes, then the rest). */
export const fableModelLine = "Set model to 'Fable 5.2' and saved as your default for new sessions";
/** What the old parse put on the chip from that line (everything after "Set model to "): the test string. */
export const oldParseLabel = "'Fable 5.2' and saved as your default for new sessions";

/** The box, its row and the three buttons on its right, measured: is each inside the box's right edge? */
const boxMeasure = `(() => {
  const box = document.querySelector(".main .cmp");
  const bar = document.querySelector(".main .cmp-bar");
  const rect = (element) => {
    if (element === null || element === undefined) return null;
    const r = element.getBoundingClientRect();
    return { left: Math.round(r.left * 10) / 10, right: Math.round(r.right * 10) / 10, width: Math.round(r.width * 10) / 10 };
  };
  const boxRect = rect(box);
  const inside = (r) => (r === null || boxRect === null ? null : r.right <= boxRect.right + 0.5 && r.left >= boxRect.left - 0.5);
  const send = rect(document.querySelector(".main .cmp-bar .send"));
  const attach = rect(document.querySelector('.main .cmp-bar [aria-label="Attach files"]'));
  const ring = rect(document.querySelector(".main .cmp-bar .ctx-ring-w, .main .cmp-bar .ctx-ring"));
  const model = document.querySelector(".main .cmp-bar .chip.pick.model");
  const modelText = model?.querySelector(".ct");
  return {
    window: { width: window.innerWidth, height: window.innerHeight },
    box: boxRect,
    row: rect(bar),
    rowScrollsSideways: bar === null ? null : bar.scrollWidth > bar.clientWidth + 1,
    rowWraps: bar === null ? null : getComputedStyle(bar).flexWrap !== "nowrap",
    send,
    sendInside: inside(send),
    sendRightGap: send === null || boxRect === null ? null : Math.round((boxRect.right - send.right) * 10) / 10,
    attach,
    attachInside: inside(attach),
    ring,
    ringInside: inside(ring),
    chips: [...document.querySelectorAll(".main .cmp-bar .chip")].map((chip) => ({
      className: chip.className,
      text: (chip.querySelector(".ct")?.textContent ?? "").trim(),
      width: Math.round(chip.getBoundingClientRect().width * 10) / 10,
    })),
    modelChip: model === null
      ? null
      : {
          text: modelText?.textContent ?? null,
          title: model.querySelector(".pick-b")?.getAttribute("title") ?? null,
          ellipsis: modelText === null || modelText === undefined ? null : modelText.scrollWidth > modelText.clientWidth,
          width: Math.round(model.getBoundingClientRect().width * 10) / 10,
        },
  };
})()`;

/** The old parse's label on the Model chip (text and title), kept there while React draws the row again. */
const longLabel = `(() => {
  const label = ${JSON.stringify(oldParseLabel)};
  const apply = () => {
    const chip = document.querySelector(".main .cmp-bar .chip.pick.model");
    const text = chip?.querySelector(".ct");
    // React's own text node, so a later change of the real label still lands.
    const node = text?.firstChild;
    if (node === null || node === undefined) return false;
    if (node.nodeValue !== label) node.nodeValue = label;
    const button = chip.querySelector(".pick-b");
    if (button !== null && button.getAttribute("title") !== "Model: " + label) button.setAttribute("title", "Model: " + label);
    return true;
  };
  window.__lcLabel?.disconnect();
  const bar = document.querySelector(".main .cmp-bar");
  if (bar !== null) {
    window.__lcLabel = new MutationObserver(apply);
    window.__lcLabel.observe(bar, { subtree: true, childList: true, characterData: true, attributes: true });
  }
  return apply();
})()`;

/** The chat's newest link: scrolled to the end, its middle. */
const linkPoint = `(() => {
  const scroller = document.querySelector(".main .chat-scroll");
  if (scroller !== null) scroller.scrollTop = scroller.scrollHeight;
  const links = [...document.querySelectorAll(".main .chat .md-link")];
  const link = links.at(-1);
  if (link === undefined) return [];
  link.scrollIntoView({ block: "center" });
  const r = link.getBoundingClientRect();
  return [{ x: r.left + Math.min(r.width / 2, 40), y: r.top + r.height / 2 }];
})()`;

const linkMeasure = `(() => {
  const links = [...document.querySelectorAll(".main .chat .md-link")];
  return {
    links: links.map((link) => {
      const style = getComputedStyle(link);
      return {
        tag: link.tagName.toLowerCase(),
        text: (link.textContent ?? "").trim(),
        href: link.getAttribute("href"),
        title: link.getAttribute("title"),
        draggable: link.getAttribute("draggable"),
        focusable: link.tabIndex >= 0,
        hovered: link.matches(":hover"),
        cursor: style.cursor,
        decoration: style.textDecorationLine + " " + style.textDecorationStyle,
        color: style.color,
      };
    }),
    notLinks: document.querySelectorAll(".main .chat .md-link-off").length,
  };
})()`;

/** What build-box's build shell shows for capture 164: a script's line with a URL in it (an invented address). */
export const terminalUrlScreen = [
  "root@build-box:~/herdr# ./scripts/publish-blog.sh slot-2",
  "Uploading 3 files... done.",
  "Blog slot 2 is live: https://example.invalid/blog/slot-2 (published).",
  "root@build-box:~/herdr# ",
].join("\n");

const shellTile = '[data-tile="w2:p3"]';

/** Points along the URL's part of the shell's canvas, row by row, for the mouse to find the link. */
const terminalPoints = `(() => {
  const canvas = document.querySelector('${shellTile} .term-host canvas');
  if (canvas === null) return [];
  const r = canvas.getBoundingClientRect();
  const points = [];
  for (let y = r.top + 3; y < Math.min(r.bottom, r.top + 200); y += 3) points.push({ x: r.left + 250, y });
  return points;
})()`;

const terminalOverLink = `(() => document.querySelector('${shellTile} .term-host')?.style.cursor === "pointer")()`;

const terminalMeasure = `(() => {
  const host = document.querySelector('${shellTile} .term-host');
  const canvas = host?.querySelector("canvas");
  const r = canvas?.getBoundingClientRect();
  return {
    cursor: host?.style.cursor ?? null,
    overLink: host?.style.cursor === "pointer",
    canvas: r === undefined ? null : { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) },
  };
})()`;

export function linksChipsCaptureSteps(
  ids: { macMini: string; buildBox: string },
  size: (size: { width: number; height: number } | null) => Promise<void>,
  printModelLine: (hostId: string, paneId: string, stdout: string) => Promise<boolean>,
  /** The screen a demo shell's terminal shows when it opens (null: put back what it had). */
  showShellScreen: (hostId: string, paneId: string, screen: string | null) => Promise<void>,
): CaptureStep[] {
  const sundial = [
    { type: "settings", open: false },
    { type: "set-mode", mode: "projects" },
    { type: "set-host-folded", hostId: ids.macMini, folded: false },
    { type: "select-pane", hostId: ids.macMini, paneId: "w6:p1" },
    { type: "set-tab", tab: "chat" },
  ] as const;
  return [
    {
      name: "163-links-chat-link-hover",
      what: "The sundial reply's link (Details are in the pull request) under the mouse at 1440x900: a real link in the link colour, underlined on hover, the address as its title; a click or Return opens it in the default browser (shown by test/links-chips-chat-links.test.ts, never a real browser here)",
      before: () => size({ width: 1440, height: 900 }),
      commands: [...sundial],
      settleMs: 700,
      pointer: { points: linkPoint, until: `(() => document.querySelector(".main .chat .md-link:hover") !== null)()` },
      measure: linkMeasure,
    },
    {
      name: "164-links-terminal-url-cmd",
      what: "build-box's build shell in Terminal (its screen a script's line with an invented URL, shown before its terminal opens), the mouse over the URL with Cmd held: ghostty-web underlines the link and shows the hand (as it does by default, over a link, Cmd or not); Cmd-click would open it in the default browser (test/links-chips-terminal-links.test.ts), a plain click selects as before",
      before: () => showShellScreen(ids.buildBox, "w2:p3", terminalUrlScreen),
      commands: [
        { type: "settings", open: false },
        { type: "set-mode", mode: "projects" },
        { type: "set-host-folded", hostId: ids.buildBox, folded: false },
        { type: "select-pane", hostId: ids.buildBox, paneId: "w2:p3" },
        { type: "set-tab", tab: "terminal" },
      ],
      settleMs: 600,
      pointer: { points: terminalPoints, modifiers: ["meta"], until: terminalOverLink },
      measure: terminalMeasure,
      afterCapture: () => showShellScreen(ids.buildBox, "w2:p3", null),
    },
    {
      name: "165-links-fable-chip",
      what: `Sundial after Claude Code printed "${fableModelLine}" (written into its demo transcript): the Model chip reads Fable 5.2, Send inside the box, at 1440x900`,
      before: async () => {
        await printModelLine(ids.macMini, "w6:p1", fableModelLine);
      },
      commands: [...sundial],
      settleMs: 2_500,
      measure: boxMeasure,
    },
    {
      name: "166-links-fable-chip-min",
      what: "The Fable 5.2 chip (the real parse) at the window's minimum size (840x620), Send inside the box",
      before: () => size({ width: 840, height: 620 }),
      commands: [...sundial],
      settleMs: 1_200,
      measure: boxMeasure,
    },
    {
      name: "167-links-long-label-min",
      what: `The old parse's label "${oldParseLabel}" put on the Model chip as a test string, at the window's minimum size (840x620): the Model chip shrinks first with an ellipsis (its full text its tooltip), the row neither wraps nor scrolls sideways, Send, the paperclip and the ring inside the box`,
      commands: [...sundial],
      page: [longLabel],
      settleMs: 700,
      measure: boxMeasure,
    },
    {
      name: "168-links-long-label-wide",
      what: "The same long label at 1440x900: the chip shrinks only as far as the row needs, Send inside the box",
      before: () => size({ width: 1440, height: 900 }),
      commands: [...sundial],
      page: [longLabel],
      settleMs: 700,
      measure: boxMeasure,
      afterCapture: async () => {
        await size(null);
      },
    },
  ];
}

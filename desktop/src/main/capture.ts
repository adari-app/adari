// Driving the page from the main process: a command goes out on
// IPC.appCommand, and the page answers with its id once the change is painted
// (two animation frames later). The capture flag uses this to show each state
// before it takes the window's own pixels.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { BrowserWindow } from "electron";

import type { AppCommands, CommandBody } from "./app-commands";
import { demoShotBase64 } from "./demo/demo-chat";
import { demoGitCommit, demoGitFolders } from "./demo/demo-git";
import { demoSplitTab } from "./demo/demo-hosts";
import { demoTallBashScreen, demoTallCutCall, demoTallCutScreen, demoTallEditScreen, type DemoRunningCall } from "./demo/demo-tall";

// The command channel itself lives in app-commands.ts: the shipped app answers the page's commands
// without this file, which holds the demo's captures and comes only into development builds.
export { AppCommands, type CommandBody } from "./app-commands";

/** One capture: the commands that set the window up, how long to let it settle, the file name. */
export interface CaptureStep {
  readonly name: string;
  readonly what: string;
  readonly commands: readonly CommandBody[];
  readonly settleMs: number;
  /** Commands sent `afterMs` after the ones above (a terminal's bytes in before a selection is made in it). */
  readonly after?: { readonly afterMs: number; readonly commands: readonly CommandBody[] };
  /** Scripts run in the page after the commands (the chat scrolled, a draft typed as the user's keys would). */
  readonly page?: readonly string[];
  /** A script whose answer is kept with the capture in captures.json (what the picture shows, measured). */
  readonly measure?: string;
  /** Run in main before the commands (for example, a machine added whose new host key is asked about). */
  readonly before?: () => Promise<void>;
  /** Run in main after the picture is taken (for example, This Mac taken out of the list again, so the captures after it are as before). */
  readonly afterCapture?: () => Promise<void>;
  /**
   * The real mouse on the sidebar's right edge (webContents.sendInputEvent, as a person's hand):
   * a drag by `dragBy` points (right is positive), or a double-click. Sent after the commands, before the page scripts.
   */
  readonly edge?: { readonly dragBy: number } | { readonly doubleClick: true };
  /**
   * The real mouse moved over the page (webContents.sendInputEvent, as a person's hand), after the page
   * scripts: to each point `points` (a page script) gives, `modifiers` held, until `until` (a page script) answers
   * true or the points run out; it stays where it stopped for the picture.
   */
  readonly pointer?: { readonly points: string; readonly modifiers?: readonly ("meta" | "control" | "shift" | "alt")[]; readonly until?: string };
  /** Only this element (a CSS selector) and `pad` points around it, not the whole window. */
  readonly crop?: { readonly selector: string; readonly pad: number };
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The mouse on the sidebar's right edge, half way down: pressed, moved in 12 steps and let go
 * (a drag), or clicked twice (a double-click). Where the edge is comes from the page (`.sb`'s right side).
 */
async function onSidebarEdge(window: BrowserWindow, edge: NonNullable<CaptureStep["edge"]>): Promise<void> {
  const contents = window.webContents;
  const at = (await contents.executeJavaScript(
    `(() => { const r = document.querySelector(".sb")?.getBoundingClientRect(); return r === undefined ? null : { x: Math.round(r.right) - 1, y: Math.round(r.top + r.height / 2) }; })()`,
    true,
  )) as { x: number; y: number } | null;
  if (at === null) return;
  const { x, y } = at;
  contents.sendInputEvent({ type: "mouseMove", x, y });
  await wait(60);
  if ("doubleClick" in edge) {
    for (const clickCount of [1, 2]) {
      contents.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount });
      contents.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount });
      await wait(40);
    }
    return;
  }
  contents.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
  const steps = 12;
  for (let step = 1; step <= steps; step += 1) {
    await wait(24);
    contents.sendInputEvent({ type: "mouseMove", x: x + Math.round((edge.dragBy * step) / steps), y, button: "left", modifiers: ["leftbuttondown"] });
  }
  await wait(60);
  contents.sendInputEvent({ type: "mouseUp", x: x + edge.dragBy, y, button: "left", clickCount: 1 });
}

/**
 * The demo captures (the capture flag): the empty state with both machines and
 * the Needs you group, a working pane's terminal streaming, a pane that needs
 * you showing its dialog, the Priority view, and Chat; then the split tabs:
 * two panes side by side, four, the split menu refused at
 * four, a zoomed pane, the split menu and New agent's Where.
 */
export function demoCaptureSteps(ids: { macMini: string; buildBox: string }): CaptureStep[] {
  return [
    {
      name: "01-empty-state",
      what: "Sidebar with two machines (Mac mini folded to its header, build-box open) under the Needs you group; nothing selected (the empty state)",
      commands: [
        { type: "set-mode", mode: "projects" },
        { type: "clear-selection" },
        { type: "set-host-folded", hostId: ids.macMini, folded: true },
        { type: "set-host-folded", hostId: ids.buildBox, folded: false },
      ],
      settleMs: 800,
    },
    {
      name: "02-terminal-working",
      what: "Terminal filling its tile edge to edge (no column cap, no centring, no box; Ghostty's 2-point padding): a working pane (Mac mini, aurora-web-mac), the left tile of its tab's two (workers 1), playing the heavy-excerpt recording; the design pane's tile beside it",
      commands: [
        { type: "set-host-folded", hostId: ids.macMini, folded: false },
        // An agent pane opens in Chat: Terminal is picked on it once it is open.
        { type: "select-pane", hostId: ids.macMini, paneId: "w7:p1G" },
        { type: "set-tab", tab: "terminal" },
      ],
      settleMs: 3_000,
    },
    {
      name: "03-needs-you",
      what: "A pane that needs you (build-box, beacon): Claude Code's Bash dialog in the terminal",
      commands: [
        { type: "select-pane", hostId: ids.buildBox, paneId: "w1:p1" },
        { type: "set-tab", tab: "terminal" },
      ],
      settleMs: 1_500,
    },
    {
      name: "04-priority",
      what: "Priority view merged across both machines",
      commands: [{ type: "set-mode", mode: "priority" }],
      settleMs: 800,
    },
    {
      name: "05-chat",
      what: "Chat for a working pane (Mac mini, aurora-web-mac, demo transcript) in its tile, the left of its tab's two: a finished turn with its folded tool group, a code block and its footer, a progress row between tool groups, a queued message, and the running turn",
      commands: [
        { type: "set-mode", mode: "projects" },
        { type: "select-pane", hostId: ids.macMini, paneId: "w7:p1G" },
        { type: "set-tab", tab: "chat" },
      ],
      settleMs: 1_500,
    },
    {
      name: "06-terminal-box",
      what: "The same tile's terminal with the message box brought over it (the header's box button, or ⇧⌘T)",
      commands: [
        { type: "set-tab", tab: "terminal" },
        { type: "set-box", shown: true },
      ],
      settleMs: 2_500,
    },
    {
      name: "07-terminal-box-hidden",
      what: "The box hidden again (⇧⌘T, the button or Escape): the terminal fills its tile and has the keyboard back",
      commands: [{ type: "set-box", shown: false }],
      settleMs: 1_500,
    },
    {
      name: "08-open-in-ghostty",
      what: "A sidebar row's menu with Open in Ghostty (shown only where Ghostty is installed), greyed with its reason: a demo machine has no SSH address (the pane's tile behind it); then Rename… and Close pane. Nothing is chosen and nothing is started",
      commands: [
        { type: "set-box", shown: false },
        { type: "open-row-menu", hostId: ids.macMini, paneId: "w7:p1G" },
      ],
      settleMs: 1_500,
    },
    {
      name: "09-chat-notice",
      what: "A transcript notice in place (Mac mini, design pane, demo transcript, the right tile of its tab's two): the Interrupted line of a request the user stopped stays in the chat's flow between its turn and the next, not as a toast",
      commands: [
        { type: "select-pane", hostId: ids.macMini, paneId: "w7:p1H" },
        { type: "set-tab", tab: "chat" },
      ],
      settleMs: 1_500,
    },
    {
      name: "10-composer-attachments",
      what: "The message box with attachments as chips: a screenshot as its thumbnail and a build log by name, each with its x; the + for the picker at the left of the bar (Mac mini, design pane)",
      commands: [
        {
          type: "attach-files",
          files: [
            { name: "Screenshot.png", type: "image/png", base64: demoShotBase64 },
            { name: "build.log", type: "text/plain", base64: btoa("Build succeeded\n12 tests passed\n") },
          ],
        },
      ],
      settleMs: 1_200,
    },
    {
      name: "11-sent-picture",
      what: "Sent: both uploaded to the demo machine's private folder, the message went with their paths after the text; the user's bubble shows the picture as a thumbnail and the log by name, the paths themselves never shown",
      commands: [{ type: "click", selector: ".cmp .send" }],
      settleMs: 3_000,
    },
    {
      name: "12-picture-full-size",
      what: "The thumbnail clicked: the picture full size over the window (a click or Escape closes it)",
      commands: [{ type: "click", selector: ".chat .msg-u .thumb" }],
      settleMs: 1_200,
    },
    {
      name: "13-message-copied",
      what: "Copy under the agent's reply clicked: its check for a moment; every message has one (faint until the pointer is over it)",
      commands: [
        { type: "click", selector: ".viewer" },
        { type: "click", selector: ".chat .msg-a .msg-copy" },
      ],
      settleMs: 300,
    },
    {
      name: "14-chat-code",
      what: "A long finished chat (Mac mini, sundial pane, demo transcript): replies with code blocks in syntax colours under a header (language, Wrap, Copy), a heading, a list, a quote, a link, tool rows and the Worked for rows",
      commands: [
        { type: "select-pane", hostId: ids.macMini, paneId: "w6:p1" },
        { type: "set-tab", tab: "chat" },
      ],
      settleMs: 1_500,
    },
    {
      name: "15-send-to-picker",
      what: "Send to… for a reply in the design pane's chat: the picker with what is sent, its filter, every pane of both machines by machine and workspace (agents first, the source pane left out), and its keys (↑ ↓ move, ↩ open with draft, ⌘↩ send now, esc close)",
      commands: [{ type: "open-handoff", hostId: ids.macMini, paneId: "w7:p1H", text: demoHandoffText }],
      settleMs: 900,
    },
    {
      name: "16-send-to-landed",
      what: "Return on the working pane (Mac mini, aurora-web-mac): its tile is focused in Terminal, the view picked on it at step 06 (the pick is kept per pane), with its message box up holding the reply after its context line (From … in herdr-companion (Mac mini):); nothing sent",
      commands: [{ type: "pick-handoff", hostId: ids.macMini, paneId: "w7:p1G", action: "draft" }],
      settleMs: 1_200,
    },
    {
      name: "17-new-agent",
      what: "New agent from the herdr-companion workspace header's +: the workspace, the kinds (Claude runs cl from the demo Mac's agents.json, Codex, Grok, a shell), the folder with the workspace's folders suggested; Return starts, Esc cancels",
      commands: [{ type: "open-new-agent", hostId: ids.macMini, workspaceId: "w7" }],
      settleMs: 900,
    },
    {
      name: "18-new-agent-started",
      what: "Return on Claude: cl typed in a new tab of the workspace on the demo's Herdr, Claude there, and the new pane open in Chat (an agent pane opens in Chat); its row in the sidebar",
      commands: [{ type: "start-new-agent", hostId: ids.macMini, workspaceId: "w7", kind: "claude", folder: null }],
      settleMs: 1_500,
    },
    {
      name: "19-workspace-menu",
      what: "The herdr-companion header's right-click: New agent here; each header's + beside its count",
      commands: [{ type: "open-workspace-menu", hostId: ids.macMini, workspaceId: "w7" }],
      settleMs: 900,
    },
    // Chat | Terminal | Changes (demo git, demo-git.ts).
    {
      name: "20-changes-agent",
      what: "An agent's Changes (Mac mini, aurora-web-mac, the third segment): This turn (its running turn changed nothing yet), This session (the Edit of its first turn), its folder now (branch, a change not staged, one staged, one untracked) and the commits since its session began",
      commands: [
        { type: "select-pane", hostId: ids.macMini, paneId: "w7:p1G" },
        { type: "set-tab", tab: "changes" },
      ],
      settleMs: 1_500,
    },
    {
      name: "21-changes-file-diff",
      what: "A folder file's diff opened from Changes: Not staged, the new side's line numbers, a long line scrolled sideways, +5 −1 and Copy above, Back to Changes",
      commands: [{ type: "open-changes-row", rowId: "git|App/Terminal/CompanionTerminalView.swift" }],
      settleMs: 1_000,
    },
    {
      name: "22-changes-commit",
      what: "A commit this session opened from Changes: its message, stat and patch",
      commands: [
        { type: "set-tab", tab: "terminal" },
        { type: "set-tab", tab: "changes" },
        { type: "open-changes-row", rowId: "commit|" + demoGitCommit },
      ],
      settleMs: 1_000,
    },
    {
      name: "23-changes-own-edit",
      what: "A file the agent's own calls changed, opened from This session: each edit under its turn, tool, time and message",
      commands: [
        { type: "set-tab", tab: "terminal" },
        { type: "set-tab", tab: "changes" },
        { type: "open-changes-row", rowId: "session|" + demoGitFolders.macBuild + "/App/Terminal/CompanionTerminalView.swift" },
      ],
      settleMs: 1_000,
    },
    {
      name: "24-changes-shared-folder",
      what: "Changes of an agent with no transcript in a folder another agent shares (Mac mini, Quartz): who else uses it, its git only, the commits of the last 12 hours",
      commands: [{ type: "select-pane", hostId: ids.macMini, paneId: "w2:p1" }],
      settleMs: 1_500,
    },
    {
      name: "25-changes-overview",
      what: "Every agent's Changes (from View > What Each Agent Changed; the sidebar has no entry for it): each machine, its workspaces with the agents with changes first, each agent's folder git and its own files",
      commands: [{ type: "set-changes-overview", shown: true }],
      settleMs: 1_500,
    },
    {
      name: "26-away-line",
      what: "Nothing selected, no screen open (the sidebar has no While you were away line; View > While You Were Away opens its screen)",
      commands: [{ type: "set-changes-overview", shown: false }, { type: "clear-selection" }, { type: "show-away", shown: false }],
      settleMs: 1_500,
    },
    {
      name: "27-away-screen",
      what: "While you were away: the screen with a card per agent (Needs you, Finished, Still working; Quiet folded), each with its run, last reply, files and commits",
      commands: [{ type: "show-away", shown: true }],
      settleMs: 1_500,
    },
    {
      name: "28-search-results",
      what: "Search conversations (⇧⌘F) for “column” across both machines: the hits grouped by pane, newest first, each with who wrote it, when, and its text with the match marked (the demo machine answers the search from the fixture transcripts)",
      commands: [
        { type: "show-away", shown: false },
        { type: "search", query: "column" },
      ],
      settleMs: 2_500,
    },
    {
      name: "29-search-hit-open",
      what: "The first hit opened (Return): its pane in Chat with the message scrolled to the middle and marked",
      commands: [{ type: "search-open-first" }],
      settleMs: 2_000,
    },
    ...splitCaptureSteps(ids),
    ...copyCaptureSteps(ids),
    ...modelCaptureSteps(ids),
    ...newWorkspaceCaptureSteps(ids),
  ];
}

/** The folder the New workspace captures make one at (on the demo's Mac mini). */
export const demoNewWorkspaceFolder = "/Users/demo/code/herdr-site";

/** New workspace's dialog and the workspace it made, selected (steps 39-40). */
function newWorkspaceCaptureSteps(ids: { macMini: string }): CaptureStep[] {
  return [
    {
      name: "39-new-workspace",
      what: "New workspace (⇧⌘N, the sidebar's row under New agent, File > New Workspace…) on the Mac mini: the machine (a choice: two machines answer), a folder on it with the folders its panes are in suggested, the name from the folder's last part (herdr-site) until the user types their own; Return creates, Esc cancels; nothing is made here",
      commands: [
        // Step 38's context card goes with the pane it was on; the list back at its top (a mode change scrolls it there),
        // where the New workspace row is, under New agent.
        { type: "clear-selection" },
        { type: "set-mode", mode: "priority" },
        { type: "set-mode", mode: "projects" },
        { type: "open-new-workspace", hostId: ids.macMini, folder: demoNewWorkspaceFolder },
      ],
      settleMs: 900,
    },
    {
      name: "40-new-workspace-made",
      what: "Return: one workspace.create on the demo's Herdr; herdr-site is in the Mac mini's sidebar with its shell's row selected, and the main area offers Start an agent in it (New agent for herdr-site at its folder) or Open its shell",
      commands: [{ type: "create-workspace", hostId: ids.macMini, folder: demoNewWorkspaceFolder, name: null }],
      settleMs: 1_500,
    },
  ];
}

/** The split tabs' captures (steps 30-35), after the steps above. */
function splitCaptureSteps(ids: { macMini: string }): CaptureStep[] {
  const [lookChat] = demoSplitTab.chats;
  const attachChat = demoSplitTab.chats[1];
  return [
    {
      name: "30-two-panes",
      what: "Two panes side by side (workers 1 in herdr-companion, Herdr's layout): the aurora-web-mac pane focused (the accent ring) in Terminal, as picked at step 06, and the design pane in Chat; each tile's header has its number, glyph, name and kind, the Chat/Terminal switch, zoom, split and close; the sidebar marks both rows as shown",
      commands: [
        { type: "set-box", shown: false },
        { type: "select-pane", hostId: ids.macMini, paneId: "w7:p1G" },
        // The Changes steps (20-23) left this pane in Changes; back to the Terminal picked at step 06.
        { type: "set-tab", tab: "terminal" },
      ],
      settleMs: 2_000,
    },
    {
      name: "31-four-panes",
      what: "Four panes (the demo's split tab, desktop work in herdr-companion): two columns, each split down; the two working Claude panes in Chat following their live transcripts (a step every 1.4 s) and the two shells in Terminal printing their logs; the top-left tile focused; ⌘1–⌘4 by Herdr's order",
      commands: [{ type: "select-pane", hostId: ids.macMini, paneId: lookChat }],
      settleMs: 3_500,
    },
    {
      name: "32-split-menu-full",
      what: "The split menu on a tile of the 4-pane tab: Split right, Split down, New agent to the right…, New agent below…, each greyed with the reason (This tab already shows 4 panes; Adari shows up to 4.)",
      commands: [{ type: "open-split-menu", hostId: ids.macMini, paneId: lookChat }],
      settleMs: 900,
    },
    {
      name: "33-zoomed-pane",
      what: "A zoomed pane: the zoom button on the aurora-web-attach tile; Herdr zooms it (pane.zoom) and the main area shows it alone, in Chat following its live transcript, with the Zoomed chip and its Unzoom button",
      commands: [{ type: "zoom-pane", hostId: ids.macMini, paneId: attachChat, zoomed: true }],
      settleMs: 1_500,
    },
    {
      name: "34-split-menu",
      what: "The split menu on the design pane's tile (workers 1, two panes), after Unzoom on the split tab: Split right and Split down make a shell beside it as Herdr's split does; New agent to the right… and below… open New agent with its Where set",
      commands: [
        { type: "zoom-pane", hostId: ids.macMini, paneId: attachChat, zoomed: false },
        { type: "select-pane", hostId: ids.macMini, paneId: "w7:p1H" },
        { type: "open-split-menu", hostId: ids.macMini, paneId: "w7:p1H" },
      ],
      settleMs: 2_500,
    },
    {
      name: "35-new-agent-where",
      what: "New agent's Where (from the split menu's New agent to the right…): New tab, Split right (chosen) and Split down beside the design pane in herdr-companion; Return starts the agent in the new pane; nothing is started here",
      commands: [{ type: "open-new-agent", hostId: ids.macMini, workspaceId: "w7", where: { paneId: "w7:p1H", direction: "right" } }],
      settleMs: 900,
    },
  ];
}

/** The terminal copies what the user selects (step 36). */
function copyCaptureSteps(ids: { buildBox: string }): CaptureStep[] {
  return [
    {
      name: "36-terminal-copied",
      what: "A selection in the terminal (build-box, beacon: Claude Code's Bash dialog) dragged over its lines by the mouse: the moment the button comes up it is on the clipboard, and Copied shows in the tile's corner for 1.2 s (a capture run's copy does not reach this Mac's clipboard)",
      commands: [
        // The New agent dialog from step 35 closed (its scrim's click), nothing started.
        { type: "click", selector: ".scrim" },
        { type: "set-host-folded", hostId: ids.buildBox, folded: false },
        { type: "select-pane", hostId: ids.buildBox, paneId: "w1:p1" },
        { type: "set-tab", tab: "terminal" },
      ],
      after: { afterMs: 2_000, commands: [{ type: "terminal-select", selector: ".term-host canvas", from: { x: 0.02, y: 0.08 }, to: { x: 0.7, y: 0.3 } }] },
      settleMs: 350,
    },
  ];
}

/** The Model and Effort chips and the context card (steps 37-38). */
function modelCaptureSteps(ids: { macMini: string }): CaptureStep[] {
  return [
    {
      name: "37-model-effort-chips",
      what: "The design pane's box (workers 1, in Chat) with the Model and Effort chips right after the agent (Claude · Opus 5.5 · Extra high · folder · machine; the effort its replies carry), its Effort menu open at the chip: Low, Medium, High, Extra high, Max (Extra high ticked); nothing is picked",
      commands: [
        // Step 36 already closed step 35's New agent dialog; no Cancel here.
        { type: "select-pane", hostId: ids.macMini, paneId: "w7:p1H" },
        { type: "set-tab", tab: "chat" },
        { type: "click", selector: ".cmp-bar .chip.pick.effort .pick-b" },
      ],
      settleMs: 2_500,
    },
    {
      name: "38-context-card",
      what: "The same box with the context ring just left of the paperclip and its card open (a click): Context, the used share of the model's 1M window (the demo machine has no user settings), a bar with the tick where it compacts, the source line and Compact; nothing is sent",
      commands: [
        // The Effort menu from step 37 closes (its chip again), then the ring opens its card.
        { type: "click", selector: ".cmp-bar .chip.pick.effort .pick-b" },
        { type: "click", selector: ".cmp-bar .ctx-ring" },
      ],
      settleMs: 2_000,
    },
  ];
}

/**
 * A Grok pane's Chat (step 51; main.ts takes it after the needs-you card's 45-50,
 * before the update mark's 52 and the live row's 53-54).
 */
export function grokCaptureSteps(ids: { macMini: string }): CaptureStep[] {
  return [
    {
      name: "51-grok-chat",
      what: "A Grok pane's Chat (Mac mini, tidepool-narration; Herdr names no session, so Chat follows the newest Grok session filed under its folder): the user's message, the thinking, Read, Search, the Edit with its diff, the command and its output, the reply joined from its parts and Worked for; then the user's next message, its turn still running, its last command waiting on Grok's approval frame (the card at the end, captures 80-83)",
      commands: [
        { type: "select-pane", hostId: ids.macMini, paneId: "wD:pK" },
        { type: "set-tab", tab: "chat" },
      ],
      settleMs: 2_000,
    },
  ];
}

/** The demo pane whose Claude Code has an update installed (step 52). */
export const demoUpdateReadyPane = "w6:p1";

/**
 * "Update ready" on the sidebar row and in the header, its card
 * open (step 52), on the pane sendCaptureSteps' 41-44 show in Chat.
 */
export function updateMarkCaptureSteps(ids: { macMini: string }): CaptureStep[] {
  return [
    {
      name: "52-update-ready",
      what: "A Claude pane whose screen shows Claude Code's \"✔ Update installed · Restart to update\" (Mac mini, w6:p1, the demo's pane.read): the Update ready mark on its sidebar row beside the name (tooltip: Claude Code update installed. /exit when it's idle, then Resume.) and beside the agent's name in the header, the header mark's card open with the same words and its main button, Restart on the new version (the agent done, its session known: enabled); the click is not made, nothing is sent",
      commands: [
        { type: "select-pane", hostId: ids.macMini, paneId: demoUpdateReadyPane },
        { type: "set-tab", tab: "chat" },
        { type: "click", selector: ".mh .upd" },
      ],
      settleMs: 2_000,
    },
  ];
}

/** The Chat's scroll and the box as the captures measure them. */
const chatMeasure = `(() => {
  const s = document.querySelector(".chat-scroll");
  const i = document.querySelector(".chat-inset");
  const w = document.querySelector(".cmp-wrap.float");
  return {
    gapToEnd: Math.round(s.scrollHeight - s.scrollTop - s.clientHeight),
    scrollTop: Math.round(s.scrollTop),
    scrollHeight: s.scrollHeight,
    clientHeight: s.clientHeight,
    insetHeight: i === null ? null : i.offsetHeight,
    boxHeight: w === null ? null : w.offsetHeight,
    newPill: document.querySelector(".chat-new") !== null,
    pendingBubbles: document.querySelectorAll(".msg-u.pending").length,
  };
})()`;

/** A draft put in the open pane's box as typing would (the textarea's value, then its input event). */
function typeDraft(text: string): string {
  return `(() => {
    const t = document.querySelector(".cmp textarea");
    t.focus();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(t, ${JSON.stringify(text)});
    t.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`;
}

/**
 * The chat scrolled to `fraction` of its height (1: its end), as the user's wheel would leave it. A wheel
 * event first, as a wheel sends one: only the user's gesture lets the Chat go of its end (a bare scroll goes back to it).
 */
function scrollChat(fraction: number): string {
  return `(() => { const s = document.querySelector(".chat-scroll"); s.dispatchEvent(new WheelEvent("wheel", { deltaY: -1, bubbles: true })); s.scrollTop = Math.round((s.scrollHeight - s.clientHeight) * ${fraction}); return true; })()`;
}

const multiLineDraft = Array.from({ length: 10 }, (_, i) => `Line ${i + 1}: check the release notes against the tests and say what is missing.`).join("\n");

/**
 * A send takes the user to the bottom. The long finished
 * demo chat (Mac mini, sundial) in the one pane view: scrolled up into its
 * history with a draft in the box, then Send; then at its end with a 10-line
 * draft, then Send (the box shrinks). Each capture keeps the chat's distance
 * from its end and whether the New pill shows (captures.json). The capture
 * run takes them after demoCaptureSteps' 40 (main.ts).
 */
export function sendCaptureSteps(ids: { macMini: string }): CaptureStep[] {
  return [
    {
      name: "41-scrolled-up-before-send",
      what: "The long finished demo chat (Mac mini, sundial) in the one pane view, scrolled up into its history, a draft in the box; nothing sent yet",
      commands: [
        // Step 38's context card closes (the ring again) before another pane opens.
        { type: "click", selector: ".cmp-bar .ctx-ring" },
        { type: "set-host-folded", hostId: ids.macMini, folded: false },
        { type: "select-pane", hostId: ids.macMini, paneId: "w6:p1" },
        { type: "set-tab", tab: "chat" },
      ],
      after: { afterMs: 1_500, commands: [] },
      page: [scrollChat(0.4), typeDraft("Can you check the release notes once more before I tag it?")],
      settleMs: 800,
      measure: chatMeasure,
    },
    {
      name: "42-after-send-at-end",
      what: "Send pressed while scrolled up: the chat at its end, following, the user's message bubble above the box, no New pill",
      commands: [{ type: "click", selector: ".cmp-bar .send.on" }],
      settleMs: 1_500,
      measure: chatMeasure,
    },
    {
      name: "43-multiline-draft-at-end",
      what: "The same chat at its end with a 10-line draft in the box (the box tall, the chat's end clear of it)",
      commands: [],
      page: [scrollChat(1), typeDraft(multiLineDraft)],
      settleMs: 800,
      measure: chatMeasure,
    },
    {
      name: "44-multiline-sent-at-end",
      what: "The 10-line draft sent at the end: the box back to one line, the chat still at its end (no gap left by the box shrinking)",
      commands: [{ type: "click", selector: ".cmp-bar .send.on" }],
      settleMs: 1_500,
      measure: chatMeasure,
    },
  ];
}

/** What a capture shows of the needs-you card (in a split, the focused tile's): its kind, header, question, options, Sent, and the Needs you rows. */
const cardMeasure = `(() => {
  const card = document.querySelector(".tile.focused .ncard") ?? document.querySelector(".ncard");
  const text = (selector) => card?.querySelector(selector)?.textContent ?? null;
  return {
    card: card?.getAttribute("data-needs-card") ?? null,
    header: text(".nc-t"),
    target: text(".nc-target"),
    question: text(".nc-q"),
    options: card === null ? [] : [...card.querySelectorAll(".nc-opt")].map((b) => (b.classList.contains("on") ? "[" + b.textContent + "]" : b.textContent)),
    diffRows: card === null ? 0 : card.querySelectorAll(".nc-diff .dl:not(.more)").length,
    more: text(".nc-diff .more"),
    lines: text(".nc-lines"),
    sent: text(".nc-sent"),
    placeholder: document.querySelector(".cmp textarea")?.getAttribute("placeholder") ?? null,
    needsYou: [...document.querySelectorAll(".row.ny .nm")].map((n) => n.textContent),
  };
})()`;

/**
 * The needs-you card at the end of Chat on the demo's blocked
 * panes (demo-prompts.ts screens, read by the real matcher in main): a Bash
 * run, an edit with a diff, an AskUserQuestion menu after the edit's answer, an
 * unmatched question, "Sent: Yes" after an answer, and the sidebar once that
 * pane's question is gone (two quiet reads 2.5 s apart).
 */
export function needsCardCaptureSteps(ids: { macMini: string; buildBox: string }): CaptureStep[] {
  return [
    {
      name: "45-needs-card-run",
      what: "build-box's beacon in Chat: Claude wants to run, the command in mono, Do you want to proceed?, four options with Yes (Return) filled vermilion, the key hint; the box answers 4 in words",
      commands: [
        { type: "set-mode", mode: "projects" },
        { type: "set-host-folded", hostId: ids.buildBox, folded: false },
        { type: "select-pane", hostId: ids.buildBox, paneId: "w1:p1" },
        { type: "set-tab", tab: "chat" },
      ],
      settleMs: 3_000,
      measure: cardMeasure,
    },
    {
      name: "46-needs-card-edit",
      what: "Mac mini's Quartz pane in Chat: Claude wants to edit src/sync/retry-config.ts, six diff rows and 3 more lines, the question, Yes filled, No and tell Claude as the box's option",
      commands: [
        { type: "set-host-folded", hostId: ids.macMini, folded: false },
        { type: "select-pane", hostId: ids.macMini, paneId: "w2:p70" },
        { type: "set-tab", tab: "chat" },
      ],
      settleMs: 3_000,
      measure: cardMeasure,
    },
    {
      name: "47-needs-card-asks",
      what: "The edit answered with Yes (a click on 1, through main's fingerprint check): the pane's next question, an AskUserQuestion menu: Claude asks, four options, no box option (the box says Claude is waiting on the question above)",
      commands: [{ type: "click", selector: '.ncard .nc-opt[data-key="1"]' }],
      settleMs: 3_500,
      measure: cardMeasure,
    },
    {
      name: "48-needs-card-unmatched",
      what: "build-box's bookshop (Codex) in Chat: a question the matcher does not read: Codex needs you, its lines in mono, Answer in Terminal",
      commands: [
        { type: "select-pane", hostId: ids.buildBox, paneId: "w1:p2" },
        { type: "set-tab", tab: "chat" },
      ],
      settleMs: 3_000,
      measure: cardMeasure,
    },
    {
      name: "49-needs-card-sent",
      what: "beacon's Bash question answered with Yes (a click on 1): Sent: Yes in the options' place while the screen moves on",
      commands: [
        { type: "select-pane", hostId: ids.buildBox, paneId: "w1:p1" },
        { type: "set-tab", tab: "chat" },
        { type: "click", selector: '.tile.focused .ncard .nc-opt[data-key="1"]' },
      ],
      settleMs: 700,
      measure: cardMeasure,
    },
    {
      name: "50-needs-card-gone-sidebar",
      what: "beacon's question gone from its screen (two reads, 2.5 s apart, nothing prompt-like) while the demo's Herdr still says blocked: beacon shows as working, out of Needs you; bookshop and Quartz stay",
      commands: [],
      settleMs: 7_000,
      measure: cardMeasure,
    },
  ];
}

/** What a capture shows of the live row (the focused tile's Chat): its text, the demo reply's rows, and the Chat's place. */
const liveMeasure = `(() => {
  const chat = document.querySelector(".tile.focused .chat-scroll") ?? document.querySelector(".chat-scroll");
  const live = chat?.querySelector("[data-chat-live]") ?? null;
  const replies = chat === null ? [] : [...chat.querySelectorAll(".msg-a:not(.live)")].map((row) => row.textContent ?? "");
  return {
    liveRow: live === null ? null : live.textContent,
    liveRows: chat === null ? 0 : chat.querySelectorAll("[data-chat-live]").length,
    landedReplyRows: replies.filter((text) => text.includes("The Return tests pass")).length,
    gapToEnd: chat === null ? null : Math.round(chat.scrollHeight - chat.scrollTop - chat.clientHeight),
    newPill: chat?.parentElement?.querySelector(".chat-new") != null,
    working: chat?.parentElement?.querySelector(".working") != null,
  };
})()`;

/** The user's message typed in the focused tile's box and sent with its Send button. */
function sendFromFocusedTile(text: string): string {
  return `(async () => {
    const t = document.querySelector(".tile.focused .cmp textarea") ?? document.querySelector(".cmp textarea");
    t.focus();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(t, ${JSON.stringify(text)});
    t.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 150));
    const send = document.querySelector(".tile.focused .cmp-bar .send.on") ?? document.querySelector(".cmp-bar .send.on");
    send?.click();
    return send != null;
  })()`;
}

/**
 * Chat's live row on the Mac mini's working Claude pane
 * (the left tile of workers 1): the user's message sent from
 * its box, then Claude's reply as it is being written (read off the pane's
 * screen in main about every 400 ms, demo-live.ts), at the Chat's end, the
 * Chat following it; then the reply landed in the transcript, its row in the
 * live row's place, one row.
 */
export function liveRowCaptureSteps(ids: { macMini: string }): CaptureStep[] {
  return [
    {
      name: "53-live-row-streaming",
      what: "aurora-web-mac (Mac mini, working) in Chat, left tile of workers 1: the user's message sent, then Claude's reply being written at the Chat's end (the live row, a breathing dot in its margin), read off the pane's screen; the Chat at its end, following",
      commands: [
        { type: "set-mode", mode: "projects" },
        { type: "set-host-folded", hostId: ids.macMini, folded: false },
        { type: "select-pane", hostId: ids.macMini, paneId: "w7:p1G" },
        { type: "set-tab", tab: "chat" },
      ],
      after: { afterMs: 2_000, commands: [] },
      page: [sendFromFocusedTile("Run the Return tests once more and tell me where they stand.")],
      settleMs: 4_800,
      measure: liveMeasure,
    },
    {
      name: "54-live-row-landed",
      what: "The reply landed in the transcript: its reply row (Markdown: bold, the list) in the live row's place, one row, no live row; the Chat still at its end",
      commands: [],
      settleMs: 7_000,
      measure: liveMeasure,
    },
  ];
}

/** The live row's measure for the Codex pane's demo reply. */
const codexLiveMeasure = liveMeasure.replace("The Return tests pass", "This week's notes mention both");

/**
 * Chat's live row on the Mac mini's idle Codex pane (Atelier, w5):
 * the user's message sent from its box, the pane works, then Codex's reply as it is
 * being written (read off the pane's screen about every 400 ms, the link drawn
 * "label (target)", demo-live.ts), at the Chat's end; then the reply landed in
 * the rollout, its row (Markdown links, bold) in the live row's place, one row.
 */
export function codexLiveCaptureSteps(ids: { macMini: string }): CaptureStep[] {
  return [
    {
      name: "55-codex-live-streaming",
      what: "The Mac mini's Codex pane (Atelier) in Chat: the user's message sent, the pane working, then Codex's reply being written at the Chat's end (the live row, read off the pane's screen; its links as Codex draws them, 'label (target)'); the Chat at its end, following",
      commands: [
        { type: "set-mode", mode: "projects" },
        { type: "set-host-folded", hostId: ids.macMini, folded: false },
        { type: "select-pane", hostId: ids.macMini, paneId: "w5:pH" },
        { type: "set-tab", tab: "chat" },
      ],
      after: { afterMs: 2_000, commands: [] },
      page: [sendFromFocusedTile("Do this week's notes mention Qwen or DeepSeek?")],
      settleMs: 7_000,
      measure: codexLiveMeasure,
    },
    {
      name: "56-codex-live-landed",
      what: "The reply landed in the rollout: its reply row (Markdown: the two note links, bold) in the live row's place, one row, no live row; the Chat still at its end",
      commands: [],
      // Landed 11 s after the message reached the pane; past the app's next 5 s refresh, which shows the pane done.
      settleMs: 12_000,
      measure: codexLiveMeasure,
    },
  ];
}

/**
 * A Cursor pane's Chat (step 57; main.ts takes it after the Codex live row's 55-56).
 */
export function cursorCaptureSteps(ids: { macMini: string }): CaptureStep[] {
  return [
    {
      name: "57-cursor-chat",
      what: "The Mac mini's Cursor pane (harbor; Herdr names no session, so Chat follows the newest chat Cursor filed under its folder, its store.db read as one line per root ref): the user's message timed by its <timestamp>, the reply, Read, Grep as a search, the StrReplace edit with its diff, the failed Shell (exit 1) and the one that passed, the final reply and Worked for",
      commands: [
        { type: "set-mode", mode: "projects" },
        { type: "set-host-folded", hostId: ids.macMini, folded: false },
        { type: "select-pane", hostId: ids.macMini, paneId: "wC:p1" },
        { type: "set-tab", tab: "chat" },
      ],
      settleMs: 2_500,
    },
  ];
}

/** The live row's measure for the Cursor pane's demo reply. */
const cursorLiveMeasure = liveMeasure.replace("The Return tests pass", "Two tests in RateLimiterTests cover the window reset");

/**
 * Chat's live row on the Mac mini's idle Cursor pane (harbor,
 * wC:p1; steps 66-67, main.ts takes them after the pane menus' 58-61): the user's message
 * sent from its box, the pane works (Thinking, the lead-in and its Read, which
 * the store saves as their own message), then Cursor's reply as it is being
 * written (read off the pane's screen about every 400 ms: the heading a plain
 * line, the code without its fence, as Cursor draws them, demo-live.ts), at the
 * Chat's end; then the reply landed in the store, its row (Markdown: the
 * heading, the list, the fenced code) in the live row's place, one row.
 */
export function cursorLiveCaptureSteps(ids: { macMini: string }): CaptureStep[] {
  return [
    {
      name: "66-cursor-live-streaming",
      what: "The Mac mini's Cursor pane (harbor) in Chat: the user's message sent, the pane working, the lead-in and its Read once (the store's), then Cursor's reply being written at the Chat's end (the live row, read off the pane's screen: the heading a plain line as Cursor draws it); the Chat at its end, following",
      commands: [
        { type: "set-mode", mode: "projects" },
        { type: "set-host-folded", hostId: ids.macMini, folded: false },
        { type: "select-pane", hostId: ids.macMini, paneId: "wC:p1" },
        { type: "set-tab", tab: "chat" },
      ],
      after: { afterMs: 2_000, commands: [] },
      page: [sendFromFocusedTile("Which tests cover the limiter's window reset?")],
      settleMs: 7_000,
      measure: cursorLiveMeasure,
    },
    {
      name: "67-cursor-live-landed",
      what: "The reply landed in the store: its reply row (Markdown: the Window reset heading, the numbered list, the fenced zsh code) in the live row's place, one row, the lead-in once, no live row; the Chat still at its end",
      commands: [],
      // Landed 11 s after the message reached the pane; past the app's next 5 s refresh, which shows the pane done.
      settleMs: 12_000,
      measure: cursorLiveMeasure,
    },
  ];
}

/** The Cursor pane's chips and Effort chip, read off the page. */
const cursorChipsMeasure = `(() => {
  const chips = [...document.querySelectorAll(".cmp-bar .chip.pick .pick-b")].map((b) => b.getAttribute("aria-label"));
  const menu = [...document.querySelectorAll(".chip-menu .chip-g, .chip-menu [role=menuitemradio]")].map((e) => (e.classList.contains("chip-g") ? "# " : "") + e.textContent + (e.getAttribute("aria-checked") === "true" ? " (ticked)" : ""));
  return { chips, menu };
})()`;

/**
 * The Mac mini's Cursor pane (harbor, wC:p1; steps 68-70,
 * main.ts takes them after the Cursor live row's 66-67): its Model and Effort chips
 * read off Cursor's footer (Grok 4.7 256K Medium · 4.2%), the Effort chip's
 * menu in T3 Code's traits order (Effort, Context, Fast, the footer's ticked),
 * then High picked: the demo pane's Cursor menu driven by keys (/model, Enter,
 * Tab, the arrow down to High, Enter, Esc, Esc), the footer then says High.
 */
export function cursorChipsCaptureSteps(ids: { macMini: string }): CaptureStep[] {
  return [
    {
      name: "68-cursor-chips",
      what: "The Cursor pane's box in Chat: Cursor \u{00B7} Grok 4.7 \u{00B7} Medium and the ring (4.2% of 256K), read off the footer under Cursor's box; nothing picked",
      commands: [
        { type: "set-mode", mode: "projects" },
        { type: "set-host-folded", hostId: ids.macMini, folded: false },
        { type: "select-pane", hostId: ids.macMini, paneId: "wC:p1" },
        { type: "set-tab", tab: "chat" },
      ],
      settleMs: 2_500,
      measure: cursorChipsMeasure,
    },
    {
      name: "69-cursor-effort-menu",
      what: "The Effort chip's menu: Effort (Low, Medium ticked, High, Extra High), Context (256K ticked, 500K), Fast; nothing picked yet",
      commands: [{ type: "click", selector: ".cmp-bar .chip.pick.effort .pick-b" }],
      settleMs: 800,
      measure: cursorChipsMeasure,
    },
    {
      name: "70-cursor-effort-high",
      what: "High picked: Cursor's own menu driven by keys on the demo pane, the screen read after each (/model, Enter, Tab, Down x4, Enter, Esc, Esc); the footer says Grok 4.7 256K High, so the chip shows High",
      commands: [{ type: "click", selector: ".chip-menu button[role=menuitemradio]:nth-of-type(3)" }],
      settleMs: 2_500,
      measure: cursorChipsMeasure,
    },
  ];
}

/**
 * The Mac mini's Grok pane (tidepool-narration,
 * wD:pK; steps 71-73, after 68-70): its Model and Effort chips from the
 * summary.json beside its session (Grok 4.7, High), the Effort menu (Effort,
 * then Context, ticked by summary.json and signals.json), then Medium picked:
 * `/model grok-4.7 256k medium` typed into its box and Enter, its border then
 * says medium.
 */
export function grokChipsCaptureSteps(ids: { macMini: string }): CaptureStep[] {
  return [
    {
      name: "71-grok-chips",
      what: "The Grok pane's box in Chat: Grok \u{00B7} Grok 4.7 \u{00B7} High, read from the summary.json beside its session; nothing picked",
      commands: [
        { type: "set-mode", mode: "projects" },
        { type: "set-host-folded", hostId: ids.macMini, folded: false },
        { type: "select-pane", hostId: ids.macMini, paneId: "wD:pK" },
        { type: "set-tab", tab: "chat" },
      ],
      settleMs: 2_500,
      measure: cursorChipsMeasure,
    },
    {
      name: "72-grok-effort-menu",
      what: "The Grok Effort chip's menu: Effort (Low, Medium, High ticked, Extra high), Context (256K ticked, 500K); nothing picked yet",
      commands: [{ type: "click", selector: ".cmp-bar .chip.pick.effort .pick-b" }],
      settleMs: 800,
      measure: cursorChipsMeasure,
    },
    {
      name: "73-grok-effort-medium",
      what: "Medium picked: /model grok-4.7 256k medium typed into the demo Grok pane's box and Enter; its border says Grok 4.7 (medium), so the chip shows Medium",
      commands: [{ type: "click", selector: ".chip-menu button[role=menuitemradio]:nth-of-type(2)" }],
      settleMs: 2_500,
      measure: cursorChipsMeasure,
    },
  ];
}

/**
 * Close pane and Rename… (steps 58-61; main.ts takes them after
 * the Cursor pane's Chat, 57). Nothing is chosen: no pane is closed or renamed.
 */
export function manageCaptureSteps(ids: { macMini: string }): CaptureStep[] {
  return [
    {
      name: "58-more-menu-shell",
      what: "The pane header's More (…) on a shell pane (Mac mini, Meterbox's shell, alone in its tab, Terminal): Rename… and Close pane (no Restart: it is an agent's). Nothing is chosen",
      commands: [
        { type: "set-mode", mode: "projects" },
        { type: "set-host-folded", hostId: ids.macMini, folded: false },
        { type: "select-pane", hostId: ids.macMini, paneId: "w8:p1" },
        { type: "set-tab", tab: "terminal" },
        { type: "set-box", shown: false },
      ],
      after: { afterMs: 800, commands: [{ type: "click", selector: '.main [data-more="pane"]' }] },
      settleMs: 1_200,
    },
    {
      name: "59-row-menu",
      what: "A sidebar row's right-click menu (Mac mini, Quartz, Notes Opus): Open in Ghostty where it is shown (greyed: a demo machine has no SSH address), Rename… and Close pane. Nothing is chosen",
      commands: [
        { type: "select-pane", hostId: ids.macMini, paneId: "w2:p70" },
        { type: "set-tab", tab: "chat" },
        { type: "open-row-menu", hostId: ids.macMini, paneId: "w2:p70" },
      ],
      settleMs: 1_200,
    },
    {
      name: "60-row-rename",
      what: "Rename… on Notes Opus's row, a name that is its tab's label: the inline field in the row's place with its name selected, the tip under it (Return saves · Esc cancels · renames the tab in Herdr, the Swift renameTarget); nothing is sent until Return",
      commands: [{ type: "rename-pane", hostId: ids.macMini, paneId: "w2:p70" }],
      settleMs: 1_000,
    },
    {
      name: "61-workspace-rename",
      what: "Rename workspace… on Quartz's header: the same field on the header with the workspace's name selected; nothing is sent until Return",
      commands: [{ type: "rename-workspace", hostId: ids.macMini, workspaceId: "w2" }],
      settleMs: 1_000,
    },
  ];
}

/**
 * The Model and Effort chips read what the agent runs on (step 62; main.ts takes it after
 * the Cursor pane's Chat, 57).
 */
export function chipsEffortCaptureSteps(ids: { macMini: string }): CaptureStep[] {
  return [
    {
      name: "62-chips-effort",
      what: "The design pane's box (workers 1, in Chat): Claude · Opus 5.5 · Extra high · folder · machine, the model from its newest reply's message.model and the effort from the effort Claude Code writes on every reply; no menu open, nothing picked",
      commands: [
        { type: "set-mode", mode: "projects" },
        { type: "select-pane", hostId: ids.macMini, paneId: "w7:p1H" },
        { type: "set-tab", tab: "chat" },
      ],
      settleMs: 2_500,
    },
  ];
}

/** What the Running strip and its panel show (the captures' measure). */
const runningMeasure = `(() => {
  const strip = document.querySelector(".run-strip");
  const items = strip === null ? [] : [...strip.querySelectorAll(".run-item")];
  const panel = document.querySelector(".run-panel");
  const rows = [...document.querySelectorAll(".chat-scroll .tr")].map((row) => (row.textContent ?? "").replace(/\\s+/g, " ").trim()).filter((text) => text.length > 0);
  return {
    strip: items.map((item) => ({ kind: item.getAttribute("data-kind"), text: (item.textContent ?? "").replace(/\\s+/g, " ").trim() })),
    panel: panel === null ? null : (panel.textContent ?? "").replace(/\\s+/g, " ").trim(),
    rows: rows.slice(-12),
  };
})()`;

/**
 * The Running strip right above the message box on the Mac mini's marigold pane (its turn
 * ended with a dev server, a monitor and a background agent still running), a monitor's panel open, and the
 * tidepool pane's rows after the same three ended.
 */
export function runningCaptureSteps(ids: { macMini: string }): CaptureStep[] {
  return [
    {
      name: "63-running-strip",
      what: "The marigold pane (Mac mini, Bellhop) in Chat: its turn ended with three things still running, so the Running strip right above the message box has a background command (Start the dev server), a monitor (Watch the build for errors) and a background agent (Check the board on a phone) with its newest step (Ran npx playwright test …, read from its own transcript), each with its time, ticking",
      commands: [
        { type: "set-mode", mode: "projects" },
        { type: "set-host-folded", hostId: ids.macMini, folded: false },
        { type: "select-pane", hostId: ids.macMini, paneId: "wB:p1" },
        { type: "set-tab", tab: "chat" },
      ],
      settleMs: 3_500,
      measure: runningMeasure,
    },
    {
      name: "64-running-panel",
      what: "The monitor's item clicked: its panel above the strip with the command (its first lines) and the newest event (the WARN line); Esc or a click elsewhere closes it",
      commands: [],
      page: [`document.querySelector('.run-item[data-kind="monitor"]')?.click()`],
      settleMs: 900,
      measure: runningMeasure,
    },
    {
      name: "65-running-ended",
      what: "The tidepool pane (Mac mini, Tidepool) in Chat after the same three ended: their rows fold again (Ran 2 commands, opened here: the background command done, the monitor stopped by TaskStop), the agent's row done with its time; no Running strip",
      commands: [
        { type: "select-pane", hostId: ids.macMini, paneId: "wD:p1" },
        { type: "set-tab", tab: "chat" },
      ],
      after: { afterMs: 2_000, commands: [] },
      page: [`[...document.querySelectorAll(".chat-scroll button")].find((b) => (b.textContent ?? "").trim().startsWith("Ran 2 commands"))?.click()`],
      settleMs: 1_200,
      measure: runningMeasure,
    },
  ];
}

/** What the Grok captures show: the card's words, the Working line, the pane's status, the Needs you group. */
const grokCardMeasure = `(() => {
  const card = document.querySelector(".ncard");
  const text = (selector) => card?.querySelector(selector)?.textContent ?? null;
  return {
    card: card?.getAttribute("data-needs-card") ?? null,
    header: text(".nc-t"),
    title: text(".nc-q"),
    command: text(".nc-cmd"),
    options: card === null ? [] : [...card.querySelectorAll(".nc-opt")].map((b) => (b.classList.contains("on") ? "[" + b.textContent + "]" : b.textContent)),
    sent: text(".nc-sent"),
    note: text(".nc-note"),
    working: document.querySelector(".chat .working-t")?.textContent ?? null,
    status: document.querySelector(".main .mh .stt")?.textContent ?? null,
    frameInTerminal: document.querySelector(".main .term-area") !== null && card === null,
    needsYou: [...document.querySelectorAll(".row.ny .nm")].map((n) => n.textContent),
  };
})()`;

/**
 * The demo's Grok pane (Mac mini, tidepool-narration,
 * wD:pK) waiting on Grok 1.0.70's approval frame (demo-prompts.ts), its turn
 * running for 17m 8s when the demo starts (demo-chat.ts): the card (80), the
 * same frame in the pane's Terminal (81), a pick (82: a click on 3, its digit
 * closes the frame, and the card goes at main's next read) and, two quiet
 * reads later, the pane working with the Working line counting from the
 * turn's real start, not the pick (83). Main.ts takes them after
 * the Grok chips (71-73) and before the sidebar's 86-87.
 * (Step 61 leaves its workspace rename field open in the sidebar; no
 * capture command closes it.)
 */
export function grokCardCaptureSteps(ids: { macMini: string }): CaptureStep[] {
  return [
    {
      name: "80-grok-card",
      what: "The Grok pane in Chat, blocked on Grok's approval frame: Grok wants to run, the frame's title (Render scene 3's narration check), the command whole, Grok's five options in its order and words (always-approve and Always allow / Never allow too) with 3 Yes, proceed (Return) filled; Grok in Needs you",
      commands: [
        { type: "set-mode", mode: "projects" },
        { type: "set-host-folded", hostId: ids.macMini, folded: false },
        { type: "select-pane", hostId: ids.macMini, paneId: "wD:pK" },
        { type: "set-tab", tab: "chat" },
      ],
      settleMs: 3_500,
      measure: grokCardMeasure,
    },
    {
      name: "81-grok-terminal",
      what: "The same pane's Terminal: the frame the card reads, as Grok draws it (the ┃ block, the › title, the command under │, the options, the 1/5:select footer)",
      commands: [{ type: "set-tab", tab: "terminal" }],
      settleMs: 2_000,
      measure: grokCardMeasure,
    },
    {
      name: "82-grok-after-pick",
      what: "Back in Chat, 3 Yes, proceed clicked: main re-read the frame (same fingerprint), sent the digit 3 alone, read 300 ms later and found the frame gone (it took: no Enter, never Esc): the card says Sent: Yes, proceed in place of its options until the pane's next read, which shows nothing prompt-like and takes the card away with the frame (900 ms after the click lands on either side of that read). Herdr still says blocked (Needs you in the header and the sidebar) until two quiet reads clear the mark; the command's row still runs",
      commands: [
        { type: "set-tab", tab: "chat" },
        { type: "click", selector: '.ncard .nc-opt[data-key="3"]' },
      ],
      settleMs: 900,
      measure: grokCardMeasure,
    },
    {
      name: "83-grok-working",
      what: "Two quiet reads later the mark is cleared: the pane shows as Working (out of Needs you, Priority 3 to 2) while the demo's Herdr still says blocked, and the Working line counts from the turn's real start (Grok's turnStartMs, 17m 8s before the demo started, plus the minutes the captures took), not from the pick",
      commands: [],
      settleMs: 7_000,
      measure: grokCardMeasure,
    },
  ];
}

/** The card as the captures measure it (Codex's header, parameters, options with descriptions). */
const codexAskMeasure = `(() => {
  const card = document.querySelector(".ncard");
  const text = (selector) => card?.querySelector(selector)?.textContent ?? null;
  return {
    card: card?.getAttribute("data-needs-card") ?? null,
    header: text(".nc-t"),
    question: text(".nc-q"),
    parameters: text(".nc-params"),
    options: card === null ? [] : [...card.querySelectorAll(".nc-opt")].map((b) => {
      const words = (b.querySelector(".k")?.textContent ?? "") + " " + (b.querySelector(".l")?.textContent ?? "") + " / " + (b.querySelector(".d")?.textContent ?? "");
      return b.classList.contains("on") ? "[" + words + "]" : words;
    }),
    sent: text(".nc-sent"),
    note: text(".nc-note"),
    terminalButton: card?.querySelector(".nc-term") !== null && card !== null,
    status: document.querySelector(".main .mh .stt")?.textContent ?? null,
    frameInTerminal: document.querySelector(".main .term-area") !== null && card === null,
    needsYou: [...document.querySelectorAll(".row.ny .nm")].map((n) => n.textContent),
    pills: [...document.querySelectorAll(".sb .row.ny")].map((row) => (row.querySelector(".nm")?.textContent ?? "") + ": " + (row.querySelector(".pill")?.textContent ?? "")),
  };
})()`;

/**
 * The demo's Codex pane (Mac mini,
 * lumen-onboarding-perf, wA:pM) waiting on Codex 0.166.0's tool-call
 * question (a computer-use app request, demo-prompts.ts): the card in Chat
 * (88), the same form in the pane's Terminal (89), and a pick (90: a click on
 * 1 Allow; main re-reads the form, sends the digit 1 alone, reads 300 ms later
 * and finds the form gone). The pane is zoomed for them (it shares workers 1
 * with two others); they are last, so nothing after them sees the zoom.
 * Main.ts takes them last, after the sidebar's 86-87.
 */
export function codexAskCaptureSteps(ids: { macMini: string }): CaptureStep[] {
  return [
    {
      name: "88-codex-ask-card",
      what: "The Codex pane in Chat, blocked on Codex 0.166.0's tool-call question (a computer-use app request): Codex wants to use a tool, Codex's header (Allow Computer Use to control Google Chrome), its two parameter rows, and Codex's four options in its order, each with its description under it (1 Allow, 2 Allow for this session, 3 Always allow: Run the tool and remember this choice for future tool calls, 4 Cancel), 1 Allow (Codex's mark) filled; Pending Approval in the sidebar. The pane is zoomed (it shares workers 1 with two others) so the whole card shows; Herdr names no session for it, so Chat says so above the card",
      commands: [
        { type: "set-mode", mode: "projects" },
        { type: "set-host-folded", hostId: ids.macMini, folded: false },
        { type: "select-pane", hostId: ids.macMini, paneId: "wA:pM" },
        // The pane shares workers 1 with two others: zoomed, the whole card shows.
        { type: "zoom-pane", hostId: ids.macMini, paneId: "wA:pM", zoomed: true },
        { type: "set-tab", tab: "chat" },
      ],
      settleMs: 3_500,
      measure: codexAskMeasure,
    },
    {
      name: "89-codex-ask-terminal",
      what: "The same pane's Terminal: the form the card reads, as Codex draws it (Field 1/1, the header, the parameter rows, the numbered options with their descriptions, enter to submit | esc to cancel)",
      commands: [{ type: "set-tab", tab: "terminal" }],
      settleMs: 2_000,
      measure: codexAskMeasure,
    },
    {
      name: "90-codex-ask-after",
      what: "Back in Chat, 1 Allow clicked: main re-read the form (same fingerprint: header, parameters, labels and descriptions), sent the digit 1 alone (no Enter, never Esc), read 300 ms later and found the form gone (it took): the card says Sent: Allow in place of its options until the pane's next read takes the card away with the form",
      commands: [
        { type: "set-tab", tab: "chat" },
        { type: "click", selector: '.ncard .nc-opt[data-key="1"]' },
      ],
      settleMs: 900,
      measure: codexAskMeasure,
    },
  ];
}

/** The left list as the captures measure it (the cards gone, each needs-you row's pill and fit, folded headers' counts). */
const sidebarMeasure = `(() => {
  const text = (element) => (element?.textContent ?? "").replace(/\\s+/g, " ").trim();
  const sidebar = document.querySelector(".sb");
  const box = (element) => (element === null ? 0 : Math.round(element.getBoundingClientRect().width));
  return {
    sidebarWidth: box(sidebar),
    changesCard: document.querySelector(".sb-changes") !== null,
    awayLine: document.querySelector(".away-line") !== null,
    needsYou: [...document.querySelectorAll(".sb .row.ny")].map((row) => {
      const pill = row.querySelector(".pill");
      return {
        row: row.getAttribute("data-row"),
        text: text(row),
        pill: text(pill),
        pillColor: pill === null ? null : getComputedStyle(pill).color,
        dotColor: getComputedStyle(row.querySelector(".g")).backgroundColor,
        fits: row.scrollWidth <= row.clientWidth,
        rowWidth: box(row),
        nameWidth: box(row.querySelector(".nm")),
        pillWidth: box(pill),
        titleWidth: box(row.querySelector(".act") ?? row.querySelector(".ws2")),
        titleShown: (() => { const fit = row.querySelector(".fit"); return fit !== null && getComputedStyle(fit).display !== "none"; })(),
      };
    }),
    workingRows: [...document.querySelectorAll(".sb .row")].filter((row) => row.querySelector(".g.work") !== null).map((row) => ({ text: text(row), pill: row.querySelector(".pill") !== null })),
    foldedWithCount: [...document.querySelectorAll(".sb .ws-h")].filter((header) => header.querySelector(".nyn") !== null).map((header) => ({ text: text(header), dot: getComputedStyle(header.querySelector(".ny")).backgroundColor })),
    // The rows a folded machine keeps (its agents that need you), and whether the Needs you group is folded.
    machineRows: [...document.querySelectorAll(".sb .host-ny .row")].map((row) => ({ host: row.closest(".host")?.getAttribute("data-host") ?? null, text: text(row), pill: text(row.querySelector(".pill")), fits: row.scrollWidth <= row.clientWidth })),
    needsYouGroupFolded: (() => { const group = document.querySelector(".sb .grp"); return group !== null && group.querySelector(".row") === null; })(),
  };
})()`;

/** Quartz's header on the Mac mini (w2: Notes Fable, done; Notes Opus, which needs you). */
const quartzHeader = (macMini: string): string => `.host[data-host="${macMini}"] .ws-hw[data-ws="w2"]`;

/** Scrolls the left list so an element is at its top (the list keeps where the earlier captures left it). */
const scrollListTo = (selector: string): string =>
  `(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (element !== null) element.scrollIntoView({ block: "start" }); })()`;

/**
 * The left list without the Changes and While you were away cards (84; View > While You Were Away and
 * View > What Each Agent Changed open their screens) and agents that need you with T3's pill beside the working ones
 * (85). main.ts takes these two after send's 44 and before the needs-card captures answer anything, so the demo's
 * dialogs are as they start: Notes Opus's Edit (Mac mini w2:p70) and beacon's Bash (build-box w1:p1) read as approvals
 * (Pending Approval), bookshop's question the matcher does not read (build-box w1:p2) as Awaiting Input. Dev
 * (herdr-companion, w7:p1) works.
 */
export function sidebarCaptureSteps(ids: { macMini: string; buildBox: string }): CaptureStep[] {
  return [
    {
      name: "84-sidebar-no-cards",
      what: "Projects, nothing selected, both machines open, the list at its top: New agent, New workspace, then the Needs you group (beacon and Notes Opus Pending Approval, bookshop Awaiting Input); no Changes card, no While you were away line (View > While You Were Away and View > What Each Agent Changed open them)",
      commands: [
        { type: "show-away", shown: false },
        { type: "set-changes-overview", shown: false },
        { type: "search", query: null },
        { type: "set-host-folded", hostId: ids.macMini, folded: false },
        { type: "set-host-folded", hostId: ids.buildBox, folded: false },
        { type: "clear-selection" },
        // A mode change puts the list back at its top (as 39 does).
        { type: "set-mode", mode: "priority" },
        { type: "set-mode", mode: "projects" },
      ],
      settleMs: 2_000,
      measure: sidebarMeasure,
    },
    {
      name: "85-needs-you-row",
      what: "Dev (working) open; the list at Quartz: Notes Opus needs you, T3's amber dot and Pending Approval (its Edit) beside Notes Fable (done); under it herdr-companion's working rows keep their spinner and title, no pill",
      commands: [{ type: "select-pane", hostId: ids.macMini, paneId: "w7:p1" }],
      page: [scrollListTo(quartzHeader(ids.macMini))],
      settleMs: 2_500,
      measure: sidebarMeasure,
    },
  ];
}

/**
 * A folded project keeps its agent that needs you (86), taken last. 61 leaves its rename field on
 * Quartz's header, so the field is closed (its Esc cancels it, nothing sent) before the header is clicked. By then
 * Notes Opus's Edit was answered (47) and its next question reads as Awaiting Input. Then both
 * machines folded and the Needs you group folded too: each machine keeps its agents that need you under its header (87).
 */
export function sidebarFoldedCaptureSteps(ids: { macMini: string; buildBox: string }): CaptureStep[] {
  return [
    {
      name: "86-folded-needs",
      what: "Quartz folded (its header clicked): Notes Opus, which needs you, stays under it with its pill (Awaiting Input: its next question, after 47's answer); Notes Fable (done) is folded away; the header shows the amber dot and 1 beside its 2 panes",
      commands: [{ type: "set-mode", mode: "projects" }],
      page: [
        // Its Esc (the window is shown without focus, so a blur would not reach it).
        `document.querySelectorAll(".sb .rn-in").forEach((field) => field.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })))`,
        `document.querySelector(${JSON.stringify(`${quartzHeader(ids.macMini)} .ws-h`)})?.click()`,
        scrollListTo(quartzHeader(ids.macMini)),
      ],
      settleMs: 1_500,
      measure: sidebarMeasure,
    },
    {
      name: "87-folded-machine-needs",
      what: "Both machines folded and the Needs you group folded too: each machine keeps its agent that needs you under its header (Mac mini's Notes Opus in Quartz, build-box's bookshop in clients), each with its pill and project; their other rows stay folded",
      commands: [
        { type: "set-host-folded", hostId: ids.macMini, folded: true },
        { type: "set-host-folded", hostId: ids.buildBox, folded: true },
        // A mode change puts the list back at its top (as 39 does).
        { type: "set-mode", mode: "priority" },
        { type: "set-mode", mode: "projects" },
      ],
      // The Needs you group folded (its header clicked while it shows rows).
      page: [`(() => { const group = document.querySelector(".sb .grp"); if (group !== null && group.querySelector(".row") !== null) group.querySelector(".grp-h")?.click(); })()`],
      settleMs: 1_500,
      measure: sidebarMeasure,
    },
  ];
}

/** The chips' labels, the Permissions chip's icon and word, and its menu (each mode's word, words and icon, the ticked one). */
const modesMeasure = `(() => {
  const chip = document.querySelector(".cmp-bar .chip.pick.mode");
  const chips = [...document.querySelectorAll(".cmp-bar .chip.pick .pick-b")].map((b) => b.getAttribute("aria-label"));
  const menu = [...document.querySelectorAll(".chip-menu.modes [role=menuitemradio]")].map((e) => ({
    label: e.querySelector(".l")?.firstChild?.textContent ?? "",
    description: e.querySelector(".ds")?.textContent ?? "",
    icon: e.querySelector(".mi")?.getAttribute("data-mode-icon") ?? null,
    ticked: e.getAttribute("aria-checked") === "true",
    disabled: e.getAttribute("aria-disabled") === "true",
  }));
  const rect = chip?.getBoundingClientRect();
  return {
    chips,
    mode: chip === null ? null : { icon: chip.querySelector(".mi")?.getAttribute("data-mode-icon") ?? null, word: chip.querySelector(".ct")?.textContent ?? null, width: rect === undefined ? null : Math.round(rect.width) },
    group: document.querySelector(".chip-menu.modes .chip-g")?.textContent ?? null,
    menu,
  };
})()`;

/**
 * Steps 91-96, after the sidebar's 86-87: the Permissions chip beside Model and Effort on each of the Mac
 * mini's agents, its word read the agent's own way (Claude Code's footer row,
 * Grok's border, Cursor's model row, Codex's rollout turn_context); Codex's
 * menu open (its four presets with their words, the current one ticked);
 * then Approve for me picked: main typed /permissions into the demo Codex
 * pane, read it back, Enter, read its list, pressed 2 alone and read Codex's
 * history row, so the chip shows what the screen says.
 */
export function modesCaptureSteps(ids: { macMini: string }): CaptureStep[] {
  const pane = (paneId: string): CommandBody[] => [
    { type: "set-mode", mode: "projects" },
    { type: "set-host-folded", hostId: ids.macMini, folded: false },
    { type: "select-pane", hostId: ids.macMini, paneId },
    { type: "set-tab", tab: "chat" },
  ];
  return [
    {
      name: "91-mode-chip-claude",
      what: "The Claude pane's box in Chat (aurora-web-mac, zoomed out of its two-pane tab so its box has the room a word needs): the Permissions chip after Model and Effort shows sparkles and Auto, read off Claude Code's footer row (\u{23F5}\u{23F5} auto mode on); nothing picked",
      commands: [...pane("w7:p1G"), { type: "zoom-pane", hostId: ids.macMini, paneId: "w7:p1G", zoomed: true }],
      settleMs: 2_500,
      measure: modesMeasure,
    },
    {
      name: "92-mode-chip-grok",
      what: "The Grok pane's box in Chat (tidepool-narration): the Permissions chip shows the crossed shield and Always-approve, read off Grok's border (Grok 4.7 (high) \u{B7} always-approve); nothing picked",
      // 91's zoom undone first (its tab as Herdr laid it out).
      commands: [{ type: "zoom-pane", hostId: ids.macMini, paneId: "w7:p1G", zoomed: false }, ...pane("wD:pK")],
      settleMs: 2_500,
      measure: modesMeasure,
    },
    {
      name: "93-mode-chip-cursor",
      what: "The Cursor pane's box in Chat (harbor): the Permissions chip shows the lock and Supervised, Cursor's model row showing no approval word (neither Auto-review nor Run Everything on); nothing picked",
      commands: pane("wC:p1"),
      settleMs: 2_500,
      measure: modesMeasure,
    },
    {
      name: "94-mode-chip-codex",
      what: "The Codex pane's box in Chat (Atelier): the Permissions chip shows the lock and Ask for approval, from its rollout's newest turn_context (on-request, workspace-write, reviewer user: Codex's own preset); nothing picked",
      commands: pane("w5:pH"),
      settleMs: 2_500,
      measure: modesMeasure,
    },
    {
      name: "95-mode-menu-codex",
      what: "The Codex Permissions chip's menu (opening it types nothing): Ask for approval (ticked), Approve for me, Full Access, Read Only, each with Codex's own words under it and its icon",
      commands: [{ type: "click", selector: ".cmp-bar .chip.pick.mode .pick-b" }],
      settleMs: 800,
      measure: modesMeasure,
    },
    {
      name: "96-mode-pick-codex",
      what: "Approve for me picked: main typed /permissions into the demo Codex pane and read it back twice, Enter, read its list (Ask for approval current), pressed 2 alone and read Codex's history row (\u{2022} Permission selection requested: Approve for me); the chip shows sparkles and Approve for me",
      commands: [{ type: "click", selector: ".chip-menu.modes button[role=menuitemradio]:nth-of-type(2)" }],
      settleMs: 3_000,
      measure: modesMeasure,
    },
  ];
}

/** What the host-key captures show: the dialog's text, and each machine's error with its Try again. */
const hostKeyMeasure = `(() => {
  const dialog = document.querySelector(".dlg.hostkey");
  const errors = [...document.querySelectorAll(".host-err")].map((node) => ({
    text: node.textContent,
    retry: node.querySelector(".host-retry") !== null,
  }));
  return { dialog: dialog === null ? null : dialog.innerText, errors };
})()`;

/**
 * A machine seen for the first time (`hostId`,
 * demo-new-key.ts, added by `ask` in main) asks "Trust this Mac?" (97); Cancel
 * stores nothing and leaves it waiting for Try again, scrolled into view (98).
 * Neither writes a pin. Last.
 */
export function hostKeyCaptureSteps(hostId: string, ask: () => Promise<void>): CaptureStep[] {
  const row = JSON.stringify(`.host[data-host="${hostId}"]`);
  return [
    {
      name: "97-host-key-question",
      what: "Studio Mac's first connection stopped at its host key (nothing sent, nothing pinned): Trust this Mac? shows the machine and its address, the key type ED25519, its SHA256 fingerprint and the line that prints it on the Mac (ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub); Cancel has the focus, Trust and connect beside it",
      before: ask,
      commands: [
        { type: "set-mode", mode: "projects" },
        { type: "clear-selection" },
      ],
      settleMs: 1_500,
      measure: hostKeyMeasure,
    },
    {
      name: "98-host-key-cancelled",
      what: "Cancel pressed: nothing stored or sent; Studio Mac stays offline with its reason (Not connected: this Mac's host key was not trusted. Nothing was sent or saved.) and Try again beside it",
      commands: [{ type: "click", selector: ".dlg.hostkey .df .btn:not(.pri)" }],
      // The machine is last in the list: once its Try again is there, scroll it into view.
      page: [
        `(async () => {
          const retry = () => document.querySelector(${row})?.querySelector(".host-retry") ?? null;
          for (let tries = 0; tries < 40 && retry() === null; tries += 1) await new Promise((done) => setTimeout(done, 50));
          document.querySelector(${row})?.scrollIntoView({ block: "end" });
        })()`,
      ],
      settleMs: 1_500,
      measure: hostKeyMeasure,
    },
  ];
}

/** The machines' order, and This Mac's header, note, error and workspaces as the list draws them. */
const thisMacMeasure = `(() => {
  const mac = document.querySelector('.host[data-host="this-mac"]');
  const text = (node) => (node === null || node === undefined ? null : node.innerText);
  return {
    order: [...document.querySelectorAll(".host")].map((node) => node.getAttribute("data-host")),
    header: text(mac?.querySelector(".host-h")),
    note: text(mac?.querySelector(".host-note")),
    error: text(mac?.querySelector(".host-err")),
    workspaces: [...(mac?.querySelectorAll(".ws-h") ?? [])].map((node) => node.innerText),
    rows: mac?.querySelectorAll("[data-row]").length ?? 0,
  };
})()`;

/**
 * The list at its top with This Mac open. The selection is left as it is
 * (83's), as 86 that follows draws with it; Away, the Changes overview and
 * search are already off there (84 turned them off), so these change nothing
 * the next captures see.
 */
const thisMacListCommands: readonly CommandBody[] = [
  { type: "show-away", shown: false },
  { type: "set-changes-overview", shown: false },
  { type: "search", query: null },
  { type: "set-host-folded", hostId: "this-mac", folded: false },
  { type: "set-mode", mode: "priority" },
  { type: "set-mode", mode: "projects" },
];

/**
 * This Mac in the machines list, placed by main (`place`) on the
 * capture's fake-herdr fixture (this-mac-fixture.ts), never this Mac's own
 * Herdr: found (99: the fake herdr on its PATH and its socket served, so it
 * sits first with its workspace), then not running (100: neither, so it reads
 * "Herdr is not running on this Mac" with the hint, as a note). They run
 * before 86-87 (the host key's 97-98 stay last), and This Mac is taken out
 * again after 100 (`place("gone")`), so the demo captures after them are as
 * they were.
 */
export function thisMacCaptureSteps(place: (state: "found" | "missing" | "gone") => Promise<void>): CaptureStep[] {
  return [
    {
      name: "99-this-mac",
      what: "This Mac first in the machines list, no address and no sign-in, its Herdr found through the login shell (the capture's fake herdr and socket): its herdr-companion workspace with a working Claude Code pane and a shell, above the demo machines",
      before: () => place("found"),
      commands: thisMacListCommands,
      settleMs: 2_000,
      measure: thisMacMeasure,
    },
    {
      name: "100-this-mac-not-running",
      what: "herdr does not resolve and there is no socket: beside the demo machines This Mac is left out of the sidebar (no header, no card, nothing in its place) until its next look finds Herdr; alone (a first run) it would stay first with its note and hint",
      before: () => place("missing"),
      commands: thisMacListCommands,
      settleMs: 2_000,
      measure: thisMacMeasure,
      afterCapture: () => place("gone"),
    },
  ];
}

/**
 * The sidebar's width and what each row shows of its names: the sidebar's, the main pane's and
 * the window's widths, the width kept (adari.sidebar.width), the edge (its cursor), each machine header's name
 * (whole or cut) and badges, and each row's name and second text (whole or cut) with its tooltip.
 */
const sidebarWidthMeasure = `(() => {
  const text = (element) => (element?.textContent ?? "").replace(/\\s+/g, " ").trim();
  const box = (element) => (element === null || element === undefined ? 0 : Math.round(element.getBoundingClientRect().width));
  const cut = (element) => element !== null && element !== undefined && element.scrollWidth > element.clientWidth;
  const shown = (element) => element !== null && element !== undefined && element.getClientRects().length > 0 && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().bottom <= (element.closest(".host-h")?.getBoundingClientRect().bottom ?? Infinity);
  const rail = document.querySelector(".sb-rail");
  const rows = [...document.querySelectorAll(".sb .host [data-row]")].map((row) => {
    const name = row.querySelector(".nm");
    const second = row.querySelector(".act, .ws2");
    return { row: row.getAttribute("data-row"), name: text(name), nameCut: cut(name), nameWidth: box(name), second: text(second), secondWidth: box(second), title: row.getAttribute("title") };
  });
  return {
    sidebarWidth: box(document.querySelector(".sb")),
    mainWidth: box(document.querySelector(".main")),
    windowWidth: window.innerWidth,
    kept: localStorage.getItem("adari.sidebar.width"),
    edge: rail === null ? null : { cursor: getComputedStyle(rail).cursor, width: box(rail), title: rail.getAttribute("title") },
    hosts: [...document.querySelectorAll(".sb .host")].map((host) => {
      const header = host.querySelector(".host-h");
      const name = header?.querySelector(".hn");
      return {
        host: host.getAttribute("data-host"),
        name: text(name),
        nameCut: cut(name),
        badges: [...(header?.querySelectorAll(".pf, .hs, .pc") ?? [])].map((badge) => ({ text: text(badge), shown: shown(badge), cut: cut(badge) })),
        title: header?.getAttribute("title") ?? null,
      };
    }),
    rowsCut: rows.filter((row) => row.nameCut).length,
    rows,
    // A local machine's header (This Mac, macOS, Not running, 19 panes) and an offline machine's, each laid out by the page's own
    // style sheet at this width: a copy of the first machine's header given those badges, measured, then taken out.
    headerProbes: [
      ["This Mac", "macOS", "Not running", false, "19 panes"],
      ["Mac mini", "macOS", "Offline · last known", true, "19 panes"],
    ].map(([label, platform, status, dot, count]) => {
      const original = document.querySelector(".sb .host .host-h");
      if (original === null) return null;
      const probe = original.cloneNode(true);
      probe.removeAttribute("title");
      probe.querySelector(".hn").textContent = label;
      const pf = probe.querySelector(".pf");
      if (pf !== null) pf.textContent = platform;
      const make = (tag, className, words) => { const e = document.createElement(tag); e.className = className; if (words !== null) e.textContent = words; return e; };
      const badges = [make("span", "hs", status), ...(dot ? [make("i", "ny", null)] : []), make("span", "pc", count)];
      const holder = probe.querySelector(".hb");
      if (holder !== null) {
        probe.querySelector(".hg")?.remove();
        const group = make("span", "hg", null);
        badges.forEach((badge) => group.appendChild(badge));
        holder.prepend(group);
      } else {
        probe.querySelectorAll(".hs, .ny, .pc").forEach((e) => e.remove());
        const chev = probe.querySelector(".chev");
        badges.forEach((badge) => probe.insertBefore(badge, chev));
      }
      original.parentElement.appendChild(probe);
      const name = probe.querySelector(".hn");
      const measured = {
        header: [label, platform, status, count].join(" · "),
        name: text(name),
        nameCut: cut(name),
        nameWidth: box(name),
        badges: [...probe.querySelectorAll(".pf, .hs, .pc")].map((badge) => ({ text: text(badge), shown: shown(badge), cut: cut(badge), width: box(badge) })),
      };
      probe.remove();
      return measured;
    }),
  };
})()`;

/** The list at its top in Projects (a mode change puts it there, as 39 does); the selection and folds as they are. */
const sidebarTopCommands: readonly CommandBody[] = [
  { type: "show-away", shown: false },
  { type: "set-changes-overview", shown: false },
  { type: "search", query: null },
  { type: "set-mode", mode: "priority" },
  { type: "set-mode", mode: "projects" },
];

/**
 * Steps 101-105, after This Mac's 99-100 and before the sidebar's 86-87: the sidebar at its default
 * width with the demo's long agent names (101); its right edge dragged with the real mouse to 440 px, the width
 * kept (102); dragged far left, it stops at its minimum (103); far right, it stops where the main pane keeps its
 * own minimum (104); a double-click on the edge puts it back to 288 px and keeps nothing (105), so 86-98 draw as
 * before. 103 folds both machines (their headers' badges at the narrowest) and 104 opens them again; the
 * selection is left as it is (86 draws with 83's selection).
 */
export function sidebarWidthCaptureSteps(ids: { macMini: string; buildBox: string }): CaptureStep[] {
  return [
    {
      name: "101-sidebar-names",
      what: "The sidebar at its default 288 px, Projects, the list at its top: each machine's name whole before its platform and status; a long agent name (aurora-web-design-system-refresh · opus) keeps the row before its second text, cut with an ellipsis only where the row runs out, and whole in the row's tooltip",
      commands: sidebarTopCommands,
      settleMs: 1_500,
      measure: sidebarWidthMeasure,
    },
    {
      name: "102-sidebar-wide",
      what: "The sidebar's right edge dragged 152 px to the right with the mouse: 440 px, kept for the next launch (adari.sidebar.width); the long agent names whole, the main pane narrower",
      commands: [],
      edge: { dragBy: 152 },
      settleMs: 1_200,
      measure: sidebarWidthMeasure,
    },
    {
      name: "103-sidebar-min",
      what: "The edge dragged 400 px to the left: the sidebar stops at its minimum, 256 px; both machines folded, so their headers carry the needs-you dot and the pane count beside the platform, the names whole",
      commands: [
        { type: "set-host-folded", hostId: ids.macMini, folded: true },
        { type: "set-host-folded", hostId: ids.buildBox, folded: true },
      ],
      edge: { dragBy: -400 },
      settleMs: 1_200,
      measure: sidebarWidthMeasure,
    },
    {
      name: "104-sidebar-main-min",
      what: "Both machines open again, and the edge dragged 1000 px to the right: the sidebar stops where the main pane keeps its minimum, 552 px (888 px in a 1440 px window)",
      commands: [
        { type: "set-host-folded", hostId: ids.macMini, folded: false },
        { type: "set-host-folded", hostId: ids.buildBox, folded: false },
      ],
      edge: { dragBy: 1_000 },
      settleMs: 1_200,
      measure: sidebarWidthMeasure,
    },
    {
      name: "105-sidebar-reset",
      what: "A double-click on the edge: back to the default 288 px, nothing kept",
      commands: [],
      edge: { doubleClick: true },
      settleMs: 1_200,
      measure: sidebarWidthMeasure,
    },
  ];
}

/**
 * A text field of the page given `text` as the user's typing would (React reads the input event), focused;
 * with `enter`, then Return.
 */
function typeIntoField(selector: string, text: string, enter = false): string {
  return `(async () => {
    for (let tries = 0; tries < 60 && document.querySelector(${JSON.stringify(selector)})?.disabled !== false; tries += 1) await new Promise((done) => setTimeout(done, 50));
    const field = document.querySelector(${JSON.stringify(selector)});
    if (field === null) return false;
    field.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(field, ${JSON.stringify(text)});
    field.dispatchEvent(new Event("input", { bubbles: true }));
    if (${enter}) field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await new Promise((done) => setTimeout(done, 400));
    return true;
  })()`;
}

/** The element's rectangle in the window, `pad` points around it (within the window). */
async function cropRect(window: BrowserWindow, crop: NonNullable<CaptureStep["crop"]>): Promise<{ x: number; y: number; width: number; height: number } | undefined> {
  const rect = (await window.webContents.executeJavaScript(
    `(() => { const r = document.querySelector(${JSON.stringify(crop.selector)})?.getBoundingClientRect(); return r ? { x: r.left, y: r.top, width: r.width, height: r.height, w: window.innerWidth, h: window.innerHeight } : null; })()`,
    true,
  )) as { x: number; y: number; width: number; height: number; w: number; h: number } | null;
  if (rect === null) return undefined;
  const x = Math.max(0, Math.floor(rect.x - crop.pad));
  const y = Math.max(0, Math.floor(rect.y - crop.pad));
  return { x, y, width: Math.min(rect.w - x, Math.ceil(rect.width + 2 * crop.pad)), height: Math.min(rect.h - y, Math.ceil(rect.height + 2 * crop.pad)) };
}

/** What a Settings capture shows, measured: its section, where it sits, and nothing cut off sideways. */
const settingsMeasure = `(() => {
  const page = document.querySelector(".settings-page");
  const box = (node) => { const r = node?.getBoundingClientRect(); return r ? { left: Math.round(r.left), width: Math.round(r.width), height: Math.round(r.height) } : null; };
  const scroll = page?.querySelector(".set-scroll");
  return {
    open: page !== null,
    section: page?.getAttribute("data-section") ?? null,
    window: { width: window.innerWidth, height: window.innerHeight },
    sidebar: box(document.querySelector(".sb")),
    page: box(page),
    nav: box(page?.querySelector(".set-nav")),
    overflowsSideways: scroll ? scroll.scrollWidth > scroll.clientWidth + 1 : null,
    paneHidden: [...document.querySelectorAll(".app > .main")].every((node) => getComputedStyle(node).visibility === "hidden"),
    footerButton: document.querySelector("[data-settings-button]")?.className ?? null,
    focused: document.activeElement?.getAttribute("data-section") ?? document.activeElement?.getAttribute("data-start-input") ?? document.activeElement?.tagName ?? null,
    // The column's width and place (T3 Code's readable width, centred), and what the page says.
    column: box(page?.querySelector(".set-col")),
    actionsRight: [...(page?.querySelectorAll(".set-rc") ?? [])].map((node) => Math.round(node.getBoundingClientRect().right)),
    fields: [...(page?.querySelectorAll("[data-start-input]") ?? [])].map((node) => ({ field: node.getAttribute("data-start-input"), value: node.value, invalid: node.getAttribute("aria-invalid") === "true", disabled: node.disabled })),
    text: page?.querySelector(".set-col")?.innerText ?? null,
  };
})()`;

/**
 * What the drawer captures show: the pane switch's words, the drawer's shells and note,
 * and the sidebar: the drawer's shells drawn as rows there (none: they live in the drawer only), the rows of
 * their workspace, and the footer's agent count.
 */
const terminalDrawerMeasure = `(() => {
  const text = (node) => (node === null || node === undefined ? null : node.innerText);
  const drawer = document.querySelector(".tdr");
  const shells = drawer === null ? [] : [...drawer.querySelectorAll(".tdr-tab")].map((node) => node.getAttribute("data-shell"));
  const rows = [...document.querySelectorAll(".sb [data-row]")].map((node) => ({ key: node.getAttribute("data-row"), name: node.innerText.split("\\n")[0] }));
  const workspace = shells.length === 0 ? null : "/" + shells[0].split(":")[0] + ":";
  return {
    sidebar: {
      shellRows: rows.filter((row) => shells.some((pane) => row.key.endsWith("/" + pane))).map((row) => row.key),
      workspaceRows: workspace === null ? [] : rows.filter((row) => row.key.includes(workspace)),
      agents: text(document.querySelector(".sb-foot .ag")),
    },
    switch: [...document.querySelectorAll(".main .seg.sm button, .tile.focused .seg button")].map((node) => ({ label: node.getAttribute("aria-label") ?? node.innerText, title: node.getAttribute("title"), on: node.classList.contains("on") })),
    drawer: drawer === null ? null : {
      height: Math.round(drawer.getBoundingClientRect().height),
      shells: [...drawer.querySelectorAll(".tdr-tab")].map((node) => ({ label: node.innerText, pane: node.getAttribute("data-shell"), on: node.classList.contains("on") })),
      note: text(drawer.querySelector(".tdr-note-t")),
      owner: text(drawer.querySelector(".tdr-own")),
      terminal: drawer.querySelector(".term-host") !== null,
    },
  };
})()`;

/**
 * Steps 106-114 (the terminal drawer's 115-120 after them): the sidebar footer's Settings button (106, cropped), then Settings over the demo's
 * split tab (desktop work, 4 panes) at the default window size, one section each (107-112), and at the window's
 * minimum size, 840 x 620 (113; `resize` sets the window's size, and puts it back after the picture).
 * T3 Code's layout on every page; Chat with a start command being typed (108b) and saved, beside
 * one refused as the user types it (108c; `page` runs a script in the window: Mac mini's command is put back after it, so
 * every later capture starts Claude as before).
 */
export function settingsCaptureSteps(
  ids: { macMini: string; buildBox: string },
  resize: (size: { width: number; height: number } | null) => Promise<void>,
  page?: (script: string) => Promise<unknown>,
): CaptureStep[] {
  const section = (name: string, id: string, what: string, extra: Partial<CaptureStep> = {}): CaptureStep => ({
    name,
    what,
    commands: [{ type: "settings", open: true, section: id as never }],
    settleMs: 1_200,
    measure: settingsMeasure,
    ...extra,
  });
  return [
    {
      name: "106-settings-button",
      what: "The sidebar footer's Settings button (gear and word, a button; ⌘, in its tooltip), the demo's split tab shown",
      commands: [...sidebarTopCommands, { type: "select-pane", hostId: ids.macMini, paneId: "w7:pS1" }],
      settleMs: 1_500,
      crop: { selector: ".sb-foot", pad: 12 },
      measure: settingsMeasure,
    },
    section("107-settings-machines", "machines", "Settings › Machines over the split tab: one row per machine (name, status, address), the demo machines' Demo (This Mac's Built in) in the actions column where an SSH machine has Edit… and Remove…; no upload lines (they are on Uploaded images)"),
    section("108-settings-chat", "chat", "Settings › Chat: Send presses Return (on), and Start commands per machine, a field per kind (Claude Code first, then Codex, Grok Build, Cursor Agent), the stock command in grey when empty; the demo's ~/.adari/agents.json says claude"),
    section("108b-settings-chat-editing", "chat", "Settings › Chat: Mac mini's Claude Code command being typed (claude --model opus, focused, not saved yet: Return saves, Esc puts it back)", {
      page: [typeIntoField(`[data-start-input="${ids.macMini}/claude"]`, "claude --model opus")],
    }),
    section("108c-settings-chat-saved", "chat", "Settings › Chat: Return saved Mac mini's command into its ~/.adari/agents.json (Saved, used from now on); build-box's Codex field refuses codex && echo hi as the user types it (never written)", {
      page: [typeIntoField(`[data-start-input="${ids.macMini}/claude"]`, "claude --model opus", true), typeIntoField(`[data-start-input="${ids.buildBox}/codex"]`, "codex && echo hi")],
      afterCapture: async () => {
        // Mac mini's command put back (as the user would: typed, Return), so the captures after this start Claude as before.
        await page?.(typeIntoField(`[data-start-input="${ids.macMini}/claude"]`, "claude", true));
        const back = await page?.(
          `new Promise((done) => setTimeout(() => { const row = document.querySelector('[data-start="${ids.macMini}"] [data-start-kind="claude"]'); done({ value: row?.querySelector("input")?.value ?? null, status: row?.querySelector(".set-rs")?.innerText ?? null }); }, 600))`,
        );
        console.log(`108c: Mac mini's Claude Code command put back: ${JSON.stringify(back)}`);
      },
    }),
    section("109-settings-uploads", "uploads", "Settings › Uploaded images: each machine's uploads counted (Mac mini 312 files, build-box 27, from the parallel listing) with Delete now (asks first) in the actions column"),
    section("110-settings-appearance", "appearance", "Settings › Appearance: the terminal's text size as a stepper (View › Bigger Text, Smaller Text, Actual Size) and a sample"),
    section("111-settings-updates", "updates", "Settings › Updates: Adari's version, update line and Check for Updates…; Agent CLIs grouped by CLI: Claude Code (Update ready: Main on Mac mini) and Codex (Update available: trendline on build-box), each with its instruction and Resume"),
    section("112-settings-about", "about", "Settings › About: the version, the privacy line, and Open-source licenses (View licenses opens THIRD_PARTY_NOTICES.md); no list in the page"),
    section("113-settings-min", "machines", "Settings at the window's minimum size (840 x 620): the section list narrower, a row narrower than 32rem puts its actions under its words, nothing cut off sideways", {
      before: () => resize({ width: 840, height: 620 }),
      afterCapture: async () => {
        await resize(null);
      },
      settleMs: 1_500,
    }),
    {
      name: "114-settings-closed",
      what: "Settings closed again (as Esc or ⌘, would): the split tab as it was, the footer button off",
      commands: [{ type: "settings", open: false }],
      settleMs: 1_200,
      measure: settingsMeasure,
    },
  ];
}

/**
 * The terminal drawer and the pane switch's
 * words, on demo machines only. The sundial Claude pane on Chat with its
 * drawer closed (115); its header's Terminal drawer button: one shell made by
 * `tab.create` in its folder, then New shell a second (116); the same pane on
 * its Claude Code tab (117); the Atelier Codex pane's switch (118); the meterbox
 * shell, no switch (119); the split tab's focused Claude tile with its drawer
 * (120). Last, after the Settings captures' 106-114 (so those draw as before); 115
 * closes Settings first, so it also stands alone under --capture-only.
 */
export function terminalDrawerCaptureSteps(ids: { macMini: string }): CaptureStep[] {
  const pane = (paneId: string): CommandBody[] => [
    { type: "set-mode", mode: "projects" },
    { type: "set-host-folded", hostId: ids.macMini, folded: false },
    { type: "select-pane", hostId: ids.macMini, paneId },
  ];
  const [lookChat] = demoSplitTab.chats;
  return [
    {
      name: "115-drawer-closed",
      what: "The sundial Claude pane on Chat, its drawer closed: the switch reads Chat · Claude Code · Changes, and the header has the Terminal drawer button (⌘J, View > Terminal)",
      commands: [{ type: "settings", open: false }, ...pane("w6:p1"), { type: "set-tab", tab: "chat" }],
      settleMs: 2_500,
      measure: terminalDrawerMeasure,
    },
    {
      name: "116-drawer-two-shells",
      what: "The Terminal drawer button: the drawer opens along the bottom of the pane, Chat stays above it, and one shell is made by tab.create in sundial's folder (the agent's tab untouched); then New shell makes a second, its tab picked and its terminal focused. The drawer's tabs read Terminal and Terminal 2 (their Herdr tabs labelled Terminal), and neither is a sidebar row",
      commands: [{ type: "click", selector: '.main [aria-label="Terminal drawer"]' }],
      after: { afterMs: 1_500, commands: [{ type: "click", selector: '.tdr button[aria-label="New shell"]' }] },
      settleMs: 2_500,
      measure: terminalDrawerMeasure,
    },
    {
      name: "117-claude-code-tab",
      what: "The same pane on its Claude Code tab (the stored view still \"terminal\"): Claude Code's own screen above, the drawer and its two shells below",
      commands: [{ type: "set-tab", tab: "terminal" }],
      settleMs: 2_000,
      measure: terminalDrawerMeasure,
    },
    {
      name: "118-codex-switch",
      what: "The Atelier Codex pane: its switch reads Chat · Codex · Changes (the middle tab's title: Codex's own screen); its drawer is its own, closed",
      commands: [...pane("w5:pH"), { type: "set-tab", tab: "chat" }],
      settleMs: 2_500,
      measure: terminalDrawerMeasure,
    },
    {
      name: "119-shell-no-switch",
      what: "The meterbox shell pane: its terminal with no switch and no drawer button; its message box and the rest as on any shell pane",
      commands: pane("w8:p1"),
      settleMs: 2_000,
      measure: terminalDrawerMeasure,
    },
    {
      name: "120-drawer-split",
      what: "The split tab, the aurora-web-look Claude tile focused: its tile's Terminal drawer button opens the focused tile's drawer under the tiles, named by the tile (1 · its name), with one shell made in its folder",
      commands: [...pane(lookChat), { type: "click", selector: `.tile[data-tile="${lookChat}"] [data-drawer-toggle]` }],
      settleMs: 3_000,
      measure: terminalDrawerMeasure,
    },
  ];
}

/**
 * What a ring capture shows, measured: its button's box and look, its svg's box and turn,
 * how far the svg's centre is from the button's, the card's Compact, and Chat's command rows.
 */
const ringMeasure = `(() => {
  const button = document.querySelector(".cmp-bar .ctx-ring");
  const svg = button?.querySelector("svg") ?? null;
  if (button === null || svg === null) return null;
  const box = (node) => { const r = node.getBoundingClientRect(); return { x: +r.x.toFixed(2), y: +r.y.toFixed(2), width: +r.width.toFixed(2), height: +r.height.toFixed(2) }; };
  const b = box(button);
  const s = box(svg);
  const look = getComputedStyle(button);
  const turn = getComputedStyle(svg);
  return {
    className: button.className,
    button: { ...b, display: look.display, border: look.borderTopWidth + " " + look.borderTopStyle, radius: look.borderTopLeftRadius, animation: look.animationName, transform: look.transform },
    svg: { ...s, animation: turn.animationName, transform: turn.transform, origin: turn.transformOrigin },
    svgCentreOffBy: [+(s.x + s.width / 2 - b.x - b.width / 2).toFixed(2), +(s.y + s.height / 2 - b.y - b.height / 2).toFixed(2)],
    card: document.querySelector(".ctx-card .btn")?.textContent ?? null,
    commandRows: [...document.querySelectorAll(".cmd-row .cmd")].map((node) => node.textContent),
  };
})()`;

/** The ring's turn held `ms` into it (its animations paused there), so a capture shows a known frame. */
function ringFrame(ms: number): string {
  return `(() => {
    const ring = document.querySelector(".cmp-bar .ctx-ring");
    const turning = ring === null ? [] : [ring, ...ring.querySelectorAll("*")].flatMap((node) => node.getAnimations());
    for (const animation of turning) {
      animation.pause();
      animation.currentTime = ${ms};
    }
    return turning.length;
  })()`;
}

/**
 * The ring while the pane compacts (one ring, its turn centred in its button): the
 * sundial Claude pane (Mac mini) on Chat. `/compact` typed in the box (126) and sent (127): a command row, the
 * ring as it was. Then the ring's card and its Compact (128): the ring turns until the transcript shows the
 * compaction (never, on the demo machine), held at 0, a third and two thirds of its 1.1 s turn (128-130, the card
 * closed for 129-130). Last, after the agents' 121-125; 126
 * closes Settings first, so it stands alone too.
 */
export function ringCaptureSteps(ids: { macMini: string }): CaptureStep[] {
  const ring = { selector: ".cmp-bar .ctx-ring-w", pad: 20 };
  const frame = (name: string, ms: number, what: string, commands: CommandBody[] = []): CaptureStep => ({
    name,
    what: `${what}; the ring's turn held at ${ms} ms of 1100 (cropped round the ring)`,
    commands,
    page: [ringFrame(ms)],
    settleMs: 800,
    crop: ring,
    measure: ringMeasure,
  });
  return [
    {
      name: "126-ring-typed-compact",
      what: "The sundial Claude pane (Mac mini) on Chat, /compact typed in its box, nothing sent; the ring at rest left of the paperclip (cropped to the box)",
      commands: [
        { type: "settings", open: false },
        { type: "set-mode", mode: "projects" },
        { type: "set-host-folded", hostId: ids.macMini, folded: false },
        { type: "select-pane", hostId: ids.macMini, paneId: "w6:p1" },
        { type: "set-tab", tab: "chat" },
      ],
      page: [typeDraft("/compact")],
      settleMs: 2_000,
      crop: { selector: ".cmp", pad: 8 },
      measure: ringMeasure,
    },
    {
      name: "127-ring-typed-compact-sent",
      what: "Send pressed: /compact goes as a command row in Chat; a typed command does not make the ring turn, so it stays at rest (cropped round the ring)",
      commands: [{ type: "click", selector: ".cmp-bar .send.on" }],
      settleMs: 1_500,
      crop: ring,
      measure: ringMeasure,
    },
    frame("128-ring-compacting-0", 0, "The ring's card opened and its Compact pressed (the card reads Compacting…): the ring turns while the pane compacts", [
      { type: "click", selector: ".cmp-bar .ctx-ring" },
      { type: "click", selector: ".ctx-card .btn" },
    ]),
    frame("129-ring-compacting-367", 367, "Still compacting, the card closed (the ring again)", [{ type: "click", selector: ".cmp-bar .ctx-ring" }]),
    frame("130-ring-compacting-733", 733, "Still compacting"),
  ];
}

/** What 131-133 show of the card: cardMeasure's, the tall frame's description, command rows and "N more", and (133) Chat's call's label and file. */
const tallCardMeasure = `(() => {
  const card = document.querySelector(".tile.focused .ncard") ?? document.querySelector(".ncard");
  const text = (selector) => card?.querySelector(selector)?.textContent ?? null;
  const command = card?.querySelector(".nc-run .nc-cmd")?.textContent ?? null;
  return {
    card: card?.getAttribute("data-needs-card") ?? null,
    subject: card?.getAttribute("data-subject") ?? null,
    from: text(".nc-from"),
    file: text(".nc-file"),
    header: text(".nc-t"),
    target: text(".nc-target"),
    description: text(".nc-desc"),
    commandRows: command === null ? 0 : command.split("\\n").length,
    commandMore: text(".nc-run .nc-more"),
    question: text(".nc-q"),
    options: card === null ? [] : [...card.querySelectorAll(".nc-opt")].map((b) => (b.classList.contains("on") ? "[" + b.textContent + "]" : b.textContent)),
    diffRows: card === null ? 0 : card.querySelectorAll(".nc-diff .dl:not(.more)").length,
    more: text(".nc-diff .more"),
    lines: text(".nc-lines"),
    hint: text(".nc-hint"),
  };
})()`;

/**
 * Approval frames taller than the card's first read, whose card still shows the request, not only "Do you want to
 * proceed?" and Answer in Terminal: build-box's beacon (Claude) on Chat, its screen Claude Code's approval frame
 * taller than the card's 40-line read (demo-tall.ts): a 60-line heredoc command (131) and an edit with an 81-row
 * diff (132). 133: the Mac mini's sundial pane (Claude) blocked on a 250-line command whose header
 * is above even the 200-line read, its transcript holding the same call still running: Answer in Terminal, Chat's
 * call under its label. `show` blocks the pane on its screens (and writes the running call into its transcript);
 * null puts back the screens and status it had. Last, after the ring's 126-130; each step closes Settings first,
 * so each stands alone under --capture-only.
 */
export function tallCardCaptureSteps(
  ids: { buildBox: string; macMini: string },
  show: (hostId: string, paneId: string, screens: readonly string[] | null, running?: DemoRunningCall) => Promise<void>,
): CaptureStep[] {
  const open = (hostId: string, paneId: string): CommandBody[] => [
    { type: "settings", open: false },
    { type: "set-mode", mode: "projects" },
    { type: "set-host-folded", hostId, folded: false },
    { type: "select-pane", hostId, paneId },
    { type: "set-tab", tab: "chat" },
  ];
  return [
    {
      name: "131-needs-card-tall-run",
      what: "beacon asks to run a 60-line python3 heredoc (78 screen rows): Claude wants to run, the description, the command's first 6 lines and 54 more, Do you want to proceed?, Yes and No answerable in Chat",
      before: () => show(ids.buildBox, "w1:p1", [demoTallBashScreen]),
      commands: open(ids.buildBox, "w1:p1"),
      settleMs: 5_000,
      measure: tallCardMeasure,
    },
    {
      name: "132-needs-card-tall-edit",
      what: "beacon asks to edit src/probe/summary.ts with 40 removed and 40 added rows (99 screen rows): Claude wants to edit, six diff rows and the rest as more lines, the question, its three options",
      before: () => show(ids.buildBox, "w1:p1", [demoTallEditScreen]),
      commands: open(ids.buildBox, "w1:p1"),
      settleMs: 5_000,
      measure: tallCardMeasure,
    },
    {
      name: "133-needs-card-tall-cut",
      what: "The Mac mini's sundial asks to run a 250-line command whose header is above even the 200-line read (268 screen rows), Chat's running Bash call the same command: Claude Code needs you, then under \"Chat's running call, not read from the question:\" Bash, its description, its first 6 lines and 244 more, then the screen's 4 rows and Answer in Terminal; no Yes or No",
      before: () => show(ids.macMini, "w6:p1", [demoTallCutScreen], demoTallCutCall),
      commands: open(ids.macMini, "w6:p1"),
      settleMs: 5_000,
      measure: tallCardMeasure,
      afterCapture: () => show(ids.macMini, "w6:p1", null),
    },
  ];
}

/** The reply Send to… carries in the captures (a fixture, not a transcript). */
export const demoHandoffText =
  "The sidebar now groups panes by workspace, with the ones that need you on top.\n\nRun the checks before merging:\n\n```sh\nnpm run typecheck && npm test\n```";

export interface CaptureResult {
  readonly file: string;
  readonly what: string;
  readonly width: number;
  readonly height: number;
  /** The step's measure script's answer, if it has one. */
  readonly measured?: unknown;
}

/** Runs each step and writes the window's own pixels (webContents.capturePage) as PNG files. */
/** The mouse over each point a page script gives, keys held, until a page script says it is there. */
async function movePointer(window: BrowserWindow, pointer: NonNullable<CaptureStep["pointer"]>): Promise<void> {
  const contents = window.webContents;
  const points = (await contents.executeJavaScript(pointer.points, true)) as readonly { x: number; y: number }[] | null;
  const modifiers = [...(pointer.modifiers ?? [])];
  for (const point of points ?? []) {
    const x = Math.round(point.x);
    const y = Math.round(point.y);
    contents.sendInputEvent({ type: "mouseMove", x, y, modifiers });
    await wait(70);
    if (pointer.until === undefined || (await contents.executeJavaScript(pointer.until, true)) === true) return;
  }
}

export async function runCaptures(
  window: BrowserWindow,
  commands: AppCommands,
  directory: string,
  steps: readonly CaptureStep[],
): Promise<CaptureResult[]> {
  mkdirSync(directory, { recursive: true });
  await commands.ready(30_000);
  const results: CaptureResult[] = [];
  for (const step of steps) {
    if (step.before !== undefined) await step.before();
    for (const command of step.commands) await commands.send(window.webContents, command);
    if (step.after !== undefined) {
      await wait(step.after.afterMs);
      for (const command of step.after.commands) await commands.send(window.webContents, command);
    }
    if (step.edge !== undefined) await onSidebarEdge(window, step.edge);
    for (const script of step.page ?? []) await window.webContents.executeJavaScript(script, true);
    if (step.pointer !== undefined) await movePointer(window, step.pointer);
    await wait(step.settleMs);
    const image = await window.webContents.capturePage(step.crop === undefined ? undefined : await cropRect(window, step.crop));
    const file = path.join(directory, `${step.name}.png`);
    writeFileSync(file, image.toPNG());
    const size = image.getSize();
    const measured: unknown = step.measure === undefined ? undefined : await window.webContents.executeJavaScript(step.measure, true);
    results.push({ file, what: step.what, width: size.width, height: size.height, ...(measured === undefined ? {} : { measured }) });
    if (step.afterCapture !== undefined) await step.afterCapture();
  }
  const [contentWidth, contentHeight] = window.getContentSize();
  writeFileSync(
    path.join(directory, "captures.json"),
    `${JSON.stringify({ capturedAt: new Date().toISOString(), window: { contentWidth, contentHeight }, captures: results }, null, 2)}\n`,
  );
  return results;
}

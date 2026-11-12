// The showcase shots (`--showcase-capture=<dir>`): the
// window's own pixels (webContents.capturePage, as --capture takes them) at
// 1600 x 900 points and 2x, each shot a whole story, and a 12 s clip of the
// hero streaming (frames from capturePage joined by ffmpeg into H.264). The
// window is shown without taking focus; the terminals' text is one step up.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { BrowserWindow } from "electron";

import { IPC } from "../../shared/ipc-contract";
import type { AppCommands, CommandBody } from "../capture";
import { showcaseHandoffText, showcasePaneIds as ids } from "./showcase-chat";
import { showcaseHostIds as hosts } from "./showcase-hosts";

/** The window: 1600 x 900 points, captured at 2x (3200 x 1800 pixels). */
export const showcaseWindow = { width: 1600, height: 900, scale: 2 } as const;

/** The clip: 12 s at 30 frames a second, 1600 x 900. */
export const showcaseClip = { seconds: 12, fps: 30, file: "a-hero-clip.mp4" } as const;

/** What a shot does beyond the page's commands. */
export type ShotAction = "none" | "clip" | "answer-dialog";

export interface ShowcaseShot {
  readonly name: string;
  readonly what: string;
  readonly commands: readonly CommandBody[];
  readonly settleMs: number;
  /** "clip" records the clip right after the shot; "answer-dialog" presses Return in the shown terminal first. */
  readonly action: ShotAction;
}

const { studio, gpu } = hosts;

/**
 * The shots, in the order they are taken (the live chats are newest first:
 * the hero, its clip, the working chat and the four panes come before the rest).
 */
export function showcaseShots(): ShowcaseShot[] {
  return [
    {
      name: "a-hero",
      what: "Hero: storefront's checkout tab split in two, “Add Apple Pay” in Chat streaming its turn on the left and “Fix the flaky cart test” in Terminal (Claude Code running the cart suite) on the right; the full sidebar with both machines, Needs you on top",
      commands: [
        { type: "set-mode", mode: "projects" },
        { type: "set-host-folded", hostId: studio, folded: false },
        { type: "set-host-folded", hostId: gpu, folded: false },
        { type: "select-pane", hostId: studio, paneId: ids.cart },
        { type: "set-tab", tab: "terminal" },
        { type: "select-pane", hostId: studio, paneId: ids.applePay },
        { type: "set-tab", tab: "chat" },
        { type: "set-box", shown: false },
      ],
      settleMs: 6_000,
      action: "clip",
    },
    {
      name: "b-chat-working",
      what: "Chat of a working agent mid-reply (“Faster product page”): a finished turn with a code block and a before/after table, then the running turn with folded tool rows, progress lines and the latest edit",
      commands: [
        { type: "select-pane", hostId: studio, paneId: ids.pdp },
        { type: "set-tab", tab: "chat" },
      ],
      settleMs: 3_000,
      action: "none",
    },
    {
      name: "h-four-panes",
      what: "Four panes in one tab (ios-app, release 3.2): the Live Activity agent's finished Chat and the dark-receipts Codex agent's live Chat on top, Claude Code editing the widget and Codex running the cart sheet tests in Terminal below",
      commands: [
        { type: "select-pane", hostId: studio, paneId: ids.widget },
        { type: "set-tab", tab: "terminal" },
        { type: "select-pane", hostId: studio, paneId: ids.sheet },
        { type: "set-tab", tab: "terminal" },
        { type: "select-pane", hostId: studio, paneId: ids.receipts },
        { type: "set-tab", tab: "chat" },
        { type: "select-pane", hostId: studio, paneId: ids.liveActivity },
        { type: "set-tab", tab: "chat" },
      ],
      settleMs: 5_000,
      action: "none",
    },
    {
      name: "c1-needs-you",
      what: "Needs you: “Passkeys for sign in” on gpu-box stopped at Claude Code's permission dialog (run the passkeys migration?), shown in the app's own terminal; the sidebar's Needs you group on top",
      commands: [
        { type: "select-pane", hostId: gpu, paneId: ids.passkeys },
        { type: "set-tab", tab: "terminal" },
      ],
      settleMs: 2_500,
      action: "none",
    },
    {
      name: "c2-needs-you-answered",
      what: "The dialog answered from the app (Return on “1. Yes” in its terminal): the migration runs, the tests follow, and the pane leaves Needs you for Working in the sidebar",
      commands: [],
      settleMs: 4_500,
      action: "answer-dialog",
    },
    {
      name: "d1-changes-overview",
      what: "Changes across agents: every agent on both machines, the ones with changes first, each with its folder's branch, files and commits",
      commands: [{ type: "set-changes-overview", shown: true }],
      settleMs: 3_000,
      action: "none",
    },
    {
      name: "d2-changes-diff",
      what: "From the overview, the Apple Pay agent's Changes and one file's diff (PaymentSheet.tsx, not staged): the Apple Pay button above the card form",
      commands: [
        // The overview's rows carry their machine's id first.
        { type: "open-changes-row", rowId: `${studio}|agent|${ids.applePay}` },
        { type: "open-changes-row", rowId: "git|src/checkout/PaymentSheet.tsx" },
      ],
      settleMs: 2_000,
      action: "none",
    },
    {
      name: "e-away",
      what: "While you were away: a card per agent on both machines (Needs you, Finished, Still working), each with its last reply, files and commits; the line at the top of the sidebar",
      commands: [
        { type: "set-changes-overview", shown: false },
        { type: "clear-selection" },
        { type: "show-away", shown: true },
      ],
      settleMs: 3_000,
      action: "none",
    },
    {
      name: "f1-send-to",
      what: "Send to…: the Apple Pay agent's reply about merchant validation, with every pane on both machines to send it to (agents first)",
      commands: [
        { type: "show-away", shown: false },
        { type: "select-pane", hostId: studio, paneId: ids.applePay },
        { type: "set-tab", tab: "chat" },
        { type: "open-handoff", hostId: studio, paneId: ids.applePay, text: showcaseHandoffText },
      ],
      settleMs: 1_500,
      action: "none",
    },
    {
      name: "f2-send-to-landed",
      what: "The reply landed in another agent: “Apple Pay guide” (docs) open in Chat with the reply in its message box after its From line, ready to send",
      commands: [{ type: "pick-handoff", hostId: studio, paneId: ids.guide, action: "draft" }],
      settleMs: 2_000,
      action: "none",
    },
    {
      name: "g-search",
      what: "Search across agents for “Apple Pay”: hits on both machines grouped by agent, newest first, each with who wrote it, when, and the match marked",
      commands: [{ type: "search", query: "Apple Pay" }],
      settleMs: 3_000,
      action: "none",
    },
  ];
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface ShowcaseCaptureOptions {
  readonly window: BrowserWindow;
  readonly commands: AppCommands;
  readonly directory: string;
  /** Asks every machine for a fresh snapshot (the sidebar follows a dialog answered). */
  readonly refresh: () => Promise<unknown>;
  /** ffmpeg for the clip and the contact sheet; none skips both. */
  readonly ffmpeg: string | null;
  readonly log: (line: string) => void;
}

export interface ShowcaseResult {
  readonly file: string;
  readonly what: string;
  readonly width: number;
  readonly height: number;
}

/** Runs the shots, the clip, the contact sheet and shots.md. */
export async function runShowcaseCapture(options: ShowcaseCaptureOptions): Promise<ShowcaseResult[]> {
  const { window, commands, directory, log } = options;
  mkdirSync(directory, { recursive: true });
  // 1600 x 900 points at 2x whatever the display: a 3200 x 1800 window whose page is zoomed 2x
  // (its CSS viewport stays 1600 x 900; text, canvases and the terminals draw at twice the pixels).
  window.setContentSize(showcaseWindow.width * showcaseWindow.scale, showcaseWindow.height * showcaseWindow.scale);
  await commands.ready(30_000);
  window.webContents.setZoomFactor(showcaseWindow.scale);
  // The terminals' text one step up (View > Bigger Text), so it reads on a phone.
  window.webContents.send(IPC.viewCommand, "font-bigger");
  await wait(1_500);
  const results: ShowcaseResult[] = [];
  let clip: ClipStats | null = null;
  for (const shot of showcaseShots()) {
    for (const command of shot.commands) await commands.send(window.webContents, command);
    if (shot.action === "answer-dialog") {
      for (const type of ["keyDown", "char", "keyUp"] as const) window.webContents.sendInputEvent({ type, keyCode: type === "char" ? "\r" : "Return" });
      await wait(600);
      await options.refresh();
    }
    await wait(shot.settleMs);
    const image = await window.webContents.capturePage();
    const file = path.join(directory, `${shot.name}.png`);
    writeFileSync(file, image.toPNG());
    const size = image.getSize();
    results.push({ file, what: shot.what, width: size.width, height: size.height });
    log(`shot ${shot.name} ${size.width}x${size.height}`);
    if (shot.action === "clip" && options.ffmpeg !== null) {
      clip = await recordClip(window, path.join(directory, showcaseClip.file), options.ffmpeg);
      log(`clip ${clip.unique} frames captured in ${clip.seconds.toFixed(1)} s (${clip.capturedFps.toFixed(1)} a second), written as ${clip.written} at ${showcaseClip.fps} fps`);
    }
  }
  const [contentWidth, contentHeight] = window.getContentSize();
  writeFileSync(
    path.join(directory, "captures.json"),
    `${JSON.stringify({ capturedAt: new Date().toISOString(), window: { points: { width: showcaseWindow.width, height: showcaseWindow.height }, pixels: { width: contentWidth, height: contentHeight }, zoom: window.webContents.getZoomFactor() }, shots: results, clip }, null, 2)}\n`,
  );
  writeFileSync(path.join(directory, "shots.md"), shotsMarkdown(results, clip));
  if (options.ffmpeg !== null) await contactSheet(options.ffmpeg, directory);
  return results;
}

export interface ClipStats {
  readonly file: string;
  readonly seconds: number;
  /** Distinct frames capturePage gave in the time. */
  readonly unique: number;
  readonly capturedFps: number;
  /** Frames written at 30 a second (a slot with no new frame repeats the last). */
  readonly written: number;
}

/** 12 s of the window: capturePage as fast as it answers, each 1/30 s slot given the newest frame, piped to ffmpeg. */
async function recordClip(window: BrowserWindow, file: string, ffmpeg: string): Promise<ClipStats> {
  const contents = window.webContents;
  // The capture look stills the spinners; the clip shows them moving.
  await contents.executeJavaScript("document.body.classList.remove('capturing')");
  const frames: { at: number; jpeg: Buffer }[] = [];
  const start = performance.now();
  const lengthMs = showcaseClip.seconds * 1000;
  while (performance.now() - start < lengthMs) {
    const asked = performance.now();
    const image = await contents.capturePage();
    const at = (asked + performance.now()) / 2 - start;
    frames.push({ at, jpeg: image.toJPEG(92) });
  }
  await contents.executeJavaScript("document.body.classList.add('capturing')");
  const slots = showcaseClip.seconds * showcaseClip.fps;
  const encoder = spawn(
    ffmpeg,
    [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "image2pipe", "-framerate", String(showcaseClip.fps), "-c:v", "mjpeg", "-i", "-",
      "-vf", `scale=${showcaseWindow.width}:${showcaseWindow.height}:flags=lanczos`,
      "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
      "-r", String(showcaseClip.fps),
      file,
    ],
    { stdio: ["pipe", "ignore", "pipe"] },
  );
  let errors = "";
  encoder.stderr.on("data", (chunk: Buffer) => (errors += chunk.toString("utf8")));
  const done = new Promise<number>((resolve) => encoder.on("close", (code) => resolve(code ?? 1)));
  let index = 0;
  for (let slot = 0; slot < slots; slot += 1) {
    const time = (slot * 1000) / showcaseClip.fps;
    while (index + 1 < frames.length && frames[index + 1]!.at <= time) index += 1;
    if (!encoder.stdin.write(frames[index]!.jpeg)) await new Promise((resolve) => encoder.stdin.once("drain", resolve));
  }
  encoder.stdin.end();
  const code = await done;
  if (code !== 0) throw new Error(`ffmpeg exited ${code}: ${errors.trim()}`);
  const seconds = (frames.at(-1)?.at ?? 0) / 1000;
  return { file, seconds: showcaseClip.seconds, unique: frames.length, capturedFps: frames.length / Math.max(1, seconds), written: slots };
}

/** The shots side by side, four to a row, 800 x 450 each. */
async function contactSheet(ffmpeg: string, directory: string): Promise<void> {
  const shots = readdirSync(directory)
    .filter((name) => /^[a-h]\d?-.*\.png$/.test(name))
    .sort();
  if (shots.length === 0) return;
  const columns = 4;
  const rows = Math.ceil(shots.length / columns);
  const inputs = shots.flatMap((name) => ["-i", path.join(directory, name)]);
  const scaled = shots.map((_, i) => `[${i}:v]scale=800:450:flags=lanczos,pad=816:466:8:8:color=0x0b0b0c[s${i}]`).join(";");
  const layout = shots.map((_, i) => `${(i % columns) * 816}_${Math.floor(i / columns) * 466}`).join("|");
  const graph = `${scaled};${shots.map((_, i) => `[s${i}]`).join("")}xstack=inputs=${shots.length}:layout=${layout}:fill=0x0b0b0c[out]`;
  const code = await new Promise<number>((resolve) => {
    const child = spawn(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", ...inputs, "-filter_complex", graph, "-map", "[out]", "-frames:v", "1", path.join(directory, "contact.png")], { stdio: "ignore" });
    child.on("close", (exit) => resolve(exit ?? 1));
  });
  if (code !== 0) throw new Error(`ffmpeg could not make the contact sheet (exit ${code}); ${rows} rows of ${columns}`);
}

function shotsMarkdown(results: readonly ShowcaseResult[], clip: ClipStats | null): string {
  const lines = ["# Adari desktop showcase: the shots", "", "1600 x 900 points at 2x (3200 x 1800 pixels), dark; the invented setup (`--showcase`).", ""];
  for (const result of [...results].sort((a, b) => path.basename(a.file).localeCompare(path.basename(b.file)))) {
    lines.push(`- \`${path.basename(result.file)}\` (${result.width}x${result.height}): ${result.what}`);
  }
  if (clip !== null) {
    lines.push(
      `- \`${path.basename(clip.file)}\` (1600x900, H.264, ${showcaseClip.seconds} s at ${showcaseClip.fps} fps): the hero streaming; capturePage gave ${clip.unique} distinct frames in ${clip.seconds} s (${clip.capturedFps.toFixed(1)} a second), each 1/30 s slot shows the newest`,
    );
  }
  lines.push("- `contact.png`: every shot, four to a row, in file order", "");
  return lines.join("\n");
}

/** ffmpeg where Homebrew puts it (or HERDR_FFMPEG), null when there is none. */
export function findFfmpeg(env: NodeJS.ProcessEnv = process.env): string | null {
  const candidate = env["HERDR_FFMPEG"] ?? "/opt/homebrew/bin/ffmpeg";
  return existsSync(candidate) ? candidate : null;
}

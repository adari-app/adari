// The flicker probe (--flicker-probe=<dir>, in demo
// mode): a working Claude pane whose demo transcript keeps landing (a step every
// 1.4 s: its live tool row, the Working line ticking, the ring and chips
// re-reading), zoomed so its Chat has the floating box.
// For a few seconds the page samples the box on every animation frame (its
// DOM node, its height, the textarea's height, the chat's bottom inset, the
// ring's level and fill, the chips' text) and records every DOM change inside
// the box, while the main process takes a burst of webContents.capturePage
// frames of the box's rectangle and diffs each with the one before. Nothing
// the user does changes the box in that time, so any change is the flicker. Off in the
// packaged app: its flag is ignored there and the runner refuses.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { app, contentTracing, type BrowserWindow } from "electron";

import type { AppCommands, CommandBody } from "./capture";

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The page's side: samples per animation frame and DOM changes inside the box, kept on window.__flicker. */
const instrument = `(() => {
  const wrap = document.querySelector('.cmp-wrap');
  const cmp = document.querySelector('.cmp');
  const textarea = cmp && cmp.querySelector('textarea');
  if (!wrap || !cmp || !textarea) return 'no box';
  const describe = (node) => {
    const el = node.nodeType === 1 ? node : node.parentElement;
    if (!el) return '?';
    const cls = typeof el.className === 'string' ? el.className : (el.getAttribute && el.getAttribute('class')) || '';
    return el.tagName.toLowerCase() + (cls ? '.' + cls.trim().split(/\\s+/).join('.') : '');
  };
  const state = { samples: [], mutations: [], start: performance.now(), wrap, cmp, textarea, running: true };
  window.__flicker = state;
  const observer = new MutationObserver((records) => {
    for (const r of records) {
      state.mutations.push({
        t: Math.round(performance.now() - state.start),
        type: r.type,
        target: describe(r.target),
        attribute: r.attributeName || null,
        old: r.oldValue === null ? null : String(r.oldValue).slice(0, 120),
        now: r.type === 'attributes' ? String(r.target.getAttribute(r.attributeName)).slice(0, 120) : r.type === 'characterData' ? String(r.target.data).slice(0, 120) : null,
        added: r.addedNodes.length,
        removed: r.removedNodes.length,
      });
    }
  });
  observer.observe(wrap, { subtree: true, attributes: true, attributeOldValue: true, childList: true, characterData: true, characterDataOldValue: true });
  const inset = () => { const el = document.querySelector('.chat-area .chat-inset'); return el ? el.style.height : null; };
  const sample = () => {
    if (!state.running) return;
    const ring = document.querySelector('.cmp .ctx-ring');
    const fill = document.querySelector('.cmp .ctx-ring .fill');
    state.samples.push({
      t: Math.round(performance.now() - state.start),
      sameBox: document.querySelector('.cmp') === cmp && document.querySelector('.cmp-wrap') === wrap && cmp.querySelector('textarea') === textarea,
      wrapHeight: wrap.offsetHeight,
      boxTop: Math.round(cmp.getBoundingClientRect().top * 10) / 10,
      textareaHeight: textarea.style.height,
      inset: inset(),
      ring: ring ? ring.getAttribute('class') : null,
      fill: fill ? fill.getAttribute('stroke-dasharray') : null,
      chips: Array.from(document.querySelectorAll('.cmp .cmp-bar .chip')).map((c) => c.textContent).join(' | '),
      working: (document.querySelector('.chat-area .working-t') || {}).textContent || null,
    });
    requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
  const r = cmp.getBoundingClientRect();
  return JSON.stringify({ x: Math.floor(r.left), y: Math.floor(r.top), width: Math.ceil(r.width), height: Math.ceil(r.height) });
})()`;

const collect = `(() => { const s = window.__flicker; s.running = false; return JSON.stringify({ samples: s.samples, mutations: s.mutations }); })()`;

interface Sample {
  readonly t: number;
  readonly sameBox: boolean;
  readonly wrapHeight: number;
  readonly boxTop: number;
  readonly textareaHeight: string;
  readonly inset: string | null;
  readonly ring: string | null;
  readonly fill: string | null;
  readonly chips: string;
  readonly working: string | null;
}

interface Mutation {
  readonly t: number;
  readonly type: string;
  readonly target: string;
  readonly attribute: string | null;
  readonly old: string | null;
  readonly now: string | null;
  readonly added: number;
  readonly removed: number;
}

/** How many runs of equal values a sampled field has, and the values seen. */
function changes<T>(samples: readonly Sample[], pick: (sample: Sample) => T): { readonly changes: number; readonly values: T[] } {
  let count = 0;
  const values: T[] = [];
  samples.forEach((sample, index) => {
    const value = pick(sample);
    if (!values.some((seen) => JSON.stringify(seen) === JSON.stringify(value))) values.push(value);
    if (index > 0 && JSON.stringify(value) !== JSON.stringify(pick(samples[index - 1]!))) count += 1;
  });
  return { changes: count, values: values.slice(0, 12) };
}

export interface FrameDiff {
  readonly index: number;
  readonly atMs: number;
  /** Pixels of the box whose colour moved by more than 6 on any channel since the frame before. */
  readonly changedPixels: number;
  readonly maxDelta: number;
}

/** Pixels changed between two BGRA bitmaps of the same size. */
export function diffBitmaps(a: Uint8Array, b: Uint8Array): { changedPixels: number; maxDelta: number } {
  let changedPixels = 0;
  let maxDelta = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i + 3 < length; i += 4) {
    const delta = Math.max(Math.abs(a[i]! - b[i]!), Math.abs(a[i + 1]! - b[i + 1]!), Math.abs(a[i + 2]! - b[i + 2]!));
    if (delta > 6) changedPixels += 1;
    if (delta > maxDelta) maxDelta = delta;
  }
  return { changedPixels, maxDelta };
}

/** Runs the probe; `label` names this run (before, after). Returns the summary file. */
export async function runFlickerProbe(
  window: BrowserWindow,
  commands: AppCommands,
  dir: string,
  ids: { macMini: string },
  label: string,
  durationMs = 9_000,
): Promise<string> {
  // Off in the shipped app, whatever asked for it.
  if (app.isPackaged) throw new Error("the flicker probe is off in the shipped app");
  const contents = window.webContents;
  await commands.ready(30_000);
  const setup: CommandBody[] = [
    { type: "set-mode", mode: "projects" },
    { type: "set-host-folded", hostId: ids.macMini, folded: false },
    { type: "select-pane", hostId: ids.macMini, paneId: "w7:pS1" },
    { type: "set-tab", tab: "chat" },
    { type: "zoom-pane", hostId: ids.macMini, paneId: "w7:pS1", zoomed: true },
  ];
  for (const command of setup) await commands.send(contents, command);
  // Long enough for the live rows to reach the box and scroll behind it (HERDR_FLICKER_SETTLE_MS).
  await wait(Number(process.env["HERDR_FLICKER_SETTLE_MS"] ?? 3_000));
  const framesDir = path.join(dir, `frames-${label}`);
  mkdirSync(framesDir, { recursive: true });
  const rectText = (await contents.executeJavaScript(instrument, true)) as string;
  if (rectText === "no box") throw new Error("the flicker probe found no message box");
  const box = JSON.parse(rectText) as { x: number; y: number; width: number; height: number };
  // A band above the box too: the Working line and the live row the blur sits under.
  const rect = { x: box.x, y: Math.max(0, box.y - 60), width: box.width, height: box.height + 60 };
  writeFileSync(path.join(dir, `window-${label}-start.png`), (await contents.capturePage()).toPNG());
  const started = Date.now();
  const diffs: FrameDiff[] = [];
  let previous: Uint8Array | null = null;
  let index = 0;
  while (Date.now() - started < durationMs) {
    const image = await contents.capturePage(rect);
    const bitmap = new Uint8Array(image.toBitmap());
    const atMs = Date.now() - started;
    if (previous !== null && previous.length === bitmap.length) {
      // Only the box's own rows (the band above it is context, saved in the frames).
      const scale = image.getSize().height / rect.height;
      const rowBytes = image.getSize().width * 4;
      const from = Math.round(60 * scale) * rowBytes;
      diffs.push({ index, atMs, ...diffBitmaps(previous.subarray(from), bitmap.subarray(from)) });
    }
    if (index < 400) writeFileSync(path.join(framesDir, `${String(index).padStart(3, "0")}.png`), image.toPNG());
    previous = bitmap;
    index += 1;
  }
  writeFileSync(path.join(dir, `window-${label}-end.png`), (await contents.capturePage()).toPNG());
  const page = JSON.parse((await contents.executeJavaScript(collect, true)) as string) as { samples: Sample[]; mutations: Mutation[] };
  // The compositor's own account (no captures now, which redraw the whole frame): what each frame redraws.
  let trace: string | null = null;
  if (process.env["HERDR_FLICKER_TRACE"] === "1") {
    await contentTracing.startRecording({
      included_categories: ["viz", "cc", "gpu", "disabled-by-default-viz.quads", "disabled-by-default-viz.debug.overlay_planes", "disabled-by-default-cc.debug"],
    });
    await wait(5_000);
    trace = await contentTracing.stopRecording(path.join(dir, `trace-${label}.json`));
  }
  await commands.send(contents, { type: "zoom-pane", hostId: ids.macMini, paneId: "w7:pS1", zoomed: false });
  const samples = page.samples;
  const byTarget = new Map<string, number>();
  for (const m of page.mutations) {
    const k = `${m.type} ${m.target}${m.attribute === null ? "" : ` [${m.attribute}]`}`;
    byTarget.set(k, (byTarget.get(k) ?? 0) + 1);
  }
  const changed = diffs.filter((diff) => diff.changedPixels > 0);
  const summary = {
    label,
    trace,
    rect,
    frames: index,
    seconds: Math.round((Date.now() - started) / 100) / 10,
    framesWithBoxPixelsChanged: changed.length,
    largestChanges: [...changed].sort((a, b) => b.changedPixels - a.changedPixels).slice(0, 12),
    samples: samples.length,
    sameBoxNodeThroughout: samples.every((s) => s.sameBox),
    wrapHeight: changes(samples, (s) => s.wrapHeight),
    boxTop: changes(samples, (s) => s.boxTop),
    textareaHeight: changes(samples, (s) => s.textareaHeight),
    chatInset: changes(samples, (s) => s.inset),
    ring: changes(samples, (s) => [s.ring, s.fill]),
    chips: changes(samples, (s) => s.chips),
    workingLine: changes(samples, (s) => s.working),
    domChangesInBox: Object.fromEntries([...byTarget.entries()].sort((a, b) => b[1] - a[1])),
    firstMutations: page.mutations.slice(0, 60),
  };
  const file = path.join(dir, `flicker-${label}.json`);
  writeFileSync(file, JSON.stringify(summary, null, 2));
  return file;
}

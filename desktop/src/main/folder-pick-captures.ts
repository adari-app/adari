// Captures 141-148 (development builds only, through
// dev-modes.ts): New workspace with its machine picker and recent folders as
// rows, the folder list open under a typed folder on the demo's
// Mac mini, Tab into a subfolder, a missing folder, build-box's Linux home,
// New agent's "Starts in … · Change…" and its list after Change…, and This
// Mac (the capture's fake-herdr fixture, its home a small invented tree in
// the fixture's temp folder, never this Mac's own home) with Choose… beside
// the field. Each step closes what the step before left open first; the
// folder window itself is never opened.

import { mkdirSync } from "node:fs";
import path from "node:path";

import type { CaptureStep } from "./capture";

/** Esc on every open dialog until none is left (a list open closes first, then its dialog). */
const closeDialogs = `(async () => {
  for (let i = 0; i < 6 && document.querySelector(".dlg") !== null; i += 1) {
    document.querySelector(".dlg").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await new Promise((done) => setTimeout(done, 120));
  }
  return document.querySelector(".dlg") === null;
})()`;

/** Types `text` into the open dialog's folder field as the user's keys would (after Change… when New agent shows Starts in), then `keys`. */
function typeFolder(text: string, keys: readonly string[] = []): string {
  return `(async () => {
    const wait = (ms) => new Promise((done) => setTimeout(done, ms));
    for (let tries = 0; tries < 60 && document.querySelector(".dlg") === null; tries += 1) await wait(50);
    document.querySelector('[aria-label="Change the folder"]')?.click();
    await wait(150);
    const field = document.querySelector('.dlg input[aria-label="Folder"]');
    if (field === null) return false;
    field.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(field, ${JSON.stringify(text)});
    field.dispatchEvent(new Event("input", { bubbles: true }));
    await wait(700);
    for (const key of ${JSON.stringify(keys)}) {
      field.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
      await wait(700);
    }
    return true;
  })()`;
}

/** What the picture shows, measured: the dialog's size, its field, the list's rows and lines, the recent rows, Choose…, the agent lines. */
const folderMeasure = `(() => {
  const text = (element) => (element?.textContent ?? "").replace(/\\s+/g, " ").trim();
  const dialog = document.querySelector(".dlg");
  const rect = dialog?.getBoundingClientRect();
  return {
    dialog: rect === undefined ? null : { title: dialog.getAttribute("aria-label"), x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
    labels: [...document.querySelectorAll(".dlg .fld .lb")].map(text),
    machine: document.querySelector('.dlg select[aria-label="Machine"]')?.value ?? null,
    folder: document.querySelector('.dlg input[aria-label="Folder"]')?.value ?? null,
    startsIn: text(document.querySelector(".dlg .na-in")) || null,
    listed: [...document.querySelectorAll(".dlg .fb-i")].map((row) => ({ name: text(row), on: row.classList.contains("on") })),
    listLines: [...document.querySelectorAll(".dlg .fb-line, .dlg .fb-keys")].map(text),
    recent: [...document.querySelectorAll(".dlg .nw-row")].map((row) => ({ name: text(row.querySelector(".nm")), path: text(row.querySelector(".pa")) })),
    chips: [...document.querySelectorAll(".dlg .na-sugg .chip")].map(text),
    choose: text(document.querySelector('.dlg [aria-label="Choose a folder on this Mac"]')) || null,
    agentLines: [...document.querySelectorAll(".dlg .na-kind")].map((kind) => ({ kind: kind.getAttribute("data-kind"), line: text(kind.querySelector(".d")) })),
    note: text(document.querySelector(".dlg .df .note")),
  };
})()`;

/** This Mac's fixture home, given a few folders (Code with three projects, Documents, Desktop, a hidden one). */
export function seedThisMacHome(home: string): void {
  for (const name of ["Code/herdr-companion", "Code/harbor", "Code/aurora-web", "Documents", "Desktop", ".config"]) mkdirSync(path.join(home, name), { recursive: true });
}

export function folderPickCaptureSteps(
  ids: { macMini: string; buildBox: string },
  page: (script: string) => Promise<unknown>,
  placeThisMac: (state: "found" | "gone") => Promise<string | null>,
): CaptureStep[] {
  const step = (name: string, what: string, extra: Partial<CaptureStep> & Pick<CaptureStep, "commands">): CaptureStep => ({
    name,
    what,
    settleMs: 900,
    measure: folderMeasure,
    ...extra,
    before: async () => {
      await page(closeDialogs);
      await extra.before?.();
    },
  });
  const projects = "/Users/demo/code/";
  return [
    step("141-folder-pick-new-workspace", "New workspace on the Mac mini, T3's Add project shape: Machine first (a picker), the folder field, the recent folders as rows of name and whole path, then the name", {
      commands: [{ type: "open-new-workspace", hostId: ids.macMini }],
    }),
    step("142-folder-pick-list", `The folder list open under a typed folder: ${projects} on the Mac mini, its folders sorted, the first highlighted, the keys`, {
      commands: [{ type: "open-new-workspace", hostId: ids.macMini }],
      page: [typeFolder(projects)],
    }),
    step("143-folder-pick-tab", "Tab into a subfolder: herdr-c filtered to herdr-companion, Tab completes it and lists what is inside", {
      commands: [{ type: "open-new-workspace", hostId: ids.macMini }],
      page: [typeFolder(`${projects}herdr-c`, ["Tab"])],
    }),
    step("144-folder-pick-missing", "A folder that is not there: a plain line, the field still typeable", {
      commands: [{ type: "open-new-workspace", hostId: ids.macMini }],
      page: [typeFolder("~/projects-old/")],
    }),
    step("145-folder-pick-linux", "build-box (Linux) picked: ~/ lists /root's folders, hidden ones left out", {
      commands: [{ type: "open-new-workspace", hostId: ids.buildBox }],
      page: [typeFolder("~/")],
    }),
    step("146-folder-pick-new-agent", "New agent in herdr-companion: Starts in its folder · Change… (no prefilled field, no chip), the agent lines below it", {
      commands: [{ type: "open-new-agent", hostId: ids.macMini, workspaceId: "w7" }],
    }),
    step("147-folder-pick-new-agent-list", "New agent after Change…: the field with the list open inside herdr-companion, the pane folders as rows", {
      commands: [{ type: "open-new-agent", hostId: ids.macMini, workspaceId: "w7" }],
      page: [typeFolder(`${projects}herdr-companion/`)],
    }),
    step("148-folder-pick-this-mac", "New workspace on This Mac (the capture's fixture, its invented home): Choose… beside the field (the macOS folder window, not opened here) and ~/ listed by the local reader", {
      before: async () => {
        const home = await placeThisMac("found");
        if (home !== null) seedThisMacHome(home);
      },
      commands: [{ type: "open-new-workspace", hostId: "this-mac" }],
      page: [typeFolder("~/")],
      settleMs: 1_500,
      afterCapture: async () => {
        await page(closeDialogs);
        await placeThisMac("gone");
      },
    }),
  ];
}

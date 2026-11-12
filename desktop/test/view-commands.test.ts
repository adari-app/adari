// Terminal text size per window and the View menu's keys.

import { describe, expect, it } from "vitest";

import { viewMenuItems } from "../src/main/view-menu";
import {
  clampFontSize,
  defaultTerminalFontSize,
  fontSizeKey,
  isViewCommand,
  loadFontSize,
  maximumTerminalFontSize,
  minimumTerminalFontSize,
  nextFontSize,
  saveFontSize,
  type ViewCommand,
} from "../src/shared/view-commands";

describe("terminal text size", () => {
  it("steps one point within the bounds and resets to 13", () => {
    expect(nextFontSize(13, "font-bigger")).toBe(14);
    expect(nextFontSize(13, "font-smaller")).toBe(12);
    expect(nextFontSize(20, "font-reset")).toBe(defaultTerminalFontSize);
    expect(nextFontSize(maximumTerminalFontSize, "font-bigger")).toBe(maximumTerminalFontSize);
    expect(nextFontSize(minimumTerminalFontSize, "font-smaller")).toBe(minimumTerminalFontSize);
    expect(nextFontSize(15, "toggle-box")).toBe(15);
  });

  it("keeps a window's size in its own storage and reads bad values as the default", () => {
    const storage = new Map<string, string>();
    const store = { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => void storage.set(key, value) };
    expect(loadFontSize(store)).toBe(13);
    saveFontSize(store, 17);
    expect(storage.get(fontSizeKey)).toBe("17");
    expect(loadFontSize(store)).toBe(17);
    storage.set(fontSizeKey, "huge");
    expect(loadFontSize(store)).toBe(13);
    storage.set(fontSizeKey, "400");
    expect(loadFontSize(store)).toBe(maximumTerminalFontSize);
    expect(loadFontSize(null)).toBe(13);
    expect(clampFontSize(12.6)).toBe(13);
    expect(clampFontSize(Number.NaN)).toBe(13);
  });

  it("accepts only the four commands", () => {
    expect(isViewCommand("font-bigger")).toBe(true);
    expect(isViewCommand("toggle-box")).toBe(true);
    expect(isViewCommand("zoom")).toBe(false);
    expect(isViewCommand(3)).toBe(false);
  });
});

describe("the View menu", () => {
  it("sends ⌘0, ⌘+, ⌘= and ⌘- to the page instead of zooming it, and ⇧⌘T toggles the box", () => {
    const sent: ViewCommand[] = [];
    const items = viewMenuItems((command) => sent.push(command), true);
    expect(items.some((item) => item.role === "zoomIn" || item.role === "zoomOut" || item.role === "resetZoom")).toBe(false);
    const byKey = new Map(items.filter((item) => item.accelerator !== undefined).map((item) => [item.accelerator, item]));
    // View > Terminal (⌘J) toggles the drawer, after Changes.
    expect([...byKey.keys()]).toEqual(["CmdOrCtrl+0", "CmdOrCtrl+Plus", "CmdOrCtrl+=", "CmdOrCtrl+-", "Shift+Cmd+T", "Ctrl+Cmd+C", "CmdOrCtrl+J"]);
    for (const key of byKey.keys()) {
      const click = byKey.get(key)!.click as () => void;
      click();
    }
    expect(sent).toEqual(["font-reset", "font-bigger", "font-bigger", "font-smaller", "toggle-box", "toggle-changes", "toggle-terminal"]);
    expect(viewMenuItems(() => undefined, false).find((item) => item.label === "Show or Hide Message Box")?.accelerator).toBe("Shift+Ctrl+T");
  });
});

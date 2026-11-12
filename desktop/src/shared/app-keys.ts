// The window's own shortcuts (the menu's are in main/menu.ts): ⌘J (Ctrl+J) the
// open pane's terminal drawer (T3 Code's key; View › Terminal shows it), ⇧⌘J
// (Ctrl+Shift+J) the next pane needing you, ⌘F (Ctrl+F) search, ⌘N (Ctrl+N)
// New agent for the selected pane's workspace, ⇧⌘F (Ctrl+Shift+F) Search
// conversations, ⇧⌘N (Ctrl+Shift+N) New workspace (the Swift app's key; taken
// before the terminal sees it, as ⌘N is). While the main
// area shows a tab's split panes: ⌘1–⌘4 (Ctrl+1–4) focus a
// tile in Herdr's order, ⌃⌘ arrows (Ctrl+Alt arrows) the neighbouring tile.

export type AppShortcut = "nextNeedsYou" | "toggleTerminal" | "search" | "searchConversations" | "newAgent" | "newWorkspace";

export interface ShortcutKey {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}

export function appShortcut(event: ShortcutKey, mac: boolean): AppShortcut | null {
  const mod = mac ? event.metaKey : event.ctrlKey;
  if (!mod || event.altKey) return null;
  switch (event.key) {
    case "j":
    case "J":
      return event.shiftKey ? "nextNeedsYou" : "toggleTerminal";
    case "f":
    case "F":
      return event.shiftKey ? "searchConversations" : "search";
    case "n":
    case "N":
      // ⇧⌘N is New workspace, as in the Swift app.
      return event.shiftKey ? "newWorkspace" : "newAgent";
    default:
      return null;
  }
}

export type MoveDirection = "left" | "right" | "up" | "down";

export type TileShortcut = { readonly type: "tile"; readonly index: number } | { readonly type: "move"; readonly direction: MoveDirection };

const arrows: Readonly<Record<string, MoveDirection>> = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };

/** A tile key: ⌘1–⌘4 (Ctrl+1–4 elsewhere) a tile by its place; ⌃⌘ arrows (Ctrl+Alt arrows) the neighbouring one. */
export function tileShortcut(event: ShortcutKey, mac: boolean): TileShortcut | null {
  if (event.shiftKey) return null;
  const mod = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (mod && !event.altKey && /^[1-4]$/.test(event.key)) return { type: "tile", index: Number(event.key) - 1 };
  const move = mac ? event.metaKey && event.ctrlKey && !event.altKey : event.ctrlKey && event.altKey && !event.metaKey;
  const direction = arrows[event.key];
  if (move && direction !== undefined) return { type: "move", direction };
  return null;
}

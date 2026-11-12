// The page's side of the split panes: which pane the window
// shows goes to the main process (bridge.watchLayout), and the newest layout
// of that pane's tab comes back (bridge.onLayoutUpdate), kept here for the
// main area. A bridge without the calls (an older test stub) shows one pane.

import type { HerdrDesktopBridge, LayoutUpdateEvent } from "../../shared/ipc-contract";
import type { PaneLayout } from "../../shared/pane-layout";

class LayoutStore {
  private current: LayoutUpdateEvent | null = null;
  private readonly listeners = new Set<() => void>();
  private attached = false;
  private watched: string | null = null;

  get(): LayoutUpdateEvent | null {
    return this.current;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Listens to the main process once for the page's life. */
  attach(bridge: HerdrDesktopBridge): void {
    if (this.attached || typeof bridge.onLayoutUpdate !== "function") return;
    this.attached = true;
    bridge.onLayoutUpdate((event) => this.receive(event));
  }

  /** The window shows this pane now (null: nothing). */
  watch(bridge: HerdrDesktopBridge, hostId: string | null, paneId: string | null): void {
    const key = hostId === null || paneId === null ? null : `${hostId}\n${paneId}`;
    if (key === this.watched) return;
    this.watched = key;
    if (typeof bridge.watchLayout === "function") bridge.watchLayout(hostId, paneId);
  }

  receive(event: LayoutUpdateEvent): void {
    this.current = event;
    for (const listener of Array.from(this.listeners)) listener();
  }

  /** The layout of the tab `tabId` on `hostId`, when that is what the window was last sent. */
  layoutFor(hostId: string, tabId: string | null): PaneLayout | null {
    const current = this.current;
    if (current === null || tabId === null || current.hostId !== hostId || current.layout === null) return null;
    return current.layout.tabId === tabId ? current.layout : null;
  }

  /** Tests: forget everything. */
  reset(): void {
    this.current = null;
    this.watched = null;
    this.attached = false;
    for (const listener of Array.from(this.listeners)) listener();
  }
}

export const layoutStore = new LayoutStore();

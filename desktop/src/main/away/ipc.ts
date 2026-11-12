// "While you were away" on the IPC surface (the contract's away channels):
// the page reads the state, is sent each change, says when the digest is on
// screen, and marks all seen. The sender checks are ipc.ts's.

import type { BrowserWindow } from "electron";

import { IPC } from "../../shared/ipc-contract";
import { handle, on } from "../ipc";
import type { AwayService } from "./service";

export function registerAwayIpc(away: AwayService): void {
  handle(IPC.awayState, () => away.state);
  on(IPC.awayShown, () => away.shown());
  on(IPC.awayMarkSeen, () => away.markAllSeen());
}

/** A visit is the window's focus: focus starts one, blur ends it. */
export function followFocus(window: BrowserWindow, away: AwayService): void {
  window.on("focus", () => away.focus());
  window.on("blur", () => away.blur());
  if (window.isFocused()) away.focus();
}

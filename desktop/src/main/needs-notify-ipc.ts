// The notifications on the IPC surface: the page's Needs you report on every
// change, and Settings › Notifications (the switches, a change of them, Send a
// test notification, what became of the last notification, and Open
// Notification Settings, which takes nothing: main opens its one fixed
// address). The sender checks are ipc.ts's (handle, on); the report is
// checked as every other payload is (isNeedsYouReport: types, lengths, at most
// maxReportRows rows and maxReportWaiting identities, every index of every
// array so a structured-cloned array's holes are refused), and anything else
// is dropped or refused.
//
// Nothing the page sends throws in the main process unasked: the report's
// listener (an `on`, which nothing would catch) drops what fails the check, and
// should the notifier throw all the same it logs the error and drops the report.
// The four `handle`s throw only their own "bad request" on purpose, which
// Electron answers as a rejected promise to the page.

import { IPC } from "../shared/ipc-contract";
import { isNeedsYouReport, isNotifySettingsChange } from "../shared/needs-notify";
import { handle, on } from "./ipc";
import type { NeedsNotifier } from "./needs-notifier";

export function registerNotifyIpc(
  notifier: Pick<NeedsNotifier, "update" | "settings" | "setSettings" | "test" | "delivery" | "openSystemSettings">,
  log: (line: string) => void = () => undefined,
): void {
  on(IPC.needsYouReport, (_event, report, ...rest) => {
    if (rest.length > 0 || !isNeedsYouReport(report)) return;
    try {
      notifier.update(report);
    } catch (error) {
      log(`a Needs you report was dropped: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  handle(IPC.notifySettings, (_event, ...rest) => {
    if (rest.length > 0) throw new Error("bad request");
    return notifier.settings();
  });
  handle(IPC.notifySettingsSet, (_event, change, ...rest) => {
    if (rest.length > 0 || !isNotifySettingsChange(change)) throw new Error("bad request");
    return notifier.setSettings(change);
  });
  handle(IPC.notifyTest, (_event, ...rest) => {
    if (rest.length > 0) throw new Error("bad request");
    return notifier.test();
  });
  handle(IPC.notifyDelivery, (_event, ...rest) => {
    if (rest.length > 0) throw new Error("bad request");
    return notifier.delivery();
  });
  on(IPC.notifyOpenSystemSettings, (_event, ...rest) => {
    if (rest.length > 0) return;
    notifier.openSystemSettings();
  });
}

// The page's side of the notifications, the Dock badge and the menu bar item:
// the sidebar's own Needs you rows (desktop-sidebar.ts buildDesktopSidebar's
// needsYou, the list ⇧⌘J walks), each with the pill its row shows, go to the
// main process on every change (src/shared/needs-notify.ts needsYouReport);
// the main process applies the rules (src/main/needs-notifier.ts). The window
// keeps this running while it is closed (hidden): its page is not throttled in
// the background (window.ts backgroundThrottling false) and keeps its
// connections' snapshots coming (hostsChanged), so the list keeps updating.

import { useEffect, useRef } from "react";

import type { DesktopRow } from "../shared/desktop-sidebar";
import type { HerdrDesktopBridge } from "../shared/ipc-contract";
import type { NeedsPillKind } from "../shared/needs-pill";
import { needsYouReport, sameReport, type NeedsYouReport, type ReportHost } from "../shared/needs-notify";

/** Sends the report when it changed (nothing until the first hosts are in, so the app opening reports no machine away). */
export function useNeedsYouReport(
  bridge: Pick<HerdrDesktopBridge, "reportNeedsYou">,
  hosts: readonly ReportHost[] | null,
  needsYou: readonly DesktopRow[],
  pills: ReadonlyMap<string, NeedsPillKind>,
): void {
  const sent = useRef<NeedsYouReport | null>(null);
  useEffect(() => {
    if (hosts === null || typeof bridge.reportNeedsYou !== "function") return;
    const report = needsYouReport(needsYou, hosts, pills);
    if (sent.current !== null && sameReport(sent.current, report)) return;
    sent.current = report;
    bridge.reportNeedsYou(report);
  }, [bridge, hosts, needsYou, pills]);
}

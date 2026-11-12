// The sidebar footer with and without the
// update pill, rendered by React: the pill sits at the footer's right end in
// the agent count's place while it shows, and the count is back when it goes.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Sidebar, type SidebarProps } from "../src/renderer/components/Sidebar";
import { UpdatePill } from "../src/renderer/components/UpdatePill";
import { buildDesktopSidebar } from "../src/shared/desktop-sidebar";
import { emptyFoldState } from "../src/shared/sidebar-model";
import { initialUpdateView, onAvailable, onDownloaded, onDownloadProgress, onDownloadStart, updatePill } from "../src/shared/updates";
import { nowUnixMs } from "./support/sidebar-fixture";

const none = (): void => undefined;

function footer(updatePillNode: SidebarProps["updatePill"]): string {
  const props: SidebarProps = {
    sidebar: buildDesktopSidebar([], { nowUnixMs, fold: { ...emptyFoldState, mode: "projects" } }),
    selectedKey: null,
    search: null,
    demo: false,
    foldedHosts: new Set(),
    onSelect: none,
    onRowMenu: none,
    onToggleHost: none,
    onHostMenu: none,
    onRetryHost: none,
    onMode: none,
    onToggleWorkspace: none,
    onToggleExpanded: none,
    onToggleSection: none,
    onSearch: none,
    onAddHost: none,
    onNewAgent: none,
    onWorkspaceMenu: none,
    updatePill: updatePillNode,
  };
  const html = renderToStaticMarkup(createElement(Sidebar, props));
  const at = html.indexOf('<div class="sb-foot">');
  return html.slice(at, html.indexOf('<div class="sb-rail"', at));
}

const available = onAvailable(initialUpdateView("0.1.0", null, true), "0.1.1", 0);

describe("the sidebar footer", () => {
  it("no pill: Settings and the agent count", () => {
    const html = footer(null);
    expect(html).toContain('<span class="ag">0 agents</span>');
    expect(html).not.toContain("upd-pill");
  });

  it("with a pill: Settings, then the pill at the right end in the count's place", () => {
    for (const view of [available, onDownloadProgress(onDownloadStart(available), 42), onDownloaded(onDownloadStart(available), "0.1.1")]) {
      const html = footer(createElement(UpdatePill, { pill: updatePill(view), onAction: none }));
      expect(html).not.toContain('class="ag"');
      expect(html.indexOf("data-settings-button")).toBeLessThan(html.indexOf("upd-pill"));
      expect(html).toMatch(/<button type="button" class="upd-pill [^"]+" data-update-pill="(download|downloading|install)"/u);
    }
    expect(footer(createElement(UpdatePill, { pill: updatePill(available), onAction: none }))).toContain('<span class="upd-l">Download</span>');
  });
});

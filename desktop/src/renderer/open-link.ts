// A link you open in Chat or the Terminal goes to the default
// browser through main (the bridge's openLink; main checks it again and calls
// the system's open), never into the app's window. Only http and https; any
// other address is left alone. T3 Code does the same through its local API's
// shell.openExternal (apps/web/src/browser/useOpenLink.ts:54).

import { isSafeExternalUrl } from "../shared/external-url";
import type { HerdrDesktopBridge } from "../shared/ipc-contract";

type LinkBridge = Pick<HerdrDesktopBridge, "openLink">;

/** The page's bridge, when there is one (none in a test that gives none). */
function pageBridge(): LinkBridge | undefined {
  return typeof window === "undefined" ? undefined : (window as { herdrDesktop?: LinkBridge }).herdrDesktop;
}

/** Opens `url` in the default browser when it is http or https; true when it went. */
export function openLink(url: string, bridge: LinkBridge | undefined = pageBridge()): boolean {
  if (!isSafeExternalUrl(url) || bridge?.openLink === undefined) return false;
  bridge.openLink(url);
  return true;
}

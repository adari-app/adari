// Settings › Machines shows, under each
// connected machine, one line of Herdr's agent integrations with Install or
// Update (src/renderer/components/integrations.tsx IntegrationsLine), and
// reads them again as the page opens. The page on the small hooks host with a
// fake bridge.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  const hooks = { ...fakeReact, useLayoutEffect: fakeReact.useEffect };
  return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});

import type { HostView } from "../src/shared/ipc-contract";
import type { HostIntegrations, IntegrationItem, IntegrationOutcome } from "../src/shared/integrations";
import { HookHost, elements } from "./support/fake-hooks";
import { flush, loadSettings, mountSettings, settingsBridge, sshHost, thisMac } from "./support/settings-page";

const { IntegrationsLine, integrationNotes, settingsIntegrationItems } = await import("../src/renderer/components/integrations");
const { escapeOwners, keyOwners } = await import("../src/renderer/components/escape-owners");
const { uploadsStore } = await import("../src/renderer/settings/uploads-store");
await loadSettings();

const item = (target: string, name: string, state: IntegrationItem["state"], available = true): IntegrationItem => ({ target, kind: target, name, state, available });

function integrations(items: IntegrationItem[], outcomes: Record<string, IntegrationOutcome> = {}): HostIntegrations {
  return { incarnation: 2, connection: 4, epoch: 7, items, outcomes };
}

const mini = (extra: Partial<HostView> = {}): HostView =>
  sshHost("mini", "Mac mini", {
    incarnation: 2,
    connection: 4,
    epoch: 7,
    integrations: integrations([item("claude", "Claude Code", "current"), item("codex", "Codex", "not_installed"), item("grok", "Grok Build", "outdated"), item("pi", "Pi", "not_installed", false)]),
    ...extra,
  });

const texts = (tree: unknown): string[] =>
  elements(tree).flatMap((element) => {
    const children = element.props["children"];
    return (Array.isArray(children) ? children : [children]).filter((child): child is string => typeof child === "string");
  });

/** Each kind's words on the line ("Claude Code: installed"), its name and state now either side of the Early badge. */
const itemTexts = (tree: unknown): string[] =>
  elements(tree)
    .filter((element) => element.props["className"] === "set-int-i")
    .map((element) => {
      const children = element.props["children"];
      return (Array.isArray(children) ? children : [children]).filter((child): child is string => typeof child === "string").join("");
    });

function line(host: HostView, bridge: Record<string, unknown> = {}) {
  const view = new HookHost(IntegrationsLine as (props: object) => unknown, { host, bridge });
  view.render();
  return view;
}

beforeEach(() => {
  escapeOwners.reset();
  keyOwners.reset();
  uploadsStore.reset();
  integrationNotes.reset();
  vi.stubGlobal("window", { addEventListener: () => undefined, removeEventListener: () => undefined });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Settings › Machines: one line of Herdr's integrations per connected machine", () => {
  it("lists the shown kinds Herdr finds there with their state, Install or Update beside the missing and old ones", () => {
    const view = line(mini());
    const items = elements(view.tree).filter((element) => element.props["className"] === "set-int-i");
    expect(items.map((element) => element.props["data-integration"])).toEqual(["claude", "codex", "grok"]);
    expect(itemTexts(view.tree)).toEqual(["Claude Code: installed", "Codex: not installed", "Grok Build: out of date"]);
    expect(texts(view.tree)).toEqual(expect.arrayContaining(["Install", "Update"]));
    const buttons = elements(view.tree).filter((element) => element.type === "button");
    expect(buttons.map((button) => [button.props["data-integration-install"], button.props["children"]])).toEqual([
      ["codex", "Install"],
      ["grok", "Update"],
    ]);
    expect(texts(view.tree).join(" ")).not.toContain("—");
  });

  it("a click sends one install for that target, bound as the page shows the machine; nothing runs on its own", async () => {
    const calls: unknown[][] = [];
    const bridge = { installIntegration: (...args: unknown[]) => (calls.push(args), Promise.resolve({ sent: false, note: "Not installed: Mac mini is offline. Nothing was sent." })) };
    const view = line(mini(), bridge);
    expect(calls).toEqual([]);
    const update = elements(view.tree).find((element) => element.props["data-integration-install"] === "grok")!;
    (update.props["onClick"] as () => void)();
    await flush();
    expect(calls).toEqual([["mini", "grok", { incarnation: 2, connection: 4, epoch: 7 }]]);
    view.render();
    expect(texts(view.tree)).toContain("Not installed: Mac mini is offline. Nothing was sent.");
  });

  it("shows the outcome and Herdr's lines under it, as text; the button greyed while it runs", () => {
    const installed = line(
      mini({
        integrations: integrations([item("codex", "Codex", "current")], {
          codex: { phase: "installed", text: "Installed. Restart Codex so it uses it.", messages: ["<i>wrote</i> the hooks"], action: "install" },
        }),
      }),
    );
    expect(itemTexts(installed.tree)).toEqual(["Codex: installed"]);
    expect(texts(installed.tree)).toEqual(expect.arrayContaining(["Installed. Restart Codex so it uses it.", "<i>wrote</i> the hooks"]));
    expect(elements(installed.tree).filter((element) => element.type === "button")).toEqual([]);
    const running = line(mini({ integrations: integrations([item("codex", "Codex", "not_installed")], { codex: { phase: "installing", text: "Installing Herdr's Codex integration…", messages: [], action: "install" } }) }));
    expect(elements(running.tree).find((element) => element.type === "button")!.props["disabled"]).toBe(true);
  });

  it("no line for an offline machine, one with no list (herdr-core, an older Herdr), or none of whose agents Herdr finds", () => {
    expect(settingsIntegrationItems(mini({ state: "offline" }))).toEqual([]);
    expect(settingsIntegrationItems(sshHost("core", "Core"))).toEqual([]);
    expect(settingsIntegrationItems(mini({ integrations: integrations([item("pi", "Pi", "not_installed", false)]) }))).toEqual([]);
  });

  it("the page puts the line under the machine's row and reads the integrations again as it opens", async () => {
    const { bridge } = settingsBridge();
    let refreshed = 0;
    const run = mountSettings("machines", { bridge: { ...bridge, refreshIntegrations: () => ((refreshed += 1), Promise.resolve()) }, hosts: [thisMac, mini(), sshHost("studio", "Studio")] });
    await flush();
    expect(refreshed).toBe(1);
    const shown = run.all((element) => typeof element.type === "function" && (element.type as { name: string }).name === "IntegrationsLine");
    expect(shown.map((element) => (element.props["host"] as HostView).id)).toEqual(["mini"]);
    run.rerender({ hosts: [thisMac, mini({ connection: 5 }), sshHost("studio", "Studio")] });
    await flush();
    expect(refreshed).toBe(1);
  });
});

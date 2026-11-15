// The Help menu's Report a Problem… and Send Feedback…, and the main process's
// door for Settings › About's same two (IPC.openFeedback). On the Mac the app
// had no Help menu; now it has one (role "help", where macOS adds its search
// field) holding the two. Elsewhere the Help menu keeps Check for Updates… and
// gains the two. Every other menu is as it was. The door takes only which one
// ("problem" or "feedback"): an address, or anything else, opens nothing.

import { afterEach, describe, expect, it, vi } from "vitest";

const template = vi.hoisted(() => ({ current: null as unknown[] | null }));
const registered = vi.hoisted(() => ({ on: new Map<string, (...args: unknown[]) => unknown>() }));
vi.mock("electron", () => ({
  ipcMain: {
    handle: () => undefined,
    on: (channel: string, listener: (...args: unknown[]) => unknown) => registered.on.set(channel, listener),
  },
  app: { name: "Adari" },
  Menu: { buildFromTemplate: (items: unknown[]) => ((template.current = items), {}), setApplicationMenu: () => undefined },
}));

const { installApplicationMenu } = await import("../src/main/menu");
const { registerIpc } = await import("../src/main/ipc");
const { APP_ORIGIN } = await import("../src/main/protocol");
const { IPC } = await import("../src/shared/ipc-contract");
const { feedbackRepo, openFeedbackIssue } = await import("../src/main/feedback");
const { feedbackIssueUrl, isFeedbackIssueUrl } = await import("../src/shared/feedback");

type Item = { label?: string; role?: string; type?: string; submenu?: Item[]; click?: () => void };
const details = { version: "0.1.1", signedRelease: false, macOS: "15.1.0", chip: "Apple silicon" };

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => Object.defineProperty(process, "platform", platform));

/** The menu as installed on `os`; `opened` gets each address the menu's handler opens through main's opener. */
function menu(os: string, withFeedback = true) {
  Object.defineProperty(process, "platform", { value: os });
  const opened: string[] = [];
  const kinds: string[] = [];
  installApplicationMenu({
    updatesEnabled: true,
    checkForUpdates: () => undefined,
    viewCommand: () => undefined,
    openSettings: () => undefined,
    ...(withFeedback
      ? {
          openFeedback: (kind: "problem" | "feedback") => {
            kinds.push(kind);
            openFeedbackIssue(kind, details, (url) => opened.push(url));
          },
        }
      : {}),
  });
  return { items: template.current as Item[], opened, kinds };
}

const topLabels = (items: Item[]) => items.map((item) => item.label ?? item.role);
const subLabels = (item: Item | undefined) => (item?.submenu ?? []).map((entry) => entry.label ?? entry.role ?? entry.type);

describe("the Help menu", () => {
  it("on the Mac: a new Help menu (role help) last, holding Report a Problem… and Send Feedback…", () => {
    const { items } = menu("darwin");
    expect(topLabels(items)).toEqual(["Adari", "File", "editMenu", "View", "windowMenu", "Help"]);
    const help = items.at(-1)!;
    expect(help.role).toBe("help");
    expect(subLabels(help)).toEqual(["Report a Problem…", "Send Feedback…"]);
  });

  it("on the Mac, every other menu as it was (the app menu's About, Check for Updates…, Settings…, Hide, Quit)", () => {
    const before = menu("darwin", false).items;
    const after = menu("darwin").items;
    expect(topLabels(before)).toEqual(["Adari", "File", "editMenu", "View", "windowMenu"]);
    for (let i = 0; i < before.length; i += 1) expect(subLabels(after[i])).toEqual(subLabels(before[i]));
    expect(subLabels(after[0])).toEqual(["about", "Check for Updates…", "separator", "Settings…", "separator", "hide", "hideOthers", "unhide", "separator", "quit"]);
  });

  it("elsewhere: Help keeps Check for Updates…, then a separator and the two", () => {
    const { items } = menu("linux");
    const help = items.find((item) => item.label === "Help");
    expect(subLabels(help)).toEqual(["Check for Updates…", "separator", "Report a Problem…", "Send Feedback…"]);
    expect(subLabels(menu("linux", false).items.find((item) => item.label === "Help"))).toEqual(["Check for Updates…"]);
  });

  it("each item opens its new issue through main's opener, with that address (no window touched)", () => {
    for (const os of ["darwin", "linux"]) {
      const { items, opened, kinds } = menu(os);
      const help = items.find((item) => item.label === "Help")!;
      help.submenu!.find((item) => item.label === "Report a Problem…")!.click!();
      help.submenu!.find((item) => item.label === "Send Feedback…")!.click!();
      expect(kinds).toEqual(["problem", "feedback"]);
      expect(opened).toEqual([feedbackIssueUrl("problem", details, feedbackRepo), feedbackIssueUrl("feedback", details, feedbackRepo)]);
      for (const url of opened) expect(isFeedbackIssueUrl(url, feedbackRepo)).toBe(true);
    }
  });
});

describe("the main process's door for About's two", () => {
  function door() {
    const kinds: unknown[] = [];
    const links: unknown[] = [];
    registered.on.clear();
    registerIpc({
      hosts: { backend: () => null, list: () => [], refresh: async () => undefined },
      openFeedback: (kind: unknown) => kinds.push(kind),
      openLink: (url: unknown) => links.push(url),
    } as never);
    const event = { senderFrame: { url: APP_ORIGIN }, sender: { id: 1 } };
    const send = (...args: unknown[]) => registered.on.get(IPC.openFeedback)!(event, ...args);
    return { kinds, links, send, event };
  }

  it("takes the kind only, and passes it to main's openFeedback", () => {
    const { kinds, links, send } = door();
    send("problem");
    send("feedback");
    expect(kinds).toEqual(["problem", "feedback"]);
    expect(links).toEqual([]);
  });

  it("an address, another word, or a second argument opens nothing (no other host through this path)", () => {
    const { kinds, links, send } = door();
    for (const args of [["https://evil.example/"], ["https://github.com/adari-app/adari/issues/new?body=x"], ["bug"], [""], [null], [{ kind: "problem" }], ["problem", "https://evil.example/"], []]) send(...args);
    expect(kinds).toEqual([]);
    expect(links).toEqual([]);
  });

  it("a page from anywhere but the app is not heard", () => {
    const { kinds } = door();
    registered.on.get(IPC.openFeedback)!({ senderFrame: { url: "https://evil.example/" }, sender: { id: 1 } }, "problem");
    expect(kinds).toEqual([]);
  });
});

// Settings › About's Report a problem and Send feedback: two rows after Open-source
// licenses, each with a New issue button, and one line under them. A click is
// the bridge's openFeedback with which one; main builds the new issue's address
// and opens it through its link opener (src/main/feedback.ts). Followed here
// from the click, through the main process's door, to the opener.

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  const hooks = { ...fakeReact, useLayoutEffect: fakeReact.useEffect };
  return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});
const registered = vi.hoisted(() => ({ on: new Map<string, (...args: unknown[]) => unknown>() }));
vi.mock("electron", () => ({
  ipcMain: { handle: () => undefined, on: (channel: string, listener: (...args: unknown[]) => unknown) => registered.on.set(channel, listener) },
}));

import { elements } from "./support/fake-hooks";
import { loadSettings, mountSettings, settingsBridge } from "./support/settings-page";

const { registerIpc } = await import("../src/main/ipc");
const { APP_ORIGIN } = await import("../src/main/protocol");
const { IPC } = await import("../src/shared/ipc-contract");
const { feedbackRepo, openFeedbackIssue } = await import("../src/main/feedback");
const { feedbackIssueUrl, isFeedbackIssueUrl } = await import("../src/shared/feedback");
await loadSettings();

afterEach(() => vi.unstubAllGlobals());

const details = { version: "0.1.1", signedRelease: true, macOS: "15.1.0", chip: "Apple silicon" };

/** A bridge whose openFeedback goes through the main process's door to its opener (`opened`), as preload's does. */
function wired() {
  const opened: string[] = [];
  const asked: unknown[][] = [];
  registered.on.clear();
  registerIpc({
    hosts: { backend: () => null, list: () => [], refresh: async () => undefined },
    openFeedback: (kind: "problem" | "feedback") => openFeedbackIssue(kind, details, (url) => opened.push(url)),
    openLink: (url: string) => opened.push(`openLink:${url}`),
  } as never);
  const event = { senderFrame: { url: APP_ORIGIN }, sender: { id: 1 } };
  const { bridge: base } = settingsBridge();
  const bridge = { ...base, openFeedback: (...args: unknown[]) => (asked.push(args), registered.on.get(IPC.openFeedback)!(event, ...args)) };
  return { bridge, opened, asked };
}

type Run = ReturnType<typeof mountSettings>;
const rowOf = (run: Run, kind: string) => run.find((element) => element.props["data-feedback"] === kind);
/** The row's own button (looked for inside the row). */
const buttonOf = (run: Run, kind: string) => elements(rowOf(run, kind)).find((element) => element.type === "button")!;
const text = (element: { props: Record<string, unknown> } | undefined): string[] => [element?.props["children"]].flat().filter((child): child is string => typeof child === "string");

describe("Settings › About's Report a problem and Send feedback", () => {
  it("two rows after Open-source licenses, each a New issue button, and the one line under them", () => {
    const { bridge } = wired();
    const run = mountSettings("about", { bridge });
    const titles = run.all((element) => element.props["className"] === "set-k").map((element) => element.props["children"]);
    expect(titles).toEqual(["Version", "Privacy", "Open-source licenses", "Report a problem", "Send feedback"]);
    for (const kind of ["problem", "feedback"]) {
      expect(rowOf(run, kind)).toBeDefined();
      expect(text(buttonOf(run, kind))).toEqual(["New issue"]);
      expect(buttonOf(run, kind).props["aria-label"]).toBe(kind === "problem" ? "Report a Problem…" : "Send Feedback…");
      expect(buttonOf(run, kind).props["disabled"]).toBe(false);
    }
    expect(buttonOf(run, "problem").props["title"]).toBe("Report a Problem…");
    expect(buttonOf(run, "feedback").props["title"]).toBe("Send Feedback…");
    const foot = run.find((element) => element.props["data-feedback-foot"] !== undefined);
    expect(text(foot)).toEqual(["Opens a new issue on GitHub in your browser. Adari sends nothing itself."]);
    run.view.unmount();
  });

  it("each button: the bridge asked with its kind only, and main's opener given that new issue's address", () => {
    const { bridge, opened, asked } = wired();
    const run = mountSettings("about", { bridge });
    (buttonOf(run, "problem").props["onClick"] as () => void)();
    (buttonOf(run, "feedback").props["onClick"] as () => void)();
    expect(asked).toEqual([["problem"], ["feedback"]]);
    expect(opened).toEqual([feedbackIssueUrl("problem", details, feedbackRepo), feedbackIssueUrl("feedback", details, feedbackRepo)]);
    for (const url of opened) expect(isFeedbackIssueUrl(url, feedbackRepo)).toBe(true);
    run.view.unmount();
  });

  it("an older bridge with no openFeedback: both buttons greyed, nothing to call", () => {
    const { bridge } = settingsBridge();
    const run = mountSettings("about", { bridge });
    for (const kind of ["problem", "feedback"]) expect(buttonOf(run, kind).props["disabled"]).toBe(true);
    run.view.unmount();
  });
});

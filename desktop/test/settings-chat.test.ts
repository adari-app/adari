// Settings › Chat. "Send presses Return" is read by every
// message box: on (the default), Return sends and Shift-Return adds a line;
// off, Return adds a line and ⌘Return (Ctrl+Return elsewhere) sends. It is
// kept in the window's localStorage, so it holds across a relaunch.
// Start commands, each machine's command per agent kind from
// ~/.adari/agents.json, editable.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HostView } from "../src/shared/ipc-contract";
import type { SidebarRow } from "../src/shared/sidebar-model";
import { parseStartCommands } from "../src/shared/start-commands";
import { returnSends, sendButtonTitle, sendPressesReturnKey } from "../src/shared/settings";
import { HookHost, find, elements } from "./support/fake-hooks";
import { MemoryStorage } from "./support/manage-page";
import { flush, loadSettings, mountSettings, settingsBridge, sshHost } from "./support/settings-page";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  return { ...actual, ...fakeReact, default: { ...actual, ...fakeReact } };
});

const { Composer } = await import("../src/renderer/components/MainPane");
const { composerDrafts } = await import("../src/renderer/components/composer-drafts");
const { composerSettings } = await import("../src/renderer/components/composer-settings");
await loadSettings();

let storage: MemoryStorage;
let sends: string[];

beforeEach(() => {
  storage = new MemoryStorage();
  sends = [];
  composerDrafts.clear();
  vi.stubGlobal("window", {
    localStorage: storage,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    herdrDesktop: {
      sendToPane: (_hostId: string, _paneId: string, text: string) => {
        sends.push(text);
        return new Promise<void>(() => undefined);
      },
    },
  });
  composerSettings.reset();
  composerSettings.setMac(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const enter = (extra: Partial<{ shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; altKey: boolean }> = {}) => ({
  key: "Enter",
  shiftKey: false,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  ...extra,
});

describe("which Return sends", () => {
  it("on: Return sends, Shift-Return does not, nor while an input method composes", () => {
    expect(returnSends(enter(), true, true)).toBe(true);
    expect(returnSends(enter({ shiftKey: true }), true, true)).toBe(false);
    expect(returnSends({ ...enter(), isComposing: true }, true, true)).toBe(false);
  });

  it("off: Return adds a line; ⌘Return sends on the Mac, Ctrl+Return elsewhere", () => {
    expect(returnSends(enter(), false, true)).toBe(false);
    expect(returnSends(enter({ metaKey: true }), false, true)).toBe(true);
    expect(returnSends(enter({ ctrlKey: true }), false, true)).toBe(false);
    expect(returnSends(enter({ ctrlKey: true }), false, false)).toBe(true);
    expect(returnSends(enter({ metaKey: true }), false, false)).toBe(false);
    expect(returnSends(enter({ metaKey: true, altKey: true }), false, true)).toBe(false);
  });

  it("the Send button says which", () => {
    expect(sendButtonTitle(true, true)).toBe("Send (Return) · Shift-Return for a new line");
    expect(sendButtonTitle(false, true)).toBe("Send (⌘Return) · Return for a new line");
    expect(sendButtonTitle(false, false)).toBe("Send (Ctrl+Return) · Return for a new line");
  });
});

const mac = { id: "mac-mini", name: "Mac mini" } as HostView;
const pane = { paneID: "w1:p1", name: "A", workspaceLabel: "ops" } as SidebarRow;

function composer() {
  const ui = new HookHost(Composer, { host: mac, row: pane });
  ui.render();
  const textarea = () => find(ui.tree, "textarea")!;
  let prevented = false;
  return {
    ui,
    type: (value: string) => (textarea().props["onChange"] as (e: unknown) => void)({ target: { value } }),
    press: (keys: Partial<{ shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }> = {}) => {
      prevented = false;
      (textarea().props["onKeyDown"] as (e: unknown) => void)({
        ...enter(keys),
        nativeEvent: { isComposing: false },
        preventDefault: () => (prevented = true),
      });
      return prevented;
    },
    sendTitle: () => elements(ui.tree).find((element) => element.props["aria-label"] === "Send")?.props["title"],
  };
}

describe("the message box follows the setting", () => {
  it("on (the default): Return sends", () => {
    const c = composer();
    c.type("hello");
    expect(c.press()).toBe(true);
    expect(sends).toEqual(["hello"]);
    expect(c.sendTitle()).toBe("Send (Return) · Shift-Return for a new line");
    c.ui.unmount();
  });

  it("off: Return is left to the box (a new line), ⌘Return sends", () => {
    composerSettings.setSendPressesReturn(false);
    const c = composer();
    c.type("line one");
    expect(c.press()).toBe(false);
    expect(sends).toEqual([]);
    expect(c.press({ metaKey: true })).toBe(true);
    expect(sends).toEqual(["line one"]);
    expect(c.sendTitle()).toBe("Send (⌘Return) · Return for a new line");
    c.ui.unmount();
  });

  it("a box already open follows a change made in Settings", () => {
    const c = composer();
    composerSettings.setSendPressesReturn(false);
    c.type("draft");
    expect(c.press()).toBe(false);
    expect(sends).toEqual([]);
    c.ui.unmount();
  });
});

describe("Settings › Chat › Send presses Return", () => {
  it("its switch sets it, kept in localStorage, and it holds across a relaunch", () => {
    const { bridge } = settingsBridge();
    const page = mountSettings("chat", { bridge });
    const toggle = () => page.part("Switch", (props) => props["label"] === "Send presses Return")!;
    expect(toggle().props["on"]).toBe(true);

    (toggle().props["onChange"] as (on: boolean) => void)(false);
    expect(composerSettings.sendPressesReturn()).toBe(false);
    expect(storage.getItem(sendPressesReturnKey)).toBe("false");
    expect(toggle().props["on"]).toBe(false);

    // A relaunch: read from storage again.
    composerSettings.reset();
    expect(composerSettings.sendPressesReturn()).toBe(false);
    const c = composer();
    c.type("kept");
    expect(c.press()).toBe(false);
    expect(c.press({ metaKey: true })).toBe(true);
    c.ui.unmount();

    (toggle().props["onChange"] as (on: boolean) => void)(true);
    composerSettings.reset();
    expect(composerSettings.sendPressesReturn()).toBe(true);
    page.view.unmount();
  });

  it("a value that cannot be read is the default (on)", () => {
    storage.setItem(sendPressesReturnKey, "garbled");
    composerSettings.reset();
    expect(composerSettings.sendPressesReturn()).toBe(true);
  });
});

// Start commands, editable. A field per machine per kind (Claude Code first), the stock command in grey when empty;
// Return or leaving the field saves it through the main process (bridge.saveStartCommand: ~/.adari/agents.json on the
// machine), Esc puts it back; a command the reader would refuse is refused as the user types it and never sent; New
// agent and the Resume chip use the saved value.
describe("Settings › Chat › Start commands, editable", () => {
  const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

  /** A bridge whose machines' files are `files` (null: none; a string: bytes that are not JSON); saves recorded, answered as the main process would. */
  function machines(files: Record<string, Record<string, string> | string | null>) {
    const { bridge, fake } = settingsBridge();
    const saves: [string, string, string][] = [];
    let refuse: string | null = null;
    const read = (hostId: string) => {
      const file = files[hostId] ?? null;
      return parseStartCommands(file === null ? null : typeof file === "string" ? new TextEncoder().encode(file) : encode(file));
    };
    const full = {
      ...bridge,
      startCommands: (hostId: string) => (fake.calls.push(["startCommands", hostId]), Promise.resolve(read(hostId))),
      saveStartCommand: (hostId: string, kind: string, command: string) => {
        saves.push([hostId, kind, command]);
        if (refuse !== null) return Promise.reject(new Error(refuse));
        const file = { ...(files[hostId] as Record<string, string> | null) };
        if (command === "") delete file[kind];
        else file[kind] = command;
        files[hostId] = file;
        return Promise.resolve(read(hostId));
      },
    };
    return { bridge: full, fake, saves, refuseWith: (why: string | null) => (refuse = why) };
  }

  const hosts = [sshHost("studio", "Studio"), sshHost("box", "Box"), sshHost("off", "Off", { state: "offline" } as Partial<HostView>)];

  function chat(bridge: object, shown: HostView[] = hosts) {
    const page = mountSettings("chat", { bridge, hosts: shown });
    const field = (hostId: string, kind: string) => page.find((element) => element.props["data-start-input"] === `${hostId}/${kind}`)!;
    const group = (hostId: string) => page.find((element) => element.props["data-start"] === hostId)!;
    const words = (tree: unknown) =>
      elements(tree)
        .map((element) => element.props["children"])
        .filter((children): children is string => typeof children === "string");
    const status = (hostId: string, kind: string) => words(elements(group(hostId)).find((element) => element.props["data-start-kind"] === kind)).slice(1);
    let prevented = false;
    let stopped = false;
    const key = (hostId: string, kind: string, name: string) => {
      prevented = false;
      stopped = false;
      (field(hostId, kind).props["onKeyDown"] as (event: unknown) => void)({
        key: name,
        nativeEvent: { isComposing: false },
        preventDefault: () => (prevented = true),
        stopPropagation: () => (stopped = true),
      });
      return { prevented, stopped };
    };
    return {
      page,
      field,
      group,
      words,
      status,
      key,
      type: (hostId: string, kind: string, value: string) => (field(hostId, kind).props["onChange"] as (event: unknown) => void)({ target: { value } }),
      blur: (hostId: string, kind: string) => (field(hostId, kind).props["onBlur"] as () => void)(),
    };
  }

  it("a field per kind on each machine, Claude Code first; the file's command in it, the stock command in grey; read only from connected machines", async () => {
    const m = machines({ studio: { claude: "claude --model opus" }, box: null });
    const c = chat(m.bridge);
    await flush();
    expect(elements(c.group("studio")).filter((element) => element.props["data-start-kind"] !== undefined).map((element) => element.props["data-start-kind"])).toEqual(["claude", "codex", "grok", "cursor"]);
    expect(c.field("studio", "claude").props).toMatchObject({ value: "claude --model opus", placeholder: "claude", disabled: false });
    expect(c.field("studio", "codex").props).toMatchObject({ value: "", placeholder: "codex", disabled: false });
    expect(c.field("box", "grok").props).toMatchObject({ value: "", placeholder: "grok" });
    expect(c.field("box", "cursor").props).toMatchObject({ value: "", placeholder: "cursor agent" });
    expect(c.words(c.group("studio"))).toContain("From ~/.adari/agents.json");
    expect(c.words(c.group("box"))).toContain("No ~/.adari/agents.json yet: each agent starts with its own command.");
    expect(c.field("off", "claude").props["disabled"]).toBe(true);
    expect(c.words(c.group("off"))).toContain("Not connected. Start commands are read and saved while it is connected.");
    expect(m.fake.calls.filter((call) => call[0] === "startCommands").map((call) => call[1])).toEqual(["studio", "box"]);
    c.page.view.unmount();
  });

  it("Return saves it, trimmed, once (leaving the field after does not save again); then New agent and the Resume chip use it", async () => {
    const { startCommandsStore } = await import("../src/renderer/components/resume");
    const { handoffStore } = await import("../src/renderer/handoff/handoff-state");
    const { resumeOffer } = await import("../src/shared/pane-life");
    const { typedStart } = await import("../src/shared/start-commands");
    startCommandsStore.clear();
    const m = machines({ studio: { claude: "cl", codex: "codex2" }, box: null });
    const c = chat(m.bridge);
    await flush();
    c.type("studio", "claude", "  claude --model opus  ");
    expect(c.status("studio", "claude")).toEqual(["Not saved yet: Return saves it on the machine, Esc puts it back."]);
    expect(m.saves).toEqual([]);
    expect(c.key("studio", "claude", "Enter").prevented).toBe(true);
    expect(c.status("studio", "claude")).toEqual(["Saving…"]);
    c.blur("studio", "claude");
    await flush();
    expect(m.saves).toEqual([["studio", "claude", "claude --model opus"]]);
    expect(c.field("studio", "claude").props["value"]).toBe("claude --model opus");
    expect(c.status("studio", "claude")).toEqual(["Saved. New agent, Resume and restart type claude --model opus."]);
    c.blur("studio", "claude");
    await flush();
    expect(m.saves).toHaveLength(1);
    // The window's own copy: what New agent (typedStart) and the Resume chip read.
    const kept = startCommandsStore.get("studio", handoffStore.life.connection("studio"))!;
    expect(typedStart(kept, "claude")).toEqual({ type: "typed", command: "claude --model opus" });
    expect(typedStart(kept, "codex")).toEqual({ type: "typed", command: "codex2" });
    const exited = { kind: "claude", title: "Claude", terminalID: "t1", session: { source: "herdr:claude", agent: "claude", kind: "id", value: "0f2c9a6e-1d2b-4c3d-9e8f-aabbccddeeff" } };
    expect(resumeOffer(exited as never, kept)?.command).toBe("claude --model opus --resume 0f2c9a6e-1d2b-4c3d-9e8f-aabbccddeeff");
    c.page.view.unmount();
  });

  it("a command the reader would refuse is refused as the user types it, and never sent", async () => {
    const m = machines({ studio: { claude: "cl" } });
    const c = chat(m.bridge, [sshHost("studio", "Studio")]);
    await flush();
    for (const [typed, reason] of [
      ["cl; rm x", "The command has \u201c;\u201d, not allowed in a plain command."],
      ["codex && echo hi", "The command has \u201c&\u201d, not allowed in a plain command."],
      ["x".repeat(65), "The command is longer than 64 characters."],
      ["claude  --model opus", "The command is not words separated by single spaces."],
    ]) {
      c.type("studio", "claude", typed!);
      expect(c.status("studio", "claude"), typed).toEqual([reason]);
      expect(c.field("studio", "claude").props["aria-invalid"]).toBe(true);
      c.key("studio", "claude", "Enter");
      c.blur("studio", "claude");
      await flush();
    }
    expect(m.saves).toEqual([]);
    c.page.view.unmount();
  });

  it("Esc puts back what is saved, and is the field's own (the page stays open)", async () => {
    const m = machines({ studio: { claude: "cl" } });
    const c = chat(m.bridge, [sshHost("studio", "Studio")]);
    await flush();
    c.type("studio", "claude", "claude --wrong");
    expect(c.key("studio", "claude", "Escape")).toEqual({ prevented: true, stopped: true });
    expect(c.field("studio", "claude").props["value"]).toBe("cl");
    expect(c.status("studio", "claude")).toEqual([]);
    // With nothing typed, Esc is the page's again (it closes Settings).
    expect(c.key("studio", "claude", "Escape")).toEqual({ prevented: false, stopped: false });
    c.blur("studio", "claude");
    await flush();
    expect(m.saves).toEqual([]);
    c.page.view.unmount();
  });

  it("emptied: saved as no command, so the kind starts with its stock command again; unchanged: nothing sent", async () => {
    const m = machines({ studio: { claude: "cl" } });
    const c = chat(m.bridge, [sshHost("studio", "Studio")]);
    await flush();
    c.type("studio", "codex", "");
    c.blur("studio", "codex");
    c.type("studio", "claude", "cl");
    c.blur("studio", "claude");
    await flush();
    expect(m.saves).toEqual([]);
    c.type("studio", "claude", "   ");
    c.key("studio", "claude", "Enter");
    await flush();
    expect(m.saves).toEqual([["studio", "claude", ""]]);
    expect(c.field("studio", "claude").props["value"]).toBe("");
    expect(c.status("studio", "claude")).toEqual(["Saved. Claude Code starts with claude again."]);
    c.page.view.unmount();
  });

  it("a save the main process refused says why, and keeps what the user typed", async () => {
    const m = machines({ studio: { claude: "cl" } });
    m.refuseWith("Error invoking remote method 'herdr:start-command-save': Error: Studio is not connected.");
    const c = chat(m.bridge, [sshHost("studio", "Studio")]);
    await flush();
    c.type("studio", "claude", "claude");
    c.key("studio", "claude", "Enter");
    await flush();
    expect(c.status("studio", "claude")).toEqual(["Not saved: Studio is not connected."]);
    expect(c.field("studio", "claude").props["value"]).toBe("claude");
    m.refuseWith("The machine did not put the new file in place: Permission denied");
    c.key("studio", "claude", "Enter");
    await flush();
    expect(c.status("studio", "claude")).toEqual(["Not saved: The machine did not put the new file in place: Permission denied"]);
    c.page.view.unmount();
  });

  it("a file that was not read: its fields greyed, and why (Adari does not rewrite a file it cannot read)", async () => {
    const m = machines({ studio: "[1, 2]" });
    const c = chat(m.bridge, [sshHost("studio", "Studio")]);
    await flush();
    expect(c.field("studio", "claude").props["disabled"]).toBe(true);
    expect(c.words(c.group("studio"))).toContain(
      '~/.adari/agents.json was not read: it is not a JSON object such as {"claude": "cl"}. Fix it on the machine first; Adari does not rewrite a file it cannot read.',
    );
    c.page.view.unmount();
  });

  it("a command in the file New agent would not type says so under its field", async () => {
    const m = machines({ studio: { claude: "cl; rm x" } });
    const c = chat(m.bridge, [sshHost("studio", "Studio")]);
    await flush();
    expect(c.status("studio", "claude")).toEqual([
      "Not used: the claude command in ~/.adari/agents.json has \u201c;\u201d, not allowed in a plain command. Claude Code starts with claude until it is changed here.",
    ]);
    c.page.view.unmount();
  });

  it("a read of the machine that started before a save and comes back after it does not put the old command back", async () => {
    let release: (value: ReturnType<typeof parseStartCommands>) => void = () => undefined;
    const late = new Promise<ReturnType<typeof parseStartCommands>>((resolve) => {
      release = resolve;
    });
    let reads = 0;
    const { bridge } = settingsBridge();
    const commands = (claude: string) => parseStartCommands(encode({ claude }));
    const full = {
      ...bridge,
      startCommands: (hostId: string) => (hostId !== "box" ? Promise.resolve(parseStartCommands(null)) : (reads += 1) === 1 ? Promise.resolve(commands("old")) : late),
      saveStartCommand: async () => commands("new"),
    };
    const box = sshHost("box", "Box");
    const other = sshHost("other", "Other", { state: "offline" } as Partial<HostView>);
    const c = chat(full, [box, other]);
    await flush();
    expect(c.field("box", "claude").props["value"]).toBe("old");
    // Another machine connects: every connected machine is read again, Box too (that read is held).
    c.page.rerender({ hosts: [box, { ...other, state: "connected" }] });
    await flush();
    expect(reads).toBe(2);
    c.type("box", "claude", "new");
    c.blur("box", "claude");
    await flush();
    expect(c.field("box", "claude").props["value"]).toBe("new");
    release(commands("old"));
    await flush();
    expect(c.field("box", "claude").props["value"]).toBe("new");
    expect(c.status("box", "claude")).toEqual(["Saved. New agent, Resume and restart type new."]);
    c.page.view.unmount();
  });

  it("Cursor Agent's Saved line promises New agent and Resume only (restart does not know it); the others promise restart too", async () => {
    const { restartKinds } = await import("../src/shared/agent-restart");
    expect(Object.hasOwn(restartKinds, "cursor")).toBe(false);
    const m = machines({ studio: {} });
    const c = chat(m.bridge, [sshHost("studio", "Studio")]);
    await flush();
    for (const kind of ["claude", "codex", "grok", "cursor"]) {
      c.type("studio", kind, `${kind === "cursor" ? "cursor-agent" : kind} --x`);
      c.blur("studio", kind);
      await flush();
    }
    expect(c.status("studio", "cursor")).toEqual(["Saved. New agent and Resume type cursor-agent --x."]);
    expect(c.status("studio", "claude")).toEqual(["Saved. New agent, Resume and restart type claude --x."]);
    // Codex's row has its note (Adari adds --no-daemon) above the line.
    expect(c.status("studio", "codex")).toEqual(["Adari adds --no-daemon so Chat can find the session.", "Saved. New agent, Resume and restart type codex --x."]);
    expect(c.status("studio", "grok")).toEqual(["Saved. New agent, Resume and restart type grok --x."]);
    c.type("studio", "cursor", "");
    c.blur("studio", "cursor");
    await flush();
    expect(c.status("studio", "cursor")).toEqual(["Saved. Cursor Agent starts with cursor agent again."]);
    c.page.view.unmount();
  });
});

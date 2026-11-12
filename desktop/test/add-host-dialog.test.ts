// Add a machine: Password (the default, as the iPhone app) or Key file. The
// real dialog runs on the small hooks host (test/support/fake-hooks.ts) with a
// fake bridge; the handlers are called as a click or a keystroke would.

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AddHostRequest, EditHostRequest, HostSettings, HostView } from "../src/shared/ipc-contract";
import { HookHost, elements } from "./support/fake-hooks";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  return { ...actual, ...fakeReact, default: { ...actual, ...fakeReact } };
});

const { AddHostDialog } = await import("../src/renderer/components/AddHostDialog");

const pickedKey = "/Users/robin/keys/id_ed25519";
let added: AddHostRequest[] = [];
let updated: EditHostRequest[] = [];
let removed: string[] = [];
let failWith: string | null = null;
const listed = [{ id: "h1" }] as HostView[];

beforeEach(() => {
  added = [];
  updated = [];
  removed = [];
  failWith = null;
  const answer = <T,>(record: () => void, value: T): Promise<T> => {
    record();
    return failWith === null ? Promise.resolve(value) : Promise.reject(new Error(`Error invoking remote method 'herdr:hosts-add': Error: ${failWith}`));
  };
  vi.stubGlobal("window", {
    herdrDesktop: {
      addHost: (request: AddHostRequest) => answer(() => added.push(request), listed),
      updateHost: (request: EditHostRequest) => answer(() => updated.push(request), listed),
      removeHost: (id: string) => answer(() => removed.push(id), listed),
      pickKeyFile: () => Promise.resolve(pickedKey),
    },
  });
});

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

type Node = { type: unknown; props: Record<string, unknown> };

function text(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  if (typeof node === "object" && node !== null && "props" in node) return text((node as Node).props["children"]);
  return "";
}

function dialog(props: { editing?: HostSettings; passwordStorage?: boolean } = {}) {
  const saved: HostView[][] = [];
  const ui = new HookHost(AddHostDialog, {
    editing: props.editing ?? null,
    passwordStorage: props.passwordStorage ?? true,
    onClose: () => undefined,
    onSaved: (hosts: HostView[]) => saved.push(hosts),
  });
  ui.render();
  const all = (): Node[] => elements(ui.tree) as Node[];
  const field = (label: string): Node | undefined => all().find((e) => e.props["aria-label"] === label);
  const button = (label: string): Node | undefined => all().find((e) => e.type === "button" && text(e) === label);
  const type = (label: string, value: string): void => {
    (field(label)!.props["onChange"] as (event: { target: { value: string } }) => void)({ target: { value } });
  };
  const click = (node: Node | undefined): void => {
    expect(node).toBeDefined();
    (node!.props["onClick"] as () => void)();
  };
  const method = (auth: "password" | "key"): Node => all().find((e) => e.props["data-auth"] === auth)!;
  const save = (): Node => all().find((e) => e.type === "button" && e.props["className"] === "btn pri")!;
  const note = (): string =>
    text(all().find((e) => typeof e.props["className"] === "string" && (e.props["className"] as string).startsWith("note")));
  return { ui, all, field, button, type, click, method, save, note, saved };
}

function fillMachine(d: ReturnType<typeof dialog>): void {
  d.type("Address", "mac-mini.local");
  d.type("User", "robin");
}

describe("Add a machine", () => {
  it("starts on Password: a masked password field with a show toggle, no key file", () => {
    const d = dialog();
    expect(d.method("password").props["aria-pressed"]).toBe(true);
    expect(d.method("key").props["aria-pressed"]).toBe(false);
    expect(d.field("Password")?.props["type"]).toBe("password");
    expect(d.field("Private key file")).toBeUndefined();
    expect(d.field("Key passphrase")).toBeUndefined();
    d.click(d.button("Show"));
    expect(d.field("Password")?.props["type"]).toBe("text");
    d.click(d.button("Hide"));
    expect(d.field("Password")?.props["type"]).toBe("password");
  });

  it("needs a password before Add", async () => {
    const d = dialog();
    fillMachine(d);
    expect(d.save().props["disabled"]).toBe(true);
    d.type("Password", "hunter2");
    expect(d.save().props["disabled"]).toBe(false);
    expect(text(d.save())).toBe("Add");
    d.click(d.save());
    await flush();
    expect(added).toEqual([
      { name: "", host: "mac-mini.local", port: 22, username: "robin", auth: "password", keyPath: "", herdrSession: "default", secret: "hunter2" },
    ]);
    expect(d.saved).toEqual([listed]);
  });

  it("Key file: today's picker and an optional passphrase; needs a key file before Add", async () => {
    const d = dialog();
    fillMachine(d);
    d.click(d.method("key"));
    expect(d.field("Password")).toBeUndefined();
    expect(d.field("Private key file")).toBeDefined();
    expect(d.field("Key passphrase")?.props["type"]).toBe("password");
    expect(d.save().props["disabled"]).toBe(true);
    d.click(d.button("Choose…"));
    await flush();
    expect(d.field("Private key file")?.props["value"]).toBe(pickedKey);
    expect(d.save().props["disabled"]).toBe(false);
    d.click(d.save());
    await flush();
    expect(added[0]).toMatchObject({ auth: "key", keyPath: pickedKey, secret: "" });
    d.type("Key passphrase", "phrase");
    d.click(d.save());
    await flush();
    expect(added[1]).toMatchObject({ auth: "key", secret: "phrase" });
  });

  it("shows what the main process refused, in its words", async () => {
    const d = dialog();
    fillMachine(d);
    d.type("Password", "hunter2");
    failWith = "The port is a number from 1 to 65535.";
    d.click(d.save());
    await flush();
    expect(d.note()).toBe("The port is a number from 1 to 65535.");
    expect(d.saved).toEqual([]);
  });

  it("when passwords cannot be saved here, says why and keeps Add off; a key file still works", () => {
    const d = dialog({ passwordStorage: false });
    fillMachine(d);
    d.type("Password", "hunter2");
    expect(d.save().props["disabled"]).toBe(true);
    expect(d.note()).toMatch(/can't save a password.*key file/);
    d.click(d.method("key"));
    d.type("Private key file", "/keys/id");
    expect(d.save().props["disabled"]).toBe(false);
  });
});

describe("Edit a machine", () => {
  const settings: HostSettings = {
    id: "h1",
    name: "Mac mini",
    host: "mac-mini.local",
    port: 2200,
    username: "robin",
    auth: "password",
    keyPath: "",
    herdrSession: "work",
    secretSaved: true,
  };
  const request: EditHostRequest = {
    id: "h1",
    name: "Mac mini",
    host: "mac-mini.local",
    port: 2200,
    username: "robin",
    auth: "password",
    keyPath: "",
    herdrSession: "work",
    secret: null,
  };

  it("fills in the machine; an empty password keeps the saved one", async () => {
    const d = dialog({ editing: settings });
    expect(d.all().some((e) => e.props["aria-label"] === "Edit machine")).toBe(true);
    expect(d.field("Address")?.props["value"]).toBe("mac-mini.local");
    expect(d.field("Port")?.props["value"]).toBe("2200");
    expect(d.field("Session")?.props["value"]).toBe("work");
    expect(d.field("Password")?.props["value"]).toBe("");
    expect(d.field("Password")?.props["placeholder"]).toMatch(/saved/i);
    expect(text(d.save())).toBe("Save");
    expect(d.save().props["disabled"]).toBe(false);
    d.click(d.save());
    await flush();
    expect(updated).toEqual([request]);
    d.type("Password", "new-one");
    d.click(d.save());
    await flush();
    expect(updated[1]).toMatchObject({ id: "h1", secret: "new-one" });
  });

  it("switching a password machine to a key file sends no password", async () => {
    const d = dialog({ editing: settings });
    d.click(d.method("key"));
    d.type("Private key file", "/keys/id");
    d.click(d.save());
    await flush();
    expect(updated[0]).toMatchObject({ auth: "key", keyPath: "/keys/id", secret: "" });
  });

  it("a key machine's saved passphrase is kept, or forgotten", async () => {
    const d = dialog({ editing: { ...settings, auth: "key", keyPath: "/keys/id" } });
    expect(d.field("Key passphrase")?.props["placeholder"]).toMatch(/saved/i);
    d.click(d.save());
    await flush();
    expect(updated[0]).toMatchObject({ auth: "key", secret: null });
    d.click(d.button("Forget"));
    d.click(d.save());
    await flush();
    expect(updated[1]).toMatchObject({ auth: "key", secret: "" });
  });

  it("a key machine switched to Password needs a password typed", () => {
    const d = dialog({ editing: { ...settings, auth: "key", keyPath: "/keys/id", secretSaved: false } });
    d.click(d.method("password"));
    expect(d.save().props["disabled"]).toBe(true);
    d.type("Password", "pw");
    expect(d.save().props["disabled"]).toBe(false);
  });

  it("Remove asks once more, then removes the machine", async () => {
    const d = dialog({ editing: settings });
    d.click(d.button("Remove…"));
    expect(removed).toEqual([]);
    d.click(d.button("Remove Mac mini"));
    await flush();
    expect(removed).toEqual(["h1"]);
    expect(d.saved).toEqual([listed]);
  });
});

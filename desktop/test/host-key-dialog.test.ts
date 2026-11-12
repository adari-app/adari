// "Trust this Mac?" on the page. The real dialog runs
// on the small hooks host (test/support/fake-hooks.ts) with a fake bridge: it
// shows the machine, the key's type, its SHA256: fingerprint and the check
// line; Trust and connect sends the question's id and that fingerprint back,
// Cancel (or Escape) the machine's id and the question's (an answer names
// the question it answers). The sidebar's Try again shows beside a
// declined key, and Add a machine says the first connection asks.

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { HostKeyQuestion, HostView } from "../src/shared/ipc-contract";
import { buildDesktopSidebar } from "../src/shared/desktop-sidebar";
import { HookHost, elements } from "./support/fake-hooks";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  return { ...actual, ...fakeReact, default: { ...actual, ...fakeReact } };
});

const { HostKeyDialog } = await import("../src/renderer/components/HostKeyDialog");
const { Sidebar } = await import("../src/renderer/components/Sidebar");
const { AddHostDialog } = await import("../src/renderer/components/AddHostDialog");

type Node = { type: unknown; props: Record<string, unknown> };

function text(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  if (typeof node === "object" && node !== null && "props" in node) return text((node as Node).props["children"]);
  return "";
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

const question: HostKeyQuestion = {
  id: "5f0c2a8e-3b1d-4c6f-9a2e-7d4b1c0e8f21",
  host: "mac-mini.local",
  port: 22,
  keyType: "ssh-ed25519",
  typeLabel: "ED25519",
  fingerprint: "SHA256:HQKPG+aLKrfK44cuT+BFQWiL+yqeXHLlqG11jhKEOaw",
  check: "ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub",
};
const listed = [{ id: "mini" }] as HostView[];
let calls: unknown[][] = [];

beforeEach(() => {
  calls = [];
  vi.stubGlobal("window", {
    herdrDesktop: {
      trustHostKey: (hostId: string, questionId: string, fingerprint: string) => (
        calls.push(["trust", hostId, questionId, fingerprint]), Promise.resolve(listed)
      ),
      cancelHostKey: (hostId: string, questionId: string) => (calls.push(["cancel", hostId, questionId]), Promise.resolve(listed)),
    },
  });
});

function dialog() {
  const answered: HostView[][] = [];
  const ui = new HookHost(HostKeyDialog, {
    hostId: "mini",
    name: "Mac mini",
    question,
    onAnswered: (hosts: HostView[]) => answered.push(hosts),
  });
  ui.render();
  const all = (): Node[] => elements(ui.tree) as Node[];
  const button = (label: string): Node | undefined => all().find((e) => e.type === "button" && text(e) === label);
  const click = (node: Node | undefined): void => {
    expect(node).toBeDefined();
    (node!.props["onClick"] as () => void)();
  };
  return { ui, all, button, click, answered };
}

describe("Trust this Mac?", () => {
  it("shows the machine, the key's type, its fingerprint and the check line", () => {
    const d = dialog();
    const shown = d.all().map(text).join("\n");
    const box = d.all().find((e) => e.props["role"] === "alertdialog");
    expect(box?.props["aria-label"]).toBe("Trust this Mac?");
    expect(shown).toContain("Trust this Mac?");
    expect(shown).toContain("Mac mini");
    expect(shown).toContain("mac-mini.local");
    expect(shown).toContain("ED25519");
    expect(shown).toContain(question.fingerprint);
    expect(shown).toContain(question.check);
    expect(d.button("Trust and connect")).toBeDefined();
    expect(d.button("Cancel")).toBeDefined();
  });

  it("Trust and connect sends the question's id and the fingerprint shown", async () => {
    const d = dialog();
    d.click(d.button("Trust and connect"));
    await flush();
    expect(calls).toEqual([["trust", "mini", question.id, question.fingerprint]]);
    expect(d.answered).toEqual([listed]);
  });

  it("Cancel, or Escape, sends the machine and the question's id", async () => {
    const d = dialog();
    d.click(d.button("Cancel"));
    await flush();
    const box = d.all().find((e) => e.props["role"] === "alertdialog")!;
    let prevented = false;
    (box.props["onKeyDown"] as (event: { key: string; preventDefault(): void }) => void)({
      key: "Escape",
      preventDefault: () => (prevented = true),
    });
    await flush();
    expect(prevented).toBe(true);
    expect(calls).toEqual([
      ["cancel", "mini", question.id],
      ["cancel", "mini", question.id],
    ]);
  });
});

describe("Try again beside a declined key", () => {
  it("shows for a declined host key and asks the main process", () => {
    const view = (extra: Partial<HostView>): HostView => ({
      id: "mini",
      name: "Mac mini",
      kind: "ssh",
      address: "robin@mac-mini.local:22",
      platform: null,
      state: "offline",
      error: "Not connected: this Mac's host key was not trusted. Nothing was sent or saved.",
      topology: null,
      fetchedAtMs: null,
      ...extra,
    });
    const retried: string[] = [];
    const render = (hosts: HostView[]) => {
      const ui = new HookHost(Sidebar, {
        sidebar: buildDesktopSidebar(hosts, { nowUnixMs: 0 }),
        selectedKey: null,
        search: null,
        demo: false,
        foldedHosts: new Set<string>(),
        onSelect: () => undefined,
        onRowMenu: () => undefined,
        onToggleHost: () => undefined,
        onHostMenu: () => undefined,
        onRetryHost: (id: string) => retried.push(id),
        onMode: () => undefined,
        onToggleWorkspace: () => undefined,
        onToggleExpanded: () => undefined,
        onToggleSection: () => undefined,
        onSearch: () => undefined,
        onAddHost: () => undefined,
        onNewAgent: () => undefined,
        onWorkspaceMenu: () => undefined,
      });
      ui.render();
      return (elements(ui.tree) as Node[]).find((e) => e.type === "button" && e.props["className"] === "host-retry");
    };
    expect(render([view({ hostKey: question })])).toBeUndefined();
    const button = render([view({ hostKeyDeclined: true })]);
    expect(button).toBeDefined();
    (button!.props["onClick"] as () => void)();
    expect(retried).toEqual(["mini"]);
  });
});

describe("Add a machine", () => {
  it("says the first connection asks before it trusts the machine's key", () => {
    const ui = new HookHost(AddHostDialog, { editing: null, passwordStorage: true, onClose: () => undefined, onSaved: () => undefined });
    ui.render();
    const note = (elements(ui.tree) as Node[]).find(
      (e) => typeof e.props["className"] === "string" && (e.props["className"] as string).startsWith("note"),
    );
    expect(text(note)).toBe("The first connection shows the machine's host key to check and trust; a changed key is refused.");
  });
});

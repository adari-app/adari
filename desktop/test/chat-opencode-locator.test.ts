// How an OpenCode or Kilo pane binds to its session, with fake Herdr snapshots: the id
// Herdr reports (`herdr:opencode` / `herdr:kilo`, Herdr src/agent_resume.rs:249-261), the id an argv names
// (`--session` / `-s`, opencode v1.18.29 packages/opencode/src/cli/cmd/tui.ts:91-95), else the folder
// (Grok's and Cursor's rule: refused when two of the agent's panes in the folder name nothing). The
// commands are checked as text here; chat-opencode-store.test.ts runs them on fixture databases.

import { describe, expect, it } from "vitest";

import {
  chatSessionKey,
  locateCommand,
  makeSessionRef,
  paneSession,
  parseLocateOutput,
  sessionForPane,
  sessionFromArgv,
  sessionRefFromAgentSession,
} from "../src/shared/chat/locator";
import {
  isOpenCodeViewPath,
  kiloAmbiguousNote,
  openCodeAmbiguousNote,
  openCodeAmbiguousReason,
  openCodeDatabaseFormat,
  openCodeFolderSQL,
  parseOpenCodeViewPath,
} from "../src/shared/chat/agents/opencode-locate";
import { chatKinds, chatReadsKind } from "../src/shared/chat/kinds";

const cwd = "/Users/fixture/project";
// session-id.ts: `ses_` + 12 hex (time) + 14 base62.
const id = "ses_6a1f0c2b3d4eAbCdEfGhIjKlMn";
const other = "ses_6a1f0c2b3d4fZyXwVuTsRqPoNm";
const home = "/Users/fixture";
const database = `${home}/.local/share/opencode/opencode.db`;
const kiloDatabase = `${home}/.local/share/kilo/kilo.db`;

describe("opencode locator: the session Herdr reports", () => {
  it("takes `herdr:opencode` and `herdr:kilo` ids, nothing else", () => {
    expect(sessionRefFromAgentSession({ source: "herdr:opencode", agent: "opencode", kind: "id", value: id })).toEqual({ format: "opencode", lookup: { kind: "id", id } });
    expect(sessionRefFromAgentSession({ source: "herdr:kilo", agent: "kilo", kind: "id", value: id })).toEqual({ format: "kilo", lookup: { kind: "id", id } });
    for (const value of ["", "ses_", "ses_short", "11111111-1111-4111-8111-111111111111", `${id}'; rm -rf /`, `ses_${"a".repeat(80)}`, "ses_abc/../def"]) {
      expect(sessionRefFromAgentSession({ source: "herdr:opencode", agent: "opencode", kind: "id", value }), value).toBeNull();
    }
    // Herdr reports an id only (session_ref_from_report): a path or folder from it is not taken.
    expect(sessionRefFromAgentSession({ source: "herdr:opencode", agent: "opencode", kind: "path", value: database })).toBeNull();
    expect(sessionRefFromAgentSession({ source: "herdr:kilo", agent: "kilo", kind: "folder", value: cwd })).toBeNull();
  });

  it("binds a pane to the reported id first, then its argv's, then its folder", () => {
    const reported = sessionForPane({ agent: "opencode", cwd, agentSession: { source: "herdr:opencode", agent: "opencode", kind: "id", value: id } }, { argv: ["opencode", "-s", other] });
    expect(reported).toMatchObject({ source: "herdr:opencode", ref: { format: "opencode", lookup: { kind: "id", id } }, paneFolders: [cwd] });
    const argv = sessionForPane({ agent: "kilo", cwd }, { argv: ["kilo", "--session", other] });
    expect(argv).toMatchObject({ source: "argv", ref: { format: "kilo", lookup: { kind: "id", id: other } } });
    const folder = sessionForPane({ agent: "OpenCode", cwd: cwd + "/" });
    expect(folder).toMatchObject({ source: "folder", ref: { format: "opencode", lookup: { kind: "folder", folder: cwd } } });
    // The report's source names the agent whose store is read (Herdr reports `herdr:kilo` for a Kilo pane).
    expect(sessionForPane({ agent: "kilo", cwd, agentSession: { source: "herdr:opencode", agent: "opencode", kind: "id", value: id } })?.ref.format).toBe("opencode");
  });

  it("reads `--session <id>`, `-s <id>`, `--session=<id>`; `--fork` and a bad id name none", () => {
    expect(sessionFromArgv(["opencode", "--session", id], "opencode")).toEqual({ source: "herdr:opencode", agent: "opencode", kind: "id", value: id });
    expect(sessionFromArgv(["kilo", `--session=${id}`], "kilo")).toEqual({ source: "herdr:kilo", agent: "kilo", kind: "id", value: id });
    expect(sessionFromArgv(["opencode", "-s", id, "--fork"], "opencode")).toBeNull();
    expect(sessionFromArgv(["opencode", "-s", "--continue"], "opencode")).toBeNull();
    expect(sessionFromArgv(["opencode", "--continue"], "opencode")).toBeNull();
  });
});

describe("opencode locator: the folder rule", () => {
  it("refuses two panes of the agent in one folder that name nothing, with the agent's note", () => {
    const two = { agents: [{ paneID: "p1", agent: "opencode", cwd }, { paneID: "p2", agent: "opencode", cwd }], panes: [] };
    expect(paneSession(two, "p1")).toBe("ambiguous");
    expect(openCodeAmbiguousReason("opencode")).toBe("ambiguousOpenCodeSession");
    expect(openCodeAmbiguousReason("Kilo")).toBe("ambiguousKiloSession");
    expect(openCodeAmbiguousReason("cursor")).toBeNull();
    expect(openCodeAmbiguousNote).toBe("Two OpenCode sessions are open in this folder, so Chat can't tell which is this pane's");
    expect(kiloAmbiguousNote).toBe("Two Kilo sessions are open in this folder, so Chat can't tell which is this pane's");
    // A Kilo pane in the same folder is not an OpenCode peer; nor is one in another folder.
    expect(paneSession({ agents: [{ paneID: "p1", agent: "opencode", cwd }, { paneID: "p2", agent: "kilo", cwd }], panes: [] }, "p1")).toMatchObject({ source: "folder" });
    expect(paneSession({ agents: [{ paneID: "p1", agent: "opencode", cwd }, { paneID: "p2", agent: "opencode", cwd: "/Users/fixture/elsewhere" }], panes: [] }, "p1")).toMatchObject({ source: "folder" });
  });

  it("skips the sessions its peers name; a pane naming its own is not refused", () => {
    const machine = {
      agents: [
        { paneID: "p1", agent: "opencode", cwd },
        { paneID: "p2", agent: "opencode", cwd, agentSession: { source: "herdr:opencode", agent: "opencode", kind: "id", value: other } },
      ],
      panes: [],
    };
    const mine = paneSession(machine, "p1");
    expect(mine !== "ambiguous" && mine !== null ? mine.ref.lookup : null).toEqual({ kind: "folder", folder: cwd, exclude: [other] });
    expect(paneSession(machine, "p2")).toMatchObject({ source: "herdr:opencode", ref: { lookup: { kind: "id", id: other } } });
    expect(chatSessionKey(mine as Exclude<typeof mine, "ambiguous" | null>)).toContain(other);
  });

  it("asks V2's table, then V1's, for the folder's newest root session, quoting the folder and the peers' ids", () => {
    const sql = openCodeFolderSQL("/Users/o'brien/p/", [other], "session_v2");
    expect(sql).toBe(
      `select 'v2 '||id from session_v2 where directory='/Users/o''brien/p' and parent_id is null and id not in ('${other}') order by time_updated desc, id desc limit 1;`,
    );
    const ref = makeSessionRef("opencode", { kind: "folder", folder: cwd })!;
    const command = locateCommand(ref)!;
    expect(command.startsWith("/bin/sh -c ")).toBe(true);
    expect(command).toContain("mode=ro");
    expect(command).toContain("-readonly");
    for (const word of [" rm ", " mv ", "touch", " tee ", " >", "mkdir", "sqlite3 -cmd"]) expect(command.includes(word), word).toBe(false);
    expect(locateCommand(makeSessionRef("kilo", { kind: "id", id })!)).toContain("'kilo.db'");
    // Too many peers, or an exclusion that is not an id, is refused.
    expect(makeSessionRef("opencode", { kind: "folder", folder: cwd, exclude: Array.from({ length: 65 }, (_, index) => `ses_${String(index).padStart(26, "0")}`) })).toBeNull();
    expect(makeSessionRef("opencode", { kind: "folder", folder: cwd, exclude: ["x'); drop table session; --"] })).toBeNull();
    expect(makeSessionRef("opencode", { kind: "folder", folder: "relative/folder" })).toBeNull();
  });
});

describe("opencode locator: the view path", () => {
  it("is `<database>/<session id>` under `.local/share/<app>/<app>.db` only", () => {
    expect(parseOpenCodeViewPath(`${database}/${id}`)).toEqual({ format: "opencode", database, session: id });
    expect(parseOpenCodeViewPath(`${kiloDatabase}/${id}`)).toEqual({ format: "kilo", database: kiloDatabase, session: id });
    expect(openCodeDatabaseFormat(database)).toBe("opencode");
    for (const path of [
      `${home}/.local/share/opencode/kilo.db/${id}`,
      `${home}/.local/share/opencode/opencode.db/not-an-id`,
      `${home}/.local/share/../share/opencode/opencode.db/${id}`,
      `relative/.local/share/opencode/opencode.db/${id}`,
      `${home}/.cursor/chats/x/${id}`,
      `${home}/.local/share/opencode/opencode.db`,
    ]) {
      expect(isOpenCodeViewPath(path), path).toBe(false);
    }
  });

  it("takes only the session asked for, or one not excluded, of the same agent", () => {
    const byID = makeSessionRef("opencode", { kind: "id", id })!;
    expect(parseLocateOutput(`${database}/${id}\n`, byID)).toBe(`${database}/${id}`);
    expect(parseLocateOutput(`${database}/${other}\n`, byID)).toBeNull();
    expect(parseLocateOutput(`${kiloDatabase}/${id}\n`, byID)).toBeNull();
    const folder = makeSessionRef("opencode", { kind: "folder", folder: cwd, exclude: [other] })!;
    expect(parseLocateOutput(`${database}/${id}\n`, folder)).toBe(`${database}/${id}`);
    expect(parseLocateOutput(`${database}/${other}\n`, folder)).toBeNull();
    expect(parseLocateOutput("", folder)).toBeNull();
    // A path lookup of the agent's view is taken as it is (no command).
    const path = makeSessionRef("opencode", { kind: "path", path: `${database}/${id}` })!;
    expect(locateCommand(path)).toBeNull();
    expect(makeSessionRef("opencode", { kind: "path", path: `${kiloDatabase}/${id}` })).toBeNull();
  });
});

describe("opencode locator: the kinds Chat reads", () => {
  it("lists opencode and kilo beside the readers before", () => {
    // The other readers' kinds are in the list too.
    expect(chatKinds).toEqual(expect.arrayContaining(["claude", "codex", "grok", "cursor", "opencode", "kilo"]));
    expect(chatReadsKind("OpenCode")).toBe(true);
    expect(chatReadsKind("kilo")).toBe(true);
    expect(chatReadsKind("aider")).toBe(false);
  });
});

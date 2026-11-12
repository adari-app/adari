// Send to… (App/CompanionHandoffModel.swift): a reply, a progress
// update, a code block, a selection or one of your own messages goes from one
// agent's chat to another pane in one action. This file is the pure part:
// what is sent and how it is written, the 64 KB bound, a draft already in the
// target's box kept, the recent targets, the list the picker shows, its
// highlight, what a pick is bound to (the program the row showed, on the
// connection it was listed on, in the run the page saw) and the toasts' words.

import type { SessionTopology } from "../main/herdr/wire";
import type { HostRun } from "./ipc-contract";
import { isPaneChangedNote } from "./send-binding";
import { agentIn, runsAgentIn, type PaneLife } from "./pane-life";
import {
  buildSidebarModel,
  emptyFoldState,
  searchFold,
  sidebarInputFromTopology,
  type SidebarFoldState,
  type SidebarGlyph,
} from "./sidebar-model";

// MARK: - What is sent

/** What a selection in a reply is: prose, code inside one block, or both (sent as written). */
export type HandoffSelectionKind =
  | { readonly type: "prose" }
  | { readonly type: "code"; readonly language: string | null }
  | { readonly type: "mixed" };

/** What the text is, which decides how it is written for the target. */
export type HandoffKind =
  /** An agent's whole reply, its markdown as written. */
  | { readonly type: "reply" }
  /** A progress update between tool calls, as written (the desktop's progress row). */
  | { readonly type: "progress" }
  /** A code block's code, exactly as written; it goes in a fence with its language. */
  | { readonly type: "code"; readonly language: string | null }
  /** Part of a reply you selected. */
  | { readonly type: "selection"; readonly selection: HandoffSelectionKind }
  /** One of your own messages, sent again elsewhere as you wrote it (no context line). */
  | { readonly type: "ownMessage" };

/** The pane the text comes from, as the sidebar names it. */
export interface HandoffSource {
  readonly hostId: string;
  readonly paneId: string;
  /** The pane's name as its sidebar row shows it. */
  readonly name: string;
  /** `claude`, `codex`, … or the shell's kind. */
  readonly kind: string;
  readonly workspace: string | null;
  readonly macName: string | null;
}

export interface HandoffPayload {
  readonly text: string;
  readonly kind: HandoffKind;
  readonly source: HandoffSource;
}

// MARK: - How it is written

/** The most a hand-off carries: 64 KB of UTF-8, the context line and any fence or quote marks included. */
export const handoffLimitBytes = 64 * 1024;

export function nonEmpty(text: string | null | undefined): string | null {
  return text === null || text === undefined || text.trim() === "" ? null : text;
}

/** `From claude in aurora-web (Mac mini):`, without the workspace or the machine when not known. */
export function contextLine(source: HandoffSource): string {
  let line = `From ${source.name}`;
  const workspace = nonEmpty(source.workspace);
  if (workspace !== null) line += ` in ${workspace}`;
  const mac = nonEmpty(source.macName);
  if (mac !== null) line += ` (${mac})`;
  return `${line}:`;
}

/** The line break the text writes ("\r\n" when it has one), for the lines added around it. */
export function lineBreakOf(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

export interface TextLine {
  readonly content: string;
  /** "\r\n", "\n", "\r" or "" for the last. */
  readonly terminator: string;
}

/** The text's lines, each with the line end it had. */
export function linesOf(text: string): TextLine[] {
  const result: TextLine[] = [];
  let current = "";
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]!;
    if (c === "\r") {
      if (text[i + 1] === "\n") {
        result.push({ content: current, terminator: "\r\n" });
        i += 1;
      } else {
        result.push({ content: current, terminator: "\r" });
      }
      current = "";
    } else if (c === "\n") {
      result.push({ content: current, terminator: "\n" });
      current = "";
    } else {
      current += c;
    }
  }
  if (current !== "" || result.length === 0) result.push({ content: current, terminator: "" });
  return result;
}

/** The longest run of backticks a line opens with (after up to three spaces). */
export function longestOpeningBackticks(text: string): number {
  let longest = 0;
  for (const line of linesOf(text)) {
    const content = line.content.replace(/^ */, "");
    if (line.content.length - content.length > 3) continue;
    const run = /^`*/.exec(content)![0].length;
    longest = Math.max(longest, run);
  }
  return longest;
}

/**
 * The code in a fence with its language. The fence is longer than any run of
 * backticks that opens a line of the code; the code keeps its line ends, and a
 * closing fence follows its last line break (one is added when it has none).
 */
export function fenced(code: string, language: string | null): string {
  const fence = "`".repeat(Math.max(3, longestOpeningBackticks(code) + 1));
  const lineBreak = lineBreakOf(code);
  const info = nonEmpty(language)?.trim() ?? "";
  const last = code.at(-1);
  const ending = last === "\n" || last === "\r" ? "" : lineBreak;
  return fence + info + lineBreak + code + ending + fence;
}

/** Prose quoted: `> ` before each line (`>` alone before an empty one), every line end kept. */
export function quoted(prose: string): string {
  return linesOf(prose)
    .map((line) => (line.content === "" ? ">" : `> ${line.content}`) + line.terminator)
    .join("");
}

/** The text written for its kind (no context line). */
export function handoffBody(text: string, kind: HandoffKind): string {
  switch (kind.type) {
    case "reply":
    case "progress":
    case "ownMessage":
      return text;
    case "code":
      return fenced(text, kind.language);
    case "selection":
      switch (kind.selection.type) {
        case "prose":
          return quoted(text);
        case "code":
          return fenced(text, kind.selection.language);
        case "mixed":
          return text;
      }
  }
}

/** What lands in the target: the context line, a line break and the body; your own message as you wrote it. */
export function handoffMessage(payload: HandoffPayload): string {
  const body = handoffBody(payload.text, payload.kind);
  if (payload.kind.type === "ownMessage") return body;
  return contextLine(payload.source) + lineBreakOf(payload.text) + body;
}

/** The bytes it carries (UTF-8). */
export function utf8Size(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function fits(message: string): boolean {
  return utf8Size(message) <= handoffLimitBytes;
}

/** Whole KB, rounded up (65,537 bytes read 65 KB). */
export function kilobytes(bytes: number): number {
  return Math.floor((bytes + 1023) / 1024);
}

export function tooLongText(bytes: number): string {
  return `Too long to send (${kilobytes(bytes)} KB); copy it instead`;
}

/** What is being sent, in a few words ("Code block · swift · 3 lines"). */
export function payloadSummary(payload: HandoffPayload): string {
  let what: string;
  switch (payload.kind.type) {
    case "reply":
      what = "Reply";
      break;
    case "progress":
      what = "Progress update";
      break;
    case "code": {
      const language = nonEmpty(payload.kind.language);
      what = language === null ? "Code block" : `Code block · ${language}`;
      break;
    }
    case "selection":
      what = "Selection";
      break;
    case "ownMessage":
      what = "Your message";
  }
  const lines = linesOf(payload.text).filter((line) => line.content !== "" || line.terminator !== "").length;
  return `${what} · ${lines === 1 ? "1 line" : `${Math.max(lines, 1)} lines`}`;
}

/** The first line with text in it, for the preview. */
export function firstLine(text: string): string {
  return linesOf(text).map((line) => line.content).find((line) => line.trim() !== "")?.trim() ?? "";
}

// MARK: - A selection in a reply

export interface FencedBlock {
  /** The code between the fences (UTF-16 offsets into the markdown), [start, end). */
  readonly code: readonly [number, number];
  /** The whole block, its fence lines included. */
  readonly whole: readonly [number, number];
  readonly language: string | null;
}

/** The fenced code blocks (``` or ~~~, three or more; closed by the same character at least as long; an unclosed one runs to the end). */
export function fencedBlocks(markdown: string): FencedBlock[] {
  const blocks: FencedBlock[] = [];
  let offset = 0;
  let open: { marker: string; length: number; start: number; codeStart: number; language: string | null } | null = null;
  for (const line of linesOf(markdown)) {
    const lineLength = line.content.length + line.terminator.length;
    const trimmed = line.content.replace(/^ */, "");
    const indent = line.content.length - trimmed.length;
    const first = trimmed[0];
    if (indent <= 3 && (first === "`" || first === "~")) {
      const run = new RegExp(`^\\${first}*`).exec(trimmed)![0].length;
      if (run >= 3) {
        if (open !== null) {
          if (first === open.marker && run >= open.length && /^[ \t]*$/.test(trimmed.slice(run))) {
            blocks.push({ code: [open.codeStart, offset], whole: [open.start, offset + lineLength], language: open.language });
            open = null;
            offset += lineLength;
            continue;
          }
        } else {
          const info = trimmed.slice(run).trim();
          const language = info.split(" ")[0] ?? "";
          open = { marker: first, length: run, start: offset, codeStart: offset + lineLength, language: language === "" ? null : language };
          offset += lineLength;
          continue;
        }
      }
    }
    offset += lineLength;
  }
  if (open !== null) blocks.push({ code: [open.codeStart, offset], whole: [open.start, offset], language: open.language });
  return blocks;
}

/** What the selection [start, end) of `markdown` is: code inside one block's code, prose touching no block, mixed otherwise. */
export function selectionKindIn(markdown: string, start: number, end: number): HandoffSelectionKind {
  const blocks = fencedBlocks(markdown);
  for (const block of blocks) {
    if (block.code[0] <= start && end <= block.code[1]) return { type: "code", language: block.language };
  }
  const touches = blocks.some((block) =>
    start === end ? block.whole[0] <= start && start < block.whole[1] : block.whole[0] < end && start < block.whole[1],
  );
  return touches ? { type: "mixed" } : { type: "prose" };
}

/**
 * The same question for a selection in the rendered reply (the desktop's
 * chat shows markdown as elements, not its source): each end's code block
 * (its language, null for none named; undefined: the end is not in a code
 * block's code) and whether it takes in any code block.
 */
export function selectionKindOfEnds(
  start: { readonly inCode: boolean; readonly language: string | null; readonly block: unknown },
  end: { readonly inCode: boolean; readonly language: string | null; readonly block: unknown },
  touchesCode: boolean,
): HandoffSelectionKind {
  if (start.inCode && end.inCode && start.block === end.block) return { type: "code", language: start.language };
  return touchesCode || start.inCode || end.inCode ? { type: "mixed" } : { type: "prose" };
}

// MARK: - The draft already in the target's box

export interface Landing {
  /** The box's text after the hand-off. */
  readonly text: string;
  /** Where the hand-off starts in it (UTF-16): the cursor goes there. */
  readonly start: number;
  /** A draft was there and kept: the hand-off went after it. */
  readonly appended: boolean;
}

/** Line breaks ending the text ("\r\n" counts once), white space between them ignored. */
export function trailingBreaks(text: string): number {
  let count = 0;
  const lines = linesOf(text);
  if (lines.at(-1)?.terminator === "") {
    if (lines.at(-1)!.content.trim() !== "") return 0;
    lines.pop();
  }
  for (const line of [...lines].reverse()) {
    count += 1;
    if (line.content.trim() !== "") break;
  }
  return count;
}

/**
 * The hand-off in the target's box: alone when the box holds no draft (nothing,
 * or white space only); after the draft and one blank line otherwise, the draft
 * never changed (only the missing breaks added, in its line-break style).
 */
export function land(handoff: string, existing: string | null | undefined): Landing {
  if (existing === null || existing === undefined || existing.trim() === "") return { text: handoff, start: 0, appended: false };
  const lineBreak = lineBreakOf(existing);
  const separator = lineBreak.repeat(Math.max(0, 2 - trailingBreaks(existing)));
  const head = existing + separator;
  return { text: head + handoff, start: head.length, appended: true };
}

// MARK: - Recent targets

export interface HandoffRecent {
  readonly hostId: string;
  readonly paneId: string;
}

export const recentsKey = "adari.handoff.recents";
export const recentsLimit = 5;

const sameRecent = (a: HandoffRecent, b: HandoffRecent): boolean => a.hostId === b.hostId && a.paneId === b.paneId;

/** `recent` first, once, the rest after it, at most five. */
export function addingRecent(recent: HandoffRecent, list: readonly HandoffRecent[]): HandoffRecent[] {
  return [recent, ...list.filter((other) => !sameRecent(other, recent))].slice(0, recentsLimit);
}

/** The storage the recents live in (this window's localStorage in the app; a fake in tests). */
export interface RecentsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The last five targets picked on this computer, newest first (never synced). */
export class HandoffRecents {
  constructor(private readonly storage: RecentsStorage | null) {}

  list(): HandoffRecent[] {
    try {
      const raw: unknown = JSON.parse(this.storage?.getItem(recentsKey) ?? "[]");
      if (!Array.isArray(raw)) return [];
      return raw
        .filter(
          (item): item is HandoffRecent =>
            typeof item === "object" && item !== null && typeof item.hostId === "string" && typeof item.paneId === "string",
        )
        .map((item) => ({ hostId: item.hostId, paneId: item.paneId }))
        .slice(0, recentsLimit);
    } catch {
      return [];
    }
  }

  record(recent: HandoffRecent): void {
    try {
      this.storage?.setItem(recentsKey, JSON.stringify(addingRecent(recent, this.list())));
    } catch {
      // Not kept: the picker works without its recent targets.
    }
  }
}

// MARK: - What a row showed

/**
 * What a pane of a connected machine showed when it was listed: the connection
 * it was listed on, the terminal in it, the agent there (its kind and session;
 * none for a shell) and the agent's run as the page saw it. A pick is carried
 * out only while the pane shows the same, on the same connection.
 */
export interface HandoffIdentity {
  /** The machine's connection generation (PaneLife.connection). */
  readonly connection: number;
  readonly terminalID: string;
  /** The agent's kind ("codex"); null: none (a shell). */
  readonly agent: string | null;
  /** The agent's Herdr session; null when Herdr reports none. */
  readonly session: string | null;
  /** The pane's agent run (PaneLife.arrival). */
  readonly arrival: number;
  /** The main process's connection and agent run for the pane (HostView.run), which its Send checks. */
  readonly run?: { readonly connection: number; readonly arrival: number };
}

/** The same program: the same terminal and agent (or none), the same run, the same session where both are known. */
export function sameProgram(a: HandoffIdentity, b: HandoffIdentity): boolean {
  return (
    a.terminalID === b.terminalID &&
    a.agent === b.agent &&
    a.arrival === b.arrival &&
    (a.run === undefined || b.run === undefined || (a.run.connection === b.run.connection && a.run.arrival === b.run.arrival)) &&
    (a.session === null || b.session === null || a.session === b.session)
  );
}

/** What each pane of `topology` shows, on `connection`; `arrival`: the run of a pane's agent as the page saw it. */
export function identitiesOf(
  topology: SessionTopology,
  connection: number,
  arrival: (paneID: string) => number = () => 0,
  run?: HostRun,
): Map<string, HandoffIdentity> {
  const identities = new Map<string, HandoffIdentity>();
  for (const pane of topology.panes) {
    if (identities.has(pane.paneID)) continue;
    const info = agentIn(pane, topology);
    const runs = runsAgentIn(pane, topology);
    const session = info?.agentSession?.value;
    identities.set(pane.paneID, {
      connection,
      terminalID: pane.terminalID,
      agent: runs ? (info?.agent ?? pane.agent ?? "agent").toLowerCase() : null,
      session: runs && session !== undefined && session !== "" ? session : null,
      arrival: arrival(pane.paneID),
      ...(run === undefined ? {} : { run: { connection: run.connection, arrival: run.arrivals[pane.paneID] ?? 0 } }),
    });
  }
  return identities;
}

// MARK: - The targets

/** A pane the text can go to, as the sidebar shows it. */
export interface HandoffTarget {
  readonly hostId: string;
  readonly macName: string;
  readonly paneId: string;
  readonly workspaceId: string;
  readonly workspace: string;
  readonly name: string;
  readonly kind: string;
  readonly isAgent: boolean;
  readonly folder: string | null;
  readonly glyph: SidebarGlyph;
  /** Null while its machine answers; else "Offline" or "Not connected": not pickable. */
  readonly macState: string | null;
  /** What the row showed, on the connected machine (null elsewhere). */
  readonly identity: HandoffIdentity | null;
}

export const targetId = (target: Pick<HandoffTarget, "hostId" | "paneId">): string => `${target.hostId}|${target.paneId}`;
export const isPickable = (target: HandoffTarget): boolean => target.macState === null;
/** "codex in herdr-companion": what the toasts call it. */
export const targetTitle = (target: HandoffTarget): string => `${target.name} in ${target.workspace}`;

export function statusWord(glyph: SidebarGlyph): string {
  switch (glyph) {
    case "needsYou":
      return "Needs you";
    case "working":
      return "Working";
    case "doneUnseen":
      return "Done";
    case "idle":
      return "Ready";
    case "unknown":
      return "Status unknown";
    case "shell":
      return "Shell";
  }
}

/** What a screen reader reads for a row. */
export function targetLabel(target: HandoffTarget): string {
  const parts = [target.name];
  if (target.kind !== target.name) parts.push(target.kind);
  parts.push(statusWord(target.glyph));
  parts.push(`${target.workspace} on ${target.macName}`);
  if (target.macState !== null) parts.push(`${target.macState}, cannot be picked`);
  return parts.join(", ");
}

export interface HandoffPane {
  readonly paneId: string;
  readonly name: string;
  readonly kind: string;
  readonly isAgent: boolean;
  readonly folder: string | null;
  readonly glyph: SidebarGlyph;
  readonly identity: HandoffIdentity | null;
}

/** One machine's panes, as the page knows them now. */
export interface HandoffMac {
  readonly hostId: string;
  readonly name: string;
  /** Null: answering. Else "Offline" or "Not connected": its panes show and cannot be picked. */
  readonly state: string | null;
  readonly workspaces: readonly { readonly id: string; readonly label: string; readonly panes: readonly HandoffPane[] }[];
}

export const offlineState = "Offline";
export const notConnectedState = "Not connected";

/** What the handoff needs of a machine (HostView has it). */
export interface HandoffHost {
  readonly id: string;
  readonly name: string;
  readonly address: string;
  readonly state: "connecting" | "connected" | "offline";
  readonly topology: SessionTopology | null;
  /** The main process's counts (HostView.run). */
  readonly run?: HostRun;
}

/** The fold that shows every pane of a machine: Projects, every workspace open and expanded. */
export function everyPaneFold(macID: string, topology: SessionTopology): SidebarFoldState {
  const ids = [...new Set(topology.workspaces.map((workspace) => workspace.workspaceID))].sort();
  return { ...emptyFoldState, mode: "projects", expandedWorkspaces: ids.length === 0 ? {} : { [macID]: ids } };
}

/**
 * Every machine the page lists, each with its panes as its sidebar has them
 * (every workspace open, the sidebar's names and glyphs). A machine answering
 * now has each pane's identity; one offline or connecting shows its last
 * snapshot, not pickable. A machine with no snapshot yet is left out.
 */
export function handoffMacs(
  hosts: readonly HandoffHost[],
  life: Pick<PaneLife, "connection" | "arrival">,
  options: { readonly nowUnixMs: number; readonly seenDone?: Readonly<Record<string, ReadonlySet<string>>> },
): HandoffMac[] {
  const macs: HandoffMac[] = [];
  for (const host of hosts) {
    if (host.topology === null) continue;
    const state = host.state === "connected" ? null : host.state === "offline" ? offlineState : notConnectedState;
    const identities =
      state === null ? identitiesOf(host.topology, life.connection(host.id), (paneID) => life.arrival(host, paneID), host.run) : new Map();
    const model = buildSidebarModel(
      sidebarInputFromTopology(host.topology, {
        macID: host.id,
        fold: everyPaneFold(host.id, host.topology),
        search: "",
        nowUnixMs: options.nowUnixMs,
        seenDonePaneIDs: options.seenDone?.[host.id],
      }),
    );
    macs.push({
      hostId: host.id,
      name: host.name,
      state,
      workspaces: model.projects.map((section) => ({
        id: section.header.workspaceID,
        label: section.header.label,
        panes: section.rows.map((row) => ({
          paneId: row.paneID,
          name: row.name,
          kind: row.kind,
          isAgent: row.isAgent,
          folder: row.cwd ?? null,
          glyph: row.glyph,
          identity: identities.get(row.paneID) ?? null,
        })),
      })),
    });
  }
  return macs;
}

/** The pane `paneId` as `mac` lists it, if listed. */
export function paneOf(mac: HandoffMac, paneId: string): HandoffPane | null {
  for (const workspace of mac.workspaces) {
    const pane = workspace.panes.find((candidate) => candidate.paneId === paneId);
    if (pane !== undefined) return pane;
  }
  return null;
}

export interface HandoffGroup {
  readonly hostId: string;
  readonly macName: string;
  readonly macState: string | null;
  readonly workspaceId: string;
  readonly workspace: string;
  readonly targets: readonly HandoffTarget[];
}

export interface HandoffList {
  readonly recent: readonly HandoffTarget[];
  readonly groups: readonly HandoffGroup[];
}

export const emptyHandoffList: HandoffList = { recent: [], groups: [] };

/** Every row in the order shown (the recent ones first). */
export function listRows(list: HandoffList): HandoffTarget[] {
  return [...list.recent, ...list.groups.flatMap((group) => group.targets)];
}

/** Every word of the query is in the name, the kind, the folder or the workspace (case and accents aside). */
export function matchesQuery(target: HandoffTarget, query: string): boolean {
  const words = query.split(/\s+/).filter((word) => word !== "");
  if (words.length === 0) return true;
  const fields = [target.name, target.kind, target.folder ?? "", target.workspace].map(searchFold);
  return words.every((word) => fields.some((field) => field.includes(searchFold(word))));
}

/**
 * The list for `macs` (the answering ones first, then the others, each by
 * name), without the pane the text comes from, filtered by `query`; agents
 * first in each workspace; a recent target listed once, in Recent, while its
 * pane is still there.
 */
export function handoffList(
  macs: readonly HandoffMac[],
  current: HandoffRecent | null,
  recents: readonly HandoffRecent[],
  query: string,
): HandoffList {
  const ordered = macs
    .map((mac, index) => ({ mac, index }))
    .sort((a, b) => {
      const sa = a.mac.state === null ? 0 : 1;
      const sb = b.mac.state === null ? 0 : 1;
      if (sa !== sb) return sa - sb;
      const na = a.mac.name.toLowerCase();
      const nb = b.mac.name.toLowerCase();
      if (na !== nb) return na < nb ? -1 : 1;
      return a.index - b.index;
    })
    .map((entry) => entry.mac);
  const all: HandoffTarget[] = [];
  const groups: HandoffGroup[] = [];
  for (const mac of ordered) {
    for (const workspace of mac.workspaces) {
      const targets = workspace.panes
        .map(
          (pane): HandoffTarget => ({
            hostId: mac.hostId,
            macName: mac.name,
            paneId: pane.paneId,
            workspaceId: workspace.id,
            workspace: workspace.label,
            name: pane.name,
            kind: pane.kind,
            isAgent: pane.isAgent,
            folder: pane.folder,
            glyph: pane.glyph,
            macState: mac.state,
            identity: pane.identity,
          }),
        )
        .filter((target) => !(current !== null && sameRecent(target, current)) && matchesQuery(target, query));
      const sorted = [...targets.filter((target) => target.isAgent), ...targets.filter((target) => !target.isAgent)];
      all.push(...sorted);
      groups.push({ hostId: mac.hostId, macName: mac.name, macState: mac.state, workspaceId: workspace.id, workspace: workspace.label, targets: sorted });
    }
  }
  const byId = new Map<string, HandoffTarget>();
  for (const target of all) if (!byId.has(targetId(target))) byId.set(targetId(target), target);
  const seen = new Set<string>();
  const recent: HandoffTarget[] = [];
  for (const key of recents.slice(0, recentsLimit)) {
    const id = targetId(key);
    if (seen.has(id)) continue;
    seen.add(id);
    const target = byId.get(id);
    if (target !== undefined) recent.push(target);
  }
  const inRecent = new Set(recent.map(targetId));
  const shown = groups
    .map((group) => ({ ...group, targets: group.targets.filter((target) => !inRecent.has(targetId(target))) }))
    .filter((group) => group.targets.length > 0);
  return { recent, groups: shown };
}

// MARK: - The picker's highlight

/** The row ↑ and ↓ move to and Return picks: only pickable rows, from the first one, stopping at either end. */
export const highlight = {
  /** The same row while still listed and pickable, else the first pickable one. */
  settle(id: string | null, rows: readonly HandoffTarget[]): string | null {
    if (id !== null && rows.some((row) => targetId(row) === id && isPickable(row))) return id;
    const first = rows.find(isPickable);
    return first === undefined ? null : targetId(first);
  },
  move(id: string | null, step: number, rows: readonly HandoffTarget[]): string | null {
    const pickable = rows.filter(isPickable);
    if (pickable.length === 0) return null;
    const index = pickable.findIndex((row) => targetId(row) === id);
    if (index < 0) return targetId(pickable[0]!);
    return targetId(pickable[Math.min(Math.max(index + step, 0), pickable.length - 1)]!);
  },
  target(id: string | null, rows: readonly HandoffTarget[]): HandoffTarget | null {
    return rows.find((row) => targetId(row) === id && isPickable(row)) ?? null;
  },
};

// MARK: - A pick checked

/** What a pick does: the target opens with the text in its box, or the text goes now (⌘Return). */
export type HandoffAction = "draft" | "sendNow";

export type HandoffRefusal =
  | { readonly type: "notConnected" }
  | { readonly type: "reconnected" }
  | { readonly type: "closed" }
  | { readonly type: "replaced"; readonly now: string }
  | { readonly type: "another" };

/**
 * Why `picked` cannot be carried out now (null: it can). `connection`: the
 * generation of its machine's connection now (null: not answering); `now`: the
 * pane as that machine lists it now (null: not listed).
 */
export function refusalFor(picked: HandoffTarget, now: HandoffPane | null, connection: number | null): HandoffRefusal | null {
  const identity = picked.identity;
  if (connection === null || identity === null) return { type: "notConnected" };
  if (identity.connection !== connection) return { type: "reconnected" };
  if (now === null || now.identity === null) return { type: "closed" };
  if (sameProgram(identity, now.identity)) return null;
  return now.kind === picked.kind ? { type: "another" } : { type: "replaced", now: now.kind };
}

// MARK: - What the toast says

export const handoffNotice = {
  refused(target: HandoffTarget, refusal: HandoffRefusal, action: HandoffAction): string {
    let why: string;
    switch (refusal.type) {
      case "notConnected":
        why = `${target.macName} is not connected`;
        break;
      case "reconnected":
        why = `${target.macName} reconnected after the pick`;
        break;
      case "closed":
        why = `${target.name} is closed`;
        break;
      case "replaced":
        why = `${target.name} now runs ${refusal.now}, not ${target.kind}`;
        break;
      case "another":
        why = `${target.name} now runs another ${target.kind}`;
    }
    return `${why}: ${action === "sendNow" ? "not sent" : "not put in its box"}. The text is copied.`;
  },
  sent: (target: HandoffTarget): string => `Sent to ${targetTitle(target)}`,
  notSent: (target: HandoffTarget, reason: string): string =>
    `Not sent to ${targetTitle(target)}. ${sentence(reason.replace(/ The text is kept\.$/, ""))} The text is in its message box.`,
  unconfirmed: (target: HandoffTarget, reason: string): string => `Maybe sent to ${targetTitle(target)}. ${sentence(reason)}`,
  /** The pane is not the one picked any more: nothing went and nothing is put in any box. */
  stale: (target: HandoffTarget, reason: string): string =>
    `Not sent to ${targetTitle(target)}. ${sentence(reason.replace(/ The text is kept\.$/, "").replace(/^Not run: /, ""))} The text is copied.`,
  appended: (target: HandoffTarget): string => `Added to ${targetTitle(target)} after the draft already in its box`,
};

/** The reason as a sentence of its own ("Not sent: …" loses its lead). */
export function sentence(reason: string): string {
  let text = reason.trim();
  for (const lead of ["Not sent: ", "Not queued: "]) {
    if (text.startsWith(lead)) text = text.slice(lead.length);
  }
  if (text === "") return "";
  text = text[0]!.toUpperCase() + text.slice(1);
  return text.endsWith(".") ? text : `${text}.`;
}

/**
 * A Send now the main process did not carry out: refused (nothing went: the
 * text goes to the target's box) or not confirmed (it may have arrived: never
 * put in the box to go twice). The main process's notes say which
 * (src/main/herdr/send.ts): a refusal says "Not sent", "Not run" or "…; not sent".
 * A stale one (the picked connection or run is gone)
 * puts nothing in any box: the pane holds another program now.
 */
export function sendFailure(note: string): "stale" | "refused" | "unconfirmed" {
  const text = note.trim();
  if (isPaneChangedNote(text)) return "stale";
  return /^Not (sent|run)\b/.test(text) || /; not sent\.?$/.test(text) ? "refused" : "unconfirmed";
}

// MARK: - The picker's state

/**
 * The picker's state (CompanionHandoffPickerModel): the list for the filter,
 * the highlighted row, the bound, and what each key and click does. A click on
 * a row opens it with the draft at once; Return does the same for the
 * highlighted row, ⌘Return sends now. A picker acts once; the row ↑ ↓ picked
 * stays as it was picked until you pick again, whatever a refresh shows; a
 * pick is checked against the panes as they are now before it goes, and the
 * delivery refuses one whose pane changed since.
 */
export class HandoffPicker {
  readonly message: string;
  readonly bytes: number;
  readonly fits: boolean;
  query = "";
  list: HandoffList = emptyHandoffList;
  highlighted: string | null = null;
  copied = false;
  private acted = false;
  private selection: HandoffTarget | null = null;

  constructor(
    readonly payload: HandoffPayload,
    private readonly macs: () => readonly HandoffMac[],
    private readonly recents: readonly HandoffRecent[],
    private readonly current: HandoffRecent | null,
    private readonly act: (target: HandoffTarget, action: HandoffAction) => void,
    private readonly copyText: (text: string) => void,
  ) {
    this.message = handoffMessage(payload);
    this.bytes = utf8Size(this.message);
    this.fits = this.bytes <= handoffLimitBytes;
    this.refresh();
  }

  get hasActed(): boolean {
    return this.acted;
  }

  get rows(): HandoffTarget[] {
    return listRows(this.list);
  }

  setQuery(query: string): void {
    if (query === this.query) return;
    this.query = query;
    this.refresh();
  }

  /** The list again (the filter changed, or the panes or their states). */
  refresh(): void {
    this.list = handoffList(this.macs(), this.current, this.recents, this.query);
    this.highlighted = highlight.settle(this.highlighted, this.rows);
    if (this.selection !== null && targetId(this.selection) !== this.highlighted) this.selection = null;
  }

  /** The highlighted row as listed now (what the picker shows). */
  get shown(): HandoffTarget | null {
    return highlight.target(this.highlighted, this.rows);
  }

  /** What an action on the highlighted row carries out: the row as you picked it while still highlighted, else as listed now. */
  get picked(): HandoffTarget | null {
    const shown = this.shown;
    if (shown === null) return null;
    if (this.selection !== null && targetId(this.selection) === targetId(shown)) return this.selection;
    return shown;
  }

  move(step: number): void {
    if (!this.fits) return;
    this.highlighted = highlight.move(this.highlighted, step, this.rows);
    this.selection = this.shown;
  }

  /** The pointer over a row highlights it (nothing is picked). */
  hover(target: HandoffTarget): void {
    if (!this.fits || !isPickable(target) || targetId(target) === this.highlighted) return;
    this.highlighted = targetId(target);
    this.selection = target;
  }

  /** A row clicked: it opens with the draft at once. */
  click(target: HandoffTarget): void {
    if (!this.fits || this.acted || !isPickable(target)) return;
    this.take(target, "draft");
  }

  /** Return (`draft`) or ⌘Return (`sendNow`) on the highlighted row. */
  perform(action: HandoffAction): void {
    const target = this.picked;
    if (!this.fits || this.acted || target === null || !isPickable(target)) return;
    this.take(target, action);
  }

  copy(): void {
    this.copyText(this.payload.text);
    this.copied = true;
  }

  private take(picked: HandoffTarget, action: HandoffAction): void {
    this.refresh();
    const now = this.rows.find((row) => targetId(row) === targetId(picked));
    if (now !== undefined && !isPickable(now)) return;
    if (this.acted) return;
    this.acted = true;
    this.act(picked, action);
  }
}

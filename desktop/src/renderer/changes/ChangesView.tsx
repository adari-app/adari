// An agent's Changes:
// the folder and Refresh above; then what its own calls changed this turn and
// this session, its folder's git now, and the commits since its session began.
// A file or a commit opens its diff (DiffView) with Back to the list. Read when
// it opens, on Refresh or Try again, and once when the agent leaves Working;
// never on a timer. The main process reads (src/main/changes/service.ts); the
// rows are shared/changes/content.ts's. It follows its
// context (the machine and its connection, the pane, the agent there, its
// session and its folder): a change drops the list and any open diff and reads
// again, or, the machine offline, says so without reading; an answer asked for
// an older context never shows.

import { useEffect, useRef, useState } from "react";

import {
  changesItems,
  changesText,
  commitMeta,
  detailState,
  editsText,
  fileLabel,
  fileSubtitle,
  fileTitle,
  loadingInput,
  offlineInput,
  readInput,
  statusLetter,
  type ChangesDetailState,
  type ChangesItem,
  type ChangesScope,
} from "../../shared/changes/content";
import { documentFromEdits } from "../../shared/changes/diff";
import { changeKind, isFolder, isStaged, type AgentCommit, type GitChangeKind, type GitFileChange } from "../../shared/changes/git";
import { displayPath, type AgentChangedFile } from "../../shared/changes/tools";
import type { ChangesAgentResult, ChangesDiffRequest, HerdrDesktopBridge } from "../../shared/ipc-contract";
import { ChevronLeftIcon, ChevronRightIcon, FolderIcon, RefreshIcon } from "../icons";
import { DiffView } from "./DiffView";

export type ChangesBridge = Pick<HerdrDesktopBridge, "changesAgent" | "changesDiff" | "closeChanges" | "copyText">;

/** A file's or a commit's diff, opened from the list. */
export interface ChangesDetail {
  readonly id: string;
  readonly title: string;
  readonly subtitle: string;
  readonly state: ChangesDetailState;
  /** What reads it again (none for an agent's own edits, shown from the read). */
  readonly request: ChangesDiffRequest | null;
}

export interface ChangesViewProps {
  readonly bridge: ChangesBridge;
  readonly hostId: string;
  readonly paneId: string;
  /** The agent's kind and folder as the sidebar has them (shown until the first read answers). */
  readonly kind: string;
  readonly folder: string | null;
  /** The pane's agent is working: leaving Working reads again, once. */
  readonly working: boolean;
  /** The machine's connection (absent: connected). Offline shows the offline rows without reading; back online reads again. */
  readonly online?: boolean;
  /** The agent's session as Herdr names it (agentSessionKey): a new one reads again. */
  readonly session?: string | null;
}

/** "+12 −3" in the diff's colours, "binary", or nothing. */
function Counts({ added, removed, binary = false }: { added: number | null; removed: number | null; binary?: boolean }) {
  if (binary) return <span className="ch-counts dc-note">binary</span>;
  if (added === null || removed === null) return null;
  return (
    <span className="ch-counts">
      <span className="dc-add">{`+${added}`}</span>
      <span className="dc-del">{`−${removed}`}</span>
    </span>
  );
}

const letterTone = (kind: GitChangeKind): string =>
  kind === "added" || kind === "untracked" ? " add" : kind === "deleted" || kind === "conflicted" ? " del" : "";

export function ChangesView({ bridge, hostId, paneId, kind, folder, working, online = true, session = null }: ChangesViewProps) {
  const [result, setResult] = useState<ChangesAgentResult | null>(null);
  const [refreshing, setRefreshing] = useState(online);
  const [detail, setDetail] = useState<ChangesDetail | null>(null);
  const [reads, setReads] = useState(0);
  const known = folder !== null && folder.trim().length > 0 ? folder : null;
  // What the list is of; a read's answer shows only while it still is.
  const context = JSON.stringify([hostId, paneId, kind, known, online, session]);
  const shownContext = useRef(context);
  const live = useRef(true);
  // The diff asked for last: an older answer is dropped.
  const asked = useRef(0);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      bridge.closeChanges();
    };
  }, [bridge]);

  // Another context (another pane, agent, session, folder or the machine's
  // connection) drops what was shown, the open diff and any diff still asked for.
  if (shownContext.current !== context) {
    shownContext.current = context;
    asked.current += 1;
    setResult(null);
    setDetail(null);
    setRefreshing(online);
  }

  useEffect(() => {
    // Offline: the offline rows, nothing read; reconnecting is a new context and reads.
    if (!online) {
      setRefreshing(false);
      return;
    }
    setRefreshing(true);
    const asking = context;
    void bridge.changesAgent(hostId, paneId).then(
      (read) => {
        if (!live.current || shownContext.current !== asking || read === null) return;
        setResult(read);
        setRefreshing(false);
      },
      () => {
        if (live.current && shownContext.current === asking) setRefreshing(false);
      },
    );
  }, [bridge, context, hostId, paneId, online, reads]);

  // fix: the agent finished a turn (left Working): read again, once.
  const wasWorking = useRef(working);
  useEffect(() => {
    if (wasWorking.current && !working) setReads((n) => n + 1);
    wasWorking.current = working;
  }, [working]);

  const refresh = (): void => setReads((n) => n + 1);
  const shownFolder = result?.folder ?? folder;

  const openDiff = (id: string, title: string, subtitle: string, request: ChangesDiffRequest): void => {
    asked.current += 1;
    const ask = asked.current;
    setDetail({ id, title, subtitle, state: { kind: "loading" }, request });
    const bound = request.kind === "file" ? 256 * 1_024 : 512 * 1_024;
    void bridge.changesDiff(hostId, paneId, request).then(
      (answer) => {
        if (!live.current || asked.current !== ask || answer === null) return;
        setDetail((current) => (current === null || current.id !== id ? current : { ...current, state: detailState(answer, bound) }));
      },
      () => {
        if (!live.current || asked.current !== ask) return;
        setDetail((current) => (current === null || current.id !== id ? current : { ...current, state: detailState({ kind: "failed" }, bound) }));
      },
    );
  };

  const openEdits = (file: AgentChangedFile, scope: ChangesScope): void => {
    asked.current += 1;
    const count = file.edits.length;
    setDetail({
      id: `edits|${scope}|${file.path}`,
      title: displayPath(file.path, shownFolder),
      subtitle: `${scope} · ${editsText(count)} by its own calls`,
      state: { kind: "shown", document: documentFromEdits(file.edits) },
      request: null,
    });
  };
  const openFile = (change: GitFileChange): void => openDiff("file|" + change.path, fileTitle(change), fileSubtitle(change), { kind: "file", path: change.path });
  const openCommit = (commit: AgentCommit): void => openDiff("commit|" + commit.hash, commit.subject, commitMeta(commit), { kind: "commit", hash: commit.hash });

  if (detail !== null) {
    const state = detail.state;
    return (
      <div className="changes" data-testid="changes-detail">
        <div className="ch-dhead">
          <button type="button" className="ch-back" aria-label="Back to Changes" onClick={() => setDetail(null)}>
            <ChevronLeftIcon size={15} />
            Changes
          </button>
          <div className="ch-dtitle" role="heading" aria-level={2}>
            <span className="t mono">{detail.title}</span>
            <span className="s">{detail.subtitle}</span>
          </div>
        </div>
        {state.kind === "loading" ? (
          <div className="ch-message" aria-live="polite">
            <span className="ch-spin" aria-hidden="true" />
            {changesText.readingDiff}
          </div>
        ) : state.kind === "shown" ? (
          <DiffView document={state.document} copy={(text) => bridge.copyText(text)} />
        ) : (
          <div className="ch-message">
            <span>{state.text}</span>
            {state.retry && detail.request !== null ? (
              <button type="button" className="ch-try" onClick={() => openDiff(detail.id, detail.title, detail.subtitle, detail.request!)}>
                Try again
              </button>
            ) : null}
          </div>
        )}
      </div>
    );
  }

  const input = !online ? offlineInput(kind, folder) : result === null ? loadingInput(kind, folder) : readInput(result);
  const items = changesItems(input);
  return (
    <div className="changes" data-testid="changes-list">
      <div className="ch-top">
        <FolderIcon size={13} />
        <span className="ch-folder mono" aria-label={"Folder " + (shownFolder ?? "not known")}>
          {shownFolder ?? "No folder"}
        </span>
        <span className="sp" />
        <button type="button" className={refreshing ? "ib on" : "ib"} aria-label={refreshing ? "Reading" : "Refresh"} disabled={refreshing || !online} onClick={refresh}>
          <RefreshIcon size={14} />
        </button>
      </div>
      <div className="ch-scroll">
        <div className="ch-col">{items.map((item) => drawItem(item, { openEdits, openFile, openCommit, refresh }))}</div>
      </div>
    </div>
  );
}

interface Actions {
  openEdits(file: AgentChangedFile, scope: ChangesScope): void;
  openFile(change: GitFileChange): void;
  openCommit(commit: AgentCommit): void;
  refresh(): void;
}

/** One row (plain elements: the list is short, at most 300 of the folder's files). */
function drawItem(item: ChangesItem, actions: Actions) {
  const kind = item.kind;
  switch (kind.type) {
    case "header":
      return (
        <div key={item.id} data-item={item.id} className="ch-head" role="heading" aria-level={3}>
          <span className="t">{kind.title}</span>
          {kind.detail === null ? null : <span className="d">{kind.detail}</span>}
        </div>
      );
    case "note":
      return (
        <div key={item.id} data-item={item.id} className={kind.tone === "problem" ? "ch-note problem" : "ch-note"}>
          {kind.text}
        </div>
      );
    case "retry":
      return (
        <div key={item.id} data-item={item.id} className="ch-note">
          <span>{kind.text}</span>
          <button type="button" className="ch-try" onClick={actions.refresh}>
            Try again
          </button>
        </div>
      );
    case "loading":
      return (
        <div key={item.id} data-item={item.id} className="ch-loading" aria-live="polite">
          <span className="ch-spin" aria-hidden="true" />
          {kind.text}
        </div>
      );
    case "toolFile": {
      const file = kind.file;
      const edits = file.edits.length;
      return (
        <button
          key={item.id}
          type="button"
          data-item={item.id}
          className="ch-row"
          aria-label={`${kind.shown}, ${file.added} added, ${file.removed} removed, ${editsText(edits)}`}
          onClick={() => actions.openEdits(file, kind.scope)}
        >
          <span className="ch-path mono">{kind.shown}</span>
          <span className="sp" />
          <Counts added={file.added} removed={file.removed} />
          <span className="ch-times mono">{`${edits}×`}</span>
          <ChevronRightIcon size={12} />
        </button>
      );
    }
    case "gitFile": {
      const change = kind.change;
      const letterKind = changeKind(change);
      return (
        <button
          key={item.id}
          type="button"
          data-item={item.id}
          className="ch-row"
          aria-label={fileLabel(change) + (isStaged(change) ? ", staged" : "")}
          onClick={() => actions.openFile(change)}
        >
          <span className={"ch-letter mono" + letterTone(letterKind)}>{statusLetter(letterKind)}</span>
          <span className="ch-path mono">{change.path}</span>
          {isStaged(change) ? <span className="ch-staged">staged</span> : null}
          <span className="sp" />
          {isFolder(change) ? null : <Counts added={change.added} removed={change.removed} binary={change.binary} />}
          <ChevronRightIcon size={12} />
        </button>
      );
    }
    case "commit": {
      const commit = kind.commit;
      return (
        <button
          key={item.id}
          type="button"
          data-item={item.id}
          className="ch-row commit"
          aria-label={`Commit ${commit.subject}, ${commitMeta(commit)}`}
          onClick={() => actions.openCommit(commit)}
        >
          <span className="ch-commit">
            <span className="s">{commit.subject}</span>
            <span className="m mono">{commitMeta(commit)}</span>
          </span>
          <span className="sp" />
          <Counts added={commit.added} removed={commit.removed} />
          <ChevronRightIcon size={12} />
        </button>
      );
    }
    case "loadEarlier":
      return null;
  }
}

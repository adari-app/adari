// Tool rows, quiet as T3 Code's (muted ink, normal weight, a chevron that
// turns 90° as the row opens), drawn by chat.css's
// `.tr`, `.tg`, `.tblock` and `.dcard`: one line per call (what, on what, its result), opening to the
// diff, the command and its last lines, the files found, or the plan. A
// finished turn's calls fold into one "Ran 3 commands" line that opens.

import { useState, type ReactNode } from "react";

import { diffCountsText, type ChatFoldedCalls, type ChatToolCall, type ChatToolDetail } from "../../shared/chat/model";
import {
  AgentIcon,
  ChevronRightIcon,
  EyeIcon,
  GlobeIcon,
  ListIcon,
  PencilIcon,
  PromptIcon,
  SearchIcon,
  ToolIcon,
} from "../icons";

const baseName = (path: string): string => {
  const trimmed = path.replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  return slash < 0 ? trimmed : trimmed.slice(slash + 1);
};

function verb(call: ChatToolCall): { icon: ReactNode; label: string; target: string } {
  const kind = call.kind;
  if (call.isUserShell) return { icon: <PromptIcon size={14} />, label: "Shell", target: call.target };
  switch (kind) {
    case "read":
      return { icon: <EyeIcon size={14} />, label: "Read", target: baseName(call.target) };
    case "edit":
      return { icon: <PencilIcon size={14} />, label: "Edit", target: baseName(call.target) };
    case "bash":
      return { icon: <PromptIcon size={14} />, label: call.toolName === "Bash" || call.toolName === "" ? "Bash" : call.toolName, target: call.target };
    case "search":
      return { icon: <SearchIcon size={14} />, label: "Search", target: call.target };
    case "web":
      return { icon: <GlobeIcon size={14} />, label: "Web", target: call.target };
    case "agent":
      return { icon: <AgentIcon size={14} />, label: "Agent", target: call.target };
    case "plan":
      return { icon: <ListIcon size={14} />, label: "Plan", target: call.target };
    default:
      return { icon: <ToolIcon size={14} />, label: call.toolName === "" ? kind.other : call.toolName, target: call.target };
  }
}

function hasDetail(detail: ChatToolDetail): boolean {
  switch (detail.type) {
    case "none":
      return false;
    case "diff":
      return detail.diff.lines.length > 0;
    case "bash":
      return detail.bash.command !== "" || detail.bash.outputTail.length > 0;
    case "search":
      return detail.search.files.length > 0;
    case "plan":
      return detail.steps.length > 0;
    case "text":
      return detail.text.trim() !== "";
  }
}

function Detail({ call }: { call: ChatToolCall }) {
  const detail = call.detail;
  switch (detail.type) {
    case "none":
      return null;
    case "diff":
      return (
        <div className="dcard">
          <div className="dh">
            <span className="p">{detail.diff.files.join(", ")}</span>
            <span className="r">
              <span className="add">+{detail.diff.added}</span> <span className="del">−{detail.diff.removed}</span>
            </span>
          </div>
          <div className="db">
            {detail.diff.lines.map((line, index) => (
              <div key={index} className={line.kind === "added" ? "dl a" : line.kind === "removed" ? "dl d" : line.kind === "file" ? "dl f" : "dl"}>
                <span className="sg">{line.kind === "added" ? "+" : line.kind === "removed" ? "-" : ""}</span>
                <span className="tx">{line.text}</span>
              </div>
            ))}
            {detail.diff.moreLines > 0 ? <div className="dl gap">⋯ {detail.diff.moreLines} more lines</div> : null}
          </div>
        </div>
      );
    case "bash":
      return (
        <div className="tblock">
          {detail.bash.command === "" ? null : (
            <div className="cmd">
              <span className="pr">$ </span>
              {detail.bash.command}
            </div>
          )}
          {detail.bash.outputTail.map((line, index) => (
            <div key={index} className={call.state === "failed" ? "out err" : "out"}>
              {line}
            </div>
          ))}
          {detail.bash.exitCode !== null && detail.bash.exitCode !== 0 ? <div className="out err">exit {detail.bash.exitCode}</div> : null}
        </div>
      );
    case "search":
      return (
        <div className="tblock">
          {detail.search.files.map((file) => (
            <div key={file} className="out">
              {file}
            </div>
          ))}
          {detail.search.fileCount !== null && detail.search.fileCount > detail.search.files.length ? (
            <div className="out dim">⋯ {detail.search.fileCount - detail.search.files.length} more</div>
          ) : null}
        </div>
      );
    case "plan":
      return (
        <div className="plan">
          {detail.steps.map((step, index) => (
            <div key={index} className={`step ${step.status}`}>
              <span className="box">{step.status === "completed" ? "✓" : step.status === "inProgress" ? "◐" : ""}</span>
              {step.text}
            </div>
          ))}
        </div>
      );
    case "text":
      return <div className="tblock">{detail.text}</div>;
  }
}

/** One call: a line that opens to its detail. A failed call shows its detail open. */
export function ToolRow({ call }: { call: ChatToolCall }) {
  const openable = hasDetail(call.detail);
  const [open, setOpen] = useState(call.state === "failed");
  const { icon, label, target } = verb(call);
  const diff = call.detail.type === "diff" ? call.detail.diff : null;
  const meta =
    call.state === "running" ? (
      <span className="m run">
        <span className="spin" />
      </span>
    ) : call.task?.state === "running" ? (
      // Its call returned, the task runs on: said so until it ends, then its outcome.
      <span className="m run bg">
        <span className="spin" />
        {call.resultSummary}
      </span>
    ) : call.resultSummary === null ? null : (
      <span className={call.state === "failed" ? "m bad" : "m"}>{call.resultSummary}</span>
    );
  return (
    <div className={call.state === "failed" ? "trw bad" : "trw"}>
      <button
        className={openable ? "tr open-able" : "tr"}
        onClick={() => openable && setOpen((value) => !value)}
        title={call.target}
        aria-expanded={openable ? open : undefined}
      >
        <span className="i">{icon}</span>
        <span className="v">{label}</span>
        <span className="tg2">{target}</span>
        {diff === null ? null : (
          <span className="cnt" title={diffCountsText(diff)}>
            <span className="add">+{diff.added}</span> <span className="del">−{diff.removed}</span>
          </span>
        )}
        {call.moreCalls > 0 ? <span className="more">+{call.moreCalls}</span> : null}
        {meta}
        {openable ? (
          <span className="chev">
            <ChevronRightIcon size={12} />
          </span>
        ) : null}
      </button>
      {open && openable ? <Detail call={call} /> : null}
    </div>
  );
}

/** A finished turn's calls folded into one line ("Read 2 files, ran 1 command"). */
export function FoldedRow({ folded }: { folded: ChatFoldedCalls }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="fold">
      <button className="tg" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span className="chev">
          <ChevronRightIcon size={12} />
        </span>
        {folded.summary}
      </button>
      {open ? (
        <div className="fold-b">
          {folded.calls.map((call) => (
            <ToolRow key={call.id} call={call} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

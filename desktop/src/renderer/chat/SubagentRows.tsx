// The subagents a turn started, as one compact row (a
// spinner and "2 agents running" while any runs; each one's description and
// type, then "running" or "done · 1m 12s"); a click on one opens its report,
// in the reply's style with its Copy. A running one's
// newest tool step ("Read Banner.swift") stands in place of "running". A subagent's report whose start is not
// held, or another Claude session's message, is a folded row of its own
// ("Agent report", "Message from another session").

import { useState, type ReactNode } from "react";

import {
  agentMessageTitle,
  subagentStatusText,
  subagentStepText,
  subagentTitle,
  subagentsRunning,
  subagentsSummary,
  type ChatAgentMessage,
  type ChatSubagent,
  type ChatSubagents,
} from "../../shared/chat/model";
import { AgentIcon, ChatIcon, CheckIcon, ChevronRightIcon, CloseIcon } from "../icons";

/** Draws a report or a message as the reply is drawn (markdown and its Copy). */
export type RenderText = (text: string) => ReactNode;

function SubagentLine({ agent, renderText }: { agent: ChatSubagent; renderText: RenderText }) {
  const [open, setOpen] = useState(false);
  const report = agent.report !== null && agent.report.trim() !== "" ? agent.report : null;
  const step = subagentStepText(agent);
  const icon =
    agent.state === "running" ? (
      <span className="spin" />
    ) : agent.state === "done" ? (
      <CheckIcon size={12} />
    ) : agent.state === "failed" ? (
      <CloseIcon size={12} />
    ) : (
      <span className="sub-stop" />
    );
  return (
    <div className={agent.state === "failed" ? "trw sub bad" : "trw sub"}>
      <button
        className={report === null ? "tr" : "tr open-able"}
        onClick={() => report !== null && setOpen((value) => !value)}
        title={agent.prompt ?? subagentTitle(agent)}
        aria-expanded={report === null ? undefined : open}
      >
        <span className="i">{icon}</span>
        <span className="v">{subagentTitle(agent)}</span>
        {agent.type === null ? null : <span className="tg2">{agent.type}</span>}
        <span className={agent.state === "failed" ? "m bad" : step === null ? "m" : "m step"}>{step ?? subagentStatusText(agent)}</span>
        {report === null ? null : (
          <span className="chev">
            <ChevronRightIcon size={12} />
          </span>
        )}
      </button>
      {open && report !== null ? <div className="sub-report">{renderText(report)}</div> : null}
    </div>
  );
}

/** The turn's subagents: the summary line, then one line each. */
export function SubagentsRow({ group, renderText }: { group: ChatSubagents; renderText: RenderText }) {
  return (
    <div className="subagents">
      <div className="tr sub-head">
        <span className="i">{subagentsRunning(group) > 0 ? <span className="spin" /> : <AgentIcon size={14} />}</span>
        <span className="v">{subagentsSummary(group)}</span>
      </div>
      <div className="sub-list">
        {group.agents.map((agent) => (
          <SubagentLine key={agent.id} agent={agent} renderText={renderText} />
        ))}
      </div>
    </div>
  );
}

/** "Agent report" or "Message from another session", folded; a click opens its text. */
export function AgentMessageRow({ message, renderText }: { message: ChatAgentMessage; renderText: RenderText }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="trw agent-msg">
      <button className="tr open-able" onClick={() => setOpen((value) => !value)} aria-expanded={open} title={message.from ?? undefined}>
        <span className="i">{message.kind === "report" ? <AgentIcon size={14} /> : <ChatIcon size={14} />}</span>
        <span className="v">{agentMessageTitle(message)}</span>
        {message.from === null || message.from === "" ? null : <span className="tg2">{message.from}</span>}
        <span className="chev">
          <ChevronRightIcon size={12} />
        </span>
      </button>
      {open ? <div className="sub-report">{renderText(message.text)}</div> : null}
    </div>
  );
}

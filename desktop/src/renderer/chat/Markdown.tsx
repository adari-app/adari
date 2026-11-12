// The agent's markdown as React elements (src/shared/chat/markdown.ts reads
// it): paragraphs, headings, lists, quotes, tables, rules, and code blocks with
// a header (the language, Send to…, Wrap, Copy) over a body in syntax colours
// (highlight.ts) that scrolls sideways or wraps. Never HTML: every part is an
// element built here, so raw HTML in a reply shows as text. An
// http or https link is a real link: a click, or Return on it, opens it in the
// default browser through main (open-link.ts), never in the app's window; any
// other link stays text with its address as its title. Nothing navigates.

import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";

import { parseMarkdown, type MdBlock, type MdInline } from "../../shared/chat/markdown";
import { isSafeExternalUrl } from "../../shared/external-url";
import { openLink } from "../open-link";
import { CheckIcon, CopyIcon, WrapIcon } from "../icons";
import { highlight } from "./highlight";

/** A code block's Send to… (handoff): its language, its code as written, and where the picker points. */
export type SendCode = (language: string | null, text: string, x: number, y: number) => void;

export interface MarkdownProps {
  readonly source: string;
  onCopy(text: string): void;
  /** Send to… in each code block's header (none when absent). */
  readonly onSendCode?: SendCode;
}

export function Markdown({ source, onCopy, onSendCode }: MarkdownProps) {
  const blocks = useMemo(() => parseMarkdown(source), [source]);
  return <div className="md">{renderBlocks(blocks, onCopy, onSendCode)}</div>;
}

/** How long "Copied" shows after a code block's Copy (T3 Code's 1.2 s). */
const copiedMs = 1_200;

/** The code as spans with the highlighter's classes; plain runs stay text. */
function Highlighted({ text, language }: { text: string; language: string | null }) {
  const tokens = useMemo(() => highlight(text, language), [text, language]);
  return (
    <code>
      {tokens.map((token, index) =>
        token.kind === "plain" ? (
          <Fragment key={index}>{token.text}</Fragment>
        ) : (
          <span key={index} className={`hl-${token.kind}`}>
            {token.text}
          </span>
        ),
      )}
    </code>
  );
}

/** A fenced block: a header (its language, Wrap, Copy) over a body that scrolls sideways or wraps. */
export function CodeBlock({ language, text, onCopy, onSend }: { language: string | null; text: string; onCopy(text: string): void; onSend?: SendCode }) {
  const [copied, setCopied] = useState(false);
  const [wrapped, setWrapped] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );
  const copy = (): void => {
    onCopy(text);
    setCopied(true);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), copiedMs);
  };
  return (
    <div className="md-code" data-lang={language ?? ""}>
      <div className="md-code-h">
        <span className="md-code-lang">{language ?? "text"}</span>
        <span className="md-code-acts">
          {onSend === undefined ? null : (
            <button
              className="md-act md-send"
              onClick={(event) => {
                const box = event.currentTarget.getBoundingClientRect();
                onSend(language, text, box.left, box.bottom + 4);
              }}
              title="Send the code to another pane"
              aria-label="Send code to…"
            >
              <span className="md-act-t">Send to…</span>
            </button>
          )}
          <button
            className="md-act"
            aria-pressed={wrapped}
            aria-label="Wrap lines"
            title={wrapped ? "Do not wrap lines" : "Wrap lines"}
            onClick={() => setWrapped((value) => !value)}
          >
            <WrapIcon />
          </button>
          <button className={copied ? "md-act done" : "md-act"} aria-label={copied ? "Copied" : "Copy code"} title={copied ? "Copied" : "Copy code"} onClick={copy}>
            {copied ? <CheckIcon /> : <CopyIcon />}
            {copied ? <span className="md-act-t">Copied</span> : null}
          </button>
        </span>
      </div>
      <pre className={wrapped ? "md-code-b wrap" : "md-code-b"}>
        <Highlighted text={text} language={language} />
      </pre>
    </div>
  );
}

/** Whether you are selecting text (a drag that ended on the link is a selection, not a click to open it). */
function selecting(): boolean {
  const selection = typeof window === "undefined" ? null : (window.getSelection?.() ?? null);
  return selection !== null && !selection.isCollapsed && selection.toString().length > 0;
}

/**
 * An http or https link as T3 Code's ChatMarkdown anchor (apps/web/src/components/ChatMarkdown.tsx
 * MarkdownAnchor): focusable, a click or Return opens it in the default browser, the page never follows it. Not
 * draggable, so a drag across it selects its text. Any other address: text in the reply's colour, its address as the title.
 */
export function linkElement(key: number, href: string, children: ReactNode): ReactNode {
  if (!isSafeExternalUrl(href)) {
    return (
      <span key={key} className="md-link-off" title={href}>
        {children}
      </span>
    );
  }
  return (
    <a
      key={key}
      className="md-link"
      href={href}
      title={href}
      rel="noopener noreferrer"
      draggable={false}
      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
        event.preventDefault();
        if (selecting()) return;
        openLink(href);
      }}
      onKeyDown={(event: KeyboardEvent<HTMLAnchorElement>) => {
        if (event.key !== "Enter") return;
        // Before the browser's own click for Return on a link (one open, not two).
        event.preventDefault();
        openLink(href);
      }}
    >
      {children}
    </a>
  );
}

function renderInlines(inlines: readonly MdInline[]): ReactNode[] {
  return inlines.map((inline, index) => {
    switch (inline.type) {
      case "text":
        return <Fragment key={index}>{inline.text}</Fragment>;
      case "code":
        return (
          <code key={index} className="md-ic">
            {inline.text}
          </code>
        );
      case "strong":
        return <strong key={index}>{renderInlines(inline.children)}</strong>;
      case "em":
        return <em key={index}>{renderInlines(inline.children)}</em>;
      case "strike":
        return <del key={index}>{renderInlines(inline.children)}</del>;
      case "link":
        return linkElement(index, inline.href, renderInlines(inline.children));
      case "break":
        return <br key={index} />;
    }
  });
}

function renderBlock(block: MdBlock, key: number, onCopy: (text: string) => void, onSend?: SendCode): ReactNode {
  switch (block.type) {
    case "paragraph":
      return (
        <p key={key} className="md-p">
          {renderInlines(block.inlines)}
        </p>
      );
    case "heading": {
      const level = Math.min(Math.max(block.level, 1), 6);
      const Tag = `h${level}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
      return (
        <Tag key={key} className={`md-h md-h${level}`}>
          {renderInlines(block.inlines)}
        </Tag>
      );
    }
    case "code":
      return <CodeBlock key={key} language={block.language} text={block.text} onCopy={onCopy} onSend={onSend} />;
    case "list": {
      const items = block.items.map((item, index) => <li key={index}>{renderBlocks(item, onCopy, onSend)}</li>);
      return block.ordered ? (
        <ol key={key} className="md-list" start={block.start}>
          {items}
        </ol>
      ) : (
        <ul key={key} className="md-list">
          {items}
        </ul>
      );
    }
    case "quote":
      return (
        <blockquote key={key} className="md-quote">
          {renderBlocks(block.blocks, onCopy, onSend)}
        </blockquote>
      );
    case "rule":
      return <hr key={key} className="md-rule" />;
    case "table": {
      const columns = Math.max(block.head.length, block.align.length, ...block.rows.map((row) => row.length));
      const cell = (cells: readonly (readonly MdInline[])[], column: number): ReactNode => renderInlines(cells[column] ?? []);
      const align = (column: number) => ({ textAlign: block.align[column] ?? undefined });
      return (
        <div key={key} className="md-table-wrap">
          <table className="md-table">
            <thead>
              <tr>
                {Array.from({ length: columns }, (_, column) => (
                  <th key={column} style={align(column)}>
                    {cell(block.head, column)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, index) => (
                <tr key={index}>
                  {Array.from({ length: columns }, (_, column) => (
                    <td key={column} style={align(column)}>
                      {cell(row, column)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
  }
}

function renderBlocks(blocks: readonly MdBlock[], onCopy: (text: string) => void, onSend?: SendCode): ReactNode[] {
  return blocks.map((block, index) => renderBlock(block, index, onCopy, onSend));
}

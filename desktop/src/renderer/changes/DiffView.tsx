// The Changes view's diff:
// "+12 −3", the files, binary or cut, and Copy above; the rows below, in one
// scroll both ways, as wide as the widest line and never wrapped. Only the rows
// in sight are drawn (each kind has a fixed height, shared/changes/diff.ts
// `diffLayout`), so a 2,000-line diff stays light. Monospace, the theme's green
// and red, dark only.

import { useEffect, useMemo, useRef, useState } from "react";

import { diffLayout, rowAccessibilityText, rowHeight, rowSign, visibleRows, type DiffDocument, type DiffRow } from "../../shared/changes/diff";

/** How long "Copied" shows after a Copy (the code block's). */
const copiedMs = 1_500;
/** Rows drawn above and below the ones in sight. */
const overscan = 12;
/** The rows' side inset, in pixels. */
const inset = 14;

/** Copy, then "Copied" for a moment. */
function useCopied(): [boolean, () => void] {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );
  const mark = (): void => {
    setCopied(true);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), copiedMs);
  };
  return [copied, mark];
}

function note(document: DiffDocument): string {
  const parts: string[] = [];
  if (document.files.length > 1) parts.push(`${document.files.length} files`);
  if (document.binary) parts.push("binary");
  if (document.cut) parts.push("cut");
  return parts.join(" · ");
}

/** A diff: its counts and Copy above, its lines below. */
export function DiffView({ document, copy }: { document: DiffDocument; copy: (text: string) => void }) {
  const [copied, markCopied] = useCopied();
  const extra = note(document);
  const summary = `${document.added} added, ${document.removed} removed` + (extra.length > 0 ? ", " + extra : "");
  return (
    <div className="diff" data-testid="changes-diff">
      <div className="diff-bar">
        <span className="diff-counts mono" aria-label={summary}>
          <span className="dc-add">{`+${document.added}`}</span>
          <span className="dc-del">{`−${document.removed}`}</span>
          {extra.length > 0 ? <span className="dc-note">{extra}</span> : null}
        </span>
        <span className="sp" />
        <button
          type="button"
          className={copied ? "diff-copy on" : "diff-copy"}
          aria-label={copied ? "Copied" : "Copy the diff"}
          onClick={() => {
            copy(document.copyText);
            markCopied();
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      {document.rows.length === 0 ? <div className="diff-empty">Nothing to show for this file.</div> : <DiffLines document={document} copy={copy} />}
    </div>
  );
}

/** The rows in sight, laid out at their fixed heights, in one scroll both ways. */
export function DiffLines({ document, copy }: { document: DiffDocument; copy: (text: string) => void }) {
  const layout = useMemo(() => diffLayout(document), [document]);
  const scroller = useRef<HTMLDivElement | null>(null);
  const [view, setView] = useState({ top: 0, height: 800 });
  useEffect(() => {
    const element = scroller.current;
    if (element === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setView({ top: element.scrollTop, height: element.clientHeight }));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    // Another diff starts at its top.
    const element = scroller.current;
    if (element !== null) {
      element.scrollTop = 0;
      element.scrollLeft = 0;
    }
    setView((previous) => (previous.top === 0 ? previous : { top: 0, height: previous.height }));
  }, [document]);
  const range = visibleRows(layout, view.top, view.height, overscan);
  const gutter = document.largestNumber > 0 ? Math.max(String(document.largestNumber).length, 2) + 1 : 0;
  const width = `calc(${inset * 2}px + ${gutter}ch + 2ch + ${document.columns + 1}ch)`;
  const rows: unknown[] = [];
  for (let index = range.start; index < range.end; index += 1) {
    const row = document.rows[index]!;
    rows.push(drawRow(row, layout.offsets[index]!, rowHeight(row.kind, layout.heights), gutter, document, copy));
  }
  return (
    <div
      className="diff-scroll"
      ref={scroller}
      onScroll={(event) => {
        const target = event.currentTarget;
        setView({ top: target.scrollTop, height: target.clientHeight });
      }}
    >
      <div className="diff-content" style={{ height: layout.total, width, minWidth: "100%" }}>
        {rows as React.ReactNode[]}
      </div>
    </div>
  );
}

/** One row (a plain element, so the rows in sight are the only ones made). */
function drawRow(row: DiffRow, top: number, height: number, gutter: number, document: DiffDocument, copy: (text: string) => void) {
  const style = { top, height };
  switch (row.kind) {
    case "section":
      return (
        <div key={row.id} data-row={row.id} className="drow k-section" style={style} role="heading" aria-level={3} aria-label={row.text}>
          <span className="pin">{row.text}</span>
        </div>
      );
    case "notice":
      return (
        <div key={row.id} data-row={row.id} className="drow k-notice" style={style} aria-label={row.text}>
          <span className="pin">{row.text}</span>
        </div>
      );
    case "file": {
      const file = row.file === null ? undefined : document.files[row.file];
      const own = document.files.length > 1 && file !== undefined ? file.copyText : null;
      return (
        <div key={row.id} data-row={row.id} className="drow k-file" style={style} aria-label={rowAccessibilityText(row)}>
          <span className="dfile mono">{row.text}</span>
          {own === null ? null : (
            <button type="button" className="diff-copy file" aria-label="Copy this file's diff" onClick={() => copy(own)}>
              Copy file
            </button>
          )}
        </div>
      );
    }
    default:
      return (
        <div key={row.id} data-row={row.id} className={`drow k-${row.kind} mono`} style={style} aria-label={rowAccessibilityText(row)}>
          <span className="dn" style={{ width: `${gutter}ch` }}>
            {row.number === null ? "" : String(row.number)}
          </span>
          <span className="ds">{rowSign(row)}</span>
          <span className="dt">{row.text}</span>
        </div>
      );
  }
}

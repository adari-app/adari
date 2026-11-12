// Nothing selected: the empty state (the ">_" mark, one line, a hint).

export function EmptyState({ needsYou, hosts }: { needsYou: number; hosts: number }) {
  // ⌘J is the terminal drawer now; the next pane needing you is ⇧⌘J.
  const shortcut = navigator.userAgent.includes("Mac") ? "⇧⌘J" : "Ctrl+Shift+J";
  return (
    <main className="main">
      <div className="mh" />
      <div className="empty">
        <div className="ctr">
          <div className="mark">&gt;_</div>
          <h1>{needsYou > 0 ? `${needsYou} ${needsYou === 1 ? "agent needs" : "agents need"} you` : "Pick a pane"}</h1>
          <div className="sub">
            {hosts === 0 ? (
              "Add a machine with + to see its Herdr panes"
            ) : needsYou > 0 ? (
              <>
                Pick one on the left, or press <span className="kbd">{shortcut}</span> for the next
              </>
            ) : (
              "Pick a pane on the left to open its terminal"
            )}
          </div>
        </div>
      </div>
    </main>
  );
}

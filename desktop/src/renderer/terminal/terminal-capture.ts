// A selection in the shown terminal as your mouse makes it (captures only):
// the press, the move and the release go to the
// terminal's canvas as real mouse events, so ghostty-web's SelectionManager
// and the copy (terminal-copy.ts) run as they do for you.

/** A point on the canvas as fractions of its width and height. */
export interface CanvasPoint {
  readonly x: number;
  readonly y: number;
}

/** Presses `clicks` times at `from` (a drag to `to` on the last); false when no canvas is found. */
export function selectInTerminal(selector: string, from: CanvasPoint, to: CanvasPoint | null, clicks: number): boolean {
  const canvas = document.querySelector(selector);
  if (!(canvas instanceof HTMLCanvasElement)) return false;
  const rect = canvas.getBoundingClientRect();
  const fire = (type: string, at: CanvasPoint, detail: number, buttons: number): void => {
    canvas.dispatchEvent(
      new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        button: 0,
        buttons,
        detail,
        clientX: rect.left + at.x * rect.width,
        clientY: rect.top + at.y * rect.height,
      }),
    );
  };
  for (let n = 1; n <= clicks; n += 1) {
    fire("mousedown", from, n, 1);
    const end = n === clicks && to !== null ? to : from;
    if (end !== from) fire("mousemove", end, n, 1);
    fire("mouseup", end, n, 0);
    fire("click", end, n, 0);
    if (n === 2) fire("dblclick", end, n, 0);
  }
  return true;
}

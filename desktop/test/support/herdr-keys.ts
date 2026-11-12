// The key names Herdr's agent.send_keys
// takes, as proven against the real Herdr on a Claude Code 2.1.319 pane
// (`herdr agent send-keys`), plus the names the apps already send.
// A fake that takes agent.send_keys checks every name here and refuses any
// other with `invalid_key`, as Herdr does ("C-u" and "BSpace" are refused).

import { APIError } from "../../src/main/herdr/wire";

export const provenHerdrKeys: ReadonlySet<string> = new Set([
  // Proven live.
  "ctrl+u",
  "Backspace",
  "backspace",
  "Escape",
  "C-c",
  "ctrl+c",
  // Already sent by the apps.
  "Enter",
  "Up",
  "Down",
  "Tab",
  "BTab",
  "Return",
]);

/** Throws Herdr's `invalid_key` for any name not proven; nothing is sent then. */
export function checkHerdrKeys(keys: readonly string[]): void {
  const unknown = keys.find((name) => !provenHerdrKeys.has(name));
  if (unknown !== undefined) throw new APIError("invalid_key", `unknown key: ${unknown}`);
}

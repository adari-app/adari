// Which addresses the app opens in the default browser: http
// and https only, never file:, javascript:, a relative path or a custom
// scheme. The window's guard (src/main/window.ts), the open-link call
// (src/main/ipc.ts), a chat link (src/renderer/chat/Markdown.tsx) and a
// terminal link (src/renderer/terminal/terminal-links.ts) all ask this one.

/** The longest address the open-link call takes (a link longer than this is not one you meant to open). */
export const maxExternalUrlLength = 8_192;

/** http and https only; never file:, javascript: or custom schemes. */
export function isSafeExternalUrl(candidate: string): boolean {
  if (typeof candidate !== "string" || candidate.length > maxExternalUrlLength) return false;
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

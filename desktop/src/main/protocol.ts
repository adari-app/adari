// The app's own scheme for the renderer's files, with a strict content security
// policy on every response.
//
// Adapted from T3 Code (MIT, Copyright (c) 2026 T3 Tools Inc.):
// apps/desktop/src/electron/ElectronProtocol.ts (the scheme privileges, the asset
// handler with its path checks, the CSP header on each response), rewritten without
// Effect and without the proxy and Clerk parts.

import { promises as fs } from "node:fs";
import path from "node:path";

import { protocol } from "electron";

export const APP_SCHEME = "adari";
export const APP_HOST = "app";
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
export const APP_URL = `${APP_ORIGIN}/`;

/**
 * No network origin at all: the renderer talks only to the preload. Ghostty's
 * terminal core is WebAssembly, hence 'wasm-unsafe-eval': its file is fetched
 * from this protocol (terminal-core.ts), and ghostty-web's own
 * copy, its fallback, from a data: URL, hence data: in connect-src; styles
 * allow inline for the terminal canvas sizing.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "connect-src 'self' data:",
  "img-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ttf": "font/ttf",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
};

/** Must run before `app` is ready. */
export function registerSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true },
    },
  ]);
}

/**
 * Resolves a request path inside `root`, or null when it escapes it or is
 * malformed. Paths without an extension fall back to index.html (one page app).
 */
export function resolveAssetPath(root: string, requestUrl: string): { file: string; fallback: boolean } | null {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }
  if (url.protocol !== `${APP_SCHEME}:` || url.host !== APP_HOST) return null;
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  if (pathname.includes("\0")) return null;
  const base = path.resolve(root);
  const file = path.resolve(base, `.${pathname}`);
  if (file !== base && !file.startsWith(base + path.sep)) return null;
  return { file, fallback: path.extname(file) === "" };
}

function withPolicy(body: BodyInit | null, init: ResponseInit, contentType?: string): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  headers.set("X-Content-Type-Options", "nosniff");
  if (contentType) headers.set("Content-Type", contentType);
  return new Response(body, { ...init, headers });
}

export function registerAppProtocol(rendererRoot: string): void {
  protocol.handle(APP_SCHEME, async (request) => {
    if (request.method !== "GET" && request.method !== "HEAD") return withPolicy(null, { status: 405 });
    const resolved = resolveAssetPath(rendererRoot, request.url);
    if (!resolved) return withPolicy(null, { status: 404 });
    let file = resolved.file;
    try {
      const stat = await fs.stat(file).catch(() => null);
      if (!stat?.isFile()) {
        if (!resolved.fallback) return withPolicy(null, { status: 404 });
        file = path.join(rendererRoot, "index.html");
      }
      const contents = await fs.readFile(file);
      const type = MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
      return withPolicy(request.method === "HEAD" ? null : new Uint8Array(contents), { status: 200 }, type);
    } catch {
      return withPolicy(null, { status: 404 });
    }
  });
}

/** Same scheme and host as the app's own pages (T3: isSameOriginRendererNavigation). */
export function isAppUrl(candidate: string): boolean {
  try {
    const url = new URL(candidate);
    return url.protocol === `${APP_SCHEME}:` && url.host === APP_HOST;
  } catch {
    return false;
  }
}

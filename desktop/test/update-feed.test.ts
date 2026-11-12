// What an update check sends, on electron-
// updater's own AppUpdater and GitHub provider, set up as the app sets it up
// (configureUpdater) and driven by the app's UpdateController, against a local
// fake feed. The requests are made by builder-util-runtime's own HttpExecutor
// (its User-Agent and Cache-Control) and go to a server on a Unix socket in
// the test's scratch folder: the github.com URLs are only names here, nothing
// leaves this machine.

import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { AppUpdater } from "electron-updater";
import type { AppAdapter } from "electron-updater/out/AppAdapter";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { anonymousStagingId, configureUpdater, memoryUpdatePrefs, UPDATE_GITHUB_FEED, UpdateController, updateSettings, type Updater } from "../src/main/updates";

// The copy of builder-util-runtime electron-updater itself uses (not a dependency of the app's own).
const runtime = createRequire(require.resolve("electron-updater"))("builder-util-runtime") as {
  HttpExecutor: new () => { createRequest(options: unknown, callback: (response: unknown) => void): unknown };
};

const scratch = mkdtempSync(path.join(process.env["HERDR_TEST_SCRATCH"] || os.tmpdir(), "update-feed-"));
const socket = path.join(scratch, "feed.sock");

/** One request as electron-updater made it (where it meant to go) and as the fake feed got it. */
interface Sent {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, unknown>;
}
const meant: Sent[] = [];
const received: Sent[] = [];
let mode: "published" | "no-repo" | "no-release" = "published";

const atom = (tags: readonly string[]) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom">\n<id>tag:github.com,2008:https://github.com/adari-app/adari/releases</id>\n<title>Release notes from adari</title>\n${tags
    .map((tag) => `<entry><id>tag:github.com,2008:Repository/1/${tag}</id><link rel="alternate" type="text/html" href="https://github.com/adari-app/adari/releases/tag/${tag}"/><title>${tag}</title><content>No content.</content></entry>`)
    .join("\n")}\n</feed>\n`;
const latestMac = [
  "version: 0.1.1",
  "files:",
  "  - url: Adari-0.1.1-arm64.zip",
  "    sha512: AAAA",
  "    size: 4",
  "path: Adari-0.1.1-arm64.zip",
  "sha512: AAAA",
  "releaseDate: '2026-11-09T12:00:00.000Z'",
  "",
].join("\n");

const server = http.createServer((request, response) => {
  received.push({ method: request.method ?? "", url: request.url ?? "", headers: { ...request.headers } });
  const send = (status: number, type: string, body: string) => {
    response.writeHead(status, { "content-type": type });
    response.end(body);
  };
  if (mode === "no-repo") return send(404, "text/plain", "Not Found");
  if (request.url === "/adari-app/adari/releases.atom") return send(200, "application/atom+xml", atom(mode === "published" ? ["v0.1.1", "v0.1.0"] : []));
  if (request.url === "/adari-app/adari/releases/latest") return mode === "published" ? send(200, "application/json", JSON.stringify({ tag_name: "v0.1.1" })) : send(404, "application/json", "{}");
  if (request.url === "/adari-app/adari/releases/download/v0.1.1/latest-mac.yml") return send(200, "text/yaml", latestMac);
  return send(404, "text/plain", "Not Found");
});

/** builder-util-runtime's executor, every connection to the fake feed's socket (the URL's host only named in Host). */
class LocalExecutor extends runtime.HttpExecutor {
  override createRequest(options: unknown, callback: (response: unknown) => void): unknown {
    const o = options as { method?: string; protocol?: string; hostname?: string; port?: string; path: string; headers: Record<string, string> };
    meant.push({ method: o.method ?? "GET", url: `${o.protocol ?? "https:"}//${o.hostname}${o.port ? `:${o.port}` : ""}${o.path}`, headers: { ...o.headers } });
    // A connection of its own for each request (the executor adds its timeout listener to the socket).
    return http.request({ socketPath: socket, agent: false, method: o.method ?? "GET", path: o.path, headers: { ...o.headers, host: o.hostname } }, callback);
  }
}

function adapter(name: string): AppAdapter {
  const home = path.join(scratch, name);
  return {
    version: "0.1.0",
    name: "Adari",
    isPackaged: true,
    appUpdateConfigPath: path.join(home, "app-update.yml"),
    userDataPath: path.join(home, "userData"),
    baseCachePath: path.join(home, "cache"),
    whenReady: () => Promise.resolve(),
    relaunch: () => undefined,
    quit: () => undefined,
    onQuit: () => undefined,
  };
}

/** electron-updater's AppUpdater as the Mac one checks (its download and install are not this test's). */
class CheckingUpdater extends AppUpdater {
  constructor(app: AppAdapter) {
    super(null, app);
    (this as unknown as { httpExecutor: unknown }).httpExecutor = new LocalExecutor();
  }
  protected doDownloadUpdate(): Promise<string[]> {
    return Promise.reject(new Error("not in this test"));
  }
  quitAndInstall(): void {
    throw new Error("not in this test");
  }
}

const on = updateSettings({}, { platform: "darwin", packaged: true, signed: true, demo: false });

function app(name: string) {
  const updater = new CheckingUpdater(adapter(name));
  const logs: string[] = [];
  const controller = new UpdateController({
    settings: on,
    version: "0.1.0",
    prefs: memoryUpdatePrefs(),
    confirmInstall: () => Promise.resolve(false),
    verifySignature: () => Promise.resolve(null),
    load: () => Promise.resolve(updater as unknown as Updater),
    log: (line) => logs.push(line),
  });
  return { updater, controller, logs, home: path.join(scratch, name) };
}

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(socket, resolve));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  writeFileSync(path.join(scratch, "requests.json"), `${JSON.stringify({ meant, received }, null, 2)}\n`);
});

describe("a check against the fake feed (electron-updater's own GitHub provider)", () => {
  it("three GETs to the feed, the all-zero staging id, no id file; it finds 0.1.1 and downloads nothing", async () => {
    mode = "published";
    meant.length = 0;
    received.length = 0;
    const a = app("app");
    expect(await a.controller.check("manual")).toEqual({ kind: "available", version: "0.1.1" });
    const common = { "User-Agent": "electron-builder", "Cache-Control": "no-cache", "x-user-staging-id": anonymousStagingId };
    expect(meant).toEqual([
      { method: "GET", url: "https://github.com/adari-app/adari/releases.atom", headers: { accept: "application/xml, application/atom+xml, text/xml, */*", ...common } },
      { method: "GET", url: "https://github.com/adari-app/adari/releases/latest", headers: { Accept: "application/json", ...common } },
      { method: "GET", url: "https://github.com/adari-app/adari/releases/download/v0.1.1/latest-mac.yml", headers: common },
    ]);
    // What arrived: the same three, nothing more (Node adds only its Connection header).
    expect(received.map((r) => `${r.method} ${String(r.headers["host"])}${r.url}`)).toEqual([
      "GET github.com/adari-app/adari/releases.atom",
      "GET github.com/adari-app/adari/releases/latest",
      "GET github.com/adari-app/adari/releases/download/v0.1.1/latest-mac.yml",
    ]);
    for (const r of received) {
      expect(Object.keys(r.headers).sort()).toEqual(
        expect.arrayContaining(["cache-control", "host", "user-agent", "x-user-staging-id"]),
      );
      expect(Object.keys(r.headers).filter((name) => !["accept", "cache-control", "connection", "host", "user-agent", "x-user-staging-id"].includes(name))).toEqual([]);
      expect(r.headers["x-user-staging-id"]).toBe(anonymousStagingId);
      expect(r.headers["cookie"]).toBeUndefined();
      expect(r.headers["authorization"]).toBeUndefined();
    }
    // No per-install id is ever made.
    expect(existsSync(path.join(a.home, "userData", ".updaterId"))).toBe(false);
    expect(a.controller.view()).toMatchObject({ status: "available", available: "0.1.1", downloads: 0 });
    expect(a.updater.autoDownload).toBe(false);
  });

  it("electron-updater as it comes would make a per-install id file and send it; configureUpdater is what stops that", async () => {
    mode = "published";
    meant.length = 0;
    const stock = new CheckingUpdater(adapter("stock"));
    stock.logger = null;
    stock.autoDownload = false;
    stock.setFeedURL({ ...UPDATE_GITHUB_FEED });
    await stock.checkForUpdates();
    const file = path.join(scratch, "stock", "userData", ".updaterId");
    expect(existsSync(file)).toBe(true);
    const id = meant[0]!.headers["x-user-staging-id"];
    expect(id).not.toBe(anonymousStagingId);
    expect(id).toMatch(/^[0-9a-f-]{36}$/u);
    // The same updater set up as the app sets it up sends zeros from then on.
    meant.length = 0;
    const fresh = new CheckingUpdater(adapter("configured"));
    configureUpdater(fresh as unknown as Updater, UPDATE_GITHUB_FEED, () => undefined);
    await fresh.checkForUpdates();
    expect(meant.map((m) => m.headers["x-user-staging-id"])).toEqual([anonymousStagingId, anonymousStagingId, anonymousStagingId]);
    expect(existsSync(path.join(scratch, "configured", "userData", ".updaterId"))).toBe(false);
  });

  it("before publish (no repo, or a repo with no release): a quiet failure, one log line, the state as it was", async () => {
    for (const next of ["no-repo", "no-release"] as const) {
      mode = next;
      const a = app(`quiet-${next}`);
      const answer = await a.controller.check("automatic");
      expect(answer).toEqual({ kind: "failed", message: "No release is published on GitHub yet." });
      expect(a.logs.filter((line) => line.startsWith("automatic check"))).toEqual(["automatic check failed: No release is published on GitHub yet."]);
      expect(a.controller.view()).toMatchObject({ status: "idle", lastCheck: { outcome: "failed" } });
    }
  });
});

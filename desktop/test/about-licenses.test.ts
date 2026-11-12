// About's one "Open-source licenses" row (T3 Code's About:
// apps/web/src/components/settings/SettingsPanels.tsx, View licenses). Its
// button opens THIRD_PARTY_NOTICES.md, the file every package ships at the
// root of app.asar (electron-builder.config.cjs `files`; test/notices.test.ts
// checks it holds every licence text). Another app cannot read inside
// app.asar, so the packaged file is copied out, byte for byte, into the app's
// own folder first; a development run opens the repo's file where it is; with
// no viewer for Markdown, the same text opens as a .txt. Nothing is fetched.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

const registered = vi.hoisted(() => ({ handles: new Map<string, (...args: unknown[]) => unknown>() }));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, listener: (...args: unknown[]) => unknown) => registered.handles.set(channel, listener),
    on: () => undefined,
  },
}));

const { registerIpc } = await import("../src/main/ipc");
const { APP_ORIGIN } = await import("../src/main/protocol");
const { IPC } = await import("../src/shared/ipc-contract");
const { insideAsar, noticesFileName, openShippedLicenses } = await import("../src/main/licenses");
const { scratch } = await import("./support/this-mac-fake");

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const notices = readFileSync(path.join(repo, noticesFileName));

/** An app folder holding the notices (`asar`: named as a packaged app's archive is). */
function app(asar: boolean) {
  const root = mkdtempSync(path.join(scratch, "about-lic-"));
  const appPath = path.join(root, asar ? "Adari.app/Contents/Resources/app.asar" : "desktop");
  mkdirSync(appPath, { recursive: true });
  writeFileSync(path.join(appPath, noticesFileName), notices);
  return { appPath, userData: path.join(root, "userData") };
}

describe("View licenses opens the notices file the app ships", () => {
  it("is the repo's THIRD_PARTY_NOTICES.md, the one electron-builder puts in every package", () => {
    expect(noticesFileName).toBe("THIRD_PARTY_NOTICES.md");
    const config = (readFileSync(path.join(repo, "electron-builder.config.cjs"), "utf8"));
    expect(config).toContain('"THIRD_PARTY_NOTICES.md"');
  });

  it("a development run: the file opened where it is, nothing copied", async () => {
    const site = app(false);
    const opened: string[] = [];
    await expect(openShippedLicenses({ ...site, open: async (file) => (opened.push(file), "") })).resolves.toBeNull();
    expect(opened).toEqual([path.join(site.appPath, noticesFileName)]);
    expect(existsSync(site.userData)).toBe(false);
  });

  it("a packaged app: copied out of app.asar into the app's own folder, byte for byte, and that copy opened", async () => {
    const site = app(true);
    expect(insideAsar(path.join(site.appPath, noticesFileName))).toBe(true);
    expect(insideAsar(path.join(repo, noticesFileName))).toBe(false);
    const opened: string[] = [];
    await expect(openShippedLicenses({ ...site, open: async (file) => (opened.push(file), "") })).resolves.toBeNull();
    expect(opened).toEqual([path.join(site.userData, noticesFileName)]);
    expect(readFileSync(path.join(site.userData, noticesFileName)).equals(notices)).toBe(true);
  });

  it("no app opens Markdown: the same text as a .txt (TextEdit); neither: why, in words", async () => {
    const site = app(true);
    const opened: string[] = [];
    await expect(openShippedLicenses({ ...site, open: async (file) => (opened.push(file), file.endsWith(".md") ? "No application knows how to open it." : "") })).resolves.toBeNull();
    expect(opened).toEqual([path.join(site.userData, noticesFileName), path.join(site.userData, "THIRD_PARTY_NOTICES.txt")]);
    expect(readFileSync(path.join(site.userData, "THIRD_PARTY_NOTICES.txt")).equals(notices)).toBe(true);
    await expect(openShippedLicenses({ ...site, open: async () => "No application knows how to open it." })).resolves.toBe(
      "Could not open THIRD_PARTY_NOTICES.md: No application knows how to open it.",
    );
  });

  it("a build without the file says so (nothing opened)", async () => {
    const root = mkdtempSync(path.join(scratch, "about-lic-"));
    const opened: string[] = [];
    await expect(openShippedLicenses({ appPath: root, userData: path.join(root, "u"), open: async (file) => (opened.push(file), "") })).resolves.toBe(
      "THIRD_PARTY_NOTICES.md is not in this build.",
    );
    expect(opened).toEqual([]);
  });

  it("at the main process's door: no arguments taken; the opener's answer passed back", async () => {
    const event = { senderFrame: { url: APP_ORIGIN }, sender: { id: 1 } };
    let calls = 0;
    registered.handles.clear();
    registerIpc({ hosts: { backend: () => null, list: () => [], refresh: async () => undefined }, openLicenses: async () => (calls += 1, null) } as never);
    const open = (...args: unknown[]) => registered.handles.get(IPC.openLicenses)!(event, ...args) as Promise<unknown>;
    await expect(open()).resolves.toBeNull();
    await expect(open("/etc/passwd")).rejects.toThrow("bad request");
    expect(calls).toBe(1);
  });
});

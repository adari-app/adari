// Credits and licenses (Settings › About opens THIRD_PARTY_NOTICES.md). The list is made
// from what is installed (scripts/third-party-licenses.mjs, no network): every
// production dependency and what it depends on, the packages compiled into the
// app, Electron, and the bundled fonts, each with its licence text. The
// checked-in file the page bundles matches a fresh run.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { licensesFile, thirdPartyLicenses, thirdPartyLicensesText, type ThirdPartyComponent } from "../scripts/third-party-licenses.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const list = thirdPartyLicenses(root);
const byName = new Map<string, ThirdPartyComponent>(list.components.map((component) => [component.name, component]));
const readJson = (file: string) => JSON.parse(readFileSync(file, "utf8")) as { name: string; version: string; dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> };

/** electron-builder.config.cjs's `!**\/node_modules/<name>/**`: not in the app. */
const excluded = new Set([...readFileSync(path.join(root, "electron-builder.config.cjs"), "utf8").matchAll(/"!\*\*\/node_modules\/([^/"*]+)\/\*\*"/g)].map((match) => match[1]!));

/** A package as Node finds it from `from` (nested node_modules first, then up to the package's own). */
function installed(name: string, from: string): string | null {
  for (let dir = from; dir.startsWith(root); dir = path.dirname(dir)) {
    const candidate = path.join(dir, "node_modules", name);
    if (existsSync(path.join(candidate, "package.json"))) return candidate;
    if (dir === root) break;
  }
  return null;
}

/** package.json's dependencies and theirs, as installed (an optional one only when it is), less what the app leaves out. */
function shippedPackages(): Map<string, string> {
  const found = new Map<string, string>();
  const queue: [string, string][] = Object.keys(readJson(path.join(root, "package.json")).dependencies ?? {}).map((name) => [name, root]);
  while (queue.length > 0) {
    const [name, from] = queue.shift()!;
    if (excluded.has(name)) continue;
    const dir = installed(name, from);
    if (dir === null) continue;
    const manifest = readJson(path.join(dir, "package.json"));
    if (found.has(`${manifest.name}@${manifest.version}`)) continue;
    found.set(`${manifest.name}@${manifest.version}`, dir);
    for (const next of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies })) queue.push([next, dir]);
  }
  return found;
}

const looksLikeALicence = (text: string): boolean => text.length >= 200 && /licen[cs]e|permission|public domain/i.test(text);

describe("the credits list", () => {
  it("lists every production dependency (and what it depends on) with its licence text", () => {
    const shipped = shippedPackages();
    expect(shipped.size).toBeGreaterThan(5);
    for (const [key, dir] of shipped) {
      const [name, version] = [key.slice(0, key.lastIndexOf("@")), key.slice(key.lastIndexOf("@") + 1)];
      const entry = list.components.find((component) => component.name === name && component.version === version);
      expect(entry, `${key} is in the list`).toBeDefined();
      expect(entry!.kind).toBe("package");
      expect(looksLikeALicence(entry!.text), `${key} has its licence text`).toBe(true);
      expect(entry!.source.startsWith(path.relative(root, dir).split(path.sep).join("/"))).toBe(true);
    }
    for (const name of ["ssh2", "electron-updater"]) expect(byName.get(name)?.kind).toBe("package");
    // What the app leaves out is not listed as shipped.
    for (const name of excluded) expect(byName.has(name), `${name} is left out of the app`).toBe(false);
  });

  it("lists the packages compiled into the app (ghostty-web, React) and Electron, each with its licence", () => {
    for (const name of ["ghostty-web", "react", "react-dom", "scheduler"]) {
      expect(byName.get(name)?.kind, name).toBe("bundled");
      expect(looksLikeALicence(byName.get(name)!.text), name).toBe(true);
    }
    const electron = byName.get("Electron")!;
    expect(electron.kind).toBe("runtime");
    expect(electron.version).toBe(readJson(path.join(root, "node_modules/electron/package.json")).version);
    expect(electron.text).toBe(readFileSync(path.join(root, "node_modules/electron/LICENSE"), "utf8").replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").trim());
    expect(electron.note).toMatch(/LICENSES\.chromium\.html/);
    expect(byName.get("Ghostty")?.license).toBe("MIT");
  });

  it("lists each font the app loads with its OFL text", () => {
    const css = readFileSync(path.join(root, "src/renderer/styles/fonts.css"), "utf8");
    const families = new Set([...css.matchAll(/url\("[^"]*\/([A-Za-z]+)-[A-Za-z]+\.(?:ttf|otf|woff2?)"\)/g)].map((match) => match[1]!));
    expect(families.size).toBeGreaterThan(0);
    const fonts = list.components.filter((component) => component.kind === "font");
    expect(fonts).toHaveLength(families.size);
    for (const font of fonts) {
      expect(font.license).toBe("OFL-1.1");
      expect(font.text).toMatch(/SIL OPEN FONT LICENSE/i);
    }
  });

  it("every entry has a licence and its text", () => {
    for (const component of list.components) {
      expect(component.license, component.name).not.toBe("");
      expect(looksLikeALicence(component.text), component.name).toBe(true);
    }
  });

  it("the bundled file matches a fresh run (scripts/build.mjs writes it before each build)", () => {
    expect(readFileSync(path.join(root, licensesFile), "utf8")).toBe(thirdPartyLicensesText(root));
  });

  it("is made from the disk only: the generator asks nothing of the network", () => {
    const source = readFileSync(path.join(root, "scripts/third-party-licenses.mjs"), "utf8");
    expect(source).not.toMatch(/\bfrom\s+["'](node:)?(https?|net|tls|dns|child_process)["']|\bfetch\(/);
  });
});

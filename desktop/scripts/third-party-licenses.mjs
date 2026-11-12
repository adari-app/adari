// The per-package record of third-party licences, kept in the repo (the page
// does not show it: About opens THIRD_PARTY_NOTICES.md, which every package
// ships). Every third-party component the app ships, each with its licence
// text, read from what is installed (no network):
//
// - Electron, the runtime (node_modules/electron: its LICENSE; Chromium's and
//   Node's notices are Electron's LICENSES.chromium.html, which
//   electron-builder keeps in every package);
// - the npm packages in the package's own node_modules: package.json's
//   dependencies and what they depend on (their optional ones when installed),
//   less what electron-builder.config.cjs keeps out (`!**/node_modules/<name>/**`);
// - the npm packages the build compiles into dist/ (esbuild and Vite): every
//   package the sources import (not type-only, not Node's own, not electron),
//   and what they depend on (React DOM brings Scheduler);
// - Ghostty, compiled into ghostty-web's ghostty-vt.wasm (its text from
//   THIRD_PARTY_NOTICES.md, as ghostty-web's LICENSE has only Coder's), and the
//   code adapted from T3 Code (the same file);
// - the fonts the renderer's fonts.css loads, with the OFL text beside them
//   (the repo's App/Fonts).
//
// `node scripts/third-party-licenses.mjs` writes the list to
// src/renderer/settings/third-party-licenses.json (checked in, not bundled);
// `--check` only says whether it is current. scripts/build.mjs
// writes it before every build, so the repo's list stays fresh;
// test/settings-licenses.test.ts checks the file matches a fresh run.

import { builtinModules, createRequire } from "node:module";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const defaultRoot = path.join(here, "..");
/** The list's place in the sources, relative to desktop/. */
export const licensesFile = "src/renderer/settings/third-party-licenses.json";

const licenceFile = /^(licen[sc]e|copying)(\.(md|txt|markdown))?$/i;

/** The MIT text, for a package whose package.json says MIT but which carries no licence file (lazy-val). */
const mitBody = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

const normalised = (text) => text.replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").trim();
const posix = (file) => file.split(path.sep).join("/");
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));

/** The package directory `name` resolves to from `from`, as Node finds it (node_modules up to the root); null: not installed. */
function resolvePackage(root, from, name) {
  let dir = from;
  for (;;) {
    const candidate = path.join(dir, "node_modules", name);
    if (existsSync(path.join(candidate, "package.json"))) return candidate;
    const parent = path.dirname(dir);
    if (dir === root || parent === dir || !parent.startsWith(root)) return null;
    dir = parent;
  }
}

function licenceName(pkg, text) {
  if (typeof pkg.license === "string") return pkg.license;
  if (typeof pkg.license?.type === "string") return pkg.license.type;
  if (Array.isArray(pkg.licenses) && typeof pkg.licenses[0]?.type === "string") return pkg.licenses[0].type;
  if (/Permission is hereby granted, free of charge/.test(text)) return "MIT";
  return "see licence text";
}

function authorName(author) {
  if (typeof author === "string") return author.replace(/\s*[<(].*$/, "").trim();
  if (typeof author?.name === "string") return author.name;
  return null;
}

function homepage(pkg) {
  const repository = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
  const url = typeof pkg.homepage === "string" ? pkg.homepage : repository;
  if (typeof url !== "string") return null;
  return url
    .replace(/^git\+/, "")
    .replace(/^git:\/\//, "https://")
    .replace(/\.git$/, "")
    .replace(/^github:/, "https://github.com/")
    .replace(/^([\w.-]+\/[\w.-]+)$/, "https://github.com/$1");
}

/** One npm package's entry: its licence file's text (or, with none, its package.json's licence and why). */
function packageEntry(root, dir, kind) {
  const pkg = readJson(path.join(dir, "package.json"));
  const file = readdirSync(dir)
    .filter((name) => licenceFile.test(name) && statSync(path.join(dir, name)).isFile())
    .sort()[0];
  let text;
  let note = null;
  let source;
  if (file !== undefined) {
    text = normalised(readFileSync(path.join(dir, file), "utf8"));
    source = posix(path.relative(root, path.join(dir, file)));
  } else if (pkg.license === "MIT") {
    const holder = authorName(pkg.author);
    text = `MIT License\n\nCopyright (c) ${holder ?? "its authors"}\n\n${mitBody}`;
    note = `The package carries no licence file; its package.json names the MIT licence${holder === null ? "" : ` and ${holder} as its author`}. The MIT text follows.`;
    source = posix(path.relative(root, path.join(dir, "package.json")));
  } else {
    throw new Error(`${pkg.name}: no licence file and no licence text to give`);
  }
  return {
    name: pkg.name,
    version: pkg.version,
    kind,
    license: licenceName(pkg, text),
    url: homepage(pkg),
    source,
    ...(note === null ? {} : { note }),
    text,
  };
}

/** The packages electron-builder keeps out of the package (`!**\/node_modules/<name>/**`). */
function excludedPackages(root) {
  const require = createRequire(path.join(root, "package.json"));
  const config = require(path.join(root, "electron-builder.config.cjs"));
  const excluded = new Set();
  for (const pattern of config.files ?? []) {
    const match = /^!\*\*\/node_modules\/((?:@[^/]+\/)?[^/]+)\/\*\*$/.exec(pattern);
    if (match !== null) excluded.add(match[1]);
  }
  return excluded;
}

/** Every package `names` reach from `from`, with what each depends on (optional ones when installed), less `skip`. */
function closure(root, from, names, skip) {
  const found = new Map();
  const visit = (dir, name) => {
    if (skip.has(name)) return;
    const at = resolvePackage(root, dir, name);
    if (at === null) throw new Error(`${name} is not installed (needed from ${posix(path.relative(root, dir)) || "."})`);
    if (found.has(at)) return;
    found.set(at, name);
    const pkg = readJson(path.join(at, "package.json"));
    for (const dependency of Object.keys(pkg.dependencies ?? {})) visit(at, dependency);
    for (const optional of Object.keys(pkg.optionalDependencies ?? {})) {
      if (!skip.has(optional) && resolvePackage(root, at, optional) !== null) visit(at, optional);
    }
  };
  for (const name of names) visit(from, name);
  return [...found.keys()];
}

function sourceFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(full));
    else if (/\.(ts|tsx|mts|cts)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) files.push(full);
  }
  return files;
}

const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

/** The package a bare specifier names ("react-dom/client" → "react-dom"); null for a relative path, Node's own or a URL. */
export function packageOfSpecifier(specifier) {
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.includes(":") || builtins.has(specifier)) return null;
  const parts = specifier.split("/");
  const name = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  return builtins.has(name) ? null : name;
}

/** The packages the sources import for real (type-only imports and exports left out). */
export function importedPackages(root) {
  const names = new Set();
  const statement = /(?:^|[;\n])\s*(import|export)\s+(type\s+)?([^;]*?)\s*from\s*["']([^"']+)["']/g;
  const bare = /(?:^|[;\n])\s*import\s*["']([^"']+)["']/g;
  const dynamic = /\b(?:import|require)\(\s*["']([^"']+)["']\s*\)/g;
  for (const file of sourceFiles(path.join(root, "src"))) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(statement)) {
      if (match[2] !== undefined) continue;
      // `import { type A, type B } from "x"` is type-only too.
      const clause = match[3].trim();
      const braced = /^\{([^}]*)\}$/.exec(clause);
      if (braced !== null && braced[1].split(",").map((part) => part.trim()).filter(Boolean).every((part) => part.startsWith("type "))) continue;
      const name = packageOfSpecifier(match[4]);
      if (name !== null) names.add(name);
    }
    for (const match of [...text.matchAll(bare), ...text.matchAll(dynamic)]) {
      const name = packageOfSpecifier(match[1]);
      if (name !== null) names.add(name);
    }
    // The JSX runtime (react/jsx-runtime) comes with every .tsx file.
    if (file.endsWith(".tsx")) names.add("react");
  }
  return [...names].sort();
}

/** A fenced block's text under a heading of THIRD_PARTY_NOTICES.md (the first block after it). */
function noticeBlock(notices, heading) {
  const at = notices.indexOf(`\n${heading}\n`);
  if (at < 0) throw new Error(`THIRD_PARTY_NOTICES.md has no "${heading}"`);
  const open = notices.indexOf("\n```\n", at);
  const close = notices.indexOf("\n```", open + 5);
  if (open < 0 || close < 0) throw new Error(`THIRD_PARTY_NOTICES.md has no licence text under "${heading}"`);
  return normalised(notices.slice(open + 5, close));
}

const fontNames = { Geist: "Geist", IBMPlexMono: "IBM Plex Mono", JetBrainsMono: "JetBrains Mono" };

/** The fonts fonts.css loads: each family's files and the OFL text beside them. */
function fontEntries(root) {
  const css = readFileSync(path.join(root, "src/renderer/styles/fonts.css"), "utf8");
  const families = new Map();
  for (const match of css.matchAll(/url\("([^"]+)"\)/g)) {
    const file = path.resolve(path.join(root, "src/renderer/styles"), match[1]);
    const prefix = path.basename(file).split("-")[0];
    const list = families.get(prefix) ?? [];
    list.push(file);
    families.set(prefix, list);
  }
  return [...families.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([prefix, files]) => {
      const licence = path.join(path.dirname(files[0]), `${prefix}-OFL.txt`);
      if (!existsSync(licence)) throw new Error(`${prefix}: no OFL text beside its fonts`);
      return {
        name: fontNames[prefix] ?? prefix,
        version: null,
        kind: "font",
        license: "OFL-1.1",
        url: null,
        source: posix(path.relative(root, licence)),
        note: `The files: ${files.map((file) => path.basename(file)).join(", ")}.`,
        text: normalised(readFileSync(licence, "utf8")),
      };
    });
}

const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.source < b.source ? -1 : 1);

/** The whole list, in a fixed order: Electron, the npm packages, Ghostty, the adapted code, the fonts. */
export function thirdPartyLicenses(root = defaultRoot) {
  const top = readJson(path.join(root, "package.json"));
  const skip = excludedPackages(root);
  // electron is the runtime (its own entry); its npm package's dependencies only download it.
  skip.add("electron");
  const shipped = closure(root, root, Object.keys(top.dependencies ?? {}), skip);
  const shippedSet = new Set(shipped);
  const imported = importedPackages(root).filter((name) => name !== "electron");
  const bundled = closure(root, root, imported, skip).filter((dir) => !shippedSet.has(dir));
  const electronDir = resolvePackage(root, root, "electron");
  if (electronDir === null) throw new Error("electron is not installed");
  const electron = {
    ...packageEntry(root, electronDir, "runtime"),
    name: "Electron",
    url: "https://www.electronjs.org",
    note: "Electron includes Chromium, Node.js and the libraries they use. Their licence texts are Electron's LICENSES.chromium.html, which ships in the app beside Electron's LICENSE (Contents/Resources on the Mac, next to the app's executable on Windows and Linux).",
  };
  const notices = readFileSync(path.join(root, "THIRD_PARTY_NOTICES.md"), "utf8").replace(/\r\n?/g, "\n");
  const ghosttyWeb = bundled.some((dir) => readJson(path.join(dir, "package.json")).name === "ghostty-web");
  const embedded = ghosttyWeb
    ? [
        {
          name: "Ghostty",
          version: null,
          kind: "embedded",
          license: "MIT",
          url: "https://github.com/ghostty-org/ghostty",
          source: "THIRD_PARTY_NOTICES.md",
          note: "Ghostty's terminal core, compiled to WebAssembly (ghostty-vt.wasm) inside ghostty-web, which carries only Coder's licence.",
          text: noticeBlock(notices, "### Ghostty"),
        },
      ]
    : [];
  const adapted = {
    name: "T3 Code",
    version: null,
    kind: "adapted",
    license: "MIT",
    url: "https://github.com/pingdotgg/t3code",
    source: "THIRD_PARTY_NOTICES.md",
    note: "Code adapted from T3 Code: the app's protocol, window, menu, updater and packaging (THIRD_PARTY_NOTICES.md lists the files).",
    text: noticeBlock(notices, "## Code adapted from T3 Code"),
  };
  const packages = [...shipped.map((dir) => packageEntry(root, dir, "package")), ...bundled.map((dir) => packageEntry(root, dir, "bundled"))].sort(byName);
  return { format: 1, components: [electron, ...packages, ...embedded, adapted, ...fontEntries(root)] };
}

/** The file's text: stable (no dates, a fixed order), so a fresh run gives the same bytes. */
export function thirdPartyLicensesText(root = defaultRoot) {
  return `${JSON.stringify(thirdPartyLicenses(root), null, 1)}\n`;
}

/** Writes the list when it is not current; whether it changed. */
export function writeThirdPartyLicenses(root = defaultRoot) {
  const file = path.join(root, licensesFile);
  const text = thirdPartyLicensesText(root);
  const current = existsSync(file) ? readFileSync(file, "utf8") : null;
  if (current === text) return false;
  writeFileSync(file, text);
  return true;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--check")) {
    const current = existsSync(path.join(defaultRoot, licensesFile)) ? readFileSync(path.join(defaultRoot, licensesFile), "utf8") : null;
    const fresh = thirdPartyLicensesText(defaultRoot);
    console.log(current === fresh ? `${licensesFile} is current` : `${licensesFile} is out of date: run node scripts/third-party-licenses.mjs`);
    process.exit(current === fresh ? 0 : 1);
  }
  const changed = writeThirdPartyLicenses(defaultRoot);
  const count = thirdPartyLicenses(defaultRoot).components.length;
  console.log(`${licensesFile}: ${count} components${changed ? " (written)" : " (already current)"}`);
}

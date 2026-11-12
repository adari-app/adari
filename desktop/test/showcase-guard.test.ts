// The showcase's guard. Every string the showcase can show (machine
// names, sidebar labels, titles, folders, transcripts, terminal screens, diffs
// and commits, what While you were away and Search read, the Send to… text, the
// shot captions, the window title) is checked against the recorded fixtures,
// read here at test time so no list of real names is written into the repo:
// no label, name, folder or title found in them, no "/Volumes/", and not the
// recorded home folders' user names.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { DemoTranscript } from "../src/main/demo/demo-chat";
import { showcaseShots } from "../src/main/showcase/showcase-capture";
import { showcaseHandoffText } from "../src/main/showcase/showcase-chat";
import { showcaseGitTexts, showcaseGpuCommits, showcaseGpuGit, showcaseStudioCommits, showcaseStudioGit } from "../src/main/showcase/showcase-git";
import { showcaseHosts, showcaseScenes } from "../src/main/showcase/showcase-hosts";
import { desktopRoot, fixturesRoot } from "./support/swift-fixtures";

const start = 1_800_000_000_000;

/** Every file under the fixtures folder, as text. */
function fixtureTexts(): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  const walk = (folder: string): void => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push({ file: path.relative(fixturesRoot, full), text: readFileSync(full).toString("utf8") });
    }
  };
  walk(fixturesRoot);
  return out;
}

/** The keys whose values the app shows as a label, a name, a title or a folder. */
const shownKeys = new Set(["label", "name", "title", "terminal_title", "terminal_title_stripped", "cwd", "foreground_cwd", "workspace_label", "tab_label"]);

interface Recorded {
  /** Labels, names and titles (and the folders' last parts). */
  readonly words: Set<string>;
  readonly folders: Set<string>;
  /** /Users/<name> and /home/<name> owners. */
  readonly users: Set<string>;
  /** The agents' kinds (claude, codex, …): the app's own words, not a name. */
  readonly kinds: Set<string>;
}

function recorded(): Recorded {
  const words = new Set<string>();
  const folders = new Set<string>();
  const users = new Set<string>();
  const kinds = new Set<string>();
  // In a session transcript (.jsonl) a "name" is a tool's; only its folders are someone's.
  let session = false;
  const visit = (value: unknown, key: string | null): void => {
    if (Array.isArray(value)) value.forEach((item) => visit(item, key));
    else if (value !== null && typeof value === "object") for (const [k, v] of Object.entries(value)) visit(v, k);
    else if (typeof value === "string" && key !== null) {
      if (key === "agent") kinds.add(value.toLowerCase());
      if (!shownKeys.has(key) || (session && !value.startsWith("/"))) return;
      if (value.startsWith("/")) folders.add(value);
      else words.add(value);
    }
  };
  for (const { file, text } of fixtureTexts()) {
    // A recording may hold a line that is not JSON on purpose (the parsers' tests): its paths are still read below.
    const json = (source: string): void => {
      try {
        visit(JSON.parse(source), null);
      } catch {
        // not JSON
      }
    };
    session = file.endsWith(".jsonl");
    if (file.endsWith(".json")) json(text);
    if (file.endsWith(".jsonl")) for (const line of text.split("\n").filter((l) => l.trim().length > 0)) json(line);
    // Paths anywhere (the recorded screens and sessions too).
    for (const match of text.matchAll(/(?:\/Users|\/home|\/root|\/Volumes|\/private)(?:\/[A-Za-z0-9._-]+)+/g)) folders.add(match[0]);
    for (const match of text.matchAll(/\/(?:Users|home)\/([A-Za-z0-9._-]+)/g)) users.add(match[1]!);
  }
  for (const folder of folders) {
    // A scratch folder's last part (project, requested, …) is no one's project; its whole path is still checked.
    if (/^(?:\/private)?\/tmp(?:\/|$)/.test(folder)) continue;
    const last = folder.split("/").filter((part) => part.length > 0).at(-1);
    if (last !== undefined) words.add(last);
  }
  return { words, folders, users, kinds };
}

/** The product's own name (Herdr, its companion): shown by the app itself, not taken from anyone's setup. */
const productWords = new Set(["herdr"]);

/** A word or phrase as a whole word: case-sensitive when three characters or fewer (initials), else not. */
function wordPattern(word: string): RegExp {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, word.length <= 3 ? "" : "i");
}

const styles = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "g");

function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((item) => strings(item, out));
  else if (value !== null && typeof value === "object") Object.values(value).forEach((item) => strings(item, out));
  return out;
}

function transcriptText(transcript: DemoTranscript): string[] {
  const lines = [transcript.path, transcript.cwd, ...transcript.lines];
  if (transcript.live !== undefined) for (let index = 0; index < 200; index += 1) lines.push(...transcript.live.step(index, start + index * 1_000));
  return lines;
}

/** Everything the showcase can show. */
function showcaseStrings(): { what: string; text: string }[] {
  const out: { what: string; text: string }[] = [];
  const add = (what: string, texts: readonly string[]): void => texts.forEach((text) => out.push({ what, text }));
  for (const host of showcaseHosts(start)) {
    add(`${host.descriptor.id} descriptor`, strings(host.descriptor));
    add(`${host.descriptor.id} snapshot`, strings(host.snapshot));
    add(`${host.descriptor.id} home`, [host.home ?? ""]);
    for (const transcript of host.transcripts) add(`transcript ${transcript.paneID}`, transcriptText(transcript));
  }
  for (const scene of showcaseScenes()) {
    for (const [cols, rows] of [[60, 24], [100, 45], [160, 60]] as const) {
      for (const ms of [0, 1_500, 4_000, 8_000, 12_000, 18_000, 26_000, 34_000, 60_000]) add("terminal", scene.frame(ms, cols, rows).map((line) => line.replace(styles, "")));
    }
  }
  add("git", [...showcaseGitTexts, ...strings(showcaseStudioGit), ...strings(showcaseGpuGit), ...strings(showcaseStudioCommits), ...strings(showcaseGpuCommits)]);
  add("Send to…", [showcaseHandoffText]);
  add("shot captions", showcaseShots().map((shot) => `${shot.name} ${shot.what}`));
  const title = /title: "([^"]+)"/.exec(readFileSync(path.join(desktopRoot, "src/main/window.ts"), "utf8"))?.[1];
  add("window title", [title ?? ""]);
  return out;
}

/** The recorded labels, names and titles worth checking: numbers and lone symbols are no one's name; the agents' kinds and the product's name are the app's own words. */
function checkedWords(real: Recorded): string[] {
  return [...real.words].filter((word) => {
    const folded = word.trim().toLowerCase();
    return /[A-Za-z]/.test(folded) && !real.kinds.has(folded) && !productWords.has(folded);
  });
}

function foundWords(real: Recorded, shown: readonly { what: string; text: string }[]): string[] {
  return checkedWords(real).flatMap((word) => {
    const pattern = wordPattern(word.trim());
    const hit = shown.find(({ text }) => pattern.test(text));
    return hit === undefined ? [] : [`${JSON.stringify(word)} in ${hit.what}`];
  });
}

/** The recorded folders' made-up owner (/Users/demo, no one's account): also the app's own word for a demo machine's kind. */
const placeholderOwners = new Set(["demo"]);

/** The recorded home folders' owners worth checking. */
function checkedOwners(real: Recorded): string[] {
  return [...real.users].filter((user) => !placeholderOwners.has(user.toLowerCase()));
}

function foundPaths(real: Recorded, shown: readonly { what: string; text: string }[]): string[] {
  const found: string[] = [];
  const owners = checkedOwners(real).map((user) => [user, new RegExp(`(?<![A-Za-z0-9])${user.replace(/\./g, "\\.")}(?![A-Za-z0-9])`, "i")] as const);
  for (const { what, text } of shown) {
    if (text.includes("/Volumes/")) found.push(`/Volumes/ in ${what}`);
    for (const folder of real.folders) if (folder.length > 5 && text.includes(folder)) found.push(`${folder} in ${what}`);
    for (const [user, pattern] of owners) if (pattern.test(text)) found.push(`${user} in ${what}`);
  }
  return [...new Set(found)];
}

describe("the showcase guard", () => {
  const real = recorded();
  const shown = showcaseStrings();

  it("reads enough from the recorded fixtures to mean something", () => {
    expect(real.words.size).toBeGreaterThan(40);
    expect(real.folders.size).toBeGreaterThan(20);
    expect(checkedOwners(real).length).toBeGreaterThan(0);
    expect(shown.length).toBeGreaterThan(2_000);
  });

  it("shows no label, name or title found in the recorded fixtures", () => {
    expect(foundWords(real, shown)).toEqual([]);
  });

  it("shows no recorded folder, nothing under /Volumes/, and not the recorded home folders' owners", () => {
    expect(foundPaths(real, shown)).toEqual([]);
  });

  it("would catch a recorded label, folder or owner planted in what it shows", () => {
    const word = checkedWords(real)[0]!;
    const folder = [...real.folders].find((candidate) => candidate.length > 5)!;
    const user = checkedOwners(real)[0]!;
    expect(foundWords(real, [{ what: "planted", text: `a row named ${word} today` }])).toHaveLength(1);
    expect(foundPaths(real, [{ what: "planted", text: `cd ${folder}` }]).length).toBeGreaterThan(0);
    expect(foundPaths(real, [{ what: "planted", text: `/home/${user}/x` }])).toEqual([`${user} in planted`]);
    expect(foundPaths(real, [{ what: "planted", text: "/Volumes/Data" }])).toEqual(["/Volumes/ in planted"]);
  });

  it("never imports a recorded fixture", () => {
    const folder = path.join(desktopRoot, "src/main/showcase");
    for (const file of readdirSync(folder)) {
      const source = readFileSync(path.join(folder, file), "utf8");
      expect(source, file).not.toMatch(/fixtures\/|bundled|protocol22|replay\//);
    }
  });
});

// A port of HerdrKit's
// AgentChangesGit.swift: git in an agent's folder, read only, over the SSH
// connection the app already has (the runner, reader.ts). One exec per folder
// for its state (the branch, one `git status --porcelain=v1 -z`, `git diff
// --numstat -z` and `--cached`); one file's diff, a commit, and the commits
// since the session began on demand. Every command is `/bin/sh -c '<script>'`
// whatever the login shell, every value single-quoted, every path after `--`
// (pathspecs taken literally, from the top); git runs with `--no-pager`, `-c
// core.quotepath=off`, `--no-optional-locks` and GIT_OPTIONAL_LOCKS=0 (no index
// refresh, no lock), `-c diff.autoRefreshIndex=false` (a working-tree `git diff`
// otherwise rewrites the index when a file's stat changed and its content did
// not), no external diff or text conversion, no fsmonitor hook; no filter
// (each one git has set up is turned off; its keys read NUL-terminated and
// byte for byte, each checked whole, for every git call, the log's too), no
// signature check, no look inside submodules, no lazy fetch. Output is cut on
// the Mac (`head -c`) at its bound; each section's exit status is kept outside
// the cut and printed after it, so a failure reads as a failure, never as a
// clean folder. Pure: the commands and the parsers; the reader runs them.
//
// Times are seconds since 1970, as the chat model's.

import { shellQuote as q } from "../chat/locator";

/** The Changes views' bounds (AgentChangesLimits). */
export interface AgentChangesLimits {
  /** One command's time (5 s). */
  readonly timeoutMs: number;
  /** One folder's status and line counts. */
  readonly statusBytes: number;
  /** One file's diff (staged and not). */
  readonly fileDiffBytes: number;
  /** One commit (`git show --stat --patch`). */
  readonly commitBytes: number;
  /** The commits since the session began. */
  readonly logBytes: number;
  readonly maxCommits: number;
  /** Folders (and transcripts) read on the across-agents screen, per Mac. */
  readonly folders: number;
  /** Commands (and transcript reads) running at once on one Mac. */
  readonly commandsAtOnce: number;
  /** A transcript read backwards from its end. */
  readonly transcriptBytesPerPane: number;
  readonly transcriptChunkBytes: number;
  /** One transcript read's time inside the gate (10 s); past it the row says it could not be read and the permit is returned. */
  readonly transcriptTimeoutMs: number;
}

export const defaultChangesLimits: AgentChangesLimits = {
  timeoutMs: 5_000,
  statusBytes: 256 * 1_024,
  fileDiffBytes: 256 * 1_024,
  commitBytes: 512 * 1_024,
  logBytes: 64 * 1_024,
  maxCommits: 50,
  folders: 20,
  commandsAtOnce: 3,
  transcriptBytesPerPane: 2 * 1_024 * 1_024,
  transcriptChunkBytes: 128 * 1_024,
  transcriptTimeoutMs: 10_000,
};

/** The defaults with `changes`, each at least 1 (a timeout and a transcript bound may be anything). */
export function changesLimits(changes: Partial<AgentChangesLimits> = {}): AgentChangesLimits {
  const limits = { ...defaultChangesLimits, ...changes };
  const least = (value: number): number => Math.max(1, Math.floor(value));
  return {
    ...limits,
    statusBytes: least(limits.statusBytes),
    fileDiffBytes: least(limits.fileDiffBytes),
    commitBytes: least(limits.commitBytes),
    logBytes: least(limits.logBytes),
    maxCommits: least(limits.maxCommits),
    folders: least(limits.folders),
    commandsAtOnce: least(limits.commandsAtOnce),
    transcriptChunkBytes: least(limits.transcriptChunkBytes),
  };
}

// MARK: - values

export type GitChangeKind = "modified" | "added" | "deleted" | "renamed" | "copied" | "typeChanged" | "untracked" | "conflicted";

/** One entry of `git status`, with its lines added and removed (staged and not, together). */
export interface GitFileChange {
  /** From the repository's top. */
  readonly path: string;
  /** A rename's or copy's source. */
  readonly originalPath: string | null;
  /** Porcelain v1's X (the index) and Y (the working tree): one character each. */
  readonly indexStatus: string;
  readonly worktreeStatus: string;
  /** Null where git counts none (untracked, binary, not in the counts read). */
  readonly added: number | null;
  readonly removed: number | null;
  readonly binary: boolean;
}

export function gitFileChange(
  path: string,
  indexStatus: string,
  worktreeStatus: string,
  fields: Partial<Pick<GitFileChange, "originalPath" | "added" | "removed" | "binary">> = {},
): GitFileChange {
  return {
    path,
    originalPath: fields.originalPath ?? null,
    indexStatus,
    worktreeStatus,
    added: fields.added ?? null,
    removed: fields.removed ?? null,
    binary: fields.binary ?? false,
  };
}

export const isUntracked = (change: GitFileChange): boolean => change.indexStatus === "?";
/** An untracked folder (git lists the folder, not its files). */
export const isFolder = (change: GitFileChange): boolean => isUntracked(change) && change.path.endsWith("/");
export const isStaged = (change: GitFileChange): boolean => !isUntracked(change) && change.indexStatus !== " " && change.indexStatus !== "!";
export const isUnstaged = (change: GitFileChange): boolean => !isUntracked(change) && change.worktreeStatus !== " " && change.worktreeStatus !== "!";

export function changeKind(change: GitFileChange): GitChangeKind {
  const x = change.indexStatus;
  const y = change.worktreeStatus;
  if (x === "?") return "untracked";
  if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) return "conflicted";
  if (x === "R" || y === "R") return "renamed";
  if (x === "C" || y === "C") return "copied";
  if (x === "A" || y === "A") return "added";
  if (x === "D" || y === "D") return "deleted";
  if (x === "T" || y === "T") return "typeChanged";
  return "modified";
}

export type GitHead =
  | { readonly kind: "branch"; readonly name: string }
  /** Not on a branch: the commit's short hash. */
  | { readonly kind: "detached"; readonly hash: string }
  /** A branch with no commits yet. */
  | { readonly kind: "unborn"; readonly name: string }
  | { readonly kind: "unknown" };

export interface GitFolderStatus {
  /** The repository's top folder. */
  readonly top: string | null;
  readonly head: GitHead;
  /** In `git status` order. */
  readonly files: readonly GitFileChange[];
  /** The output passed its bound: the list is partial. */
  readonly cut: boolean;
}

export const statusAdded = (status: GitFolderStatus): number => status.files.reduce((n, f) => n + (f.added ?? 0), 0);
export const statusRemoved = (status: GitFolderStatus): number => status.files.reduce((n, f) => n + (f.removed ?? 0), 0);
/** Tracked files with changes, staged or not. */
export const changedCount = (status: GitFolderStatus): number => status.files.filter((f) => !isUntracked(f)).length;
export const untrackedCount = (status: GitFolderStatus): number => status.files.filter(isUntracked).length;

/** What reading a folder gave. */
export type GitFolderRead =
  | { readonly kind: "repository"; readonly status: GitFolderStatus }
  | { readonly kind: "notARepository" }
  /** The folder is not there. */
  | { readonly kind: "noFolder" }
  /** Git's setup runs a filter that cannot be turned off here. */
  | { readonly kind: "runsAFilter" }
  | { readonly kind: "failed" }
  | { readonly kind: "timedOut" };

/** A diff or a commit in parts ("Staged", "Not staged", "Untracked"; one untitled part for a commit); empty parts are left out. */
export interface GitTextPart {
  readonly title: string;
  readonly text: string;
}

export interface GitText {
  readonly parts: readonly GitTextPart[];
  /** The output passed its bound: the text stops there. */
  readonly cut: boolean;
}

export type GitTextResult =
  | { readonly kind: "text"; readonly text: GitText }
  | { readonly kind: "notARepository" }
  | { readonly kind: "noFolder" }
  /** The file goes through a filter git has set up (or git's setup runs one that cannot be turned off): not run. */
  | { readonly kind: "runsAFilter" }
  | { readonly kind: "failed" }
  | { readonly kind: "timedOut" };

/** A commit since the session began. */
export interface AgentCommit {
  readonly hash: string;
  readonly subject: string;
  /** The committer's time, seconds since 1970. */
  readonly time: number;
  readonly parents: number;
  /** From `--shortstat`; null for a merge (not counted). */
  readonly files: number | null;
  readonly added: number | null;
  readonly removed: number | null;
}

export const shortHash = (commit: AgentCommit): string => commit.hash.slice(0, 7);
export const isMerge = (commit: AgentCommit): boolean => commit.parents > 1;

export type AgentCommitsRead =
  /** Newest first. */
  | { readonly kind: "commits"; readonly commits: readonly AgentCommit[] }
  | { readonly kind: "notARepository" }
  | { readonly kind: "failed" }
  | { readonly kind: "timedOut" };

// MARK: - commands

/** Printed instead of anything else where the folder is not a working tree (or git refuses it), and where it is gone. */
export const notARepositoryMarker = "HERDR-GIT-NOT-A-REPOSITORY";
export const noFolderMarker = "HERDR-GIT-NO-FOLDER";
/**
 * Printed instead of anything else where git's setup runs a filter that
 * cannot be turned off on its command line (or has a filter key that
 * is not `filter.<name>.<variable>`), and, for a tracked file's diff, where the
 * file goes through a filter (its working copy compares only through it).
 */
export const runsAFilterMarker = "HERDR-GIT-RUNS-A-FILTER";
/** Git could not say which filters it has. */
export const failedMarker = "HERDR-GIT-FAILED";

/** The output's parts, each after its marker line. */
export type GitSection = "HEAD" | "OID" | "TOP" | "STATUS" | "UNSTAGED" | "STAGED" | "UNTRACKED" | "SHOW" | "LOG" | "END" | "EXITS";

export const gitSections: readonly GitSection[] = ["HEAD", "OID", "TOP", "STATUS", "UNSTAGED", "STAGED", "UNTRACKED", "SHOW", "LOG", "END", "EXITS"];

/** A marker no path can make by chance: it carries the command's own nonce (letters and digits). */
export function gitMarker(section: GitSection, nonce: string): string {
  return "HERDR-CHANGES-" + nonce + "-" + section;
}

/** A fresh nonce: 16 hex digits. */
export function makeNonce(): string {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Every git call's own guards: no pager, no lock and no index refresh, no fsmonitor hook, no signature check (gpg.program). */
const gitOptions =
  "--no-pager --no-optional-locks -c core.quotepath=off -c color.ui=never " +
  "-c core.fsmonitor=false -c diff.autoRefreshIndex=false -c log.showSignature=false";

/** git in the folder with every configured filter turned off (the preamble leaves those `-c`s in "$@"). */
const g = "git " + gitOptions + ' -C "$F" "$@"';

/** A filter key's variable, checked letter by letter (no range: a locale cannot widen it). */
const lowercase = "abcdefghijklmnopqrstuvwxyz";

/**
 * The folder's checks, then every filter git has set up (the
 * repository's, the user's, the system's, through includes) turned off for each
 * command: git runs a clean, smudge or process filter only where
 * `filter.<name>.clean`, `.smudge` or `.process` is a non-empty command, and a
 * `-c` on the command line is read after every config file; so each name `git
 * config` lists is given empty commands and `required=false` (a required filter
 * with no command would otherwise stop git). git has no switch that turns
 * filters off for `status` or `diff`, and `--attr-source` still reads
 * `$GIT_DIR/info/attributes`, so the names are what it takes.
 *
 * The names are read first, read
 * only, NUL-terminated (`git config -z --name-only --get-regexp`), with git's
 * exit after them, through `od` byte for byte: no list of names is ever split on
 * a newline or on IFS (only `od`'s three-digit numbers are split). Each key is
 * made again from its bytes (`printf` of `\ooo`, nothing in it evaluated) and
 * checked whole: `filter.` then a name (any bytes, none of them a newline or an
 * "=", which a `-c` cannot say: git splits there) then "." and a variable git
 * would write (a lowercase letter, then lowercase letters, digits or "-"). A
 * key that is not one, git's exit other than 0 or 1, or anything else `od` did
 * not print as a byte, and the folder is not read: no command that could apply
 * a filter runs (`runsAFilter`, or `failed` when git could not list them). A
 * tracked file's diff whose file goes through a configured filter (`check-attr`)
 * is not run either: without its filter the working copy does not compare with
 * what git stored. Submodules are not looked into (`--ignore-submodules=dirty`):
 * their own config's filters are not in this list. GIT_NO_LAZY_FETCH=1: a partial
 * clone does not fetch.
 *
 * `strict` false (the log: stored commits, no working copy, no text conversion
 * or external diff, so no filter it could reach): the names that can be said
 * are turned off all the same, and a key that cannot be is passed over.
 */
function preamble(folder: string, options: { readonly filterOf?: string; readonly strict?: boolean } = {}): string {
  const plain = "git " + gitOptions + ' -C "$F"';
  const strict = options.strict !== false;
  const path = strict ? options.filterOf : undefined;
  let script =
    "F=" + q(folder) + "; " +
    '[ -d "$F" ] || { echo ' + noFolderMarker + "; exit 0; }; " +
    "GIT_OPTIONAL_LOCKS=0; GIT_NO_LAZY_FETCH=1; export GIT_OPTIONAL_LOCKS GIT_NO_LAZY_FETCH; set --; " +
    '[ "$(' + plain + ' rev-parse --is-inside-work-tree 2>/dev/null)" = true ] || { echo ' +
    notARepositoryMarker + "; exit 0; }; " +
    "O=$( { " + plain + " config -z --name-only --get-regexp '^filter\\.' 2>/dev/null; printf '%s' \"$?\"; } | od -An -v -to1 )" +
    (strict ? " || { echo " + failedMarker + "; exit 0; }; " : "; ");
  if (path !== undefined) {
    script +=
      "U=$(" + plain + " rev-parse --show-cdup 2>/dev/null) || { echo " + failedMarker + "; exit 0; }; " +
      "A=$(" + plain + ' check-attr filter -- "$U"' + q(path) + " 2>/dev/null) || { echo " +
      failedMarker + "; exit 0; }; V=${A##*: }; ";
  }
  // Each byte's number: 000 ends a key, 012 (a newline) or 075 (an "=") spoils
  // it (Z), any other byte is kept as `\ooo`; the rest after the last key is
  // git's exit ("0" or "1"). `$Z$k`: a spoilt key does not start with "filter.".
  script +=
    "B=; H=; r=; Z=; unset IFS; set -f; for b in $O; do case $b in " +
    '000) k=$(printf "$r"); n=${k#filter.}; v=${n##*.}; n=${n%.*}; ' +
    "case $Z$k in filter.*.*) " +
    'case $v in ""|[!' + lowercase + "]*|*[!" + lowercase + "0123456789-]*) B=1;; *) " +
    (path === undefined ? "" : '[ "$n" = "$V" ] && H=1; ') +
    'set -- "$@" -c "filter.$n.clean=" -c "filter.$n.smudge=" -c "filter.$n.process=" -c "filter.$n.required=false";; ' +
    "esac;; *) B=1;; esac; r=; Z=;; " +
    "012|075) Z=1; r=$r\\\\$b;; [0123][01234567][01234567]) r=$r\\\\$b;; *) B=1;; esac; done; set +f; ";
  if (strict) {
    script +=
      "case $r in '\\060'|'\\061') ;; *) echo " + failedMarker + "; exit 0;; esac; " +
      '[ -z "$B" ] || { echo ' + runsAFilterMarker + "; exit 0; }; ";
  }
  if (path !== undefined) script += '[ -z "$H" ] || { echo ' + runsAFilterMarker + "; exit 0; }; ";
  return script;
}

const mark = (section: GitSection, nonce: string): string => "printf '%s\\n' " + gitMarker(section, nonce) + "; ";

/** One section: its marker, its command, and its exit status (to fd 3: the exits, kept apart from the cut output). */
const step = (section: GitSection, nonce: string, command: string): string =>
  mark(section, nonce) + command + '; echo "' + section + ' $?" >&3; ';

/**
 * The sections cut at `maxBytes` on the Mac (`head -c`), each section's
 * exit kept outside the cut (fd 3, read into $R), then printed after the output
 * under the exits marker: the cap never hides a status. The parser takes a
 * failed section as a failure, except the one the cut stopped (git dies of the
 * closed pipe there) and any after it.
 */
const capped = (sections: string, nonce: string, maxBytes: number): string =>
  "exec 4>&1; R=$( { { " + sections + mark("END", nonce) + "} </dev/null 2>/dev/null | head -c " + String(maxBytes) +
  " >&4; } 3>&1 ); printf '\\n%s\\n%s\\n' " + gitMarker("EXITS", nonce) + ' "$R"';

const wrap = (script: string): string => "/bin/sh -c " + q(script);

/**
 * The a/ and b/ prefixes whatever the user's config says
 * (diff.mnemonicPrefix writes i/ and w/, diff.noprefix none), so the diff view
 * reads the names the same way everywhere. `--submodule=short`: a
 * submodule's change is its commit ids, never a diff git runs inside it.
 */
const diffFlags = "--no-color --no-ext-diff --no-textconv --submodule=short -M --src-prefix=a/ --dst-prefix=b/";

/** The branch, the top folder, `git status --porcelain=v1 -z` and both numstats, in one exec, cut at `maxBytes`. */
export function statusCommand(folder: string, nonce: string, maxBytes: number): string {
  return wrap(
    preamble(folder) +
      capped(
        step("HEAD", nonce, g + " symbolic-ref -q HEAD") +
          step("OID", nonce, g + " rev-parse -q --verify HEAD") +
          step("TOP", nonce, g + " rev-parse --show-toplevel") +
          step("STATUS", nonce, g + " status --porcelain=v1 -z --ignore-submodules=dirty") +
          step("UNSTAGED", nonce, g + " diff --numstat -z --ignore-submodules=dirty " + diffFlags) +
          step("STAGED", nonce, g + " diff --cached --numstat -z --ignore-submodules=dirty " + diffFlags),
        nonce,
        maxBytes,
      ),
  );
}

/** One file's diff: staged, then not staged (a rename's source too); an untracked file against nothing, from the top. */
export function fileDiffCommand(folder: string, change: GitFileChange, nonce: string, maxBytes: number): string {
  if (isUntracked(change)) {
    return wrap(
      preamble(folder) +
        "T=$(" + g + ' rev-parse --show-toplevel) && cd -- "$T" || exit 0; ' +
        capped(step("UNTRACKED", nonce, "git " + gitOptions + ' "$@" diff --no-index ' + diffFlags + " -- /dev/null " + q(change.path)), nonce, maxBytes),
    );
  }
  const specs = [change.path, ...(change.originalPath === null ? [] : [change.originalPath])].map((path) => q(":(top,literal)" + path)).join(" ");
  return wrap(
    preamble(folder, { filterOf: change.path }) +
      capped(
        step("STAGED", nonce, g + " diff --cached --ignore-submodules=dirty " + diffFlags + " -- " + specs) +
          step("UNSTAGED", nonce, g + " diff --ignore-submodules=dirty " + diffFlags + " -- " + specs),
        nonce,
        maxBytes,
      ),
  );
}

/** One commit with its stat and diff (a merge against its first parent); null for anything that is not a full hash. */
export function showCommand(folder: string, hash: string, nonce: string, maxBytes: number): string | null {
  if (!isHash(hash)) return null;
  return wrap(
    preamble(folder) +
      capped(step("SHOW", nonce, g + " show " + diffFlags + " -m --first-parent --stat --patch --format=medium --date=iso " + hash + " --"), nonce, maxBytes),
  );
}

/** Hash, committer time, parents, subject, then `--shortstat`'s line. */
const logFormat = "%x1e%H%x1f%ct%x1f%P%x1f%s%x1f";

/** `since` as git takes it: UTC, whole seconds (the start of 1970 for anything earlier, or none). */
export function isoSeconds(since: number): string {
  const seconds = Number.isFinite(since) && since > 0 ? Math.floor(since) : 0;
  return new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * The commits since `since`, with the files each changed. Its own
 * command, framed and with its exits like the others: the HEAD first, and on an
 * unborn one (no commits yet) no `git log` (which fails there): an empty
 * history. `log` reads stored commits, no working copy, with no text
 * conversion or external diff: no filter is in its way. Every
 * filter whose name can be said is turned off for it all the same; one that
 * cannot be does not stop it (`strict` false).
 */
export function logCommand(folder: string, since: number, maxCount: number, nonce: string, maxBytes: number): string {
  return wrap(
    preamble(folder, { strict: false }) +
      capped(
        mark("OID", nonce) + g + ' rev-parse -q --verify HEAD; o=$?; echo "OID $o" >&3; [ $o != 0 ] || { ' +
          step(
            "LOG",
            nonce,
            g + " log --no-color --no-ext-diff --no-textconv --since=" + q(isoSeconds(since)) + " --max-count=" + String(Math.max(1, Math.floor(maxCount))) +
              " --format=" + q(logFormat) + " --shortstat",
          ) +
          "}; ",
        nonce,
        maxBytes,
      ),
  );
}

/** The exits that are not failures: `symbolic-ref -q` on a detached HEAD and `rev-parse -q --verify HEAD` on an unborn one (1), `diff --no-index` finding a difference (1). */
const meantExits: Partial<Record<GitSection, readonly number[]>> = {
  HEAD: [0, 1],
  OID: [0, 1],
  TOP: [0],
  STATUS: [0],
  UNSTAGED: [0],
  STAGED: [0],
  UNTRACKED: [0, 1],
  SHOW: [0],
  LOG: [0],
};

/**
 * What a command prints, for a fake git (demo mode, tests): each section
 * after its marker, the end marker (unless the output was cut), then each
 * section's exit (`exits`, else 0).
 */
export function gitOutput(
  sections: readonly (readonly [GitSection, string])[],
  nonce: string,
  options: { readonly exits?: Partial<Record<GitSection, number>>; readonly cut?: boolean } = {},
): string {
  let text = sections.map(([section, body]) => gitMarker(section, nonce) + "\n" + body).join("");
  if (options.cut !== true) text += gitMarker("END", nonce) + "\n";
  text += "\n" + gitMarker("EXITS", nonce) + "\n";
  for (const [section] of sections) {
    if (meantExits[section] !== undefined) text += section + " " + String(options.exits?.[section] ?? 0) + "\n";
  }
  return text;
}

// MARK: - parsing

interface Sections {
  readonly parts: Partial<Record<GitSection, string>>;
  /** The sections in their order, the exits left out. */
  readonly order: readonly GitSection[];
  /** The end marker came (else the output was cut). */
  readonly complete: boolean;
}

/** The text after each marker, up to the next one; whether the end marker came. */
function sections(output: string, nonce: string): Sections {
  const found: { section: GitSection; start: number; end: number }[] = [];
  for (const section of gitSections) {
    const marker = gitMarker(section, nonce) + "\n";
    const start = output.indexOf(marker);
    if (start >= 0) found.push({ section, start, end: start + marker.length });
  }
  found.sort((a, b) => a.start - b.start);
  const parts: Partial<Record<GitSection, string>> = {};
  found.forEach((entry, index) => {
    const next = found[index + 1];
    let end = next?.start ?? output.length;
    // The line break printed before the exits is not the section's (a cut one ends where the cut was).
    if (next?.section === "EXITS" && end > entry.end && output[end - 1] === "\n") end -= 1;
    parts[entry.section] = output.slice(entry.end, end);
  });
  return { parts, order: found.map((entry) => entry.section).filter((section) => section !== "EXITS"), complete: parts.END !== undefined };
}

/** Each section's exit status, from the lines after the exits marker; null where there is no such marker. */
function exits(output: string, nonce: string): Partial<Record<GitSection, number>> | null {
  const marker = gitMarker("EXITS", nonce) + "\n";
  const start = output.indexOf(marker);
  if (start < 0) return null;
  const read: Partial<Record<GitSection, number>> = {};
  for (const line of output.slice(start + marker.length).split("\n")) {
    const words = line.split(" ").filter((word) => word.length > 0);
    if (words.length !== 2 || !(gitSections as readonly string[]).includes(words[0]!) || !/^-?\d+$/.test(words[1]!)) continue;
    read[words[0] as GitSection] = Number(words[1]);
  }
  return read;
}

/**
 * Every section that ran to its end exited as git means it to; the one
 * the cut stopped (and any after it) is not judged: it died of the closed pipe,
 * or never ran. No exits at all: a failure.
 */
function exitedWell(output: string, nonce: string, read: Sections): boolean {
  const codes = exits(output, nonce);
  if (codes === null) return false;
  for (const section of read.complete ? read.order : read.order.slice(0, -1)) {
    const meant = meantExits[section];
    if (meant === undefined) continue;
    const code = codes[section];
    if (code === undefined || !meant.includes(code)) return false;
  }
  return true;
}

function line(text: string | undefined): string {
  let value = text ?? "";
  while (value.endsWith("\n") || value.endsWith("\r")) value = value.slice(0, -1);
  return value;
}

/** NUL-terminated fields; the last one is dropped when it has no NUL (the output was cut inside it). */
function fields(text: string | undefined, cut: boolean): string[] {
  if (text === undefined || text.length === 0) return [];
  const all = text.split("\0");
  const last = all[all.length - 1];
  // A terminated last field leaves "" after it; an unterminated one is whole only when nothing was cut.
  if (last === "" || last === "\n") all.pop();
  else if (cut) all.pop();
  return all;
}

/** `--numstat -z`: "added\tremoved\tpath" or, for a rename, "added\tremoved\t" then the source and the destination; "-" for a binary file's counts. */
function numstat(tokens: readonly string[]): { path: string; added: number | null; removed: number | null; binary: boolean }[] {
  const entries: { path: string; added: number | null; removed: number | null; binary: boolean }[] = [];
  let index = 0;
  const count = (text: string): number | null => (/^\d+$/.test(text) ? Number(text) : null);
  while (index < tokens.length) {
    const token = tokens[index]!;
    index += 1;
    const first = token.indexOf("\t");
    const second = first < 0 ? -1 : token.indexOf("\t", first + 1);
    if (second < 0) continue;
    const addedText = token.slice(0, first);
    const removedText = token.slice(first + 1, second);
    let path = token.slice(second + 1);
    if (path.length === 0) {
      if (index + 1 >= tokens.length) break;
      path = tokens[index + 1]!;
      index += 2;
    }
    entries.push({ path, added: count(addedText), removed: count(removedText), binary: addedText === "-" && removedText === "-" });
  }
  return entries;
}

function markerOnly<T>(output: string, notARepository: T, noFolder: T, runsAFilter: T, failed: T): T {
  if (output.includes(noFolderMarker)) return noFolder;
  if (output.includes(notARepositoryMarker)) return notARepository;
  if (output.includes(runsAFilterMarker)) return runsAFilter;
  return failed;
}

export function parseStatus(output: string, nonce: string): GitFolderRead {
  const read = sections(output, nonce);
  const { parts, order, complete } = read;
  if (order.length === 0 && parts.EXITS === undefined) {
    return markerOnly<GitFolderRead>(output, { kind: "notARepository" }, { kind: "noFolder" }, { kind: "runsAFilter" }, { kind: "failed" });
  }
  if (parts.STATUS === undefined && complete) return { kind: "failed" };
  if (!exitedWell(output, nonce, read)) return { kind: "failed" };
  const last = order[order.length - 1];
  const isCut = (section: GitSection): boolean => !complete && last === section;

  const symbolic = line(parts.HEAD);
  const oid = line(parts.OID);
  let head: GitHead;
  if (symbolic.startsWith("refs/heads/")) {
    const name = symbolic.slice("refs/heads/".length);
    head = oid.length === 0 ? { kind: "unborn", name } : { kind: "branch", name };
  } else if (symbolic.length > 0) {
    head = oid.length === 0 ? { kind: "unborn", name: symbolic } : { kind: "branch", name: symbolic };
  } else if (oid.length > 0) {
    head = { kind: "detached", hash: oid.slice(0, 7) };
  } else {
    head = { kind: "unknown" };
  }
  const top = line(parts.TOP);

  const counts = new Map<string, { added: number | null; removed: number | null; binary: boolean }>();
  const sum = (a: number | null | undefined, b: number | null): number | null => {
    if (a !== null && a !== undefined && b !== null) return a + b;
    return a ?? b;
  };
  for (const section of ["UNSTAGED", "STAGED"] as const) {
    for (const entry of numstat(fields(parts[section], isCut(section)))) {
      const old = counts.get(entry.path);
      const binary = (old?.binary ?? false) || entry.binary;
      counts.set(
        entry.path,
        binary ? { added: null, removed: null, binary: true } : { added: sum(old?.added, entry.added), removed: sum(old?.removed, entry.removed), binary: false },
      );
    }
  }

  const files: GitFileChange[] = [];
  const tokens = fields(parts.STATUS, isCut("STATUS"));
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index]!;
    index += 1;
    if (token.length < 4 || token[2] !== " ") continue;
    const x = token[0]!;
    const y = token[1]!;
    const path = token.slice(3);
    let original: string | null = null;
    if ("RC".includes(x) || "RC".includes(y)) {
      if (index >= tokens.length) break;
      original = tokens[index]!;
      index += 1;
    }
    const count = counts.get(path);
    files.push({
      path,
      originalPath: original,
      indexStatus: x,
      worktreeStatus: y,
      added: count?.added ?? null,
      removed: count?.removed ?? null,
      binary: count?.binary ?? false,
    });
  }
  return { kind: "repository", status: { top: top.length === 0 ? null : top, head, files, cut: !complete } };
}

/** A file's diff or a commit, by its parts. */
export function parseText(output: string, nonce: string): GitTextResult {
  const read = sections(output, nonce);
  if (read.order.length === 0 && read.parts.EXITS === undefined) {
    return markerOnly<GitTextResult>(output, { kind: "notARepository" }, { kind: "noFolder" }, { kind: "runsAFilter" }, { kind: "failed" });
  }
  if (!exitedWell(output, nonce, read)) return { kind: "failed" };
  const titled: readonly [GitSection, string][] = [
    ["STAGED", "Staged"],
    ["UNSTAGED", "Not staged"],
    ["UNTRACKED", "Untracked"],
    ["SHOW", ""],
  ];
  const parts: GitTextPart[] = [];
  for (const [section, title] of titled) {
    const body = read.parts[section];
    if (body !== undefined && body.length > 0) parts.push({ title, text: body });
  }
  return { kind: "text", text: { parts, cut: !read.complete } };
}

/** " 2 files changed, 10 insertions(+), 3 deletions(-)"; zeros where a count is not there. */
function shortstat(text: string): { files: number; added: number; removed: number } {
  let files = 0;
  let added = 0;
  let removed = 0;
  for (const clause of text.split(",")) {
    const words = clause.split(/\s+/).filter((word) => word.length > 0);
    if (words.length < 2 || !/^\d+$/.test(words[0]!)) continue;
    const number = Number(words[0]);
    if (words[1]!.startsWith("file")) files = number;
    if (words[1]!.startsWith("insertion")) added = number;
    if (words[1]!.startsWith("deletion")) removed = number;
  }
  return { files, added, removed };
}

/** The commits at or after `since`, newest first. Framed; an unborn HEAD is an empty history; a failed `git log` a failure. */
export function parseLog(output: string, since: number, nonce: string): AgentCommitsRead {
  const read = sections(output, nonce);
  if (read.order.length === 0 && read.parts.EXITS === undefined) {
    if (output.includes(notARepositoryMarker) || output.includes(noFolderMarker)) return { kind: "notARepository" };
    return { kind: "failed" };
  }
  if (!exitedWell(output, nonce, read)) return { kind: "failed" };
  const log = read.parts.LOG;
  if (log === undefined) {
    // No commits yet (the HEAD's rev-parse said 1), or cut first.
    return exits(output, nonce)?.OID === 1 ? { kind: "commits", commits: [] } : { kind: "failed" };
  }
  const commits: { index: number; commit: AgentCommit }[] = [];
  for (const record of log.split("\u001e")) {
    if (record.length === 0) continue;
    const parts = record.split("\u001f");
    if (parts.length < 5) continue;
    const [hash, time, parentsText, subject] = parts as [string, string, string, string];
    const rest = parts.slice(4).join("\u001f");
    if (!isHash(hash) || !/^\d+(\.\d+)?$/.test(time)) continue;
    const seconds = Number(time);
    if (seconds < since) continue;
    const parents = parentsText.split(" ").filter((p) => p.length > 0).length;
    const stat = shortstat(rest);
    const merge = parents > 1;
    commits.push({
      index: commits.length,
      commit: {
        hash,
        subject,
        time: seconds,
        parents,
        files: merge ? null : stat.files,
        added: merge ? null : stat.added,
        removed: merge ? null : stat.removed,
      },
    });
  }
  commits.sort((a, b) => (a.commit.time !== b.commit.time ? b.commit.time - a.commit.time : a.index - b.index));
  return { kind: "commits", commits: commits.map((entry) => entry.commit) };
}

/** A full hash: 40 or 64 lower-case hex digits. */
export function isHash(text: string): boolean {
  return (text.length === 40 || text.length === 64) && /^[0-9a-f]+$/.test(text);
}

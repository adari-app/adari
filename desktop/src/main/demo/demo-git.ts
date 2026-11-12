// Demo mode's git (a port of the Swift app's
// CompanionChangesFixture.Git), answering from memory by command: the nonce
// read from the command, the folder from its quoted name, the file from its
// pathspec. The Mac mini's Mac-build worktree is on its work
// branch with a change not staged, one staged and an untracked file, and two
// commits after its session began; Quartz's folder, which two agents share,
// is on a release branch with one change and one commit; the design folder is
// clean; every other folder is not a repository. Invented content; nothing
// runs anywhere.

import { gitOutput, notARepositoryMarker, type GitSection } from "../../shared/changes/git";
import { ChangesCancelled, type ReadOnlyCommandRunner } from "../../shared/changes/reader";

export const demoGitFolders = {
  macBuild: "/Users/demo/code/worktrees/aurora-web-mac",
  quartz: "/Users/demo/code/quartz",
  design: "/Users/demo/code/worktrees/aurora-web-design",
} as const;

export const demoGitCommit = "4f1c2a9e7b3d5c6a8e9f0b1c2d3e4f5a6b7c8d9e";

const oid = "a".repeat(40) + "\n";

/** A long line, to scroll sideways. */
const longLine =
  "        let summary = \"" + "Return sends, Shift-Return starts a new line, on every keyboard. ".repeat(4) + "\"";

export interface DemoGitFolder {
  readonly branch: string;
  readonly status: string;
  readonly unstaged: string;
  readonly staged: string;
  readonly diffs: Readonly<Record<string, { readonly staged: string; readonly unstaged: string }>>;
  /** Hash, minutes before the demo's start, subject, shortstat line. */
  readonly commits: readonly (readonly [string, number, string, string])[];
}

const folders: Readonly<Record<string, DemoGitFolder>> = {
  [demoGitFolders.macBuild]: {
    branch: "z/aurora-web-mac",
    status: " M App/Terminal/CompanionTerminalView.swift\0M  App/CompanionChatComposer.swift\0?? notes/mac-input.md\0",
    unstaged: "5\t1\tApp/Terminal/CompanionTerminalView.swift\0",
    staged: "14\t3\tApp/CompanionChatComposer.swift\0",
    diffs: {
      "App/Terminal/CompanionTerminalView.swift": {
        staged: "",
        unstaged: [
          "diff --git a/App/Terminal/CompanionTerminalView.swift b/App/Terminal/CompanionTerminalView.swift",
          "index 3f2a1b0..8c9d7e4 100644",
          "--- a/App/Terminal/CompanionTerminalView.swift",
          "+++ b/App/Terminal/CompanionTerminalView.swift",
          "@@ -88,7 +88,11 @@ final class CompanionTerminalView: UIView {",
          "     private func installGestures() {",
          "         let pan = UIPanGestureRecognizer(target: self, action: #selector(handlePan(_:)))",
          "-        pan.allowedScrollTypesMask = []",
          "+        pan.allowedScrollTypesMask = .all",
          "+        pan.maximumNumberOfTouches = 2",
          "+        // trackpad and mouse wheel, not only touches",
          "+        addGestureRecognizer(pan)",
          "+" + longLine,
          "     }",
          " ",
          "     @objc private func handlePan(_ pan: UIPanGestureRecognizer) {",
          "",
        ].join("\n"),
      },
      "App/CompanionChatComposer.swift": {
        staged: [
          "diff --git a/App/CompanionChatComposer.swift b/App/CompanionChatComposer.swift",
          "index 1a2b3c4..5d6e7f8 100644",
          "--- a/App/CompanionChatComposer.swift",
          "+++ b/App/CompanionChatComposer.swift",
          "@@ -38,9 +38,20 @@ final class ComposerTextView: UITextView {",
          "     override var keyCommands: [UIKeyCommand]? {",
          "-        [UIKeyCommand(input: \"\\r\", modifierFlags: .command, action: #selector(send))]",
          "-    }",
          "-    // Return inserts a new line.",
          "+        let send = UIKeyCommand(input: \"\\r\", modifierFlags: [], action: #selector(send))",
          "+        send.wantsPriorityOverSystemBehavior = true",
          "+        let newline = UIKeyCommand(input: \"\\r\", modifierFlags: .shift, action: #selector(newLine))",
          "+        return [send, newline]",
          "+    }",
          "+",
          "+    @objc private func newLine() {",
          "+        insertText(\"\\n\")",
          "+    }",
          "+",
          "+    // Return sends; Shift-Return makes a new line.",
          "+    // The key command wins over the text view's own newline.",
          "+    // The iPad's attached keyboard takes the same commands.",
          "+",
          "     @objc private func send() {",
          "         onSend?(text)",
          "     }",
          "",
        ].join("\n"),
        unstaged: "",
      },
    },
    commits: [
      [demoGitCommit, 6, "Return sends and Shift-Return makes a new line", " 1 file changed, 14 insertions(+), 3 deletions(-)"],
      ["9b8a7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b", 27, "Scroll the terminal with the trackpad and the wheel", " 2 files changed, 48 insertions(+), 6 deletions(-)"],
    ],
  },
  [demoGitFolders.quartz]: {
    branch: "release/2.2.10",
    status: " M Quartz/PaywallView.swift\0",
    unstaged: "1\t1\tQuartz/PaywallView.swift\0",
    staged: "",
    diffs: {
      "Quartz/PaywallView.swift": {
        staged: "",
        unstaged: [
          "diff --git a/Quartz/PaywallView.swift b/Quartz/PaywallView.swift",
          "index 0a1b2c3..4d5e6f7 100644",
          "--- a/Quartz/PaywallView.swift",
          "+++ b/Quartz/PaywallView.swift",
          "@@ -18,3 +18,3 @@ struct PaywallView: View {",
          "     var headline: String {",
          "-        \"Start your trial\"",
          "+        \"Try it free\"",
          "     }",
          "",
        ].join("\n"),
      },
    },
    commits: [["1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d", 40, "Bump the build to 2.2.10", " 1 file changed, 1 insertion(+), 1 deletion(-)"]],
  },
  [demoGitFolders.design]: {
    branch: "z/aurora-web-design",
    status: "",
    unstaged: "",
    staged: "",
    diffs: {},
    commits: [],
  },
};

const untrackedDiff = [
  "diff --git a/notes/mac-input.md b/notes/mac-input.md",
  "new file mode 100644",
  "index 0000000..1111111",
  "--- /dev/null",
  "+++ b/notes/mac-input.md",
  "@@ -0,0 +1,3 @@",
  "+# Mac input",
  "+",
  "+Trackpad scrolling, Return to send, the touch key row hidden.",
  "",
].join("\n");

const show = [
  "commit " + demoGitCommit,
  "Author: Fixture <fixture@example.invalid>",
  "Date:   2026-11-02 21:12:00 +0000",
  "",
  "    Return sends and Shift-Return makes a new line",
  "",
  "---",
  " App/CompanionChatComposer.swift | 17 ++++++++++++++---",
  " 1 file changed, 14 insertions(+), 3 deletions(-)",
  "",
  "diff --git a/App/CompanionChatComposer.swift b/App/CompanionChatComposer.swift",
  "index 1111111..2222222 100644",
  "--- a/App/CompanionChatComposer.swift",
  "+++ b/App/CompanionChatComposer.swift",
  "@@ -38,4 +38,6 @@ final class ComposerTextView: UITextView {",
  "     override var keyCommands: [UIKeyCommand]? {",
  "-        [UIKeyCommand(input: \"\\r\", modifierFlags: .command, action: #selector(send))]",
  "+        let send = UIKeyCommand(input: \"\\r\", modifierFlags: [], action: #selector(send))",
  "+        let newline = UIKeyCommand(input: \"\\r\", modifierFlags: .shift, action: #selector(newLine))",
  "+        return [send, newline]",
  "     }",
  "",
].join("\n");

/** What a DemoGit answers from (the showcase has its own). */
export interface DemoGitData {
  readonly folders: Readonly<Record<string, DemoGitFolder>>;
  /** `git show` by commit hash; a hash not listed shows `defaultShow`. */
  readonly shows: Readonly<Record<string, string>>;
  readonly defaultShow: string;
  /** An untracked file's diff by its path; a path not listed shows `defaultUntracked`. */
  readonly untracked: Readonly<Record<string, string>>;
  readonly defaultUntracked: string;
}

export const demoGitData: DemoGitData = { folders, shows: {}, defaultShow: show, untracked: {}, defaultUntracked: untrackedDiff };

/** The nonce a command's markers carry. */
export function demoNonce(command: string): string | null {
  const at = command.indexOf("HERDR-CHANGES-");
  if (at < 0) return null;
  const match = /^[A-Za-z0-9]+/.exec(command.slice(at + "HERDR-CHANGES-".length));
  return match === null ? null : match[0];
}

/** Demo mode's git: `startMs` is the demo's start, the commits' times are before it. */
export class DemoGit implements ReadOnlyCommandRunner {
  /** Commands run (tests). */
  readonly commands: string[] = [];

  constructor(
    private readonly startMs: number,
    private readonly data: DemoGitData = demoGitData,
  ) {}

  runReadOnlyCommand(command: string, _maxOutputBytes: number, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted === true) return Promise.reject(new ChangesCancelled());
    this.commands.push(command);
    return Promise.resolve(this.answer(command));
  }

  private answer(command: string): string {
    const folders = this.data.folders;
    const name = Object.keys(folders).find((folder) => command.includes(folder + "'"));
    if (name === undefined) return notARepositoryMarker + "\n";
    const folder = folders[name]!;
    const nonce = demoNonce(command);
    if (nonce === null) return "";
    const output = (sections: readonly (readonly [GitSection, string])[]): string => gitOutput(sections, nonce);
    if (command.includes(" log --no-color")) {
      if (folder.commits.length === 0) return output([["OID", oid], ["LOG", ""]]);
      return output([["OID", oid], ["LOG", this.log(folder)]]);
    }
    if (command.includes("status --porcelain")) {
      return output([
        ["HEAD", `refs/heads/${folder.branch}\n`],
        ["OID", oid],
        ["TOP", name + "\n"],
        ["STATUS", folder.status],
        ["UNSTAGED", folder.unstaged],
        ["STAGED", folder.staged],
      ]);
    }
    if (command.includes(" show ")) {
      const hash = Object.keys(this.data.shows).find((candidate) => command.includes(candidate));
      return output([["SHOW", hash === undefined ? this.data.defaultShow : this.data.shows[hash]!]]);
    }
    if (command.includes("--no-index")) {
      const path = Object.keys(this.data.untracked).find((candidate) => command.includes(candidate));
      return output([["UNTRACKED", path === undefined ? this.data.defaultUntracked : this.data.untracked[path]!]]);
    }
    const entry = Object.entries(folder.diffs).find(([path]) => command.includes(":(top,literal)" + path));
    if (entry === undefined) return output([["STAGED", ""], ["UNSTAGED", ""]]);
    return output([["STAGED", entry[1].staged], ["UNSTAGED", entry[1].unstaged]]);
  }

  private log(folder: DemoGitFolder): string {
    return folder.commits
      .map(([hash, minutes, subject, stat]) => `\u001e${hash}\u001f${Math.floor((this.startMs - minutes * 60_000) / 1000)}\u001f\u001f${subject}\u001f\n${stat}\n`)
      .join("");
  }
}

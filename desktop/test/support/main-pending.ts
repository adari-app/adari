// main's earlier pending.ts (the commit in mainCommit) loaded beside this one, for the parity
// tests: read from git (`git show`, this repository's own history, with an empty global config and no system
// config), written under the test scratch folder with its relative imports pointed at this worktree's src, then
// imported. Never written into the repository.

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { emptyGlobalConfig, scratch } from "./changes-git";

/** The commit the earlier pending.ts is read from. */
export const mainCommit = "1eb8ac6f";

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

type PendingModule = typeof import("../../src/shared/chat/pending");
let loaded: Promise<PendingModule> | null = null;
let present: boolean | null = null;

/**
 * Whether this repository's history holds the earlier pending.ts (checked once). The public copy has one commit
 * per release and a download has no history at all: there the parity cases that need it are skipped.
 */
export function hasMainPending(): boolean {
  present ??= (() => {
    try {
      execFileSync("git", ["cat-file", "-e", `${mainCommit}:desktop/src/shared/chat/pending.ts`], {
        cwd: desktop,
        stdio: "ignore",
        env: { ...process.env, GIT_CONFIG_GLOBAL: emptyGlobalConfig(), GIT_CONFIG_NOSYSTEM: "1" },
      });
      return true;
    } catch {
      return false;
    }
  })();
  return present;
}

/** main's pending module (once per test file). */
export function mainPending(): Promise<PendingModule> {
  loaded ??= (async () => {
    const source = execFileSync("git", ["show", `${mainCommit}:desktop/src/shared/chat/pending.ts`], {
      cwd: desktop,
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_GLOBAL: emptyGlobalConfig(), GIT_CONFIG_NOSYSTEM: "1" },
    });
    const from = path.join(desktop, "src/shared/chat");
    const relocated = source.replace(/from "(\.\.?\/[^"]+)"/gu, (_whole, relative: string) => `from "${path.join(from, relative)}"`);
    const folder = path.join(scratch, `desktop-main-pending-${randomUUID()}`);
    mkdirSync(folder, { recursive: true });
    const file = path.join(folder, "main-pending.ts");
    writeFileSync(file, relocated);
    return (await import(/* @vite-ignore */ file)) as PendingModule;
  })();
  return loaded;
}

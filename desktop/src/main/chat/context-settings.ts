// The user's auto-compact settings for the context ring,
// read only over the transcripts' own reader (SFTP for an SSH machine, as
// agents.json is read): Claude Code's <config>/settings.json (the config
// folder from the transcript's path, <config>/projects/<slug>/<session>.jsonl),
// then the pane folder's .claude/settings.json and .claude/settings.local.json,
// the later winning; Codex's config.toml in the Codex home its rollout sits
// under. At most 64 KB of a file is read (a larger one is passed over), only
// the auto-compact keys are kept (context-meter.ts keepCompactSettings), and
// nothing of them is logged. A file is read again at most once a minute, and
// at once on a reconnect (the key carries the connection).

import {
  codexCompactLimit,
  contextSettingsPaths,
  isConfinedPath,
  keepCompactSettings,
  mergeCompactSettings,
  settingsReadLimit,
  settingsRereadMs,
  type ContextLimits,
  type KeptCompactSettings,
  type SettingsFileKind,
} from "../../shared/context-meter";
import type { ChipAgent } from "../../shared/agent-settings";
import type { TranscriptFileReader } from "../../shared/chat/feed";

const decoder = new TextDecoder("utf-8", { fatal: false });

/**
 * The reader as the settings need it: the machine's home (SFTP's
 * realpath("."), the login folder) and a file's real location (symlinks
 * followed). A reader that cannot name its home reads no settings (the limit
 * is unknown); one without realpath relies on the path's own checks.
 */
export interface SettingsFileReader extends TranscriptFileReader {
  home?(): Promise<string | null>;
  realpath?(path: string): Promise<string | null>;
}

/** A file's text, or null when there is none, it is larger than the bound, or it does not read. */
export async function readBounded(reader: TranscriptFileReader, path: string, limit = settingsReadLimit): Promise<string | null> {
  try {
    const size = await reader.size(path);
    if (size <= 0 || size > limit) return null;
    const bytes = await reader.read(path, 0, size);
    return decoder.decode(bytes.subarray(0, limit));
  } catch {
    return null;
  }
}

interface Cached {
  readonly at: number;
  readonly limits: Promise<ContextLimits>;
}

export class ContextSettings {
  private readonly cache = new Map<string, Cached>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * The limits for a pane's transcript. `key` names the machine and its
   * connection: a reconnect is a new key, read afresh.
   */
  load(reader: SettingsFileReader, key: string, format: ChipAgent, transcriptPath: string, cwd: string | null): Promise<ContextLimits> {
    const cacheKey = JSON.stringify([key, format, transcriptPath, cwd]);
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined && this.now() - cached.at < settingsRereadMs) return cached.limits;
    const limits = this.read(reader, format, transcriptPath, cwd);
    this.cache.set(cacheKey, { at: this.now(), limits });
    // A bounded cache: the oldest go first.
    while (this.cache.size > 64) this.cache.delete(this.cache.keys().next().value!);
    return limits;
  }

  /** Each file once, in order; Claude Code's merged, Codex's one value. */
  private async read(reader: SettingsFileReader, format: ChipAgent, transcriptPath: string, cwd: string | null): Promise<ContextLimits> {
    const home = (await reader.home?.().catch(() => null)) ?? null;
    const paths = home === null ? [] : contextSettingsPaths(format, transcriptPath, cwd, home);
    // A file whose real location (symlinks followed) is outside home is not read.
    const confined = async (path: string): Promise<string | null> => {
      if (home === null) return null;
      if (reader.realpath === undefined) return path;
      const real = await reader.realpath(path).catch(() => null);
      return real !== null && isConfinedPath(real, home) ? real : null;
    };
    const readConfined = async (path: string): Promise<string | null> => {
      const real = await confined(path);
      return real === null ? null : readBounded(reader, real);
    };
    if (format === "codex") {
      const file = paths[0];
      const text = file === undefined ? null : await readConfined(file.path);
      return { codexLimit: text === null ? null : codexCompactLimit(text) };
    }
    const files: { kind: SettingsFileKind; settings: KeptCompactSettings }[] = [];
    for (const file of paths) {
      const text = await readConfined(file.path);
      const settings = text === null ? null : keepCompactSettings(text);
      if (settings !== null) files.push({ kind: file.kind, settings });
    }
    return { claude: mergeCompactSettings(files) };
  }
}

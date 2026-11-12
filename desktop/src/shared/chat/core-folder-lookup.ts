// The one read-only lookup the iPhone app runs for a herdr-core Claude or Codex
// pane whose argv names no session (HerdrKit TranscriptLocator.swift, "the core
// finder's lookup"), ported line for line: the same `/usr/bin/perl` script, every value
// a single-quoted argument after `--` (never code), its answer read strictly.
// Pure functions, so the command is tested as text and run on synthetic homes;
// the main process runs it on the host's existing read-only exec
// (SshTranscriptReader.runReadOnlyCommand: its deadline, the output cap here).

import { isGrokSessionID, isUsableFolder, isUsablePath, maxExcluded, normalisedFolder, shellQuote } from "./locator";

/** The agents whose herdr-core panes are bound by this lookup (GrokPaneSession.coreFolderKinds). */
export type CoreFolderFormat = "claude" | "codex";

/**
 * A Claude or Codex folder lookup (TranscriptSessionRef `.folder` with `sinceProcess`): the folder, the
 * sessions peers name and earlier runs had (lower-case UUIDs, sorted), and the process on the Mac whose
 * start bounds it (the agent's, herdr-core's foreground pid).
 */
export interface CoreFolderRef {
  readonly format: CoreFolderFormat;
  readonly folder: string;
  readonly excluding: readonly string[];
  readonly sinceProcess: number;
}

/** A checked ref, or null (TranscriptSessionRef.init: a usable folder, a pid, at most 64 UUIDs skipped). */
export function makeCoreFolderRef(format: CoreFolderFormat, folder: string, excluding: readonly string[], sinceProcess: number): CoreFolderRef | null {
  if (!isUsableFolder(folder) || !Number.isInteger(sinceProcess) || sinceProcess <= 0 || sinceProcess > 0x7fffffff) return null;
  if (excluding.length > maxExcluded || !excluding.every(isGrokSessionID)) return null;
  // One session in either hex case; kept lower-case.
  return { format, folder, excluding: [...new Set(excluding.map((id) => id.toLowerCase()))].sort(), sinceProcess };
}

/** What the lookup printed: the agent process's start (14 digits, epoch seconds) and the transcript it proved, if any. */
export interface CoreFolderResult {
  readonly generation: string;
  readonly path: string | null;
}

/** A session an earlier lookup of the same terminal and pid found, skipped unless the process is still that one. */
export interface CoreEarlierSession {
  readonly generation: string;
  readonly id: string;
}

/** The most the lookup prints is a line; this much is read back. */
export const coreFolderOutputLimit = 64 * 1_024;
/** The process-start check's answer is one line of 15 bytes; this much is read back. */
export const coreGenerationOutputLimit = 1_024;

const utf8 = new TextEncoder();
const byteLength = (value: string): number => utf8.encode(value).length;

/** A trailing slash is not the folder's. */
const trimmedFolder = normalisedFolder;

/**
 * Claude Code's project folder name for a folder: every UTF-16 unit that is not an ASCII letter or digit
 * turned into "-", trailing slashes not the folder's (TranscriptLocator.claudeProjectSlug).
 */
export function coreClaudeProjectSlug(folder: string): string {
  return trimmedFolder(folder).replace(/[^A-Za-z0-9]/g, "-");
}

/** A longer name is cut there and a hash added (`<first 200>-<hash>`); the transcripts' own `cwd` decides. */
export const claudeSlugLimit = 200;

/** Whether `name` is the project folder Claude Code files `folder` in. */
export function isClaudeProjectFolder(name: string, folder: string): boolean {
  const slug = coreClaudeProjectSlug(folder);
  if (slug.length <= claudeSlugLimit) return name === slug;
  const head = slug.slice(0, claudeSlugLimit) + "-";
  return name.startsWith(head) && name.length > head.length && /^[A-Za-z0-9]+$/.test(name.slice(head.length));
}

/** The session id a Claude (`<id>.jsonl`) or Codex (`rollout-<time>-<id>.jsonl`) transcript is named by, a UUID; null for any other name. */
export function transcriptSessionID(path: string, format: CoreFolderFormat): string | null {
  const name = path.split("/").at(-1) ?? "";
  if (!name.endsWith(".jsonl")) return null;
  const stem = name.slice(0, -".jsonl".length);
  if (format === "claude") return isGrokSessionID(stem) ? stem : null;
  if (!stem.startsWith("rollout-") || byteLength(stem) <= "rollout-".length + 37) return null;
  const id = stem.slice(-36);
  return stem.slice(0, -36).endsWith("-") && isGrokSessionID(id) ? id : null;
}

/** A generation as the lookup prints it: 14 digits. */
export function isCoreGeneration(value: string): boolean {
  return /^[0-9]{14}$/.test(value);
}

/**
 * One read-only command for a herdr-core Claude or Codex pane's folder (TranscriptLocator.coreFolderCommand).
 * On the Mac it reads the agent process's start (`ps -o lstart=`, epoch seconds; nothing when the process is
 * gone), takes the UUID-named transcripts under the folder's Claude Code project folders (`~/.claude`, every
 * `~/.claude-seats/<name>`) or under `~/.codex/sessions/YYYY/MM/DD/`, regular files only, the excluded ones
 * skipped in either case, each written after the whole second the process started in; sorts them all newest
 * first and proves at most 32 by their records read as JSON (Claude: the first user, assistant or system record
 * gives this session's `sessionId`, no `isSidechain`, the folder as its top-level `cwd`; Codex: the first line is
 * this session's `session_meta`, `source` `cli`, the folder as `payload.cwd`); prints `<generation>\t<path>` for
 * the first proved, else `<generation>`, then a newline. Ends itself after 8 seconds. `earlier` are skipped
 * unless their generation is the process's. Null when anything does not check.
 */
export function coreFolderCommand(ref: CoreFolderRef, earlier: readonly CoreEarlierSession[] = []): string | null {
  if (ref.sinceProcess <= 0 || !isUsableFolder(ref.folder)) return null;
  if (!earlier.every((item) => isCoreGeneration(item.generation) && isGrokSessionID(item.id))) return null;
  if (!ref.excluding.every(isGrokSessionID)) return null;
  const folder = trimmedFolder(ref.folder);
  let project = "-";
  let long = "0";
  if (ref.format === "claude") {
    const slug = coreClaudeProjectSlug(folder);
    if (slug.length > claudeSlugLimit) {
      project = slug.slice(0, claudeSlugLimit) + "-";
      long = "1";
    } else {
      project = slug;
    }
  }
  const items = [...ref.excluding.map((id) => "x:" + id), ...earlier.map((item) => `g:${item.generation}:${item.id.toLowerCase()}`)];
  const args = [ref.format, String(ref.sinceProcess), folder, project, long, ...items];
  return "/usr/bin/perl -e " + shellQuote(coreFolderScript) + " -- " + args.map(shellQuote).join(" ");
}

/**
 * The lookup's answer, read strictly: valid UTF-8 (no replacement character), exactly one line
 * ending in its newline, a generation, and at most one usable path in the place this agent files its
 * transcripts, named by a session UUID nobody excludes. Anything else, more, or nothing: null.
 */
export function parseCoreFolderOutput(output: string, ref: CoreFolderRef): CoreFolderResult | null {
  if (output.includes("�") || byteLength(output) > 4_096 + 16 || !output.endsWith("\n")) return null;
  const line = output.slice(0, -1);
  if (line.includes("\n") || line.includes("\r")) return null;
  const tab = line.indexOf("\t");
  const generation = tab < 0 ? line : line.slice(0, tab);
  if (!isCoreGeneration(generation)) return null;
  if (tab < 0) return { generation, path: null };
  const path = line.slice(tab + 1);
  const id = isUsablePath(path) ? transcriptSessionID(path, ref.format)?.toLowerCase() : undefined;
  if (id === undefined || ref.excluding.includes(id)) return null;
  const parts = path.split("/");
  const at = (back: number): string => parts[parts.length - back] ?? "";
  if (ref.format === "claude") {
    const config = at(4) === ".claude" || (parts.length >= 6 && at(5) === ".claude-seats" && at(4) !== "" && !at(4).startsWith("."));
    if (parts.length < 5 || at(3) !== "projects" || !isClaudeProjectFolder(at(2), ref.folder) || !config) return null;
  } else {
    const digits = (part: string, count: number): boolean => part.length === count && /^[0-9]+$/.test(part);
    if (parts.length < 7 || at(6) !== ".codex" || at(5) !== "sessions" || !digits(at(4), 4) || !digits(at(3), 2) || !digits(at(2), 2)) return null;
  }
  return { generation, path };
}

/** The agent process's start alone, as the lookup reads it, for a found session held without a lookup. */
export function coreGenerationCommand(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0 || pid > 0x7fffffff) return null;
  return "/usr/bin/perl -e " + shellQuote(coreGenerationScript) + " -- " + shellQuote(String(pid));
}

/** Its answer, read strictly: one generation and its newline; null for anything else, or nothing (the process is gone). */
export function parseCoreGenerationOutput(output: string): string | null {
  if (byteLength(output) !== 15 || !output.endsWith("\n")) return null;
  const generation = output.slice(0, -1);
  return isCoreGeneration(generation) ? generation : null;
}

// The scripts, as TranscriptLocator.swift has them (core-folder-lookup.test.ts checks they are the same text).

/**
 * The agent process's start (`$pid`): `ps -o lstart=` read in the zone `ps` printed it in and turned into epoch
 * seconds here, the later of two readings across a DST fold, so the generation (`$gen`, 14 digits) is the same
 * whatever the Mac's time zone. Nothing at all when the process is gone.
 */
export const coreStartPerl = String.raw`$ENV{LC_ALL} = 'C';
open(my $ps, '-|', '/bin/ps', '-o', 'lstart=', '-p', $pid) or exit 0;
my $lstart = do { local $/; <$ps> }; close $ps;
my %mon = (Jan => 0, Feb => 1, Mar => 2, Apr => 3, May => 4, Jun => 5, Jul => 6, Aug => 7, Sep => 8, Oct => 9, Nov => 10, Dec => 11);
exit 0 unless defined $lstart && $lstart =~ /\A\s*[A-Z][a-z]{2}\s+([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})\s*\z/ && exists $mon{$1};
my ($mo, $d, $h, $mi, $s, $y) = ($mon{$1}, $2, $3, $4, $5, $6);
my $start;
for my $dst (0, 1) {
  my $t = POSIX::mktime($s, $mi, $h, $d, $mo, $y - 1900, 0, 0, $dst);
  next unless defined $t;
  my @l = localtime $t;
  next unless $l[0] == $s && $l[1] == $mi && $l[2] == $h && $l[3] == $d && $l[4] == $mo && $l[5] == $y - 1900;
  $start = $t if !defined $start || $t > $start;
}
exit 0 unless defined $start && $start > 0 && $start < 1e14;
my $gen = sprintf('%014d', $start);
`;

/** The process-start check (`coreGenerationCommand`, the pid after `--`). */
export const coreGenerationScript =
  String.raw`use strict; use warnings; use POSIX ();
open(STDERR, '>', '/dev/null'); $SIG{ALRM} = sub { exit 0 }; alarm 8;
my ($pid) = @ARGV;
exit 0 unless defined $pid && $pid =~ /\A[1-9][0-9]{0,9}\z/ && @ARGV == 1;
` +
  coreStartPerl +
  String.raw`print "$gen\n";
exit 0;`;

/** The lookup run on the Mac (`coreFolderCommand`, args after `--`). */
export const coreFolderScript =
  String.raw`use strict; use warnings;
use POSIX (); use Time::HiRes (); use JSON::PP ();
open(STDERR, '>', '/dev/null'); $SIG{ALRM} = sub { exit 0 }; alarm 8;
my ($kind, $pid, $folder, $project, $long, @items) = @ARGV;
exit 0 unless defined $long && ($kind eq 'claude' || $kind eq 'codex') && $pid =~ /\A[1-9][0-9]{0,9}\z/ && $long =~ /\A[01]\z/;
my $uuid = qr/[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}/;
` +
  coreStartPerl +
  String.raw`my $cutoff = $start + 1;
my (%skip, %maybe, %keep);
for my $item (@items) {
  if ($item =~ /\Ax:($uuid)\z/) { $skip{lc $1} = 1 }
  elsif ($item =~ /\Ag:(\d{14}):($uuid)\z/) { if ($1 eq $gen) { $keep{lc $2} = 1 } else { $maybe{lc $2} = 1 } }
  else { exit 0 }
}
$skip{$_} = 1 for grep { !$keep{$_} } keys %maybe;
my $home = $ENV{HOME};
exit 0 unless defined $home && $home =~ m{\A/};
my @found;
sub consider {
  my ($path, $id) = @_;
  return if $skip{lc $id};
  my @st = Time::HiRes::lstat($path);
  return unless @st && -f _ && $st[9] >= $cutoff;
  push @found, [$st[9], $path, lc $id];
}
sub names { my ($dir, $re) = @_; opendir(my $dh, $dir) or return (); my @n = grep { $_ =~ $re } readdir $dh; closedir $dh; return sort @n; }
if ($kind eq 'claude') {
  my @configs = ("$home/.claude");
  push @configs, map { "$home/.claude-seats/$_" } names("$home/.claude-seats", qr/\A[^.]/);
  for my $config (@configs) {
    my $projects = "$config/projects";
    my @dirs = $long ? names($projects, qr/\A\Q$project\E[0-9A-Za-z]+\z/) : names($projects, qr/\A\Q$project\E\z/);
    for my $dir (@dirs) { for my $file (names("$projects/$dir", qr/\A$uuid\.jsonl\z/)) { consider("$projects/$dir/$file", substr($file, 0, 36)) } }
  }
} else {
  my $base = "$home/.codex/sessions";
  for my $yy (names($base, qr/\A\d{4}\z/)) { for my $mm (names("$base/$yy", qr/\A\d{2}\z/)) { for my $dd (names("$base/$yy/$mm", qr/\A\d{2}\z/)) {
    for my $file (names("$base/$yy/$mm/$dd", qr/\Arollout-.+-$uuid\.jsonl\z/)) { consider("$base/$yy/$mm/$dd/$file", substr($file, -42, 36)) }
  } } }
}
@found = sort { $b->[0] <=> $a->[0] || $a->[1] cmp $b->[1] } @found;
my $json = JSON::PP->new->utf8;
sub field { my ($v) = @_; return (defined $v && !ref $v) ? $v : undef }
sub same_folder { my ($cwd) = @_; return 0 unless defined $cwd; utf8::encode($cwd); $cwd =~ s{(?<=.)/+\z}{}; return $cwd eq $folder }
sub claude_owner {
  my ($buf, $id) = @_;
  my @lines = split /\n/, $buf, -1; pop @lines;
  my $n = 0;
  for my $line (@lines) {
    last if ++$n > 64;
    next if $line eq '' || length($line) > 262144;
    my $r = eval { $json->decode($line) };
    return 0 unless ref $r eq 'HASH';
    my $type = field($r->{type});
    next unless defined $type && ($type eq 'user' || $type eq 'assistant' || $type eq 'system');
    my $sid = field($r->{sessionId});
    return 0 if $r->{isSidechain} || !defined $sid || lc $sid ne $id;
    return same_folder(field($r->{cwd}));
  }
  return 0;
}
sub codex_owner {
  my ($buf, $id) = @_;
  my $nl = index($buf, "\n");
  return 0 if $nl < 0;
  my $r = eval { $json->decode(substr($buf, 0, $nl)) };
  return 0 unless ref $r eq 'HASH' && (field($r->{type}) // '') eq 'session_meta' && ref $r->{payload} eq 'HASH';
  my $p = $r->{payload};
  my ($sid, $source) = (field($p->{id}), field($p->{source}));
  return 0 unless defined $sid && lc $sid eq $id && defined $source && $source eq 'cli';
  return same_folder(field($p->{cwd}));
}
my $n = 0;
for my $c (@found) {
  last if ++$n > 32;
  my (undef, $path, $id) = @$c;
  open(my $fh, '<:raw', $path) or next;
  my $buf = '';
  my $got = read($fh, $buf, $kind eq 'claude' ? 4194304 : 1048576);
  close $fh;
  next unless $got;
  if ($kind eq 'claude' ? claude_owner($buf, $id) : codex_owner($buf, $id)) { print "$gen\t$path\n"; exit 0 }
}
print "$gen\n";
exit 0;`;

// What the composer takes in:
// picked files, a paste and a drop become payloads by one rule: at most ten
// at a time, images re-encoded (image-prepare.ts, 30 MB before), the other
// kinds that upload as they are (12 MB), what the composer already keeps
// counted against 64 MB; refusals are named, and the note says so. A paste of files asks the main process first for files
// copied in the Finder (Chromium pastes only their icon).

import {
  attachmentText,
  excessText,
  extensionOf,
  maxImageSourceBytes,
  maxItemsPerDrop,
  maxUploadBytes,
  refusedText,
  residentText,
  uploadKind,
} from "../../shared/attachments";
import type { ClipboardFiles, HerdrDesktopBridge } from "../../shared/ipc-contract";
import { composerDrafts, type AttachmentPayload, type ComposerDrafts } from "./composer-drafts";
import { prepareImage, type PreparedImage, type SourceFile } from "./image-prepare";

export type ImagePreparer = (file: SourceFile) => Promise<PreparedImage>;

export interface IntakeResult {
  readonly payloads: AttachmentPayload[];
  readonly note: string | null;
}

/** A DOM File (or anything with its shape) as a source file. */
export interface FileLike {
  readonly name: string;
  readonly type: string;
  readonly size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export function sourceOf(file: FileLike, name: string = file.name): SourceFile {
  return { name, type: file.type, size: file.size, bytes: async () => new Uint8Array(await file.arrayBuffer()) };
}

const stem = (name: string): string => {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
};

/** The payloads `files` make and what to say about the rest; `resident` is what the composer may still keep. */
export async function intakeFiles(files: readonly SourceFile[], prepare: ImagePreparer, resident: number): Promise<IntakeResult> {
  const payloads: AttachmentPayload[] = [];
  const refused: string[] = [];
  const excess: string[] = [];
  const kept: string[] = [];
  const failures: string[] = [];
  let left = resident;
  for (const [index, file] of files.entries()) {
    if (index >= maxItemsPerDrop) {
      excess.push(file.name);
      continue;
    }
    const kind = uploadKind(file.name, file.type);
    if (kind.kind === "unsupported") {
      refused.push(file.name);
      continue;
    }
    if (kind.kind === "image" ? file.size > maxImageSourceBytes : file.size > maxUploadBytes) {
      failures.push(`${file.name}: ${kind.kind === "image" ? attachmentText.sourceTooLarge : attachmentText.tooLarge}`);
      continue;
    }
    try {
      let payload: AttachmentPayload;
      if (kind.kind === "image") {
        const prepared = await prepare(file);
        payload = { name: `${stem(file.name)}.${prepared.extension}`, extension: prepared.extension, image: true, data: prepared.data };
      } else {
        payload = { name: file.name, extension: kind.extension, image: false, data: await file.bytes() };
      }
      if (payload.data.byteLength > left) {
        kept.push(payload.name);
        continue;
      }
      left -= payload.data.byteLength;
      payloads.push(payload);
    } catch (error) {
      failures.push(`${file.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const lines: string[] = [];
  if (refused.length > 0) lines.push(refusedText(refused));
  if (excess.length > 0) lines.push(excessText(excess));
  if (kept.length > 0) lines.push(residentText(kept));
  return { payloads, note: lines.length > 0 ? lines.join(" ") : (failures.at(-1) ?? null) };
}

/** Reads `files` and attaches what they make to the pane's draft; its note goes under the box. */
export async function attachSources(
  key: string,
  files: readonly SourceFile[],
  drafts: ComposerDrafts = composerDrafts,
  prepare: ImagePreparer = prepareImage,
  extraNote: string | null = null,
): Promise<void> {
  if (files.length === 0 && extraNote === null) return;
  const result = await intakeFiles(files, prepare, drafts.residentAllowance(key));
  drafts.attach(key, result.payloads);
  const note = [extraNote, result.note].filter((line): line is string => line !== null).join(" ");
  if (note !== "") drafts.note(key, note);
}

/** Dropped or picked DOM files, by their own names. */
export function attachFiles(key: string, files: readonly FileLike[], drafts: ComposerDrafts = composerDrafts): Promise<void> {
  return attachSources(key, files.map((file) => sourceOf(file)), drafts);
}

/** The clipboard or drop names files (a paste of files, or a Finder copy). */
export function carriesFiles(data: { readonly types: readonly string[] | ArrayLike<string> } | null | undefined): boolean {
  if (data === null || data === undefined) return false;
  return Array.from(data.types).includes("Files");
}

/**
 * Whether a paste into the box is files (an image, a browser's Copy Image, a
 * Finder copy) rather than text: it carries files, and no text, or only a
 * short single line with no rich text beside it (a Finder copy's file name).
 * A rich text copy that also carries a picture of itself pastes as text.
 */
export function pasteTakesFiles(data: { readonly types: readonly string[] | ArrayLike<string>; getData(type: string): string } | null | undefined): boolean {
  if (!carriesFiles(data)) return false;
  const types = Array.from(data!.types);
  const text = types.includes("text/plain") ? data!.getData("text/plain") : "";
  if (text.trim() === "") return true;
  if (types.includes("text/html") || types.includes("text/rtf")) return false;
  return !text.includes("\n") && text.length <= 255;
}

/** What the main process read of the Finder's copy, as a note (refused, past ten, unreadable). */
function clipboardNote(read: ClipboardFiles): string | null {
  const lines: string[] = [];
  if (read.refused.length > 0) lines.push(refusedText(read.refused));
  if (read.excess.length > 0) lines.push(excessText(read.excess));
  if (lines.length === 0 && read.failures.length > 0) lines.push(read.failures.at(-1)!);
  return lines.length > 0 ? lines.join(" ") : null;
}

/** Whether main's read of the clipboard says anything (files, or a name it left): then it is the answer, not the pasted icon. */
export function clipboardAnswers(read: ClipboardFiles | null): read is ClipboardFiles {
  return read !== null && (read.files.length > 0 || read.refused.length > 0 || read.failures.length > 0 || read.excess.length > 0);
}

/** Every name main's read left, and why: refused kinds, past ten, and each that could not be read. */
export function clipboardLeftNote(read: ClipboardFiles): string | null {
  const lines: string[] = [];
  if (read.refused.length > 0) lines.push(refusedText(read.refused));
  if (read.excess.length > 0) lines.push(excessText(read.excess));
  for (const failure of read.failures) lines.push(`Not attached: ${failure}`);
  return lines.length > 0 ? lines.join(" ") : null;
}

/**
 * A paste that carries files: the Finder's copied files when the main
 * process finds any, else the pasted images themselves ("Pasted image").
 */
export async function attachPasted(
  key: string,
  domFiles: readonly FileLike[],
  bridge: Pick<HerdrDesktopBridge, "clipboardFiles"> | undefined,
  drafts: ComposerDrafts = composerDrafts,
): Promise<void> {
  let copied: ClipboardFiles | null = null;
  try {
    copied = bridge?.clipboardFiles === undefined ? null : await bridge.clipboardFiles();
  } catch {
    copied = null;
  }
  if (clipboardAnswers(copied)) {
    const sources = copied.files.map(
      (file): SourceFile => ({ name: file.name, type: file.type, size: file.data.byteLength, bytes: async () => file.data }),
    );
    await attachSources(key, sources, drafts, prepareImage, clipboardNote(copied));
    return;
  }
  const sources = domFiles.map((file) => {
    const pastedImage = uploadKind(file.name, file.type).kind === "image";
    const extension = extensionOf(file.name);
    return sourceOf(file, pastedImage ? `Pasted image${extension === "" ? "" : `.${extension}`}` : file.name);
  });
  await attachSources(key, sources, drafts);
}

/** Dragged files over the Chat or the box: a drop attaches them (and never opens them in the window). */
export function dragOverFiles(event: { dataTransfer: { types: readonly string[] | ArrayLike<string>; dropEffect?: string } | null; preventDefault(): void }): void {
  if (!carriesFiles(event.dataTransfer)) return;
  event.preventDefault();
  if (event.dataTransfer !== null) event.dataTransfer.dropEffect = "copy";
}

/** A drop of files on the Chat or the box: they become chips in the pane's draft. */
export function dropFiles(
  key: string,
  event: { dataTransfer: { types: readonly string[] | ArrayLike<string>; files: ArrayLike<FileLike> } | null; preventDefault(): void; stopPropagation?(): void },
): void {
  if (!carriesFiles(event.dataTransfer)) return;
  event.preventDefault();
  event.stopPropagation?.();
  void attachFiles(key, Array.from(event.dataTransfer!.files));
}

// The app's uploads to a machine, by the Swift app's rules (HerdrKit
// CitadelTransport.swift RemoteAttachment and UploadSweep.swift, App
// CompanionComposerView.swift CompanionAttachmentKinds and `joined`):
//
// - what may upload: images (re-encoded to PNG or JPEG first, at most 12 MB
//   after, 30 MB before) and PDF, text, logs, Markdown, JSON, CSV and zip
//   files (at most 12 MB); nothing else;
// - where: `<home>/.adari-attachments-<32 lowercase hex>/attachment-<lowercase uuid>.<ext>`
//   (uploads from before the app's rename, under
//   `.herdr-companion-attachments-<32 lowercase hex>`, are still shown and swept),
//   a new private (0700) folder per upload, the file 0600, the home the SSH
//   account's canonical one;
// - what the message carries: the typed text, then each upload's path,
//   separated by single spaces (CompanionComposerSession.joined), so Claude,
//   Codex and Grok read them as they do from the iPhone and iPad, and the
//   transcript's parser (ChatAttachmentText) takes them back out.

/** The largest upload, in bytes (RemoteAttachment.maximumByteCount). */
export const maxUploadBytes = 12 * 1_024 * 1_024;
/** The largest image read before it is re-encoded (CompanionImageNormalizer.maximumSourceBytes). */
export const maxImageSourceBytes = 30 * 1_024 * 1_024;
/** One drop or paste takes at most this many items (CompanionAttachmentIntake.maximumItemsPerDrop). */
export const maxItemsPerDrop = 10;
/** What one composer keeps to upload or retry, in all (CompanionAttachmentIntake.maximumResidentBytes). */
export const maxResidentBytes = 64 * 1_024 * 1_024;

export const uploadFolderPrefix = ".adari-attachments-";
/** The folder name before the app's rename; recognised (shown, swept), never written. */
export const legacyUploadFolderPrefix = ".herdr-companion-attachments-";
/** Every upload folder name this app owns, the new one first. */
export const uploadFolderPrefixes: readonly string[] = [uploadFolderPrefix, legacyUploadFolderPrefix];
export const uploadFilePrefix = "attachment-";

/** The kinds an upload may have, as the uploader names them (RemoteAttachment.safeExtension); null for any other. */
export function safeUploadExtension(value: string): string | null {
  switch (value.toLowerCase()) {
    case "png":
      return "png";
    case "jpg":
    case "jpeg":
      return "jpg";
    case "pdf":
      return "pdf";
    case "txt":
    case "text":
      return "txt";
    case "log":
      return "log";
    case "md":
    case "markdown":
      return "md";
    case "json":
      return "json";
    case "csv":
      return "csv";
    case "zip":
      return "zip";
    default:
      return null;
  }
}

/** Image files the composer reads and re-encodes (what Chromium decodes). */
const imageExtensions = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "heic", "heif", "tif", "tiff", "avif"]);

/** A file's extension, lower case, or "" (its name's last dot). */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 || dot === name.length - 1 ? "" : name.slice(dot + 1).toLowerCase();
}

export type UploadKind =
  /** An image: re-encoded to PNG or JPEG before it uploads. */
  | { readonly kind: "image" }
  /** A listed file kind: goes as it is, with this extension. */
  | { readonly kind: "file"; readonly extension: string }
  | { readonly kind: "unsupported" };

/**
 * What a picked, pasted or dropped file is (CompanionAttachmentKinds and the
 * picker's image check): by its type when it says image, else by its name.
 */
export function uploadKind(name: string, mimeType: string): UploadKind {
  const extension = extensionOf(name);
  if (mimeType.startsWith("image/") || imageExtensions.has(extension)) return { kind: "image" };
  switch (extension) {
    case "markdown":
      return { kind: "file", extension: "md" };
    case "text":
      return { kind: "file", extension: "txt" };
    case "pdf":
    case "txt":
    case "log":
    case "md":
    case "json":
    case "csv":
    case "zip":
      return { kind: "file", extension };
    default:
      return { kind: "unsupported" };
  }
}

/** The file picker's kinds (the + button's `accept`). */
export const pickerAccept = "image/*,.pdf,.txt,.text,.log,.md,.markdown,.json,.csv,.zip";

/** The Swift app's words for each refusal. */
export const attachmentText = {
  unsupported: "Only images, PDF, text, logs, Markdown, JSON, CSV and zip files upload.",
  tooLarge: `The image is too large to upload. Choose one under ${maxUploadBytes / 1_024 / 1_024} MB.`,
  sourceTooLarge: "That image is over 30 MB. Choose a smaller photo or screenshot.",
  sourceDimensionsTooLarge: "That image has too many pixels to open safely. Choose a smaller photo or screenshot.",
  unreadable: "That file is not a readable image.",
  outputTooLarge: "The image is still over 12 MB after conversion. Crop it or choose a smaller image.",
  unsafeRemoteHome: "The Mac returned an unsafe home-directory path.",
  privateDirectoryUnavailable: "Adari could not create its private attachment directory on the Mac.",
  privateDirectoryPermissions: "The attachment directory on the Mac is not private (0700).",
  uploadedFileInvalid: "The uploaded image could not be verified on the Mac.",
  unsupportedFormat: "The selected image could not be converted to PNG or JPEG.",
  disconnected: "Not attached: not connected to the Mac.",
} as const;

export function refusedText(names: readonly string[]): string {
  return `Not attached: ${names.join(", ")}. ${attachmentText.unsupported}`;
}

export function excessText(names: readonly string[]): string {
  return (
    `Not attached: ${names.join(", ")}. One drop takes up to ${maxItemsPerDrop} items and ` +
    `${maxResidentBytes / 1_048_576} MB in all; drop the rest again once these have uploaded.`
  );
}

export function residentText(names: readonly string[]): string {
  return (
    `Not attached: ${names.join(", ")}. Files waiting to upload or to retry take up to ` +
    `${maxResidentBytes / 1_048_576} MB in all; attach these again once those have uploaded, or remove one that failed.`
  );
}

/**
 * What Send carries: the typed text, then each upload's path, separated by
 * single spaces (CompanionComposerSession.joined): no separator after a text
 * that ends in a space or a new line.
 */
export function joinedMessage(text: string, paths: readonly string[]): string {
  if (paths.length === 0) return text;
  const tail = paths.join(" ");
  if (text === "") return tail;
  const separator = text.endsWith(" ") || text.endsWith("\n") ? "" : " ";
  return text + separator + tail;
}

const isLowerHex = (value: string): boolean => /^[0-9a-f]+$/.test(value);
const lowerUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A plain absolute path: no control characters, no `..` component (RemoteAttachmentUploadOperation.isSafeAbsolutePath). */
export function isSafeAbsolutePath(path: string): boolean {
  if (!path.startsWith("/")) return false;
  for (let i = 0; i < path.length; i += 1) {
    const unit = path.charCodeAt(i);
    if (unit < 0x20 || unit === 0x7f) return false;
  }
  return !path.includes("/../") && !path.endsWith("/..");
}

/** `.adari-attachments-` (or the old `.herdr-companion-attachments-`) and exactly 32 of `[0-9a-f]`. */
export function isUploadFolderName(name: string): boolean {
  const prefix = uploadFolderPrefixes.find((candidate) => name.startsWith(candidate));
  if (prefix === undefined) return false;
  const nonce = name.slice(prefix.length);
  return nonce.length === 32 && isLowerHex(nonce);
}

/** `attachment-`, a lowercase uuid, `.` and an extension the uploader writes unchanged. */
export function isUploadFileName(name: string): boolean {
  if (!name.startsWith(uploadFilePrefix)) return false;
  const rest = name.slice(uploadFilePrefix.length);
  if (rest.length <= 37 || rest[36] !== ".") return false;
  if (!lowerUUID.test(rest.slice(0, 36))) return false;
  const extension = rest.slice(37);
  return safeUploadExtension(extension) === extension;
}

/** The single name under `home` in `path`, or null (UploadSweep childName, on UTF-16 units as given). */
function childName(path: string, home: string): string | null {
  if (!isSafeAbsolutePath(home)) return null;
  if (home !== "/" && home.slice(1).split("/").some((part) => part === "" || part === ".")) return null;
  const root = home === "/" ? "/" : `${home}/`;
  if (path.length <= root.length || !path.startsWith(root)) return null;
  const name = path.slice(root.length);
  return name.includes("/") ? null : name;
}

/** An upload folder: exactly `<home>/.adari-attachments-<32 [0-9a-f]>` (or the old prefix). */
export function isUploadFolder(path: string, home: string): boolean {
  const name = childName(path, home);
  return name !== null && isUploadFolderName(name);
}

/** Exactly one of this app's uploads in `home` (RemoteAttachment.isOwnedPath with the sweep's stricter names). */
export function isOwnedUploadPath(path: string, home: string): boolean {
  const slash = path.lastIndexOf("/");
  if (slash <= 0) return false;
  return isUploadFolder(path.slice(0, slash), home) && isUploadFileName(path.slice(slash + 1));
}

/** A random 32-hex folder nonce and a lowercase file uuid, as the uploader makes them. */
export interface UploadNames {
  readonly nonce: string;
  readonly uuid: string;
}

export function uploadNames(randomUUID: () => string): UploadNames {
  return { nonce: randomUUID().toLowerCase().replaceAll("-", ""), uuid: randomUUID().toLowerCase() };
}

/** The folder, the partial file and the final path of one upload. */
export function uploadLayout(home: string, names: UploadNames, extension: string): { folder: string; partial: string; final: string } {
  const folder = `${home === "/" ? "" : home}/${uploadFolderPrefix}${names.nonce}`;
  const base = `${uploadFilePrefix}${names.uuid}`;
  return { folder, partial: `${folder}/.${base}.uploading`, final: `${folder}/${base}.${extension}` };
}

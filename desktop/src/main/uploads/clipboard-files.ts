// Files copied in the Finder (or Explorer), for ⌘V into the composer or the
// terminal: Chromium's paste event carries only the file's icon then, so the
// page asks the main process, which reads the clipboard's file list and the
// files themselves, by the picker's kinds and limits (attachments.ts):
// at most ten, an image up to 30 MB before it is re-encoded, any other kind
// that uploads up to 12 MB. A file that does not fit is named, not read.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { maxImageSourceBytes, maxItemsPerDrop, maxUploadBytes, uploadKind } from "../../shared/attachments";
import type { ClipboardFiles } from "../../shared/ipc-contract";

/** The clipboard as the reader needs it: one format's text, or "" when it has none. */
export interface ClipboardSource {
  read(format: string): Promise<string>;
}

/** A raw platform format, as Electron's clipboard names it. */
export const osFormat = (format: string): string => `electron application/osclipboard;format="${format}"`;

/** Electron's clipboard (the async API of Electron 44) as a ClipboardSource. */
export function electronClipboardSource(clipboard: Electron.Clipboard): ClipboardSource {
  return {
    async read(format) {
      try {
        if (!(await clipboard.has(format))) return "";
        for (const item of await clipboard.read()) {
          try {
            const value = await item.getType(format);
            if (value instanceof Blob) return await value.text();
          } catch {
            // not in this item
          }
        }
      } catch {
        // the clipboard could not be read
      }
      return "";
    },
  };
}

function fileURLPaths(text: string): string[] {
  const paths: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const url = line.trim();
    if (!url.startsWith("file://")) continue;
    try {
      paths.push(fileURLToPath(url));
    } catch {
      // not a local file
    }
  }
  return paths;
}

/**
 * The paths the clipboard names: the file URL list (text/uri-list), else
 * macOS's file list (a plist of paths), else its one file URL.
 */
export async function clipboardPaths(source: ClipboardSource): Promise<string[]> {
  let paths = fileURLPaths(await source.read("text/uri-list"));
  if (paths.length === 0) {
    const plist = await source.read(osFormat("NSFilenamesPboardType"));
    for (const match of plist.matchAll(/<string>([^<]*)<\/string>/g)) {
      const decoded = (match[1] ?? "")
        .replaceAll("&lt;", "<")
        .replaceAll("&gt;", ">")
        .replaceAll("&quot;", '"')
        .replaceAll("&apos;", "'")
        .replaceAll("&amp;", "&");
      if (decoded.startsWith("/")) paths.push(decoded);
    }
  }
  if (paths.length === 0) paths = fileURLPaths(await source.read(osFormat("public.file-url")));
  return [...new Set(paths)];
}

/** The copied files, read, and the names of those that could not be. */
export async function readClipboardFiles(source: ClipboardSource, files: Pick<typeof fs, "statSync" | "readFileSync"> = fs): Promise<ClipboardFiles> {
  const result: { files: { name: string; type: string; data: Uint8Array }[]; refused: string[]; excess: string[]; failures: string[] } = {
    files: [],
    refused: [],
    excess: [],
    failures: [],
  };
  const paths = await clipboardPaths(source);
  for (const [index, filePath] of paths.entries()) {
    const name = path.basename(filePath);
    if (index >= maxItemsPerDrop) {
      result.excess.push(name);
      continue;
    }
    const kind = uploadKind(name, "");
    if (kind.kind === "unsupported") {
      result.refused.push(name);
      continue;
    }
    try {
      const stat = files.statSync(filePath);
      if (!stat.isFile()) {
        result.refused.push(name);
        continue;
      }
      if (stat.size > (kind.kind === "image" ? maxImageSourceBytes : maxUploadBytes)) {
        result.failures.push(`${name}: ${kind.kind === "image" ? "That image is over 30 MB. Choose a smaller photo or screenshot." : "The file is too large to upload. Choose one under 12 MB."}`);
        continue;
      }
      const data = files.readFileSync(filePath);
      result.files.push({ name, type: "", data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) });
    } catch (error) {
      result.failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return result;
}

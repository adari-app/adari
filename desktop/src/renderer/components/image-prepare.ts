// An image as it uploads: read
// (at most 30 MB, 16,384 pixels a side, 64 megapixels), drawn at most 4,096
// pixels on its longest side, encoded as PNG (a PNG, or a kind that may have
// transparency) or JPEG at 0.86 (a photo), and drawn 20% smaller each time,
// up to nine times, until it is under 12 MB. In the page, with Chromium's
// decoder and an OffscreenCanvas; the size loop is `encodeWithin`.
//
// So an attached photo uploads quickly,
// a photo (a JPEG or HEIC source: the JPEG path) is drawn at most 2,048
// pixels on its longest side; a PNG, a screenshot, a kind that may have
// transparency or an unknown kind keeps 4,096.

import { attachmentText, extensionOf, maxImageSourceBytes, maxUploadBytes } from "../../shared/attachments";

export const maxSourceDimension = 16_384;
export const maxSourcePixels = 64 * 1_024 * 1_024;
export const maxDimension = 4_096;
/** A photo's longest side (the JPEG path). */
export const maxPhotoDimension = 2_048;

export interface PreparedImage {
  readonly data: Uint8Array;
  readonly extension: "png" | "jpg";
}

/** A file to read, as the page has it (a picked, pasted or dropped File, or one the main process read). */
export interface SourceFile {
  readonly name: string;
  readonly type: string;
  readonly size: number;
  bytes(): Promise<Uint8Array>;
}

/** PNG for a PNG and for kinds that may be transparent; JPEG for photos (JPEG, HEIC). */
export function prefersPNG(name: string, type: string): boolean {
  const extension = extensionOf(name);
  const photo = type === "image/jpeg" || type === "image/heic" || type === "image/heif" || ["jpg", "jpeg", "heic", "heif"].includes(extension);
  return !photo;
}

/** The first size, at most `longest` (4,096) on its longest side, then 80% each time until `encode` gives under 12 MB. */
export async function encodeWithin(
  width: number,
  height: number,
  encode: (width: number, height: number) => Promise<Uint8Array>,
  longest: number = maxDimension,
): Promise<Uint8Array> {
  if (!(width > 0 && height > 0) || !Number.isFinite(width) || !Number.isFinite(height)) throw new Error(attachmentText.unreadable);
  if (width > maxSourceDimension || height > maxSourceDimension || width * height > maxSourcePixels) {
    throw new Error(attachmentText.sourceDimensionsTooLarge);
  }
  const scale = Math.min(1, longest / Math.max(1, width, height));
  let w = Math.max(1, Math.floor(width * scale));
  let h = Math.max(1, Math.floor(height * scale));
  for (let attempt = 0; attempt < 9; attempt += 1) {
    const encoded = await encode(w, h);
    if (encoded.byteLength <= maxUploadBytes) return encoded;
    w = Math.max(1, Math.floor(w * 0.8));
    h = Math.max(1, Math.floor(h * 0.8));
  }
  throw new Error(attachmentText.outputTooLarge);
}

export async function prepareImage(file: SourceFile): Promise<PreparedImage> {
  if (file.size > maxImageSourceBytes) throw new Error(attachmentText.sourceTooLarge);
  const bytes = await file.bytes();
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: file.type || "application/octet-stream" }));
  } catch {
    throw new Error(attachmentText.unreadable);
  }
  const png = prefersPNG(file.name, file.type);
  try {
    const data = await encodeWithin(bitmap.width, bitmap.height, async (width, height) => {
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext("2d");
      if (context === null) throw new Error(attachmentText.unreadable);
      if (!png) {
        context.fillStyle = "#fff";
        context.fillRect(0, 0, width, height);
      }
      context.drawImage(bitmap, 0, 0, width, height);
      const blob = await canvas.convertToBlob(png ? { type: "image/png" } : { type: "image/jpeg", quality: 0.86 });
      return new Uint8Array(await blob.arrayBuffer());
    }, png ? maxDimension : maxPhotoDimension);
    return { data, extension: png ? "png" : "jpg" };
  } finally {
    bitmap.close();
  }
}

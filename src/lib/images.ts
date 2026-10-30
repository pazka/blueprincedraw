/**
 * Image helpers. Everything here is safe to run on a worker thread: no DOM,
 * only OffscreenCanvas / createImageBitmap / FileReader.
 */

export const DEFAULT_QUALITY = 0.9;
export const DEFAULT_MAX_DIMENSION = 2560;

/** Formats that gain nothing from, or are damaged by, a raster re-encode. */
const NO_TRANSCODE = new Set(["image/svg+xml", "image/webp", "image/gif", "image/avif"]);

export type TranscodeResult = {
  bytes: Uint8Array;
  mimeType: string;
  width: number;
  height: number;
  transcoded: boolean;
};

export function dataUrlMime(dataURL: string): string {
  const match = /^data:([^;,]+)/.exec(dataURL);
  return match ? match[1] : "image/png";
}

/** Decodes a data URL to raw bytes without building a giant intermediate string. */
export async function dataUrlToBytes(dataURL: string): Promise<Uint8Array> {
  const res = await fetch(dataURL);
  return new Uint8Array(await res.arrayBuffer());
}

export function bytesToDataUrl(bytes: Uint8Array, mimeType: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(new Blob([bytes as BlobPart], { type: mimeType }));
  });
}

/**
 * Re-encodes an image to WebP, optionally shrinking it to fit `maxDimension`.
 * Falls back to the original bytes whenever the re-encode fails or comes out
 * bigger, so this can never make a project worse.
 */
export async function toWebp(
  bytes: Uint8Array,
  mimeType: string,
  quality = DEFAULT_QUALITY,
  maxDimension = DEFAULT_MAX_DIMENSION,
): Promise<TranscodeResult> {
  const original: TranscodeResult = {
    bytes,
    mimeType,
    width: 0,
    height: 0,
    transcoded: false,
  };
  if (NO_TRANSCODE.has(mimeType)) return original;
  if (typeof OffscreenCanvas === "undefined" || typeof createImageBitmap === "undefined") {
    return original;
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: mimeType }));
  } catch {
    return original;
  }

  try {
    const scale =
      maxDimension > 0 ? Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height)) : 1;
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (!ctx) return original;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, width, height);

    const blob = await canvas.convertToBlob({ type: "image/webp", quality });
    if (blob.type !== "image/webp") return original; // encoder refused WebP
    const out = new Uint8Array(await blob.arrayBuffer());
    if (out.byteLength >= bytes.byteLength) return original;

    return { bytes: out, mimeType: "image/webp", width, height, transcoded: true };
  } catch {
    return original;
  } finally {
    bitmap.close();
  }
}

export const formatBytes = (n: number): string => {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
};

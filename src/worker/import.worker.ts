/// <reference lib="webworker" />
/**
 * Imports a classic single-file `.excalidraw` of any size.
 *
 * Runs off the main thread so the editor stays responsive, streams the file so
 * it is never held in memory as one string, and writes each image straight to
 * the project store as binary, optionally re-encoded to WebP on the way in.
 */

import { streamExcalidrawScene } from "../lib/jsonStream.ts";
import { dataUrlMime, dataUrlToBytes, toWebp } from "../lib/images.ts";
import { extForMime, storeFromRef } from "../lib/store.ts";
import type { FileIndex, ImportOptions, ImportProgress, SceneDoc, StoreRef } from "../types.ts";

export type ImportRequest = {
  blob: Blob;
  ref: StoreRef;
  options: ImportOptions;
};

export type ImportResponse =
  | { ok: true; progress: ImportProgress }
  | { ok: false; message: string };

const post = (msg: { type: "progress" | "done" | "error" } & Record<string, unknown>) =>
  (self as unknown as Worker).postMessage(msg);

self.onmessage = async (event: MessageEvent<ImportRequest>) => {
  const { blob, ref, options } = event.data;
  const store = storeFromRef(ref);

  const progress: ImportProgress = {
    phase: "reading",
    bytesRead: 0,
    bytesTotal: blob.size,
    filesDone: 0,
    elements: 0,
    storedBytes: 0,
    originalBytes: 0,
  };

  let lastPost = 0;
  const report = (force = false) => {
    const now = Date.now();
    if (force || now - lastPost > 150) {
      lastPost = now;
      post({ type: "progress", progress: { ...progress } });
    }
  };

  try {
    let elements: any[] = [];
    let appState: Record<string, any> = {};
    const index: FileIndex = {};

    await streamExcalidrawScene(blob, {
      onProgress: (read) => {
        progress.bytesRead = read;
        report();
      },
      onElements: (els) => {
        elements = els;
        progress.elements = els.length;
        progress.phase = "images";
        report(true);
      },
      onAppState: (state) => {
        appState = state ?? {};
      },
      onFile: async (id, entry) => {
        const dataURL: string = entry?.dataURL ?? "";
        if (!dataURL.startsWith("data:")) return;

        const sourceMime = entry?.mimeType || dataUrlMime(dataURL);
        const raw = await dataUrlToBytes(dataURL);
        progress.originalBytes += raw.byteLength;

        const result = options.transcode
          ? await toWebp(raw, sourceMime, options.quality, options.maxDimension)
          : { bytes: raw, mimeType: sourceMime, transcoded: false };

        const ext = extForMime(result.mimeType);
        const created = entry?.created ?? Date.now();
        const originalBytes = result.transcoded ? raw.byteLength : undefined;
        await store.writeFile(id, ext, result.bytes, result.mimeType, { created, originalBytes });

        index[id] = {
          id,
          mimeType: result.mimeType,
          ext,
          bytes: result.bytes.byteLength,
          created,
          lastRetrieved: entry?.lastRetrieved ?? Date.now(),
          ...(originalBytes ? { originalBytes } : {}),
        };

        progress.filesDone += 1;
        progress.storedBytes += result.bytes.byteLength;
        report();
      },
    });

    // Drop the parts of appState that should not be restored from a foreign file.
    delete appState.collaborators;
    delete appState.selectedElementIds;

    const doc: SceneDoc = {
      type: "blueprincedraw-scene",
      version: 1,
      savedAt: Date.now(),
      elements,
      appState,
    };

    await store.backupScene();
    // Merge, never replace: images already stored stay reachable, so the
    // previous board (and its scene backups) keeps every picture it had.
    await store.writeIndex({ ...(await store.readIndex()), ...index });
    await store.writeScene(doc);

    progress.phase = "done";
    report(true);
    post({ type: "done", progress: { ...progress } });
  } catch (err) {
    progress.phase = "error";
    progress.message = err instanceof Error ? err.message : String(err);
    post({ type: "error", message: progress.message, progress: { ...progress } });
  }
};

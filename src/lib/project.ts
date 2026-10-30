/** Glue between a Store and the Excalidraw editor. */

import { bytesToDataUrl, dataUrlMime, dataUrlToBytes, toWebp } from "./images.ts";
import { extForMime, type Store } from "./store.ts";
import { referencedFileIds, type SceneSource } from "./sceneFile.ts";
import type { FileIndex, ImportOptions, SceneDoc } from "../types.ts";

export type EditorScene = {
  elements: any[];
  appState: Record<string, any>;
  files: Record<string, any>;
  index: FileIndex;
  savedAt: number | null;
};

/** Reads a project's scene and image index, but not the images themselves:
 *  the editor opens at once and `streamImages` fills them in afterwards. */
export async function loadProject(store: Store): Promise<EditorScene> {
  const [doc, index] = await Promise.all([store.readScene(), store.readIndex()]);
  return {
    elements: doc?.elements ?? [],
    appState: doc?.appState ?? {},
    files: {},
    index,
    savedAt: doc?.savedAt ?? null,
  };
}

/** Image ids ordered by how close their elements sit to the saved viewport, so
 *  what is on screen appears first; images no element uses come last. */
export function imageLoadOrder(
  elements: readonly any[],
  appState: Record<string, any>,
  index: FileIndex,
  viewport = { width: globalThis.innerWidth || 1600, height: globalThis.innerHeight || 900 },
): string[] {
  const zoom = appState.zoom?.value || 1;
  const cx = -(appState.scrollX ?? 0) + viewport.width / 2 / zoom;
  const cy = -(appState.scrollY ?? 0) + viewport.height / 2 / zoom;
  const distance = new Map<string, number>();
  for (const el of elements) {
    if (el.type !== "image" || !el.fileId || el.isDeleted || !index[el.fileId]) continue;
    const d = Math.hypot(el.x + (el.width ?? 0) / 2 - cx, el.y + (el.height ?? 0) / 2 - cy);
    distance.set(el.fileId, Math.min(d, distance.get(el.fileId) ?? Infinity));
  }
  const ids = Object.keys(index);
  return ids.sort((a, b) => (distance.get(a) ?? Infinity) - (distance.get(b) ?? Infinity));
}

/**
 * Loads images in parallel and hands them over in batches (for
 * `excalidrawAPI.addFiles`). Each image becomes its own data URL (many small
 * strings, never one big one), so this stays safe however large the project.
 */
export async function streamImages(
  store: Store,
  index: FileIndex,
  ids: string[],
  onBatch: (files: any[], done: number, total: number) => void,
  { concurrency = 4, batchMs = 250, signal }: {
    concurrency?: number;
    batchMs?: number;
    signal?: AbortSignal;
  } = {},
): Promise<{ loaded: number; failed: number }> {
  let next = 0;
  let done = 0;
  let failed = 0;
  let pending: any[] = [];
  let lastFlush = Date.now();
  const flush = () => {
    if (pending.length) onBatch(pending, done, ids.length);
    pending = [];
    lastFlush = Date.now();
  };

  const worker = async () => {
    while (next < ids.length && !signal?.aborted) {
      const id = ids[next++];
      const entry = index[id];
      try {
        const stored = await store.readFile(id, entry);
        if (stored) {
          // await BEFORE touching `pending`: `pending.push(await …)` would bind
          // the array first, and a flush during the await would swallow the image
          const dataURL = await bytesToDataUrl(stored.bytes, stored.mimeType);
          pending.push({
            id,
            mimeType: stored.mimeType,
            dataURL,
            created: entry.created,
            lastRetrieved: entry.lastRetrieved,
          });
        } else failed += 1;
      } catch {
        failed += 1;
      }
      done += 1;
      if (Date.now() - lastFlush >= batchMs) flush();
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, worker));
  if (!signal?.aborted) flush();
  return { loaded: done - failed, failed };
}

/**
 * Copies a whole project between stores (browser <-> folder), image by image,
 * then the scene. Used when a project moves into a newly picked folder.
 */
export async function copyProject(
  from: Store,
  to: Store,
  onProgress?: (done: number, total: number) => void,
): Promise<{ images: number }> {
  const [doc, index] = await Promise.all([from.readScene(), from.readIndex()]);
  const ids = Object.keys(index);
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < ids.length) {
      const id = ids[next++];
      const entry = index[id];
      const stored = await from.readFile(id, entry);
      if (stored) {
        await to.writeFile(id, entry.ext, stored.bytes, stored.mimeType, {
          created: entry.created,
          originalBytes: entry.originalBytes,
        });
      }
      onProgress?.(++done, ids.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, ids.length) }, worker));
  await to.writeIndex(index);
  if (doc) {
    await to.backupScene();
    await to.writeScene(doc);
  }
  return { images: ids.length };
}

/** App state keys worth persisting. Anything transient (selection, cursors,
 *  open dialogs) is deliberately left out so reopening is always clean. */
const PERSISTED_APP_STATE = [
  "viewBackgroundColor",
  "gridSize",
  "gridStep",
  "gridModeEnabled",
  "theme",
  "scrollX",
  "scrollY",
  "zoom",
  "currentItemStrokeColor",
  "currentItemBackgroundColor",
  "currentItemFillStyle",
  "currentItemStrokeWidth",
  "currentItemStrokeStyle",
  "currentItemRoughness",
  "currentItemOpacity",
  "currentItemFontFamily",
  "currentItemFontSize",
  "currentItemTextAlign",
  "currentItemRoundness",
  "currentItemArrowType",
  "currentItemEndArrowhead",
  "currentItemStartArrowhead",
  "objectsSnapModeEnabled",
  "name",
] as const;

export function pickAppState(appState: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const key of PERSISTED_APP_STATE) {
    if (appState[key] !== undefined) out[key] = appState[key];
  }
  return out;
}

export async function saveProject(
  store: Store,
  elements: any[],
  appState: Record<string, any>,
  { backup = false } = {},
): Promise<SceneDoc> {
  const doc: SceneDoc = {
    type: "blueprincedraw-scene",
    version: 1,
    savedAt: Date.now(),
    elements,
    appState: pickAppState(appState),
  };
  if (backup) await store.backupScene();
  await store.writeScene(doc);
  return doc;
}

/**
 * Persists images that appeared in the editor (paste, drag-drop, library) but
 * are not in the project index yet. Returns the new index if anything changed.
 */
export async function syncNewFiles(
  store: Store,
  index: FileIndex,
  editorFiles: Record<string, any>,
  options: ImportOptions,
): Promise<{ index: FileIndex; added: number } | null> {
  const missing = Object.keys(editorFiles || {}).filter((id) => !index[id]);
  if (missing.length === 0) return null;

  const next: FileIndex = { ...index };
  for (const id of missing) {
    const entry = editorFiles[id];
    const dataURL: string = entry?.dataURL ?? "";
    if (!dataURL.startsWith("data:")) continue;

    const sourceMime = entry?.mimeType || dataUrlMime(dataURL);
    const raw = await dataUrlToBytes(dataURL);
    const result = options.transcode
      ? await toWebp(raw, sourceMime, options.quality, options.maxDimension)
      : { bytes: raw, mimeType: sourceMime, transcoded: false };

    const ext = extForMime(result.mimeType);
    const created = entry?.created ?? Date.now();
    const originalBytes = result.transcoded ? raw.byteLength : undefined;
    await store.writeFile(id, ext, result.bytes, result.mimeType, { created, originalBytes });
    next[id] = {
      id,
      mimeType: result.mimeType,
      ext,
      bytes: result.bytes.byteLength,
      created,
      lastRetrieved: Date.now(),
      ...(originalBytes ? { originalBytes } : {}),
    };
  }

  await store.writeIndex(next);
  return { index: next, added: missing.length };
}

/** Removes binaries no element references any more. */
export async function pruneOrphans(store: Store, elements: any[]): Promise<number> {
  const referenced = new Set(
    elements.filter((el) => el.type === "image" && el.fileId).map((el) => el.fileId as string),
  );
  const index = await store.readIndex();
  const orphans = Object.keys(index).filter((id) => !referenced.has(id));
  if (orphans.length === 0) return 0;

  const next: FileIndex = { ...index };
  for (const id of orphans) {
    await store.deleteFile(id, index[id].ext);
    delete next[id];
  }
  await store.writeIndex(next);
  return orphans.length;
}

/** V8 caps strings at this many characters. A single-file save larger than
 *  that cannot be opened by excalidraw.com (or any editor that reads the file
 *  as one string); BlueprinceDraw streams it, so it still opens here. */
export const MAX_STRING_LENGTH = 536_870_888;

/**
 * What a single-file save writes: the editor's current elements and settings,
 * and every image those elements use. Images come from the editor when it
 * already holds them (no conversion at all), otherwise from the store, one at
 * a time, so saving never needs the whole board in memory twice.
 */
export function boardSource(
  store: Store,
  index: FileIndex,
  elements: readonly any[],
  appState: Record<string, any>,
  editorFiles: Record<string, any>,
): SceneSource {
  return {
    elements,
    appState: pickAppState(appState),
    fileIds: referencedFileIds(elements),
    async getImage(id) {
      const live = editorFiles[id];
      const entry = index[id];
      if (live?.dataURL?.startsWith("data:")) {
        return {
          id,
          mimeType: live.mimeType,
          dataURL: live.dataURL,
          created: live.created ?? entry?.created,
          lastRetrieved: live.lastRetrieved ?? entry?.lastRetrieved,
        };
      }
      if (!entry) return null;
      const stored = await store.readFile(id, entry);
      if (!stored) return null;
      return {
        id,
        mimeType: stored.mimeType,
        dataURL: await bytesToDataUrl(stored.bytes, stored.mimeType),
        created: entry.created,
        lastRetrieved: entry.lastRetrieved,
      };
    },
  };
}

/**
 * Puts back into the index every image binary the store holds but the index
 * forgot. Before v1.1 an import replaced the index with the imported file's
 * images only, which left earlier images stored but unreachable; this makes
 * them visible again (and "Remove unused images" can then clean them up).
 */
export async function recoverIndex(store: Store, index: FileIndex): Promise<{ index: FileIndex; recovered: number }> {
  const lost = await store.listStoredFiles(new Set(Object.keys(index)));
  if (lost.length === 0) return { index, recovered: 0 };
  const now = Date.now();
  const next: FileIndex = { ...index };
  for (const f of lost) {
    next[f.id] = { id: f.id, mimeType: f.mimeType, ext: f.ext, bytes: f.bytes, created: now, lastRetrieved: now };
  }
  await store.writeIndex(next);
  return { index: next, recovered: lost.length };
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

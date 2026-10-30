/**
 * The single-file save: a standard `.excalidraw` document (elements, app state
 * and every image as a base64 data URL), the same format excalidraw.com reads
 * and writes, so every file saved before keeps opening and every file saved
 * here opens elsewhere (below the 512 MB browser string limit, see README).
 *
 * Writing never builds the document in memory. It is emitted as a sequence of
 * small parts (header, elements, then one image at a time) into a sink: a file
 * on disk through the File System Access API, a Blob assembled from per-part
 * Blobs for the download fallback, or a Node stream in the tests. Reading is
 * done by `streamExcalidrawScene` (jsonStream.ts), which is just as frugal.
 */

export type SceneSink = {
  write(part: string): Promise<void>;
};

export type SceneImage = {
  id: string;
  mimeType: string;
  dataURL: string;
  created?: number;
  lastRetrieved?: number;
};

export type SceneSource = {
  elements: readonly any[];
  appState: Record<string, any>;
  /** image ids to write, in order */
  fileIds: readonly string[];
  /** fetches one image at a time; null = not available (skipped and reported) */
  getImage(id: string): Promise<SceneImage | null>;
};

export type WriteResult = { images: number; missing: string[]; bytes: number };

const ASCII = /^[\x00-\x7f]*$/;
const encoder = new TextEncoder();
/** UTF-8 length without encoding the (mostly ASCII, possibly huge) part twice. */
export const utf8Length = (s: string) => (ASCII.test(s) ? s.length : encoder.encode(s).length);

/** Image ids the saved board needs: those referenced by non-deleted image elements. */
export function referencedFileIds(elements: readonly any[]): string[] {
  const ids = new Set<string>();
  for (const el of elements) {
    if (el.type === "image" && el.fileId && !el.isDeleted) ids.add(el.fileId);
  }
  return [...ids];
}

export async function writeSceneFile(
  sink: SceneSink,
  source: SceneSource,
  onProgress?: (done: number, total: number) => void,
): Promise<WriteResult> {
  let bytes = 0;
  const put = async (part: string) => {
    bytes += utf8Length(part);
    await sink.write(part);
  };

  await put('{\n  "type": "excalidraw",\n  "version": 2,\n  "source": "https://excalidraw.hosh.it",\n  "elements": ');
  await put(JSON.stringify(source.elements));
  await put(',\n  "appState": ');
  await put(JSON.stringify(source.appState));
  await put(',\n  "files": {');

  const missing: string[] = [];
  let written = 0;
  let done = 0;
  for (const id of source.fileIds) {
    const image = await source.getImage(id);
    if (image && image.dataURL.startsWith("data:")) {
      const entry = {
        id,
        mimeType: image.mimeType,
        dataURL: image.dataURL,
        created: image.created ?? Date.now(),
        lastRetrieved: image.lastRetrieved ?? Date.now(),
      };
      await put(`${written === 0 ? "\n    " : ",\n    "}${JSON.stringify(id)}: ${JSON.stringify(entry)}`);
      written += 1;
    } else {
      missing.push(id);
    }
    onProgress?.(++done, source.fileIds.length);
  }

  await put("\n  }\n}\n");
  return { images: written, missing, bytes };
}

/* --------------------------------------------------------------- sinks */

/**
 * Writes into a file picked with the File System Access API. The browser
 * writes to a temporary swap file and only replaces the real one on close(),
 * so an interrupted save (crash, tab closed, disk full) leaves the previous
 * file untouched. Afterwards the size on disk is checked against what was sent.
 */
export async function writeToFileHandle(
  handle: FileSystemFileHandle,
  source: SceneSource,
  onProgress?: (done: number, total: number) => void,
): Promise<WriteResult & { lastModified: number }> {
  const writable = await (handle as any).createWritable({ keepExistingData: false });
  let result: WriteResult;
  try {
    result = await writeSceneFile({ write: (part) => writable.write(part) }, source, onProgress);
    await writable.close();
  } catch (err) {
    await writable.abort().catch(() => {});
    throw err;
  }
  const file = await handle.getFile();
  if (file.size !== result.bytes) {
    throw new Error(`The saved file has ${file.size} bytes instead of ${result.bytes}. Save again.`);
  }
  return { ...result, lastModified: file.lastModified };
}

/**
 * Download fallback (browsers without the File System Access API). Each part
 * becomes its own Blob immediately, so its string can be freed; browsers keep
 * large Blobs on disk, and the final Blob only references the parts.
 */
export async function buildSceneBlob(
  source: SceneSource,
  onProgress?: (done: number, total: number) => void,
): Promise<{ blob: Blob } & WriteResult> {
  const parts: Blob[] = [];
  const result = await writeSceneFile(
    { write: async (part) => void parts.push(new Blob([part])) },
    source,
    onProgress,
  );
  return { blob: new Blob(parts, { type: "application/json" }), ...result };
}

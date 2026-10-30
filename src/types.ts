export type FileIndexEntry = {
  id: string;
  mimeType: string;
  ext: string;
  bytes: number;
  created: number;
  lastRetrieved: number;
  /** original byte size before transcoding, if it was transcoded */
  originalBytes?: number;
};

/** Optional details stored next to an image binary. */
export type FileMeta = { created?: number; originalBytes?: number };

export type FileIndex = Record<string, FileIndexEntry>;

export type SceneDoc = {
  type: "blueprincedraw-scene";
  version: 1;
  savedAt: number;
  elements: any[];
  appState: Record<string, any>;
};

export type StoreKind = "folder" | "browser";

export type StoreStats = {
  fileCount: number;
  fileBytes: number;
  sceneBytes: number;
};

/** Serialisable pointer to a store, safe to postMessage into a worker. */
export type StoreRef =
  | { kind: "folder"; root: FileSystemDirectoryHandle }
  | { kind: "browser" };

export type ImportOptions = {
  transcode: boolean;
  quality: number;
  maxDimension: number;
};

export type ImportProgress = {
  phase: "reading" | "images" | "done" | "error";
  bytesRead: number;
  bytesTotal: number;
  filesDone: number;
  elements: number;
  storedBytes: number;
  originalBytes: number;
  message?: string;
};

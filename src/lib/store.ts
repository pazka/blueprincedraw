/**
 * Storage back ends.
 *
 * Both keep the same shape: a small `scene.json` holding elements + app state,
 * and every image as its own binary file. Nothing is ever base64-encoded on
 * disk, and no single blob has to be parsed as one string, so a project can
 * grow indefinitely without hitting the limit that breaks the classic
 * single-file `.excalidraw` format.
 *
 *   folder mode  -> a real directory the user picked (durable, backup-able)
 *   browser mode -> IndexedDB in this origin (zero setup, survives reloads)
 */

import { FILE_STORE, KV_STORE, idbClear, idbDelete, idbGet, idbKeys, idbPut } from "./idb.ts";
import type { FileIndex, FileMeta, SceneDoc, StoreKind, StoreRef, StoreStats } from "../types.ts";

export const MAX_BACKUPS = 20;
export const PROJECT_MARKER = "blueprincedraw.json";
export const SCENE_FILE = "scene.json";
export const INDEX_FILE = "files-index.json";
export const FILES_DIR = "files";
export const BACKUP_DIR = "backups";

export type StoredFile = { bytes: Uint8Array; mimeType: string };
export type StoredFileInfo = { id: string; ext: string; mimeType: string; bytes: number };

const MIME_FOR_EXT: Record<string, string> = {
  webp: "image/webp",
  jpg: "image/jpeg",
  png: "image/png",
  svg: "image/svg+xml",
  gif: "image/gif",
  avif: "image/avif",
  bmp: "image/bmp",
};

export interface Store {
  readonly kind: StoreKind;
  readonly label: string;
  readScene(): Promise<SceneDoc | null>;
  writeScene(doc: SceneDoc): Promise<void>;
  readIndex(): Promise<FileIndex>;
  writeIndex(index: FileIndex): Promise<void>;
  readFile(id: string, entry: { ext: string; mimeType: string }): Promise<StoredFile | null>;
  writeFile(id: string, ext: string, bytes: Uint8Array, mimeType: string, meta?: FileMeta): Promise<void>;
  deleteFile(id: string, ext: string): Promise<void>;
  stats(): Promise<StoreStats>;
  /** Image binaries physically present (except the ids in `skip`), listed or not in the index. */
  listStoredFiles(skip?: Set<string>): Promise<StoredFileInfo[]>;
  /** snapshot the current scene.json before it gets overwritten */
  backupScene(): Promise<void>;
  listBackups(): Promise<string[]>;
  readBackup(name: string): Promise<SceneDoc | null>;
  clearAll(): Promise<void>;
}

export const extForMime = (mime: string): string => {
  switch (mime) {
    case "image/webp":
      return "webp";
    case "image/jpeg":
    case "image/jfif":
      return "jpg";
    case "image/svg+xml":
      return "svg";
    case "image/gif":
      return "gif";
    case "image/avif":
      return "avif";
    case "image/bmp":
      return "bmp";
    default:
      return "png";
  }
};

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

const backupName = () => `scene-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;

/* ------------------------------------------------------------------ folder */

export class FolderStore implements Store {
  readonly kind = "folder" as const;
  private root: FileSystemDirectoryHandle;
  // a plain field, not a parameter property: keeps this file runnable by
  // Node's type stripping (the tests import it without a build step)
  constructor(root: FileSystemDirectoryHandle) {
    this.root = root;
  }

  get label() {
    return this.root.name;
  }

  static async attach(root: FileSystemDirectoryHandle): Promise<FolderStore> {
    const store = new FolderStore(root);
    await store.writeJson(PROJECT_MARKER, {
      type: "blueprincedraw-project",
      version: 1,
      createdAt: Date.now(),
    });
    await root.getDirectoryHandle(FILES_DIR, { create: true });
    await root.getDirectoryHandle(BACKUP_DIR, { create: true });
    return store;
  }

  private async writeJson(name: string, value: unknown, dir = this.root) {
    const handle = await dir.getFileHandle(name, { create: true });
    // createWritable() buffers into a swap file and only replaces the target on
    // close(), so a crash mid-write cannot truncate the previous version.
    const w = await handle.createWritable();
    try {
      await w.write(encode(value));
      await w.close();
    } catch (err) {
      await w.abort().catch(() => {});
      throw err;
    }
  }

  private async readJson<T>(name: string, dir = this.root): Promise<T | null> {
    try {
      const handle = await dir.getFileHandle(name);
      const text = await (await handle.getFile()).text();
      return text ? (JSON.parse(text) as T) : null;
    } catch {
      return null;
    }
  }

  readScene() {
    return this.readJson<SceneDoc>(SCENE_FILE);
  }

  writeScene(doc: SceneDoc) {
    return this.writeJson(SCENE_FILE, doc);
  }

  async readIndex() {
    return (await this.readJson<FileIndex>(INDEX_FILE)) ?? {};
  }

  writeIndex(index: FileIndex) {
    return this.writeJson(INDEX_FILE, index);
  }

  async readFile(id: string, entry: { ext: string; mimeType: string }) {
    try {
      const dir = await this.root.getDirectoryHandle(FILES_DIR);
      const handle = await dir.getFileHandle(`${id}.${entry.ext}`);
      const file = await handle.getFile();
      return { bytes: new Uint8Array(await file.arrayBuffer()), mimeType: entry.mimeType };
    } catch {
      return null;
    }
  }

  /** `mimeType` is unused here: folder mode records it in files-index.json and
   *  keeps the binary on disk exactly as given. */
  async writeFile(id: string, ext: string, bytes: Uint8Array, _mimeType?: string) {
    const dir = await this.root.getDirectoryHandle(FILES_DIR, { create: true });
    const handle = await dir.getFileHandle(`${id}.${ext}`, { create: true });
    const w = await handle.createWritable();
    try {
      await w.write(new Blob([bytes as BlobPart]));
      await w.close();
    } catch (err) {
      await w.abort().catch(() => {});
      throw err;
    }
  }

  async deleteFile(id: string, ext: string) {
    try {
      const dir = await this.root.getDirectoryHandle(FILES_DIR);
      await dir.removeEntry(`${id}.${ext}`);
    } catch {
      /* already gone */
    }
  }

  async stats(): Promise<StoreStats> {
    const index = await this.readIndex();
    const entries = Object.values(index);
    let sceneBytes = 0;
    try {
      const handle = await this.root.getFileHandle(SCENE_FILE);
      sceneBytes = (await handle.getFile()).size;
    } catch {
      /* not saved yet */
    }
    return {
      fileCount: entries.length,
      fileBytes: entries.reduce((sum, e) => sum + (e.bytes || 0), 0),
      sceneBytes,
    };
  }

  async listStoredFiles(skip = new Set<string>()): Promise<StoredFileInfo[]> {
    const out: StoredFileInfo[] = [];
    let dir: FileSystemDirectoryHandle;
    try {
      dir = await this.root.getDirectoryHandle(FILES_DIR);
    } catch {
      return out;
    }
    for await (const [name, handle] of (dir as any).entries()) {
      const m = /^(.+)\.([a-z0-9]+)$/.exec(name as string);
      if (!m || skip.has(m[1]) || (handle as FileSystemHandle).kind !== "file" || !MIME_FOR_EXT[m[2]]) continue;
      const file = await (handle as FileSystemFileHandle).getFile();
      out.push({ id: m[1], ext: m[2], mimeType: MIME_FOR_EXT[m[2]], bytes: file.size });
    }
    return out;
  }

  async backupScene() {
    const existing = await this.readScene();
    if (!existing) return;
    const dir = await this.root.getDirectoryHandle(BACKUP_DIR, { create: true });
    await this.writeJson(backupName(), existing, dir);

    const names: string[] = [];
    for await (const name of (dir as any).keys()) {
      if (name.startsWith("scene-")) names.push(name as string);
    }
    names.sort();
    for (const stale of names.slice(0, Math.max(0, names.length - MAX_BACKUPS))) {
      await dir.removeEntry(stale).catch(() => {});
    }
  }

  async listBackups() {
    try {
      const dir = await this.root.getDirectoryHandle(BACKUP_DIR);
      const names: string[] = [];
      for await (const name of (dir as any).keys()) {
        if (name.startsWith("scene-")) names.push(name as string);
      }
      return names.sort().reverse();
    } catch {
      return [];
    }
  }

  async readBackup(name: string) {
    try {
      const dir = await this.root.getDirectoryHandle(BACKUP_DIR);
      return await this.readJson<SceneDoc>(name, dir);
    } catch {
      return null;
    }
  }

  async clearAll() {
    await this.root.removeEntry(FILES_DIR, { recursive: true }).catch(() => {});
    await this.root.removeEntry(SCENE_FILE).catch(() => {});
    await this.root.removeEntry(INDEX_FILE).catch(() => {});
    await this.root.getDirectoryHandle(FILES_DIR, { create: true });
  }
}

/* ----------------------------------------------------------------- browser */

const KEY_SCENE = "scene";
const KEY_INDEX = "index";
const KEY_BACKUPS = "backups";

export class BrowserStore implements Store {
  readonly kind = "browser" as const;
  readonly label = "Browser storage";

  async readScene() {
    return (await idbGet<SceneDoc>(KV_STORE, KEY_SCENE)) ?? null;
  }

  writeScene(doc: SceneDoc) {
    return idbPut(KV_STORE, KEY_SCENE, doc).then(() => undefined);
  }

  async readIndex() {
    return (await idbGet<FileIndex>(KV_STORE, KEY_INDEX)) ?? {};
  }

  writeIndex(index: FileIndex) {
    return idbPut(KV_STORE, KEY_INDEX, index).then(() => undefined);
  }

  async readFile(id: string) {
    const rec = await idbGet<StoredFile>(FILE_STORE, id);
    return rec ? { bytes: new Uint8Array(rec.bytes), mimeType: rec.mimeType } : null;
  }

  writeFile(id: string, _ext: string, bytes: Uint8Array, mimeType: string) {
    return idbPut(FILE_STORE, id, { bytes, mimeType }).then(() => undefined);
  }

  deleteFile(id: string) {
    return idbDelete(FILE_STORE, id).then(() => undefined);
  }

  async stats(): Promise<StoreStats> {
    const index = await this.readIndex();
    const entries = Object.values(index);
    const scene = await this.readScene();
    return {
      fileCount: entries.length,
      fileBytes: entries.reduce((sum, e) => sum + (e.bytes || 0), 0),
      sceneBytes: scene ? JSON.stringify(scene).length : 0,
    };
  }

  async listStoredFiles(skip = new Set<string>()): Promise<StoredFileInfo[]> {
    const out: StoredFileInfo[] = [];
    for (const key of await idbKeys(FILE_STORE)) {
      if (skip.has(String(key))) continue; // keys only: listed images are never read here
      const rec = await idbGet<StoredFile>(FILE_STORE, key);
      if (!rec) continue;
      out.push({ id: String(key), ext: extForMime(rec.mimeType), mimeType: rec.mimeType, bytes: rec.bytes.byteLength });
    }
    return out;
  }

  async backupScene() {
    const existing = await this.readScene();
    if (!existing) return;
    const backups = (await idbGet<Record<string, SceneDoc>>(KV_STORE, KEY_BACKUPS)) ?? {};
    backups[backupName()] = existing;
    for (const stale of Object.keys(backups).sort().slice(0, -MAX_BACKUPS)) {
      delete backups[stale];
    }
    await idbPut(KV_STORE, KEY_BACKUPS, backups);
  }

  async listBackups() {
    const backups = (await idbGet<Record<string, SceneDoc>>(KV_STORE, KEY_BACKUPS)) ?? {};
    return Object.keys(backups).sort().reverse();
  }

  async readBackup(name: string) {
    const backups = (await idbGet<Record<string, SceneDoc>>(KV_STORE, KEY_BACKUPS)) ?? {};
    return backups[name] ?? null;
  }

  async clearAll() {
    await idbClear(FILE_STORE);
    await idbDelete(KV_STORE, KEY_SCENE);
    await idbDelete(KV_STORE, KEY_INDEX);
  }
}

/* -------------------------------------------------------------- resolution */

export function storeFromRef(ref: StoreRef): Store {
  return ref.kind === "folder" ? new FolderStore(ref.root) : new BrowserStore();
}

export function refForStore(store: Store): StoreRef {
  if (store.kind === "folder") {
    return { kind: "folder", root: (store as FolderStore)["root"] as FileSystemDirectoryHandle };
  }
  return { kind: "browser" };
}

/** Count of orphaned binaries, i.e. images no element points at any more. */
export async function findOrphans(store: Store, elements: any[]): Promise<string[]> {
  const referenced = new Set(
    elements.filter((el) => el.type === "image" && el.fileId).map((el) => el.fileId as string),
  );
  const index = await store.readIndex();
  return Object.keys(index).filter((id) => !referenced.has(id));
}

export async function listBrowserFileIds(): Promise<string[]> {
  return (await idbKeys(FILE_STORE)).map(String);
}

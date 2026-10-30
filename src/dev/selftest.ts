/**
 * Exercises FolderStore end to end.
 *
 * A picked directory and the origin private file system expose the very same
 * `FileSystemDirectoryHandle` API, so running against OPFS covers every folder
 * code path (atomic writes, the binary files directory, the backup rotation)
 * without needing the native folder picker.
 *
 * Run from the console: `await window.__bpd.selfTest()`
 */

import { FolderStore, MAX_BACKUPS } from "../lib/store.ts";
import type { SceneDoc } from "../types.ts";

const scene = (n: number): SceneDoc => ({
  type: "blueprincedraw-scene",
  version: 1,
  savedAt: Date.now(),
  elements: Array.from({ length: n }, (_, i) => ({ id: `el${i}`, type: "rectangle" })),
  appState: { viewBackgroundColor: "#ffffff" },
});

export async function folderSelfTest(): Promise<Record<string, unknown>> {
  const results: Record<string, unknown> = {};
  const opfs = await navigator.storage.getDirectory();
  await opfs.removeEntry("selftest", { recursive: true }).catch(() => {});
  const root = await opfs.getDirectoryHandle("selftest", { create: true });

  const store = await FolderStore.attach(root);
  results.label = store.label;

  // scene round trip
  await store.writeScene(scene(3));
  results.sceneRoundTrip = (await store.readScene())?.elements.length === 3;

  // binary round trip: bytes must come back identical, no base64 anywhere
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 255, 128]);
  await store.writeFile("abc123", "webp", bytes, "image/webp");
  const back = await store.readFile("abc123", { ext: "webp", mimeType: "image/webp" });
  results.binaryRoundTrip =
    !!back && back.bytes.length === bytes.length && back.bytes.every((b, i) => b === bytes[i]);

  await store.writeIndex({
    abc123: {
      id: "abc123",
      mimeType: "image/webp",
      ext: "webp",
      bytes: bytes.length,
      created: 1,
      lastRetrieved: 2,
    },
  });
  results.indexRoundTrip = Object.keys(await store.readIndex()).length === 1;

  const stats = await store.stats();
  results.stats = stats;
  results.statsCorrect = stats.fileCount === 1 && stats.fileBytes === bytes.length;

  // backup rotation: more snapshots than the cap, oldest must be dropped
  for (let i = 0; i < MAX_BACKUPS + 4; i++) {
    await store.backupScene();
    await store.writeScene(scene(i + 4));
    await new Promise((r) => setTimeout(r, 2)); // distinct ISO timestamps
  }
  const backups = await store.listBackups();
  results.backupCount = backups.length;
  results.backupsCapped = backups.length === MAX_BACKUPS;
  results.newestBackupReadable = (await store.readBackup(backups[0]))?.elements.length;

  // on-disk layout
  const names: string[] = [];
  for await (const name of (root as any).keys()) names.push(name as string);
  results.layout = names.sort();

  const filesDir = await root.getDirectoryHandle("files");
  const fileNames: string[] = [];
  for await (const name of (filesDir as any).keys()) fileNames.push(name as string);
  results.filesDir = fileNames;

  // the scene file must stay small: no image bytes may leak into it
  const sceneFile = await (await root.getFileHandle("scene.json")).getFile();
  results.sceneFileBytes = sceneFile.size;
  results.sceneHasNoBase64 = !(await sceneFile.text()).includes("data:image");

  await store.clearAll();
  results.clearedScene = (await store.readScene()) === null;

  await opfs.removeEntry("selftest", { recursive: true }).catch(() => {});

  results.pass = [
    results.sceneRoundTrip,
    results.binaryRoundTrip,
    results.indexRoundTrip,
    results.statsCorrect,
    results.backupsCapped,
    results.sceneHasNoBase64,
    results.clearedScene,
  ].every(Boolean);

  return results;
}

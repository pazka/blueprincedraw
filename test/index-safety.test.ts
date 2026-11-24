// The "never break existing data" rule (CLAUDE.md) rests on three helpers of
// src/lib/project.ts: recoverIndex (images an older version stored but dropped
// from the index come back), syncNewFiles (new editor images are added without
// touching the ones already indexed) and pruneOrphans (only images no element
// uses are deleted). These tests pin what each one keeps and what it changes,
// on an in-memory Store.
import assert from "node:assert/strict";
import { test } from "node:test";

const { pruneOrphans, recoverIndex, syncNewFiles } = await import("../src/lib/project.ts");

type Entry = { id: string; ext: string; mimeType: string; bytes: number; created: number; lastRetrieved: number };

function memoryStore(index: Record<string, Entry>, binaries: Record<string, { ext: string; mimeType: string; bytes: Uint8Array }>) {
  const calls = { writeIndex: 0, deleted: [] as string[], written: [] as string[] };
  let stored: Record<string, Entry> = structuredClone(index);
  const files = { ...binaries };
  const store = {
    kind: "browser",
    label: "memory",
    async readIndex() {
      return structuredClone(stored);
    },
    async writeIndex(next: Record<string, Entry>) {
      calls.writeIndex++;
      stored = structuredClone(next);
    },
    async writeFile(id: string, ext: string, bytes: Uint8Array, mimeType: string) {
      calls.written.push(id);
      files[id] = { ext, mimeType, bytes };
    },
    async deleteFile(id: string) {
      calls.deleted.push(id);
      delete files[id];
    },
    async listStoredFiles(skip = new Set<string>()) {
      return Object.entries(files)
        .filter(([id]) => !skip.has(id))
        .map(([id, f]) => ({ id, ext: f.ext, mimeType: f.mimeType, bytes: f.bytes.byteLength }));
    },
  };
  return { store: store as any, calls, files, stored: () => stored };
}

const entry = (id: string, bytes = 3): Entry => ({ id, ext: "webp", mimeType: "image/webp", bytes, created: 1, lastRetrieved: 2 });
const bin = (n = 3) => ({ ext: "webp", mimeType: "image/webp", bytes: new Uint8Array(n) });

test("recoverIndex puts back stored images the index forgot and keeps the listed ones as they are", async () => {
  const index = { a: entry("a") };
  const m = memoryStore(index, { a: bin(), lost1: bin(5), lost2: { ext: "png", mimeType: "image/png", bytes: new Uint8Array(7) } });
  const { index: next, recovered } = await recoverIndex(m.store, index);
  assert.equal(recovered, 2);
  assert.deepEqual(next.a, entry("a"));
  assert.deepEqual(
    [next.lost1.ext, next.lost1.mimeType, next.lost1.bytes, next.lost2.ext, next.lost2.mimeType, next.lost2.bytes],
    ["webp", "image/webp", 5, "png", "image/png", 7],
  );
  assert.deepEqual(Object.keys(m.stored()).sort(), ["a", "lost1", "lost2"]);
  assert.equal(m.calls.writeIndex, 1);
  assert.deepEqual(m.calls.deleted, []);
  assert.deepEqual(index, { a: entry("a") }, "the caller's index object is not mutated");
});

test("recoverIndex changes nothing when every stored image is listed", async () => {
  const index = { a: entry("a") };
  const m = memoryStore(index, { a: bin() });
  const out = await recoverIndex(m.store, index);
  assert.equal(out.recovered, 0);
  assert.equal(out.index, index);
  assert.equal(m.calls.writeIndex, 0);
});

test("syncNewFiles stores only the editor images the index lacks and keeps the others", async () => {
  const index = { a: entry("a") };
  const m = memoryStore(index, { a: bin() });
  const editorFiles = {
    a: { dataURL: "data:image/webp;base64,AAAA", mimeType: "image/webp" }, // already indexed: untouched
    b: { dataURL: "data:image/png;base64,AQID", mimeType: "image/png", created: 42 },
    c: { dataURL: "https://example.invalid/x.png" }, // not a data URL: never stored
  };
  const out = await syncNewFiles(m.store, index, editorFiles, { transcode: false, quality: 0.9, maxDimension: 2560 });
  assert.ok(out);
  assert.deepEqual(out.index.a, entry("a"));
  assert.deepEqual([out.index.b.mimeType, out.index.b.ext, out.index.b.bytes, out.index.b.created], ["image/png", "png", 3, 42]);
  assert.equal(out.index.c, undefined);
  assert.deepEqual(m.calls.written, ["b"]);
  assert.deepEqual([...m.files.b.bytes], [1, 2, 3]);
  assert.deepEqual(Object.keys(m.stored()).sort(), ["a", "b"]);
  assert.deepEqual(m.calls.deleted, []);
});

test("syncNewFiles does nothing when the index already has every editor image", async () => {
  const index = { a: entry("a") };
  const m = memoryStore(index, { a: bin() });
  const out = await syncNewFiles(m.store, index, { a: { dataURL: "data:image/webp;base64,AAAA" } }, { transcode: false, quality: 0.9, maxDimension: 2560 });
  assert.equal(out, null);
  assert.equal(m.calls.writeIndex, 0);
  assert.deepEqual(m.calls.written, []);
});

test("pruneOrphans deletes only images no image element uses (deleted elements still keep theirs)", async () => {
  const index = { used: entry("used"), undoable: entry("undoable"), orphan: entry("orphan") };
  const m = memoryStore(index, { used: bin(), undoable: bin(), orphan: bin() });
  const elements = [
    { type: "image", fileId: "used" },
    { type: "image", fileId: "undoable", isDeleted: true },
    { type: "rectangle", fileId: "orphan" }, // not an image element: does not keep it
  ];
  assert.equal(await pruneOrphans(m.store, elements), 1);
  assert.deepEqual(m.calls.deleted, ["orphan"]);
  assert.deepEqual(Object.keys(m.stored()).sort(), ["undoable", "used"]);
  assert.deepEqual(Object.keys(m.files).sort(), ["undoable", "used"]);
});

test("pruneOrphans changes nothing when every image is used", async () => {
  const m = memoryStore({ a: entry("a") }, { a: bin() });
  assert.equal(await pruneOrphans(m.store, [{ type: "image", fileId: "a" }]), 0);
  assert.equal(m.calls.writeIndex, 0);
  assert.deepEqual(m.calls.deleted, []);
});

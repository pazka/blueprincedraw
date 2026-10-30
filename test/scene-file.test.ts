import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createWriteStream, openAsBlob } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { streamExcalidrawScene } from "../src/lib/jsonStream.ts";
import { referencedFileIds, utf8Length, writeSceneFile, type SceneSink } from "../src/lib/sceneFile.ts";

// bytesToDataUrl (used by boardSource) needs a FileReader; Node has none.
(globalThis as any).FileReader ??= class {
  result: string | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  error = null;
  readAsDataURL(blob: Blob) {
    blob.arrayBuffer().then((buf) => {
      this.result = `data:${blob.type};base64,${Buffer.from(buf).toString("base64")}`;
      this.onload?.();
    });
  }
};
const { boardSource, recoverIndex } = await import("../src/lib/project.ts");

const V8_STRING_LIMIT = 536_870_888;

function fileSink(path: string): SceneSink & { close(): Promise<void> } {
  const out = createWriteStream(path);
  return {
    write: (part) =>
      new Promise((resolve, reject) => {
        out.once("error", reject);
        if (out.write(part)) resolve();
        else out.once("drain", resolve);
      }),
    close: () => new Promise((resolve) => out.end(resolve)),
  };
}

const imageElement = (i: number, fileId: string) => ({
  id: `el${i}`,
  type: "image",
  fileId,
  x: i * 10,
  y: 0,
  width: 10,
  height: 10,
  status: "saved",
});

async function readBack(path: string) {
  const files = new Map<string, any>();
  let elements: any[] = [];
  let appState: any = null;
  await streamExcalidrawScene(await openAsBlob(path), {
    onElements: (els) => void (elements = els),
    onAppState: (s) => void (appState = s),
    onFile: (id, entry) => void files.set(id, entry),
  });
  return { files, elements, appState };
}

test("a saved file round-trips: elements, app state, images, non-ASCII text", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bpd-file-"));
  try {
    const images = new Map(
      ["a", "b", "c"].map((id) => [id, `data:image/webp;base64,${randomBytes(3000).toString("base64")}`]),
    );
    const elements = [
      imageElement(0, "a"),
      imageElement(1, "b"),
      imageElement(2, "c"),
      { id: "t", type: "text", text: "Énigme ✓ 你好   \"quoted\"" },
    ];
    const path = join(dir, "board.excalidraw");
    const sink = fileSink(path);
    const result = await writeSceneFile(sink, {
      elements,
      appState: { viewBackgroundColor: "#fffce8" },
      fileIds: referencedFileIds(elements),
      getImage: async (id) => ({ id, mimeType: "image/webp", dataURL: images.get(id)!, created: 1 }),
    });
    await sink.close();

    assert.equal((await stat(path)).size, result.bytes, "byte count matches what is on disk");
    const back = await readBack(path);
    assert.deepEqual(back.elements, elements);
    assert.equal(back.appState.viewBackgroundColor, "#fffce8");
    assert.equal(back.files.size, 3);
    for (const [id, url] of images) assert.equal(back.files.get(id).dataURL, url);
    // and it is plain JSON in the classic format, readable by excalidraw.com
    const doc = JSON.parse(await (await openAsBlob(path)).text());
    assert.equal(doc.type, "excalidraw");
    assert.equal(doc.version, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("missing images are reported and skipped, never written as broken entries", async () => {
  const parts: string[] = [];
  const result = await writeSceneFile({ write: async (p) => void parts.push(p) }, {
    elements: [imageElement(0, "here"), imageElement(1, "gone")],
    appState: {},
    fileIds: ["here", "gone"],
    getImage: async (id) => (id === "here" ? { id, mimeType: "image/png", dataURL: "data:image/png;base64,AA==" } : null),
  });
  assert.deepEqual(result.missing, ["gone"]);
  assert.equal(result.images, 1);
  const doc = JSON.parse(parts.join(""));
  assert.deepEqual(Object.keys(doc.files), ["here"]);
});

test("referencedFileIds: only images still on the board, each once", () => {
  assert.deepEqual(
    referencedFileIds([
      imageElement(0, "a"),
      imageElement(1, "a"),
      { ...imageElement(2, "b"), isDeleted: true },
      { type: "rectangle" },
    ]),
    ["a"],
  );
  assert.equal(utf8Length("abc"), 3);
  assert.equal(utf8Length("é✓"), 5);
});

test("boardSource takes images from the editor first, then from the store", async () => {
  const reads: string[] = [];
  const store = {
    kind: "browser",
    async readFile(id: string) {
      reads.push(id);
      return { bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png" };
    },
  } as any;
  const index = {
    live: { id: "live", ext: "png", mimeType: "image/png", bytes: 3, created: 5, lastRetrieved: 5 },
    stored: { id: "stored", ext: "png", mimeType: "image/png", bytes: 3, created: 7, lastRetrieved: 7 },
  };
  const source = boardSource(
    store,
    index,
    [imageElement(0, "live"), imageElement(1, "stored"), imageElement(2, "nowhere")],
    { theme: "dark", selectedElementIds: { x: true } },
    { live: { id: "live", mimeType: "image/png", dataURL: "data:image/png;base64,LIVE" } },
  );
  assert.equal((await source.getImage("live"))?.dataURL, "data:image/png;base64,LIVE");
  assert.equal((await source.getImage("stored"))?.dataURL, "data:image/png;base64,AQID");
  assert.equal(await source.getImage("nowhere"), null);
  assert.deepEqual(reads, ["stored"]);
  assert.deepEqual(source.appState, { theme: "dark" }, "transient app state is not saved");
});

test("recoverIndex puts back images that are stored but missing from the index", async () => {
  let written: any = null;
  const store = {
    async listStoredFiles(skip: Set<string>) {
      return [
        { id: "kept", ext: "webp", mimeType: "image/webp", bytes: 10 },
        { id: "lost", ext: "webp", mimeType: "image/webp", bytes: 20 },
      ].filter((f) => !skip.has(f.id));
    },
    async writeIndex(index: any) {
      written = index;
    },
  } as any;
  const index = { kept: { id: "kept", ext: "webp", mimeType: "image/webp", bytes: 10, created: 1, lastRetrieved: 1 } };
  const { index: next, recovered } = await recoverIndex(store, index);
  assert.equal(recovered, 1);
  assert.equal(next.lost.bytes, 20);
  assert.equal(next.kept.created, 1, "existing entries are untouched");
  assert.deepEqual(written, next);

  written = null;
  assert.equal((await recoverIndex(store, next)).recovered, 0);
  assert.equal(written, null, "nothing to recover means nothing is written");
});

/**
 * The real promise: a board bigger than the V8 string limit (the size that
 * makes excalidraw.com say "invalid file") is written and read back without
 * either side ever holding the file in memory. Opt-in (writes ~600 MB):
 * BPD_BIG_FILE=1 npm test. CI runs it.
 */
test("a file above the 512 MB string limit saves and reopens with bounded memory", { skip: !process.env.BPD_BIG_FILE }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "bpd-big-"));
  const IMAGES = 440;
  const SIZE = 1024 * 1024; // 1 MiB of raw bytes per image, ~1.37 MB as a data URL
  const base = randomBytes(SIZE);
  const imageBytes = (i: number) => {
    const b = Buffer.from(base);
    b.writeUInt32LE(i, 0); // every image distinct
    return b;
  };
  const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

  let peak = 0;
  const sample = () => (peak = Math.max(peak, process.memoryUsage().heapUsed + process.memoryUsage().external));
  const timer = setInterval(sample, 20);
  try {
    const ids = Array.from({ length: IMAGES }, (_, i) => `img${i}`);
    const elements = ids.map((id, i) => imageElement(i, id));
    const path = join(dir, "huge.excalidraw");
    const sink = fileSink(path);
    const result = await writeSceneFile(sink, {
      elements,
      appState: {},
      fileIds: ids,
      getImage: async (id) => ({
        id,
        mimeType: "image/png",
        dataURL: `data:image/png;base64,${imageBytes(Number(id.slice(3))).toString("base64")}`,
      }),
    });
    await sink.close();
    const size = (await stat(path)).size;
    assert.equal(size, result.bytes);
    assert.ok(size > V8_STRING_LIMIT, `file is ${size} bytes, above the string limit`);

    let seen = 0;
    await streamExcalidrawScene(await openAsBlob(path), {
      onElements: (els) => assert.equal(els.length, IMAGES),
      onFile: (id, entry) => {
        const bytes = Buffer.from(entry.dataURL.slice(entry.dataURL.indexOf(",") + 1), "base64");
        assert.equal(sha(bytes), sha(imageBytes(Number(id.slice(3)))), `${id} intact`);
        seen += 1;
        sample();
      },
    });
    assert.equal(seen, IMAGES);
    // a whole-file approach would need > 1 GB here (the file as UTF-16 string)
    assert.ok(peak < 400 * 1024 * 1024, `peak memory ${Math.round(peak / 1e6)} MB`);
    console.log(`big file: ${Math.round(size / 1e6)} MB, peak heap+external ${Math.round(peak / 1e6)} MB`);
  } finally {
    clearInterval(timer);
    await rm(dir, { recursive: true, force: true });
  }
});

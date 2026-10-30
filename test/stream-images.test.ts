import assert from "node:assert/strict";
import { test } from "node:test";

// Node has no FileReader; a minimal one is enough for bytesToDataUrl.
(globalThis as any).FileReader ??= class {
  result: string | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  error = null;
  readAsDataURL(blob: Blob) {
    // resolve after a varying delay so loads finish out of order, as in a browser
    blob.arrayBuffer().then((buf) =>
      setTimeout(() => {
        this.result = `data:${blob.type};base64,${Buffer.from(buf).toString("base64")}`;
        this.onload?.();
      }, Math.random() * 4),
    );
  }
};

const { imageLoadOrder, streamImages } = await import("../src/lib/project.ts");

function fakeStore(count: number) {
  const index: Record<string, any> = {};
  for (let i = 0; i < count; i++) {
    index[`img${i}`] = { id: `img${i}`, ext: "webp", mimeType: "image/webp", bytes: 3, created: 1, lastRetrieved: 1 };
  }
  const store = {
    kind: "browser",
    async readFile(id: string) {
      await new Promise((r) => setTimeout(r, Math.random() * 3));
      return { bytes: new Uint8Array([1, 2, 3]), mimeType: "image/webp" };
    },
  };
  return { store: store as any, index };
}

test("streamImages delivers every image exactly once, whatever the batch timing", async () => {
  // batchMs 0 flushes on every completion: the worst case for a lost image
  for (const batchMs of [0, 1, 5]) {
    const { store, index } = fakeStore(300);
    const seen: string[] = [];
    const result = await streamImages(store, index, Object.keys(index), (files) => {
      for (const f of files) seen.push(f.id);
    }, { batchMs, concurrency: 6 });
    assert.equal(result.failed, 0);
    assert.equal(seen.length, 300, `batchMs=${batchMs}: ${300 - seen.length} images lost`);
    assert.equal(new Set(seen).size, 300, `batchMs=${batchMs}: duplicates`);
  }
});

test("streamImages stops when aborted", async () => {
  const { store, index } = fakeStore(200);
  const controller = new AbortController();
  let delivered = 0;
  const done = streamImages(store, index, Object.keys(index), (files) => {
    delivered += files.length;
    if (delivered > 20) controller.abort();
  }, { batchMs: 0, signal: controller.signal });
  await done;
  assert.ok(delivered < 200);
});

test("imageLoadOrder puts what is on screen first and unused images last", () => {
  const index = { near: {}, far: {}, unused: {} } as any;
  const elements = [
    { type: "image", fileId: "far", x: 10_000, y: 10_000, width: 10, height: 10 },
    { type: "image", fileId: "near", x: 400, y: 300, width: 10, height: 10 },
  ];
  const order = imageLoadOrder(elements, { scrollX: 0, scrollY: 0, zoom: { value: 1 } }, index, {
    width: 800,
    height: 600,
  });
  assert.deepEqual(order, ["near", "far", "unused"]);
});

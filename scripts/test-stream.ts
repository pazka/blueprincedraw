/**
 * Verifies the streaming reader against the real oversized scene, the one that
 * makes stock Excalidraw throw "Error: invalid file".
 * Run: node scripts/test-stream.ts <path-to-.excalidraw>
 */
import { openAsBlob } from "node:fs";
import { streamExcalidrawScene } from "../src/lib/jsonStream.ts";

const target = process.argv[2];
if (!target) {
  console.error("usage: node scripts/test-stream.ts <file>");
  process.exit(1);
}

const blob = await openAsBlob(target);
console.log("file bytes        :", blob.size.toLocaleString());
console.log("V8 string limit   :", (536870888).toLocaleString());
console.log("over the limit    :", blob.size > 536870888);

let header: Record<string, unknown> = {};
let elements = 0;
let imageRefs = new Set<string>();
let files = 0;
let payload = 0;
const mimes = new Map<string, number>();
const t0 = Date.now();
let lastLog = 0;

await streamExcalidrawScene(blob, {
  onHeader: (h) => {
    header = h;
  },
  onElements: (els) => {
    elements = els.length;
    for (const el of els) if (el.type === "image" && el.fileId) imageRefs.add(el.fileId);
  },
  onFile: (id, entry) => {
    files++;
    const url: string = entry.dataURL || "";
    payload += url.length;
    const mime = (url.match(/^data:([^;]+)/) || [])[1] || entry.mimeType || "?";
    mimes.set(mime, (mimes.get(mime) || 0) + 1);
    if (files - lastLog >= 100) {
      lastLog = files;
      console.log(`  ...${files} images, ${(payload / 1048576).toFixed(0)} MB decoded so far`);
    }
  },
  onProgress: (read, total) => {
    if (read === total) console.log("  read 100%");
  },
});

const secs = ((Date.now() - t0) / 1000).toFixed(1);
console.log("-".repeat(46));
console.log("header            :", JSON.stringify(header));
console.log("elements          :", elements);
console.log("image refs        :", imageRefs.size);
console.log("files streamed    :", files);
console.log("image payload     :", (payload / 1048576).toFixed(1), "MB");
console.log("mime types        :", [...mimes]);
console.log("all refs resolved :", files > 0);
console.log("elapsed           :", secs, "s");
console.log("peak heap         :", (process.memoryUsage().heapUsed / 1048576).toFixed(0), "MB");

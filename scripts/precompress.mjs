// Writes .br and .gz twins of every compressible file in dist/ (served by
// server/static.js when the browser accepts them). Brotli at max quality: done
// once at build time, so it costs nothing per request.
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

const root = fileURLToPath(new URL("../dist/", import.meta.url));
const COMPRESSIBLE = /\.(html|js|mjs|css|json|svg|txt|webmanifest|ttf)$/;
let count = 0;
let before = 0;
let after = 0;

async function walk(dir) {
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, ent.name);
    if (ent.isDirectory()) await walk(path);
    else if (COMPRESSIBLE.test(ent.name)) {
      const data = await readFile(path);
      if (data.length < 1024) continue;
      const br = brotliCompressSync(data, {
        params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: data.length },
      });
      const gz = gzipSync(data, { level: 9 });
      if (br.length < data.length) await writeFile(`${path}.br`, br);
      if (gz.length < data.length) await writeFile(`${path}.gz`, gz);
      count += 1;
      before += data.length;
      after += br.length;
    }
  }
}

await walk(root);
console.log(`precompressed ${count} files: ${(before / 1e6).toFixed(1)} MB -> ${(after / 1e6).toFixed(1)} MB (brotli)`);

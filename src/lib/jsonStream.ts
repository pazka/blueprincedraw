/**
 * Streaming reader for Excalidraw scene files of unbounded size.
 *
 * A normal `JSON.parse(await blob.text())` cannot work on very large scenes: the
 * whole file has to become one JavaScript string first, and V8 caps strings at
 * 536,870,888 characters. Anything past that throws
 * `RangeError: Invalid string length`, which Excalidraw surfaces as
 * "Error: invalid file".
 *
 * This reader never materialises the document. It pulls the blob in chunks and
 * reports one top-level key at a time; the `files` map is walked entry by entry,
 * so peak memory is one chunk plus one image.
 */

const CHUNK_BYTES = 8 * 1024 * 1024;

export type SceneStreamHandlers = {
  onHeader?: (header: Record<string, unknown>) => void;
  onElements?: (elements: any[]) => void | Promise<void>;
  onAppState?: (appState: Record<string, any>) => void | Promise<void>;
  onFile?: (id: string, entry: any) => void | Promise<void>;
  /** called roughly once per chunk read */
  onProgress?: (bytesRead: number, bytesTotal: number) => void;
};

function isWs(c: number): boolean {
  return c === 32 || c === 9 || c === 10 || c === 13;
}

function isDelimiter(c: number): boolean {
  return c === 44 || c === 125 || c === 93 || isWs(c);
}

/** Scans a JSON string literal starting at the opening quote.
 *  Returns the index just past the closing quote, or -1 if truncated. */
function scanString(s: string, i: number): number {
  const n = s.length;
  let j = i + 1;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c === 92) {
      j += 2;
      continue;
    }
    if (c === 34) return j + 1;
    j++;
  }
  return -1;
}

/** Scans an object or array, honouring strings so braces inside them are
 *  not counted. Returns the index just past it, or -1 if truncated. */
function scanContainer(s: string, i: number): number {
  const n = s.length;
  let depth = 0;
  let j = i;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c === 34) {
      const end = scanString(s, j);
      if (end < 0) return -1;
      j = end;
      continue;
    }
    if (c === 123 || c === 91) {
      depth++;
    } else if (c === 125 || c === 93) {
      depth--;
      if (depth === 0) return j + 1;
    }
    j++;
  }
  return -1;
}

/** Scans one complete JSON value starting at `i`, skipping leading whitespace.
 *  Returns the index just past it, or -1 when more input is needed. */
function scanValue(s: string, i: number): number {
  const n = s.length;
  while (i < n && isWs(s.charCodeAt(i))) i++;
  if (i >= n) return -1;

  const c = s[i];
  if (c === '"') return scanString(s, i);
  if (c === "{" || c === "[") return scanContainer(s, i);

  let j = i;
  while (j < n && !isDelimiter(s.charCodeAt(j))) j++;
  // a primitive touching the end of the buffer may still be truncated
  return j < n ? j : -1;
}

export async function streamExcalidrawScene(
  blob: Blob,
  handlers: SceneStreamHandlers,
): Promise<void> {
  const total = blob.size;
  const decoder = new TextDecoder("utf-8");
  let offset = 0;
  let buf = "";
  let pos = 0;
  let eof = false;

  /** Pull one more chunk into `buf`. Returns false once the blob is exhausted. */
  const more = async (): Promise<boolean> => {
    if (eof) return false;
    // drop what has already been consumed so the buffer cannot grow unbounded
    if (pos > 0) {
      buf = buf.slice(pos);
      pos = 0;
    }
    if (offset >= total) {
      buf += decoder.decode(); // flush a trailing partial code point
      eof = true;
      return false;
    }
    const end = Math.min(offset + CHUNK_BYTES, total);
    const bytes = await blob.slice(offset, end).arrayBuffer();
    offset = end;
    buf += decoder.decode(new Uint8Array(bytes), { stream: true });
    handlers.onProgress?.(offset, total);
    return true;
  };

  const skipWs = async (): Promise<string | null> => {
    for (;;) {
      while (pos < buf.length && isWs(buf.charCodeAt(pos))) pos++;
      if (pos < buf.length) return buf[pos];
      if (!(await more())) return null;
    }
  };

  const expect = async (ch: string): Promise<void> => {
    const c = await skipWs();
    if (c !== ch) {
      const found = c === null ? "end of file" : JSON.stringify(c);
      throw new Error(`Malformed scene file: expected ${JSON.stringify(ch)} but found ${found}`);
    }
    pos++;
  };

  const takeValueRaw = async (): Promise<string> => {
    for (;;) {
      const end = scanValue(buf, pos);
      if (end >= 0) {
        const raw = buf.slice(pos, end);
        pos = end;
        return raw;
      }
      if (!(await more())) {
        const last = scanValue(buf, pos);
        if (last >= 0) {
          const raw = buf.slice(pos, last);
          pos = last;
          return raw;
        }
        throw new Error("Malformed scene file: unexpected end of file");
      }
    }
  };

  const takeKey = async (): Promise<string> => {
    const c = await skipWs();
    if (c !== '"') throw new Error("Malformed scene file: expected an object key");
    return JSON.parse(await takeValueRaw());
  };

  const streamFilesMap = async (): Promise<void> => {
    const open = await skipWs();
    if (open === "n") {
      await takeValueRaw(); // "files": null
      return;
    }
    await expect("{");
    for (;;) {
      const c = await skipWs();
      if (c === null) throw new Error("Malformed scene file: unexpected end of file");
      if (c === "}") {
        pos++;
        return;
      }
      if (c === ",") {
        pos++;
        continue;
      }
      const id = await takeKey();
      await expect(":");
      const raw = await takeValueRaw();
      await handlers.onFile?.(id, JSON.parse(raw));
    }
  };

  await expect("{");

  const header: Record<string, unknown> = {};
  let headerSent = false;
  const sendHeader = () => {
    if (!headerSent) {
      handlers.onHeader?.(header);
      headerSent = true;
    }
  };

  for (;;) {
    const c = await skipWs();
    if (c === null) throw new Error("Malformed scene file: unexpected end of file");
    if (c === "}") {
      pos++;
      break;
    }
    if (c === ",") {
      pos++;
      continue;
    }

    const key = await takeKey();
    await expect(":");

    if (key === "files") {
      sendHeader();
      await streamFilesMap();
      continue;
    }

    const raw = await takeValueRaw();
    if (key === "elements") {
      sendHeader();
      await handlers.onElements?.(JSON.parse(raw));
    } else if (key === "appState") {
      await handlers.onAppState?.(JSON.parse(raw));
    } else {
      try {
        header[key] = JSON.parse(raw);
      } catch {
        /* unknown top-level key: ignore rather than fail the whole import */
      }
    }
  }

  sendHeader();
}

# BlueprinceDraw

**https://excalidraw.hosh.it** is an Excalidraw workspace built for scenes
that keep growing, the ones the normal `.excalidraw` file format eventually
refuses to open.

Your board never leaves your machine: there is no account and no login, and
the site only serves the editor. You save the board as **one `.excalidraw`
file** holding the scene and every image, in the same format excalidraw.com
uses, and you open it again from any computer.

It is the real Excalidraw editor (the official `@excalidraw/excalidraw`
package), wrapped in a storage layer that does not fall over as a project gets
large.

---

## Why this exists

A `.excalidraw` file is one JSON document with every image base64-encoded
inside it. To open one, a browser has to turn the whole file into a single
JavaScript string. V8 (the engine in Chrome, Edge and Node) caps strings at

```
536,870,888 characters
```

`RESTORED_BLUEPRINCE.excalidraw` was **554,243,417 bytes**, about 17 MB past
that ceiling. Reading it throws `RangeError: Invalid string length` before any
parsing happens, and Excalidraw reports that as:

```
Error: invalid file
```

The file was never malformed; it was simply too big to exist as one string.
No amount of RAM, no incognito window and no patched version of Excalidraw can
change that, because the limit is in the engine itself.

BlueprinceDraw sidesteps it in two ways:

1. **Nothing is ever parsed as one giant string.** Imports are streamed in
   8 MB chunks; the `files` map is walked one image at a time.
2. **Nothing is ever stored as one giant file.** A project is a small
   `scene.json` plus one binary file per image, and base64 never touches the disk.

As a result, `scene.json` for this project is under 1 MB and will stay that way
no matter how many screenshots get added.

---

## Running it

**Online:** open https://excalidraw.hosh.it, then **Menu → Open…** (Ctrl+O)
to load a `.excalidraw` file of any size and **Save** (Ctrl+S) to write it
back. Chrome and Edge save straight into the file you opened; other browsers
download a new copy on each save.

**Locally:** double-click **`BlueprinceDraw.cmd`**. It installs and builds on
first run, then serves the app on http://localhost:4270 (this machine only)
and opens it.

From a terminal:

```bash
npm ci          # once
npm run dev     # http://localhost:4270, with hot reload
npm run build   # production build (fonts/locales copied, brotli/gzip twins)
npm start       # serve dist/ with the production server (APP_PORT, default 8000)
npm test        # server + image-streaming tests
```

Everything is served by the app itself, fonts and locales included: no CDN,
no analytics, no request to any other site (the Content-Security-Policy
forbids it). The server is a ~200-line Node standard-library file server
that answers `GET` only; `DEPLOY.md` explains how it runs on the box.

---

## How a board is saved

### Your save: one `.excalidraw` file

**Open…** (Ctrl+O), **Save** (Ctrl+S) and **Save as…** (Ctrl+Shift+S) work on
a single standard `.excalidraw` file: elements, canvas settings and every image
the board uses, each image embedded as a data URL. It is the format
excalidraw.com reads and writes, so every file saved before this version still
opens, and files saved here open there too (up to 512 MB, see below).

- **Saving into the file you opened** (Chrome and Edge). After the first Save
  or Open, Ctrl+S rewrites that same file, and a linked file is also saved
  automatically 20 seconds after the first unsaved change. The status bar
  shows which file the board belongs to and whether it is up to date. After a
  browser restart, one click on **Allow saving to the file** restores access.
- **A save never damages the previous file.** The browser writes to a
  temporary file and only swaps it in once every byte is written, then the
  app checks the size on disk. If anything fails midway, the old file is
  untouched and the status bar says so.
- **Changed elsewhere?** If the file was rewritten by another computer or tab
  (a synced folder, for instance), the app asks before overwriting it, and
  offers to load the newer version when you come back to the tab.
- **No size limit.** Neither saving nor opening ever holds the file in memory
  as one piece: it is written and read one image at a time (see
  [Big files](#big-files)).
- **Other browsers** have no direct file access, so Save downloads the file
  and Open uses the file picker.

### The working copy (automatic)

While you draw, the board is also kept in the browser, saved 1.5 s after each
edit, so a crash or a closed tab never loses work even before a file save. It
lives in this site's IndexedDB by default, or in a folder you pick with
**Keep a working copy in a folder…** (one binary per image, 20 rotating
scene backups). Boards stored by earlier versions open exactly as before.

Opening a file adds its images to the working copy and never removes the ones
already there. Images that an earlier version stored but lost track of are
found again automatically when the board opens.

## Images

By default every imported or pasted image is re-encoded to WebP
(quality 0.9, capped at 2560 px on the long edge). On the Blueprince project
that is a **91% reduction**: 369.7 MB of PNG became 34.1 MB of WebP, visually
indistinguishable.

Turn it off with **Menu → Compress images to WebP** if you want originals kept
byte-for-byte. The re-encode is skipped automatically for SVG, GIF, AVIF and
anything already WebP, and is discarded whenever it would produce a *larger*
file, so it can never make a project worse.

**Menu → Remove unused images** deletes binaries no element points at any more.

---

## Status bar

```
● All changes saved · 🗄 Browser storage · 486 images · 36.4 MB · 📄 blueprince.excalidraw: saved 22:41
```

The dot is about the working copy: green means saved, amber means edits
pending, blue pulsing means a write is in flight, and red means the last save
failed. The 📄 part is about your file. Closing the tab while either one has
unsaved changes asks first.

Pure view changes (panning, zooming, selecting) do not count as edits, so
idle time never rewrites anything.

## Layout

```
src/
  lib/jsonStream.ts   chunked reader for .excalidraw files of any size
  lib/store.ts        FolderStore + BrowserStore behind one interface
  lib/project.ts      editor <-> store glue, progressive image loading,
                      board source for saving, index recovery, orphan cleanup
  lib/sceneFile.ts    single-file save, streamed one image at a time
  lib/images.ts       WebP transcoding, data URL <-> bytes
  lib/idb.ts          small IndexedDB wrapper (no npm dependency)
  worker/import.worker.ts   streaming import off the main thread
  dev/selftest.ts     exercises folder storage against OPFS
  App.tsx             editor, menu, autosave, status bar
server/                     static file server (Node stdlib), /healthz, smoke checks
scripts/copy-assets.mjs     Excalidraw fonts + locales into the build (no CDN)
scripts/precompress.mjs     brotli/gzip twins of the build
scripts/test-stream.ts      streams a real file and prints what it found
test/                       npm test
deploy/, .github/           hosh.it box deployment (see DEPLOY.md)
```

Runtime dependencies are `@excalidraw/excalidraw`, `react` and `react-dom`
(bundled into the page). The server uses only Node's standard library.

## Big files

The editor opens as soon as the scene (elements only, under 1 MB) is read;
images then stream in, four at a time, **nearest to the saved viewport
first**, and appear as they arrive. On the Blueprince board (1,290 elements,
486 images, 36 MB) the canvas is usable after ~0.1 s and every image is in
after ~0.6 s.

Every step streams, so a board can grow past the size that breaks other
tools: a single JavaScript string tops out at 512 MB, and excalidraw.com (or
any editor reading a file as one string) fails above it with "invalid file".

| Step | How | Measured on the Blueprince board |
|---|---|---|
| Open | 8 MB chunks, one image parsed at a time | 554 MB original: 37 s with WebP conversion, 7 s without, JS heap peak 140 MB |
| Save | one image written at a time into the file | 52 MB in 0.3 s; 554 MB (PNG originals kept) in 2 s |
| Reopen a save above 512 MB | same streamed reader | 554 MB in 7 s, identical elements, every image back |
| Node test, CI | `BPD_BIG_FILE=1`: writes and rereads a 615 MB file | peak memory 166 MB |

The only thing that grows with the board is the editor itself, which keeps
each image in memory to draw it. With WebP compression (the default) your
board needs about 140 MB; with the original PNGs about 700 MB, far below the
4 GB Chrome allows a tab.

### Checking the stream reader against a real file

```bash
node scripts/test-stream.ts /path/to/huge.excalidraw
```

Against the 554 MB original: 1289 elements and 485 images in **2.0 s** with a
**89 MB** peak heap.

### Checking folder storage

Open the app's console and run:

```js
await window.__bpd.selfTest()
```

A picked folder and the origin private file system expose the same
`FileSystemDirectoryHandle` API, so this covers every folder code path (atomic
writes, the binary files directory, backup rotation, stats) without needing
the native picker. It reports `pass: true` when all of them hold.

`window.__bpd` also exposes `api` (the live Excalidraw API), `boot` and
`writeTo(fileHandle)`, `openBlob(file)` and `buildFile()` for poking at a
running session.

---

## Verified

- The 554 MB `RESTORED_BLUEPRINCE.excalidraw`, the file excalidraw.com refuses
  with "Error: invalid file", imports fully: 1289 elements, 485 images,
  395.7 MB of PNG down to 36.4 MB of WebP (−91%).
- Reopening after a reload restores all 1,290 elements and 486 images (2026-10-30 save).
- Saving produces a valid 51.9 MB `.excalidraw` that reopens with identical
  elements (ids and versions) and every image resolved.
- A 554 MB save, above the browser string limit, reopens the same way.
- `selfTest()` passes on folder storage.

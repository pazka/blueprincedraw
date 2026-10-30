# BlueprinceDraw

**https://excalidraw.hosh.it** is an Excalidraw workspace built for scenes
that keep growing, the ones the normal `.excalidraw` file format eventually
refuses to open.

Your board never leaves your machine: there is no account and no login, and
the site only serves the editor. Boards are saved in your browser (or in a
folder you pick), and you move them around with **Export** / **Import**.

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

**Online:** open https://excalidraw.hosh.it. To bring a board over, use
**Menu → Import .excalidraw (any size)…**; to take it elsewhere, **Export**.
A board saved on one site or browser is not visible on another (browser
storage belongs to one address), so export from the old place and import
into the new one.

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

## How a project is stored

### Folder mode (recommended)

**Menu → Use a project folder…** and pick a directory. Chrome and Edge only, as
it uses the File System Access API.

```
MyProject/
  blueprincedraw.json      project marker
  scene.json               elements + canvas settings   (small, fast to load)
  files-index.json         image id -> format, size, timestamps
  files/
    8edeb24146d4….webp     one binary per image, no base64
    …
  backups/
    scene-2026-09-20T14-31-07-004Z.json   last 20 snapshots
```

Why this is safer than a single file:

- **Normal files on your disk**, which any backup tool, sync client or file
  manager can see, so nothing is trapped in browser storage.
- **Atomic saves:** writes go through a swap file and only replace the target
  on commit, so a crash mid-save cannot truncate the previous version.
- **Automatic snapshots:** `scene.json` is copied into `backups/` before every
  manual save and at most every 5 minutes during autosave; the last 20 are
  kept. Since images live outside `scene.json`, each snapshot costs kilobytes.
- **Damage stays local:** a corrupted image file loses that one image, not the
  project.

### Browser mode (default)

With no folder chosen, everything lives in IndexedDB for this origin, and the
app asks the browser for persistent storage so it is not evicted. It is fine
for scratch work, but switch to a folder (or export regularly) for anything you
care about.

You can move between the two at any time: picking an empty folder copies the
open project into it.

---

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

## Importing and exporting

**Menu → Import .excalidraw (any size)…** accepts any classic scene file with
no size limit. It runs on a worker thread with live progress, so the editor
stays responsive. The 554 MB original imports in about a minute.

**Menu → Export .excalidraw…** writes a standard single-file scene for sharing
or for excalidraw.com. The export is assembled as a stream of blob parts rather
than one concatenated string, and you get a warning before producing anything
over ~512 MB, because such a file would be unreadable by excalidraw.com, though
BlueprinceDraw itself can still reopen it.

---

## Saving

Autosave runs 1.5 s after the last edit. `Ctrl+S` forces an immediate save plus
a backup snapshot. The footer shows the live state:

```
● All changes saved · 📁 blueprince · 485 images · 34.1 MB
```

A dot that is green means saved, amber means edits pending, blue pulsing means
a write is in flight, red means the last save failed. Closing the tab with
unsaved work prompts first.

Pure view changes (panning, zooming, selecting) do not mark the project
dirty, so idle time never rewrites the file.

---

## Layout

```
src/
  lib/jsonStream.ts   chunked reader for .excalidraw files of any size
  lib/store.ts        FolderStore + BrowserStore behind one interface
  lib/project.ts      editor <-> store glue, progressive image loading,
                      export builder, orphan cleanup
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

## Opening a big board fast

The editor opens as soon as the scene (elements only, under 1 MB) is read;
images then stream in, four at a time, **nearest to the saved viewport
first**, and appear as they arrive. On the Blueprince board (1,290 elements,
486 images, 36 MB) the canvas is usable after ~0.1 s and every image is in
after ~0.6 s.

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
`buildExport()` for poking at a running session.

---

## Verified

- The 554 MB `RESTORED_BLUEPRINCE.excalidraw`, the file excalidraw.com refuses
  with "Error: invalid file", imports fully: 1289 elements, 485 images,
  395.7 MB of PNG down to 36.4 MB of WebP (−91%).
- Reopening after a reload restores all 1,290 elements and 486 images (2026-10-30 export).
- Export produces a valid 51.9 MB `.excalidraw` that parses cleanly with every
  image reference resolved.
- `selfTest()` passes on folder storage.

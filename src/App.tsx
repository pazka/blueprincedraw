import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Excalidraw, Footer, MainMenu, getSceneVersion } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";

import { BrowserStore, FolderStore, refForStore, type Store } from "./lib/store.ts";
import { KV_STORE, idbGet, idbPut, requestPersistence } from "./lib/idb.ts";
import {
  MAX_STRING_LENGTH,
  boardSource,
  copyProject,
  downloadBlob,
  imageLoadOrder,
  loadProject,
  pruneOrphans,
  recoverIndex,
  saveProject,
  streamImages,
  syncNewFiles,
  type EditorScene,
} from "./lib/project.ts";
import { buildSceneBlob, writeToFileHandle } from "./lib/sceneFile.ts";
import { DEFAULT_MAX_DIMENSION, DEFAULT_QUALITY, formatBytes } from "./lib/images.ts";
import { BusyOverlay, ProgressOverlay } from "./ui/Overlay.tsx";
import type { FileIndex, ImportOptions, ImportProgress } from "./types.ts";

const AUTOSAVE_MS = 1500;
const BACKUP_EVERY_MS = 5 * 60 * 1000;
const HANDLE_KEY = "projectDirHandle";
const OPTIONS_KEY = "imageOptions";
/** the .excalidraw file the board is saved to (a FileSystemFileHandle, Chrome/Edge) */
const FILE_KEY = "sceneFileHandle";
/** { version, lastModified } of that file when this browser last wrote or read it */
const FILE_META_KEY = "sceneFileMeta";
/** a linked file is rewritten this long after the first unsaved change */
const FILE_AUTOSAVE_MS = 20_000;
const FILE_TYPES = [
  { description: "Excalidraw scene", accept: { "application/json": [".excalidraw", ".json"] } },
];
const canPickFiles = typeof window !== "undefined" && "showSaveFilePicker" in window && "showOpenFilePicker" in window;

type FileMeta = { version: number; lastModified: number };
type FileState = "none" | "clean" | "dirty" | "writing" | "error";

const DEFAULT_OPTIONS: ImportOptions = {
  transcode: true,
  quality: DEFAULT_QUALITY,
  maxDimension: DEFAULT_MAX_DIMENSION,
};

type SaveState = "idle" | "dirty" | "saving" | "saved" | "error";

type Boot = {
  store: Store;
  scene: EditorScene;
  /** bumped to force a clean remount of the editor when the project changes */
  epoch: number;
};

const emptyProgress = (): ImportProgress => ({
  phase: "reading",
  bytesRead: 0,
  bytesTotal: 0,
  filesDone: 0,
  elements: 0,
  storedBytes: 0,
  originalBytes: 0,
});

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export default function App() {
  const [boot, setBoot] = useState<Boot | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [busy, setBusy] = useState<{ title: string; detail?: string } | null>(null);
  const [importProgress, setImportProgress] = useState<ImportProgress | null>(null);
  const [importDone, setImportDone] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [stats, setStats] = useState({ fileCount: 0, fileBytes: 0, sceneBytes: 0 });
  const [imageLoad, setImageLoad] = useState<{ done: number; total: number } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [options, setOptions] = useState<ImportOptions>(DEFAULT_OPTIONS);
  const [needsReconnect, setNeedsReconnect] = useState(false);
  const [api, setApi] = useState<any>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [fileAccess, setFileAccess] = useState<"granted" | "prompt">("granted");
  const [fileState, setFileState] = useState<FileState>("none");
  const [fileSavedAt, setFileSavedAt] = useState<number | null>(null);
  const [fileProgress, setFileProgress] = useState<{ done: number; total: number } | null>(null);

  const apiRef = useRef<any>(null);
  const indexRef = useRef<FileIndex>({});
  const timerRef = useRef<number | null>(null);
  const savingRef = useRef(false);
  const syncingRef = useRef(false);
  const lastBackupRef = useRef(0);
  const savedVersionRef = useRef<number | null>(null);
  const epochRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const fileHandleRef = useRef<FileSystemFileHandle | null>(null);
  const fileMetaRef = useRef<FileMeta | null>(null);
  const fileTimerRef = useRef<number | null>(null);
  const fileWritingRef = useRef(false);
  const pendingHandleRef = useRef<FileSystemFileHandle | null>(null);
  const conflictWarnedRef = useRef(false);

  const say = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast((current) => (current === message ? null : current)), 4000);
  }, []);

  const refreshStats = useCallback(async (store: Store) => {
    setStats(await store.stats());
  }, []);

  const openProject = useCallback(
    async (store: Store, note?: string) => {
      setBusy({ title: "Opening project", detail: store.label });
      try {
        // scene + index only: images stream in once the editor is up
        const scene = await loadProject(store);
        // images an older version stored but dropped from the index come back
        const { index, recovered } = await recoverIndex(store, scene.index);
        scene.index = index;
        indexRef.current = scene.index;
        savedVersionRef.current = getSceneVersion(scene.elements);
        epochRef.current += 1;
        apiRef.current = null;
        setApi(null);
        setBoot({ store, scene, epoch: epochRef.current });
        setSaveState(scene.savedAt ? "saved" : "idle");
        await refreshStats(store);
        if (recovered) say(`Recovered ${recovered} stored image${recovered === 1 ? "" : "s"} the index had lost`);
        else if (note) say(note);
        return scene;
      } catch (err) {
        setBootError(errorText(err));
        return null;
      } finally {
        setBusy(null);
      }
    },
    [refreshStats, say],
  );

  /* ------------------------------------------------------------ boot */

  const start = useCallback(async () => {
    let store: Store = new BrowserStore();
    const handle = await idbGet<FileSystemDirectoryHandle>(KV_STORE, HANDLE_KEY).catch(() => null);
    if (handle) {
      const permission = await (handle as any)
        .queryPermission({ mode: "readwrite" })
        .catch(() => "denied");
      if (permission === "granted") {
        store = new FolderStore(handle);
      } else {
        setNeedsReconnect(true);
      }
    }
    const scene = await openProject(store);

    // the file this board is saved to, if any (permission must be re-granted after a restart)
    const fileHandle = await idbGet<FileSystemFileHandle>(KV_STORE, FILE_KEY).catch(() => null);
    if (fileHandle && scene) {
      fileHandleRef.current = fileHandle;
      fileMetaRef.current = (await idbGet<FileMeta>(KV_STORE, FILE_META_KEY).catch(() => null)) ?? null;
      setFileName(fileHandle.name);
      const access = await (fileHandle as any).queryPermission({ mode: "readwrite" }).catch(() => "prompt");
      setFileAccess(access === "granted" ? "granted" : "prompt");
      setFileState(fileMetaRef.current?.version === getSceneVersion(scene.elements) ? "clean" : "dirty");
    }
  }, [openProject]);

  useEffect(() => {
    void (async () => {
      await requestPersistence().catch(() => false);
      const saved = await idbGet<ImportOptions>(KV_STORE, OPTIONS_KEY).catch(() => null);
      if (saved) setOptions({ ...DEFAULT_OPTIONS, ...saved });
      await start();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ----------------------------------------------- progressive images */

  useEffect(() => {
    if (!api || !boot) return;
    const index = indexRef.current;
    const ids = imageLoadOrder(boot.scene.elements, boot.scene.appState, index);
    if (ids.length === 0) {
      setImageLoad(null);
      return;
    }
    const controller = new AbortController();
    setImageLoad({ done: 0, total: ids.length });
    void streamImages(
      boot.store,
      index,
      ids,
      (files, done, total) => {
        if (controller.signal.aborted) return;
        api.addFiles(files);
        setImageLoad({ done, total });
      },
      { signal: controller.signal },
    ).then(({ failed }) => {
      if (controller.signal.aborted) return;
      setImageLoad(null);
      if (failed) say(`${failed} image${failed === 1 ? "" : "s"} could not be loaded`);
    });
    return () => controller.abort();
  }, [api, boot, say]);

  /* ------------------------------------------------------------ saving */

  const doSave = useCallback(
    async (opts: { manual?: boolean } = {}) => {
      const api = apiRef.current;
      const store = boot?.store;
      if (!api || !store || savingRef.current) return;

      savingRef.current = true;
      setSaveState("saving");
      try {
        const now = Date.now();
        const backup = opts.manual === true || now - lastBackupRef.current > BACKUP_EVERY_MS;
        const elements = api.getSceneElements();
        await saveProject(store, elements, api.getAppState(), { backup });
        savedVersionRef.current = getSceneVersion(elements);
        if (backup) lastBackupRef.current = now;
        setSaveState("saved");
        await refreshStats(store);
        if (opts.manual) say(`Saved to ${store.label}`);
      } catch (err) {
        setSaveState("error");
        say(`Save failed: ${errorText(err)}`);
      } finally {
        savingRef.current = false;
      }
    },
    [boot, refreshStats, say],
  );

  const scheduleSave = useCallback(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      void doSave();
    }, AUTOSAVE_MS);
  }, [doSave]);

  const saveFileRef = useRef<(opts?: { as?: boolean; auto?: boolean }) => Promise<void>>(async () => {});

  const handleChange = useCallback(
    (elements: readonly any[], _appState: any, files: Record<string, any>) => {
      if (!boot) return;

      // Excalidraw fires onChange for pure view changes (pan, zoom, selection)
      // and once on mount. Only treat a real element mutation as unsaved work.
      const version = getSceneVersion(elements as any);
      if (version !== savedVersionRef.current) {
        setSaveState((current) => (current === "saving" ? current : "dirty"));
        scheduleSave();
      }
      if (fileHandleRef.current && version !== fileMetaRef.current?.version) {
        setFileState((current) => (current === "writing" ? current : "dirty"));
        // first unsaved change arms the timer; later edits do not push it back,
        // so continuous editing still reaches the file every FILE_AUTOSAVE_MS
        if (fileTimerRef.current === null) {
          fileTimerRef.current = window.setTimeout(() => {
            fileTimerRef.current = null;
            void saveFileRef.current({ auto: true });
          }, FILE_AUTOSAVE_MS);
        }
      }

      // persist any image that arrived by paste / drag-drop
      const missing = Object.keys(files || {}).some((id) => !indexRef.current[id]);
      if (missing && !syncingRef.current) {
        syncingRef.current = true;
        void syncNewFiles(boot.store, indexRef.current, files, options)
          .then(async (result) => {
            if (result) {
              indexRef.current = result.index;
              await refreshStats(boot.store);
              say(`Stored ${result.added} new image${result.added === 1 ? "" : "s"}`);
            }
          })
          .catch((err) => say(`Image save failed: ${err.message}`))
          .finally(() => {
            syncingRef.current = false;
          });
      }
    },
    [boot, options, refreshStats, say, scheduleSave],
  );

  useEffect(() => {
    // Ctrl+S / Ctrl+Shift+S / Ctrl+O are taken before Excalidraw sees them:
    // its own loader reads a whole file as one string, which large boards break.
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      const key = event.key.toLowerCase();
      if (key !== "s" && key !== "o") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (key === "o") void openFileRef.current();
      else void saveFileRef.current({ as: event.shiftKey });
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, []);

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (saveState === "dirty" || saveState === "saving" || fileState === "dirty" || fileState === "writing") {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [saveState, fileState]);

  /* ------------------------------------------------------- folder mode */

  const chooseFolder = useCallback(async () => {
    if (!("showDirectoryPicker" in window)) {
      say("This browser has no folder access. Use Chrome or Edge for folder projects.");
      return;
    }
    try {
      const root = await (window as any).showDirectoryPicker({
        id: "blueprincedraw",
        mode: "readwrite",
        startIn: "documents",
      });
      const store = await FolderStore.attach(root);
      await idbPut(KV_STORE, HANDLE_KEY, root);
      setNeedsReconnect(false);

      const existing = await store.readScene();
      const api = apiRef.current;
      if (!existing && api && boot) {
        // first use of this folder: copy the open project into it (every image,
        // straight from its store), then the editor's current, possibly unsaved, scene
        setBusy({ title: "Copying project into folder", detail: root.name });
        await copyProject(boot.store, store, (done, total) => {
          if (done % 10 === 0) setBusy({ title: "Copying project into folder", detail: `Image ${done}/${total}` });
        });
        await saveProject(store, api.getSceneElements(), api.getAppState(), { backup: false });
      }
      await openProject(store, `Project folder: ${root.name}`);
    } catch (err: any) {
      if (err?.name !== "AbortError") say(`Could not open folder: ${err.message}`);
    } finally {
      setBusy(null);
    }
  }, [boot, openProject, say]);

  const reconnectFolder = useCallback(async () => {
    const handle = await idbGet<FileSystemDirectoryHandle>(KV_STORE, HANDLE_KEY).catch(() => null);
    if (!handle) {
      setNeedsReconnect(false);
      return;
    }
    const permission = await (handle as any)
      .requestPermission({ mode: "readwrite" })
      .catch(() => "denied");
    if (permission === "granted") {
      setNeedsReconnect(false);
      await openProject(new FolderStore(handle), `Reconnected to ${handle.name}`);
    } else {
      say("Folder access was declined.");
    }
  }, [openProject, say]);

  const useBrowserStorage = useCallback(async () => {
    await openProject(new BrowserStore(), "Switched to browser storage");
  }, [openProject]);

  /* ----------------------------------------------------------- import */

  const runImport = useCallback(
    (file: File) => {
      if (!boot) return;
      setImportDone(false);
      setImportProgress({ ...emptyProgress(), bytesTotal: file.size });

      const worker = new Worker(new URL("./worker/import.worker.ts", import.meta.url), {
        type: "module",
      });

      worker.onmessage = async (event: MessageEvent<any>) => {
        const { type, progress, message } = event.data;
        if (type === "progress") {
          setImportProgress(progress);
          return;
        }
        if (type === "error") {
          setImportProgress({ ...progress, phase: "error", message });
          setImportDone(true);
          worker.terminate();
          return;
        }
        setImportProgress(progress);
        setImportDone(true);
        // terminate only after the project has been read back, so a worker
        // thread is never killed while it still owns pending storage work
        const scene = await openProject(boot.store, `Opened ${file.name}`);
        worker.terminate();
        const handle = pendingHandleRef.current;
        pendingHandleRef.current = null;
        if (scene && handle) {
          // the opened file is now where this board is saved
          const meta = { version: getSceneVersion(scene.elements), lastModified: file.lastModified };
          fileHandleRef.current = handle;
          fileMetaRef.current = meta;
          await idbPut(KV_STORE, FILE_KEY, handle).catch(() => {});
          await idbPut(KV_STORE, FILE_META_KEY, meta).catch(() => {});
          setFileName(handle.name);
          setFileAccess("granted");
          setFileState("clean");
          setFileSavedAt(null);
        }
      };

      worker.onerror = (event) => {
        setImportProgress((current) => ({
          ...(current ?? emptyProgress()),
          phase: "error",
          message: event.message || "Import worker crashed",
        }));
        setImportDone(true);
      };

      worker.postMessage({ blob: file, ref: refForStore(boot.store), options });
    },
    [boot, openProject, options],
  );

  const onPickFile = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (file) runImport(file);
    },
    [runImport],
  );

  /* ------------------------------------------------- the single file */

  /** Has the linked file been rewritten by something else since we last wrote or read it? */
  const fileChangedElsewhere = useCallback(async (handle: FileSystemFileHandle) => {
    const meta = fileMetaRef.current;
    if (!meta) return false;
    const file = await handle.getFile();
    return file.lastModified > meta.lastModified + 1000;
  }, []);

  /**
   * Writes the whole board (scene + every image it uses) to one .excalidraw
   * file, streamed one image at a time. Ctrl+S saves to the linked file,
   * Ctrl+Shift+S (or the first save) asks where. Browsers without file access
   * download the file instead.
   */
  const saveFile = useCallback(
    async ({ as = false, auto = false }: { as?: boolean; auto?: boolean } = {}) => {
      const api = apiRef.current;
      if (!api || !boot) return;
      if (fileWritingRef.current) {
        if (!auto) say("A save to the file is already running");
        return;
      }
      if (fileTimerRef.current !== null) {
        window.clearTimeout(fileTimerRef.current);
        fileTimerRef.current = null;
      }
      void doSave({ manual: !auto }); // the browser copy follows along

      const elements = api.getSceneElements();
      const version = getSceneVersion(elements);
      const source = boardSource(boot.store, indexRef.current, elements, api.getAppState(), api.getFiles());
      const progress = (done: number, total: number) => {
        if (done % 10 === 0 || done === total) setFileProgress({ done, total });
      };

      if (!canPickFiles) {
        if (auto) return;
        setBusy({ title: "Preparing the file" });
        try {
          const { blob, missing } = await buildSceneBlob(source, progress);
          downloadBlob(blob, fileName ?? "blueprince.excalidraw");
          say(`Downloaded ${formatBytes(blob.size)}${missing.length ? `, ${missing.length} image(s) missing` : ""}`);
        } catch (err) {
          say(`Could not build the file: ${errorText(err)}`);
        } finally {
          setBusy(null);
          setFileProgress(null);
        }
        return;
      }

      let handle = as ? null : fileHandleRef.current;
      try {
        if (handle) {
          let access = await (handle as any).queryPermission({ mode: "readwrite" });
          if (access !== "granted") {
            if (auto) {
              setFileAccess("prompt");
              return;
            }
            access = await (handle as any).requestPermission({ mode: "readwrite" });
            if (access !== "granted") {
              say("Access to the file was declined, nothing was written");
              return;
            }
            setFileAccess("granted");
          }
          if (await fileChangedElsewhere(handle)) {
            if (auto) {
              setFileState("error");
              if (!conflictWarnedRef.current) {
                conflictWarnedRef.current = true;
                say(`${handle.name} was changed outside this tab: press Ctrl+S to choose what to keep`);
              }
              return;
            }
            const overwrite = window.confirm(
              `${handle.name} was changed outside this tab since it was last saved here.\n\n` +
                "Overwrite it with the board on screen?",
            );
            if (!overwrite) return;
          }
        } else {
          if (auto) return;
          handle = await (window as any).showSaveFilePicker({
            id: "blueprincedraw-file",
            suggestedName: fileName ?? "blueprince.excalidraw",
            types: FILE_TYPES,
          });
        }
      } catch (err: any) {
        if (err?.name !== "AbortError") say(`Could not open the file: ${errorText(err)}`);
        return;
      }
      if (!handle) return;

      fileWritingRef.current = true;
      setFileState("writing");
      if (!auto) setBusy({ title: "Saving", detail: handle.name });
      try {
        const result = await writeToFileHandle(handle, source, progress);
        conflictWarnedRef.current = false;
        const meta = { version, lastModified: result.lastModified };
        fileHandleRef.current = handle;
        fileMetaRef.current = meta;
        await idbPut(KV_STORE, FILE_KEY, handle);
        await idbPut(KV_STORE, FILE_META_KEY, meta);
        setFileName(handle.name);
        setFileAccess("granted");
        setFileSavedAt(Date.now());
        const stillSame = getSceneVersion(apiRef.current?.getSceneElements() ?? elements) === version;
        setFileState(stillSame ? "clean" : "dirty");
        if (result.missing.length) {
          say(`Saved, but ${result.missing.length} image(s) could not be found and were left out`);
        } else if (!auto) {
          say(
            result.bytes > MAX_STRING_LENGTH
              ? `Saved ${formatBytes(result.bytes)}. Above 512 MB only BlueprinceDraw can open it`
              : `Saved ${handle.name} (${formatBytes(result.bytes)})`,
          );
        }
      } catch (err) {
        setFileState("error");
        say(`Saving failed and the previous file is unchanged: ${errorText(err)}`);
      } finally {
        fileWritingRef.current = false;
        setFileProgress(null);
        setBusy(null);
      }
    },
    [boot, doSave, fileChangedElsewhere, fileName, say],
  );
  saveFileRef.current = saveFile;

  /** Before another file replaces the board: offer to save, or stop. Returns false to stop. */
  const readyToReplace = useCallback(async () => {
    if (fileState === "dirty" || fileState === "error") {
      const save = window.confirm(
        `The board on screen has changes that are not in ${fileName ?? "a file"} yet.\n\n` +
          "OK saves them first. Cancel keeps the board open and does nothing.",
      );
      if (!save) return false;
      await saveFile();
    } else if (!fileName && saveState !== "idle") {
      const proceed = window.confirm(
        "The board on screen was never saved to a file. Open another file anyway? " +
          "The current board stays in this browser's storage.",
      );
      if (!proceed) return false;
    }
    return true;
  }, [fileName, fileState, saveFile, saveState]);

  /** Opens a .excalidraw file of any size (streamed) and saves to it from then on. */
  const openFile = useCallback(async () => {
    if (!boot || !(await readyToReplace())) return;
    if (!canPickFiles) {
      pendingHandleRef.current = null;
      fileInputRef.current?.click();
      return;
    }
    try {
      const [handle] = await (window as any).showOpenFilePicker({ id: "blueprincedraw-file", types: FILE_TYPES });
      pendingHandleRef.current = handle;
      runImport(await handle.getFile());
    } catch (err: any) {
      if (err?.name !== "AbortError") say(`Could not open the file: ${errorText(err)}`);
    }
  }, [boot, readyToReplace, runImport, say]);
  const openFileRef = useRef(openFile);
  openFileRef.current = openFile;

  // A .excalidraw dropped on the canvas would otherwise reach Excalidraw's own
  // loader, which reads the whole file as one string (fails above 512 MB).
  useEffect(() => {
    const onDrop = (event: DragEvent) => {
      const file = event.dataTransfer?.files?.[0];
      if (!file || !/\.(excalidraw|json)$/i.test(file.name)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      // must be requested during the event, before any await
      const item = event.dataTransfer?.items?.[0] as any;
      const handlePromise: Promise<any> | null = item?.getAsFileSystemHandle?.() ?? null;
      void (async () => {
        if (!(await readyToReplace())) return;
        const handle = handlePromise ? await handlePromise.catch(() => null) : null;
        pendingHandleRef.current = handle?.kind === "file" ? handle : null;
        runImport(file);
      })();
    };
    window.addEventListener("drop", onDrop, { capture: true });
    return () => window.removeEventListener("drop", onDrop, { capture: true });
  }, [readyToReplace, runImport]);

  /** After a browser restart the file needs one click to grant access again. */
  const reconnectFile = useCallback(async () => {
    const handle = fileHandleRef.current;
    if (!handle) return;
    const access = await (handle as any).requestPermission({ mode: "readwrite" }).catch(() => "denied");
    if (access !== "granted") {
      say("Access to the file was declined");
      return;
    }
    setFileAccess("granted");
    if (await fileChangedElsewhere(handle)) {
      const load = window.confirm(
        `${handle.name} was changed outside this browser (another computer or tab).\n\n` +
          "Open that version? Cancel keeps the board on screen, and the next save overwrites the file.",
      );
      if (load) {
        pendingHandleRef.current = handle;
        runImport(await handle.getFile());
        return;
      }
      // keep ours: accept the outside change as seen, so the next save is not blocked
      const file = await handle.getFile();
      fileMetaRef.current = { version: -1, lastModified: file.lastModified };
      setFileState("dirty");
    }
    say(`Connected to ${handle.name}`);
  }, [fileChangedElsewhere, runImport, say]);

  // Back on the tab: pick up a newer file saved from elsewhere, if nothing here is unsaved.
  useEffect(() => {
    const onFocus = async () => {
      const handle = fileHandleRef.current;
      if (!handle || fileAccess !== "granted" || fileState !== "clean" || saveState === "dirty") return;
      try {
        if (await fileChangedElsewhere(handle)) {
          if (window.confirm(`${handle.name} was updated outside this tab. Load the new version?`)) {
            pendingHandleRef.current = handle;
            runImport(await handle.getFile());
          } else {
            const file = await handle.getFile();
            fileMetaRef.current = { ...(fileMetaRef.current as FileMeta), lastModified: file.lastModified };
          }
        }
      } catch {
        /* file moved or deleted: the next save reports it */
      }
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [fileAccess, fileChangedElsewhere, fileState, runImport, saveState]);

  const prune = useCallback(async () => {
    const api = apiRef.current;
    if (!api || !boot) return;
    setBusy({ title: "Looking for unused images" });
    try {
      const removed = await pruneOrphans(boot.store, api.getSceneElements());
      indexRef.current = await boot.store.readIndex();
      await refreshStats(boot.store);
      say(removed ? `Removed ${removed} unused image${removed === 1 ? "" : "s"}` : "No unused images");
    } catch (err) {
      say(`Cleanup failed: ${errorText(err)}`);
    } finally {
      setBusy(null);
    }
  }, [boot, refreshStats, say]);

  const toggleTranscode = useCallback(async () => {
    const next = { ...options, transcode: !options.transcode };
    setOptions(next);
    await idbPut(KV_STORE, OPTIONS_KEY, next).catch(() => {});
    say(
      next.transcode
        ? "New images will be re-encoded to WebP"
        : "New images will be stored in their original format",
    );
  }, [options, say]);

  /* -------------------------------------------------------------- view */

  const initialData = useMemo(() => {
    if (!boot) return null;
    return {
      elements: boot.scene.elements,
      appState: { ...boot.scene.appState, collaborators: new Map() },
      files: boot.scene.files,
      scrollToContent: !boot.scene.appState.zoom,
    };
  }, [boot]);

  const savedLabel =
    saveState === "saving"
      ? "Saving…"
      : saveState === "dirty"
        ? "Unsaved changes"
        : saveState === "error"
          ? "Save failed"
          : saveState === "saved"
            ? "All changes saved"
            : "Ready";

  if (bootError) {
    return (
      <div className="bpd-overlay">
        <div className="bpd-panel">
          <h2>Could not open the project</h2>
          <p className="bpd-error">{bootError}</p>
          <button className="bpd-button" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      </div>
    );
  }

  const kind = boot?.store.kind;

  return (
    <div className="bpd-root">
      <input
        ref={fileInputRef}
        type="file"
        // .txt included so clipboard dumps ("type":"excalidraw/clipboard") can
        // be picked too; the reader walks keys and does not care about the type
        accept=".excalidraw,.json,.txt,application/json,text/plain"
        onChange={onPickFile}
        style={{ display: "none" }}
        data-testid="import-input"
      />

      {initialData && boot ? (
        <Excalidraw
          key={boot.epoch}
          excalidrawAPI={(instance: any) => {
            apiRef.current = instance;
            setApi(instance);
            // debugging aid: lets a test driver inspect the live editor and
            // build an export without triggering a download
            (window as any).__bpd = {
              api: instance,
              boot,
              index: indexRef.current,
              selfTest: () => import("./dev/selftest.ts").then((m) => m.folderSelfTest()),
              /** save to any FileSystemFileHandle (e.g. one in OPFS) exactly like Ctrl+S does */
              writeTo: (handle: FileSystemFileHandle) =>
                writeToFileHandle(
                  handle,
                  boardSource(
                    boot.store,
                    indexRef.current,
                    instance.getSceneElements(),
                    instance.getAppState(),
                    instance.getFiles(),
                  ),
                ),
              /** open a File/Blob exactly like Open… does (streamed import) */
              openBlob: (blob: File) => runImport(blob),
              buildFile: () =>
                buildSceneBlob(
                  boardSource(
                    boot.store,
                    indexRef.current,
                    instance.getSceneElements(),
                    instance.getAppState(),
                    instance.getFiles(),
                  ),
                ),
            };
          }}
          initialData={initialData as any}
          onChange={handleChange as any}
          name="BlueprinceDraw"
        >
          <MainMenu>
            <MainMenu.Item onSelect={() => void openFile()} shortcut="Ctrl+O">
              Open…
            </MainMenu.Item>
            <MainMenu.Item onSelect={() => void saveFile()} shortcut="Ctrl+S">
              {canPickFiles ? "Save" : "Save (download)"}
            </MainMenu.Item>
            {canPickFiles ? (
              <MainMenu.Item onSelect={() => void saveFile({ as: true })} shortcut="Ctrl+Shift+S">
                Save as…
              </MainMenu.Item>
            ) : null}
            <MainMenu.Separator />
            <MainMenu.Item onSelect={() => void chooseFolder()}>
              Keep a working copy in a folder…
            </MainMenu.Item>
            {kind === "folder" ? (
              <MainMenu.Item onSelect={() => void useBrowserStorage()}>
                Switch to browser storage
              </MainMenu.Item>
            ) : null}
            <MainMenu.Separator />
            <MainMenu.Item onSelect={() => void toggleTranscode()}>
              {options.transcode ? "✓ " : ""}Compress images to WebP
            </MainMenu.Item>
            <MainMenu.Item onSelect={() => void prune()}>Remove unused images</MainMenu.Item>
            <MainMenu.Separator />
            <MainMenu.DefaultItems.ToggleTheme />
            <MainMenu.DefaultItems.ChangeCanvasBackground />
          </MainMenu>

          <Footer>
            <div className="bpd-status" data-testid="status-bar">
              <span className={`bpd-dot bpd-dot-${saveState}`} />
              <span>{savedLabel}</span>
              <span className="bpd-sep">·</span>
              <span title={kind === "folder" ? "Folder project" : "Browser storage"}>
                {kind === "folder" ? "📁" : "🗄"} {boot.store.label}
              </span>
              <span className="bpd-sep">·</span>
              <span>
                {stats.fileCount} image{stats.fileCount === 1 ? "" : "s"} ·{" "}
                {formatBytes(stats.fileBytes)}
              </span>
              {imageLoad ? (
                <>
                  <span className="bpd-sep">·</span>
                  <span data-testid="image-progress">
                    loading images {imageLoad.done}/{imageLoad.total}
                  </span>
                </>
              ) : null}
              <span className="bpd-sep">·</span>
              <span data-testid="file-status" title="The .excalidraw file this board is saved to">
                📄{" "}
                {fileState === "none"
                  ? "not saved to a file yet (Ctrl+S)"
                  : `${fileName}: ${
                      fileState === "writing"
                        ? fileProgress
                          ? `saving ${fileProgress.done}/${fileProgress.total}`
                          : "saving…"
                        : fileState === "dirty"
                          ? "unsaved changes"
                          : fileState === "error"
                            ? "not saved"
                            : fileSavedAt
                              ? `saved ${new Date(fileSavedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
                              : "saved"
                    }`}
              </span>
              {fileName && fileAccess === "prompt" ? (
                <button className="bpd-link" onClick={() => void reconnectFile()}>
                  Allow saving to the file
                </button>
              ) : null}
              {needsReconnect ? (
                <button className="bpd-link" onClick={() => void reconnectFolder()}>
                  Reconnect folder
                </button>
              ) : null}
            </div>
          </Footer>
        </Excalidraw>
      ) : null}

      {busy ? <BusyOverlay title={busy.title} detail={busy.detail} /> : null}

      {importProgress ? (
        <ProgressOverlay
          title={importDone ? "File opened" : "Opening file"}
          progress={importProgress}
          note={
            importDone
              ? undefined
              : "The file is streamed in chunks and never loaded into memory whole."
          }
          onDismiss={importDone ? () => setImportProgress(null) : undefined}
        />
      ) : null}

      {toast ? <div className="bpd-toast">{toast}</div> : null}
    </div>
  );
}

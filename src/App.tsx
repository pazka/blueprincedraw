import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Excalidraw, Footer, MainMenu, getSceneVersion } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";

import { BrowserStore, FolderStore, refForStore, type Store } from "./lib/store.ts";
import { KV_STORE, idbGet, idbPut, requestPersistence } from "./lib/idb.ts";
import {
  buildClassicExport,
  copyProject,
  downloadBlob,
  estimateClassicExport,
  imageLoadOrder,
  loadProject,
  pruneOrphans,
  saveProject,
  streamImages,
  syncNewFiles,
  type EditorScene,
} from "./lib/project.ts";
import { DEFAULT_MAX_DIMENSION, DEFAULT_QUALITY, formatBytes } from "./lib/images.ts";
import { BusyOverlay, ProgressOverlay } from "./ui/Overlay.tsx";
import type { FileIndex, ImportOptions, ImportProgress } from "./types.ts";

const AUTOSAVE_MS = 1500;
const BACKUP_EVERY_MS = 5 * 60 * 1000;
const HANDLE_KEY = "projectDirHandle";
const OPTIONS_KEY = "imageOptions";

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

  const apiRef = useRef<any>(null);
  const indexRef = useRef<FileIndex>({});
  const timerRef = useRef<number | null>(null);
  const savingRef = useRef(false);
  const syncingRef = useRef(false);
  const lastBackupRef = useRef(0);
  const savedVersionRef = useRef<number | null>(null);
  const epochRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
        indexRef.current = scene.index;
        savedVersionRef.current = getSceneVersion(scene.elements);
        epochRef.current += 1;
        apiRef.current = null;
        setApi(null);
        setBoot({ store, scene, epoch: epochRef.current });
        setSaveState(scene.savedAt ? "saved" : "idle");
        await refreshStats(store);
        if (note) say(note);
      } catch (err) {
        setBootError(errorText(err));
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
    await openProject(store);
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
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void doSave({ manual: true });
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [doSave]);

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (saveState === "dirty" || saveState === "saving") {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [saveState]);

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
        await openProject(boot.store, `Imported ${file.name}`);
        worker.terminate();
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

  /* ----------------------------------------------------------- export */

  const exportClassic = useCallback(async () => {
    const api = apiRef.current;
    if (!api || !boot) return;
    const elements = api.getSceneElements();
    const estimate = estimateClassicExport(
      indexRef.current,
      JSON.stringify(elements).length,
    );
    if (
      !estimate.safe &&
      !window.confirm(
        `This export is about ${formatBytes(estimate.bytes)}.\n\n` +
          "Files above ~512 MB cannot be reopened by excalidraw.com or by any " +
          "other browser-based editor. That is a hard limit on JavaScript " +
          "string length, not a bug.\n\nBlueprinceDraw can still reopen it. Export anyway?",
      )
    ) {
      return;
    }

    setBusy({ title: "Building .excalidraw export" });
    try {
      const blob = await buildClassicExport(
        boot.store,
        elements,
        api.getAppState(),
        indexRef.current,
        (done, total) => {
          if (done % 25 === 0) {
            setBusy({ title: "Building .excalidraw export", detail: `Image ${done}/${total}` });
          }
        },
      );
      const stamp = new Date().toISOString().slice(0, 10);
      downloadBlob(blob, `blueprincedraw-${stamp}.excalidraw`);
      say(`Exported ${formatBytes(blob.size)}`);
    } catch (err) {
      say(`Export failed: ${errorText(err)}`);
    } finally {
      setBusy(null);
    }
  }, [boot, say]);

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
              buildExport: () =>
                buildClassicExport(
                  boot.store,
                  instance.getSceneElements(),
                  instance.getAppState(),
                  indexRef.current,
                ),
            };
          }}
          initialData={initialData as any}
          onChange={handleChange as any}
          name="BlueprinceDraw"
        >
          <MainMenu>
            <MainMenu.Item onSelect={() => void doSave({ manual: true })}>
              Save now (Ctrl+S)
            </MainMenu.Item>
            <MainMenu.Item onSelect={() => fileInputRef.current?.click()}>
              Import .excalidraw (any size)…
            </MainMenu.Item>
            <MainMenu.Item onSelect={() => void exportClassic()}>
              Export .excalidraw…
            </MainMenu.Item>
            <MainMenu.Separator />
            <MainMenu.Item onSelect={() => void chooseFolder()}>
              Use a project folder…
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
          title={importDone ? "Import finished" : "Importing scene"}
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

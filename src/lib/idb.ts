/** Minimal IndexedDB helper. Hand-rolled rather than pulled from npm so the
 *  app keeps a small, auditable dependency surface. */

export const DB_NAME = "blueprincedraw";
export const DB_VERSION = 1;
export const KV_STORE = "kv";
export const FILE_STORE = "files";

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(KV_STORE)) db.createObjectStore(KV_STORE);
      if (!db.objectStoreNames.contains(FILE_STORE)) db.createObjectStore(FILE_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(
  store: string,
  mode: IDBTransactionMode,
  run: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = run(t.objectStore(store));
        let result: T;
        req.onsuccess = () => {
          result = req.result;
        };
        req.onerror = () => reject(req.error);
        // Resolve on transaction completion, not on request success. A request
        // succeeds before its transaction commits, so resolving early would let
        // a caller act (or a worker be terminated) while the write is still
        // uncommitted, silently losing it.
        t.oncomplete = () => resolve(result);
        t.onabort = () => reject(t.error ?? new Error("IndexedDB transaction aborted"));
        t.onerror = () => reject(t.error ?? new Error("IndexedDB transaction failed"));
      }),
  );
}

export const idbGet = <T>(store: string, key: IDBValidKey) =>
  tx<T>(store, "readonly", (s) => s.get(key) as IDBRequest<T>);

export const idbPut = (store: string, key: IDBValidKey, value: unknown) =>
  tx(store, "readwrite", (s) => s.put(value, key));

export const idbDelete = (store: string, key: IDBValidKey) =>
  tx(store, "readwrite", (s) => s.delete(key));

export const idbKeys = (store: string) =>
  tx<IDBValidKey[]>(store, "readonly", (s) => s.getAllKeys());

export const idbClear = (store: string) => tx(store, "readwrite", (s) => s.clear());

/** Ask the browser to keep this origin's data out of the eviction pool. */
export async function requestPersistence(): Promise<boolean> {
  if (!navigator.storage?.persist) return false;
  if (await navigator.storage.persisted()) return true;
  return navigator.storage.persist();
}

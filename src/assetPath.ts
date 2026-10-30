/** Serve Excalidraw's fonts and locales from this app instead of a CDN, so the
 *  editor works with no network at all. Must be evaluated before the
 *  @excalidraw/excalidraw module is imported. */
declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string;
  }
}

// Must be an absolute URL: Excalidraw 0.18 resolves font URLs with
// `new URL(path, EXCALIDRAW_ASSET_PATH)`, and a bare "/" silently falls back
// to its CDN (esm.sh), which the CSP blocks by design.
window.EXCALIDRAW_ASSET_PATH = `${window.location.origin}/`;

export {};

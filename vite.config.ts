import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Excalidraw lists a second source for every font: its CDN (esm.sh). The app
 * serves all fonts itself, and the CSP forbids third-party hosts, so that
 * fallback could only produce ~230 CSP errors per page load. Point it at a
 * same-origin path that does not exist instead: nothing ever leaves the site.
 */
function noExcalidrawCdn(): Plugin {
  const CDN = "`https://esm.sh/${";
  return {
    name: "no-excalidraw-cdn",
    enforce: "pre",
    transform(code, id) {
      if (!id.includes("@excalidraw/excalidraw") || !code.includes(CDN)) return null;
      return { code: code.replaceAll(CDN, "`${globalThis.location?.origin ?? \"\"}/no-cdn/${"), map: null };
    },
  };
}

export default defineConfig({
  plugins: [noExcalidrawCdn(), react()],
  define: {
    // required by @excalidraw/excalidraw when bundled outside its own monorepo
    "process.env.IS_PREACT": JSON.stringify("false"),
  },
  server: { port: 4270, strictPort: true },
  preview: { port: 4270, strictPort: true },
  build: { chunkSizeWarningLimit: 4096, sourcemap: false },
});

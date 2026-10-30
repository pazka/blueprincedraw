// Copies Excalidraw's fonts and locales into public/ so the app serves them
// itself (no CDN). Run before every build; public/fonts and public/locales are
// generated, hence gitignored.
import { cp, rm } from "node:fs/promises";

const src = new URL("../node_modules/@excalidraw/excalidraw/dist/prod/", import.meta.url);
for (const dir of ["fonts", "locales"]) {
  const target = new URL(`../public/${dir}/`, import.meta.url);
  await rm(target, { recursive: true, force: true });
  await cp(new URL(`${dir}/`, src), target, { recursive: true });
}
console.log("copied excalidraw fonts + locales into public/");

// Visual use cases of blueprincedraw (hosh-management AGENTS.md section 3), listed in TESTING.md
// "Visual use cases". Every case is shot at the 3 widths, each in a fresh browser context (empty IndexedDB:
// a first-time visitor). Nothing is ever sent to the server: the board is opened in the page exactly like
// Open… does (window.__bpd.openBlob, the streamed importer), from the fixed board built below.
// The fixture is built in code on purpose: the repo never holds a .excalidraw file (CLAUDE.md).
import { deflateSync } from "node:zlib";
import { setTimeout as sleep } from "node:timers/promises";

export const WIDTHS = [1400, 1024, 390];

/** A small, fixed PNG (Node built-ins): a 4-colour 32x32 checker, so the image element shows real pixels. */
function png() {
  const w = 32, h = 32, rows = [];
  const colours = [[214, 69, 65], [52, 120, 198], [240, 196, 25], [60, 160, 90]];
  for (let y = 0; y < h; y++) {
    const row = [0];
    for (let x = 0; x < w; x++) row.push(...colours[(x >> 4) + 2 * (y >> 4)]);
    rows.push(Buffer.from(row));
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0)),
  ]);
}

const T = 1767225600000; // 2026-01-01T00:00:00Z: every timestamp of the fixture
const base = (id, type, x, y, width, height, extra = {}) => ({
  id, type, x, y, width, height, angle: 0, strokeColor: "#1e1e1e", backgroundColor: "transparent",
  fillStyle: "solid", strokeWidth: 2, strokeStyle: "solid", roughness: 1, opacity: 100, groupIds: [],
  frameId: null, roundness: null, seed: 1000 + id.length * 7, version: 1, versionNonce: 1, isDeleted: false,
  boundElements: null, updated: T, link: null, locked: false, index: null, ...extra,
});

/** The fixed board: a room grid (rectangles), a label, an arrow, an ellipse and one image. */
export const BOARD = {
  type: "excalidraw", version: 2, source: "https://excalidraw.hosh.it",
  elements: [
    base("room-a", "rectangle", 0, 0, 220, 160, { backgroundColor: "#a5d8ff", seed: 11 }),
    base("room-b", "rectangle", 260, 0, 220, 160, { backgroundColor: "#b2f2bb", seed: 12 }),
    base("room-c", "rectangle", 0, 200, 480, 140, { backgroundColor: "#ffec99", seed: 13 }),
    base("label", "text", 20, 20, 180, 25, {
      seed: 14, text: "Entrance Hall", originalText: "Entrance Hall", fontSize: 20, fontFamily: 5,
      textAlign: "left", verticalAlign: "top", containerId: null, lineHeight: 1.25, autoResize: true,
    }),
    base("link", "arrow", 230, 80, 30, 0, {
      seed: 15, points: [[0, 0], [30, 0]], lastCommittedPoint: null, startBinding: null, endBinding: null,
      startArrowhead: null, endArrowhead: "arrow", elbowed: false,
    }),
    base("well", "ellipse", 300, 220, 120, 100, { backgroundColor: "#ffc9c9", seed: 16 }),
    base("shot", "image", 40, 220, 96, 96, { seed: 17, fileId: "fixture-image-1", status: "saved", scale: [1, 1], crop: null }),
  ],
  appState: { viewBackgroundColor: "#ffffff", gridSize: 20 },
  files: {
    "fixture-image-1": {
      id: "fixture-image-1", mimeType: "image/png", created: T, lastRetrieved: T,
      dataURL: "data:image/png;base64," + png().toString("base64"),
    },
  },
};

const ready = "!!window.__bpd && !!document.querySelector('.excalidraw canvas') && !document.querySelector('.bpd-overlay')";

/** The editor is up, the browser copy is saved, no toast is showing and nothing moves any more.
 * (On a phone Excalidraw shows no footer, so there is no status bar to read there.) */
async function settled(p) {
  if (!(await p.waitFor(ready, 30000))) throw new Error("the editor did not start");
  if (!(await p.waitFor("!/Saving|Unsaved|loading images/.test(document.querySelector('[data-testid=status-bar]')?.innerText || '')", 20000))) {
    throw new Error("the status bar did not settle");
  }
  if (!(await p.waitFor("!document.querySelector('.bpd-toast')", 10000))) throw new Error("a toast stayed on screen");
  await sleep(300);
}

async function click(p, selector, what) {
  const ok = await p.evaluate(`(() => { const e = ${selector}; if (!e) return false; e.click(); return true; })()`);
  if (!ok) throw new Error(`nothing to click: ${what}`);
  await sleep(300);
}

const menu = (label) => `[...document.querySelectorAll('.dropdown-menu-item')].find((e) => e.innerText.trim().startsWith(${JSON.stringify(label)}))`;

/** Opens the fixed board like Open… does, and waits for the "File opened" panel. */
async function openBoard(p) {
  await settled(p);
  await p.evaluate(`(async () => {
    const file = new File([${JSON.stringify(JSON.stringify(BOARD))}], "fixture.excalidraw", { type: "application/json" });
    window.__bpd.openBlob(file);
    return true;
  })()`);
  if (!(await p.waitFor("/File opened/.test(document.querySelector('.bpd-overlay h2')?.innerText || '')", 30000))) {
    throw new Error("the board did not open");
  }
  // the "Opened …" toast leaves after 4 s; the panel stays until Close
  if (!(await p.waitFor("!document.querySelector('.bpd-toast')", 10000))) throw new Error("a toast stayed on screen");
}

async function board(p) {
  await openBoard(p);
  await click(p, "document.querySelector('.bpd-overlay .bpd-button')", "Close");
  await settled(p);
  // the image is in the editor (every width) and counted as stored (status bar, desktop and laptop)
  if (!(await p.waitFor("!!window.__bpd.api.getFiles()['fixture-image-1'] && (!document.querySelector('[data-testid=status-bar]') || /1 image/.test(document.querySelector('[data-testid=status-bar]').innerText))", 20000))) {
    throw new Error("the image of the board was not stored");
  }
  // the same view at every run: the whole board in the window
  await p.evaluate("(() => { const a = window.__bpd.api; a.scrollToContent(a.getSceneElements(), { fitToViewport: true, viewportZoomFactor: 0.7, animate: false }); return true; })()");
  await sleep(500);
}

export const CASES = [
  // a first visit: empty board in browser storage
  { id: "E1-empty", path: "/", steps: settled },
  { id: "E2-menu-open", path: "/", steps: async (p) => { await settled(p); await click(p, "document.querySelector('[data-testid=main-menu-trigger]')", "main menu"); } },
  {
    // the "?" shortcut: the help button is not on the phone layout
    id: "E3-help", path: "/",
    css: ".Modal__content { opacity: 1 !important; transform: none !important; }",
    steps: async (p) => {
      await settled(p);
      await p.evaluate("(() => { document.querySelector('.excalidraw').dispatchEvent(new KeyboardEvent('keydown', { key: '?', code: 'Slash', shiftKey: true, bubbles: true })); return true; })()");
      if (!(await p.waitFor("!!document.querySelector('.HelpDialog')", 5000))) throw new Error("help did not open");
      await sleep(300);
    },
  },
  // a board opened from a .excalidraw file (Open…)
  { id: "B1-file-opened", path: "/", steps: openBoard },
  { id: "B2-board", path: "/", steps: board },
  {
    id: "B3-board-selected", path: "/",
    steps: async (p) => {
      await board(p);
      await p.evaluate("(() => { window.__bpd.api.updateScene({ appState: { selectedElementIds: { 'room-b': true } } }); return true; })()");
      await sleep(500);
    },
  },
  {
    id: "B4-board-dark", path: "/",
    steps: async (p) => {
      await board(p);
      await click(p, "document.querySelector('[data-testid=main-menu-trigger]')", "main menu");
      await click(p, menu("Dark mode"), "Dark mode");
      // the phone menu stays open after a choice: close it like a visitor would
      if (await p.evaluate("!!document.querySelector('.dropdown-menu')")) {
        await click(p, "document.querySelector('[data-testid=main-menu-trigger]')", "main menu (close)");
      }
      if (!(await p.waitFor("document.querySelector('.excalidraw').classList.contains('theme--dark')", 5000))) throw new Error("dark mode did not apply");
    },
  },
];

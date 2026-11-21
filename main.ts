// VELMORA — The Floating Isles
// A travel poster for a place that does not exist.
// Pure Node 22 stdlib: rasterizes a 1024x1024 poster and writes /output/entry.png.
// No network, no dependencies, fully deterministic (seeded randomness).

import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const W = 1024;
const H = 1024;
const buf = new Uint8Array(W * H * 3);

type RGB = [number, number, number];

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function hex(h: string): RGB {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function mix(c1: RGB, c2: RGB, t: number): RGB {
  return [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];
}

// Deterministic pseudo-random generator so every run paints the same poster.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Blend a colour onto one pixel with alpha 0..1.
function put(x: number, y: number, c: RGB, a: number): void {
  const xi = Math.round(x);
  const yi = Math.round(y);
  if (xi < 0 || xi >= W || yi < 0 || yi >= H || a <= 0) return;
  const i = (yi * W + xi) * 3;
  if (a >= 1) {
    buf[i] = c[0];
    buf[i + 1] = c[1];
    buf[i + 2] = c[2];
    return;
  }
  buf[i] = lerp(buf[i], c[0], a);
  buf[i + 1] = lerp(buf[i + 1], c[1], a);
  buf[i + 2] = lerp(buf[i + 2], c[2], a);
}

function fillRect(x0: number, y0: number, x1: number, y1: number, c: RGB, a: number): void {
  const xa = Math.max(0, Math.floor(x0));
  const xb = Math.min(W - 1, Math.ceil(x1));
  const ya = Math.max(0, Math.floor(y0));
  const yb = Math.min(H - 1, Math.ceil(y1));
  for (let y = ya; y <= yb; y++) {
    const row = y * W * 3;
    for (let x = xa; x <= xb; x++) {
      const i = row + x * 3;
      buf[i] = lerp(buf[i], c[0], a);
      buf[i + 1] = lerp(buf[i + 1], c[1], a);
      buf[i + 2] = lerp(buf[i + 2], c[2], a);
    }
  }
}

// Vertical gradient between y0 and y1 through colour stops [position 0..1, colour].
function vGradient(y0: number, y1: number, stops: [number, RGB][]): void {
  for (let y = y0; y < y1; y++) {
    const t = (y - y0) / (y1 - y0);
    let c: RGB = stops[stops.length - 1][1];
    for (let s = 0; s < stops.length - 1; s++) {
      if (t >= stops[s][0] && t <= stops[s + 1][0]) {
        const lt = (t - stops[s][0]) / (stops[s + 1][0] - stops[s][0]);
        c = mix(stops[s][1], stops[s + 1][1], lt);
        break;
      }
    }
    const row = y * W * 3;
    for (let x = 0; x < W; x++) {
      buf[row + x * 3] = c[0];
      buf[row + x * 3 + 1] = c[1];
      buf[row + x * 3 + 2] = c[2];
    }
  }
}

// Soft-edged filled disc.
function disc(cx: number, cy: number, r: number, c: RGB, a: number, soft = 1): void {
  const x0 = Math.max(0, Math.floor(cx - r - soft - 1));
  const x1 = Math.min(W - 1, Math.ceil(cx + r + soft + 1));
  const y0 = Math.max(0, Math.floor(cy - r - soft - 1));
  const y1 = Math.min(H - 1, Math.ceil(cy + r + soft + 1));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x - cx, y - cy);
      const cov = d <= r ? 1 : clamp(1 - (d - r) / soft, 0, 1);
      if (cov > 0) put(x, y, c, a * cov);
    }
  }
}

// Radial glow: alpha falls off quadratically with distance.
function glow(cx: number, cy: number, r: number, c: RGB, a: number): void {
  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(W - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(H - 1, Math.ceil(cy + r));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x - cx, y - cy) / r;
      if (d >= 1) continue;
      put(x, y, c, a * (1 - d) * (1 - d));
    }
  }
}

// Soft-edged filled ellipse.
function ellipse(cx: number, cy: number, rx: number, ry: number, c: RGB, a: number): void {
  const x0 = Math.max(0, Math.floor(cx - rx - 2));
  const x1 = Math.min(W - 1, Math.ceil(cx + rx + 2));
  const y0 = Math.max(0, Math.floor(cy - ry - 2));
  const y1 = Math.min(H - 1, Math.ceil(cy + ry + 2));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const v = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
      if (v > 1.44) continue;
      const d = Math.sqrt(v);
      const cov = d <= 1 ? 1 : clamp(1 - (d - 1) * 6, 0, 1);
      if (cov > 0) put(x, y, c, a * cov);
    }
  }
}

// Scanline polygon fill (even-odd), alpha-blended.
function poly(pts: [number, number][], c: RGB, a: number): void {
  let ymin = Infinity;
  let ymax = -Infinity;
  for (const [, y] of pts) {
    ymin = Math.min(ymin, y);
    ymax = Math.max(ymax, y);
  }
  for (let y = Math.ceil(ymin); y <= Math.floor(ymax); y++) {
    if (y < 0 || y >= H) continue;
    const xs: number[] = [];
    for (let i = 0; i < pts.length; i++) {
      const [x1, y1] = pts[i];
      const [x2, y2] = pts[(i + 1) % pts.length];
      if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) {
        xs.push(x1 + ((y - y1) * (x2 - x1)) / (y2 - y1));
      }
    }
    xs.sort((p, q) => p - q);
    const row = y * W * 3;
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xa = Math.max(0, Math.ceil(xs[k]));
      const xb = Math.min(W - 1, Math.floor(xs[k + 1]));
      for (let x = xa; x <= xb; x++) {
        const i = row + x * 3;
        buf[i] = lerp(buf[i], c[0], a);
        buf[i + 1] = lerp(buf[i + 1], c[1], a);
        buf[i + 2] = lerp(buf[i + 2], c[2], a);
      }
    }
  }
}

// Thick line segment with round caps, anti-aliased.
function seg(x1: number, y1: number, x2: number, y2: number, w: number, c: RGB, a: number): void {
  const r = w / 2;
  const xa = Math.floor(Math.min(x1, x2) - r - 1);
  const xb = Math.ceil(Math.max(x1, x2) + r + 1);
  const ya = Math.floor(Math.min(y1, y2) - r - 1);
  const yb = Math.ceil(Math.max(y1, y2) + r + 1);
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  for (let y = ya; y <= yb; y++) {
    for (let x = xa; x <= xb; x++) {
      let t = len2 === 0 ? 0 : ((x - x1) * dx + (y - y1) * dy) / len2;
      t = clamp(t, 0, 1);
      const px = x1 + t * dx;
      const py = y1 + t * dy;
      const d = Math.hypot(x - px, y - py);
      const cov = clamp(r + 0.6 - d, 0, 1);
      if (cov > 0) put(x, y, c, a * cov);
    }
  }
}

// ---------------------------------------------------------------------------
// Stroke typeface: single-stroke geometric capitals on a 5 x 7 grid.
// Each glyph is a list of polylines; each point is [x, y] in grid units.
// Authored for this poster so the name reads as set type, not an overlay.
// ---------------------------------------------------------------------------
type Pt = [number, number];
const GLYPHS: Record<string, Pt[][]> = {
  A: [[[0, 6], [2, 0], [4, 6]], [[1, 4], [3, 4]]],
  B: [[[0, 0], [0, 6]], [[0, 0], [3, 0], [4, 1], [4, 2], [3, 3], [0, 3]], [[0, 3], [3, 3], [4, 4], [4, 5], [3, 6], [0, 6]]],
  C: [[[4, 1], [3, 0], [1, 0], [0, 1], [0, 5], [1, 6], [3, 6], [4, 5]]],
  D: [[[0, 0], [0, 6]], [[0, 0], [3, 0], [4, 1], [4, 5], [3, 6], [0, 6]]],
  E: [[[0, 0], [0, 6]], [[0, 0], [4, 0]], [[0, 3], [3, 3]], [[0, 6], [4, 6]]],
  F: [[[0, 0], [0, 6]], [[0, 0], [4, 0]], [[0, 3], [3, 3]]],
  G: [[[4, 1], [3, 0], [1, 0], [0, 1], [0, 5], [1, 6], [3, 6], [4, 5], [4, 3], [2.5, 3]]],
  H: [[[0, 0], [0, 6]], [[4, 0], [4, 6]], [[0, 3], [4, 3]]],
  I: [[[2, 0], [2, 6]], [[0.5, 0], [3.5, 0]], [[0.5, 6], [3.5, 6]]],
  L: [[[0, 0], [0, 6]], [[0, 6], [4, 6]]],
  M: [[[0, 6], [0, 0], [2, 3], [4, 0], [4, 6]]],
  N: [[[0, 6], [0, 0], [4, 6], [4, 0]]],
  O: [[[1, 0], [3, 0], [4, 1], [4, 5], [3, 6], [1, 6], [0, 5], [0, 1], [1, 0]]],
  R: [[[0, 0], [0, 6]], [[0, 0], [3, 0], [4, 1], [4, 2], [3, 3], [0, 3]], [[2, 3], [4, 6]]],
  S: [[[4, 1], [3, 0], [1, 0], [0, 1], [0, 2], [1, 3], [3, 3], [4, 4], [4, 5], [3, 6], [1, 6], [0, 5]]],
  T: [[[0, 0], [4, 0]], [[2, 0], [2, 6]]],
  U: [[[0, 0], [0, 5], [1, 6], [3, 6], [4, 5], [4, 0]]],
  V: [[[0, 0], [2, 6], [4, 0]]],
  W: [[[0, 0], [1, 6], [2, 3], [3, 6], [4, 0]]],
  Y: [[[0, 0], [2, 3], [4, 0]], [[2, 3], [2, 6]]],
  "-": [[[0.5, 3], [3.5, 3]]],
  ".": [[[2, 5.6], [2, 6]]],
};

function textWidth(s: string, unit: number, tracking: number): number {
  let w = 0;
  for (const ch of s) w += (ch === " " ? 4 : 5) * unit + tracking;
  return w - tracking;
}

// Draw centred text; y is the top of the cap height.
function drawText(s: string, cx: number, y: number, unit: number, w: number, c: RGB, a: number, tracking = 0): void {
  let x = cx - textWidth(s, unit, tracking) / 2;
  for (const ch of s) {
    if (ch !== " ") {
      const g = GLYPHS[ch];
      if (g) {
        for (const line of g) {
          for (let i = 0; i + 1 < line.length; i++) {
            seg(
              x + line[i][0] * unit, y + line[i][1] * unit,
              x + line[i + 1][0] * unit, y + line[i + 1][1] * unit,
              w, c, a,
            );
          }
        }
      }
    }
    x += (ch === " " ? 4 : 5) * unit + tracking;
  }
}

// ---------------------------------------------------------------------------
// The scene
// ---------------------------------------------------------------------------
const rand = mulberry32(20261121);

const CREAM: RGB = hex("#fff2cf");
const SUN: RGB = hex("#ffedb5");
const SEA_TOP: RGB = hex("#e08a5e");

function ridge(base: number, amp1: number, amp2: number, f1: number, f2: number, p1: number, p2: number, c: RGB, a: number): void {
  const pts: [number, number][] = [];
  for (let x = 0; x <= W; x += 8) {
    const y = base + amp1 * Math.sin(x * f1 + p1) + amp2 * Math.sin(x * f2 + p2);
    pts.push([x, y]);
  }
  pts.push([W, H]);
  pts.push([0, H]);
  poly(pts, c, a);
}

function waterfall(x: number, y0: number, len: number, w0: number, c: RGB): void {
  for (let t = 0; t < len; t++) {
    const w = w0 * (1 - (t / len) * 0.45);
    const a = 0.6 * (1 - (t / len) * 0.55);
    const sway = Math.sin(t * 0.09) * 2;
    fillRect(x - w / 2 + sway, y0 + t, x + w / 2 + sway, y0 + t + 1, c, a);
  }
}

function island(cx: number, cy: number, rx: number, ry: number, depth: number, top: RGB, side: RGB, alpha: number, tower: boolean): void {
  // Rocky underside tapering to a point.
  poly(
    [
      [cx - rx * 0.94, cy - 2],
      [cx + rx * 0.94, cy - 2],
      [cx + rx * 0.16, cy + depth],
      [cx - rx * 0.1, cy + depth],
    ],
    side,
    alpha,
  );
  // Grassy top.
  ellipse(cx, cy, rx, ry, top, alpha);
  // Warm rim light along the top edge, sun side: a smooth arc, not dots.
  for (let k = 0; k < 40; k++) {
    const q0 = -0.98 + (k / 40) * 1.96;
    const q1 = -0.98 + ((k + 1) / 40) * 1.96;
    const y0 = cy - ry * Math.sqrt(1 - q0 * q0) - 1;
    const y1 = cy - ry * Math.sqrt(1 - q1 * q1) - 1;
    seg(cx + q0 * rx, y0, cx + q1 * rx, y1, 2.6, hex("#ffd9a0"), alpha * 0.9);
  }
  if (tower) {
    // A slender watchtower with one lit window.
    const tx = cx - rx * 0.25;
    fillRect(tx - 7, cy - ry - 46, tx + 7, cy - ry + 2, hex("#1c2f45"), alpha);
    poly([[tx - 11, cy - ry - 46], [tx + 11, cy - ry - 46], [tx, cy - ry - 62]], hex("#e08a5e"), alpha);
    disc(tx, cy - ry - 30, 3.5, hex("#ffe9a8"), alpha);
    // Two little pines on the far edge, spaced apart so each reads.
    poly([[cx + rx * 0.4, cy - ry - 2], [cx + rx * 0.5, cy - ry - 30], [cx + rx * 0.6, cy - ry - 2]], hex("#16303c"), alpha);
    poly([[cx + rx * 0.64, cy - ry - 2], [cx + rx * 0.71, cy - ry - 22], [cx + rx * 0.78, cy - ry - 2]], hex("#16303c"), alpha);
  }
}

function bird(x: number, y: number, s: number, c: RGB, a: number): void {
  seg(x - s, y, x, y + s * 0.45, 2.4, c, a);
  seg(x, y + s * 0.45, x + s, y, 2.4, c, a);
}

function paint(): void {
  const HORIZON = 640;

  // 1. Sunset sky.
  vGradient(0, HORIZON, [
    [0, hex("#160f38")],
    [0.32, hex("#47235f")],
    [0.55, hex("#8f3d68")],
    [0.72, hex("#d96a5e")],
    [0.88, hex("#f6a45c")],
    [1, hex("#ffd9a3")],
  ]);

  // 2. Stars fading out toward the horizon glow.
  for (let i = 0; i < 150; i++) {
    const x = rand() * W;
    const y = rand() * 330;
    const r = 0.7 + rand() * 1.2;
    const a = (1 - y / 380) * (0.35 + rand() * 0.6);
    disc(x, y, r, hex("#fff8e0"), a, 0.8);
  }

  // 3. Low soft clouds catching the light.
  ellipse(210, 545, 150, 14, hex("#f7b98a"), 0.16);
  ellipse(830, 520, 180, 16, hex("#f7b98a"), 0.14);
  ellipse(620, 470, 120, 11, hex("#e89a7a"), 0.12);

  // 4. The low sun and its glow.
  glow(640, 590, 300, hex("#ff9a4d"), 0.55);
  glow(640, 590, 170, hex("#ffc46b"), 0.7);
  disc(640, 590, 78, SUN, 1, 2);
  disc(640, 590, 62, hex("#fff6cf"), 0.9, 2);

  // 5. A far floating isle, hazed by distance.
  island(170, 292, 72, 20, 62, hex("#5a4a7e"), hex("#3c2f5e"), 0.75, false);

  // 6. Distant ridges behind the sea.
  ridge(612, 14, 7, 0.006, 0.017, 1.2, 4.0, hex("#3a2350"), 1);
  ridge(636, 10, 5, 0.009, 0.021, 3.1, 0.6, hex("#2c1a44"), 1);

  // 7. The sea, still warm at the horizon, deep indigo below.
  vGradient(HORIZON, H, [
    [0, SEA_TOP],
    [0.12, hex("#8a5570")],
    [0.4, hex("#3a2f5e")],
    [1, hex("#141233")],
  ]);

  // 8. Sun path on the water: widening shimmer dashes. Kept above the
  //    tagline so no streak crosses the type.
  for (let i = 0; i < 80; i++) {
    const t = rand();
    const y = 652 + t * 278;
    const w = 26 + t * 170;
    const x = 640 + (rand() - 0.5) * w;
    const h = 3 + rand() * 4;
    const a = (0.5 - t * 0.28) * (0.45 + rand() * 0.55);
    fillRect(x - w / 2, y, x + w / 2, y + h, hex("#ffcf8a"), a);
  }

  // 9. The floating isles — the landmark. Waterfalls spill off their edges
  //    and vanish into the cloud sea below.
  island(350, 420, 168, 42, 138, hex("#1e4a44"), hex("#122c33"), 1, true);
  waterfall(300, 452, 96, 9, hex("#cfeef2"));
  waterfall(352, 462, 110, 12, hex("#dff5f7"));
  waterfall(408, 452, 88, 8, hex("#cfeef2"));
  island(770, 322, 108, 29, 96, hex("#23504a"), hex("#152f38"), 1, false);
  waterfall(742, 344, 70, 7, hex("#cfeef2"));
  waterfall(786, 348, 62, 6, hex("#dff5f7"));

  // 10. Birds crossing the evening sky.
  const INK: RGB = hex("#241536");
  bird(520, 250, 12, INK, 0.85);
  bird(565, 228, 9, INK, 0.8);
  bird(600, 262, 7, INK, 0.75);
  bird(240, 190, 9, INK, 0.7);
  bird(880, 210, 10, INK, 0.8);

  // 11. Dark foreground cliffs framing the bottom corners.
  poly([[0, 1024], [0, 872], [90, 900], [210, 942], [330, 968], [300, 1024]], hex("#120e28"), 1);
  poly([[1024, 1024], [1024, 890], [950, 912], [850, 950], [760, 972], [800, 1024]], hex("#120e28"), 1);
  // Pines on the left cliff.
  poly([[70, 896], [92, 838], [114, 896]], hex("#0d1a24"), 1);
  poly([[104, 884], [122, 838], [140, 884]], hex("#0d1a24"), 1);

  // 12. Type, set with intent: the name leads, the place follows.
  const SHADOW: RGB = hex("#2a1240");
  drawText("VELMORA", 512, 114, 15, 11, SHADOW, 0.55, 6);
  drawText("VELMORA", 512, 108, 15, 11, CREAM, 1, 6);
  drawText("THE FLOATING ISLES", 512, 246, 5.2, 4.5, hex("#ffd9a0"), 1, 3);
  // Small diamonds flanking the subtitle.
  poly([[196, 261], [202, 255], [208, 261], [202, 267]], hex("#ffd9a0"), 1);
  poly([[816, 261], [822, 255], [828, 261], [822, 267]], hex("#ffd9a0"), 1);
  drawText("WHERE THE SKY MEETS THE SEA", 512, 958, 4, 3.4, hex("#ffe9c0"), 0.92, 2.5);

  // 13. A thin poster frame.
  const FRAME: RGB = hex("#fff2cf");
  fillRect(26, 26, 998, 28.5, FRAME, 0.4);
  fillRect(26, 995.5, 998, 998, FRAME, 0.4);
  fillRect(26, 26, 28.5, 998, FRAME, 0.4);
  fillRect(995.5, 26, 998, 998, FRAME, 0.4);
}

// ---------------------------------------------------------------------------
// PNG encoding (stdlib zlib + hand-rolled CRC32, filter 0 scanlines)
// ---------------------------------------------------------------------------
const CRC_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  const crc = crc32(out.subarray(4, 8 + data.length));
  view.setUint32(8 + data.length, crc);
  return out;
}

function encodePng(): Uint8Array {
  const raw = new Uint8Array(H * (1 + W * 3));
  for (let y = 0; y < H; y++) {
    raw[y * (1 + W * 3)] = 0; // filter: none
    raw.set(buf.subarray(y * W * 3, (y + 1) * W * 3), y * (1 + W * 3) + 1);
  }
  const idat = deflateSync(raw, { level: 9 });
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, W);
  v.setUint32(4, H);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))];
  const total = parts.reduce((s, p) => s + p.length, 0);
  const png = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    png.set(p, off);
    off += p.length;
  }
  return png;
}

const outPath = process.env.OUTPUT_PATH ?? "/output/entry.png";
paint();
const png = encodePng();
mkdirSync("/output", { recursive: true });
writeFileSync(outPath, png);
console.log(`wrote ${outPath}: ${W}x${H} PNG, ${png.length} bytes (limit 1048576)`);

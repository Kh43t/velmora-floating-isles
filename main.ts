// SHELMERE — The Island That Swims
// A travel poster for a place that does not exist.
// Pure Node 22 standard library: it rasterizes a 1024x1024 poster and
// writes /output/entry.png. No network, no dependencies, deterministic.

import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const SIZE = 1024;
type Tint = [number, number, number];
type Pt = [number, number];
type Contour = Pt[];

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function rgb(hexcode: string): Tint {
  const n = parseInt(hexcode.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function shadeOf(a: Tint, b: Tint, t: number): Tint {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

// Small fast deterministic generator (xorshift32) — one fixed stream for
// every painterly detail, so the poster is identical on every run.
function makeDice(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

const dice = makeDice(20261121);

// ---------------------------------------------------------------------------
// Canvas: one RGB framebuffer plus the only drawing verbs the poster needs.
// ---------------------------------------------------------------------------
class Canvas {
  data = new Uint8Array(SIZE * SIZE * 3);

  dot(x: number, y: number, c: Tint, a: number): void {
    const xi = Math.round(x);
    const yi = Math.round(y);
    if (xi < 0 || xi >= SIZE || yi < 0 || yi >= SIZE || a <= 0) return;
    const i = (yi * SIZE + xi) * 3;
    if (a >= 1) {
      this.data[i] = c[0];
      this.data[i + 1] = c[1];
      this.data[i + 2] = c[2];
      return;
    }
    this.data[i] += (c[0] - this.data[i]) * a;
    this.data[i + 1] += (c[1] - this.data[i + 1]) * a;
    this.data[i + 2] += (c[2] - this.data[i + 2]) * a;
  }

  // Solid rectangle, alpha-blended.
  box(x0: number, y0: number, x1: number, y1: number, c: Tint, a: number): void {
    const xa = Math.max(0, Math.floor(x0));
    const xb = Math.min(SIZE - 1, Math.ceil(x1));
    const ya = Math.max(0, Math.floor(y0));
    const yb = Math.min(SIZE - 1, Math.ceil(y1));
    for (let y = ya; y <= yb; y++) {
      const row = y * SIZE * 3;
      for (let x = xa; x <= xb; x++) {
        const i = row + x * 3;
        this.data[i] += (c[0] - this.data[i]) * a;
        this.data[i + 1] += (c[1] - this.data[i + 1]) * a;
        this.data[i + 2] += (c[2] - this.data[i + 2]) * a;
      }
    }
  }

  // Vertical wash through colour stops [fraction 0..1, colour].
  wash(y0: number, y1: number, stops: [number, Tint][]): void {
    for (let y = Math.max(0, y0); y < Math.min(SIZE, y1); y++) {
      const t = (y - y0) / (y1 - y0);
      let c: Tint = stops[stops.length - 1][1];
      for (let s = 0; s < stops.length - 1; s++) {
        if (t >= stops[s][0] && t <= stops[s + 1][0]) {
          const f = (t - stops[s][0]) / (stops[s + 1][0] - stops[s][0]);
          c = shadeOf(stops[s][1], stops[s + 1][1], f);
          break;
        }
      }
      const row = y * SIZE * 3;
      for (let x = 0; x < SIZE; x++) {
        this.data[row + x * 3] = c[0];
        this.data[row + x * 3 + 1] = c[1];
        this.data[row + x * 3 + 2] = c[2];
      }
    }
  }

  // Filled disc with a soft rim of `feather` pixels.
  spot(cx: number, cy: number, r: number, c: Tint, a: number, feather = 1.5): void {
    const x0 = Math.max(0, Math.floor(cx - r - feather - 1));
    const x1 = Math.min(SIZE - 1, Math.ceil(cx + r + feather + 1));
    const y0 = Math.max(0, Math.floor(cy - r - feather - 1));
    const y1 = Math.min(SIZE - 1, Math.ceil(cy + r + feather + 1));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const d = Math.hypot(x - cx, y - cy);
        const cov = d <= r ? 1 : clamp01(1 - (d - r) / feather);
        if (cov > 0) this.dot(x, y, c, a * cov);
      }
    }
  }

  // Glow whose alpha fades quadratically to the edge of the radius.
  halo(cx: number, cy: number, r: number, c: Tint, a: number): void {
    const x0 = Math.max(0, Math.floor(cx - r));
    const x1 = Math.min(SIZE - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r));
    const y1 = Math.min(SIZE - 1, Math.ceil(cy + r));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const d = Math.hypot(x - cx, y - cy) / r;
        if (d >= 1) continue;
        this.dot(x, y, c, a * (1 - d) * (1 - d));
      }
    }
  }

  // Filled ellipse with a soft rim.
  oval(cx: number, cy: number, rx: number, ry: number, c: Tint, a: number): void {
    const x0 = Math.max(0, Math.floor(cx - rx - 2));
    const x1 = Math.min(SIZE - 1, Math.ceil(cx + rx + 2));
    const y0 = Math.max(0, Math.floor(cy - ry - 2));
    const y1 = Math.min(SIZE - 1, Math.ceil(cy + ry + 2));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const v = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
        if (v > 1.44) continue;
        const d = Math.sqrt(v);
        const cov = d <= 1 ? 1 : clamp01(1 - (d - 1) * 6);
        if (cov > 0) this.dot(x, y, c, a * cov);
      }
    }
  }

  // Nonzero-winding fill of any number of closed contours. Contours that
  // wind the same way union; a contour wound the opposite way cuts a hole.
  // That is what lets a glyph's stem, bars and serifs overlap freely while
  // its counters stay open.
  fill(contours: Contour[], c: Tint, a: number): void {
    let top = Infinity;
    let bottom = -Infinity;
    for (const pts of contours) {
      for (const [, y] of pts) {
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
    }
    for (let y = Math.ceil(top); y <= Math.floor(bottom); y++) {
      if (y < 0 || y >= SIZE) continue;
      const hits: [number, number][] = [];
      for (const pts of contours) {
        for (let i = 0; i < pts.length; i++) {
          const [x1, y1] = pts[i];
          const [x2, y2] = pts[(i + 1) % pts.length];
          if (y1 <= y && y2 > y) {
            hits.push([x1 + ((y - y1) * (x2 - x1)) / (y2 - y1), 1]);
          } else if (y2 <= y && y1 > y) {
            hits.push([x1 + ((y - y1) * (x2 - x1)) / (y2 - y1), -1]);
          }
        }
      }
      hits.sort((p, q) => p[0] - q[0]);
      const row = y * SIZE * 3;
      let wind = 0;
      for (let k = 0; k + 1 < hits.length; k++) {
        wind += hits[k][1];
        if (wind === 0) continue;
        const xa = Math.max(0, Math.ceil(hits[k][0]));
        const xb = Math.min(SIZE - 1, Math.floor(hits[k + 1][0]));
        for (let x = xa; x <= xb; x++) {
          const i = row + x * 3;
          this.data[i] += (c[0] - this.data[i]) * a;
          this.data[i + 1] += (c[1] - this.data[i + 1]) * a;
          this.data[i + 2] += (c[2] - this.data[i + 2]) * a;
        }
      }
    }
  }

  // Thick segment with round caps.
  stroke(x1: number, y1: number, x2: number, y2: number, w: number, c: Tint, a: number): void {
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
        t = clamp01(t);
        const d = Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
        const cov = clamp01(r + 0.6 - d);
        if (cov > 0) this.dot(x, y, c, a * cov);
      }
    }
  }

  // Polyline along an ellipse arc; angles in degrees, y grows downwards.
  arcLine(cx: number, cy: number, rx: number, ry: number, a0: number, a1: number, w: number, c: Tint, a: number): void {
    const steps = Math.max(8, Math.round(Math.abs(a1 - a0) / 3));
    let px = cx + rx * Math.cos((a0 * Math.PI) / 180);
    let py = cy + ry * Math.sin((a0 * Math.PI) / 180);
    for (let k = 1; k <= steps; k++) {
      const ang = (a0 + ((a1 - a0) * k) / steps) * (Math.PI / 180);
      const qx = cx + rx * Math.cos(ang);
      const qy = cy + ry * Math.sin(ang);
      this.stroke(px, py, qx, qy, w, c, a);
      px = qx;
      py = qy;
    }
  }
}

const page = new Canvas();

// ---------------------------------------------------------------------------
// Palette — a flat vintage travel-poster set: deep teal, coral, gold, cream.
// ---------------------------------------------------------------------------
const INK = {
  cream: rgb("#fff3d0"),
  gold: rgb("#ffd98c"),
  sun: rgb("#ffdf9e"),
  coral: rgb("#d96a4e"),
  roof: rgb("#b85c3f"),
  shell: rgb("#1d4a40"),
  shellLight: rgb("#2a6a55"),
  shellDark: rgb("#0e2b26"),
  skin: rgb("#4d6338"),
  skinDark: rgb("#33411f"),
  town: rgb("#f4e3c2"),
  deep: rgb("#0b2833"),
  rock: rgb("#0d222c"),
};

// ---------------------------------------------------------------------------
// Filled serif capitals on a 7 x 10 grid. Each glyph is a list of closed
// contours; a contour wound the opposite way to its neighbours is a
// counter, because the fill rule is nonzero winding. Serifs are part of
// the outlines, so stems, bars and serifs may overlap freely.
// ---------------------------------------------------------------------------
const R = (x0: number, y0: number, x1: number, y1: number): Contour => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];

const SERIF: Record<string, Contour[]> = {
  A: [
    [[0, 10], [2.5, 0], [4.5, 0], [7, 10], [5.4, 10], [3.5, 2.4], [1.6, 10]],
    R(1.7, 6.5, 5.3, 7.7),
  ],
  C: [
    [[6.4, 1.4], [5.2, 0.2], [2.8, 0], [1.2, 1.0], [0.3, 2.8], [0.1, 5], [0.3, 7.2], [1.2, 9.0], [2.8, 10], [5.2, 9.8], [6.4, 8.6], [5.3, 7.4], [4.5, 8.5], [3.2, 8.6], [2.0, 7.6], [1.6, 5], [2.0, 2.4], [3.2, 1.4], [4.5, 1.5], [5.3, 2.6]],
  ],
  D: [
    R(0, 0, 1.5, 10),
    R(-0.4, 0, 1.9, 0.9),
    R(-0.4, 9.1, 1.9, 10),
    [[1.5, 0], [4.2, 0], [5.8, 1.4], [6.5, 5], [5.8, 8.6], [4.2, 10], [1.5, 10]],
    [[2.9, 8.4], [3.9, 8.4], [4.8, 7.2], [5.1, 5], [4.8, 2.8], [3.9, 1.6], [2.9, 1.6]],
  ],
  E: [
    R(0, 0, 1.5, 10),
    R(-0.4, 0, 1.9, 0.9),
    R(-0.4, 9.1, 1.9, 10),
    R(0, 0, 6.3, 1.5),
    R(0, 4.25, 5.0, 5.75),
    R(0, 8.5, 6.3, 10),
  ],
  H: [
    R(0, 0, 1.5, 10),
    R(5.5, 0, 7, 10),
    R(-0.4, 0, 1.9, 0.9),
    R(-0.4, 9.1, 1.9, 10),
    R(5.1, 0, 7.4, 0.9),
    R(5.1, 9.1, 7.4, 10),
    R(0, 4.25, 7, 5.75),
  ],
  I: [R(2.75, 0, 4.25, 10), R(1.1, 0, 5.9, 1.3), R(1.1, 8.7, 5.9, 10)],
  L: [
    R(0, 0, 1.5, 10),
    R(-0.4, 0, 1.9, 0.9),
    R(-0.4, 9.1, 1.9, 10),
    R(0, 8.5, 6.3, 10),
  ],
  M: [
    [[0, 10], [0, 0], [1.6, 0], [3.5, 4.6], [5.4, 0], [7, 0], [7, 10], [5.4, 10], [5.4, 3.8], [3.5, 8.2], [1.6, 3.8], [1.6, 10]],
    R(-0.2, 9.2, 1.8, 10),
    R(5.2, 9.2, 7.2, 10),
  ],
  N: [
    [[0, 10], [0, 0], [1.7, 0], [5.3, 6.8], [5.3, 0], [7, 0], [7, 10], [5.3, 10], [1.7, 3.2], [1.7, 10]],
    R(-0.2, 9.2, 1.9, 10),
    R(5.1, 9.2, 7.2, 10),
  ],
  O: [
    [[2.2, 0], [4.8, 0], [6.4, 1.8], [7, 5], [6.4, 8.2], [4.8, 10], [2.2, 10], [0.6, 8.2], [0, 5], [0.6, 1.8]],
    [[1.7, 3.0], [1.4, 5], [1.7, 7.0], [2.9, 8.3], [4.1, 8.3], [5.3, 7.0], [5.6, 5], [5.3, 3.0], [4.1, 1.7], [2.9, 1.7]],
  ],
  R: [
    R(0, 0, 1.5, 10),
    R(-0.4, 0, 1.9, 0.9),
    R(-0.4, 9.1, 1.9, 10),
    [[1.5, 0], [4.4, 0], [5.9, 1.2], [6.1, 3.2], [5.2, 4.8], [1.5, 4.8]],
    [[2.9, 3.6], [4.2, 3.6], [4.7, 3.0], [4.7, 2.2], [4.2, 1.4], [2.9, 1.4]],
    [[3.4, 4.8], [4.8, 4.8], [7, 10], [5.4, 10], [3.0, 6.4]],
  ],
  S: [
    [[6.3, 1.4], [5.2, 0.2], [3.0, 0], [1.4, 0.8], [0.5, 2.4], [0.5, 3.8], [1.3, 4.7], [2.8, 5.0], [4.4, 5.4], [5.8, 6.4], [6.4, 7.8], [5.6, 9.4], [3.8, 10], [1.6, 9.6], [0.4, 8.4], [1.3, 7.4], [2.3, 8.4], [3.8, 8.5], [4.9, 7.6], [5.0, 6.6], [4.2, 5.9], [2.6, 5.6], [1.2, 5.0], [0.3, 3.9], [0.4, 2.6], [1.2, 1.5], [2.6, 1.3], [4.0, 1.4], [5.0, 2.0], [5.7, 2.6]],
  ],
  T: [R(0, 0, 7, 1.5), R(2.75, 1.5, 4.25, 10), R(2.0, 9.0, 5.0, 10)],
  U: [
    [[0, 0], [1.5, 0], [1.5, 7.2], [2.6, 8.5], [4.4, 8.5], [5.5, 7.2], [5.5, 0], [7, 0], [7, 7.6], [5.6, 9.6], [4.6, 10], [2.4, 10], [1.4, 9.6], [0, 7.6]],
  ],
  W: [
    [[0, 0], [1.4, 0], [2.8, 10], [1.4, 10]],
    [[1.4, 10], [2.8, 10], [4.2, 1.0], [3.0, 0.4]],
    [[3.0, 0.4], [4.2, 1.0], [5.6, 10], [4.2, 10]],
    [[4.2, 10], [5.6, 10], [7, 0], [5.6, 0]],
  ],
  Y: [
    [[0, 0], [1.5, 0], [3.5, 4.0], [5.5, 0], [7, 0], [4.2, 5.6], [4.2, 10], [2.8, 10], [2.8, 5.6]],
  ],
};

const GLYPH_ADVANCE = 8; // grid units per letter, space included
const SPACE_ADVANCE = 4;

function lineWidth(text: string, unit: number, track: number): number {
  let w = 0;
  for (const ch of text) {
    w += (ch === " " ? SPACE_ADVANCE : GLYPH_ADVANCE) * unit + track;
  }
  return w - track;
}

// Centre one line of set type; `top` is the top of the cap height.
function setLine(text: string, cx: number, top: number, unit: number, c: Tint, a: number, track = 0): void {
  let x = cx - lineWidth(text, unit, track) / 2;
  for (const ch of text) {
    if (ch !== " ") {
      const glyph = SERIF[ch];
      if (glyph) {
        const moved = glyph.map((contour) =>
          contour.map(([gx, gy]): Pt => [x + gx * unit, top + gy * unit]),
        );
        page.fill(moved, c, a);
      }
    }
    x += (ch === " " ? SPACE_ADVANCE : GLYPH_ADVANCE) * unit + track;
  }
}

// A small four-point star used as a divider in the type lines.
function diamond(cx: number, cy: number, r: number, c: Tint, a: number): void {
  page.fill([[[cx, cy - r], [cx + r, cy], [cx, cy + r], [cx - r, cy]]], c, a);
}

// ---------------------------------------------------------------------------
// The scene: SHELMERE, a harbour town riding on the back of a great turtle.
// ---------------------------------------------------------------------------
const HORIZON = 640;

// The shell dome: centre (470, 728), radii (305, 168). Its top peaks at
// y = 560, its bottom edge sits in the water at y = 728.
const SHELL = { cx: 470, cy: 728, rx: 305, ry: 168 };

function domeOutline(scale: number): Contour {
  const pts: Pt[] = [];
  for (let k = 0; k <= 40; k++) {
    const ang = (Math.PI * (180 + (k / 40) * 180)) / 180;
    pts.push([
      SHELL.cx + SHELL.rx * scale * Math.cos(ang),
      SHELL.cy + SHELL.ry * scale * Math.sin(ang),
    ]);
  }
  return pts;
}

function sky(): void {
  page.wash(0, HORIZON, [
    [0, rgb("#0b323e")],
    [0.3, rgb("#155f5e")],
    [0.55, rgb("#d97a52")],
    [0.78, rgb("#f2a55c")],
    [1, rgb("#ffd98c")],
  ]);

  // Flat evening clouds, barely there.
  page.oval(220, 330, 150, 13, rgb("#f7b98a"), 0.14);
  page.oval(820, 300, 170, 15, rgb("#f7b98a"), 0.12);
  page.oval(600, 385, 120, 10, rgb("#e89a7a"), 0.1);

  // The low sun, just clearing the shell's right shoulder.
  page.halo(700, 590, 210, rgb("#ff9a4d"), 0.5);
  page.halo(700, 590, 120, rgb("#ffc46b"), 0.65);
  page.spot(700, 590, 60, INK.sun, 1, 2);
  page.spot(700, 590, 46, rgb("#fff6cf"), 0.9, 2);
}

function sea(): void {
  page.wash(HORIZON, SIZE, [
    [0, rgb("#cf7a55")],
    [0.15, rgb("#5d7a68")],
    [0.45, rgb("#1d4f57")],
    [1, rgb("#0b2833")],
  ]);

  // The sun path: widening gold dashes on the water, kept clear of the
  // bottom type line.
  for (let i = 0; i < 85; i++) {
    const t = dice();
    const y = 656 + t * 268;
    const w = 24 + t * 190;
    const x = 700 + (dice() - 0.5) * w;
    const h = 3 + dice() * 4;
    const a = (0.5 - t * 0.28) * (0.4 + dice() * 0.6);
    page.box(x - w / 2, y, x + w / 2, y + h, rgb("#ffcf8a"), a);
  }
}

function gull(x: number, y: number, s: number, c: Tint, a: number): void {
  page.stroke(x - s, y, x, y + s * 0.45, 2.4, c, a);
  page.stroke(x, y + s * 0.45, x + s, y, 2.4, c, a);
}

function turtle(): void {
  // The dome itself, with its lower edge sunk in the water.
  const dome = domeOutline(1);
  dome.push([SHELL.cx + SHELL.rx, SHELL.cy], [SHELL.cx - SHELL.rx, SHELL.cy]);
  page.fill([dome], INK.shell, 1);

  // Scute fan: seams radiating from a hub near the dome's peak, crossed
  // by three concentric arcs — the shell's plate pattern.
  const hub: Pt = [SHELL.cx, SHELL.cy - SHELL.ry + 22];
  for (const deg of [198, 222, 246, 270, 294, 318, 342]) {
    const rad = (deg * Math.PI) / 180;
    const ex = SHELL.cx + SHELL.rx * Math.cos(rad);
    const ey = SHELL.cy + SHELL.ry * Math.sin(rad);
    page.stroke(hub[0], hub[1], ex, ey, 4, INK.shellDark, 0.7);
  }
  for (const s of [0.52, 0.72, 0.9]) {
    page.arcLine(SHELL.cx, SHELL.cy, SHELL.rx * s, SHELL.ry * s, 180, 360, 4, INK.shellDark, 0.6);
  }
  // A lighter wash on the dome's upper face, sun side.
  page.arcLine(SHELL.cx, SHELL.cy, SHELL.rx * 0.97, SHELL.ry * 0.97, 250, 355, 5, INK.shellLight, 0.5);
  // Gold rim light along the sun-side edge of the shell.
  page.arcLine(SHELL.cx, SHELL.cy, SHELL.rx, SHELL.ry, 272, 352, 4.5, INK.gold, 0.85);
  page.arcLine(SHELL.cx, SHELL.cy, SHELL.rx, SHELL.ry, 188, 262, 3, INK.gold, 0.35);

  // Neck and head, rising out of the water on the left, low beside the
  // shell — a turtle swimming, not a snail on a hill.
  page.fill(
    [
      [
        [238, 716],
        [205, 648],
        [180, 622],
        [162, 606],
        [148, 618],
        [158, 648],
        [178, 690],
        [205, 718],
      ],
    ],
    INK.skin,
    1,
  );
  page.oval(165, 615, 52, 38, INK.skin, 1);
  page.oval(146, 626, 30, 24, INK.skin, 1);
  // Shading under the jaw, then the eye and a calm mouth line.
  page.oval(168, 634, 44, 24, INK.skinDark, 0.35);
  page.spot(142, 608, 6, rgb("#120e28"), 1, 1);
  page.spot(140, 606, 2, INK.cream, 1, 0.8);
  page.arcLine(146, 626, 22, 12, 20, 130, 2.4, INK.skinDark, 0.8);

  // Front flipper: a broad blade half out of the water on the right, and
  // a hint of the far flipper tucked against the shell on the left.
  page.fill(
    [[[695, 730], [765, 714], [838, 732], [800, 760], [725, 754]]],
    INK.skin,
    1,
  );
  page.stroke(705, 726, 768, 716, 3, INK.skinDark, 0.5);
  page.oval(205, 730, 36, 14, INK.skin, 1);

  // Water lapping the shell: a soft shadow under the dome, then white
  // ripples in the sea just in front of its lower edge, fanning out from
  // the flipper's tip.
  page.oval(470, 738, 315, 10, rgb("#0b2833"), 0.3);
  for (const [wx, wy, wr] of [
    [300, 736, 36],
    [430, 746, 52],
    [560, 738, 44],
    [660, 748, 36],
  ] as [number, number, number][]) {
    page.arcLine(wx, wy, wr, 10, 180, 360, 2.4, rgb("#e8f4ee"), 0.32);
  }
  for (const [wx, wy, wr] of [
    [380, 762, 30],
    [520, 768, 40],
    [640, 764, 28],
  ] as [number, number, number][]) {
    page.arcLine(wx, wy, wr, 9, 180, 360, 2.2, rgb("#e8f4ee"), 0.22);
  }
  page.arcLine(815, 762, 70, 13, 200, 340, 2.4, rgb("#e8f4ee"), 0.35);
  page.arcLine(830, 780, 95, 17, 200, 340, 2.2, rgb("#e8f4ee"), 0.25);
}

// One little harbour house, upright on the shell.
function house(x: number, y: number, w: number, h: number, lit: boolean): void {
  page.box(x, y - h, x + w, y, INK.town, 1);
  page.fill(
    [[[x - 2, y - h], [x + w / 2, y - h - 11], [x + w + 2, y - h]]],
    INK.roof,
    1,
  );
  if (lit) {
    page.box(x + w * 0.28, y - h + 5, x + w * 0.28 + 4, y - h + 10, INK.gold, 1);
    page.box(x + w * 0.62, y - h + 5, x + w * 0.62 + 4, y - h + 10, INK.gold, 1);
  }
  // Chimney with a curl of smoke.
  page.box(x + w - 5, y - h - 8, x + w - 2, y - h, rgb("#2c3a3f"), 1);
  page.arcLine(x + w - 3, y - h - 14, 5, 4, 200, 340, 2, rgb("#f4e3c2"), 0.3);
}

function cypress(x: number, y: number, h: number): void {
  page.fill(
    [[[x - 6, y], [x, y - h], [x + 6, y]]],
    rgb("#12303a"),
    1,
  );
  page.box(x - 1.5, y - 2, x + 1.5, y + 3, rgb("#12303a"), 1);
}

function town(): void {
  // Houses ride the dome's curve; each sits on the shell at its angle.
  // Angles run around the dome's upper half (180..360), so every house
  // lands on the shell and none collides with the lighthouse at the peak.
  const spots: [number, number, number, boolean][] = [
    [226, 28, 22, true],
    [238, 24, 20, true],
    [252, 30, 22, false],
    [264, 26, 20, true],
    [276, 26, 20, true],
    [288, 30, 22, false],
    [302, 24, 20, true],
    [314, 28, 22, true],
  ];
  for (const [deg, w, h, lit] of spots) {
    const rad = (deg * Math.PI) / 180;
    const x = SHELL.cx + SHELL.rx * 0.99 * Math.cos(rad) - w / 2;
    const y = SHELL.cy + SHELL.ry * 0.99 * Math.sin(rad);
    house(x, y, w, h, lit);
  }
  cypress(319, 584, 26);
  cypress(621, 584, 22);

  // The lighthouse on the shell's peak, its lamp lit for the evening.
  const lx = SHELL.cx;
  const peak = SHELL.cy - SHELL.ry;
  page.box(lx - 9, peak - 46, lx + 9, peak + 2, rgb("#12303a"), 1);
  page.box(lx - 12, peak - 52, lx + 12, peak - 44, rgb("#12303a"), 1);
  page.spot(lx, peak - 48, 5, INK.gold, 1, 1);
  page.halo(lx, peak - 48, 34, INK.gold, 0.5);
  page.fill([[[lx + 9, peak - 52], [lx + 26, peak - 48], [lx + 9, peak - 44]]], INK.coral, 1);
  page.stroke(lx + 9, peak - 52, lx + 9, peak - 66, 2.4, rgb("#12303a"), 1);
}

function sailboat(x: number, y: number, s: number): void {
  const hull: Tint = rgb("#1a1430");
  page.fill(
    [[[x - 18 * s, y], [x + 18 * s, y], [x + 12 * s, y + 10 * s], [x - 12 * s, y + 10 * s]]],
    hull,
    1,
  );
  page.fill(
    [[[x, y], [x, y - 44 * s], [x + 24 * s, y]]],
    rgb("#ffe9c0"),
    0.95,
  );
  page.fill(
    [[[x - 2 * s, y], [x - 2 * s, y - 32 * s], [x - 18 * s, y]]],
    rgb("#f2c98a"),
    0.95,
  );
  page.stroke(x, y - 48 * s, x, y + 2 * s, 3, hull, 1);
  page.stroke(x - 20 * s, y + 16 * s, x + 20 * s, y + 16 * s, 3, rgb("#ffcf8a"), 0.45);
}

function foreground(): void {
  // Dark rocks framing the bottom corners.
  page.fill(
    [[[0, 1024], [0, 905], [70, 930], [150, 955], [230, 975], [200, 1024]]],
    INK.rock,
    1,
  );
  page.fill(
    [[[1024, 1024], [1024, 920], [960, 940], [890, 962], [830, 980], [860, 1024]]],
    INK.rock,
    1,
  );
  page.fill([[[70, 938], [92, 880], [114, 938]]], rgb("#0d1a24"), 1);
  page.fill([[[104, 948], [122, 892], [140, 948]]], rgb("#0d1a24"), 1);

  sailboat(255, 845, 1);
  sailboat(855, 890, 0.72);

  const dark: Tint = rgb("#241536");
  gull(330, 320, 12, dark, 0.85);
  gull(385, 296, 9, dark, 0.8);
  gull(420, 330, 7, dark, 0.75);
  gull(610, 300, 10, dark, 0.8);
}

function type(): void {
  // The name leads, big and cream, with a soft shadow so it holds
  // against the bright sky bands.
  const shadow: Tint = rgb("#2a1240");
  setLine("SHELMERE", 512, 72, 11.8, shadow, 0.5, 4);
  setLine("SHELMERE", 512, 66, 11.8, INK.cream, 1, 4);
  const sub = "THE ISLAND THAT SWIMS";
  const sw = lineWidth(sub, 3.6, 3);
  setLine(sub, 512, 212, 3.6, INK.gold, 1, 3);
  diamond(512 - sw / 2 - 26, 230, 5, INK.gold, 1);
  diamond(512 + sw / 2 + 26, 230, 5, INK.gold, 1);

  // The promise of the stay, along the bottom.
  const foot = "WHERE THE SEA CARRIES YOU HOME";
  const fw = lineWidth(foot, 2.7, 2.5);
  setLine(foot, 512, 950, 2.7, INK.cream, 0.95, 2.5);
  diamond(512 - fw / 2 - 24, 963, 4, INK.cream, 0.9);
  diamond(512 + fw / 2 + 24, 963, 4, INK.cream, 0.9);

  // A thin poster frame.
  page.box(26, 26, 998, 29, INK.cream, 0.45);
  page.box(26, 995, 998, 998, INK.cream, 0.45);
  page.box(26, 26, 29, 998, INK.cream, 0.45);
  page.box(995, 26, 998, 998, INK.cream, 0.45);
}

function grain(): void {
  // Coarse print grain, 4x4 blocks: enough to read as paper, light
  // enough to keep the file far under the 1 MiB cap.
  for (let by = 0; by < SIZE; by += 4) {
    for (let bx = 0; bx < SIZE; bx += 4) {
      const g = (dice() - 0.5) * 12;
      for (let y = by; y < Math.min(by + 4, SIZE); y++) {
        for (let x = bx; x < Math.min(bx + 4, SIZE); x++) {
          const i = (y * SIZE + x) * 3;
          page.data[i] = Math.max(0, Math.min(255, page.data[i] + g));
          page.data[i + 1] = Math.max(0, Math.min(255, page.data[i + 1] + g));
          page.data[i + 2] = Math.max(0, Math.min(255, page.data[i + 2] + g));
        }
      }
    }
  }
}

function paint(): void {
  sky();
  sea();
  turtle();
  town();
  foreground();
  type();
  grain();
}

// ---------------------------------------------------------------------------
// PNG writing: hand-rolled chunks over zlib, filter 0 scanlines.
// ---------------------------------------------------------------------------
const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crcOf(bytes: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(kind: string, payload: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(payload.length, 0);
  head.write(kind, 4, "ascii");
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crcOf(Buffer.concat([head.subarray(4), payload])), 0);
  return Buffer.concat([head, payload, tail]);
}

function writePng(): Buffer {
  const raw = Buffer.alloc(SIZE * (1 + SIZE * 3));
  for (let y = 0; y < SIZE; y++) {
    raw[y * (1 + SIZE * 3)] = 0; // filter: none
    Buffer.from(page.data.buffer, y * SIZE * 3, SIZE * 3).copy(
      raw,
      y * (1 + SIZE * 3) + 1,
    );
  }
  const idat = deflateSync(raw, { level: 9 });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const outPath = process.env.OUTPUT_PATH ?? "/output/entry.png";
paint();
const png = writePng();
mkdirSync("/output", { recursive: true });
writeFileSync(outPath, png);
console.log(`wrote ${outPath}: ${SIZE}x${SIZE} PNG, ${png.length} bytes (limit 1048576)`);

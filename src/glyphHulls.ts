// glyphHulls.ts — collision hulls for the "Celebrate your hard work" bubble letters.
// Replaces the old distance-transform circle-packer, which packed up to 8 inscribed
// circles per glyph and produced a tangled spirograph that didn't read as the letter
// (an `o` came out as a ring of tiny balls instead of one circle).
//
// Each glyph is traced by hand (in /glyph-editor) with a FEW curved primitives: ball,
// capsule, rrect (rounded rectangle = Rapier roundCuboid), and oval (ellipse via
// roundConvexHull). Curved only — no sharp corners: a corner catches on a neighbour and
// wedges the pile, whereas these slide past each other. A capsule/rect collapses a whole
// stroke into one collider; rect/oval scale x and y independently ("just wider").
//
// Coordinate system (matches the rendered glyph EXACTLY):
//   • Units are fractions of the font `size` (1.0 == size px). Scale by `size` to get px.
//   • Origin (0,0) is the glyph's body centre — the PIXI text anchor (0.5). The real
//     component positions each letter body there and offsets colliders from it, so a
//     hull authored in this frame lands on the glyph with no per-glyph calibration.
//   • +x is right, +y is DOWN (screen/PIXI convention).
// Author + verify these against /glyph-editor, which renders the real font with this grid.

import type * as PIXI from 'pixi.js'

/** A ball collider: centre (x,y), radius r — all in font-size units. */
export interface HullBall {
  t: 'ball'
  x: number
  y: number
  r: number
}
/**
 * A capsule collider: a stadium centred at (x,y) with cap radius r and a straight
 * segment of half-length h (so the full length along its axis is 2h + 2r). `a` is the
 * rotation in radians; a=0 means the capsule's long axis is VERTICAL (Rapier's capsule
 * is built along local +y), a=π/2 makes it horizontal. All lengths in font-size units.
 */
export interface HullCapsule {
  t: 'cap'
  x: number
  y: number
  r: number
  h: number
  a: number
}
/**
 * A rounded rectangle (Rapier `roundCuboid`): independent half-extents `hx`/`hy` with a
 * corner radius `r`, rotated by `a`. Unlike a capsule it scales in x and y independently
 * — make it "just wider" by growing `hx`. Flat sides + rounded corners (no sharp corner
 * to wedge on). `hx`/`hy` are the OUTER half-extents; `r` ≤ min(hx,hy).
 */
export interface HullRRect {
  t: 'rrect'
  x: number
  y: number
  hx: number
  hy: number
  r: number
  a: number
}
/**
 * An ellipse (built from a Rapier `roundConvexHull` of points sampled on the ellipse, so
 * it's fully curved — no corners). Independent semi-axes `rx`/`ry`, rotated by `a`.
 */
export interface HullOval {
  t: 'oval'
  x: number
  y: number
  rx: number
  ry: number
  a: number
}
export type HullShape = HullBall | HullCapsule | HullRRect | HullOval

/** Same primitives but pre-scaled to pixels — what the spec ships to the physics world. */
export interface PxBall {
  t: 'ball'
  x: number
  y: number
  r: number
}
export interface PxCapsule {
  t: 'cap'
  x: number
  y: number
  r: number
  h: number
  a: number
}
export interface PxRRect {
  t: 'rrect'
  x: number
  y: number
  hx: number
  hy: number
  r: number
  a: number
}
export interface PxOval {
  t: 'oval'
  x: number
  y: number
  rx: number
  ry: number
  a: number
}
export type PxShape = PxBall | PxCapsule | PxRRect | PxOval

/** Scale a normalized hull (font-size units) to pixels for a given rendered glyph size. */
export function scaleHull(shapes: HullShape[], size: number): PxShape[] {
  return shapes.map((s): PxShape => {
    switch (s.t) {
      case 'ball':
        return { t: 'ball', x: s.x * size, y: s.y * size, r: s.r * size }
      case 'cap':
        return { t: 'cap', x: s.x * size, y: s.y * size, r: s.r * size, h: s.h * size, a: s.a }
      case 'rrect':
        return { t: 'rrect', x: s.x * size, y: s.y * size, hx: s.hx * size, hy: s.hy * size, r: s.r * size, a: s.a }
      case 'oval':
        return { t: 'oval', x: s.x * size, y: s.y * size, rx: s.rx * size, ry: s.ry * size, a: s.a }
    }
  })
}

const PI2 = Math.PI / 2

/**
 * Stroke a px-space hull onto a PIXI.Graphics, transformed by a body pose (origin
 * ox,oy + rotation bodyRot). Used by BOTH /glyph-editor and the in-app `d` debug overlay,
 * so what you tune in the editor is exactly what collides. Call g.stroke(...) after.
 */
export function strokeHullPx(
  g: PIXI.Graphics,
  shapes: PxShape[],
  ox: number,
  oy: number,
  bodyRot = 0,
): void {
  const bc = Math.cos(bodyRot)
  const bs = Math.sin(bodyRot)
  const toWorld = (lx: number, ly: number) => ({ x: ox + (bc * lx - bs * ly), y: oy + (bs * lx + bc * ly) })
  for (const s of shapes) {
    const c = toWorld(s.x, s.y)
    if (s.t === 'ball') {
      g.circle(c.x, c.y, s.r)
      continue
    }
    if (s.t === 'rrect' || s.t === 'oval') {
      // Both are oriented by (own rotation + body rotation) about their centre c.
      const t = s.a + bodyRot
      const ct = Math.cos(t)
      const st = Math.sin(t)
      const place = (lx: number, ly: number): number[] => [c.x + ct * lx - st * ly, c.y + st * lx + ct * ly]
      const pts: number[] = []
      if (s.t === 'oval') {
        const N = 40
        for (let k = 0; k < N; k++) {
          const th = (2 * Math.PI * k) / N
          pts.push(...place(s.rx * Math.cos(th), s.ry * Math.sin(th)))
        }
      } else {
        const r = Math.min(s.r, s.hx, s.hy)
        const ix = s.hx - r // corner-arc centre offsets
        const iy = s.hy - r
        const N = 8 // samples per corner arc
        const corner = (cxl: number, cyl: number, from: number) => {
          for (let k = 0; k <= N; k++) {
            const th = from + (Math.PI / 2) * (k / N)
            pts.push(...place(cxl + r * Math.cos(th), cyl + r * Math.sin(th)))
          }
        }
        corner(ix, -iy, -Math.PI / 2) // top-right
        corner(ix, iy, 0) // bottom-right
        corner(-ix, iy, Math.PI / 2) // bottom-left
        corner(-ix, -iy, Math.PI) // top-left
      }
      g.poly(pts)
      continue
    }
    // Capsule: the two cap centres sit at ±h along its long axis. Rapier builds the
    // capsule along local +y; rotate (0,1) by (own rotation + body rotation) to get the
    // axis direction in world, then place the caps at ±h along it.
    const ang = s.a + bodyRot
    const ux = -Math.sin(ang)
    const uy = Math.cos(ang)
    const aEnd = { x: c.x - ux * s.h, y: c.y - uy * s.h }
    const bEnd = { x: c.x + ux * s.h, y: c.y + uy * s.h }
    // Trace the stadium outline as a closed polyline (no canvas-arc winding ambiguity).
    const phi = Math.atan2(bEnd.y - aEnd.y, bEnd.x - aEnd.x)
    const pts: number[] = []
    const N = 14
    for (let k = 0; k <= N; k++) {
      const t = phi + PI2 + Math.PI * (k / N) // far cap (around aEnd)
      pts.push(aEnd.x + s.r * Math.cos(t), aEnd.y + s.r * Math.sin(t))
    }
    for (let k = 0; k <= N; k++) {
      const t = phi - PI2 + Math.PI * (k / N) // near cap (around bEnd)
      pts.push(bEnd.x + s.r * Math.cos(t), bEnd.y + s.r * Math.sin(t))
    }
    g.poly(pts)
  }
}

// The unique glyphs in "CELEBRATE your hard work" (order is the editor's tab order).
export const GLYPH_LIST = ['C', 'E', 'L', 'B', 'R', 'A', 'T', 'y', 'o', 'u', 'r', 'h', 'a', 'd', 'w', 'k'] as const

/**
 * Every glyph the dev tools can reach, in tab order: the demo phrase first (GLYPH_LIST), then any
 * other authored hull. Without the second half, glyphs outside the demo phrase would be
 * un-browsable and therefore unverifiable — you could author them but never look at them again.
 * Declared after GLYPH_HULLS below, so it is defined at the bottom of this file.
 */

// ── Collision hulls, placed in /glyph-editor against the real Cherry Bomb One face ──
// (font-size units; origin = glyph centre; +y down). Curved primitives only — ball,
// capsule, rrect (roundCuboid), oval (roundConvexHull) — so packed letters slide and
// never wedge on a corner. To retune: drag in /glyph-editor, then re-bake the export here.
export const GLYPH_HULLS: Record<string, HullShape[]> = {
  C: [{ t: 'oval', x: -0.038, y: -0.008, rx: 0.324, ry: 0.377, a: 0 }],
  E: [{ t: 'cap', x: -0.019, y: -0.005, r: 0.272, h: 0.101, a: 0.001 }],
  L: [
    { t: 'cap', x: -0.178, y: -0.034, r: 0.15, h: 0.195, a: 0.066 },
    { t: 'cap', x: -0.049, y: 0.217, r: 0.13, h: 0.18, a: 1.571 },
  ],
  B: [{ t: 'cap', x: -0.034, y: -0.015, r: 0.313, h: 0.06, a: -0.025 }],
  R: [{ t: 'oval', x: -0.04, y: 0.009, rx: 0.3, ry: 0.386, a: 0 }],
  A: [{ t: 'oval', x: -0.042, y: 0.014, rx: 0.315, ry: 0.393, a: 0 }],
  T: [
    { t: 'cap', x: -0.043, y: -0.222, r: 0.145, h: 0.219, a: 1.576 },
    { t: 'cap', x: -0.041, y: 0.105, r: 0.141, h: 0.115, a: -0.017 },
  ],
  y: [{ t: 'cap', x: -0.058, y: 0.192, r: 0.26, h: 0.086, a: 0.181 }],
  o: [{ t: 'ball', x: -0.044, y: 0.107, r: 0.249 }],
  u: [{ t: 'ball', x: -0.038, y: 0.088, r: 0.26 }],
  r: [
    { t: 'cap', x: -0.166, y: 0.1, r: 0.11, h: 0.135, a: -0.049 },
    { t: 'ball', x: 0.052, y: -0.018, r: 0.132 },
  ],
  h: [
    { t: 'cap', x: -0.2, y: 0, r: 0.12, h: 0.29, a: 0 },
    { t: 'cap', x: 0.109, y: 0.144, r: 0.11, h: 0.15, a: 0 },
    { t: 'cap', x: -0.005, y: -0.038, r: 0.1, h: 0.112, a: 1.573 },
  ],
  a: [{ t: 'ball', x: -0.053, y: 0.132, r: 0.269 }],
  d: [
    { t: 'ball', x: -0.07, y: 0.094, r: 0.24 },
    { t: 'cap', x: 0.083, y: -0.025, r: 0.118, h: 0.23, a: 0 },
  ],
  w: [{ t: 'cap', x: -0.039, y: 0.103, r: 0.262, h: 0.106, a: 1.571 }],
  k: [
    { t: 'cap', x: -0.179, y: 0.012, r: 0.12, h: 0.28, a: 0 },
    { t: 'cap', x: 0.058, y: -0.012, r: 0.1, h: 0.06, a: -2.165 },
    { t: 'cap', x: 0.073, y: 0.187, r: 0.1, h: 0.068, a: -0.541 },
  ],

  // ── Traced for a second wordmark ("Little Striders Running Club") ─────────────────────────
  // Merged in key-wise, never as a wholesale replacement. Note `o` and `a` are deliberately NOT
  // taken from that set: both maps have them, traced independently, and the values differ by
  // ~5% (that wordmark's own lines contain no `o`/`a`, so they were re-traced from scratch for
  // its transition words). Neither is "more correct" — a blind spread would silently clobber
  // whichever was tuned against the demo phrase above.
  i: [{ t: 'oval', x: -0.043, y: -0.023, rx: 0.379, ry: 0.12, a: 1.574 }],
  t: [
    { t: 'cap', x: -0.073, y: -0.016, r: 0.108, h: 0.254, a: -0.009 },
    { t: 'cap', x: -0.06, y: -0.097, r: 0.1, h: 0.175, a: 1.569 },
    { t: 'cap', x: -0.005, y: 0.263, r: 0.1, h: 0.083, a: 1.683 },
  ],
  l: [{ t: 'oval', x: -0.045, y: -0.005, rx: 0.38, ry: 0.12, a: 1.588 }],
  e: [{ t: 'ball', x: -0.035, y: 0.112, r: 0.253 }],
  S: [{ t: 'oval', x: -0.039, y: -0.006, rx: 0.367, ry: 0.286, a: 1.555 }],
  s: [{ t: 'ball', x: -0.045, y: 0.102, r: 0.231 }],
  n: [{ t: 'ball', x: -0.053, y: 0.11, r: 0.266 }],
  g: [{ t: 'ball', x: -0.029, y: 0.149, r: 0.323 }],
  b: [
    { t: 'ball', x: -0.037, y: 0.098, r: 0.262 },
    { t: 'cap', x: -0.184, y: -0.113, r: 0.1, h: 0.166, a: 0.252 },
  ],
  M: [{ t: 'ball', x: -0.039, y: -0.002, r: 0.394 }],
  c: [{ t: 'ball', x: -0.025, y: 0.102, r: 0.246 }],
  J: [
    { t: 'cap', x: -0.006, y: -0.255, r: 0.1, h: 0.192, a: 1.568 },
    { t: 'cap', x: 0.007, y: 0.039, r: 0.136, h: 0.12, a: 0 },
    { t: 'cap', x: -0.184, y: 0.201, r: 0.1, h: 0.125, a: -0.811 },
  ],
  D: [{ t: 'ball', x: -0.062, y: -0.016, r: 0.344 }],
}

/**
 * Hull for a glyph, or a single-ball fallback sized to the grab box (half-extents in u).
 *
 * `hulls` defaults to the bundled map, so every existing 3-argument call is unchanged. Pass your
 * own to run the engine on glyphs this package has never seen — the reason it exists is that an
 * app's authored hulls are ITS data, and vendoring the whole module just to swap the map is what
 * caused the first consumer of this library to fork it.
 */
export function hullForGlyph(
  ch: string,
  hwU: number,
  hhU: number,
  hulls: Record<string, HullShape[]> = GLYPH_HULLS,
): HullShape[] {
  const h = hulls[ch]
  if (h && h.length) return h
  return [{ t: 'ball', x: 0, y: 0, r: Math.max(0.05, Math.min(hwU, hhU) * 0.95) }]
}

/**
 * Bind a hull map once and hand the resulting 3-argument function down into the build path.
 * `buildLetter` calls this per glyph per rebuild, so threading a map through every render layer
 * is noise; binding at the app boundary is not.
 */
export const makeHullForGlyph =
  (hulls: Record<string, HullShape[]>) =>
  (ch: string, hwU: number, hhU: number): HullShape[] =>
    hullForGlyph(ch, hwU, hhU, hulls)

/** @see the doc comment above GLYPH_HULLS. */
export const EDITABLE_GLYPHS: readonly string[] = [...new Set<string>([...GLYPH_LIST, ...Object.keys(GLYPH_HULLS)])]

import { it, beforeAll } from 'vitest'
import {
  createCelebrateWorld,
  stepCelebrate,
  addLetter,
  retargetLetter,
  scatterLetter,
  cullDiscarded,
  removeWalls,
  armEnclosureNow,
  type LetterSpec,
} from './src/celebratePhysics'
import { GLYPH_HULLS, scaleHull } from './src/glyphHulls'
import { ensureRapierInitialized } from './src/lib/physics/rapierInit'

const DT = 1 / 60
const W = 1364, H = 883

// Mirror the component's specFor without canvas: hull from GLYPH_HULLS, box from size heuristics.
function spec(ch: string, x: number, y: number, size: number): LetterSpec {
  const hw = Math.max(8, size * 0.34)
  const hh = Math.max(8, size * 0.4)
  const hull = GLYPH_HULLS[ch] ?? []
  const colliders = hull.length ? scaleHull(hull, size) : []
  return { colliders, hw, hh, slotX: x, slotY: y }
}

beforeAll(async () => { await ensureRapierInitialized() })

it('corner spawn -> thanks morph -> long settle does not panic', async () => {
  const w = await createCelebrateWorld([], W, H, 60, 20)
  // simulate the race: empty world, walls up (post entrance)
  armEnclosureNow(w)
  for (let i = 0; i < 120; i++) stepCelebrate(w, DT)

  // ── corner stage: 7 glyphs materialize at the odometer ──
  removeWalls(w)
  const total = '044,203'
  const sz1 = Math.min(W, H) * 0.11
  const cell = sz1 * 0.62
  let cx = 28 + cell / 2
  const cornerIdx: number[] = []
  for (const ch of total) {
    cornerIdx.push(addLetter(w, spec(ch, cx, 28 + sz1 * 0.65, sz1), true))
    cx += cell
  }
  for (let i = 0; i < 42; i++) stepCelebrate(w, DT) // 0.7s hold

  // ── thanks stage: retarget the 7 + fly in THANK YOU! and the since line ──
  removeWalls(w)
  const lines: Array<[string, number, number]> = [
    ['THANK YOU!', 120, H * 0.4],
    ['', 0, 0], // placeholder—number retargets below
    ['student rosterings since 09/15/2025', 36, H * 0.685],
  ]
  // retarget corner digits to centre
  let nx = W / 2 - (7 * 74) / 2
  cornerIdx.forEach((idx) => { retargetLetter(w, idx, nx, H * 0.56); nx += 74 })
  // fly-ins
  for (const [text, size, y] of lines) {
    if (!text) continue
    let lx = W / 2 - (text.length * size * 0.5) / 2
    for (const ch of text) {
      if (ch !== ' ') addLetter(w, spec(ch, lx, y, size), false)
      lx += size * 0.5
    }
  }
  // step 12 seconds; the live panic hits ~8s after the thanks morph
  for (let i = 0; i < 720; i++) {
    stepCelebrate(w, DT)
    if (i % 60 === 0) cullDiscarded(w)
  }
}, 30000)

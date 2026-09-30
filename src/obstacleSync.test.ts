import { describe, it, expect, beforeAll } from 'vitest'
import { createCelebrateWorld, stepCelebrate, type CelebrateWorld, type ObstaclePose } from './celebratePhysics'
import { createObstacleSync } from './obstacleSync'
import { ensureRapierInitialized } from './lib/physics/rapierInit'

// `sync` decides the component's `busy`: while a mirror moves, the untangle stands down, so a
// letter the mirror pushes is not read as wedged and ghost-driven through it. A mirror whose
// motion never counts gets exactly that ejection loop.

const WAKE = 2
const DT = 1 / 60

async function world(): Promise<CelebrateWorld> {
  return createCelebrateWorld([{ colliders: [{ t: 'ball', x: 0, y: 0, r: 20 }], hw: 20, hh: 20, slotX: 700, slotY: 500 }], 800, 600, 60, 20)
}

const pose = (x: number, y: number, r = 40): ObstaclePose[] => [{ id: 'blob', x, y, r }]

beforeAll(async () => {
  await ensureRapierInitialized()
})

describe('createObstacleSync', () => {
  it('a finite birth is not a move; a jump past wakePx is, and a sub-pixel wobble is not', async () => {
    const s = createObstacleSync(await world(), WAKE)
    expect(s.sync(pose(200, 200))).toBe(false)
    expect(s.sync(pose(200.5, 200))).toBe(false)
    expect(s.sync(pose(205, 200))).toBe(true)
    expect(s.sync(pose(205.5, 200.5))).toBe(false)
  })

  it('a slow drift accumulates into a move instead of hiding under the threshold', async () => {
    const s = createObstacleSync(await world(), WAKE)
    s.sync(pose(200, 200))
    expect(s.sync(pose(201, 200))).toBe(false)
    expect(s.sync(pose(202, 200))).toBe(false)
    expect(s.sync(pose(203, 200))).toBe(true)
  })

  it('a mirror born without a finite pose counts as moving when its first finite pose places it', async () => {
    const w = await world()
    const s = createObstacleSync(w, WAKE)
    expect(s.sync(pose(NaN, NaN))).toBe(false)
    stepCelebrate(w, DT)
    expect(s.sync(pose(400, 150))).toBe(true)
    stepCelebrate(w, DT)
    expect(s.mirrors.get('blob')!.o.body.isEnabled()).toBe(true)
  })

  it('…and from then on it is an ordinary mirror: a wobble is calm, a drift wakes it', async () => {
    const s = createObstacleSync(await world(), WAKE)
    s.sync(pose(NaN, NaN))
    s.sync(pose(400, 150))
    expect(s.sync(pose(400.5, 150))).toBe(false)
    expect(s.sync(pose(401.5, 150))).toBe(false)
    expect(s.sync(pose(403, 150))).toBe(true)
    const e = s.mirrors.get('blob')!
    expect([e.lastX, e.lastY, e.lastR].every(Number.isFinite)).toBe(true)
  })

  it('a mirror born without a finite radius counts as moving when its real radius arrives', async () => {
    const s = createObstacleSync(await world(), WAKE)
    s.sync(pose(200, 200, NaN)) // collider clamped to 1px
    expect(s.sync(pose(200, 200, 40))).toBe(true)
    expect(s.sync(pose(200, 200, 40.5))).toBe(false)
  })

  it('a non-finite frame after a finite one is not a move, and does not unseat the last pose', async () => {
    const s = createObstacleSync(await world(), WAKE)
    s.sync(pose(200, 200))
    expect(s.sync(pose(NaN, NaN, NaN))).toBe(false)
    expect(s.sync(pose(200.5, 200))).toBe(false) // compared with (200, 200), not with NaN
    expect(s.sync(pose(205, 200))).toBe(true)
  })

  it('a pose that disappears takes its mirror out of the world', async () => {
    const w = await world()
    const s = createObstacleSync(w, WAKE)
    s.sync(pose(200, 200))
    const body = s.mirrors.get('blob')!.o.body
    expect(w.world.getRigidBody(body.handle)).toBeTruthy()
    expect(s.sync([])).toBe(false)
    expect(s.mirrors.size).toBe(0)
    expect(w.world.getRigidBody(body.handle)).toBeFalsy()
  })
})

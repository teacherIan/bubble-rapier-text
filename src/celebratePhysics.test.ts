import { describe, it, expect, beforeAll } from 'vitest'
import {
  createCelebrateWorld,
  stepCelebrate,
  armEnclosureNow,
  scatterLetter,
  retargetLetter,
  exitCelebrate,
  resizeWorld,
  removeWalls,
  type CelebrateWorld,
  type LetterSpec,
} from './celebratePhysics'
import { ensureRapierInitialized } from './lib/physics/rapierInit'

// Integration tests against a REAL Rapier world (the compat build runs fine under node).
// These cover the idle gate, whose whole value is that a host can stop its ticker — a bug here
// is invisible in a screenshot and shows up only as a phone that never stops animating.

const DT = 1 / 60

const atSlot = (x: number, y: number): LetterSpec => ({
  colliders: [{ t: 'ball', x: 0, y: 0, r: 20 }],
  hw: 20,
  hh: 20,
  slotX: x,
  slotY: y,
})

/**
 * A world whose letters are already parked on their slots. Letters normally spawn OUTSIDE the
 * screen and fly in, which would take hundreds of steps to settle; snapping them home keeps these
 * tests about the idle gate rather than about the entrance.
 */
async function settledWorld(specs: LetterSpec[]): Promise<CelebrateWorld> {
  const w = await createCelebrateWorld(specs, 800, 600, 60, 20)
  for (const L of w.letters) {
    L.body.setTranslation({ x: L.tx, y: L.ty }, true)
    L.body.setRotation(0, true)
    L.body.setLinvel({ x: 0, y: 0 }, true)
    L.body.setAngvel(0, true)
  }
  return w
}

beforeAll(async () => {
  await ensureRapierInitialized()
})

describe('settledFrames (the idle gate)', () => {
  it('stays at 0 while the entrance is still running', async () => {
    const w = await settledWorld([atSlot(400, 300)])
    for (let i = 0; i < 30; i++) stepCelebrate(w, DT)
    // The cage goes up only after WALL_DELAY_MS; until then the entrance is in flight.
    expect(w.wallsAdded).toBe(false)
    expect(w.settledFrames).toBe(0)
  })

  it('accumulates once the cage is up and the letters are home', async () => {
    const w = await settledWorld([atSlot(400, 300)])
    armEnclosureNow(w)
    for (let i = 0; i < 30; i++) stepCelebrate(w, DT)
    expect(w.wallsAdded).toBe(true)
    expect(w.settledFrames).toBeGreaterThan(20)
  })

  it('resets the moment a letter is knocked out of place', async () => {
    const w = await settledWorld([atSlot(400, 300)])
    armEnclosureNow(w)
    for (let i = 0; i < 30; i++) stepCelebrate(w, DT)
    expect(w.settledFrames).toBeGreaterThan(0)

    retargetLetter(w, 0, 100, 100) // new slot, far away — it must fly there
    stepCelebrate(w, DT)
    expect(w.settledFrames).toBe(0)
  })

  it('does not idle while a letter is still flying off-screen', async () => {
    const w = await settledWorld([atSlot(400, 300)])
    armEnclosureNow(w)
    for (let i = 0; i < 30; i++) stepCelebrate(w, DT)
    scatterLetter(w, 0)
    for (let i = 0; i < 10; i++) stepCelebrate(w, DT)
    // A discarded letter is still in flight — the host must keep stepping or it freezes mid-air.
    expect(w.settledFrames).toBe(0)
  })

  it('does not idle while the host reports itself busy', async () => {
    const w = await settledWorld([atSlot(400, 300)])
    armEnclosureNow(w)
    for (let i = 0; i < 30; i++) stepCelebrate(w, DT, true)
    expect(w.settledFrames).toBe(0)
    // …and resumes settling as soon as the host stops being busy.
    for (let i = 0; i < 30; i++) stepCelebrate(w, DT)
    expect(w.settledFrames).toBeGreaterThan(0)
  })

  it('resets while exiting (letters are falling off-screen)', async () => {
    const w = await settledWorld([atSlot(400, 300)])
    armEnclosureNow(w)
    for (let i = 0; i < 30; i++) stepCelebrate(w, DT)
    expect(w.settledFrames).toBeGreaterThan(0)
    exitCelebrate(w)
    stepCelebrate(w, DT)
    expect(w.settledFrames).toBe(0)
  })
})

describe('armEnclosureNow', () => {
  it('puts the cage up immediately, skipping the entrance delay', async () => {
    const w = await settledWorld([atSlot(400, 300)])
    expect(w.wallsAdded).toBe(false)
    armEnclosureNow(w)
    expect(w.wallsAdded).toBe(true)
    expect(w.floorBody).not.toBeNull()
    expect(w.walls.length).toBeGreaterThan(0)
  })

  it('is a no-op once the cage is already up (no duplicate walls)', async () => {
    const w = await settledWorld([atSlot(400, 300)])
    armEnclosureNow(w)
    const n = w.walls.length
    const floor = w.floorBody
    armEnclosureNow(w)
    expect(w.walls.length).toBe(n)
    expect(w.floorBody).toBe(floor)
  })
})

describe('wall-cage lifetime', () => {
  // createWallCage returns `floor: bottom`, and `bottom` is also an element of `walls`. Anything
  // that frees the floor on its own must drop it from `walls` too, or the next teardown frees it
  // twice — which panics the Rapier WASM module rather than throwing something catchable.
  it('survives exit followed by a resize (double-free of the floor)', async () => {
    const w = await settledWorld([atSlot(400, 300)])
    armEnclosureNow(w)
    expect(w.walls).toContain(w.floorBody)

    exitCelebrate(w)
    expect(w.floorBody).toBeNull()
    expect(w.walls).toHaveLength(3) // floor spliced out — the other three survive

    // The shipped component calls this from its ResizeObserver; a phone URL-bar collapse is enough.
    expect(() => resizeWorld(w, 500, 400, 60, 20)).not.toThrow()
    stepCelebrate(w, DT)
  })

  it('survives exit followed by removeWalls', async () => {
    const w = await settledWorld([atSlot(400, 300)])
    armEnclosureNow(w)
    exitCelebrate(w)
    expect(() => removeWalls(w)).not.toThrow()
  })

  it('survives removeWalls followed by exit (the reverse order)', async () => {
    const w = await settledWorld([atSlot(400, 300)])
    armEnclosureNow(w)
    removeWalls(w)
    expect(() => exitCelebrate(w)).not.toThrow()
  })

  it('resizes repeatedly without freeing a wall twice', async () => {
    const w = await settledWorld([atSlot(400, 300)])
    armEnclosureNow(w)
    for (let i = 0; i < 5; i++) {
      expect(() => resizeWorld(w, 400 + i * 50, 300 + i * 40, 60, 20)).not.toThrow()
      stepCelebrate(w, DT)
    }
    expect(w.walls).toHaveLength(4)
  })
})

describe('reclaiming a flung letter', () => {
  it('restores damping so it settles, and the idle gate can fire again', async () => {
    const w = await settledWorld([atSlot(400, 300)])
    armEnclosureNow(w)
    for (let i = 0; i < 20; i++) stepCelebrate(w, DT)
    expect(w.settledFrames).toBeGreaterThan(0)

    // Fling it, then claim it back — scatterLetter zeroes linear damping so gravity can carry the
    // letter off-screen, and retargetLetter must hand back a body that behaves like a fresh one.
    scatterLetter(w, 0)
    stepCelebrate(w, DT)
    retargetLetter(w, 0, 400, 300)
    expect(w.letters[0].discarded).toBe(false)
    expect(w.letters[0].body.linearDamping()).toBeGreaterThan(0)

    // It must actually come to rest — without the restore it oscillates forever and `calm` is
    // never true, so the host's ticker could never stop.
    for (let i = 0; i < 600; i++) stepCelebrate(w, DT)
    expect(w.settledFrames).toBeGreaterThan(0)
  })
})

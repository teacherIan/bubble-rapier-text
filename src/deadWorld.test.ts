import { describe, it, expect, beforeAll, vi } from 'vitest'
import {
  createCelebrateWorld,
  stepCelebrate,
  armEnclosureNow,
  exitCelebrate,
  removeWalls,
  resizeLetterColliders,
  resizeWorld,
  retargetLetter,
  scatterLetter,
  cullDiscarded,
  addLetter,
  removeLetter,
  solidifyLetter,
  startLetterDrag,
  moveDrag,
  releaseDrag,
  addObstacle,
  removeObstacle,
  startBodyDrag,
  endBodyDrag,
  setWallGroups,
  type CelebrateWorld,
  type LetterSpec,
  type MouseJoint,
  type Obstacle,
} from './celebratePhysics'
import { ensureRapierInitialized } from './lib/physics/rapierInit'
import { safeFreeWorld } from './lib/safeFreeWorld'

// A world whose wasm has panicked is marked `dead` by stepCelebrate and must never be touched
// again: after the trap, the raw sets are left borrowed and every call into them throws. In the
// component that throw lands in a React effect (a host flipping `exiting`, a phrase change) and
// takes out the host's error boundary. This file poisons its own worlds, so it runs apart from
// the main suite.

const DT = 1 / 60

const atSlot = (x: number, y: number): LetterSpec => ({
  colliders: [{ t: 'ball', x: 0, y: 0, r: 20 }],
  hw: 20,
  hh: 20,
  slotX: x,
  slotY: y,
})

interface Poisoned {
  w: CelebrateWorld
  o: Obstacle
  m: MouseJoint
}

type Model = 'double free' | 'mid-step panic'

// Two models of a dead world. A double free is a genuine wasm trap, but it leaves only the BODY set
// mid-borrow. A panic inside world.step() leaves every set borrowed, so every read and write throws;
// freeing the world reproduces that (every access then throws "null pointer passed to rust").
async function poisonedWorld(model: Model = 'double free'): Promise<Poisoned> {
  const w = await createCelebrateWorld([atSlot(400, 300), atSlot(300, 300)], 800, 600, 60, 20)
  for (const L of w.letters) {
    L.body.setTranslation({ x: L.tx, y: L.ty }, true)
    L.body.setLinvel({ x: 0, y: 0 }, true)
  }
  armEnclosureNow(w)
  for (let i = 0; i < 10; i++) stepCelebrate(w, DT)
  const o = addObstacle(w, 100, 100, 20)
  const prop = w.world.createRigidBody(w.rapier.RigidBodyDesc.dynamic().setTranslation(600, 100))
  const m = startBodyDrag(w, prop, 0, 0, 600, 100)
  if (model === 'mid-step panic') {
    w.dead = true // what stepCelebrate's catch sets
    w.world.free()
    expect(() => w.letters[0].body.translation(), 'precondition: every access throws').toThrow()
    return { w, o, m }
  }
  // Poison it the way production died — a wasm panic. A double free is a reliable trigger (see
  // WallCage.floor); the trap leaves the body set mid-borrow.
  const doomed = w.world.createRigidBody(w.rapier.RigidBodyDesc.fixed())
  w.world.removeRigidBody(doomed)
  expect(() => w.world.removeRigidBody(doomed)).toThrow()
  const err = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    stepCelebrate(w, DT)
  } finally {
    err.mockRestore()
  }
  expect(w.dead, 'precondition: the step caught the panic and froze the world').toBe(true)
  return { w, o, m }
}

beforeAll(async () => {
  await ensureRapierInitialized()
})

describe('a dead world: public mutators are no-ops', () => {
  const cases: Array<[string, (p: Poisoned) => unknown]> = [
    ['exitCelebrate', ({ w }) => exitCelebrate(w)],
    ['removeWalls', ({ w }) => removeWalls(w)],
    ['resizeLetterColliders', ({ w }) => resizeLetterColliders(w, 0, [{ t: 'ball', x: 0, y: 0, r: 30 }])],
    ['removeObstacle', ({ w, o }) => removeObstacle(w, o)],
    ['endBodyDrag', ({ w, m }) => endBodyDrag(w, m)],
    ['setWallGroups', ({ w }) => setWallGroups(w, 0x00010001)],
    ['setWallGroups(null)', ({ w }) => setWallGroups(w, null)],
    // Already guarded before this file existed — kept so the whole contract is pinned in one place.
    ['stepCelebrate', ({ w }) => stepCelebrate(w, DT)],
    ['armEnclosureNow', ({ w }) => armEnclosureNow(w)],
    ['resizeWorld', ({ w }) => resizeWorld(w, 900, 700, 60, 20)],
    ['retargetLetter', ({ w }) => retargetLetter(w, 0, 10, 10)],
    ['scatterLetter', ({ w }) => scatterLetter(w, 0)],
    ['cullDiscarded', ({ w }) => cullDiscarded(w)],
    ['addLetter', ({ w }) => addLetter(w, atSlot(10, 10))],
    ['removeLetter', ({ w }) => removeLetter(w, 0)],
    ['solidifyLetter', ({ w }) => solidifyLetter(w, 0)],
    ['startLetterDrag', ({ w }) => startLetterDrag(w, 0, 0, 0, 10, 10)],
    ['moveDrag', ({ w }) => moveDrag(w, 10, 10)],
    ['releaseDrag', ({ w }) => releaseDrag(w)],
  ]
  const models: Model[] = ['double free', 'mid-step panic']
  const matrix = models.flatMap((model) => cases.map(([name, call]) => [name, model, call] as const))
  it.each(matrix)('%s does not touch the poisoned wasm (%s)', async (_name, model, call) => {
    const p = await poisonedWorld(model)
    expect(() => call(p)).not.toThrow()
  })

  it('exitCelebrate on a dead world leaves it frozen, not half-exited', async () => {
    const { w } = await poisonedWorld()
    exitCelebrate(w)
    expect(w.exiting).toBe(false)
  })
})

// The component frees its world in a React cleanup (unmount, <Activity> hide) and on a cancelled
// build. A throw there reaches the host's error boundary, or with none, unmounts the host's root.
describe('safeFreeWorld', () => {
  const models: Model[] = ['double free', 'mid-step panic']
  it.each(models)('never throws on a dead world, and says nothing (%s)', async (model) => {
    const bare = await poisonedWorld(model)
    expect(() => bare.w.world.free(), 'precondition: a bare free() throws on this world').toThrow()
    const { w } = await poisonedWorld(model)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(() => safeFreeWorld(w)).not.toThrow()
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('frees a live world', async () => {
    const w = await createCelebrateWorld([atSlot(400, 300)], 800, 600, 60, 20)
    safeFreeWorld(w)
    expect(() => w.letters[0].body.translation()).toThrow()
  })

  it('swallows a throw from a world that is not dead, and logs it', async () => {
    const w = await createCelebrateWorld([atSlot(400, 300)], 800, 600, 60, 20)
    safeFreeWorld(w)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(() => safeFreeWorld(w)).not.toThrow() // a second free throws inside Rapier
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })
})

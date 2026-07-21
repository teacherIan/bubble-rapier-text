import { describe, it, expect, beforeAll } from 'vitest'
import {
  createCelebrateWorld,
  stepCelebrate,
  armEnclosureNow,
  scatterLetter,
  cullDiscarded,
  retargetLetter,
  exitCelebrate,
  resizeWorld,
  removeWalls,
  startLetterDrag,
  releaseDrag,
  addObstacle,
  moveObstacle,
  removeObstacle,
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

    // …and not throwing is only half the contract. The exit removed the floor SO THE LETTERS CAN
    // LEAVE; a rebuilt cage would hand back a new one (walls.length is 3, still truthy) and they
    // would land instead.
    expect(w.floorBody, 'a resize during an exit must not resurrect the floor').toBeNull()
    for (let i = 0; i < 240; i++) stepCelebrate(w, DT)
    expect(w.letters[0].body.translation().y, 'letters must still fall out of the bottom').toBeGreaterThan(w.h)
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

describe('the self-freeing untangle', () => {
  // The flagship invariant: a letter that cannot reach its slot by springs alone must ALWAYS be
  // freed and driven home. Both triggers are covered, because each exists to close a hole the
  // other leaves — and a regression here is invisible until a wordmark silently renders wrong.

  /** Pin a letter far from its slot so the springs cannot resolve it. */
  const wedge = (w: CelebrateWorld, i: number, x: number, y: number) => {
    const b = w.letters[i].body
    b.setTranslation({ x, y }, true)
    b.setLinvel({ x: 0, y: 0 }, true)
    b.setAngvel(0, true)
  }

  it('frees a PARKED, out-of-place letter (the fast path)', async () => {
    const w = await settledWorld([atSlot(400, 300)])
    armEnclosureNow(w)
    const L = w.letters[0]

    // Hold it far from its slot and motionless every frame — the wedged case.
    for (let i = 0; i < 60; i++) {
      wedge(w, 0, 100, 100)
      stepCelebrate(w, DT)
      if (L.ghost) break
    }
    expect(L.ghost, 'a parked out-of-place letter must be ghosted for the glide').toBe(true)
  })

  it('drives a freed letter home and re-solidifies it', async () => {
    const w = await settledWorld([atSlot(400, 300)])
    armEnclosureNow(w)
    const L = w.letters[0]
    for (let i = 0; i < 60 && !L.ghost; i++) {
      wedge(w, 0, 100, 100)
      stepCelebrate(w, DT)
    }
    expect(L.ghost).toBe(true)

    // Now let it glide: the pose is DRIVEN, so it converges without any spring help.
    for (let i = 0; i < 200 && L.ghost; i++) stepCelebrate(w, DT)
    const p = L.body.translation()
    expect(Math.hypot(p.x - L.tx, p.y - L.ty)).toBeLessThan(w.unghostDist + 1)
    expect(L.ghost, 'it must hand back to the springs once home + upright').toBe(false)
  })

  it('frees a letter that is jostled and never parks (the watchdog)', async () => {
    const w = await settledWorld([atSlot(400, 300)])
    armEnclosureNow(w)
    const L = w.letters[0]
    for (let i = 0; i < 30; i++) stepCelebrate(w, DT) // arrive once, arming the watchdog
    expect(L.arrivedOnce).toBe(true)

    // Held out of place but ALWAYS moving faster than PARK_V, so the fast path can never fire.
    for (let i = 0; i < 400 && !L.ghost; i++) {
      L.body.setTranslation({ x: 100, y: 100 }, true)
      L.body.setLinvel({ x: 400, y: 0 }, true) // well above PARK_V (95)
      stepCelebrate(w, DT)
    }
    expect(L.ghost, 'a jostled letter never parks — the watchdog must still free it').toBe(true)
  })

  it('does not fight the user: no untangle while a letter is held', async () => {
    const w = await settledWorld([atSlot(400, 300)])
    armEnclosureNow(w)
    startLetterDrag(w, 0, 0, 0, 100, 100)
    const L = w.letters[0]
    for (let i = 0; i < 200; i++) {
      wedge(w, 0, 100, 100)
      stepCelebrate(w, DT)
    }
    // Ghosting a letter pressed against a held one ejects it violently when it re-solidifies.
    expect(L.ghost).toBe(false)
    releaseDrag(w)
  })

  it('does not fight the host either: `busy` stands the untangle down (for an ARRIVED letter)', async () => {
    const w = await settledWorld([atSlot(400, 300)])
    armEnclosureNow(w)
    const L = w.letters[0]
    for (let i = 0; i < 30; i++) stepCelebrate(w, DT) // arrive properly first —
    // busy protects letters the host displaced, not fly-ins it is blocking
    // (a never-arrived letter keeps its untangle rights; see the suite below).
    for (let i = 0; i < 200; i++) {
      wedge(w, 0, 100, 100)
      stepCelebrate(w, DT, true) // host is holding one of its own bodies over the letters
    }
    expect(L.ghost).toBe(false)
  })

  it('does not cut short a letter that has never arrived (a fly-in)', async () => {
    const w = await createCelebrateWorld([atSlot(400, 300)], 800, 600, 60, 20)
    armEnclosureNow(w)
    const L = w.letters[0]
    expect(L.arrivedOnce).toBe(false)
    // It spawns off-screen and flies in. The watchdog must stay disarmed the whole way, or the
    // dramatic entrance gets replaced by a teleport.
    for (let i = 0; i < 100; i++) {
      L.body.setLinvel({ x: 300, y: 0 }, true) // in flight, never parked
      stepCelebrate(w, DT)
      if (L.arrivedOnce) break
      expect(L.ghost, 'a never-arrived letter must not be freed mid-flight').toBe(false)
    }
  })
})

describe('scatterLetter fling styles', () => {
  it('flings SOLID by default — the bonk (collider enabled, not ghosted)', async () => {
    const w = await settledWorld([atSlot(400, 300)])
    armEnclosureNow(w)
    scatterLetter(w, 0)
    const L = w.letters[0]
    expect(L.discarded).toBe(true)
    expect(L.ghost, 'a solid fling keeps collisions on so it bonks the forming word').toBe(false)
    // it is actually moving off, not frozen
    const v = L.body.linvel()
    expect(Math.hypot(v.x, v.y)).toBeGreaterThan(100)
  })

  it('flings pass-through when solid:false — the calm morph', async () => {
    const w = await settledWorld([atSlot(400, 300)])
    armEnclosureNow(w)
    scatterLetter(w, 0, { solid: false })
    expect(w.letters[0].ghost, 'solid:false passes through everything from frame one').toBe(true)
  })

  it('a solid straggler drops to pass-through after its bonk window, so it can escape', async () => {
    const w = await settledWorld([atSlot(400, 300)])
    armEnclosureNow(w)
    scatterLetter(w, 0) // solid
    const L = w.letters[0]
    // Pin it on-screen so it cannot leave on its own — the wedged-straggler case.
    for (let i = 0; i < 200; i++) {
      L.body.setTranslation({ x: 400, y: 300 }, true)
      stepCelebrate(w, DT)
      if (L.ghost) break
    }
    expect(L.ghost, 'a solid straggler must phase to pass-through so it stops disturbing the word').toBe(true)
  })

  it('a flung letter still gets culled off-screen regardless of style', async () => {
    const w = await settledWorld([atSlot(400, 300)])
    armEnclosureNow(w)
    scatterLetter(w, 0)
    // let it fly; it should leave and be culled
    for (let i = 0; i < 300; i++) {
      stepCelebrate(w, DT)
      if (cullDiscarded(w).length) break
    }
    expect(w.letters).toHaveLength(0)
  })
})

describe('host obstacles (kinematic mirrors)', () => {
  it('a mirror swept through a settled letter shoves it aside', async () => {
    const w = await settledWorld([atSlot(400, 300)])
    armEnclosureNow(w)
    for (let i = 0; i < 30; i++) stepCelebrate(w, DT) // settle on the slot
    const before = w.letters[0].body.translation()

    // Sweep a 60px mirror through the slot from the left, at mirror-motion `busy`.
    const o = addObstacle(w, 200, 300, 60)
    for (let i = 0; i < 90; i++) {
      moveObstacle(o, 200 + i * 4, 300) // 240 px/s — arrives at the slot around frame 50
      stepCelebrate(w, DT, true)
    }
    const during = w.letters[0].body.translation()
    const pushed = Math.hypot(during.x - before.x, during.y - before.y)
    expect(pushed, 'the letter must be shoved off its slot by the passing mirror').toBeGreaterThan(30)
    expect(w.letters[0].ghost, 'busy stands the untangle down — the letter must never ghost through the mirror').toBe(false)

    // Mirror leaves + goes still: the slot spring brings the letter home and the world re-settles.
    removeObstacle(w, o)
    for (let i = 0; i < 600 && w.settledFrames < 30; i++) stepCelebrate(w, DT)
    expect(w.settledFrames, 'the world must re-settle once the mirror is gone').toBeGreaterThanOrEqual(30)
  })

  it('a breathing mirror resizes in place without recreating the handle', async () => {
    const w = await settledWorld([atSlot(400, 300)])
    const o = addObstacle(w, 100, 100, 40)
    moveObstacle(o, 100, 100, 40.2) // sub-pixel breath — skipped
    expect(o.r).toBe(40)
    moveObstacle(o, 100, 100, 55) // real growth — applied
    expect(o.r).toBe(55)
    removeObstacle(w, o)
  })
})

describe('busy vs transition fly-ins', () => {
  it('a never-arrived letter blocked under persistent busy still ghosts home', async () => {
    const w = await settledWorld([atSlot(400, 300)])
    armEnclosureNow(w)
    for (let i = 0; i < 30; i++) stepCelebrate(w, DT)
    // A fly-in: retarget marks it never-arrived; park it far from its slot, as
    // if pressed against an obstacle field it cannot push through.
    retargetLetter(w, 0, 400, 300)
    const L = w.letters[0]
    L.body.setTranslation({ x: 60, y: 60 }, true)
    for (let i = 0; i < 120 && !L.ghost; i++) {
      L.body.setTranslation({ x: 60, y: 60 }, true)
      L.body.setLinvel({ x: 0, y: 0 }, true)
      stepCelebrate(w, DT, true) // busy the WHOLE time (a wobbling mirror field)
    }
    expect(L.ghost, 'a blocked fly-in must ghost-glide home even under busy').toBe(true)
  })

  it('an ARRIVED letter pressed under busy is left alone (no ghost-through)', async () => {
    const w = await settledWorld([atSlot(400, 300)])
    armEnclosureNow(w)
    for (let i = 0; i < 30; i++) stepCelebrate(w, DT) // arrive properly
    const L = w.letters[0]
    for (let i = 0; i < 120; i++) {
      L.body.setTranslation({ x: 200, y: 300 }, true) // shoved off + held by a "prop"
      L.body.setLinvel({ x: 0, y: 0 }, true)
      stepCelebrate(w, DT, true)
    }
    expect(L.ghost, 'busy must stand the untangle down for an arrived letter').toBe(false)
  })
})

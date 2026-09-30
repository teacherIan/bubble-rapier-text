import { describe, it, expect, beforeAll, vi } from 'vitest'
import {
  createCelebrateWorld,
  stepCelebrate,
  armEnclosureNow,
  scatterLetter,
  cullDiscarded,
  retargetLetter,
  resizeLetterColliders,
  exitCelebrate,
  resizeWorld,
  removeWalls,
  startLetterDrag,
  moveDrag,
  releaseDrag,
  startBodyDrag,
  moveBodyDrag,
  endBodyDrag,
  addLetter,
  setWallGroups,
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

describe('addLetter spawn placement', () => {
  it('default: spawns OUTSIDE the viewport (the fly-in entrance)', async () => {
    const w = await settledWorld([atSlot(400, 300)])
    const i = addLetter(w, atSlot(200, 200))
    const p = w.letters[i].body.translation()
    const inside = p.x >= 0 && p.x <= w.w && p.y >= 0 && p.y <= w.h
    expect(inside).toBe(false)
  })

  it('atSlot: materializes exactly at its slot, upright and at rest', async () => {
    const w = await settledWorld([atSlot(400, 300)])
    const i = addLetter(w, atSlot(200, 200), true)
    const L = w.letters[i]
    const p = L.body.translation()
    expect(p.x).toBeCloseTo(200)
    expect(p.y).toBeCloseTo(200)
    expect(L.body.rotation()).toBeCloseTo(0)
    const v = L.body.linvel()
    expect(Math.hypot(v.x, v.y)).toBeLessThan(0.001)
  })
})

describe('idle-gate velocity term (ported from little_striders)', () => {
  it('a letter ON its slot but spinning fast is not calm', async () => {
    const w = await settledWorld([atSlot(400, 300)])
    armEnclosureNow(w)
    for (let i = 0; i < 10; i++) stepCelebrate(w, DT)
    expect(w.settledFrames).toBeGreaterThan(0) // baseline: at rest on slot = calm
    w.letters[0].body.setAngvel(8, true) // in place, upright-ish, but visibly spinning
    stepCelebrate(w, DT)
    expect(w.settledFrames).toBe(0)
  })
})

describe('setWallGroups', () => {
  it('stamps the cage now and again after a resize rebuild', async () => {
    const w = await settledWorld([atSlot(400, 300)])
    armEnclosureNow(w)
    const GROUPS = 0x00020001 // membership 1, filter 2 — arbitrary non-default
    setWallGroups(w, GROUPS)
    const groupsOf = (body: NonNullable<CelebrateWorld['floorBody']>) => {
      const out: number[] = []
      for (let i = 0; i < body.numColliders(); i++) out.push(body.collider(i).collisionGroups())
      return out
    }
    expect(groupsOf(w.floorBody!)).toContain(GROUPS)
    for (const wall of w.walls) expect(groupsOf(wall)).toContain(GROUPS)
    // The cage is REBUILT on resize — the stamp must survive it.
    resizeWorld(w, 900, 700, 60, 20)
    expect(groupsOf(w.floorBody!)).toContain(GROUPS)
    for (const wall of w.walls) expect(groupsOf(wall)).toContain(GROUPS)
  })
})

describe('resizeLetterColliders', () => {
  it('rebuilds a survivor body at the new size, so its cached mass tracks the new hull', async () => {
    // The bug: on a size-changing morph, retargetLetter moves a survivor but
    // leaves its hull (and cached mass/inertia) frozen at the CREATE size, so it
    // collides as its old, too-large self and never settles.
    const w = await settledWorld([atSlot(400, 300)]) // one ball collider, r=20
    const L = w.letters[0]
    const massBefore = L.mass
    expect(L.body.numColliders()).toBe(1)

    resizeLetterColliders(w, 0, [{ t: 'ball', x: 0, y: 0, r: 40 }]) // 2x radius
    expect(L.body.numColliders()).toBe(1)
    // A ball of 2x the radius has ~4x the area -> ~4x the mass at density 1; the
    // cached mass the springs read must reflect it (it was frozen before).
    expect(L.mass).toBeGreaterThan(massBefore * 3)
    expect(L.mass).toBe(L.body.mass()) // cache is in sync with the body
  })

  it('replaces the WHOLE collider set (a 3-piece hull becomes 1)', async () => {
    const w = await settledWorld([
      {
        colliders: [
          { t: 'ball', x: 0, y: 0, r: 20 },
          { t: 'ball', x: 12, y: 0, r: 14 },
          { t: 'ball', x: -12, y: 0, r: 14 },
        ],
        hw: 20,
        hh: 20,
        slotX: 400,
        slotY: 300,
      },
    ])
    expect(w.letters[0].body.numColliders()).toBe(3)
    resizeLetterColliders(w, 0, [{ t: 'ball', x: 0, y: 0, r: 30 }])
    expect(w.letters[0].body.numColliders()).toBe(1) // old ones all removed
  })

  it('is a no-op on an empty hull (never strips a body to zero colliders)', async () => {
    const w = await settledWorld([atSlot(400, 300)])
    resizeLetterColliders(w, 0, [])
    expect(w.letters[0].body.numColliders()).toBe(1)
  })
})

/** The cached mass/inertia of a letter BUILT with a single ball of radius r — what a resize to that
 *  hull must reproduce. */
async function freshLetter(r: number): Promise<{ mass: number; inertia: number }> {
  const w = await createCelebrateWorld([{ ...atSlot(400, 300), colliders: [{ t: 'ball', x: 0, y: 0, r }] }], 800, 600, 60, 20)
  const { mass, inertia } = w.letters[0]
  w.world.free()
  return { mass, inertia }
}

// Rapier adds a new collider's mass to its body at once but takes a removed collider's out only at
// the next step, so a read straight after the rebuild counted the old hull and the new one together.
// Every survivor of a morph is resized, and the slot spring scales by the cached mass.
describe('resizeLetterColliders caches the NEW hull\'s mass, not old + new', () => {
  it('a same-size resize leaves the cached mass and inertia unchanged', async () => {
    const w = await settledWorld([atSlot(400, 300)]) // r=20
    const L = w.letters[0]
    const fresh = await freshLetter(20)
    resizeLetterColliders(w, 0, [{ t: 'ball', x: 0, y: 0, r: 20 }])
    expect(L.mass).toBeCloseTo(fresh.mass, 3)
    expect(L.inertia).toBeCloseTo(fresh.inertia, 0)
  })

  it('a shrink caches the smaller hull', async () => {
    const w = await settledWorld([{ ...atSlot(400, 300), colliders: [{ t: 'ball', x: 0, y: 0, r: 30 }] }])
    const L = w.letters[0]
    const fresh = await freshLetter(20)
    resizeLetterColliders(w, 0, [{ t: 'ball', x: 0, y: 0, r: 20 }])
    expect(L.mass).toBeCloseTo(fresh.mass, 3)
    expect(L.inertia).toBeCloseTo(fresh.inertia, 0)
  })

  it('the body agrees after the next step (the removed hull is not taken out twice)', async () => {
    const w = await settledWorld([{ ...atSlot(400, 300), colliders: [{ t: 'ball', x: 0, y: 0, r: 30 }] }])
    const L = w.letters[0]
    const fresh = await freshLetter(20)
    resizeLetterColliders(w, 0, [{ t: 'ball', x: 0, y: 0, r: 20 }])
    stepCelebrate(w, DT)
    expect(L.body.mass()).toBeCloseTo(fresh.mass, 3)
    expect(L.body.principalInertia()).toBeCloseTo(fresh.inertia, 0)
  })
})

describe('exit idle gate', () => {
  it('lets settledFrames accumulate once the exit letters clear the bottom', async () => {
    const w = await settledWorld([atSlot(400, 300)])
    armEnclosureNow(w)
    exitCelebrate(w)
    // Fall off the bottom (the exit opens the floor and lets gravity take them).
    for (let i = 0; i < 400; i++) stepCelebrate(w, DT)
    expect(w.letters[0].body.translation().y).toBeGreaterThan(w.h) // gone off-screen
    // Old behavior pinned settledFrames=0 forever while exiting -> the host
    // ticker could never idle. Now it accumulates once the letters are gone.
    expect(w.settledFrames).toBeGreaterThan(0)
  })
})

describe('re-caging after removeWalls', () => {
  it('armEnclosureNow rebuilds the cage that removeWalls tore down', async () => {
    const w = await settledWorld([atSlot(400, 300)])
    armEnclosureNow(w)
    expect(w.walls.length).toBeGreaterThan(0)
    removeWalls(w) // a morph opens every edge; wallsAdded stays true, walls emptied
    expect(w.walls.length).toBe(0)
    armEnclosureNow(w) // must REBUILD, not no-op on the stale wallsAdded flag
    expect(w.walls.length).toBeGreaterThan(0)
    expect(w.floorBody).not.toBeNull()
  })
})

/** Pin a letter far from its slot until the untangle ghosts it (the glide-home state). */
function ghostByWedging(w: CelebrateWorld, i: number): void {
  const L = w.letters[i]
  for (let k = 0; k < 60 && !L.ghost; k++) {
    L.body.setTranslation({ x: 100, y: 100 }, true)
    L.body.setLinvel({ x: 0, y: 0 }, true)
    L.body.setAngvel(0, true)
    stepCelebrate(w, DT)
  }
  expect(L.ghost, 'precondition: the letter is gliding home as a ghost').toBe(true)
}

describe("resizeLetterColliders keeps the letter's collision mode", () => {
  it('a ghost gliding home keeps its new colliders disabled', async () => {
    const w = await settledWorld([atSlot(400, 300)])
    armEnclosureNow(w)
    ghostByWedging(w, 0)
    const L = w.letters[0]
    resizeLetterColliders(w, 0, [{ t: 'ball', x: 0, y: 0, r: 30 }])
    // Solid colliders on a DRIVEN body shove every neighbour it is teleported through.
    for (let i = 0; i < L.body.numColliders(); i++) expect(L.body.collider(i).isEnabled()).toBe(false)
    expect(L.ghost).toBe(true)
    // The cached mass is the new hull's, read before the colliders were disabled.
    const fresh = await freshLetter(30)
    expect(L.mass).toBeCloseTo(fresh.mass, 3)
    expect(L.inertia).toBeCloseTo(fresh.inertia, 0)
  })

  it('a pass-through flung letter keeps colliding with nothing', async () => {
    const w = await settledWorld([atSlot(400, 300)])
    armEnclosureNow(w)
    scatterLetter(w, 0, { solid: false })
    const L = w.letters[0]
    resizeLetterColliders(w, 0, [{ t: 'ball', x: 0, y: 0, r: 30 }])
    for (let i = 0; i < L.body.numColliders(); i++) {
      expect(L.body.collider(i).isEnabled()).toBe(true) // keeps its mass, so gravity still carries it off
      expect(L.body.collider(i).collisionGroups()).toBe(0)
    }
  })
})

describe('setWallGroups(null)', () => {
  it('restores the default groups on the cage that is up now, not only on the next rebuild', async () => {
    const w = await settledWorld([atSlot(400, 300)])
    armEnclosureNow(w)
    setWallGroups(w, 0x00020001)
    setWallGroups(w, null)
    for (const wall of w.walls) {
      for (let i = 0; i < wall.numColliders(); i++) expect(wall.collider(i).collisionGroups() >>> 0).toBe(0xffffffff)
    }
  })
})

describe('exit', () => {
  it('a letter cannot be grabbed mid-exit (the anchor would hang it in the air)', async () => {
    const w = await settledWorld([atSlot(400, 300)])
    armEnclosureNow(w)
    exitCelebrate(w)
    startLetterDrag(w, 0, 0, 0, 400, 300)
    expect(w.drag).toBeNull()
    for (let i = 0; i < 240; i++) stepCelebrate(w, DT)
    expect(w.letters[0].body.translation().y).toBeGreaterThan(w.h)
  })

  it('armEnclosureNow cannot re-cage an exit that began before the cage went up', async () => {
    // The component path: `exiting` already true when the async build finishes, with reduced
    // motion — exitCelebrate runs on a cage-less world, then armEnclosureNow.
    const w = await settledWorld([atSlot(400, 300)])
    exitCelebrate(w)
    armEnclosureNow(w)
    expect(w.floorBody).toBeNull()
    for (let i = 0; i < 240; i++) stepCelebrate(w, DT)
    expect(w.letters[0].body.translation().y, 'the letters must still fall out').toBeGreaterThan(w.h)
  })
})

describe('dragging your own bodies (startBodyDrag / moveBodyDrag)', () => {
  it('moveBodyDrag actually moves the anchor, so the prop follows the cursor', async () => {
    const w = await settledWorld([atSlot(400, 300)])
    armEnclosureNow(w)
    const prop = w.world.createRigidBody(w.rapier.RigidBodyDesc.dynamic().setTranslation(650, 150).setCanSleep(false))
    w.world.createCollider(w.rapier.ColliderDesc.ball(15), prop)
    const m = startBodyDrag(w, prop, 0, 0, 650, 150)
    moveBodyDrag(m, 150, 450)
    for (let i = 0; i < 90; i++) stepCelebrate(w, DT, true)
    const p = prop.translation()
    expect(Math.hypot(p.x - 150, p.y - 450)).toBeLessThan(15)
    endBodyDrag(w, m)
  })
})

describe('non-finite input never poisons or strands a body', () => {
  it('a non-finite slot is replaced once (world centre), not re-injected every frame', async () => {
    const w = await settledWorld([atSlot(400, 300), atSlot(300, 300)])
    armEnclosureNow(w)
    const L = w.letters[0]
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      retargetLetter(w, 0, NaN, NaN)
      for (let i = 0; i < 120; i++) stepCelebrate(w, DT)
      expect(w.dead).toBe(false)
      expect(L.body.isEnabled()).toBe(true)
      expect(Number.isFinite(L.tx) && Number.isFinite(L.ty)).toBe(true)
      expect(err, 'one report, not one per frame').toHaveBeenCalledTimes(1)
    } finally {
      err.mockRestore()
    }
    // …and it is still an ordinary letter.
    retargetLetter(w, 0, 600, 300)
    for (let i = 0; i < 300; i++) stepCelebrate(w, DT)
    const p = L.body.translation()
    expect(Math.hypot(p.x - 600, p.y - 300)).toBeLessThan(w.stuckDist)
  })

  it("a letter body disabled by Rapier's NaN quarantine is re-enabled and put back on its slot", async () => {
    const w = await settledWorld([atSlot(400, 300)])
    armEnclosureNow(w)
    const L = w.letters[0]
    // Rapier 0.20+ answers a body whose state goes non-finite mid-step by rolling it back and
    // DISABLING it. A disabled letter never moves again: not by the springs, not by gravity.
    L.body.setEnabled(false)
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      stepCelebrate(w, DT)
      expect(L.body.isEnabled()).toBe(true)
      expect(err, 'the recovery is reported, not silent').toHaveBeenCalled()
    } finally {
      err.mockRestore()
    }
    retargetLetter(w, 0, 600, 300)
    for (let i = 0; i < 300; i++) stepCelebrate(w, DT)
    const p = L.body.translation()
    expect(Math.hypot(p.x - 600, p.y - 300)).toBeLessThan(w.stuckDist)
  })

  it('the real quarantine path: a NaN velocity reaches the solver and the letter recovers', async (ctx) => {
    const w = await settledWorld([atSlot(400, 300)])
    const [maj, min] = w.rapier.version().split('.').map(Number)
    if (maj === 0 && min < 20) ctx.skip() // 0.19 panics here instead (the dead-world path)
    armEnclosureNow(w)
    const L = w.letters[0]
    L.body.setLinvel({ x: NaN, y: 0 }, true)
    w.world.step() // straight into the solver, past the pre-step sentinel
    expect(L.body.isEnabled(), 'precondition: Rapier quarantined the body').toBe(false)
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      for (let i = 0; i < 5; i++) stepCelebrate(w, DT)
    } finally {
      err.mockRestore()
    }
    expect(L.body.isEnabled()).toBe(true)
    retargetLetter(w, 0, 600, 300)
    for (let i = 0; i < 300; i++) stepCelebrate(w, DT)
    const p = L.body.translation()
    expect(Math.hypot(p.x - 600, p.y - 300)).toBeLessThan(w.stuckDist)
  })

  it('stepCelebrate ignores a dt that is not a positive finite number', async () => {
    for (const bad of [NaN, Infinity, 0, -1 / 60]) {
      const w = await settledWorld([atSlot(400, 300)])
      armEnclosureNow(w)
      const L = w.letters[0]
      const before = L.body.translation()
      stepCelebrate(w, bad)
      expect(L.body.isEnabled(), `dt=${bad}`).toBe(true)
      const p = L.body.translation()
      expect(Math.hypot(p.x - before.x, p.y - before.y), `dt=${bad}`).toBeLessThan(1)
    }
  })

  it('moveDrag ignores a non-finite cursor; the drag keeps working', async () => {
    const w = await settledWorld([atSlot(400, 300)])
    armEnclosureNow(w)
    startLetterDrag(w, 0, 0, 0, 400, 300)
    moveDrag(w, NaN, 300)
    for (let i = 0; i < 5; i++) stepCelebrate(w, DT)
    moveDrag(w, 250, 300)
    for (let i = 0; i < 90; i++) stepCelebrate(w, DT)
    expect(w.drag!.cursorBody.isEnabled()).toBe(true)
    const p = w.letters[0].body.translation()
    expect(Math.hypot(p.x - 250, p.y - 300)).toBeLessThan(15)
    releaseDrag(w)
  })

  it('moveBodyDrag ignores a non-finite cursor', async () => {
    const w = await settledWorld([atSlot(400, 300)])
    armEnclosureNow(w)
    const prop = w.world.createRigidBody(w.rapier.RigidBodyDesc.dynamic().setTranslation(650, 150).setCanSleep(false))
    w.world.createCollider(w.rapier.ColliderDesc.ball(15), prop)
    const m = startBodyDrag(w, prop, 0, 0, 650, 150)
    moveBodyDrag(m, Infinity, 150)
    expect(m.cursorX).toBe(650)
    for (let i = 0; i < 5; i++) stepCelebrate(w, DT, true)
    expect(m.cursorBody.isEnabled()).toBe(true)
    endBodyDrag(w, m)
  })

  it('moveObstacle ignores a non-finite pose; the mirror keeps colliding', async () => {
    const w = await settledWorld([atSlot(400, 300)])
    armEnclosureNow(w)
    for (let i = 0; i < 30; i++) stepCelebrate(w, DT)
    const before = w.letters[0].body.translation()
    const o = addObstacle(w, 200, 300, 60)
    moveObstacle(o, NaN, NaN, NaN) // the foreign sim blew up for a frame
    stepCelebrate(w, DT, true)
    expect(o.body.isEnabled()).toBe(true)
    expect(o.r).toBe(60)
    for (let i = 0; i < 90; i++) {
      moveObstacle(o, 200 + i * 4, 300)
      stepCelebrate(w, DT, true)
    }
    const during = w.letters[0].body.translation()
    expect(Math.hypot(during.x - before.x, during.y - before.y)).toBeGreaterThan(30)
    removeObstacle(w, o)
  })

  it('addObstacle clamps a non-finite radius', async () => {
    const w = await settledWorld([atSlot(400, 300)])
    const o = addObstacle(w, 100, 100, NaN)
    expect(o.r).toBe(1)
    stepCelebrate(w, DT)
    expect(o.collider.isEnabled()).toBe(true)
    removeObstacle(w, o)
  })
})

describe('a mirror without a finite pose', () => {
  it('addObstacle with a non-finite pose parks the mirror; the first finite move PLACES it', async () => {
    const w = await settledWorld([atSlot(400, 300)])
    armEnclosureNow(w)
    for (let i = 0; i < 30; i++) stepCelebrate(w, DT)
    const o = addObstacle(w, NaN, NaN, 40) // a foreign sim's first pose was garbage
    stepCelebrate(w, DT, true)
    moveObstacle(o, 400, 150) // first real pose: well clear of the letter at (400, 300)
    stepCelebrate(w, DT, true)
    expect(o.body.isEnabled()).toBe(true)
    const q = o.body.translation()
    expect(Math.hypot(q.x - 400, q.y - 150)).toBeLessThan(1)
    // Placed, not swept there: nothing on the way was batted aside.
    const L = w.letters[0].body.translation()
    expect(Math.hypot(L.x - 400, L.y - 300)).toBeLessThan(5)
    // …and from here it is an ordinary mirror: sweeping it down shoves the letter.
    for (let i = 0; i < 60; i++) {
      moveObstacle(o, 400, 150 + i * 5)
      stepCelebrate(w, DT, true)
    }
    const after = w.letters[0].body.translation()
    expect(Math.hypot(after.x - 400, after.y - 300)).toBeGreaterThan(30)
    removeObstacle(w, o)
  })

  it("a mirror disabled by Rapier's NaN quarantine comes back on its next finite pose", async () => {
    const w = await settledWorld([atSlot(400, 300)])
    armEnclosureNow(w)
    const o = addObstacle(w, 200, 300, 40)
    o.body.setEnabled(false) // what Rapier 0.20+ does to a body whose state went non-finite
    moveObstacle(o, 210, 300)
    stepCelebrate(w, DT, true)
    expect(o.body.isEnabled()).toBe(true)
    const q = o.body.translation()
    expect(Math.hypot(q.x - 210, q.y - 300)).toBeLessThan(1)
    removeObstacle(w, o)
  })
})

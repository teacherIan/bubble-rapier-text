// celebratePhysics.ts — framework-free (Rapier only, no PIXI/React) physics for the
// "Celebrate your hard work" bubble text, so it can also run inside a web worker.
// The main thread owns glyph rasterization + PIXI render + pointer; this module owns
// the world: per-letter slot/upright springs, the ghost-home untangle, and the
// grab-point drag spring. State is a plain object so the worker can drive it.
import type RAPIER from '@dimforge/rapier2d-compat'
import { createPhysicsWorld, createWallCage, type WallCage } from '@/lib/physics/world'
import type { PxShape } from './glyphHulls'

// --- physics tuning (pixel units; world.lengthUnit = 100) ---
export const GRAVITY = 620 // gentle downward pull so the entrance reads as a real fall
const SLOT_SPRING = 150 // = ω²: pull toward the target slot (mass-normalized accel)
const ANG_SPRING = 80 // = ω²: torque toward upright (INERTIA-normalized — see step)
const LINEAR_DAMPING = 3.0 // settle without endless overshoot (underdamped = bouncy)
const ANGULAR_DAMPING = 11 // ζ≈0.6 vs ANG_SPRING: letters stand up cleanly, slight wobble
const RESTITUTION = 0.15 // letter-vs-letter bounce — kept low so contacts dissipate (a bouncier value
// keeps punting pinned letters around and feeds the wedge; the entrance still reads bouncy because
// that comes from gravity + LINEAR_DAMPING, not restitution).
const SOLVER_ITERATIONS = 8 // > the default 4: fewer residual penetrations in the packed pile = fewer wedges at the source
const WALL_T = 240
// Drag is a Rapier REVOLUTE "mouse joint": a kinematic anchor body sits at the cursor and the
// grabbed point is pinned to it (see attachMouseJoint), so the letter hinges/swings about wherever
// you grabbed it (grab the top of a tall glyph and it dangles + swings under gravity, like lifting a
// real object by an edge). An earlier hand-rolled penalty spring at the grab point drove a runaway
// off-centre orbit (~13 rad/s); a hard joint has no positional feedback, so the natural hinge is
// solver-stable and never whirls. (The old centre-anchored spring avoided the spin by giving up the
// hinge entirely — pure translation, no rotation; its DRAG_STIFFNESS/DRAG_DAMP/DRAG_ANG_DAMP
// constants are gone with it — a hard joint needs no tuning.)
// Untangle: a letter that's out of place AND stops making progress toward its slot is wedged
// against its neighbours. We free it by GHOSTING it (collisions off) and then DRIVING it home —
// directly lerping its pose to slot + upright each frame so it glides through its neighbours and
// converges by construction. (Why drive, not spring? A collider-disabled body has inert mass
// properties, so applyImpulse/applyTorqueImpulse do NOTHING to a ghost — the springs can't right
// it. Verified live: a ghosted, tilted letter never stands up under the angular spring alone.
// The old one-shot FREE_KICK/FREE_SPIN was a hopeful ballistic shove that often left a flat-lying
// oval tilted forever.) Tracked PER LETTER (a jittery neighbour can't block a wedged one).
// STUCK_DIST/UNGHOST_DIST scale with the text (passed in).
//
// TWO independent triggers, because either alone leaves a hole:
//   • PARKED-and-wrong (fast path) — out of place AND barely moving for STUCK_FRAMES. Snappy, but
//     it only ever fires for a letter that comes to rest.
//   • WRONG-for-too-long at ANY speed (the wrongTotal watchdog) — closes the hole above, where a
//     letter jostled just above PARK_V by its neighbours never parks, so it was never freed and
//     could stay visibly out of place indefinitely.
// (This replaced an earlier `bestScore`/SCORE_EPS "is it still making progress?" heuristic, which
// was jitter-proof but could be defeated by a letter creeping imperceptibly toward its slot forever.)
const PARK_V = 95 // px/s — below this LINEAR speed an out-of-place letter counts as wedged/parked
const PARK_V2 = PARK_V * PARK_V // squared, so the per-frame "still moving?" test compares v·v and skips the sqrt
const STUCK_ANG = 0.4 // rad of tilt (~23°) beyond which a settled letter is "not upright"
const UNGHOST_ANG = 0.2 // re-solidify a gliding letter only once well under STUCK_ANG
const STUCK_FRAMES = 40 // ~0.66s parked-and-wrong before we free a letter (the snappy path)
const STUCK_TOTAL_FRAMES = 120 // ~2s wrong at ANY speed before the watchdog frees it (jostled-forever case)
const GLIDE_K = 0.2 // per-frame pose lerp while gliding home — converges smoothly in ~12 frames
const WALL_DELAY_MS = 2800 // add the enclosure after the entrance — letters fly in from OUTSIDE
const SPAWN_MARGIN = 120 // how far outside the screen edge letters spawn
// The slot-spring is linear (force ∝ distance), so a letter spawned far off-screen would be
// flung at thousands of px/s in one step — faster than the solver can resolve contacts, which
// tangles the pile. Cap fly-in speed to a solver-safe value (≈18px/step at 60Hz).
const MAX_SPEED = 1200 // px/s
const MAX_SPIN = 16 // rad/s

/** Per-letter spec built on the main thread (needs canvas/font) and shipped to the worker. */
export interface LetterSpec {
  colliders: PxShape[] // hand-authored compound (balls + capsules) in px, relative to body centre
  hw: number // grab-box half-width (also the empty-hull ball fallback)
  hh: number // grab-box half-height
  slotX: number // target slot (world px)
  slotY: number
}

/** One letter's live physics state. Exposed because `CelebrateWorld.letters` is public. */
export interface LetterBody {
  body: RAPIER.RigidBody
  tx: number
  ty: number
  ghost: boolean // true while gliding home with collisions disabled
  discarded: boolean // true once flung off in a transition — no springs, just flies under gravity
  mass: number // cached: constant for a fixed collider set (verified: disabling colliders doesn't change it)
  inertia: number // cached principal moment of inertia — avoids per-frame WASM calls in the springs
  wrongFrames: number // consecutive frames out-of-place AND parked (wedged) — the snappy free trigger
  wrongTotal: number // consecutive frames out-of-place at ANY speed — the watchdog free trigger
  arrivedOnce: boolean // has reached its slot ≥once — gates the watchdog so a fly-in (never-arrived) isn't cut short
}

// A drag is a Rapier revolute "mouse joint": a kinematic anchor at the cursor pinned to the grabbed
// point, so the body swings freely about it (a hinge — where you grab matters).
export interface MouseJoint {
  cursorBody: RAPIER.RigidBody // kinematic anchor, moved to the pointer each step
  joint: RAPIER.ImpulseJoint // revolute joint: grabbed point ↔ cursor (free to rotate → swing)
  cursorX: number
  cursorY: number
}

export interface DragState extends MouseJoint {
  index: number // letter being dragged
}

export interface CelebrateWorld {
  rapier: typeof RAPIER
  world: RAPIER.World
  letters: LetterBody[]
  w: number
  h: number
  stuckDist: number
  unghostDist: number
  elapsedMs: number
  wallsAdded: boolean
  floorBody: RAPIER.RigidBody | null // the bottom wall, removed on exit so letters fall off-screen
  walls: RAPIER.RigidBody[] // all four enclosure walls — removed wholesale on a word-to-word transition
  exiting: boolean // true once dropping off-screen (springs off, floor removed) — the /celebrate Start exit
  drag: DragState | null
}

// Spawn just OUTSIDE a random screen edge (all four), so letters fly in and converge
// from every direction instead of piling out of one pocket above — far fewer tangles.
// Velocity starts at zero; the slot-spring (which dominates at large distance) yanks
// each one inward. The enclosure is added only after the entrance, so nothing here is
// trapped behind a wall.
function spawnPose(w: number, h: number): { x: number; y: number; rot: number } {
  const rot = (Math.random() - 0.5) * Math.PI * 1.6
  switch (Math.floor(Math.random() * 4)) {
    case 0:
      return { x: Math.random() * w, y: -SPAWN_MARGIN - Math.random() * h * 0.25, rot } // top
    case 1:
      return { x: Math.random() * w, y: h + SPAWN_MARGIN + Math.random() * h * 0.25, rot } // bottom
    case 2:
      return { x: -SPAWN_MARGIN - Math.random() * w * 0.25, y: Math.random() * h, rot } // left
    default:
      return { x: w + SPAWN_MARGIN + Math.random() * w * 0.25, y: Math.random() * h, rot } // right
  }
}

// The screen enclosure (floor, walls, ceiling), added once after the entrance so the
// untangle/drag can't fling a letter off-screen. Returns the FLOOR body so the exit can
// remove it and let the letters fall out the bottom.
function addEnclosure(rapier: typeof RAPIER, world: RAPIER.World, w: number, h: number): WallCage {
  // Full-height side walls, no friction — the celebrate enclosure. Returns the whole cage:
  // the exit removes just the floor (letters fall out the bottom); a re-layout transition
  // removes every wall (letters scatter off all edges).
  return createWallCage(rapier, world, w, h, { thickness: WALL_T, sideExtent: 'full' })
}

function setLetterSolid(L: LetterBody, solid: boolean): void {
  for (let i = 0; i < L.body.numColliders(); i++) {
    const c = L.body.collider(i)
    c.setEnabled(solid)
    if (solid) c.setCollisionGroups(0xffffffff) // restore default (a scatter may have set it to pass-through)
  }
  L.ghost = !solid
}

// Free a wedged letter: ghost it (collisions off) and stop it dead, so the per-frame glide in
// stepCelebrate can drive it cleanly home from rest. Resets the stuck counters.
//
// NOTE the deliberate asymmetry with setLetterPassthrough below: a wedged letter is being DRIVEN
// (stepCelebrate lerps its pose every frame), so it wants no physics at all — disabling the collider is
// correct here precisely because the inert mass props don't matter to a driven body. A FLUNG letter
// is still simulated, so it must keep its mass. Same word ("ghost"), two different mechanisms.
function freeLetter(L: LetterBody): void {
  setLetterSolid(L, false)
  L.body.setLinvel({ x: 0, y: 0 }, true)
  L.body.setAngvel(0, true)
  L.wrongFrames = 0
  L.wrongTotal = 0
}

// Ghost a FLUNG (discarded) letter by making it pass through everything via collision GROUPS, WITHOUT
// disabling its collider. Disabling the collider zeroes the body's effective mass — and a zero-mass
// dynamic body gets NO gravity and its velocity decays to zero, so the letter freezes on-screen instead
// of flying off (verified against Rapier 0.19). Keeping the collider enabled (filtered to hit nothing)
// retains the mass, so gravity + the scatter velocity carry it cleanly off any edge to be culled.
function setLetterPassthrough(L: LetterBody): void {
  for (let i = 0; i < L.body.numColliders(); i++) {
    const c = L.body.collider(i)
    c.setEnabled(true)
    c.setCollisionGroups(0) // membership 0 + filter 0 → collides with nothing
  }
  L.ghost = true
}

const OVAL_SAMPLES = 24 // points sampled on the ellipse for the roundConvexHull oval

// Collider rotation relative to the body: balls are rotation-invariant, everything else
// carries its authored angle `a`.
function shapeRot(c: PxShape): number {
  return c.t === 'ball' ? 0 : c.a
}

// Build the (untranslated, unrotated) ColliderDesc for one hull primitive.
function colliderDescFor(rapier: typeof RAPIER, c: PxShape): RAPIER.ColliderDesc | null {
  switch (c.t) {
    case 'ball':
      return rapier.ColliderDesc.ball(Math.max(1, c.r))
    case 'cap':
      return rapier.ColliderDesc.capsule(Math.max(0.5, c.h), Math.max(1, c.r))
    case 'rrect': {
      // roundCuboid(hx, hy, border): total half-extent = hx + border, so the inner cuboid
      // is the OUTER half-extent minus the corner radius.
      const r = Math.max(0.5, Math.min(c.r, c.hx, c.hy))
      return rapier.ColliderDesc.roundCuboid(Math.max(0.5, c.hx - r), Math.max(0.5, c.hy - r), r)
    }
    case 'oval': {
      // Ellipse with no native shape: sample points on the (shrunk) ellipse and round the
      // convex hull by the border so the outer boundary ≈ ellipse(rx, ry) and is fully curved.
      const br = Math.max(0.5, Math.min(c.rx, c.ry) * 0.5)
      const irx = c.rx - br
      const iry = c.ry - br
      const fallback = () => rapier.ColliderDesc.ball(Math.max(1, Math.min(c.rx, c.ry)))
      if (irx <= 0.5 || iry <= 0.5) return fallback()
      const pts = new Float32Array(OVAL_SAMPLES * 2)
      for (let k = 0; k < OVAL_SAMPLES; k++) {
        const th = (2 * Math.PI * k) / OVAL_SAMPLES
        pts[k * 2] = irx * Math.cos(th)
        pts[k * 2 + 1] = iry * Math.sin(th)
      }
      return rapier.ColliderDesc.roundConvexHull(pts, br) ?? fallback()
    }
  }
}

// Build one letter rigid body (spawned just outside a random edge) with its hand-authored
// compound of curved colliders tracing the glyph (see glyphHulls.ts): ball, capsule,
// roundCuboid (rounded rect), and oval (a roundConvexHull of points on the ellipse). All
// are corner-free, so packed letters slide instead of wedging. Each piece is positioned +
// rotated relative to the body centre. Empty hull (shouldn't happen — hullForGlyph
// guarantees ≥1) falls back to a ball. Shared by world creation and runtime spawns.
function createLetterBody(rapier: typeof RAPIER, world: RAPIER.World, spec: LetterSpec, w: number, h: number): LetterBody {
  const pose = spawnPose(w, h)
  const body = world.createRigidBody(
    rapier.RigidBodyDesc.dynamic()
      .setTranslation(pose.x, pose.y)
      .setRotation(pose.rot)
      .setLinearDamping(LINEAR_DAMPING)
      .setAngularDamping(ANGULAR_DAMPING)
      .setCanSleep(false) // these bodies are perpetually servoed to a slot — a sleeping wrong letter
      // (Rapier sleeps below ~0.4·lengthUnit = 40px/s) would never be re-homed; never let them sleep.
      .setCcdEnabled(true), // small fast glyphs were tunneling through the floor on entry
  )
  const pieces = spec.colliders.length
    ? spec.colliders
    : [{ t: 'ball' as const, x: 0, y: 0, r: Math.min(spec.hw, spec.hh) }]
  for (const c of pieces) {
    const desc = colliderDescFor(rapier, c)
    if (desc) world.createCollider(desc.setTranslation(c.x, c.y).setRotation(shapeRot(c)).setRestitution(RESTITUTION).setDensity(1), body)
  }
  return {
    body,
    tx: spec.slotX,
    ty: spec.slotY,
    ghost: false,
    discarded: false,
    mass: body.mass(),
    inertia: body.principalInertia(),
    wrongFrames: 0,
    wrongTotal: 0,
    arrivedOnce: false,
  }
}

export async function createCelebrateWorld(
  specs: LetterSpec[],
  w: number,
  h: number,
  stuckDist: number,
  unghostDist: number,
): Promise<CelebrateWorld> {
  // lengthUnit=100 (px-space; the shared default — see createPhysicsWorld). No enclosure
  // yet — letters spawn OUTSIDE the edges and fly in; addEnclosure() runs after the
  // entrance (see stepCelebrate).
  const { rapier, world } = await createPhysicsWorld({ x: 0, y: GRAVITY }, { numSolverIterations: SOLVER_ITERATIONS })

  const letters: LetterBody[] = specs.map((spec) => createLetterBody(rapier, world, spec, w, h))

  return { rapier, world, letters, w, h, stuckDist, unghostDist, elapsedMs: 0, wallsAdded: false, floorBody: null, walls: [], exiting: false, drag: null }
}

// ── Transition primitives (re-layout to a new phrase) ───────────────────────────────────
// A transition reuses the live world: matching letters glide to NEW slots, the rest are
// flung off, and missing letters fly in. The render layer keeps its renderLetters[] array
// index-aligned with world.letters[] by mirroring addLetter(). All letters stay SOLID —
// disabling colliders zeroes the body mass, which kills both gravity (a flung letter would
// hang) and the mass-scaled slot spring (a spawned letter wouldn't move). Instead the
// caller removes the whole wall cage (removeWalls) so flung letters exit off any edge and
// spawned letters fly in unobstructed.

/** Resize the world to a new viewport: update the stored dims + untangle thresholds, and rebuild
 *  the enclosure at the new size IF it's currently up (so the walls track the viewport on a device
 *  rotation / mobile URL-bar change). If the cage isn't up yet (mid-entrance) or was removed (a
 *  re-layout transition / exit), it's left alone — stepCelebrate adds it later at the then-current
 *  size. The render layer is responsible for recomputing slot targets (retargetLetter) for the new
 *  dimensions and resizing its own canvas. */
export function resizeWorld(state: CelebrateWorld, w: number, h: number, stuckDist: number, unghostDist: number): void {
  state.w = w
  state.h = h
  state.stuckDist = stuckDist
  state.unghostDist = unghostDist
  if (state.walls.length) {
    for (const wall of state.walls) state.world.removeRigidBody(wall)
    const cage = createWallCage(state.rapier, state.world, w, h, { thickness: WALL_T, sideExtent: 'full' })
    state.floorBody = cage.floor
    state.walls = cage.walls
  }
}

/** Remove the entire enclosure so the world is open on all sides (for a re-layout transition). */
export function removeWalls(state: CelebrateWorld): void {
  for (const wall of state.walls) state.world.removeRigidBody(wall)
  state.walls = []
  state.floorBody = null
  state.wallsAdded = true // keep stepCelebrate from re-adding the cage
}

/** Point an existing letter at a new slot; the slot spring carries it there. */
export function retargetLetter(state: CelebrateWorld, index: number, x: number, y: number): void {
  const L = state.letters[index]
  if (!L) return
  L.tx = x
  L.ty = y
  L.discarded = false
  L.wrongFrames = 0 // re-arm stuck detection against the new slot
  L.wrongTotal = 0
  L.arrivedOnce = false // now flying to a NEW slot — disarm the watchdog until it arrives there
  setLetterSolid(L, true) // ensure solid (it may have been mid-ghost from the untangle)
}

/** Fling a letter off-screen: kill its homing spring (discarded) and give it a strong random velocity
 *  + spin. Make it pass through everything (so it can't get caught in the re-forming text) but KEEP its
 *  collider enabled — see setLetterPassthrough: disabling the collider zeroes the mass, which kills
 *  gravity and lets the velocity decay to zero, freezing the letter on-screen instead of arcing off. */
export function scatterLetter(state: CelebrateWorld, index: number): void {
  const L = state.letters[index]
  if (!L) return
  L.discarded = true
  setLetterPassthrough(L) // collide with nothing, BUT keep mass → gravity still pulls it off-screen
  L.body.enableCcd(false) // no longer needs continuous collision — it's leaving the screen
  L.body.setLinearDamping(0) // 0 so gravity keeps accelerating it off-screen (it won't slow + sleep mid-air)
  const ang = Math.random() * Math.PI * 2
  const speed = 700 + Math.random() * 700
  L.body.setLinvel({ x: Math.cos(ang) * speed, y: Math.sin(ang) * speed - 220 }, true) // slight up-bias → flies up, then gravity wins
  L.body.setAngvel((Math.random() - 0.5) * 2 * MAX_SPIN, true)
}

/** Spawn a new letter into the running world (flies in from an edge toward its slot).
 *  Returns its index — the render layer must push a matching renderLetter at the same index. */
export function addLetter(state: CelebrateWorld, spec: LetterSpec): number {
  const L = createLetterBody(state.rapier, state.world, spec, state.w, state.h)
  state.letters.push(L)
  return state.letters.length - 1
}

/** Make a dragged letter solid again (called when a ghosting letter is grabbed). */
export function solidifyLetter(state: CelebrateWorld, index: number): void {
  const L = state.letters[index]
  if (L && L.ghost) setLetterSolid(L, true)
}

// ── Drag: a Rapier revolute "mouse joint" (the grabbed point hinges to the cursor) ─────────────
function attachMouseJoint(state: CelebrateWorld, body: RAPIER.RigidBody, grabLocalX: number, grabLocalY: number, cursorX: number, cursorY: number): MouseJoint {
  // A kinematic anchor body at the cursor, pinned to the grabbed point by a revolute joint. The body
  // is free to ROTATE about that pin, so it swings from wherever you grabbed it (a hinge).
  const cursorBody = state.world.createRigidBody(state.rapier.RigidBodyDesc.kinematicPositionBased().setTranslation(cursorX, cursorY))
  const joint = state.world.createImpulseJoint(
    state.rapier.JointData.revolute({ x: 0, y: 0 }, { x: grabLocalX, y: grabLocalY }), // anchor on cursor ↔ grabbed local point
    cursorBody,
    body,
    true,
  )
  return { cursorBody, joint, cursorX, cursorY }
}

function detachMouseJoint(state: CelebrateWorld, m: MouseJoint): void {
  state.world.removeImpulseJoint(m.joint, true)
  state.world.removeRigidBody(m.cursorBody)
}

/** Grab a letter at a point in its local frame; it then hinges/swings from there as you drag. */
export function startLetterDrag(state: CelebrateWorld, index: number, grabLocalX: number, grabLocalY: number, cursorX: number, cursorY: number): void {
  const L = state.letters[index]
  if (!L) return
  if (state.drag) detachMouseJoint(state, state.drag) // clear any prior drag
  state.drag = { index, ...attachMouseJoint(state, L.body, grabLocalX, grabLocalY, cursorX, cursorY) }
}

/** Update the cursor anchor (on pointer move). */
export function moveDrag(state: CelebrateWorld, cursorX: number, cursorY: number): void {
  if (state.drag) {
    state.drag.cursorX = cursorX
    state.drag.cursorY = cursorY
  }
}

/** Release the drag — the letter keeps its fling momentum, then the slot spring carries it home. */
export function releaseDrag(state: CelebrateWorld): void {
  if (state.drag) {
    detachMouseJoint(state, state.drag)
    state.drag = null
  }
}

// ── Dragging your OWN bodies (props) on the same hinge ──────────────────────────────────────────
// The three above are letter-specific (they own `state.drag`, which the untangle and the springs
// consult). A consumer that adds its own body to the world — a mascot, a prop, anything — gets the
// same revolute-hinge feel from these, while owning the returned handle itself. The library
// deliberately knows nothing about what the body IS.
//
// While the user holds a prop OVER the letters, pass `busy: true` to stepCelebrate: the letters
// pressed against it would otherwise be read as wedged, ghosted, and driven home THROUGH it, then
// ejected violently when they re-solidify where the prop sits.

/** Grab any body in the world at a point in its local frame; it hinges/swings from there. */
export function startBodyDrag(
  state: CelebrateWorld,
  body: RAPIER.RigidBody,
  grabLocalX: number,
  grabLocalY: number,
  cursorX: number,
  cursorY: number,
): MouseJoint {
  return attachMouseJoint(state, body, grabLocalX, grabLocalY, cursorX, cursorY)
}

/** Steer a prop drag's cursor anchor. Feed the handle to stepCelebrate's caller each frame. */
export function moveBodyDrag(m: MouseJoint, cursorX: number, cursorY: number): void {
  m.cursorX = cursorX
  m.cursorY = cursorY
}

/** Release a prop drag, removing its joint + kinematic anchor. */
export function endBodyDrag(state: CelebrateWorld, m: MouseJoint): void {
  detachMouseJoint(state, m)
}

/**
 * Drop every letter off the bottom of the screen — the /celebrate "Start" exit. Removes the
 * floor (so the bottom is open) and stops the homing springs; gravity then pulls the letters
 * down and out. They stay solid, so they tumble against each other + the side walls on the
 * way down. A small downward kick + wake makes the drop decisive (settled letters may sleep).
 */
export function exitCelebrate(state: CelebrateWorld): void {
  if (state.exiting) return
  state.exiting = true
  releaseDrag(state) // detach any in-flight drag joint + cursor anchor before the world tears down
  // Open the bottom. If the entrance hasn't placed the walls yet, mark them added so the
  // floor is never created (nothing to fall back onto).
  if (state.floorBody) {
    state.world.removeRigidBody(state.floorBody)
    state.floorBody = null
  }
  state.wallsAdded = true
  // The settle damping (LINEAR_DAMPING) caps fall speed at a low terminal velocity (~g/damping),
  // so without dropping it the letters only drift down. Zero it, then kick downward — scaled to
  // the screen height so even the top line clears the bottom within EXIT_MS regardless of size.
  const kick = Math.max(350, state.h * 0.45)
  for (const L of state.letters) {
    L.body.setLinearDamping(0)
    const v = L.body.linvel()
    L.body.setLinvel({ x: v.x * 0.4, y: Math.max(v.y, 0) + kick }, true) // `true` wakes the body
    L.body.setAngvel((Math.random() - 0.5) * 8, true)
  }
}

/**
 * Advance one fixed timestep: slot/upright springs, ghost-home untangle, drag.
 *
 * `busy` lets the HOST declare it is doing something the sim can't see — most importantly holding
 * one of its own bodies over the letters (see startBodyDrag). While busy, the untangle stands down
 * so pressed-against letters aren't ghosted and driven home through the obstacle. It is a parameter
 * rather than a field on the world so it can never go stale: the host asserts it fresh each frame.
 */
export function stepCelebrate(state: CelebrateWorld, dt: number, busy = false): void {
  const { rapier, world, letters } = state

  // Exiting: no springs/untangle/drag — just step, so gravity pulls the letters down through
  // the (now-removed) floor and off the bottom.
  if (state.exiting) {
    world.timestep = dt
    world.step()
    return
  }

  state.elapsedMs += dt * 1000
  if (!state.wallsAdded && state.elapsedMs >= WALL_DELAY_MS) {
    const cage = addEnclosure(rapier, world, state.w, state.h) // letters have flown in; now contain them
    state.floorBody = cage.floor
    state.walls = cage.walls
    state.wallsAdded = true
  }

  const draggedIndex = state.drag ? state.drag.index : -1
  for (let i = 0; i < letters.length; i++) {
    if (i === draggedIndex) continue // driven by the drag spring below
    const L = letters[i]
    if (L.discarded) continue // flung off in a transition — no spring/untangle, just flies under gravity
    const p = L.body.translation()
    const dist = Math.hypot(L.tx - p.x, L.ty - p.y)
    const ang = Math.atan2(Math.sin(L.body.rotation()), Math.cos(L.body.rotation()))

    // ── Gliding home (ghost) ─────────────────────────────────────────────────────────────
    // A freed letter is DRIVEN, not sprung: lerp its pose straight to slot + upright each frame
    // (it passes through neighbours, colliders disabled) so it converges by construction, and it
    // re-solidifies the moment it's home AND upright. Because the glide arrives it at rest, that
    // gate is met cleanly — no overshoot, no shove-back. (The springs CANNOT right a ghost: a
    // collider-disabled body's mass props are inert, so impulses do nothing.)
    if (L.ghost) {
      if (dist < state.unghostDist && Math.abs(ang) < UNGHOST_ANG) {
        setLetterSolid(L, true) // arrived — hand back to the springs (falls through below)
        L.wrongFrames = 0
        L.wrongTotal = 0
      } else {
        L.body.setTranslation({ x: p.x + (L.tx - p.x) * GLIDE_K, y: p.y + (L.ty - p.y) * GLIDE_K }, true)
        L.body.setRotation(ang * (1 - GLIDE_K), true)
        L.body.setLinvel({ x: 0, y: 0 }, true) // arrive calm so the un-ghost gate above passes
        L.body.setAngvel(0, true)
        continue
      }
    }

    // Slot + upright springs (solid letters), using CACHED mass/inertia (constant per glyph) instead
    // of 3 WASM calls/frame. Linear spring is mass-normalized (impulse/m = accel); the angular
    // spring is inertia-normalized so ω² is consistent across glyph sizes.
    L.body.applyImpulse({ x: (L.tx - p.x) * SLOT_SPRING * dt * L.mass, y: (L.ty - p.y) * SLOT_SPRING * dt * L.mass }, true)
    L.body.applyTorqueImpulse(-ang * ANG_SPRING * dt * L.inertia, true)

    // Per-letter untangle. SCORE combines position AND tilt (max of the two; 1 = the threshold),
    // so a letter at the right spot but ROTATED (a flat-lying oval) still reads as wrong.
    const score = Math.max(dist / state.stuckDist, Math.abs(ang) / STUCK_ANG)
    if (score <= 1) {
      L.wrongFrames = 0 // settled
      L.wrongTotal = 0
      L.arrivedOnce = true // reached its slot — the watchdog may now arm for it (catches a post-arrival jostle)
      continue
    }
    if (state.drag || busy) {
      // Don't fight the user. While they HOLD a letter — or hold one of their OWN bodies over the
      // letters (`busy`, see startBodyDrag) — the blocked letters just press against the obstacle;
      // don't let the untangle ghost+drive them home through it (they'd un-ghost where the obstacle
      // sits and get ejected → a violent bounce). They re-home the instant it moves away.
    } else {
      L.wrongTotal++ // counts wrong frames at ANY speed (the jostled-above-PARK_V case)
      const v = L.body.linvel()
      const sp2 = v.x * v.x + v.y * v.y
      // Snappy path: PARKED-and-wrong → free fast. (A wobble can't reset wrongFrames.)
      if (sp2 < PARK_V2) {
        if (++L.wrongFrames > STUCK_FRAMES) {
          freeLetter(L) // ghost + stop; the glide above drives it home next frame
          continue
        }
      } else {
        L.wrongFrames = Math.max(0, L.wrongFrames - 1) // moving — decay (jitter-proof)
      }
      // Watchdog: wrong for too long regardless of speed (jostled letters never park, so the snappy
      // path alone missed them). Gated on wallsAdded (skip the initial dramatic fly-in) AND
      // arrivedOnce (skip a TRANSITION fly-in too — removeWalls leaves wallsAdded=true, so without
      // arrivedOnce a never-yet-arrived spawning letter would be cut short). A settled-then-jostled
      // letter HAS arrivedOnce → covered.
      if (state.wallsAdded && L.arrivedOnce && L.wrongTotal > STUCK_TOTAL_FRAMES) {
        freeLetter(L)
        continue
      }
    }
  }

  // Drag: just steer the kinematic cursor anchor to the pointer — the revolute joint (attached on
  // grab) pins the grabbed point to it and lets the letter swing about it (a hinge). Setting the
  // next-kinematic translation gives the body a real velocity, so a fast drag flings it.
  if (state.drag) state.drag.cursorBody.setNextKinematicTranslation({ x: state.drag.cursorX, y: state.drag.cursorY })

  // Cap speeds so the solver always sees resolvable motion (the linear spring would
  // otherwise fling far-spawned letters too fast for contacts to keep up). Discarded letters
  // are skipped — they're meant to fly off fast and get culled once off-screen.
  for (const L of letters) {
    if (L.discarded) continue
    const v = L.body.linvel()
    const sp = Math.hypot(v.x, v.y)
    if (sp > MAX_SPEED) L.body.setLinvel({ x: (v.x / sp) * MAX_SPEED, y: (v.y / sp) * MAX_SPEED }, true)
    const av = L.body.angvel()
    if (av > MAX_SPIN) L.body.setAngvel(MAX_SPIN, true)
    else if (av < -MAX_SPIN) L.body.setAngvel(-MAX_SPIN, true)
  }

  world.timestep = dt
  world.step()
}

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
const RESTITUTION = 0.3 // letter-vs-letter bounce
const WALL_T = 240
// Drag spring. Anchoring it at the GRABBED point (a penalty "mouse joint") drove a runaway
// orbit/spin about an off-centre grab — the body whirled at ~13 rad/s and no amount of
// damping settled it. So we anchor at the body CENTRE instead: pull the centre toward
// (cursor − grabOffset) so the grabbed point still lands under the pointer, but the force
// is applied at the centre of mass → it produces NO torque. A drag is pure translation; it
// can't spin. (Gravity is a centre force too, so it adds no torque either.) Light angular
// damping calms any spin a neighbour contact imparts, leaving only a gentle rotate.
const DRAG_STIFFNESS = 700 // = ω²: how hard the body chases so the grabbed point sits at the cursor
const DRAG_DAMP = 50 // ≈critical velocity damping (snappy + stable, no buzz)
const DRAG_ANG_DAMP = 30 // angular-velocity damping while dragging (calms contact-induced spin)
// Untangle: when a letter is out of place AND stops making progress toward its slot (wedged
// against neighbours), briefly GHOST it (collisions off) so the springs carry it home +
// upright through the others, then re-solidify. Tracked PER LETTER so a jittery neighbour
// can't block a wedged one. STUCK_DIST/UNGHOST_DIST scale with the text (passed in).
const SCORE_EPS = 0.08 // placement score must improve by this to count as "progressing" (jitter-tolerant)
const STUCK_ANG = 0.4 // rad of tilt (~23°) beyond which a settled letter is "not upright"
const UNGHOST_ANG = 0.2 // re-solidify only once well under STUCK_ANG, so it can't churn
const SETTLE_V = 90 // px/s — a ghosting letter must be this slow (plus home + upright) to re-solidify
const STUCK_FRAMES = 45 // ~0.75s of stalled-but-wrong before we free a letter
const FREE_KICK = 320 // px/s shove toward the slot when freeing a wedged letter (springs alone are too weak)
const FREE_SPIN = 9 // rad/s spin toward upright when freeing a wedged (e.g. flat-lying oval) letter
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

interface LetterBody {
  body: RAPIER.RigidBody
  tx: number
  ty: number
  ghost: boolean // true while gliding home with collisions disabled
  discarded: boolean // true once flung off in a transition — no springs, just flies under gravity
  mass: number // cached: constant for a fixed collider set (verified: disabling colliders doesn't change it)
  inertia: number // cached principal moment of inertia — avoids per-frame WASM calls in the springs
  wrongFrames: number // consecutive frames out-of-place AND not improving its best score
  bestScore: number // best (min) placement score (position+tilt) since last placed/retargeted — jitter-proof
}

export interface DragState {
  index: number // letter being dragged
  localX: number // grabbed point in the letter's local frame (the pivot)
  localY: number
  cursorX: number // spring target (world px)
  cursorY: number
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
    bestScore: Infinity,
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
  const { rapier, world } = await createPhysicsWorld({ x: 0, y: GRAVITY })

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
  L.wrongFrames = 0
  L.bestScore = Infinity // re-arm stuck detection against the new slot
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

/**
 * Drop every letter off the bottom of the screen — the /celebrate "Start" exit. Removes the
 * floor (so the bottom is open) and stops the homing springs; gravity then pulls the letters
 * down and out. They stay solid, so they tumble against each other + the side walls on the
 * way down. A small downward kick + wake makes the drop decisive (settled letters may sleep).
 */
export function exitCelebrate(state: CelebrateWorld): void {
  if (state.exiting) return
  state.exiting = true
  state.drag = null
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

/** Advance one fixed timestep: slot/upright springs, ghost-home untangle, drag spring. */
export function stepCelebrate(state: CelebrateWorld, dt: number): void {
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
    const v = L.body.linvel()
    const speed = Math.hypot(v.x, v.y)
    // A ghosting letter has arrived once it's home, upright, AND nearly stopped → solidify.
    // The speed gate matters: solidifying while it's still drifting lets a neighbour shove the
    // thin oval back out before it settles. Ghosted it can't collide, so it always reaches this.
    if (L.ghost && dist < state.unghostDist && Math.abs(ang) < UNGHOST_ANG && speed < SETTLE_V) {
      setLetterSolid(L, true)
      L.wrongFrames = 0
      L.bestScore = Infinity
    }
    // Slot + upright springs, using CACHED mass/inertia (constant per glyph) instead of 3
    // WASM calls/frame. Linear spring is mass-normalized (impulse/m = accel); the angular
    // spring is inertia-normalized so ω² is consistent across glyph sizes.
    L.body.applyImpulse({ x: (L.tx - p.x) * SLOT_SPRING * dt * L.mass, y: (L.ty - p.y) * SLOT_SPRING * dt * L.mass }, true)
    L.body.applyTorqueImpulse(-ang * ANG_SPRING * dt * L.inertia, true)
    if (L.ghost) continue // already gliding home — don't also run stuck detection

    // Per-letter untangle: SCORE combines position AND tilt (max of the two, 1 = the threshold).
    // A letter whose score doesn't IMPROVE by SCORE_EPS for STUCK_FRAMES is wedged → free it:
    // ghost it (pass through neighbours) + kick it (velocity toward the slot, spin toward upright).
    // Springs alone can't pop a wedge — e.g. a flat-lying oval 'i' pinned between 't' and 'e'.
    // Scoring on TILT too is the fix for "tries once then gives up": a letter sitting at the right
    // spot but rotated has a stable distance, so a distance-only metric saw no problem and never
    // re-fired — score catches the tilt. Gating on BEST (min) score is jitter-proof, and we re-arm
    // each cycle so it keeps trying until it's genuinely upright + home.
    const score = Math.max(dist / state.stuckDist, Math.abs(ang) / STUCK_ANG)
    if (score <= 1) {
      L.wrongFrames = 0
      L.bestScore = Infinity // settled: re-arm so a later knock starts fresh
      continue
    }
    if (score < L.bestScore - SCORE_EPS) {
      L.bestScore = score // still making real headway (closer OR more upright)
      L.wrongFrames = 0
    } else if (!state.drag && ++L.wrongFrames > STUCK_FRAMES) {
      setLetterSolid(L, false) // ghost: pass through neighbours
      const dx = L.tx - p.x
      const dy = L.ty - p.y
      const d = Math.hypot(dx, dy) || 1
      L.body.setLinvel({ x: (dx / d) * FREE_KICK, y: (dy / d) * FREE_KICK }, true) // shove toward home
      L.body.setAngvel(ang > 0 ? -FREE_SPIN : FREE_SPIN, true) // spin toward upright
      L.wrongFrames = 0
      L.bestScore = Infinity
    }
  }

  // Drag: a damped spring on the body CENTRE whose target is (cursor − grabOffset), so the
  // grabbed point tracks the pointer while the force stays at the centre of mass — pure
  // translation, no drag torque, so it can't whirl. Light angular damping calms contact spin.
  if (state.drag) {
    const L = letters[state.drag.index]
    if (L) {
      const b = L.body
      const p = b.translation()
      const rot = b.rotation()
      const c = Math.cos(rot)
      const s = Math.sin(rot)
      const rx = c * state.drag.localX - s * state.drag.localY // grab offset (centre→grabbed point), world frame
      const ry = s * state.drag.localX + c * state.drag.localY
      const tx = state.drag.cursorX - rx // where the CENTRE must be for the grabbed point to sit at the cursor
      const ty = state.drag.cursorY - ry
      const lv = b.linvel()
      const fx = (tx - p.x) * DRAG_STIFFNESS - lv.x * DRAG_DAMP
      const fy = (ty - p.y) * DRAG_STIFFNESS - lv.y * DRAG_DAMP
      b.applyImpulse({ x: fx * dt * L.mass, y: fy * dt * L.mass }, true) // at the centre → no torque
      b.applyTorqueImpulse(-b.angvel() * DRAG_ANG_DAMP * dt * L.inertia, true)
    }
  }

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

// celebratePhysics.ts — framework-free (Rapier only, no PIXI/React) physics for the
// "Celebrate your hard work" bubble text, so it can also run inside a web worker.
// The main thread owns glyph rasterization + PIXI render + pointer; this module owns
// the world: per-letter slot/upright springs, the ghost-home untangle, and the
// grab-point drag spring. State is a plain object so the worker can drive it.
import type RAPIER from '@dimforge/rapier2d-compat'
import { createPhysicsWorld, createWallCage } from '@/lib/physics/world'
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
// Untangle: when nothing is moving but a letter is still out of order, briefly GHOST
// the worst one (collisions off) so the springs carry it home + upright through the
// others, then re-solidify. STUCK_DIST/UNGHOST_DIST scale with the text (passed in).
const QUIET_V = 55 // px/s — the worst letter below this counts as "parked" (a wedged letter
// can jitter from neighbor contact, so this is well above 0 but below active settling speed)
const STUCK_ANG = 0.4 // rad of tilt (~23°) beyond which a settled letter is "not upright"
const UNGHOST_ANG = 0.2 // re-solidify only once well under STUCK_ANG, so it can't churn
const STUCK_FRAMES = 45 // ~0.75s of parked-but-wrong before we act
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
  quietStuckFrames: number
  elapsedMs: number
  wallsAdded: boolean
  floorBody: RAPIER.RigidBody | null // the bottom wall, removed on exit so letters fall off-screen
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
function addEnclosure(rapier: typeof RAPIER, world: RAPIER.World, w: number, h: number): RAPIER.RigidBody {
  // Full-height side walls, no friction — the celebrate enclosure. The shared helper
  // returns the floor (bottom wall) so the exit can remove it and let the letters fall
  // out the bottom.
  return createWallCage(rapier, world, w, h, { thickness: WALL_T, sideExtent: 'full' }).floor
}

function setLetterSolid(L: LetterBody, solid: boolean): void {
  for (let i = 0; i < L.body.numColliders(); i++) L.body.collider(i).setEnabled(solid)
  L.ghost = !solid
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

  const letters: LetterBody[] = specs.map((spec) => {
    const pose = spawnPose(w, h)
    const body = world.createRigidBody(
      rapier.RigidBodyDesc.dynamic()
        .setTranslation(pose.x, pose.y)
        .setRotation(pose.rot)
        .setLinearDamping(LINEAR_DAMPING)
        .setAngularDamping(ANGULAR_DAMPING)
        .setCcdEnabled(true), // small fast glyphs were tunneling through the floor on entry
    )
    // Hand-authored compound of curved colliders tracing the glyph (see glyphHulls.ts):
    // ball, capsule, roundCuboid (rounded rect), and oval (a roundConvexHull of points on
    // the ellipse). All are corner-free, so packed letters slide instead of wedging. Each
    // is positioned + rotated relative to the body centre. Empty hull (shouldn't happen —
    // hullForGlyph guarantees ≥1) falls back to a ball.
    const pieces = spec.colliders.length
      ? spec.colliders
      : [{ t: 'ball' as const, x: 0, y: 0, r: Math.min(spec.hw, spec.hh) }]
    for (const c of pieces) {
      const desc = colliderDescFor(rapier, c)
      if (desc) world.createCollider(desc.setTranslation(c.x, c.y).setRotation(shapeRot(c)).setRestitution(RESTITUTION).setDensity(1), body)
    }
    return { body, tx: spec.slotX, ty: spec.slotY, ghost: false }
  })

  return { rapier, world, letters, w, h, stuckDist, unghostDist, quietStuckFrames: 0, elapsedMs: 0, wallsAdded: false, floorBody: null, exiting: false, drag: null }
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
    state.floorBody = addEnclosure(rapier, world, state.w, state.h) // letters have flown in; now contain them
    state.wallsAdded = true
  }

  const draggedIndex = state.drag ? state.drag.index : -1
  const wrongSlow: LetterBody[] = [] // out-of-order + parked letters, ghosted together on trigger
  let worst: LetterBody | null = null
  let worstScore = 1 // only letters past the thresholds (score > 1) count
  let worstV = 0 // the worst letter's OWN speed (not the whole system's)
  for (let i = 0; i < letters.length; i++) {
    if (i === draggedIndex) continue // driven by the drag spring below
    const L = letters[i]
    const p = L.body.translation()
    // A ghosting letter has arrived once it's home and upright → make it solid again.
    if (L.ghost) {
      const ga = Math.atan2(Math.sin(L.body.rotation()), Math.cos(L.body.rotation()))
      if (Math.hypot(L.tx - p.x, L.ty - p.y) < state.unghostDist && Math.abs(ga) < UNGHOST_ANG) setLetterSolid(L, true)
    }
    const m = L.body.mass()
    // Linear spring is mass-normalized (impulse/m = accel). Angular spring must be
    // INERTIA-normalized: applyTorqueImpulse divides by the moment of inertia, so
    // multiply by principalInertia() for a consistent ω² across glyph sizes.
    L.body.applyImpulse({ x: (L.tx - p.x) * SLOT_SPRING * dt * m, y: (L.ty - p.y) * SLOT_SPRING * dt * m }, true)
    const ang = Math.atan2(Math.sin(L.body.rotation()), Math.cos(L.body.rotation()))
    L.body.applyTorqueImpulse(-ang * ANG_SPRING * dt * L.body.principalInertia(), true)
    if (L.ghost) continue // already being resolved; don't also pick it as worst
    const score = Math.max(Math.hypot(L.tx - p.x, L.ty - p.y) / state.stuckDist, Math.abs(ang) / STUCK_ANG)
    if (score <= 1) continue // in place + upright
    const v = L.body.linvel()
    const speed = Math.hypot(v.x, v.y)
    if (speed < QUIET_V) wrongSlow.push(L) // out of order AND parked
    if (score > worstScore) {
      worstScore = score
      worst = L
      worstV = speed
    }
  }

  // When the worst-placed letter has itself stopped moving but is still out of order,
  // ghost EVERY wrong-and-parked letter at once — they glide home + upright through
  // each other, then re-solidify (above). Doing the whole set (not just the worst)
  // breaks mutual wedges: two letters tangled together can't each keep re-breaking the
  // other. Gating on the WORST letter's own speed (not global quiescence) means one
  // jittery neighbor — common on tight/small layouts — can't block the untangle forever.
  if (!state.drag && worst && worstV < QUIET_V) state.quietStuckFrames++
  else state.quietStuckFrames = 0
  if (state.quietStuckFrames > STUCK_FRAMES) {
    for (const L of wrongSlow) setLetterSolid(L, false)
    state.quietStuckFrames = 0
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
      const m = b.mass()
      const fx = (tx - p.x) * DRAG_STIFFNESS - lv.x * DRAG_DAMP
      const fy = (ty - p.y) * DRAG_STIFFNESS - lv.y * DRAG_DAMP
      b.applyImpulse({ x: fx * dt * m, y: fy * dt * m }, true) // at the centre → no torque
      b.applyTorqueImpulse(-b.angvel() * DRAG_ANG_DAMP * dt * b.principalInertia(), true)
    }
  }

  // Cap speeds so the solver always sees resolvable motion (the linear spring would
  // otherwise fling far-spawned letters too fast for contacts to keep up).
  for (const L of letters) {
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

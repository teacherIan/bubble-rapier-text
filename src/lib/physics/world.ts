// Type-only: every RAPIER reference below is a type annotation, and the runtime namespace arrives
// via ensureRapierInitialized(). A value import here would pull the compat build's inlined WASM into
// the bundle even for a consumer who injected their own loader (see setRapierLoader).
import type RAPIER from '@dimforge/rapier2d-compat'
import { ensureRapierInitialized } from './rapierInit'

// Shared Rapier-world primitives. Pure (no React), realm-portable — these run on the
// main thread AND inside a physics web worker, so they must not
// reach for anything browser/DOM-specific. Each consumer still owns its own World and
// its own render/step loop; this only removes the near-verbatim construction boilerplate.

export interface PhysicsWorld {
  rapier: typeof RAPIER
  world: RAPIER.World
}

/**
 * Create a Rapier World after ensuring the WASM core is initialised (init is shared
 * per realm via ensureRapierInitialized; the World itself is owned by the caller).
 *
 * lengthUnit defaults to 100 because every sim in this app runs in PIXEL space, not SI
 * metres. At Rapier's default lengthUnit of 1 it treats a hundreds-of-px body as a
 * ~100 m giant and runs its internal thresholds (allowed linear error, contact
 * prediction, sleeping/CCD cutoffs) ~100x too tight — the documented #1 Rapier
 * mistake, which surfaces as perpetual sub-pixel contact micro-jitter. Pass
 * `lengthUnit: 1` to opt a px-space world out (e.g. to preserve existing feel) — but
 * note that Rapier 0.20+ also caps every body's linear speed at 400·lengthUnit per
 * second, so a px-space world at lengthUnit 1 can move nothing faster than 400 px/s.
 */
export async function createPhysicsWorld(
  gravity: { x: number; y: number },
  opts: { lengthUnit?: number; numSolverIterations?: number } = {},
): Promise<PhysicsWorld> {
  const rapier = await ensureRapierInitialized()
  const world = new rapier.World(new rapier.Vector2(gravity.x, gravity.y))
  world.lengthUnit = opts.lengthUnit ?? 100
  if (opts.numSolverIterations !== undefined) {
    world.integrationParameters.numSolverIterations = opts.numSolverIterations
  }
  return { rapier, world }
}

export interface WallCageOptions {
  /** Wall thickness in px. */
  thickness: number
  /** Friction applied to every wall collider (Rapier default if omitted). */
  friction?: number
  /**
   * Side-wall (left/right) half-height. The top/bottom walls always seal the corners
   * (their half-width is width/2 + thickness), so the side walls only need to span the
   * opening:
   *   - 'full'                -> half-height = height   (extends well past the corners;
   *                              the celebrate enclosure)
   *   - 'half-plus-thickness' -> half-height = height/2 + thickness (a snug cage)
   * Defaults to 'full'.
   */
  sideExtent?: 'full' | 'half-plus-thickness'
}

export interface WallCage {
  /** [top, bottom, left, right] — for callers that remove the whole cage on resize. */
  walls: RAPIER.RigidBody[]
  /**
   * The bottom wall, exposed so callers can drop the floor (e.g. let bodies
   * fall out). **This is the SAME body as `walls[1]`** — it is not a separate
   * handle. If you drop the floor with `world.removeRigidBody(cage.floor)`,
   * splice it out of `walls` before you tear the rest of the cage down, or you
   * will call `removeRigidBody` twice on one body — a double free that panics
   * the Rapier WASM instance (unrecoverable). `walls.filter(w => w !== floor)`.
   */
  floor: RAPIER.RigidBody
}

/**
 * Build a 4-wall fixed cage enclosing the rectangle [0,0]..[width,height], with each
 * wall's inner face aligned to the room bound. Returns the wall bodies and the floor.
 */
export function createWallCage(
  rapier: typeof RAPIER,
  world: RAPIER.World,
  width: number,
  height: number,
  opts: WallCageOptions,
): WallCage {
  const t = opts.thickness
  const make = (cx: number, cy: number, halfW: number, halfH: number): RAPIER.RigidBody => {
    const body = world.createRigidBody(rapier.RigidBodyDesc.fixed().setTranslation(cx, cy))
    let desc = rapier.ColliderDesc.cuboid(halfW, halfH)
    if (opts.friction !== undefined) desc = desc.setFriction(opts.friction)
    world.createCollider(desc, body)
    return body
  }

  const sideHalfH = opts.sideExtent === 'half-plus-thickness' ? height / 2 + t : height

  const top = make(width / 2, -t / 2, width / 2 + t, t / 2)
  const bottom = make(width / 2, height + t / 2, width / 2 + t, t / 2)
  const left = make(-t / 2, height / 2, t / 2, sideHalfH)
  const right = make(width + t / 2, height / 2, t / 2, sideHalfH)

  return { walls: [top, bottom, left, right], floor: bottom }
}

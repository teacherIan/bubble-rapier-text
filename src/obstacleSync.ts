import { addObstacle, moveObstacle, removeObstacle, type CelebrateWorld, type Obstacle, type ObstaclePose } from './celebratePhysics'

// The component's side of the host-obstacle feature: reconcile the host's poses against the
// world's kinematic mirrors by id, once per frame. Kept out of the component so the bookkeeping
// that decides `busy` can be tested against a real world.

/** One mirror and the last pose that counted as a move (see wakePx). */
export interface MirrorEntry {
  o: Obstacle
  lastX: number
  lastY: number
  lastR: number
}

export interface ObstacleSync {
  /** Live mirrors by pose id. */
  readonly mirrors: ReadonlyMap<string, MirrorEntry>
  /**
   * Add, move and remove mirrors so the world matches `poses`. Returns whether any mirror MOVED:
   * strayed more than `wakePx` from the last pose that counted. Hysteresis, not a per-frame delta —
   * a calm ring's sub-pixel wobble never counts, a slow drift accumulates until it does.
   * Never call it on a dead world (addObstacle creates a body).
   */
  sync(poses: readonly ObstaclePose[]): boolean
}

export function createObstacleSync(world: CelebrateWorld, wakePx: number): ObstacleSync {
  const mirrors = new Map<string, MirrorEntry>()
  const seen = new Set<string>()
  // A last value that is not finite is the seed of a mirror born without that value (a foreign
  // sim's first frame was garbage): its first real value is a move. Comparing against it instead
  // gives NaN, which is never > wakePx, so the mirror's motion would never count again.
  const wakes = (last: number, next: number): boolean => !Number.isFinite(last) || Math.abs(next - last) > wakePx
  return {
    mirrors,
    sync(poses) {
      let moved = false
      seen.clear()
      for (const p of poses) {
        seen.add(p.id)
        const e = mirrors.get(p.id)
        if (!e) {
          // Born at its first known pose — never parked at (0,0) waiting for data.
          mirrors.set(p.id, { o: addObstacle(world, p.x, p.y, p.r), lastX: p.x, lastY: p.y, lastR: p.r })
          continue
        }
        moveObstacle(e.o, p.x, p.y, p.r)
        // Only what moveObstacle applied can count: a position needs both coordinates finite,
        // a radius its own.
        const posMoved = Number.isFinite(p.x) && Number.isFinite(p.y) && (wakes(e.lastX, p.x) || wakes(e.lastY, p.y))
        const rMoved = Number.isFinite(p.r) && wakes(e.lastR, p.r)
        if (posMoved) {
          e.lastX = p.x
          e.lastY = p.y
        }
        if (rMoved) e.lastR = p.r
        if (posMoved || rMoved) moved = true
      }
      if (mirrors.size > seen.size) {
        for (const [id, e] of mirrors) {
          if (!seen.has(id)) {
            removeObstacle(world, e.o)
            mirrors.delete(id)
          }
        }
      }
      return moved
    },
  }
}

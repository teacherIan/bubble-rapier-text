// bubble-rapier-text — public API.
//
// A self-contained library for the physics-driven "Celebrate your hard work" bubble text:
// each glyph is a PIXI bubble-letter backed by a Rapier rigid body whose collider is a
// hand-authored hull of curved primitives. Letters rain in, self-assemble into legible
// text, and can be dragged/flung. Ships with the interactive hull editor used to author
// those colliders.
//
// Font: the components render in "Cherry Bomb One". Import the stylesheet once to register
// the vendored face:  import 'bubble-rapier-text/styles.css'

// ── React components ──────────────────────────────────────────────────────────
export { CelebrateBubbles } from './CelebrateBubbles'
export { GlyphHullEditor } from './GlyphHullEditor'
export { GlyphHullLab } from './GlyphHullLab'

// ── Framework-free physics (Rapier only — drive it from your own render loop) ──
export {
  createCelebrateWorld,
  stepCelebrate,
  solidifyLetter,
  exitCelebrate,
  // re-layout primitives: morph the live world into a new word (reuse matching glyphs,
  // fling the rest off, fly missing ones in)
  removeWalls,
  retargetLetter,
  scatterLetter,
  addLetter,
  GRAVITY,
  type LetterSpec,
  type CelebrateWorld,
  type DragState,
} from './celebratePhysics'

// ── Glyph collision hulls + helpers (author / scale / draw) ───────────────────
export {
  GLYPH_HULLS,
  GLYPH_LIST,
  hullForGlyph,
  scaleHull,
  strokeHullPx,
  type HullShape,
  type HullBall,
  type HullCapsule,
  type HullRRect,
  type HullOval,
  type PxShape,
  type PxBall,
  type PxCapsule,
  type PxRRect,
  type PxOval,
} from './glyphHulls'

// ── Shared Rapier-world primitives (build your own sims on the same base) ──────
export {
  createPhysicsWorld,
  createWallCage,
  type PhysicsWorld,
  type WallCage,
  type WallCageOptions,
} from './lib/physics/world'
export { ensureRapierInitialized } from './lib/physics/rapierInit'

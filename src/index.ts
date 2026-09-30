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
export { GlyphHullEditor, type HullExtraObject } from './GlyphHullEditor'
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
  resizeLetterColliders,
  scatterLetter,
  addLetter,
  removeLetter, // remove one body (splice your parallel render array at the same index)
  cullDiscarded, // collect flung letters that are off-screen or long-since discarded
  resizeWorld, // resize the world + rebuild the enclosure on a viewport / device-rotation change
  armEnclosureNow, // skip the entrance delay when letters start at their final pose (reduced motion)
  setWallGroups, // collision groups for the cage (a host body that passes through the walls); null = default
  // drag: a revolute "mouse joint" — the grabbed point hinges to the cursor, so a letter grabbed
  // by its top edge dangles and swings rather than sliding rigidly
  startLetterDrag,
  moveDrag,
  releaseDrag,
  // …and the same hinge for bodies YOU add to the world (a mascot, a prop): you own the handle
  startBodyDrag,
  moveBodyDrag,
  endBodyDrag,
  // kinematic mirrors of bodies simulated in ANOTHER world (a blob ring in a worker):
  // letters carom off them, they never yield — the foreign sim is the authority
  addObstacle,
  moveObstacle,
  removeObstacle,
  GRAVITY,
  type LetterSpec,
  type LetterBody,
  type CelebrateWorld,
  type DragState,
  type MouseJoint,
  type Obstacle,
  type ObstaclePose,
} from './celebratePhysics'

// ── Glyph collision hulls + helpers (author / scale / draw) ───────────────────
export {
  GLYPH_HULLS,
  GLYPH_LIST,
  GLYPH_GROUPS, // printable-ASCII bands (Uppercase / Lowercase / Digits / Punctuation) for the dev tools
  hullForGlyph,
  makeHullForGlyph, // bind your OWN hull map once, then pass the 3-arg result down the build path
  EDITABLE_GLYPHS, // every authored glyph, in grouped dev-tool tab order
  type GlyphGroup,
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

// ── Text style (the ONE definition the component and both dev tools render with) ──
export { FONT_STACK, letterStyle, metricStyle, SPACE_FRAC } from './letterStyle'

// ── Layout: slots derived from the LIVE viewport (recomputed on resize/rotation) ──
export {
  createLineLayout,
  type Measure,
  type Line,
  type Slot as LayoutSlot,
  type LayoutResult,
  type LayoutOptions,
  type LayoutStrategy,
} from './layout'

// ── Word-to-word transition planning (pure — pairs with the re-layout primitives) ──
export { planClaims, type LetterView, type TransitionPlan, type Slot } from './transition'

// ── Shared Rapier-world primitives (build your own sims on the same base) ──────
export {
  createPhysicsWorld,
  createWallCage,
  type PhysicsWorld,
  type WallCage,
  type WallCageOptions,
} from './lib/physics/world'
export {
  ensureRapierInitialized,
  // Bring your own Rapier build (raw .wasm, a CDN URL, a vendored copy) instead of the
  // inlined compat default. Must be called before anything creates a world.
  setRapierLoader,
  type RapierLoader,
} from './lib/physics/rapierInit'

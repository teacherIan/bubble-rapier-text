# Changelog

All notable changes to `bubble-rapier-text`. Pre-1.0, so breaking changes ship in MINOR versions.

## 0.2.0 — unreleased

Merges three long-lived branches and brings the untangle in line with the design they assume.

### Breaking

- **Drag is now a revolute "mouse joint" instead of a centre-anchored spring.** A letter grabbed by
  its top edge dangles and swings from the grab point rather than translating rigidly. `DragState`
  now extends `MouseJoint` (gains `cursorBody`/`joint`, loses `localX`/`localY`), so any code that
  hand-assigned `world.drag` must call `startLetterDrag` instead. The internal `DRAG_STIFFNESS`,
  `DRAG_DAMP`, and `DRAG_ANG_DAMP` constants are gone — a hard joint needs no tuning.
- `LetterBody` loses `bestScore` and gains `wrongTotal` + `arrivedOnce` (see below). It is now
  exported, since `CelebrateWorld.letters` was always public.

### Added

- `resizeWorld(state, w, h, stuckDist, unghostDist)` — resize the world and rebuild the enclosure on
  a viewport change or device rotation. Previously the world was frozen at its mount size, so a
  rotation left letters jammed against stale wall colliders.
- `startBodyDrag` / `moveBodyDrag` / `endBodyDrag` — the same revolute hinge for bodies **you** add
  to the world (a mascot, a prop). You own the returned handle; the library stays agnostic.
- `startLetterDrag` / `moveDrag` / `releaseDrag` and the `MouseJoint` type are now exported.
- `stepCelebrate(state, dt, busy?)` — the optional third argument lets the host declare it is doing
  something the sim can't see (most importantly, holding one of its own bodies over the letters), so
  the untangle stands down. Defaulted, so existing two-argument callers are unaffected.

### Fixed

- **Flung letters no longer freeze on-screen.** Discarded letters were ghosted by *disabling* their
  colliders, which zeroes a body's effective mass — and a zero-mass dynamic body gets no gravity and
  decays to a standstill (verified against Rapier 0.19). They now pass through via collision
  *groups* with the collider left enabled, so they keep their mass and fly cleanly off-screen.
- **A wedged letter is now DRIVEN home rather than kicked.** The springs cannot right a ghost: a
  collider-disabled body's mass properties are inert, so impulses do nothing to it. The old one-shot
  `FREE_KICK`/`FREE_SPIN` was a ballistic shove that often left a flat-lying oval tilted forever.
  The untangle now lerps the ghost's pose straight to slot + upright each frame, so it converges by
  construction.
- **The untangle trigger no longer misses jostled letters.** The old `bestScore`/`SCORE_EPS`
  "is it still making progress?" heuristic could be defeated by a letter creeping imperceptibly
  toward its slot forever. Two independent triggers replace it: a snappy *parked-and-wrong* counter
  (`STUCK_FRAMES`, gated on `PARK_V`) and a speed-independent `wrongTotal` watchdog
  (`STUCK_TOTAL_FRAMES`) that catches letters jostled above the park threshold that therefore never
  park. The watchdog is gated on `arrivedOnce` so a letter still flying to a *new* slot isn't cut
  short mid-flight.

## 0.1.0

Initial release: PIXI bubble-letters on Rapier rigid bodies with hand-authored collision hulls, the
spawn-from-edges entrance, slot/upright springs, the re-layout primitives, and the hull editor.

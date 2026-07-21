# Changelog

All notable changes to `bubble-rapier-text`. Pre-1.0, so breaking changes ship in MINOR versions.

## 0.3.1 — 2026-07-20

### Fixed

- **`sideEffects` now actually protects the bundle.** `*.css` didn't match `src/styles.css`
  (no-slash globs match root only), and `pixi.js/unsafe-eval` named another package's file,
  which the field can't do. Now `**/*.css` + `./dist/**/*.js`, so a tree-shaking consumer can't
  drop the stylesheet import or the bundle's module-level `pixi.js/unsafe-eval` registration.
- Stale header comment in `vite.lib.config.ts` claimed `exports` points at the TypeScript
  source; it has pointed at `dist/` since 0.3.0.

### Docs

- README: "Sharing one Rapier init with a host app" — the `setRapierLoader` recipe (module
  scope, before mount) for consumers that already initialize Rapier.

Note: the `using deprecated parameters for the initialization function` console warning comes
from inside `@dimforge/rapier2d-compat`'s own shim (its public `init()` takes no arguments) —
not fixable here; harmless.

## 0.3.0 — 2026-07-20

Makes the library consumable at all, and adds the pieces a second consumer needs.

### Breaking

- **`pixi.js` and `@dimforge/rapier2d-compat` are now `peerDependencies`.** Their objects cross the
  API boundary (`CelebrateWorld.rapier` is public), so a second copy in the graph means duplicate
  WebGL registration and `instanceof` misses. npm 7+ auto-installs peers, so a plain
  `npm i bubble-rapier-text` still works.

### Added

- **Full A–Z coverage**: 52 authored glyph hulls, up from 29. Any word can be set; previously an
  unauthored glyph fell back to a generic ball sized to its grab box.
- **`hullForGlyph(ch, hw, hh, hulls?)` + `makeHullForGlyph(hulls)`** — bring your own hull map
  instead of vendoring the module to swap it.
- **`createLineLayout`** (`src/layout.ts`) — slots derived from the LIVE viewport, with per-line
  `weight` so a subtitle stays smaller than its display line. Everything app-specific is a
  parameter.
- **Resize / rotation support** on `<CelebrateBubbles>` via a `ResizeObserver`: the renderer, the
  world, the wall cage, and the untangle thresholds all follow the viewport.
- **Idle gate** — `settledFrames` on the world, and the component stops its PIXI ticker after
  `idleFrames` calm frames (default 110, `false` to disable), waking on pointer, resize, or nav.
- **`planClaims`** (`src/transition.ts`) — the matching half of the re-layout primitives; now
  generic over the slot type.
- **Live `phrase` / `layout`** — changing either MORPHS the current word into the new one (matching
  glyphs glide across, the rest scatter, missing ones fly in) rather than cutting to it.
- New props: `play`, `phrase`, `layout`, `idleFrames`, `reducedMotion`, `maxResolution`, `onReady`,
  `onError`. All defaulted.
- `armEnclosureNow`, `removeLetter`, `cullDiscarded`, `setRapierLoader`, and the `letterStyle`
  module are now exported.
- ESLint, Vitest, and 42 tests — the repo previously had none of the three.

### Fixed

- **The package could not be consumed.** `celebratePhysics.ts` imported through a build-time `@/`
  alias that the CONSUMER's bundler had to resolve; an app defining its own `@ → ./src` resolved it
  into its own tree. Now relative.
- **A git install shipped no `dist`** — added the `prepare` script.
- **Phrase measurement** used a raw 2D canvas context, which does not reliably resolve the loaded
  web face; it under-measured, so the fit came out too large and end letters spawned pinned against
  the walls. Now measured through `CanvasTextMetrics` with the render style.
- **The fit ignored height entirely**, so a short or landscape viewport overlapped and clipped the
  lines.
- **A failed init leaked a WebGL context and a Rapier world.** Browsers cap live contexts, so in an
  SPA that remounts, repeated failures bricked the canvas.
- **`letterStyle` was triplicated** across the component and both dev tools, with a hand-maintained
  "BYTE-IDENTICAL" comment. It is load-bearing — stroke and shadow inflate the text box whose centre
  is the collider origin — and is now one shared module, which also adds the padding the copies
  lacked (descenders and the shadow were being clipped out of the glyph texture).
- **The hull editor's exporter serialised via `GLYPH_LIST`**, silently dropping any hull for a glyph
  outside the demo phrase on the next re-bake. This is the bug that let this library and its first
  consumer drift into two different hull sets.
- `pickLetter` could grab a flung, mid-cull letter.
- `scatterLetter` on an already-flung letter reset its cull lease, so repeated transitions could
  keep a letter alive indefinitely.

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

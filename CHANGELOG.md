# Changelog

All notable changes to `bubble-rapier-text`. Pre-1.0, so breaking changes ship in MINOR versions.

## 0.11.0 — 2026-09-29

Rapier 0.21, plus a once-over for lifecycle and robustness. Nothing breaking: the public API is
unchanged apart from one added export, and the Rapier peer range widens rather than moves.

### Changed
- **`@dimforge/rapier2d-compat` peer range is now `^0.19.0 || ^0.20.0 || ^0.21.0`** (was `^0.19.0`).
  The library is developed against 0.21.0; the test suite passes on 0.19.3, 0.20.0 and 0.21.0, so a
  host pinned to 0.19 can take this version without bumping its own Rapier.
- On Rapier 0.20+ the `using deprecated parameters for the initialization function` console warning
  (see 0.4.1) is gone. Rapier fixed its compat shim upstream; `init()` still takes no arguments.
- What Rapier 0.20/0.21 changed underneath, checked against this library: speed caps (400·lengthUnit
  px/s — 40000 px/s at the default lengthUnit 100 — and about 45° of rotation per step), rewritten
  sleeping, CCD against fixed colliders by default, new contact defaults, and restitution applied at
  the end of the step. Entrance settle times, exit and cull timings are the same on 0.19.3 and
  0.21.0. A world made with `createPhysicsWorld({ lengthUnit: 1 })` in px space is now capped at
  400 px/s.
- `stepCelebrate` ignores a `dt` that is not a positive, finite number (no time passes).
- `addObstacle` with a non-finite pose parks the mirror, disabled, until `moveObstacle` gets a finite
  pose, which PLACES it rather than sweeping it there.

### Added
- **`setWallGroups` is exported from the package entry.** 0.8.0 listed it as added, but the entry
  never re-exported it, so no consumer could import it.

### Fixed
- **A dead world (a caught wasm panic) no longer takes the host page down.**
  - Unmounting `<CelebrateBubbles>` threw from its cleanup (`world.free()` on a panicked world
    throws). Without an error boundary the host's React root unmounted: navigating away from a
    frozen toy killed the page.
  - A `phrase`/`layout` change, a tap, and a resize each read or rebuilt bodies in the poisoned wasm.
    The first threw inside the host's effect (page gone); the resize read `world.letters[-1]`.
  - `exitCelebrate`, `removeWalls`, `resizeLetterColliders`, `removeObstacle`, `endBodyDrag` and
    `setWallGroups` still touched the poisoned instance (0.8.4 guarded the rest). A host flipping
    `exiting` after the world died hit this from inside an effect.
- **Non-finite input recovers instead of freezing a body.** Rapier 0.20+ quarantines a body whose
  state goes non-finite (rolls it back and disables it for good), where 0.19 panicked.
  - The pre-step sentinel re-enables a quarantined letter and resets it to its slot.
  - A non-finite slot is replaced by the world centre, once. Before, the spring re-injected NaN every
    frame: the world died on 0.19, and on 0.21 the letter froze and logged an error every frame.
  - `moveDrag`, `moveBodyDrag` and `moveObstacle` ignore non-finite input (the anchor or mirror
    holds); `addObstacle` clamps a non-finite radius (`Math.max(1, NaN)` is NaN).
- **`moveBodyDrag` never moved anything.** `stepCelebrate` steers only the letter drag, so a prop
  grabbed with `startBodyDrag` hung from an anchor that stayed where it was grabbed. `moveBodyDrag`
  now sets the anchor's kinematic target.
- **React 19.2 `<Activity>`:** re-showing a hidden `<CelebrateBubbles>` threw. The `play` effect
  called the destroyed build's `wake()` before the new build published (`app.ticker` is null after
  destroy).
- **`<GlyphHullLab>` / `<GlyphHullEditor>` unmounted during PIXI init blanked the host page.** They
  destroyed a half-built Application (PIXI 8 throws). They now adopt the app only once `init()`
  resolves, and all three components share `safeDestroyApp`.
- **Exit:** a letter can no longer be grabbed mid-exit (the exiting step never moves the anchor, so it
  hung in the air), and `armEnclosureNow` no longer re-cages an exit that began before the cage went
  up (the component path: `exiting` already true when the build finishes, with reduced motion; the
  letters landed instead of leaving).
- `resizeLetterColliders` rebuilt a ghost's or a pass-through letter's colliders solid; the letter now
  keeps its collision mode.
- `setWallGroups(null)` only took effect on the next cage rebuild; it now restores the default groups
  on the live cage.

## 0.10.0 — 2026-07-22

Consumer-facing hull tooling: a project can now point `GlyphHullEditor` / `GlyphHullLab` at its
OWN glyph set + authored hulls (and a mascot), instead of forking the tools to swap in demo data.

### Added
- **`hulls` prop on `GlyphHullEditor` and `GlyphHullLab`** — the injected authored-hull map to
  edit / overlay. Defaults to the built-in `GLYPH_HULLS`, so existing no-prop mounts are unchanged.
  Pair with `makeHullForGlyph(hulls)` at the app boundary.
- **`extraObjects` prop on `GlyphHullEditor`** — non-glyph editable objects (e.g. a mascot) shown
  as extra tabs (a trailing "Objects" band), each with an image backdrop drawn at exactly 1 grid
  unit (`unit: 'width' | 'height'`) and its own default hull. An object with `exportAs` is emitted
  as its own `export const <name>: HullShape[]` block instead of folded into the `GLYPH_HULLS` map.
  New `HullExtraObject` type exported.
- **`storageKey` prop on `GlyphHullEditor`** — namespaces the localStorage WIP so two consumers on
  one origin don't clobber each other's in-progress hulls.

All three props are optional and default to today's behavior; the library's own demo mounts need no
changes.

## 0.9.0 — 2026-07-22

The bundled hull map becomes a standard library: it now covers the **whole printable-ASCII set**,
so the engine can set any word or number, and the Hull editor is organized to match.

### Added
- **Digits 0–9 and every ASCII punctuation mark now have authored hulls.** They are *derived* from
  the Cherry Bomb One outlines by the same fitted ink-box→frame transform as the A–Z set (one ball
  where the ink is roughly square, an axis-aligned oval otherwise), which reproduces the hand-placed
  hulls to within ~2 % of the glyph. Previously these fell back to a generic centred ball, which
  mis-placed off-centre marks (high apostrophes, low commas, tall bars). Diagonal/split marks
  (`/ \ % & " : ; =`) get a single bounding blob — deliberate, and flagged in-source as the first
  candidates to refine by hand.
- **`GLYPH_GROUPS`** (and the `GlyphGroup` type) — the printable-ASCII set banded into
  Uppercase / Lowercase / Digits / Punctuation, for the editor palette and lab contact sheet.

### Changed
- **Retuned the hand-authored and derived hulls** from an editor pass (includes collapsing `!` from
  a stem+dot pair into one slim capsule).
- **`EDITABLE_GLYPHS` now enumerates the full ASCII set in grouped order** (Uppercase → Lowercase →
  Digits → Punctuation) instead of demo-phrase-first. The **Hull editor** palette is laid out in
  those labelled bands (demo-phrase glyphs pink-bordered), the **Hull lab** contact sheet follows,
  and the editor's *Copy code* output is grouped with section-header comments.

### Fixed
- **The editor's baked-code emitted malformed TypeScript for the `'` and `\` glyph keys** (`'''`
  and `'\'`). Keys are now quoted correctly (`"'"` and `'\\'`), so a re-bake that includes those
  marks pastes back cleanly.

## 0.8.4 — 2026-07-22

Minor stability polish (audit follow-ups).

### Fixed
- **Exit never let the ticker idle.** `exitCelebrate` set `exiting = true`
  permanently; while exiting, the step pinned `settledFrames = 0`, so a host
  that kept the component mounted after a finish/hide ran the loop at 60fps
  forever. Once every letter has fallen clear of the bottom, `settledFrames`
  now accumulates so the idle gate can fire.
- **`world.dead` was only honored by `stepCelebrate`.** After a caught WASM
  panic, the other public mutators (`retargetLetter`, `scatterLetter`,
  `cullDiscarded`, the drag trio, `resizeWorld`, `addLetter`, `removeLetter`,
  `solidifyLetter`) still touched the poisoned instance. They now no-op when
  `dead`. (The React component was already safe — its ticker checks `dead`.)
- **No way to re-cage after `removeWalls`.** `armEnclosureNow` no-op'd on the
  stale `wallsAdded` flag; it now rebuilds whenever the walls are actually
  absent, so a framework-free consumer can bring the enclosure back after a
  morph.
- **`getObstacles()` returning `undefined` orphaned mirrors.** A present getter
  that returned `undefined` (paused / no data) skipped reconciliation, leaking
  every kinematic mirror body. Undefined is now treated as "none now" and the
  mirrors are cleaned up.

## 0.8.3 — 2026-07-22

Stability fixes from a multi-agent audit.

### Added
- `resizeLetterColliders(state, index, colliders)` — rebuild a letter's physics
  hull in place at a new size.

### Fixed
- **Survivor colliders on a size-changing morph.** A reused glyph was re-styled
  and moved but its Rapier hull stayed frozen at the size it was created, so in
  a differently-sized phrase survivors collided as their old, too-large selves,
  shoved each other off their slots, and never settled — `settledFrames` never
  crossed idle, so a self-driven host's ticker never stopped (mobile battery).
  `<CelebrateBubbles>` now rebuilds each survivor's hull during the transition.
- **Scrambled wordmark on resize after a morph.** After a word-to-word
  transition the letter arrays are no longer in slot order, but the same-size
  resize path re-homed by array index — reassembling the wordmark scrambled and
  building each collider hull for the wrong glyph. A resize after a morph now
  forces a clean rebuild (which re-deals in slot order) instead.
- **Rejected Rapier init was cached forever.** A transient loader/WASM failure
  left `ensureRapierInitialized` holding a rejected promise, wedging Rapier and
  `setRapierLoader` for the life of the page. It now clears on failure so a
  retry can re-init.
- **Non-finite reset target.** The NaN-pose safety net reset a letter to its
  slot without checking the slot itself was finite; a non-finite slot made it a
  no-op that re-injected NaN forever. It now falls back to the world center.
- `createWallCage`'s `WallCage.floor` JSDoc now warns that it is the same body
  as `walls[1]` (removing both double-frees and panics the WASM).

## 0.8.2 — 2026-07-22

### Fixed

- **Texture GC off for the letter canvas** (`textureGCActive: false`). PIXI 8.19's texture GC
  can double-return a canvas-text texture an explicit destroy already returned —
  `TexturePool.returnTexture` then reads an undefined pool entry and throws, at runtime from
  the GC pass and at teardown inside `app.destroy` (the crash `safeDestroyApp` was swallowing).
  This component destroys every Text it creates, so the GC bought nothing here.

## 0.8.1 — 2026-07-21

### Fixed

- **The panic guard survives its own diagnostics.** The forensic dump reads the just-poisoned
  wasm world; if those reads trap, the freeze now still lands (dump degrades to a placeholder).
- **The component honors a dead world**: the ticker stops instead of reading letter bodies from
  poisoned wasm memory every frame; letters hold their last painted pose.
- `safeDestroyApp` logs what it swallows — a teardown throw is survivable, not invisible.
- The hand-off lifecycle test's imports were mis-rooted (resolved only via a vite-node fallback).

## 0.8.0 — 2026-07-21

Ports from little_striders — the app this library was extracted from had kept improving its
vendored copy; 0.8.0 brings those improvements home ahead of its migration onto the package.

### Added

- **`setWallGroups(state, groups)`** — stamp collision groups on every cage collider, now and on
  every rebuild (resize, post-transition). For a host body that must pass THROUGH the walls while
  the letters stay caged (the strider cheetah). `null` restores the default.

### Changed

- **The idle gate gained a velocity term.** A letter sitting on its slot but still visibly moving
  or spinning no longer counts as calm — `settledFrames` can't accrue mid-wobble, so a host ticker
  never stops while pixels are changing.
- **Structural rebuilds re-deal from the top.** `colorSeq` resets when a resize/rotation rebuilds
  the same word, so the palette and pattern offsets reproduce instead of reshuffling. Transitions
  still deal forward (and `slotColor` pins are unaffected).
- **Pointermoves are rAF-coalesced** (one layout-forcing rect read per frame, latest event wins),
  and all pointer/key listeners are `passive`.

### Fixed

- **Per-letter styles are freed with their letters.** Culls, rebuilds, and refits destroy the
  replaced `TextStyle` (shared underlying textures untouched) — under a `styleFor` pattern factory
  the old behavior leaked a style + fill pattern per cull/refit.
- The `d` debug hull overlay draws ABOVE the letters (it rendered behind them).
- The canvas container is `aria-hidden` — a decorative physics toy shouldn't reach screen readers.

## 0.7.3 — 2026-07-21

### Changed

- **Letter legibility over busy fields**: the white outline is thicker (0.045em → 0.062em) and
  the drop shadow is now a soft close hug (alpha 0.34 → 0.16, distance 0.085em → 0.045em,
  blur 3 → 4). The old heavy offset shadow read as a black smear against saturated backgrounds.
  Metrics change with it (metricStyle is the one source), so measurement/colliders stay agreed.

### Fixed

- **Teardown can no longer feed the host's error boundary.** PIXI v8's canvas-text texture pool
  can double-return a texture inside `app.destroy` (its GC may have unloaded it while the ticker
  slept), throwing mid-cleanup during React unmount. All destroy sites now go through
  `safeDestroyApp`: swallow, drop the canvas, move on — the app was being discarded anyway.

## 0.7.2 — 2026-07-21

### Fixed

- **A Rapier wasm panic can no longer freeze the host page.** `stepCelebrate` wraps the step:
  on the first panic the world is marked dead and freezes in place (letters hold their last pose)
  instead of re-throwing out of the host ticker every frame. A pre-step sentinel also catches any
  non-finite letter pose the frame it appears, logs a forensic line naming the letter, and resets
  it to its slot — so an upstream math bug degrades to one visible snap, not a dead world.

## 0.7.1 — 2026-07-21

### Added

- **`LayoutOptions.slotColor` / `Slot.color` — per-slot pinned colours.** The dealt-palette
  counter is monotonic across rebuilds, so a HUD hand-off could not predict which colours new
  letters would draw; a layout can now pin them (colour continuity with the HUD twin). Pins apply
  only at letter creation — survivors keep the colour they already wear.

## 0.7.0 — 2026-07-21

### Added

- **HUD hand-off primitives** — three small pieces that together let a non-physics HUD element
  (a corner odometer) hand its glyphs to the physics world and have them travel on the sim:
  - `LayoutOptions.lineXs` — per-line centre **x** (mirrors `lineYs`; default stays centred),
    for edge-anchored lines.
  - `LayoutOptions.baseSize` now also accepts `(vw, vh) => number`, so a line's size can be
    derived from the live viewport (e.g. matching a sibling HUD element's font size).
  - `LayoutOptions.spawnAtSlot` (carried onto `LayoutResult`) — letters MISSING in a transition
    to this layout materialize AT their slots, upright and at rest, instead of flying in from an
    edge. Stage the swap under the hidden HUD twin, then transition to the real layout: the same
    bodies retarget and physically travel there.
  - `addLetter(state, spec, atSlot?)` gained the matching optional parameter.

## 0.6.1 — 2026-07-21

### Fixed

- **`busy` no longer strands transition fly-ins.** The untangle stand-down now protects only
  letters that have ARRIVED at a slot at least once (the held-prop case it was built for). A
  never-arrived fly-in pressed against a busy obstacle field — e.g. a wobbling blob wall that
  keeps `busy` true indefinitely — keeps its untangle rights and ghost-glides home through the
  crowd, instead of leaning on the first obstacle forever.

## 0.6.0 — 2026-07-21

### Added

- **`styleFor` prop — custom letter text styles (patterned fills).** A mount-time factory
  `(color, size, seq) => PIXI.TextStyle`; defaults to the classic solid-fill `letterStyle`.
  `seq` is the letter's deal order, for per-letter pattern offsets. Keep `metricStyle`'s
  metrics or layout and colliders will disagree with the drawing. Letters now remember their
  dealt colour + seq, so transition refits restyle correctly even with non-numeric fills.

### Notes

- An EMPTY morph target (`lines: []`) is supported and scatters every letter — a host can
  explode the whole phrase and later fly a new one in from the edges.

## 0.5.1 — 2026-07-21

### Fixed

- **A mirror resting on a letter's slot no longer causes a ghost/eject oscillation.** With the
  untangle armed, a letter whose home sat under a stationary obstacle was read as wedged,
  ghost-driven through the mirror, re-solidified inside it, and ejected — every ~0.7s, forever.
  A resting mirror overlapping any letter's SLOT now asserts `busy`, so the letter leans on it
  until it drifts away.

### Added

- Authored a slim `!` hull (stem capsule + dot). It previously fell back to a grab-box ball,
  which collided ~3× wider than the glyph.

## 0.5.0 — 2026-07-20

### Added

- **Host obstacles — letters bounce off ANOTHER simulation.** New `getObstacles` prop: a
  per-frame getter of `{ id, x, y, r }` poses mirrored into the letter world as kinematic
  balls (reconciled by id, radius breathes in place). Letters carom off them and inherit
  momentum from movers; mirrors never yield — the foreign sim is the authority. Mirror motion
  asserts `busy` internally (per-mirror 2px hysteresis) so pressed letters push instead of
  ghosting through, and the idle gate is disabled while the prop is set (a stopped ticker
  couldn't see a mirror coming). Framework-free primitives exported too:
  `addObstacle` / `moveObstacle` / `removeObstacle` + `Obstacle` / `ObstaclePose`.

## 0.4.1 — 2026-07-20

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

## 0.4.0 — 2026-07-20

### Changed (visual default)

- **Transition debris now BONKS.** Letters dropped in a word-to-word transition fly off SOLID by
  default, colliding with the forming word and each other on the way out — a livelier, more chaotic
  effect than the previous clean pass-through. A solid straggler that wedges on-screen drops to
  pass-through after ~2.5s so it can still escape, and the cull backstop sweeps whatever remains.
  Pass `scatterStyle="through"` (component) or `scatterLetter(state, i, { solid: false })` (physics)
  for the old calm morph.

  This restores an effect the app that seeded this library had evolved (solid-bonk) but that an
  earlier merge had replaced with the tamer pass-through while fixing an unrelated freeze bug.

### Added

- `<CelebrateBubbles scatterStyle>` — `'bonk'` (default) or `'through'`.
- `scatterLetter(state, index, { solid })` — `solid` defaults true.

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

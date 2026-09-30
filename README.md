# bubble-rapier-text

Physics-driven **"Celebrate your hard work"** bubble text. Each glyph is a [PIXI](https://pixijs.com)
bubble-letter backed by a [Rapier](https://rapier.rs) 2D rigid body whose collider is a
**hand-authored hull** of curved primitives tracing the letter. Letters rain in from the
edges, per-letter springs pull each toward its slot and upright, and they tumble and bonk
into one another until the phrase self-assembles into legible text. Grab a letter to fling
it — the springs carry it home.

Ships with the interactive **hull editor** used to author those colliders against the real
font, plus a calibration **lab** for screenshots and overlays.

This repository is self-contained: `npm install && npm run dev` runs the celebration text
natively, fully offline (the display font is vendored).

---

## Quick start

```bash
npm install
npm run dev      # → http://localhost:5173  (Celebrate / Hull editor / Hull lab)
```

The demo nav switches between the three surfaces:

- **Celebrate** — the live bubble text. Drag a letter; press **`d`** to overlay the collision
  hulls; use **Replay**, **Exit ⬇**, and the **frame** toggle to exercise the component props.
- **Hull editor** — drag/resize/rotate the collider primitives on top of each glyph; copy the
  baked code back into `src/glyphHulls.ts`.
- **Hull lab** — render any glyph large with grid + hull overlay (URL params below).

Other scripts:

```bash
npm run build      # static demo build → demo-dist/
npm run preview    # serve the built demo
npm run typecheck  # tsc -b (strict, no emit)
npm run lint       # eslint, zero-warning
npm test           # vitest (pure geometry + a real Rapier world)
npm run build:lib  # the published library bundle → dist/ (ESM + .d.ts)
npm run check:browser  # headless-Chrome lifecycle checks against `npm run dev` (see the script's header)
```

---

## Use it in your app

The package's `exports` point at the prebuilt ESM bundle in `dist/` (with `.d.ts` alongside), so
any bundler — Vite, Next, webpack, Rollup, esbuild — or plain node ESM can consume it. `prepare`
builds that bundle on install, so a git dependency works too:

```bash
npm i github:teacherIan/bubble-rapier-text
```

```tsx
import { CelebrateBubbles } from 'bubble-rapier-text'
import 'bubble-rapier-text/styles.css' // registers the vendored "Cherry Bomb One" face

export function Splash() {
  return (
    <div style={{ position: 'relative', width: '100%', height: '100vh' }}>
      <CelebrateBubbles position="absolute" />
    </div>
  )
}
```

**Peer dependencies:** `react`, `react-dom` (18 or 19), `pixi.js` (8), and
`@dimforge/rapier2d-compat` (0.19, 0.20 or 0.21 — developed against 0.21, and the test suite passes
on all three). npm 7+ installs peers automatically, so there is nothing extra
to do — they are peers rather than dependencies because their objects cross this package's API
surface (`CelebrateWorld.rapier` is public), and a second copy in the graph means duplicate WebGL
registration and `instanceof` checks that fail across the boundary.

### `<CelebrateBubbles>` props

All optional. **`phrase`, `layout`, `exiting`, and `play` are LIVE** — change `phrase` (or
`layout`) and the current word *morphs* into the new one: matching glyphs glide across, the rest
scatter off, and missing letters fly in. The rest (`hulls`, `palette`, `frame`, `position`, …) are
read once at mount; changing them later does nothing (the component warns in dev). Remount with a
different React `key` to change those.

| Prop          | Type                      | Default   | What it does |
| ------------- | ------------------------- | --------- | ------------ |
| `position`    | `'fixed' \| 'absolute'`   | `'fixed'` | `'fixed'` fills the viewport; `'absolute'` fills a positioned parent (overlay). |
| `exiting`     | `boolean`                 | `false`   | Flip to `true` to fling every letter off the bottom of the screen (a hand-off / dismiss). |
| `transparent` | `boolean`                 | `false`   | Drop the gradient backdrop so whatever's behind shows through. |
| `frame`       | `boolean`                 | `false`   | Push the lines to the top and bottom edges so they *frame* a central element instead of sitting over the middle. |
| `play`        | `boolean`                 | `true`    | **Live.** Hold the letters at their spawn edges until `true`, so a host can finish its own intro first. Latches once released. |
| `phrase`      | `Line[] \| (vw) => Line[]` | the demo phrase | **Live.** The words to set. `Line` is `{ text, weight? }`; `weight` scales that line relative to the others. Changing it morphs the current word into the new one. A function of viewport width lets you restructure on a phone. |
| `hulls`       | `Record<string, HullShape[]>` | bundled | Collision hulls for your glyphs. The bundled set is traced against Cherry Bomb One — a different display face wants its own (see *Authoring hulls*). |
| `palette`     | `readonly number[]`       | 8 festive colours | Per-letter fill colours, cycled. |
| `scatterStyle`| `'bonk' | 'through'`      | `'bonk'`  | How transition debris flies off. `bonk` keeps flung letters SOLID so they collide with the forming word (chaotic, fun); `through` passes them through for a calm morph. |
| `layout`      | `LayoutStrategy`          | derived from `phrase` | **Live.** Full control of slot geometry; overrides `phrase`. Changing it morphs, same as `phrase`. See `createLineLayout`. |
| `idleFrames`  | `number \| false`         | `110`     | Stop the PIXI ticker after this many fully-calm frames; `false` never stops. Wakes on pointer, resize, and exit. |
| `getObstacles` | `() => ObstaclePose[]`   | —         | Kinematic mirrors of bodies simulated in ANOTHER world — letters bounce off them (see [Bouncing letters off another simulation](#bouncing-letters-off-another-simulation)). Polled per frame; disables the idle gate while set. |
| `styleFor`    | `(color, size, seq) => PIXI.TextStyle` | the classic solid fill | Custom letter text styles — patterned fills, themed strokes. Gets the letter's dealt colour, slot size, and deal order (`seq`, for per-letter pattern offsets). KEEP `metricStyle`'s metrics or layout and colliders will disagree with what's drawn. Mount-time. |
| `reducedMotion` | `boolean`               | the media query | Force the no-rain path: letters start on their slots and the cage goes up immediately. |
| `maxResolution` | `number \| (w) => number` | `2` ≤640px, else `2.5` | Cap on `devicePixelRatio`. A phone at DPR 3 renders 9× the pixels for no visible gain. |
| `background`  | `string`                  | a soft gradient | CSS background behind the canvas. `transparent` wins over it. |
| `title`       | `string`                  | `'Drag a letter'` | The container's tooltip. User-visible text — set it in a non-English host. |
| `onReady`     | `() => void`              | —         | Fires on the first painted frame. Hide your own boot screen here. |
| `onError`     | `(err: unknown) => void`  | —         | Init failed (WebGL blocked, WASM refused). Leave your fallback UI up. |

### Retheming

`phrase`, `hulls`, `palette`, and `background` are props — you should not need to fork this package
to change the words or the look. The display **font** is the one thing still baked in
(`src/styles.css` registers the vendored face, and `src/letterStyle.ts` names it); swapping it also
means authoring hulls for the new face, since the bundled hulls trace Cherry Bomb One specifically.

### Lower-level exports

You don't have to use the React component. The physics is framework-free (Rapier only) and
the hull data + helpers are plain functions:

```ts
import {
  // framework-free sim — drive it from your own render loop
  createCelebrateWorld, stepCelebrate, solidifyLetter, exitCelebrate,
  armEnclosureNow, // skip the entrance delay when letters start at their final pose
  // re-layout: morph the live world into a NEW word — reuse matching glyphs, fling the rest
  // off (scatterLetter), fly missing ones in (addLetter); removeWalls opens the edges first
  removeWalls, retargetLetter, scatterLetter, addLetter,
  removeLetter, cullDiscarded, // collect flung letters once they're off-screen
  resizeWorld, // resize + rebuild the enclosure on a viewport / device-rotation change
  setWallGroups, // collision groups for the cage, e.g. a host body that passes through the walls
  // drag: a revolute "mouse joint" — the grabbed point hinges to the cursor, so a letter
  // picked up by its top edge dangles and swings
  startLetterDrag, moveDrag, releaseDrag,
  startBodyDrag, moveBodyDrag, endBodyDrag, // …and the same hinge for YOUR bodies
  type LetterSpec, type LetterBody, type CelebrateWorld, type MouseJoint,
  // which live letter claims which new slot (pairs with the re-layout primitives above)
  planClaims,
  // slots derived from the live viewport; recompute on resize
  createLineLayout,
  // glyph hulls — pass your own map, or bind one with makeHullForGlyph. Covers all printable ASCII.
  GLYPH_HULLS, GLYPH_LIST, GLYPH_GROUPS, EDITABLE_GLYPHS, hullForGlyph, makeHullForGlyph, scaleHull, strokeHullPx,
  // the ONE text style the component and both dev tools render with
  letterStyle, metricStyle, FONT_STACK,
  // shared Rapier-world primitives; setRapierLoader swaps in your own WASM build
  createPhysicsWorld, createWallCage, ensureRapierInitialized, setRapierLoader,
} from 'bubble-rapier-text'
```

Driving it yourself means calling `stepCelebrate(world, dt)` on a fixed timestep and copying each
body's pose onto your own sprites. `world.settledFrames` counts consecutive fully-calm frames, so a
host can stop its render loop once the scene is at rest:

```ts
if (world.settledFrames > 110 && !world.drag) stopMyTicker()
```

The self-assembly is robust: each letter frees itself from a wedge on its own schedule. A wedged
letter is GHOSTED (collisions off) and then **driven** home — its pose is lerped straight to
slot + upright each frame, so it converges by construction. (It has to be driven, not sprung: a
collider-disabled body's mass properties are inert, so impulses do nothing to a ghost.) Two
independent triggers catch it — parked-and-wrong for a letter that comes to rest, and a
speed-independent watchdog for one that neighbours keep jostling so it never parks. A jittery
neighbour therefore can't trap it, including a thin glyph that settles on its side.

See the full public surface in [`src/index.ts`](src/index.ts).

---

### Sharing one Rapier init with a host app

If your app already initializes Rapier for its own physics (or you'd rather ship a raw `.wasm`
than the compat build's inlined base64), point the library at YOUR loader **at module scope**,
before anything mounts:

```ts
import { setRapierLoader } from 'bubble-rapier-text'
import { ensureRapierInitialized } from '@/lib/physics/rapierInit' // your app's once-per-page init

setRapierLoader(ensureRapierInitialized)
```

`setRapierLoader` throws if the library's own init already started — call it in the module that
lazy-imports the component, not in an effect. One Rapier instance means one WASM decode and no
cross-instance `instanceof` misses between your bodies and the library's.

### Bouncing letters off another simulation

Two Rapier worlds can never collide — but if your page also runs its OWN sim (soft-body blobs in
a worker, a mascot), the letters can still bounce off it via **kinematic mirrors**: hand the
component a getter that re-states the foreign bodies' poses each frame, in this component's
CSS-px space:

```tsx
const posesRef = useRef<ObstaclePose[]>([])   // your other sim writes here at its own cadence
const getObstacles = useCallback(() => posesRef.current, [])

<CelebrateBubbles getObstacles={getObstacles} />
```

Mirrors are reconciled by `id` (new id → added, missing id → removed, `r` breathes in place).
The solver treats them as infinitely heavy: letters carom off and inherit momentum from a moving
mirror, and can never push back — the foreign sim stays the authority. While any mirror is moving
the wedged-letter untangle stands down (a pressed letter pushes instead of ghosting through), and
the idle gate is disabled whenever the prop is set, because a stopped ticker couldn't see a
mirror coming. Driving the sim yourself instead? The same primitives are exported:
`addObstacle` / `moveObstacle` / `removeObstacle`, plus `busy` on `stepCelebrate`.

### Layout control: `createLineLayout`

`createLineLayout({ lines, measure, ... })` returns a `LayoutStrategy` — a function from viewport
to per-character slots, plus a structural `signature` the component uses to tell a resize re-home
from a real morph. Beyond the basics (`baseSize`, `widthBudget`, `heightBudget`, `maxScale`,
`lineYs`, `frame`), three options exist for **HUD hand-offs** (added in 0.7.x):

| Option        | What it does |
| ------------- | ------------ |
| `lineXs`      | Per-line centre **x** (mirrors `lineYs`; default centres on the viewport). Edge-anchor a line over a HUD element. |
| `baseSize`    | Also accepts `(vw, vh) => number`, so a line's font size can match a sibling HUD element exactly. |
| `spawnAtSlot` | Letters MISSING in a transition to this layout **materialize at their slots**, upright and at rest, instead of flying in from an edge. |
| `slotColor`   | Pin per-slot colours (`(lineIndex, charIndex, ch) => number \| undefined`). The dealt-palette counter is monotonic across rebuilds, so colour continuity with a HUD twin needs pins. Pins apply at letter creation; survivors keep the colour they wear. |

The pattern: render your HUD element (a canvas odometer, a DOM counter) normally; at the hand-off
moment, transition to a `spawnAtSlot` layout whose slots sit exactly over it — same size (viewport
`baseSize`), same advances (your `measure`), same colours (`slotColor`) — and hide the HUD element
the same frame. The letters are now real physics bodies wearing identical pixels. A beat later,
transition to your real layout: the same bodies **retarget and travel there on the sim**. No fades,
no seam.

## Authoring collision hulls

Each glyph's collider is a small compound of **curved** primitives — `ball`, `cap` (capsule),
`rrect` (Rapier `roundCuboid`), `oval` (a `roundConvexHull` of points on an ellipse). Curved
only, by design: a sharp corner catches on a neighbour and wedges the pile, whereas these
slide past each other. The hulls are authored in **font-size units** with the origin at the
glyph centre (the PIXI text anchor `0.5`), so a hull authored against the rendered glyph drops
straight onto the physics body with no per-glyph calibration.

**Coverage.** `GLYPH_HULLS` ships a hull for the whole **printable-ASCII set** — all 52 letters,
the ten digits, and every ASCII punctuation mark — so the engine can set *any* word or number, not
just the demo phrase. The demo-phrase letters are hand-traced; the rest are **derived** from the
Cherry Bomb One outlines by the fitted ink-box→frame transform (one ball where the ink is roughly
square, an axis-aligned oval otherwise), which reproduces the hand-placed hulls to within ~2 % of
the glyph. Diagonal or split marks (`/ \ % & " : ; =`) get a single bounding blob that over-covers
the gaps — fine for physics ("reads as the mark and slides"), but the first candidates to refine by
hand. Anything the map *doesn't* cover (accented Latin-1, symbols) still works via `hullForGlyph`'s
single-ball fallback. `GLYPH_GROUPS` bands the set (Uppercase / Lowercase / Digits / Punctuation)
for the dev tools.

To retune a glyph:

1. `npm run dev` → **Hull editor**. The palette is grouped into those bands; demo-phrase glyphs are
   pink-bordered.
2. Pick the glyph, drag the body / yellow size handles / blue rotate handle. `b`/`c`/`x`/`v`
   add a ball/capsule/rect/oval; `⌫` deletes; `←`/`→` switch glyphs.
3. Hit **Copy code** and paste the grouped `GLYPH_HULLS` block back into
   [`src/glyphHulls.ts`](src/glyphHulls.ts).

Edits also mirror to `localStorage` (key `celebrateGlyphHulls.v1`) so the editor survives a
reload mid-session.

### Hull lab URL params

On the **Hull lab** view (`/` then pick the tab — params read from the query string):

| Param      | Effect |
| ---------- | ------ |
| `?i=<n>`   | render only `GLYPH_LIST[n]`, large |
| `?g=<char>`| render a specific character |
| `?hull=1`  | overlay the authored hull (same path as the live `d` overlay) |
| `?all=1`   | 4×N contact sheet of every glyph |

---

## How it works

- [`src/celebratePhysics.ts`](src/celebratePhysics.ts) — the world: spawn-from-edges entrance,
  per-letter slot + upright springs, a revolute "mouse joint" drag (the grabbed point hinges to
  the cursor, so a letter picked up by its top edge dangles and swings), a "ghost-home" untangle
  that disables collisions on a wedged letter and DRIVES its pose home, and the exit.
  Framework-free so it can run on the main thread or in a worker.
- [`src/CelebrateBubbles.tsx`](src/CelebrateBubbles.tsx) — PIXI render, canvas glyph
  measurement, pointer input, and the fixed-step ticker that steps the sim in lockstep with
  rendering.
- [`src/glyphHulls.ts`](src/glyphHulls.ts) — the hull data, `scaleHull` (units → px), and
  `strokeHullPx` (the single draw path shared by the editor, the lab, and the in-app `d`
  overlay — so what you tune is exactly what collides).
- [`src/lib/physics/`](src/lib/physics) — shared Rapier bootstrap (`createPhysicsWorld` with
  `lengthUnit = 100` for pixel-space sims) and a reusable wall cage.

Rapier ships its core as WASM; `ensureRapierInitialized()` loads it once per page and every
consumer owns its own `World`.

---

## Font & license

- Code: **MIT** — see [`LICENSE`](LICENSE).
- Font: **"Cherry Bomb One"** (Latin subset) is vendored at
  `src/assets/fonts/cherry-bomb-one-latin.woff2` and licensed under the **SIL Open Font
  License 1.1** — see [`OFL.txt`](OFL.txt). The components race a short font-load timeout and
  fall back to a system sans, so text always appears; but the hand-authored hulls trace the
  Cherry Bomb One face specifically, so that's the face to render for correct collisions.

  Prefer the CDN instead of the vendored file? Skip the `styles.css` import and add to your
  `<head>`:

  ```html
  <link href="https://fonts.googleapis.com/css2?family=Cherry+Bomb+One&display=swap" rel="stylesheet" />
  ```

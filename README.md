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
npm run build      # static demo build → dist/
npm run preview    # serve the built demo
npm run typecheck  # tsc -b (strict, no emit)
npm run build:lib  # optional precompiled library bundle → dist/ (ESM + .d.ts)
```

---

## Use it in your app

The package's `exports` point at the TypeScript **source**, so a bundler-based app
(Vite, Next, webpack 5, …) can consume it directly — no build step required.

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

Peer dependencies: `react` and `react-dom` (18 or 19). `pixi.js` and
`@dimforge/rapier2d-compat` come along as regular dependencies.

### `<CelebrateBubbles>` props

All optional. The world is built **once** on mount; `position` / `frame` / `transparent` are
read from the initial render. `exiting` is live (flip it to trigger the exit).

| Prop          | Type                      | Default   | What it does |
| ------------- | ------------------------- | --------- | ------------ |
| `position`    | `'fixed' \| 'absolute'`   | `'fixed'` | `'fixed'` fills the viewport; `'absolute'` fills a positioned parent (overlay). |
| `exiting`     | `boolean`                 | `false`   | Flip to `true` to fling every letter off the bottom of the screen (a hand-off / dismiss). |
| `transparent` | `boolean`                 | `false`   | Drop the gradient backdrop so whatever's behind shows through. |
| `frame`       | `boolean`                 | `false`   | Push the two lines to the top and bottom edges so they *frame* a central element instead of sitting over the middle. |

The phrase, sizes, palette, and font live as constants at the top of
[`src/CelebrateBubbles.tsx`](src/CelebrateBubbles.tsx) — edit there to retheme.

### Lower-level exports

You don't have to use the React component. The physics is framework-free (Rapier only) and
the hull data + helpers are plain functions:

```ts
import {
  // framework-free sim — drive it from your own render loop
  createCelebrateWorld, stepCelebrate, solidifyLetter, exitCelebrate,
  // re-layout: morph the live world into a NEW word — reuse matching glyphs, fling the rest
  // off (scatterLetter), fly missing ones in (addLetter); removeWalls opens the edges first
  removeWalls, retargetLetter, scatterLetter, addLetter,
  resizeWorld, // resize + rebuild the enclosure on a viewport / device-rotation change
  type LetterSpec, type CelebrateWorld,
  // glyph hulls
  GLYPH_HULLS, GLYPH_LIST, hullForGlyph, scaleHull, strokeHullPx,
  // shared Rapier-world primitives
  createPhysicsWorld, createWallCage, ensureRapierInitialized,
} from 'bubble-rapier-text'
```

The self-assembly is robust: each letter frees itself from a wedge on its own schedule (it
ghosts + gets a kick toward its slot when its placement score stalls), so a jittery neighbour
can't trap it — including a thin glyph that settles on its side. See the public surface in
[`src/index.ts`](src/index.ts).

---

## Authoring collision hulls

Each glyph's collider is a small compound of **curved** primitives — `ball`, `cap` (capsule),
`rrect` (Rapier `roundCuboid`), `oval` (a `roundConvexHull` of points on an ellipse). Curved
only, by design: a sharp corner catches on a neighbour and wedges the pile, whereas these
slide past each other. The hulls are authored in **font-size units** with the origin at the
glyph centre (the PIXI text anchor `0.5`), so a hull authored against the rendered glyph drops
straight onto the physics body with no per-glyph calibration.

To retune a letter:

1. `npm run dev` → **Hull editor**.
2. Pick the glyph, drag the body / yellow size handles / blue rotate handle. `b`/`c`/`x`/`v`
   add a ball/capsule/rect/oval; `⌫` deletes; `←`/`→` switch letters.
3. Hit **Copy code** and paste the `GLYPH_HULLS` block back into
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
  per-letter slot + upright springs, a centre-anchored drag spring (no orbiting), a
  "ghost-home" untangle that briefly disables collisions on wedged letters so they glide into
  place, and the exit. Framework-free so it can run on the main thread or in a worker.
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

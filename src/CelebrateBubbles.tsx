import { useEffect, useRef } from 'react'
import * as PIXI from 'pixi.js'
import 'pixi.js/unsafe-eval'
import {
  createCelebrateWorld,
  stepCelebrate,
  solidifyLetter,
  exitCelebrate,
  startLetterDrag,
  moveDrag,
  releaseDrag,
  armEnclosureNow,
  cullDiscarded,
  removeLetter,
  addLetter,
  retargetLetter,
  resizeWorld,
  removeWalls,
  scatterLetter,
  addObstacle,
  moveObstacle,
  removeObstacle,
  type Obstacle,
  type ObstaclePose,
  type LetterSpec,
  type CelebrateWorld,
} from './celebratePhysics'
import { GLYPH_HULLS, makeHullForGlyph, scaleHull, strokeHullPx, type HullShape, type PxShape } from './glyphHulls'
import { letterStyle, metricStyle, SPACE_FRAC } from './letterStyle'
import { createLineLayout, type Line, type LayoutStrategy, type Slot } from './layout'
import { planClaims, type LetterView } from './transition'

// "Celebrate your hard work" rendered as physics objects: each glyph is a Pixi
// bubble-letter backed by a Rapier rigid body whose collider is a HAND-AUTHORED hull of
// curved primitives tracing the glyph (see glyphHulls.ts; tune them in /glyph-editor).
// Letters rain in from above and per-letter springs pull each toward its slot + upright,
// so they tumble + bonk into each other and self-assemble into legible text. Drag a
// letter to fling it (grab point matters — off-center pulls rotate it); the springs then
// carry it back home.
//
// Physics lives in celebratePhysics.ts (framework-free, Rapier only); this component
// does PIXI render, glyph measurement (canvas), and pointer input, and steps the sim in
// the PIXI ticker — physics and render in lockstep on the same thread (smoother than an
// off-thread worker for ~21 light bodies, which aren't the bottleneck; the worker pattern
// stays available in celebratePhysics if a heavy/simultaneous case ever needs it).

// The demo phrase. `weight` keeps the subtitle half the size of the display line — without it a
// single fitted size would render both at 120px.
const DEFAULT_LINES: Line[] = [
  { text: 'CELEBRATE', weight: 1 },
  { text: 'your hard work', weight: 0.5 },
]
const BASE_SIZE = 120 // px for a weight-1 line before fitting
// Warm the face at ONE representative size. Sizes are fitted at runtime now, so there are no fixed
// sizes left to warm — and a face loaded at any size is loaded for all of them.
const FONT_LOAD_PX = 120

// One festive color per letter (cycled). The default; override with the `palette` prop.
const PALETTE = [0xef6f6c, 0xf4a259, 0xf6c453, 0x8cb369, 0x4d9de0, 0x7768ae, 0xe26d9e, 0x49b6a8]

const GRAB_PAD = 1.15 // forgiveness around a glyph's box when picking under the cursor
// Untangle distance thresholds (px) — base values; scaled by `fit` so on small
// screens a tangled (now-tiny) letter still trips them.
const STUCK_DIST = 48 // from slot, beyond which a settled letter is "out of place"
const UNGHOST_DIST = 22 // from slot, at which a ghosting letter re-solidifies

// Fixed-step accumulator so the frame-count-based untangle logic is stable
// regardless of render fps.
const FIXED_DT = 1 / 60
const MAX_SUBSTEPS = 3
const SPIRAL_CLAMP = 0.25

// A host obstacle counts as MOVING (→ busy: untangle stands down) once it strays this far from
// the last pose that counted. Hysteresis, not a per-frame delta: a calm ring's sub-pixel wobble
// must not hold busy forever (busy starves the wedged-letter self-heal), while a slow drift must
// still accumulate into a real push instead of hiding under the threshold.
const OBSTACLE_WAKE_PX = 2

interface RenderLetter {
  ch: string // the glyph — needed to plan a word-to-word transition (which live letter claims which new slot)
  text: PIXI.Text
  hw: number // glyph half-extents — the grab box
  hh: number
  colliders: PxShape[] // hand-authored compound (balls + capsules) in px, for the `d` debug overlay
}

// `position` lets this be the whole-viewport sandbox (default 'fixed', e.g. /celebrate-text)
// or an in-place overlay filling a positioned parent (e.g. the /celebrate opening title).
// `exiting`: flip true to fling every letter off-screen (the /celebrate Start hand-off).
// `transparent`: drop the gradient backdrop so whatever's behind (e.g. the blob ring) shows.
// `frame`: push the two lines to the top + bottom so they FRAME the centre instead of
// sitting over it (used on /celebrate to wrap the text around the blob circle + button).
export function CelebrateBubbles({
  position = 'fixed',
  exiting = false,
  transparent = false,
  frame = false,
  background,
  title = 'Drag a letter',
  play = true,
  phrase,
  hulls,
  palette = PALETTE,
  scatterStyle = 'bonk',
  layout: layoutProp,
  idleFrames = 110,
  reducedMotion,
  maxResolution = (w) => (w <= 640 ? 2 : 2.5),
  getObstacles,
  onReady,
  onError,
}: {
  position?: 'fixed' | 'absolute'
  exiting?: boolean
  transparent?: boolean
  frame?: boolean
  /** Hold the letters at their spawn edges until true — lets a host finish its own intro first. */
  play?: boolean
  /** The phrase to set. Lines, or a function of viewport width (stack more lines on a phone). */
  phrase?: Line[] | ((vw: number) => Line[])
  /**
   * Collision hulls for YOUR glyphs, keyed by character (font-size units, origin = glyph centre).
   * Defaults to the bundled set, which is traced against Cherry Bomb One — so a different display
   * face wants its own, authored in `<GlyphHullEditor>`. Anything missing falls back to a ball
   * sized to the glyph's box, which collides as a blob rather than as the letter.
   */
  hulls?: Record<string, HullShape[]>
  /** Per-letter fill colours, cycled in order. */
  palette?: readonly number[]
  /**
   * How letters dropped in a transition fly off. `'bonk'` (default) keeps them SOLID so they collide
   * with the forming word and each other on the way out — chaotic and fun. `'through'` passes them
   * through everything for a calm morph.
   */
  scatterStyle?: 'bonk' | 'through'
  /** CSS background behind the canvas. Overrides the default gradient; `transparent` wins over both. */
  background?: string
  /** The container's `title`/tooltip. User-visible text, so a non-English host needs to set it. */
  title?: string
  /** Full control of slot geometry. Overrides `phrase`. */
  layout?: LayoutStrategy
  /** Stop the ticker after this many fully-calm frames; false never stops. */
  idleFrames?: number | false
  /** Override the prefers-reduced-motion media query (letters start home, no rain). */
  reducedMotion?: boolean
  /** Cap on devicePixelRatio. A number, or a function of the viewport width. */
  maxResolution?: number | ((width: number) => number)
  /**
   * Kinematic mirrors of bodies simulated ELSEWHERE (a blob ring in a worker, a mascot), polled
   * every ticker frame — a getter, not state, so 60fps poses never re-render anything (hand a
   * stable function reading a ref). Poses are px in THIS component's box; ids key reconciliation
   * (new id → mirror added, missing id → removed). Letters carom off mirrors; mirrors never
   * yield — the foreign sim is the authority. While any mirror is moving the untangle stands
   * down (a pressed letter pushes instead of ghosting through), and the idle gate is disabled
   * whenever this prop is set: a stopped ticker couldn't see a mirror coming.
   */
  getObstacles?: () => ObstaclePose[]
  /** Fired on the first painted frame — hide your own loading/boot screen here. */
  onReady?: () => void
  /** Init failed (WebGL blocked, WASM refused). Leave your fallback UI up. */
  onError?: (err: unknown) => void
} = {}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const worldRef = useRef<CelebrateWorld | null>(null)
  const exitingRef = useRef(exiting)
  exitingRef.current = exiting
  // Mirrored into refs: the build effect runs ONCE, so its closure must read the latest value
  // rather than whatever was current at mount.
  const playRef = useRef(play)
  playRef.current = play
  const onReadyRef = useRef(onReady)
  onReadyRef.current = onReady
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError
  const getObstaclesRef = useRef(getObstacles)
  getObstaclesRef.current = getObstacles
  // Published by the build effect so the `exiting` effect below can restart a stopped ticker.
  const wakeRef = useRef<(() => void) | null>(null)
  // `phrase` and `layout` are LIVE: changing either morphs the current word into the new one
  // (matching glyphs glide across, the rest scatter, missing ones fly in). The build effect reads
  // these refs (so a change mid-build is honoured) and publishes the morph through transitionRef.
  const phraseRef = useRef(phrase)
  phraseRef.current = phrase
  const layoutPropRef = useRef(layoutProp)
  layoutPropRef.current = layoutProp
  const transitionRef = useRef<(() => void) | null>(null)

  // The world is built ONCE on mount (see the big effect below), so these props are read from that
  // first closure and later changes are silently ignored. Changing one and seeing nothing happen
  // looks exactly like a bug in this library, so say so in dev. (`phrase` and `layout` are NOT here
  // — they are live: changing either morphs the word. `exiting` and `play` are live too.)
  const mountProps = useRef({ hulls, palette, frame, position })
  if (import.meta.env?.DEV) {
    const m = mountProps.current
    const changed = (
      [
        ['hulls', m.hulls !== hulls],
        ['palette', m.palette !== palette],
        ['frame', m.frame !== frame],
        ['position', m.position !== position],
      ] as const
    )
      .filter(([, did]) => did)
      .map(([name]) => name)
    if (changed.length) {
      console.warn(
        `[bubble-rapier-text] ${changed.join(', ')} changed after mount and will be IGNORED — the ` +
          'scene is built once. Remount with a different React `key` to apply it.',
      )
      mountProps.current = { hulls, palette, frame, position } // warn once per change
    }
  }

  // When asked to exit, fling the letters off-screen. (If the world is still being built,
  // the build path checks exitingRef and exits as soon as it's ready.)
  useEffect(() => {
    if (exiting && worldRef.current && !worldRef.current.exiting) {
      exitCelebrate(worldRef.current)
      wakeRef.current?.() // the letters must FALL — a stopped ticker would freeze them in place
    }
  }, [exiting])

  // Same for `play`: if the ticker idled out while held, releasing the hold has to restart it.
  useEffect(() => {
    if (play) wakeRef.current?.()
  }, [play])

  // Live `phrase` / `layout`: on a change, morph the current word into the new one. syncLayout
  // guards on the layout SIGNATURE, so a consumer re-passing an equal phrase as a fresh array each
  // render is a no-op rather than a churn; it also no-ops until the async build has published it.
  useEffect(() => {
    transitionRef.current?.()
  }, [phrase, layoutProp])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    let cancelled = false
    let cleanup: (() => void) | null = null
    // Track partially-built resources so a throw mid-build frees them. Without this, a failed
    // mount leaks a WebGL context and a Rapier world; browsers cap live contexts, so in an SPA
    // that remounts, a handful of failures permanently bricks the canvas.
    let builtApp: PIXI.Application | null = null
    let builtWorld: CelebrateWorld | null = null

    const run = async () => {
      // Load the bubble font, but NEVER block on it — glyph widths/shapes drive the
      // layout + colliders, so we'd like it loaded; race a short timeout and fall back
      // to the stack so the text always appears (still legible either way).
      try {
        await Promise.race([
          document.fonts.load(`400 ${FONT_LOAD_PX}px "Cherry Bomb One"`),
          new Promise((resolve) => setTimeout(resolve, 1500)),
        ])
      } catch {
        /* fall back to FONT_STACK */
      }
      if (cancelled || !containerRef.current) return

      const w = Math.max(1, el.clientWidth)
      const h = Math.max(1, el.clientHeight)

      const app = new PIXI.Application()
      await app.init({
        width: w,
        height: h,
        backgroundAlpha: 0,
        antialias: true,
        autoDensity: true,
        // Clamp DPR. A phone at DPR 3 renders 9x the pixels of DPR 1 for a difference nobody can
        // see on a bubble letter, and pays for it in battery and fill rate.
        // NB deliberately NOT powerPreference:'high-performance' — that forces the discrete GPU on
        // dual-GPU laptops, which would undo the very saving this clamp is making.
        resolution: Math.min(
          window.devicePixelRatio || 1,
          typeof maxResolution === 'function' ? maxResolution(w) : maxResolution,
        ),
        preference: 'webgl',
      })
      if (cancelled || !containerRef.current) {
        app.destroy({ removeView: true }, { children: true })
        return
      }
      app.canvas.style.display = 'block'
      app.canvas.style.width = '100%'
      app.canvas.style.height = '100%'
      el.appendChild(app.canvas)
      builtApp = app
      // Paint by zIndex so a transition can drop scattered debris (0) BEHIND the forming word (1),
      // never over it. Cheap: PIXI only re-sorts when a child's zIndex actually changes.
      app.stage.sortableChildren = true

      // Measure through PIXI's own CanvasTextMetrics, not a raw 2D context: the raw context does
      // not reliably resolve the loaded web face (it silently falls back to the system stack), so it
      // UNDER-measures — the fit then comes out too large and end letters spawn pinned to the walls.
      const measure = (text: string, size: number) => {
        const style = metricStyle(size)
        let total = 0
        for (const ch of text) {
          total += ch === ' ' ? size * SPACE_FRAC : PIXI.CanvasTextMetrics.measureText(ch, style).width
        }
        return total
      }

      // Bind the hull map ONCE here rather than threading it through every build path — this is
      // called per glyph per rebuild.
      const hullFor = makeHullForGlyph(hulls ?? GLYPH_HULLS)
      // An empty palette would make `% palette.length` NaN, index to undefined, and hand PIXI a
      // style with no fill. Fall back rather than render invisible letters.
      const colors = palette.length ? palette : PALETTE

      // Built from the REFS, not the mount-time props, so a phrase/layout change during the async
      // build (slow font load) is picked up rather than lost. syncLayout() below reconciles it.
      const buildLayout = (): LayoutStrategy =>
        layoutPropRef.current ??
        createLineLayout({
          lines: phraseRef.current ?? DEFAULT_LINES,
          measure,
          baseSize: BASE_SIZE,
          frame,
        })
      let layout: LayoutStrategy = buildLayout()

      // ONE build path for a letter, shared by the initial build, a resize rebuild, and any future
      // transition spawn. Divergent build paths are how a letter ends up with a collider that does
      // not match the glyph the viewer sees.
      const renderLetters: RenderLetter[] = []
      let colorSeq = 0 // monotonic, NOT renderLetters.length — culls splice that and colours would drift
      const specFor = (slot: Slot): { spec: LetterSpec; render: RenderLetter } => {
        const t = new PIXI.Text({ text: slot.ch, style: letterStyle(colors[colorSeq++ % colors.length], slot.size) })
        t.anchor.set(0.5)
        app.stage.addChild(t)
        const hw = Math.max(8, t.width * 0.42)
        const hh = Math.max(8, t.height * 0.4)
        // Hand-authored hull (font-size units, origin = glyph centre) scaled to px.
        const colliders = scaleHull(hullFor(slot.ch, hw / slot.size, hh / slot.size), slot.size)
        t.zIndex = 1 // active letters paint in FRONT; scattered debris is dropped to 0 in a transition
        return {
          spec: { colliders, hw, hh, slotX: slot.x, slotY: slot.y },
          render: { ch: slot.ch, text: t, hw, hh, colliders },
        }
      }

      // Re-fit an existing render letter to a (possibly new-sized) slot: restyle at the slot size,
      // recompute the grab box and hull in place. Shared by the resize re-home and the transition
      // survivor path — the glyph itself is unchanged, so its Text is reused rather than rebuilt.
      const refitLetter = (r: RenderLetter, slot: Slot): void => {
        r.text.style = letterStyle(r.text.style.fill as number, slot.size)
        r.hw = Math.max(8, r.text.width * 0.42)
        r.hh = Math.max(8, r.text.height * 0.4)
        r.colliders = scaleHull(hullFor(slot.ch, r.hw / slot.size, r.hh / slot.size), slot.size)
      }

      let { slots, fit, sizes } = layout(w, h)
      let lastSig = layout.signature(w)
      const specs: LetterSpec[] = []
      for (const slot of slots) {
        const { spec, render } = specFor(slot)
        specs.push(spec)
        renderLetters.push(render)
      }

      const world: CelebrateWorld = await createCelebrateWorld(specs, w, h, STUCK_DIST * fit, UNGHOST_DIST * fit)
      if (cancelled || !containerRef.current) {
        world.world.free()
        app.destroy({ removeView: true }, { children: true })
        return // bail BEFORE publishing the world, so no handle outlives this freed world
      }
      builtWorld = world
      worldRef.current = world
      if (exitingRef.current) exitCelebrate(world) // already asked to exit before the world finished building
      if (import.meta.env?.DEV) (window as unknown as { __cb?: unknown }).__cb = { world, specs, app } // dev-only debug handle

      // Reduced motion: no rain. Snap every letter onto its slot, upright and still, and put the
      // cage up immediately — there is nothing flying in for it to contain.
      const reduced =
        reducedMotion ?? (typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)').matches : false)
      if (reduced) {
        for (const L of world.letters) {
          if (L.discarded) continue
          L.body.setTranslation({ x: L.tx, y: L.ty }, true)
          L.body.setRotation(0, true)
          L.body.setLinvel({ x: 0, y: 0 }, true)
          L.body.setAngvel(0, true)
        }
        armEnclosureNow(world)
      }

      // --- pointer ---
      const toWorld = (e: PointerEvent): { x: number; y: number } => {
        const r = el.getBoundingClientRect()
        return { x: e.clientX - r.left, y: e.clientY - r.top }
      }

      // Pick the letter under the cursor: transform the point into each glyph's
      // local (rotated) frame and test its padded box; prefer the closest hit.
      const pickLetter = (px: number, py: number): number => {
        let best = -1
        let bestD = Infinity
        for (let i = 0; i < world.letters.length; i++) {
          if (world.letters[i].discarded) continue // flung and mid-cull — not grabbable
          const p = world.letters[i].body.translation()
          const rot = world.letters[i].body.rotation()
          const c = Math.cos(rot)
          const s = Math.sin(rot)
          const dx = px - p.x
          const dy = py - p.y
          const lx = c * dx + s * dy
          const ly = -s * dx + c * dy
          const { hw, hh } = renderLetters[i]
          if (Math.abs(lx) <= hw * GRAB_PAD && Math.abs(ly) <= hh * GRAB_PAD) {
            const d = (lx / hw) ** 2 + (ly / hh) ** 2
            if (d < bestD) {
              bestD = d
              best = i
            }
          }
        }
        return best
      }

      const onPointerDown = (e: PointerEvent) => {
        wake() // a paused ticker must resume before anything can be dragged
        const { x, y } = toWorld(e)
        const i = pickLetter(x, y)
        if (i < 0) return // missed all letters — do nothing (background click used to re-scatter, but users tap here to grab a letter)
        solidifyLetter(world, i) // grabbing a ghosting letter makes it solid again
        // The grabbed point in the letter's LOCAL frame becomes the hinge the joint pins to the cursor.
        const p = world.letters[i].body.translation()
        const rot = world.letters[i].body.rotation()
        const c = Math.cos(rot)
        const s = Math.sin(rot)
        const dx = x - p.x
        const dy = y - p.y
        startLetterDrag(world, i, c * dx + s * dy, -s * dx + c * dy, x, y)
        try {
          el.setPointerCapture(e.pointerId)
        } catch {
          /* capture is best-effort; drag still tracks via the move/up listeners */
        }
      }

      const onPointerMove = (e: PointerEvent) => {
        if (!world.drag) return
        const { x, y } = toWorld(e)
        moveDrag(world, x, y)
      }

      const endDrag = (e: PointerEvent) => {
        releaseDrag(world) // detach the joint + cursor anchor; the letter keeps its fling, then springs home
        try {
          el.releasePointerCapture(e.pointerId)
        } catch {
          /* pointer already released */
        }
      }

      el.addEventListener('pointerdown', onPointerDown)
      el.addEventListener('pointermove', onPointerMove)
      el.addEventListener('pointerup', endDrag)
      el.addEventListener('pointercancel', endDrag)

      // Press `d` to toggle dev outlines of the rigid bodies (one persistent Graphics,
      // redrawn only while on — no per-frame work when off).
      const debugGfx = new PIXI.Graphics()
      app.stage.addChild(debugGfx)
      let debug = false
      let debugDrawn = false
      const onKey = (e: KeyboardEvent) => {
        if (e.key !== 'd' && e.key !== 'D') return
        const tgt = e.target as HTMLElement | null
        if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable)) return
        debug = !debug
        wake() // the overlay is drawn in the ticker — toggling it while idle must repaint
        if (import.meta.env?.DEV) (window as unknown as { __debug?: boolean }).__debug = debug
      }
      window.addEventListener('keydown', onKey)

      let acc = 0
      // `started` LATCHES: once the host lets the rain go, a later play=false must not re-freeze the
      // letters mid-fall. Reduced motion has nothing to wait for, so it starts immediately.
      let started = reduced
      let announcedReady = false
      // Host obstacle mirrors, reconciled against getObstacles() by id each frame. Lives in this
      // closure so it dies with the world.
      const obstacles = new Map<string, { o: Obstacle; lastX: number; lastY: number; lastR: number }>()
      const obstacleIds = new Set<string>()
      // Pull the host's foreign-body poses and re-state them as kinematic mirrors. Returns whether
      // any mirror MOVED (per OBSTACLE_WAKE_PX hysteresis) — that is this frame's `busy`.
      const syncObstacles = (): boolean => {
        const poses = getObstaclesRef.current?.()
        if (!poses) return false
        let moved = false
        obstacleIds.clear()
        for (const p of poses) {
          obstacleIds.add(p.id)
          const e = obstacles.get(p.id)
          if (!e) {
            // Born at its first known pose — never parked at (0,0) waiting for data.
            obstacles.set(p.id, { o: addObstacle(world, p.x, p.y, p.r), lastX: p.x, lastY: p.y, lastR: p.r })
            continue
          }
          moveObstacle(e.o, p.x, p.y, p.r)
          if (
            Math.abs(p.x - e.lastX) > OBSTACLE_WAKE_PX ||
            Math.abs(p.y - e.lastY) > OBSTACLE_WAKE_PX ||
            Math.abs(p.r - e.lastR) > OBSTACLE_WAKE_PX
          ) {
            e.lastX = p.x
            e.lastY = p.y
            e.lastR = p.r
            moved = true
          }
        }
        if (obstacles.size > obstacleIds.size) {
          for (const [id, e] of obstacles) {
            if (!obstacleIds.has(id)) {
              removeObstacle(world, e.o)
              obstacles.delete(id)
            }
          }
        }
        // A mirror RESTING on a letter's SLOT also counts as busy. With the
        // untangle armed, a letter whose home is occupied is read as wedged,
        // ghost-driven THROUGH the mirror, re-solidified inside it, and ejected
        // — a ~0.7s oscillation loop. Busy stands the untangle down, so the
        // letter simply leans on the mirror until it drifts off the slot. The
        // check is against tx/ty (the slot), not the letter's pose: it is the
        // occupied HOME that starves the return, wherever the letter now sits.
        if (!moved) {
          moved = poses.some((p) =>
            world.letters.some((L, i) => {
              if (L.discarded) return false
              const rl = renderLetters[i]
              const reach = p.r + Math.max(rl?.hw ?? 0, rl?.hh ?? 0)
              const dx = p.x - L.tx
              const dy = p.y - L.ty
              return dx * dx + dy * dy < reach * reach
            }),
          )
        }
        return moved
      }
      const ticker = (t: PIXI.Ticker) => {
        // Gate only the SIMULATION on `play`, never the position sync below. The sync is the only
        // writer of text.position, so returning early here left every glyph at its default (0,0) —
        // a pile in the top-left corner, painted at exactly the moment onReady tells the host to
        // drop its boot screen. The letters must sit at their spawn edges (off-screen) instead.
        const simulate = started || playRef.current
        if (simulate && !started) started = true
        if (simulate) {
          // Once per FRAME, not per substep: the host's poses can't change mid-frame, and
          // setNextKinematicTranslation spreads one pose delta across however many steps run.
          const busy = syncObstacles()
          acc += Math.min(SPIRAL_CLAMP, t.deltaMS / 1000)
          let steps = 0
          while (acc >= FIXED_DT && steps < MAX_SUBSTEPS) {
            stepCelebrate(world, FIXED_DT, busy)
            acc -= FIXED_DT
            steps += 1
          }
          if (steps === MAX_SUBSTEPS && acc > FIXED_DT) acc = 0 // drop backlog
        }
        for (let i = 0; i < renderLetters.length; i++) {
          const p = world.letters[i].body.translation()
          renderLetters[i].text.position.set(p.x, p.y)
          renderLetters[i].text.rotation = world.letters[i].body.rotation()
        }
        if (debug) {
          debugGfx.clear()
          for (let i = 0; i < renderLetters.length; i++) {
            const b = world.letters[i].body
            const p = b.translation()
            strokeHullPx(debugGfx, renderLetters[i].colliders, p.x, p.y, b.rotation())
          }
          debugGfx.stroke({ width: 2, color: 0x00e5ff, alpha: 0.9 })
          debugDrawn = true
        } else if (debugDrawn) {
          debugGfx.clear() // toggled off — clear once, then idle
          debugDrawn = false
        }
        // Collect flung letters that are done. Returns DESCENDING indices, so splicing the
        // parallel render array here can't shift an index out from under the loop.
        const culled = cullDiscarded(world)
        for (const i of culled) {
          renderLetters[i].text.destroy()
          renderLetters.splice(i, 1)
        }

        if (!announcedReady) {
          announcedReady = true
          onReadyRef.current?.() // first painted frame — safe to drop a boot screen now
        }

        // Idle gate: once nothing has moved for a while, STOP the ticker. On a phone this is the
        // difference between a canvas that animates forever and one that goes quiet.
        //
        // `started` is part of the condition on purpose: while the host withholds `play` we never
        // call stepCelebrate, so settledFrames stays frozen at 0 and could never reach the
        // threshold — the ticker would spin at 60fps doing nothing for as long as the host waits.
        //
        // An obstacle source disables the gate outright: mirrors are POLLED, so a stopped ticker
        // would never see a foreign body coming and letters would sleep through the hit. The host
        // that wires obstacles is animating that other sim anyway — its screen is not idle.
        if (idleFrames !== false && started && !world.drag && !getObstaclesRef.current && world.settledFrames > idleFrames) {
          app.ticker.stop()
        }
      }

      // Restart the ticker on anything that could change the scene. ONE definition, shared by the
      // pointer handler, the resize observer, and the exiting effect — a second copy is how one of
      // them ends up not resetting settledFrames and the gate re-fires immediately.
      const wake = () => {
        world.settledFrames = 0
        if (!app.ticker.started) app.ticker.start()
      }
      wakeRef.current = wake

      // ── Word-to-word transition (the live `phrase` / `layout` hand-off) ──────────────────────
      // Reuses matching glyphs, flings the rest off, flies missing ones in — the animated morph
      // that turns one word into another rather than cutting to it. planClaims (pure) decides which
      // live letter claims which new slot; this coordinates that decision across physics + render.
      const transitionTo = (nextLayout: LayoutStrategy, nextSig: string): void => {
        const next = nextLayout(world.w, world.h)
        wake() // the glide/scatter/fly-in all need the loop running
        releaseDrag(world) // a held letter must not be scattered while still joint-pinned to the cursor
        removeWalls(world) // open every edge so flung letters exit and spawned letters fly in freely
        // Rescale the untangle thresholds to the new fit — a longer phrase fits smaller, and a
        // fixed 48px "wedged" threshold would never trip at a quarter of the size.
        world.stuckDist = STUCK_DIST * next.fit
        world.unghostDist = UNGHOST_DIST * next.fit

        const view: LetterView[] = world.letters.map((L, i) => {
          const p = L.body.translation()
          return { ch: renderLetters[i].ch, x: p.x, y: p.y, discarded: L.discarded }
        })
        const { claimed, plan } = planClaims(view, next.slots)

        // Survivors: reuse the matching glyph — re-fit to the new size, glide to the new slot, keep
        // it in front. (Indices below refer to the pre-spawn arrays; the spawn loop only appends.)
        for (const { slot, survivor } of plan) {
          if (survivor < 0) continue
          refitLetter(renderLetters[survivor], slot)
          retargetLetter(world, survivor, slot.x, slot.y)
          renderLetters[survivor].text.zIndex = 1
        }
        // Unclaimed: fling off-screen, dropped BEHIND the forming word so debris never paints over it.
        for (let i = 0; i < world.letters.length; i++) {
          if (claimed.has(i)) continue
          scatterLetter(world, i, { solid: scatterStyle === 'bonk' })
          renderLetters[i].text.zIndex = 0
        }
        // Missing: a fresh letter flies in from an edge (specFor + addLetter keep both arrays aligned).
        for (const { slot, survivor } of plan) {
          if (survivor >= 0) continue
          const { spec, render } = specFor(slot)
          addLetter(world, spec)
          renderLetters.push(render)
        }

        layout = nextLayout
        slots = next.slots
        fit = next.fit
        sizes = next.sizes
        lastSig = nextSig
      }

      // Rebuild the layout from the current props and morph to it — UNLESS the words are unchanged
      // (a consumer re-passing an equal phrase as a fresh array each render must not churn). Guarding
      // on the signature, not identity, is what makes a live `phrase` prop safe.
      const syncLayout = (): void => {
        const nextLayout = buildLayout()
        const nextSig = nextLayout.signature(world.w)
        if (nextSig === lastSig) {
          layout = nextLayout // adopt the new fn (its measure closure is current) without morphing
          return
        }
        transitionTo(nextLayout, nextSig)
      }
      transitionRef.current = syncLayout
      // Reconcile a phrase/layout change that landed DURING the async build (no-op if unchanged).
      syncLayout()

      app.ticker.add(ticker)

      // ── Resize / rotation ────────────────────────────────────────────────────────────────
      // The world used to be frozen at its mount size: a rotation left the letters jammed against
      // stale wall colliders, and the canvas was CSS-stretched rather than re-rendered.
      let raf = 0
      const relayout = () => {
        raf = 0
        if (cancelled || !containerRef.current) return
        const nw = Math.max(1, el.clientWidth)
        const nh = Math.max(1, el.clientHeight)
        if (nw === world.w && nh === world.h) return // observer fires on no-op changes too
        wake()
        app.renderer.resize(nw, nh)
        if (world.exiting) {
          // Mid-exit the letters are falling off-screen and must keep falling. Re-homing would
          // re-damp them (retargetLetter restores the damping exitCelebrate zeroed) and a
          // structural rebuild would SNAP the wordmark back together on its way out. Keep the
          // renderer sized to the container and leave the world alone.
          world.w = nw
          world.h = nh
          return
        }

        const next = layout(nw, nh)
        const sig = layout.signature(nw)
        // Rescaling the untangle thresholds with the text is what keeps the self-freeing untangle
        // working at the new size — at a phone's scale, a letter wedged by 48px is off by half a
        // word, and the fixed threshold would never trip.
        resizeWorld(world, nw, nh, STUCK_DIST * next.fit, UNGHOST_DIST * next.fit)

        // Re-home is only SAFE when the letters stay inside the new bounds. A width change moves
        // every slot AND shrinks the wall cage, which resizeWorld has just rebuilt around wherever
        // the letters currently are — any letter left outside is now trapped behind a wall it
        // cannot cross, pressing against it forever. So a change in the fitted SIZE (or the line
        // set) rebuilds and snaps; only a height-only change, which leaves x untouched, re-homes.
        const sizeChanged = Math.abs((next.sizes[0] ?? 0) - (sizes[0] ?? 0)) > 0.5
        const structural = sig !== lastSig || next.slots.length !== renderLetters.length || sizeChanged
        if (structural) {
          releaseDrag(world) // detach the joint BEFORE freeing the bodies it pins
          for (let i = renderLetters.length - 1; i >= 0; i--) {
            renderLetters[i].text.destroy()
            removeLetter(world, i)
          }
          renderLetters.length = 0
          for (const slot of next.slots) {
            const { spec, render } = specFor(slot)
            const i = addLetter(world, spec)
            renderLetters.push(render)
            // SNAP home rather than re-raining the phrase on every resize — but only once the
            // entrance has been released. Before that the letters are deliberately held off-screen
            // for the rain, and a reflow during a slow load must not assemble them early.
            if (started) {
              const b = world.letters[i].body
              b.setTranslation({ x: slot.x, y: slot.y }, true)
              b.setRotation(0, true)
              b.setLinvel({ x: 0, y: 0 }, true)
              b.setAngvel(0, true)
            }
          }
        } else {
          // Same structure at a new size: re-home in place. Cheap, and no letter blinks out.
          next.slots.forEach((slot, i) => {
            const r = renderLetters[i]
            if (!r) return
            refitLetter(r, slot)
            retargetLetter(world, i, slot.x, slot.y)
          })
        }
        slots = next.slots
        fit = next.fit
        sizes = next.sizes
        lastSig = sig
      }
      const ro = new ResizeObserver(() => {
        // Coalesce a burst of observer callbacks (a drag-resize fires many) into one rAF.
        if (!raf) raf = requestAnimationFrame(relayout)
      })
      ro.observe(el)

      cleanup = () => {
        ro.disconnect()
        if (raf) cancelAnimationFrame(raf)
        el.removeEventListener('pointerdown', onPointerDown)
        el.removeEventListener('pointermove', onPointerMove)
        el.removeEventListener('pointerup', endDrag)
        el.removeEventListener('pointercancel', endDrag)
        window.removeEventListener('keydown', onKey)
        app.ticker.remove(ticker)
        app.destroy({ removeView: true }, { children: true })
        world.world.free()
        worldRef.current = null
        if (import.meta.env?.DEV) {
          delete (window as unknown as { __cb?: unknown }).__cb // don't pin the freed world
          delete (window as unknown as { __debug?: boolean }).__debug
        }
      }
    }

    run().catch((err) => {
      console.error('CelebrateBubbles init failed:', err)
      // Free whatever got built before the throw (see builtApp/builtWorld). Guarded on `cleanup`
      // so we never double-free what the normal teardown path already owns.
      if (!cleanup) {
        try {
          builtWorld?.world.free()
        } catch {
          /* already freed */
        }
        try {
          builtApp?.destroy({ removeView: true }, { children: true })
        } catch {
          /* already destroyed */
        }
        builtWorld = null
        builtApp = null
        worldRef.current = null
      }
      onErrorRef.current?.(err)
    })

    return () => {
      cancelled = true
      cleanup?.()
    }
    // Build the world ONCE on mount; position/frame/transparent are read from the initial
    // closure and are passed as static literals by both call sites, so they're intentionally
    // not deps. `exiting` is handled by its own effect above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div
      ref={containerRef}
      title={title}
      style={{
        position, // 'fixed' = whole viewport; 'absolute' = fill a positioned parent (overlay)
        inset: 0,
        overflow: 'hidden',
        cursor: 'grab',
        touchAction: 'none',
        background: transparent ? 'transparent' : (background ?? 'radial-gradient(circle at 50% 38%, #ffffff, #eef4ff 58%, #e3ecfa)'),
      }}
    />
  )
}

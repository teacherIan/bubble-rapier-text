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
  type LetterSpec,
  type CelebrateWorld,
} from './celebratePhysics'
import { hullForGlyph, scaleHull, strokeHullPx, type PxShape } from './glyphHulls'
import { letterStyle, metricStyle, SPACE_FRAC } from './letterStyle'

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

const LINE1 = { text: 'CELEBRATE', size: 120 }
const LINE2 = { text: 'your hard work', size: 60 }

// One festive color per letter (cycled).
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

interface RenderLetter {
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
  play = true,
  reducedMotion,
  maxResolution = (w) => (w <= 640 ? 2 : 2.5),
  onReady,
  onError,
}: {
  position?: 'fixed' | 'absolute'
  exiting?: boolean
  transparent?: boolean
  frame?: boolean
  /** Hold the letters at their spawn edges until true — lets a host finish its own intro first. */
  play?: boolean
  /** Override the prefers-reduced-motion media query (letters start home, no rain). */
  reducedMotion?: boolean
  /** Cap on devicePixelRatio. A number, or a function of the viewport width. */
  maxResolution?: number | ((width: number) => number)
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

  // When asked to exit, fling the letters off-screen. (If the world is still being built,
  // the build path checks exitingRef and exits as soon as it's ready.)
  useEffect(() => {
    if (exiting && worldRef.current && !worldRef.current.exiting) exitCelebrate(worldRef.current)
  }, [exiting])

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
          Promise.all([
            document.fonts.load(`400 ${LINE1.size}px "Cherry Bomb One"`),
            document.fonts.load(`400 ${LINE2.size}px "Cherry Bomb One"`),
          ]),
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

      // Fit the phrase to the viewport: the fixed display sizes overflow narrow phone
      // screens (letters jam against the walls), so scale both lines down until the
      // widest fits the width with margin (0.8 leaves room so end letters aren't pinned).
      // Measure through PIXI's own CanvasTextMetrics, not a raw 2D context. The raw context does
      // not reliably resolve the loaded web face (it silently falls back to the system stack), so it
      // UNDER-measures the phrase — the fit scale then comes out too large and the end letters spawn
      // pinned against the walls. One reused style object per size; spaces are priced with the same
      // SPACE_FRAC that buildLine advances by, so measurement and layout can't disagree.
      const measure = (text: string, size: number) => {
        const style = metricStyle(size)
        let total = 0
        for (const ch of text) {
          total += ch === ' ' ? size * SPACE_FRAC : PIXI.CanvasTextMetrics.measureText(ch, style).width
        }
        return total
      }
      const fit = Math.min(1, (w * 0.8) / Math.max(measure(LINE1.text, LINE1.size), measure(LINE2.text, LINE2.size)))
      const line1 = { text: LINE1.text, size: LINE1.size * fit }
      const line2 = { text: LINE2.text, size: LINE2.size * fit }

      // Build the Pixi texts (rendered here) + the physics specs (for the sim world).
      const renderLetters: RenderLetter[] = []
      const specs: LetterSpec[] = []
      const buildLine = (line: { text: string; size: number }, lineY: number) => {
        const items = [...line.text].map((ch) => {
          if (ch === ' ') return { ch, t: null as PIXI.Text | null, width: line.size * SPACE_FRAC }
          const t = new PIXI.Text({ text: ch, style: letterStyle(PALETTE[renderLetters.length % PALETTE.length], line.size) })
          t.anchor.set(0.5)
          t.resolution = 2
          return { ch, t, width: t.width }
        })
        const total = items.reduce((s, it) => s + it.width, 0)
        let cursor = w / 2 - total / 2
        for (const it of items) {
          const slotX = cursor + it.width / 2
          cursor += it.width
          if (!it.t) continue
          it.t.style.fill = PALETTE[renderLetters.length % PALETTE.length] // per-letter color (length is final at push time)
          app.stage.addChild(it.t)
          const hw = Math.max(8, it.t.width * 0.42)
          const hh = Math.max(8, it.t.height * 0.4)
          // Hand-authored hull (font-size units, origin = glyph centre) scaled to px.
          const colliders = scaleHull(hullForGlyph(it.ch, hw / line.size, hh / line.size), line.size)
          specs.push({ colliders, hw, hh, slotX, slotY: lineY })
          renderLetters.push({ text: it.t, hw, hh, colliders })
        }
      }

      // Keep the two lines well clear of each other: line 1 is tall, so a tight gap
      // lets the bouncy settle overlap the lines and tangle letters across them.
      // Center layout: the two lines sit just above/below the middle. Frame layout: push
      // them near the top + bottom edges so they wrap AROUND a central element (the blob ring).
      const gap = line1.size * 0.86
      const topY = frame ? h * 0.13 : h / 2 - gap
      const botY = frame ? h * 0.87 : h / 2 + gap
      buildLine(line1, topY)
      buildLine(line2, botY)

      const world: CelebrateWorld = await createCelebrateWorld(specs, w, h, STUCK_DIST * fit, UNGHOST_DIST * fit)
      if (cancelled || !containerRef.current) {
        world.world.free()
        app.destroy({ removeView: true }, { children: true })
        return // bail BEFORE publishing the world, so no handle outlives this freed world
      }
      builtWorld = world
      worldRef.current = world
      if (exitingRef.current) exitCelebrate(world) // already asked to exit before the world finished building
      if (import.meta.env.DEV) (window as unknown as { __cb?: unknown }).__cb = { world, specs } // dev-only debug handle

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
        if (import.meta.env.DEV) (window as unknown as { __debug?: boolean }).__debug = debug
      }
      window.addEventListener('keydown', onKey)

      let acc = 0
      // `started` LATCHES: once the host lets the rain go, a later play=false must not re-freeze the
      // letters mid-fall. Reduced motion has nothing to wait for, so it starts immediately.
      let started = reduced
      let announcedReady = false
      const ticker = (t: PIXI.Ticker) => {
        if (!started) {
          if (!playRef.current) {
            // Held: letters sit at their spawn edges. Still paint one frame so the host can hide
            // its boot screen against a real canvas rather than a blank one.
            if (!announcedReady) {
              announcedReady = true
              onReadyRef.current?.()
            }
            return
          }
          started = true
        }
        acc += Math.min(SPIRAL_CLAMP, t.deltaMS / 1000)
        let steps = 0
        while (acc >= FIXED_DT && steps < MAX_SUBSTEPS) {
          stepCelebrate(world, FIXED_DT)
          acc -= FIXED_DT
          steps += 1
        }
        if (steps === MAX_SUBSTEPS && acc > FIXED_DT) acc = 0 // drop backlog
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
        if (!announcedReady) {
          announcedReady = true
          onReadyRef.current?.() // first painted frame — safe to drop a boot screen now
        }
      }
      app.ticker.add(ticker)

      cleanup = () => {
        el.removeEventListener('pointerdown', onPointerDown)
        el.removeEventListener('pointermove', onPointerMove)
        el.removeEventListener('pointerup', endDrag)
        el.removeEventListener('pointercancel', endDrag)
        window.removeEventListener('keydown', onKey)
        app.ticker.remove(ticker)
        app.destroy({ removeView: true }, { children: true })
        world.world.free()
        worldRef.current = null
        if (import.meta.env.DEV) {
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
      title="Drag a letter"
      style={{
        position, // 'fixed' = whole viewport; 'absolute' = fill a positioned parent (overlay)
        inset: 0,
        overflow: 'hidden',
        cursor: 'grab',
        touchAction: 'none',
        background: transparent ? 'transparent' : 'radial-gradient(circle at 50% 38%, #ffffff, #eef4ff 58%, #e3ecfa)',
      }}
    />
  )
}

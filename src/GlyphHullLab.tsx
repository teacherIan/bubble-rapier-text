import { useEffect, useRef } from 'react'
import * as PIXI from 'pixi.js'
import 'pixi.js/unsafe-eval'
import { GLYPH_LIST, GLYPH_HULLS, scaleHull, strokeHullPx, hullForGlyph } from './glyphHulls'

// Calibration harness for hand-authoring the letter collision hulls. Renders glyphs in
// the REAL Cherry Bomb One face with a normalized grid centred on the exact body origin
// the live component uses (PIXI text anchor 0.5), so coordinates read off the grid map
// 1:1 into glyphHulls.ts. URL params:
//   ?i=<n>      render only GLYPH_LIST[n], large, for precise reading / screenshots
//   ?g=<char>   render a specific character instead of an index
//   ?hull=1     overlay the authored hull (scaleHull + strokeHullPx — same path as live)
//   ?all=1      4×N contact sheet of every glyph (overview)
// Not linked anywhere; dev-only sandbox sibling of /celebrate-text.

const FONT_STACK = '"Cherry Bomb One", system-ui, sans-serif'

function params() {
  const p = new URLSearchParams(window.location.search)
  return {
    i: p.has('i') ? Number(p.get('i')) : null,
    g: p.get('g'),
    hull: p.get('hull') === '1',
    all: p.get('all') === '1',
  }
}

function letterStyle(size: number): PIXI.TextStyle {
  // BYTE-IDENTICAL to CelebrateBubbles.letterStyle (incl. dropShadow), so the PIXI text
  // bounding box — hence the anchor-0.5 body origin colliders hang off — matches the live
  // view exactly. Without the shadow the bbox (and origin) would shift a few px.
  return new PIXI.TextStyle({
    fontFamily: FONT_STACK,
    fontSize: size,
    fill: 0x4d9de0,
    stroke: { color: 0xffffff, width: Math.max(2, size * 0.045) },
    dropShadow: { color: 0x232347, alpha: 0.34, blur: 3, distance: size * 0.085, angle: Math.PI / 2 },
  })
}

// Draw the normalized grid: ticks every 0.1u, bold axes, half-unit labels. `size` px = 1u.
function drawGrid(stage: PIXI.Container, ox: number, oy: number, size: number, extent = 0.75) {
  const g = new PIXI.Graphics()
  const step = 0.1
  for (let v = -extent; v <= extent + 1e-6; v += step) {
    const major = Math.abs(v % 0.5) < 1e-6
    const x = ox + v * size
    const y = oy + v * size
    g.moveTo(x, oy - extent * size).lineTo(x, oy + extent * size)
    g.moveTo(ox - extent * size, y).lineTo(ox + extent * size, y)
    g.stroke({ width: major ? 1.4 : 0.6, color: major ? 0xb9c2d6 : 0xe2e7f0, alpha: major ? 0.9 : 0.7 })
  }
  // Bold axes through the origin.
  g.moveTo(ox, oy - extent * size).lineTo(ox, oy + extent * size)
  g.moveTo(ox - extent * size, oy).lineTo(ox + extent * size, oy)
  g.stroke({ width: 1.6, color: 0x8893a8, alpha: 0.95 })
  stage.addChild(g)
  // Axis tick labels at every 0.1.
  for (let k = -Math.round(extent / step); k <= Math.round(extent / step); k++) {
    const v = k * step
    if (k === 0) continue
    const lbl = (n: number) => n.toFixed(1)
    const tx = new PIXI.Text({ text: lbl(v), style: { fontFamily: 'monospace', fontSize: Math.max(9, size * 0.045), fill: 0x6b7488 } })
    tx.anchor.set(0.5)
    tx.position.set(ox + v * size, oy + 0.012 * size + (major(v) ? 12 : 9))
    stage.addChild(tx)
    const ty = new PIXI.Text({ text: lbl(v), style: { fontFamily: 'monospace', fontSize: Math.max(9, size * 0.045), fill: 0x6b7488 } })
    ty.anchor.set(0.5)
    ty.position.set(ox - 0.012 * size - 14, oy + v * size)
    stage.addChild(ty)
  }
}
function major(v: number) {
  return Math.abs(v % 0.5) < 1e-6
}

function drawHullOverlay(stage: PIXI.Container, ch: string, ox: number, oy: number, size: number, hwU: number, hhU: number) {
  const shapes = scaleHull(hullForGlyph(ch, hwU, hhU), size)
  const authored = (GLYPH_HULLS[ch]?.length ?? 0) > 0
  const g = new PIXI.Graphics()
  strokeHullPx(g, shapes, ox, oy)
  g.stroke({ width: Math.max(2, size * 0.012), color: authored ? 0xff3b6b : 0xffa600, alpha: 0.95 })
  stage.addChild(g)
  // Mark each primitive centre so offsets are easy to judge.
  const dots = new PIXI.Graphics()
  for (const s of shapes) dots.circle(ox + s.x, oy + s.y, Math.max(1.5, size * 0.006))
  dots.fill({ color: authored ? 0xff3b6b : 0xffa600, alpha: 0.9 })
  stage.addChild(dots)
}

export function GlyphHullLab() {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    let cancelled = false
    let app: PIXI.Application | null = null

    const run = async () => {
      try {
        await Promise.race([
          document.fonts.load(`400 120px "Cherry Bomb One"`),
          new Promise((r) => setTimeout(r, 2000)),
        ])
      } catch {
        /* fall back to stack */
      }
      await document.fonts.ready.catch(() => {})
      if (cancelled || !ref.current) return

      const w = Math.max(1, el.clientWidth)
      const h = Math.max(1, el.clientHeight)
      app = new PIXI.Application()
      await app.init({ width: w, height: h, background: 0xffffff, antialias: true, autoDensity: true, resolution: window.devicePixelRatio || 1 })
      if (cancelled) {
        app.destroy({ removeView: true }, { children: true })
        return
      }
      app.canvas.style.cssText = 'display:block;width:100%;height:100%'
      el.appendChild(app.canvas)

      const { i, g, hull, all } = params()

      const addGlyph = (ch: string, cx: number, cy: number, size: number) => {
        drawGrid(app!.stage, cx, cy, size)
        const t = new PIXI.Text({ text: ch, style: letterStyle(size) })
        t.anchor.set(0.5)
        t.resolution = 2 // match the live component
        t.alpha = 0.62 // see the grid + hull through the fill
        t.position.set(cx, cy)
        app!.stage.addChild(t)
        const hwU = Math.max(0.06, (t.width * 0.42) / size)
        const hhU = Math.max(0.06, (t.height * 0.4) / size)
        if (hull) drawHullOverlay(app!.stage, ch, cx, cy, size, hwU, hhU)
        // Label
        const lab = new PIXI.Text({ text: `'${ch}'`, style: { fontFamily: 'monospace', fontSize: 16, fill: 0x222222 } })
        lab.position.set(cx - size * 0.78, cy - size * 0.85)
        app!.stage.addChild(lab)
      }

      if (all) {
        const cols = 4
        const rows = Math.ceil(GLYPH_LIST.length / cols)
        const cellW = w / cols
        const cellH = h / rows
        const size = Math.min(cellW, cellH) * 0.5
        GLYPH_LIST.forEach((ch, k) => {
          const cx = (k % cols + 0.5) * cellW
          const cy = (Math.floor(k / cols) + 0.5) * cellH
          addGlyph(ch, cx, cy, size)
        })
      } else {
        const ch = g ?? (i != null ? GLYPH_LIST[i] : 'a')
        const size = Math.min(w, h) * 0.42
        addGlyph(ch, w / 2, h / 2, size)
      }
    }

    run().catch((e) => console.error('GlyphHullLab failed:', e))
    return () => {
      cancelled = true
      app?.destroy({ removeView: true }, { children: true })
    }
  }, [])

  return <div ref={ref} style={{ position: 'fixed', inset: 0, background: '#fff', overflow: 'hidden' }} />
}

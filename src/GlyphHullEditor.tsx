import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import * as PIXI from 'pixi.js'
import 'pixi.js/unsafe-eval'
import { GLYPH_LIST, GLYPH_HULLS, EDITABLE_GLYPHS, type HullShape } from './glyphHulls'

// Interactive editor for the letter collision hulls. The glyph is rendered in the REAL
// Cherry Bomb One face (PIXI, anchor 0.5 — identical origin to the live component), and you
// drag/resize/rotate balls + capsules right on top of it. Coordinates are font-size units
// (origin = glyph centre, +y down), so what you place here drops straight into glyphHulls.ts.
// Everything is mirrored to localStorage + a live code box; not linked anywhere (dev route).

const FONT_STACK = '"Cherry Bomb One", system-ui, sans-serif'
const BOX = 720 // editor canvas is a fixed square (deterministic — no viewport races)
const CX = BOX / 2
const CY = BOX / 2
const UNIT = 300 // px per font-size unit
const EXTENT = 1.05 // grid half-extent in units
const LS_KEY = 'celebrateGlyphHulls.v1'

type Hulls = Record<string, HullShape[]>

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v))

function loadHulls(): Hulls {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Hulls
      // ensure every glyph has an entry (fall back to defaults)
      const base = clone(GLYPH_HULLS) as Hulls
      return { ...base, ...parsed }
    }
  } catch {
    /* ignore */
  }
  return clone(GLYPH_HULLS) as Hulls
}

// unit ↔ screen
const sx = (ux: number) => CX + ux * UNIT
const sy = (uy: number) => CY + uy * UNIT
const ux = (px: number) => (px - CX) / UNIT
const uy = (py: number) => (py - CY) / UNIT

// capsule axis (Rapier builds along local +y, rotated by a) and its two cap centres (unit)
function capAxis(a: number) {
  return { x: -Math.sin(a), y: Math.cos(a) }
}
function capEnds(s: Extract<HullShape, { t: 'cap' }>) {
  const u = capAxis(s.a)
  return { ax: s.x - u.x * s.h, ay: s.y - u.y * s.h, bx: s.x + u.x * s.h, by: s.y + u.y * s.h }
}
// stadium outline as an SVG path (screen coords), sampled like the live debug overlay
function capsulePath(s: Extract<HullShape, { t: 'cap' }>): string {
  const e = capEnds(s)
  const ax = sx(e.ax)
  const ay = sy(e.ay)
  const bx = sx(e.bx)
  const by = sy(e.by)
  const r = s.r * UNIT
  const phi = Math.atan2(by - ay, bx - ax)
  const pts: string[] = []
  const N = 18
  for (let k = 0; k <= N; k++) {
    const t = phi + Math.PI / 2 + Math.PI * (k / N)
    pts.push(`${(ax + r * Math.cos(t)).toFixed(1)},${(ay + r * Math.sin(t)).toFixed(1)}`)
  }
  for (let k = 0; k <= N; k++) {
    const t = phi - Math.PI / 2 + Math.PI * (k / N)
    pts.push(`${(bx + r * Math.cos(t)).toFixed(1)},${(by + r * Math.sin(t)).toFixed(1)}`)
  }
  return `M${pts.join(' L')}Z`
}

const r3 = (n: number) => Math.round(n * 1000) / 1000

function toCode(hulls: Hulls): string {
  const fmt = (s: HullShape) => {
    switch (s.t) {
      case 'ball':
        return `{ t: 'ball', x: ${r3(s.x)}, y: ${r3(s.y)}, r: ${r3(s.r)} }`
      case 'cap':
        return `{ t: 'cap', x: ${r3(s.x)}, y: ${r3(s.y)}, r: ${r3(s.r)}, h: ${r3(s.h)}, a: ${r3(s.a)} }`
      case 'rrect':
        return `{ t: 'rrect', x: ${r3(s.x)}, y: ${r3(s.y)}, hx: ${r3(s.hx)}, hy: ${r3(s.hy)}, r: ${r3(s.r)}, a: ${r3(s.a)} }`
      case 'oval':
        return `{ t: 'oval', x: ${r3(s.x)}, y: ${r3(s.y)}, rx: ${r3(s.rx)}, ry: ${r3(s.ry)}, a: ${r3(s.a)} }`
    }
  }
  // Serialise the union of the editor's tab order and EVERY authored glyph — not GLYPH_LIST alone.
  // Keying the export off GLYPH_LIST silently dropped any hull for a glyph outside the demo phrase,
  // so re-baking after tweaking one letter would delete all the others. That is precisely how this
  // library and its first consumer drifted into two different hull sets.
  const keys = [...new Set<string>([...GLYPH_LIST, ...Object.keys(hulls)])]
  const lines = keys.map((g) => {
    const arr = hulls[g] ?? []
    return `  ${/^[A-Za-z]$/.test(g) ? g : `'${g}'`}: [\n${arr.map((s) => `    ${fmt(s)},`).join('\n')}\n  ],`
  })
  return `export const GLYPH_HULLS: Record<string, HullShape[]> = {\n${lines.join('\n')}\n}`
}

type DragMode =
  | { kind: 'move'; offx: number; offy: number; downx: number; downy: number; armed: boolean }
  | { kind: 'ballR' }
  | { kind: 'capA' }
  | { kind: 'capB' }
  | { kind: 'capR' }
  | { kind: 'rectSize' }
  | { kind: 'ovalRx' }
  | { kind: 'ovalRy' }
  | { kind: 'shapeRot' }

// rotate a local vector by a (y-down) and its inverse — for the oriented rect/oval handles
function rotLocal(a: number, lx: number, ly: number) {
  const c = Math.cos(a)
  const s = Math.sin(a)
  return { x: c * lx - s * ly, y: s * lx + c * ly }
}
function invRotLocal(a: number, dx: number, dy: number) {
  const c = Math.cos(-a)
  const s = Math.sin(-a)
  return { x: c * dx - s * dy, y: s * dx + c * dy }
}

const DEAD_ZONE = 0.012 // a click within this (in units) only selects; drag beyond to move

export function GlyphHullEditor({ glyphs = EDITABLE_GLYPHS }: { glyphs?: readonly string[] } = {}) {
  const pixiHostRef = useRef<HTMLDivElement>(null)
  const textRef = useRef<PIXI.Text | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)

  const [gi, setGi] = useState(0)
  const glyph = glyphs[gi]
  const [hulls, setHulls] = useState<Hulls>(() => loadHulls())
  const [sel, setSel] = useState(-1)
  const dragRef = useRef<DragMode | null>(null)
  const [glyphAlpha, setGlyphAlpha] = useState(0.6)

  const shapes = hulls[glyph] ?? []

  // Refs mirror the latest hulls + active index so a pointermove never depends on a React
  // re-render having landed first (a fast drag fires move before setSel/setHulls commit).
  const hullsRef = useRef(hulls)
  hullsRef.current = hulls
  const selRef = useRef(-1)
  const glyphRef = useRef(glyph)
  glyphRef.current = glyph
  const select = (i: number) => {
    selRef.current = i
    setSel(i)
  }

  // persist + recompute code on every change
  const code = useMemo(() => toCode(hulls), [hulls])
  useEffect(() => {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(hulls))
      if (import.meta.env.DEV) (window as unknown as { __glyphHulls?: Hulls }).__glyphHulls = hulls // dev-only read-out (prod uses Copy code)
    } catch {
      /* ignore */
    }
  }, [hulls])

  // ── PIXI: grid + glyph (fixed-size, faithful origin) ───────────────────────────
  useEffect(() => {
    const host = pixiHostRef.current
    if (!host) return
    let app: PIXI.Application | null = null
    let cancelled = false
    ;(async () => {
      try {
        await Promise.race([document.fonts.load(`400 120px "Cherry Bomb One"`), new Promise((r) => setTimeout(r, 1500))])
        await document.fonts.ready.catch(() => {})
      } catch {
        /* fall back */
      }
      if (cancelled) return
      app = new PIXI.Application()
      await app.init({ width: BOX, height: BOX, backgroundAlpha: 0, antialias: true, resolution: 2, autoDensity: true })
      if (cancelled) {
        app.destroy({ removeView: true }, { children: true })
        return
      }
      app.canvas.style.cssText = 'display:block;width:100%;height:100%'
      host.appendChild(app.canvas)

      // grid
      const g = new PIXI.Graphics()
      for (let v = -EXTENT; v <= EXTENT + 1e-6; v += 0.1) {
        const major = Math.abs(v % 0.5) < 1e-6
        g.moveTo(sx(v), sy(-EXTENT)).lineTo(sx(v), sy(EXTENT))
        g.moveTo(sx(-EXTENT), sy(v)).lineTo(sx(EXTENT), sy(v))
        g.stroke({ width: major ? 1.2 : 0.5, color: major ? 0xb9c2d6 : 0xe6eaf2, alpha: major ? 0.9 : 0.8 })
      }
      g.moveTo(CX, sy(-EXTENT)).lineTo(CX, sy(EXTENT))
      g.moveTo(sx(-EXTENT), CY).lineTo(sx(EXTENT), CY)
      g.stroke({ width: 1.5, color: 0x8893a8, alpha: 0.95 })
      app.stage.addChild(g)
      for (let k = -10; k <= 10; k++) {
        if (k === 0) continue
        const v = k * 0.1
        const mk = (text: string, x: number, y: number) => {
          const t = new PIXI.Text({ text, style: { fontFamily: 'monospace', fontSize: 11, fill: 0x9aa4b8 } })
          t.anchor.set(0.5)
          t.position.set(x, y)
          app!.stage.addChild(t)
        }
        mk(v.toFixed(1), sx(v), CY + 11)
        mk(v.toFixed(1), CX - 16, sy(v))
      }

      const t = new PIXI.Text({
        // Read through the ref: this effect builds the PIXI app ONCE, and the [glyph] effect below
        // syncs the text immediately after, so the initial value is cosmetic. Depending on `glyphs`
        // here would tear down and rebuild the whole renderer whenever the glyph set changed.
        text: glyphRef.current,
        style: new PIXI.TextStyle({
          fontFamily: FONT_STACK,
          fontSize: UNIT,
          fill: 0x4d9de0,
          stroke: { color: 0xffffff, width: Math.max(2, UNIT * 0.045) },
          dropShadow: { color: 0x232347, alpha: 0.34, blur: 3, distance: UNIT * 0.085, angle: Math.PI / 2 },
        }),
      })
      t.anchor.set(0.5)
      t.resolution = 2
      t.position.set(CX, CY)
      app.stage.addChild(t)
      textRef.current = t
    })()
    return () => {
      cancelled = true
      textRef.current = null
      app?.destroy({ removeView: true }, { children: true })
    }
  }, [])

  // update glyph + its alpha when selection of glyph / alpha changes
  useEffect(() => {
    if (textRef.current) textRef.current.text = glyph
  }, [glyph])
  useEffect(() => {
    if (textRef.current) textRef.current.alpha = glyphAlpha
  }, [glyphAlpha, glyph])

  // ── editing ───────────────────────────────────────────────────────────────────
  const updateShape = (i: number, patch: Partial<HullShape>) =>
    setHulls((h) => {
      const next = clone(h)
      next[glyph] = next[glyph].map((s, k) => (k === i ? ({ ...s, ...patch } as HullShape) : s))
      return next
    })

  const pointerUnit = (e: ReactPointerEvent | PointerEvent) => {
    const rect = svgRef.current!.getBoundingClientRect()
    const px = ((e.clientX - rect.left) / rect.width) * BOX
    const py = ((e.clientY - rect.top) / rect.height) * BOX
    return { ux: ux(px), uy: uy(py) }
  }

  const startDrag = (mode: DragMode, i: number) => (e: ReactPointerEvent) => {
    e.stopPropagation()
    select(i)
    dragRef.current = mode
    try {
      svgRef.current?.setPointerCapture(e.pointerId)
    } catch {
      /* best effort */
    }
  }

  const onMove = (e: ReactPointerEvent) => {
    const mode = dragRef.current
    const i = selRef.current
    if (mode == null || i < 0) return
    const p = pointerUnit(e)
    const s = (hullsRef.current[glyphRef.current] ?? [])[i]
    if (!s) return
    if (mode.kind === 'move') {
      if (!mode.armed && Math.hypot(p.ux - mode.downx, p.uy - mode.downy) < DEAD_ZONE) return
      mode.armed = true
      updateShape(i, { x: r3(p.ux - mode.offx), y: r3(p.uy - mode.offy) } as Partial<HullShape>)
    } else if (mode.kind === 'ballR') {
      updateShape(i, { r: r3(Math.max(0.02, Math.hypot(p.ux - s.x, p.uy - s.y))) } as Partial<HullShape>)
    } else if (mode.kind === 'capR' && s.t === 'cap') {
      updateShape(i, { r: r3(Math.max(0.02, Math.hypot(p.ux - s.x, p.uy - s.y))) } as Partial<HullShape>)
    } else if ((mode.kind === 'capA' || mode.kind === 'capB') && s.t === 'cap') {
      const e2 = capEnds(s)
      const fixed = mode.kind === 'capA' ? { x: e2.bx, y: e2.by } : { x: e2.ax, y: e2.ay }
      const moved = { x: p.ux, y: p.uy }
      const cx = (fixed.x + moved.x) / 2
      const cy = (fixed.y + moved.y) / 2
      const dx = moved.x - cx
      const dy = moved.y - cy
      const h = Math.max(0.0, Math.hypot(dx, dy))
      // axis always points A→B (so dragging either end keeps the other fixed).
      const vx = mode.kind === 'capB' ? moved.x - fixed.x : fixed.x - moved.x
      const vy = mode.kind === 'capB' ? moved.y - fixed.y : fixed.y - moved.y
      const a = Math.atan2(-vx, vy)
      updateShape(i, { x: r3(cx), y: r3(cy), h: r3(h), a: r3(a) } as Partial<HullShape>)
    } else if (mode.kind === 'rectSize' && s.t === 'rrect') {
      const l = invRotLocal(s.a, p.ux - s.x, p.uy - s.y) // corner pos in the rect's own frame
      const hx = Math.max(0.02, Math.abs(l.x))
      const hy = Math.max(0.02, Math.abs(l.y))
      updateShape(i, { hx: r3(hx), hy: r3(hy), r: r3(Math.min(s.r, hx, hy)) } as Partial<HullShape>)
    } else if (mode.kind === 'ovalRx' && s.t === 'oval') {
      const l = invRotLocal(s.a, p.ux - s.x, p.uy - s.y)
      updateShape(i, { rx: r3(Math.max(0.02, Math.abs(l.x))) } as Partial<HullShape>)
    } else if (mode.kind === 'ovalRy' && s.t === 'oval') {
      const l = invRotLocal(s.a, p.ux - s.x, p.uy - s.y)
      updateShape(i, { ry: r3(Math.max(0.02, Math.abs(l.y))) } as Partial<HullShape>)
    } else if (mode.kind === 'shapeRot' && (s.t === 'rrect' || s.t === 'oval')) {
      // rotate so the handle (local −y) points at the cursor
      updateShape(i, { a: r3(Math.atan2(p.ux - s.x, -(p.uy - s.y))) } as Partial<HullShape>)
    }
  }
  const endDrag = (e: ReactPointerEvent) => {
    dragRef.current = null
    try {
      svgRef.current?.releasePointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
  }

  const addBall = () =>
    setHulls((h) => {
      const next = clone(h)
      next[glyph] = [...(next[glyph] ?? []), { t: 'ball', x: 0, y: 0.1, r: 0.15 }]
      return next
    })
  const addCap = () =>
    setHulls((h) => {
      const next = clone(h)
      next[glyph] = [...(next[glyph] ?? []), { t: 'cap', x: 0, y: 0.1, r: 0.1, h: 0.12, a: 0 }]
      return next
    })
  const addRect = () =>
    setHulls((h) => {
      const next = clone(h)
      next[glyph] = [...(next[glyph] ?? []), { t: 'rrect', x: 0, y: 0.1, hx: 0.18, hy: 0.12, r: 0.06, a: 0 }]
      return next
    })
  const addOval = () =>
    setHulls((h) => {
      const next = clone(h)
      next[glyph] = [...(next[glyph] ?? []), { t: 'oval', x: 0, y: 0.1, rx: 0.18, ry: 0.12, a: 0 }]
      return next
    })
  const delSel = () => {
    if (sel < 0) return
    setHulls((h) => {
      const next = clone(h)
      next[glyph] = next[glyph].filter((_, k) => k !== sel)
      return next
    })
    select(-1)
  }
  const resetGlyph = () =>
    setHulls((h) => {
      const next = clone(h)
      next[glyph] = clone(GLYPH_HULLS[glyph] ?? [])
      return next
    })

  // keyboard: Delete / Backspace removes selected, b/c add
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement | null
      if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA')) return
      if (e.key === 'Delete' || e.key === 'Backspace') delSel()
      else if (e.key === 'b') addBall()
      else if (e.key === 'c') addCap()
      else if (e.key === 'x') addRect()
      else if (e.key === 'v') addOval()
      else if (e.key === 'ArrowRight') setGi((i) => (i + 1) % glyphs.length)
      else if (e.key === 'ArrowLeft') setGi((i) => (i - 1 + glyphs.length) % glyphs.length)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel, glyph])

  const HANDLE = 7
  const selShape = sel >= 0 ? shapes[sel] : null

  return (
    <div style={{ display: 'flex', gap: 16, padding: 16, height: '100%', boxSizing: 'border-box', fontFamily: 'system-ui', background: '#fff', color: '#1f2433' }}>
      {/* canvas + svg editing layer */}
      <div style={{ position: 'relative', width: BOX, height: BOX, flex: '0 0 auto', border: '1px solid #e2e7f0', borderRadius: 8, overflow: 'hidden' }}>
        <div ref={pixiHostRef} style={{ position: 'absolute', inset: 0 }} />
        <svg
          ref={svgRef}
          viewBox={`0 0 ${BOX} ${BOX}`}
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', touchAction: 'none' }}
          onPointerMove={onMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onPointerDown={() => select(-1)}
        >
          {shapes.map((s, i) => {
            const selected = i === sel
            const stroke = selected ? '#ff2d6b' : '#ff7aa6'
            const common = {
              stroke,
              strokeWidth: selected ? 2.5 : 1.8,
              fill: selected ? 'rgba(255,45,107,0.12)' : 'rgba(255,122,166,0.06)',
              style: { cursor: 'move' as const },
            }
            if (s.t === 'ball') {
              return (
                <g key={i}>
                  <circle
                    cx={sx(s.x)}
                    cy={sy(s.y)}
                    r={s.r * UNIT}
                    {...common}
                    onPointerDown={(e) => {
                      const p = pointerUnit(e)
                      startDrag({ kind: 'move', offx: p.ux - s.x, offy: p.uy - s.y, downx: p.ux, downy: p.uy, armed: false }, i)(e)
                    }}
                  />
                  {selected && (
                    <>
                      <circle cx={sx(s.x)} cy={sy(s.y)} r={HANDLE} fill="#ff2d6b" />
                      <circle cx={sx(s.x) + s.r * UNIT} cy={sy(s.y)} r={HANDLE} fill="#fff" stroke="#ff2d6b" strokeWidth={2} style={{ cursor: 'ew-resize' }} onPointerDown={startDrag({ kind: 'ballR' }, i)} />
                    </>
                  )}
                </g>
              )
            }
            // local→screen handle position for the oriented rect/oval
            const hpos = (lx: number, ly: number) => {
              const w = rotLocal(s.a, lx, ly)
              return { x: sx(s.x + w.x), y: sy(s.y + w.y) }
            }
            const bodyDown = (e: ReactPointerEvent) => {
              const p = pointerUnit(e)
              startDrag({ kind: 'move', offx: p.ux - s.x, offy: p.uy - s.y, downx: p.ux, downy: p.uy, armed: false }, i)(e)
            }
            if (s.t === 'rrect') {
              const cxs = sx(s.x)
              const cys = sy(s.y)
              const rr = Math.min(s.r, s.hx, s.hy) * UNIT
              const corner = hpos(s.hx, s.hy)
              const rotH = hpos(0, -(s.hy + 0.08))
              return (
                <g key={i}>
                  <rect
                    x={cxs - s.hx * UNIT}
                    y={cys - s.hy * UNIT}
                    width={s.hx * 2 * UNIT}
                    height={s.hy * 2 * UNIT}
                    rx={rr}
                    ry={rr}
                    transform={`rotate(${((s.a * 180) / Math.PI).toFixed(2)} ${cxs} ${cys})`}
                    {...common}
                    onPointerDown={bodyDown}
                  />
                  {selected && (
                    <>
                      <line x1={cxs} y1={cys} x2={rotH.x} y2={rotH.y} stroke="#ff2d6b" strokeWidth={1} />
                      <circle cx={cxs} cy={cys} r={HANDLE - 1} fill="#ff2d6b" />
                      <circle cx={corner.x} cy={corner.y} r={HANDLE} fill="#ffd23f" stroke="#ff2d6b" strokeWidth={2} style={{ cursor: 'nwse-resize' }} onPointerDown={startDrag({ kind: 'rectSize' }, i)} />
                      <circle cx={rotH.x} cy={rotH.y} r={HANDLE} fill="#7fd4ff" stroke="#ff2d6b" strokeWidth={2} style={{ cursor: 'grab' }} onPointerDown={startDrag({ kind: 'shapeRot' }, i)} />
                    </>
                  )}
                </g>
              )
            }
            if (s.t === 'oval') {
              const cxs = sx(s.x)
              const cys = sy(s.y)
              const rxH = hpos(s.rx, 0)
              const ryH = hpos(0, s.ry)
              const rotH = hpos(0, -(s.ry + 0.08))
              return (
                <g key={i}>
                  <ellipse
                    cx={cxs}
                    cy={cys}
                    rx={s.rx * UNIT}
                    ry={s.ry * UNIT}
                    transform={`rotate(${((s.a * 180) / Math.PI).toFixed(2)} ${cxs} ${cys})`}
                    {...common}
                    onPointerDown={bodyDown}
                  />
                  {selected && (
                    <>
                      <line x1={cxs} y1={cys} x2={rotH.x} y2={rotH.y} stroke="#ff2d6b" strokeWidth={1} />
                      <circle cx={cxs} cy={cys} r={HANDLE - 1} fill="#ff2d6b" />
                      <circle cx={rxH.x} cy={rxH.y} r={HANDLE} fill="#ffd23f" stroke="#ff2d6b" strokeWidth={2} style={{ cursor: 'ew-resize' }} onPointerDown={startDrag({ kind: 'ovalRx' }, i)} />
                      <circle cx={ryH.x} cy={ryH.y} r={HANDLE} fill="#ffd23f" stroke="#ff2d6b" strokeWidth={2} style={{ cursor: 'ns-resize' }} onPointerDown={startDrag({ kind: 'ovalRy' }, i)} />
                      <circle cx={rotH.x} cy={rotH.y} r={HANDLE} fill="#7fd4ff" stroke="#ff2d6b" strokeWidth={2} style={{ cursor: 'grab' }} onPointerDown={startDrag({ kind: 'shapeRot' }, i)} />
                    </>
                  )}
                </g>
              )
            }
            const e2 = capEnds(s)
            const perp = { x: Math.cos(s.a), y: Math.sin(s.a) }
            return (
              <g key={i}>
                <path
                  d={capsulePath(s)}
                  {...common}
                  onPointerDown={(e) => {
                    const p = pointerUnit(e)
                    startDrag({ kind: 'move', offx: p.ux - s.x, offy: p.uy - s.y, downx: p.ux, downy: p.uy, armed: false }, i)(e)
                  }}
                />
                {selected && (
                  <>
                    <circle cx={sx(s.x)} cy={sy(s.y)} r={HANDLE - 1} fill="#ff2d6b" />
                    <circle cx={sx(e2.ax)} cy={sy(e2.ay)} r={HANDLE} fill="#fff" stroke="#ff2d6b" strokeWidth={2} style={{ cursor: 'crosshair' }} onPointerDown={startDrag({ kind: 'capA' }, i)} />
                    <circle cx={sx(e2.bx)} cy={sy(e2.by)} r={HANDLE} fill="#fff" stroke="#ff2d6b" strokeWidth={2} style={{ cursor: 'crosshair' }} onPointerDown={startDrag({ kind: 'capB' }, i)} />
                    <circle cx={sx(s.x + perp.x * s.r)} cy={sy(s.y + perp.y * s.r)} r={HANDLE} fill="#ffd23f" stroke="#ff2d6b" strokeWidth={2} style={{ cursor: 'nwse-resize' }} onPointerDown={startDrag({ kind: 'capR' }, i)} />
                  </>
                )}
              </g>
            )
          })}
        </svg>
      </div>

      {/* controls */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12, overflow: 'auto' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {glyphs.map((g, i) => (
            <button
              key={g + i}
              onClick={() => {
                setGi(i)
                select(-1)
              }}
              style={{
                width: 34,
                height: 34,
                fontSize: 16,
                fontWeight: 700,
                borderRadius: 6,
                cursor: 'pointer',
                border: i === gi ? '2px solid #ff2d6b' : '1px solid #d4dae6',
                background: i === gi ? '#fff0f4' : '#fff',
              }}
            >
              {g}
            </button>
          ))}
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <button onClick={addBall} style={btn}>+ Ball (b)</button>
          <button onClick={addCap} style={btn}>+ Capsule (c)</button>
          <button onClick={addRect} style={btn}>+ Rect (x)</button>
          <button onClick={addOval} style={btn}>+ Oval (v)</button>
          <button onClick={delSel} style={{ ...btn, color: '#c0264e' }} disabled={sel < 0}>Delete (⌫)</button>
          <button onClick={resetGlyph} style={btn}>Reset ‘{glyph}’</button>
          <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
            glyph α
            <input type="range" min={0.2} max={1} step={0.05} value={glyphAlpha} onChange={(e) => setGlyphAlpha(Number(e.target.value))} />
          </label>
        </div>

        <div style={{ fontSize: 13, lineHeight: 1.5 }}>
          <b>‘{glyph}’</b> — {shapes.length} shape(s). Click to select; drag body to move. White dots =
          capsule ends; yellow = size (capsule width / rect corner / oval radius); blue = rotate. A
          rect/oval scales x &amp; y independently — drag a yellow handle to make it “just wider.” Arrows ←/→ switch letters.
        </div>

        {selShape && (
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 12, background: '#f7f9fc', padding: 8, borderRadius: 6 }}>
            <span style={{ fontWeight: 700 }}>{selShape.t}</span>
            <NumField label="x" value={selShape.x} onChange={(v) => updateShape(sel, { x: v } as Partial<HullShape>)} />
            <NumField label="y" value={selShape.y} onChange={(v) => updateShape(sel, { y: v } as Partial<HullShape>)} />
            {(selShape.t === 'ball' || selShape.t === 'cap' || selShape.t === 'rrect') && (
              <NumField label="r" value={selShape.r} onChange={(v) => updateShape(sel, { r: v } as Partial<HullShape>)} />
            )}
            {selShape.t === 'cap' && <NumField label="h" value={selShape.h} onChange={(v) => updateShape(sel, { h: v } as Partial<HullShape>)} />}
            {selShape.t === 'rrect' && <NumField label="hx" value={selShape.hx} onChange={(v) => updateShape(sel, { hx: v } as Partial<HullShape>)} />}
            {selShape.t === 'rrect' && <NumField label="hy" value={selShape.hy} onChange={(v) => updateShape(sel, { hy: v } as Partial<HullShape>)} />}
            {selShape.t === 'oval' && <NumField label="rx" value={selShape.rx} onChange={(v) => updateShape(sel, { rx: v } as Partial<HullShape>)} />}
            {selShape.t === 'oval' && <NumField label="ry" value={selShape.ry} onChange={(v) => updateShape(sel, { ry: v } as Partial<HullShape>)} />}
            {selShape.t !== 'ball' && <NumField label="a" value={selShape.a} onChange={(v) => updateShape(sel, { a: v } as Partial<HullShape>)} />}
          </div>
        )}

        <textarea
          readOnly
          value={code}
          onFocus={(e) => e.currentTarget.select()}
          style={{ flex: 1, minHeight: 220, fontFamily: 'monospace', fontSize: 11, border: '1px solid #d4dae6', borderRadius: 6, padding: 8, whiteSpace: 'pre', overflow: 'auto' }}
        />
        <button onClick={() => navigator.clipboard?.writeText(code)} style={{ ...btn, alignSelf: 'flex-start' }}>Copy code</button>
      </div>
    </div>
  )
}

const btn: CSSProperties = {
  padding: '6px 10px',
  fontSize: 13,
  borderRadius: 6,
  border: '1px solid #d4dae6',
  background: '#fff',
  cursor: 'pointer',
}

function NumField({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
      {label}
      <input
        type="number"
        step={0.01}
        value={value}
        onChange={(e) => onChange(Math.round(Number(e.target.value) * 1000) / 1000)}
        style={{ width: 64, fontSize: 12, padding: '2px 4px', border: '1px solid #d4dae6', borderRadius: 4 }}
      />
    </label>
  )
}

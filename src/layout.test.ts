import { describe, it, expect } from 'vitest'
import { createLineLayout, type Line } from './layout'

// A stand-in for text measurement: every glyph is 0.5em wide. Deterministic and font-free, which
// is the whole reason `measure` is injected.
const measure = (text: string, size: number) => text.length * size * 0.5

const LINES: Line[] = [
  { text: 'Alpha Beta', weight: 1 },
  { text: 'Gamma', weight: 0.5 },
]

describe('createLineLayout', () => {
  it('emits one slot per non-space character', () => {
    const layout = createLineLayout({ lines: LINES, measure })
    const { slots } = layout(1200, 800)
    expect(slots).toHaveLength('AlphaBeta'.length + 'Gamma'.length) // the space is dropped
    expect(slots.some((s) => s.ch === ' ')).toBe(false)
  })

  it('preserves per-line weight, so a subtitle stays smaller than its display line', () => {
    const layout = createLineLayout({ lines: LINES, measure })
    const { slots } = layout(1200, 800)
    const line1 = slots.find((s) => s.ch === 'A')!
    const line2 = slots.find((s) => s.ch === 'G')!
    expect(line2.size).toBeCloseTo(line1.size * 0.5)
  })

  it('scales down to honour the width budget', () => {
    const layout = createLineLayout({ lines: LINES, measure, widthBudget: 0.8 })
    const narrow = layout(400, 800)
    const wide = layout(1600, 800)
    expect(narrow.fit).toBeLessThan(wide.fit)
    const widest = measure('Alpha Beta', 120 * narrow.fit)
    expect(widest).toBeLessThanOrEqual(400 * 0.8 + 0.001)
  })

  it('also fits on HEIGHT — a short viewport must not overlap the lines', () => {
    // The original width-only fit is exactly what this covers: at 1600x200 the width is generous,
    // so a width-only fit would leave the lines full-size and overlapping.
    const layout = createLineLayout({ lines: LINES, measure })
    const short = layout(1600, 200)
    const tall = layout(1600, 1200)
    expect(short.fit).toBeLessThan(tall.fit)
  })

  it('never scales UP past maxScale', () => {
    const layout = createLineLayout({ lines: LINES, measure, maxScale: 1 })
    expect(layout(10000, 10000).fit).toBe(1)
  })

  it('centres each line horizontally about the viewport', () => {
    const layout = createLineLayout({ lines: [{ text: 'ABCD' }], measure })
    const { slots } = layout(1000, 800)
    const mid = (slots[0].x + slots[slots.length - 1].x) / 2
    expect(mid).toBeCloseTo(500, 0)
  })

  it('recomputes from the viewport, so the same strategy serves any size', () => {
    const layout = createLineLayout({ lines: LINES, measure })
    const a = layout(800, 600)
    const b = layout(1600, 600)
    expect(a.slots[0].x).not.toBeCloseTo(b.slots[0].x)
    expect(a.slots).toHaveLength(b.slots.length)
  })

  it('accepts a function of width, so a host can restructure on a phone', () => {
    const layout = createLineLayout({
      lines: (vw) => (vw <= 640 ? [{ text: 'Alpha' }, { text: 'Beta' }, { text: 'Gamma' }] : LINES),
      measure,
    })
    expect(new Set(layout(1200, 800).slots.map((s) => s.y)).size).toBe(2)
    expect(new Set(layout(390, 800).slots.map((s) => s.y)).size).toBe(3)
  })

  describe('signature', () => {
    it('is stable across a pure size change, so a resize re-homes instead of rebuilding', () => {
      const layout = createLineLayout({ lines: LINES, measure })
      expect(layout.signature(1200)).toBe(layout.signature(800))
    })

    it('changes when the line set changes, so the host knows it must rebuild', () => {
      const layout = createLineLayout({
        lines: (vw) => (vw <= 640 ? [{ text: 'Alpha' }, { text: 'Beta' }] : LINES),
        measure,
      })
      expect(layout.signature(390)).not.toBe(layout.signature(1200))
    })
  })

  it('separates lines enough that a bouncy settle cannot overlap them', () => {
    const layout = createLineLayout({ lines: LINES, measure })
    const { slots, sizes } = layout(1200, 800)
    const ys = [...new Set(slots.map((s) => s.y))].sort((a, b) => a - b)
    expect(ys[1] - ys[0]).toBeGreaterThan(Math.max(...sizes) * 0.5)
  })
})

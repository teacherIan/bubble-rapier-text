import { describe, it, expect } from 'vitest'
import { GLYPH_HULLS, hullForGlyph, scaleHull, type HullShape } from './glyphHulls'

// These pin the two invariants the whole collision system rests on:
//  1. scaleHull is a pure units→px multiply that leaves ANGLES alone. Scaling an angle is the
//     classic bug here — it would tilt every non-ball collider by a size-dependent amount, so a
//     hull authored in the editor at one size would collide differently at another.
//  2. hullForGlyph always yields at least one shape. A glyph with no authored hull must fall back
//     to a ball, or it becomes a collider-less body that drops through the floor.

describe('scaleHull', () => {
  it('scales lengths and leaves angles untouched', () => {
    const shapes: HullShape[] = [
      { t: 'ball', x: 0.1, y: -0.2, r: 0.3 },
      { t: 'cap', x: 0.1, y: 0.2, r: 0.05, h: 0.4, a: 1.234 },
      { t: 'rrect', x: -0.1, y: 0.2, hx: 0.3, hy: 0.15, r: 0.05, a: -0.5 },
      { t: 'oval', x: 0, y: 0.1, rx: 0.25, ry: 0.4, a: 2 },
    ]
    const px = scaleHull(shapes, 100)

    expect(px[0]).toEqual({ t: 'ball', x: 10, y: -20, r: 30 })
    expect(px[1]).toEqual({ t: 'cap', x: 10, y: 20, r: 5, h: 40, a: 1.234 })
    expect(px[2]).toEqual({ t: 'rrect', x: -10, y: 20, hx: 30, hy: 15, r: 5, a: -0.5 })
    expect(px[3]).toEqual({ t: 'oval', x: 0, y: 10, rx: 25, ry: 40, a: 2 })
  })

  it('is linear in size, so a hull collides the same shape at any font size', () => {
    const shapes: HullShape[] = [{ t: 'cap', x: 0.1, y: 0.2, r: 0.05, h: 0.4, a: 0.7 }]
    const a = scaleHull(shapes, 50)[0]
    const b = scaleHull(shapes, 150)[0]
    if (a.t !== 'cap' || b.t !== 'cap') throw new Error('shape kind must survive scaling')
    expect(b.x / a.x).toBeCloseTo(3)
    expect(b.r / a.r).toBeCloseTo(3)
    expect(b.h / a.h).toBeCloseTo(3)
    expect(b.a).toBe(a.a) // NOT scaled
  })

  it('does not mutate the authored input', () => {
    const shapes: HullShape[] = [{ t: 'ball', x: 0.1, y: 0.2, r: 0.3 }]
    const before = structuredClone(shapes)
    scaleHull(shapes, 64)
    expect(shapes).toEqual(before)
  })
})

describe('hullForGlyph', () => {
  it('returns the authored hull for a known glyph', () => {
    expect(hullForGlyph('o', 0.3, 0.3)).toBe(GLYPH_HULLS['o'])
  })

  it('falls back to a ball for an unauthored glyph', () => {
    const hull = hullForGlyph('§', 0.3, 0.4) // § — never authored
    expect(hull).toHaveLength(1)
    expect(hull[0].t).toBe('ball')
  })

  it('sizes the fallback ball to the SMALLER half-extent so it fits inside the glyph box', () => {
    const hull = hullForGlyph('§', 0.2, 0.5)
    if (hull[0].t !== 'ball') throw new Error('expected ball fallback')
    expect(hull[0].r).toBeCloseTo(0.2 * 0.95)
  })

  it('never returns a zero-radius ball, even for a degenerate box', () => {
    const hull = hullForGlyph('§', 0, 0)
    if (hull[0].t !== 'ball') throw new Error('expected ball fallback')
    expect(hull[0].r).toBeGreaterThan(0) // a 0-radius collider would fall through the floor
  })
})

describe('GLYPH_HULLS data', () => {
  it('has no empty hulls (an empty array silently degrades to the ball fallback)', () => {
    for (const [ch, shapes] of Object.entries(GLYPH_HULLS)) {
      expect(shapes.length, `glyph ${ch} has an empty hull`).toBeGreaterThan(0)
    }
  })

  it('keeps every primitive strictly positive in its radii/extents', () => {
    for (const [ch, shapes] of Object.entries(GLYPH_HULLS)) {
      for (const s of shapes) {
        const label = `glyph ${ch} (${s.t})`
        if (s.t === 'ball') expect(s.r, label).toBeGreaterThan(0)
        else if (s.t === 'cap') {
          expect(s.r, label).toBeGreaterThan(0)
          expect(s.h, label).toBeGreaterThan(0)
        } else if (s.t === 'rrect') {
          expect(s.hx, label).toBeGreaterThan(0)
          expect(s.hy, label).toBeGreaterThan(0)
          // Rapier's roundCuboid treats r as a border ADDED to the half-extents; a corner
          // radius larger than the box it rounds is a malformed shape.
          expect(s.r, label).toBeLessThanOrEqual(Math.min(s.hx, s.hy))
        } else {
          expect(s.rx, label).toBeGreaterThan(0)
          expect(s.ry, label).toBeGreaterThan(0)
        }
      }
    }
  })
})

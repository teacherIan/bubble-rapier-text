import { describe, it, expect } from 'vitest'
import { planClaims, type LetterView, type Slot } from './transition'

const L = (ch: string, x: number, y: number, discarded = false): LetterView => ({ ch, x, y, discarded })
const S = (ch: string, x: number, y: number): Slot => ({ ch, x, y })

describe('planClaims', () => {
  it('claims the NEAREST exact-case match for a slot', () => {
    const { plan, claimed } = planClaims([L('a', 0, 0), L('a', 100, 0)], [S('a', 90, 0)])
    expect(plan[0].survivor).toBe(1) // the closer 'a'
    expect([...claimed]).toEqual([1])
  })

  it('claims each letter at most once (second same-glyph slot must spawn)', () => {
    const { plan } = planClaims([L('a', 0, 0)], [S('a', 0, 0), S('a', 10, 0)])
    expect(plan[0].survivor).toBe(0)
    expect(plan[1].survivor).toBe(-1)
  })

  it('is case-sensitive', () => {
    expect(planClaims([L('A', 0, 0)], [S('a', 0, 0)]).plan[0].survivor).toBe(-1)
  })

  it('never claims a discarded (flung-off) letter', () => {
    expect(planClaims([L('a', 0, 0, true)], [S('a', 0, 0)]).plan[0].survivor).toBe(-1)
  })

  it('a slot with no matching glyph → survivor -1, claimed empty', () => {
    const { plan, claimed } = planClaims([L('x', 0, 0)], [S('y', 0, 0)])
    expect(plan[0].survivor).toBe(-1)
    expect(claimed.size).toBe(0)
  })

  it('distributes two like glyphs to their nearest distinct slots', () => {
    const { plan } = planClaims([L('o', 0, 0), L('o', 100, 0)], [S('o', 5, 0), S('o', 95, 0)])
    expect(plan[0].survivor).toBe(0) // slot near 5 → letter at 0
    expect(plan[1].survivor).toBe(1) // slot near 95 → letter at 100
  })

  it('preserves a RICHER slot type through the plan (generic over Slot)', () => {
    // The orchestrator passes layout slots that carry a `size`; planClaims must hand them back
    // intact, not widened to the bare {ch,x,y}. If this regresses, the caller loses `size` and
    // every survivor re-fits to NaN.
    type Sized = { ch: string; x: number; y: number; size: number }
    const slots: Sized[] = [{ ch: 'a', x: 0, y: 0, size: 42 }]
    const { plan } = planClaims([L('a', 1, 1)], slots)
    expect(plan[0].slot.size).toBe(42)
  })
})

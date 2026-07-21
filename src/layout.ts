// layout.ts — where the letters go, DERIVED from the live viewport.
//
// Previously the two lines were laid out inline at fixed sizes with a width-only fit. Two problems
// that only a viewport-derived layout can fix:
//   • the fit considered WIDTH alone, so on a short or landscape viewport the lines overlapped and
//     clipped — there was nothing to notice the height at all;
//   • the layout ran once at mount, so nothing could recompute it on resize or rotation.
//
// Everything app-specific is a parameter. The library ships a sensible default (centred, or framed
// top/bottom) and a consumer supplies its own `lines` and `lineYs` rather than editing this file.
// `measure` is INJECTED for the same reason it always was: it keeps this module pure geometry —
// no PIXI, no DOM — so it is unit-testable without a canvas.

/** Measures one string at one font size, in px. */
export type Measure = (text: string, size: number) => number

/**
 * One line of the phrase. `weight` scales this line's font size relative to the others — that is
 * what keeps a display line larger than its subtitle. Omitted means 1.
 */
export interface Line {
  text: string
  weight?: number
}

/** A resolved target for one character. `size` is per-slot because lines can differ in weight. */
export interface Slot {
  ch: string
  x: number
  y: number
  size: number
  /** Pin this slot's fill colour instead of taking the next dealt palette colour. The pin only
   *  applies when the letter is CREATED for this slot; a survivor keeps its existing colour. */
  color?: number
}

export interface LayoutResult {
  slots: Slot[]
  /** The scale applied to the base size to make the phrase fit. Callers scale px thresholds by it. */
  fit: number
  /** Resolved font size per line, in px. */
  sizes: number[]
  /** Transition hint: new letters materialize AT their slots instead of flying in from an edge. */
  spawnAtSlot?: boolean
}

export interface LayoutOptions {
  /** Lines, or a function of viewport width (e.g. to stack more lines on a phone). */
  lines: Line[] | ((vw: number) => Line[])
  measure: Measure
  /** Font size of a weight-1 line before fitting. A function form sees the live viewport — for
   *  anchoring a line at a size derived from it (e.g. matching a sibling HUD element). */
  baseSize?: number | ((vw: number, vh: number) => number)
  /** Fraction of the width the widest line may occupy. < 1 keeps end letters off the walls. */
  widthBudget?: number
  /** Fraction of the height all lines together may occupy. */
  heightBudget?: number
  /** Never scale UP past this, so a huge viewport doesn't produce absurd glyphs. */
  maxScale?: number
  /** A glyph's visual height as a fraction of its font size — used for the height fit. */
  glyphHeightRatio?: number
  /** Baseline y for each line. Default centres them; see `frame`. */
  lineYs?: (vh: number, count: number, sizes: number[]) => number[]
  /** Centre x for each line. Default centres on the viewport; use for edge-anchored lines
   *  (a corner HUD stage). Mirrors `lineYs`. */
  lineXs?: (vw: number, count: number, sizes: number[]) => number[]
  /** Push the lines to the top and bottom edges instead of centring (default lineYs only). */
  frame?: boolean
  /** Pin per-slot colours: return a colour for (lineIndex, charIndex, ch) or undefined to fall
   *  back to the dealt palette. charIndex counts every character of the line, spaces included —
   *  align it with your own per-character HUD indexing. */
  slotColor?: (lineIndex: number, charIndex: number, ch: string) => number | undefined
  /** Carried onto every LayoutResult: letters MISSING in a transition to this layout spawn at
   *  their slots (an in-place materialize) rather than flying in from off-screen. The stage for
   *  a seamless swap with a non-physics twin, before a later layout moves the letters for real. */
  spawnAtSlot?: boolean
}

export interface LayoutStrategy {
  (vw: number, vh: number): LayoutResult
  /**
   * A value that changes only when the layout STRUCTURE changes (line count, line text). The host
   * compares it across a resize to decide between a cheap re-home and a full rebuild — a rebuild
   * respawns every letter, which is the difference between a smooth resize and a visible flash.
   */
  signature: (vw: number) => string
}

const SPACE_FRAC = 0.34 // must match letterStyle.ts — spaces advance without a Text object

const defaultLineYs = (vh: number, count: number, sizes: number[], frame: boolean): number[] => {
  if (count === 1) return [vh / 2]
  if (frame) {
    // Wrap the lines AROUND the centre, so a host can put something in the middle.
    const step = count === 1 ? 0 : 0.74 / (count - 1)
    return Array.from({ length: count }, (_, i) => vh * (0.13 + i * step))
  }
  // Centred: stack the lines about the middle, spaced by the tallest so a bouncy settle can't
  // overlap two lines and tangle letters across them.
  const gap = Math.max(...sizes) * 0.86
  const span = (count - 1) * gap
  return Array.from({ length: count }, (_, i) => vh / 2 - span / 2 + i * gap)
}

/**
 * Build a layout strategy: a function from viewport to slots, plus a structural `signature`.
 *
 * Fitting considers BOTH axes — the widest line against the width budget, and the stacked line
 * heights against the height budget — then takes the smaller scale.
 */
export function createLineLayout(opts: LayoutOptions): LayoutStrategy {
  const {
    lines,
    measure,
    baseSize = 120,
    widthBudget = 0.8,
    heightBudget = 0.62,
    maxScale = 1,
    glyphHeightRatio = 1.0,
    lineYs,
    lineXs,
    slotColor,
    frame = false,
    spawnAtSlot = false,
  } = opts

  const resolve = (vw: number): Line[] => (typeof lines === 'function' ? lines(vw) : lines)

  const strategy = (vw: number, vh: number): LayoutResult => {
    const ls = resolve(vw)
    const weights = ls.map((l) => l.weight ?? 1)
    const base = typeof baseSize === 'function' ? baseSize(vw, vh) : baseSize
    const baseSizes = weights.map((wt) => base * wt)

    const widest = Math.max(1, ...ls.map((l, i) => measure(l.text, baseSizes[i])))
    const fitW = (vw * widthBudget) / widest
    const stacked = baseSizes.reduce((s, sz) => s + sz * glyphHeightRatio, 0)
    const fitH = (vh * heightBudget) / Math.max(1, stacked)
    const fit = Math.min(maxScale, fitW, fitH)

    const sizes = baseSizes.map((sz) => sz * fit)
    const ys = lineYs ? lineYs(vh, ls.length, sizes) : defaultLineYs(vh, ls.length, sizes, frame)
    const xs = lineXs ? lineXs(vw, ls.length, sizes) : null

    const slots: Slot[] = []
    ls.forEach((line, li) => {
      const size = sizes[li]
      // Pre-resolve advances so spaces cost the same here as they do when the letters are built.
      const widths = [...line.text].map((ch) => (ch === ' ' ? size * SPACE_FRAC : measure(ch, size)))
      const total = widths.reduce((s, v) => s + v, 0)
      let cursor = (xs ? xs[li] : vw / 2) - total / 2
      ;[...line.text].forEach((ch, ci) => {
        const wdt = widths[ci]
        const x = cursor + wdt / 2
        cursor += wdt
        if (ch === ' ') return
        const color = slotColor?.(li, ci, ch)
        slots.push(color === undefined ? { ch, x, y: ys[li], size } : { ch, x, y: ys[li], size, color })
      })
    })

    return { slots, fit, sizes, spawnAtSlot }
  }

  // Height is deliberately absent: only WIDTH can change the line set (via a `lines` function),
  // and a height-only change is exactly the case the cheap re-home path handles well.
  //
  // The delimiters are written as \u escapes, not literal control bytes: NUL and SOH cannot occur
  // in real line text (so the signature is unambiguous), but embedding them literally makes git
  // classify this file as BINARY and show no diff for it at all.
  strategy.signature = (vw: number): string =>
    resolve(vw)
      .map((l) => `${l.text}\u0000${l.weight ?? 1}`)
      .join('\u0001')

  return strategy
}

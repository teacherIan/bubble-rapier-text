// letterStyle.ts — the ONE definition of how a bubble letter is drawn.
//
// This used to be copy-pasted into CelebrateBubbles, GlyphHullEditor, and GlyphHullLab, with a
// comment in the lab asserting it was "BYTE-IDENTICAL to CelebrateBubbles.letterStyle". That
// invariant is load-bearing and was maintained by hand: the stroke and drop shadow both inflate the
// rendered text's bounding box, and the collider origin is that box's centre (PIXI anchor 0.5). Let
// the copies drift and every authored hull silently lands a few px off the glyph it was traced on.
import * as PIXI from 'pixi.js'

export const FONT_STACK = '"Cherry Bomb One", system-ui, sans-serif'

/**
 * A space's advance as a fraction of the font size. Shared by the measurement pass and the layout
 * pass — if they disagree, the fitted phrase width doesn't match where the letters actually go.
 */
export const SPACE_FRAC = 0.34

/**
 * The style WITHOUT a fill colour, for measurement. Identical in every metric-affecting respect to
 * letterStyle() below, so measuring with this and rendering with that cannot disagree.
 *
 * `padding` matters: PIXI crops the glyph texture to the style's computed bounds, and a drop shadow
 * cast below the baseline (plus the stroke) lands outside them — without the pad, descenders and
 * the shadow are clipped off the rasterized texture.
 */
export function metricStyle(size: number): PIXI.TextStyle {
  return new PIXI.TextStyle({
    fontFamily: FONT_STACK,
    fontSize: size,
    stroke: { color: 0xffffff, width: Math.max(2, size * 0.045) },
    dropShadow: { color: 0x232347, alpha: 0.34, blur: 3, distance: size * 0.085, angle: Math.PI / 2 },
    padding: Math.ceil(size * 0.2),
  })
}

/** The rendered style: the metric style plus a fill colour. */
export function letterStyle(color: number, size: number): PIXI.TextStyle {
  const style = metricStyle(size)
  style.fill = color
  return style
}

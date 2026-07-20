// transition.ts — the PURE planner behind a word-to-word hand-off. Given where the live letters
// are and where the target slots are, it decides which existing glyph claims each slot (nearest
// matching, each used once), which letters are left unclaimed (to be flung off), and which slots
// need a fresh letter spawned. No PIXI/Rapier here, so it is trivially unit-testable.
//
// This is the missing half of the re-layout primitives (removeWalls / retargetLetter /
// scatterLetter / addLetter): those can morph a live world into a new word, but they need someone
// to decide WHICH letter goes where. Reusing a glyph instead of respawning it is what makes the
// transition read as the same letters rearranging rather than one word being replaced by another.

/** A target position for one character in the new word. */
export interface Slot {
  ch: string
  x: number
  y: number
}

/** A live letter as the planner sees it: its glyph, current position, and whether it's flung off. */
export interface LetterView {
  ch: string
  x: number
  y: number
  discarded: boolean
}

export interface TransitionPlan<S extends Slot = Slot> {
  /** Indices of letters claimed by a slot (each appears once). Everything else should be scattered. */
  claimed: Set<number>
  /** Per target slot: the claimed survivor's index, or -1 if a fresh letter must be spawned. */
  plan: { slot: S; survivor: number }[]
}

/**
 * For each slot, claim the NEAREST unused, non-discarded, exact-case matching letter. A letter is
 * claimed at most once; a slot with no match gets `survivor: -1` (spawn one).
 *
 * Matching is case-SENSITIVE on purpose: 'a' and 'A' are different glyphs with different hulls and
 * different sizes, so reusing one as the other would visibly pop.
 *
 * Greedy nearest-first, not a global optimal assignment. For the handful of letters a wordmark has,
 * the difference is invisible in motion and the greedy pass is trivial to reason about.
 */
export function planClaims<S extends Slot>(letters: LetterView[], slots: S[]): TransitionPlan<S> {
  const claimed = new Set<number>()
  const plan = slots.map((slot) => {
    let best = -1
    let bestD = Infinity
    for (let i = 0; i < letters.length; i++) {
      const L = letters[i]
      if (claimed.has(i) || L.discarded || L.ch !== slot.ch) continue
      const d = Math.hypot(L.x - slot.x, L.y - slot.y)
      if (d < bestD) {
        bestD = d
        best = i
      }
    }
    if (best >= 0) claimed.add(best)
    return { slot, survivor: best }
  })
  return { claimed, plan }
}

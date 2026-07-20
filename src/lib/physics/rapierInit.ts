import type RAPIER from '@dimforge/rapier2d-compat'

// Rapier ships its physics core as WASM. RAPIER.init() loads and instantiates that
// module exactly once per page; subsequent World instances are pure JS construction.
// We share this init across all consumers, but each consumer owns its own World so
// step() doesn't double-advance shared bodies.
//
// The loader is INJECTABLE because how you get the WASM is a deployment decision, not a
// library one. The default (`@dimforge/rapier2d-compat`, which inlines the WASM as base64)
// works with no configuration anywhere, at the cost of a larger bundle and a
// decode-on-startup. A consumer that would rather ship the raw .wasm — via
// `@dimforge/rapier2d` with a bundler plugin, a CDN URL, or its own vendored copy — calls
// setRapierLoader() instead of forking the module.

/** Resolves to an initialized Rapier namespace. */
export type RapierLoader = () => Promise<typeof RAPIER>

/** Default: the compat build, whose WASM is inlined — no bundler or server configuration. */
const compatLoader: RapierLoader = async () => {
  const R = await import('@dimforge/rapier2d-compat')
  await R.init()
  return R
}

let loader: RapierLoader = compatLoader
let initPromise: Promise<typeof RAPIER> | null = null

/**
 * Swap in your own Rapier loader. Must be called BEFORE anything touches the physics —
 * `createCelebrateWorld`, `<CelebrateBubbles>` mounting, or a bare `ensureRapierInitialized`.
 *
 * Throws if init has already begun rather than silently ignoring you: the world you would
 * get back would be built on the OTHER Rapier, and the resulting cross-instance bugs
 * (colliders that never collide, `instanceof` misses) are miserable to trace back to here.
 */
export function setRapierLoader(next: RapierLoader): void {
  if (initPromise) {
    throw new Error(
      'setRapierLoader() called after Rapier initialization already started. Call it before ' +
        'creating a world or mounting <CelebrateBubbles>.',
    )
  }
  loader = next
}

export async function ensureRapierInitialized(): Promise<typeof RAPIER> {
  if (!initPromise) initPromise = loader()
  return initPromise
}

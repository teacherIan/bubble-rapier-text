import RAPIER from '@dimforge/rapier2d-compat'

// Rapier ships its physics core as WASM. RAPIER.init() loads and instantiates that
// module exactly once per page; subsequent World instances are pure JS construction.
// We share this init across all consumers, but each consumer owns its own World so
// step() doesn't double-advance shared bodies.
let initPromise: Promise<typeof RAPIER> | null = null

export async function ensureRapierInitialized(): Promise<typeof RAPIER> {
  if (!initPromise) {
    initPromise = RAPIER.init().then(() => RAPIER)
  }
  return initPromise
}

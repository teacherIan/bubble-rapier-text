import type { CelebrateWorld } from '../celebratePhysics'

// A world whose wasm panicked cannot be freed: the panic left its raw sets mid-borrow, and free()
// throws "attempted to take ownership of Rust value while it was borrowed". Thrown from a React
// cleanup, that takes out the host's error boundary on the way OUT — the page dies because the
// user navigated away from a frozen toy. The world is being discarded either way; drop it.
//
// Silent for a dead world (stepCelebrate already logged the panic); a live world whose free()
// throws is a new failure, so it is logged.
export function safeFreeWorld(world: CelebrateWorld): void {
  try {
    world.world.free()
  } catch (err) {
    if (!world.dead) console.warn('[bubble-rapier-text] world.free() threw during teardown', err)
  }
}

import type * as PIXI from 'pixi.js'

// Teardown must never throw: PIXI v8's canvas-text texture pool can double-return a texture on
// destroy (its GC may have already unloaded it while the ticker slept), which surfaces as
// "Cannot read properties of undefined (reading 'push')" INSIDE app.destroy — and an exception in
// a React cleanup feeds the host's error boundary, which then pointlessly rebuilds the tree the
// user is navigating away from. The app is being discarded either way; swallow and drop the view.
//
// Shared by the component and both dev tools. Callers must only pass an app whose init() has
// RESOLVED: PIXI 8 throws when an Application is destroyed mid-init (its plugins are not set up
// yet), so an app still initializing is not theirs to destroy — adopt it after init, or not at all.
export function safeDestroyApp(app: PIXI.Application): void {
  try {
    app.destroy({ removeView: true }, { children: true })
  } catch (err) {
    // Known case: PIXI v8's canvas-text pool double-returns a texture. Log it —
    // a swallowed teardown error must still be visible to whoever regresses it.
    console.warn('[bubble-rapier-text] app.destroy threw during teardown (view dropped manually)', err)
    try {
      app.canvas?.remove()
    } catch {
      /* view already gone */
    }
  }
}

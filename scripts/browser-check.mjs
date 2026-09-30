// Headless-Chrome checks for the component fixes a node unit test cannot reach (0.11.0): a dead
// world met by a phrase change, a tap, a resize and an unmount; <GlyphHullLab>/<GlyphHullEditor>
// unmounted while PIXI's init() is pending; <CelebrateBubbles> hidden and re-shown under React
// 19.2 <Activity>. A scenario passes when the demo's nav survives and no page error or
// console.error appears. One line per scenario; exits 1 if any fails.
//
// Not part of `npm test` — it needs a browser and the demo dev server:
//   npm i --no-save playwright-core      (falls back to installed Chrome without Playwright's own)
//   npx vite --host 127.0.0.1 --port 5199
//   npm run check:browser -- [label] [scenario]      (BASE=<url> to point it elsewhere)
let chromium
try {
  ;({ chromium } = await import('playwright-core'))
} catch {
  console.error('browser-check: playwright-core is not installed — npm i --no-save playwright-core')
  process.exit(2)
}

const BASE = process.env.BASE ?? 'http://127.0.0.1:5199/'
const label = process.argv[2] ?? 'run'
const only = process.argv[3]

async function launch() {
  try {
    return await chromium.launch({ headless: true })
  } catch {
    return await chromium.launch({ headless: true, channel: 'chrome' })
  }
}

const browser = await launch()

async function fresh() {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push('pageerror: ' + String(e.message).slice(0, 160)))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push('console.error: ' + m.text().slice(0, 160))
  })
  await page.goto(BASE)
  await page.waitForFunction(() => !!window.__cb, null, { timeout: 15000 })
  return { ctx, page, errors }
}

// Kill the wasm the way production died: a double free traps; the next step catches it.
async function poison(page) {
  return page.evaluate(async () => {
    const cb = window.__cb
    const w = cb.world
    // A real mid-step panic leaves EVERY raw set borrowed, so every later read or write throws.
    // Model exactly that: mark it dead (what stepCelebrate's catch does) and free the wasm world,
    // after which every body read throws "null pointer passed to rust".
    w.dead = true
    w.world.free()
    await new Promise((r) => setTimeout(r, 100)) // one ticker frame: it sees `dead` and stops
    try { w.letters[0].body.translation(); return false } catch { /* reads throw, as intended */ }
    return w.dead
  })
}

const navAlive = (page) => page.evaluate(() => !!document.querySelector('nav'))
const relevant = (errors) =>
  errors.filter((e) => !e.includes('physics world died mid-step') && !e.includes('[bubble-rapier-text] physics'))

let failed = 0
async function scenario(name, fn) {
  if (only && only !== name) return
  const { ctx, page, errors } = await fresh()
  let note = ''
  try {
    note = (await fn(page)) ?? ''
  } catch (e) {
    note = 'script threw: ' + String(e.message).slice(0, 160)
  }
  await page.waitForTimeout(600)
  const alive = await navAlive(page).catch(() => false)
  const errs = relevant(errors)
  const ok = alive && errs.length === 0 && !note.startsWith('script threw') && !note.startsWith('BAD')
  if (!ok) failed += 1
  console.log(`[${label}] ${ok ? 'PASS' : 'FAIL'} ${name} — page ${alive ? 'intact' : 'GONE'}${note ? ' — ' + note : ''}`)
  for (const e of errs.slice(0, 4)) console.log(`        ${e}`)
  await ctx.close()
}

// A. dead world, then a live phrase change (the Morph button).
await scenario('dead-then-morph', async (page) => {
  if (!(await poison(page))) return 'BAD: could not poison'
  await page.getByRole('button', { name: 'Morph' }).click()
})

// B. dead world, then a tap on the canvas (pointerdown → pickLetter).
await scenario('dead-then-pointerdown', async (page) => {
  if (!(await poison(page))) return 'BAD: could not poison'
  await page.mouse.click(640, 420)
})

// C. dead world, then a viewport change that forces a structural rebuild.
await scenario('dead-then-resize', async (page) => {
  if (!(await poison(page))) return 'BAD: could not poison'
  await page.setViewportSize({ width: 420, height: 800 })
  await page.waitForTimeout(300)
})

// G. a genuinely panicked world (double free → trap → caught by the step), then unmount.
await scenario('dead-then-unmount', async (page) => {
  const dead = await page.evaluate(async () => {
    const cb = window.__cb
    const w = cb.world
    const d = w.world.createRigidBody(w.rapier.RigidBodyDesc.fixed())
    w.world.removeRigidBody(d)
    try { w.world.removeRigidBody(d) } catch { /* the trap */ }
    if (!cb.app.ticker.started) cb.app.ticker.start()
    const t0 = performance.now()
    while (!w.dead && performance.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 50))
    return w.dead
  })
  if (!dead) return 'BAD: could not poison'
  await page.getByRole('button', { name: 'Hull lab' }).click() // unmounts <CelebrateBubbles>
})

// D/E. the dev tools unmounted while PIXI's Application.init is still pending.
for (const [name, tab] of [['lab-unmount-mid-init', 'Hull lab'], ['editor-unmount-mid-init', 'Hull editor']]) {
  await scenario(name, async (page) => {
    // Same module instance the app uses (same ?v= hash), so the patch reaches its Application.
    const patched = await page.evaluate(async () => {
      const url = performance.getEntriesByType('resource').map((e) => e.name).find((n) => /\/pixi__js\.js/.test(n))
      if (!url) return false
      const m = await import(url)
      const orig = m.Application.prototype.init
      window.__initPending = 0
      m.Application.prototype.init = async function (...args) {
        window.__initPending++
        await new Promise((r) => setTimeout(r, 3000))
        try { return await orig.apply(this, args) } finally { window.__initPending-- }
      }
      return true
    })
    if (!patched) return 'BAD: could not patch PIXI'
    await page.getByRole('button', { name: tab }).click()
    await page.waitForFunction(() => window.__initPending > 0, null, { timeout: 5000 })
    await page.getByRole('button', { name: 'Celebrate' }).click() // unmount while init is pending
    await page.waitForFunction(() => window.__initPending === 0, null, { timeout: 8000 })
    await page.waitForTimeout(300)
    const canvases = await page.evaluate(() => document.querySelectorAll('canvas').length)
    return `unmounted mid-init; canvases after: ${canvases}`
  })
}

// F. React 19.2 <Activity>: hide (effects clean up) then show (effects re-run).
await scenario('activity-hide-show', async (page) => {
  const ok = await page.evaluate(async () => {
    const names = performance.getEntriesByType('resource').map((e) => e.name)
    const reactUrl = names.find((n) => /\/deps\/react\.js/.test(n))
    const domUrl = names.find((n) => /\/deps\/react-dom_client\.js/.test(n))
    if (!reactUrl || !domUrl) return 'missing dep urls'
    const Rm = await import(reactUrl)
    const React = Rm.Activity ? Rm : Rm.default
    const Dm = await import(domUrl)
    const createRoot = Dm.createRoot ?? Dm.default.createRoot
    const { CelebrateBubbles } = await import('/src/CelebrateBubbles.tsx')
    const host = document.createElement('div')
    host.style.cssText = 'position:fixed;inset:0;z-index:5'
    document.body.appendChild(host)
    const root = createRoot(host)
    let mode = 'visible'
    const render = () =>
      root.render(React.createElement(React.Activity, { mode }, React.createElement(CelebrateBubbles, { position: 'absolute', transparent: true })))
    render()
    window.__setMode = (m) => { mode = m; render() }
    return 'ok'
  })
  if (ok !== 'ok') return 'BAD: ' + ok
  await page.waitForTimeout(2500) // let the second instance finish its async build
  await page.evaluate(() => window.__setMode('hidden'))
  await page.waitForTimeout(500)
  await page.evaluate(() => window.__setMode('visible'))
  await page.waitForTimeout(2500)
  const canvases = await page.evaluate(() => document.querySelectorAll('canvas').length)
  return `canvases after: ${canvases}`
})

await browser.close()
if (failed) process.exitCode = 1

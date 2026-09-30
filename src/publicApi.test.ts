import { describe, it, expect } from 'vitest'
import * as api from './index'
import * as physics from './celebratePhysics'
import * as hulls from './glyphHulls'
import * as layout from './layout'
import * as transition from './transition'
import * as letterStyle from './letterStyle'
import * as world from './lib/physics/world'
import * as rapierInit from './lib/physics/rapierInit'

// package.json `exports` exposes only the entry, so a runtime export the entry forgets to re-export
// is unreachable for every consumer, however well it is documented. (setWallGroups shipped in
// 0.8.0 that way.)
describe('the package entry', () => {
  const modules = { physics, hulls, layout, transition, letterStyle, world, rapierInit }
  for (const [name, mod] of Object.entries(modules)) {
    it(`re-exports every runtime export of ${name}`, () => {
      const missing = Object.keys(mod).filter((k) => !(k in api))
      expect(missing).toEqual([])
    })
  }
})

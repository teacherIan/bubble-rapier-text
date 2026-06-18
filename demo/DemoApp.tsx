import { useState, type CSSProperties } from 'react'
import { CelebrateBubbles, GlyphHullEditor, GlyphHullLab } from '../src'

// Demo harness for the library: a thin top nav switches between the three surfaces the
// package exposes — the celebration bubble text, the interactive hull editor, and the
// calibration lab. Each view is keyed so switching fully remounts it (clean PIXI/Rapier
// teardown + rebuild). The celebrate view also exercises the component's runtime props
// (exit fling, frame layout) so the whole public surface is reachable from the browser.

type View = 'celebrate' | 'editor' | 'lab'

const TABS: { id: View; label: string }[] = [
  { id: 'celebrate', label: 'Celebrate' },
  { id: 'editor', label: 'Hull editor' },
  { id: 'lab', label: 'Hull lab' },
]

export function DemoApp() {
  const [view, setView] = useState<View>('celebrate')
  const [frame, setFrame] = useState(false)
  const [exiting, setExiting] = useState(false)
  const [nonce, setNonce] = useState(0)

  const replay = () => {
    setExiting(false)
    setNonce((n) => n + 1)
  }

  return (
    <>
      <nav style={navStyle}>
        <span style={{ fontWeight: 800, letterSpacing: 0.3 }}>bubble-rapier-text</span>
        <div style={{ display: 'flex', gap: 4 }}>
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setView(t.id)}
              style={{ ...tabStyle, ...(view === t.id ? tabActive : null) }}
            >
              {t.label}
            </button>
          ))}
        </div>

        {view === 'celebrate' && (
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginLeft: 'auto' }}>
            <label style={chkStyle}>
              <input type="checkbox" checked={frame} onChange={(e) => { setFrame(e.target.checked); replay() }} />
              frame
            </label>
            <button onClick={replay} style={tabStyle}>Replay</button>
            <button onClick={() => setExiting(true)} style={tabStyle}>Exit ⬇</button>
          </div>
        )}
        {view !== 'celebrate' && (
          <span style={{ marginLeft: 'auto', fontSize: 12, opacity: 0.7 }}>drag handles • press d on Celebrate for hulls</span>
        )}
      </nav>

      <div style={stageStyle}>
        {view === 'celebrate' && (
          <CelebrateBubbles key={`cb-${nonce}-${frame}`} frame={frame} exiting={exiting} />
        )}
        {view === 'editor' && (
          <div key="editor" style={{ position: 'absolute', inset: 0, paddingTop: NAV_H, boxSizing: 'border-box' }}>
            <GlyphHullEditor />
          </div>
        )}
        {view === 'lab' && <GlyphHullLab key="lab" />}
      </div>
    </>
  )
}

const NAV_H = 48

const navStyle: CSSProperties = {
  position: 'fixed',
  top: 0,
  left: 0,
  right: 0,
  height: NAV_H,
  zIndex: 1000,
  display: 'flex',
  alignItems: 'center',
  gap: 14,
  padding: '0 14px',
  boxSizing: 'border-box',
  background: 'rgba(255,255,255,0.86)',
  backdropFilter: 'blur(8px)',
  borderBottom: '1px solid #e2e7f0',
  fontFamily: 'system-ui, sans-serif',
  fontSize: 14,
  color: '#1f2433',
}

const tabStyle: CSSProperties = {
  padding: '6px 12px',
  fontSize: 13,
  borderRadius: 6,
  border: '1px solid #d4dae6',
  background: '#fff',
  color: '#1f2433',
  cursor: 'pointer',
}

const tabActive: CSSProperties = {
  border: '1px solid #4d9de0',
  background: '#eef4ff',
  fontWeight: 700,
}

const chkStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  fontSize: 13,
}

const stageStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
}

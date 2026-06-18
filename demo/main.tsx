import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../src/styles.css' // registers the vendored "Cherry Bomb One" face
import './demo.css'
import { DemoApp } from './DemoApp'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <DemoApp />
  </StrictMode>,
)

import { Profiler, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

// VITE_MEASURE=1 builds count React commits for scripts/measure.mjs.
const measured = import.meta.env.VITE_MEASURE === '1'
if (measured) window.__reactCommitCount = 0
const countCommit = () => { window.__reactCommitCount++ }
const app = measured ? <Profiler id="app" onRender={countCommit}><App /></Profiler> : <App />
createRoot(document.getElementById('root')).render(<StrictMode>{app}</StrictMode>)

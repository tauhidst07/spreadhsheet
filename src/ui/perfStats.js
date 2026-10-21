// Lightweight runtime counters shown in the status bar: how often the grid
// commits, and the delay from a keystroke to the next animation frame (the
// frame that paints the keystroke). Mutated only from effects and event
// listeners, never during render.
export const perfStats = {
    gridCommits: 0,
    lastKeyMs: null,
    maxKeyMs: 0,
    keyCount: 0,
}

const listeners = new Set()

export function subscribePerf(fn) {
    listeners.add(fn)
    return () => listeners.delete(fn)
}

function notify() {
    for (const fn of listeners) fn()
}

export function noteGridCommit() {
    perfStats.gridCommits++
}

/** Installs a capture-phase keydown listener measuring keydown → next frame. */
export function installKeyLatencyProbe() {
    const onKey = (e) => {
        if (e.key.length !== 1 && e.key !== 'Backspace') return
        const start = e.timeStamp
        requestAnimationFrame(() => {
            const ms = performance.now() - start
            perfStats.lastKeyMs = ms
            perfStats.keyCount++
            if (ms > perfStats.maxKeyMs) perfStats.maxKeyMs = ms
            notify()
        })
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
}

export function resetKeyStats() {
    perfStats.lastKeyMs = null
    perfStats.maxKeyMs = 0
    perfStats.keyCount = 0
    notify()
}

// The text being edited lives outside React state of the grid so that a
// keystroke only re-renders the two subscribers (cell editor and formula
// bar), never the grid. Used with useSyncExternalStore.
export function createEditStore() {
    let text = ''
    const listeners = new Set()
    return {
        get: () => text,
        set(next) {
            if (next === text) return
            text = next
            for (const l of listeners) l()
        },
        subscribe(listener) {
            listeners.add(listener)
            return () => listeners.delete(listener)
        },
    }
}

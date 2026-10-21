// ─────────────────────────────────────────────────────────────
//  Grid geometry: prefix sums of row heights / column widths and
//  binary search from a pixel offset back to an index. Pure.
// ─────────────────────────────────────────────────────────────

/** offsets[i] = sum of sizes[0..i-1]; length n + 1. */
export function prefixSums(n, sizeAt) {
    const offsets = new Float64Array(n + 1)
    for (let i = 0; i < n; i++) offsets[i + 1] = offsets[i] + sizeAt(i)
    return offsets
}

/**
 * Largest i with offsets[i] <= x and a non-zero size (hidden rows have
 * size 0 and are skipped), clamped to [0, n-1].
 */
export function indexAt(offsets, x) {
    const n = offsets.length - 1
    if (n <= 0) return 0
    if (x <= 0) return firstVisibleFrom(offsets, 0)
    if (x >= offsets[n]) return lastVisibleBefore(offsets, n - 1)
    let lo = 0, hi = n - 1
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1
        if (offsets[mid] <= x) lo = mid
        else hi = mid - 1
    }
    // offsets[lo] <= x < offsets[lo+1] holds only for a visible index; equal
    // neighbouring offsets (hidden rows) resolve to the last of them, which is visible.
    return lo
}

function firstVisibleFrom(offsets, i) {
    const n = offsets.length - 1
    while (i < n - 1 && offsets[i + 1] === offsets[i]) i++
    return i
}

function lastVisibleBefore(offsets, i) {
    while (i > 0 && offsets[i + 1] === offsets[i]) i--
    return i
}

/** Visible index window [start, end] for a viewport, with overscan. */
export function visibleWindow(offsets, from, scroll, viewport, overscan) {
    const base = offsets[from]
    const start = Math.max(from, indexAt(offsets, base + scroll) - overscan)
    const end = Math.min(offsets.length - 2, indexAt(offsets, base + scroll + viewport) + overscan)
    return [start, Math.max(start, end)]
}

export function sizeOf(offsets, i) {
    return offsets[i + 1] - offsets[i]
}

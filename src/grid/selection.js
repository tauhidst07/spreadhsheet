// Selection helpers shared by the grid and the app shell.

export function selectionRange(sel) {
    return {
        r1: Math.min(sel.anchor.r, sel.head.r), r2: Math.max(sel.anchor.r, sel.head.r),
        c1: Math.min(sel.anchor.c, sel.head.c), c2: Math.max(sel.anchor.c, sel.head.c),
    }
}

/** Where the fill handle drag ends up: extend along the dominant axis, or shrink. */
export function fillTarget(src, cell) {
    const down = cell.r - src.r2, up = src.r1 - cell.r
    const right = cell.c - src.c2, left = src.c1 - cell.c
    const vertical = Math.max(down, up, 0)
    const horizontal = Math.max(right, left, 0)
    if (vertical === 0 && horizontal === 0) {
        // Inside the selection: dragging back shrinks it.
        const shrinkRows = src.r2 - cell.r
        const shrinkCols = src.c2 - cell.c
        if (shrinkRows > 0 && shrinkRows >= shrinkCols) return { ...src, r2: cell.r }
        if (shrinkCols > 0) return { ...src, c2: cell.c }
        return src
    }
    if (vertical >= horizontal) return down > 0 ? { ...src, r2: cell.r } : { ...src, r1: cell.r }
    return right > 0 ? { ...src, c2: cell.c } : { ...src, c1: cell.c }
}


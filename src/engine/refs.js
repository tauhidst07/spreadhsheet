// ─────────────────────────────────────────────────────────────
//  A1-notation helpers. Positions are 0-based everywhere.
// ─────────────────────────────────────────────────────────────

export function columnLabel(col) {
    let label = ''
    let n = col + 1
    while (n > 0) {
        n--
        label = String.fromCharCode(65 + (n % 26)) + label
        n = Math.floor(n / 26)
    }
    return label
}

export function columnIndex(letters) {
    let index = 0
    for (let i = 0; i < letters.length; i++) index = index * 26 + (letters.charCodeAt(i) - 64)
    return index - 1
}

export function cellLabel(row, col) {
    return columnLabel(col) + (row + 1)
}

/** "B7" → { row: 6, col: 1 }; accepts `$` markers and lower case. */
export function parseCellLabel(text) {
    const m = String(text).trim().toUpperCase().match(/^\$?([A-Z]{1,4})\$?(\d{1,7})$/)
    if (!m) return null
    const row = parseInt(m[2], 10) - 1
    if (row < 0) return null
    return { row, col: columnIndex(m[1]) }
}

/** "A1:C5" or "B2" → normalised { r1, c1, r2, c2 }. */
export function parseRangeLabel(text) {
    const parts = String(text).split(':')
    if (parts.length > 2) return null
    const a = parseCellLabel(parts[0])
    const b = parts.length === 2 ? parseCellLabel(parts[1]) : a
    if (!a || !b) return null
    return normRange({ r1: a.row, c1: a.col, r2: b.row, c2: b.col })
}

export function normRange({ r1, c1, r2, c2 }) {
    return { r1: Math.min(r1, r2), c1: Math.min(c1, c2), r2: Math.max(r1, r2), c2: Math.max(c1, c2) }
}

export function rangeLabel({ r1, c1, r2, c2 }) {
    const a = cellLabel(r1, c1)
    return r1 === r2 && c1 === c2 ? a : `${a}:${cellLabel(r2, c2)}`
}

export function rangeContains(range, row, col) {
    return row >= range.r1 && row <= range.r2 && col >= range.c1 && col <= range.c2
}

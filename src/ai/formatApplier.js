// ─────────────────────────────────────────────────────────────
//  format_sheet applier, split in two:
//    planFormat()  — pure: action + sheet reader → the exact changes
//    applyFormat() — writes a plan through the engine as ONE undo step
//  Rules: AI_CONTRACT.md §4 (order of application is load-bearing).
// ─────────────────────────────────────────────────────────────
import { DEFAULT_STYLE, looksLikeTotalsRow, compactStyle, MIN_COL_WIDTH, MAX_COL_WIDTH } from '../engine/core.js'
import { formatForDisplay } from '../engine/values.js'

const STYLE_KEYS = Object.keys(DEFAULT_STYLE)

function same(a, b) {
    const x = compactStyle(a), y = compactStyle(b)
    if (x === y) return true
    if (!x || !y) return false
    return STYLE_KEYS.every(k => x[k] === y[k])
}

/**
 * `sheet` is a reader: { getUsedRange(), getText(r,c), getStyle(r,c),
 * getColWidth(c), frozenRows }. `measure(text, style)` → px, used only
 * for autoFitColumns. Returns
 *   { status: 'OK' | 'NO_CHANGES' | 'OUT_OF_RANGE', message,
 *     styles: [[row, col, style]], widths: [[col, px]], freezeRows?: number,
 *     totalsRow: row | null, totalsDropped: boolean }
 */
export function planFormat(action, sheet, measure = null) {
    const used = sheet.getUsedRange()
    const empty = { styles: [], widths: [], totalsRow: null, totalsDropped: false }
    if (!used) return { ...empty, status: 'NO_CHANGES', message: 'The sheet is empty; nothing to format.' }

    const headerRow = used.r1
    const lastRow = used.r2
    const colCount = used.c2 - used.c1 + 1
    const usedRowCount = lastRow - headerRow + 1
    const bodyRows = lastRow > headerRow ? [headerRow + 1, lastRow] : null

    // §4.5 — refuse a freeze that would freeze every used row, before anything else.
    if (typeof action.freezeRows === 'number' && action.freezeRows >= usedRowCount) {
        return {
            ...empty,
            status: 'OUT_OF_RANGE',
            message: `Freezing ${action.freezeRows} rows would freeze the whole table (${usedRowCount} rows). Nothing was changed.`,
        }
    }

    // §4.2 — totals row: last used row, if it looks like one.
    const lastTexts = []
    for (let c = used.c1; c <= used.c2; c++) lastTexts.push(sheet.getText(lastRow, c))
    const totalsRow = bodyRows && looksLikeTotalsRow(lastTexts, { allowSummaryLine: true }) ? lastRow : null

    // Working copy of every style in the used range.
    const work = new Map()
    const k = (r, c) => r * 65536 + c
    const get = (r, c) => work.has(k(r, c)) ? work.get(k(r, c)) : sheet.getStyle(r, c)
    const merge = (r, c, patch) => work.set(k(r, c), { ...DEFAULT_STYLE, ...get(r, c), ...patch })
    const eachCol = (fn) => { for (let c = used.c1; c <= used.c2; c++) fn(c) }
    const eachBody = (fn) => { if (bodyRows) for (let r = bodyRows[0]; r <= bodyRows[1]; r++) fn(r) }

    // §4.3 order: clear → body → columns → totals → header (last, so it wins).
    if (action.clearFormatting) {
        for (let r = headerRow; r <= lastRow; r++) eachCol(c => work.set(k(r, c), { ...DEFAULT_STYLE }))
    }
    if (action.bodyStyle) eachBody(r => eachCol(c => merge(r, c, action.bodyStyle)))
    for (const entry of action.columns ?? []) {
        if (entry.col < 0 || entry.col >= colCount) continue // §4.4 — never outside the used range
        const c = used.c1 + entry.col
        eachBody(r => merge(r, c, entry.style))
    }
    const totalsDropped = !!action.totalsStyle && totalsRow === null
    if (action.totalsStyle && totalsRow !== null) eachCol(c => merge(totalsRow, c, action.totalsStyle))
    if (action.headerStyle) {
        const { numberFormat: _ignored, ...header } = action.headerStyle // the header is never number-formatted
        eachCol(c => merge(headerRow, c, header))
    }

    const styles = []
    for (const [key, style] of work) {
        const r = Math.floor(key / 65536), c = key % 65536
        if (!same(style, sheet.getStyle(r, c))) styles.push([r, c, style])
    }

    // Widths: explicit ones first, then auto-fit over the final styles (§4.6).
    const widthMap = new Map()
    for (const { col, width } of action.columnWidths ?? []) {
        if (col < 0 || col >= colCount || width < MIN_COL_WIDTH || width > MAX_COL_WIDTH) continue
        widthMap.set(used.c1 + col, width)
    }
    if (action.autoFitColumns && measure) {
        eachCol(c => {
            let best = 0
            for (let r = headerRow; r <= lastRow; r++) {
                const style = get(r, c)
                const text = formatForDisplay(sheet.getText(r, c), style.numberFormat)
                if (text !== '') best = Math.max(best, measure(text, style))
            }
            widthMap.set(c, Math.max(MIN_COL_WIDTH, Math.min(MAX_COL_WIDTH, Math.ceil(best + 12))))
        })
    }
    const widths = [...widthMap].filter(([c, w]) => sheet.getColWidth(c) !== w)

    let freezeRows
    if (typeof action.freezeRows === 'number' && action.freezeRows !== sheet.frozenRows) freezeRows = action.freezeRows

    const changed = styles.length > 0 || widths.length > 0 || freezeRows !== undefined
    return {
        status: changed ? 'OK' : 'NO_CHANGES',
        message: changed ? null : 'Nothing to change: the sheet already looks like that (or the request is outside the table).',
        styles, widths, freezeRows, totalsRow, totalsDropped,
    }
}

/** Applies a plan from planFormat() as a single undo step. */
export function applyFormat(engine, plan) {
    if (plan.status !== 'OK') return plan.status
    engine.batch('AI format', () => {
        if (plan.styles.length) engine.setStyles(plan.styles, 'AI format')
        for (const [col, width] of plan.widths) engine.setColWidth(col, width)
        if (plan.freezeRows !== undefined) engine.setFrozen(plan.freezeRows)
    })
    return 'OK'
}

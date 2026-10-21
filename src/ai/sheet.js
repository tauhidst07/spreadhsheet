// ─────────────────────────────────────────────────────────────
//  Reading the sheet for the AI features: the table the executor
//  runs over, and the (small) context the model is allowed to see.
//  Pure functions over an engine-like reader; no React.
// ─────────────────────────────────────────────────────────────
import { rangeLabel } from '../engine/refs.js'
import { toNum, toDate, norm } from '../engine/values.js'
import { dataRows } from './executor.js'

/**
 * Computed cell text of the used range: row 1 of it is the header.
 * `engine` needs getUsedRange() and getText(row, col).
 */
export function readTable(engine) {
    const used = engine.getUsedRange()
    if (!used) return { columns: [], rows: [], range: null }
    const columns = []
    for (let c = used.c1; c <= used.c2; c++) columns.push(engine.getText(used.r1, c))
    const rows = []
    for (let r = used.r1 + 1; r <= used.r2; r++) {
        const row = new Array(used.c2 - used.c1 + 1)
        for (let c = used.c1; c <= used.c2; c++) row[c - used.c1] = engine.getText(r, c)
        rows.push(row)
    }
    return { columns, rows, range: used }
}

/** number | currency | percent | date | text | id, from the non-empty values of a column. */
export function inferColumnType(name, values) {
    const filled = values.map(v => String(v ?? '').trim()).filter(v => v !== '')
    if (filled.length === 0) return 'text'
    const share = (pred) => filled.filter(pred).length / filled.length
    if (/\bid$/i.test(name.trim()) || (share(v => /^[A-Z]{2,}-?\d+$/i.test(v)) > 0.9)) return 'id'
    if (share(v => toDate(v) !== null) > 0.8) return 'date'
    const numeric = share(v => toNum(v) !== null)
    if (numeric > 0.8) {
        if (share(v => v.includes('$')) > 0.5) return 'currency'
        if (share(v => v.endsWith('%')) > 0.3) return 'percent'
        return 'number'
    }
    return 'text'
}

function examples(values, n = 3) {
    const out = []
    const seen = new Set()
    for (const v of values) {
        const t = String(v ?? '')
        if (t.trim() === '' || seen.has(norm(t))) continue
        seen.add(norm(t))
        out.push(t)
        if (out.length === n) break
    }
    return out
}

/**
 * The only sheet information sent to a model: headers, inferred types,
 * a few examples, five sample rows, the row count and the selection.
 * Never the full data.
 */
export function buildContext(table, selection = null) {
    if (!table.range) return { range: null, rowCount: 0, columns: [], sampleRows: [], selection: null, hasTotalsRow: false }
    const body = dataRows(table, true)
    const hasTotalsRow = body.length < table.rows.filter(r => r.some(c => String(c).trim() !== '')).length
    const sampleSize = Math.min(body.length, 200) // type inference only; not sent
    const columns = table.columns.map((name, index) => {
        const vals = []
        for (let i = 0; i < sampleSize; i++) vals.push(body[i][index])
        return { name, index, type: inferColumnType(name, vals), examples: examples(vals) }
    })
    return {
        range: rangeLabel(table.range),
        rowCount: table.rows.length,
        columns,
        sampleRows: body.slice(0, 5),
        selection: selection ? rangeLabel(selection) : null,
        hasTotalsRow,
    }
}

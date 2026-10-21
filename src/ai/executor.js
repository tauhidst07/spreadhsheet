// ─────────────────────────────────────────────────────────────
//  Query executor: runs a validated `query` plan over a table of
//  computed cell text. Pure; follows AI_CONTRACT.md §3 exactly.
//
//  table = { columns: string[], rows: string[][] }  (header excluded)
// ─────────────────────────────────────────────────────────────
import { FILTER_OPS, AGGREGATE_FNS, MAX_RESULT_ROWS } from './contract.js'
import { norm, toNum, toDate, isTotalsLabel } from '../engine/values.js'

class QueryError extends Error {
    constructor(code, detail) {
        super(detail)
        this.code = code
        this.detail = detail
    }
}

const round2 = (n) => (n === null ? null : Math.round(n * 100) / 100)

function columnResolver(columns) {
    const index = new Map()
    columns.forEach((name, i) => {
        const key = norm(name)
        if (key !== '' && !index.has(key)) index.set(key, i)
    })
    return (name) => {
        const i = index.get(norm(name))
        if (i === undefined) throw new QueryError('UNKNOWN_COLUMN', `UNKNOWN_COLUMN:${name}`)
        return i
    }
}

function matches(op, cell, value) {
    switch (op) {
        case 'eq':
        case 'neq': {
            const a = toNum(cell), b = toNum(value)
            const equal = a !== null && b !== null ? a === b : norm(cell) === norm(value)
            return op === 'eq' ? equal : !equal
        }
        case 'gt': case 'gte': case 'lt': case 'lte': {
            const dv = typeof value === 'string' ? toDate(value) : null
            let a, b
            if (dv) {
                a = toDate(cell); b = dv
                if (a === null) return false
            } else {
                a = toNum(cell); b = toNum(value)
                if (a === null || b === null) return false
            }
            if (op === 'gt') return a > b
            if (op === 'gte') return a >= b
            if (op === 'lt') return a < b
            return a <= b
        }
        case 'contains': return norm(cell).includes(norm(value))
        case 'startsWith': return norm(cell).startsWith(norm(value))
        case 'endsWith': return norm(cell).endsWith(norm(value))
        case 'isEmpty': return norm(cell) === ''
        case 'notEmpty': return norm(cell) !== ''
        default: throw new QueryError('UNKNOWN_OP', `UNKNOWN_OP:${op}`)
    }
}

function aggregate(fn, cells) {
    switch (fn) {
        case 'count': return cells.reduce((n, c) => n + (String(c ?? '').trim() !== '' ? 1 : 0), 0)
        case 'countDistinct': {
            const seen = new Set()
            for (const c of cells) { const k = norm(c); if (k !== '') seen.add(k) }
            return seen.size
        }
        default: {
            let sum = 0, count = 0, min = Infinity, max = -Infinity
            for (const c of cells) {
                const n = toNum(c)
                if (n === null) continue
                sum += n; count++
                if (n < min) min = n
                if (n > max) max = n
            }
            if (count === 0) return null
            if (fn === 'sum') return sum
            if (fn === 'avg') return sum / count
            if (fn === 'min') return min
            if (fn === 'max') return max
            throw new QueryError('UNKNOWN_FN', `UNKNOWN_FN:${fn}`)
        }
    }
}

/** Numbers first (numerically), then everything else by norm(); `dir` flips within a class. */
function compareCells(a, b, dir) {
    const na = typeof a === 'number' ? a : toNum(a)
    const nb = typeof b === 'number' ? b : toNum(b)
    const sign = dir === 'desc' ? -1 : 1
    if (na !== null && nb !== null) return na < nb ? -sign : na > nb ? sign : 0
    if (na !== null) return -1
    if (nb !== null) return 1
    const ta = norm(a), tb = norm(b)
    return ta < tb ? -sign : ta > tb ? sign : 0
}

function sortRows(rows, keys) {
    if (!keys.length) return rows
    return rows
        .map((row, i) => ({ row, i }))
        .sort((x, y) => {
            for (const { index, dir } of keys) {
                const c = compareCells(x.row[index], y.row[index], dir)
                if (c !== 0) return c
            }
            return x.i - y.i
        })
        .map(x => x.row)
}

/** Data rows the plan runs over: blank rows skipped, totals row optionally excluded. */
export function dataRows(table, excludeTotalsRow = true) {
    let rows = table.rows
    if (excludeTotalsRow && rows.length) {
        const last = rows[rows.length - 1]
        const first = last.find(c => String(c ?? '').trim() !== '')
        if (first !== undefined && isTotalsLabel(first)) rows = rows.slice(0, -1)
    }
    return rows.filter(row => row.some(c => String(c ?? '').trim() !== ''))
}

/**
 * Runs a plan. Returns { columns, rows, rowCount, truncated } or
 * { error, detail } — it never throws.
 */
export function executeQuery(plan, table) {
    try {
        return run(plan, table)
    } catch (e) {
        if (e instanceof QueryError) return { error: e.code, detail: e.detail }
        throw e
    }
}

function run(plan, table) {
    if (plan.type !== 'query') throw new QueryError('READ_ONLY', 'READ_ONLY')
    const col = columnResolver(table.columns)
    const filters = (plan.filters ?? []).map(f => {
        if (!FILTER_OPS.includes(f.op)) throw new QueryError('UNKNOWN_OP', `UNKNOWN_OP:${f.op}`)
        return { index: col(f.column), op: f.op, value: f.value }
    })
    const groupBy = (plan.groupBy ?? []).map(name => ({ name, index: col(name) }))
    const aggregates = (plan.aggregates ?? []).map(a => {
        if (!AGGREGATE_FNS.includes(a.fn)) throw new QueryError('UNKNOWN_FN', `UNKNOWN_FN:${a.fn}`)
        return { fn: a.fn, index: col(a.column), as: a.as ?? `${a.fn}(${a.column})` }
    })
    const projected = plan.columns ? plan.columns.map(name => ({ name, index: col(name) })) : null
    const limitRequested = plan.limit ?? MAX_RESULT_ROWS
    const limit = Math.max(1, Math.min(MAX_RESULT_ROWS, Math.floor(limitRequested)))

    let rows = dataRows(table, plan.excludeTotalsRow !== false)
    if (filters.length) rows = rows.filter(row => filters.every(f => matches(f.op, row[f.index] ?? '', f.value)))

    let columns, out
    if (groupBy.length || aggregates.length) {
        columns = [...groupBy.map(g => table.columns[g.index].trim()), ...aggregates.map(a => a.as)]
        const groups = new Map()
        for (const row of rows) {
            const key = groupBy.map(g => norm(row[g.index])).join('\u0000')
            let g = groups.get(key)
            if (!g) groups.set(key, g = { label: groupBy.map(gb => String(row[gb.index] ?? '').trim()), rows: [] })
            g.rows.push(row)
        }
        if (!groupBy.length && groups.size === 0) groups.set('', { label: [], rows: [] })
        out = [...groups.values()].map(g => [
            ...g.label,
            ...aggregates.map(a => aggregate(a.fn, g.rows.map(r => r[a.index] ?? ''))),
        ])
        const outIndex = columnResolver(columns)
        const keys = (plan.sort ?? []).map(s => {
            try { return { index: outIndex(s.column), dir: s.dir ?? 'asc' } } catch {
                throw new QueryError('UNKNOWN_SORT_COLUMN', `UNKNOWN_SORT_COLUMN:${s.column}`)
            }
        })
        out = sortRows(out, keys).map(row => row.map(v => (typeof v === 'number' ? round2(v) : v)))
    } else {
        const keys = (plan.sort ?? []).map(s => {
            try { return { index: col(s.column), dir: s.dir ?? 'asc' } } catch {
                throw new QueryError('UNKNOWN_SORT_COLUMN', `UNKNOWN_SORT_COLUMN:${s.column}`)
            }
        })
        const sorted = sortRows(rows, keys)
        const pick = projected ?? table.columns.map((name, index) => ({ name, index }))
        columns = pick.map(p => table.columns[p.index])
        out = sorted.map(row => pick.map(p => row[p.index] ?? ''))
    }

    const truncated = out.length > limit
    if (truncated) out = out.slice(0, limit)
    return { columns, rows: out, rowCount: out.length, truncated }
}

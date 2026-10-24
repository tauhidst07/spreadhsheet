// ─────────────────────────────────────────────────────────────
//  AI Query executor — pure JS, no DOM/React.
//  Implements the semantics in AI_CONTRACT.md §3 exactly.
//  All computation happens here; no number comes from the model.
// ─────────────────────────────────────────────────────────────

import { toNum, toDate } from '../engine/core.js'
import { MAX_RESULT_ROWS } from './contract.js'

// ── Normalisation helpers ──

/** norm(v): trim + lowercase for text comparison */
function norm(v) {
    return String(v === null || v === undefined ? '' : v).trim().toLowerCase()
}

// ── Filter operations ──

function applyFilterOp(cellVal, op, filterVal) {
    const cn = norm(cellVal)
    const fv = filterVal === null || filterVal === undefined ? '' : String(filterVal)
    const fn = norm(fv)

    switch (op) {
        case 'eq': {
            const cv = toNum(String(cellVal ?? ''))
            const fvn = toNum(fv)
            if (cv !== null && fvn !== null) return cv === fvn
            return cn === fn
        }
        case 'neq': {
            const cv = toNum(String(cellVal ?? ''))
            const fvn = toNum(fv)
            if (cv !== null && fvn !== null) return cv !== fvn
            return cn !== fn
        }
        case 'gt': {
            // date or number
            const fd = toDate(fv)
            if (fd) { const cd = toDate(String(cellVal ?? '')); return cd ? cd > fd : false }
            const cv = toNum(String(cellVal ?? '')), fvn = toNum(fv)
            if (cv === null || fvn === null) return false
            return cv > fvn
        }
        case 'gte': {
            const fd = toDate(fv)
            if (fd) { const cd = toDate(String(cellVal ?? '')); return cd ? cd >= fd : false }
            const cv = toNum(String(cellVal ?? '')), fvn = toNum(fv)
            if (cv === null || fvn === null) return false
            return cv >= fvn
        }
        case 'lt': {
            const fd = toDate(fv)
            if (fd) { const cd = toDate(String(cellVal ?? '')); return cd ? cd < fd : false }
            const cv = toNum(String(cellVal ?? '')), fvn = toNum(fv)
            if (cv === null || fvn === null) return false
            return cv < fvn
        }
        case 'lte': {
            const fd = toDate(fv)
            if (fd) { const cd = toDate(String(cellVal ?? '')); return cd ? cd <= fd : false }
            const cv = toNum(String(cellVal ?? '')), fvn = toNum(fv)
            if (cv === null || fvn === null) return false
            return cv <= fvn
        }
        case 'contains': return cn.includes(fn)
        case 'startsWith': return cn.startsWith(fn)
        case 'endsWith': return cn.endsWith(fn)
        case 'isEmpty': return cn === ''
        case 'notEmpty': return cn !== ''
        default: return true
    }
}

// ── Aggregate helpers ──

function aggregate(fn, values) {
    // values: Array of cell string values
    const nums = values.map(v => toNum(String(v ?? ''))).filter(n => n !== null)
    switch (fn) {
        case 'sum': return nums.length === 0 ? null : nums.reduce((a, b) => a + b, 0)
        case 'avg': return nums.length === 0 ? null : nums.reduce((a, b) => a + b, 0) / nums.length
        case 'count': return values.filter(v => String(v ?? '').trim() !== '').length
        case 'countDistinct': return new Set(values.map(v => norm(v)).filter(x => x !== '')).size
        case 'min': return nums.length === 0 ? null : Math.min(...nums)
        case 'max': return nums.length === 0 ? null : Math.max(...nums)
        default: return null
    }
}

// ── Sort comparison ──

function compareValues(a, b) {
    // Numbers before text, blanks last
    const an = toNum(String(a ?? ''))
    const bn = toNum(String(b ?? ''))
    const aBlank = String(a ?? '').trim() === ''
    const bBlank = String(b ?? '').trim() === ''
    if (aBlank && bBlank) return 0
    if (aBlank) return 1
    if (bBlank) return -1
    if (an !== null && bn !== null) return an - bn
    if (an !== null) return -1
    if (bn !== null) return 1
    // Date comparison
    const ad = toDate(String(a ?? '')), bd = toDate(String(b ?? ''))
    if (ad && bd) return ad < bd ? -1 : ad > bd ? 1 : 0
    return norm(a).localeCompare(norm(b))
}

// ─────────────────────────────────────────────────────────────
//  Main executor
// ─────────────────────────────────────────────────────────────

/**
 * Execute a validated query plan over sheet data.
 *
 * @param {object} plan  - Validated query plan (QUERY_PLAN_SCHEMA)
 * @param {object} engine - The spreadsheet engine
 * @returns {{ columns, rows, rowCount, truncated } | { error, detail }}
 */
export function executeQuery(plan, engine) {
    try {
        if (!plan || plan.type !== 'query') {
            return { error: 'READ_ONLY', detail: 'Only query actions can be executed against the sheet' }
        }
        const used = engine.getUsedRange()
        if (!used) return { columns: [], rows: [], rowCount: 0, truncated: false }

        const { startRow, endRow, startCol, endCol } = used

        // Prefer a row that actually looks like headers (e.g. contains "Region")
        let headerRowIndex = startRow
        const scanEnd = Math.min(endRow, startRow + 5)
        for (let r = startRow; r <= scanEnd; r++) {
            const names = []
            for (let c = startCol; c <= endCol; c++) {
                names.push(norm(engine.getCellRaw(r, c).raw ?? ''))
            }
            if (names.includes('region') || names.includes('order id') || names.includes('total')) {
                headerRowIndex = r
                break
            }
        }

        const headerRow = []
        for (let c = startCol; c <= endCol; c++) {
            const raw = engine.getCellRaw(headerRowIndex, c).raw ?? ''
            headerRow.push(raw.trim())
        }

        // Build column name → index mapping (case-insensitive)
        const colMap = new Map() // norm(name) → colIndex (0-based within used range)
        for (let i = 0; i < headerRow.length; i++) {
            colMap.set(norm(headerRow[i]), i)
        }

        function resolveCol(name) {
            const idx = colMap.get(norm(name))
            if (idx === undefined) {
                const available = headerRow.filter(Boolean).join(', ') || '(none)'
                return {
                    error: 'UNKNOWN_COLUMN',
                    detail: `Column "${name}" was not found. Available: ${available}. Click "Sample 3k" then ask again.`,
                }
            }
            return { idx }
        }

        // ── Validate all column names in plan ──
        const allPlanCols = new Set()
        for (const f of plan.filters || []) allPlanCols.add(f.column)
        for (const g of plan.groupBy || []) allPlanCols.add(g)
        for (const a of plan.aggregates || []) allPlanCols.add(a.column)
        for (const c of plan.columns || []) allPlanCols.add(c)

        for (const colName of allPlanCols) {
            const res = resolveCol(colName)
            if (res.error) return res
        }

        // ── Read data rows ──
        const isTotals = engine.isTotalsRow(endRow)
        const excludeTotals = plan.excludeTotalsRow !== false  // default true

        const dataEnd = isTotals && excludeTotals ? endRow - 1 : endRow
        const colCount = endCol - startCol + 1
        const dataRows = []
        for (let r = headerRowIndex + 1; r <= dataEnd; r++) {
            let allEmpty = true
            const row = new Array(colCount)
            for (let c = startCol; c <= endCol; c++) {
                const raw = engine.getCellRaw(r, c).raw ?? ''
                let v = raw
                if (raw.startsWith('=')) {
                    const computed = engine.getComputedRange(r, c, r, c)[0][0]
                    v = computed !== '' && computed !== null && computed !== undefined ? computed : raw
                }
                row[c - startCol] = v
                if (String(v ?? '').trim() !== '') allEmpty = false
            }
            if (allEmpty) continue
            dataRows.push(row)
        }

        // ── Apply filters (AND) ──
        let filtered = dataRows
        if (plan.filters && plan.filters.length > 0) {
            filtered = dataRows.filter(row => {
                for (const f of plan.filters) {
                    const { idx } = resolveCol(f.column)
                    const cellVal = row[idx]
                    if (!applyFilterOp(cellVal, f.op, f.value)) return false
                }
                return true
            })
        }

        // ── Group-by + aggregates ──
        let result
        let resultCols

        if (plan.groupBy && plan.groupBy.length > 0) {
            const groupColIndices = plan.groupBy.map(g => resolveCol(g).idx)
            const aggDefs = plan.aggregates || []

            // Build group map: groupKey → { firstLabel[], aggValues[][] }
            const groupMap = new Map()
            const groupOrder = []

            for (const row of filtered) {
                const key = groupColIndices.map(i => norm(row[i])).join('\x00')
                if (!groupMap.has(key)) {
                    groupMap.set(key, {
                        labels: groupColIndices.map(i => String(row[i] ?? '').trim()),
                        aggValues: aggDefs.map(() => []),
                    })
                    groupOrder.push(key)
                }
                const grp = groupMap.get(key)
                aggDefs.forEach((a, ai) => {
                    const { idx } = resolveCol(a.column)
                    grp.aggValues[ai].push(row[idx])
                })
            }

            // Compute aggregate column names
            const aggNames = aggDefs.map(a => a.as || `${a.fn}(${a.column})`)
            resultCols = [...plan.groupBy, ...aggNames]

            result = groupOrder.map(key => {
                const grp = groupMap.get(key)
                const aggResults = aggDefs.map((a, ai) => aggregate(a.fn, grp.aggValues[ai]))
                return [...grp.labels, ...aggResults]
            })

        } else if (plan.aggregates && plan.aggregates.length > 0) {
            const aggDefs = plan.aggregates
            const aggNames = aggDefs.map(a => a.as || `${a.fn}(${a.column})`)
            resultCols = aggNames
            const aggValues = aggDefs.map(() => [])
            for (const row of filtered) {
                aggDefs.forEach((a, ai) => {
                    const { idx } = resolveCol(a.column)
                    aggValues[ai].push(row[idx])
                })
            }
            const aggResults = aggDefs.map((a, ai) => aggregate(a.fn, aggValues[ai]))
            result = [aggResults]
        } else {
            // Row result: project on requested columns
            const projCols = plan.columns && plan.columns.length > 0
                ? plan.columns
                : headerRow
            const projIndices = projCols.map(c => resolveCol(c).idx)
            resultCols = projCols
            result = filtered.map(row => projIndices.map(i => row[i]))
        }

        // ── Sort ──
        if (plan.sort && plan.sort.length > 0) {
            // Map sort column names to result column indices
            const sortEntries = plan.sort.map(s => {
                const ci = resultCols.indexOf(s.column)
                // Also try case-insensitive
                const ci2 = ci === -1 ? resultCols.findIndex(c => norm(c) === norm(s.column)) : ci
                return { colIdx: ci2, dir: s.dir || 'asc' }
            }).filter(s => s.colIdx !== -1)

            result.sort((a, b) => {
                for (const { colIdx, dir } of sortEntries) {
                    const cmp = compareValues(a[colIdx], b[colIdx])
                    if (cmp !== 0) return dir === 'desc' ? -cmp : cmp
                }
                return 0
            })
        }

        // ── Limit (cap at MAX_RESULT_ROWS) ──
        const limit = Math.min(plan.limit ?? MAX_RESULT_ROWS, MAX_RESULT_ROWS)
        const truncated = result.length > limit
        if (truncated) result = result.slice(0, limit)

        // ── Round numbers in results for display ──
        const rounded = result.map(row =>
            row.map(v => {
                if (typeof v === 'number') return Math.round(v * 100) / 100
                return v
            })
        )

        return {
            columns: resultCols,
            rows: rounded,
            rowCount: rounded.length,
            truncated,
        }
    } catch (e) {
        return { error: 'PROVIDER_ERROR', detail: e.message }
    }
}

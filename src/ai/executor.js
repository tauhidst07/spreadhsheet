// ─────────────────────────────────────────────────────────────
//  AI query executor — runs a validated read-only query plan over
//  the sheet's computed values. Pure logic (no React, no DOM).
// ─────────────────────────────────────────────────────────────

import { norm, toNum, toDate } from '../engine/core.js'
import { MAX_RESULT_ROWS } from './contract.js'

/**
 * Executes a validated `query` plan over an engine instance.
 * Returns { columns, rows, rowCount, truncated } or { error, detail }.
 */
export function executeQuery(plan, engine) {
    if (!plan || plan.type !== 'query') {
        return { error: 'READ_ONLY', detail: 'Executor only accepts "query" action type' }
    }

    const used = engine.getUsedRange()
    if (used.rowCount === 0) {
        return { columns: [], rows: [], rowCount: 0, truncated: false }
    }

    // 1. Read header from row 1 (index used.minRow)
    const headerRowIdx = used.minRow
    const headers = []
    const colIndexByName = new Map() // norm(name) -> col index

    for (let c = used.minCol; c <= used.maxCol; c++) {
        const cell = engine.getCell(headerRowIdx, c)
        const name = String(cell.computed !== null && cell.computed !== '' ? cell.computed : cell.raw).trim()
        headers.push(name)
        if (name) {
            colIndexByName.set(norm(name), c)
        }
    }

    // Helper to resolve column index with error handling
    function resolveColumnIndex(colName) {
        if (!colName) return -1
        const key = norm(colName)
        if (colIndexByName.has(key)) return colIndexByName.get(key)
        return -1
    }

    // 2. Validate all referenced column names before execution
    if (plan.filters) {
        for (const f of plan.filters) {
            if (resolveColumnIndex(f.column) === -1) {
                return { error: 'UNKNOWN_COLUMN', detail: `UNKNOWN_COLUMN:${f.column}` }
            }
        }
    }
    if (plan.groupBy) {
        for (const g of plan.groupBy) {
            if (resolveColumnIndex(g) === -1) {
                return { error: 'UNKNOWN_COLUMN', detail: `UNKNOWN_COLUMN:${g}` }
            }
        }
    }
    if (plan.aggregates) {
        for (const a of plan.aggregates) {
            if (resolveColumnIndex(a.column) === -1) {
                return { error: 'UNKNOWN_COLUMN', detail: `UNKNOWN_COLUMN:${a.column}` }
            }
        }
    }
    if (plan.columns) {
        for (const c of plan.columns) {
            if (resolveColumnIndex(c) === -1) {
                return { error: 'UNKNOWN_COLUMN', detail: `UNKNOWN_COLUMN:${c}` }
            }
        }
    }

    // 3. Extract candidate rows (row 2 to used.maxRow)
    const excludeTotals = plan.excludeTotalsRow !== false
    const startRowIdx = headerRowIdx + 1
    let endRowIdx = used.maxRow

    // Check totals row: last used row when first non-empty cell matches regex
    if (excludeTotals && endRowIdx >= startRowIdx) {
        for (let c = used.minCol; c <= used.maxCol; c++) {
            const raw = engine.getCell(endRowIdx, c).raw.trim()
            if (raw) {
                if (/^(grand\s+)?(total|totals|subtotal|sum)\b/i.test(raw)) {
                    endRowIdx--
                }
                break
            }
        }
    }

    // Determine required columns
    const neededCols = new Set()
    if (plan.filters) {
        for (const f of plan.filters) neededCols.add(resolveColumnIndex(f.column))
    }
    if (plan.groupBy) {
        for (const g of plan.groupBy) neededCols.add(resolveColumnIndex(g))
    }
    if (plan.aggregates) {
        for (const a of plan.aggregates) neededCols.add(resolveColumnIndex(a.column))
    }
    if (plan.columns) {
        for (const c of plan.columns) neededCols.add(resolveColumnIndex(c))
    } else if (!plan.aggregates || plan.aggregates.length === 0) {
        for (let c = used.minCol; c <= used.maxCol; c++) neededCols.add(c)
    }
    const neededColsArray = Array.from(neededCols)

    // Read candidate rows
    const sourceRows = []
    for (let r = startRowIdx; r <= endRowIdx; r++) {
        let hasAnyVal = false
        const rowData = []
        for (let i = 0; i < neededColsArray.length; i++) {
            const c = neededColsArray[i]
            const cell = engine.getCell(r, c)
            const val = cell.computed !== null && cell.computed !== '' ? cell.computed : cell.raw
            if (val !== '' && val !== null && val !== undefined) hasAnyVal = true
            rowData[c] = val
        }
        if (hasAnyVal) {
            sourceRows.push({ rowIndex: r, data: rowData })
        }
    }

    // 4. Apply Filters (AND)
    const filteredRows = sourceRows.filter(rowObj => {
        if (!plan.filters || plan.filters.length === 0) return true
        for (const f of plan.filters) {
            const colIdx = resolveColumnIndex(f.column)
            const cellVal = rowObj.data[colIdx] ?? ''
            const op = f.op
            const filterVal = f.value

            if (op === 'isEmpty') {
                if (norm(cellVal) !== '') return false
                continue
            }
            if (op === 'notEmpty') {
                if (norm(cellVal) === '') return false
                continue
            }

            if (op === 'eq' || op === 'neq') {
                const numC = toNum(cellVal)
                const numF = toNum(filterVal)
                let match = false
                if (numC !== null && numF !== null) {
                    match = Math.abs(numC - numF) < 1e-9
                } else {
                    match = norm(cellVal) === norm(filterVal)
                }
                if (op === 'eq' && !match) return false
                if (op === 'neq' && match) return false
                continue
            }

            if (['gt', 'gte', 'lt', 'lte'].includes(op)) {
                const dateF = toDate(filterVal)
                if (dateF !== null) {
                    const dateC = toDate(cellVal)
                    if (dateC === null) return false
                    const cmp = dateC.localeCompare(dateF)
                    if (op === 'gt' && !(cmp > 0)) return false
                    if (op === 'gte' && !(cmp >= 0)) return false
                    if (op === 'lt' && !(cmp < 0)) return false
                    if (op === 'lte' && !(cmp <= 0)) return false
                } else {
                    const numC = toNum(cellVal)
                    const numF = toNum(filterVal)
                    if (numC === null || numF === null) return false
                    if (op === 'gt' && !(numC > numF)) return false
                    if (op === 'gte' && !(numC >= numF)) return false
                    if (op === 'lt' && !(numC < numF)) return false
                    if (op === 'lte' && !(numC <= numF)) return false
                }
                continue
            }

            if (op === 'contains') {
                if (!norm(cellVal).includes(norm(filterVal))) return false
                continue
            }
            if (op === 'startsWith') {
                if (!norm(cellVal).startsWith(norm(filterVal))) return false
                continue
            }
            if (op === 'endsWith') {
                if (!norm(cellVal).endsWith(norm(filterVal))) return false
                continue
            }
        }
        return true
    })

    // 5. Group By & Aggregates OR Raw Row Projection
    const hasGroupBy = plan.groupBy && plan.groupBy.length > 0
    const hasAggregates = plan.aggregates && plan.aggregates.length > 0

    let outputColumns = []
    let outputRows = []

    if (hasGroupBy || hasAggregates) {
        // Output column names
        const groupCols = plan.groupBy || []
        const aggCols = (plan.aggregates || []).map(a => a.as || `${a.fn}(${a.column})`)
        outputColumns = [...groupCols, ...aggCols]

        // Group rows
        // Map: groupKey -> { labels: string[], rows: rowObj[] }
        const groups = new Map()

        for (const rowObj of filteredRows) {
            let key = ''
            const labels = []
            for (const gName of groupCols) {
                const cIdx = resolveColumnIndex(gName)
                const val = rowObj.data[cIdx] ?? ''
                key += (key ? '|||' : '') + norm(val)
                labels.push(String(val).trim())
            }

            if (!groups.has(key)) {
                groups.set(key, { labels, rows: [] })
            }
            groups.get(key).rows.push(rowObj)
        }

        // For each group, compute aggregates
        for (const group of groups.values()) {
            const outRow = [...group.labels]
            if (plan.aggregates) {
                for (const agg of plan.aggregates) {
                    const cIdx = resolveColumnIndex(agg.column)
                    const vals = group.rows.map(r => r.data[cIdx])

                    if (agg.fn === 'count') {
                        const cnt = vals.filter(v => norm(v) !== '').length
                        outRow.push(cnt)
                    } else if (agg.fn === 'countDistinct') {
                        const set = new Set(vals.map(norm).filter(n => n !== ''))
                        outRow.push(set.size)
                    } else if (['sum', 'avg', 'min', 'max'].includes(agg.fn)) {
                        const numVals = vals.map(toNum).filter(n => n !== null)
                        if (numVals.length === 0) {
                            outRow.push(null)
                        } else {
                            if (agg.fn === 'sum') {
                                const sum = numVals.reduce((a, b) => a + b, 0)
                                outRow.push(Math.round(sum * 100) / 100)
                            } else if (agg.fn === 'avg') {
                                const avg = numVals.reduce((a, b) => a + b, 0) / numVals.length
                                outRow.push(Math.round(avg * 100) / 100)
                            } else if (agg.fn === 'min') {
                                const min = Math.min(...numVals)
                                outRow.push(Math.round(min * 100) / 100)
                            } else if (agg.fn === 'max') {
                                const max = Math.max(...numVals)
                                outRow.push(Math.round(max * 100) / 100)
                            }
                        }
                    }
                }
            }
            outputRows.push(outRow)
        }
    } else {
        // Raw row projection (no aggregates, no group by)
        const projColNames = plan.columns && plan.columns.length > 0 ? plan.columns : headers
        outputColumns = [...projColNames]

        for (const rowObj of filteredRows) {
            const rowArr = []
            for (const colName of projColNames) {
                const cIdx = resolveColumnIndex(colName)
                const val = rowObj.data[cIdx] ?? ''
                rowArr.push(val)
            }
            outputRows.push(rowArr)
        }
    }

    // 6. Sort Output
    if (plan.sort && plan.sort.length > 0) {
        // Validate sort columns
        for (const s of plan.sort) {
            const outIdx = outputColumns.findIndex(c => norm(c) === norm(s.column))
            if (outIdx === -1) {
                return { error: 'UNKNOWN_SORT_COLUMN', detail: `Sort column "${s.column}" not found in output columns` }
            }
        }

        outputRows.sort((rowA, rowB) => {
            for (const s of plan.sort) {
                const colIdx = outputColumns.findIndex(c => norm(c) === norm(s.column))
                const valA = rowA[colIdx]
                const valB = rowB[colIdx]

                const numA = toNum(valA)
                const numB = toNum(valB)

                let cmp = 0
                if (numA !== null && numB !== null) {
                    cmp = numA - numB
                } else if (numA !== null && numB === null) {
                    cmp = -1 // numbers before text
                } else if (numA === null && numB !== null) {
                    cmp = 1
                } else {
                    cmp = norm(valA).localeCompare(norm(valB))
                }

                if (cmp !== 0) {
                    return s.dir === 'desc' ? -cmp : cmp
                }
            }
            return 0
        })
    }

    // 7. Limit & Clamping (Capped at 500)
    const effectiveLimit = Math.min(plan.limit || 500, MAX_RESULT_ROWS)
    const totalCount = outputRows.length
    const truncated = totalCount > effectiveLimit
    const finalRows = truncated ? outputRows.slice(0, effectiveLimit) : outputRows

    return {
        columns: outputColumns,
        rows: finalRows,
        rowCount: finalRows.length,
        truncated,
    }
}

/**
 * Generates a human-readable summary of a query plan.
 */
export function describeQueryPlan(plan) {
    if (!plan) return ''
    const parts = []

    if (plan.aggregates && plan.aggregates.length > 0) {
        const aggs = plan.aggregates.map(a => `${a.fn.toUpperCase()} of ${a.column}${a.as ? ` as "${a.as}"` : ''}`).join(', ')
        parts.push(aggs)
    } else if (plan.columns && plan.columns.length > 0) {
        parts.push(`Select ${plan.columns.join(', ')}`)
    } else {
        parts.push('Select all columns')
    }

    if (plan.groupBy && plan.groupBy.length > 0) {
        parts.push(`grouped by ${plan.groupBy.join(', ')}`)
    }

    if (plan.filters && plan.filters.length > 0) {
        const filterStr = plan.filters.map(f => `${f.column} ${f.op} ${f.value !== undefined ? `"${f.value}"` : ''}`).join(' and ')
        parts.push(`where ${filterStr}`)
    }

    if (plan.sort && plan.sort.length > 0) {
        const sortStr = plan.sort.map(s => `${s.column} (${s.dir || 'asc'})`).join(', ')
        parts.push(`sorted by ${sortStr}`)
    }

    if (plan.limit) {
        parts.push(`limit ${plan.limit}`)
    }

    return parts.join(' ')
}

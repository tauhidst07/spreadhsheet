// ─────────────────────────────────────────────────────────────
//  Fill handle logic — pure computation, no DOM/React.
//  Handles: copy, numeric sequences, text+number sequences,
//  date sequences (preserving format), weekday/month cycles,
//  formula fill with absolute reference support.
// ─────────────────────────────────────────────────────────────

import { shiftFormulaForFill, toDate } from '../engine/core.js'

// ── Weekday / Month cycle tables ──
const WEEKDAYS_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const WEEKDAYS_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function matchCycle(value, list) {
    const vl = value.toLowerCase()
    const idx = list.findIndex(x => x.toLowerCase() === vl)
    if (idx === -1) return null
    // Detect case style
    const isUpper = value === value.toUpperCase()
    const isTitle = value[0] === value[0].toUpperCase() && value.slice(1) === value.slice(1).toLowerCase()
    return { idx, list, isUpper, isTitle, original: value }
}

function cycleItem(match, offset) {
    const { list, isUpper, isTitle } = match
    const item = list[(match.idx + offset + list.length * 1000) % list.length]
    if (isUpper) return item.toUpperCase()
    if (isTitle) return item[0].toUpperCase() + item.slice(1).toLowerCase()
    return item.toLowerCase()
}

/**
 * Detect the type and properties of a single seed value.
 */
function detectSeedType(value) {
    if (!value && value !== 0) return { type: 'copy' }
    const s = String(value)

    // Formula
    if (s.startsWith('=')) return { type: 'formula', value: s }

    // Pure integer
    if (/^-?\d+$/.test(s.trim())) return { type: 'number', value: parseFloat(s) }

    // Pure float
    if (/^-?\d*\.\d+$/.test(s.trim())) return { type: 'number', value: parseFloat(s) }

    // Weekday (long)
    let m = matchCycle(s.trim(), WEEKDAYS_LONG)
    if (m) return { type: 'cycle', match: m }
    m = matchCycle(s.trim(), WEEKDAYS_SHORT)
    if (m) return { type: 'cycle', match: m }

    // Month (long)
    m = matchCycle(s.trim(), MONTHS_LONG)
    if (m) return { type: 'cycle', match: m }
    m = matchCycle(s.trim(), MONTHS_SHORT)
    if (m) return { type: 'cycle', match: m }

    // Date
    const d = toDate(s.trim())
    if (d) return { type: 'date', isoDate: d, original: s.trim(), fmt: detectDateFormat(s.trim()) }

    // Text ending in number (ORD-1001, Q4, 2024-W01)
    const textNumMatch = s.match(/^(.*?)(\d+)$/)
    if (textNumMatch && textNumMatch[2]) {
        return {
            type: 'textNum',
            prefix: textNumMatch[1],
            num: parseInt(textNumMatch[2]),
            digits: textNumMatch[2].length,
            padded: textNumMatch[2].length > 1 && textNumMatch[2][0] === '0',
        }
    }

    return { type: 'copy', value: s }
}

function detectDateFormat(s) {
    if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(s)) return 'iso'       // 2024-01-15
    if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s)) return 'us'      // 1/15/2024
    if (/^\d{1,2}\s+[A-Za-z]{3,}\s+\d{4}$/.test(s)) return 'eu' // 15 Jan 2024
    return 'iso'
}

function isoToFormat(isoDate, fmt, originalMonthCase) {
    const [y, mm, dd] = isoDate.split('-')
    if (fmt === 'iso') return `${y}-${mm}-${dd}`
    if (fmt === 'us') return `${parseInt(mm)}/${parseInt(dd)}/${y}`
    if (fmt === 'eu') {
        const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
        let mo = MONTHS[parseInt(mm) - 1]
        // Preserve case from original if possible
        if (originalMonthCase) {
            if (originalMonthCase === originalMonthCase.toUpperCase()) mo = mo.toUpperCase()
            else if (originalMonthCase === originalMonthCase.toLowerCase()) mo = mo.toLowerCase()
        }
        return `${parseInt(dd)} ${mo} ${y}`
    }
    return isoDate
}

function addDays(isoDate, n) {
    const d = new Date(isoDate + 'T00:00:00Z')
    d.setUTCDate(d.getUTCDate() + n)
    const y = d.getUTCFullYear()
    const m = String(d.getUTCMonth() + 1).padStart(2, '0')
    const day = String(d.getUTCDate()).padStart(2, '0')
    return `${y}-${m}-${day}`
}

/**
 * Compute the fill value for a target cell, given the source seed(s).
 *
 * @param {Array<Array<string>>} sourceValues  - 2D array of seed values
 * @param {number} relRow   - target row offset from source top-left
 * @param {number} relCol   - target col offset from source top-left
 * @param {object} seqInfo  - pre-computed sequence info (from analyzeSequence)
 */
function computeFillValue(sourceValues, relRow, relCol, seqInfo) {
    const srcH = sourceValues.length
    const srcW = sourceValues[0]?.length ?? 0
    const patRow = ((relRow % srcH) + srcH) % srcH
    const patCol = ((relCol % srcW) + srcW) % srcW
    const beyond = relRow < 0 || relRow >= srcH || relCol < 0 || relCol >= srcW

    if (seqInfo && beyond) {
        const { type } = seqInfo
        const axisOff = srcW === 1 ? relRow : relCol

        if (type === 'numericCol' && (srcW === 1 ? relCol === 0 : relRow === 0)) {
            return String(seqInfo.firstNum + seqInfo.step * axisOff)
        }

        if (type === 'textNumCol' && (srcW === 1 ? relCol === 0 : relRow === 0)) {
            const { prefix, firstNum, step, digits, padded } = seqInfo
            const next = firstNum + step * axisOff
            const s = String(Math.abs(next))
            const signed = next < 0 ? '-' : ''
            return prefix + signed + (padded ? s.padStart(digits, '0') : s)
        }

        if (type === 'dateCol' && (srcW === 1 ? relCol === 0 : relRow === 0)) {
            const newIso = addDays(seqInfo.firstIso, seqInfo.step * axisOff)
            const fmt = seqInfo.formats[patRow] || seqInfo.formats[0]
            const monthCase = seqInfo.monthCases[patRow]
            return isoToFormat(newIso, fmt, monthCase)
        }

        if (type === 'cycleCol' && (srcW === 1 ? relCol === 0 : relRow === 0)) {
            return cycleItem(seqInfo.match, axisOff)
        }
    }

    const raw = sourceValues[patRow][patCol]
    if (raw && raw.startsWith('=')) {
        const dr = relRow - patRow
        const dc = relCol - patCol
        return shiftFormulaForFill(raw, dr, dc)
    }

    if (srcH === 1 && srcW === 1 && (relRow !== 0 || relCol !== 0)) {
        const off = relRow !== 0 ? relRow : relCol
        const seed = detectSeedType(sourceValues[0][0])
        if (seed.type === 'cycle') return cycleItem(seed.match, off)
        if (seed.type === 'date') return isoToFormat(addDays(seed.isoDate, off), seed.fmt, null)
        if (seed.type === 'textNum') {
            const n = seed.num + off
            const s = String(Math.abs(n))
            const signed = n < 0 ? '-' : ''
            return seed.prefix + signed + (seed.padded ? s.padStart(seed.digits, '0') : s)
        }
    }

    return raw
}

/**
 * Analyze a source range to detect sequence type (for fills beyond the seed).
 * Only handles single-column sources for now.
 */
function analyzeSequence(sourceValues) {
    const h = sourceValues.length
    const w = sourceValues[0]?.length ?? 0

    if (w !== 1 || h < 2) return null

    const vals = sourceValues.map(r => r[0])

    // Numeric sequence
    const nums = vals.map(v => parseFloat(v))
    if (nums.every(n => !isNaN(n))) {
        const steps = []
        for (let i = 1; i < nums.length; i++) steps.push(nums[i] - nums[i - 1])
        const step = steps[0]
        if (steps.every(s => Math.abs(s - step) < 0.0001)) {
            return { type: 'numericCol', step, firstNum: nums[0] }
        }
    }

    // Date sequence
    const dates = vals.map(v => toDate(String(v).trim()))
    if (dates.every(d => d !== null)) {
        const days = dates.map(d => new Date(d + 'T00:00:00Z').getTime() / 86400000)
        const steps = []
        for (let i = 1; i < days.length; i++) steps.push(days[i] - days[i - 1])
        const step = Math.round(steps[0])
        if (steps.every(s => Math.abs(Math.round(s) - step) < 0.5)) {
            return {
                type: 'dateCol',
                step,
                firstIso: dates[0],
                formats: vals.map(v => detectDateFormat(String(v).trim())),
                monthCases: vals.map(v => String(v).trim().match(/[A-Za-z]+/)?.[0] || null),
            }
        }
    }

    // Text+number sequence
    const textNums = vals.map(v => {
        const m = String(v).match(/^(.*?)(\d+)$/)
        return m ? { prefix: m[1], num: parseInt(m[2]), digits: m[2].length, padded: m[2][0] === '0' } : null
    })
    if (textNums.every(t => t !== null)) {
        const prefixes = textNums.map(t => t.prefix)
        if (prefixes.every(p => p === prefixes[0])) {
            const numSteps = []
            for (let i = 1; i < textNums.length; i++) numSteps.push(textNums[i].num - textNums[i - 1].num)
            const step = numSteps[0]
            if (numSteps.every(s => s === step)) {
                const first = textNums[0]
                return {
                    type: 'textNumCol',
                    prefix: first.prefix,
                    firstNum: first.num,
                    step,
                    digits: first.digits,
                    padded: first.padded,
                }
            }
        }
    }

    // Cycle sequence
    if (h >= 1) {
        const seed = detectSeedType(vals[0])
        if (seed.type === 'cycle') {
            // Check all are from the same cycle list
            const list = seed.match.list
            const all = vals.map(v => matchCycle(String(v).trim(), list))
            if (all.every(m => m !== null)) {
                return { type: 'cycleCol', match: seed.match }
            }
        }
    }

    return null
}

/**
 * Perform a fill operation.
 *
 * @param {object} params
 *   seedStartRow, seedStartCol, seedEndRow, seedEndCol — the selection (seed cells)
 *   fillEndRow, fillEndCol — the drag target
 *   engine — the spreadsheet engine
 *   direction — 'down'|'up'|'right'|'left' (inferred if not given)
 * @returns Array<{ row, col, value }> — changes to apply
 */
export function computeFill(params) {
    const { seedStartRow, seedStartCol, seedEndRow, seedEndCol, fillEndRow, fillEndCol, engine } = params

    const srcH = seedEndRow - seedStartRow + 1
    const srcW = seedEndCol - seedStartCol + 1
    const sourceValues = []
    const sourceStyles = []
    for (let r = 0; r < srcH; r++) {
        const row = []
        const styleRow = []
        for (let c = 0; c < srcW; c++) {
            row.push(engine.getCellRaw(seedStartRow + r, seedStartCol + c).raw ?? '')
            styleRow.push({ ...(engine.getStyle(seedStartRow + r, seedStartCol + c) || {}) })
        }
        sourceValues.push(row)
        sourceStyles.push(styleRow)
    }

    const seqInfo = analyzeSequence(sourceValues)
    const changes = []

    const inside =
        fillEndRow >= seedStartRow && fillEndRow <= seedEndRow &&
        fillEndCol >= seedStartCol && fillEndCol <= seedEndCol &&
        (fillEndRow < seedEndRow || fillEndCol < seedEndCol)

    if (inside) {
        for (let r = seedStartRow; r <= seedEndRow; r++) {
            for (let c = seedStartCol; c <= seedEndCol; c++) {
                if (r > fillEndRow || c > fillEndCol) {
                    changes.push({ row: r, col: c, value: '', clear: true })
                }
            }
        }
        return changes
    }

    const dy = fillEndRow > seedEndRow
        ? fillEndRow - seedEndRow
        : fillEndRow < seedStartRow
            ? fillEndRow - seedStartRow
            : 0
    const dx = fillEndCol > seedEndCol
        ? fillEndCol - seedEndCol
        : fillEndCol < seedStartCol
            ? fillEndCol - seedStartCol
            : 0

    let fillMinRow = seedStartRow, fillMaxRow = seedEndRow
    let fillMinCol = seedStartCol, fillMaxCol = seedEndCol
    if (Math.abs(dy) >= Math.abs(dx)) {
        if (dy > 0) fillMaxRow = fillEndRow
        else if (dy < 0) fillMinRow = fillEndRow
    } else {
        if (dx > 0) fillMaxCol = fillEndCol
        else if (dx < 0) fillMinCol = fillEndCol
    }

    for (let r = fillMinRow; r <= fillMaxRow; r++) {
        for (let c = fillMinCol; c <= fillMaxCol; c++) {
            if (r >= seedStartRow && r <= seedEndRow && c >= seedStartCol && c <= seedEndCol) continue

            const relRow = r - seedStartRow
            const relCol = c - seedStartCol
            const patRow = ((relRow % srcH) + srcH) % srcH
            const patCol = ((relCol % srcW) + srcW) % srcW
            const value = computeFillValue(sourceValues, relRow, relCol, seqInfo)
            if (value !== undefined && value !== null) {
                changes.push({
                    row: r,
                    col: c,
                    value: String(value),
                    style: { ...sourceStyles[patRow][patCol] },
                })
            }
        }
    }

    return changes
}

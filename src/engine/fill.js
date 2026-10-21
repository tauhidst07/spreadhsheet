// ─────────────────────────────────────────────────────────────
//  Fill-handle series inference (pure; no engine state).
//
//  A "lane" is one column (vertical fill) or one row (horizontal
//  fill) of the selection. Seeds are the lane's selected cells in
//  order; a target is addressed by its series index t, where seeds
//  occupy t = 0..k-1, cells after them t = k, k+1, … and cells
//  before them (dragging up / left) t = -1, -2, …
// ─────────────────────────────────────────────────────────────
import {
    parseLiteralNumber, parseDate, dateToSerial, formatSerialLike,
    MONTHS, WEEKDAYS, matchCase, numberToText,
} from './values.js'

const CYCLES = [
    { list: WEEKDAYS, abbr: WEEKDAYS.map(d => d.slice(0, 3)) },
    { list: MONTHS, abbr: MONTHS.map(m => m.slice(0, 3)) },
]

function classify(seed) {
    if (seed.formula) return { type: 'formula' }
    const raw = seed.raw
    if (raw.trim() === '') return { type: 'blank' }
    const n = parseLiteralNumber(raw)
    if (n !== null) return { type: 'num', n }
    const date = parseDate(raw)
    if (date) return { type: 'date', n: dateToSerial(date), tpl: date }
    const word = raw.trim().toLowerCase()
    for (let ci = 0; ci < CYCLES.length; ci++) {
        const { list, abbr } = CYCLES[ci]
        let idx = list.indexOf(word)
        let short = false
        if (idx < 0) { idx = abbr.indexOf(word); short = idx >= 0 }
        if (idx >= 0) return { type: 'cycle', cycle: ci, n: idx, short, sample: raw.trim() }
    }
    const m = raw.match(/^(.*?)(\d+)$/)
    if (m) return { type: 'tnum', prefix: m[1], n: parseInt(m[2], 10), width: m[2].length, padded: m[2].length > 1 && m[2][0] === '0' }
    return { type: 'text' }
}

function sameSeries(a, b) {
    if (a.type !== b.type) return false
    if (a.type === 'tnum') return a.prefix === b.prefix
    if (a.type === 'cycle') return a.cycle === b.cycle
    return a.type === 'num' || a.type === 'date'
}

const mod = (a, n) => ((a % n) + n) % n

/**
 * Plans one lane. Returns, for every requested series index, either
 *   { seed: s, raw }            a literal value to write (styled like seed s), or
 *   { seed: s, offset }         copy seed s's formula shifted by `offset` cells.
 */
export function planLane(seeds, indices) {
    const k = seeds.length
    const info = seeds.map(classify)
    const first = info[0]
    const isSeries = ['num', 'date', 'cycle', 'tnum'].includes(first.type) && info.every(i => sameSeries(first, i))

    let step = 0
    if (isSeries) {
        if (k === 1) step = first.type === 'num' ? 0 : 1 // one number → copy; dates, names, "Item 1" → +1
        else if (first.type === 'cycle') step = mod(info[1].n - info[0].n, CYCLES[first.cycle].list.length)
        else step = (info[k - 1].n - info[0].n) / (k - 1)
    }

    return indices.map(t => {
        const s = mod(t, k)
        const seedInfo = info[s]
        if (!isSeries) {
            return seedInfo.type === 'formula' ? { seed: s, offset: t - s } : { seed: s, raw: seeds[s].raw }
        }
        const value = first.n + step * t
        switch (first.type) {
            case 'num': return { seed: s, raw: numberToText(value) }
            case 'date': return { seed: s, raw: formatSerialLike(Math.round(value), seedInfo.tpl) }
            case 'cycle': {
                const { list, abbr } = CYCLES[first.cycle]
                const idx = mod(Math.round(value), list.length)
                const word = seedInfo.short ? abbr[idx] : list[idx]
                return { seed: s, raw: matchCase(word, seedInfo.sample) }
            }
            case 'tnum': {
                const n = Math.round(value)
                if (n < 0) return { seed: s, raw: seeds[s].raw }
                const digits = seedInfo.padded ? String(n).padStart(seedInfo.width, '0') : String(n)
                return { seed: s, raw: seedInfo.prefix + digits }
            }
            default: return { seed: s, raw: seeds[s].raw }
        }
    })
}

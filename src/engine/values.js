// ─────────────────────────────────────────────────────────────
//  Value normalisation shared by the formula engine, sort,
//  filters, number formats and the AI executor.
//  Rules follow AI_CONTRACT.md §3.2 exactly.
// ─────────────────────────────────────────────────────────────

const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/
const STRICT_LITERAL_NUMBER = /^-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i

export const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
    'august', 'september', 'october', 'november', 'december']
export const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']

/** Text key: trim + lower case. */
export function norm(v) {
    if (v === null || v === undefined) return ''
    return String(v).trim().toLowerCase()
}

/**
 * Number coercion: `$1,200.00` → 1200, `10%` → 0.1, `15 %` → 0.15,
 * `N/A` → null, '' → null. Numbers pass through.
 */
export function toNum(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null
    if (v === null || v === undefined || typeof v === 'object') return null
    const s = String(v).trim()
    if (s === '') return null
    const percent = s.endsWith('%')
    const stripped = s.replace(/[$,%\s]/g, '')
    if (!PLAIN_NUMBER.test(stripped)) return null
    const n = Number(stripped)
    return percent ? n / 100 : n
}

/** Is a literal typed into a cell a plain number (no symbols)? Used for computed values. */
export function parseLiteralNumber(raw) {
    const s = raw.trim()
    if (!STRICT_LITERAL_NUMBER.test(s)) return null
    return Number(s)
}

function monthFromWord(word) {
    const w = word.toLowerCase()
    if (w.length < 3) return -1
    return MONTHS.findIndex(m => m.startsWith(w))
}

function validDay(y, m, d) {
    if (m < 1 || m > 12 || d < 1 || d > 31) return false
    const t = new Date(Date.UTC(y, m - 1, d))
    return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d
}

function pad2(n) { return String(n).padStart(2, '0') }

/**
 * Parses the three sample date formats. Returns
 * { y, m, d, format } where format is 'iso' | 'us' | 'dmy', or null.
 * `iso` remembers whether the seed was zero padded so fill can keep it.
 */
export function parseDate(v) {
    if (typeof v !== 'string') return null
    const s = v.trim()
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
    if (m) {
        const y = +m[1], mo = +m[2], d = +m[3]
        if (!validDay(y, mo, d)) return null
        return { y, m: mo, d, format: 'iso', padded: m[2].length === 2 && m[3].length === 2 }
    }
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
    if (m) {
        const mo = +m[1], d = +m[2], y = +m[3]
        if (!validDay(y, mo, d)) return null
        return { y, m: mo, d, format: 'us' }
    }
    m = s.match(/^(\d{1,2})\s+([A-Za-z]{3,})\.?\s+(\d{4})$/)
    if (m) {
        const mo = monthFromWord(m[2]) + 1
        const d = +m[1], y = +m[3]
        if (mo === 0 || !validDay(y, mo, d)) return null
        return { y, m: mo, d, format: 'dmy', monthText: m[2] }
    }
    return null
}

/** ISO day string `YYYY-MM-DD` or null. */
export function toDate(v) {
    const p = parseDate(v)
    return p ? `${p.y}-${pad2(p.m)}-${pad2(p.d)}` : null
}

/** Days since the Unix epoch for a parsed date (UTC, so no DST drift). */
export function dateToSerial(p) {
    return Math.round(Date.UTC(p.y, p.m - 1, p.d) / 86400000)
}

/** Writes a serial day back out in the shape of `template` (a parseDate result). */
export function formatSerialLike(serial, template) {
    const t = new Date(serial * 86400000)
    const y = t.getUTCFullYear(), m = t.getUTCMonth() + 1, d = t.getUTCDate()
    if (template.format === 'us') return `${m}/${d}/${y}`
    if (template.format === 'dmy') {
        const name = MONTHS[m - 1]
        const fullName = template.monthText.toLowerCase() === MONTHS[template.m - 1]
        const word = fullName ? name : name.slice(0, 3)
        return `${d} ${matchCase(word, template.monthText)} ${y}`
    }
    if (template.padded === false) return `${y}-${m}-${d}`
    return `${y}-${pad2(m)}-${pad2(d)}`
}

/** Re-cases `word` like `sample`: MON, mon or Mon. */
export function matchCase(word, sample) {
    if (sample === sample.toUpperCase()) return word.toUpperCase()
    if (sample === sample.toLowerCase()) return word.toLowerCase()
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
}

/** The totals-row test from AI_CONTRACT.md §3.1, applied to a row's first non-empty cell. */
export const TOTALS_LABEL = /^(grand\s+)?(total|totals|subtotal|sum)\b/i

export function isTotalsLabel(text) {
    return TOTALS_LABEL.test(String(text ?? '').trim())
}

// ── Number format display (AI_CONTRACT.md §4 table) ──

function groupThousands(fixed) {
    const [int, frac] = fixed.split('.')
    const neg = int.startsWith('-')
    const digits = neg ? int.slice(1) : int
    const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    return (neg ? '-' : '') + grouped + (frac !== undefined ? '.' + frac : '')
}

function trimPercent(n) {
    // 0.1 → "10", 0.125 → "12.5", 7900 stays "7900"
    return String(Number((n * 100).toFixed(2)))
}

/**
 * Applies a numberFormat to the text the grid would otherwise show.
 * Formatting never changes the stored value; text that does not coerce is left alone.
 */
export function formatForDisplay(text, numberFormat) {
    if (!numberFormat || numberFormat === 'general' || text === '') return text
    if (numberFormat === 'date') {
        const iso = toDate(text)
        return iso ?? text
    }
    const n = toNum(text)
    if (n === null) return text
    switch (numberFormat) {
        case 'number': return groupThousands(n.toFixed(2))
        case 'currency': return n < 0 ? '-$' + groupThousands((-n).toFixed(2)) : '$' + groupThousands(n.toFixed(2))
        case 'percent': return trimPercent(n) + '%'
        default: return text
    }
}

/** Formats a computed number the way the grid shows it (no float noise). */
export function numberToText(n) {
    if (!Number.isFinite(n)) return '#VALUE!'
    if (Number.isInteger(n)) return String(n)
    return String(Number(n.toPrecision(12)))
}

// Value coercion and display formatting shared by the engine, the query
// executor and the format applier. Rules follow AI_CONTRACT.md §3.2 and §4.

const NUMBER_TEXT = /^-?\d+(\.\d+)?$/
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']

/** Text key: trimmed, lower-cased. */
export const norm = v => String(v ?? '').trim().toLowerCase()

/** `$1,200.00` → 1200, `10%` → 0.1, `N/A` → null. Numbers pass through. */
export function toNum(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  const s = String(v ?? '').trim()
  if (!s) return null
  const percent = s.endsWith('%')
  const n = s.replace(/[$,%\s]/g, '')
  if (!NUMBER_TEXT.test(n)) return null
  return percent ? Number(n) / 100 : Number(n)
}

const dateCache = new Map()

/** Parses `YYYY-M-D`, `M/D/YYYY` or `D Mon YYYY` into `{ y, m, d, format }`, else null. Memoised: columns repeat dates. */
export function parseDate(v) {
  const key = String(v ?? '')
  let hit = dateCache.get(key)
  if (hit === undefined) {
    if (dateCache.size > 50000) dateCache.clear()
    hit = parseDateText(key.trim())
    dateCache.set(key, hit)
  }
  return hit
}

function parseDateText(s) {
  if (!s || s.length > 20 || !/\d/.test(s)) return null
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s)
  if (m) return checkDate(+m[1], +m[2], +m[3], 'iso')
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s)
  if (m) return checkDate(+m[3], +m[1], +m[2], 'us')
  m = /^(\d{1,2}) ([A-Za-z]{3,}) (\d{4})$/.exec(s)
  if (m) {
    const name = m[2].toLowerCase(), month = MONTHS.findIndex(full => full.startsWith(name)) + 1
    if (month || name === 'sept') return checkDate(+m[3], month || 9, +m[1], 'dmy')
  }
  return null
}

function checkDate(y, m, d, format) {
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null
  return { y, m, d, format }
}

const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate()
const pad = n => String(n).padStart(2, '0')

/** ISO day string `YYYY-MM-DD` or null. */
export function toDate(v) {
  const p = parseDate(v)
  return p ? `${p.y}-${pad(p.m)}-${pad(p.d)}` : null
}

/** Days since 1970-01-01 for a parsed date. */
export const dayNumber = p => Date.UTC(p.y, p.m - 1, p.d) / 86400000

/** Writes a day number back in one of the three sample formats. */
export function formatDay(day, format) {
  const date = new Date(day * 86400000), y = date.getUTCFullYear(), m = date.getUTCMonth() + 1, d = date.getUTCDate()
  if (format === 'us') return `${m}/${d}/${y}`
  if (format === 'dmy') return `${d} ${MONTHS[m - 1][0].toUpperCase()}${MONTHS[m - 1].slice(1, 3)} ${y}`
  return `${y}-${pad(m)}-${pad(d)}`
}

/** Locale-independent `1,234.50`. */
function grouped(n, decimals) {
  const fixed = Math.abs(n).toFixed(decimals)
  const [int, frac] = fixed.split('.')
  const body = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return (n < 0 && Number(fixed) !== 0 ? '-' : '') + body + (frac ? `.${frac}` : '')
}

/** Shows a computed number without float noise. */
export const formatComputed = n => String(Number.isInteger(n) ? n : parseFloat(n.toPrecision(12)))

/** Applies a `numberFormat` to display text. The stored value is never changed. */
export function applyNumberFormat(text, format) {
  if (!format || format === 'general' || text === '') return text
  if (format === 'date') return toDate(text) ?? text
  const n = toNum(text)
  if (n === null || parseDate(text)) return text
  if (format === 'percent') return `${parseFloat((n * 100).toFixed(10))}%`
  if (format === 'currency') return n < 0 ? `-$${grouped(-n, 2)}` : `$${grouped(n, 2)}`
  return grouped(n, 2)
}

const TOTALS = /^(grand\s+)?(total|totals|subtotal|sum)\b/i

/** A row (array of display strings) whose first filled cell reads like "Total". */
export function isTotalsLabelRow(row) {
  const first = row.find(v => String(v ?? '').trim() !== '')
  return first !== undefined && TOTALS.test(String(first).trim())
}

/** AI_CONTRACT.md §4.2: totals label, or a summary line (label, then numbers, some cells empty). */
export function looksLikeTotalsRow(row) {
  if (isTotalsLabelRow(row)) return true
  const values = row.map(v => String(v ?? '').trim()), filled = values.filter(Boolean)
  if (filled.length < 2 || filled.length === values.length) return false
  return toNum(filled[0]) === null && filled.slice(1).every(v => toNum(v) !== null)
}

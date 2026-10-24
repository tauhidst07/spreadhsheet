// Pure AI plumbing: response parsing, schema validation, sheet context and the
// query executor (AI_CONTRACT.md §1–§3). No React, no DOM, no provider details.

import { ACTION_TYPES, AGGREGATE_FNS, CLARIFY_SCHEMA, FILTER_OPS, FORMAT_SHEET_SCHEMA, MAX_RESULT_ROWS, QUERY_PLAN_SCHEMA } from './contract.js'
import { isTotalsLabelRow, norm, parseDate, toDate, toNum } from '../engine/values.js'
import { cellLabel } from '../engine/formula.js'

const fail = (error, detail) => ({ error, detail })

// ── Response parsing ─────────────────────────────────────────

/** Extracts and parses the first balanced JSON object in model text (prose and code fences allowed). */
export function parseAction(text) {
  const source = String(text ?? ''), start = source.indexOf('{')
  if (start < 0) return fail('INVALID_RESPONSE', 'No JSON object found in the response')
  const end = matchingBrace(source, start)
  if (end < 0) return fail('INVALID_RESPONSE', 'Unclosed JSON object')
  try { return { action: JSON.parse(source.slice(start, end + 1)) } }
  catch (error) { return fail('INVALID_RESPONSE', `Malformed JSON: ${error.message}`) }
}

function matchingBrace(s, start) {
  let depth = 0, quoted = false, escaped = false
  for (let i = start; i < s.length; i++) {
    const ch = s[i]
    if (quoted) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') quoted = false
    } else if (ch === '"') quoted = true
    else if (ch === '{') depth++
    else if (ch === '}' && --depth === 0) return i
  }
  return -1
}

// ── Schema validation (hand-written subset of JSON Schema) ───

const typeOk = (v, t) => (t === 'integer' ? Number.isInteger(v) : t === 'null' ? v === null : t === 'array' ? Array.isArray(v)
  : t === 'object' ? v !== null && typeof v === 'object' && !Array.isArray(v) : typeof v === t)

function check(value, schema, path) {
  if ('const' in schema && value !== schema.const) return `${path} must be ${JSON.stringify(schema.const)}`
  if (schema.enum && !schema.enum.includes(value)) return `${path} must be one of ${schema.enum.join(', ')}`
  if (schema.type) {
    const types = [].concat(schema.type)
    if (!types.some(t => typeOk(value, t))) return `${path} must be ${types.join(' or ')}`
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) return `${path} must be ≥ ${schema.minimum}`
    if (schema.maximum !== undefined && value > schema.maximum) return `${path} must be ≤ ${schema.maximum}`
  }
  if (typeof value === 'string' && schema.pattern && !new RegExp(schema.pattern).test(value)) return `${path} has an invalid format`
  if (Array.isArray(value) && schema.items) {
    for (let i = 0; i < value.length; i++) { const e = check(value[i], schema.items, `${path}[${i}]`); if (e) return e }
  }
  if (typeOk(value, 'object') && schema.properties) {
    for (const key of schema.required ?? []) if (!(key in value)) return `${path}.${key} is required`
    for (const [key, v] of Object.entries(value)) {
      const sub = schema.properties[key]
      if (!sub) { if (schema.additionalProperties === false) return `${path}.${key} is not allowed`; continue }
      const e = check(v, sub, `${path}.${key}`)
      if (e) return e
    }
  }
  return null
}

const SCHEMAS = { [ACTION_TYPES.QUERY]: QUERY_PLAN_SCHEMA, [ACTION_TYPES.FORMAT_SHEET]: FORMAT_SHEET_SCHEMA, [ACTION_TYPES.CLARIFY]: CLARIFY_SCHEMA }

/** Validates a parsed action. Unknown action types are READ_ONLY; schema failures say what failed. */
export function validateAction(action) {
  if (!typeOk(action, 'object')) return fail('INVALID_RESPONSE', 'action must be a JSON object')
  if (typeof action.type !== 'string') return fail('INVALID_RESPONSE', 'action.type is required')
  const schema = SCHEMAS[action.type]
  if (!schema) return fail('READ_ONLY', `READ_ONLY: action type "${action.type}" is not allowed`)
  const error = check(action, schema, 'action')
  return error ? fail('INVALID_RESPONSE', error) : { action }
}

// ── Sheet context (what the model may know) ──────────────────

function inferType(name, values) {
  const filled = values.map(v => String(v).trim()).filter(Boolean)
  if (!filled.length) return 'text'
  const share = test => filled.filter(test).length / filled.length
  if (/\b(id|code|key)$/i.test(String(name).trim()) || share(v => /^[A-Z]{2,}-?\d+$/i.test(v)) > 0.8) return 'id'
  if (share(v => parseDate(v)) > 0.8) return 'date'
  if (share(v => /%$/.test(v)) > 0.3 && share(v => toNum(v) !== null) > 0.6) return 'percent'
  if (share(v => v.includes('$')) > 0.3 && share(v => toNum(v) !== null) > 0.8) return 'currency'
  if (share(v => toNum(v) !== null) > 0.8) return 'number'
  return 'text'
}

/**
 * Builds the context sent with every prompt: range, row count, per-column
 * name/index/type/examples, at most 5 sample rows, selection and whether a
 * totals row exists. Reads at most 200 rows to infer types; never the full data.
 * `matrix` is the used range as display text, row 0 the header.
 */
export function buildContext(matrix, selection) {
  const header = matrix[0] ?? [], body = matrix.slice(1).filter(r => r.some(v => norm(v)))
  const hasTotalsRow = body.length > 0 && isTotalsLabelRow(body.at(-1))
  const data = hasTotalsRow ? body.slice(0, -1) : body, probe = data.slice(0, 200)
  return {
    range: matrix.length ? `A1:${cellLabel(matrix.length - 1, Math.max(0, header.length - 1))}` : null,
    rowCount: data.length,
    columns: header.map((name, index) => {
      const values = probe.map(r => r[index] ?? '')
      return { name, index, type: inferType(name, values), examples: [...new Set(values.filter(v => String(v).trim()))].slice(0, 3) }
    }),
    sampleRows: data.slice(0, 5),
    selection: selection ?? null,
    hasTotalsRow,
  }
}

const SYSTEM_PROMPT = `You translate a user's request about a spreadsheet into exactly one JSON action. You never compute numbers yourself.
Allowed actions (JSON Schema):
query: ${JSON.stringify(QUERY_PLAN_SCHEMA)}
format_sheet: ${JSON.stringify(FORMAT_SHEET_SCHEMA)}
clarify: ${JSON.stringify(CLARIFY_SCHEMA)}
Rules:
- Use column names exactly as given in the context. If the request names a field that is not one of those columns (for example "territory" when there is no Territory column), never substitute a similar column: answer with clarify and ask which column the user means.
- Questions about the data become a read-only query. Requests to change, delete or add data are not allowed: answer with clarify explaining that only read-only questions and formatting are supported.
- Formatting requests become format_sheet; column indexes are 0-based from the context.
- filters combine with AND; op is one of ${FILTER_OPS.join(', ')}; aggregate fn is one of ${AGGREGATE_FNS.join(', ')}.
- Dates in filters use YYYY-MM-DD. limit is at most ${MAX_RESULT_ROWS}.
Answer with a single JSON object and nothing else.`

/** The user turn: sheet context plus the request. */
const userTurn = (prompt, context) => `Sheet context:\n${JSON.stringify(context)}\n\nRequest: ${prompt}`

/**
 * Asks the provider and returns a validated action, or { error, detail }.
 * Provider failures become PROVIDER_ERROR-style errors with their code kept.
 */
export async function requestAction(provider, prompt, context, history = []) {
  let response
  try { response = await provider.complete({ system: SYSTEM_PROMPT, user: userTurn(prompt, context), history, prompt }) }
  catch (error) { return fail(error.code ?? 'PROVIDER_ERROR', error.message) }
  const parsed = parseAction(response.text)
  if (parsed.error) return { ...parsed, raw: response.text }
  const checked = validateAction(parsed.action)
  return checked.error ? { ...checked, raw: response.text } : { action: checked.action, raw: response.text }
}

// ── Query executor ───────────────────────────────────────────

function matches(cell, f) {
  const a = norm(cell), b = norm(f.value)
  switch (f.op) {
    case 'isEmpty': return a === ''
    case 'notEmpty': return a !== ''
    case 'contains': return a.includes(b)
    case 'startsWith': return a.startsWith(b)
    case 'endsWith': return a.endsWith(b)
    case 'eq': case 'neq': {
      const x = toNum(cell), y = toNum(f.value)
      const same = x !== null && y !== null ? x === y : a === b
      return f.op === 'eq' ? same : !same
    }
    default: {
      const day = toDate(f.value)
      const x = day ? toDate(cell) : toNum(cell), y = day ?? toNum(f.value)
      if (x === null || y === null) return false
      return f.op === 'gt' ? x > y : f.op === 'gte' ? x >= y : f.op === 'lt' ? x < y : x <= y
    }
  }
}

function aggregate(fn, values) {
  if (fn === 'count') return values.filter(v => norm(v) !== '').length
  if (fn === 'countDistinct') return new Set(values.map(norm).filter(Boolean)).size
  const nums = values.map(toNum).filter(n => n !== null)
  if (!nums.length) return null
  if (fn === 'sum') return nums.reduce((a, b) => a + b, 0)
  if (fn === 'avg') return nums.reduce((a, b) => a + b, 0) / nums.length
  if (fn === 'min') return nums.reduce((a, b) => (b < a ? b : a))
  return nums.reduce((a, b) => (b > a ? b : a))
}

/** Sort key: numbers compare numerically and come before text, which compares on norm(). */
const sortKey = v => { const n = toNum(v); return n === null ? { n: null, t: norm(v) } : { n, t: '' } }

function compareKeys(a, b) {
  if (a.n !== null && b.n !== null) return a.n - b.n
  if (a.n !== null) return -1
  if (b.n !== null) return 1
  return a.t < b.t ? -1 : a.t > b.t ? 1 : 0
}

const round2 = v => (typeof v === 'number' ? Math.round(v * 100) / 100 : v)

/**
 * Runs a validated query plan over `matrix` (display text, row 0 = header).
 * Returns { columns, rows, rowCount, truncated } or { error, detail }.
 */
export function executeQuery(matrix, plan) {
  if (plan?.type !== ACTION_TYPES.QUERY) return fail('READ_ONLY', 'READ_ONLY')
  const headers = matrix[0] ?? [], index = new Map()
  headers.forEach((h, i) => { if (!index.has(norm(h))) index.set(norm(h), i) })
  const col = name => index.get(norm(name))
  const filters = plan.filters ?? [], groupBy = plan.groupBy ?? [], aggregates = plan.aggregates ?? []
  for (const f of filters) if (!FILTER_OPS.includes(f.op)) return fail('UNKNOWN_OP', `UNKNOWN_OP:${f.op}`)
  for (const a of aggregates) if (!AGGREGATE_FNS.includes(a.fn)) return fail('UNKNOWN_FN', `UNKNOWN_FN:${a.fn}`)
  const named = [...filters.map(f => f.column), ...groupBy, ...aggregates.map(a => a.column), ...(aggregates.length ? [] : plan.columns ?? [])]
  for (const name of named) if (col(name) === undefined) return fail('UNKNOWN_COLUMN', `UNKNOWN_COLUMN:${name}`)

  let rows = matrix.slice(1).filter(r => r.some(v => norm(v) !== ''))
  if (plan.excludeTotalsRow !== false && rows.length && isTotalsLabelRow(rows.at(-1))) rows = rows.slice(0, -1)
  const filterCols = filters.map(f => col(f.column))
  rows = rows.filter(r => filters.every((f, i) => matches(r[filterCols[i]] ?? '', f)))

  let columns, output
  if (aggregates.length) {
    const groupCols = groupBy.map(col), aggCols = aggregates.map(a => col(a.column)), groups = new Map()
    if (!groupBy.length) groups.set('', { label: [], rows })
    else for (const r of rows) {
      const key = groupCols.map(i => norm(r[i])).join('\u0001')
      let g = groups.get(key)
      if (!g) groups.set(key, (g = { label: groupCols.map(i => String(r[i] ?? '').trim()), rows: [] }))
      g.rows.push(r)
    }
    columns = [...groupBy, ...aggregates.map(a => a.as ?? `${a.fn}(${a.column})`)]
    output = [...groups.values()].map(g => [...g.label, ...aggregates.map((a, i) => aggregate(a.fn, g.rows.map(r => r[aggCols[i]] ?? '')))])
  } else {
    columns = plan.columns?.length ? plan.columns : headers
    const picks = columns.map(col)
    output = rows.map(r => picks.map(i => r[i] ?? ''))
  }

  const sorts = (plan.sort ?? []).map(s => ({ i: columns.findIndex(c => norm(c) === norm(s.column)), dir: s.dir === 'desc' ? -1 : 1, column: s.column }))
  const missing = sorts.find(s => s.i < 0)
  if (missing) return fail('UNKNOWN_SORT_COLUMN', `UNKNOWN_SORT_COLUMN:${missing.column}`)
  if (sorts.length) {
    output = output.map((r, i) => ({ r, i, k: sorts.map(s => sortKey(r[s.i])) })).sort((x, y) => {
      for (let j = 0; j < sorts.length; j++) { const d = compareKeys(x.k[j], y.k[j]); if (d) return d * sorts[j].dir }
      return x.i - y.i
    }).map(x => x.r)
  }

  const limit = Math.min(plan.limit ?? MAX_RESULT_ROWS, MAX_RESULT_ROWS)
  const shown = output.slice(0, limit)
  return { columns, rows: shown.map(r => r.map(round2)), rowCount: shown.length, truncated: output.length > limit }
}

/** One-line plain-words description of a query plan. */
export function describeQuery(plan) {
  const parts = []
  const aggs = plan.aggregates ?? []
  parts.push(aggs.length ? aggs.map(a => `${a.fn === 'countDistinct' ? 'count distinct' : a.fn} of ${a.column}`).join(', ') : `rows (${plan.columns?.length ? plan.columns.join(', ') : 'all columns'})`)
  if (plan.groupBy?.length) parts.push(`grouped by ${plan.groupBy.join(' and ')}`)
  if (plan.filters?.length) parts.push(`where ${plan.filters.map(f => `${f.column} ${f.op}${f.value !== undefined && f.value !== null ? ` ${f.value}` : ''}`).join(' and ')}`)
  if (plan.sort?.length) parts.push(`sorted by ${plan.sort.map(s => `${s.column} ${s.dir ?? 'asc'}`).join(', ')}`)
  parts.push(`limit ${Math.min(plan.limit ?? MAX_RESULT_ROWS, MAX_RESULT_ROWS)}${(plan.limit ?? 0) > MAX_RESULT_ROWS ? ` (requested ${plan.limit}, capped)` : ''}`)
  if (plan.excludeTotalsRow === false) parts.push('including the totals row')
  return parts.join('; ')
}


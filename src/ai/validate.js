// ─────────────────────────────────────────────────────────────
//  Response parsing and schema validation for model output.
//  Hand-written: supports exactly the JSON-Schema subset used in
//  contract.js (type, const, enum, required, properties,
//  additionalProperties, items, minimum, maximum, pattern).
// ─────────────────────────────────────────────────────────────
import { ACTION_TYPES, QUERY_PLAN_SCHEMA, FORMAT_SHEET_SCHEMA, CLARIFY_SCHEMA } from './contract.js'

/**
 * Finds the first balanced {...} in model text that parses as a JSON object.
 * Handles prose before/after, ```json fences and braces inside strings.
 * Returns { value } or { error }.
 */
export function extractJson(text) {
    if (typeof text !== 'string' || text.trim() === '') return { error: 'The model returned an empty response.' }
    let lastError = 'No JSON object found in the response.'
    for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
        const end = matchBrace(text, start)
        if (end === -1) { lastError = 'The JSON object in the response is not closed.'; continue }
        try {
            const value = JSON.parse(text.slice(start, end + 1))
            if (value && typeof value === 'object' && !Array.isArray(value)) return { value }
        } catch (e) {
            lastError = `The response is not valid JSON: ${e.message}`
        }
    }
    return { error: lastError }
}

function matchBrace(text, start) {
    let depth = 0
    let inString = false
    for (let i = start; i < text.length; i++) {
        const ch = text[i]
        if (inString) {
            if (ch === '\\') i++
            else if (ch === '"') inString = false
        } else if (ch === '"') inString = true
        else if (ch === '{') depth++
        else if (ch === '}') { depth--; if (depth === 0) return i }
    }
    return -1
}

function typeOf(v) {
    if (v === null) return 'null'
    if (Array.isArray(v)) return 'array'
    if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number'
    return typeof v
}

function typeMatches(v, type) {
    const actual = typeOf(v)
    return actual === type || (type === 'number' && actual === 'integer')
}

/** Validates `value` against `schema`; returns a list of "path: problem" strings. */
export function validateSchema(value, schema, path = '$') {
    const errors = []
    if (schema.const !== undefined && value !== schema.const) {
        errors.push(`${path}: must be ${JSON.stringify(schema.const)}`)
        return errors
    }
    if (schema.enum && !schema.enum.includes(value)) {
        errors.push(`${path}: must be one of ${schema.enum.join(', ')} (got ${JSON.stringify(value)})`)
        return errors
    }
    if (schema.type) {
        const types = Array.isArray(schema.type) ? schema.type : [schema.type]
        if (!types.some(t => typeMatches(value, t))) {
            errors.push(`${path}: must be ${types.join(' or ')} (got ${typeOf(value)})`)
            return errors
        }
    }
    if (typeof value === 'number') {
        if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: must be ≥ ${schema.minimum}`)
        if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: must be ≤ ${schema.maximum}`)
    }
    if (typeof value === 'string' && schema.pattern && !new RegExp(schema.pattern).test(value)) {
        errors.push(`${path}: does not match ${schema.pattern}`)
    }
    if (Array.isArray(value) && schema.items) {
        value.forEach((item, i) => errors.push(...validateSchema(item, schema.items, `${path}[${i}]`)))
    }
    if (typeOf(value) === 'object') {
        for (const key of schema.required ?? []) {
            if (!(key in value)) errors.push(`${path}: missing required "${key}"`)
        }
        for (const [key, v] of Object.entries(value)) {
            const sub = schema.properties?.[key]
            if (sub) errors.push(...validateSchema(v, sub, `${path}.${key}`))
            else if (schema.additionalProperties === false) errors.push(`${path}: unexpected property "${key}"`)
        }
    }
    return errors
}

const SCHEMAS = {
    [ACTION_TYPES.QUERY]: QUERY_PLAN_SCHEMA,
    [ACTION_TYPES.FORMAT_SHEET]: FORMAT_SHEET_SCHEMA,
    [ACTION_TYPES.CLARIFY]: CLARIFY_SCHEMA,
}

/**
 * Raw model text → { action } or { error: { code, detail } }.
 * Unknown action types are READ_ONLY (nothing but read-only queries and
 * formatting is ever executed); anything malformed is INVALID_RESPONSE.
 */
export function parseAction(text) {
    const { value, error } = extractJson(text)
    if (error) return { error: { code: 'INVALID_RESPONSE', detail: error } }
    if (typeof value.type !== 'string') {
        return { error: { code: 'INVALID_RESPONSE', detail: '$: missing required "type"' } }
    }
    const schema = SCHEMAS[value.type]
    if (!schema) {
        return { error: { code: 'READ_ONLY', detail: `Action type "${value.type}" is not allowed. Only read-only queries, formatting and clarifying questions are accepted.` } }
    }
    const problems = validateSchema(value, schema)
    if (problems.length) return { error: { code: 'INVALID_RESPONSE', detail: problems.join('; ') }, value }
    return { action: value }
}

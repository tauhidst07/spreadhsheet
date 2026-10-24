// ─────────────────────────────────────────────────────────────
//  JSON schema validator — hand-written, no external libraries.
//  Validates responses against QUERY_PLAN_SCHEMA, FORMAT_SHEET_SCHEMA,
//  and CLARIFY_SCHEMA from contract.js.
// ─────────────────────────────────────────────────────────────

import {
    ACTION_TYPES,
    QUERY_PLAN_SCHEMA,
    FORMAT_SHEET_SCHEMA,
    CLARIFY_SCHEMA,
    FILTER_OPS,
    AGGREGATE_FNS,
    NUMBER_FORMATS,
} from './contract.js'

/**
 * Validate a value against a simplified JSON Schema (draft-07 style).
 * Returns { valid: true } or { valid: false, error: string }
 */
export function validateSchema(value, schema, path = '') {
    if (!schema || typeof schema !== 'object') return { valid: true }

    // const check
    if ('const' in schema) {
        if (value !== schema.const) {
            return { valid: false, error: `${path}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}` }
        }
        return { valid: true }
    }

    // enum check
    if (schema.enum) {
        if (!schema.enum.includes(value)) {
            return { valid: false, error: `${path}: expected one of [${schema.enum.join(', ')}], got ${JSON.stringify(value)}` }
        }
        return { valid: true }
    }

    // type check
    if (schema.type) {
        const types = Array.isArray(schema.type) ? schema.type : [schema.type]
        const jsType = value === null ? 'null' : typeof value
        const typeMatch = types.some(t => {
            if (t === 'integer') return Number.isInteger(value)
            if (t === 'null') return value === null
            if (t === 'array') return Array.isArray(value)
            if (t === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value)
            return jsType === t
        })
        if (!typeMatch) {
            return { valid: false, error: `${path}: expected type [${types.join('|')}], got ${jsType}` }
        }
    }

    // object validation
    if (schema.type === 'object' || (schema.properties && !schema.type)) {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
            return { valid: false, error: `${path}: expected object` }
        }

        // Required fields
        if (schema.required) {
            for (const req of schema.required) {
                if (!(req in value)) {
                    return { valid: false, error: `${path}: missing required field "${req}"` }
                }
            }
        }

        // Additional properties check
        if (schema.additionalProperties === false && schema.properties) {
            for (const key of Object.keys(value)) {
                if (!(key in schema.properties)) {
                    return { valid: false, error: `${path}: unexpected property "${key}"` }
                }
            }
        }

        // Property validation
        if (schema.properties) {
            for (const [key, propSchema] of Object.entries(schema.properties)) {
                if (key in value && value[key] !== undefined) {
                    const res = validateSchema(value[key], propSchema, `${path}.${key}`)
                    if (!res.valid) return res
                }
            }
        }
    }

    // array validation
    if (schema.type === 'array') {
        if (!Array.isArray(value)) {
            return { valid: false, error: `${path}: expected array` }
        }
        if (schema.items) {
            for (let i = 0; i < value.length; i++) {
                const res = validateSchema(value[i], schema.items, `${path}[${i}]`)
                if (!res.valid) return res
            }
        }
    }

    // Numeric constraints
    if (typeof value === 'number') {
        if (schema.minimum !== undefined && value < schema.minimum) {
            return { valid: false, error: `${path}: ${value} < minimum ${schema.minimum}` }
        }
        if (schema.maximum !== undefined && value > schema.maximum) {
            return { valid: false, error: `${path}: ${value} > maximum ${schema.maximum}` }
        }
    }

    // String pattern
    if (schema.pattern && typeof value === 'string') {
        if (!new RegExp(schema.pattern).test(value)) {
            return { valid: false, error: `${path}: "${value}" does not match pattern ${schema.pattern}` }
        }
    }

    return { valid: true }
}

/**
 * Extract the first JSON object from a model response string.
 * Models may wrap JSON in prose and/or code fences.
 */
export function extractJSON(text) {
    if (!text || typeof text !== 'string') return null

    // Try direct parse first
    try { return JSON.parse(text.trim()) } catch { /* fall through */ }

    // Strip code fences (```json ... ``` or ``` ... ```)
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (fenced) {
        try { return JSON.parse(fenced[1].trim()) } catch { /* fall through */ }
    }

    // Find the first { and match braces
    let depth = 0
    let start = -1
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '{') {
            if (start === -1) start = i
            depth++
        } else if (text[i] === '}') {
            depth--
            if (depth === 0 && start !== -1) {
                try { return JSON.parse(text.slice(start, i + 1)) } catch { start = -1 }
            }
        }
    }
    return null
}

/**
 * Validate and classify a parsed action object.
 * Returns { action, error, detail } — action is null if invalid.
 */
export function validateAction(obj) {
    if (!obj || typeof obj !== 'object') {
        return { action: null, error: 'INVALID_RESPONSE', detail: 'Response is not a JSON object' }
    }

    const type = obj.type

    if (type === ACTION_TYPES.QUERY) {
        const res = validateSchema(obj, QUERY_PLAN_SCHEMA, 'query')
        if (!res.valid) return { action: null, error: 'INVALID_RESPONSE', detail: res.error }
        return { action: obj, error: null }
    }

    if (type === ACTION_TYPES.FORMAT_SHEET) {
        const res = validateSchema(obj, FORMAT_SHEET_SCHEMA, 'format_sheet')
        if (!res.valid) return { action: null, error: 'INVALID_RESPONSE', detail: res.error }
        return { action: obj, error: null }
    }

    if (type === ACTION_TYPES.CLARIFY) {
        const res = validateSchema(obj, CLARIFY_SCHEMA, 'clarify')
        if (!res.valid) return { action: null, error: 'INVALID_RESPONSE', detail: res.error }
        return { action: obj, error: null }
    }

    // Unknown action type
    if (type === 'mutation' || type === 'write' || type === 'update') {
        return { action: null, error: 'READ_ONLY', detail: `Action type "${type}" is not allowed` }
    }

    return { action: null, error: 'INVALID_RESPONSE', detail: `Unknown action type: "${type}"` }
}

/**
 * Full pipeline: extract JSON from raw text, parse, validate.
 */
export function parseAndValidate(rawText) {
    const parsed = extractJSON(rawText)
    if (!parsed) {
        return { action: null, error: 'INVALID_RESPONSE', detail: 'Could not extract valid JSON from model response' }
    }
    return validateAction(parsed)
}

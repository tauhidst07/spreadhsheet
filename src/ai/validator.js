// ─────────────────────────────────────────────────────────────
//  AI action response parser & validator (no external libraries).
//  Extracts JSON from model output and checks it against the
//  allowed action schemas before anything touches the sheet.
// ─────────────────────────────────────────────────────────────

import { ACTION_TYPES, FILTER_OPS, AGGREGATE_FNS, NUMBER_FORMATS } from './contract.js'

/**
 * Extracts and parses the first JSON object from model output text.
 * Handles prose, conversational prefixes/suffixes, and markdown code fences.
 */
export function extractAndParseJSON(rawText) {
    if (!rawText || typeof rawText !== 'string') {
        return { ok: false, error: 'INVALID_RESPONSE', detail: 'Empty or non-string response from provider' }
    }

    const trimmed = rawText.trim()

    // 1. Check for markdown code fences: ```json ... ``` or ``` ... ```
    const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (fenceMatch) {
        try {
            const parsed = JSON.parse(fenceMatch[1].trim())
            return { ok: true, data: parsed }
        } catch (err) {
            return { ok: false, error: 'INVALID_RESPONSE', detail: `Failed to parse JSON inside code fence: ${err.message}` }
        }
    }

    // 2. Direct JSON.parse attempt
    try {
        const parsed = JSON.parse(trimmed)
        return { ok: true, data: parsed }
    } catch {
        // Fall through to substring search
    }

    // 3. Find first outer balanced '{' ... '}'
    const firstBrace = trimmed.indexOf('{')
    const lastBrace = trimmed.lastIndexOf('}')
    if (firstBrace !== -1 && lastBrace > firstBrace) {
        const candidate = trimmed.slice(firstBrace, lastBrace + 1)
        try {
            const parsed = JSON.parse(candidate)
            return { ok: true, data: parsed }
        } catch (err) {
            return { ok: false, error: 'INVALID_RESPONSE', detail: `Failed to parse JSON candidate: ${err.message}` }
        }
    }

    return { ok: false, error: 'INVALID_RESPONSE', detail: 'No JSON object found in model response' }
}

function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function validateStyle(style, path) {
    if (!isPlainObject(style)) return `${path} must be an object`
    const allowedKeys = new Set(['bold', 'italic', 'underline', 'bg', 'color', 'align', 'fontSize', 'numberFormat'])
    for (const k of Object.keys(style)) {
        if (!allowedKeys.has(k)) return `${path} contains unknown property "${k}"`
    }
    if (style.bold !== undefined && typeof style.bold !== 'boolean') return `${path}.bold must be a boolean`
    if (style.italic !== undefined && typeof style.italic !== 'boolean') return `${path}.italic must be a boolean`
    if (style.underline !== undefined && typeof style.underline !== 'boolean') return `${path}.underline must be a boolean`
    if (style.bg !== undefined && typeof style.bg !== 'string') return `${path}.bg must be a string`
    if (style.color !== undefined && typeof style.color !== 'string') return `${path}.color must be a string`
    if (style.align !== undefined && !['left', 'center', 'right'].includes(style.align)) {
        return `${path}.align must be "left", "center", or "right"`
    }
    if (style.fontSize !== undefined) {
        if (!Number.isInteger(style.fontSize) || style.fontSize < 8 || style.fontSize > 24) {
            return `${path}.fontSize must be an integer between 8 and 24`
        }
    }
    if (style.numberFormat !== undefined && !NUMBER_FORMATS.includes(style.numberFormat)) {
        return `${path}.numberFormat must be one of: ${NUMBER_FORMATS.join(', ')}`
    }
    return null
}

/**
 * Validates an action object against the AI Contract schemas.
 * Returns { valid: true, action } or { valid: false, error, detail }.
 */
export function validateAction(action) {
    if (!isPlainObject(action)) {
        return { valid: false, error: 'INVALID_RESPONSE', detail: 'Action must be a JSON object' }
    }

    if (!action.type) {
        return { valid: false, error: 'INVALID_RESPONSE', detail: 'Missing required "type" field' }
    }

    // ── 1. clarify ──
    if (action.type === ACTION_TYPES.CLARIFY) {
        if (typeof action.question !== 'string' || !action.question.trim()) {
            return { valid: false, error: 'INVALID_RESPONSE', detail: 'clarify action requires a non-empty string "question"' }
        }
        return { valid: true, action }
    }

    // ── 2. query ──
    if (action.type === ACTION_TYPES.QUERY) {
        if (action.excludeTotalsRow !== undefined && typeof action.excludeTotalsRow !== 'boolean') {
            return { valid: false, error: 'INVALID_RESPONSE', detail: 'excludeTotalsRow must be a boolean' }
        }

        if (action.filters !== undefined) {
            if (!Array.isArray(action.filters)) {
                return { valid: false, error: 'INVALID_RESPONSE', detail: 'filters must be an array' }
            }
            for (let i = 0; i < action.filters.length; i++) {
                const f = action.filters[i]
                if (!isPlainObject(f)) return { valid: false, error: 'INVALID_RESPONSE', detail: `filters[${i}] must be an object` }
                if (typeof f.column !== 'string') return { valid: false, error: 'INVALID_RESPONSE', detail: `filters[${i}].column must be a string` }
                if (!FILTER_OPS.includes(f.op)) {
                    return { valid: false, error: 'UNKNOWN_OP', detail: `filters[${i}].op "${f.op}" is invalid` }
                }
            }
        }

        if (action.groupBy !== undefined) {
            if (!Array.isArray(action.groupBy) || !action.groupBy.every(g => typeof g === 'string')) {
                return { valid: false, error: 'INVALID_RESPONSE', detail: 'groupBy must be an array of column name strings' }
            }
        }

        if (action.aggregates !== undefined) {
            if (!Array.isArray(action.aggregates)) {
                return { valid: false, error: 'INVALID_RESPONSE', detail: 'aggregates must be an array' }
            }
            for (let i = 0; i < action.aggregates.length; i++) {
                const a = action.aggregates[i]
                if (!isPlainObject(a)) return { valid: false, error: 'INVALID_RESPONSE', detail: `aggregates[${i}] must be an object` }
                if (!AGGREGATE_FNS.includes(a.fn)) {
                    return { valid: false, error: 'UNKNOWN_FN', detail: `aggregates[${i}].fn "${a.fn}" is invalid` }
                }
                if (typeof a.column !== 'string') return { valid: false, error: 'INVALID_RESPONSE', detail: `aggregates[${i}].column must be a string` }
                if (a.as !== undefined && typeof a.as !== 'string') {
                    return { valid: false, error: 'INVALID_RESPONSE', detail: `aggregates[${i}].as must be a string` }
                }
            }
        }

        if (action.columns !== undefined) {
            if (!Array.isArray(action.columns) || !action.columns.every(c => typeof c === 'string')) {
                return { valid: false, error: 'INVALID_RESPONSE', detail: 'columns must be an array of column name strings' }
            }
        }

        if (action.sort !== undefined) {
            if (!Array.isArray(action.sort)) {
                return { valid: false, error: 'INVALID_RESPONSE', detail: 'sort must be an array' }
            }
            for (let i = 0; i < action.sort.length; i++) {
                const s = action.sort[i]
                if (!isPlainObject(s)) return { valid: false, error: 'INVALID_RESPONSE', detail: `sort[${i}] must be an object` }
                if (typeof s.column !== 'string') return { valid: false, error: 'INVALID_RESPONSE', detail: `sort[${i}].column must be a string` }
                if (s.dir !== undefined && !['asc', 'desc'].includes(s.dir)) {
                    return { valid: false, error: 'INVALID_RESPONSE', detail: `sort[${i}].dir must be "asc" or "desc"` }
                }
            }
        }

        if (action.limit !== undefined) {
            if (!Number.isInteger(action.limit) || action.limit < 1) {
                return { valid: false, error: 'INVALID_RESPONSE', detail: 'limit must be a positive integer' }
            }
        }

        return { valid: true, action }
    }

    // ── 3. format_sheet ──
    if (action.type === ACTION_TYPES.FORMAT_SHEET) {
        if (action.clearFormatting !== undefined && typeof action.clearFormatting !== 'boolean') {
            return { valid: false, error: 'INVALID_RESPONSE', detail: 'clearFormatting must be a boolean' }
        }

        if (action.headerStyle !== undefined) {
            const err = validateStyle(action.headerStyle, 'headerStyle')
            if (err) return { valid: false, error: 'INVALID_RESPONSE', detail: err }
        }

        if (action.bodyStyle !== undefined) {
            const err = validateStyle(action.bodyStyle, 'bodyStyle')
            if (err) return { valid: false, error: 'INVALID_RESPONSE', detail: err }
        }

        if (action.totalsStyle !== undefined) {
            const err = validateStyle(action.totalsStyle, 'totalsStyle')
            if (err) return { valid: false, error: 'INVALID_RESPONSE', detail: err }
        }

        if (action.columns !== undefined) {
            if (!Array.isArray(action.columns)) {
                return { valid: false, error: 'INVALID_RESPONSE', detail: 'columns must be an array' }
            }
            for (let i = 0; i < action.columns.length; i++) {
                const c = action.columns[i]
                if (!isPlainObject(c)) return { valid: false, error: 'INVALID_RESPONSE', detail: `columns[${i}] must be an object` }
                if (!Number.isInteger(c.col) || c.col < 0) {
                    return { valid: false, error: 'INVALID_RESPONSE', detail: `columns[${i}].col must be a non-negative integer` }
                }
                const err = validateStyle(c.style, `columns[${i}].style`)
                if (err) return { valid: false, error: 'INVALID_RESPONSE', detail: err }
            }
        }

        if (action.freezeRows !== undefined && action.freezeRows !== null) {
            if (!Number.isInteger(action.freezeRows) || action.freezeRows < 0) {
                return { valid: false, error: 'INVALID_RESPONSE', detail: 'freezeRows must be a non-negative integer or null' }
            }
        }

        if (action.columnWidths !== undefined) {
            if (!Array.isArray(action.columnWidths)) {
                return { valid: false, error: 'INVALID_RESPONSE', detail: 'columnWidths must be an array' }
            }
            for (let i = 0; i < action.columnWidths.length; i++) {
                const cw = action.columnWidths[i]
                if (!isPlainObject(cw)) return { valid: false, error: 'INVALID_RESPONSE', detail: `columnWidths[${i}] must be an object` }
                if (!Number.isInteger(cw.col) || cw.col < 0) {
                    return { valid: false, error: 'INVALID_RESPONSE', detail: `columnWidths[${i}].col must be a non-negative integer` }
                }
                if (!Number.isInteger(cw.width) || cw.width < 30 || cw.width > 600) {
                    return { valid: false, error: 'INVALID_RESPONSE', detail: `columnWidths[${i}].width must be an integer between 30 and 600` }
                }
            }
        }

        if (action.autoFitColumns !== undefined && typeof action.autoFitColumns !== 'boolean') {
            return { valid: false, error: 'INVALID_RESPONSE', detail: 'autoFitColumns must be a boolean' }
        }

        return { valid: true, action }
    }

    return { valid: false, error: 'READ_ONLY', detail: `Action type "${action.type}" is not recognized or permitted` }
}

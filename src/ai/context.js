// ─────────────────────────────────────────────────────────────
//  Context builder — assembles the sheet context sent to the LLM.
//  Sends headers, inferred types, ≤5 sample rows, row count, selection.
//  NEVER sends the full data.
// ─────────────────────────────────────────────────────────────

import { toNum, toDate, indexToColumnLabel } from '../engine/core.js'

/**
 * Infer the type of a column from its sample values.
 * Returns one of: 'id' | 'date' | 'currency' | 'percent' | 'number' | 'text'
 */
function inferColumnType(values) {
    if (values.length === 0) return 'text'
    const nonEmpty = values.filter(v => v && String(v).trim())
    if (nonEmpty.length === 0) return 'text'

    // id: matches patterns like ORD-1001, SKU123, etc.
    const idPattern = /^[A-Z]+-?\d+$/
    if (nonEmpty.every(v => idPattern.test(String(v).trim().toUpperCase()))) return 'id'

    // date
    if (nonEmpty.every(v => toDate(String(v).trim()) !== null)) return 'date'

    // percent
    if (nonEmpty.some(v => String(v).trim().endsWith('%'))) return 'percent'

    // currency
    if (nonEmpty.some(v => String(v).trim().startsWith('$'))) return 'currency'

    // number
    if (nonEmpty.every(v => toNum(String(v).trim()) !== null)) return 'number'

    return 'text'
}

/**
 * Build the sheet context object sent in the user turn.
 */
export function buildContext(engine, selection) {
    const used = engine.getUsedRange()
    if (!used) {
        return {
            range: 'A1',
            rowCount: 0,
            columns: [],
            sampleRows: [],
            selection: null,
            hasTotalsRow: false,
        }
    }

    const { startRow, endRow, startCol, endCol } = used
    const dataRowCount = endRow - startRow // number of data rows, excluding header

    // Read header
    const headers = []
    for (let c = startCol; c <= endCol; c++) {
        headers.push(engine.getCellRaw(startRow, c).raw?.trim() ?? '')
    }

    // Read up to 5 sample rows (skip blank rows)
    const sampleRows = []
    for (let r = startRow + 1; r <= endRow && sampleRows.length < 5; r++) {
        const row = []
        let allEmpty = true
        for (let c = startCol; c <= endCol; c++) {
            const computed = engine.getComputedRange(r, c, r, c)[0][0]
            const raw = engine.getCellRaw(r, c).raw ?? ''
            const v = String(computed !== '' && computed !== null && computed !== undefined ? computed : raw).trim()
            row.push(v)
            if (v) allEmpty = false
        }
        if (!allEmpty) sampleRows.push(row)
    }

    // Infer column types from sample data
    const columns = headers.map((name, i) => {
        const examples = sampleRows.map(r => r[i]).filter(Boolean).slice(0, 3)
        const type = inferColumnType(examples)
        return { name, index: i, type, examples }
    })

    const hasTotalsRow = engine.isTotalsRow(endRow)

    // Build range string like A1:J33
    const startColLetter = indexToColumnLabel(startCol)
    const endColLetter = indexToColumnLabel(endCol)
    const range = `${startColLetter}${startRow + 1}:${endColLetter}${endRow + 1}`

    return {
        range,
        rowCount: dataRowCount,
        columns,
        sampleRows,
        selection: selection || null,
        hasTotalsRow,
    }
}

/**
 * Build the system prompt for query actions.
 */
export function buildQuerySystemPrompt() {
    return `You are a spreadsheet query assistant. Your ONLY job is to translate the user's question into a structured JSON query plan.

RULES:
- Respond with EXACTLY ONE JSON object and nothing else (or wrap it in a single \`\`\`json code fence).
- The JSON must conform to the query schema below.
- NEVER compute numbers yourself. Your plan will be executed by code.
- Column names must be copied EXACTLY from the context (case and spacing preserved).
- If you cannot identify a column, use {"type":"clarify","question":"..."}.
- If the request asks to modify data (not read it), respond with {"type":"clarify","question":"I can only read and analyse data, not modify it."}.
- limit defaults to 500 and cannot exceed 500.

QUERY SCHEMA:
{
  "type": "query",
  "excludeTotalsRow": boolean,        // default true
  "filters": [{"column":string,"op":string,"value":string|number|null}],
  "groupBy": [string],
  "aggregates": [{"fn":string,"column":string,"as":string}],
  "columns": [string],               // for row results: which columns to return
  "sort": [{"column":string,"dir":"asc"|"desc"}],
  "limit": integer
}

Filter ops: eq neq gt gte lt lte contains startsWith endsWith isEmpty notEmpty
Aggregate fns: sum avg count countDistinct min max`
}

/**
 * Build the system prompt for format actions.
 */
export function buildFormatSystemPrompt() {
    return `You are a spreadsheet formatting assistant. Your ONLY job is to translate formatting instructions into a structured JSON format_sheet action.

RULES:
- Respond with EXACTLY ONE JSON object (or wrap in \`\`\`json code fence).
- Row 1 is the header row. The body is row 2 to last used row.
- Column indices are 0-based integers within the used range.
- Column widths: 30–600 pixels.
- Font sizes: 8–24.
- Colors: 6-digit hex (#rrggbb) or "white".
- numberFormat: "general" | "number" | "currency" | "percent" | "date"
- freezeRows: integer (0 = unfreeze) or null (unchanged)

FORMAT_SHEET SCHEMA:
{
  "type": "format_sheet",
  "clearFormatting": boolean,
  "headerStyle": { "bold":bool,"italic":bool,"underline":bool,"bg":"#rrggbb","color":"#rrggbb","align":"left"|"center"|"right","fontSize":int },
  "bodyStyle": { ...same style... },
  "totalsStyle": { ...same style... },
  "columns": [{"col": int, "style": {...}}],
  "freezeRows": int|null,
  "columnWidths": [{"col":int,"width":int}],
  "autoFitColumns": boolean
}`
}

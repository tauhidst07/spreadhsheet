// ─────────────────────────────────────────────────────────────
//  Format-sheet applier — turns a validated formatting intent into
//  concrete style/structure changes. Pure logic (no React, no DOM).
// ─────────────────────────────────────────────────────────────

import { toNum } from '../engine/core.js'

/**
 * Checks whether the last used row qualifies as a totals row: either its
 * first filled cell reads like a total, or it looks like a summary line
 * (a text label followed by numbers with at least one empty column).
 */
export function isTotalsRow(engine, lastUsedRow, minCol, maxCol) {
    if (lastUsedRow < 1) return false

    let firstFilledCol = -1
    let firstFilledRaw = ''
    let filledCount = 0
    let emptyCount = 0
    let numericCount = 0

    for (let c = minCol; c <= maxCol; c++) {
        const raw = engine.getCell(lastUsedRow, c).raw.trim()
        if (raw) {
            filledCount++
            if (firstFilledCol === -1) {
                firstFilledCol = c
                firstFilledRaw = raw
            } else {
                if (toNum(raw) !== null) numericCount++
            }
        } else {
            emptyCount++
        }
    }

    if (filledCount === 0) return false

    // 1. Regex check on first filled cell
    if (/^(grand\s+)?(total|totals|subtotal|sum)\b/i.test(firstFilledRaw)) {
        return true
    }

    // 2. Summary line heuristic:
    // non-numeric label first, then numbers, at least one empty column,
    // at least two filled cells, and not all cells filled.
    const isFirstNonNumeric = toNum(firstFilledRaw) === null
    if (isFirstNonNumeric && filledCount >= 2 && emptyCount >= 1 && numericCount >= 1) {
        return true
    }

    return false
}

/**
 * Applies a format_sheet action to an engine instance.
 * Returns { ok: true, changesMade: boolean, summary: string } or { error, detail }.
 */
export function applyFormatSheet(action, engine) {
    if (!action || action.type !== 'format_sheet') {
        return { error: 'INVALID_ACTION', detail: 'Expected format_sheet action' }
    }

    const used = engine.getUsedRange()
    const usedRowCount = used.rowCount

    // 1. Validate freezeRows against used row count
    if (action.freezeRows !== undefined && action.freezeRows !== null) {
        if (usedRowCount > 0 && action.freezeRows >= usedRowCount) {
            return {
                error: 'OUT_OF_RANGE',
                detail: `freezeRows (${action.freezeRows}) must be less than used row count (${usedRowCount})`,
            }
        }
    }

    if (usedRowCount === 0) {
        return { error: 'NO_CHANGES', detail: 'Sheet has no data' }
    }

    // Capture state before any modification
    const preSnap = engine.takeSnapshot()
    const oldFrozenRows = engine.getFrozenRows()
    const oldWidths = new Map()
    for (let c = used.minCol; c <= used.maxCol; c++) {
        oldWidths.set(c, engine.getColWidth(c))
    }

    const headerRow = used.minRow
    const lastRow = used.maxRow
    const hasBody = usedRowCount > 1
    const hasTotals = isTotalsRow(engine, lastRow, used.minCol, used.maxCol)
    const bodyStartRow = headerRow + 1
    const bodyEndRow = hasTotals ? lastRow - 1 : lastRow

    let modified = false

    // Step A: clearFormatting
    if (action.clearFormatting) {
        for (let r = used.minRow; r <= used.maxRow; r++) {
            for (let c = used.minCol; c <= used.maxCol; c++) {
                const cell = engine.getCell(r, c)
                if (cell.style && Object.keys(cell.style).length > 0) {
                    engine.setCellStyleSilent(r, c, {
                        bold: false, italic: false, underline: false,
                        bg: 'white', color: '#202124', align: 'left',
                        fontSize: 13, numberFormat: 'general'
                    })
                    modified = true
                }
            }
        }
    }

    // Step B: bodyStyle
    if (action.bodyStyle && hasBody && bodyStartRow <= bodyEndRow) {
        for (let r = bodyStartRow; r <= bodyEndRow; r++) {
            for (let c = used.minCol; c <= used.maxCol; c++) {
                engine.setCellStyleSilent(r, c, action.bodyStyle)
                modified = true
            }
        }
    }

    // Step C: columns[]
    if (action.columns && hasBody && bodyStartRow <= bodyEndRow) {
        for (const colEntry of action.columns) {
            const c = colEntry.col
            if (c >= used.minCol && c <= used.maxCol) {
                for (let r = bodyStartRow; r <= bodyEndRow; r++) {
                    engine.setCellStyleSilent(r, c, colEntry.style)
                    modified = true
                }
            }
        }
    }

    // Step D: totalsStyle
    if (action.totalsStyle && hasTotals) {
        for (let c = used.minCol; c <= used.maxCol; c++) {
            engine.setCellStyleSilent(lastRow, c, action.totalsStyle)
            modified = true
        }
    }

    // Step E: headerStyle (applied last so it wins over column alignments)
    if (action.headerStyle) {
        for (let c = used.minCol; c <= used.maxCol; c++) {
            // Header is never number-formatted
            const cleanHeaderStyle = { ...action.headerStyle }
            delete cleanHeaderStyle.numberFormat
            engine.setCellStyleSilent(headerRow, c, cleanHeaderStyle)
            modified = true
        }
    }

    // Step F: freezeRows
    if (action.freezeRows !== undefined && action.freezeRows !== null) {
        if (engine.getFrozenRows() !== action.freezeRows) {
            engine.setFrozenRows(action.freezeRows)
            modified = true
        }
    }

    // Step G: columnWidths
    if (action.columnWidths) {
        for (const cw of action.columnWidths) {
            if (cw.col >= used.minCol && cw.col <= used.maxCol) {
                if (cw.width >= 30 && cw.width <= 600) {
                    if (engine.getColWidth(cw.col) !== cw.width) {
                        engine.setColWidth(cw.col, cw.width)
                        modified = true
                    }
                }
            }
        }
    }

    // Step H: autoFitColumns
    if (action.autoFitColumns) {
        for (let c = used.minCol; c <= used.maxCol; c++) {
            let maxLen = 4
            for (let r = used.minRow; r <= used.maxRow; r++) {
                const cell = engine.getCell(r, c)
                const text = String(cell.formatted || cell.raw || '')
                if (text.length > maxLen) maxLen = text.length
            }
            const autoWidth = Math.min(Math.max(Math.round(maxLen * 8.5 + 24), 65), 350)
            if (engine.getColWidth(c) !== autoWidth) {
                engine.setColWidth(c, autoWidth)
                modified = true
            }
        }
    }

    // If nothing changed, return NO_CHANGES without creating an undo entry
    if (!modified) {
        return { error: 'NO_CHANGES', detail: 'Action caused no visible change' }
    }

    // Record one undo step covering all formatting and structure changes
    engine.recordFormatSheetUndo(preSnap, oldFrozenRows, oldWidths)

    return {
        ok: true,
        changesMade: true,
        summary: describeFormatPreview(action),
    }
}

/**
 * Generates a concise plain-words preview of a format_sheet action.
 * Example: "header: bold, grey; 4 columns: number formats; freeze 1 row; totals row: bold"
 */
export function describeFormatPreview(action) {
    if (!action) return ''
    const parts = []

    if (action.clearFormatting) {
        parts.push('clear formatting')
    }

    if (action.headerStyle) {
        const hParts = []
        if (action.headerStyle.bold) hParts.push('bold')
        if (action.headerStyle.bg) hParts.push(action.headerStyle.bg === '#f0f0f0' ? 'grey' : action.headerStyle.bg)
        if (action.headerStyle.align) hParts.push(action.headerStyle.align)
        parts.push(`header: ${hParts.join(', ') || 'styled'}`)
    }

    if (action.columns && action.columns.length > 0) {
        const numCols = action.columns.filter(c => c.style?.numberFormat).length
        if (numCols > 0) {
            parts.push(`${numCols} columns: number formats`)
        } else {
            parts.push(`${action.columns.length} columns styled`)
        }
    }

    if (action.bodyStyle) {
        const bParts = []
        if (action.bodyStyle.fontSize) bParts.push(`font size ${action.bodyStyle.fontSize}`)
        if (action.bodyStyle.color) bParts.push(`color ${action.bodyStyle.color}`)
        parts.push(`body: ${bParts.join(', ') || 'styled'}`)
    }

    if (action.freezeRows !== undefined && action.freezeRows !== null) {
        if (action.freezeRows === 0) parts.push('unfreeze header')
        else parts.push(`freeze ${action.freezeRows} row${action.freezeRows > 1 ? 's' : ''}`)
    }

    if (action.totalsStyle) {
        const tParts = []
        if (action.totalsStyle.bold) tParts.push('bold')
        parts.push(`totals row: ${tParts.join(', ') || 'styled'}`)
    }

    if (action.autoFitColumns) {
        parts.push('auto-fit columns')
    }

    return parts.join('; ')
}

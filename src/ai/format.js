// Pure format_sheet applier (AI_CONTRACT.md §4). It turns a validated action
// into a style plan the engine applies as one undo step; it never touches values.

import { applyNumberFormat, looksLikeTotalsRow } from '../engine/values.js'
import { normalizeStyle } from '../engine/core.js'

/**
 * @param view {{ matrix: string[][], styleAt: (r, c) => object, frozenRows: number,
 *               measure: (text: string, style: object) => number }}
 *        matrix is the used range as display text (row 0 = header).
 * @returns {{ code: 'OUT_OF_RANGE' | 'NO_CHANGES', detail?: string } | { code: 'PLAN', plan, summary: string[] }}
 */
export function planFormat(view, action) {
  const { matrix } = view
  const rowCount = matrix.length, colCount = Math.max(0, ...matrix.map(r => r.length))
  if (!rowCount || !colCount) return { code: 'NO_CHANGES', detail: 'The sheet is empty' }
  if (typeof action.freezeRows === 'number' && action.freezeRows >= rowCount) {
    return { code: 'OUT_OF_RANGE', detail: `Freezing ${action.freezeRows} rows would freeze all ${rowCount} used rows` }
  }

  const styles = new Map(), key = (r, c) => r * colCount + c
  const get = (r, c) => styles.get(key(r, c)) ?? view.styleAt(r, c) ?? {}
  const merge = (r, c, patch) => styles.set(key(r, c), normalizeStyle({ ...get(r, c), ...patch }))
  const last = rowCount - 1, hasBody = rowCount > 1
  const totals = hasBody && looksLikeTotalsRow(matrix[last])
  const summary = []

  if (action.clearFormatting) {
    for (let r = 0; r < rowCount; r++) for (let c = 0; c < colCount; c++) styles.set(key(r, c), {})
    summary.push('clear existing formatting')
  }
  if (action.bodyStyle && hasBody) {
    for (let r = 1; r <= last; r++) for (let c = 0; c < colCount; c++) merge(r, c, action.bodyStyle)
    summary.push(`body: ${describeStyle(action.bodyStyle)}`)
  }
  const columns = (action.columns ?? []).filter(item => item.col >= 0 && item.col < colCount)
  if (hasBody) for (const item of columns) for (let r = 1; r <= last; r++) merge(r, item.col, item.style)
  if (columns.length) summary.push(`${columns.length} column${columns.length > 1 ? 's' : ''}: ${[...new Set(columns.map(i => describeStyle(i.style)))].join('; ')}`)
  if (action.totalsStyle && totals) {
    for (let c = 0; c < colCount; c++) merge(last, c, action.totalsStyle)
    summary.push(`totals row: ${describeStyle(action.totalsStyle)}`)
  }
  if (action.headerStyle) {
    const { numberFormat: _numberFormat, ...header } = action.headerStyle
    for (let c = 0; c < colCount; c++) merge(0, c, header)
    summary.push(`header: ${describeStyle(header)}`)
  }

  const widths = new Map()
  for (const item of action.columnWidths ?? []) {
    if (item.col >= 0 && item.col < colCount && item.width >= 30 && item.width <= 600) widths.set(item.col, item.width)
  }
  if (widths.size) summary.push(`set ${widths.size} column width${widths.size > 1 ? 's' : ''}`)
  if (typeof action.freezeRows === 'number') summary.push(action.freezeRows ? `freeze ${action.freezeRows} row${action.freezeRows > 1 ? 's' : ''}` : 'unfreeze rows')
  if (action.autoFitColumns) {
    for (let c = 0; c < colCount; c++) {
      let width = 0
      for (let r = 0; r < rowCount; r++) {
        const style = get(r, c), text = applyNumberFormat(matrix[r][c] ?? '', style.numberFormat)
        if (text) width = Math.max(width, view.measure(text, style))
      }
      if (width) widths.set(c, Math.round(Math.max(30, Math.min(600, width + 16))))
    }
    summary.push('auto-fit column widths')
  }

  const plan = {
    styles: [...styles].map(([k, style]) => [Math.floor(k / colCount), k % colCount, style]),
    widths: [...widths],
    frozenRows: typeof action.freezeRows === 'number' ? action.freezeRows : undefined,
  }
  return { code: 'PLAN', plan, summary }
}

function describeStyle(style) {
  const words = []
  if (style.bold) words.push('bold')
  if (style.italic) words.push('italic')
  if (style.underline) words.push('underline')
  if (style.bg) words.push(`background ${style.bg}`)
  if (style.color) words.push(`text ${style.color}`)
  if (style.align) words.push(`${style.align}-aligned`)
  if (style.fontSize) words.push(`${style.fontSize}px`)
  if (style.numberFormat) words.push(`${style.numberFormat} format`)
  return words.join(', ') || 'plain'
}

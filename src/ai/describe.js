// Plain-words descriptions of AI actions, for result cards and previews.

const COLOUR_NAMES = {
    '#f0f0f0': 'grey', '#ffff99': 'yellow', '#99ffcc': 'green', '#ffcccc': 'red',
    '#cce5ff': 'blue', '#e0ccff': 'purple', '#ffd9b3': 'orange', white: 'white', '#ffffff': 'white',
}

const FORMAT_NAMES = { general: 'general', number: 'number (1,200.00)', currency: 'currency ($1,200.00)', percent: 'percent (10%)', date: 'date (2024-01-15)' }

const OP_WORDS = {
    eq: 'is', neq: 'is not', gt: '>', gte: '≥', lt: '<', lte: '≤',
    contains: 'contains', startsWith: 'starts with', endsWith: 'ends with', isEmpty: 'is empty', notEmpty: 'is not empty',
}

const FN_WORDS = { sum: 'total', avg: 'average', count: 'count', countDistinct: 'number of distinct', min: 'lowest', max: 'highest' }

const colour = (hex) => COLOUR_NAMES[String(hex).toLowerCase()] ?? hex

export function describeStyle(style) {
    const parts = []
    if (style.bold !== undefined) parts.push(style.bold ? 'bold' : 'not bold')
    if (style.italic !== undefined) parts.push(style.italic ? 'italic' : 'not italic')
    if (style.underline !== undefined) parts.push(style.underline ? 'underlined' : 'no underline')
    if (style.bg) parts.push(`${colour(style.bg)} fill`)
    if (style.color) parts.push(`${colour(style.color)} text`)
    if (style.align) parts.push(`${style.align}-aligned`)
    if (style.fontSize) parts.push(`size ${style.fontSize}`)
    if (style.numberFormat) parts.push(FORMAT_NAMES[style.numberFormat] ?? style.numberFormat)
    return parts.join(', ')
}

export function describeQuery(plan) {
    const parts = []
    const filters = plan.filters ?? []
    if (filters.length) {
        parts.push('Rows where ' + filters.map(f =>
            ['isEmpty', 'notEmpty'].includes(f.op) ? `${f.column} ${OP_WORDS[f.op]}` : `${f.column} ${OP_WORDS[f.op] ?? f.op} ${JSON.stringify(f.value)}`,
        ).join(' and '))
    } else parts.push('All rows')
    if (plan.excludeTotalsRow === false) parts.push('including the totals row')
    if (plan.groupBy?.length) parts.push(`grouped by ${plan.groupBy.join(' and ')}`)
    if (plan.aggregates?.length) {
        parts.push('showing ' + plan.aggregates.map(a => `${FN_WORDS[a.fn] ?? a.fn} of ${a.column}${a.as ? ` as “${a.as}”` : ''}`).join(', '))
    } else if (plan.columns?.length) parts.push(`showing ${plan.columns.join(', ')}`)
    if (plan.sort?.length) parts.push('sorted by ' + plan.sort.map(s => `${s.column} ${s.dir === 'desc' ? 'high → low' : 'low → high'}`).join(', then '))
    if (plan.limit) parts.push(plan.limit > 500 ? `limit ${plan.limit} (capped at 500)` : `top ${plan.limit}`)
    return parts.join(', ') + '.'
}

/** Preview lines like "header: bold, grey fill", "4 columns: number formats", "freeze 1 row". */
export function describeFormat(action, plan, columnNames = []) {
    const lines = []
    const name = (i) => columnNames[i] ? `${columnNames[i]}` : `column ${i + 1}`
    if (action.clearFormatting) lines.push('clear all formatting in the table')
    if (action.headerStyle) {
        const { numberFormat: _skip, ...rest } = action.headerStyle
        lines.push(`header: ${describeStyle(rest) || 'no change'}`)
    }
    if (action.bodyStyle) lines.push(`body: ${describeStyle(action.bodyStyle)}`)
    const cols = action.columns ?? []
    const inside = cols.filter(c => c.col < columnNames.length || !columnNames.length)
    const outside = cols.filter(c => columnNames.length && c.col >= columnNames.length)
    if (inside.length) {
        const formats = inside.filter(c => c.style.numberFormat).length
        lines.push(`${inside.length} column${inside.length > 1 ? 's' : ''}${formats ? ': number formats' : ''} — ` +
            inside.map(c => `${name(c.col)}: ${describeStyle(c.style)}`).join('; '))
    }
    if (outside.length) lines.push(`ignored: ${outside.map(c => `column ${c.col + 1}`).join(', ')} (outside the ${columnNames.length}-column table)`)
    if (action.totalsStyle) {
        lines.push(plan?.totalsDropped
            ? 'totals row: skipped — the last row is not a totals row'
            : `totals row: ${describeStyle(action.totalsStyle)}`)
    }
    if (typeof action.freezeRows === 'number') {
        lines.push(action.freezeRows === 0 ? 'unfreeze rows' : `freeze ${action.freezeRows} row${action.freezeRows > 1 ? 's' : ''}`)
    }
    if (action.columnWidths?.length) lines.push(`set ${action.columnWidths.length} column width${action.columnWidths.length > 1 ? 's' : ''}`)
    if (action.autoFitColumns) lines.push('auto-fit column widths')
    return lines
}

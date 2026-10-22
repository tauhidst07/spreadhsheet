// Loads a fixture TSV into the engine starting at A1.
// Writes every cell in a single batched setRange so large fixtures
// import in one pass (and as one undo step).
import salesSmall from '../../fixtures/sales.tsv?raw'
import salesLarge from '../../fixtures/sales-large.tsv?raw'

export function parseTsv(text) {
    const lines = text.replace(/\r\n?/g, '\n').split('\n')
    if (lines.length && lines[lines.length - 1] === '') lines.pop()
    return lines.map(line => line.split('\t'))
}

function loadTsv(engine, text) {
    const rows = parseTsv(text)
    const cols = Math.max(...rows.map(r => r.length))
    engine.ensureCapacity(rows.length + 20, cols + 5)
    const updates = []
    for (let r = 0; r < rows.length; r++) {
        for (let c = 0; c < rows[r].length; c++) {
            const val = rows[r][c]
            if (val !== undefined && val !== '') {
                updates.push({ r, c, raw: val })
            }
        }
    }
    engine.setRange(updates, 'Load Sample')
    return { rows: rows.length, cols }
}

/** 33 lines: header, 31 messy data rows, totals row. */
export function loadSampleSmall(engine) {
    return loadTsv(engine, salesSmall)
}

/** ~3,000 lines of the same kind of data. */
export function loadSampleLarge(engine) {
    return loadTsv(engine, salesLarge)
}

// Replaces the sheet with a fixture TSV starting at A1, as one undo step.
// The ~250 KB large sample is fetched on demand so it is not in the main bundle.
import salesSmall from '../../fixtures/sales.tsv?raw'

export function parseTsv(text) {
    const lines = text.replace(/\r\n?/g, '\n').split('\n')
    if (lines.length && lines[lines.length - 1] === '') lines.pop()
    return lines.map(line => line.split('\t'))
}

export function loadTsv(engine, text) {
    const rows = parseTsv(text)
    const cols = Math.max(...rows.map(r => r.length))
    engine.ensureCapacity(rows.length + 20, cols + 5)
    engine.batch('Load sample', () => {
        engine.clearAll() // a sample replaces the sheet, it is not pasted over it
        engine.setRange(0, 0, rows, 'Load sample')
    })
    return { rows: rows.length, cols }
}

export const sampleSmallText = async () => salesSmall
export const sampleLargeText = async () => (await import('../../fixtures/sales-large.tsv?raw')).default

/** 33 lines: header, 31 messy data rows, totals row. */
export function loadSampleSmall(engine) {
    return loadTsv(engine, salesSmall)
}

/** ~3,000 lines of the same kind of data. */
export async function loadSampleLarge(engine) {
    return loadTsv(engine, await sampleLargeText())
}

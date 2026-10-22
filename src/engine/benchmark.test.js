import { describe, it, expect } from 'vitest'
import { createEngine } from './core.js'
import { loadSampleLarge } from '../fixtures/loadSample.js'
import { executeQuery } from '../ai/executor.js'
import { applyFormatSheet } from '../ai/applier.js'
import queriesFixtures from '../../fixtures/ai-eval/queries.json'

describe('Performance Budget Measurements', () => {
    it('Budget 1: Filling 5,000 cells completes in under 200 ms', () => {
        const engine = createEngine(6000, 10)
        engine.setCell(0, 0, '1')
        engine.setCell(1, 0, '2')

        const start = performance.now()
        engine.applyFill({
            seedStartRow: 0, seedStartCol: 0,
            seedEndRow: 1, seedEndCol: 0,
            targetStartRow: 0, targetStartCol: 0,
            targetEndRow: 5000, targetEndCol: 0,
        })
        const duration = performance.now() - start

        console.log(`[MEASUREMENT] Filling 5,000 cells: ${duration.toFixed(2)} ms (Budget: < 200 ms)`)
        expect(duration).toBeLessThan(200)
        expect(engine.getCell(5000, 0).raw).toBe('5001')
    })

    it('Budget 2: Sorting 10,000 rows takes under 300 ms', () => {
        const engine = createEngine(10500, 5)
        const updates = []
        // Populate 10,000 rows with randomized numbers
        for (let r = 1; r <= 10000; r++) {
            updates.push({ r, c: 0, raw: `Item ${r}` })
            updates.push({ r, c: 1, raw: String((r * 37) % 10000) })
        }
        engine.setRange(updates, 'Populate 10k rows')

        const start = performance.now()
        engine.sortRange({ r1: 1, r2: 10000, col: 1, dir: 'asc' })
        const duration = performance.now() - start

        console.log(`[MEASUREMENT] Sorting 10,000 rows: ${duration.toFixed(2)} ms (Budget: < 300 ms)`)
        expect(duration).toBeLessThan(300)
    })

    it('Budget 2b: Sort sales-large.tsv by Date and report time', () => {
        const engine = createEngine(3500, 15)
        loadSampleLarge(engine)

        // Find Date column (col index 1)
        const start = performance.now()
        engine.sortRange({ col: 1, dir: 'asc' })
        const duration = performance.now() - start

        console.log(`[MEASUREMENT] Sorting sales-large.tsv (~3,000 rows) by Date: ${duration.toFixed(2)} ms`)
        expect(duration).toBeLessThan(300)
    })

    it('Budget 3: Keystroke latency with 50,000 filled cells recalculating dependent cells', () => {
        const engine = createEngine(100000, 20)
        const updates = []
        // Populate 50,000 cells (5,000 rows x 10 cols)
        for (let r = 0; r < 5000; r++) {
            for (let c = 0; c < 10; c++) {
                updates.push({ r, c, raw: String(r + c) })
            }
        }
        engine.setRange(updates, 'Populate 50k cells')

        // Edit a single cell
        const start = performance.now()
        engine.setCell(2500, 5, '99999')
        const duration = performance.now() - start

        console.log(`[MEASUREMENT] Single cell edit latency with 50,000 filled cells: ${duration.toFixed(2)} ms (Budget: < 16 ms)`)
        expect(duration).toBeLessThan(16)
    })

    it('Budget 4: Golden query plans over sales-large.tsv run in under 50 ms', () => {
        const engine = createEngine(3500, 15)
        loadSampleLarge(engine)

        for (const testCase of queriesFixtures.cases.slice(0, 5)) {
            const start = performance.now()
            executeQuery(testCase.plan, engine)
            const duration = performance.now() - start
            console.log(`[MEASUREMENT] Query "${testCase.prompt}": ${duration.toFixed(2)} ms (Budget: < 50 ms)`)
            expect(duration).toBeLessThan(50)
        }
    })

    it('Budget 4b: Two-level group-by over 100,000 generated rows in under 500 ms', () => {
        const engine = createEngine(100100, 5)
        engine.setCell(0, 0, 'Region')
        engine.setCell(0, 1, 'Category')
        engine.setCell(0, 2, 'Amount')

        const regions = ['North', 'South', 'East', 'West', 'Central']
        const categories = ['Electronics', 'Furniture', 'Accessories', 'Software']

        const updates = []
        for (let r = 1; r <= 100000; r++) {
            updates.push({ r, c: 0, raw: regions[r % regions.length] })
            updates.push({ r, c: 1, raw: categories[r % categories.length] })
            updates.push({ r, c: 2, raw: String((r * 13) % 500) })
        }
        engine.setRange(updates, 'Populate 100k rows')

        const plan = {
            type: 'query',
            groupBy: ['Region', 'Category'],
            aggregates: [{ fn: 'sum', column: 'Amount', as: 'TotalAmount' }],
        }

        const start = performance.now()
        const result = executeQuery(plan, engine)
        const duration = performance.now() - start

        console.log(`[MEASUREMENT] Two-level group-by over 100,000 rows: ${duration.toFixed(2)} ms (Budget: < 500 ms)`)
        expect(duration).toBeLessThan(500)
        expect(result.rows.length).toBe(20) // 5 regions * 4 categories
    })

    it('Budget 5: Applying format on sales-large.tsv in under 300 ms', () => {
        const engine = createEngine(3500, 15)
        loadSampleLarge(engine)

        const action = {
            type: 'format_sheet',
            headerStyle: { bold: true, bg: '#f0f0f0', align: 'center' },
            columns: [
                { col: 6, style: { align: 'right', numberFormat: 'number' } },
                { col: 7, style: { align: 'right', numberFormat: 'currency' } },
                { col: 8, style: { align: 'right', numberFormat: 'percent' } },
                { col: 9, style: { align: 'right', numberFormat: 'currency' } }
            ],
            totalsStyle: { bold: true },
            freezeRows: 1,
            autoFitColumns: true
        }

        const start = performance.now()
        const res = applyFormatSheet(action, engine)
        const duration = performance.now() - start

        console.log(`[MEASUREMENT] Formatting sales-large.tsv (~3,000 rows): ${duration.toFixed(2)} ms (Budget: < 300 ms)`)
        expect(duration).toBeLessThan(300)
        expect(res.ok).toBe(true)
    })
})

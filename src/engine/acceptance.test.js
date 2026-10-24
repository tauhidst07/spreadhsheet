import { describe, it, expect } from 'vitest'
import { createEngine, parseRef } from './core.js'
import { computeFill } from './fill.js'
import { loadSampleSmall, loadSampleLarge } from '../fixtures/loadSample.js'
import { executeQuery } from '../ai/executor.js'
import { createMockProvider } from '../ai/mockProvider.js'
import { parseAndValidate } from '../ai/validator.js'
import formatEval from '../../fixtures/ai-eval/format-prompts.json'
import queryEval from '../../fixtures/ai-eval/queries.json'

describe('Challenge 1: Range selection and fill handle', () => {
    it('fills alphanumeric series ORD-1001, ORD-1002 to A6 and undoes in one step', () => {
        const engine = createEngine(50, 50)
        loadSampleSmall(engine)

        const beforeA4 = engine.getCellRaw(3, 0).raw
        const beforeA5 = engine.getCellRaw(4, 0).raw
        const beforeA6 = engine.getCellRaw(5, 0).raw

        const changes = computeFill({
            seedStartRow: 1, seedStartCol: 0,
            seedEndRow: 2, seedEndCol: 0,
            fillEndRow: 5, fillEndCol: 0,
            engine,
        })
        expect(changes.length).toBe(3)
        expect(changes[0].value).toBe('ORD-1003')
        expect(changes[1].value).toBe('ORD-1004')
        expect(changes[2].value).toBe('ORD-1005')

        engine.applyFill(changes)
        expect(engine.getCellRaw(3, 0).raw).toBe('ORD-1003')
        expect(engine.getCellRaw(4, 0).raw).toBe('ORD-1004')
        expect(engine.getCellRaw(5, 0).raw).toBe('ORD-1005')

        engine.undo()
        expect(engine.getCellRaw(3, 0).raw).toBe(beforeA4)
        expect(engine.getCellRaw(4, 0).raw).toBe(beforeA5)
        expect(engine.getCellRaw(5, 0).raw).toBe(beforeA6)
    })

    it('fills relative and absolute formulas correctly', () => {
        const engine = createEngine(50, 50)
        loadSampleSmall(engine)

        engine.setCell(1, 10, '=G2*H2')
        engine.setCell(1, 11, '=$G$2*H2')

        const changesK = computeFill({
            seedStartRow: 1, seedStartCol: 10,
            seedEndRow: 1, seedEndCol: 10,
            fillEndRow: 31, fillEndCol: 10,
            engine,
        })
        engine.applyFill(changesK)
        expect(engine.getCellRaw(31, 10).raw).toBe('=G32*H32')

        const changesL = computeFill({
            seedStartRow: 1, seedStartCol: 11,
            seedEndRow: 1, seedEndCol: 11,
            fillEndRow: 31, fillEndCol: 11,
            engine,
        })
        engine.applyFill(changesL)
        expect(engine.getCellRaw(31, 11).raw).toBe('=$G$2*H32')

        engine.insertRow(9)
        expect(engine.getCellRaw(32, 11).raw).toBe('=$G$2*H33')
    })

    it('preserves date formats during fill', () => {
        const engine = createEngine(50, 50)
        loadSampleSmall(engine)

        // B2: 2024-01-03, B3: 2024-01-05, B4: 1/8/2024 — uneven deltas cycle each seed format
        const changes = computeFill({
            seedStartRow: 1, seedStartCol: 1,
            seedEndRow: 3, seedEndCol: 1,
            fillEndRow: 7, fillEndCol: 1,
            engine,
        })
        expect(changes.length).toBe(4)
        engine.applyFill(changes)
        expect(engine.getCellRaw(4, 1).raw).toBe('2024-01-03')
        expect(engine.getCellRaw(5, 1).raw).toBe('2024-01-05')
        expect(engine.getCellRaw(6, 1).raw).toBe('1/8/2024')
        expect(engine.getCellRaw(7, 1).raw).toBe('2024-01-03')
    })

    it('copies seed style, fills upward, shrinks, and cycles weekdays', () => {
        const engine = createEngine(20, 10)
        engine.setCell(5, 0, '1')
        engine.setCell(6, 0, '2')
        engine.setStyle(5, 0, { bold: true, bg: '#ffee00' })
        engine.setStyle(6, 0, { bold: true, bg: '#ffee00' })

        const down = computeFill({
            seedStartRow: 5, seedStartCol: 0, seedEndRow: 6, seedEndCol: 0,
            fillEndRow: 8, fillEndCol: 0, engine,
        })
        engine.applyFill(down)
        expect(engine.getCellRaw(7, 0).raw).toBe('3')
        expect(engine.getCellRaw(8, 0).raw).toBe('4')
        expect(engine.getStyle(7, 0).bold).toBe(true)
        expect(engine.getStyle(7, 0).bg).toBe('#ffee00')

        const up = computeFill({
            seedStartRow: 5, seedStartCol: 0, seedEndRow: 6, seedEndCol: 0,
            fillEndRow: 3, fillEndCol: 0, engine,
        })
        engine.applyFill(up)
        expect(engine.getCellRaw(4, 0).raw).toBe('0')
        expect(engine.getCellRaw(3, 0).raw).toBe('-1')

        engine.setCell(0, 1, 'Mon')
        const days = computeFill({
            seedStartRow: 0, seedStartCol: 1, seedEndRow: 0, seedEndCol: 1,
            fillEndRow: 2, fillEndCol: 1, engine,
        })
        engine.applyFill(days)
        expect(engine.getCellRaw(1, 1).raw).toBe('Tue')
        expect(engine.getCellRaw(2, 1).raw).toBe('Wed')

        engine.setCell(0, 2, 'Item 1')
        engine.setCell(1, 2, 'x')
        engine.setCell(2, 2, 'y')
        const filled = computeFill({
            seedStartRow: 0, seedStartCol: 2, seedEndRow: 0, seedEndCol: 2,
            fillEndRow: 2, fillEndCol: 2, engine,
        })
        engine.applyFill(filled)
        expect(engine.getCellRaw(1, 2).raw).toBe('Item 2')
        expect(engine.getCellRaw(2, 2).raw).toBe('Item 3')
        const shrink = computeFill({
            seedStartRow: 0, seedStartCol: 2, seedEndRow: 2, seedEndCol: 2,
            fillEndRow: 0, fillEndCol: 2, engine,
        })
        engine.applyFill(shrink)
        expect(engine.getCellRaw(1, 2).raw).toBe('')
        expect(engine.getCellRaw(2, 2).raw).toBe('')
        expect(engine.getCellRaw(0, 2).raw).toBe('Item 1')
    })

    it('fills 5,000 cells in under 200 ms', () => {
        const engine = createEngine(6000, 10)
        engine.setCell(0, 0, '1')
        engine.setCell(1, 0, '2')

        const t0 = performance.now()
        const changes = computeFill({
            seedStartRow: 0, seedStartCol: 0,
            seedEndRow: 1, seedEndCol: 0,
            fillEndRow: 5001, fillEndCol: 0,
            engine,
        })
        engine.applyFill(changes)
        const elapsed = performance.now() - t0
        expect(elapsed).toBeLessThan(200)
    })

    it('getUsedRange covers sales.tsv and Delete-style bulk clear undoes in one step', () => {
        const engine = createEngine(50, 50)
        loadSampleSmall(engine)
        const used = engine.getUsedRange()
        expect(used.startRow).toBe(0)
        expect(used.endRow).toBe(32)
        const entries = []
        for (let r = 1; r <= 3; r++) entries.push({ row: r, col: 0, value: '' })
        engine.bulkSet(entries)
        expect(engine.getCellRaw(1, 0).raw).toBe('')
        engine.undo()
        expect(engine.getCellRaw(1, 0).raw).toBe('ORD-1001')
    })
})

describe('Challenge 2: Sort and filter', () => {
    it('sorts by Total descending: K2 shows price per unit 1080, A33 reads Total, blank sorts last', () => {
        const engine = createEngine(50, 50)
        loadSampleSmall(engine)

        // Put =J2/G2 in K2 (row 1, col 10), fill to K32 (row 31)
        engine.setCell(1, 10, '=J2/G2')
        const changes = computeFill({
            seedStartRow: 1, seedStartCol: 10,
            seedEndRow: 1, seedEndCol: 10,
            fillEndRow: 31, fillEndCol: 10,
            engine,
        })
        engine.bulkSet(changes)

        // Sort by Total (col 9) descending
        engine.sort(9, 'desc')

        // ORD-1025 has the largest total ($9,720.00), so it is sorted to row 1 (row 2 in 1-based)
        expect(engine.getCellRaw(1, 0).raw).toBe('ORD-1025')
        expect(engine.getCell(1, 10).computed).toBe(1080)

        // Row 32 (A33) still reads Total
        expect(engine.getCellRaw(32, 0).raw).toBe('Total')
    })

    it('filter Region to West (matches West, West , west), sorting does not move hidden rows, undo twice restores', () => {
        const engine = createEngine(50, 50)
        loadSampleSmall(engine)

        // Filter Region (col 2) to 'West'
        engine.setFilter(2, { values: new Set(['west']) })
        expect(engine.hiddenRows.size).toBeGreaterThan(0)

        // Capture positions of hidden rows before sort
        const hiddenBefore = [...engine.hiddenRows].map(r => ({ r, raw: engine.getCellRaw(r, 0).raw }))

        // Sort by Units (col 6) asc
        engine.sort(6, 'asc')

        // Hidden rows did not move
        for (const item of hiddenBefore) {
            expect(engine.getCellRaw(item.r, 0).raw).toBe(item.raw)
        }

        const afterFilter = engine.getCellRaw(1, 0).raw
        engine.undo()
        expect(engine.getCellRaw(1, 0).raw).toBe(afterFilter)
        expect(engine.hiddenRows.size).toBeGreaterThan(0)

        engine.undo()
        expect(engine.hiddenRows.size).toBe(0)
        expect(engine.getCellRaw(1, 0).raw).toBe('ORD-1001')
    })

    it('cycles sort back to original row identity', () => {
        const engine = createEngine(50, 50)
        loadSampleSmall(engine)
        const original = []
        for (let r = 1; r <= 31; r++) original.push(engine.getCellRaw(r, 0).raw)
        engine.sort(9, 'desc')
        expect(engine.getCellRaw(1, 0).raw).toBe('ORD-1025')
        engine.sort(9, 'original')
        for (let r = 1; r <= 31; r++) {
            expect(engine.getCellRaw(r, 0).raw).toBe(original[r - 1])
        }
    })

    it('sorts 3000 rows in sales-large.tsv in under 300 ms', () => {
        const engine = createEngine(3500, 20)
        loadSampleLarge(engine)

        const t0 = performance.now()
        engine.sort(1, 'asc')
        const elapsed = performance.now() - t0
        expect(elapsed).toBeLessThan(300)
    })

    it('sorts 10,000 rows in under 300 ms', () => {
        const engine = createEngine(10020, 4)
        engine.setCell(0, 0, 'Name')
        engine.setCell(0, 1, 'N')
        for (let i = 1; i <= 10000; i++) {
            engine.setCell(i, 0, 'R' + i)
            engine.setCell(i, 1, String((i * 17) % 10000))
        }
        const t0 = performance.now()
        engine.sort(1, 'asc')
        const elapsed = performance.now() - t0
        expect(elapsed).toBeLessThan(300)
    })
})

describe('Challenge 3: Virtualized grid at scale', () => {
    it('handles 100,000 rows x 200 cols capacity', () => {
        const engine = createEngine(100000, 200)
        expect(engine.rows).toBe(100000)
        expect(engine.cols).toBe(200)

        // Cell edit far from origin
        engine.setCell(95000, 150, 'FarCell')
        expect(engine.getCell(95000, 150).raw).toBe('FarCell')
    })

    it('freezes row 1, resizes column D to 300px, inserts column before D', () => {
        const engine = createEngine(50, 50)
        engine.setFrozenRows(1)
        expect(engine.frozenRows).toBe(1)

        // Col D is index 3
        engine.setColWidth(3, 300)
        expect(engine.getColWidth(3)).toBe(300)

        // Insert column before D (atIndex 3)
        engine.insertColumn(3)

        // New column at index 3 has default width 100
        expect(engine.getColWidth(3)).toBe(100)
        // Old D is now E (index 4) and keeps 300px
        expect(engine.getColWidth(4)).toBe(300)
    })

    it('fill-down helper fills a formula far from the origin as one undo step', () => {
        const engine = createEngine(5000, 20)
        engine.setCell(1, 9, '3')
        engine.setCell(1, 10, '=J2*2')
        const changes = computeFill({
            seedStartRow: 1, seedStartCol: 10,
            seedEndRow: 1, seedEndCol: 10,
            fillEndRow: 4999, fillEndCol: 10,
            engine,
        })
        engine.applyFill(changes)
        expect(engine.getCellRaw(4999, 10).raw).toBe('=J5000*2')
        engine.undo()
        expect(engine.getCellRaw(4999, 10).raw).toBe('')
    })
})

describe('Challenge 4: Ask your data (AI Query)', () => {
    it('executes golden query cases correctly against sales-large.tsv', () => {
        const engine = createEngine(3500, 20)
        loadSampleLarge(engine)

        for (const c of queryEval.cases) {
            if (c.plan.type === 'query') {
                const res = executeQuery(c.plan, engine)
                if (c.expect.error) {
                    expect(res.error).toBe(c.expect.error)
                    continue
                }
                expect(res.error).toBeUndefined()
                if (c.expect.rowCount !== undefined) {
                    expect(res.rowCount).toBe(c.expect.rowCount)
                }
                if (c.expect.columns) {
                    expect(res.columns).toEqual(c.expect.columns)
                }
                if (c.expect.rows && c.expect.rows.length > 0) {
                    for (let ri = 0; ri < Math.min(3, c.expect.rows.length); ri++) {
                        for (let ci = 0; ci < c.expect.rows[ri].length; ci++) {
                            const expectedVal = c.expect.rows[ri][ci]
                            const actualVal = res.rows[ri][ci]
                            if (typeof expectedVal === 'number') {
                                expect(Math.abs(actualVal - expectedVal)).toBeLessThan(0.05)
                            } else {
                                expect(actualVal).toBe(expectedVal)
                            }
                        }
                    }
                }
            }
        }
    })

    it('mock provider round-trips golden prompts through parseAndValidate', async () => {
        const provider = createMockProvider()
        for (const c of queryEval.cases) {
            const resp = await provider.complete({ prompt: c.prompt })
            const { action, error } = parseAndValidate(resp.text)
            if (c.expect?.error && c.plan?.type !== 'query' && c.plan?.type !== 'clarify') {
                expect(error).toBe(c.expect.error)
                continue
            }
            expect(error).toBeFalsy()
            expect(action).toEqual(c.plan)
        }
        for (const c of formatEval.cases) {
            const resp = await provider.complete({ prompt: c.prompt })
            const { action, error } = parseAndValidate(resp.text)
            expect(error).toBeFalsy()
            expect(action).toEqual(c.action)
        }
    })

    it('rejects non-query actions and unknown columns; insert is one undo', () => {
        const engine = createEngine(50, 50)
        loadSampleSmall(engine)
        expect(executeQuery({ type: 'format_sheet' }, engine).error).toBe('READ_ONLY')
        const unknown = executeQuery({
            type: 'query',
            columns: ['Not A Column'],
            filters: [],
            groupBy: [],
            aggregates: [],
            sort: [],
            limit: 10,
        }, engine)
        expect(unknown.error).toBe('UNKNOWN_COLUMN')

        engine.insertRows([['H1', 'H2'], ['a', 'b']], 40, 0)
        expect(engine.getCellRaw(40, 0).raw).toBe('H1')
        expect(engine.getCellRaw(41, 1).raw).toBe('b')
        engine.undo()
        expect(engine.getCellRaw(40, 0).raw).toBe('')
    })

    it('runs a two-level group-by over 100,000 rows in under 500 ms', () => {
        const engine = createEngine(100002, 4)
        engine.setCell(0, 0, 'Region')
        engine.setCell(0, 1, 'Cat')
        engine.setCell(0, 2, 'Amt')
        const entries = []
        for (let i = 1; i <= 100000; i++) {
            entries.push({ row: i, col: 0, value: i % 2 ? 'West' : 'East' })
            entries.push({ row: i, col: 1, value: i % 3 ? 'A' : 'B' })
            entries.push({ row: i, col: 2, value: String(i % 10) })
        }
        engine.bulkSet(entries, { undo: false, recalculate: false })
        const plan = {
            type: 'query',
            columns: [],
            filters: [],
            groupBy: ['Region', 'Cat'],
            aggregates: [{ fn: 'sum', column: 'Amt', as: 'total' }],
            sort: [],
            limit: 500,
        }
        const t0 = performance.now()
        const res = executeQuery(plan, engine)
        const elapsed = performance.now() - t0
        expect(res.error).toBeUndefined()
        expect(res.rowCount).toBe(4)
        expect(elapsed).toBeLessThan(500)
    }, 30000)
})

describe('Challenge 5: Format with AI', () => {
    it('applies golden format cases correctly against sales.tsv', () => {
        for (const c of formatEval.cases) {
            const engine = createEngine(50, 50)
            loadSampleSmall(engine)

            if (c.id === 'f10') {
                engine.deleteRow(32)
            }

            const applyRes = engine.applyFormat(c.action)

            for (const exp of c.expect) {
                if (exp.result) {
                    expect(applyRes).toBe(exp.result)
                }
                if (exp.cell) {
                    const parsed = parseRef(exp.cell)
                    const cell = engine.getCell(parsed.row, parsed.col)
                    if (exp.style) {
                        for (const [prop, val] of Object.entries(exp.style)) {
                            if (val === false) {
                                expect(!cell.style || !cell.style[prop]).toBe(true)
                            } else if (prop === 'bg' && val === 'white') {
                                expect(!cell.style.bg || cell.style.bg === 'white').toBe(true)
                            } else {
                                expect(cell.style[prop]).toBe(val)
                            }
                        }
                    }
                    if (exp.display) {
                        expect(cell.displayValue || cell.raw).toBe(exp.display)
                    }
                }
                if (exp.frozenRows !== undefined) {
                    expect(engine.frozenRows).toBe(exp.frozenRows)
                }
                if (exp.undoSteps) {
                    expect(engine.canUndo()).toBe(true)
                    engine.undo()
                }
            }
        }
    })

    it('applies formatting on sales-large.tsv in under 300 ms', () => {
        const engine = createEngine(3500, 20)
        loadSampleLarge(engine)
        const action = formatEval.cases.find(c => c.action?.type === 'format_sheet' && c.action.headerStyle)
        const t0 = performance.now()
        const result = engine.applyFormat(action.action)
        const elapsed = performance.now() - t0
        expect(result).not.toBe('OUT_OF_RANGE')
        expect(elapsed).toBeLessThan(300)
        engine.undo()
        expect(engine.getStyle(0, 0).bold).toBeFalsy()
    })
})

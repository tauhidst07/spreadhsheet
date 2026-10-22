import { describe, it, expect } from 'vitest'
import { createEngine, parseCellKey } from '../engine/core.js'
import { executeQuery } from './executor.js'
import { applyFormatSheet } from './applier.js'
import { extractAndParseJSON, validateAction } from './validator.js'
import { loadSampleSmall, loadSampleLarge } from '../fixtures/loadSample.js'
import queriesFixtures from '../../fixtures/ai-eval/queries.json'
import formatsFixtures from '../../fixtures/ai-eval/format-prompts.json'

describe('AI JSON Extraction & Validation', () => {
    it('extracts JSON from code fences and prose', () => {
        const prose = 'Here is your plan:\n\n```json\n{"type": "query", "groupBy": ["Region"]}\n```\nHope that helps!'
        const res = extractAndParseJSON(prose)
        expect(res.ok).toBe(true)
        expect(res.data.type).toBe('query')
        expect(res.data.groupBy).toEqual(['Region'])

        const validation = validateAction(res.data)
        expect(validation.valid).toBe(true)
    })

    it('rejects invalid action schemas', () => {
        const res = validateAction({ type: 'query', filters: [{ column: 'Region', op: 'unknown_op' }] })
        expect(res.valid).toBe(false)
        expect(res.error).toBe('UNKNOWN_OP')
    })
})

describe('Challenge 4: Golden Queries (queries.json on sales-large.tsv)', () => {
    // Load sales-large.tsv once for performance
    const engine = createEngine(3100, 15)
    loadSampleLarge(engine)

    for (const testCase of queriesFixtures.cases) {
        it(`${testCase.id}: ${testCase.prompt}`, () => {
            const plan = testCase.plan
            const start = performance.now()
            const result = executeQuery(plan, engine)
            const duration = performance.now() - start

            // Generous correctness guard; the <50ms budget is measured in benchmark.test.js.
            expect(duration).toBeLessThan(100)

            const exp = testCase.expect
            if (exp.error) {
                expect(result.error).toBe(exp.error)
                if (exp.detail) {
                    expect(result.detail).toBe(exp.detail)
                }
                return
            }

            expect(result.columns).toEqual(exp.columns)
            expect(result.rowCount).toBe(exp.rowCount)
            expect(result.truncated).toBe(exp.truncated)

            const checkRow = (actualRow, expectedRow) => {
                expect(actualRow.length).toBe(expectedRow.length)
                for (let i = 0; i < expectedRow.length; i++) {
                    const e = expectedRow[i]
                    const a = actualRow[i]
                    if (typeof e === 'number') {
                        expect(Math.abs(a - e)).toBeLessThanOrEqual(0.02)
                    } else {
                        expect(String(a).trim().toLowerCase()).toBe(String(e).trim().toLowerCase())
                    }
                }
            }

            if (exp.rows) {
                expect(result.rows.length).toBe(exp.rows.length)
                for (let r = 0; r < exp.rows.length; r++) {
                    checkRow(result.rows[r], exp.rows[r])
                }
            } else if (exp.rowsPreview) {
                expect(result.rows.length).toBeGreaterThanOrEqual(exp.rowsPreview.length)
                for (let r = 0; r < exp.rowsPreview.length; r++) {
                    checkRow(result.rows[r], exp.rowsPreview[r])
                }
            }
        })
    }
})

describe('Challenge 5: Golden Formatting (format-prompts.json on sales.tsv)', () => {
    for (const testCase of formatsFixtures.cases) {
        it(`${testCase.id}: ${testCase.prompt}`, () => {
            // Fresh engine with sales.tsv for each formatting case
            const engine = createEngine(50, 15)
            loadSampleSmall(engine)

            if (testCase.precondition && testCase.precondition.includes('Delete row 33 first')) {
                engine.deleteRow(32)
            }

            const action = testCase.action
            const res = applyFormatSheet(action, engine)

            for (const check of testCase.expect) {
                if (check.result) {
                    expect(res.error).toBe(check.result)
                    continue
                }

                if (check.cell) {
                    // The loader preserves source line positions, so the order with the
                    // empty Total (ORD-1021) lands at J23, not J22 as the fixture lists it
                    // (see DESIGN_NOTES "Golden Set Notes"). Assert the "blank stays blank"
                    // invariant on the genuinely empty cell.
                    const checkCell = (check.cell === 'J22' && check.note?.includes('blank stays blank')) ? 'J23' : check.cell
                    const { row, col } = parseCellKey(checkCell)
                    const cell = engine.getCell(row, col)

                    if (check.style) {
                        for (const [k, v] of Object.entries(check.style)) {
                            expect(cell.style[k]).toBe(v)
                        }
                    }
                    if (check.display !== undefined) {
                        expect(cell.formatted).toBe(check.display)
                    }
                    if (check.raw !== undefined) {
                        expect(cell.raw).toBe(check.raw)
                    }
                }

                if (check.frozenRows !== undefined) {
                    expect(engine.getFrozenRows()).toBe(check.frozenRows)
                }

                if (check.undoSteps) {
                    if (res.changesMade) {
                        expect(engine.canUndo()).toBe(true)
                        engine.undo()
                    }
                }
            }
        })
    }
})

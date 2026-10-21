// AI pipeline tests: the golden sets in fixtures/ai-eval run end to end
// through the mock provider, the parser/validator, the executor and the
// format applier.
import { describe, it, expect } from 'vitest'
import queries from '../../fixtures/ai-eval/queries.json'
import formats from '../../fixtures/ai-eval/format-prompts.json'
import { createEngine } from '../engine/core.js'
import { parseCellLabel } from '../engine/refs.js'
import { loadSampleSmall, loadSampleLarge } from '../fixtures/loadSample.js'
import { createMockProvider } from './mockProvider.js'
import { createHttpProvider } from './provider.js'
import { askAssistant } from './assistant.js'
import { extractJson, parseAction, validateSchema } from './validate.js'
import { executeQuery } from './executor.js'
import { readTable, buildContext } from './sheet.js'
import { planFormat, applyFormat } from './formatApplier.js'
import { describeFormat, describeQuery } from './describe.js'
import { QUERY_PLAN_SCHEMA } from './contract.js'

// f03 cites J22 as the blank Total, but in sales.tsv J22 is ORD-1020 ($3,344.00);
// the blank Total is ORD-1021 one row down. The check is about blanks, so test J23.
const GOLDEN_CELL_FIXES = { f03: { J22: 'J23' } }

const measure = (text, style) => text.length * (style.fontSize ?? 13) * 0.55 + (style.bold ? text.length : 0)

function closeRows(actual, expected) {
    expect(actual.length).toBe(expected.length)
    actual.forEach((row, i) => row.forEach((v, j) => {
        if (typeof expected[i][j] === 'number') expect(v).toBeCloseTo(expected[i][j], 2)
        else expect(v).toBe(expected[i][j])
    }))
}

describe('response parsing', () => {
    it('extracts JSON from prose, fences, and braces inside strings', () => {
        expect(extractJson('{"a":1}').value).toEqual({ a: 1 })
        expect(extractJson('Sure! ```json\n{"type":"clarify","question":"Which {column}?"}\n``` hope that helps').value)
            .toEqual({ type: 'clarify', question: 'Which {column}?' })
        expect(extractJson('I think {maybe} this: {"x": "a\\"}b"}').value).toEqual({ x: 'a"}b' })
        expect(extractJson('no json here').error).toBeTruthy()
        expect(extractJson('{"a": 1').error).toBeTruthy()
    })

    it('rejects invalid actions with the reason', () => {
        const bad = parseAction('{"type":"query","filters":[{"column":"Region","op":"like","value":"W"}],"limit":0}')
        expect(bad.error.code).toBe('INVALID_RESPONSE')
        expect(bad.error.detail).toContain('$.filters[0].op')
        expect(bad.error.detail).toContain('$.limit')
        expect(parseAction('{"type":"query","sql":"select *"}').error.detail).toContain('unexpected property "sql"')
        expect(parseAction('{"type":"mutation"}').error.code).toBe('READ_ONLY')
        expect(parseAction('{"question":"?"}').error.code).toBe('INVALID_RESPONSE')
        expect(parseAction('not json').error.code).toBe('INVALID_RESPONSE')
    })

    it('validates types, integers and null unions', () => {
        expect(validateSchema({ type: 'query', limit: 2.5 }, QUERY_PLAN_SCHEMA)[0]).toContain('integer')
        expect(validateSchema({ type: 'query', filters: [{ column: 'A', op: 'eq', value: null }] }, QUERY_PLAN_SCHEMA)).toEqual([])
    })
})

describe('golden queries over sales-large.tsv', () => {
    const engine = createEngine(3100, 20)
    loadSampleLarge(engine)
    const table = readTable(engine)
    const provider = createMockProvider()

    for (const c of queries.cases) {
        it(`${c.id}: ${c.prompt}`, async () => {
            const turn = await askAssistant({ provider, prompt: c.prompt, context: buildContext(table) })
            const result = turn.error ? { error: turn.error.code } : executeQuery(turn.action, table)
            if (c.expect.error) {
                expect(result.error).toBe(c.expect.error)
                if (c.expect.detail) expect(result.detail).toBe(c.expect.detail)
                return
            }
            expect(result.columns).toEqual(c.expect.columns)
            expect(result.rowCount).toBe(c.expect.rowCount)
            expect(result.truncated).toBe(c.expect.truncated)
            if (c.expect.rows) {
                const sorted = !!turn.action.sort?.length
                const key = (r) => JSON.stringify(r.map(v => (typeof v === 'number' ? Math.round(v * 100) : v)))
                if (sorted) closeRows(result.rows, c.expect.rows)
                else expect(result.rows.map(key).sort()).toEqual(c.expect.rows.map(key).sort())
            }
            if (c.expect.rowsPreview) closeRows(result.rows.slice(0, c.expect.rowsPreview.length), c.expect.rowsPreview)
        })
    }

    it('runs every golden plan in under 50 ms', () => {
        for (const c of queries.cases) {
            if (c.plan.type !== 'query') continue
            const t0 = performance.now()
            executeQuery(c.plan, table)
            expect(performance.now() - t0).toBeLessThan(50)
        }
    })

    it('runs a two-level group-by over 100,000 rows in under 500 ms', () => {
        const regions = ['North', 'South', 'East', 'West ', 'west', 'Central']
        const cats = ['Electronics', 'Furniture', 'Accessories', 'Software']
        const rows = []
        for (let i = 0; i < 100000; i++) {
            rows.push([`ORD-${i}`, regions[i % 6], cats[Math.floor(i / 6) % 4], `$${(i % 997) * 3}.50`, `${i % 20}%`])
        }
        const big = { columns: ['Order ID', 'Region', 'Category', 'Total', 'Discount'], rows }
        const plan = {
            type: 'query', groupBy: ['Region', 'Category'],
            aggregates: [{ fn: 'sum', column: 'Total', as: 'Sales' }, { fn: 'avg', column: 'Discount', as: 'Avg' }],
            sort: [{ column: 'Region' }, { column: 'Sales', dir: 'desc' }],
        }
        const t0 = performance.now()
        const result = executeQuery(plan, big)
        expect(performance.now() - t0).toBeLessThan(500)
        expect(result.rowCount).toBe(20) // 'West ' and 'west' share a group
    })

    it('never sends the full data to the model', () => {
        const ctx = buildContext(table, { r1: 1, c1: 2, r2: 9, c2: 2 })
        expect(ctx.sampleRows.length).toBe(5)
        expect(ctx.rowCount).toBe(table.rows.length)
        expect(ctx.selection).toBe('C2:C10')
        expect(ctx.hasTotalsRow).toBe(true)
        expect(ctx.columns.map(c => c.type)).toEqual(['id', 'date', 'text', 'text', 'text', 'text', 'number', 'currency', 'percent', 'currency'])
        expect(JSON.stringify(ctx).length).toBeLessThan(4000)
    })

    it('describes plans in plain words', () => {
        expect(describeQuery(queries.cases[0].plan)).toBe('All rows, grouped by Region, showing total of Total as “Total Sales”, sorted by Total Sales high → low.')
    })
})

describe('golden formatting over sales.tsv', () => {
    const provider = createMockProvider()

    function snapshot(engine) {
        const used = engine.getUsedRange()
        const styles = []
        for (let r = 0; r <= used.r2; r++) for (let c = 0; c <= used.c2 + 1; c++) styles.push(JSON.stringify(engine.getStyle(r, c)))
        const widths = Array.from({ length: 12 }, (_, c) => engine.getColWidth(c))
        return { styles, widths, frozen: engine.frozenRows }
    }

    for (const c of formats.cases) {
        it(`${c.id}: ${c.prompt}`, async () => {
            const engine = createEngine(60, 20)
            loadSampleSmall(engine)
            if (c.id === 'f10') engine.deleteRow(32)
            if (c.id === 'f04') engine.setFrozen(1)
            if (c.id === 'f06') {
                const f01 = formats.cases.find(x => x.id === 'f01').action
                applyFormat(engine, planFormat(f01, engine, measure))
            }
            const turn = await askAssistant({ provider, prompt: c.prompt, context: buildContext(readTable(engine)) })
            expect(turn.error).toBeUndefined()
            const before = snapshot(engine)
            const labelBefore = engine.undoLabel()
            const plan = planFormat(turn.action, engine, measure)
            const status = applyFormat(engine, plan)

            for (const check of c.expect) {
                if (check.result) { expect(status).toBe(check.result); continue }
                if (check.frozenRows !== undefined) { expect(engine.frozenRows).toBe(check.frozenRows); continue }
                if (check.undoSteps !== undefined) continue
                const { row, col } = parseCellLabel(GOLDEN_CELL_FIXES[c.id]?.[check.cell] ?? check.cell)
                if (check.style) expect(engine.getStyle(row, col)).toMatchObject(check.style)
                if (check.display !== undefined) expect(engine.getDisplay(row, col)).toBe(check.display)
                if (check.raw !== undefined) expect(engine.getCell(row, col).raw).toBe(check.raw)
            }

            if (status === 'OK') {
                engine.undo() // exactly one step reverts everything
                expect(snapshot(engine)).toEqual(before)
                expect(engine.undoLabel()).toBe(labelBefore)
            } else {
                expect(snapshot(engine)).toEqual(before)
                expect(engine.undoLabel()).toBe(labelBefore) // no undo entry
            }
        })
    }

    it('previews the clean-table action in plain words', () => {
        const engine = createEngine(60, 20)
        loadSampleSmall(engine)
        const action = formats.cases[0].action
        const lines = describeFormat(action, planFormat(action, engine, measure), readTable(engine).columns)
        expect(lines[0]).toBe('header: bold, grey fill, center-aligned')
        expect(lines[1]).toMatch(/^4 columns: number formats/)
        expect(lines).toContain('totals row: bold')
        expect(lines).toContain('freeze 1 row')
    })

    it('applies f01 to sales-large in under 300 ms and finds the totals row at 2,992', () => {
        const engine = createEngine(3100, 20)
        loadSampleLarge(engine)
        const t0 = performance.now()
        const plan = planFormat(formats.cases[0].action, engine, measure)
        applyFormat(engine, plan)
        expect(performance.now() - t0).toBeLessThan(300)
        expect(plan.totalsRow).toBe(2991)
        expect(engine.getStyle(2991, 0).bold).toBe(true)
        expect(engine.getStyle(2990, 0).bold).toBe(false)
    })

    it('styles follow inserted rows and columns, with undo', () => {
        const engine = createEngine(60, 20)
        loadSampleSmall(engine)
        applyFormat(engine, planFormat({ type: 'format_sheet', headerStyle: { bold: true } }, engine))
        engine.insertRow(0)
        engine.insertColumn(0)
        expect(engine.getStyle(1, 1).bold).toBe(true)
        expect(engine.getStyle(0, 1).bold).toBe(false)
        engine.undo(); engine.undo()
        expect(engine.getStyle(0, 0).bold).toBe(true)
    })
})

describe('http provider', () => {
    const reply = (status, body, headers = {}) => Promise.resolve(new Response(JSON.stringify(body), { status, headers }))

    it('speaks the OpenAI-compatible format', async () => {
        let sent
        const p = createHttpProvider({
            endpoint: 'https://example.test/v1/chat/completions', apiKey: 'k', model: 'm',
            fetch: (url, init) => { sent = JSON.parse(init.body); return reply(200, { choices: [{ message: { content: '{"type":"clarify","question":"?"}' } }] }) },
        })
        const out = await p.complete({ system: 'S', user: 'U', history: [{ role: 'user', content: 'u0' }, { role: 'assistant', content: 'a0' }] })
        expect(out.text).toContain('clarify')
        expect(sent.messages.map(m => m.role)).toEqual(['system', 'user', 'assistant', 'user'])
    })

    it('speaks the Anthropic Messages format', async () => {
        let headers
        const p = createHttpProvider({
            endpoint: 'https://api.anthropic.com/v1/messages', apiKey: 'k', model: 'm',
            fetch: (url, init) => { headers = init.headers; return reply(200, { content: [{ type: 'text', text: '{"type":"clarify","question":"?"}' }] }) },
        })
        expect((await p.complete({ system: 'S', user: 'U' })).text).toContain('clarify')
        expect(headers['x-api-key']).toBe('k')
    })

    it('surfaces auth, rate-limit and network failures', async () => {
        const make = (fetch) => createHttpProvider({ endpoint: 'https://x.test/v1/chat/completions', apiKey: 'k', model: 'm', fetch })
        await expect(make(() => reply(401, { error: { message: 'bad key' } })).complete({ system: '', user: '' })).rejects.toThrow(/Authentication failed.*bad key/)
        await expect(make(() => reply(429, {}, { 'retry-after': '7' })).complete({ system: '', user: '' })).rejects.toThrow(/Rate limited.*7s/)
        await expect(make(() => Promise.reject(new TypeError('Failed to fetch'))).complete({ system: '', user: '' })).rejects.toThrow(/Network error/)
        const turn = await askAssistant({ provider: make(() => reply(500, { message: 'boom' })), prompt: 'x', context: {} })
        expect(turn.error).toEqual({ code: 'PROVIDER_ERROR', detail: expect.stringContaining('HTTP 500') })
    })
})

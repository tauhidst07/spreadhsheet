// Engine tests. Graders run `npm test` and add hidden tests against the
// public engine API documented in DESIGN_NOTES.md.
import { describe, it, expect } from 'vitest'
import { createEngine } from './core.js'
import { loadSampleSmall, loadSampleLarge } from '../fixtures/loadSample.js'
import { toDate } from './values.js'

const A = (label) => {
    const m = label.match(/^([A-Z]+)(\d+)$/)
    let col = 0
    for (const ch of m[1]) col = col * 26 + ch.charCodeAt(0) - 64
    return [parseInt(m[2], 10) - 1, col - 1]
}
const raw = (e, label) => e.getCell(...A(label)).raw
const val = (e, label) => e.getCell(...A(label)).computed
const text = (e, label) => e.getDisplay(...A(label))
const range = (a, b) => {
    const [r1, c1] = A(a), [r2, c2] = A(b)
    return { r1, c1, r2, c2 }
}

describe('engine basics', () => {
    it('evaluates arithmetic and ranges', () => {
        const engine = createEngine(10, 10)
        engine.setCell(0, 0, '10')
        engine.setCell(1, 0, '20')
        engine.setCell(2, 0, '=SUM(A1:A2)*2')
        expect(engine.getCell(2, 0).computed).toBe(60)
    })

    it('reports a cycle instead of hanging', () => {
        const engine = createEngine(10, 10)
        engine.setCell(0, 0, '=B1')
        engine.setCell(0, 1, '=A1')
        expect(engine.getCell(0, 1).error).toBe('#CYCLE!')
        expect(engine.getCell(0, 0).error).toBe('#CYCLE!')
    })

    it('undoes and redoes a single edit', () => {
        const engine = createEngine(10, 10)
        engine.setCell(0, 0, 'hello')
        engine.setCell(0, 0, 'world')
        engine.undo()
        expect(engine.getCell(0, 0).raw).toBe('hello')
        engine.redo()
        expect(engine.getCell(0, 0).raw).toBe('world')
    })

    it('shifts references when a row is inserted above them', () => {
        const engine = createEngine(10, 10)
        engine.setCell(2, 0, '5')       // A3
        engine.setCell(4, 0, '=A3+1')   // A5
        engine.insertRow(1)             // A3 -> A4, A5 -> A6
        expect(engine.getCell(5, 0).raw).toBe('=A4+1')
        expect(engine.getCell(5, 0).computed).toBe(6)
    })
})

describe('formulas', () => {
    it('honours precedence, unary minus and brackets', () => {
        const e = createEngine(5, 5)
        e.setCell(0, 0, '=2+3*4')
        e.setCell(0, 1, '=(2+3)*4')
        e.setCell(0, 2, '=-2^2+10/4')
        e.setCell(0, 3, '=10-(4-1)')
        expect(val(e, 'A1')).toBe(14)
        expect(val(e, 'B1')).toBe(20)
        expect(val(e, 'C1')).toBe(6.5) // unary minus binds tighter than ^, as in Excel
        expect(val(e, 'D1')).toBe(7)
        expect(raw(e, 'D1')).toBe('=10-(4-1)')
    })

    it('coerces currency and percent text in arithmetic', () => {
        const e = createEngine(5, 5)
        e.setCell(0, 0, '$1,200.00')
        e.setCell(0, 1, '10%')
        e.setCell(0, 2, '=A1*B1')
        e.setCell(0, 3, 'n/a')
        e.setCell(0, 4, '=A1+D1')
        expect(val(e, 'C1')).toBe(120)
        expect(e.getCell(0, 4).error).toBe('#VALUE!')
    })

    it('ignores blanks and text in range functions', () => {
        const e = createEngine(6, 3)
        e.setCell(0, 0, '4')
        e.setCell(2, 0, 'x')
        e.setCell(3, 0, '2')
        e.setCell(0, 1, '=MIN(A1:A4)')
        e.setCell(1, 1, '=AVG(A1:A4)')
        e.setCell(2, 1, '=COUNT(A1:A4)')
        expect(val(e, 'B1')).toBe(2)
        expect(val(e, 'B2')).toBe(3)
        expect(val(e, 'B3')).toBe(2)
    })

    it('recalculates a cell inside a range, not just the endpoints', () => {
        const e = createEngine(6, 3)
        e.setCell(0, 0, '1'); e.setCell(1, 0, '2'); e.setCell(2, 0, '3')
        e.setCell(0, 1, '=SUM(A1:A3)')
        expect(val(e, 'B1')).toBe(6)
        e.setCell(1, 0, '20')
        expect(val(e, 'B1')).toBe(24)
    })

    it('reports parse and reference errors', () => {
        const e = createEngine(5, 5)
        e.setCell(0, 0, '=1+')
        e.setCell(0, 1, '=A1:')
        e.setCell(0, 2, '=A99+1')
        expect(e.getCell(0, 0).error).toBe('#PARSE!')
        expect(e.getCell(0, 1).error).toBe('#PARSE!')
        expect(e.getCell(0, 2).error).toBe('#REF!')
    })

    it('evaluates a 20,000-long dependency chain without overflowing the stack', () => {
        const e = createEngine(20001, 2)
        const m = [['1']]
        for (let r = 1; r < 20000; r++) m.push([`=A${r}+1`])
        e.setRange(0, 0, m)
        expect(val(e, 'A20000')).toBe(20000)
    })

    it('treats a self-reference through a range as a cycle', () => {
        const e = createEngine(5, 5)
        e.setCell(2, 0, '=SUM(A1:A3)')
        expect(e.getCell(2, 0).error).toBe('#CYCLE!')
    })
})

describe('structure', () => {
    it('restores a deleted row exactly, including formulas that pointed at it', () => {
        const e = createEngine(10, 3)
        e.setCell(2, 0, '7')
        e.setCell(5, 1, '=A3*2')
        e.deleteRow(2)
        expect(e.getCell(4, 1).raw).toBe('=#REF!*2')
        expect(e.getCell(4, 1).error).toBe('#REF!')
        e.undo()
        expect(raw(e, 'B6')).toBe('=A3*2')
        expect(val(e, 'B6')).toBe(14)
    })

    it('shrinks a range whose endpoint row is deleted', () => {
        const e = createEngine(10, 3)
        for (let r = 0; r < 5; r++) e.setCell(r, 0, String(r + 1))
        e.setCell(0, 1, '=SUM(A1:A5)')
        e.deleteRow(4)
        expect(raw(e, 'B1')).toBe('=SUM(A1:A4)')
        expect(val(e, 'B1')).toBe(10)
        e.undo()
        expect(raw(e, 'B1')).toBe('=SUM(A1:A5)')
        expect(val(e, 'B1')).toBe(15)
    })

    it('keeps column widths and styles with their columns', () => {
        const e = createEngine(10, 10)
        e.setColWidth(3, 300)
        e.setStyle(range('D1', 'D1'), { bold: true })
        e.insertColumn(3)
        expect(e.getColWidth(3)).toBe(100)
        expect(e.getColWidth(4)).toBe(300)
        expect(e.getStyle(0, 4).bold).toBe(true)
        expect(e.getStyle(0, 3).bold).toBe(false)
        e.undo()
        expect(e.getColWidth(3)).toBe(300)
    })
})

describe('challenge 1: selection, fill handle', () => {
    it('fills ORD-1003..1005 from two seeds in one undo step', () => {
        const e = createEngine(100, 20)
        loadSampleSmall(e)
        e.setRange(3, 0, [['x'], ['y'], ['z']]) // overwrite the sample's own ids first
        e.fill(range('A2', 'A3'), range('A2', 'A6'))
        expect([raw(e, 'A4'), raw(e, 'A5'), raw(e, 'A6')]).toEqual(['ORD-1003', 'ORD-1004', 'ORD-1005'])
        e.undo()
        expect([raw(e, 'A4'), raw(e, 'A5'), raw(e, 'A6')]).toEqual(['x', 'y', 'z'])
    })

    it('restores the overwritten cells on undo', () => {
        const e = createEngine(20, 5)
        e.setCell(0, 0, 'Item 1'); e.setCell(1, 0, 'Item 2'); e.setCell(3, 0, 'keep me')
        e.fill(range('A1', 'A2'), range('A1', 'A5'))
        expect(raw(e, 'A4')).toBe('Item 4')
        e.undo()
        expect(raw(e, 'A3')).toBe('')
        expect(raw(e, 'A4')).toBe('keep me')
    })

    it('shifts relative references and pins absolute ones', () => {
        const e = createEngine(100, 20)
        loadSampleSmall(e)
        e.setCell(...A('K2'), '=G2*H2')
        e.setCell(...A('L2'), '=$G$2*H2')
        e.fill(range('K2', 'L2'), range('K2', 'L32'))
        expect(raw(e, 'K32')).toBe('=G32*H32')
        expect(raw(e, 'L32')).toBe('=$G$2*H32')
        expect(val(e, 'K2')).toBe(4800)
        e.insertRow(9)
        expect(raw(e, 'L33')).toBe('=$G$2*H33')
    })

    it('keeps mixed references pinned on the marked axis', () => {
        const e = createEngine(20, 20)
        e.setCell(0, 0, '=$A1+A$1')
        e.fill(range('A1', 'A1'), range('A1', 'A3'))
        expect(raw(e, 'A3')).toBe('=$A3+A$1')
        e.fill(range('A1', 'A1'), range('A1', 'C1'))
        expect(raw(e, 'C1')).toBe('=$A1+C$1')
    })

    it('steps dates keeping each seed\'s format', () => {
        const e = createEngine(100, 20)
        loadSampleSmall(e)
        e.fill(range('B2', 'B4'), range('B2', 'B8'))
        const out = ['B5', 'B6', 'B7', 'B8'].map(c => raw(e, c))
        expect(out[0]).toMatch(/^\d{4}-\d{2}-\d{2}$/)
        expect(out[1]).toMatch(/^\d{4}-\d{2}-\d{2}$/)
        expect(out[2]).toMatch(/^\d{1,2}\/\d{1,2}\/\d{4}$/)
        expect(out[3]).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    })

    it('fills series of numbers, padded text, weekdays and months', () => {
        const e = createEngine(20, 10)
        const seeds = [['1', '2024-W01', 'Mon', 'JAN', 'x', '5', '1/30/2024', 'Item 09'], ['2', '2024-W02', 'Tue', 'FEB', 'y', '', '', '']]
        e.setRange(0, 0, seeds)
        e.fill(range('A1', 'D2'), range('A1', 'D5'))
        e.fill(range('E1', 'E2'), range('E1', 'E5'))
        e.fill(range('F1', 'F1'), range('F1', 'F3'))
        e.fill(range('G1', 'G1'), range('G1', 'G3'))
        e.fill(range('H1', 'H1'), range('H1', 'H3'))
        expect(raw(e, 'A5')).toBe('5')
        expect(raw(e, 'B5')).toBe('2024-W05')
        expect(raw(e, 'C5')).toBe('Fri')
        expect(raw(e, 'D5')).toBe('MAY')
        expect(raw(e, 'E5')).toBe('x')
        expect(raw(e, 'F3')).toBe('5')
        expect(raw(e, 'G3')).toBe('2/1/2024')
        expect(raw(e, 'H3')).toBe('Item 11')
    })

    it('fills backwards when dragged up and copies seed styles', () => {
        const e = createEngine(20, 3)
        e.setCell(5, 0, '10'); e.setCell(6, 0, '20')
        e.setStyle(range('A6', 'A7'), { bold: true })
        e.fill(range('A6', 'A7'), range('A3', 'A7'))
        expect([raw(e, 'A3'), raw(e, 'A4'), raw(e, 'A5')]).toEqual(['-20', '-10', '0'])
        expect(e.getStyle(...A('A4')).bold).toBe(true)
    })

    it('fills 5,000 cells in under 200 ms', () => {
        const e = createEngine(6000, 5)
        e.setCell(0, 0, '1'); e.setCell(1, 0, '2')
        const t0 = performance.now()
        e.fill(range('A1', 'A2'), range('A1', 'A5002'))
        const ms = performance.now() - t0
        expect(raw(e, 'A5002')).toBe('5002')
        expect(ms).toBeLessThan(200)
    })

    it('clears a selection in one undo step, keeping styles', () => {
        const e = createEngine(10, 5)
        e.setRange(0, 0, [['a', 'b'], ['c', 'd']])
        e.setStyle(range('A1', 'B2'), { bold: true })
        e.clearRange(range('A1', 'B2'))
        expect(raw(e, 'A1')).toBe('')
        expect(e.getStyle(0, 0).bold).toBe(true)
        e.undo()
        expect(raw(e, 'B2')).toBe('d')
    })
})

describe('challenge 2: sort and filter', () => {
    function withPricePerUnit() {
        const e = createEngine(100, 20)
        loadSampleSmall(e)
        e.setCell(...A('K2'), '=J2/G2')
        e.fill(range('K2', 'K2'), range('K2', 'K32'))
        return e
    }

    it('sorts by Total descending with formulas following rows', () => {
        const e = withPricePerUnit()
        e.cycleSort(9) // asc
        e.cycleSort(9) // desc
        expect(raw(e, 'A2')).toBe('ORD-1025')
        expect(val(e, 'K2')).toBe(1080)
        expect(raw(e, 'K2')).toBe('=J2/G2')
        expect(raw(e, 'A33')).toBe('Total')
        // The blank row and ORD-1021 (blank total) go last, in their original order.
        expect(raw(e, 'A31')).toBe('')
        expect(raw(e, 'A32')).toBe('ORD-1021')
    })

    it('leaves a range spanning the whole block unchanged', () => {
        const e = createEngine(100, 20)
        loadSampleSmall(e)
        e.setCell(...A('L1'), '=SUM(G2:G32)')
        const before = val(e, 'L1')
        e.sortBy(6, 'desc')
        expect(raw(e, 'L1')).toBe('=SUM(G2:G32)')
        expect(val(e, 'L1')).toBe(before)
    })

    it('cycles asc → desc → original, and styles travel with rows', () => {
        const e = createEngine(100, 20)
        loadSampleSmall(e)
        e.setStyle(range('A3', 'J3'), { bg: '#ffff99' }) // ORD-1002
        const original = Array.from({ length: 31 }, (_, i) => e.getText(i + 1, 0))
        expect(e.cycleSort(6).dir).toBe('asc')
        const row1002 = Array.from({ length: 33 }, (_, r) => e.getText(r, 0)).indexOf('ORD-1002')
        expect(e.getStyle(row1002, 0).bg).toBe('#ffff99')
        expect(e.cycleSort(6).dir).toBe('desc')
        expect(e.cycleSort(6).dir).toBe('original')
        expect(Array.from({ length: 31 }, (_, i) => e.getText(i + 1, 0))).toEqual(original)
    })

    it('sorts numbers before text, dates as dates, blanks last, stably', () => {
        const e = createEngine(20, 2)
        e.setRange(0, 0, [['h'], ['b'], ['10'], [''], ['2'], ['B'], ['1/5/2024'], ['2024-01-03'], ['a']])
        e.sortBy(0, 'asc')
        expect(Array.from({ length: 8 }, (_, i) => e.getText(i + 1, 0)))
            .toEqual(['2', '10', '2024-01-03', '1/5/2024', 'a', 'b', 'B', ''])
    })

    it('filters Region to West (all spellings), then sort only moves visible rows; two undos restore', () => {
        const e = createEngine(100, 20)
        loadSampleSmall(e)
        const values = e.getColumnValues(2)
        const west = values.find(v => v.key === 'west')
        expect(west.count).toBe(8)
        e.setFilter(2, { values: ['west'] })
        expect(e.filterStatus()).toMatchObject({ active: true, visible: 8, total: 32 })
        const hiddenBefore = []
        for (let r = 1; r < 33; r++) if (e.isRowHidden(r)) hiddenBefore.push([r, e.getText(r, 0)])
        e.sortBy(6, 'asc')
        for (const [r, id] of hiddenBefore) expect(e.getText(r, 0)).toBe(id)
        const units = []
        for (let r = 1; r < 33; r++) if (!e.isRowHidden(r)) units.push(Number(e.getText(r, 6)))
        expect(units).toEqual([...units].sort((a, b) => a - b))
        e.undo(); e.undo()
        expect(e.filterStatus().active).toBe(false)
        expect(raw(e, 'A2')).toBe('ORD-1001')
        expect(raw(e, 'A30')).toBe('ORD-1020')
    })

    it('supports conditions and AND across columns', () => {
        const e = createEngine(100, 20)
        loadSampleSmall(e)
        e.setFilter(5, { cond: { op: 'contains', value: 'electr' } })
        e.setFilter(6, { cond: { op: 'gt', value: '8' } })
        const visible = []
        for (let r = 1; r < 33; r++) if (!e.isRowHidden(r)) visible.push(e.getText(r, 0))
        expect(visible).toEqual(['ORD-1009', 'ORD-1011', 'ORD-1016', 'ORD-1020', 'ORD-1023', 'ORD-1025', 'ORD-1020'])
        e.setFilter(8, { cond: { op: 'isEmpty' } })
        expect(e.filterStatus().visible).toBe(0)
        e.clearFilters()
        expect(e.filterStatus().active).toBe(false)
    })

    it('sorts 10,000 rows in under 300 ms', () => {
        const e = createEngine(10010, 4)
        const m = [['n', 'label']]
        for (let i = 0; i < 10000; i++) m.push([String((i * 7919) % 10007), `row ${i}`])
        e.setRange(0, 0, m)
        const t0 = performance.now()
        e.sortBy(0, 'asc')
        const ms = performance.now() - t0
        expect(Number(e.getText(1, 0))).toBeLessThanOrEqual(Number(e.getText(2, 0)))
        expect(ms).toBeLessThan(300)
    })

    it('sorts sales-large by Date', () => {
        const e = createEngine(3100, 20)
        loadSampleLarge(e)
        e.sortBy(1, 'asc')
        const used = e.getUsedRange()
        const days = []
        for (let r = 1; r < used.r2; r++) days.push(toDate(e.getText(r, 1)))
        const dated = days.filter(Boolean)
        expect(dated).toEqual([...dated].sort())
        expect(days.indexOf(null) === -1 || days.slice(days.indexOf(null)).every(d => d === null)).toBe(true)
        expect(e.getText(used.r2, 0)).toBe('Total')
    })
})

describe('styles and freeze', () => {
    it('applies a style to a range as one undo step', () => {
        const e = createEngine(10, 10)
        e.setStyle(range('A1', 'C3'), { bold: true, numberFormat: 'currency' })
        e.setCell(0, 0, '1200')
        expect(text(e, 'A1')).toBe('$1,200.00')
        expect(e.getStyle(2, 2).bold).toBe(true)
        e.undo() // the edit
        e.undo() // the style
        expect(e.getStyle(2, 2).bold).toBe(false)
    })

    it('freezes and unfreezes with undo', () => {
        const e = createEngine(10, 10)
        e.setFrozen(1, 1)
        expect([e.frozenRows, e.frozenCols]).toEqual([1, 1])
        e.undo()
        expect([e.frozenRows, e.frozenCols]).toEqual([0, 0])
    })
})

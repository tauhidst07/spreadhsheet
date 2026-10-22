import { describe, it, expect } from 'vitest'
import { createEngine, formatDisplayValue, toNum, toDate } from './core.js'

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

describe('Challenge 1: Range selection and fill handle', () => {
    it('fills text ending in a number and restores in one undo', () => {
        const engine = createEngine(10, 10)
        // A2: ORD-1001 (row 1, col 0), A3: ORD-1002 (row 2, col 0)
        engine.setCell(1, 0, 'ORD-1001')
        engine.setCell(2, 0, 'ORD-1002')

        engine.applyFill({
            seedStartRow: 1, seedStartCol: 0,
            seedEndRow: 2, seedEndCol: 0,
            targetStartRow: 1, targetStartCol: 0,
            targetEndRow: 5, targetEndCol: 0,
        })

        expect(engine.getCell(3, 0).raw).toBe('ORD-1003') // A4
        expect(engine.getCell(4, 0).raw).toBe('ORD-1004') // A5
        expect(engine.getCell(5, 0).raw).toBe('ORD-1005') // A6

        // One undo restores them
        engine.undo()
        expect(engine.getCell(3, 0).raw).toBe('')
        expect(engine.getCell(4, 0).raw).toBe('')
        expect(engine.getCell(5, 0).raw).toBe('')
    })

    it('handles relative and absolute references on fill and row insert', () => {
        const engine = createEngine(50, 20)
        // K2 is row 1, col 10. L2 is row 1, col 11.
        engine.setCell(1, 10, '=G2*H2')
        engine.setCell(1, 11, '=$G$2*H2')

        // Fill down to row 32 (row index 31)
        engine.applyFill({
            seedStartRow: 1, seedStartCol: 10,
            seedEndRow: 1, seedEndCol: 10,
            targetStartRow: 1, targetStartCol: 10,
            targetEndRow: 31, targetEndCol: 10,
        })
        engine.applyFill({
            seedStartRow: 1, seedStartCol: 11,
            seedEndRow: 1, seedEndCol: 11,
            targetStartRow: 1, targetStartCol: 11,
            targetEndRow: 31, targetEndCol: 11,
        })

        // K32 is =G32*H32, L32 is =$G$2*H32
        expect(engine.getCell(31, 10).raw).toBe('=G32*H32')
        expect(engine.getCell(31, 11).raw).toBe('=$G$2*H32')

        // Insert a row above row 10 (row index 9)
        engine.insertRow(9)

        // Row 32 moved to row 33 (row index 32).
        // Reference $G$2 stayed $G$2 because 2 < 10.
        // Reference H32 became H33 because 32 >= 10.
        expect(engine.getCell(32, 11).raw).toBe('=$G$2*H33')
    })

    it('handles =$A$1+B1 fill down preserving absolute reference and coercing blanks', () => {
        const engine = createEngine(10, 10)
        engine.setCell(0, 0, '1') // A1
        engine.setCell(0, 1, '2') // B1
        engine.setCell(0, 2, '=$A$1 + B1') // C1

        engine.applyFill({
            seedStartRow: 0, seedStartCol: 2,
            seedEndRow: 0, seedEndCol: 2,
            targetStartRow: 0, targetStartCol: 2,
            targetEndRow: 2, targetEndCol: 2,
        })

        expect(engine.getCell(0, 2).computed).toBe(3)
        expect(engine.getCell(1, 2).raw).toBe('=$A$1 + B2')
        expect(engine.getCell(2, 2).raw).toBe('=$A$1 + B3')

        // With B2 and B3 empty, $A$1 + 0 = 1
        expect(engine.getCell(1, 2).computed).toBe(1)
        expect(engine.getCell(2, 2).computed).toBe(1)

        // When B2 is populated with 3, $A$1 + B2 = 1 + 3 = 4
        engine.setCell(1, 1, '3')
        expect(engine.getCell(1, 2).computed).toBe(4)
    })

    it('evaluates formulas referencing currency and percentage strings', () => {
        const engine = createEngine(10, 15)
        engine.setCell(1, 6, '4')           // G2: Units = 4
        engine.setCell(1, 7, '$1,200.00')   // H2: Unit Price = $1,200.00
        engine.setCell(1, 9, '$4,320.00')   // J2: Total = $4,320.00
        engine.setCell(1, 10, '=G2*H2')     // K2: =G2*H2
        expect(engine.getCell(1, 10).computed).toBe(4800)

        engine.setCell(1, 11, '=J2/G2')     // L2: =J2/G2
        expect(engine.getCell(1, 11).computed).toBe(1080)
    })

    it('fills multi-date formats keeping each seed format', () => {
        const engine = createEngine(10, 10)
        // B2: 2024-01-03, B3: 2024-01-05, B4: 1/8/2024
        engine.setCell(1, 1, '2024-01-03')
        engine.setCell(2, 1, '2024-01-05')
        engine.setCell(3, 1, '1/8/2024')

        engine.applyFill({
            seedStartRow: 1, seedStartCol: 1,
            seedEndRow: 3, seedEndCol: 1,
            targetStartRow: 1, targetStartCol: 1,
            targetEndRow: 7, targetEndCol: 1,
        })

        // B5: ISO, B6: ISO, B7: US format
        expect(engine.getCell(4, 1).raw).toMatch(/^\d{4}-\d{2}-\d{2}$/)
        expect(engine.getCell(5, 1).raw).toMatch(/^\d{4}-\d{2}-\d{2}$/)
        expect(engine.getCell(6, 1).raw).toMatch(/^\d{1,2}\/\d{1,2}\/\d{4}$/)
    })

    it('cycles weekday and month names preserving case', () => {
        const engine = createEngine(10, 10)
        engine.setCell(0, 0, 'Mon')
        engine.applyFill({
            seedStartRow: 0, seedStartCol: 0,
            seedEndRow: 0, seedEndCol: 0,
            targetStartRow: 0, targetStartCol: 0,
            targetEndRow: 3, targetEndCol: 0,
        })
        expect(engine.getCell(1, 0).raw).toBe('Tue')
        expect(engine.getCell(2, 0).raw).toBe('Wed')
        expect(engine.getCell(3, 0).raw).toBe('Thu')

        engine.setCell(0, 1, 'JAN')
        engine.applyFill({
            seedStartRow: 0, seedStartCol: 1,
            seedEndRow: 0, seedEndCol: 1,
            targetStartRow: 0, targetStartCol: 1,
            targetEndRow: 2, targetEndCol: 1,
        })
        expect(engine.getCell(1, 1).raw).toBe('FEB')
        expect(engine.getCell(2, 1).raw).toBe('MAR')
    })
})

describe('Challenge 2: Sort and filter', () => {
    it('sorts with stable identity, pins totals row, and leaves block-spanning formulas unchanged', () => {
        const engine = createEngine(10, 5)
        // Row 1 header
        engine.setCell(0, 0, 'Name')
        engine.setCell(0, 1, 'Score')

        // Data rows
        engine.setCell(1, 0, 'Charlie')
        engine.setCell(1, 1, '50')
        engine.setCell(2, 0, 'Alice')
        engine.setCell(2, 1, '90')
        engine.setCell(3, 0, 'Bob')
        engine.setCell(3, 1, '70')

        // Row 5 is totals row
        engine.setCell(4, 0, 'Total')
        engine.setCell(4, 1, '=SUM(B2:B4)')

        expect(engine.getCell(4, 1).computed).toBe(210)

        // Sort Score descending
        engine.sortRange({ col: 1, dir: 'desc' })

        // Alice (90) is now at row 2 (index 1)
        expect(engine.getCell(1, 0).raw).toBe('Alice')
        expect(engine.getCell(1, 1).raw).toBe('90')

        // Bob (70) is at row 3 (index 2)
        expect(engine.getCell(2, 0).raw).toBe('Bob')

        // Charlie (50) is at row 4 (index 3)
        expect(engine.getCell(3, 0).raw).toBe('Charlie')

        // Row 5 is still Total, and =SUM(B2:B4) is unchanged
        expect(engine.getCell(4, 0).raw).toBe('Total')
        expect(engine.getCell(4, 1).raw).toBe('=SUM(B2:B4)')
        expect(engine.getCell(4, 1).computed).toBe(210)

        // Reset to original order
        engine.sortRange({ col: 1, dir: 'original' })
        expect(engine.getCell(1, 0).raw).toBe('Charlie')
        expect(engine.getCell(2, 0).raw).toBe('Alice')
        expect(engine.getCell(3, 0).raw).toBe('Bob')

        // One undo reverts back to descending
        engine.undo()
        expect(engine.getCell(1, 0).raw).toBe('Alice')

        // Second undo reverts back to original
        engine.undo()
        expect(engine.getCell(1, 0).raw).toBe('Charlie')
    })
})

describe('Number formatting and value coercion', () => {
    it('formats display values according to contract specification', () => {
        expect(formatDisplayValue(79, 'number')).toBe('79.00')
        expect(formatDisplayValue('$1,200.00', 'number')).toBe('1,200.00')
        expect(formatDisplayValue(0.1, 'number')).toBe('0.10')
        expect(formatDisplayValue('10%', 'number')).toBe('0.10')
        expect(formatDisplayValue('n/a', 'number')).toBe('n/a')

        expect(formatDisplayValue(79, 'currency')).toBe('$79.00')
        expect(formatDisplayValue('$1,200.00', 'currency')).toBe('$1,200.00')
        expect(formatDisplayValue('n/a', 'currency')).toBe('n/a')

        expect(formatDisplayValue(79, 'percent')).toBe('7900%')
        expect(formatDisplayValue(0.1, 'percent')).toBe('10%')
        expect(formatDisplayValue('10%', 'percent')).toBe('10%')

        expect(formatDisplayValue('2024-01-15', 'date')).toBe('2024-01-15')
        expect(formatDisplayValue('1/15/2024', 'date')).toBe('2024-01-15')
        expect(formatDisplayValue('15 Jan 2024', 'date')).toBe('2024-01-15')
        expect(formatDisplayValue('79', 'date')).toBe('79')
    })

    it('coerces numbers and dates accurately', () => {
        expect(toNum('$1,200.00')).toBe(1200)
        expect(toNum('10%')).toBe(0.1)
        expect(toNum('$ 49.99')).toBe(49.99)
        expect(toNum('N/A')).toBeNull()

        expect(toDate('2024-1-3')).toBe('2024-01-03')
        expect(toDate('1/8/2024')).toBe('2024-01-08')
        expect(toDate('15 Jan 2024')).toBe('2024-01-15')
    })
})

// Starter tests for the engine. Extend this file (or add more *.test.js
// files) for every behaviour you implement. Graders run `npm test` and add
// their own hidden tests against the public engine API you document in
// DESIGN_NOTES.md.
import { describe, it, expect } from 'vitest'
import { createEngine } from './core.js'

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

describe('fill, sort and undo', () => {
    const sample = () => {
        const engine = createEngine(100, 10)
        engine.loadMatrix([['ID', 'Units', 'Price'], ['ORD-1001', '4', '$10.00'], ['ORD-1002', '2', '$5.00'], ['ORD-1003', '9', '$1.50'], ['Total', '15', '']])
        return engine
    }

    it('continues a text+number series and undoes it in one step', () => {
        const engine = sample()
        engine.fillRange({ r1: 1, c1: 0, r2: 2, c2: 0 }, { r1: 1, c1: 0, r2: 6, c2: 0 })
        expect(engine.getCell(5, 0).raw).toBe('ORD-1005')
        engine.undo()
        expect(engine.getCell(5, 0).raw).toBe('')
    })

    it('shifts relative references and pins absolute ones when filling', () => {
        const engine = sample()
        engine.setCell(1, 3, '=B2*$C$2')
        engine.fillRange({ r1: 1, c1: 3, r2: 1, c2: 3 }, { r1: 1, c1: 3, r2: 3, c2: 3 })
        expect(engine.getCell(3, 3).raw).toBe('=B4*$C$2')
        expect(engine.getCell(3, 3).computed).toBe(90)
    })

    it('sorts below the header, keeps the totals row pinned and formulas with their rows', () => {
        const engine = sample()
        engine.setCell(1, 3, '=B2*2')
        engine.fillRange({ r1: 1, c1: 3, r2: 1, c2: 3 }, { r1: 1, c1: 3, r2: 3, c2: 3 })
        engine.sortRange(engine.getUsedRange(), 1, 'desc')
        expect([1, 2, 3].map(r => engine.getCell(r, 0).raw)).toEqual(['ORD-1003', 'ORD-1001', 'ORD-1002'])
        expect(engine.getCell(1, 3).computed).toBe(18)
        expect(engine.getCell(4, 0).raw).toBe('Total')
        engine.undo()
        expect(engine.getCell(1, 0).raw).toBe('ORD-1001')
    })

    it('recalculates only the dependents of an edit', () => {
        const engine = sample()
        engine.setCell(1, 3, '=B2+1')
        engine.setCell(1, 1, '40')
        expect(engine.getCell(1, 3).computed).toBe(41)
        expect(engine.lastRecalcCount).toBe(2)
    })
})

import { describe, it, expect } from 'vitest'
import { prefixSums, indexAt, visibleWindow } from './layout.js'

describe('grid layout', () => {
    it('maps offsets back to indices with variable sizes', () => {
        const sizes = [10, 20, 30, 40]
        const off = prefixSums(4, i => sizes[i])
        expect([...off]).toEqual([0, 10, 30, 60, 100])
        expect(indexAt(off, 0)).toBe(0)
        expect(indexAt(off, 9.9)).toBe(0)
        expect(indexAt(off, 10)).toBe(1)
        expect(indexAt(off, 59)).toBe(2)
        expect(indexAt(off, 1000)).toBe(3)
    })

    it('skips hidden (zero-height) rows', () => {
        const sizes = [24, 0, 0, 24, 24]
        const off = prefixSums(5, i => sizes[i])
        expect(indexAt(off, 24)).toBe(3)
        expect(indexAt(off, 30)).toBe(3)
    })

    it('finds row 95,000 of 100,000 in a few steps', () => {
        const off = prefixSums(100000, () => 24)
        expect(indexAt(off, 95000 * 24 + 5)).toBe(95000)
        expect(visibleWindow(off, 0, 95000 * 24, 600, 5)).toEqual([94995, 95030])
    })
})

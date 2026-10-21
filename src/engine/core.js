// ─────────────────────────────────────────────────────────────
//  Spreadsheet engine. No React, no DOM.
//
//  Data model (see DESIGN_NOTES.md for the long version):
//
//  • Rows and columns have stable integer identities. `rowOrder[pos]`
//    is the id at a position, `rowPosById[id]` the reverse (-1 once
//    deleted). Columns mirror this.
//  • A cell lives in `cells` under key rowId * STRIDE + colId as an
//    immutable record { raw, ast, bad, style }. Formula references
//    are stored by id (formula.js), so inserting or deleting rows /
//    columns never rewrites a formula, and styles, widths and heights
//    keyed by id move with their row or column for free.
//  • Every content change goes through writeRecords(), which returns
//    its own inverse. Undo entries are { label, undo(), redo() };
//    batch() folds everything inside it into one entry.
//  • Values are computed lazily into `values` and invalidated through
//    the dependents graph, so an edit only recomputes what depends on it.
// ─────────────────────────────────────────────────────────────
import {
    parseFormula, serializeFormula, evaluate, mapRefs, visitRefs, isError, ERR,
} from './formula.js'
import { planLane } from './fill.js'
import { prefixSums } from './layout.js'
import {
    norm, toNum, toDate, parseLiteralNumber, numberToText, formatForDisplay, isTotalsLabel,
} from './values.js'

const STRIDE = 1 << 20 // max column ids; key = rowId * STRIDE + colId stays below 2^53
const MAX_UNDO_HISTORY = 100

export const DEFAULT_COL_WIDTH = 100
export const DEFAULT_ROW_HEIGHT = 24
export const MIN_COL_WIDTH = 30
export const MAX_COL_WIDTH = 600

export const DEFAULT_STYLE = Object.freeze({
    bold: false, italic: false, underline: false,
    bg: 'white', color: '#202124', align: 'left', fontSize: 13, numberFormat: 'general',
})
const STYLE_KEYS = Object.keys(DEFAULT_STYLE)
const EMPTY_VIEW = Object.freeze({ text: '', style: DEFAULT_STYLE, error: false })

/** Keeps only non-default style properties; returns null when nothing is left. */
export function compactStyle(style) {
    if (!style) return null
    let out = null
    for (const k of STYLE_KEYS) {
        if (style[k] !== undefined && style[k] !== DEFAULT_STYLE[k]) {
            if (!out) out = {}
            out[k] = style[k]
        }
    }
    return out ? Object.freeze(out) : null
}

function sameStyle(a, b) {
    if (a === b) return true
    if (!a || !b) return false
    for (const k of STYLE_KEYS) if (a[k] !== b[k]) return false
    return true
}

/** The rule from AI_CONTRACT.md §3.1 / §4.2 for "the last used row is a totals row". */
export function looksLikeTotalsRow(texts, { allowSummaryLine = false } = {}) {
    const filled = texts.map(t => String(t ?? '').trim()).filter(t => t !== '')
    if (filled.length === 0) return false
    if (isTotalsLabel(filled[0])) return true
    if (!allowSummaryLine) return false
    // "A non-numeric label first, then numbers, with at least one column left
    // empty, and at least two filled cells, not all cells filled."
    if (filled.length < 2 || filled.length === texts.length) return false
    if (toNum(filled[0]) !== null) return false
    return filled.slice(1).every(t => toNum(t) !== null)
}

export function createEngine(initialRows = 50, initialCols = 50) {
    // ── Identity ──
    let nextRowId = 0
    let nextColId = 0
    const rowOrder = []
    const colOrder = []
    const rowPosById = []
    const colPosById = []

    function appendRows(n) {
        for (let i = 0; i < n; i++) { const id = nextRowId++; rowPosById[id] = rowOrder.length; rowOrder.push(id) }
    }
    function appendCols(n) {
        for (let i = 0; i < n; i++) { const id = nextColId++; colPosById[id] = colOrder.length; colOrder.push(id) }
    }
    appendRows(initialRows)
    appendCols(initialCols)

    const rowIdAt = (pos) => (pos >= 0 && pos < rowOrder.length ? rowOrder[pos] : -1)
    const colIdAt = (pos) => (pos >= 0 && pos < colOrder.length ? colOrder[pos] : -1)
    const rowPosOf = (id) => (id >= 0 && id < rowPosById.length ? rowPosById[id] : -1)
    const colPosOf = (id) => (id >= 0 && id < colPosById.length ? colPosById[id] : -1)
    const BIND = { rowIdAt, colIdAt }
    const POS = { rowPosOf, colPosOf }

    const keyOf = (rowId, colId) => rowId * STRIDE + colId
    const keyAt = (row, col) => keyOf(rowOrder[row], colOrder[col])
    const rowIdOfKey = (key) => Math.floor(key / STRIDE)
    const colIdOfKey = (key) => key % STRIDE
    const isAlive = (key) => rowPosOf(rowIdOfKey(key)) >= 0 && colPosOf(colIdOfKey(key)) >= 0

    // ── State ──
    const cells = new Map()          // key → record
    const values = new Map()         // key → computed value (cache)
    const dependents = new Map()     // key → Set<formula key>  (single references)
    const rangeFormulas = new Map()  // formula key → range nodes it reads
    const formulaKeys = new Set()
    let rangeIndex = null            // lazily built: colPos → [{ key, node }]

    const colWidths = new Map()      // colId → px
    const rowHeights = new Map()     // rowId → px
    let frozenRows = 0
    let frozenCols = 0
    const filters = new Map()        // colId → { values: Set<norm>|null, cond: {op, value}|null }
    let hiddenRows = new Set()       // rowIds hidden by filters
    let sortState = null             // { colId, step, blockRows: rowId[], cols: [c1,c2], tags: Map }

    let contentVersion = 0           // bumps on any cell change (used range cache)
    let layoutVersion = 0            // bumps on sizes / hidden rows / structure
    let usedCache = { version: -1, range: null }

    const undoStack = []
    const redoStack = []
    let batchDepth = 0
    let batchEntries = null

    // ── Records ──

    function makeRecord(raw, style) {
        const text = raw ?? ''
        if (text.startsWith('=') && text.length > 1) {
            try {
                return Object.freeze({ raw: null, ast: parseFormula(text, BIND), bad: false, style })
            } catch {
                return Object.freeze({ raw: text, ast: null, bad: true, style })
            }
        }
        if (text.trim() === '') return style ? Object.freeze({ raw: '', ast: null, bad: false, style }) : null
        return Object.freeze({ raw: text, ast: null, bad: false, style })
    }

    function withStyle(rec, style) {
        if (!rec) return style ? Object.freeze({ raw: '', ast: null, bad: false, style }) : null
        if (!style && !rec.ast && !rec.bad && rec.raw === '') return null
        return Object.freeze({ ...rec, style })
    }

    function withAst(rec, ast) {
        return Object.freeze({ ...rec, ast })
    }

    function rawText(rec) {
        if (!rec) return ''
        return rec.ast ? serializeFormula(rec.ast, POS) : rec.raw
    }

    const hasContent = (rec) => !!rec && (rec.ast !== null || rec.raw !== '')

    // ── Dependency bookkeeping ──

    function registerFormula(key, ast) {
        formulaKeys.add(key)
        const ranges = []
        visitRefs(ast, (ref) => {
            const k = keyOf(ref.row, ref.col)
            let set = dependents.get(k)
            if (!set) dependents.set(k, set = new Set())
            set.add(key)
        }, (range) => ranges.push(range))
        if (ranges.length) { rangeFormulas.set(key, ranges); rangeIndex = null }
    }

    function unregisterFormula(key, ast) {
        formulaKeys.delete(key)
        visitRefs(ast, (ref) => {
            const k = keyOf(ref.row, ref.col)
            const set = dependents.get(k)
            if (set) { set.delete(key); if (set.size === 0) dependents.delete(k) }
        }, () => {})
        if (rangeFormulas.delete(key)) rangeIndex = null
    }

    function rangeBounds(node) {
        const r1 = rowPosOf(node.a.row), r2 = rowPosOf(node.b.row)
        const c1 = colPosOf(node.a.col), c2 = colPosOf(node.b.col)
        if (r1 < 0 || r2 < 0 || c1 < 0 || c2 < 0) return null
        return { r1: Math.min(r1, r2), r2: Math.max(r1, r2), c1: Math.min(c1, c2), c2: Math.max(c1, c2) }
    }

    function getRangeIndex() {
        if (rangeIndex) return rangeIndex
        rangeIndex = new Map()
        for (const [key, nodes] of rangeFormulas) {
            for (const node of nodes) {
                const b = rangeBounds(node)
                if (!b) continue
                for (let c = b.c1; c <= b.c2; c++) {
                    let list = rangeIndex.get(c)
                    if (!list) rangeIndex.set(c, list = [])
                    list.push({ key, b })
                }
            }
        }
        return rangeIndex
    }

    /**
     * Drops cached values for `changed` keys and everything that depends on
     * them, wave by wave. Invariant: if a cell is not cached, nothing that
     * depends on it is cached either — so a wave stops at uncached cells.
     */
    function invalidate(changed) {
        let wave = []
        for (const k of changed) { values.delete(k); wave.push(k) }
        while (wave.length) {
            const next = []
            const drop = (d) => { if (values.has(d)) { values.delete(d); next.push(d) } }
            const byCol = new Map()
            for (const k of wave) {
                const deps = dependents.get(k)
                if (deps) for (const d of deps) drop(d)
                if (rangeFormulas.size) {
                    const r = rowPosOf(rowIdOfKey(k)), c = colPosOf(colIdOfKey(k))
                    if (r < 0 || c < 0) continue
                    const span = byCol.get(c)
                    if (!span) byCol.set(c, { lo: r, hi: r })
                    else { if (r < span.lo) span.lo = r; if (r > span.hi) span.hi = r }
                }
            }
            if (byCol.size) {
                const index = getRangeIndex()
                for (const [c, span] of byCol) {
                    const list = index.get(c)
                    if (!list) continue
                    for (const { key, b } of list) if (b.r1 <= span.hi && b.r2 >= span.lo) drop(key)
                }
            }
            wave = next
        }
    }

    /**
     * The one write primitive. `changes` is [[key, record|null], …].
     * Returns the inverse change list. Does not touch the undo stack.
     */
    function writeRecords(changes) {
        const inverse = new Array(changes.length)
        const changedKeys = []
        for (let i = 0; i < changes.length; i++) {
            const [key, rec] = changes[i]
            const old = cells.get(key) ?? null
            inverse[changes.length - 1 - i] = [key, old]
            if (old === rec) continue
            if (old && old.ast) unregisterFormula(key, old.ast)
            if (rec) cells.set(key, rec); else cells.delete(key)
            if (rec && rec.ast) registerFormula(key, rec.ast)
            const contentChanged = (old?.ast ?? old?.raw ?? '') !== (rec?.ast ?? rec?.raw ?? '') || (old?.bad ?? false) !== (rec?.bad ?? false)
            if (contentChanged) changedKeys.push(key)
        }
        if (changedKeys.length) { invalidate(changedKeys); contentVersion++ }
        return inverse
    }

    // ── Undo plumbing ──

    function record(entry) {
        if (batchDepth > 0) { batchEntries.push(entry); return }
        undoStack.push(entry)
        if (undoStack.length > MAX_UNDO_HISTORY) undoStack.shift()
        redoStack.length = 0
    }

    function recordWrite(label, changes) {
        const inverse = writeRecords(changes)
        if (changes.length) record({ label, undo: () => writeRecords(inverse), redo: () => writeRecords(changes) })
    }

    /**
     * Runs fn() so that every recorded change inside it becomes ONE undo step.
     * If fn throws, everything it did is rolled back and the error rethrown.
     */
    function batch(label, fn) {
        batchDepth++
        if (batchDepth === 1) batchEntries = []
        let result
        try {
            result = fn()
        } catch (error) {
            if (batchDepth === 1) {
                for (let i = batchEntries.length - 1; i >= 0; i--) batchEntries[i].undo()
                batchEntries = null
            }
            batchDepth--
            throw error
        }
        batchDepth--
        if (batchDepth === 0) {
            const entries = batchEntries
            batchEntries = null
            if (entries.length) {
                record({
                    label,
                    undo: () => { for (let i = entries.length - 1; i >= 0; i--) entries[i].undo() },
                    redo: () => { for (const e of entries) e.redo() },
                })
            }
        }
        return result
    }

    function undo() {
        const entry = undoStack.pop()
        if (!entry) return false
        entry.undo()
        redoStack.push(entry)
        return true
    }

    function redo() {
        const entry = redoStack.pop()
        if (!entry) return false
        entry.redo()
        undoStack.push(entry)
        return true
    }

    // ── Evaluation ──

    function literalValue(rec) {
        if (!rec) return ''
        if (rec.bad) return ERR.PARSE
        const n = parseLiteralNumber(rec.raw)
        return n === null ? rec.raw : n
    }

    /** Value of a key for the evaluator; only reads, never recurses. */
    function peek(key) {
        if (values.has(key)) return values.get(key)
        const rec = cells.get(key)
        if (!rec || !rec.ast) return literalValue(rec)
        return ERR.CYCLE // a formula still being evaluated: we are inside a cycle
    }

    const evalCtx = {
        value(rowId, colId) {
            if (rowPosOf(rowId) < 0 || colPosOf(colId) < 0) return ERR.REF
            return peek(keyOf(rowId, colId))
        },
        range(node) {
            const b = rangeBounds(node)
            if (!b) return ERR.REF
            const out = []
            for (let r = b.r1; r <= b.r2; r++) {
                const rowId = rowOrder[r]
                for (let c = b.c1; c <= b.c2; c++) out.push(peek(keyOf(rowId, colOrder[c])))
            }
            return out
        },
    }

    function computeFormula(ast) {
        const v = evaluate(ast, evalCtx)
        if (typeof v === 'number') {
            if (!Number.isFinite(v)) return ERR.VALUE
            return v === 0 ? 0 : v // normalise -0
        }
        return v
    }

    /** Formula keys this formula reads that are not cached yet. */
    function pendingPrecedents(ast, out) {
        visitRefs(ast, (ref) => {
            if (rowPosOf(ref.row) < 0 || colPosOf(ref.col) < 0) return
            const k = keyOf(ref.row, ref.col)
            if (!values.has(k)) { const rec = cells.get(k); if (rec && rec.ast) out.push(k) }
        }, (node) => {
            const b = rangeBounds(node)
            if (!b) return
            for (let r = b.r1; r <= b.r2; r++) {
                const rowId = rowOrder[r]
                for (let c = b.c1; c <= b.c2; c++) {
                    const k = keyOf(rowId, colOrder[c])
                    if (!values.has(k) && formulaKeys.has(k)) out.push(k)
                }
            }
        })
        return out
    }

    /**
     * Computes a cell, evaluating uncached precedents first with an explicit
     * stack (no recursion, so a 100k-long chain cannot overflow). A precedent
     * that is still on the current path is a cycle: both ends get #CYCLE! and
     * the error propagates to everything in between.
     */
    function valueOf(key) {
        if (values.has(key)) return values.get(key)
        const rec = cells.get(key)
        if (!rec || !rec.ast) {
            const v = literalValue(rec)
            if (rec) values.set(key, v)
            return v
        }
        const stack = [key]
        const onPath = new Set()
        while (stack.length) {
            const k = stack[stack.length - 1]
            if (values.has(k)) { stack.pop(); onPath.delete(k); continue }
            const r = cells.get(k)
            if (onPath.has(k)) {
                values.set(k, computeFormula(r.ast))
                onPath.delete(k)
                stack.pop()
                continue
            }
            onPath.add(k)
            for (const p of pendingPrecedents(r.ast, [])) {
                if (onPath.has(p)) { values.set(p, ERR.CYCLE); values.set(k, ERR.CYCLE); break }
                stack.push(p)
            }
        }
        return values.get(key)
    }

    // ── Reading cells ──

    function inBounds(row, col) {
        return row >= 0 && col >= 0 && row < rowOrder.length && col < colOrder.length
    }

    function recordAt(row, col) {
        return inBounds(row, col) ? cells.get(keyAt(row, col)) ?? null : null
    }

    /** Text the grid would show before number formatting. */
    function textAt(row, col) {
        if (!inBounds(row, col)) return ''
        const key = keyAt(row, col)
        const rec = cells.get(key)
        if (!rec) return ''
        if (!rec.ast) return rec.bad ? ERR.PARSE.error : rec.raw
        const v = valueOf(key)
        if (isError(v)) return v.error
        return typeof v === 'number' ? numberToText(v) : String(v)
    }

    function getCell(row, col) {
        const rec = recordAt(row, col)
        if (!rec) return { raw: '', computed: '', error: null, style: DEFAULT_STYLE }
        const v = valueOf(keyAt(row, col))
        const style = rec.style ? { ...DEFAULT_STYLE, ...rec.style } : DEFAULT_STYLE
        if (isError(v)) return { raw: rawText(rec), computed: null, error: v.error, style }
        return { raw: rawText(rec), computed: v, error: null, style }
    }

    function getDisplay(row, col) {
        const rec = recordAt(row, col)
        if (!rec) return ''
        const text = textAt(row, col)
        const nf = rec.style?.numberFormat
        return nf ? formatForDisplay(text, nf) : text
    }

    /** Everything the grid needs to paint one cell, in one lookup. */
    function getView(row, col) {
        const rec = recordAt(row, col)
        if (!rec) return EMPTY_VIEW
        const text = textAt(row, col)
        const style = rec.style ? { ...DEFAULT_STYLE, ...rec.style } : DEFAULT_STYLE
        const error = rec.bad || (rec.ast !== null && isError(values.get(keyAt(row, col))))
        return { text: rec.style?.numberFormat ? formatForDisplay(text, rec.style.numberFormat) : text, style, error }
    }

    function getStyle(row, col) {
        const rec = recordAt(row, col)
        return rec?.style ? { ...DEFAULT_STYLE, ...rec.style } : DEFAULT_STYLE
    }

    function isErrorAt(row, col) {
        const rec = recordAt(row, col)
        if (!rec) return false
        if (rec.bad) return true
        return rec.ast ? isError(valueOf(keyAt(row, col))) : false
    }

    // ── Used range ──

    function getUsedRange() {
        if (usedCache.version === contentVersion) return usedCache.range
        let r1 = Infinity, c1 = Infinity, r2 = -1, c2 = -1
        for (const [key, rec] of cells) {
            if (!hasContent(rec)) continue
            const r = rowPosOf(rowIdOfKey(key)), c = colPosOf(colIdOfKey(key))
            if (r < 0 || c < 0) continue
            if (r < r1) r1 = r
            if (r > r2) r2 = r
            if (c < c1) c1 = c
            if (c > c2) c2 = c
        }
        const range = r2 < 0 ? null : { r1, c1, r2, c2 }
        usedCache = { version: contentVersion, range }
        return range
    }

    function bumpStructure() {
        values.clear()
        rangeIndex = null
        contentVersion++
        layoutVersion++
    }

    // ── Cell edits ──

    function setCell(row, col, raw) {
        if (!inBounds(row, col)) return
        const key = keyAt(row, col)
        const old = cells.get(key) ?? null
        if (rawText(old) === (raw ?? '')) return
        recordWrite('Edit cell', [[key, makeRecord(raw ?? '', old?.style ?? null)]])
    }

    /** Writes a matrix of raw strings with its top-left at (row, col), growing the grid if needed. One undo step. */
    function setRange(row, col, matrix, label = 'Paste') {
        const height = matrix.length
        const width = Math.max(0, ...matrix.map(r => r.length))
        if (row + height > rowOrder.length || col + width > colOrder.length) {
            ensureCapacity(row + height, col + width)
        }
        const changes = []
        for (let r = 0; r < height; r++) {
            for (let c = 0; c < matrix[r].length; c++) {
                const key = keyAt(row + r, col + c)
                const old = cells.get(key) ?? null
                const raw = matrix[r][c] ?? ''
                if (rawText(old) === raw) continue
                changes.push([key, makeRecord(raw, old?.style ?? null)])
            }
        }
        recordWrite(label, changes)
        return changes.length
    }

    function forEachKeyIn(range, fn) {
        const r2 = Math.min(range.r2, rowOrder.length - 1)
        const c2 = Math.min(range.c2, colOrder.length - 1)
        for (let r = Math.max(0, range.r1); r <= r2; r++) {
            const rowId = rowOrder[r]
            for (let c = Math.max(0, range.c1); c <= c2; c++) fn(keyOf(rowId, colOrder[c]), r, c)
        }
    }

    /** Whole-row / whole-column selections are clipped to the used range for bulk writes. */
    function clipToUsed(range) {
        const used = getUsedRange()
        const fullCols = range.r1 === 0 && range.r2 >= rowOrder.length - 1
        const fullRows = range.c1 === 0 && range.c2 >= colOrder.length - 1
        if (!fullCols && !fullRows) return range
        if (!used) return null
        const out = { ...range }
        if (fullCols) out.r2 = Math.max(used.r2, 0)
        if (fullRows) out.c2 = Math.max(used.c2, 0)
        return out
    }

    /** Clears contents (and styles when `styles`) in a range. One undo step. */
    function clearRange(range, { styles = false } = {}) {
        const target = clipToUsed(range)
        if (!target) return 0
        const changes = []
        forEachKeyIn(target, (key) => {
            const rec = cells.get(key)
            if (!rec) return
            const next = styles ? null : withStyle({ raw: '', ast: null, bad: false }, rec.style)
            if (next !== rec && (hasContent(rec) || styles)) changes.push([key, next])
        })
        recordWrite(styles ? 'Clear' : 'Delete', changes)
        return changes.length
    }

    function clearAll() {
        const changes = []
        for (const [key] of cells) if (isAlive(key)) changes.push([key, null])
        batch('Clear all', () => {
            recordWrite('Clear all', changes)
            if (filters.size) setFiltersInternal(new Map())
        })
    }

    // ── Styles ──

    /** Merges `patch` into the style of every cell in range. One undo step. */
    function setStyle(range, patch) {
        const target = clipToUsed(range)
        if (!target) return 0
        const changes = []
        forEachKeyIn(target, (key) => {
            const rec = cells.get(key) ?? null
            const merged = compactStyle({ ...DEFAULT_STYLE, ...(rec?.style ?? {}), ...patch })
            if (sameStyle(merged, rec?.style ?? null)) return
            changes.push([key, withStyle(rec, merged)])
        })
        recordWrite('Format', changes)
        return changes.length
    }

    /** Replaces styles cell by cell: entries are [row, col, fullStyle|null]. One undo step. */
    function setStyles(entries, label = 'Format') {
        const changes = []
        for (const [row, col, style] of entries) {
            if (!inBounds(row, col)) continue
            const key = keyAt(row, col)
            const rec = cells.get(key) ?? null
            const next = compactStyle(style)
            if (sameStyle(next, rec?.style ?? null)) continue
            changes.push([key, withStyle(rec, next)])
        }
        recordWrite(label, changes)
        return changes.length
    }

    // ── Fill ──

    function shiftAst(ast, dr, dc) {
        const shiftRef = (ref) => {
            let row = ref.row, col = ref.col
            if (!ref.ar && dr) {
                const p = rowPosOf(ref.row)
                if (p >= 0) { row = rowIdAt(p + dr); if (row < 0) return { t: 'err', code: '#REF!' } }
            }
            if (!ref.ac && dc) {
                const p = colPosOf(ref.col)
                if (p >= 0) { col = colIdAt(p + dc); if (col < 0) return { t: 'err', code: '#REF!' } }
            }
            return row === ref.row && col === ref.col ? ref : { ...ref, row, col }
        }
        return mapRefs(ast, shiftRef, (range) => {
            const a = shiftRef(range.a), b = shiftRef(range.b)
            if (a.t === 'err' || b.t === 'err') return { t: 'err', code: '#REF!' }
            return a === range.a && b === range.b ? range : { ...range, a, b }
        })
    }

    /**
     * Fills `dest` from the seed cells in `src`. `dest` must contain `src` and
     * extend it along one axis. Values, series, shifted formulas and seed
     * styles are written in one undo step. Returns the number of cells written.
     */
    function fill(src, dest) {
        const vertical = dest.r1 < src.r1 || dest.r2 > src.r2
        const changes = []
        const lanes = vertical ? [src.c1, src.c2] : [src.r1, src.r2]
        const seedLen = vertical ? src.r2 - src.r1 + 1 : src.c2 - src.c1 + 1
        const start = vertical ? src.r1 : src.c1
        const targets = []
        if (vertical) {
            for (let r = dest.r1; r < src.r1; r++) targets.push(r)
            for (let r = src.r2 + 1; r <= dest.r2; r++) targets.push(r)
        } else {
            for (let c = dest.c1; c < src.c1; c++) targets.push(c)
            for (let c = src.c2 + 1; c <= dest.c2; c++) targets.push(c)
        }
        const indices = targets.map(p => p - start)
        for (let lane = lanes[0]; lane <= lanes[1]; lane++) {
            const seedRecs = []
            for (let i = 0; i < seedLen; i++) {
                seedRecs.push(vertical ? recordAt(start + i, lane) : recordAt(lane, start + i))
            }
            const seeds = seedRecs.map(rec => ({ raw: rec ? (rec.ast ? '' : rec.raw) : '', formula: !!rec?.ast }))
            const plan = planLane(seeds, indices)
            for (let i = 0; i < targets.length; i++) {
                const row = vertical ? targets[i] : lane
                const col = vertical ? lane : targets[i]
                if (!inBounds(row, col)) continue
                const step = plan[i]
                const seedRec = seedRecs[step.seed]
                const style = seedRec?.style ?? null
                let rec
                if (step.offset !== undefined) {
                    const ast = shiftAst(seedRec.ast, vertical ? step.offset : 0, vertical ? 0 : step.offset)
                    rec = Object.freeze({ raw: null, ast, bad: false, style })
                } else {
                    rec = makeRecord(step.raw, style)
                }
                const key = keyAt(row, col)
                if ((cells.get(key) ?? null) !== rec) changes.push([key, rec])
            }
        }
        recordWrite('Fill', changes)
        return changes.length
    }

    // ── Structure: insert / delete rows and columns ──

    function rebuildRowPositions(from) {
        for (let p = from; p < rowOrder.length; p++) rowPosById[rowOrder[p]] = p
    }
    function rebuildColPositions(from) {
        for (let p = from; p < colOrder.length; p++) colPosById[colOrder[p]] = p
    }

    function spliceIn(order, rebuild, at, ids) {
        order.splice(at, 0, ...ids)
        rebuild(at)
        bumpStructure()
    }

    function spliceOut(order, posById, rebuild, at, count) {
        const ids = order.splice(at, count)
        for (const id of ids) posById[id] = -1
        rebuild(at)
        bumpStructure()
        return ids
    }

    /**
     * After deleting rows/columns, a range whose endpoint was deleted would
     * read #REF!. Like other spreadsheets, shrink it to the surviving part
     * instead; only a range that loses every row/column becomes #REF!.
     * `axis` is 'row' or 'col'; `before` maps the removed ids to their old positions.
     */
    function shrinkRangesAfterDelete(axis, removed, at, count) {
        const changes = []
        const posOf = axis === 'row' ? rowPosOf : colPosOf
        const idAt = axis === 'row' ? rowIdAt : colIdAt
        const field = axis === 'row' ? 'row' : 'col'
        for (const [key, nodes] of rangeFormulas) {
            if (!isAlive(key)) continue
            if (!nodes.some(n => removed.has(n.a[field]) || removed.has(n.b[field]))) continue
            const rec = cells.get(key)
            const ast = mapRefs(rec.ast, (ref) => ref, (range) => {
                const aGone = removed.has(range.a[field]), bGone = removed.has(range.b[field])
                if (!aGone && !bGone) return range
                // Old positions: survivors are where they are; removed ones were at `at`..`at+count-1`.
                const oldPos = (end) => removed.has(end[field]) ? removed.get(end[field]) : (posOf(end[field]) >= at ? posOf(end[field]) + count : posOf(end[field]))
                const pa = oldPos(range.a), pb = oldPos(range.b)
                const lo = Math.min(pa, pb), hi = Math.max(pa, pb)
                const newLo = lo >= at && lo < at + count ? at : (lo >= at + count ? lo - count : lo)
                const newHi = hi >= at && hi < at + count ? at - 1 : (hi >= at + count ? hi - count : hi)
                if (newHi < newLo) return { t: 'err', code: '#REF!' }
                const loEnd = pa <= pb ? 'a' : 'b'
                const hiEnd = loEnd === 'a' ? 'b' : 'a'
                return {
                    ...range,
                    [loEnd]: { ...range[loEnd], [field]: idAt(newLo) },
                    [hiEnd]: { ...range[hiEnd], [field]: idAt(newHi) },
                }
            })
            if (ast !== rec.ast) changes.push([key, withAst(rec, ast)])
        }
        return changes
    }

    function insertRows(at, count = 1) {
        at = Math.max(0, Math.min(at, rowOrder.length))
        const ids = []
        for (let i = 0; i < count; i++) ids.push(nextRowId++)
        const doIt = () => spliceIn(rowOrder, rebuildRowPositions, at, ids)
        const undoIt = () => spliceOut(rowOrder, rowPosById, rebuildRowPositions, at, count)
        doIt()
        record({ label: 'Insert row', undo: undoIt, redo: doIt })
    }

    function deleteRows(at, count = 1) {
        if (at < 0 || at >= rowOrder.length) return
        count = Math.min(count, rowOrder.length - at)
        batch('Delete row', () => {
            const ids = rowOrder.slice(at, at + count)
            const doIt = () => spliceOut(rowOrder, rowPosById, rebuildRowPositions, at, count)
            const undoIt = () => spliceIn(rowOrder, rebuildRowPositions, at, ids)
            doIt()
            record({ label: 'Delete row', undo: undoIt, redo: doIt })
            const removed = new Map(ids.map((id, i) => [id, at + i]))
            recordWrite('Delete row', shrinkRangesAfterDelete('row', removed, at, count))
        })
    }

    function insertColumns(at, count = 1) {
        at = Math.max(0, Math.min(at, colOrder.length))
        const ids = []
        for (let i = 0; i < count; i++) ids.push(nextColId++)
        const doIt = () => spliceIn(colOrder, rebuildColPositions, at, ids)
        const undoIt = () => spliceOut(colOrder, colPosById, rebuildColPositions, at, count)
        doIt()
        record({ label: 'Insert column', undo: undoIt, redo: doIt })
    }

    function deleteColumns(at, count = 1) {
        if (at < 0 || at >= colOrder.length) return
        count = Math.min(count, colOrder.length - at)
        batch('Delete column', () => {
            const ids = colOrder.slice(at, at + count)
            const doIt = () => spliceOut(colOrder, colPosById, rebuildColPositions, at, count)
            const undoIt = () => spliceIn(colOrder, rebuildColPositions, at, ids)
            doIt()
            record({ label: 'Delete column', undo: undoIt, redo: doIt })
            const removed = new Map(ids.map((id, i) => [id, at + i]))
            recordWrite('Delete column', shrinkRangesAfterDelete('col', removed, at, count))
        })
    }

    function ensureCapacity(minRows, minCols) {
        if (minRows > rowOrder.length) { appendRows(minRows - rowOrder.length); layoutVersion++ }
        if (minCols > colOrder.length) { appendCols(minCols - colOrder.length); layoutVersion++ }
    }

    // ── Sizes and freeze ──

    function setSize(map, id, value, fallback, label) {
        const old = map.get(id)
        const next = value === fallback ? undefined : value
        if (old === next) return false
        const apply = (v) => { if (v === undefined) map.delete(id); else map.set(id, v); layoutVersion++ }
        apply(next)
        record({ label, undo: () => apply(old), redo: () => apply(next) })
        return true
    }

    function getColWidth(col) {
        return colWidths.get(colOrder[col]) ?? DEFAULT_COL_WIDTH
    }
    function setColWidth(col, width) {
        if (col < 0 || col >= colOrder.length) return false
        const w = Math.round(Math.max(MIN_COL_WIDTH, Math.min(MAX_COL_WIDTH, width)))
        return setSize(colWidths, colOrder[col], w, DEFAULT_COL_WIDTH, 'Resize column')
    }
    function getRowHeight(row) {
        const id = rowOrder[row]
        if (hiddenRows.has(id)) return 0
        return rowHeights.get(id) ?? DEFAULT_ROW_HEIGHT
    }
    function setRowHeight(row, height) {
        if (row < 0 || row >= rowOrder.length) return false
        const h = Math.round(Math.max(12, Math.min(400, height)))
        return setSize(rowHeights, rowOrder[row], h, DEFAULT_ROW_HEIGHT, 'Resize row')
    }

    /**
     * Width that fits every used cell in a column. `measure(text, style)` returns
     * pixels; the engine never touches the DOM, the UI passes a canvas measurer.
     */
    function measureColumn(col, measure) {
        const used = getUsedRange()
        let best = 0
        if (used) {
            for (let r = used.r1; r <= used.r2; r++) {
                const rec = recordAt(r, col)
                if (!rec) continue
                const text = getDisplay(r, col)
                if (text !== '') best = Math.max(best, measure(text, getStyle(r, col)))
            }
        }
        return Math.max(MIN_COL_WIDTH, Math.min(MAX_COL_WIDTH, Math.ceil(best + 12)))
    }

    function autoFitColumn(col, measure) {
        return setColWidth(col, measureColumn(col, measure))
    }

    function setFrozen(rowsCount, colsCount = frozenCols) {
        const prev = [frozenRows, frozenCols]
        const next = [Math.max(0, rowsCount | 0), Math.max(0, colsCount | 0)]
        if (prev[0] === next[0] && prev[1] === next[1]) return false
        const apply = ([r, c]) => { frozenRows = r; frozenCols = c; layoutVersion++ }
        apply(next)
        record({ label: 'Freeze', undo: () => apply(prev), redo: () => apply(next) })
        return true
    }

    // ── Filters (a view: rows are hidden, never moved or removed) ──

    /** Data rows a filter applies to: everything under the used range's header row. */
    function filterRows() {
        const used = getUsedRange()
        if (!used || used.r2 <= used.r1) return null
        return { first: used.r1 + 1, last: used.r2, header: used.r1 }
    }

    function rowPassesFilters(row, list) {
        for (const [colId, f] of list) {
            const col = colPosOf(colId)
            if (col < 0) continue
            const text = textAt(row, col)
            const key = norm(text)
            if (f.values && !f.values.has(key)) return false
            if (f.cond && !conditionHolds(f.cond, text)) return false
        }
        return true
    }

    function computeHidden(nextFilters) {
        const hidden = new Set()
        const span = filterRows()
        if (!span || nextFilters.size === 0) return hidden
        const list = [...nextFilters]
        for (let r = span.first; r <= span.last; r++) {
            if (!rowPassesFilters(r, list)) hidden.add(rowOrder[r])
        }
        return hidden
    }

    function setFiltersInternal(nextFilters) {
        const prevFilters = new Map(filters)
        const prevHidden = hiddenRows
        const nextHidden = computeHidden(nextFilters)
        const apply = (f, h) => {
            filters.clear()
            for (const [k, v] of f) filters.set(k, v)
            hiddenRows = h
            layoutVersion++
        }
        apply(nextFilters, nextHidden)
        record({ label: 'Filter', undo: () => apply(prevFilters, prevHidden), redo: () => apply(nextFilters, nextHidden) })
    }

    /**
     * Sets (or with null, clears) the filter on a column. A filter is
     * { values?: string[] (normalised keys; '' is "(Blanks)"), cond?: { op, value } }
     * with op ∈ contains | gt | lt | isEmpty. One undo step.
     */
    function setFilter(col, filter) {
        const colId = colOrder[col]
        if (colId === undefined) return
        const next = new Map(filters)
        const values = filter?.values ? new Set(filter.values) : null
        const cond = filter?.cond && filter.cond.op ? { op: filter.cond.op, value: filter.cond.value ?? '' } : null
        if (!values && !cond) next.delete(colId)
        else next.set(colId, { values, cond })
        setFiltersInternal(next)
    }

    function clearFilters() {
        if (filters.size) setFiltersInternal(new Map())
    }

    function getFilter(col) {
        const f = filters.get(colOrder[col])
        if (!f) return null
        return { values: f.values ? [...f.values] : null, cond: f.cond ? { ...f.cond } : null }
    }

    /** Distinct values of a column's data rows, grouped by norm() with the first-seen label. */
    function getColumnValues(col) {
        const span = filterRows()
        const groups = new Map()
        if (!span) return []
        for (let r = span.first; r <= span.last; r++) {
            const text = textAt(r, col)
            const key = norm(text)
            const g = groups.get(key)
            if (g) g.count++
            else groups.set(key, { key, label: key === '' ? '(Blanks)' : text.trim(), count: 1 })
        }
        return [...groups.values()].sort((a, b) => {
            if (a.key === '') return 1
            if (b.key === '') return -1
            return compareValues(a.label, b.label)
        })
    }

    function filterStatus() {
        const span = filterRows()
        const total = span ? span.last - span.first + 1 : 0
        let hidden = 0
        if (span) for (let r = span.first; r <= span.last; r++) if (hiddenRows.has(rowOrder[r])) hidden++
        return { active: filters.size > 0, visible: total - hidden, total, columns: [...filters.keys()].map(colPosOf).filter(c => c >= 0) }
    }

    const isRowHidden = (row) => hiddenRows.has(rowOrder[row])

    // ── Geometry (prefix sums, cached per layout version) ──

    let offsetsCache = null
    /** { rowTop, colLeft }: rowTop[r] is the y of row r (hidden rows are 0 tall). */
    function getOffsets() {
        if (offsetsCache && offsetsCache.version === layoutVersion &&
            offsetsCache.rowTop.length === rowOrder.length + 1 && offsetsCache.colLeft.length === colOrder.length + 1) {
            return offsetsCache
        }
        offsetsCache = {
            version: layoutVersion,
            rowTop: prefixSums(rowOrder.length, getRowHeight),
            colLeft: prefixSums(colOrder.length, getColWidth),
        }
        return offsetsCache
    }

    // ── Sort (a physical edit: cell records move between rows) ──

    function sortBlockFor(col, selection) {
        if (selection && selection.r2 > selection.r1 && col >= selection.c1 && col <= selection.c2) {
            return { r1: selection.r1, r2: selection.r2, c1: selection.c1, c2: selection.c2 }
        }
        const used = getUsedRange()
        if (!used || used.r2 <= used.r1) return null
        let r2 = used.r2
        const lastTexts = []
        for (let c = used.c1; c <= used.c2; c++) lastTexts.push(textAt(r2, c))
        if (looksLikeTotalsRow(lastTexts)) r2-- // pin the trailing totals row
        if (r2 <= used.r1) return null
        return { r1: used.r1 + 1, r2, c1: used.c1, c2: Math.max(used.c2, col) }
    }

    /**
     * Reorders the rows of `block` (only the visible ones) into `order`, an
     * array of block-row indices. Cell records move with their row; every
     * single reference to a moved cell is retargeted to where it went, while
     * range references stay put (a SUM over the block is unchanged).
     */
    function permuteRows(visibleRows, order, c1, c2) {
        const moveTo = new Map() // old rowId → new rowId
        for (let i = 0; i < order.length; i++) {
            const from = rowOrder[visibleRows[order[i]]]
            const to = rowOrder[visibleRows[i]]
            if (from !== to) moveTo.set(from, to)
        }
        if (moveTo.size === 0) return []
        const retarget = (ref) => {
            const to = moveTo.get(ref.row)
            if (to === undefined) return ref
            const c = colPosOf(ref.col)
            return c >= c1 && c <= c2 ? { ...ref, row: to } : ref
        }
        const fix = (rec) => {
            if (!rec || !rec.ast) return rec
            const ast = mapRefs(rec.ast, retarget)
            return ast === rec.ast ? rec : withAst(rec, ast)
        }
        const next = new Map()
        // Moved block cells (records travel with their row, styles included).
        for (const [from, to] of moveTo) {
            for (let c = c1; c <= c2; c++) {
                const colId = colOrder[c]
                next.set(keyOf(to, colId), fix(cells.get(keyOf(from, colId)) ?? null))
            }
        }
        // Formulas elsewhere that point into moved rows.
        for (const key of formulaKeys) {
            if (next.has(key) || !isAlive(key)) continue
            const rowId = rowIdOfKey(key), c = colPosOf(colIdOfKey(key))
            if (moveTo.has(rowId) && c >= c1 && c <= c2) continue // its slot is overwritten above
            const rec = cells.get(key)
            const fixed = fix(rec)
            if (fixed !== rec) next.set(key, fixed)
        }
        return [...next]
    }

    function sortKey(text) {
        const t = text.trim()
        if (t === '') return { cls: 3 }
        const n = toNum(t)
        if (n !== null) return { cls: 0, v: n }
        const d = toDate(t)
        if (d) return { cls: 1, v: d }
        return { cls: 2, v: t.toLowerCase() }
    }

    function compareKeys(a, b, dir) {
        if (a.cls === 3 || b.cls === 3) return (a.cls === 3) - (b.cls === 3) // blanks last, both ways
        const sign = dir === 'desc' ? -1 : 1
        if (a.cls !== b.cls) return sign * (a.cls - b.cls)
        return a.v < b.v ? -sign : a.v > b.v ? sign : 0
    }

    function compareValues(x, y) {
        return compareKeys(sortKey(String(x)), sortKey(String(y)), 'asc')
    }

    /**
     * Sorts the data block by `col`. `dir` is 'asc' | 'desc' | 'original'.
     * The block is the selection when it spans several rows, otherwise the
     * used range under the header row with a trailing totals row pinned.
     * Rows hidden by a filter do not move. One undo step.
     */
    function sortBy(col, dir, selection = null) {
        const block = sortBlockFor(col, selection)
        if (!block) return null
        const visibleRows = []
        for (let r = block.r1; r <= block.r2; r++) if (!hiddenRows.has(rowOrder[r])) visibleRows.push(r)
        const blockIds = visibleRows.map(r => rowOrder[r])
        const sameBlock = sortState && sortState.c1 === block.c1 && sortState.c2 === block.c2 &&
            sortState.blockIds.length === blockIds.length && sortState.blockIds.every((id, i) => id === blockIds[i])
        // Stable row identity for "back to original order": tags assigned when a
        // sort sequence starts, travelling with the row contents on every sort.
        const tags = sameBlock ? sortState.tags : visibleRows.map((_, i) => i)

        let order
        if (dir === 'original') {
            order = visibleRows.map((_, i) => i).sort((a, b) => tags[a] - tags[b])
        } else {
            const keys = visibleRows.map(r => sortKey(textAt(r, col)))
            order = visibleRows.map((_, i) => i).sort((a, b) => compareKeys(keys[a], keys[b], dir) || a - b)
        }
        const changes = permuteRows(visibleRows, order, block.c1, block.c2)
        const nextTags = order.map(i => tags[i])
        const prevState = sortState
        const nextState = dir === 'original'
            ? null
            : { c1: block.c1, c2: block.c2, blockIds, tags: nextTags, colId: colOrder[col], dir }
        batch('Sort', () => {
            recordWrite('Sort', changes)
            sortState = nextState
            record({ label: 'Sort', undo: () => { sortState = prevState }, redo: () => { sortState = nextState } })
        })
        return { block, rows: visibleRows.length, moved: changes.length }
    }

    /** Header click: ascending → descending → original order. */
    function cycleSort(col, selection = null) {
        const current = sortState && sortState.colId === colOrder[col] ? sortState.dir : null
        const dir = current === 'asc' ? 'desc' : current === 'desc' ? 'original' : 'asc'
        const result = sortBy(col, dir, selection)
        return result ? { ...result, dir } : null
    }

    function getSortState() {
        if (!sortState) return null
        const col = colPosOf(sortState.colId)
        return col < 0 ? null : { col, dir: sortState.dir }
    }

    // ── Public API ──

    return {
        get rows() { return rowOrder.length },
        get cols() { return colOrder.length },
        get contentVersion() { return contentVersion },
        get layoutVersion() { return layoutVersion },
        get frozenRows() { return frozenRows },
        get frozenCols() { return frozenCols },

        getCell,
        getView,
        getOffsets,
        getDisplay,
        getText: textAt,
        getStyle,
        isError: isErrorAt,
        getUsedRange,

        setCell,
        setRange,
        clearRange,
        clearAll,
        setStyle,
        setStyles,
        fill,

        insertRow: insertRows,
        deleteRow: deleteRows,
        insertColumn: insertColumns,
        deleteColumn: deleteColumns,
        ensureCapacity,

        getColWidth,
        setColWidth,
        getRowHeight,
        setRowHeight,
        measureColumn,
        autoFitColumn,
        setFrozen,

        setFilter,
        getFilter,
        clearFilters,
        getColumnValues,
        filterStatus,
        isRowHidden,

        sortBy,
        cycleSort,
        getSortState,

        batch,
        undo,
        redo,
        canUndo: () => undoStack.length > 0,
        canRedo: () => redoStack.length > 0,
        undoLabel: () => undoStack[undoStack.length - 1]?.label ?? null,
        redoLabel: () => redoStack[redoStack.length - 1]?.label ?? null,
    }
}

function conditionHolds(cond, text) {
    const t = norm(text)
    const v = norm(cond.value)
    switch (cond.op) {
        case 'contains': return t.includes(v)
        case 'isEmpty': return t === ''
        case 'gt':
        case 'lt': {
            const dv = toDate(String(cond.value ?? ''))
            if (dv) {
                const dc = toDate(text)
                if (!dc) return false
                return cond.op === 'gt' ? dc > dv : dc < dv
            }
            const a = toNum(text), b = toNum(cond.value)
            if (a === null || b === null) return false
            return cond.op === 'gt' ? a > b : a < b
        }
        default: return true
    }
}

// ─────────────────────────────────────────────────────────────
//  Spreadsheet engine — pure JS, zero DOM/React imports.
//  All public methods are documented in DESIGN_NOTES.md.
// ─────────────────────────────────────────────────────────────

// NO React or DOM imports — pure computation only.

const OPERATOR_PRECEDENCE = { '+': 1, '-': 1, '*': 2, '/': 2 }
const MAX_UNDO_HISTORY = 200

// ─────────────────────────────────────────────────────────────
//  Column / Cell coordinate utilities
// ─────────────────────────────────────────────────────────────

export function columnLetterToIndex(columnLetter) {
    let index = 0
    for (let i = 0; i < columnLetter.length; i++) {
        index = index * 26 + (columnLetter.charCodeAt(i) - 64)
    }
    return index - 1
}

export function indexToColumnLabel(col) {
    let label = ''
    let num = col + 1
    while (num > 0) {
        num--
        label = String.fromCharCode(65 + (num % 26)) + label
        num = Math.floor(num / 26)
    }
    return label
}

export function indexToCellKey(row, col) {
    return indexToColumnLabel(col) + (row + 1)
}

export function parseCellKey(cellKey) {
    const match = cellKey.match(/^([A-Z]+)(\d+)$/)
    if (!match) return null
    return { row: parseInt(match[2]) - 1, col: columnLetterToIndex(match[1]) }
}

// ─────────────────────────────────────────────────────────────
//  Absolute reference support: $A$1, $A1, A$1
//  A reference token like "$A$1" has colAbs=true, rowAbs=true.
// ─────────────────────────────────────────────────────────────

/**
 * Parse a cell reference string that may have $ prefixes.
 * Returns { colAbs, rowAbs, col, row } or null.
 */
export function parseRef(refStr) {
    const m = refStr.match(/^(\$?)([A-Z]+)(\$?)(\d+)$/)
    if (!m) return null
    return {
        colAbs: m[1] === '$',
        col: columnLetterToIndex(m[2]),
        rowAbs: m[3] === '$',
        row: parseInt(m[4]) - 1,
    }
}

/**
 * Reconstruct a reference string from a parsed ref.
 */
export function refToString({ colAbs, col, rowAbs, row }) {
    return (colAbs ? '$' : '') + indexToColumnLabel(col) +
        (rowAbs ? '$' : '') + (row + 1)
}

// ─────────────────────────────────────────────────────────────
//  Dependency graph (tracks which cells depend on which)
// ─────────────────────────────────────────────────────────────

function createDependencyGraph() {
    const forwardEdges = new Map()  // cell -> Set<deps>
    const reverseEdges = new Map()  // dep  -> Set<dependents>

    function addDependency(cell, dependsOn) {
        if (!forwardEdges.has(cell)) forwardEdges.set(cell, new Set())
        if (!reverseEdges.has(dependsOn)) reverseEdges.set(dependsOn, new Set())
        forwardEdges.get(cell).add(dependsOn)
        reverseEdges.get(dependsOn).add(cell)
    }

    function removeAllDependencies(cell) {
        const deps = forwardEdges.get(cell)
        if (deps) {
            for (const dep of deps) {
                const rev = reverseEdges.get(dep)
                if (rev) {
                    rev.delete(cell)
                    if (rev.size === 0) reverseEdges.delete(dep)
                }
            }
            forwardEdges.delete(cell)
        }
    }

    function getDependencies(cell) { return forwardEdges.get(cell) || new Set() }
    function getDependents(cell) { return reverseEdges.get(cell) || new Set() }

    function getAllDependentsRecursive(cell, visited = new Set()) {
        if (visited.has(cell)) return new Set()
        visited.add(cell)
        const result = new Set()
        for (const dep of getDependents(cell)) {
            result.add(dep)
            for (const ind of getAllDependentsRecursive(dep, visited)) result.add(ind)
        }
        return result
    }

    function hasCycle(startCell) {
        const visited = new Set()
        const stack = new Set()
        const dfs = (node) => {
            if (stack.has(node)) return true
            if (visited.has(node)) return false
            visited.add(node)
            stack.add(node)
            for (const dep of getDependencies(node)) {
                if (dfs(dep)) return true
            }
            stack.delete(node)
            return false
        }
        return dfs(startCell)
    }

    function topologicalSort(affectedCells) {
        const inDegree = new Map()
        const queue = []
        const sorted = []
        for (const cell of affectedCells) inDegree.set(cell, 0)
        for (const cell of affectedCells) {
            for (const dep of getDependencies(cell)) {
                if (affectedCells.has(dep)) inDegree.set(cell, (inDegree.get(cell) || 0) + 1)
            }
        }
        for (const cell of affectedCells) { if (inDegree.get(cell) === 0) queue.push(cell) }
        while (queue.length > 0) {
            const cell = queue.shift()
            sorted.push(cell)
            for (const dep of getDependents(cell)) {
                if (affectedCells.has(dep)) {
                    inDegree.set(dep, inDegree.get(dep) - 1)
                    if (inDegree.get(dep) === 0) queue.push(dep)
                }
            }
        }
        return sorted
    }

    function clear() { forwardEdges.clear(); reverseEdges.clear() }

    return { addDependency, removeAllDependencies, getDependencies, getDependents, getAllDependentsRecursive, hasCycle, topologicalSort, clear }
}

// ─────────────────────────────────────────────────────────────
//  Tokenizer — handles $ prefixes for absolute references
// ─────────────────────────────────────────────────────────────

function tokenize(expression) {
    const tokens = []
    let pos = 0

    while (pos < expression.length) {
        const ch = expression[pos]

        if (ch === ' ') { pos++; continue }
        if (ch === '(' || ch === ')') { tokens.push({ type: 'paren', value: ch }); pos++; continue }
        if ('+-*/,'.includes(ch)) { tokens.push({ type: 'operator', value: ch }); pos++; continue }
        if (ch === ':') { tokens.push({ type: 'colon', value: ':' }); pos++; continue }

        // Number literal
        if ((ch >= '0' && ch <= '9') || ch === '.') {
            let s = ''
            while (pos < expression.length && ((expression[pos] >= '0' && expression[pos] <= '9') || expression[pos] === '.')) {
                s += expression[pos++]
            }
            tokens.push({ type: 'number', value: parseFloat(s) })
            continue
        }

        // String literal
        if (ch === '"') {
            let s = ''
            pos++
            while (pos < expression.length && expression[pos] !== '"') {
                s += expression[pos++]
            }
            pos++ // closing "
            tokens.push({ type: 'string', value: s })
            continue
        }

        // Identifier or cell reference (may start with $)
        if (ch === '$' || (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z')) {
            let s = ''
            // Consume the full reference including possible $ signs
            while (pos < expression.length && /[$A-Za-z0-9]/.test(expression[pos])) {
                s += expression[pos++].toUpperCase()
            }

            // Check if followed by : (range)
            if (expression[pos] === ':') {
                // This is the start of a range. Consume the colon and the end ref.
                pos++ // skip :
                let endRef = ''
                while (pos < expression.length && /[$A-Za-z0-9]/.test(expression[pos])) {
                    endRef += expression[pos++].toUpperCase()
                }
                tokens.push({ type: 'range_literal', start: s, end: endRef })
                continue
            }

            // Cell reference?
            const cellMatch = s.replace(/\$/g, '').match(/^([A-Z]+)(\d+)$/)
            if (cellMatch) {
                tokens.push({ type: 'cell_ref', value: s })
            } else {
                // Function name (no $)
                tokens.push({ type: 'function', value: s })
            }
            continue
        }

        throw new Error(`Unexpected character: ${ch}`)
    }

    return tokens
}

// ─────────────────────────────────────────────────────────────
//  Parser — produces a small AST
// ─────────────────────────────────────────────────────────────

function parse(tokens) {
    let pos = 0

    function peek() { return tokens[pos] }
    function consume() { return tokens[pos++] }

    function parseExpr(minPrec = 0) {
        let left = parseUnary()
        while (true) {
            const tok = peek()
            if (!tok || tok.type !== 'operator' || tok.value === ',') break
            const prec = OPERATOR_PRECEDENCE[tok.value]
            if (prec === undefined || prec <= minPrec) break
            consume()
            const right = parseUnary() // right-assoc: use prec, not prec+1 for same-level
            left = { type: 'binary', op: tok.value, left, right }
        }
        return left
    }

    function parseUnary() {
        const tok = peek()
        if (tok && tok.type === 'operator' && tok.value === '-') {
            consume()
            const operand = parsePrimary()
            return { type: 'unary', op: '-', operand }
        }
        return parsePrimary()
    }

    function parsePrimary() {
        const tok = peek()
        if (!tok) throw new Error('Unexpected end')

        if (tok.type === 'number') { consume(); return { type: 'number', value: tok.value } }
        if (tok.type === 'string') { consume(); return { type: 'string', value: tok.value } }
        if (tok.type === 'range_literal') {
            consume()
            return { type: 'range', start: tok.start, end: tok.end }
        }
        if (tok.type === 'cell_ref') {
            consume()
            return { type: 'cell', ref: tok.value }
        }
        if (tok.type === 'function') {
            consume()
            if (peek()?.value !== '(') throw new Error(`Expected ( after function ${tok.value}`)
            consume() // (
            const args = []
            while (peek()?.value !== ')') {
                if (args.length > 0 && peek()?.value === ',') consume()
                args.push(parseExpr(0))
            }
            consume() // )
            return { type: 'call', name: tok.value, args }
        }
        if (tok.type === 'paren' && tok.value === '(') {
            consume()
            const inner = parseExpr(0)
            if (peek()?.value !== ')') throw new Error('Mismatched parentheses')
            consume()
            return inner
        }
        throw new Error(`Unexpected token: ${JSON.stringify(tok)}`)
    }

    const ast = parseExpr(0)
    return ast
}

// ─────────────────────────────────────────────────────────────
//  Cell range expansion
// ─────────────────────────────────────────────────────────────

function expandRange(startRef, endRef) {
    const s = parseRef(startRef)
    const e = parseRef(endRef)
    if (!s || !e) throw new Error('REF')
    const cells = []
    const r1 = Math.min(s.row, e.row), r2 = Math.max(s.row, e.row)
    const c1 = Math.min(s.col, e.col), c2 = Math.max(s.col, e.col)
    for (let r = r1; r <= r2; r++) {
        for (let c = c1; c <= c2; c++) {
            cells.push(indexToCellKey(r, c))
        }
    }
    return cells
}

// ─────────────────────────────────────────────────────────────
//  Evaluator
// ─────────────────────────────────────────────────────────────

function evalAST(ast, getCellValue, visited = new Set()) {
    if (!ast) return 0
    switch (ast.type) {
        case 'number': return ast.value
        case 'string': return ast.value
        case 'unary': {
            const v = evalAST(ast.operand, getCellValue, visited)
            return ast.op === '-' ? -v : v
        }
        case 'binary': {
            let l = evalAST(ast.left, getCellValue, visited)
            let r = evalAST(ast.right, getCellValue, visited)
            if (l === '' || l === null || l === undefined) l = 0
            if (r === '' || r === null || r === undefined) r = 0
            if (typeof l === 'string') {
                const n = Number(l)
                if (!isNaN(n)) l = n
            }
            if (typeof r === 'string') {
                const n = Number(r)
                if (!isNaN(n)) r = n
            }
            if (typeof l !== 'number' || typeof r !== 'number') throw new Error('VALUE')
            switch (ast.op) {
                case '+': return l + r
                case '-': return l - r
                case '*': return l * r
                case '/': if (r === 0) throw new Error('DIV0'); return l / r
                default: throw new Error('VALUE')
            }
        }
        case 'cell': {
            const ref = parseRef(ast.ref)
            if (!ref) throw new Error('REF')
            const key = indexToCellKey(ref.row, ref.col)
            if (visited.has(key)) throw new Error('CIRCULAR')
            const val = getCellValue(key, visited)
            if (val === '#CYCLE!') throw new Error('CIRCULAR')
            if (val === '#REF!') throw new Error('REF')
            if (val === '#DIV/0!') throw new Error('DIV0')
            if (typeof val === 'string' && val.startsWith('#')) throw new Error('VALUE')
            return val
        }
        case 'range': throw new Error('VALUE')
        case 'call': {
            const { name, args } = ast
            // Aggregate functions expect a single range argument or cell arguments
            if (['SUM', 'AVG', 'MIN', 'MAX', 'COUNT', 'AVERAGE'].includes(name)) {
                const cells = []
                for (const arg of args) {
                    if (arg.type === 'range') {
                        cells.push(...expandRange(arg.start, arg.end))
                    } else if (arg.type === 'cell') {
                        const ref = parseRef(arg.ref)
                        if (ref) cells.push(indexToCellKey(ref.row, ref.col))
                    }
                }
                const nums = []
                for (const k of cells) {
                    if (visited.has(k)) throw new Error('CIRCULAR')
                    const v = getCellValue(k, visited)
                    if (v === '#CYCLE!') throw new Error('CIRCULAR')
                    if (v === '#REF!') throw new Error('REF')
                    if (v === '#DIV/0!') throw new Error('DIV0')
                    if (typeof v === 'string' && v.startsWith('#')) throw new Error('VALUE')
                    if (v !== '' && v !== null && v !== undefined) {
                        const n = parseFloat(v)
                        if (!isNaN(n)) nums.push(n)
                    }
                }
                switch (name) {
                    case 'SUM': return nums.reduce((a, b) => a + b, 0)
                    case 'AVG':
                    case 'AVERAGE': return nums.length === 0 ? 0 : nums.reduce((a, b) => a + b, 0) / nums.length
                    case 'MIN': return nums.length === 0 ? 0 : Math.min(...nums)
                    case 'MAX': return nums.length === 0 ? 0 : Math.max(...nums)
                    case 'COUNT': return nums.length
                    default: throw new Error('VALUE')
                }
            }
            if (name === 'IF') {
                const cond = evalAST(args[0], getCellValue, visited)
                return cond ? evalAST(args[1], getCellValue, visited) : evalAST(args[2], getCellValue, visited)
            }
            if (name === 'ABS') return Math.abs(evalAST(args[0], getCellValue, visited))
            if (name === 'ROUND') {
                const val = evalAST(args[0], getCellValue, visited)
                const dec = args[1] ? evalAST(args[1], getCellValue, visited) : 0
                return Math.round(val * Math.pow(10, dec)) / Math.pow(10, dec)
            }
            throw new Error('VALUE')
        }
        default: throw new Error('VALUE')
    }
}

function evaluateFormula(expression, getCellValue, visited = new Set()) {
    try {
        if (!expression || expression.trim() === '') return { value: '', error: null }
        if (!expression.startsWith('=')) return { value: expression, error: null }
        const body = expression.slice(1).trim()
        if (!body) return { value: '', error: null }
        const tokens = tokenize(body)
        const ast = parse(tokens)
        const result = evalAST(ast, getCellValue, visited)
        return { value: result, error: null }
    } catch (e) {
        const msg = e.message
        if (msg === 'CIRCULAR') return { value: null, error: '#CYCLE!' }
        if (msg === 'REF') return { value: null, error: '#REF!' }
        if (msg === 'VALUE') return { value: null, error: '#VALUE!' }
        if (msg === 'DIV0') return { value: null, error: '#DIV/0!' }
        return { value: null, error: '#PARSE!' }
    }
}

// ─────────────────────────────────────────────────────────────
//  Reference shifting (for fill and insert/delete)
// ─────────────────────────────────────────────────────────────

/**
 * Shift all relative cell references in `formula` by (rowDelta, colDelta).
 * Absolute references ($A$1, $A1, A$1) are respected.
 * atIndex / isCol: when non-null, only shift refs at or after that index.
 */
export function shiftFormulaReferences(formula, rowDelta, colDelta, { atRow = null, atCol = null } = {}) {
    if (!formula || !formula.startsWith('=')) return formula

    // Replace all reference tokens (with optional $ prefixes)
    return formula.replace(/(\$?[A-Z]+\$?\d+)/g, (match) => {
        const ref = parseRef(match)
        if (!ref) return match

        let newRow = ref.row
        let newCol = ref.col

        // Row shift: only when not absolute, and >= atRow if atRow specified
        if (!ref.rowAbs) {
            if (atRow === null || ref.row >= atRow) newRow += rowDelta
        }
        // Col shift: only when not absolute, and >= atCol if atCol specified
        if (!ref.colAbs) {
            if (atCol === null || ref.col >= atCol) newCol += colDelta
        }

        if (newRow < 0 || newCol < 0) return match
        return refToString({ colAbs: ref.colAbs, col: newCol, rowAbs: ref.rowAbs, row: newRow })
    })
}

/**
 * Shift a formula for fill-handle: adjust relative refs by (rowOffset, colOffset).
 * Used when filling from a seed cell to compute each target cell's formula.
 */
export function shiftFormulaForFill(formula, rowOffset, colOffset) {
    return shiftFormulaReferences(formula, rowOffset, colOffset)
}

function extractCellReferences(formula) {
    const refs = new Set()
    const regex = /(\$?[A-Z]+\$?\d+)/g
    let m
    while ((m = regex.exec(formula)) !== null) {
        // Normalize: strip $ for dependency tracking
        const clean = m[1].replace(/\$/g, '')
        refs.add(clean)
    }
    return refs
}

// ─────────────────────────────────────────────────────────────
//  Number-format display helper (pure, no DOM)
// ─────────────────────────────────────────────────────────────

/**
 * toNum: parse a messy cell value into a number or null.
 * Handles $1,200.00 → 1200, 10% → 0.1, N/A → null, etc.
 */
export function toNum(v) {
    if (v === null || v === undefined) return null
    let s = String(v).trim()
    if (s === '' || s.toLowerCase() === 'n/a' || s.toLowerCase() === 'null') return null
    const isPercent = s.endsWith('%')
    s = s.replace(/[$,\s%]/g, '')
    if (!/^-?\d+(\.\d+)?$/.test(s)) return null
    const n = parseFloat(s)
    return isPercent ? n / 100 : n
}

/**
 * Apply a numberFormat to a computed value for display.
 * Stored value is never changed.
 */
export function applyNumberFormat(raw, computed, fmt) {
    if (!fmt || fmt === 'general') return null  // null means "use default display"

    // Only format if we have a numeric value
    const num = typeof computed === 'number' ? computed : toNum(computed ?? raw)
    if (num === null) return null // non-numeric: leave alone

    switch (fmt) {
        case 'number':
            return num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
        case 'currency':
            return '$' + num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
        case 'percent':
            return (num * 100).toFixed(0) + '%'
        case 'date': {
            // Try to parse as a date and display as YYYY-MM-DD
            const d = toDate(raw ?? String(computed))
            return d || null
        }
        default:
            return null
    }
}

/**
 * toDate: parse date strings in three formats to YYYY-MM-DD or null.
 */
export function toDate(v) {
    if (!v) return null
    const s = String(v).trim()
    // YYYY-M-D or YYYY-MM-DD
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
    if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`
    // M/D/YYYY
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
    if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`
    // D Mon YYYY (e.g. 15 Jan 2024)
    const MONTHS = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' }
    m = s.match(/^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})$/)
    if (m) {
        const mo = MONTHS[m[2].toLowerCase().slice(0, 3)]
        if (mo) return `${m[3]}-${mo}-${m[1].padStart(2, '0')}`
    }
    return null
}

// ─────────────────────────────────────────────────────────────
//  Main engine factory
// ─────────────────────────────────────────────────────────────

export function createEngine(initialRows = 50, initialCols = 50) {
    let rows = initialRows
    let cols = initialCols

    // Sparse cell store: key → { raw, computed, error }
    const cells = new Map()
    const graph = createDependencyGraph()
    const dirtyCells = new Set()
    const computedCache = new Map()

    // Styles: key → style object { bold, italic, underline, bg, color, align, fontSize, numberFormat }
    const styles = new Map()

    // Column widths: col index → pixel width
    const colWidths = new Map()
    // Row heights: row index → pixel height
    const rowHeights = new Map()

    // Sort: stable original-order row mapping. rowOrder[visIndex] = physicalRow
    // This maps the visual (sorted) row index to the original physical row.
    let rowOrder = null  // null means "no sort active"
    let rowIdentity = Array.from({ length: rows }, (_, i) => i)
    let nextRowId = rows

    // Filter state: Map<colIndex, { values?: Set<string>, conditions: [...] }>
    const filterState = new Map()

    // Computed filter result: Set of hidden row indices (physical)
    let hiddenRows = new Set()

    // Freeze state
    let frozenRows = 0
    let frozenCols = 0

    // Undo/redo stacks
    const undoStack = []
    const redoStack = []

    let _generation = 0

    // ── Internal helpers ──

    function cellKey(row, col) { return indexToCellKey(row, col) }
    function cellCoords(key) { return parseCellKey(key) }

    function isValidCellKey(key) {
        const c = cellCoords(key)
        return c && c.row >= 0 && c.row < rows && c.col >= 0 && c.col < cols
    }

    function updateDependencies(cell, rawFormula) {
        for (const ref of extractCellReferences(rawFormula)) {
            if (isValidCellKey(ref)) graph.addDependency(cell, ref)
        }
    }

    function markCellDirty(cell) {
        dirtyCells.add(cell)
        for (const dep of graph.getAllDependentsRecursive(cell)) dirtyCells.add(dep)
    }

    function markAllCellsDirty() {
        for (const [key, cell] of cells.entries()) {
            if (cell.raw && cell.raw.startsWith('=')) dirtyCells.add(key)
        }
    }

    // ── Value resolution ──

    function resolveCellValue(key, visited = new Set()) {
        if (visited.has(key)) return '#CYCLE!'
        visited.add(key)

        if (computedCache.has(key)) {
            const cached = computedCache.get(key)
            if (cached._gen === _generation && !dirtyCells.has(key)) {
                visited.delete(key)
                return cached.error || cached.computed
            }
            computedCache.delete(key)
        }

        const cell = cells.get(key)
        if (!cell || !cell.raw) { visited.delete(key); return '' }

        if (!cell.raw.startsWith('=')) {
            const n = toNum(cell.raw)
            visited.delete(key)
            return n !== null ? n : cell.raw
        }

        const result = evaluateFormula(cell.raw, (k, vis) => resolveCellValue(k, vis || visited), visited)
        visited.delete(key)

        if (result.error) {
            computedCache.set(key, { computed: null, error: result.error, _gen: _generation })
            return result.error
        }
        computedCache.set(key, { computed: result.value, error: null, _gen: _generation })
        return result.value
    }

    function recalculate() {
        if (dirtyCells.size === 0) return
        const affected = new Set(dirtyCells)
        const sorted = graph.topologicalSort(affected)
        for (const cell of sorted) {
            if (dirtyCells.has(cell)) { computedCache.delete(cell); resolveCellValue(cell) }
        }
        for (const cell of affected) {
            if (!sorted.includes(cell)) { computedCache.delete(cell); resolveCellValue(cell) }
        }
        dirtyCells.clear()
    }

    // ── Core cell operations ──

    function setCellRaw(row, col, raw) {
        const key = cellKey(row, col)
        graph.removeAllDependencies(key)
        computedCache.delete(key)

        if (!raw || raw.trim() === '') {
            cells.delete(key)
            markCellDirty(key)
            return
        }

        if (raw.startsWith('=')) {
            cells.set(key, { raw, computed: null, error: null })
            updateDependencies(key, raw)
            if (graph.hasCycle(key)) {
                graph.removeAllDependencies(key)
                cells.set(key, { raw, computed: null, error: '#CYCLE!' })
                markCellDirty(key)
                return
            }
        } else {
            cells.set(key, { raw, computed: null, error: null })
        }
        markCellDirty(key)
    }

    function getCellRaw(row, col) {
        const key = cellKey(row, col)
        const cell = cells.get(key)
        if (!cell) return { raw: '', computed: null, error: null }
        return cell
    }

    // ── Snapshot / Restore ──

    function takeSnapshot() {
        const snap = {
            cells: new Map(),
            styles: new Map(),
            colWidths: new Map(colWidths),
            rowHeights: new Map(rowHeights),
            rows, cols,
            rowOrder: rowOrder ? [...rowOrder] : null,
            rowIdentity: [...rowIdentity],
            nextRowId,
            frozenRows, frozenCols,
        }
        for (const [k, v] of cells.entries()) snap.cells.set(k, { ...v })
        for (const [k, v] of styles.entries()) snap.styles.set(k, { ...v })
        return snap
    }

    function restoreSnapshot(snap) {
        cells.clear()
        styles.clear()
        colWidths.clear()
        rowHeights.clear()
        for (const [k, v] of snap.cells.entries()) cells.set(k, { ...v })
        for (const [k, v] of snap.styles.entries()) styles.set(k, { ...v })
        for (const [k, v] of snap.colWidths.entries()) colWidths.set(k, v)
        for (const [k, v] of snap.rowHeights.entries()) rowHeights.set(k, v)
        rows = snap.rows
        cols = snap.cols
        rowOrder = snap.rowOrder ? [...snap.rowOrder] : null
        rowIdentity = snap.rowIdentity ? [...snap.rowIdentity] : Array.from({ length: snap.rows }, (_, i) => i)
        nextRowId = snap.nextRowId ?? rowIdentity.length
        frozenRows = snap.frozenRows ?? 0
        frozenCols = snap.frozenCols ?? 0
        graph.clear()
        computedCache.clear()
        dirtyCells.clear()
        _generation++
        for (const [k, v] of cells.entries()) {
            if (v.raw && v.raw.startsWith('=')) updateDependencies(k, v.raw)
        }
        markAllCellsDirty()
    }

    // ── Row / Column structural operations ──

    function performInsertRow(atIndex) {
        const snap = takeSnapshot()
        cells.clear(); graph.clear(); computedCache.clear(); dirtyCells.clear()
        _generation++
        const newStyles = new Map()
        for (const [key, value] of snap.cells.entries()) {
            const coords = cellCoords(key)
            if (!coords) continue
            if (coords.row >= atIndex) {
                cells.set(cellKey(coords.row + 1, coords.col), {
                    ...value,
                    raw: shiftFormulaReferences(value.raw, 1, 0, { atRow: atIndex })
                })
            } else {
                cells.set(key, {
                    ...value,
                    raw: shiftFormulaReferences(value.raw, 1, 0, { atRow: atIndex })
                })
            }
        }
        for (const [key, value] of snap.styles.entries()) {
            const coords = cellCoords(key)
            if (!coords) continue
            if (coords.row >= atIndex) {
                newStyles.set(cellKey(coords.row + 1, coords.col), { ...value })
            } else {
                newStyles.set(key, { ...value })
            }
        }
        styles.clear()
        for (const [k, v] of newStyles.entries()) styles.set(k, v)
        const newHeights = new Map()
        for (const [r, h] of snap.rowHeights.entries()) {
            if (r >= atIndex) newHeights.set(r + 1, h)
            else newHeights.set(r, h)
        }
        rowHeights.clear()
        for (const [k, v] of newHeights.entries()) rowHeights.set(k, v)
        rowIdentity.splice(atIndex, 0, nextRowId++)
        rows++
        for (const [k, v] of cells.entries()) {
            if (v.raw && v.raw.startsWith('=')) updateDependencies(k, v.raw)
        }
        markAllCellsDirty()
    }

    function performDeleteRow(atIndex) {
        const snap = takeSnapshot()
        cells.clear(); graph.clear(); computedCache.clear(); dirtyCells.clear()
        _generation++
        const newStyles = new Map()
        for (const [key, value] of snap.cells.entries()) {
            const coords = cellCoords(key)
            if (!coords || coords.row === atIndex) continue
            if (coords.row > atIndex) {
                cells.set(cellKey(coords.row - 1, coords.col), {
                    ...value,
                    raw: shiftFormulaReferences(value.raw, -1, 0, { atRow: atIndex + 1 })
                })
            } else {
                cells.set(key, {
                    ...value,
                    raw: shiftFormulaReferences(value.raw, -1, 0, { atRow: atIndex + 1 })
                })
            }
        }
        for (const [key, value] of snap.styles.entries()) {
            const coords = cellCoords(key)
            if (!coords || coords.row === atIndex) continue
            if (coords.row > atIndex) {
                newStyles.set(cellKey(coords.row - 1, coords.col), { ...value })
            } else {
                newStyles.set(key, { ...value })
            }
        }
        styles.clear()
        for (const [k, v] of newStyles.entries()) styles.set(k, v)
        const newHeights = new Map()
        for (const [r, h] of snap.rowHeights.entries()) {
            if (r === atIndex) continue
            if (r > atIndex) newHeights.set(r - 1, h)
            else newHeights.set(r, h)
        }
        rowHeights.clear()
        for (const [k, v] of newHeights.entries()) rowHeights.set(k, v)
        rowIdentity.splice(atIndex, 1)
        rows--
        for (const [k, v] of cells.entries()) {
            if (v.raw && v.raw.startsWith('=')) updateDependencies(k, v.raw)
        }
        markAllCellsDirty()
    }

    function performInsertColumn(atIndex) {
        const snap = takeSnapshot()
        cells.clear(); graph.clear(); computedCache.clear(); dirtyCells.clear()
        _generation++
        const newStyles = new Map()
        const newWidths = new Map()
        for (const [key, value] of snap.cells.entries()) {
            const coords = cellCoords(key)
            if (!coords) continue
            if (coords.col >= atIndex) {
                cells.set(cellKey(coords.row, coords.col + 1), {
                    ...value,
                    raw: shiftFormulaReferences(value.raw, 0, 1, { atCol: atIndex })
                })
            } else {
                cells.set(key, {
                    ...value,
                    raw: shiftFormulaReferences(value.raw, 0, 1, { atCol: atIndex })
                })
            }
        }
        for (const [key, value] of snap.styles.entries()) {
            const coords = cellCoords(key)
            if (!coords) continue
            if (coords.col >= atIndex) {
                newStyles.set(cellKey(coords.row, coords.col + 1), { ...value })
            } else {
                newStyles.set(key, { ...value })
            }
        }
        for (const [c, w] of snap.colWidths.entries()) {
            if (c >= atIndex) newWidths.set(c + 1, w)
            else newWidths.set(c, w)
        }
        styles.clear(); for (const [k, v] of newStyles.entries()) styles.set(k, v)
        colWidths.clear(); for (const [k, v] of newWidths.entries()) colWidths.set(k, v)
        cols++
        for (const [k, v] of cells.entries()) {
            if (v.raw && v.raw.startsWith('=')) updateDependencies(k, v.raw)
        }
        markAllCellsDirty()
    }

    function performDeleteColumn(atIndex) {
        const snap = takeSnapshot()
        cells.clear(); graph.clear(); computedCache.clear(); dirtyCells.clear()
        _generation++
        const newStyles = new Map()
        const newWidths = new Map()
        for (const [key, value] of snap.cells.entries()) {
            const coords = cellCoords(key)
            if (!coords || coords.col === atIndex) continue
            if (coords.col > atIndex) {
                cells.set(cellKey(coords.row, coords.col - 1), {
                    ...value,
                    raw: shiftFormulaReferences(value.raw, 0, -1, { atCol: atIndex + 1 })
                })
            } else {
                cells.set(key, {
                    ...value,
                    raw: shiftFormulaReferences(value.raw, 0, -1, { atCol: atIndex + 1 })
                })
            }
        }
        for (const [key, value] of snap.styles.entries()) {
            const coords = cellCoords(key)
            if (!coords || coords.col === atIndex) continue
            if (coords.col > atIndex) {
                newStyles.set(cellKey(coords.row, coords.col - 1), { ...value })
            } else {
                newStyles.set(key, { ...value })
            }
        }
        for (const [c, w] of snap.colWidths.entries()) {
            if (c === atIndex) continue
            if (c > atIndex) newWidths.set(c - 1, w)
            else newWidths.set(c, w)
        }
        styles.clear(); for (const [k, v] of newStyles.entries()) styles.set(k, v)
        colWidths.clear(); for (const [k, v] of newWidths.entries()) colWidths.set(k, v)
        cols--
        for (const [k, v] of cells.entries()) {
            if (v.raw && v.raw.startsWith('=')) updateDependencies(k, v.raw)
        }
        markAllCellsDirty()
    }

    // ── Sort engine ──

    /**
     * Get the used range (rows with any non-empty cell).
     * Returns { startRow, endRow, startCol, endCol }
     */
    function getUsedRange() {
        let minRow = Infinity, maxRow = -Infinity, minCol = Infinity, maxCol = -Infinity
        for (const key of cells.keys()) {
            const c = cellCoords(key)
            if (!c) continue
            if (c.row < minRow) minRow = c.row
            if (c.row > maxRow) maxRow = c.row
            if (c.col < minCol) minCol = c.col
            if (c.col > maxCol) maxCol = c.col
        }
        if (minRow === Infinity) return null
        return { startRow: minRow, endRow: maxRow, startCol: minCol, endCol: maxCol }
    }

    /**
     * Check if a row looks like a totals row (first non-empty cell matches totals pattern).
     */
    function isTotalsRow(rowIndex) {
        for (let c = 0; c < cols; c++) {
            const cell = cells.get(cellKey(rowIndex, c))
            if (!cell || !cell.raw) continue
            const txt = cell.raw.trim()
            if (!txt) continue
            return /^(grand\s+)?(total|totals|subtotal|sum)\b/i.test(txt)
        }
        return false
    }

    /**
     * Sort the data block by a column.
     * direction: 'asc' | 'desc' | 'original'
     * If sortRange is provided use it, otherwise use the used range minus header/totals.
     */
    function performSort(colIndex, direction) {
        const used = getUsedRange()
        if (!used) return

        const headerRow = used.startRow
        const lastRow = used.endRow
        const totals = isTotalsRow(lastRow) ? lastRow : null
        const dataStart = headerRow + 1
        const dataEnd = totals !== null ? lastRow - 1 : lastRow

        if (dataStart > dataEnd) return

        // Initialize rowOrder if not set (identity mapping)
        if (!rowOrder) {
            rowOrder = []
            for (let r = 0; r < rows; r++) rowOrder.push(r)
        }

        if (direction === 'original') {
            const origEntries = []
            for (let vr = dataStart; vr <= dataEnd; vr++) {
                if (hiddenRows.has(vr)) continue
                origEntries.push({ physRow: vr, id: rowIdentity[vr] ?? vr })
            }
            origEntries.sort((a, b) => a.id - b.id)
            if (!rowOrder) {
                rowOrder = []
                for (let r = 0; r < rows; r++) rowOrder.push(r)
            }
            const visDataIndices = []
            for (let vr = dataStart; vr <= dataEnd; vr++) {
                if (!hiddenRows.has(vr)) visDataIndices.push(vr)
            }
            const newRowOrder = [...rowOrder]
            for (let i = 0; i < visDataIndices.length; i++) {
                newRowOrder[visDataIndices[i]] = origEntries[i].physRow
            }
            rowOrder = newRowOrder
            _rewriteCellsFromRowOrder()
            return
        }

        function extractSortKey(val) {
            if (val === '' || val === null || val === undefined) return { isBlank: true }
            const s = String(val).trim()
            if (s === '') return { isBlank: true }
            const n = typeof val === 'number' ? val : toNum(s)
            if (n !== null) return { isNum: true, num: n }
            const d = toDate(s)
            if (d !== null) return { isDate: true, date: d }
            return { isText: true, text: s.toLowerCase() }
        }

        const entries = []
        for (let vr = dataStart; vr <= dataEnd; vr++) {
            const physRow = rowOrder ? rowOrder[vr] : vr
            if (hiddenRows.has(physRow)) continue  // skip hidden rows
            const cell = cells.get(cellKey(physRow, colIndex))
            const rawVal = cell ? cell.raw : ''
            const computedVal = resolveCellValue(cellKey(physRow, colIndex))
            const sortKey = extractSortKey(computedVal !== '' ? computedVal : rawVal)
            entries.push({ physRow, sortKey })
        }

        // Sort entries using precomputed keys
        entries.sort((a, b) => {
            const ak = a.sortKey, bk = b.sortKey
            if (ak.isBlank && bk.isBlank) return 0
            if (ak.isBlank) return 1
            if (bk.isBlank) return -1
            let cmp = 0
            if (ak.isNum && bk.isNum) cmp = ak.num - bk.num
            else if (ak.isNum) cmp = -1
            else if (bk.isNum) cmp = 1
            else if (ak.isDate && bk.isDate) cmp = ak.date < bk.date ? -1 : ak.date > bk.date ? 1 : 0
            else cmp = ak.text.localeCompare(bk.text)
            return direction === 'desc' ? -cmp : cmp
        })

        // Build new row order
        const newRowOrder = rowOrder ? [...rowOrder] : Array.from({ length: rows }, (_, i) => i)
        const sortedPhysRows = entries.map(e => e.physRow)

        // Visible data visual indices in order
        const visDataIndices = []
        for (let vr = dataStart; vr <= dataEnd; vr++) {
            const physRow = rowOrder ? rowOrder[vr] : vr
            if (!hiddenRows.has(physRow)) visDataIndices.push(vr)
        }

        for (let i = 0; i < visDataIndices.length; i++) {
            newRowOrder[visDataIndices[i]] = sortedPhysRows[i]
        }

        rowOrder = newRowOrder

        // Now physically rewrite the cells in sorted order
        _rewriteCellsFromRowOrder()
    }

    /**
     * Physically rewrite all cell data in the order specified by rowOrder.
     * After this, rowOrder is reset to null (natural order).
     */
    function _rewriteCellsFromRowOrder() {
        if (!rowOrder) return

        const snap = takeSnapshot()
        cells.clear(); styles.clear(); graph.clear(); computedCache.clear(); dirtyCells.clear()
        _generation++

        // Group snap cells by row to only iterate cells that actually exist
        const cellsByRow = new Map()
        for (const [key, cell] of snap.cells.entries()) {
            const coords = cellCoords(key)
            if (!coords) continue
            if (!cellsByRow.has(coords.row)) cellsByRow.set(coords.row, [])
            cellsByRow.get(coords.row).push({ col: coords.col, cell })
        }

        const stylesByRow = new Map()
        for (const [key, style] of snap.styles.entries()) {
            const coords = cellCoords(key)
            if (!coords) continue
            if (!stylesByRow.has(coords.row)) stylesByRow.set(coords.row, [])
            stylesByRow.get(coords.row).push({ col: coords.col, style })
        }

        const maxVr = rowOrder.length
        const newIdentity = rowIdentity.slice()
        const newHeights = new Map()
        for (let vr = 0; vr < maxVr; vr++) {
            const physRow = rowOrder[vr]
            const rowDelta = vr - physRow
            newIdentity[vr] = rowIdentity[physRow] ?? physRow
            if (rowHeights.has(physRow)) newHeights.set(vr, rowHeights.get(physRow))
            const rowCells = cellsByRow.get(physRow)
            if (rowCells) {
                for (let i = 0; i < rowCells.length; i++) {
                    const { col, cell: srcCell } = rowCells[i]
                    const dstKey = cellKey(vr, col)
                    let newRaw = srcCell.raw
                    if (rowDelta !== 0 && newRaw && newRaw.startsWith('=')) {
                        newRaw = shiftFormulaForFill(newRaw, rowDelta, 0)
                    }
                    cells.set(dstKey, { ...srcCell, raw: newRaw })
                }
            }
            const rowStyles = stylesByRow.get(physRow)
            if (rowStyles) {
                for (let i = 0; i < rowStyles.length; i++) {
                    const { col, style } = rowStyles[i]
                    styles.set(cellKey(vr, col), { ...style })
                }
            }
        }
        rowIdentity = newIdentity
        rowHeights.clear()
        for (const [k, v] of newHeights.entries()) rowHeights.set(k, v)

        rowOrder = null

        for (const [k, v] of cells.entries()) {
            if (v.raw && v.raw.startsWith('=')) updateDependencies(k, v.raw)
        }
        markAllCellsDirty()
    }

    // ── Filter engine ──

    function recomputeHiddenRows() {
        hiddenRows = new Set()
        if (filterState.size === 0) return

        const used = getUsedRange()
        if (!used) return

        const headerRow = used.startRow
        const lastRow = used.endRow
        const totals = isTotalsRow(lastRow) ? lastRow : null

        for (let r = headerRow + 1; r <= lastRow; r++) {
            if (totals !== null && r === totals) continue // never hide totals row

            let hide = false
            for (const [colIndex, filter] of filterState.entries()) {
                const rawVal = getCellRaw(r, colIndex).raw ?? ''
                const computedVal = resolveCellValue(cellKey(r, colIndex))
                const strVal = String(computedVal ?? rawVal)

                if (!filterMatchesCell(filter, strVal)) {
                    hide = true
                    break
                }
            }
            if (hide) hiddenRows.add(r)
        }
    }

    function filterMatchesCell(filter, strVal) {
        const norm = strVal.trim().toLowerCase()

        // Check "values" checklist (if provided)
        if (filter.values && filter.values.size > 0) {
            if (!filter.values.has(norm) && !filter.values.has(strVal.trim())) {
                return false
            }
        }

        // Check conditions
        if (filter.conditions) {
            for (const cond of filter.conditions) {
                if (!conditionMatches(cond, strVal)) return false
            }
        }

        return true
    }

    function conditionMatches(cond, strVal) {
        const norm = strVal.trim().toLowerCase()
        const v = cond.value ?? ''

        switch (cond.type) {
            case 'contains': return norm.includes(v.toLowerCase())
            case 'notContains': return !norm.includes(v.toLowerCase())
            case 'startsWith': return norm.startsWith(v.toLowerCase())
            case 'endsWith': return norm.endsWith(v.toLowerCase())
            case 'isEmpty': return norm === ''
            case 'notEmpty': return norm !== ''
            case 'equals': return norm === v.toLowerCase()
            case 'notEquals': return norm !== v.toLowerCase()
            case 'greaterThan': {
                const n = toNum(strVal), nv = toNum(v)
                if (n === null || nv === null) return false
                return n > nv
            }
            case 'lessThan': {
                const n = toNum(strVal), nv = toNum(v)
                if (n === null || nv === null) return false
                return n < nv
            }
            case 'greaterThanOrEqual': {
                const n = toNum(strVal), nv = toNum(v)
                if (n === null || nv === null) return false
                return n >= nv
            }
            case 'lessThanOrEqual': {
                const n = toNum(strVal), nv = toNum(v)
                if (n === null || nv === null) return false
                return n <= nv
            }
            default: return true
        }
    }

    /**
     * Get distinct values for a column (for filter checklist).
     */
    function getDistinctColumnValues(colIndex) {
        const used = getUsedRange()
        if (!used) return []
        const values = new Map() // norm → original
        for (let r = used.startRow + 1; r <= used.endRow; r++) {
            const v = getCellRaw(r, colIndex).raw ?? ''
            const norm = v.trim().toLowerCase()
            if (!values.has(norm)) values.set(norm, v.trim())
        }
        return [...values.values()].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
    }

    // ── Undo / Redo ──

    function pushUndo(entry) {
        undoStack.push(entry)
        if (undoStack.length > MAX_UNDO_HISTORY) undoStack.shift()
        redoStack.length = 0
    }

    function executeSetCell(row, col, value) {
        const prev = getCellRaw(row, col).raw
        if (prev !== value) {
            pushUndo({ type: 'set', r: row, c: col, oldVal: prev, newVal: value })
        }
        setCellRaw(row, col, value)
        _generation++
        recalculate()
    }

    /**
     * Bulk set multiple cells as a single undo step.
     * entries: Array<{ row, col, value }>
     */
    function executeBulkSet(entries, opts = {}) {
        if (opts.undo !== false) {
            const oldValues = entries.map(e => ({ r: e.row, c: e.col, val: getCellRaw(e.row, e.col).raw }))
            const newValues = entries.map(e => ({ r: e.row, c: e.col, val: e.value }))
            pushUndo({ type: 'bulk', oldValues, newValues })
        }
        for (const e of entries) {
            if (opts.recalculate === false && !(e.value || '').startsWith('=')) {
                const key = cellKey(e.row, e.col)
                if (!e.value) cells.delete(key)
                else cells.set(key, { raw: e.value, computed: null, error: null })
            } else {
                setCellRaw(e.row, e.col, e.value)
            }
        }
        if (opts.recalculate !== false) {
            _generation++
            recalculate()
        }
    }

    /**
     * Apply a fill-handle result as one undo step (values + inherited styles, including clears).
     * entries: Array<{ row, col, value, style?, clear? }>
     */
    function executeApplyFill(entries) {
        if (!entries || entries.length === 0) return
        const snap = takeSnapshot()
        pushUndo({ type: 'snap', snap, label: 'fill' })
        for (const e of entries) {
            const key = cellKey(e.row, e.col)
            if (e.clear) {
                setCellRaw(e.row, e.col, '')
                styles.delete(key)
            } else {
                setCellRaw(e.row, e.col, e.value)
                if (e.style && Object.keys(e.style).length > 0) {
                    styles.set(key, { ...e.style })
                }
            }
        }
        _generation++
        recalculate()
    }

    function executeInsertRow(atIndex) {
        const snap = takeSnapshot()
        pushUndo({ type: 'snap', snap, label: 'rowins' })
        performInsertRow(atIndex)
        recalculate()
    }

    function executeDeleteRow(atIndex) {
        const snap = takeSnapshot()
        pushUndo({ type: 'snap', snap, label: 'rowdel' })
        performDeleteRow(atIndex)
        recalculate()
    }

    function executeInsertColumn(atIndex) {
        const snap = takeSnapshot()
        pushUndo({ type: 'snap', snap, label: 'colins' })
        performInsertColumn(atIndex)
        recalculate()
    }

    function executeDeleteColumn(atIndex) {
        const snap = takeSnapshot()
        pushUndo({ type: 'snap', snap, label: 'coldel' })
        performDeleteColumn(atIndex)
        recalculate()
    }

    function executeSort(colIndex, direction) {
        const snap = takeSnapshot()
        pushUndo({ type: 'snap', snap, label: 'sort' })
        performSort(colIndex, direction)
        recalculate()
    }

    function cloneFilterState() {
        const m = new Map()
        for (const [k, v] of filterState.entries()) {
            m.set(k, {
                values: v.values ? new Set(v.values) : undefined,
                conditions: v.conditions ? v.conditions.map(c => ({ ...c })) : [],
            })
        }
        return m
    }

    function restoreFilterState(cloned) {
        filterState.clear()
        for (const [k, v] of cloned.entries()) {
            filterState.set(k, {
                values: v.values ? new Set(v.values) : undefined,
                conditions: v.conditions ? v.conditions.map(c => ({ ...c })) : [],
            })
        }
        recomputeHiddenRows()
    }

    function executeSetFilter(colIndex, filterDef) {
        const prev = cloneFilterState()
        if (!filterDef) {
            filterState.delete(colIndex)
        } else {
            filterState.set(colIndex, filterDef)
        }
        recomputeHiddenRows()
        const next = cloneFilterState()
        pushUndo({ type: 'filter', prev, next })
    }

    function executeClearAllFilters() {
        if (filterState.size === 0) return
        const prev = cloneFilterState()
        filterState.clear()
        hiddenRows.clear()
        pushUndo({ type: 'filter', prev, next: cloneFilterState() })
    }

    function executeApplyFormat(action) {
        const snap = takeSnapshot()
        // This is called by the AI format applier; returns NO_CHANGES, OUT_OF_RANGE, or null.
        const result = _applyFormatAction(action)
        if (result === 'NO_CHANGES') return 'NO_CHANGES'
        if (result === 'OUT_OF_RANGE') return 'OUT_OF_RANGE'
        pushUndo({ type: 'snap', snap, label: 'format' })
        return null
    }

    function executeInsertRows(values, atRow, atCol) {
        // Insert query result rows into the sheet at (atRow, atCol).
        // values: Array<Array<string>> — each inner array is a row of cells.
        const snap = takeSnapshot()
        const entries = []
        for (let r = 0; r < values.length; r++) {
            for (let c = 0; c < values[r].length; c++) {
                entries.push({ row: atRow + r, col: atCol + c, value: String(values[r][c] ?? '') })
            }
        }
        pushUndo({ type: 'snap', snap, label: 'insert_result' })
        if (atRow + values.length + 5 > rows) {
            for (let i = rows; i < atRow + values.length + 5; i++) rowIdentity.push(nextRowId++)
            rows = atRow + values.length + 5
        }
        if (atCol + (values[0]?.length ?? 0) + 5 > cols) {
            cols = atCol + (values[0]?.length ?? 0) + 5
        }
        for (const e of entries) setCellRaw(e.row, e.col, e.value)
        _generation++
        recalculate()
    }

    function _applyFormatAction(action) {
        const used = getUsedRange()
        if (!used) return 'NO_CHANGES'

        const { startRow, endRow, startCol, endCol } = used
        const colCount = endCol - startCol + 1
        const usedRowCount = endRow - startRow + 1

        // Check OUT_OF_RANGE for freezeRows
        if (action.freezeRows != null && action.freezeRows >= usedRowCount) {
            return 'OUT_OF_RANGE'
        }

        let changed = false

        const getStyle = (r, c) => {
            const k = cellKey(r, c)
            return styles.get(k) ? { ...styles.get(k) } : {}
        }
        const setStyle = (r, c, s) => {
            const k = cellKey(r, c)
            const prev = styles.get(k)
            const merged = { ...(prev || {}), ...s }
            styles.set(k, merged)
            changed = true
        }

        // 1. clearFormatting
        if (action.clearFormatting) {
            for (let r = startRow; r <= endRow; r++) {
                for (let c = startCol; c <= endCol; c++) {
                    styles.delete(cellKey(r, c))
                }
            }
            changed = true
        }

        const headerRow = startRow
        const bodyStart = startRow + 1
        const bodyEnd = endRow

        // Check if last row is a totals row
        const lastRow = endRow
        const hasTotals = isTotalsRow(lastRow)

        // 2. bodyStyle (body rows, all used columns)
        if (action.bodyStyle) {
            const bodyRowEnd = hasTotals ? bodyEnd - 1 : bodyEnd
            if (bodyStart <= bodyRowEnd) {
                for (let r = bodyStart; r <= bodyRowEnd; r++) {
                    for (let c = startCol; c <= endCol; c++) {
                        const s = getStyle(r, c)
                        const merged = { ...s, ...action.bodyStyle }
                        setStyle(r, c, merged)
                    }
                }
            }
        }

        // 3. column styles (body rows only, header row never number-formatted)
        if (action.columns) {
            for (const colEntry of action.columns) {
                const absCol = colEntry.col
                if (absCol < 0 || absCol >= colCount) continue // out of range: ignore
                const physCol = startCol + absCol
                const colBodyEnd = hasTotals ? bodyEnd - 1 : bodyEnd
                if (bodyStart <= colBodyEnd) {
                    for (let r = bodyStart; r <= colBodyEnd; r++) {
                        const s = getStyle(r, physCol)
                        // Never apply numberFormat or align from column entry to header
                        setStyle(r, physCol, { ...s, ...colEntry.style })
                    }
                }
            }
        }

        // 4. totalsStyle
        if (action.totalsStyle && hasTotals) {
            for (let c = startCol; c <= endCol; c++) {
                setStyle(lastRow, c, { ...getStyle(lastRow, c), ...action.totalsStyle })
            }
        }

        // 5. headerStyle (applied last — wins over column entries)
        if (action.headerStyle) {
            for (let c = startCol; c <= endCol; c++) {
                const s = getStyle(headerRow, c)
                // Never apply numberFormat to header
                const { numberFormat: _nf, ...headerStyleSafe } = action.headerStyle
                setStyle(headerRow, c, { ...s, ...headerStyleSafe })
            }
        }

        // 6. freezeRows
        if (action.freezeRows != null) {
            if (frozenRows !== action.freezeRows) {
                frozenRows = action.freezeRows
                changed = true
            }
        }

        // 7. columnWidths
        if (action.columnWidths) {
            for (const { col, width } of action.columnWidths) {
                if (col < 0 || col >= colCount) continue
                if (width < 30 || width > 600) continue
                colWidths.set(startCol + col, width)
                changed = true
            }
        }

        // 8. autoFitColumns (approximation: set width based on max content length)
        if (action.autoFitColumns) {
            for (let c = startCol; c <= endCol; c++) {
                let maxLen = 0
                for (let r = startRow; r <= endRow; r++) {
                    const v = String(getCellRaw(r, c).raw || '')
                    if (v.length > maxLen) maxLen = v.length
                }
                const w = Math.max(60, Math.min(300, maxLen * 8 + 20))
                colWidths.set(c, w)
                changed = true
            }
        }

        return changed ? null : 'NO_CHANGES'
    }

    function undo() {
        if (undoStack.length === 0) return false
        const entry = undoStack.pop()
        if (entry.type === 'set') {
            const cur = getCellRaw(entry.r, entry.c).raw
            redoStack.push({ ...entry, newVal: cur })
            setCellRaw(entry.r, entry.c, entry.oldVal)
            _generation++
            recalculate()
        } else if (entry.type === 'bulk') {
            const curVals = entry.oldValues.map(e => ({ r: e.r, c: e.c, val: getCellRaw(e.r, e.c).raw }))
            redoStack.push({ type: 'bulk', oldValues: curVals, newValues: entry.newValues })
            for (const e of entry.oldValues) setCellRaw(e.r, e.c, e.val)
            _generation++
            recalculate()
        } else if (entry.type === 'snap') {
            const curSnap = takeSnapshot()
            redoStack.push({ type: 'snap', snap: curSnap, label: entry.label })
            restoreSnapshot(entry.snap)
            recomputeHiddenRows()
            recalculate()
        } else if (entry.type === 'filter') {
            redoStack.push(entry)
            restoreFilterState(entry.prev)
        }
        return true
    }

    function redo() {
        if (redoStack.length === 0) return false
        const entry = redoStack.pop()
        if (entry.type === 'set') {
            const cur = getCellRaw(entry.r, entry.c).raw
            undoStack.push({ ...entry, oldVal: cur })
            setCellRaw(entry.r, entry.c, entry.newVal)
            _generation++
            recalculate()
        } else if (entry.type === 'bulk') {
            const curVals = entry.newValues.map(e => ({ r: e.r, c: e.c, val: getCellRaw(e.r, e.c).raw }))
            undoStack.push({ type: 'bulk', oldValues: curVals, newValues: entry.newValues })
            for (const e of entry.newValues) setCellRaw(e.r, e.c, e.val)
            _generation++
            recalculate()
        } else if (entry.type === 'snap') {
            const curSnap = takeSnapshot()
            undoStack.push({ type: 'snap', snap: curSnap, label: entry.label })
            restoreSnapshot(entry.snap)
            recomputeHiddenRows()
            recalculate()
        } else if (entry.type === 'filter') {
            undoStack.push(entry)
            restoreFilterState(entry.next)
        }
        return true
    }

    // ── Public cell display ──

    function getCellForDisplay(row, col) {
        recalculate() // flush dirty cells before display
        const cell = getCellRaw(row, col)
        const key = cellKey(row, col)
        const value = resolveCellValue(key)
        const explicitStyle = styles.get(key) || {}
        const fmt = explicitStyle.numberFormat

        const isHeader = row === 0
        const style = {
            ...(isHeader ? { fontSize: 13 } : {}),
            align: explicitStyle.align || (typeof value === 'number' ? 'right' : 'left'),
            ...explicitStyle,
        }

        if (typeof value === 'string' && value.startsWith('#')) {
            return { raw: cell.raw, computed: null, error: value, style }
        }

        // Apply numberFormat for display
        const displayValue = fmt ? applyNumberFormat(cell.raw, value, fmt) : null

        return {
            raw: cell.raw,
            computed: value,
            error: null,
            style,
            displayValue,  // null means "use computed"
        }
    }

    // ── Public API ──
    const engine = {
        get rows() { return rows },
        get cols() { return cols },
        get frozenRows() { return frozenRows },
        get frozenCols() { return frozenCols },
        get hiddenRows() { return hiddenRows },
        get filterState() { return filterState },

        getCell: getCellForDisplay,
        getCellRaw: (r, c) => getCellRaw(r, c),
        setCell: executeSetCell,
        bulkSet: executeBulkSet,
        applyFill: executeApplyFill,

        insertRow: executeInsertRow,
        deleteRow: executeDeleteRow,
        insertColumn: executeInsertColumn,
        deleteColumn: executeDeleteColumn,

        sort: executeSort,
        setFilter: executeSetFilter,
        clearAllFilters: executeClearAllFilters,
        getDistinctColumnValues,
        recomputeHiddenRows,
        isTotalsRow,
        getUsedRange,

        applyFormat: executeApplyFormat,
        insertRows: executeInsertRows,

        undo,
        redo,
        canUndo: () => undoStack.length > 0,
        canRedo: () => redoStack.length > 0,

        getColWidth: (col) => colWidths.get(col) || 100,
        setColWidth: (col, w) => { colWidths.set(col, w) },
        getRowHeight: (row) => rowHeights.get(row) || 24,
        setRowHeight: (row, h) => { rowHeights.set(row, h) },

        getStyle: (row, col) => styles.get(cellKey(row, col)) || {},
        setStyle: (row, col, s) => {
            const key = cellKey(row, col)
            styles.set(key, { ...(styles.get(key) || {}), ...s })
        },
        clearStyle: (row, col) => { styles.delete(cellKey(row, col)) },
        bulkSetStyle: (entries) => {
            // entries: Array<{ row, col, style }>
            for (const e of entries) {
                const key = cellKey(e.row, e.col)
                styles.set(key, { ...(styles.get(key) || {}), ...e.style })
            }
        },

        setFrozenRows: (n) => { frozenRows = n },
        setFrozenCols: (n) => { frozenCols = n },

        ensureCapacity: (minRows, minCols) => {
            if (minRows > rows) {
                for (let i = rows; i < minRows; i++) rowIdentity.push(nextRowId++)
                rows = minRows
            }
            if (minCols > cols) cols = minCols
        },

        // For AI executor: read computed values in a range
        getComputedRange: (startRow, startCol, endRow, endCol) => {
            recalculate()
            const result = []
            for (let r = startRow; r <= endRow; r++) {
                const row = []
                for (let c = startCol; c <= endCol; c++) {
                    row.push(resolveCellValue(cellKey(r, c)))
                }
                result.push(row)
            }
            return result
        },
    }

    return engine
}

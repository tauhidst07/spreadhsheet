// ─────────────────────────────────────────────────────────────
//  Spreadsheet Engine Core
//  Pure JavaScript spreadsheet engine: sparse cell store,
//  formula evaluation, dependency graph with cycle detection,
//  undo/redo, range selection, fill handle, sorting, styling,
//  and structural mutations. (No React, no DOM dependencies).
// ─────────────────────────────────────────────────────────────

const OPERATOR_PRECEDENCE = { '+': 1, '-': 1, '*': 2, '/': 2 }
const MAX_UNDO_HISTORY = 100

// Default cell style
export const DEFAULT_CELL_STYLE = Object.freeze({
    bold: false,
    italic: false,
    underline: false,
    bg: 'white',
    color: '#202124',
    align: 'left',
    fontSize: 13,
    numberFormat: 'general',
})

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

export function indexToColLetter(col) {
    let label = ''
    let colNumber = col + 1
    while (colNumber > 0) {
        colNumber--
        label = String.fromCharCode(65 + (colNumber % 26)) + label
        colNumber = Math.floor(colNumber / 26)
    }
    return label
}

export function indexToCellKey(row, col) {
    return indexToColLetter(col) + (row + 1)
}

export function parseCellKey(cellKey) {
    if (!cellKey) return null
    const clean = cellKey.replace(/\$/g, '').toUpperCase()
    const match = clean.match(/^([A-Z]+)(\d+)$/)
    if (!match) return null
    return { row: parseInt(match[2], 10) - 1, col: columnLetterToIndex(match[1]) }
}

export function parseCellCoord(ref) {
    if (!ref) return null
    const match = String(ref).match(/^(\$?)([A-Za-z]+)(\$?)(\d+)$/)
    if (!match) return null
    return {
        colAbs: match[1] === '$',
        colLetter: match[2].toUpperCase(),
        col: columnLetterToIndex(match[2].toUpperCase()),
        rowAbs: match[3] === '$',
        row: parseInt(match[4], 10) - 1,
        cleanKey: match[2].toUpperCase() + match[4],
    }
}

// ─────────────────────────────────────────────────────────────
//  Data coercion & normalization
//  Shared text/number/date parsing used by sorting, filtering,
//  number formatting and the AI query executor.
// ─────────────────────────────────────────────────────────────

export function norm(v) {
    return String(v === null || v === undefined ? '' : v).trim().toLowerCase()
}

export function toNum(v) {
    if (v === null || v === undefined) return null
    let s = String(v).trim()
    if (!s) return null

    let isPercent = false
    if (s.endsWith('%')) {
        isPercent = true
        s = s.slice(0, -1).trim()
    }

    // Strip $, ,, whitespace
    s = s.replace(/[$,\s]/g, '')
    if (!/^-?\d+(\.\d+)?$/.test(s)) return null

    const num = parseFloat(s)
    if (isNaN(num)) return null
    return isPercent ? num / 100 : num
}

const MONTH_NAMES_MAP = {
    jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
    jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12'
}

export function toDate(v) {
    if (v === null || v === undefined) return null
    const s = String(v).trim()
    if (!s) return null

    // 1. YYYY-M-D or YYYY-MM-DD
    const mIso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
    if (mIso) {
        const y = mIso[1]
        const m = mIso[2].padStart(2, '0')
        const d = mIso[3].padStart(2, '0')
        return `${y}-${m}-${d}`
    }

    // 2. M/D/YYYY or MM/DD/YYYY
    const mUs = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
    if (mUs) {
        const y = mUs[3]
        const m = mUs[1].padStart(2, '0')
        const d = mUs[2].padStart(2, '0')
        return `${y}-${m}-${d}`
    }

    // 3. D Mon YYYY (e.g. "15 Jan 2024", "15 January 2024")
    const mText = s.match(/^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})$/)
    if (mText) {
        const d = mText[1].padStart(2, '0')
        const monKey = mText[2].slice(0, 3).toLowerCase()
        const m = MONTH_NAMES_MAP[monKey]
        if (m) {
            const y = mText[3]
            return `${y}-${m}-${d}`
        }
    }

    return null
}

export function formatDisplayValue(val, format) {
    if (val === null || val === undefined || val === '') return ''
    if (!format || format === 'general') return String(val)

    if (format === 'date') {
        const iso = toDate(val)
        return iso !== null ? iso : String(val)
    }

    const num = toNum(val)
    if (num === null) {
        // Non-numeric text is left alone
        return String(val)
    }

    if (format === 'number') {
        return num.toLocaleString('en-US', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
        })
    }

    if (format === 'currency') {
        const formatted = Math.abs(num).toLocaleString('en-US', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
        })
        return num < 0 ? `-$${formatted}` : `$${formatted}`
    }

    if (format === 'percent') {
        const pct = num * 100
        const rounded = Math.round(pct * 100) / 100
        const formatted = Number.isInteger(rounded)
            ? String(Math.round(pct))
            : rounded.toLocaleString('en-US', { maximumFractionDigits: 2 })
        return `${formatted}%`
    }

    return String(val)
}

// ─────────────────────────────────────────────────────────────
//  Dependency graph (tracks which cells depend on which)
// ─────────────────────────────────────────────────────────────

function createDependencyGraph() {
    const forwardEdges = new Map()
    const reverseEdges = new Map()

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
                if (reverseEdges.has(dep)) {
                    reverseEdges.get(dep).delete(cell)
                    if (reverseEdges.get(dep).size === 0) reverseEdges.delete(dep)
                }
            }
            forwardEdges.delete(cell)
        }
        const dependents = reverseEdges.get(cell)
        if (dependents) {
            for (const dependent of dependents) {
                if (forwardEdges.has(dependent)) {
                    forwardEdges.get(dependent).delete(cell)
                    if (forwardEdges.get(dependent).size === 0) forwardEdges.delete(dependent)
                }
            }
            reverseEdges.delete(cell)
        }
    }

    function getDependencies(cell) {
        return forwardEdges.get(cell) || new Set()
    }

    function getDependents(cell) {
        return reverseEdges.get(cell) || new Set()
    }

    function getAllDependentsRecursive(cell, visited = new Set()) {
        if (visited.has(cell)) return new Set()
        visited.add(cell)
        const result = new Set()
        for (const dependent of getDependents(cell)) {
            result.add(dependent)
            for (const indirect of getAllDependentsRecursive(dependent, visited)) {
                result.add(indirect)
            }
        }
        return result
    }

    function hasCycle(startCell) {
        const visited = new Set()
        const recursionStack = new Set()
        const dfs = (node) => {
            if (recursionStack.has(node)) return true
            if (visited.has(node)) return false
            visited.add(node)
            recursionStack.add(node)
            for (const dep of getDependencies(node)) {
                if (dfs(dep)) return true
            }
            recursionStack.delete(node)
            return false
        }
        return dfs(startCell)
    }

    function topologicalSort(affectedCells) {
        if (!affectedCells || affectedCells.size === 0) return []
        if (forwardEdges.size === 0 && reverseEdges.size === 0) return []

        const inDegree = new Map()
        const queue = []
        const sorted = []

        for (const cell of affectedCells) inDegree.set(cell, 0)
        for (const cell of affectedCells) {
            for (const dep of getDependencies(cell)) {
                if (affectedCells.has(dep)) {
                    inDegree.set(cell, (inDegree.get(cell) || 0) + 1)
                }
            }
        }
        for (const cell of affectedCells) {
            if (inDegree.get(cell) === 0) queue.push(cell)
        }
        let qHead = 0
        while (qHead < queue.length) {
            const cell = queue[qHead++]
            sorted.push(cell)
            for (const dependent of getDependents(cell)) {
                if (affectedCells.has(dependent)) {
                    inDegree.set(dependent, inDegree.get(dependent) - 1)
                    if (inDegree.get(dependent) === 0) queue.push(dependent)
                }
            }
        }
        return sorted
    }

    function clear() {
        forwardEdges.clear()
        reverseEdges.clear()
    }

    return {
        addDependency,
        removeAllDependencies,
        getDependencies,
        getDependents,
        getAllDependentsRecursive,
        hasCycle,
        topologicalSort,
        clear,
        hasEdges: () => forwardEdges.size > 0 || reverseEdges.size > 0
    }
}

// ─────────────────────────────────────────────────────────────
//  Tokenizer — converts formula string into tokens
// ─────────────────────────────────────────────────────────────

function tokenize(expression) {
    const tokens = []
    let position = 0

    while (position < expression.length) {
        const char = expression[position]

        if (char === ' ') {
            position++
            continue
        }

        if (char === '(' || char === ')') {
            tokens.push({ type: 'paren', value: char })
            position++
            continue
        }

        if ('+-*/,'.includes(char)) {
            tokens.push({ type: 'operator', value: char })
            position++
            continue
        }

        if ((char >= '0' && char <= '9') || char === '.') {
            let numberStr = ''
            while (position < expression.length && ((expression[position] >= '0' && expression[position] <= '9') || expression[position] === '.')) {
                numberStr += expression[position]
                position++
            }
            tokens.push({ type: 'number', value: parseFloat(numberStr) })
            continue
        }

        if (char === '$' || (char >= 'A' && char <= 'Z') || (char >= 'a' && char <= 'z')) {
            let identifier = ''
            while (position < expression.length && (
                expression[position] === '$' ||
                (expression[position] >= 'A' && expression[position] <= 'Z') ||
                (expression[position] >= 'a' && expression[position] <= 'z') ||
                (expression[position] >= '0' && expression[position] <= '9')
            )) {
                identifier += expression[position].toUpperCase()
                position++
            }

            const cellMatch = identifier.match(/^\$?([A-Z]+)\$?(\d+)$/)
            if (cellMatch) {
                // Check if followed by ':' and another cell reference (a range!)
                let look = position
                while (look < expression.length && expression[look] === ' ') look++
                if (look < expression.length && expression[look] === ':') {
                    let look2 = look + 1
                    while (look2 < expression.length && expression[look2] === ' ') look2++
                    let endIdentifier = ''
                    let p = look2
                    while (p < expression.length && (
                        expression[p] === '$' ||
                        (expression[p] >= 'A' && expression[p] <= 'Z') ||
                        (expression[p] >= 'a' && expression[p] <= 'z') ||
                        (expression[p] >= '0' && expression[p] <= '9')
                    )) {
                        endIdentifier += expression[p].toUpperCase()
                        p++
                    }
                    const endCellMatch = endIdentifier.match(/^\$?([A-Z]+)\$?(\d+)$/)
                    if (endCellMatch) {
                        tokens.push({ type: 'range', start: identifier, end: endIdentifier })
                        position = p
                        continue
                    }
                }
                tokens.push({ type: 'cell', value: identifier })
            } else {
                tokens.push({ type: 'function', value: identifier })
            }
            continue
        }

        if (char === ':') {
            tokens.push({ type: 'operator', value: ':' })
            position++
            continue
        }

        throw new Error(`Unexpected character: ${char}`)
    }

    return tokens
}

// ─────────────────────────────────────────────────────────────
//  Parser — converts tokens into an AST using shunting-yard
// ─────────────────────────────────────────────────────────────

function parseTokensToAST(tokens) {
    const outputQueue = []
    const operatorStack = []
    let position = 0

    while (position < tokens.length) {
        const token = tokens[position]

        if (token.type === 'number' || token.type === 'cell' || token.type === 'range') {
            outputQueue.push(token)
            position++
        } else if (token.type === 'function') {
            operatorStack.push(token)
            position++
        } else if (token.type === 'operator') {
            while (
                operatorStack.length > 0 &&
                operatorStack[operatorStack.length - 1].type === 'operator' &&
                OPERATOR_PRECEDENCE[operatorStack[operatorStack.length - 1].value] >= OPERATOR_PRECEDENCE[token.value]
            ) {
                outputQueue.push(operatorStack.pop())
            }
            operatorStack.push(token)
            position++
        } else if (token.type === 'paren' && token.value === '(') {
            operatorStack.push(token)
            position++
        } else if (token.type === 'paren' && token.value === ')') {
            while (operatorStack.length > 0 && operatorStack[operatorStack.length - 1].value !== '(') {
                outputQueue.push(operatorStack.pop())
            }
            if (operatorStack.length > 0 && operatorStack[operatorStack.length - 1].value === '(') {
                operatorStack.pop()
            }
            if (operatorStack.length > 0 && operatorStack[operatorStack.length - 1].type === 'function') {
                const funcToken = operatorStack.pop()
                if (outputQueue.length > 0 && outputQueue[outputQueue.length - 1].type === 'range') {
                    const rangeToken = outputQueue.pop()
                    outputQueue.push({ type: 'function', name: funcToken.value, range: rangeToken })
                } else {
                    outputQueue.push(funcToken)
                }
            }
            position++
        } else {
            position++
        }
    }

    while (operatorStack.length > 0) {
        if (operatorStack[operatorStack.length - 1].value === '(') {
            throw new Error('Mismatched parentheses')
        }
        outputQueue.push(operatorStack.pop())
    }

    return buildASTFromRPN(outputQueue)
}

function buildASTFromRPN(rpnTokens) {
    const stack = []

    for (const token of rpnTokens) {
        if (token.type === 'number' || token.type === 'cell' || token.type === 'range') {
            stack.push(token)
        } else if (token.type === 'operator') {
            if (stack.length < 2) throw new Error('Invalid expression')
            const right = stack.pop()
            const left = stack.pop()
            stack.push({ type: 'binary', operator: token.value, left, right })
        } else if (token.type === 'function') {
            if (token.range) {
                stack.push(token)
            } else {
                if (stack.length === 0) throw new Error(`Function ${token.value} requires arguments`)
                const argument = stack.pop()
                if (argument.type === 'range') {
                    stack.push({ type: 'function', name: token.value, range: argument })
                } else {
                    throw new Error(`Function ${token.value} requires a range`)
                }
            }
        }
    }

    if (stack.length !== 1) throw new Error('Invalid expression')
    return stack[0]
}

// ─────────────────────────────────────────────────────────────
//  Evaluator — walks the AST and computes values
// ─────────────────────────────────────────────────────────────

export function expandCellRange(startKey, endKey) {
    const startClean = String(startKey).replace(/\$/g, '').toUpperCase()
    const endClean = String(endKey).replace(/\$/g, '').toUpperCase()
    const startMatch = startClean.match(/^([A-Z]+)(\d+)$/)
    const endMatch = endClean.match(/^([A-Z]+)(\d+)$/)
    if (!startMatch || !endMatch) throw new Error('REF')

    const startCol = columnLetterToIndex(startMatch[1])
    const startRow = parseInt(startMatch[2], 10) - 1
    const endCol = columnLetterToIndex(endMatch[1])
    const endRow = parseInt(endMatch[2], 10) - 1

    const cells = []
    for (let r = Math.min(startRow, endRow); r <= Math.max(startRow, endRow); r++) {
        for (let c = Math.min(startCol, endCol); c <= Math.max(startCol, endCol); c++) {
            cells.push(indexToCellKey(r, c))
        }
    }
    return cells
}

function evaluateAST(ast, getCellValue, visited = new Set()) {
    if (!ast) return 0

    if (ast.type === 'number') return ast.value

    if (ast.type === 'cell') {
        const key = ast.value.replace(/\$/g, '').toUpperCase()
        if (visited.has(key)) throw new Error('CIRCULAR')
        visited.add(key)
        const value = getCellValue(key, visited)
        visited.delete(key)
        return value
    }

    if (ast.type === 'range') throw new Error('VALUE')

    if (ast.type === 'binary') {
        let leftVal = evaluateAST(ast.left, getCellValue, visited)
        let rightVal = evaluateAST(ast.right, getCellValue, visited)

        // Blank/empty cells coerce to 0 in arithmetic (standard spreadsheet semantics)
        if (leftVal === '' || leftVal === null || leftVal === undefined) leftVal = 0
        if (rightVal === '' || rightVal === null || rightVal === undefined) rightVal = 0

        const leftNum = typeof leftVal === 'number' ? leftVal : toNum(leftVal)
        const rightNum = typeof rightVal === 'number' ? rightVal : toNum(rightVal)

        if (leftNum === null || rightNum === null || isNaN(leftNum) || isNaN(rightNum)) throw new Error('VALUE')

        switch (ast.operator) {
            case '+': return leftNum + rightNum
            case '-': return leftNum - rightNum
            case '*': return leftNum * rightNum
            case '/':
                if (rightNum === 0) throw new Error('VALUE')
                return leftNum / rightNum
            default: throw new Error('VALUE')
        }
    }

    if (ast.type === 'function') {
        const rangeCells = expandCellRange(ast.range.start, ast.range.end)
        const values = rangeCells.map(cellKey => {
            if (visited.has(cellKey)) throw new Error('CIRCULAR')
            visited.add(cellKey)
            const value = getCellValue(cellKey, visited)
            visited.delete(cellKey)
            const num = typeof value === 'number' ? value : toNum(value)
            return num === null || isNaN(num) ? 0 : num
        })

        switch (ast.name) {
            case 'SUM': return values.reduce((sum, val) => sum + val, 0)
            case 'AVG': return values.length === 0 ? 0 : values.reduce((sum, val) => sum + val, 0) / values.length
            case 'MIN': return values.length === 0 ? 0 : Math.min(...values)
            case 'MAX': return values.length === 0 ? 0 : Math.max(...values)
            default: throw new Error('VALUE')
        }
    }

    throw new Error('VALUE')
}

function evaluateFormula(expression, getCellValue) {
    try {
        if (!expression || expression.trim() === '') return { value: '', error: null }
        if (!expression.startsWith('=')) return { value: expression, error: null }

        const formulaBody = expression.slice(1).trim()
        if (formulaBody === '') return { value: '', error: null }

        const tokens = tokenize(formulaBody)
        const ast = parseTokensToAST(tokens)
        const result = evaluateAST(ast, getCellValue)
        return { value: result, error: null }
    } catch (error) {
        if (error.message === 'CIRCULAR') return { value: null, error: '#CYCLE!' }
        if (error.message === 'REF') return { value: null, error: '#REF!' }
        if (error.message === 'VALUE') return { value: null, error: '#VALUE!' }
        return { value: null, error: '#PARSE!' }
    }
}

// ─────────────────────────────────────────────────────────────
//  Reference shifting
// ─────────────────────────────────────────────────────────────

export function shiftCellReferences(formula, rowShift, colShift, atIndex, isColumnOperation = false) {
    if (!formula || !formula.startsWith('=')) return formula

    return formula.replace(/(\$?)([A-Za-z]+)(\$?)(\d+)/gi, (match, colDollar, colLetter, rowDollar, rowStr) => {
        const colIdx = columnLetterToIndex(colLetter.toUpperCase())
        const rowIdx = parseInt(rowStr, 10) - 1
        let newRow = rowIdx
        let newCol = colIdx

        if (isColumnOperation) {
            if (colShift < 0) {
                if (colIdx === atIndex) return '#REF!'
                if (colIdx > atIndex) newCol = colIdx + colShift
            } else if (colShift > 0) {
                if (colIdx >= atIndex) newCol = colIdx + colShift
            }
        } else {
            if (rowShift < 0) {
                if (rowIdx === atIndex) return '#REF!'
                if (rowIdx > atIndex) newRow = rowIdx + rowShift
            } else if (rowShift > 0) {
                if (rowIdx >= atIndex) newRow = rowIdx + rowShift
            }
        }

        if (newRow < 0 || newCol < 0) return '#REF!'
        return `${colDollar}${indexToColLetter(newCol)}${rowDollar}${newRow + 1}`
    })
}

export function shiftFormulaForFill(formula, deltaRow, deltaCol) {
    if (!formula || !formula.startsWith('=')) return formula

    return formula.replace(/(\$?)([A-Za-z]+)(\$?)(\d+)/gi, (match, colDollar, colLetter, rowDollar, rowStr) => {
        const colIdx = columnLetterToIndex(colLetter.toUpperCase())
        const rowIdx = parseInt(rowStr, 10) - 1

        const newCol = colDollar === '$' ? colIdx : colIdx + deltaCol
        const newRow = rowDollar === '$' ? rowIdx : rowIdx + deltaRow

        if (newRow < 0 || newCol < 0) return '#REF!'
        return `${colDollar}${indexToColLetter(newCol)}${rowDollar}${newRow + 1}`
    })
}

export function extractCellReferences(formula) {
    const references = new Set()
    if (!formula) return references

    // Ranges
    const rangeRegex = /(\$?)([A-Za-z]+)(\$?)(\d+)\s*:\s*(\$?)([A-Za-z]+)(\$?)(\d+)/gi
    let match
    while ((match = rangeRegex.exec(formula)) !== null) {
        try {
            const startKey = match[2] + match[4]
            const endKey = match[6] + match[8]
            for (const key of expandCellRange(startKey, endKey)) {
                references.add(key)
            }
        } catch {
            // ignore malformed
        }
    }

    // Individual cells
    const cellRegex = /\$?([A-Za-z]+)\$?(\d+)/gi
    while ((match = cellRegex.exec(formula)) !== null) {
        const key = match[1].toUpperCase() + match[2]
        references.add(key)
    }

    return references
}

// ─────────────────────────────────────────────────────────────
//  Fill pattern generator
//  Extrapolates a seed sequence into numbers, dates, weekday/month
//  names, numbered text tokens, or shifted formulas.
// ─────────────────────────────────────────────────────────────

const WEEKDAYS_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const WEEKDAYS_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

function detectCase(str) {
    if (str === str.toUpperCase()) return 'upper'
    if (str === str.toLowerCase()) return 'lower'
    return 'title'
}

function applyCase(str, c) {
    if (c === 'upper') return str.toUpperCase()
    if (c === 'lower') return str.toLowerCase()
    return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase()
}

function detectDateFormat(str) {
    if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(str)) return 'iso'
    if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(str)) return 'us'
    if (/^\d{1,2}\s+[A-Za-z]{3,}\s+\d{4}$/.test(str)) return 'text'
    return null
}

function parseDateToUtcMs(str) {
    const iso = toDate(str)
    if (!iso) return null
    const [y, m, d] = iso.split('-').map(Number)
    return Date.UTC(y, m - 1, d)
}

function formatDateFromUtcMs(ms, format) {
    const d = new Date(ms)
    const y = d.getUTCFullYear()
    const m = d.getUTCMonth() + 1
    const day = d.getUTCDate()

    if (format === 'us') {
        return `${m}/${day}/${y}`
    }
    if (format === 'text') {
        const monNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
        return `${day} ${monNames[m - 1]} ${y}`
    }
    // iso default
    return `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

export function generateFillSeries(seedValues, count, deltaRow, deltaCol) {
    // seedValues: array of raw strings
    if (seedValues.length === 0 || count <= 0) return []

    // Check if formulas
    if (seedValues.every(s => typeof s === 'string' && s.startsWith('='))) {
        return Array.from({ length: count }, (_, i) => {
            const seedIdx = i % seedValues.length
            const cycle = Math.floor(i / seedValues.length) + 1
            const rShift = deltaRow !== 0 ? (deltaRow > 0 ? cycle * seedValues.length : -cycle * seedValues.length) : 0
            const cShift = deltaCol !== 0 ? (deltaCol > 0 ? cycle * seedValues.length : -cycle * seedValues.length) : 0
            return shiftFormulaForFill(seedValues[seedIdx], rShift, cShift)
        })
    }

    // Check if dates
    const dateFormats = seedValues.map(detectDateFormat)
    if (dateFormats.every(f => f !== null)) {
        const dateTimes = seedValues.map(parseDateToUtcMs)
        let stepDays = 1
        if (dateTimes.length > 1) {
            const spanDays = (dateTimes[dateTimes.length - 1] - dateTimes[0]) / (86400000)
            stepDays = Math.round(spanDays / (dateTimes.length - 1))
            if (stepDays === 0) stepDays = 1
        }
        const lastTime = dateTimes[dateTimes.length - 1]
        return Array.from({ length: count }, (_, i) => {
            const targetMs = lastTime + (i + 1) * stepDays * 86400000
            const format = dateFormats[i % dateFormats.length]
            return formatDateFromUtcMs(targetMs, format)
        })
    }

    // Check if weekdays
    const weekdayIdxs = seedValues.map(s => {
        const lower = s.trim().toLowerCase()
        let idx = WEEKDAYS_SHORT.findIndex(w => w.toLowerCase() === lower)
        if (idx !== -1) return { idx, long: false, case: detectCase(s.trim()) }
        idx = WEEKDAYS_LONG.findIndex(w => w.toLowerCase() === lower)
        if (idx !== -1) return { idx, long: true, case: detectCase(s.trim()) }
        return null
    })
    if (weekdayIdxs.every(w => w !== null)) {
        let step = 1
        if (weekdayIdxs.length > 1) {
            step = (weekdayIdxs[weekdayIdxs.length - 1].idx - weekdayIdxs[0].idx) / (weekdayIdxs.length - 1)
        }
        const lastW = weekdayIdxs[weekdayIdxs.length - 1]
        return Array.from({ length: count }, (_, i) => {
            const nextIdx = ((lastW.idx + Math.round((i + 1) * step)) % 7 + 7) % 7
            const list = lastW.long ? WEEKDAYS_LONG : WEEKDAYS_SHORT
            return applyCase(list[nextIdx], lastW.case)
        })
    }

    // Check if months
    const monthIdxs = seedValues.map(s => {
        const lower = s.trim().toLowerCase()
        let idx = MONTHS_SHORT.findIndex(m => m.toLowerCase() === lower)
        if (idx !== -1) return { idx, long: false, case: detectCase(s.trim()) }
        idx = MONTHS_LONG.findIndex(m => m.toLowerCase() === lower)
        if (idx !== -1) return { idx, long: true, case: detectCase(s.trim()) }
        return null
    })
    if (monthIdxs.every(m => m !== null)) {
        let step = 1
        if (monthIdxs.length > 1) {
            step = (monthIdxs[monthIdxs.length - 1].idx - monthIdxs[0].idx) / (monthIdxs.length - 1)
        }
        const lastM = monthIdxs[monthIdxs.length - 1]
        return Array.from({ length: count }, (_, i) => {
            const nextIdx = ((lastM.idx + Math.round((i + 1) * step)) % 12 + 12) % 12
            const list = lastM.long ? MONTHS_LONG : MONTHS_SHORT
            return applyCase(list[nextIdx], lastM.case)
        })
    }

    // Check text ending in numbers (e.g. "ORD-1001", "Item 1", "Q4", "2024-W01")
    const numEndMatches = seedValues.map(s => String(s).match(/^(.*?)(\d+)$/))
    if (numEndMatches.every(m => m !== null)) {
        const prefix = numEndMatches[0][1]
        const samePrefix = numEndMatches.every(m => m[1] === prefix)
        if (samePrefix) {
            const nums = numEndMatches.map(m => parseInt(m[2], 10))
            const digits = numEndMatches[0][2].length
            let step = 1
            if (nums.length > 1) {
                step = (nums[nums.length - 1] - nums[0]) / (nums.length - 1)
            }
            const lastNum = nums[nums.length - 1]
            return Array.from({ length: count }, (_, i) => {
                const nextVal = Math.round(lastNum + (i + 1) * step)
                return prefix + String(nextVal).padStart(digits, '0')
            })
        }
    }

    // Check numeric seeds
    const numValues = seedValues.map(s => {
        const n = parseFloat(s)
        return (!isNaN(n) && String(n) === String(s).trim()) ? n : null
    })
    if (numValues.every(n => n !== null)) {
        if (numValues.length === 1) {
            // Single numeric seed: copy
            return Array.from({ length: count }, () => seedValues[0])
        }
        const step = (numValues[numValues.length - 1] - numValues[0]) / (numValues.length - 1)
        const lastNum = numValues[numValues.length - 1]
        return Array.from({ length: count }, (_, i) => {
            const nextVal = lastNum + (i + 1) * step
            return String(Number.isInteger(nextVal) ? nextVal : Math.round(nextVal * 10000) / 10000)
        })
    }

    // Default: copy seed cycle
    return Array.from({ length: count }, (_, i) => seedValues[i % seedValues.length])
}

// ─────────────────────────────────────────────────────────────
//  Main Engine Factory
// ─────────────────────────────────────────────────────────────

export function createEngine(initialRows = 50, initialCols = 50) {
    let rows = initialRows
    let cols = initialCols

    // Cells store: key -> { raw: string, style: object }
    const cells = new Map()
    const graph = createDependencyGraph()
    const dirtyCells = new Set()
    const computedCache = new Map()
    const undoStack = []
    const redoStack = []

    // Stable row identities for sorting reset
    let rowIdentities = Array.from({ length: rows }, (_, i) => i)
    let nextRowId = rows

    // Custom dimensions and freezing
    const customRowHeights = new Map()
    const customColWidths = new Map()
    let frozenRowsCount = 0
    let frozenColsCount = 0

    let _generation = 0

    // ── Internal helpers ──

    function cellKey(row, col) {
        return indexToCellKey(row, col)
    }

    function cellCoords(key) {
        return parseCellKey(key)
    }

    function isValidCellKey(key) {
        const coords = cellCoords(key)
        return coords && coords.row >= 0 && coords.row < rows && coords.col >= 0 && coords.col < cols
    }

    function updateDependencies(cell, rawFormula) {
        for (const ref of extractCellReferences(rawFormula)) {
            if (isValidCellKey(ref)) graph.addDependency(cell, ref)
        }
    }

    function markCellDirty(cell) {
        dirtyCells.add(cell)
        for (const dependent of graph.getAllDependentsRecursive(cell)) {
            dirtyCells.add(dependent)
        }
    }

    function markAllCellsDirty() {
        for (const key of cells.keys()) dirtyCells.add(key)
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
        if (!cell || !cell.raw) {
            visited.delete(key)
            return ''
        }

        if (!cell.raw.startsWith('=')) {
            const numericValue = parseFloat(cell.raw)
            visited.delete(key)
            return (isNaN(numericValue) || String(numericValue) !== cell.raw.trim()) ? cell.raw : numericValue
        }

        const result = evaluateFormula(cell.raw, (k) => resolveCellValue(k, visited))
        visited.delete(key)

        if (result.error) {
            computedCache.set(key, { computed: null, error: result.error, _gen: _generation })
            return result.error
        }

        computedCache.set(key, { computed: result.value, error: null, _gen: _generation })
        return result.value
    }

    // ── Recalculation ──

    function recalculate() {
        if (dirtyCells.size === 0) return

        if (!graph.hasEdges()) {
            for (const cell of dirtyCells) {
                computedCache.delete(cell)
            }
            dirtyCells.clear()
            return
        }

        const affected = new Set(dirtyCells)
        const sorted = graph.topologicalSort(affected)
        const sortedSet = new Set(sorted)

        for (const cell of sorted) {
            if (dirtyCells.has(cell)) {
                computedCache.delete(cell)
                resolveCellValue(cell)
            }
        }
        for (const cell of affected) {
            if (!sortedSet.has(cell)) {
                computedCache.delete(cell)
                resolveCellValue(cell)
            }
        }

        dirtyCells.clear()
    }

    // ── Internal raw cell setters ──

    function setCellRaw(row, col, raw, style = null) {
        const key = cellKey(row, col)
        graph.removeAllDependencies(key)
        computedCache.delete(key)

        const existing = cells.get(key)
        const currentStyle = style ?? (existing ? existing.style : null)

        if ((!raw || raw.trim() === '') && !currentStyle) {
            cells.delete(key)
            markCellDirty(key)
            return
        }

        if (raw && raw.startsWith('=')) {
            cells.set(key, { raw, style: currentStyle })
            updateDependencies(key, raw)
            if (graph.hasCycle(key)) {
                graph.removeAllDependencies(key)
                cells.set(key, { raw, style: currentStyle, computed: null, error: '#CYCLE!' })
                markCellDirty(key)
                return
            }
        } else {
            cells.set(key, { raw: raw ?? '', style: currentStyle })
        }

        markCellDirty(key)
    }

    function setCellStyleRaw(row, col, styleUpdates) {
        const key = cellKey(row, col)
        const existing = cells.get(key)
        const prevStyle = existing?.style || {}
        const mergedStyle = { ...prevStyle, ...styleUpdates }
        // Clean out undefined or null values
        for (const k of Object.keys(mergedStyle)) {
            if (mergedStyle[k] === undefined || mergedStyle[k] === null) delete mergedStyle[k]
        }
        const raw = existing?.raw || ''
        if (!raw && Object.keys(mergedStyle).length === 0) {
            cells.delete(key)
        } else {
            cells.set(key, { raw, style: Object.keys(mergedStyle).length > 0 ? mergedStyle : null })
        }
    }

    // ── Snapshots ──

    function takeSnapshot() {
        const snapshot = new Map()
        for (const [key, value] of cells.entries()) {
            snapshot.set(key, { raw: value.raw, style: value.style ? { ...value.style } : null })
        }
        return snapshot
    }

    function restoreSnapshot(snapshot) {
        cells.clear()
        for (const [key, value] of snapshot.entries()) {
            cells.set(key, { raw: value.raw, style: value.style ? { ...value.style } : null })
        }
        graph.clear()
        computedCache.clear()
        dirtyCells.clear()
        _generation++
        for (const [key, value] of cells.entries()) {
            if (value.raw && value.raw.startsWith('=')) updateDependencies(key, value.raw)
        }
        markAllCellsDirty()
    }

    // ── Undo / Redo ──

    function pushToUndoStack(entry) {
        undoStack.push({ ...entry, _gen: _generation })
        if (undoStack.length > MAX_UNDO_HISTORY) undoStack.shift()
        redoStack.length = 0
    }

    // ── Public cell display ──

    function getCellForDisplay(row, col) {
        const key = cellKey(row, col)
        const cell = cells.get(key)
        const raw = cell?.raw || ''
        const style = cell?.style || null

        const computed = resolveCellValue(key)
        const isError = typeof computed === 'string' && computed.startsWith('#')
        const error = isError ? computed : null
        const valForFormat = isError ? null : (computed !== null && computed !== '' ? computed : raw)
        const formatted = isError ? error : formatDisplayValue(valForFormat, style?.numberFormat)

        return {
            raw,
            computed: isError ? null : computed,
            error,
            style: { ...DEFAULT_CELL_STYLE, ...(style || {}) },
            formatted: formatted || raw,
        }
    }

    // ── Single cell edit ──

    function executeSetCell(row, col, value) {
        const key = cellKey(row, col)
        const existing = cells.get(key)
        const oldRaw = existing?.raw || ''
        const oldStyle = existing?.style ? { ...existing.style } : null

        if (oldRaw === value) return

        pushToUndoStack({
            type: 'set',
            r: row,
            c: col,
            oldRaw,
            oldStyle,
            newRaw: value,
            newStyle: oldStyle,
        })

        setCellRaw(row, col, value, oldStyle)
        _generation++
        recalculate()
    }

    function executeSetCellStyle(row, col, styleUpdates) {
        const key = cellKey(row, col)
        const existing = cells.get(key)
        const oldStyle = existing?.style ? { ...existing.style } : null
        const merged = { ...oldStyle, ...styleUpdates }

        pushToUndoStack({
            type: 'set_style',
            r: row,
            c: col,
            oldStyle,
            newStyle: merged,
        })

        setCellStyleRaw(row, col, styleUpdates)
        _generation++
        recalculate()
    }

    // ── Bulk range operations (used by fill, clear, paste and AI insert) ──

    function executeSetRange(cellUpdates, undoLabel = 'Bulk Edit') {
        // cellUpdates: array of { r, c, raw?, style? }
        if (!cellUpdates || cellUpdates.length === 0) return

        const oldCells = []
        for (const u of cellUpdates) {
            const key = cellKey(u.r, u.c)
            const existing = cells.get(key)
            oldCells.push({
                r: u.r,
                c: u.c,
                oldRaw: existing?.raw || '',
                oldStyle: existing?.style ? { ...existing.style } : null,
                newRaw: u.raw !== undefined ? u.raw : (existing?.raw || ''),
                newStyle: u.style !== undefined ? u.style : (existing?.style ? { ...existing.style } : null),
            })
        }

        pushToUndoStack({
            type: 'bulk_cells',
            label: undoLabel,
            cells: oldCells,
        })

        for (const u of oldCells) {
            setCellRaw(u.r, u.c, u.newRaw, u.newStyle)
        }

        _generation++
        recalculate()
    }

    function executeClearRange(r1, c1, r2, c2) {
        const startRow = Math.min(r1, r2)
        const endRow = Math.max(r1, r2)
        const startCol = Math.min(c1, c2)
        const endCol = Math.max(c1, c2)

        const oldCells = []
        for (let r = startRow; r <= endRow; r++) {
            for (let c = startCol; c <= endCol; c++) {
                const key = cellKey(r, c)
                const existing = cells.get(key)
                if (existing) {
                    oldCells.push({
                        r,
                        c,
                        oldRaw: existing.raw,
                        oldStyle: existing.style ? { ...existing.style } : null,
                        newRaw: '',
                        newStyle: null,
                    })
                }
            }
        }

        if (oldCells.length === 0) return

        pushToUndoStack({
            type: 'bulk_cells',
            label: 'Clear Range',
            cells: oldCells,
        })

        for (const u of oldCells) {
            setCellRaw(u.r, u.c, '', null)
        }

        _generation++
        recalculate()
    }

    function ensureCapacity(minRows, minCols) {
        if (minRows > rows) {
            for (let i = rows; i < minRows; i++) rowIdentities.push(nextRowId++)
            rows = minRows
        }
        if (minCols > cols) cols = minCols
    }

    // ── Fill handle execution ──

    function executeApplyFill({ seedStartRow, seedStartCol, seedEndRow, seedEndCol, targetStartRow, targetStartCol, targetEndRow, targetEndCol }) {
        const sMinR = Math.min(seedStartRow, seedEndRow)
        const sMaxR = Math.max(seedStartRow, seedEndRow)
        const sMinC = Math.min(seedStartCol, seedEndCol)
        const sMaxC = Math.max(seedStartCol, seedEndCol)

        const tMinR = Math.min(targetStartRow, targetEndRow)
        const tMaxR = Math.max(targetStartRow, targetEndRow)
        const tMinC = Math.min(targetStartCol, targetEndCol)
        const tMaxC = Math.max(targetStartCol, targetEndCol)

        // Ensure bounds
        ensureCapacity(tMaxR + 1, tMaxC + 1)

        const updates = []

        // Vertical fill (expanding downwards or upwards)
        if (tMinC === sMinC && tMaxC === sMaxC) {
            const isDown = tMaxR > sMaxR
            const isUp = tMinR < sMinR

            for (let c = sMinC; c <= sMaxC; c++) {
                const seedRaws = []
                const seedStyles = []
                for (let r = sMinR; r <= sMaxR; r++) {
                    const cell = getCellForDisplay(r, c)
                    seedRaws.push(cell.raw)
                    seedStyles.push(cell.style)
                }

                if (isDown) {
                    const count = tMaxR - sMaxR
                    const series = generateFillSeries(seedRaws, count, 1, 0)
                    for (let i = 0; i < count; i++) {
                        const targetR = sMaxR + 1 + i
                        updates.push({
                            r: targetR,
                            c,
                            raw: series[i],
                            style: seedStyles[i % seedStyles.length],
                        })
                    }
                } else if (isUp) {
                    const count = sMinR - tMinR
                    const series = generateFillSeries([...seedRaws].reverse(), count, -1, 0)
                    for (let i = 0; i < count; i++) {
                        const targetR = sMinR - 1 - i
                        updates.push({
                            r: targetR,
                            c,
                            raw: series[i],
                            style: seedStyles[i % seedStyles.length],
                        })
                    }
                }
            }
        }
        // Horizontal fill (expanding rightwards or leftwards)
        else if (tMinR === sMinR && tMaxR === sMaxR) {
            const isRight = tMaxC > sMaxC
            const isLeft = tMinC < sMinC

            for (let r = sMinR; r <= sMaxR; r++) {
                const seedRaws = []
                const seedStyles = []
                for (let c = sMinC; c <= sMaxC; c++) {
                    const cell = getCellForDisplay(r, c)
                    seedRaws.push(cell.raw)
                    seedStyles.push(cell.style)
                }

                if (isRight) {
                    const count = tMaxC - sMaxC
                    const series = generateFillSeries(seedRaws, count, 0, 1)
                    for (let i = 0; i < count; i++) {
                        const targetC = sMaxC + 1 + i
                        updates.push({
                            r,
                            c: targetC,
                            raw: series[i],
                            style: seedStyles[i % seedStyles.length],
                        })
                    }
                } else if (isLeft) {
                    const count = sMinC - tMinC
                    const series = generateFillSeries([...seedRaws].reverse(), count, 0, -1)
                    for (let i = 0; i < count; i++) {
                        const targetC = sMinC - 1 - i
                        updates.push({
                            r,
                            c: targetC,
                            raw: series[i],
                            style: seedStyles[i % seedStyles.length],
                        })
                    }
                }
            }
        }

        if (updates.length === 0) return
        executeSetRange(updates, 'Fill')
    }

    // ── Used range & totals-row detection ──

    function getUsedRange() {
        let minR = Infinity, maxR = -1, minC = Infinity, maxC = -1
        for (const [key, cell] of cells.entries()) {
            if (cell.raw && cell.raw.trim() !== '') {
                const coords = cellCoords(key)
                if (coords) {
                    if (coords.row < minR) minR = coords.row
                    if (coords.row > maxR) maxR = coords.row
                    if (coords.col < minC) minC = coords.col
                    if (coords.col > maxC) maxC = coords.col
                }
            }
        }

        if (maxR === -1) {
            return { minRow: 0, maxRow: 0, minCol: 0, maxCol: 0, rowCount: 0, colCount: 0, hasTotalsRow: false }
        }

        // Check if last used row is a totals row
        let hasTotalsRow = false
        for (let c = minC; c <= maxC; c++) {
            const raw = cells.get(cellKey(maxR, c))?.raw?.trim()
            if (raw) {
                if (/^(grand\s+)?(total|totals|subtotal|sum)\b/i.test(raw)) {
                    hasTotalsRow = true
                }
                break
            }
        }

        return {
            minRow: minR,
            maxRow: maxR,
            minCol: minC,
            maxCol: maxC,
            rowCount: maxR - minR + 1,
            colCount: maxC - minC + 1,
            hasTotalsRow,
        }
    }

    // ── Sorting ──

    function executeSortRange({ r1, r2, col, dir, visibleRows = null }) {
        // dir: 'asc' | 'desc' | 'original'
        let startR = r1, endR = r2

        if (startR === undefined || endR === undefined) {
            const used = getUsedRange()
            if (used.rowCount <= 1) return
            startR = 1 // Row 0 is header
            endR = used.hasTotalsRow ? used.maxRow - 1 : used.maxRow
        }

        if (startR >= endR) return

        // Target row indices to sort
        let targetRows = []
        for (let r = startR; r <= endR; r++) {
            if (visibleRows === null || visibleRows.includes(r)) {
                targetRows.push(r)
            }
        }
        if (targetRows.length <= 1) return

        // Pre-extract sort keys once per row for high performance
        const rowKeys = new Map()
        for (const r of targetRows) {
            if (dir === 'original') {
                rowKeys.set(r, { identity: rowIdentities[r] ?? r })
            } else {
                const cell = getCellForDisplay(r, col)
                const raw = cell.computed !== null && cell.computed !== '' ? cell.computed : cell.raw
                const isBlank = raw === null || raw === undefined || String(raw).trim() === ''
                const num = isBlank ? null : toNum(raw)
                const date = (isBlank || num !== null) ? null : toDate(raw)
                const text = (isBlank || num !== null || date !== null) ? '' : norm(raw)
                rowKeys.set(r, { isBlank, num, date, text, identity: rowIdentities[r] ?? r })
            }
        }

        // Sort comparator using pre-extracted keys
        const sortedTargetRows = [...targetRows].sort((rowA, rowB) => {
            const keyA = rowKeys.get(rowA)
            const keyB = rowKeys.get(rowB)

            if (dir === 'original') {
                return keyA.identity - keyB.identity
            }

            // Blanks last always
            if (keyA.isBlank && !keyB.isBlank) return 1
            if (!keyA.isBlank && keyB.isBlank) return -1
            if (keyA.isBlank && keyB.isBlank) return keyA.identity - keyB.identity

            let cmp = 0
            if (keyA.num !== null && keyB.num !== null) {
                cmp = keyA.num - keyB.num
            } else if (keyA.num !== null && keyB.num === null) {
                cmp = -1 // numbers before text
            } else if (keyA.num === null && keyB.num !== null) {
                cmp = 1 // numbers before text
            } else if (keyA.date && keyB.date) {
                cmp = keyA.date.localeCompare(keyB.date)
            } else {
                cmp = keyA.text.localeCompare(keyB.text)
            }

            if (cmp === 0) {
                return keyA.identity - keyB.identity
            }
            return dir === 'desc' ? -cmp : cmp
        })

        // Build row mapping: oldRow -> newRow
        const rowMapping = new Map()
        for (let i = 0; i < targetRows.length; i++) {
            const oldRow = sortedTargetRows[i]
            const newRow = targetRows[i]
            rowMapping.set(oldRow, newRow)
        }

        // Check if anything actually moved
        let changed = false
        for (const [oldR, newR] of rowMapping.entries()) {
            if (oldR !== newR) { changed = true; break }
        }
        if (!changed) return

        // Take snapshot before sorting
        const snap = takeSnapshot()
        const oldRowIds = [...rowIdentities]

        pushToUndoStack({
            type: 'sort',
            snap,
            oldRowIds,
        })

        // Extract rows data
        const rowDataMap = new Map()
        for (const r of targetRows) {
            const colsData = new Map()
            for (let c = 0; c < cols; c++) {
                const key = cellKey(r, c)
                if (cells.has(key)) {
                    colsData.set(c, { ...cells.get(key) })
                }
            }
            rowDataMap.set(r, {
                cells: colsData,
                identity: rowIdentities[r],
            })
        }

        // Clear target row cells in grid
        for (const r of targetRows) {
            for (let c = 0; c < cols; c++) {
                cells.delete(cellKey(r, c))
            }
        }

        // Place rows in new positions
        for (let i = 0; i < targetRows.length; i++) {
            const oldR = sortedTargetRows[i]
            const newR = targetRows[i]
            const data = rowDataMap.get(oldR)
            rowIdentities[newR] = data.identity
            for (const [c, cellVal] of data.cells.entries()) {
                cells.set(cellKey(newR, c), { ...cellVal })
            }
        }

        // Formulas follow rows:
        // Update references pointing to moved rows throughout the entire sheet
        // UNLESS the reference is part of a range spanning the full sorted block [startR..endR]
        let hasFormula = false
        for (const cell of cells.values()) {
            if (cell.raw && cell.raw.startsWith('=')) {
                cell.raw = updateFormulasAfterSort(cell.raw, rowMapping, startR, endR)
                hasFormula = true
            }
        }

        if (hasFormula) {
            graph.clear()
            computedCache.clear()
            dirtyCells.clear()
            _generation++
            for (const [key, value] of cells.entries()) {
                if (value.raw && value.raw.startsWith('=')) updateDependencies(key, value.raw)
            }
            markAllCellsDirty()
            recalculate()
        } else {
            computedCache.clear()
            dirtyCells.clear()
            _generation++
        }
    }

    function updateFormulasAfterSort(formula, rowMapping, blockStartRow, blockEndRow) {
        // Check for ranges spanning the whole block (e.g. J2:J32)
        // If range spans [blockStartRow..blockEndRow], leave it untouched
        const blockRangeRegex = new RegExp(`(\\$?[A-Za-z]+)(\\$?)${blockStartRow + 1}\\s*:\\s*(\\$?[A-Za-z]+)(\\$?)${blockEndRow + 1}`, 'gi')
        const protectedPlaceholders = []
        let protectedFormula = formula.replace(blockRangeRegex, (m) => {
            const idx = protectedPlaceholders.length
            protectedPlaceholders.push(m)
            return `__PROTECTED_RANGE_${idx}__`
        })

        // Replace other cell references
        const updated = protectedFormula.replace(/(\$?)([A-Za-z]+)(\$?)(\d+)/gi, (match, colDollar, colLetter, rowDollar, rowStr) => {
            const rowIdx = parseInt(rowStr, 10) - 1
            if (rowMapping.has(rowIdx)) {
                const newRow = rowMapping.get(rowIdx)
                return `${colDollar}${colLetter}${rowDollar}${newRow + 1}`
            }
            return match
        })

        // Restore protected ranges
        return updated.replace(/__PROTECTED_RANGE_(\d+)__/g, (_, idx) => protectedPlaceholders[parseInt(idx, 10)])
    }

    // ── Row / Column structural operations ──

    function performInsertRow(atIndex) {
        const snapshot = takeSnapshot()
        cells.clear()
        graph.clear()
        computedCache.clear()
        dirtyCells.clear()
        _generation++

        for (const [key, value] of snapshot.entries()) {
            const coords = cellCoords(key)
            if (!coords) continue
            if (coords.row >= atIndex) {
                const newKey = cellKey(coords.row + 1, coords.col)
                cells.set(newKey, { ...value, raw: shiftCellReferences(value.raw, 1, 0, atIndex) })
            } else {
                cells.set(key, { ...value, raw: shiftCellReferences(value.raw, 1, 0, atIndex) })
            }
        }
        rows++
        rowIdentities.splice(atIndex, 0, nextRowId++)

        // Shift custom row heights
        const newHeights = new Map()
        for (const [r, h] of customRowHeights.entries()) {
            if (r >= atIndex) newHeights.set(r + 1, h)
            else newHeights.set(r, h)
        }
        customRowHeights.clear()
        for (const [r, h] of newHeights.entries()) customRowHeights.set(r, h)

        for (const [key, value] of cells.entries()) {
            if (value.raw.startsWith('=')) updateDependencies(key, value.raw)
        }
        markAllCellsDirty()
    }

    function performDeleteRow(atIndex) {
        const snapshot = takeSnapshot()
        cells.clear()
        graph.clear()
        computedCache.clear()
        dirtyCells.clear()
        _generation++

        for (const [key, value] of snapshot.entries()) {
            const coords = cellCoords(key)
            if (!coords) continue
            if (coords.row === atIndex) continue
            if (coords.row > atIndex) {
                const newKey = cellKey(coords.row - 1, coords.col)
                cells.set(newKey, { ...value, raw: shiftCellReferences(value.raw, -1, 0, atIndex) })
            } else {
                cells.set(key, { ...value, raw: shiftCellReferences(value.raw, -1, 0, atIndex) })
            }
        }
        rows--
        rowIdentities.splice(atIndex, 1)

        // Shift custom row heights
        const newHeights = new Map()
        for (const [r, h] of customRowHeights.entries()) {
            if (r === atIndex) continue
            if (r > atIndex) newHeights.set(r - 1, h)
            else newHeights.set(r, h)
        }
        customRowHeights.clear()
        for (const [r, h] of newHeights.entries()) customRowHeights.set(r, h)

        for (const [key, value] of cells.entries()) {
            if (value.raw.startsWith('=')) updateDependencies(key, value.raw)
        }
        markAllCellsDirty()
    }

    function performInsertColumn(atIndex) {
        const snapshot = takeSnapshot()
        cells.clear()
        graph.clear()
        computedCache.clear()
        dirtyCells.clear()
        _generation++

        for (const [key, value] of snapshot.entries()) {
            const coords = cellCoords(key)
            if (!coords) continue
            if (coords.col >= atIndex) {
                const newKey = cellKey(coords.row, coords.col + 1)
                cells.set(newKey, { ...value, raw: shiftCellReferences(value.raw, 0, 1, atIndex, true) })
            } else {
                cells.set(key, { ...value, raw: shiftCellReferences(value.raw, 0, 1, atIndex, true) })
            }
        }
        cols++

        // Shift custom col widths
        const newWidths = new Map()
        for (const [c, w] of customColWidths.entries()) {
            if (c >= atIndex) newWidths.set(c + 1, w)
            else newWidths.set(c, w)
        }
        customColWidths.clear()
        for (const [c, w] of newWidths.entries()) customColWidths.set(c, w)

        for (const [key, value] of cells.entries()) {
            if (value.raw.startsWith('=')) updateDependencies(key, value.raw)
        }
        markAllCellsDirty()
    }

    function performDeleteColumn(atIndex) {
        const snapshot = takeSnapshot()
        cells.clear()
        graph.clear()
        computedCache.clear()
        dirtyCells.clear()
        _generation++

        for (const [key, value] of snapshot.entries()) {
            const coords = cellCoords(key)
            if (!coords) continue
            if (coords.col === atIndex) continue
            if (coords.col > atIndex) {
                const newKey = cellKey(coords.row, coords.col - 1)
                cells.set(newKey, { ...value, raw: shiftCellReferences(value.raw, 0, -1, atIndex, true) })
            } else {
                cells.set(key, { ...value, raw: shiftCellReferences(value.raw, 0, -1, atIndex, true) })
            }
        }
        cols--

        // Shift custom col widths
        const newWidths = new Map()
        for (const [c, w] of customColWidths.entries()) {
            if (c === atIndex) continue
            if (c > atIndex) newWidths.set(c - 1, w)
            else newWidths.set(c, w)
        }
        customColWidths.clear()
        for (const [c, w] of newWidths.entries()) customColWidths.set(c, w)

        for (const [key, value] of cells.entries()) {
            if (value.raw.startsWith('=')) updateDependencies(key, value.raw)
        }
        markAllCellsDirty()
    }

    function executeInsertRow(atIndex) {
        const snapshot = takeSnapshot()
        const previousRows = rows
        const oldRowIds = [...rowIdentities]
        pushToUndoStack({ type: 'rowins', snap: snapshot, oldRows: previousRows, oldRowIds })
        performInsertRow(atIndex)
        recalculate()
    }

    function executeDeleteRow(atIndex) {
        const snapshot = takeSnapshot()
        const previousRows = rows
        const oldRowIds = [...rowIdentities]
        pushToUndoStack({ type: 'rowdel', snap: snapshot, oldRows: previousRows, oldRowIds })
        performDeleteRow(atIndex)
        recalculate()
    }

    function executeInsertColumn(atIndex) {
        const snapshot = takeSnapshot()
        const previousCols = cols
        pushToUndoStack({ type: 'colins', snap: snapshot, oldCols: previousCols })
        performInsertColumn(atIndex)
        recalculate()
    }

    function executeDeleteColumn(atIndex) {
        const snapshot = takeSnapshot()
        const previousCols = cols
        pushToUndoStack({ type: 'coldel', snap: snapshot, oldCols: previousCols })
        performDeleteColumn(atIndex)
        recalculate()
    }

    // ── Undo / Redo execution ──

    function undo() {
        if (undoStack.length === 0) return false
        const entry = undoStack.pop()

        if (entry.type === 'set') {
            const current = cells.get(cellKey(entry.r, entry.c))
            redoStack.push({
                ...entry,
                newRaw: current?.raw || '',
                newStyle: current?.style ? { ...current.style } : null,
            })
            setCellRaw(entry.r, entry.c, entry.oldRaw, entry.oldStyle)
            _generation++
            recalculate()
        } else if (entry.type === 'set_style') {
            const current = cells.get(cellKey(entry.r, entry.c))
            redoStack.push({
                ...entry,
                newStyle: current?.style ? { ...current.style } : null,
            })
            setCellStyleRaw(entry.r, entry.c, entry.oldStyle || {})
            _generation++
            recalculate()
        } else if (entry.type === 'bulk_cells') {
            const currentCells = []
            for (const item of entry.cells) {
                const current = cells.get(cellKey(item.r, item.c))
                currentCells.push({
                    r: item.r,
                    c: item.c,
                    oldRaw: item.oldRaw,
                    oldStyle: item.oldStyle,
                    newRaw: current?.raw || '',
                    newStyle: current?.style ? { ...current.style } : null,
                })
                setCellRaw(item.r, item.c, item.oldRaw, item.oldStyle)
            }
            redoStack.push({
                type: 'bulk_cells',
                label: entry.label,
                cells: currentCells,
            })
            _generation++
            recalculate()
        } else if (entry.type === 'sort') {
            redoStack.push({
                type: 'sort',
                restoreSnap: takeSnapshot(),
                restoreRowIds: [...rowIdentities],
            })
            restoreSnapshot(entry.snap)
            rowIdentities = [...entry.oldRowIds]
            recalculate()
        } else if (entry.type === 'format_sheet') {
            redoStack.push({
                type: 'format_sheet',
                restoreSnap: takeSnapshot(),
                restoreFrozenRows: frozenRowsCount,
                restoreWidths: new Map(customColWidths),
            })
            restoreSnapshot(entry.snap)
            frozenRowsCount = entry.oldFrozenRows
            customColWidths.clear()
            for (const [c, w] of entry.oldWidths.entries()) customColWidths.set(c, w)
            recalculate()
        } else {
            // Structural changes
            redoStack.push({
                ...entry,
                restoreSnap: takeSnapshot(),
                restoreRows: rows,
                restoreCols: cols,
                restoreRowIds: [...rowIdentities],
            })
            restoreSnapshot(entry.snap)
            if (entry.type === 'rowins' || entry.type === 'rowdel') {
                rows = entry.oldRows
                rowIdentities = [...entry.oldRowIds]
            } else if (entry.type === 'colins' || entry.type === 'coldel') {
                cols = entry.oldCols
            }
            recalculate()
        }
        return true
    }

    function redo() {
        if (redoStack.length === 0) return false
        const entry = redoStack.pop()

        if (entry.type === 'set') {
            const current = cells.get(cellKey(entry.r, entry.c))
            undoStack.push({
                ...entry,
                oldRaw: current?.raw || '',
                oldStyle: current?.style ? { ...current.style } : null,
            })
            setCellRaw(entry.r, entry.c, entry.newRaw, entry.newStyle)
            _generation++
            recalculate()
        } else if (entry.type === 'set_style') {
            const current = cells.get(cellKey(entry.r, entry.c))
            undoStack.push({
                ...entry,
                oldStyle: current?.style ? { ...current.style } : null,
            })
            setCellStyleRaw(entry.r, entry.c, entry.newStyle || {})
            _generation++
            recalculate()
        } else if (entry.type === 'bulk_cells') {
            const oldCells = []
            for (const item of entry.cells) {
                const current = cells.get(cellKey(item.r, item.c))
                oldCells.push({
                    r: item.r,
                    c: item.c,
                    oldRaw: current?.raw || '',
                    oldStyle: current?.style ? { ...current.style } : null,
                    newRaw: item.newRaw,
                    newStyle: item.newStyle,
                })
                setCellRaw(item.r, item.c, item.newRaw, item.newStyle)
            }
            undoStack.push({
                type: 'bulk_cells',
                label: entry.label,
                cells: oldCells,
            })
            _generation++
            recalculate()
        } else if (entry.type === 'sort') {
            undoStack.push({
                type: 'sort',
                snap: takeSnapshot(),
                oldRowIds: [...rowIdentities],
            })
            restoreSnapshot(entry.restoreSnap)
            rowIdentities = [...entry.restoreRowIds]
            recalculate()
        } else if (entry.type === 'format_sheet') {
            undoStack.push({
                type: 'format_sheet',
                snap: takeSnapshot(),
                oldFrozenRows: frozenRowsCount,
                oldWidths: new Map(customColWidths),
            })
            restoreSnapshot(entry.restoreSnap)
            frozenRowsCount = entry.restoreFrozenRows
            customColWidths.clear()
            for (const [c, w] of entry.restoreWidths.entries()) customColWidths.set(c, w)
            recalculate()
        } else {
            undoStack.push({
                ...entry,
                snap: takeSnapshot(),
                oldRows: rows,
                oldCols: cols,
                oldRowIds: [...rowIdentities],
            })
            restoreSnapshot(entry.restoreSnap)
            rows = entry.restoreRows
            cols = entry.restoreCols
            if (entry.restoreRowIds) rowIdentities = [...entry.restoreRowIds]
            recalculate()
        }
        return true
    }

    // ── Public Engine Object ──

    return {
        get rows() { return rows },
        get cols() { return cols },
        getCell: getCellForDisplay,
        setCell: executeSetCell,
        setCellStyle: executeSetCellStyle,
        // Style write that does NOT record its own undo entry. Bulk callers
        // (e.g. the format applier) snapshot once and record a single step.
        setCellStyleSilent: (r, c, styleUpdates) => { setCellStyleRaw(r, c, styleUpdates) },
        setRange: executeSetRange,
        clearRange: executeClearRange,
        applyFill: executeApplyFill,
        sortRange: executeSortRange,
        getUsedRange,
        insertRow: executeInsertRow,
        deleteRow: executeDeleteRow,
        insertColumn: executeInsertColumn,
        deleteColumn: executeDeleteColumn,
        undo,
        redo,
        canUndo: () => undoStack.length > 0,
        canRedo: () => redoStack.length > 0,
        ensureCapacity,
        getRowHeight: (r) => customRowHeights.get(r) || 28,
        setRowHeight: (r, h) => { customRowHeights.set(r, h) },
        getColWidth: (c) => customColWidths.get(c) || 100,
        setColWidth: (c, w) => { customColWidths.set(c, w) },
        getFrozenRows: () => frozenRowsCount,
        setFrozenRows: (n) => { frozenRowsCount = n },
        getFrozenCols: () => frozenColsCount,
        setFrozenCols: (n) => { frozenColsCount = n },
        // Helper to record format sheet undo
        recordFormatSheetUndo: (prevSnap, prevFrozenRows, prevWidths) => {
            pushToUndoStack({
                type: 'format_sheet',
                snap: prevSnap,
                oldFrozenRows: prevFrozenRows,
                oldWidths: new Map(prevWidths),
            })
        },
        takeSnapshot,
    }
}

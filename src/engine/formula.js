// ─────────────────────────────────────────────────────────────
//  Formulas: tokenizer, recursive-descent parser, evaluator,
//  serializer and reference rewriting.
//
//  References are stored by *identity*, not position:
//      { t: 'ref', row: <rowId>, col: <colId>, ar: <$row>, ac: <$col> }
//  so inserting or deleting rows/columns never rewrites a formula;
//  the text form is produced on demand from the current positions.
//
//  AST nodes:
//      num   { v }                 neg  { e }
//      ref   { row, col, ar, ac }  bin  { op, l, r }
//      range { a: ref, b: ref }    fn   { name, args }
//      err   { code }              (a reference that could not be bound)
// ─────────────────────────────────────────────────────────────
import { columnIndex, columnLabel } from './refs.js'
import { toNum } from './values.js'

export const ERR = Object.freeze({
    CYCLE: Object.freeze({ error: '#CYCLE!' }),
    REF: Object.freeze({ error: '#REF!' }),
    VALUE: Object.freeze({ error: '#VALUE!' }),
    PARSE: Object.freeze({ error: '#PARSE!' }),
})

export function isError(v) {
    return v !== null && typeof v === 'object' && typeof v.error === 'string'
}

export const FUNCTIONS = Object.freeze(['SUM', 'AVG', 'AVERAGE', 'MIN', 'MAX', 'COUNT'])

// ── Tokenizer ──

const TOKEN = /\s*(?:(\d+\.?\d*|\.\d+)|(\$?[A-Za-z]{1,4}\$?\d{1,7})(?![A-Za-z0-9(])|([A-Za-z][A-Za-z0-9.]*)|(#REF!)|([-+*/^(),:]))/y

function tokenize(src) {
    const tokens = []
    TOKEN.lastIndex = 0
    let pos = 0
    while (pos < src.length) {
        if (/^\s*$/.test(src.slice(pos))) break
        TOKEN.lastIndex = pos
        const m = TOKEN.exec(src)
        if (!m) throw new SyntaxError(`Unexpected character at ${pos}`)
        pos = TOKEN.lastIndex
        if (m[1] !== undefined) tokens.push({ k: 'num', v: Number(m[1]) })
        else if (m[2] !== undefined) tokens.push({ k: 'ref', v: m[2].toUpperCase() })
        else if (m[3] !== undefined) tokens.push({ k: 'ident', v: m[3].toUpperCase() })
        else if (m[4] !== undefined) tokens.push({ k: 'refErr' })
        else tokens.push({ k: 'op', v: m[5] })
    }
    return tokens
}

// ── Parser ──

/**
 * Parses formula text (with or without the leading '=') into an AST.
 * `bind` maps positions to identities: { rowIdAt(pos), colIdAt(pos) } → id or -1.
 * Throws SyntaxError on malformed input.
 */
export function parseFormula(text, bind) {
    const src = text.startsWith('=') ? text.slice(1) : text
    const tokens = tokenize(src)
    let i = 0
    const peek = () => tokens[i]
    const isOp = (v) => tokens[i] && tokens[i].k === 'op' && tokens[i].v === v
    const expectOp = (v) => {
        if (!isOp(v)) throw new SyntaxError(`Expected '${v}'`)
        i++
    }

    function refNode(label) {
        const m = label.match(/^(\$?)([A-Z]+)(\$?)(\d+)$/)
        const colPos = columnIndex(m[2])
        const rowPos = parseInt(m[4], 10) - 1
        const row = rowPos >= 0 ? bind.rowIdAt(rowPos) : -1
        const col = bind.colIdAt(colPos)
        if (row < 0 || col < 0) return { t: 'err', code: '#REF!' }
        return { t: 'ref', row, col, ar: m[3] === '$', ac: m[1] === '$' }
    }

    function primary() {
        const tok = peek()
        if (!tok) throw new SyntaxError('Unexpected end of formula')
        if (tok.k === 'num') { i++; return { t: 'num', v: tok.v } }
        if (tok.k === 'refErr') { i++; return { t: 'err', code: '#REF!' } }
        if (tok.k === 'ref') {
            i++
            const a = refNode(tok.v)
            if (isOp(':')) {
                i++
                const next = peek()
                if (!next || next.k !== 'ref') throw new SyntaxError('Range needs two cell references')
                i++
                const b = refNode(next.v)
                if (a.t === 'err' || b.t === 'err') return { t: 'err', code: '#REF!' }
                return { t: 'range', a, b }
            }
            return a
        }
        if (tok.k === 'ident') {
            i++
            if (!isOp('(')) throw new SyntaxError(`Unknown name ${tok.v}`)
            i++
            const args = []
            if (!isOp(')')) {
                args.push(expression())
                while (isOp(',')) { i++; args.push(expression()) }
            }
            expectOp(')')
            return { t: 'fn', name: tok.v, args }
        }
        if (isOp('(')) {
            i++
            const e = expression()
            expectOp(')')
            return e
        }
        throw new SyntaxError('Unexpected token')
    }

    function unary() {
        if (isOp('-')) { i++; return { t: 'neg', e: unary() } }
        if (isOp('+')) { i++; return unary() }
        return primary()
    }

    function power() {
        const base = unary()
        if (isOp('^')) { i++; return { t: 'bin', op: '^', l: base, r: power() } }
        return base
    }

    function term() {
        let l = power()
        while (isOp('*') || isOp('/')) { const op = tokens[i++].v; l = { t: 'bin', op, l, r: power() } }
        return l
    }

    function expression() {
        let l = term()
        while (isOp('+') || isOp('-')) { const op = tokens[i++].v; l = { t: 'bin', op, l, r: term() } }
        return l
    }

    if (tokens.length === 0) throw new SyntaxError('Empty formula')
    const ast = expression()
    if (i !== tokens.length) throw new SyntaxError('Unexpected trailing input')
    return ast
}

// ── Serializer ──

/** `pos` = { rowPosOf(id), colPosOf(id) } → position or -1 when deleted. */
export function serializeFormula(ast, pos) {
    return '=' + toText(ast, pos, 0)
}

const PRECEDENCE = { '+': 1, '-': 1, '*': 2, '/': 2, '^': 3 }

function refText(ref, pos) {
    const r = pos.rowPosOf(ref.row)
    const c = pos.colPosOf(ref.col)
    if (r < 0 || c < 0) return '#REF!'
    return (ref.ac ? '$' : '') + columnLabel(c) + (ref.ar ? '$' : '') + (r + 1)
}

function toText(node, pos, parentPrec, rightSide = false) {
    switch (node.t) {
        case 'num': return String(node.v)
        case 'err': return node.code
        case 'ref': return refText(node, pos)
        case 'range': {
            const a = refText(node.a, pos), b = refText(node.b, pos)
            return a === '#REF!' || b === '#REF!' ? '#REF!' : `${a}:${b}`
        }
        case 'neg': return '-' + toText(node.e, pos, 4)
        case 'fn': return `${node.name}(${node.args.map(a => toText(a, pos, 0)).join(',')})`
        case 'bin': {
            const p = PRECEDENCE[node.op]
            // At equal precedence, + - * / are left-associative (bracket the right
            // child: A-(B-C)) and ^ is right-associative (bracket the left child).
            const text = `${toText(node.l, pos, p)}${node.op}${toText(node.r, pos, p, true)}`
            const needs = p < parentPrec || (p === parentPrec && (parentPrec === 3 ? !rightSide : rightSide))
            return needs ? `(${text})` : text
        }
        default: return '#PARSE!'
    }
}

// ── Reference walking / rewriting ──

/** Calls onRef(ref) for every single reference and onRange(range) for every range. */
export function visitRefs(ast, onRef, onRange) {
    switch (ast.t) {
        case 'ref': onRef(ast); break
        case 'range': onRange(ast); break
        case 'neg': visitRefs(ast.e, onRef, onRange); break
        case 'bin': visitRefs(ast.l, onRef, onRange); visitRefs(ast.r, onRef, onRange); break
        case 'fn': for (const a of ast.args) visitRefs(a, onRef, onRange); break
        default: break
    }
}

/**
 * Returns a new AST (sharing untouched subtrees) where every single ref is
 * replaced by mapRef(ref) and every range by mapRange(range). Either mapper may
 * return the node unchanged, or an { t: 'err' } node. Returns the same object
 * when nothing changed, so callers can cheaply detect "no rewrite needed".
 */
export function mapRefs(ast, mapRef, mapRange = (r) => r) {
    switch (ast.t) {
        case 'ref': return mapRef(ast)
        case 'range': return mapRange(ast)
        case 'neg': {
            const e = mapRefs(ast.e, mapRef, mapRange)
            return e === ast.e ? ast : { ...ast, e }
        }
        case 'bin': {
            const l = mapRefs(ast.l, mapRef, mapRange)
            const r = mapRefs(ast.r, mapRef, mapRange)
            return l === ast.l && r === ast.r ? ast : { ...ast, l, r }
        }
        case 'fn': {
            let changed = false
            const args = ast.args.map(a => {
                const m = mapRefs(a, mapRef, mapRange)
                if (m !== a) changed = true
                return m
            })
            return changed ? { ...ast, args } : ast
        }
        default: return ast
    }
}

// ── Evaluator ──

/**
 * `ctx.value(rowId, colId)` → number | string | error for one cell (blank is '').
 * `ctx.range(rangeNode)` → array of values, or ERR.REF when an endpoint is gone.
 */
export function evaluate(ast, ctx) {
    switch (ast.t) {
        case 'num': return ast.v
        case 'err': return ERR.REF
        case 'ref': {
            const v = ctx.value(ast.row, ast.col)
            return v === '' ? 0 : v
        }
        case 'range': return ERR.VALUE
        case 'neg': {
            const v = asNumber(evaluate(ast.e, ctx))
            return isError(v) ? v : -v
        }
        case 'bin': {
            const l = asNumber(evaluate(ast.l, ctx))
            if (isError(l)) return l
            const r = asNumber(evaluate(ast.r, ctx))
            if (isError(r)) return r
            switch (ast.op) {
                case '+': return l + r
                case '-': return l - r
                case '*': return l * r
                case '/': return r === 0 ? ERR.VALUE : l / r
                case '^': {
                    const p = Math.pow(l, r)
                    return Number.isFinite(p) ? p : ERR.VALUE
                }
                default: return ERR.VALUE
            }
        }
        case 'fn': return callFunction(ast, ctx)
        default: return ERR.VALUE
    }
}

/** Arithmetic coercion: '' → 0, `$1,200` → 1200, `10%` → 0.1, other text → #VALUE!. */
function asNumber(v) {
    if (typeof v === 'number') return v
    if (isError(v)) return v
    if (v === '') return 0
    const n = toNum(v)
    return n === null ? ERR.VALUE : n
}

function callFunction(ast, ctx) {
    if (!FUNCTIONS.includes(ast.name)) return ERR.VALUE
    // Collect numeric inputs. Text and blanks inside ranges are ignored (Excel
    // semantics); a direct text argument that is not a number is #VALUE!.
    const nums = []
    for (const arg of ast.args) {
        if (arg.t === 'range') {
            const values = ctx.range(arg)
            if (isError(values)) return values
            for (const v of values) {
                if (isError(v)) return v
                const n = typeof v === 'number' ? v : toNum(v)
                if (n !== null) nums.push(n)
            }
        } else {
            const v = evaluate(arg, ctx)
            if (isError(v)) return v
            const n = typeof v === 'number' ? v : toNum(v)
            if (n === null) { if (v !== '') return ERR.VALUE } else nums.push(n)
        }
    }
    switch (ast.name) {
        case 'SUM': return nums.reduce((s, n) => s + n, 0)
        case 'AVG':
        case 'AVERAGE': return nums.length ? nums.reduce((s, n) => s + n, 0) / nums.length : 0
        case 'MIN': return nums.length ? nums.reduce((m, n) => (n < m ? n : m), Infinity) : 0
        case 'MAX': return nums.length ? nums.reduce((m, n) => (n > m ? n : m), -Infinity) : 0
        case 'COUNT': return nums.length
        default: return ERR.VALUE
    }
}

// Formula parsing, evaluation and reference rewriting.
//
// A formula is stored as a *template*: its text split into literal parts and
// reference specs, where relative references are offsets from the host cell
// and absolute ($) ones are fixed indices. Moving a template to another cell
// therefore shifts relative references for free (fill, sort), and identical
// relative formulas (=J2*2 filled down 100,000 rows) share one template and one
// parsed AST.

export const ERRORS = Object.freeze({
  REF: Object.freeze({ error: '#REF!' }),
  VALUE: Object.freeze({ error: '#VALUE!' }),
  DIV0: Object.freeze({ error: '#DIV/0!' }),
  NAME: Object.freeze({ error: '#NAME?' }),
  PARSE: Object.freeze({ error: '#PARSE!' }),
  CYCLE: Object.freeze({ error: '#CYCLE!' }),
})

export const isError = v => v !== null && typeof v === 'object' && 'error' in v

// ── A1 addresses ─────────────────────────────────────────────

export function colLabel(col) {
  let out = ''
  for (let n = col + 1; n > 0; n = Math.floor((n - 1) / 26)) out = String.fromCharCode(65 + ((n - 1) % 26)) + out
  return out
}

function colIndex(label) {
  let n = 0
  for (const ch of label.toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64
  return n - 1
}

export const cellLabel = (r, c) => `${colLabel(c)}${r + 1}`

/** `AZ5000` → { r, c }; null when malformed. */
export function parseCellLabel(text) {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(String(text).trim())
  return m && Number(m[2]) > 0 ? { r: Number(m[2]) - 1, c: colIndex(m[1]) } : null
}

/** `K2:K100000` or `B7` → normalised { r1, c1, r2, c2 }; null when malformed. */
export function parseRangeLabel(text) {
  const [a, b = a, extra] = String(text).split(':')
  const p = parseCellLabel(a), q = parseCellLabel(b)
  if (!p || !q || extra !== undefined) return null
  return { r1: Math.min(p.r, q.r), c1: Math.min(p.c, q.c), r2: Math.max(p.r, q.r), c2: Math.max(p.c, q.c) }
}

// ── Tokenizer ────────────────────────────────────────────────

const REF_TOKEN = /^(\$?)([A-Za-z]{1,3})(\$?)(\d+)/
const NUM_TOKEN = /^\d*\.?\d+(?:[eE][-+]?\d+)?/
const NAME_TOKEN = /^[A-Za-z_][A-Za-z0-9_.]*/

function tokenize(body, hostR, hostC) {
  const tokens = [], parts = [], refs = []
  let i = 0, text = ''
  const flush = () => { if (text) { parts.push(text); text = '' } }
  while (i < body.length) {
    const rest = body.slice(i), ch = body[i]
    if (ch === ' ') { text += ch; i++; continue }
    const ref = REF_TOKEN.exec(rest)
    if (ref && !/^[A-Za-z0-9_(]/.test(rest.slice(ref[0].length))) {
      const absCol = ref[1] === '$', absRow = ref[3] === '$', col = colIndex(ref[2]), row = Number(ref[4]) - 1
      const spec = { row: absRow ? row : row - hostR, col: absCol ? col : col - hostC, absRow, absCol, bad: false }
      flush(); parts.push({ ref: refs.length }); tokens.push({ t: 'ref', i: refs.length }); refs.push(spec)
      i += ref[0].length; continue
    }
    if (rest.startsWith('#REF!')) {
      flush(); parts.push({ ref: refs.length }); tokens.push({ t: 'ref', i: refs.length })
      refs.push({ row: 0, col: 0, absRow: true, absCol: true, bad: true }); i += 5; continue
    }
    const num = NUM_TOKEN.exec(rest)
    if (num) { tokens.push({ t: 'num', v: Number(num[0]) }); text += num[0]; i += num[0].length; continue }
    const name = NAME_TOKEN.exec(rest)
    if (name) { tokens.push({ t: 'name', v: name[0].toUpperCase() }); text += name[0]; i += name[0].length; continue }
    if (ch === '"') {
      const end = body.indexOf('"', i + 1)
      if (end < 0) throw new SyntaxError('unterminated string')
      tokens.push({ t: 'str', v: body.slice(i + 1, end) }); text += body.slice(i, end + 1); i = end + 1; continue
    }
    if ('+-*/^(),:&'.includes(ch)) { tokens.push({ t: ch }); text += ch; i++; continue }
    if ('<>='.includes(ch)) {
      const two = body.slice(i, i + 2), op = ['<=', '>=', '<>'].includes(two) ? two : ch
      tokens.push({ t: 'cmp', v: op }); text += op; i += op.length; continue
    }
    throw new SyntaxError(`unexpected ${ch}`)
  }
  flush()
  return { tokens, parts, refs }
}

// ── Parser (recursive descent → AST) ─────────────────────────

function parse(tokens) {
  let pos = 0
  const peek = () => tokens[pos], take = t => (tokens[pos]?.t === t ? tokens[pos++] : null)
  const expect = t => { if (!take(t)) throw new SyntaxError(`expected ${t}`) }
  const binary = (next, ops) => () => {
    let left = next()
    while (peek() && ops(peek())) { const op = tokens[pos++]; left = { k: 'bin', op: op.v ?? op.t, a: left, b: next() } }
    return left
  }
  const primary = () => {
    const tok = tokens[pos++]
    if (!tok) throw new SyntaxError('unexpected end')
    if (tok.t === 'num') return { k: 'num', v: tok.v }
    if (tok.t === 'str') return { k: 'str', v: tok.v }
    if (tok.t === '-') return { k: 'neg', a: unary() }
    if (tok.t === '+') return unary()
    if (tok.t === '(') { const e = comparison(); expect(')'); return e }
    if (tok.t === 'ref') {
      if (take(':')) {
        const end = take('ref')
        if (!end) throw new SyntaxError('bad range')
        return { k: 'range', a: tok.i, b: end.i }
      }
      return { k: 'ref', i: tok.i }
    }
    if (tok.t === 'name') {
      if (tok.v === 'TRUE' || tok.v === 'FALSE') return { k: 'num', v: tok.v === 'TRUE' ? 1 : 0 }
      expect('(')
      const args = []
      if (!take(')')) { do args.push(comparison()); while (take(',')); expect(')') }
      return { k: 'fn', name: tok.v, args }
    }
    throw new SyntaxError(`unexpected ${tok.t}`)
  }
  const unary = () => primary()
  const power = binary(unary, t => t.t === '^')
  const term = binary(power, t => t.t === '*' || t.t === '/')
  const sum = binary(term, t => t.t === '+' || t.t === '-')
  const concat = binary(sum, t => t.t === '&')
  const comparison = binary(concat, t => t.t === 'cmp')
  const ast = comparison()
  if (pos !== tokens.length) throw new SyntaxError('trailing input')
  return ast
}

// ── Templates ────────────────────────────────────────────────

const signature = (parts, refs) => parts.map(p => {
  if (typeof p === 'string') return p
  const s = refs[p.ref]
  return s.bad ? '\u0001!' : `\u0001${s.absRow ? '$' : ''}${s.row},${s.absCol ? '$' : ''}${s.col}`
}).join('')

function collectDeps(ast, singles, ranges) {
  if (ast.k === 'ref') singles.push(ast.i)
  else if (ast.k === 'range') ranges.push([ast.a, ast.b])
  else for (const child of ast.args ?? [ast.a, ast.b].filter(Boolean)) collectDeps(child, singles, ranges)
}

function makeTemplate(parts, refs, ast, singles, ranges) {
  return { parts, refs, ast, singles, ranges, sig: signature(parts, refs) }
}

/**
 * Compiles formula text (with leading `=`) entered at (r, c) into a template,
 * interned in `cache` so identical relative formulas share one object.
 */
export function compileFormula(raw, r, c, cache) {
  let tpl
  try {
    const { tokens, parts, refs } = tokenize(raw.slice(1), r, c)
    const ast = parse(tokens)
    const singles = [], ranges = []
    collectDeps(ast, singles, ranges)
    tpl = makeTemplate(parts, refs, ast, singles, ranges)
  } catch {
    tpl = { parts: [raw.slice(1)], refs: [], ast: null, singles: [], ranges: [], sig: `\u0002${raw}` }
  }
  return intern(tpl, cache)
}

function intern(tpl, cache) {
  const hit = cache.get(tpl.sig)
  if (hit) return hit
  cache.set(tpl.sig, tpl)
  return tpl
}

function refText(spec, r, c) {
  if (spec.bad) return '#REF!'
  const row = spec.absRow ? spec.row : spec.row + r, col = spec.absCol ? spec.col : spec.col + c
  if (row < 0 || col < 0) return '#REF!'
  return `${spec.absCol ? '$' : ''}${colLabel(col)}${spec.absRow ? '$' : ''}${row + 1}`
}

/** Formula text as the user sees it in the formula bar, for a template hosted at (r, c). */
export const formulaText = (tpl, r, c) => '=' + tpl.parts.map(p => (typeof p === 'string' ? p : refText(tpl.refs[p.ref], r, c))).join('')

/** Absolute { row, col } of a reference spec at host (r, c), or null when it is #REF!. */
export function targetOf(spec, r, c) {
  if (spec.bad) return null
  const row = spec.absRow ? spec.row : spec.row + r, col = spec.absCol ? spec.col : spec.col + c
  return row < 0 || col < 0 ? null : { row, col }
}

/**
 * Rewrites a template for a structural edit along one axis ('row' | 'col').
 * The host moves from (r, c) to (nr, nc); `mapSingle(t)` maps a single
 * reference target and `mapRange(t1, t2)` maps both ends of a range; either
 * returns null when the target was deleted. $ markers are preserved: an
 * absolute reference still follows its data, as in every spreadsheet.
 * Returns the same template object when nothing changed.
 */
export function remapTemplate(tpl, r, c, nr, nc, axis, mapSingle, mapRange, cache) {
  if (!tpl.refs.length) return tpl
  const rowAxis = axis === 'row', host = rowAxis ? r : c, newHost = rowAxis ? nr : nc
  const next = tpl.refs.slice()
  let changed = false
  const write = (i, target) => {
    const spec = tpl.refs[i]
    if (spec.bad) return
    if (target === null) { next[i] = { ...spec, bad: true }; changed = true; return }
    const abs = rowAxis ? spec.absRow : spec.absCol
    const value = abs ? target : target - newHost
    if (value !== (rowAxis ? spec.row : spec.col)) { next[i] = rowAxis ? { ...spec, row: value } : { ...spec, col: value }; changed = true }
  }
  const abs = spec => (rowAxis ? (spec.absRow ? spec.row : spec.row + host) : (spec.absCol ? spec.col : spec.col + host))
  for (const i of tpl.singles) if (!tpl.refs[i].bad) write(i, mapSingle(abs(tpl.refs[i])))
  for (const [a, b] of tpl.ranges) {
    if (tpl.refs[a].bad || tpl.refs[b].bad) continue
    const t1 = abs(tpl.refs[a]), t2 = abs(tpl.refs[b]), flip = t1 > t2
    const mapped = mapRange(Math.min(t1, t2), Math.max(t1, t2))
    if (!mapped) { write(a, null); write(b, null) } else { write(a, mapped[flip ? 1 : 0]); write(b, mapped[flip ? 0 : 1]) }
  }
  if (!changed) return tpl
  return intern(makeTemplate(tpl.parts, next, tpl.ast, tpl.singles, tpl.ranges), cache)
}

// ── Evaluation ───────────────────────────────────────────────

function toNumber(v) {
  if (v === null || v === '') return 0
  if (typeof v === 'number') return v
  if (isError(v)) return v
  const n = Number(String(v).trim())
  return String(v).trim() !== '' && Number.isFinite(n) ? n : ERRORS.VALUE
}

const AGGREGATES = {
  SUM: nums => nums.reduce((a, b) => a + b, 0),
  AVERAGE: nums => (nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : ERRORS.DIV0),
  MIN: nums => (nums.length ? nums.reduce((a, b) => (b < a ? b : a)) : 0),
  MAX: nums => (nums.length ? nums.reduce((a, b) => (b > a ? b : a)) : 0),
  COUNT: nums => nums.length,
}
AGGREGATES.AVG = AGGREGATES.AVERAGE

function evalNode(node, tpl, ctx) {
  switch (node.k) {
    case 'num': case 'str': return node.v
    case 'ref': {
      const t = targetOf(tpl.refs[node.i], ctx.r, ctx.c)
      return t ? ctx.get(t.row, t.col) : ERRORS.REF
    }
    case 'range': return ERRORS.VALUE
    case 'neg': { const v = toNumber(evalNode(node.a, tpl, ctx)); return isError(v) ? v : -v }
    case 'bin': return binaryOp(node.op, evalNode(node.a, tpl, ctx), evalNode(node.b, tpl, ctx))
    case 'fn': return callFunction(node, tpl, ctx)
    default: return ERRORS.VALUE
  }
}

function binaryOp(op, a, b) {
  if (isError(a)) return a
  if (isError(b)) return b
  if (op === '&') return `${a ?? ''}${b ?? ''}`
  if (['=', '<>', '<', '>', '<=', '>='].includes(op)) {
    const x = typeof a === 'number' ? a : String(a ?? '').toLowerCase(), y = typeof b === 'number' ? b : String(b ?? '').toLowerCase()
    return ({ '=': x === y, '<>': x !== y, '<': x < y, '>': x > y, '<=': x <= y, '>=': x >= y })[op] ? 1 : 0
  }
  const x = toNumber(a), y = toNumber(b)
  if (isError(x)) return x
  if (isError(y)) return y
  if (op === '+') return x + y
  if (op === '-') return x - y
  if (op === '*') return x * y
  if (op === '^') return x ** y
  return y === 0 ? ERRORS.DIV0 : x / y
}

function callFunction(node, tpl, ctx) {
  const agg = AGGREGATES[node.name]
  if (agg) {
    const nums = []
    for (const arg of node.args) {
      if (arg.k === 'range') {
        const a = targetOf(tpl.refs[arg.a], ctx.r, ctx.c), b = targetOf(tpl.refs[arg.b], ctx.r, ctx.c)
        if (!a || !b) return ERRORS.REF
        let failed = null
        ctx.each(Math.min(a.row, b.row), Math.min(a.col, b.col), Math.max(a.row, b.row), Math.max(a.col, b.col), v => {
          if (isError(v)) failed = failed ?? v
          else if (typeof v === 'number') nums.push(v)
        })
        if (failed) return failed
      } else {
        const v = evalNode(arg, tpl, ctx)
        if (isError(v)) return v
        const n = toNumber(v)
        if (!isError(n) && v !== null && v !== '') nums.push(n)
      }
    }
    return agg(nums)
  }
  const args = node.args.map(arg => evalNode(arg, tpl, ctx))
  const bad = args.find(isError)
  if (bad) return bad
  if (node.name === 'ABS' && args.length === 1) { const n = toNumber(args[0]); return isError(n) ? n : Math.abs(n) }
  if (node.name === 'ROUND' && args.length >= 1) {
    const n = toNumber(args[0]), d = args.length > 1 ? toNumber(args[1]) : 0
    if (isError(n)) return n
    if (isError(d)) return d
    const f = 10 ** d
    return Math.round(n * f) / f
  }
  if (node.name === 'IF' && args.length >= 2) return toNumber(args[0]) ? args[1] : (args[2] ?? 0)
  return ERRORS.NAME
}

/**
 * Evaluates a template hosted at (r, c). `ctx.get(row, col)` returns a cell
 * value (number, string, null or error) and `ctx.each(r1, c1, r2, c2, fn)`
 * visits the non-empty values of a rectangle.
 */
export function evaluate(tpl, r, c, ctx) {
  if (!tpl.ast) return ERRORS.PARSE
  ctx.r = r; ctx.c = c
  const v = evalNode(tpl.ast, tpl, ctx)
  if (typeof v === 'number' && !Number.isFinite(v)) return ERRORS.VALUE
  return v
}

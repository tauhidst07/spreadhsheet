// The spreadsheet engine: sparse storage, formulas with a dependency graph,
// styles, sizes, filters and patch-based undo. Pure JavaScript: no React, no DOM.
//
// Data model
//   rowsById   Map<row, RowRec>; a RowRec is { id, cells: Map<col, Cell>, styles: Map<col, Style>, height? }.
//              Everything that belongs to a row lives in its RowRec, so sorting and
//              inserting rows move one object per row and styles/heights follow.
//   Cell       literal { raw, num } (num = coerced number or null) or formula { tpl, value }.
//   src        what undo stores for a cell: null, the literal text, or the formula template.
//   graph      single-cell edges (Map<cellKey, Set<formulaKey>>) plus range edges bucketed
//              by column, so an edit visits only its dependents.

import { compileFormula, ERRORS, evaluate, formulaText, isError, remapTemplate, targetOf } from './formula.js'
import { seriesFor } from './fill.js'
import { formatComputed, isTotalsLabelRow, norm, parseDate, dayNumber, toNum, applyNumberFormat } from './values.js'

export const DEFAULT_COL_WIDTH = 100
export const DEFAULT_ROW_HEIGHT = 24
const MAX_UNDO = 100
const STRIDE = 16384
const CHUNK = 5000          // cells (or rows) per step of a sliced job

/** Runs a step generator to completion synchronously and returns its result. */
function drain(steps) {
  let next = steps.next()
  while (!next.done) next = steps.next()
  return next.value
}
const STYLE_KEYS = ['bold', 'italic', 'underline', 'bg', 'color', 'align', 'fontSize', 'numberFormat']

const keyOf = (r, c) => r * STRIDE + c
const rowOfKey = k => Math.floor(k / STRIDE)
const colOfKey = k => k % STRIDE

/** Drops unknown, false-y defaults and empty values so equal styles compare equal. */
export function normalizeStyle(style) {
  const out = {}
  for (const k of STYLE_KEYS) {
    const v = style?.[k]
    if (v === undefined || v === null || v === '' || v === false) continue
    if (k === 'bg' && v === 'white') continue
    if (k === 'numberFormat' && v === 'general') continue
    out[k] = v
  }
  return out
}

const sameStyle = (a, b) => {
  const ka = Object.keys(a), kb = Object.keys(b)
  return ka.length === kb.length && ka.every(k => a[k] === b[k])
}

const normRange = ({ r1, c1, r2, c2 }) => ({ r1: Math.min(r1, r2), c1: Math.min(c1, c2), r2: Math.max(r1, r2), c2: Math.max(c1, c2) })

export function createEngine(initialRows = 100000, initialCols = 200) {
  let rows = initialRows, cols = initialCols
  let rowsById = new Map()
  let colWidths = new Map()
  let filters = new Map()
  let frozenRows = 0, frozenCols = 0
  let nextRowId = 0
  let version = 0, layoutVersion = 0
  const undoStack = [], redoStack = []
  const tplCache = new Map()
  const singleDeps = new Map()          // cellKey → formulaKey | Set<formulaKey>
  const rangeDeps = new Map()           // col → Map<formulaKey, Array<[r1, r2]>>
  let usedCache = null, hiddenCache = null, lastRecalcCount = 0

  // ── Storage ────────────────────────────────────────────────

  const cellAt = (r, c) => rowsById.get(r)?.cells.get(c)
  const srcOf = cell => (cell ? cell.tpl ?? cell.raw : null)

  function rowRec(r) {
    let rec = rowsById.get(r)
    if (!rec) { rec = { id: nextRowId++, cells: new Map(), styles: new Map() }; rowsById.set(r, rec) }
    return rec
  }

  function dropIfEmpty(r) {
    const rec = rowsById.get(r)
    if (rec && !rec.cells.size && !rec.styles.size && rec.height === undefined) rowsById.delete(r)
  }

  function makeCell(src, r, c) {
    if (typeof src === 'string') {
      if (src.startsWith('=') && src.length > 1) return { tpl: compileFormula(src, r, c, tplCache), value: null }
      return { raw: src, num: toNum(src) }
    }
    return { tpl: src, value: null }
  }

  /** Writes a cell without history or recalculation; keeps the graph in sync. */
  function putCell(r, c, src) {
    const k = keyOf(r, c), old = cellAt(r, c)
    if (old?.tpl) unlink(k, r, c, old.tpl)
    if (src === null || src === '') {
      if (old) { rowsById.get(r).cells.delete(c); dropIfEmpty(r); if (usedCache && (r === usedCache.r2 || c === usedCache.c2)) usedCache = null }
      return null
    }
    const cell = makeCell(src, r, c)
    rowRec(r).cells.set(c, cell)
    if (cell.tpl) link(k, r, c, cell.tpl)
    if (usedCache && !old) usedCache = { r1: 0, c1: 0, r2: Math.max(usedCache.r2, r), c2: Math.max(usedCache.c2, c) }
    return cell
  }

  // ── Dependency graph ───────────────────────────────────────

  function addEdge(ck, k) {
    const cur = singleDeps.get(ck)
    if (cur === undefined) singleDeps.set(ck, k)
    else if (typeof cur === 'number') { if (cur !== k) singleDeps.set(ck, new Set([cur, k])) }
    else cur.add(k)
  }

  function removeEdge(ck, k) {
    const cur = singleDeps.get(ck)
    if (cur === k) singleDeps.delete(ck)
    else if (cur instanceof Set) { cur.delete(k); if (cur.size === 1) singleDeps.set(ck, cur.values().next().value) }
  }

  function rangeBox(tpl, a, b, r, c) {
    const p = targetOf(tpl.refs[a], r, c), q = targetOf(tpl.refs[b], r, c)
    return p && q ? [Math.min(p.row, q.row), Math.min(p.col, q.col), Math.max(p.row, q.row), Math.max(p.col, q.col)] : null
  }

  /** Cell key a single reference points at from host (r, c), or -1 for #REF!. */
  function refKey(spec, r, c) {
    if (spec.bad) return -1
    const row = spec.absRow ? spec.row : spec.row + r, col = spec.absCol ? spec.col : spec.col + c
    return row < 0 || col < 0 ? -1 : row * STRIDE + col
  }

  /** Adds the edges of formula k (hosted at r, c) to the graph. */
  function link(k, r, c, tpl) {
    for (const i of tpl.singles) {
      const ck = refKey(tpl.refs[i], r, c)
      if (ck >= 0) addEdge(ck, k)
    }
    for (const [a, b] of tpl.ranges) {
      const box = rangeBox(tpl, a, b, r, c)
      if (!box) continue
      for (let col = box[1]; col <= box[3]; col++) {
        let byFormula = rangeDeps.get(col)
        if (!byFormula) rangeDeps.set(col, (byFormula = new Map()))
        const list = byFormula.get(k)
        if (list) list.push([box[0], box[2]]); else byFormula.set(k, [[box[0], box[2]]])
      }
    }
  }

  function unlink(k, r, c, tpl) {
    for (const i of tpl.singles) {
      const ck = refKey(tpl.refs[i], r, c)
      if (ck >= 0) removeEdge(ck, k)
    }
    for (const [a, b] of tpl.ranges) {
      const box = rangeBox(tpl, a, b, r, c)
      if (!box) continue
      for (let col = box[1]; col <= box[3]; col++) {
        const byFormula = rangeDeps.get(col)
        if (byFormula) { byFormula.delete(k); if (!byFormula.size) rangeDeps.delete(col) }
      }
    }
  }

  const NONE = []

  function dependentsOf(k) {
    const single = singleDeps.get(k), byFormula = rangeDeps.size ? rangeDeps.get(colOfKey(k)) : undefined
    if (single === undefined && !byFormula) return NONE
    const out = single === undefined ? [] : typeof single === 'number' ? [single] : [...single]
    if (byFormula) {
      const r = rowOfKey(k)
      for (const [f, spans] of byFormula) if (spans.some(([a, b]) => r >= a && r <= b)) out.push(f)
    }
    return out
  }

  /** Rebuilds the graph; returns every formula key (`all`) and those with ranges (`ranged`). */
  function relinkAll() {
    singleDeps.clear(); rangeDeps.clear()
    const all = [], ranged = []
    for (const [r, rec] of rowsById) for (const [c, cell] of rec.cells) if (cell.tpl) {
      const k = keyOf(r, c)
      link(k, r, c, cell.tpl); all.push(k)
      if (cell.tpl.ranges.length) ranged.push(k)
    }
    return { all, ranged }
  }

  // ── Recalculation (dependents only, topological order) ─────

  const evalCtx = {
    r: 0, c: 0,
    get(r, c) {
      const cell = cellAt(r, c)
      if (!cell) return null
      return cell.tpl ? cell.value : cell.num ?? cell.raw
    },
    each(r1, c1, r2, c2, fn) {
      const visit = rec => {
        if (c2 - c1 < rec.cells.size) { for (let c = c1; c <= c2; c++) { const cell = rec.cells.get(c); if (cell) fn(cell.tpl ? cell.value : cell.num ?? cell.raw) } }
        else for (const [c, cell] of rec.cells) if (c >= c1 && c <= c2) fn(cell.tpl ? cell.value : cell.num ?? cell.raw)
      }
      if (r2 - r1 > rowsById.size) { for (const [r, rec] of rowsById) if (r >= r1 && r <= r2) visit(rec) }
      else for (let r = r1; r <= r2; r++) { const rec = rowsById.get(r); if (rec) visit(rec) }
    },
  }

  /**
   * Recomputes the formulas reachable from `roots` (changed cells) through the
   * dependency graph, in topological order (iterative DFS, reverse post-order).
   * Formulas on a cycle get #CYCLE!. Cost is proportional to the dependents.
   */
  function recalc(roots) {
    const state = new Map(), order = [], cyclic = new Set(), stack = [], onStack = new Map()
    for (const root of roots) {
      if (state.has(root)) continue
      const first = dependentsOf(root)
      if (!first.length) { state.set(root, 2); order.push(root); continue }
      state.set(root, 1); onStack.set(root, 0); stack.push([root, first, 0])
      while (stack.length) {
        const frame = stack[stack.length - 1]
        if (frame[2] < frame[1].length) {
          const next = frame[1][frame[2]++], s = state.get(next)
          if (s === 1) { for (let i = onStack.get(next); i < stack.length; i++) cyclic.add(stack[i][0]) }
          else if (s === undefined) { state.set(next, 1); onStack.set(next, stack.length); stack.push([next, dependentsOf(next), 0]) }
        } else {
          stack.pop(); onStack.delete(frame[0]); state.set(frame[0], 2); order.push(frame[0])
        }
      }
    }
    for (let i = order.length - 1; i >= 0; i--) {
      const k = order[i], r = rowOfKey(k), c = colOfKey(k), cell = cellAt(r, c)
      if (cell?.tpl) cell.value = cyclic.has(k) ? ERRORS.CYCLE : evaluate(cell.tpl, r, c, evalCtx)
    }
    lastRecalcCount = order.length
  }

  // ── Reading ────────────────────────────────────────────────

  /** Computed value: number, text, '' (empty) or { error }. */
  function valueAt(r, c) {
    const cell = cellAt(r, c)
    if (!cell) return ''
    if (!cell.tpl) return cell.raw
    return cell.value ?? ''
  }

  /** Display text before number formatting (what queries and sorting read). */
  function textAt(r, c) {
    const v = valueAt(r, c)
    if (typeof v === 'number') return formatComputed(v)
    return isError(v) ? v.error : String(v)
  }

  function getCell(r, c) {
    const cell = cellAt(r, c)
    if (!cell) return { raw: '', computed: '', error: null }
    if (!cell.tpl) return { raw: cell.raw, computed: cell.num ?? cell.raw, error: null }
    const v = cell.value
    return { raw: formulaText(cell.tpl, r, c), computed: isError(v) ? null : v ?? '', error: isError(v) ? v.error : null }
  }

  const styleAt = (r, c) => rowsById.get(r)?.styles.get(c)

  /** Text as the grid shows it, with the cell's number format applied. */
  function displayAt(r, c) {
    const text = textAt(r, c), fmt = styleAt(r, c)?.numberFormat
    return fmt ? applyNumberFormat(text, fmt) : text
  }

  function usedRange() {
    if (usedCache) return usedCache
    let r2 = -1, c2 = -1
    for (const [r, rec] of rowsById) {
      if (!rec.cells.size) continue
      if (r > r2) r2 = r
      for (const c of rec.cells.keys()) if (c > c2) c2 = c
    }
    usedCache = r2 < 0 ? null : { r1: 0, c1: 0, r2, c2 }
    return usedCache
  }

  const rowTexts = (r, c1, c2) => { const out = []; for (let c = c1; c <= c2; c++) out.push(textAt(r, c)); return out }

  function getRangeText(range) {
    const { r1, c1, r2, c2 } = normRange(range), out = []
    for (let r = r1; r <= r2; r++) out.push(rowTexts(r, c1, c2))
    return out
  }

  // ── Filters (a view, but recorded in history) ──────────────

  function matchesFilter(text, f) {
    const key = norm(text)
    if (f.values && !f.values.includes(key)) return false
    if (!f.op) return true
    if (f.op === 'empty') return key === ''
    if (f.op === 'contains') return key.includes(norm(f.value))
    const a = toNum(text), b = toNum(f.value)
    if (a === null || b === null) return false
    return f.op === 'gt' ? a > b : a < b
  }

  function hiddenRows() {
    if (!filters.size) return null
    if (hiddenCache) return hiddenCache
    const used = usedRange(), last = used ? used.r2 : 0, hidden = new Set()
    for (let r = 1; r <= last; r++) {
      for (const [c, f] of filters) if (!matchesFilter(textAt(r, c), f)) { hidden.add(r); break }
    }
    hiddenCache = hidden
    return hidden
  }

  const isRowHidden = r => !!hiddenRows()?.has(r)

  // ── History ────────────────────────────────────────────────

  /** Bumps versions after a mutation. putCell keeps the used range current; `structural` drops it. */
  function changed(layout = false, structural = false) {
    version++
    hiddenCache = null
    if (structural) usedCache = null
    if (layout || filters.size) layoutVersion++
  }

  function record(entry) {
    undoStack.push(entry)
    if (undoStack.length > MAX_UNDO) undoStack.shift()
    redoStack.length = 0
  }

  /** A patch collects old/new pairs; commit() applies nothing more, it only records. */
  function beginPatch() { return { cells: [], styles: [], widths: [], heights: [], frozen: null, filters: [], roots: [] } }

  function writeCell(p, r, c, src) {
    const old = srcOf(cellAt(r, c)), next = src === '' ? null : src
    if (old === next) return
    p.cells.push([r, c, old, next]); putCell(r, c, next); p.roots.push(keyOf(r, c))
  }

  function writeStyle(p, r, c, style) {
    const old = styleAt(r, c) ?? null, next = style && Object.keys(style).length ? style : null
    if (old === next || (old && next && sameStyle(old, next))) return
    p.styles.push([r, c, old, next]); putStyle(r, c, next)
  }

  function putStyle(r, c, style) {
    if (style) rowRec(r).styles.set(c, style)
    else if (rowsById.has(r)) { rowsById.get(r).styles.delete(c); dropIfEmpty(r) }
  }

  function putHeight(r, h) {
    if (h !== null) rowRec(r).height = h
    else if (rowsById.has(r)) { delete rowsById.get(r).height; dropIfEmpty(r) }
  }

  function writeWidth(p, c, w) {
    const old = colWidths.get(c) ?? null
    if (old === w) return
    p.widths.push([c, old, w]); w === null ? colWidths.delete(c) : colWidths.set(c, w)
  }

  function writeHeight(p, r, h) {
    const old = rowsById.get(r)?.height ?? null
    if (old === h) return
    p.heights.push([r, old, h]); putHeight(r, h)
  }

  function writeFrozen(p, nextRows, nextCols) {
    if (nextRows === frozenRows && nextCols === frozenCols) return
    p.frozen = [frozenRows, frozenCols, nextRows, nextCols]; frozenRows = nextRows; frozenCols = nextCols
  }

  function writeFilter(p, c, f) {
    const old = filters.get(c) ?? null
    if (JSON.stringify(old) === JSON.stringify(f)) return
    p.filters.push([c, old, f]); f ? filters.set(c, f) : filters.delete(c)
  }

  const patchSize = p => p.cells.length + p.styles.length + p.widths.length + p.heights.length + p.filters.length + (p.frozen ? 1 : 0)

  function commit(p) {
    if (!patchSize(p)) return false
    recalc(p.roots)
    p.roots = []
    const { roots: _roots, ...entry } = p
    record({ type: 'patch', ...entry })
    changed(p.widths.length + p.heights.length + p.filters.length > 0 || !!p.frozen)
    return true
  }

  function* applyPatchSteps(p, undo) {
    // Cell/style entries are [r, c, old, new]; width/height/filter entries are [index, old, new].
    const side = undo ? 2 : 3, pick = undo ? 1 : 2, order = list => (undo ? [...list].reverse() : list)
    let roots = [], n = 0
    for (const e of order(p.cells)) {
      putCell(e[0], e[1], e[side]); roots.push(keyOf(e[0], e[1]))
      if (++n % CHUNK === 0) { recalc(roots); roots = []; yield n / p.cells.length }
    }
    for (const e of order(p.styles)) putStyle(e[0], e[1], e[side])
    for (const e of order(p.widths)) e[pick] === null ? colWidths.delete(e[0]) : colWidths.set(e[0], e[pick])
    for (const e of order(p.heights)) putHeight(e[0], e[pick])
    for (const e of order(p.filters)) e[pick] ? filters.set(e[0], e[pick]) : filters.delete(e[0])
    if (p.frozen) { frozenRows = p.frozen[undo ? 0 : 2]; frozenCols = p.frozen[undo ? 1 : 3] }
    recalc(roots)
  }

  function* replaySteps(entry, undo) {
    if (entry.type === 'patch') yield* applyPatchSteps(entry, undo)
    else if (entry.type === 'permute') yield* permuteSteps(undo ? entry.to : entry.from, undo ? entry.from : entry.to)
    else if (entry.type === 'insert') undo ? removeLines(entry.axis, entry.at, entry.count) : insertLines(entry.axis, entry.at, entry.count)
    else if (entry.type === 'delete') {
      if (undo) { insertLines(entry.axis, entry.at, entry.count); restoreLines(entry) }
      else Object.assign(entry, removeLines(entry.axis, entry.at, entry.count))
    }
    changed(entry.type !== 'patch' || entry.widths.length + entry.heights.length + entry.filters.length > 0 || !!entry.frozen, true)
  }

  /** Reverts the last history entry; a generator so large reverts can be time-sliced. */
  function* undoSteps() {
    const entry = undoStack.pop()
    if (!entry) return false
    yield* replaySteps(entry, true); redoStack.push(entry)
    return true
  }

  function* redoSteps() {
    const entry = redoStack.pop()
    if (!entry) return false
    yield* replaySteps(entry, false); undoStack.push(entry)
    return true
  }

  // ── Structural edits ───────────────────────────────────────

  /**
   * Moves every cell along one axis. `mapIndex(i)` gives the new index of a
   * row/column (-1 when deleted); `mapSingle`/`mapRange` rewrite references.
   * Returns what was removed plus the formulas whose text had to change, so a
   * delete can be undone exactly.
   */
  function restructure(axis, mapIndex, mapSingle, mapRange) {
    const removed = [], fixes = [], moved = []
    const remap = (cell, r, c, nr, nc) => {
      if (!cell.tpl) return cell
      const tpl = remapTemplate(cell.tpl, r, c, nr, nc, axis, mapSingle, mapRange, tplCache)
      if (tpl === cell.tpl) return cell
      fixes.push([r, c, cell.tpl]); moved.push([nr, nc])
      return { tpl, value: cell.value }
    }
    if (axis === 'row') {
      const next = new Map()
      for (const [r, rec] of rowsById) {
        const nr = mapIndex(r)
        if (nr < 0) { removed.push([r, rec]); continue }
        for (const [c, cell] of rec.cells) { const moved = remap(cell, r, c, nr, c); if (moved !== cell) rec.cells.set(c, moved) }
        next.set(nr, rec)
      }
      rowsById = next
    } else {
      for (const [r, rec] of rowsById) {
        const cells = new Map(), styles = new Map(), gone = { cells: [], styles: [] }
        for (const [c, cell] of rec.cells) { const nc = mapIndex(c); if (nc < 0) gone.cells.push([c, cell]); else cells.set(nc, remap(cell, r, c, r, nc)) }
        for (const [c, style] of rec.styles) { const nc = mapIndex(c); if (nc < 0) gone.styles.push([c, style]); else styles.set(nc, style) }
        if (gone.cells.length || gone.styles.length) removed.push([r, gone])
        rec.cells = cells; rec.styles = styles
      }
      const widths = new Map(), removedWidths = []
      for (const [c, w] of colWidths) { const nc = mapIndex(c); if (nc < 0) removedWidths.push([c, w]); else widths.set(nc, w) }
      colWidths = widths
      const nextFilters = new Map()
      for (const [c, f] of filters) { const nc = mapIndex(c); if (nc >= 0) nextFilters.set(nc, f) }
      filters = nextFilters
      removed.push(['widths', removedWidths])
    }
    const { ranged } = relinkAll()
    recalc([...moved.map(([r, c]) => keyOf(r, c)), ...ranged])
    return { removed, fixes }
  }

  function insertLines(axis, at, count) {
    if (axis === 'row') rows += count; else cols += count
    const shift = i => (i >= at ? i + count : i)
    restructure(axis, shift, shift, (a, b) => [shift(a), shift(b)])
  }

  function removeLines(axis, at, count) {
    const end = at + count
    const result = restructure(axis,
      i => (i < at ? i : i >= end ? i - count : -1),
      t => (t < at ? t : t >= end ? t - count : null),
      (a, b) => {
        const na = a < at ? a : a >= end ? a - count : at, nb = b < at ? b : b >= end ? b - count : at - 1
        return nb < na ? null : [na, nb]
      })
    if (axis === 'row') rows -= count; else cols -= count
    return result
  }

  /** Puts back what removeLines took out (after the lines were re-inserted). */
  function restoreLines(entry) {
    if (entry.axis === 'row') {
      for (const [r, rec] of entry.removed) rowsById.set(r, rec)
    } else {
      for (const [r, gone] of entry.removed) {
        if (r === 'widths') { for (const [c, w] of gone) colWidths.set(c, w); continue }
        const rec = rowRec(r)
        for (const [c, cell] of gone.cells) rec.cells.set(c, cell)
        for (const [c, style] of gone.styles) rec.styles.set(c, style)
      }
    }
    for (const [r, c, tpl] of entry.fixes) { const rec = rowsById.get(r); if (rec?.cells.has(c)) rec.cells.set(c, { tpl, value: null }) }
    recalc(relinkAll().all)
  }

  function insertRows(at, count = 1) { insertLines('row', at, count); record({ type: 'insert', axis: 'row', at, count }); changed(true, true) }
  function insertColumns(at, count = 1) { insertLines('col', at, count); record({ type: 'insert', axis: 'col', at, count }); changed(true, true) }
  function deleteRows(at, count = 1) { const { removed, fixes } = removeLines('row', at, count); record({ type: 'delete', axis: 'row', at, count, removed, fixes }); changed(true, true) }
  function deleteColumns(at, count = 1) { const { removed, fixes } = removeLines('col', at, count); record({ type: 'delete', axis: 'col', at, count, removed, fixes }); changed(true, true) }

  /**
   * Row from[i] moves to to[i] (a permutation of the same rows). Formulas
   * follow their rows; multi-row ranges stay put. Only the moved rows'
   * formulas and the formulas that reference moved cells are re-linked, in
   * slices; values travel with their rows, so only changed templates and
   * range formulas are recalculated.
   */
  function* permuteSteps(from, to) {
    const target = new Map()
    for (let i = 0; i < from.length; i++) target.set(from[i], to[i])
    const move = i => target.get(i) ?? i
    const mapRange = (a, b) => (a === b ? [move(a), move(a)] : [a, b])
    const affected = [], seen = new Set()
    let n = 0
    for (const r of from) {
      const rec = rowsById.get(r)
      if (rec) for (const [c, cell] of rec.cells) {
        const k = keyOf(r, c)
        if (cell.tpl && !seen.has(k)) { seen.add(k); affected.push(r, c, cell) }
        for (const f of dependentsOf(k)) if (!seen.has(f)) { seen.add(f); affected.push(rowOfKey(f), colOfKey(f), cellAt(rowOfKey(f), colOfKey(f))) }
      }
      if (++n % CHUNK === 0) yield
    }
    for (let i = 0; i < affected.length; i += 3) {
      unlink(keyOf(affected[i], affected[i + 1]), affected[i], affected[i + 1], affected[i + 2].tpl)
      if (i % (CHUNK * 3) === 0) yield
    }
    const recs = from.map(r => rowsById.get(r))
    for (const r of from) rowsById.delete(r)
    recs.forEach((rec, i) => { if (rec) rowsById.set(to[i], rec) })
    const roots = []
    for (let i = 0; i < affected.length; i += 3) {
      const r = affected[i], c = affected[i + 1], cell = affected[i + 2], nr = move(r)
      const tpl = remapTemplate(cell.tpl, r, c, nr, c, 'row', move, mapRange, tplCache)
      if (tpl !== cell.tpl) { rowsById.get(nr).cells.set(c, { tpl, value: cell.value }); roots.push(keyOf(nr, c)) }
      link(keyOf(nr, c), nr, c, tpl)
      if (i % (CHUNK * 3) === 0) yield
    }
    for (const byFormula of rangeDeps.values()) for (const k of byFormula.keys()) roots.push(k)
    recalc(roots)
  }

  // ── Sorting ────────────────────────────────────────────────

  function sortKey(r, col) {
    const v = valueAt(r, col)
    if (typeof v === 'number') return [0, v, '']
    const text = isError(v) ? v.error : String(v).trim()
    if (!text) return [2, 0, '']
    const date = parseDate(text)
    if (date) return [0, dayNumber(date), '']
    const n = toNum(text)
    return n === null ? [1, 0, text.toLowerCase()] : [0, n, '']
  }

  /**
   * Sorts the rows of `range` by column `col`. dir: 'asc' | 'desc' | 'original'
   * (back to the stable row identity). Row 1 of the range is a header when
   * `header`; a trailing totals row stays pinned. With a filter active only
   * visible rows are reordered. One undo step; returns false when nothing moved.
   */
  function* sortRangeSteps(range, col, dir = 'asc', { header = true, pinTotals = true } = {}) {
    const box = normRange(range)
    const start = box.r1 + (header ? 1 : 0)
    let end = box.r2
    if (pinTotals && end > start && isTotalsLabelRow(rowTexts(end, box.c1, box.c2))) end--
    const hidden = hiddenRows(), slots = []
    let lastId = -1, gap = 0
    for (let r = start; r <= end; r++) {
      // Every row in the block gets a stable identity; blank rows slot in after their predecessor.
      const rec = rowsById.get(r)
      if (rec) { lastId = rec.id; gap = 0 } else rowsById.set(r, { id: lastId + (gap += 1e-6), cells: new Map(), styles: new Map() })
      if (!hidden?.has(r)) slots.push(r)
    }
    const factor = dir === 'desc' ? -1 : 1, decorated = []
    for (let i = 0; i < slots.length; i++) {
      const r = slots[i]
      decorated.push({ r, i, k: dir === 'original' ? [0, rowsById.get(r).id, ''] : sortKey(r, col) })
      if ((i + 1) % (CHUNK * 2) === 0) yield
    }
    yield
    decorated.sort((x, y) => {
      const a = x.k, b = y.k
      if (a[0] === 2 || b[0] === 2) return a[0] === b[0] ? x.i - y.i : a[0] === 2 ? 1 : -1
      let d = a[0] - b[0]
      if (!d) d = a[0] === 1 ? (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0) : a[1] - b[1]
      return d ? d * factor : x.i - y.i
    })
    const from = [], to = []
    decorated.forEach((item, i) => { if (item.r !== slots[i]) { from.push(item.r); to.push(slots[i]) } })
    if (!from.length) return false
    yield
    yield* permuteSteps(from, to)
    record({ type: 'permute', from, to })
    changed(true, true)
    return true
  }

  // ── Bulk edits ─────────────────────────────────────────────

  function clampRange(range) {
    const box = normRange(range), used = usedRange()
    if (!used) return box
    if (box.r1 === 0 && box.r2 >= rows - 1) box.r2 = Math.max(used.r2, box.r1)
    if (box.c1 === 0 && box.c2 >= cols - 1) box.c2 = Math.max(used.c2, box.c1)
    return box
  }

  function setCell(r, c, raw) {
    const p = beginPatch()
    writeCell(p, r, c, raw)
    return commit(p)
  }

  /** Writes a matrix of raw values with its top-left at (r, c), as one undo step. */
  function setRange(r, c, matrix) {
    const p = beginPatch()
    rows = Math.max(rows, r + matrix.length)
    matrix.forEach((line, i) => line.forEach((v, j) => { cols = Math.max(cols, c + j + 1); writeCell(p, r + i, c + j, v === null || v === undefined ? null : String(v)) }))
    return commit(p)
  }

  function* clearRangeSteps(range) {
    const { r1, c1, r2, c2 } = clampRange(range), p = beginPatch()
    const targets = r2 - r1 > rowsById.size ? [...rowsById.keys()].filter(r => r >= r1 && r <= r2) : Array.from({ length: r2 - r1 + 1 }, (_, i) => r1 + i)
    for (const r of targets) {
      const rec = rowsById.get(r)
      if (rec) for (const c of [...rec.cells.keys()]) if (c >= c1 && c <= c2) writeCell(p, r, c, null)
      if (p.roots.length >= CHUNK) { recalc(p.roots); p.roots = []; yield }
    }
    return commit(p)
  }

  /**
   * Fill-handle fill from `source` into `target` (which contains it and
   * extends it in one direction). A target inside the source clears the
   * cells it no longer covers. Seeds' styles are copied. One undo step.
   */
  function* fillRangeSteps(source, target) {
    const s = normRange(source), t = normRange(target), p = beginPatch()
    if (t.r1 >= s.r1 && t.r2 <= s.r2 && t.c1 >= s.c1 && t.c2 <= s.c2) {
      for (let r = s.r1; r <= s.r2; r++) for (let c = s.c1; c <= s.c2; c++) if (r > t.r2 || c > t.c2) writeCell(p, r, c, null)
      return commit(p)
    }
    rows = Math.max(rows, t.r2 + 1); cols = Math.max(cols, t.c2 + 1)
    const vertical = t.r1 < s.r1 || t.r2 > s.r2
    const lines = vertical ? [s.c1, s.c2] : [s.r1, s.r2]
    const seedLen = vertical ? s.r2 - s.r1 + 1 : s.c2 - s.c1 + 1
    for (let line = lines[0]; line <= lines[1]; line++) {
      const seeds = [], seedStyles = []
      for (let i = 0; i < seedLen; i++) {
        const r = vertical ? s.r1 + i : line, c = vertical ? line : s.c1 + i
        seeds.push(srcOf(cellAt(r, c))); seedStyles.push(styleAt(r, c) ?? null)
      }
      const at = seriesFor(seeds)
      const [from, to, origin] = vertical ? [t.r1, t.r2, s.r1] : [t.c1, t.c2, s.c1]
      for (let pos = from; pos <= to; pos++) {
        const k = pos - origin
        if (k >= 0 && k < seedLen) continue
        const r = vertical ? pos : line, c = vertical ? line : pos
        writeCell(p, r, c, at(k))
        writeStyle(p, r, c, seedStyles[((k % seedLen) + seedLen) % seedLen])
        if (p.roots.length >= CHUNK) { recalc(p.roots); p.roots = []; yield (pos - from) / (to - from + 1) }
      }
    }
    return commit(p)
  }

  // ── Styles, sizes, freeze ──────────────────────────────────

  /** Merges `patch` into the style of every cell in `range`. One undo step. */
  function setStyle(range, patch) {
    const { r1, c1, r2, c2 } = clampRange(range), p = beginPatch()
    for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) writeStyle(p, r, c, normalizeStyle({ ...styleAt(r, c), ...patch }))
    return commit(p)
  }

  function setColumnWidth(c, w) { const p = beginPatch(); writeWidth(p, c, Math.round(Math.max(30, Math.min(600, w)))); return commit(p) }
  function setRowHeight(r, h) { const p = beginPatch(); writeHeight(p, r, Math.round(Math.max(16, Math.min(200, h)))); return commit(p) }
  function setFrozen(nextRows, nextCols = frozenCols) { const p = beginPatch(); writeFrozen(p, nextRows, nextCols); return commit(p) }

  /** Fits column c to its widest display text; `measure(text, style)` returns pixels. */
  function autoFitColumn(c, measure) {
    let width = 0
    for (const [r, rec] of rowsById) if (rec.cells.has(c)) width = Math.max(width, measure(displayAt(r, c), rec.styles.get(c) ?? {}))
    return setColumnWidth(c, width ? width + 16 : DEFAULT_COL_WIDTH)
  }

  /**
   * Applies a style plan as one undo step: { styles: [[r, c, style|null]],
   * widths: [[c, w]], frozenRows? }. Returns 'APPLIED' or 'NO_CHANGES'.
   */
  function applyStylePlan(plan) {
    const p = beginPatch()
    for (const [r, c, style] of plan.styles ?? []) writeStyle(p, r, c, style ? normalizeStyle(style) : null)
    for (const [c, w] of plan.widths ?? []) writeWidth(p, c, w)
    if (typeof plan.frozenRows === 'number') writeFrozen(p, plan.frozenRows, frozenCols)
    return commit(p) ? 'APPLIED' : 'NO_CHANGES'
  }

  // ── Filters ────────────────────────────────────────────────

  /** filter: { values?: string[] (normalised keys, '' = blanks), op?: 'contains'|'gt'|'lt'|'empty', value? } or null. */
  function setFilter(c, filter) { const p = beginPatch(); writeFilter(p, c, filter); return commit(p) }
  function clearFilters() { const p = beginPatch(); for (const c of [...filters.keys()]) writeFilter(p, c, null); return commit(p) }

  /** Distinct values of column c below the header: [{ key, label, count }], first-seen label. */
  function distinctValues(c) {
    const used = usedRange(), seen = new Map()
    for (let r = 1; used && r <= used.r2; r++) {
      const text = textAt(r, c), key = norm(text), hit = seen.get(key)
      if (hit) hit.count++; else seen.set(key, { key, label: text.trim(), count: 1 })
    }
    return [...seen.values()].sort((a, b) => (a.key === '' ? 1 : b.key === '' ? -1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  }

  // ── Loading ────────────────────────────────────────────────

  /** Replaces the sheet with a matrix of raw values. Clears history. */
  function loadMatrix(matrix) {
    rowsById = new Map(); colWidths = new Map(); filters = new Map(); frozenRows = 0; frozenCols = 0
    tplCache.clear(); undoStack.length = 0; redoStack.length = 0
    let width = 0
    matrix.forEach((line, r) => {
      width = Math.max(width, line.length)
      const rec = rowRec(r)
      line.forEach((v, c) => { if (v !== '' && v !== null && v !== undefined) rec.cells.set(c, makeCell(String(v), r, c)) })
    })
    rows = Math.max(rows, matrix.length + 1); cols = Math.max(cols, width)
    recalc(relinkAll().all)
    changed(true, true)
  }

  return {
    get rows() { return rows },
    get cols() { return cols },
    get version() { return version },
    get layoutVersion() { return layoutVersion },
    get frozenRows() { return frozenRows },
    get frozenCols() { return frozenCols },
    /** Cells visited by the last recalculation (the edited cells plus their dependents). */
    get lastRecalcCount() { return lastRecalcCount },
    getCell,
    getValue: valueAt,
    getText: textAt,
    getDisplay: displayAt,
    getCellStyle: (r, c) => ({ ...styleAt(r, c) }),
    getUsedRange: usedRange,
    getRangeText,
    getColumnWidth: c => colWidths.get(c) ?? DEFAULT_COL_WIDTH,
    getRowHeight: r => rowsById.get(r)?.height ?? DEFAULT_ROW_HEIGHT,
    hasCustomRowHeights: () => { for (const rec of rowsById.values()) if (rec.height !== undefined) return true; return false },
    isRowHidden,
    hiddenRows,
    getFilter: c => filters.get(c) ?? null,
    getFilters: () => new Map(filters),
    distinctValues,
    setCell,
    setRange,
    clearRange: range => drain(clearRangeSteps(range)),
    fillRange: (source, target) => drain(fillRangeSteps(source, target)),
    sortRange: (...args) => drain(sortRangeSteps(...args)),
    // Step generators for the UI to time-slice large operations (same results, same single undo entry).
    clearRangeSteps,
    fillRangeSteps,
    sortRangeSteps,
    undoSteps,
    redoSteps,
    setStyle,
    applyStylePlan,
    setColumnWidth,
    setRowHeight,
    autoFitColumn,
    setFrozen,
    setFilter,
    clearFilters,
    insertRow: insertRows,
    deleteRow: deleteRows,
    insertColumn: insertColumns,
    deleteColumn: deleteColumns,
    loadMatrix,
    undo: () => drain(undoSteps()),
    redo: () => drain(redoSteps()),
    canUndo: () => undoStack.length > 0,
    canRedo: () => redoStack.length > 0,
    undoDepth: () => undoStack.length,
  }
}

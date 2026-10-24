import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import './App.css'
import { createEngine, DEFAULT_ROW_HEIGHT } from './engine/core.js'
import { cellLabel, parseRangeLabel } from './engine/formula.js'
import { toNum } from './engine/values.js'
import { GridView, rangeOf } from './grid/GridView.js'
import FilterMenu from './grid/FilterMenu.jsx'
import Toolbar from './Toolbar.jsx'
import { loadSample } from './fixtures/loadSample.js'

const AiPanel = lazy(() => import('./ai/AiPanel.jsx'))

const SLICE_MS = 24
const nextFrame = () => new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)))
const rangeLabel = r => (r.r1 === r.r2 && r.c1 === r.c2 ? cellLabel(r.r1, r.c1) : `${cellLabel(r.r1, r.c1)}:${cellLabel(r.r2, r.c2)}`)
const cellsIn = r => (r.r2 - r.r1 + 1) * (r.c2 - r.c1 + 1)

export default function App() {
  const [engine] = useState(() => createEngine(100000, 200))
  const viewRef = useRef(null), hostRef = useRef(null), formulaRef = useRef(null), nameRef = useRef(null)
  const sortRef = useRef({ col: -1, dir: '' })
  const [sel, setSel] = useState({ ar: 0, ac: 0, fr: 0, fc: 0 })
  const [, setTick] = useState(0)
  const [busy, setBusy] = useState(null)
  const [toast, setToast] = useState(null)
  const [aiOpen, setAiOpen] = useState(false)
  const [filterMenu, setFilterMenu] = useState(null)
  const [summary, setSummary] = useState('')

  const notify = useCallback((message, kind = 'info') => setToast({ message, kind, id: Date.now() }), [])
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 3500); return () => clearTimeout(t) }, [toast])

  /** Runs an engine mutation, then repaints the grid and the chrome once. */
  const mutate = useCallback(fn => {
    const result = fn()
    viewRef.current?.refresh()
    setTick(t => t + 1)
    return result
  }, [])

  /**
   * Runs an engine step generator time-sliced: small jobs finish inside the
   * first slice with no visible state; large ones show progress, yield to the
   * browser every ~24 ms and block input until done (one undo entry either way).
   */
  const busyRef = useRef(false)
  const runJob = useCallback(async (label, steps) => {
    if (busyRef.current) return false
    busyRef.current = true
    let next = steps.next(), sliceStart = performance.now(), shown = false
    try {
      while (!next.done) {
        if (performance.now() - sliceStart > SLICE_MS) {
          const pct = typeof next.value === 'number' ? ` ${Math.round(next.value * 100)}%` : ''
          setBusy(`${label}${pct}`); shown = true
          await nextFrame()
          sliceStart = performance.now()
        }
        next = steps.next()
      }
    } finally {
      busyRef.current = false
      if (shown) setBusy(null)
      viewRef.current?.refresh()
      setTick(t => t + 1)
    }
    return next.value
  }, [])

  /** Short mutations that are always small (style of a range, sizes, filters). */
  const guarded = useCallback(fn => (busyRef.current ? false : mutate(fn)), [mutate])

  const resetSortCycle = () => { sortRef.current = { col: -1, dir: '' } }
  const undo = useCallback(() => { resetSortCycle(); return runJob('Undoing…', engine.undoSteps()) }, [engine, runJob])
  const redo = useCallback(() => { resetSortCycle(); return runJob('Redoing…', engine.redoSteps()) }, [engine, runJob])

  const selectRange = useCallback((range, active = { r: range.r1, c: range.c1 }) => {
    const view = viewRef.current
    view.select({ ar: active.r, ac: active.c, fr: active.r === range.r1 ? range.r2 : range.r1, fc: active.c === range.c1 ? range.c2 : range.c1 })
    view.scrollIntoView(active.r, active.c, true)
  }, [])

  const fill = useCallback((source, target) => runJob('Filling…', engine.fillRangeSteps(source, target)), [runJob, engine])

  const sortColumn = useCallback(async (col, forced) => {
    const prev = sortRef.current
    const dir = forced ?? (prev.col !== col ? 'asc' : prev.dir === 'asc' ? 'desc' : prev.dir === 'desc' ? 'original' : 'asc')
    const s = rangeOf(viewRef.current.sel), used = engine.getUsedRange()
    if (!used) return notify('Nothing to sort yet')
    const explicit = s.r2 > s.r1 && !(s.r1 === 0 && s.r2 >= engine.rows - 1)
    const range = explicit ? { r1: s.r1, c1: 0, r2: s.r2, c2: used.c2 } : used
    sortRef.current = { col, dir: dir === 'original' ? '' : dir }
    const label = dir === 'original' ? 'Restoring original order…' : 'Sorting…'
    await runJob(label, engine.sortRangeSteps(range, col, dir, { header: !explicit || s.r1 === 0 }))
  }, [runJob, engine, notify])

  const handlers = useRef(null)
  handlers.current = { fill, sortColumn, undo, redo, notify, mutate, runJob }

  // Mount the imperative grid once.
  useEffect(() => {
    const h = () => handlers.current
    const view = new GridView(hostRef.current, engine, {
      onSelect: s => setSel({ ...s }),
      onCommit: (r, c, text) => h().mutate(() => engine.setCell(r, c, text)),
      onMove: (dr, dc) => { const s = view.sel, r = s.ar + dr, c = s.ac + dc; view.select({ ar: r, ac: c, fr: r, fc: c }); view.scrollIntoView(view.sel.ar, view.sel.ac, true) },
      onFill: (source, target) => h().fill(source, target),
      onResizeColumn: (c, w) => h().mutate(() => engine.setColumnWidth(c, w)),
      onResizeRow: (r, height) => h().mutate(() => engine.setRowHeight(r, height ?? DEFAULT_ROW_HEIGHT)),
      onAutoFit: c => h().mutate(() => engine.autoFitColumn(c, (t, s) => view.measure(t, s))),
      onFilterMenu: (col, at) => setFilterMenu({ col, at }),
      onSortClick: col => h().sortColumn(col),
      sortState: c => (sortRef.current.col === c ? sortRef.current.dir : ''),
      onEditInput: text => { if (formulaRef.current && document.activeElement !== formulaRef.current) formulaRef.current.value = text ?? engine.getCell(view.sel.ar, view.sel.ac).raw },
      isFormulaBar: node => node === formulaRef.current,
      onKeyDown: e => { if (busyRef.current) e.preventDefault(); else keyDown(e, view) },
      isBusy: () => busyRef.current,
    })
    viewRef.current = view
    if (import.meta.env.VITE_MEASURE === '1') window.__sheet = { engine, view }
    return () => view.destroy()
    // keyDown reads everything through refs, so the grid mounts exactly once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine])

  function keyDown(e, view) {
    const s = view.sel, mod = e.ctrlKey || e.metaKey, key = e.key
    const move = (dr, dc, extend) => {
      let r = (extend ? s.fr : s.ar) + dr
      const c = (extend ? s.fc : s.ac) + dc
      if (dr) while (r > 0 && r < engine.rows - 1 && engine.isRowHidden(r)) r += Math.sign(dr)
      if (extend) view.select({ ...s, fr: r, fc: c }); else view.select({ ar: r, ac: c, fr: r, fc: c })
      view.scrollIntoView(extend ? view.sel.fr : view.sel.ar, extend ? view.sel.fc : view.sel.ac, true)
    }
    const arrows = { ArrowDown: [1, 0], ArrowUp: [-1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }
    if (arrows[key]) {
      e.preventDefault()
      const [dr, dc] = arrows[key]
      if (mod) {
        const used = engine.getUsedRange() ?? { r2: 0, c2: 0 }
        const r = dr > 0 ? used.r2 : dr < 0 ? 0 : (e.shiftKey ? s.fr : s.ar), c = dc > 0 ? used.c2 : dc < 0 ? 0 : (e.shiftKey ? s.fc : s.ac)
        if (e.shiftKey) view.select({ ...s, fr: r, fc: c }); else view.select({ ar: r, ac: c, fr: r, fc: c })
        view.scrollIntoView(r, c, true)
      } else move(dr, dc, e.shiftKey)
      return
    }
    if (key === 'PageDown' || key === 'PageUp') { e.preventDefault(); move((key === 'PageDown' ? 1 : -1) * view.pageRows(), 0, e.shiftKey); return }
    if (key === 'Home' && mod) { e.preventDefault(); view.select({ ar: 0, ac: 0, fr: 0, fc: 0 }); view.scrollIntoView(0, 0, true); return }
    if (key === 'End' && mod) {
      e.preventDefault()
      const used = engine.getUsedRange() ?? { r2: 0, c2: 0 }
      view.select({ ar: used.r2, ac: used.c2, fr: used.r2, fc: used.c2 }); view.scrollIntoView(used.r2, used.c2); return
    }
    if (key === 'Home') { e.preventDefault(); view.select({ ar: s.ar, ac: 0, fr: s.ar, fc: 0 }); view.scrollIntoView(s.ar, 0, true); return }
    if (key === 'Tab') { e.preventDefault(); move(0, e.shiftKey ? -1 : 1, false); return }
    if (key === 'Enter' || key === 'F2') { e.preventDefault(); view.startEdit(); return }
    if (key === 'Delete' || key === 'Backspace') {
      e.preventDefault()
      const r = rangeOf(s)
      handlers.current.runJob('Clearing…', engine.clearRangeSteps(r))
      return
    }
    if (mod) {
      const k = key.toLowerCase()
      if (k === 'a') { e.preventDefault(); const used = engine.getUsedRange(); if (used) view.select({ ar: 0, ac: 0, fr: used.r2, fc: used.c2 }); return }
      if (k === 'd' || k === 'r') {
        e.preventDefault()
        const r = rangeOf(s), source = k === 'd' ? { ...r, r2: r.r1 } : { ...r, c2: r.c1 }
        if (cellsIn(r) > 1) handlers.current.fill(source, r)
        return
      }
      if (k === 'b' || k === 'i' || k === 'u') {
        e.preventDefault()
        const prop = { b: 'bold', i: 'italic', u: 'underline' }[k]
        handlers.current.mutate(() => engine.setStyle(rangeOf(s), { [prop]: !engine.getCellStyle(s.ar, s.ac)[prop] }))
        return
      }
      return
    }
    if (key.length === 1 && !e.altKey) { e.preventDefault(); view.startEdit(key) }
  }

  // Global shortcuts: Ctrl+K (AI panel), Ctrl+Z / Ctrl+Y (undo/redo) outside text inputs.
  useEffect(() => {
    const onKey = e => {
      const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase()
      if (mod && k === 'k') { e.preventDefault(); setAiOpen(open => !open); return }
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? '')
      if (!mod || typing) return
      if (k === 'z') { e.preventDefault(); if (e.shiftKey) handlers.current.redo(); else handlers.current.undo() }
      else if (k === 'y') { e.preventDefault(); handlers.current.redo() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Formula bar and name box follow the active cell (uncontrolled inputs, no per-keystroke state).
  useEffect(() => {
    const view = viewRef.current
    if (formulaRef.current && !view?.editing) formulaRef.current.value = engine.getCell(sel.ar, sel.ac).raw
    if (nameRef.current && document.activeElement !== nameRef.current) nameRef.current.value = rangeLabel(rangeOf(sel))
  })

  // Selection summary is computed after paint so it never delays input.
  useEffect(() => {
    const id = setTimeout(() => {
      const r = rangeOf(sel), used = engine.getUsedRange()
      if (!used || cellsIn(r) < 2) return setSummary('')
      const r2 = Math.min(r.r2, used.r2), c2 = Math.min(r.c2, used.c2)
      let count = 0, nums = 0, sum = 0
      for (let row = r.r1; row <= r2; row++) {
        if (engine.isRowHidden(row)) continue
        for (let c = r.c1; c <= c2; c++) {
          const v = engine.getValue(row, c)
          if (v === '') continue
          count++
          const n = typeof v === 'number' ? v : toNum(v)
          if (n !== null && typeof v !== 'object') { nums++; sum += n }
        }
      }
      setSummary(count ? `Count ${count.toLocaleString('en-US')}${nums ? ` · Sum ${parseFloat(sum.toFixed(2)).toLocaleString('en-US')} · Average ${parseFloat((sum / nums).toFixed(2)).toLocaleString('en-US')}` : ''}` : '')
    }, 60)
    return () => clearTimeout(id)
  }, [sel, engine, busy])

  const load = async which => {
    setBusy('Loading sample…')
    try {
      const rows = await loadSample(which)
      await nextFrame()
      mutate(() => engine.loadMatrix(rows))
      resetSortCycle()
      viewRef.current.select({ ar: 0, ac: 0, fr: 0, fc: 0 })
      viewRef.current.scrollIntoView(0, 0, true)
      notify(`Loaded ${rows.length.toLocaleString('en-US')} rows`)
    } catch (error) {
      notify(`Could not load the sample: ${error.message}`, 'error')
    } finally {
      setBusy(null)
      viewRef.current?.focus()
    }
  }

  const jumpTo = text => {
    const range = parseRangeLabel(text.trim())
    if (!range || range.r2 >= engine.rows || range.c2 >= engine.cols) { notify(`"${text}" is not a cell or range`, 'error'); return }
    selectRange(range)
    viewRef.current.focus()
  }

  const range = rangeOf(sel)
  const style = engine.getCellStyle(sel.ar, sel.ac)
  const used = engine.getUsedRange()
  const hidden = engine.hiddenRows()
  const dataRows = used ? used.r2 : 0
  const empty = !used

  const actions = {
    undo, redo,
    canUndo: engine.canUndo(), canRedo: engine.canRedo(),
    style,
    setStyle: patch => guarded(() => engine.setStyle(range, patch)),
    insertRow: () => guarded(() => engine.insertRow(range.r1)),
    // A whole-column selection deletes only the active row (never the entire sheet), and vice versa.
    deleteRow: () => guarded(() => (viewRef.current.isFullColumns() ? engine.deleteRow(sel.ar) : engine.deleteRow(range.r1, range.r2 - range.r1 + 1))),
    insertColumn: () => guarded(() => engine.insertColumn(range.c1)),
    deleteColumn: () => guarded(() => (viewRef.current.isFullRows() ? engine.deleteColumn(sel.ac) : engine.deleteColumn(range.c1, range.c2 - range.c1 + 1))),
    frozenRows: engine.frozenRows, frozenCols: engine.frozenCols,
    toggleFreezeRow: () => mutate(() => engine.setFrozen(engine.frozenRows ? 0 : 1, engine.frozenCols)),
    toggleFreezeCol: () => mutate(() => engine.setFrozen(engine.frozenRows, engine.frozenCols ? 0 : 1)),
    hasFilters: !!hidden || engine.getFilters().size > 0,
    clearFilters: () => mutate(() => engine.clearFilters()),
    loadSmall: () => load('small'), loadLarge: () => load('large'),
    openAi: () => setAiOpen(true),
    busy: !!busy,
  }

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand"><span className="brand-mark" aria-hidden="true">▦</span> Sheets</div>
        <Toolbar {...actions} />
      </header>
      <div className="formula-bar">
        <input ref={nameRef} className="name-box" aria-label="Name box" defaultValue="A1" spellCheck={false}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); jumpTo(e.currentTarget.value) } else if (e.key === 'Escape') { e.currentTarget.value = rangeLabel(range); viewRef.current.focus() } }}
          onFocus={e => e.currentTarget.select()} />
        <span className="fx" aria-hidden="true">fx</span>
        <input ref={formulaRef} className="formula-bar-input" aria-label="Formula bar" spellCheck={false} placeholder="Enter a value or a formula such as =SUM(J2:J32)"
          onFocus={e => viewRef.current.setEditText(e.currentTarget.value)}
          onInput={e => viewRef.current.setEditText(e.currentTarget.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') { e.preventDefault(); viewRef.current.commitEdit(1, 0) }
            else if (e.key === 'Tab') { e.preventDefault(); viewRef.current.commitEdit(0, 1) }
            else if (e.key === 'Escape') { e.preventDefault(); viewRef.current.cancelEdit(); e.currentTarget.value = engine.getCell(sel.ar, sel.ac).raw }
          }}
          onBlur={e => { if (viewRef.current.editing && e.relatedTarget !== viewRef.current.editor) viewRef.current.commitEdit(0, 0) }} />
      </div>
      <main className="workspace">
        <div className="grid-wrap">
          <div ref={hostRef} className="grid-root" />
          {empty && !busy && (
            <div className="empty-state">
              <p className="empty-title">This sheet is empty</p>
              <p>Start typing, or load sample data</p>
              <div className="empty-actions">
                <button type="button" className="btn primary" onClick={actions.loadSmall}>Load sales.tsv (33 rows)</button>
                <button type="button" className="btn" onClick={actions.loadLarge}>Load sales-large.tsv (3k rows)</button>
              </div>
            </div>
          )}
          {busy && <div className="busy" role="status"><span className="spinner" aria-hidden="true" />{busy}</div>}
        </div>
        {aiOpen && (
          <Suspense fallback={<aside className="ai-panel ai-loading">Loading assistant…</aside>}>
            <AiPanel engine={engine} view={viewRef.current} selection={rangeLabel(range)} onClose={() => { setAiOpen(false); viewRef.current.focus() }}
              onChange={() => { viewRef.current.refresh(); setTick(t => t + 1) }} />
          </Suspense>
        )}
      </main>
      <footer className="status-bar">
        <span>{busy ?? 'Ready'}</span>
        {hidden && <span className="status-filter">{(dataRows - hidden.size).toLocaleString('en-US')} of {dataRows.toLocaleString('en-US')} rows</span>}
        <span className="status-spacer" />
        {summary && <span>{summary}</span>}
        <span className="status-muted">{rangeLabel(range)}</span>
      </footer>
      {filterMenu && (
        <FilterMenu engine={engine} col={filterMenu.col} at={filterMenu.at}
          onClose={() => { setFilterMenu(null); viewRef.current.focus() }}
          onApply={filter => { mutate(() => engine.setFilter(filterMenu.col, filter)); setFilterMenu(null); viewRef.current.focus() }}
          onSort={dir => { sortColumn(filterMenu.col, dir); setFilterMenu(null) }} />
      )}
      {toast && <div className={`toast ${toast.kind}`} role="alert">{toast.message}</div>}
    </div>
  )
}

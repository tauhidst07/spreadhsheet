import { useState, useRef, useEffect, useReducer, useSyncExternalStore } from 'react'
import './App.css'
import { createEngine } from './engine/core.js'
import { cellLabel, rangeLabel, parseRangeLabel } from './engine/refs.js'
import { toNum } from './engine/values.js'
import { sampleSmallText, sampleLargeText, loadTsv, parseTsv } from './fixtures/loadSample.js'
import Grid from './grid/Grid.jsx'
import { selectionRange } from './grid/selection.js'
import FilterMenu from './grid/FilterMenu.jsx'
import AiPanel from './ui/AiPanel.jsx'
import { createEditStore } from './grid/editStore.js'
import { measureText } from './grid/measure.js'
import { perfStats, subscribePerf, installKeyLatencyProbe, resetKeyStats } from './ui/perfStats.js'
import { executeQuery } from './ai/executor.js'
import { readTable } from './ai/sheet.js'
import { planFormat, applyFormat } from './ai/formatApplier.js'

const TOTAL_ROWS = 100000
const TOTAL_COLS = 200
const STATS_LIMIT = 20000

const FILLS = [
    ['white', 'White'], ['#ffff99', 'Yellow'], ['#99ffcc', 'Green'], ['#ffcccc', 'Red'],
    ['#cce5ff', 'Blue'], ['#e0ccff', 'Purple'], ['#ffd9b3', 'Orange'], ['#f0f0f0', 'Gray'],
]
const NUMBER_FORMATS = [['general', 'General'], ['number', '1,200.00'], ['currency', '$1,200.00'], ['percent', '10%'], ['date', '2024-01-15']]

/** Runs fn and reports how long it took (event handlers only, never during render). */
function timeIt(fn) {
    const t0 = performance.now()
    const result = fn()
    return { result, ms: performance.now() - t0 }
}

const isTextInput = (el) => el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)

function FormulaBar({ editStore, editing, value, onFocus, onKey, onBlur }) {
    const text = useSyncExternalStore(editStore.subscribe, editStore.get)
    return (
        <input
            className="formula-bar-input"
            data-formula-bar
            value={editing ? text : value}
            spellCheck={false}
            onFocus={onFocus}
            onChange={(e) => editStore.set(e.target.value)}
            onKeyDown={onKey}
            onBlur={onBlur}
            placeholder="Select a cell, then type a value or a formula like =SUM(A1:A5)"
        />
    )
}

/** Status-bar readout: grid commits and keystroke → next-frame latency. */
function PerfReadout() {
    const [, force] = useReducer(v => v + 1, 0)
    useEffect(() => subscribePerf(force), [])
    useEffect(() => installKeyLatencyProbe(), [])
    const { gridCommits, lastKeyMs, maxKeyMs, keyCount } = perfStats
    return (
        <span className="perf" title="Grid commits since load; keystroke → next animation frame (last / max over the keys typed since reset)">
            grid renders {gridCommits}
            {lastKeyMs !== null && <> · key→frame {lastKeyMs.toFixed(1)} ms (max {maxKeyMs.toFixed(1)}, {keyCount} keys)
                <button type="button" className="link" onClick={resetKeyStats}>reset</button></>}
        </span>
    )
}

export default function App() {
    const [engine] = useState(() => createEngine(TOTAL_ROWS, TOTAL_COLS))
    const [editStore] = useState(createEditStore)
    const [, bump] = useReducer(v => v + 1, 0)
    const [selection, setSelection] = useState({ anchor: { r: 0, c: 0 }, head: { r: 0, c: 0 } })
    const [editing, setEditing] = useState(null)
    const [filterMenu, setFilterMenu] = useState(null)
    const [aiOpen, setAiOpen] = useState(false)
    const [status, setStatus] = useState('Ready')
    const [nameBox, setNameBox] = useState(null)
    const gridApi = useRef(null)
    const editingRef = useRef(null)

    const sel = selectionRange(selection)
    const active = selection.anchor
    const activeStyle = engine.getStyle(active.r, active.c)

    const timed = (label, fn) => {
        const { result, ms } = timeIt(fn)
        setStatus(typeof label === 'function' ? label(result, ms) : `${label} in ${ms.toFixed(1)} ms`)
        bump()
        return result
    }

    const select = (next) => {
        const clamp = (p) => ({ r: Math.max(0, Math.min(engine.rows - 1, p.r)), c: Math.max(0, Math.min(engine.cols - 1, p.c)) })
        setSelection({ anchor: clamp(next.anchor), head: clamp(next.head) })
    }

    const selectAndShow = (r1, c1, r2 = r1, c2 = c1) => {
        select({ anchor: { r: r1, c: c1 }, head: { r: r2, c: c2 } })
        gridApi.current?.scrollIntoView(r2, c2)
        gridApi.current?.scrollIntoView(r1, c1)
    }

    /** A whole-row/whole-column selection should not narrow sort to "the selection". */
    const blockSelection = () => {
        const full = (sel.r1 === 0 && sel.r2 === engine.rows - 1) || (sel.c1 === 0 && sel.c2 === engine.cols - 1)
        return !full && sel.r2 > sel.r1 ? sel : null
    }

    // ── Editing ──

    const startEdit = (text, mode, source = 'cell') => {
        const { r, c } = selection.anchor
        editStore.set(text ?? engine.getCell(r, c).raw)
        editingRef.current = { r, c, mode, source }
        setEditing({ r, c, mode, source })
    }

    const commitEdit = (move) => {
        const ed = editingRef.current
        if (!ed) return
        editingRef.current = null
        const value = editStore.get()
        timed('Saved', () => engine.setCell(ed.r, ed.c, value))
        setEditing(null)
        if (move) {
            let r = ed.r + move[0]
            while (move[0] && r > 0 && r < engine.rows - 1 && engine.isRowHidden(r)) r += move[0]
            const c = ed.c + move[1]
            selectAndShow(Math.max(0, Math.min(engine.rows - 1, r)), Math.max(0, Math.min(engine.cols - 1, c)))
        }
        gridApi.current?.focus()
    }

    const cancelEdit = () => {
        editingRef.current = null
        setEditing(null)
        gridApi.current?.focus()
    }

    const blurEdit = (next) => {
        if (next && next.closest?.('[data-formula-bar], .cell-editor')) return
        commitEdit(null)
    }

    // ── Commands ──

    const undo = () => { cancelIfEditing(); timed((ok, ms) => (ok ? `Undo in ${ms.toFixed(1)} ms` : 'Nothing to undo'), () => engine.undo()) }
    const redo = () => { cancelIfEditing(); timed((ok, ms) => (ok ? `Redo in ${ms.toFixed(1)} ms` : 'Nothing to redo'), () => engine.redo()) }
    const cancelIfEditing = () => { if (editingRef.current) { editingRef.current = null; setEditing(null) } }

    const applyStyle = (patch) => timed('Formatted', () => engine.setStyle(sel, patch))
    const toggleStyle = (prop) => applyStyle({ [prop]: !activeStyle[prop] })

    const clearSelection = () => timed((n, ms) => `Cleared ${n} cells in ${ms.toFixed(1)} ms`, () => engine.clearRange(sel))

    const fill = (src, dest) => {
        if (dest.r1 === src.r1 && dest.r2 === src.r2 && dest.c1 === src.c1 && dest.c2 === src.c2) return
        const shrinking = dest.r2 < src.r2 || dest.c2 < src.c2
        if (shrinking) {
            const removed = dest.r2 < src.r2 ? { ...src, r1: dest.r2 + 1 } : { ...src, c1: dest.c2 + 1 }
            timed((n, ms) => `Shrunk fill: cleared ${n} cells in ${ms.toFixed(1)} ms`, () => engine.clearRange(removed, { styles: true }))
        } else {
            timed((n, ms) => `Filled ${n.toLocaleString()} cells in ${ms.toFixed(1)} ms`, () => engine.fill(src, dest))
        }
        select({ anchor: { r: dest.r1, c: dest.c1 }, head: { r: dest.r2, c: dest.c2 } })
    }

    const fillShortcut = (dir) => {
        if (dir === 'down') {
            if (sel.r1 === sel.r2) { if (sel.r1 > 0) fill({ ...sel, r1: sel.r1 - 1, r2: sel.r1 - 1 }, { ...sel, r1: sel.r1 - 1 }) }
            else fill({ ...sel, r2: sel.r1 }, sel)
        } else if (sel.c1 === sel.c2) { if (sel.c1 > 0) fill({ ...sel, c1: sel.c1 - 1, c2: sel.c1 - 1 }, { ...sel, c1: sel.c1 - 1 }) }
        else fill({ ...sel, c2: sel.c1 }, sel)
    }

    const sort = (col, dir = null) => {
        setFilterMenu(null)
        timed((res, ms) => (res ? `Sorted ${res.rows.toLocaleString()} rows by ${cellLabel(0, col).replace(/\d+$/, '')} (${res.dir ?? dir}) in ${ms.toFixed(1)} ms` : 'Nothing to sort'),
            () => {
                if (!dir) return engine.cycleSort(col, blockSelection())
                const res = engine.sortBy(col, dir, blockSelection())
                return res && { ...res, dir }
            })
    }

    const applyFilter = (col, filter) => {
        setFilterMenu(null)
        timed((_, ms) => {
            const s = engine.filterStatus()
            return s.active ? `Filter: ${s.visible} of ${s.total} rows (${ms.toFixed(1)} ms)` : 'Filter cleared'
        }, () => engine.setFilter(col, filter))
    }

    const copy = (e) => {
        if (editingRef.current) return
        e.preventDefault()
        const used = engine.getUsedRange()
        const r2 = Math.min(sel.r2, used ? used.r2 : sel.r1)
        const c2 = Math.min(sel.c2, used ? used.c2 : sel.c1)
        const lines = []
        for (let r = sel.r1; r <= r2; r++) {
            const row = []
            for (let c = sel.c1; c <= c2; c++) row.push(engine.getCell(r, c).raw)
            lines.push(row.join('\t'))
        }
        e.clipboardData.setData('text/plain', lines.join('\n'))
        setStatus(`Copied ${rangeLabel({ r1: sel.r1, c1: sel.c1, r2, c2 })}`)
    }

    const paste = (e) => {
        if (editingRef.current) return
        e.preventDefault()
        const matrix = parseTsv(e.clipboardData.getData('text/plain'))
        if (!matrix.length) return
        timed((n, ms) => `Pasted ${n} cells in ${ms.toFixed(1)} ms`, () => engine.setRange(active.r, active.c, matrix, 'Paste'))
        const w = Math.max(...matrix.map(r => r.length))
        select({ anchor: active, head: { r: active.r + matrix.length - 1, c: active.c + w - 1 } })
    }

    const structural = (kind) => {
        const fullRows = sel.c1 === 0 && sel.c2 === engine.cols - 1
        const fullCols = sel.r1 === 0 && sel.r2 === engine.rows - 1
        const nRows = fullRows ? sel.r2 - sel.r1 + 1 : 1
        const nCols = fullCols ? sel.c2 - sel.c1 + 1 : 1
        timed(`${kind}`, () => {
            if (kind === 'Insert row') engine.insertRow(sel.r1, nRows)
            if (kind === 'Delete row') engine.deleteRow(sel.r1, nRows)
            if (kind === 'Insert column') engine.insertColumn(sel.c1, nCols)
            if (kind === 'Delete column') engine.deleteColumn(sel.c1, nCols)
        })
    }

    const loadSample = async (getText, label) => {
        cancelIfEditing()
        const text = await getText()
        timed((res, ms) => `Loaded ${label}: ${res.rows.toLocaleString()} rows in ${ms.toFixed(1)} ms`, () => loadTsv(engine, text))
        selectAndShow(0, 0)
    }

    const jumpTo = (text) => {
        const rg = parseRangeLabel(text)
        if (!rg || rg.r2 >= engine.rows || rg.c2 >= engine.cols) { setStatus(`“${text}” is not a cell or range on this sheet`); return false }
        selectAndShow(rg.r1, rg.c1, rg.r2, rg.c2)
        gridApi.current?.focus()
        return true
    }

    const actions = {
        select, startEdit, commitEdit, cancelEdit, blurEdit, clearSelection, fill, fillShortcut, toggleStyle, copy, paste, sort,
        resizeColumn: (c, w) => timed(`Column ${cellLabel(0, c).replace(/\d+$/, '')} set to ${Math.round(w)} px`, () => engine.setColWidth(c, w)),
        resizeRow: (r, h) => timed(`Row ${r + 1} set to ${Math.round(h)} px`, () => engine.setRowHeight(r, h)),
        autoFit: (c) => timed(`Auto-fit column ${cellLabel(0, c).replace(/\d+$/, '')}`, () => engine.autoFitColumn(c, measureText)),
        openFilter: (col, rect) => setFilterMenu({ col, rect }),
    }

    // `?perf` exposes the engine to scripts/perf.mjs (production build measurements).
    useEffect(() => {
        if (new URLSearchParams(window.location.search).has('perf')) {
            window.__sheet = { engine, refresh: bump, perfStats, ai: { executeQuery, readTable, planFormat, applyFormat, measureText } }
        }
    }, [engine])

    // Global shortcuts: undo/redo when no text field has focus, Ctrl+K anywhere.
    const shortcuts = useRef(null)
    useEffect(() => { shortcuts.current = { undo, redo, toggleAi: () => setAiOpen(o => !o) } })
    useEffect(() => {
        const onKey = (e) => {
            const mod = e.ctrlKey || e.metaKey
            if (!mod) return
            const k = e.key.toLowerCase()
            if (k === 'k') { e.preventDefault(); shortcuts.current.toggleAi(); return }
            if (isTextInput(e.target)) return
            if (k === 'z' && !e.shiftKey) { e.preventDefault(); shortcuts.current.undo() }
            else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); shortcuts.current.redo() }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [])

    // ── Derived display ──

    const filter = engine.filterStatus()
    const sortState = engine.getSortState()
    const cellCount = (sel.r2 - sel.r1 + 1) * (sel.c2 - sel.c1 + 1)
    let stats = null
    if (cellCount > 1 && cellCount <= STATS_LIMIT) {
        let sum = 0, count = 0, filled = 0
        for (let r = sel.r1; r <= sel.r2; r++) {
            if (engine.isRowHidden(r)) continue
            for (let c = sel.c1; c <= sel.c2; c++) {
                const t = engine.getText(r, c)
                if (t === '') continue
                filled++
                const n = toNum(t)
                if (n !== null) { sum += n; count++ }
            }
        }
        stats = { sum, count, filled }
    }
    const nameBoxValue = nameBox ?? (cellCount > 1 ? rangeLabel(sel) : cellLabel(active.r, active.c))
    const formulaValue = engine.getCell(active.r, active.c).raw

    return (
        <div className="app">
            <header className="toolbar">
                <div className="tb-group">
                    <button type="button" className={`tb-btn bold ${activeStyle.bold ? 'on' : ''}`} onClick={() => toggleStyle('bold')} title="Bold (Ctrl+B)">B</button>
                    <button type="button" className={`tb-btn italic ${activeStyle.italic ? 'on' : ''}`} onClick={() => toggleStyle('italic')} title="Italic (Ctrl+I)">I</button>
                    <button type="button" className={`tb-btn underline ${activeStyle.underline ? 'on' : ''}`} onClick={() => toggleStyle('underline')} title="Underline (Ctrl+U)">U</button>
                    <select className="tb-select" value={activeStyle.fontSize} onChange={(e) => applyStyle({ fontSize: parseInt(e.target.value, 10) })} title="Font size">
                        {[8, 10, 11, 12, 13, 14, 16, 18, 20, 24].map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                </div>
                <div className="tb-group">
                    {['left', 'center', 'right'].map(a => (
                        <button type="button" key={a} className={`tb-btn ${activeStyle.align === a ? 'on' : ''}`} onClick={() => applyStyle({ align: a })} title={`Align ${a}`}>
                            {a === 'left' ? '⇤' : a === 'center' ? '↔' : '⇥'}
                        </button>
                    ))}
                    <input type="color" className="tb-color" value={activeStyle.color} onChange={(e) => applyStyle({ color: e.target.value })} title="Text colour" />
                    <select className="tb-select" value={activeStyle.bg} onChange={(e) => applyStyle({ bg: e.target.value })} title="Fill colour">
                        {FILLS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                    <select className="tb-select" value={activeStyle.numberFormat} onChange={(e) => applyStyle({ numberFormat: e.target.value })} title="Number format">
                        {NUMBER_FORMATS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                </div>
                <div className="tb-group">
                    <button type="button" className="tb-btn" onClick={undo} disabled={!engine.canUndo()} title={`Undo ${engine.undoLabel() ?? ''} (Ctrl+Z)`}>↶ Undo</button>
                    <button type="button" className="tb-btn" onClick={redo} disabled={!engine.canRedo()} title={`Redo ${engine.redoLabel() ?? ''} (Ctrl+Shift+Z)`}>↷ Redo</button>
                </div>
                <div className="tb-group">
                    <button type="button" className="tb-btn" onClick={() => structural('Insert row')} title="Insert row(s) above">+ Row</button>
                    <button type="button" className="tb-btn" onClick={() => structural('Delete row')} title="Delete selected row(s)">− Row</button>
                    <button type="button" className="tb-btn" onClick={() => structural('Insert column')} title="Insert column(s) to the left">+ Col</button>
                    <button type="button" className="tb-btn" onClick={() => structural('Delete column')} title="Delete selected column(s)">− Col</button>
                </div>
                <div className="tb-group">
                    <button type="button" className={`tb-btn ${engine.frozenRows ? 'on' : ''}`} onClick={() => timed('Freeze rows', () => engine.setFrozen(engine.frozenRows ? 0 : 1, engine.frozenCols))} title="Freeze the first row">❄ Row 1</button>
                    <button type="button" className={`tb-btn ${engine.frozenCols ? 'on' : ''}`} onClick={() => timed('Freeze columns', () => engine.setFrozen(engine.frozenRows, engine.frozenCols ? 0 : 1))} title="Freeze the first column">❄ Col A</button>
                </div>
                <div className="tb-group">
                    <button type="button" className="tb-btn" onClick={() => loadSample(sampleSmallText, 'sales.tsv')} title="Load fixtures/sales.tsv (33 rows) at A1">⬇ Sample 33</button>
                    <button type="button" className="tb-btn" onClick={() => loadSample(sampleLargeText, 'sales-large.tsv')} title="Load fixtures/sales-large.tsv (~3,000 rows) at A1">⬇ Sample 3k</button>
                    <button type="button" className="tb-btn danger" onClick={() => timed('Cleared sheet', () => engine.clearAll())} title="Clear every cell (undoable)">✕ All</button>
                </div>
                <div className="tb-group tb-right">
                    <button type="button" className={`tb-btn ai ${aiOpen ? 'on' : ''}`} onClick={() => setAiOpen(o => !o)} title="Ask your data / format with AI (Ctrl+K)">✦ AI <kbd>Ctrl K</kbd></button>
                </div>
            </header>

            <div className="formula-bar">
                <input
                    className="name-box"
                    value={nameBoxValue}
                    onFocus={(e) => { setNameBox(nameBoxValue); e.target.select() }}
                    onChange={(e) => setNameBox(e.target.value)}
                    onBlur={() => setNameBox(null)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') { if (jumpTo(e.currentTarget.value)) setNameBox(null) }
                        if (e.key === 'Escape') { setNameBox(null); gridApi.current?.focus() }
                    }}
                    aria-label="Name box"
                    title="Type a cell or range (e.g. AZ5000) and press Enter"
                />
                <span className="fx">fx</span>
                <FormulaBar
                    editStore={editStore}
                    editing={!!editing}
                    value={formulaValue}
                    onFocus={() => { if (!editingRef.current) startEdit(null, 'edit', 'bar') }}
                    onKey={(e) => {
                        if (e.key === 'Enter') { e.preventDefault(); commitEdit([1, 0]) }
                        else if (e.key === 'Tab') { e.preventDefault(); commitEdit([0, 1]) }
                        else if (e.key === 'Escape') { e.preventDefault(); cancelEdit() }
                    }}
                    onBlur={(e) => blurEdit(e.relatedTarget)}
                />
            </div>

            <div className="workspace">
                <Grid
                    engine={engine}
                    selection={selection}
                    editing={editing}
                    editStore={editStore}
                    actions={actions}
                    apiRef={gridApi}
                    filterCols={filter.columns}
                    sortState={sortState}
                />
                {aiOpen && (
                    <AiPanel
                        engine={engine}
                        selection={cellCount > 1 ? sel : null}
                        onSheetChanged={(msg) => { setStatus(msg); bump() }}
                        onClose={() => { setAiOpen(false); gridApi.current?.focus() }}
                    />
                )}
            </div>

            <footer className="status-bar">
                <span>{cellCount > 1 ? `${rangeLabel(sel)} · ${cellCount.toLocaleString()} cells` : cellLabel(active.r, active.c)}</span>
                {stats && stats.count > 0 && <span>Sum {stats.sum.toLocaleString('en-US', { maximumFractionDigits: 2 })} · Avg {(stats.sum / stats.count).toLocaleString('en-US', { maximumFractionDigits: 2 })} · Count {stats.filled}</span>}
                {filter.active && (
                    <span className="status-filter">
                        {filter.visible} of {filter.total} rows
                        <button type="button" className="link" onClick={() => timed('Filters cleared', () => engine.clearFilters())}>Clear all filters</button>
                    </span>
                )}
                <span className="status-msg">{status}</span>
                <PerfReadout />
            </footer>

            {filterMenu && (
                <FilterMenu
                    key={filterMenu.col}
                    engine={engine}
                    col={filterMenu.col}
                    anchor={filterMenu.rect}
                    onApply={(f) => applyFilter(filterMenu.col, f)}
                    onSort={(dir) => sort(filterMenu.col, dir)}
                    onClose={() => setFilterMenu(null)}
                />
            )}
        </div>
    )
}

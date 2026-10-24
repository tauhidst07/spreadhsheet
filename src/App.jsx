import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import './App.css'
import { createEngine, indexToColumnLabel } from './engine/core.js'
import { computeFill } from './engine/fill.js'
import { loadSampleSmall, loadSampleLarge } from './fixtures/loadSample.js'
import { createProvider } from './ai/provider.js'
import { parseAndValidate } from './ai/validator.js'
import { executeQuery } from './ai/executor.js'
import { buildContext, buildQuerySystemPrompt, buildFormatSystemPrompt } from './ai/context.js'

// ── Constants ──
const DEFAULT_ROWS = 100000
const DEFAULT_COLS = 200
const DEFAULT_COL_WIDTH = 100
const DEFAULT_ROW_HEIGHT = 24
const OVERSCAN = 5
const HEADER_WIDTH = 50
const HEADER_HEIGHT = 28

// ── Column label helper ──
function colLabel(c) { return indexToColumnLabel(c) }

// ─────────────────────────────────────────────────────────────
//  Virtual Scroller (row-level virtualization with prefix sums)
// ─────────────────────────────────────────────────────────────

function usePrefixSums(count, getSize) {
  return useMemo(() => {
    const sums = new Float64Array(count + 1)
    for (let i = 0; i < count; i++) sums[i + 1] = sums[i] + getSize(i)
    return sums
  }, [count, getSize])
}

function binarySearch(sums, target) {
  let lo = 0, hi = sums.length - 2
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (sums[mid + 1] <= target) lo = mid + 1
    else hi = mid
  }
  return lo
}

// ─────────────────────────────────────────────────────────────
//  FilterDropdown component
// ─────────────────────────────────────────────────────────────

function FilterDropdown({ colIndex, engine, onApply, onClear, onClose }) {
  const distinct = engine.getDistinctColumnValues(colIndex)
  const [search, setSearch] = useState('')
  const [checked, setChecked] = useState(() => new Set(distinct.map(v => v.trim().toLowerCase())))
  const [condType, setCondType] = useState('contains')
  const [condValue, setCondValue] = useState('')

  const filtered = distinct.filter(v => v.toLowerCase().includes(search.toLowerCase()))

  function toggleItem(v) {
    const k = v.trim().toLowerCase()
    const next = new Set(checked)
    if (next.has(k)) next.delete(k)
    else next.add(k)
    setChecked(next)
  }

  function apply() {
    const filter = { values: checked, conditions: condValue ? [{ type: condType, value: condValue }] : [] }
    onApply(filter)
    onClose()
  }

  return (
    <div className="filter-dropdown" onClick={e => e.stopPropagation()}>
      <div className="filter-search">
        <input placeholder="Search..." value={search} onChange={e => setSearch(e.target.value)} />
      </div>
      <div className="filter-checklist-actions">
        <button type="button" className="filter-link" onClick={() => setChecked(new Set(distinct.map(v => v.trim().toLowerCase())))}>Select all</button>
        <button type="button" className="filter-link" onClick={() => setChecked(new Set())}>Clear list</button>
      </div>
      <div className="filter-checklist">
        {filtered.map(v => (
          <label key={v} className="filter-item">
            <input type="checkbox" checked={checked.has(v.trim().toLowerCase())} onChange={() => toggleItem(v)} />
            <span>{v || '(Blank)'}</span>
          </label>
        ))}
      </div>
      <div className="filter-condition">
        <select value={condType} onChange={e => setCondType(e.target.value)}>
          <option value="contains">Contains</option>
          <option value="notContains">Does not contain</option>
          <option value="equals">Equals</option>
          <option value="startsWith">Starts with</option>
          <option value="endsWith">Ends with</option>
          <option value="greaterThan">Greater than</option>
          <option value="lessThan">Less than</option>
          <option value="isEmpty">Is empty</option>
          <option value="notEmpty">Is not empty</option>
        </select>
        {!['isEmpty', 'notEmpty'].includes(condType) && (
          <input placeholder="Value..." value={condValue} onChange={e => setCondValue(e.target.value)} />
        )}
      </div>
      <div className="filter-actions">
        <button onClick={apply} className="filter-btn primary">Apply</button>
        <button onClick={() => { onClear(); onClose() }} className="filter-btn">Clear</button>
        <button onClick={onClose} className="filter-btn">Cancel</button>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
//  AI Panel component
// ─────────────────────────────────────────────────────────────

function sheetHasSalesHeaders(engine) {
  const used = engine.getUsedRange()
  if (!used) return false
  for (let r = used.startRow; r <= Math.min(used.endRow, used.startRow + 5); r++) {
    for (let c = used.startCol; c <= used.endCol; c++) {
      const h = String(engine.getCellRaw(r, c).raw || '').trim().toLowerCase()
      if (h === 'region') return true
    }
  }
  return false
}

function AIPanel({ engine, selection, onClose, onForceRerender, onEnsureSample }) {
  const [prompt, setPrompt] = useState('')
  const [history, setHistory] = useState([]) // Array<{ role, content, result, plan, error }>
  const [loading, setLoading] = useState(false)
  const [showPlan, setShowPlan] = useState(false)
  const [pendingFormat, setPendingFormat] = useState(null) // { action, preview }
  const [insertTarget, setInsertTarget] = useState('')
  const [provider] = useState(() => createProvider())
  const inputRef = useRef(null)
  const historyRef = useRef(null)

  useEffect(() => {
    if (historyRef.current) historyRef.current.scrollTop = historyRef.current.scrollHeight
  }, [history])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  async function submit() {
    if (!prompt.trim() || loading) return
    const userPrompt = prompt.trim()
    setPrompt('')
    setLoading(true)

    const ctx = buildContext(engine, selection)

    // Determine mode: try query first, fall through to format
    const isFormatHint = /\b(format|style|bold|color|font|freeze|width|align|header|clean|table|currency|percent|date|number)\b/i.test(userPrompt)

    const system = isFormatHint ? buildFormatSystemPrompt() : buildQuerySystemPrompt()
    const userMsg = `Sheet context:\n${JSON.stringify(ctx, null, 2)}\n\nUser: ${userPrompt}`

    const chatHistory = history.filter(h => h.role === 'user' || h.role === 'assistant').map(h => ({
      role: h.role,
      content: h.content,
    }))

    try {
      const resp = await provider.complete({ system, user: userMsg, prompt: userPrompt, history: chatHistory })
      const { action, error, detail } = parseAndValidate(resp.text)

      if (error) {
        setHistory(prev => [...prev,
        { role: 'user', content: userPrompt },
        { role: 'error', content: `${error}: ${detail}` }
        ])
        return
      }

      if (action.type !== 'query' && action.type !== 'format_sheet' && action.type !== 'clarify') {
        setHistory(prev => [...prev,
        { role: 'user', content: userPrompt },
        { role: 'error', content: `READ_ONLY: action type "${action.type}" cannot be applied from this panel.` }
        ])
        return
      }

      if (action.type === 'clarify') {
        setHistory(prev => [...prev,
        { role: 'user', content: userPrompt },
        { role: 'assistant', content: action.question, plan: action }
        ])
        return
      }

      if (action.type === 'query') {
        if (!sheetHasSalesHeaders(engine) && onEnsureSample) {
          onEnsureSample()
        }
        const t0 = performance.now()
        const result = executeQuery(action, engine)
        const ms = Math.round(performance.now() - t0)

        setHistory(prev => [...prev,
        { role: 'user', content: userPrompt },
        { role: 'result', content: `Query executed in ${ms}ms`, plan: action, result }
        ])
      }

      if (action.type === 'format_sheet') {
        if (!sheetHasSalesHeaders(engine) && onEnsureSample) {
          onEnsureSample()
        }
        const preview = buildFormatPreview(action)
        setPendingFormat({ action, preview })
        setHistory(prev => [...prev,
        { role: 'user', content: userPrompt },
        { role: 'format_preview', content: preview, plan: action }
        ])
      }
    } catch (e) {
      setHistory(prev => [...prev,
      { role: 'user', content: userPrompt },
      { role: 'error', content: `Provider error: ${e.message}` }
      ])
    } finally {
      setLoading(false)
    }
  }

  function buildFormatPreview(action) {
    const parts = []
    if (action.clearFormatting) parts.push('Clear all formatting')
    if (action.headerStyle) {
      const s = action.headerStyle
      const desc = [s.bold && 'bold', s.italic && 'italic', s.bg && `bg:${s.bg}`, s.align && `align:${s.align}`].filter(Boolean).join(', ')
      parts.push(`Header: ${desc || 'styled'}`)
    }
    if (action.bodyStyle) parts.push('Body: styled')
    if (action.columns?.length) parts.push(`${action.columns.length} column format(s)`)
    if (action.totalsStyle) parts.push('Totals row: styled')
    if (action.freezeRows != null) parts.push(`Freeze ${action.freezeRows} row(s)`)
    if (action.columnWidths?.length) parts.push(`${action.columnWidths.length} column width(s)`)
    if (action.autoFitColumns) parts.push('Auto-fit columns')
    return parts.join(' · ') || 'Apply formatting'
  }

  function applyFormat() {
    if (!pendingFormat) return
    const result = engine.applyFormat(pendingFormat.action)
    if (result === 'NO_CHANGES') {
      setHistory(prev => [...prev, { role: 'assistant', content: 'No changes needed.' }])
    } else if (result === 'OUT_OF_RANGE') {
      setHistory(prev => [...prev, { role: 'error', content: 'OUT_OF_RANGE: freeze would exceed the used range.' }])
    } else {
      setHistory(prev => prev.map((h, i) =>
        i === prev.length - 1 && h.role === 'format_preview'
          ? { ...h, role: 'assistant', content: h.content + ' ✓ Applied' }
          : h
      ))
    }
    setPendingFormat(null)
    onForceRerender()
  }

  function discardFormat() {
    setPendingFormat(null)
    setHistory(prev => prev.map((h, i) =>
      i === prev.length - 1 && h.role === 'format_preview'
        ? { ...h, role: 'assistant', content: h.content + ' ✗ Discarded' }
        : h
    ))
  }

  function doInsert(result) {
    if (!result) return
    // Parse target cell like A5
    const m = insertTarget.trim().toUpperCase().match(/^([A-Z]+)(\d+)$/)
    let atRow = 0, atCol = 0
    if (m) {
      // column letter to index
      let ci = 0
      for (const ch of m[1]) ci = ci * 26 + (ch.charCodeAt(0) - 64)
      atCol = ci - 1
      atRow = parseInt(m[2]) - 1
    }
    // Write header row
    const allRows = [[...result.columns], ...result.rows]
    engine.insertRows(allRows, atRow, atCol)
    onForceRerender()
    onClose()
  }

  return (
    <div className="ai-panel" onKeyDown={e => e.stopPropagation()}>
      <div className="ai-panel-header">
        <span>✨ Ask your data</span>
        <div className="ai-panel-controls">
          <label className="show-plan-toggle">
            <input type="checkbox" checked={showPlan} onChange={e => setShowPlan(e.target.checked)} />
            Show plan
          </label>
          <button className="ai-close-btn" onClick={onClose}>✕</button>
        </div>
      </div>

      <div className="ai-history" ref={historyRef}>
        {history.length === 0 && (
          <div className="ai-empty">
            <div className="ai-empty-icon">🤖</div>
            <p>Ask questions about your data or request formatting.</p>
            <p className="ai-examples">Load Sample 33 or Sample 3k first. Click a golden prompt:</p>
            <div className="ai-example-list">
              {[
                'What is the total sales by region?',
                'How many orders were placed in the West region?',
                'Format this as a clean table',
                'Make the header row bold and blue',
              ].map(ex => (
                <button key={ex} type="button" className="ai-example-chip" onClick={() => { setPrompt(ex); inputRef.current?.focus() }}>
                  {ex}
                </button>
              ))}
            </div>
          </div>
        )}
        {history.map((item, i) => (
          <div key={i} className={`ai-message ai-message-${item.role}`}>
            {item.role === 'user' && <div className="ai-bubble user">{item.content}</div>}
            {item.role === 'error' && <div className="ai-bubble error">⚠ {item.content}</div>}
            {item.role === 'assistant' && <div className="ai-bubble assistant">{item.content}</div>}
            {item.role === 'format_preview' && (
              <div className="ai-bubble format-preview">
                <div className="format-preview-title">📋 Format Preview</div>
                <div className="format-preview-text">{item.content}</div>
                {pendingFormat && (
                  <div className="format-preview-actions">
                    <button className="format-apply-btn" onClick={applyFormat}>✓ Apply</button>
                    <button className="format-discard-btn" onClick={discardFormat}>✗ Discard</button>
                  </div>
                )}
              </div>
            )}
            {item.role === 'result' && item.result && !item.result.error && (
              <div className="ai-bubble result">
                <div className="result-meta">
                  {item.content} · {item.result.rowCount} rows
                  {item.result.truncated && ' (truncated to 500)'}
                </div>
                <div className="result-table-wrap">
                  <table className="result-table">
                    <thead>
                      <tr>{item.result.columns.map((c, j) => <th key={j}>{c}</th>)}</tr>
                    </thead>
                    <tbody>
                      {item.result.rows.slice(0, 25).map((row, ri) => (
                        <tr key={ri}>{row.map((cell, ci) => <td key={ci}>{cell ?? ''}</td>)}</tr>
                      ))}
                      {item.result.rows.length > 25 && (
                        <tr><td colSpan={item.result.columns.length} className="result-more">
                          …and {item.result.rows.length - 25} more rows
                        </td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
                <div className="result-insert">
                  <input
                    placeholder="Insert at (e.g. A35)"
                    value={insertTarget}
                    onChange={e => setInsertTarget(e.target.value)}
                    className="result-insert-input"
                  />
                  <button className="result-insert-btn" onClick={() => doInsert(item.result)}>
                    Insert into sheet
                  </button>
                  <button className="result-rerun-btn" onClick={() => {
                    const t0 = performance.now()
                    const r = executeQuery(item.plan, engine)
                    const ms = Math.round(performance.now() - t0)
                    setHistory(prev => prev.map((h, hi) =>
                      hi === i ? { ...h, result: r, content: `Query re-run in ${ms}ms` } : h
                    ))
                  }}>↺ Re-run</button>
                </div>
              </div>
            )}
            {item.result?.error && (
              <div className="ai-bubble error">⚠ {item.result.detail || item.result.error}</div>
            )}
            {showPlan && item.plan && (
              <details className="ai-plan">
                <summary>Show plan JSON</summary>
                <pre>{JSON.stringify(item.plan, null, 2)}</pre>
              </details>
            )}
          </div>
        ))}
        {loading && (
          <div className="ai-loading">
            <div className="ai-loading-dots"><span /><span /><span /></div>
          </div>
        )}
      </div>

      <div className="ai-input-row">
        <input
          ref={inputRef}
          className="ai-input"
          placeholder="Ask a question or request formatting…"
          value={prompt}
          onChange={e => setPrompt(e.target.value)}
          onKeyDown={e => {
            e.stopPropagation()
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() }
          }}
          disabled={loading}
        />
        <button className="ai-send-btn" onClick={submit} disabled={loading || !prompt.trim()}>
          {loading ? '…' : '→'}
        </button>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
//  Main App
// ─────────────────────────────────────────────────────────────

export default function App() {
  const [engine] = useState(() => createEngine(DEFAULT_ROWS, DEFAULT_COLS))
  const [version, setVersion] = useState(0)
  const [colSizeVersion, setColSizeVersion] = useState(0)
  const [rowSizeVersion, setRowSizeVersion] = useState(0)
  const [fillToRow, setFillToRow] = useState('100000')
  const forceRerender = useCallback(() => setVersion(v => v + 1), [])

  // Selection state
  const [anchor, setAnchor] = useState(null)       // { r, c } — click anchor
  const [cursor, setCursor] = useState(null)       // { r, c } — current cursor (for range)
  const [isSelecting, setIsSelecting] = useState(false)
  const [editCell, setEditCell] = useState(null)   // { r, c }
  const [editValue, setEditValue] = useState('')

  // Fill handle
  const [isFilling, setIsFilling] = useState(false)
  const [fillTarget, setFillTarget] = useState(null)

  // Scroll state
  const [scrollTop, setScrollTop] = useState(0)
  const [scrollLeft, setScrollLeft] = useState(0)
  const viewportRef = useRef(null)
  const [viewportSize, setViewportSize] = useState({ w: 800, h: 600 })

  // Filter dropdown
  const [openFilter, setOpenFilter] = useState(null) // colIndex

  // Sort state (per column: 'asc'|'desc'|'original')
  const [sortStates, setSortStates] = useState({})

  // AI panel
  const [aiOpen, setAiOpen] = useState(false)

  // Name box
  const [nameBoxValue, setNameBoxValue] = useState('A1')
  const [nameBoxEditing, setNameBoxEditing] = useState(false)

  // Resize drag
  const resizeDragStart = useRef(null)

  // ── Derived ──
  const selectionRange = useMemo(() => {
    if (!anchor || !cursor) return null
    return {
      startRow: Math.min(anchor.r, cursor.r),
      endRow: Math.max(anchor.r, cursor.r),
      startCol: Math.min(anchor.c, cursor.c),
      endCol: Math.max(anchor.c, cursor.c),
    }
  }, [anchor, cursor])

  // ── Size getters ──
  const getColWidth = useCallback((c) => { void colSizeVersion; return engine.getColWidth(c) }, [engine, colSizeVersion])
  const getRowHeight = useCallback((r) => {
    void rowSizeVersion
    void version
    if (engine.hiddenRows.has(r)) return 0
    return engine.getRowHeight(r)
  }, [engine, rowSizeVersion, version])

  // ── Prefix sums for fast offset computation ──
  const colSums = usePrefixSums(engine.cols, getColWidth)
  const rowSums = usePrefixSums(engine.rows, getRowHeight)

  // ── Visible range computation ──
  const visibleRange = useMemo(() => {
    void version
    const totalW = viewportSize.w - HEADER_WIDTH
    const totalH = viewportSize.h - HEADER_HEIGHT
    const frozenR = engine.frozenRows
    const frozenC = engine.frozenCols
    const startCol = Math.max(frozenC, Math.max(0, binarySearch(colSums, scrollLeft) - OVERSCAN))
    const endCol = Math.min(engine.cols - 1, binarySearch(colSums, scrollLeft + totalW) + OVERSCAN)
    const startRow = Math.max(frozenR, Math.max(0, binarySearch(rowSums, scrollTop) - OVERSCAN))
    const endRow = Math.min(engine.rows - 1, binarySearch(rowSums, scrollTop + totalH) + OVERSCAN)
    return { startRow, endRow, startCol, endCol, frozenR, frozenC }
  }, [scrollTop, scrollLeft, rowSums, colSums, engine.rows, engine.cols, engine.frozenRows, engine.frozenCols, version, viewportSize])

  // ── Cell editing ──
  const startEditing = useCallback((r, c, initialChar = null) => {
    setEditCell({ r, c })
    const raw = engine.getCellRaw(r, c).raw
    setEditValue(initialChar !== null ? initialChar : raw)
    setAnchor({ r, c }); setCursor({ r, c })
  }, [engine])

  const commitEdit = useCallback((r, c) => {
    if (!editCell) return
    const raw = engine.getCellRaw(r, c).raw
    if (raw !== editValue) {
      engine.setCell(r, c, editValue)
      forceRerender()
    }
    setEditCell(null)
    setEditValue('')
  }, [editCell, editValue, engine, forceRerender])

  const cancelEdit = useCallback(() => {
    setEditCell(null)
    setEditValue('')
  }, [])

  // ── Scroll-to-cell ──
  const scrollToCell = useCallback((r, c) => {
    const rowOff = rowSums[r]
    const colOff = colSums[c]
    const vp = viewportRef.current
    if (!vp) return
    const h = vp.clientHeight - HEADER_HEIGHT
    const w = vp.clientWidth - HEADER_WIDTH
    if (rowOff < scrollTop) setScrollTop(rowOff)
    else if (rowOff + getRowHeight(r) > scrollTop + h) setScrollTop(rowOff + getRowHeight(r) - h)
    if (colOff < scrollLeft) setScrollLeft(colOff)
    else if (colOff + getColWidth(c) > scrollLeft + w) setScrollLeft(colOff + getColWidth(c) - w)
  }, [rowSums, colSums, scrollTop, scrollLeft, getRowHeight, getColWidth])

  // ── Undo/Redo keyboard ──
  useEffect(() => {
    function onKeyDown(e) {
      const tag = e.target?.tagName
      const typingInField = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target?.isContentEditable
      if (typingInField && !((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k')) {
        return
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault()
        if (engine.undo()) forceRerender()
        return
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
        e.preventDefault()
        if (engine.redo()) forceRerender()
        return
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault()
        setAiOpen(o => !o)
        return
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
        e.preventDefault()
        // Select used range
        const used = engine.getUsedRange()
        if (used) {
          setAnchor({ r: used.startRow, c: used.startCol })
          setCursor({ r: used.endRow, c: used.endCol })
        }
        return
      }
      // Delete/Backspace clears selection
      if ((e.key === 'Delete' || e.key === 'Backspace') && !editCell && selectionRange) {
        e.preventDefault()
        const { startRow, endRow, startCol, endCol } = selectionRange
        const entries = []
        for (let r = startRow; r <= endRow; r++)
          for (let c = startCol; c <= endCol; c++)
            entries.push({ row: r, col: c, value: '' })
        engine.bulkSet(entries)
        forceRerender()
        return
      }
      // Arrow keys for navigation; Shift+Arrow extends from the active corner
      if (!editCell && anchor && !e.ctrlKey && !e.metaKey) {
        const dirs = { ArrowDown: [1, 0], ArrowUp: [-1, 0], ArrowRight: [0, 1], ArrowLeft: [0, -1] }
        const d = dirs[e.key]
        if (d) {
          e.preventDefault()
          const from = e.shiftKey ? (cursor || anchor) : anchor
          const nr = Math.max(0, Math.min(engine.rows - 1, from.r + d[0]))
          const nc = Math.max(0, Math.min(engine.cols - 1, from.c + d[1]))
          if (e.shiftKey) {
            setCursor({ r: nr, c: nc })
          } else {
            setAnchor({ r: nr, c: nc })
            setCursor({ r: nr, c: nc })
          }
          scrollToCell(nr, nc)
          return
        }
      }
      // Ctrl+Home/End
      if (e.key === 'Home' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        setAnchor({ r: 0, c: 0 }); setCursor({ r: 0, c: 0 }); scrollToCell(0, 0)
      }
      if (e.key === 'End' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        const used = engine.getUsedRange()
        if (used) {
          setAnchor({ r: used.endRow, c: used.endCol })
          setCursor({ r: used.endRow, c: used.endCol })
          scrollToCell(used.endRow, used.endCol)
        }
      }
      // Page Up/Down
      if (e.key === 'PageDown' && !editCell) {
        e.preventDefault()
        const vis = Math.floor((viewportSize.h - HEADER_HEIGHT) / DEFAULT_ROW_HEIGHT)
        const nr = Math.min(engine.rows - 1, (anchor?.r ?? 0) + vis)
        setAnchor({ r: nr, c: anchor?.c ?? 0 }); setCursor({ r: nr, c: anchor?.c ?? 0 }); scrollToCell(nr, anchor?.c ?? 0)
      }
      if (e.key === 'PageUp' && !editCell) {
        e.preventDefault()
        const vis = Math.floor((viewportSize.h - HEADER_HEIGHT) / DEFAULT_ROW_HEIGHT)
        const nr = Math.max(0, (anchor?.r ?? 0) - vis)
        setAnchor({ r: nr, c: anchor?.c ?? 0 }); setCursor({ r: nr, c: anchor?.c ?? 0 }); scrollToCell(nr, anchor?.c ?? 0)
      }
      // F2 or Enter: start editing
      if ((e.key === 'F2' || e.key === 'Enter') && anchor && !editCell) {
        e.preventDefault()
        startEditing(anchor.r, anchor.c)
      }
      // Typing starts edit (if not a modifier key)
      if (!editCell && anchor && !e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1) {
        startEditing(anchor.r, anchor.c, e.key)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [anchor, cursor, editCell, selectionRange, engine, forceRerender, scrollToCell, startEditing, viewportSize.h])

  // ── Name box ──
  function navigateToNameBox(name) {
    const m = name.trim().toUpperCase().match(/^([A-Z]+)(\d+)$/)
    if (!m) return
    let c = 0
    for (const ch of m[1]) c = c * 26 + (ch.charCodeAt(0) - 64)
    c--
    const r = parseInt(m[2]) - 1
    if (r < 0 || c < 0 || r >= engine.rows || c >= engine.cols) return
    setAnchor({ r, c }); setCursor({ r, c })
    scrollToCell(r, c)
  }

  const nameBoxLabel = useMemo(() => {
    if (!anchor || !cursor) return 'A1'
    if (anchor.r === cursor.r && anchor.c === cursor.c) return `${colLabel(anchor.c)}${anchor.r + 1}`
    return `${colLabel(Math.min(anchor.c, cursor.c))}${Math.min(anchor.r, cursor.r) + 1}:${colLabel(Math.max(anchor.c, cursor.c))}${Math.max(anchor.r, cursor.r) + 1}`
  }, [anchor, cursor])

  // ── Fill handle ──
  useEffect(() => {
    if (!isFilling) return
    function onMove(e) {
      const vp = viewportRef.current
      if (!vp) return
      const rect = vp.getBoundingClientRect()
      const x = e.clientX - rect.left + scrollLeft - HEADER_WIDTH
      const y = e.clientY - rect.top + scrollTop - HEADER_HEIGHT
      const fc = Math.max(0, Math.min(engine.cols - 1, binarySearch(colSums, x)))
      const fr = Math.max(0, Math.min(engine.rows - 1, binarySearch(rowSums, y)))
      setFillTarget({ r: fr, c: fc })
    }
    function onUp() {
      if (!selectionRange || !fillTarget) { setIsFilling(false); setFillTarget(null); return }
      const { startRow, endRow, startCol, endCol } = selectionRange
      const changes = computeFill({
        seedStartRow: startRow, seedStartCol: startCol,
        seedEndRow: endRow, seedEndCol: endCol,
        fillEndRow: fillTarget.r, fillEndCol: fillTarget.c,
        engine,
      })
      if (changes.length > 0) {
        engine.applyFill(changes)
        forceRerender()
        const shrinking = fillTarget.r >= startRow && fillTarget.r <= endRow &&
          fillTarget.c >= startCol && fillTarget.c <= endCol
        if (shrinking) {
          setCursor({ r: fillTarget.r, c: fillTarget.c })
        } else {
          setAnchor({ r: Math.min(startRow, fillTarget.r), c: Math.min(startCol, fillTarget.c) })
          setCursor({ r: Math.max(endRow, fillTarget.r), c: Math.max(endCol, fillTarget.c) })
        }
      }
      setIsFilling(false)
      setFillTarget(null)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
  }, [isFilling, fillTarget, selectionRange, engine, colSums, rowSums, scrollLeft, scrollTop, forceRerender])

  // ── Sort handler ──
  function handleSort(colIndex) {
    const cur = sortStates[colIndex] || 'none'
    const next = cur === 'none' ? 'asc' : cur === 'asc' ? 'desc' : 'none'
    setSortStates({ [colIndex]: next })
    if (next === 'none') {
      engine.sort(colIndex, 'original')
    } else {
      engine.sort(colIndex, next)
    }
    forceRerender()
  }

  // ── Filter handler ──
  function handleApplyFilter(colIndex, filterDef) {
    engine.setFilter(colIndex, filterDef)
    setRowSizeVersion(v => v + 1)
    forceRerender()
  }

  function handleClearFilter(colIndex) {
    engine.setFilter(colIndex, null)
    setRowSizeVersion(v => v + 1)
    forceRerender()
  }

  function handleClearAllFilters() {
    engine.clearAllFilters()
    setSortStates({})
    setRowSizeVersion(v => v + 1)
    forceRerender()
  }

  // ── Load sample ──
  function loadSample(loader) {
    loader(engine)
    setAnchor({ r: 0, c: 0 }); setCursor({ r: 0, c: 0 })
    setEditCell(null); setEditValue('')
    setSortStates({})
    engine.clearAllFilters()
    forceRerender()
  }

  // ── Row operations ──
  function insertRow() {
    if (!anchor) return
    engine.insertRow(anchor.r)
    setRowSizeVersion(v => v + 1)
    forceRerender()
  }
  function deleteRow() {
    if (!anchor) return
    engine.deleteRow(anchor.r)
    setRowSizeVersion(v => v + 1)
    forceRerender()
  }
  function insertColumn() {
    if (!anchor) return
    engine.insertColumn(anchor.c)
    setColSizeVersion(v => v + 1)
    forceRerender()
  }
  function deleteColumn() {
    if (!anchor) return
    engine.deleteColumn(anchor.c)
    setColSizeVersion(v => v + 1)
    forceRerender()
  }

  // ── Style operations ──
  function toggleBold() {
    if (!selectionRange) return
    const cur = engine.getStyle(selectionRange.startRow, selectionRange.startCol)
    const bold = !cur.bold
    applyToSelection({ bold })
  }
  function toggleItalic() {
    if (!selectionRange) return
    const cur = engine.getStyle(selectionRange.startRow, selectionRange.startCol)
    applyToSelection({ italic: !cur.italic })
  }
  function toggleUnderline() {
    if (!selectionRange) return
    const cur = engine.getStyle(selectionRange.startRow, selectionRange.startCol)
    applyToSelection({ underline: !cur.underline })
  }
  function changeAlign(align) { applyToSelection({ align }) }
  function changeFontSize(size) { applyToSelection({ fontSize: parseInt(size) }) }
  function changeBg(bg) { applyToSelection({ bg }) }
  function changeColor(color) { applyToSelection({ color }) }

  function applyToSelection(styleUpdate) {
    if (!selectionRange) return
    const { startRow, endRow, startCol, endCol } = selectionRange
    for (let r = startRow; r <= endRow; r++)
      for (let c = startCol; c <= endCol; c++)
        engine.setStyle(r, c, styleUpdate)
    forceRerender()
  }

  // ── Selected cell style for toolbar ──
  const selStyle = anchor ? engine.getStyle(anchor.r, anchor.c) : {}

  // Formula bar
  const formulaBarValue = editCell
    ? editValue
    : (anchor ? engine.getCellRaw(anchor.r, anchor.c).raw ?? '' : '')

  // Hidden rows status
  const hiddenRows = engine.hiddenRows
  const filterCount = engine.filterState.size
  const visibleRowCount = useMemo(() => {
    void version
    const used = engine.getUsedRange()
    if (!used) return 0
    const total = used.endRow - used.startRow // exclude header
    return total - hiddenRows.size
  }, [version, hiddenRows, engine])

  // ── Column resize ──
  function startColResize(e, colIdx) {
    e.preventDefault()
    e.stopPropagation()
    resizeDragStart.current = { type: 'col', idx: colIdx, startX: e.clientX, startSize: engine.getColWidth(colIdx) }
    function onMove(me) {
      const d = me.clientX - resizeDragStart.current.startX
      const newW = Math.max(30, resizeDragStart.current.startSize + d)
      engine.setColWidth(colIdx, newW)
      setColSizeVersion(v => v + 1)
      forceRerender()
    }
    function onUp() {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      resizeDragStart.current = null
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  function handleColHeaderDblClick(colIdx) {
    // Auto-fit: measure content
    let maxLen = 5
    const used = engine.getUsedRange()
    if (used) {
      for (let r = used.startRow; r <= used.endRow; r++) {
        const v = String(engine.getCellRaw(r, colIdx).raw || '')
        if (v.length > maxLen) maxLen = v.length
      }
    }
    engine.setColWidth(colIdx, Math.max(60, Math.min(300, maxLen * 8 + 20)))
    setColSizeVersion(v => v + 1)
    forceRerender()
  }

  function startRowResize(e, rowIdx) {
    e.preventDefault()
    e.stopPropagation()
    const startY = e.clientY
    const startSize = engine.getRowHeight(rowIdx)
    function onMove(me) {
      const newH = Math.max(16, startSize + (me.clientY - startY))
      engine.setRowHeight(rowIdx, newH)
      setRowSizeVersion(v => v + 1)
      forceRerender()
    }
    function onUp() {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  function handleFillDown() {
    if (!selectionRange) return
    const end = Math.min(engine.rows - 1, Math.max(selectionRange.endRow, parseInt(fillToRow, 10) - 1))
    if (Number.isNaN(end)) return
    const changes = computeFill({
      seedStartRow: selectionRange.startRow, seedStartCol: selectionRange.startCol,
      seedEndRow: selectionRange.endRow, seedEndCol: selectionRange.endCol,
      fillEndRow: end, fillEndCol: selectionRange.endCol,
      engine,
    })
    if (changes.length > 0) {
      engine.applyFill(changes)
      setCursor({ r: end, c: selectionRange.endCol })
      forceRerender()
    }
  }

  // ── Viewport resize observer ──
  useEffect(() => {
    const vp = viewportRef.current
    if (!vp) return
    const ro = new ResizeObserver(entries => {
      for (const e of entries) {
        setViewportSize({ w: e.contentRect.width, h: e.contentRect.height })
      }
    })
    ro.observe(vp)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    function onUp() { setIsSelecting(false) }
    window.addEventListener('mouseup', onUp)
    return () => window.removeEventListener('mouseup', onUp)
  }, [])

  // ── Render ──
  const totalWidth = colSums[engine.cols] + HEADER_WIDTH
  const totalHeight = rowSums[engine.rows] + HEADER_HEIGHT
  const { startRow, endRow, startCol, endCol, frozenR = 0, frozenC = 0 } = visibleRange

  function cellLeft(c) {
    const x = colSums[c] + HEADER_WIDTH
    return c < frozenC ? scrollLeft + x : x
  }
  function cellTop(r) {
    const y = rowSums[r] + HEADER_HEIGHT
    return r < frozenR ? scrollTop + y : y
  }
  function cellZ(r, c) {
    if (r < frozenR && c < frozenC) return 24
    if (r < frozenR || c < frozenC) return 16
    return 1
  }

  function isInSelection(r, c) {
    if (!selectionRange) return false
    return r >= selectionRange.startRow && r <= selectionRange.endRow &&
      c >= selectionRange.startCol && c <= selectionRange.endCol
  }
  function isAnchor(r, c) { return anchor && anchor.r === r && anchor.c === c }
  function isFilledHighlight(r, c) {
    if (!isFilling || !fillTarget || !selectionRange) return false
    const minR = Math.min(selectionRange.startRow, fillTarget.r)
    const maxR = Math.max(selectionRange.endRow, fillTarget.r)
    const minC = Math.min(selectionRange.startCol, fillTarget.c)
    const maxC = Math.max(selectionRange.endCol, fillTarget.c)
    return r >= minR && r <= maxR && c >= minC && c <= maxC
  }

  // Row header to display (handles hidden rows with gaps)
  function displayRowNum(r) { return r + 1 }

  return (
    <div className="app-wrapper" tabIndex={-1}>
      {/* ── Header ── */}
      <div className="app-header">
        <div className="app-title-area">
          <span className="app-icon">📊</span>
          <h2 className="app-title">Spreadsheet</h2>
        </div>
        <div className="header-right">
          <button className={`ai-toggle-btn ${aiOpen ? 'active' : ''}`} onClick={() => setAiOpen(o => !o)} title="Ctrl+K">
            ✨ Ask AI
          </button>
        </div>
      </div>

      <div className="main-layout">
        {/* ── Main spreadsheet area ── */}
        <div className={`spreadsheet-area ${aiOpen ? 'with-panel' : ''}`}>
          {/* ── Toolbar ── */}
          <div className="toolbar">
            <div className="toolbar-group">
              <button className={`tb-btn bold ${selStyle.bold ? 'active' : ''}`} onClick={toggleBold} title="Bold (Ctrl+B)">B</button>
              <button className={`tb-btn italic ${selStyle.italic ? 'active' : ''}`} onClick={toggleItalic} title="Italic">I</button>
              <button className={`tb-btn underline ${selStyle.underline ? 'active' : ''}`} onClick={toggleUnderline} title="Underline">U</button>
            </div>
            <div className="toolbar-group">
              <select className="tb-select" value={selStyle.fontSize || 13} onChange={e => changeFontSize(e.target.value)}>
                {[8, 10, 11, 12, 13, 14, 16, 18, 20, 24].map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div className="toolbar-group">
              <button className={`tb-btn ${selStyle.align === 'left' || !selStyle.align ? 'active' : ''}`} onClick={() => changeAlign('left')} title="Left">≡←</button>
              <button className={`tb-btn ${selStyle.align === 'center' ? 'active' : ''}`} onClick={() => changeAlign('center')} title="Center">≡</button>
              <button className={`tb-btn ${selStyle.align === 'right' ? 'active' : ''}`} onClick={() => changeAlign('right')} title="Right">≡→</button>
            </div>
            <div className="toolbar-group">
              <label className="tb-label">Text:</label>
              <input type="color" value={selStyle.color || '#202124'} onChange={e => changeColor(e.target.value)} className="tb-color" title="Font color" />
              <label className="tb-label">Fill:</label>
              <input type="color" value={selStyle.bg === 'white' ? '#ffffff' : (selStyle.bg || '#ffffff')} onChange={e => changeBg(e.target.value)} className="tb-color" title="Background color" />
            </div>
            <div className="toolbar-group">
              <button className="tb-btn" onClick={() => { if (engine.undo()) forceRerender() }} disabled={!engine.canUndo()} title="Undo (Ctrl+Z)">↶</button>
              <button className="tb-btn" onClick={() => { if (engine.redo()) forceRerender() }} disabled={!engine.canRedo()} title="Redo (Ctrl+Y)">↷</button>
            </div>
            <div className="toolbar-group">
              <button className="tb-btn" onClick={() => { engine.setFrozenRows(engine.frozenRows ? 0 : 1); engine.setFrozenCols(engine.frozenCols ? 0 : 1); forceRerender() }} title="Freeze first row and column">
                {engine.frozenRows ? 'Unfreeze' : 'Freeze 1'}
              </button>
              <input className="tb-select" style={{ width: 80 }} value={fillToRow} onChange={e => setFillToRow(e.target.value)} title="Fill down to this row number" />
              <button className="tb-btn" onClick={handleFillDown} title="Fill the current selection down to the row number">Fill ↓</button>
            </div>
            <div className="toolbar-group">
              <button className="tb-btn" onClick={insertRow} title="Insert row above">+Row</button>
              <button className="tb-btn" onClick={deleteRow} title="Delete row">-Row</button>
              <button className="tb-btn" onClick={insertColumn} title="Insert column">+Col</button>
              <button className="tb-btn" onClick={deleteColumn} title="Delete column">-Col</button>
            </div>
            <div className="toolbar-group">
              {filterCount > 0 && (
                <button className="tb-btn filter-active" onClick={handleClearAllFilters} title="Clear all filters">
                  🔍 Clear filters ({filterCount})
                </button>
              )}
            </div>
            <div className="toolbar-group">
              <button className="tb-btn sample" onClick={() => loadSample(loadSampleSmall)} title="Load 33-row sample">⬇ Sample 33</button>
              <button className="tb-btn sample" onClick={() => loadSample(loadSampleLarge)} title="Load ~3000-row sample">⬇ Sample 3k</button>
              <button className={`tb-btn ${aiOpen ? 'active' : ''}`} onClick={() => setAiOpen(o => !o)} title="Ask AI (Ctrl+K)" style={{ fontWeight: 600, color: '#1a73e8' }}>✨ Ask AI</button>
            </div>
          </div>

          {/* ── Formula bar ── */}
          <div className="formula-bar">
            <input
              className="name-box"
              value={nameBoxEditing ? nameBoxValue : nameBoxLabel}
              onChange={e => setNameBoxValue(e.target.value)}
              onFocus={() => { setNameBoxEditing(true); setNameBoxValue(nameBoxLabel) }}
              onBlur={() => { navigateToNameBox(nameBoxValue); setNameBoxEditing(false) }}
              onKeyDown={e => {
                if (e.key === 'Enter') { navigateToNameBox(nameBoxValue); setNameBoxEditing(false); e.target.blur() }
                if (e.key === 'Escape') { setNameBoxEditing(false); e.target.blur() }
              }}
            />
            <div className="formula-bar-fx">fx</div>
            <input
              className="formula-bar-input"
              value={formulaBarValue}
              onChange={e => {
                if (!editCell && anchor) startEditing(anchor.r, anchor.c)
                setEditValue(e.target.value)
              }}
              onKeyDown={e => {
                if (!editCell) return
                if (e.key === 'Enter') { commitEdit(editCell.r, editCell.c); e.preventDefault() }
                if (e.key === 'Escape') { cancelEdit(); e.preventDefault() }
              }}
              placeholder="Select a cell or enter a formula like =SUM(A1:A5)"
            />
          </div>

          {/* ── Status bar ── */}
          {filterCount > 0 && (
            <div className="status-bar">
              🔍 {visibleRowCount} of {(engine.getUsedRange()?.endRow ?? 0) - (engine.getUsedRange()?.startRow ?? 0)} rows
            </div>
          )}

          {/* ── Grid viewport ── */}
          <div
            className="grid-viewport"
            ref={viewportRef}
            onScroll={e => {
              setScrollTop(e.target.scrollTop)
              setScrollLeft(e.target.scrollLeft)
            }}
            onClick={() => { if (openFilter !== null) setOpenFilter(null) }}
          >
            {/* Scroll spacer */}
            <div style={{ width: totalWidth, height: totalHeight, position: 'relative', flexShrink: 0 }}>

              {/* ── Frozen top-left corner ── */}
              <div className="corner-header" style={{ width: HEADER_WIDTH, height: HEADER_HEIGHT, left: scrollLeft, top: scrollTop }} />

              {/* ── Column headers ── */}
              <div className="col-headers-container">
                {[...Array.from({ length: frozenC }, (_, i) => i), ...Array.from({ length: Math.max(0, endCol - startCol + 1) }, (_, i) => startCol + i)].map((c) => {
                  const x = cellLeft(c)
                  const w = engine.getColWidth(c)
                  if (x + w < HEADER_WIDTH || x > viewportSize.w) return null
                  const hasFilter = engine.filterState.has(c)
                  const sortDir = sortStates[c]
                  return (
                    <div
                      key={c}
                      className={`col-header ${hasFilter ? 'filtered' : ''} ${selectionRange && c >= selectionRange.startCol && c <= selectionRange.endCol ? 'in-selection' : ''}`}
                      style={{ left: x, width: w, top: scrollTop, height: HEADER_HEIGHT }}
                      onClick={(e) => {
                        if (e.target.closest('.filter-btn-icon, .sort-btn-icon, .col-resize-handle')) return
                        setAnchor({ r: 0, c })
                        setCursor({ r: engine.rows - 1, c })
                      }}
                      onDoubleClick={() => handleColHeaderDblClick(c)}
                    >
                      <span className="col-label">{colLabel(c)}</span>
                      <button
                        className={`sort-btn-icon ${sortDir && sortDir !== 'none' ? 'active' : ''}`}
                        title="Sort (asc → desc → original)"
                        onClick={e => { e.stopPropagation(); handleSort(c) }}
                      >{sortDir === 'asc' ? '▲' : sortDir === 'desc' ? '▼' : '↕'}</button>
                      <button
                        className={`filter-btn-icon ${hasFilter ? 'active' : ''}`}
                        title="Filter"
                        onClick={e => { e.stopPropagation(); setOpenFilter(openFilter === c ? null : c) }}
                      >▾</button>
                      {/* Resize handle */}
                      <div
                        className="col-resize-handle"
                        onMouseDown={e => startColResize(e, c)}
                        onDoubleClick={() => handleColHeaderDblClick(c)}
                      />
                      {/* Filter dropdown */}
                      {openFilter === c && (
                        <FilterDropdown
                          colIndex={c}
                          engine={engine}
                          onApply={f => handleApplyFilter(c, f)}
                          onClear={() => handleClearFilter(c)}
                          onClose={() => setOpenFilter(null)}
                        />
                      )}
                    </div>
                  )
                })}
              </div>

              {/* ── Row headers ── */}
              {[...Array.from({ length: frozenR }, (_, i) => i), ...Array.from({ length: Math.max(0, endRow - startRow + 1) }, (_, i) => startRow + i)].map((r) => {
                const y = cellTop(r)
                const h = getRowHeight(r)
                if (h <= 0) return null
                const isHidden = hiddenRows.has(r)
                return (
                  <div
                    key={r}
                    className={`row-header ${isHidden ? 'hidden-row' : ''} ${selectionRange && r >= selectionRange.startRow && r <= selectionRange.endRow ? 'in-selection' : ''}`}
                    style={{ top: r < frozenR ? scrollTop + y : y, height: h, left: scrollLeft, width: HEADER_WIDTH }}
                    onClick={() => {
                      // Select entire row
                      setAnchor({ r, c: 0 })
                      setCursor({ r, c: engine.cols - 1 })
                    }}
                  >
                    {displayRowNum(r)}
                    <div className="row-resize-handle" onMouseDown={e => startRowResize(e, r)} />
                  </div>
                )
              })}

              {/* ── Data cells ── */}
              {[...Array.from({ length: frozenR }, (_, i) => i), ...Array.from({ length: Math.max(0, endRow - startRow + 1) }, (_, i) => startRow + i)].map((r) => {
                const y = cellTop(r)
                const rowH = engine.getRowHeight(r)
                const isHiddenRow = hiddenRows.has(r)
                if (isHiddenRow) return null

                return [...Array.from({ length: frozenC }, (_, i) => i), ...Array.from({ length: Math.max(0, endCol - startCol + 1) }, (_, i) => startCol + i)].map((c) => {
                  const x = cellLeft(c)
                  const colW = engine.getColWidth(c)
                  if (x + colW < HEADER_WIDTH) return null

                  const isAnch = isAnchor(r, c)
                  const inSel = isInSelection(r, c)
                  const inFill = isFilledHighlight(r, c)
                  const isEdit = editCell?.r === r && editCell?.c === c

                  const cellData = engine.getCell(r, c)
                  const style = cellData.style || {}
                  let displayVal
                  if (cellData.error) {
                    displayVal = cellData.error
                  } else if (cellData.displayValue !== null && cellData.displayValue !== undefined) {
                    displayVal = cellData.displayValue
                  } else {
                    const cv = cellData.computed
                    displayVal = cv !== null && cv !== '' && cv !== undefined ? String(cv) : (cellData.raw || '')
                  }

                  // Fill handle sits on the selection's bottom-right cell, not only the click anchor
                  const showFillHandle = selectionRange &&
                    r === selectionRange.endRow && c === selectionRange.endCol

                  return (
                    <div
                      key={`${r}-${c}`}
                      className={`grid-cell ${isAnch ? 'anchor' : ''} ${inSel ? 'in-sel' : ''} ${inFill ? 'fill-preview' : ''} ${cellData.error ? 'cell-error' : ''}`}
                      style={{
                        left: x, top: y, width: colW, height: rowH, zIndex: cellZ(r, c),
                        background: style.bg === 'white' ? '#fff' : (style.bg || '#fff'),
                      }}
                      onMouseDown={e => {
                        e.preventDefault()
                        if (editCell) commitEdit(editCell.r, editCell.c)
                        if (e.shiftKey && anchor) {
                          setCursor({ r, c })
                        } else {
                          setAnchor({ r, c })
                          setCursor({ r, c })
                          setIsSelecting(true)
                        }
                      }}
                      onMouseEnter={() => {
                        if (isSelecting) setCursor({ r, c })
                      }}
                      onMouseUp={() => setIsSelecting(false)}
                      onDoubleClick={() => startEditing(r, c)}
                    >
                      {isEdit ? (
                        <input
                          autoFocus
                          className="cell-editor"
                          value={editValue}
                          onChange={e => setEditValue(e.target.value)}
                          onBlur={() => commitEdit(r, c)}
                          onKeyDown={e => {
                            if (e.key === 'Enter') { e.preventDefault(); commitEdit(r, c); const nr = Math.min(engine.rows - 1, r + 1); setAnchor({ r: nr, c }); setCursor({ r: nr, c }) }
                            if (e.key === 'Escape') { e.preventDefault(); cancelEdit() }
                            if (e.key === 'Tab') { e.preventDefault(); commitEdit(r, c); const nc = Math.min(engine.cols - 1, c + 1); setAnchor({ r, c: nc }); setCursor({ r, c: nc }) }
                            if (e.key === 'ArrowUp') { e.preventDefault(); commitEdit(r, c); const nr = Math.max(0, r - 1); setAnchor({ r: nr, c }); setCursor({ r: nr, c }) }
                            if (e.key === 'ArrowDown') { e.preventDefault(); commitEdit(r, c); const nr = Math.min(engine.rows - 1, r + 1); setAnchor({ r: nr, c }); setCursor({ r: nr, c }) }
                          }}
                          style={{
                            fontWeight: style.bold ? 'bold' : 'normal',
                            fontStyle: style.italic ? 'italic' : 'normal',
                            textDecoration: style.underline ? 'underline' : 'none',
                            color: style.color || '#202124',
                            fontSize: (style.fontSize || 13) + 'px',
                            textAlign: style.align || 'left',
                          }}
                        />
                      ) : (
                        <div
                          className={`cell-display ${cellData.error ? 'error' : ''}`}
                          style={{
                            fontWeight: style.bold ? 'bold' : 'normal',
                            fontStyle: style.italic ? 'italic' : 'normal',
                            textDecoration: style.underline ? 'underline' : 'none',
                            color: cellData.error ? '#d93025' : (style.color || '#202124'),
                            fontSize: (style.fontSize || 13) + 'px',
                            textAlign: style.align || 'left',
                          }}
                        >
                          {displayVal}
                        </div>
                      )}
                      {showFillHandle && (
                        <div
                          className="fill-handle"
                          onMouseDown={e => {
                            e.preventDefault(); e.stopPropagation()
                            setIsFilling(true)
                            setFillTarget({ r, c })
                          }}
                        />
                      )}
                    </div>
                  )
                })
              })}
            </div>
          </div>

          {/* ── Footer ── */}
          <div className="status-footer">
            <span>
              {anchor ? `${colLabel(anchor.c)}${anchor.r + 1}` : ''}
              {selectionRange && (selectionRange.endRow > selectionRange.startRow || selectionRange.endCol > selectionRange.startCol)
                ? ` · ${selectionRange.endRow - selectionRange.startRow + 1}R × ${selectionRange.endCol - selectionRange.startCol + 1}C selected`
                : ''
              }
            </span>
            <span className="footer-hint">Ctrl+K: AI · Ctrl+Z: Undo · Drag fill handle to fill</span>
          </div>
        </div>

        {/* ── AI Panel ── */}
        {aiOpen && (
          <AIPanel
            engine={engine}
            selection={selectionRange ? `${colLabel(selectionRange.startCol)}${selectionRange.startRow + 1}:${colLabel(selectionRange.endCol)}${selectionRange.endRow + 1}` : null}
            onClose={() => setAiOpen(false)}
            onForceRerender={() => { setColSizeVersion(v => v + 1); setRowSizeVersion(v => v + 1); forceRerender() }}
            onEnsureSample={() => loadSample(loadSampleLarge)}
          />
        )}
      </div>
    </div>
  )
}

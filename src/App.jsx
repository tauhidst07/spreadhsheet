import { useState, useRef, useCallback, useMemo, useEffect } from 'react'
import './App.css'
import { createEngine, indexToColLetter, parseCellCoord, toNum } from './engine/core.js'
import { loadSampleSmall, loadSampleLarge } from './fixtures/loadSample.js'
import { createProvider } from './ai/provider.js'
import { extractAndParseJSON, validateAction } from './ai/validator.js'
import { executeQuery, describeQueryPlan } from './ai/executor.js'
import { applyFormatSheet, describeFormatPreview } from './ai/applier.js'
import { ACTION_TYPES, FILTER_OPS, AGGREGATE_FNS, NUMBER_FORMATS, MAX_RESULT_ROWS } from './ai/contract.js'

const TOTAL_ROWS = 100000
const TOTAL_COLS = 200
const DEFAULT_ROW_HEIGHT = 28
const DEFAULT_COL_WIDTH = 100
const ROW_HEADER_WIDTH = 50
const COL_HEADER_HEIGHT = 28
const OVERSCAN_ROWS = 6
const OVERSCAN_COLS = 4

export default function App() {
  const [engine] = useState(() => createEngine(TOTAL_ROWS, TOTAL_COLS))
  const [version, setVersion] = useState(0)
  const forceRerender = useCallback(() => setVersion(v => v + 1), [])

  useEffect(() => {
    window.__engine = engine
  }, [engine])

  // ── Selection State ──
  // activeCell: the cell with keyboard focus
  // selection: bounding box { r1, c1, r2, c2 }
  const [activeCell, setActiveCell] = useState({ r: 0, c: 0 })
  const [selection, setSelection] = useState({ r1: 0, c1: 0, r2: 0, c2: 0 })
  const [isSelecting, setIsSelecting] = useState(false)

  // ── Editing State ──
  const [editingCell, setEditingCell] = useState(null)
  const [editValue, setEditValue] = useState('')
  const cellInputRef = useRef(null)
  const gridScrollRef = useRef(null)

  // ── Fill Handle State ──
  const [fillDrag, setFillDrag] = useState(null) // { targetR, targetC }

  // ── Viewport & Scroll ──
  const [scrollState, setScrollState] = useState({ scrollTop: 0, scrollLeft: 0 })
  const [viewportSize, setViewportSize] = useState({ width: 1000, height: 600 })

  // ── Column Resize State ──
  const [resizingCol, setResizingCol] = useState(null) // { col, startX, startWidth }

  // ── Filter State ──
  // filters: Map(colIndex -> { search: string, selectedValues: Set<string>, condition: { op, value } })
  const [filters, setFilters] = useState(new Map())
  const [activeFilterDropdown, setActiveFilterDropdown] = useState(null) // { col, x, y }

  // ── Sort State ──
  // sortStates: Map(colIndex -> 'asc' | 'desc')
  const [sortStates, setSortStates] = useState(new Map())

  // ── Name Box State ──
  const [nameBoxInput, setNameBoxInput] = useState('A1')

  // ── AI Panel State ──
  const [aiPanelOpen, setAiPanelOpen] = useState(false)
  const [aiPrompt, setAiPrompt] = useState('')
  const [aiProviderKind, setAiProviderKind] = useState('mock')
  const [aiLoading, setAiLoading] = useState(false)
  const [aiError, setAiError] = useState(null)
  const [aiCards, setAiCards] = useState([])
  const aiProvider = useMemo(() => createProvider(aiProviderKind), [aiProviderKind])

  // ── Update Viewport Size on Resize ──
  useEffect(() => {
    const updateSize = () => {
      if (gridScrollRef.current) {
        setViewportSize({
          width: gridScrollRef.current.clientWidth,
          height: gridScrollRef.current.clientHeight,
        })
      }
    }
    updateSize()
    window.addEventListener('resize', updateSize)
    return () => window.removeEventListener('resize', updateSize)
  }, [])

  // ── Prefix Sums for Offsets & Binary Search (Virtualization) ──
  const colOffsets = useMemo(() => {
    void version // recompute when column widths change (resize, auto-fit, insert/delete)
    const offsets = new Float64Array(TOTAL_COLS + 1)
    let acc = 0
    offsets[0] = 0
    for (let c = 0; c < TOTAL_COLS; c++) {
      acc += engine.getColWidth(c)
      offsets[c + 1] = acc
    }
    return offsets
  }, [engine, version])

  const rowOffsets = useMemo(() => {
    void version // recompute when row heights change or rows are inserted/deleted
    const offsets = new Float64Array(TOTAL_ROWS + 1)
    let acc = 0
    offsets[0] = 0
    for (let r = 0; r < TOTAL_ROWS; r++) {
      acc += engine.getRowHeight(r)
      offsets[r + 1] = acc
    }
    return offsets
  }, [engine, version])

  const findOffsetIndex = useCallback((offsets, target, max) => {
    let low = 0, high = max - 1
    while (low <= high) {
      const mid = (low + high) >> 1
      if (offsets[mid + 1] <= target) low = mid + 1
      else if (offsets[mid] > target) high = mid - 1
      else return mid
    }
    return Math.max(0, Math.min(low, max - 1))
  }, [])

  // ── Filter Matching & Visible Rows Calculation ──
  const visibleRows = useMemo(() => {
    void version // re-evaluate visibility when the underlying cells change
    if (filters.size === 0) return null

    const used = engine.getUsedRange()
    const headerRow = used.minRow
    const rowsList = []

    // Header always visible
    rowsList.push(headerRow)

    for (let r = headerRow + 1; r < engine.rows; r++) {
      let passes = true
      for (const [col, filter] of filters.entries()) {
        const cell = engine.getCell(r, col)
        const rawVal = cell.computed !== null && cell.computed !== '' ? String(cell.computed) : cell.raw
        const trimmed = rawVal.trim()
        const normVal = trimmed.toLowerCase()

        // 1. Condition rules
        if (filter.condition && filter.condition.op !== 'none') {
          const { op, value } = filter.condition
          const normCond = (value || '').trim().toLowerCase()
          if (op === 'contains' && !normVal.includes(normCond)) passes = false
          if (op === 'greaterThan') {
            // Coerce through the engine so currency/percent cells compare numerically.
            const numC = toNum(trimmed)
            const numF = toNum(value)
            if (numC === null || numF === null || !(numC > numF)) passes = false
          }
          if (op === 'lessThan') {
            const numC = toNum(trimmed)
            const numF = toNum(value)
            if (numC === null || numF === null || !(numC < numF)) passes = false
          }
          if (op === 'isEmpty' && normVal !== '') passes = false
        }

        // 2. Checklist values
        if (passes && filter.selectedValues) {
          const checkKey = trimmed === '' ? '(blanks)' : trimmed.toLowerCase()
          let found = false
          for (const s of filter.selectedValues) {
            if (s.toLowerCase() === checkKey) {
              found = true
              break
            }
          }
          if (!found) passes = false
        }

        if (!passes) break
      }
      if (passes) rowsList.push(r)
    }

    return rowsList
  }, [filters, engine, version])

  // ── Virtual Visible Window ──
  const { visibleRowStart, visibleRowEnd, visibleColStart, visibleColEnd } = useMemo(() => {
    const startC = Math.max(0, findOffsetIndex(colOffsets, scrollState.scrollLeft, TOTAL_COLS) - OVERSCAN_COLS)
    const endC = Math.min(TOTAL_COLS - 1, findOffsetIndex(colOffsets, scrollState.scrollLeft + viewportSize.width, TOTAL_COLS) + OVERSCAN_COLS)

    let startR = 0, endR = TOTAL_ROWS - 1
    if (visibleRows === null) {
      startR = Math.max(0, findOffsetIndex(rowOffsets, scrollState.scrollTop, TOTAL_ROWS) - OVERSCAN_ROWS)
      endR = Math.min(TOTAL_ROWS - 1, findOffsetIndex(rowOffsets, scrollState.scrollTop + viewportSize.height, TOTAL_ROWS) + OVERSCAN_ROWS)
    } else {
      // With filters, map virtual scroll to visibleRows
      const visibleCount = visibleRows.length
      const idxStart = Math.max(0, Math.floor(scrollState.scrollTop / DEFAULT_ROW_HEIGHT) - OVERSCAN_ROWS)
      const idxEnd = Math.min(visibleCount - 1, Math.ceil((scrollState.scrollTop + viewportSize.height) / DEFAULT_ROW_HEIGHT) + OVERSCAN_ROWS)
      startR = idxStart
      endR = idxEnd
    }

    return {
      visibleRowStart: startR,
      visibleRowEnd: endR,
      visibleColStart: startC,
      visibleColEnd: endC,
    }
  }, [colOffsets, rowOffsets, scrollState, viewportSize, visibleRows, findOffsetIndex])

  // ── Total Grid Dimensions ──
  const totalGridWidth = colOffsets[TOTAL_COLS]
  const totalGridHeight = visibleRows === null
    ? rowOffsets[TOTAL_ROWS]
    : visibleRows.length * DEFAULT_ROW_HEIGHT

  // ── Sync Name Box with Active Cell ──
  useEffect(() => {
    setNameBoxInput(`${indexToColLetter(activeCell.c)}${activeCell.r + 1}`)
  }, [activeCell])

  // ── Scroll to Cell ──
  const scrollToCell = useCallback((r, c) => {
    if (!gridScrollRef.current) return
    const top = visibleRows === null
      ? rowOffsets[r]
      : (visibleRows.indexOf(r) !== -1 ? visibleRows.indexOf(r) * DEFAULT_ROW_HEIGHT : 0)
    const left = colOffsets[c]

    gridScrollRef.current.scrollTo({
      top: Math.max(0, top - 100),
      left: Math.max(0, left - 100),
      behavior: 'smooth',
    })
  }, [colOffsets, rowOffsets, visibleRows])

  // ── Handle Name Box Jump ──
  const handleNameBoxKeyDown = useCallback((e) => {
    if (e.key === 'Enter') {
      const coord = parseCellCoord(nameBoxInput.trim())
      if (coord && coord.row >= 0 && coord.row < TOTAL_ROWS && coord.col >= 0 && coord.col < TOTAL_COLS) {
        setActiveCell({ r: coord.row, c: coord.col })
        setSelection({ r1: coord.row, c1: coord.col, r2: coord.row, c2: coord.col })
        scrollToCell(coord.row, coord.col)
        e.currentTarget?.blur()
      }
    }
  }, [nameBoxInput, scrollToCell])

  // ── Cell Editing ──
  const startEditing = useCallback((row, col, initialChar = null) => {
    setActiveCell({ r: row, c: col })
    setEditingCell({ r: row, c: col })
    const cell = engine.getCell(row, col)
    setEditValue(initialChar !== null ? initialChar : cell.raw)
    setTimeout(() => cellInputRef.current?.focus(), 0)
  }, [engine])

  const commitEdit = useCallback((row, col) => {
    const current = engine.getCell(row, col)
    if (current.raw !== editValue) {
      engine.setCell(row, col, editValue)
      forceRerender()
    }
    setEditingCell(null)
  }, [engine, editValue, forceRerender])

  // ── Cell Selection & Drag ──
  const handleCellMouseDown = useCallback((r, c, e) => {
    if (e.shiftKey) {
      // Shift+Click extends selection
      setSelection(prev => ({
        r1: Math.min(prev.r1, r),
        c1: Math.min(prev.c1, c),
        r2: Math.max(prev.r2, r),
        c2: Math.max(prev.c2, c),
      }))
      setActiveCell({ r, c })
    } else {
      if (editingCell && (editingCell.r !== r || editingCell.c !== c)) {
        commitEdit(editingCell.r, editingCell.c)
      }
      setActiveCell({ r, c })
      setSelection({ r1: r, c1: c, r2: r, c2: c })
      setIsSelecting(true)
    }
  }, [editingCell, commitEdit])

  const handleCellMouseEnter = useCallback((r, c) => {
    if (isSelecting) {
      setSelection({
        r1: Math.min(activeCell.r, r),
        c1: Math.min(activeCell.c, c),
        r2: Math.max(activeCell.r, r),
        c2: Math.max(activeCell.c, c),
      })
    }
    if (fillDrag) {
      setFillDrag(prev => ({ ...prev, targetR: r, targetC: c }))
    }
  }, [isSelecting, activeCell, fillDrag])

  const handleMouseUp = useCallback(() => {
    setIsSelecting(false)
    if (fillDrag) {
      // Apply fill handle
      engine.applyFill({
        seedStartRow: selection.r1,
        seedStartCol: selection.c1,
        seedEndRow: selection.r2,
        seedEndCol: selection.c2,
        targetStartRow: selection.r1,
        targetStartCol: selection.c1,
        targetEndRow: fillDrag.targetR,
        targetEndCol: fillDrag.targetC,
      })
      forceRerender()
      setSelection({
        r1: Math.min(selection.r1, fillDrag.targetR),
        c1: Math.min(selection.c1, fillDrag.targetC),
        r2: Math.max(selection.r2, fillDrag.targetR),
        c2: Math.max(selection.c2, fillDrag.targetC),
      })
      setFillDrag(null)
    }
    if (resizingCol) {
      setResizingCol(null)
    }
  }, [fillDrag, engine, selection, forceRerender, resizingCol])

  useEffect(() => {
    window.addEventListener('mouseup', handleMouseUp)
    return () => window.removeEventListener('mouseup', handleMouseUp)
  }, [handleMouseUp])

  // ── Clipboard State (Ctrl+C / Ctrl+V / Ctrl+X) ──
  const clipboardRef = useRef(null)

  const handleCopy = useCallback(() => {
    const minR = Math.min(selection.r1, selection.r2)
    const maxR = Math.max(selection.r1, selection.r2)
    const minC = Math.min(selection.c1, selection.c2)
    const maxC = Math.max(selection.c1, selection.c2)

    const data = []
    const textRows = []
    for (let r = minR; r <= maxR; r++) {
      const row = []
      const textCols = []
      for (let c = minC; c <= maxC; c++) {
        const cell = engine.getCell(r, c)
        row.push({ raw: cell.raw, style: cell.style ? { ...cell.style } : null })
        textCols.push(cell.raw || '')
      }
      data.push(row)
      textRows.push(textCols.join('\t'))
    }
    clipboardRef.current = data
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(textRows.join('\n')).catch(() => {})
    }
  }, [selection, engine])

  const handlePaste = useCallback(async () => {
    let rowsToPaste = clipboardRef.current

    try {
      if (navigator.clipboard && navigator.clipboard.readText) {
        const text = await navigator.clipboard.readText()
        if (text && (!rowsToPaste || text.includes('\t') || text.includes('\n'))) {
          const lines = text.replace(/\r\n/g, '\n').split('\n')
          if (lines.length > 0 && !(lines.length === 1 && lines[0] === '')) {
            rowsToPaste = lines.map(line => line.split('\t').map(raw => ({ raw, style: null })))
          }
        }
      }
    } catch {
      // Use internal clipboard if system clipboard access is restricted
    }

    if (!rowsToPaste || rowsToPaste.length === 0) return

    const updates = []
    const startR = activeCell.r
    const startC = activeCell.c

    for (let rIdx = 0; rIdx < rowsToPaste.length; rIdx++) {
      for (let cIdx = 0; cIdx < rowsToPaste[rIdx].length; cIdx++) {
        const targetR = startR + rIdx
        const targetC = startC + cIdx
        if (targetR < TOTAL_ROWS && targetC < TOTAL_COLS) {
          const item = rowsToPaste[rIdx][cIdx]
          updates.push({
            r: targetR,
            c: targetC,
            raw: item.raw,
            style: item.style,
          })
        }
      }
    }

    if (updates.length > 0) {
      engine.setRange(updates, 'Paste')
      forceRerender()
      const endR = Math.min(TOTAL_ROWS - 1, startR + rowsToPaste.length - 1)
      const endC = Math.min(TOTAL_COLS - 1, startC + rowsToPaste[0].length - 1)
      setSelection({ r1: startR, c1: startC, r2: endR, c2: endC })
    }
  }, [activeCell, engine, forceRerender])

  // ── Keyboard Navigation (Ctrl+Home, Ctrl+End, Page Up/Down, Arrows) ──
  const handleKeyDown = useCallback((e) => {
    // Open AI with Ctrl+K / Cmd+K
    if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault()
      setAiPanelOpen(prev => !prev)
      return
    }

    const tag = e.target.tagName?.toLowerCase()
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      return
    }

    if (editingCell) {
      if (e.key === 'Enter') {
        e.preventDefault()
        commitEdit(editingCell.r, editingCell.c)
        const nextR = Math.min(editingCell.r + 1, TOTAL_ROWS - 1)
        setActiveCell({ r: nextR, c: editingCell.c })
        setSelection({ r1: nextR, c1: editingCell.c, r2: nextR, c2: editingCell.c })
      } else if (e.key === 'Tab') {
        e.preventDefault()
        commitEdit(editingCell.r, editingCell.c)
        const nextC = Math.min(editingCell.c + 1, TOTAL_COLS - 1)
        setActiveCell({ r: editingCell.r, c: nextC })
        setSelection({ r1: editingCell.r, c1: nextC, r2: editingCell.r, c2: nextC })
      } else if (e.key === 'Escape') {
        setEditingCell(null)
      }
      return
    }

    // Ctrl+A / Cmd+A: Select used range
    if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
      e.preventDefault()
      const used = engine.getUsedRange()
      if (used.rowCount > 0) {
        setSelection({ r1: used.minRow, c1: used.minCol, r2: used.maxRow, c2: used.maxCol })
      } else {
        setSelection({ r1: 0, c1: 0, r2: 50, c2: 20 })
      }
      return
    }

    // Ctrl+Home: Jump to A1
    if ((e.ctrlKey || e.metaKey) && e.key === 'Home') {
      e.preventDefault()
      setActiveCell({ r: 0, c: 0 })
      setSelection({ r1: 0, c1: 0, r2: 0, c2: 0 })
      scrollToCell(0, 0)
      return
    }

    // Ctrl+End: Jump to bottom-right of used range
    if ((e.ctrlKey || e.metaKey) && e.key === 'End') {
      e.preventDefault()
      const used = engine.getUsedRange()
      setActiveCell({ r: used.maxRow, c: used.maxCol })
      setSelection({ r1: used.maxRow, c1: used.maxCol, r2: used.maxRow, c2: used.maxCol })
      scrollToCell(used.maxRow, used.maxCol)
      return
    }

    // Ctrl+Z: Undo
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault()
      if (engine.undo()) forceRerender()
      return
    }

    // Ctrl+Y or Ctrl+Shift+Z: Redo
    if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.shiftKey && (e.key === 'z' || e.key === 'Z')))) {
      e.preventDefault()
      if (engine.redo()) forceRerender()
      return
    }

    // Ctrl+C / Cmd+C: Copy
    if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C')) {
      e.preventDefault()
      handleCopy()
      return
    }

    // Ctrl+V / Cmd+V: Paste
    if ((e.ctrlKey || e.metaKey) && (e.key === 'v' || e.key === 'V')) {
      e.preventDefault()
      handlePaste()
      return
    }

    // Ctrl+X / Cmd+X: Cut
    if ((e.ctrlKey || e.metaKey) && (e.key === 'x' || e.key === 'X')) {
      e.preventDefault()
      handleCopy()
      engine.clearRange(selection.r1, selection.c1, selection.r2, selection.c2)
      forceRerender()
      return
    }

    // Delete / Backspace: Clear selection in one undo step
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      engine.clearRange(selection.r1, selection.c1, selection.r2, selection.c2)
      forceRerender()
      return
    }

    // F2 or Enter: start editing
    if (e.key === 'F2' || e.key === 'Enter') {
      e.preventDefault()
      startEditing(activeCell.r, activeCell.c)
      return
    }

    // Navigation arrows
    if (['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'PageDown', 'PageUp'].includes(e.key)) {
      e.preventDefault()
      let deltaR = 0, deltaC = 0
      if (e.key === 'ArrowDown') deltaR = 1
      if (e.key === 'ArrowUp') deltaR = -1
      if (e.key === 'ArrowLeft') deltaC = -1
      if (e.key === 'ArrowRight') deltaC = 1
      if (e.key === 'PageDown') deltaR = 25
      if (e.key === 'PageUp') deltaR = -25

      const newR = Math.max(0, Math.min(TOTAL_ROWS - 1, activeCell.r + deltaR))
      const newC = Math.max(0, Math.min(TOTAL_COLS - 1, activeCell.c + deltaC))

      if (e.shiftKey) {
        // Extend selection
        setSelection(prev => ({
          r1: Math.min(prev.r1, newR),
          c1: Math.min(prev.c1, newC),
          r2: Math.max(prev.r2, newR),
          c2: Math.max(prev.c2, newC),
        }))
        setActiveCell({ r: newR, c: newC })
      } else {
        setActiveCell({ r: newR, c: newC })
        setSelection({ r1: newR, c1: newC, r2: newR, c2: newC })
      }
      scrollToCell(newR, newC)
      return
    }

    // Alphanumeric keys start editing with initial character
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault()
      startEditing(activeCell.r, activeCell.c, e.key)
    }
  }, [editingCell, commitEdit, engine, forceRerender, selection, activeCell, scrollToCell, startEditing, handleCopy, handlePaste])

  // ── Format Selection Actions ──
  const applySelectionFormat = useCallback((styleUpdates) => {
    const updates = []
    for (let r = selection.r1; r <= selection.r2; r++) {
      for (let c = selection.c1; c <= selection.c2; c++) {
        const cell = engine.getCell(r, c)
        updates.push({
          r,
          c,
          style: { ...cell.style, ...styleUpdates },
        })
      }
    }
    engine.setRange(updates, 'Format Selection')
    forceRerender()
  }, [selection, engine, forceRerender])

  const activeCellStyle = useMemo(() => {
    void version
    return engine.getCell(activeCell.r, activeCell.c).style
  }, [engine, activeCell, version])

  // ── Column Sorting ──
  const handleSortColumn = useCallback((col) => {
    const current = sortStates.get(col) || 'none'
    const nextDir = current === 'none' ? 'asc' : (current === 'asc' ? 'desc' : 'original')

    setSortStates(prev => {
      const next = new Map(prev)
      next.set(col, nextDir)
      return next
    })

    // If active selection spans multiple rows, sort within selection, else whole used range
    const isMultiRow = selection.r2 > selection.r1
    engine.sortRange({
      r1: isMultiRow ? selection.r1 : undefined,
      r2: isMultiRow ? selection.r2 : undefined,
      col,
      dir: nextDir,
      visibleRows: visibleRows !== null ? visibleRows : null,
    })
    forceRerender()
  }, [sortStates, selection, engine, visibleRows, forceRerender])

  // ── Column Resize ──
  const handleResizeMouseDown = useCallback((col, e) => {
    e.stopPropagation()
    setResizingCol({
      col,
      startX: e.clientX,
      startWidth: engine.getColWidth(col),
    })
  }, [engine])

  const handleResizeMouseMove = useCallback((e) => {
    if (resizingCol) {
      const delta = e.clientX - resizingCol.startX
      const newWidth = Math.max(30, Math.min(600, resizingCol.startWidth + delta))
      engine.setColWidth(resizingCol.col, newWidth)
      forceRerender()
    }
  }, [resizingCol, engine, forceRerender])

  const handleResizeDoubleClick = useCallback((col, e) => {
    e.stopPropagation()
    // Auto-fit column width on double-click
    const used = engine.getUsedRange()
    let maxLen = 4
    for (let r = used.minRow; r <= used.maxRow; r++) {
      const cell = engine.getCell(r, col)
      const text = String(cell.formatted || cell.raw || '')
      if (text.length > maxLen) maxLen = text.length
    }
    const autoWidth = Math.min(Math.max(Math.round(maxLen * 8.5 + 24), 65), 350)
    engine.setColWidth(col, autoWidth)
    forceRerender()
  }, [engine, forceRerender])

  useEffect(() => {
    if (resizingCol) {
      window.addEventListener('mousemove', handleResizeMouseMove)
      return () => window.removeEventListener('mousemove', handleResizeMouseMove)
    }
  }, [resizingCol, handleResizeMouseMove])

  // ── Filter Dropdown Logic ──
  const openFilterDropdown = useCallback((col, e) => {
    e.stopPropagation()
    const rect = e.currentTarget.getBoundingClientRect()
    setActiveFilterDropdown({
      col,
      x: rect.left,
      y: rect.bottom + 4,
    })
  }, [])

  const closeFilterDropdown = useCallback(() => {
    setActiveFilterDropdown(null)
  }, [])

  const distinctColumnValues = useMemo(() => {
    void version // refresh distinct values when the data changes
    if (!activeFilterDropdown) return []
    const col = activeFilterDropdown.col
    const used = engine.getUsedRange()
    const map = new Map() // lowercase -> canonical display
    for (let r = used.minRow + 1; r <= used.maxRow; r++) {
      const cell = engine.getCell(r, col)
      const val = cell.computed !== null && cell.computed !== '' ? String(cell.computed) : cell.raw
      const trimmed = val ? String(val).trim() : ''
      if (trimmed === '') {
        if (!map.has('(blanks)')) map.set('(blanks)', '(Blanks)')
      } else {
        const lower = trimmed.toLowerCase()
        if (!map.has(lower)) {
          // Capitalize first letter cleanly for display
          const display = trimmed.charAt(0).toUpperCase() + trimmed.slice(1)
          map.set(lower, display)
        }
      }
    }
    return Array.from(map.values()).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
  }, [activeFilterDropdown, engine, version])

  const [filterSearch, setFilterSearch] = useState('')
  const [filterSelectedValues, setFilterSelectedValues] = useState(new Set())
  const [filterConditionOp, setFilterConditionOp] = useState('none')
  const [filterConditionVal, setFilterConditionVal] = useState('')

  useEffect(() => {
    if (activeFilterDropdown) {
      const existing = filters.get(activeFilterDropdown.col)
      setFilterSearch('')
      if (existing) {
        setFilterSelectedValues(new Set(existing.selectedValues || distinctColumnValues))
        setFilterConditionOp(existing.condition?.op || 'none')
        setFilterConditionVal(existing.condition?.value || '')
      } else {
        setFilterSelectedValues(new Set(distinctColumnValues))
        setFilterConditionOp('none')
        setFilterConditionVal('')
      }
    }
  }, [activeFilterDropdown, filters, distinctColumnValues])

  const applyCurrentFilter = useCallback(() => {
    if (!activeFilterDropdown) return
    const col = activeFilterDropdown.col
    setFilters(prev => {
      const next = new Map(prev)
      next.set(col, {
        selectedValues: filterSelectedValues,
        condition: { op: filterConditionOp, value: filterConditionVal },
      })
      return next
    })
    closeFilterDropdown()
  }, [activeFilterDropdown, filterSelectedValues, filterConditionOp, filterConditionVal, closeFilterDropdown])

  const clearCurrentFilter = useCallback(() => {
    if (!activeFilterDropdown) return
    setFilters(prev => {
      const next = new Map(prev)
      next.delete(activeFilterDropdown.col)
      return next
    })
    closeFilterDropdown()
  }, [activeFilterDropdown, closeFilterDropdown])

  const clearAllFilters = useCallback(() => {
    setFilters(new Map())
  }, [])

  // ── Load Sample Data ──
  const loadSample = useCallback((loader) => {
    loader(engine)
    forceRerender()
    setActiveCell({ r: 0, c: 0 })
    setSelection({ r1: 0, c1: 0, r2: 0, c2: 0 })
    setFilters(new Map())
    setSortStates(new Map())
  }, [engine, forceRerender])

  // ── AI Execution (Ctrl+K) ──
  const buildSheetContext = useCallback(() => {
    const used = engine.getUsedRange()
    const headerRow = used.minRow
    const columns = []

    for (let c = used.minCol; c <= used.maxCol; c++) {
      const headerCell = engine.getCell(headerRow, c)
      const name = String(headerCell.computed !== null && headerCell.computed !== '' ? headerCell.computed : headerCell.raw).trim()
      const examples = []
      for (let r = headerRow + 1; r <= Math.min(headerRow + 5, used.maxRow); r++) {
        const val = engine.getCell(r, c).raw
        if (val) examples.push(val)
      }

      // Infer column type
      let type = 'text'
      if (examples.every(e => !isNaN(parseFloat(e)))) type = 'number'
      else if (examples.some(e => /^\$/.test(e))) type = 'currency'
      else if (examples.some(e => /%$/.test(e))) type = 'percent'
      else if (examples.some(e => /^\d{4}-\d{2}-\d{2}$|^\d{1,2}\/\d{1,2}\/\d{4}$/.test(e))) type = 'date'
      else if (examples.some(e => /^ORD-|^ID-/i.test(e))) type = 'id'

      columns.push({ name, index: c, type, examples })
    }

    const sampleRows = []
    for (let r = headerRow + 1; r <= Math.min(headerRow + 5, used.maxRow); r++) {
      const row = []
      for (let c = used.minCol; c <= used.maxCol; c++) {
        row.push(engine.getCell(r, c).raw)
      }
      sampleRows.push(row)
    }

    return {
      range: `${indexToColLetter(used.minCol)}${used.minRow + 1}:${indexToColLetter(used.maxCol)}${used.maxRow + 1}`,
      rowCount: used.rowCount - 1,
      columns,
      sampleRows,
      selection: `${indexToColLetter(selection.c1)}${selection.r1 + 1}:${indexToColLetter(selection.c2)}${selection.r2 + 1}`,
      hasTotalsRow: used.hasTotalsRow,
    }
  }, [engine, selection])

  const handleSendAiPrompt = useCallback(async (promptText = aiPrompt) => {
    if (!promptText.trim()) return
    setAiLoading(true)
    setAiError(null)

    try {
      const context = buildSheetContext()
      const systemPrompt = `You translate a spreadsheet user's intent into a single JSON action. You never compute results yourself — the app runs the plan over the real data.

Return exactly one JSON object, no prose, with one of these "type" values:

1. "query" — read-only analysis. Optional fields:
   - excludeTotalsRow (boolean, default true)
   - filters: [{ column, op, value }], op one of: ${FILTER_OPS.join(', ')}
   - groupBy: [column names]
   - aggregates: [{ fn, column, as? }], fn one of: ${AGGREGATE_FNS.join(', ')}
   - columns: [column names]   (only for row results, no aggregates)
   - sort: [{ column, dir }], dir "asc" or "desc"
   - limit: positive integer (capped at ${MAX_RESULT_ROWS})
2. "format_sheet" — styling intent. Optional fields: clearFormatting, headerStyle, bodyStyle, totalsStyle, columns ([{ col, style }]), freezeRows, columnWidths ([{ col, width }]), autoFitColumns. A style may set: bold, italic, underline, bg, color, align, fontSize, numberFormat (one of: ${NUMBER_FORMATS.join(', ')}).
3. "clarify" — { question } when the request is ambiguous or names a column that does not exist.

Use column names exactly as they appear in the provided headers. If a needed column is not present, return a clarify action instead of guessing.`

      const response = await aiProvider.complete({
        system: systemPrompt,
        user: aiProvider.name === 'mock' ? promptText : `${JSON.stringify(context, null, 2)}\n\nUser Prompt: ${promptText}`,
      })

      const parseRes = extractAndParseJSON(response.text)
      if (!parseRes.ok) {
        throw new Error(`Parse failure: ${parseRes.detail}`)
      }

      const valRes = validateAction(parseRes.data)
      if (!valRes.valid) {
        throw new Error(`Validation error [${valRes.error}]: ${valRes.detail}`)
      }

      const action = valRes.action

      if (action.type === ACTION_TYPES.CLARIFY) {
        setAiCards(prev => [{
          id: Date.now(),
          type: 'clarify',
          prompt: promptText,
          question: action.question,
          plan: action,
        }, ...prev])
      } else if (action.type === ACTION_TYPES.QUERY) {
        const queryRes = executeQuery(action, engine)
        if (queryRes.error) {
          throw new Error(`Execution error [${queryRes.error}]: ${queryRes.detail}`)
        }
        setAiCards(prev => [{
          id: Date.now(),
          type: 'query',
          prompt: promptText,
          plan: action,
          description: describeQueryPlan(action),
          result: queryRes,
        }, ...prev])
      } else if (action.type === ACTION_TYPES.FORMAT_SHEET) {
        const preview = describeFormatPreview(action)
        setAiCards(prev => [{
          id: Date.now(),
          type: 'format_sheet',
          prompt: promptText,
          plan: action,
          preview,
          applied: false,
        }, ...prev])
      }

      setAiPrompt('')
    } catch (err) {
      setAiError(err.message)
    } finally {
      setAiLoading(false)
    }
  }, [aiPrompt, buildSheetContext, aiProvider, engine])

  const handleApplyAiFormat = useCallback((card) => {
    const res = applyFormatSheet(card.plan, engine)
    if (res.error) {
      // Surface the result in the panel rather than a blocking dialog.
      setAiError(`${res.error}: ${res.detail}`)
      return
    }
    setAiError(null)
    forceRerender()
    setAiCards(prev => prev.map(c => c.id === card.id ? { ...c, applied: true } : c))
  }, [engine, forceRerender])

  const handleInsertAiQueryResult = useCallback((card) => {
    const { columns, rows } = card.result
    const startR = activeCell.r
    const startC = activeCell.c

    const updates = []
    // Header row, then one row per result record — all as one undo step.
    for (let c = 0; c < columns.length; c++) {
      updates.push({ r: startR, c: startC + c, raw: String(columns[c]) })
    }
    for (let r = 0; r < rows.length; r++) {
      for (let c = 0; c < rows[r].length; c++) {
        updates.push({ r: startR + 1 + r, c: startC + c, raw: String(rows[r][c] ?? '') })
      }
    }

    engine.setRange(updates, 'Insert AI Query Result')
    forceRerender()
    setAiCards(prev => prev.map(c => c.id === card.id
      ? { ...c, insertedAt: `${indexToColLetter(startC)}${startR + 1}` }
      : c))
  }, [activeCell, engine, forceRerender])

  // Re-run re-executes the stored plan over the sheet — no provider call.
  const handleRerunAiQuery = useCallback((card) => {
    const queryRes = executeQuery(card.plan, engine)
    if (queryRes.error) {
      setAiError(`${queryRes.error}: ${queryRes.detail}`)
      return
    }
    setAiError(null)
    setAiCards(prev => prev.map(c => c.id === card.id ? { ...c, result: queryRes } : c))
  }, [engine])

  // ── Derived Selection Geometry ──
  const selBoxStyle = useMemo(() => {
    const left = colOffsets[selection.c1]
    const width = colOffsets[selection.c2 + 1] - left
    const top = visibleRows === null
      ? rowOffsets[selection.r1]
      : (visibleRows.indexOf(selection.r1) !== -1 ? visibleRows.indexOf(selection.r1) * DEFAULT_ROW_HEIGHT : 0)
    const bottom = visibleRows === null
      ? rowOffsets[selection.r2 + 1]
      : (visibleRows.indexOf(selection.r2) !== -1 ? (visibleRows.indexOf(selection.r2) + 1) * DEFAULT_ROW_HEIGHT : top + DEFAULT_ROW_HEIGHT)
    const height = bottom - top

    return {
      left: `${left}px`,
      top: `${top}px`,
      width: `${Math.max(2, width)}px`,
      height: `${Math.max(2, height)}px`,
    }
  }, [selection, colOffsets, rowOffsets, visibleRows])

  // ── Derived Fill Preview Geometry ──
  const fillPreviewStyle = useMemo(() => {
    if (!fillDrag) return null
    const minC = Math.min(selection.c1, fillDrag.targetC)
    const maxC = Math.max(selection.c2, fillDrag.targetC)
    const minR = Math.min(selection.r1, fillDrag.targetR)
    const maxR = Math.max(selection.r2, fillDrag.targetR)

    const left = colOffsets[minC]
    const width = colOffsets[maxC + 1] - left
    const top = visibleRows === null
      ? rowOffsets[minR]
      : (visibleRows.indexOf(minR) !== -1 ? visibleRows.indexOf(minR) * DEFAULT_ROW_HEIGHT : 0)
    const bottom = visibleRows === null
      ? rowOffsets[maxR + 1]
      : (visibleRows.indexOf(maxR) !== -1 ? (visibleRows.indexOf(maxR) + 1) * DEFAULT_ROW_HEIGHT : top + DEFAULT_ROW_HEIGHT)
    const height = bottom - top

    return {
      left: `${left}px`,
      top: `${top}px`,
      width: `${Math.max(2, width)}px`,
      height: `${Math.max(2, height)}px`,
    }
  }, [fillDrag, selection, colOffsets, rowOffsets, visibleRows])

  // ── Formula Bar Value ──
  const formulaBarValue = editingCell
    ? editValue
    : (activeCell ? engine.getCell(activeCell.r, activeCell.c).raw : '')

  return (
    <div className="app-wrapper" onKeyDown={handleKeyDown} tabIndex={0}>
      {/* ── Header ── */}
      <div className="app-header">
        <div className="header-left">
          <div className="app-title-badge">
            <span>📊</span>
            <span>SpreadsheetApp</span>
          </div>
          <span className="sheet-badge">100k × 200 Virtualized</span>
        </div>
        <div className="header-right">
          <button className="ai-toggle-btn" onClick={() => setAiPanelOpen(prev => !prev)} title="AI Assistant (Ctrl+K)">
            <span>✨</span>
            <span>AI Assistant</span>
            <span style={{ opacity: 0.8, fontSize: 11 }}>Ctrl+K</span>
          </button>
        </div>
      </div>

      {/* ── Toolbar ── */}
      <div className="toolbar">
        <div className="toolbar-group">
          <button className="toolbar-btn" onClick={() => { if (engine.undo()) forceRerender() }} disabled={!engine.canUndo()} title="Undo (Ctrl+Z)">↶ Undo</button>
          <button className="toolbar-btn" onClick={() => { if (engine.redo()) forceRerender() }} disabled={!engine.canRedo()} title="Redo (Ctrl+Y)">↷ Redo</button>
        </div>

        <div className="toolbar-group">
          <button className={`toolbar-btn bold-btn ${activeCellStyle.bold ? 'active' : ''}`} onClick={() => applySelectionFormat({ bold: !activeCellStyle.bold })} title="Bold (Ctrl+B)">B</button>
          <button className={`toolbar-btn italic-btn ${activeCellStyle.italic ? 'active' : ''}`} onClick={() => applySelectionFormat({ italic: !activeCellStyle.italic })} title="Italic (Ctrl+I)">I</button>
          <button className={`toolbar-btn underline-btn ${activeCellStyle.underline ? 'active' : ''}`} onClick={() => applySelectionFormat({ underline: !activeCellStyle.underline })} title="Underline (Ctrl+U)">U</button>
        </div>

        <div className="toolbar-group">
          <span className="toolbar-label">Size:</span>
          <select className="toolbar-select" value={activeCellStyle.fontSize || 13} onChange={(e) => applySelectionFormat({ fontSize: parseInt(e.target.value) })}>
            {[8, 10, 11, 12, 13, 14, 16, 18, 20, 24].map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>

        <div className="toolbar-group">
          <button className={`toolbar-btn ${activeCellStyle.align === 'left' ? 'active' : ''}`} onClick={() => applySelectionFormat({ align: 'left' })}>⬤←</button>
          <button className={`toolbar-btn ${activeCellStyle.align === 'center' ? 'active' : ''}`} onClick={() => applySelectionFormat({ align: 'center' })}>⬤</button>
          <button className={`toolbar-btn ${activeCellStyle.align === 'right' ? 'active' : ''}`} onClick={() => applySelectionFormat({ align: 'right' })}>⬤→</button>
        </div>

        <div className="toolbar-group">
          <span className="toolbar-label">Format:</span>
          <select className="toolbar-select" value={activeCellStyle.numberFormat || 'general'} onChange={(e) => applySelectionFormat({ numberFormat: e.target.value })}>
            <option value="general">General</option>
            <option value="number">Number (1,200.00)</option>
            <option value="currency">Currency ($1,200.00)</option>
            <option value="percent">Percent (10%)</option>
            <option value="date">Date (2024-01-15)</option>
          </select>
        </div>

        <div className="toolbar-group">
          <span className="toolbar-label">Color:</span>
          <input type="color" value={activeCellStyle.color || '#202124'} onChange={(e) => applySelectionFormat({ color: e.target.value })} style={{ width: 26, height: 26, border: 'none', cursor: 'pointer' }} />
          <span className="toolbar-label" style={{ marginLeft: 4 }}>Fill:</span>
          <select className="toolbar-select" value={activeCellStyle.bg || 'white'} onChange={(e) => applySelectionFormat({ bg: e.target.value })}>
            <option value="white">White</option>
            <option value="#ffff99">Yellow</option>
            <option value="#99ffcc">Green</option>
            <option value="#ffcccc">Red</option>
            <option value="#cce5ff">Blue</option>
            <option value="#f0f0f0">Grey</option>
          </select>
        </div>

        <div className="toolbar-group">
          <button className="toolbar-btn" onClick={() => { engine.insertRow(activeCell.r); forceRerender() }}>+ Row</button>
          <button className="toolbar-btn" onClick={() => { engine.deleteRow(activeCell.r); forceRerender() }}>- Row</button>
          <button className="toolbar-btn" onClick={() => { engine.insertColumn(activeCell.c); forceRerender() }}>+ Col</button>
          <button className="toolbar-btn" onClick={() => { engine.deleteColumn(activeCell.c); forceRerender() }}>- Col</button>
        </div>

        <div className="toolbar-group">
          <button className="toolbar-btn danger" onClick={() => { engine.clearRange(selection.r1, selection.c1, selection.r2, selection.c2); forceRerender() }}>✕ Clear</button>
          {filters.size > 0 && (
            <button className="toolbar-btn" onClick={clearAllFilters} style={{ background: '#fce8e6', color: '#c5221f' }}>Clear Filters ({filters.size})</button>
          )}
        </div>

        <div className="toolbar-group">
          <button className="toolbar-btn sample-btn" onClick={() => loadSample(loadSampleSmall)}>⬇ Sample 33</button>
          <button className="toolbar-btn sample-btn" onClick={() => loadSample(loadSampleLarge)}>⬇ Sample 3k</button>
        </div>
      </div>

      {/* ── Formula Bar & Name Box ── */}
      <div className="formula-bar-container">
        <input className="name-box" value={nameBoxInput} onChange={(e) => setNameBoxInput(e.target.value)} onKeyDown={handleNameBoxKeyDown} title="Name Box (Jump to cell)" />
        <span className="formula-icon">fx</span>
        <input
          className="formula-bar-input"
          value={formulaBarValue}
          onChange={(e) => {
            if (!editingCell) setEditingCell(activeCell)
            setEditValue(e.target.value)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              commitEdit(activeCell.r, activeCell.c)
            }
          }}
          placeholder="Enter a value or formula (=SUM, =AVG, =MIN, =MAX, + - * /)"
        />
      </div>

      {/* ── Workspace ── */}
      <div className="workspace">
        <div className="grid-container">
          {/* Top-left sticky corner */}
          <div
            className="grid-corner"
            style={{ width: `${ROW_HEADER_WIDTH}px`, height: `${COL_HEADER_HEIGHT}px` }}
            onClick={() => {
              const used = engine.getUsedRange()
              setSelection({ r1: 0, c1: 0, r2: Math.max(50, used.maxRow), c2: Math.max(20, used.maxCol) })
            }}
          >
            <div className="corner-triangle" />
          </div>

          {/* Frozen Column Header Pane */}
          <div
            className="frozen-col-header-pane"
            style={{
              left: `${ROW_HEADER_WIDTH}px`,
              right: 0,
              height: `${COL_HEADER_HEIGHT}px`,
            }}
            onWheel={(e) => {
              if (gridScrollRef.current) {
                gridScrollRef.current.scrollLeft += e.deltaX || e.deltaY
              }
            }}
          >
            {Array.from({ length: visibleColEnd - visibleColStart + 1 }, (_, idx) => {
              const col = visibleColStart + idx
              const colLeft = colOffsets[col] - scrollState.scrollLeft
              const colWidth = engine.getColWidth(col)
              const isColSelected = selection.c1 <= col && col <= selection.c2
              const sortDir = sortStates.get(col)
              const hasFilter = filters.has(col)

              return (
                <div
                  key={col}
                  data-col={col}
                  className={`col-header-cell ${isColSelected ? 'selected' : ''}`}
                  style={{ left: `${colLeft}px`, width: `${colWidth}px` }}
                  onClick={() => handleSortColumn(col)}
                >
                  <div className="col-header-content">
                    <span className="col-header-label">{indexToColLetter(col)}</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                      {sortDir && <span className="col-sort-indicator">{sortDir === 'asc' ? '▲' : (sortDir === 'desc' ? '▼' : '')}</span>}
                      <button
                        className={`col-filter-btn ${hasFilter ? 'active' : ''}`}
                        onClick={(e) => openFilterDropdown(col, e)}
                        title="Filter column"
                      >
                        ▼
                      </button>
                    </div>
                  </div>
                  <div
                    className="col-resize-handle"
                    onMouseDown={(e) => handleResizeMouseDown(col, e)}
                    onDoubleClick={(e) => handleResizeDoubleClick(col, e)}
                  />
                </div>
              )
            })}
          </div>

          {/* Frozen Row Header Pane */}
          <div
            className="frozen-row-header-pane"
            style={{
              top: `${COL_HEADER_HEIGHT}px`,
              bottom: 0,
              width: `${ROW_HEADER_WIDTH}px`,
            }}
            onWheel={(e) => {
              if (gridScrollRef.current) {
                gridScrollRef.current.scrollTop += e.deltaY
              }
            }}
          >
            {Array.from({ length: visibleRowEnd - visibleRowStart + 1 }, (_, idx) => {
              const rowPointer = visibleRowStart + idx
              const actualRow = visibleRows === null ? rowPointer : visibleRows[rowPointer]
              if (actualRow === undefined) return null

              const rawTop = visibleRows === null ? rowOffsets[actualRow] : rowPointer * DEFAULT_ROW_HEIGHT
              const rowTop = rawTop - scrollState.scrollTop
              const rowHeight = visibleRows === null ? engine.getRowHeight(actualRow) : DEFAULT_ROW_HEIGHT
              const isRowSelected = selection.r1 <= actualRow && actualRow <= selection.r2

              return (
                <div
                  key={actualRow}
                  data-row={actualRow}
                  className={`row-header-cell ${isRowSelected ? 'selected' : ''}`}
                  style={{ top: `${rowTop}px`, height: `${rowHeight}px` }}
                  onClick={() => {
                    setActiveCell({ r: actualRow, c: 0 })
                    setSelection({ r1: actualRow, c1: 0, r2: actualRow, c2: TOTAL_COLS - 1 })
                  }}
                >
                  {actualRow + 1}
                </div>
              )
            })}
          </div>

          {/* Grid Scroll Body */}
          <div
            className="grid-body-scroll"
            ref={gridScrollRef}
            style={{
              marginLeft: `${ROW_HEADER_WIDTH}px`,
              marginTop: `${COL_HEADER_HEIGHT}px`,
            }}
            onScroll={(e) => {
              setScrollState({
                scrollTop: e.currentTarget.scrollTop,
                scrollLeft: e.currentTarget.scrollLeft,
              })
            }}
          >
            <div
              className="grid-body-inner"
              style={{
                width: `${totalGridWidth}px`,
                height: `${totalGridHeight}px`,
              }}
            >
              {/* Range Selection Highlight Box */}
              <div className="selection-box" style={selBoxStyle}>
                {/* Fill Handle Square */}
                <div
                  className="fill-handle"
                  onMouseDown={(e) => {
                    e.stopPropagation()
                    setFillDrag({ targetR: selection.r2, targetC: selection.c2 })
                  }}
                  title="Drag to fill series"
                />
              </div>

              {/* Fill Preview Drag Box */}
              {fillPreviewStyle && (
                <div className="fill-preview-box" style={fillPreviewStyle} />
              )}

              {/* Rendered Visible Cells */}
              {Array.from({ length: visibleRowEnd - visibleRowStart + 1 }, (_, rIdx) => {
                const rowPointer = visibleRowStart + rIdx
                const r = visibleRows === null ? rowPointer : visibleRows[rowPointer]
                if (r === undefined) return null

                const cellTop = visibleRows === null ? rowOffsets[r] : rowPointer * DEFAULT_ROW_HEIGHT
                const cellHeight = visibleRows === null ? engine.getRowHeight(r) : DEFAULT_ROW_HEIGHT

                return Array.from({ length: visibleColEnd - visibleColStart + 1 }, (_, cIdx) => {
                  const c = visibleColStart + cIdx
                  const cellLeft = colOffsets[c]
                  const cellWidth = engine.getColWidth(c)
                  const isEditing = editingCell?.r === r && editingCell?.c === c
                  const cellData = engine.getCell(r, c)
                  const style = cellData.style || {}

                  return (
                    <div
                      key={`${r},${c}`}
                      data-row={r}
                      data-col={c}
                      className={`cell-item ${cellData.error ? 'error-cell' : ''}`}
                      style={{
                        top: `${cellTop}px`,
                        left: `${cellLeft}px`,
                        width: `${cellWidth}px`,
                        height: `${cellHeight}px`,
                        background: style.bg || 'white',
                        fontWeight: style.bold ? 'bold' : 'normal',
                        fontStyle: style.italic ? 'italic' : 'normal',
                        textDecoration: style.underline ? 'underline' : 'none',
                        color: cellData.error ? '#d93025' : (style.color || '#202124'),
                        fontSize: `${style.fontSize || 13}px`,
                        textAlign: style.align || 'left',
                        justifyContent: style.align === 'right' ? 'flex-end' : (style.align === 'center' ? 'center' : 'flex-start'),
                      }}
                      onMouseDown={(e) => handleCellMouseDown(r, c, e)}
                      onMouseEnter={() => handleCellMouseEnter(r, c)}
                      onDoubleClick={() => startEditing(r, c)}
                    >
                      {isEditing ? (
                        <input
                          autoFocus
                          ref={cellInputRef}
                          className="cell-editor-input"
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onBlur={() => commitEdit(r, c)}
                        />
                      ) : (
                        <span>{cellData.formatted}</span>
                      )}
                    </div>
                  )
                })
              })}
            </div>
          </div>
        </div>

        {/* ── AI Assistant Side Panel (Ctrl+K) ── */}
        {aiPanelOpen && (
          <div className="ai-panel">
            <div className="ai-panel-header">
              <div className="ai-header-title">
                <span>✨</span>
                <span>AI Assistant</span>
              </div>
              <button className="ai-close-btn" onClick={() => setAiPanelOpen(false)}>✕</button>
            </div>

            <div className="ai-provider-selector">
              <span style={{ color: '#5f6368', fontWeight: 500 }}>Provider:</span>
              <button
                className={`toolbar-btn ${aiProviderKind === 'mock' ? 'active' : ''}`}
                onClick={() => setAiProviderKind('mock')}
              >
                Mock (Golden Set)
              </button>
              <button
                className={`toolbar-btn ${aiProviderKind === 'http' ? 'active' : ''}`}
                onClick={() => setAiProviderKind('http')}
              >
                HTTP (.env.local)
              </button>
              <span className={`ai-provider-badge ${aiProviderKind}`}>
                {aiProviderKind.toUpperCase()}
              </span>
            </div>

            <div className="ai-body">
              {aiError && (
                <div className="ai-error-banner">
                  <span>⚠️ {aiError}</span>
                </div>
              )}

              {/* Suggestions Chips */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={{ fontSize: 11, fontWeight: 600, color: '#5f6368' }}>Try a golden prompt:</span>
                <div className="ai-suggestions-list">
                  {[
                    'Total sales by region',
                    'Top 3 sales reps by total sales',
                    'Average discount on Electronics orders',
                    'Format this as a clean table',
                    'Make the header row bold and blue',
                    'Show unit prices and totals as currency with two decimals',
                  ].map(p => (
                    <span key={p} className="ai-chip" onClick={() => handleSendAiPrompt(p)}>{p}</span>
                  ))}
                </div>
              </div>

              {/* Result Cards */}
              {aiCards.map(card => (
                <div key={card.id} className="ai-card">
                  <div className="ai-card-title">
                    <span>{card.type === 'query' ? '📊 Analysis Plan' : (card.type === 'format_sheet' ? '🎨 Formatting Plan' : '💬 Clarify')}</span>
                    <span style={{ fontSize: 11, color: '#5f6368' }}>{card.prompt}</span>
                  </div>

                  {card.type === 'query' && (
                    <>
                      <div className="ai-description">{card.description}</div>
                      <div className="ai-result-table-wrap">
                        <table className="ai-result-table">
                          <thead>
                            <tr>
                              {card.result.columns.map(c => <th key={c}>{c}</th>)}
                            </tr>
                          </thead>
                          <tbody>
                            {card.result.rows.slice(0, 10).map((row, rIdx) => (
                              <tr key={rIdx}>
                                {row.map((val, cIdx) => <td key={cIdx}>{String(val)}</td>)}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <span style={{ fontSize: 11, color: '#5f6368' }}>
                        Showing {card.result.rows.length} rows {card.result.truncated ? '(truncated at limit)' : ''}
                      </span>
                      <div className="ai-card-actions">
                        <button className="ai-btn primary" onClick={() => handleInsertAiQueryResult(card)}>Insert into Sheet</button>
                        <button className="ai-btn" onClick={() => handleRerunAiQuery(card)}>Re-run</button>
                      </div>
                      {card.insertedAt && (
                        <span style={{ fontSize: 11, color: '#188038' }}>Inserted at {card.insertedAt}</span>
                      )}
                    </>
                  )}

                  {card.type === 'format_sheet' && (
                    <>
                      <div className="ai-description">{card.preview}</div>
                      <div className="ai-card-actions">
                        <button
                          className="ai-btn primary"
                          onClick={() => handleApplyAiFormat(card)}
                          disabled={card.applied}
                        >
                          {card.applied ? '✓ Applied' : 'Apply to Sheet'}
                        </button>
                        <button
                          className="ai-btn cancel-btn"
                          onClick={() => setAiCards(prev => prev.filter(c => c.id !== card.id))}
                        >
                          Cancel
                        </button>
                      </div>
                    </>
                  )}

                  {card.type === 'clarify' && (
                    <div className="ai-description" style={{ background: '#fef7e0', color: '#b06000' }}>
                      {card.question}
                    </div>
                  )}

                  {/* Show Plan Toggle */}
                  <details style={{ marginTop: 4 }}>
                    <summary style={{ fontSize: 11, color: '#1a73e8', cursor: 'pointer' }}>Show Plan JSON</summary>
                    <pre className="ai-plan-json">{JSON.stringify(card.plan, null, 2)}</pre>
                  </details>
                </div>
              ))}
            </div>

            <div className="ai-input-wrap">
              <textarea
                className="ai-input"
                rows={2}
                value={aiPrompt}
                onChange={(e) => setAiPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    handleSendAiPrompt()
                  }
                }}
                placeholder="Ask your data or format sheet... (Enter to send)"
              />
              <button
                className="ai-send-btn"
                onClick={() => handleSendAiPrompt()}
                disabled={aiLoading}
              >
                {aiLoading ? 'Thinking...' : 'Generate Plan'}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ── Status Bar ── */}
      <div className="status-bar">
        <div className="status-left">
          <span>{visibleRows !== null ? `${visibleRows.length - 1} of ${engine.getUsedRange().rowCount - 1} rows` : `${Math.max(0, engine.getUsedRange().rowCount - 1)} rows`}</span>
          {selection && (
            <span className="status-badge">
              {indexToColLetter(selection.c1)}{selection.r1 + 1}:{indexToColLetter(selection.c2)}{selection.r2 + 1}
              {' '}({(selection.r2 - selection.r1 + 1) * (selection.c2 - selection.c1 + 1)} cells)
            </span>
          )}
        </div>
        <div className="status-right">
          <span>{aiProviderKind === 'mock' ? 'Mock Offline Mode' : 'HTTP Live Mode'}</span>
        </div>
      </div>

      {/* ── Filter Dropdown Popup ── */}
      {activeFilterDropdown && (
        <>
          <div className="filter-dropdown-backdrop" onClick={closeFilterDropdown} />
          <div
            className="filter-dropdown"
            style={{
              left: `${Math.min(activeFilterDropdown.x, window.innerWidth - 270)}px`,
              top: `${activeFilterDropdown.y}px`,
            }}
          >
            <div className="filter-title">
              <span>Filter: Column {indexToColLetter(activeFilterDropdown.col)}</span>
              <button style={{ border: 'none', background: 'transparent', cursor: 'pointer' }} onClick={closeFilterDropdown}>✕</button>
            </div>

            {/* Condition Filter */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: '#5f6368' }}>Condition:</span>
              <select
                className="toolbar-select"
                value={filterConditionOp}
                onChange={(e) => setFilterConditionOp(e.target.value)}
              >
                <option value="none">None</option>
                <option value="contains">Text contains</option>
                <option value="greaterThan">Greater than</option>
                <option value="lessThan">Less than</option>
                <option value="isEmpty">Is empty</option>
              </select>
              {filterConditionOp !== 'none' && filterConditionOp !== 'isEmpty' && (
                <input
                  className="filter-search-input"
                  value={filterConditionVal}
                  onChange={(e) => setFilterConditionVal(e.target.value)}
                  placeholder="Value..."
                />
              )}
            </div>

            {/* Values Checklist */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: '#5f6368' }}>Filter by values:</span>
              <input
                className="filter-search-input"
                placeholder="Search values..."
                value={filterSearch}
                onChange={(e) => setFilterSearch(e.target.value)}
              />
              <div style={{ display: 'flex', gap: 8, fontSize: 11 }}>
                <span style={{ color: '#1a73e8', cursor: 'pointer' }} onClick={() => setFilterSelectedValues(new Set(distinctColumnValues))}>Select All</span>
                <span style={{ color: '#1a73e8', cursor: 'pointer' }} onClick={() => setFilterSelectedValues(new Set())}>Clear</span>
              </div>
              <div className="filter-values-list">
                {distinctColumnValues
                  .filter(v => v.toLowerCase().includes(filterSearch.toLowerCase()))
                  .map(val => (
                    <label key={val} className="filter-checkbox-item">
                      <input
                        type="checkbox"
                        checked={filterSelectedValues.has(val)}
                        onChange={(e) => {
                          const next = new Set(filterSelectedValues)
                          if (e.target.checked) next.add(val)
                          else next.delete(val)
                          setFilterSelectedValues(next)
                        }}
                      />
                      <span>{val}</span>
                    </label>
                  ))}
              </div>
            </div>

            <div className="filter-actions-row">
              <button className="filter-btn-sm" onClick={clearCurrentFilter}>Clear Filter</button>
              <button className="filter-btn-sm" onClick={closeFilterDropdown}>Cancel</button>
              <button className="filter-btn-sm primary" onClick={applyCurrentFilter}>Apply</button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

// Imperative virtual grid. React renders the chrome around it; this class owns
// the cell DOM. A transparent native scroller sits on top and receives wheel,
// mouse and keyboard input; cells live in clipped layers underneath and are a
// pooled, keyed set of divs re-positioned at most once per animation frame.
// Hit-testing is arithmetic on prefix sums, so no handler reads layout.

import { colLabel } from '../engine/formula.js'
import { parseDate, toNum } from '../engine/values.js'
import { DEFAULT_ROW_HEIGHT } from '../engine/core.js'

const ROW_HEADER_WIDTH = 52
const COL_HEADER_HEIGHT = 26
const OVERSCAN_ROWS = 6
const OVERSCAN_COLS = 2
const HANDLE = 7
const RESIZE_ZONE = 5
const FILTER_ZONE = 20

/** Prefix sums of sizes; hidden entries have size 0. */
function prefix(count, sizeAt) {
  const sums = new Float64Array(count + 1)
  for (let i = 0; i < count; i++) sums[i + 1] = sums[i] + sizeAt(i)
  return sums
}

/** Index whose span contains `offset` (binary search). */
function indexAt(sums, offset) {
  let lo = 0, hi = sums.length - 2
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (sums[mid] <= offset) lo = mid; else hi = mid - 1
  }
  return Math.max(0, lo)
}

const el = (tag, className, parent) => {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (parent) parent.appendChild(node)
  return node
}

export const rangeOf = s => ({ r1: Math.min(s.ar, s.fr), c1: Math.min(s.ac, s.fc), r2: Math.max(s.ar, s.fr), c2: Math.max(s.ac, s.fc) })

export class GridView {
  constructor(host, engine, handlers) {
    this.host = host
    this.engine = engine
    this.handlers = handlers
    this.sel = { ar: 0, ac: 0, fr: 0, fc: 0 }
    this.scrollX = 0; this.scrollY = 0; this.width = 0; this.height = 0
    this.frame = 0
    this.layoutVersion = -1; this.dataVersion = -1
    this.drag = null
    this.editing = null
    this.fillPreview = null
    this.copyRange = null
    this.measureCtx = null
    this.build()
    this.bind()
    this.schedule()
  }

  // ── DOM skeleton ─────────────────────────────────────────

  build() {
    const host = this.host
    host.classList.add('grid-host')
    this.layers = el('div', 'grid-layers', host)
    const layer = (name) => {
      const clip = el('div', `grid-layer ${name}`, this.layers)
      const inner = el('div', 'grid-layer-inner', clip)
      const overlay = { sel: el('div', 'sel-rect', inner), active: el('div', 'active-cell', inner), handle: el('div', 'fill-handle', inner), fill: el('div', 'fill-preview', inner) }
      return { clip, inner, overlay, pool: new Map(), spare: [] }
    }
    this.body = layer('layer-body')
    this.frozenTop = layer('layer-top')
    this.frozenLeft = layer('layer-left')
    this.frozenCorner = layer('layer-corner')
    this.colHeads = { clip: el('div', 'grid-layer layer-colheads', this.layers), pool: new Map(), spare: [] }
    this.colHeads.inner = el('div', 'grid-layer-inner', this.colHeads.clip)
    this.colHeadsFrozen = { clip: el('div', 'grid-layer layer-colheads-frozen', this.layers), pool: new Map(), spare: [] }
    this.colHeadsFrozen.inner = el('div', 'grid-layer-inner', this.colHeadsFrozen.clip)
    this.rowHeads = { clip: el('div', 'grid-layer layer-rowheads', this.layers), pool: new Map(), spare: [] }
    this.rowHeads.inner = el('div', 'grid-layer-inner', this.rowHeads.clip)
    this.rowHeadsFrozen = { clip: el('div', 'grid-layer layer-rowheads-frozen', this.layers), pool: new Map(), spare: [] }
    this.rowHeadsFrozen.inner = el('div', 'grid-layer-inner', this.rowHeadsFrozen.clip)
    this.corner = el('div', 'grid-corner', this.layers)
    this.guide = el('div', 'resize-guide', this.layers)
    this.scroller = el('div', 'grid-scroller', host)
    this.scroller.tabIndex = 0
    this.scroller.setAttribute('role', 'grid')
    this.scroller.setAttribute('aria-label', 'Spreadsheet')
    this.spacer = el('div', 'grid-spacer', this.scroller)
    this.editor = el('textarea', 'cell-editor', host)
    this.editor.spellcheck = false
    this.editor.setAttribute('aria-label', 'Cell editor')
  }

  bind() {
    this.onScroll = () => this.schedule()
    this.scroller.addEventListener('scroll', this.onScroll, { passive: true })
    this.resizeObserver = new ResizeObserver(entries => {
      const box = entries[0].contentRect
      this.width = box.width; this.height = box.height
      this.hostRect = null
      this.schedule()
    })
    this.resizeObserver.observe(this.host)
    this.scroller.addEventListener('mousedown', e => this.mouseDown(e))
    this.scroller.addEventListener('dblclick', e => this.doubleClick(e))
    this.scroller.addEventListener('mousemove', e => { if (!this.drag) this.scroller.style.cursor = this.cursorAt(this.point(e)) })
    this.scroller.addEventListener('keydown', e => this.handlers.onKeyDown(e))
    this.onWindowMove = e => this.dragMove(e)
    this.onWindowUp = e => this.dragEnd(e)
    this.editor.addEventListener('keydown', e => this.editorKey(e))
    this.editor.addEventListener('input', () => this.handlers.onEditInput?.(this.editor.value))
    this.editor.addEventListener('blur', e => { if (this.editing && !this.editing.keepOnBlur && !this.handlers.isFormulaBar?.(e.relatedTarget)) this.commitEdit(0, 0) })
  }

  destroy() {
    cancelAnimationFrame(this.frame)
    this.resizeObserver.disconnect()
    window.removeEventListener('mousemove', this.onWindowMove)
    window.removeEventListener('mouseup', this.onWindowUp)
    this.host.replaceChildren()
  }

  // ── Layout ───────────────────────────────────────────────

  schedule() {
    if (!this.frame) this.frame = requestAnimationFrame(() => { this.frame = 0; this.render() })
  }

  /** Engine changed: re-read data (and sizes if layoutVersion moved) on the next frame. */
  refresh() { this.schedule() }

  ensureLayout() {
    const e = this.engine
    if (this.layoutVersion === e.layoutVersion && this.rowsPos?.length === e.rows + 1 && this.colsPos?.length === e.cols + 1) return
    this.layoutVersion = e.layoutVersion
    const hidden = e.hiddenRows()
    this.rowsPos = prefix(e.rows, r => (hidden?.has(r) ? 0 : e.getRowHeight(r)))
    this.colsPos = prefix(e.cols, c => e.getColumnWidth(c))
    this.spacer.style.width = `${ROW_HEADER_WIDTH + this.colsPos[e.cols]}px`
    this.spacer.style.height = `${COL_HEADER_HEIGHT + this.rowsPos[e.rows]}px`
  }

  get frozenW() { return this.colsPos[this.engine.frozenCols] }
  get frozenH() { return this.rowsPos[this.engine.frozenRows] }

  // ── Rendering ────────────────────────────────────────────

  render() {
    const e = this.engine
    this.ensureLayout()
    this.scrollX = this.scroller.scrollLeft
    this.scrollY = this.scroller.scrollTop
    const dataChanged = this.dataVersion !== e.version
    this.dataVersion = e.version
    const fw = this.frozenW, fh = this.frozenH, fr = e.frozenRows, fc = e.frozenCols
    const bodyW = Math.max(0, this.width - ROW_HEADER_WIDTH - fw), bodyH = Math.max(0, this.height - COL_HEADER_HEIGHT - fh)
    const rows = this.visible(this.rowsPos, fh + this.scrollY, bodyH, fr, OVERSCAN_ROWS)
    const cols = this.visible(this.colsPos, fw + this.scrollX, bodyW, fc, OVERSCAN_COLS)
    const frozenRows = [], frozenCols = []
    for (let r = 0; r < fr; r++) if (this.rowsPos[r + 1] > this.rowsPos[r]) frozenRows.push(r)
    for (let c = 0; c < fc; c++) frozenCols.push(c)

    this.place(this.body, ROW_HEADER_WIDTH + fw, COL_HEADER_HEIGHT + fh, bodyW, bodyH, fw + this.scrollX, fh + this.scrollY)
    this.place(this.frozenTop, ROW_HEADER_WIDTH + fw, COL_HEADER_HEIGHT, bodyW, fh, fw + this.scrollX, 0)
    this.place(this.frozenLeft, ROW_HEADER_WIDTH, COL_HEADER_HEIGHT + fh, fw, bodyH, 0, fh + this.scrollY)
    this.place(this.frozenCorner, ROW_HEADER_WIDTH, COL_HEADER_HEIGHT, fw, fh, 0, 0)
    this.place(this.colHeads, ROW_HEADER_WIDTH + fw, 0, bodyW, COL_HEADER_HEIGHT, fw + this.scrollX, 0)
    this.place(this.colHeadsFrozen, ROW_HEADER_WIDTH, 0, fw, COL_HEADER_HEIGHT, 0, 0)
    this.place(this.rowHeads, 0, COL_HEADER_HEIGHT + fh, ROW_HEADER_WIDTH, bodyH, 0, fh + this.scrollY)
    this.place(this.rowHeadsFrozen, 0, COL_HEADER_HEIGHT, ROW_HEADER_WIDTH, fh, 0, 0)

    this.paintCells(this.body, rows, cols, dataChanged)
    this.paintCells(this.frozenTop, frozenRows, cols, dataChanged)
    this.paintCells(this.frozenLeft, rows, frozenCols, dataChanged)
    this.paintCells(this.frozenCorner, frozenRows, frozenCols, dataChanged)
    this.paintColHeads(this.colHeads, cols)
    this.paintColHeads(this.colHeadsFrozen, frozenCols)
    this.paintRowHeads(this.rowHeads, rows)
    this.paintRowHeads(this.rowHeadsFrozen, frozenRows)
    for (const layer of [this.body, this.frozenTop, this.frozenLeft, this.frozenCorner]) this.paintOverlay(layer)
    this.positionEditor()
  }

  /** Visible indices (non-empty spans) from `start` px for `size` px, never below `min`. */
  visible(sums, start, size, min, overscan) {
    const out = [], count = sums.length - 1
    const first = Math.max(min, indexAt(sums, start) - overscan)
    const last = Math.min(count - 1, indexAt(sums, start + size) + overscan)
    for (let i = first; i <= last; i++) if (sums[i + 1] > sums[i]) out.push(i)
    return out
  }

  place(layer, left, top, width, height, originX, originY) {
    const s = layer.clip.style, key = `${left},${top},${width},${height}`
    if (layer.box !== key) { layer.box = key; s.left = `${left}px`; s.top = `${top}px`; s.width = `${width}px`; s.height = `${height}px` }
    if (layer.originX === originX && layer.originY === originY) return
    layer.originX = originX; layer.originY = originY
    layer.inner.style.transform = `translate3d(${-originX}px,${-originY}px,0)`
  }

  /** Keyed reuse: cells still visible keep their element; only new cells are written. */
  reuse(layer, keys, create) {
    const next = new Map(), fresh = []
    for (const k of keys) { const node = layer.pool.get(k); if (node) { next.set(k, node); layer.pool.delete(k) } else fresh.push(k) }
    for (const node of layer.pool.values()) { node.style.display = 'none'; layer.spare.push(node) }
    for (const k of fresh) {
      const node = layer.spare.pop() ?? create()
      node.style.display = ''
      node._key = null
      next.set(k, node)
    }
    layer.pool = next
    return next
  }

  paintCells(layer, rows, cols, dataChanged) {
    const e = this.engine, keys = []
    for (const r of rows) for (const c of cols) keys.push(r * 16384 + c)
    const nodes = this.reuse(layer, keys, () => el('div', 'cell', layer.inner))
    for (const [k, node] of nodes) {
      const r = Math.floor(k / 16384), c = k % 16384
      const x = this.colsPos[c], y = this.rowsPos[r], w = this.colsPos[c + 1] - x, h = this.rowsPos[r + 1] - y
      if (node._x !== x || node._y !== y || node._w !== w || node._h !== h) {
        node._x = x; node._y = y; node._w = w; node._h = h
        const s = node.style
        s.transform = `translate(${x}px,${y}px)`; s.width = `${w}px`; s.height = `${h}px`
      }
      if (node._key === k && !dataChanged) continue
      node._key = k
      const text = e.getDisplay(r, c)
      if (node._text !== text) { node._text = text; node.textContent = text }
      const style = e.getCellStyle(r, c), value = e.getValue(r, c), error = typeof value === 'object'
      const numeric = typeof value === 'number' || (typeof value === 'string' && value !== '' && toNum(value) !== null && !parseDate(value))
      const sig = `${style.bold ? 'b' : ''}${style.italic ? 'i' : ''}${style.underline ? 'u' : ''}|${style.bg ?? ''}|${style.color ?? ''}|${style.align ?? (numeric ? 'right' : '')}|${style.fontSize ?? ''}|${error ? 'err' : ''}`
      if (node._sig !== sig) {
        node._sig = sig
        const s = node.style
        s.fontWeight = style.bold ? '600' : ''
        s.fontStyle = style.italic ? 'italic' : ''
        s.textDecoration = style.underline ? 'underline' : ''
        s.background = style.bg ?? ''
        s.color = style.color ?? ''
        s.textAlign = style.align ?? (numeric ? 'right' : '')
        s.fontSize = style.fontSize ? `${style.fontSize}px` : ''
        node.classList.toggle('cell-error', error)
      }
    }
  }

  paintColHeads(layer, cols) {
    const e = this.engine, { c1, c2 } = rangeOf(this.sel), full = this.isFullColumns()
    const nodes = this.reuse(layer, cols, () => {
      const node = el('div', 'col-head', layer.inner)
      node._label = el('span', 'col-label', node)
      node._sort = el('span', 'col-sort', node)
      node._filter = el('span', 'col-filter', node)
      node._filter.textContent = '▾'
      return node
    })
    for (const [c, node] of nodes) {
      const x = this.colsPos[c], w = this.colsPos[c + 1] - x
      if (node._x !== x || node._w !== w) { node._x = x; node._w = w; node.style.transform = `translateX(${x}px)`; node.style.width = `${w}px`; node.classList.toggle('narrow', w < 72) }
      if (node._key !== c) { node._key = c; node._label.textContent = colLabel(c) }
      const sort = this.handlers.sortState?.(c) ?? ''
      if (node._sortText !== sort) { node._sortText = sort; node._sort.textContent = sort === 'asc' ? '↑' : sort === 'desc' ? '↓' : '⇅'; node._sort.classList.toggle('active', !!sort) }
      node.classList.toggle('in-sel', c >= c1 && c <= c2)
      node.classList.toggle('full-sel', full && c >= c1 && c <= c2)
      node._filter.classList.toggle('active', !!e.getFilter(c))
    }
  }

  paintRowHeads(layer, rows) {
    const { r1, r2 } = rangeOf(this.sel), filtered = !!this.engine.hiddenRows(), full = this.isFullRows()
    const nodes = this.reuse(layer, rows, () => el('div', 'row-head', layer.inner))
    for (const [r, node] of nodes) {
      const y = this.rowsPos[r], h = this.rowsPos[r + 1] - y
      if (node._y !== y || node._h !== h) { node._y = y; node._h = h; node.style.transform = `translateY(${y}px)`; node.style.height = `${h}px` }
      if (node._key !== r) { node._key = r; node.textContent = String(r + 1) }
      node.classList.toggle('in-sel', r >= r1 && r <= r2)
      node.classList.toggle('full-sel', full && r >= r1 && r <= r2)
      node.classList.toggle('filtered', filtered && r > 0)
    }
  }

  isFullColumns() { const { r1, r2 } = rangeOf(this.sel); return r1 === 0 && r2 >= this.engine.rows - 1 }
  isFullRows() { const { c1, c2 } = rangeOf(this.sel); return c1 === 0 && c2 >= this.engine.cols - 1 }

  rectOf(range) {
    const x = this.colsPos[range.c1], y = this.rowsPos[range.r1]
    return { x, y, w: this.colsPos[range.c2 + 1] - x, h: this.rowsPos[range.r2 + 1] - y }
  }

  paintOverlay(layer) {
    const { sel, active, handle, fill } = layer.overlay
    const range = rangeOf(this.sel), box = this.rectOf(range)
    const key = `${box.x},${box.y},${box.w},${box.h},${this.sel.ar},${this.sel.ac},${!!this.editing},${this.fillPreview ? JSON.stringify(this.fillPreview) : ''},${this.layoutVersion}`
    if (layer.overlayKey === key) return
    layer.overlayKey = key
    const single = range.r1 === range.r2 && range.c1 === range.c2
    const setBox = (node, b, show) => {
      node.style.display = show ? '' : 'none'
      if (show) { node.style.transform = `translate(${b.x}px,${b.y}px)`; node.style.width = `${b.w}px`; node.style.height = `${b.h}px` }
    }
    setBox(sel, box, !single)
    setBox(active, this.rectOf({ r1: this.sel.ar, c1: this.sel.ac, r2: this.sel.ar, c2: this.sel.ac }), true)
    handle.style.transform = `translate(${box.x + box.w - HANDLE / 2 - 1}px,${box.y + box.h - HANDLE / 2 - 1}px)`
    handle.style.display = this.editing ? 'none' : ''
    setBox(fill, this.fillPreview ? this.rectOf(this.fillPreview) : box, !!this.fillPreview)
  }

  // ── Geometry ─────────────────────────────────────────────

  /** Pointer position relative to the grid host (uses the event's offset on the scroller, no layout read). */
  point(e) {
    const rect = this.hostRect ?? (this.hostRect = this.host.getBoundingClientRect())
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  /** Sheet coordinates for a host point, honouring frozen panes. */
  sheetPoint(p) {
    const fw = this.frozenW, fh = this.frozenH
    const bx = p.x - ROW_HEADER_WIDTH, by = p.y - COL_HEADER_HEIGHT
    return { x: bx < fw ? bx : bx + this.scrollX, y: by < fh ? by : by + this.scrollY }
  }

  cellAt(p) {
    const s = this.sheetPoint(p)
    return { r: indexAt(this.rowsPos, Math.max(0, s.y)), c: indexAt(this.colsPos, Math.max(0, s.x)) }
  }

  zoneAt(p) {
    if (p.x < ROW_HEADER_WIDTH && p.y < COL_HEADER_HEIGHT) return { kind: 'corner' }
    const s = this.sheetPoint(p)
    if (p.y < COL_HEADER_HEIGHT) {
      const c = indexAt(this.colsPos, Math.max(0, s.x)), right = this.colsPos[c + 1], left = this.colsPos[c]
      if (right - s.x <= RESIZE_ZONE) return { kind: 'col-resize', c }
      if (s.x - left <= RESIZE_ZONE && c > 0) return { kind: 'col-resize', c: c - 1 }
      if (right - s.x <= FILTER_ZONE + RESIZE_ZONE) return { kind: 'filter', c, x: p.x - (s.x - left) }
      if (right - s.x <= FILTER_ZONE * 2 + RESIZE_ZONE) return { kind: 'sort', c }
      return { kind: 'col', c }
    }
    if (p.x < ROW_HEADER_WIDTH) {
      const r = indexAt(this.rowsPos, Math.max(0, s.y)), bottom = this.rowsPos[r + 1]
      if (bottom - s.y <= RESIZE_ZONE) return { kind: 'row-resize', r }
      return { kind: 'row', r }
    }
    const range = rangeOf(this.sel), box = this.rectOf(range)
    if (!this.editing && Math.abs(s.x - (box.x + box.w)) <= HANDLE && Math.abs(s.y - (box.y + box.h)) <= HANDLE) return { kind: 'fill' }
    return { kind: 'cell', ...this.cellAt(p) }
  }

  cursorAt(p) {
    const kind = this.zoneAt(p).kind
    return kind === 'col-resize' ? 'col-resize' : kind === 'row-resize' ? 'row-resize' : kind === 'fill' ? 'crosshair'
      : kind === 'filter' || kind === 'sort' ? 'pointer' : kind === 'col' ? 's-resize' : kind === 'row' ? 'e-resize' : 'cell'
  }

  // ── Mouse ────────────────────────────────────────────────

  mouseDown(e) {
    if (e.button !== 0 || this.handlers.isBusy?.()) return
    this.hostRect = null
    const p = this.point(e)
    if (p.x > this.width - 14 && this.scroller.scrollHeight > this.height) return // native scrollbar
    if (p.y > this.height - 14 && this.scroller.scrollWidth > this.width) return
    if (this.editing) this.commitEdit(0, 0)
    const zone = this.zoneAt(p), e2 = this.engine
    e.preventDefault()
    this.scroller.focus({ preventScroll: true })
    if (zone.kind === 'corner') return this.select({ ar: 0, ac: 0, fr: e2.rows - 1, fc: e2.cols - 1 })
    if (zone.kind === 'filter') return this.handlers.onFilterMenu?.(zone.c, { x: this.hostRect.left + zone.x, y: this.hostRect.top + COL_HEADER_HEIGHT })
    if (zone.kind === 'sort') return this.handlers.onSortClick?.(zone.c)
    if (zone.kind === 'col-resize') {
      this.drag = { kind: 'col-resize', c: zone.c, start: e.clientX, size: e2.getColumnWidth(zone.c) }
    } else if (zone.kind === 'row-resize') {
      this.drag = { kind: 'row-resize', r: zone.r, start: e.clientY, size: e2.getRowHeight(zone.r) }
    } else if (zone.kind === 'fill') {
      this.drag = { kind: 'fill', source: rangeOf(this.sel) }
    } else if (zone.kind === 'col') {
      const ac = e.shiftKey ? this.sel.ac : zone.c
      this.select({ ar: 0, ac, fr: e2.rows - 1, fc: zone.c }, false)
      this.drag = { kind: 'cols', ac }
    } else if (zone.kind === 'row') {
      const ar = e.shiftKey ? this.sel.ar : zone.r
      this.select({ ar, ac: 0, fr: zone.r, fc: e2.cols - 1 }, false)
      this.drag = { kind: 'rows', ar }
    } else {
      const { r, c } = zone
      this.select(e.shiftKey ? { ...this.sel, fr: r, fc: c } : { ar: r, ac: c, fr: r, fc: c }, false)
      this.drag = { kind: 'cells' }
    }
    this.drag.last = p
    window.addEventListener('mousemove', this.onWindowMove)
    window.addEventListener('mouseup', this.onWindowUp)
  }

  dragMove(e) {
    if (!this.drag) return
    this.drag.last = this.point(e)
    this.drag.clientX = e.clientX; this.drag.clientY = e.clientY
    if (!this.drag.pending) {
      this.drag.pending = requestAnimationFrame(() => { if (this.drag) { this.drag.pending = 0; this.dragStep() } })
    }
  }

  dragStep() {
    const d = this.drag, p = d.last
    if (d.kind === 'col-resize' || d.kind === 'row-resize') {
      const col = d.kind === 'col-resize'
      d.next = Math.max(col ? 30 : 16, d.size + (col ? d.clientX - d.start : d.clientY - d.start))
      const s = this.guide.style
      s.display = 'block'
      if (col) { const x = ROW_HEADER_WIDTH + this.colsPos[d.c] - (d.c >= this.engine.frozenCols ? this.scrollX : 0) + d.next; s.left = `${x}px`; s.top = '0'; s.width = '1px'; s.height = '100%' }
      else { const y = COL_HEADER_HEIGHT + this.rowsPos[d.r] - (d.r >= this.engine.frozenRows ? this.scrollY : 0) + d.next; s.top = `${y}px`; s.left = '0'; s.height = '1px'; s.width = '100%' }
      return
    }
    // Auto-scroll when dragging past the edges.
    const edge = 24
    let dx = 0, dy = 0
    if (p.x > this.width - edge) dx = 20; else if (p.x < ROW_HEADER_WIDTH + edge && d.kind !== 'rows') dx = -20
    if (p.y > this.height - edge) dy = 20; else if (p.y < COL_HEADER_HEIGHT + edge && d.kind !== 'cols') dy = -20
    if (dx || dy) {
      this.scroller.scrollLeft += dx; this.scroller.scrollTop += dy
      this.scrollX = this.scroller.scrollLeft; this.scrollY = this.scroller.scrollTop
      d.pending = requestAnimationFrame(() => { if (this.drag) { this.drag.pending = 0; this.dragStep() } })
    }
    const clamped = { x: Math.max(ROW_HEADER_WIDTH, Math.min(this.width - 1, p.x)), y: Math.max(COL_HEADER_HEIGHT, Math.min(this.height - 1, p.y)) }
    const { r, c } = this.cellAt(clamped)
    if (d.kind === 'cells') this.select({ ...this.sel, fr: r, fc: c }, false)
    else if (d.kind === 'cols') this.select({ ar: 0, ac: d.ac, fr: this.engine.rows - 1, fc: c }, false)
    else if (d.kind === 'rows') this.select({ ar: d.ar, ac: 0, fr: r, fc: this.engine.cols - 1 }, false)
    else if (d.kind === 'fill') { this.fillPreview = fillTarget(d.source, r, c); this.schedule() }
  }

  dragEnd() {
    const d = this.drag
    window.removeEventListener('mousemove', this.onWindowMove)
    window.removeEventListener('mouseup', this.onWindowUp)
    if (!d) return
    cancelAnimationFrame(d.pending)
    this.drag = null
    this.guide.style.display = 'none'
    if (d.kind === 'col-resize' && d.next !== undefined) this.handlers.onResizeColumn(d.c, d.next)
    else if (d.kind === 'row-resize' && d.next !== undefined) this.handlers.onResizeRow(d.r, d.next)
    else if (d.kind === 'fill' && this.fillPreview) {
      const target = this.fillPreview
      this.fillPreview = null
      this.handlers.onFill(d.source, target)
      this.select({ ar: target.r1, ac: target.c1, fr: target.r2, fc: target.c2 }, false)
    }
    this.handlers.onSelect?.(this.sel)
  }

  doubleClick(e) {
    const zone = this.zoneAt(this.point(e))
    if (zone.kind === 'col-resize') this.handlers.onAutoFit(zone.c)
    else if (zone.kind === 'row-resize') this.handlers.onResizeRow(zone.r, null)
    else if (zone.kind === 'cell') this.startEdit()
  }

  // ── Selection & scrolling ────────────────────────────────

  /** Sets the selection; `notify` false defers the React update to drag end. */
  select(sel, notify = true) {
    const e = this.engine, clampR = r => Math.max(0, Math.min(e.rows - 1, r)), clampC = c => Math.max(0, Math.min(e.cols - 1, c))
    this.sel = { ar: clampR(sel.ar), ac: clampC(sel.ac), fr: clampR(sel.fr), fc: clampC(sel.fc) }
    this.schedule()
    if (notify || !this.drag) this.handlers.onSelect?.(this.sel)
  }

  /**
   * Scrolls so (r, c) is visible. Uses cached sizes only. With `snap`, a
   * target inside the frozen panes scrolls that axis back to the start
   * (Ctrl+Home, name box), as spreadsheets do.
   */
  scrollIntoView(r, c, snap = false) {
    this.ensureLayout()
    const e = this.engine, fw = this.frozenW, fh = this.frozenH
    if (snap && r < e.frozenRows) this.scroller.scrollTop = 0
    if (snap && c < e.frozenCols) this.scroller.scrollLeft = 0
    const bodyW = this.width - ROW_HEADER_WIDTH - fw - 14, bodyH = this.height - COL_HEADER_HEIGHT - fh - 14
    if (r >= e.frozenRows) {
      const top = this.rowsPos[r] - fh, bottom = this.rowsPos[r + 1] - fh
      if (top < this.scrollY) this.scroller.scrollTop = top
      else if (bottom > this.scrollY + bodyH) this.scroller.scrollTop = bottom - bodyH
    }
    if (c >= e.frozenCols) {
      const left = this.colsPos[c] - fw, right = this.colsPos[c + 1] - fw
      if (left < this.scrollX) this.scroller.scrollLeft = left
      else if (right > this.scrollX + bodyW) this.scroller.scrollLeft = right - bodyW
    }
    this.scrollX = this.scroller.scrollLeft; this.scrollY = this.scroller.scrollTop
    this.schedule()
  }

  /** Rows that fit in the body viewport (for Page Up / Page Down). */
  pageRows() { return Math.max(1, Math.floor((this.height - COL_HEADER_HEIGHT - this.frozenH) / DEFAULT_ROW_HEIGHT) - 1) }

  focus() { this.scroller.focus({ preventScroll: true }) }

  // ── Editing ──────────────────────────────────────────────

  startEdit(initial = null, focus = true) {
    const { ar: r, ac: c } = this.sel
    this.scrollIntoView(r, c)
    const raw = this.engine.getCell(r, c).raw
    this.editing = { r, c, original: raw }
    this.editor.value = initial ?? raw
    this.editor.style.display = 'block'
    this.positionEditor()
    if (focus) {
      this.editor.focus({ preventScroll: true })
      this.editor.setSelectionRange(this.editor.value.length, this.editor.value.length)
    }
    this.handlers.onEditInput?.(this.editor.value)
    this.schedule()
  }

  /** Mirrors formula-bar typing into the in-cell editor without React state. */
  setEditText(text) {
    if (!this.editing) { this.startEdit(text, false); this.editing.keepOnBlur = true }
    this.editor.value = text
  }

  positionEditor() {
    if (!this.editing) return
    const { r, c } = this.editing, e = this.engine
    const x = ROW_HEADER_WIDTH + this.colsPos[c] - (c >= e.frozenCols ? this.scrollX : 0)
    const y = COL_HEADER_HEIGHT + this.rowsPos[r] - (r >= e.frozenRows ? this.scrollY : 0)
    const w = this.colsPos[c + 1] - this.colsPos[c], h = this.rowsPos[r + 1] - this.rowsPos[r]
    const s = this.editor.style, key = `${x},${y},${w},${h}`
    if (this.editorBox === key) return
    this.editorBox = key
    s.transform = `translate(${x}px,${y}px)`; s.minWidth = `${w}px`; s.height = `${h}px`
  }

  editorKey(e) {
    if (e.key === 'Enter' && !e.altKey) { e.preventDefault(); this.commitEdit(e.shiftKey ? -1 : 1, 0) }
    else if (e.key === 'Tab') { e.preventDefault(); this.commitEdit(0, e.shiftKey ? -1 : 1) }
    else if (e.key === 'Escape') { e.preventDefault(); this.cancelEdit() }
  }

  /** Commits the editor text and moves the active cell by (dr, dc). */
  commitEdit(dr, dc) {
    const ed = this.editing
    if (!ed) return
    this.editing = null
    this.editorBox = null
    this.editor.style.display = 'none'
    const text = this.editor.value
    if (text !== ed.original) this.handlers.onCommit(ed.r, ed.c, text)
    this.handlers.onEditInput?.(null)
    if (dr || dc) this.handlers.onMove(dr, dc)
    this.focus()
    this.schedule()
  }

  cancelEdit() {
    if (!this.editing) return
    this.editing = null
    this.editorBox = null
    this.editor.style.display = 'none'
    this.handlers.onEditInput?.(null)
    this.focus()
    this.schedule()
  }

  /** Text width in px for auto-fit, measured with a canvas (no DOM layout). */
  measure(text, style) {
    if (!this.measureCtx) this.measureCtx = document.createElement('canvas').getContext('2d')
    this.measureCtx.font = `${style.italic ? 'italic ' : ''}${style.bold ? '600 ' : ''}${style.fontSize ?? 13}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`
    return this.measureCtx.measureText(text).width
  }
}

/** Fill target: the source extended along the axis the pointer moved furthest from it. */
export function fillTarget(source, r, c) {
  const down = r - source.r2, up = source.r1 - r, right = c - source.c2, left = source.c1 - c
  const vertical = Math.max(down, up), horizontal = Math.max(right, left)
  if (vertical <= 0 && horizontal <= 0) {
    // Inside the source: shrink from the bottom/right edge.
    if (r < source.r2 && source.r2 - r >= source.c2 - c) return { ...source, r2: Math.max(source.r1, r) }
    if (c < source.c2) return { ...source, c2: Math.max(source.c1, c) }
    return source
  }
  if (vertical >= horizontal) return down > 0 ? { ...source, r2: r } : { ...source, r1: r }
  return right > 0 ? { ...source, c2: c } : { ...source, c1: c }
}


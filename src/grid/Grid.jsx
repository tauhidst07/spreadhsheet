// ─────────────────────────────────────────────────────────────
//  Virtualized grid.
//
//  Four panes: corner, top (column headers + frozen rows), left
//  (row headers + frozen columns) and body. Only the body scrolls
//  natively; the top/left panes are moved with a transform from the
//  scroll handler, so they stay in sync in the same frame. React
//  re-renders only when the visible row/column window changes, and
//  only visible cells (plus overscan) exist in the DOM.
//
//  Geometry comes from engine.getOffsets(): prefix sums of row
//  heights / column widths; pixel → index is a binary search.
// ─────────────────────────────────────────────────────────────
import { useState, useRef, useEffect, useLayoutEffect, useImperativeHandle, useSyncExternalStore } from 'react'
import { indexAt, visibleWindow } from '../engine/layout.js'
import { columnLabel } from '../engine/refs.js'
import { DEFAULT_STYLE, DEFAULT_ROW_HEIGHT } from '../engine/core.js'
import { measureText } from './measure.js'
import { selectionRange, fillTarget } from './selection.js'
import { noteGridCommit } from '../ui/perfStats.js'

const HEADER_H = 24
const ROWHDR_W = 56
const OVERSCAN_ROWS = 6
const OVERSCAN_COLS = 2
const RESIZE_ZONE = 5
const AUTOSCROLL_EDGE = 24

function cellCss(style, error) {
    if (style === DEFAULT_STYLE && !error) return null
    return {
        fontWeight: style.bold ? 700 : undefined,
        fontStyle: style.italic ? 'italic' : undefined,
        textDecoration: style.underline ? 'underline' : undefined,
        color: error ? '#d93025' : style.color,
        background: style.bg === 'white' ? undefined : style.bg,
        fontSize: style.fontSize === 13 ? undefined : style.fontSize,
        textAlign: style.align === 'left' ? undefined : style.align,
    }
}

function CellEditor({ editStore, rect, style, mode, autoFocus, actions }) {
    const text = useSyncExternalStore(editStore.subscribe, editStore.get)
    const ref = useRef(null)
    useLayoutEffect(() => {
        if (!autoFocus) return // editing started in the formula bar, which keeps focus
        const el = ref.current
        el.focus({ preventScroll: true })
        el.setSelectionRange(el.value.length, el.value.length)
    }, [autoFocus])
    const width = Math.max(rect.w, Math.min(600, measureText(text, style) + 16))
    const onKeyDown = (e) => {
        const k = e.key
        const arrows = { ArrowDown: [1, 0], ArrowUp: [-1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }
        if (k === 'Enter') { e.preventDefault(); e.stopPropagation(); actions.commitEdit(e.shiftKey ? [-1, 0] : [1, 0]) }
        else if (k === 'Tab') { e.preventDefault(); e.stopPropagation(); actions.commitEdit(e.shiftKey ? [0, -1] : [0, 1]) }
        else if (k === 'Escape') { e.preventDefault(); e.stopPropagation(); actions.cancelEdit() }
        else if (mode === 'enter' && arrows[k]) { e.preventDefault(); e.stopPropagation(); actions.commitEdit(arrows[k]) }
        else e.stopPropagation()
    }
    return (
        <input
            ref={ref}
            data-nogrid
            className="cell-editor"
            value={text}
            spellCheck={false}
            onChange={(e) => editStore.set(e.target.value)}
            onKeyDown={onKeyDown}
            onBlur={(e) => actions.blurEdit(e.relatedTarget)}
            style={{
                left: rect.x, top: rect.y, width, height: rect.h,
                fontWeight: style.bold ? 700 : 400, fontStyle: style.italic ? 'italic' : 'normal',
                fontSize: style.fontSize, color: style.color, textAlign: style.align,
                background: style.bg,
            }}
        />
    )
}

export default function Grid({ engine, selection, editing, editStore, actions, apiRef, filterCols, sortState }) {
    const rootRef = useRef(null)
    const bodyRef = useRef(null)
    const topRef = useRef(null)
    const leftRef = useRef(null)
    const lastWinRef = useRef(null)
    const dragRef = useRef(null)
    const [scroll, setScroll] = useState({ top: 0, left: 0 })
    const [viewport, setViewport] = useState({ w: 1200, h: 700 })
    const [drag, setDrag] = useState(null)

    const rows = engine.rows
    const cols = engine.cols
    const { rowTop, colLeft } = engine.getOffsets()
    const fr = Math.min(engine.frozenRows, rows - 1)
    const fc = Math.min(engine.frozenCols, cols - 1)
    const frozenH = rowTop[fr]
    const frozenW = colLeft[fc]
    const used = engine.getUsedRange()
    const sel = selectionRange(selection)
    const active = selection.anchor

    const computeWin = (top, left, vp) => {
        const [r0, r1] = visibleWindow(rowTop, fr, top, vp.h, OVERSCAN_ROWS)
        const [c0, c1] = visibleWindow(colLeft, fc, left, vp.w, OVERSCAN_COLS)
        return { r0, r1, c0, c1 }
    }
    const win = computeWin(scroll.top, scroll.left, viewport)

    // ── Scrolling ──

    const syncPanes = () => {
        const el = bodyRef.current
        if (!el) return
        if (topRef.current) topRef.current.style.transform = `translateX(${-el.scrollLeft}px)`
        if (leftRef.current) leftRef.current.style.transform = `translateY(${-el.scrollTop}px)`
    }

    const onScroll = () => {
        const el = bodyRef.current
        syncPanes()
        const w = computeWin(el.scrollTop, el.scrollLeft, viewport)
        const last = lastWinRef.current
        if (!last || last.r0 !== w.r0 || last.r1 !== w.r1 || last.c0 !== w.c0 || last.c1 !== w.c1) {
            lastWinRef.current = w
            setScroll({ top: el.scrollTop, left: el.scrollLeft })
        }
    }

    useLayoutEffect(syncPanes)
    useLayoutEffect(() => { noteGridCommit() })

    useEffect(() => {
        const el = bodyRef.current
        const ro = new ResizeObserver(() => setViewport({ w: el.clientWidth, h: el.clientHeight }))
        ro.observe(el)
        return () => ro.disconnect()
    }, [])

    function scrollIntoView(r, c) {
        const el = bodyRef.current
        if (!el) return
        if (r >= fr) {
            const y = rowTop[r] - frozenH, h = rowTop[r + 1] - rowTop[r]
            if (y < el.scrollTop) el.scrollTop = y
            else if (y + h > el.scrollTop + el.clientHeight) el.scrollTop = y + h - el.clientHeight
        }
        if (c >= fc) {
            const x = colLeft[c] - frozenW, w = colLeft[c + 1] - colLeft[c]
            if (x < el.scrollLeft) el.scrollLeft = x
            else if (x + w > el.scrollLeft + el.clientWidth) el.scrollLeft = Math.max(0, x + w - el.clientWidth)
        }
    }

    useImperativeHandle(apiRef, () => ({
        scrollIntoView,
        focus: () => rootRef.current?.focus({ preventScroll: true }),
        pageRows: () => Math.max(1, Math.floor((bodyRef.current?.clientHeight ?? 600) / DEFAULT_ROW_HEIGHT) - 1),
    }))

    // ── Hit testing (one function for all panes) ──

    function hitTest(clientX, clientY) {
        const rect = rootRef.current.getBoundingClientRect()
        const el = bodyRef.current
        const px = clientX - rect.left, py = clientY - rect.top
        const bx = px - ROWHDR_W, by = py - HEADER_H
        const x = bx < frozenW ? Math.max(0, bx) : bx - frozenW + el.scrollLeft + frozenW
        const y = by < frozenH ? Math.max(0, by) : by - frozenH + el.scrollTop + frozenH
        return {
            row: indexAt(rowTop, y), col: indexAt(colLeft, x), x, y,
            inColHeader: py < HEADER_H, inRowHeader: px < ROWHDR_W, px, py,
        }
    }

    function resizeTarget(offsets, pos) {
        const i = indexAt(offsets, pos)
        if (offsets[i + 1] - pos <= RESIZE_ZONE) return i
        if (pos - offsets[i] <= RESIZE_ZONE && i > 0) return indexAt(offsets, offsets[i] - 1)
        return null
    }

    // ── Mouse ──

    function stepDrag(clientX, clientY) {
        const d = dragRef.current
        if (!d) return
        const hit = hitTest(clientX, clientY)
        if (d.kind === 'cells') actions.select({ anchor: d.anchor, head: { r: hit.row, c: hit.col } })
        else if (d.kind === 'cols') actions.select({ anchor: d.anchor, head: { r: rows - 1, c: hit.col } })
        else if (d.kind === 'rows') actions.select({ anchor: d.anchor, head: { r: hit.row, c: cols - 1 } })
        else if (d.kind === 'fill') {
            const dest = fillTarget(d.src, { r: hit.row, c: hit.col })
            d.dest = dest
            setDrag({ kind: 'fill', dest })
        } else if (d.kind === 'colResize') {
            d.size = Math.max(30, Math.min(600, hit.x - colLeft[d.index]))
            setDrag({ kind: 'colResize', screen: hit.px - (hit.x - colLeft[d.index]) + d.size })
        } else if (d.kind === 'rowResize') {
            d.size = Math.max(12, Math.min(400, hit.y - rowTop[d.index]))
            setDrag({ kind: 'rowResize', screen: hit.py - (hit.y - rowTop[d.index]) + d.size })
        }
    }

    function autoScrollLoop() {
        const d = dragRef.current
        if (!d || !d.pointer) return
        const el = bodyRef.current
        const r = el.getBoundingClientRect()
        const { x, y } = d.pointer
        let dx = 0, dy = 0
        if (y > r.bottom - AUTOSCROLL_EDGE) dy = Math.min(60, y - (r.bottom - AUTOSCROLL_EDGE))
        else if (y < r.top + 4 && el.scrollTop > 0 && d.kind !== 'cols') dy = -Math.min(60, r.top + 4 - y)
        if (x > r.right - AUTOSCROLL_EDGE) dx = Math.min(60, x - (r.right - AUTOSCROLL_EDGE))
        else if (x < r.left + 4 && el.scrollLeft > 0 && d.kind !== 'rows') dx = -Math.min(60, r.left + 4 - x)
        if ((dx || dy) && d.kind !== 'colResize' && d.kind !== 'rowResize') {
            el.scrollTop += dy
            el.scrollLeft += dx
            stepDrag(x, y)
        }
        d.raf = requestAnimationFrame(autoScrollLoop)
    }

    function beginDrag(state) {
        dragRef.current = state
        const move = (e) => {
            dragRef.current.pointer = { x: e.clientX, y: e.clientY }
            stepDrag(e.clientX, e.clientY)
        }
        const up = () => {
            window.removeEventListener('mousemove', move)
            window.removeEventListener('mouseup', up)
            const d = dragRef.current
            dragRef.current = null
            cancelAnimationFrame(d.raf)
            setDrag(null)
            if (d.kind === 'fill' && d.dest) actions.fill(d.src, d.dest)
            if (d.kind === 'colResize' && d.size !== undefined) actions.resizeColumn(d.index, d.size)
            if (d.kind === 'rowResize' && d.size !== undefined) actions.resizeRow(d.index, d.size)
        }
        window.addEventListener('mousemove', move)
        window.addEventListener('mouseup', up)
        state.raf = requestAnimationFrame(autoScrollLoop)
    }

    const onMouseDown = (e) => {
        if (e.button !== 0 || e.target.closest('[data-nogrid]')) return
        e.preventDefault()
        if (editing) actions.commitEdit(null)
        rootRef.current.focus({ preventScroll: true })
        const hit = hitTest(e.clientX, e.clientY)
        if (hit.inColHeader && hit.inRowHeader) {
            actions.select({ anchor: { r: 0, c: 0 }, head: { r: rows - 1, c: cols - 1 } })
            return
        }
        if (hit.inColHeader) {
            const c = resizeTarget(colLeft, hit.x)
            if (c !== null) { beginDrag({ kind: 'colResize', index: c }); return }
            const anchor = e.shiftKey ? { r: 0, c: selection.anchor.c } : { r: 0, c: hit.col }
            actions.select({ anchor, head: { r: rows - 1, c: hit.col } })
            beginDrag({ kind: 'cols', anchor })
            return
        }
        if (hit.inRowHeader) {
            const r = resizeTarget(rowTop, hit.y)
            if (r !== null) { beginDrag({ kind: 'rowResize', index: r }); return }
            const anchor = e.shiftKey ? { r: selection.anchor.r, c: 0 } : { r: hit.row, c: 0 }
            actions.select({ anchor, head: { r: hit.row, c: cols - 1 } })
            beginDrag({ kind: 'rows', anchor })
            return
        }
        const cell = { r: hit.row, c: hit.col }
        const anchor = e.shiftKey ? selection.anchor : cell
        actions.select({ anchor, head: cell })
        beginDrag({ kind: 'cells', anchor })
    }

    const onDoubleClick = (e) => {
        if (e.target.closest('[data-nogrid]')) return
        const hit = hitTest(e.clientX, e.clientY)
        if (hit.inColHeader && !hit.inRowHeader) {
            const c = resizeTarget(colLeft, hit.x)
            if (c !== null) actions.autoFit(c)
            return
        }
        if (!hit.inColHeader && !hit.inRowHeader) actions.startEdit(null, 'edit')
    }

    const onFillHandleDown = (e) => {
        if (e.button !== 0) return
        e.preventDefault()
        e.stopPropagation()
        if (editing) actions.commitEdit(null)
        beginDrag({ kind: 'fill', src: sel })
    }

    // ── Keyboard ──

    const onKeyDown = (e) => {
        if (e.target !== rootRef.current) return
        const mod = e.ctrlKey || e.metaKey
        const k = e.key
        const nextRow = (r, dir) => {
            let n = r + dir
            while (n >= 0 && n < rows && engine.isRowHidden(n)) n += dir
            return n < 0 || n >= rows ? r : n
        }
        const filled = (r, c) => engine.getText(r, c) !== ''
        const jump = (r, c, dr, dc) => {
            const inside = (rr, cc) => rr >= 0 && rr < rows && cc >= 0 && cc < cols
            if (!inside(r + dr, c + dc)) return { r, c }
            let rr = r, cc = c
            if (filled(r, c) && filled(r + dr, c + dc)) {
                while (inside(rr + dr, cc + dc) && filled(rr + dr, cc + dc)) { rr += dr; cc += dc }
            } else {
                rr += dr; cc += dc
                while (inside(rr + dr, cc + dc) && !filled(rr, cc)) { rr += dr; cc += dc }
            }
            return { r: rr, c: cc }
        }
        const go = (target, extend) => {
            const t = { r: Math.max(0, Math.min(rows - 1, target.r)), c: Math.max(0, Math.min(cols - 1, target.c)) }
            actions.select(extend ? { anchor: selection.anchor, head: t } : { anchor: t, head: t })
            scrollIntoView(t.r, t.c)
        }
        const from = e.shiftKey ? selection.head : selection.anchor
        const arrows = { ArrowDown: [1, 0], ArrowUp: [-1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }

        if (arrows[k]) {
            e.preventDefault()
            const [dr, dc] = arrows[k]
            if (mod) go(jump(from.r, from.c, dr, dc), e.shiftKey)
            else go({ r: dr ? nextRow(from.r, dr) : from.r, c: from.c + dc }, e.shiftKey)
        } else if (k === 'Tab') {
            e.preventDefault()
            go({ r: active.r, c: active.c + (e.shiftKey ? -1 : 1) }, false)
        } else if (k === 'Home') {
            e.preventDefault()
            go(mod ? { r: 0, c: 0 } : { r: from.r, c: 0 }, e.shiftKey)
        } else if (k === 'End' && mod) {
            e.preventDefault()
            go(used ? { r: used.r2, c: used.c2 } : { r: 0, c: 0 }, e.shiftKey)
        } else if (k === 'PageDown' || k === 'PageUp') {
            e.preventDefault()
            const page = Math.max(1, Math.floor(bodyRef.current.clientHeight / DEFAULT_ROW_HEIGHT) - 1)
            let r = from.r
            for (let i = 0; i < page; i++) r = nextRow(r, k === 'PageDown' ? 1 : -1)
            go({ r, c: from.c }, e.shiftKey)
        } else if (k === 'Enter' || k === 'F2') {
            e.preventDefault()
            actions.startEdit(null, 'edit')
        } else if (k === 'Delete' || k === 'Backspace') {
            e.preventDefault()
            actions.clearSelection()
        } else if (mod && (k === 'a' || k === 'A')) {
            e.preventDefault()
            if (used) actions.select({ anchor: { r: used.r1, c: used.c1 }, head: { r: used.r2, c: used.c2 } })
        } else if (mod && (k === 'd' || k === 'r')) {
            e.preventDefault()
            actions.fillShortcut(k === 'd' ? 'down' : 'right')
        } else if (mod && ['b', 'i', 'u'].includes(k)) {
            e.preventDefault()
            actions.toggleStyle({ b: 'bold', i: 'italic', u: 'underline' }[k])
        } else if (!mod && !e.altKey && k.length === 1) {
            e.preventDefault()
            actions.startEdit(k, 'enter')
        }
    }

    // ── Rendering helpers ──

    const visibleRowsIn = (from, to) => {
        const out = []
        for (let r = from; r <= to; r++) if (rowTop[r + 1] > rowTop[r]) out.push(r)
        return out
    }
    const range = (from, to) => { const out = []; for (let i = from; i <= to; i++) out.push(i); return out }
    const bodyRows = visibleRowsIn(win.r0, win.r1)
    const bodyCols = range(win.c0, win.c1)
    const frozenRowList = visibleRowsIn(0, fr - 1)
    const frozenColList = range(0, fc - 1)

    // Pane coordinate systems.
    const P = {
        body: { x: (c) => colLeft[c] - frozenW, y: (r) => rowTop[r] - frozenH },
        top: { x: (c) => colLeft[c] - frozenW, y: (r) => HEADER_H + rowTop[r] },
        left: { x: (c) => ROWHDR_W + colLeft[c], y: (r) => rowTop[r] - frozenH },
        corner: { x: (c) => ROWHDR_W + colLeft[c], y: (r) => HEADER_H + rowTop[r] },
    }

    function cells(rowList, colList, pane) {
        const out = []
        for (const r of rowList) {
            const y = pane.y(r), h = rowTop[r + 1] - rowTop[r]
            for (const c of colList) {
                const v = engine.getView(r, c)
                out.push(
                    <div
                        key={r * 1024 + c}
                        className={v.error ? 'gc err' : 'gc'}
                        style={{ left: pane.x(c), top: y, width: colLeft[c + 1] - colLeft[c], height: h, lineHeight: `${h - 1}px`, ...cellCss(v.style, v.error) }}
                    >
                        {v.text}
                    </div>,
                )
            }
        }
        return out
    }

    function rectOf(rg, pane) {
        return {
            x: pane.x(rg.c1), y: pane.y(rg.r1),
            w: colLeft[rg.c2 + 1] - colLeft[rg.c1], h: rowTop[rg.r2 + 1] - rowTop[rg.r1],
        }
    }

    function overlay(pane, name) {
        const s = rectOf(sel, pane)
        const a = rectOf({ r1: active.r, r2: active.r, c1: active.c, c2: active.c }, pane)
        const multi = sel.r1 !== sel.r2 || sel.c1 !== sel.c2
        const out = []
        if (multi) out.push(<div key="sel" className="sel-range" style={{ left: s.x, top: s.y, width: s.w, height: s.h }} />)
        out.push(<div key="act" className="sel-active" style={{ left: a.x, top: a.y, width: a.w, height: a.h }} />)
        if (drag?.kind === 'fill') {
            const f = rectOf(drag.dest, pane)
            out.push(<div key="fill" className="fill-preview" style={{ left: f.x, top: f.y, width: f.w, height: f.h }} />)
        }
        if (!editing) {
            out.push(
                <div key="handle" data-nogrid className="fill-handle" title="Drag to fill"
                    onMouseDown={onFillHandleDown}
                    style={{ left: s.x + s.w - 4, top: s.y + s.h - 4 }} />,
            )
        }
        if (editing && paneOf(editing.r, editing.c) === name) {
            const rect = rectOf({ r1: editing.r, r2: editing.r, c1: editing.c, c2: editing.c }, pane)
            out.push(<CellEditor key="editor" editStore={editStore} rect={rect} style={engine.getStyle(editing.r, editing.c)} mode={editing.mode} autoFocus={editing.source !== 'bar'} actions={actions} />)
        }
        return out
    }

    function paneOf(r, c) {
        if (r < fr && c < fc) return 'corner'
        if (r < fr) return 'top'
        if (c < fc) return 'left'
        return 'body'
    }

    const selectedCol = (c) => c >= sel.c1 && c <= sel.c2
    const selectedRow = (r) => r >= sel.r1 && r <= sel.r2
    const fullCols = sel.r1 === 0 && sel.r2 === rows - 1
    const fullRows = sel.c1 === 0 && sel.c2 === cols - 1

    function colHeaders(colList, pane) {
        return colList.map(c => {
            const inData = used && c >= used.c1 && c <= used.c2
            const filtered = filterCols.includes(c)
            const sorted = sortState && sortState.col === c ? sortState.dir : null
            return (
                <div key={`h${c}`}
                    className={`ch${selectedCol(c) ? (fullCols ? ' hdr-full' : ' hdr-sel') : ''}`}
                    style={{ left: pane.x(c), width: colLeft[c + 1] - colLeft[c] }}>
                    <span className="ch-label">{columnLabel(c)}</span>
                    {(inData || filtered) && (
                        <span className="ch-tools" data-nogrid>
                            <button type="button" className={`ch-btn${sorted ? ' on' : ''}`} title="Sort: ascending → descending → original"
                                onMouseDown={(e) => { e.preventDefault(); e.stopPropagation() }}
                                onClick={() => actions.sort(c)}>
                                {sorted === 'asc' ? '▲' : sorted === 'desc' ? '▼' : '⇅'}
                            </button>
                            <button type="button" className={`ch-btn${filtered ? ' on' : ''}`} title="Filter"
                                onMouseDown={(e) => { e.preventDefault(); e.stopPropagation() }}
                                onClick={(e) => actions.openFilter(c, e.currentTarget.getBoundingClientRect())}>
                                {filtered ? '⧩' : '▾'}
                            </button>
                        </span>
                    )}
                </div>
            )
        })
    }

    function rowHeaders(rowList, pane) {
        return rowList.map(r => (
            <div key={`r${r}`}
                className={`rh${selectedRow(r) ? (fullRows ? ' hdr-full' : ' hdr-sel') : ''}`}
                style={{ top: pane.y(r), height: rowTop[r + 1] - rowTop[r], lineHeight: `${rowTop[r + 1] - rowTop[r] - 1}px` }}>
                {r + 1}
            </div>
        ))
    }

    const spacerW = colLeft[cols] - frozenW
    const spacerH = rowTop[rows] - frozenH
    const cornerW = ROWHDR_W + frozenW
    const cornerH = HEADER_H + frozenH

    return (
        <div
            ref={rootRef}
            className="grid-root"
            tabIndex={0}
            onMouseDown={onMouseDown}
            onDoubleClick={onDoubleClick}
            onKeyDown={onKeyDown}
            onCopy={actions.copy}
            onPaste={actions.paste}
        >
            <div ref={bodyRef} className="pane pane-body" style={{ left: cornerW, top: cornerH }} onScroll={onScroll}>
                <div className="spacer" style={{ width: spacerW, height: spacerH }}>
                    {cells(bodyRows, bodyCols, P.body)}
                    {overlay(P.body, 'body')}
                </div>
            </div>

            <div className="pane pane-top" style={{ left: cornerW, height: cornerH }}>
                <div ref={topRef} className="pane-inner" style={{ width: spacerW, height: cornerH }}>
                    {colHeaders(bodyCols, P.top)}
                    {cells(frozenRowList, bodyCols, P.top)}
                    {fr > 0 && overlay(P.top, 'top')}
                </div>
                {fr > 0 && <div className="freeze-line-h" style={{ top: cornerH - 1 }} />}
            </div>

            <div className="pane pane-left" style={{ top: cornerH, width: cornerW }}>
                <div ref={leftRef} className="pane-inner" style={{ width: cornerW, height: spacerH }}>
                    {rowHeaders(bodyRows, P.left)}
                    {cells(bodyRows, frozenColList, P.left)}
                    {fc > 0 && overlay(P.left, 'left')}
                </div>
                {fc > 0 && <div className="freeze-line-v" style={{ left: cornerW - 1 }} />}
            </div>

            <div className="pane pane-corner" style={{ width: cornerW, height: cornerH }}>
                <div className="corner-box" title="Select all" />
                {colHeaders(frozenColList, P.corner)}
                {rowHeaders(frozenRowList, P.corner)}
                {cells(frozenRowList, frozenColList, P.corner)}
                {fr > 0 && fc > 0 && overlay(P.corner, 'corner')}
            </div>

            {drag?.kind === 'colResize' && <div className="resize-guide-v" style={{ left: drag.screen }} />}
            {drag?.kind === 'rowResize' && <div className="resize-guide-h" style={{ top: drag.screen }} />}
        </div>
    )
}

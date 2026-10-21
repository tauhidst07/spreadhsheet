// Column header dropdown: sort, condition, value checklist with search.
import { useState, useRef, useLayoutEffect } from 'react'
import { columnLabel } from '../engine/refs.js'

const CONDITIONS = [
    { op: '', label: 'No condition' },
    { op: 'contains', label: 'Text contains' },
    { op: 'gt', label: 'Greater than' },
    { op: 'lt', label: 'Less than' },
    { op: 'isEmpty', label: 'Is empty' },
]
const MAX_LISTED = 500

export default function FilterMenu({ engine, col, anchor, onApply, onSort, onClose }) {
    const [values] = useState(() => engine.getColumnValues(col))
    const [initial] = useState(() => engine.getFilter(col))
    const [checked, setChecked] = useState(() => new Set(initial?.values ?? values.map(v => v.key)))
    const [search, setSearch] = useState('')
    const [op, setOp] = useState(initial?.cond?.op ?? '')
    const [condValue, setCondValue] = useState(initial?.cond?.value ?? '')
    const [pos, setPos] = useState({ left: anchor.left, top: anchor.bottom + 4 })
    const ref = useRef(null)

    useLayoutEffect(() => {
        const el = ref.current
        const r = el.getBoundingClientRect()
        const left = Math.max(8, Math.min(anchor.left, window.innerWidth - r.width - 8))
        const top = Math.max(8, Math.min(anchor.bottom + 4, window.innerHeight - r.height - 8))
        if (left !== pos.left || top !== pos.top) setPos({ left, top })
    }, [anchor, pos])

    const q = search.trim().toLowerCase()
    const shown = q ? values.filter(v => v.label.toLowerCase().includes(q)) : values
    const listed = shown.slice(0, MAX_LISTED)
    const allShownChecked = shown.every(v => checked.has(v.key))
    const header = engine.getText(engine.getUsedRange()?.r1 ?? 0, col)

    const toggle = (key) => setChecked(prev => {
        const next = new Set(prev)
        if (next.has(key)) next.delete(key); else next.add(key)
        return next
    })
    const toggleShown = () => setChecked(prev => {
        const next = new Set(prev)
        for (const v of shown) { if (allShownChecked) next.delete(v.key); else next.add(v.key) }
        return next
    })
    const apply = () => {
        const all = values.every(v => checked.has(v.key))
        onApply({ values: all ? null : [...checked], cond: op ? { op, value: condValue } : null })
    }

    return (
        <>
            <div className="menu-backdrop" onMouseDown={onClose} />
            <div ref={ref} className="filter-menu" style={pos} onKeyDown={(e) => { if (e.key === 'Escape') onClose(); if (e.key === 'Enter') apply() }}>
                <div className="fm-title">{header || `Column ${columnLabel(col)}`}</div>
                <div className="fm-row">
                    <button type="button" onClick={() => onSort('asc')}>Sort A → Z</button>
                    <button type="button" onClick={() => onSort('desc')}>Sort Z → A</button>
                </div>
                <div className="fm-section">Filter by condition</div>
                <div className="fm-row">
                    <select value={op} onChange={(e) => setOp(e.target.value)}>
                        {CONDITIONS.map(c => <option key={c.op} value={c.op}>{c.label}</option>)}
                    </select>
                    {op && op !== 'isEmpty' && (
                        <input value={condValue} onChange={(e) => setCondValue(e.target.value)} placeholder="Value" />
                    )}
                </div>
                <div className="fm-section">Filter by values</div>
                <input className="fm-search" autoFocus value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search values" />
                <label className="fm-item fm-all">
                    <input type="checkbox" checked={allShownChecked} onChange={toggleShown} />
                    {q ? 'Select all matches' : 'Select all'}
                </label>
                <div className="fm-list">
                    {listed.map(v => (
                        <label key={v.key} className="fm-item">
                            <input type="checkbox" checked={checked.has(v.key)} onChange={() => toggle(v.key)} />
                            <span className="fm-label">{v.label}</span>
                            <span className="fm-count">{v.count}</span>
                        </label>
                    ))}
                    {shown.length > MAX_LISTED && <div className="fm-more">{shown.length - MAX_LISTED} more — narrow with search</div>}
                </div>
                <div className="fm-row fm-actions">
                    <button type="button" onClick={() => onApply(null)}>Clear filter</button>
                    <span className="fm-spacer" />
                    <button type="button" onClick={onClose}>Cancel</button>
                    <button type="button" className="primary" onClick={apply}>Apply</button>
                </div>
            </div>
        </>
    )
}

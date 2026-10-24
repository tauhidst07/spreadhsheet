import { useEffect, useMemo, useRef, useState } from 'react'
import { colLabel } from '../engine/formula.js'

const MAX_ITEMS = 500
const CONDITIONS = [['', 'No condition'], ['contains', 'Text contains'], ['gt', 'Greater than'], ['lt', 'Less than'], ['empty', 'Is empty']]

/** Column filter dropdown: sort, search, checklist with (Blanks), one condition. */
export default function FilterMenu({ engine, col, at, onClose, onApply, onSort }) {
  const current = engine.getFilter(col)
  const values = useMemo(() => engine.distinctValues(col), [engine, col])
  const [checked, setChecked] = useState(() => new Set(current?.values ?? values.map(v => v.key)))
  const [search, setSearch] = useState('')
  const [op, setOp] = useState(current?.op ?? '')
  const [value, setValue] = useState(current?.value ?? '')
  const ref = useRef(null)

  useEffect(() => {
    const away = e => { if (!ref.current?.contains(e.target)) onClose() }
    const esc = e => { if (e.key === 'Escape') onClose() }
    // Registered after the opening mousedown has finished propagating, so it cannot close the menu.
    const timer = setTimeout(() => window.addEventListener('mousedown', away))
    window.addEventListener('keydown', esc)
    return () => { clearTimeout(timer); window.removeEventListener('mousedown', away); window.removeEventListener('keydown', esc) }
  }, [onClose])

  const needle = search.trim().toLowerCase()
  const shown = needle ? values.filter(v => v.key.includes(needle)) : values
  const allShownChecked = shown.every(v => checked.has(v.key))
  const toggle = key => setChecked(prev => { const next = new Set(prev); if (next.has(key)) next.delete(key); else next.add(key); return next })
  const toggleAll = () => setChecked(prev => { const next = new Set(prev); for (const v of shown) { if (allShownChecked) next.delete(v.key); else next.add(v.key) } return next })

  const apply = () => {
    const everything = values.every(v => checked.has(v.key))
    const filter = { values: everything ? null : values.filter(v => checked.has(v.key)).map(v => v.key), op: op || null, value: op && op !== 'empty' ? value : null }
    onApply(filter.values || filter.op ? filter : null)
  }

  const header = engine.getText(0, col)
  const left = Math.max(8, Math.min(at.x, window.innerWidth - 288))
  return (
    <div ref={ref} className="filter-menu" style={{ left, top: at.y + 2 }} role="dialog" aria-label={`Filter column ${colLabel(col)}`}>
      <div className="fm-title">{header || `Column ${colLabel(col)}`}</div>
      <div className="fm-sort">
        <button type="button" className="btn small" onClick={() => onSort('asc')}>Sort A → Z</button>
        <button type="button" className="btn small" onClick={() => onSort('desc')}>Sort Z → A</button>
      </div>
      <label className="fm-label" htmlFor="fm-condition">Condition</label>
      <div className="fm-condition">
        <select id="fm-condition" value={op} onChange={e => setOp(e.target.value)}>
          {CONDITIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        {op && op !== 'empty' && <input aria-label="Condition value" value={value} onChange={e => setValue(e.target.value)} placeholder={op === 'contains' ? 'text' : 'number'} />}
      </div>
      <label className="fm-label" htmlFor="fm-search">Values</label>
      <input id="fm-search" className="fm-search" placeholder="Search values" value={search} onChange={e => setSearch(e.target.value)} autoFocus />
      <div className="fm-list">
        <label className="fm-item fm-all"><input type="checkbox" checked={allShownChecked} onChange={toggleAll} /> (Select all{needle ? ' shown' : ''})</label>
        {shown.slice(0, MAX_ITEMS).map(v => (
          <label key={v.key} className="fm-item">
            <input type="checkbox" checked={checked.has(v.key)} onChange={() => toggle(v.key)} />
            <span className="fm-value">{v.key === '' ? '(Blanks)' : v.label}</span>
            <span className="fm-count">{v.count}</span>
          </label>
        ))}
        {shown.length > MAX_ITEMS && <div className="fm-more">Showing {MAX_ITEMS} of {shown.length.toLocaleString('en-US')} values; search to narrow.</div>}
        {!shown.length && <div className="fm-more">No matching values</div>}
      </div>
      <div className="fm-actions">
        <button type="button" className="btn small" onClick={() => onApply(null)} disabled={!current}>Clear filter</button>
        <span className="status-spacer" />
        <button type="button" className="btn small" onClick={onClose}>Cancel</button>
        <button type="button" className="btn small primary" onClick={apply}>Apply</button>
      </div>
    </div>
  )
}

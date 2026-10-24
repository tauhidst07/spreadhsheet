const FILLS = [['', 'None'], ['#fff2cc', 'Yellow'], ['#d9ead3', 'Green'], ['#f4cccc', 'Red'], ['#cfe2f3', 'Blue'], ['#ead1dc', 'Pink'], ['#efefef', 'Grey']]
const COLORS = [['', 'Default'], ['#1a73e8', 'Blue'], ['#188038', 'Green'], ['#d93025', 'Red'], ['#e37400', 'Orange'], ['#5f6368', 'Grey']]
const FORMATS = [['general', 'General'], ['number', 'Number'], ['currency', 'Currency'], ['percent', 'Percent'], ['date', 'Date']]

const Btn = ({ label, title, onClick, active, disabled, className = '' }) => (
  <button type="button" className={`tb-btn ${active ? 'active' : ''} ${className}`} title={title} aria-label={title} aria-pressed={active ?? undefined} onClick={onClick} disabled={disabled}>{label}</button>
)

export default function Toolbar(p) {
  const s = p.style, off = p.busy
  return (
    <div className="toolbar" role="toolbar" aria-label="Formatting">
      <div className="tb-group">
        <Btn label="↶" title="Undo (Ctrl+Z)" onClick={p.undo} disabled={off || !p.canUndo} />
        <Btn label="↷" title="Redo (Ctrl+Y)" onClick={p.redo} disabled={off || !p.canRedo} />
      </div>
      <div className="tb-group">
        <Btn label={<b>B</b>} title="Bold (Ctrl+B)" active={!!s.bold} onClick={() => p.setStyle({ bold: !s.bold })} disabled={off} />
        <Btn label={<i>I</i>} title="Italic (Ctrl+I)" active={!!s.italic} onClick={() => p.setStyle({ italic: !s.italic })} disabled={off} />
        <Btn label={<u>U</u>} title="Underline (Ctrl+U)" active={!!s.underline} onClick={() => p.setStyle({ underline: !s.underline })} disabled={off} />
      </div>
      <div className="tb-group">
        {['left', 'center', 'right'].map(a => (
          <Btn key={a} label={<span className={`align-icon align-${a}`} />} title={`Align ${a}`} active={s.align === a} onClick={() => p.setStyle({ align: s.align === a ? null : a })} disabled={off} />
        ))}
      </div>
      <div className="tb-group">
        <select className="tb-select" aria-label="Number format" value={s.numberFormat ?? 'general'} onChange={e => p.setStyle({ numberFormat: e.target.value })} disabled={off}>
          {FORMATS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <select className="tb-select narrow" aria-label="Font size" value={s.fontSize ?? 13} onChange={e => p.setStyle({ fontSize: Number(e.target.value) === 13 ? null : Number(e.target.value) })} disabled={off}>
          {[10, 11, 12, 13, 14, 16, 18, 20, 24].map(n => <option key={n} value={n}>{n}</option>)}
        </select>
        <select className="tb-select" aria-label="Fill colour" value={s.bg ?? ''} onChange={e => p.setStyle({ bg: e.target.value || null })} disabled={off}>
          {FILLS.map(([v, l]) => <option key={l} value={v}>Fill {l}</option>)}
        </select>
        <select className="tb-select" aria-label="Text colour" value={s.color ?? ''} onChange={e => p.setStyle({ color: e.target.value || null })} disabled={off}>
          {COLORS.map(([v, l]) => <option key={l} value={v}>Text {l}</option>)}
        </select>
      </div>
      <div className="tb-group">
        <Btn label="+ Row" title="Insert row above" onClick={p.insertRow} disabled={off} />
        <Btn label="− Row" title="Delete selected rows" onClick={p.deleteRow} disabled={off} />
        <Btn label="+ Col" title="Insert column left" onClick={p.insertColumn} disabled={off} />
        <Btn label="− Col" title="Delete selected columns" onClick={p.deleteColumn} disabled={off} />
      </div>
      <div className="tb-group">
        <Btn label="Freeze row" title="Freeze the first row" active={p.frozenRows > 0} onClick={p.toggleFreezeRow} disabled={off} />
        <Btn label="Freeze col" title="Freeze the first column" active={p.frozenCols > 0} onClick={p.toggleFreezeCol} disabled={off} />
        <Btn label="Clear filters" title="Clear all filters" onClick={p.clearFilters} disabled={off || !p.hasFilters} />
      </div>
      <div className="tb-group">
        <Btn label="Sample 33" title="Load fixtures/sales.tsv (33 rows) at A1" onClick={p.loadSmall} disabled={off} />
        <Btn label="Sample 3k" title="Load fixtures/sales-large.tsv (~3,000 rows) at A1" onClick={p.loadLarge} disabled={off} />
      </div>
      <div className="tb-group tb-end">
        <Btn label="✦ Ask AI  Ctrl+K" title="Ask your data / format with AI (Ctrl+K)" className="accent" onClick={p.openAi} />
      </div>
    </div>
  )
}

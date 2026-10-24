import { useEffect, useRef, useState } from 'react'
import { createProvider, providerMode } from './provider.js'
import { buildContext, describeQuery, executeQuery, requestAction } from './runtime.js'
import { planFormat } from './format.js'
import { cellLabel, parseCellLabel } from '../engine/formula.js'

const EXAMPLES = ['What is the total sales by region?', 'Top 3 sales reps by total sales', 'Format this as a clean table', 'Highlight the totals row in yellow']

/** Used range as display text: the only data the executor and applier read. */
function sheetMatrix(engine) {
  const used = engine.getUsedRange()
  return used ? engine.getRangeText(used) : []
}

const timed = fn => { const t = performance.now(), value = fn(); return [value, performance.now() - t] }

/** Ctrl+K side panel: prompt → validated action → result card / format preview / clarify. */
export default function AiPanel({ engine, view, selection, onClose, onChange }) {
  const [provider] = useState(() => createProvider())
  const [cards, setCards] = useState([])
  const [prompt, setPrompt] = useState('')
  const [pending, setPending] = useState(false)
  const [showPlan, setShowPlan] = useState(true)
  const inputRef = useRef(null), listRef = useRef(null), nextId = useRef(0)

  useEffect(() => { inputRef.current?.focus() }, [])
  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' }) }, [cards])

  const update = (id, patch) => setCards(list => list.map(c => (c.id === id ? { ...c, ...patch } : c)))

  const formatView = () => ({ matrix: sheetMatrix(engine), styleAt: (r, c) => engine.getCellStyle(r, c), frozenRows: engine.frozenRows, measure: (t, s) => view.measure(t, s) })

  const ask = async text => {
    const question = text.trim()
    if (!question || pending) return
    const id = ++nextId.current
    setPrompt('')
    setPending(true)
    setCards(list => [...list, { id, prompt: question, status: 'pending' }])
    const matrix = sheetMatrix(engine)
    const history = cards.filter(c => c.raw).slice(-3).flatMap(c => [{ role: 'user', content: c.prompt }, { role: 'assistant', content: c.raw }])
    const response = await requestAction(provider, question, buildContext(matrix, selection), history)
    setPending(false)
    if (response.error) return update(id, { status: 'error', error: response, raw: response.raw })
    const { action, raw } = response
    if (action.type === 'clarify') return update(id, { status: 'clarify', action, raw, question: action.question })
    if (action.type === 'format_sheet') {
      const planned = planFormat(formatView(), action)
      return update(id, { status: planned.code === 'OUT_OF_RANGE' ? 'error' : 'format', action, raw, summary: planned.summary, error: planned.code === 'OUT_OF_RANGE' ? { error: 'OUT_OF_RANGE', detail: planned.detail } : null })
    }
    const [result, ms] = timed(() => executeQuery(matrix, action))
    if (result.error === 'UNKNOWN_COLUMN') {
      // Never guess a similar column: ask, listing the real ones.
      const name = result.detail.slice('UNKNOWN_COLUMN:'.length)
      return update(id, { status: 'clarify', action, raw, code: result.error, question: `There is no column called "${name}". Which column did you mean? Available: ${(matrix[0] ?? []).filter(Boolean).join(', ')}.` })
    }
    update(id, result.error ? { status: 'error', action, raw, error: result } : { status: 'result', action, raw, result, ms, target: defaultTarget(engine) })
  }

  const rerun = card => {
    const [result, ms] = timed(() => executeQuery(sheetMatrix(engine), card.action))
    update(card.id, result.error ? { status: 'error', error: result } : { result, ms, rerunAt: new Date().toLocaleTimeString('en-GB') })
  }

  const insert = card => {
    const at = parseCellLabel(card.target ?? '')
    if (!at) return update(card.id, { note: `"${card.target}" is not a cell` })
    const { columns, rows } = card.result
    engine.setRange(at.r, at.c, [columns, ...rows.map(r => r.map(v => (v === null ? '' : String(v))))])
    onChange()
    update(card.id, { note: `Inserted ${rows.length + 1} rows at ${cellLabel(at.r, at.c)} (one undo step)` })
  }

  const apply = card => {
    const planned = planFormat(formatView(), card.action)
    if (planned.code !== 'PLAN') return update(card.id, { status: 'error', error: { error: planned.code, detail: planned.detail } })
    const [code, ms] = timed(() => engine.applyStylePlan(planned.plan))
    onChange()
    update(card.id, { status: 'applied', outcome: code === 'NO_CHANGES' ? 'NO_CHANGES: nothing to change, no undo step added' : `Applied in ${ms.toFixed(1)} ms (one undo step)` })
  }

  return (
    <aside className="ai-panel" aria-label="Ask your data">
      <div className="ai-head">
        <div>
          <strong>Ask your data</strong>
          <span className={`ai-mode ${providerMode()}`}>{providerMode() === 'http' ? 'Live model' : 'Mock provider'}</span>
        </div>
        <label className="ai-toggle"><input type="checkbox" checked={showPlan} onChange={e => setShowPlan(e.target.checked)} /> Show plan</label>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close panel">×</button>
      </div>
      <div className="ai-cards" ref={listRef}>
        {!cards.length && (
          <div className="ai-empty">
            <p>Ask a question about the sheet or describe a format. The model only writes a plan; every number comes from the sheet.</p>
            {EXAMPLES.map(e => <button key={e} type="button" className="chip" onClick={() => ask(e)}>{e}</button>)}
          </div>
        )}
        {cards.map(card => <Card key={card.id} card={card} showPlan={showPlan} onRerun={rerun} onInsert={insert} onApply={apply}
          onDiscard={c => update(c.id, { status: 'discarded' })} onTarget={(c, target) => update(c.id, { target })} />)}
      </div>
      <form className="ai-input" onSubmit={e => { e.preventDefault(); ask(prompt) }}>
        <textarea ref={inputRef} rows={2} value={prompt} placeholder="e.g. Total units per category" aria-label="Prompt"
          onChange={e => setPrompt(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(prompt) } else if (e.key === 'Escape') onClose() }} />
        <button type="submit" className="btn primary" disabled={pending || !prompt.trim()}>{pending ? 'Thinking…' : 'Ask'}</button>
      </form>
    </aside>
  )
}

function defaultTarget(engine) {
  const used = engine.getUsedRange()
  return cellLabel(0, used ? used.c2 + 2 : 0)
}

function Card({ card, showPlan, onRerun, onInsert, onApply, onDiscard, onTarget }) {
  const [override, setOverride] = useState(null)
  const plan = override ?? showPlan
  const { status, action, result, error } = card
  return (
    <div className={`ai-card ${status}`}>
      <div className="ai-prompt">{card.prompt}</div>
      {status === 'pending' && <div className="ai-pending"><span className="spinner" aria-hidden="true" /> Asking the model…</div>}
      {error && <div className="ai-error"><strong>{error.error}</strong>{error.detail && error.detail !== error.error ? `: ${error.detail}` : ''}<div className="ai-hint">Nothing in the sheet was changed.</div></div>}
      {status === 'clarify' && <div className="ai-clarify">❓ {card.question ?? action.question}{card.code && <div className="ai-hint">{card.code}: nothing was run.</div>}</div>}
      {status === 'result' && (
        <>
          <div className="ai-plan-words">{describeQuery(action)}</div>
          <div className="ai-meta">{result.rowCount.toLocaleString('en-US')} row{result.rowCount === 1 ? '' : 's'}{result.truncated ? ' (truncated to the limit)' : ''} · computed in {card.ms.toFixed(1)} ms{card.rerunAt ? ` · re-run at ${card.rerunAt}` : ''}</div>
          <div className="ai-table-wrap">
            <table className="ai-table">
              <thead><tr>{result.columns.map((c, i) => <th key={i}>{c}</th>)}</tr></thead>
              <tbody>{result.rows.map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j} className={typeof v === 'number' ? 'num' : ''}>{v === null ? '—' : typeof v === 'number' ? v.toLocaleString('en-US', { maximumFractionDigits: 2 }) : v}</td>)}</tr>)}</tbody>
            </table>
          </div>
          <div className="ai-actions">
            <button type="button" className="btn small" onClick={() => onRerun(card)} title="Runs the same plan again without calling the model">Re-run</button>
            <span className="ai-insert">
              <input aria-label="Insert at cell" value={card.target ?? ''} onChange={e => onTarget(card, e.target.value)} />
              <button type="button" className="btn small" onClick={() => onInsert(card)}>Insert into sheet</button>
            </span>
          </div>
          {card.note && <div className="ai-note">{card.note}</div>}
        </>
      )}
      {(status === 'format' || status === 'applied' || status === 'discarded') && (
        <>
          <div className="ai-plan-words">Preview: {card.summary.length ? card.summary.join('; ') : 'no formatting changes'}</div>
          {status === 'format' && (
            <div className="ai-actions">
              <button type="button" className="btn small primary" onClick={() => onApply(card)}>Apply</button>
              <button type="button" className="btn small" onClick={() => onDiscard(card)}>Discard</button>
            </div>
          )}
          {status === 'applied' && <div className="ai-note">{card.outcome}</div>}
          {status === 'discarded' && <div className="ai-note">Discarded; nothing was changed.</div>}
        </>
      )}
      {action && (
        <div className="ai-plan">
          <button type="button" className="link-btn" onClick={() => setOverride(!plan)}>{plan ? 'Hide plan' : 'Show plan'}</button>
          {plan && <pre>{JSON.stringify(action, null, 2)}</pre>}
        </div>
      )}
    </div>
  )
}

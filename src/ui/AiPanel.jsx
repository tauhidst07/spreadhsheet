// Ctrl+K side panel: prompt, conversation history and result cards.
// All logic lives in src/ai (pure); this file only wires it to the UI.
import { useState, useRef, useEffect } from 'react'
import { createProvider } from '../ai/provider.js'
import { askAssistant } from '../ai/assistant.js'
import { executeQuery } from '../ai/executor.js'
import { readTable, buildContext } from '../ai/sheet.js'
import { planFormat, applyFormat } from '../ai/formatApplier.js'
import { describeQuery, describeFormat } from '../ai/describe.js'
import { measureText } from '../grid/measure.js'
import { cellLabel, parseCellLabel } from '../engine/refs.js'
import { norm } from '../engine/values.js'

const provider = createProvider()

const SUGGESTIONS = [
    'What is the total sales by region?',
    'Top 3 sales reps by total sales',
    'Break down sales by region and category',
    'Format this as a clean table',
    'Highlight the totals row in yellow',
    'Unfreeze the header row',
]

const ERROR_TEXT = {
    INVALID_RESPONSE: 'The model’s answer was not a valid action, so nothing was changed.',
    READ_ONLY: 'That would change data. The assistant can only read, analyse and format.',
    PROVIDER_ERROR: 'The AI provider could not be reached.',
    UNKNOWN_OP: 'The plan used a filter operation that does not exist.',
    UNKNOWN_FN: 'The plan used an aggregate that does not exist.',
    UNKNOWN_SORT_COLUMN: 'The plan sorts by a column that is not in the result.',
}

function formatNumber(v) {
    if (typeof v !== 'number') return v ?? ''
    return v.toLocaleString('en-US', { maximumFractionDigits: 2 })
}

/** Replaces every use of column `from` in a plan by `to` (the user picked it). */
function substituteColumn(plan, from, to) {
    const fix = (name) => (norm(name) === norm(from) ? to : name)
    return {
        ...plan,
        ...(plan.filters && { filters: plan.filters.map(f => ({ ...f, column: fix(f.column) })) }),
        ...(plan.groupBy && { groupBy: plan.groupBy.map(fix) }),
        ...(plan.aggregates && { aggregates: plan.aggregates.map(a => ({ ...a, column: fix(a.column) })) }),
        ...(plan.columns && { columns: plan.columns.map(fix) }),
        ...(plan.sort && { sort: plan.sort.map(s => ({ ...s, column: fix(s.column) })) }),
    }
}

function runQuery(plan, engine) {
    const t0 = performance.now()
    const table = readTable(engine)
    const t1 = performance.now()
    const result = executeQuery(plan, table)
    const execMs = performance.now() - t1
    if (result.error === 'UNKNOWN_COLUMN') {
        return { kind: 'unknownColumn', plan, missing: result.detail.slice('UNKNOWN_COLUMN:'.length), columns: table.columns }
    }
    if (result.error) return { kind: 'error', plan, error: { code: result.error, detail: result.detail } }
    return { kind: 'query', plan, result, execMs, readMs: t1 - t0 }
}

function previewFormat(action, engine) {
    const plan = planFormat(action, engine, measureText)
    const columns = readTable(engine).columns
    return { kind: 'format', action, plan, lines: describeFormat(action, plan, columns), state: plan.status === 'OK' ? 'preview' : plan.status }
}

function defaultInsertCell(engine) {
    const used = engine.getUsedRange()
    return used ? cellLabel(used.r1, used.c2 + 2) : 'A1'
}

function PlanJson({ value }) {
    return <pre className="ai-json">{JSON.stringify(value, null, 2)}</pre>
}

function QueryCard({ card, showPlan, onRerun, onInsert, engine }) {
    const [target, setTarget] = useState(() => defaultInsertCell(engine))
    const [open, setOpen] = useState(false)
    const { result } = card
    return (
        <div className="ai-card">
            <div className="ai-desc">{describeQuery(card.plan)}</div>
            <div className="ai-table-wrap">
                <table className="ai-table">
                    <thead><tr>{result.columns.map((c, i) => <th key={i}>{c}</th>)}</tr></thead>
                    <tbody>
                        {result.rows.map((row, i) => (
                            <tr key={i}>{row.map((v, j) => <td key={j} className={typeof v === 'number' ? 'num' : ''}>{formatNumber(v)}</td>)}</tr>
                        ))}
                    </tbody>
                </table>
            </div>
            <div className="ai-meta">
                {result.rowCount} row{result.rowCount === 1 ? '' : 's'}{result.truncated ? ' (truncated to the 500-row limit)' : ''}
                {' · '}executed in {card.execMs.toFixed(1)} ms
            </div>
            <div className="ai-actions">
                <button type="button" onClick={onRerun} title="Execute the same plan again (no model call)">↻ Re-run</button>
                <span className="ai-insert">
                    <button type="button" onClick={() => onInsert(target)}>Insert into sheet at</button>
                    <input value={target} onChange={(e) => setTarget(e.target.value)} size={6} aria-label="Insert at cell" />
                </span>
                <button type="button" className="link" onClick={() => setOpen(o => !o)}>{open || showPlan ? 'Hide plan' : 'Show plan'}</button>
            </div>
            {(open || showPlan) && <PlanJson value={card.plan} />}
        </div>
    )
}

function FormatCard({ card, showPlan, onApply, onDiscard }) {
    const [open, setOpen] = useState(false)
    const status = {
        preview: null,
        applied: `Applied${card.ms !== undefined ? ` in ${card.ms.toFixed(1)} ms` : ''} — Ctrl+Z undoes it in one step.`,
        discarded: 'Discarded.',
        NO_CHANGES: `NO_CHANGES — ${card.plan.message ?? 'nothing would change.'} No undo entry was created.`,
        OUT_OF_RANGE: `OUT_OF_RANGE — ${card.plan.message}`,
    }[card.state]
    return (
        <div className="ai-card">
            <div className="ai-desc">Preview</div>
            <ul className="ai-preview">{card.lines.map((l, i) => <li key={i}>{l}</li>)}</ul>
            {status && <div className={`ai-status ${card.state === 'applied' ? 'ok' : card.state === 'discarded' ? '' : 'warn'}`}>{status}</div>}
            <div className="ai-actions">
                {card.state === 'preview' && <>
                    <button type="button" className="primary" onClick={onApply}>Apply</button>
                    <button type="button" onClick={onDiscard}>Discard</button>
                </>}
                <button type="button" className="link" onClick={() => setOpen(o => !o)}>{open || showPlan ? 'Hide plan' : 'Show plan'}</button>
            </div>
            {(open || showPlan) && <PlanJson value={card.action} />}
        </div>
    )
}

let nextTurnId = 1

export default function AiPanel({ engine, selection, onSheetChanged, onClose }) {
    const [turns, setTurns] = useState([])
    const [input, setInput] = useState('')
    const [busy, setBusy] = useState(false)
    const [showPlan, setShowPlan] = useState(false)
    const inputRef = useRef(null)
    const listRef = useRef(null)

    useEffect(() => { inputRef.current?.focus() }, [])
    useEffect(() => {
        const el = listRef.current
        if (el) el.scrollTop = el.scrollHeight
    }, [turns])

    const update = (id, patch) => setTurns(ts => ts.map(t => (t.id === id ? { ...t, ...patch } : t)))

    async function submit(text) {
        const prompt = text.trim()
        if (!prompt || busy) return
        const id = nextTurnId++
        setTurns(ts => [...ts, { id, prompt, kind: 'pending' }])
        setInput('')
        setBusy(true)
        const context = buildContext(readTable(engine), selection)
        const history = turns
            .filter(t => t.rawText)
            .flatMap(t => [{ role: 'user', content: t.prompt }, { role: 'assistant', content: t.rawText }])
        const res = await askAssistant({ provider, prompt, context, history })
        let card
        if (res.error) card = { kind: 'error', error: res.error }
        else if (res.action.type === 'clarify') card = { kind: 'clarify', question: res.action.question, action: res.action }
        else if (res.action.type === 'query') card = runQuery(res.action, engine)
        else card = previewFormat(res.action, engine)
        update(id, { ...card, rawText: res.rawText, modelMs: res.ms, provider: res.provider })
        setBusy(false)
    }

    function rerun(turn) {
        update(turn.id, runQuery(turn.plan, engine))
    }

    function insert(turn, target) {
        const at = parseCellLabel(target)
        if (!at) { update(turn.id, { insertError: `“${target}” is not a cell like L1.` }); return }
        const { columns, rows } = turn.result
        const matrix = [columns, ...rows.map(row => row.map(v => (v === null || v === undefined ? '' : String(v))))]
        engine.setRange(at.row, at.col, matrix, 'Insert AI result')
        update(turn.id, { insertError: null })
        onSheetChanged(`Inserted ${rows.length} rows × ${columns.length} columns at ${cellLabel(at.row, at.col)} — one undo step`)
    }

    function applyTurn(turn) {
        const t0 = performance.now()
        const plan = planFormat(turn.action, engine, measureText) // re-plan: the sheet may have changed since the preview
        const status = applyFormat(engine, plan)
        const ms = performance.now() - t0
        update(turn.id, { plan, state: status === 'OK' ? 'applied' : status, ms })
        if (status === 'OK') onSheetChanged(`AI format applied in ${ms.toFixed(1)} ms`)
    }

    function pickColumn(turn, column) {
        const plan = substituteColumn(turn.plan, turn.missing, column)
        update(turn.id, { ...runQuery(plan, engine), chosen: column })
    }

    return (
        <aside className="ai-panel">
            <div className="ai-header">
                <strong>Ask your data</strong>
                <span className="ai-provider" title="VITE_AI_PROVIDER">{provider.name}</span>
                <label className="ai-toggle"><input type="checkbox" checked={showPlan} onChange={(e) => setShowPlan(e.target.checked)} /> show plan</label>
                <button type="button" className="ai-close" onClick={onClose} title="Close (Ctrl+K)">✕</button>
            </div>
            <div className="ai-list" ref={listRef}>
                {turns.length === 0 && (
                    <div className="ai-empty">
                        <p>Ask a question about the sheet or ask for formatting. The model only writes a plan; the numbers come from the sheet.</p>
                        {SUGGESTIONS.map(s => <button type="button" key={s} className="ai-chip" onClick={() => submit(s)}>{s}</button>)}
                    </div>
                )}
                {turns.map(turn => (
                    <div key={turn.id} className="ai-turn">
                        <div className="ai-prompt">{turn.prompt}</div>
                        {turn.kind === 'pending' && <div className="ai-card ai-pending">Thinking…</div>}
                        {turn.kind === 'error' && (
                            <div className="ai-card ai-error">
                                <strong>{turn.error.code}</strong> — {ERROR_TEXT[turn.error.code] ?? 'Something went wrong.'}
                                <div className="ai-detail">{turn.error.detail}</div>
                                {(showPlan && turn.rawText) && <pre className="ai-json">{turn.rawText}</pre>}
                            </div>
                        )}
                        {turn.kind === 'clarify' && <div className="ai-card ai-clarify">{turn.question}</div>}
                        {turn.kind === 'unknownColumn' && (
                            <div className="ai-card ai-clarify">
                                There is no column called <strong>“{turn.missing}”</strong>. Which column did you mean?
                                <div className="ai-chips">
                                    {turn.columns.filter(c => c.trim()).map(c => <button type="button" key={c} className="ai-chip" onClick={() => pickColumn(turn, c)}>{c}</button>)}
                                </div>
                                {showPlan && <PlanJson value={turn.plan} />}
                            </div>
                        )}
                        {turn.kind === 'query' && (
                            <QueryCard card={turn} engine={engine} showPlan={showPlan} onRerun={() => rerun(turn)} onInsert={(target) => insert(turn, target)} />
                        )}
                        {turn.kind === 'format' && (
                            <FormatCard card={turn} showPlan={showPlan} onApply={() => applyTurn(turn)} onDiscard={() => update(turn.id, { state: 'discarded' })} />
                        )}
                        {turn.insertError && <div className="ai-card ai-error">{turn.insertError}</div>}
                    </div>
                ))}
            </div>
            <form className="ai-form" onSubmit={(e) => { e.preventDefault(); submit(input) }}>
                <input
                    ref={inputRef}
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    placeholder={busy ? 'Waiting for the model…' : 'e.g. Total units per category'}
                    onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}
                />
                <button type="submit" className="primary" disabled={busy || !input.trim()}>Ask</button>
            </form>
        </aside>
    )
}
